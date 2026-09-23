"""Role-based question selection for AHE rounds.

The previous rule let the Evolve agent pick any in-pool set (guardrails only
enforced membership, budget and >=60% overlap). That produced the failure we
actually hit on 9-8-8: three of four questions came from the same operator
family, an over-generalised policy change looked like a win, and the decision
promoted it — after which two unrelated shapes regressed.

This module gives every question in a round an explicit **role**, so a round
measures what it claims to measure:

  regression  2 slots — questions that PASSED last round and are inside the
              change's declared scope; spread across families. Primary causal
              evidence that the change did not break what worked.
  repair      1 slot — questions that LOST last round (or sit in scope.at_risk);
              when nothing lost, the least-recently-examined question of a
              different family.
  probe       1 slot — deliberately a *different* family than everything else
              (cold-start generalisation probe). It is recorded but carries
              zero weight in the pass-rate/pairing decision.

Machine constraints on top: at least ``min_families`` distinct families (when
the pool allows), at most ``max_per_family`` questions per family, >=60%
overlap with the previous round, and least-recently-used rotation as the
tie-breaker so the pool is not pinned to the same four shapes forever.

The agent's own ``selected`` list is honoured where it satisfies a role, and
replaced where it does not — the correction is recorded in the rationale.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence

PURPOSE_REGRESSION = "regression"
PURPOSE_REPAIR = "repair"
PURPOSE_PROBE = "probe"
MAIN_PURPOSES = (PURPOSE_REGRESSION, PURPOSE_REPAIR)

MIN_OVERLAP_RATIO = 0.6


@dataclass
class Selection:
    selected: List[str] = field(default_factory=list)
    purposes: Dict[str, str] = field(default_factory=dict)
    rationale: str = ""
    families: List[str] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "selected": self.selected,
            "purposes": self.purposes,
            "rationale": self.rationale,
            "families": self.families,
            "notes": self.notes,
        }


def _family(pool: Any, iid: str) -> str:
    try:
        inst = pool.get(iid)
    except Exception:  # noqa: BLE001
        return ""
    return str(getattr(inst, "family", "") or "")


def _regime(pool: Any, iid: str) -> str:
    """decode (M<=32) vs prefill (M>32) — a stronger axis than operator."""
    try:
        inst = pool.get(iid)
    except Exception:  # noqa: BLE001
        return ""
    try:
        m = int(getattr(inst, "M", 0) or 0)
    except (TypeError, ValueError):
        return ""
    if m <= 0:
        return ""
    return "decode" if m <= 32 else "prefill"


def _rotation_key(rotation: Mapping[str, int], iid: str) -> int:
    try:
        return int(rotation.get(iid, 0))
    except (TypeError, ValueError):
        return 0


def _scope_ids(plan: Optional[Any]) -> List[str]:
    """Ids the change declares it will improve / must keep unchanged."""
    ids: List[str] = []
    changes = getattr(plan, "changes", None)
    if changes is None and isinstance(plan, Mapping):
        changes = plan.get("changes")
    for change in changes or []:
        scope = change.get("scope") if isinstance(change, Mapping) else None
        if not isinstance(scope, Mapping):
            continue
        for bucket in ("expected_improve", "unchanged", "at_risk"):
            bucket_ids = scope.get(bucket)
            if isinstance(bucket_ids, str):
                bucket_ids = [bucket_ids]
            for iid in bucket_ids or []:
                if isinstance(iid, str) and iid not in ids:
                    ids.append(iid)
    return ids


def _pick_spread(candidates: Sequence[str], pool: Any, used_families: set,
                 count: int, used_regimes: Optional[set] = None) -> List[str]:
    """Pick ``count`` ids preferring uncovered regimes, then families.

    Regime first: decode (M<=32) and prefill (M>32) need completely different
    kernels, so a round that covers four prefill families but no decode
    question would miss the harder, more valuable half of the space.
    """
    used_regimes = used_regimes if used_regimes is not None else set()

    def rank(iid: str) -> tuple:
        regime = _regime(pool, iid)
        family = _family(pool, iid)
        return (
            0 if (regime and regime not in used_regimes) else 1,
            0 if (family and family not in used_families) else 1,
        )

    picked: List[str] = []
    remaining = list(candidates)
    # Greedy: re-rank after every pick so the second anchor prefers the regime
    # the first one did not cover (a pre-sorted pass would keep picking the
    # same regime).
    while len(remaining) > 0 and len(picked) < count:
        remaining.sort(key=lambda i: (rank(i), candidates.index(i)))
        best = remaining[0]
        regime = _regime(pool, best)
        family = _family(pool, best)
        redundant = bool(family and family in used_families
                         and regime in used_regimes)
        if redundant and len(remaining) > (count - len(picked)):
            remaining.pop(0)
            continue
        remaining.pop(0)
        picked.append(best)
        if family:
            used_families.add(family)
        if regime:
            used_regimes.add(regime)
    return picked


def select_questions(*, pool: Any, budget: int,
                     prev_selected: Sequence[str] = (),
                     prev_results: Optional[Mapping[str, Mapping[str, Any]]] = None,
                     plan: Optional[Any] = None,
                     rotation: Optional[Mapping[str, int]] = None,
                     min_families: int = 3,
                     max_per_family: int = 2,
                     anchor_min: int = 2) -> Selection:
    """Return this round's question set with per-question roles."""
    budget = int(budget)
    rotation = rotation or {}
    prev_results = prev_results or {}
    notes: List[str] = []
    purposes: Dict[str, str] = {}
    stages: Dict[str, str] = {}

    all_ids = list(pool.all_ids())
    families_available = {_family(pool, i) for i in all_ids}
    families_available.discard("")
    target_families = min(int(min_families), max(1, len(families_available)))

    if budget <= 0 or not all_ids:
        return Selection(selected=[], purposes={}, rationale="empty pool")

    prev = [i for i in prev_selected if i in pool.instances]
    passed = [i for i in prev if (prev_results.get(i) or {}).get("passed") is True]
    failed = [i for i in prev
              if prev_results.get(i) is not None
              and (prev_results.get(i) or {}).get("passed") is not True]
    scope_all = [i for i in _scope_ids(plan) if i in pool.instances]
    scope_improve = [i for i in _scope_ids(plan) if i in pool.instances]
    scope_risk: List[str] = []
    changes = getattr(plan, "changes", None)
    if changes is None and isinstance(plan, Mapping):
        changes = plan.get("changes")
    for change in changes or []:
        scope = change.get("scope") if isinstance(change, Mapping) else None
        if not isinstance(scope, Mapping):
            continue
        for iid in scope.get("at_risk") or []:
            if isinstance(iid, str) and iid in pool.instances and iid not in scope_risk:
                scope_risk.append(iid)
        for iid in scope.get("expected_improve") or []:
            if isinstance(iid, str) and iid in pool.instances and iid not in scope_improve:
                scope_improve.append(iid)

    agent_ids: List[str] = []
    plan_selected = getattr(plan, "selected", None)
    if plan_selected is None and isinstance(plan, Mapping):
        plan_selected = plan.get("selected")
    for iid in plan_selected or []:
        if isinstance(iid, str) and iid in pool.instances and iid not in agent_ids:
            agent_ids.append(iid)

    chosen: List[str] = []
    used_families: set = set()
    used_regimes: set = set()

    def _take(iid: str, purpose: str, stage: str) -> None:
        if iid in chosen or len(chosen) >= budget:
            return
        chosen.append(iid)
        purposes[iid] = purpose
        stages[iid] = stage
        used_families.add(_family(pool, iid))
        if _regime(pool, iid):
            used_regimes.add(_regime(pool, iid))

    def _family_counts() -> Dict[str, int]:
        counts: Dict[str, int] = {}
        for iid in chosen:
            fam = _family(pool, iid)
            counts[fam] = counts.get(fam, 0) + 1
        return counts

    def _lru(candidates: Sequence[str]) -> List[str]:
        return sorted(candidates, key=lambda i: (_rotation_key(rotation, i), i))

    def _drop_one(protect: Sequence[str] = (PURPOSE_REGRESSION,)) -> Optional[str]:
        """Remove the least important question to make room."""
        order = ["fill", "agent", "repair", "probe", "regression"]
        for stage in order:
            victims = [i for i in chosen if stages.get(i) == stage]
            for victim in reversed(victims):
                if purposes.get(victim) in protect:
                    # keep at least two regression anchors
                    if purposes.get(victim) == PURPOSE_REGRESSION and \
                            list(purposes.values()).count(PURPOSE_REGRESSION) > 2:
                        pass
                    else:
                        continue
                chosen.remove(victim)
                purposes.pop(victim, None)
                stages.pop(victim, None)
                return victim
        return None

    # 1) regression anchors (2): passed last round, scope-aware, family-spread
    anchor_pool = [i for i in scope_improve + scope_all if i in passed] or list(passed)
    if not anchor_pool:
        anchor_pool = list(pool.historical_ids())
        if prev:
            notes.append("no passed question last round; anchors from history")
    anchor_want = 2 if budget >= 3 else 1
    for iid in _pick_spread(anchor_pool, pool, used_families, anchor_want,
                            used_regimes):
        _take(iid, PURPOSE_REGRESSION, "anchor")

    # 2) agent picks that already fit a role
    for iid in agent_ids:
        if len(chosen) >= budget:
            break
        if iid in passed and iid not in chosen:
            _take(iid, PURPOSE_REGRESSION, "agent")
        elif iid in failed and iid not in chosen:
            _take(iid, PURPOSE_REPAIR, "agent")

    # 3) repair slot: at-risk scope first, then whatever lost, then LRU
    if budget >= 2 and PURPOSE_REPAIR not in purposes.values():
        repair_pool = [i for i in scope_risk + list(failed)
                       if i not in chosen]
        if not repair_pool:
            repair_pool = _lru([i for i in all_ids if i not in chosen])
            if failed:
                notes.append("repair slot filled by least-recently-examined question")
        for iid in _pick_spread(repair_pool, pool, used_families, 1,
                                used_regimes):
            _take(iid, PURPOSE_REPAIR, "repair")

    # 4) fill remaining slots: scope-improve first, then least-recently-used
    if len(chosen) < budget:
        fill_pool = [i for i in scope_improve if i not in chosen]
        fill_pool += _lru([i for i in all_ids if i not in chosen
                           and i not in fill_pool])
        for iid in _pick_spread(fill_pool, pool, used_families,
                                budget - len(chosen), used_regimes):
            _take(iid, PURPOSE_REGRESSION if iid in passed else PURPOSE_REPAIR,
                  "fill")

    # 5) generalisation probe: prefer a family nothing else covers
    if budget >= 2:
        uncovered = _lru([i for i in all_ids if i not in chosen
                          and _family(pool, i)
                          and _family(pool, i) not in used_families])
        if not uncovered:
            uncovered = _lru([i for i in all_ids if i not in chosen
                              and _regime(pool, i)
                              and _regime(pool, i) not in used_regimes])
        if uncovered:
            probe_id = uncovered[0]
            if len(chosen) >= budget:
                victim = _drop_one()
                if victim is not None:
                    notes.append(f"replaced {victim} with cross-family probe "
                                 f"{probe_id}")
            _take(probe_id, PURPOSE_PROBE, "probe")
        else:
            # No untouched family left: promote the freshest question whose
            # family appears once in this round (it is the generalisation
            # signal), instead of swapping the set around.
            counts = _family_counts()
            singles = [i for i in chosen
                       if counts.get(_family(pool, i), 0) == 1
                       and i not in probe_ids(purposes)]
            singles.sort(key=lambda i: (
                purposes.get(i) == PURPOSE_REGRESSION,
                _rotation_key(rotation, i), i))
            if singles:
                probe_id = singles[0]
                purposes[probe_id] = PURPOSE_PROBE
                stages[probe_id] = "probe"
                notes.append(f"probe is the unique-family question "
                             f"{probe_id} already in the round")
            else:
                fallback = _lru([i for i in all_ids if i not in chosen])
                if fallback:
                    probe_id = fallback[0]
                    victim = _drop_one() if len(chosen) >= budget else None
                    if victim is not None:
                        notes.append(f"replaced {victim} with probe {probe_id}")
                    _take(probe_id, PURPOSE_PROBE, "probe")
                    notes.append("pool exhausted per family; probe is the "
                                 "freshest remaining question")
                else:
                    notes.append("no cross-family probe available in the pool")

    # ---------------------------------------------------- machine guardrails
    if max_per_family > 0:
        counts = _family_counts()
        for iid in list(chosen):
            fam = _family(pool, iid)
            if counts.get(fam, 0) <= max_per_family:
                continue
            replacement = next(
                (c for c in _lru([i for i in all_ids if i not in chosen])
                 if _family(pool, c)
                 and counts.get(_family(pool, c), 0) < max_per_family
                 and _family(pool, c) not in used_families),
                None,
            )
            if replacement is None:
                continue
            counts[fam] -= 1
            counts[_family(pool, replacement)] = counts.get(
                _family(pool, replacement), 0) + 1
            purposes[replacement] = purposes.get(iid, PURPOSE_REPAIR)
            stages[replacement] = stages.get(iid, "fill")
            purposes.pop(iid, None)
            stages.pop(iid, None)
            chosen[chosen.index(iid)] = replacement
            used_families = {_family(pool, c) for c in chosen}
            notes.append(f"family quota: {iid} -> {replacement}")

    # overlap: keep round-to-round comparability
    if prev:
        need = int(MIN_OVERLAP_RATIO * len(prev))
        overlap = len(set(chosen) & set(prev))
        for iid in prev:
            if overlap >= need or not chosen:
                break
            if iid in chosen:
                continue
            victim = _drop_one(protect=(PURPOSE_REGRESSION, PURPOSE_REPAIR))
            if victim is None:
                break
            notes.append(f"overlap backfill: {victim} -> {iid}")
            _take(iid, PURPOSE_REGRESSION, "overlap")
            overlap += 1

    # anchors: at least anchor_min ids with accepted history
    anchor_set = set(pool.historical_ids())
    have = sum(1 for i in chosen if i in anchor_set)
    if have < anchor_min:
        for iid in _lru([i for i in anchor_set if i not in chosen]):
            if have >= anchor_min:
                break
            victim = _drop_one(protect=(PURPOSE_REGRESSION,))
            if victim is None:
                break
            _take(iid, PURPOSE_REGRESSION, "anchor")
            have += 1
            notes.append(f"anchor backfill: added {iid}")

    families = sorted({_family(pool, i) for i in chosen if _family(pool, i)})
    regimes = sorted({_regime(pool, i) for i in chosen if _regime(pool, i)})
    if len(regimes) < 2 and len({_regime(pool, i) for i in all_ids
                                 if _regime(pool, i)}) >= 2:
        notes.append(f"regime coverage {regimes} covers a single regime")
    if len(families) < target_families:
        notes.append(f"family coverage {len(families)} < target {target_families}")

    rationale = (
        "roles: " + ", ".join(f"{i}={purposes.get(i)}" for i in chosen)
        + f" | families: {', '.join(families)}"
        + f" | regimes: {', '.join(regimes)}"
        + (f" | notes: {'; '.join(notes)}" if notes else "")
    )
    return Selection(selected=list(chosen),
                     purposes={i: purposes[i] for i in chosen if i in purposes},
                     rationale=rationale, families=families, notes=notes)


def overlap_ratio(selected: Sequence[str], prev: Sequence[str]) -> float:
    if not prev:
        return 1.0
    return len(set(selected) & set(prev)) / len(set(prev))


def main_purposes(purposes: Mapping[str, str]) -> List[str]:
    """Ids that take part in the pass-rate / win-loss decision."""
    return [i for i, p in (purposes or {}).items() if p in MAIN_PURPOSES]


def probe_ids(purposes: Mapping[str, str]) -> List[str]:
    return [i for i, p in (purposes or {}).items() if p == PURPOSE_PROBE]
