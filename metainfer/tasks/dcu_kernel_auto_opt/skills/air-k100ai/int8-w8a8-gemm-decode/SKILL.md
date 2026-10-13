---
name: int8-w8a8-gemm-decode
description: >
  INT8 W8A8 GEMM decode kernels (M<=32) on the AIR-COOLED Hygon K100_AI
  (gfx928, no HBM address hashing): split-K partial kernels with fused atomic
  combine, small-M zero-pad path, and a µs-scale acceptance protocol with noise
  tolerance. Air-board edition: baselines in references/ are kme6's own. Load
  together with int8-w8a8-gemm-foundations. For M>32 use int8-w8a8-gemm-prefill.
---

<!-- metainfer-edition: air-k100ai -->

# INT8 W8A8 GEMM — Decode (M <= 32) — air board (K100_AI / DEV-AI, gfx928)

This board has **no HBM address hashing**: many threads reading strided (a few
rows per pass, rows 4 KiB apart) collapse onto the same memory channels, so
concurrent-read bandwidth is roughly half the liquid board's. On the TP8 M=8
decode family — where both boards were measured with the same script and
protocol — that costs **1.06-1.40x**, and the loss tracks how fragmented the read
is: `shared_down_proj` K=256 loses 1.399x, `qkv_proj` K=6144 only 1.059x.

> The liquid edition of this skill is a ledger of M=2 / M=16 kernels measured on
> `K500SM_AI / DEV-HPC`. **Nothing in it is validated on this board**, and its
> latencies must not be quoted here. It lives in `skills/liquid-k500sm/` and is
> not installed on this machine. Your numbers come from
> `references/air-measured-baselines.md` or your own rounds.

## 1. Where to start (this board)

1. Read `references/air-measured-baselines.md`: TP8 M=8 (15 shapes, with the
   reference board's value and the ratio) and TP8 M=16 (air values only).
2. Pick the shape's **air** baseline from `baselines/air-k100ai.json` via
   `fixed_triton_graph_baseline(...)`; that number is what a promoted variant's
   `speedup` is computed against. A record with `profile_mismatch=True` is the
   other board's and must never become a speedup.
3. Reuse this board's accepted kernels from `variant/air-k100ai/` if one matches
   your (operator, model, TP, M) family — same-board evidence, still requiring a
   full re-validation.

## 2. Kernel shape for M <= 32 *(method, carried from the liquid edition)*

- Decode is **launch/latency-bound**: a µs-scale measurement where a few extra
  instructions and one extra barrier are visible, and where noise is a real
  threat to acceptance (see §4).
- The family that worked: **split-K partial kernels with a fused atomic
  combine**, small tiles, and a zero-padded small-M path for M below the tile.
- Keep a simple scalar int8/int32 fallback for unmatched shapes; it is also the
  bootstrap path and the correctness anchor.
- Prefer direct fragment epilogues (no accumulator LDS round trip, one fewer
  barrier) once the lane ownership is verified.
- **On this board, spend the effort on the read pattern first**: fewer, longer
  contiguous chunks per thread (merged/wider vector loads, contiguous weight
  layout, one resident block reusing its data) beat occupancy or tile
  micro-tuning, because the strided-read penalty is not something those levers
  can buy back.

## 3. Boundary: 16 < M <= 32

An extrapolation gap on both boards. Route by measurement: keep a
decode-compatible arm and a prefill-compatible arm until one is measured for the
exact shape, and do not assume the M<=16 recipe scales.

## 4. Acceptance protocol (µs-scale noise) *(method)*

1. Correctness first, on the exact shape, extreme and random int8 values, and
   the M tails.
2. Graph capture -> update static input contents -> replay -> compare again.
3. Fair unprofiled GPU-event timing with the protocol in the foundations skill
   (warmups 50, samples 50-100, launches/sample 20, median + p90 + min).
4. **Noise discipline**: this board is a shared host. Check the device is
   actually free before a timed run (`VRAM <= 90%` and `HCU == 0`), take
   three independent passes, and compare medians. A candidate inside the
   pass-to-pass dispersion of the baseline is **not** an improvement; the
   measured dispersion of this board's baseline table is ~0.7% median, with a
   tail on the tiny shapes.
5. A speedup is only meaningful against **this board's** baseline entry for the
   same exact (TP, M, N, K), and the promotion gates re-check it server-side.

The task's own harness (`w8a8_bench.py`, `profile_pmc.sh`, the acceptance
thresholds in the task record) owns the authoritative protocol; this skill only
explains what tends to fail.

## 5. Rejected ideas worth knowing *(method, from the liquid ledger)*

The liquid edition lists decode ideas that were measured and failed there
(among them: pretending an allocation removal is kernel acceleration, and
treating PMC time as the score). Those *reasoning* traps are board independent
and are kept in the foundations skill's guardrails; the **numbers** behind them
are not, so re-measure before reuse.

## 6. What to publish

A decode round on this board produces:
- an accepted kernel promoted into `variant/air-k100ai/<family>/<model>/TP<n>/M<m>/`
  (the promote path stamps `hw_profile=air-k100ai machine=kme6 measured_on=...`
  and computes `speedup` against the air baseline, or omits the ratio when only
  the other board's baseline exists);
- optionally a skill published into this air edition — with the shape, the air
  baseline it beat, and the measurement protocol. Never a liquid figure.
