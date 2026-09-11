"""Tests for orchestrator.predictions (M1 slice 3: inner decision hook)."""

from __future__ import annotations

from ..orchestrator.predictions import check_prediction, parse_prediction, plan_tag


def test_no_structured_prediction_returns_none():
    assert check_prediction(
        {"hypothesis": "plain prose"},
        candidate_us=100.0,
        best_us=110.0,
        passed=True,
        p90_guard_passed=True,
    ) is None
    assert parse_prediction({"hypothesis": "x"}) is None


def test_infra_failure_is_na():
    out = check_prediction(
        {"prediction": {"direction": "improve"}},
        candidate_us=float("inf"),
        best_us=100.0,
        passed=False,
        p90_guard_passed=False,
        failure_reason="timed out after 900s",
    )
    assert out is not None and out["checked"] == "na"


def test_range_hit_and_miss():
    proposal = {"prediction": {"expected_us_range": [90.0, 105.0]}}
    hit = check_prediction(
        proposal,
        candidate_us=98.0,
        best_us=110.0,
        passed=True,
        p90_guard_passed=True,
    )
    assert hit["checked"] == "hit"
    miss = check_prediction(
        proposal,
        candidate_us=120.0,
        best_us=110.0,
        passed=True,
        p90_guard_passed=True,
    )
    assert miss["checked"] == "miss"
    assert "outside declared range" in miss["reason"]


def test_direction_improve_requires_band():
    ok = check_prediction(
        {"prediction": {"direction": "improve"}},
        candidate_us=100.0,
        best_us=110.0,  # ~9% better
        passed=True,
        p90_guard_passed=True,
    )
    assert ok["checked"] == "hit"
    flat = check_prediction(
        {"prediction": {"direction": "flat"}},
        candidate_us=109.0,  # ~0.9% delta -> inside flat band
        best_us=110.0,
        passed=True,
        p90_guard_passed=True,
    )
    assert flat["checked"] == "hit"
    wrong = check_prediction(
        {"prediction": {"direction": "improve"}},
        candidate_us=109.0,  # only ~0.9% better -> below the 2% band
        best_us=110.0,
        passed=True,
        p90_guard_passed=True,
    )
    assert wrong["checked"] == "miss"


def test_correctness_failure_means_miss():
    out = check_prediction(
        {"prediction": {"expected_us_range": [90.0, 105.0]}},
        candidate_us=98.0,
        best_us=110.0,
        passed=False,
        p90_guard_passed=False,
    )
    assert out["checked"] == "miss"
    assert "correctness failed" in out["reason"]


def test_plan_tag_helpers():
    assert plan_tag({"hypothesis": "x"}) is None
    assert plan_tag({"plan_id": "occupancy_resource"}) == "occupancy_resource"
    assert plan_tag({"plan_id": "  "}) is None
