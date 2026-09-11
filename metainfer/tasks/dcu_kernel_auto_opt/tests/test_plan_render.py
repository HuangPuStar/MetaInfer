"""Tests for planner rendering + controlled-state parity with the legacy menu.

Controlled-state parity (not corpus heuristic): on states where the planner's
legacy-aligned branches deliberately mirror the current round menus, assert the
mandate texts agree on key direction tokens.
"""

from __future__ import annotations

from ..orchestrator.planner import catalog, choose_plan_from_history, render_plan
from ..orchestrator.prompts import w8a8_round_strategy
from ..orchestrator.w8a8_pipeline import isa_round_policy


def _valid(improvement: float = 0.5) -> dict:
    return {
        "build_success": True,
        "correctness_passed": True,
        "speedup": 1.0,
        "metrics": {"graph_capture_passed": True},
        "acceptance": {"improvement_percent": improvement},
    }


def test_render_all_catalog_plans_nonempty_and_deterministic():
    cat = catalog()
    ctx = {"iteration": 3, "max_iterations": 10, "rounds_left": 8}
    seen = {}
    for pid in cat:
        text = render_plan(pid, ctx=ctx, cat=cat)
        assert pid in text and len(text) > 10
        seen[pid] = text
    # deterministic
    for pid, text in seen.items():
        assert render_plan(pid, ctx=ctx, cat=cat) == text


def test_fresh_lane_m16_matches_menu_on_dumma():
    # Fresh m16 lane: planner (establish_arch) and legacy menu (round 1 DUMMA
    # bootstrap instruction) both direct at DUMMA.
    plan = choose_plan_from_history([], iteration=1, shape={"M": 16})
    menu = w8a8_round_strategy(
        {"M": 16, "N": 1536, "K": 4096},
        1,
        [],
        {},
        max_iterations=10,
        isa_policy=isa_round_policy(
            iteration=1, max_iterations=10, history=[]
        ),
    )
    rendered = render_plan(plan, cat=catalog())
    assert "DUMMA" in rendered and "DUMMA" in menu


def test_plateau_open_matches_menu_on_isa():
    history = [_valid(0.5) for _ in range(5)] + [
        _valid(v) for v in (0.5, 0.9, 1.2)
    ]
    shape = {"M": 16, "N": 1536, "K": 4096}
    iteration, max_iterations = 9, 10
    policy = isa_round_policy(
        iteration=iteration, max_iterations=max_iterations, history=history
    )
    assert policy.get("phase") == "isa_guided_hip"

    plan = choose_plan_from_history(
        history, iteration=iteration, max_iterations=max_iterations,
        shape=shape,
    )
    menu = w8a8_round_strategy(
        shape, iteration, history, {},
        max_iterations=max_iterations, isa_policy=policy,
    )
    rendered = render_plan(plan, cat=catalog())
    assert plan == "isa_guided_hip"
    assert "ISA" in rendered and "ISA" in menu


def test_faster_wrong_matches_menu_on_repair():
    history = [_valid(0.5), {
        "build_success": True,
        "correctness_passed": False,
        "speedup": 1.9,
        "metrics": {"graph_capture_passed": True},
    }]
    shape = {"M": 16, "N": 1536, "K": 4096}
    iteration, max_iterations = 4, 10
    plan = choose_plan_from_history(
        history, iteration=iteration, max_iterations=max_iterations,
        shape=shape,
    )
    policy = isa_round_policy(
        iteration=iteration, max_iterations=max_iterations, history=history
    )
    menu = w8a8_round_strategy(
        shape, iteration, history, {},
        max_iterations=max_iterations, isa_policy=policy,
    )
    rendered = render_plan(plan, cat=catalog())
    assert plan == "repair_faster_wrong"
    assert "repair" in rendered.lower() and "repair" in menu.lower()
