"""Stopping an AHE run must be a pause, not a death.

The two are easy to confuse in this codebase: an experiment whose process is
merely gone looks *exactly* like one that crashed, and the supervisor, the
janitor sweep and ``should_launch_resume`` all exist to bring crashed runs back
automatically. So a Stop button that only kills the process would restart the
task seconds later.

These tests pin the difference: Stop brings down everything that would keep the
round moving (supervisor, DKAO children, orchestrator), records an explicit
stop that no automatic path overrules, and leaves the artifacts intact so the
resume paths can pick the run back up.
"""

from __future__ import annotations

import json
import os

from metainfer.server import tasks as _tasks
from metainfer.server.state_reader import read_run
from metainfer.server.tasks import TaskEntry

from metainfer.tasks.harness_evolve.server.routes import (
    OPERATOR_STOP_FILE,
    _operator_stopped,
    janitor_sweep,
    should_launch_resume,
)


def _he_task(tmp_path, task_id="he-stop", *, finished=False,
             final_status="", iteration=2, target=5, resume_pid=None):
    state_dir = tmp_path / "state"
    workspace = tmp_path / "ws"
    state_dir.mkdir(parents=True, exist_ok=True)
    workspace.mkdir(parents=True, exist_ok=True)
    (state_dir / "requirements.json").write_text(json.dumps({
        "task_id": task_id, "task_type": "harness-evolve",
        "answers": {"per_round_budget": 4},
    }), encoding="utf-8")
    run = {"task_id": task_id, "task_type": "harness-evolve",
           "current_phase": "evaluate", "current_iteration": iteration,
           "finished": finished, "last_update": 1.0}
    if final_status:
        run["final_status"] = final_status
    (state_dir / "run.json").write_text(json.dumps(run), encoding="utf-8")
    if target is not None:
        (workspace / "target_iterations.json").write_text(
            json.dumps({"target": target}), encoding="utf-8")
    if resume_pid is not None:
        (state_dir / "resume.pid").write_text(str(resume_pid), encoding="utf-8")
    _tasks.add_task(TaskEntry(
        id=task_id, type="harness-evolve", label="AHE",
        state_dir=str(state_dir), workspace_dir=str(workspace), created_at=0.0))
    return state_dir, workspace


def test_stop_marks_the_run_finished_and_terminal(tmp_path, client):
    """A cut-short round must not look like a finished one, and must stay put."""
    state_dir, workspace = _he_task(tmp_path)

    resp = client.post("/api/harness-evolve/he-stop/stop")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert body["iteration"] == 2

    run = read_run(state_dir)
    assert run["finished"] is True
    assert run["final_status"] == "stopped_by_operator"
    assert "Stopped by operator." in run["notes"]

    # The marker is what stops every automatic path from reviving it.
    marker = json.loads((workspace / OPERATOR_STOP_FILE).read_text())
    assert marker["iteration"] == 2
    assert marker["phase"] == "evaluate"
    assert marker["by"] == "webui"


def test_a_stopped_run_is_terminal_and_not_restarted(tmp_path, client):
    """should_launch_resume must refuse the exact state Stop produces."""
    state_dir, _ = _he_task(tmp_path)
    client.post("/api/harness-evolve/he-stop/stop")
    assert should_launch_resume(read_run(state_dir), 5, False) is False


def test_a_crashed_run_is_still_recovered(tmp_path, client):
    """The guard must not disarm crash recovery: only Stop is special."""
    state_dir, _ = _he_task(tmp_path, finished=False)
    assert should_launch_resume(read_run(state_dir), 5, False) is True


def test_the_janitor_never_restarts_a_stopped_run(tmp_path, client,
                                                 monkeypatch):
    """The sweep that exists to resurrect dead runs must respect a human."""
    _he_task(tmp_path)
    calls = []
    monkeypatch.setattr(
        "metainfer.tasks.harness_evolve.server.routes._launch_supervisor",
        lambda *a, **k: calls.append("supervisor") or {"pid": 1})
    monkeypatch.setattr(
        "metainfer.tasks.harness_evolve.server.routes._launch_resume",
        lambda *a, **k: calls.append("resume") or {"pid": 1})

    assert calls == []
    client.post("/api/harness-evolve/he-stop/stop")
    actions = janitor_sweep()
    assert calls == [], "the janitor restarted a run the operator stopped"
    assert any(a.get("action") == "skip" for a in actions), actions


def test_the_janitor_still_recovers_an_unstopped_run(tmp_path, client,
                                                     monkeypatch):
    """Sanity check on the previous test: without Stop, it does relaunch."""
    _he_task(tmp_path)
    calls = []
    monkeypatch.setattr(
        "metainfer.tasks.harness_evolve.server.routes._launch_supervisor",
        lambda *a, **k: calls.append("supervisor") or {"pid": 1})
    monkeypatch.setattr(
        "metainfer.tasks.harness_evolve.server.routes._launch_resume",
        lambda *a, **k: calls.append("resume") or {"pid": 1})
    janitor_sweep()
    assert calls == ["supervisor", "resume"]


def test_stop_clears_a_stale_resume_pid(tmp_path, client):
    """Otherwise /resume would answer "already running" about a dead process."""
    state_dir, _ = _he_task(tmp_path, resume_pid=999999)   # not our process
    resp = client.post("/api/harness-evolve/he-stop/stop")
    assert resp.status_code == 200
    assert not (state_dir / "resume.pid").exists()
    follow_up = client.post("/api/harness-evolve/he-stop/resume", json={})
    assert follow_up.status_code == 200, follow_up.text


def test_resume_clears_the_marker_so_the_run_can_continue(tmp_path, client,
                                                          monkeypatch):
    """"Restart later" has to actually work: the marker must not outlive it.

    The marker is cleared by ``_launch_resume`` itself -- the function that
    decides the run continues -- so its call is inspected at the spawn instead
    of being replaced: replacing it would assert nothing about clearing.
    """
    import subprocess

    state_dir, workspace = _he_task(tmp_path)
    client.post("/api/harness-evolve/he-stop/stop")
    assert (workspace / OPERATOR_STOP_FILE).exists()

    spawned = {}

    class _FakeProc:
        pid = 4242

    def fake_popen(cmd, *a, **k):
        spawned["cmd"] = cmd
        # The state the run is launched in: this is what the supervisor and the
        # janitor will see from the moment the process exists.
        spawned["marker_gone"] = not (workspace / OPERATOR_STOP_FILE).exists()
        return _FakeProc()

    monkeypatch.setattr(subprocess, "Popen", fake_popen)
    resp = client.post("/api/harness-evolve/he-stop/resume", json={})
    assert resp.status_code == 200, resp.text
    assert "resume" in spawned.get("cmd", []), "resume refused to relaunch"
    assert spawned["marker_gone"], \
        "the stop marker was still there when the new run was spawned"
    assert _operator_stopped(workspace) is None


def test_the_cli_resume_clears_the_marker_too(tmp_path):
    """The server is not the only way back in; the CLI path must agree."""
    from metainfer.tasks.harness_evolve.orchestrator.cli import (
        _clear_operator_stop,
    )
    workspace = tmp_path / "ws"
    workspace.mkdir()
    (workspace / OPERATOR_STOP_FILE).write_text("{}", encoding="utf-8")
    assert _clear_operator_stop(workspace) == [OPERATOR_STOP_FILE]
    assert not (workspace / OPERATOR_STOP_FILE).exists()
    assert _clear_operator_stop(workspace) == []          # idempotent


def test_summary_reports_the_stop_so_the_page_can_explain_it(tmp_path, client):
    _he_task(tmp_path)
    before = client.get("/api/harness-evolve/he-stop/summary").json()
    assert before["operator_stop"] is None
    client.post("/api/harness-evolve/he-stop/stop")
    after = client.get("/api/harness-evolve/he-stop/summary").json()
    assert after["operator_stop"]["iteration"] == 2


def test_stop_only_targets_this_task_type(tmp_path, client):
    """A DKAO task id must not reach the HE stop route."""
    _he_task(tmp_path)
    _tasks.add_task(TaskEntry(
        id="dkao-x", type="dcu-kernel-auto-opt", label="d",
        state_dir=str(tmp_path / "d"), workspace_dir=str(tmp_path / "dw"),
        created_at=0.0))
    assert client.post("/api/harness-evolve/dkao-x/stop").status_code == 409
    assert client.post("/api/harness-evolve/nope/stop").status_code == 404


def test_stop_reports_children_it_brought_down(tmp_path, client, monkeypatch):
    """Stopping must reach the DKAO children, which outlive the parent."""
    _he_task(tmp_path)
    from metainfer.tasks.harness_evolve.server import routes as r
    killed = []
    monkeypatch.setattr(r, "_live_dkao_children",
                        lambda ws: [{"pid": 111, "cmd": "child a"},
                                    {"pid": 222, "cmd": "child b"}])
    monkeypatch.setattr(r, "_terminate_pid",
                        lambda pid, **k: killed.append(pid) or True)
    body = client.post("/api/harness-evolve/he-stop/stop").json()
    assert body["stopped_children"] == [111, 222]
    # the second sweep must not re-kill what the first one already took down
    assert killed == [111, 222]
    assert body["relaunched_children"] == []


def test_stop_reaches_an_orchestrator_that_never_wrote_resume_pid(
        tmp_path, client, monkeypatch):
    """A run started from the New Task form has no ``resume.pid``.

    Stop used to look for the orchestrator through ``_resume_running``, which
    reads only that file: on such a run it found nothing, answered "stopped",
    and left the orchestrator alive -- which then re-launched the children Stop
    had just killed as an env retry. ``_run_alive`` is the wide check
    (``orchestrator.pid``, then ``resume.pid``, then a cmdline scan).
    """
    state_dir, _ = _he_task(tmp_path)          # no resume_pid on purpose
    from metainfer.tasks.harness_evolve.server import routes as r

    killed = []
    monkeypatch.setattr(r, "_live_dkao_children", lambda ws: [])
    monkeypatch.setattr(r, "_run_alive", lambda sd: 4242)
    monkeypatch.setattr(r, "_terminate_pid",
                        lambda pid, **k: killed.append(pid) or True)

    body = client.post("/api/harness-evolve/he-stop/stop").json()
    assert body["stopped_orchestrator_pid"] == 4242
    assert killed == [4242], "the orchestrator was left running"
    assert body["stopped"] is True
    # ... and a task that wrote neither pid file is still "nothing to stop"
    assert r._resume_running(state_dir) is None


def test_stop_sweeps_the_retry_wave_the_orchestrator_launched_while_dying(
        tmp_path, client, monkeypatch):
    """The env retry can land between the child sweep and the parent kill.

    That wave is a *new* child, not one of the pids already stopped, so a single
    sweep leaves it optimizing for hours while the page says "stopped".
    """
    _he_task(tmp_path)
    from metainfer.tasks.harness_evolve.server import routes as r

    waves = [[{"pid": 111, "cmd": "first wave"}],
             [{"pid": 111, "cmd": "first wave"},
              {"pid": 333, "cmd": "retry wave"}]]
    killed = []
    monkeypatch.setattr(r, "_live_dkao_children", lambda ws: waves.pop(0))
    monkeypatch.setattr(r, "_run_alive", lambda sd: 4242)
    monkeypatch.setattr(r, "_terminate_pid",
                        lambda pid, **k: killed.append(pid) or True)

    body = client.post("/api/harness-evolve/he-stop/stop").json()
    assert killed == [111, 4242, 333], killed
    assert body["stopped_children"] == [111, 333]
    assert body["relaunched_children"] == [333]


def test_a_terminate_failure_is_reported_not_hidden(tmp_path, client,
                                                    monkeypatch):
    """The operator has to know whether the process actually went away.

    A stale pid is not a live process, so this drives ``_live_dkao_children``
    instead: it is the only path that yields a pid the server will try to kill.
    """
    state_dir, _ = _he_task(tmp_path)
    from metainfer.tasks.harness_evolve.server import routes as r
    monkeypatch.setattr(r, "_live_dkao_children",
                        lambda ws: [{"pid": 111, "cmd": "child"}])
    monkeypatch.setattr(r, "_terminate_pid", lambda pid, **k: False)
    monkeypatch.setattr(r, "_run_alive", lambda sd: 999999)

    body = client.post("/api/harness-evolve/he-stop/stop").json()
    assert body["stopped"] is False
    assert body["stopped_children"] == []          # it did not go away
    assert "可再点一次" in body["message"]
    # ... and the run is still marked stopped, so nothing restarts it blindly
    assert read_run(state_dir)["final_status"] == "stopped_by_operator"


def test_terminate_pid_actually_stops_a_real_process(tmp_path):
    """The one path mocks cannot prove: does the signal really land?

    Stop is only a pause if the processes are genuinely gone -- a surviving
    DKAO child would keep its agents and its place in DKAO's admission queue
    while the UI says "stopped".
    """
    import subprocess
    import sys
    import time

    from metainfer.tasks.harness_evolve.server.routes import _terminate_pid

    # Own session, like every process the experiment spawns; the SIGTERM goes
    # to the group first, so this must not be the test runner's group.
    proc = subprocess.Popen([sys.executable, "-c",
                             "import time\nwhile True: time.sleep(1)\n"],
                            start_new_session=True)
    try:
        assert proc.poll() is None
        assert _terminate_pid(proc.pid, grace_s=5.0) is True
        deadline = time.time() + 5.0
        while proc.poll() is None and time.time() < deadline:
            time.sleep(0.1)
        assert proc.poll() is not None, "the process survived the stop"
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait(timeout=5)


def test_terminate_pid_reports_a_process_it_cannot_kill(monkeypatch):
    """A refusal must come back as False, not as a silent success."""
    from metainfer.tasks.harness_evolve.server import routes as r

    monkeypatch.setattr(r.os, "kill", lambda *a, **k: None)   # never dies
    monkeypatch.setattr(r, "_proc_state", lambda pid: "S")    # ... and runs on
    assert r._terminate_pid(12345, grace_s=0.3) is False


def test_a_zombie_counts_as_stopped():
    """Otherwise every successful stop of a non-child reports failure."""
    from metainfer.tasks.harness_evolve.server import routes as r

    assert r._proc_state(os.getpid()) in {"R", "S", "D"}
    assert r._proc_state(99999999) is None          # gone


def test_terminate_pid_treats_a_zombie_as_stopped(monkeypatch):
    from metainfer.tasks.harness_evolve.server import routes as r

    monkeypatch.setattr(r.os, "kill", lambda *a, **k: None)
    monkeypatch.setattr(r, "_proc_state", lambda pid: "Z")
    assert r._terminate_pid(12345, grace_s=0.3) is True


# ------------------------------------------------- liveness without a pid file


def test_summary_reports_a_live_run_the_shell_cannot_see(tmp_path, client,
                                                        monkeypatch):
    """Stop must appear on a run whose orchestrator.pid was never written.

    The shell's green dot reads that file; runs started before it existed are
    alive with a blue dot, and inheriting that blind spot would hide Stop on
    exactly the runs that need it.
    """
    from metainfer.tasks.harness_evolve.server import routes as r

    _he_task(tmp_path, resume_pid=4242)
    monkeypatch.setattr(r, "_resume_running", lambda sd: 4242)
    monkeypatch.setattr(r, "_supervisor_running", lambda ws: None)
    monkeypatch.setattr(r, "_live_dkao_children", lambda ws: [])
    body = client.get("/api/harness-evolve/he-stop/summary").json()
    assert body["running"] is True
    # and the shell's own view stays untouched: this is a UI hint, not a
    # rewrite of the shared liveness contract
    shell = client.get("/api/sys-shell/he-stop").json()["status"]
    assert shell.get("running") is False


def test_summary_sees_liveness_through_a_running_child(tmp_path, client,
                                                       monkeypatch):
    """A round can be mid-flight while the parent is between steps."""
    from metainfer.tasks.harness_evolve.server import routes as r

    _he_task(tmp_path)
    monkeypatch.setattr(r, "_resume_running", lambda sd: None)
    monkeypatch.setattr(r, "_supervisor_running", lambda ws: None)
    monkeypatch.setattr(r, "_live_dkao_children",
                        lambda ws: [{"pid": 7, "cmd": "child"}])
    assert client.get("/api/harness-evolve/he-stop/summary"
                      ).json()["running"] is True


def test_summary_is_not_running_after_a_stop(tmp_path, client, monkeypatch):
    """The button must disappear once the stop has actually landed."""
    from metainfer.tasks.harness_evolve.server import routes as r

    _he_task(tmp_path)
    monkeypatch.setattr(r, "_live_dkao_children", lambda ws: [])
    client.post("/api/harness-evolve/he-stop/stop")
    body = client.get("/api/harness-evolve/he-stop/summary").json()
    assert body["running"] is False
    assert body["operator_stop"] is not None


# --------------------------------------------- what the operator is told to do


def _read(rel: str) -> str:
    from pathlib import Path
    return (Path(__file__).resolve().parents[1] / rel).read_text(encoding="utf-8")


def test_the_page_calls_it_a_pause_and_offers_the_way_back():
    """The button is where most operators will ever read about this."""
    src = _read("static/he-detail.js")
    assert "停止任务（暂停）" in src, "the button no longer says it is a pause"
    assert "不会被 janitor / supervisor 自动拉起" in src, (
        "the page must tell the operator a stop sticks")
    assert "FLOW.md §9" in src, "the page must point at the operations note"
    # A stopped run keeps its phase, so "is the graph finished?" is the wrong
    # question for the button next to it: what the click does depends on whether
    # anything is running.
    assert '"续跑到该轮次上限"' in src
    assert '${isFinished ? "续跑到该轮次上限"' not in src, (
        "the resume label is gated on the graph again: a stopped run would offer "
        "「更新上限（下一轮生效）」 while the click actually re-launches it")


def test_the_operations_note_is_written_down():
    """FLOW.md §9 is the operator manual this feature is explained in."""
    flow = _read("FLOW.md")
    assert "## 9. 停止与续跑" in flow
    for needle in ("operator_stop.json", "stopped by operator", "env_retry_attempts",
                   "Reset", "_run_alive"):
        assert needle in flow, f"the operations note no longer mentions {needle}"
    # ... and the README, which is what a maintainer opens first, points at it.
    readme = _read("README.md")
    assert "§9" in readme and "FLOW.md" in readme
