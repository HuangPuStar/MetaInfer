"""EvalScope child worker — runs one dataset evaluation in isolation.

The supervisor launches this module as a subprocess *per dataset*:

    python -m metainfer.tasks.evalscope_correctness.orchestrator.evalscope_worker

Non-secret config arrives on **stdin** as one JSON line; the API key is
delivered only via the child's ``EVALSCOPE_API_KEY`` environment variable
(or ``EVALSCOPE_*_KEY`` matching ``api_key_env_var``). The worker never
reads, writes, or logs the secret.

Keeping EvalScope in an isolated child process (rather than calling
``run_task`` inside the orchestrator) protects MetaInfer's process from
EvalScope's heavy imports / logging reconfiguration / threads, and gives
the supervisor a hard wall-clock + signal boundary around each dataset.

Design invariants:
* Runs exactly the datasets listed in the stdin config (the supervisor
  already narrowed it to one) and writes results into ``work_dir``.
* Exit code 0 == EvalScope reported success. Any exception is printed to
  stderr (never the secret) and surfaced as a nonzero exit so the
  supervisor records the dataset as not-produced.
"""

from __future__ import annotations

import json
import sys
from typing import Any, Dict, Optional


def _load_config() -> Dict[str, Any]:
    """Read the non-secret config JSON from stdin."""
    raw = sys.stdin.read()
    try:
        cfg = json.loads(raw)
    except ValueError as exc:
        raise RuntimeError(f"invalid config on stdin: {exc}") from exc
    if not isinstance(cfg, dict):
        raise RuntimeError("config on stdin must be a JSON object")
    return cfg


def _build_task_config(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Construct the EvalScope ``TaskConfig`` payload (as a dict).

    We pass a plain dict to :func:`evalscope.run_task`, which coerces it
    into a ``TaskConfig`` internally — so the worker needs no direct import
    of pydantic ``SecretStr`` or the config class.
    """
    api_key = _resolve_api_key(cfg.get("api_key_env_var"))

    task: Dict[str, Any] = {
        "model": cfg["model"],
        "model_id": cfg.get("model_id") or cfg["model"],
        "api_url": cfg["api_url"],
        "api_key": api_key,  # SecretStr is derived by TaskConfig's validator
        "eval_type": "openai_api",
        "eval_backend": "Native",
        "datasets": list(cfg["datasets"]),
        # limit is per-subset; None = full dataset.
        "limit": cfg.get("limit"),
        # Remote (openai_api) defaults eval_batch_size to 8 unless set —
        # correctness evals force an explicit, conservative value.
        "eval_batch_size": int(cfg.get("eval_batch_size") or 1),
        "seed": int(cfg.get("seed") or 42),
        "no_timestamp": True,
        "work_dir": cfg["work_dir"],
        "collect_perf": False,
        "generation_config": {
            "temperature": float(cfg.get("temperature") or 0.0),
            "max_tokens": int(cfg.get("max_tokens") or 8192),
            "timeout": float(cfg.get("timeout_seconds") or 300.0),
        },
    }
    if cfg.get("dataset_cache_dir"):
        task["dataset_dir"] = cfg["dataset_cache_dir"]
    if cfg.get("needs_sandbox"):
        # Reference scoring executes generated code (e.g. HumanEval). The
        # supervisor preflights Docker availability; enabling the sandbox
        # here keeps execution off the MetaInfer host.
        task["use_sandbox"] = True
    return task


def _resolve_api_key(env_var: Optional[str]) -> str:
    """Return the key to send, or ``EMPTY`` for an unauthenticated endpoint.

    The secret (if any) is read from this child's own environment — the
    supervisor copied it here. It is never part of the config that crossed
    stdin.
    """
    if env_var:
        import os
        value = os.environ.get(env_var)
        if value:
            return value
    return "EMPTY"


def main(argv: Optional[list] = None) -> int:
    try:
        cfg = _load_config()
        task = _build_task_config(cfg)
    except Exception as exc:  # noqa: BLE001 — surface any config error
        print(f"[evalscope-worker] config error: {exc}", file=sys.stderr)
        return 2

    try:
        from evalscope import run_task  # lazy: heavy import stays in this child
    except Exception as exc:  # noqa: BLE001
        print(
            f"[evalscope-worker] EvalScope is not importable here: {exc}. "
            "Install with: pip install 'evalscope>=1.11,<2'",
            file=sys.stderr,
        )
        return 3

    try:
        run_task(task)
    except Exception as exc:  # noqa: BLE001 — turn any failure into exit code
        # Never print the api key; the config/exception may embed task dicts,
        # so only the exception type + message go to stderr.
        print(f"[evalscope-worker] run failed: {type(exc).__name__}: {exc}",
              file=sys.stderr)
        return 4
    return 0


if __name__ == "__main__":
    sys.exit(main())
