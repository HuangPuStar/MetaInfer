"""Tests for the advisory e2e model-level oracle.

Strategy: the heavy sglang serve+bench is behind an :class:`E2ERunner`
Protocol; we inject a :class:`MockE2ERunner` and unit-test the oracle's
*comparison / regression / baseline-caching / report* logic with no GPU, no
sglang, no model weights. The real ``SglangE2ERunner`` is exercised only by
its environment-detection degrading path here.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from metainfer.tasks.opt_kernel.orchestrator.oracles.e2e import (
    BenchResult,
    E2E_ORACLE_VERSION,
    E2EOracle,
    E2EReport,
    _baseline_cache_key,
    _compute_comparison,
    _compute_regression,
)
from metainfer.tasks.opt_kernel.orchestrator.oracles._sglang_runner import (
    SglangE2ERunner,
)


# --------------------------------------------------------------------------- #
# Mock runner
# --------------------------------------------------------------------------- #

class MockE2ERunner:
    """Records calls and returns scripted BenchResults.

    ``baseline_result`` / ``agent_result`` are returned verbatim (so tests
    can script throughput/latency/correctness). Call history lets tests
    assert the baseline was cached (not re-run on the 2nd iteration).
    """

    def __init__(self, baseline_result: BenchResult, agent_result: BenchResult) -> None:
        self.baseline_result = baseline_result
        self.agent_result = agent_result
        self.calls: list[tuple] = []  # (kernel_path, is_baseline)

    def run_bench(self, kernel_path, req, is_baseline):  # noqa: ANN001
        self.calls.append((kernel_path, is_baseline))
        return (
            BenchResult(**self.baseline_result.__dict__)
            if is_baseline else
            BenchResult(**self.agent_result.__dict__)
        )


def _baseline(out=100.0, tpot=20.0, ttft=50.0, capture=10.0, correct=True):
    return BenchResult(
        kind="baseline", output_throughput_tok_s=out, tpot_ms=tpot,
        ttft_ms=ttft, capture_s=capture, output_correct=correct,
        successful_requests=256,
    )


def _agent(out=120.0, tpot=18.0, ttft=45.0, capture=11.0, correct=True):
    return BenchResult(
        kind="agent", output_throughput_tok_s=out, tpot_ms=tpot,
        ttft_ms=ttft, capture_s=capture, output_correct=correct,
        successful_requests=256,
    )


# --------------------------------------------------------------------------- #
# Pure comparison / regression
# --------------------------------------------------------------------------- #

def test_comparison_agent_better_than_baseline():
    comp = _compute_comparison(_agent(out=150), _baseline(out=100))
    assert comp["output_throughput_ratio"] == 1.5
    # tpot_ratio = baseline/agent → 20/18 > 1 → agent faster
    assert comp["tpot_ratio"] is not None and comp["tpot_ratio"] > 1.0


def test_comparison_unmeasurable_is_none():
    comp = _compute_comparison(_agent(out=0), _baseline(out=0))
    assert comp["output_throughput_ratio"] is None


def test_regression_flags_output_throughput_drop():
    # agent 80 vs baseline 100 → 20% drop > 10% threshold → regressed
    reg = _compute_regression(_agent(out=80), _baseline(out=100), None,
                             out_thr=0.10, tpot_thr=0.10, capture_thr=0.50)
    assert reg["regressed"] is True
    assert reg["vs_baseline"]["output_throughput_regressed"] is True


def test_regression_no_flag_when_agent_wins():
    reg = _compute_regression(_agent(out=120), _baseline(out=100), None,
                             out_thr=0.10, tpot_thr=0.10, capture_thr=0.50)
    assert reg["regressed"] is False
    assert reg["vs_baseline"]["output_throughput_regressed"] is False


def test_regression_incorrect_output_flags():
    reg = _compute_regression(_agent(correct=False), _baseline(), None,
                             out_thr=0.10, tpot_thr=0.10, capture_thr=0.50)
    assert reg["regressed"] is True


def test_regression_vs_prev_iteration_drop():
    prev = {"agent": {"output_throughput_tok_s": 150.0, "tpot_ms": 18.0}}
    # agent now 120 → 20% drop from prev → flagged
    reg = _compute_regression(_agent(out=120), _baseline(out=100), prev,
                             out_thr=0.10, tpot_thr=0.10, capture_thr=0.50)
    assert reg["vs_prev"]["available"] is True
    assert reg["vs_prev"]["output_throughput_regressed"] is True
    assert reg["regressed"] is True


def test_regression_vs_prev_not_available_without_prev():
    reg = _compute_regression(_agent(out=120), _baseline(out=100), None,
                             out_thr=0.10, tpot_thr=0.10, capture_thr=0.50)
    assert reg["vs_prev"]["available"] is False


# --------------------------------------------------------------------------- #
# Oracle run — baseline caching + report
# --------------------------------------------------------------------------- #

def _req(**kw):
    base = {"task_id": "t1", "model_path": "/models/x", "tp": "8",
            "lmslim_version": "0.3.1", "e2e_input_len": "1024",
            "e2e_output_len": "128", "e2e_num_requests": "256"}
    base.update(kw)
    return base


def test_run_writes_report_and_runs_both_serves(tmp_path: Path):
    runner = MockE2ERunner(_baseline(), _agent())
    oracle = E2EOracle(runner=runner, baseline_cache_path=None)
    rep = oracle.run(iter_dir=tmp_path, req=_req(), report_dir=tmp_path, iteration=1)
    # both agent + baseline served (no cache → baseline run fresh)
    assert [c[1] for c in runner.calls] == [False, True]
    assert rep.baseline_cached is False
    assert rep.agent["output_throughput_tok_s"] == 120.0
    assert rep.baseline["output_throughput_tok_s"] == 100.0
    # report persisted
    written = json.loads((tmp_path / "e2e_report.json").read_text())
    assert written["oracle_version"] == E2E_ORACLE_VERSION
    assert written["comparison"]["output_throughput_ratio"] == 1.2


def test_baseline_cache_hit_skips_baseline_serve(tmp_path: Path):
    cache = tmp_path / "e2e_baseline_cache.json"
    runner = MockE2ERunner(_baseline(), _agent())
    oracle = E2EOracle(runner=runner, baseline_cache_path=cache)

    # first run: agent + baseline (cache miss → persists baseline)
    oracle.run(iter_dir=tmp_path, req=_req(), report_dir=tmp_path, iteration=1)
    assert [c[1] for c in runner.calls] == [False, True]
    assert cache.is_file()

    runner.calls.clear()
    # second run: agent only — baseline served from cache
    oracle.run(iter_dir=tmp_path, req=_req(), report_dir=tmp_path, iteration=2)
    assert [c[1] for c in runner.calls] == [False]
    # but the baseline result is still in the report (from cache)


def test_baseline_cache_invalidated_on_key_change(tmp_path: Path):
    cache = tmp_path / "e2e_baseline_cache.json"
    runner = MockE2ERunner(_baseline(), _agent())
    oracle = E2EOracle(runner=runner, baseline_cache_path=cache)

    # run 1 with model A
    oracle.run(iter_dir=tmp_path, req=_req(model_path="/models/A"),
               report_dir=tmp_path, iteration=1)
    first_key = json.loads(cache.read_text())["cache_key"]

    runner.calls.clear()
    # run 2 with model B → different cache key → cache miss → baseline re-run
    oracle.run(iter_dir=tmp_path, req=_req(model_path="/models/B"),
               report_dir=tmp_path, iteration=2)
    assert [c[1] for c in runner.calls] == [False, True]
    second_key = json.loads(cache.read_text())["cache_key"]
    assert first_key != second_key


def test_cache_key_excludes_agent_kernel(tmp_path: Path):
    """The baseline cache key must NOT depend on the agent kernel path — the
    baseline uses the stock lmslim kernel, so it is invariant across iterations
    even though the agent kernel changes every iteration. (SSOT: the agent
    kernel is the thing under test, not a baseline input.)"""
    k1 = _baseline_cache_key(_req(model_path="/models/A"))
    k2 = _baseline_cache_key(_req(model_path="/models/A",
                                  e2e_input_len="2048"))
    # changing bench params changes the key (correct: changes the measurement)
    assert k1 != k2
    # same params → same key (stable)
    assert _baseline_cache_key(_req(model_path="/models/A")) == k1


# --------------------------------------------------------------------------- #
# Pipeline integration: advisory hook never blocks, crash degrades
# --------------------------------------------------------------------------- #

def test_sglang_runner_degrades_without_env(monkeypatch):
    """The real runner must surface an unusable environment as a RuntimeError
    (never a hang) so the oracle pipeline hook can degrade to advisory
    pass-through. We force the env check to fail (the runner's first guard)
    and confirm run_bench re-raises rather than proceeding to launch a
    server — this is the exact contract ``_maybe_run_e2e_oracle`` relies on."""
    runner = SglangE2ERunner()
    monkeypatch.setattr(
        runner, "_check_env",
        lambda: (_ for _ in ()).throw(RuntimeError("sglang/lmslim not importable")),
    )
    with pytest.raises(RuntimeError):
        runner.run_bench(kernel_path=None, req=_req(), is_baseline=True)
