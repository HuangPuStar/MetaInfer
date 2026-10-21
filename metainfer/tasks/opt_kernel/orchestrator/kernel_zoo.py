"""Kernel zoo — a node-level library of reusable kernel implementations.

Inspired by the KDA blog's *kernel zoo* ("a kernel zoo of reusable
implementations" inside the TIRx Harness, see
https://nvlabs.github.io/kda/blog/2026-09-27-kda-for-kda). The zoo shortens the
feedback loop for a new optimization task: instead of starting every task from
a blank page, the planner reads proven kernels from *prior* finished tasks of
the same kind and reuses them as scaffolds / building blocks.

Single source of truth (see CLAUDE.md §数据一致性):

- **Authority** — ``<node>/.metainfer/kernel_zoo.jsonl``: a node-level JSONL
  index of promoted kernels. Appended to at task finish (best kernel of the
  run) and read at plan time. Capped to :data:`MAX_ZOO_ENTRIES` (oldest dropped)
  so the zoo stays lean, mirroring the KDA kernel-wiki tenet "search results
  get leaner". Like the lessons wiki this is a compacted authority (not a
  purely append-only log): promotion may drop the oldest entry.
- **Per-task provenance** — the promoted kernel source is **inlined** into the
  zoo entry (capped at :data:`MAX_SRC_INLINE` bytes) so the zoo is
  self-contained and survives a workspace reset. We never store a path into a
  task workspace and read it back (that workspace may be reset/deleted →
  dangling ref). The original task workspace remains the historical record.

Each zoo entry::

    {"ts": float, "source_task_id": str, "task_type": str,
     "tags": {"operator": str, "hardware": str, "language": str,
              "shapes": str},
     "perf": {<flat perf dict of the best iteration>},
     "primary": {"metric": str, "value": float, "direction": "decrease"|"increase"},
     "kernel_file": str,      # filename within the best iter dir
     "kernel_src": str,        # inlined source (capped)
     "note": str}

Advisory: a missing/empty best iteration, an unreadable kernel file, or a
non-standard ``state_dir`` layout all yield no promotion and never block the
finish path. The planner prompt block is omitted when no matching entry exists.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import metrics
from .lessons import node_metainfer_dir

ZOO_FILE = "kernel_zoo.jsonl"
ZOO_LOCK = "kernel_zoo.lock"

# Inline at most this many bytes of kernel source into a zoo entry so the zoo
# file stays small and the prompt block stays bounded. Larger kernels are
# truncated with a visible marker.
MAX_SRC_INLINE = 24 * 1024

# Cap the zoo to this many entries (drop oldest on overflow) so "search
# results get leaner" — a new task does not drown in stale scaffolds.
MAX_ZOO_ENTRIES = 40

# How many matching entries to surface in the planner prompt block.
PROMPT_BLOCK_LIMIT = 3

# Source extensions we consider "the kernel" when picking what to inline.
_KERNEL_EXTS = (".py", ".cu", ".cuh", ".hip", ".c", ".triton", ".cc")


def zoo_path(state_dir: Path) -> Path:
    """Absolute path of the node-level kernel zoo index."""
    return node_metainfer_dir(Path(state_dir)) / ZOO_FILE


def _match(entry: Dict[str, Any], task_type: Optional[str],
           operator: Optional[str], hardware: Optional[str],
           language: Optional[str]) -> bool:
    if task_type is not None and entry.get("task_type") != task_type:
        return False
    tags = entry.get("tags") or {}
    if operator and tags.get("operator") and tags.get("operator") != operator:
        return False
    if hardware and tags.get("hardware") and tags.get("hardware") != hardware:
        return False
    if language and tags.get("language") and tags.get("language") != language:
        return False
    return True


def read_zoo(state_dir: Path, task_type: Optional[str] = None,
             operator: Optional[str] = None, hardware: Optional[str] = None,
             language: Optional[str] = None,
             limit: int = PROMPT_BLOCK_LIMIT) -> List[Dict]:
    """Return matching zoo entries, best/most-recent first.

    Filters by ``task_type`` and any of operator/hardware/language that are
    provided (None ⇒ don't filter on that axis). Missing / unreadable zoo →
    ``[]`` (advisory, never raises). A non-standard ``state_dir`` layout (the
    ``node_metainfer_dir`` helper raises ``ValueError``) is treated as "no
    zoo", mirroring :func:`lessons.read_wiki_lessons`.
    """
    try:
        p = zoo_path(state_dir)
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
        if _match(rec, task_type, operator, hardware, language):
            out.append(rec)
    # Most recent first (the zoo is appended newest-last).
    out.reverse()
    if limit > 0:
        out = out[:limit]
    return out


def _truncate(src: str) -> str:
    if len(src) <= MAX_SRC_INLINE:
        return src
    keep = MAX_SRC_INLINE
    # Cut on a line boundary for readability.
    cut = src.rfind("\n", 0, keep)
    if cut > keep // 2:
        keep = cut
    return src[:keep] + "\n# ... (truncated; see the original task workspace)\n"


def _pick_kernel_file(iter_dir: Path) -> Optional[Path]:
    """Pick the kernel source file to inline from an iteration dir.

    Heuristic: the largest file with a known kernel extension. The
    implementer agent writes the kernel under a free filename, so "largest
    source file" is a robust proxy for the primary kernel (config / driver
    scripts are typically much smaller). Returns None if nothing matches.
    """
    candidates = []
    try:
        for entry in iter_dir.rglob("*"):
            if entry.is_file() and entry.suffix.lower() in _KERNEL_EXTS:
                # Skip vendored / build artefact trees.
                parts = {p.lower() for p in entry.parts}
                if {"__pycache__", ".git", "build", "dist"} & parts:
                    continue
                try:
                    size = entry.stat().st_size
                except OSError:
                    continue
                candidates.append((size, entry))
    except OSError:
        return None
    if not candidates:
        return None
    candidates.sort(key=lambda t: t[0], reverse=True)
    return candidates[0][1]


def _best_iteration(store, workspace) -> Optional[Dict[str, Any]]:
    """Find the iteration with the best primary metric among completed iters
    that have a usable perf dict. Returns ``{"iter": int, "perf": dict,
    "primary": (value, direction)}`` or None. Stateless / resume-safe (reads
    history from the store, like :func:`pipeline._count_iters_since_best`).
    """
    last = workspace.latest_complete_number()
    if not last:
        return None
    best: Optional[Dict[str, Any]] = None
    for i in range(1, last + 1):
        rec = store.load_iteration(i)
        if rec is None:
            continue
        perf = rec.get("perf") if isinstance(rec, dict) else getattr(rec, "perf", None)
        if not perf:
            continue
        m = metrics.primary_metric(perf)
        if m is None:
            continue
        val, direction = m
        if best is None or metrics.is_improvement(val, best["primary"][0], direction):
            best = {"iter": i, "perf": perf, "primary": (val, direction)}
    return best


def promote_best(state_dir: Path, workspace, store, task_id: str,
                 task_type: str, req: Dict[str, Any],
                 now: Optional[float] = None) -> Optional[Dict]:
    """Promote the best kernel of this finished task into the node zoo.

    Picks the best iteration (by primary metric), inlines its kernel source
    (capped), and appends a zoo entry under an exclusive lock. The zoo is then
    capped to :data:`MAX_ZOO_ENTRIES` (oldest dropped). Advisory: never
    raises — any failure returns None. Returns the appended entry, or None
    when there is no usable perf / no kernel file.

    ``req`` supplies the tags (operator / hardware / language / shapes); read
    via :mod:`metainfer.orchestrator.requirements.req_field` so both flat and
    legacy nested forms work (see CLAUDE.md §requirements.json 扁平化).
    """
    try:
        from metainfer.orchestrator.requirements import req_field
        best = _best_iteration(store, workspace)
        if best is None:
            return None
        iter_dir = workspace.iter_dir(best["iter"])
        kfile = _pick_kernel_file(iter_dir)
        if kfile is None:
            return None
        try:
            raw_src = kfile.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return None
        val, direction = best["primary"]
        entry = {
            "ts": float(now if now is not None else time.time()),
            "source_task_id": str(task_id),
            "task_type": str(task_type),
            "tags": {
                "operator": req_field(req, "operator", ""),
                "hardware": req_field(req, "target_hardware", ""),
                "language": req_field(req, "kernel_language", ""),
                "shapes": req_field(req, "input_shapes", ""),
            },
            "perf": best["perf"],
            "primary": {
                "metric": ("ms_per_op" if "ms_per_op" in best["perf"]
                           else ("tokens_per_sec" if "tokens_per_sec" in best["perf"]
                                 else ("speedup" if "speedup" in best["perf"] else "gflops"))),
                "value": val,
                "direction": direction,
            },
            "kernel_file": kfile.name,
            "kernel_src": _truncate(raw_src),
            "note": f"promoted from {task_id} iter {best['iter']}",
        }
        _append_capped(state_dir, entry)
        return entry
    except Exception:  # noqa: BLE001 — advisory: never block finish
        return None


def _append_capped(state_dir: Path, entry: Dict) -> None:
    """Append ``entry`` to the zoo under an exclusive lock, then cap to
    :data:`MAX_ZOO_ENTRIES` by dropping the oldest lines. The cap is a
    rewrite (the zoo is a *compacted* authority, not append-only) — this is
    the "search results get leaner" side of the self-evolving zoo."""
    wp = zoo_path(state_dir)
    wp.parent.mkdir(parents=True, exist_ok=True)
    lock_path = wp.parent / ZOO_LOCK
    import fcntl  # POSIX only; this project targets Linux DCU hosts
    with open(lock_path, "a") as lf:
        fcntl.flock(lf, fcntl.LOCK_EX)
        try:
            existing: List[str] = []
            if wp.is_file():
                try:
                    existing = wp.read_text(encoding="utf-8").splitlines()
                except OSError:
                    existing = []
            existing.append(json.dumps(entry, ensure_ascii=False))
            # Keep the newest MAX_ZOO_ENTRIES (drop oldest from the front).
            if len(existing) > MAX_ZOO_ENTRIES:
                existing = existing[-MAX_ZOO_ENTRIES:]
            tmp = wp.with_suffix(".jsonl.tmp")
            with open(tmp, "w", encoding="utf-8") as wf:
                for s in existing:
                    wf.write(s + "\n")
            tmp.replace(wp)
        finally:
            fcntl.flock(lf, fcntl.LOCK_UN)


def zoo_prompt_block(entries: List[Dict]) -> Optional[str]:
    """Render matching zoo entries as a planner-prompt section, or ``None``
    when empty (so the caller omits the section). Each entry shows its tags,
    the measured primary perf, and the inlined kernel source (already capped
    at write time) as a reusable scaffold / starting point — never a mandate.
    """
    if not entries:
        return None
    lines = [
        "# Kernel zoo — reusable kernels from prior tasks (scaffolds, not mandates)",
        "# Reuse a matching proven kernel as a STARTING POINT when it fits;",
        "# you still own correctness and must beat its perf. Each entry's",
        "# source is inlined below (truncated if large).",
        "",
    ]
    for idx, e in enumerate(entries, 1):
        tags = e.get("tags") or {}
        prim = e.get("primary") or {}
        src = (e.get("kernel_src") or "").rstrip()
        src_lang = ""
        fname = e.get("kernel_file", "kernel")
        if "." in fname:
            src_lang = fname.rsplit(".", 1)[-1]
        lines.append(
            f"## Zoo entry {idx}: {tags.get('operator','?')} / "
            f"{tags.get('hardware','?')} / {tags.get('language','?')} "
            f"(from {e.get('source_task_id','?')})"
        )
        shapes = tags.get("shapes")
        if shapes:
            lines.append(f"shapes: {shapes}")
        if prim:
            lines.append(
                f"primary: {prim.get('metric')}={prim.get('value')} "
                f"({prim.get('direction')} is better)"
            )
        lines.append(f"```{src_lang}")
        lines.append(src if src else "# (source unavailable)")
        lines.append("```")
        lines.append("")
    return "\n".join(lines)
