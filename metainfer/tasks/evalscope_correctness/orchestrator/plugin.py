"""TaskPlugin descriptor for evalscope-correctness.

This task has no iteration loop and no shared state graph, so
``phases_module`` is empty (allowed — see :class:`TaskPlugin`) and
``diagnostic_globs`` is empty (nothing is copied forward between
iterations that never exist).
"""

from metainfer.orchestrator.tasks.base import TaskPlugin

PLUGIN = TaskPlugin(
    task_type="evalscope-correctness",
    cli_module="metainfer.tasks.evalscope_correctness.orchestrator.cli",
    phases_module="",
    diagnostic_globs=(),
)
