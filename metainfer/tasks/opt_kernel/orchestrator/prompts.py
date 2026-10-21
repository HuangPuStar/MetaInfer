"""Prompt templates for opt-kernel sub-agents.

Concise prompts — the bare minimum to drive the ABCDEF loop for GPU kernel
optimization. Each builder returns a rendered prompt string.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional


NOTEBOOKS_HINT = """Knowledge base: `notebooks/` directory. Use Glob + Read tools to consult
relevant reference designs. Read only the files matching this iteration's task."""

HARDWARE_DETECTION_MANDATE = """# MANDATORY: detect actual GPU hardware BEFORE writing any code
The `target_hardware` field in the requirements is what the USER selected — it may
be aspirational, inaccurate, or for a different machine. Your kernel MUST target the
HARDWARE THAT IS ACTUALLY PRESENT on this machine, not what the user typed.

Before writing a single line of kernel code, RUN these detection commands and report
what you find:

```bash
# Detect GPU vendor and model
if command -v rocm-smi >/dev/null; then
    echo "=== ROCm platform ==="
    rocm-smi --showproductname 2>/dev/null || rocm-smi -a 2>/dev/null | grep -i 'Card Series' | head -4
    echo "HIP version:" && hipconfig --full 2>/dev/null | grep 'HIP version' | head -1
elif command -v nvidia-smi >/dev/null; then
    echo "=== NVIDIA platform ==="
    nvidia-smi --query-gpu=name,compute_cap --format=csv,noheader
else
    echo "=== No GPU tool found ==="
    lspci | grep -i -E 'vga|3d|display|accelerator' || echo "unknown"
fi

# Check available toolchain
echo "=== Toolchain ==="
which hipcc 2>/dev/null || echo "no hipcc"
which nvcc 2>/dev/null || echo "no nvcc"
python3 -c "import triton; print('Triton', triton.__version__)" 2>/dev/null || echo "no Triton"
python3 -c "import torch; print('PyTorch', torch.__version__, 'CUDA', torch.version.cuda)" 2>/dev/null || echo "no PyTorch"
```

Rules:
1. **Run this FIRST** in your first Bash turn. Do not skip it.
2. **Report the actual hardware** in your plan.md / first commit message.
3. **If actual hardware differs from target_hardware**, write the kernel for the
   ACTUAL hardware, but note the discrepancy in plan.md. The requirements field is
   a user aspiration; the real hardware is the build target.
4. **Use the toolchain that actually exists**: if `hipcc` is present, write HIP
   kernels. If `nvcc` is present, write CUDA kernels. If Triton is available,
   prefer Triton for portability. Never assume a toolchain that isn't installed.
5. **Verify after compilation**: run a trivial smoke test (allocate, copy, launch a
   tiny kernel) to confirm the runtime works before attempting the full kernel."""



def _render_req(req: Dict[str, Any]) -> str:
    from metainfer.orchestrator.requirements import req_summary_lines
    return "\n".join(req_summary_lines(req))


def plan_prompt(
    req: Dict[str, Any],
    iter_dir: Path,
    notebooks_dir: Path,
    iteration: int,
    prev_failures: Optional[str] = None,
    review_feedback: Optional[str] = None,
    perf_plan: Optional[str] = None,
    logs_dir: Optional[Path] = None,
    user_feedback: Optional[str] = None,
    prediction_verdict: Optional[str] = None,
    debugger_overview: Optional[str] = None,
    search_mode: Optional[str] = None,
    cross_task_lessons: Optional[str] = None,
    flow: Optional[str] = None,
    kernel_zoo_block: Optional[str] = None,
) -> str:
    pf = prev_failures or "(none — first iteration)"
    rf = f"\n\n# Previous iteration's review\n{review_feedback}" if review_feedback else ""
    pp = f"\n\n# Previous perf plan\n{perf_plan}" if perf_plan else ""
    # Operator feedback (persistent guidance — applies to this and every
    # following iteration until the run ends). Surfaced FIRST, before prior
    # failures, so human direction takes priority over machine history.
    uf = (f"\n\n# Operator feedback (from the human operator; treat as a\n"
          f"# standing directive for this and all following iterations)\n"
          f"{user_feedback}") if user_feedback else ""
    # P2 (AHE decision observability): the verdict on the PREVIOUS
    # iteration's predictions (confirmed/falsified/inconclusive per planned
    # change). Surfaced before "Previous failures" so the planner first
    # checks whether its last bets paid off, then reads the failure text.
    # See ``docs/opt_kernel_ahe.md`` §4.
    pv = (f"\n\n# Previous change-evaluation verdict (your last predictions)\n"
          f"{prediction_verdict}\n"
          f"Falsified predictions mean the change did NOT deliver the expected "
          f"perf move — do NOT repeat that change as-is.") if prediction_verdict else ""
    # P1 (AHE experience observability): cross-iteration distilled evidence
    # from the Agent Debugger. Surfaced before "Previous failures" so the
    # planner sees cross-iteration patterns ("tiling regressed correctness
    # 2/3 times") before the single-step failure text. Falls back to the
    # 1-step prev_failures when no corpus exists yet. See
    # ``docs/opt_kernel_ahe.md`` §5.
    dov = (f"\n\n# Cross-iteration debugger evidence (distilled from prior iters)\n"
           f"{debugger_overview}") if debugger_overview else ""
    # Search mode (flame-chase-style): a plateau-triggered directive to escape
    # the current local optimum. Advisory — nudges the plan, not the gate.
    if search_mode == "rewrite":
        sm = (f"\n\n# Search mode: REWRITE (plateau detected)\n"
              f"The primary performance metric has not improved for several "
              f"iterations — you are stuck on a local optimum. This iteration, "
              f"make a STRUCTURAL change to the kernel rather than another "
              f"incremental config tweak: rewrite the tiling / split-K / "
              f"pipelining strategy, or move to a different implementation "
              f"approach. Keep the kernel correct on every legal input. Keep "
              f"the current best config documented as a one-line revert.")
    elif search_mode == "fine_tune":
        sm = (f"\n\n# Search mode: FINE-TUNE\n"
              f"Make a small, verifiable incremental improvement to the current "
              f"best kernel.")
    else:
        sm = ""
    # Cross-task lessons (AHE experience accumulation): a block distilled from
    # prior tasks of this type (node-level wiki). Advisory — reminds the agent
    # of known failure modes / do-not-repeat lists so it does not rediscover
    # them. None when the wiki is empty / this is the first task.
    ctl = (f"\n\n{cross_task_lessons}") if cross_task_lessons else ""
    # Kernel zoo (KDA): matching proven kernels from prior tasks, inlined as
    # reusable scaffolds / a starting point. None when the zoo is empty / no
    # match — the section is omitted entirely.
    kzb = (f"\n\n{kernel_zoo_block}") if kernel_zoo_block else ""
    # Humanize-style flow directive (advisory). For flame_chase the search-mode
    # block already carries the rewrite/fine-tune directive; ralph_loop and
    # rlar add a one-line framing so the agent understands which flow it is in.
    flow_norm = (flow or "flame_chase").strip().lower()
    if flow_norm == "ralph_loop":
        fd = ("\n\n# Flow: RALPH_LOOP (Humanize)\n"
              "This run grinds the same task round after round in a fresh "
              "session each iteration until the budget stops it — there is "
              "no plateau-triggered rewrite. Keep making the best incremental "
              "progress you can verify; do not throw away a working kernel.")
    elif flow_norm == "rlar":
        fd = ("\n\n# Flow: RLAR (Humanize) — actor + fresh reviewer\n"
              "A fresh reviewer reads each iteration's work and its notes drive "
              "the next plan. Aim for a complete, self-contained, reviewer-"
              "satisfying kernel each iteration; the search-mode block below "
              "stays in FINE-TUNE.")
    else:
        fd = ""
    return f"""You are the **PLANNER** for GPU kernel optimization, iteration #{iteration}.

# Task requirements
{_render_req(req)}

# Working directory
{iter_dir}

# Knowledge base
{NOTEBOOKS_HINT}
Path: {notebooks_dir}
{uf}
{dov}
{fd}
{sm}
{ctl}
{kzb}
{pv}

# Previous failures
{pf}{rf}{pp}

# Deliverables
Write exactly three files in `{iter_dir}`:
1. `plan.md` — work plan: goal, file-by-file work items, test plan, perf targets, risks
2. `test_spec.md` — test spec: inputs, expected outputs, JSON output shape
3. `predictions.json` — falsifiable perf bets (AHE decision observability)

### `predictions.json` schema
A JSON object with an optional ``baseline_perf`` (echo the last measured perf
you can read from the previous iteration's `perf_report.json` if present) and
a ``predictions`` array. Each prediction is a structured, falsifiable claim
about ONE planned change:
```json
{{
  "baseline_perf": {{"tokens_per_sec": 0.0, "ms_per_op": 0.0, "speedup": 0.0}},
  "predictions": [
    {{
      "id": "p1",
      "change": "one-line description of the change",
      "target_metric": "tokens_per_sec",
      "direction": "increase",
      "expected_delta_pct": 15.0,
      "reason": "why this should move the metric this much",
      "at_risk_metrics": ["ms_per_op", "correctness"],
      "confidence": 0.7
    }}
  ]
}}
```
Rules:
- ``direction`` is ``increase`` for bigger-is-better metrics
  (tokens_per_sec / speedup / gflops / bandwidth_gb_s) and ``decrease`` for
  ms_per_op.
- ``expected_delta_pct`` is the RELATIVE change you predict vs the current
  baseline. Be honest — next round this is checked against the actual perf
  delta and falsified predictions are surfaced back to you.
- If you genuinely cannot predict a magnitude, set ``expected_delta_pct`` to
  a small positive number and keep ``confidence`` low. Do NOT omit the file.
- One prediction per distinct change. Keep it to 1-3 predictions.

### Kernel correctness: agent-written test.sh
For correctness, the implementer will write `test.sh`. The test MUST output a
JSON line: `{{"passed": true/false, "perf": {{...}}, "notes": "..."}}`.

Do NOT write code. Planning only.

{HARDWARE_DETECTION_MANDATE}
"""


def implement_prompt(
    req: Dict[str, Any],
    iter_dir: Path,
    notebooks_dir: Path,
    iteration: int,
    prev_failure: Optional[str] = None,
    review_feedback: Optional[str] = None,
    perf_plan: Optional[str] = None,
    logs_dir: Optional[Path] = None,
) -> str:
    pf = prev_failure or "(none)"
    rf = f"\n\n# Review from previous iteration\n{review_feedback}" if review_feedback else ""
    pp = f"\n\n# Perf plan to execute\n{perf_plan}" if perf_plan else ""
    return f"""You are the **IMPLEMENTER** for GPU kernel optimization, iteration #{iteration}.

# Task requirements
{_render_req(req)}

# Working directory
{iter_dir}

# Plan
Read `{iter_dir}/plan.md` and `{iter_dir}/test_spec.md`.

# Knowledge base
{NOTEBOOKS_HINT}
Path: {notebooks_dir}

# Previous failure
{pf}
Fix this FIRST if a failure is shown.{rf}{pp}

# Deliverables
1. The kernel code described in the plan, inside `{iter_dir}`.
2. A test script at `{iter_dir}/test.sh` (bash, executable):
   - Compile and run the kernel, compare output against a correctness reference.
   - On success print: `{{"passed": true, "perf": {{"<metric>": <number>}}, "notes": "..."}}`
   - On failure print: `{{"passed": false, "error": "...", "traceback": "..."}}`
   - Exit 0 in all cases.

{HARDWARE_DETECTION_MANDATE}

# Mandatory self-test
Before declaring B done, run `bash {iter_dir}/test.sh` yourself. If it doesn't
pass, fix the kernel before handing off to C.
"""


def implement_redo_prompt(
    req: Dict[str, Any],
    iter_dir: Path,
    notebooks_dir: Path,
    iteration: int,
    prev_failure: Optional[str] = None,
    logs_dir: Optional[Path] = None,
) -> str:
    return f"""Your previous B (implement) turn did not produce a working kernel.
You're in a resumed session — do NOT re-bootstrap.

# What went wrong
{prev_failure or "(no detail)"}

# Working directory
{iter_dir}

Fix the issue with minimal edits. Re-run `bash test.sh` to confirm before exiting.
"""


def write_test_harness_prompt(
    req: Dict[str, Any],
    iter_dir: Path,
    notebooks_dir: Path,
    iteration: int,
) -> str:
    return f"""You are the **TEST HARNESS WRITER** for iteration #{iteration}.

Write `{iter_dir}/test.sh` that compiles + runs the kernel in `{iter_dir}` and
compares against a reference implementation.

Output contract:
- success → `{{"passed": true, "perf": {{"<metric>": <number>}}, "notes": "..."}}`
- failure → `{{"passed": false, "error": "...", "traceback": "..."}}`
- exit 0 always.

Knowledge base: {notebooks_dir}
"""


def review_prompt(
    req: Dict[str, Any],
    iter_dir: Path,
    notebooks_dir: Path,
    iteration: int,
    outcome: Optional[str] = None,
    failure: Optional[str] = None,
    perf: Optional[Dict[str, float]] = None,
    logs_dir: Optional[Path] = None,
) -> str:
    oc = f"C outcome: **{outcome}**" if outcome else "C outcome: (not provided)"
    fb = f"\nFailure:\n```\n{failure}\n```" if failure else ""
    pf = f"\nPerf: {json.dumps(perf)}" if perf else ""
    review_path = (logs_dir / "review.md") if logs_dir else iter_dir / "review.md"
    return f"""You are the **REVIEWER** for iteration #{iteration}.

# Task
{_render_req(req)}

# Test outcome
{oc}{fb}{pf}

# Working directory
{iter_dir}

Read the code, plan, and test output. Write `{review_path}`:
- **Verdict**: PASS / NEEDS_FIX (advisory)
- **Root cause** (if C failed): cite specific error
- **Issues**: list with file:line and fixes
- **Suggestions for next iteration**: prioritized
- **Confidence**: 1-5

Do NOT modify code. Review only.
"""


def review_prompt_a(
    req: Dict[str, Any],
    iter_dir: Path,
    notebooks_dir: Path,
    iteration: int,
    outcome: Optional[str] = None,
    failure: Optional[str] = None,
    perf: Optional[Dict[str, float]] = None,
    logs_dir: Optional[Path] = None,
) -> str:
    """Reviewer A: correctness perspective.

    Focuses on numerical correctness, edge cases, dtype handling, and
    whether the kernel matches the reference implementation. Writes
    ``review-A.md``.
    """
    oc = f"C outcome: **{outcome}**" if outcome else "C outcome: (not provided)"
    fb = f"\nFailure:\n```\n{failure}\n```" if failure else ""
    pf = f"\nPerf: {json.dumps(perf)}" if perf else ""
    review_path = (logs_dir / "review-A.md") if logs_dir else iter_dir / "review-A.md"
    return f"""You are **REVIEWER A (correctness)** for iteration #{iteration}.

# Task
{_render_req(req)}

# Test outcome
{oc}{fb}{pf}

# Working directory
{iter_dir}

# Your focus: CORRECTNESS
You are the correctness reviewer. Focus on:
- **Numerical accuracy**: Does the kernel match the reference (PyTorch eager / w8a8_scaled_mm reference)? Check dtype handling, accumulation order, scale fusion.
- **Edge cases**: M=1 (single token), M=32 (decode batch), M=4096 (prefill). K/N alignment. Odd shapes that don't tile evenly.
- **Quantization correctness**: Is the per-token x_scale applied correctly? Is the per-channel weight_scale transposed properly? Is the int8→int32 accumulation correct?
- **Overflow / saturation**: Can the int32 accumulator overflow for large K? Are scales in the right range?
- **Determinism**: Is the kernel deterministic across runs?

Read the code, plan, and test output. Write `{review_path}`:
- **Verdict**: PASS / NEEDS_FIX (advisory)
- **Correctness issues**: list with file:line and severity (critical/minor)
- **Edge case gaps**: shapes or dtypes not tested
- **Root cause** (if C failed): cite specific error
- **Suggestions for next iteration**: correctness-focused, prioritized
- **Confidence**: 1-5

Do NOT modify code. Review only.
"""


def review_prompt_b(
    req: Dict[str, Any],
    iter_dir: Path,
    notebooks_dir: Path,
    iteration: int,
    outcome: Optional[str] = None,
    failure: Optional[str] = None,
    perf: Optional[Dict[str, float]] = None,
    logs_dir: Optional[Path] = None,
) -> str:
    """Reviewer B: performance perspective.

    Focuses on kernel performance, memory access patterns, occupancy,
    and whether the kernel achieves the target speedup. Writes
    ``review-B.md``.
    """
    oc = f"C outcome: **{outcome}**" if outcome else "C outcome: (not provided)"
    fb = f"\nFailure:\n```\n{failure}\n```" if failure else ""
    pf = f"\nPerf: {json.dumps(perf)}" if perf else ""
    review_path = (logs_dir / "review-B.md") if logs_dir else iter_dir / "review-B.md"
    return f"""You are **REVIEWER B (performance)** for iteration #{iteration}.

# Task
{_render_req(req)}

# Test outcome
{oc}{fb}{pf}

# Working directory
{iter_dir}

# Your focus: PERFORMANCE
You are the performance reviewer. Focus on:
- **Throughput**: Is the kernel achieving the target speedup vs baseline (lmslim matmul_int8)? Is it compute-bound or memory-bound?
- **Memory access patterns**: Are loads coalesced? Is the K-dimension loop tiled for L2/LDS reuse? Is the weight matrix layout (TN vs NT) optimal for the target arch?
- **Occupancy**: Is the workgroup size appropriate for gfx928 (128 CU, wavefront=64)? Are register/LDS usage within limits?
- **Decode vs prefill**: Is the kernel tuned for both M≤32 (decode, latency-sensitive) and M=4096 (prefill, throughput-sensitive)? Different tile sizes may be needed.
- **CUDA Graph compatibility**: Can the kernel be captured into a CUDA Graph (no host-side allocation, no dynamic shapes)?
- **Triton config**: Are BLOCK_SIZE_M/N/K, num_warps, num_stages, SPLIT_K tuned for each M regime? The baseline uses different configs per M bucket.
- **Scale fusion**: Is the per-token/per-channel scale fused into the epilogue, or done as a separate kernel pass?

Read the code, plan, and test output. Write `{review_path}`:
- **Verdict**: PASS / NEEDS_FIX (advisory)
- **Performance issues**: list with file:line and expected impact
- **Bottleneck analysis**: compute-bound? memory-bound? launch-overhead-bound?
- **Tuning suggestions**: specific BLOCK_SIZE / num_warps / SPLIT_K recommendations per M regime
- **Speedup assessment**: current vs baseline, and what's needed to hit target
- **Confidence**: 1-5

Do NOT modify code. Review only.
"""


def c_repair_prompt(
    req: Dict[str, Any],
    iter_dir: Path,
    notebooks_dir: Path,
    iteration: int,
    attempt: int,
    max_attempts: int,
    failure: Optional[str],
    logs_dir: Optional[Path] = None,
) -> str:
    remaining = max(0, max_attempts - attempt)
    return f"""You are the **C-STEP DEBUGGER** for iteration #{iteration}, attempt {attempt}/{max_attempts} ({remaining} remaining).

C failed with:
```
{failure or "(no detail)"}
```

# Working directory
{iter_dir}

Fix ONE root cause with minimal edits. Verify locally. Stop after the fix.
Do NOT re-run the full test suite — the orchestrator does that.
"""


def c_repair_followup_prompt(
    iteration: int,
    attempt: int,
    max_attempts: int,
    new_failure: Optional[str],
    logs_dir: Path,
) -> str:
    remaining = max(0, max_attempts - attempt)
    return f"""C-step re-run still FAILED. Attempt {attempt}/{max_attempts} ({remaining} remaining).

New failure:
```
{new_failure or "(no detail)"}
```

You're in a resumed session. Fix ONE root cause. Minimal edits. Stop after the fix.
"""


def perf_test_prompt(
    req: Dict[str, Any],
    iter_dir: Path,
    notebooks_dir: Path,
    iteration: int,
    review_feedback: Optional[str] = None,
    logs_dir: Optional[Path] = None,
) -> str:
    return f"""You are the **PERF TESTER** for iteration #{iteration}.

The kernel PASSED correctness. Measure its performance.

# Working directory
{iter_dir}

# Deliverables
1. Write `{iter_dir}/perf.sh` — benchmarks the kernel with realistic shapes,
   warmup, multiple runs. Outputs `perf_report.json`.
2. Run it and produce:
   ```json
   {{"tokens_per_sec": <float>, "ms_per_op": <float>, "gflops": <float>,
     "bandwidth_gb_s": <float>, "notes": "..."}}
   ```
3. Print one JSON line to stdout: `{{"passed": true, "perf": {{...}}, "notes": "..."}}`

Do NOT modify the kernel. Benchmark only.
"""


def perf_plan_prompt(
    req: Dict[str, Any],
    iter_dir: Path,
    notebooks_dir: Path,
    iteration: int,
    last_perf: Optional[Dict[str, float]] = None,
    review_feedback: Optional[str] = None,
    logs_dir: Optional[Path] = None,
    prediction_verdict: Optional[str] = None,
    profiler_hint: Optional[str] = None,
) -> str:
    lp = json.dumps(last_perf) if last_perf else "(read perf_report.json)"
    # P2 (AHE decision observability): the verdict on THIS iteration's
    # predictions (computed by the orchestrator after E). Helps the perf
    # planner learn which bets paid off this round. See
    # ``docs/opt_kernel_ahe.md`` §4.
    pv = (f"\n\n# This iteration's change-evaluation verdict\n"
          f"{prediction_verdict}") if prediction_verdict else ""
    # Profiling skill hint (advisory): tells the perf planner a ready rocprof
    # tool exists + the iter-#14 methodology (bind a dedicated idle card).
    ph = profiler_hint or ""
    return f"""You are the **PERF PLANNER** for iteration #{iteration}.

# Working directory
{iter_dir}

# Last measured perf
{lp}{pv}

Read `{iter_dir}/perf_report.json` and `{iter_dir}/change_evaluation.json`
(if present) and write `{iter_dir}/perf_plan.md`:
1. Current perf baseline
2. Bottleneck analysis (kernel bound? memory bandwidth? launch overhead?)
3. Planned optimizations (prioritized, with expected impact + confidence)
4. What NOT to do
{ph}
Do NOT modify code. Planning only.
"""


def retrospective_prompt(
    req: Dict[str, Any],
    iter_dir: Path,
    notebooks_dir: Path,
    iteration: int,
    this_perf: Optional[Dict[str, float]] = None,
    prev_perf: Optional[Dict[str, float]] = None,
    review_feedback: Optional[str] = None,
    e_ok: bool = True,
    e_error: Optional[str] = None,
    logs_dir: Optional[Path] = None,
    goal: Optional[str] = None,
) -> str:
    tp = json.dumps(this_perf) if this_perf else "(none)"
    pp = json.dumps(prev_perf) if prev_perf else "(none)"
    es = "E PASSED" if e_ok else f"E FAILED: {e_error or 'unknown'}"
    gl = goal or "(no goal)"
    return f"""You are the **RETROSPECTIVE WRITER** for iteration #{iteration}.

Write `{logs_dir}/retrospective.md`:
- **Goal**: {gl}
- **E status**: {es}
- **Perf this iter**: {tp}
- **Perf prev iter**: {pp}

Read `{iter_dir}/plan.md` and the code for context. Synthesize, don't dump.

Sections: Goal, What changed, Perf vs prev, Why perf moved, Review summary, Caveats.
Keep under 600 words. Do NOT modify code.
"""


def failure_retrospective_prompt(
    req: Dict[str, Any],
    iter_dir: Path,
    notebooks_dir: Path,
    iteration: int,
    failure_reason: Optional[str] = None,
    failed_phase: Optional[str] = None,
    phase_attempts: Optional[int] = None,
    logs_dir: Optional[Path] = None,
    goal: Optional[str] = None,
) -> str:
    fr = failure_reason or "(unknown)"
    fp = failed_phase or "(unknown)"
    gl = goal or "(no goal)"
    return f"""You are the **POSTMORTEM WRITER** for FAILED iteration #{iteration}.

Write `{logs_dir}/retrospective.md`:
- **Goal**: {gl}
- **Failed phase**: {fp}
- **Failure**: {fr}

Read the plan, code, and diagnostic logs. Sections: What was tried, Where it broke,
Recovery attempted, Why recovery didn't work, What next iter should do differently.
Keep under 600 words. Do NOT modify code.
"""


def debugger_prompt(
    req: Dict[str, Any],
    iterations_root: Path,
    iteration: int,
    iter_dir: Path,
    logs_dir: Path,
    iteration_summary: str,
    timeline_excerpt: str,
    prior_overview_exists: bool,
    prior_detail_paths: List[str],
) -> str:
    """Prompt for the Agent Debugger (P1, AHE experience observability).

    The debugger runs advisory after each iteration closes. Its cwd is the
    workspace ``iterations_root`` so it can read every iteration directory
    and write the two-layer evidence corpus under ``analysis/``. The
    orchestrator pre-computes the iteration summary + a compact timeline
    excerpt and embeds them as text (the agent has no direct access to
    ``state_dir``); the agent reads the on-disk artifacts (plan/code/reviews/
    perf_report/retrospective/predictions/change_evaluation) for drill-down.
    See ``docs/opt_kernel_ahe.md`` §5.
    """
    prior = ""
    if prior_overview_exists:
        prior += (f"A prior `analysis/overview.md` already exists — read it and "
                  f"REVISE it (don't start from scratch; fold in this iter).\n")
    if prior_detail_paths:
        prior += "Prior per-iteration analyses to build on (read for patterns):\n"
        for p in prior_detail_paths:
            prior += f"- {p}\n"
    if not prior:
        prior = "(no prior analyses — this is iteration #1; establish the corpus.)"
    return f"""You are the **AGENT DEBUGGER** for GPU kernel optimization, iteration #{iteration}.

You distill this iteration's full trajectory into a layered, sourced evidence
corpus that the PLANNER of future iterations will read. This is AHE "experience
observability": raw traces are too big to feed forward — you compress them into
structured root-cause reports, every claim linked back to a concrete artifact.

# Working directory (workspace root — all iteration dirs are siblings)
{iterations_root}
This iteration's dir:  `{iter_dir}`
This iteration's logs: `{logs_dir}`

# Pre-computed iteration summary (from the orchestrator's state)
{iteration_summary}

# Compact timeline excerpt (this iteration only)
{timeline_excerpt}

# Prior corpus
{prior}

# What to read for drill-down (use Read/Glob tools)
- `{iter_dir}/plan.md`, `predictions.json`, `change_evaluation.json` (if present)
- `{iter_dir}/perf_report.json`
- the kernel code in `{iter_dir}`
- `{logs_dir}/retrospective.md` and any review/audit logs in `{logs_dir}`

# Deliverables (write BOTH files)
1. `analysis/detail/iter_{iteration:03d}.md` — per-iteration deep analysis:
   - **What changed** this iter (from plan.md / code diff vs prior iter)
   - **Why perf moved** (or why it didn't) — root cause, not just "it went up"
   - **Prediction verdicts**: which of this iter's predictions confirmed/falsified
     and WHY (link each to the change_evaluation entry)
   - **Recurring failure-mode flags**: patterns seen across iterations (read prior
     detail files) — e.g. "shared-mem tiling regressed correctness 2/3 times"
   - Every claim cites a file/line or timeline event. Synthesize, don't dump.
2. `analysis/overview.md` — cross-iteration root-cause summary (REWRITE the whole
   file each run, folding in this iteration):
   - **What helps / what hurts** (concrete change families, with counts)
   - **Recurring failure modes** (the "do not repeat" list)
   - **Falsified-prediction patterns** (change families that consistently
     under-deliver vs claimed)
   - **Suggested directions** for the next planner
   - Keep under ~500 words. This is the digest the planner reads by default.
3. `analysis/lessons.jsonl` — structured, machine-readable lessons distilled
   from this task so far, ONE JSON OBJECT PER LINE (no array, no comments):
   ```
   {{"category": "failure_mode", "headline": "<short, imperative>", "detail": "<1-2 sentences>"}}
   ```
   `category` MUST be one of `failure_mode` (a root cause that recurs across
   iterations), `do_not_repeat` (a change that is banned / already shipped and
   must not be reattempted), or `insight` (a durable positive finding).
   Write 0-8 lines. Be specific and actionable ("BN=64 OOMs the 64 KB
   shared-mem budget; cap BK*BN at 48 KB" not "tiling is hard"). The
   orchestrator appends these to a node-level wiki so FUTURE tasks of this
   type read them at plan time — this is how experience survives across tasks.
   Omit the file entirely if you have nothing durable to record this run.

Do NOT modify any kernel code or iteration artifacts. You only WRITE under `analysis/`.
"""
