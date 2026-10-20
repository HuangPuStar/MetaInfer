"""I.4 E2E: admin force-kill via API.

Acquires a slot, then POSTs /api/cluster/scoreboard/force-release to release
it. Verifies the slot is freed and a cancel.marker is written for the worker.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from metainfer.cluster import paths, scoreboard, worker_registry
from metainfer.server.app import create_app


@pytest.fixture(autouse=True)
def _scratch_root(tmp_path: Path, monkeypatch) -> Path:
    monkeypatch.setenv("METAINFER_ROOT", str(tmp_path))
    return tmp_path


def test_force_release_endpoint_frees_slot(tmp_path: Path) -> None:
    worker_registry.register_worker(
        "w0", "ip", "h", "m", {0: {"name": "g"}},
    )
    # Pretend an orchestrator acquired the slot for some job.
    token = scoreboard.acquire_gpus(
        [("w0", 0)], holder="orch", job_id="j1", deadline_s=5.0,
    )
    assert token is not None
    # And submitted a job (so worker has a job_dir to receive cancel.marker).
    from metainfer.cluster import mqueue
    from metainfer.cluster.queue_schema import JobSpec
    spec = JobSpec(
        job_id="j1", type="script", worker_node_id="w0",
        gpu_slots=[("w0", 0)], timeout_s=60.0,
        env={}, submitter="orch", submitted_at=0.0,
        script_body="sleep 60\n",
    )
    mqueue.submit_job(spec)

    client = TestClient(create_app())
    resp = client.post("/api/cluster/scoreboard/force-release", json={
        "node_id": "w0", "gpu_idx": 0, "reason": "admin-kill-test",
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body["was_held"] is True

    # Slot must be gone.
    # list_claims() reports every GPU (free or held); only held rows count.
    claims = [c for c in scoreboard.list_claims() if c["status"] == "held"]
    assert all(not (c["node_id"] == "w0" and c["gpu_idx"] == 0) for c in claims)

    # cancel.marker must be present in the job_dir so the worker sees it.
    assert paths.job_cancel_marker(paths.job_dir("w0", "j1")).exists()
