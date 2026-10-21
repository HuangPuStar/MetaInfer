"""Performance oracle for opt-kernel: fixed, deterministic benchmark harness.

This replaces the old E-step pattern of "perf-tester agent writes perf.sh
and runs it". The agent-written benchmark was unreliable across iterations
(different shapes, different warmup, different metric definitions), so
iter(N) vs iter(N-1) comparisons were meaningless.

The perf oracle fixes this by owning the benchmark:

  - Fixed shape set (derived from ``req['input_shapes']`` + operator type).
  - Fixed warmup policy (drop the first ``WARMUP_ITERS`` runs).
  - Fixed metric definitions (latency, throughput, speedup vs baseline).
  - CUDA Graph capture + replay (when supported) for stable timing.
  - Baseline comparison against the reference implementation.
  - rocprof profile capture (kernel stats, counters, HIP trace).
  - Regression check vs the previous iteration's perf dict.

The agent's contract: expose the kernel via a Python module
(``kernel.py``) with a known entry-point function. For w8a8 GEMM:

    def w8a8_scaled_mm(x_q, weight, x_scale, weight_scale, out_dtype=torch.bfloat16):
        # x_q: (M, K) int8, weight: (K, N) int8
        # x_scale: (M, 1) fp32, weight_scale: (N, 1) fp32
        # returns: (M, N) out_dtype

Output: ``perf_report.json`` with a structured schema (see :class:`PerfReport`).
"""

from __future__ import annotations

import importlib
import importlib.util
import json
import math
import os
import statistics
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import yaml

from . import profiler as profiler_mod


# Number of timed iterations (after warmup) per shape.
TIMED_ITERS = 50
# Drop this many initial runs to absorb JIT compilation / cache misses.
WARMUP_ITERS = 10
# Relative drop in the primary metric that counts as a regression.
REGRESSION_THRESHOLD = 0.20

# iter #17 P0b: module-version stamp. Emitted into every
# ``perf_report.json::methodology.oracle_version`` so "is the new code
# actually loaded?" is a one-field check in the report, not a planner's
# guess. A report whose stamp does not match this on-disk constant PROVES
# the running orchestrator holds a stale ``oracles.perf`` module (the
# iter #14/#15/#16 root cause: edits on disk were never re-imported because
# the long-running orchestrator cached the iteration-1 module in
# ``sys.modules``; ``importlib.reload`` in ``pipeline.py`` closes that).
PERF_ORACLE_VERSION = "iter17-gate-derive-reload"


# --------------------------------------------------------------------------- #
# Module-level helpers (shared with the correctness oracle — SSOT)
# --------------------------------------------------------------------------- #
# These three helpers encode the w8a8 task contract: HOW to load the
# agent's kernel.py and WHAT the reference answer is. They are the single
# source of truth for that contract — the correctness oracle imports them
# instead of re-implementing the reference (which would dual-write the math
# and drift). The ``KernelPerfOracle`` instance methods below delegate here.

def import_kernel(iter_dir: Path):
    """Import the agent's ``kernel.py`` from an iteration directory.

    Returns the loaded module (exposing ``w8a8_scaled_mm``) or ``None`` on
    any failure (missing file / import error / syntax error). Idempotent:
    re-imports over the ``agent_kernel`` ``sys.modules`` entry.
    """
    kernel_path = iter_dir / "kernel.py"
    if not kernel_path.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("agent_kernel", kernel_path)
        if spec is None or spec.loader is None:
            return None
        module = importlib.util.module_from_spec(spec)
        sys.modules["agent_kernel"] = module
        spec.loader.exec_module(module)
        return module
    except Exception:
        return None


def reference_w8a8_scaled_mm(x_q, weight, x_scale, weight_scale, out_dtype):
    """PyTorch fp32 reference for w8a8 scaled matmul (matches the task spec).

    ``acc = x_q.float() @ weight.float()``; ``out = acc * x_scale * weight_scale.T``.
    This is the referee's answer key — both the perf oracle and the
    correctness oracle compare the agent's kernel output against this.
    """
    import torch
    x_f32 = x_q.to(torch.float32)
    w_f32 = weight.to(torch.float32)
    acc = torch.mm(x_f32, w_f32)
    ws_squeezed = weight_scale.squeeze(-1)
    out = acc * x_scale * ws_squeezed.unsqueeze(0)
    return out.to(out_dtype)


def parse_kv_shapes(raw: str) -> Dict[str, int]:
    """Parse ``'M=4096,N=4096,K=4096'`` into a dict (keys uppercased)."""
    result: Dict[str, int] = {}
    for part in raw.replace(";", ",").split(","):
        part = part.strip()
        if "=" in part:
            k, v = part.split("=", 1)
            try:
                result[k.strip().upper()] = int(v.strip())
            except ValueError:
                pass
    return result


@dataclass
class ShapeResult:
    """Per-shape benchmark result."""
    shape: Dict[str, int]
    kernel_us: float = 0.0
    kernel_us_stdev: float = 0.0
    baseline_us: float = 0.0
    speedup: float = 0.0
    gflops: float = 0.0
    bandwidth_gb_s: float = 0.0
    correct: bool = True
    error: Optional[str] = None


@dataclass
class PerfReport:
    """Structured perf report — serialized to perf_report.json."""
    schema_version: int = 2
    task_id: str = ""
    iteration: Optional[int] = None
    measured_at: float = 0.0
    methodology: Dict[str, Any] = field(default_factory=dict)
    hardware: Dict[str, Any] = field(default_factory=dict)
    results: List[Dict[str, Any]] = field(default_factory=list)
    primary: Dict[str, Any] = field(default_factory=dict)
    target: Optional[Dict[str, Any]] = None
    regression: Optional[Dict[str, Any]] = None
    profile_artifacts: List[Dict[str, Any]] = field(default_factory=list)
    notes: str = ""
    # Backward-compat: flat top-level fields so old _read_perf_report
    # keeps working. Mirror the primary (M=4096 prefill) run.
    tokens_per_sec: float = 0.0
    ms_per_op: float = 0.0
    gflops: float = 0.0
    bandwidth_gb_s: float = 0.0
    speedup: float = 0.0
    # iter #14 P2: audit field recording WHICH number populates `speedup` so
    # the regression detector is auditable. ``speedup_source`` is a STRING
    # (not parsed by ``_read_perf_report`` which only reads numeric fields) --
    # additive / backward-compatible. Values: ``prefill`` (the primary's own
    # baseline was measurable), ``decode_median`` (the prefill-primary baseline
    # OOMed under VRAM pressure -> fell back to the decode median speedup, a
    # real measurable number ~1.18, arming the regression detector), ``none``
    # (full contention: no baseline measurable anywhere -> speedup stays 0.0).
    speedup_source: str = "prefill"

    def to_dict(self) -> Dict[str, Any]:
        return {k: v for k, v in self.__dict__.items()}


class KernelPerfOracle:
    """Fixed benchmark harness for GPU kernel optimization.

    The oracle imports the agent's ``kernel.py`` and benchmarks it against
    a reference implementation with fixed shapes, warmup, and iteration count.
    """

    def run(
        self,
        iter_dir: Path,
        req: Dict[str, Any],
        report_dir: Path,
        iteration: int,
        prev_perf: Optional[Dict[str, float]] = None,
        timeout_s: int = 1800,
    ) -> PerfReport:
        """Run the benchmark and write ``perf_report.json``.

        Returns the :class:`PerfReport`. Also writes it to
        ``iter_dir / "perf_report.json"`` for the pipeline's existing
        ``_read_perf_report`` parser.
        """
        report_dir.mkdir(parents=True, exist_ok=True)
        report = PerfReport(
            task_id=str(req.get("task_id", "")),
            iteration=iteration,
            measured_at=time.time(),
            methodology={
                "timed_iters": TIMED_ITERS,
                "warmup_iters": WARMUP_ITERS,
                "cuda_graph": True,
                "metric": "median_kernel_us",
            },
        )
        # iter #17 P0b: stamp the producing module's version into the report
        # on BOTH the gate-derived and self-measured paths (set here, before
        # the gate branch, so it is never forgotten). A report whose stamp
        # differs from the on-disk ``PERF_ORACLE_VERSION`` proves the running
        # orchestrator used a stale cached module.
        report.methodology["oracle_version"] = PERF_ORACLE_VERSION

        # Resolve hardware profile
        hw = self._hardware_info(req)
        report.hardware = hw

        # Resolve shapes from req
        shapes = self._resolve_shapes(req)
        report.notes = f"Benchmarked {len(shapes)} shape(s)."

        # iter #16 P0: single source of truth. The C-phase gate
        # (``gate_result.json::perf``) is the timing authority -- event-timed,
        # freest-card-pinned, clean. The oracle's own separate run was
        # contaminated (prefill stdev 365 vs the clean band 43-49) and its
        # prefill baseline OOMed (``speedup=0.0`` for 16 iterations). Per the
        # project's single-source-of-truth rule (CLAUDE.md "双写" anti-pattern),
        # derive the report FROM the gate instead of re-measuring, and skip the
        # oracle's benchmark loop entirely. Fall back to the existing
        # measurement path below only when the gate is absent (back-compat).
        gate = self._load_gate(iter_dir / "gate_result.json")
        if gate is not None:
            self._populate_from_gate(report, gate, prev_perf)
            self._write_report(report, iter_dir, report_dir)
            return report

        # Import the agent's kernel module
        kernel_module = self._import_kernel(iter_dir)
        if kernel_module is None:
            report.notes = "kernel.py not found or import failed"
            self._write_report(report, iter_dir, report_dir)
            return report

        # Benchmark each shape
        results: List[ShapeResult] = []
        for shape in shapes:
            sr = self._benchmark_shape(kernel_module, shape, req, iter_dir)
            results.append(sr)

        report.results = [self._shape_result_to_dict(sr) for sr in results]

        # Primary = the prefill shape (largest M) if available, else first
        primary_sr = self._pick_primary(results)
        if primary_sr:
            report.primary = self._shape_result_to_dict(primary_sr)
            report.ms_per_op = primary_sr.kernel_us / 1000.0
            report.gflops = primary_sr.gflops
            report.bandwidth_gb_s = primary_sr.bandwidth_gb_s
            report.speedup = primary_sr.speedup
            report.speedup_source = "prefill"
            # tokens_per_sec backward-compat: approximate from prefill throughput
            if primary_sr.kernel_us > 0:
                report.tokens_per_sec = 1e6 / primary_sr.kernel_us

        # iter #14 P2: honest `report.speedup` fallback so the 14-iteration
        # `speedup=0.0` blindness ends. When the prefill-primary baseline is
        # UNMEASURABLE (OOM under VRAM pressure -> primary_sr.speedup == 0.0),
        # fall back to the **decode median** speedup across the measurable
        # decode (M<=32) shapes -- a real, measurable number (~1.18) that arms
        # the regression detector instead of leaving it disarmed at 0.0.
        # Additive / backward-compatible: all existing flat fields are kept;
        # only `speedup` is made non-zero when any decode baseline is
        # measurable, and `speedup_source` records which number was used. If
        # NO baseline is measurable anywhere (full contention), keep
        # speedup=0.0 and speedup_source="none" (graceful degrade -- same as
        # today, no false claim). The per-shape `primary` dict is unchanged.
        if primary_sr is None or primary_sr.speedup == 0.0:
            decode_sps = [
                sr.speedup for sr in results
                if sr.shape.get("path") == "decode" and sr.speedup > 0
            ]
            if decode_sps:
                report.speedup = float(statistics.median(decode_sps))
                report.speedup_source = "decode_median"
            else:
                report.speedup = 0.0
                report.speedup_source = "none"

        # iter #16 P0 back-compat: the gate was absent, so we self-measured.
        # Record this so the official report is never silent about which path
        # produced ``speedup`` (single-source-of-truth auditability).
        report.notes += (f"; speedup_source={report.speedup_source}"
                         f"; oracle-self-measured (gate_result.json absent)")

        # Regression check
        if prev_perf:
            report.regression = self._check_regression(prev_perf, report)

        # Profile capture (rocprof)
        try:
            profile_cmd = self._profile_command(iter_dir, req)
            if profile_cmd:
                key_counters = self._key_counters(req)
                env = self._profile_env(req, iter_dir)
                artifacts = profiler_mod.collect_profile(
                    iter_dir, profile_cmd, env=env,
                    key_counters=key_counters, timeout_s=timeout_s,
                )
                report.profile_artifacts = artifacts
        except Exception as exc:  # noqa: BLE001
            report.profile_artifacts = [{"kind": "error", "error": str(exc)}]

        self._write_report(report, iter_dir, report_dir)
        return report

    # ------------------------------------------------------------------ #
    # Kernel import + benchmark
    # ------------------------------------------------------------------ #

    # ------------------------------------------------------------------ #
    # iter #16 P0: gate-derivation (single source of truth)
    # ------------------------------------------------------------------ #

    def _load_gate(self, gate_path: Path) -> Optional[Dict[str, Any]]:
        """Load the C-phase ``gate_result.json::perf`` if present & authoritative.

        Returns the ``perf`` dict (the timing authority), or ``None`` when the
        gate is absent / unreadable / has no authoritative numbers (C-phase
        failed, an older iter dir, or a standalone oracle invocation) -- in
        which case the caller falls back to the existing measurement path.
        """
        if not gate_path.is_file():
            return None
        try:
            obj = json.loads(gate_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if not isinstance(obj, dict):
            return None
        perf = obj.get("perf")
        if not isinstance(perf, dict) or not perf:
            return None
        if not perf.get("shapes") and not perf.get("primary"):
            return None
        return perf

    @staticmethod
    def _gate_decode_speedups(gate: Dict[str, Any]) -> List[float]:
        """Collect measurable decode speedups from the gate for the median."""
        sps: List[float] = []
        dg = gate.get("decode_gate") or {}
        for sh in dg.get("measurable_shapes") or []:
            sp = sh.get("speedup")
            if isinstance(sp, (int, float)) and sp > 0:
                sps.append(float(sp))
        if not sps:
            for sh in gate.get("decode_tp_shapes") or []:
                sp = sh.get("speedup")
                if isinstance(sp, (int, float)) and sp > 0:
                    sps.append(float(sp))
        return sps

    def _populate_from_gate(
        self, report: PerfReport, gate: Dict[str, Any],
        prev_perf: Optional[Dict[str, float]],
    ) -> None:
        """Populate ``PerfReport`` from the gate (single source of truth).

        Maps the gate's flat ``shapes[]`` / ``primary`` into the oracle's
        existing result/primary dict shape so the consumer parser
        (``_read_perf_report``) and any downstream reader are unchanged.
        No field is removed; only derived. The oracle's own benchmark loop
        and its (contaminated / OOMing) prefill baseline are skipped entirely.
        """
        # results[] <- gate perf.shapes[] (5 official shapes).
        # iter #17 P0c: fail-loud ``correct`` -- never fabricate ``true`` when
        # the gate omits the field (the Reviewer A advisory). The gate always
        # sets it today, but a future schema drift must surface as
        # ``correct=None`` + a ``correct_unknown=<shape>`` note token, not a
        # silent ``true`` in the official audit surface.
        results: List[Dict[str, Any]] = []
        correct_unknown: List[str] = []
        for s in gate.get("shapes") or []:
            M = s.get("M")
            path = "prefill" if (isinstance(M, (int, float)) and M >= 1024) else "decode"
            c = s.get("correct")
            if c is None:
                correct_unknown.append(f"{M}x{s.get('K')}x{s.get('N')}")
                correct_val: Optional[bool] = None
            else:
                correct_val = bool(c)
            results.append({
                "shape": {"M": M, "K": s.get("K"), "N": s.get("N"), "path": path},
                "kernel_us": float(s.get("kernel_us", 0.0)),
                "kernel_us_stdev": float(s.get("kernel_us_stdev", 0.0)),
                "baseline_us": float(s.get("baseline_us", 0.0)),
                "speedup": float(s.get("speedup", 0.0)),
                "gflops": float(s.get("gflops", 0.0)),
                "bandwidth_gb_s": float(s.get("bandwidth_gb_s", 0.0)),
                "correct": correct_val,
                "error": None,
            })
        report.results = results

        # primary <- gate perf.primary (prefill row).
        gp = gate.get("primary") or {}
        pc = gp.get("correct")
        if pc is None:
            correct_unknown.append(f"primary_{gp.get('M')}x{gp.get('K')}x{gp.get('N')}")
            primary_correct: Optional[bool] = None
        else:
            primary_correct = bool(pc)
        primary = {
            "shape": {"M": gp.get("M"), "K": gp.get("K"), "N": gp.get("N"),
                      "path": "prefill"},
            "kernel_us": float(gp.get("kernel_us", 0.0)),
            "kernel_us_stdev": float(gp.get("kernel_us_stdev", 0.0)),
            "baseline_us": float(gp.get("baseline_us", 0.0)),
            "speedup": float(gp.get("speedup", 0.0)),
            "gflops": float(gp.get("gflops", 0.0)),
            "bandwidth_gb_s": float(gp.get("bandwidth_gb_s", 0.0)),
            "correct": primary_correct,
            "error": None,
        }
        report.primary = primary
        ku = primary["kernel_us"]
        report.ms_per_op = ku / 1000.0 if ku > 0 else 0.0
        report.gflops = primary["gflops"]
        report.bandwidth_gb_s = primary["bandwidth_gb_s"]
        if ku > 0:
            report.tokens_per_sec = 1e6 / ku

        # speedup <- gate prefill (real, gate-measured), else decode median.
        ps = gate.get("prefill_speedup")
        pb = gate.get("prefill_baseline_us")
        if (isinstance(ps, (int, float)) and float(ps) > 0
                and isinstance(pb, (int, float)) and float(pb) > 0):
            report.speedup = float(ps)
            report.speedup_source = "prefill"
        else:
            sps = self._gate_decode_speedups(gate)
            if sps:
                report.speedup = float(statistics.median(sps))
                report.speedup_source = "decode_median"
            else:
                report.speedup = 0.0
                report.speedup_source = "none"

        # Record that this report was derived (not re-measured).
        report.methodology["derived_from"] = "gate_result.json"

        # rocprof is absent (16th iteration); emit the stubs directly and skip
        # the profiler subprocess so no kernel re-runs in the E-phase.
        not_found = "rocprof not found on PATH"
        report.profile_artifacts = [
            {"kind": "kernel_stats", "collected": False, "error": not_found},
            {"kind": "counters", "collected": False, "error": not_found},
            {"kind": "hip_trace", "collected": False, "error": not_found},
        ]

        # Regression check is now meaningful: speedup is non-zero & gate-derived.
        if prev_perf:
            report.regression = self._check_regression(prev_perf, report)

        # Carry the gate's contention tokens into notes (auditable).
        tokens = []
        for key in ("measured_gpu", "dcu_use", "vram_free_gib", "compute_idle",
                    "baseline_faithful", "baseline_method", "primary_method"):
            v = gate.get(key)
            if v is not None:
                tokens.append(f"{key}={v}")
        # iter #17 P0c: surface any shape whose ``correct`` the gate omitted as
        # an explicit ``correct_unknown`` token (never silently claimed).
        for cu in correct_unknown:
            tokens.append(f"correct_unknown={cu}")
        tokens.append(f"speedup_source={report.speedup_source}")
        report.notes = ("Derived from gate_result.json (single source of truth); "
                        + "; ".join(tokens))

    def _import_kernel(self, iter_dir: Path):
        """Import the agent's kernel.py from the iteration directory."""
        return import_kernel(iter_dir)

    def _benchmark_shape(
        self, kernel_module, shape: Dict[str, int],
        req: Dict[str, Any], iter_dir: Path,
    ) -> ShapeResult:
        """Benchmark the agent's kernel on one shape."""
        sr = ShapeResult(shape=shape)
        operator = str(req.get("operator", "")).lower()

        try:
            import torch
        except ImportError:
            sr.error = "torch not available"
            sr.correct = False
            return sr

        try:
            if "gemm" in operator or "quant" in operator:
                return self._benchmark_gemm(kernel_module, shape, req, sr)
            else:
                # Generic fallback: call kernel.benchmark(shape) if it exists
                return self._benchmark_generic(kernel_module, shape, sr)
        except Exception as exc:  # noqa: BLE001
            sr.correct = False
            sr.error = f"benchmark error: {exc!r}"
            return sr

    def _benchmark_gemm(
        self, kernel_module, shape: Dict[str, int],
        req: Dict[str, Any], sr: ShapeResult,
    ) -> ShapeResult:
        """Benchmark a w8a8 GEMM kernel against the lmslim baseline."""
        import torch

        M = shape.get("M", 4096)
        K = shape.get("K", 4096)
        N = shape.get("N", 4096)
        device = "cuda" if torch.cuda.is_available() else "cpu"

        # Generate test data
        torch.manual_seed(42)
        x_q = torch.randint(-127, 127, (M, K), dtype=torch.int8, device=device)
        weight = torch.randint(-127, 127, (K, N), dtype=torch.int8, device=device)
        x_scale = torch.rand(M, 1, dtype=torch.float32, device=device) * 0.01 + 0.001
        weight_scale = torch.rand(N, 1, dtype=torch.float32, device=device) * 0.01 + 0.001
        out_dtype = torch.bfloat16

        # Resolve the kernel entry point
        kernel_fn = getattr(kernel_module, "w8a8_scaled_mm", None)
        if kernel_fn is None:
            sr.correct = False
            sr.error = "kernel.py does not expose w8a8_scaled_mm()"
            return sr

        # Correctness check against PyTorch reference
        try:
            ref = self._reference_w8a8_scaled_mm(x_q, weight, x_scale, weight_scale, out_dtype)
            out = kernel_fn(x_q, weight, x_scale, weight_scale, out_dtype)
            if not torch.allclose(out.float(), ref.float(), atol=1.0, rtol=1e-2):
                sr.correct = False
                sr.error = "correctness check failed (atol=1.0)"
                return sr
        except Exception as exc:  # noqa: BLE001
            sr.correct = False
            sr.error = f"correctness error: {exc!r}"
            return sr

        # Timed benchmark with CUDA Graph
        # iter #14 P2.2: the prefill shape (path==prefill / large M) is timed
        # via per-call CUDA events so its per-shape `speedup` is honest event-vs
        # -event against the event-based lmslim baseline (graph-replay zeroes
        # host dispatch while the baseline pays it). Decode keeps graph-replay
        # for cross-iteration consistency.
        is_prefill = (shape.get("path") == "prefill") or (M >= 1024)
        kernel_times = self._timed_benchmark(
            lambda: kernel_fn(x_q, weight, x_scale, weight_scale, out_dtype),
            device=device,
            method=("event" if is_prefill else "graph"),
        )
        sr.kernel_us = statistics.median(kernel_times) if kernel_times else 0.0
        sr.kernel_us_stdev = statistics.stdev(kernel_times) if len(kernel_times) >= 2 else 0.0

        # Input-sensitivity probe (anti "cached output" reward-hack): a kernel
        # whose output does not depend on its inputs lets graph-replay / repeated
        # timing measure a near-free replay (fake-fast). Catches cache-by-tensor-
        # identity tricks the single-shot correctness check above misses. A
        # failure is a correctness failure (the kernel is not a faithful function
        # of its inputs) and zeroes the speedup.
        ok, err = self._input_sensitivity_check(
            kernel_fn, x_q, weight, x_scale, weight_scale, out_dtype,
        )
        if not ok:
            sr.correct = False
            sr.error = err
            return sr

        # Baseline: lmslim matmul_int8
        baseline_times = self._benchmark_baseline_gemm(
            x_q, weight, x_scale, weight_scale, out_dtype, device
        )
        if baseline_times:
            sr.baseline_us = statistics.median(baseline_times)
            if sr.kernel_us > 0:
                sr.speedup = sr.baseline_us / sr.kernel_us

        # Throughput metrics
        if sr.kernel_us > 0:
            # 2*M*K*N FLOPs for GEMM (multiply-accumulate = 2 ops)
            flops = 2 * M * K * N
            sr.gflops = round(flops / sr.kernel_us / 1e3, 2)  # us → GFLOPS
            # Bandwidth: read x_q (M*K int8) + weight (K*N int8) + write out (M*N bf16)
            bytes_transferred = M * K * 1 + K * N * 1 + M * N * 2
            sr.bandwidth_gb_s = round(bytes_transferred / sr.kernel_us / 1e3, 2)

        return sr

    def _benchmark_baseline_gemm(
        self, x_q, weight, x_scale, weight_scale, out_dtype, device,
    ) -> List[float]:
        """Benchmark the lmslim matmul_int8 baseline."""
        try:
            from lmslim.layers.gemm.int8_utils import matmul_int8
        except ImportError:
            return []

        config = None  # Let baseline auto-select config based on M
        try:
            # Warmup
            for _ in range(WARMUP_ITERS):
                matmul_int8(x_q, x_scale, weight, weight_scale, out_dtype, config)
            if device == "cuda":
                torch.cuda.synchronize()
            # Timed
            times: List[float] = []
            for _ in range(TIMED_ITERS):
                if device == "cuda":
                    torch.cuda.synchronize()
                    t0 = time.perf_counter()
                    matmul_int8(x_q, x_scale, weight, weight_scale, out_dtype, config)
                    torch.cuda.synchronize()
                    t1 = time.perf_counter()
                    times.append((t1 - t0) * 1e6)
                else:
                    t0 = time.perf_counter()
                    matmul_int8(x_q, x_scale, weight, weight_scale, out_dtype, config)
                    t1 = time.perf_counter()
                    times.append((t1 - t0) * 1e6)
            return times
        except Exception:
            return []

    def _reference_w8a8_scaled_mm(self, x_q, weight, x_scale, weight_scale, out_dtype):
        """PyTorch reference for w8a8 scaled matmul (matches the task spec)."""
        return reference_w8a8_scaled_mm(x_q, weight, x_scale, weight_scale, out_dtype)

    def _input_sensitivity_check(
        self, kernel_fn, x_q, weight, x_scale, weight_scale, out_dtype,
    ) -> Tuple[bool, Optional[str]]:
        """Anti "cached / precomputed output" reward-hack (KDA gauntlet gate).

        A kernel whose output does not actually depend on its inputs can let
        CUDA-Graph replay (or plain repeated-call timing) measure a near-free
        replay instead of real compute — inflating throughput / speedup while
        the single-shot correctness check (which only ever sees one input)
        still passes. We mutate the input tensors **in place** (same tensor
        objects / same ``id()``) to fresh values, then re-run the kernel and
        compare against the PyTorch reference on those mutated inputs. A
        faithful kernel re-reads its inputs and the output tracks the change;
        a cache keyed on tensor identity returns the stale output and fails.

        On CUDA we verify through the captured graph itself (capture → mutate
        → replay → compare), which also catches graph-specific caching; on CPU
        (or if graph capture fails) we fall back to a direct call. Returns
        ``(ok, error_msg)``. Restores the original inputs on exit so downstream
        code is unaffected.
        """
        import torch
        M, K = x_q.shape
        K2, N = weight.shape
        device = x_q.device
        gen = torch.Generator(device=device).manual_seed(7777)
        new_xq = torch.randint(-127, 127, (M, K), dtype=torch.int8, device=device, generator=gen)
        new_w = torch.randint(-127, 127, (K2, N), dtype=torch.int8, device=device, generator=gen)
        new_xs = torch.rand(M, 1, dtype=torch.float32, device=device, generator=gen) * 0.01 + 0.001
        new_ws = torch.rand(N, 1, dtype=torch.float32, device=device, generator=gen) * 0.01 + 0.001
        orig = (x_q.clone(), weight.clone(), x_scale.clone(), weight_scale.clone())

        def _ref_now():
            return self._reference_w8a8_scaled_mm(x_q, weight, x_scale, weight_scale, out_dtype)

        def _fail(msg):
            return False, msg

        try:
            # Preferred: graph-replay probe (CUDA). Capture a graph whose output
            # we hold a reference to, then mutate inputs in place and replay.
            used_graph = False
            if device.type == "cuda" and torch.cuda.is_available():
                try:
                    g = torch.cuda.CUDAGraph()
                    with torch.cuda.graph(g):
                        out = kernel_fn(x_q, weight, x_scale, weight_scale, out_dtype)
                    torch.cuda.synchronize()
                    x_q.copy_(new_xq); weight.copy_(new_w)
                    x_scale.copy_(new_xs); weight_scale.copy_(new_ws)
                    ref_new = _ref_now()
                    g.replay(); torch.cuda.synchronize()
                    used_graph = True
                    if not torch.allclose(out.float(), ref_new.float(), atol=1.0, rtol=1e-2):
                        return _fail(
                            "input-insensitivity (graph-replay): output did not "
                            "track mutated inputs (suspected cached/precomputed output)"
                        )
                except Exception:
                    used_graph = False  # fall through to direct probe
            if not used_graph:
                x_q.copy_(new_xq); weight.copy_(new_w)
                x_scale.copy_(new_xs); weight_scale.copy_(new_ws)
                ref_new = _ref_now()
                out = kernel_fn(x_q, weight, x_scale, weight_scale, out_dtype)
                if not torch.allclose(out.float(), ref_new.float(), atol=1.0, rtol=1e-2):
                    return _fail(
                        "input-insensitivity: output did not track mutated inputs "
                        "(suspected cached/precomputed output)"
                    )
            return True, None
        except Exception as exc:  # noqa: BLE001
            return False, f"input-sensitivity check crashed: {exc!r}"
        finally:
            x_q.copy_(orig[0]); weight.copy_(orig[1])
            x_scale.copy_(orig[2]); weight_scale.copy_(orig[3])

    def _timed_benchmark(self, fn, device: str = "cuda",
                         method: str = "graph") -> List[float]:
        """Run fn with warmup + timed iterations, returning per-call microseconds.

        Uses CUDA Graph capture + replay when on GPU for stable timing.
        Falls back to event-based timing if graph capture fails.

        iter #14 P2.2: ``method='event'`` forces per-call CUDA-event timing
        (both the kernel launch AND its host dispatch are counted), used for
        the prefill shape so its per-shape ``speedup`` is honest event-vs-event
        against the event-based lmslim baseline (the graph-replay kernel timer
        zeroes host dispatch while the baseline pays it -- a small asymmetry
        for prefill, ~8%). Decode stays on ``method='graph'`` (graph-replay)
        to preserve cross-iteration consistency of the oracle's own decode
        rows; the regression metric is ``report.speedup`` which P2.1 makes
        honest via the decode-median fallback regardless.
        """
        import torch
        times: List[float] = []

        if device != "cuda" or not torch.cuda.is_available():
            # CPU fallback
            for _ in range(WARMUP_ITERS):
                fn()
            for _ in range(TIMED_ITERS):
                t0 = time.perf_counter()
                fn()
                t1 = time.perf_counter()
                times.append((t1 - t0) * 1e6)
            return times

        # iter #14 P2.2: event-timing path (prefill honesty). Per-call CUDA
        # events count the real host-dispatch cost, symmetric with the
        # event-based lmslim baseline (``_benchmark_baseline_gemm`` uses
        # perf_counter + sync). Graph capture is skipped for this path.
        if method == "event":
            try:
                for _ in range(WARMUP_ITERS):
                    fn()
                torch.cuda.synchronize()
                start = torch.cuda.Event(enable_timing=True)
                end = torch.cuda.Event(enable_timing=True)
                for _ in range(TIMED_ITERS):
                    start.record()
                    fn()
                    end.record()
                    torch.cuda.synchronize()
                    times.append(start.elapsed_time(end) * 1e3)  # ms -> us
                return times
            except Exception:
                # Fall through to the graph path as a last resort.
                times = []

        # GPU: try CUDA Graph capture
        try:
            # Warmup (also primes the graph capture)
            for _ in range(WARMUP_ITERS):
                fn()
            torch.cuda.synchronize()

            # Capture into a graph
            graph = torch.cuda.CUDAGraph()
            with torch.cuda.graph(graph):
                fn()
            torch.cuda.synchronize()

            # Timed replay
            for _ in range(TIMED_ITERS):
                t0 = time.perf_counter()
                graph.replay()
                torch.cuda.synchronize()
                t1 = time.perf_counter()
                times.append((t1 - t0) * 1e6)
            return times
        except Exception:
            # Fallback: event-based timing without graph
            try:
                for _ in range(WARMUP_ITERS):
                    fn()
                torch.cuda.synchronize()
                start = torch.cuda.Event(enable_timing=True)
                end = torch.cuda.Event(enable_timing=True)
                for _ in range(TIMED_ITERS):
                    start.record()
                    fn()
                    end.record()
                    torch.cuda.synchronize()
                    times.append(start.elapsed_time(end))  # ms → convert
                # Convert ms → us
                return [t * 1e3 for t in times]
            except Exception:
                return []

    def _benchmark_generic(self, kernel_module, shape, sr: ShapeResult) -> ShapeResult:
        """Generic fallback: call kernel.benchmark(shape) if it exists."""
        bench_fn = getattr(kernel_module, "benchmark", None)
        if bench_fn is None:
            sr.correct = False
            sr.error = "kernel.py has no benchmark() or known operator entry point"
            return sr
        try:
            result = bench_fn(shape)
            if isinstance(result, dict):
                sr.kernel_us = float(result.get("us", 0))
                sr.gflops = float(result.get("gflops", 0))
                sr.bandwidth_gb_s = float(result.get("bandwidth_gb_s", 0))
                sr.correct = bool(result.get("correct", True))
            else:
                sr.kernel_us = float(result)
        except Exception as exc:  # noqa: BLE001
            sr.correct = False
            sr.error = f"benchmark() error: {exc!r}"
        return sr

    # ------------------------------------------------------------------ #
    # Shape resolution
    # ------------------------------------------------------------------ #

    def _resolve_shapes(self, req: Dict[str, Any]) -> List[Dict[str, int]]:
        """Resolve the benchmark shape set from the task requirements.

        For w8a8 GEMM, the default shapes cover the two key regimes:
          - Decode path: M ≤ 32 (M=1, 8, 16, 32)
          - Prefill path: M = 4096
        K and N come from req['input_shapes'] or default to 4096.
        """
        operator = str(req.get("operator", "")).lower()
        if "gemm" in operator or "quant" in operator:
            return self._resolve_gemm_shapes(req)
        # Generic: parse from input_shapes
        return self._parse_shapes(req)

    def _resolve_gemm_shapes(self, req: Dict[str, Any]) -> List[Dict[str, int]]:
        """Resolve GEMM shapes: decode (M≤32) + prefill (M=4096)."""
        raw = str(req.get("input_shapes", "")).strip()
        K, N = 4096, 4096
        if raw:
            parsed = self._parse_kv_shapes(raw)
            K = int(parsed.get("K", K))
            N = int(parsed.get("N", N))
        # Decode path: small M (TP=4/8 → per-rank M is even smaller)
        # Prefill path: M=4096
        shapes = [
            {"M": 1, "K": K, "N": N, "path": "decode"},
            {"M": 8, "K": K, "N": N, "path": "decode"},
            {"M": 16, "K": K, "N": N, "path": "decode"},
            {"M": 32, "K": K, "N": N, "path": "decode"},
            {"M": 4096, "K": K, "N": N, "path": "prefill"},
        ]
        return shapes

    def _parse_kv_shapes(self, raw: str) -> Dict[str, int]:
        """Parse 'M=4096,N=4096,K=4096' into a dict."""
        return parse_kv_shapes(raw)

    def _parse_shapes(self, req: Dict[str, Any]) -> List[Dict[str, int]]:
        """Parse generic shapes from req['input_shapes']."""
        raw = str(req.get("input_shapes", "")).strip()
        parsed = self._parse_kv_shapes(raw)
        if parsed:
            return [parsed]
        return [{"M": 4096, "K": 4096, "N": 4096}]

    # ------------------------------------------------------------------ #
    # Helpers
    # ------------------------------------------------------------------ #

    def _pick_primary(self, results: List[ShapeResult]) -> Optional[ShapeResult]:
        """Pick the primary result (prefill / largest M)."""
        if not results:
            return None
        # Prefer the prefill path or largest M
        for sr in results:
            if sr.shape.get("path") == "prefill":
                return sr
        return max(results, key=lambda sr: sr.shape.get("M", 0))

    def _shape_result_to_dict(self, sr: ShapeResult) -> Dict[str, Any]:
        return {
            "shape": sr.shape,
            "kernel_us": round(sr.kernel_us, 2),
            "kernel_us_stdev": round(sr.kernel_us_stdev, 2),
            "baseline_us": round(sr.baseline_us, 2),
            "speedup": round(sr.speedup, 3),
            "gflops": round(sr.gflops, 2),
            "bandwidth_gb_s": round(sr.bandwidth_gb_s, 2),
            "correct": sr.correct,
            "error": sr.error,
        }

    def _check_regression(
        self, prev_perf: Dict[str, float], report: PerfReport,
    ) -> Dict[str, Any]:
        """Check if the primary metric regressed vs the previous iteration."""
        prev_speedup = prev_perf.get("speedup", 0)
        curr_speedup = report.speedup
        if prev_speedup > 0 and curr_speedup > 0:
            drop = (prev_speedup - curr_speedup) / prev_speedup
            return {
                "vs_prev_speedup": round(curr_speedup / prev_speedup, 3),
                "drop": round(drop, 3),
                "threshold": REGRESSION_THRESHOLD,
                "regressed": drop > REGRESSION_THRESHOLD,
            }
        # Fallback: compare ms_per_op
        prev_ms = prev_perf.get("ms_per_op", 0)
        curr_ms = report.ms_per_op
        if prev_ms > 0 and curr_ms > 0:
            increase = (curr_ms - prev_ms) / prev_ms
            return {
                "vs_prev_ms": round(curr_ms / prev_ms, 3),
                "increase": round(increase, 3),
                "threshold": REGRESSION_THRESHOLD,
                "regressed": increase > REGRESSION_THRESHOLD,
            }
        return {"regressed": False, "note": "no previous baseline"}

    def _hardware_info(self, req: Dict[str, Any]) -> Dict[str, Any]:
        """Extract hardware info from the profile snapshot."""
        try:
            from ..hardware import resolve_hardware_profile
            _, profile = resolve_hardware_profile(req)
            if profile:
                rt = profile.get("runtime", {})
                return {
                    "name": profile.get("id", ""),
                    "arch": rt.get("target_arch", ""),
                    "cu": rt.get("compute_units", 0),
                    "wavefront": rt.get("wavefront_size", 0),
                    "matrix_instructions": rt.get("matrix_instructions", ""),
                }
        except Exception:
            pass
        return {}

    def _profile_command(self, iter_dir: Path, req: Dict[str, Any]) -> List[str]:
        """Build the command to profile (runs the kernel benchmark).

        The oracle writes a small ``_bench_profile.py`` that the profiler
        wraps. This ensures rocprof captures the actual kernel execution.
        """
        bench_script = iter_dir / "_bench_profile.py"
        bench_script.write_text(
            "import sys, json, importlib.util\n"
            "spec = importlib.util.spec_from_file_location('agent_kernel', "
            f"{str(iter_dir / 'kernel.py')!r})\n"
            "mod = importlib.util.module_from_spec(spec)\n"
            "sys.modules['agent_kernel'] = mod\n"
            "spec.loader.exec_module(mod)\n"
            "import torch\n"
            "M, K, N = 4096, 4096, 4096\n"
            "x_q = torch.randint(-127, 127, (M, K), dtype=torch.int8, device='cuda')\n"
            "w = torch.randint(-127, 127, (K, N), dtype=torch.int8, device='cuda')\n"
            "xs = torch.rand(M, 1, dtype=torch.float32, device='cuda') * 0.01 + 0.001\n"
            "ws = torch.rand(N, 1, dtype=torch.float32, device='cuda') * 0.01 + 0.001\n"
            "fn = getattr(mod, 'w8a8_scaled_mm', None)\n"
            "if fn:\n"
            "    for _ in range(20):\n"
            "        fn(x_q, w, xs, ws, torch.bfloat16)\n"
            "    torch.cuda.synchronize()\n"
            "    for _ in range(10):\n"
            "        fn(x_q, w, xs, ws, torch.bfloat16)\n"
            "    torch.cuda.synchronize()\n",
            encoding="utf-8",
        )
        return [sys.executable, str(bench_script)]

    def _key_counters(self, req: Dict[str, Any]) -> List[str]:
        """Get key hardware counters from the profile."""
        try:
            from ..hardware import profiler_key_counters
            return profiler_key_counters(req)
        except Exception:
            return []

    def _profile_env(self, req: Dict[str, Any], iter_dir: Path) -> Dict[str, str]:
        """Build the environment for the profiler subprocess."""
        env = dict(os.environ)
        try:
            from ..hardware import execution_environment
            env.update(execution_environment(req, iter_dir))
        except Exception:
            pass
        return env

    def _write_report(self, report: PerfReport, iter_dir: Path, report_dir: Path) -> None:
        """Write perf_report.json to both iter_dir and report_dir."""
        data = report.to_dict()
        text = json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True)
        (iter_dir / "perf_report.json").write_text(text, encoding="utf-8")
        (report_dir / "perf-report.json").write_text(text, encoding="utf-8")
