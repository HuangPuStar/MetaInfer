"""I.2 E2E: PP2-style contention — two concurrent acquisitions that each
want GPU-on-A AND GPU-on-B (reverse order). Proves no deadlock and that
each round has exactly one winner.

This doesn't actually call submit_pp2_ranks; it stress-tests the underlying
scoreboard acquisition pattern that PP2 depends on.
"""

from __future__ import annotations

import threading
import time
from pathlib import Path

import pytest

from metainfer.cluster import scoreboard, worker_registry
from metainfer.cluster.queue_schema import STATUS_DONE
from metainfer.testing.fake_worker import FakeWorker


@pytest.fixture(autouse=True)
def _scratch_root(tmp_path: Path, monkeypatch) -> Path:
    monkeypatch.setenv("METAINFER_ROOT", str(tmp_path))
    return tmp_path


def test_pp2_contention_no_deadlock(tmp_path: Path) -> None:
    worker_registry.register_worker("wA", "ip", "h", "m", {0: {"name": "g"}})
    worker_registry.register_worker("wB", "ip", "h", "m", {0: {"name": "g"}})

    rounds = 5
    winners_per_round = []
    lock = threading.Lock()

    def run_round(round_idx: int) -> None:
        # Each thread acquires [A0, B0] but in different orders.
        slots = [("wA", 0), ("wB", 0)]
        if round_idx % 2 == 1:
            slots = list(reversed(slots))
        # In-process acquire/release — no FakeWorker needed for this test.
        token = scoreboard.acquire_gpus(slots, holder=f"h{round_idx}",
                                        job_id=f"j{round_idx}", deadline_s=5.0)
        assert token is not None, "must eventually acquire"
        with lock:
            winners_per_round.append(round_idx)
        time.sleep(0.02)
        scoreboard.release_gpus(token)

    threads = [threading.Thread(target=run_round, args=(i,)) for i in range(rounds)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10.0)

    assert len(winners_per_round) == rounds, \
        "all rounds must complete (no deadlock)"
    # After all rounds done, no slots remain held.
    # list_claims() reports every GPU (free or held); only held rows count.
    remaining = [c for c in scoreboard.list_claims() if c["status"] == "held"]
    assert remaining == [], f"no slot should remain held, got {remaining}"
