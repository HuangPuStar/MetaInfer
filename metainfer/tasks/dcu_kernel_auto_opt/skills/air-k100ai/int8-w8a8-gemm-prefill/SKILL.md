---
name: int8-w8a8-gemm-prefill
description: >
  INT8 W8A8 GEMM prefill kernels (M>32) on the AIR-COOLED Hygon K100_AI
  (gfx928, no HBM address hashing): 2D M-tile staged-LDS DUMMA kernels, no
  split-K, occupancy/LDS tuning, and this board's M=3072 / M=4096 baselines.
  Air-board edition. Load together with int8-w8a8-gemm-foundations. For M<=32
  use int8-w8a8-gemm-decode.
---

<!-- metainfer-edition: air-k100ai -->

# INT8 W8A8 GEMM — Prefill (M > 32) — air board (K100_AI / DEV-AI, gfx928)

Prefill on this board has **no validated recipe yet**: every "accepted
architecture" ledger in the liquid edition was validated on `K500SM_AI /
DEV-HPC`, and this board's memory behaviour differs (no HBM address hashing ->
strided concurrent reads lose about half the bandwidth). Treat any inherited
recipe as a hypothesis to re-measure, never as a result.

> Baseline numbers for this board: `references/air-measured-baselines.md`
> (TP8 M=3072 and M=4096) and `baselines/air-k100ai.json`. **The liquid
> edition's latencies are not quotable here** and — for M=4096 — not even the
> cross-board ratios are readable (the reference rows are single-pass and one
> was visibly disturbed by a co-tenant, so they even look like "air is faster").
> The liquid edition lives in `skills/liquid-k500sm/` and is not installed here.

## 1. Where to start

1. Read `references/air-measured-baselines.md` and take the **air** baseline for
   the exact shape via `fixed_triton_graph_baseline(...)`.
2. Reuse this board's kernels from `variant/air-k100ai/` where the family
   matches; nothing in the liquid tree counts as evidence here.
3. Because this board loses most on fragmented reads, make the **read pattern**
   the first design variable: stage through LDS with longer contiguous chunks,
   keep the resident block's data reused across K rather than re-reading HBM,
   and prefer merged/wider vector loads. Occupancy and LDS micro-tuning come
   after that, not instead of it.

## 2. Kernel shape for M > 32 *(method, carried)*

- Prefill is **LDS/compute-bound** at ms scale: 2D M-tile kernels with staged
  LDS and **no split-K** (split-K's combine cost dominates here).
- Block sizes are multiples of the 64-lane wavefront; the INT8 primitive is
  `m16n16k32`.
- Keep a scalar fallback for unmatched shapes and for the small-M API cases.
- Shape-specific packed weight layouts are allowed (one-time, out of the timed
  region and out of Graph capture, same byte count, graph-stable addresses,
  correctness checked against the raw logical `[K,N]` weight).

## 3. Boundary: 32 < M < 3072

Unmeasured on this board. Route by measurement and keep one arm per regime
(staged prefill vs decode-compatible) until an exact-shape measurement exists.

## 4. Acceptance protocol *(method)*

1. Correctness on the exact shape (extreme + random int8), Graph capture ->
   content update -> replay -> compare.
2. Fair unprofiled GPU-event timing; median + p90; three independent passes.
3. **Large-M reference cache**: the CPU int64 exact reference takes minutes to
   hours at these shapes. The control plane pre-seeds it once per shape
   (`w8a8_bench.py --prepare-reference`) — never run a large-M correctness check
   without it, and never use a CPU int64 GEMM as an ad-hoc reference (no BLAS
   path for int64: a single shape took 76 s in this workspace's own tooling).
   A chunked fp32 GEMM with int32 accumulation is exact here, because
   `127*127*chunk < 2**24`.
4. Confirm the device was actually idle for the timed run (`VRAM <= 90%`,
   `HCU == 0`); this is a shared host and a co-tenant can move a ms-scale number
   by tens of percent.
5. A promoted variant's `speedup` must come from this board's baseline entry for
   the same exact (TP, M, N, K); otherwise the promote path omits the ratio.

## 5. Rejected / guardrail evidence *(method)*

The liquid ledger's rejected ideas are worth reading for the *reasoning* traps
(claiming an allocation removal as kernel acceleration, using profiled time as
the score, accepting a change with stale profile data). Their numbers are the
liquid board's: re-measure before you reuse or refute any of them here.

## 6. What to publish

A prefill round on this board produces accepted kernels under
`variant/air-k100ai/<family>/<model>/TP<n>/M<m>/` (stamped with this board and
its measurement date) and, optionally, a skill published into this air edition:
include the shape, the air baseline it beat, the protocol, and the resource
report. Do not import liquid figures into it.
