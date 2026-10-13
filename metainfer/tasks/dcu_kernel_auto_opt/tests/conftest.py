"""Shared fixtures for dcu-kernel-auto-opt plugin route tests."""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from metainfer.testing import isolated_env  # noqa: F401 — re-export as fixture
from metainfer.server import app as app_module
from metainfer.server import tasks as _tasks
from metainfer.server.tasks import TaskEntry

from ..orchestrator import skill_store


@pytest.fixture
def app(isolated_env):
    return app_module.create_app()


@pytest.fixture
def client(app):
    return TestClient(app)


@pytest.fixture(autouse=True)
def _no_measurement_gate(monkeypatch):
    """Offline tests never wait on a real device.

    Every timed benchmark and PMC profile now passes the admission gate
    (VRAM <= 90% and HCU == 0), which on a busy machine means a 30-minute wait
    per check. Unit tests exercise command construction and parsing, not
    admission, so the gate is off unless a test turns it back on (see
    ``test_gpu_preflight.py``).
    """
    monkeypatch.setenv("METAINFER_GPU_PREFLIGHT", "0")
    yield


@pytest.fixture(autouse=True)
def _never_touch_the_operators_skill_library(tmp_path, monkeypatch):
    """Point the skill library at the test's tmp dir, always.

    ``GenAndOptPipeline._prepare_worktrees()`` calls ``sync_skill_libraries()``
    for real -- by design, since it has to correct a stale library *before* any
    worker is spawned -- and several tests call that method directly while
    pinning the **other** hardware profile for their baselines.  Without this
    guard those tests physically swapped the operator's ``~/.dsh/skills`` (and
    the Claude mirror) between air and liquid mid-suite, moving files in and out
    of ``~/.dsh/.metainfer-skill-libraries`` (measured 2026-10-07; see
    ``wiki-metainfer/gotchas/dkao-tests-toggle-live-skill-library.md``).

    A test that wants its own library still wins: the env vars are honoured
    first (``test_skill_store.py``), and a fixture that patches these functions
    again runs after this one (``test_skill_profile_isolation.py``).
    """
    fallback = tmp_path / "_skill_library"
    monkeypatch.setattr(
        skill_store, "dsh_skills_root",
        lambda: Path(os.environ["DSH_SKILLS_DIR"]).expanduser()
        if os.environ.get("DSH_SKILLS_DIR") else fallback / "dsh",
    )
    monkeypatch.setattr(
        skill_store, "ccb_skills_root",
        lambda: Path(os.environ["METAINFER_CLAUDE_SKILLS_DIR"]).expanduser()
        if os.environ.get("METAINFER_CLAUDE_SKILLS_DIR") else fallback / "ccb",
    )
    yield


def register_dkao_task(
    state_dir, workspace_dir, task_id: str = "dkao-1"
) -> TaskEntry:
    """Register one dcu-kernel-auto-opt task in the WebUI registry."""
    state_dir.mkdir(parents=True, exist_ok=True)
    workspace_dir.mkdir(parents=True, exist_ok=True)
    entry = TaskEntry(
        id=task_id,
        type="dcu-kernel-auto-opt",
        label="test dkao task",
        state_dir=str(state_dir),
        workspace_dir=str(workspace_dir),
        created_at=0.0,
    )
    _tasks.add_task(entry)
    return entry
