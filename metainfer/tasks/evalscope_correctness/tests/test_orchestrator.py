"""Orchestrator lifecycle: invalid-input, preflight, resume reuse, secret."""

from __future__ import annotations

import json

import pytest

from metainfer.tasks.evalscope_correctness.orchestrator import (
    orchestrator as _orch,
)
from metainfer.tasks.evalscope_correctness.orchestrator import config as _config
from metainfer.tasks.evalscope_correctness.orchestrator import report as _report

from ._fixtures import gsm8k_report, humaneval_report, pred_row, write_attempt


def _write_requirements(state_dir, data):
    state_dir.mkdir(parents=True, exist_ok=True)
    p = state_dir / "req.json"
    p.write_text(json.dumps(data), encoding="utf-8")
    return p


def _good_req():
    return {
        "task_id": "esc-t",
        "task_type": "evalscope-correctness",
        "label": "t",
        "api_url": "http://127.0.0.1:30000/v1",
        "model": "Qwen",
        "benchmarks": ["gsm8k"],
        "gate_gsm8k": "0.7",
    }


def test_invalid_input_stops_without_running(tmp_path):
    req = _write_requirements(tmp_path, {**_good_req(), "api_url": "nope"})
    state_dir, work_dir = tmp_path / "state", tmp_path / "work"
    code = _orch.run_with_requirements(
        req, state_dir=state_dir, workspace_dir=work_dir
    )
    assert code == 2
    run = json.loads((state_dir / "run.json").read_text())
    assert run["final_status"] == "stopped"
    assert "input validation" in run["last_transition_label"]
    # pid file must be cleared (exited).
    pid = json.loads((state_dir / "orchestrator.pid").read_text())
    assert pid["pid"] is None


def test_preflight_failure_stops(tmp_path, monkeypatch):
    from metainfer.tasks.evalscope_correctness.orchestrator import runner as _runner
    monkeypatch.setattr(_runner, "preflight_for", lambda cfg: "EvalScope not installed")
    req = _write_requirements(tmp_path, _good_req())
    code = _orch.run_with_requirements(
        req, state_dir=tmp_path / "state", workspace_dir=tmp_path / "work"
    )
    assert code == 2
    run = json.loads((tmp_path / "state" / "run.json").read_text())
    assert run["final_status"] == "stopped"
    assert "preflight" in run["last_transition_label"]


def test_supervisor_reuses_complete_attempt_without_running(tmp_path, monkeypatch):
    """A dataset already complete under the fingerprint must not re-run."""
    req = _write_requirements(tmp_path, _good_req())
    cfg = _config.parse_requirements(json.loads(req.read_text()))
    fp = cfg.fingerprint()
    evalscope_root = tmp_path / "work" / "evalscope"

    # Seed a complete attempt for gsm8k under the current fingerprint.
    a1 = evalscope_root / "gsm8k" / "attempt-1"
    write_attempt(a1, "gsm8k", gsm8k_report(num=4, score=0.8),
                  [pred_row(i, "gsm8k") for i in range(4)],
                  filename_prefix="gsm8k", model_id="Qwen")
    (a1 / "attempt.json").write_text(json.dumps({
        "dataset": "gsm8k", "fingerprint": fp, "exit_code": 0,
    }), encoding="utf-8")

    def _should_not_run(*_a, **_kw):
        raise AssertionError("a complete dataset must not be re-run")

    monkeypatch.setattr(_orch._runner, "run_dataset", _should_not_run)

    code = _orch.run_with_requirements(
        req, state_dir=tmp_path / "state", workspace_dir=tmp_path / "work"
    )
    assert code == 0  # reuse is transparent → success
    result = json.loads((tmp_path / "state" / "result.json").read_text())
    assert result["complete"] is True
    assert result["datasets"][0]["dataset"] == "gsm8k"
    assert result["datasets"][0]["raw_relative"] == "evalscope/gsm8k/attempt-1"


def test_attempt_with_different_fingerprint_is_not_reused(tmp_path):
    req = _write_requirements(tmp_path, _good_req())
    cfg = _config.parse_requirements(json.loads(req.read_text()))
    fp = cfg.fingerprint()
    evalscope_root = tmp_path / "work" / "evalscope"
    a1 = evalscope_root / "gsm8k" / "attempt-1"
    write_attempt(a1, "gsm8k", gsm8k_report(num=4, score=0.8),
                  [pred_row(i, "gsm8k") for i in range(4)], filename_prefix="gsm8k")
    (a1 / "attempt.json").write_text(json.dumps({
        "dataset": "gsm8k", "fingerprint": "sha256:different", "exit_code": 0,
    }), encoding="utf-8")
    assert _orch._latest_complete_attempt(
        evalscope_root, "gsm8k", fp, None
    ) is None


def test_attempt_that_did_not_finish_cleanly_is_not_reused(tmp_path):
    req = _write_requirements(tmp_path, _good_req())
    cfg = _config.parse_requirements(json.loads(req.read_text()))
    fp = cfg.fingerprint()
    evalscope_root = tmp_path / "work" / "evalscope"
    a1 = evalscope_root / "gsm8k" / "attempt-1"
    write_attempt(a1, "gsm8k", gsm8k_report(num=4, score=0.8),
                  [pred_row(i, "gsm8k") for i in range(4)], filename_prefix="gsm8k")
    (a1 / "attempt.json").write_text(json.dumps({
        "dataset": "gsm8k", "fingerprint": fp, "exit_code": 4,  # worker failed
    }), encoding="utf-8")
    assert _orch._latest_complete_attempt(
        evalscope_root, "gsm8k", fp, None
    ) is None


def test_finalize_completeness_and_gate(tmp_path):
    """A complete-but-below-gate evaluation is still reported as complete;
    the quality gate is the independent pass/fail."""
    evalscope_root = tmp_path / "work" / "evalscope"
    work = tmp_path / "work"
    a1 = evalscope_root / "gsm8k" / "attempt-1"
    write_attempt(a1, "gsm8k", gsm8k_report(num=4, score=0.6),  # below 0.7 gate
                  [pred_row(i, "gsm8k") for i in range(4)], filename_prefix="gsm8k")
    cfg = _config.parse_requirements(_good_req())  # gate_gsm8k=0.7
    result = _orch._finalize(
        cfg=cfg,
        evalscope_root=evalscope_root,
        chosen={"gsm8k": a1},
        workspace_dir=work,
    )
    assert result["complete"] is True            # evaluation fully executed
    assert result["quality"]["configured"] is True
    assert result["quality"]["passed"] is False  # 0.6 < 0.7
    d0 = result["datasets"][0]
    assert d0["score"] == pytest.approx(0.6)
    assert d0["threshold"] == 0.7
    assert d0["threshold_met"] is False
