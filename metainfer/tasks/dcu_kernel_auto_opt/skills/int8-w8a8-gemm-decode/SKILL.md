---
name: int8-w8a8-gemm-decode
description: >
  INT8 W8A8 GEMM decode kernels for M<=32 on Hygon K500SM_AI/gfx928: split-K
  partial kernels with fused atomic combine, small-M zero-pad path, and a
  µs-scale acceptance protocol with noise tolerance. Load together with
  int8-w8a8-gemm-foundations (contract, layout, DUMMA rules, Graph safety,
  benchmarking). For M>32 use int8-w8a8-gemm-prefill.
---
# INT8 W8A8 GEMM — Decode (M <= 32) — gfx928 / SGLang TP4

Worker-29 lineage, DTK 26.04; K500SM_AI/gfx928, 120 CUs, wavefront 64,
64 KiB LDS/CU, 65,536 VGPRs/CU. Validated evidence covers M<=16; M in
(16, 32] is a boundary gap — reuse the M=16 recipes below and measure (see
§3). This skill is the decode half of the phase split; load
`int8-w8a8-gemm-foundations` for the operator/layout contract, DUMMA and
epilogue rules, Graph-safe interface, SGLang integration, and shared
guardrails. Baselines are fixed user-supplied Triton CUDA-graph numbers that
were never re-measured in this lineage — do not treat any baseline as optimal;
"speedup" is always vs that fixed table.

For the four Hy3 TP4 M=16 shapes (2026-08-23, hy3-dsh-tp4-m16-1-7f1fb1d1) the
source of truth is the authoritative control-plane fact ledger plus each
worker's `runs/<shape>/experiments.jsonl` — pending worker SKILL.md tables may
be stale and must not override the ledger. **All four shapes have accepted
candidates; no plateau was proven anywhere (`plateau=false`): every accepted
number is best-found, not a proven optimum.** A shape whose worker timed out /
produced no accepted candidate stays **unoptimized** — never infer success, a
speedup, or optimality from a failed or timed-out worker.

Operator: `x_q[M,K] int8 @ W[K,N] int8 -> int32 -> * x_scale[M,1] *
weight_scale[N,1].T -> bf16[M,N]`. Timed region = GEMM + scales + bf16
epilogue + split-K combine inside the CUDA Graph; excludes quantization,
weight packing/preprocessing, allocation, JIT, capture. Protocol: unprofiled
CUDA-graph replay, 100 warmup / 30 samples x 100 replays, hot cache; report
median AND p90; Graph vs Graph only.

## 1. M = 16 decode (validated)

Use gfx928 INT8 DUMMA:

```cpp
DUFragment<matrix_a,16,16,32,signed char,row_major>
DUFragment<matrix_b,16,16,32,signed char,row_major>
DUFragment<accumulator,16,16,32,int>
```

Best validated TP4 dispatch:

| K,N | Path |
|---|---|
| 4096,1536 | non-uniform split-K=10, 4 waves, stage-K=64, double-buffer prefetch |
| 4096,1024 | split-K=16 |
| 1024,8192 | two-wave staged kernel, K-stage=128 |
| 2048,4096 | two-wave staged kernel, K-stage=128 |
| 512,4096 | two-wave staged kernel, K-stage=128 |

The non-split kernel computes a 16x32 output tile with two wavefronts. It
loads A/B cooperatively, performs m16n16k32 DUMMA, and writes each accumulator
fragment directly from registers through a fused scale/bf16 epilogue.

Split-K requirements:

- Allocate int32 workspace before Graph capture.
- Every launch overwrites every partial tile; no workspace clear is needed.
- Measure partial GEMM plus combine together.
- Do not report only the main kernel as total operator latency.
- Do not restrict split-K to powers of two. Sweep block count near an integer
  multiple of the physical CU count, while keeping every K boundary aligned
  to the DUMMA/staging unit.

For the fully validated `M=16,K=4096,N=1536` optimization sequence, byte
accounting, ISA evidence, rejected variants, and the 570 GB/s result, read
[references/wqkv-a-m16-split10-570gbps.md](references/wqkv-a-m16-split10-570gbps.md).

### 1.1 Hy3 TP4 M=16 shapes (authoritative, 2026-08-23)

Each accepted kernel is selected by an exact (m,n,k) shape guard placed
**before** generic tiled/scalar paths so decode, M=3072/4096 prefill, and
generic arms stay untouched. `HIP_KERNEL_NAME(templated<...>)` +
`hipLaunchKernelGGL` are valid on this toolchain and used by every accepted
kernel here. Scalar bootstrap kernels (qkv 476.8 us, o_proj 511.4 us,
gate_up 331.0 us, down_proj 39.4 us) are correctness-first placeholders, not
baselines.

| shape_id | M,N,K | Accepted kernel (final) | Best median / p90 us | baseline us | speedup |
|---|---|---|---|---|---|
| hy3_tp4_qkv_proj_m16 | 16,2560,4096 | `w8a8_dumma_m16_n64_splitk_partial_kernel<6, FUSED=true>` (iter 23) | 26.046 / 26.090 | 80.19 | 3.08x |
| hy3_tp4_o_proj_m16 | 16,4096,2048 | `w8a8_gemm_m16_dumma_packedb_kernel` (iter 16) | 18.221 / 18.242 | 54.617 | 3.00x |
| hy3_tp4_shared_gate_up_proj_m16 | 16,768,4096 | `m16_dumma_runtime_splitk_lds_staged_colmajor_B` (iter 8) | 11.310 / 11.325 | 73.262 | 6.48x |
| hy3_tp4_shared_down_proj_m16 | 16,4096,384 | `w8a8_dumma_m16n16k32_sk2_kernel` (iter 15) | 10.848 / 11.088 | 23.216 | 2.14x |

Accepted architectures (reusable recipes):

- **qkv (N=2560,K=4096)**: block-N=64, 256 thr = 4 waves (one 16x16
  quadrant/wave), grid = 40 tiles x split-K=6 = **240 blocks = 2 blocks/CU**;
  stage-K=64 double-buffered A+B LDS (10,240 B/block); one 16-B cooperative
  load/lane/stage; load-bearing tid-linear B lane roles (`b_krow = tid>>2`,
  `b_nchunk = tid&3` = 16 unique 128-B lines per wave-load); one
  `__syncthreads`/stage; non-uniform 64-aligned K slicing ([0,K) exactly once,
  preserves bit-exact int32 order); **fused last-arrival combine tail** —
  monotonic global counters (`arrived % SPLIT_K == SPLIT_K-1`),
  `__threadfence` + `atomicAdd`, last arriver sums the L2-hot planes
  ascending, scales, stores one 8-B bf16; counters in the last 160 B of the
  16-plane contract workspace, one-time async memset before first launch →
  **one kernel launch per replay**. Accepted chain: 476.8 (scalar) → 140.63 →
  131.71 → 124.92 → 54.21 → 36.88 → 31.52 → 28.48 → 26.33 → **26.05** us.
- **o_proj (N=4096,K=2048)**: 256 blocks x 128 thr = 2 waves, one 16x16 N
  tile/block; in-block split-K=2, 8 uniform stages of K=128 (4 m16n16k32
  steps, 8 dwordx2 loads)/wave; **register-only K-loop transport with depth-1
  prefetch** (next stage's 8 dwordx2 loads issued before the current 4-MMAC
  burst, rotated in after; compiler wait lands at next fill); packed-B
  fragment-slot layout `packed[n_tile][k_step][lane][8]` produced once
  out-of-timed-region for (k,n)==(2048,4096); A stays logical row-major
  (32 KiB, L2-hot); LDS = two 1 KiB int32 partial planes only; one END-of-K
  barrier; 44 VGPR/24 SGPR/2048 B LDS, 0 spills.
- **gate_up (N=768,K=4096)**: 16x64 block tile, 2 waves x 2 N-tiles/wave
  sharing one A fragment, 12 N-groups; runtime split-K 1..16 default **16** →
  192 blocks (1.6/CU, all 120 CUs); whole 256-row split slice staged once
  (A 16x272, B 64x272; `kStagedRowStride=272=256+16` bank skew), batched
  16-B/thread loads → `ds_write_b128`, one barrier, then **zero-barrier
  LDS-only K loop** (unroll 2: 2 ds_read2_b32 + 2 ds_read2_b64 + 4 v_mmac);
  packed `[N,K]` n-major weight for (k,n)==(4096,768) with `col_major` B +
  one 8-B LDS read per fragment; S=16 combine specialization = 96 blocks x
  128 thr with all 16 plane loads issued into a register array before the
  ascending sum; GEMM 123 VGPR/68 SGPR/25,856 B LDS; combine in the timed
  Graph.
- **down_proj (N=4096,K=384)**: grid = N/16 = 256 blocks x 128 thr = 2 waves,
  split-K=2 along K (K-half per wave, 6 unrolled steps); A staged 16x192
  row-major, 208-B padded stride (192+16), dwordx4 loads → ds_write_b128; B
  staged n-major from packed `[N][K]` transpose `P[n*384+k]=W[k*4096+n]`,
  208-B padded column stride, one ds_read_b64 per step (was 8 ds_read_u8 +
  ~11 VALU); **fused per-block LDS combine**: wave 0 publishes int32 partial
  to `s_part`, one barrier, wave 1 adds s=0 then s=1 (exact int32 order) and
  emits scaled bf16 from registers; scales prefetched into LDS `s_scale[32]`
  at kernel top with stores **deferred until after both staging loops**
  (removes prologue vmcnt window); 43 VGPR/18 SGPR/14,464 B LDS.

Cross-shape rules that held (measured):

1. **M=16 grid parallelism is scarce — split-K is the occupancy lever.**
   Sweep non-power-of-two split counts near integer multiples of 120 CUs
   ({2,3,4,5,6,8,9,10,12,16}); winners were 6 (qkv), 2 (o_proj, down_proj),
   16 (gate_up). Keep every K boundary aligned to the staging/DUMMA unit.
2. **Direct global fragment loads are poison first**: library byte-load +
   reassembly + per-load `vmcnt` before each mmac cost 1.6-3x. Fix: one
   aligned 8/16-B vector load per lane per fragment/step, via LDS staging
   (gate_up, down_proj, qkv) or register-only transport (o_proj).
3. **Pack the cold once-read weight (B) outside the timed region/Graph**
   into the fragment's layout ([N,K] n-major transpose, per-tile/
   fragment-slot packs) so each fragment is one contiguous dwordx2/b64 read;
   leave small L2-hot A logical. Packing alone was small; it is the
   prerequisite for vectorized B loads.
4. **Zero in-loop barriers for decode**; one END-of-K barrier for the LDS
   int32 partial-plane combine is cheap and order-independent (bit-identical).
5. **Split-K combine is part of the operator wall** — never time the partial
   kernel alone. Fuse it where it wins (qkv last-arrival tail; down_proj
   per-block LDS) but **not universally**: gate_up's atomic-accumulator +
   finalize fusion regressed 43.8%.
6. **LDS bank skew**: pad row/column strides to 16-B-aligned non-power-of-two
   values (272=256+16, 208=192+16, 80/72/68/144 elsewhere); strides ≡ 0
   (mod 128 B) alias every row onto one bank phase.
7. **Exact int32 accumulation order (k-ascending per split, ascending split
   sum) is preserved across all accepted variants → outputs are bit-identical
   (0 mismatches).**
8. **Launch geometry before micro-opt** (down_proj: 256x1-wave 68.9 us →
   128x2-wave 15.4 us); verify the exact code object of the timed run
   (digest-matched), not a stale sibling; source-level prefetch is not
   overlap without ISA proof (`global_load_dwordx4 -> v_mmac -> vmcnt(0) ->
   ds_write_b128`).

### 1.2 Fallback routing (must stay byte-identical and building)

- qkv: FUSED=false partial + quadrant combine kernel for workspaces < 16
  planes; generic scalar fallback for every other (m,n,k) including paired
  M=2.
- o_proj: scalar fallback decodes the packed-B layout for (k,n)==(2048,4096);
  M=2 fallback exact.
- gate_up: scalar fallback decodes the [N,K] pack for (k,n)==(4096,768);
  identity copy otherwise; generic single-buffer tiled arms kept untuned.
- down_proj: unsplit two-wave DUMMA (grid 128) for other M=16 shapes; generic
  scalar with a `b_transposed` flag for M=2.
- Routing rule: exact-shape guard → tuned kernel; any other shape → generic
  tiled path or scalar fallback, never the tuned kernel.

## 2. 1 <= M < 16

The implemented compatibility path zero-pads A to 16 rows in LDS and masks
output rows. It is correct and Graph-safe, but performance must be measured
for each M. Do not assume the M=16 dispatch is optimal for M=1/2/4/8.

For the validated `M=2,K=4096,N=1536` split-K=8 route, ISA/PMC evidence,
bandwidth accounting, failed B-staging/prefetch/finalize variants, the other
M=2 baselines, and acceptance gates, read
[references/m2-decode-search.md](references/m2-decode-search.md). Do not route
other M=2 shapes to a custom kernel until that reference's exactness and
repeated Graph speedup gates pass; retain Triton otherwise.

## 3. Boundary: 16 < M <= 32

No accepted candidate has been measured in (16, 32]. Reuse the M=16 recipe
(split-K + fused combine family) and measure per exact M before committing a
route. Keep a decode-compatible arm and a staged prefill arm for the same
(K,N) until measured; the decode direct-B-from-global pattern does not
transfer to larger M, and prefill's no-split-K rule does not apply here.

## 4. Validated evidence

### M=2 decode, 2026-08-03

Fair preallocated-output baseline, hot cache, 50 warmups, 50 samples,
20 launches/sample; exact output check passed:

| Case | Eager ms | Graph ms |
|---|---|---:|---:|
| wqkv_a | 0.099411 | 0.066924 |
| wq_b / indexer.wq_b | 0.095939 | 0.047181 |
| wo_b | 0.096399 | 0.054453 |
| shared gate_up_proj | 0.096759 | 0.060389 |
| shared down_proj | 0.094487 | 0.018975 |

For `wqkv_a (K=4096,N=1536)`, the accepted HIP dispatch is split-K=8,
StageK=512, two waves/block sharing one padded A stage, direct row-major B
loads, direct partial stores to `[8,2,N]`, and a 64-thread vectorized combine.
Three final Graph median/P90 runs were `20.004/21.592`, `20.024/20.448`, and
`19.944/20.336 us`; changed-input Graph replay was exact bf16. This is about
3.35x faster than the 66.924 us Triton Graph baseline. The other four rows
remain baseline-only and require their own search.

### M=16 optimized HIP Graph

Formal hot-cache run: 50 warmups, 100 samples, 20 launches/sample.
Split-K results include the combine kernel:

| Case | HIP path | HIP Graph ms | Triton Graph ms | Speedup |
|---|---|---|---|---:|---:|
| wqkv_a | split-K=10 w4 stage64 prefetch | **0.017344** | 0.066597 | **3.84x** |
| wq_b | staged2 K128 | 0.030972 | 0.048049 | 1.55x |
| wo_b | staged2 K128 | 0.050917 | 0.054617 | 1.07x |
| shared gate_up_proj | split-K=16 | 0.018440 | 0.060965 | 3.31x |
| shared down_proj | staged2 K128 | 0.014568 | 0.021372 | 1.47x |

The updated `wqkv_a` row uses 100 warmups, 300 samples, and 20 Graph replays
per event sample. Its P90 is 0.017616 ms and exact bf16 replay with changed
input contents passed. The other rows retain their earlier protocol and must
not be interpreted as having been rerun in the same session.

### Hy3 TP4 M=16 (2026-08-23, hy3-dsh-tp4-m16-1-7f1fb1d1)

The authoritative table (accepted kernels, median/p90, baselines, recipes,
accepted chains) lives in §1.1. Earlier drafts of this table listed down_proj
as (16, 6144, 768) — that was stale; the ledger and worker_3 evidence confirm
`hy3_tp4_shared_down_proj_m16 = (16, 4096, 384)` (`w8a8_dumma_m16n16k32_sk2_
kernel`, 10.848 us median / 11.088 us p90, 2.14x vs the 23.216 us baseline).

## 5. Decode acceptance: µs-scale noise protocol

Decode kernels are µs-scale, so acceptance gates are dominated by measurement
noise, not kernel quality:

- Report median AND p90; never min. Compare Graph vs Graph only.
- The `final <= 1.05 x worker best` gate can trip on thermal/GPU-state drift at
  µs scale. Observed failures: `hy3_tp4_shared_gate_up_proj_m16` final 13.009 us
  vs worker best 11.310 us (15% gap) and `minimax_tp8_qkv_proj_m16` final
  73.611 us vs worker best 33.202 us (2.2x gap) despite unchanged kernels —
  both tasks stopped on the gate. The control plane now re-measures on a gate
  failure: up to 3 re-measures, 300 s apart (`_PERF_GATE_MAX_RETRIES=3`,
  `_PERF_GATE_RETRY_INTERVAL_S=300`), accepting the best (min) median; only an
  every-attempt failure is reported as a regression. A tolerance band (e.g.
  ±10% at M<=16) is also justified.
- Split-K candidates: measure partial GEMM **plus combine together**; never
  accept on partial-kernel time alone.
- Expect small speedups: the decode launch/latency floor (~5-10 us) and the
  already-decent Triton decode baselines cap headroom at roughly 3-6x.
  A flat or small gain can still be the right answer at M<=32.
- Protocol: unprofiled CUDA-graph replay, 100 warmup / 30 samples x 100
  replays, hot cache; report median AND p90 (p90 guard vs current best);
  Graph vs Graph only. Timed region = GEMM + scales + bf16 epilogue +
  split-K combine inside the Graph (see intro).
- One smallest focused change per round. Only after acceptance explain with
  hipprof PMC (`--pmc --pmc-type 3`) and require predicted counters to move,
  else the mechanism is ambiguous. `lds_wait ≈ lds_instructions` is NOT a
  bottleneck signal (true in accepted kernels too). Profiled duration is
  never the score. Derived TOPS/GB/s are logical rates (`2MNK/median`), not
  measured HBM traffic.
- After a killed/aborted round, restore the accepted source to its recorded
  digest before the next experiment.

### 5.1 Integration and correctness gates (Graph-safe)

- Build/load the extension before capture; preallocate output and workspace
  before capture; launch on `at::cuda::getCurrentCUDAStream(device)`; no
  allocation/sync/JIT/preprocessing/CPU reads inside capture; replay may
  update contents, never addresses/shapes. Route M<=16 through
  `gemm_out_optimized`, M>16 through the prefill path; unsupported
  conditions return None to keep the original SGLang path (foundations holds
  the shared Graph-safe contract).
- Correctness: exact bf16 vs reference (0 mismatches expected — int32 order
  preserved), extreme/random int8, M tails, Graph capture + changed contents
  + replay. Paired M=2 fallback validation must decode the packed layout:
  qkv 531 us, o_proj 789.4 us, gate_up 0 mismatch, down_proj 85.9 us — all
  mismatch 0.

## 6. Rejected / guardrail evidence (decode)

- Do not assume power-of-two split-K. The validated wqkv_a winner uses
  non-uniform split10; split4 and split16 both regressed for different reasons.
- Do not fuse split-K finalization merely to remove a Graph node. Atomic
  last-arriver finalization regressed, and DTK 26.04 failed to capture the
  cooperative-launch candidate into the Graph. (Exception: the hy3 qkv_proj_m16
  winner's fused monotonic-arrival combine is accepted on this lineage — it
  passed exact Graph replay.)
- Do not assume fewer tiles per block is better: for decode, insufficient
  block count can leave roughly 120 CUs underfilled.
- Historical M=2 trials rejected uint16/uint32 reinterpret vectorization,
  manual ILP/unrolling, row fusion, and collapsing grid parallelism for two
  shapes. Re-profile before revisiting.
- For M=2 wqkv_a, final ISA contains `v_mmac_i32_16x16x32_i8`, but the
  row-major B fragment loader expands each K=512 split to 128
  `global_load_ubyte` instructions. Coalesced B-to-LDS staging regressed to
  32.712 us, paired B-fragment prefetch to 20.488 us, uneven split10 to
  21.381 us, and atomic last-arriver finalize to 21.892 us. Do not replace
  the accepted route with these merely because their source looks more
  parallel or more vectorized.
- Do not describe the M=2 event-derived 316 GB/s logical tensor rate or
  326 GB/s workspace-inclusive program rate as peak HBM. PMC reported about
  98,560 external 64B read requests (about 6.31 MB) for the main kernel, but
  the real compute path also executes a fixed M16 DUMMA tile: 14 of 16 rows
  are padding. A 500+ GB/s pure-memory proxy is not a valid compute baseline.
- Hy3 TP4 per-shape rejected (measured; do not re-litigate without new
  evidence):
  - **qkv** (flat/regressed): packed-B + A-only LDS (55.7), LDS bank skew ldm
    64→68 (36.8), split-K 12 (40.0), stage-K 128 (42.1), deeper prefetch
    (32.4), block-N=128 split-K=12 (32.1), per-64-column packed B (26.5),
    split-K 9 (28.9), cold-plane L2 warm (28.4). Killed rounds 12/15/20/21
    (infra — prove nothing).
  - **o_proj**: in-block split-K=4 on the byte-load kernel (94.2), grid
    split-K + combine kernel (94.6), in-loop-barrier A-only LDS (209.3),
    depth-2 prefetch (20.16), 8-wave uniform (19.60), stage-K=128 at 6 waves
    imbalanced (19.33), epilogue plane bank-skew (19.39), 1-wave occupancy
    cliff (19.60), stage-K=256 (19.17). No compile failures in this lineage.
  - **gate_up**: finer one-wave 16x32 grid (13.62), packed A-fragment loader —
    lighter ISA regressed 44% (20.19; ISA counts are not a performance
    proxy), CU-aligned split-K=10 120 blocks (12.99), split-K=8 24 N-groups
    (13.23), nontemporal glc/slc B loads (13.11), the whole combine CU-spread
    family (13.0-20.7), atomic last-arriver + finalize 3-launch tail (20.11),
    exact 2-blocks/CU 240-block grid (15.22). Killed round 7 (agent timeout —
    proves nothing).
  - **down_proj**: register prefetch depth-2 (flat — compiler kept vmcnt
    before mmac), split-K 4/3 occupancy probes (15.0/13.6), stride-4 bank
    repack (capacity-invalid, caught by correctness and reverted), four
    per-8-k-group B planes (flat 11.72). More co-residency was monotonically
    worse at this shape (latency/issue-bound, not occupancy-starved). All 15
    rounds built and passed correctness.
- A compile error proves only that candidate failed to compile (e.g. gate_up
  iter 5's undeclared `kPackedK`, fixed in-round), never that DUMMA, INT8, a
  HIP API, templates, or inline asm are unsupported. Killed rounds (missing
  proposal, ~900 s timeout, restore failures) are infra/agent failures that
  prove nothing.
- Do not transfer any winner (split-K default, stage size, layout, occupancy)
  to another M / (K,N) / TP size / architecture without re-measuring; decode
  vs prefill (M=3072/4096) conclusions do not cross M regimes.

## 7. Next optimization questions (decode)

- M=2: keep the validated wqkv_a dispatch; execute the phased search for the
  other four `(K,N)` families and add static routes only after they clear the
  Graph acceptance gate.
- M=1/4/8: build per-M dispatch only if Graph latency improves.
- M in (16, 32]: measure the M=16 recipe per exact M before committing a route
  (see §3); the decode acceptance protocol in §5 applies.
- Hy3 TP4 M=16: all four shapes are **optimized** (accepted, correct,
  Graph-passed) with `plateau=false` — accepted numbers are best-found, not
  proven floors; continue per-shape HIP search. Baselines (80.19 / 54.617 /
  73.262 / 23.216 us) are fixed user-supplied Triton Graph numbers, never
  re-measured, **never optimal**.
