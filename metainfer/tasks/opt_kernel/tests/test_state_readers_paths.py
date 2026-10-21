"""Tests for opt-kernel state readers — regression for the 上报 (WebUI read)
path bug: _logs_dir_for / _iter_dir_for looked in the wrong place
(``workspace/iter-NNN`` / ``run.json.workspace_dir``) so reviews, the
correctness oracle report, and perf_profile were always empty in the WebUI.

Real layout (SSOT):
  state_dir/logs/<NNN>/  → review-A.md, review-B.md, review.md,
                          correctness_report.json
  workspace/<NNN>/      → perf_report.json, profile/
``workspace_dir`` lives in registry.json (``workspace_dir_for(entry)``),
NOT in run.json.
"""

from __future__ import annotations

import json
from pathlib import Path

from metainfer.tasks.opt_kernel.server import _state_readers as sr


def _seed_layout(node_root: Path, tid: str, n: int = 1) -> tuple[Path, Path]:
    """Create the documented node layout and return (state_dir, workspace_dir)."""
    state_dir = node_root / ".metainfer" / "tasks" / tid
    workspace_dir = node_root / "workspaces" / tid
    logs = state_dir / "logs" / f"{n:03d}"
    logs.mkdir(parents=True)
    (workspace_dir / f"{n:03d}").mkdir(parents=True)
    return state_dir, workspace_dir


def test_read_reviews_finds_review_files_in_state_dir_logs(tmp_path: Path):
    state_dir, _ = _seed_layout(tmp_path, "t1")
    logs = state_dir / "logs" / "001"
    (logs / "review-A.md").write_text("# A review", encoding="utf-8")
    (logs / "review-B.md").write_text("# B review", encoding="utf-8")
    (logs / "review.md").write_text("# merged", encoding="utf-8")

    r = sr.read_reviews(state_dir, 1)
    assert r["has_reviews"] is True
    assert r["review_a"] == "# A review"
    assert r["review_b"] == "# B review"
    assert r["review_merged"] == "# merged"


def test_read_reviews_includes_correctness_report(tmp_path: Path):
    """The C_test correctness oracle report must surface in the 上报 payload."""
    state_dir, _ = _seed_layout(tmp_path, "t1")
    logs = state_dir / "logs" / "001"
    (logs / "review-A.md").write_text("a", encoding="utf-8")
    (logs / "correctness_report.json").write_text(json.dumps({
        "all_correct": True, "n_pass": 10, "n_fail": 0,
    }), encoding="utf-8")

    r = sr.read_reviews(state_dir, 1)
    assert r["correctness"] is not None
    assert r["correctness"]["all_correct"] is True
    assert r["correctness"]["n_pass"] == 10


def test_read_reviews_missing_returns_empty_not_crash(tmp_path: Path):
    state_dir = tmp_path / ".metainfer" / "tasks" / "t1"
    state_dir.mkdir(parents=True)
    r = sr.read_reviews(state_dir, 5)
    assert r["has_reviews"] is False
    assert r["review_a"] is None
    assert r["correctness"] is None


def test_read_profile_finds_perf_report_in_workspace(tmp_path: Path):
    """perf_report.json lives in workspace/<NNN>/, passed via workspace_dir."""
    state_dir, workspace_dir = _seed_layout(tmp_path, "t1")
    perf = {"ms_per_op": 2.5, "gflops": 55064, "regression": {"regressed": False}}
    (workspace_dir / "001" / "perf_report.json").write_text(
        json.dumps(perf), encoding="utf-8")

    r = sr.read_profile(state_dir, 1, workspace_dir)
    assert r["has_profile"] is True
    assert r["perf_report"]["ms_per_op"] == 2.5
    assert r["perf_report"]["gflops"] == 55064


def test_read_profile_workspace_dir_from_registry_ssot(tmp_path: Path):
    """Simulate the routes path: workspace_dir comes from the registry entry
    (workspace_dir_for), not run.json. Must resolve correctly."""
    state_dir, workspace_dir = _seed_layout(tmp_path, "t1")
    (workspace_dir / "001" / "perf_report.json").write_text(
        json.dumps({"ms_per_op": 1.0}), encoding="utf-8")
    # run.json intentionally has NO workspace_dir (matches real run.json)
    (state_dir / "run.json").write_text(json.dumps({
        "task_id": "t1", "current_iteration": 1, "current_phase": "A_plan",
    }), encoding="utf-8")

    r = sr.read_profile(state_dir, 1, workspace_dir)
    assert r["has_profile"] is True


def test_read_profile_falls_back_to_derived_workspace(tmp_path: Path):
    """When no workspace_dir is supplied (defensive fallback), _iter_dir_for
    derives workspace from the documented node layout
    (nodes/<node>/workspaces/<tid> sibling of .metainfer/tasks/<tid>)."""
    # build the real node layout so the fallback derivation lands correctly
    state_dir, workspace_dir = _seed_layout(tmp_path, "t1")
    (workspace_dir / "001" / "perf_report.json").write_text(
        json.dumps({"ms_per_op": 7.7}), encoding="utf-8")

    r = sr.read_profile(state_dir, 1)  # no workspace_dir → fallback
    assert r["has_profile"] is True
    assert r["perf_report"]["ms_per_op"] == 7.7


def test_read_reviews_real_task_layout(tmp_path: Path):
    """Mirror the exact layout seen on kme6 to lock the regression:
    state_dir=nodes/kme6/.metainfer/tasks/<tid>, workspace=sibling workspaces/."""
    node = tmp_path / "nodes" / "kme6"
    state_dir, workspace_dir = _seed_layout(node, "w8a8-pitest-1788156948", n=2)
    logs = state_dir / "logs" / "002"
    (logs / "review-A.md").write_text("review A", encoding="utf-8")
    (logs / "review-B.md").write_text("review B", encoding="utf-8")
    (logs / "correctness_report.json").write_text(json.dumps({
        "all_correct": True, "n_pass": 10, "n_fail": 0,
    }), encoding="utf-8")
    (workspace_dir / "002" / "perf_report.json").write_text(json.dumps({
        "ms_per_op": 2.50, "gflops": 55063.73,
    }), encoding="utf-8")

    assert sr.read_reviews(state_dir, 2)["review_a"] == "review A"
    prof = sr.read_profile(state_dir, 2, workspace_dir)
    assert prof["perf_report"]["ms_per_op"] == 2.50
