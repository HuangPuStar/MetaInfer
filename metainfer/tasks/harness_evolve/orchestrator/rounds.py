"""Round question selection and gate evaluation for harness_evolve.

One HE run chases one deliverable: a harness version that can be promoted into
DKAO. The round structure is fixed by the operator:

* **Round 1 is a baseline round.** It draws 4 operators at random from the
  question pool, has DKAO measure them, and **judges nothing**: no gate is
  evaluated and nothing is promoted. The kernels that beat their variant go
  straight into the variant pool (that is a kernel fact, not a harness
  verdict). These 4 operators become the fixed **generalization paper**
  (``generalization_ids``) for the rest of the run.
* **Every later round** draws a fresh random set of 4 operators (never reusing
  the paper) and judges **only the performance gate**.
* When the performance gate passes, the *same* harness is handed to DKAO again
  with the paper's operators — that retake is the **generalization gate**, and
  it counts as half a round (``GENERALIZATION_ROUND_COST``).
* Both gates are counter rules against the variant: the performance gate needs
  >= 75% wins, the generalization gate >= 50% wins, and in both cases a
  non-winning operator may not fall below 80% of its variant.

Because a rejected candidate never reaches production, each round measures
against the same reference: "is this harness better than what the variant pool
currently holds".
"""

from __future__ import annotations

import json
import math
import random
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence

from .decision_engine import (
    GENERALIZATION_GATE_WIN_RATIO, PERFORMANCE_GATE_WIN_RATIO,
    gate_verdict,
)
from .variant import pool_instances, reference_results, resolve_variant

#: Operators per gate. The machine exposes 4 HCUs, so every round is sized in
#: multiples of 4: that keeps a wave able to fill all four devices at once and
#: keeps the two gates symmetric (the paper is one wave too).
OPERATORS_PER_GATE = 4
GPU_COUNT = 4

#: A round is split into two stages. ``performance`` hands a fresh operator set
#: to DKAO and judges only the performance gate; when that passes, the very same
#: harness is handed to DKAO a second time with the frozen paper — that retake
#: is the ``generalization`` stage. Round 1 is neither: it is a *baseline* round
#: that measures the paper and judges nothing.
STAGE_BASELINE = "baseline"
STAGE_PERFORMANCE = "performance"
STAGE_GENERALIZATION = "generalization"

#: What each stage costs against the round budget. A normal round is 1.0; the
#: generalization retake is half a round (the operator asked for "iteration
#: 2.5"), because it re-runs a fixed, already-chosen paper instead of opening a
#: new round of the search.
PERFORMANCE_ROUND_COST = 1.0
GENERALIZATION_ROUND_COST = 0.5

#: The frozen "retake the paper with this harness" request.
PENDING_GENERALIZATION_FILE = "pending_generalization.json"

#: Directory holding one evaluation attempt's DKAO children
#: (``children/<attempt dir>/<operator>``). Each attempt -- a first run and
#: every environment retry of it, and the generalization retake -- gets its own,
#: so no two DKAO runs ever share a child workspace.
CHILDREN_DIR = "children"


def round_stage(*, iteration: int, pending: Optional[Dict[str, Any]]) -> str:
    """Which stage this pass through the loop is.

    A pending generalization retake wins over the round number: the loop may
    come back to the same iteration to retake the paper, and that pass is the
    ``generalization`` stage even though its directory is ``iteration_002``.
    """
    if pending:
        return STAGE_GENERALIZATION
    return STAGE_BASELINE if int(iteration) <= 1 else STAGE_PERFORMANCE


def iteration_of_dir_name(name: str) -> int:
    """The iteration a ``children/<name>`` directory belongs to (0 if none).

    Names are ``iteration_NNN`` plus optional suffixes (``_a2`` for a retry,
    ``_generalization`` for the retake). The iteration is always the second
    underscore-separated field, so it is read by position: a regex would also
    match the attempt counter and silently merge two rounds' children.
    """
    parts = str(name).split("_")
    if len(parts) < 2 or parts[0] != "iteration":
        return 0
    try:
        return int(parts[1])
    except ValueError:
        return 0


def stage_dir_name(stage: str, iteration: int, *, attempt: int = 1) -> str:
    """Directory under ``<exp>/children`` holding one evaluation attempt.

    Every attempt gets its own directory. A retry of one question is a *new*
    DKAO run, and DKAO binds the child workspace's ``main`` symlink to the exact
    kernel repo it was told to use: reusing the directory makes the retry die in
    seconds with "workspace main already points to ..., not requested ...",
    which turns a transient environment hiccup into an apparently permanent
    failure that burns the whole retry budget. A fresh directory also keeps each
    attempt's evidence instead of overwriting the one that failed.
    """
    name = f"iteration_{int(iteration):03d}"
    if int(attempt) > 1:
        name += f"_a{int(attempt)}"
    if stage == STAGE_GENERALIZATION:
        name += "_generalization"
    return name


def attempt_dirs(children_root: Path, iteration: int) -> List[Path]:
    """Every attempt directory of one iteration, oldest attempt first.

    The retake sorts after the performance pass it belongs to (both carry
    ``_generalization`` in the name only for the retake's own directory).
    """
    root = Path(children_root)
    if not root.is_dir():
        return []
    found = [d for d in root.iterdir()
             if d.is_dir() and iteration_of_dir_name(d.name) == int(iteration)]
    return sorted(found, key=lambda d: (d.name.count("_a"),
                                        "_generalization" in d.name, d.name))


def resolve_child_dir(children_root: Path, iteration: int,
                      question_id: str) -> Optional[Path]:
    """The directory holding one question's current attempt (newest wins).

    ``None`` means the question has no child in this iteration at all: returning
    a path that does not exist would make "not measured" look like "measured,
    directory missing" to every caller.
    """
    found = [d / str(question_id) for d in attempt_dirs(children_root, iteration)
             if (d / str(question_id)).is_dir()]
    return found[-1] if found else None


def child_dir_map(children_root: Path, iteration: int) -> Dict[str, Path]:
    """``{question_id: directory}`` for one iteration, newest attempt wins."""
    out: Dict[str, Path] = {}
    for attempt_dir in attempt_dirs(children_root, iteration):
        for qid in sorted(p.name for p in attempt_dir.iterdir() if p.is_dir()):
            out[qid] = attempt_dir / qid
    return out


def stage_seconds(pending: Optional[Dict[str, Any]]) -> int:
    """Stable suffix making a retake's child ids distinct from the first pass."""
    if not pending:
        return 0
    try:
        return int(pending.get("frozen_at") or 0)
    except (TypeError, ValueError):
        return 0


def device_for_index(index: int) -> int:
    """The device a question at ``index`` in a round is handed to.

    A fixed rotation, not a reading of the cards: ``harness_evolve`` does not
    manage GPU occupancy (DKAO's own admission gate does), so the assignment
    only has to be a stable, even layout — N questions land as N / 4 sequential
    waves with one question per device in each.
    """
    return int(index) % GPU_COUNT


def normalized_per_gate(value: Any, default: int = OPERATORS_PER_GATE) -> int:
    """Round the requested question count to a non-zero multiple of 4.

    A count that is not a multiple of 4 would leave devices idle in a wave, so
    it is rounded up to the next multiple (and anything unusable falls back to
    the default).
    """
    try:
        count = int(value)
    except (TypeError, ValueError):
        return default
    if count <= 0:
        return default
    if count % GPU_COUNT:
        count = ((count // GPU_COUNT) + 1) * GPU_COUNT
    return count


#: An operator is "decode" at small M and "prefill" at large M, matching the
#: family naming the pool uses (``decode__o_proj`` / ``prefill__o_proj``).
DECODE_MAX_M = 32
REGIME_DECODE = "decode"
REGIME_PREFILL = "prefill"


def regime_of(entry: Dict[str, Any]) -> str:
    """Which regime an operator belongs to (family first, shape as fallback)."""
    family = str(entry.get("family") or "")
    if family.startswith(REGIME_DECODE + "__"):
        return REGIME_DECODE
    if family.startswith(REGIME_PREFILL + "__"):
        return REGIME_PREFILL
    contract = entry.get("contract") or {}
    try:
        m = int(contract.get("M") or 0)
    except (TypeError, ValueError):
        m = 0
    return REGIME_DECODE if 0 < m <= DECODE_MAX_M else REGIME_PREFILL


def sample_operators(instances: Dict[str, Dict[str, Any]], *,
                     table: Optional[Dict[str, Any]] = None,
                     count: int = OPERATORS_PER_GATE,
                     exclude: Iterable[str] = (),
                     rng: Optional[random.Random] = None,
                     require_judgeable: bool = True,
                     require_regimes: bool = True,
                     ) -> List[str]:
    """A random operator sample, skipping ids that cannot be judged.

    ``require_judgeable`` keeps out operators with neither a variant nor a fixed
    baseline: those could not produce a win/loss, so they would only dilute the
    ratio.

    ``require_regimes`` guarantees the sample spans both regimes (at least one
    decode and at least one prefill) so a round is never judged on a single
    shape class; the rest of the sample is filled at random from everything
    that is left.
    """
    excluded = {str(x) for x in exclude}
    available = [iid for iid in instances if iid not in excluded]
    if require_judgeable:
        available = [iid for iid in available
                     if resolve_variant(table or {}, iid,
                                        instances=instances) is not None]
    if not available:
        return []
    picker = rng or random
    count = max(1, min(int(count), len(available)))
    picked: List[str] = []
    if require_regimes:
        for regime in (REGIME_DECODE, REGIME_PREFILL):
            members = [iid for iid in available
                       if regime_of(instances[iid]) == regime
                       and iid not in picked]
            if members and len(picked) < count:
                picked.append(picker.choice(sorted(members)))
    rest = [iid for iid in available if iid not in picked]
    picker.shuffle(rest)
    picked.extend(rest[:max(0, count - len(picked))])
    return sorted(picked[:count])


def _statement_groups(state: Dict[str, Any]) -> Dict[str, Any]:
    """The persisted groups, whichever shape the caller handed over.

    The pipeline passes what :func:`group_state` returned (the groups dict
    itself); older callers wrap it as ``{"groups": ...}``. Reading only one of
    the two shapes silently loses the frozen paper — and a lost paper means the
    performance draw may hand the generalization exam's own operators back.
    """
    if not isinstance(state, dict):
        return {}
    nested = state.get("groups")
    if isinstance(nested, dict):
        return dict(nested)
    if "generalization_ids" in state:
        return dict(state)
    return {}


def select_round_questions(*, iteration: int,
                           table: Dict[str, Any],
                           instances: Dict[str, Dict[str, Any]],
                           state: Dict[str, Any],
                           count: int = OPERATORS_PER_GATE,
                           rng: Optional[random.Random] = None,
                           pending: Optional[Dict[str, Any]] = None,
                           ) -> Dict[str, Any]:
    """Which operators this pass measures, and in which role.

    Returns ``{"performance_ids", "generalization_ids", "defines_paper",
    "stage"}``.

    * ``pending`` set → this pass is the **generalization retake**: it measures
      exactly the paper, again, and judges the generalization gate. No new
      operators are drawn.
    * otherwise round 1 → the **baseline** round: it draws the paper (which
      becomes the fixed exam) and measures it, judging nothing.
    * otherwise → **performance** stage: a fresh random draw excluding the
      paper; the paper comes back only if this pass wins and the retake runs.
    """
    groups = _statement_groups(state)
    paper = list(groups.get("generalization_ids") or [])
    if pending:
        ids = [str(i) for i in (pending.get("operator_ids") or paper)]
        return {"performance_ids": ids, "generalization_ids": ids,
                "defines_paper": False, "stage": STAGE_GENERALIZATION}
    if iteration <= 1 or not paper:
        # Round 1 defines the generalization paper and measures it, but it is a
        # baseline round: nothing is judged and nothing is promoted from it.
        draw = sample_operators(instances, table=table, count=count, rng=rng)
        return {"performance_ids": draw, "generalization_ids": list(draw),
                "defines_paper": True, "stage": STAGE_BASELINE}
    performance = sample_operators(instances, table=table, count=count,
                                   exclude=paper, rng=rng)
    return {"performance_ids": performance,
            "generalization_ids": paper, "defines_paper": False,
            "stage": STAGE_PERFORMANCE}


def _load_json(path: Path) -> Any:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def read_pending_generalization(exp_dir: Path) -> Optional[Dict[str, Any]]:
    """The frozen retake request, if the last performance stage passed.

    While this file exists, the next pass through the loop is the
    generalization stage: the same harness bytes go to DKAO again, with the
    paper's operators. Nothing else is decided until that retake is judged.
    """
    data = _load_json(Path(exp_dir) / PENDING_GENERALIZATION_FILE)
    return data if isinstance(data, dict) else None


def write_pending_generalization(exp_dir: Path, *,
                                 iteration: int,
                                 harness_revision: str,
                                 snapshot_dir: Optional[str],
                                 operator_ids: Sequence[str],
                                 performance_gate: Dict[str, Any],
                                 ) -> Dict[str, Any]:
    """Freeze "retake the paper with this harness" for the next pass."""
    exp_dir = Path(exp_dir)
    payload = {
        "schema": "he-pending-generalization/1",
        "iteration": int(iteration),
        "operator_ids": [str(i) for i in operator_ids],
        "harness_revision": str(harness_revision or ""),
        "snapshot_dir": str(snapshot_dir) if snapshot_dir else None,
        "performance_wins": list(performance_gate.get("wins") or []),
        "performance_gate_status": performance_gate.get("status"),
        "frozen_at": time.time(),
    }
    exp_dir.mkdir(parents=True, exist_ok=True)
    path = exp_dir / PENDING_GENERALIZATION_FILE
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2,
                              sort_keys=True), encoding="utf-8")
    tmp.replace(path)
    return payload


def clear_pending_generalization(exp_dir: Path) -> None:
    try:
        (Path(exp_dir) / PENDING_GENERALIZATION_FILE).unlink()
    except OSError:
        pass


def evaluate_gate(*, kind: str, operator_ids: Sequence[str],
                  results: Dict[str, Any],
                  table: Dict[str, Any],
                  instances: Dict[str, Dict[str, Any]],
                  ) -> Dict[str, Any]:
    """Judge one gate's operator set against the variants they must beat."""
    ids = [iid for iid in operator_ids]
    reference = reference_results(table, ids, instances=instances)
    candidate = {iid: results[iid] for iid in ids if iid in results}
    verdict = gate_verdict(reference, candidate, kind=kind)
    verdict["iteration"] = None
    verdict["requested_ids"] = ids
    verdict["requested"] = len(ids)
    missing = [iid for iid in ids if iid not in results]
    if missing:
        unmeasured = sorted(set(verdict["unmeasured"]) | set(missing))
        verdict["unmeasured"] = unmeasured
        verdict["reasons"] = list(verdict["reasons"]) + [
            "not measured this round: " + ", ".join(sorted(missing))]
        # A gate is a statement about the harness, so it may only be made when
        # the round actually produced the evidence. Two cases are decided here:
        #
        #  * the measured part already loses — a question below the floor, or so
        #    few wins that even if every missing question won, the count would
        #    not reach the required wins. That is a FAIL, and saying so now
        #    saves the round a relaunch;
        #  * otherwise the outcome is open: the harness may be fine and the
        #    machine may have eaten a measurement. Marking that FAIL blames the
        #    harness for a missing number (and, on the generalization retake,
        #    spends the candidate on it), so the round carries no verdict and is
        #    re-measured instead.
        needed_total = (max(1, min(len(ids),
                                 math.ceil(len(ids) * gate_ratio(kind))))
                        if ids else 0)
        verdict["wins_needed_over_requested"] = needed_total
        possible_wins = len(verdict["wins"]) + len(unmeasured)
        if verdict["below_floor"] or possible_wins < needed_total:
            verdict["status"] = "FAIL"
            verdict["reasons"] = list(verdict["reasons"]) + [
                "gate cannot pass even if every unmeasured question won "
                f"({possible_wins} possible win(s) vs {needed_total} needed)"]
        else:
            verdict["status"] = "INCOMPLETE"
    return verdict


def group_state(table: Dict[str, Any]) -> Dict[str, Any]:
    """The persisted groups (the fixed generalization paper lives here)."""
    groups = table.get("groups")
    return dict(groups) if isinstance(groups, dict) else {}


def record_paper(table: Dict[str, Any], *, iteration: int,
                 generalization_ids: Sequence[str],
                 performance_ids: Sequence[str]) -> Dict[str, Any]:
    """Persist this run's fixed generalization paper on the variant table.

    The paper is written once and never replaced: it is the run's frozen exam,
    so a later round must not be able to move the goalposts.
    """
    groups = group_state(table)
    groups.setdefault("generalization_ids", list(generalization_ids))
    groups.setdefault("generalization_defined_at", iteration)
    groups["last_performance_ids"] = list(performance_ids)
    return groups


def baseline_round_verdict(results: Dict[str, Any],
                          operator_ids: Sequence[str]) -> Dict[str, Any]:
    """Whether the baseline round produced usable evidence for every operator.

    Round 1 judges no gate, so there is no win ratio to check — but it still
    owes one usable measurement per operator: the kernels that beat their
    variant are what seeds the pool for every later round to beat, and a paper
    that was never really measured cannot serve as the run's exam.
    """
    ids = [str(i) for i in operator_ids]
    unusable: List[str] = []
    for iid in ids:
        row = results.get(iid)
        if not isinstance(row, dict):
            unusable.append(iid)
            continue
        median = row.get("median_us")
        try:
            value = float(median)
        except (TypeError, ValueError):
            unusable.append(iid)
            continue
        if value <= 0 or row.get("correctness_ok") is False:
            unusable.append(iid)
    return {
        "status": "PASS" if not unusable else "FAIL",
        "operators": ids,
        "measured": sorted(set(ids) - set(unusable)),
        "failed": sorted(unusable),
        "reasons": ([] if not unusable else
                    ["baseline round produced no usable measurement for: "
                     + ", ".join(sorted(unusable))]),
    }


def gate_ratio(kind: str) -> float:
    return (PERFORMANCE_GATE_WIN_RATIO if kind == "performance"
            else GENERALIZATION_GATE_WIN_RATIO)


def paper_path(exp_dir: Path) -> Path:
    return Path(exp_dir) / "generalization_paper.json"
