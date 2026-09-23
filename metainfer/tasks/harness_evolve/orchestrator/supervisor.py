"""Incident supervisor for unattended harness_evolve runs.

The outer loop is long (hours per round) and can die in ways that are not the
harness' fault (the GPU filled up, an agent transport closed, the host killed
the process). This supervisor watches the experiment and, per incident class,
takes the *safe* action automatically:

  resource       the host ran out of memory and killed the run (exit 137 /
                 OOM markers in the log) -> wait (default 30 min), then restart
                 the round. HE never inspects the cards: a device verdict is
                 DKAO's (FLOW.md §0)
  agent          flaky agent transport/timeout -> exponential backoff restart
  code           deterministic traceback/config error -> do NOT loop; stop and
                 report (retrying would replay the same failure)
  unknown        restart once, then stop

Every decision is a pure function (:func:`classify_incident`,
:func:`decide_action`) so the behaviour is testable without touching GPUs, and
every action is appended to ``incidents.jsonl`` for audit. Repeated failures of
the same class trip a circuit breaker that stops the run instead of burning
compute unattended.

Optionally (``--diagnose-agent``) it asks a read-only DSH agent to write
``incident_report.md`` with a root-cause hypothesis; that report is advisory
only — it never performs restarts itself.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

CATEGORY_RESOURCE = "resource"
CATEGORY_AGENT = "agent"
CATEGORY_CODE = "code"
CATEGORY_UNKNOWN = "unknown"

_RESOURCE_MARKERS = (
    "outofmemory", "out of memory", "hipErrorOutOfMemory", "bad_alloc",
    "cannot allocate memory", "no space left", "memory exhausted",
)
_AGENT_MARKERS = (
    "transportclosederror", "timed out after", "timeoutexpired",
    "nonzero exit 1", "agent attempt", "connection reset",
)
_CODE_MARKERS = ("traceback (most recent call last)",)


def classify_incident(*, log_tail: str = "",
                      exit_code: Optional[int] = None) -> Tuple[str, List[str]]:
    """Return ``(category, evidence)`` for one observed failure.

    The verdict comes from *this run's own* evidence (exit status and log text);
    HE holds no device verdict of its own (FLOW.md §0), so nothing here reads
    the cards.
    """
    text = (log_tail or "").lower()
    evidence: List[str] = []
    if exit_code in (137, -9):
        evidence.append(f"exit code {exit_code} (killed, usually OOM)")
    for marker in _RESOURCE_MARKERS:
        if marker.lower() in text:
            evidence.append(f"log mentions {marker!r}")
            break
    if evidence:
        return CATEGORY_RESOURCE, evidence
    for marker in _AGENT_MARKERS:
        if marker.lower() in text:
            return CATEGORY_AGENT, [f"log mentions {marker!r}"]
    for marker in _CODE_MARKERS:
        if marker in text:
            return CATEGORY_CODE, ["deterministic traceback in the log"]
    return CATEGORY_UNKNOWN, evidence or ["no recognisable failure signature"]


def decide_action(*, category: str, same_class_streak: int,
                  waits_done: int, restarts_done: int,
                  running: bool,
                  max_restarts: int = 3, max_waits: int = 6,
                  breaker_streak: int = 3,
                  wait_seconds: int = 1800) -> Dict[str, Any]:
    """Pure policy: what to do about one incident.

    ``action`` is one of ``restart`` | ``wait`` | ``stop`` | ``run`` (healthy)
    | ``done`` (target already reached).
    """
    if running:
        return {"action": "run", "sleep_s": 0,
                "reason": "experiment process is alive"}
    if same_class_streak >= breaker_streak and category != CATEGORY_RESOURCE:
        return {"action": "stop", "sleep_s": 0,
                "reason": (f"circuit breaker: {same_class_streak} consecutive "
                           f"{category} failures")}
    if category == CATEGORY_CODE:
        return {"action": "stop", "sleep_s": 0,
                "reason": ("deterministic code/config failure; restarting "
                           "would replay it")}
    if category == CATEGORY_RESOURCE:
        if waits_done >= max_waits:
            return {"action": "stop", "sleep_s": 0,
                    "reason": f"resource still short after {waits_done} waits"}
        return {"action": "wait", "sleep_s": int(wait_seconds),
                "reason": ("memory pressure: wait, re-check free VRAM, then "
                           "restart")}
    if restarts_done >= max_restarts:
        return {"action": "stop", "sleep_s": 0,
                "reason": f"gave up after {restarts_done} restarts"}
    backoff = wait_seconds if category == CATEGORY_AGENT else 300
    return {"action": "restart", "sleep_s": min(backoff, 1800),
            "reason": f"{category} failure; restart with backoff"}


def pid_is_live(pid: Optional[int], *, marker: str = "harness_evolve",
                proc_root: Path = Path("/proc")) -> bool:
    """Live (non-zombie) process whose cmdline mentions ``marker``.

    Shared by the supervisor and the server so both agree on what "running"
    means: a zombie child or a recycled pid must never count as alive.

    ``proc_root`` exists so tests can build a fake process table (the same hook
    ``live_child_count`` already has); it defaults to the real ``/proc``.
    """
    if not pid or pid == os.getpid():
        return False
    proc = Path(proc_root) / str(int(pid))
    if not proc.exists():
        return False
    try:
        state = (proc / "stat").read_text(encoding="utf-8").split(") ", 1)[1].split()[0]
    except (OSError, IndexError):
        return False
    if state == "Z":
        return False
    try:
        cmdline = (proc / "cmdline").read_bytes().replace(b"\0", b" ").decode(
            "utf-8", "replace")
    except OSError:
        return False
    return marker in cmdline


def pid_from_file(path: Path) -> Optional[int]:
    """The PID recorded in a pid file, whether it is JSON or a bare number.

    Both writers in this package use JSON (``{"pid": …}``); an older process may
    have left a bare number. Reading only the bare form is what made every
    current pid file unparseable, which silently pushed every liveness question
    onto the ``/proc`` cmdline scan — and that scan then matched the *caller
    itself*, so a resume could never start round 1.
    """
    try:
        raw = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    if not raw:
        return None
    if raw.startswith("{"):
        try:
            data = json.loads(raw)
        except ValueError:
            return None
        try:
            return int(data.get("pid"))
        except (TypeError, ValueError):
            return None
    try:
        return int(raw.split()[0])
    except (IndexError, ValueError):
        return None


def task_process_alive(state_dir: Path, *,
                       exclude: Optional[int] = None,
                       proc_root: Path = Path("/proc"),
                       self_pid: Optional[int] = None) -> Optional[int]:
    """PID of *another* live orchestrator for this task, whichever path started it.

    Tasks can be started by the server ("run") or by the supervisor
    ("resume"); ``resume.pid`` alone is not enough, and a server-started task
    has no resume pid at all. Falling back to a cmdline scan keeps the
    supervisor from "restarting" a perfectly healthy run.

    The caller's own pid is never returned (and ``exclude`` adds another): a
    resume asking "is somebody else running this experiment?" must not answer
    itself, or it will stand down forever and no round will ever start.
    """
    state_dir = Path(state_dir)
    excluded = {int(self_pid) if self_pid is not None else os.getpid()}
    if exclude:
        excluded.add(int(exclude))
    for name in ("orchestrator.pid", "resume.pid"):
        pid = pid_from_file(state_dir / name)
        if not pid or pid in excluded:
            continue
        if pid_is_live(pid, proc_root=proc_root):
            return pid
    marker = str(state_dir)
    for entry in Path(proc_root).iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        if pid in excluded:
            continue
        try:
            cmdline = (entry / "cmdline").read_bytes().replace(b"\0", b" ").decode(
                "utf-8", "replace")
        except OSError:
            continue
        if "harness_evolve.orchestrator.cli" in cmdline and marker in cmdline:
            return pid
    return None


class Supervisor:
    """Watch one experiment and keep it moving toward its target round."""

    def __init__(self, state_dir: Path, workspace_dir: Path, *,
                 target: Optional[int] = None, interval_s: int = 30,
                 wait_seconds: int = 1800, max_restarts: int = 3,
                 max_waits: int = 6, diagnose_agent: bool = False,
                 stall_seconds: int = 2400,
                 clock: Callable[[], float] = time.time,
                 sleeper: Callable[[float], None] = time.sleep,
                 resume_launcher: Optional[Callable[[], int]] = None,
                 ) -> None:
        self.state_dir = Path(state_dir)
        self.workspace_dir = Path(workspace_dir)
        self.exp_dir = self.workspace_dir
        self.target = target
        self.interval_s = int(interval_s)
        self.wait_seconds = int(wait_seconds)
        self.max_restarts = int(max_restarts)
        self.max_waits = int(max_waits)
        self.diagnose_agent = bool(diagnose_agent)
        self.stall_seconds = int(stall_seconds)
        self._resume_proc = None
        self.clock = clock
        self.sleeper = sleeper
        self._resume_launcher = resume_launcher
        self.state_path = self.exp_dir / "supervisor_state.json"
        self.incidents_path = self.exp_dir / "incidents.jsonl"
        self.stop_flag = self.exp_dir / "supervisor.stop"

    # ---------------------------------------------------------------- state
    def read_state(self) -> Dict[str, Any]:
        try:
            return json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def write_state(self, **fields: Any) -> Dict[str, Any]:
        state = self.read_state()
        state.update(fields)
        state["updated_at"] = self.clock()
        try:
            self.state_path.write_text(
                json.dumps(state, ensure_ascii=False, indent=2),
                encoding="utf-8")
        except OSError:
            pass
        return state

    def record_incident(self, **fields: Any) -> None:
        row = {"ts": self.clock(), **fields}
        try:
            with self.incidents_path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
        except OSError:
            pass

    # ----------------------------------------------------------- inspection
    def _read_json(self, path: Path) -> Dict[str, Any]:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def run_state(self) -> Dict[str, Any]:
        return self._read_json(self.state_dir / "run.json")

    def current_target(self) -> Optional[int]:
        if self.target is not None:
            return int(self.target)
        data = self._read_json(self.exp_dir / "target_iterations.json")
        try:
            return int(data.get("target"))
        except (TypeError, ValueError):
            return None

    # NOTE: there is deliberately no ``free_gb()`` / device query here any more.
    # HE does not read the cards (FLOW.md §0): whether a device is clean enough
    # to measure on is DKAO's verdict, taken in the child's own gate, and the
    # only place it is recorded is the child's ``measurement_gate.jsonl``.

    def resume_pid(self) -> Optional[int]:
        try:
            return int((self.state_dir / "resume.pid")
                       .read_text(encoding="utf-8").split()[0])
        except (OSError, ValueError, IndexError):
            return None

    def process_alive(self) -> bool:
        """True when *any* orchestrator process for this task is alive.

        Covers both launch paths (server "run" and supervisor "resume") and
        rejects zombies, which is what the stuck-then-restarting failure mode
        needed.
        """
        return task_process_alive(self.state_dir) is not None

    def progress_age(self) -> Optional[float]:
        """Seconds since *any* part of the run last made progress.

        The outer loop is mostly waiting: during ``evaluate`` it can sit for
        hours while the DKAO children work, and the outer timeline barely
        changes. Counting child state as progress prevents the stall guard
        from killing a perfectly healthy long round (which would turn into a
        restart storm).
        """
        newest = 0.0
        for name in ("run.json", "timeline.jsonl"):
            try:
                newest = max(newest, (self.state_dir / name).stat().st_mtime)
            except OSError:
                continue
        iteration = int(self.run_state().get("current_iteration") or 0)
        children_root = self.exp_dir / "children"
        if iteration and children_root.is_dir():
            # One round can own two child directories: the performance pass
            # (``iteration_NNN``) and, when that pass won its gate, the
            # generalization retake (``iteration_NNN_generalization``). Both are
            # part of "what is running right now".
            for name in (f"iteration_{iteration:03d}",
                         f"iteration_{iteration:03d}_generalization"):
                current = children_root / name
                if not current.is_dir():
                    continue
                for child in current.iterdir():
                    for relative in ("state/timeline.jsonl", "state/run.json",
                                     "orchestrator-external.log"):
                        try:
                            newest = max(newest,
                                         (child / relative).stat().st_mtime)
                        except OSError:
                            continue
        if newest <= 0:
            return None
        return max(0.0, self.clock() - newest)

    def live_child_count(self, proc_root: Path = Path("/proc")) -> int:
        """Live DKAO children of the iteration currently being evaluated.

        The stall guard needs *processes*, not only file mtimes: a child that is
        generating or measuring a kernel can be silent for an hour, and reading
        that as "the run died" produced a duplicate resume per stall.
        """
        iteration = int(self.run_state().get("current_iteration") or 0)
        if not iteration:
            return 0
        # ``iteration_NNN`` also matches ``iteration_NNN_generalization``: both
        # belong to the round being evaluated (the retake is the same round).
        needle = f"children/iteration_{iteration:03d}"
        alive = 0
        try:
            entries = list(proc_root.iterdir())
        except OSError:
            return 0
        for entry in entries:
            if not entry.name.isdigit():
                continue
            try:
                cmdline = (entry / "cmdline").read_bytes().replace(
                    b"\0", b" ").decode("utf-8", "replace")
            except OSError:
                continue
            if needle not in cmdline or "dcu_kernel_auto_opt" not in cmdline:
                continue
            try:
                state = (entry / "stat").read_text().split(") ", 1)[1].split()[0]
            except (OSError, IndexError, ValueError):
                continue
            if state != "Z":
                alive += 1
        return alive

    def stale_run_pids(self) -> List[int]:
        """Orchestrator processes for this task that are still alive."""
        marker = str(self.state_dir)
        out: List[int] = []
        try:
            entries = list(Path("/proc").iterdir())
        except OSError:
            return out
        for entry in entries:
            if not entry.name.isdigit():
                continue
            pid = int(entry.name)
            try:
                cmdline = (entry / "cmdline").read_bytes().replace(
                    b"\0", b" ").decode("utf-8", "replace")
            except OSError:
                continue
            if "harness_evolve.orchestrator.cli" in cmdline and marker in cmdline:
                out.append(pid)
        return out

    def terminate_stale_run(self, pids: Optional[Sequence[int]] = None
                            ) -> List[int]:
        """Kill a stalled run's process groups; return the pids that were signalled.

        Their children are killed with them (each orchestrator starts its own
        session), so the GPU leases they hold are reaped by the broker instead
        of blocking the round that replaces them.
        """
        if pids is None:
            pids = self.stale_run_pids()
        pids = [int(pid) for pid in pids if int(pid) != os.getpid()]
        for pid in pids:
            try:
                os.killpg(os.getpgid(pid), signal.SIGTERM)
            except OSError:
                try:
                    os.kill(pid, signal.SIGTERM)
                except OSError:
                    continue
        deadline = self.clock() + 10.0
        while self.clock() < deadline:
            if not any(pid_is_live(pid) for pid in pids):
                return pids
            self.sleeper(0.5)
        for pid in pids:
            if not pid_is_live(pid):
                continue
            try:
                os.killpg(os.getpgid(pid), signal.SIGKILL)
            except OSError:
                try:
                    os.kill(pid, signal.SIGKILL)
                except OSError:
                    continue
        return pids

    def reap_child(self) -> Optional[int]:
        """Collect a finished child so it cannot linger as a zombie."""
        proc = getattr(self, "_resume_proc", None)
        if proc is None:
            return None
        code = proc.poll()
        if code is None:
            return None
        self._resume_proc = None
        self.record_incident(action="resume_exited", category=CATEGORY_UNKNOWN,
                             pid=proc.pid, returncode=code)
        return int(code)

    def _log_tail(self, size: int = 4000) -> str:
        parts: List[str] = []
        for name in ("resume.log", "orchestrator.log"):
            path = self.state_dir / name
            if path.is_file():
                try:
                    parts.append(path.read_text(encoding="utf-8",
                                                errors="replace")[-size:])
                except OSError:
                    continue
        return "\n".join(parts)

    # ------------------------------------------------------------- actions
    @staticmethod
    def project_root() -> Path:
        """Directory that contains the ``metainfer`` package.

        Getting this wrong makes the restarted process die instantly with
        ``ModuleNotFoundError: No module named 'metainfer'`` — which is exactly
        how a supervised run can look "stuck in analyze".
        """
        here = Path(__file__).resolve()
        for parent in here.parents:
            if (parent / "metainfer" / "tasks").is_dir():
                return parent
        return here.parents[4]

    def _launch_resume(self) -> int:
        if self._resume_launcher is not None:
            return int(self._resume_launcher())
        meta_root = self.project_root()
        log = (self.state_dir / "resume.log").open("a", encoding="utf-8")
        cmd = [
            sys.executable, "-m",
            "metainfer.tasks.harness_evolve.orchestrator.cli", "resume",
            "--state-dir", str(self.state_dir),
            "--workspace-dir", str(self.workspace_dir),
        ]
        env = dict(os.environ)
        env.setdefault("PYTHONPATH", str(meta_root))
        proc = subprocess.Popen(
            cmd, cwd=str(meta_root), stdout=log, stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL, env=env, start_new_session=True)
        log.close()
        # Keep the handle so the child can be reaped: an unreaped child stays
        # as a zombie, and a zombie still answers ``os.kill(pid, 0)``.
        self._resume_proc = proc
        (self.state_dir / "resume.pid").write_text(str(proc.pid),
                                                   encoding="utf-8")
        return int(proc.pid)

    def write_incident_report(self, incident: Dict[str, Any]) -> Optional[Path]:
        """Ask a read-only DSH agent for a root-cause report (advisory)."""
        if not self.diagnose_agent:
            return None
        # Local import: this advisory path must not add an import edge from the
        # supervisor to the evolve module at load time.
        from .evolve import DEFAULT_EVOLVE_MODEL

        wrapper = (Path(__file__).resolve().parents[2]
                   / "dcu_kernel_auto_opt" / "bridge" / "dsh" / "dsh_agent.py")
        if not wrapper.is_file():
            return None
        report = self.exp_dir / "incident_report.md"
        prompt = (
            "You are diagnosing a crashed kernel-optimization experiment. "
            f"Read these logs if useful: {self.state_dir}/resume.log, "
            f"{self.state_dir}/orchestrator.log, and the incident record at "
            f"{self.incidents_path}. Latest incident: {json.dumps(incident)[:2000]}\n"
            f"Write a concise markdown report to {report} with: (1) most likely "
            "root cause with the log lines that support it, (2) whether a "
            "restart would help, (3) one concrete prevention suggestion. "
            "Do not run commands; analysis and the file write only."
        )
        try:
            proc = subprocess.run(
                [sys.executable, str(wrapper), "-p", "--output-format",
                 "stream-json", "--input-format", "text",
                 "--permission-mode", "bypassPermissions",
                 "--add-dir", str(self.exp_dir), "--model",
                 DEFAULT_EVOLVE_MODEL, "--effort", "low",
                 "--tools", "Read,Glob,Grep,Write",
                 "--disallowedTools", "Bash,Skill,WebFetch,WebSearch"],
                input=prompt, text=True, capture_output=True, timeout=1200,
                env=dict(os.environ))
        except Exception:  # noqa: BLE001 - diagnostics are best effort
            return None
        return report if report.is_file() else None

    # ---------------------------------------------------------------- loop
    def step(self) -> Dict[str, Any]:
        """One supervision tick. Returns the decision record."""
        if self.stop_flag.exists():
            self.write_state(status="stopped", reason="stop flag present")
            return {"action": "stop", "reason": "stop flag present"}

        self.reap_child()
        run = self.run_state()
        target = self.current_target()
        iteration = int(run.get("current_iteration") or 0)
        finished = bool(run.get("finished"))
        alive = self.process_alive()
        stalled = False
        if alive and not finished:
            age = self.progress_age()
            if age is not None and age > float(self.stall_seconds):
                live_children = self.live_child_count()
                if live_children:
                    # A DKAO child can spend an hour generating a kernel without
                    # writing its own state. That is work, not a stall, and
                    # calling it one used to start a *second* resume process
                    # that then fought the first one for the same four devices.
                    self.record_incident(action="stall_ignored",
                                         category=CATEGORY_UNKNOWN,
                                         idle_seconds=int(age),
                                         live_children=live_children,
                                         reason="children of this iteration "
                                                "are still running")
                else:
                    stalled = True
                    alive = False
                    self.record_incident(action="stalled",
                                         category=CATEGORY_UNKNOWN,
                                         pid=self.resume_pid(),
                                         idle_seconds=int(age),
                                         reason="no state written for too long")
                    # Never leave the stalled process behind: an orphan keeps
                    # its GPU leases and starves the round that replaces it.
                    killed = self.terminate_stale_run()
                    if killed:
                        self.record_incident(action="stalled_killed",
                                             category=CATEGORY_UNKNOWN,
                                             pids=killed)

        if target is not None and iteration >= target and finished:
            self.write_state(status="done", iteration=iteration,
                             target=target)
            return {"action": "done", "reason": f"target {target} reached",
                    "iteration": iteration, "target": target}

        same_streak = int(self.read_state().get("same_class_streak") or 0)
        waits = int(self.read_state().get("waits_done") or 0)
        restarts = int(self.read_state().get("restarts_done") or 0)

        incident: Optional[Dict[str, Any]] = None
        category = CATEGORY_UNKNOWN
        if alive:
            decision = {"action": "run", "sleep_s": 0,
                        "reason": "experiment process is alive"}
        else:
            category, evidence = classify_incident(log_tail=self._log_tail())
            last_category = str(self.read_state().get("last_category") or "")
            same_streak = same_streak + 1 if category == last_category else 1
            incident = {
                "category": category, "evidence": evidence,
                "iteration": iteration,
                "finished": finished, "target": target,
            }
            decision = decide_action(
                category=category, same_class_streak=same_streak,
                waits_done=waits, restarts_done=restarts, running=False,
                max_restarts=self.max_restarts, max_waits=self.max_waits,
                wait_seconds=self.wait_seconds)

        action = decision["action"]
        if action == "done":
            self.write_state(status="done")
            return decision

        if action == "run":
            self.write_state(status="running", target=target,
                             iteration=iteration, last_category=None,
                             same_class_streak=0, waits_done=0,
                             restarts_done=0)
            return decision

        if action == "stop":
            self.write_state(status="stopped", reason=decision["reason"],
                             last_category=category,
                             same_class_streak=same_streak)
            self.record_incident(action="stop", category=category,
                                 reason=decision["reason"],
                                 evidence=(incident or {}).get("evidence"))
            if incident:
                self.write_incident_report({**incident, **decision})
            return decision

        if action == "wait":
            self.record_incident(action="wait", category=category,
                                 seconds=decision["sleep_s"],
                                 reason=decision["reason"],
                                 evidence=(incident or {}).get("evidence"))
            self.write_state(status="waiting", last_category=category,
                             same_class_streak=same_streak,
                             waits_done=waits + 1,
                             waiting_until=self.clock() + decision["sleep_s"],
                             reason=decision["reason"])
            self.sleeper(decision["sleep_s"])
            # The wait is over: restart the run. Whether a card is clean by then
            # is DKAO's business (FLOW.md §0) — its gate waits on the child's
            # behalf, so there is nothing for HE to re-check here.
            pid = self._launch_resume()
            self.record_incident(action="restart_after_wait",
                                 category=category, pid=pid)
            self.write_state(status="running", pid=pid,
                             waits_done=waits + 1)
            return {**decision, "action": "restart", "pid": pid}

        # restart (backoff)
        if decision.get("sleep_s"):
            self.sleeper(decision["sleep_s"])
        pid = self._launch_resume()
        self.record_incident(action="restart", category=category, pid=pid,
                             reason=decision["reason"],
                             evidence=(incident or {}).get("evidence"))
        self.write_state(status="running", pid=pid, last_category=category,
                         same_class_streak=same_streak,
                         restarts_done=restarts + 1)
        return {**decision, "pid": pid}

    def run_forever(self, max_ticks: Optional[int] = None) -> Dict[str, Any]:
        self.write_state(status="starting", target=self.current_target(),
                         pid=os.getpid())
        ticks = 0
        last: Dict[str, Any] = {}
        while max_ticks is None or ticks < max_ticks:
            last = self.step()
            ticks += 1
            if last.get("action") in {"done", "stop"}:
                break
            self.sleeper(self.interval_s)
        return last


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(prog="harness-evolve-supervisor")
    sub = ap.add_subparsers(dest="command", required=True)
    watch = sub.add_parser("watch", help="supervise one experiment")
    watch.add_argument("--state-dir", type=Path, required=True)
    watch.add_argument("--workspace-dir", type=Path, required=True)
    watch.add_argument("--target", type=int, default=None)
    watch.add_argument("--interval", type=int, default=30)
    watch.add_argument("--wait-seconds", type=int, default=1800)
    watch.add_argument("--max-restarts", type=int, default=3)
    watch.add_argument("--max-waits", type=int, default=6)
    watch.add_argument("--diagnose-agent", action="store_true")
    watch.add_argument("--stall-seconds", type=int, default=2400)
    args = ap.parse_args(argv)

    if args.command == "watch":
        sup = Supervisor(
            args.state_dir, args.workspace_dir, target=args.target,
            interval_s=args.interval, wait_seconds=args.wait_seconds,
            max_restarts=args.max_restarts, max_waits=args.max_waits,
            diagnose_agent=args.diagnose_agent,
            stall_seconds=args.stall_seconds,
        )
        (args.workspace_dir).mkdir(parents=True, exist_ok=True)
        (args.state_dir).mkdir(parents=True, exist_ok=True)
        pid_file = args.workspace_dir / "supervisor.pid"
        pid_file.write_text(str(os.getpid()), encoding="utf-8")
        try:
            final = sup.run_forever()
        finally:
            try:
                pid_file.unlink()
            except OSError:
                pass
        print(json.dumps(final, ensure_ascii=False))
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
