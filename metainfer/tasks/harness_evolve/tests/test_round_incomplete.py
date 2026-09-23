"""A round that could not measure every question gets no verdict.

``evaluate_gate`` used to answer ``FAIL`` whenever a drawn question produced no
number. That reads as "the harness is worse than the variant", which is a claim
the round did not support — and the loop acted on it: it went through
analyze→evolve to fix a harness that may have been fine, and on the
generalization retake it spent the candidate on a missing measurement.

This drives the real loop (dry-run evaluator) with one question's result removed
from the performance pass and checks what the run does about it.
"""

from __future__ import annotations

import json
from pathlib import Path

import yaml

from metainfer.tasks.harness_evolve.orchestrator import pipeline as P
from metainfer.tasks.harness_evolve.orchestrator.config import (
    load_experiment_config,
)
from metainfer.tasks.harness_evolve.orchestrator.pipeline import run_experiment
from metainfer.tasks.harness_evolve.orchestrator.state import (
    write_target_iterations,
)


def _variant_cfg(tmp_path: Path, **answers):
    """Same shape as the resume tests: a real pool file, four questions."""
    ops = {f"op{i:02d}": {"baseline_us": 100.0 + i, "best_known_us": 40.0 + 4 * i}
           for i in range(8)}
    pool = tmp_path / "pool.yaml"
    pool.write_text(yaml.safe_dump({
        "schema_version": 1,
        "instances": [
            {"id": iid, "family": f"decode__fam{i}", "contract": {"M": 16},
             "baseline_us": v["baseline_us"], "best_known_us": v["best_known_us"],
             "history": []}
            for i, (iid, v) in enumerate(sorted(ops.items()))
        ],
    }, sort_keys=False), encoding="utf-8")
    tmp_path.mkdir(parents=True, exist_ok=True)
    req = tmp_path / "requirements.json"
    req.write_text(json.dumps({
        "task_id": "incomplete-task",
        "task_type": "harness-evolve",
        "execution_mode": "dry-run",
        "evolve_mode": "dry-run",
        "pool_source": str(pool),
        "question_pool": str(pool),
        "round_questions": "variant",
        "per_round_budget": "4",
        "max_iterations": 1,
        **answers,
    }), encoding="utf-8")
    return load_experiment_config(req, tmp_path / "state", tmp_path / "ws")


def _timeline_events(cfg) -> list:
    path = Path(cfg.state_dir) / "timeline.jsonl"
    if not path.is_file():
        return []
    return [json.loads(line)["type"]
            for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def test_a_round_missing_a_measurement_carries_no_verdict(tmp_path, monkeypatch):
    cfg = _variant_cfg(tmp_path)
    write_target_iterations(cfg.exp_dir, 2)
    real = P.build_evaluator("dry-run")
    dropped: dict = {}

    def factory(_mode):
        class Sabotaged:
            """The dry-run evaluator, minus one question on the pass round."""

            def evaluate(self, cfg_, snapshot, iteration, instances=None):
                results = real.evaluate(cfg_, snapshot, iteration,
                                        instances=instances)
                if (str(cfg_.answers.get("round_stage")) == "performance"
                        and results):
                    victim = sorted(results)[0]
                    dropped["id"] = victim
                    results = {k: v for k, v in results.items() if k != victim}
                return results

        return Sabotaged()

    monkeypatch.setattr(P, "build_evaluator", factory)

    run_experiment(cfg)

    exp = cfg.exp_dir
    # round 1 (baseline) measured everything and was decided as before
    assert (exp / "runs" / "iteration_001" / "input"
            / "baseline_round.json").is_file()

    gate = json.loads((exp / "runs" / "iteration_002" / "input"
                       / "performance_gate.json").read_text(encoding="utf-8"))
    assert gate["status"] == "INCOMPLETE", gate
    assert dropped["id"] in gate["unmeasured"]

    events = _timeline_events(cfg)
    assert "round_incomplete" in events, events
    # nothing was promoted, and no retake was frozen off a round without a verdict
    assert not (exp / "pending_promotion.json").is_file()
    assert not (exp / "pending_generalization.json").is_file()


def test_the_incomplete_round_is_recorded_with_its_reason(tmp_path, monkeypatch):
    cfg = _variant_cfg(tmp_path)
    write_target_iterations(cfg.exp_dir, 2)
    real = P.build_evaluator("dry-run")
    dropped: dict = {}

    def factory(_mode):
        class Sabotaged:
            def evaluate(self, cfg_, snapshot, iteration, instances=None):
                results = real.evaluate(cfg_, snapshot, iteration,
                                        instances=instances)
                if (str(cfg_.answers.get("round_stage")) == "performance"
                        and results):
                    victim = sorted(results)[0]
                    dropped["id"] = victim
                    results = {k: v for k, v in results.items() if k != victim}
                return results

        return Sabotaged()

    monkeypatch.setattr(P, "build_evaluator", factory)
    run_experiment(cfg)

    rows = [json.loads(line) for line in
            (Path(cfg.state_dir) / "timeline.jsonl").read_text(
                encoding="utf-8").splitlines() if line.strip()]
    incomplete = [row for row in rows if row["type"] == "round_incomplete"]
    assert incomplete, rows
    payload = incomplete[0]["payload"]
    assert payload["gate"] == "performance"
    assert payload["unmeasured"] == [dropped["id"]]
    assert payload["measured"], "the questions that did report are listed"
    assert "no harness verdict" in payload["policy"]
