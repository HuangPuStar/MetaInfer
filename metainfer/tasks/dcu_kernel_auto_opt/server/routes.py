"""Read-only task-specific Web routes."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict

from fastapi import APIRouter, HTTPException, Request, Response

from metainfer.server._helpers import (
    require_task_type,
    state_dir_for,
    task_or_404,
    workspace_dir_for,
)
from metainfer.server.state_reader import read_requirements, read_run

from ..orchestrator import phases
from ..orchestrator.config import (
    GEN_AND_OPT_MODE,
    LEGACY_SMOKE_MODE,
    SMOKE_MODE,
    load_config,
)
from ..orchestrator.guidance import add_guidance, list_guidance
from ..orchestrator.rename_kernel_repo import rename_kernel_repo
from ..orchestrator.skill_store import (
    fuse_skill,
    list_skill_library,
    mark_fuse_running,
    publish_skill,
    rollback_skill,
    sync_skill_libraries,
)
from metainfer.orchestrator import hw_profile
from ..orchestrator.variant_store import (
    add_variant,
    derive_variant_meta,
    list_variant_index,
)
from ..orchestrator.w8a8_baselines import (
    fixed_triton_graph_baseline,
    trusted_baseline_us,
)


PLUGIN_TYPE = "dcu-kernel-auto-opt"


def _load(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def _read_jsonl(path: Path) -> list[Dict[str, Any]]:
    if not path.exists():
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


def _execution_profile(state_dir: Path) -> str:
    """``production`` or ``default`` — the queue rank this task runs at."""
    requirements = read_requirements(state_dir) or {}
    answers = requirements.get("answers")
    raw = ""
    if isinstance(answers, dict):
        raw = str(answers.get("execution_profile") or "")
    raw = raw.strip().lower()
    return "production" if raw in {"production", "prod"} else "default"


# --------------------------------------------------------------------------- #
# Embedding a harness_evolve child (AHE iteration -> DKAO view)
# --------------------------------------------------------------------------- #
# Every harness_evolve question is a real DKAO run, but it is spawned straight
# from the orchestrator CLI and is therefore NOT in the WebUI task registry --
# so ``task_or_404`` cannot find it and the DKAO page could not render it. The
# AHE page passes the child's artifact directory instead. Only genuine AHE
# children are accepted, and they are exposed read-only: the roster of a round
# belongs to the HE orchestrator, not to whoever happens to be looking at it.
AHE_CHILD_PREFIX = "ahe-child:"


def _ahe_child_entry(state_dir_raw: str):
    """Build a read-only entry for a harness_evolve child's artifact dir.

    Raises 404 unless ``state_dir`` is the ``state/`` of a question inside a
    *registered* harness_evolve task's ``children/<attempt>/<question>/`` tree.
    The registry is what makes the caller trustworthy: without it any path on
    the box could be read through these routes.
    """
    from metainfer.server import tasks as _tasks

    state_dir = Path(state_dir_raw)
    parts = state_dir.parts
    # .../children/<attempt dir>/<question>/state
    # parts[-1] = "state", parts[-2] = <question>, parts[-3] = <attempt dir>
    #
    # The attempt directory is not always a bare ``iteration_NNN``: HE gives a
    # retry ``_a<N>`` and the generalization retake ``_generalization``, and
    # those runs are just as viewable as the first pass -- a stricter pattern
    # here 404'd every request the mirror made for the retake's round, so the
    # drill-down showed nothing but errors. HE owns the naming rule, so ask it
    # rather than keeping a second copy of the pattern that can drift.
    from metainfer.tasks.harness_evolve.orchestrator.rounds import (
        iteration_of_dir_name,
    )

    if state_dir.name != "state" or len(parts) < 3 \
            or not iteration_of_dir_name(parts[-3]):
        raise HTTPException(404, f"not an AHE child directory: {state_dir}")
    question_dir = state_dir.parent
    iteration_dir = question_dir.parent
    children_dir = iteration_dir.parent
    if children_dir.name != "children":
        raise HTTPException(404, f"not an AHE child directory: {state_dir}")
    workspace_dir = children_dir.parent
    owner = next(
        (e for e in _tasks.list_tasks()
         if e.type == "harness-evolve"
         and Path(e.workspace_dir or "") == workspace_dir),
        None,
    )
    if owner is None:
        raise HTTPException(
            404, f"no harness-evolve task owns {workspace_dir}")
    return _tasks.TaskEntry(
        id=f"{AHE_CHILD_PREFIX}{state_dir}",
        type=PLUGIN_TYPE,
        label=f"{owner.label or owner.id} · {question_dir.name}",
        state_dir=str(state_dir),
        workspace_dir=str(question_dir / "workspace"),
        created_at=owner.created_at,
        launcher=owner.launcher,
    )


def _entry_for(request: Request, task_id: str):
    """``task_or_404``, plus the embed path used by the AHE page."""
    state_dir_raw = str(request.query_params.get("state_dir") or "").strip()
    if state_dir_raw:
        return _ahe_child_entry(state_dir_raw)
    return task_or_404(task_id)


def _is_mirrored_child(entry) -> bool:
    """True for the read-only AHE-child view (see ``_ahe_child_entry``)."""
    return str(getattr(entry, "id", "")).startswith(AHE_CHILD_PREFIX)


def _require_writable(entry) -> None:
    """Refuse writes through the embedded mirror.

    An AHE round's workers are steered by the HE orchestrator that spawned
    them; letting the drill-down mutate them would let a read-only view change
    a run's roster mid-round. The UI hides these controls too -- this is the
    half that a hand-made request cannot bypass.
    """
    if _is_mirrored_child(entry):
        raise HTTPException(
            403, "this DKAO run is embedded read-only from a harness_evolve "
                 "iteration; steer it from its own task page")


def _skill_profile_blocked_reason(entry) -> str:
    """Why this task's skills may not be fused/published here, or ``""``.

    Fusion and publishing write into the skill library of **this machine's**
    profile (``~/.dsh/skills``, mirrored to Claude), while the pending skill's
    numbers were measured on the task's own board.  Filing one board's findings
    under the other's edition is exactly the mix-up the profile split exists to
    prevent -- air boards have no HBM address hashing, so the same code measures
    1.06-1.70x apart per operator -- so the two boards must be the same.  A task
    with no record is refused for the same reason a variant promotion is: there
    is no way to tell whose numbers these are.

    One rule, two callers: the write guard below (409) and ``GET /skills``,
    which reports it so the page hides the buttons instead of letting them fail.
    Deliberately non-raising: an unresolvable machine blocks the write rather
    than crashing the *read* that explains why.
    """
    detected = hw_profile.profile_id() or ""
    from metainfer.server.tools.backfill_task_hw_profile import recorded_profile

    task_profile, _source = recorded_profile(state_dir_for(entry))
    if not detected:
        return (
            "cannot establish this machine's hardware profile, so its skill "
            "library has no board to file findings under; resolve the profile "
            "before publishing or fusing skills"
        )
    if not task_profile:
        return (
            f"this task has no recorded hardware profile, so its skill cannot "
            f"be filed under {detected!r}: classify it first with "
            "`python3 -m metainfer.server.tools.backfill_task_hw_profile --apply`"
        )
    if task_profile != detected:
        return (
            f"refusing to write a {task_profile!r} task's skill into the "
            f"{detected!r} skill library: its findings were measured on "
            f"{task_profile!r} and would be read as {detected!r} knowledge "
            f"(1.06-1.70x apart, per operator). Do it on the {task_profile!r} "
            "machine instead."
        )
    return ""


def _require_task_board_matches_library(entry) -> None:
    """Refuse to file a task's skill under another board's edition.

    The visible half is ``SkillLibrary``'s hidden buttons; this is the half a
    hand-made request cannot bypass (same shape as ``add_variant_route``'s 409).
    """
    reason = _skill_profile_blocked_reason(entry)
    if reason:
        raise HTTPException(status_code=409, detail=reason)


def _latest_gpu_lease(state_dir: Path) -> Dict[str, Any]:
    """The last ``gpu_leases_acquired`` row, or ``{}`` when nothing is leased."""
    latest: Dict[str, Any] = {}
    for row in _read_jsonl(state_dir / "timeline.jsonl"):
        if row.get("type") == "gpu_leases_acquired":
            payload = row.get("payload")
            if isinstance(payload, dict):
                latest = payload
    return latest


def _gate_status(state_dir: Path, limit: int = 200) -> Dict[str, Any]:
    """Compact view of the admission-gate audit trail.

    Answers "why is nothing happening": a task waiting for VRAM<=90%/HCU==0 on
    every candidate device leaves the blocked checks and their reasons here.
    """
    rows = _read_jsonl(state_dir / "measurement_gate.jsonl")[-limit:]
    blocked = [r for r in rows if r.get("event") == "gate_blocked"]
    last = rows[-1] if rows else {}
    return {
        "checks": len(rows),
        "blocked": len(blocked),
        "last_event": last.get("event"),
        "last_ts": last.get("ts"),
        "last_site": last.get("site"),
        "last_gpu": last.get("gpu"),
        "last_reasons": list(last.get("reasons") or []),
    }


def _running_pid(path: Path) -> int | None:
    record = _load(path, {}) or {}
    try:
        pid = int(record.get("pid") or 0)
    except (TypeError, ValueError):
        return None
    if pid <= 0:
        return None
    try:
        os.kill(pid, 0)
    except (OSError, ProcessLookupError):
        return None
    return pid


def _restart_worker_commands(
    requirements: Path,
    state_dir: Path,
    workspace_dir: Path,
    worker_id: str,
) -> tuple[list[str], list[str]]:
    """Build the restart + integration commands for one failed worker lane.

    Neither command passes an explicit ``--claude-bin``: the lane binaries
    resolve the agent binary from the task's ``agent_framework`` themselves
    (ccb -> METAINFER_CLAUDE_BIN / ``ccb``, dsh -> ``bridge/dsh/dsh_agent.py``),
    matching how the original run launched its agents.
    """
    common = [
        "--state-dir", str(state_dir),
        "--workspace-dir", str(workspace_dir),
        "--worker-id", worker_id,
    ]
    command = [
        sys.executable,
        "-m",
        "metainfer.tasks.dcu_kernel_auto_opt.orchestrator.restart_worker",
        str(requirements),
        *common,
    ]
    integration_command = [
        sys.executable,
        "-m",
        (
            "metainfer.tasks.dcu_kernel_auto_opt.orchestrator."
            "integrate_restarted_worker"
        ),
        str(requirements),
        *common,
    ]
    return command, integration_command


def _read_bootstrap_attempts(
    worker_root: Path,
    state_dir: Path | None,
    worker_id: str,
    assigned_shapes: list[str],
) -> list[Dict[str, Any]]:
    if state_dir is None:
        return []
    snapshot = _load(state_dir / "agents.json", {}) or {}
    agents = snapshot.get("agents") or []
    snapshot_ts = float(snapshot.get("ts") or 0)
    snapshot_stale = snapshot_ts > 0 and time.time() - snapshot_ts > 30
    pattern = re.compile(
        rf"^{re.escape(worker_id)}-bootstrap-attempt(\d+)$"
    )
    matched: list[tuple[int, Dict[str, Any]]] = []
    for agent in agents:
        if not isinstance(agent, dict):
            continue
        match = pattern.match(str(agent.get("name") or ""))
        if match:
            matched.append((int(match.group(1)), agent))
    bootstrap_progress = _load(
        worker_root / "bootstrap_progress.json", {}
    ) or {}
    progress_attempt = int(bootstrap_progress.get("attempt") or 0)
    if not matched and progress_attempt:
        progress_status = str(
            bootstrap_progress.get("status") or "pending"
        )
        matched.append((progress_attempt, {
            "name": f"{worker_id}-bootstrap-attempt{progress_attempt}",
            "status": (
                "running"
                if progress_status in {"agent_running", "validating"}
                else progress_status
            ),
            "success": (
                True if progress_status == "passed"
                else False if progress_status == "failed"
                else None
            ),
        }))
    matched.sort(key=lambda item: item[0])
    if not matched:
        return []

    successful_workers = {
        str(event.get("payload", {}).get("worker_id"))
        for event in _read_jsonl(state_dir / "timeline.jsonl")
        if event.get("type") == "worker_bootstrap_success"
    }
    source = worker_root / "source"
    generated_files = [
        relative
        for relative in (
            "w8a8_backend.py",
            "setup.py",
            "csrc/bindings.cpp",
            "csrc/w8a8_gemm_hip.hip",
        )
        if (source / relative).is_file()
    ]
    proposal = _load(source / "proposal.json", {}) or {}
    bootstrap_result = _load(worker_root / "bootstrap_result.json", {}) or {}
    latest_attempt = matched[-1][0]
    attempts = []
    for attempt, agent in matched:
        raw_status = str(
            agent.get("status") or agent.get("phase") or "pending"
        )
        success = agent.get("success")
        error = agent.get("error")
        persisted_success = (
            int(bootstrap_result.get("attempt") or 0) == attempt
            and bool(bootstrap_result.get("passed"))
        )
        progress_matches = progress_attempt == attempt
        iteration_record = _load(
            worker_root / "iterations" / "bootstrap"
            / f"iteration{attempt}" / "iteration.json",
            {},
        ) or {}
        attempt_record = (
            iteration_record
            if iteration_record else
            bootstrap_progress
            if progress_matches else {}
        )
        progress_status = str(attempt_record.get("status") or "")
        if persisted_success:
            status = "passed"
        elif progress_status == "failed":
            status = "failed"
            error = attempt_record.get("error") or error
        elif progress_status == "passed":
            status = "passed"
        elif progress_status == "validating":
            status = "validating"
        elif progress_status == "agent_running" and raw_status == "running":
            status = "running"
        elif (
            raw_status == "running"
            and snapshot_stale
        ):
            status = "orphaned"
            error = error or (
                "The orchestrator stopped updating this agent; its last "
                "recorded process state is stale."
            )
        elif agent.get("killed") or raw_status == "failed" or success is False:
            status = "failed"
        elif (
            attempt == latest_attempt
            and worker_id in successful_workers
        ):
            status = "passed"
        elif raw_status == "running":
            status = "running"
        elif attempt < latest_attempt:
            status = "retrying"
            if not error:
                error = (
                    "Agent finished, but trusted validation requested "
                    "another bootstrap attempt."
                )
        elif success is True:
            status = "validating"
        else:
            status = raw_status
        hypothesis = (
            bootstrap_result.get("hypothesis")
            if persisted_success else proposal.get("hypothesis")
            if attempt == latest_attempt and isinstance(proposal, dict)
            else None
        )
        if (
            not persisted_success
            and attempt_record.get("hypothesis")
        ):
            hypothesis = attempt_record["hypothesis"]
        attempt_metrics = (
            bootstrap_result.get("metrics") or {}
            if persisted_success else
            attempt_record.get("metrics") or {}
        )
        attempts.append({
            "kind": "bootstrap",
            "attempt": attempt,
            "status": status,
            "hypothesis": hypothesis or (
                "Create and validate the initial HIP implementation for "
                f"{', '.join(assigned_shapes) or 'assigned shapes'}."
            ),
            "generated_files": generated_files,
            "metrics": attempt_metrics,
            "artifact_dir": attempt_record.get("artifact_dir"),
            "candidate_files": attempt_record.get("candidate_files") or [],
            "error": error,
            "elapsed_s": agent.get("elapsed_s"),
            "last_output_age_s": agent.get("last_output_age_s"),
            "started_at": agent.get("started_at"),
        })
    return attempts


def localize_experiment_baseline(
    experiment: Dict[str, Any],
    shape_id: str,
    shape_params: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Show a round's speedup against **this board's** baseline.

    A round records ``speedup = baseline_us / median_us`` as it ran.  For a task
    that predates the hardware-profile split that ``baseline_us`` is the
    hardcoded reference board's number (``user_supplied_fixed_table``), so the
    page would show e.g. ``shared_down_proj 1.967x`` next to a variant that
    correctly says ``超基线 2.55x`` -- two ratios for one kernel, one of them
    cross-board.  This rewrites the *displayed* numbers when the recorded
    baseline is not provably this board's, and keeps the original under
    ``recorded_*`` so nothing is hidden (the historical decision is untouched:
    report and iteration files are never modified).
    """
    recorded = experiment.get("baseline_us")
    if recorded is None:
        return experiment
    if trusted_baseline_us(recorded) is not None:
        return experiment                     # provably this board's: as recorded
    if not shape_params:
        return experiment
    try:
        record = fixed_triton_graph_baseline(shape_id, dict(shape_params))
    except ValueError:
        return experiment
    local = trusted_baseline_us(record)
    median = experiment.get("median_us")
    if median is None:
        median = (experiment.get("metrics") or {}).get("median_us")
    if local is None or median in (None, 0):
        return experiment
    out = dict(experiment)
    out["baseline_us"] = local
    out["speedup"] = float(local) / float(median)
    out["recorded_baseline_us"] = recorded
    out["recorded_speedup"] = experiment.get("speedup")
    out["baseline_profile"] = record.get("baseline_profile")
    out["baseline_note"] = (
        f"speedup recomputed against this board's baseline ({local} us); the run "
        f"itself used {recorded} us from another hardware profile"
    )
    return out


def read_worker_lanes(
    workspace_dir: Path, state_dir: Path | None = None
) -> Dict[str, Any]:
    """Return exactly four worker lanes with their full iteration history."""
    plan = _load(workspace_dir / "plan.json", {}) or {}
    shape_params_by_id = {
        str(item.get("id")): {
            key: item[key] for key in ("M", "N", "K", "tp_size") if key in item
        }
        for item in (plan.get("shapes") or [])
        if isinstance(item, dict) and item.get("id")
    }
    max_iterations = int(plan.get("max_iterations") or 0)
    assignment_by_worker = {
        str(item.get("worker_id")): item
        for item in (plan.get("assignments") or [])
        if isinstance(item, dict) and item.get("worker_id")
    }
    agent_by_worker: Dict[str, Dict[str, Any]] = {}
    if state_dir is not None:
        snapshot = _load(state_dir / "agents.json", {}) or {}
        for agent in snapshot.get("agents") or []:
            if not isinstance(agent, dict):
                continue
            name = str(agent.get("name") or "")
            match = re.match(
                r"^(worker_\d+)-(?:.+-iter\d+|skill|bootstrap-attempt\d+)$",
                name,
            )
            if not match:
                continue
            worker_id = match.group(1)
            current = agent_by_worker.get(worker_id)
            if (
                current is None
                or float(agent.get("started_at") or 0)
                >= float(current.get("started_at") or 0)
            ):
                agent_by_worker[worker_id] = agent
    # Lanes are the task's own workers, in plan order. They used to be the fixed
    # `worker_0..3`, which is wrong on an eight-card machine where manual mode
    # names each worker after the card it runs on (`worker_6`).  The detail view
    # still always shows four rows, so a shorter plan is padded with the
    # historical lane names that are not already taken -- which reproduces the
    # old listing exactly for a plan that stays on cards 0..3.
    worker_ids = list(assignment_by_worker)
    for index in range(4):
        if len(worker_ids) >= 4:
            break
        candidate = f"worker_{index}"
        if candidate not in worker_ids:
            worker_ids.append(candidate)
    lanes = []
    for worker_id in worker_ids:
        worker_root = workspace_dir / "workers" / worker_id
        assignment = assignment_by_worker.get(worker_id, {})
        assigned_shapes = assignment.get("shapes") or []
        status = _load(worker_root / "status.json", {}) or {}
        bootstrap_attempts = _read_bootstrap_attempts(
            worker_root, state_dir, worker_id, assigned_shapes
        )
        experiments = []
        runs_root = worker_root / "runs"
        if runs_root.exists():
            for path in sorted(runs_root.glob("*/experiments.jsonl")):
                experiments.extend(_read_jsonl(path))
        # Display each round's speedup against THIS board's baseline (see
        # ``localize_experiment_baseline``): the recorded ratio of a pre-split
        # task is computed from another profile's number and must not be shown
        # next to a variant that uses this board's.
        experiments = [
            localize_experiment_baseline(
                item,
                str(item.get("shape_id") or ""),
                shape_params_by_id.get(str(item.get("shape_id") or "")),
            )
            for item in experiments
        ]
        experiments.sort(
            key=lambda item: (
                float(item.get("timestamp") or 0),
                int(item.get("iteration") or 0),
            )
        )
        lane_state = status.get("state")
        if not lane_state and bootstrap_attempts:
            lane_state = f"bootstrap_{bootstrap_attempts[-1]['status']}"
        current_agent = agent_by_worker.get(worker_id, {})
        agent_status = str(current_agent.get("status") or "")
        last_output_age = current_agent.get("last_output_age_s")
        if lane_state == "building":
            step = "Building trusted baseline"
        elif lane_state == "baseline":
            step = "Benchmarking trusted baseline"
        elif str(lane_state).startswith("bootstrap_"):
            bootstrap_state = str(lane_state).removeprefix("bootstrap_")
            step = {
                "running": "Bootstrap Agent generating initial kernel",
                "agent_running": "Child Agent generating initial HIP kernel",
                "validating": "Validating initial kernel",
                "retrying": "Retrying initial kernel generation",
                "passed": "Initial kernel validated",
                "failed": "Initial kernel unavailable; lane will be skipped",
                "orphaned": "Bootstrap Agent stopped responding",
            }.get(bootstrap_state, "Preparing initial kernel")
        elif lane_state == "agent_running":
            step = "Agent planning and editing kernel"
        elif lane_state == "profiling_current_best":
            step = "Profiling current best kernel with PMC"
        elif lane_state == "repairing_candidate":
            repair = int(status.get("repair") or 0)
            max_repairs = int(status.get("max_repairs") or 4)
            step = (
                "Repairing compile/correctness failure "
                f"({repair}/{max_repairs})"
            )
        elif lane_state == "validating_candidate":
            step = "Compiling and validating candidate"
        elif lane_state == "recording_result":
            step = "Recording round result"
        elif lane_state == "optimization_complete":
            step = "Optimization rounds complete"
        elif lane_state == "skill_writing":
            step = "Writing worker optimization skill"
        elif lane_state == "completed":
            step = "Worker skill ready"
        elif lane_state in {"failed", "timed_out", "skipped"}:
            step = "Lane unavailable; main Agent will skip it"
        elif not assignment:
            step = "No shapes assigned"
        else:
            step = "Waiting to start"
        if agent_status in {"failed", "orphaned"} and lane_state == "agent_running":
            step = "Agent failed; waiting for lane fallback"
        completed_rounds = len(experiments)
        target_rounds = max_iterations * max(1, len(assigned_shapes))
        current_iteration = int(status.get("iteration") or 0)
        current_shape = status.get("shape_id")
        active_states = {
            "profiling_current_best",
            "agent_running",
            "validating_candidate",
            "repairing_candidate",
            "recording_result",
        }
        already_recorded = any(
            int(item.get("iteration") or 0) == current_iteration
            and item.get("shape_id") == current_shape
            for item in experiments
        )
        active_iteration = None
        if (
            current_iteration > 0
            and lane_state in active_states
            and not already_recorded
        ):
            active_iteration = {
                "iteration": current_iteration,
                "shape_id": current_shape,
                "state": lane_state,
                "step": step,
                "agent_name": current_agent.get("name"),
                "agent_status": current_agent.get("status"),
                "elapsed_s": current_agent.get("elapsed_s"),
                "last_output_age_s": last_output_age,
            }
            if lane_state == "repairing_candidate":
                active_iteration["repair"] = int(
                    status.get("repair") or 0
                )
                active_iteration["max_repairs"] = int(
                    status.get("max_repairs") or 4
                )
        # A lane without an assignment shows the card its name claims, which is
        # how the fixed 0..3 rows used to be labelled.
        digits = re.fullmatch(r"worker_(\d+)", worker_id)
        fallback_gpu = int(digits.group(1)) if digits else None
        lanes.append({
            "worker_id": worker_id,
            "gpu": assignment.get("gpu", fallback_gpu),
            "assigned": bool(assignment),
            "assigned_shapes": assigned_shapes,
            "state": lane_state or (
                "not_assigned" if not assignment else "pending"
            ),
            "current_iteration": current_iteration,
            "current_shape": current_shape,
            "step": step,
            "completed_rounds": completed_rounds,
            "target_rounds": target_rounds,
            "agent": {
                "name": current_agent.get("name"),
                "status": current_agent.get("status"),
                "elapsed_s": current_agent.get("elapsed_s"),
                "last_output_age_s": last_output_age,
                "error": current_agent.get("error"),
            } if current_agent else None,
            "long_running": (
                isinstance(last_output_age, (int, float))
                and last_output_age >= 180
                and agent_status == "running"
            ),
            "bootstrap_attempts": bootstrap_attempts,
            "experiments": experiments,
            "active_iteration": active_iteration,
            "latest": experiments[-1] if experiments else None,
            "guidance": (
                list_guidance(state_dir / "guidance", worker_id)
                if state_dir is not None else []
            ),
        })
    return {"workers": lanes}


def _stat_token(path: Path) -> str:
    try:
        st = path.stat()
    except OSError:
        return "-"
    return f"{int(st.st_mtime)}:{st.st_size}"


def _state_signature(state_dir: Path, workspace_dir: Path) -> str:
    """Tiny fingerprint of everything the detail view renders.

    The detail page polls while a run is alive.  Fetching its two heavy
    payloads (``/summary`` ~0.6 MB, ``/iterations`` ~5.7 MB on a finished
    multi-worker task) every 3 s was the single biggest cost of keeping a task
    open: ~6 MB per poll, re-parsed and re-compared in the browser.  This
    signature costs a few dozen ``stat`` calls, so the client can skip both
    unless something actually moved.

    **Completeness is a correctness requirement, not an optimisation.**  The
    signature answers "may I reuse what I already have?", so every file the two
    payloads are derived from has to be in here.  It used to cover only
    ``iteration.json`` / ``status.json`` / ``best.json``, which was blind to the
    two feed files the lanes are really built from:

      * ``workers/*/runs/*/experiments.jsonl`` -- the rounds themselves.  A
        worker that uses the ``runs/`` layout (which is what a real run writes;
        ``iterations/`` is the older layout) had *no* covered input, so the
        gate reported "unchanged" while rounds were being appended and the page
        froze on a stale round list.
      * ``state_dir/timeline.jsonl`` -- appended for the whole run, and it is
        where ``/summary``'s ``gpu_leases`` comes from.

    ``_read_jsonl``-backed feeds are tracked by (mtime, size); a truncated or
    rewritten file changes size, an appended one changes both.
    """
    tokens = [
        _stat_token(state_dir / "run.json"),
        _stat_token(state_dir / "requirements.json"),
        _stat_token(state_dir / "timeline.jsonl"),
        _stat_token(state_dir / "measurement_gate.jsonl"),
        _stat_token(state_dir / "agents.json"),
        _stat_token(workspace_dir / "final_report.json"),
        _stat_token(workspace_dir / "plan.json"),
    ]
    workers = workspace_dir / "workers"
    if workers.is_dir():
        # Every glob below is sorted: the digest must depend on file state
        # only, never on directory-iteration order (see
        # test_signature_is_stable_and_content_addressed).
        for pattern in (
            "*/status.json",
            "*/bootstrap_progress.json",
            "*/bootstrap_result.json",
            "*/result.json",
            "*/best.json",
            "*/iterations/*/iteration.json",
            "*/runs/*/experiments.jsonl",
        ):
            for path in sorted(workers.glob(pattern)):
                tokens.append(_stat_token(path))
    digest = hashlib.sha1("|".join(tokens).encode("utf-8")).hexdigest()
    return digest[:20]


# --------------------------------------------------------------------------- #
# Memoised heavy payloads
# --------------------------------------------------------------------------- #
# ``/summary`` and ``/iterations`` are pure functions of (state_dir,
# workspace_dir, view), and the signature above is a complete, cheap
# fingerprint of exactly those inputs.  So the signature doubles as the cache
# key *and* the validator: a poll whose signature has not moved is answered
# without rebuilding the body at all.
#
# That ordering is the whole point.  The old arrangement built the payload
# first and hashed it afterwards, which meant an unchanged poll still paid the
# full rebuild -- measured on a 5.6 MB lane payload: 43-58 ms reading the
# per-round files, 31-35 ms of ``json.dumps``, 3.8 ms of sha1.  Content-hashing
# could only ever save the transfer, never that CPU, and it silently gave up
# once a body passed the middleware's size cap (a 20 MB task therefore re-sent
# 20 MB on every single poll).

_PAYLOAD_CACHE: Dict[Any, bytes] = {}
_PAYLOAD_CACHE_BYTES = 0
_PAYLOAD_CACHE_MAX_ENTRIES = 6
_PAYLOAD_CACHE_MAX_BYTES = 64 * 1024 * 1024


def _cached_payload(key: Any, build) -> bytes:
    """Serialise one heavy payload once per signature.

    Bounded by entry count *and* total bytes, evicting oldest-first: these
    payloads are megabytes, so an unbounded cache would accumulate every task
    ever opened in the WebUI's lifetime.
    """
    global _PAYLOAD_CACHE_BYTES
    hit = _PAYLOAD_CACHE.get(key)
    if hit is not None:
        return hit
    payload = build()
    _PAYLOAD_CACHE[key] = payload
    _PAYLOAD_CACHE_BYTES += len(payload)
    while _PAYLOAD_CACHE and (
        len(_PAYLOAD_CACHE) > _PAYLOAD_CACHE_MAX_ENTRIES
        or _PAYLOAD_CACHE_BYTES > _PAYLOAD_CACHE_MAX_BYTES
    ):
        oldest = next(iter(_PAYLOAD_CACHE))
        _PAYLOAD_CACHE_BYTES -= len(_PAYLOAD_CACHE.pop(oldest))
    return payload


def _json_safe(value: Any) -> Any:
    """Replace non-finite floats with ``None``, recursively.

    These routes used to return a plain dict and let FastAPI serialise it.
    Because they were annotated ``-> Dict[str, Any]``, FastAPI inferred a
    response model and ran the payload through Pydantic, which encodes ``inf``
    and ``nan`` as JSON ``null``.  Now that the handlers return a ``Response``
    (so the ETag can be decided *before* the body is built) that step is gone,
    and it has to be reproduced by hand -- exactly:

      * real round files do contain non-finite floats: ``experiments.jsonl`` is
        written by ``json.dumps`` with its default ``allow_nan=True``, and one
        workspace here holds ``"Infinity"`` for a candidate that never measured;
      * emitting a bare ``Infinity`` (i.e. ``allow_nan=True``) would produce a
        body the browser's ``JSON.parse`` rejects outright, breaking the page;
      * and ``allow_nan=False`` alone raises, i.e. a 500 on a real task.

    Only floats are touched, so the common case returns the original container
    rather than a copy.
    """
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    return value


def _json_bytes(payload: Any) -> bytes:
    """The bytes FastAPI's (Pydantic-backed) JSONResponse would have produced."""
    return json.dumps(
        _json_safe(payload),
        ensure_ascii=False, allow_nan=False, separators=(",", ":"),
    ).encode("utf-8")


def _revalidated(
    request: Request, etag: str, build
) -> Response:
    """Answer 304 from the fingerprint, or build the body and tag it.

    ``build`` is only called when the client does not already hold these bytes,
    so the expensive path is reachable exactly once per state change.
    """
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag})
    return Response(
        content=build(), media_type="application/json", headers={"ETag": etag}
    )


# Fields the lane payload carries for the *agent* pipeline, but that no browser
# code reads.  Verified across every plugin's ``static/`` tree: ``candidate_isa``
# (the dominant one at ~35 KiB per round), ``inline_asm_source``,
# ``profile_evidence`` and ``isa_optimization`` have zero references in the
# frontend, which is why ``?view=lanes`` drops them.  The orchestrator reads all
# four straight from the round files on disk, so its path is untouched.
#
# This is a denylist on purpose: anything not named here survives, so a field
# this list has not caught up with is preserved rather than silently dropped.
_LANE_HEAVY_EXPERIMENT_FIELDS = frozenset({
    "candidate_isa",
    "inline_asm_source",
    "profile_evidence",
    "isa_optimization",
})


def _trim_lane_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    """The list view's cut of ``/iterations``: same lanes, minus dead weight.

    Measured on this machine: 19.67 MiB -> 5.95 MiB (-70%) for the heaviest
    task, 5.59 MiB -> 2.17 MiB (-61%) for a typical finished one.
    """
    workers = []
    for lane in payload.get("workers") or []:
        if not isinstance(lane, dict):
            workers.append(lane)
            continue
        trimmed = {k: v for k, v in lane.items() if k != "latest"}
        trimmed["experiments"] = [
            {k: v for k, v in experiment.items()
             if k not in _LANE_HEAVY_EXPERIMENT_FIELDS}
            if isinstance(experiment, dict) else experiment
            for experiment in (lane.get("experiments") or [])
        ]
        workers.append(trimmed)
    return {"workers": workers}


def _build_summary(workspace_dir: Path, state_dir: Path) -> bytes:
    """Everything ``/summary`` derives from disk, as response bytes."""
    workers = []
    workers_root = workspace_dir / "workers"
    if workers_root.exists():
        for status_path in sorted(workers_root.glob("*/status.json")):
            workers.append(_load(status_path, {}))
    return _json_bytes({
        "run": read_run(state_dir),
        "plan": _load(workspace_dir / "plan.json", None),
        "workers": workers,
        "report": _load(workspace_dir / "final_report.json", None),
        # production mode: which queue rank this task took and which devices it
        # holds, so the operator can tell a real run from a harness round
        "execution_profile": _execution_profile(state_dir),
        "gpu_leases": _latest_gpu_lease(state_dir),
        "gate": _gate_status(state_dir),
    })


def _build_iterations(
    workspace_dir: Path, state_dir: Path, lanes_view: str
) -> bytes:
    """Everything ``/iterations`` derives from disk, as response bytes."""
    lanes = read_worker_lanes(workspace_dir, state_dir)
    if lanes_view == "lanes":
        lanes = _trim_lane_payload(lanes)
    return _json_bytes(lanes)


def build_router(plugin) -> APIRouter:
    router = APIRouter()

    @router.get("/state-signature")
    def state_signature(task_id: str, request: Request) -> Dict[str, Any]:
        """Cheap change detector for the detail view (see _state_signature)."""
        entry = _entry_for(request, task_id)
        require_task_type(entry, PLUGIN_TYPE)
        return {
            "signature": _state_signature(
                state_dir_for(entry), workspace_dir_for(entry)
            )
        }

    @router.get("/summary")
    def summary(task_id: str, request: Request) -> Response:
        entry = _entry_for(request, task_id)
        require_task_type(entry, PLUGIN_TYPE)
        state_dir = state_dir_for(entry)
        workspace_dir = workspace_dir_for(entry)
        signature = _state_signature(state_dir, workspace_dir)
        etag = '"%s-summary"' % signature

        def build() -> bytes:
            return _cached_payload(
                ("summary", str(workspace_dir), str(state_dir), signature),
                lambda: _build_summary(workspace_dir, state_dir),
            )

        return _revalidated(request, etag, build)

    @router.get("/iterations")
    def iterations(task_id: str, request: Request, view: str = "full") -> Response:
        entry = _entry_for(request, task_id)
        require_task_type(entry, PLUGIN_TYPE)
        state_dir = state_dir_for(entry)
        workspace_dir = workspace_dir_for(entry)
        # Only two cuts exist; anything else falls back to the full body, so a
        # stray query string can never invent a third cache entry.
        lanes_view = "lanes" if view == "lanes" else "full"
        signature = _state_signature(state_dir, workspace_dir)
        # The view is part of the tag: two cuts of one state must not collide.
        etag = '"%s-%s"' % (signature, lanes_view)

        def build() -> bytes:
            return _cached_payload(
                ("iterations", str(workspace_dir), str(state_dir),
                 signature, lanes_view),
                lambda: _build_iterations(workspace_dir, state_dir, lanes_view),
            )

        return _revalidated(request, etag, build)

    @router.post("/workers/{worker_id}/guidance")
    async def submit_guidance(
        task_id: str, worker_id: str, request: Request
    ) -> Dict[str, Any]:
        entry = _entry_for(request, task_id)
        require_task_type(entry, PLUGIN_TYPE)
        _require_writable(entry)
        plan = _load(workspace_dir_for(entry) / "plan.json", {}) or {}
        assigned = {
            str(item.get("worker_id"))
            for item in (plan.get("assignments") or [])
            if isinstance(item, dict)
        }
        if worker_id not in assigned:
            raise HTTPException(status_code=400, detail="worker is not assigned")
        try:
            body = await request.json()
            text = body.get("text", "") if isinstance(body, dict) else ""
            guidance = add_guidance(
                state_dir_for(entry) / "guidance", worker_id, str(text)
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"guidance": guidance}

    @router.post("/workers/{worker_id}/restart")
    def restart_worker(task_id: str, worker_id: str, request: Request) -> Dict[str, Any]:
        entry = _entry_for(request, task_id)
        require_task_type(entry, PLUGIN_TYPE)
        _require_writable(entry)
        # The worker name carries the card (`worker_6`), so any worker_<n>; the
        # plan lookup below is what actually pins it to this task.
        if not re.fullmatch(r"worker_\d+", worker_id):
            raise HTTPException(status_code=400, detail="invalid worker id")
        state_dir = state_dir_for(entry)
        workspace_dir = workspace_dir_for(entry)
        plan = _load(workspace_dir / "plan.json", {}) or {}
        assignment = next((
            item for item in (plan.get("assignments") or [])
            if isinstance(item, dict) and item.get("worker_id") == worker_id
        ), None)
        if assignment is None:
            raise HTTPException(status_code=400, detail="worker is not assigned")
        worker_root = workspace_dir / "workers" / worker_id
        status = _load(worker_root / "status.json", {}) or {}
        if status.get("state") not in {"failed", "timed_out"}:
            raise HTTPException(
                status_code=409,
                detail="only a failed or timed-out worker can be restarted",
            )
        pid_path = worker_root / "restart.pid.json"
        active_pid = _running_pid(pid_path)
        if active_pid is not None:
            raise HTTPException(
                status_code=409,
                detail=f"worker restart is already running as pid {active_pid}",
            )
        requirements = state_dir / "requirements.json"
        if not requirements.is_file():
            raise HTTPException(status_code=400, detail="requirements.json is missing")
        log_path = state_dir / f"{worker_id}_restart.log"
        command, integration_command = _restart_worker_commands(
            requirements, state_dir, workspace_dir, worker_id
        )
        try:
            with log_path.open("ab") as log_file:
                process = subprocess.Popen(
                    command,
                    cwd=Path(__file__).resolve().parents[4],
                    stdin=subprocess.DEVNULL,
                    stdout=log_file,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                    close_fds=True,
                )
                integration_process = subprocess.Popen(
                    integration_command,
                    cwd=Path(__file__).resolve().parents[4],
                    stdin=subprocess.DEVNULL,
                    stdout=log_file,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                    close_fds=True,
                )
        except OSError as exc:
            raise HTTPException(
                status_code=500, detail=f"failed to start worker: {exc}"
            ) from exc
        pid_path.write_text(json.dumps({
            "pid": process.pid,
            "task_id": task_id,
            "worker_id": worker_id,
            "physical_gpu": assignment.get("gpu"),
            "started_at": time.time(),
            "integration_pid": integration_process.pid,
        }, indent=2), encoding="utf-8")
        return {
            "ok": True,
            "worker_id": worker_id,
            "physical_gpu": assignment.get("gpu"),
            "pid": process.pid,
            "integration_pid": integration_process.pid,
            "isolated": True,
        }

    @router.post("/rename-repo")
    async def rename_repo(task_id: str, request: Request) -> Dict[str, Any]:
        """Rename the task's kernel repository and repair all references.

        Body: ``{"new_name": "<kernel-repos directory name>"}``. Refuses
        while the task's orchestrator is still running.
        """
        entry = _entry_for(request, task_id)
        require_task_type(entry, PLUGIN_TYPE)
        _require_writable(entry)
        state_dir = state_dir_for(entry)
        workspace_dir = workspace_dir_for(entry)
        try:
            body = await request.json()
        except (ValueError, AttributeError) as exc:
            raise HTTPException(
                status_code=400, detail="invalid JSON body"
            ) from exc
        new_name = (
            body.get("new_name") if isinstance(body, dict) else None
        ) or ""
        try:
            return rename_kernel_repo(
                workspace_dir, new_name, state_dir=state_dir
            )
        except (ValueError, RuntimeError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.get("/state-graph")
    def state_graph(task_id: str, request: Request) -> Dict[str, Any]:
        entry = _entry_for(request, task_id)
        require_task_type(entry, PLUGIN_TYPE)
        state_dir = state_dir_for(entry)
        run = read_run(state_dir)
        requirements = read_requirements(state_dir) or {}
        answers = requirements.get("answers")
        source = answers if isinstance(answers, dict) else requirements
        return phases.graph_payload(
            run.get("current_phase", phases.PREPARE),
            run.get("last_outcome"),
            run.get("last_transition_label"),
            include_baseline=(
                source.get("execution_mode") != GEN_AND_OPT_MODE
            ),
        )

    @router.get("/skills")
    def skills(task_id: str, request: Request) -> Dict[str, Any]:
        """The skill library, plus the hardware-profile context of a write.

        Two profiles travel in this payload and they are different things
        (compare ``variants_index``):

        * ``hw_profile`` / ``installed_profile`` -- the board **this machine**
          is, i.e. whose edition the library holds and where a write lands;
        * ``task_hw_profile`` -- the board **this task's numbers** were measured
          on.  Fusion and publishing fold the task's pending skill into the
          library of this machine's board, so the two must agree;
          ``write_blocked_reason`` carries the server's verdict (the same string
          its 409 returns) so the page can hide the buttons rather than offer
          ones that fail.
        """
        entry = _entry_for(request, task_id)
        require_task_type(entry, PLUGIN_TYPE)
        workspace_dir = workspace_dir_for(entry)
        library = list_skill_library(workspace_dir)
        plan = _load(workspace_dir / "plan.json", {}) or {}
        if plan.get("execution_mode") in {LEGACY_SMOKE_MODE, SMOKE_MODE}:
            quarantined = library.get("pending") or []
            library["pending"] = []
            library["quarantined_count"] = len(quarantined)
            library["publish_disabled_reason"] = (
                "Infrastructure-smoke findings are unrelated to the selected "
                "operator and cannot be published as optimization skills."
            )
        from metainfer.server.tools.backfill_task_hw_profile import recorded_profile

        task_profile, task_profile_source = recorded_profile(state_dir_for(entry))
        library["task_hw_profile"] = task_profile
        library["task_hw_profile_source"] = task_profile_source
        library["write_blocked_reason"] = _skill_profile_blocked_reason(entry)
        library["profiles"] = [
            {"id": profile.id, "label": profile.label, "cooled": profile.cooled}
            for profile in sorted(
                hw_profile.PROFILES.values(), key=lambda item: item.id
            )
        ]
        return library

    @router.post("/skills/{skill_name}/publish")
    def publish(task_id: str, skill_name: str, request: Request) -> Dict[str, Any]:
        entry = _entry_for(request, task_id)
        require_task_type(entry, PLUGIN_TYPE)
        _require_writable(entry)
        _require_task_board_matches_library(entry)
        workspace_dir = workspace_dir_for(entry)
        plan = _load(workspace_dir / "plan.json", {}) or {}
        if plan.get("execution_mode") in {LEGACY_SMOKE_MODE, SMOKE_MODE}:
            raise HTTPException(
                status_code=400,
                detail=(
                    "infrastructure-smoke skills are quarantined and cannot "
                    "be published"
                ),
            )
        try:
            return {
                "skill": publish_skill(workspace_dir, skill_name)
            }
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except FileExistsError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @router.post("/skills/sync")
    def sync_skills(task_id: str, request: Request) -> Dict[str, Any]:
        """Manually mirror the authoritative dsh library into the ccb library.

        Deliberately *not* behind the task-board guard: this only re-seeds this
        machine's own profile and mirrors it, so it cannot file one board's
        findings under the other -- it is the repair action, not a write of task
        knowledge.
        """
        entry = _entry_for(request, task_id)
        require_task_type(entry, PLUGIN_TYPE)
        _require_writable(entry)
        workspace_dir = workspace_dir_for(entry)
        return {"sync": sync_skill_libraries(workspace_dir=workspace_dir)}

    @router.post("/skills/fuse")
    async def fuse_skill_route(task_id: str, request: Request) -> Dict[str, Any]:
        """Trigger the main-agent fusion of one pending skill into the dsh
        library (mirrored to ccb afterwards). Runs in the background; poll
        ``GET /skills`` ``fuse_status`` for progress.

        The task's own board must be this machine's: the fusion agent folds the
        pending skill into the library of *this* profile, so a liquid task's
        findings fused on the air machine would be read as air knowledge.
        """
        entry = _entry_for(request, task_id)
        require_task_type(entry, PLUGIN_TYPE)
        _require_writable(entry)
        _require_task_board_matches_library(entry)
        workspace_dir = workspace_dir_for(entry)
        state_dir = state_dir_for(entry)
        plan = _load(workspace_dir / "plan.json", {}) or {}
        if plan.get("execution_mode") in {LEGACY_SMOKE_MODE, SMOKE_MODE}:
            raise HTTPException(
                status_code=400,
                detail=(
                    "infrastructure-smoke skills are quarantined and cannot "
                    "be fused"
                ),
            )
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001 - malformed body
            body = {}
        skill_name = str(body.get("skill_name") or "").strip()
        if not skill_name:
            raise HTTPException(status_code=400, detail="missing skill_name")
        pending = workspace_dir / "skills" / "pending" / skill_name
        if not (pending / "SKILL.md").is_file():
            raise HTTPException(
                status_code=404,
                detail=f"pending skill not found: {skill_name}",
            )
        req = read_requirements(state_dir)
        if req is None:
            raise HTTPException(
                status_code=400,
                detail="no requirements.json to read agent framework from",
            )
        config = load_config(req)
        mark_fuse_running(workspace_dir, skill_name)

        def _run_fusion() -> None:
            try:
                fuse_skill(
                    config=config,
                    workspace_dir=workspace_dir,
                    state_dir=state_dir,
                    skill_name=skill_name,
                )
            except Exception:  # noqa: BLE001 - status file carries the error
                pass

        threading.Thread(target=_run_fusion, daemon=True).start()
        return {
            "ok": True,
            "action": "fuse",
            "skill_name": skill_name,
            "status": "running",
        }

    @router.post("/skills/{skill_name}/rollback")
    def rollback(task_id: str, skill_name: str, request: Request) -> Dict[str, Any]:
        """Restore the latest SKILL.md backup of a fused skill in the dsh
        library and re-mirror to ccb."""
        entry = _entry_for(request, task_id)
        require_task_type(entry, PLUGIN_TYPE)
        _require_writable(entry)
        workspace_dir = workspace_dir_for(entry)
        try:
            return {"result": rollback_skill(skill_name, workspace_dir=workspace_dir)}
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @router.get("/variants")
    def variants_index(task_id: str, request: Request) -> Dict[str, Any]:
        """Return the fine-grained variant index (which shapes are already
        captured in the variant library), plus the hardware-profile context.

        Variants are stored per hardware profile: the air-cooled board has no
        HBM address hashing, so a median measured there is 40-87% slower on
        read-heavy operators and must never be compared with a liquid one.

        Two profiles travel in this payload, and they are different things:

        * ``hw_profile`` -- the board **this machine** is (what a write lands in);
        * ``task_hw_profile`` -- the board **this task's numbers** were measured
          on. A task page lists the variants of the task's own board: opening a
          liquid task on the air machine must show the liquid library, not an
          empty column (and promoting from it must be refused server-side).
        """
        entry = _entry_for(request, task_id)
        require_task_type(entry, PLUGIN_TYPE)
        from metainfer.server.tools.backfill_task_hw_profile import recorded_profile

        task_profile, task_profile_source = recorded_profile(state_dir_for(entry))
        return {
            "variants": list_variant_index(),
            "hw_profile": hw_profile.snapshot(),
            "task_hw_profile": task_profile,
            "task_hw_profile_source": task_profile_source,
            "profiles": [
                {"id": profile.id, "label": profile.label, "cooled": profile.cooled}
                for profile in sorted(
                    hw_profile.PROFILES.values(), key=lambda item: item.id
                )
            ],
        }

    @router.post("/variants")
    async def add_variant_route(task_id: str, request: Request) -> Dict[str, Any]:
        """Add one optimized shape's accepted kernel into the shared variant
        library, organized by operator type / model / TP / specific operator.
        Replaces an existing section for the same shape (with a file backup).

        The numbers in that kernel were measured on one specific board, and the
        write lands in *this* machine's profile, so the two must be the same:
        promoting a liquid task's kernel on the air machine would file liquid
        measurements under the air library (``variant/air-k100ai/...``).  A task
        whose profile is unknown is refused for the same reason -- there is no
        way to tell whether its medians belong here.
        """
        entry = _entry_for(request, task_id)
        require_task_type(entry, PLUGIN_TYPE)
        _require_writable(entry)
        state_dir = state_dir_for(entry)
        workspace_dir = workspace_dir_for(entry)
        detected = hw_profile.require().id
        from metainfer.server.tools.backfill_task_hw_profile import recorded_profile

        task_profile, task_profile_source = recorded_profile(state_dir)
        if not task_profile:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"this task has no recorded hardware profile, so its numbers "
                    f"cannot be filed under {detected!r}: classify it first with "
                    "`python3 -m metainfer.server.tools.backfill_task_hw_profile "
                    "--apply`"
                ),
            )
        if task_profile != detected:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"refusing to promote a {task_profile!r} task's kernel into "
                    f"the {detected!r} library: its median was measured on "
                    f"{task_profile!r} and is not comparable here "
                    f"(1.06-1.70x apart, per operator). Promote it on the "
                    f"{task_profile!r} machine instead."
                ),
            )
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001 - malformed body
            body = {}
        shape_id = str(body.get("shape_id") or "").strip()
        if not shape_id:
            raise HTTPException(status_code=400, detail="missing shape_id")
        req = read_requirements(state_dir)
        if req is None:
            raise HTTPException(
                status_code=400, detail="no requirements.json for this task"
            )
        answers = req.get("answers") if isinstance(req.get("answers"), dict) else req

        # Locate the accepted kernel for this shape under any worker lane.
        accepted = None
        for worker_root in sorted((workspace_dir / "workers").glob("worker_*")):
            candidate = worker_root / "accepted" / shape_id / "kernel.hip"
            if candidate.is_file():
                accepted = candidate
                break
        if accepted is None:
            raise HTTPException(
                status_code=404,
                detail=f"no accepted kernel for shape {shape_id}",
            )
        manifest_path = accepted.parent / "manifest.json"
        manifest = _load(manifest_path, {})
        metrics = dict(manifest.get("metrics") or {})
        meta = derive_variant_meta(answers, shape_id)
        # Baseline (for the speedup multiple) comes from the task's fixed
        # table first (final_report); when the task stopped before REPORT,
        # fall back to the shared fixed Triton baseline table so the variant
        # still records a meaningful baseline_us/speedup.
        #
        # Either source counts only when the number provably came from *this*
        # machine's profile (trusted_baseline_us): a pre-split task report, or a
        # lookup that fell back to the reference board, carries the other
        # board's number -- the kernel is still recorded, the ratio is not.
        baseline = None
        initial = _load(
            workspace_dir / "final_report.json", {}
        ).get("initial_metrics") or {}
        b = initial.get(shape_id)
        if b is not None:
            baseline = trusted_baseline_us(b)
        if baseline is None:
            shape_params = dict(manifest.get("shape") or {})
            if meta.get("tp") is not None:
                shape_params["tp_size"] = meta["tp"]
            try:
                record = fixed_triton_graph_baseline(shape_id, shape_params)
                baseline = trusted_baseline_us(record)
            except ValueError:
                baseline = None
        if baseline is not None and metrics.get("median_us"):
            metrics["baseline_us"] = baseline
            metrics["speedup"] = float(baseline) / float(metrics["median_us"])

        kernel_source = accepted.read_text(encoding="utf-8", errors="replace")
        commit = str(manifest.get("commit") or "")
        try:
            result = add_variant(
                meta=meta,
                kernel_source=kernel_source,
                commit=commit,
                metrics=metrics,
                source_task=str(req.get("task_id") or task_id),
                backup=True,
                # Hard guard: a strictly slower candidate may not replace the
                # existing variant for the same shape (equal/faster may).
                reject_slower_than_existing=True,
                # This is the user-facing write boundary: the leaf must land in
                # the profile of the machine that measured it.  An unidentifiable
                # machine fails here instead of writing into "unmigrated".
                require_profile=True,
            )
        except hw_profile.HardwareProfileError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"ok": True, **result}

    return router
