"""A dedicated home for the errors DKAO actually produces.

Why a folder and not a wiki page: every one of these errors has cost somebody
hours, and the same *text* keeps coming back with a different root cause. The
WebUI shows the sentence that failed; what an operator needs next to it is
"which class is this, what causes it, what do I do, and has it already been
fixed" — see ``README.md`` and the ``NN-*.md`` symptom files.

``collect_errors.py`` is the machine half: it walks the task state dirs (and the
worker workspaces) under ``nodes/*/``, pulls out every error-ish string, tags it
with a class, and writes ``samples.jsonl`` + ``SUMMARY.md``. Re-run it after a
bad night and the new evidence lands in the repository instead of in a chat log.
"""

from .collect_errors import (
    CLASSES,
    ErrorClass,
    Record,
    classify,
    collect,
    main,
    render_summary,
    scan_task,
)

__all__ = [
    "CLASSES",
    "ErrorClass",
    "Record",
    "classify",
    "collect",
    "main",
    "render_summary",
    "scan_task",
]
