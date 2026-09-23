"""round_plan: per-round question set chosen by the single Evolve role.

The evolve step produces BOTH the harness change and the next round's
``round_plan.json`` (strategy / rationale / selected / weights). Machine
guardrails in this module keep agent-chosen sets comparable and in-pool:
  - all ids must be in the pool;
  - overlap with the previous round's scored set >= 60% (auto back-fill);
  - budget cap enforced.
Decisions (flip / attribution / best-ever / rollback) are made on the overlap
pairs only (see docs/dkao_suite_protocol_v2.md).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from .pool import Pool

MIN_OVERLAP_RATIO = 0.6
VALID_STRATEGIES = ("explore", "exploit", "balanced")


@dataclass
class RoundPlan:
    iteration: int
    strategy: str = "balanced"
    rationale: str = ""
    selected: List[str] = field(default_factory=list)
    weights: Dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "iteration": self.iteration,
            "strategy": self.strategy,
            "rationale": self.rationale,
            "selected": self.selected,
            "weights": self.weights,
        }

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "RoundPlan":
        return cls(
            iteration=int(d.get("iteration", 0)),
            strategy=str(d.get("strategy") or "balanced"),
            rationale=str(d.get("rationale") or ""),
            selected=[str(x) for x in (d.get("selected") or [])],
            weights={
                str(k): float(v) for k, v in (d.get("weights") or {}).items()
            },
        )


def load_round_plan(path: Path) -> Optional[RoundPlan]:
    if not path.is_file():
        return None
    try:
        return RoundPlan.from_dict(
            json.loads(path.read_text(encoding="utf-8"))
        )
    except (OSError, ValueError):
        return None


def validate_in_pool(plan: RoundPlan, pool: Pool) -> None:
    if plan.strategy not in VALID_STRATEGIES:
        raise ValueError(
            f"strategy {plan.strategy!r} not in {VALID_STRATEGIES}"
        )
    pool.assert_in_pool(plan.selected)
    if len(set(plan.selected)) != len(plan.selected):
        raise ValueError("round_plan.selected contains duplicates")


def _top_up_anchors(
    picked: List[str],
    seen: set,
    pool: Pool,
    budget: int,
    anchor_min: int,
) -> List[str]:
    """Guarantee at least ``anchor_min`` instances WITH accepted history.

    Cold (baseline-only) shapes are allowed as questions, but every round must
    carry >= anchor_min historical anchors so family tau stays anchored and
    results stay comparable. Replaces trailing non-anchor picks if needed.
    """
    anchor_set = set(pool.historical_ids())
    have = sum(1 for i in picked if i in anchor_set)
    if have >= anchor_min:
        return picked
    for aid in pool.historical_ids():
        if have >= anchor_min:
            break
        if aid in seen:
            continue
        # make room by dropping the last non-anchor pick (never drop an anchor)
        drop_idx = next(
            (i for i in range(len(picked) - 1, -1, -1)
             if picked[i] not in anchor_set),
            None,
        )
        if drop_idx is not None:
            old = picked.pop(drop_idx)
            seen.discard(old)
        picked.append(aid)
        seen.add(aid)
        have += 1
        if len(picked) > budget:  # safety; budget >= anchor_min is required
            picked = picked[:budget]
    if have < anchor_min:
        raise ValueError(
            f"pool has fewer than {anchor_min} historical anchors; "
            "cannot satisfy the anchor rule"
        )
    return picked


def enforce_guardrails(
    prev_selected: List[str],
    plan: Optional[RoundPlan],
    pool: Pool,
    budget: int,
    anchor_min: int = 2,
) -> List[str]:
    """Return the final scored set for the next round.

    Guardrails:
    - budget must be >= anchor_min;
    - plan None / empty -> stratified default sample;
    - otherwise start from plan.selected (in pool);
    - overlap with previous scored set >= MIN_OVERLAP_RATIO (auto back-fill);
    - >= anchor_min instances must carry accepted history (anchor rule);
    - every id stays in the pool; total capped at budget.
    """
    budget = int(budget)
    if budget < anchor_min:
        raise ValueError(f"budget {budget} < anchor_min {anchor_min}")
    if plan is None or not plan.selected:
        picked = pool.stratified_sample(budget)
        return _top_up_anchors(picked, set(picked), pool, budget, anchor_min)[:budget]

    validate_in_pool(plan, pool)
    picked: List[str] = []
    seen: set = set()
    for iid in plan.selected:
        if iid not in seen:
            picked.append(iid)
            seen.add(iid)
        if len(picked) >= budget:
            break

    prev = [i for i in prev_selected if i in pool.instances]
    if prev:
        overlap = len(set(picked) & set(prev))
        need = int(MIN_OVERLAP_RATIO * len(prev))
        for iid in prev:
            if overlap >= need or len(picked) >= budget:
                break
            if iid not in seen:
                picked.append(iid)
                seen.add(iid)
                overlap += 1

    if len(picked) < budget:
        for iid in pool.stratified_sample(budget):
            if len(picked) >= budget:
                break
            if iid not in seen:
                picked.append(iid)
                seen.add(iid)
    return _top_up_anchors(picked, seen, pool, budget, anchor_min)[:budget]


ROTATION_FILE = "pool_rotation.json"


def load_rotation(exp_dir: Path) -> Dict[str, int]:
    """Per-question last-selected round (sidecar; the pool yaml stays read-only)."""
    path = Path(exp_dir) / ROTATION_FILE
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    out: Dict[str, int] = {}
    for key, value in data.items():
        try:
            out[str(key)] = int(value)
        except (TypeError, ValueError):
            continue
    return out


def mark_selected(exp_dir: Path, ids: List[str], iteration: int) -> Dict[str, int]:
    """Record that ``ids`` were examined in ``iteration`` (rotation fairness)."""
    rotation = load_rotation(exp_dir)
    for iid in ids:
        rotation[str(iid)] = int(iteration)
    try:
        (Path(exp_dir) / ROTATION_FILE).write_text(
            json.dumps(rotation, ensure_ascii=False, indent=2, sort_keys=True),
            encoding="utf-8")
    except OSError:
        pass
    return rotation
