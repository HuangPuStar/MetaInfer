"""Mechanism gate: evidence grading + lenient/strict decision behaviour."""

from __future__ import annotations

import json
from pathlib import Path

from metainfer.tasks.harness_evolve.orchestrator.decision_engine import (
    DecisionPolicy, decide,
)
from metainfer.tasks.harness_evolve.orchestrator.mechanism_checks import (
    collect_candidate_evidence, evaluate_changes,
)

WIN = {"a": {"passed": True, "median_us": 100.0, "correctness_ok": True,
             "new_best_known": True},
       "b": {"passed": True, "median_us": 100.0, "correctness_ok": True,
             "new_best_known": True}}
CAND = {"a": {"passed": True, "median_us": 50.0, "correctness_ok": True},
        "b": {"passed": True, "median_us": 50.0, "correctness_ok": True}}


def _manifest(check=None, change_id="chg-1"):
    change = {"id": change_id, "component": "planner_policy",
              "mechanism_signature": ["fallback.m16 contains epilogue_fusion"]}
    if check is not None:
        change["mechanism_check"] = check
    return {"schema_version": 1, "iteration": 1, "changes": [change],
            "verification": {"status": "pending"}}


# ---------------------------------------------------------------- grader ----

def test_plan_ids_hit_partial_and_contradiction():
    check = {"kind": "planner_plan_ids",
             "expect_any": ["memory_layout", "epilogue_fusion"]}
    hit = {"planner_plan_ids": ["architecture_explore", "memory_layout"],
           "planner_enabled": True}
    part = {"planner_plan_ids": ["architecture_explore", "grid_splitk"],
            "planner_enabled": True}
    contra = {"planner_plan_ids": [], "planner_enabled": False}
    unob = {"planner_plan_ids": [], "planner_enabled": True}

    assert evaluate_changes(_manifest(check), hit)[0]["chg-1"] == "hit"
    assert evaluate_changes(_manifest(check), part)[0]["chg-1"] == "partial"
    assert evaluate_changes(_manifest(check), contra)[0]["chg-1"] == "contradicted"
    assert evaluate_changes(_manifest(check), unob)[0]["chg-1"] == "unobserved"


def test_expected_plan_order_hit():
    check = {"kind": "planner_plan_ids",
             "expect_order": ["architecture_explore", "memory_layout"]}
    ev = {"planner_plan_ids": ["architecture_explore", "grid_splitk",
                               "memory_layout"],
          "planner_enabled": True}
    assert evaluate_changes(_manifest(check), ev)[0]["chg-1"] == "hit"


def test_harness_revision_grading():
    check = {"kind": "harness_revision"}
    ok = {"candidate_harness_revision": "rev2",
          "observed_harness_revisions": ["rev2"]}
    wrong = {"candidate_harness_revision": "rev2",
             "observed_harness_revisions": ["rev1"]}
    none = {"candidate_harness_revision": "rev2",
            "observed_harness_revisions": []}
    assert evaluate_changes(_manifest(check), ok)[0]["chg-1"] == "hit"
    assert evaluate_changes(_manifest(check), wrong)[0]["chg-1"] == "contradicted"
    assert evaluate_changes(_manifest(check), none)[0]["chg-1"] == "unobserved"


def test_agent_only_plan_ids_are_soft_evidence():
    """Without a planner record, matching ids are only partial evidence."""
    check = {"kind": "planner_plan_ids", "expect_any": ["memory_layout"]}
    ev = {"agent_plan_ids": ["memory_layout"], "planner_enabled": True}
    checks, detail = evaluate_changes(_manifest(check), ev)
    assert checks["chg-1"] == "partial"
    assert "agent" in detail["changes"][0]["reason"]


def test_missing_check_stays_unobserved():
    checks, detail = evaluate_changes(_manifest(None), {"plan_ids": []})
    assert checks["chg-1"] == "unobserved"
    assert "mechanism_check" in detail["changes"][0]["reason"]


def test_evidence_collection_reads_children(tmp_path):
    exp = tmp_path / "exp"
    ws = exp / "children" / "iteration_001" / "shapeA" / "workspace"
    runs = ws / "workers" / "worker_0" / "runs" / "shapeA"
    runs.mkdir(parents=True)
    (runs / "experiments.jsonl").write_text(
        json.dumps({"iteration": 1, "plan_id": "memory_layout"}) + "\n"
        + json.dumps({"iteration": 2, "plan_id": "epilogue_fusion"}) + "\n",
        encoding="utf-8")
    (ws / "main").mkdir(parents=True)
    (ws / "main" / "scaffold_manifest.json").write_text(
        json.dumps({"harness": {"revision": "rev-cand"}}), encoding="utf-8")
    tl = exp / "children" / "iteration_001" / "shapeA" / "state"
    tl.mkdir(parents=True)
    (tl / "timeline.jsonl").write_text(
        json.dumps({"ts": 1.0, "type": "gate_blocked", "payload": {}}) + "\n",
        encoding="utf-8")
    snap = exp / "runs" / "iteration_001" / "input" / "workspace"
    snap.mkdir(parents=True)
    (snap / "manifest.yaml").write_text("revision: rev-cand\n", encoding="utf-8")

    (ws / "workers" / "worker_0" / "planner_plans.jsonl").write_text(
        json.dumps({"iteration": 1, "plan_id": "memory_layout",
                    "source": "planner"}) + "\n", encoding="utf-8")

    ev = collect_candidate_evidence(exp, 1, planner_enabled=True)
    assert ev["agent_plan_ids"] == ["memory_layout", "epilogue_fusion"]
    assert ev["planner_plan_ids"] == ["memory_layout"]
    assert ev["plan_id_source"] == "planner"
    assert ev["observed_harness_revisions"] == ["rev-cand"]
    assert ev["candidate_harness_revision"] == "rev-cand"
    assert "gate_blocked" in ev["gate_events"]


# --------------------------------------------------------------- decision ----

def test_lenient_promotes_unobserved_win():
    d = decide(WIN, CAND, manifest=_manifest({"kind": "planner_plan_ids",
                                              "expect_any": ["memory_layout"]}),
               mechanism_checks={"chg-1": "unobserved"},
               policy=DecisionPolicy(mechanism_policy="lenient"))
    assert d["verdict"] == "PROMOTE_UNEXPLAINED"
    assert d["action"] == "SET_CHAMPION"
    assert d["mechanism_gate"]["status"] == "UNOBSERVED"


def test_lenient_still_confirms_on_contradiction():
    d = decide(WIN, CAND, manifest=_manifest({"kind": "planner_plan_ids",
                                              "expect_any": ["memory_layout"]}),
               mechanism_checks={"chg-1": "contradicted"},
               policy=DecisionPolicy(mechanism_policy="lenient"))
    assert d["verdict"] == "CONFIRM_REQUIRED"
    assert d["mechanism_gate"]["contradicted"] == ["chg-1"]


def test_contradiction_promotes_after_reproduction():
    d = decide(WIN, CAND, manifest=_manifest({"kind": "harness_revision"}),
               mechanism_checks={"chg-1": "contradicted"},
               confirmation_reproduced=True,
               policy=DecisionPolicy(mechanism_policy="lenient"))
    assert d["verdict"] == "PROMOTE_UNEXPLAINED"


def test_hit_promotes_and_strict_policy_confirms_unobserved():
    hit = decide(WIN, CAND, manifest=_manifest({"kind": "harness_revision"}),
                 mechanism_checks={"chg-1": "hit"},
                 policy=DecisionPolicy(mechanism_policy="lenient"))
    assert hit["verdict"] == "PROMOTE"
    strict = decide(WIN, CAND,
                    manifest=_manifest({"kind": "harness_revision"}),
                    mechanism_checks={"chg-1": "unobserved"},
                    policy=DecisionPolicy(mechanism_policy="strict"))
    assert strict["verdict"] == "CONFIRM_REQUIRED"


def test_off_policy_ignores_mechanism():
    d = decide(WIN, CAND, manifest=_manifest({"kind": "harness_revision"}),
               mechanism_checks={"chg-1": "contradicted"},
               policy=DecisionPolicy(mechanism_policy="off"))
    assert d["verdict"] == "PROMOTE_UNEXPLAINED"


# ------------------------------------------------------- generalization ----

def test_probe_regression_blocks_promotion():
    """A win in the tuned families must not promote if an untouched one broke."""
    champ = {"a": {"passed": True, "median_us": 100.0, "correctness_ok": True},
             "b": {"passed": True, "median_us": 100.0, "correctness_ok": True},
             "p": {"passed": True, "median_us": 100.0, "correctness_ok": True}}
    cand = {"a": {"passed": True, "median_us": 50.0, "correctness_ok": True},
            "b": {"passed": True, "median_us": 50.0, "correctness_ok": True},
            "p": {"passed": True, "median_us": 300.0, "correctness_ok": True}}
    purposes = {"a": "regression", "b": "repair", "p": "probe"}
    d = decide(champ, cand, purposes=purposes)
    assert d["generalization_gate"]["status"] == "FAIL"
    assert d["verdict"] == "CONFIRM_REQUIRED"
    assert "over-fitting" in d["reason"]
    # the probe is not part of the paired decision set
    assert "p" not in d["paired_ids"] and d["probe_ids"] == ["p"]
    # reproduces -> allowed through, still recorded
    d2 = decide(champ, cand, purposes=purposes, confirmation_reproduced=True)
    assert d2["verdict"] == "PROMOTE_UNEXPLAINED"
    assert d2["generalization_gate"]["status"] == "FAIL"


def test_probe_pass_allows_normal_promotion():
    champ = {"a": {"passed": True, "median_us": 100.0, "correctness_ok": True},
             "b": {"passed": True, "median_us": 100.0, "correctness_ok": True},
             "p": {"passed": True, "median_us": 100.0, "correctness_ok": True}}
    cand = {"a": {"passed": True, "median_us": 50.0, "correctness_ok": True},
            "b": {"passed": True, "median_us": 50.0, "correctness_ok": True},
            "p": {"passed": True, "median_us": 98.0, "correctness_ok": True}}
    d = decide(champ, cand,
               purposes={"a": "regression", "b": "repair", "p": "probe"})
    assert d["generalization_gate"]["status"] == "PASS"
    assert d["verdict"] == "PROMOTE_UNEXPLAINED"   # lenient default
    assert d["purpose_breakdown"]["p"]["counted"] is False


# ------------------------------------------------------- gate_values ------

def _gate_change(paths=("round_acceptance_improvement_percent",)):
    return _manifest({"kind": "gate_values", "expect_any": list(paths)})


def test_gate_values_hit_when_children_ran_with_declared_values():
    ev = {
        "candidate_gates": {"wired": True,
                            "gates": {"round_acceptance_improvement_percent": 2.5}},
        "observed_gates": [
            {"gates": {"round_acceptance_improvement_percent": 2.5}},
        ],
    }
    checks, detail = evaluate_changes(_gate_change(), ev)
    assert checks["chg-1"] == "hit"
    assert "declared values" in detail["changes"][0]["reason"]


def test_gate_values_contradicted_when_values_differ():
    ev = {
        "candidate_gates": {"wired": True,
                            "gates": {"round_acceptance_improvement_percent": 2.5}},
        "observed_gates": [
            {"gates": {"round_acceptance_improvement_percent": 1.0}},
        ],
    }
    checks, _ = evaluate_changes(_gate_change(), ev)
    assert checks["chg-1"] == "contradicted"


def test_gate_values_contradicted_when_component_is_unwired():
    ev = {"candidate_gates": {"wired": False, "gates": {}},
          "observed_gates": [{"gates": {}}]}
    checks, detail = evaluate_changes(_gate_change(), ev)
    assert checks["chg-1"] == "contradicted"
    assert "not wired" in detail["changes"][0]["reason"]


def test_gate_values_unobserved_without_snapshot():
    ev = {"candidate_gates": {"wired": True, "gates": {}}, "observed_gates": []}
    checks, _ = evaluate_changes(_gate_change(), ev)
    assert checks["chg-1"] == "unobserved"


# ------------------------------------------------- invalid / inconclusive ----

def test_missing_measurement_is_invalid_not_hard_fail():
    """A crashed child must not look like a performance regression."""
    champ = {"a": {"passed": True, "median_us": 100.0, "correctness_ok": True},
             "b": {"passed": True, "median_us": 100.0, "correctness_ok": True}}
    cand = {"a": {"passed": False, "median_us": None, "correctness_ok": False,
                  "status": "missing_report"},
            "b": {"passed": True, "median_us": 90.0, "correctness_ok": True}}
    d = decide(champ, cand)
    assert d["performance_gate"]["counts"]["INVALID"] == 1
    assert d["performance_gate"]["counts"]["HARD_FAIL"] == 0


def test_mostly_unmeasurable_round_is_inconclusive():
    champ = {k: {"passed": True, "median_us": 100.0, "correctness_ok": True}
             for k in "abcd"}
    cand = {
        "a": {"passed": False, "median_us": None, "status": "missing_report"},
        "b": {"passed": False, "median_us": None, "status": "missing_report"},
        "c": {"passed": False, "median_us": None, "status": "missing_report"},
        "d": {"passed": True, "median_us": 100.0, "correctness_ok": True},
    }
    d = decide(champ, cand)
    assert d["verdict"] == "INCONCLUSIVE"
    assert d["action"] == "KEEP_CHAMPION_ARCHIVE_CANDIDATE"
    assert d["performance_gate"]["status"] == "INCONCLUSIVE"
    assert "no verdict" in d["reason"]


def test_measurable_regression_still_rejects():
    """Sanity: a genuine, fully measured regression still rejects.

    Two losses are required: ``max_loss_ratio`` deliberately tolerates a single
    losing question so one noisy shape cannot trigger a rollback.
    """
    champ = {k: {"passed": True, "median_us": 100.0, "correctness_ok": True}
             for k in ("a", "b")}
    cand = {k: {"passed": True, "median_us": 300.0, "correctness_ok": True}
            for k in ("a", "b")}
    d = decide(champ, cand)
    assert d["verdict"] == "REJECT"
    assert d["performance_gate"]["counts"]["LOSS"] == 2
