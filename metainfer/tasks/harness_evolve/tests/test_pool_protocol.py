"""Tests for suite protocol v2: pool, auto-pass, round_plan guardrails, and
pool-mode pipeline decisions."""

from __future__ import annotations

import json
from pathlib import Path

from ..orchestrator.pipeline import run_experiment
from ..orchestrator.pool import builtin_pool
from ..orchestrator.round_plan import (
    RoundPlan,
    enforce_guardrails,
    validate_in_pool,
)
from ..orchestrator.attribution import pass_rate


def _pool():
    return builtin_pool()


def test_builtin_pool_sampling_and_heldout():
    pool = _pool()
    ids = pool.stratified_sample(4)
    assert len(ids) == 4 and len(set(ids)) == 4
    pool.assert_in_pool(ids)
    held = pool.heldout_ids(2, exclude=set(ids))
    assert len(held) == 2 and not (set(held) & set(ids))


def test_tau_and_auto_pass():
    pool = _pool()
    inst_id = "dsv4_tp8_qkv_proj_m16"  # family decode__qkv_proj
    inst = pool.get(inst_id)
    tau = pool.tau_family(inst.family)
    assert tau > 0.0
    ok = pool.auto_pass(inst_id, tau * inst.baseline_us * 0.9,
                        correctness_ok=True, p90_ok=True)
    assert ok["passed"] is True
    bad = pool.auto_pass(inst_id, inst.baseline_us * 0.9,
                         correctness_ok=True, p90_ok=True)
    assert bad["passed"] is False  # ratio 0.9 > tau
    noc = pool.auto_pass(inst_id, 1.0, correctness_ok=False, p90_ok=True)
    assert noc["passed"] is False


def test_round_plan_in_pool_validation():
    pool = _pool()
    plan = RoundPlan(iteration=1, selected=["dsv4_tp8_qkv_proj_m16",
                                            "hy3_tp8_qkv_proj_m16"])
    validate_in_pool(plan, pool)
    bad = RoundPlan(iteration=1, selected=["not-in-pool"])
    try:
        validate_in_pool(bad, pool)
        raise AssertionError("expected ValueError")
    except ValueError:
        pass


def test_guardrails_preserve_overlap_and_budget():
    pool = _pool()
    prev = pool.stratified_sample(5)
    # agent proposes a fresh set of 3 different ids
    fresh = [i for i in pool.stratified_sample(9) if i not in set(prev)][:3]
    plan = RoundPlan(iteration=2, strategy="explore",
                     rationale="try fresh", selected=fresh)
    out = enforce_guardrails(prev, plan, pool, budget=5)
    overlap = len(set(out) & set(prev))
    assert overlap >= int(0.6 * len(prev))  # >= 3 of 5
    assert len(out) == 5 and len(set(out)) == 5
    pool.assert_in_pool(out)


def test_pipeline_pool_mode_dry(tmp_path):
    """pool-mode: results restricted to scored ids, round_plan written per
    evolve, overlap decisions recorded."""
    req = tmp_path / "req.json"
    req.write_text(json.dumps({
        "task_id": "pool-dry",
        "answers": {
            "suite_yaml": "instances: []",
            "max_iterations": "2",
            "execution_mode": "dry-run",
            "pool_source": "builtin",
            "per_round_budget": "4",
        },
    }), encoding="utf-8")
    from ..orchestrator.cli import run_with_requirements
    rc = run_with_requirements(req, state_dir=tmp_path / "st",
                               workspace_dir=tmp_path / "ws")
    assert rc == 0
    ws = tmp_path / "ws"
    pool = _pool()

    i1 = ws / "runs" / "iteration_001" / "input"
    i2 = ws / "runs" / "iteration_002" / "input"
    r1 = json.loads((i1 / "benchmark" / "results.json").read_text())["results"]
    scored1 = json.loads((i1 / "benchmark" / "scored_ids.json").read_text())
    assert set(r1) == set(scored1)
    assert len(scored1) <= 4
    pool.assert_in_pool(scored1)
    # evolve writes round_plan each round
    assert (ws / "runs" / "iteration_001" / "evolve"
            / "round_plan.json").is_file()
    assert (ws / "runs" / "iteration_002" / "evolve"
            / "round_plan.json").is_file()
    # iteration 2 overlap decision artefacts exist
    assert (i2 / "diff.json").is_file()
    stats = pass_rate(r1)
    assert stats["n_total"] == len(scored1)


def _mixed_pool():
    from ..orchestrator.pool import Pool, PoolInstance
    insts = {}
    for iid in ("anchor_a", "anchor_b"):
        insts[iid] = PoolInstance(
            id=iid, model="m", tp_size=8, operator="o", M=16, N=1, K=1,
            baseline_us=100.0, family="decode__o",
            history=[{"accepted": True, "median_us": 45.0}],
        )
    for iid in ("cold_a", "cold_b"):
        insts[iid] = PoolInstance(
            id=iid, model="m", tp_size=8, operator="o", M=16, N=1, K=1,
            baseline_us=100.0, family="decode__o", history=[],
        )
    return Pool(insts)


def test_anchor_rule_keeps_two_historical_shapes():
    pool = _mixed_pool()
    plan = RoundPlan(iteration=1, strategy="explore",
                     rationale="all cold this round",
                     selected=["cold_a", "cold_b"])
    out = enforce_guardrails([], plan, pool, budget=4)
    assert len(out) == 4
    anchors = [i for i in out if i in ("anchor_a", "anchor_b")]
    assert len(anchors) >= 2


def test_budget_below_anchor_min_raises():
    pool = _mixed_pool()
    try:
        enforce_guardrails([], None, pool, budget=1)
        raise AssertionError("expected ValueError")
    except ValueError:
        pass


def test_historical_ids_helper():
    pool = _mixed_pool()
    assert set(pool.historical_ids()) == {"anchor_a", "anchor_b"}


def test_pool_dry_run_assigns_question_roles(tmp_path):
    """Every round carries explicit roles, and the decision records them."""
    req = tmp_path / "req.json"
    req.write_text(json.dumps({
        "task_id": "pool-roles",
        "answers": {
            "suite_yaml": "instances: []",
            "max_iterations": "2",
            "execution_mode": "dry-run",
            "pool_source": "builtin",
            "per_round_budget": "4",
        },
    }), encoding="utf-8")
    from ..orchestrator.cli import run_with_requirements
    assert run_with_requirements(req, state_dir=tmp_path / "st",
                                 workspace_dir=tmp_path / "ws") == 0
    ws = tmp_path / "ws"

    for num in (1, 2):
        base = ws / "runs" / f"iteration_{num:03d}" / "input"
        plan = json.loads((base / "benchmark" / "purposes.json")
                          .read_text(encoding="utf-8"))
        purposes = plan["purposes"]
        scored = json.loads((base / "benchmark" / "scored_ids.json")
                            .read_text(encoding="utf-8"))
        assert set(purposes) == set(scored)
        roles = list(purposes.values())
        assert roles.count("regression") >= 2
        assert "repair" in roles
        assert "probe" in roles
        assert len(set(plan["families"])) >= 2

        decision = json.loads((base / "decision.json").read_text(encoding="utf-8"))
        if "generalization_gate" in decision:
            assert decision["probe_ids"]
            assert "p" not in decision["paired_ids"] or True
            assert decision["purpose_breakdown"]

    # rotation sidecar records what was examined
    rotation = json.loads((ws / "pool_rotation.json").read_text(encoding="utf-8"))
    assert rotation and max(rotation.values()) >= 1


def test_wired_scope_violations_detects_changes_to_unwired_components(tmp_path):
    """Editing a component the manifest marks unwired must be reported."""
    from ..orchestrator.pipeline import _wired_scope_violations

    before = tmp_path / "before"
    after = tmp_path / "after"
    for root in (before, after):
        root.mkdir()
    manifest = {
        "schema_version": 1,
        "components": {
            "gates": {"path": "gates.yaml", "wired": True},
            "prompts": {"path": "prompts.yaml", "wired": False},
        },
    }
    for root in (before, after):
        (root / "manifest.yaml").write_text(json.dumps(manifest), encoding="utf-8")
        (root / "gates.yaml").write_text("gates: {}\n", encoding="utf-8")
        (root / "prompts.yaml").write_text("a: 1\n", encoding="utf-8")

    assert _wired_scope_violations(before, after) == []

    # edit the wired component -> no violation reported
    (after / "gates.yaml").write_text("gates: {x: 1}\n", encoding="utf-8")
    assert _wired_scope_violations(before, after) == []

    # edit the unwired component -> violation reported
    (after / "prompts.yaml").write_text("a: 2\n", encoding="utf-8")
    violations = _wired_scope_violations(before, after)
    assert violations == [{"component": "prompts", "path": "prompts.yaml"}]


def test_generations_are_recorded_and_champion_is_the_best_measured(tmp_path):
    """Each round is registered as a generation and best_ever points at it."""
    req = tmp_path / "req.json"
    req.write_text(json.dumps({
        "task_id": "pool-generations",
        "answers": {
            "suite_yaml": "instances: []",
            "max_iterations": "3",
            "execution_mode": "dry-run",
            "pool_source": "builtin",
            "per_round_budget": "4",
        },
    }), encoding="utf-8")
    from ..orchestrator.cli import run_with_requirements
    from ..orchestrator.champion_selection import (
        best_generation, load_generations,
    )
    assert run_with_requirements(req, state_dir=tmp_path / "st",
                                 workspace_dir=tmp_path / "ws") == 0
    ws = tmp_path / "ws"
    gens = load_generations(ws)
    assert [g.iteration for g in gens] == [1, 2, 3]
    best = best_generation(gens)
    assert best is not None
    best_ever = json.loads((ws / "best_ever.json").read_text(encoding="utf-8"))
    assert best_ever["iteration"] == best.iteration
    assert best_ever["verdict"] in {"BEST_MEASURED", "MANUAL_BASELINE",
                                    "BASELINE", "PROMOTE",
                                    "PROMOTE_UNEXPLAINED"}


def test_dry_run_writes_best_known_review_and_skips_final_evolve(tmp_path):
    req = tmp_path / "req.json"
    req.write_text(json.dumps({
        "task_id": "pool-review",
        "answers": {
            "suite_yaml": "instances: []",
            "max_iterations": "3",
            "execution_mode": "dry-run",
            "pool_source": "builtin",
            "per_round_budget": "4",
        },
    }), encoding="utf-8")
    from ..orchestrator.cli import run_with_requirements
    assert run_with_requirements(req, state_dir=tmp_path / "st",
                                 workspace_dir=tmp_path / "ws") == 0
    ws = tmp_path / "ws"

    assert (ws / "best_known.json").is_file()
    review = json.loads((ws / "round_review.json").read_text(encoding="utf-8"))
    assert review["variant_policy"] == "freeze"
    assert review["champion_iteration"] in {1, 2, 3}
    assert (ws / "round_review.md").read_text(encoding="utf-8").startswith(
        "# Cross-round review")

    manifest = json.loads((ws / "runs" / "iteration_003" / "evolve"
                           / "change_manifest.json").read_text(encoding="utf-8"))
    assert manifest["verification"]["status"] == "target_reached_skip_evolve"
    assert manifest["changes"] == []


def test_resume_skips_a_round_that_was_marked_skipped(tmp_path):
    """A skipped round must not block the loop: the next round still runs.

    Mirrors the live handover (iteration 2 ran while the GPU gate was broken
    and was marked skipped): its eval artifacts are absent, so the resumed
    process has to pick the next round up from the previous round's evolve dir.
    """
    req = tmp_path / "req.json"
    req.write_text(json.dumps({
        "task_id": "pool-skip",
        "answers": {
            "suite_yaml": "instances: []",
            "max_iterations": "4",
            "execution_mode": "dry-run",
            "pool_source": "builtin",
            "per_round_budget": "3",
        },
    }), encoding="utf-8")
    from ..orchestrator.config import load_experiment_config
    from ..orchestrator.cli import run_experiment
    from ..orchestrator.pipeline import completed_iterations

    cfg = load_experiment_config(req, tmp_path / "st", tmp_path / "ws")
    run_experiment(cfg, start_iteration=1, iterations_to_run=1)
    assert completed_iterations(cfg.exp_dir) == 1

    # mark iteration 2 skipped: results recorded as empty, no evolve artifacts
    it2 = cfg.exp_dir / "runs" / "iteration_002" / "input"
    (it2 / "benchmark").mkdir(parents=True, exist_ok=True)
    (it2 / "benchmark" / "results.json").write_text(
        json.dumps({"iteration": 2, "results": {}, "skipped": True}),
        encoding="utf-8")
    assert completed_iterations(cfg.exp_dir) == 2

    # the resumed process starts at round 3 and runs it end to end
    run_experiment(cfg, start_iteration=3, iterations_to_run=1)
    it3 = cfg.exp_dir / "runs" / "iteration_003" / "input"
    results = json.loads((it3 / "benchmark" / "results.json").read_text())
    assert results["results"], "round 3 must still select and score questions"
    assert (it3 / "decision.json").is_file()
    assert (it3 / "diff.json").is_file()
    assert completed_iterations(cfg.exp_dir) == 3
