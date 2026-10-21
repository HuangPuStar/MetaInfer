"""Falsifiable-prediction evaluation for opt_kernel (AHE decision observability).

This is the **P2** piece from ``docs/opt_kernel_ahe.md``. The planner, in the
A_plan phase, writes ``iter_dir/predictions.json`` — a structured claim about
how each planned change should move perf. After the E perf oracle produces
``perf_report.json``, :func:`evaluate_predictions` compares each prediction
against the actual perf delta (vs the previous iteration's authoritative
baseline) and returns a ``change_evaluation`` dict that the orchestrator writes
to ``iter_dir/change_evaluation.json``.

Design constraints (see CLAUDE.md "single source of truth"):

- **Authority**: perf numbers and the formal regression verdict live in
  ``perf_report.json`` (the oracle). ``predictions.json`` is the planner's
  *historical claim*; ``change_evaluation.json`` is a *derived snapshot*.
  Neither is read back to mutate run/registry/IterationRecord authority —
  they only feed the next planner's prompt context. The file header says so.
- **Advisory / non-blocking**: this module never raises into the pipeline;
  the orchestrator wraps calls in try/except. Missing/partial inputs degrade
  to ``inconclusive`` verdicts, not crashes.
- **Pure**: no I/O, no pipeline dependency — trivially unit-testable.

Metric direction convention (mirrors ``oracles/perf.py``):

    INCREASE_GOOD = {tokens_per_sec, speedup, gflops, bandwidth_gb_s}  # bigger is better
    DECREASE_GOOD = {ms_per_op}                                       # smaller is better
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

# Metrics where larger is better. ms_per_op is the only "smaller is better"
# primary metric in opt_kernel today; everything else the oracle emits is
# bigger-is-better. Unknown metrics default to "increase-good" (safer: a
# drop is treated as a regression rather than silently ignored).
INCREASE_GOOD = {"tokens_per_sec", "speedup", "gflops", "bandwidth_gb_s", "kernel_us_per_op"}
DECREASE_GOOD = {"ms_per_op"}

# Relative worsen threshold for at-risk (non-primary) metrics. The formal
# regression of the *primary* metric is owned by the perf oracle; this is only
# a soft flag for the planner's declared at-risk metrics.
AT_RISK_WORSEN_THRESHOLD = 0.05


def _is_increase_good(metric: str) -> bool:
    """True if bigger-is-better for this metric. Unknown → increase-good."""
    if metric in DECREASE_GOOD:
        return False
    return True


def _relative_delta_pct(baseline: float, actual: float) -> Optional[float]:
    """Signed relative change in percent (actual vs baseline). None if no baseline."""
    if baseline in (0, None):
        return None
    return (actual - baseline) / baseline * 100.0


def _signed_predicted_move(direction: str, actual_delta_pct: float) -> float:
    """Reframe actual delta so that *positive* = moved in the predicted direction.

    For ``increase``: positive actual_delta_pct is good → keep as-is.
    For ``decrease``: negative actual_delta_pct is good → flip sign.
    """
    if direction == "decrease":
        return -actual_delta_pct
    return actual_delta_pct


def _metric_regressed(metric: str, baseline: Optional[float],
                      actual: Optional[float]) -> bool:
    """Did this at-risk metric worsen beyond the soft threshold?"""
    if baseline is None or actual is None or baseline == 0:
        return False
    rel = (actual - baseline) / baseline
    if _is_increase_good(metric):
        # bigger is better → regression is a drop
        return rel < -AT_RISK_WORSEN_THRESHOLD
    # smaller is better → regression is a rise
    return rel > AT_RISK_WORSEN_THRESHOLD


def _verdict_for(prediction: Dict[str, Any], baseline_perf: Optional[Dict[str, float]],
                 actual_perf: Optional[Dict[str, float]]) -> str:
    """Classify one prediction: confirmed | falsified | inconclusive."""
    target = prediction.get("target_metric")
    direction = prediction.get("direction", "increase")
    expected = prediction.get("expected_delta_pct")

    if target is None or expected is None:
        return "inconclusive"

    try:
        expected = float(expected)
    except (TypeError, ValueError):
        return "inconclusive"

    baseline_val = baseline_perf.get(target) if baseline_perf else None
    actual_val = actual_perf.get(target) if actual_perf else None
    if baseline_val is None or actual_val is None:
        return "inconclusive"

    actual_delta = _relative_delta_pct(float(baseline_val), float(actual_val))
    if actual_delta is None:
        return "inconclusive"

    # Magnitude of movement in the PREDICTED direction (positive = as predicted).
    predicted_move = _signed_predicted_move(direction, actual_delta)

    if expected <= 0:
        # No meaningful claim → can't falsify.
        return "inconclusive"

    if predicted_move >= 0.5 * expected:
        return "confirmed"
    return "falsified"


def _at_risk_summary(prediction: Dict[str, Any],
                     baseline_perf: Optional[Dict[str, float]],
                     actual_perf: Optional[Dict[str, float]],
                     ) -> Dict[str, Any]:
    """Per at-risk-metric actuals + whether any regressed.

    Non-numeric concerns the planner may list (e.g. ``"correctness"``) are
    *not* evaluable from perf data — correctness is owned by the C_test phase,
    not the perf oracle — so they are noted but never counted as a perf
    regression.
    """
    at_risk: List[str] = list(prediction.get("at_risk_metrics") or [])
    per_metric: Dict[str, Any] = {}
    any_regressed = False
    for m in at_risk:
        b = baseline_perf.get(m) if baseline_perf else None
        a = actual_perf.get(m) if actual_perf else None
        if b is None or a is None:
            per_metric[m] = {"evaluable": False, "delta_pct": None}
            continue
        delta = _relative_delta_pct(float(b), float(a))
        regressed = _metric_regressed(m, float(b), float(a))
        if regressed:
            any_regressed = True
        per_metric[m] = {"evaluable": True, "delta_pct": delta, "regressed": regressed}
    return {"at_risk_regression": any_regressed, "at_risk_actual": per_metric}


def evaluate_predictions(
    predictions: List[Dict[str, Any]],
    baseline_perf: Optional[Dict[str, float]] = None,
    actual_perf: Optional[Dict[str, float]] = None,
    regression: Optional[Dict[str, Any]] = None,
    iteration: Optional[int] = None,
) -> Dict[str, Any]:
    """Compare planner predictions against actual perf → change_evaluation dict.

    Parameters
    ----------
    predictions
        The ``predictions`` list from ``predictions.json``. May be empty.
    baseline_perf
        Previous iteration's authoritative perf (``IterationRecord.perf``).
        None / empty → all verdicts ``inconclusive``.
    actual_perf
        This iteration's perf (from ``perf_report.json`` via the oracle).
    regression
        The perf oracle's ``report.regression`` dict (authoritative formal
        regression verdict for the primary metric). Echoed into the output
        for the planner's context; not used to compute per-prediction verdicts.
    iteration
        Echoed into the output for traceability.

    Returns
    -------
    dict
        ``change_evaluation`` structure (see ``docs/opt_kernel_ahe.md`` §4.1):
        ``{iteration, baseline_perf, actual_perf, regression, predictions, summary, verdict_text}``.
        Always returns a dict — never raises. Callers may freely serialize it.
    """
    predictions = list(predictions or [])
    out_preds: List[Dict[str, Any]] = []
    n_confirmed = 0
    n_falsified = 0
    n_inconclusive = 0
    n_at_risk_reg = 0
    verdict_lines: List[str] = []

    for p in predictions:
        pid = p.get("id") or f"p{len(out_preds) + 1}"
        target = p.get("target_metric")
        direction = p.get("direction", "increase")
        expected = p.get("expected_delta_pct")
        verdict = _verdict_for(p, baseline_perf, actual_perf)
        risk = _at_risk_summary(p, baseline_perf, actual_perf)

        actual_delta: Optional[float] = None
        if (target and baseline_perf and actual_perf
                and baseline_perf.get(target) is not None
                and actual_perf.get(target) is not None):
            actual_delta = _relative_delta_pct(
                float(baseline_perf[target]), float(actual_perf[target]))

        out_preds.append({
            "id": pid,
            "change": p.get("change"),
            "target_metric": target,
            "direction": direction,
            "expected_delta_pct": expected,
            "actual_delta_pct": actual_delta,
            "verdict": verdict,
            "at_risk_regression": risk["at_risk_regression"],
            "at_risk_actual": risk["at_risk_actual"],
        })

        if verdict == "confirmed":
            n_confirmed += 1
        elif verdict == "falsified":
            n_falsified += 1
        else:
            n_inconclusive += 1
        if risk["at_risk_regression"]:
            n_at_risk_reg += 1

        if actual_delta is not None and expected is not None:
            try:
                exp_f = float(expected)
                verdict_lines.append(
                    f"{pid} {verdict.upper()} "
                    f"({target} {direction} {exp_f:+.1f}% expected vs "
                    f"{actual_delta:+.1f}% actual)")
            except (TypeError, ValueError):
                verdict_lines.append(f"{pid} {verdict.upper()} ({target})")
        else:
            verdict_lines.append(f"{pid} {verdict.upper()} ({target or 'no metric'})")

    summary = (
        f"{n_confirmed}/{len(predictions)} confirmed, "
        f"{n_falsified} falsified, {n_inconclusive} inconclusive, "
        f"{n_at_risk_reg} at-risk regressions"
    )
    verdict_text = "; ".join(verdict_lines) if verdict_lines else None

    return {
        "iteration": iteration,
        "baseline_perf": dict(baseline_perf) if baseline_perf else None,
        "actual_perf": dict(actual_perf) if actual_perf else None,
        "regression": regression,
        "predictions": out_preds,
        "summary": summary,
        "verdict_text": verdict_text,
    }
