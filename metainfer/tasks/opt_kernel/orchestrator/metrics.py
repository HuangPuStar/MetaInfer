"""Shared perf-metric helpers for the opt_kernel orchestrator.

Single source of truth for "which perf number is the headline" and "does this
count as a real improvement beyond noise". Used by:

- ``pipeline._count_iters_since_best`` (flame-chase plateau detection, #3)
- ``kernel_zoo.promote_best`` (kernel-zoo promotion picks the best iter, #7)

Keeping these here (rather than in ``pipeline``) avoids a circular import:
``kernel_zoo`` needs the metric logic but must not import the pipeline module.
``pipeline`` delegates to these via its ``_primary_metric`` / ``_is_improvement``
thin wrappers so existing call sites and tests are unchanged.
"""

from __future__ import annotations

from typing import Dict, Optional, Tuple

# Improvement must beat a 0.5% relative margin to count as a new best, so
# measurement jitter does not reset the plateau counter (mirrors the perf
# oracle's anti-noise posture, but smaller — this is a nudge, not a gate).
PLATEAU_IMPROVE_MARGIN = 0.005


def primary_metric(perf: Dict[str, float]) -> Optional[Tuple[float, str]]:
    """Pick the single best-available primary metric from a flat perf dict.

    Returns ``(value, direction)`` where direction is ``"decrease"`` (lower is
    better) or ``"increase"``. Preference order matches what the perf oracle
    reports as the headline: ``ms_per_op`` (latency) first, then throughput,
    then ``speedup``, then ``gflops``.
    """
    if "ms_per_op" in perf:
        return float(perf["ms_per_op"]), "decrease"
    if "tokens_per_sec" in perf:
        return float(perf["tokens_per_sec"]), "increase"
    if "speedup" in perf:
        return float(perf["speedup"]), "increase"
    if "gflops" in perf:
        return float(perf["gflops"]), "increase"
    return None


def is_improvement(new: float, best: float, direction: str,
                   margin: float = PLATEAU_IMPROVE_MARGIN) -> bool:
    """True if ``new`` beats ``best`` beyond the noise ``margin``."""
    if best == 0:
        return new != 0
    if direction == "decrease":
        return (best - new) / abs(best) > margin
    return (new - best) / abs(best) > margin
