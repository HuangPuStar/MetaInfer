"""Tests for the explicit publish gate."""

from __future__ import annotations

import json
from pathlib import Path

import yaml

from ..orchestrator.attribution import copy_tree, save_json
from ..orchestrator.publish import (
    check_publishable,
    publish_harness,
    publish_kernels,
)

_DCU_SEED = Path("/root/zth_agent/MetaInfer/metainfer/tasks/"
                 "dcu_kernel_auto_opt/harness_default")


def _fake_experiment(tmp_path, *, verdict="PROMOTE", held="PASS"):
    exp = tmp_path / "exp"
    snapshot = exp / "runs" / "iteration_002" / "input" / "workspace"
    copy_tree(_DCU_SEED, snapshot)
    save_json(exp / "best_ever.json", {
        "iteration": 2, "pass_rate": 0.9, "snapshot_dir": str(snapshot),
        "workspace_revision": "rev-2",
    })
    save_json(exp / "runs" / "iteration_002" / "input" / "decision.json", {
        "iteration": 2, "verdict": verdict, "action": "SET_CHAMPION",
        "heldout_gate": {"status": held},
    })
    return exp


def test_publish_gate_rejects_non_promotable(tmp_path):
    exp = _fake_experiment(tmp_path, verdict="REJECT")
    gate = check_publishable(exp)
    assert gate["ok"] is False
    assert any("not promotable" in e for e in gate["errors"])


def test_publish_gate_rejects_overfit(tmp_path):
    exp = _fake_experiment(tmp_path, verdict="PROMOTE", held="FAIL")
    gate = check_publishable(exp)
    assert gate["ok"] is False
    assert any("held-out" in e for e in gate["errors"])


def test_publish_harness_backs_up_and_replaces_target(tmp_path):
    exp = _fake_experiment(tmp_path)
    gate = check_publishable(exp)
    assert gate["ok"] is True and gate["verdict"] == "PROMOTE"

    target = tmp_path / "harness_default"
    copy_tree(_DCU_SEED, target)
    marker = target / "old_extra.yaml"
    marker.write_text("old: true", encoding="utf-8")

    result = publish_harness(exp, target=target)
    assert result["ok"] and result["published"]
    assert not marker.exists()  # replace semantics removed stale file
    assert (target / "planner_policy.yaml").is_file()
    backups = list(tmp_path.glob("harness_default.pre-publish-*"))
    assert len(backups) == 1
    log = (exp / "publish_log.jsonl").read_text().strip().splitlines()
    assert len(log) == 1 and "harness" in log[0]


def test_publish_kernels_updates_pool_with_backup(tmp_path):
    exp = tmp_path / "exp"
    child = exp / "children" / "iter001" / "c" / "workspace"
    child.mkdir(parents=True)
    report = {
        "status": "success",
        "config": {"shapes": [{"id": "s1"}]},
        "final_validation": {"s1": {"median_us": 30.0, "p90_us": 31.0}},
    }
    (child / "final_report.json").write_text(json.dumps(report),
                                             encoding="utf-8")
    pool_path = tmp_path / "pool.yaml"
    pool_path.write_text(yaml.safe_dump({"instances": [{
        "id": "s1", "contract": {"M": 16}, "family": "f",
        "baseline_us": 100.0, "best_known_us": 50.0, "history": [],
    }]}), encoding="utf-8")

    result = publish_kernels(exp, pool_path=pool_path)
    assert result["ok"] and result["published"]
    assert result["updated"] == ["s1"]
    data = yaml.safe_load(pool_path.read_text(encoding="utf-8"))
    assert data["instances"][0]["best_known_us"] == 30.0
    assert len(list(tmp_path.glob("pool.yaml.pre-publish-*"))) == 1
