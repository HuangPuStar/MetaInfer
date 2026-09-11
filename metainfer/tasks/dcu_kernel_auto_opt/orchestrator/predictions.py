"""Inner decision-observability helpers (M1 slice 3, additive & inert).

The worker round record already stores the agent's ``hypothesis`` prose and
``profile_evidence``. This module adds *optional structured prediction* support:

- proposal may carry a top-level ``prediction`` object:
    {
      "expected_us_range": [lo, hi],   # optional numeric range for median_us
      "direction": "improve|regress|flat",  # optional relative to current best
      "at_risk": true/false,           # optional: change may regress P90/shapes
    }
- after a round is measured, ``check_prediction`` returns a compact verdict
  (``hit`` / ``miss`` / ``na``) plus the evidence used, or ``None`` when the
  proposal declared no structured prediction (fully backward compatible).

Runtime behaviour is unchanged: prompts do not yet instruct agents to emit
``prediction``; the hook in ``w8a8_pipeline`` only adds fields to the round
record when a structured prediction is present. ``plan_id`` capture (feeding
the planner's coverage guards) is handled separately in the pipeline hook.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional


_INFRA_TOKENS = ("timeout", "timed out", "killed", "no result", "exit 143")


def parse_prediction(proposal: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Extract the structured prediction (if any) from a proposal dict."""
    prediction = proposal.get("prediction")
    if not isinstance(prediction, dict):
        return None
    return dict(prediction)


def _is_infra_failure(failure_reason: Any) -> bool:
    reason = str(failure_reason or "").lower()
    return any(token in reason for token in _INFRA_TOKENS)


def check_prediction(
    proposal: Dict[str, Any],
    *,
    candidate_us: float,
    best_us: float,
    passed: bool,
    p90_guard_passed: bool,
    failure_reason: Any = None,
) -> Optional[Dict[str, Any]]:
    """Compare a declared structured prediction against the measured round.

    Returns None when the proposal declared nothing (or it is not dict-shaped).
    Otherwise returns:
      {
        "declared": {...},
        "checked": "hit" | "miss" | "na",
        "candidate_us": float,
        "best_us": float,
        "reason": str,
      }
    """
    declared = parse_prediction(proposal)
    if declared is None:
        return None

    na = not passed and _is_infra_failure(failure_reason)
    if na:
        return {
            "declared": declared,
            "checked": "na",
            "candidate_us": candidate_us,
            "best_us": best_us,
            "reason": "infrastructure failure; prediction not judged",
        }

    reasons: List[str] = []
    expected_range = declared.get("expected_us_range")
    direction = declared.get("direction")

    range_ok: Optional[bool] = None
    if isinstance(expected_range, (list, tuple)) and len(expected_range) == 2:
        try:
            lo, hi = float(expected_range[0]), float(expected_range[1])
        except (TypeError, ValueError):
            lo = hi = None
        if lo is not None:
            range_ok = (lo <= candidate_us <= hi)
            if not range_ok:
                reasons.append(
                    f"median {candidate_us:.1f}us outside declared range "
                    f"[{lo:.1f}, {hi:.1f}]"
                )

    dir_ok: Optional[bool] = None
    if isinstance(direction, str) and direction in ("improve", "regress", "flat"):
        # relative comparison against the current best median (v0: flat = within
        # +-2% of best, matching the plateau band used elsewhere)
        if best_us > 0 and candidate_us != float("inf"):
            delta = (best_us - candidate_us) / best_us * 100.0
            if direction == "improve":
                dir_ok = delta >= 2.0 and passed
                if not dir_ok:
                    reasons.append(f"expected improvement, got delta {delta:.1f}%")
            elif direction == "regress":
                dir_ok = delta <= -2.0
                if not dir_ok:
                    reasons.append(f"expected regression, got delta {delta:.1f}%")
            else:  # flat
                dir_ok = -2.0 <= delta < 2.0
                if not dir_ok:
                    reasons.append(f"expected flat, got delta {delta:.1f}%")

    if not passed:
        reasons.append("correctness failed")

    checks = [c for c in (range_ok, dir_ok) if c is not None]
    if checks:
        hit = passed and all(checks)
    else:
        # structured object present but nothing checkable declared
        hit = passed

    if not hit:
        reasons.append("no p90 guard evidence" if not p90_guard_passed else "")
        reasons = [r for r in reasons if r]

    return {
        "declared": declared,
        "checked": "hit" if hit else "miss",
        "candidate_us": candidate_us,
        "best_us": best_us,
        "reason": "; ".join(reasons) or "ok",
    }


def plan_tag(proposal: Dict[str, Any]) -> Optional[str]:
    """Optional plan_id from proposal (feeds planner coverage guards later)."""
    pid = proposal.get("plan_id")
    return pid if isinstance(pid, str) and pid.strip() else None
