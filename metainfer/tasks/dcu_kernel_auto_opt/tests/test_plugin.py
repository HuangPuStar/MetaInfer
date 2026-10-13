from __future__ import annotations

import json

import pytest

import metainfer.tasks  # noqa: F401
from metainfer.orchestrator.registry import get_orchestrator
from metainfer.server.forms import load_form_schema
from metainfer.server.registry import get
from ..server.routes import _restart_worker_commands, read_worker_lanes


def test_task_and_web_plugins_registered():
    assert get_orchestrator("dcu-kernel-auto-opt").task_type == "dcu-kernel-auto-opt"
    plugin = get("dcu-kernel-auto-opt")
    assert plugin is not None
    assert plugin.detail_view_module == "app/dkao-detail"


def test_form_schema_is_available():
    schema = load_form_schema("dcu-kernel-auto-opt")
    assert schema is not None
    assert schema["type"] == "dcu-kernel-auto-opt"
    keys = {field["key"] for field in schema["fields"]}
    assert {
        "operator", "kernel_language", "target_hardware", "shape_config",
        "dtype", "correctness_ref", "perf_target", "max_iterations",
        "execution_mode", "target_repo_path", "agent_framework",
        "agent_model",
    } <= keys
    shape = next(
        field for field in schema["fields"]
        if field["key"] == "shape_config"
    )
    assert shape["required"] is False
    assert shape["default"] == ""
    assert shape["override_component"] == "shape-input"
    # The catalog must span the form's full width: in a half-width column the
    # operator signatures were clipped and picking a shape was guesswork.
    assert shape["full_row"] is True
    framework = next(
        field for field in schema["fields"]
        if field["key"] == "agent_framework"
    )
    assert framework["default"] == "ccb"
    assert [option["label"] for option in framework["options"]] == [
        "ccb", "dsh"
    ]
    model = next(
        field for field in schema["fields"]
        if field["key"] == "agent_model"
    )
    assert model["default"] == "Opus"
    assert model["override_component"] == "agent-model"
    assert model["override_module"] == "app/dkao-agent-fields"
    assert [option["label"] for option in model["options"]] == [
        "Opus", "Sonnet", "deepseek-flash-4.1", "deepseek-v4-flash"
    ]


def test_worker_lanes_always_has_four_rows(tmp_path):
    lanes = read_worker_lanes(tmp_path)
    assert [row["worker_id"] for row in lanes["workers"]] == [
        "worker_0", "worker_1", "worker_2", "worker_3",
    ]


def test_restart_commands_let_lane_resolve_agent_binary(tmp_path):
    # Regression: the restart route used to force METAINFER_CLAUDE_BIN
    # (ccb's binary) as an explicit --claude-bin, which breaks dsh-framework
    # lanes whose agents must run through bridge/dsh/dsh_agent.py. The lane
    # binaries resolve the framework-appropriate binary themselves.
    requirements = tmp_path / "requirements.json"
    requirements.write_text("{}", encoding="utf-8")
    state = tmp_path / "state"
    workspace = tmp_path / "workspace"
    command, integration = _restart_worker_commands(
        requirements, state, workspace, "worker_1"
    )
    for cmd in (command, integration):
        assert "--claude-bin" not in cmd
        assert "--worker-id" in cmd
        assert cmd[cmd.index("--worker-id") + 1] == "worker_1"
        assert str(requirements) in cmd
    assert "restart_worker" in command[2]
    assert "integrate_restarted_worker" in integration[2]


def test_worker_lanes_surface_live_optimization_step(tmp_path):
    workspace = tmp_path / "workspace"
    state = tmp_path / "state"
    worker = workspace / "workers" / "worker_0"
    runs = worker / "runs" / "m2"
    runs.mkdir(parents=True)
    state.mkdir()
    workspace.joinpath("plan.json").write_text(json.dumps({
        "max_iterations": 5,
        "assignments": [{
            "worker_id": "worker_0",
            "gpu": 0,
            "shapes": ["m2"],
        }],
    }), encoding="utf-8")
    worker.joinpath("status.json").write_text(json.dumps({
        "state": "validating_candidate",
        "iteration": 2,
        "shape_id": "m2",
    }), encoding="utf-8")
    runs.joinpath("experiments.jsonl").write_text(
        json.dumps({"iteration": 1, "shape_id": "m2"}) + "\n",
        encoding="utf-8",
    )
    state.joinpath("agents.json").write_text(json.dumps({
        "agents": [{
            "name": "worker_0-m2-iter2",
            "status": "running",
            "started_at": 10,
            "last_output_age_s": 181,
        }],
    }), encoding="utf-8")

    lane = read_worker_lanes(workspace, state)["workers"][0]

    assert lane["step"] == "Compiling and validating candidate"
    assert lane["completed_rounds"] == 1
    assert lane["target_rounds"] == 5
    assert lane["long_running"] is True
    assert lane["active_iteration"] == {
        "iteration": 2,
        "shape_id": "m2",
        "state": "validating_candidate",
        "step": "Compiling and validating candidate",
        "agent_name": "worker_0-m2-iter2",
        "agent_status": "running",
        "elapsed_s": None,
        "last_output_age_s": 181,
    }


def test_worker_lanes_surface_pmc_and_repair_steps(tmp_path):
    workspace = tmp_path / "workspace"
    state = tmp_path / "state"
    worker = workspace / "workers" / "worker_0"
    worker.mkdir(parents=True)
    state.mkdir()
    workspace.joinpath("plan.json").write_text(json.dumps({
        "max_iterations": 5,
        "assignments": [{
            "worker_id": "worker_0",
            "gpu": 0,
            "shapes": ["m2"],
        }],
    }), encoding="utf-8")

    worker.joinpath("status.json").write_text(json.dumps({
        "state": "profiling_current_best",
        "iteration": 2,
        "shape_id": "m2",
    }), encoding="utf-8")
    lane = read_worker_lanes(workspace, state)["workers"][0]
    assert lane["active_iteration"]["step"] == (
        "Profiling current best kernel with PMC"
    )

    worker.joinpath("status.json").write_text(json.dumps({
        "state": "repairing_candidate",
        "iteration": 2,
        "shape_id": "m2",
        "repair": 3,
        "max_repairs": 4,
    }), encoding="utf-8")
    lane = read_worker_lanes(workspace, state)["workers"][0]
    assert lane["active_iteration"]["step"] == (
        "Repairing compile/correctness failure (3/4)"
    )
    assert lane["active_iteration"]["repair"] == 3
    assert lane["active_iteration"]["max_repairs"] == 4


def test_worker_lanes_surface_bootstrap_attempts(tmp_path):
    workspace = tmp_path / "workspace"
    state = tmp_path / "state"
    source = workspace / "workers" / "worker_0" / "source"
    source.joinpath("csrc").mkdir(parents=True)
    state.mkdir()
    workspace.joinpath("plan.json").write_text(json.dumps({
        "assignments": [{
            "worker_id": "worker_0",
            "gpu": 0,
            "shapes": ["m2_wqkv_a"],
        }],
    }), encoding="utf-8")
    source.joinpath("csrc", "w8a8_gemm_hip.hip").write_text(
        "// hip", encoding="utf-8"
    )
    state.joinpath("agents.json").write_text(json.dumps({
        "agents": [{
            "name": "worker_0-bootstrap-attempt1",
            "status": "running",
            "success": None,
            "elapsed_s": 12.5,
            "last_output_age_s": 0.5,
        }],
    }), encoding="utf-8")

    lane = read_worker_lanes(workspace, state)["workers"][0]

    assert lane["state"] == "bootstrap_running"
    assert lane["bootstrap_attempts"] == [{
        "kind": "bootstrap",
        "attempt": 1,
        "status": "running",
        "hypothesis": (
            "Create and validate the initial HIP implementation for "
            "m2_wqkv_a."
        ),
        "generated_files": ["csrc/w8a8_gemm_hip.hip"],
        "metrics": {},
        "artifact_dir": None,
        "candidate_files": [],
        "error": None,
        "elapsed_s": 12.5,
        "last_output_age_s": 0.5,
        "started_at": None,
    }]


def test_worker_lanes_surface_live_bootstrap_performance_metrics(tmp_path):
    workspace = tmp_path / "workspace"
    state = tmp_path / "state"
    worker = workspace / "workers" / "worker_0"
    source = worker / "source"
    source.mkdir(parents=True)
    state.mkdir()
    workspace.joinpath("plan.json").write_text(json.dumps({
        "assignments": [{
            "worker_id": "worker_0",
            "gpu": 0,
            "shapes": ["m2_wqkv_a"],
        }],
    }), encoding="utf-8")
    state.joinpath("agents.json").write_text(json.dumps({
        "agents": [{
            "name": "worker_0-bootstrap-attempt1",
            "status": "completed",
            "success": True,
        }],
    }), encoding="utf-8")
    metrics = {
        "passed": True,
        "median_us": 8.25,
        "p90_us": 8.75,
        "tflops": 19.5,
        "bandwidth_gb_s": 812.0,
    }
    worker.joinpath("bootstrap_progress.json").write_text(json.dumps({
        "attempt": 1,
        "status": "validating",
        "hypothesis": "Use a DUMMA tiled kernel.",
        "metrics": {"m2_wqkv_a": metrics},
    }), encoding="utf-8")

    attempt = read_worker_lanes(
        workspace, state
    )["workers"][0]["bootstrap_attempts"][0]

    assert attempt["status"] == "validating"
    assert attempt["hypothesis"] == "Use a DUMMA tiled kernel."
    assert attempt["metrics"]["m2_wqkv_a"] == metrics


def test_worker_lanes_surface_bootstrap_iteration_snapshot(tmp_path):
    workspace = tmp_path / "workspace"
    state = tmp_path / "state"
    worker = workspace / "workers" / "worker_0"
    record = (
        worker / "iterations" / "bootstrap"
        / "iteration1" / "iteration.json"
    )
    record.parent.mkdir(parents=True)
    state.mkdir()
    workspace.joinpath("plan.json").write_text(json.dumps({
        "assignments": [{
            "worker_id": "worker_0",
            "gpu": 0,
            "shapes": ["m2"],
        }],
    }), encoding="utf-8")
    state.joinpath("agents.json").write_text(json.dumps({
        "agents": [{
            "name": "worker_0-bootstrap-attempt1",
            "status": "done",
            "success": True,
        }],
    }), encoding="utf-8")
    record.write_text(json.dumps({
        "attempt": 1,
        "status": "failed",
        "error": "trusted compile failed",
        "artifact_dir": "iterations/bootstrap/iteration1",
        "candidate_files": ["csrc/w8a8_gemm_hip.hip"],
        "metrics": {},
    }), encoding="utf-8")

    attempt = read_worker_lanes(
        workspace, state
    )["workers"][0]["bootstrap_attempts"][0]

    assert attempt["status"] == "failed"
    assert attempt["error"] == "trusted compile failed"
    assert attempt["artifact_dir"] == "iterations/bootstrap/iteration1"
    assert attempt["candidate_files"] == ["csrc/w8a8_gemm_hip.hip"]


# --------------------------------------------------------------------------- #
# The row's speedup must use this board's baseline
# --------------------------------------------------------------------------- #


def test_a_pre_split_baseline_is_rebased_for_display(monkeypatch):
    """The reported confusion: task row 1.967x vs variant 超基线 2.55x.

    ``1.967`` is ``19.984 / 10.16`` -- the reference board's baseline, which is
    what the task ran against before the profile split.  The page must show the
    same ratio as the variant (this board's baseline), while keeping the
    recorded pair so nothing is hidden.
    """
    from metainfer.orchestrator import hw_profile
    from ..server.routes import localize_experiment_baseline

    monkeypatch.setenv("METAINFER_HW_PROFILE", "air-k100ai")
    hw_profile.clear_cache()
    row = {"shape_id": "minimax_tp8_shared_down_proj_m8", "median_us": 10.16,
           "baseline_us": 19.984, "speedup": 1.967086}
    out = localize_experiment_baseline(
        row, row["shape_id"], {"M": 8, "N": 6144, "K": 384, "tp_size": 8}
    )
    assert out["baseline_us"] == 25.936              # this board's table
    assert out["speedup"] == pytest.approx(2.55296, rel=1e-4)
    assert out["recorded_baseline_us"] == 19.984     # history kept, not hidden
    assert out["recorded_speedup"] == 1.967086
    assert out["baseline_profile"] == "air-k100ai"
    assert row["speedup"] == 1.967086                # the input is not mutated
    hw_profile.clear_cache()


def test_a_baseline_that_is_already_local_is_left_alone(monkeypatch):
    from metainfer.orchestrator import hw_profile
    from ..server.routes import localize_experiment_baseline

    monkeypatch.setenv("METAINFER_HW_PROFILE", "air-k100ai")
    hw_profile.clear_cache()
    row = {"shape_id": "s", "median_us": 10.16, "baseline_us": 25.936,
           "speedup": 2.553}
    out = localize_experiment_baseline(row, "s", {"M": 8, "N": 6144, "K": 384})
    assert out is row and "recorded_speedup" not in out
    hw_profile.clear_cache()


def test_the_reference_machine_keeps_its_own_numbers(monkeypatch):
    """On the liquid board those baselines ARE local: no rewriting."""
    from metainfer.orchestrator import hw_profile
    from ..server.routes import localize_experiment_baseline

    monkeypatch.setenv("METAINFER_HW_PROFILE", "liquid-k500sm")
    hw_profile.clear_cache()
    row = {"shape_id": "s", "median_us": 10.16, "baseline_us": 19.984,
           "speedup": 1.967086}
    out = localize_experiment_baseline(row, "s", {"M": 8, "N": 6144, "K": 384})
    assert out is row
    hw_profile.clear_cache()


def test_an_unmeasured_shape_or_missing_numbers_are_left_alone(monkeypatch):
    from metainfer.orchestrator import hw_profile
    from ..server.routes import localize_experiment_baseline

    monkeypatch.setenv("METAINFER_HW_PROFILE", "air-k100ai")
    hw_profile.clear_cache()
    row = {"shape_id": "s", "median_us": 10.16, "baseline_us": 19.984,
           "speedup": 1.967086}
    # No shape params -> cannot look this board's number up.
    assert localize_experiment_baseline(row, "s", None) is row
    # Not in this board's table -> nothing to rebase onto.
    assert localize_experiment_baseline(row, "s", {"M": 8, "N": 1, "K": 1}) is row
    # No median -> no ratio to compute.
    assert localize_experiment_baseline(
        {"shape_id": "s", "baseline_us": 19.984}, "s", {"M": 8, "N": 6144, "K": 384}
    ) is not None
    hw_profile.clear_cache()


def test_read_worker_lanes_rebases_the_rows_it_serves(tmp_path, monkeypatch):
    """End of the wire: what the page gets is already on this board's scale."""
    import json

    from metainfer.orchestrator import hw_profile
    from ..server.routes import read_worker_lanes

    monkeypatch.setenv("METAINFER_HW_PROFILE", "air-k100ai")
    hw_profile.clear_cache()
    workspace = tmp_path / "ws"
    run = workspace / "workers" / "worker_0" / "runs" / "001"
    run.mkdir(parents=True)
    (workspace / "plan.json").write_text(json.dumps({
        "shapes": [{"id": "minimax_tp8_shared_down_proj_m8", "M": 8, "N": 6144,
                    "K": 384, "tp_size": 8}],
        "assignments": [{"worker_id": "worker_0",
                         "shapes": ["minimax_tp8_shared_down_proj_m8"]}],
    }), encoding="utf-8")
    (run / "experiments.jsonl").write_text(json.dumps({
        "shape_id": "minimax_tp8_shared_down_proj_m8", "iteration": 3,
        "accepted": True, "median_us": 10.16, "baseline_us": 19.984,
        "speedup": 1.967086, "metrics": {"median_us": 10.16},
    }) + "\n", encoding="utf-8")

    lane = read_worker_lanes(workspace)["workers"][0]
    row = lane["experiments"][0]
    assert row["speedup"] == pytest.approx(2.55296, rel=1e-4)
    assert row["baseline_us"] == 25.936
    assert row["recorded_speedup"] == 1.967086
    hw_profile.clear_cache()
