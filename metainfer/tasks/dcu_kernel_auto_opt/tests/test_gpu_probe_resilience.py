"""Transient GPU-stack failures must not kill a task.

``w8a8_bench.py --probe`` initialises a device, so it inherits the container's
ROCm/amdsmi startup problems. Observed in production, three times in one
evening, on unrelated tasks:

    RuntimeError: ... --probe failed (3): shm_open: Permission denied
    UserWarning: Can't initialize amdsmi - Error code: 32

while the same command run by hand minutes later on the same repository printed
the expected JSON with an empty stderr, and 12 concurrent probes all passed. The
probe therefore retries a couple of times (with the stale amdsmi shared-memory
waits in between), and still applies the identical acceptance checks —
so the retry is a resilience change, never a weakening of the gate.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from ..orchestrator import gpu_probe


class _Runner:
    """Stands in for ``real_pipeline._run``: fails N times, then succeeds."""

    def __init__(self, failures: int, error: Exception | None = None):
        self.failures = failures
        self.error = error or RuntimeError(
            "python3 w8a8_bench.py ... --probe failed (3): "
            "shm_open: Permission denied\n"
            "UserWarning: Can't initialize amdsmi - Error code: 32")
        self.calls: list[dict] = []

    def __call__(self, command, *, cwd, env, timeout):
        self.calls.append({"command": list(command), "cwd": cwd, "env": env,
                           "timeout": timeout})
        if len(self.calls) <= self.failures:
            raise self.error
        return subprocess.CompletedProcess(
            args=command, returncode=0,
            stdout=json.dumps({"visible_devices": 1,
                               "cudagraph_available": True}),
            stderr="")


@pytest.fixture()
def no_sleep(monkeypatch):
    """Record the waits instead of taking them."""
    waits: list[float] = []
    monkeypatch.setattr(gpu_probe.time, "sleep", lambda s: waits.append(s))
    return waits


def _probe(tmp_path: Path, runner: _Runner, **kwargs):
    return gpu_probe.run_gpu_probe(
        harness=tmp_path / "w8a8_bench.py",
        source=tmp_path,
        env={"HIP_VISIBLE_DEVICES": "0"},
        runner=runner,
        state_dir=tmp_path / "state",
        **kwargs,
    )


@pytest.fixture(autouse=True)
def shm_writable(monkeypatch):
    """Pin the ``/dev/shm`` verdict for the tests below.

    The real verdict depends on who started the test run: under a file sandbox
    ``/dev/shm`` is read-only, which would silently turn every retry case into a
    no-retry case here. The confinement reaction has its own tests (see "a
    read-only /dev/shm" below); everything else runs with a writable /dev/shm.
    Returns the real check, for the test that exercises it.
    """
    real = gpu_probe.shm_write_check
    monkeypatch.setattr(gpu_probe, "shm_write_check", lambda directory=gpu_probe.SHM_DIR: {
        "ok": True, "dir": str(directory), "errno": None, "error": None,
        "denied": False})
    return real


def test_a_transient_stack_failure_is_retried_and_succeeds(tmp_path, no_sleep,
                                                           monkeypatch):
    cleaned: list[int] = []          # nothing may touch /dev/shm (see below)
    runner = _Runner(failures=1)

    result = _probe(tmp_path, runner)

    assert result.returncode == 0
    assert len(runner.calls) == 2, "one failure then one successful retry"
    assert no_sleep == [gpu_probe.RETRY_WAITS_SECONDS[0]]
    assert cleaned == [], (
        "nothing may touch /dev/shm during a retry: unlinking a live rendezvous "
        "file is what produced the 'Bad file descriptor' failures")
    # the probe command is unchanged and still asks for the cheap answer
    assert runner.calls[0]["command"][-1] == "--probe"
    assert runner.calls[0]["env"]["HIP_VISIBLE_DEVICES"] == "0"
    assert runner.calls[0]["timeout"] == 120
    assert not (tmp_path / "state" / "gpu_probe_failure.json").exists(), (
        "a recovered probe is not a failure worth reporting")


def test_a_broken_stack_that_never_heals_fails_with_diagnostics(tmp_path,
                                                                no_sleep):
    runner = _Runner(failures=99)

    with pytest.raises(RuntimeError) as excinfo:
        _probe(tmp_path, runner)

    message = str(excinfo.value)
    assert f"GPU probe failed after {gpu_probe.probe_attempts()} attempt(s)" in message
    assert "shm_open" in message, "the operator sees the real symptom"
    assert "Diagnostics:" in message
    # the waits grow, so a healing handshake has time to come back
    assert no_sleep == list(gpu_probe.RETRY_WAITS_SECONDS)
    assert len(runner.calls) == gpu_probe.probe_attempts()

    # a snapshot is left next to the task's other evidence
    snapshot = json.loads(
        (tmp_path / "state" / "gpu_probe_failure.json").read_text())
    assert snapshot["attempts"] == gpu_probe.probe_attempts()
    assert snapshot["visible_devices_env"] == "0"
    # the shm inventory is what matters: names, modes and owners are exactly
    # what a stale amdsmi handshake looks like
    assert isinstance(snapshot["dev_shm"], list)
    assert all({"name", "mode", "uid", "size"} <= set(entry)
               for entry in snapshot["dev_shm"])
    assert "Max open files" in snapshot["limits"]


def test_a_failure_that_is_not_the_gpu_stack_fails_immediately(tmp_path,
                                                               no_sleep):
    """A wrong environment is not a flake: do not paper over it with retries."""
    runner = _Runner(failures=99, error=RuntimeError(
        "python3 w8a8_bench.py --probe failed (1): Traceback ... "
        "ModuleNotFoundError: No module named 'torch'"))

    with pytest.raises(RuntimeError):
        _probe(tmp_path, runner)

    assert len(runner.calls) == 1, "no retry for a non-transient failure"
    assert no_sleep == []


def test_a_timeout_is_treated_as_transient(tmp_path, no_sleep):
    """A probe that hangs on device init is the same class of problem."""
    runner = _Runner(failures=1, error=subprocess.TimeoutExpired("probe", 120))

    result = _probe(tmp_path, runner)
    assert result.returncode == 0
    assert len(runner.calls) == 2


def test_clean_stale_rocm_shm_is_off_unless_asked(tmp_path, monkeypatch):
    """Deleting /dev/shm entries is opt-in, and never automatic.

    An unlinked file leaves its opener holding a dead inode, so the next
    ``fchmod`` on it returns ``Bad file descriptor``. The retry path must not do
    this; only an operator who knows the machine is quiet may ask for it.
    """
    shm = tmp_path / "shm"
    shm.mkdir()
    victim = shm / "rocm_smi_card1"
    victim.write_text("x", encoding="utf-8")
    monkeypatch.setattr(gpu_probe, "SHM_GLOBS", (str(shm / "rocm_smi_card*"),))
    monkeypatch.delenv(gpu_probe.CLEAN_SHM_ENV, raising=False)
    now = 1_000_000.0
    os.utime(victim, (now - 600, now - 600))      # idle for ten minutes

    assert gpu_probe.clean_stale_rocm_shm(now=now, force=False) == []
    assert victim.exists(), "nothing may be deleted by default"
    monkeypatch.setenv(gpu_probe.CLEAN_SHM_ENV, "1")
    assert gpu_probe.clean_stale_rocm_shm(now=now) == ["rocm_smi_card1"]
    assert not victim.exists()


def test_clean_stale_rocm_shm_only_removes_idle_files_when_asked(tmp_path, monkeypatch):
    shm = tmp_path / "shm"
    shm.mkdir()
    stale = shm / "rocm_smi_card1"
    fresh = shm / "rocm_smi_card2"
    other = shm / "sem.mp-keepme"
    for path in (stale, fresh, other):
        path.write_text("x", encoding="utf-8")
    monkeypatch.setattr(gpu_probe, "SHM_GLOBS", (str(shm / "rocm_smi_card*"),))

    now = 1_000_000.0
    stale.touch()
    Path(stale).touch()
    import os
    os.utime(stale, (now - 600, now - 600))      # idle for 10 minutes
    os.utime(fresh, (now - 1, now - 1))          # touched a second ago

    removed = gpu_probe.clean_stale_rocm_shm(now=now, force=True)

    assert removed == ["rocm_smi_card1"]
    assert not stale.exists()
    assert fresh.exists(), "a live handshake is left alone"
    assert other.exists(), "unrelated shm segments are never touched"


def test_probe_attempts_counts_the_retries():
    assert gpu_probe.probe_attempts() == len(gpu_probe.RETRY_WAITS_SECONDS) + 1
    assert gpu_probe.probe_attempts(wait_seconds=()) == 1


# --------------------------------------------------- concurrent init is fixed

def test_probes_are_serialised_across_processes(tmp_path, monkeypatch):
    """Only one process may start the GPU stack at a time.

    The failure this defends against is *concurrent* device initialisation: four
    tasks starting together broke the amdsmi shared-memory handshake and every
    one of them failed. Retrying inside that storm just repeats the storm, so the
    probe takes a container-wide lock around each attempt.
    """
    import threading
    import time as _time

    monkeypatch.setattr(gpu_probe, "PROBE_LOCK_PATH",
                        str(tmp_path / "probe.lock"))
    monkeypatch.delenv(gpu_probe.PROBE_LOCK_ENV, raising=False)
    windows: list[tuple[float, float]] = []
    lock = threading.Lock()

    class SlowRunner(_Runner):
        def __call__(self, command, *, cwd, env, timeout):
            start = _time.monotonic()
            _time.sleep(0.05)
            end = _time.monotonic()
            with lock:
                windows.append((start, end))
            return super().__call__(command, cwd=cwd, env=env, timeout=timeout)

    def probe():
        _probe(tmp_path, SlowRunner(failures=0))

    threads = [threading.Thread(target=probe) for _ in range(3)]
    [t.start() for t in threads]
    [t.join() for t in threads]

    assert len(windows) == 3
    ordered = sorted(windows)
    for (_, first_end), (second_start, _) in zip(ordered, ordered[1:]):
        assert second_start >= first_end, (
            "two probes initialised the device stack at the same time")


def test_the_serialisation_can_be_switched_off(tmp_path, monkeypatch):
    """An operator can rule the lock out as a suspect."""
    monkeypatch.setattr(gpu_probe, "PROBE_LOCK_PATH",
                        str(tmp_path / "probe.lock"))
    monkeypatch.setenv(gpu_probe.PROBE_LOCK_ENV, "0")
    assert gpu_probe._probe_lock_enabled() is False
    with gpu_probe.gpu_probe_lock() as held:
        assert held is False, "the lock must report that it was not taken"
    result = _probe(tmp_path, _Runner(failures=0))
    assert result.returncode == 0


def test_a_recovered_probe_is_recorded(tmp_path, monkeypatch):
    """When a retry saves the round, leave evidence that it did."""
    monkeypatch.setattr(gpu_probe, "PROBE_LOCK_PATH",
                        str(tmp_path / "probe.lock"))
    monkeypatch.setattr(gpu_probe, "clean_stale_rocm_shm", lambda **kw: [])
    monkeypatch.setattr(gpu_probe.time, "sleep", lambda s: None)
    result = gpu_probe.run_gpu_probe(
        harness=tmp_path / "w8a8_bench.py", source=tmp_path,
        env={"HIP_VISIBLE_DEVICES": "0"}, runner=_Runner(failures=1),
        state_dir=tmp_path / "state")
    assert result.returncode == 0
    recovered = (tmp_path / "state" / "gpu_probe_recovered.jsonl").read_text()
    assert "attempt" in recovered


# ------------------------------------------- a busy card is waited out

def test_a_busy_card_is_still_probed(tmp_path, no_sleep, monkeypatch):
    """A shared machine must not block the probe.

    Waiting out a busy card is the measurement gate's job (it knows the device
    set and waits up to 24 h). An earlier version of this module short-circuited
    the probe when ``check_gpu`` reported the card busy — that stopped runs which
    used to proceed on a shared machine, which is worse than the transient stack
    failure it was defending against. The card's state is therefore *reported*,
    not enforced.
    """
    monkeypatch.setattr(gpu_probe, "PROBE_LOCK_PATH",
                        str(tmp_path / "probe.lock"))
    monkeypatch.setattr(gpu_probe, "device_admission", lambda env: {
        "checked": True, "usable": False, "device": 0,
        "vram_percent": 89.0, "util_percent": 100.0,
        "reason": "HCU 100% > 0 limit"})
    monkeypatch.setattr(gpu_probe, "clean_stale_rocm_shm", lambda **kw: [])
    runner = _Runner(failures=99)

    with pytest.raises(RuntimeError) as excinfo:
        _probe(tmp_path, runner)

    assert len(runner.calls) == gpu_probe.probe_attempts(), (
        "the probe must be attempted even while the card is busy")
    message = str(excinfo.value)
    assert "may be contention" in message, message[:400]
    # the verdict is in the snapshot next to the other evidence
    snapshot = json.loads(
        (tmp_path / "state" / "gpu_probe_failure.json").read_text())
    assert snapshot["admission"]["usable"] is False


def test_a_busy_card_that_heals_on_retry_still_succeeds(tmp_path, no_sleep,
                                                        monkeypatch):
    """Contention that clears between attempts must not fail the round."""
    monkeypatch.setattr(gpu_probe, "PROBE_LOCK_PATH",
                        str(tmp_path / "probe.lock"))
    monkeypatch.setattr(gpu_probe, "device_admission", lambda env: {
        "checked": True, "usable": False, "device": 0,
        "reason": "VRAM 96% > 90% limit"})
    monkeypatch.setattr(gpu_probe, "clean_stale_rocm_shm", lambda **kw: [])

    result = _probe(tmp_path, _Runner(failures=1))

    assert result.returncode == 0
    assert no_sleep == [gpu_probe.RETRY_WAITS_SECONDS[0]]


def test_a_free_card_probes_immediately(tmp_path, no_sleep, monkeypatch):
    monkeypatch.setattr(gpu_probe, "PROBE_LOCK_PATH",
                        str(tmp_path / "probe.lock"))
    monkeypatch.setattr(gpu_probe, "device_admission", lambda env: {
        "checked": True, "usable": True, "device": 0, "reason": "card is idle"})
    runner = _Runner(failures=0)

    result = _probe(tmp_path, runner)

    assert result.returncode == 0
    assert len(runner.calls) == 1 and no_sleep == []


def test_a_transient_failure_reports_the_stack_not_contention(tmp_path,
                                                              no_sleep,
                                                              monkeypatch):
    """A card that is free but whose stack is broken is a different story."""
    monkeypatch.setattr(gpu_probe, "PROBE_LOCK_PATH",
                        str(tmp_path / "probe.lock"))
    monkeypatch.setattr(gpu_probe, "device_admission", lambda env: {
        "checked": True, "usable": True, "device": 0, "reason": "card is idle"})
    monkeypatch.setattr(gpu_probe, "clean_stale_rocm_shm", lambda **kw: [])

    with pytest.raises(RuntimeError) as excinfo:
        _probe(tmp_path, _Runner(failures=99))

    message = str(excinfo.value)
    assert "container's GPU stack" in message
    assert "GPU contention" not in message


def test_admission_is_skipped_when_the_gate_is_off(monkeypatch):
    """``METAINFER_GPU_PREFLIGHT=0`` is the operator's escape valve."""
    monkeypatch.setenv("METAINFER_GPU_PREFLIGHT", "0")
    verdict = gpu_probe.device_admission({"HIP_VISIBLE_DEVICES": "0"})
    assert verdict == {"checked": False, "usable": True,
                       "reason": "admission disabled"}


# ------------------------------------------- a read-only /dev/shm is not a flake

def _deny_shm(monkeypatch, *, errno_=13, error="Permission denied"):
    """Make this process tree look like one under a read-only /dev/shm."""
    monkeypatch.setattr(gpu_probe, "shm_write_check",
                        lambda directory=gpu_probe.SHM_DIR: {
                            "ok": False, "dir": str(directory),
                            "errno": errno_, "error": error,
                            "denied": errno_ in gpu_probe.SHM_DENIED_ERRNOS})


def test_denied_shared_memory_is_diagnosed_and_not_retried(tmp_path, no_sleep,
                                                           monkeypatch):
    """The sandbox failure: deterministic, so no retry budget is spent on it.

    Observed in production: the MetaInfer WebUI had been started from a shell
    under a file sandbox (writes only under its workspace and /tmp), so every
    orchestrator it spawned inherited a read-only /dev/shm. Each attempt died
    with 'shm_open: Permission denied' + 'Can't initialize amdsmi', while the
    same command from an unrestricted shell passed — the failure had to be named
    instead of retried, and attributed to the launcher instead of the container.
    """
    _deny_shm(monkeypatch)
    runner = _Runner(failures=99)

    with pytest.raises(RuntimeError) as excinfo:
        _probe(tmp_path, runner)

    assert len(runner.calls) == 1, (
        "waiting cannot turn a read-only /dev/shm into a writable one")
    assert no_sleep == [], "no backoff is spent on a permission"
    message = str(excinfo.value)
    assert "Permission denied" in message
    assert "/dev/shm" in message
    assert "sandbox" in message and "Restart it outside" in message
    assert "container's GPU stack" not in message, (
        "the container is fine — blaming it sends the operator to the wrong fix")

    snapshot = json.loads(
        (tmp_path / "state" / "gpu_probe_failure.json").read_text())
    assert snapshot["dev_shm_write"]["ok"] is False
    assert snapshot["dev_shm_write"]["denied"] is True
    assert snapshot["attempts_performed"] == 1
    assert snapshot["attempts"] == gpu_probe.probe_attempts(), (
        "the budget is still recorded, so a short report is never mistaken for "
        "an exhausted one")


def test_shared_memory_trouble_that_is_not_a_permission_is_still_retried(
        tmp_path, no_sleep, monkeypatch):
    """Only 'you may not write here' skips the retry: ENOSPC is not a verdict."""
    _deny_shm(monkeypatch, errno_=28, error="No space left on device")
    runner = _Runner(failures=99)

    with pytest.raises(RuntimeError) as excinfo:
        _probe(tmp_path, runner)

    assert len(runner.calls) == gpu_probe.probe_attempts()
    assert no_sleep == list(gpu_probe.RETRY_WAITS_SECONDS)
    message = str(excinfo.value)
    assert "No space left on device" in message
    assert "Restart it outside" not in message, (
        "a full tmpfs is not a sandbox problem")


def test_shared_memory_is_probed_with_the_real_verdict(tmp_path, shm_writable):
    """The check itself: a throwaway file where ``shm_open`` would put one."""
    check = shm_writable
    ok = check(str(tmp_path))
    assert ok["ok"] is True and ok["errno"] is None
    assert not list(tmp_path.iterdir()), "the check cleans up after itself"

    missing = check(str(tmp_path / "does-not-exist"))
    assert missing["ok"] is False and missing["errno"] == 2
    assert missing["denied"] is False, (
        "a missing directory is not confinement: it must not suppress retries")


def test_only_denial_errnos_count_as_confinement():
    assert gpu_probe._shm_denied({"ok": False, "errno": 13})
    assert gpu_probe._shm_denied({"ok": False, "errno": 1})
    assert gpu_probe._shm_denied({"ok": False, "errno": 30})
    assert not gpu_probe._shm_denied({"ok": True})
    assert not gpu_probe._shm_denied({"ok": False, "errno": 28})
    assert not gpu_probe._shm_denied({})

