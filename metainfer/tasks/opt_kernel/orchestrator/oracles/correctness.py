"""Correctness oracle for opt-kernel: immutable referee for the agent's kernel.

Problem this solves
-------------------
C_test used to run the agent's *own* ``test.sh`` — the contestant was also
the referee. An agent that wrote a weak ``test.sh`` (few shapes, loose
tolerance, no edge cases) could pass C while shipping a numerically wrong
kernel. The perf oracle (``oracles/perf.py``) already checks correctness on
its 5 benchmark shapes, but that runs in E and only on perf-representative
shapes (M=1/8/16/32/4096) — it misses the edge cases that bite in production
(odd M, K not a multiple of BLOCK_K, K tails, K=1, small N).

This oracle is the **referee**: orchestrator-owned code the agent cannot
edit, that loads the agent's ``kernel.py`` and compares its
``w8a8_scaled_mm`` output against the **same** PyTorch fp32 reference the
perf oracle uses (imported from ``oracles.perf`` — single source of truth
for the reference math), on a fixed edge-case shape set.

Contract
--------
``run()`` returns a :class:`CorrectnessReport` and writes
``correctness_report.json`` into ``report_dir``. ``all_correct`` is the
gating bit the pipeline keys off; ``failures`` lists the offending shapes
so the C debugger can root-cause.
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from .perf import import_kernel, reference_w8a8_scaled_mm, parse_kv_shapes

# Bumped whenever the shape set, seed policy, or tolerance changes so a
# report's vintage is a one-field check (mirrors perf.py::PERF_ORACLE_VERSION).
# iter2: per-run input salt + stress-probe shapes (saturated / gaussian fills)
# to deny the agent a fixed distribution to overfit (KDA "input-distribution
# caught" reward hack) and to exercise extreme quantization ranges.
CORRECTNESS_ORACLE_VERSION = "iter2-salt-stress"


def _oracle_seed(task_id: str, iteration: int) -> int:
    """Per-run input salt for the correctness oracle.

    Derives a deterministic-but-varying seed from ``(task_id, iteration)`` so
    the exact input tensors change every iteration. This denies the agent a
    *fixed* input distribution to overfit (the KDA reward hack where a kernel
    hardcodes a distributional constant — e.g. the expected L2 norm of a
    Gaussian — and passes fixed-seed tests while failing on real data).
    Reproducible: the same ``(task_id, iteration)`` always yields the same
    seed, so a reported failure can be replayed exactly.

    Note this deliberately diverges from ``perf.py::_benchmark_gemm``'s
    fixed seed 42: the perf oracle needs cross-iteration-comparable inputs for
    stable benchmarking, while this *referee* oracle wants distributional
    variety to catch overfitting. The two now check correctness on different
    inputs — more coverage, not less.
    """
    h = hashlib.sha256(f"{task_id}|{iteration}".encode("utf-8")).digest()
    return int.from_bytes(h[:4], "big")

# Tolerance — matches perf.py::_benchmark_gemm's correctness gate (atol=1.0,
# rtol=1e-2). One source of truth for the *threshold* would be nicer, but the
# perf oracle hardcodes it in _benchmark_gemm; we mirror the same constants
# here and stamp them into the report so drift is auditable.
CORRECTNESS_ATOL = 1.0
CORRECTNESS_RTOL = 1e-2


@dataclass
class ShapeCheck:
    """Result of checking one shape."""
    shape: Dict[str, int]
    correct: bool = False
    error: Optional[str] = None
    max_abs_err: Optional[float] = None


@dataclass
class CorrectnessReport:
    """Structured correctness report — serialized to correctness_report.json."""
    schema_version: int = 1
    oracle_version: str = CORRECTNESS_ORACLE_VERSION
    task_id: str = ""
    iteration: Optional[int] = None
    measured_at: float = 0.0
    all_correct: bool = False
    n_total: int = 0
    n_pass: int = 0
    n_fail: int = 0
    failures: List[Dict[str, Any]] = field(default_factory=list)
    shapes_checked: List[Dict[str, int]] = field(default_factory=list)
    tolerance: Dict[str, float] = field(
        default_factory=lambda: {"atol": CORRECTNESS_ATOL, "rtol": CORRECTNESS_RTOL}
    )
    # The per-run input salt used for this check (KDA-style anti-overfit;
    # see ``_oracle_seed``). Stamped so a reported failure is reproducible.
    oracle_seed: Optional[int] = None
    notes: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {k: v for k, v in self.__dict__.items()}


class KernelCorrectnessOracle:
    """Immutable correctness referee for the agent's w8a8 GEMM kernel.

    Stateless (dataclasses only) — safe to instantiate per E/C phase.
    """

    def run(
        self,
        iter_dir: Path,
        req: Dict[str, Any],
        report_dir: Path,
        iteration: int,
        timeout_s: int = 600,  # noqa: ARG002 — kept for signature parity with perf oracle
    ) -> CorrectnessReport:
        """Run the correctness check and write ``correctness_report.json``.

        Returns the :class:`CorrectnessReport`. Also writes it to
        ``report_dir / "correctness_report.json"``.
        """
        report_dir.mkdir(parents=True, exist_ok=True)
        report = CorrectnessReport(
            task_id=str(req.get("task_id", "")),
            iteration=iteration,
            measured_at=time.time(),
        )

        kernel = import_kernel(iter_dir)
        if kernel is None:
            report.notes = "kernel.py not found or import failed"
            report.failures = [{"shape": {}, "error": report.notes}]
            report.n_total = 1
            report.n_fail = 1
            report.all_correct = False
            self._write_report(report, report_dir)
            return report

        kernel_fn = getattr(kernel, "w8a8_scaled_mm", None)
        if kernel_fn is None:
            report.notes = "kernel.py does not expose w8a8_scaled_mm()"
            report.failures = [{"shape": {}, "error": report.notes}]
            report.n_total = 1
            report.n_fail = 1
            report.all_correct = False
            self._write_report(report, report_dir)
            return report

        shapes = self._resolve_correctness_shapes(req)
        report.shapes_checked = list(shapes)
        report.n_total = len(shapes)
        seed = _oracle_seed(str(req.get("task_id", "")), iteration)
        report.oracle_seed = seed

        try:
            import torch
        except ImportError:
            report.notes = "torch not available"
            report.failures = [{"shape": {}, "error": report.notes}]
            report.n_fail = report.n_total
            report.all_correct = False
            self._write_report(report, report_dir)
            return report
        device = "cuda" if torch.cuda.is_available() else "cpu"

        for shape in shapes:
            chk = self._check_shape(kernel_fn, shape, device, seed)
            if chk.correct:
                report.n_pass += 1
            else:
                report.n_fail += 1
                report.failures.append({
                    "shape": shape,
                    "error": chk.error,
                    "max_abs_err": chk.max_abs_err,
                })
        report.all_correct = report.n_fail == 0
        if report.all_correct:
            report.notes = f"All {report.n_total} shapes correct"
        else:
            report.notes = f"{report.n_fail}/{report.n_total} shapes failed"
        self._write_report(report, report_dir)
        return report

    # ------------------------------------------------------------------ #
    # Shape resolution
    # ------------------------------------------------------------------ #

    def _resolve_correctness_shapes(self, req: Dict[str, Any]) -> List[Dict[str, int]]:
        """Build the correctness shape set: perf-representative shapes PLUS
        edge cases the agent's test.sh commonly omits.

        K/N default to 4096 and are overridable via ``req['input_shapes']``
        (same parsing as the perf oracle — :func:`parse_kv_shapes`). The M
        values are fixed: they target tile-boundary / tail / degenerate
        cases that break kernels which only got tested on round numbers.
        """
        raw = str(req.get("input_shapes", "")).strip()
        K, N = 4096, 4096
        if raw:
            parsed = parse_kv_shapes(raw)
            K = int(parsed.get("K", K))
            N = int(parsed.get("N", N))
        shapes: List[Dict[str, int]] = []
        # Representative — the perf oracle measures these, so they MUST be
        # correct (a perf-correct-but-numerically-wrong kernel is the worst
        # outcome: it ships with a good score).
        for M in (1, 8, 16, 32, 4096):
            shapes.append({"M": M, "K": K, "N": N})
        # Edge cases — the agent's test.sh usually tests round numbers only.
        shapes.append({"M": 17, "K": K, "N": N})    # odd M (tile boundary)
        shapes.append({"M": 1, "K": 300, "N": N})   # K not a multiple of BLOCK_K
        shapes.append({"M": 1, "K": 4090, "N": N})  # K tail (unaligned)
        shapes.append({"M": 1, "K": 1, "N": N})      # degenerate K=1
        shapes.append({"M": 1, "K": K, "N": 32})    # small N (< BLOCK_N)
        # Stress probes (KDA-style distribution holdouts). A kernel that
        # overfits the default uniform-random distribution — e.g. by hardcoding
        # a distributional constant — must still be correct on these
        # structurally different inputs, which the agent's test.sh almost
        # never generates. The optional ``fill`` key selects the input
        # distribution (default ``uniform`` = the legacy path).
        shapes.append({"M": 1, "K": K, "N": N, "fill": "saturated"})
        shapes.append({"M": 4096, "K": K, "N": N, "fill": "saturated"})
        shapes.append({"M": 1, "K": K, "N": N, "fill": "gaussian"})
        return shapes

    # ------------------------------------------------------------------ #
    # Per-shape check
    # ------------------------------------------------------------------ #

    def _check_shape(self, kernel_fn, shape: Dict[str, int], device: str,
                     seed: int) -> ShapeCheck:
        """Run the agent kernel + the reference on one shape; compare.

        ``seed`` is the per-run salt (see :func:`_oracle_seed`); ``shape["fill"]``
        (default ``uniform``) selects the input distribution.
        """
        chk = ShapeCheck(shape=shape)
        try:
            import torch
        except ImportError:
            chk.error = "torch not available"
            return chk

        M = int(shape.get("M", 4096))
        K = int(shape.get("K", 4096))
        N = int(shape.get("N", 4096))
        out_dtype = torch.bfloat16

        x_q, weight, x_scale, weight_scale = _gen_inputs(
            M, K, N, device, seed, shape.get("fill", "uniform")
        )

        try:
            ref = reference_w8a8_scaled_mm(x_q, weight, x_scale, weight_scale, out_dtype)
            out = kernel_fn(x_q, weight, x_scale, weight_scale, out_dtype)
            if out.shape != ref.shape:
                chk.error = f"shape mismatch: kernel {tuple(out.shape)} vs ref {tuple(ref.shape)}"
                return chk
            if not torch.allclose(
                out.float(), ref.float(),
                atol=CORRECTNESS_ATOL, rtol=CORRECTNESS_RTOL,
            ):
                max_abs_err = float((out.float() - ref.float()).abs().max().item())
                chk.max_abs_err = max_abs_err
                chk.error = (
                    f"allclose failed (atol={CORRECTNESS_ATOL}, "
                    f"rtol={CORRECTNESS_RTOL}, max_abs_err={max_abs_err:.4f})"
                )
                return chk
        except Exception as exc:  # noqa: BLE001
            chk.error = f"kernel exception: {exc!r}"
            return chk

        chk.correct = True
        return chk

    # ------------------------------------------------------------------ #
    # Persistence
    # ------------------------------------------------------------------ #

    def _write_report(self, report: CorrectnessReport, report_dir: Path) -> None:
        path = report_dir / "correctness_report.json"
        try:
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(report.to_dict(), indent=2), encoding="utf-8")
            tmp.replace(path)
        except OSError:
            pass


# --------------------------------------------------------------------------- #
# Input generation (per-run salt + distribution holdouts)
# --------------------------------------------------------------------------- #

def _gen_inputs(M, K, N, device, seed: int, fill: str):
    """Build (x_q, weight, x_scale, weight_scale) for one shape check.

    ``fill`` selects the input distribution:
      * ``uniform``   — legacy uniform-random int8 (default).
      * ``saturated`` — only {-127, 127} (all-extreme-magnitude inputs) with
        uniform-range scales; exercises the extreme quantization range
        (catches overflow / precision shortcuts that hold on mild inputs)
        without blowing up the output magnitude.
      * ``gaussian``  — clipped normal (std 40); a *different* distribution
        from uniform, so a kernel that hardcodes a uniform-distribution
        constant (e.g. the expected L2 norm) fails here.
    All paths seed from ``seed`` so a failure is reproducible.
    """
    import torch

    torch.manual_seed(seed)
    if fill == "saturated":
        # {-127, 127} only (all-extreme-magnitude inputs; no zeros / mild
        # values) — exercises overflow / precision shortcuts that hold on
        # the uniform range. Scales are ~10x smaller than uniform so the
        # dequantized output stays in the atol-dominated regime even at
        # production K: ±127-only inputs have ~3x the variance of uniform, so
        # matching uniform's output magnitude needs smaller scales. The stress
        # is the input magnitude (all ±127), not a blown-up output that would
        # false-reject faithful non-bit-identical kernels (tiled / split-K
        # accumulate in a different order than the fp32 reference).
        x_q = (torch.randint(0, 2, (M, K), device=device) * 254 - 127).to(torch.int8)
        weight = (torch.randint(0, 2, (K, N), device=device) * 254 - 127).to(torch.int8)
        x_scale = torch.rand(M, 1, dtype=torch.float32, device=device) * 0.001 + 0.0001
        weight_scale = torch.rand(N, 1, dtype=torch.float32, device=device) * 0.001 + 0.0001
    elif fill == "gaussian":
        x_q = torch.clamp(torch.randn(M, K, device=device) * 40, -127, 127).round().to(torch.int8)
        weight = torch.clamp(torch.randn(K, N, device=device) * 40, -127, 127).round().to(torch.int8)
        x_scale = torch.rand(M, 1, dtype=torch.float32, device=device) * 0.01 + 0.001
        weight_scale = torch.rand(N, 1, dtype=torch.float32, device=device) * 0.01 + 0.001
    else:  # uniform (legacy)
        x_q = torch.randint(-127, 127, (M, K), dtype=torch.int8, device=device)
        weight = torch.randint(-127, 127, (K, N), dtype=torch.int8, device=device)
        x_scale = torch.rand(M, 1, dtype=torch.float32, device=device) * 0.01 + 0.001
        weight_scale = torch.rand(N, 1, dtype=torch.float32, device=device) * 0.01 + 0.001
    return x_q, weight, x_scale, weight_scale
