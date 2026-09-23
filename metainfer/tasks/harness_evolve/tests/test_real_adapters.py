"""Unit tests for real evaluator/evolver surfaces (no GPU/LLM calls)."""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import List

from ..orchestrator.adapters.eval import (
    DkaoCliEvaluator, _child_env, _normalize_report,
    _normalize_workspace_result, _worker_rounds,
)
from ..orchestrator.config import ExperimentConfig, InstanceSpec
from ..orchestrator.evolve import AgentEvolver, _last_result


def _inst():
    return InstanceSpec(
        id="hy3_tp8_qkv_proj_m16",
        shape={"model": "hy3", "tp_size": 8, "operator": "qkv_proj",
               "M": 16, "N": 1280, "K": 4096},
        budget_rounds=4,
        pass_median_us_le=60.0,
    )


def _cfg(tmp_path):
    # HE manages no GPU occupancy: the device is the fixed index % 4 rotation and
    # there is no gate wait, lease or broker poll to configure.
    return ExperimentConfig(
        task_id="ahe-parent", state_dir=tmp_path / "state",
        workspace_dir=tmp_path / "workspace", suite=[_inst()],
        execution_mode="dkao-cli", agent_framework="dsh",
        answers={"ahe_repo_root": str(tmp_path / "ahe-repos")},
    )


def test_dkao_requirements_include_parent_and_shape(tmp_path):
    ev = DkaoCliEvaluator()
    req = ev._build_dkao_requirements(
        _cfg(tmp_path), _inst(), 2, "child-id", "repo-name", 3,
        tmp_path / "harness",
    )
    assert req["parent_ahe_task_id"] == "ahe-parent"
    assert req["ahe_iteration"] == 2
    assert req["target_repo_path"] == "repo-name"
    shape_cfg = __import__("yaml").safe_load(req["shape_config"])
    # DKAO manual mode requires worker_N <-> GPU N; a single child on GPU 3
    # must therefore be assigned to worker_3 (not worker_0 with gpu=3).
    assert shape_cfg["assignments"] == {
        "worker_3": {"gpu": 3, "shapes": ["hy3_tp8_qkv_proj_m16"]}
    }
    assert shape_cfg["shapes"][0]["M"] == 16


def test_dkao_child_uses_flash_41_model_label(tmp_path):
    """The child DKAO task runs on the 4.1 Flash model, and the label it
    submits is one DKAO's own config resolves (the two task packages must not
    drift apart on model naming)."""
    from metainfer.tasks.dcu_kernel_auto_opt.orchestrator.config import (
        DSH_MODEL_IDS,
    )

    ev = DkaoCliEvaluator()
    req = ev._build_dkao_requirements(
        _cfg(tmp_path), _inst(), 1, "child-id", "repo-name", 0,
        tmp_path / "harness",
    )
    label = req["agent_model"]
    assert label == "deepseek-flash-4.1"
    assert DSH_MODEL_IDS[label] == "deepseek/deepseek-flash"


def test_normalize_real_final_report():
    report = {
        "status": "success",
        "final_validation": {
            "hy3_tp8_qkv_proj_m16": {
                "passed": True, "graph_capture_passed": True,
                "mismatch_count": 0, "median_us": 42.0, "p90_us": 43.0,
            },
        },
        "workers": {},
    }
    out = _normalize_report(_inst(), report)
    assert out["status"] == "success"
    assert out["correctness_ok"] is True
    assert out["median_us"] == 42.0 and out["p90_us"] == 43.0


def test_partial_worker_result_is_preserved_but_never_passes(tmp_path):
    worker = tmp_path / "workers" / "worker_0"
    worker.mkdir(parents=True)
    (worker / "result.json").write_text(json.dumps({
        "shapes": {_inst().id: {"metrics": {
            "graph_capture_passed": True,
            "correctness_passed_in_precheck": True,
            "median_us": 40.0, "p90_us": 41.0,
        }}},
    }), encoding="utf-8")
    out = _normalize_workspace_result(_inst(), tmp_path)
    assert out["status"] == "partial_worker_result"
    assert out["median_us"] == 40.0
    assert out["correctness_ok"] is True
    assert out["passed"] is False  # no final serial validation


def test_real_evaluator_forces_isolated_repo_root(tmp_path, monkeypatch):
    cfg = _cfg(tmp_path)
    ev = DkaoCliEvaluator()
    # The device is a pure layout decision (index % 4): the evaluator takes no
    # reading of the host, so the test cannot depend on what is running on it.
    seen = {}

    def fake_run_one(cfg_, workspace, iteration, inst, index, repo_root,
                     child_root, preflight=None, **kwargs):
        seen["repo_root"] = repo_root
        seen["child_root"] = child_root
        seen["index"] = index
        return {"status": "completed", "passed": True, "median_us": 1.0}

    monkeypatch.setattr(ev, "_run_one", fake_run_one)
    out = ev.evaluate(cfg, tmp_path / "harness", 1, [_inst()])
    assert out[_inst().id]["passed"] is True
    assert seen["repo_root"] == (tmp_path / "ahe-repos").resolve()
    assert "children/iteration_001" in str(seen["child_root"])
    assert seen["index"] == 0


def test_agent_evolver_prompt_is_single_role_and_pool_bounded(tmp_path):
    ev = AgentEvolver()
    prompt = ev._prompt(tmp_path, 1, {
        "overview": "overview.md", "selected": ["a"], "pool_ids": ["a", "b"],
        "results": {}, "diff": {}, "decision": {},
    })
    assert "SINGLE AHE Evolve Agent" in prompt
    assert "two responsibilities in this ONE role" in prompt
    assert "invent pool ids" in prompt
    assert "_ahe_change_manifest.json" in prompt
    assert "_ahe_round_plan.json" in prompt


def test_evolve_agent_defaults_to_flash_41(tmp_path):
    """Both the adapter and build_evolver default to deepseek/deepseek-flash."""
    from ..orchestrator.evolve import (
        DEFAULT_EVOLVE_MODEL, LEGACY_EVOLVE_MODEL, build_evolver,
    )

    assert DEFAULT_EVOLVE_MODEL == "deepseek/deepseek-flash"
    assert LEGACY_EVOLVE_MODEL == "deepseek/deepseek-v4-flash-0731"
    assert AgentEvolver().model == DEFAULT_EVOLVE_MODEL
    assert build_evolver("agent").model == DEFAULT_EVOLVE_MODEL
    # A form answer still wins over the default.
    assert build_evolver("agent", model=LEGACY_EVOLVE_MODEL).model == (
        LEGACY_EVOLVE_MODEL)


def test_last_result_parses_stream_json():
    text = '\n'.join([
        json.dumps({"type": "assistant", "message": "x"}),
        json.dumps({"type": "result", "result": "done"}),
    ])
    assert _last_result(text) == "done"


def test_real_mode_rejects_builtin_pool(tmp_path):
    from ..orchestrator.config import ExperimentConfig
    from ..orchestrator.pipeline import _load_pool
    cfg = ExperimentConfig(
        task_id="t", state_dir=tmp_path / "s", workspace_dir=tmp_path / "w",
        suite=[], execution_mode="dkao-cli", agent_framework="dsh",
        pool_source="builtin",
    )
    try:
        _load_pool(cfg)
        raise AssertionError("expected ValueError for builtin pool in real mode")
    except ValueError:
        pass


def test_measured_pool_yaml_loads(tmp_path):
    from ..orchestrator.pool_builder import build_pool
    # a minimal fake historical report -> builder -> loader round trip
    wd = tmp_path / "nodes" / "n" / "workspaces" / "task"
    (wd / "final_report.json").parent.mkdir(parents=True)
    (wd / "final_report.json").write_text(json.dumps({
        "config": {
            "model": "hy3",
            "shapes": [{"id": "hy3_tp8_qkv_proj_m16", "M": 16, "N": 1280,
                        "K": 4096, "tp_size": 8, "operator": "qkv_proj"}],
        },
        "initial_metrics": {"hy3_tp8_qkv_proj_m16": {"baseline_us": 100.0}},
        "final_validation": {"hy3_tp8_qkv_proj_m16": {"median_us": 42.0,
                                                       "p90_us": 43.0}},
    }), encoding="utf-8")
    data = build_pool(tmp_path)
    assert len(data["instances"]) == 1
    pool_path = tmp_path / "pool.yaml"
    import yaml as _y
    from ..orchestrator.pool import Pool
    pool_path.write_text(_y.safe_dump(data, sort_keys=False), encoding="utf-8")
    pool = Pool.from_yaml(pool_path)
    assert pool.all_ids() == ["hy3_tp8_qkv_proj_m16"]
    assert pool.get("hy3_tp8_qkv_proj_m16").baseline_us == 100.0


def test_worker_rounds_counts_real_attempts(tmp_path):
    """rounds_used falls back to the workers' own experiment records."""
    exp = tmp_path / "workers" / "worker_0" / "runs" / "shapeA"
    exp.mkdir(parents=True)
    (exp / "experiments.jsonl").write_text(
        '{"iteration": 1}\n{"iteration": 2}\n{"iteration": 3}\n',
        encoding="utf-8")
    assert _worker_rounds(tmp_path) == 3
    assert _worker_rounds(tmp_path / "missing") == 0


def test_child_env_enables_planner_by_default(tmp_path):
    """The evaluated harness' planner only works with METAINFER_PLANNER=1."""
    cfg = _cfg(tmp_path)
    env = _child_env(cfg, tmp_path / "repos", tmp_path / "ws")
    assert env["METAINFER_PLANNER"] == "1"
    assert env["METAINFER_KERNEL_REPOS"] == str(tmp_path / "repos")
    assert env["METAINFER_HARNESS_ROOT"] == str(tmp_path / "ws")


def test_child_env_planner_can_be_disabled(tmp_path):
    cfg = _cfg(tmp_path)
    cfg.answers["planner_enabled"] = "false"
    env = _child_env(cfg, tmp_path / "repos", tmp_path / "ws")
    assert "METAINFER_PLANNER" not in env


def test_child_env_uses_task_scope_and_quick_bench_by_default(tmp_path):
    """One question = one shape: AHE defaults to the cheap validation budget."""
    cfg = _cfg(tmp_path)
    env = _child_env(cfg, tmp_path / "repos", tmp_path / "ws")
    assert env["METAINFER_VALIDATE_SCOPE"] == "task"
    assert env["METAINFER_BENCH_WARMUPS"] == "30"
    assert env["METAINFER_BENCH_SAMPLES"] == "30"
    assert env["METAINFER_BENCH_REPLAYS"] == "50"


def test_child_env_full_budget_can_be_requested(tmp_path):
    cfg = _cfg(tmp_path)
    cfg.answers["validate_scope"] = "api"
    cfg.answers["bench_profile"] = "full"
    env = _child_env(cfg, tmp_path / "repos", tmp_path / "ws")
    assert env["METAINFER_VALIDATE_SCOPE"] == "api"
    assert "METAINFER_BENCH_WARMUPS" not in env
    assert "METAINFER_BENCH_SAMPLES" not in env


def test_child_env_explicit_bench_numbers_win(tmp_path):
    cfg = _cfg(tmp_path)
    cfg.answers["bench_samples"] = "12"
    env = _child_env(cfg, tmp_path / "repos", tmp_path / "ws")
    assert env["METAINFER_BENCH_SAMPLES"] == "12"


def test_env_failure_detection_includes_compile_and_timeout():
    """Compile errors and timeouts are environmental: they earn a retry.

    The rule is "no usable number => the environment owes us a measurement".
    A reported compile error *with* a number is contradictory, and the number is
    the stronger evidence: the kernel ran, so the round scores it (as a loss)
    instead of throwing it away and re-running a question that already measured.
    """
    from metainfer.tasks.harness_evolve.orchestrator.adapters.eval import (
        DkaoCliEvaluator,
    )
    ev = DkaoCliEvaluator()
    assert ev._env_failed({"status": "success", "passed": False,
                           "median_us": None,
                           "reason": "ninja: build stopped: subcommand failed"})
    assert ev._env_failed({"status": "timeout", "passed": False,
                           "median_us": None, "reason": "timed out after 900s"})
    measured_with_error_text = {"status": "rejected", "passed": False,
                                "median_us": 12.0, "correctness_ok": True,
                                "reason": "hipcc: error: undefined template DUFragment"}
    assert ev._env_failed(measured_with_error_text) is False
    # a genuine performance failure is NOT environmental
    assert not ev._env_failed({"status": "success", "passed": False,
                               "median_us": 900.0,
                               "reason": "median above gate"})
    # a passing result is never an environment failure
    assert not ev._env_failed({"status": "success", "passed": True,
                               "median_us": 12.0})


def _pool_inst(inst_id: str):
    from types import SimpleNamespace
    return SimpleNamespace(id=inst_id, shape={"M": 16, "N": 16, "K": 16},
                           budget_rounds=3, notes="")


def test_a_measured_partial_result_is_not_an_environment_failure():
    ev = DkaoCliEvaluator()
    measured = {"status": "partial_worker_result", "passed": False,
                "correctness_ok": True, "median_us": 8.52,
                "reason": "final report missing; worker best preserved as evidence"}
    assert ev._env_failed(measured) is False          # the number is evidence
    # ... but on a re-run the same partial *is* an environment problem: the
    # device was shared while it ran.
    assert ev._env_failed(measured, retry=True) is True

    unmeasured = {"status": "partial_worker_result", "passed": False,
                  "median_us": None, "reason": "no worker numbers"}
    assert ev._env_failed(unmeasured) is True

    missing = {"status": "missing_report", "passed": False, "median_us": None}
    assert ev._env_failed(missing) is True
    assert ev._env_failed({"status": "success", "passed": True,
                           "median_us": 5.0}) is False


def test_every_attempt_gets_its_own_child_directory(tmp_path, monkeypatch):
    """A retried question must not reuse its first attempt's child workspace.

    DKAO binds ``children/<attempt>/<question>/workspace/main`` to the exact
    kernel repo it was launched with and refuses to run when that symlink points
    elsewhere. Re-running into the same directory therefore kills the retry
    instantly ("workspace main already points to ...") and an environment hiccup
    turns into a burned retry budget. Each attempt owns a directory instead, so
    the failed attempt's evidence also survives next to the retry's.
    """
    cfg = _cfg(tmp_path)
    cfg.answers["env_retry_attempts"] = 2
    ev = DkaoCliEvaluator()
    dirs: List[str] = []

    def fake_run_one(cfg_, ws, iteration, inst, gpu, rr, cr, layout=None,
                     **kwargs):
        dirs.append(cr.name)
        # A real child leaves a workspace bound to its kernel repo behind.
        (cr / inst.id / "workspace").mkdir(parents=True, exist_ok=True)
        (cr / inst.id / "orchestrator-external.log").write_text(
            f"attempt {len(dirs)}", encoding="utf-8")
        if len(dirs) == 1:
            return {"status": "missing_report", "passed": False,
                    "median_us": None, "returncode": 1}
        return {"status": "completed", "passed": True, "median_us": 1.0}

    monkeypatch.setattr(ev, "_run_one", fake_run_one)
    out = ev.evaluate(cfg, tmp_path / "harness", 1, [_inst()])

    assert len(dirs) == 2 and len(set(dirs)) == 2, (
        f"each attempt needs its own directory, got {dirs}")
    # the first attempt keeps the plain name; a retry is suffixed
    assert dirs == ["iteration_001", "iteration_001_a2"]
    # the retry ran in a fresh directory, so the first attempt's evidence is
    # still there to explain why it failed
    first = cfg.exp_dir / "children" / dirs[0] / _inst().id
    assert (first / "orchestrator-external.log").read_text() == "attempt 1"
    assert out[_inst().id]["passed"] is True


def _events(cfg):
    path = cfg.state_dir / "timeline.jsonl"
    if not path.is_file():
        return []
    return [json.loads(l)["type"] for l in
            path.read_text().splitlines() if l.strip()]


def test_a_round_hands_every_question_to_dkao_without_checking_the_cards(
        tmp_path, monkeypatch):
    """The dispatch never probes a device: it lays questions out and publishes.

    Eight questions are two waves of four, one question per device, and the
    evaluator never asks the host anything about the cards.
    """
    cfg = _cfg(tmp_path)
    ev = DkaoCliEvaluator()
    seen = []

    def fake_run_one(cfg_, ws, iteration, inst, gpu, rr, cr, layout=None,
                     **kwargs):
        # the device HE hands the question to is the fixed index % 4 rotation
        seen.append((inst.id, gpu))
        return {"status": "completed", "passed": True, "median_us": 1.0}

    monkeypatch.setattr(ev, "_run_one", fake_run_one)
    out = ev.evaluate(cfg, tmp_path / "harness", 1,
                      [_pool_inst(i) for i in ("a", "b", "c", "d",
                                               "e", "f", "g", "h")])
    assert set(out) == set("abcdefgh")
    # one question per device, in order, wrapping onto device 0 for wave two
    assert seen == [("a", 0), ("b", 1), ("c", 2), ("d", 3),
                    ("e", 0), ("f", 1), ("g", 2), ("h", 3)]
    # nothing in the round reads or leases a device
    layout = (cfg.exp_dir / "runs" / "iteration_001" / "input" / "benchmark"
              / "gpu_preflight.json")
    saved = json.loads(layout.read_text(encoding="utf-8"))
    assert saved["leases"] == [] and saved["enabled"] is False
    assert saved["managed_by"] == "dcu_kernel_auto_opt"
    assert "gpu_layout_fixed" in _events(cfg)


def test_a_dkao_gate_verdict_stops_the_round_instead_of_relaunching(
        tmp_path, monkeypatch):
    """Exit 75 is the child's gate giving up after its own 24 h budget.

    HE has no cards to reassign, so relaunching the child would mean ignoring a
    verdict it has no standing to overrule: the round stops and says so.
    """
    cfg = _cfg(tmp_path)
    ev = DkaoCliEvaluator()
    calls = []

    def fake_run_one(cfg_, ws, iteration, inst, gpu, rr, cr, layout=None,
                     **kwargs):
        calls.append(inst.id)
        return {"status": "environment_failed", "passed": False,
                "median_us": None, "returncode": 75, "gate_blocked": True}

    monkeypatch.setattr(ev, "_run_one", fake_run_one)
    out = ev.evaluate(cfg, tmp_path / "harness", 1,
                      [_pool_inst(i) for i in ("a", "b", "c", "d")])
    # exactly one attempt per question — no retry storm against a busy card
    assert calls == ["a", "b", "c", "d"]
    assert all(r["gate_blocked"] for r in out.values())
    stop = json.loads((cfg.exp_dir / "stop_requested.json").read_text(
        encoding="utf-8"))
    assert stop["reason"] == "round_incomplete"
    assert stop["cause"] == "gpu_gate_blocked"
    assert stop["unmeasured"] == ["a", "b", "c", "d"]
    assert "env_retry_exhausted" not in _events(cfg)


def test_an_ordinary_environment_failure_is_still_retried(tmp_path, monkeypatch):
    """A broken toolchain is not a gate verdict: the environment owes a number."""
    cfg = _cfg(tmp_path)
    cfg.answers["env_retry_attempts"] = 2
    ev = DkaoCliEvaluator()
    attempts = []

    def fake_run_one(cfg_, ws, iteration, inst, gpu, rr, cr, layout=None,
                     **kwargs):
        attempts.append(inst.id)
        if len(attempts) == 1:
            return {"status": "missing_report", "passed": False,
                    "median_us": None, "returncode": 1}
        return {"status": "completed", "passed": True, "median_us": 1.0}

    monkeypatch.setattr(ev, "_run_one", fake_run_one)
    out = ev.evaluate(cfg, tmp_path / "harness", 1, [_inst()])
    assert attempts == [_inst().id, _inst().id]
    assert out[_inst().id]["passed"] is True
    assert (cfg.exp_dir / "children" / "iteration_001_a2").is_dir(), (
        "the retry ran in the second attempt's own directory")
    assert "env_retry_exhausted" not in _events(cfg)


def test_a_gate_verdict_is_never_counted_as_a_measurement(tmp_path, monkeypatch):
    """A question the gate blocked has no number, so the round is incomplete."""
    cfg = _cfg(tmp_path)
    ev = DkaoCliEvaluator()
    res = {"status": "environment_failed", "passed": False,
           "median_us": None, "gate_blocked": True}
    assert ev._is_measured(res) is False
    assert ev._incomplete_ids([_inst()], {_inst().id: res}) == [_inst().id]


