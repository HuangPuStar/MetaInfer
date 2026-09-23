"""System-level harness decision engine.

Separates the performance gate (did the agent system get better?) from the
mechanism gate (did it improve for the reason declared in change_manifest?).
True performance is primary: an unexplained but reproducible win may be
promoted; a mechanism miss alone never turns a real stable win into REJECT.

Verdicts:
  BASELINE               first measured version, becomes champion
  PROMOTE                clear performance win + mechanism evidence hit
  CONFIRM_REQUIRED       clear performance win, mechanism absent/missed; repeat
  PROMOTE_UNEXPLAINED    repeated clear win but mechanism still missed/unknown
  NO_SIGNAL              inside noise; champion unchanged, candidate archived
  SPECIALIZE             target family wins but held-out regresses; routeable
  REJECT                 correctness or primary-suite significant regression
  REJECT_OVERFIT         main improves but held-out regresses and not routeable
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Mapping, Optional


@dataclass(frozen=True)
class DecisionPolicy:
    noise_percent: float = 2.0
    min_independent_wins: int = 2
    max_loss_ratio: float = 0.10
    max_heldout_losses: int = 0
    #: The performance gate is a *question-count* rule: the candidate passes
    #: when at least this fraction of the counted questions (probe questions
    #: excluded) are measurably faster than the champion. With the default 0.75
    #: that is "3 of 4 questions beat the current variant", regardless of how
    #: far behind the remaining question is.
    min_win_ratio: float = 0.75
    #: One hard red line inside that rule: a single question that is slower by
    #: more than this percentage — or that fails correctness — still rejects the
    #: candidate, so "three small wins plus one collapse" cannot be promoted.
    hard_regression_percent: float = 30.0
    #: A round whose paired set is mostly unmeasurable (crashed children,
    #: suppressed measurements) cannot support a verdict: it is recorded as
    #: INCONCLUSIVE instead of REJECT.
    min_valid_pair_ratio: float = 0.5
    #: How strictly the mechanism gate is enforced when a real performance win
    #: has no (or only partial) mechanism evidence:
    #:   ``lenient`` (default) — unverified/partial evidence may still promote
    #:       (recorded as PROMOTE_UNEXPLAINED); only a *contradiction* forces
    #:       one confirmation round;
    #:   ``strict`` — anything short of a verified hit requires confirmation;
    #:   ``off`` — skip the mechanism gate entirely.
    mechanism_policy: str = "lenient"


def _median(r: Mapping[str, Any]) -> Optional[float]:
    try:
        v = float(r.get("median_us"))
        return v if v > 0 else None
    except (TypeError, ValueError):
        return None


_MISSING_STATUSES = {"missing_report", "exception", "timeout", "partial_worker_result"}


def _correctness_hard_fail(r: Mapping[str, Any]) -> bool:
    return r.get("correctness_ok") is False or r.get("correctness_passed") is False


def _measurement_missing(r: Mapping[str, Any]) -> bool:
    """True when there is no usable measurement at all.

    A crashed child (``missing_report``) or a timeout is an *environment*
    failure: treating it as HARD_FAIL/LOSS turns infrastructure trouble into a
    fake harness regression, which is how a run can be "rejected" five times
    in a row while nothing was actually measured.
    """
    if r.get("median_us") in (None, ""):
        return True
    return str(r.get("status") or "").strip().lower() in _MISSING_STATUSES


def compare_instances(
    champion: Mapping[str, Mapping[str, Any]],
    candidate: Mapping[str, Mapping[str, Any]],
    *,
    noise_percent: float,
) -> Dict[str, Any]:
    """Paired comparison on ids present in both result sets."""
    ids = sorted(set(champion) & set(candidate))
    rows: Dict[str, Any] = {}
    counts = {"WIN": 0, "LOSS": 0, "NO_SIGNAL": 0, "HARD_FAIL": 0,
              "INVALID": 0}
    pass_before = pass_after = 0

    for iid in ids:
        before, after = champion[iid], candidate[iid]
        pass_before += int(before.get("passed") is True)
        pass_after += int(after.get("passed") is True)
        b, a = _median(before), _median(after)
        if _measurement_missing(after):
            verdict, delta = "INVALID", None
        elif _correctness_hard_fail(after):
            verdict, delta = "HARD_FAIL", None
        elif b is None or a is None:
            verdict, delta = "INVALID", None
        else:
            delta = (b - a) / b * 100.0  # positive = candidate faster
            if delta > noise_percent:
                verdict = "WIN"
            elif delta < -noise_percent:
                verdict = "LOSS"
            else:
                verdict = "NO_SIGNAL"
        counts[verdict] += 1
        rows[iid] = {
            "champion_median_us": b,
            "candidate_median_us": a,
            "delta_percent": round(delta, 4) if delta is not None else None,
            "verdict": verdict,
            "champion_passed": before.get("passed") is True,
            "candidate_passed": after.get("passed") is True,
        }

    return {
        "overlap_ids": ids,
        "per_instance": rows,
        "counts": counts,
        "pass_before": pass_before,
        "pass_after": pass_after,
        "delta_pass": pass_after - pass_before,
    }


def _manifest_changes(manifest: Optional[Mapping[str, Any]]) -> List[Mapping[str, Any]]:
    if not manifest:
        return []
    return [x for x in manifest.get("changes", []) if isinstance(x, Mapping)]


def _mechanism_status(
    manifest: Optional[Mapping[str, Any]],
    mechanism_checks: Optional[Mapping[str, bool]],
) -> Dict[str, Any]:
    changes = _manifest_changes(manifest)
    declared = [c for c in changes if c.get("mechanism_signature")]
    if not declared:
        return {"status": "NOT_DECLARED", "hits": [], "misses": []}
    if not mechanism_checks:
        return {
            "status": "NOT_CHECKED",
            "hits": [],
            "misses": [str(c.get("id", "unknown")) for c in declared],
            "unobserved": [],
            "contradicted": [],
        }
    hits, misses, unobserved, contradicted = [], [], [], []
    for c in declared:
        cid = str(c.get("id", "unknown"))
        raw = mechanism_checks.get(cid)
        if raw is True or raw == "hit":
            hits.append(cid)
        elif raw == "partial":
            hits.append(cid)          # lenient: partial evidence counts
        elif raw == "unobserved":
            unobserved.append(cid)
        elif raw == "contradicted":
            contradicted.append(cid)
            misses.append(cid)
        else:
            misses.append(cid)
    if contradicted:
        status = "MISS"
    elif hits and not misses:
        status = "HIT"
    elif hits and misses:
        status = "PARTIAL"
    elif unobserved and not misses:
        status = "UNOBSERVED"
    else:
        status = "MISS"
    return {"status": status, "hits": hits, "misses": misses,
            "unobserved": unobserved, "contradicted": contradicted}


def _collapse(row: Mapping[str, Any], limit_percent: float) -> bool:
    """One question that regressed past the red line (or broke correctness)."""
    delta = row.get("delta_percent")
    try:
        if delta is not None and float(delta) < -abs(float(limit_percent)):
            return True
    except (TypeError, ValueError):
        pass
    return row.get("verdict") == "HARD_FAIL"


def _routeable(manifest: Optional[Mapping[str, Any]]) -> bool:
    for c in _manifest_changes(manifest):
        scope = c.get("scope") or {}
        if isinstance(scope, Mapping) and scope.get("routeable") is True:
            return True
    return False


def decide(
    champion: Optional[Mapping[str, Mapping[str, Any]]],
    candidate: Mapping[str, Mapping[str, Any]],
    *,
    manifest: Optional[Mapping[str, Any]] = None,
    heldout_champion: Optional[Mapping[str, Mapping[str, Any]]] = None,
    heldout_candidate: Optional[Mapping[str, Mapping[str, Any]]] = None,
    mechanism_checks: Optional[Mapping[str, bool]] = None,
    confirmation_reproduced: bool = False,
    purposes: Optional[Mapping[str, str]] = None,
    policy: DecisionPolicy = DecisionPolicy(),
) -> Dict[str, Any]:
    """Return a complete, auditable system-level decision record.

    ``purposes`` labels each question (regression / repair / probe). Probe
    questions are *generalisation* evidence only: they never enter the
    pass-rate or win/loss pair that decides promotion, but a probe that
    regresses blocks promotion, because it means the change does not
    generalise beyond the family it was tuned on.
    """
    if champion is None:
        return {
            "verdict": "BASELINE",
            "performance_gate": {"status": "BASELINE"},
            "mechanism_gate": {"status": "NOT_APPLICABLE"},
            "heldout_gate": {"status": "NOT_APPLICABLE"},
            "action": "SET_CHAMPION",
        }

    purposes = purposes or {}
    probe_set = {i for i, p in purposes.items() if p == "probe"}
    main_ids = [i for i in candidate if i not in probe_set]
    if not main_ids:
        main_ids = list(candidate)
    champion_main = {k: v for k, v in champion.items() if k in main_ids}
    candidate_main = {k: v for k, v in candidate.items() if k in main_ids}

    perf = compare_instances(champion_main, candidate_main,
                             noise_percent=policy.noise_percent)
    counts = perf["counts"]
    #: correctness/missing-measurement failures are always fatal: a comparison
    #: missing one side is not evidence that the candidate is faster.
    hard_fail = counts["HARD_FAIL"] > 0 or counts["INVALID"] > 0
    measured = counts["WIN"] + counts["LOSS"] + counts["NO_SIGNAL"]
    # Question-count performance gate: >= min_win_ratio of the measured
    # questions must be measurably faster than the champion. NO_SIGNAL (inside
    # the noise band) is not a win, so it counts against the ratio.
    win_ratio = (counts["WIN"] / measured) if measured else 0.0
    enough_wins = measured > 0 and win_ratio >= float(policy.min_win_ratio)
    # Hard red line: one question that fell off a cliff still rejects.
    collapses = [
        iid for iid, row in (perf.get("per_instance") or {}).items()
        if _collapse(row, policy.hard_regression_percent)
    ]
    clear_improvement = bool(enough_wins and not hard_fail and not collapses)

    held = None
    heldout_regression = False
    if heldout_champion is not None and heldout_candidate is not None:
        held = compare_instances(
            heldout_champion, heldout_candidate,
            noise_percent=policy.noise_percent,
        )
        heldout_regression = (
            held["counts"]["HARD_FAIL"] > 0
            or held["counts"]["LOSS"] > policy.max_heldout_losses
            or held["delta_pass"] < 0
        )

    mechanism = _mechanism_status(manifest, mechanism_checks)

    #: Counted questions that produced a usable pairing (WIN/LOSS/NO_SIGNAL).
    measurable = counts["WIN"] + counts["LOSS"] + counts["NO_SIGNAL"]
    #: All counted questions inside the noise band: "no measurable difference"
    #: rather than "worse". Drives both the gate status and the verdict.
    indistinguishable = bool(measured) and counts["WIN"] == 0 and counts["LOSS"] == 0
    paired_total = len(perf["overlap_ids"])
    coverage = (measured / paired_total) if paired_total else 1.0
    inconclusive = bool(paired_total) and coverage < float(
        policy.min_valid_pair_ratio)

    generalization: Dict[str, Any] = {"status": "NOT_RUN", "comparison": None,
                                      "ids": sorted(probe_set)}
    if probe_set:
        probe_champion = {k: v for k, v in champion.items() if k in probe_set}
        probe_candidate = {k: v for k, v in candidate.items() if k in probe_set}
        if set(probe_champion) & set(probe_candidate):
            probe_perf = compare_instances(
                probe_champion, probe_candidate,
                noise_percent=policy.noise_percent)
            probe_counts = probe_perf["counts"]
            generalization = {
                "status": ("FAIL" if (probe_counts["HARD_FAIL"] > 0
                                      or probe_counts["LOSS"] > 0) else "PASS"),
                "comparison": probe_perf,
                "ids": sorted(probe_set),
            }

    if inconclusive:
        # Not a result: keep the champion, do not count it as a failure.
        verdict, action = "INCONCLUSIVE", "KEEP_CHAMPION_ARCHIVE_CANDIDATE"
    elif hard_fail or collapses:
        verdict, action = "REJECT", "RESTORE_CHAMPION"
    elif clear_improvement and heldout_regression:
        if _routeable(manifest):
            verdict, action = "SPECIALIZE", "ARCHIVE_SPECIALIZED"
        else:
            verdict, action = "REJECT_OVERFIT", "RESTORE_CHAMPION"
    elif clear_improvement and generalization["status"] == "FAIL":
        # A win inside the tuned families that breaks an untouched family is
        # over-fitting, not progress: require one confirmation round.
        if confirmation_reproduced:
            verdict, action = "PROMOTE_UNEXPLAINED", "SET_CHAMPION"
        else:
            verdict, action = "CONFIRM_REQUIRED", "ARCHIVE_AND_CONFIRM"
    elif clear_improvement:
        mstatus = mechanism["status"]
        policy_mode = str(policy.mechanism_policy or "lenient").lower()
        if mstatus in {"HIT", "PARTIAL"}:
            verdict, action = "PROMOTE", "SET_CHAMPION"
        elif policy_mode == "off":
            verdict, action = "PROMOTE_UNEXPLAINED", "SET_CHAMPION"
        elif policy_mode == "lenient" and mstatus in {"UNOBSERVED",
                                                      "NOT_CHECKED",
                                                      "NOT_DECLARED"}:
            # Performance is primary: an unverified win may still take the
            # champion slot, but it is recorded as unexplained.
            verdict, action = "PROMOTE_UNEXPLAINED", "SET_CHAMPION"
        elif confirmation_reproduced:
            verdict, action = "PROMOTE_UNEXPLAINED", "SET_CHAMPION"
        else:
            verdict, action = "CONFIRM_REQUIRED", "ARCHIVE_AND_CONFIRM"
    else:
        # Below the win ratio. Distinguish "we measured no difference" (an
        # honest no-signal: keep the champion, try again) from "the candidate
        # is measurably worse" (a real reject that counts toward the circuit
        # breaker). A round where every counted question sat inside the noise
        # band is the former; anything with LOSSes is the latter.
        if indistinguishable:
            verdict, action = "NO_SIGNAL", "KEEP_CHAMPION_ARCHIVE_CANDIDATE"
        else:
            verdict, action = "REJECT", "RESTORE_CHAMPION"

    performance_status = (
        "INCONCLUSIVE" if inconclusive else
        "FAIL" if hard_fail or collapses else
        "PASS" if clear_improvement else
        "NO_SIGNAL" if indistinguishable else "FAIL"
    )
    heldout_status = (
        "NOT_RUN" if held is None else
        "FAIL" if heldout_regression else "PASS"
    )
    record = {
        "verdict": verdict,
        "action": action,
        "policy": {
            "noise_percent": policy.noise_percent,
            "min_win_ratio": policy.min_win_ratio,
            "hard_regression_percent": policy.hard_regression_percent,
            "min_independent_wins": policy.min_independent_wins,
            "max_loss_ratio": policy.max_loss_ratio,
            "max_heldout_losses": policy.max_heldout_losses,
            "mechanism_policy": policy.mechanism_policy,
        },
        "performance_gate": {"status": performance_status,
                             "measurable_pairs": measurable,
                             "paired_total": paired_total,
                             "coverage": round(coverage, 3),
                             # the question-count rule, in one line:
                             "win_ratio": round(win_ratio, 3),
                             "min_win_ratio": policy.min_win_ratio,
                             "wins_needed": _wins_needed(measured, policy),
                             "collapses": sorted(collapses),
                             **perf},
        "mechanism_gate": mechanism,
        "generalization_gate": generalization,
        "purpose_breakdown": {
            iid: {"purpose": purposes.get(iid, "regression"),
                  "counted": iid not in probe_set}
            for iid in sorted(set(champion) | set(candidate))
        },
        "paired_ids": sorted(set(champion_main) & set(candidate_main)),
        "probe_ids": sorted(probe_set),
        "heldout_gate": {
            "status": heldout_status,
            "comparison": held,
        },
        "reason": _reason(verdict, perf, mechanism, heldout_regression,
                          win_ratio=win_ratio,
                          collapses=collapses,
                          policy=policy),
    }
    if generalization["status"] == "FAIL":
        tail = ("promoted after reproduction" if verdict == "PROMOTE_UNEXPLAINED"
                else ("rejected" if action == "RESTORE_CHAMPION"
                      else "repeat once"))
        record["reason"] = (
            "performance improved inside the tuned families but an untouched "
            f"family regressed (over-fitting): {tail}"
        )
    return record


def _needed_wins(measured: int, ratio: float) -> int:
    """Ceiling of ``measured * ratio``: 4 operators at 75% need 3 wins."""
    if measured <= 0:
        return 0
    import math
    return max(1, min(measured, int(math.ceil(measured * float(ratio)))))


def _wins_needed(measured: int, policy: DecisionPolicy) -> int:
    """How many of the counted questions must win (round-level policy)."""
    return _needed_wins(measured, policy.min_win_ratio)


#: The two harness gates, on the operator-count rule the operator specified.
#: Both compare the candidate against the *current variant* of each operator and
#: both refuse a candidate that lets any single operator fall below a floor, so
#: "many small wins plus one collapse" cannot pass.
PERFORMANCE_GATE_WIN_RATIO = 0.75      # 4 operators -> at least 3 must win
PERFORMANCE_GATE_FLOOR_PERCENT = 0.80  # every non-winning operator >= 80% of the variant
GENERALIZATION_GATE_WIN_RATIO = 0.50   # 4 operators -> at least 2 must win
GENERALIZATION_GATE_FLOOR_PERCENT = 0.80

#: How a tie (a difference inside the comparison's noise band) is scored.
#: ``"loss"``: only a strict win counts — the performance gate's rule, where
#: fresh operators must genuinely come out ahead.
#: ``"neutral"``: a tie is evidence of *holding the line*, not of failure — the
#: generalization gate's rule. The retake re-measures the paper on the same
#: harness, and DKAO warm-starts from the kernel the baseline round just put in
#: the pool, so re-finding that same kernel is the expected outcome; scoring it
#: as a loss would demand that a search policy out-optimize its own best result
#: every time. A real regression (below the floor) still fails the gate.
TIE_AS_LOSS = "loss"
TIE_AS_NEUTRAL = "neutral"


def gate_verdict(reference: Mapping[str, Mapping[str, Any]],
                 candidate: Mapping[str, Mapping[str, Any]],
                 *,
                 kind: str = "performance",
                 noise_percent: float = 2.0,
                 win_ratio: Optional[float] = None,
                 floor_percent: Optional[float] = None,
                 ties: Optional[str] = None,
                 ) -> Dict[str, Any]:
    """Judge one round of a gate on the operator-count rule.

    ``kind`` is ``"performance"`` (>= 75% of operators must beat their variant)
    or ``"generalization"`` (>= 50%). In both cases every operator that did not
    win must still be at least ``floor_percent`` of its variant, and an operator
    that produced no usable measurement fails the gate outright rather than
    being counted as a loss.

    ``ties`` decides how a difference inside ``noise_percent`` is scored; it
    defaults to the gate's own rule (performance: a tie is not a win;
    generalization: a tie holds the line). Every operator that is genuinely
    slower than its variant (and every one below the floor) blocks the gate.
    """
    if win_ratio is None:
        win_ratio = (PERFORMANCE_GATE_WIN_RATIO if kind == "performance"
                     else GENERALIZATION_GATE_WIN_RATIO)
    if floor_percent is None:
        floor_percent = (PERFORMANCE_GATE_FLOOR_PERCENT if kind == "performance"
                         else GENERALIZATION_GATE_FLOOR_PERCENT)
    if ties is None:
        ties = TIE_AS_LOSS if kind == "performance" else TIE_AS_NEUTRAL
    comparison = compare_instances(reference, candidate,
                                   noise_percent=noise_percent)
    rows = comparison.get("per_instance") or {}
    judged = ["WIN", "LOSS", "NO_SIGNAL"]
    all_judged = [iid for iid, row in rows.items()
                  if row.get("verdict") in judged]
    ties_ids = [iid for iid in all_judged
                if rows[iid]["verdict"] == "NO_SIGNAL"]
    losses = [iid for iid in all_judged if rows[iid]["verdict"] == "LOSS"]
    # Neutral ties leave the denominator: they are neither a win to count nor a
    # loss to answer for (the floor is what catches a real regression).
    counted = ([iid for iid in all_judged if iid not in set(ties_ids)]
               if ties == TIE_AS_NEUTRAL else all_judged)
    wins = [iid for iid in counted if rows[iid]["verdict"] == "WIN"]
    unmeasured = sorted(
        iid for iid, row in rows.items()
        if row.get("verdict") in {"INVALID", "HARD_FAIL"})
    too_slow = sorted(
        iid for iid in all_judged
        if _below_floor(rows[iid], floor_percent))
    measured = len(counted)
    ratio = (len(wins) / measured) if measured else 0.0
    needed = _needed_wins(measured, win_ratio)
    reasons: List[str] = []
    if unmeasured:
        reasons.append("no usable measurement: " + ", ".join(unmeasured))
    if too_slow:
        reasons.append(
            f"below {floor_percent:.0%} of the variant: " + ", ".join(too_slow))
    if measured and len(wins) < needed:
        reasons.append(f"{len(wins)}/{measured} operators beat the variant "
                       f"(needs {needed} = {win_ratio:.0%})")
    all_tied = bool(all_judged) and len(ties_ids) == len(all_judged)
    if all_tied:
        # Every operator tied. Scored as holding the line (the generalization
        # gate's rule) that is a pass on the floor requirement alone; scored as
        # a loss it means the candidate proved nothing.
        if ties == TIE_AS_LOSS:
            reasons.append("no operator beat its variant (all tied)")
    elif not measured and not unmeasured:
        reasons.append("nothing comparable to the variant")
    record = {
        "kind": kind,
        "status": "PASS" if not reasons else "FAIL",
        "win_ratio": round(ratio, 3),
        "required_win_ratio": win_ratio,
        "floor_percent_of_variant": floor_percent,
        "tie_policy": ties,
        "operators": sorted(rows),
        "wins": sorted(wins),
        "losses": sorted(losses),
        "ties": sorted(ties_ids),
        "counted": measured,
        "wins_needed": needed,
        "unmeasured": unmeasured,
        "below_floor": too_slow,
        "reasons": reasons,
        "comparison": comparison,
    }
    return record


def _below_floor(row: Mapping[str, Any], floor_percent: float) -> bool:
    """True when a measured operator is worse than ``floor_percent`` of its variant."""
    delta = row.get("delta_percent")
    try:
        if delta is None:
            return False
        return float(delta) < (float(floor_percent) - 1.0) * 100.0
    except (TypeError, ValueError):
        return False



def _reason(verdict: str, perf: Mapping[str, Any], mechanism: Mapping[str, Any],
            heldout_regression: bool, *, win_ratio: float = 0.0,
            collapses: Optional[List[str]] = None,
            policy: Optional[DecisionPolicy] = None) -> str:
    policy = policy or DecisionPolicy()
    counts = perf.get("counts") or {}
    measured = (int(counts.get("WIN", 0)) + int(counts.get("LOSS", 0))
                + int(counts.get("NO_SIGNAL", 0)))
    summary = (f"{counts.get('WIN', 0)}/{measured} counted questions faster "
               f"than the champion (needs {_wins_needed(measured, policy)}, "
               f"{policy.min_win_ratio:.0%})")
    if verdict == "INCONCLUSIVE":
        return ("too few usable measurements this round (crashed children or "
                "suppressed readings); no verdict")
    if verdict == "PROMOTE":
        return f"clear performance improvement ({summary}); declared mechanism verified"
    if verdict == "PROMOTE_UNEXPLAINED":
        return (f"reproduced performance improvement ({summary}); mechanism "
                "remains unverified")
    if verdict == "CONFIRM_REQUIRED":
        return (f"performance improved ({summary}) but mechanism is "
                "absent/unverified; repeat once")
    if verdict == "SPECIALIZE":
        return ("target suite improved but held-out regressed; preserve as "
                "routeable variant")
    if verdict == "REJECT_OVERFIT":
        return "target suite improved but held-out regression exceeded boundary"
    if verdict == "REJECT":
        if collapses:
            return (f"hard red line crossed on {', '.join(sorted(collapses))} "
                    f"(> {policy.hard_regression_percent:.0f}% slower or "
                    f"incorrect); {summary}")
        if int(counts.get("HARD_FAIL", 0)) or int(counts.get("INVALID", 0)):
            return ("correctness failure or an unusable measurement in the "
                    "comparison; not a result we can trust")
        return (f"performance gate failed: {summary} "
                f"(needed {policy.min_win_ratio:.0%} of counted questions)")
    if verdict == "NO_SIGNAL":
        return (f"candidate is inside the noise band ({summary}); keep "
                "champion and archive candidate")
    return "first measured version establishes the champion baseline"
