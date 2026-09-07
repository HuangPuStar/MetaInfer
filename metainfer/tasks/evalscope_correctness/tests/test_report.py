"""Report normalization — completeness vs quality-gate semantics."""

from __future__ import annotations

import pytest

from metainfer.tasks.evalscope_correctness.orchestrator import report as _report

from ._fixtures import (
    custom_report,
    gsm8k_report,
    humaneval_report,
    pred_row,
)


def _rows(n, stop="stop", errored_at=None):
    return [pred_row(i, "gsm8k", stop=stop, error=errored_at if i == errored_at else None)
            for i in range(n)]


def test_gsm8k_accuracy_mean_selected():
    report = gsm8k_report(num=8, score=0.75)
    rows = _rows(8)
    out = _report.normalize_dataset(report, rows, dataset="gsm8k")
    assert out["complete"] is True
    assert out["primary_metric"] == "accuracy/mean"
    assert out["score"] == pytest.approx(0.75)
    assert out["num"] == 8
    assert out["requested"] == 8 and out["predicted"] == 8


def test_humaneval_picks_pass_at_k_not_metrics0():
    """metrics[0] is accuracy/mean, but the primary is pass@1 (index 1)."""
    report = humaneval_report(num=8, score=0.5)
    rows = _rows(8)
    out = _report.normalize_dataset(report, rows, dataset="humaneval")
    assert out["complete"] is True
    assert out["primary_metric"] == "accuracy/pass_at_k(k=1)"
    assert out["score"] == pytest.approx(0.5)


def test_truncation_fails_completeness():
    report = gsm8k_report(num=8, score=0.5)
    rows = _rows(8)
    rows[3] = pred_row(3, "gsm8k", stop="length")  # stop_reason length
    out = _report.normalize_dataset(report, rows, dataset="gsm8k")
    assert out["complete"] is False
    assert out["truncated"] == 1
    assert any("truncated" in r for r in out["reasons"])


def test_model_error_fails_completeness():
    report = gsm8k_report(num=8, score=0.5)
    rows = _rows(8, errored_at=2)
    rows[2]["model_output"]["error"] = "rate limited"
    out = _report.normalize_dataset(report, rows, dataset="gsm8k")
    assert out["complete"] is False
    assert out["errored"] == 1


def test_parse_failures_count_as_malformed():
    report = gsm8k_report(num=8, score=0.5)
    rows = _rows(8)
    out = _report.normalize_dataset(report, rows, dataset="gsm8k", parse_failures=2)
    assert out["complete"] is False
    assert out["malformed"] == 2


def test_sample_count_mismatch_fails_completeness():
    report = gsm8k_report(num=10, score=0.5)  # requested 10
    rows = _rows(8)  # only 8 predictions
    out = _report.normalize_dataset(report, rows, dataset="gsm8k")
    assert out["complete"] is False
    assert any("sample-count mismatch" in r for r in out["reasons"])


def test_missing_metric_score_fails_completeness():
    report = gsm8k_report(num=8, score=None)
    rows = _rows(8)
    out = _report.normalize_dataset(report, rows, dataset="gsm8k")
    assert out["complete"] is False
    assert out["score"] is None
    assert any("no score" in r for r in out["reasons"])


def test_non_evalscope_report_raises():
    with pytest.raises(_report.ReportError):
        _report.normalize_dataset({"foo": 1}, [], dataset="gsm8k")


def test_schema_version_below_supported_fails():
    report = gsm8k_report()
    report["schema_version"] = 1
    out = _report.normalize_dataset(report, _rows(8), dataset="gsm8k")
    assert out["complete"] is False
    assert any("schema_version" in r for r in out["reasons"])


def test_custom_dataset_uses_metrics0_when_no_primary():
    report = custom_report("arc", num=8, score=0.6)
    rows = [pred_row(i, "arc") for i in range(8)]
    out = _report.normalize_dataset(report, rows, dataset="arc")
    assert out["complete"] is True
    assert out["primary_metric"] == "accuracy/mean"
    assert out["score"] == pytest.approx(0.6)


# --------------------------------------------------------------------------- #
# Threshold / quality-gate semantics
# --------------------------------------------------------------------------- #

def test_threshold_met_when_at_or_above():
    report = gsm8k_report(num=8, score=0.7)
    out = _report.normalize_dataset(report, _rows(8), dataset="gsm8k",
                                    threshold=0.7)
    assert out["threshold_met"] is True
    assert out["threshold"] == 0.7


def test_threshold_not_met_when_below():
    report = gsm8k_report(num=8, score=0.6)
    out = _report.normalize_dataset(report, _rows(8), dataset="gsm8k",
                                    threshold=0.7)
    assert out["threshold_met"] is False


def test_no_threshold_reports_only():
    report = gsm8k_report(num=8, score=0.6)
    out = _report.normalize_dataset(report, _rows(8), dataset="gsm8k")
    assert out["threshold"] is None
    assert out["threshold_met"] is None


def test_incomplete_dataset_with_threshold_is_not_met():
    report = gsm8k_report(num=8, score=0.6)
    rows = _rows(8)
    rows[0] = pred_row(0, "gsm8k", stop="length")
    out = _report.normalize_dataset(report, rows, dataset="gsm8k", threshold=0.5)
    # Truncated → not complete → gate must not silently "pass".
    assert out["complete"] is False
    assert out["threshold_met"] is False


def test_missing_dataset_row():
    out = _report.missing_dataset_row("gsm8k", threshold=0.7, reason="boom")
    assert out["complete"] is False
    assert out["has_report"] is False
    assert out["reasons"] == ["boom"]
    assert out["threshold"] == 0.7


def test_perf_summary_bounded():
    report = gsm8k_report()
    report["perf_metrics"] = {"summary": {
        "n_samples": 8,
        "latency": {"mean": 12.3456789, "p99": 99.999999, "min": 1.0, "max": 500.0},
        "throughput": {"avg_output_tps": 61.62},
        "usage": {"input_tokens": {"mean": 178.0}},
    }}
    out = _report.normalize_dataset(report, _rows(8), dataset="gsm8k")
    perf = out["performance"]
    # Only a bounded latency subset survives (mean/p99), rounded.
    assert set(perf["latency"].keys()) == {"mean", "p99"}
    assert perf["latency"]["mean"] == pytest.approx(12.3457)
    assert "min" not in perf["latency"]
