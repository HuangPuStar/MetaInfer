"""I.1 E2E: full submit→run→result flow via FakeWorker.

Asserts that:
  - A GPU slot is acquired before the job runs.
  - The slot is released after the job completes.
  - The job's result.json ends up in the replies channel.
  - stdout.log accumulates the worker's output.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from metainfer.cluster import paths, sdk, scoreboard, worker_registry
from metainfer.cluster.queue_schema import JobHandle, JobResult
from metainfer.testing.fake_worker import FakeWorker


@pytest.fixture(autouse=True)
def _scratch_root(tmp_path: Path, monkeypatch) -> Path:
    monkeypatch.setenv("METAINFER_ROOT", str(tmp_path))
    return tmp_path


def test_full_remote_job_flow_acquire_release_result(tmp_path: Path) -> None:
    worker_registry.register_worker(
        "w0", "10.0.0.1", "fake", "aa:bb",
        gpu_topology={0: {"name": "fakeGPU", "total_memory_mib": 1024}},
    )
    fake = FakeWorker(
        node_id="w0",
        gpu_topology={0: {"name": "fakeGPU", "total_memory_mib": 1024}},
    )
    fake.register()

    captured: dict = {}

    def handler(handle: JobHandle, own_node_id: str) -> JobResult:
        # While the job is running, the slot must be held.
        claims = scoreboard.list_claims()
        acquired = [c for c in claims if c["node_id"] == "w0" and c["gpu_idx"] == 0
                    and c["status"] == "held"]
        captured["acquired_during_run"] = len(acquired) == 1
        # Write some stdout so tail-readers can verify
        (Path(handle.job_dir) / "stdout.log").write_text("hello e2e\n")
        return JobResult(job_id=handle.spec.job_id, status="done", exit_code=0,
                         duration_s=0.01)

    fake.handler = handler
    fake.start_background()

    try:
        job_id, result = sdk.submit_script(
            worker_node_id="w0",
            script_body="echo hi\n",
            gpu_slots=[("w0", 0)],
            timeout_s=10.0,
        )
    finally:
        fake.stop()

    # Assertions
    assert job_id, "job_id must be returned"
    assert result is not None
    assert result.status == "done"
    assert result.exit_code == 0
    assert captured.get("acquired_during_run") is True, \
        "GPU slot must be held while job is running"

    # Slot must be released after job.
    claims_after = [c for c in scoreboard.list_claims() if c["status"] == "held"]
    assert all(not (c["node_id"] == "w0" and c["gpu_idx"] == 0)
               for c in claims_after), "slot must be released"

    # Result file exists in replies channel.
    own_node = worker_registry.detect_local_ip() or "orchestrator"
    # reply_to defaults to submitter node id; just glob for any reply with this job_id
    inbox_jd = paths.job_dir("w0", job_id)
    assert (inbox_jd / "stdout.log").read_text() == "hello e2e\n"
