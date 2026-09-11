"""Tests for orchestrator.planner (M1 slice 2: state-conditioned selector v0)."""

from __future__ import annotations

from ..orchestrator import planner


def _valid_record(improvement: float = 0.5, *, speedup: float = 1.0) -> dict:
    return {
        "build_success": True,
        "correctness_passed": True,
        "speedup": speedup,
        "metrics": {"graph_capture_passed": True},
        "acceptance": {"improvement_percent": improvement},
    }


def _wrong_fast_record() -> dict:
    return {
        "build_success": True,
        "correctness_passed": False,
        "speedup": 1.8,
        "metrics": {"graph_capture_passed": True},
    }


def _build_fail_record() -> dict:
    return {"build_success": False, "failure_reason": "compile error line 42"}


def _infra_record() -> dict:
    return {
        "build_success": False,
        "failure_reason": "timed out after 900s",
    }


def test_catalog_loads_from_yaml_seed():
    cat = planner.catalog()
    for pid in ("repair_faster_wrong", "isa_guided_hip", "consolidate"):
        assert pid in cat


def test_p0_faster_wrong_beats_everything():
    history = [_valid_record(), _wrong_fast_record()]
    assert planner.choose_plan_from_history(history, iteration=3) == (
        "repair_faster_wrong"
    )


def test_empty_history_is_not_build_failure():
    # A fresh lane (no previous round) must not be routed to fix_build.
    assert planner.choose_plan_from_history([]) == "establish_arch"


def test_p0_infra_retry_and_build_fix():
    assert planner.choose_plan_from_history([_valid_record(), _infra_record()]) == (
        "retry_same"
    )
    assert planner.choose_plan_from_history(
        [_valid_record(), _build_fail_record()]
    ) == "fix_build"


def test_p1_last_round_consolidates():
    history = [_valid_record() for _ in range(3)]
    assert planner.choose_plan_from_history(
        history, iteration=10, max_iterations=10
    ) == "consolidate"


def test_p1_plateau_opens_isa_then_asm():
    # 8 valid HIP rounds + last three improvements inside [-2, 2) prove
    # plateau with the ISA gate open (required_hip_rounds = max_iterations - 2).
    history = [_valid_record(0.5) for _ in range(5)] + [
        _valid_record(v) for v in (0.5, 0.9, 1.2)
    ]
    plan = planner.choose_plan_from_history(
        history, iteration=9, max_iterations=10
    )
    assert plan == "isa_guided_hip"
    plan2 = planner.choose_plan_from_history(
        history,
        iteration=9,
        max_iterations=10,
        compiler_limitation_confirmed=True,
    )
    assert plan2 == "conditional_inline_asm"


def test_p2_occupancy_signature_selects_resource_round():
    history = [_valid_record() for _ in range(2)]
    pmc = {"waves_per_cu": 12, "target_waves_per_cu": 16}
    assert planner.choose_plan_from_history(
        history, pmc=pmc, iteration=5
    ) == "occupancy_resource"


def test_p2_bank_conflict_signature():
    history = [_valid_record() for _ in range(2)]
    pmc = {"lds_instructions": 1000, "lds_bank_conflicts": 2000}
    assert planner.choose_plan_from_history(
        history, pmc=pmc, iteration=5
    ) == "memory_layout"


def test_p4_fallback_matches_legacy_menu_intent(monkeypatch):
    # The no-evidence fallback (uncertainty -> legacy_menu) is on by default;
    # disable it here so the P4 portfolio table itself is exercised.
    pol = dict(planner._builtin_policy())
    pol["uncertainty"] = {"enabled": False}
    monkeypatch.setattr(planner, "policy", lambda root=None: pol)
    history = [_valid_record() for _ in range(2)]
    plan = planner.choose_plan_from_history(
        history, iteration=2, max_iterations=10, shape={"M": 4096}
    )
    assert plan == "memory_layout"  # large_m legacy menu, step after bootstrap


def test_coverage_guard_breaks_same_plan_repetition():
    history = [_valid_record() for _ in range(2)]
    pmc = {
        "waves_per_cu": 12,
        "target_waves_per_cu": 16,
        "l2_hit_rate": 40.0,
    }
    # two prior identical occupancy rounds -> P3 should route to the next
    # candidate (memory_layout from l2_low) instead of repeating occupancy.
    plan = planner.choose_plan_from_history(
        history,
        pmc=pmc,
        iteration=6,
        plan_tags=["occupancy_resource", "occupancy_resource"],
    )
    assert plan == "memory_layout"


def test_fallback_portfolio_cycles_instead_of_pinning_the_tail():
    """Long runs must not be pinned to the table's last row (consolidate).

    9-8-8 iteration 3 showed 9 of 11 planner picks were ``consolidate``
    because the fallback indexed past the table end and clamped. The
    portfolio now cycles, so a long run keeps revisiting exploration plans.
    """
    from ..orchestrator.planner import _legacy_fallback

    picks = [
        _legacy_fallback({"shape": {"M": 16}, "iteration": it})
        for it in range(2, 14)
    ]
    assert len(set(picks)) > 2, picks
    tail = picks[-4:]
    assert len(set(tail)) > 1, tail
    assert tail.count("consolidate") < len(tail), tail


def test_uncertainty_falls_back_to_legacy_menu(monkeypatch):
    """No bottleneck evidence -> defer to the hand-tuned menu."""
    from ..orchestrator import planner as P

    pol = dict(P._builtin_policy())
    pol["uncertainty"] = {"enabled": True, "plan": "legacy_menu",
                          "min_valid_rounds": 1}
    monkeypatch.setattr(P, "policy", lambda root=None: pol)
    monkeypatch.setattr(P, "bottleneck_tags", lambda pmc: [])
    ctx = {"valid_hip_rounds": 2, "pmc": {}, "shape": {"M": 16},
           "iteration": 3, "max_iterations": 11, "rounds_left": 9,
           "tried_counts": {}, "consecutive_same": 0,
           "last_present": False, "faster_wrong": False}
    assert P.choose_plan(ctx) == "legacy_menu"


def test_uncertainty_is_skipped_when_a_bottleneck_is_known(monkeypatch):
    from ..orchestrator import planner as P

    pol = dict(P._builtin_policy())
    pol["uncertainty"] = {"enabled": True, "plan": "legacy_menu"}
    pol["bottleneck_to_plan"] = {"lds_bank_conflicts": "memory_layout"}
    monkeypatch.setattr(P, "policy", lambda root=None: pol)
    monkeypatch.setattr(P, "bottleneck_tags",
                        lambda pmc: ["lds_bank_conflicts"])
    ctx = {"valid_hip_rounds": 2, "pmc": {"available": True},
           "shape": {"M": 16}, "iteration": 3, "max_iterations": 11,
           "rounds_left": 9, "tried_counts": {}, "consecutive_same": 0,
           "last_present": False, "faster_wrong": False}
    assert P.choose_plan(ctx) == "memory_layout"


def test_legacy_menu_plan_renders_the_legacy_menu(tmp_path, monkeypatch):
    import json as _json
    from ..orchestrator import w8a8_pipeline as W

    monkeypatch.setenv("METAINFER_PLANNER", "1")
    monkeypatch.setattr(W, "choose_plan_from_history",
                        lambda *a, **k: "legacy_menu")
    sink = tmp_path / "planner_plans.jsonl"
    text = W._round_strategy_text(
        {"M": 16, "N": 4096, "K": 2048}, 2, [], {"available": False},
        {"max_iterations": 5, "skill_allowed": True},
        plan_sink=sink, shape_id="hy3_tp4_o_proj_m16",
    )
    assert text and len(text) > 50
    row = _json.loads(sink.read_text(encoding="utf-8").splitlines()[-1])
    assert row["plan_id"] == "legacy_menu" and row["source"] == "planner"
