"""Contract for the fields the WebUI "Iteration Progress" table renders.

``static/ok-detail.js`` builds one row per iteration straight from
``read_iterations``: ``status``, ``goal``, ``duration_s``,
``kernel_library_size`` and ``perf.{exec_time_ms,speedup}``. Iterations that
never got as far as measuring (failed / still running) must still come back as
rows — the table falls back to "—" for the metrics it doesn't have — so the
reader must not require a complete record, and an iteration that was only
partially written must not take the whole list down.
"""

from __future__ import annotations

import json

from metainfer.tasks.evolve_kernel.server import _state_readers as sr


def _write_iteration(state_dir, n, **fields):
    # The writer dumps `IterationRecord.to_dict()` (== asdict), so every field is
    # always on disk — an unmeasured iteration carries `perf: {}`, not a missing
    # key. Fixtures pass the fields explicitly to mirror that shape.
    iters = state_dir / "iterations"
    iters.mkdir(parents=True, exist_ok=True)
    (iters / f"{n:03d}.json").write_text(
        json.dumps({"iteration": n, **fields}), encoding="utf-8")


def test_read_iterations_keeps_the_fields_the_table_renders(tmp_path):
    _write_iteration(tmp_path, 2, status="success", goal="wider tiles + double buffer",
                     duration_s=41.5, kernel_library_size=3,
                     perf={"exec_time_ms": 0.121, "speedup": 1.02,
                           "combined_score": 58.1})
    _write_iteration(tmp_path, 1, status="failed", duration_s=2.0,
                     failure_reason="harness crashed", perf={})

    rows = sr.read_iterations(tmp_path)
    assert [r["iteration"] for r in rows] == [1, 2]

    failed, measured = rows
    # A failed iteration is still a row; its empty `perf` leaves the metric
    # columns at "—" in the table.
    assert failed["status"] == "failed"
    assert failed["failure_reason"] == "harness crashed"
    assert failed["perf"] == {}

    assert measured["perf"]["exec_time_ms"] == 0.121
    assert measured["perf"]["speedup"] == 1.02
    assert measured["goal"] == "wider tiles + double buffer"
    assert measured["duration_s"] == 41.5
    assert measured["kernel_library_size"] == 3


def test_read_iterations_skips_an_unreadable_record(tmp_path):
    _write_iteration(tmp_path, 1, status="success", perf={"exec_time_ms": 0.2})
    (tmp_path / "iterations" / "002.json").write_text("{not json", encoding="utf-8")

    rows = sr.read_iterations(tmp_path)
    assert [r["iteration"] for r in rows] == [1]


def test_read_iterations_empty_when_no_directory(tmp_path):
    assert sr.read_iterations(tmp_path) == []
