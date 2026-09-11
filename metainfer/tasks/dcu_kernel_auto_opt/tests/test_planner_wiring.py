"""Tests for planner wiring env toggle (METAINFER_PLANNER)."""

from __future__ import annotations

from ..orchestrator.w8a8_pipeline import (
    _planner_enabled,
    _round_strategy_text,
    isa_round_policy,
)
from ..orchestrator.prompts import w8a8_round_strategy


def _isa_policy(iteration: int, max_iterations: int, history) -> dict:
    return isa_round_policy(
        iteration=iteration, max_iterations=max_iterations, history=history
    )


def test_planner_disabled_by_default(monkeypatch):
    monkeypatch.delenv("METAINFER_PLANNER", raising=False)
    assert _planner_enabled() is False


def test_env_toggle_enables(monkeypatch):
    monkeypatch.setenv("METAINFER_PLANNER", "1")
    assert _planner_enabled() is True


def test_disabled_returns_exact_legacy_text(monkeypatch):
    monkeypatch.delenv("METAINFER_PLANNER", raising=False)
    shape = {"M": 16, "N": 1536, "K": 4096}
    history = []
    policy = _isa_policy(1, 10, history)
    got = _round_strategy_text(shape, 1, history, {}, policy)
    expected = w8a8_round_strategy(
        shape, 1, history, {},
        max_iterations=10, isa_policy=policy,
    )
    assert got == expected


def test_enabled_renders_planner_mandate(monkeypatch):
    monkeypatch.setenv("METAINFER_PLANNER", "1")
    shape = {"M": 16, "N": 1536, "K": 4096}
    history = []
    policy = _isa_policy(1, 10, history)
    got = _round_strategy_text(shape, 1, history, {}, policy)
    assert got.startswith("Mandatory decision for this round:")
    assert "establish_arch" in got


def test_round_strategy_text_records_planner_decision(tmp_path, monkeypatch):
    """The planner's own choice is written to planner_plans.jsonl (hard evidence)."""
    import json as _json
    from ..orchestrator.w8a8_pipeline import _round_strategy_text

    monkeypatch.setenv("METAINFER_PLANNER", "1")
    sink = tmp_path / "planner_plans.jsonl"
    text = _round_strategy_text(
        {"M": 16, "N": 4096, "K": 2048}, 1, [], {"available": False},
        {"max_iterations": 3, "skill_allowed": True},
        plan_sink=sink, shape_id="hy3_tp4_o_proj_m16",
    )
    assert text
    assert sink.is_file()
    row = _json.loads(sink.read_text(encoding="utf-8").splitlines()[0])
    assert row["source"] == "planner"
    assert row["plan_id"]
    assert row["iteration"] == 1
    assert row["shape_id"] == "hy3_tp4_o_proj_m16"


def test_round_strategy_text_writes_nothing_without_planner(tmp_path, monkeypatch):
    from ..orchestrator.w8a8_pipeline import _round_strategy_text

    monkeypatch.delenv("METAINFER_PLANNER", raising=False)
    sink = tmp_path / "planner_plans.jsonl"
    text = _round_strategy_text(
        {"M": 16, "N": 4096, "K": 2048}, 1, [], {"available": False},
        {"max_iterations": 3, "skill_allowed": True},
        plan_sink=sink, shape_id="hy3_tp4_o_proj_m16",
    )
    assert text
    assert not sink.exists()
