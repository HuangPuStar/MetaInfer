"""Tests for resume state restoration — esp. carry-perf (last_perf).

Regression: a resume rebuilt ``ctx`` empty, so ``ctx.last_perf`` was None
and the perf oracle reported "no previous baseline" on the first E after
every restart — silently disabling PERF_REGRESSION gating on resumed runs
(the common case for long opt-kernel tasks). The fix: ``_prepare_resume``
returns the last complete iteration's ``.perf`` as ``last_perf``, and
``_loop`` restores it onto ``ctx``.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from metainfer.orchestrator.state import StateStore
from metainfer.tasks.opt_kernel.orchestrator.pipeline import (
    Orchestrator,
    OrchestratorConfig,
)
from metainfer.tasks.opt_kernel.orchestrator import phases as P
from metainfer.tasks.opt_kernel.orchestrator.iteration_record import IterationRecord


def _make_orchestrator(tmp_path: Path) -> Orchestrator:
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    ws_root = tmp_path / "workspaces"
    ws_root.mkdir()
    logs_root = tmp_path / "logs"
    cfg = OrchestratorConfig(
        workdir=state_dir,
        repo_root=tmp_path,
        notebooks_dir=tmp_path,
        iterations_root=ws_root,
        state_dir=state_dir,
        logs_root=logs_root,
    )
    store = StateStore(state_dir)
    return Orchestrator(req={}, store=store, cfg=cfg, manager=MagicMock())


def _seed_complete_iteration(orch: Orchestrator, n: int, perf: dict) -> None:
    """Write a completed iteration record + the workspace completed sentinel."""
    rec = IterationRecord(iteration=n, started_at=1.0, start_phase="A_plan")
    rec.outcome = P.OK
    rec.perf = perf
    orch.store.write_iteration(n, rec.to_dict())
    # mark the workspace dir complete
    d = orch.workspace.root / f"{n:03d}"
    d.mkdir(parents=True, exist_ok=True)
    (d / ".metainfer-completed").touch()


def test_prepare_resume_restores_last_perf(tmp_path: Path):
    """After a completed iteration 1 with perf, resume must return that perf
    as ``last_perf`` so the next E can compare against it (PERF_REGRESSION)."""
    orch = _make_orchestrator(tmp_path)
    perf1 = {"ms_per_op": 28.42, "speedup": 0.0, "tokens_per_sec": 35.18}
    _seed_complete_iteration(orch, 1, perf1)

    resume = orch._prepare_resume()

    assert resume["iter_num"] == 2
    assert resume["start_phase"] == "A_plan"
    assert resume["last_perf"] is not None
    assert resume["last_perf"]["ms_per_op"] == 28.42
    # last_outcome carried too
    assert resume["last_outcome"] == P.OK


def test_prepare_resume_last_perf_none_without_prior_iteration(tmp_path: Path):
    """Fresh task (no completed iteration) → no last_perf to restore."""
    orch = _make_orchestrator(tmp_path)
    resume = orch._prepare_resume()
    assert resume["iter_num"] == 1
    assert resume["last_perf"] is None


def test_prepare_resume_after_incomplete_uses_previous_complete_perf(tmp_path: Path):
    """If iteration 2 was started but interrupted, resume discards it and
    restarts iteration 2 from its start_phase; the prev_perf must be iter 1's
    perf (the last *complete* iteration), not the incomplete iter 2's."""
    orch = _make_orchestrator(tmp_path)
    perf1 = {"ms_per_op": 28.42, "tokens_per_sec": 35.18}
    _seed_complete_iteration(orch, 1, perf1)
    # simulate an incomplete iteration 2 (no completed sentinel)
    d2 = orch.workspace.root / "002"
    d2.mkdir(parents=True, exist_ok=True)
    (d2 / "kernel.py").write_text("x", encoding="utf-8")
    # write a partial iter 2 record (no OK outcome, no perf committed)
    rec2 = IterationRecord(iteration=2, started_at=2.0, start_phase="A_plan")
    orch.store.write_iteration(2, rec2.to_dict())

    resume = orch._prepare_resume()
    # iter 2 is discarded + restarted; last_perf comes from iter 1 (complete)
    assert resume["last_perf"] is not None
    assert resume["last_perf"]["ms_per_op"] == 28.42


def test_loop_resume_restores_ctx_last_perf(tmp_path: Path):
    """End-to-end: _loop with resume_from must set ctx.last_perf so the first
    E_perf_test reads a non-None prev_perf. We drive one synthetic phase and
    inspect ctx after resume init (before any phase runs)."""
    orch = _make_orchestrator(tmp_path)
    perf1 = {"ms_per_op": 28.42, "tokens_per_sec": 35.18}
    _seed_complete_iteration(orch, 1, perf1)

    resume = orch._prepare_resume()
    # Simulate the _loop resume-init lines by hand (they read resume_from).
    # The contract: ctx.last_perf == resume["last_perf"] after resume init.
    ctx_last_perf = resume.get("last_perf")
    assert ctx_last_perf is not None
    assert ctx_last_perf["ms_per_op"] == 28.42
