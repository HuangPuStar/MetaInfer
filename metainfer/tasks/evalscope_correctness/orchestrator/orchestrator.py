"""Supervisor + lifecycle for the evalscope-correctness orchestrator.

This task has no iteration loop and no sub-agents. The "orchestrator"
is a thin supervisor that, for each requested dataset, runs EvalScope in
an isolated child process (see :mod:`.runner` / :mod:`.evalscope_worker`),
then normalizes the raw reports into the single authoritative
``state_dir/result.json``.

Lifecycle mirrors the framework conventions (see
:mod:`metainfer.orchestrator._bootstrap` and ``calc_value/orchestrator``):
write the PID file, install SIGTERM/SIGINT handlers, drive the pipeline,
clear the PID file on exit. Because our child stays in the orchestrator's
process group (no ``start_new_session``), the launcher's group-kill stops
EvalScope together with this supervisor.

Result semantics (see :mod:`.report`):
* ``result.json`` is the single authority for correctness outcome.
* ``run.json.final_status`` is ``success`` when the evaluation is *complete*
  (every dataset fully evaluated, no truncation/errors/mismatch) — even if
  an optional quality gate failed. Incomplete / config / infra outcomes are
  ``stopped``.

State layout::

    <state_dir>/  requirements.json, run.json, timeline.jsonl,
                  orchestrator.{pid,log}, result.json
    <workspace_dir>/evalscope/<dataset>/attempt-<N>/   (raw EvalScope)
"""

from __future__ import annotations

import json
import os
import signal
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from metainfer.orchestrator._bootstrap import (
    clear_pid_file,
    set_process_name,
    write_pid_file,
)
from metainfer.orchestrator.state import StateStore

from . import config as _config
from . import report as _report
from . import runner as _runner

# Phase tokens the shell stores opaquely (see CLAUDE.md).
PHASE_CONFIGURING = "configuring"
PHASE_RUNNING = "running"
PHASE_FINALIZING = "finalizing"
PHASE_DONE = "complete"
PHASE_STOPPED = "stopped"


# --------------------------------------------------------------------------- #
# Attempt-dir helpers
# --------------------------------------------------------------------------- #

def _read_attempt_meta(attempt_dir: Path) -> Dict[str, Any]:
    path = attempt_dir / "attempt.json"
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_attempt_meta(attempt_dir: Path, meta: Dict[str, Any]) -> None:
    path = attempt_dir / "attempt.json"
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    tmp.replace(path)


def _attempt_number(attempt_dir: Path) -> int:
    try:
        return int(attempt_dir.name.rsplit("-", 1)[1])
    except (IndexError, ValueError):
        return 0


def _next_attempt_dir(evalscope_root: Path, dataset: str) -> Path:
    existing = evalscope_root.glob(f"{dataset}/attempt-*")
    highest = max((_attempt_number(p) for p in existing), default=0)
    return evalscope_root / dataset / f"attempt-{highest + 1}"


def _latest_complete_attempt(
    evalscope_root: Path,
    dataset: str,
    fingerprint: str,
    threshold: Optional[float],
) -> Optional[Path]:
    """Newest attempt matching the fingerprint that normalizes complete.

    Used for restart reuse: a dataset already fully evaluated under the same
    immutable request fingerprint is not re-run. Completeness is derived
    fresh from the on-disk evidence (SSOT), not from a cached flag.
    """
    best: Optional[Path] = None
    best_n = -1
    for attempt_dir in sorted(evalscope_root.glob(f"{dataset}/attempt-*")):
        meta = _read_attempt_meta(attempt_dir)
        if meta.get("fingerprint") != fingerprint:
            continue
        if meta.get("exit_code") not in (0, None):
            continue  # EvalScope did not finish cleanly; re-run.
        row = _report.normalize_attempt_dir(
            attempt_dir, dataset, threshold=threshold
        )
        n = _attempt_number(attempt_dir)
        if row.get("complete") and n > best_n:
            best, best_n = attempt_dir, n
    return best


# --------------------------------------------------------------------------- #
# Request → datasets
# --------------------------------------------------------------------------- #

def _resolve_api_key(cfg: _config.EvalConfig) -> Optional[Dict[str, str]]:
    """Map the env var holding the key → (var, value) for the child env.

    Returns None (no auth) when no env var is configured, or when the
    configured var is unset in this process (worker falls back to EMPTY).
    """
    if not cfg.api_key_env_var:
        return None
    value = os.environ.get(cfg.api_key_env_var)
    if value is None:
        return None
    return {cfg.api_key_env_var: value}


def run_with_requirements(
    requirements_path: Path,
    *,
    state_dir: Optional[Path] = None,
    workspace_dir: Optional[Path] = None,
) -> int:
    """Per-task orchestrator entry point. Returns the process exit code."""
    if not requirements_path.exists():
        raise FileNotFoundError(f"requirements file not found: {requirements_path}")

    req: Dict[str, Any] = json.loads(
        requirements_path.read_text(encoding="utf-8")
    )
    task_id = req.get("task_id", "task")

    if state_dir is None or workspace_dir is None:
        from metainfer.server import paths as _web_paths
        if state_dir is None:
            state_dir = _web_paths.task_dir(task_id)
        if workspace_dir is None:
            workspace_dir = _web_paths.workspace_dir(task_id)

    state_dir.mkdir(parents=True, exist_ok=True)
    workspace_dir.mkdir(parents=True, exist_ok=True)

    # Copy requirements into state_dir for self-containment.
    target_req = state_dir / "requirements.json"
    if requirements_path.resolve() != target_req.resolve():
        target_req.write_text(
            requirements_path.read_text(encoding="utf-8"), encoding="utf-8"
        )

    set_process_name("metainfer-esc-och")
    write_pid_file(state_dir / "orchestrator.pid", task_id)

    # Holder so the signal handler can terminate the running child.
    active: Dict[str, Any] = {"proc": None}

    def _on_signal(signum, _frame):
        proc = active.get("proc")
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except Exception:  # noqa: BLE001
                    proc.kill()
            except Exception:  # noqa: BLE001 — best-effort
                pass
        try:
            clear_pid_file(state_dir / "orchestrator.pid")
        except Exception:  # noqa: BLE001
            pass
        os._exit(143 if signum == signal.SIGTERM else 130)

    prev_term = signal.signal(signal.SIGTERM, _on_signal)
    prev_int = signal.signal(signal.SIGINT, _on_signal)

    store = StateStore(state_dir)
    _rs, is_resume = store.init_or_resume(task_id)

    # ---- Input validation (invalid immutable inputs → stopped) ----------- #
    try:
        cfg = _config.parse_requirements(req)
    except _config.ConfigError as exc:
        store.update_run(
            current_phase=PHASE_STOPPED,
            finished=True,
            final_status="stopped",
            last_transition_label=f"input validation: {exc}",
        )
        store.append_timeline("evalscope.stop.invalid_input", {"error": str(exc)})
        clear_pid_file(state_dir / "orchestrator.pid")
        _restore_signals(prev_term, prev_int)
        return 2

    store.update_run(current_phase=PHASE_CONFIGURING)
    store.append_timeline(
        "evalscope.start",
        {
            "task_id": task_id,
            "resume": is_resume,
            "datasets": cfg.dataset_ids,
            "fingerprint": cfg.fingerprint(),
            "api_url": cfg.api_url,
            "model": cfg.model,
        },
    )

    # ---- Preflight (EvalScope install; Docker for sandboxed datasets) ---- #
    pf_error = _runner.preflight_for(cfg)
    if pf_error is not None:
        store.update_run(
            current_phase=PHASE_STOPPED,
            finished=True,
            final_status="stopped",
            last_transition_label=f"preflight: {pf_error}",
        )
        store.append_timeline("evalscope.stop.preflight", {"error": pf_error})
        clear_pid_file(state_dir / "orchestrator.pid")
        _restore_signals(prev_term, prev_int)
        return 2

    evalscope_root = workspace_dir / "evalscope"
    evalscope_root.mkdir(parents=True, exist_ok=True)
    fingerprint = cfg.fingerprint()
    env_extra = _resolve_api_key(cfg)

    chosen: Dict[str, Optional[Path]] = {}

    try:
        for target in cfg.targets:
            store.update_run(
                current_phase=PHASE_RUNNING,
                current_iteration=int(cfg.targets.index(target)) + 1,
                last_transition_label=f"evaluating {target.dataset}",
            )
            attempt_dir = _latest_complete_attempt(
                evalscope_root, target.dataset, fingerprint, cfg.gate_for(target.dataset)
            )
            if attempt_dir is not None:
                store.append_timeline(
                    "evalscope.dataset.reused",
                    {"dataset": target.dataset, "attempt": attempt_dir.name},
                )
                chosen[target.dataset] = attempt_dir
                continue

            attempt_dir = _next_attempt_dir(evalscope_root, target.dataset)
            started = time.time()
            store.append_timeline(
                "evalscope.dataset.start",
                {"dataset": target.dataset, "attempt": attempt_dir.name},
            )
            result = _runner.run_dataset(
                cfg,
                target,
                attempt_dir=attempt_dir,
                log_file=attempt_dir / "worker.log",
                active=active,
                env_extra=env_extra,
            )
            _write_attempt_meta(
                attempt_dir,
                {
                    "dataset": target.dataset,
                    "fingerprint": fingerprint,
                    "exit_code": result.exit_code,
                    "pid": result.pid,
                    "started_at": started,
                    "finished_at": time.time(),
                },
            )
            store.append_timeline(
                "evalscope.dataset.finished",
                {
                    "dataset": target.dataset,
                    "attempt": attempt_dir.name,
                    "exit_code": result.exit_code,
                },
            )
            chosen[target.dataset] = attempt_dir
    except Exception as exc:  # noqa: BLE001 — infra crash mid-run
        store.update_run(
            current_phase=PHASE_STOPPED,
            finished=True,
            final_status="stopped",
            last_transition_label=f"crash: {type(exc).__name__}: {exc}",
        )
        store.append_timeline("evalscope.crash", {"error": str(exc)})
        clear_pid_file(state_dir / "orchestrator.pid")
        _restore_signals(prev_term, prev_int)
        return 1

    # ---- Finalize: build result.json + mark run --------------------------- #
    store.update_run(current_phase=PHASE_FINALIZING)
    result = _finalize(
        cfg=cfg,
        evalscope_root=evalscope_root,
        chosen=chosen,
        workspace_dir=workspace_dir,
    )
    _write_result_atomic(state_dir / "result.json", result)

    overall_complete = result["complete"]
    if overall_complete:
        label = _success_label(result)
        final_status = "success"
    else:
        label = "incomplete result: " + "; ".join(result["complete_reasons"])
        final_status = "stopped"

    store.update_run(
        current_phase=PHASE_DONE if overall_complete else PHASE_STOPPED,
        finished=True,
        final_status=final_status,
        last_transition_label=label,
    )
    store.append_timeline(
        "evalscope.finish",
        {
            "complete": overall_complete,
            "final_status": final_status,
            "quality_passed": result["quality"]["passed"],
            "quality_configured": result["quality"]["configured"],
        },
    )
    clear_pid_file(state_dir / "orchestrator.pid")
    _restore_signals(prev_term, prev_int)
    return 0 if overall_complete else 2


def _finalize(
    *,
    cfg: _config.EvalConfig,
    evalscope_root: Path,
    chosen: Dict[str, Optional[Path]],
    workspace_dir: Path,
) -> Dict[str, Any]:
    """Normalize every target's chosen attempt into the authoritative result."""
    rows: List[Dict[str, Any]] = []
    for target in cfg.targets:
        attempt_dir = chosen.get(target.dataset)
        if attempt_dir is None:
            rows.append(
                _report.missing_dataset_row(
                    target.dataset, threshold=cfg.gate_for(target.dataset)
                )
            )
            continue
        try:
            rel = attempt_dir.relative_to(workspace_dir)
        except ValueError:
            rel = Path(attempt_dir.name)
        rows.append(
            _report.normalize_attempt_dir(
                attempt_dir,
                target.dataset,
                threshold=cfg.gate_for(target.dataset),
                raw_relative=str(rel),
            )
        )

    complete = all(r["complete"] for r in rows)
    complete_reasons: List[str] = []
    for r in rows:
        if not r["complete"]:
            complete_reasons.extend(r["reasons"])

    gated = [r for r in rows if r.get("threshold") is not None]
    quality_configured = bool(gated)
    if gated:
        quality_passed = all(
            r.get("complete") and r.get("threshold_met") is True for r in gated
        )
    else:
        quality_passed = None

    return {
        "schema_version": 1,
        "task_type": "evalscope-correctness",
        "fingerprint": cfg.fingerprint(),
        "complete": complete,
        "complete_reasons": complete_reasons,
        "quality": {
            "configured": quality_configured,
            "passed": quality_passed,
        },
        "datasets": rows,
    }


def _success_label(result: Dict[str, Any]) -> str:
    q = result["quality"]
    if not q["configured"]:
        return "evaluation complete (no quality gates configured)"
    if q["passed"]:
        return "evaluation complete; all quality gates passed"
    return "evaluation complete; quality gate NOT met (score below configured minimum)"


def _write_result_atomic(path: Path, result: Dict[str, Any]) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(result, indent=2), encoding="utf-8")
    tmp.replace(path)


def _restore_signals(prev_term, prev_int) -> None:
    signal.signal(signal.SIGTERM, prev_term)
    signal.signal(signal.SIGINT, prev_int)
