"""evalscope-correctness orchestrator package.

Self-contained supervisor + EvalScope runner. The framework
(:mod:`metainfer.orchestrator`) never imports this pipeline directly — it
dispatches to the CLI module declared on :data:`plugin.PLUGIN`.

Layout::

    plugin.py          TaskPlugin descriptor
    cli.py             ``run <req.json> --state-dir … --workspace-dir …``
    config.py          parse + validate the evaluation request (from form.yaml)
    orchestrator.py    supervisor lifecycle: StateStore, PID/signal handling,
                       per-dataset runner, atomic result.json
    runner.py          launch an isolated EvalScope child process per dataset
    evalscope_worker.py  the child: build TaskConfig, run_task, emit a
                       self-describing ``attempt.json`` (never the secret)
    report.py          normalize EvalScope reports → result.json (completeness
                       vs quality-gate separation), all pure + testable
"""

from metainfer.orchestrator.tasks import register
from .plugin import PLUGIN

register(PLUGIN)
