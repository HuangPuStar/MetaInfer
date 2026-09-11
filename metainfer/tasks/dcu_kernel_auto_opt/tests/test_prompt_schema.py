"""Prompt-schema tests: worker prompt now carries optional decision fields."""

from __future__ import annotations

from pathlib import Path

from ..orchestrator.config import WorkerAssignment
from ..orchestrator.w8a8_pipeline import RealW8A8OptimizationPipeline


def _round_prompt(**overrides):
    args = dict(
        assignment=WorkerAssignment("worker_0", 0, ["m2"]),
        shape_id="m2",
        shape={"M": 2, "N": 16, "K": 32},
        best={"median_us": 10.0},
        root=Path("/tmp/worker"),
        iteration=1,
        guidance=None,
        history=[],
        pmc_evidence={},
    )
    args.update(overrides)
    return RealW8A8OptimizationPipeline._worker_prompt(**args)


def test_first_turn_prompt_mentions_decision_fields():
    prompt = _round_prompt()
    assert '"plan_id"' in prompt
    assert '"prediction"' in prompt
    assert '"expected_us_range"' in prompt
    assert '"direction": "improve"' in prompt
    assert "checks `prediction` against the measured round" in prompt


def test_continuation_prompt_mentions_optional_fields():
    prompt = _round_prompt(
        continuation=True,
        history=[{
            "iteration": 1,
            "accepted": True,
            "build_success": True,
            "correctness_passed": True,
            "metrics": {"median_us": 9.0},
        }],
    )
    assert "optional plan_id and prediction" in prompt
