"""Child-process handles: spawn, watch, terminate.

Why this exists
---------------
A question runs as a real DKAO child task for hours, and HE has to be able to
stop that child when the round itself is over — most importantly when the child
outstays its timeout (``child_timeout_minutes``) and would otherwise hold a
device forever.

* ``spawn`` starts the child in its own session, so the child and everything it
  spawned (agent sessions, compilers, benchmark subprocesses) can be signalled
  as one group;
* ``terminate`` escalates ``SIGTERM`` → ``SIGKILL`` on that group.

What is deliberately **not** here any more: freezing (``SIGSTOP``/``SIGCONT``).
It existed to pause a child whose device had been taken over — exactly the
"HE manages the environment" coupling that FLOW.md §0 removed. Whether a card is
clean enough to measure on is DKAO's verdict, taken in the child's own
measurement gate, and the child's contamination handling deals with a round that
was measured on a shared device. A stopped process keeps its VRAM anyway, so
pausing never handed the card to anybody.
"""

from __future__ import annotations

import os
import signal
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence


class ChildProcess:
    """One child task under process control."""

    def __init__(self, proc: "subprocess.Popen[Any]") -> None:
        self.proc = proc
        self.pid = int(proc.pid)
        # start_new_session=True made the child a session/group leader, so the
        # whole tree shares this pgid.
        try:
            self.pgid = os.getpgid(self.pid)
        except OSError:
            self.pgid = self.pid
        self.terminated: bool = False
        self.terminate_reason: str = ""

    # ------------------------------------------------------------- queries
    def poll(self) -> Optional[int]:
        return self.proc.poll()

    def alive(self) -> bool:
        return self.proc.poll() is None

    # ------------------------------------------------------------- control
    def _signal_group(self, sig: int) -> bool:
        """Signal the whole process group; fall back to the child alone."""
        try:
            os.killpg(self.pgid, sig)
            return True
        except OSError:
            pass
        try:
            os.kill(self.pid, sig)
            return True
        except OSError:
            return False

    def terminate(self, *, reason: str = "", grace_s: float = 20.0,
                  now: Optional[float] = None) -> bool:
        """Stop the child for good (``SIGTERM`` then ``SIGKILL``)."""
        if self.terminated:
            return False
        self.terminate_reason = reason
        self._signal_group(signal.SIGTERM)
        deadline = time.time() + max(0.0, float(grace_s))
        while self.alive() and time.time() < deadline:
            time.sleep(0.2)
        if self.alive():
            self._signal_group(signal.SIGKILL)
        self.terminated = True
        return True

    def state(self) -> Dict[str, Any]:
        return {
            "pid": self.pid,
            "pgid": self.pgid,
            "alive": self.alive(),
            "terminated": self.terminated,
            "terminate_reason": self.terminate_reason,
        }


def spawn(command: Sequence[str], *, cwd: str, env: Dict[str, str],
          log_path: Path) -> ChildProcess:
    """Start a child task in its own session (so it can be signalled as a tree)."""
    log = log_path.open("w", encoding="utf-8")
    proc = subprocess.Popen(
        list(command), cwd=cwd, env=env, stdout=log,
        stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
        text=True, start_new_session=True,
    )
    log.close()          # the child keeps its own descriptor
    return ChildProcess(proc)


class ProcessRegistry:
    """Live child handles, keyed by question id (thread-safe enough for us)."""

    def __init__(self) -> None:
        self._children: Dict[str, ChildProcess] = {}
        self._lock = threading.Lock()

    def add(self, question_id: str, child: ChildProcess) -> None:
        with self._lock:
            self._children[question_id] = child

    def get(self, question_id: str) -> Optional[ChildProcess]:
        with self._lock:
            return self._children.get(question_id)

    def drop(self, question_id: str) -> None:
        with self._lock:
            self._children.pop(question_id, None)

    def items(self) -> List[Any]:
        with self._lock:
            return list(self._children.items())

    def state(self) -> Dict[str, Any]:
        return {qid: child.state() for qid, child in self.items()}
