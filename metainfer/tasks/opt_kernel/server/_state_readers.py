"""State-dir readers for the opt-kernel task type.

Same iteration record schema as gen-infer-framework (ABCDEF cycle,
perf dict, retrospective_path).
"""

from __future__ import annotations

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


def read_charts(state_dir: Path) -> Dict[str, Any]:
    recs = read_iterations(state_dir)
    durations = [
        {"x": r.get("iteration", 0), "y": round(r.get("duration_s", 0) or 0, 1)}
        for r in recs if r.get("duration_s")
    ]
    perf_keys: List[str] = []
    for r in recs:
        for k in (r.get("perf") or {}):
            if k not in perf_keys:
                perf_keys.append(k)
    perf_series = []
    for k in perf_keys:
        series = [
            {"x": r.get("iteration", 0), "y": (r.get("perf") or {}).get(k)}
            for r in recs if r.get("perf") and k in r["perf"]
        ]
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


def read_ahe(state_dir: Path,
              workspace_dir: Optional[Path] = None) -> Dict[str, Any]:
    """Read the AHE (Agentic Harness Engineering) artifacts for a task.

    AHE adds two advisory loops on top of the opt-kernel ABCDEF pipeline
    (see ``docs/opt_kernel_ahe.md``):

    * **Falsifiable predictions (P2)** — the planner writes a structured
      ``predictions.json`` per iteration; after the E perf step the
      orchestrator compares predicted vs actual and writes
      ``change_evaluation.json`` with a confirmed/falsified/inconclusive
      verdict per prediction.
    * **Agent debugger (P1)** — after each iteration close, a debugger
      agent folds the full trajectory into ``analysis/detail/iter_NNN.md``
      and a cross-iteration ``analysis/overview.md`` (rewritten each run).

    All of these are **derived historical snapshots** — perf numbers and
    the formal regression verdict live in ``perf_report.json`` (the
    oracle, SSOT). This reader is read-only and never writes back.

    Returns a single payload so the WebUI panel can render with one fetch:
    ``overview_md`` (cross-iteration debugger summary), ``detail_iters``
    (iteration numbers that have a detail markdown, lazy-loaded via
    :func:`read_ahe_detail`), and ``iterations`` (per-iteration prediction
    vs actual + verdicts, sourced primarily from ``change_evaluation.json``
    with ``predictions.json`` as a fallback for in-progress iterations
    that have not yet been evaluated).
    """
    ws = workspace_dir
    if ws is None:
        ws = state_dir.parent.parent.parent / "workspaces" / state_dir.name
    analysis_dir = ws / "analysis"
    overview_md: Optional[str] = None
    detail_iters: List[int] = []
    if analysis_dir.is_dir():
        ov = analysis_dir / "overview.md"
        if ov.is_file():
            try:
                overview_md = ov.read_text(encoding="utf-8", errors="replace")
            except OSError:
                overview_md = None
        detail_dir = analysis_dir / "detail"
        if detail_dir.is_dir():
            for p in detail_dir.glob("iter_*.md"):
                try:
                    detail_iters.append(int(p.stem.split("_")[1]))
                except (ValueError, IndexError):
                    continue
            detail_iters.sort()

    iterations: List[Dict[str, Any]] = []
    for d in sorted(ws.glob("[0-9][0-9][0-9]"), key=lambda p: int(p.name)):
        try:
            n = int(d.name)
        except ValueError:
            continue
        ce = _load_json(d / "change_evaluation.json", None)
        preds_file = _load_json(d / "predictions.json", None)
        if not isinstance(ce, dict) and not isinstance(preds_file, dict):
            continue
        entry: Dict[str, Any] = {
            "iteration": n,
            "has_evaluation": isinstance(ce, dict),
            "has_predictions": isinstance(preds_file, dict),
            "verdicts": [],
            "baseline_perf": None,
            "actual_perf": None,
            "regression": None,
            "summary": None,
            "verdict_text": None,
        }
        if isinstance(ce, dict):
            entry["verdicts"] = ce.get("predictions", []) or []
            entry["baseline_perf"] = ce.get("baseline_perf")
            entry["actual_perf"] = ce.get("actual_perf")
            entry["regression"] = ce.get("regression")
            entry["summary"] = ce.get("summary")
            entry["verdict_text"] = ce.get("verdict_text")
        elif isinstance(preds_file, dict):
            # in-progress iteration: predictions written but not yet
            # evaluated — show the planner's intent without verdicts.
            entry["verdicts"] = [
                {k: v for k, v in p.items()
                 if k in ("id", "change", "target_metric", "direction",
                          "expected_delta_pct", "reason", "at_risk_metrics")}
                for p in (preds_file.get("predictions", []) or [])
            ]
            entry["baseline_perf"] = preds_file.get("baseline_perf")
        iterations.append(entry)

    return {
        "available": overview_md is not None or bool(iterations)
                     or bool(detail_iters),
        "overview_md": overview_md,
        "detail_iters": detail_iters,
        "iterations": iterations,
    }


def read_ahe_detail(state_dir: Path, n: int,
                     workspace_dir: Optional[Path] = None) -> Dict[str, Any]:
    """Read one iteration's agent-debugger detail markdown.

    The detail file lives at ``<workspace>/analysis/detail/iter_NNN.md``.
    Returns ``{has_detail, markdown, iteration}``; ``has_detail`` is False
    when the file is absent (e.g. debugger disabled or not yet run).
    """
    ws = workspace_dir
    if ws is None:
        ws = state_dir.parent.parent.parent / "workspaces" / state_dir.name
    path = ws / "analysis" / "detail" / f"iter_{n:03d}.md"
    markdown = ""
    has = False
    if path.is_file():
        try:
            markdown = path.read_text(encoding="utf-8", errors="replace")
            has = True
        except OSError:
            markdown = ""
    return {"iteration": n, "has_detail": has, "markdown": markdown}


def read_state_graph(state_dir: Path) -> Dict[str, Any]:
    run = _read_run(state_dir)
    current = run.get("current_phase", "idle")
    last_outcome = run.get("last_outcome")
    last_label = run.get("last_transition_label")
    if hasattr(_phases, "graph_payload"):
        return _phases.graph_payload(current, last_outcome, last_label)
    return {"error": "phases module does not export graph_payload()"}


def _iter_dir_for(state_dir: Path, n: int,
                  workspace_dir: Optional[Path] = None) -> Path:
    """Return the iteration workspace directory.

    Iteration artifacts that live in the workspace (perf_report.json,
    profile/) are at ``<workspace_dir>/<NNN>/`` where ``<NNN>`` is the
    zero-padded iteration number produced by ``IterationWorkspace._pad``
    (e.g. ``001``).

    The workspace_dir is the SSOT path held in ``registry.json`` (passed
    in by routes via ``workspace_dir_for(entry)``). ``run.json`` does NOT
    carry ``workspace_dir`` — the old code read it from run.json, always
    got None, and fell back to ``state_dir.parent / "workspace" / "iter-NNN"``
    which matched neither the directory name (``001`` vs ``iter-001``) nor
    the location → every read returned empty.

    As a defensive fallback (when no workspace_dir is supplied) derive it
    from the documented node layout: ``nodes/<node>/workspaces/<tid>`` is
    a sibling of ``nodes/<node>/.metainfer/tasks/<tid>``.
    """
    ws = workspace_dir
    if ws is None:
        # state_dir = nodes/<node>/.metainfer/tasks/<tid>
        # workspace = nodes/<node>/workspaces/<tid>
        ws = state_dir.parent.parent.parent / "workspaces" / state_dir.name
    return ws / f"{n:03d}"


def _logs_dir_for(state_dir: Path, n: int) -> Path:
    """Return the logs directory for iteration n.

    review-A.md / review-B.md / review.md / correctness_report.json are
    written by the orchestrator's D_review and C_test phases into
    ``<state_dir>/logs/<NNN>/`` (NOT the workspace). The old code assumed
    ``workspace/iter-NNN/logs`` which never matched the real layout →
    WebUI always got empty reviews. Dir name is zero-padded ``<NNN>``.
    """
    return state_dir / "logs" / f"{n:03d}"


def read_reviews(state_dir: Path, n: int) -> Dict[str, Any]:
    """Read the dual-reviewer output + correctness oracle result for iter n.

    review-A.md / review-B.md / review.md and correctness_report.json all
    live in the iteration's logs directory under the state_dir.
    """
    logs_dir = _logs_dir_for(state_dir, n)
    result: Dict[str, Any] = {
        "iteration": n,
        "has_reviews": False,
        "review_a": None,
        "review_b": None,
        "review_merged": None,
        "correctness": None,
    }
    found = False
    for label, fname in (("review_a", "review-A.md"),
                         ("review_b", "review-B.md"),
                         ("review_merged", "review.md")):
        path = logs_dir / fname
        if path.is_file():
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
                result[label] = text
                found = True
            except OSError:
                pass
    # Correctness oracle report (C_test phase) — same logs dir.
    cr_path = logs_dir / "correctness_report.json"
    if cr_path.is_file():
        crep = _load_json(cr_path, None)
        if isinstance(crep, dict):
            result["correctness"] = {
                k: crep.get(k) for k in
                ("all_correct", "n_pass", "n_fail", "failures", "shapes")
                if k in crep
            }
    result["has_reviews"] = found
    return result


def read_profile(state_dir: Path, n: int,
                  workspace_dir: Optional[Path] = None) -> Dict[str, Any]:
    """Read the perf profile data for iteration n.

    Returns the structured perf_report.json (including profile_artifacts
    from rocprof) and parses the kernel stats CSV if available.
    """
    iter_dir = _iter_dir_for(state_dir, n, workspace_dir)
    result: Dict[str, Any] = {
        "iteration": n,
        "has_profile": False,
        "perf_report": None,
        "kernel_stats": None,
        "counters": None,
        "hip_trace_path": None,
        "artifacts": [],
    }

    # Read perf_report.json
    perf_path = iter_dir / "perf_report.json"
    if perf_path.is_file():
        report = _load_json(perf_path, None)
        if report and isinstance(report, dict):
            result["perf_report"] = report
            result["has_profile"] = True
            result["artifacts"] = report.get("profile_artifacts", [])
            # Extract kernel stats from the report if present
            for art in result["artifacts"]:
                if not isinstance(art, dict):
                    continue
                kind = art.get("kind", "")
                if kind == "kernel_stats" and art.get("collected"):
                    result["kernel_stats"] = art.get("kernels")
                elif kind == "counters" and art.get("collected"):
                    result["counters"] = art.get("metrics")
                elif kind == "hip_trace" and art.get("collected"):
                    result["hip_trace_path"] = art.get("path")

    # Also try reading the raw stats CSV directly (in case the report
    # didn't capture it but the file exists)
    if result["kernel_stats"] is None:
        profile_dir = iter_dir / "profile"
        for csv_name in ["results.stats.csv", "results.csv"]:
            csv_path = profile_dir / csv_name
            if csv_path.is_file():
                kernels = _parse_stats_csv(csv_path)
                if kernels:
                    result["kernel_stats"] = kernels
                    break

    return result


def _parse_stats_csv(path: Path) -> List[Dict[str, Any]]:
    """Parse a rocprof stats CSV into a list of per-kernel stat dicts."""
    import csv as _csv
    kernels: List[Dict[str, Any]] = []
    try:
        with open(path, encoding="utf-8", errors="replace", newline="") as f:
            reader = _csv.DictReader(f)
            for row in reader:
                entry: Dict[str, Any] = {}
                for key, val in row.items():
                    k = (key or "").strip()
                    v = (val or "").strip()
                    if not k:
                        continue
                    kl = k.lower()
                    if "name" in kl:
                        entry["kernel"] = v
                    elif "call" in kl:
                        try:
                            entry["calls"] = int(float(v))
                        except ValueError:
                            entry["calls"] = v
                    elif "total" in kl and "duration" in kl:
                        try:
                            entry["total_ns"] = float(v.rstrip("%"))
                        except ValueError:
                            entry["total_ns"] = v
                    elif "average" in kl or "avg" in kl:
                        try:
                            entry["avg_ns"] = float(v.rstrip("%"))
                        except ValueError:
                            entry["avg_ns"] = v
                    elif "percentage" in kl or "percent" in kl:
                        try:
                            entry["percentage"] = float(v.rstrip("%"))
                        except ValueError:
                            entry["percentage"] = v
                    else:
                        entry[k] = v
                if entry:
                    kernels.append(entry)
    except Exception:
        pass
    return kernels
