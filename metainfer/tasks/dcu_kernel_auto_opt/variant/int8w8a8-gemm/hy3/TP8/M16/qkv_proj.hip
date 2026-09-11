// @@variant shape=hy3_tp8_qkv_proj_m16 commit=f2b771e350c9fea3b13d59b5fec4219786976bcc added=2026-09-09
//   median_us=19.3 p90_us=19.32 speedup=3.875 baseline_us=74.78
//   source=hy3-dsh-tp8-m16-9-8-0161e718
// W8A8 INT8 GEMM HIP implementation for Hygon K500SM_AI / gfx928.
//
// Worker: worker_0 (physical GPU 0), shape hy3_tp8_qkv_proj_m16
//   M = 16, N = 1280, K = 4096  (logical weight layout [K, N]).
//
// Iteration 0 (bootstrap): correctness-first scalar kernel (one thread per
// output element) served every shape and measured 336 us on this shape.
//
// Iteration 1 (DUMMA bootstrap, this round): replace the scalar kernel for
// the exact guard (m, n, k) == (16, 1280, 4096) with the minimal native
// gfx928 DUMMA INT8 m16n16k32 tile per the round mandate:
//   - one 64-lane wavefront per block, one 16x16 output tile per block
//     (grid = N/16 = 80 blocks), no cross-wave barrier;
//   - A and B fragments are loaded DIRECTLY from their row-major global
//     tensors every 32-K step (no LDS staging, no split-K, no workspace,
//     no combine kernel in the timed region);
//   - explicit int32 accumulation: du_fill_fragment(acc, 0) then one
//     du_mma_sync per ascending 32-K step (exact int32 dot, same sum as
//     the scalar kernel since int32 addition is exact and order-free);
//   - single-wave LDS epilogue: du_store_matrix_sync materializes the
//     16x16 int32 tile in LDS (library-defined ownership), one
//     __syncthreads() reached by all 64 threads, then the 64 lanes scale
//     with x_scale[row] * weight_scale[n0+col] (scalar-path float order)
//     and store bf16 through the manual round-to-nearest-even conversion.
// This establishes the exact DUMMA API family below so later rounds can
// tune geometry (wavefronts/block, LDS staging, split-K planes).
//
// Iteration 2 (architecture round, this round): measure grid parallelism
// before polishing.  The iteration-1 geometry (80 one-wave blocks over 120
// CUs, 0.67 blocks/CU) is far below the two-blocks-per-CU latency-hiding
// target, and the measured 130.43 us median (vs 74.782 us Triton Graph
// baseline) is dominated by underfilled CUs and per-block serial load->mma
// chains (128 direct-load 32-K steps per block).  This round replaces the
// exact-guard dispatch with a grid-level split-K=3 geometry, still one
// 64-lane wavefront per block and one 16x16 N tile per wave (zero in-block
// barriers):
//   - grid = (N/16) * SPLIT_K = 80 * 3 = 240 blocks = exactly 2 blocks per
//     device CU (120 CUs), split id on gridDim.y, tile id on gridDim.x;
//   - the 4,096-long K axis is partitioned into three legal 32-aligned,
//     non-uniform, ascending slices of {1376, 1376, 1344} rows (43/43/42
//     m16n16k32 steps), each block du_fill_fragment(acc,0) then runs its
//     own ascending 32-K DUMMA chain over its slice only (bit-exact int32
//     partial dot: |partial| <= 6.6e7 << 2^31, order-free);
//   - each block materializes its 16x16 int32 partial (LDS epilogue, same
//     single-wave store/barrier pattern as iteration 1) into its own plane
//     of the caller's int32 workspace: partials[split][16][N]; every launch
//     overwrites every plane, so no workspace clear is needed;
//   - a small combine kernel (80 blocks x 64 lanes, second launch on the
//     same stream inside the timed API) sums the SPLIT_K planes ascending
//     per output element (exact int32, identical to the scalar k-ascending
//     sum) and applies x_scale[row] * weight_scale[col] then bf16 RNE,
//     keeping every output bit-identical to the CPU reference.
// Split-K combine is part of the operator wall and stays inside the timed
// region/Graph.  Workspace need = SPLIT_K*M*N*4 = 245,760 B, well under the
// contract's 16-plane 1,310,720 B allocation for this shape.
//
// Iteration 3 (architecture round, this round): continue the mandated
// split-K occupancy sweep.  Iteration 2's falsifiable claim held (240
// one-wave blocks = 2 blocks/CU cut the wall from 130.43 to 68.65 us
// median, 1.089x over the 74.782 us Triton Graph baseline), but the
// measured logical rate (86 GB/s, 2.44 TOPS) is still far below the
// headroom of this decode family, so the sweep goes finer inside the
// trusted CU-aligned probe set {2,3,4,5,6,8,9,12}: SPLIT_K=6 -> grid =
// 80 N tiles x 6 K-slices = 480 one-wave zero-in-block-barrier blocks =
// exactly 4 blocks per device CU, and each block's serial 32-K chain
// halves to {22,22,21,21,21,21} steps = rows {704,704,672,672,672,672}
// (the existing generic slice formula; disjoint, ascending, 32-aligned,
// exact cover of [0,4096)).  The partial and combine kernels are
// UNCHANGED code -- both were already generic over gridDim.y /
// split_count -- so this round only moves the launcher geometry constant
// kSplitK from 3 to 6.  Workspace need = 6*M*N*4 = 491,520 B, still
// inside the caller's 16-plane 1,310,720 B allocation; the combine kernel
// (80 blocks x 64 lanes) sums the six planes ascending per output element
// (exact int32 -> bit-identical to the scalar k-ascending sum) and stays
// in the timed Graph.
//
// Iteration 4 (architecture/pipeline round, this round): multi-N-tile
// reuse.  The iteration-3 code object (PMC digest 26d6df45...) shows the
// poison direct-load pattern per 32-K step: 16 global_load_ubyte (8 per
// A/B fragment) with ~10 scattered s_waitcnt vmcnt before byte reassembly
// and one v_mmac_i32_16x16x32_i8, and no cross-iteration load overlap, so
// at 4 resident one-wave blocks/CU every block's serial chain is one
// ~load-latency step per m16n16k32 mma (52.19 us median; the wall is the
// per-step latency of a one-mma step, not raw issue or HBM traffic).
// This round keeps the same split-K partial + combine architecture and
// the same 4 blocks/CU co-residency but widens each one-wave block to TWO
// adjacent 16-wide N tiles (32 columns): per 32-K step the wave loads the
// A fragment ONCE and issues two du_mma_sync (independent accumulators),
// so the x_q A bytes [16 x 32] of the shared step are reused across the
// two output tiles (per-output A global loads/reassembly halve) while
// each B byte is still read exactly once (no B reuse).  To keep 480
// one-wave blocks = exactly 4/CU over 120 CUs the grid becomes 40 N
// groups x SPLIT_K=12 K-slices ({11x8, 10x4} 32-K steps = rows
// {352x8, 320x4}, disjoint ascending exact cover of [0,4096), every
// boundary a DUMMA-k multiple; existing generic slice formula).  Per-block
// serial chain drops to <= 11 steps of TWO mmas, so if the iteration-3
// wall is per-step load->mma latency the per-output step latency halves
// and the unprofiled Graph median/P90 must drop materially below
// 52.194/52.269 us.  Workspace need = 12*M*N*4 = 983,040 B, still inside
// the caller's 16-plane 1,310,720 B allocation; the combine kernel (80
// blocks x 64 lanes) is UNCHANGED code and sums the twelve planes
// ascending per output element (exact int32 -> bit-identical to the
// scalar k-ascending sum), staying in the timed Graph.  The only edits
// are the widened per-wave N tile in the partial kernel plus the launcher
// geometry; the workspace-less fallback keeps the iteration-1 one-wave
// direct kernel byte-for-byte and the scalar fallback still serves every
// unmatched shape including the paired M=2 API shape.
//
// Iteration 5 (packed-weight/staging round, this round): B-only LDS slice
// staging.  The iteration-4 code object (PMC digest 1a4e30d0..., vmem_read
// 122,880 = 24 byte-granular global_load_ubyte per 32-K step x 5120
// block-steps) shows the remaining wall is the poison direct-global B half
// of the per-step load->wait->reassembly->mma chain: per step the wave
// still pays 16 global byte loads (B0/B1) plus ~10 scattered s_waitcnt
// vmcnt on the MMA critical path even though every byte is L2-hot in the
// timed Graph replay.  Per the lineage rule, direct-global fragment loads
// are poison: this round removes the B half by staging each block's whole
// 32-column B slice (<= 352 rows x 32 B = 11,264 B) into LDS ONCE at block
// start with 16-B int4 cooperative loads (64 lanes x 16 B per wavefront
// instruction, 4-deep source batching so one vmcnt drain covers 4
// in-flight round trips), one same-wave __syncthreads(), then every
// 32-K step reads the B0/B1 fragments from LDS with du_load_matrix_sync
// (~30-cycle LDS latency, no global round trip) at row stride 32 -- the
// staged tile is an exact byte mirror of the block's global B strip, so
// fragment contents, the k-ascending int32 order and the partial planes
// are bit-identical to iteration 4.  A stays direct-global on purpose:
// this round isolates the B-side hypothesis (A-only staging and the
// packed [N,K] layout remain untested axes).  Geometry is UNCHANGED (40
// N groups x SPLIT_K=12 = 480 one-wave blocks = exactly 4 blocks/CU over
// 120 CUs; per-block LDS 11,264 B + 2 x 1,024 B acc tiles = 13,312 B,
// 65,536/13,312 = 4.9, so the 4/CU co-residency is preserved and LDS does
// not become the occupancy limiter).  If the per-step wall is the B-load
// half of the global wait ladder, the official unprofiled Graph median/P90
// must drop materially below 41.154/41.233 us (partial-kernel profiled
// 36.32 us); if instead the median stays flat or regresses, the wall at 4
// waves/CU is A-side latency or per-CU issue (16 vs 24 loads immaterial),
// and the next round must stage A too (LDS-only K loop) or raise
// co-residency -- never a scalar-fallback change.  Exactness is preserved
// for every shape: the (m,n,k)==(16,1280,4096) guard is unchanged; the
// staged bytes are a copy of the same global bytes the direct loader
// read, the workspace-less fallback keeps the iteration-1 direct kernel
// byte-for-byte (still correct for this shape), the scalar fallback still
// serves every unmatched shape including the paired M=2 API shape, and no
// pack/layout/env/stream/config change is made; all launches stay on the
// caller stream inside the timed API/Graph.
//
// Iteration 6 (infrastructure failure, no valid artifact): the round-6
// attempt was killed by the agent infrastructure before it produced a
// candidate result; no round-6 source change was accepted and the session
// was reset to the iteration-5 accepted best source below.  The failure does
// not count as a completed optimization round.
//
// Iteration 7 (staging round, this round): A+B whole-slice LDS staging
// (LDS-only K loop).  The iteration-5 result (39.404/39.485 us official
// Graph median/P90 vs iteration-4 41.154/41.233) falsified its own claim:
// the predicted 25-33 us for the B-half hypothesis did not appear, so per
// the iteration-5 contingency text this round stages the shared A operand
// too.  The iteration-5 PMC (source digest 5fb42aff..., grid 480 = 40 N
// groups x SPLIT_K=12, vmem_read 46,080, l2_misses 98,879, counter-derived
// HBM ~187.9 GB/s << peak) still shows 8 byte-granular global_load_ubyte of
// the shared A fragment plus ~8 scattered s_waitcnt vmcnt before shift/or
// reassembly on the MMA path every 32-K step (~40,960 of the 46,080
// vmem_read over 5,120 block-steps): pure per-step A-side global latency
// serialization, not traffic.  This round stages BOTH operands once per
// block with 16-B int4 cooperative loads (A slice: 16 m-rows x 256 B + 16 B
// pad/row = 4,352 B at row stride 272 for bank skew; B strip: 256 x 32 =
// 8,192 B), one same-wave __syncthreads(), then an LDS-only K loop (A
// fragment at row stride 272, B0/B1 at row stride 32 via
// du_load_matrix_sync) with zero per-step global loads/waits.  Staged tiles
// are exact byte mirrors of the global operands, so fragment bytes, the
// k-ascending int32 order and the partial planes are bit-identical to
// iteration 5.  Geometry forced by LDS capacity: a whole-slice A stage does
// not fit at SPLIT_K=12 with 4 resident blocks/CU (A 16 x 352 = 5,632 B +
// B 11,264 B + acc 2,048 B = 18,944 B -> floor(65,536/18,944) = 3), so the
// guard launch moves to SPLIT_K=16: sixteen UNIFORM 8-step slices (128 ==
// 16 x 8, rows {256 x 16}; every boundary a DUMMA-k multiple), grid = 40 N
// groups x 16 = 640 one-wave blocks ~ 5.33/CU over 120 CUs, per-block LDS
// 4,352 + 8,192 + 2,048 = 14,592 B -> floor(65,536/14,592) = 4 resident
// blocks/CU, i.e. the iteration-5 co-residency is preserved.  Workspace
// need = 16 int32 planes = 1,310,720 B = the caller's full fixed 16-plane
// allocation for this shape, still gated by the launcher's workspace_bytes
// >= kWorkspaceNeeded check (undersized workspaces keep the workspace-less
// fallback).  The combine kernel (80 blocks x 64 lanes, second same-stream
// launch in the timed API/Graph) is UNCHANGED code, generic over
// split_count = 16, and sums the sixteen planes ascending per output
// element (exact int32 -> bit-identical to the scalar k-ascending sum),
// staying in the timed Graph.  All fallbacks, guards, pack/layout/env/
// stream/config behavior are unchanged.
//
// Iteration 8 (occupancy/resource round, this round): raise the waves-per-
// block occupancy limiter from 1 to 2 wavefronts per block (blockDim 64 ->
// 128).  PMC of the accepted iteration-7 code object (source digest
// b64e3209..., grid 640, workgroup 64, arch_vgpr 40, sgpr 48, scratch 0,
// LDS/block 14,592 B -> floor(65,536/14,592) = 4 resident blocks/CU =
// 5.33 waves/CU by grid) shows the residual wall is per-SIMD single-wave
// latency exposure, not issue or HBM traffic: each resident wave is alone
// on its SIMD (4 blocks x 1 wave -> 4 SIMDs), so every per-step
// s_waitcnt lgkmcnt after the staged-fragment du_load_matrix_sync and every
// du_mma accumulator dependency stalls that SIMD with no second independent
// wave to issue (VALU issue utilization ~3-6% of the 26.56 us profiled
// kernel; only 12 one-time staging global loads per block, vmem_read
// 7,680).  The fix keeps the iteration-7 geometry byte-for-byte in every
// respect that affects partials (SPLIT_K=16, 40 x 16 = 640 blocks, 8-step
// slices rows {256 x 16}, staged exact byte mirrors, k-ascending int32
// order, 16-plane workspace) and splits the one-time staging ACROSS the two
// waves (wave 0 copies the A slice, wave 1 copies the B strip; exactly the
// same global bytes read once -- no repeated HBM reads traded for
// occupancy), then each wave runs its OWN 8-step accumulator chain for one
// n16 tile of the block's 32 columns (one du_mma per step per wave; total
// MMA count unchanged).  LDS per block stays 14,592 B -> still 4 resident
// blocks/CU, but now 8 resident waves/CU = 2 per SIMD, so a stalling wave
// is covered by its co-resident sibling.  The only deliberately added cost
// is LDS re-reads: the shared A fragment is now loaded by both waves
// (predicted lds_instructions 99,840 -> ~125-135k with conflicts scaling at
// the measured ~2.56/instr); LDS is not the wall at ~3-6% issue
// utilization.  The combine kernel, guards, workspace-less fallback, scalar
// fallback and pack identity are all unchanged.
//
// Iteration 9 (combine restructure round, this round): attack the OTHER half
// of the operator wall.  PMC of the accepted iteration-8 code object (source
// digest beb25b76..., official Graph median/P90 28.884/28.933 us) profiles
// BOTH timed dispatches of the operator replay: the 640-block partial kernel
// at 19.361 us AND the 80-block combine kernel at 16.960 us -- the combine is
// 46.7% of the 36.321 us profiled operator aggregate, not a small tail.  Its
// structure explains the cost: 80 one-wave 64-lane blocks (<= 80 of 480
// SIMDs busy, ~40 CUs fully idle) whose lanes each run FOUR output elements
// through a DEPENDENT per-plane chain -- one 4-B global load + s_waitcnt
// vmcnt + int32 add per plane, 16 serial DRAM round trips per element (the
// exact code object's static body is one load/wait/add per plane iteration)
// -- against plane data that is L2-cold at combine start (combine
// l2_hit_rate 6.9%, l2_misses 21,596 ~= the whole 1.31 MB of partial planes,
// evicted by the partial kernel's 5.37 MB streaming read): DRAM-latency
// serialization on only 1.34 MB of reads, plus underfill.  This round
// restructures ONLY the combine kernel (the partial kernel, SPLIT_K=16
// 640-block geometry, staged byte mirrors, k-ascending int32 partials,
// 16-plane 1,310,720 B workspace contract, workspace-less fallback, exact
// guard and scalar fallback are byte-for-byte unchanged): the guard launcher
// switches the combine grid from 80 x 1 one-wave blocks to a 2-D grid of 80
// n-tiles x 4 four-row m-groups = 320 one-wave blocks, and the kernel's
// split_count == 16 specialization gives every lane exactly ONE output
// element that issues ALL sixteen plane loads as INDEPENDENT reads into a
// 16-int register array (one vmcnt drain, 16-way memory-level parallelism
// per lane), then sums the registers in ascending split order s = 0..15 --
// the identical int32 sequence as the old ascending loop -- and applies the
// unchanged float scale order and f32_to_bf16_rne, so every output element
// stays bit-identical (this mirrors the validated gate_up S=16 combine
// recipe: issue all 16 plane loads into a register array before the
// ascending sum).  Same stream, same two launches, no allocation or sync
// inside the timed API/Graph.
//
// Iterations 10-15 (five-wave occupancy arc on this guard, all archived at
// iterations/hy3_tp8_qkv_proj_m16/iterationN): iteration 10 (direct-register
// epilogue on the two-wave mapping: acc tiles + epilogue barrier removed,
// LDS 14,592 -> 12,544 B = 5 resident blocks/CU = 10 waves/CU) measured
// 20.827/21.585 us and was NOT accepted; iteration 11 raised waves-per-block
// 2 -> 5 (blockDim 320, grid 16 x 16 = 256 blocks, LDS 29,952 B = 2 resident
// blocks/CU = 10 waves/CU) but FAILED exact correctness (its source declared
// no __launch_bounds__ while the launcher requests 320 threads, so the
// compiled descriptor capped the workgroup at 256 and the fifth wavefront's
// tile was absent: 4,091/20,480 mismatches, first at (m,n)=(0,64)); the
// iteration-11 repair was completed in iteration 13 by declaring
// __launch_bounds__(320) (exact correctness passed, 0 mismatches; measured
// 23.764/24.086 us); iteration 14 (ping/pong fragment double-buffer) passed
// correctness but the toolchain spilled the second fragment set to the
// private segment on every K step (.private_segment_fixed_size 48) -> 39.472
// us, closing the register-pipelining axis; iteration 15 replaced the
// five-wave epilogue __syncthreads() with __threadfence_block() (the acc
// tiles are wave-private and the waves' plane stores are disjoint, so the
// cross-wave join was pure skew cost) and measured 20.613/20.641 us, correct
// but still not below the accepted two-wave 20.179/20.216.
//
// Iteration 16 (this round): close the five-wave occupancy axis with the
// measured occupancy evidence and apply the repair arc's validated epilogue
// discovery to the accepted mapping.  Occupancy ledger of the partial
// kernel, all correct and bit-identical: 8 resident waves/CU (4 x 2-wave
// blocks, LDS 14,592 B) = 20.179/20.216 us (iteration 9, accepted); the two
// independent 10 resident-waves/CU configurations -- iteration 10 (5 x
// 2-wave blocks) 20.827/21.585 and iteration 15 (2 x 5-wave blocks)
// 20.613/20.641 -- BOTH trail the 8-wave configuration, i.e. per-SIMD wave
// density 2.5 (some SIMDs carry 3 waves while others idle) is worse than a
// clean 2.0 on this kernel, and the five-wave mapping (2 or 1 resident
// 5-wave blocks/CU = 10 or 5 waves/CU only) can never reach the 8-wave
// sweet spot.  The accepted iteration-9 source below still carries the SAME
// provably-unnecessary epilogue __syncthreads() cross-wave join whose
// five-wave form cost ~3.15 us (iteration 13 23.764 -> iteration 15 20.613
// with the join removed).  Fix (the ONLY code change of this round; the
// two-wave geometry, blockDim 128, grid 40 x 16 = 640 blocks, staging
// partition, stage byte mirrors, 8-step K loop, combine kernel and its
// 320-block launch, workspace, guards and fallbacks are byte-for-byte the
// accepted iteration-9 candidate, verified by diff): replace the partial
// kernel's epilogue __syncthreads() with __threadfence_block(), exactly as
// iteration 15 validated on the five-wave form of this same kernel.
// acc_tile0/acc_tile1 are each written by du_store_matrix_sync and read
// back only by the SAME wave (w == 0 -> acc_tile0, w == 1 -> acc_tile1), and
// the two waves' plane stores touch disjoint 16-column ranges, so no
// epilogue stage has any cross-wave dependency; __threadfence_block() still
// orders each wave's own outstanding LDS writes before its read-back
// ds_reads (wavefront-wide lgkmcnt drain) while costing zero cross-wave
// wait.  The staging __syncthreads() above stays (wave 0 stages the A slice
// that wave 1 also reads).  Every partial byte and combine output byte is
// unchanged, so the output is bit-identical to iteration 9.
//
// Iteration 18 (this round): compile-time 8-step K-loop specialization of
// the partial kernel, applied to the current checked-in source (the
// iteration-16 candidate; working-tree digest cbc40932... = the iteration-16
// archive, verified by diff).  Round 17 drafted exactly this edit and
// verified its codegen locally, but the agent session was killed by the
// round infrastructure before a valid proposal landed -- no source change
// was ever applied, no build/benchmark ran, and per policy that
// infrastructure failure does not count toward the valid-round ledger, so
// this round re-submits the same HIP-only change as a fresh valid round.
// The iteration-11 repair item is closed since iteration 13 (archived
// iteration-11 five-wave source + __launch_bounds__(320) ONLY, exact-correct
// with 0 mismatches; iterations 13-16 completed that arc and iteration 16
// re-based on the accepted two-wave mapping).  Status of the current source:
// the iteration-16 epilogue barrier-decoupled two-wave partial kernel
// (blockDim 128, grid 40 x 16 = 640 blocks, LDS 14,592 B = 4 resident
// blocks/CU = 8 resident waves/CU) measured official Graph median/P90
// 19.9885/20.0133 us (min 19.9557 / max 21.3734, correctness 0 mismatches,
// Graph capture and paired M=2 fallback passed), improving the accepted
// 20.179/20.216 by 0.95%; it is kept as the experimental base ("official
// best is unchanged until cumulative improvement reaches the normal
// acceptance threshold"), and this round keeps building on that source.
// The partial kernel dominates the operator wall, and the exact-source code
// object shows its K loop is ROLLED: the generic loop is runtime-bounded
// (my_steps from the runtime k and gridDim.y args), so the backend emits one
// static body of [ds_read2_b32 (A) + 8 x ds_read_u8 (B) + ~25-VALU byte
// reassembly + 4 lgkmcnt drains + one v_mmac_i32_16x16x32_i8] with a
// loop-carried WAR on the single fragment register set: step s+1's LDS
// reads cannot issue until step s's v_mmac has consumed the same fragment
// registers, so every step's full LDS latency sits serially on the
// accumulator chain with only 2 resident waves/SIMD to cover it (reused PMC
// of this exact geometry: lds_instructions 107,520, lds_wait_instructions
// 19,597, lds_bank_conflicts 276,480).  The guard launch is the kernel's
// ONLY call site and always runs the uniform 8-step slice (k == 4096,
// gridDim.y == 16 -> my_steps == 8 == kStageMaxSteps, rows == 256 ==
// kStageMaxRows, staged capacity exactly filled), so this round specializes
// that case: when my_steps == kStageMaxSteps the K loop runs with a
// COMPILE-TIME trip count of 8 under #pragma unroll; the backend then fully
// unrolls the chain, renames the fragment registers per step and issues
// each step's LDS reads after the previous step's v_mmac has consumed its
// registers, overlapping the next step's LDS round trip with the current
// v_mmac's execution (no loop-carried WAR; verified in the local exact-flag
// code object of this edit: 8 static v_mmac + 72 static ds_reads in the
// specialized path vs 1 static v_mmac / 10 static ds_reads in the rolled
// predecessor, vgpr 34 / sgpr 39 / private_segment 0 / group_segment 14,592
// B and exactly ONE s_barrier unchanged -> the 4-blocks/CU = 8-waves/CU
// occupancy is preserved).  Both branches issue the identical ascending-s
// du_mma sequence into the same accumulator (v_mmac acc operand v[1:4]
// throughout) over the same staged byte mirrors, so every partial byte and
// every combine output byte is bit-identical to iteration 16 and exact
// correctness must pass with 0 mismatches; the generic rolled loop stays
// verbatim as the else path for any non-guard (my_steps != 8)
// configuration.  Geometry, staging partition, stage byte mirrors, the
// blockDim 128 / grid 40 x 16 = 640 blocks launch, the epilogue
// (acc-tile store + __threadfence_block + read-back plane store), the
// combine kernel and its 320-block launch, the 16-plane 1,310,720 B
// workspace need, the workspace-less iteration-1 fallback, the exact
// (m,n,k)==(16,1280,4096) guard and the scalar fallback for every unmatched
// shape (including paired M=2) are all unchanged.
//
// Iteration 20 (DS-side staging-latency round, accepted): the exact-guard
// launch always stages the full 512-chunk B strip (chunks == 512 == 8 x 64
// lanes), so wave 1's B copy now runs as ONE straight-line 8-deep batched
// group (all eight 16-B source loads issue before the first LDS store, one
// vmcnt drain covers the whole strip) instead of two serialized 4-deep
// iterations -- the second global round trip is removed from every block's
// staging join critical path (official Graph median/P90 19.967 -> 19.541/
// 19.558 us, accepted).  The generic rolled loop stays verbatim as the else
// path for any non-guard (chunks != 512) configuration.
//
// Iteration 21 (this round): DS-side bank-skew round for the B-fragment
// ds_read_u8 structure (pre-registered in iterations 18 and 20: the next
// increment must attack the PMC-documented DS ledger of this exact object --
// lds_bank_conflicts 276,480 = ~2.57 replays per LDS instruction, dominated
// by the 8 byte-granular B-fragment reads per step per wave, 128 per block).
// The row-major B fragment loader reads each lane's 8 bytes at addresses
// base + (8*(lane>>4) + i) * ldm for i = 0..7, so the four row groups
// g = lane>>4 of the fragment's 32 k rows sit 8*ldm bytes apart; with the
// stage_b rows packed at the old ldm == 32, every group sat 256 B (== 0
// mod 128 B) apart and each ds_read_u8 replayed the SAME LDS bank 4x per
// wavefront.  This round pads each staged B row to kStageBRowStride = 36 B
// (32 data + 4 pad): the groups then sit 288 B (== 32 mod 128 B) apart and
// hit banks {b, b+8, b+16, b+24} -- the B-fragment reads become
// conflict-free while every staged data byte, the fragment contents, the
// k-ascending int32 order and the partial planes stay bit-identical (the
// pads are never written or read; only the loader's ldm argument and the
// wave-1 store offsets change).  Wave-1 staging stores become four 4-B
// words per 16-B chunk (36*r is only 4-B aligned) at int32 offsets
// 9*r + 4*h + {0,1,2,3}; LDS store bandwidth is unchanged.  LDS per block
// grows 14,592 -> 15,616 B (stage_b 8,192 -> 9,216): 4 x 15,616 = 62,464
// <= 65,536, so the 4-resident-blocks/CU = 8-resident-waves/CU occupancy
// sweet spot is preserved.  The workspace-less fallback, the exact
// (m,n,k)==(16,1280,4096) guard, the scalar fallback for every unmatched
// shape (including paired M=2), the combine kernel and its 320-block
// launch, the pack identity and the 16-plane 1,310,720 B workspace need are
// all unchanged.  The iteration-11 repair item stays closed since
// iteration 13 (five-wave archive + __launch_bounds__(320) ONLY, exact-
// correct; the five-wave axis closed on measurement: best 20.613/20.641 us
// vs the accepted two-wave mapping 19.541/19.558 us).
//
// Iterations 22-25 (rounds 22 and 23 measured and rejected, tree reverted to
// the iteration-21 source e7ae27d0...; round 24 was killed mid-round before
// any measurement -- its archive draft was never compiled or run): round 22
// removed the acc-tile LDS round trip from the partial epilogue at pinned
// occupancy (direct-register plane stores) and REGRESSED (+0.82 us ->
// 20.276/20.298 us) because the register-distributed acc values force 16-B
// store granules per wavefront instruction instead of the read-back path's
// four full 64-B lines -- rejected and reverted; round 23 widened each
// combine block to a 32-column n-strip with dwordx2 plane loads (160 blocks)
// and measured FLAT (median 19.4504 us vs the 19.4528 shadow, within its own
// +/-0.05 us falsification band, plus a 41.1 us max outlier) -- rejected and
// reverted.  Round 23's pre-registered falsification branch (a) therefore
// committed THIS round to a combine block mapping whose per-plane reads run
// in longer contiguous runs per row (or a partial-plane store-order change),
// never occupancy / fragment duplication / raw asm / a scalar-fallback
// change.
//
// Iteration 25 (this round): combine mapping v3 -- one output row per
// block.  The combine byte stream is fixed (every plane word is read
// exactly once, 64-B sectors fully consumed), so v1 (iteration 9: blocks of
// 4 rows x 16 cols) and v2 (iteration 23: 4 rows x 32 cols) both issue
// every per-plane wavefront load as FOUR 64-B (v1) or 128-B (v2) runs at
// the 5,120-B m-row stride -- four different DRAM rows, i.e. up to four row
// activations per load instruction -- which is exactly why widening the
// per-row run 64 -> 128 B in v2 could not move the combine (it never
// reduced the rows-per-instruction scatter).  The guard combine launch now
// uses one-wave blocks that each own ONE m-row x 64 consecutive columns
// (kDummaCombineColsPerBlock = 64; grid 20 x 16 = 320 blocks, the same
// 320-block count and the same one-output-element-per-lane, 16-independent-
// plane-load structure as iteration 9): every per-plane wavefront load then
// reads 64 lanes x 4 B = 256 B CONTIGUOUS = four consecutive 64-B lines of
// ONE DRAM row (single run, ~4x fewer DRAM row activations for the same
// byte stream).  Each element's ascending-s int32 sum, the float scale
// order and every output bf16 word are unchanged element-for-element, so
// the output is bit-identical to the iteration-21 shadow; the partial
// kernel, the 16-plane workspace contract, the exact guard, the
// workspace-less fallback and the scalar fallback (paired M=2 included) are
// byte-for-byte untouched.
//
// launch_pack_w8a8_weight (optional, out of the timed region) is an
// identity device-to-device copy: the logical [K, N] int8 weight and the
// [N, 1] fp32 scales are copied unchanged, so the DUMMA direct loader
// reads the exact logical [K, N] row-major layout.  Later rounds may
// change the packed layout here together with the matching GEMM
// interpretation.
//
// This file is compiled with hipcc by torch.utils.cpp_extension; it must
// stay free of torch/ATen dependencies.  Only the two extern "C" launchers
// below are the host contract consumed by csrc/bindings.cpp.
//
// Include order is the known-good DTK order: HIP runtime first, then the
// bfloat16 header, then du_mma.h (consumed by the DUMMA kernel below).

#include <hip/hip_runtime.h>
#include <hip/hip_bfloat16.h>
#include <du_mma.h>

#include <cstdint>

namespace {

// IEEE round-to-nearest-even conversion of an fp32 value to a bf16 bit
// pattern, implemented with pure integer ops.  This is exactly the
// conversion applied by the CPU reference (`scaled.to(torch.bfloat16)`),
// independent of which bf16 type family the DTK headers provide.
__device__ __forceinline__ uint16_t f32_to_bf16_rne(float f) {
  constexpr uint32_t kRoundBias = 0x7FFFu;
  uint32_t u;
  __builtin_memcpy(&u, &f, sizeof(u));
  const uint32_t lsb = (u >> 16) & 1u;  // tie goes to even
  u += kRoundBias + lsb;
  return static_cast<uint16_t>(u >> 16);
}

}  // namespace

// ---------------------------------------------------------------------------
// Scalar generic GEMM: out[m, n] = bf16(int32(sum_k a[m,k]*b[k,n])
//                                      * x_scale[m] * weight_scale[n]).
// One thread per output element.  Adjacent lanes walk adjacent columns n
// (the fastest-changing output/weight dimension).  gfx928 wavefront = 64;
// the launcher always uses blockDim 128 (a multiple of 64).
// ---------------------------------------------------------------------------
__global__ void w8a8_scalar_gemm_kernel(
    const int8_t* __restrict__ a,        // x_q      [M, K] row-major
    const int8_t* __restrict__ b,        // packed_weight [K, N] row-major
    const float* __restrict__ x_scale,   // [M] (logical [M, 1])
    const float* __restrict__ w_scale,   // [N] (logical [N, 1])
    uint16_t* __restrict__ out,          // [M, N] bf16 payload
    int m,
    int n,
    int k) {
  const int tid =
      static_cast<int>(blockIdx.x) * static_cast<int>(blockDim.x) +
      static_cast<int>(threadIdx.x);
  const int total = m * n;
  if (tid >= total) {
    return;
  }
  const int row = tid / n;  // M is small for decode; N is the fast axis
  const int col = tid - row * n;

  const int8_t* a_row = a + static_cast<int64_t>(row) * k;
  const int8_t* b_col = b + col;  // stride n along k

  int32_t acc = 0;
#pragma unroll 4
  for (int kk = 0; kk < k; ++kk) {
    acc += static_cast<int32_t>(a_row[kk]) *
           static_cast<int32_t>(b_col[static_cast<int64_t>(kk) * n]);
  }

  const float scaled = static_cast<float>(acc) * x_scale[row] * w_scale[col];
  out[tid] = f32_to_bf16_rne(scaled);
}

// ---------------------------------------------------------------------------
// Exact-guard DUMMA path for hy3_tp8_qkv_proj_m16 (M=16, N=1280, K=4096).
//
// Minimal native gfx928 INT8 tile: DUFragment<matrix_a/matrix_b,16,16,32,
// signed char> fragments with a DUFragment<accumulator,16,16,32,int>
// accumulator, one 64-thread wavefront per block, one 16x16 output tile per
// block (grid = N/16 = 80 blocks).  Every K step is an explicit int32
// du_mma_sync over a 32-aligned ascending k chunk, so the int32 dot is
// identical to the scalar kernel's sum (exact integer addition, no
// overflow: |out| <= K*127*127 ~= 6.6e7 << 2^31).
//
// The gfx928 int8 m16n16k32 accelerator fragment ownership is opaque, so
// the epilogue materializes the tile with du_store_matrix_sync into a
// single-wave LDS staging array (library-defined mem_row_major placement,
// 256 x int32 = 1,024 B) and only afterwards applies the per-element float
// scaling and the bf16 RNE store.  BlockDim is one wavefront, so the single
// __syncthreads() below is a same-wave barrier (all 64 threads reach it)
// and there is no cross-wave synchronization anywhere in the kernel.
// ---------------------------------------------------------------------------
constexpr int kDummaM = 16;
constexpr int kDummaN = 16;
constexpr int kDummaK = 32;
constexpr int kDummaWaveSize = 64;

// Combine constants.  Iteration 9: the exact-guard launcher (SPLIT_K == 16)
// launched the combine kernel as 80 n-tiles x four-row m-groups of one-wave
// blocks and the kernel specialized split_count == kDummaCombineSplits with
// one output element per lane.  Iteration 25 (mapping v3): the guard launch
// becomes 20 column-groups x 16 m-rows of one-wave blocks -- each block owns
// ONE output row x kDummaCombineColsPerBlock = 64 consecutive columns (4 x
// kDummaN), so every per-plane wavefront load reads a single 256-B
// contiguous run (four consecutive 64-B lines inside one DRAM row) instead
// of four 64/128-B runs at the 5,120-B row stride (see the kernel comment
// below for the DRAM row-activation mechanism).
constexpr int kDummaCombineSplits = 16;        // == the guard launcher kSplitK
constexpr int kDummaCombineColsPerBlock = 64;  // n-columns per combine block

__global__ void w8a8_dumma_m16_tile_kernel(
    const int8_t* __restrict__ a,        // x_q [M, K] row-major
    const int8_t* __restrict__ b,        // packed_weight [K, N] row-major
    const float* __restrict__ x_scale,   // [M]
    const float* __restrict__ w_scale,   // [N]
    uint16_t* __restrict__ out,          // [M, N] bf16 payload
    int n,
    int k) {
  const int lane = static_cast<int>(threadIdx.x);  // blockDim == 64
  const int n0 = static_cast<int>(blockIdx.x) * kDummaN;

  __shared__ __align__(16) int32_t acc_tile[kDummaM * kDummaN];

  du::dumma::DUFragment<du::dumma::matrix_a, kDummaM, kDummaN, kDummaK,
                        signed char, du::dumma::row_major>
      a_frag;
  du::dumma::DUFragment<du::dumma::matrix_b, kDummaM, kDummaN, kDummaK,
                        signed char, du::dumma::row_major>
      b_frag;
  du::dumma::DUFragment<du::dumma::accumulator, kDummaM, kDummaN, kDummaK,
                        int>
      acc_frag;
  du::dumma::du_fill_fragment(acc_frag, 0);

  // A is [16, k] (row stride k) and B is [k, 16] (row stride n); both stay
  // row-major in their global tensors, so each 32-K step loads straight
  // from global with the library row_major loaders.
  for (int k0 = 0; k0 < k; k0 += kDummaK) {
    du::dumma::du_load_matrix_sync(a_frag, a + k0, k);
    du::dumma::du_load_matrix_sync(
        b_frag, b + static_cast<int64_t>(k0) * n + n0, n);
    du::dumma::du_mma_sync(acc_frag, a_frag, b_frag, acc_frag);
  }

  du::dumma::du_store_matrix_sync(acc_tile, acc_frag, kDummaN,
                                  du::dumma::mem_row_major);
  __syncthreads();

  // 256 elements / 64 lanes: each lane scales and stores four outputs.
#pragma unroll
  for (int linear = lane; linear < kDummaM * kDummaN; linear += kDummaWaveSize) {
    const int row = linear / kDummaN;
    const int col = linear - row * kDummaN;
    const int out_col = n0 + col;
    const float scaled = static_cast<float>(acc_tile[linear]) *
                         x_scale[row] * w_scale[out_col];
    out[static_cast<int64_t>(row) * n + out_col] = f32_to_bf16_rne(scaled);
  }
}

// ---------------------------------------------------------------------------
// Split-K partial kernel (iteration 2 probe, widened in iteration 4 to
// multi-N-tile reuse, B-staged in iteration 5): same m16n16k32 int8 DUMMA
// tile as iteration 1, but gridDim = (N/(16*kTilesPerWave), SPLIT_K) so
// every one-wave block owns kTilesPerWave adjacent 16-wide N tiles AND one
// ascending 32-aligned K slice, and writes its exact int32 partials into
// workspace planes partials[split][16][n].  Iteration 4: kTilesPerWave = 2,
// so per 32-K step the wave loads the A fragment once and shares it between
// the two du_mma_sync calls (A bytes of the step reused across both output
// tiles; every B byte is still read exactly once).  Iteration 5 (staging
// round, B-only): each block first stages its whole 32-column B slice
// (my_steps*32 rows x 32 B, <= 352 x 32 = 11,264 B under the SPLIT_K=12
// guard launch) into an LDS tile stage_b that is an EXACT byte mirror of
// the block's global B strip (16-B int4 cooperative loads, 4-deep source
// batching so one vmcnt drain covers 4 in-flight round trips), then after
// one same-wave __syncthreads() the K loop reads the B0/B1 fragments from
// LDS with du_load_matrix_sync (row stride 32) -- same fragment bytes as
// the iteration-4 direct global loads, so the int32 partials stay
// bit-identical -- while A stays on the direct-global path (this round
// isolates the B side only).  BlockDim is one 64-lane wavefront: the two
// barriers are the staging barrier above and the single same-wave
// __syncthreads() after the LDS materialization of both partial tiles.
// LDS per block: 11,264 B (stage_b) + 2 x 1,024 B (acc tiles) = 13,312 B
// -> 65,536 / 13,312 = 4.9, so the 4-blocks-per-CU launch co-residency is
// preserved (LDS is not the occupancy limiter).
//
// Iteration 7 (this round): A+B whole-slice LDS staging.  Each one-wave
// block now stages BOTH operands of its whole K slice once: stage_a holds
// the 16 m-rows x 256 slice bytes at row stride 272 (256 data + 16 pad for
// bank skew, 4,352 B) and stage_b holds the 256 x 32 B strip (8,192 B);
// both use 16-B int4 cooperative loads with the same 4-deep batching, one
// same-wave __syncthreads(), and then the K loop reads every fragment from
// LDS (A at row stride 272, B0/B1 at row stride 32) -- zero per-step global
// loads and zero vmcnt waits on the MMA path.  Geometry moved to SPLIT_K=16
// (uniform 8-step slices, 40 x 16 = 640 blocks): per-block LDS 4,352 +
// 8,192 + 2,048 = 14,592 B -> floor(65,536/14,592) = 4, so the 4-blocks/CU
// co-residency of iteration 5 is preserved.  Barriers per block stay two
// (staging, epilogue).  Staged tiles are exact byte mirrors, so partials
// are bit-identical to iteration 5 and the combine kernel is unchanged.
//
// Iteration 8 (occupancy/resource round, this round): tune the waves-per-
// block occupancy limiter.  PMC of the accepted iteration-7 code object
// (source digest b64e3209..., grid 640, workgroup 64, arch_vgpr 40, sgpr 48,
// scratch 0, LDS/block 14,592 B -> floor(65,536/14,592) = 4 resident blocks/
// CU, 5.33 waves/CU by grid) shows a per-SIMD latency-exposure wall: every
// block is ONE wavefront, so at 4 resident blocks/CU the four waves land one
// per SIMD and each SIMD has no second independent wave to issue while the
// resident wave stalls on its per-step s_waitcnt lgkmcnt (lds_wait 8,359)
// after the staged-fragment du_load_matrix_sync and on its du_mma accum
// chain (VALU issue utilization ~3-6% of the 26.56 us profiled kernel;
// vmem_read 7,680 = only the 12 one-time staging loads per block).  Fix:
// blockDim 64 -> 128, i.e. TWO 64-lane wavefronts per block, and the block's
// 32-column strip is split by ownership: wave w computes ONLY n-tile w (cols
// [n0+16w, n0+16w+16)) over the shared 8-step slice with its own independent
// accumulator chain, one du_mma per step per wave (same total MMA count).
// LDS per block is UNCHANGED (stage_a 4,352 + stage_b 8,192 + 2 x 1,024 acc
// tiles = 14,592 B), so 4 blocks/CU still fit but now carry 8 resident waves
// = 2 per SIMD: one wave's LDS->MMA stall is filled by the other.  The
// one-time staging is partitioned, NOT duplicated: wave 0 copies the shared
// A slice and wave 1 copies the B strip (their iteration-7 loops unchanged),
// so exactly the same global bytes are read once (no repeated HBM reads for
// occupancy) and the staging barrier becomes a cross-wave __syncthreads().
// Deliberate added cost: the A fragment is re-read from LDS by each wave
// (lds_instructions 99,840 -> ~125-135k predicted; LDS pipe/conflicts are
// not the wall at ~3-6% issue utilization -- the trade is LDS re-reads, not
// HBM traffic).  Geometry, planes, combine kernel, guards and fallbacks are
// otherwise unchanged.
// ---------------------------------------------------------------------------
__global__ void w8a8_dumma_m16_splitk_partial_kernel(
    const int8_t* __restrict__ a,        // x_q [16, k] row-major
    const int8_t* __restrict__ b,        // packed_weight [k, n] row-major
    int32_t* __restrict__ partials,      // [gridDim.y][16][n] int32
    int n,
    int k) {
  constexpr int kTilesPerWave = 2;   // two adjacent 16-wide N tiles per block
  // Iteration 8 (occupancy round): each block is TWO 64-lane wavefronts
  // (blockDim 128).  Wave w owns N tile w of the block's 32 columns (cols
  // [n0 + 16*w, n0 + 16*w + 16)) and runs an independent 8-step accumulator
  // chain over the shared K slice for that tile alone.
  const int tid = static_cast<int>(threadIdx.x);   // blockDim == 128
  const int w = tid >> 6;                          // wave id inside block 0/1
  const int lane = tid & (kDummaWaveSize - 1);     // lane id within the wave
  const int group = static_cast<int>(blockIdx.x);  // 32-wide n-group id
  const int split = static_cast<int>(blockIdx.y);  // k-slice id
  const int n0 = group * (kDummaN * kTilesPerWave);

  // Stage-buffer sizing is tied to the ONLY launch site of this kernel: the
  // exact (m,n,k)==(16,1280,4096) guard with gridDim.y == 16 (iteration 7),
  // so total_steps == 128 and every split owns exactly 8 steps = 256 rows
  // (128 == 16 * 8; the generic slice formula below degenerates to uniform
  // 8-step slices).  Compile-time capacities: 256 rows of B per block and
  // 16 m-rows x (256 + 16 pad) bytes of A per block.
  constexpr int kStageSplitCount = 16;    // gridDim.y of the guard launch
  constexpr int kStageMaxSteps =
      (128 + kStageSplitCount - 1) / kStageSplitCount;  // 8 (uniform)
  constexpr int kStageMaxRows = kStageMaxSteps * kDummaK;  // 256 rows x 32
  constexpr int kStageARowStride =
      kStageMaxRows + 16;  // 272 B per A m-row: 256 data + 16 pad for banks
  // Iteration 21 (DS-side bank-skew round): each staged B k-row now occupies
  // kStageBRowStride = 36 B (32 data bytes + 4 pad bytes).  The row-major B
  // fragment loader reads a lane's 8 fragment bytes at addresses
  // base + (8*(lane>>4) + i) * ldm, i = 0..7: the four lane groups
  // g = lane>>4 sit 8*ldm bytes apart, so with the old ldm == 32 every group
  // landed 256 B (== 0 mod 128 B) apart and each of the 8 ds_read_u8 per
  // fragment replayed the SAME LDS bank 4x (the PMC-documented
  // lds_bank_conflicts 276,480 = ~2.57 replays/instr on this object, ~89% of
  // it from the B-fragment byte reads: 128 per block).  ldm == 36 puts the
  // groups 288 B (== 32 mod 128 B, 8 banks) apart, so the four groups hit
  // banks {b, b+8, b+16, b+24} -- fully conflict-free -- while the 4-B pad
  // per row keeps every row start 4-B aligned for the staging stores.
  // stage_b grows 8,192 -> 9,216 B and the block total becomes 4,352
  // (stage_a) + 9,216 (stage_b) + 2,048 (acc tiles) = 15,616 B/block:
  // 4 x 15,616 = 62,464 <= 65,536, so the 4-resident-blocks/CU =
  // 8-resident-waves/CU occupancy sweet spot is preserved unchanged.
  constexpr int kStageBRowStride = kDummaN * 2 + 4;  // 36 B per staged B row

  __shared__ __align__(16) int32_t acc_tile0[kDummaM * kDummaN];
  __shared__ __align__(16) int32_t acc_tile1[kDummaM * kDummaN];
  __shared__ __align__(16) int8_t stage_a[kDummaM * kStageARowStride];
  __shared__ __align__(16) int8_t stage_b[kStageMaxRows * kStageBRowStride];

  du::dumma::DUFragment<du::dumma::matrix_a, kDummaM, kDummaN, kDummaK,
                        signed char, du::dumma::row_major>
      a_frag;
  du::dumma::DUFragment<du::dumma::matrix_b, kDummaM, kDummaN, kDummaK,
                        signed char, du::dumma::row_major>
      b_frag;  // this wave's B half of the strip (b_col == 16*w bytes)
  du::dumma::DUFragment<du::dumma::accumulator, kDummaM, kDummaN, kDummaK,
                        int>
      acc_frag;  // this wave's accumulator for its n16 tile
  du::dumma::du_fill_fragment(acc_frag, 0);

  // 32-aligned non-uniform K slicing over the gridDim.y splits: split s owns
  // my_steps ascending 32-K steps beginning at step_begin, slices are
  // disjoint and cover [0, k) exactly once in ascending order, so the int32
  // partial sums and the ascending combine below reproduce the scalar
  // k-ascending sum bit-for-bit.
  const int total_steps = k / kDummaK;
  const int split_count = static_cast<int>(gridDim.y);
  const int base_steps = total_steps / split_count;
  const int rem_steps = total_steps - base_steps * split_count;
  const int my_steps = base_steps + (split < rem_steps ? 1 : 0);
  const int step_begin =
      split * base_steps + (split < rem_steps ? split : rem_steps);
  const int k_base = step_begin * kDummaK;  // first global k row of slice
  const int rows = my_steps * kDummaK;  // slice rows: my_steps x 32

  // Stage the block's operands (iteration 8: PARTITIONED across the two
  // wavefronts, not duplicated -- the union reads exactly the same global
  // bytes as the iteration-7 single wave, so no byte is fetched twice and
  // HBM traffic is unchanged).  Wave 0 copies the shared A slice: the 16
  // m-rows x rows bytes of A (global columns [k_base, k_base + rows)),
  // stored m-major in stage_a at row stride kStageARowStride (an exact byte
  // mirror of global a[m][k_base .. k_base + rows)).  Wave 1 copies the
  // block's 32-column B strip: my_steps*32 rows x 32 B, stored row-major in
  // stage_b at the 36-B row pitch kStageBRowStride (32 data + 4 pad bytes
  // per row; iteration 21 bank skew -- an exact byte mirror of the global
  // data rows [k_base, k_base + rows) x columns [n0, n0 + 32), pads never
  // written or read).  Each copy uses the
  // unchanged iteration-7 cooperative code: 64 lanes x 16 B per wavefront
  // instruction, chunks in LDS int4 units, loads batched 4-deep in source so
  // one vmcnt drain covers 4 in-flight global round trips (the two waves'
  // round trips overlap further across the SIMDs).  Global m-rows are
  // k-major at stride k and global B rows are n-major at stride n (k % 16 ==
  // 0 and n % 16 == 0 under the guard; k_base and n0 are 32-aligned), so
  // every 16-B global load is 16-B aligned (the wave-1 LDS stores are
  // 4-B-granular since iteration 21: 36*row is only 4-B aligned).
  const int a_chunks = (rows * kDummaM) / 16;      // rows/16 int4 per m-row
  const int chunks = rows * (kDummaN * 2) / 16;    // rows*2 int4 chunks
  if (w == 0) {
    const int per_row = rows / 16;
    const int4* __restrict__ a4 = reinterpret_cast<const int4*>(a);
    int4* __restrict__ ald4 = reinterpret_cast<int4*>(stage_a);
    const int kb4 = k_base >> 4;  // global int4 column of the slice start
    const auto ld_chunk = [&](int e) {
      const int m = e / per_row;
      const int t = e - m * per_row;
      return a4[static_cast<int64_t>(m) * (k >> 4) + kb4 + t];
    };
    const auto st_chunk = [&](int e, const int4& v) {
      const int m = e / per_row;
      const int t = e - m * per_row;
      ald4[m * (kStageARowStride / 16) + t] = v;
    };
    int e = lane;
    for (; e + 3 * kDummaWaveSize < a_chunks; e += 4 * kDummaWaveSize) {
      const int4 v0 = ld_chunk(e);
      const int4 v1 = ld_chunk(e + kDummaWaveSize);
      const int4 v2 = ld_chunk(e + 2 * kDummaWaveSize);
      const int4 v3 = ld_chunk(e + 3 * kDummaWaveSize);
      st_chunk(e, v0);
      st_chunk(e + kDummaWaveSize, v1);
      st_chunk(e + 2 * kDummaWaveSize, v2);
      st_chunk(e + 3 * kDummaWaveSize, v3);
    }
    for (; e < a_chunks; e += kDummaWaveSize) {
      st_chunk(e, ld_chunk(e));
    }
  } else {
    const int4* __restrict__ b4 = reinterpret_cast<const int4*>(b);
    const auto ld_chunk = [&](int e) {
      const int r = e >> 1;
      // Global int4 index of (global row k_base + r, col half e&1).
      return b4[static_cast<int64_t>(k_base + r) * (n >> 4) + (n0 >> 4) +
                (e & 1)];
    };
    // Iteration 21: stage_b rows now live at the 36-B pitch
    // kStageBRowStride (32 data bytes + 4 pad per row), so a 16-B chunk
    // (row r = e >> 1, col half h = e & 1 of that row) can no longer be
    // stored with one 16-B-aligned ds_write_b128 (36*r is 16-B aligned only
    // for r % 4 == 0).  Each chunk is stored as four consecutive int32 words
    // at word offset 9*r + 4*h + {0,1,2,3} == (36*r + 16*h)/4 + {0,1,2,3}:
    // every data byte lands at exactly the same byte offset (row*36 + ncol)
    // the loader reads back, so the staged data byte mirror of the global B
    // strip is unchanged -- only the pad bytes (row*36 + 32..35) are never
    // written and never read (the fragment loader only touches ncol < 32).
    // LDS store bandwidth is unchanged (4 x 4-B words per chunk); the four
    // words of one chunk are consecutive, so a lane's store stream stays
    // dense per row half.
    int32_t* __restrict__ lds32 = reinterpret_cast<int32_t*>(stage_b);
    const auto st_chunk = [&](int e, const int4& v) {
      const int word0 = (e >> 1) * (kStageBRowStride >> 2) + (e & 1) * 4;
      lds32[word0 + 0] = v.x;
      lds32[word0 + 1] = v.y;
      lds32[word0 + 2] = v.z;
      lds32[word0 + 3] = v.w;
    };
    // Iteration 20 (guard-slice staging latency specialization): the guard
    // launch is the ONLY call site of this kernel and always stages the
    // full 512-chunk B strip (chunks == rows*2 == 512 == 8 x 64 lanes, rows
    // == 256 == kStageMaxRows, staged capacity exactly filled).  The
    // runtime-bounded 4-deep loop below then compiles to TWO serialized
    // 4-deep iterations (each iteration issues four 16-B source loads and
    // drains them with vmcnt waits before the next iteration's loads can
    // issue -- two full global round trips on the block's staging critical
    // path, one per iteration), and wave 0's A copy finishes in a single
    // 4-deep group and then idles at the __syncthreads() join while wave 1
    // completes its second round trip.  When chunks == 8*kDummaWaveSize the
    // loop now runs as ONE straight-line 8-deep batched group: all eight
    // 16-B source loads per lane are issued before the first LDS store, so
    // one drain window covers the whole strip and the second round trip is
    // removed from the join's critical path.  Every chunk id [0, 512) is
    // still loaded and stored exactly once by exactly one lane to the same
    // stage_b byte (the chunk set, the store order and the byte mirror are
    // identical to the rolled loop), so every staged byte, every partial
    // and every combine output byte is bit-identical; the generic rolled
    // loop stays verbatim as the else path for any non-guard (chunks !=
    // 512) configuration, which never executes at the only launch site.
    if (chunks == 8 * kDummaWaveSize) {
      const int4 v0 = ld_chunk(lane);
      const int4 v1 = ld_chunk(lane + kDummaWaveSize);
      const int4 v2 = ld_chunk(lane + 2 * kDummaWaveSize);
      const int4 v3 = ld_chunk(lane + 3 * kDummaWaveSize);
      const int4 v4 = ld_chunk(lane + 4 * kDummaWaveSize);
      const int4 v5 = ld_chunk(lane + 5 * kDummaWaveSize);
      const int4 v6 = ld_chunk(lane + 6 * kDummaWaveSize);
      const int4 v7 = ld_chunk(lane + 7 * kDummaWaveSize);
      st_chunk(lane, v0);
      st_chunk(lane + kDummaWaveSize, v1);
      st_chunk(lane + 2 * kDummaWaveSize, v2);
      st_chunk(lane + 3 * kDummaWaveSize, v3);
      st_chunk(lane + 4 * kDummaWaveSize, v4);
      st_chunk(lane + 5 * kDummaWaveSize, v5);
      st_chunk(lane + 6 * kDummaWaveSize, v6);
      st_chunk(lane + 7 * kDummaWaveSize, v7);
    } else {
      int e = lane;
      for (; e + 3 * kDummaWaveSize < chunks; e += 4 * kDummaWaveSize) {
        const int4 v0 = ld_chunk(e);
        const int4 v1 = ld_chunk(e + kDummaWaveSize);
        const int4 v2 = ld_chunk(e + 2 * kDummaWaveSize);
        const int4 v3 = ld_chunk(e + 3 * kDummaWaveSize);
        st_chunk(e, v0);
        st_chunk(e + kDummaWaveSize, v1);
        st_chunk(e + 2 * kDummaWaveSize, v2);
        st_chunk(e + 3 * kDummaWaveSize, v3);
      }
      for (; e < chunks; e += kDummaWaveSize) {
        st_chunk(e, ld_chunk(e));
      }
    }
  }
  __syncthreads();  // stage_a and stage_b ready for every lane of both waves

  // LDS-only K loop (iteration 8): every 32-K step wave w reads the A
  // fragment from the staged A mirror at row stride kStageARowStride and its
  // own B half from the staged B strip at the 36-B row pitch
  // kStageBRowStride (byte column b_col; iteration 21 bank skew)
  // -- the same fragment bytes the iteration-7 loads produced, with no
  // global round trip and no vmcnt wait on the MMA path -- then issues ONE
  // du_mma on its private accumulator.  The two resident wavefronts carry
  // independent 8-step chains, so a SIMD holding both can issue one wave's
  // instructions while the other stalls on its s_waitcnt lgkmcnt / du_mma
  // dependency (per-SIMD latency exposure was the iteration-7 wall).
  const int b_col = w * kDummaN;  // byte offset of this wave's n16 tile

  // Iteration 18 (compile-time 8-step K-loop specialization): the guard
  // launch is the ONLY call site of this kernel and always runs the uniform
  // 8-step slice (k == 4096, gridDim.y == 16 -> my_steps == 8 ==
  // kStageMaxSteps, rows == 256 == kStageMaxRows, staged capacity exactly
  // filled).  The runtime-bounded generic loop below compiles to a ROLLED
  // body (verified in the exact-source code object: one static v_mmac per
  // step with per-step ds_read2_b32 + 8 x ds_read_u8 + ~25-VALU byte
  // reassembly + 4 lgkmcnt drains on the accumulator chain and a
  // loop-carried WAR on the single fragment set), so every step's full LDS
  // latency sits serially on the MMA path with only 2 resident waves/SIMD
  // to cover it (PMC of the exact object: lds_instructions 107,520,
  // lds_wait_instructions 19,597).  Making the guard trip count
  // compile-time 8 lets the backend fully unroll the chain, rename the
  // fragment registers per step and hoist later steps' LDS reads across the
  // current step's v_mmac (local exact-flag codegen check of this edit: 8
  // static v_mmac in the specialized path with the next steps' LDS reads
  // issued before the current v_mmac; vgpr 34 / private_segment 0 /
  // group_segment 14,592 B unchanged -> the 4-blocks/CU = 8-waves/CU
  // occupancy is preserved).  Both branches issue the identical
  // ascending-s du_mma sequence into the same accumulator over the same
  // staged byte mirrors, so every partial byte and every combine output
  // byte is bit-identical to iteration 16; the generic rolled loop stays
  // verbatim as the else path for any non-guard (my_steps != 8)
  // configuration.
  if (my_steps == kStageMaxSteps) {
#pragma unroll
    for (int s = 0; s < kStageMaxSteps; ++s) {
      du::dumma::du_load_matrix_sync(
          a_frag, stage_a + static_cast<int64_t>(s) * kDummaK,
          kStageARowStride);
      du::dumma::du_load_matrix_sync(
          b_frag,
          stage_b +
              static_cast<int64_t>(s) * kDummaK * kStageBRowStride + b_col,
          kStageBRowStride);
      du::dumma::du_mma_sync(acc_frag, a_frag, b_frag, acc_frag);
    }
  } else {
    for (int s = 0; s < my_steps; ++s) {
      du::dumma::du_load_matrix_sync(
          a_frag, stage_a + static_cast<int64_t>(s) * kDummaK,
          kStageARowStride);
      du::dumma::du_load_matrix_sync(
          b_frag,
          stage_b +
              static_cast<int64_t>(s) * kDummaK * kStageBRowStride + b_col,
          kStageBRowStride);
      du::dumma::du_mma_sync(acc_frag, a_frag, b_frag, acc_frag);
    }
  }

  // Epilogue (iteration 16, barrier-decoupled): each wave materializes its
  // own tile into its own LDS acc buffer (wave 0 -> acc_tile0, wave 1 ->
  // acc_tile1, 1,024 B each), then its 64 lanes read back that same buffer
  // and store the 256 int32 partials (4 stores per lane) to
  // plane[split][m][n0 + b_col + col].  acc_tile{w} is written and read ONLY
  // by wave w, and the two waves' plane stores touch disjoint 16-column
  // ranges, so nothing in the epilogue needs cross-wave convergence.  The
  // former epilogue __syncthreads() was a 128-thread cross-wave join whose
  // release was gated by the slower of the block's two waves on a kernel
  // that runs only 8 resident waves/CU (4 x 2-wave blocks) to hide the skew
  // -- the same join whose five-wave form measured ~3.15 us of pure cost
  // (iteration 13 23.764/24.086 -> iteration 15 20.613/20.641 us with the
  // join removed, exact correctness passing in both).  It is replaced by
  // __threadfence_block(), which only orders THIS wave's own outstanding LDS
  // writes (the du_store_matrix_sync ds_writes of its private acc tile)
  // before its read-back ds_reads and costs no cross-wave wait.  The staging
  // __syncthreads() above stays (wave 0 stages the A slice and wave 1 stages
  // the B strip; every wave reads bytes the other wave staged).  Every
  // partial byte, the k-ascending int32 order and every plane store address
  // are unchanged, so the output is bit-identical to iteration 9 and exact
  // correctness must pass with 0 mismatches.
  if (w == 0) {
    du::dumma::du_store_matrix_sync(acc_tile0, acc_frag, kDummaN,
                                    du::dumma::mem_row_major);
  } else {
    du::dumma::du_store_matrix_sync(acc_tile1, acc_frag, kDummaN,
                                    du::dumma::mem_row_major);
  }
  __threadfence_block();  // iteration 16: wave-local store->read ordering
                          // only; no cross-wave join (was __syncthreads())

  int32_t* plane = partials + static_cast<int64_t>(split) * kDummaM * n;
  const int32_t* tile = (w == 0) ? acc_tile0 : acc_tile1;
  const int out_col0 = n0 + b_col;
#pragma unroll
  for (int linear = lane; linear < kDummaM * kDummaN;
       linear += kDummaWaveSize) {
    const int row = linear / kDummaN;
    const int col = linear - row * kDummaN;
    plane[static_cast<int64_t>(row) * n + out_col0 + col] = tile[linear];
  }
}

// ---------------------------------------------------------------------------
// Split-K combine kernel (iteration 2, restructured in iteration 9, mapping
// v3 in iteration 25): sums the gridDim.y int32 partial planes ascending per
// output element (exact int32, no overflow, bit-identical to the scalar
// k-ascending dot), applies x_scale[row] * weight_scale[col] in the scalar
// float order and stores bf16 through f32_to_bf16_rne.  Iteration 9 added
// the guard specialization (split_count == 16): one output element per lane,
// all sixteen plane loads issued as INDEPENDENT reads into a 16-int register
// array (single vmcnt drain instead of a dependent load->wait->add chain of
// 16 DRAM round trips per element), then the ascending-s register sum and
// the scaled bf16 store.  Iteration 25 (this round) keeps that per-lane
// structure and changes ONLY the block-to-output mapping: every one-wave
// block owns ONE m-row x kDummaCombineColsPerBlock = 64 consecutive columns
// (guard grid = 20 x 16 = 320 one-wave blocks, same block count as
// iteration 9).  In the iteration-9/23 mappings each block covered 4 rows x
// 16/32 columns, so every per-plane wavefront load issued four 64/128-B runs
// at the 5,120-B m-row stride -- four different DRAM rows, i.e. up to four
// row activations per load instruction -- which is why widening the per-row
// run 64 -> 128 B in iteration 23 could not move the combine (it never
// reduced the rows-per-instruction scatter).  With ONE row per block every
// per-plane load instruction is 64 lanes x 4 B = 256 B CONTIGUOUS = four
// consecutive 64-B lines of one DRAM row (a single run: ~4x fewer DRAM row
// activations for the identical 1.31 MB byte stream, identical 64-B sectors,
// identical wavefront-load count).  The element set is unchanged, so every
// element's ascending-s int32 sum, the float scale order and every output
// bf16 word are bit-identical to the pre-iteration-25 combine; the generic
// loop below stays verbatim for every other call site / split count / grid
// shape.
// ---------------------------------------------------------------------------
__global__ void w8a8_dumma_m16_combine_kernel(
    const int32_t* __restrict__ partials,  // [split_count][16][n] int32
    const float* __restrict__ x_scale,     // [16]
    const float* __restrict__ w_scale,     // [n]
    uint16_t* __restrict__ out,            // [16, n] bf16 payload
    int n,
    int split_count) {
  const int lane = static_cast<int>(threadIdx.x);  // blockDim == 64
  const int n0 = static_cast<int>(blockIdx.x) * kDummaN;

  // ---------------------------------------------------------------------
  // Iteration 25 specialization (mapping v3; guard launch only:
  // split_count == 16 and gridDim.y == kDummaM == 16 -> blockIdx.x =
  // 64-column group in [0, 20), blockIdx.y = one m-row in [0, 16)).  Each
  // lane owns output element (row, col) with row = blockIdx.y and col =
  // blockIdx.x * 64 + lane: the sixteen independent 4-B plane reads (plane
  // stride kDummaM * n int32) batch into one vmcnt drain, and because the
  // 64 lanes of the block are 64 CONSECUTIVE columns of ONE row, every
  // per-plane wavefront load covers 256 contiguous bytes (4 consecutive
  // 64-B lines of one DRAM row) instead of four 5,120-B-strided runs; the
  // ascending-s register sum then reproduces the exact int32 sequence for
  // this element.
  // ---------------------------------------------------------------------
  if (split_count == kDummaCombineSplits && gridDim.y == kDummaM) {
    const int row = static_cast<int>(blockIdx.y);
    const int col =
        static_cast<int>(blockIdx.x) * kDummaCombineColsPerBlock + lane;
    const int64_t elem = static_cast<int64_t>(row) * n + col;
    int32_t v[kDummaCombineSplits];
#pragma unroll
    for (int s = 0; s < kDummaCombineSplits; ++s) {
      v[s] = partials[static_cast<int64_t>(s) * (kDummaM * n) + elem];
    }
    int32_t acc = 0;
#pragma unroll
    for (int s = 0; s < kDummaCombineSplits; ++s) {
      acc += v[s];  // ascending split order: identical int32 sum
    }
    const float scaled =
        static_cast<float>(acc) * x_scale[row] * w_scale[col];
    out[elem] = f32_to_bf16_rne(scaled);
    return;
  }

#pragma unroll
  for (int linear = lane; linear < kDummaM * kDummaN;
       linear += kDummaWaveSize) {
    const int row = linear / kDummaN;
    const int col = linear - row * kDummaN;
    const int out_col = n0 + col;
    int32_t acc = 0;
    for (int s = 0; s < split_count; ++s) {
      acc += partials[(static_cast<int64_t>(s) * kDummaM + row) * n +
                      out_col];
    }
    const float scaled =
        static_cast<float>(acc) * x_scale[row] * w_scale[out_col];
    out[static_cast<int64_t>(row) * n + out_col] = f32_to_bf16_rne(scaled);
  }
}

// ---------------------------------------------------------------------------
// Identity device-to-device packing (bootstrap): grid-stride byte copies on
// the caller stream.  Valid for every (K, N), including unmatched shapes.
// ---------------------------------------------------------------------------
__global__ void w8a8_identity_copy_i8_kernel(
    const int8_t* __restrict__ src,
    int8_t* __restrict__ dst,
    int64_t count) {
  const int64_t stride = static_cast<int64_t>(gridDim.x) * blockDim.x;
  for (int64_t i = static_cast<int64_t>(blockIdx.x) * blockDim.x +
                   static_cast<int64_t>(threadIdx.x);
       i < count; i += stride) {
    dst[i] = src[i];
  }
}

__global__ void w8a8_identity_copy_f32_kernel(
    const float* __restrict__ src,
    float* __restrict__ dst,
    int64_t count) {
  const int64_t stride = static_cast<int64_t>(gridDim.x) * blockDim.x;
  for (int64_t i = static_cast<int64_t>(blockIdx.x) * blockDim.x +
                   static_cast<int64_t>(threadIdx.x);
       i < count; i += stride) {
    dst[i] = src[i];
  }
}

// ---------------------------------------------------------------------------
// Host launcher consumed by csrc/bindings.cpp (gemm_out, timed region).
// The exact (16, 1280, 4096) guard dispatches the split-K DUMMA partial +
// combine kernels (two wavefronts per partial block since iteration 8);
// the scalar fallback below launches 128 threads per 128 outputs.
// ---------------------------------------------------------------------------
extern "C" void launch_w8a8_gemm(
    const int8_t* a,
    const int8_t* b,
    const float* x_scale,
    const float* weight_scale,
    void* out,
    void* workspace,
    int64_t workspace_bytes,
    int m,
    int n,
    int k,
    hipStream_t stream) {
  (void)workspace;
  (void)workspace_bytes;
  if (m <= 0 || n <= 0 || k <= 0 || a == nullptr || b == nullptr ||
      x_scale == nullptr || weight_scale == nullptr || out == nullptr) {
    return;
  }

  // ---------------------------------------------------------------------
  // Exact-shape DUMMA guard: hy3_tp8_qkv_proj_m16 (M=16, N=1280, K=4096).
  // Lineage: iteration 4 widened each one-wave block to TWO adjacent
  // 16-wide N tiles (32 columns) sharing one A-fragment load per 32-K step
  // at SPLIT_K=12 (grid 40 x 12 = 480 blocks = 4/CU over 120 CUs);
  // iteration 5 staged each block's 32-column B slice into LDS once and
  // read the B0/B1 fragments from LDS per step, A direct-global
  // (39.404/39.485 us official Graph median/P90, from 41.154/41.233).
  // Iteration 7: BOTH operands are staged per K slice -- the A fragment
  // also comes from LDS, so the K loop is global-load-free -- which forces
  // SPLIT_K=16: sixteen UNIFORM 8-step slices (128 == 16 x 8, rows
  // {256 x 16}, exact ascending cover of [0, 4096), every boundary a
  // DUMMA-k multiple), grid = 40 N groups x 16 = 640 one-wave blocks
  // (~5.33 waves/CU, 4 resident blocks/CU by LDS: 14,592 B/block ->
  // 65,536/14,592 = 4.4), each block writing exact int32 partial planes
  // (cols [n0, n0+16) and [n0+16, n0+32) of plane[split]), then one
  // UNCHANGED 80-block combine kernel (generic over split_count = 16) that
  // sums the planes ascending and emits the scaled bf16 output.  Staged
  // tiles are exact byte mirrors of the global operands, so fragment
  // bytes, K-slice bounds, the k-ascending int32 order and the partial
  // plane layout are unchanged: the combine+scale output is bit-identical
  // to iteration 5.
  // Iteration 8 (this round): occupancy/resource change only -- the same
  // 640-block SPLIT_K=16 geometry now runs TWO 64-lane wavefronts per block
  // (blockDim 128): wave w computes tile w (cols [n0+16w, n0+16w+16)) of
  // the block's 32-column strip with its own independent accumulator chain
  // over the shared slice.  LDS per block is UNCHANGED (14,592 B -> 4
  // resident blocks/CU), so co-residency rises from 4 to 8 resident waves
  // per CU = 2 per SIMD, hiding each wave's per-step LDS->MMA stall behind
  // the other wave.  Staging is partitioned across the two waves (wave 0 =
  // A slice, wave 1 = B strip; identical global bytes read exactly once).
  // The combine kernel, the 16-plane workspace need (1,310,720 B), the
  // k-ascending partial order and the bit-identical output are unchanged.
  // Both launches stay on the caller stream inside the timed API/Graph;
  // the combine cost is part of the operator wall.  Requires 16 int32
  // partial planes (1,310,720 B) of the caller's workspace -- the full
  // fixed 16-plane 1,310,720 B allocation for this shape; when the
  // workspace is missing/undersized the exact guard falls back to the
  // iteration-1 one-wave direct geometry (still no workspace).  Every
  // unmatched (m, n, k) -- including the paired M=2 API shapes with the
  // same (N, K) -- keeps reaching the scalar fallback below.
  // Iteration 9 (this round): combine-side restructure only.  PMC of the
  // accepted iteration-8 code object profiles the combine kernel at 16.960
  // us vs 19.361 us for the partial kernel (46.7% of the 36.321 us profiled
  // operator aggregate) with a 6.9% L2 hit rate and only 80 one-wave blocks,
  // so the guard now launches the SAME combine kernel on a 2-D grid (80
  // n-tiles x 4 four-row m-groups = 320 one-wave blocks) and the kernel's
  // split_count==16 specialization gives each lane one output element that
  // batches all sixteen plane reads into a register array before the
  // ascending sum.  Partials, output bytes, bit-exactness and the partial
  // kernel launch are unchanged.
  // ---------------------------------------------------------------------
  if (m == 16 && n == 1280 && k == 4096) {
    constexpr int kDummaThreads = 64;        // one wavefront (tile/combine)
    constexpr int kPartialThreads = 2 * kDummaThreads;  // 2 waves per block
    constexpr int kTilesPerWave = 2;   // two 16-wide N tiles per block (n32)
    constexpr int kSplitK = 16;        // 40 groups x 16 = 640 blocks, 4/CU
    const int ntiles = n / kDummaN;    // 1280 / 16 = 80 combine tiles
    const int ngroups = ntiles / kTilesPerWave;  // 80 / 2 = 40 n32 groups
    const int64_t kWorkspaceNeeded =
        static_cast<int64_t>(kSplitK) * kDummaM * n * sizeof(int32_t);
    auto* out_bf16 = reinterpret_cast<uint16_t*>(out);
    if (workspace != nullptr && workspace_bytes >= kWorkspaceNeeded) {
      auto* partials = reinterpret_cast<int32_t*>(workspace);
      hipLaunchKernelGGL(w8a8_dumma_m16_splitk_partial_kernel,
                         dim3(ngroups, kSplitK), dim3(kPartialThreads), 0,
                         stream, a, b, partials, n, k);
      // Iteration 25 (mapping v3): 2-D combine grid = 20 column-groups x 16
      // one-row blocks = 320 one-wave blocks (one output row x 64 consecutive
      // columns per block, one output element per lane, 16-deep independent
      // plane-load register batch in the kernel's split_count==16 path; every
      // per-plane wavefront load is one 256-B contiguous run of one DRAM row
      // instead of four 5,120-B-strided runs).
      hipLaunchKernelGGL(w8a8_dumma_m16_combine_kernel,
                         dim3(n / kDummaCombineColsPerBlock, kDummaM),
                         dim3(kDummaThreads), 0, stream,
                         partials, x_scale, weight_scale, out_bf16, n,
                         kSplitK);
    } else {
      // Workspace-less fallback: iteration-1 one-wave direct geometry.
      hipLaunchKernelGGL(w8a8_dumma_m16_tile_kernel,
                         dim3(ntiles), dim3(kDummaThreads), 0, stream,
                         a, b, x_scale, weight_scale, out_bf16, n, k);
    }
    return;
  }

  // ---------------------------------------------------------------------
  // Scalar generic fallback: every shape outside the exact guard above.
  // ---------------------------------------------------------------------

  constexpr int kBlockThreads = 128;  // multiple of the gfx928 wavefront 64
  const int total = m * n;
  const int grid = (total + kBlockThreads - 1) / kBlockThreads;
  auto* out_bf16 = reinterpret_cast<uint16_t*>(out);
  hipLaunchKernelGGL(w8a8_scalar_gemm_kernel,
                     dim3(grid), dim3(kBlockThreads), 0, stream,
                     a, b, x_scale, weight_scale, out_bf16, m, n, k);
}

// ---------------------------------------------------------------------------
// Host launcher for the optional out-of-timed-region weight packing.
// Bootstrap: identity device-to-device copy of the int8 [K, N] weight and
// the fp32 [N, 1] scales; valid for every (K, N), unmatched shapes included.
// ---------------------------------------------------------------------------
extern "C" void launch_pack_w8a8_weight(
    const int8_t* raw_weight,
    const float* weight_scale,
    int8_t* packed_weight,
    float* packed_weight_scale,
    int k,
    int n,
    hipStream_t stream) {
  constexpr int kPackBlockThreads = 256;

  const int64_t i8_count = static_cast<int64_t>(k) * n;
  if (i8_count > 0 && raw_weight != nullptr && packed_weight != nullptr) {
    const int i8_grid =
        static_cast<int>((i8_count + kPackBlockThreads - 1) /
                         kPackBlockThreads);
    hipLaunchKernelGGL(w8a8_identity_copy_i8_kernel,
                       dim3(i8_grid), dim3(kPackBlockThreads), 0, stream,
                       raw_weight, packed_weight, i8_count);
  }

  const int64_t f32_count = static_cast<int64_t>(n);
  if (f32_count > 0 && weight_scale != nullptr &&
      packed_weight_scale != nullptr) {
    const int f32_grid =
        static_cast<int>((f32_count + kPackBlockThreads - 1) /
                         kPackBlockThreads);
    hipLaunchKernelGGL(w8a8_identity_copy_f32_kernel,
                       dim3(f32_grid), dim3(kPackBlockThreads), 0, stream,
                       weight_scale, packed_weight_scale, f32_count);
  }
}
// @@end
