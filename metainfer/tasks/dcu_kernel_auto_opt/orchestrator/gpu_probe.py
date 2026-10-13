"""Run the trusted probe subprocess, surviving a transiently broken GPU stack.

``w8a8_bench.py --probe`` initialises a device, so it goes through exactly the
same ROCm/amdsmi startup as a measurement. When *that* startup fails, the failure
is environmental, not the candidate's:

    RuntimeError: ... --probe failed (3): shm_open: Permission denied
    UserWarning: Can't initialize amdsmi - Error code: 32

That came out of the cheap, implementation-free part of Generate (the scaffold
preflight), where the probe answers only "is one device visible and is HIP Graph
available". Two real observations shaped this module:

* the failure is *transient and concurrent*. The identical command, run by hand
  minutes later on the same machine, the same repository and each of the four
  GPUs, printed the expected JSON with an empty stderr — yet a task that
  initialises four devices at once failed every time, with three different
  low-level symptoms across reports (``shm_open: Permission denied``,
  ``shm_open: Invalid argument``, ``fchmod: Bad file descriptor``, always next to
  ``Can't initialize amdsmi - Error code: 32``). The ROCm/amdsmi startup is a
  shared-memory handshake over ``/dev/shm/rocm_smi_card*``, and concurrent
  starters race on those segments;
* one such blip used to kill a multi-hour task, because a single failed probe
  raised immediately.

So the probe is (a) *serialised* across processes with a container-wide lock, so
the stack's handshake is never started by several processes at once, and (b)
retried a couple of times with a growing wait, long enough for a broken
handshake to heal. It is **always attempted**: waiting out a busy card is the
measurement gate's job (it knows the device set and waits up to 24 h), and
short-circuiting that here would stop runs that used to proceed on a shared
machine. Whether the card was busy is recorded, so the failure message can say
which of the two problems it was. Retrying cannot weaken the check: the same
two assertions (exactly one visible device, HIP Graph available) are applied to
whatever the successful attempt printed. When every attempt fails, the error is
enriched with what an operator would otherwise have to reproduce by hand, and a
diagnostic snapshot is written next to the task's other evidence.

One failure does **not** heal by waiting: the same ``shm_open: Permission
denied`` pair also appears when the *launcher* runs inside a file sandbox that
makes everything outside its workspace read-only — ``/dev/shm`` included. ROCm
and amdsmi bring the stack up through ``/dev/shm`` rendezvous files
(``rocm_smi_card*``), so such a process tree can never see a device, and
retrying only repeats the denial. That case is therefore *measured* before the
first attempt (see :func:`shm_write_check`), reported as its own cause, and
never retried: the fix belongs to whoever started the WebUI/orchestrator, not to
the candidate kernel.
"""

from __future__ import annotations

import errno
import fcntl
import glob
import json
import os
import shutil
import subprocess
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

#: ``shm_open: Permission denied`` / ``Can't initialize amdsmi`` — the fragment
#: amdsmi's C library prints to stderr when its shared-memory handshake breaks.
#: Matched to *explain* the failure; the retry never depends on the diagnosis.
TRANSIENT_GPU_MARKERS = ("shm_open", "amdsmi", "hsa_", "rocr", "fchmod",
                         "rocm_smi", "bad file descriptor")

#: ``/dev/shm`` files that *may* be cleaned, and only when an operator asks for
#: it. Deleting them is **off by default**: they are live rendezvous files, and a
#: process that opened one keeps a handle to the now-unlinked inode, so the next
#: ``fchmod``/``shm_open`` on it fails with "Bad file descriptor" / "Invalid
#: argument" — precisely the failure that was being investigated. Cleaning them
#: can only be justified on a quiet machine, so it is opt-in.
SHM_GLOBS = ("/dev/shm/rocm_smi_card*",)
CLEAN_SHM_ENV = "METAINFER_GPU_PROBE_CLEAN_SHM"

#: Where POSIX shared memory lives on Linux (``shm_open("/x")`` is
#: ``open("/dev/shm/x")``). ROCm needs to *write* here, so a read-only
#: ``/dev/shm`` means no device, ever.
SHM_DIR = "/dev/shm"

#: Errnos that mean "this process may not write there" — i.e. confinement, a
#: deterministic condition no wait can clear. Anything else (``ENOSPC``,
#: ``EMFILE``, …) is reported but still retried like an ordinary transient
#: failure, so a false negative here can only cost time, never a verdict.
SHM_DENIED_ERRNOS = (errno.EACCES, errno.EPERM, errno.EROFS)

#: Waits before each retry. The handshake that breaks here is repaired by a
#: *later, quieter* start, so the waits are generous: one attempt plus these is
#: at most ~2.5 minutes, still inside the ordinary task budget.
RETRY_WAITS_SECONDS = (5.0, 20.0)

#: One lock for the whole container: only one process may start the GPU stack at
#: a time. This is the actual fix for the concurrent-init race — retrying inside
#: a storm of starters only reproduces the storm.
PROBE_LOCK_PATH = "/tmp/metainfer-gpu-probe.lock"

#: An operator can disable the serialisation (e.g. to prove it was the cause).
PROBE_LOCK_ENV = "METAINFER_GPU_PROBE_LOCK"


def probe_attempts(wait_seconds: Optional[tuple] = None,
                   ) -> int:
    """How many probe attempts a caller should make."""
    waits = RETRY_WAITS_SECONDS if wait_seconds is None else tuple(wait_seconds)
    return len(waits) + 1


def shm_write_check(directory: str = SHM_DIR) -> Dict[str, Any]:
    """Can **this** process create a POSIX shared-memory object?

    Returns ``{"ok": bool, ...}`` and never raises. The check creates (and
    immediately removes) one throwaway file, which is exactly what
    ``shm_open(name, O_CREAT)`` does internally, so a denial here is the denial
    the GPU stack would hit a moment later.

    The failure this exists for: the MetaInfer WebUI (or any orchestrator) was
    started from a shell that runs under a file sandbox — Landlock/bwrap-style
    confinement grants writes to a couple of roots (the workspace, ``/tmp``) and
    makes the rest of the filesystem read-only, ``/dev/shm`` included. Every
    orchestrator the launcher spawns inherits that domain, and a child cannot
    drop it, so the probe fails identically at every attempt while the very same
    command run from an unrestricted shell succeeds. Naming it separately is the
    difference between "the container's GPU stack is broken" (misleading: it
    sends the operator to the wrong machine) and "restart the WebUI outside the
    sandbox" (the actual fix).
    """
    try:
        fd, path = tempfile.mkstemp(prefix=".metainfer-shm-check-",
                                    dir=directory)
    except OSError as exc:
        return {
            "ok": False,
            "dir": str(directory),
            "errno": exc.errno,
            "error": exc.strerror,
            "denied": exc.errno in SHM_DENIED_ERRNOS,
        }
    try:
        os.close(fd)
    except OSError:
        pass
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
    return {"ok": True, "dir": str(directory), "errno": None, "error": None,
            "denied": False}


def _shm_denied(check: Dict[str, Any]) -> bool:
    """Whether a failed :func:`shm_write_check` proves confinement.

    Only the "you may not write here" errnos qualify; a full ``/dev/shm`` or an
    exhausted fd table is a different problem and keeps the ordinary retry path.
    """
    return bool(check) and not check.get("ok", True) and bool(
        check.get("denied") or check.get("errno") in SHM_DENIED_ERRNOS)


def clean_stale_rocm_shm(*, min_age_seconds: float = 60.0,
                         now: Optional[float] = None,
                         force: bool = False) -> List[str]:
    """Remove idle amdsmi shared-memory files; return the names removed.

    **Off unless ``force`` (or ``METAINFER_GPU_PROBE_CLEAN_SHM=1``).** Unlinking
    a file another process already opened leaves that process holding a handle to
    a dead inode, and its next ``fchmod`` on it fails with
    ``Bad file descriptor`` — the cleanup was creating the symptom it was meant
    to clear. Only an operator who knows the machine is quiet should ask for it.
    """
    if not force and str(os.environ.get(CLEAN_SHM_ENV, "")).strip().lower() \
            not in {"1", "on", "true", "yes"}:
        return []
    clock = time.time() if now is None else float(now)
    removed: List[str] = []
    for pattern in SHM_GLOBS:
        for name in glob.glob(pattern):
            path = Path(name)
            try:
                if clock - path.stat().st_mtime < float(min_age_seconds):
                    continue
                path.unlink()
                removed.append(path.name)
            except OSError:
                continue
    return removed


def gpu_probe_diagnostics(*, command: List[str], attempts: int,
                          env: Optional[Dict[str, str]] = None,
                          waits: Optional[List[str]] = None,
                          state_dir: Optional[Path] = None,
                          attempts_performed: Optional[int] = None,
                          now: Optional[float] = None) -> Dict[str, Any]:
    """Everything an operator needs to explain a probe that will not start."""
    diag: Dict[str, Any] = {
        "ts": time.time() if now is None else float(now),
        "attempts": attempts,
        "command": list(command),
        "uid": os.getuid(),
        "gid": os.getgid(),
        # The child's own environment, not ours: the probe is pinned to a
        # device by HIP_VISIBLE_DEVICES, and that is the first thing to check.
        "visible_devices_env": (env or os.environ).get("HIP_VISIBLE_DEVICES"),
        # Why each attempt did not produce a device: "card was busy" (waiting)
        # versus "the stack did not start" (retrying).
        "waits": list(waits or []),
        # Whether this process tree may write /dev/shm at all. When it may not,
        # no attempt can ever see a device and no retry is spent on it.
        "dev_shm_write": shm_write_check(),
        "dev_shm": [],
    }
    if attempts_performed is not None:
        # Fewer than the budget when the failure was provably deterministic.
        diag["attempts_performed"] = int(attempts_performed)
    diag["admission"] = device_admission(env or {})
    try:
        for entry in sorted(Path("/dev/shm").iterdir()):
            try:
                info = entry.lstat()
            except OSError:
                continue
            diag["dev_shm"].append({
                "name": entry.name,
                "mode": oct(info.st_mode & 0o777),
                "uid": info.st_uid,
                "size": info.st_size,
                "mtime": info.st_mtime,
            })
    except OSError as exc:
        diag["dev_shm_error"] = repr(exc)
    for fd_name, limit_file in (("limits", "/proc/self/limits"),):
        try:
            diag[fd_name] = Path(limit_file).read_text(
                encoding="utf-8", errors="replace")
        except OSError as exc:
            diag[fd_name] = repr(exc)
    if state_dir is not None:
        try:
            target = Path(state_dir) / "gpu_probe_failure.json"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(diag, ensure_ascii=False, indent=2),
                              encoding="utf-8")
            diag["written_to"] = str(target)
        except OSError:
            pass
    return diag


def _looks_transient(exc: BaseException) -> bool:
    """Whether this probe failure is worth another attempt.

    Two classes qualify, and both describe the *container*, not the candidate:

    * the GPU stack's handshake broke (``shm_open`` / ``amdsmi`` / a HIP runtime
      error) — the failure observed in production;
    * the probe never returned, so device initialisation is wedged.

    Everything else (a missing module, a traceback from the harness) fails
    immediately: retrying it would only delay a real report by 25 seconds.
    """
    if isinstance(exc, subprocess.TimeoutExpired):
        return True
    text = f"{exc} {getattr(exc, 'stderr', '') or ''}".lower()
    return any(marker in text for marker in TRANSIENT_GPU_MARKERS)


def _probe_lock_enabled() -> bool:
    """Serialisation is on unless the operator turns it off explicitly."""
    value = str(os.environ.get(PROBE_LOCK_ENV, "")).strip().lower()
    return value not in {"0", "off", "false", "no"}


@contextmanager
def gpu_probe_lock(*, timeout_seconds: float = 600.0):
    """Let one process at a time start the GPU stack.

    ``flock`` on a file in ``/tmp`` is container-wide and costs nothing when
    uncontended; when contended, the waiters queue instead of racing on the
    amdsmi shared-memory handshake. On any problem with the lock file itself the
    probe simply proceeds unlocked: a lock must never be the reason a task
    cannot measure.
    """
    if not _probe_lock_enabled():
        yield False
        return
    handle = None
    acquired = False
    try:
        handle = open(PROBE_LOCK_PATH, "a+")
        deadline = time.time() + float(timeout_seconds)
        while True:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
                break
            except OSError:
                if time.time() >= deadline:
                    break
                time.sleep(0.5)
        yield acquired
    except OSError:
        yield False
    finally:
        if handle is not None:
            try:
                if acquired:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
            try:
                handle.close()
            except OSError:
                pass


def _admission_enabled() -> bool:
    """The GPU admission switch, shared with the measurement gate.

    ``METAINFER_GPU_PREFLIGHT=0`` turns device admission off everywhere; the
    probe must honour the same switch rather than invent its own policy.
    """
    try:
        from .gpu_preflight import preflight_enabled
        return bool(preflight_enabled())
    except Exception:  # noqa: BLE001 - fail open, like the gate does not
        return True


def _target_device(env: Dict[str, str]) -> Optional[int]:
    raw = str((env or {}).get("HIP_VISIBLE_DEVICES") or "").strip()
    if not raw:
        return None
    try:
        return int(raw.split(",")[0])
    except (TypeError, ValueError):
        return None


def device_admission(env: Dict[str, str]) -> Dict[str, Any]:
    """Is the device this probe would use actually free right now?

    Measured evidence, across three reports: a probe started while another job
    was running on the card failed *every* attempt — ``shm_open: Permission
    denied`` / ``Invalid argument``, ``fchmod: Bad file descriptor``, always next
    to ``Can't initialize amdsmi - Error code: 32`` — while the same command on a
    quiet card passed first try. Starting the ROCm stack on a busy card is what
    breaks it, so a busy card is waited out instead of being hammered.
    """
    if not _admission_enabled():
        return {"checked": False, "usable": True, "reason": "admission disabled"}
    device = _target_device(env)
    if device is None:
        return {"checked": False, "usable": True, "reason": "no device pinned"}
    try:
        from .gpu_preflight import check_gpu, sample_gpu_state, total_vram_gb
        state = sample_gpu_state([device], samples=1).get(device) or {}
        verdict = check_gpu(device, state, total_gb=total_vram_gb(device))
    except Exception as exc:  # noqa: BLE001 - never block on our own bookkeeping
        return {"checked": False, "usable": True,
                "reason": f"state unreadable: {exc!r}"}
    reasons = list(verdict.get("reasons") or [])
    return {
        "checked": True,
        "usable": bool(verdict.get("usable")),
        "device": device,
        "vram_percent": state.get("vram_max_percent",
                                  state.get("vram_percent")),
        "util_percent": state.get("util_max_percent",
                                  state.get("util_percent")),
        "reason": "; ".join(str(r) for r in reasons) or "card is idle",
    }


def _record_recovered(state_dir: Optional[Path], attempt: int) -> None:
    """Note that a retry (not the first attempt) got a device.

    Not an error: it is the evidence that the stack was momentarily unusable,
    which is what tells an operator the serialisation/retry earned its keep.
    """
    if state_dir is None:
        return
    try:
        target = Path(state_dir) / "gpu_probe_recovered.jsonl"
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({"ts": time.time(), "attempt": attempt}) + "\n")
    except OSError:
        pass


def run_gpu_probe(*, harness: Path, source: Path, env: Dict[str, str],
                  runner: Callable[..., "subprocess.CompletedProcess[str]"],
                  timeout: int = 120,
                  state_dir: Optional[Path] = None,
                  waits: Optional[tuple] = None,
                  ) -> "subprocess.CompletedProcess[str]":
    """Run the device probe, retrying a broken GPU stack.

    ``runner`` is the caller's own subprocess helper (``real_pipeline._run``),
    injected so this module stays free of import cycles and is trivial to test.
    Raises the last failure with diagnostics attached when every attempt fails.
    """
    command = [
        "python3", str(harness),
        "--source", str(source),
        "--m", "1", "--n", "1", "--k", "1",
        "--probe",
    ]
    wait_list = tuple(RETRY_WAITS_SECONDS if waits is None else waits)
    attempts = len(wait_list) + 1
    # Measure the determinism of the environment *before* spending attempts on
    # it: a process tree that cannot write /dev/shm cannot bring the GPU stack
    # up, so "retry" would be the same experiment with the same answer.
    shm = shm_write_check()
    confined = _shm_denied(shm)
    last_error: Optional[BaseException] = None
    performed = 0
    for attempt in range(1, attempts + 1):
        performed = attempt
        try:
            # Hold the container-wide lock for the whole (short) probe: the
            # failure being defended against is *concurrent* device startup.
            with gpu_probe_lock() as held:
                result = runner(command, cwd=source, env=env, timeout=timeout)
            if attempt > 1:
                _record_recovered(state_dir, attempt)
            return result
        except (RuntimeError, subprocess.TimeoutExpired) as exc:  # noqa: PERF203
            last_error = exc
            transient = _looks_transient(exc)
            if attempt >= attempts or not transient or confined:
                # Nothing left to try, a failure that is not the transient stack
                # problem this module exists for, or a condition that waiting
                # cannot change: fail with evidence.
                break
            # A plain wait, and nothing else: touching /dev/shm here is what
            # produced the "Bad file descriptor" failures.
            time.sleep(wait_list[attempt - 1])
    diag = gpu_probe_diagnostics(command=command, attempts=attempts, env=env,
                                 state_dir=state_dir,
                                 attempts_performed=performed)
    # The probe is always attempted, whatever the cards are doing: waiting for a
    # quiet card is DKAO's measurement gate's job, and pre-empting it here would
    # stop runs that used to proceed fine. The verdict is reported so a *busy*
    # card can be told apart from a broken stack in the failure message.
    busy = bool(diag.get("admission", {}).get("checked")) and not \
        diag["admission"].get("usable", True)
    if confined:
        # Deterministic and unfixable from inside the task: say what it is and
        # who has to change it, instead of blaming the container's GPU stack.
        hint = (
            "This process tree may not write to " + str(shm.get("dir")) +
            f" (shm_open: {shm.get('error')}, errno {shm.get('errno')}). ROCm and "
            "amdsmi bring the GPU stack up through /dev/shm rendezvous files, so "
            "no device can appear while that path is read-only; the retry budget "
            "was not spent because waiting cannot change a permission. The usual "
            "cause is the launcher — the MetaInfer WebUI, or the shell that "
            "started the orchestrator — running inside a file sandbox that only "
            "allows writes under its workspace and /tmp. Restart it outside that "
            "sandbox (an unrestricted shell) and relaunch the task; a child "
            "process cannot drop the sandbox by itself."
        )
    elif not shm.get("ok", True):
        # Not a permission problem, but /dev/shm is still unusable: the GPU
        # stack cannot come up either way, and the errno says why.
        hint = (
            "This process tree cannot create shared memory in "
            f"{shm.get('dir')} (shm_open: {shm.get('error')}, errno "
            f"{shm.get('errno')}), which is where ROCm and amdsmi keep their "
            "rendezvous files: no device can appear until /dev/shm is usable "
            "(free space, fd limits, a mounted tmpfs)."
        )
    elif busy:
        hint = (
            "The device was busy with another job while these attempts ran "
            f"({diag['admission'].get('reason')}), so this may be contention rather "
            "than a broken container: try again, or free the card."
        )
    else:
        hint = "This is the container's GPU stack, not the kernel under test."
    raise RuntimeError(
        f"GPU probe failed after {performed} attempt(s) "
        f"({type(last_error).__name__}): {last_error}\n{hint} "
        "Diagnostics: " + json.dumps(diag, ensure_ascii=False)[:1500]
    ) from last_error
