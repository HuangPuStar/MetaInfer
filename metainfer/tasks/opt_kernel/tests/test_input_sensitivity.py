"""Tests for the input-sensitivity probe (anti "cached output" reward-hack).

The perf oracle times the agent's kernel via CUDA-Graph replay / repeated
calls on the SAME input tensors. A kernel that caches its output keyed on
tensor identity (or ignores its inputs entirely) makes every timed replay a
near-free cache return while still passing the single-shot correctness check.
``_input_sensitivity_check`` mutates the inputs in place and re-runs the kernel
to catch this; these tests cover the direct (CPU) probe path.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest


# The identity-cache kernel produces an empty CUDA graph (cache hit -> no GPU
# ops); the capture emits a benign UserWarning we expect and want to silence.
pytestmark = pytest.mark.filterwarnings("ignore::UserWarning")


# --------------------------------------------------------------------------- #
# helpers: build faithful / cheating kernels
# --------------------------------------------------------------------------- #

def _faithful_kernel():
    from metainfer.tasks.opt_kernel.orchestrator.oracles.perf import reference_w8a8_scaled_mm
    def w8a8_scaled_mm(x_q, weight, x_scale, weight_scale, out_dtype):
        return reference_w8a8_scaled_mm(x_q, weight, x_scale, weight_scale, out_dtype)
    return w8a8_scaled_mm


def _constant_output_kernel():
    """Output independent of inputs (always returns a constant)."""
    import torch
    def w8a8_scaled_mm(x_q, weight, x_scale, weight_scale, out_dtype):
        M, _ = x_q.shape
        _, N = weight.shape
        return torch.full((M, N), 5.0, dtype=out_dtype, device=x_q.device)
    return w8a8_scaled_mm


def _identity_cache_kernel():
    """Caches output keyed on ``id(x_q)`` — the realistic graph-replay hack."""
    import torch
    from metainfer.tasks.opt_kernel.orchestrator.oracles.perf import reference_w8a8_scaled_mm
    cache: dict = {}

    def w8a8_scaled_mm(x_q, weight, x_scale, weight_scale, out_dtype):
        key = id(x_q)
        if key in cache:
            return cache[key]
        out = reference_w8a8_scaled_mm(x_q, weight, x_scale, weight_scale, out_dtype)
        cache[key] = out
        return out
    return w8a8_scaled_mm


def _make_inputs(device="cpu"):
    import torch
    torch.manual_seed(42)
    M, K, N = 8, 8, 8
    x_q = torch.randint(-127, 127, (M, K), dtype=torch.int8, device=device)
    weight = torch.randint(-127, 127, (K, N), dtype=torch.int8, device=device)
    x_scale = torch.rand(M, 1, dtype=torch.float32, device=device) * 0.01 + 0.001
    weight_scale = torch.rand(N, 1, dtype=torch.float32, device=device) * 0.01 + 0.001
    return x_q, weight, x_scale, weight_scale, torch.bfloat16


# --------------------------------------------------------------------------- #
# _input_sensitivity_check (direct / CPU probe)
# --------------------------------------------------------------------------- #

def test_input_sensitivity_faithful_kernel_passes():
    from metainfer.tasks.opt_kernel.orchestrator.oracles.perf import KernelPerfOracle
    x_q, weight, x_scale, weight_scale, out_dtype = _make_inputs()
    ok, err = KernelPerfOracle()._input_sensitivity_check(
        _faithful_kernel(), x_q, weight, x_scale, weight_scale, out_dtype)
    assert ok is True
    assert err is None


def test_input_sensitivity_constant_output_is_caught():
    from metainfer.tasks.opt_kernel.orchestrator.oracles.perf import KernelPerfOracle
    x_q, weight, x_scale, weight_scale, out_dtype = _make_inputs()
    ok, err = KernelPerfOracle()._input_sensitivity_check(
        _constant_output_kernel(), x_q, weight, x_scale, weight_scale, out_dtype)
    assert ok is False
    assert "input-insensitivity" in err


def test_input_sensitivity_identity_cache_is_caught():
    """A kernel that caches by tensor identity passes a single-shot check but
    must fail the mutate-and-rerun probe (the realistic graph-replay hack)."""
    from metainfer.tasks.opt_kernel.orchestrator.oracles.perf import KernelPerfOracle
    x_q, weight, x_scale, weight_scale, out_dtype = _make_inputs()
    k = _identity_cache_kernel()
    # simulate the perf oracle's correctness + warmup calls on the original
    # tensors, which populate the identity-keyed cache BEFORE the probe runs.
    k(x_q, weight, x_scale, weight_scale, out_dtype)
    ok, err = KernelPerfOracle()._input_sensitivity_check(
        k, x_q, weight, x_scale, weight_scale, out_dtype)
    assert ok is False
    assert "input-insensitivity" in err


def test_input_sensitivity_restores_inputs_after_check():
    """The probe must leave the input tensors as it found them (downstream /
    baseline code may reuse them). Verify byte-for-byte restoration."""
    import torch
    from metainfer.tasks.opt_kernel.orchestrator.oracles.perf import KernelPerfOracle
    x_q, weight, x_scale, weight_scale, out_dtype = _make_inputs()
    snap = (x_q.clone(), weight.clone(), x_scale.clone(), weight_scale.clone())
    KernelPerfOracle()._input_sensitivity_check(
        _faithful_kernel(), x_q, weight, x_scale, weight_scale, out_dtype)
    assert torch.equal(x_q, snap[0])
    assert torch.equal(weight, snap[1])
    assert torch.equal(x_scale, snap[2])
    assert torch.equal(weight_scale, snap[3])


def test_input_sensitivity_crashing_kernel_reported_not_raised():
    from metainfer.tasks.opt_kernel.orchestrator.oracles.perf import KernelPerfOracle
    def boom(x_q, weight, x_scale, weight_scale, out_dtype):
        raise RuntimeError("kaboom")
    x_q, weight, x_scale, weight_scale, out_dtype = _make_inputs()
    ok, err = KernelPerfOracle()._input_sensitivity_check(
        boom, x_q, weight, x_scale, weight_scale, out_dtype)
    assert ok is False
    assert "crashed" in err


# --------------------------------------------------------------------------- #
# Integration through _benchmark_gemm (wiring: check zeroes correctness)
# --------------------------------------------------------------------------- #

def _write_kernel_module(tmp_path: Path, body: str) -> Path:
    (tmp_path / "kernel.py").write_text(body, encoding="utf-8")
    import importlib.util, sys
    spec = importlib.util.spec_from_file_location("agent_kernel_is_test", tmp_path / "kernel.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["agent_kernel_is_test"] = mod
    spec.loader.exec_module(mod)
    return mod


def test_benchmark_gemm_rejects_identity_cache_kernel(tmp_path):
    """End-to-end: an identity-caching kernel that would fool repeated-call
    timing is caught by the probe wired into ``_benchmark_gemm`` — its
    per-shape ``correct`` flips False and the error names the hack."""
    body = (
        "import torch\n"
        "from metainfer.tasks.opt_kernel.orchestrator.oracles.perf "
        "import reference_w8a8_scaled_mm as _ref\n"
        "_cache = {}\n"
        "def w8a8_scaled_mm(x_q, weight, x_scale, weight_scale, out_dtype):\n"
        "    key = id(x_q)\n"
        "    if key in _cache:\n"
        "        return _cache[key]\n"
        "    out = _ref(x_q, weight, x_scale, weight_scale, out_dtype)\n"
        "    _cache[key] = out\n"
        "    return out\n"
    )
    mod = _write_kernel_module(tmp_path, body)
    from metainfer.tasks.opt_kernel.orchestrator.oracles.perf import KernelPerfOracle, ShapeResult
    sr = ShapeResult(shape={"M": 8, "K": 8, "N": 8, "path": "decode"})
    out = KernelPerfOracle()._benchmark_gemm(mod, {"M": 8, "K": 8, "N": 8}, {}, sr)
    assert out.correct is False
    assert "input-insensitivity" in (out.error or "")


def test_benchmark_gemm_accepts_faithful_kernel(tmp_path):
    body = (
        "from metainfer.tasks.opt_kernel.orchestrator.oracles.perf "
        "import reference_w8a8_scaled_mm as _ref\n"
        "def w8a8_scaled_mm(x_q, weight, x_scale, weight_scale, out_dtype):\n"
        "    return _ref(x_q, weight, x_scale, weight_scale, out_dtype)\n"
    )
    mod = _write_kernel_module(tmp_path, body)
    from metainfer.tasks.opt_kernel.orchestrator.oracles.perf import KernelPerfOracle, ShapeResult
    sr = ShapeResult(shape={"M": 8, "K": 8, "N": 8, "path": "decode"})
    out = KernelPerfOracle()._benchmark_gemm(mod, {"M": 8, "K": 8, "N": 8}, {}, sr)
    assert out.correct is True, out.error


# --------------------------------------------------------------------------- #
# _input_sensitivity_check (CUDA graph-replay branch)
# --------------------------------------------------------------------------- #
# All tests above run on CPU and therefore only hit the direct-probe fallback.
# This exercises the more subtle graph-replay branch (capture -> in-place
# mutate -> replay -> compare) on a real GPU, and is skipped where CUDA/HIP is
# unavailable so the suite stays hermetic on CI/CPU.

def _cuda_available() -> bool:
    try:
        import torch
        return bool(torch.cuda.is_available())
    except Exception:
        return False


@pytest.mark.skipif(not _cuda_available(), reason="no CUDA/HIP device")
def test_input_sensitivity_graph_replay_faithful_passes():
    import torch
    from metainfer.tasks.opt_kernel.orchestrator.oracles.perf import KernelPerfOracle
    x_q, weight, x_scale, weight_scale, out_dtype = _make_inputs(device="cuda")
    ok, err = KernelPerfOracle()._input_sensitivity_check(
        _faithful_kernel(), x_q, weight, x_scale, weight_scale, out_dtype)
    assert ok is True, err


@pytest.mark.skipif(not _cuda_available(), reason="no CUDA/HIP device")
def test_input_sensitivity_graph_replay_catches_identity_cache():
    """The realistic graph-replay hack: the perf oracle captures a CUDA graph
    of the kernel and replays it for timing; an identity-keyed cache makes
    every replay a free cache return. The graph-replay probe (capture ->
    in-place mutate the SAME tensor -> replay -> compare to the fresh fp32
    reference) must catch this on the GPU path too."""
    import torch
    from metainfer.tasks.opt_kernel.orchestrator.oracles.perf import KernelPerfOracle
    x_q, weight, x_scale, weight_scale, out_dtype = _make_inputs(device="cuda")
    k = _identity_cache_kernel()
    k(x_q, weight, x_scale, weight_scale, out_dtype)  # warmup -> fill cache
    ok, err = KernelPerfOracle()._input_sensitivity_check(
        k, x_q, weight, x_scale, weight_scale, out_dtype)
    assert ok is False
    assert "input-insensitivity" in (err or "")
