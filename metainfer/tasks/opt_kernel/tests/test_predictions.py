"""Tests for the falsifiable-prediction evaluator (P2, AHE decision observability).

``evaluate_predictions`` is a pure function (no I/O, no pipeline) that compares
the planner's structured ``predictions.json`` claims against the actual perf
delta vs the previous iteration's authoritative baseline. Verdicts:
``confirmed`` / ``falsified`` / ``inconclusive``. See ``docs/opt_kernel_ahe.md``
§4.6 and ``predictions.py`` for the contract.
"""

from __future__ import annotations

import pytest

from metainfer.tasks.opt_kernel.orchestrator.predictions import evaluate_predictions


# Baselines / actuals reused across cases.
BASE = {"tokens_per_sec": 1000.0, "ms_per_op": 1.0, "speedup": 1.2, "gflops": 500.0}


def _pred(target="tokens_per_sec", direction="increase", expected=15.0,
          at_risk=None, pid="p1", change="x"):
    return {
        "id": pid, "change": change, "target_metric": target,
        "direction": direction, "expected_delta_pct": expected,
        "at_risk_metrics": at_risk or [],
    }


# --------------------------------------------------------------------------- #
# confirmed / falsified / inconclusive — increase-good metric
# --------------------------------------------------------------------------- #

def test_confirmed_when_actual_meets_half_of_expected():
    # expected +15%, actual +15% → confirmed (>= 50% of expected)
    actual = {**BASE, "tokens_per_sec": 1150.0}
    out = evaluate_predictions([_pred(expected=15.0)], BASE, actual, iteration=3)
    assert out["predictions"][0]["verdict"] == "confirmed"
    assert out["predictions"][0]["actual_delta_pct"] == pytest.approx(15.0)
    assert out["summary"].startswith("1/1 confirmed")
    assert "p1 CONFIRMED" in out["verdict_text"]


def test_confirmed_at_half_expected_boundary():
    # expected +20%, actual +10% → exactly 50% → confirmed
    actual = {**BASE, "tokens_per_sec": 1100.0}
    out = evaluate_predictions([_pred(expected=20.0)], BASE, actual)
    assert out["predictions"][0]["verdict"] == "confirmed"


def test_falsified_when_actual_moves_opposite():
    # predicted increase +15%, actual dropped 12% → falsified (opposite direction)
    actual = {**BASE, "tokens_per_sec": 880.0}
    out = evaluate_predictions([_pred(expected=15.0)], BASE, actual)
    assert out["predictions"][0]["verdict"] == "falsified"


def test_falsified_when_under_shoots_below_half_expected():
    # expected +30%, actual +5% (only ~17% of expected) → falsified (under-claim)
    actual = {**BASE, "tokens_per_sec": 1050.0}
    out = evaluate_predictions([_pred(expected=30.0)], BASE, actual)
    assert out["predictions"][0]["verdict"] == "falsified"


# --------------------------------------------------------------------------- #
# decrease-good metric (ms_per_op)
# --------------------------------------------------------------------------- #

def test_confirmed_for_decrease_metric():
    # expected ms_per_op -20% (decrease), actual -20% → confirmed
    actual = {**BASE, "ms_per_op": 0.8}
    out = evaluate_predictions([_pred(target="ms_per_op", direction="decrease", expected=20.0)],
                                BASE, actual)
    assert out["predictions"][0]["verdict"] == "confirmed"
    # actual_delta_pct is the raw signed change (-20%), not the predicted-move reframe
    assert out["predictions"][0]["actual_delta_pct"] == pytest.approx(-20.0)


def test_falsified_for_decrease_metric_when_it_increased():
    # predicted ms_per_op decrease, but it rose 10% → falsified
    actual = {**BASE, "ms_per_op": 1.1}
    out = evaluate_predictions([_pred(target="ms_per_op", direction="decrease", expected=20.0)],
                                BASE, actual)
    assert out["predictions"][0]["verdict"] == "falsified"


# --------------------------------------------------------------------------- #
# inconclusive
# --------------------------------------------------------------------------- #

def test_inconclusive_when_no_baseline():
    out = evaluate_predictions([_pred(expected=15.0)], None, {"tokens_per_sec": 1100.0})
    assert out["predictions"][0]["verdict"] == "inconclusive"
    assert out["baseline_perf"] is None


def test_inconclusive_when_target_metric_missing_in_actual():
    actual = {"ms_per_op": 0.9}  # no tokens_per_sec
    out = evaluate_predictions([_pred(target="tokens_per_sec", expected=15.0)], BASE, actual)
    assert out["predictions"][0]["verdict"] == "inconclusive"
    assert out["predictions"][0]["actual_delta_pct"] is None


def test_inconclusive_when_expected_missing():
    actual = {**BASE, "tokens_per_sec": 1100.0}
    out = evaluate_predictions([_pred(expected=None)], BASE, actual)
    assert out["predictions"][0]["verdict"] == "inconclusive"


def test_inconclusive_when_expected_zero_or_negative():
    actual = {**BASE, "tokens_per_sec": 1100.0}
    out = evaluate_predictions([_pred(expected=0.0)], BASE, actual)
    assert out["predictions"][0]["verdict"] == "inconclusive"


# --------------------------------------------------------------------------- #
# at-risk metrics
# --------------------------------------------------------------------------- #

def test_at_risk_regression_flags_worsened_metric():
    # predicted tokens_per_sec +15%; at-risk ms_per_op rose 12% (> 5% threshold) → regressed
    actual = {**BASE, "tokens_per_sec": 1150.0, "ms_per_op": 1.12}
    out = evaluate_predictions(
        [_pred(expected=15.0, at_risk=["ms_per_op", "correctness"])], BASE, actual)
    p = out["predictions"][0]
    assert p["verdict"] == "confirmed"
    assert p["at_risk_regression"] is True
    # correctness is non-numeric → not evaluable from perf, never counts as perf regression
    assert p["at_risk_actual"]["correctness"]["evaluable"] is False
    assert p["at_risk_actual"]["ms_per_op"]["regressed"] is True


def test_at_risk_no_regression_when_within_threshold():
    # at-risk gflops dropped 3% (< 5% threshold) → not regressed
    actual = {**BASE, "tokens_per_sec": 1150.0, "gflops": 485.0}
    out = evaluate_predictions([_pred(expected=15.0, at_risk=["gflops"])], BASE, actual)
    assert out["predictions"][0]["at_risk_regression"] is False
    assert out["predictions"][0]["at_risk_actual"]["gflops"]["regressed"] is False


def test_at_risk_regression_for_increase_good_metric_dropping():
    # at-risk speedup dropped 8% (> 5%) → regressed
    actual = {**BASE, "tokens_per_sec": 1150.0, "speedup": 1.10}
    out = evaluate_predictions([_pred(expected=15.0, at_risk=["speedup"])], BASE, actual)
    assert out["predictions"][0]["at_risk_regression"] is True


def test_at_risk_metric_absent_in_actual_is_not_regressed():
    # gflops present in baseline but absent in actual → not evaluable, not regressed
    actual = {"tokens_per_sec": 1150.0, "ms_per_op": 1.0, "speedup": 1.2}
    out = evaluate_predictions([_pred(expected=15.0, at_risk=["gflops"])], BASE, actual)
    assert out["predictions"][0]["at_risk_regression"] is False
    assert out["predictions"][0]["at_risk_actual"]["gflops"]["evaluable"] is False


# --------------------------------------------------------------------------- #
# aggregation / summary / verdict_text / shape
# --------------------------------------------------------------------------- #

def test_summary_counts_mixed_verdicts():
    preds = [
        _pred(pid="p1", target="tokens_per_sec", expected=15.0),    # +15% >= 7.5 confirmed
        _pred(pid="p2", target="tokens_per_sec", expected=50.0),     # +15% < 25 falsified
        _pred(pid="p3", target="bandwidth_gb_s", expected=10.0),     # not in baseline→inconclusive
    ]
    actual = {**BASE, "tokens_per_sec": 1150.0}  # tokens_per_sec present, bandwidth absent
    out = evaluate_predictions(preds, BASE, actual)
    assert out["summary"] == "1/3 confirmed, 1 falsified, 1 inconclusive, 0 at-risk regressions"
    assert "p1 CONFIRMED" in out["verdict_text"]
    assert "p2 FALSIFIED" in out["verdict_text"]
    assert "p3 INCONCLUSIVE" in out["verdict_text"]


def test_regression_echoed_through_not_used_for_verdict():
    # The oracle's formal regression dict is echoed for context but does NOT
    # drive per-prediction verdicts (verdict comes from actual vs expected).
    reg = {"regressed": True, "drop": 0.25, "threshold": 0.20}
    actual = {**BASE, "tokens_per_sec": 1300.0}  # +30% → confirmed regardless of reg
    out = evaluate_predictions([_pred(expected=15.0)], BASE, actual, regression=reg, iteration=4)
    assert out["predictions"][0]["verdict"] == "confirmed"
    assert out["regression"] == reg
    assert out["iteration"] == 4


def test_empty_predictions_returns_empty_result():
    out = evaluate_predictions([], BASE, {**BASE, "tokens_per_sec": 1100.0})
    assert out["predictions"] == []
    assert out["summary"] == "0/0 confirmed, 0 falsified, 0 inconclusive, 0 at-risk regressions"
    assert out["verdict_text"] is None


def test_no_actual_perf_all_inconclusive():
    out = evaluate_predictions([_pred(expected=15.0)], BASE, None)
    assert out["predictions"][0]["verdict"] == "inconclusive"
    assert out["actual_perf"] is None


def test_never_raises_on_garbage_prediction():
    # Robustness: malformed prediction entries degrade to inconclusive, no crash.
    out = evaluate_predictions(
        [{"id": "bad"}],  # no target/expected
        BASE, {**BASE, "tokens_per_sec": 1100.0})
    assert out["predictions"][0]["verdict"] == "inconclusive"
    assert out["predictions"][0]["id"] == "bad"


def test_auto_id_when_missing():
    out = evaluate_predictions(
        [{"target_metric": "tokens_per_sec", "direction": "increase", "expected_delta_pct": 15.0}],
        BASE, {**BASE, "tokens_per_sec": 1150.0})
    assert out["predictions"][0]["id"] == "p1"
    assert out["predictions"][0]["verdict"] == "confirmed"
