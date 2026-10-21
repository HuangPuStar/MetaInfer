"""HTTP route tests for the opt-kernel operator feedback channel."""

from __future__ import annotations

import json
from pathlib import Path

from metainfer.server import tasks as _tasks
from metainfer.server.tasks import TaskEntry


PLUGIN_TYPE = "opt-kernel"


def _register(state_dir: Path, task_id: str = "ok-1") -> TaskEntry:
    state_dir.mkdir(parents=True, exist_ok=True)
    entry = TaskEntry(
        id=task_id, type=PLUGIN_TYPE,
        label="ok test", state_dir=str(state_dir), created_at=0.0,
    )
    _tasks.add_task(entry)
    return entry


def test_feedback_post_and_get(client, isolated_env):
    state_dir = isolated_env["home"] / "tasks" / "ok-1"
    _register(state_dir, "ok-1")
    (state_dir / "run.json").write_text(json.dumps({
        "task_id": "ok-1", "current_iteration": 3, "current_phase": "A_plan",
    }), encoding="utf-8")

    # GET empty initially
    r = client.get("/api/opt-kernel/ok-1/feedback")
    assert r.status_code == 200
    assert r.json() == {"entries": [], "count": 0}

    # POST one opinion
    r = client.post("/api/opt-kernel/ok-1/feedback", json={"text": "优先大 batch 吞吐"})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["count"] == 1
    assert body["entry"]["text"] == "优先大 batch 吞吐"
    # iteration_at_submit read from run.json::current_iteration
    assert body["entry"]["iteration_at_submit"] == 3

    # GET reflects it
    r = client.get("/api/opt-kernel/ok-1/feedback")
    assert r.json()["count"] == 1
    assert r.json()["entries"][0]["text"] == "优先大 batch 吞吐"


def test_feedback_post_rejects_empty(client, isolated_env):
    state_dir = isolated_env["home"] / "tasks" / "ok-2"
    _register(state_dir, "ok-2")
    r = client.post("/api/opt-kernel/ok-2/feedback", json={"text": "   "})
    assert r.status_code == 400
    # nothing written
    assert not (state_dir / "user_feedback.jsonl").exists()


def test_feedback_persists_across_posts(client, isolated_env):
    state_dir = isolated_env["home"] / "tasks" / "ok-3"
    _register(state_dir, "ok-3")
    for msg in ("opinion one", "opinion two", "opinion three"):
        client.post("/api/opt-kernel/ok-3/feedback", json={"text": msg})
    r = client.get("/api/opt-kernel/ok-3/feedback")
    assert r.json()["count"] == 3
    texts = [e["text"] for e in r.json()["entries"]]
    assert texts == ["opinion one", "opinion two", "opinion three"]


def test_feedback_404_unknown_task(client, isolated_env):
    r = client.get("/api/opt-kernel/no-such/feedback")
    assert r.status_code == 404
    r = client.post("/api/opt-kernel/no-such/feedback", json={"text": "x"})
    assert r.status_code == 404


def test_feedback_written_to_ssot_file(client, isolated_env):
    """The route must persist to state_dir/user_feedback.jsonl (SSOT) so the
    orchestrator can read it at A_plan."""
    state_dir = isolated_env["home"] / "tasks" / "ok-4"
    _register(state_dir, "ok-4")
    client.post("/api/opt-kernel/ok-4/feedback", json={"text": "standing directive"})
    lines = (state_dir / "user_feedback.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1
    entry = json.loads(lines[0])
    assert entry["text"] == "standing directive"
    assert "ts" in entry and "id" in entry
