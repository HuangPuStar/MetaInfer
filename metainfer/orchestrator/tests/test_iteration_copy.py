"""Tests for IterationWorkspace copy-forward (esp. symlink handling)."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from metainfer.orchestrator.iteration import IterationWorkspace


def _ws(tmp_path: Path) -> IterationWorkspace:
    return IterationWorkspace(tmp_path / "iters", logs_root=tmp_path / "logs")


def test_open_iteration_copies_real_files(tmp_path: Path):
    ws = _ws(tmp_path)
    # seed iteration 1 with a real file
    one = ws.open_iteration(1)
    (one / "kernel.py").write_text("VALUE = 1\n", encoding="utf-8")
    # open iteration 2 — should inherit kernel.py
    two = ws.open_iteration(2)
    assert (two / "kernel.py").read_text() == "VALUE = 1\n"


def test_open_iteration_skips_symlink_to_external_tree(tmp_path: Path):
    """Regression: an agent-created symlink ``nodes -> /repo/nodes`` must
    NOT be followed when seeding the next iteration. Following it copies an
    external tree, and when that tree contains the workspace itself the
    recursion nests infinitely → OSError [Errno 36] File name too long."""
    ws = _ws(tmp_path)
    # external tree the symlink will point at (stands in for /repo/nodes)
    external = tmp_path / "external_nodes"
    external.mkdir()
    (external / "kme6").mkdir()

    one = ws.open_iteration(1)
    (one / "kernel.py").write_text("VALUE = 1\n", encoding="utf-8")
    # the agent creates a symlink pointing out of the workspace
    (one / "nodes").symlink_to(external)

    # open iteration 2 — must NOT follow the symlink, must NOT explode
    two = ws.open_iteration(2)
    assert (two / "kernel.py").read_text() == "VALUE = 1\n"
    # the symlink itself is dropped (not followed, not copied as a link)
    assert not (two / "nodes").exists()
    # and critically: no nested external tree got pulled in
    assert not (two / "nodes" / "kme6").exists()


def test_open_iteration_skips_symlink_even_when_target_is_workspace(tmp_path: Path):
    """Worst case: the symlink points at a tree that itself contains the
    workspace (the real bug: nodes -> /repo/nodes, and /repo/nodes/.../
    workspaces/<id>/001/ re-enters the workspace). Copy must terminate."""
    ws = _ws(tmp_path)
    root = tmp_path / "repo"
    (root / "nodes" / "kme6" / "workspaces").mkdir(parents=True)

    one = ws.open_iteration(1)
    (one / "kernel.py").write_text("ok\n", encoding="utf-8")
    # symlink: workspace/001/nodes -> repo/nodes  (repo/nodes contains workspaces/...)
    (one / "nodes").symlink_to(root / "nodes")
    # make the external tree re-enter the workspace to force the old infinite loop
    (root / "nodes" / "kme6" / "workspaces" / "self").symlink_to(ws.root)

    two = ws.open_iteration(2)  # must not hang / not raise
    assert (two / "kernel.py").read_text() == "ok\n"
    assert not (two / "nodes").exists()


def test_open_iteration_skips_pycache_and_completed(tmp_path: Path):
    ws = _ws(tmp_path)
    one = ws.open_iteration(1)
    (one / "kernel.py").write_text("x\n", encoding="utf-8")
    (one / "__pycache__").mkdir()
    (one / "__pycache__" / "k.pyc").write_text("y", encoding="utf-8")
    (one / ".metainfer-completed").write_text("", encoding="utf-8")
    two = ws.open_iteration(2)
    assert (two / "kernel.py").exists()
    assert not (two / "__pycache__").exists()
    assert not (two / ".metainfer-completed").exists()
