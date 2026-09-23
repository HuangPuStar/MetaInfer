"""harness_evolve — AHE outer-loop task type for MetaInfer.

Drives dcu_kernel_auto_opt task instances as evaluation units, per
``MetaInfer/docs/dkao_harness_eval_protocol.md`` (evaluation protocol v2) and
``MetaInfer/docs/ahe_dkao_integration_plan.md``.

This is the "first usable version": a headless orchestrator running the AHE
iteration layout with pluggable evaluators/evolvers (dry-run default; DKAO-CLI
and AgentEvolver reserved for worker29 validation), plus read-only WebUI routes.
"""

from .orchestrator import plugin as _task_plugin  # noqa: F401
from .server import plugin as _web_plugin  # noqa: F401
