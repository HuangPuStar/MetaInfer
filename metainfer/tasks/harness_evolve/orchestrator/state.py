"""Experiment state recording for harness_evolve (file-system-as-database).

The WebUI launcher runs the HE orchestrator as a bare ``cli run`` subprocess,
so nothing outside the pipeline would otherwise write the per-task
``run.json`` / ``timeline.jsonl`` that the shell reads for the phase graph
(``state_reader.read_run`` / ``read_timeline``). This module gives the
pipeline a small writer that keeps those files in the same shape DKAO writes:
``run.json`` fields merged with ``state_reader`` defaults, timeline rows as
``{"ts": float, "type": str, "payload": dict}``.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

_RUN_DEFAULTS: Dict[str, Any] = {
    "task_id": None,
    "task_type": None,
    "created_at": 0,
    "current_iteration": 0,
    "current_phase": "idle",
    "last_update": 0,
    "finished": False,
    "final_status": None,
    "last_outcome": None,
    "last_transition_label": None,
    "notes": [],
}


def _load_json(path: Path) -> Optional[Dict[str, Any]]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def read_run(state_dir: Path) -> Dict[str, Any]:
    data = _load_json(Path(state_dir) / "run.json")
    if data is None:
        return dict(_RUN_DEFAULTS)
    return {**_RUN_DEFAULTS, **data}


def set_run(state_dir: Path, **fields: Any) -> Dict[str, Any]:
    """Merge fields into run.json (thread-safe via atomic replace)."""
    state_dir = Path(state_dir)
    state_dir.mkdir(parents=True, exist_ok=True)
    path = state_dir / "run.json"
    run = read_run(state_dir)
    run.update(fields)
    run["last_update"] = time.time()
    _atomic_write_json(path, run)
    return run


def append_timeline(state_dir: Path, event_type: str,
                    payload: Optional[Dict[str, Any]] = None) -> None:
    state_dir = Path(state_dir)
    state_dir.mkdir(parents=True, exist_ok=True)
    path = state_dir / "timeline.jsonl"
    row = {
        "ts": time.time(),
        "type": event_type,
        "payload": payload or {},
    }
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(row, ensure_ascii=False) + "\n")


def _atomic_write_json(path: Path, data: Dict[str, Any]) -> None:
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2),
                   encoding="utf-8")
    os.replace(tmp, path)


def last_phase_event(state_dir: Path) -> Optional[Dict[str, Any]]:
    """Most recent timeline entry (used by tests / diagnostics)."""
    path = Path(state_dir) / "timeline.jsonl"
    if not path.is_file():
        return None
    last: Optional[Dict[str, Any]] = None
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict):
            last = row
    return last


def list_timeline(state_dir: Path) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    path = Path(state_dir) / "timeline.jsonl"
    if not path.is_file():
        return out
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict):
            out.append(row)
    return out


#: Where a running process records the harness code it actually loaded, so a
#: later round can notice the files on disk moved on without it.
REVISION_FILE = "harness_revision.json"


def harness_revision() -> str:
    """Fingerprint of the harness_evolve *code* (not the experiment workspace).

    Rounds run for hours, so an operator who fixes the loop cannot expect the
    running process to pick the change up. This is how the next round notices
    that a restart is required instead of silently running stale logic.
    """
    import hashlib

    root = Path(__file__).resolve().parent
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*.py")):
        try:
            data = path.read_bytes()
        except OSError:
            continue
        digest.update(path.relative_to(root).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(data)
        digest.update(b"\0")
    return digest.hexdigest()[:16]


def write_harness_revision(state_dir: Path,
                           revision: Optional[str] = None) -> str:
    """Record the revision this process actually loaded."""
    value = str(revision or harness_revision())
    state_dir = Path(state_dir)
    state_dir.mkdir(parents=True, exist_ok=True)
    _atomic_write_json(state_dir / REVISION_FILE, {
        "revision": value, "pid": os.getpid(), "started_at": time.time()})
    return value


def loaded_harness_revision(state_dir: Path) -> Optional[str]:
    data = _load_json(Path(state_dir) / REVISION_FILE)
    if not data:
        return None
    value = data.get("revision")
    return str(value) if value else None


#: How many iterations the experiment should reach in TOTAL, kept in a file
#: outside the running process so the target can be adjusted while the outer
#: loop is running (raise it to continue, lower it to stop earlier).
TARGET_FILE = "target_iterations.json"


def target_iterations_path(exp_dir: Path) -> Path:
    return Path(exp_dir) / TARGET_FILE


def read_target_iterations(exp_dir: Path) -> Optional[int]:
    """Total iteration count the experiment should reach (None = unset)."""
    data = _load_json(target_iterations_path(exp_dir))
    if not data:
        return None
    try:
        value = int(data.get("target"))
    except (TypeError, ValueError):
        return None
    return value if value >= 1 else None


def write_target_iterations(exp_dir: Path, target: int) -> Dict[str, Any]:
    exp_dir = Path(exp_dir)
    exp_dir.mkdir(parents=True, exist_ok=True)
    payload = {"target": int(target), "updated_at": time.time()}
    _atomic_write_json(target_iterations_path(exp_dir), payload)
    return payload


def clear_target_iterations(exp_dir: Path) -> None:
    try:
        target_iterations_path(exp_dir).unlink()
    except OSError:
        pass
