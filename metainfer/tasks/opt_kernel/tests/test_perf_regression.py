"""Tests for the perf-regression classification that ``pipeline._do_perf_test``
uses to decide between emitting OK and PERF_REGRESSION.

We test the pure helper ``_regression_failure`` directly — it is the single
piece of logic that translates the perf oracle's ``report.regression`` dict
(the single source of truth, computed in ``oracles/perf.py``) into either
``None`` (no regression → OK) or a failure string (→ PERF_REGRESSION). This
keeps the test free of GPU / agent / file machinery while still covering the
branch that was previously dead (the oracle computed ``regression`` but the
pipeline never read it).
"""

from __future__ import annotations

import pytest

from metainfer.tasks.opt_kernel.orchestrator.pipeline import _regression_failure
from metainfer.tasks.opt_kernel.orchestrator import phases as P


# --------------------------------------------------------------------------- #
# No regression → None (caller emits OK)
# --------------------------------------------------------------------------- #

def test_none_when_regression_dict_is_none():
    assert _regression_failure(None) is None


def test_none_when_not_regressed():
    reg = {"regressed": False, "note": "no previous baseline"}
    assert _regression_failure(reg) is None


def test_none_when_regressed_key_missing():
    reg = {"drop": 0.3, "threshold": 0.2}
    assert _regression_failure(reg) is None


# --------------------------------------------------------------------------- #
# Regression via speedup drop → failure string
# --------------------------------------------------------------------------- #

def test_failure_on_speedup_drop():
    reg = {
        "vs_prev_speedup": 0.70,
        "drop": 0.30,
        "threshold": 0.20,
        "regressed": True,
    }
    msg = _regression_failure(reg)
    assert msg is not None
    assert "speedup dropped 30.0%" in msg
    assert "threshold 20%" in msg


# --------------------------------------------------------------------------- #
# Regression via ms_per_op increase → failure string
# (the oracle's fallback path when speedup is unmeasurable)
# --------------------------------------------------------------------------- #

def test_failure_on_ms_per_op_increase():
    reg = {
        "vs_prev_ms": 1.25,
        "increase": 0.25,
        "threshold": 0.20,
        "regressed": True,
    }
    msg = _regression_failure(reg)
    assert msg is not None
    assert "ms_per_op increased 25.0%" in msg
    assert "threshold 20%" in msg


# --------------------------------------------------------------------------- #
# Threshold comes from the oracle dict (SSOT), not a pipeline constant
# --------------------------------------------------------------------------- #

def test_threshold_read_from_oracle_dict():
    reg = {"drop": 0.5, "threshold": 0.10, "regressed": True}
    msg = _regression_failure(reg)
    assert msg is not None
    assert "threshold 10%" in msg


def test_threshold_falls_back_when_absent():
    reg = {"drop": 0.5, "regressed": True}
    msg = _regression_failure(reg)
    assert msg is not None
    # Fallback 20% (the oracle's actual default) — not a pipeline constant.
    assert "threshold 20%" in msg


# --------------------------------------------------------------------------- #
# regressed=True but no drop/increase field → still flagged (defensive)
# --------------------------------------------------------------------------- #

def test_failure_when_regressed_but_metric_missing():
    reg = {"regressed": True}
    msg = _regression_failure(reg)
    assert msg is not None
    assert "primary metric regressed" in msg


# --------------------------------------------------------------------------- #
# Integration with the phase table: a regression failure string feeds the
# PERF_REGRESSION outcome, which the table routes to B_implement.
# --------------------------------------------------------------------------- #

def test_regression_failure_routes_via_phase_table():
    """The contract _do_perf_test relies on: a non-None failure string means
    emit PERF_REGRESSION, and PERF_REGRESSION from E_perf_test has a
    transition (no longer dead code)."""
    reg = {"drop": 0.30, "threshold": 0.20, "regressed": True}
    failure = _regression_failure(reg)
    assert failure is not None
    t = P.next_transition("E_perf_test", P.PERF_REGRESSION)
    assert t is not None and t.to_phase == "B_implement"
