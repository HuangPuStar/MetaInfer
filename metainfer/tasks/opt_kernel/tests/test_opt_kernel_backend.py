"""Tests for opt-kernel backend additions: dual reviewer, profile oracle,
state readers, and routes."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


# --------------------------------------------------------------------------- #
# Hardware profile
# --------------------------------------------------------------------------- #

def test_hardware_profiles_load():
    from metainfer.tasks.opt_kernel.orchestrator.hardware import load_hardware_profiles
    profiles = load_hardware_profiles()
    assert "K100AI / K500SM (DCU)" in profiles
    p = profiles["K100AI / K500SM (DCU)"]
    assert p["runtime"]["target_arch"] == "gfx928"
    assert p["runtime"]["compute_units"] == 128
    assert p["runtime"]["wavefront_size"] == 64
    assert p["operators"]["gemm"]["baseline"] == "lmslim.layers.gemm.int8_utils.matmul_int8"


def test_resolve_hardware_profile():
    from metainfer.tasks.opt_kernel.orchestrator.hardware import resolve_hardware_profile
    req = {"target_hardware": "K100AI / K500SM (DCU)"}
    sel, prof = resolve_hardware_profile(req)
    assert sel == "K100AI / K500SM (DCU)"
    assert prof is not None
    assert prof["runtime"]["target_arch"] == "gfx928"


def test_resolve_hardware_profile_none():
    from metainfer.tasks.opt_kernel.orchestrator.hardware import resolve_hardware_profile
    sel, prof = resolve_hardware_profile({})
    assert sel is None
    assert prof is None


def test_profiler_key_counters():
    from metainfer.tasks.opt_kernel.orchestrator.hardware import profiler_key_counters
    req = {"target_hardware": "K100AI / K500SM (DCU)"}
    counters = profiler_key_counters(req)
    assert "SQ_BUSY_CYCLES" in counters
    assert "L2CacheHit" in counters


def test_materialize_hardware_binding(tmp_path):
    from metainfer.tasks.opt_kernel.orchestrator.hardware import materialize_hardware_binding
    req = {"target_hardware": "K100AI / K500SM (DCU)"}
    snapshot = materialize_hardware_binding(req, tmp_path)
    assert snapshot.exists()
    data = json.loads(snapshot.read_text())
    assert data["selected_hardware"] == "K100AI / K500SM (DCU)"
    assert data["profile"]["runtime"]["target_arch"] == "gfx928"


# --------------------------------------------------------------------------- #
# Perf oracle
# --------------------------------------------------------------------------- #

def test_perf_oracle_imports():
    from metainfer.tasks.opt_kernel.orchestrator.oracles import KernelPerfOracle, PerfReport
    oracle = KernelPerfOracle()
    assert oracle is not None
    report = PerfReport()
    assert report.schema_version == 2


def test_perf_oracle_resolve_gemm_shapes():
    from metainfer.tasks.opt_kernel.orchestrator.oracles.perf import KernelPerfOracle
    oracle = KernelPerfOracle()
    req = {"operator": "W8A8 GEMM", "input_shapes": "K=4096,N=4096"}
    shapes = oracle._resolve_shapes(req)
    # Should have decode (M<=32) + prefill (M=4096) shapes
    ms = [s["M"] for s in shapes]
    assert 1 in ms
    assert 32 in ms
    assert 4096 in ms
    for s in shapes:
        assert s["K"] == 4096
        assert s["N"] == 4096


def test_perf_oracle_no_kernel(tmp_path):
    """Oracle should handle missing kernel.py gracefully."""
    from metainfer.tasks.opt_kernel.orchestrator.oracles.perf import KernelPerfOracle
    oracle = KernelPerfOracle()
    req = {"operator": "W8A8 GEMM", "target_hardware": "K100AI / K500SM (DCU)"}
    report = oracle.run(
        iter_dir=tmp_path, req=req, report_dir=tmp_path / "logs",
        iteration=1, prev_perf=None, timeout_s=10,
    )
    assert report.iteration == 1
    assert "not found" in report.notes or "failed" in report.notes
    # perf_report.json should still be written
    assert (tmp_path / "perf_report.json").exists()


# --------------------------------------------------------------------------- #
# State readers
# --------------------------------------------------------------------------- #

def test_read_reviews_empty(tmp_path):
    from metainfer.tasks.opt_kernel.server._state_readers import read_reviews
    result = read_reviews(tmp_path, 1)
    assert result["iteration"] == 1
    assert result["has_reviews"] is False
    assert result["review_a"] is None
    assert result["review_b"] is None


def test_read_reviews_with_files(tmp_path):
    from metainfer.tasks.opt_kernel.server._state_readers import read_reviews
    # Real layout: review files live in <state_dir>/logs/<NNN>/ (NOT workspace).
    logs_dir = tmp_path / "logs" / "001"
    logs_dir.mkdir(parents=True)
    (logs_dir / "review-A.md").write_text("# Reviewer A\nCorrectness OK")
    (logs_dir / "review-B.md").write_text("# Reviewer B\nPerformance OK")
    (logs_dir / "review.md").write_text("Merged review")
    result = read_reviews(tmp_path, 1)
    assert result["has_reviews"] is True
    assert "Correctness OK" in result["review_a"]
    assert "Performance OK" in result["review_b"]
    assert "Merged" in result["review_merged"]


def test_read_profile_empty(tmp_path):
    from metainfer.tasks.opt_kernel.server._state_readers import read_profile
    result = read_profile(tmp_path, 1)
    assert result["iteration"] == 1
    assert result["has_profile"] is False


def test_read_ahe_empty(tmp_path):
    from metainfer.tasks.opt_kernel.server._state_readers import read_ahe
    result = read_ahe(tmp_path, tmp_path / "workspace")
    assert result["available"] is False
    assert result["overview_md"] is None
    assert result["iterations"] == []
    assert result["detail_iters"] == []


def test_read_ahe_with_artifacts(tmp_path):
    from metainfer.tasks.opt_kernel.server._state_readers import read_ahe
    workspace = tmp_path / "workspace"
    iter_dir = workspace / "001"
    iter_dir.mkdir(parents=True)
    (iter_dir / "predictions.json").write_text(json.dumps({
        "baseline_perf": {"ms_per_op": 2.0},
        "predictions": [{
            "id": "p1", "change": "raise num_stages", "target_metric": "ms_per_op",
            "direction": "decrease", "expected_delta_pct": 6.0, "reason": "latency hiding",
        }],
    }))
    (iter_dir / "change_evaluation.json").write_text(json.dumps({
        "iteration": 1,
        "baseline_perf": {"ms_per_op": 2.0},
        "actual_perf": {"ms_per_op": 1.85},
        "regression": {"regressed": False, "note": "ok"},
        "predictions": [{
            "id": "p1", "change": "raise num_stages", "target_metric": "ms_per_op",
            "direction": "decrease", "expected_delta_pct": 6.0,
            "actual_delta_pct": -7.5, "verdict": "confirmed",
        }],
        "summary": "prefill -7.5%", "verdict_text": "p1 confirmed",
    }))
    analysis = workspace / "analysis"
    (analysis / "detail").mkdir(parents=True)
    (analysis / "overview.md").write_text("# Overview\nfolded evidence")
    (analysis / "detail" / "iter_001.md").write_text("# Iter 1 detail")
    result = read_ahe(tmp_path, workspace)
    assert result["available"] is True
    assert "folded evidence" in result["overview_md"]
    assert result["detail_iters"] == [1]
    assert len(result["iterations"]) == 1
    entry = result["iterations"][0]
    assert entry["iteration"] == 1
    assert entry["has_evaluation"] is True
    assert entry["verdicts"][0]["verdict"] == "confirmed"
    assert entry["verdicts"][0]["actual_delta_pct"] == -7.5
    assert entry["actual_perf"]["ms_per_op"] == 1.85
    assert entry["regression"]["regressed"] is False
    assert entry["summary"] == "prefill -7.5%"


def test_read_ahe_predictions_only_pending(tmp_path):
    """An in-progress iteration has predictions.json but no evaluation yet —
    the reader surfaces the planner's intent without verdicts."""
    from metainfer.tasks.opt_kernel.server._state_readers import read_ahe
    workspace = tmp_path / "workspace"
    (workspace / "001").mkdir(parents=True)
    (workspace / "001" / "predictions.json").write_text(json.dumps({
        "baseline_perf": {"ms_per_op": 2.0},
        "predictions": [{
            "id": "p1", "change": "x", "target_metric": "ms_per_op",
            "direction": "decrease", "expected_delta_pct": 5.0, "reason": "r",
        }],
    }))
    result = read_ahe(tmp_path, workspace)
    entry = result["iterations"][0]
    assert entry["has_evaluation"] is False
    assert entry["has_predictions"] is True
    assert entry["verdicts"][0]["id"] == "p1"
    assert "verdict" not in entry["verdicts"][0]
    assert entry["actual_perf"] is None


def test_read_ahe_detail(tmp_path):
    from metainfer.tasks.opt_kernel.server._state_readers import read_ahe_detail
    workspace = tmp_path / "workspace"
    detail_dir = workspace / "analysis" / "detail"
    detail_dir.mkdir(parents=True)
    detail_dir.joinpath("iter_002.md").write_text("# Iter 2 root cause")
    r = read_ahe_detail(tmp_path, 2, workspace)
    assert r["has_detail"] is True
    assert "root cause" in r["markdown"]
    r2 = read_ahe_detail(tmp_path, 99, workspace)
    assert r2["has_detail"] is False
    assert r2["markdown"] == ""


def test_read_profile_with_report(tmp_path):
    from metainfer.tasks.opt_kernel.server._state_readers import read_profile
    # Real layout: perf_report.json lives in <workspace>/<NNN>/ (workspace_dir
    # is the SSOT path from registry, passed by routes via workspace_dir_for).
    workspace_dir = tmp_path / "workspace"
    iter_dir = workspace_dir / "001"
    iter_dir.mkdir(parents=True)
    report = {
        "schema_version": 2,
        "iteration": 1,
        "hardware": {"arch": "gfx928", "cu": 128},
        "primary": {"kernel_us": 100.0, "speedup": 1.5, "gflops": 8000.0},
        "results": [{"shape": {"M": 4096}, "speedup": 1.5}],
        "profile_artifacts": [
            {"kind": "kernel_stats", "collected": True, "kernels": [{"kernel": "gemm", "avg_ns": 100000}]},
            {"kind": "hip_trace", "collected": True, "path": "profile/results.json"},
        ],
    }
    (iter_dir / "perf_report.json").write_text(json.dumps(report))
    result = read_profile(tmp_path, 1, workspace_dir)
    assert result["has_profile"] is True
    assert result["perf_report"]["hardware"]["arch"] == "gfx928"
    assert result["kernel_stats"] is not None
    assert result["kernel_stats"][0]["kernel"] == "gemm"
    assert result["hip_trace_path"] == "profile/results.json"


# --------------------------------------------------------------------------- #
# Prompts
# --------------------------------------------------------------------------- #

def test_review_prompt_a_correctness_focus():
    from metainfer.tasks.opt_kernel.orchestrator.prompts import review_prompt_a
    req = {"operator": "W8A8 GEMM", "target_hardware": "K100AI / K500SM (DCU)"}
    prompt = review_prompt_a(
        req, Path("/tmp"), Path("/tmp/nb"), 1, "ok", None, {"speedup": 1.5}, Path("/tmp"),
    )
    assert "REVIEWER A (correctness)" in prompt
    assert "Numerical accuracy" in prompt
    assert "review-A.md" in prompt


def test_review_prompt_b_performance_focus():
    from metainfer.tasks.opt_kernel.orchestrator.prompts import review_prompt_b
    req = {"operator": "W8A8 GEMM", "target_hardware": "K100AI / K500SM (DCU)"}
    prompt = review_prompt_b(
        req, Path("/tmp"), Path("/tmp/nb"), 1, "ok", None, {"speedup": 1.5}, Path("/tmp"),
    )
    assert "REVIEWER B (performance)" in prompt
    assert "Throughput" in prompt
    assert "Occupancy" in prompt
    assert "review-B.md" in prompt


# --------------------------------------------------------------------------- #
# Form YAML
# --------------------------------------------------------------------------- #

def test_form_yaml_has_w8a8():
    import yaml
    form_path = Path(__file__).parent.parent / "form.yaml"
    with open(form_path) as f:
        questions = yaml.safe_load(f)
    ops = [q for q in questions if q["key"] == "operator"][0]
    labels = [o["label"] for o in ops["options"]]
    assert "W8A8 GEMM" in labels

    gemm_config = [q for q in questions if q["key"] == "gemm_config"][0]
    config_labels = [o["label"] for o in gemm_config["options"]]
    assert "CUDA Graph compatible" in config_labels
    assert "TP=4" in config_labels
    assert "TP=8" in config_labels
    assert "Decode path (M≤32)" in config_labels
    assert "Prefill path (M=4096)" in config_labels

    baseline = [q for q in questions if q["key"] == "baseline"][0]
    baseline_labels = [o["label"] for o in baseline["options"]]
    assert "lmslim matmul_int8" in baseline_labels
