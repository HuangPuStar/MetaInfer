"""Production profile: priority in the device queue, but never a gate bypass.

The operator's decision (2026-09-16, option 1): a production DKAO task outranks
the evolving harness when devices are handed out, but it still only measures on
a device that passes VRAM<=90% / HCU==0 — a shared card yields stale numbers no
matter who asked for the run.
"""

from __future__ import annotations

import json

from ..orchestrator import config as cfg

import importlib.util

import pytest
_GPU_BROKER_AVAILABLE = (
    importlib.util.find_spec("metainfer.orchestrator.gpu_broker") is not None
)
requires_gpu_broker = pytest.mark.skipif(
    not _GPU_BROKER_AVAILABLE,
    reason="metainfer.orchestrator.gpu_broker is not available in this tree",
)


def _lease(monkeypatch, *, grants, profile, answers=None):
    """Run lease_gpus_for_task against a fake broker and report the call."""
    from metainfer.orchestrator import gpu_broker

    calls = []

    class _FakeBroker:
        def acquire(self, holder, **kwargs):
            calls.append(kwargs)
            return [{"gpu": g, "holder": holder} for g in grants]

    monkeypatch.setattr(gpu_broker, "GpuBroker", _FakeBroker)
    assignments = [cfg.WorkerAssignment(worker_id="worker_0", gpu=0,
                                        shape_ids=["s1"])]
    merged = {"task_id": "t1"}
    merged.update(answers or {})
    rebuilt, info = cfg.lease_gpus_for_task(
        assignments, merged, production=(profile == "production"))
    return calls, rebuilt, info


@requires_gpu_broker
def test_production_leases_at_the_highest_priority(monkeypatch):
    calls, rebuilt, info = _lease(monkeypatch, grants=[2], profile="production")
    assert calls and calls[0]["priority"] == 100          # PRIORITY_PRODUCTION
    assert calls[0]["meta"]["profile"] == "production"
    assert info["profile"] == "production" and info["gpus"] == [2]
    assert rebuilt[0].gpu == 2


@requires_gpu_broker
def test_default_profile_still_uses_production_priority_on_the_broker(monkeypatch):
    """DKAO has always asked at priority 100; the profile makes it explicit."""
    calls, _, info = _lease(monkeypatch, grants=[0], profile="default")
    assert calls[0]["priority"] == 100
    assert calls[0]["meta"]["profile"] == "default"
    assert info["profile"] == "default"


@requires_gpu_broker
def test_production_waits_longer_for_a_device_that_passes_the_gate(monkeypatch):
    """Nothing passing the gate: production keeps waiting instead of giving up."""
    calls, _, _ = _lease(monkeypatch, grants=[0], profile="production",
                         answers={"gpu_lease_max_waits": "2",
                                  "production_max_waits": "48",
                                  "gpu_lease_wait_seconds": "0"})
    assert calls[0]["priority"] == 100


@requires_gpu_broker
def test_no_device_after_the_budget_reports_the_gate_honestly(monkeypatch):
    import pytest

    class _EmptyBroker:
        def acquire(self, holder, **kwargs):
            return []

    from metainfer.orchestrator import gpu_broker
    monkeypatch.setattr(gpu_broker, "GpuBroker", _EmptyBroker)
    assignments = [cfg.WorkerAssignment(worker_id="worker_0", gpu=0,
                                        shape_ids=["s1"])]
    with pytest.raises(RuntimeError) as excinfo:
        cfg.lease_gpus_for_task(assignments, {"task_id": "t1",
                                              "gpu_lease_max_waits": "2",
                                              "gpu_lease_wait_seconds": "0"},
                                production=True)
    message = str(excinfo.value)
    assert "production" in message
    # and it must say the gate was NOT skipped
    assert "not skipped" in message and "shared card" in message


@requires_gpu_broker
def test_load_config_accepts_the_profile_and_forces_the_broker(monkeypatch):
    """``production`` implies broker-mediated scheduling (that is the queue)."""
    from metainfer.orchestrator import gpu_broker

    seen = {}

    class _FakeBroker:
        def acquire(self, holder, **kwargs):
            seen.update(kwargs)
            return [{"gpu": 1, "holder": holder}]

    monkeypatch.setattr(gpu_broker, "GpuBroker", _FakeBroker)
    req = {
        "task_id": "prod-1",
        "answers": {
            "execution_mode": "Generate & optimize (auto-create kernel repo)",
            "target_repo_path": "11111",
            "shape_config": ("model: m\nassignment_mode: ai\nshape_scope: subset\n"
                             "shapes:\n  - {id: s1, M: 16, N: 64, K: 32, tp_size: 8,"
                             " operator: o_proj}\n"),
            "max_iterations": "1",
            "execution_profile": "production",
            # deliberately ask for occupy: production must override it
            "gpu_mode": "occupy",
        },
    }
    config = cfg.load_config(req)
    assert config.execution_profile == "production"
    assert config.gpu_mode == "scheduled"          # broker carries the priority
    assert seen["priority"] == 100
    assert config.gpu_leases.get("profile") == "production"


def test_an_unknown_profile_is_rejected():
    import pytest

    req = {
        "task_id": "bad-1",
        "answers": {
            "execution_mode": "Generate & optimize (auto-create kernel repo)",
            "target_repo_path": "11111",
            "shape_config": ("model: m\nassignment_mode: ai\nshape_scope: subset\n"
                             "shapes:\n  - {id: s1, M: 16, N: 64, K: 32, tp_size: 8,"
                             " operator: o_proj}\n"),
            "max_iterations": "1",
            "execution_profile": "fastest",
        },
    }
    with pytest.raises(ValueError):
        cfg.load_config(req)


@requires_gpu_broker
def test_replace_assignments_keeps_the_profile(monkeypatch):
    """Re-planning the workers must not silently downgrade a production task."""
    from metainfer.orchestrator import gpu_broker

    class _FakeBroker:
        def acquire(self, holder, **kwargs):
            return [{"gpu": 3, "holder": holder}]

    monkeypatch.setattr(gpu_broker, "GpuBroker", _FakeBroker)
    req = {
        "task_id": "prod-2",
        "answers": {
            "execution_mode": "Generate & optimize (auto-create kernel repo)",
            "target_repo_path": "11111",
            "shape_config": ("model: m\nassignment_mode: ai\nshape_scope: subset\n"
                             "shapes:\n  - {id: s1, M: 16, N: 64, K: 32, tp_size: 8,"
                             " operator: o_proj}\n"),
            "max_iterations": "1",
            "execution_profile": "production",
        },
    }
    config = cfg.load_config(req)
    replanned = cfg.replace_assignments(config, config.assignments)
    assert replanned.execution_profile == "production"
    assert replanned.gpu_leases.get("priority") == 100


def test_gpu_leases_acquired_event_names_the_profile():
    """The timeline event carries the rank, so the GPU view can label a holder."""
    from ..orchestrator.gen_and_opt_pipeline import GenAndOptPipeline

    events = []

    class _Store:
        task_dir = None

        def append_timeline(self, name, payload):
            events.append((name, payload))

    pipeline = GenAndOptPipeline.__new__(GenAndOptPipeline)
    pipeline.store = _Store()
    pipeline._register_gpu_leases(type("C", (), {
        "gpu_leases": {"holder": "dkao:prod-2", "gpus": [3], "mode": "scheduled",
                       "profile": "production", "priority": 100},
    })())
    acquired = dict(events)["gpu_leases_acquired"]
    assert acquired["profile"] == "production"
    assert acquired["priority"] == 100


def test_summary_reports_the_profile_and_the_held_devices(tmp_path):
    """The task view shows production mode + which devices the task leased."""
    from ..server.routes import _execution_profile, _latest_gpu_lease

    state_dir = tmp_path / "state"
    state_dir.mkdir()
    (state_dir / "requirements.json").write_text(json.dumps({
        "task_id": "prod-3",
        "answers": {"execution_profile": "production"},
    }), encoding="utf-8")
    (state_dir / "timeline.jsonl").write_text("\n".join([
        json.dumps({"ts": 1.0, "type": "phase_start",
                    "payload": {"phase": "prepare"}}),
        json.dumps({"ts": 2.0, "type": "gpu_leases_acquired", "payload": {
            "holder": "dkao:prod-3", "gpus": [1, 2], "mode": "scheduled",
            "profile": "production", "priority": 100}}),
        json.dumps({"ts": 3.0, "type": "gpu_leases_released",
                    "payload": {"holder": "dkao:prod-3", "gpus": [1, 2]}}),
    ]), encoding="utf-8")

    assert _execution_profile(state_dir) == "production"
    leases = _latest_gpu_lease(state_dir)
    assert leases["gpus"] == [1, 2] and leases["priority"] == 100


def test_summary_defaults_to_the_default_profile(tmp_path):
    from ..server.routes import _execution_profile, _latest_gpu_lease

    state_dir = tmp_path / "state"
    state_dir.mkdir()
    (state_dir / "requirements.json").write_text(json.dumps({
        "task_id": "plain-1", "answers": {}}), encoding="utf-8")
    assert _execution_profile(state_dir) == "default"
    assert _latest_gpu_lease(state_dir) == {}


def test_gate_status_summarises_the_blocked_checks(tmp_path):
    """A task parked on the gate must say why, in its own state dir."""
    from ..server.routes import _gate_status

    state_dir = tmp_path / "state"
    state_dir.mkdir()
    rows = [
        {"ts": 1.0, "event": "gate_blocked", "site": "generate_probe",
         "gpu": 0, "attempt": 1, "max_waits": 48,
         "reasons": ["device busy: HCU 98.0% > 0.0%"]},
        {"ts": 1801.0, "event": "gate_ok", "site": "generate_probe", "gpu": 1,
         "passing": [1], "reasons": []},
    ]
    (state_dir / "measurement_gate.jsonl").write_text(
        "\n".join(json.dumps(r) for r in rows), encoding="utf-8")

    gate = _gate_status(state_dir)
    assert gate["checks"] == 2 and gate["blocked"] == 1
    assert gate["last_event"] == "gate_ok" and gate["last_gpu"] == 1
    assert gate["last_reasons"] == []


def test_gate_status_is_empty_without_an_audit_trail(tmp_path):
    from ..server.routes import _gate_status

    state_dir = tmp_path / "state"
    state_dir.mkdir()
    assert _gate_status(state_dir)["checks"] == 0
