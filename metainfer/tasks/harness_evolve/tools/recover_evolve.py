"""Recover a crashed harness_evolve experiment.

When the outer loop dies after an iteration's evaluation (e.g. the evolve
turn timed out before the robustness fix), the value of that iteration is
already on disk: benchmark results, decision and best_ever. This tool runs
the MISSING evolve step for such an iteration, writes the evolve artifacts,
commits the workspace generation and finishes the report - i.e. it performs
the tail of ``pipeline.run_experiment`` without re-running any DKAO work.

Usage::

    PYTHONPATH=/root/zth_agent/MetaInfer python3 -m \
      metainfer.tasks.harness_evolve.tools.recover_evolve \
      <requirements.json> --state-dir DIR --workspace-dir DIR [--iteration N]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..orchestrator.attribution import save_json
from ..orchestrator.config import load_experiment_config
from ..orchestrator.evolve import DEFAULT_EVOLVE_MODEL, build_evolver
from ..orchestrator import pipeline as P
from ..orchestrator.round_plan import RoundPlan


def _load_json(path: Path) -> Optional[Dict[str, Any]]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _candidate_iteration(exp: Path, wanted: Optional[int]) -> Path:
    runs = exp / "runs"
    dirs = sorted(d for d in runs.glob("iteration_*") if d.is_dir())
    if wanted is not None:
        target = runs / f"iteration_{wanted:03d}"
        if not target.is_dir():
            raise SystemExit(f"iteration {wanted} not found under {runs}")
        return target
    for d in reversed(dirs):
        has_decision = (d / "input" / "decision.json").is_file()
        has_evolve = (d / "evolve" / "change_manifest.json").is_file()
        if has_decision and not has_evolve:
            return d
    raise SystemExit("no iteration with a completed evaluation and missing "
                     "evolve artifacts; nothing to recover")


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(prog="recover_evolve")
    ap.add_argument("requirements", type=Path)
    ap.add_argument("--state-dir", type=Path, required=True)
    ap.add_argument("--workspace-dir", type=Path, required=True)
    ap.add_argument("--iteration", type=int, default=None)
    args = ap.parse_args(argv)

    cfg = load_experiment_config(args.requirements, args.state_dir,
                                 args.workspace_dir)
    exp = cfg.exp_dir
    it_dir = _candidate_iteration(exp, args.iteration)
    iteration = int(it_dir.name.split("_")[-1])
    print(f"[recover] iteration {iteration} at {it_dir}")

    input_dir = it_dir / "input"
    results = ((_load_json(input_dir / "benchmark" / "results.json") or {})
               .get("results") or {})
    decision = _load_json(input_dir / "decision.json") or {}
    diff = _load_json(input_dir / "diff.json") or {}
    scored = _load_json(input_dir / "benchmark" / "scored_ids.json") or []
    selected = list(scored) or P._load_ids(exp / P.LAST_SCORED_FILE)

    pool = P._load_pool(cfg)
    pool_ids = pool.all_ids() if pool is not None else list(selected)

    evolver = build_evolver(
        str(cfg.answers.get("evolve_mode") or "dry-run"),
        model=str(cfg.answers.get("evolve_model")
                  or DEFAULT_EVOLVE_MODEL),
        timeout_seconds=float(cfg.answers.get("evolve_timeout_seconds")
                              or 3600),
    )
    P._record_state(cfg, P.EVOLVE, iteration, event="evolve_start_recover")

    live_workspace = exp / "workspace"
    evolve_out = evolver.apply(live_workspace, iteration, {
        "overview": str(input_dir / "analysis" / "overview.md"),
        "results": results,
        "diff": diff,
        "decision": decision,
        "selected": selected,
        "pool_ids": pool_ids,
    })

    evolve_dir = it_dir / "evolve"
    evolve_dir.mkdir(parents=True, exist_ok=True)
    revision = P._commit_workspace(live_workspace, iteration)
    evolve_out["manifest"]["workspace_revision"] = revision
    save_json(evolve_dir / "change_manifest.json", evolve_out["manifest"])
    (evolve_dir / "evolve_summary.md").write_text(
        evolve_out["summary"] + "\n", encoding="utf-8")
    if pool is not None:
        agent_plan = evolve_out.get("round_plan")
        if isinstance(agent_plan, dict):
            plan_obj = RoundPlan.from_dict(agent_plan)
            pool.assert_in_pool(plan_obj.selected)
        else:
            plan_obj = RoundPlan(
                iteration=iteration, strategy="balanced",
                rationale="recover: keep same scored set",
                selected=list(selected),
            )
        save_json(evolve_dir / "round_plan.json", plan_obj.to_dict())
    P._record_state(cfg, P.REPORT, event="experiment_report_recover")
    report = P._final_report(cfg)
    P._record_state(cfg, P.FINISHED, event="experiment_finished_recover")
    print(f"[recover] evolve manifest -> {evolve_dir / 'change_manifest.json'}")
    print(f"[recover] report -> {report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
