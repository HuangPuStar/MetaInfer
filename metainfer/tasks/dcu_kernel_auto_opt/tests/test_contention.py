"""Discarding a worker round that was measured on a shared device."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

from ..orchestrator.contention import (
    discard_contaminated_round, iteration_is_contaminated, read_contention,
)


def _history(path: Path, rounds: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for i in range(1, rounds + 1):
            fh.write(json.dumps({
                "schema_version": 1, "worker_id": "worker_0", "iteration": i,
                "shape_id": "op_a", "accepted": i % 2 == 1,
                "metrics": {"median_us": 100.0 - i, "p90_us": 100.0 - i,
                            "passed": True, "mismatch_count": 0},
            }) + "\n")


def _window(path: Path, **fields) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(fields), encoding="utf-8")


def test_a_round_inside_the_window_is_discarded_and_quarantined(tmp_path):
    state = tmp_path / "state"
    history = tmp_path / "runs" / "op_a" / "experiments.jsonl"
    iteration_dir = tmp_path / "runs" / "op_a" / "iteration3"
    iteration_dir.mkdir(parents=True)
    _history(history, 3)
    now = time.time()
    frozen_from, recovered_at = now - 60, now - 30
    # the round's work happened while the device was shared
    stamp = frozen_from + 10
    os.utime(iteration_dir, (stamp, stamp))
    _window(state / "contention.json", question="op_a", gpu=0, active=True,
            frozen_from=frozen_from, recovered_at=recovered_at)

    result = discard_contaminated_round(
        experiments_path=history, iteration=3, state_dir=state,
        iteration_dir=iteration_dir)

    assert result["discarded"] is True
    assert result["rounds_removed"] == 1
    kept = [json.loads(l) for l in history.read_text().splitlines()]
    assert [r["iteration"] for r in kept] == [1, 2]      # round 3 removed
    quarantined = json.loads(Path(result["quarantined"][0]).read_text())
    assert quarantined["iteration"] == 3
    assert quarantined["metrics"]["median_us"] == 97.0   # evidence preserved
    assert quarantined["reason"] == "device_shared_during_measurement"


def test_a_round_outside_the_window_is_kept(tmp_path):
    state = tmp_path / "state"
    history = tmp_path / "runs" / "op_a" / "experiments.jsonl"
    iteration_dir = tmp_path / "runs" / "op_a" / "iteration1"
    iteration_dir.mkdir(parents=True)
    _history(history, 2)
    now = time.time()
    # the device was taken over AFTER this round finished
    _window(state / "contention.json", frozen_from=now + 30, recovered_at=None)

    result = discard_contaminated_round(
        experiments_path=history, iteration=1, state_dir=state,
        iteration_dir=iteration_dir)
    assert result["discarded"] is False
    assert len(history.read_text().splitlines()) == 2


def test_no_contention_record_means_nothing_is_discarded(tmp_path):
    history = tmp_path / "runs" / "op_a" / "experiments.jsonl"
    _history(history, 2)
    result = discard_contaminated_round(experiments_path=history, iteration=1,
                                        state_dir=tmp_path / "state")
    assert result["discarded"] is False
    assert "no contention" in result["reason"]


def test_an_open_window_contaminates_the_running_round(tmp_path):
    """Contention still active: the round that was running is not trusted."""
    window = {"frozen_from": time.time() - 10, "active": True}
    contaminated, why = iteration_is_contaminated(1, window)
    assert contaminated is True and "taken over" in why
    assert read_contention(tmp_path / "missing") == {}
