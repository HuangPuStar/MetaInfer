"""Generation-level champion selection for harness_evolve.

The decision engine compares the candidate harness against a *champion*. Using
"the last generation that happened to be PROMOTEd" is wrong: a generation can
hold the best measured result and still not be promoted in its own round (its
change needed confirmation, or only one question won). If the next generation
is worse but does get promoted, that worse harness would take the champion
slot.

This module keeps one record per evaluated generation and picks the champion by
*measured merit*:

1. generations whose verdict was REJECT / REJECT_OVERFIT are disqualified
   (they were proven not to generalise or to regress);
2. more passing questions wins (absolute count on each generation's own set);
3. otherwise, on the questions the two generations share, more WINs wins;
4. otherwise the generation with the better cross-shape median wins;
5. ties keep the earlier generation (stability over novelty).

The champion is therefore "the best harness we have measured so far", which is
what every later round must beat — even if that generation was never promoted
at the time.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional

GENERATIONS_FILE = "generations.jsonl"
_REJECTED_VERDICTS = {"REJECT", "REJECT_OVERFIT"}
_PENDING_VERDICTS = {"CONFIRM_REQUIRED"}


@dataclass
class Generation:
    iteration: int
    verdict: str = ""
    results: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    snapshot_dir: str = ""
    workspace_revision: str = ""
    pass_count: int = 0
    rejected: bool = False
    pending: bool = False

    def __post_init__(self) -> None:
        # the verdict decides qualification; keep the two flags in sync
        if self.verdict in _REJECTED_VERDICTS:
            self.rejected = True
        if self.verdict in _PENDING_VERDICTS:
            self.pending = True

    def to_dict(self) -> Dict[str, Any]:
        return {
            "iteration": self.iteration,
            "verdict": self.verdict,
            "pass_count": self.pass_count,
            "rejected": self.rejected,
            "pending": self.pending,
            "snapshot_dir": self.snapshot_dir,
            "workspace_revision": self.workspace_revision,
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any],
                  results: Optional[Mapping[str, Any]] = None) -> "Generation":
        verdict = str(data.get("verdict") or "")
        return cls(
            iteration=int(data.get("iteration") or 0),
            verdict=verdict,
            results=dict(results or {}),
            snapshot_dir=str(data.get("snapshot_dir") or ""),
            workspace_revision=str(data.get("workspace_revision") or ""),
            pass_count=int(data.get("pass_count") or 0),
            rejected=bool(data.get("rejected", verdict in _REJECTED_VERDICTS)),
            pending=bool(data.get("pending", verdict in _PENDING_VERDICTS)),
        )


def _median(row: Mapping[str, Any]) -> Optional[float]:
    try:
        value = float(row.get("median_us"))
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def load_generations(exp_dir: Path) -> List[Generation]:
    """Every evaluated generation, oldest first, with its measured results."""
    exp = Path(exp_dir)
    path = exp / GENERATIONS_FILE
    records: List[Dict[str, Any]] = []
    if path.is_file():
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if isinstance(row, dict):
                records.append(row)
    out: List[Generation] = []
    for row in sorted(records, key=lambda r: int(r.get("iteration") or 0)):
        iteration = int(row.get("iteration") or 0)
        results_path = (exp / "runs" / f"iteration_{iteration:03d}" / "input"
                        / "benchmark" / "results.json")
        results: Dict[str, Any] = {}
        if results_path.is_file():
            try:
                results = json.loads(results_path.read_text(encoding="utf-8")) or {}
                results = results.get("results", results)
            except (OSError, ValueError):
                results = {}
        out.append(Generation.from_dict(row, results))
    return out


def record_generation(exp_dir: Path, generation: Generation) -> None:
    """Append (or replace) one generation record."""
    exp = Path(exp_dir)
    path = exp / GENERATIONS_FILE
    rows: List[Dict[str, Any]] = []
    if path.is_file():
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if isinstance(row, dict) and int(row.get("iteration") or 0) != generation.iteration:
                rows.append(row)
    rows.append(generation.to_dict())
    rows.sort(key=lambda r: int(r.get("iteration") or 0))
    path.write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n",
        encoding="utf-8")


def _pass_count(results: Mapping[str, Mapping[str, Any]]) -> int:
    return sum(1 for row in results.values() if row.get("passed") is True)


def _wins(a: Mapping[str, Mapping[str, Any]],
          b: Mapping[str, Mapping[str, Any]], noise_percent: float) -> int:
    """How many questions generation ``a`` beats generation ``b`` on."""
    wins = 0
    for iid in set(a) & set(b):
        ma, mb = _median(a[iid]), _median(b[iid])
        if ma is None or mb is None:
            continue
        delta = (mb - ma) / mb * 100.0        # positive => a is faster
        if delta > noise_percent:
            wins += 1
    return wins


def compare_generations(a: Generation, b: Generation, *,
                        noise_percent: float = 2.0) -> str:
    """Return ``\"a\"``, ``\"b\"`` or ``\"tie\"`` (a wins / b wins / no winner)."""
    if a.rejected and not b.rejected:
        return "b"
    if b.rejected and not a.rejected:
        return "a"
    a_pass, b_pass = _pass_count(a.results), _pass_count(b.results)
    if a_pass != b_pass:
        return "a" if a_pass > b_pass else "b"
    a_wins = _wins(a.results, b.results, noise_percent)
    b_wins = _wins(b.results, a.results, noise_percent)
    if a_wins != b_wins:
        return "a" if a_wins > b_wins else "b"
    # shared-question medians: compare the geometric mean of ratios
    shared = [iid for iid in set(a.results) & set(b.results)
              if _median(a.results[iid]) and _median(b.results[iid])]
    if shared:
        ratio = 1.0
        for iid in shared:
            ratio *= _median(a.results[iid]) / _median(b.results[iid])
        ratio **= 1.0 / len(shared)
        if ratio < 1.0 - noise_percent / 100.0:
            return "a"
        if ratio > 1.0 + noise_percent / 100.0:
            return "b"
    return "tie"


def best_generation(generations: List[Generation], *,
                    noise_percent: float = 2.0) -> Optional[Generation]:
    """The champion: best measured generation among non-rejected ones."""
    candidates = [g for g in generations if not g.rejected and g.results]
    if not candidates:
        return None
    best = candidates[0]
    for gen in candidates[1:]:
        winner = compare_generations(gen, best, noise_percent=noise_percent)
        if winner == "a":
            best = gen
    return best


def summarize(generations: List[Generation]) -> List[Dict[str, Any]]:
    """Cross-round review table: one row per generation."""
    champion = best_generation(generations)
    rows: List[Dict[str, Any]] = []
    for gen in generations:
        rows.append({
            **gen.to_dict(),
            "champion": bool(champion and champion.iteration == gen.iteration),
            "medians": {iid: _median(row)
                        for iid, row in sorted(gen.results.items())},
        })
    return rows
