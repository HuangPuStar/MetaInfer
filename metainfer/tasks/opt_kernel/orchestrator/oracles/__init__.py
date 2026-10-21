"""opt-kernel oracles.

* :mod:`.perf` — fixed benchmark harness for GPU kernel optimization.
  Replaces the agent-written perf.sh with a deterministic, comparable
  benchmark that captures rocprof profile artifacts.
* :mod:`.correctness` — immutable correctness referee. Runs the agent's
  kernel against the same PyTorch reference as the perf oracle, on a
  fixed edge-case shape set, so C_test is no longer gated solely by the
  agent's own (contestant) test.sh.
* :mod:`.profiler` — rocprof wrapper (kernel stats, counters, HIP trace).
* :mod:`.e2e` — advisory model-level oracle. Runs the agent's kernel inside
  a real sglang serve and compares TTFT/TPOT/output throughput/capture cost
  against the stock lmslim baseline (cached as an invariant). Advisory-only:
  collects data on the per-shape-bench blind spots without gating.
"""

from .perf import KernelPerfOracle, PerfReport  # noqa: F401
from .correctness import KernelCorrectnessOracle, CorrectnessReport  # noqa: F401
from .e2e import E2EOracle, E2EReport, E2ERunner, BenchResult  # noqa: F401
