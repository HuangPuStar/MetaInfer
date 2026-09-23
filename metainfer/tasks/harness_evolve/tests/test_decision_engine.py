"""System-level five-state decision engine tests."""

from __future__ import annotations

from ..orchestrator.decision_engine import DecisionPolicy, decide


def _results(medians, *, passed=True, correctness=True):
    return {
        k: {
            "median_us": v,
            "passed": passed,
            "correctness_ok": correctness,
        }
        for k, v in medians.items()
    }


def _manifest(routeable=False):
    return {
        "iteration": 1,
        "changes": [{
            "id": "chg-1",
            "mechanism_signature": ["plan sequence changes"],
            "scope": {"routeable": routeable},
        }],
    }


def test_first_result_establishes_baseline():
    d = decide(None, _results({"a": 100.0}))
    assert d["verdict"] == "BASELINE"
    assert d["action"] == "SET_CHAMPION"


def test_promote_when_performance_and_mechanism_hit():
    champ = _results({"a": 100.0, "b": 100.0})
    cand = _results({"a": 90.0, "b": 88.0})
    d = decide(champ, cand, manifest=_manifest(),
               mechanism_checks={"chg-1": True})
    assert d["verdict"] == "PROMOTE"
    assert d["performance_gate"]["status"] == "PASS"
    assert d["mechanism_gate"]["status"] == "HIT"


def test_lenient_default_promotes_unexplained_win_without_repeat():
    """Default policy is lenient: an unverified win still takes the champion."""
    champ = _results({"a": 100.0, "b": 100.0})
    cand = _results({"a": 90.0, "b": 90.0})
    d = decide(champ, cand, manifest=_manifest(), mechanism_checks={})
    assert d["verdict"] == "PROMOTE_UNEXPLAINED"
    assert d["action"] == "SET_CHAMPION"
    assert d["policy"]["mechanism_policy"] == "lenient"


def test_strict_policy_requires_confirmation_then_promotes():
    champ = _results({"a": 100.0, "b": 100.0})
    cand = _results({"a": 90.0, "b": 90.0})
    strict = DecisionPolicy(mechanism_policy="strict")
    first = decide(champ, cand, manifest=_manifest(), mechanism_checks={},
                   policy=strict)
    assert first["verdict"] == "CONFIRM_REQUIRED"
    second = decide(champ, cand, manifest=_manifest(), mechanism_checks={},
                    confirmation_reproduced=True, policy=strict)
    assert second["verdict"] == "PROMOTE_UNEXPLAINED"
    assert second["action"] == "SET_CHAMPION"


def test_no_signal_keeps_champion_without_rejecting_candidate():
    champ = _results({"a": 100.0, "b": 100.0})
    cand = _results({"a": 99.5, "b": 101.0})
    d = decide(champ, cand, manifest=_manifest())
    assert d["verdict"] == "NO_SIGNAL"
    assert d["action"] == "KEEP_CHAMPION_ARCHIVE_CANDIDATE"


def test_correctness_or_primary_regression_rejects():
    champ = _results({"a": 100.0, "b": 100.0})
    cand = _results({"a": 120.0, "b": 90.0})
    cand["b"]["correctness_ok"] = False
    d = decide(champ, cand, manifest=_manifest())
    assert d["verdict"] == "REJECT"
    assert d["action"] == "RESTORE_CHAMPION"


def test_heldout_regression_specializes_if_routeable_else_rejects_overfit():
    champ = _results({"a": 100.0, "b": 100.0})
    cand = _results({"a": 80.0, "b": 80.0})
    held_champ = _results({"h": 100.0})
    held_cand = _results({"h": 120.0})

    specialized = decide(
        champ, cand, manifest=_manifest(routeable=True),
        mechanism_checks={"chg-1": True},
        heldout_champion=held_champ, heldout_candidate=held_cand,
    )
    assert specialized["verdict"] == "SPECIALIZE"
    assert specialized["action"] == "ARCHIVE_SPECIALIZED"

    rejected = decide(
        champ, cand, manifest=_manifest(routeable=False),
        mechanism_checks={"chg-1": True},
        heldout_champion=held_champ, heldout_candidate=held_cand,
    )
    assert rejected["verdict"] == "REJECT_OVERFIT"


def test_harness_validate_error_detects_bad_yaml(tmp_path):
    import shutil as _sh
    from metainfer.tasks.dcu_kernel_auto_opt.orchestrator.harness_io import default_harness_dir
    from ..orchestrator.pipeline import _harness_validate_error
    wd = tmp_path / "ws"
    _sh.copytree(default_harness_dir(), wd)
    assert _harness_validate_error(wd) is None
    (wd / "planner_policy.yaml").write_text("not: [valid\n", encoding="utf-8")
    assert _harness_validate_error(wd) is not None


# --------------------------------------------------------- the 75% rule
# The performance gate is a question-count rule: >= 75% of the counted
# questions must be measurably faster than the champion ("3 of 4 beat the
# current variant"), with one hard red line for a single question that
# collapses (> 30% slower) or fails correctness.

def test_three_of_four_question_wins_pass_the_performance_gate():
    champ = _results({"a": 100.0, "b": 100.0, "c": 100.0, "d": 100.0})
    cand = _results({"a": 90.0, "b": 90.0, "c": 91.0, "d": 110.0})  # d is 10% slower
    d = decide(champ, cand, manifest=_manifest(), mechanism_checks={"chg-1": True})
    assert d["performance_gate"]["status"] == "PASS"
    assert d["performance_gate"]["win_ratio"] == 0.75
    assert d["performance_gate"]["wins_needed"] == 3
    assert d["verdict"] == "PROMOTE"


def test_two_of_four_question_wins_fail_the_performance_gate():
    champ = _results({"a": 100.0, "b": 100.0, "c": 100.0, "d": 100.0})
    cand = _results({"a": 90.0, "b": 90.0, "c": 130.0, "d": 130.0})
    d = decide(champ, cand, manifest=_manifest(), mechanism_checks={"chg-1": True})
    assert d["verdict"] == "REJECT"
    assert d["performance_gate"]["status"] == "FAIL"
    assert d["performance_gate"]["win_ratio"] == 0.5
    assert "2/4 counted questions faster" in d["reason"]


def test_one_collapsing_question_rejects_despite_three_wins():
    """The red line: 3 small wins do not buy one 40%-slower question."""
    champ = _results({"a": 100.0, "b": 100.0, "c": 100.0, "d": 100.0})
    cand = _results({"a": 90.0, "b": 90.0, "c": 90.0, "d": 140.0})
    d = decide(champ, cand, manifest=_manifest(), mechanism_checks={"chg-1": True})
    assert d["verdict"] == "REJECT"
    assert d["performance_gate"]["collapses"] == ["d"]
    assert "hard red line" in d["reason"]


def test_three_questions_all_winning_passes():
    champ = _results({"a": 100.0, "b": 100.0, "c": 100.0})
    cand = _results({"a": 80.0, "b": 80.0, "c": 80.0})
    d = decide(champ, cand, manifest=_manifest(), mechanism_checks={"chg-1": True})
    assert d["policy"]["min_win_ratio"] == 0.75
    assert d["performance_gate"]["wins_needed"] == 3
    assert d["performance_gate"]["status"] == "PASS"


def test_a_draw_inside_the_noise_band_counts_against_the_ratio():
    """Only strictly measurable wins count: a tie is not a win."""
    champ = _results({"a": 100.0, "b": 100.0, "c": 100.0, "d": 100.0})
    cand = _results({"a": 90.0, "b": 90.0, "c": 100.0, "d": 130.0})
    d = decide(champ, cand, manifest=_manifest(), mechanism_checks={"chg-1": True})
    gate = d["performance_gate"]
    assert gate["counts"]["NO_SIGNAL"] == 1 and gate["counts"]["WIN"] == 2
    assert gate["win_ratio"] == 0.5
    assert d["verdict"] == "REJECT"


def test_probe_questions_are_excluded_from_the_ratio():
    """A probe is generalisation evidence, not part of the 75% denominator."""
    champ = _results({"a": 100.0, "b": 100.0, "c": 100.0, "probe": 100.0})
    cand = _results({"a": 90.0, "b": 90.0, "c": 90.0, "probe": 200.0})
    d = decide(champ, cand, manifest=_manifest(), mechanism_checks={"chg-1": True},
               purposes={"probe": "probe"})
    # 3/3 counted questions won -> gate passes, but the probe regression blocks
    assert d["performance_gate"]["win_ratio"] == 1.0
    assert d["generalization_gate"]["status"] == "FAIL"
    assert d["verdict"] == "CONFIRM_REQUIRED"


def test_unusable_measurement_is_fatal_even_at_three_of_four():
    """A comparison missing one side is not "the candidate is faster"."""
    champ = _results({"a": 100.0, "b": 100.0, "c": 100.0, "d": 100.0})
    cand = _results({"a": 90.0, "b": 90.0, "c": 90.0, "d": 100.0})
    cand["d"] = {"median_us": None, "passed": False, "correctness_ok": False,
                 "status": "missing_report"}
    d = decide(champ, cand, manifest=_manifest(), mechanism_checks={"chg-1": True})
    assert d["performance_gate"]["counts"]["INVALID"] == 1
    assert d["verdict"] == "REJECT"
    assert "unusable measurement" in d["reason"]
