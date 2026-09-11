"""Prove planner_policy.yaml is a live, evolvable state->plan component."""

from __future__ import annotations

import shutil
from pathlib import Path

import yaml

from ..orchestrator import planner
from ..orchestrator.harness_io import default_harness_dir


def _valid():
    return {"build_success": True, "correctness_passed": True,
            "metrics": {"graph_capture_passed": True},
            "acceptance": {"improvement_percent": 5.0}}


def test_policy_seed_loads():
    pol = planner.policy()
    assert pol["repair_priority"]["faster_wrong"] == "repair_faster_wrong"
    assert pol["bottleneck_to_plan"]["occupancy_limited"] == "occupancy_resource"


def test_workspace_policy_change_changes_selected_plan(monkeypatch, tmp_path):
    root = tmp_path / "harness"
    shutil.copytree(default_harness_dir(), root)
    policy_path = root / "planner_policy.yaml"
    data = yaml.safe_load(policy_path.read_text(encoding="utf-8"))
    # AHE-like change: route occupancy pressure to pipeline_tune instead of
    # occupancy_resource. The selector must obey the evolved workspace file.
    data["bottleneck_to_plan"]["occupancy_limited"] = "pipeline_tune"
    policy_path.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
    monkeypatch.setenv("METAINFER_HARNESS_ROOT", str(root))

    plan = planner.choose_plan_from_history(
        [_valid(), _valid()],
        pmc={"waves_per_cu": 8, "target_waves_per_cu": 16},
        iteration=4,
        max_iterations=10,
        shape={"M": 4096},
    )
    assert plan == "pipeline_tune"


def test_policy_fallback_order_is_evolvable(monkeypatch, tmp_path):
    root = tmp_path / "harness"
    shutil.copytree(default_harness_dir(), root)
    path = root / "planner_policy.yaml"
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    data["fallback"]["prefill"][0] = "occupancy_resource"
    # exercise the evolvable portfolio itself, not the no-evidence fallback
    data.setdefault("uncertainty", {})["enabled"] = False
    path.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
    monkeypatch.setenv("METAINFER_HARNESS_ROOT", str(root))

    plan = planner.choose_plan_from_history(
        [_valid(), _valid()], pmc={}, iteration=2, max_iterations=10,
        shape={"M": 4096},
    )
    assert plan == "occupancy_resource"
