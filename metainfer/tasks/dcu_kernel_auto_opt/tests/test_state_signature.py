"""The detail view's cheap change detector (/state-signature).

Why this exists: the DKAO detail panel polls while a run is alive, and its two
heavy payloads are ``/summary`` (~0.6 MB) and ``/iterations`` (5.7 MB on a
finished multi-worker task: 86 ``iteration.json`` files).  Even with the server's
ETag revalidation answering 304, every poll still made the server *rebuild and
hash* those megabytes, which is what made the page feel stuck with a task open.
``/state-signature`` costs a few dozen ``stat`` calls so the panel can skip both
unless something actually moved.
"""

from __future__ import annotations

import json
import time

from .conftest import register_dkao_task


def _signature(client, task_id="dkao-1"):
    r = client.get(f"/api/dcu-kernel-auto-opt/{task_id}/state-signature")
    assert r.status_code == 200, r.text
    body = r.json()
    assert isinstance(body.get("signature"), str) and body["signature"]
    return body["signature"]


def test_signature_is_stable_and_content_addressed(client, tmp_path):
    state_dir = tmp_path / "state"
    workspace_dir = tmp_path / "workspace"
    register_dkao_task(state_dir, workspace_dir)
    (state_dir / "run.json").write_text(json.dumps({"current_phase": "explore"}))
    workers = workspace_dir / "workers" / "worker_0" / "iterations" / "001"
    workers.mkdir(parents=True)
    (workers / "iteration.json").write_text('{"iteration": 1}')

    first = _signature(client)
    assert _signature(client) == first, "signature must not depend on request time"


def test_signature_changes_when_a_watched_file_changes(client, tmp_path):
    state_dir = tmp_path / "state"
    workspace_dir = tmp_path / "workspace"
    register_dkao_task(state_dir, workspace_dir)
    run_path = state_dir / "run.json"
    run_path.write_text(json.dumps({"current_phase": "explore"}))
    before = _signature(client)

    time.sleep(0.01)  # mtime granularity
    run_path.write_text(json.dumps({"current_phase": "report"}))

    assert _signature(client) != before


def test_signature_changes_on_a_new_iteration_file(client, tmp_path):
    """A finished lane's new round must be visible to the gate."""
    state_dir = tmp_path / "state"
    workspace_dir = tmp_path / "workspace"
    register_dkao_task(state_dir, workspace_dir)
    iterations = workspace_dir / "workers" / "worker_1" / "iterations"
    (iterations / "001").mkdir(parents=True)
    (iterations / "001" / "iteration.json").write_text('{"iteration": 1}')
    before = _signature(client)

    (iterations / "002").mkdir()
    (iterations / "002" / "iteration.json").write_text('{"iteration": 2}')

    assert _signature(client) != before


def test_signature_is_tiny_and_json_serialisable(client, tmp_path):
    state_dir = tmp_path / "state"
    workspace_dir = tmp_path / "workspace"
    register_dkao_task(state_dir, workspace_dir)
    r = client.get("/api/dcu-kernel-auto-opt/dkao-1/state-signature")
    # The whole point is that this is a few bytes, not megabytes.
    assert len(r.content) < 512
