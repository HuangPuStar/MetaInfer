"""Launch an isolated EvalScope child process for one dataset.

Responsibilities:
* **Preflight** — a lazy, non-crashing check that EvalScope (``>=1.11,<2``)
  is installed and that Docker is available when a sandboxed dataset
  (HumanEval) is requested. MetaInfer's own dependency set stays unchanged;
  EvalScope is only imported inside the child.
* **Child launch** — copy the non-secret config to stdin, copy the API key
  only into the child's environment, run the worker module, and wait.
  The child is NOT given a new session/process group, so it stays inside
  the orchestrator's process group: MetaInfer's existing launcher/PID
  lifecycle kills it together with the task.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional

from . import config as _config

# Module path of the isolated worker (launched via ``python -m ...``).
_WORKER_MODULE = (
    "metainfer.tasks.evalscope_correctness.orchestrator.evalscope_worker"
)

# EvalScope version window we validate against.
EVALSCOPE_MIN = (1, 11)
EVALSCOPE_MAX = (2, 0)


@dataclass
class Preflight:
    """Result of checking the environment can run a target."""

    ok: bool
    error: str = ""

    def __bool__(self) -> bool:  # pragma: no cover - trivial
        return self.ok


def check_evalscope_install() -> Preflight:
    """Verify a compatible EvalScope is importable (lazily, no heavy import).

    Uses importlib metadata rather than importing evalscope so we don't
    trigger its heavy import chain inside the orchestrator.
    """
    import importlib.metadata
    try:
        version = importlib.metadata.version("evalscope")
    except importlib.metadata.PackageNotFoundError:
        return Preflight(
            False,
            "EvalScope is not installed. Install with: "
            "pip install 'evalscope>=1.11,<2'",
        )
    parts = []
    for seg in version.split(".")[:2]:
        try:
            parts.append(int(seg))
        except ValueError:
            parts.append(0)
    vtuple = tuple(parts[:2])
    if not (EVALSCOPE_MIN <= vtuple < EVALSCOPE_MAX):
        return Preflight(
            False,
            f"EvalScope {version} is not in the supported range "
            f"[{EVALSCOPE_MIN[0]}.{EVALSCOPE_MIN[1]}, {EVALSCOPE_MAX[0]}.0); "
            "install 'evalscope>=1.11,<2'",
        )
    return Preflight(True)


def check_sandbox_available() -> Preflight:
    """Verify Docker (the sandbox engine) is available on PATH."""
    import shutil
    if shutil.which("docker") is None:
        return Preflight(
            False,
            "Docker is required to sandbox HumanEval code execution, but "
            "'docker' was not found on PATH. Start Docker or omit HumanEval.",
        )
    return Preflight(True)


def preflight_for(cfg: _config.EvalConfig) -> Optional[str]:
    """Return an error string if the environment can't run the request.

    Checks EvalScope installation always; checks Docker only when a
    sandboxed dataset is requested. A return of ``None`` means ready.
    """
    ev = check_evalscope_install()
    if not ev.ok:
        return ev.error
    if any(t.needs_sandbox for t in cfg.targets):
        sand = check_sandbox_available()
        if not sand.ok:
            return sand.error
    return None


@dataclass
class ChildResult:
    exit_code: int
    pid: Optional[int] = None


def run_dataset(
    cfg: _config.EvalConfig,
    target,
    *,
    attempt_dir: Path,
    log_file: Path,
    active: Dict[str, Any],
    env_extra: Optional[Dict[str, str]] = None,
) -> ChildResult:
    """Evaluate one dataset in a fresh attempt directory.

    ``active`` is a mutable holder (``{'proc': None}``) the caller uses to
    terminate the running child on SIGTERM/SIGINT; we register the Popen
    there for the duration of the wait. ``env_extra`` lets the caller inject
    the API key (and any other vars) into the child environment without
    them ever touching argv or logs.
    """
    attempt_dir.mkdir(parents=True, exist_ok=True)

    # Build the non-secret child config (never the key).
    child_cfg: Dict[str, Any] = cfg.to_child_json()
    child_cfg["work_dir"] = str(attempt_dir)
    child_cfg["datasets"] = [target.dataset]
    child_cfg["needs_sandbox"] = bool(target.needs_sandbox)

    # Preserve the exact config we sent as immutable evidence.
    (attempt_dir / "child_config.json").write_text(
        json.dumps(child_cfg, indent=2), encoding="utf-8"
    )

    env = dict(os.environ)
    if env_extra:
        env.update(env_extra)

    log_file.parent.mkdir(parents=True, exist_ok=True)
    stdout_fh = log_file.open("ab", buffering=0) if str(log_file) != "-" else None

    payload = json.dumps(child_cfg) + "\n"
    proc = subprocess.Popen(
        [sys.executable, "-m", _WORKER_MODULE],
        stdin=subprocess.PIPE,
        stdout=stdout_fh if stdout_fh else None,
        stderr=subprocess.STDOUT,
        env=env,
        # No start_new_session: keep the child inside the orchestrator's
        # process group so a group kill reaches it too.
        start_new_session=False,
        text=True,
    )

    active["proc"] = proc
    try:
        assert proc.stdin is not None
        proc.stdin.write(payload)
        proc.stdin.close()
        exit_code = proc.wait()
    finally:
        active["proc"] = None
        if stdout_fh is not None:
            stdout_fh.close()

    return ChildResult(exit_code=exit_code, pid=proc.pid)
