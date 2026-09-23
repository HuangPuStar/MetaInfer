"""One experiment, one driver — and "finished" means finished.

The sweep in the server exists so an experiment whose supervisor died does not
sit idle forever. It got that wrong in two independent ways, and together they
produced the reported symptom ("HE opened the next round before DKAO finished"):

* it asked ``_resume_running`` whether the task was running, but a task created
  from the New Task form never writes ``resume.pid`` — only ``orchestrator.pid``
  — so a one-second-old, healthy run looked like an unsupervised corpse;
* the resume it then started computed the next iteration from
  ``completed_iterations``, which counted ``input/stage.json`` — a file written
  when a pass *starts* — so "just began" read as "already judged" and the next
  round opened on top of the running one.

Each piece is pinned here separately, because either one alone is enough to
double-drive an experiment.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from metainfer.tasks.harness_evolve.orchestrator import supervisor as sup
from metainfer.tasks.harness_evolve.orchestrator.pipeline import (
    completed_iterations,
)
from metainfer.tasks.harness_evolve.server import routes as R


# ------------------------------------------------------- pid files and liveness

def test_pid_from_file_reads_both_forms(tmp_path):
    (tmp_path / "json.pid").write_text(
        json.dumps({"pid": 4242, "task_id": "t"}), encoding="utf-8")
    (tmp_path / "bare.pid").write_text("4242\n", encoding="utf-8")
    (tmp_path / "empty.pid").write_text("", encoding="utf-8")
    (tmp_path / "junk.pid").write_text("not-a-pid", encoding="utf-8")

    assert sup.pid_from_file(tmp_path / "json.pid") == 4242
    assert sup.pid_from_file(tmp_path / "bare.pid") == 4242
    assert sup.pid_from_file(tmp_path / "empty.pid") is None
    assert sup.pid_from_file(tmp_path / "junk.pid") is None
    assert sup.pid_from_file(tmp_path / "missing.pid") is None


def test_a_runner_never_finds_itself(tmp_path):
    """The regression that made a resume stand down forever.

    In production the resume's own cmdline is
    ``python3 -m ...harness_evolve.orchestrator.cli resume --state-dir <state>``
    — which matches the ``/proc`` scan this function falls back to. Answering
    "somebody is already running this" with its own pid meant a run with no
    completed iteration could never be restarted.
    """
    state = tmp_path / "state"
    state.mkdir()
    proc_root = tmp_path / "proc"
    mine = 11111
    (proc_root / str(mine)).mkdir(parents=True)
    (proc_root / str(mine) / "cmdline").write_bytes(
        f"python3 -m metainfer.tasks.harness_evolve.orchestrator.cli resume "
        f"--state-dir {state} --workspace-dir {tmp_path / 'ws'} --iterations 1"
        .encode())

    # asking as *that* process: nobody else is running the experiment
    assert sup.task_process_alive(state, proc_root=proc_root,
                                  self_pid=mine) is None
    # asking as somebody else: yes, that process is running it
    assert sup.task_process_alive(state, proc_root=proc_root,
                                  self_pid=mine + 1) == mine
    # an explicit exclusion works too (the supervisor skipping its own child)
    assert sup.task_process_alive(state, proc_root=proc_root, self_pid=mine + 1,
                                  exclude=mine) is None


def test_a_dead_pid_file_is_not_alive(tmp_path):
    state = tmp_path / "state"
    state.mkdir()
    (state / "orchestrator.pid").write_text(
        json.dumps({"pid": 999999, "task_id": "t"}), encoding="utf-8")
    assert sup.task_process_alive(state) is None


# ------------------------------------------------------------------- the sweep

def _entry(state: Path, ws: Path, task_id: str = "t-he"):
    class Entry:
        id = task_id
        type = R.PLUGIN_TYPE
        state_dir = str(state)
        workspace_dir = str(ws)

    return Entry()


def _run_json(state: Path, *, finished: bool = False, iteration: int = 1) -> None:
    (state / "run.json").write_text(
        json.dumps({"task_id": "t-he", "task_type": "harness-evolve",
                    "current_iteration": iteration, "finished": finished}),
        encoding="utf-8")


@pytest.fixture()
def sweep_env(tmp_path, monkeypatch):
    """A janitor that would launch everything, over a task nobody runs."""
    state = tmp_path / "state"
    ws = tmp_path / "ws"
    state.mkdir()
    ws.mkdir()
    launched: list = []
    monkeypatch.setattr("metainfer.server.tasks.list_tasks",
                        lambda: [_entry(state, ws)])
    monkeypatch.setattr(R, "read_target_iterations", lambda _w: 5)
    monkeypatch.setattr(R, "_launch_supervisor",
                        lambda *a, **k: launched.append("supervisor") or {"pid": 11})
    monkeypatch.setattr(R, "_launch_resume",
                        lambda *a, **k: launched.append("resume") or {"pid": 22})
    return {"state": state, "ws": ws, "launched": launched}


def test_the_sweep_leaves_a_server_started_run_alone(sweep_env, monkeypatch):
    """The exact production shape: run alive, no resume.pid, no supervisor.pid.

    This is what a task looks like one second after the New Task form starts it
    — and the old liveness check called that "nobody is supervising".
    """
    monkeypatch.setattr(R, "_run_alive", lambda _s: 4242)
    monkeypatch.setattr(R, "_supervisor_running", lambda _w: None)
    _run_json(sweep_env["state"], finished=False, iteration=1)

    actions = R.janitor_sweep()

    assert sweep_env["launched"] == [], (
        "a live run must never get a second driver")
    assert actions and actions[0]["action"] == "skip"
    assert actions[0]["pid"] == 4242


def test_the_sweep_recovers_a_dead_run(sweep_env, monkeypatch):
    """Nothing alive and unfinished: that is the case the sweep exists for."""
    monkeypatch.setattr(R, "_run_alive", lambda _s: None)
    monkeypatch.setattr(R, "_supervisor_running", lambda _w: None)
    _run_json(sweep_env["state"], finished=False, iteration=2)

    actions = R.janitor_sweep()

    assert sweep_env["launched"] == ["supervisor", "resume"]
    assert actions[0]["action"] == "supervisor+resume"


def test_the_sweep_restarts_only_the_run_when_a_supervisor_survives(
        sweep_env, monkeypatch):
    monkeypatch.setattr(R, "_run_alive", lambda _s: None)
    monkeypatch.setattr(R, "_supervisor_running", lambda _w: 777)
    _run_json(sweep_env["state"], finished=False, iteration=2)

    actions = R.janitor_sweep()

    assert sweep_env["launched"] == ["resume"]
    assert actions[0]["action"] == "resume"


def test_the_sweep_never_restarts_a_terminal_run(sweep_env, monkeypatch):
    monkeypatch.setattr(R, "_run_alive", lambda _s: None)
    monkeypatch.setattr(R, "_supervisor_running", lambda _w: None)
    (sweep_env["state"] / "run.json").write_text(
        json.dumps({"current_iteration": 1, "finished": True,
                    "final_status": "round_incomplete"}), encoding="utf-8")

    # a run that stopped on purpose gets no action at all: no supervisor, no
    # resume, and it needs a human decision
    assert R.janitor_sweep() == []
    assert sweep_env["launched"] == []


def test_the_sweep_skips_a_task_the_operator_stopped(sweep_env, monkeypatch):
    (sweep_env["ws"] / "operator_stop.json").write_text(
        json.dumps({"stopped_at": time.time()}), encoding="utf-8")
    _run_json(sweep_env["state"], finished=False, iteration=1)

    assert R.janitor_sweep()[0]["action"] == "skip"
    assert sweep_env["launched"] == []


# --------------------------------------------------- "finished" means finished

def _pass_dir(exp: Path, iteration: int, *files: str) -> Path:
    input_dir = exp / "runs" / f"iteration_{iteration:03d}" / "input"
    input_dir.mkdir(parents=True, exist_ok=True)
    for name in files:
        path = input_dir / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{}", encoding="utf-8")
    return input_dir


def test_a_pass_that_only_started_is_not_a_completed_iteration(tmp_path):
    """``stage.json`` is written when the pass opens the round, not when it ends.

    Counting it made the resume launched by the sweep compute ``start = 2``
    while iteration 1 was still being measured — two rounds on four cards.
    """
    exp = tmp_path / "exp"
    _pass_dir(exp, 1, "stage.json")          # began, produced nothing yet

    assert completed_iterations(exp) == 0


def test_a_pass_that_produced_a_verdict_is_completed(tmp_path):
    exp = tmp_path / "exp"
    _pass_dir(exp, 1, "stage.json", "baseline_round.json")
    _pass_dir(exp, 2, "stage.json", "performance_gate.json")

    assert completed_iterations(exp) == 2

    _pass_dir(exp, 3, "stage.json")          # round 3 is under way
    assert completed_iterations(exp) == 2, (
        "an open round must not advance the counter")


def test_a_decided_pass_counts_even_without_a_gate_file(tmp_path):
    exp = tmp_path / "exp"
    _pass_dir(exp, 1, "stage.json", "decision.json")

    assert completed_iterations(exp) == 1


def test_the_generalization_retake_counts_for_its_iteration(tmp_path):
    exp = tmp_path / "exp"
    _pass_dir(exp, 2, "stage.json", "performance_gate.json")
    _pass_dir(exp, 2, "generalization_gate.json")

    assert completed_iterations(exp) == 2
