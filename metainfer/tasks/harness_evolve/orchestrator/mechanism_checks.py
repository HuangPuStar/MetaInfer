"""Mechanism gate: check whether a harness change was actually exercised.

The Evolve Agent declares, per change, *why* it should work (a
``mechanism_signature``) and — since this module landed — how to verify that
the mechanism really ran (a structured ``mechanism_check``). This module
collects the candidate iteration's evidence and grades each declared change:

  ``hit``          the declared mechanism was observed
  ``partial``      planner/agent activity observed, but not the declared plan
  ``unobserved``   nothing to observe (no record) — *not* a contradiction
  ``contradicted`` the change demonstrably did not take effect (e.g. the
                   candidate harness revision was never loaded, or the
                   planner produced no plan records although the change
                   requires it)

Grades feed ``decision_engine``: under the default lenient policy a real
performance win may promote with ``hit``/``partial``/``unobserved`` evidence
(the latter recorded as PROMOTE_UNEXPLAINED), while a *contradiction* forces
one confirmation round so an implausible explanation cannot silently win.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Tuple

from .rounds import child_dir_map

_PLAN_ID_KEYS = ("plan_id", "planner_plan_id", "plan")
_GATE_EVENT_HINTS = ("gate", "guard", "threshold", "reject", "blocked")


def _load_json(path: Path) -> Dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _jsonl(path: Path) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    if not path.is_file():
        return out
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict):
            out.append(row)
    return out


def _candidate_gates(candidate_workspace: Optional[Path]) -> Dict[str, Any]:
    """Gate values the candidate harness declares (its gates.yaml + wiring)."""
    if candidate_workspace is None:
        return {}
    root = Path(candidate_workspace)
    try:
        import yaml
        manifest = yaml.safe_load(
            (root / "manifest.yaml").read_text(encoding="utf-8")) or {}
        data = yaml.safe_load(
            (root / "gates.yaml").read_text(encoding="utf-8")) or {}
    except (OSError, ValueError):
        return {}
    components = manifest.get("components") or {}
    gates_entry = components.get("gates") if isinstance(components, dict) else {}
    return {
        "gates": data.get("gates") if isinstance(data, dict) else None,
        "wired": bool((gates_entry or {}).get("wired", True)),
    }


def collect_candidate_evidence(exp: Path, iteration: int,
                               planner_enabled: Optional[bool] = None,
                               candidate_workspace: Optional[Path] = None,
                               ) -> Dict[str, Any]:
    """Gather observable evidence from one iteration's DKAO children."""
    exp = Path(exp)
    children_root = exp / "children"
    snapshot_manifest = (
        exp / "runs" / f"iteration_{iteration:03d}" / "input" / "workspace"
        / "manifest.yaml"
    )
    candidate_revision = ""
    try:
        import yaml
        candidate_revision = str(
            (yaml.safe_load(snapshot_manifest.read_text(encoding="utf-8"))
             or {}).get("revision") or ""
        )
    except (OSError, ValueError):
        candidate_revision = ""

    observed_gate_snapshots: List[Dict[str, Any]] = []
    agent_plan_ids: List[str] = []
    planner_plan_ids: List[str] = []
    harness_revisions: List[str] = []
    gate_events: List[str] = []
    children: Dict[str, Any] = {}
    # An iteration can own several attempt directories (a first run, its
    # environment retries, and the generalization retake): evidence is gathered
    # from all of them, because a mechanism that fired in any attempt fired.
    for child in (child_dir_map(children_root, iteration).values()
                  if children_root.is_dir() else []):
        workspace = child / "workspace"
        child_plans: List[str] = []
        for exp_file in (workspace / "workers").glob(
                "*/runs/*/experiments.jsonl"):
            for row in _jsonl(exp_file):
                for key in _PLAN_ID_KEYS:
                    value = row.get(key)
                    if isinstance(value, str) and value.strip():
                        child_plans.append(value.strip())
                        break
        agent_plan_ids.extend(child_plans)

        # Hard evidence: the plans the DKAO planner itself selected for
        # this worker's rounds (written by _round_strategy_text).
        for plans_file in (workspace / "workers").glob(
                "*/planner_plans.jsonl"):
            for row in _jsonl(plans_file):
                value = row.get("plan_id")
                if isinstance(value, str) and value.strip():
                    planner_plan_ids.append(value.strip())

        scaffold = _load_json(workspace / "main" / "scaffold_manifest.json")
        harness = scaffold.get("harness") if isinstance(scaffold, dict) else {}
        revision = ""
        if isinstance(harness, dict):
            revision = str(harness.get("revision") or "")
        if revision:
            harness_revisions.append(revision)

        gate_snapshot = _load_json(child / "state" / "gates_effective.json")
        if gate_snapshot:
            observed_gate_snapshots.append(gate_snapshot)

        for event in _jsonl(child / "state" / "timeline.jsonl"):
            etype = str(event.get("type") or "")
            if any(hint in etype for hint in _GATE_EVENT_HINTS):
                gate_events.append(etype)

        children[child.name] = {
            "agent_plan_ids": child_plans,
            "harness_revision": revision,
        }

    return {
        "iteration": iteration,
        "planner_enabled": planner_enabled,
        "candidate_harness_revision": candidate_revision,
        "observed_harness_revisions": sorted(set(harness_revisions)),
        # ``plan_ids`` stays the agents' self-reported ids for backwards
        # compatibility; ``planner_plan_ids`` is the authoritative record.
        "plan_ids": agent_plan_ids,
        "agent_plan_ids": agent_plan_ids,
        "planner_plan_ids": planner_plan_ids,
        "plan_id_source": ("planner" if planner_plan_ids
                           else ("agent" if agent_plan_ids else "none")),
        "candidate_gates": _candidate_gates(candidate_workspace),
        "observed_gates": observed_gate_snapshots,
        "gate_events": sorted(set(gate_events)),
        "children": children,
    }


def _grade_harness_revision(change: Mapping[str, Any],
                            evidence: Mapping[str, Any]) -> Tuple[str, str]:
    observed = list(evidence.get("observed_harness_revisions") or [])
    expected = str(evidence.get("candidate_harness_revision") or "")
    if not observed:
        return "unobserved", "no child recorded which harness revision it loaded"
    if expected and all(rev == expected for rev in observed):
        return "hit", f"candidate harness revision {expected} was loaded"
    if expected and all(rev != expected for rev in observed):
        return ("contradicted",
                f"children loaded {observed} but the candidate revision is "
                f"{expected}: the change never took effect")
    return "partial", f"harness revisions observed: {observed}"


def _grade_plan_ids(change: Mapping[str, Any],
                    evidence: Mapping[str, Any]) -> Tuple[str, str]:
    check = change.get("mechanism_check") or {}
    planner_ids = list(evidence.get("planner_plan_ids") or [])
    agent_ids = list(evidence.get("agent_plan_ids")
                     or evidence.get("plan_ids") or [])
    observed = planner_ids or agent_ids
    expect_any = [str(x) for x in (check.get("expect_any") or [])]
    expect_order = [str(x) for x in (check.get("expect_order") or [])]
    if not expect_any and not expect_order:
        return "unobserved", "mechanism_check declares no expected plan ids"
    # A disabled planner is hard counter-evidence: a planner_policy change
    # cannot have been consumed, whatever plan ids the agents reported for
    # themselves (those come from the workers' own proposals).
    if evidence.get("planner_enabled") is False:
        return ("contradicted",
                "the planner was disabled for this iteration, so a "
                "planner_policy change could not have taken effect"
                + (f" (agent-reported plan ids: {sorted(set(observed))})"
                   if observed else ""))
    if not observed:
        return ("unobserved",
                "no planner plan records were produced this iteration")
    if not planner_ids:
        # Only the workers' own proposals mention plans; that cannot prove the
        # planner drove the mandate, so it is soft evidence at best.
        hits_any = [pid for pid in agent_ids
                    if pid in expect_any or pid in expect_order]
        if hits_any:
            return ("partial",
                    "plan ids match only agent self-reports (no planner "
                    f"record): {sorted(set(hits_any))}")
        return ("partial",
                f"agent-reported plan ids {sorted(set(agent_ids))} do not "
                f"match the declared ones")
    if expect_order:
        idx = 0
        for pid in observed:
            if idx < len(expect_order) and pid == expect_order[idx]:
                idx += 1
        if idx == len(expect_order):
            return "hit", f"observed expected plan order {expect_order}"
    hit_any = [pid for pid in observed if pid in expect_any]
    if hit_any:
        return "hit", f"observed declared plan(s) {sorted(set(hit_any))}"
    return ("partial",
            f"planner produced plans {sorted(set(observed))} but none of the "
            f"declared ones {sorted(set(expect_any + expect_order))}")


def _grade_gate_events(change: Mapping[str, Any],
                       evidence: Mapping[str, Any]) -> Tuple[str, str]:
    check = change.get("mechanism_check") or {}
    expected = [str(x) for x in (check.get("expect_any") or [])]
    observed = list(evidence.get("gate_events") or [])
    if not expected:
        return "unobserved", "mechanism_check declares no expected gate events"
    hits = [event for event in observed if event in expected]
    if hits:
        return "hit", f"observed declared gate event(s) {hits}"
    return "unobserved", f"declared gate events absent (observed {observed})"


def _grade_gate_values(change: Mapping[str, Any],
                       evidence: Mapping[str, Any]) -> Tuple[str, str]:
    """Did children actually run with the gate values the harness declares?"""
    candidate = evidence.get("candidate_gates") or {}
    declared = candidate.get("gates")
    observed = list(evidence.get("observed_gates") or [])
    if not candidate:
        return "unobserved", "candidate harness gates could not be read"
    if not candidate.get("wired", True):
        return ("contradicted",
                "gates.yaml is not wired in the candidate manifest, so its "
                "values cannot reach the runtime")
    if not observed:
        return ("unobserved",
                "children recorded no effective-gate snapshot for this run")
    check = change.get("mechanism_check") or {}
    paths = [str(p) for p in (check.get("expect_any") or [])]
    for snapshot in observed:
        seen = snapshot.get("gates")
        if not isinstance(seen, Mapping) or declared is None:
            continue
        if paths:
            mismatched = []
            for path in paths:
                node_seen: Any = seen
                node_declared: Any = declared
                for part in path.split("."):
                    node_seen = node_seen.get(part) if isinstance(node_seen, Mapping) else None
                    node_declared = (node_declared.get(part)
                                     if isinstance(node_declared, Mapping) else None)
                if node_seen != node_declared:
                    mismatched.append(path)
            if mismatched:
                return ("contradicted",
                        f"children ran with different values for {mismatched}")
            return "hit", f"children ran with the declared values for {paths}"
        if dict(seen) == dict(declared):
            return "hit", "children ran with the candidate gate values"
        return ("contradicted",
                "children ran with gate values that differ from the candidate")
    return "unobserved", "no comparable gate snapshot"


_GRADERS = {
    "harness_revision": _grade_harness_revision,
    "planner_plan_ids": _grade_plan_ids,
    "planner_plan_id_sequence": _grade_plan_ids,
    "gate_events": _grade_gate_events,
    "gate_values": _grade_gate_values,
}


def evaluate_changes(
    manifest: Optional[Mapping[str, Any]],
    evidence: Mapping[str, Any],
) -> Tuple[Dict[str, str], Dict[str, Any]]:
    """Grade every declared change; returns (checks, detail)."""
    changes = [c for c in ((manifest or {}).get("changes") or [])
               if isinstance(c, Mapping)]
    checks: Dict[str, str] = {}
    detail: Dict[str, Any] = {"changes": []}
    for change in changes:
        cid = str(change.get("id") or "unknown")
        check = change.get("mechanism_check")
        declared = bool(change.get("mechanism_signature"))
        if not declared:
            checks[cid] = "unobserved"
            detail["changes"].append({
                "id": cid, "grade": "unobserved",
                "reason": "change declares no mechanism_signature",
            })
            continue
        if not isinstance(check, Mapping):
            checks[cid] = "unobserved"
            detail["changes"].append({
                "id": cid, "grade": "unobserved",
                "reason": ("no structured mechanism_check declared; "
                           "signature kept as documentation only"),
            })
            continue
        kind = str(check.get("kind") or "").strip()
        grader = _GRADERS.get(kind)
        if grader is None:
            checks[cid] = "unobserved"
            detail["changes"].append({
                "id": cid, "grade": "unobserved",
                "reason": f"unknown mechanism_check kind {kind!r}",
            })
            continue
        grade, reason = grader(change, evidence)
        checks[cid] = grade
        detail["changes"].append({
            "id": cid, "grade": grade, "kind": kind, "reason": reason,
            "expect": {k: v for k, v in check.items() if k != "kind"},
        })
    detail["planner_plan_ids"] = list(evidence.get("planner_plan_ids") or [])
    detail["agent_plan_ids"] = list(evidence.get("agent_plan_ids") or [])
    detail["summary"] = {
        "hit": [c for c, g in checks.items() if g == "hit"],
        "partial": [c for c, g in checks.items() if g == "partial"],
        "unobserved": [c for c, g in checks.items() if g == "unobserved"],
        "contradicted": [c for c, g in checks.items() if g == "contradicted"],
    }
    return checks, detail
