"""Tests for the search-mode (flame-chase-style rewrite↔fine-tune) advisory.

Covers the pure helpers (``_primary_metric`` / ``_is_improvement`` /
``_resolve_search_mode``) and the stateless plateau counter
``_count_iters_since_best`` (via a fake store/workspace), plus the
``plan_prompt`` injection. Advisory-only: never touches the state machine.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from metainfer.tasks.opt_kernel.orchestrator.pipeline import (
    PLATEAU_WINDOW,
    _count_iters_since_best,
    _is_improvement,
    _primary_metric,
    _resolve_search_mode,
)
from metainfer.tasks.opt_kernel.orchestrator.prompts import plan_prompt


# --------------------------------------------------------------------------- #
# _primary_metric
# --------------------------------------------------------------------------- #

def test_primary_metric_prefers_ms_per_op_decrease():
    m = _primary_metric({"ms_per_op": 1.8, "speedup": 2.0, "gflops": 70})
    assert m == (1.8, "decrease")


def test_primary_metric_falls_back_through_preferences():
    assert _primary_metric({"tokens_per_sec": 100}) == (100.0, "increase")
    assert _primary_metric({"speedup": 2.0}) == (2.0, "increase")
    assert _primary_metric({"gflops": 70.0}) == (70.0, "increase")
    assert _primary_metric({}) is None
    # non-numeric / missing keys ignored
    assert _primary_metric({"correctness": True}) is None


# --------------------------------------------------------------------------- #
# _is_improvement (noise margin)
# --------------------------------------------------------------------------- #

def test_is_improvement_decrease_direction():
    assert _is_improvement(1.0, 2.0, "decrease") is True       # 50% better
    assert _is_improvement(1.992, 2.0, "decrease") is False    # 0.4% = noise
    assert _is_improvement(2.5, 2.0, "decrease") is False     # worse


def test_is_improvement_increase_direction():
    assert _is_improvement(3.0, 2.0, "increase") is True      # 50% better
    assert _is_improvement(2.008, 2.0, "increase") is False    # 0.4% = noise
    assert _is_improvement(1.5, 2.0, "increase") is False     # worse


# --------------------------------------------------------------------------- #
# _resolve_search_mode
# --------------------------------------------------------------------------- #

def test_resolve_search_mode_fine_tune_by_default():
    assert _resolve_search_mode(1, 0) == "fine_tune"          # first iter
    assert _resolve_search_mode(5, 1) == "fine_tune"          # improving
    assert _resolve_search_mode(5, PLATEAU_WINDOW - 1) == "fine_tune"


def test_resolve_search_mode_rewrite_on_plateau():
    assert _resolve_search_mode(5, PLATEAU_WINDOW) == "rewrite"
    assert _resolve_search_mode(10, 7) == "rewrite"
    # plateau detection only kicks in after iteration 1
    assert _resolve_search_mode(1, 99) == "fine_tune"


def test_resolve_search_mode_window_is_configurable():
    assert _resolve_search_mode(5, 2, plateau_window=2) == "rewrite"
    assert _resolve_search_mode(5, 1, plateau_window=2) == "fine_tune"


# --------------------------------------------------------------------------- #
# _count_iters_since_best (stateless, resume-safe)
# --------------------------------------------------------------------------- #

@dataclass
class _FakeRec:
    iteration: int
    perf: Dict[str, float] = field(default_factory=dict)


class _FakeStore:
    """Mimics the REAL ``StateStore.load_iteration`` contract: returns a plain
    ``dict`` (the shell ships no IterationRecord dataclass), with ``perf``
    as a top-level dict key — NOT an attribute. The plateau counter must read
    ``rec.get('perf')``, never ``rec.perf``."""

    def __init__(self, records: List[_FakeRec]):
        self._records = {r.iteration: r for r in records}

    def load_iteration(self, i: int) -> Optional[Dict[str, Any]]:
        r = self._records.get(i)
        if r is None:
            return None
        return {"iteration": r.iteration, "perf": r.perf}


class _FakeWorkspace:
    def __init__(self, last: int):
        self._last = last

    def latest_complete_number(self) -> int:
        return self._last


def test_count_iters_since_best_empty_history():
    assert _count_iters_since_best(_FakeStore([]), _FakeWorkspace(0)) == 0


def test_count_iters_since_best_all_improving():
    # ms_per_op monotonically decreasing → last iter is the best → 0 since best
    recs = [_FakeRec(i, {"ms_per_op": 2.0 - 0.1 * i}) for i in range(1, 5)]
    assert _count_iters_since_best(_FakeStore(recs), _FakeWorkspace(4)) == 0


def test_count_iters_since_best_detects_plateau():
    # iter1 best=2.0; iters 2..5 all hover around 1.98 (within 0.5% noise of
    # each other and of... wait: 1.98 vs 2.0 is 1% better, so iter2 sets a new
    # best=1.98; then 3..5 are noise around 1.98 → since best = 3).
    recs = [
        _FakeRec(1, {"ms_per_op": 2.00}),
        _FakeRec(2, {"ms_per_op": 1.98}),   # 1% better → new best
        _FakeRec(3, {"ms_per_op": 1.981}),  # noise
        _FakeRec(4, {"ms_per_op": 1.979}),  # noise
        _FakeRec(5, {"ms_per_op": 1.980}),  # noise
    ]
    assert _count_iters_since_best(_FakeStore(recs), _FakeWorkspace(5)) == 3


def test_count_iters_since_best_skips_records_without_perf():
    recs = [
        _FakeRec(1, {"ms_per_op": 2.0}),
        _FakeRec(2, {}),                    # no perf → skipped
        _FakeRec(3, {"ms_per_op": 1.9}),    # new best
        _FakeRec(4, {"ms_per_op": 1.905}),  # noise → since best = 1
    ]
    assert _count_iters_since_best(_FakeStore(recs), _FakeWorkspace(4)) == 1


def test_count_iters_since_best_resume_safe():
    """Recomputing from history gives the same value as a live counter would —
    a restart reads the store and arrives at the same plateau signal."""
    recs = [_FakeRec(i, {"ms_per_op": 2.0}) for i in range(1, 6)]  # flat → plateau
    # best set at iter1 (2.0); iters 2..5 are noise → since best = 4
    assert _count_iters_since_best(_FakeStore(recs), _FakeWorkspace(5)) == 4


def test_count_iters_since_best_no_usable_perf_returns_zero():
    # All records exist but none have a primary metric → no signal → 0
    # (maps to fine_tune, NOT 'since-the-beginning rewrite').
    recs = [_FakeRec(i, {}) for i in range(1, 6)]
    assert _count_iters_since_best(_FakeStore(recs), _FakeWorkspace(5)) == 0


def test_count_iters_since_best_real_state_store_integration(tmp_path):
    """Regression guard: drive the plateau counter against the REAL
    ``StateStore`` (which returns plain dicts, not objects with ``.perf``).
    This is the contract that broke silently when ``_count_iters_since_best``
    used attribute access — the fake-store tests passed while production
    skipped every record and forced ``rewrite`` on every iteration."""
    from metainfer.orchestrator.state import StateStore

    store = StateStore(tmp_path / "tasks" / "t1")
    # Write iteration records exactly as the pipeline persists them: a JSON
    # object with a top-level ``perf`` dict (the real 001.json schema).
    iters_dir = store.task_dir / "iterations"
    seq = [
        (1, {"ms_per_op": 2.00}),
        (2, {"ms_per_op": 1.98}),   # new best (1% better)
        (3, {"ms_per_op": 1.981}),  # noise
        (4, {"ms_per_op": 1.979}),  # noise
        (5, {"ms_per_op": 1.980}),  # noise → since best = 3
    ]
    for n, perf in seq:
        (iters_dir / f"{n:03d}.json").write_text(
            __import__("json").dumps({"iteration": n, "perf": perf}))
    ws = _FakeWorkspace(5)
    # Must read dicts from the real store, not skip them.
    assert _count_iters_since_best(store, ws) == 3
    # And the improving-only case must NOT trip rewrite.
    improving = [(i, {"ms_per_op": 2.0 - 0.1 * i}) for i in range(1, 5)]
    for n, perf in improving:
        (iters_dir / f"{n:03d}.json").write_text(
            __import__("json").dumps({"iteration": n, "perf": perf}))
    assert _count_iters_since_best(store, _FakeWorkspace(4)) == 0


# --------------------------------------------------------------------------- #
# plan_prompt injection
# --------------------------------------------------------------------------- #

def test_plan_prompt_rewrite_mode_directs_structural_change():
    p = plan_prompt(req={}, iter_dir=Path("/w"), notebooks_dir=Path("/n"),
                    iteration=5, search_mode="rewrite")
    assert "Search mode: REWRITE" in p
    assert "STRUCTURAL change" in p


def test_plan_prompt_fine_tune_mode_directs_incremental():
    p = plan_prompt(req={}, iter_dir=Path("/w"), notebooks_dir=Path("/n"),
                    iteration=2, search_mode="fine_tune")
    assert "Search mode: FINE-TUNE" in p
    assert "incremental" in p.lower()


def test_plan_prompt_omits_search_mode_when_absent():
    p = plan_prompt(req={}, iter_dir=Path("/w"), notebooks_dir=Path("/n"),
                    iteration=1)
    assert "Search mode" not in p


# --------------------------------------------------------------------------- #
# _resolve_flow_mode (Humanize-style flow selection)
# --------------------------------------------------------------------------- #
from metainfer.tasks.opt_kernel.orchestrator.pipeline import (
    FLOW_MODES,
    _resolve_flow_mode,
)


def test_flow_modes_are_the_expected_three():
    assert FLOW_MODES == ("flame_chase", "ralph_loop", "rlar")


def test_resolve_flow_mode_flame_chase_uses_plateau_logic():
    # Same as _resolve_search_mode: plateau -> rewrite.
    assert _resolve_flow_mode("flame_chase", 1, 0) == "fine_tune"
    assert _resolve_flow_mode("flame_chase", 5, PLATEAU_WINDOW) == "rewrite"
    assert _resolve_flow_mode("flame_chase", 5, PLATEAU_WINDOW - 1) == "fine_tune"


def test_resolve_flow_mode_ralph_loop_never_rewrites():
    # ralph_loop: same task round after round; no plateau-triggered rewrite.
    assert _resolve_flow_mode("ralph_loop", 1, 0) == "fine_tune"
    assert _resolve_flow_mode("ralph_loop", 9, 99) == "fine_tune"
    assert _resolve_flow_mode("RALPH_LOOP", 9, 99) == "fine_tune"  # case-insensitive


def test_resolve_flow_mode_rlar_never_rewrites():
    assert _resolve_flow_mode("rlar", 9, 99) == "fine_tune"
    assert _resolve_flow_mode("rlar", 1, 0) == "fine_tune"


def test_resolve_flow_mode_unknown_defaults_to_flame_chase():
    # Unknown / None -> safe default = flame_chase plateau logic.
    assert _resolve_flow_mode(None, 5, PLATEAU_WINDOW) == "rewrite"
    assert _resolve_flow_mode("nonsense", 5, PLATEAU_WINDOW) == "rewrite"
    assert _resolve_flow_mode("", 5, 0) == "fine_tune"


def test_plan_prompt_flow_directive_ralph_loop():
    p = plan_prompt(req={}, iter_dir=Path("/w"), notebooks_dir=Path("/n"),
                    iteration=3, search_mode="fine_tune", flow="ralph_loop")
    assert "Flow: RALPH_LOOP" in p
    assert "no plateau-triggered rewrite" in p


def test_plan_prompt_flow_directive_rlar():
    p = plan_prompt(req={}, iter_dir=Path("/w"), notebooks_dir=Path("/n"),
                    iteration=3, search_mode="fine_tune", flow="rlar")
    assert "Flow: RLAR" in p
    assert "fresh reviewer" in p


def test_plan_prompt_flow_directive_absent_for_flame_chase():
    p = plan_prompt(req={}, iter_dir=Path("/w"), notebooks_dir=Path("/n"),
                    iteration=3, search_mode="fine_tune", flow="flame_chase")
    assert "Flow:" not in p
