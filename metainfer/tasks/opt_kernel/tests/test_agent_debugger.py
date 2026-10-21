"""Tests for the Agent Debugger advisory step (P1, AHE experience observability).

Covers ``docs/opt_kernel_ahe.md`` §5.6:
- ``_maybe_run_debugger`` launches the debugger agent with trajectory context
  embedded in the prompt when enabled + interval matches.
- ``enabled=False`` / interval gating → no launch.
- Failure path (agent fails / raises) → ``debugger_error`` timeline, no crash.
- ``plan_prompt`` injects ``# Cross-iteration debugger evidence`` only when
  overview text is present; falls back to plain ``prev_failures`` otherwise.
- ``_read_debugger_overview`` caps length and returns None when absent.
- ``_debugger_iteration_summary`` / ``_debugger_timeline_excerpt`` render compact
  per-iteration context.

The manager is a MagicMock that records launched specs (no real agent / GPU).
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from metainfer.orchestrator.state import StateStore
from metainfer.tasks.opt_kernel.orchestrator.pipeline import (
    AgentDebuggerConfig,
    IterationContext,
    Orchestrator,
    OrchestratorConfig,
)
from metainfer.tasks.opt_kernel.orchestrator import phases as P
from metainfer.tasks.opt_kernel.orchestrator.iteration_record import IterationRecord
from metainfer.tasks.opt_kernel.orchestrator.prompts import plan_prompt


def _make_orchestrator(tmp_path: Path, **dbg_kwargs) -> Orchestrator:
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    iterations_root = tmp_path / "ws"
    cfg = OrchestratorConfig(
        workdir=state_dir, repo_root=tmp_path, notebooks_dir=tmp_path,
        iterations_root=iterations_root, state_dir=state_dir,
        logs_root=tmp_path / "logs",
        agent_debugger=AgentDebuggerConfig(**dbg_kwargs),
    )
    manager = MagicMock()
    # default: make launches appear to succeed
    manager.result.return_value = MagicMock(success=True, error=None,
                                             failure_mode=None, session_id=None)
    return Orchestrator(req={}, store=StateStore(state_dir), cfg=cfg, manager=manager)


def _seed_timeline(orch: Orchestrator, iteration: int) -> None:
    orch.store.append_timeline("phase_start", {"iteration": iteration, "phase": "A_plan"})
    orch.store.append_timeline("transition", {"iteration": iteration, "outcome": "OK"})
    orch.store.append_timeline("prediction_evaluated",
                               {"iteration": iteration, "summary": "1/1 confirmed"})


def _make_rec(n: int, perf=None) -> IterationRecord:
    rec = IterationRecord(iteration=n, started_at=1.0, start_phase="A_plan")
    rec.outcome = P.OK
    rec.status = "success"
    rec.perf = perf or {"tokens_per_sec": 1100.0, "ms_per_op": 0.9, "speedup": 1.3}
    rec.phases = {"A_plan": {"outcome": P.OK}, "E_perf_test": {"outcome": P.OK}}
    return rec


def _launched_specs(orch: Orchestrator):
    """All AgentSpecs passed to manager.launch."""
    return [c.args[0] for c in orch.manager.launch.call_args_list]


# --------------------------------------------------------------------------- #
# gating
# --------------------------------------------------------------------------- #

def test_disabled_does_not_launch(tmp_path: Path):
    orch = _make_orchestrator(tmp_path, enabled=False)
    orch._maybe_run_debugger(_make_rec(1))
    assert orch.manager.launch.call_count == 0


def test_interval_gating_skips_non_matching(tmp_path: Path):
    orch = _make_orchestrator(tmp_path, enabled=True, interval=2)
    orch._maybe_run_debugger(_make_rec(1))  # 1 % 2 != 0
    assert orch.manager.launch.call_count == 0
    orch._maybe_run_debugger(_make_rec(2))  # 2 % 2 == 0
    assert orch.manager.launch.call_count == 1


def test_interval_zero_disabled(tmp_path: Path):
    orch = _make_orchestrator(tmp_path, enabled=True, interval=0)
    orch._maybe_run_debugger(_make_rec(2))
    assert orch.manager.launch.call_count == 0


# --------------------------------------------------------------------------- #
# launch + prompt context
# --------------------------------------------------------------------------- #

def test_launches_debugger_with_trajectory_context(tmp_path: Path):
    orch = _make_orchestrator(tmp_path, enabled=True, interval=1)
    _seed_timeline(orch, 1)
    orch._maybe_run_debugger(_make_rec(1))
    assert orch.manager.launch.call_count == 1
    spec = _launched_specs(orch)[0]
    assert spec.role == "debugger"
    assert spec.name == "iter1-debugger"
    # workdir is the workspace iterations_root (so it can read sibling iters
    # and write analysis/), NOT the per-iteration dir or state_dir
    assert spec.workdir == orch.cfg.iterations_root
    prompt = spec.prompt_file.read_text()
    assert "AGENT DEBUGGER" in prompt
    assert "iteration: 1" in prompt              # iteration summary embedded
    assert "phase_start" in prompt or "transition" in prompt  # timeline excerpt
    assert "analysis/detail/iter_001.md" in prompt  # deliverable path
    assert "analysis/overview.md" in prompt


def test_prior_corpus_signaled_when_overview_exists(tmp_path: Path):
    orch = _make_orchestrator(tmp_path, enabled=True)
    (orch._analysis_dir / "detail").mkdir(parents=True)
    (orch._analysis_dir / "overview.md").write_text("# prior overview")
    (orch._analysis_dir / "detail" / "iter_001.md").write_text("prior")
    _seed_timeline(orch, 2)
    orch._maybe_run_debugger(_make_rec(2))
    prompt = _launched_specs(orch)[0].prompt_file.read_text()
    assert "prior `analysis/overview.md` already exists" in prompt
    assert "analysis/detail/iter_001.md" in prompt  # listed as prior detail


# --------------------------------------------------------------------------- #
# advisory / non-blocking
# --------------------------------------------------------------------------- #

def test_agent_failure_logs_debugger_error_no_crash(tmp_path: Path):
    orch = _make_orchestrator(tmp_path, enabled=True)
    orch.manager.result.return_value = MagicMock(success=False, error="boom",
                                                  failure_mode="infra", session_id=None)
    orch._maybe_run_debugger(_make_rec(1))
    types = [json.loads(ln)["type"] for ln in orch.store.timeline_path.read_text().splitlines() if ln.strip()]
    assert "debugger_error" in types
    assert "agent_debugger" not in types


def test_launch_exception_caught_and_logged(tmp_path: Path):
    orch = _make_orchestrator(tmp_path, enabled=True)
    orch.manager.launch.side_effect = RuntimeError("spawn died")
    orch._maybe_run_debugger(_make_rec(1))  # must not raise
    types = [json.loads(ln)["type"] for ln in orch.store.timeline_path.read_text().splitlines() if ln.strip()]
    assert "debugger_error" in types


def test_success_emits_agent_debugger_timeline(tmp_path: Path):
    orch = _make_orchestrator(tmp_path, enabled=True)
    orch._maybe_run_debugger(_make_rec(3))
    types = [json.loads(ln)["type"] for ln in orch.store.timeline_path.read_text().splitlines() if ln.strip()]
    assert "agent_debugger" in types


# --------------------------------------------------------------------------- #
# overview read + planner injection
# --------------------------------------------------------------------------- #

def test_read_debugger_overview_none_when_absent(tmp_path: Path):
    orch = _make_orchestrator(tmp_path, enabled=True)
    assert orch._read_debugger_overview() is None


def test_read_debugger_overview_caps_length(tmp_path: Path):
    orch = _make_orchestrator(tmp_path, enabled=True, overview_cap_chars=50)
    (orch._analysis_dir).mkdir(parents=True)
    (orch._analysis_dir / "overview.md").write_text("x" * 200)
    out = orch._read_debugger_overview()
    assert out is not None
    assert len(out) == 50


def test_plan_prompt_includes_debugger_overview_when_present():
    p = plan_prompt(req={}, iter_dir=Path("/w"), notebooks_dir=Path("/n"), iteration=2,
                    debugger_overview="tiling regressed correctness 2/3 times")
    assert "# Cross-iteration debugger evidence" in p
    assert "tiling regressed correctness 2/3 times" in p
    # sits before "Previous failures"
    assert p.index("# Cross-iteration debugger evidence") < p.index("# Previous failures")


def test_plan_prompt_omits_debugger_overview_when_absent():
    p = plan_prompt(req={}, iter_dir=Path("/w"), notebooks_dir=Path("/n"), iteration=1)
    assert "# Cross-iteration debugger evidence" not in p
    # prev_failures fallback still present
    assert "# Previous failures" in p


# --------------------------------------------------------------------------- #
# summary / timeline excerpt helpers
# --------------------------------------------------------------------------- #

def test_iteration_summary_includes_perf_and_status(tmp_path: Path):
    orch = _make_orchestrator(tmp_path)
    rec = _make_rec(1, perf={"tokens_per_sec": 1100.0})
    s = orch._debugger_iteration_summary(rec)
    assert "iteration: 1" in s
    assert "tokens_per_sec=1100" in s
    assert "status: success" in s


def test_timeline_excerpt_filters_to_one_iteration(tmp_path: Path):
    orch = _make_orchestrator(tmp_path)
    _seed_timeline(orch, 1)
    _seed_timeline(orch, 2)
    excerpt = orch._debugger_timeline_excerpt(1)
    assert "phase_start" in excerpt
    assert "A_plan" in excerpt
    # iteration 2 events must NOT leak into iteration 1's excerpt
    excerpt2 = orch._debugger_timeline_excerpt(2)
    assert "iteration: 1" not in excerpt2
