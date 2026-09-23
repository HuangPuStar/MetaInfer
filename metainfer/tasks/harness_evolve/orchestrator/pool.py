"""Registered-instance pool + automatic pass criteria (suite protocol v2).

A "question" can only come from the pool: instances the user registered with a
frozen Triton baseline and a valid contract (they are the operators actually
integrated & measured, e.g. DeepSeek INT8 W8A8 GEMM family). AHE decides pass
automatically (``tau_family`` derived from each family's accepted history) and
picks per-round question sets via round_plan + machine guardrails (see
``docs/dkao_suite_protocol_v2.md``).
"""

from __future__ import annotations

import json
import statistics
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

DEFAULT_TAU = 0.6  # cold-start default: must beat baseline by >= 1/DEFAULT_TAU? see auto_pass


def family_of(M: int, operator: str) -> str:
    regime = "decode" if M <= 32 else "prefill"
    return f"{regime}__{operator}"


@dataclass
class PoolInstance:
    id: str
    model: str
    tp_size: int
    operator: str
    M: int
    N: int
    K: int
    baseline_us: float
    family: str = ""
    best_known_us: Optional[float] = None
    history: List[Dict[str, Any]] = field(default_factory=list)
    last_selected_round: Optional[int] = None

    @property
    def key(self) -> str:
        return self.id

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "contract": {
                "model": self.model, "tp_size": self.tp_size,
                "operator": self.operator, "M": self.M, "N": self.N,
                "K": self.K,
            },
            "family": self.family or family_of(self.M, self.operator),
            "baseline_us": self.baseline_us,
            "best_known_us": self.best_known_us,
            "history": self.history,
            "last_selected_round": self.last_selected_round,
        }


def _entry_to_instance(d: Dict[str, Any]) -> PoolInstance:
    c = d.get("contract") or {}
    baseline = d.get("baseline_us")
    if not isinstance(baseline, (int, float)) or baseline <= 0:
        raise ValueError(f"instance {d.get('id')} needs positive baseline_us")
    inst = PoolInstance(
        id=str(d["id"]),
        model=str(c.get("model", "")),
        tp_size=int(c.get("tp_size", 8)),
        operator=str(c.get("operator", "")),
        M=int(c.get("M", 0)),
        N=int(c.get("N", 0)),
        K=int(c.get("K", 0)),
        baseline_us=float(baseline),
        family=str(d.get("family") or family_of(int(c.get("M", 0)),
                                                 str(c.get("operator", "")))),
        best_known_us=(
            float(d["best_known_us"]) if d.get("best_known_us") else None
        ),
        history=list(d.get("history") or []),
        last_selected_round=(
            int(d["last_selected_round"]) if d.get("last_selected_round") is not None
            else None
        ),
    )
    return inst


class Pool:
    """Registered question pool (file-backed or built-in fixture)."""

    def __init__(self, instances: Optional[Dict[str, PoolInstance]] = None):
        self.instances: Dict[str, PoolInstance] = instances or {}

    @classmethod
    def from_yaml(cls, path: Path) -> "Pool":
        import yaml
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        entries = data.get("instances") if isinstance(data, dict) else data
        pool = cls()
        for d in entries or []:
            inst = _entry_to_instance(d)
            pool.register(inst)
        return pool

    def register(self, inst: PoolInstance) -> None:
        if inst.id in self.instances:
            raise ValueError(f"duplicate pool instance: {inst.id}")
        self.instances[inst.id] = inst

    def get(self, inst_id: str) -> PoolInstance:
        return self.instances[inst_id]

    def all_ids(self) -> List[str]:
        return sorted(self.instances)

    def assert_in_pool(self, ids: List[str]) -> None:
        unknown = [i for i in ids if i not in self.instances]
        if unknown:
            raise ValueError(f"instances not in pool: {unknown}")

    # -- per-family automatic target (tau) --------------------------------
    def family_ratios(self, family: str) -> List[float]:
        ratios = []
        for inst in self.instances.values():
            if (inst.family or family_of(inst.M, inst.operator)) != family:
                continue
            for rec in inst.history:
                if rec.get("accepted") is True and rec.get("median_us"):
                    try:
                        r = float(rec["median_us"]) / float(inst.baseline_us)
                    except (TypeError, ValueError, ZeroDivisionError):
                        continue
                    if 0 < r < 1.0:
                        ratios.append(r)
        return ratios

    def tau_family(self, family: str, quantile: float = 0.6,
                   default: float = DEFAULT_TAU) -> float:
        ratios = self.family_ratios(family)
        if not ratios:
            return default
        ratios.sort()
        idx = min(len(ratios) - 1, max(0, int(len(ratios) * quantile)))
        return max(0.05, ratios[idx])

    # -- auto pass ---------------------------------------------------------
    def auto_pass(self, inst_id: str, median_us: float, *,
                  correctness_ok: bool, p90_ok: bool) -> Dict[str, Any]:
        inst = self.get(inst_id)
        tau = self.tau_family(inst.family or family_of(inst.M, inst.operator))
        target_us = tau * float(inst.baseline_us)
        perf_ok = median_us <= target_us
        passed = bool(correctness_ok and perf_ok and p90_ok)
        return {
            "instance": inst_id,
            "passed": passed,
            "tau_family": tau,
            "target_us": round(target_us, 3),
            "median_us": round(float(median_us), 3),
            "correctness_ok": bool(correctness_ok),
            "p90_ok": bool(p90_ok),
        }

    # -- coverage / sampling helpers ---------------------------------------
    def stratified_sample(self, budget: int,
                          exclude: Optional[Set[str]] = None) -> List[str]:
        """Deterministic coverage-first sample: at least one per family/M-regime
        bucket when budget allows, then fill by insertion order."""
        exclude = exclude or set()
        by_family: Dict[str, List[str]] = {}
        for iid in self.all_ids():
            if iid in exclude:
                continue
            inst = self.instances[iid]
            fam = inst.family or family_of(inst.M, inst.operator)
            by_family.setdefault(fam, []).append(iid)
        picked: List[str] = []
        seen: Set[str] = set()
        for fam in sorted(by_family):
            if len(picked) >= budget:
                break
            iid = by_family[fam][0]
            picked.append(iid)
            seen.add(iid)
        for iid in self.all_ids():
            if len(picked) >= budget:
                break
            if iid not in seen and iid not in exclude:
                picked.append(iid)
                seen.add(iid)
        return picked

    def historical_ids(self) -> List[str]:
        """Instances with at least one accepted history record (anchor set)."""
        return [
            iid for iid, inst in self.instances.items() if inst.history
        ]

    def heldout_ids(self, k: int, *,
                    exclude: Optional[Set[str]] = None) -> List[str]:
        """Least-recently-selected instances (lightweight held-out probe)."""
        exclude = exclude or set()
        candidates = [
            (inst.last_selected_round if inst.last_selected_round is not None
             else -10**9, iid)
            for iid, inst in self.instances.items()
            if iid not in exclude
        ]
        candidates.sort()
        return [iid for _, iid in candidates[:k]]


# ---------------------------------------------------------------------------
# Built-in fixture pool (dry-run / tests). Real deployment loads a user pool
# file (registered operators with measured baselines).
# ---------------------------------------------------------------------------
def _default_instances() -> Dict[str, PoolInstance]:
    rows = [
        ("dsv4_tp8_qkv_proj_m16", "deepseek-v4", 8, "qkv_proj", 16, 1280, 4096, 100.0, 45.0),
        ("hy3_tp8_qkv_proj_m16", "hy3", 8, "qkv_proj", 16, 1280, 4096, 90.0, 40.0),
        ("hy3_tp8_o_proj_m16", "hy3", 8, "o_proj", 16, 4096, 1024, 60.0, 22.0),
        ("glm52_tp4_gate_up_m16", "glm52", 4, "shared_gate_up_proj", 16, 1024, 4096, 70.0, 30.0),
        ("hy3_tp8_qkv_proj_m4096", "hy3", 8, "qkv_proj", 4096, 1280, 4096, 10000.0, 5000.0),
        ("hy3_tp8_o_proj_m4096", "hy3", 8, "o_proj", 4096, 4096, 1024, 8000.0, 3000.0),
        ("hy3_tp8_gate_up_m4096", "hy3", 8, "shared_gate_up_proj", 4096, 384, 4096, 7000.0, 2500.0),
    ]
    insts = {}
    for iid, model, tp, op, m, n, k, base, best in rows:
        hist = [{"accepted": True, "median_us": best}]
        insts[iid] = PoolInstance(
            id=iid, model=model, tp_size=tp, operator=op, M=m, N=n, K=k,
            baseline_us=base, family=family_of(m, op),
            best_known_us=best, history=hist, last_selected_round=None,
        )
    return insts


def builtin_pool() -> Pool:
    return Pool(_default_instances())
