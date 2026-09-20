"""Shared fixtures for dcu-kernel-auto-opt plugin route tests."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from metainfer.testing import isolated_env  # noqa: F401 — re-export as fixture
from metainfer.server import app as app_module
from metainfer.server import tasks as _tasks
from metainfer.server.tasks import TaskEntry


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
