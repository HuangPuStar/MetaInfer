"""CLI entry point for the evalscope-correctness orchestrator subprocess.

The launcher spawns::

    python -m metainfer.tasks.evalscope_correctness.orchestrator.cli \\
        run <requirements.json> --state-dir … --workspace-dir …

Contract required by the framework: ``run`` subcommand + ``--state-dir`` and
``--workspace-dir`` flags.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="metainfer-evalscope-correctness",
        description="MetaInfer EvalScope correctness orchestrator.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    run_p = sub.add_parser("run", help="Run the EvalScope correctness evaluation")
    run_p.add_argument("requirements", type=Path, help="Path to requirements.json")
    run_p.add_argument("--state-dir", type=Path, default=None,
                       help="Metadata dir (run.json, timeline.jsonl, result.json).")
    run_p.add_argument("--workspace-dir", type=Path, default=None,
                       help="Generated-artifacts dir (raw EvalScope outputs).")

    args = parser.parse_args(argv)

    if args.cmd == "run":
        from .orchestrator import run_with_requirements
        return run_with_requirements(
            requirements_path=args.requirements,
            state_dir=args.state_dir,
            workspace_dir=args.workspace_dir,
        )
    return 1


if __name__ == "__main__":
    sys.exit(main())
