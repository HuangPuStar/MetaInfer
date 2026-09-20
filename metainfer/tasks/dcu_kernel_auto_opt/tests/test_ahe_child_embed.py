"""The AHE page embeds this view for one question of one iteration.

Every harness_evolve question *is* a real DKAO run, but it is spawned by the HE
orchestrator's CLI and is therefore absent from the WebUI task registry -- so
``task_or_404`` cannot resolve it and the DKAO page could not render it. The AHE
page passes the child's artifact directory instead, which these routes accept
under two conditions, both checked here:

  * the directory really is a question of a *registered* harness_evolve task
    (otherwise any path on the box could be read through these routes), and
  * it is read-only: a round's roster belongs to the orchestrator that spawned
    it, not to whoever is watching it.
"""

from __future__ import annotations

import json

from metainfer.server import tasks as _tasks
from metainfer.server.tasks import TaskEntry


def _he_task_with_child(tmp_path, *, register_owner: bool = True,
                        task_id: str = "he-embed", question: str = "m16_wqkv_a"):
    """One registered HE task with one evaluated question on disk."""
    state_dir = tmp_path / "he-state"
    workspace = tmp_path / "he-workspace"
    child_state = (workspace / "children" / "iteration_003" / question
                   / "state")
    child_ws = child_state.parent / "workspace"
    child_state.mkdir(parents=True)
    (child_ws / "workers" / "worker_1").mkdir(parents=True)
    (child_state / "requirements.json").write_text(json.dumps({
        "task_id": "ahe-it003-wqkv", "task_type": "dcu-kernel-auto-opt",
        "answers": {"shapes": []},
    }), encoding="utf-8")
    (child_state / "run.json").write_text(json.dumps({
        "task_id": "ahe-it003-wqkv", "task_type": "dcu-kernel-auto-opt",
        "current_phase": "parallel_explore", "current_iteration": 2,
        "last_update": 123.0,
    }), encoding="utf-8")
    (child_ws / "plan.json").write_text(json.dumps({
        "shapes": [{"id": "m16_wqkv_a"}], "execution_mode": "gen-and-opt",
    }), encoding="utf-8")
    (child_ws / "workers" / "worker_1" / "status.json").write_text(
        json.dumps({"worker_id": "worker_1", "gpu": 1, "state": "optimizing"}),
        encoding="utf-8")

    state_dir.mkdir(parents=True, exist_ok=True)
    if register_owner:
        _tasks.add_task(TaskEntry(
            id=task_id, type="harness-evolve", label="AHE",
            state_dir=str(state_dir), workspace_dir=str(workspace),
            created_at=0.0))
    return child_state, child_ws, workspace


def test_a_registered_he_child_is_served_through_the_dkao_routes(
        tmp_path, client):
    """The embedded view gets the same payload the standalone page gets."""
    child_state, _, _ = _he_task_with_child(tmp_path)

    resp = client.get(
        "/api/dcu-kernel-auto-opt/ignored/summary",
        params={"state_dir": str(child_state)})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["run"]["current_phase"] == "parallel_explore"
    assert body["plan"]["shapes"][0]["id"] == "m16_wqkv_a"
    assert body["workers"][0]["worker_id"] == "worker_1"
    assert body["gate"] is not None

    lanes = client.get(
        "/api/dcu-kernel-auto-opt/ignored/iterations",
        params={"state_dir": str(child_state)})
    assert lanes.status_code == 200, lanes.text
    # one lane per device, and the one this child wrote shows its real state
    by_id = {w["worker_id"]: w for w in lanes.json()["workers"]}
    assert "worker_1" in by_id
    assert by_id["worker_1"]["gpu"] == 1
    assert by_id["worker_1"]["state"] == "optimizing"


def test_the_task_id_in_the_path_is_irrelevant_for_an_embedded_child(
        tmp_path, client):
    """The AHE page keys the URL by question; only state_dir resolves it."""
    child_state, _, _ = _he_task_with_child(tmp_path)
    other = _he_task_with_child(tmp_path / "second", task_id="he-embed-2",
                                question="m16_other")
    first = client.get("/api/dcu-kernel-auto-opt/aaa/summary",
                       params={"state_dir": str(child_state)})
    second = client.get("/api/dcu-kernel-auto-opt/aaa/summary",
                        params={"state_dir": str(other[0])})
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()      # same content, different paths


def test_an_unregistered_directory_is_refused(tmp_path, client):
    """Without a registered HE owner, any path could be read: refuse it."""
    child_state, _, _ = _he_task_with_child(tmp_path, register_owner=False)
    resp = client.get("/api/dcu-kernel-auto-opt/x/summary",
                      params={"state_dir": str(child_state)})
    assert resp.status_code == 404
    assert "harness-evolve" in resp.json()["detail"]


def test_arbitrary_paths_are_refused(tmp_path, client):
    """Not a child of an iteration -> 404, even if the task exists."""
    _, _, workspace = _he_task_with_child(tmp_path)
    probes = [
        tmp_path / "he-state",                       # the HE task's own state
        workspace / "children",                      # too shallow
        workspace / "children" / "iteration_003",    # the question's parent
        workspace / "children" / "iteration_003" / "m16_wqkv_a",  # not "state"
        tmp_path / "elsewhere" / "state",            # unrelated path
    ]
    for probe in probes:
        probe.mkdir(parents=True, exist_ok=True)
        resp = client.get("/api/dcu-kernel-auto-opt/x/summary",
                          params={"state_dir": str(probe)})
        assert resp.status_code == 404, f"{probe} was accepted"


def test_without_a_state_dir_the_routes_behave_exactly_as_before(
        tmp_path, client):
    """No query parameter -> the ordinary registry lookup."""
    resp = client.get("/api/dcu-kernel-auto-opt/nope/summary")
    assert resp.status_code == 404
    assert resp.json()["detail"] == "no such task: nope"


def test_the_embedded_view_cannot_write(tmp_path, client):
    """Read-only for real: the UI hides these, the server refuses them."""
    child_state, _, _ = _he_task_with_child(tmp_path)
    writes = [
        ("post", "/workers/worker_1/guidance", {"text": "steer me"}),
        ("post", "/workers/worker_1/restart", {}),
        ("post", "/skills/some-skill/publish", {}),
        ("post", "/skills/sync", {}),
        ("post", "/skills/fuse", {"skill_name": "s"}),
        ("post", "/skills/some-skill/rollback", {}),
        ("post", "/variants", {"shape_id": "m16"}),
        ("post", "/rename-repo", {"new_name": "nope"}),
    ]
    for method, path, payload in writes:
        resp = getattr(client, method)(
            f"/api/dcu-kernel-auto-opt/ignored{path}",
            params={"state_dir": str(child_state)}, json=payload)
        assert resp.status_code == 403, f"{path} -> {resp.status_code}"
        assert "read-only" in resp.json()["detail"]


def test_reads_are_not_blocked_by_the_write_guard(tmp_path, client):
    """The guard must not leak onto GETs, or the mirror would be blank."""
    child_state, _, _ = _he_task_with_child(tmp_path)
    for path in ("/summary", "/iterations", "/state-graph", "/skills",
                 "/variants"):
        resp = client.get(f"/api/dcu-kernel-auto-opt/ignored{path}",
                          params={"state_dir": str(child_state)})
        assert resp.status_code == 200, f"{path} -> {resp.status_code}"


def test_a_registered_task_of_another_type_is_still_rejected(tmp_path, client):
    """The embed path must not become a way around the type check."""
    _he_task_with_child(tmp_path)                      # HE task exists
    other_state = tmp_path / "dkao-state"
    other_ws = tmp_path / "dkao-ws"
    other_state.mkdir(parents=True)
    other_ws.mkdir(parents=True)
    _tasks.add_task(TaskEntry(
        id="calc-1", type="calc-theoretical-value", label="calc",
        state_dir=str(other_state), workspace_dir=str(other_ws), created_at=0.0))

    resp = client.get("/api/dcu-kernel-auto-opt/calc-1/summary")
    assert resp.status_code == 409                    # wrong type, as before
