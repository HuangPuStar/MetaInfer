"""Context linkage tests for DSH trajectories."""

from __future__ import annotations

from pathlib import Path

from metainfer.server import paths
from metainfer.trajectory.links import infer_context


def test_research_lab_worktree_context() -> None:
    context = infer_context({
        "cwd": "/root/.dsh/metainfer-research-lab/worktrees/prj-9e7e3432/n-0011/subdir",
    })
    assert context is not None
    assert context["kind"] == "research-lab"
    assert context["projectId"] == "prj-9e7e3432"
    assert context["nodeId"] == "n-0011"


def test_metainfer_workspace_context(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("METAINFER_ROOT", str(tmp_path))
    monkeypatch.setenv("METAINFER_NODE_ID", "node-a")
    workspace = paths.workspaces_root() / "task-123" / "iterations" / "001"
    workspace.mkdir(parents=True, exist_ok=True)
    context = infer_context({"cwd": str(workspace)})
    assert context is not None
    assert context["kind"] == "metainfer-task"
    assert context["taskId"] == "task-123"


def test_unknown_context_is_none() -> None:
    assert infer_context({"cwd": "/tmp/unrelated"}) is None
