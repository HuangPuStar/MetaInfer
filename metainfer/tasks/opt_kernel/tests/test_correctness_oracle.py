"""Tests for the opt-kernel correctness oracle (immutable C-phase referee).

Coverage:
  - shape resolution (representative + edge cases, K/N from req)
  - report structure / serialization
  - SSOT module helpers shared with perf oracle (parse_kv_shapes, import_kernel,
    reference_w8a8_scaled_mm)
  - run() branches: kernel missing / no entry point / wrong kernel caught /
    correct kernel passes
  - the oracle is the referee (contestant/referee separation): a kernel that
    returns zeros is flagged even though it never "crashes"

The shape-heavy paths use monkeypatched tiny shapes so the suite runs on CPU
in milliseconds (no GPU, no large GEMM).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from metainfer.tasks.opt_kernel.orchestrator.oracles.correctness import (
    CORRECTNESS_ATOL,
    CORRECTNESS_ORACLE_VERSION,
    CORRECTNESS_RTOL,
    CorrectnessReport,
    KernelCorrectnessOracle,
)
from metainfer.tasks.opt_kernel.orchestrator.oracles.perf import (
    import_kernel,
    parse_kv_shapes,
    reference_w8a8_scaled_mm,
)


# --------------------------------------------------------------------------- #
# Shape resolution
# --------------------------------------------------------------------------- #

def test_resolve_shapes_default_has_representative_and_edge():
    o = KernelCorrectnessOracle()
    shapes = o._resolve_correctness_shapes({})
    Ms = {s["M"] for s in shapes}
    # representative (perf-measured) must all be present
    assert {1, 8, 16, 32, 4096} <= Ms
    # edge cases
    assert {"M": 17, "K": 4096, "N": 4096} in shapes      # odd M
    assert any(s["K"] == 300 for s in shapes)              # K not multiple of BLOCK_K
    assert any(s["K"] == 4090 for s in shapes)             # K tail (unaligned)
    assert any(s["K"] == 1 for s in shapes)                # degenerate K=1
    assert any(s["N"] == 32 for s in shapes)               # small N


def test_resolve_shapes_overrides_kn_from_req():
    o = KernelCorrectnessOracle()
    shapes = o._resolve_correctness_shapes({"input_shapes": "M=4096,K=1024,N=8192"})
    # Design contract:
    #   - representative shapes (M in 1/8/16/32/4096) + odd-M edge use the
    #     overridden K/N
    #   - K-tail edges use fixed K (300/4090/1) with the overridden N
    #   - small-N edge uses fixed N=32 with the overridden K
    assert {"M": 4096, "K": 1024, "N": 8192} in shapes   # representative uses override
    assert {"M": 17, "K": 1024, "N": 8192} in shapes    # odd-M uses override
    assert any(s["K"] == 300 and s["N"] == 8192 for s in shapes)  # K-tail edge
    assert any(s["K"] == 1 and s["N"] == 8192 for s in shapes)    # degenerate-K edge
    assert any(s["N"] == 32 and s["K"] == 1024 for s in shapes)  # small-N edge


def test_resolve_shapes_count_is_stable():
    """Lock the shape count so adding/removing an edge case is a deliberate
    test change (not a silent drift)."""
    o = KernelCorrectnessOracle()
    shapes = o._resolve_correctness_shapes({})
    # 5 representative + 5 edge + 3 stress probes = 13
    assert len(shapes) == 13


def test_resolve_shapes_has_stress_probes():
    """Stress-probe shapes (saturated / gaussian fills) are present so a
    kernel that overfits the default uniform distribution still gets checked
    on structurally different inputs (KDA reward-hacking defense)."""
    o = KernelCorrectnessOracle()
    shapes = o._resolve_correctness_shapes({})
    fills = {s.get("fill") for s in shapes}
    assert "saturated" in fills
    assert "gaussian" in fills
    # representative / edge shapes carry no fill key (default = uniform)
    assert any("fill" not in s for s in shapes)


def test_resolve_shapes_stress_uses_overridden_kn():
    """Stress probes honor ``input_shapes`` overrides (same as edge cases)."""
    o = KernelCorrectnessOracle()
    shapes = o._resolve_correctness_shapes({"input_shapes": "K=1024,N=8192"})
    sat = [s for s in shapes if s.get("fill") == "saturated"]
    assert all(s["K"] == 1024 and s["N"] == 8192 for s in sat)


# --------------------------------------------------------------------------- #
# Report structure
# --------------------------------------------------------------------------- #

def test_report_to_dict_is_serializable_and_stamped():
    r = CorrectnessReport(task_id="t1", iteration=7, all_correct=True,
                          n_total=10, n_pass=10)
    d = r.to_dict()
    assert d["oracle_version"] == CORRECTNESS_ORACLE_VERSION
    assert d["all_correct"] is True
    assert d["tolerance"] == {"atol": CORRECTNESS_ATOL, "rtol": CORRECTNESS_RTOL}
    # round-trips through json
    json.dumps(d)


# --------------------------------------------------------------------------- #
# SSOT module helpers (shared with perf oracle)
# --------------------------------------------------------------------------- #

def test_parse_kv_shapes():
    assert parse_kv_shapes("M=4096,K=4096,N=4096") == {"M": 4096, "K": 4096, "N": 4096}
    assert parse_kv_shapes("") == {}
    # tolerates ';' separators (perf oracle accepts both)
    assert parse_kv_shapes("K=1024;N=8192") == {"K": 1024, "N": 8192}


def test_import_kernel_missing_returns_none(tmp_path: Path):
    assert import_kernel(tmp_path) is None


def test_import_kernel_loads_module(tmp_path: Path):
    (tmp_path / "kernel.py").write_text("VALUE = 42\n", encoding="utf-8")
    m = import_kernel(tmp_path)
    assert m is not None
    assert m.VALUE == 42


# --------------------------------------------------------------------------- #
# Per-run salt + distribution holdouts (KDA anti-overfit)
# --------------------------------------------------------------------------- #

def test_oracle_seed_is_deterministic_and_varies():
    """``_oracle_seed`` is reproducible for (task,iter) but varies across them."""
    from metainfer.tasks.opt_kernel.orchestrator.oracles.correctness import _oracle_seed
    assert _oracle_seed("t", 1) == _oracle_seed("t", 1)   # reproducible
    assert _oracle_seed("t", 1) != _oracle_seed("t", 2)    # varies by iter
    assert _oracle_seed("t", 1) != _oracle_seed("u", 1)    # varies by task


def test_gen_inputs_fill_distributions_differ():
    """Each ``fill`` produces a recognizably different input distribution."""
    import torch
    from metainfer.tasks.opt_kernel.orchestrator.oracles.correctness import _gen_inputs
    torch.manual_seed(0)
    xq_u, _, _, _ = _gen_inputs(64, 64, 64, "cpu", seed=123, fill="uniform")
    xq_s, _, _, _ = _gen_inputs(64, 64, 64, "cpu", seed=123, fill="saturated")
    xq_g, _, _, _ = _gen_inputs(64, 64, 64, "cpu", seed=123, fill="gaussian")
    # saturated is only {-127, 127}
    vals = set(int(v) for v in xq_s.flatten().unique().tolist())
    assert vals <= {-127, 127}
    # uniform and gaussian span a range and are NOT the all-extreme set
    assert set(int(v) for v in xq_u.flatten().unique().tolist()) != {-127, 127}
    assert set(int(v) for v in xq_g.flatten().unique().tolist()) != {-127, 127}
    # same seed → same inputs (reproducibility)
    xq_u2, _, _, _ = _gen_inputs(64, 64, 64, "cpu", seed=123, fill="uniform")
    assert torch.equal(xq_u, xq_u2)


def test_saturated_fill_stays_atol_dominated_at_production_k():
    """Regression for the saturated false-positive risk: at production K=4096
    the saturated fill must keep the dequantized output in the atol-dominated
    regime (max |out| << atol/rtol = 1.0/0.01 = 100). Pre-fix (scales ~0.04)
    the output magnitude was ~1600 → rtol-dominated → a faithful non-
    bit-identical kernel (tiled / split-K, accumulates in a different order
    than the fp32 reference) could be ~2 bf16 ulps off (~25) and exceed the
    ~17 tolerance window → false reject. With uniform-range scales the
    stress is the all-±127 input magnitude, not a blown-up output."""
    import torch
    from metainfer.tasks.opt_kernel.orchestrator.oracles.correctness import _gen_inputs
    x_q, w, xs, ws = _gen_inputs(4096, 4096, 4096, "cpu", seed=7, fill="saturated")
    ref = reference_w8a8_scaled_mm(x_q, w, xs, ws, torch.bfloat16)
    mag = float(ref.abs().max().item())
    # atol-dominated: well under atol/rtol = 100, so tolerance (~1.0 + 0.01*mag)
    # is dominated by atol and comfortably exceeds a few bf16 ulps (which scale
    # with mag). Keeps the extreme-quantization stress WITHOUT false-rejecting
    # faithful kernels at large K.
    assert mag < 50.0, f"saturated output magnitude {mag} is rtol-dominated"


def test_run_stamps_oracle_seed(tmp_path, tiny_shapes):
    """``run()`` records the per-run salt on the report for replay."""
    (tmp_path / "kernel.py").write_text(
        "from metainfer.tasks.opt_kernel.orchestrator.oracles.perf "
        "import reference_w8a8_scaled_mm as _ref\n"
        "def w8a8_scaled_mm(x_q, weight, x_scale, weight_scale, out_dtype):\n"
        "    return _ref(x_q, weight, x_scale, weight_scale, out_dtype)\n",
        encoding="utf-8",
    )
    o = KernelCorrectnessOracle()
    rep = o.run(iter_dir=tmp_path, req={"task_id": "t"}, report_dir=tmp_path, iteration=7)
    assert rep.oracle_seed is not None and isinstance(rep.oracle_seed, int)
    assert (tmp_path / "correctness_report.json").is_file()
    written = json.loads((tmp_path / "correctness_report.json").read_text())
    assert written["oracle_version"] == "iter2-salt-stress"
    assert written["oracle_seed"] == rep.oracle_seed


def test_run_correct_kernel_passes_on_stress_shapes(tmp_path):
    """A genuinely correct kernel passes the saturated/gaussian probes too —
    confirms the stress shapes are not over-strict (the reference matches).
    Uses tiny M so it runs on CPU fast."""
    import metainfer.tasks.opt_kernel.orchestrator.oracles.correctness as C
    (tmp_path / "kernel.py").write_text(
        "from metainfer.tasks.opt_kernel.orchestrator.oracles.perf "
        "import reference_w8a8_scaled_mm as _ref\n"
        "def w8a8_scaled_mm(x_q, weight, x_scale, weight_scale, out_dtype):\n"
        "    return _ref(x_q, weight, x_scale, weight_scale, out_dtype)\n",
        encoding="utf-8",
    )
    stress = [{"M": 1, "K": 4, "N": 4, "fill": f} for f in ("uniform", "saturated", "gaussian")]
    orig = C.KernelCorrectnessOracle._resolve_correctness_shapes
    C.KernelCorrectnessOracle._resolve_correctness_shapes = lambda self, req: stress  # type: ignore
    try:
        o = C.KernelCorrectnessOracle()
        rep = o.run(iter_dir=tmp_path, req={"task_id": "t"}, report_dir=tmp_path, iteration=1)
    finally:
        C.KernelCorrectnessOracle._resolve_correctness_shapes = orig  # type: ignore
    assert rep.all_correct is True, rep.failures


def test_reference_w8a8_scaled_mm_shape_and_dtype():
    import torch
    x = torch.randint(-127, 127, (4, 8), dtype=torch.int8)
    w = torch.randint(-127, 127, (8, 16), dtype=torch.int8)
    xs = torch.rand(4, 1, dtype=torch.float32) * 0.01 + 0.001
    ws = torch.rand(16, 1, dtype=torch.float32) * 0.01 + 0.001
    ref = reference_w8a8_scaled_mm(x, w, xs, ws, torch.bfloat16)
    assert ref.shape == (4, 16)
    assert ref.dtype == torch.bfloat16
    # matches the documented math: acc * x_scale * weight_scale.T
    expected = (x.float() @ w.float()) * xs * ws.squeeze(-1).unsqueeze(0)
    assert torch.allclose(ref.float(), expected, atol=1.0, rtol=1e-1)


# --------------------------------------------------------------------------- #
# run() — early failures (no torch needed)
# --------------------------------------------------------------------------- #

def test_run_kernel_not_found(tmp_path: Path):
    o = KernelCorrectnessOracle()
    rep = o.run(iter_dir=tmp_path, req={"task_id": "t"}, report_dir=tmp_path, iteration=1)
    assert rep.all_correct is False
    assert rep.n_fail == 1
    assert "not found" in rep.notes or "import" in rep.notes
    # report persisted
    written = json.loads((tmp_path / "correctness_report.json").read_text())
    assert written["all_correct"] is False


def test_run_no_entry_point(tmp_path: Path):
    (tmp_path / "kernel.py").write_text("X = 1\n", encoding="utf-8")
    o = KernelCorrectnessOracle()
    rep = o.run(iter_dir=tmp_path, req={}, report_dir=tmp_path, iteration=2)
    assert rep.all_correct is False
    assert rep.n_fail == 1
    assert "w8a8_scaled_mm" in rep.failures[0]["error"]


# --------------------------------------------------------------------------- #
# run() — actual correctness gating (tiny shapes via monkeypatch)
# --------------------------------------------------------------------------- #

_TINY_SHAPES = [{"M": 2, "K": 4, "N": 4}, {"M": 1, "K": 1, "N": 4}]


@pytest.fixture
def tiny_shapes(monkeypatch):
    monkeypatch.setattr(
        KernelCorrectnessOracle, "_resolve_correctness_shapes",
        lambda self, req: list(_TINY_SHAPES),
    )


def test_run_wrong_kernel_is_caught(tmp_path: Path, tiny_shapes):
    """A kernel that returns a clearly-wrong value (but never crashes) must
    be flagged by the referee — this is the whole point of the immutable
    oracle: the agent's own test.sh might not check these shapes."""
    (tmp_path / "kernel.py").write_text(
        "import torch\n"
        "def w8a8_scaled_mm(x_q, weight, x_scale, weight_scale, out_dtype):\n"
        "    M, N = x_q.shape[0], weight.shape[1]\n"
        "    return torch.full((M, N), 9999.0, dtype=out_dtype, device=x_q.device)\n",
        encoding="utf-8",
    )
    o = KernelCorrectnessOracle()
    rep = o.run(iter_dir=tmp_path, req={}, report_dir=tmp_path, iteration=3)
    assert rep.all_correct is False
    assert rep.n_fail == 2
    assert rep.n_pass == 0
    assert len(rep.failures) == 2
    # each failure records the offending shape + a max_abs_err
    assert rep.failures[0]["max_abs_err"] is not None


def test_run_correct_kernel_passes(tmp_path: Path, tiny_shapes):
    """A kernel that matches the reference on all shapes passes — confirms
    the oracle is not over-strict (a correct kernel is accepted)."""
    (tmp_path / "kernel.py").write_text(
        "from metainfer.tasks.opt_kernel.orchestrator.oracles.perf "
        "import reference_w8a8_scaled_mm as _ref\n"
        "def w8a8_scaled_mm(x_q, weight, x_scale, weight_scale, out_dtype):\n"
        "    return _ref(x_q, weight, x_scale, weight_scale, out_dtype)\n",
        encoding="utf-8",
    )
    o = KernelCorrectnessOracle()
    rep = o.run(iter_dir=tmp_path, req={}, report_dir=tmp_path, iteration=4)
    assert rep.all_correct is True
    assert rep.n_fail == 0
    assert rep.n_pass == 2
    assert (tmp_path / "correctness_report.json").is_file()


def test_run_reports_per_shape_error_detail(tmp_path: Path, tiny_shapes):
    """The failure detail must include the shape + a human-readable error so
    the C debugger can root-cause (the pipeline feeds this into prev_failure)."""
    (tmp_path / "kernel.py").write_text(
        "import torch\n"
        "def w8a8_scaled_mm(x_q, weight, x_scale, weight_scale, out_dtype):\n"
        "    M, N = x_q.shape[0], weight.shape[1]\n"
        "    return torch.full((M, N), 9999.0, dtype=out_dtype, device=x_q.device)\n",
        encoding="utf-8",
    )
    o = KernelCorrectnessOracle()
    rep = o.run(iter_dir=tmp_path, req={}, report_dir=tmp_path, iteration=5)
    f0 = rep.failures[0]
    assert "shape" in f0 and "error" in f0
    assert "allclose failed" in f0["error"]
