"""Read-only Web routes for harness_evolve.

Serves the AHE experiment artifacts (workspace_dir of a task entry):
- /summary            report.md text + config snapshot + best_ever + scores
- /iterations         per-iteration benchmark/diff/change_evaluation/evolve/rollback
- /iterations/{n}/overview   analysis overview markdown (plain text)
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Mapping

from fastapi import APIRouter, HTTPException, Request

from metainfer.server._helpers import (
    require_task_type,
    state_dir_for,
    task_or_404,
    workspace_dir_for,
)
from metainfer.server.state_reader import read_requirements, read_run

from ..orchestrator import phases
from ..orchestrator.phases import PREPARE
from ..orchestrator.rounds import (
    CHILDREN_DIR, GPU_COUNT, child_dir_map, device_for_index,
    iteration_of_dir_name, resolve_child_dir,
)
from ..orchestrator.state import (
    read_target_iterations, write_target_iterations,
)

PLUGIN_TYPE = "harness-evolve"


def _load(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def _experiment_config(entry: Any, workspace_dir: Path):
    """Load the experiment config behind one task (for promotion commands)."""
    from ..orchestrator.config import load_experiment_config

    state_dir = Path(str(getattr(entry, "state_dir", "") or ""))
    req = state_dir / "requirements.json"
    if not req.is_file():
        raise HTTPException(404, f"requirements.json missing in {state_dir}")
    return load_experiment_config(req, state_dir, workspace_dir)


def _approve_with_config(entry: Any, workspace_dir: Path, by: str):
    from ..orchestrator.promotion import approve_promotion

    cfg = _experiment_config(entry, workspace_dir)
    return approve_promotion(cfg, cfg.exp_dir, approved_by=by)


def _deny_with_config(entry: Any, workspace_dir: Path, reason: str):
    from ..orchestrator.promotion import deny_promotion

    cfg = _experiment_config(entry, workspace_dir)
    return deny_promotion(cfg, cfg.exp_dir, reason=reason)


def _text(path: Path) -> str | None:
    if not path.is_file():
        return None
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def _jsonl(path: Path) -> List[Dict[str, Any]]:
    if not path.is_file():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            item = json.loads(line)
        except ValueError:
            continue
        if isinstance(item, dict):
            rows.append(item)
    return rows


def _iterations(exp: Path) -> List[Dict[str, Any]]:
    runs = exp / "runs"
    if not runs.is_dir():
        return []
    out: List[Dict[str, Any]] = []
    for d in sorted(runs.glob("iteration_*")):
        if not d.is_dir():
            continue
        i_dir = d / "input"
        e_dir = d / "evolve"
        entry: Dict[str, Any] = {
            "name": d.name,
            # Which gate this round judged, and what it concluded. The page must
            # show the round's real criterion (FLOW.md §3: the variant
            # comparison), not the pool's tau_family * baseline annotation.
            "stage": _load(i_dir / "stage.json", None),
            "performance_gate": _load(i_dir / "performance_gate.json", None),
            "generalization_gate": _load(
                i_dir / "generalization_gate.json", None),
            "baseline_round": _load(i_dir / "baseline_round.json", None),
            "benchmark": _load(i_dir / "benchmark" / "results.json", None),
            "scored_ids": _load(i_dir / "benchmark" / "scored_ids.json", None),
            "diff": _load(i_dir / "diff.json", None),
            "decision": _load(i_dir / "decision.json", None),
            "change_evaluation": _load(
                i_dir / "change_evaluation.json", None
            ),
            "rollback": _load(d / "rollback.json", None),
            "overview": (
                _text(i_dir / "analysis" / "overview.md") or ""
            )[:8000],
            "evolve_manifest": _load(
                e_dir / "change_manifest.json", None
            ),
            "round_plan": _load(e_dir / "round_plan.json", None),
            "evolve_summary": _text(e_dir / "evolve_summary.md") or "",
            "promotion": _load(d / "promotion.json", None),
            "mechanism_evidence": _load(
                i_dir / "mechanism_evidence.json", None),
            "purposes": (_load(i_dir / "benchmark" / "purposes.json", {})
                         or {}).get("purposes", {}),
        }
        out.append(entry)
    return out


def _child_best_median(workspace_dir: Path) -> Dict[str, Any]:
    """Fast per-child perf peek: best accepted median + completed rounds."""
    best: Optional[float] = None
    rounds = 0
    runs_root = workspace_dir / "workers"
    if runs_root.is_dir():
        for w in runs_root.glob("worker_*"):
            for exp_file in (w / "runs").glob("*/experiments.jsonl"):
                for row in _jsonl(exp_file):
                    rounds += 1
                    m = row.get("metrics") or {}
                    median = m.get("median_us")
                    if row.get("accepted") and isinstance(median, (int, float)):
                        best = median if best is None else min(best, float(median))
    return {"best_median_us": best, "rounds": rounds}


def _child_gate_audit(child_state_dir: Path, limit: int = 200) -> Dict[str, Any]:
    """One child's own DKAO admission-gate audit trail.

    ``harness_evolve`` does not manage GPU occupancy: it hands each question to
    a DKAO child and the child's engine decides when a card is clean enough to
    time a kernel. So the reason a question is "doing nothing" lives in that
    child's ``measurement_gate.jsonl`` — ``gate_blocked`` rows carry the reason
    (``VRAM 96% > 90% limit`` / ``device busy: HCU 100.0% > 0.0%``), the attempt
    number and the wait interval. This reads it read-only and never judges.

    One subtlety, because it decides what the UI may claim: a *passing* row also
    carries a ``reasons`` list, and those reasons belong to the *other*
    candidates that failed (``gpu`` on such a row is the device that passed
    while ``reasons`` describes the one that did not). So the reasons are only
    surfaced when the last verdict actually blocked, and the device this child
    is using is taken from the passing row, not from the reasons.
    """
    rows = _jsonl(child_state_dir / "measurement_gate.jsonl")[-limit:]
    # A gate call writes one row per channel, so identical rows double up.
    seen: set = set()
    unique: List[Dict[str, Any]] = []
    for row in rows:
        key = (round(float(row.get("ts") or 0), 1), row.get("event"),
               row.get("attempt"), row.get("site"))
        if key in seen:
            continue
        seen.add(key)
        unique.append(row)
    blocked = [r for r in unique if r.get("event") == "gate_blocked"]
    passed = [r for r in unique if r.get("event") == "gate_pass"
              or r.get("usable") is True]
    last = unique[-1] if unique else {}
    last_blocked = bool(last) and last.get("event") == "gate_blocked"

    def _device_of(row: Dict[str, Any]) -> Optional[int]:
        try:
            return int(row["gpu"]) if row.get("gpu") is not None else None
        except (TypeError, ValueError):
            return None

    # Which card this child is *measuring on* — not which card some gate call
    # happened to run on. The generate-stage probe may legitimately run on any
    # passing device ("the task's own card first, otherwise any idle one"), so a
    # probe row on GPU2 says nothing about a child pinned to GPU0. Rows from the
    # measuring sites (benchmark / PMC) do name the child's own card, so they are
    # preferred; only when none exists does a probe (or a block) stand in.
    own_card = None
    for row in reversed(passed):
        if str(row.get("site") or "") in ("benchmark", "profile_pmc"):
            own_card = _device_of(row)
            if own_card is not None:
                break
    if own_card is None:
        for row in reversed(passed):
            own_card = _device_of(row)
            if own_card is not None:
                break
    device = own_card
    if device is None:
        for row in reversed(blocked):
            device = _device_of(row)
            if device is not None:
                break
    probe_device = None
    for row in reversed(passed):
        if str(row.get("site") or "") == "generate_probe":
            probe_device = _device_of(row)
            if probe_device is not None:
                break
    return {
        "checks": len(unique),
        "blocked": len(blocked),
        "waited_seconds": sum(
            float(r.get("wait_seconds") or 0) for r in blocked),
        "device": device,
        # Every device this child's gate ever looked at: the card it measures on
        # plus any card a probe ran on. Kept apart from ``device`` so the page
        # can say "pinned to GPU0, probe passed on GPU2" instead of claiming the
        # child moved.
        "devices": sorted({d for d in (_device_of(r) for r in unique)
                           if d is not None}),
        "probe_device": probe_device,
        "device_from": ("gate_pass" if device is not None and passed
                        else ("gate_blocked" if device is not None else None)),
        "last_event": last.get("event"),
        "last_ts": last.get("ts"),
        "last_site": last.get("site"),
        "last_gpu": last.get("gpu"),
        "last_usable": last.get("usable"),
        "last_candidates": list(last.get("candidates") or []),
        "last_passing": list(last.get("passing") or []),
        # Only meaningful (and only about *this* device) when the verdict blocked.
        "last_reasons": (list(last.get("reasons") or []) if last_blocked
                         else []),
        "last_attempt": last.get("attempt"),
        "max_waits": last.get("max_waits"),
        "wait_seconds": last.get("wait_seconds"),
        "blocked_reasons": [
            {"ts": r.get("ts"), "site": r.get("site"), "gpu": r.get("gpu"),
             "attempt": r.get("attempt"), "reasons": list(r.get("reasons") or [])}
            for r in blocked[-10:]
        ],
    }


def _layout_devices(exp: Path, num: int) -> Dict[str, int]:
    """``question -> device`` exactly as HE recorded it for one round.

    ``gpu_preflight.json`` is a layout record, not an occupancy check: it says
    which card each question was handed to. That — not the card some later probe
    used — is what a per-card view must group by.
    """
    data = _load(exp / "runs" / f"iteration_{num:03d}" / "input" / "benchmark"
                 / "gpu_preflight.json", None)
    raw = data.get("devices") if isinstance(data, dict) else None
    out: Dict[str, int] = {}
    if isinstance(raw, dict):
        for qid, gpu in raw.items():
            try:
                out[str(qid)] = int(gpu)
            except (TypeError, ValueError):
                continue
    return out


def _assigned_device(requirements: Optional[Dict[str, Any]]) -> Optional[int]:
    """The card HE pinned for one child, from its ``shape_config``.

    The HE evaluator pins each question with a manual DKAO assignment, so the
    child's own requirements are a reliable second source when the round's layout
    record is missing (older rounds, hand-written requirements).
    """
    if not isinstance(requirements, dict):
        return None
    raw = requirements.get("shape_config")
    cfg: Any = raw
    if not isinstance(raw, dict):
        try:
            import yaml

            cfg = yaml.safe_load(str(raw or "")) or {}
        except Exception:  # noqa: BLE001 - a malformed config is simply no answer
            return None
    assignments = cfg.get("assignments") if isinstance(cfg, dict) else None
    if isinstance(assignments, dict):
        for worker in assignments.values():
            if isinstance(worker, dict) and worker.get("gpu") is not None:
                try:
                    return int(worker["gpu"])
                except (TypeError, ValueError):
                    continue
    return None


def _gpu_cards(exp: Path, num: int,
               answers: Optional[Dict[str, Any]] = None,
               ) -> List[Dict[str, Any]]:
    """Devices of one AHE iteration with the questions DKAO is measuring on them.

    One card per physical device, showing how far each child's inner DKAO task
    is and what it has measured. This replaces the old lease view read-only: HE
    holds no lease and reads no device state, so the card carries the child's
    own evidence — the device the child's gate cleared it for, and why it had to
    wait when it did.

    The device comes from that child's gate records. Only when a child has no
    gate record at all (it never reached a measurement) does the fixed
    ``index % GPU_COUNT`` rotation stand in, and then it is flagged as a
    prediction rather than reported as an observation.
    """
    children = _children_live(exp, num, answers)
    own = child_dir_map(exp / CHILDREN_DIR, num)
    layout = _layout_devices(exp, num)
    cards: Dict[int, Dict[str, Any]] = {}
    for idx, (qid, info) in enumerate(sorted(children.items())):
        state_dir = Path(str(info.get("child_state_dir") or (base / qid / "state")))
        gate = _child_gate_audit(state_dir)
        requirements = _load((own.get(qid) or Path()) / "requirements.json", None)
        assigned = _assigned_device(requirements)
        # Which card this question belongs to. HE's own layout for the round is
        # the answer ("index % 4", one question per card); a child that ran
        # before the layout was recorded falls back to the device HE pinned in
        # its requirements. The child's gate device is only a last resort: it can
        # name a *probe* card, which would put a child pinned to GPU0 under GPU2
        # and make a four-card view show two.
        if qid in layout:
            gpu, source = layout[qid], "layout"
        elif assigned is not None:
            gpu, source = assigned, "assignment"
        elif gate.get("device") is not None:
            gpu, source = int(gate["device"]), (gate.get("device_from") or "gate")
        else:
            gpu, source = device_for_index(idx), "predicted"
        info.update({
            "question": qid,
            "gpu": gpu,
            "gpu_source": source,
            "assigned_device": assigned,
            "gate_device": gate.get("device"),
            "gate_audit": gate,
            "requirements": requirements,
        })
        cards.setdefault(gpu, {"gpu": gpu, "questions": []})
        cards[gpu]["questions"].append(info)
    return [cards[g] for g in sorted(cards)]


def _gate_map(answers: Dict[str, Any], ids: List[str]) -> Dict[str, Dict[str, Any]]:
    """The *pool* criterion per instance: baseline, family tau, target median.

    This is ``pool.auto_pass`` (median <= tau_family * baseline). It is NOT the
    variant-round gate: since 2026-09-15 the performance/generalization gates
    compare against each operator's current *variant* (FLOW.md §3, served by
    :func:`_real_gate_map`), and a variant round never reaches ``auto_pass``
    (the variant branch ``continue``s before it). Keep this for the legacy / suite
    path, which really was judged this way, and expose it to the page as
    ``pool_reference`` so it can never be mistaken for the round's gate.
    """
    from ..orchestrator.pool import Pool

    src = str(answers.get("pool_source") or "").strip()
    if not src:
        return {}
    try:
        pool = Pool.from_yaml(Path(src).expanduser())
    except Exception:  # noqa: BLE001 - gates are advisory for the UI
        return {}
    out: Dict[str, Dict[str, Any]] = {}
    for iid in ids:
        inst = pool.instances.get(iid)
        if inst is None:
            continue
        tau = pool.tau_family(inst.family or "")
        out[iid] = {
            "baseline_us": inst.baseline_us,
            "tau_family": tau,
            "target_us": round(tau * float(inst.baseline_us), 3),
            "best_known_us": inst.best_known_us,
            "family": inst.family,
        }
    return out


#: The gate's own knobs, mirrored from ``orchestrator.decision_engine`` so the
#: page can describe the criterion the orchestrator really applies (FLOW.md §3)
#: instead of re-deriving it. One place changes both.
GATE_WIN_RATIO = {"performance": 0.75, "generalization": 0.50}
GATE_FLOOR_PERCENT = 0.80
GATE_NOISE_PERCENT = 2.0

VARIANT_TABLE_FILE = "variant_table.json"


def _round_input_dir(exp: Path, num: int) -> Path:
    return exp / "runs" / f"iteration_{num:03d}" / "input"


def _round_stage(exp: Path, num: int) -> Optional[str]:
    """The stage this round declared (``baseline`` / ``performance`` / ...).

    ``None`` means the round predates the staging (legacy / suite path, or the
    short-lived transitional build that wrote a gate document without a
    ``stage.json``).
    """
    doc = _load(_round_input_dir(exp, num) / "stage.json", None)
    name = doc.get("stage") if isinstance(doc, dict) else None
    return str(name) if name else None


def _round_gate_doc(exp: Path, num: int,
                    stage: Optional[str]) -> Optional[Dict[str, Any]]:
    """The gate document this round judged, or ``None`` when it judged none.

    The baseline round (FLOW.md §2) judges nothing, so it has no document: its
    questions still *have* an opponent — the one the round is about to measure
    and write back — which is what the page shows for it.
    """
    i_dir = _round_input_dir(exp, num)
    if stage == "generalization":
        return _load(i_dir / "generalization_gate.json", None)
    if stage == "performance":
        return _load(i_dir / "performance_gate.json", None)
    if stage is None:                    # transitional build: document, no stage
        for name in ("performance_gate.json", "generalization_gate.json"):
            doc = _load(i_dir / name, None)
            if isinstance(doc, dict):
                return doc
    return None


def _pool_source(answers: Mapping[str, Any]) -> str:
    return str(
        answers.get("question_pool") or answers.get("pool_source") or ""
    ).strip()


def _variant_sources(exp: Path, answers: Mapping[str, Any]):
    """``(variant_table, pool_instances)``, exactly as the orchestrator sees them."""
    from ..orchestrator.variant import pool_instances

    table = _load(exp / VARIANT_TABLE_FILE, None)
    table = table if isinstance(table, dict) else {}
    instances: Dict[str, Dict[str, Any]] = {}
    src = _pool_source(answers)
    if src:
        path = Path(src).expanduser()
        if path.is_file():
            try:
                instances = pool_instances(path)
            except Exception:  # noqa: BLE001 - a bad pool is "no answer", not a 500
                instances = {}
    return table, instances


def _real_gate_map(exp: Path, num: int, ids: List[str],
                   answers: Mapping[str, Any],
                   ) -> Dict[str, Any]:
    """The criterion this round actually judges, per question.

    FLOW.md §3: the performance gate compares each question against that
    operator's *current variant* — a strict win for >= 75% of the questions,
    with every question at least 80% of its variant (the floor). That is a
    different number from ``tau_family * baseline_us``, so the two are served
    separately and the page labels them by protocol:

    * ``variant`` (a ``stage.json`` exists, a gate document exists, or the run
      kept a variant table): the round is judged against the variant;
    * ``legacy``: the pre-2026-09-15 / suite path, which really did use the pool
      criterion — the page says so instead of dressing it up as a variant match.

    ``target_us`` keeps its historic name for the round table, but for a variant
    round it is the variant (``variant_us``), never a family baseline.
    """
    from ..orchestrator.variant import resolve_variant

    stage = _round_stage(exp, num)
    gate = _round_gate_doc(exp, num, stage)
    table, instances = _variant_sources(exp, answers)
    on_protocol = (stage is not None or isinstance(gate, dict)
                   or (exp / VARIANT_TABLE_FILE).is_file())
    judged = ((gate or {}).get("comparison") or {}).get("per_instance") or {}
    win_ratio = GATE_WIN_RATIO.get(
        str(stage or ""), GATE_WIN_RATIO["performance"])
    targets: Dict[str, Dict[str, Any]] = {}
    for qid in ids:
        resolved = resolve_variant(table, qid, instances=instances) or {}
        variant_us = resolved.get("median_us")
        row = judged.get(qid) or {}
        targets[qid] = {
            "protocol": "variant" if on_protocol else "legacy",
            "stage": stage,
            "variant_us": variant_us,
            "variant_source": resolved.get("source"),
            "variant_p90_us": resolved.get("p90_us"),
            "kernel_source": resolved.get("kernel_source"),
            "target_us": variant_us,
            "judged": ({
                "verdict": row.get("verdict"),
                "candidate_median_us": row.get("candidate_median_us"),
                "delta_percent": row.get("delta_percent"),
            } if row else None),
            "win_ratio": win_ratio,
            "wins_needed": None,
            "floor_percent": GATE_FLOOR_PERCENT,
            "noise_percent": GATE_NOISE_PERCENT,
        }
    round_gate: Optional[Dict[str, Any]] = None
    if isinstance(gate, dict):
        round_gate = {
            "kind": gate.get("kind") or stage,
            "status": gate.get("status"),
            "wins": gate.get("wins"),
            "wins_needed": gate.get("wins_needed"),
            "operators": gate.get("operators"),
            "counted": gate.get("counted"),
            "below_floor": gate.get("below_floor"),
            "unmeasured": gate.get("unmeasured"),
            "reasons": gate.get("reasons"),
        }
        for qid in targets:
            targets[qid]["wins_needed"] = gate.get("wins_needed")
    return {
        "protocol": "variant" if on_protocol else "legacy",
        "stage": stage,
        "round": round_gate,
        "targets": targets,
    }


def _children_live(exp: Path, num: int,
                   answers: Optional[Dict[str, Any]] = None,
                   ) -> Dict[str, Dict[str, Any]]:
    """Live per-question state from each real DKAO child task.

    Every question is one DKAO child whose orchestrator writes its own
    ``state/run.json``; expose the child's current_phase (Prepare -> ... ->
    Finished of the *inner* DKAO loop) plus its perf peek and the gate it is
    judged by so the HE detail page can show the Evaluate step drilling into
    each child.

    ``gate`` is the round's real criterion (the variant comparison). For rounds
    that predate the variant protocol it degenerates to the pool criterion, with
    ``protocol == "legacy"`` on it so the page can say which path produced the
    verdict. ``pool_reference`` always carries the pool criterion as a clearly
    named annotation — it is not a gate on the variant protocol.
    """
    base = exp / CHILDREN_DIR
    dirs = child_dir_map(base, num)          # {question: newest attempt dir}
    out: Dict[str, Dict[str, Any]] = {}
    if not dirs:
        return out
    ids = sorted(dirs)
    gates = _gate_map(answers or {}, ids)
    real = _real_gate_map(exp, num, ids, answers or {})
    for qid, d in sorted(dirs.items()):
        run = read_run(d / "state")
        perf = _child_best_median(d / "workspace")
        gate = real["targets"].get(qid)
        pool_ref = gates.get(qid)
        if (gate is not None and gate.get("protocol") == "legacy"
                and pool_ref is not None):
            # A legacy round was judged by the family criterion, so that is the
            # target its page must show — unchanged from how it was decided.
            gate = dict(gate, target_us=pool_ref.get("target_us"))
        out[qid] = {
            "current_phase": run.get("current_phase") or "idle",
            "current_iteration": run.get("current_iteration"),
            "finished": bool(run.get("finished")),
            "final_status": run.get("final_status"),
            "last_update": run.get("last_update"),
            "best_median_us": perf["best_median_us"],
            "rounds": perf["rounds"],
            "gate": gate,
            "pool_reference": pool_ref,
            "gate_protocol": real["protocol"],
            "gate_stage": real["stage"],
            "child_dir": str(d),
            "attempt_dir": d.parent.name,
            "child_state_dir": str(d / "state"),
        }
    return out


def _tail_text(path: Path, size: int = 1200) -> str:
    if not path.is_file():
        return ""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    return text[-size:]


def _dkao_child_payload(exp: Path, num: int, child: str) -> Dict[str, Any]:
    """Aggregate one HE question's inner DKAO task into a DKAO-like payload.

    Each question is a real dcu_kernel_auto_opt child that writes the same
    artifacts a WebUI DKAO task does (state/run.json + timeline + agents.json,
    workspace/workers/*). This mirrors what the DKAO detail page reads so the
    HE page can render the child with the same look: 8-step inner state
    machine + worker lanes + agents.
    """
    if not child or child in {".", ".."} or "/" in child or "\\" in child:
        raise HTTPException(404, "unknown child")
    # A question can own several attempt directories (a first run, its retries,
    # the generalization retake): the drill-down always opens the newest one.
    d = resolve_child_dir(exp / CHILDREN_DIR, num, child)
    if d is None or not d.is_dir():
        raise HTTPException(404, "child not found")

    state_dir = d / "state"
    run = read_run(state_dir)
    run_phase = run.get("current_phase") or "prepare"
    # DKAO phases machine (Prepare..Finished, 8 steps incl. Baseline).
    from metainfer.tasks.dcu_kernel_auto_opt.orchestrator import phases as dkao
    graph = dkao.graph_payload(run_phase, include_baseline=True)

    agents_raw = [
        item for item in ((_load(state_dir / "agents.json", None) or {})
                          .get("agents") or [])
        if isinstance(item, dict)
    ]

    workers: List[Dict[str, Any]] = []
    wdir = d / "workspace" / "workers"
    if wdir.is_dir():
        for w in sorted(wdir.iterdir()):
            if not w.is_dir():
                continue
            status = _load(w / "status.json", {}) or {}
            bootstrap = _load(w / "bootstrap_result.json", {}) or {}
            result = _load(w / "result.json", {}) or {}
            shape_id = status.get("shape_id")
            metrics: Dict[str, Any] = {}
            if shape_id:
                metrics = (
                    ((result.get("shapes") or {}).get(shape_id) or {})
                    .get("metrics") or {}
                )
            # Per-round optimization history (the same source DKAO lanes use).
            experiments: List[Dict[str, Any]] = []
            rounds = 0
            runs_dir = w / "runs"
            if runs_dir.is_dir():
                for exp_file in sorted(runs_dir.glob("*/experiments.jsonl")):
                    if not shape_id:
                        shape_id = exp_file.parent.name
                    for row in _jsonl(exp_file):
                        m = row.get("metrics") or {}
                        experiments.append({
                            "iteration": row.get("iteration"),
                            "median_us": m.get("median_us"),
                            "p90_us": m.get("p90_us"),
                            "accepted": bool(row.get("accepted")),
                            "correctness_passed": bool(
                                row.get("correctness_passed")
                            ),
                            "speedup": row.get("speedup"),
                            "baseline_us": row.get("baseline_us"),
                            "timestamp": row.get("timestamp"),
                        })
                rounds = len(experiments)
                experiments.sort(key=lambda e: (
                    float(e.get("timestamp") or 0),
                    int(e.get("iteration") or 0),
                ))
            accepted_medians = [
                e["median_us"] for e in experiments
                if e.get("accepted") and e.get("median_us") is not None
            ]
            workers.append({
                "worker_id": w.name,
                "state": status.get("state") or "idle",
                "iteration": status.get("iteration"),
                "shape_id": shape_id,
                "physical_gpu": status.get("physical_gpu"),
                "bootstrap_status": bootstrap.get("status"),
                "median_us": metrics.get("median_us"),
                "p90_us": metrics.get("p90_us"),
                "passed": metrics.get("passed"),
                "rounds": rounds,
                "best_median_us": (
                    min(accepted_medians) if accepted_medians else None
                ),
                "experiments": experiments,
                "last_update": status.get("last_update"),
            })

    # Agents: annotate worker turns with the matching per-round performance
    # (agent name is "worker_N-<shape>-iterK" -> experiments.jsonl iteration K)
    import re as _re
    perf_index: Dict[Any, Dict[str, Any]] = {}
    for w in workers:
        for e in w.get("experiments") or []:
            perf_index[(w["worker_id"], e.get("iteration"))] = e
    agents: List[Dict[str, Any]] = []
    for item in agents_raw:
        entry: Dict[str, Any] = {
            "name": item.get("name"),
            "role": item.get("role"),
            "status": item.get("status"),
            "phase": item.get("phase"),
            "error": item.get("error"),
        }
        match = _re.match(r"^(worker_\d+)-.+-iter(\d+)$",
                          str(item.get("name") or ""))
        if match:
            worker_id, iteration = match.group(1), int(match.group(2))
            turn = perf_index.get((worker_id, iteration))
            if turn:
                entry["iteration"] = iteration
                entry["median_us"] = turn.get("median_us")
                entry["p90_us"] = turn.get("p90_us")
                entry["speedup"] = turn.get("speedup")
                entry["baseline_us"] = turn.get("baseline_us")
                entry["accepted"] = turn.get("accepted")
        agents.append(entry)

    return {
        "child": child,
        "run": {
            "current_phase": run_phase,
            "current_iteration": run.get("current_iteration"),
            "finished": bool(run.get("finished")),
            "final_status": run.get("final_status"),
        },
        "graph": graph,
        "agents": agents,
        "workers": workers,
        "repo_path": str(d / "workspace" / "main"),
        "child_workspace_dir": str(d / "workspace"),
        "log_tail": _tail_text(d / "orchestrator-external.log"),
    }


def _resume_running(state_dir: Path) -> Optional[int]:
    """PID of a live harness_evolve run (zombies and recycled pids excluded)."""
    try:
        pid = int((Path(state_dir) / "resume.pid")
                  .read_text(encoding="utf-8").split()[0])
    except (OSError, ValueError, IndexError):
        return None
    try:
        from ..orchestrator.supervisor import task_process_alive
    except Exception:  # noqa: BLE001 - fall back to a plain existence check
        try:
            os.kill(pid, 0)
            return pid
        except OSError:
            return None
    return task_process_alive(state_dir)


def _run_alive(state_dir: Path) -> Optional[int]:
    """PID of a live orchestrator for this task, whichever path started it.

    The sweep has to distinguish "nobody is running this experiment" from "this
    experiment is running fine". ``_resume_running`` answers only the narrower
    question (is there a *resume*?), and a task created from the New Task form
    never writes ``resume.pid`` — so a one-second-old, perfectly healthy run
    looked like an unsupervised corpse, and the sweep started a second driver
    for it (which then opened the next round while round 1 was still being
    evaluated). ``task_process_alive`` reads ``orchestrator.pid`` first and
    falls back to a cmdline scan, which is exactly the question here.
    """
    try:
        from ..orchestrator.supervisor import task_process_alive
        return task_process_alive(Path(state_dir))
    except Exception:  # noqa: BLE001 - never break the sweep
        return _resume_running(state_dir)


#: Terminal states that must never be auto-restarted: the loop stopped on
#: purpose (a round could not measure every question, operator abort, circuit
#: breaker) and needs a human decision. Restarting them would silently re-enter
#: the same condition.
#:
#: ``gpu_gate_blocked`` is deliberately absent: since HE stopped managing GPU
#: occupancy it holds no device verdict of its own and never stops a run for
#: one. What it can do is stop because a *child's* DKAO gate refused to measure
#: — that arrives as ``round_incomplete`` with ``cause`` ``gpu_gate_blocked``
#: (see ``DkaoCliEvaluator._stop_on_incomplete_round``).
TERMINAL_STATUSES = {"round_incomplete",
                     "aborted_by_operator", "circuit_breaker",
                     # an explicit Stop press: only a human asking again (or
                     # the resume paths clearing it) may bring the run back
                     "stopped_by_operator",
                     # variant-round protocol: a run parks for a human decision
                     # and ends once a harness is promoted (or the budget runs
                     # out) — none of those should be silently restarted.
                     "awaiting_approval", "rounds_exhausted"}


def should_launch_resume(run: Mapping[str, Any], target: Any,
                         resume_running: bool) -> bool:
    """Whether an unattended start must (re)launch the experiment process.

    Covers three cases: nothing started yet, the previous process died
    mid-round (``finished`` is False), and the target round is not reached —
    but never a run that deliberately stopped for a terminal reason.
    """
    if resume_running or not run:
        return False
    if str(run.get("final_status") or "") in TERMINAL_STATUSES:
        return False
    if not run.get("finished"):
        return True
    if target in (None, ""):
        return False
    try:
        return int(run.get("current_iteration") or 0) < int(target)
    except (TypeError, ValueError):
        return False


def _launch_resume(state_dir: Path, workspace_dir: Path,
                   iterations: int,
                   champion_iteration: Any = None) -> Dict[str, Any]:
    """Spawn the resume CLI in the background and record its pid."""
    import subprocess
    import sys

    # Spawning the experiment again is the operator saying "continue": without
    # this, the marker left by Stop would make the supervisor and the janitor
    # refuse to supervise the run we are starting right now.
    _clear_operator_stop(Path(workspace_dir))
    meta_root = Path(__file__).resolve().parents[4]
    log_path = state_dir / "resume.log"
    log = log_path.open("a", encoding="utf-8")
    log.write(f"\n=== resume requested: +{iterations} round(s) "
              f"@ {time.strftime('%Y-%m-%d %H:%M:%S')} ===\n")
    log.flush()
    cmd = [
        sys.executable, "-m",
        "metainfer.tasks.harness_evolve.orchestrator.cli", "resume",
        "--state-dir", str(state_dir),
        "--workspace-dir", str(workspace_dir),
        "--iterations", str(iterations),
    ]
    if champion_iteration not in (None, ""):
        cmd += ["--champion-iteration", str(int(champion_iteration))]
    env = dict(os.environ)
    env.setdefault("PYTHONPATH", str(meta_root))
    proc = subprocess.Popen(
        cmd, cwd=str(meta_root), stdout=log, stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL, env=env, start_new_session=True,
    )
    log.close()
    (state_dir / "resume.pid").write_text(str(proc.pid), encoding="utf-8")
    return {"ok": True, "pid": proc.pid, "iterations": iterations,
            "log": str(log_path)}


#: Presence of this file means "the operator stopped this run on purpose".
#: It is the only thing that distinguishes a deliberate stop from a crash, and
#: every path that would helpfully restart an unsupervised run must respect it
#: (the janitor sweep, the supervisor, the resume launcher). Cleared by the
#: resume paths, i.e. when a human asks for the run to continue again.
OPERATOR_STOP_FILE = "operator_stop.json"


def _operator_stop_path(workspace_dir: Path) -> Path:
    return Path(workspace_dir) / OPERATOR_STOP_FILE


def _run_live(state_dir: Path, workspace_dir: Path) -> bool:
    """Whether this experiment is doing something right now.

    Deliberately not just ``orchestrator.pid``: children outlive their parent's
    bookkeeping (a round can be mid-flight while the parent is briefly between
    steps), and a run started before that file existed has no entry at all.
    """
    if _resume_running(Path(state_dir)):
        return True
    if _supervisor_running(Path(workspace_dir)):
        return True
    return bool(_live_dkao_children(Path(workspace_dir)))


def _operator_stopped(workspace_dir: Path) -> Optional[Dict[str, Any]]:
    """The stop record if the operator stopped this run, else None."""
    return _load(_operator_stop_path(workspace_dir), None) or None


def _clear_operator_stop(workspace_dir: Path) -> bool:
    """Drop the operator-stop marker so the run may be driven again."""
    path = _operator_stop_path(workspace_dir)
    try:
        path.unlink()
        return True
    except OSError:
        return False


def _live_dkao_children(workspace_dir: Path) -> List[Dict[str, Any]]:
    """Live DKAO child runs belonging to this HE workspace.

    Children are spawned with ``start_new_session=True``, so signalling the HE
    orchestrator does NOT reach them: they would keep their agents and their
    place in DKAO's admission queue after a "stop". They are found by their
    command line, which names this experiment's artifact directory -- the one
    thing that identifies them without a registry of our own.
    """
    marker = f"{Path(workspace_dir)}/children/".encode()
    found: List[Dict[str, Any]] = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        if pid == os.getpid():
            continue
        try:
            cmdline = (entry / "cmdline").read_bytes().replace(b"\0", b" ")
        except OSError:
            continue
        if marker not in cmdline \
                or b"dcu_kernel_auto_opt.orchestrator.cli" not in cmdline:
            continue
        found.append({"pid": pid, "cmd": cmdline.decode("utf-8", "replace")})
    return found


def _proc_state(pid: int) -> Optional[str]:
    """``/proc/<pid>`` state letter, or None when the process is gone."""
    try:
        stat = Path(f"/proc/{int(pid)}/stat").read_text(encoding="utf-8")
    except OSError:
        return None
    try:
        return stat.split(") ", 1)[1].split()[0]
    except IndexError:
        return None


def _terminate_pid(pid: int, *, grace_s: float = 20.0) -> bool:
    """SIGTERM a process group (then the process), and report whether it went.

    ``os.killpg`` first because these processes lead their own session: the
    DKAO orchestrator spawns agent processes that must not outlive it.

    A zombie counts as stopped -- it executes no more, it just has not been
    reaped yet (we are usually not its parent). ``os.kill(pid, 0)`` succeeds
    for exactly that case, which would make a successful stop report itself as
    a failure.
    """
    def _stopped() -> bool:
        state = _proc_state(pid)
        return state is None or state == "Z"

    for target in (-pid, pid):
        try:
            os.kill(target, 15)
            break
        except OSError:
            continue
    deadline = time.time() + grace_s
    while time.time() < deadline:
        if _stopped():
            return True
        time.sleep(0.2)
    for target in (-pid, pid):
        try:
            os.kill(target, 9)
            break
        except OSError:
            continue
    time.sleep(0.3)
    return _stopped()


def _supervisor_running(workspace_dir: Path) -> Optional[int]:
    """PID of a live incident supervisor for this experiment (None when idle).

    A zombie must not count: ``os.kill(pid, 0)`` succeeds for a defunct process
    whose parent has not reaped it, and that stale pid then blocks every future
    supervision of the task ("supervisor already running" for a process that
    cannot observe anything).
    """
    pid_file = Path(workspace_dir) / "supervisor.pid"
    try:
        pid = int(pid_file.read_text(encoding="utf-8").split()[0])
    except (OSError, ValueError, IndexError):
        return None
    try:
        state = Path(f"/proc/{pid}/stat").read_text().split(") ", 1)[1]
    except (OSError, IndexError, ValueError):
        return None
    if state.split()[0] == "Z":
        return None
    try:
        os.kill(pid, 0)
    except OSError:
        return None
    return pid


def _launch_supervisor(state_dir: Path, workspace_dir: Path, target: Any,
                       diagnose: bool = False) -> Dict[str, Any]:
    """Start the unattended supervisor (self-healing) for this experiment."""
    import subprocess
    import sys

    meta_root = Path(__file__).resolve().parents[4]
    log_path = Path(workspace_dir) / "supervisor.log"
    log = log_path.open("a", encoding="utf-8")
    log.write(f"\n=== supervisor requested: target={target} diagnose={diagnose} "
              f"@ {time.strftime('%Y-%m-%d %H:%M:%S')} ===\n")
    log.flush()
    cmd = [
        sys.executable, "-m",
        "metainfer.tasks.harness_evolve.orchestrator.supervisor", "watch",
        "--state-dir", str(state_dir), "--workspace-dir", str(workspace_dir),
    ]
    if target not in (None, ""):
        cmd += ["--target", str(int(target))]
    if diagnose:
        cmd += ["--diagnose-agent"]
    env = dict(os.environ)
    env.setdefault("PYTHONPATH", str(meta_root))
    proc = subprocess.Popen(
        cmd, cwd=str(meta_root), stdout=log, stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL, env=env, start_new_session=True,
    )
    log.close()
    (Path(workspace_dir) / "supervisor.pid").write_text(str(proc.pid),
                                                         encoding="utf-8")
    return {"pid": proc.pid, "log": str(log_path)}


def _supervisor_payload(workspace_dir: Path) -> Dict[str, Any]:
    workspace_dir = Path(workspace_dir)
    state: Dict[str, Any] = {}
    try:
        state = json.loads((workspace_dir / "supervisor_state.json")
                           .read_text(encoding="utf-8"))
    except (OSError, ValueError):
        state = {}
    incidents: List[Dict[str, Any]] = []
    path = workspace_dir / "incidents.jsonl"
    if path.is_file():
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines()[-40:]:
            try:
                incidents.append(json.loads(line))
            except ValueError:
                continue
    return {
        "running": _supervisor_running(workspace_dir) is not None,
        "pid": _supervisor_running(workspace_dir),
        "state": state,
        "incidents": incidents,
        "has_report": (workspace_dir / "incident_report.md").is_file(),
    }


_JANITOR_STARTED = False


def janitor_sweep() -> List[Dict[str, Any]]:
    """Last-resort recovery: restart experiments nobody is supervising.

    The supervisor normally handles crashes, but if the supervisor itself dies
    (OOM, kill, container restart) the experiment would sit idle forever — the
    exact "stuck in analyze" symptom. This sweep runs inside the server and
    re-launches supervision for any task that is unfinished and has neither a
    live experiment process nor a live supervisor.
    """
    from metainfer.server.tasks import list_tasks

    actions: List[Dict[str, Any]] = []
    for entry in list_tasks():
        if getattr(entry, "type", None) != PLUGIN_TYPE:
            continue
        try:
            state_dir = state_dir_for(entry)
            workspace_dir = workspace_dir_for(entry)
            stopped = _operator_stopped(workspace_dir)
            if stopped is not None:
                # "Last-resort recovery" must not overrule a human: this is the
                # one sweep that would otherwise restart a task minutes after
                # the operator stopped it.
                actions.append({"task": entry.id, "action": "skip",
                                "reason": "stopped by operator",
                                "stopped_at": stopped.get("stopped_at")})
                continue
            run = read_run(state_dir)
            if not run:
                continue
            target = read_target_iterations(workspace_dir)
            run_live = _run_alive(state_dir)
            supervisor_live = _supervisor_running(workspace_dir)
            if run_live:
                # Somebody *is* running this experiment — most often the process
                # the New Task form started a second ago. Starting a second
                # driver here is what made a fresh task open two rounds at once.
                actions.append({"task": entry.id, "action": "skip",
                                "reason": "run is alive", "pid": run_live})
                continue
            if supervisor_live:
                if should_launch_resume(run, target, False):
                    resume = _launch_resume(state_dir, workspace_dir, 1,
                                            champion_iteration=None)
                    actions.append({"task": entry.id, "action": "resume",
                                    "pid": resume.get("pid")})
                continue
            if not should_launch_resume(run, target, False):
                continue
            out = _launch_supervisor(state_dir, workspace_dir, target,
                                     diagnose=False)
            resume = _launch_resume(state_dir, workspace_dir, 1,
                                    champion_iteration=None)
            actions.append({"task": entry.id, "action": "supervisor+resume",
                            "supervisor_pid": out.get("pid"),
                            "resume_pid": resume.get("pid")})
        except Exception as exc:  # noqa: BLE001 - never break the sweep
            actions.append({"task": getattr(entry, "id", "?"),
                            "action": "error", "error": repr(exc)})
    return actions


def _start_janitor(interval_s: int = 300) -> None:
    global _JANITOR_STARTED
    if _JANITOR_STARTED:
        return
    _JANITOR_STARTED = True
    import threading

    def loop() -> None:
        while True:
            time.sleep(max(30, int(interval_s)))
            try:
                actions = janitor_sweep()
                for action in actions:
                    if action.get("action") != "error":
                        print(f"[he-janitor] {action}", flush=True)
            except Exception:  # noqa: BLE001
                continue

    threading.Thread(target=loop, daemon=True, name="he-janitor").start()


def build_router(plugin) -> APIRouter:
    router = APIRouter()
    if os.environ.get("METAINFER_DISABLE_JANITOR", "").strip().lower() not in {
            "1", "true", "yes"}:
        _start_janitor()

    @router.get("/summary")
    def summary(task_id: str) -> Dict[str, Any]:
        entry = task_or_404(task_id)
        require_task_type(entry, PLUGIN_TYPE)
        exp = workspace_dir_for(entry)
        state_dir = state_dir_for(entry)
        return {
            "config_snapshot": _load(exp / "config_snapshot.json", None),
            "report": _text(exp / "report.md"),
            "best_ever": _load(exp / "best_ever.json", None),
            "scores": _jsonl(exp / "iteration_scores.jsonl"),
            # Which protocol this run is on. ``protocol.json`` is written by the
            # orchestrator when it leaves the fixed one; the page puts a banner
            # on screen from it, because a run that judges neither gate looks
            # exactly like a run that is merely quiet.
            "protocol": _load(exp / "protocol.json", None)
            or {"protocol": "variant", "mode": "variant",
                "reason": "FLOW.md fixed protocol"},
            # Whether the operator pressed Stop: the page needs it to explain
            # why nothing is running, and to offer the way back.
            "operator_stop": _operator_stopped(exp),
            # Liveness as this plugin knows it. The shell's green dot reads
            # ``orchestrator.pid``, which a run started before that file existed
            # never wrote -- the process is alive and the dot is blue. The page
            # must not inherit that blind spot, or Stop would be hidden on
            # exactly the runs that need it.
            "running": _run_live(state_dir, exp),
        }

    @router.get("/iterations")
    def iterations(task_id: str) -> List[Dict[str, Any]]:
        entry = task_or_404(task_id)
        require_task_type(entry, PLUGIN_TYPE)
        return _iterations(workspace_dir_for(entry))

    @router.get("/state-graph")
    def state_graph(task_id: str) -> Dict[str, Any]:
        """Outer-loop AHE phase machine (Prepare..Finished)."""
        entry = task_or_404(task_id)
        require_task_type(entry, PLUGIN_TYPE)
        run = read_run(state_dir_for(entry))
        return phases.graph_payload(run.get("current_phase") or PREPARE)

    @router.get("/iterations/{num}/gpu")
    def iteration_gpu(task_id: str, num: int) -> Dict[str, Any]:
        """Read-only device cards for one AHE iteration.

        Replaces the old lease view: HE holds no lease and takes no reading of
        the cards, so the page shows the layout HE chose (``index % 4``) plus
        what each child's *own* DKAO gate says about the device it was handed.
        """
        entry = task_or_404(task_id)
        require_task_type(entry, PLUGIN_TYPE)
        req = read_requirements(state_dir_for(entry)) or {}
        answers = req.get("answers")
        if not isinstance(answers, dict):
            answers = req
        exp = workspace_dir_for(entry)
        return {
            "iteration": num,
            "gpu_count": GPU_COUNT,
            "managed_by": "dcu_kernel_auto_opt",
            "leases": [],
            "layout": _load(
                exp / "runs" / f"iteration_{num:03d}" / "input" / "benchmark"
                / "gpu_preflight.json", None),
            "cards": _gpu_cards(exp, num, answers),
        }

    @router.get("/iterations/{num}/children")
    def iteration_children(task_id: str, num: int) -> Dict[str, Dict[str, Any]]:
        """Live inner DKAO phase per question of one AHE iteration."""
        entry = task_or_404(task_id)
        require_task_type(entry, PLUGIN_TYPE)
        req = read_requirements(state_dir_for(entry)) or {}
        answers = req.get("answers")
        if not isinstance(answers, dict):
            answers = req
        return _children_live(workspace_dir_for(entry), num, answers)

    @router.post("/resume")
    async def resume(task_id: str, request: Request) -> Dict[str, Any]:
        """Continue the experiment with further round(s) from the current state."""
        entry = task_or_404(task_id)
        require_task_type(entry, PLUGIN_TYPE)
        state_dir = state_dir_for(entry)
        workspace_dir = workspace_dir_for(entry)
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001 - body is optional
            body = {}
        body = body or {}
        target = body.get("target")
        if target is not None:
            target = max(1, int(target))
            write_target_iterations(workspace_dir, target)

        live = _resume_running(state_dir)
        if live:
            # Already running: a new target is picked up by the next round.
            return {
                "ok": True, "running": True, "pid": live,
                "target": read_target_iterations(workspace_dir),
                "updated": target is not None,
                "message": ("target updated; the running loop picks it up "
                            "at the next round" if target is not None
                            else "already running"),
            }
        run = read_run(state_dir)
        if not run.get("finished"):
            raise HTTPException(
                409, "task is not finished yet; wait for the current round")
        iterations = max(1, int(body.get("iterations") or 1))
        champion_iteration = body.get("champion_iteration")
        out = _launch_resume(state_dir, workspace_dir, iterations,
                             champion_iteration=champion_iteration)
        out["target"] = read_target_iterations(workspace_dir)
        return out

    @router.post("/autopilot")
    async def autopilot(task_id: str, request: Request) -> Dict[str, Any]:
        """Unattended mode: run to the target round, self-healing on incidents."""
        entry = task_or_404(task_id)
        require_task_type(entry, PLUGIN_TYPE)
        state_dir = state_dir_for(entry)
        workspace_dir = workspace_dir_for(entry)
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = {}
        body = body or {}
        target = body.get("target")
        if target is not None:
            write_target_iterations(workspace_dir, max(1, int(target)))
        target = read_target_iterations(workspace_dir)
        live = _supervisor_running(workspace_dir)
        if live:
            return {"ok": True, "supervisor_pid": live, "target": target,
                    "message": "supervisor already running; target updated"}
        out = _launch_supervisor(state_dir, workspace_dir, target,
                                 diagnose=bool(body.get("diagnose_agent")))
        resume_pid = None
        run = read_run(state_dir)
        if should_launch_resume(run, target, bool(_resume_running(state_dir))):
            # Covers both "not started yet" and "the previous process died
            # mid-round": the run must never be left unsupervised.
            champion = body.get("champion_iteration")
            resume = _launch_resume(state_dir, workspace_dir, 1,
                                    champion_iteration=champion)
            resume_pid = resume.get("pid")
        return {"ok": True, "supervisor_pid": out["pid"], "target": target,
                "resume_pid": resume_pid, "log": out["log"]}

    @router.get("/review")
    def review(task_id: str) -> Dict[str, Any]:
        """Cross-round review: generations, best-known curve, regressions."""
        entry = task_or_404(task_id)
        require_task_type(entry, PLUGIN_TYPE)
        ws = workspace_dir_for(entry)
        regressions: List[Dict[str, Any]] = []
        path = ws / "regressions.jsonl"
        if path.is_file():
            for line in path.read_text(encoding="utf-8",
                                      errors="replace").splitlines()[-40:]:
                try:
                    regressions.append(json.loads(line))
                except ValueError:
                    continue
        return {
            "review": _load(ws / "round_review.json", None),
            "best_known": _load(ws / "best_known.json", {}),
            "regressions": regressions,
        }

    @router.get("/promotion")
    def promotion(task_id: str) -> Dict[str, Any]:
        """Pending harness promotion + what production currently is.

        Nothing reaches DKAO without an explicit approval, so the UI needs to
        see the candidate, its gate evidence, and the current production
        version in one place.
        """
        entry = task_or_404(task_id)
        require_task_type(entry, PLUGIN_TYPE)
        ws = workspace_dir_for(entry)
        from ..orchestrator.promotion import promoted_harness, read_pending

        pending = read_pending(ws)
        promoted = promoted_harness(ws)
        table_path = ws / "variant_table.json"
        table = _load(table_path, {}) or {}
        return {
            "pending": pending,
            "promoted": promoted,
            "variant_table": {
                "harness_version": table.get("harness_version"),
                "operators": len(table.get("operators") or {}),
                "groups": table.get("groups") or {},
                "last_promoted_at": table.get("last_promoted_at"),
            },
        }

    @router.post("/promotion/approve")
    async def promotion_approve(task_id: str, request: Request) -> Dict[str, Any]:
        """Human approval: publish the pending harness into DKAO."""
        entry = task_or_404(task_id)
        require_task_type(entry, PLUGIN_TYPE)
        workspace_dir = workspace_dir_for(entry)
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001 - body is optional
            body = {}
        by = str((body or {}).get("by") or "operator")
        result = _approve_with_config(entry, workspace_dir, by)
        return {"ok": bool(result.get("ok")), "result": result,
                "approved_by": by}

    @router.post("/promotion/deny")
    async def promotion_deny(task_id: str, request: Request) -> Dict[str, Any]:
        """Reject the pending candidate; the run keeps iterating."""
        entry = task_or_404(task_id)
        require_task_type(entry, PLUGIN_TYPE)
        workspace_dir = workspace_dir_for(entry)
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = {}
        reason = str((body or {}).get("reason") or "operator")
        result = _deny_with_config(entry, workspace_dir, reason)
        return {"ok": bool(result.get("ok")), "result": result}

    @router.get("/supervisor")
    def supervisor(task_id: str) -> Dict[str, Any]:
        entry = task_or_404(task_id)
        require_task_type(entry, PLUGIN_TYPE)
        return _supervisor_payload(workspace_dir_for(entry))

    @router.post("/supervisor/stop")
    def supervisor_stop(task_id: str) -> Dict[str, Any]:
        entry = task_or_404(task_id)
        require_task_type(entry, PLUGIN_TYPE)
        workspace_dir = workspace_dir_for(entry)
        (workspace_dir / "supervisor.stop").write_text(
            str(time.time()), encoding="utf-8")
        pid = _supervisor_running(workspace_dir)
        if pid:
            try:
                os.kill(pid, 15)
            except OSError:
                pass
        return {"ok": True, "stopped_pid": pid}

    @router.post("/stop")
    def stop(task_id: str) -> Dict[str, Any]:
        """Stop the whole run, leaving it restartable.

        Stopping is not killing: this is the operator's "pause". Everything
        that would keep the round moving is brought down -- the incident
        supervisor (so it cannot restart what we are stopping), the running
        DKAO children, and the HE orchestrator itself -- and the run is left
        explicitly *finished*, so no automatic path revives it while the
        artifacts stay intact for a later resume.

        Killing instead would be indistinguishable from a crash, which is
        exactly what ``should_launch_resume`` and the janitor sweep exist to
        recover from: they would restart the task seconds later.

        Order matters, and the order is the one below: marker (1) so no sweep
        revives the run while it is being torn down; supervisor (2), children
        (3), orchestrator (4), one more child sweep for the env-retry wave the
        orchestrator may have launched while dying (5), and only then the
        terminal state (6). A live orchestrator never reads the marker itself,
        so skipping (4) leaves a process that answers the loss of its children
        by re-launching them.
        """
        entry = task_or_404(task_id)
        require_task_type(entry, PLUGIN_TYPE)
        state_dir = state_dir_for(entry)
        workspace_dir = workspace_dir_for(entry)
        run_before = read_run(state_dir)
        iteration = run_before.get("current_iteration")

        # 1. The marker first: it is what makes this stop stick. A concurrent
        #    janitor tick must see it before it decides to relaunch anything.
        stopped_at = time.time()
        _operator_stop_path(workspace_dir).write_text(json.dumps({
            "stopped_at": stopped_at,
            "by": "webui",
            "iteration": iteration,
            "phase": run_before.get("current_phase"),
        }, indent=2), encoding="utf-8")

        # 2. The supervisor, before the orchestrator: it exists to restart a
        #    dead experiment, and would do exactly that to the one we stop.
        (workspace_dir / "supervisor.stop").write_text(
            str(stopped_at), encoding="utf-8")
        supervisor_pid = _supervisor_running(workspace_dir)
        if supervisor_pid:
            try:
                os.kill(supervisor_pid, 15)
            except OSError:
                pass

        # 3. The children, before the parent: the parent's own shutdown would
        #    otherwise leave them (and their agents) running.
        children = _live_dkao_children(workspace_dir)
        stopped_children = [c["pid"] for c in children
                            if _terminate_pid(c["pid"])]

        # 4. The orchestrator itself, now that nothing below it is mid-write.
        #    ``_run_alive`` and NOT ``_resume_running``: the latter reads only
        #    ``resume.pid``, which a task created from the New Task form never
        #    writes -- so Stop answered "stopped" while the orchestrator kept
        #    running, and immediately re-launched the children it had just lost
        #    as an env retry. ``_run_alive`` reads ``orchestrator.pid``,
        #    ``resume.pid`` and finally scans cmdlines; the janitor sweep learned
        #    this same lesson first (see its docstring).
        orchestrator_pid = _run_alive(state_dir)
        stopped_ok = not orchestrator_pid or _terminate_pid(orchestrator_pid)

        # 5. Once more for the retry wave. A question whose child vanished is an
        #    environment failure to the evaluator, which answers it with a fresh
        #    child (``env_retry_attempts``) -- and it can launch that wave in the
        #    seconds between step 3 and step 4. Miss it and the UI says "stopped"
        #    while a brand-new DKAO child optimizes on a card for hours.
        already = set(stopped_children)
        relaunched = [c["pid"] for c in _live_dkao_children(workspace_dir)
                      if c["pid"] not in already]
        stopped_children += [pid for pid in relaunched if _terminate_pid(pid)]

        # 6. Make it visible and final: a round cut short must not look like a
        #    round that finished, and ``finished`` is what tells every
        #    automatic path to keep its hands off.
        run = read_run(state_dir)
        notes = list(run.get("notes") or [])
        if "Stopped by operator." not in notes:
            notes.append("Stopped by operator.")
        run.update({
            "finished": True,
            "final_status": "stopped_by_operator",
            "last_outcome": "stopped_by_operator",
            "last_transition_label": "operator stop",
            "last_update": stopped_at,
            "notes": notes,
        })
        tmp = state_dir / ".run.json.stop.tmp"
        tmp.write_text(json.dumps(run, indent=2), encoding="utf-8")
        os.replace(tmp, state_dir / "run.json")

        # A stale resume.pid would make /resume answer "already running" about
        # a process we just killed.
        try:
            (state_dir / "resume.pid").unlink()
        except OSError:
            pass

        return {
            "ok": True,
            "stopped": stopped_ok,
            "stopped_children": stopped_children,
            "relaunched_children": relaunched,
            "stopped_supervisor_pid": supervisor_pid,
            "stopped_orchestrator_pid": orchestrator_pid,
            "iteration": iteration,
            "message": ("已停止；产物保留，点「继续运行」可从当前进度接着跑"
                        if stopped_ok else
                        "停止信号已发送，但编排进程未及时退出；可再点一次"),
        }

    @router.get("/dkao/{num}/{child}")
    def dkao_child(task_id: str, num: int, child: str) -> Dict[str, Any]:
        """DKAO-like detail of one HE question (inner 8-step machine etc.)."""
        entry = task_or_404(task_id)
        require_task_type(entry, PLUGIN_TYPE)
        return _dkao_child_payload(workspace_dir_for(entry), num, child)

    @router.get("/iterations/{num}/overview")
    def overview(task_id: str, num: int) -> str:
        entry = task_or_404(task_id)
        require_task_type(entry, PLUGIN_TYPE)
        path = (
            workspace_dir_for(entry) / "runs"
            / f"iteration_{num:03d}" / "input" / "analysis" / "overview.md"
        )
        text = _text(path)
        if text is None:
            raise HTTPException(404, "overview not found")
        return text

    return router
