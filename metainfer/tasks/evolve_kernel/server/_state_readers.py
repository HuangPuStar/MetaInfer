"""State-dir readers for the evolve-kernel task type .

Reads: iterations, charts, state-graph, kernel library, harnesses.
"""

from __future__ import annotations

import difflib
import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..orchestrator import phases as _phases


def _load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return default


def _read_run(state_dir: Path) -> Dict[str, Any]:
    return _load_json(state_dir / "run.json", {}) or {}


# --------------------------------------------------------------------------- #
# Iterations
# --------------------------------------------------------------------------- #


def read_iterations(state_dir: Path) -> List[Dict[str, Any]]:
    iters_dir = state_dir / "iterations"
    if not iters_dir.exists():
        return []
    out: List[Dict[str, Any]] = []
    for p in sorted(iters_dir.glob("*.json")):
        data = _load_json(p, None)
        if data is not None:
            out.append(data)
    return out


def read_iteration(state_dir: Path, n: int) -> Optional[Dict[str, Any]]:
    return _load_json(state_dir / "iterations" / f"{n:03d}.json", None)


# --------------------------------------------------------------------------- #
# Charts
# --------------------------------------------------------------------------- #


def read_charts(state_dir: Path) -> Dict[str, Any]:
    recs = read_iterations(state_dir)
    durations = [
        {"x": r.get("iteration", 0), "y": round(r.get("duration_s", 0) or 0, 1)}
        for r in recs if r.get("duration_s")
    ]
    # Collect all perf metrics
    perf_keys = ["exec_time_ms", "speedup", "combined_score"]
    perf_series = []
    for k in perf_keys:
        series = [
            {"x": r.get("iteration", 0), "y": (r.get("perf") or {}).get(k)}
            for r in recs if r.get("perf") and k in r["perf"]
        ]
        if series:
            perf_series.append({"metric": k, "points": series})

    return {
        "durations": durations,
        "perf_series": perf_series,
        "iteration_status": [
            {
                "iteration": r.get("iteration", 0),
                "status": r.get("status", "running"),
                "goal": r.get("goal") or "",
            }
            for r in recs
        ],
    }


# --------------------------------------------------------------------------- #
# Retrospective
# --------------------------------------------------------------------------- #


def read_retrospective(state_dir: Path, n: int) -> Dict[str, Any]:
    rec = read_iteration(state_dir, n)
    if rec is None:
        return {"has_retrospective": False, "markdown": "no such iteration",
                "path": None, "this_perf": {}, "prev_perf": {}, "iteration": n}
    prev = read_iteration(state_dir, n - 1) if n > 1 else None
    prev_perf = dict(prev.get("perf") or {}) if prev else {}
    this_perf = dict(rec.get("perf") or {})
    path_str = rec.get("retrospective_path")
    markdown = ""
    has = False
    if path_str:
        p = Path(path_str)
        if p.is_file():
            try:
                markdown = p.read_text(encoding="utf-8", errors="replace")
                has = True
            except OSError:
                markdown = ""
    if not has:
        markdown = (
            f"# Iteration {n} — no retrospective available\n\n"
            f"Status: {rec.get('status', 'unknown')}\n"
        )
    return {
        "has_retrospective": has,
        "path": path_str,
        "markdown": markdown,
        "this_perf": this_perf,
        "prev_perf": prev_perf,
        "iteration": n,
    }


# --------------------------------------------------------------------------- #
# State Graph
# --------------------------------------------------------------------------- #


def read_state_graph(state_dir: Path) -> Dict[str, Any]:
    run = _read_run(state_dir)
    current = run.get("current_phase", "idle")
    last_outcome = run.get("last_outcome")
    last_label = run.get("last_transition_label")
    if hasattr(_phases, "graph_payload"):
        return _phases.graph_payload(current, last_outcome, last_label)
    return {"error": "phases module does not export graph_payload()"}


# --------------------------------------------------------------------------- #
# Kernel Library
# --------------------------------------------------------------------------- #


def read_kernel_library(workspace_dir: Path) -> Dict[str, Any]:
    path = workspace_dir / "kernel_library.json"
    if not path.is_file():
        return {"kernels": [], "size": 0}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"kernels": [], "size": 0}
    if not isinstance(data, list):
        return {"kernels": [], "size": 0}

    # Enrich each kernel entry with a preview (first 20 lines)
    enriched = []
    for k in data:
        code = k.get("code", "")
        preview = "\n".join(code.splitlines()[:20]) if code else ""
        enriched.append({
            **k,
            "code_preview": preview,
            "code_lines": len(code.splitlines()) if code else 0,
        })
    return {"kernels": enriched, "size": len(enriched)}


# --------------------------------------------------------------------------- #
# Harnesses
# --------------------------------------------------------------------------- #


def read_harness(workspace_dir: Path, harness_type: str) -> Dict[str, Any]:
    """Read correctness or perf harness."""
    hdir = workspace_dir / "harnesses"
    fname = f"{harness_type}_harness.py"
    path = hdir / fname

    if not path.is_file():
        return {"exists": False, "code": "", "path": str(path)}

    try:
        code = path.read_text(encoding="utf-8")
    except OSError:
        return {"exists": False, "code": "", "path": str(path)}

    return {
        "exists": True,
        "code": code,
        "path": str(path),
        "lines": len(code.splitlines()),
    }


# --------------------------------------------------------------------------- #
# Reference Kernel
# --------------------------------------------------------------------------- #


def read_reference_kernel(workspace_dir: Path) -> Dict[str, Any]:
    path = workspace_dir / "reference" / "original_kernel.py"
    if not path.is_file():
        return {"exists": False, "code": "", "path": str(path)}

    try:
        code = path.read_text(encoding="utf-8")
    except OSError:
        return {"exists": False, "code": "", "path": str(path)}

    return {
        "exists": True,
        "code": code,
        "path": str(path),
        "lines": len(code.splitlines()),
    }


# --------------------------------------------------------------------------- #
# Kernel source & diff
# --------------------------------------------------------------------------- #

# Metadata carried alongside a single kernel's source (the fields the diff
# view needs to explain a change: how fast it was, which iteration added it,
# and which library kernel it was derived from).
_KERNEL_META_KEYS = (
    "exec_time_ms",
    "complexity_score",
    "combined_score",
    "iteration_added",
    "parent_id",
)


def read_kernel_source(workspace_dir: Path, kernel_id: str) -> Dict[str, Any]:
    """Return the full source + metadata for one library kernel, by id.

    ``read_kernel_library`` ships every kernel's code in one payload; this
    resolves a single kernel so callers that already know the id (the diff
    view) don't have to scan the list, and so the lookup has one definition.
    """
    for k in read_kernel_library(workspace_dir)["kernels"]:
        if str(k.get("id")) == str(kernel_id):
            code = k.get("code") or ""
            return {
                "exists": True,
                "id": k.get("id"),
                "code": code,
                "lines": len(code.splitlines()),
                "meta": {key: k.get(key) for key in _KERNEL_META_KEYS},
            }
    return {"exists": False, "id": kernel_id, "code": "", "lines": 0, "meta": {}}


def read_kernel_diff(workspace_dir: Path, kernel_id: str,
                     base: str = "reference") -> Dict[str, Any]:
    """Unified diff of a library kernel against a baseline.

    ``base`` is ``"reference"`` (the original kernel the task started from)
    or ``"parent"`` (the library kernel this one was derived from). Returns
    the diff text plus added/removed line counts; a missing kernel, a root
    kernel with no parent, or a parent that is no longer in the library
    (the library evicts past ``MAX_LIBRARY_SIZE``) yields ``exists: False``
    with an ``error`` reason rather than raising.
    """
    src = read_kernel_source(workspace_dir, kernel_id)
    if not src["exists"]:
        return _diff_missing(base, f"unknown kernel {kernel_id!r}")

    if base == "parent":
        parent_id = src["meta"].get("parent_id")
        if not parent_id:
            return _diff_missing(base, "kernel has no parent")
        base_src = read_kernel_source(workspace_dir, parent_id)
        if not base_src["exists"]:
            return _diff_missing(
                base, f"parent {str(parent_id)[:8]} is no longer in the library")
        base_code = base_src["code"]
        base_label = f"kernel {str(parent_id)[:8]}"
    else:
        ref = read_reference_kernel(workspace_dir)
        base_code = ref["code"] if ref["exists"] else ""
        base_label = "reference"

    diff_lines = list(difflib.unified_diff(
        base_code.splitlines(), (src["code"] or "").splitlines(),
        fromfile=f"a/{base_label}",
        tofile=f"b/kernel {str(kernel_id)[:8]}",
        lineterm="",
    ))
    added = sum(1 for ln in diff_lines
                if ln.startswith("+") and not ln.startswith("+++"))
    removed = sum(1 for ln in diff_lines
                  if ln.startswith("-") and not ln.startswith("---"))
    return {
        "exists": True,
        "base": base,
        "base_label": base_label,
        "diff": "\n".join(diff_lines),
        "added": added,
        "removed": removed,
    }


def _diff_missing(base: str, error: str) -> Dict[str, Any]:
    return {"exists": False, "base": base, "base_label": base,
            "diff": "", "added": 0, "removed": 0, "error": error}
