"""End-to-end: a round judged against variants, then a human-approved promotion.

Covers the operator's protocol: round 1 defines the generalization paper, the
performance gate uses fresh operators, both gates compare against the current
variant, a passing candidate waits for a human, and approval publishes the
harness and moves the variants.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml

from ..orchestrator import pipeline as pl
from ..orchestrator import rounds as R
from ..orchestrator import variant as V
from ..orchestrator import promotion as promo
from ..orchestrator.config import load_experiment_config


class FakeEvaluator:
    """Deterministic measurements: ``medians`` maps operator id -> us.

    ``medians`` may also be a callable ``(iteration, stage) -> {id: median}``, so
    a test can make the generalization retake measure differently from the
    baseline round that fixed the paper — that is the only way to say anything
    about what an approval publishes.
    """

    name = "fake"

    def __init__(self, medians):
        self.medians = medians
        self.calls = []
        self.stages = []

    def evaluate(self, cfg, workspace, iteration, instances=None):
        medians = self.medians
        stage = str((getattr(cfg, "answers", None) or {}).get("round_stage") or "")
        if callable(medians):
            medians = medians(iteration, stage)
        self.stages.append((iteration, stage))
        out = {}
        for inst in (instances or []):
            iid = inst.id
            self.calls.append(iid)
            median = medians.get(iid)
            if median is None:
                out[iid] = {"status": "missing_report", "passed": False,
                            "correctness_ok": False, "median_us": None}
                continue
            out[iid] = {"status": "success", "passed": True,
                        "correctness_ok": True, "p90_ok": True,
                        "median_us": float(median), "p90_us": float(median),
                        "repo_path": f"/repos/{iid}"}
        return out


def _write_pool(tmp_path: Path, ops: dict) -> Path:
    path = tmp_path / "pool.yaml"
    path.write_text(yaml.safe_dump({
        "schema_version": 1,
        "instances": [
            {"id": iid, "family": f"fam{i}",
             "contract": {"model": "m", "tp_size": 8, "operator": "o",
                          "M": 16, "N": 64, "K": 32},
             "baseline_us": values["baseline"], "best_known_us": values["variant"],
             "history": []}
            for i, (iid, values) in enumerate(sorted(ops.items()))
        ],
    }, sort_keys=False), encoding="utf-8")
    return path


def _cfg(tmp_path: Path, pool: Path, **answers):
    req = tmp_path / "requirements.json"
    req.write_text(json.dumps({
        "task_id": "variant-e2e",
        "answers": {
            "suite_yaml": "instances: []",
            "execution_mode": "dry-run",
            "evolve_mode": "dry-run",
            "pool_source": str(pool),
            "question_pool": str(pool),
            "round_questions": "variant",
            "per_round_budget": "3",
            "max_iterations": "4",
            "max_rounds": "3",
            **answers,
        },
    }), encoding="utf-8")
    return load_experiment_config(req, tmp_path / "state", tmp_path / "ws")


def _patch(monkeypatch, tmp_path, evaluator, prod_dir):
    # A real DKAO child leaves its optimized workspace behind; the kernel
    # promotion path reads exactly that directory, so the fake evaluator
    # materializes one per question it measured.
    original = evaluator.evaluate
    measured: dict = {}

    def evaluate(cfg, workspace, iteration, instances=None):
        results = original(cfg, workspace, iteration, instances=instances)
        from ..orchestrator.rounds import CHILDREN_DIR, stage_dir_name
        stage = pl.round_stage(
            iteration=iteration,
            pending=pl.read_pending_generalization(cfg.exp_dir))
        override = cfg.answers.pop("_attempt_dir", None)
        for iid, row in results.items():
            measured[str(iid)] = row
            child = (cfg.exp_dir / CHILDREN_DIR
                     / (override or stage_dir_name(stage, iteration))
                     / str(iid) / "workspace")
            child.mkdir(parents=True, exist_ok=True)
            (child / "manifest.yaml").write_text(
                f"harness_name: candidate-{iid}\n", encoding="utf-8")
        return results

    evaluator.evaluate = evaluate
    # The real child writes an accepted-kernel manifest inside that workspace;
    # the fake does not, so the DKAO-side promotion is stubbed at its boundary.
    # Everything the parent does around it (best-known wins on the pool file,
    # backups, history rows, audit log) stays real.
    from metainfer.tasks.dcu_kernel_auto_opt.orchestrator import variant_promote

    def promote_variant(*, workspace_dir, answers, shape_id, source_task="",
                        correctness_ok=None, min_improvement_percent=0.0,
                        tp=None, m=None, model_label=None, dry_run=False,
                        **kwargs):
        # A real child only has an accepted kernel in the workspace that ran.
        # Reading the manifest keeps this stub honest: pointing it at a
        # directory that never produced a kernel fails, like DKAO would.
        try:
            manifest = (Path(workspace_dir) / "manifest.yaml").read_text(
                encoding="utf-8")
        except OSError:
            manifest = ""
        if "failed-attempt" in manifest:
            return {"ok": False, "action": "no_kernel", "shape": shape_id,
                    "reason": f"no accepted kernel under {workspace_dir}"}
        row = measured.get(str(shape_id)) or {}
        action = "would-add" if dry_run else "added"
        return {"ok": True, "action": action, "shape": shape_id,
                "new_median_us": row.get("median_us"),
                "old_median_us": None, "path": f"/variants/{shape_id}"}

    monkeypatch.setattr(variant_promote, "promote_variant", promote_variant)
    monkeypatch.setattr(pl, "build_evaluator", lambda mode: evaluator)
    monkeypatch.setattr(promo, "_production_dir", lambda: prod_dir)
    monkeypatch.setattr(pl, "_head_revision", lambda ws: "rev-candidate")


def _steady(ops, share=0.5):
    """A harness that keeps finding the *same* faster kernel every time.

    The gate compares a measurement with the variant; a tie inside the
    comparison's noise band is ``NO_SIGNAL``, not a win, so a redrawn operator
    set needs to be genuinely better than what the last round recorded. Tests
    that want an unqualified win therefore improve on each round's own result.
    """
    def medians(iteration, stage):
        # Only the baseline round's operators are in the variant pool before
        # the draw, so a draw's variant is still the original one.
        return {iid: values["variant"] * share
                for iid, values in ops.items()}
    return medians


def _ops(n=10, variant=40.0):
    return {f"op{i:02d}": {"baseline": 100.0 + i, "variant": variant + 4 * i}
            for i in range(n)}


def test_failed_performance_gate_rolls_back_and_keeps_iterating(tmp_path, monkeypatch):
    """Round 1 judges nothing; the performance gate is what rejects."""
    pool_path = _write_pool(tmp_path, _ops())
    cfg = _cfg(tmp_path, pool_path)
    prod = tmp_path / "production"
    prod.mkdir()
    (prod / "manifest.yaml").write_text("harness_name: seed\n", encoding="utf-8")

    # every operator is far slower than its variant
    evaluator = FakeEvaluator({iid: 400.0 for iid in _ops()})
    _patch(monkeypatch, tmp_path, evaluator, prod)

    pl.run_experiment(cfg, start_iteration=1, iterations_to_run=1)

    it1 = cfg.exp_dir / "runs" / "iteration_001" / "input"
    # round 1 is the baseline round: no gate is written at all
    assert not (it1 / "performance_gate.json").exists()
    assert not (it1 / "generalization_gate.json").exists()
    first = json.loads((it1 / "decision.json").read_text())
    assert first["stage"] == "baseline"
    assert first["verdict"] == "BASELINE_MEASURED"
    assert (it1 / "baseline_round.json").is_file()

    # round 2 asks the same (still far too slow) evaluator for the performance
    # gate, which is the first thing that can actually fail
    it2 = cfg.exp_dir / "runs" / "iteration_002" / "input"
    perf = json.loads((it2 / "performance_gate.json").read_text())
    assert perf["status"] == "FAIL" and perf["wins"] == []
    assert not (it2 / "generalization_gate.json").exists()
    assert not (cfg.exp_dir / "pending_promotion.json").exists()
    assert not (cfg.exp_dir / "pending_generalization.json").exists()
    # the variant table did not move: a baseline round that beat nothing
    table = json.loads((cfg.exp_dir / "variant_table.json").read_text())
    assert table["harness_version"] in {None, "seed"}
    assert (it2 / "decision.json").is_file()


def test_a_retry_leaves_the_failed_attempt_beside_it_and_wins_the_resolution():
    """A retried question keeps both attempts, and the newest one is "the" one.

    The failed attempt's directory is evidence, so it must survive; the retry
    gets its own directory because DKAO binds a child workspace's ``main``
    symlink to the kernel repo it was launched with (reusing the directory makes
    the retry die instantly). Everything that reads "this question's child"
    -- the drill-down, the kernel promotion path -- must land on the retry.
    """
    import tempfile

    tmp = Path(tempfile.mkdtemp())
    ops = _ops()
    pool_path = _write_pool(tmp, ops)
    exp = tmp / "exp"
    exp.mkdir()
    operators = sorted(ops)[:2]

    def plant(attempt_dir: str, harness_name: str) -> None:
        for iid in operators:
            workspace = exp / "children" / attempt_dir / iid / "workspace"
            workspace.mkdir(parents=True, exist_ok=True)
            (workspace / "manifest.yaml").write_text(
                f"harness_name: {harness_name}\n", encoding="utf-8")

    plant("iteration_001", "failed-attempt")
    plant("iteration_001_a2", "retry-attempt")

    # both attempts are on disk, and both are attributable to the iteration
    names = {d.name for d in R.attempt_dirs(exp / "children", 1)}
    assert names == {"iteration_001", "iteration_001_a2"}
    assert R.attempt_dirs(exp / "children", 2) == []

    # the newest attempt is the question's child, for every reader
    for iid in operators:
        resolved = R.resolve_child_dir(exp / "children", 1, iid)
        assert resolved == exp / "children" / "iteration_001_a2" / iid
    assert R.child_dir_map(exp / "children", 1)[operators[0]] == (
        exp / "children" / "iteration_001_a2" / operators[0])

    # a question that only ever ran once still resolves to its single attempt
    only_once = exp / "children" / "iteration_001_a2" / "solo" / "workspace"
    only_once.mkdir(parents=True)
    assert R.resolve_child_dir(exp / "children", 1, "solo") == (
        exp / "children" / "iteration_001_a2" / "solo")
    assert R.resolve_child_dir(exp / "children", 1, "never-ran") is None


def test_round1_judges_no_gate_and_wins_do_not_promote_a_harness(tmp_path, monkeypatch):
    """A baseline round that beats every variant still promotes nothing."""
    ops = _ops()
    pool_path = _write_pool(tmp_path, ops)
    # exactly one round: the point here is round 1, and a second round is what
    # would schedule the generalization retake
    cfg = _cfg(tmp_path, pool_path, rounds="1")
    prod = tmp_path / "production"
    prod.mkdir()
    (prod / "manifest.yaml").write_text("harness_name: seed\n", encoding="utf-8")
    evaluator = FakeEvaluator({iid: values["variant"] * 0.5
                               for iid, values in ops.items()})
    _patch(monkeypatch, tmp_path, evaluator, prod)

    pl.run_experiment(cfg, start_iteration=1, iterations_to_run=1)

    it1 = cfg.exp_dir / "runs" / "iteration_001" / "input"
    baseline = json.loads((it1 / "baseline_round.json").read_text())
    assert baseline["verdict"]["status"] == "PASS"
    assert baseline["pool_promotion"]["promoted"], (
        "the baseline round's faster kernels must enter the variant pool")
    # no gate verdict, no pending promotion: only the kernels moved
    assert not (it1 / "performance_gate.json").exists()
    assert not (cfg.exp_dir / "pending_promotion.json").exists()
    assert yaml.safe_load((prod / "manifest.yaml").read_text())["harness_name"] == "seed"
    # the pool now holds the baseline round's numbers
    published = yaml.safe_load(pool_path.read_text(encoding="utf-8"))
    entries = {i["id"]: i for i in published["instances"]}
    for iid in baseline["pool_promotion"]["promoted"]:
        assert entries[iid]["best_known_us"] == pytest.approx(
            ops[iid]["variant"] * 0.5)


def test_the_retake_re_hands_the_paper_to_dkao_on_the_same_harness(
        tmp_path, monkeypatch):
    """The generalization gate is its own stage: same harness, A1 again."""
    ops = _ops()
    pool_path = _write_pool(tmp_path, ops)
    cfg = _cfg(tmp_path, pool_path)
    prod = tmp_path / "production"
    prod.mkdir()
    (prod / "manifest.yaml").write_text("harness_name: seed\n", encoding="utf-8")
    evaluator = FakeEvaluator({iid: values["variant"] * 0.5
                               for iid, values in ops.items()})
    _patch(monkeypatch, tmp_path, evaluator, prod)

    pl.run_experiment(cfg, start_iteration=1, iterations_to_run=4)

    paper = list(json.loads(
        (cfg.exp_dir / "variant_table.json").read_text()
    )["groups"]["generalization_ids"])
    assert len(paper) == 4

    it1 = cfg.exp_dir / "runs" / "iteration_001" / "input"
    it2 = cfg.exp_dir / "runs" / "iteration_002" / "input"

    # stage 1: the paper, judged by nothing
    assert json.loads((it1 / "decision.json").read_text())["stage"] == "baseline"
    assert sorted(json.loads((it1 / "benchmark" / "scored_ids.json").read_text())) \
        == sorted(paper)

    # stage 2: a fresh draw that never overlaps the paper, performance gate only
    a2 = json.loads((it2 / "benchmark" / "scored_ids.json").read_text())
    assert set(a2).isdisjoint(paper)
    perf = json.loads((it2 / "performance_gate.json").read_text())
    assert perf["status"] == "PASS"
    assert not (it2 / "generalization_gate.json").exists(), (
        "the paper must not be re-measured in the same pass as the draw")

    # stage 3: the retake — the SAME harness bytes, the paper's operators, sent
    # to DKAO again, and judged by the generalization gate
    it3 = cfg.exp_dir / "runs" / "iteration_003" / "input"
    retake = json.loads((it3 / "stage.json").read_text())
    assert retake["stage"] == "generalization"
    assert retake["retake_of_iteration"] == 2, (
        "the retake belongs to the round that won the performance gate")
    gen = json.loads((it3 / "generalization_gate.json").read_text())
    assert gen["status"] == "PASS"
    assert sorted(gen["operators"]) == sorted(paper)
    assert json.loads((it3 / "decision.json").read_text())["stage"] == \
        "generalization"
    # a fresh DKAO launch, in its own children directory, not the first pass's
    assert (cfg.exp_dir / "children" / "iteration_003_generalization").is_dir()
    assert (cfg.exp_dir / "children" / "iteration_002").is_dir(), (
        "the two stages never share a child directory")
    assert (cfg.exp_dir / "pending_promotion.json").is_file()
    run = json.loads((cfg.state_dir / "run.json").read_text())
    assert run["final_status"] == "awaiting_approval"
    assert run["rounds_used"] == pytest.approx(1.5), (
        "the baseline round is free; a performance pass is 1.0 and the "
        "generalization retake half a round")


def test_passing_rounds_wait_for_approval_then_promote(tmp_path, monkeypatch):
    ops = _ops()
    pool_path = _write_pool(tmp_path, ops)
    cfg = _cfg(tmp_path, pool_path)
    prod = tmp_path / "production"
    prod.mkdir()
    (prod / "manifest.yaml").write_text("harness_name: seed\n", encoding="utf-8")

    # half the variant on every operator: a wide win on both gates
    evaluator = FakeEvaluator({iid: values["variant"] * 0.5
                               for iid, values in ops.items()})
    _patch(monkeypatch, tmp_path, evaluator, prod)

    report = pl.run_experiment(cfg, start_iteration=1, iterations_to_run=4)
    assert report.is_file()

    it2 = cfg.exp_dir / "runs" / "iteration_002" / "input"
    perf = json.loads((it2 / "performance_gate.json").read_text())
    it3 = cfg.exp_dir / "runs" / "iteration_003" / "input"
    gen = json.loads((it3 / "generalization_gate.json").read_text())
    assert perf["status"] == "PASS" and gen["status"] == "PASS"
    assert set(perf["operators"]).isdisjoint(gen["operators"]), (
        "the performance draw and the paper are different operator sets")
    pending = json.loads((cfg.exp_dir / "pending_promotion.json").read_text())
    assert pending["version"] == "h-2"
    run = json.loads((cfg.state_dir / "run.json").read_text())
    assert run["final_status"] == "awaiting_approval"
    # nothing was written to production yet
    assert yaml.safe_load((prod / "manifest.yaml").read_text())["harness_name"] == "seed"

    # a human approves: the harness lands in production and variants move
    result = promo.approve_promotion(cfg, cfg.exp_dir, approved_by="tester")
    assert result["ok"] is True
    assert result["version"] == "h-2"
    assert not (cfg.exp_dir / "pending_promotion.json").exists()
    assert (prod / "manifest.yaml").is_file()
    assert (prod / "gates.yaml").is_file()
    promoted = json.loads((cfg.exp_dir / "promoted_harness.json").read_text())
    assert promoted["approved_by"] == "tester"
    assert Path(promoted["previous_backup"]).is_dir()

    table = json.loads((cfg.exp_dir / "variant_table.json").read_text())
    assert table["harness_version"] == "h-2"
    # the reference never drifts away from production: after approval, every
    # operator's recorded variant is the pool's own best-known kernel
    published = {i["id"]: i["best_known_us"]
                 for i in yaml.safe_load(pool_path.read_text())["instances"]}
    for iid, row in table["operators"].items():
        assert row["median_us"] == pytest.approx(published[iid]), (
            f"{iid}: the experiment's reference must match the pool's best-known")
    assert set(table["groups"]["generalization_ids"]) == set(gen["operators"])


def test_denied_candidate_is_discarded_without_touching_production(
        tmp_path, monkeypatch):
    ops = _ops()
    pool_path = _write_pool(tmp_path, ops)
    cfg = _cfg(tmp_path, pool_path, max_rounds="9")
    prod = tmp_path / "production"
    prod.mkdir()
    (prod / "manifest.yaml").write_text("harness_name: seed\n", encoding="utf-8")
    evaluator = FakeEvaluator({iid: values["variant"] * 0.5
                               for iid, values in ops.items()})
    _patch(monkeypatch, tmp_path, evaluator, prod)

    pl.run_experiment(cfg, start_iteration=1, iterations_to_run=4)
    assert (cfg.exp_dir / "pending_promotion.json").is_file()

    denied = promo.deny_promotion(cfg, cfg.exp_dir, reason="not convinced")
    assert denied["ok"] is True
    assert not (cfg.exp_dir / "pending_promotion.json").exists()
    assert not (cfg.exp_dir / "promoted_harness.json").exists()
    assert yaml.safe_load((prod / "manifest.yaml").read_text())["harness_name"] == "seed"
    table = json.loads((cfg.exp_dir / "variant_table.json").read_text())
    assert table["harness_version"] in {None, "seed"}


def test_rollback_restores_the_previous_production_tree(tmp_path, monkeypatch):
    pool_path = _write_pool(tmp_path, _ops())
    cfg = _cfg(tmp_path, pool_path)
    prod = tmp_path / "production"
    prod.mkdir()
    (prod / "manifest.yaml").write_text("harness_name: seed\n", encoding="utf-8")
    _patch(monkeypatch, tmp_path, FakeEvaluator({}), prod)

    # a promoted version replaces production
    snapshot = tmp_path / "candidate"
    snapshot.mkdir()
    (snapshot / "manifest.yaml").write_text("harness_name: evolved\n", encoding="utf-8")
    promo.promote_harness(cfg.exp_dir, {
        "iteration": 3, "version": "h-3", "revision": "rev-candidate",
        "snapshot_dir": str(snapshot),
        "performance_gate": {"status": "PASS", "wins": ["a"]},
        "generalization_gate": {"status": "PASS", "wins": ["a"], "operators": ["a"]},
    }, approved_by="tester")
    assert yaml.safe_load((prod / "manifest.yaml").read_text()
                          )["harness_name"] == "evolved"

    back = promo.rollback_harness(cfg.exp_dir, to="last-good")
    assert back["ok"] is True
    assert yaml.safe_load((prod / "manifest.yaml").read_text()
                          )["harness_name"] == "seed"
    record = json.loads((cfg.exp_dir / "promoted_harness.json").read_text())
    assert record["version"].startswith("rollback:")


def test_generalization_paper_survives_a_failed_first_round(tmp_path, monkeypatch):
    """Round 1 fixes the paper even when nothing it measures is an improvement."""
    pool_path = _write_pool(tmp_path, _ops())
    cfg = _cfg(tmp_path, pool_path)
    prod = tmp_path / "production"
    prod.mkdir()
    evaluator = FakeEvaluator({iid: 900.0 for iid in _ops()})     # all much slower
    _patch(monkeypatch, tmp_path, evaluator, prod)

    pl.run_experiment(cfg, start_iteration=1, iterations_to_run=1)

    table = json.loads((cfg.exp_dir / "variant_table.json").read_text())
    paper = table["groups"]["generalization_ids"]
    assert len(paper) == 4
    # round_questions.json is rewritten by every pass, so the baseline round's
    # own copy is what says the paper was defined there
    it1 = cfg.exp_dir / "runs" / "iteration_001" / "input"
    questions = json.loads((it1 / "stage.json").read_text())
    assert questions["stage"] == "baseline"
    assert table["groups"]["generalization_defined_at"] == 1
    assert len(table["groups"]["generalization_ids"]) == 4
    # nothing beat its variant, so the pool keeps what it had
    it1 = cfg.exp_dir / "runs" / "iteration_001" / "input"
    baseline = json.loads((it1 / "baseline_round.json").read_text())
    assert (baseline["pool_promotion"] or {}).get("promoted", []) == []


def test_the_baseline_round_stops_the_run_when_the_paper_cannot_be_measured(
        tmp_path, monkeypatch):
    """Round 1 judges no gate, but it owes a usable number for every operator."""
    pool_path = _write_pool(tmp_path, _ops())
    cfg = _cfg(tmp_path, pool_path)
    _patch(monkeypatch, tmp_path, FakeEvaluator({}), tmp_path / "production")

    pl.run_experiment(cfg, start_iteration=1, iterations_to_run=4)

    run = json.loads((cfg.state_dir / "run.json").read_text())
    assert run["final_status"] == "baseline_round_failed"
    # stopped at round 1: no later round ran, nothing was parked for approval
    assert not (cfg.exp_dir / "runs" / "iteration_002" / "input"
                / "performance_gate.json").exists()
    assert not (cfg.exp_dir / "pending_promotion.json").exists()
    events = [json.loads(l)["type"] for l in
              (cfg.state_dir / "timeline.jsonl").read_text().splitlines()
              if l.strip()]
    assert "baseline_round_failed" in events


def test_generation_records_carry_their_own_revision(tmp_path, monkeypatch):
    """A generation's record must name the revision it measured."""
    from ..orchestrator.champion_selection import load_generations

    pool_path = _write_pool(tmp_path, _ops())
    cfg = _cfg(tmp_path, pool_path, round_questions="legacy")  # exercise the legacy path
    evaluator = FakeEvaluator({})
    _patch(monkeypatch, tmp_path, evaluator, tmp_path / "production")

    pl.run_experiment(cfg, start_iteration=1, iterations_to_run=1)
    generations = load_generations(cfg.exp_dir)
    assert generations, "a generation must be recorded"
    assert generations[0].workspace_revision, (
        "workspace_revision must name this round's commit, not be empty")


def test_approval_promotes_the_accepted_rounds_kernels_into_the_pool(
        tmp_path, monkeypatch):
    """Only the accepted round's operators reach production — as best-knowns.

    Approving must (a) lower the pool's best_known where the accepted retake beat
    it, (b) append an auditable history row naming the harness version, and (c)
    leave the pool recoverable via a backup. The baseline round writes the pool
    on its own (kernel fact), so the retake has to be *better* than that to show
    up here.
    """
    ops = _ops()
    pool_path = _write_pool(tmp_path, ops)
    cfg = _cfg(tmp_path, pool_path)
    prod = tmp_path / "production"
    prod.mkdir()
    (prod / "manifest.yaml").write_text("harness_name: seed\n", encoding="utf-8")

    def medians(iteration, stage):
        share = 0.6 if stage == "generalization" else 0.9
        return {iid: values["variant"] * share for iid, values in ops.items()}

    evaluator = FakeEvaluator(medians)
    _patch(monkeypatch, tmp_path, evaluator, prod)

    pl.run_experiment(cfg, start_iteration=1, iterations_to_run=4)
    assert (cfg.exp_dir / "pending_promotion.json").is_file()
    result = promo.approve_promotion(cfg, cfg.exp_dir, approved_by="tester")
    assert result["ok"] is True

    kernel_update = result["kernel_update"]
    assert kernel_update["updated"], "the accepted round's kernels must be published"
    assert kernel_update["pool"] == str(pool_path)
    assert Path(kernel_update["backup"]).is_file()

    accepted = set(json.loads(
        (cfg.exp_dir / "variant_table.json").read_text()
    )["groups"]["generalization_ids"])
    published = yaml.safe_load(pool_path.read_text(encoding="utf-8"))
    entries = {i["id"]: i for i in published["instances"]}
    for change in kernel_update["updated"]:
        iid = change["operator_id"]
        assert iid in accepted, "only the accepted round's operators are published"
        assert entries[iid]["best_known_us"] == pytest.approx(
            ops[iid]["variant"] * 0.6)
        history = entries[iid]["history"]
        assert history[-1]["accepted"] is True
        assert history[-1]["harness_version"] == "h-2"
    # the pool is still the original operator-shaped document
    assert len(published["instances"]) == len(ops)


def test_a_slower_round_never_degrades_the_pool(tmp_path, monkeypatch):
    """Best-known wins: nothing a round measures can make a pool entry worse."""
    ops = _ops(n=8)
    pool_path = _write_pool(tmp_path, ops)
    cfg = _cfg(tmp_path, pool_path)
    prod = tmp_path / "production"
    prod.mkdir()
    (prod / "manifest.yaml").write_text("harness_name: seed\n", encoding="utf-8")

    def medians(iteration, stage):
        # A baseline round that does well, then rounds that measure worse
        share = 0.5 if stage == "baseline" else 0.95
        return {iid: values["variant"] * share for iid, values in ops.items()}

    _patch(monkeypatch, tmp_path, FakeEvaluator(medians), prod)
    pl.run_experiment(cfg, start_iteration=1, iterations_to_run=4)

    published = {i["id"]: i["best_known_us"]
                 for i in yaml.safe_load(pool_path.read_text())["instances"]}
    for iid, row in ops.items():
        assert published[iid] <= row["variant"], (
            "a pool entry may only ever improve")


def test_rejected_round_never_promotes_kernels_in_variant_mode(tmp_path, monkeypatch):
    """Only the accepted round's optimizations reach production.

    The legacy path promoted each round's kernels as soon as it was evaluated;
    under the variant protocol a rejected round must leave nothing behind.
    """
    ops = _ops()
    pool_path = _write_pool(tmp_path, ops)
    cfg = _cfg(tmp_path, pool_path)
    prod = tmp_path / "production"
    prod.mkdir()
    _patch(monkeypatch, tmp_path, FakeEvaluator({}), prod)

    promoted = {"calls": 0}

    def _fake_promote(*a, **k):
        promoted["calls"] += 1
        return None

    monkeypatch.setattr(pl, "_promote_iteration", _fake_promote)
    # the evaluator reports nothing, so every operator fails both gates
    pl.run_experiment(cfg, start_iteration=1, iterations_to_run=1)   # round 1 fails
    assert promoted["calls"] == 0
    assert not (cfg.exp_dir / "pending_promotion.json").exists()
    assert not (cfg.exp_dir / "promoted_harness.json").exists()


def test_a_run_without_a_usable_pool_stops_loudly(tmp_path, monkeypatch):
    """No operators to measure must not burn the whole round budget."""
    pool_path = tmp_path / "empty_pool.yaml"
    pool_path.write_text(yaml.safe_dump({"schema_version": 1, "instances": []}),
                         encoding="utf-8")
    cfg = _cfg(tmp_path, pool_path)
    _patch(monkeypatch, tmp_path, FakeEvaluator({}), tmp_path / "production")

    pl.run_experiment(cfg, start_iteration=1, iterations_to_run=1)
    run = json.loads((cfg.state_dir / "run.json").read_text())
    assert run["final_status"] == "no_question_pool"
    events = [json.loads(l)["type"] for l in
              (cfg.state_dir / "timeline.jsonl").read_text().splitlines() if l.strip()]
    assert "variant_pool_empty" in events


def test_mechanism_gate_is_recorded_and_does_not_veto_a_win(tmp_path, monkeypatch):
    """Lenient, but never absent: the mechanism verdict is graded and recorded.

    A contradicted mechanism ("the planner was off, so this planner policy
    change cannot have caused the win") must show up in the decision, while the
    counter gates keep deciding. Round 1 is the baseline round and has no gate
    to grade; the performance round is where a declared change is first judged.
    """
    ops = _ops()
    pool_path = _write_pool(tmp_path, ops)
    cfg = _cfg(tmp_path, pool_path)
    prod = tmp_path / "production"
    prod.mkdir()
    (prod / "manifest.yaml").write_text("harness_name: seed\n", encoding="utf-8")
    evaluator = FakeEvaluator({iid: values["variant"] * 0.5
                               for iid, values in ops.items()})
    _patch(monkeypatch, tmp_path, evaluator, prod)

    # a change manifest whose mechanism cannot have fired: the planner was off
    manifest_dir = cfg.exp_dir / "runs" / "iteration_001" / "evolve"
    manifest_dir.mkdir(parents=True, exist_ok=True)
    (manifest_dir / "change_manifest.json").write_text(json.dumps({
        "schema_version": 1, "iteration": 1,
        "changes": [{
            "id": "chg-1",
            "description": "point the exhausted-budget phase at the bounded plan",
            "files": ["planner_policy.yaml"],
            "mechanism_signature": ["planner emits architecture_explore"],
            "mechanism_check": {"kind": "planner_plan_ids",
                                "expect_any": ["architecture_explore"]},
        }],
    }), encoding="utf-8")

    pl.run_experiment(cfg, start_iteration=1, iterations_to_run=4)

    it1 = cfg.exp_dir / "runs" / "iteration_001" / "input"
    first = json.loads((it1 / "decision.json").read_text())
    assert first["stage"] == "baseline"
    assert first["mechanism_gate"] == {}, "round 1 judges no gate"
    assert first["performance_gate"] is None

    # round 2 grades that manifest against round 2's children while it judges
    # the performance gate
    it2 = cfg.exp_dir / "runs" / "iteration_002" / "input"
    second = json.loads((it2 / "decision.json").read_text())
    assert second["stage"] == "performance"
    mechanism = second["mechanism_gate"]
    assert mechanism["status"] in {"MISS", "PARTIAL", "UNOBSERVED", "HIT"}
    assert "detail" in mechanism
    assert second["performance_gate"]["status"] == "PASS"
    # a passing performance gate promotes nothing by itself: it hands the same
    # harness to DKAO again with the frozen paper
    frozen = json.loads((cfg.exp_dir / "pending_generalization.json").read_text())
    assert set(frozen["operator_ids"]) == set(
        json.loads((cfg.exp_dir / "variant_table.json").read_text()
                   )["groups"]["generalization_ids"])
