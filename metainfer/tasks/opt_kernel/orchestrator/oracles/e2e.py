"""End-to-end model-level oracle for opt-kernel.

Why this exists
---------------
The per-shape perf oracle (``oracles/perf.py``) and the correctness oracle
(``oracles/correctness.py``) measure the agent's GEMM **in isolation**:
one kernel call at a time, fixed shapes. That is necessary but not
sufficient — a kernel that wins on per-shape us can still lose (or only
tie) end-to-end because:

  * **Prefill is amortised** — the GEMM is one of many ops in a prefill
    step; scheduler / capture / other kernels dilute its gain (we observed
    prefill TTFT stay flat despite a 14-34x per-shape GEMM win).
  * **Capture cost is invisible per-shape** — a kernel that is fast at
    steady-state but slow during sglang's weight/CUDA-graph capture shows
    up only as serve startup latency, never in a per-call bench.

This oracle runs the agent's kernel inside a real sglang serve and measures
the model-level impact (TTFT / TPOT / output throughput / capture time)
against the stock lmslim baseline. It is **advisory-only** by design: it
writes ``e2e_report.json`` and a timeline event but does NOT alter the phase
state machine — the point is to collect data and expose the blind spots
before wiring any hard gating.

Design (filesystem-as-DB, single source of truth)
--------------------------------------------------
* The benchmark itself runs out-of-process via an :class:`E2ERunner` — a
  Protocol, so the heavy sglang orchestration is injectable and the oracle's
  *comparison / regression / caching* logic is pure and unit-testable with a
  mock runner (no GPU, no sglang, no model weights).
* The **baseline serve result is an invariant** across iterations (the stock
  lmslim kernel does not change), so it is cached to
  ``e2e_baseline_cache.json`` keyed by (model, tp, bench params, lmslim
  version). That cache file is the single source of truth for the baseline;
  each iteration only runs the *agent* serve. Caching is opt-in and
  invalidated by changing any key field.
* Oracle crashes degrade to advisory pass-through (timeline-logged), so a
  bug in new e2e code never blocks an iteration — same gradual-rollout
  posture as the correctness oracle.
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Optional, Protocol


E2E_ORACLE_VERSION = "iter1-advisory-collect"

# Advisory regression thresholds (used to FLAG, not block). The oracle is
# advisory-only, so these just populate report.regression for trend-watching.
OUTPUT_THROUGHPUT_REGRESSION = 0.10   # agent output throughput >10% below baseline
TPOT_REGRESSION = 0.10                # agent TPOT >10% above baseline
CAPTURE_REGRESSION = 0.50             # agent capture >50% above baseline (loose; startup-only)


# --------------------------------------------------------------------------- #
# Data model
# --------------------------------------------------------------------------- #

@dataclass
class BenchResult:
    """One serve + bench run (either agent kernel or stock baseline)."""
    kind: str = ""                      # "agent" | "baseline"
    output_throughput_tok_s: float = 0.0
    input_throughput_tok_s: float = 0.0
    ttft_ms: float = 0.0
    tpot_ms: float = 0.0
    capture_s: float = 0.0              # serve ready time (approx capture cost)
    output_correct: bool = True
    successful_requests: int = 0
    notes: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {k: v for k, v in self.__dict__.items()}


@dataclass
class E2EReport:
    """Structured e2e report — serialized to e2e_report.json."""
    schema_version: int = 1
    oracle_version: str = E2E_ORACLE_VERSION
    task_id: str = ""
    iteration: Optional[int] = None
    measured_at: float = 0.0
    agent: Dict[str, Any] = field(default_factory=dict)
    baseline: Dict[str, Any] = field(default_factory=dict)
    baseline_cached: bool = False
    comparison: Dict[str, Any] = field(default_factory=dict)
    regression: Dict[str, Any] = field(default_factory=dict)
    cache_key: str = ""
    notes: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {k: v for k, v in self.__dict__.items()}


class E2ERunner(Protocol):
    """Injectable serve+bench orchestrator.

    Implementations (:class:`SglangE2ERunner` in production, a stub in tests)
    launch a real sglang serve, optionally monkeypatch the w8a8 GEMM with the
    agent's kernel, run ``sglang.bench_serving``, and return a BenchResult.
    """

    def run_bench(
        self,
        kernel_path: Optional[Path],
        req: Dict[str, Any],
        is_baseline: bool,
    ) -> BenchResult:
        """Run one serve+bench. ``kernel_path=None`` (and ``is_baseline=True``)
        runs the stock lmslim kernel; a path runs the agent's kernel via
        monkeypatch. Raises if the environment cannot run sglang."""
        ...


# --------------------------------------------------------------------------- #
# Oracle
# --------------------------------------------------------------------------- #

class E2EOracle:
    """Advisory end-to-end oracle. Stateless except for the baseline cache.

    Constructed with an :class:`E2ERunner` (the real/stub orchestrator) and a
    baseline cache path. :meth:`run` runs the agent serve, fetches/caches the
    baseline serve, compares, and writes ``e2e_report.json``.
    """

    def __init__(
        self,
        runner: E2ERunner,
        baseline_cache_path: Optional[Path] = None,
        output_throughput_regression: float = OUTPUT_THROUGHPUT_REGRESSION,
        tpot_regression: float = TPOT_REGRESSION,
        capture_regression: float = CAPTURE_REGRESSION,
    ) -> None:
        self.runner = runner
        self.baseline_cache_path = (
            Path(baseline_cache_path) if baseline_cache_path else None
        )
        self._out_thr = output_throughput_regression
        self._tpot_thr = tpot_regression
        self._capture_thr = capture_regression

    def run(
        self,
        iter_dir: Path,
        req: Dict[str, Any],
        report_dir: Path,
        iteration: int,
        prev_e2e: Optional[Dict[str, Any]] = None,  # noqa: ARG002 — reserved for trend
        timeout_s: int = 3600,  # noqa: ARG002 — parity with other oracles
    ) -> E2EReport:
        report_dir.mkdir(parents=True, exist_ok=True)
        report = E2EReport(
            task_id=str(req.get("task_id", "")),
            iteration=iteration,
            measured_at=time.time(),
        )

        cache_key = _baseline_cache_key(req)
        report.cache_key = cache_key

        # Agent serve — always run fresh (the thing under test).
        kernel_path = iter_dir / "kernel.py"
        agent_res = self.runner.run_bench(
            kernel_path if kernel_path.exists() else None,
            req,
            is_baseline=False,
        )
        agent_res.kind = "agent"
        report.agent = agent_res.to_dict()

        # Baseline serve — cached invariant. Fetch from cache if present and
        # the key matches; otherwise run the stock-kernel serve and persist.
        baseline_res, cached = self._get_or_run_baseline(req, cache_key)
        baseline_res.kind = "baseline"
        report.baseline = baseline_res.to_dict()
        report.baseline_cached = cached

        report.comparison = _compute_comparison(agent_res, baseline_res)
        report.regression = _compute_regression(
            agent_res, baseline_res, prev_e2e,
            self._out_thr, self._tpot_thr, self._capture_thr,
        )
        if agent_res.output_correct and baseline_res.output_correct:
            report.notes = "agent + baseline both produced output"
        elif not agent_res.output_correct:
            report.notes = "agent serve output incorrect"
        else:
            report.notes = "baseline serve output incorrect"

        self._write_report(report, report_dir)
        return report

    # ------------------------------------------------------------------ #
    # Baseline cache (single source of truth for the invariant baseline)
    # ------------------------------------------------------------------ #

    def _get_or_run_baseline(
        self, req: Dict[str, Any], cache_key: str,
    ) -> tuple[BenchResult, bool]:
        # Try cache.
        if self.baseline_cache_path is not None:
            cached = self._load_baseline_cache(cache_key)
            if cached is not None:
                return cached, True
        # Cache miss / disabled → run the stock-kernel serve.
        baseline = self.runner.run_bench(None, req, is_baseline=True)
        baseline.kind = "baseline"
        if self.baseline_cache_path is not None:
            self._write_baseline_cache(cache_key, baseline)
        return baseline, False

    def _load_baseline_cache(self, cache_key: str) -> Optional[BenchResult]:
        path = self.baseline_cache_path
        if path is None or not path.is_file():
            return None
        try:
            obj = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if not isinstance(obj, dict) or obj.get("cache_key") != cache_key:
            return None
        b = obj.get("baseline")
        if not isinstance(b, dict):
            return None
        return BenchResult(**{
            k: v for k, v in b.items()
            if k in BenchResult.__dataclass_fields__
        })

    def _write_baseline_cache(self, cache_key: str, baseline: BenchResult) -> None:
        path = self.baseline_cache_path
        if path is None:
            return
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            payload = {"cache_key": cache_key, "baseline": baseline.to_dict()}
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
            tmp.replace(path)
        except OSError:
            pass

    def _write_report(self, report: E2EReport, report_dir: Path) -> None:
        path = report_dir / "e2e_report.json"
        try:
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(report.to_dict(), indent=2), encoding="utf-8")
            tmp.replace(path)
        except OSError:
            pass


# --------------------------------------------------------------------------- #
# Pure comparison / regression logic (unit-testable without a runner)
# --------------------------------------------------------------------------- #

def _safe_ratio(num: float, den: float) -> Optional[float]:
    """num/den, or None if den is non-positive (metric unmeasurable)."""
    if den <= 0:
        return None
    return num / den


def _compute_comparison(agent: BenchResult, baseline: BenchResult) -> Dict[str, Any]:
    """Agent vs baseline ratios.

    * throughput ratios are agent/baseline (>1 = agent faster).
    * latency/capture ratios are baseline/agent (>1 = agent faster, since
      lower is better for those).
    * None = unmeasurable (denominator <= 0).
    """
    return {
        "output_throughput_ratio": _safe_ratio(
            agent.output_throughput_tok_s, baseline.output_throughput_tok_s),
        "input_throughput_ratio": _safe_ratio(
            agent.input_throughput_tok_s, baseline.input_throughput_tok_s),
        "ttft_ratio": _safe_ratio(baseline.ttft_ms, agent.ttft_ms),
        "tpot_ratio": _safe_ratio(baseline.tpot_ms, agent.tpot_ms),
        "capture_ratio": _safe_ratio(baseline.capture_s, agent.capture_s),
    }


def _compute_regression(
    agent: BenchResult,
    baseline: BenchResult,
    prev_e2e: Optional[Dict[str, Any]],
    out_thr: float,
    tpot_thr: float,
    capture_thr: float,
) -> Dict[str, Any]:
    """Advisory regression flags (the oracle does not gate on these).

    Two axes:
      * vs baseline — is the agent worse than stock lmslim?
      * vs prev_e2e agent — did the agent regress since last e2e run?
    Both are recorded; ``regressed`` is true if either fires.
    """
    comp = _compute_comparison(agent, baseline)

    def _worse_throughput(ratio: Optional[float], thr: float) -> bool:
        # throughput ratio agent/baseline < (1 - thr) → agent worse by >thr
        return ratio is not None and ratio < (1.0 - thr)

    def _worse_latency(latency_ratio: Optional[float], thr: float) -> bool:
        # latency ratio baseline/agent < (1 - thr) → agent slower by >thr
        return latency_ratio is not None and latency_ratio < (1.0 - thr)

    vs_baseline = {
        "output_throughput_regressed": _worse_throughput(
            comp["output_throughput_ratio"], out_thr),
        "tpot_regressed": _worse_latency(comp["tpot_ratio"], tpot_thr),
        "capture_regressed": _worse_latency(comp["capture_ratio"], capture_thr),
    }

    vs_prev: Dict[str, Any] = {"available": False}
    if prev_e2e and isinstance(prev_e2e.get("agent"), dict):
        pa = prev_e2e["agent"]
        prev_out = float(pa.get("output_throughput_tok_s", 0) or 0)
        prev_tpot = float(pa.get("tpot_ms", 0) or 0)
        out_drop = (
            (prev_out - agent.output_throughput_tok_s) / prev_out
            if prev_out > 0 else None
        )
        tpot_up = (
            (agent.tpot_ms - prev_tpot) / prev_tpot
            if prev_tpot > 0 else None
        )
        vs_prev = {
            "available": True,
            "output_throughput_drop": round(out_drop, 3) if out_drop is not None else None,
            "tpot_increase": round(tpot_up, 3) if tpot_up is not None else None,
            "output_throughput_regressed": (
                out_drop is not None and out_drop > out_thr),
            "tpot_regressed": tpot_up is not None and tpot_up > tpot_thr,
        }

    regressed = (
        vs_baseline["output_throughput_regressed"]
        or vs_baseline["tpot_regressed"]
        or vs_baseline["capture_regressed"]
        or vs_prev.get("output_throughput_regressed", False)
        or vs_prev.get("tpot_regressed", False)
        or not agent.output_correct
    )
    return {
        "regressed": regressed,
        "vs_baseline": vs_baseline,
        "vs_prev": vs_prev,
        "thresholds": {
            "output_throughput": out_thr,
            "tpot": tpot_thr,
            "capture": capture_thr,
        },
    }


# --------------------------------------------------------------------------- #
# Baseline cache key — the invariant identity
# --------------------------------------------------------------------------- #

def _baseline_cache_key(req: Dict[str, Any]) -> str:
    """Stable hash of everything that defines the baseline serve result.

    The baseline uses the *stock* lmslim kernel, so it depends only on the
    model, tensor-parallel degree, and bench parameters (prompt/output len,
    #requests, concurrency, lmslim version) — NOT on the agent kernel. Any
    change to these invalidates the cache; the agent kernel path is
    deliberately excluded (it is the thing under test, not a baseline input).
    """
    identity = {
        "model": str(req.get("model_path", req.get("model", ""))),
        "tp": str(req.get("tp", req.get("tensor_parallel_size", "1"))),
        "lmslim_version": str(req.get("lmslim_version", "")),
        # bench params that change the measured throughput/latency
        "bench": {
            "input_len": str(req.get("e2e_input_len", req.get("input_len", "1024"))),
            "output_len": str(req.get("e2e_output_len", req.get("output_len", "128"))),
            "num_requests": str(req.get("e2e_num_requests", req.get("num_requests", "256"))),
            "concurrency": str(req.get("e2e_concurrency", req.get("concurrency", ""))),
            "port": str(req.get("e2e_port", req.get("port", "30000"))),
        },
    }
    blob = json.dumps(identity, sort_keys=True).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()[:16]
