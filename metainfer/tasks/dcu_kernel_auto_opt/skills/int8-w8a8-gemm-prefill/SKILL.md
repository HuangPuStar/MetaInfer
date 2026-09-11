---
name: int8-w8a8-gemm-prefill
description: >
  INT8 W8A8 GEMM prefill kernels for M>32 on Hygon K500SM_AI/gfx928: 2D M-tile
  staged-LDS DUMMA kernels, no split-K, occupancy/LDS tuning, and the M=3072 /
  M=4096 validated evidence. Load together with int8-w8a8-gemm-foundations
  (contract, layout, DUMMA rules, Graph safety, benchmarking). For M<=32 use
  int8-w8a8-gemm-decode.
---
# INT8 W8A8 GEMM — Prefill (M > 32) — gfx928 / SGLang TP4 + TP8

Worker-29 lineage, DTK 26.04; K500SM_AI/gfx928, 120 CUs, wavefront 64,
64 KiB LDS/CU, 65,536 VGPRs/CU. Validated evidence covers M=3072 (TP4) and
M=4096 in three lineages: TP4 (`hy3_tp4_*_m4096`, §2), TP8
(`hy3_tp8_*_m4096`, §3) and GLM-5.2 TP8 (`glm5-2-dsh-tp8-m4096-1`, §4).
M in (32, 3072) [TP4] / (32, 4096) [TP8 / GLM-5.2] are
measured-boundary gaps — reuse the staged recipes below and measure. This
skill is the prefill half of the phase split; load `int8-w8a8-gemm-foundations`
for the operator/layout contract, DUMMA and epilogue rules, Graph-safe
interface, SGLang integration, and shared guardrails. For each M=4096 lineage
the source of truth is its authoritative control-plane fact ledger (TP4:
2026-08-22 re-verified values; TP8: 2026-08-27; GLM-5.2:
`glm5-2-dsh-tp8-m4096-1-e6a280a2`): pending worker SKILL.md
tables may be stale and must not override the ledger. Baselines are fixed
user-supplied Triton CUDA-graph numbers that were never re-measured — do not
treat any baseline as measured or optimal; "speedup" is always vs that fixed
table.

## 1. M = 3072 prefill (validated)

For `M=3072,K=4096,N=1536`, use the validated large-M path:

```text
block tile      = 64x64
K stage         = 64
threads         = 256 = 4 wavefronts
wave ownership  = one 32x32 quadrant per wave
DUMMA unit      = m16n16k32
LDS             = two buffers of A[64,64] + B[64,64] = 16 KB total
prefetch         = two 16-byte vectors/thread into VGPR
epilogue        = direct fragment -> scale -> bf16 store
tail M          = zero-filled A loads + masked stores
```

Launch grid:

```text
grid.x = N / 64
grid.y = ceil(M / 64)
```

Issue stage `i+1` global loads before the stage `i` MMAC sequence. Keep the
prefetched vectors in VGPR, execute the current eight MMAC instructions, wait
for VMEM immediately before writing the alternate LDS buffer, then use an
LDS-ready barrier. Do not infer this overlap from source order: require the
gfx928 ISA to show `global_load_dwordx4 -> v_mmac_i32_* -> vmcnt(0) ->
ds_write_b128` in that order.

Current optimized prefill constraints are `M>32`, `K%64==0`, `N%64==0`,
contiguous inputs/scales/output, bf16 output, and no bias.

Do not use split-K for large M unless profiling proves grid parallelism is
insufficient. MxN already supplies many blocks, and reduction overhead is
normally unnecessary.

For the full M=3072 experiment table, ISA procedure, resource evidence,
bandwidth accounting, and rejected stage sizes, read
[references/wqkv-a-m3072-prefetch-isa.md](references/wqkv-a-m3072-prefetch-isa.md).

## 2. M = 4096 chunked prefill — TP4 (hy3_tp4_*_m4096)

Validated on the worker-29 lineage, one worker/GPU per shape ID, DTK 26.04.
Operator contract is identical to the foundations skill; weight
packing/preprocessing runs outside the timed region and outside Graph
capture. **Source of truth = the authoritative control-plane fact ledger**
(2026-08-22 re-verified values); pending worker SKILL.md tables may be stale
and must not override the ledger.

| shape_id | M,N,K | Worker | Status | Accepted best (median / p90 us) | TOPS | vs baseline |
|---|---|---|---|---|---|---|
| hy3_tp4_qkv_proj_m4096 | 4096, 2560, 4096 | worker_0 | optimized (iter 18) | 756.73 / 760.16 | 113.51 | 31.78x (24045.12) |
| hy3_tp4_o_proj_m4096 | 4096, 4096, 2048 | worker_1 | optimized (iter 10) | 803.90 / 805.14 | 85.48 | 24.73x (19881.949) |
| hy3_tp4_shared_gate_up_proj_m4096 | 4096, 768, 4096 | worker_2 | optimized (iter 13) | 220.71 / 221.54 | 116.76 | 30.26x (6678.282) |
| hy3_tp4_shared_down_proj_m4096 | 4096, 4096, 384 | worker_3 | optimized (iter 14) | 214.84 / 215.12 | 59.97 | 20.39x (4381.289) |

> The **2026-08-22 re-verified values**: each accepted kernel object was
> re-benchmarked with correctness ON (mismatch=0, max_abs_error=0.0) using the
> same protocol (100 warmup / 30 samples × 100 replays, CUDA-graph replay, hot
> cache). TOPS = 2MNK/median; bandwidth = algorithmic bytes / median (not
> measured HBM traffic). Speedup = fixed user-supplied Triton baseline /
> median. Iteration-chain values in §6 are the historical in-run measurements
> of the same accepted kernels.

- All four shapes have accepted candidates: **no GPU worker is unavailable and
  no shape in this lineage is unoptimized**. Rule for any future shape: a
  shape whose worker timed out or produced no accepted candidate stays
  **unoptimized** — never infer success, a speedup, or optimality from a
  failed/timed-out worker, and never call its baseline optimal when no
  candidate was accepted.
- M=4096 prefill: **no split-K** in any accepted candidate — the M×N
  output-tile grid already dwarfs 120 CUs, and the 16 MiB workspace has no
  useful int32 partial-plane capacity.
- Routing: exact `(m,n,k)` guard per shape → tuned DUMMA kernel; every other
  shape falls back. Place the exact-shape guard before generic tiled paths and
  keep it shape-exact so decode (M≤32), M=3072, and generic arms are
  untouched. Each source carries a generic scalar int8/int32 fallback that
  decodes the packed layout when the `(k,n)` matches: o_proj `(2048,4096)`,
  qkv `(4096,2560)`, down_proj n-major, gate_up `(4096,768)`; gate_up also
  keeps generic single-buffer tiled arms (`<64,128,128>`, `<128,64,128>`,
  `<64,64,128>`) that were never re-tuned. Untuned paths must remain
  byte-identical to the accepted source and must still build/pass.
- All speedups are vs the fixed user-supplied Triton CUDA-graph baseline table
  above; those baselines were never re-measured and must not be called
  optimal.
- Decode (M≤32), M=3072, and any other shape are outside this lineage and
  must keep their own validated routes/fallbacks.

## 3. M = 4096 chunked prefill — TP8 (hy3_tp8_*_m4096)

Validated on the worker-29 lineage (hy3-dsh-tp8-m4096-1), one worker/GPU per
shape ID, DTK 26.04. **Source of truth = the authoritative control-plane fact
ledger (2026-08-27)**; pending worker SKILL.md tables may be stale and must
not override the ledger (e.g. down_proj's draft names round 8 as final while
the ledger also accepted rounds 10/12/13; gate_up's draft calls round 11 "not
accepted" though the ledger accepts it). All four TP8 M=4096 prefill shapes
have accepted candidates (4/4); no GPU worker is unavailable. ~30 rounds in
this lineage ended as `compile_or_agent_failure` (killed ~900 s, missing
proposal, restore/resume failures): these are candidate/infra failures and
prove nothing — never infer success, a speedup, or optimality from a
timed-out/failed worker, and a compile error is never evidence that DUMMA,
INT8, a HIP API, templates, or inline asm are unsupported. Recipes do NOT
transfer across TP size: the TP4 numbers in §2 are a different lineage with
different shapes.

### 3.1 Routing and accepted evidence (authoritative ledger)

| shape_id | M,N,K | accepted best (iter) | median / p90 us | logical TOPS | speedup vs baseline |
|---|---|---|---|---|---|
| hy3_tp8_qkv_proj_m4096 | 4096,1280,4096 | 6 | 418.22 / 431.55 | 102.7 | 46.34x (19381.383) |
| hy3_tp8_o_proj_m4096 | 4096,4096,1024 | 12 | 322.99 / 325.38 | 106.4 | 43.82x (14151.792) |
| hy3_tp8_shared_gate_up_proj_m4096 | 4096,384,4096 | 18 | 115.95 / 116.23 | 111.1 | 144.13x (16712.231) |
| hy3_tp8_shared_down_proj_m4096 | 4096,4096,192 | 10 | 170.80 / 171.03 | 37.7 | 63.01x (10762.616) |

All four: correctness passed (mismatch 0 / max_abs_error 0.0), Graph capture
+ changed-contents replay passed. No proven optimum on any shape (no plateau
established): accepted numbers are the best found, not ceilings. No split-K
in any accepted candidate — the MxN tile grid dwarfs 120 CUs; the only
measured split (gate_up S=2) cost ~40-70 us of combine.

### 3.2 TP8 pack layouts and fallback guards (lineage-specific)

Foundations records the TP4 layouts; the TP8 layouts below are distinct and
shape-specific. Checkpoint weight is [N,K] (stride K); SGLang Triton view is
W.t() — preserve it for fallback and register one one-time contiguous HIP
buffer; never replace `layer.weight.data` with the contiguous copy. Packing
is one-time, out-of-timed-region, out-of-Graph, same byte count, same
graph-stable buffer; correctness is always checked against the raw logical
[K,N] weight:

- qkv (k=4096,n=1280): n-major `packed[n][k]`
- o_proj (k=1024,n=4096): n-major `packed[n*K+kk] == raw[kk*N+n]`
- gate_up (k=4096,n=384): [N,K] transpose (exact (K,N)==(4096,384) only)
- down_proj (k=192,n=4096): n-major `packed[n][k]`

Validate every pack kernel with a byte-exact simulation of the index
relation. o_proj iter 10's mis-vectorized transpose silently left most of
the buffer unwritten (mismatch 16,775,923 / max_abs_error 86.5): a fast but
wrong measurement is not a win; the iter-11 repair (per-thread 16-byte
gather from 16 raw rows + aligned int4 store) restored mismatch 0.

Fallback routing (must stay byte-identical and building): exact-shape guard
first -> tuned DUMMA kernel; every other shape -> generic tiled arms / scalar
fallback (`w8a8_gemm_scalar_fallback_kernel`), which decodes the packed
layout when the (k,n) matches and is otherwise identity. Guards (unchanged
across the lineage): qkv `(m >= 128 && n == 1280 && k == 4096)`; o_proj
`(m,n,k) == (4096,4096,1024)`; gate_up `(m == 4096 && k == 4096 && n == 384)`;
down_proj `(m >= 128 && k == 192 && n % 128 == 0)`. M tails and paired shapes
must still pass. Occupancy: verify from the exact code object (vgpr_count,
sgpr, LDS bytes, scratch/spills); `__launch_bounds__` minBlocks is a hint
only. Math: blockDim multiple of 64; blocks x LDS <= 64 KiB; VGPR x threads x
blocks <= 65,536.

### 3.3 Accepted architectures (per shape)

- **qkv — `w8a8_dumma_prefill_packedb_tiled_kernel<64,128>` (iter 6)**:
  64x128 tile, 256 thr = 4 waves, 32x64 quadrant/wave = 8 m16n16k32 int32
  acc; grid (N/128)x(M/64) = 10x64 = 640 blocks; single-buffered 64-K LDS
  stage (A[64,64] stride 68 B odd-word, B[128,64] n-major stride 80 B,
  14,592 B/block), 2 __syncthreads/stage, peeled final stage (127
  barriers/block); hoisted 12 fragment loads (4 ds_read2_b32 A + 4
  ds_read2_b64 B via load_b_frag8) then 16-MMAC burst; register-scale
  coalesced epilogue (4x4 shuffle transpose, 2+4 scale loads prefetched, one
  8-byte store/lane/fragment); 2 blocks/CU, VGPR-bound (arch 96 / code-object
  89 / sgpr 26 / no spills). Chain: 448.86 (iter 1) -> 418.22 (iter 6).
- **o_proj — `w8a8_dumma_128x64x64_kernel` (iter 12)**: 128x64 tile, 256 thr
  = 4 waves, 64x32 quadrant/wave = 8 acc; grid dim3(64,32) = 2048 blocks;
  single-buffered 64-K stage A[128,80]+B[64,80] = 15,360 B, 2
  __syncthreads/stage (32/block); 3 int4 global loads/thread/stage ->
  ds_write_b128 -> barrier -> 6 ds_read2_b64 -> 16 v_mmac; n-major [N,K] pack
  (repaired iter-11 gather) + load_fragment8 on BOTH operands (one 8-byte LDS
  read per fragment, zero reassembly VALU); coalesced 8-byte epilogue (iter 6:
  4x4 __shfl_xor transpose, ds_bpermute lowering accepted at the block tail);
  3 blocks/CU per the ledger (worker code-object re-verification: 61 VGPR/22
  SGPR/0 scratch — confirm residency from the exact object). Chain: 419.05
  (iter 6) -> 348.27 (iter 11) -> 322.99 (iter 12).
- **gate_up — `w8a8_gemm_prefill_tiled_kernel_w8<64,128,64>` (iter 18)**:
  64x128 tile, 512 thr = 8 waves, 32x32 quadrant/wave = 4 acc, 512
  v_mmac/wavefront; grid 3x64 = 192 blocks; K stage 64 double-buffered, one
  __syncthreads/stage (65/block); B packed transposed [N,K] (exact
  (K,N)==(4096,384) only), col_major fragments via load_fragment8 (one
  contiguous 8-byte LDS read); LDS 30,720 B/block, 2 blocks/CU, code object
  53 VGPR/26 SGPR/0 scratch. Chain: 169.46 (iter 2) -> 118.47 (iter 9: w4,
  256 thr/4 waves/32x64 quadrant/8 acc — biggest single win) -> 117.50
  (iter 13, load-all-then-MMAC-all burst) -> 115.95 (iter 18, w8); iters
  11/14/15 also accepted (117.6-117.7).
- **down_proj — `w8a8_dumma_prefill_kernel<64,128,64>` (iter 10)**: 64x128
  tile, 512 thr = 8 waves, 32x32 quadrant/wave = 4 acc; grid (N/128, M/64) =
  2048 blocks; K=192 in 3 x kStageK=64 double-buffered stages, one
  barrier/stage + prologue (4 dynamic; iter-12 variant drops the dead last
  barrier -> 3); A stride 88 B (kLdsPad 24), B n-major packed stride 72 B
  (kLdsPadB 8), ds_write2_b64 staging; 29,696 B/block, 2 blocks/CU = 16
  resident waves, 55-57 VGPR; load_frag8 (ds_read_b64, merged to 4
  ds_read2_b64/wave-stage) replacing du_load_matrix_sync; fused
  direct-fragment epilogue with iter-10 register-batched weight_scale loads
  (16 -> 8 scale loads/thread); left-associative ((float)acc * xs) * ws fp32,
  __float2bfloat16. Chain: 237.78 (iter 1) -> 234.23 (iter 4) -> 230.91
  (iter 6) -> 171.19 (iter 8, load_frag8, -25.9%) -> 170.80 (iter 10);
  iters 12/13 also accepted (170.93/170.94).

### 3.4 Rejected ideas (measured, correct where noted; do not re-litigate)

- qkv: 64x64 flip 509.14; 128x64 466.05; k8 swizzle 451.86 (neutral —
  conflicts not binding); explicit load_a_frag8 561.88 (CONFOUNDED: VGPR
  96->78 silently moved 2->3 blocks/CU) and 896.63 (pinned — the library
  loader's "dead" identity VALU is load-bearing latency fill; do NOT remove
  A-side VALU here); 512-thread blocks 481.55; one-stage-ahead staging
  prefetch 1097.63 (DTK scattered 34 vmcnt waits); double-buffer/1-barrier
  457.14; A stride 68->80 768.34 (odd 17-word stride load-bearing); B
  st-pair merge 659.43; tail-guard consolidation 448.17.
- o_proj: iter-10 pack bug 327.36 (CORRECTNESS FAILED — never count a fast
  wrong result); 128x128 854.05; 512 thr 491.51; B stride 80->72 719.73 /
  A-stride 80->72 437.15 (conflict floor not on the critical path); epilogue
  scale hoisting 741.15; double-buffer prefetch 891.29 (confounded: real vgpr
  85 + 30,720 B = 2 blocks/CU, 50% occupancy loss); prefetch +
  __launch_bounds__(256,4) 659.5 (15 spills + 48-B scratch —
  register-blocked in pure HIP); last-barrier drop 491.30 (flat/unstable
  window).
- gate_up: BM=32 grid 768 586.23 (doubled B staging); 128x64 flip 181.44;
  64x64 3 blocks/CU 223.90; stage-top publish 181.21 and 121.40 at w4
  (+2.5%); split-K S=2 240.19; deeper-MMAC-pipe prediction REFUTED (halving
  per-wavefront MMAC count gave only +2.17% — ~2-deep per-SIMD pipe).
- down_proj: 2-stage prefetch + 1 block/CU 617.07 (co-residency load-bearing);
  staging thread remap 182.74 (-6.3%: 4x L2 requests); ws sharing 16->8
  172.17 (p90 guard fail); scales staged in LDS 179.52 (-4.9%); split-3
  infeasible by arithmetic (LDS 89,088 B > 64 KiB, VGPR 86,016 > 65,536).
- Killed rounds (qkv 2,10,13,15,16,20; o_proj 2,9,13,15,22; gate_up 1,5,12,
  16,17; down_proj 2,5,7,11,15,17) prove nothing about the toolchain.

### 3.5 Cross-shape rules that held (measured)

1. Pack B once into the exact (k,n) layout (n-major / [N,K]) outside
   timing+Graph; together with 8-byte fragment loads this is the dominant
   lever on every shape.
2. `load_fragment8` (one ds_read2_b64 per fragment, identical x[0..7] bytes =
   identical v_mmac operand) is the winning fragment-load form — EXCEPT qkv's
   A operand, where the library row-major loader's identity VALU is
   load-bearing latency fill (removal regressed even with residency pinned;
   qkv's B-side load_b_frag8 is fine).
3. LDS bank skew: 16-byte-aligned non-power-of-two row strides (68/72/80/88);
   strides ≡ 0 (mod 128 B) alias every row onto one bank phase. When
   stride % 16 == 8, stage with two int64 halves (ds_write2_b64), not
   ds_write_b128.
4. Residency is per-shape and load-bearing: qkv 2 blocks/CU (VGPR-bound),
   o_proj 3-4, gate_up 2, down_proj 2 = 16 waves/CU. Verify the exact code
   object before trusting any delta; occupancy confounds invalidate verdicts.
5. These kernels are LDS-latency/issue-bound, not HBM- or MMAC-bound (MMAC
   pipe ~2-3%): bank-conflict elimination, barrier removal, deeper register
   prefetch, and occupancy changes stop paying once strides and pack layout
   are fixed.
6. Epilogue: coalesced 8-byte stores (4x fewer vmem_write) and scale-load
   hoisting/register batching are the winning post-MMAC moves; staging scales
   in LDS lost (down_proj -4.9%).
7. Bit-identical discipline: preserve k0-outer/kk-inner int32 order and the
   element-to-slot fragment mapping; variants then pass mismatch 0 /
   max_abs_error 0.0 with no tolerance debate.
8. Recipes do not transfer across M regimes or per-shape constants: tile
   aspect (down_proj 64x128 wins at K=192 vs 128x64 at TP4 K=384), stage
   size (64 saturates), and occupancy must be re-measured per exact shape.

Acceptance for this lineage follows the shared protocol in §7 plus the
TP8-specific notes there.

## 4. M = 4096 chunked prefill — GLM-5.2 TP8 (glm5-2-dsh-tp8-m4096-1)

Synthesis of the `glm5-2-dsh-tp8-m4096-1-e6a280a2` lineage: 4 workers, 6
exact-shape IDs, all INT8 W8A8 GEMM prefill (M=4096) on Hygon K500SM_AI /
gfx928 (120 CUs, wavefront 64, 64 KiB LDS/CU, 65,536 VGPR/CU, DTK 26.04).
**Source of truth = the authoritative control-plane fact ledger**; pending
worker SKILL.md tables may be stale and must not override it. All 6/6 exact
M=4096 shapes are optimized (accepted, correct, Graph-passed); no GPU worker
is unavailable (`{}`). Baselines are fixed user-supplied Triton CUDA-graph
numbers that were never re-measured — never call them optimal, and no accepted
candidate is a proven optimum (`plateau=false` everywhere: accepted numbers
are best-found, not ceilings). ~30 rounds across the lineage ended
`compile_or_agent_failure` (agent killed ~900 s, missing proposal, restore
failures): these prove nothing — a compile error is evidence only that that
candidate failed to compile, never that DUMMA, INT8, a HIP API, templates, or
inline asm are unsupported. `hipLaunchKernelGGL(HIP_KERNEL_NAME(templated<...>))`
is valid and used by every accepted kernel.

### 4.1 Routing and fallback guards

Exact-shape guard first -> tuned DUMMA kernel; every other `(m,n,k)` falls
through to generic tiled arms / scalar fallback. Guards (unchanged across the
lineage): fused_qkv_a `m >= 128 && n == 2624 && k == 6144`; kv_b
`k == 512 && n == 3584 && m >= 64 && m % 64 == 0`; q_b exact `(k,n) ==
(2048,2048)`; o_proj exact `(m,n,k) == (4096,6144,2048)`; shared_down exact
`(m,n,k) == (4096,6144,256)`; shared_gate_up exact `(m,n,k) ==
(4096,512,6144)`. Untuned arms (generic single-buffered `<64,128,128>` /
`<128,64,128>` / `<64,64,128>` tiled instantiations, pack kernels, scalar
fallback) must stay byte-identical and still build/pass; M tails and paired
API shapes keep working. New mechanisms are added as defaulted template
parameters behind `if constexpr` so retention instantiations are
token-identical. Operator contract: no bias, no workspace (`(void)workspace` —
no combine pass exists), **no split-K** (MxN tile grid dwarfs 120 CUs on every
shape; the only measured split in the TP8 family cost ~40-70 us of combine);
scale order left-associative `(float(dot) * x_scale[row]) * weight_scale[col]`,
then `__float2bfloat16` (plain RNE without exec-masked inf/NaN fixup is
accepted where bit-identical for finite inputs).

### 4.2 Pack layouts (shape-specific, validated byte-exact)

Checkpoint weight is `[N,K]` (stride K); the SGLang Triton view is `W.t()` —
preserve it for fallback, register one one-time contiguous HIP buffer, never
replace `layer.weight.data`. Every pack is one-time, out-of-timed, out-of-Graph,
same byte count, same graph-stable buffer, and must be validated by a
byte-exact simulation of the index relation before timing (a fast kernel
reading an incompletely written pack is a correctness failure, never a win;
the sibling lineage's mis-vectorized transpose left 16.7M elements unwritten).
The scalar fallback must decode the pack for the exact (k,n).

| shape (K, N) | pack layout |
|---|---|
| fused_qkv_a (6144, 2624) | B-panel `packed[(n>>6)*(k*64) + (kk>>4)*1024 + (n&63)*16 + (kk&15)]` — 41 panels of [K,64], 16-B aligned contiguous k-runs/column |
| kv_b (512, 3584) | tile-contiguous stage-major `packed[(((k0*(n/128)+nt)*8+kc)*128+row)*8+b]` — each (stage, n-tile) B tile one contiguous 8192-B region |
| q_b (2048, 2048) | swizzled 64-k-stage-major plane `[kc][n][8]` — lane-linear 8-byte fragment reads, zero LDS bank conflicts |
| o_proj (2048, 6144) | n-major `packed[n*K+kk] == raw[kk*N+n]` |
| shared_down (256, 6144) | panel `[N/128][K/64][128][64]` (n-major 64-k-byte rows/panel) for fully coalesced 128-B staging lines |
| shared_gate_up (6144, 512) | `[K,N] -> [N,K]` n-major transpose |

### 4.3 Accepted evidence (authoritative ledger; median / p90 us, CUDA-graph replay)

| shape_id | M, N, K | accepted best (iter) | kernel | median / p90 us | logical TOPS | speedup vs fixed baseline |
|---|---|---|---|---|---|---|
| glm_tp8_fused_qkv_a_proj_m4096 | 4096, 2624, 6144 | 5 | `w8a8_dumma_prefill_packedb_db_kernel<128,64,64>` | 937.58 / 939.48 | 140.86 | 73.23x (68661.417) |
| glm_tp8_kv_b_proj_m4096 | 4096, 3584, 512 | 17 | `w8a8_dumma_prefill_tile_kernel<64,128,32,32,true,24>` | 137.40 / 137.85 | 109.40 | 50.51x (6939.939) |
| glm_tp8_q_b_proj_m4096 | 4096, 2048, 2048 | 7 | `w8a8_dumma_prefill_128x128_kernel` | 220.14 / 220.50 | 156.08 | 65.35x (14385.571) |
| glm_tp8_o_proj_m4096 | 4096, 6144, 2048 | 9 | `w8a8_dumma_256x64x64_packedb_kernel` | 759.92 / 760.81 | 135.64 | 72.08x (54775.797) |
| glm_tp8_shared_down_proj_m4096 | 4096, 6144, 256 | 5 (9 also accepted) | `w8a8_dumma_prefill_tiled_kernel<64,128,64,...>` | 278.44 / 279.19 | 46.28 | 63.57x (17700.262) |
| glm_tp8_shared_gate_up_proj_m4096 | 4096, 512, 6144 | 16 | `w8a8_dumma_prefill_tiled_kernel<64,64,64,true,true,true,true,true>` | 273.83 / 275.35 | 94.11 | 77.62x (21254.589) |

All six: correctness passed (mismatch 0 / max_abs_error 0.0), Graph capture +
changed-contents replay passed. No split-K anywhere; exactly one kernel per
GEMM; workspace untouched.

### 4.4 Accepted architectures (condensed recipes)

- **fused_qkv_a (iter 5)**: 128x64 tile, 256 thr = 4 waves, 64x32 quadrant/
  wave = 8 int32 acc; grid 41x32 = 1312 blocks (M=4096=32x128, N=2624=41x64
  exact fit — no tail); 96 ascending 64-K stages, double-buffered LDS
  `a_tile[2][128*72] + b_tile[2][64*72]` = 27,648 B/block -> **2 blocks/CU =
  8 waves/CU**; 93 VGPR / 31 SGPR / 0 spills; stage-(s+1) loads prefetched
  into 3 int4 staging VGPR at stage top, flush after MMAC burst, ONE
  barrier/stage; B-panel pack. Chain: 5697.3 (iter 1) -> 2276.9 (iter 2,
  n-major pack) -> 1070.2 (iter 3, double buffer) -> **937.6** (iter 5,
  B-panel pack).
- **kv_b (iter 17)**: 64x128 tile, 512 thr = 8 waves, 32x32 quadrant/wave =
  4 int32 acc; grid 28x64 = 1792 blocks; K=512 = 8 x 64-K stages,
  single-buffered (two barriers/stage); A stride 88 (kALdsPad=24, zero-
  conflict reads) + B tile-contiguous stage-major, ds_write2_b64 staging;
  LDS 13,824 B/block -> **2 blocks/CU = 16 waves/CU**, 61 VGPR;
  `kPrefetchNext` issues stage-s+1 grouped A+B loads AFTER the s MMAC burst,
  before the trailing barrier (8-VGPR payload live only across barrier +
  back-edge — never carry staging payloads across the burst). Chain:
  209.41 -> 169.26 (128x64, 3 blocks/CU) -> 149.54 (64x128 flip, 16 waves/CU)
  -> 146.54 (tile-contiguous pack) -> 142.70 (plain RNE bf16) -> 139.57
  (grouped A+B staging) -> **137.40** (consolidation of prefetch + A skew).
- **q_b (iter 7)**: 128x128 tile, 256 thr = 4 waves, 64x64 quadrant/wave =
  16 int32 acc; grid 16x32 = 512 blocks; single-buffered 64-K stage
  A[128,80] + B plane `[kc][n][8]` = 18,432 B/block -> **1 block/CU = 4
  waves/CU** (best occupancy on this shape; more resident waves regressed);
  141 VGPR; `load_frag8` on BOTH operands (iter 7, -11%); register-batched
  coalesced epilogue (iter 6, -9.1%). Chain: 310.22 (n-major pack) -> 275.79
  (128x128) -> 272.06 (swizzled plane) -> 247.28 (epilogue) -> **220.14**
  (A load_frag8).
- **o_proj (iter 9)**: 256x64 tile, 256 thr = 4 waves, 128x32 quadrant/wave =
  16 int32 acc; grid 96x16 = 1536 blocks; single-buffered 64-K stage
  A[256,88] + B[64,72] = 27,136 B/block -> **2 blocks/CU = 8 waves/CU**;
  151 VGPR / 34 SGPR; 5 `global_load_dwordx4` -> 5 `ds_write2_b64` (strides
  8 mod 16) -> 10 `ds_read2_b64` -> 32 v_mmac per wave/stage; n-major pack +
  `load_frag8` B; register-batched scales epilogue (iter 6, +9.0%). Chain:
  1149.26 (128x64 DB) -> 848.53 (256x64, +35.4% biggest win) -> 839.96 (pack
  + load_frag8) -> 770.49 (epilogue batching) -> **759.92** (A stride 88
  conflict-free, +1.4%).
- **shared_down (iter 5; iter 9 also accepted)**: 64x128 tile, 512 thr = 8
  waves, 32x32 quadrant/wave = 4 int32 acc; grid 48x64 = 3072 blocks; K=256 =
  4 x 64-K stages single-buffered (2 barriers/stage) — single buffer beat
  double buffer on this K=256 shape (~1.7%); LDS A[64,88] + B[128,72] =
  14,848 B/block -> 2 blocks/CU; panel pack (fully coalesced 128-B staging
  lines) + load_frag8 + kSkew8 strides. Iter 9 adds kFragReuse +
  `__launch_bounds__(512,3)` (3 blocks/CU = 24 waves/CU at 42 VGPR) —
  essentially tied (278.52/279.11), accepted per ledger. Chain: 286.53 ->
  281.65 -> **278.44**.
- **shared_gate_up (iter 16)**: 64x64 tile, 256 thr = 4 waves, 32x32
  quadrant/wave = 4 int32 acc; grid 8x64 = 512 blocks; K=6144 = 96 x 64-K
  stages double-buffered, ONE barrier/stage (97/block); LDS A[64,88] +
  B[64,72] x2 = 20,480 B/block -> **3 blocks/CU = 12 waves/CU**, 54 VGPR;
  `kPayload` lead-2 loop-carried payload: stage s+2 global loads issued at
  the top of iteration s (no wait), payload published into the idle LDS
  buffer before the stage-s MMAC burst, vmcnt wait lands AFTER the 8 x v_mmac
  burst immediately before the barrier (removes the exposed prefetch wait);
  `load_frag8` (iter 10, -9.1%, body 175->118 instr) + kSkew8 strides
  (iter 11, conflicts 9.44M->3.15M). Chain: 432.52 -> 368.76 -> 331.64
  (double buffer) -> 301.57 (load_frag8) -> 293.30 (skew) -> **273.83**
  (payload).

### 4.5 Rejected ideas (measured; do not re-litigate without new evidence)

- **fused_qkv_a**: `<128,128,64>` square tile, 1 block/CU 3491.7 (occupancy
  halving dominates); branch-free bf16 RNE epilogue 2554.8 (epilogue NOT the
  bottleneck — "ISA-neutral by construction" must be measured); prefetch
  distance 2 via two staging sets 4992.1 (register blowup); BM=64, 3 blocks/CU
  1148.0; StageK 128 / 512 thr / 1 block/CU 1055.5; rasterization flip
  `dim3(32,41)` 3354.3; bottom-of-stage prefetch issue 3233.0; load-all-then-
  MMAC-all 938.8 (neutral, p90 guard fail).
- **kv_b**: double-buffered one-barrier stage 197.24 (28,672 B -> 2 blocks/CU
  occupancy loss dominates VMEM-stall removal); double-buffer pipelines with
  the 8-VGPR payload carried across the burst (72/72/68 VGPR -> 1 block/CU)
  153-156; 64x64 tile + minBlocks=5 probe (vgpr 48 honored, 20 waves/CU)
  491.10; ISA-guided dead last-stage barrier removal 137.87 (p90 guard fail).
- **q_b**: 512-thread w8 variant 256.09 (+50% per-stage LDS read bytes);
  `#pragma unroll 1` -> 2 blocks/CU 266.57 (occupancy REFUTED on this shape —
  1 block/CU = 4 waves/CU stays best); loop-carried payload + stage-top
  publish 221.57 (+0.65%, p90 fail — VMEM exposure refuted at 1 wave/SIMD);
  A stride 88 skew 223.73 (conflict floor not on the critical path here);
  128-K stage depth 357.77 (stage 64 saturates).
- **o_proj**: 64x128 tile 1256.05 (per-byte B ds_read_u8 class); direct-A from
  global 1715.91 (cooperative A+B staging load-bearing); one-stage-ahead
  prefetch 786.08 (-2.0%, falsified — VMEM latency already hidden by
  co-residency); load-all-then-MMAC-all 760.88 (flat, DTK already hoists);
  wave-private staging + barrier removal 973.16 (-21.9%, 2x staging traffic);
  disjoint 64x64 quadrants 796.73 (-4.6% despite -20% LDS fragment-read
  traffic — LDS-read-pipe hypothesis falsified).
- **shared_down**: 64x64 tile 297.15 (+33% A staging traffic); kRNEEpilogue
  branch-free RNE 320.88 (+15.2% — epilogue VALU not binding); kSPayload
  register payload 281.19 (p90 fail — load-wait relocation alone does not pay
  at K=256); kStageK=128 279.61; kBatchEpilogue scale hoisting 284.61;
  kLoadPair back-to-back staging loads 281.24.
- **shared_gate_up**: 32x64 tile / 2-wave blocks 749.87 (confounded, wave
  count per CU load-bearing); q64 128-thr 32x64 quadrant 629.02 (+90%);
  fragment-prefetch pipeline (persistent fragments across the K loop) 337.97;
  64x128 w8 / 512 thr 395.39 (-16.1%, loses grid blocks and tail); kStageK=32
  / 6 blocks/CU 447.37 (-34.4% — more occupancy with phase-locked co-resident
  blocks does not pay).
- Killed rounds (fused_qkv_a 9,10,12,15,17,18; kv_b 11,14,15,18,19,21; q_b
  1,2,12-15,17; o_proj 7,11,13,14; shared_down 1,7; shared_gate_up 5,9,13,14,
  15,17) are infra/agent failures — no evidence about hardware, APIs, or
  candidate ideas.

### 4.6 Cross-shape rules that held (measured)

1. **Per-shape B packing once, outside timing+Graph, into the shape-exact
   layout** is the dominant lever on every shape; together with 8-byte
   fragment loads it removes the per-byte LDS read + reassembly VALU class.
   Validate packs byte-exact; the scalar fallback must decode the pack for
   the exact (k,n).
2. **`load_frag8` wins** (identical operand bytes -> bit-identical int32)
   except where the library A-side identity VALU is load-bearing latency fill
   (verify per shape).
3. **LDS bank skew**: 16-byte-aligned non-power-of-two row strides
   (68/72/80/88/136); `stride % 16 == 8` -> `ds_write2_b64` halves. Fix
   conflicts only when they sit on the critical path (payoff is per-shape:
   +0.6% kv_b, -1.6% q_b, +1.4% o_proj).
4. **64-K stage depth saturates** (128-K lost on q_b 357.77 and fused_qkv_a
   1055.5; 32-K lost on gate_up 447.37). Double buffering wins only when
   residency is preserved (fused_qkv_a, gate_up); it lost whenever it cost
   blocks/CU (kv_b, down_proj).
5. **Residency is per-shape and load-bearing**: fused_qkv_a/o_proj 2
   blocks/CU = 8 waves/CU; kv_b/down_proj 2 blocks/CU = 16 waves/CU; gate_up
   3 blocks/CU = 12 waves/CU; q_b 1 block/CU = 4 waves/CU. Verify from the
   exact code object; occupancy confounds invalidate verdicts.
6. These kernels are **LDS-latency/issue-bound, not HBM- or MMAC-bound**
   (MMAC pipe ~2-3%). Once pack layout + strides + pipeline are fixed,
   barrier removal, occupancy probes, epilogue-scale hoisting and load-pair
   micro-scheduling stop paying.
7. **No split-K** for M=4096; launcher is a pure dispatch on the caller
   stream; packing/scales stay out of timing and Graph.
8. Recipes/constants do NOT transfer across shapes or M regimes: tile aspect
   (down_proj 64x128 at K=256 vs q_b 128x128 at K=2048 vs o_proj 256x64 at
   N=6144), occupancy, stage depth and pipeline form must be re-measured per
   exact (M,N,K).

### 4.7 Boundary gaps

- 32 < M < 4096: **no accepted candidate measured** in this lineage. Reuse
  the staged recipes above and measure per exact M before committing a route;
  keep both a staged prefill arm and a decode-compatible arm until measured.
- M <= 32 (decode): **UNOPTIMIZED in this lineage** — do not claim any decode
  speedup from this lineage, never infer success from the prefill evidence,
  and route M <= 32 work to `int8-w8a8-gemm-decode` +
  `int8-w8a8-gemm-foundations` (split-K partial kernels + fused combine,
  µs-scale noise-tolerant acceptance). Decode conclusions do not cross M
  regimes (the M=16 direct-global-operand win regressed 7.9x on M=4096
  gate_up in the sibling lineage).
- No plateau proven on any of the six shapes; continue per-shape HIP search
  with the §7 protocol (one bounded mechanism per round, falsifiable
  prediction, p90 guard vs current best, exact code-object verification).
  Next candidates: fused_qkv_a's p90-failed 938.84 us load-all-then-MMAC-all
  variant and kv_b's shadow mechanisms (stride skew / prefetch, ~138.2-138.8
  us) are within ~1% of the accepted best. Revalidate on the full model /
  8-card deployment before claiming production gains; never present the fixed
  Triton baselines as measured or optimal.

## 5. Boundary: 32 < M < 3072 (TP4) / 32 < M < 4096 (TP8 / GLM-5.2)

No accepted candidate has been measured in (32, 3072) for TP4 or (32, 4096)
for TP8 or the GLM-5.2 lineage. Reuse the staged recipes above (2D M-tile,
64-K double-buffered stage, no split-K) and measure per exact M before
committing a route. Keep the M×N output-tile grid well above 120 CUs; if it
is not, split-K may become necessary (measure it — do not assume either way).
TP8's optimized evidence is exactly M=4096 (hy3 4/4 shapes, §3; GLM-5.2 6/6
shapes, §4); do not extend those accepted numbers to other M values.

## 6. Validated evidence (TP4)

### M=3072 prefill microbenchmark

Exact bf16 comparison passed for all five TP4 shapes, using the real
transposed Triton weight view and a preprocessed contiguous HIP weight:

| Case | Triton ms | HIP ms | Speedup |
|---|---|---:|---:|---:|
| wqkv_a | 9.487898 | 0.857572 | 11.06x |
| wq_b | 15.437104 | 1.149457 | 13.43x |
| wo_b | 14.680174 | 1.102976 | 13.31x |
| shared gate_up_proj | 5.985047 | 0.623089 | 9.61x |
| shared down_proj | 4.198581 | 0.303484 | 13.83x |

The very large gain is layout-sensitive. It must not be claimed for a Triton
baseline already using an equally optimized packed layout.

The later wqkv_a ISA retune supersedes the `0.857572 ms` HIP row above for the
exact shape `(3072,1536,4096)`: the selected stage64 double-buffer prefetch
kernel measured `0.598983 ms` median and `0.605783 ms` P90 in an alternating
thermal-state trial, or `64.534 INT8 TOPS`, with exact bf16 output. A sustained
100-warmup/300-sample run measured `0.615996 ms` median and `0.621276 ms` P90,
showing device frequency/thermal drift that must be reported rather than
hidden by the best short run.

### M=4096 chunked prefill (hy3_tp4_*_m4096)

Accepted candidates per shape; baselines are the fixed user-supplied Triton
table in §2. Numbers below are the **2026-08-22 re-verified values**; the
iteration chains are the historical in-run measurements of the same accepted
kernels.

**hy3_tp4_qkv_proj_m4096 (worker_0)** — final accepted iter 18 (kernel
`w8a8_dumma_prefill_64x128_packedb_kernel`): 64x128 tile, 256 threads = 4
waves, 32x64 quadrant/wave = 8 m16n16k32 int32 accumulators; grid
(N/128)x(M/64) = 20x64 = 1280 blocks; single-buffered 64-K stage with 2
`__syncthreads`/stage; A staged row-major stride 68 B, B staged n-major stride
80 B; LDS 14,592 B/block, **3 blocks/CU** (arch_vgpr 80); one-time n-major
pack `packed[n][k]` for (k,n)==(4096,2560) outside the timed region; coalesced
4-bf16-per-lane epilogue stores. Accepted chain (us): 1296.50 (iter 1) →
1108.58 (iter 2, double-buffered 64-K) → 880.99 (iter 3, single-buffer
control) → 770.14 (iter 5, n-major packed B + 3 blocks/CU) → 721.87 (iter 6,
coalesced epilogue stores) → **756.73** (iter 18, explicit A-fragment loader
replacing the library `du_load_matrix_sync` row_major byte-reassembly VALU).
Plateau NOT proven (iter 19's reason: require 8 valid HIP rounds within ±2% of
best — continue HIP-only work).

**hy3_tp4_o_proj_m4096 (worker_1)** — final accepted iter 10 (kernel
`w8a8_dumma_128x64x64_packed_kernel`): weight packed once into `[N/64, K, 64]`
int8 panels (each 64-K stage = one coalesced 4 KiB stream); 128x64 tile, 256
threads = 4 waves, 64x32 quadrant/wave = eight m16n16k32 int32 accumulators;
grid dim3(64,32) = 2048 blocks; 64-K double-buffered LDS, A and B both
80-byte row strides (16-byte-aligned, five bank phases), 30,720 B/block, 2
blocks/CU; loop-carried int4 register payload published into the idle buffer
at the **top** of the stage (before the MMAC burst) with global prefetch one
full extra stage ahead; one `__syncthreads`/stage; fused fragment→scale→bf16
epilogue. Accepted chain (us): 981.53 (iter 1) → 834.14 (iter 3, A LDS stride
64→80; PMC: conflicts 77.6M→31.5M, 8-way→2-way) → **803.90** (iter 10,
stage-top publish).

**hy3_tp4_shared_gate_up_proj_m4096 (worker_2)** — final accepted iter 13
(`w8a8_gemm_prefill_tiled_kernel<64,128,64,2>`): 64x128 tile, 512 threads = 8
waves, 32x32 quadrant/wave = 4 accumulators; grid dim3(6,64) = 384 blocks;
K stage 64 double-buffered, one barrier/stage (65/block), 30,720 B LDS, 2
blocks/CU; `pack_weight` transposes [K,N]→[N,K] for this shape only (outside
timed region); B staged [N,K], `col_major` fragments; iter 13's
`load_fragment8` writes the 8 consecutive bytes straight into fragment
storage (one ds_read2_b64 per fragment), removing the per-byte mask/OR
reassembly (VALU 16.08M→6.25M). Accepted chain (us): 436.21 (iter 1) →
392.58 (iter 3, double-buffered K) → 280.05 (iter 10, [N,K] pack + col_major)
→ **220.71** (iter 13, load_fragment8). Bottleneck chain was LDS-wait-bound
throughout: bank-skew → software pipeline → B-fragment aliasing →
byte-reassembly VALU.

**hy3_tp4_shared_down_proj_m4096 (worker_3)** — final accepted iter 14
(`w8a8_dumma_prefill_kernel<128,64,64>`): 128x64 tile, 512 threads = 8 waves,
32x32 quadrant/wave; grid (N/64, M/128) = 2048 blocks; K stage 64
double-buffered, 29,696 B/block (A stride 80, B stride 72), **2 blocks/CU at
57 VGPR — first clean 2-block residency at constant tile** (VGPR-bound;
`__launch_bounds__` minBlocks was ignored at 74 VGPR); iter 14 packs weight
**n-major `packed[n][k]`** so B staging is 2× ds_write_b64/thread (was 16×
ds_write_b8 + ~12 VALU extracts); kk body 2×-unrolled with two independent
fragment sets, all 8 ds_read2 before the 8 v_mmac. Accepted chain (us):
266.74 → 259.23 (double-buffer + VGPR prefetch) → 255.46 (n-major B in LDS +
col_major) → 245.29 (stage 32→64) → 236.39 (unrolled kk) → **214.84** (n-major
pack). This lineage ended `plateau=false` — the accepted 214.84 us is the best
found, not a proven optimum.

## 7. Prefill acceptance protocol (M=4096 lineages)

Unprofiled CUDA-graph replay, 100 warmup / 30 samples × 100 replays, hot
cache; report median AND p90 (p90 guard vs current best), never min; compare
Graph vs Graph only; re-verified runs must have correctness ON (mismatch=0,
max_abs_error=0.0). PMC (`hipprof --pmc --pmc-type 3`) explains results after
acceptance and must move the predicted counters, else the mechanism is
ambiguous. Report thermal/frequency drift explicitly (see the M=3072
wqkv_a retune) rather than hiding it with the best short run.

Additionally for M=4096:

- Exact bf16 vs reference (mismatch 0); preserve the exact int32 accumulation
  order (k0-outer, kk-inner) and the element-to-slot fragment mapping so
  variants are bit-identical.
- Graph capture + changed input contents + replay must pass; after any change,
  re-capture the Graph with changed input contents and replay again. A Graph
  replay may update contents, never addresses/shapes. M tails and the scalar
  fallback must still pass.
- Verify resources from the exact code object + launch record (arch_vgpr vs
  code-object vgpr_count, LDS bytes, scratch/spills, grid/workgroup);
  `__launch_bounds__` minBlocks is a hint and can be ignored (down_proj
  iter 7). Occupancy math: blockDim multiple of 64; 2-3 blocks × LDS ≤ 64 KiB;
  VGPR × threads × blocks ≤ 512 KiB.
- Use the pre-seeded CPU int64 exact reference (it is slow); never run
  correctness without the reference cache present.
- Report thermal/frequency drift (max samples ~1.5x median are common;
  implied clock ~1.45 GHz) instead of hiding it with the best short run.
- `lds_wait ~= lds_instructions` alone is not a bottleneck signal (true in
  accepted kernels too); profiled time is never the score — PMC must move the
  predicted counters.

TP8-specific notes (hy3_tp8_*_m4096 and GLM-5.2 glm_tp8_*_m4096):

- Restore the accepted source to its recorded digest before the next
  experiment; make ONE bounded mechanism per round with a falsifiable
  prediction (expected direction + expected PMC/ISA deltas; a >2% regression
  falsifies the mechanism).
- Verify the exact code object of the timed run (digest-matched, never a
  stale sibling symbol); audit the exact template symbol for load -> MMAC ->
  wait -> LDS-store order, VGPR/LDS/scratch/spills, no removed required
  loads, no spilled prefetches. `__launch_bounds__` minBlocks is a hint, not
  a contract.
- Report thermal/frequency drift: max samples ~1.5-2.1x median are routine
  (GLM-5.2 lineage), not just the ~1.5x seen on TP4.
- Continue per-shape HIP search — no TP8 shape has a proven optimum (qkv's
  plateau rule of 8 valid HIP rounds within ±2% was never met; down_proj's
  best is best-found; all six GLM-5.2 shapes are `plateau=false`).

## 8. Rejected / guardrail evidence (TP4 prefill)

TP8 M=4096 rejected ideas live in §3.4. TP4 rejected evidence:

**M=4096 (hy3_tp4_*_m4096) rejected ideas** (measured, correct where noted —
do not repeat without new evidence):

- qkv: 128x64 tile flip (1152.10); one-stage-earlier global prefetch (725.77,
  −0.54% — global-load latency already hidden by co-residency); minBlocks=4 /
  72→64 VGPR squeeze (749.80 — 4 spill slots, confounded); 512-thread 8-wave
  blocks (733.01, −1.52%); B stride 80→72 conflict fix (752.79 — B conflicts
  sit at the ~4-cycle 32-bank pigeonhole floor); A stride 68→80 (732.59);
  sync-group retile (920.53); iter 19 accepted-build variant (713.84, p90
  guard failed).
- o_proj: 128x128 tile/1 block per CU (840.44, loses 2nd resident block);
  64x128 tile flip (959.38); register-rotated kk fragment prefetch (845.00);
  kStageK 64→32 / 3 blocks per CU (866.60); four-A-fragment WAR removal
  (830.13, flat); per-wave staging with zero barriers (967.17 — duplicated
  staging traffic swamps barrier savings); dual loop-carried payloads /
  two-stage lead (827.76, flat); eight A fragments at stage top (872.61).
- gate_up: direct-A arm with B-only staging (3444.26 — 7.9x slower; the
  M=16 decode kernel's direct-B-from-global win does **not** transfer across M
  regimes); 128x128 tile / 1024 threads (519.86, 5 VGPR spill slots +
  192-block grid); kStage 64→32 / 3 blocks per CU twice (407.85, 413.60 —
  more occupancy with phase-locked co-resident blocks does not pay).
- down_proj: K stage 64→128 (363.76 — stage-depth axis saturates at 64);
  64x64 active tile occupancy probe (270.34 — confounded: shrunk tile doubles
  per-output B staging); B-staging "register diet" (304.22 — flat batched
  staging issue order is load-bearing; the restructure caused scratch spills).
- Common pattern: these kernels are LDS-latency/issue-bound, not HBM-bound;
  barrier removal, occupancy changes, and deeper register prefetch all failed
  once LDS strides and pack layout were fixed. Do not re-litigate without
  profiling the exact shape.
- Killed rounds produced no candidate (`compile_or_agent_failure`: agent
  killed ~900 s, missing proposal.json, restore/resume failures): qkv
  8,9,10,15,17,20; o_proj 2,5,9,11,12,13,18,19; gate_up 5-7,9,11,14,15;
  down_proj 3,4,6,8,13,15. These are **infra/agent failures and prove
  nothing** — not that DUMMA, INT8, a HIP API, templates, or inline asm are
  unsupported. After a killed round, restore the accepted source to its
  recorded digest before the next experiment.
- **LDS bank-skew rule**: pad row strides to 16-byte-aligned non-power-of-two
  values (e.g., 80 = 64+16, 72 = 64+8, 68 = 64+4, 144 = 128+16); strides ≡ 0
  (mod 128 B) alias every row onto one bank phase (up to 8-16-way fragment
  conflicts).
- For compute prefill, report unique API bytes and tiled global requests
  separately. The M=3072 winner has only about 47.30 GB/s of unique API bytes
  but about 1.024 TB/s of tiled A/B+output requests; cache can serve repeated
  tile traffic, so neither number alone is physical HBM bandwidth.
- Do not assume a deeper Graph helps large-M compute. For the M=3072 winner,
  one node beat 4/8/16-node cold-ring Graphs because launch overhead was
  already negligible relative to the roughly 0.6 ms kernel.
- M=4096 baselines are the fixed user-supplied Triton table values; they were
  not re-measured and must not be called optimal. All four shapes now have
  accepted candidates; a future shape whose worker timed out or produced no
  accepted candidate stays unoptimized — never infer a speedup or optimality
  for it.

## 9. Next optimization questions (prefill)

- Prefill shapes other than wqkv_a: repeat the stage32/64/128 and single/double
  LDS search; do not copy the wqkv_a stage64 dispatch without measurement.
- Prefill tile search: compare 64x64 against larger/smaller tiles while
  preserving enough grid blocks and auditing VGPR/LDS/scratch in the exact
  code object.
- Measure hot and production-like cache behavior separately.
- Revalidate on the full model/8-card deployment before claiming production
  DeepSeek-V4 gains.
- M=4096 per-shape search should continue: **no proven optimum** in either
  lineage — the control plane ended `plateau=false` for TP4 qkv and
  down_proj, o_proj/gate_up explicitly disclaim optimality, and no TP8 shape
  established a plateau. Accepted numbers are the best found, not proven
  ceilings. For TP4 qkv, iter 19's plateau rule (8 valid HIP rounds within
  ±2% of best) was not met — continue HIP-only work on that shape. TP4
  down_proj's 214.84 us is the best found, not a proven optimum; TP8 qkv
  (iter 6), o_proj (iter 12), gate_up (iter 18), down_proj (iter 10) are
  likewise best-found.
- TP8 (hy3_tp8_*_m4096): continue per-shape HIP search with the §7 protocol
  (one bounded mechanism per round, falsifiable prediction); boundary
  32 < M < 4096: reuse the staged recipes and measure per exact M before
  committing a route.
- GLM-5.2 TP8 M=4096 (glm5-2-dsh-tp8-m4096-1, §4): continue per-shape HIP
  search on all six shapes with the §7 protocol (no plateau proven) — e.g.
  fused_qkv_a's p90-failed 938.84 us load-all-then-MMAC-all variant and
  kv_b's shadow mechanisms (stride skew / prefetch, ~138.2-138.8 us) are
  within ~1% of the accepted best. GLM-5.2 decode (M <= 32) is unoptimized in
  that lineage: run the decode skill's split-K + fused-combine family on the
  GLM-5.2 TP8 shapes. Revalidate on the full model / 8-card deployment before
  claiming production gains.
- M in (32, 3072): reuse the staged recipes and measure (see §5).
