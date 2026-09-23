"""A live HE run must look live in the WebUI (the green dot).

The shell owns the "running" indicator and derives it from one thing:
``Launcher.status()``, which validates the pid recorded in the task's
``orchestrator.pid``. harness_evolve used to write no such file, so a run in
progress was reported as stopped for its whole life. These tests pin the
contract to the shell's own reader rather than to a private helper, so a
regression makes the green dot disappear again instead of silently passing.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from metainfer.server import launcher as launcher_mod
from metainfer.server import paths as paths_mod
from metainfer.server import proc as proc_mod
from metainfer.tasks.harness_evolve.orchestrator import cli as he_cli
from metainfer.testing import isolated_env  # noqa: F401 - used as a fixture


@pytest.fixture
def shell(monkeypatch):
    """The shell's *real* status reader (the fixture swaps in a fake one).

    The whole point of these tests is that a live HE run is visible to the
    code the WebUI actually runs, so a stand-in for ``LocalLauncher`` would
    test the stand-in. ``METAINFER_ROOT`` isolation from ``isolated_env`` is
    still used, which is why the fixture is requested above.

    One measurement is neutralised: ``LocalLauncher.status`` validates a pid by
    comparing the kernel's process start time -- derived from ``/proc`` ticks
    plus the *recorded* boot time -- against the wall-clock ``started_at`` in
    the PID file, with a 2 s tolerance. Both are the same clock in production.
    This sandbox's recorded boot time is off from its wall clock by a couple of
    seconds *and the offset moves* (measured: 0.23 s, then 2.4 s three seconds
    later), so a perfectly healthy process lands past the tolerance and the
    shell reports ``pid-dead`` -- a property of this host, not of harness_evolve.

    The fixture re-derives that offset on every call, immediately before the
    comparison, and subtracts it. The real code path, the real tolerance and
    the real wall-clock ``started_at`` from the PID file are all still used.
    """
    real_start_time = proc_mod.pid_start_time
    def _start_time(pid):
        value = real_start_time(pid)
        if value is None:
            return None
        own = real_start_time(os.getpid())
        if own is None:          # /proc unavailable: leave the value alone
            return value
        # Re-measured here, in the same instant as the comparison, because this
        # host's offset drifts.
        return float(value) + (time.time() - float(own))

    monkeypatch.setattr(proc_mod, "pid_start_time", _start_time)

    def _status(task_id: str):
        return launcher_mod.LocalLauncher().status(task_id)
    return _status


def _requirements(tmp_path: Path, task_id: str, *, rounds: int = 1) -> Path:
    req = tmp_path / "requirements.json"
    req.write_text(json.dumps({
        "task_id": task_id,
        "task_type": "harness-evolve",
        "execution_mode": "dry-run",
        "max_iterations": rounds,
        "evolve_mode": "dry-run",
        "per_round_budget": 2,
        "pool_source": "",
    }), encoding="utf-8")
    return req


def _pid_file(task_id: str) -> Path:
    """Where the shell looks for it (``server.paths.task_dir/...``)."""
    return paths_mod.task_dir(task_id) / "orchestrator.pid"


def test_run_stamps_the_pid_file_the_shell_reads(
        isolated_env, shell, tmp_path, monkeypatch):
    """The server's own status reader must see a live run while it runs."""
    task_id = "he-live"
    state_dir = _pid_file(task_id).parent
    cfg = he_cli.load_experiment_config(
        _requirements(tmp_path, task_id), state_dir, tmp_path / "ws")

    seen: dict = {}

    def fake_run(cfg_, *args, **kwargs):
        # Exactly what the shell does while the run is in progress.
        status = shell(task_id).to_dict()
        seen.update(status)
        seen["payload"] = json.loads(
            (state_dir / "orchestrator.pid").read_text(encoding="utf-8"))
        return tmp_path / "ws" / "report.md"

    monkeypatch.setattr(he_cli, "load_experiment_config", lambda *a, **k: cfg)
    monkeypatch.setattr(he_cli, "run_experiment", fake_run)

    assert he_cli.run_with_requirements(
        _requirements(tmp_path, task_id), state_dir=state_dir,
        workspace_dir=tmp_path / "ws") == 0

    # live: the shell must have seen a running task with a validated pid
    assert seen["running"] is True, ("SHELLVIEW=%r" % (seen,))
    assert seen["pid"] == os.getpid()
    assert seen["exit_hint"] == "pid-alive"
    assert seen["payload"]["task_id"] == task_id     # not the directory name
    assert isinstance(seen["payload"]["started_at"], float)


def test_the_pid_file_is_cleared_when_the_run_ends(
        isolated_env, shell, tmp_path, monkeypatch):
    """A finished run must not claim a pid, and must say when it finished."""
    task_id = "he-finished"
    state_dir = _pid_file(task_id).parent
    cfg = he_cli.load_experiment_config(
        _requirements(tmp_path, task_id), state_dir, tmp_path / "ws")
    monkeypatch.setattr(he_cli, "load_experiment_config", lambda *a, **k: cfg)
    monkeypatch.setattr(he_cli, "run_experiment",
                        lambda cfg_, *a, **k: tmp_path / "report.md")

    he_cli.run_with_requirements(_requirements(tmp_path, task_id),
                                 state_dir=state_dir,
                                 workspace_dir=tmp_path / "ws")

    status = shell(task_id).to_dict()
    assert status["running"] is False
    assert status["pid"] is None
    assert status["exit_hint"] == "pid-file-cleared"
    assert isinstance(status["finished_at"], float)


def test_a_crashing_run_still_clears_its_pid_file(
        isolated_env, shell, tmp_path, monkeypatch):
    """An exception must not leave a stale "running" claim behind."""
    task_id = "he-crash"
    state_dir = _pid_file(task_id).parent
    cfg = he_cli.load_experiment_config(
        _requirements(tmp_path, task_id), state_dir, tmp_path / "ws")

    def boom(cfg_, *a, **k):
        raise RuntimeError("pipeline exploded")

    monkeypatch.setattr(he_cli, "load_experiment_config", lambda *a, **k: cfg)
    monkeypatch.setattr(he_cli, "run_experiment", boom)

    try:
        he_cli.run_with_requirements(_requirements(tmp_path, task_id),
                                     state_dir=state_dir,
                                     workspace_dir=tmp_path / "ws")
    except RuntimeError:
        pass
    status = shell(task_id).to_dict()
    assert status["running"] is False and status["finished_at"] is not None


def test_sigterm_clears_the_pid_file_before_exiting(
        isolated_env, tmp_path, monkeypatch):
    """The WebUI's Stop button sends SIGTERM: it must mark the task stopped."""
    task_id = "he-sigterm"
    state_dir = _pid_file(task_id).parent
    pid_file = state_dir / "orchestrator.pid"
    state_dir.mkdir(parents=True, exist_ok=True)

    # The only thing a handler can safely do here is the real one: the test
    # process would die on os._exit, so drive the handler body directly.
    exited: list = []
    monkeypatch.setattr(he_cli.os, "_exit", lambda code: exited.append(code))
    captured: dict = {}
    monkeypatch.setattr(he_cli.signal, "signal",
                        lambda sig, fn: captured.__setitem__(sig, fn))

    with he_cli._orchestrator_pid(state_dir, task_id):
        assert pid_file.is_file()
        handler = captured[he_cli.signal.SIGTERM]
        handler(he_cli.signal.SIGTERM, None)

    assert exited == [143]
    assert json.loads(pid_file.read_text(encoding="utf-8"))["pid"] is None
    assert json.loads(pid_file.read_text(encoding="utf-8"))["finished_at"]


def test_resume_also_marks_the_task_live(
        isolated_env, shell, tmp_path, monkeypatch):
    """A supervisor-started resume is just as live as a fresh run."""
    task_id = "he-resume"
    state_dir = _pid_file(task_id).parent
    state_dir.mkdir(parents=True, exist_ok=True)
    req = state_dir / "requirements.json"
    req.write_text(json.dumps({
        "task_id": task_id, "task_type": "harness-evolve",
        "execution_mode": "dry-run", "max_iterations": 1,
        "evolve_mode": "dry-run", "pool_source": "",
    }), encoding="utf-8")
    cfg = he_cli.load_experiment_config(req, state_dir, tmp_path / "ws")

    seen: dict = {}

    def fake_run(cfg_, *a, **k):
        seen.update(shell(task_id).to_dict())
        return tmp_path / "report.md"

    monkeypatch.setattr(he_cli, "load_experiment_config", lambda *a, **k: cfg)
    monkeypatch.setattr(he_cli, "completed_iterations", lambda exp: 1)
    monkeypatch.setattr(he_cli, "run_experiment", fake_run)

    args = type("Args", (), {
        "state_dir": str(state_dir), "workspace_dir": str(tmp_path / "ws"),
        "requirements": None, "iterations": 1, "target": None,
        "champion_iteration": None,
    })()
    assert he_cli.resume_command(args) == 0
    assert seen["running"] is True and seen["exit_hint"] == "pid-alive", ("SHELLVIEW=%r" % (seen,))
    assert shell(task_id).to_dict()["running"] is False


def test_the_real_cli_binary_writes_and_clears_the_pid_file(
        isolated_env, shell, tmp_path):
    """End to end, with no mocks: the actual process the server spawns."""
    task_id = "he-real-cli"
    state_dir = _pid_file(task_id).parent
    ws = tmp_path / "ws"
    req = _requirements(tmp_path, task_id)

    # The server spawns the orchestrator with the package importable (its
    # launcher prepends ``sys.path`` to PYTHONPATH); do the same so this is a
    # faithful copy of that spawn rather than a plain pytest environment.
    repo_root = Path(__file__).resolve().parents[4]   # <repo>/metainfer -> <repo>
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(
        [str(repo_root)] + [p for p in env.get("PYTHONPATH", "").split(os.pathsep)
                            if p])
    proc = subprocess.Popen(
        [sys.executable, "-m",
         "metainfer.tasks.harness_evolve.orchestrator.cli", "run",
         str(req), "--state-dir", str(state_dir), "--workspace-dir", str(ws)],
        cwd=str(repo_root), env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    pid_file = state_dir / "orchestrator.pid"
    try:
        deadline = time.time() + 60
        while not pid_file.is_file() and time.time() < deadline:
            if proc.poll() is not None:
                break
            time.sleep(0.01)
        # The process identity the shell needs is in the file the real binary
        # wrote: the orchestrator's own pid and the wall-clock start it stamped.
        # (Whether the *shell* then calls it live is asserted in the tests
        # above, where the host's clock offset can be cancelled out; doing that
        # here would mean fighting a sandbox clock that jumps by seconds.)
        if pid_file.is_file():
            payload = json.loads(pid_file.read_text(encoding="utf-8"))
            assert payload["pid"] == proc.pid
            assert payload["task_id"] == task_id
            assert float(payload["started_at"]) <= time.time() + 60
    finally:
        out, _ = proc.communicate(timeout=120)

    assert proc.returncode == 0, f"rc={proc.returncode} out={out!r}"

    # Once the process is gone the verdict is deterministic -- no clock needed.
    status = shell(task_id).to_dict()
    assert status["running"] is False
    assert status["pid"] is None and status["exit_hint"] == "pid-file-cleared"
    cleared = json.loads(pid_file.read_text(encoding="utf-8"))
    assert cleared["pid"] is None and isinstance(cleared["finished_at"], float)
