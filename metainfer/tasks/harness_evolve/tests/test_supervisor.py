"""Incident supervisor: classification, policy and supervision ticks."""

from __future__ import annotations

import json
from pathlib import Path

from metainfer.tasks.harness_evolve.orchestrator.supervisor import (
    CATEGORY_AGENT, CATEGORY_CODE, CATEGORY_RESOURCE, CATEGORY_UNKNOWN,
    Supervisor, classify_incident, decide_action,
)


# ------------------------------------------------------------- classify ----

def test_classify_resource_signals():
    assert classify_incident(log_tail="hipErrorOutOfMemory: failed")[0] == CATEGORY_RESOURCE
    assert classify_incident(log_tail="", exit_code=137)[0] == CATEGORY_RESOURCE
    assert classify_incident(log_tail="no space left on device")[0] == CATEGORY_RESOURCE
    category, evidence = classify_incident(log_tail="std::bad_alloc")
    assert category == CATEGORY_RESOURCE and evidence


def test_classify_agent_and_code_and_unknown():
    assert classify_incident(log_tail="TransportClosedError('runtime closed')")[0] == CATEGORY_AGENT
    assert classify_incident(log_tail="timed out after 1800.0 seconds")[0] == CATEGORY_AGENT
    assert classify_incident(log_tail="Traceback (most recent call last):")[0] == CATEGORY_CODE
    assert classify_incident(log_tail="everything is fine")[0] == CATEGORY_UNKNOWN


# --------------------------------------------------------------- policy ----

def test_policy_running_and_code_and_resource():
    assert decide_action(category=CATEGORY_UNKNOWN, same_class_streak=1,
                         waits_done=0, restarts_done=0, running=True)["action"] == "run"
    assert decide_action(category=CATEGORY_CODE, same_class_streak=1,
                         waits_done=0, restarts_done=0, running=False)["action"] == "stop"
    wait = decide_action(category=CATEGORY_RESOURCE, same_class_streak=1,
                         waits_done=0, restarts_done=0, running=False,
                         wait_seconds=1800)
    assert wait["action"] == "wait" and wait["sleep_s"] == 1800
    exhausted = decide_action(category=CATEGORY_RESOURCE, same_class_streak=1,
                              waits_done=6, restarts_done=0, running=False)
    assert exhausted["action"] == "stop"


def test_policy_backoff_restart_and_breaker():
    agent = decide_action(category=CATEGORY_AGENT, same_class_streak=1,
                          waits_done=0, restarts_done=0, running=False)
    assert agent["action"] == "restart" and agent["sleep_s"] > 0
    unknown = decide_action(category=CATEGORY_UNKNOWN, same_class_streak=1,
                            waits_done=0, restarts_done=0, running=False)
    assert unknown["action"] == "restart"
    breaker = decide_action(category=CATEGORY_AGENT, same_class_streak=3,
                            waits_done=0, restarts_done=1, running=False)
    assert breaker["action"] == "stop" and "circuit breaker" in breaker["reason"]
    gave_up = decide_action(category=CATEGORY_UNKNOWN, same_class_streak=1,
                            waits_done=0, restarts_done=3, running=False)
    assert gave_up["action"] == "stop"


# ----------------------------------------------------------- supervisor ----

class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def _sup(tmp_path: Path, *, launcher, clock=None, target=4,
         diagnose=False):
    """A supervisor whose only inputs are the run's own files.

    There is no free-VRAM getter any more: FLOW.md §0 — HE holds no device
    verdict, so the supervisor has nothing to ask a GPU about.
    """
    slept: list = []
    sup = Supervisor(
        tmp_path / "state", tmp_path / "exp", target=target, interval_s=0,
        clock=clock or FakeClock(), sleeper=lambda s: slept.append(s),
        resume_launcher=launcher,
        diagnose_agent=diagnose,
    )
    sup.state_dir.mkdir(parents=True, exist_ok=True)
    sup.exp_dir.mkdir(parents=True, exist_ok=True)
    sup.slept = slept  # type: ignore[attr-defined]
    return sup


def _write_run(sup: Supervisor, **fields) -> None:
    (sup.state_dir / "run.json").write_text(
        json.dumps({"task_id": "t", **fields}), encoding="utf-8")


def _pid_alive(sup: Supervisor, alive: bool) -> None:
    """Register a pid that looks like a live harness_evolve process."""
    import os
    import subprocess
    import sys
    if not alive:
        (sup.state_dir / "resume.pid").write_text("99999999", encoding="utf-8")
        return
    # argv carries the marker the liveness check looks for
    proc = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(60)", "harness_evolve"],
    )
    sup._test_proc = proc                       # type: ignore[attr-defined]
    # a fresh child has no state writes yet: disable the stall guard here
    sup.stall_seconds = 10 ** 9
    (sup.state_dir / "resume.pid").write_text(str(proc.pid), encoding="utf-8")


def test_step_reports_alive_and_done(tmp_path):
    sups = _sup(tmp_path, launcher=lambda: 1)
    _write_run(sups, current_iteration=3, finished=False)
    _pid_alive(sups, True)
    try:
        assert sups.step()["action"] == "run"
        assert sups.read_state()["status"] == "running"

        _write_run(sups, current_iteration=4, finished=True)
        done = sups.step()
        assert done["action"] == "done"
        assert sups.read_state()["status"] == "done"
    finally:
        proc = getattr(sups, "_test_proc", None)
        if proc is not None:
            proc.kill()
            proc.wait()


def test_step_waits_then_restarts_on_resource_incident(tmp_path):
    calls: list = []
    sups = _sup(tmp_path, launcher=lambda: calls.append(1) or 4242)
    _write_run(sups, current_iteration=3, finished=False)
    _pid_alive(sups, False)
    (sups.state_dir / "resume.log").write_text(
        "hipErrorOutOfMemory: failed to allocate\n", encoding="utf-8")

    out = sups.step()
    assert out["action"] == "restart"          # waited out the OOM, then restarted
    assert sups.slept and sups.slept[0] == 1800
    assert calls == [1]
    state = sups.read_state()
    assert state["status"] == "running" and state["waits_done"] == 1
    incidents = (sups.exp_dir / "incidents.jsonl").read_text(encoding="utf-8").splitlines()
    kinds = [json.loads(x)["action"] for x in incidents]
    assert "wait" in kinds and "restart_after_wait" in kinds


def test_the_restart_after_a_wait_does_not_ask_the_cards(tmp_path):
    """HE holds no device verdict: the wait is the whole condition.

    The supervisor used to re-read free VRAM after the wait and keep waiting
    while it looked low (``wait_again``) — that is HE managing the environment
    again (FLOW.md §0). Whether a card is clean now is decided by the *child's*
    own measurement gate, which waits on the child's behalf.
    """
    calls: list = []
    sups = _sup(tmp_path, launcher=lambda: calls.append(1) or 4242)
    _write_run(sups, current_iteration=3, finished=False)
    _pid_alive(sups, False)
    (sups.state_dir / "resume.log").write_text("bad_alloc\n", encoding="utf-8")

    out = sups.step()

    assert out["action"] == "restart" and calls == [1]
    assert sups.read_state()["status"] == "running"
    kinds = [json.loads(x)["action"] for x in
             (sups.exp_dir / "incidents.jsonl").read_text(
                 encoding="utf-8").splitlines()]
    assert "wait_again" not in kinds


def test_step_stops_on_deterministic_code_failure(tmp_path):
    calls: list = []
    sups = _sup(tmp_path, launcher=lambda: calls.append(1) or 7)
    _write_run(sups, current_iteration=3, finished=False)
    _pid_alive(sups, False)
    (sups.state_dir / "orchestrator.log").write_text(
        "Traceback (most recent call last):\nValueError: bad config\n",
        encoding="utf-8")
    out = sups.step()
    assert out["action"] == "stop"
    assert calls == []                         # never restarts a code error
    assert sups.read_state()["status"] == "stopped"


def test_circuit_breaker_after_repeated_agent_failures(tmp_path):
    calls: list = []
    sups = _sup(tmp_path, launcher=lambda: calls.append(1) or 5)
    _write_run(sups, current_iteration=3, finished=False)
    _pid_alive(sups, False)
    (sups.state_dir / "resume.log").write_text("TransportClosedError\n",
                                               encoding="utf-8")
    assert sups.step()["action"] == "restart"
    assert sups.step()["action"] == "restart"
    out = sups.step()
    assert out["action"] == "stop"
    assert "circuit breaker" in out["reason"]
    assert len(calls) == 2                     # third time: stop, no restart


def test_stop_flag_wins(tmp_path):
    sups = _sup(tmp_path, launcher=lambda: 1)
    (sups.exp_dir / "supervisor.stop").write_text("stop", encoding="utf-8")
    assert sups.step()["action"] == "stop"


def test_project_root_contains_the_package():
    from metainfer.tasks.harness_evolve.orchestrator.supervisor import Supervisor
    root = Supervisor.project_root()
    assert (root / "metainfer" / "tasks").is_dir()


def test_pid_is_live_rejects_missing_self_and_zombies():
    import os
    import time
    from metainfer.tasks.harness_evolve.orchestrator import supervisor as sup
    assert sup.pid_is_live(None) is False
    assert sup.pid_is_live(99999999) is False
    assert sup.pid_is_live(os.getpid()) is False          # not a harness process

    pid = os.fork()
    if pid == 0:                                          # child: exit at once
        os._exit(0)
    time.sleep(0.4)                                       # now a zombie
    try:
        assert sup.pid_is_live(pid) is False
    finally:
        os.waitpid(pid, 0)


def test_should_launch_resume_covers_start_crash_and_target():
    from metainfer.tasks.harness_evolve.server.routes import should_launch_resume
    assert should_launch_resume({}, None, False) is False
    assert should_launch_resume({"finished": False}, 5, False) is True
    assert should_launch_resume({"finished": False}, 5, True) is False
    assert should_launch_resume({"finished": True, "current_iteration": 1},
                                5, False) is True
    assert should_launch_resume({"finished": True, "current_iteration": 5},
                                5, False) is False
    assert should_launch_resume({"finished": True, "current_iteration": 5},
                                None, False) is False


def test_supervisor_restarts_when_the_child_is_a_zombie(tmp_path):
    """A defunct child must not count as 'running' (the stuck-in-analyze bug)."""
    import os
    import time
    from metainfer.tasks.harness_evolve.orchestrator.supervisor import Supervisor
    state = tmp_path / "st"
    exp = tmp_path / "exp"
    state.mkdir()
    exp.mkdir()
    pid = os.fork()
    if pid == 0:
        os._exit(0)
    time.sleep(0.4)
    try:
        (state / "resume.pid").write_text(str(pid), encoding="utf-8")
        (state / "run.json").write_text('{"current_iteration": 1, "finished": false}',
                                        encoding="utf-8")
        calls = []
        sup = Supervisor(state, exp, target=5, interval_s=0,
                         resume_launcher=lambda: calls.append(1) or 4242,
                         sleeper=lambda s: None)
        out = sup.step()
        assert calls == [1], out            # restarted instead of idling
        assert out["action"] in {"restart", "wait", "wait_again"}
    finally:
        os.waitpid(pid, 0)


def test_progress_age_counts_child_activity(tmp_path):
    """A long evaluate round must not look like a stall while children work."""
    import os
    import time
    from metainfer.tasks.harness_evolve.orchestrator.supervisor import Supervisor
    state = tmp_path / "st"
    exp = tmp_path / "exp"
    state.mkdir()
    exp.mkdir()
    (state / "run.json").write_text('{"current_iteration": 2, "finished": false}',
                                    encoding="utf-8")
    # stale outer state
    old = time.time() - 7200
    os.utime(state / "run.json", (old, old))
    (state / "timeline.jsonl").write_text("{}\n", encoding="utf-8")
    os.utime(state / "timeline.jsonl", (old, old))

    child_state = exp / "children" / "iteration_002" / "shapeA" / "state"
    child_state.mkdir(parents=True)
    (child_state / "timeline.jsonl").write_text("{}\n", encoding="utf-8")

    sup = Supervisor(state, exp, target=5, interval_s=0,
                     resume_launcher=lambda: 1,
                     sleeper=lambda s: None)
    age = sup.progress_age()
    assert age is not None and age < 60        # child write counts as progress

    # and a genuinely idle run still looks stalled
    os.utime(child_state / "timeline.jsonl", (old, old))
    assert sup.progress_age() > 3600


def test_janitor_sweep_recovers_unsupervised_tasks(monkeypatch, tmp_path):
    """A task whose supervisor died must be picked up again by the sweep."""
    from metainfer.tasks.harness_evolve.server import routes as R

    state = tmp_path / "state"
    ws = tmp_path / "ws"
    state.mkdir()
    ws.mkdir()
    (state / "run.json").write_text('{"current_iteration": 2, "finished": false}',
                                    encoding="utf-8")

    class Entry:
        id = "t-janitor"
        type = R.PLUGIN_TYPE
        state_dir = str(state)
        workspace_dir = str(ws)

    monkeypatch.setattr("metainfer.server.tasks.list_tasks", lambda: [Entry()])
    monkeypatch.setattr(R, "_resume_running", lambda _s: None)
    monkeypatch.setattr(R, "_supervisor_running", lambda _w: None)
    monkeypatch.setattr(R, "read_target_iterations", lambda _w: 5)
    monkeypatch.setattr(R, "_launch_supervisor",
                        lambda *a, **k: {"pid": 111, "log": "x"})
    monkeypatch.setattr(R, "_launch_resume",
                        lambda *a, **k: {"pid": 222})

    actions = R.janitor_sweep()
    assert actions and actions[0]["action"] == "supervisor+resume"
    assert actions[0]["supervisor_pid"] == 111
    assert actions[0]["resume_pid"] == 222


def test_janitor_sweep_leaves_a_healthy_run_alone(monkeypatch, tmp_path):
    """A live run is nobody's business — including one started by the server.

    The liveness question is ``_run_alive`` (orchestrator.pid first, then a
    /proc scan). The old version of this test mocked ``_resume_running``, i.e.
    it only ever described a *resume*-started task — which is why the real
    production shape (a task the New Task form started, no ``resume.pid``) went
    unnoticed and got a second driver.
    """
    from metainfer.tasks.harness_evolve.server import routes as R

    state = tmp_path / "state"
    ws = tmp_path / "ws"
    state.mkdir()
    ws.mkdir()
    (state / "run.json").write_text('{"current_iteration": 2, "finished": false}',
                                    encoding="utf-8")

    class Entry:
        id = "t-ok"
        type = R.PLUGIN_TYPE
        state_dir = str(state)
        workspace_dir = str(ws)

    monkeypatch.setattr("metainfer.server.tasks.list_tasks", lambda: [Entry()])
    monkeypatch.setattr(R, "_run_alive", lambda _s: 4242)
    monkeypatch.setattr(R, "_supervisor_running", lambda _w: 4343)
    monkeypatch.setattr(R, "read_target_iterations", lambda _w: 5)
    actions = R.janitor_sweep()
    assert actions and actions[0]["action"] == "skip"
    assert actions[0]["reason"] == "run is alive"


def test_should_launch_resume_respects_terminal_statuses():
    """A run stopped on purpose (unmeasured round / abort / breaker) stays stopped.

    ``round_incomplete`` is how a blocked *child* surfaces now: the DKAO gate
    that stopped it is recorded as the cause, not as HE's own device verdict.
    """
    from metainfer.tasks.harness_evolve.server.routes import should_launch_resume
    for status in ("round_incomplete", "aborted_by_operator", "circuit_breaker"):
        assert should_launch_resume(
            {"finished": True, "current_iteration": 6, "final_status": status},
            10, False) is False
    # a clean finish below target is resumed as usual
    assert should_launch_resume(
        {"finished": True, "current_iteration": 6, "final_status": "success"},
        10, False) is True


def test_task_process_alive_finds_a_server_started_run(tmp_path, monkeypatch):
    """A task launched by the server (no resume.pid) still counts as running."""
    import os
    import subprocess
    import sys
    from metainfer.tasks.harness_evolve.orchestrator import supervisor as sup

    state = tmp_path / "state"
    state.mkdir()
    assert sup.task_process_alive(state) is None       # nothing running

    # a process whose cmdline mentions this task's state dir and the CLI
    proc = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(30)",
         "harness_evolve.orchestrator.cli", str(state)],
    )
    try:
        assert sup.task_process_alive(state) == proc.pid
    finally:
        proc.kill()
        proc.wait()

    # a stale pid file (dead process) is not "alive"
    (state / "resume.pid").write_text("99999999", encoding="utf-8")
    assert sup.task_process_alive(state) is None


# ------------------------------------------------- live children / stalls ----

def _fake_proc(tmp_path, pid, cmdline, state="S"):
    root = tmp_path / "proc"
    entry = root / str(pid)
    entry.mkdir(parents=True, exist_ok=True)
    (entry / "cmdline").write_bytes(cmdline.replace(" ", "\0").encode() + b"\0")
    (entry / "stat").write_text(f"{pid} (python3) {state} 1 1 1 0 -1 4194560\n")
    return root


def test_live_child_count_reads_processes_not_mtimes(tmp_path):
    """A silent-but-alive child counts as progress; other rounds do not."""
    from metainfer.tasks.harness_evolve.orchestrator.supervisor import Supervisor

    state = tmp_path / "st"
    exp = tmp_path / "exp"
    state.mkdir()
    exp.mkdir()
    (state / "run.json").write_text('{"current_iteration": 2, "finished": false}',
                                    encoding="utf-8")
    sup = Supervisor(state, exp, target=5, interval_s=0,
                     resume_launcher=lambda: 1,
                     sleeper=lambda s: None)

    root = _fake_proc(tmp_path, 4242,
                      "python3 -m metainfer.tasks.dcu_kernel_auto_opt."
                      "orchestrator.cli run /w/children/iteration_002/shapeA")
    # a child of another iteration must not count for this one
    _fake_proc(tmp_path, 4243,
               "python3 -m metainfer.tasks.dcu_kernel_auto_opt.orchestrator.cli"
               " run /w/children/iteration_001/shapeB")
    # a zombie is not a live child
    _fake_proc(tmp_path, 4244,
               "python3 -m metainfer.tasks.dcu_kernel_auto_opt.orchestrator.cli"
               " run /w/children/iteration_002/shapeC", state="Z")
    # something else entirely
    _fake_proc(tmp_path, 4245, "python3 -m http.server")

    assert sup.live_child_count(root) == 1


def test_a_silent_live_child_blocks_the_stall_guard(tmp_path):
    """The regression that produced two resumes: 40 min of quiet child work."""
    import os
    import time
    from metainfer.tasks.harness_evolve.orchestrator.supervisor import Supervisor

    state = tmp_path / "st"
    exp = tmp_path / "exp"
    state.mkdir()
    exp.mkdir()
    (state / "run.json").write_text('{"current_iteration": 2, "finished": false}',
                                    encoding="utf-8")
    old = time.time() - 7200
    for name in ("run.json", "timeline.jsonl"):
        path = state / name
        if not path.exists():
            path.write_text("{}", encoding="utf-8")
        os.utime(path, (old, old))
    (exp / "children" / "iteration_002").mkdir(parents=True)

    calls = []
    sup = Supervisor(state, exp, target=5, interval_s=0, stall_seconds=60,
                     resume_launcher=lambda: calls.append(1) or 4242,
                     sleeper=lambda s: None)
    assert sup.process_alive.__self__ is sup        # sanity: bound to this run
    sup.process_alive = lambda: True                # a live (quiet) orchestrator
    sup.live_child_count = lambda *a, **k: 1        # ...with a live child

    out = sup.step()

    assert out["action"] == "run", out
    assert calls == []                              # no duplicate resume
    actions = [json.loads(l)["action"] for l in
               (exp / "incidents.jsonl").read_text(encoding="utf-8").splitlines()]
    assert "stall_ignored" in actions


def test_terminating_a_stale_run_kills_its_process_group(tmp_path):
    import os
    import time
    from metainfer.tasks.harness_evolve.orchestrator.supervisor import Supervisor

    state = tmp_path / "st"
    exp = tmp_path / "exp"
    state.mkdir()
    exp.mkdir()
    sup = Supervisor(state, exp, target=5, interval_s=0,
                     resume_launcher=lambda: 1,
                     sleeper=lambda s: time.sleep(min(s, 0.05)))

    pid = os.fork()
    if pid == 0:                                    # child: own session, then idle
        try:
            os.setsid()
            time.sleep(60)
        finally:
            os._exit(0)

    time.sleep(0.3)
    try:
        killed = sup.terminate_stale_run([pid])
        assert killed == [pid]
        deadline = time.time() + 5
        while time.time() < deadline:
            try:
                wpid, _ = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                break
            if wpid == pid:
                break
            time.sleep(0.1)
        assert not Path(f"/proc/{pid}").exists() or \
            Path(f"/proc/{pid}/stat").read_text().split(") ", 1)[1].startswith("Z")
    finally:
        try:
            os.kill(pid, 9)
        except OSError:
            pass
        try:
            os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            pass
