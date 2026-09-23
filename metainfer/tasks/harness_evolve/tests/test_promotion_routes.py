"""WebUI approval routes: the human gate in front of production DKAO."""

from __future__ import annotations

import json
from pathlib import Path

from metainfer.tasks.harness_evolve.orchestrator import promotion as promo
from metainfer.tasks.harness_evolve.server.routes import (
    _approve_with_config, _deny_with_config,
)


def _task_entry(state_dir: Path, workspace_dir: Path):
    class Entry:
        pass

    entry = Entry()
    entry.id = "promo-task"
    entry.state_dir = str(state_dir)
    entry.workspace_dir = str(workspace_dir)
    return entry


def _setup(tmp_path, monkeypatch):
    """An experiment parked on a pending promotion, plus a fake production dir."""
    state_dir = tmp_path / "state"
    workspace = tmp_path / "ws"
    state_dir.mkdir(parents=True)
    workspace.mkdir(parents=True)
    (state_dir / "requirements.json").write_text(json.dumps({
        "task_id": "promo-task",
        "answers": {"suite_yaml": "instances: []", "execution_mode": "dry-run"},
    }), encoding="utf-8")
    (state_dir / "run.json").write_text(json.dumps({"task_id": "promo-task"}),
                                        encoding="utf-8")

    snapshot = workspace / "runs" / "iteration_002" / "input" / "workspace"
    snapshot.mkdir(parents=True)
    (snapshot / "manifest.yaml").write_text("harness_name: evolved\n", encoding="utf-8")
    (snapshot / "gates.yaml").write_text("component: gates\n", encoding="utf-8")

    production = tmp_path / "production"
    production.mkdir()
    (production / "manifest.yaml").write_text("harness_name: seed\n", encoding="utf-8")
    monkeypatch.setattr(promo, "_production_dir", lambda: production)

    promo.write_pending_promotion(
        workspace, iteration=2, revision="rev-2", snapshot_dir=str(snapshot),
        performance_gate={"status": "PASS", "wins": ["a", "b", "c"],
                          "operators": ["a", "b", "c", "d"]},
        generalization_gate={"status": "PASS", "wins": ["a", "b"],
                             "operators": ["a", "b", "c", "d"]},
        results={"a": {"median_us": 1.0, "correctness_ok": True}})
    return _task_entry(state_dir, workspace), state_dir, workspace, production


def test_approve_route_publishes_and_clears_the_pending_candidate(tmp_path, monkeypatch):
    entry, state_dir, workspace, production = _setup(tmp_path, monkeypatch)

    result = _approve_with_config(entry, workspace, "ui-tester")
    assert result["ok"] is True
    assert result["version"] == "h-2"
    # pending cleared, production replaced, record written
    assert not (workspace / "pending_promotion.json").exists()
    assert "evolved" in (production / "manifest.yaml").read_text(encoding="utf-8")
    record = json.loads((workspace / "promoted_harness.json").read_text(encoding="utf-8"))
    assert record["approved_by"] == "ui-tester"
    assert Path(record["previous_backup"]).is_dir()
    # the run is finished from the shell's point of view
    run = json.loads((state_dir / "run.json").read_text(encoding="utf-8"))
    assert run["final_status"] == "promoted:h-2"


def test_deny_route_leaves_production_alone_and_clears_pending(tmp_path, monkeypatch):
    entry, state_dir, workspace, production = _setup(tmp_path, monkeypatch)

    result = _deny_with_config(entry, workspace, "not convinced")
    assert result["ok"] is True
    assert not (workspace / "pending_promotion.json").exists()
    assert not (workspace / "promoted_harness.json").exists()
    assert "seed" in (production / "manifest.yaml").read_text(encoding="utf-8")
    log = (workspace / "promotion_log.jsonl").read_text(encoding="utf-8")
    assert "denied" in log and "not convinced" in log


def test_approve_route_refuses_when_nothing_is_pending(tmp_path, monkeypatch):
    state_dir = tmp_path / "state"
    workspace = tmp_path / "ws"
    state_dir.mkdir(parents=True)
    workspace.mkdir(parents=True)
    (state_dir / "requirements.json").write_text(json.dumps({
        "task_id": "promo-task",
        "answers": {"suite_yaml": "instances: []", "execution_mode": "dry-run"},
    }), encoding="utf-8")
    monkeypatch.setattr(promo, "_production_dir", lambda: tmp_path / "nope")

    result = _approve_with_config(_task_entry(state_dir, workspace), workspace, "ui")
    assert result["ok"] is False and "no pending promotion" in result["errors"][0]
