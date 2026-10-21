"""Tests for the opt-kernel phase state machine — in particular that the
previously-dead ``PERF_REGRESSION`` outcome is now wired into ``E_perf_test``
and routes back to ``B_implement`` so the implementer can undo a regression.

These are pure state-machine tests: no agents, no GPU, no files. They lock
the transition-table contract that ``pipeline._do_perf_test`` relies on.
"""

from __future__ import annotations

from metainfer.tasks.opt_kernel.orchestrator import phases as P


# --------------------------------------------------------------------------- #
# Sanity: phase set
# --------------------------------------------------------------------------- #

def test_phase_set_includes_e_perf_test():
    ids = {m.id for m in P.PHASES}
    assert "E_perf_test" in ids
    assert "B_implement" in ids
    assert "F_perf_plan" in ids


def test_outcome_set_includes_perf_regression():
    assert P.PERF_REGRESSION in P.ALL_OUTCOMES


# --------------------------------------------------------------------------- #
# Forward path
# --------------------------------------------------------------------------- #

def test_linear_forward_path():
    path = ["A_plan", "B_implement", "C_test", "D_review", "E_perf_test", "F_perf_plan"]
    nxt = {
        ("A_plan", "B_implement"),
        ("B_implement", "C_test"),
        ("C_test", "D_review"),
        ("D_review", "E_perf_test"),
        ("E_perf_test", "F_perf_plan"),
        ("F_perf_plan", "A_plan"),
    }
    for i in range(len(path) - 1):
        t = P.next_transition(path[i], P.OK)
        assert t is not None, f"no transition from {path[i]} ok"
        assert (path[i], t.to_phase) in nxt, f"unexpected {path[i]} ok -> {t.to_phase}"


# --------------------------------------------------------------------------- #
# PERF_REGRESSION — the previously-dead signal
# --------------------------------------------------------------------------- #

def test_e_perf_test_perf_regression_routes_to_b_implement():
    """The core fix: E_perf_test + PERF_REGRESSION must now route somewhere
    (it used to be a dead outcome with no E-side transition, so the pipeline
    silently fell into the `no transition` error branch and restarted at
    A_plan). It should route back to B_implement to re-do the implementation.
    """
    t = P.next_transition("E_perf_test", P.PERF_REGRESSION)
    assert t is not None, "E_perf_test + PERF_REGRESSION has no transition (dead code)"
    assert t.to_phase == "B_implement"


def test_e_perf_test_perf_regression_carries_perf_and_failure():
    """A regression should carry the perf (so the next E compares against the
    regressed metric, not a stale best) and the failure (so the implementer
    sees *why* it is redoing, via prev_failure), and consume the iteration.
    """
    t = P.next_transition("E_perf_test", P.PERF_REGRESSION)
    assert t is not None
    assert t.carry_perf is True
    assert t.carry_failure is True
    assert t.consume_iteration is True


def test_c_test_perf_regression_still_routes():
    """The C_test PERF_REGRESSION transition already existed (it routes to
    D_review). Make sure it is still present — we only *added* the E one.
    """
    t = P.next_transition("C_test", P.PERF_REGRESSION)
    assert t is not None
    assert t.to_phase == "D_review"


def test_e_perf_test_ok_still_goes_to_f():
    """Adding the E PERF_REGRESSION transition must not break the E ok path."""
    t = P.next_transition("E_perf_test", P.OK)
    assert t is not None
    assert t.to_phase == "F_perf_plan"
    assert t.carry_perf is True


def test_no_dead_outcomes_for_e_perf_test():
    """Every outcome the pipeline can emit from E_perf_test must have a
    transition. The pipeline emits OK / INFRA_FAIL / LOGIC_FAIL / PERF_REGRESSION.
    """
    for outcome in (P.OK, P.INFRA_FAIL, P.LOGIC_FAIL, P.PERF_REGRESSION):
        t = P.next_transition("E_perf_test", outcome)
        assert t is not None, f"E_perf_test + {outcome} is dead (no transition)"


def test_e_perf_test_infra_fail_retries_in_place():
    t = P.next_transition("E_perf_test", P.INFRA_FAIL)
    assert t is not None
    assert t.to_phase == "E_perf_test"  # self-loop retry


# --------------------------------------------------------------------------- #
# graph payload still renders
# --------------------------------------------------------------------------- #

def test_graph_payload_includes_regression_edge():
    payload = P.graph_payload("E_perf_test", P.PERF_REGRESSION, "regress→redo impl")
    assert any(e["from"] == "E_perf_test" and e["to"] == "B_implement"
               for e in payload["edges"])
    # The legend must mention perf regression.
    assert any(o["id"] == P.PERF_REGRESSION for o in payload["outcome_legend"])
