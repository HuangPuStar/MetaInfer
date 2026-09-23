"""CLI entry point for harness_evolve orchestrator.

Framework contract::

    python -m metainfer.tasks.harness_evolve.orchestrator.cli run \\
        <requirements.json> --state-dir DIR --workspace-dir DIR

Explicit publish gate::

    python -m metainfer.tasks.harness_evolve.orchestrator.cli publish \\
        --exp-dir DIR [--harness] [--harness-target PATH] \\
        [--kernels] [--pool PATH] [--reason TEXT]
"""

from __future__ import annotations

import argparse
import json
import os
import signal
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Optional

from metainfer.orchestrator._bootstrap import clear_pid_file, write_pid_file

from .config import load_experiment_config
from .pipeline import completed_iterations, run_experiment
from .state import read_target_iterations, write_target_iterations
from .publish import check_publishable, publish_harness, publish_kernels

_DEFAULT_POOL = Path("/root/zth_agent/ahe-kernel-repos/registered_pool.yaml")


@contextmanager
def _orchestrator_pid(state_dir: Path, task_id: str) -> Iterator[Path]:
    """Own the task's ``orchestrator.pid`` for as long as this process runs.

    The WebUI decides whether a task is *running* (green dot, live kill
    button) from this file and nothing else: ``Launcher.status()`` reads
    ``{"pid", "started_at"}`` and checks that the pid is still the same
    process. An orchestrator that never writes it looks stopped for its whole
    life, which is exactly how harness_evolve used to behave while a run was
    in progress.

    Written before any work starts and cleared on every exit path — normal
    return, exception, or SIGTERM/SIGINT (the WebUI's Stop button) — so the
    file never claims a dead pid. Signals use ``os._exit`` after clearing, so
    an ``atexit`` handler would not be enough on its own.

    Covers both entry points the server uses: ``run`` (started from the New
    Task form) and ``resume`` (started by the supervisor to continue a run).
    """
    pid_file = state_dir / "orchestrator.pid"

    def _on_signal(signum, _frame):
        try:
            clear_pid_file(pid_file)
        except Exception:  # noqa: BLE001 - best effort while dying
            pass
        os._exit(143 if signum == signal.SIGTERM else 130)

    previous = (signal.getsignal(signal.SIGTERM), signal.getsignal(signal.SIGINT))
    write_pid_file(pid_file, task_id)
    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)
    try:
        yield pid_file
    finally:
        signal.signal(signal.SIGTERM, previous[0])
        signal.signal(signal.SIGINT, previous[1])
        try:
            clear_pid_file(pid_file)
        except Exception:  # noqa: BLE001 - never mask the real failure
            pass


def clear_stop_request(exp_dir: Path, *, state_dir: Path | None = None) -> "list[str]":
    """Drop a previous stop signal so a resumed round can actually run.

    A run that stopped on purpose (``round_incomplete`` — e.g. because a child's
    DKAO gate never got a clean device) leaves ``stop_requested.json`` behind,
    and the pipeline treats it as "stop now" after the next evaluate. A human
    asking for another round has decided the condition is over, so the signal is
    recorded in the timeline and then removed: without this, every resume would
    stop again immediately.
    """
    import time as _time

    cleared: list = []
    stop_path = Path(exp_dir) / "stop_requested.json"
    if not stop_path.is_file():
        return cleared
    try:
        data = json.loads(stop_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    try:
        from .state import append_timeline
        append_timeline(Path(state_dir or exp_dir), "stop_request_cleared",
                        {"reason": (data or {}).get("reason"),
                         "cleared_at": _time.time()})
    except Exception:  # noqa: BLE001 - the audit row is best effort
        pass
    try:
        stop_path.unlink()
        cleared.append("stop_requested.json")
    except OSError:
        pass
    return cleared


#: The round target is a small number of judged passes; the WebUI clamps its own
#: "target" input to this range, so the form's value is clamped the same way.
_TARGET_MIN, _TARGET_MAX = 1, 50


def _configured_rounds(cfg: Any) -> int:
    """The round limit the New Task form asked for (``rounds``).

    One round is one iteration: the baseline round is round 1, every later round
    is a performance pass plus — when it wins — the generalization retake inside
    that same iteration. ``max_iterations`` is the field's old name, still read
    so runs created before the rename keep their limit.
    """
    for key in ("rounds", "max_iterations"):
        raw = cfg.answers.get(key)
        if raw in (None, ""):
            continue
        try:
            value = int(raw)
        except (TypeError, ValueError):
            continue
        return max(_TARGET_MIN, min(_TARGET_MAX, value))
    return _TARGET_MAX // 5          # 10, the form's default


def _seed_rounds_from_form(cfg: Any, workspace_dir: Path) -> int:
    """Pin the form's round limit where the loop and the WebUI both read it."""
    rounds = _configured_rounds(cfg)
    write_target_iterations(Path(workspace_dir), rounds)
    print(f"[harness_evolve] rounds = {rounds} "
          f"(from the form's Rounds field)", flush=True)
    return rounds


def run_with_requirements(
    requirements_path: Path,
    *,
    state_dir: Path,
    workspace_dir: Path,
) -> int:
    state_dir.mkdir(parents=True, exist_ok=True)
    task_id = _task_id_of(requirements_path, fallback=state_dir.parent.name)
    with _orchestrator_pid(state_dir, task_id):
        cfg = load_experiment_config(requirements_path, state_dir, workspace_dir)
        _seed_rounds_from_form(cfg, workspace_dir)
        report = run_experiment(cfg)
    print(f"[harness_evolve] done -> {report}")
    return 0


def _clear_operator_stop(workspace_dir: Path) -> "list[str]":
    """Drop the operator-stop marker (see the WebUI's Stop button).

    ``operator_stop.json`` is what keeps a deliberately stopped run from being
    quietly restarted by the supervisor, the janitor sweep or a plain resume.
    A resume is a human asking for the run to continue, so the marker must not
    outlive it -- otherwise the run we are starting now would be treated as
    already stopped. Idempotent: no marker, nothing to report.
    """
    path = Path(workspace_dir) / "operator_stop.json"
    try:
        path.unlink()
        return ["operator_stop.json"]
    except OSError:
        return []


def _task_id_of(requirements_path: Path, *, fallback: str) -> str:
    """The task id to stamp in the PID file, read from requirements.json.

    Best effort: the PID file must exist before anything else can fail, so a
    missing or malformed requirements file falls back to the directory name
    rather than raising.
    """
    try:
        data = json.loads(requirements_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return fallback
    task_id = str(data.get("task_id") or "").strip()
    return task_id or fallback


def resume_command(args: argparse.Namespace) -> int:
    """Continue an existing experiment with one (or more) further rounds.

    The already-measured champion and previous round come back from disk, so
    only the new generation of the harness is evaluated.
    """
    state_dir = Path(args.state_dir)
    workspace_dir = Path(args.workspace_dir)
    req_path = (Path(args.requirements) if args.requirements
                else state_dir / "requirements.json")
    if not req_path.is_file():
        print(f"[resume] requirements not found: {req_path}", flush=True)
        return 2
    cfg = load_experiment_config(req_path, state_dir, workspace_dir)
    # A resumed run is just as "live" to the WebUI as a freshly started one, so
    # it owns the same PID file (see _orchestrator_pid).
    with _orchestrator_pid(state_dir, cfg.task_id):
        def _another_driver() -> Optional[int]:
            """PID of a *different* live orchestrator on this experiment.

            Two drivers on one experiment is how a round ends up measured twice
            on the same four cards: the janitor's resume used to open iteration
            N+1 while iteration N was still being evaluated. Nothing here counts
            ourselves — the pid file this process just wrote is its own.
            """
            try:
                from .supervisor import task_process_alive
                return task_process_alive(state_dir)
            except Exception:  # noqa: BLE001 - never block on our own bookkeeping
                return None

        done = completed_iterations(cfg.exp_dir)
        if done < 1:
            # Two cases: the task is already running (started by the server) and
            # we should simply stay out of the way, or nothing is running and we
            # are the ones to start round 1.
            live = _another_driver()
            if live:
                print(f"[resume] task already running (pid {live}); nothing to do",
                      flush=True)
                return 0
            print("[resume] no completed iteration yet; starting iteration 1",
                  flush=True)
            # ``target`` is optional on this path (programmatic callers build a
            # bare Namespace), so read it defensively.
            first_target = getattr(args, "target", None)
            if first_target is not None:
                write_target_iterations(cfg.exp_dir, max(1, int(first_target)))
            elif read_target_iterations(cfg.exp_dir) is None:
                _seed_rounds_from_form(cfg, cfg.exp_dir)
            report = run_experiment(cfg, start_iteration=1, iterations_to_run=1)
            print(f"[harness_evolve] started -> {report}")
            return 0
        # Same guard on the "there is history" path: a completed pass on disk
        # says nothing about whether the run that produced it is *still going*.
        running = _another_driver()
        if running:
            print(f"[resume] task already running (pid {running}); nothing to do",
                  flush=True)
            return 0
        explicit_target = getattr(args, "target", None)
        if explicit_target is not None:
            write_target_iterations(cfg.exp_dir, max(1, int(explicit_target)))
            print(f"[resume] target iterations set to {int(explicit_target)}",
                  flush=True)
        elif read_target_iterations(cfg.exp_dir) is None:
            # No target was ever stored (a run created before the form's
            # Iterations field was wired): fall back to it instead of running
            # unbounded until the round budget trips.
            _seed_rounds_from_form(cfg, cfg.exp_dir)
        start = done + 1
        rounds = max(1, int(args.iterations or 1))
        cleared = clear_stop_request(cfg.exp_dir, state_dir=state_dir)
        if cleared:
            print(f"[resume] cleared previous stop signal: {cleared}", flush=True)
        cleared += _clear_operator_stop(workspace_dir)
        print(f"[resume] completed iterations: {done}; running "
              f"iteration {start}..{start + rounds - 1}", flush=True)
        champion_iteration = getattr(args, "champion_iteration", None)
        if champion_iteration:
            print(f"[resume] comparison baseline pinned to iteration "
                  f"{int(champion_iteration)}", flush=True)
        report = run_experiment(cfg, start_iteration=start,
                                iterations_to_run=rounds,
                                champion_iteration=champion_iteration)
    print(f"[harness_evolve] resumed -> {report}")
    return 0


def _dcu_harness_default() -> Path:
    return (
        Path(__file__).resolve().parents[2]
        / "dcu_kernel_auto_opt" / "harness_default"
    )


def _promotion_context(args: argparse.Namespace):
    """Load the experiment config for the promotion commands."""
    state_dir = Path(args.state_dir)
    workspace_dir = Path(args.workspace_dir)
    req_path = state_dir / "requirements.json"
    if not req_path.is_file():
        raise SystemExit(f"[promote] requirements not found: {req_path}")
    return load_experiment_config(req_path, state_dir, workspace_dir)


def pending_command(args: argparse.Namespace) -> int:
    from .promotion import promoted_harness, read_pending

    cfg = _promotion_context(args)
    pending = read_pending(cfg.exp_dir)
    promoted = promoted_harness(cfg.exp_dir)
    print(json.dumps({"pending": pending, "promoted": promoted},
                     ensure_ascii=False, indent=2))
    return 0 if pending else 1


def approve_command(args: argparse.Namespace) -> int:
    from .promotion import approve_promotion

    cfg = _promotion_context(args)
    result = approve_promotion(cfg, cfg.exp_dir, approved_by=str(args.by))
    if not result.get("ok"):
        print(f"[approve] refused: {result.get('errors')}")
        return 2
    print(f"[approve] promoted {result['version']} -> "
          f"{result['record']['production_dir']}")
    print(f"[approve] variants updated: {result['variant_update']['updated']}")
    print(f"[approve] previous version backed up at "
          f"{result['record']['previous_backup']}")
    return 0


def deny_command(args: argparse.Namespace) -> int:
    from .promotion import deny_promotion

    cfg = _promotion_context(args)
    result = deny_promotion(cfg, cfg.exp_dir, reason=str(args.reason))
    if not result.get("ok"):
        print(f"[deny] refused: {result.get('errors')}")
        return 2
    print(f"[deny] discarded candidate {result['denied']}; "
          "resume the experiment to keep iterating")
    return 0


def rollback_command(args: argparse.Namespace) -> int:
    from .promotion import rollback_harness

    cfg = _promotion_context(args)
    result = rollback_harness(cfg.exp_dir, to=str(args.to))
    if not result.get("ok"):
        print(f"[rollback] refused: {result.get('errors')}")
        return 2
    print(f"[rollback] restored from {result['restored_from']}")
    print(f"[rollback] replaced tree backed up at "
          f"{result['record']['replaced_backup']}")
    return 0


def publish_command(args: argparse.Namespace) -> int:
    exp = Path(args.exp_dir).resolve()
    if not (exp / "config_snapshot.json").is_file():
        print(f"[publish] not a harness_evolve experiment: {exp}", flush=True)
        return 2
    did = False
    if args.harness or args.all:
        target = Path(args.harness_target or _dcu_harness_default())
        result = publish_harness(exp, target=target, reason=args.reason)
        print(f"[publish][harness] ok={result['ok']} "
              f"{result.get('published')} {result.get('errors') or ''}",
              flush=True)
        if not result.get("ok"):
            return 3
        did = True
    if args.kernels or args.all:
        pool = Path(args.pool or _DEFAULT_POOL)
        result = publish_kernels(exp, pool_path=pool, reason=args.reason)
        print(f"[publish][kernels] ok={result['ok']} "
              f"published={result.get('published')} "
              f"updated={result.get('updated', [])} "
              f"{result.get('errors') or ''}", flush=True)
        if not result.get("ok"):
            return 3
        did = True
    if not did:
        gate = check_publishable(exp)
        print(f"[publish] check only: ok={gate.get('ok')} "
              f"iteration={gate.get('iteration')} "
              f"verdict={gate.get('verdict')} errors={gate.get('errors') or []}",
              flush=True)
        return 0 if gate.get("ok") else 3
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="metainfer-harness-evolve")
    sub = parser.add_subparsers(dest="command", required=True)
    run_p = sub.add_parser("run")
    run_p.add_argument("requirements", type=Path)
    run_p.add_argument("--state-dir", type=Path, required=True)
    run_p.add_argument("--workspace-dir", type=Path, required=True)

    res = sub.add_parser("resume", help="continue an existing experiment")
    res.add_argument("--state-dir", type=Path, required=True)
    res.add_argument("--workspace-dir", type=Path, required=True)
    res.add_argument("--requirements", type=Path, default=None,
                     help="defaults to <state-dir>/requirements.json")
    res.add_argument("--iterations", type=int, default=1,
                     help="how many further rounds to run (default 1)")
    res.add_argument("--target", type=int, default=None,
                     help="total iterations to reach (dynamic; re-read every round)")
    res.add_argument("--champion-iteration", type=int, default=None,
                     help="pin the comparison baseline to a finished iteration")
    res.set_defaults(func=resume_command)

    pub = sub.add_parser("publish", help="explicit publish gate")
    pub.add_argument("--exp-dir", type=Path, required=True)
    pub.add_argument("--harness", action="store_true",
                     help="publish champion harness to production default seed")
    pub.add_argument("--harness-target", type=Path, default=None,
                     help="override harness target (default: dcu harness_default)")
    pub.add_argument("--kernels", action="store_true",
                     help="publish new best-known kernels into the registered pool")
    pub.add_argument("--all", action="store_true")
    pub.add_argument("--pool", type=Path, default=None)
    pub.add_argument("--reason", type=str, default="explicit publish")
    pub.set_defaults(func=publish_command)

    # Human decision on a candidate harness that passed both gates. Nothing is
    # written to production DKAO until `approve` runs.
    appr = sub.add_parser("approve", help="approve a pending harness promotion")
    appr.add_argument("--state-dir", type=Path, required=True)
    appr.add_argument("--workspace-dir", type=Path, required=True)
    appr.add_argument("--by", type=str, default="operator")
    appr.set_defaults(func=approve_command)

    deny = sub.add_parser("deny", help="reject a pending harness promotion")
    deny.add_argument("--state-dir", type=Path, required=True)
    deny.add_argument("--workspace-dir", type=Path, required=True)
    deny.add_argument("--reason", type=str, default="operator")
    deny.set_defaults(func=deny_command)

    roll = sub.add_parser("rollback-harness",
                          help="restore a previously promoted harness")
    roll.add_argument("--state-dir", type=Path, required=True)
    roll.add_argument("--workspace-dir", type=Path, required=True)
    roll.add_argument("--to", type=str, default="last-good",
                      help="version label (h-2), last-good, or seed")
    roll.set_defaults(func=rollback_command)

    pend = sub.add_parser("pending", help="show the pending promotion, if any")
    pend.add_argument("--state-dir", type=Path, required=True)
    pend.add_argument("--workspace-dir", type=Path, required=True)
    pend.set_defaults(func=pending_command)

    args = parser.parse_args(argv)
    if args.command == "run":
        return run_with_requirements(
            args.requirements,
            state_dir=args.state_dir,
            workspace_dir=args.workspace_dir,
        )
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
