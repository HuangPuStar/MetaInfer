"""Iteration folder management.

Layout (since the refactor):

* iteration CODE lives under ``<cwd>/<task_id>/<NNN>/`` — visible,
  top-level, not hidden.
* per-iteration LOGS (agent prompts, agent stdout/stderr, oracle reports,
  server logs) live under ``<logs_root>/<NNN>/`` where ``logs_root`` is
  typically ``<cwd>/.metainfer/logs/<task_id>/``.
* a snapshot of the previous iteration's diagnostic logs is copied forward
  into the new iteration's logs dir under ``<logs_root>/<NNN>/prev-iter/``
  so the next agent can root-cause the previous C step's failure.

Crash recovery: an iteration is "complete" once it has been closed cleanly
(success or failed). We mark that by writing a :data:`COMPLETED_SENTINEL`
file inside the iter CODE dir as the **last** write of the close path — so
an iteration whose folder lacks the sentinel was abandoned mid-flight by a
crashed orchestrator. :meth:`discard_latest_incomplete` removes the
highest-numbered such folder so a resume can restart that iteration from
scratch.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import List, Optional, Tuple


# Written as the final step of closing an iteration. Presence means the
# orchestrator shut the iteration down cleanly (not killed mid-flight).
COMPLETED_SENTINEL = ".metainfer-completed"

# Subdirectory inside the new iteration's logs dir where the previous
# iteration's diagnostic files land. Keeps the current iter's own logs
# (which start writing immediately) separate from inherited ones.
PREV_ITER_LOGS_SUBDIR = "prev-iter"

# Default diagnostic-glob set: empty. Each task plugin declares its own
# via ``TaskPlugin.diagnostic_globs``. The historical default (oracle /
# judge / test logs) was calc-shaped vocabulary — it now lives in
# gen_infer_framework's TaskPlugin descriptor.
_DEFAULT_DIAGNOSTIC_GLOBS: Tuple[str, ...] = ()

# Files / dirs that the copy-forward rule skips when seeding iteration N
# from iteration N-1's code tree. Without this filter, every new iteration
# inherited the previous run's __pycache__/, stale server logs, leftover
# PID files, and per-iteration bookkeeping — polluting the working
# directory and confusing the implementer. The prompt used to tell the
# agent to clean these up itself (via a manual `cp -r` followed by `rm`),
# but that burned a Bash turn and ~30s of wall clock every iteration for
# no value. The orchestrator now does the cleanup at copy time.
SKIP_ON_COPY = {
    COMPLETED_SENTINEL,
    "__pycache__",
    ".pytest_cache",
    "*.pyc",
    "*.pyo",
    "server.stderr.log",
    "server.stdout.log",
    "server.pid",
    "_import_test_*.py",   # transient smoke-test scaffolding the impl writes
    "*.tmp",
}


def _should_skip_on_copy(name: str) -> bool:
    """Match a filename against :data:`SKIP_ON_COPY` (supports glob)."""
    from fnmatch import fnmatch
    for pat in SKIP_ON_COPY:
        if fnmatch(name, pat):
            return True
    return False


class IterationWorkspace:
    """Owns the numbered iteration directories for one task.

    Two parallel directory trees are maintained:

    * ``iterations_root`` (visible code) — typically ``<cwd>/<task_id>/``
    * ``logs_root`` (hidden metadata + logs) — typically
      ``<cwd>/.metainfer/logs/<task_id>/``. If ``logs_root`` is None the
      workspace falls back to the legacy layout where each iteration's
      logs lived inside its code dir at ``.metainfer-logs/`` (still
      supported so old state directories keep working).
    """

    def __init__(
        self,
        iterations_root: Path,
        logs_root: Optional[Path] = None,
        *,
        diagnostic_globs: Tuple[str, ...] = _DEFAULT_DIAGNOSTIC_GLOBS,
    ) -> None:
        """Construct a workspace.

        ``diagnostic_globs`` is the set of filename patterns copied
        forward from the previous iteration's logs dir into the new
        iteration's ``prev-iter/`` subdir at open time. Pipelines
        typically source this from their TaskPlugin descriptor
        (``plugin.diagnostic_globs``). Empty means no copy-forward —
        appropriate for tasks that don't have iteration-scoped
        diagnostic files.
        """
        self.root = iterations_root
        self.root.mkdir(parents=True, exist_ok=True)
        self.logs_root = logs_root
        self.diagnostic_globs = tuple(diagnostic_globs)
        if self.logs_root is not None:
            self.logs_root.mkdir(parents=True, exist_ok=True)

    def _pad(self, n: int) -> str:
        return f"{n:03d}"

    def logs_dir_for(self, n: int) -> Path:
        """Where iteration ``n``'s logs (prompts, agent stdout, oracle
        reports, server logs, prev-iter snapshot) live.

        New layout: ``<logs_root>/<NNN>/``. Legacy fallback (when
        ``logs_root`` is None): ``<iter_dir>/<NNN>/.metainfer-logs/``.
        """
        if self.logs_root is not None:
            return self.logs_root / self._pad(n)
        return self.iter_dir(n) / ".metainfer-logs"

    def list_iterations(self) -> List[int]:
        nums = []
        for p in self.root.iterdir():
            if p.is_dir() and p.name.isdigit() and len(p.name) == 3:
                nums.append(int(p.name))
        return sorted(nums)

    def latest_number(self) -> int:
        nums = self.list_iterations()
        return nums[-1] if nums else 0

    def latest_complete_number(self) -> int:
        """Highest iteration number whose :data:`COMPLETED_SENTINEL` exists."""
        for n in reversed(self.list_iterations()):
            if self.is_complete(n):
                return n
        return 0

    def open_iteration(self, n: int) -> Path:
        """Open (creating if needed) iteration ``n``'s CODE directory.

        Behavior:
        * n == 1  → empty new dir
        * n  > 1  → if previous iteration exists, copy its CODE forward;
                    else empty

        Additionally, for n > 1, a curated set of diagnostic files from the
        previous iteration's logs dir (server logs, oracle report, judge
        outputs, test logs) is copied into THIS iteration's logs dir under
        :data:`PREV_ITER_LOGS_SUBDIR` so the next agent can inspect the
        actual failure rather than just the short ``failure_reason``
        string carried through :class:`IterationContext`.
        """
        if n < 1:
            raise ValueError("iteration numbers are 1-indexed")
        target = self.root / self._pad(n)
        if target.exists():
            # Even if the code dir already exists, make sure the prev-iter
            # log snapshot has been seeded — a partial setup before a crash
            # could have left it missing.
            if n > 1:
                self._copy_prev_diagnostics(n - 1, n)
            return target
        target.mkdir(parents=True)
        if n > 1:
            prev = self.root / self._pad(n - 1)
            if prev.exists():
                self._copy_code_tree(prev, target)
            # Seed the new iter's logs dir with a snapshot of the previous
            # iter's diagnostics. Lives under logs_dir_for(n)/prev-iter/.
            self._copy_prev_diagnostics(n - 1, n)
        return target

    def _copy_code_tree(self, src: Path, dst: Path) -> None:
        """Copy ``src`` (prev iter code dir) into ``dst`` (new iter code dir),
        skipping the per-iteration cruft listed in :data:`SKIP_ON_COPY`.

        ``shutil.copytree`` with ``dirs_exist_ok`` is the workhorse, but it
        has no built-in exclude list — so we walk the tree ourselves, filter
        entries, and recreate dir / file structure on the destination. This
        runs once per iteration at open time; the implementer agent receives
        a clean working directory and can start editing immediately.
        """
        dst.mkdir(parents=True, exist_ok=True)
        for entry in src.iterdir():
            if _should_skip_on_copy(entry.name) or entry.name.startswith("."):
                continue
            # Skip symlinks outright. An agent may link out of its
            # workspace into the repo (e.g. ``nodes -> /repo/nodes`` to reach
            # the root); following that link here would copy an external tree
            # into the next iteration. When the link target contains the
            # workspace itself (``nodes/.../workspaces/<id>/001/``), the
            # recursion nests infinitely and blows the path-length limit
            # (OSError [Errno 36]). The agent recreates any link it needs in
            # the new iteration, so dropping it at copy time is safe.
            if entry.is_symlink():
                continue
            target_entry = dst / entry.name
            if entry.is_dir():
                # Recurse, applying the same skip filter inside the subtree.
                self._copy_code_tree(entry, target_entry)
            elif entry.is_file():
                shutil.copy2(entry, target_entry)

    def _copy_prev_diagnostics(self, prev_n: int, target_n: int) -> None:
        """Copy :attr:`diagnostic_globs` from logs_dir_for(prev_n) into
        logs_dir_for(target_n)/PREV_ITER_LOGS_SUBDIR/. Best-effort."""
        if not self.diagnostic_globs:
            return
        prev_logs = self.logs_dir_for(prev_n)
        if not prev_logs.is_dir():
            return
        dst_logs = self.logs_dir_for(target_n) / PREV_ITER_LOGS_SUBDIR
        dst_logs.mkdir(parents=True, exist_ok=True)
        for pattern in self.diagnostic_globs:
            for src in prev_logs.glob(pattern):
                if not src.is_file():
                    continue
                # Skip the prev-iter subdir itself if it somehow matches
                # (defensive against nested inheritance).
                if src.parent.name == PREV_ITER_LOGS_SUBDIR:
                    continue
                try:
                    shutil.copy2(src, dst_logs / src.name)
                except OSError:
                    # best-effort — a missing diag file is fine
                    pass

    def iter_dir(self, n: int) -> Path:
        return self.root / self._pad(n)

    # ------------------------------------------------------------------ #
    # Completion / crash recovery
    # ------------------------------------------------------------------ #

    def mark_complete(self, n: int) -> None:
        """Mark iteration ``n`` as cleanly closed.

        Idempotent. The sentinel file is written *after* the iteration
        record is finalized, so its presence is a durable signal that the
        orchestrator was alive through the close path.
        """
        d = self.iter_dir(n)
        d.mkdir(parents=True, exist_ok=True)
        (d / COMPLETED_SENTINEL).touch()

    def is_complete(self, n: int) -> bool:
        """Has iteration ``n`` been closed cleanly?"""
        return (self.iter_dir(n) / COMPLETED_SENTINEL).exists()

    def discard_latest_incomplete(self) -> Optional[int]:
        """If the highest-numbered iteration is incomplete, delete its folder.

        Iterations are created sequentially, so at most one (the top) can
        be incomplete at resume time. Returns the deleted iteration's
        number, or ``None`` if every existing iteration is complete.

        Does NOT touch the state-store JSON record — the caller is
        responsible for that (it typically wants to read the record's
        ``start_phase`` before deleting it).
        """
        nums = self.list_iterations()
        if not nums:
            return None
        top = nums[-1]
        if self.is_complete(top):
            return None
        shutil.rmtree(self.iter_dir(top), ignore_errors=True)
        return top
