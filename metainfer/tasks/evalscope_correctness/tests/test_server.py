"""Server readers + ``GET /result`` route for evalscope-correctness."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from metainfer.testing import isolated_env  # noqa: F401

from metainfer.server import app as _app
from metainfer.server import tasks as _tasks
from metainfer.server.tasks import TaskEntry

from metainfer.tasks.evalscope_correctness.server import _state_readers as readers


@pytest.fixture
def client(isolated_env):
    return TestClient(_app.create_app())


def _register_task(state_dir, task_id="esc-1", type_="evalscope-correctness",
                   workspace_dir=None):
    state_dir.mkdir(parents=True, exist_ok=True)
    if workspace_dir is None:
        workspace_dir = state_dir
    workspace_dir.mkdir(parents=True, exist_ok=True)
    entry = TaskEntry(
        id=task_id, type=type_, label="esc", state_dir=str(state_dir),
        workspace_dir=str(workspace_dir), created_at=0.0,
    )
    _tasks.add_task(entry)
    return entry


def _seed_result(state_dir, payload):
    (state_dir / "result.json").write_text(json.dumps(payload), encoding="utf-8")


def _good_result():
    return {
        "schema_version": 1,
        "task_type": "evalscope-correctness",
        "complete": True,
        "quality": {"configured": True, "passed": True},
        "datasets": [{"dataset": "gsm8k", "complete": True, "score": 0.8}],
    }


# --------------------------------------------------------------------------- #
# Readers
# --------------------------------------------------------------------------- #

def test_read_result_none_when_missing(tmp_path):
    assert readers.read_result(tmp_path) is None


def test_read_result_returns_dict(tmp_path):
    _seed_result(tmp_path, {"complete": True})
    assert readers.read_result(tmp_path) == {"complete": True}


def test_read_result_none_when_malformed(tmp_path):
    (tmp_path / "result.json").write_text("{not json", encoding="utf-8")
    assert readers.read_result(tmp_path) is None


# --------------------------------------------------------------------------- #
# GET /result
# --------------------------------------------------------------------------- #

def test_result_404_when_not_ready(client, isolated_env):
    _register_task(isolated_env["home"] / "tasks" / "esc-1")
    assert client.get("/api/evalscope-correctness/esc-1/result").status_code == 404


def test_result_200_when_ready(client, isolated_env):
    state_dir = isolated_env["home"] / "tasks" / "esc-1"
    _register_task(state_dir)
    _seed_result(state_dir, _good_result())
    resp = client.get("/api/evalscope-correctness/esc-1/result")
    assert resp.status_code == 200
    assert resp.json()["complete"] is True
    assert resp.json()["datasets"][0]["dataset"] == "gsm8k"


def test_result_404_for_unknown_task(client, isolated_env):
    assert client.get("/api/evalscope-correctness/nope/result").status_code == 404


def test_result_409_for_wrong_task_type(client, isolated_env):
    _register_task(isolated_env["home"] / "tasks" / "gf-1", task_id="gf-1",
                   type_="gen-infer-framework")
    assert client.get("/api/evalscope-correctness/gf-1/result").status_code == 409
