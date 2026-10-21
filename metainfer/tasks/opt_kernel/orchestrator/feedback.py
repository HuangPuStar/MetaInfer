"""User feedback channel — persistent operator guidance during a run.

SSOT: ``state_dir/user_feedback.jsonl`` — an append-only log of operator
opinions. The WebUI POSTs here (one line per submission); the orchestrator
reads **all** entries at each A_plan and injects them into the planner
prompt as persistent guidance (the "持久指导" design chosen by the operator:
once submitted, an opinion guides **every subsequent iteration** until the
run ends — direction-level guidance is meant to keep applying).

No consumption cursor is needed: the orchestrator only *reads* the log, so
its reads never race with WebUI appends. Concurrent POSTs are serialized
with ``user_feedback.lock`` (fcntl). This keeps one authoritative file per
fact (CLAUDE.md "数据一致性"): the log is the single source of operator
opinions; nothing else stores a copy.

Each line: ``{"ts": float, "id": str, "iteration_at_submit": int|null,
"text": str}``.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from typing import List, Optional

FEEDBACK_FILE = "user_feedback.jsonl"
FEEDBACK_LOCK = "user_feedback.lock"


def feedback_path(state_dir: Path) -> Path:
    return Path(state_dir) / FEEDBACK_FILE


def read_feedback(state_dir: Path) -> List[dict]:
    """Return all feedback entries (oldest first), or [] if none yet."""
    p = feedback_path(state_dir)
    if not p.exists():
        return []
    out: List[dict] = []
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except (ValueError, OSError):
            continue
    return out


def append_feedback(state_dir: Path, text: str,
                    iteration_at_submit: Optional[int] = None) -> dict:
    """Append one operator opinion. Raises ValueError on empty text."""
    text = (text or "").strip()
    if not text:
        raise ValueError("feedback text must be non-empty")
    entry = {
        "ts": time.time(),
        "id": uuid.uuid4().hex,
        "iteration_at_submit": iteration_at_submit,
        "text": text,
    }
    p = feedback_path(state_dir)
    p.parent.mkdir(parents=True, exist_ok=True)
    lock_path = Path(state_dir) / FEEDBACK_LOCK
    import fcntl  # POSIX only; this project targets Linux DCU hosts
    with open(lock_path, "w") as lf:
        fcntl.flock(lf, fcntl.LOCK_EX)
        try:
            with open(p, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
                f.flush()
                os.fsync(f.fileno())
        finally:
            fcntl.flock(lf, fcntl.LOCK_UN)
    return entry


def feedback_text_for_prompt(state_dir: Path) -> Optional[str]:
    """Join all feedback entries into a single prompt block (oldest first).

    Returns None when there is no feedback, so the caller can omit the
    section entirely rather than render an empty one.
    """
    entries = read_feedback(state_dir)
    if not entries:
        return None
    lines: List[str] = []
    for i, e in enumerate(entries, 1):
        ts = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(e.get("ts", 0)))
        it = e.get("iteration_at_submit")
        tag = f" [submitted at iter {it}]" if it is not None else ""
        lines.append(f"({i}) [{ts}{tag}] {e.get('text', '')}")
    return "\n".join(lines)
