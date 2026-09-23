"""The two round-ish numbers in the New Task form must mean what they say.

They used to be easy to confuse, and confusing them had a real cost: the outer
loop's bound came from a hidden ``max_rounds`` (default 10) plus whatever target
the WebUI happened to carry, while the form's own answer was only recorded in
the report. A run therefore kept producing rounds nobody had asked for.

The operator's rule now is one round field:

* **Max iters** (``default_rounds``) — *one question's* optimization budget
  inside DKAO. It is not a round count and must reach the child task unchanged.
* **Rounds** (``rounds``) — *the whole task's* limit, counted in iterations: the
  baseline round is round 1, and every later round is a performance pass plus
  (when it wins) the generalization retake inside that same iteration. Passing
  both gates in round 5 of 10 ends the run there, waiting for approval.
"""

from __future__ import annotations

import json
from pathlib import Path

from metainfer.tasks.harness_evolve.orchestrator import cli as he_cli
from metainfer.tasks.harness_evolve.orchestrator.config import (
    load_experiment_config,
)
from metainfer.tasks.harness_evolve.orchestrator.pipeline import (
    COST_GUARDRAIL, ROUNDS_DEFAULT, _rounds_limit,
)
from metainfer.tasks.harness_evolve.orchestrator.state import (
    read_target_iterations,
)


def _write_req(tmp_path: Path, **answers) -> Path:
    tmp_path.mkdir(parents=True, exist_ok=True)
    payload = {
        "task_id": "form-rounds",
        "task_type": "harness-evolve",
        "execution_mode": "dry-run",
        "evolve_mode": "dry-run",
        "pool_source": "",
    }
    payload.update(answers)
    req = tmp_path / "requirements.json"
    req.write_text(json.dumps(payload), encoding="utf-8")
    return req


def _cfg(tmp_path: Path, **answers):
    return load_experiment_config(
        _write_req(tmp_path, **answers), tmp_path / "state", tmp_path / "ws")


# ---------------------------------------------------------------- Max iters

def test_max_iters_reaches_each_child_task_unchanged(tmp_path):
    """``default_rounds`` is a per-question DKAO budget, not a round count."""
    cfg = _cfg(tmp_path, default_rounds="7")
    assert cfg.answers["default_rounds"] == "7"
    from metainfer.tasks.harness_evolve.orchestrator.adapters.eval import (
        DkaoCliEvaluator,
    )
    from metainfer.tasks.harness_evolve.orchestrator.pipeline import (
        _variant_instance_spec,
    )

    spec = _variant_instance_spec(
        {"id": "op", "baseline_us": 10.0, "best_known_us": 9.0},
        budget_rounds=int(cfg.answers["default_rounds"]))
    assert spec.budget_rounds == 7
    # and it is handed to DKAO as its own "Max iters" field
    req = DkaoCliEvaluator()._build_dkao_requirements(
        cfg, spec, 1, "child-id", "repo-name", 0, tmp_path / "ws")
    assert req["max_iterations"] == "7"


# ------------------------------------------------------------------- Rounds

def test_rounds_is_the_only_round_limit(tmp_path):
    """There is one limit, counted in rounds, and a round is an iteration."""
    assert _rounds_limit(_cfg(tmp_path, rounds=4)) == 4
    # the pre-rename field name is still honoured
    assert _rounds_limit(_cfg(tmp_path / "b", max_iterations=6)) == 6
    # absent: the form's default
    assert _rounds_limit(_cfg(tmp_path / "c")) == ROUNDS_DEFAULT
    # nonsense is clamped into a sane range
    assert _rounds_limit(_cfg(tmp_path / "d", rounds=9999)) == 50
    assert _rounds_limit(_cfg(tmp_path / "e", rounds=-3)) == 1
    # the cost guardrail can never be the thing that stops a real run
    assert COST_GUARDRAIL >= 4 * ROUNDS_DEFAULT


def test_rounds_is_pinned_where_the_loop_and_the_webui_read_it(tmp_path):
    """The form's answer becomes the run's target before round 1."""
    cfg = _cfg(tmp_path, rounds=7)
    assert read_target_iterations(cfg.exp_dir) is None
    he_cli._seed_rounds_from_form(cfg, cfg.exp_dir)
    assert read_target_iterations(cfg.exp_dir) == 7
    # a runaway value is clamped exactly like the WebUI's own target box
    cfg2 = _cfg(tmp_path / "big", rounds=9999)
    he_cli._seed_rounds_from_form(cfg2, cfg2.exp_dir)
    assert read_target_iterations(cfg2.exp_dir) == 50


# --------------------------------------------------- the form's own contract

def test_the_form_has_one_round_field_and_it_is_machine_readable():
    """Loadable *and* parseable: a select submits its label.

    The explanation must not live in an option label (the backend runs ``int()``
    on some answers), and the outer loop must expose exactly one round field.
    """
    import metainfer.tasks  # noqa: F401 - registers the plugins
    from metainfer.server.forms import load_form_schema, validate_submission

    schema = load_form_schema("harness-evolve")
    assert schema is not None and schema["fields"]
    keys = [f["key"] for f in schema["fields"]]
    by_key = {f["key"]: f for f in schema["fields"]}

    assert "rounds" in keys and "max_rounds" not in keys, (
        "the outer loop exposes exactly one round field")
    for field in ("default_rounds", "rounds", "per_round_budget"):
        assert str(by_key[field]["default"]).isdigit()
    for option in by_key["default_rounds"]["options"]:
        int(option["label"])          # raises if a label grew an explanation

    # the two fields name their layer, so "Max iters" cannot be read as rounds
    assert "单题内部" in by_key["default_rounds"]["help"]
    assert "任务上限" in by_key["rounds"]["help"]

    answers = {k: str(f["default"]) for k, f in by_key.items()
               if f.get("default") not in (None, "")}
    answers["pool_source"] = "/root/zth_agent/ahe-kernel-repos/registered_pool.yaml"
    result = validate_submission("harness-evolve", answers)
    assert result["ok"], result.get("errors")
