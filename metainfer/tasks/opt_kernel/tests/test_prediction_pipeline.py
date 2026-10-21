"""Pipeline-level tests for P2 falsifiable-prediction evaluation (AHE).

Covers the advisory contract from ``docs/opt_kernel_ahe.md`` §4:
- ``_evaluate_predictions`` writes ``change_evaluation.json``, sets
  ``ctx.prediction_verdict``, emits a ``prediction_evaluated`` timeline event.
- Missing ``predictions.json`` → no-op (no timeline event, ctx untouched).
- Unparseable ``predictions.json`` → ``prediction_eval_error`` timeline, ctx untouched.
- The perf baseline is the previous iteration's authoritative ``IterationRecord.perf``.
- ``plan_prompt`` / ``perf_plan_prompt`` inject the verdict section only when present.

These exercise the wired method + prompt builders directly (manager is a mock,
no agent / GPU is spawned), mirroring ``test_resume_last_perf.py``'s harness.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from metainfer.orchestrator.state import StateStore
from metainfer.tasks.opt_kernel.orchestrator.pipeline import (
    IterationContext,
    Orchestrator,
    OrchestratorConfig,
)
from metainfer.tasks.opt_kernel.orchestrator import phases as P
from metainfer.tasks.opt_kernel.orchestrator.iteration_record import IterationRecord
from metainfer.tasks.opt_kernel.orchestrator.prompts import plan_prompt, perf_plan_prompt


def _make_orchestrator(tmp_path: Path) -> Orchestrator:
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    cfg = OrchestratorConfig(
        workdir=state_dir, repo_root=tmp_path, notebooks_dir=tmp_path,
        iterations_root=tmp_path / "ws", state_dir=state_dir,
        logs_root=tmp_path / "logs",
    )
    return Orchestrator(req={}, store=StateStore(state_dir), cfg=cfg, manager=MagicMock())


def _seed_prev_perf(orch: Orchestrator, n: int, perf: dict) -> None:
    rec = IterationRecord(iteration=n, started_at=1.0, start_phase="A_plan")
    rec.outcome = P.OK
    rec.perf = perf
    orch.store.write_iteration(n, rec.to_dict())


def _timeline_events(orch: Orchestrator) -> list[dict]:
    path = orch.store.timeline_path
    if not path.exists():
        return []
    out = []
    for ln in path.read_text(encoding="utf-8").splitlines():
        if ln.strip():
            out.append(json.loads(ln))
    return out


# --------------------------------------------------------------------------- #
# _evaluate_predictions: happy path
# --------------------------------------------------------------------------- #

def test_evaluate_predictions_writes_file_sets_ctx_and_timeline(tmp_path: Path):
    orch = _make_orchestrator(tmp_path)
    _seed_prev_perf(orch, 1, {"tokens_per_sec": 1000.0, "ms_per_op": 1.0, "speedup": 1.2})
    iter_dir = orch.workspace.root / "002"
    iter_dir.mkdir(parents=True)
    (iter_dir / "predictions.json").write_text(json.dumps({
        "predictions": [
            {"id": "p1", "change": "tiling", "target_metric": "tokens_per_sec",
             "direction": "increase", "expected_delta_pct": 15.0,
             "at_risk_metrics": ["ms_per_op"]},
        ],
    }))
    ctx = IterationContext()

    orch._evaluate_predictions(2, iter_dir, {"tokens_per_sec": 1150.0, "ms_per_op": 1.0,
                                             "speedup": 1.2}, None, ctx)

    ev = (iter_dir / "change_evaluation.json")
    assert ev.is_file()
    result = json.loads(ev.read_text())
    assert result["predictions"][0]["verdict"] == "confirmed"
    assert result["baseline_perf"]["tokens_per_sec"] == 1000.0  # from prev iter record
    assert ctx.prediction_verdict is not None
    assert "p1 CONFIRMED" in ctx.prediction_verdict
    types = [e["type"] for e in _timeline_events(orch)]
    assert "prediction_evaluated" in types


def test_baseline_comes_from_previous_iteration_record_not_predictions_file(tmp_path: Path):
    """Authority: the comparison baseline is IterationRecord.perf (derived from
    perf_report.json), NOT the planner's self-reported baseline_perf in
    predictions.json."""
    orch = _make_orchestrator(tmp_path)
    _seed_prev_perf(orch, 1, {"tokens_per_sec": 1000.0})
    iter_dir = orch.workspace.root / "002"
    iter_dir.mkdir(parents=True)
    # planner lies about its baseline — must be ignored
    (iter_dir / "predictions.json").write_text(json.dumps({
        "baseline_perf": {"tokens_per_sec": 5.0},  # bogus
        "predictions": [
            {"id": "p1", "target_metric": "tokens_per_sec", "direction": "increase",
             "expected_delta_pct": 15.0, "at_risk_metrics": []},
        ],
    }))
    ctx = IterationContext()
    orch._evaluate_predictions(2, iter_dir, {"tokens_per_sec": 1150.0}, None, ctx)
    result = json.loads((iter_dir / "change_evaluation.json").read_text())
    # +15% vs the AUTHORITATIVE 1000 baseline → confirmed; the bogus 5 is ignored
    assert result["baseline_perf"]["tokens_per_sec"] == 1000.0
    assert result["predictions"][0]["verdict"] == "confirmed"


# --------------------------------------------------------------------------- #
# advisory / non-blocking
# --------------------------------------------------------------------------- #

def test_missing_predictions_json_is_noop(tmp_path: Path):
    orch = _make_orchestrator(tmp_path)
    iter_dir = orch.workspace.root / "002"
    iter_dir.mkdir(parents=True)
    ctx = IterationContext()
    before = ctx.prediction_verdict
    orch._evaluate_predictions(2, iter_dir, {"tokens_per_sec": 1100.0}, None, ctx)
    assert ctx.prediction_verdict == before  # untouched (None)
    assert not (iter_dir / "change_evaluation.json").exists()
    assert "prediction_evaluated" not in [e["type"] for e in _timeline_events(orch)]


def test_empty_predictions_list_is_noop(tmp_path: Path):
    orch = _make_orchestrator(tmp_path)
    iter_dir = orch.workspace.root / "002"
    iter_dir.mkdir(parents=True)
    (iter_dir / "predictions.json").write_text(json.dumps({"predictions": []}))
    ctx = IterationContext()
    orch._evaluate_predictions(2, iter_dir, {"tokens_per_sec": 1100.0}, None, ctx)
    assert ctx.prediction_verdict is None
    assert not (iter_dir / "change_evaluation.json").exists()


def test_unparseable_predictions_logs_error_and_continues(tmp_path: Path):
    orch = _make_orchestrator(tmp_path)
    iter_dir = orch.workspace.root / "002"
    iter_dir.mkdir(parents=True)
    (iter_dir / "predictions.json").write_text("{ not valid json")
    ctx = IterationContext()
    orch._evaluate_predictions(2, iter_dir, {"tokens_per_sec": 1100.0}, None, ctx)
    assert ctx.prediction_verdict is None
    types = [e["type"] for e in _timeline_events(orch)]
    assert "prediction_eval_error" in types
    assert "prediction_evaluated" not in types


def test_first_iteration_no_baseline_all_inconclusive(tmp_path: Path):
    orch = _make_orchestrator(tmp_path)
    iter_dir = orch.workspace.root / "001"
    iter_dir.mkdir(parents=True)
    (iter_dir / "predictions.json").write_text(json.dumps({
        "predictions": [
            {"id": "p1", "target_metric": "tokens_per_sec", "direction": "increase",
             "expected_delta_pct": 15.0, "at_risk_metrics": []},
        ],
    }))
    ctx = IterationContext()
    orch._evaluate_predictions(1, iter_dir, {"tokens_per_sec": 1100.0}, None, ctx)
    result = json.loads((iter_dir / "change_evaluation.json").read_text())
    assert result["predictions"][0]["verdict"] == "inconclusive"
    assert result["baseline_perf"] is None
    # verdict_text still emitted (inconclusive line) and set on ctx
    assert ctx.prediction_verdict is not None
    assert "INCONCLUSIVE" in ctx.prediction_verdict


# --------------------------------------------------------------------------- #
# prompt injection
# --------------------------------------------------------------------------- #

def test_plan_prompt_includes_verdict_section_when_present():
    p = plan_prompt(req={}, iter_dir=Path("/w"), notebooks_dir=Path("/n"), iteration=2,
                    prediction_verdict="p1 CONFIRMED (tokens_per_sec +15.0% expected vs +15.0% actual)")
    assert "# Previous change-evaluation verdict" in p
    assert "p1 CONFIRMED" in p
    # section sits before "Previous failures" so the planner sees bets first
    assert p.index("# Previous change-evaluation verdict") < p.index("# Previous failures")


def test_plan_prompt_omits_verdict_section_when_absent():
    p = plan_prompt(req={}, iter_dir=Path("/w"), notebooks_dir=Path("/n"), iteration=1)
    assert "# Previous change-evaluation verdict" not in p


def test_plan_prompt_asks_for_predictions_json():
    p = plan_prompt(req={}, iter_dir=Path("/w"), notebooks_dir=Path("/n"), iteration=1)
    assert "predictions.json" in p
    assert '"direction": "increase"' in p  # schema guidance


def test_perf_plan_prompt_includes_verdict_when_present():
    p = perf_plan_prompt(req={}, iter_dir=Path("/w"), notebooks_dir=Path("/n"),
                         iteration=2, last_perf={"tokens_per_sec": 1100.0},
                         prediction_verdict="p1 FALSIFIED (tokens_per_sec +15.0% expected vs -10.0% actual)")
    assert "# This iteration's change-evaluation verdict" in p
    assert "change_evaluation.json" in p  # perf planner told to read it
    assert "p1 FALSIFIED" in p


def test_perf_plan_prompt_omits_verdict_when_absent():
    p = perf_plan_prompt(req={}, iter_dir=Path("/w"), notebooks_dir=Path("/n"),
                         iteration=1, last_perf=None)
    assert "# This iteration's change-evaluation verdict" not in p
