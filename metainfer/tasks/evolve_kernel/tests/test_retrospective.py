"""Contract for the reader behind the WebUI retrospective modal.

``static/ok-detail.js`` makes each Iteration Progress row open a modal that
fetches ``/iterations/{n}/retrospective`` (``read_retrospective``). Two things
have to hold for that to be safe to click:

* the reader must return the markdown of the iteration's ``retrospective.md``,
  together with that iteration's perf and the previous one's — the modal shows
  the prose, and the two perf maps are what make it a *retro*spective rather
  than a bare file dump; and
* when an iteration has no retro file (a failed or still-running iteration) the
  reader must still return a non-empty, informative payload instead of raising,
  so clicking any row is harmless.

The "Retro" column marker is derived from ``read_iterations``, which must carry
the row's ``retrospective_path`` through unchanged.
"""

from __future__ import annotations

import json

from metainfer.tasks.evolve_kernel.server import _state_readers as sr


def _write_iteration(state_dir, n, **fields):
    # Mirrors the writer: IterationRecord.to_dict() always drops every field on
    # disk, so fixtures pass the ones the UI reads explicitly.
    iters = state_dir / "iterations"
    iters.mkdir(parents=True, exist_ok=True)
    (iters / f"{n:03d}.json").write_text(
        json.dumps({"iteration": n, **fields}), encoding="utf-8")


def test_read_iterations_exposes_retrospective_path(tmp_path):
    _write_iteration(tmp_path, 1, status="success",
                     retrospective_path="/tmp/retro_001.md")
    _write_iteration(tmp_path, 2, status="success", perf={"exec_time_ms": 0.12})

    rows = sr.read_iterations(tmp_path)

    assert [r["iteration"] for r in rows] == [1, 2]
    # Marker column: iteration 1 has a retro, iteration 2 does not.
    assert rows[0]["retrospective_path"] == "/tmp/retro_001.md"
    assert rows[1].get("retrospective_path") is None


def test_read_retrospective_reads_markdown_and_perf_delta(tmp_path):
    retro = tmp_path / "retro_002.md"
    retro.write_text("# Iteration 2\n\nDouble-buffering won.", encoding="utf-8")
    _write_iteration(tmp_path, 1, perf={"exec_time_ms": 0.20, "speedup": 1.00})
    _write_iteration(tmp_path, 2, status="success",
                     perf={"exec_time_ms": 0.12, "speedup": 1.67},
                     retrospective_path=str(retro))

    out = sr.read_retrospective(tmp_path, 2)

    assert out["has_retrospective"] is True
    assert "Double-buffering won." in out["markdown"]
    assert out["this_perf"]["speedup"] == 1.67
    assert out["prev_perf"]["speedup"] == 1.00
    assert out["iteration"] == 2


def test_read_retrospective_placeholder_when_no_file(tmp_path):
    # A failed iteration never writes a retro file; the modal must still have
    # something to show rather than an empty body or an error.
    _write_iteration(tmp_path, 1, status="failed", failure_reason="harness crashed")

    out = sr.read_retrospective(tmp_path, 1)

    assert out["has_retrospective"] is False
    assert out["markdown"]
    assert out["iteration"] == 1


def test_read_retrospective_missing_iteration(tmp_path):
    out = sr.read_retrospective(tmp_path, 7)

    assert out["has_retrospective"] is False
    assert out["markdown"]
    assert out["iteration"] == 7
