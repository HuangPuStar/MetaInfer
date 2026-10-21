"""Cross-task lessons wiki (AHE experience accumulation).

Closes the "experience not cumulative across tasks" gap surfaced in the 16-iter
opt_kernel experiment: the Agent Debugger distills a rich failure-mode taxonomy
(``FM-1..FM-15``) and do-not-repeat list, but it lives inside ONE task's
``analysis/overview.md`` and the next task starts blind. This module persists
those lessons at the **node level** so new tasks of the same ``task_type`` read
them at plan time.

Single source of truth (see CLAUDE.md §数据一致性):

- **Authority** — ``<node>/.metainfer/lessons.jsonl``: a node-level, append-only
  JSONL log. Only ever appended to (from per-task snapshots at task finish) and
  read (by new tasks). No write-back, no bidirectional sync.
- **Historical snapshot** — ``<workspace>/iterations/analysis/lessons.jsonl``:
  written by the Agent Debugger at close. It is appended to the wiki ONCE at
  task finish and never read back for runtime logic (only the wiki is). Matches
  the "historical record, runtime reads from <other_file>" annotation pattern.

Each wiki line::

    {"ts": float, "source_task_id": str, "task_type": str,
     "category": "failure_mode"|"do_not_repeat"|"insight",
     "headline": str, "detail": str}

Advisory: a missing / malformed per-task snapshot yields zero appended records
and never blocks the run, mirroring the debugger / e2e-oracle advisory posture.
``category`` is validated so a free-form agent snapshot cannot pollute the wiki
with arbitrary keys; unrecognized lines are skipped (not rejected wholesale).
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Dict, List, Optional

LESSONS_FILE = "lessons.jsonl"
LESSONS_LOCK = "lessons.lock"

VALID_CATEGORIES = ("failure_mode", "do_not_repeat", "insight")

# Self-evolving wiki (KDA kernel-wiki tenet: "incorrect content gets deleted,
# tags get sharpened, search results get leaner"). At task finish, after
# appending this task's lessons, :func:`maintain_wiki` compacts the node
# wiki: (a) dedup near-identical lessons across tasks (same task_type +
# category + normalized headline → keep the newest), and (b) cap the wiki to
# the most recent :data:`WIKI_CAP_PER_TYPE_CATEGORY` lessons per
# (task_type, category). The wiki is therefore a *compacted* authority (not a
# purely append-only log); the per-task snapshot remains the append-only
# historical record. Advisory: never raises.
WIKI_CAP_PER_TYPE_CATEGORY = 25


def node_metainfer_dir(state_dir: Path) -> Path:
    """The node-level ``.metainfer`` dir that holds ``registry.json``.

    ``state_dir`` is per-task (``<node>/.metainfer/tasks/<task_id>``), so the
    node dir is two levels up. We validate the suffix to fail loudly on a
    misconfigured layout rather than silently writing lessons to the wrong
    place (which would make them invisible to new tasks).
    """
    node_dir = Path(state_dir).parent.parent
    if node_dir.name != ".metainfer":
        raise ValueError(
            f"expected state_dir under <node>/.metainfer/tasks/<id>; "
            f"got {state_dir!r} (two levels up is {node_dir!r}, not a .metainfer dir)"
        )
    return node_dir


def wiki_path(state_dir: Path) -> Path:
    """Absolute path of the node-level lessons wiki."""
    return node_metainfer_dir(state_dir) / LESSONS_FILE


def _task_snapshot_path(analysis_dir: Path) -> Path:
    return Path(analysis_dir) / LESSONS_FILE


def read_wiki_lessons(state_dir: Path, task_type: Optional[str] = None,
                      limit: int = 20) -> List[Dict]:
    """Return recent wiki lessons (oldest first), optionally filtered by
    ``task_type``. ``limit`` caps the number returned (the most recent N).
    Missing / unreadable wiki → ``[]`` (advisory, never raises). A
    non-standard ``state_dir`` layout (``node_metainfer_dir`` raises
    ``ValueError``) is also treated as "no wiki" here, so a misconfigured
    layout degrades the plan prompt silently rather than crashing the
    A phase. (The *writer* path still fails loudly.)"""
    try:
        p = wiki_path(state_dir)
    except ValueError:
        return []
    if not p.is_file():
        return []
    out: List[Dict] = []
    try:
        lines = p.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    for ln in lines:
        ln = ln.strip()
        if not ln:
            continue
        try:
            rec = json.loads(ln)
        except ValueError:
            continue
        if not isinstance(rec, dict):
            continue
        if task_type is not None and rec.get("task_type") != task_type:
            continue
        out.append(rec)
    if limit > 0:
        out = out[-limit:]
    return out


def append_task_lessons(state_dir: Path, analysis_dir: Path, task_id: str,
                       task_type: str, now: Optional[float] = None) -> int:
    """Append this task's debugger-distilled lessons to the node wiki.

    Reads the per-task snapshot ``<analysis_dir>/lessons.jsonl`` (agent-written,
    a historical record), stamps each valid record with ``ts`` /
    ``source_task_id`` / ``task_type``, and appends to the wiki under an
    exclusive lock (so concurrent task finishes on the same node do not
    interleave lines). Returns the number of records appended. A missing or
    empty snapshot → 0. Advisory: never raises — parse errors are skipped.
    """
    ts = float(now if now is not None else time.time())
    snap = _task_snapshot_path(analysis_dir)
    if not snap.is_file():
        return 0
    try:
        raw_lines = snap.read_text(encoding="utf-8").splitlines()
    except OSError:
        return 0

    stamped: List[str] = []
    for ln in raw_lines:
        ln = ln.strip()
        if not ln:
            continue
        try:
            rec = json.loads(ln)
        except ValueError:
            continue
        if not isinstance(rec, dict):
            continue
        category = rec.get("category")
        headline = (rec.get("headline") or "").strip()
        if category not in VALID_CATEGORIES or not headline:
            continue
        record = {
            "ts": ts,
            "source_task_id": str(task_id),
            "task_type": str(task_type),
            "category": category,
            "headline": headline,
            "detail": (rec.get("detail") or "").strip(),
        }
        stamped.append(json.dumps(record, ensure_ascii=False))

    if not stamped:
        return 0

    wp = wiki_path(state_dir)
    wp.parent.mkdir(parents=True, exist_ok=True)
    lock_path = wp.parent / LESSONS_LOCK
    import fcntl  # POSIX only; this project targets Linux DCU hosts
    with open(lock_path, "a") as lf:
        fcntl.flock(lf, fcntl.LOCK_EX)
        try:
            with open(wp, "a", encoding="utf-8") as wf:
                for s in stamped:
                    wf.write(s + "\n")
        finally:
            fcntl.flock(lf, fcntl.LOCK_UN)
    return len(stamped)


def _normalize_headline(h: str) -> str:
    """Case-insensitive, whitespace/punctuation-collapsed headline key for
    near-duplicate detection. Two lessons that say "Do not exceed the
    shared-mem ceiling" and "don't exceed shared-mem ceiling." should merge."""
    import re
    return re.sub(r"[^a-z0-9]+", " ", (h or "").lower()).strip()


def maintain_wiki(state_dir: Path, now: Optional[float] = None) -> int:
    """Compact the node lessons wiki: dedup + recency cap (self-evolving).

    Rewrites ``lessons.jsonl`` under an exclusive lock:

    1. **Dedup** — collapse lessons sharing ``(task_type, category,
       normalized headline)`` keeping the *newest* (highest ``ts``; ties →
       last in file order). This is "tags get sharpened": repeated discovery
       of the same failure mode does not pile up.
    2. **Cap** — keep at most :data:`WIKI_CAP_PER_TYPE_CATEGORY` lessons per
       ``(task_type, category)`` (newest first). This is "search results get
       leaner": a new task is not drowned in stale lessons.

    Returns the number of records remaining after compaction. Advisory:
    never raises — a missing / unreadable / malformed wiki yields 0 and no
    rewrite. Idempotent: running it twice is a no-op the second time.
    """
    try:
        wp = wiki_path(state_dir)
    except ValueError:
        return 0
    if not wp.is_file():
        return 0
    try:
        lines = wp.read_text(encoding="utf-8").splitlines()
    except OSError:
        return 0
    recs: List[Dict] = []
    for ln in lines:
        ln = ln.strip()
        if not ln:
            continue
        try:
            rec = json.loads(ln)
        except ValueError:
            continue
        if isinstance(rec, dict):
            recs.append(rec)
    if not recs:
        return 0
    # Dedup: key = (task_type, category, normalized headline); keep newest.
    # Iterate in file order (oldest→newest) and overwrite the slot so the
    # newest wins; ties (same ts) keep the later position (also newest).
    dedup: Dict[tuple, Dict] = {}
    order: List[tuple] = []
    for rec in recs:
        key = (str(rec.get("task_type", "")),
               str(rec.get("category", "")),
               _normalize_headline(rec.get("headline", "")))
        if key not in dedup:
            order.append(key)
        dedup[key] = rec
    kept = [dedup[k] for k in order]
    # Cap per (task_type, category), newest first.
    buckets: Dict[tuple, List[Dict]] = {}
    for rec in kept:
        b = (str(rec.get("task_type", "")), str(rec.get("category", "")))
        buckets.setdefault(b, []).append(rec)
    final: List[Dict] = []
    for b, items in buckets.items():
        # newest first by ts (then file order via list index as tiebreaker)
        items.sort(key=lambda r: (float(r.get("ts", 0.0)),), reverse=True)
        final.extend(items[:WIKI_CAP_PER_TYPE_CATEGORY])
    # Re-emit in a stable order: by ts ascending (oldest→newest), so the file
    # stays in chronological append order after compaction.
    final.sort(key=lambda r: float(r.get("ts", 0.0)))
    out_lines = [json.dumps(r, ensure_ascii=False) for r in final]
    lock_path = wp.parent / LESSONS_LOCK
    import fcntl
    with open(lock_path, "a") as lf:
        fcntl.flock(lf, fcntl.LOCK_EX)
        try:
            tmp = wp.with_suffix(".jsonl.tmp")
            with open(tmp, "w", encoding="utf-8") as wf:
                for s in out_lines:
                    wf.write(s + "\n")
            tmp.replace(wp)
        finally:
            fcntl.flock(lf, fcntl.LOCK_UN)
    return len(final)


def lessons_prompt_block(lessons: List[Dict]) -> Optional[str]:
    """Render wiki lessons as a prompt section, or ``None`` when empty so the
    caller can omit the section entirely (mirrors ``feedback_text_for_prompt``).

    Most recent first in the prompt (the agent reads top-down); within a record
    the category is uppercased as a tag for quick scanning.
    """
    if not lessons:
        return None
    lines = [
        "# Cross-task lessons (distilled from prior tasks of this type)",
        "# Reuse these — do not rediscover known failure modes or repeat banned changes.",
        "",
    ]
    for rec in reversed(lessons):  # newest first
        tag = str(rec.get("category", "lesson")).upper().replace("_", "-")
        src = rec.get("source_task_id", "?")
        lines.append(f"- [{tag}] (from {src}) {rec.get('headline', '')}")
        detail = (rec.get("detail") or "").strip()
        if detail:
            lines.append(f"    {detail}")
    return "\n".join(lines)
