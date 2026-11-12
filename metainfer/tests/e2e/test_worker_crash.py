"""I.3 E2E: worker crashes mid-job (no heartbeat, no result).

Verifies:
  - The inline reaper in RemoteJob surfaces the job as status=worker_dead
    within a reasonable time (not waiting for full timeout).
  - The GPU slot gets released by the reaper so a future job can use it.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

from metainfer.cluster import paths, scoreboard, sdk, worker_registry


@pytest.fixture(autouse=True)
def _scratch_root(tmp_path: Path, monkeypatch) -> Path:
    monkeypatch.setenv("METAINFER_ROOT", str(tmp_path))
    return tmp_path


def test_worker_dead_surfaces_and_slot_reaped(tmp_path: Path) -> None:
    worker_registry.register_worker(
        "w0", "ip", "h", "m",
        gpu_topology={0: {"name": "g"}},
    )
    # Register seeds an initial heartbeat. Backdate it to look stale.
    hb = paths.worker_heartbeat("w0")
    old = time.time() - 600  # 10 minutes ago — well past stale threshold
    os.utime(hb, (old, old))

    # Submit a job. Since worker is "dead", no one consumes it; the inline
    # reaper inside RemoteJob should mark it worker_dead quickly.
    job_id, result = sdk.submit_script(
        worker_node_id="w0",
        script_body="echo hi\n",
        gpu_slots=[("w0", 0)],
        timeout_s=2.0,
        acquire_deadline_s=2.0,
    )

    assert result is not None
    assert result.status == "worker_dead", \
        f"expected worker_dead, got {result.status}"
    # Slot must be released (RemoteJob's finally calls release_gpus).
    claims = [c for c in scoreboard.list_claims() if c["status"] == "held"]
    assert all(not (c["node_id"] == "w0" and c["gpu_idx"] == 0) for c in claims), \
        f"slot leaked: {claims}"
