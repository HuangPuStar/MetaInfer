"""HE experiment state recording + children-live aggregation."""

from __future__ import annotations

import json

from metainfer.server.state_reader import read_run
from metainfer.tasks.harness_evolve.orchestrator.state import (
    append_timeline,
    read_run as he_read_run,
    set_run,
)
from metainfer.tasks.harness_evolve.server.routes import _children_live


def test_set_run_roundtrips_and_matches_shell_reader(tmp_path):
    state_dir = tmp_path / "state"
    set_run(state_dir, task_id="t1", task_type="harness-evolve",
            current_phase="evaluate", current_iteration=2)
    # shell state_reader must see the same phase (run.json contract).
    assert read_run(state_dir)["current_phase"] == "evaluate"
    assert read_run(state_dir)["current_iteration"] == 2
    assert read_run(state_dir)["task_id"] == "t1"
    # our own reader agrees
    assert he_read_run(state_dir)["current_phase"] == "evaluate"


def test_set_run_finished_sets_terminal_fields(tmp_path):
    state_dir = tmp_path / "state"
    set_run(state_dir, current_phase="finished", finished=True,
            final_status="success")
    run = read_run(state_dir)
    assert run["finished"] is True
    assert run["final_status"] == "success"


def test_append_timeline_rows_are_readable(tmp_path):
    state_dir = tmp_path / "state"
    append_timeline(state_dir, "iteration_start", {"iteration": 1})
    append_timeline(state_dir, "iteration_decision", {"iteration": 1,
                                                      "verdict": "BASELINE"})
    from metainfer.tasks.harness_evolve.orchestrator.state import list_timeline
    rows = list_timeline(state_dir)
    assert [r["type"] for r in rows] == ["iteration_start",
                                         "iteration_decision"]
    assert rows[0]["payload"]["iteration"] == 1


def test_children_live_reads_each_dkao_child_run(tmp_path):
    """Each question is one DKAO child; its state/run.json drives the UI."""
    exp = tmp_path / "exp"
    child = exp / "children" / "iteration_001" / "instA" / "state"
    child2 = exp / "children" / "iteration_001" / "instB" / "state"
    set_run(child, task_type="dcu-kernel-auto-opt", current_phase="serial_validate")
    set_run(child2, task_type="dcu-kernel-auto-opt", current_phase="finished",
            finished=True, final_status="success")

    live = _children_live(exp, 1)
    assert set(live) == {"instA", "instB"}
    assert live["instA"]["current_phase"] == "serial_validate"
    assert live["instA"]["finished"] is False
    assert live["instB"]["finished"] is True
    assert live["instB"]["final_status"] == "success"


def test_children_live_missing_iteration_returns_empty(tmp_path):
    assert _children_live(tmp_path / "exp", 3) == {}


def test_children_live_shows_a_retried_question_once_at_its_newest_attempt(tmp_path):
    """One row per question, reading the attempt that ran last.

    A retry lives in its own directory (``iteration_001_a2``), so the detail
    page must not show the same question twice, and the phase it shows has to
    come from the retry — the failed attempt is history, not the current state.
    """
    exp = tmp_path / "exp"
    first = exp / "children" / "iteration_001" / "instA" / "state"
    retry = exp / "children" / "iteration_001_a2" / "instA" / "state"
    other = exp / "children" / "iteration_001_a2" / "instB" / "state"
    set_run(first, task_type="dcu-kernel-auto-opt", current_phase="prepare",
            finished=True, final_status="stopped")
    set_run(retry, task_type="dcu-kernel-auto-opt",
            current_phase="serial_validate")
    set_run(other, task_type="dcu-kernel-auto-opt", current_phase="finished",
            finished=True, final_status="success")

    live = _children_live(exp, 1)
    assert set(live) == {"instA", "instB"}, "one row per question, no duplicates"
    assert live["instA"]["current_phase"] == "serial_validate", (
        "the row must describe the retry, not the failed attempt")
    assert live["instA"]["attempt_dir"] == "iteration_001_a2"
    assert live["instA"]["child_state_dir"] == str(retry)
    # the failed attempt's evidence is still on disk for the audit
    assert (first / "run.json").is_file()
    # a different iteration has no children of its own
    assert _children_live(exp, 2) == {}
