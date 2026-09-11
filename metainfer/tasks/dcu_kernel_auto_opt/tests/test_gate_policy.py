"""gates.yaml is wired: the runtime reads it, the manifest decides if it applies."""

from __future__ import annotations

import shutil

import pytest
import yaml

from ..orchestrator import gate_policy as gp
from ..orchestrator import planner
from ..orchestrator.harness_io import default_harness_dir


@pytest.fixture(autouse=True)
def _clear_cache():
    gp.reset_cache()
    yield
    gp.reset_cache()


def _workspace(tmp_path, *, gates_wired=True, policy_wired=True):
    root = tmp_path / "harness"
    shutil.copytree(default_harness_dir(), root)
    manifest = yaml.safe_load((root / "manifest.yaml").read_text(encoding="utf-8"))
    manifest["components"]["gates"]["wired"] = gates_wired
    manifest["components"]["planner_policy"]["wired"] = policy_wired
    (root / "manifest.yaml").write_text(yaml.safe_dump(manifest, sort_keys=False),
                                        encoding="utf-8")
    return root


def _edit_gates(root, **values):
    data = yaml.safe_load((root / "gates.yaml").read_text(encoding="utf-8"))
    for key, value in values.items():
        node = data["gates"]
        parts = key.split(".")
        for part in parts[:-1]:
            node = node.setdefault(part, {})
        node[parts[-1]] = value
    (root / "gates.yaml").write_text(yaml.safe_dump(data, sort_keys=False),
                                     encoding="utf-8")


def test_seed_matches_builtin_defaults():
    """The seed file mirrors the historical constants (no surprise changes)."""
    seed = yaml.safe_load(
        (default_harness_dir() / "gates.yaml").read_text(encoding="utf-8")
    )["gates"]
    defaults = gp.builtin_gates()
    assert seed["round_acceptance_improvement_percent"] == (
        defaults["round_acceptance_improvement_percent"])
    assert seed["shadow"]["min_improvement_percent"] == (
        defaults["shadow"]["min_improvement_percent"])
    assert seed["plateau"]["max_regression_percent"] == (
        defaults["plateau"]["max_regression_percent"])
    assert seed["isa_gate"]["required_valid_isa_guided_rounds"] == (
        defaults["isa_gate"]["required_valid_isa_guided_rounds"])
    assert seed["task_budget"]["default_max_iterations"] == (
        defaults["task_budget"]["default_max_iterations"])


def test_editing_gates_changes_runtime_values(tmp_path, monkeypatch):
    root = _workspace(tmp_path)
    _edit_gates(root, **{
        "round_acceptance_improvement_percent": 2.5,
        "p90_guard": "1.05",
        "shadow.enabled": False,
        "shadow.min_improvement_percent": 0.7,
        "plateau.max_regression_percent": 3.5,
        "isa_gate.required_valid_isa_guided_rounds": 4,
        "task_budget.default_max_iterations": 6,
    })
    monkeypatch.setenv("METAINFER_HARNESS_ROOT", str(root))
    gp.reset_cache()

    assert gp.round_acceptance_improvement_percent() == 2.5
    assert gp.p90_tolerance() == 1.05
    assert gp.shadow_enabled() is False
    assert gp.shadow_min_improvement_percent() == 0.7
    assert gp.plateau_max_regression_percent() == 3.5
    assert gp.isa_required_valid_rounds() == 4
    assert gp.default_max_iterations() == 6
    # the pipeline helpers see the same values
    from ..orchestrator import w8a8_pipeline as W
    assert W._gates.round_acceptance_improvement_percent() == 2.5


def test_unwired_gates_component_is_ignored(tmp_path, monkeypatch):
    """wired:false means the file is inert — the manifest is meaningful."""
    root = _workspace(tmp_path, gates_wired=False)
    _edit_gates(root, **{"round_acceptance_improvement_percent": 9.0})
    monkeypatch.setenv("METAINFER_HARNESS_ROOT", str(root))
    gp.reset_cache()
    assert gp.round_acceptance_improvement_percent() == 1.0
    assert gp.component_wired("gates") is False


def test_unwired_planner_policy_falls_back_to_builtin(tmp_path, monkeypatch):
    root = _workspace(tmp_path, policy_wired=False)
    data = yaml.safe_load((root / "planner_policy.yaml").read_text(encoding="utf-8"))
    data["fallback"]["m16"] = ["consolidate"] * 8
    (root / "planner_policy.yaml").write_text(yaml.safe_dump(data, sort_keys=False),
                                              encoding="utf-8")
    monkeypatch.setenv("METAINFER_HARNESS_ROOT", str(root))
    effective = planner.policy()
    assert effective["fallback"]["m16"] != ["consolidate"] * 8
    assert effective["fallback"] == planner._builtin_policy()["fallback"]


def test_required_hip_rounds_rule_and_literal(tmp_path, monkeypatch):
    root = _workspace(tmp_path)
    monkeypatch.setenv("METAINFER_HARNESS_ROOT", str(root))
    gp.reset_cache()
    assert gp.required_hip_rounds(10) == 8           # documented expression
    _edit_gates(root, **{"isa_gate.required_hip_rounds_rule": 3})
    gp.reset_cache()
    assert gp.required_hip_rounds(10) == 3           # literal override


def test_p90_guard_mode_parsing(tmp_path, monkeypatch):
    root = _workspace(tmp_path)
    monkeypatch.setenv("METAINFER_HARNESS_ROOT", str(root))
    gp.reset_cache()
    assert gp.p90_guard_mode() == "no_p90_regression"
    assert gp.p90_tolerance() == 1.0
    _edit_gates(root, **{"p90_guard": "not-a-number"})
    gp.reset_cache()
    assert gp.p90_tolerance() == 1.0                 # never loosens by accident


def test_snapshot_records_what_a_run_used(tmp_path, monkeypatch):
    """Children record their effective gates so the mechanism gate can verify."""
    import json

    root = _workspace(tmp_path)
    _edit_gates(root, **{"round_acceptance_improvement_percent": 3.25})
    monkeypatch.setenv("METAINFER_HARNESS_ROOT", str(root))
    gp.reset_cache()
    state = tmp_path / "state"
    out = gp.snapshot(state)
    assert out is not None and out.is_file()
    payload = json.loads(out.read_text(encoding="utf-8"))
    assert payload["gates"]["round_acceptance_improvement_percent"] == 3.25
    assert payload["gates_wired"] is True
    assert payload["harness_root"] == str(root)


def test_snapshot_marks_unwired_gates(tmp_path, monkeypatch):
    import json

    root = _workspace(tmp_path, gates_wired=False)
    monkeypatch.setenv("METAINFER_HARNESS_ROOT", str(root))
    gp.reset_cache()
    out = gp.snapshot(tmp_path / "state2")
    payload = json.loads(out.read_text(encoding="utf-8"))
    assert payload["gates_wired"] is False
    assert payload["gates"]["round_acceptance_improvement_percent"] == 1.0
