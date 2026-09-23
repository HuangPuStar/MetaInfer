"""The draw has to be explicable afterwards — and a round has to be fillable.

Two small holes around the round's question set:

* the draw used ``random`` without recording anything, so "why these four
  operators?" could not be answered after the fact (and a pass could not be
  re-run). The seed is now derived from (task, iteration, stage) unless the form
  pins ``round_seed``, and it is written into the round's evidence;
* with fewer judgeable operators than a wave, the count was silently reduced —
  which changes what the gate means ("at least 75% win" over 3 operators is
  "all three must win"). The run now stops with a named status instead.
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


def _cfg(tmp_path: Path, *, operators: int = 8, **answers):
    pool = tmp_path / "pool.yaml"
    pool.write_text(yaml.safe_dump({
        "schema_version": 1,
        "instances": [
            {"id": f"op{i:02d}", "family": f"decode__fam{i}",
             "contract": {"M": 16}, "baseline_us": 100.0 + i,
             "best_known_us": 40.0 + 4 * i, "history": []}
            for i in range(operators)
        ],
    }, sort_keys=False), encoding="utf-8")
    tmp_path.mkdir(parents=True, exist_ok=True)
    req = tmp_path / "requirements.json"
    req.write_text(json.dumps({
        "task_id": "selection-task",
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


def _timeline(cfg):
    path = Path(cfg.state_dir) / "timeline.jsonl"
    if not path.is_file():
        return []
    return [json.loads(line) for line in
            path.read_text(encoding="utf-8").splitlines() if line.strip()]


# ------------------------------------------------------------------- the seed

def test_the_same_round_draws_the_same_questions(tmp_path):
    cfg = _cfg(tmp_path)

    rng_a, seed_a = P._round_rng(cfg, 2, "performance")
    rng_b, seed_b = P._round_rng(cfg, 2, "performance")

    assert seed_a == seed_b
    assert [rng_a.choice(range(1000)) for _ in range(5)] == \
           [rng_b.choice(range(1000)) for _ in range(5)]


def test_different_rounds_draw_differently(tmp_path):
    cfg = _cfg(tmp_path)

    first = P._round_rng(cfg, 2, "performance")
    second = P._round_rng(cfg, 3, "performance")

    assert first[1] != second[1]
    assert [first[0].random() for _ in range(3)] != \
           [second[0].random() for _ in range(3)]


def test_a_pinned_seed_in_the_form_wins(tmp_path):
    cfg = _cfg(tmp_path, round_seed="4242")

    _rng, label = P._round_rng(cfg, 2, "performance")

    assert label.startswith("round_seed=4242")


def test_the_round_records_which_draw_it_was(tmp_path):
    cfg = _cfg(tmp_path)
    write_target_iterations(cfg.exp_dir, 1)

    run_experiment(cfg)

    selections = [row for row in _timeline(cfg)
                  if row["type"] == "variant_round_selection"]
    assert selections, "the round's question set must be on the record"
    payload = selections[0]["payload"]
    assert payload["seed"] == f"selection-task:1:baseline"
    assert payload["count"] == 4
    assert payload["judgeable_in_pool"] == 8
    assert len(payload["performance_ids"]) == 4


# --------------------------------------------------- a round needs a full wave

def test_a_pool_that_cannot_fill_a_wave_stops_with_a_named_status(tmp_path):
    cfg = _cfg(tmp_path, operators=3)          # 3 judgeable, a wave is 4

    run_experiment(cfg)

    run = json.loads((Path(cfg.state_dir) / "run.json").read_text())
    assert run["final_status"] == "no_question_pool"
    events = [row["type"] for row in _timeline(cfg)]
    assert "variant_pool_too_small" in events, events
    payload = [row for row in _timeline(cfg)
               if row["type"] == "variant_pool_too_small"][0]["payload"]
    assert payload["judgeable_count"] == 3
    assert payload["questions_per_round"] == 4


def test_a_pool_with_a_whole_wave_still_runs(tmp_path):
    """The guard must not fire for a pool that can fill the round."""
    cfg = _cfg(tmp_path, operators=4)

    run_experiment(cfg)

    run = json.loads((Path(cfg.state_dir) / "run.json").read_text())
    assert run["final_status"] != "no_question_pool"
    events = [row["type"] for row in _timeline(cfg)]
    assert "variant_pool_too_small" not in events
