"""Per-operator variant table: the thing a candidate harness is measured against.

Terminology (fixed by the operator):

* **baseline** — the fixed Triton number for an operator (``baseline_us`` in the
  question pool). It never changes.
* **variant** — the *current best* result for an operator, plus the kernel that
  produced it. It is what every candidate is compared with.
* **harness** — the search policy (planner/gates). It does not measure or
  validate anything; it only steers which experiments DKAO tries, so "the new
  harness is better" means "it searches better", which is decided by comparing
  candidate results against the variants.

Update rule (operator decision, option **b**): the variant table only moves when
a harness is accepted and promoted into DKAO. A round that measures something
faster but is then rejected leaves the variant untouched — the comparison basis
must stay "what production currently is", otherwise the baseline would drift
while production did not.

The table is seeded from what already exists (the registered question pool's
``best_known_us``, and the experiment's own ``best_known.json``); operators
without a recorded variant are simply compared against their fixed baseline
until they are measured for real.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

import yaml

VARIANT_TABLE = "variant_table.json"
VARIANT_HISTORY = "variant_history.jsonl"

#: Fallback chain used when an operator has no recorded variant yet.
SOURCE_VARIANT = "variant"
SOURCE_BEST_KNOWN = "best_known"
SOURCE_BASELINE = "baseline"
SOURCE_NONE = "none"


def _load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _num(value: Any) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def pool_instances(pool_path: Path) -> Dict[str, Dict[str, Any]]:
    """``{operator_id: {baseline_us, best_known_us, family, contract}}``."""
    data = _load_json(Path(pool_path))
    if not isinstance(data, dict):
        try:
            data = yaml.safe_load(Path(pool_path).read_text(encoding="utf-8"))
        except (OSError, ValueError, yaml.YAMLError):
            return {}
    out: Dict[str, Dict[str, Any]] = {}
    for entry in (data or {}).get("instances") or []:
        if not isinstance(entry, dict):
            continue
        iid = str(entry.get("id") or "")
        if not iid:
            continue
        out[iid] = {
            "baseline_us": _num(entry.get("baseline_us")),
            "best_known_us": _num(entry.get("best_known_us")),
            "family": str(entry.get("family") or ""),
            "contract": dict(entry.get("contract") or {}),
            "history": list(entry.get("history") or []),
        }
    return out


def seed_from_pool(table: Dict[str, Any],
                   instances: Dict[str, Dict[str, Any]]) -> int:
    """Fill in variants for operators the pool already knows the best for.

    Only operators that have a measured ``best_known_us`` (an existing kernel
    that beat the baseline) become variants; the rest stay on their baseline
    until a round measures them. Nothing is re-measured here.
    """
    operators = table.setdefault("operators", {})
    seeded = 0
    for iid, entry in instances.items():
        best = entry.get("best_known_us")
        if best is None or iid in operators:
            continue
        operators[iid] = {
            "median_us": best,
            "p90_us": None,
            "correctness_ok": True,
            "kernel_source": "pool:best_known",
            "harness_version": table.get("harness_version"),
            "source_iteration": None,
            "family": entry.get("family") or "",
            "contract": entry.get("contract") or {},
            "conditions": {"origin": "registered_pool"},
            "recorded_at": None,
        }
        seeded += 1
    return seeded


def seed_from_experiment(table: Dict[str, Any], exp_dir: Path) -> int:
    """Fill in variants from the experiment's own ``best_known.json``."""
    data = _load_json(Path(exp_dir) / "best_known.json")
    if not isinstance(data, dict):
        return 0
    operators = table.setdefault("operators", {})
    seeded = 0
    for iid, entry in data.items():
        if not isinstance(entry, dict) or iid in operators:
            continue
        best = _num(entry.get("best_median_us"))
        if best is None:
            continue
        operators[str(iid)] = {
            "median_us": best,
            "p90_us": None,
            "correctness_ok": True,
            "kernel_source": f"experiment:iteration_{entry.get('best_iteration')}",
            "harness_version": table.get("harness_version"),
            "source_iteration": entry.get("best_iteration"),
            "family": "",
            "contract": {},
            "conditions": {"origin": "experiment_best_known"},
            "recorded_at": None,
        }
        seeded += 1
    return seeded


def load_variant_table(exp_dir: Path, *, pool_path: Optional[Path] = None,
                       create: bool = True) -> Dict[str, Any]:
    """Read the table, seeding it from existing data on first use."""
    exp_dir = Path(exp_dir)
    path = exp_dir / VARIANT_TABLE
    table = _load_json(path)
    if not isinstance(table, dict):
        table = {
            "schema_version": 1,
            "created_at": time.time(),
            "harness_version": None,
            "harness_dir": None,
            "operators": {},
            "groups": {},
            "seed_sources": [],
        }
    changed = False
    if pool_path is not None and Path(pool_path).is_file():
        seeded = seed_from_pool(table, pool_instances(Path(pool_path)))
        if seeded:
            table.setdefault("seed_sources", []).append(
                {"source": str(pool_path), "seeded": seeded, "ts": time.time()})
            changed = True
    seeded_exp = seed_from_experiment(table, exp_dir)
    if seeded_exp:
        table.setdefault("seed_sources", []).append(
            {"source": "best_known.json", "seeded": seeded_exp, "ts": time.time()})
        changed = True
    if changed or not path.is_file():
        if create:
            save_variant_table(exp_dir, table)
    return table


def save_variant_table(exp_dir: Path, table: Dict[str, Any]) -> Path:
    exp_dir = Path(exp_dir)
    exp_dir.mkdir(parents=True, exist_ok=True)
    table["updated_at"] = time.time()
    path = exp_dir / VARIANT_TABLE
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(table, ensure_ascii=False, indent=2, sort_keys=True),
                   encoding="utf-8")
    tmp.replace(path)
    return path


def resolve_variant(table: Dict[str, Any], operator_id: str, *,
                    instances: Optional[Dict[str, Dict[str, Any]]] = None,
                    ) -> Optional[Dict[str, Any]]:
    """The number this operator must beat, and where it came from.

    Order: recorded variant -> pool ``best_known_us`` -> fixed Triton
    ``baseline_us``. Returns ``None`` when nothing at all is known, in which
    case the operator cannot be judged this round.
    """
    entry = (table.get("operators") or {}).get(operator_id)
    if isinstance(entry, dict):
        median = _num(entry.get("median_us"))
        if median is not None:
            return {"operator_id": operator_id, "median_us": median,
                    "source": SOURCE_VARIANT,
                    "harness_version": entry.get("harness_version"),
                    "p90_us": entry.get("p90_us"),
                    "kernel_source": entry.get("kernel_source"),
                    "recorded_at": entry.get("recorded_at")}
    pool_entry = (instances or {}).get(operator_id) or {}
    best = _num(pool_entry.get("best_known_us"))
    if best is not None:
        return {"operator_id": operator_id, "median_us": best,
                "source": SOURCE_BEST_KNOWN, "harness_version": None,
                "p90_us": None, "kernel_source": "pool:best_known",
                "recorded_at": None}
    baseline = _num(pool_entry.get("baseline_us"))
    if baseline is not None:
        return {"operator_id": operator_id, "median_us": baseline,
                "source": SOURCE_BASELINE, "harness_version": None,
                "p90_us": None, "kernel_source": "triton_baseline",
                "recorded_at": None}
    return None


def reference_results(table: Dict[str, Any], operator_ids: Iterable[str], *,
                      instances: Optional[Dict[str, Dict[str, Any]]] = None,
                      ) -> Dict[str, Dict[str, Any]]:
    """A ``champion``-shaped result dict for :func:`compare_instances`.

    Each operator is represented by the variant it must beat, so the existing
    comparison/reporting code works unchanged.
    """
    out: Dict[str, Dict[str, Any]] = {}
    for iid in operator_ids:
        resolved = resolve_variant(table, iid, instances=instances)
        if resolved is None:
            continue
        out[iid] = {
            "status": "reference",
            "passed": True,
            "correctness_ok": True,
            "median_us": resolved["median_us"],
            "p90_us": resolved.get("p90_us"),
            "variant_source": resolved["source"],
            "variant_harness_version": resolved.get("harness_version"),
            "kernel_source": resolved.get("kernel_source"),
        }
    return out


def unjudgeable(table: Dict[str, Any], operator_ids: Iterable[str], *,
                instances: Optional[Dict[str, Dict[str, Any]]] = None,
                ) -> List[str]:
    """Operators with no variant and no baseline: they cannot be scored."""
    return [iid for iid in operator_ids
            if resolve_variant(table, iid, instances=instances) is None]


def variant_beats(resolved: Dict[str, Any],
                  metrics: Dict[str, Any]) -> bool:
    """Whether a measurement is faster than the variant it was compared with."""
    candidate = _num((metrics or {}).get("median_us"))
    if candidate is None:
        return False
    return candidate < _num(resolved.get("median_us")) or False


def record_variants(exp_dir: Path, table: Dict[str, Any], results: Dict[str, Any],
                    *, version: str, iteration: int,
                    groups: Optional[Dict[str, Any]] = None,
                    ) -> Dict[str, Any]:
    """Update the table after a harness is accepted and promoted (rule b).

    Only measured, correct results are recorded. Every change is appended to
    ``variant_history.jsonl`` so it is always clear which harness set which
    number.
    """
    exp_dir = Path(exp_dir)
    operators = table.setdefault("operators", {})
    recorded: List[Dict[str, Any]] = []
    history_path = exp_dir / VARIANT_HISTORY
    now = time.time()
    for iid, row in (results or {}).items():
        if not isinstance(row, dict):
            continue
        median = _num(row.get("median_us"))
        if median is None or row.get("correctness_ok") is False:
            continue
        previous = operators.get(iid) or {}
        previous_median = _num(previous.get("median_us"))
        if previous_median is not None and median >= previous_median:
            continue          # only a real improvement moves the variant
        operators[iid] = {
            "median_us": median,
            "p90_us": _num(row.get("p90_us")),
            "correctness_ok": True,
            "kernel_source": row.get("repo_path") or row.get("child_task_id"),
            "harness_version": version,
            "source_iteration": iteration,
            "family": row.get("family") or previous.get("family") or "",
            "contract": previous.get("contract") or {},
            "conditions": {
                "bench_profile": row.get("bench_profile"),
                "gate": "vram<=90,hcu==0",
            },
            "recorded_at": now,
        }
        change = {"ts": now, "operator_id": iid, "median_us": median,
                  "previous_median_us": previous_median,
                  "harness_version": version, "iteration": iteration}
        recorded.append(change)
        try:
            history_path.parent.mkdir(parents=True, exist_ok=True)
            with history_path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(change, ensure_ascii=False) + "\n")
        except OSError:
            pass
    table["harness_version"] = version
    if groups:
        table["groups"] = dict(groups)
    table["last_promoted_at"] = now
    save_variant_table(exp_dir, table)
    return {"updated": sorted(c["operator_id"] for c in recorded),
            "changes": recorded}
