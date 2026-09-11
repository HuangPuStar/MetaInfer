"""State-conditioned optimization plan selector (v0, not yet wired).

DKAO currently chooses the next optimization direction with the round menus in
``prompts.py::w8a8_round_strategy`` (keyed by iteration number). This module is
the first step toward a *state-conditioned* plan selector that decides "what to
try this round" from the current measured state (history + PMC + budget), per
the design in ``docs/dkao_harness_eval_protocol.md`` / M1 slice-2.

Slice-2 semantics:
- **Additive and inert**: nothing in the runtime pipelines calls this module yet.
  ``prompts.py``/``w8a8_pipeline.py`` keep their current behaviour unchanged.
- The plan catalog lives as data in ``harness_default/planner_catalog.yaml``
  (read through ``harness_io`` with ``METAINFER_HARNESS_ROOT`` override) so it is
  already an evolvable harness component; this module only consumes it.
- Selection layering: P0 repair -> P1 budget/phase -> P2 bottleneck signature ->
  P3 coverage / anti-loop -> P4 fallback (legacy round-menu approximation).
  Rules are deterministic pure functions, tested without GPU.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml

from .harness_io import harness_root

# ---------------------------------------------------------------------------
# Catalog (data in harness_default/planner_catalog.yaml; fallback built-in)
# ---------------------------------------------------------------------------
BUILTIN_PLAN_IDS = [
    "repair_faster_wrong", "fix_build", "retry_same",
    "bootstrap_correctness", "establish_arch", "architecture_explore",
    "grid_splitk", "pipeline_tune", "memory_layout", "occupancy_resource",
    "epilogue_fusion", "isa_guided_hip", "conditional_inline_asm", "consolidate",
]


def _builtin_catalog() -> Dict[str, Dict[str, Any]]:
    return {pid: {"focus": pid.replace("_", " ")} for pid in BUILTIN_PLAN_IDS}


def _wired(name: str, root: Optional[Path]) -> bool:
    """A component marked wired:false in the manifest is not applied at all."""
    try:
        from . import gate_policy as _gates
        return _gates.component_wired(name, root)
    except Exception:  # noqa: BLE001
        return True


def catalog(root: Optional[Path] = None) -> Dict[str, Dict[str, Any]]:
    """Load the plan catalog from the harness workspace (YAML) or built-in."""
    base = (root or harness_root()) / "planner_catalog.yaml"
    if not _wired("planner_catalog", root):
        return _builtin_catalog()
    if base.is_file():
        with base.open("r", encoding="utf-8") as fh:
            data = yaml.safe_load(fh) or {}
        entries = data.get("catalog")
        if isinstance(entries, dict) and entries:
            return {pid: dict(meta) for pid, meta in entries.items()}
    return _builtin_catalog()


def _builtin_policy() -> Dict[str, Any]:
    return {
        "repair_priority": {
            "faster_wrong": "repair_faster_wrong",
            "infrastructure_failure": "retry_same",
            "build_failure": "fix_build",
            "no_valid_kernel": "establish_arch",
        },
        "phase_gates": {
            "consolidate_when_rounds_left_lte": 1,
            "plateau_recent_valid_rounds": 3,
            "plateau_min_improvement_percent": -2.0,
            "plateau_max_improvement_percent_exclusive": 2.0,
            "isa_plan": "isa_guided_hip",
            "inline_asm_plan": "conditional_inline_asm",
            "consolidate_plan": "consolidate",
        },
        "bottleneck_to_plan": {
            "occupancy_limited": "occupancy_resource",
            "bank_conflicts": "memory_layout",
            "lds_wait": "pipeline_tune",
            "l2_low": "memory_layout",
            "grid_limited": "grid_splitk",
        },
        "coverage": {"max_consecutive_same_plan": 2,
                     "max_trials_per_plan": 2},
        "fallback": {
            "fresh": "establish_arch",
            "prefill": ["memory_layout", "pipeline_tune", "architecture_explore",
                        "memory_layout", "epilogue_fusion", "pipeline_tune",
                        "occupancy_resource", "consolidate"],
            "m16": ["architecture_explore", "grid_splitk", "pipeline_tune",
                    "memory_layout", "pipeline_tune", "pipeline_tune",
                    "occupancy_resource", "consolidate"],
            "small": ["establish_arch", "memory_layout", "occupancy_resource",
                      "architecture_explore", "memory_layout", "pipeline_tune",
                      "pipeline_tune", "consolidate"],
        },
    }


def policy(root: Optional[Path] = None) -> Dict[str, Any]:
    """Load the evolvable state->plan policy from the harness workspace."""
    base = (root or harness_root()) / "planner_policy.yaml"
    if not _wired("planner_policy", root):
        return _builtin_policy()
    if base.is_file():
        with base.open("r", encoding="utf-8") as fh:
            data = yaml.safe_load(fh) or {}
        if isinstance(data, dict):
            # only policy sections; metadata keys are ignored by selector
            return data
    return _builtin_policy()


# ---------------------------------------------------------------------------
# Context helpers
# ---------------------------------------------------------------------------
def _valid(record: Dict[str, Any]) -> bool:
    metrics = record.get("metrics") or {}
    return bool(
        record.get("build_success") is True
        and record.get("correctness_passed") is True
        and metrics.get("graph_capture_passed") is True
    )


_INFRA_TOKENS = ("timeout", "timed out", "killed", "no result", "exit 143")


def _is_infra_failure(record: Dict[str, Any]) -> bool:
    reason = str(record.get("failure_reason") or "").lower()
    return any(token in reason for token in _INFRA_TOKENS)


def derive_ctx(
    history: List[Dict[str, Any]],
    pmc: Optional[Dict[str, Any]] = None,
    iteration: int = 1,
    max_iterations: int = 10,
    *,
    compiler_limitation_confirmed: bool = False,
    plan_tags: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Fold history + PMC into the compact state vector used by the selector.

    Alignment notes (v0, documented approximations):
    - ``valid`` mirrors ``isa_round_policy``'s definition of a valid experiment
      (build+correctness+graph-capture ok).
    - plateau uses the last three *valid* improvements within [-2%, 2%).
    - infra/build/faster-wrong signals mirror the repair branches already in
      ``w8a8_round_strategy``.
    - plan_tags: per-round plan ids from proposal (schema lands in a later
      slice). Absent -> coverage guards are inert.
    """
    pol = policy()
    phase = pol.get("phase_gates") or {}
    recent_n = int(phase.get("plateau_recent_valid_rounds", 3))
    plateau_min = float(phase.get("plateau_min_improvement_percent", -2.0))
    plateau_max = float(
        phase.get("plateau_max_improvement_percent_exclusive", 2.0)
    )
    valid = [r for r in history if _valid(r)]
    recent = valid[-recent_n:]
    improvements = [
        float((r.get("acceptance") or {}).get("improvement_percent", float("inf")))
        for r in recent
    ]
    plateau = (
        len(recent) == recent_n
        and all(plateau_min <= v < plateau_max for v in improvements)
    )
    faster_wrong = any(
        r.get("build_success") is True
        and r.get("correctness_passed") is False
        and isinstance(r.get("speedup"), (int, float))
        and float(r["speedup"]) > 1.0
        for r in history
    )
    last = history[-1] if history else None
    last_present = last is not None
    last_build_ok = bool(last and last.get("build_success") is True)
    last_infra = bool(last and _is_infra_failure(last))

    rounds_used = iteration
    tried: Dict[str, int] = {}
    consecutive = 0
    tags = plan_tags or []
    for t in tags:
        tried[t] = tried.get(t, 0) + 1
    if tags:
        for t in reversed(tags):
            if t == tags[-1]:
                consecutive += 1
            else:
                break

    return {
        "iteration": iteration,
        "max_iterations": max_iterations,
        "rounds_left": max(0, max_iterations - rounds_used + 1),
        "valid_hip_rounds": len(valid),
        "recent_improvements": improvements,
        "plateau": plateau,
        "faster_wrong": faster_wrong,
        "last_present": last_present,
        "last_build_ok": last_build_ok,
        "last_infra": last_infra,
        "compiler_limitation_confirmed": compiler_limitation_confirmed,
        "pmc": pmc or {},
        "tried_counts": tried,
        "consecutive_same": consecutive,
        "plan_tags": tags,
    }


# ---------------------------------------------------------------------------
# Bottleneck signature (P2)
# ---------------------------------------------------------------------------
def bottleneck_tags(pmc: Dict[str, Any]) -> List[str]:
    """Map available PMC fields to bottleneck tags (heuristic, v0).

    Field names follow the counters referenced across the worker pipeline
    (occupancy resources, lds bank conflicts / waits, grid vs CU, L2 hit).
    Missing/None evidence yields []. Calibration against the real hipprof
    schema happens when this selector is wired.
    """
    tags: List[str] = []
    cu = pmc.get("device_cu_count")
    grid = pmc.get("grid_blocks")
    if isinstance(cu, (int, float)) and isinstance(grid, (int, float)):
        if cu > 0 and grid < 2.0 * cu:
            tags.append("grid_limited")

    lds_conflicts = pmc.get("lds_bank_conflicts")
    lds_inst = pmc.get("lds_instructions")
    if (
        isinstance(lds_conflicts, (int, float))
        and isinstance(lds_inst, (int, float))
        and lds_inst > 0
        and lds_conflicts / lds_inst > 1.5
    ):
        tags.append("bank_conflicts")

    lds_wait = pmc.get("lds_wait_instructions")
    if (
        isinstance(lds_wait, (int, float))
        and isinstance(lds_inst, (int, float))
        and lds_inst > 0
        and lds_wait >= lds_inst
    ):
        tags.append("lds_wait")

    occupancy = pmc.get("waves_per_cu") or pmc.get("active_waves_per_cu")
    target = pmc.get("target_waves_per_cu")
    if isinstance(occupancy, (int, float)) and isinstance(target, (int, float)):
        if target > 0 and occupancy < target:
            tags.append("occupancy_limited")

    l2 = pmc.get("l2_hit_rate")
    if isinstance(l2, (int, float)) and l2 < 70.0:
        tags.append("l2_low")

    # no tags -> caller falls back to P3/P4
    return tags


# ---------------------------------------------------------------------------
# Selector
# ---------------------------------------------------------------------------
_BOTTLENECK_TO_PLAN = {
    "occupancy_limited": "occupancy_resource",
    "bank_conflicts": "memory_layout",
    "lds_wait": "pipeline_tune",
    "l2_low": "memory_layout",
    "grid_limited": "grid_splitk",
}


def _legacy_fallback(ctx: Dict[str, Any]) -> str:
    """P4 fallback approximating today's round menus by M regime + iteration.

    Mirrors the *intent* of ``w8a8_round_strategy``'s small_m / m16 / large_m
    portfolios (explicitly approximate; runtime is unchanged until wiring).
    """
    pol = policy()
    fallback = pol.get("fallback") or _builtin_policy()["fallback"]
    m = int((ctx.get("shape") or {}).get("M", 0) or 0)
    it = int(ctx.get("iteration", 1))
    if it <= 1:
        return str(fallback.get("fresh") or "establish_arch")
    regime = "prefill" if m >= 128 else ("m16" if m >= 16 else "small")
    table = list(fallback.get(regime) or _builtin_policy()["fallback"][regime])
    if not table:
        return "establish_arch"
    # Cycle the portfolio instead of clamping to its last row: clamping used to
    # pin long runs to whatever the table ended with (consolidate), which
    # turned every remaining round into a no-op (observed on 9-8-8 iteration 3:
    # 9 of 11 rounds were consolidate).
    idx = (max(0, it - 2)) % len(table)
    return str(table[idx])


def choose_plan(ctx: Dict[str, Any]) -> str:
    """Deterministically pick this round's plan id from the state vector.

    Layering: P0 repair -> P1 budget/phase gates -> P2 bottleneck signature
    -> P3 coverage guards -> P4 legacy fallback.
    """
    pol = policy()
    repair = pol.get("repair_priority") or _builtin_policy()["repair_priority"]
    phase = pol.get("phase_gates") or _builtin_policy()["phase_gates"]
    bottleneck_map = pol.get("bottleneck_to_plan") or _BOTTLENECK_TO_PLAN
    coverage = pol.get("coverage") or _builtin_policy()["coverage"]

    # P0: evolvable repair priorities.
    if ctx.get("faster_wrong"):
        return str(repair["faster_wrong"])
    if ctx.get("last_present"):
        if ctx.get("last_infra"):
            return str(repair["infrastructure_failure"])
        if not ctx.get("last_build_ok"):
            return str(repair["build_failure"])
    if ctx.get("valid_hip_rounds", 0) == 0:
        return str(repair["no_valid_kernel"])

    # P1: evolvable budget / ISA phase gates.
    if ctx.get("rounds_left", 1) <= int(
        phase.get("consolidate_when_rounds_left_lte", 1)
    ):
        return str(phase.get("consolidate_plan") or "consolidate")
    if ctx.get("plateau") and ctx.get("valid_hip_rounds", 0) >= max(
        1, int(ctx.get("max_iterations", 10)) - 2
    ):
        if ctx.get("compiler_limitation_confirmed"):
            return str(phase.get("inline_asm_plan") or "conditional_inline_asm")
        return str(phase.get("isa_plan") or "isa_guided_hip")

    # P1.5: uncertainty fallback. With no bottleneck evidence the selector has
    # nothing to condition on; the legacy menu is a known-good default there,
    # and treating it as an available plan keeps policy evolution from ever
    # being worse than the hand-tuned menu (it becomes an option HE can pick).
    uncertainty = pol.get("uncertainty") or {}
    if uncertainty.get("enabled"):
        has_bottleneck = bool(bottleneck_tags(ctx.get("pmc") or {}))
        if (not has_bottleneck
                and ctx.get("valid_hip_rounds", 0) >= int(
                    uncertainty.get("min_valid_rounds", 1))):
            return str(uncertainty.get("plan") or "legacy_menu")

    # P2: evolvable bottleneck -> plan mapping.
    candidates: List[str] = []
    for tag in bottleneck_tags(ctx.get("pmc") or {}):
        plan = bottleneck_map.get(tag)
        if plan and plan not in candidates:
            candidates.append(str(plan))

    # P3: evolvable coverage / anti-loop limits.
    tried = ctx.get("tried_counts") or {}
    consecutive = int(ctx.get("consecutive_same", 0))
    max_consecutive = int(coverage.get("max_consecutive_same_plan", 2))
    max_trials = int(coverage.get("max_trials_per_plan", 2))
    for plan in candidates:
        if consecutive >= max_consecutive and plan == candidates[0]:
            continue
        if tried.get(plan, 0) < max_trials:
            return plan

    # P4: fallback
    return _legacy_fallback(ctx)


def choose_plan_from_history(
    history: List[Dict[str, Any]],
    pmc: Optional[Dict[str, Any]] = None,
    iteration: int = 1,
    max_iterations: int = 10,
    **overrides: Any,
) -> str:
    """Convenience: derive ctx from history + pmc, then select the plan."""
    # Forward ctx-shaping overrides into derive_ctx (plan_tags/consecutive and
    # compiler gate must be part of the derived state, not late-added).
    derived_kwargs = {}
    for key in ("plan_tags", "compiler_limitation_confirmed"):
        if key in overrides:
            derived_kwargs[key] = overrides.pop(key)
    ctx = derive_ctx(
        history,
        pmc,
        iteration=iteration,
        max_iterations=max_iterations,
        **derived_kwargs,
    )
    ctx.update(overrides)
    return choose_plan(ctx)


# ---------------------------------------------------------------------------
# Rendering (v0): plan -> worker-facing mandate text
# ---------------------------------------------------------------------------
_FAMILY_EXTRA: Dict[str, str] = {
    "repair": (
        "Preserve the fast/previous architecture and make the smallest "
        "correction for the reported issue; do not start a redesign."
    ),
    "bootstrap": (
        "Correctness first: a compile-clean kernel with exact int32 math "
        "matters more than performance this round."
    ),
    "explore": (
        "Make ONE bounded architecture experiment; report grid_blocks, "
        "waves_per_block and estimated active CUs in proposal.json."
    ),
    "optimize": (
        "One bounded mechanism per round with a falsifiable prediction; "
        "keep all other paths byte-identical."
    ),
    "isa": (
        "ISA evidence is advisory; only shape compiler output through "
        "HIP/DUMMA/intrinsics. Raw inline asm follows the control-plane gate."
    ),
}


def render_plan(
    plan_id: str,
    *,
    ctx: Optional[Dict[str, Any]] = None,
    cat: Optional[Dict[str, Dict[str, Any]]] = None,
) -> str:
    """Render a selected plan id into a worker-facing mandate (deterministic).

    v0 wording is intentionally concise and derives from the catalog's focus +
    family discipline. When this selector replaces ``w8a8_round_strategy``, the
    round prompt will embed this text; until then it is only used for parity
    tests and offline exploration.
    """
    entries = cat if cat is not None else catalog()
    meta = entries.get(plan_id) or {}
    focus = str(meta.get("focus") or plan_id.replace("_", " "))
    family = str(meta.get("family") or "")
    lines = [
        f"Mandatory decision for this round: {plan_id}.",
        f"Focus: {focus}.",
    ]
    extra = _FAMILY_EXTRA.get(family)
    if extra:
        lines.append(extra)
    if ctx:
        lines.append(
            f"Round context: iteration {ctx.get('iteration', '?')} / "
            f"{ctx.get('max_iterations', '?')}, "
            f"{ctx.get('rounds_left', '?')} rounds left."
        )
    return "\n".join(lines)
