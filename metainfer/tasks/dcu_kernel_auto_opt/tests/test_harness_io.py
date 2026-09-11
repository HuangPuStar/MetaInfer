"""Tests for orchestrator.harness_io (M1 slice 1: harness seed + reader)."""

from __future__ import annotations

import os
from pathlib import Path

import pytest
import yaml

from ..orchestrator import w8a8_pipeline
from ..orchestrator.config import ROUND_ACCEPTANCE_IMPROVEMENT_PERCENT
from ..orchestrator.harness_io import (
    default_harness_dir,
    harness_root,
    load_gates,
    load_manifest,
    plugin_dir,
    seed_workspace,
)


def test_plugin_dir_and_default_seed_exist():
    root = plugin_dir()
    assert root.name == "dcu_kernel_auto_opt"
    seed = default_harness_dir()
    assert seed.is_dir()
    assert (seed / "manifest.yaml").is_file()
    assert (seed / "gates.yaml").is_file()


def test_harness_root_defaults_to_seed(monkeypatch):
    monkeypatch.delenv("METAINFER_HARNESS_ROOT", raising=False)
    assert harness_root() == default_harness_dir().resolve()


def test_harness_root_env_override(monkeypatch, tmp_path):
    marker = tmp_path / "marker.txt"
    marker.write_text("x", encoding="utf-8")
    monkeypatch.setenv("METAINFER_HARNESS_ROOT", str(tmp_path))
    assert harness_root() == tmp_path.resolve()


def test_manifest_lists_gates_component():
    manifest = load_manifest()
    assert manifest.get("schema_version") == 1
    components = manifest.get("components", {})
    assert "gates" in components
    # gates is read at runtime now (orchestrator/gate_policy.py), so it is wired
    assert components["gates"]["wired"] is True
    assert "gate_policy" in (components["gates"].get("role") or "") or (
        "runtime" in (components["gates"].get("role") or ""))


def test_gates_seed_matches_builtin_defaults():
    """Drift guard: the seed gates.yaml must equal the built-in defaults.

    The runtime now reads gates.yaml through orchestrator/gate_policy.py (see
    tests/test_gate_policy.py); this test keeps the *seed file* honest so a
    fresh harness starts exactly where the hard-coded behaviour was.
    """
    from ..orchestrator import gate_policy as gp

    gates = load_gates().get("gates", {})
    defaults = gp.builtin_gates()
    assert gates["round_acceptance_improvement_percent"] == (
        defaults["round_acceptance_improvement_percent"])
    assert gates["shadow"]["min_improvement_percent"] == (
        defaults["shadow"]["min_improvement_percent"])
    assert gates["shadow"]["max_exclusive_percent"] == (
        defaults["shadow"]["max_exclusive_percent"])
    assert gates["plateau"]["max_regression_percent"] == (
        defaults["plateau"]["max_regression_percent"])
    assert gates["plateau"]["recent_valid_rounds"] == (
        defaults["plateau"]["recent_valid_rounds"])
    assert gates["isa_gate"]["required_valid_isa_guided_rounds"] == (
        defaults["isa_gate"]["required_valid_isa_guided_rounds"])
    assert gates["task_budget"]["default_max_iterations"] == (
        defaults["task_budget"]["default_max_iterations"])


def test_seed_manifest_marks_data_components_wired():
    manifest = load_manifest()
    components = manifest.get("components") or {}
    assert components["gates"]["wired"] is True
    assert components["planner_policy"]["wired"] is True
    assert components["planner_catalog"]["wired"] is True
    assert components["manifest"]["wired"] is True


def test_seed_workspace_copies_tree(tmp_path):
    dst = seed_workspace(tmp_path / "ws")
    assert dst.is_dir()
    for name in ("manifest.yaml", "gates.yaml", "README.md"):
        assert (dst / name).is_file()
    # content equality with the seed
    with (dst / "gates.yaml").open(encoding="utf-8") as fh:
        copied = yaml.safe_load(fh)
    original = load_gates()
    assert copied == original


def test_seed_workspace_missing_root_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        seed_workspace(tmp_path / "out", root=tmp_path / "does-not-exist")
