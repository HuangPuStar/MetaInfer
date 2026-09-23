"""Single-role Evolve adapters.

The real AgentEvolver modifies the harness workspace and, in the same turn,
produces BOTH:
  - _ahe_change_manifest.json (what changed / system prediction / mechanism)
  - _ahe_round_plan.json      (which registered questions to run next + why)
The pipeline moves these to runs/iteration_NNN/evolve/ after validation.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any, Dict, Optional

#: Model id the DSH Evolve Agent runs on by default. The form's `evolve_model`
#: field picks a label (see form.yaml) and the pipeline passes the id down to
#: ``bridge/dsh/dsh_agent.py --model``; this constant is the fallback used by
#: callers that were given no answer at all.
#: ``deepseek/deepseek-flash`` is the 4.1 Flash revision (form label
#: ``deepseek-flash-4.1``). ``deepseek/deepseek-v4-flash-0731`` is the older
#: pinned build, kept selectable for reproducing earlier experiments.
DEFAULT_EVOLVE_MODEL = "deepseek/deepseek-flash"
LEGACY_EVOLVE_MODEL = "deepseek/deepseek-v4-flash-0731"


def _empty_manifest(iteration: int) -> Dict[str, Any]:
    return {
        "schema_version": 1,
        "iteration": iteration,
        "changes": [],
        "verification": {
            "status": "pending", "fixes": [], "regressions": [],
            "false_predictions": [], "verdict": None,
        },
        "note": "dry-run evolve: no automatic changes",
    }


class Evolver:
    name = "base"

    def apply(self, workspace: Path, iteration: int,
              query_context: Dict[str, Any]) -> Dict[str, Any]:
        raise NotImplementedError


class DryRunEvolver(Evolver):
    name = "dry-run"

    def apply(self, workspace, iteration, query_context):
        fake = os.environ.get("HARNESS_EVOLVE_FAKE_CHANGE", "") in {"1", "true"}
        manifest = _empty_manifest(iteration)
        changed = False
        summary_lines = [f"# Evolve summary — iteration {iteration} (dry-run)", "",
                         "No automatic harness change (dry-run evolver)."]
        if fake:
            manifest = {
                "schema_version": 1, "iteration": iteration,
                "changes": [{
                    "id": f"chg-{iteration}", "type": "new",
                    "component": "gates",
                    "description": "synthetic change for attribution testing",
                    "files": ["gates.yaml"],
                    "failure_evidence": ["dry-run synthetic failure"],
                    "root_cause": "synthetic", "targeted_fix": "synthetic gates edit",
                    "failure_pattern": "synthetic", "predicted_fixes": [],
                    "risk_tasks": [],
                    "scope": {"expected_improve": ["synthetic"],
                              "expected_unchanged": [], "at_risk": [],
                              "routeable": False},
                    "system_prediction": {"direction": "improve",
                                          "expected_effect": ["pass-rate increase"]},
                    "mechanism_signature": ["synthetic mechanism fires"],
                }],
                "verification": {"status": "pending", "fixes": [],
                                 "regressions": [], "false_predictions": [],
                                 "verdict": None},
            }
            changed = True
            summary_lines.append("Emitted one synthetic change (fake mode).")
        return {"summary": "\n".join(summary_lines), "manifest": manifest,
                "changed": changed, "round_plan": None}


class AgentEvolver(Evolver):
    """Real single-role DSH evolve agent."""

    name = "agent"
    MANIFEST_NAME = "_ahe_change_manifest.json"
    PLAN_NAME = "_ahe_round_plan.json"

    def __init__(self, *, model: str = DEFAULT_EVOLVE_MODEL,
                 timeout_seconds: float = 3600):
        self.model = model
        self.timeout_seconds = timeout_seconds

    def apply(self, workspace, iteration, query_context):
        manifest_path = workspace / self.MANIFEST_NAME
        plan_path = workspace / self.PLAN_NAME
        manifest_path.unlink(missing_ok=True)
        plan_path.unlink(missing_ok=True)
        prompt = self._prompt(workspace, iteration, query_context)
        wrapper = (
            Path(__file__).resolve().parents[2] / "dcu_kernel_auto_opt"
            / "bridge" / "dsh" / "dsh_agent.py"
        )
        cmd = [
            str(wrapper), "-p", "--output-format", "stream-json",
            "--input-format", "text", "--verbose",
            "--permission-mode", "bypassPermissions",
            "--add-dir", str(workspace), "--model", self.model,
            "--effort", "max", "--tools", "Read,Glob,Grep,Write",
            "--disallowedTools", "Bash,Skill,WebFetch,WebSearch",
        ]
        try:
            proc = subprocess.run(
                cmd, input=prompt, text=True, capture_output=True,
                timeout=self.timeout_seconds, env=os.environ.copy(),
            )
        except subprocess.TimeoutExpired:
            # A slow/failed evolve turn must not abort the whole experiment:
            # the iteration's evaluation value is already recorded, so fall
            # back to a no-change placeholder and let the pipeline finish
            # (champion kept, report + finished still written).
            return _evolve_failed(
                iteration,
                f"evolve agent timed out after {self.timeout_seconds:.0f}s",
            )
        except Exception as exc:  # noqa: BLE001 - never crash the outer loop
            return _evolve_failed(
                iteration, f"evolve agent crashed: {exc!r}"
            )
        if proc.returncode != 0:
            return _evolve_failed(
                iteration,
                f"evolve agent failed rc={proc.returncode}: "
                f"{(proc.stderr or '')[-800:]}",
            )
        manifest = _read_json(manifest_path)
        plan = _read_json(plan_path)
        missing = [
            name for name, value in
            ((self.MANIFEST_NAME, manifest), (self.PLAN_NAME, plan))
            if value is None
        ]
        if missing:
            return _evolve_failed(
                iteration,
                "evolve agent did not write " + ", ".join(missing),
            )
        manifest_path.unlink(missing_ok=True)
        plan_path.unlink(missing_ok=True)
        summary = _last_result(proc.stdout) or "Evolve Agent completed."
        return {"summary": summary, "manifest": manifest, "round_plan": plan,
                "changed": bool(manifest.get("changes"))}

    def _prompt(self, workspace: Path, iteration: int,
                context: Dict[str, Any]) -> str:
        pool_ids = list(context.get("pool_ids") or [])
        selected = list(context.get("selected") or [])
        return f"""You are the SINGLE AHE Evolve Agent for DKAO INT8 W8A8 GEMM.

Iteration: {iteration}
Harness workspace (the ONLY directory you may modify): {workspace}
Analysis overview: {context.get('overview')}
Previous results/diff are embedded below.

Current selected questions: {json.dumps(selected)}
Registered pool ids (you may select ONLY these): {json.dumps(pool_ids)}
Results: {json.dumps(context.get('results') or {}, ensure_ascii=False)[:16000]}
Diff: {json.dumps(context.get('diff') or {}, ensure_ascii=False)}
Decision: {json.dumps(context.get('decision') or {}, ensure_ascii=False)[:8000]}

Your two responsibilities in this ONE role:
1) Evidence-driven harness evolution: inspect workspace, make at most ONE logical
   change to planner/gates/prompt/skill/memory; do not touch model config. Every
   change needs failure_evidence, root_cause, targeted_fix, system_prediction,
   scope (expected_improve/unchanged/at_risk/routeable), mechanism_signature.
2) Choose the NEXT round exam from registered pool ids. Give strategy
   explore|exploit|balanced, rationale and selected ids. The machine assigns
   each question a role (2 regression anchors / 1 repair / 1 cross-family
   probe) and enforces pool membership, budget, family quota and >=60%
   overlap: your picks are used where they fit a role and replaced where they
   do not (the correction is recorded in the round rationale). Weights are
   ignored — priority comes from the role, and the probe never counts toward
   the pass-rate decision.

Mechanism evidence (machine-checkable, not prose): every change MUST also
carry a structured `mechanism_check` describing how a robot can verify that the
mechanism actually ran. Allowed kinds:
  {{"kind": "planner_plan_ids", "expect_any": ["memory_layout", "epilogue_fusion"],
   "expect_order": ["architecture_explore", "memory_layout"]}}
  {{"kind": "harness_revision"}}   # candidate revision must be the one children load
  {{"kind": "gate_events", "expect_any": ["gate_blocked"]}}
  {{"kind": "gate_values", "expect_any": ["round_acceptance_improvement_percent"]}}
Use planner_plan_ids when the change edits planner_policy/planner_catalog,
gate_values when it edits gates.yaml (the runtime reads that file now), and
gate_events for gating behaviour that shows up in the child timeline. A change without mechanism_check stays
"unobserved" (allowed, but it cannot be verified as effective).

Write strict JSON files INSIDE workspace:
- {manifest_path_for_prompt(workspace, self.MANIFEST_NAME)}
  {{"schema_version":1,"iteration":{iteration},"changes":[...],
    "verification":{{"status":"pending","fixes":[],"regressions":[],
    "false_predictions":[],"verdict":null}}}}
- {manifest_path_for_prompt(workspace, self.PLAN_NAME)}
  {{"iteration":{iteration},"strategy":"balanced","rationale":"...",
    "selected":[...],"weights":{{}}}}

Use file tools only. Do not compile, benchmark, run DKAO, edit outside workspace,
or invent pool ids. Finish after rereading both JSON files from disk.
"""


def manifest_path_for_prompt(workspace: Path, name: str) -> str:
    return str(workspace / name)


def _evolve_failed(iteration: int, reason: str) -> Dict[str, Any]:
    """No-change evolve placeholder used when the evolve turn fails.

    The outer loop keeps the iteration's evaluation result (champion
    unchanged) and still writes evolve artifacts + report, instead of
    crashing mid-experiment and losing the whole round.
    """
    manifest = {
        "schema_version": 1,
        "iteration": iteration,
        "changes": [],
        "verification": {
            "status": "evolve_failed", "fixes": [], "regressions": [],
            "false_predictions": [], "verdict": None,
        },
        "note": reason,
    }
    summary = (
        f"# Evolve summary — iteration {iteration} (failed)\n\n"
        f"{reason}\n\nNo harness change was applied; "
        "the champion is unchanged."
    )
    return {"summary": summary, "manifest": manifest, "round_plan": None,
            "changed": False}


def _read_json(path: Path) -> Optional[Dict[str, Any]]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _last_result(stdout: str) -> str:
    result = ""
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get("type") == "result":
            result = str(event.get("result") or "")
    return result


def build_evolver(mode: str, *, model: str = DEFAULT_EVOLVE_MODEL,
                  timeout_seconds: float = 3600) -> Evolver:
    if mode == "agent":
        return AgentEvolver(model=model, timeout_seconds=timeout_seconds)
    return DryRunEvolver()
