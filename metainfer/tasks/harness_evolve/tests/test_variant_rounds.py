"""Variant-driven rounds: random operators, a fixed generalization paper, and
the two counter rules (>=75% / >=50% wins with an 80%-of-variant floor)."""

from __future__ import annotations

import json
import random
from pathlib import Path

import pytest

from ..orchestrator.decision_engine import gate_verdict
from ..orchestrator.rounds import (
    evaluate_gate, record_paper, regime_of, select_round_questions,
    sample_operators,
)
from ..orchestrator.variant import (
    load_variant_table, record_variants, reference_results, resolve_variant,
)


def _pool(n: int = 12) -> dict:
    """Alternating decode (M=16) / prefill (M=4096) operators with variants."""
    out = {}
    for i in range(n):
        m = 16 if i % 2 == 0 else 4096
        regime = "decode" if m == 16 else "prefill"
        out[f"op{i:02d}"] = {
            "baseline_us": 100.0 * (i + 1),
            "best_known_us": 40.0 * (i + 1),      # an existing variant
            "family": f"{regime}__fam{i}",
            "contract": {"M": m, "N": 64, "K": 32},
        }
    return out


def _table() -> dict:
    return {"operators": {}, "groups": {}, "harness_version": None}


# ------------------------------------------------------------------ selection

def test_first_round_defines_the_generalization_paper():
    pool, table = _pool(), _table()
    picked = select_round_questions(iteration=1, table=table, instances=pool,
                                    state={}, rng=random.Random(7))
    assert len(picked["performance_ids"]) == 4
    # round 1's operators are the paper, and they are what this round measures
    assert picked["generalization_ids"] == picked["performance_ids"]
    assert picked["defines_paper"] is True


def test_later_rounds_draw_new_operators_and_reuse_the_paper():
    pool, table = _pool(), _table()
    first = select_round_questions(iteration=1, table=table, instances=pool,
                                   state={}, rng=random.Random(1))
    groups = record_paper(table, iteration=1,
                          generalization_ids=first["generalization_ids"],
                          performance_ids=first["performance_ids"])
    second = select_round_questions(iteration=2, table=table, instances=pool,
                                    state={"groups": groups},
                                    rng=random.Random(2))
    assert set(second["performance_ids"]).isdisjoint(first["generalization_ids"])
    assert second["generalization_ids"] == first["generalization_ids"]
    assert second["defines_paper"] is False


def test_operators_without_any_reference_are_not_sampled():
    pool = {"known": {"baseline_us": 10.0}, "unknown": {}}
    assert sample_operators(pool, count=2, table=_table()) == ["known"]


# ---------------------------------------------------------------- the gates

def _reference(ids, table, pool):
    return reference_results(table, ids, instances=pool)


def test_performance_gate_needs_three_of_four_wins():
    pool, table = _pool(), _table()
    ids = ["op00", "op01", "op02", "op03"]
    ref = _reference(ids, table, pool)          # 40/80/120/160 us variants
    candidate = {
        "op00": {"median_us": 30.0, "correctness_ok": True, "status": "success"},
        "op01": {"median_us": 70.0, "correctness_ok": True, "status": "success"},
        "op02": {"median_us": 110.0, "correctness_ok": True, "status": "success"},
        "op03": {"median_us": 170.0, "correctness_ok": True, "status": "success"},
    }
    gate = evaluate_gate(kind="performance", operator_ids=ids, results=candidate,
                         table=table, instances=pool)
    assert gate["status"] == "PASS" and len(gate["wins"]) == 3
    assert gate["wins_needed"] == 3 and gate["required_win_ratio"] == 0.75

    # only two wins -> fail
    candidate["op02"] = {"median_us": 130.0, "correctness_ok": True,
                         "status": "success"}
    gate = evaluate_gate(kind="performance", operator_ids=ids, results=candidate,
                         table=table, instances=pool)
    assert gate["status"] == "FAIL" and "2/4 operators" in gate["reasons"][-1]


def test_a_winning_round_still_fails_if_one_operator_collapses():
    pool, table = _pool(), _table()
    ids = ["op00", "op01", "op02", "op03"]
    candidate = {
        "op00": {"median_us": 30.0, "correctness_ok": True, "status": "success"},
        "op01": {"median_us": 70.0, "correctness_ok": True, "status": "success"},
        "op02": {"median_us": 110.0, "correctness_ok": True, "status": "success"},
        # variant is 160us; 140us is only 87% ... 220us is 72% (below the floor)
        "op03": {"median_us": 220.0, "correctness_ok": True, "status": "success"},
    }
    gate = evaluate_gate(kind="performance", operator_ids=ids, results=candidate,
                         table=table, instances=pool)
    assert gate["status"] == "FAIL"
    assert gate["below_floor"] == ["op03"]


def test_generalization_gate_needs_only_two_of_four():
    pool, table = _pool(), _table()
    ids = ["op00", "op01", "op02", "op03"]
    candidate = {
        "op00": {"median_us": 30.0, "correctness_ok": True, "status": "success"},
        "op01": {"median_us": 70.0, "correctness_ok": True, "status": "success"},
        "op02": {"median_us": 140.0, "correctness_ok": True, "status": "success"},
        "op03": {"median_us": 180.0, "correctness_ok": True, "status": "success"},
    }
    gate = evaluate_gate(kind="generalization", operator_ids=ids,
                         results=candidate, table=table, instances=pool)
    assert gate["status"] == "PASS" and gate["wins_needed"] == 2
    assert gate["required_win_ratio"] == 0.5

    candidate["op01"] = {"median_us": 90.0, "correctness_ok": True,
                         "status": "success"}
    gate = evaluate_gate(kind="generalization", operator_ids=ids,
                         results=candidate, table=table, instances=pool)
    assert gate["status"] == "FAIL"


def test_a_retake_that_reproduces_the_same_kernels_still_holds_the_line():
    """Ties are not losses in the generalization gate.

    The retake re-measures the paper on the same harness, and DKAO warm-starts
    from the kernel the baseline round put in the pool — so re-finding that exact
    kernel (delta 0.0%) is the expected outcome, not a failure. Scoring it as a
    loss would demand that a *search policy* out-optimize its own best result
    every single round.
    """
    pool, table = _pool(), _table()
    ids = ["op00", "op01", "op02", "op03"]
    variants = {"op00": 40.0, "op01": 80.0, "op02": 120.0, "op03": 160.0}
    candidate = {iid: {"median_us": variants[iid], "correctness_ok": True,
                       "status": "success"} for iid in ids}

    gate = evaluate_gate(kind="generalization", operator_ids=ids,
                         results=candidate, table=table, instances=pool)
    assert gate["tie_policy"] == "neutral"
    assert gate["ties"] == ids and gate["wins"] == [] and gate["losses"] == []
    assert gate["status"] == "PASS", gate["reasons"]

    # ... but the floor still bites: one operator genuinely slower than its
    # variant fails the retake even with ties scored as holding the line
    candidate["op03"] = {"median_us": 400.0, "correctness_ok": True,
                         "status": "success"}
    gate = evaluate_gate(kind="generalization", operator_ids=ids,
                         results=candidate, table=table, instances=pool)
    assert gate["status"] == "FAIL"
    assert gate["losses"] == ["op03"] and gate["below_floor"] == ["op03"]


def test_the_performance_gate_still_counts_a_tie_as_a_loss():
    """Fresh operators must genuinely win: a tie proves nothing there."""
    pool, table = _pool(), _table()
    ids = ["op00", "op01", "op02", "op03"]
    variants = {"op00": 40.0, "op01": 80.0, "op02": 120.0, "op03": 160.0}
    candidate = {iid: {"median_us": variants[iid], "correctness_ok": True,
                       "status": "success"} for iid in ids}
    gate = evaluate_gate(kind="performance", operator_ids=ids,
                         results=candidate, table=table, instances=pool)
    assert gate["tie_policy"] == "loss"
    assert gate["status"] == "FAIL"
    assert "no operator beat its variant" in " ".join(gate["reasons"])


def test_unmeasured_operator_is_never_counted_as_a_loss():
    """Three wins and one missing number is *not* a verdict about the harness.

    It used to be FAIL, which both blamed the harness for a number the machine
    never produced and (on the retake) spent the candidate on it. The round now
    carries ``INCOMPLETE``: no verdict, re-measured later.
    """
    pool, table = _pool(), _table()
    ids = ["op00", "op01", "op02", "op03"]
    candidate = {
        "op00": {"median_us": 30.0, "correctness_ok": True, "status": "success"},
        "op01": {"median_us": 70.0, "correctness_ok": True, "status": "success"},
        "op02": {"median_us": 110.0, "correctness_ok": True, "status": "success"},
        # op03 never reported: the round is not evidence
    }
    gate = evaluate_gate(kind="performance", operator_ids=ids, results=candidate,
                         table=table, instances=pool)
    assert gate["status"] == "INCOMPLETE"
    assert "op03" in gate["unmeasured"]
    assert gate["wins_needed"] == 3              # wins already enough to pass...
    assert gate["wins_needed_over_requested"] == 3   # ... over the drawn round
    assert any("op03" in reason for reason in gate["reasons"])


def test_a_gate_that_cannot_pass_without_the_missing_question_is_a_fail():
    """Decisive losses are still decided now: no relaunch needed to know."""
    pool, table = _pool(), _table()               # variants 40/80/120/160 us
    ids = ["op00", "op01", "op02", "op03"]
    candidate = {
        # ~1% slower than each variant: inside the noise band, i.e. a tie → a
        # loss for the performance gate, but nowhere near the 80% floor.
        "op00": {"median_us": 40.4, "correctness_ok": True, "status": "success"},
        "op01": {"median_us": 80.8, "correctness_ok": True, "status": "success"},
        "op02": {"median_us": 121.2, "correctness_ok": True, "status": "success"},
        # op03 never reported
    }
    gate = evaluate_gate(kind="performance", operator_ids=ids, results=candidate,
                         table=table, instances=pool)
    assert gate["status"] == "FAIL", gate
    assert gate["below_floor"] == []              # the floor is not what decided it
    assert any("cannot pass" in reason for reason in gate["reasons"])


def test_a_question_below_the_floor_is_a_fail_even_with_others_missing():
    pool, table = _pool(), _table()
    ids = ["op00", "op01", "op02", "op03"]
    candidate = {
        "op00": {"median_us": 30.0, "correctness_ok": True, "status": "success"},
        "op01": {"median_us": 200.0, "correctness_ok": True, "status": "success"},
        # way below the 80% floor of its 80us variant
        "op02": {"median_us": 110.0, "correctness_ok": True, "status": "success"},
        # op03 never reported
    }
    gate = evaluate_gate(kind="performance", operator_ids=ids, results=candidate,
                         table=table, instances=pool)
    assert gate["status"] == "FAIL"
    assert "op01" in gate["below_floor"]


# ------------------------------------------------------- variant table rules

def test_variant_table_moves_only_when_a_harness_is_promoted(tmp_path):
    pool = _pool()
    table = load_variant_table(tmp_path, pool_path=None)
    table["operators"] = {}
    # a rejected round measured something faster, but nothing is promoted
    before = table["operators"].get("op00")
    result = record_variants(tmp_path, table, {}, version="h-2", iteration=1)
    assert result["updated"] == [] and table["operators"] == {}

    # the approved candidate's numbers become the new variants
    outcome = record_variants(
        tmp_path, table,
        {"op00": {"median_us": 11.0, "p90_us": 11.2, "correctness_ok": True,
                  "repo_path": "/repos/op00"}},
        version="h-2", iteration=1,
        groups={"generalization_ids": ["op00"]})
    assert outcome["updated"] == ["op00"]
    resolved = resolve_variant(table, "op00", instances=pool)
    assert resolved["median_us"] == 11.0 and resolved["source"] == "variant"
    assert resolved["harness_version"] == "h-2"
    history = [json.loads(l) for l in
               (tmp_path / "variant_history.jsonl").read_text().splitlines()]
    assert history[-1]["harness_version"] == "h-2"
    assert json.loads((tmp_path / "variant_table.json").read_text()
                      )["harness_version"] == "h-2"


def test_a_slower_measurement_never_regresses_a_variant(tmp_path):
    pool = _pool()
    table = {"operators": {}, "groups": {}}
    record_variants(tmp_path, table,
                    {"op00": {"median_us": 30.0, "correctness_ok": True}},
                    version="h-2", iteration=1)
    record_variants(tmp_path, table,
                    {"op00": {"median_us": 45.0, "correctness_ok": True}},
                    version="h-3", iteration=2)
    assert resolve_variant(table, "op00", instances=pool)["median_us"] == 30.0


def test_reference_falls_back_to_pool_best_known_then_baseline(tmp_path):
    pool = {"best": {"baseline_us": 100.0, "best_known_us": 40.0},
            "baseonly": {"baseline_us": 55.0},
            "nothing": {}}
    table = {"operators": {}, "groups": {}}
    assert resolve_variant(table, "best", instances=pool)["source"] == "best_known"
    assert resolve_variant(table, "baseonly", instances=pool)["source"] == "baseline"
    assert resolve_variant(table, "nothing", instances=pool) is None


def test_question_count_is_rounded_to_a_multiple_of_the_gpu_count():
    """A wave must be able to fill all 4 HCUs: counts snap to multiples of 4."""
    from ..orchestrator.rounds import OPERATORS_PER_GATE, normalized_per_gate

    assert OPERATORS_PER_GATE == 4
    assert normalized_per_gate(None) == 4          # default
    assert normalized_per_gate("") == 4
    assert normalized_per_gate(0) == 4
    assert normalized_per_gate("bad") == 4
    assert normalized_per_gate(4) == 4
    assert normalized_per_gate(5) == 8             # rounds up, never down
    assert normalized_per_gate(7) == 8
    assert normalized_per_gate(8) == 8
    assert normalized_per_gate(12) == 12


def test_eight_question_round_uses_eight_operators_in_both_gates():
    pool, table = _pool(20), _table()
    picked = select_round_questions(iteration=1, table=table, instances=pool,
                                    state={}, count=8, rng=random.Random(3))
    assert len(picked["performance_ids"]) == 8
    assert picked["generalization_ids"] == picked["performance_ids"]

    groups = record_paper(table, iteration=1,
                          generalization_ids=picked["generalization_ids"],
                          performance_ids=picked["performance_ids"])
    second = select_round_questions(iteration=2, table=table, instances=pool,
                                    state={"groups": groups}, count=8,
                                    rng=random.Random(4))
    assert len(second["performance_ids"]) == 8
    assert set(second["performance_ids"]).isdisjoint(picked["performance_ids"])


def test_eight_question_gates_need_six_and_four_wins():
    pool, table = _pool(20), _table()
    ids = [f"op{i:02d}" for i in range(8)]
    base = {iid: 100.0 for iid in ids}
    reference = {iid: {"median_us": base[iid], "status": "reference",
                       "correctness_ok": True} for iid in ids}
    # 6 wins, 2 small losses -> performance gate passes (75% of 8 = 6)
    candidate = {iid: {"median_us": 90.0, "correctness_ok": True,
                       "status": "success"} for iid in ids}
    for iid in ids[6:]:
        candidate[iid]["median_us"] = 105.0
    perf = gate_verdict(reference, candidate, kind="performance")
    assert perf["wins_needed"] == 6 and perf["status"] == "PASS"
    # 4 wins -> generalization gate passes (50% of 8 = 4), performance does not
    for iid in ids[4:]:
        candidate[iid]["median_us"] = 105.0
    assert gate_verdict(reference, candidate, kind="performance")["status"] == "FAIL"
    gen = gate_verdict(reference, candidate, kind="generalization")
    assert gen["wins_needed"] == 4 and gen["status"] == "PASS"


def test_round_size_follows_the_request_and_never_shrinks_to_the_cards():
    """A round is as big as the operator asked for, whatever the cards are doing.

    ``harness_evolve`` manages no GPU occupancy: it hands every question to a
    DKAO child and the child's own admission gate waits for a clean device. So
    there is nothing to shrink the round *to* — no "free devices" number, no
    ``fit_count_to_devices`` — and a busy machine can no longer silently turn a
    four-question round into a two-question one.
    """
    from ..orchestrator.rounds import (
        GPU_COUNT, device_for_index, normalized_per_gate,
    )

    # the requested count is honoured, only rounded up to a whole wave of 4
    assert normalized_per_gate(4) == 4
    assert normalized_per_gate(8) == 8
    assert normalized_per_gate(5) == 8

    # one question per device, repeating cyclically: 8 questions = 2 waves
    assert [device_for_index(i) for i in range(8)] == [0, 1, 2, 3, 0, 1, 2, 3]
    assert GPU_COUNT == 4


def test_no_gpu_lease_or_occupancy_logic_is_left_in_the_round_path():
    """The HE round path must not import the broker or probe the cards."""
    from ..orchestrator import rounds as rounds_mod
    from ..orchestrator.pipeline import _truthy  # still used for other flags

    assert _truthy(None, default=False) is False      # opt-in, not opt-out
    assert not hasattr(rounds_mod, "devices_free_now")
    assert not hasattr(rounds_mod, "fit_count_to_devices")

    import ast
    import inspect
    import io
    import tokenize as _tok

    from ..orchestrator.adapters import eval as eval_mod

    # Judge the code, not the comments/docstrings that document what was removed.
    source = inspect.getsource(eval_mod)
    pieces = []
    for token in _tok.generate_tokens(io.StringIO(source).readline):
        if token.type in (_tok.COMMENT, _tok.STRING):
            continue
        pieces.append(token.string)
    code = " ".join(pieces)
    for forbidden in ("gpu_broker", "PRIORITY_HARNESS", "gpu_gate",
                      "measurement_suspect", "PREFERRED_DEVICES"):
        assert forbidden not in code, forbidden
    assert "_evaluate_scheduled" not in code
    assert "_start_contention_watch" not in code
    # the gate verdict lives in the child's own measurement_gate.jsonl
    tree = ast.parse(source)
    names = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
    names |= {n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)}
    assert "measurement_suspect" not in names


def test_a_three_device_round_draws_three_operators_with_both_regimes():
    pool, table = _pool(20), _table()
    picked = select_round_questions(iteration=1, table=table, instances=pool,
                                    state={}, count=3, rng=random.Random(11))
    assert len(picked["performance_ids"]) == 3
    assert picked["generalization_ids"] == picked["performance_ids"]
    regimes = {regime_of(pool[i]) for i in picked["performance_ids"]}
    assert regimes == {"decode", "prefill"}
