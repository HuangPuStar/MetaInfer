"""Validation budget knobs shared by production DKAO tasks and AHE children.

Two dimensions of the final serial validation are configurable without
touching the algorithmic path:

* **scope** — which shapes the final validation must cover: ``api`` (every
  shape of the frozen operator API, incl. un-optimized fallback shapes) or
  ``task`` (only the shapes this task optimized). AHE evaluates a single
  question per child, so the api-wide regression sweep is pure overhead
  there; production tasks keep the full sweep by default.
* **bench profile** — sampling density of each benchmark: ``full`` (the
  bench asset defaults) or ``quick`` (small warmup/sample/replay counts),
  or explicit ``bench_warmups``/``bench_samples``/``bench_replays`` numbers.

Resolution order (highest first): explicit environment variable, then the
task's ``answers`` (the WebUI form), then the conservative default.
"""

from __future__ import annotations

import os
from typing import Any, Dict, Mapping, Optional

ENV_VALIDATE_SCOPE = "METAINFER_VALIDATE_SCOPE"
ENV_BENCH_WARMUPS = "METAINFER_BENCH_WARMUPS"
ENV_BENCH_SAMPLES = "METAINFER_BENCH_SAMPLES"
ENV_BENCH_REPLAYS = "METAINFER_BENCH_REPLAYS"

VALID_SCOPES = ("api", "task")

#: quick profile: still ~2x cheaper than the asset defaults (100/30/100) but
#: with enough warmup/sample depth that medians stay comparable across rounds
#: (a 10-warmup profile proved too noisy for decode-sized kernels).
QUICK_BENCH = {"warmups": 30, "samples": 30, "replays_per_sample": 50}


def _answers(answers: Optional[Mapping[str, Any]]) -> Mapping[str, Any]:
    return answers if isinstance(answers, Mapping) else {}


def resolve_validation_scope(answers: Optional[Mapping[str, Any]] = None) -> str:
    """``api`` (default) or ``task`` (optimal for single-shape evaluation)."""
    env = str(os.environ.get(ENV_VALIDATE_SCOPE) or "").strip().lower()
    if env in VALID_SCOPES:
        return env
    raw = str(_answers(answers).get("validation_scope") or "").strip().lower()
    if raw in VALID_SCOPES:
        return raw
    if raw in {"task only", "task-only", "selected shapes only",
               "task shapes only"}:
        return "task"
    if raw in {"all api shapes", "all", "api shapes"}:
        return "api"
    return "api"


def _int_or_none(value: Any) -> Optional[int]:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _positive_env(name: str) -> Optional[int]:
    return _int_or_none(os.environ.get(name))


def resolve_bench_kwargs(
    answers: Optional[Mapping[str, Any]] = None,
) -> Dict[str, int]:
    """Benchmark overrides for this task (``{}`` = asset defaults)."""
    ans = _answers(answers)
    profile = str(ans.get("bench_profile") or "").strip().lower()
    kwargs: Dict[str, int] = {}

    warmups = _positive_env(ENV_BENCH_WARMUPS)
    samples = _positive_env(ENV_BENCH_SAMPLES)
    replays = _positive_env(ENV_BENCH_REPLAYS)
    if warmups is None:
        warmups = _int_or_none(ans.get("bench_warmups"))
    if samples is None:
        samples = _int_or_none(ans.get("bench_samples"))
    if replays is None:
        replays = _int_or_none(ans.get("bench_replays"))

    if profile in {"quick", "fast"}:
        kwargs.update(QUICK_BENCH)
    if warmups is not None:
        kwargs["warmups"] = warmups
    if samples is not None:
        kwargs["samples"] = samples
    if replays is not None:
        kwargs["replays_per_sample"] = replays
    return kwargs
