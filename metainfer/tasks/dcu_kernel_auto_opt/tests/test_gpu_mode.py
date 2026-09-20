"""DKAO GPU modes: occupy (default, pins devices) vs scheduled (broker leases)."""

from __future__ import annotations

import pytest

import importlib.util

_GPU_BROKER_AVAILABLE = (
    importlib.util.find_spec("metainfer.orchestrator.gpu_broker") is not None
)
requires_gpu_broker = pytest.mark.skipif(
    not _GPU_BROKER_AVAILABLE,
    reason="metainfer.orchestrator.gpu_broker is not available in this tree",
)


def _assignments(spec):
    from ..orchestrator.config import WorkerAssignment
    return [WorkerAssignment(worker_id=w, gpu=g, shape_ids=list(s))
            for w, g, s in spec]


def test_rebalance_merges_workers_when_leases_are_fewer():
    """2 leases + 4 planned workers -> 2 lanes, every shape kept."""
    from ..orchestrator.config import rebalance_for_gpus
    planned = _assignments([
        ("worker_0", 0, ["a"]), ("worker_1", 1, ["b"]),
        ("worker_2", 2, ["c"]), ("worker_3", 3, ["d"]),
    ])
    lanes = rebalance_for_gpus(planned, [2, 3])
    assert len(lanes) == 2                              # one lane per device
    assert sorted(l.gpu for l in lanes) == [2, 3]
    assert {l.worker_id for l in lanes} == {"worker_2", "worker_3"}
    assert sorted(s for l in lanes for s in l.shape_ids) == ["a", "b", "c", "d"]


def test_rebalance_keeps_one_lane_per_worker_when_leases_are_plentiful():
    from ..orchestrator.config import rebalance_for_gpus
    planned = _assignments([("worker_0", 0, ["a"]), ("worker_1", 1, ["b"])])
    lanes = rebalance_for_gpus(planned, [0, 1, 2, 3])
    assert len(lanes) == 2                              # no empty lanes
    assert sorted(l.gpu for l in lanes) == [0, 1]


@requires_gpu_broker
def test_lease_gpus_for_task_layouts_workers_on_leases(monkeypatch):
    from ..orchestrator import config as C
    from metainfer.orchestrator import gpu_broker

    class FakeBroker:
        def __init__(self, *a, **k):
            self.calls = []

        def acquire(self, holder, **kwargs):
            self.calls.append((holder, kwargs))
            return [{"gpu": 2}, {"gpu": 3}]

    monkeypatch.setattr(gpu_broker, "GpuBroker", FakeBroker)
    planned = _assignments([
        ("worker_0", 0, ["a"]), ("worker_1", 1, ["b"]),
        ("worker_2", 2, ["c"]), ("worker_3", 3, ["d"]),
    ])
    lanes, info = C.lease_gpus_for_task(planned, {"task_id": "t-1"})
    assert info["mode"] == "scheduled" and info["gpus"] == [2, 3]
    assert info["holder"] == "dkao:t-1"
    assert info["requested_workers"] == 4
    assert info["mapping"] == {"worker_2": 2, "worker_3": 3}
    assert len(lanes) == 2


@requires_gpu_broker
def test_lease_gpus_for_task_fails_loudly_when_nothing_is_free(monkeypatch):
    from ..orchestrator import config as C
    from metainfer.orchestrator import gpu_broker

    class EmptyBroker:
        def __init__(self, *a, **k):
            pass

        def acquire(self, holder, **kwargs):
            return []

    monkeypatch.setattr(gpu_broker, "GpuBroker", EmptyBroker)
    with pytest.raises(RuntimeError, match="no GPU lease"):
        C.lease_gpus_for_task(_assignments([("worker_0", 0, ["a"])]),
                              {"task_id": "t-2", "gpu_lease_max_waits": 2})


def test_scheduled_mode_skips_manual_pin_validation():
    """manual (worker_N -> GPU N) is only enforced in occupy mode."""
    from ..orchestrator.config import OptimizerConfig, WorkerAssignment
    import dataclasses
    base = dict(operator="Quantized GEMM", dtype="INT8 W8A8", hardware="dcu",
                kernel_language="HIP C++", claude_model="m",
                execution_mode="gen_and_opt", target_repo_path=None,
                shapes={}, assignments=[WorkerAssignment("worker_2", 3, ["a"])],
                shape_scope="all", mock_iterations=1,
                minimum_improvement_percent=1.0)
    occupy = OptimizerConfig(assignment_mode="manual", **base)
    scheduled = OptimizerConfig(assignment_mode="scheduled", gpu_mode="scheduled",
                                **base)
    assert occupy.gpu_mode == "occupy"
    assert scheduled.gpu_mode == "scheduled"
    # the pipeline only validates worker_N -> GPU N for occupy
    assert (occupy.assignment_mode == "manual" and occupy.gpu_mode == "occupy")
    assert not (scheduled.assignment_mode == "manual"
                and scheduled.gpu_mode == "occupy")
