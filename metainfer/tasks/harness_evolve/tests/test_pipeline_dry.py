"""Offline tests for harness_evolve (dry-run, no GPU/LLM)."""

from __future__ import annotations

import json
from pathlib import Path

from ..orchestrator.attribution import diff_results, evaluate_changes, pass_rate
from ..orchestrator.cli import run_with_requirements
from ..orchestrator.config import load_experiment_config


def _write_requirements(tmp: Path, answers: dict, task_id: str = "he-test") -> Path:
    req = tmp / "requirements.json"
    req.write_text(json.dumps({
        "task_id": task_id,
        "answers": answers,
    }, ensure_ascii=False), encoding="utf-8")
    return req


def test_default_suite_config(tmp_path):
    req = _write_requirements(tmp_path, {"max_iterations": 1})
    cfg = load_experiment_config(req, tmp_path / "state", tmp_path / "ws")
    assert len(cfg.suite) == 2
    assert cfg.suite[0].id == "hy3_tp8_qkv_m4096_w4"


def test_pipeline_dry_run_layout(tmp_path, monkeypatch):
    monkeypatch.delenv("HARNESS_EVOLVE_FAKE_CHANGE", raising=False)
    req = _write_requirements(tmp_path, {"max_iterations": 2})
    rc = run_with_requirements(
        req, state_dir=tmp_path / "state", workspace_dir=tmp_path / "ws"
    )
    assert rc == 0
    ws = tmp_path / "ws"

    # seeded evolvable workspace from the dcu harness_default seed
    assert (ws / "workspace" / "manifest.yaml").is_file()

    i1 = ws / "runs" / "iteration_001" / "input"
    assert (i1 / "workspace" / "gates.yaml").is_file()
    assert (i1 / "benchmark" / "results.json").is_file()
    assert (i1 / "diff.json").is_file()
    assert (i1 / "analysis" / "overview.md").is_file()
    assert (ws / "best_ever.json").is_file()
    scores = (ws / "iteration_scores.jsonl").read_text().strip().splitlines()
    assert len(scores) == 2
    assert (ws / "report.md").is_file()
    # iteration 2 attributes iteration 1's (empty) manifest and emits an
    # explicit NO_SIGNAL decision. Equal performance must NOT be a reject
    # rollback; the candidate is archived while champion stays active.
    i2_root = ws / "runs" / "iteration_002"
    assert (i2_root / "input" / "change_evaluation.json").is_file()
    decision = json.loads((i2_root / "input" / "decision.json").read_text())
    assert decision["verdict"] == "NO_SIGNAL"
    assert not (i2_root / "rollback.json").exists()
    disposition = json.loads(
        (i2_root / "candidate_disposition.json").read_text()
    )
    assert disposition["action"] == "KEEP_CHAMPION_ARCHIVE_CANDIDATE"


def test_attribution_verdicts():
    results_pass = {"t1": {"passed": True}, "t2": {"passed": False}}
    results_fail = {"t1": {"passed": False}, "t2": {"passed": False}}
    diff = diff_results(results_pass, results_fail)
    assert "t1" in diff["regressed"]
    stats = pass_rate(results_pass)
    assert stats["n_pass"] == 1 and stats["n_total"] == 2

    manifest = {
        "iteration": 2,
        "changes": [{
            "id": "chg-1",
            "description": "fix t1",
            "files": ["gates.yaml"],
            "predicted_fixes": ["t1"],
            "risk_tasks": ["t2"],
        }],
    }
    ev = evaluate_changes(manifest, diff)
    entry = ev["change_evaluations"][0]
    assert entry["verdict"] == "INEFFECTIVE"  # predicted t1 regressed, t2 not realized

    # HARMFUL: a declared risk regressed while nothing predicted was fixed
    diff2 = diff_results(
        {"t1": {"passed": True}, "t2": {"passed": True}},
        {"t1": {"passed": True}, "t2": {"passed": False}},
    )
    ev2 = evaluate_changes(manifest, diff2)
    assert ev2["change_evaluations"][0]["verdict"] == "HARMFUL"
    assert ev2["unattributed_regressions"] == []


def test_code_change_defers_to_the_next_round(tmp_path, monkeypatch):
    """A harness fix must not wait for the run to end — nor apply mid-round.

    The running process already imported the old modules, so the loop stops at
    the round boundary with ``code_reload_pending:<next>``; the restart records
    its own revision and resumes there.
    """
    from ..orchestrator import pipeline as pl
    from ..orchestrator.state import loaded_harness_revision

    req = _write_requirements(tmp_path, {"max_iterations": 5})
    cfg = load_experiment_config(req, tmp_path / "state", tmp_path / "ws")

    pl.run_experiment(cfg, start_iteration=1, iterations_to_run=1)
    loaded = loaded_harness_revision(cfg.state_dir)
    assert loaded

    # someone edits the loop while the experiment is between rounds
    monkeypatch.setattr(pl, "harness_revision", lambda: "rev-changed")
    pl.run_experiment(cfg, start_iteration=2, iterations_to_run=1)

    run = json.loads((cfg.state_dir / "run.json").read_text(encoding="utf-8"))
    assert run["final_status"] == "code_reload_pending:3"
    assert pl.completed_iterations(cfg.exp_dir) == 2      # both rounds are real
    events = [json.loads(l) for l in
              (cfg.state_dir / "timeline.jsonl").read_text(
                  encoding="utf-8").splitlines() if l.strip()]
    deferred = [e for e in events if e["type"] == "code_reload_deferred"]
    assert deferred and deferred[-1]["payload"]["resumes_at_iteration"] == 3
    assert deferred[-1]["payload"]["on_disk_revision"] == "rev-changed"

    # the restarted process records its own revision and keeps going
    monkeypatch.undo()
    pl.run_experiment(cfg, start_iteration=3, iterations_to_run=1)
    assert pl.completed_iterations(cfg.exp_dir) == 3
    run = json.loads((cfg.state_dir / "run.json").read_text(encoding="utf-8"))
    assert not str(run.get("final_status") or "").startswith("code_reload")
