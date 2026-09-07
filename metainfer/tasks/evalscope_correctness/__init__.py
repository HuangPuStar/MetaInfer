"""evalscope-correctness — evaluate an OpenAI-compatible endpoint with
EvalScope and report correctness results.

A self-contained task plugin: run EvalScope against a user-supplied,
already-running OpenAI-compatible chat endpoint, preserve the raw EvalScope
artifacts under the workspace, and surface a normalized result (per-dataset
primary score / sample count / optional quality-gate verdict) in the WebUI.

Design notes
------------
* This is a **single-run** task — no iteration loop, no shared state graph,
  no sub-agent pipeline. The "orchestrator" process here is really a thin
  supervisor that runs EvalScope in an isolated child process per dataset.
* Execution **completeness** (did EvalScope evaluate every sample without
  truncation / errors / count mismatch) is tracked separately from the
  optional **model-quality gate** (minimum per-dataset accuracy/pass@1 the
  user may configure). A run that completes but fails its quality gate is
  still a *complete* evaluation (``final_status="success"``); only infra /
  config / incomplete-result failures surface as ``stopped``. The
  authoritative pass/fail for quality lives in ``state_dir/result.json``.
* The API secret is never persisted in ``requirements.json`` — only the name
  of an environment variable holding the key is stored, and the key is
  copied only into the child process's environment at run time.

Importing this package registers the orchestrator ``TaskPlugin`` and the
web ``WebPlugin`` (the canonical single discovery point for new task types).
"""

from .orchestrator import plugin as _task_plugin  # noqa: F401 — registers TaskPlugin
from .server import plugin as _web_plugin  # noqa: F401 — registers WebPlugin
