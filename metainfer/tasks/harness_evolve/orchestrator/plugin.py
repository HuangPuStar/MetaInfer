"""Task plugin descriptor for harness_evolve."""

from metainfer.orchestrator.tasks.base import TaskPlugin


PLUGIN = TaskPlugin(
    task_type="harness-evolve",
    cli_module="metainfer.tasks.harness_evolve.orchestrator.cli",
    phases_module="metainfer.tasks.harness_evolve.orchestrator.phases",
    diagnostic_globs=("*.json", "*.jsonl", "*.md", "*.log"),
)
