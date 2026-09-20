// @@variant shape=hy3_tp8_qkv_proj_m16 commit=a1271e87052a802cf1a620ad5f58ba9d526103cd added=2026-09-17
//   median_us=14.43 p90_us=14.44 speedup=5.183 baseline_us=74.78
//   source=hy3-tp8-m16-test9-16-619177f8
// Initial correctness-first INT8 W8A8 GEMM for gfx928 (K500SM_AI).
//
// Bootstrap strategy (iteration 0): one plain scalar kernel computes the
// complete int32 dot product for every output element. There is no DUMMA, no
// split-K, no LDS staging, no inline assembly, no software pipelining and no
// autotuning. The only goals are:
//   * compile fast and portably for gfx928,
//   * launch on PyTorch's current HIP stream with no host/device sync,
//   * be exact against bf16((A.float() @ B.float()) * x_scale * w_scale.T).
//
// Layout contract for this iteration (identity pack):
//   a            : int8 [M, K]  row-major  (x_q)
//   b            : int8 [K, N]  row-major  (packed_weight)
//   x_scale      : fp32 [M]
//   weight_scale : fp32 [N]
//   out          : bf16 [M, N]  row-major
//
// launch_pack_w8a8_weight is an identity device-to-device copy of both the
// int8 weight and the fp32 weight scale. Later Parallel explore rounds may
// change that packing and the matching GEMM interpretation.
//
// Iteration 1 established the minimal native gfx928 DUMMA INT8 m16n16k32
// tile: ONE 64-lane wavefront per block, one 16x16 output tile per block,
// grid = N/16 = 80 one-wave blocks, blockDim 64, A/B fragments loaded
// directly from row-major global at every 32-K step, explicit int32
// accumulation, and a single-wave LDS epilogue.  It reached 119.72 us
// (official best), well behind the 74.78 us Triton graph baseline.
//
// Iteration 2 (architecture: launch-geometry exploration).
// PMC/ISA evidence for that 80-block grid:
//   * grid_blocks = 80 for device_cu_count = 120 -> 40 CUs idle and at most
//     one resident wave per busy CU, far below the two-blocks-per-CU
//     latency-hiding target;
//   * the disassembled K-loop is a serial chain -- 16 x global_load_ubyte,
//     a run of s_waitcnt vmcnt(N...) drains, then exactly one v_mmac -- so
//     each wave stalls on global latency every 32-K step with no other wave
//     on the CU to cover it;
//   * counter-derived HBM bandwidth is ~45 GB/s, i.e. the device is nowhere
//     near memory-bandwidth bound: the kernel is latency/underfill bound.
// The N dimension only has N/16 = 80 tiles and M is already the full 16, so
// the single geometry that can raise independent block count is split-K.
// This round therefore keeps the complete one-wave / one-N-tile geometry
// (waves_per_block = 1, adjacent_n_tiles = 1, no cross-wave barrier, direct
// global fragment loads, one v_mmac per 32-K step) and adds a 3-way split of
// the 128 stage-aligned (k/32) K-steps:
//   * grid = (N/16) * 3 = 240 one-wave blocks for 120 CUs => exactly two
//     independent blocks per CU, the mandated latency-hiding target;
//   * split s owns stages [s*T/S, (s+1)*T/S) with T = k/32 = 128 and S = 3,
//     i.e. 42/43/43 stages of 32 K each -- every range stays 32-aligned, so
//     the stage-alignment constraint and the workspace constraint (S <= 16
//     planes) both hold;
//   * each block accumulates its K sub-range exactly in int32 and stores the
//     16x16 partial into plane s of the caller-provided workspace
//     (int32 [S][M][N]); a separate 128-thread combine kernel sums the S
//     int32 planes (exact, order-free integer addition), applies
//     static_cast<float>(acc) * x_scale[row] * weight_scale[col] in the same
//     order as the scalar fallback, and writes bf16 -- so the output stays
//     bit-identical while the combine is a cheap L2-resident second launch.
//
// Iteration 3 (architecture: split-K occupancy sweep).
// The iteration-2 falsifiable claim held: the 240 one-wave blocks (2 blocks
// per CU) cut the wall to 47.81 us median, 1.564x over the 74.78 us Triton
// Graph baseline, so the 80-block underfill was real.  The current-best
// PMC still reports grid_blocks = 240 for device_cu_count = 120 -- only TWO
// of the four SIMDs of every CU ever hold a resident wave -- and the
// counter-derived HBM rate is still just 123.8 GB/s, far below device
// bandwidth, so the kernel remains latency/occupancy bound rather than
// bandwidth bound.  The trusted CU-aligned probe set for this shape is
// {2,3,4,5,6,8,9,12}; with N/16 = 80 one-wave N tiles the grid is 80*S, so
// the CU-aligned splits are the multiples of 3 (80*S must be a multiple of
// 120).  split-K=2 yields only 160 blocks = 1.33 blocks/CU -- still below
// the mandated two-blocks-per-CU target -- so it is rejected, and the next
// CU-aligned candidate is split-K=6:
//   * grid = (N/16) * 6 = 480 one-wave blocks for 120 CUs => exactly FOUR
//     independent one-wave blocks per CU, i.e. one resident wave on each of
//     the four SIMDs, instead of 2 of 4 in iteration 2;
//   * the 128 32-aligned K-stages are partitioned 21/21/22/21/21/22 (rows
//     672/672/704/672/672/704) -- disjoint, ascending, exact cover of
//     [0, 4096), every boundary a multiple of 32 -- so the stage-alignment
//     and exact-int32 contracts are unchanged;
//   * workspace need = 6 * M * N * 4 = 491,520 B, inside the contract's
//     16-plane 1,310,720 B allocation; the partial kernel, its plane
//     indexing and the combine+scale kernel are already generic in split_k,
//     so the only source change is the launcher geometry constant
//     kSplitKTarget 3 -> 6 (the combine stays inside the timed Graph).
// Falsifiable claim: if the two idle SIMDs per CU are the limiter, the
// per-block serial 32-K chain halves (43 -> ~21 steps) while the number of
// resident waves doubles, so the official Graph median/P90 must drop
// materially below the 47.81/47.85 us iteration-2 best (expected ~34-40 us,
// with the extra 2 partial planes and the slightly longer combine cost
// included).  If it stays flat or regresses, the wall is the per-step
// load->wait->reassemble->mma latency or per-CU issue rather than SIMD
// occupancy, and the next round must attack the 16 direct global byte loads
// per stage instead of the split factor.
//
// Iteration 4 (accepted, architecture/pipeline: multi-N-tile reuse).
// The iteration-3 result falsified its own prediction: moving kSplitKTarget
// 3 -> 6 cut the wall only 47.81 -> 45.08 us (-5.7%) instead of the
// predicted ~34-40 us, so doubling the resident one-wave blocks per CU did
// NOT remove the limiter.  The reason is an invariance the split factor
// cannot break: the total m16n16k32 mma count is fixed at (N/16)*(K/32) =
// 80*128 = 10,240, so per device SIMD (480 of them) the number of serial
// load->wait->reassemble->mma steps is 10,240/480 = 21.3 for ANY split
// factor -- finer splits only shorten each block while multiplying the
// block count by the same amount.  The measured PMC still shows the poison
// per-step pattern: 16 global_load_ubyte (8 for the A fragment + 8 for the
// single B fragment) followed by a ladder of scattered s_waitcnt vmcnt and
// exactly ONE v_mmac per 32-K step, with no cross-iteration load overlap.
// This round therefore keeps the split-K partial+combine architecture and
// the 480-block / 4-blocks-per-CU co-residency but widens every one-wave
// block to TWO adjacent 16-wide N tiles (32 N columns):
//   * per 32-K step the wave loads the A fragment (16 m-rows x 32 K bytes =
//     512 B of x_q) EXACTLY ONCE and issues TWO independent du_mma_sync
//     calls -- one per 16-wide N tile -- so those A bytes are REUSED across
//     both output tiles (the per-output-tile A global loads and their
//     wait/reassembly cost halve);
//   * every B byte (k x 32 N bytes per block slice) is still read exactly
//     once -- B has no reuse (each N column belongs to exactly one block);
//   * the 128 32-aligned K stages are split 12 ways and each block owns TWO
//     output tiles, so the grid is (N/(16*2)) * 12 = 40 * 12 = 480 one-wave
//     blocks for 120 CUs = exactly 4 blocks/CU, i.e. one resident wave per
//     SIMD, identical co-residency to iteration 3 (enough blocks to cover
//     every CU);
//   * each block's serial chain drops from ~21 single-mma steps to <= 11
//     two-mma steps (the 128 stages partition 8 x 11 + 4 x 10 = rows
//     352 x 8 + 320 x 4, disjoint, ascending, exact 32-aligned cover of
//     [0, 4096)), so if the wall is the per-step global latency then the
//     latency paid per m16n16k32 mma is halved;
//   * workspace need = 12 * M * N * 4 = 983,040 B, inside the contract's
//     16-plane 1,310,720 B allocation; the partial kernel body, its plane
//     indexing and the combine+scale kernel stay generic in split_k (the
//     runtime clamp still shrinks split_k to the supplied workspace), and
//     the combine stays inside the timed Graph.
// Falsifiable claim: if the per-step direct-global load->wait->mma latency
// is the limiter, the per-output A-load cost halves and the serial chain
// per block halves, so the official Graph median/P90 must drop materially
// below the 45.08/45.17 us iteration-3 best (expected ~33-39 us, with the
// six extra partial planes and the longer 12-way combine included).  If it
// stays flat or regresses, the limiter is L2/HBM-side byte traffic or the
// per-step issue of the byte-granular loads themselves rather than latency
// amortization, and the next round must stage the operands in LDS.
//
// Iteration 5 (measured and NOT accepted: B-only LDS staging).
// Staging only the B operand into a per-block LDS mirror (16-B int4
// cooperative copy + one same-wave barrier, then du_load_matrix_sync from LDS
// at row stride 32) left the loop time unchanged and paid the serial staging
// prologue on top: the official Graph median/P90 moved 30.374/30.420 ->
// 31.309/31.350 us (+3.1%), so the round was rejected and the source was
// reverted to the iteration-4 best recorded here.  The falsification is
// informative: removing two thirds of the per-step global byte loads (the 16
// B loads of the 24) did NOT shorten the per-step chain, so the residual
// serialized operand fetch on the MMA critical path is the A half, and the
// B-only design additionally left a mixed dual-latency step (LDS B + global
// A) whose LDS reads replay the same bank 4x at the iteration-5 row pitch.
//
// Iteration 6 (pipeline round, this round): A+B whole-slice LDS staging.
// Mandated staging-family decision, made from the L2/VMEM evidence:
//   * VMEM: the exact-source PMC of the iteration-4 code object (digest
//     d5784ae4...) shows the rolled K loop issuing 24 byte-granular
//     global_load_ubyte per 32-K step (vmem_read 122,880 = 24 x 5,120
//     block-steps) behind an 18-entry scattered s_waitcnt vmcnt ladder, all
//     on the MMA path with no cross-iteration load overlap.
//   * L2: the same replay reports 61.237% L2 hits, and the per-kernel TCC/EA
//     traffic ledger shows the partial kernel reading only 5,359,488 B while
//     its load instructions request ~7.9 MB (A 2.62 MB + B 5.24 MB).  The
//     40x-reused x_q A operand is therefore ~95% L2-resident (A HBM misses
//     ~= 5,359,488 - 5,242,880 = 116,608 B) and the streaming B operand is
//     the compulsory HBM traffic read exactly once.  No staging family can
//     change the HBM byte count: direct, A-only, B-only and A+B all fetch the
//     same 5,242,880 B of B and the same ~116,608 B of A misses.  The choice
//     is therefore only about WHERE the operand fetch latency sits.
//   * B-only was already measured (iteration 5) and regressed, so between the
//     remaining families the evidence selects A+B: it is the ONLY one that
//     removes the A-side global wait (which the B-only result proves is the
//     serialization point) AND the B-side ladder at the same time, replacing
//     both with one batched cooperative prologue of 16-B loads.
// Design (one-wave geometry, blockDim 64, unchanged):
//   * Each 64-lane block stages BOTH operands of its whole K slice once:
//     stage_a = the 16 m-rows x 256 slice bytes of x_q at row stride 272
//     (256 data + 16 pad for bank skew, 4,352 B) and stage_b = the
//     256 k-rows x 32 B B-strip at row stride 36 (32 data + 4 pad, 9,216 B).
//     Both are EXACT byte mirrors of the global regions the direct loader
//     read, filled by 16-B int4 cooperative copies (A: rows/16 = 16 chunks
//     per m-row -> 256 chunks / 64 lanes = 4 chunks per lane, one 4-deep
//     batched group; B: 2 chunks per k-row -> 512 chunks / 64 lanes = 8
//     chunks per lane, two 4-deep batched groups), one same-wave
//     __syncthreads(), and then a K loop with ZERO per-step global loads and
//     ZERO vmcnt waits: A from LDS at stride 272, B0/B1 from LDS at stride 36.
//   * Pad choice is deliberate: the row_major B fragment loader reads each
//     lane's bytes at (8*(lane>>4) + i)*ldm, so a 32-B ldm puts the four lane
//     groups 256 B (== 0 mod 128) apart and replays one LDS bank 4x, while
//     36 B puts them 288 B (== 32 mod 128) apart -> banks b, b+8, b+16, b+24;
//     the A pad 272 B (== 16 mod 128) likewise skews its 16 row reads.  The
//     pads are never written and never read.
//   * Geometry moves 12 -> 16 splits because a whole-slice A stage does not
//     fit at split 12 with 4 resident blocks/CU (A 16x368 + B 352x36 + 2,048
//     = 20,608 B -> floor(65,536/20,608) = 3 resident waves/CU, below the
//     measured 4).  At S = 16 the slices are uniform 8 x 32 stages = 256 rows
//     (128 == 16*8), per-block LDS is 4,352 + 9,216 + 2,048 = 15,616 B ->
//     floor(65,536/15,616) = 4 resident blocks/CU (62,464 B <= 65,536), and
//     the grid is (N/32) x 16 = 40 x 16 = 640 one-wave blocks = 5.33/CU over
//     120 CUs, i.e. the measured 4-blocks/CU co-residency is preserved.
//     The workspace need is 16 int32 planes = 1,310,720 B = the caller's full
//     fixed allocation for this shape (the existing clamp still shrinks
//     split_k for any smaller buffer, and a slice larger than the staging
//     capacity keeps the byte-for-byte direct-global loop below).
//   * Every partial is still an exact int32 ascending 32-aligned sub-sum over
//     the SAME fragment bytes (the staged mirrors are exact copies), the
//     combine kernel is unchanged, and no cross-wave synchronization or
//     cross-block state is introduced.
// Byte ledger: HBM read/write bytes UNCHANGED (B 5,242,880 B read once + A
// misses ~116,608 B + 1,310,720 B of partial planes written/read); LDS added
// per block = 4,352 (stage_a) + 9,216 (stage_b) = 13,568 B written and
// re-read 8 times as fragments (8 x 1,536 B = 12,288 B), with the bank-skew
// pads chosen so the fragment reads are conflict-free.
// Falsifiable claim: if the per-step serialized operand fetch (not the
// compulsory HBM bytes) is the wall, the LDS-only K loop plus the batched
// 16-B staging prologue must drop the official Graph median/P90 materially
// below 30.374/30.420 us (expected ~21-27 us, combine's +4 planes included).
// If it instead stays flat or regresses, the wall at 4 waves/CU is the
// DRAM/LDS service rate or per-CU issue rather than the per-step wait ladder,
// and the next round must attack the operand stream's DRAM granularity (a
// packed [N/32][K][32] weight layout) rather than the staging family.
//
// Iteration 7 (measured and NOT accepted: depth-1 register double buffering).
// Giving the rolled LDS-only K loop two fragment register sets moved the
// official Graph median 21.412 -> 20.938 us but the P90 21.427 -> 25.333 us
// (+18%, max 26.557), so the round was rejected on the tail and the source was
// reverted to the iteration-6 best recorded here.  The lesson: at ONE resident
// wave per SIMD there is no sibling wave to absorb the tail, so the fix must
// add wave-level parallelism rather than reorder a single wave's own chain.
//
// Iteration 8 (occupancy/resource round, this round): raise the waves-per-block
// occupancy limiter from 1 to 2.  The exact-source PMC of the accepted
// iteration-6 code object (digest 4fe713e6..., grid 640 = 40 N groups x 16
// splits, workgroup 64, arch_vgpr 80, sgpr 64, scratch 0, LDS 15,616 B/block
// -> floor(65,536/15,616) = 4 resident blocks/CU, i.e. exactly ONE resident
// wave per SIMD) shows the residual wall is per-SIMD single-wave latency
// exposure, not issue or HBM traffic: every per-step s_waitcnt lgkmcnt after
// the staged-fragment du_load_matrix_sync and every du_mma accumulator
// dependency stalls that SIMD with no second independent wave to issue
// (lds_wait_instructions 11,842, lds_bank_conflicts 133,120, vmem_read 7,680 =
// only the one-time staging loads).  This round makes each block TWO 64-lane
// wavefronts (blockDim 64 -> 128, __launch_bounds__(128)) and splits the block
// by ownership: wave w computes ONLY n-tile w (cols [n0+16w, n0+16w+16)) over
// the shared 8-step slice with its own independent m16n16k32 accumulator chain,
// one du_mma per step per wave (same total MMA count).  LDS per block is
// UNCHANGED (stage_a 4,352 + stage_b 9,216 + 2 x 1,024 acc tiles = 15,616 B),
// so 4 resident blocks/CU still fit but now carry 8 resident waves/CU = 2 per
// SIMD: one wave's LDS->MMA stall is covered by its co-resident sibling.  The
// one-time staging is PARTITIONED, not duplicated: wave 0 copies the shared A
// slice, wave 1 copies the B strip (the iteration-6 cooperative loops
// unchanged), so exactly the same global bytes are read once per block -- no
// repeated HBM reads are traded for occupancy -- and the staging barrier
// becomes a cross-wave __syncthreads().  The only deliberately added cost is
// LDS re-reads: the shared A fragment is now loaded from the staged mirror by
// both waves (LDS bandwidth is not the wall at this issue utilization).  Every
// partial int32 is the identical ascending sum over the identical staged bytes
// for its own 16-column tile, so the output stays bit-identical and the combine
// kernel, the 16-plane workspace contract, the exact (m,n,k) == (16,1280,4096)
// guard, the workspace-less direct-global path and the scalar fallback for
// every unmatched shape (paired M=2 included) are all unchanged.
// Falsifiable claim: if the per-SIMD single-wave latency exposure is the wall,
// the official Graph median/P90 must drop below 21.411954/21.427149 us
// (expected ~19.5-20.9 us median) with mismatch_count 0; if it stays flat or
// regresses, the wall at 8 waves/CU is the LDS service rate or per-CU issue
// rather than wave-level coverage.
//
// Iteration 9 (combine-restructure round, this round): attack the OTHER timed
// dispatch of the operator -- the split-K combine.  Every previous round
// optimized only the 640-block partial kernel, but the operator replay runs
// TWO kernels on the same stream and the combine is a real part of the wall:
// its exact-source PMC (source digest e2a23702..., 160 x 128-thread
// one-element-per-thread blocks) profiles at 3.52 us against 19.52 us for the
// partial kernel, and the static code object's rolled plane loop is a
// DEPENDENT load -> s_waitcnt vmcnt -> int32 add chain of 16 DRAM round trips
// per output element (one 4-B global load per plane iteration) with only 160
// blocks (~1.33 warps/SIMD) to hide it.  This round restructures ONLY the
// combine kernel and its launch:
//   * the guard launcher switches the combine from 160 linear 128-thread
//     blocks to a 2-D grid of (n / 64) column groups x m rows = 20 x 16 = 320
//     ONE-wave 64-lane blocks, and the kernel's split_k == 16 specialization
//     gives every lane exactly ONE output element (row = blockIdx.y,
//     col = blockIdx.x * 64 + lane): all sixteen plane loads are issued as
//     INDEPENDENT reads into a 16-int register array (one vmcnt drain,
//     16-way memory-level parallelism per lane) and only then summed in the
//     unchanged ascending split order s = 0..15;
//   * each per-plane wavefront load now reads 64 lanes x 4 B = 256 B
//     CONTIGUOUS (four consecutive 64-B lines of one m-row) instead of four
//     runs at the 5,120-B m-row stride.
// The partial kernel, the 640-block / 16-split geometry, the staged byte
// mirrors, the k-ascending int32 partials, the 16-plane 1,310,720 B workspace
// contract, the workspace-less fallback and the scalar fallback are
// byte-for-byte unchanged.  Integer addition is exact and order-free
// (|acc| <= K*127*127 ~= 6.6e7 << 2^31), the fp32 scale order and the bf16
// conversion are element-for-element identical, so every output byte is
// bit-identical.  A clamped split_k < 16 still takes the unchanged generic
// combine path with its original 128-thread launch, so an undersized
// workspace cannot change behavior.
// Falsifiable claim: if the combine's per-element dependent plane-load chain
// (and its underfilled 160-block grid) is a material part of the 19.51 us
// operator wall, the official Graph median/P90 must drop materially below
// 19.510394/19.535989 us (expected ~17.3-18.9 us); if it stays flat, the
// combine was already fully hidden behind the partial kernel's drain and the
// remaining wall is entirely partial-kernel side.
//
// Iteration 11 (DS-side staging-latency round, this round): shorten the
// one-time staging join of the accepted iteration-9/10 partial kernel.  The
// exact-source PMC of that object (source digest bd963ec6..., grid 640 = 40 N
// groups x 16 splits, workgroup 128, LDS 15,616 B, arch_vgpr 80, scratch 0,
// profiled 20.159 us) shows the kernel is deeply latency-bound, not
// issue/bandwidth-bound: only 486,400 VALU + 112,640 LDS wave-instructions for
// 1,280 resident wavefronts x 8 K-steps, while vmem_read_instructions is just
// 7,680 (= the one-time staging loads, 12 int4 loads per block) and the
// block's critical path therefore still contains the operand staging prologue.
// The staging is PARTITIONED (wave 0 copies the 4-chunk-per-lane A slice,
// wave 1 copies the 8-chunk-per-lane B strip) and the cross-wave
// __syncthreads() joins both, so the join costs the SLOWER wave.  Wave 0
// already issues its whole A copy as one 4-deep batch, but wave 1's 512-chunk
// B strip (rows*2 = 256*2 = 512 chunks == 8 x 64 lanes) is emitted as two
// serialized 4-deep iterations: iteration k+1's four 16-B global loads cannot
// issue until iteration k's four dependent LDS stores have consumed their
// registers, so every block pays TWO dependent global round trips on the
// staging join instead of one.  Change (one focused HIP edit,
// csrc/w8a8_gemm_hip.hip only): when the B strip is exactly the guard's
// 8-chunk-per-lane shape (b_chunks == 8 * kDummaWaveSize == 512, which the
// exact (m,n,k) == (16,1280,4096) guard always produces because rows ==
// kStageMaxRows == 256), wave 1 now runs ONE straight-line 8-deep batched
// group: all eight 16-B source loads are issued before the first LDS store,
// so a single vmcnt drain covers the whole strip and the second global round
// trip leaves every block's staging join.  The generic rolled 4-deep loop
// stays verbatim as the else path for any non-guard chunk count.  The staged
// bytes, their LDS addresses (the same 36-B row pitch and store decomposition)
// and therefore every fragment byte, every k-ascending int32 partial and the
// combine output stay bit-identical; the 16-plane 1,310,720 B workspace
// contract, the workspace-less direct-global fallback, the exact shape guard,
// the scalar fallback for every unmatched shape (paired M=2 included), the
// combine kernel and its 320-block one-row-per-block launch, the pack identity
// and every stream/Graph property are unchanged.
// Falsifiable claim: if the block's staging join is a material part of the
// 18.980 us wall, removing the second global round trip from wave 1's B copy
// must move the official Graph median/P90 below 18.980430/19.183630 us
// (expected ~18.3-18.9 us median) with mismatch_count 0; if it stays flat or
// regresses, the staging join is already fully covered by the co-resident
// blocks and the residual wall is the LDS-only K loop.
//
// Iteration 13 (HIP-only consolidation round, this round): halve the split-K
// partial-plane round trip, the only non-compulsory component of the
// operator's memory traffic.  The exact-source PMC of the accepted iteration-11
// object (source digest 210fbfcfde28bc26d9c1c93a8a5f91353db51c5426853e85b5701dd44fa81fa8,
// primary kernel 640 blocks x 128 threads, LDS 15,616 B, arch_vgpr 80, sgpr 48,
// scratch 0, profiled 20.0 us; combine 320 one-wave blocks, profiled 2.72 us;
// official unprofiled Graph median/P90 18.145450/18.166250 us) reports, per
// operator replay, 6,716,736 B read + 1,351,680 B written = 8,068,416 B, and
// the memory_traffic ledger splits it into 5,368,320 B for the partial kernel
// (B 5,242,880 compulsory + A + the 1,310,720 B of int32 partial planes it
// writes) and 1,348,416 B read + 40,960 B written for the combine (the same
// 1,310,720 B of planes re-read).  The combine's own L2 hit rate is just
// 6.849% (l2_hits 1,597 / l2_misses 21,721) against the partial kernel's
// 54.392%, i.e. the 16 int32 planes are written through L2, evicted by the
// streaming B strip, and pulled back from DRAM by the immediately following
// combine: 2,621,440 B of the 8,068,416 B total (32.5%) is pure split-K
// bookkeeping against a compulsory A 65,536 B + B 5,242,880 B + out 40,960 B
// = 5,349,376 B.  Change (one focused HIP edit, csrc/w8a8_gemm_hip.hip only):
// move kSplitKTarget 16 -> 8 so the split-K bookkeeping halves to 8 planes
// (655,360 B written + 655,360 B re-read), removing 1,310,720 B (16.2%) of the
// per-replay traffic.
//   * Geometry: grid = (N/(16*T)) * 8 = 40 * 8 = 320 blocks of 128 threads;
//     the 128 32-K stages partition into uniform 16-stage (512-row) slices
//     (128 == 8 x 16), every boundary still a multiple of 32, so the
//     stage-alignment and exact-int32 contracts are unchanged.  The workspace
//     need is 8 x 80 KiB = 655,360 B, well inside the contract's fixed
//     1,310,720 B / 16-plane allocation, and the existing clamp still shrinks
//     split_k for a smaller buffer.
//   * Staging: a 512-row slice is twice the unchanged 256-row staging
//     capacity, so the kernel now stages and consumes its slice in ascending
//     256-row PHASES (exactly two at the guard).  Each phase is byte-for-byte
//     the accepted iteration-11 geometry: wave 0 stages the 256-chunk A phase
//     as one 4-deep batch and wave 1 stages the 512-chunk B strip as ONE
//     straight-line 8-deep batch behind a single vmcnt drain, then the phase's
//     8 K-steps accumulate into the SAME acc_frag in ascending k order, and an
//     end-of-phase __syncthreads() releases the LDS for the next phase.  The
//     staged bytes, their bank-skewed LDS addresses, the 36-B B row pitch, the
//     8-deep batch and therefore every fragment byte are unchanged, so every
//     k-ascending int32 partial and the combine output stay bit-identical.
//   * LDS per block is unchanged at 15,616 B (stage_a 4,352 + stage_b 9,216 +
//     2 x 1,024 acc tiles), so four resident blocks/CU still fit by capacity
//     (2 waves/block = 8 waves/CU = 2 per SIMD by capacity); the 320-block
//     grid is a single resident generation.
//   * The combine guard split and its 2-D one-wave launch move to
//     kCombineSplits = 8 (the same 20 x 16 = 320 one-wave blocks, eight
//     independent plane loads per lane in registers); a clamped split_k < 8
//     keeps the unchanged generic 128-thread combine path.
// The exact shape guard, the workspace-less fall-through, the scalar fallback
// for every unmatched shape (paired M=2 included), the pack identity, the
// stream/Graph contract and every fallback path are unchanged; no raw inline
// asm and no ISA skill is used (phase hip_only, plateau false,
// raw_inline_asm_allowed false, skill_allowed false).
// Falsifiable claim: if the 2,621,440 B split-K plane round trip is a material
// part of the 18.145 us wall, halving it must move the official Graph
// median/P90 below 18.145450/18.166250 us (expected ~16.5-17.5 us median,
// ~4-9% faster, from the 1,310,720 B traffic reduction minus the reduced grid
// parallelism) with mismatch_count 0 and unchanged Graph capture; if it stays
// flat or regresses, the plane traffic was hidden behind the operand stream
// and the residual wall is the compulsory 5.35 MB operand/out stream.
//
// The scalar kernel below stays byte-for-byte as the generic fallback for
// every unmatched shape, including the paired M=2 API shape with the same
// (N, K); the (m, n, k) == (16, 1280, 4096) guard is the only call site of
// the split-K DUMMA path, and if the caller supplies no usable workspace the
// exact shape safely falls through to that scalar fallback.
//
// Iteration 17 (HIP-only consolidation round, this round): complete the B
// memory path by packing the cold once-read weight into the col_major
// fragment layout, the lineage rule that the sibling TP4/TP8 M=16 shapes
// validated ("one ds_read_b64 per step, was 8 ds_read_u8").  Evidence for the
// accepted iteration-13 object (source digest 920506893c362e1bcefa5c36ffb0776fbfee00a9dd004943b66fc55d386ae572,
// primary kernel 320 blocks x 128 threads, LDS 15,616 B, arch_vgpr 80, sgpr 48,
// scratch 0, profiled 18.24 us; combine 320 one-wave blocks, profiled 2.72 us;
// official unprofiled Graph median/P90 16.614190340042114/16.642990112304688
// us): the exact-source code object's rolled LDS-only K loop issues ONE
// ds_read2_b32 for the A fragment, but EIGHT scatter ds_read_u8 per lane for
// the B fragment (immediates i*36 on the k-major 36-B row pitch) plus the
// byte-mask/shift/OR reassembly that packs those eight bytes into the v_mmac
// operand -- ~10 of the ~11 LDS wave-instructions and ~2/3 of the ~41 VALU
// wave-instructions per wave-step, with lds_wait_instructions 15,137 and
// lds_bank_conflicts 117,760 against lds_instructions 108,800.  The B
// fragment's 8 bytes per lane are contiguous in memory if and only if the
// staged B tile is n-major, because the library col_major matrix_b loader
// reads p[(lane&15)*ldm + 8*(lane>>4) + i].  Change (one focused HIP edit,
// csrc/w8a8_gemm_hip.hip only):
//   * for the exact (K, N) == (4096, 1280) weight pair, launch_pack_w8a8_weight
//     now writes the n-major transpose packed[n*K + k] = raw[k*N + n] instead
//     of the identity copy (same buffer, same k*n bytes, outside the timed
//     region/Graph; the packed layout is opaque per the API contract).  Every
//     other (K, N) keeps the identity copy.
//   * the guard kernel stages its 32-column B strip n-major:
//     stage_b[n * kStageBColStride + k] = packed[n0 + n][phase_begin + k] at
//     the 16-B-aligned 272-B column stride, so each 16-B cooperative chunk is
//     one ds_write_b128 and each column's phase is one contiguous run.
//   * the B fragment is declared col_major and loaded from the n-major mirror
//     (ldm = 272), so the K loop's B fragment becomes ONE contiguous 8-byte
//     LDS read per step.
//   * the scalar fallback (paired M=2 and every unmatched shape) and the
//     DUMMA kernel's direct-global safety net decode the same permutation for
//     this (K, N); all other shapes are untouched.
// The same logical (k, n) element lands in the same v_mmac fragment register,
// every staged byte is a copy of the same packed byte, and the k-ascending
// int32 accumulation is unchanged, so every partial and every output byte stay
// bit-identical; LDS per block drops 15,616 -> 15,104 B (still 4 resident
// blocks/CU), and the grid, plane geometry, combine kernel, workspace
// contract, stream/Graph properties and fallbacks are unchanged.  No raw
// inline asm and no ISA skill is used (phase hip_only, plateau false,
// raw_inline_asm_allowed false, skill_allowed false).
// Falsifiable claim: if the B fragment's 8-scatter-byte LDS read plus its
// reassembly VALU is a material part of the 16.614 us wall, replacing it with
// one 8-byte LDS read (and ~4x fewer LDS wave-instructions) must move the
// official Graph median/P90 below 16.614190/16.642990 us (expected
// ~15.9-16.3 us median, 2-4% faster) with mismatch_count 0 and unchanged
// Graph capture; if it stays flat or regresses, the LDS instruction count is
// not the wall and the residual wall is the compulsory operand byte stream.

#include <hip/hip_runtime.h>
#include <hip/hip_bfloat16.h>
#include <du_mma.h>

#include <cstdint>

namespace {

// 128 threads = 2 waves of the native gfx928 64-lane wavefront, and a
// multiple of 64 as required by this DTK.
constexpr int kBlockThreads = 128;

// Iteration 17: the exact-guard weight pair (K, N) == (4096, 1280) whose
// packed weight buffer is the n-major transpose packed[n*K + k] =
// raw[k*N + n] instead of the identity copy.  launch_pack_w8a8_weight writes
// that permutation (outside the timed region / Graph), the split-K DUMMA
// kernel consumes it through its n-major LDS stage with the library col_major
// matrix_b fragment loader, and every other consumer of the packed weight
// (the scalar fallback that serves the paired M=2 shape and every unmatched
// (m, n, k), plus the DUMMA kernel's direct-global safety net) decodes the
// same permutation.  Every other (K, N) keeps the byte-for-byte identity pack.
constexpr int kGuardK = 4096;
constexpr int kGuardN = 1280;

// One thread -> one output element. Consecutive threads stay adjacent in N,
// the fastest-changing dimension, so weight loads are coalesced.
__global__ __launch_bounds__(kBlockThreads) void w8a8_scalar_kernel(
    const int8_t* __restrict__ a,
    const int8_t* __restrict__ b,
    const float* __restrict__ x_scale,
    const float* __restrict__ weight_scale,
    __hip_bfloat16* __restrict__ out,
    int m,
    int n,
    int k) {
  const int64_t total =
      static_cast<int64_t>(m) * static_cast<int64_t>(n);
  const int64_t idx =
      static_cast<int64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
  if (idx >= total) {
    return;
  }

  const int row = static_cast<int>(idx / n);
  const int col = static_cast<int>(idx - static_cast<int64_t>(row) * n);

  const int8_t* a_ptr = a + static_cast<int64_t>(row) * k;
  int32_t acc = 0;
  if (k == kGuardK && n == kGuardN) {
    // Iteration 17: the exact-guard weight buffer holds the n-major
    // transpose packed[n*K + k] = raw[k*N + n] (a pure byte permutation),
    // so the fallback decodes that layout here.  The k-ascending int32 sum
    // and therefore every output byte are unchanged.
    const int8_t* b_col = b + static_cast<int64_t>(col) * k;
    for (int kk = 0; kk < k; ++kk) {
      acc += static_cast<int32_t>(a_ptr[kk]) *
             static_cast<int32_t>(b_col[kk]);
    }
  } else {
    const int8_t* b_ptr = b + col;
    for (int kk = 0; kk < k; ++kk) {
      acc += static_cast<int32_t>(a_ptr[kk]) * static_cast<int32_t>(*b_ptr);
      b_ptr += n;
    }
  }

  // Integer dot stays exact in int32; the two fp32 scales are applied once at
  // the very end and the result is stored as bf16.
  const float scaled = static_cast<float>(acc) * x_scale[row] *
                       weight_scale[col];
  out[idx] = __float2bfloat16(scaled);
}

// ---------------------------------------------------------------------------
// Exact-guard DUMMA split-K path for hy3_tp8_qkv_proj_m16
// (M=16, N=1280, K=4096).
//
// Minimal native gfx928 INT8 tile: DUFragment<matrix_a/matrix_b, 16,16,32,
// signed char, row_major> fragments with a DUFragment<accumulator,16,16,32,
// int> accumulator, one 64-lane wavefront per N tile (two wavefronts per block
// since iteration 8).  Iteration 4 gives every block kTilesPerWave = 2
// adjacent 16x16 output tiles, and the 128 stage-aligned (k/32) K-steps are
// split kSplitKTarget ways so that the grid becomes (N/(16*T))*S blocks
// instead of N/16.  Every K step is an explicit int32 du_mma_sync over a
// 32-aligned ascending k chunk, so each partial is an exact int32 sub-sum and
// the combine below is bit-identical to the scalar kernel's total (exact
// integer addition, order-free; |total| <= K*127*127 ~= 6.6e7 << 2^31).
//
// Iteration 6 adds whole-slice A+B LDS staging: each block first mirrors its
// whole A slice and its whole 32-column B strip into LDS with 16-B cooperative
// copies (exact byte mirrors, bank-skewed row pitches), and the K loop then
// reads every fragment from LDS with no global load and no vmcnt wait on the
// MMA path.  See the staging block below for the capacity, bank-skew and
// bit-exactness arguments.
//
// Iteration 8 raises waves-per-block from 1 to 2: wave w owns N tile w of the
// block's 32 columns and runs its own independent accumulator chain, the
// one-time staging is partitioned across the two waves (no operand byte is
// fetched twice), and LDS per block is unchanged, so 4 resident blocks/CU
// become 8 resident waves/CU = 2 per SIMD.
//
// The gfx928 int8 m16n16k32 accelerator fragment ownership is opaque, so the
// epilogue materializes each tile with du_store_matrix_sync into a per-wave
// LDS staging array (16x16 int32 = 1,024 B each, library-defined mem_row_major
// placement) and from there stores the raw int32 partials into plane `split`
// of the caller workspace.  blockDim is two wavefronts, so the staging
// __syncthreads() is a genuine cross-wave barrier inside one block (wave 0's A
// slice is read by wave 1 and vice versa for the B strip); there is no
// cross-block synchronization anywhere.
// ---------------------------------------------------------------------------
constexpr int kDummaM = 16;
constexpr int kDummaN = 16;
constexpr int kDummaK = 32;
constexpr int kDummaWaveSize = 64;

// Iteration 4: two adjacent 16-wide N tiles per block (32 N columns).
// Iteration 8: one 64-lane wave owns each of those two tiles, so the block is
// two wavefronts and the A fragment of a 32-K step is shared by both waves
// through LDS; B has no reuse (every B byte belongs to exactly one block).
constexpr int kTilesPerWave = 2;

// Iteration 13 target split of the K dimension: 8.  With kTilesPerWave = 2 the
// grid is (N / (16*2)) * S = 40 * S blocks, so S = 8 gives 320 one-generation
// blocks over the 120-device-CU K500SM_AI (2.67 blocks/CU by grid, all resident
// because the unchanged 15,616 B/block LDS footprint still fits four blocks/CU
// = 8 resident waves/CU = 2 per SIMD by capacity).  The move 16 -> 8 halves the
// ONLY non-compulsory component of the operator's memory traffic: the split-K
// partial planes (8 x 80 KiB = 655,360 B written and re-read instead of
// 16 x 80 KiB = 1,310,720 B), i.e. 1,310,720 B of the measured 8,068,416 B
// per-operator-replay traffic.  Each split now owns 16 x 32 K stages = 512
// rows, which is twice the unchanged 256-row staging capacity, so the kernel
// stages and consumes its slice in ascending 256-row PHASES (exactly two at
// the guard); see the phase loop below.  The slices stay UNIFORM
// (128 == 8 x 16) and every boundary stays a multiple of 32, so the
// stage-alignment and exact-int32 contracts are untouched.  The workspace
// holds 16 int32 planes for this shape, so 8 planes fit with room to spare and
// the runtime clamp still covers smaller buffers.
constexpr int kSplitKTarget = 8;

// Iteration 6 staging capacity, tied to the guard launch (k == 4096): 8
// stages x 32 K = 256 K rows of the slice are staged per phase.  Kept
// deliberately independent of kSplitKTarget since iteration 13: the 512-row
// slice of the 8-way split is staged as two 256-row phases, so the staging
// capacity, the A bank-skew pad and the 8-deep B batch are the accepted
// iteration-11 geometry (iteration 17 only re-lays the B mirror n-major).
constexpr int kStageMaxSteps = 8;
constexpr int kStageMaxRows = kStageMaxSteps * kDummaK;          // 256 rows
// stage_a mirrors the block's A slice: 16 m-rows x rows bytes of x_q stored
// m-major at kStageARowStride = rows + 16 pad bytes.  272 B (== 16 mod 128 B)
// skews the row_major A fragment loader's 16 row reads instead of replaying
// one bank, and 272 is a multiple of 16 so the cooperative 16-B stores stay
// 16-B aligned.
constexpr int kStageARowStride = kStageMaxRows + 16;             // 272 B
// Iteration 17: stage_b is an n-MAJOR mirror of the block's 32-column B strip.
// Element B[k][n0 + n] lives at stage_b[n * kStageBColStride + k], i.e. each
// N column owns a contiguous run of kStageBColStride bytes (the phase's k rows
// followed by 16 pad bytes), and the stride is 16-B aligned so every 16-B
// staged chunk is one aligned ds_write_b128.  The library col_major matrix_b
// fragment loader reads lane l's 8 fragment bytes as
// p[(lane & 15) * ldm + 8 * (lane >> 4) + i] (i = 0..7) -- EIGHT CONTIGUOUS
// bytes -- so on the n-major tile the K loop's B fragment becomes ONE 8-byte
// LDS read per step instead of the iteration-13 row_major loader's 8 scatter
// ds_read_u8 plus the byte-reassembly VALU that fed them.  The same logical
// (k, n) element lands in the same v_mmac fragment register in both layouts,
// so every k-ascending int32 partial and the whole output stay bit-identical.
constexpr int kStageBColStride = kStageMaxRows + 16;             // 272 B
constexpr int kStageABytes = kDummaM * kStageARowStride;         // 4,352 B
constexpr int kStageBBytes =
    kDummaN * kTilesPerWave * kStageBColStride;                  // 8,704 B

__global__ __launch_bounds__(kDummaWaveSize * kTilesPerWave)
void w8a8_dumma_m16_splitk_kernel(
    const int8_t* __restrict__ a,      // x_q [M, K] row-major
    const int8_t* __restrict__ b,      // packed_weight [N, K] n-major (guard)
    int32_t* __restrict__ partials,    // workspace [S][M, N] int32
    int n,
    int k,
    int split_k,
    int groups /* n / (kDummaN * kTilesPerWave) */) {
  // Iteration 8: blockDim is TWO 64-lane wavefronts.  Wave w owns N tile w of
  // the block's 2 x 16 columns (cols [n0 + 16*w, n0 + 16*w + 16)) and runs its
  // own independent m16n16k32 accumulator chain for that tile; the staging of
  // each ascending 256-row phase is partitioned across the waves, not
  // duplicated (wave 0 copies the shared A phase, wave 1 the B strip phase),
  // so every global byte is still read exactly once per block -- no repeated
  // HBM reads are traded for occupancy.
  const int tid = static_cast<int>(threadIdx.x);  // blockDim == 128
  const int w = tid / kDummaWaveSize;             // wave id inside block: 0/1
  const int lane = tid - w * kDummaWaveSize;      // lane id within the wave
  const int group = static_cast<int>(blockIdx.x) % groups;
  const int split = static_cast<int>(blockIdx.x) / groups;
  const int n0 = group * (kDummaN * kTilesPerWave);

  // Two LDS staging tiles, one per 16-wide N tile of this block, plus the
  // iteration-6 whole-slice operand mirrors: stage_a (the shared A slice) and
  // stage_b (the block's 32-column n-major B strip).  Static LDS = 2 x 1,024
  // + 4,352 + 8,704 = 15,104 B/block, so floor(65,536 / 15,104) = 4 resident
  // blocks/CU = 8 resident waves/CU (2 per SIMD) since iteration 8.
  __shared__ __align__(16) int32_t acc_tile0[kDummaM * kDummaN];
  __shared__ __align__(16) int32_t acc_tile1[kDummaM * kDummaN];
  __shared__ __align__(16) int8_t stage_a[kStageABytes];
  __shared__ __align__(16) int8_t stage_b[kStageBBytes];

  du::dumma::DUFragment<du::dumma::matrix_a, kDummaM, kDummaN, kDummaK,
                        signed char, du::dumma::row_major>
      a_frag;
  // Iteration 17: the B fragment is col_major over the n-major stage_b, so its
  // 8 bytes per lane are contiguous in LDS (one 8-byte read per step).
  du::dumma::DUFragment<du::dumma::matrix_b, kDummaM, kDummaN, kDummaK,
                        signed char, du::dumma::col_major>
      b_frag;  // this wave's own 16-wide B half of the block's 32-column strip
  du::dumma::DUFragment<du::dumma::accumulator, kDummaM, kDummaN, kDummaK,
                        int>
      acc_frag;  // this wave's accumulator for its n16 tile
  du::dumma::du_fill_fragment(acc_frag, 0);

  // Stage-aligned split: split s owns stages [s*T/S, (s+1)*T/S) of the
  // T = k/kDummaK 32-K stages, so every k range is a multiple of 32 and the
  // ranges tile [0, k) exactly with no gap and no overlap.
  const int total_stages = k / kDummaK;
  const int stage_begin = (split * total_stages) / split_k;
  const int stage_end = ((split + 1) * total_stages) / split_k;
  const int k_begin = stage_begin * kDummaK;
  const int k_end = stage_end * kDummaK;

  // Iteration 13: split_k == 8 makes each split's slice 16 x 32-K stages = 512
  // rows, twice the unchanged 256-row staging capacity, so the slice is staged
  // and consumed in ascending 256-row PHASES (exactly two at the exact-shape
  // guard).  Each phase reproduces the accepted iteration-11 staging geometry
  // byte-for-byte -- A: 256 16-B chunks = 4 per lane on wave 0 (one 4-deep
  // batch); B: 512 chunks = 8 per lane on wave 1 (ONE straight-line 8-deep
  // batch behind a single vmcnt drain) -- and the phase's 8 K-steps accumulate
  // into the SAME acc_frag in ascending k order.  The staged bytes, their LDS
  // addresses and therefore every fragment byte are identical to what the
  // 16-way split staged per 32-K step; only the number of int32 partial planes
  // written and re-read by the split-K round trip halves.
  for (int phase_begin = k_begin; phase_begin < k_end;
       phase_begin += kStageMaxRows) {
    const int remain = k_end - phase_begin;
    const int phase_rows = (remain < kStageMaxRows) ? remain : kStageMaxRows;

    // Iteration 6 A+B phase staging, PARTITIONED across the two wavefronts
    // since iteration 8 (B mirror is n-major since iteration 17).  Every
    // global operand byte of this phase is loaded exactly once, in 16-B int4
    // granules, into an EXACT byte mirror of the operand region the fragment
    // loaders read: stage_a holds a[m][phase_begin .. phase_begin+phase_rows)
    // at row stride kStageARowStride, and stage_b holds the block's 32
    // B-columns' phase as b_lds[n][k], i.e. element
    // packed[n0 + n][phase_begin + k] at n * kStageBColStride + k (the 16 pad
    // bytes per column are never written and never read).  Wave 0 copies the A
    // phase and wave 1 copies the B strip -- the union reads exactly the same
    // global bytes as the single-wave iteration-6 prologue, so no operand byte
    // is fetched twice.  Each copy uses 64 lanes x 16 B per wavefront
    // instruction; the A phase is one 4-deep batch and the exact-guard B strip
    // is one 8-deep batch, so one vmcnt drain covers each wave's whole phase
    // and the two waves' round trips overlap across the SIMDs.  n0 and
    // phase_begin are 32-aligned under the exact-shape guard and k % 16 == 0,
    // n % 16 == 0, so every 16-B source load is 16-B aligned, and every staged
    // B chunk lands at a 16-B-aligned n-major address (one ds_write_b128).
    const bool staged_fits = phase_rows <= kStageMaxRows;
    if (staged_fits) {
      if (w == 0) {
        // A slice phase: 16 m-rows x phase_rows bytes = phase_rows int4
        // chunks, per_row = phase_rows/16 chunks per m-row (phase_rows is a
        // multiple of 32, hence of 16).
        const int per_row = phase_rows / 16;
        const int a_chunks = kDummaM * per_row;  // == phase_rows
        const int4* __restrict__ a4 = reinterpret_cast<const int4*>(a);
        int4* __restrict__ ald4 = reinterpret_cast<int4*>(stage_a);
        const int kb4 = phase_begin >> 4;  // phase start in global int4 columns
        const int a4_stride = k >> 4;      // global A int4 columns per m-row
        const auto ld_a = [&](int e) {
          const int m = e / per_row;
          const int t = e - m * per_row;
          return a4[static_cast<int64_t>(m) * a4_stride + kb4 + t];
        };
        const auto st_a = [&](int e, const int4& v) {
          const int m = e / per_row;
          const int t = e - m * per_row;
          ald4[m * (kStageARowStride / 16) + t] = v;
        };
        int e = lane;
        for (; e + 3 * kDummaWaveSize < a_chunks; e += 4 * kDummaWaveSize) {
          const int4 v0 = ld_a(e);
          const int4 v1 = ld_a(e + kDummaWaveSize);
          const int4 v2 = ld_a(e + 2 * kDummaWaveSize);
          const int4 v3 = ld_a(e + 3 * kDummaWaveSize);
          st_a(e, v0);
          st_a(e + kDummaWaveSize, v1);
          st_a(e + 2 * kDummaWaveSize, v2);
          st_a(e + 3 * kDummaWaveSize, v3);
        }
        for (; e < a_chunks; e += kDummaWaveSize) {
          st_a(e, ld_a(e));
        }
      } else {
        // Iteration 17 B strip: the n-major packed weight stores each N
        // column's K axis contiguously, so a phase is
        // chunks_per_n = phase_rows / 16 int4 chunks PER N column (16 at the
        // guard) and consecutive lanes cover consecutive 16-B chunks of one
        // column's 256-B phase run.  Each chunk is written CONTIGUOUSLY into
        // the n-major LDS tile at stage_b[nl * kStageBColStride + t * 16], i.e.
        // one aligned ds_write_b128 per chunk, exactly the bytes the col_major
        // fragment loader reads back.
        const int chunks_per_n = phase_rows / 16;  // 16 at the guard
        const int b_chunks = (kDummaN * kTilesPerWave) * chunks_per_n;
        const int4* __restrict__ b4 = reinterpret_cast<const int4*>(b);
        int4* __restrict__ bld4 = reinterpret_cast<int4*>(stage_b);
        const int b4_per_n = k >> 4;  // packed int4 chunks per N column
        const auto ld_b = [&](int e) {
          const int nl = e / chunks_per_n;          // local N column 0..31
          const int t = e - nl * chunks_per_n;      // k-chunk in this phase
          return b4[static_cast<int64_t>(n0 + nl) * b4_per_n +
                    (phase_begin >> 4) + t];
        };
        // 272-B n-row stride and 16-B chunks keep every store 16-B aligned.
        const auto st_b = [&](int e, const int4& v) {
          const int nl = e / chunks_per_n;
          const int t = e - nl * chunks_per_n;
          bld4[nl * (kStageBColStride >> 4) + t] = v;
        };
        int e = lane;
        // Iteration 11: the exact-guard B strip is exactly 8 chunks per lane
        // (phase_rows == kStageMaxRows == 256 -> b_chunks == 512 == 8 x 64
        // lanes), so that case runs as ONE straight-line 8-deep batched group:
        // all eight 16-B source loads issue before the first LDS store, one
        // vmcnt drain covers the whole strip, and the second dependent global
        // round trip leaves the block's staging join.  Any other chunk count
        // keeps the unchanged rolled 4-deep loop below.
        if (b_chunks == 8 * kDummaWaveSize) {
          const int4 v0 = ld_b(e + 0 * kDummaWaveSize);
          const int4 v1 = ld_b(e + 1 * kDummaWaveSize);
          const int4 v2 = ld_b(e + 2 * kDummaWaveSize);
          const int4 v3 = ld_b(e + 3 * kDummaWaveSize);
          const int4 v4 = ld_b(e + 4 * kDummaWaveSize);
          const int4 v5 = ld_b(e + 5 * kDummaWaveSize);
          const int4 v6 = ld_b(e + 6 * kDummaWaveSize);
          const int4 v7 = ld_b(e + 7 * kDummaWaveSize);
          st_b(e + 0 * kDummaWaveSize, v0);
          st_b(e + 1 * kDummaWaveSize, v1);
          st_b(e + 2 * kDummaWaveSize, v2);
          st_b(e + 3 * kDummaWaveSize, v3);
          st_b(e + 4 * kDummaWaveSize, v4);
          st_b(e + 5 * kDummaWaveSize, v5);
          st_b(e + 6 * kDummaWaveSize, v6);
          st_b(e + 7 * kDummaWaveSize, v7);
          e += 8 * kDummaWaveSize;
        }
        for (; e + 3 * kDummaWaveSize < b_chunks; e += 4 * kDummaWaveSize) {
          const int4 v0 = ld_b(e);
          const int4 v1 = ld_b(e + kDummaWaveSize);
          const int4 v2 = ld_b(e + 2 * kDummaWaveSize);
          const int4 v3 = ld_b(e + 3 * kDummaWaveSize);
          st_b(e, v0);
          st_b(e + kDummaWaveSize, v1);
          st_b(e + 2 * kDummaWaveSize, v2);
          st_b(e + 3 * kDummaWaveSize, v3);
        }
        for (; e < b_chunks; e += kDummaWaveSize) {
          st_b(e, ld_b(e));
        }
      }
    }
    // Cross-wave barrier: wave 0's staged A phase is read by wave 1 (and vice
    // versa for the B strip), so both tiles are ready for both waves here, and
    // it also orders this phase's staging after every lane's previous-phase
    // LDS reads.
    __syncthreads();  // stage_a / stage_b ready for every lane of the block

    // Iteration 8 LDS-only K loop, one independent chain per wavefront.  Each
    // 32-K step reads the shared A fragment from the staged A mirror at row
    // stride kStageARowStride and this wave's own 16-wide B half from the
    // iteration-17 n-major B mirror at column stride kStageBColStride, where
    // the library col_major loader takes the lane's 8 fragment bytes as ONE
    // contiguous 8-byte read -- no global load and no vmcnt wait on the MMA
    // path.  The ascending k0 order keeps each partial's int32 accumulation
    // exact, and the staged tiles are exact byte copies of the global bytes the
    // iteration-4 path read, so this branch is bit-identical to the direct-global
    // loop below.
    if (staged_fits) {
      for (int k0 = phase_begin; k0 < phase_begin + phase_rows;
           k0 += kDummaK) {
        const int local_row = k0 - phase_begin;
        du::dumma::du_load_matrix_sync(a_frag, stage_a + local_row,
                                       kStageARowStride);
        du::dumma::du_load_matrix_sync(
            b_frag, stage_b + local_row + w * kDummaN * kStageBColStride,
            kStageBColStride);
        du::dumma::du_mma_sync(acc_frag, a_frag, b_frag, acc_frag);
      }
    } else {
      // Safety net kept for a runtime-clamped split whose phase would exceed
      // the staging capacity (an undersized workspace clamps split_k < 8): the
      // iteration-4 direct-global path, here consuming the same n-major packed
      // weight through the col_major loader at column stride K, so a clamped
      // launch stays bit-exact and can never overrun stage_a / stage_b.  This
      // branch never executes at the exact-shape guard launch, where every
      // phase is exactly kStageMaxRows rows.
      for (int k0 = phase_begin; k0 < phase_begin + phase_rows;
           k0 += kDummaK) {
        du::dumma::du_load_matrix_sync(a_frag, a + k0, k);
        du::dumma::du_load_matrix_sync(
            b_frag, b + static_cast<int64_t>(n0 + w * kDummaN) * k + k0, k);
        du::dumma::du_mma_sync(acc_frag, a_frag, b_frag, acc_frag);
      }
    }
    // End-of-phase barrier: no lane may overwrite stage_a / stage_b for the
    // next phase until every lane has consumed this phase's staged fragments.
    __syncthreads();
  }

  // Each wave materializes ONLY its own n16 tile (its private acc_tile slot)
  // and publishes that tile's 16 columns to the plane; the two waves' plane
  // ranges are disjoint, so no cross-wave dependency exists in the epilogue
  // (the barrier below only orders each wave's own LDS store/read-back).
  int32_t* my_tile = (w == 0) ? acc_tile0 : acc_tile1;
  du::dumma::du_store_matrix_sync(my_tile, acc_frag, kDummaN,
                                  du::dumma::mem_row_major);
  __syncthreads();

  // 256 int32 elements / 64 lanes: each lane writes four partials of its own
  // tile, kept row-major within the plane so the combine below reads them
  // coalesced.  Wave 1's tile lands kDummaN columns to the right of wave 0's.
  int32_t* plane =
      partials + static_cast<int64_t>(split) * kDummaM * n;
#pragma unroll
  for (int linear = lane; linear < kDummaM * kDummaN;
       linear += kDummaWaveSize) {
    const int row = linear / kDummaN;
    const int col = linear - row * kDummaN;
    const int64_t dst =
        static_cast<int64_t>(row) * n + n0 + w * kDummaN + col;
    plane[dst] = my_tile[linear];
  }
}

// Combine pass: sum the S exact int32 partial planes (order-free integer
// addition), then apply the two fp32 scales in the same order as the scalar
// fallback and store bf16.  Every plane is M*N int32 = 80 KiB for this shape,
// so the whole combine is L2-resident.
//
// Iteration 9 (combine restructure, HIP-only): the guard launch
// (split_k == kCombineSplits == 8 since iteration 13) now runs a 2-D grid of
// one-wave 64-lane blocks -- (n / kCombineColsPerBlock) column groups x m rows
// -- with exactly one output element per lane (row = blockIdx.y,
// col = blockIdx.x * 64 + lane).  The eight plane loads are issued as
// INDEPENDENT reads into a register array (one vmcnt drain, 8-way
// memory-level parallelism per lane) and summed afterwards in the unchanged
// ascending split order s = 0..7, instead of the rolled dependent load ->
// wait -> int32 add chain of 8 DRAM round trips per element.  Each per-plane
// wavefront load also reads 64 lanes x 4 B = 256 B contiguous (four
// consecutive 64-B lines of one m-row).  Every output element's int32 sum,
// fp32 scale order and bf16 conversion are unchanged, so the output is
// bit-identical; the generic path below (any clamped split_k < 8) keeps the
// original 128-thread linear mapping and the original dependent loop.
constexpr int kCombineThreads = 128;
constexpr int kCombineSplits = 8;         // == kSplitKTarget of the guard
constexpr int kCombineWaveSize = 64;      // one gfx928 wavefront per block
constexpr int kCombineColsPerBlock = 64;  // n-columns per one-wave block

__global__ __launch_bounds__(kCombineThreads) void w8a8_splitk_combine_kernel(
    const int32_t* __restrict__ partials,  // [S][M, N] int32
    const float* __restrict__ x_scale,     // [M]
    const float* __restrict__ weight_scale,  // [N]
    __hip_bfloat16* __restrict__ out,      // [M, N] bf16
    int total /* m * n */,
    int n,
    int split_k) {
  const int lane = static_cast<int>(threadIdx.x);

  // Iteration 9 guard specialization: one output element per lane, all sixteen
  // plane reads issued as independent loads before the ascending sum.  The
  // launcher pairs this branch with the 2-D one-wave grid (blockDim == 64,
  // grid == (n/64, m)); the blockDim test keeps any other launch shape on the
  // generic path.
  if (split_k == kCombineSplits &&
      static_cast<int>(blockDim.x) == kCombineColsPerBlock) {
    const int row = static_cast<int>(blockIdx.y);
    const int col =
        static_cast<int>(blockIdx.x) * kCombineColsPerBlock + lane;
    const int64_t elem = static_cast<int64_t>(row) * n + col;
    int32_t plane[kCombineSplits];
#pragma unroll
    for (int s = 0; s < kCombineSplits; ++s) {
      plane[s] = partials[static_cast<int64_t>(s) * total + elem];
    }
    int32_t acc = 0;
#pragma unroll
    for (int s = 0; s < kCombineSplits; ++s) {
      acc += plane[s];  // ascending split order: identical exact int32 sum
    }
    const float scaled =
        static_cast<float>(acc) * x_scale[row] * weight_scale[col];
    out[elem] = __float2bfloat16(scaled);
    return;
  }

  const int i = static_cast<int>(blockIdx.x) * kCombineThreads + lane;
  if (i >= total) {
    return;
  }

  int32_t acc = 0;
  for (int s = 0; s < split_k; ++s) {
    acc += partials[static_cast<int64_t>(s) * total + i];
  }

  const int row = i / n;
  const int col = i - row * n;
  const float scaled =
      static_cast<float>(acc) * x_scale[row] * weight_scale[col];
  out[i] = __float2bfloat16(scaled);
}

// Identity pack: raw int8 weight -> packed int8 weight.
__global__ __launch_bounds__(kBlockThreads) void identity_i8_kernel(
    const int8_t* __restrict__ src,
    int8_t* __restrict__ dst,
    int64_t count) {
  const int64_t i =
      static_cast<int64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
  if (i < count) {
    dst[i] = src[i];
  }
}

// Identity pack: fp32 weight scale -> packed fp32 weight scale.
__global__ __launch_bounds__(kBlockThreads) void identity_f32_kernel(
    const float* __restrict__ src,
    float* __restrict__ dst,
    int64_t count) {
  const int64_t i =
      static_cast<int64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
  if (i < count) {
    dst[i] = src[i];
  }
}

// Iteration 17 exact-guard n-major transpose pack:
//   packed[n * K + k] = raw[k * N + n]     ((K, N) == (4096, 1280) only)
// The pack runs once in launch_pack_w8a8_weight, outside the timed operator
// region and outside Graph capture, so a plain 32 x 32 LDS-tiled transpose is
// more than enough.  Same byte count and the same packed_weight buffer as the
// identity pack; the packed layout is opaque per the API contract and every
// consumer below decodes this permutation for the guard pair.
__global__ __launch_bounds__(256) void pack_nmajor_i8_kernel(
    const int8_t* __restrict__ src,  // raw weight [K, N] row-major
    int8_t* __restrict__ dst,        // packed n-major [N, K] row-major
    int k,
    int n) {
  __shared__ int8_t tile[32][33];
  const int tx = static_cast<int>(threadIdx.x);  // 0..31
  const int ty = static_cast<int>(threadIdx.y);  // 0..7
  const int col0 = static_cast<int>(blockIdx.x) * 32;  // N (output row)
  const int row0 = static_cast<int>(blockIdx.y) * 32;  // K (input row)
  // Load tile[k_local][n_local] = src[(row0 + k_local) * n + col0 + n_local].
  for (int j = ty; j < 32; j += 8) {
    const int row = row0 + j;
    if (row < k && col0 + tx < n) {
      tile[j][tx] = src[static_cast<int64_t>(row) * n + (col0 + tx)];
    }
  }
  __syncthreads();
  // Store its transpose: dst[(col0 + n_local) * k + row0 + k_local].
  for (int j = ty; j < 32; j += 8) {
    const int col = col0 + j;
    if (col < n && row0 + tx < k) {
      dst[static_cast<int64_t>(col) * k + (row0 + tx)] = tile[tx][j];
    }
  }
}

void launch_identity_i8(
    const int8_t* src,
    int8_t* dst,
    int64_t count,
    hipStream_t stream) {
  if (count <= 0) {
    return;
  }
  const int64_t blocks = (count + kBlockThreads - 1) / kBlockThreads;
  hipLaunchKernelGGL(
      identity_i8_kernel,
      dim3(static_cast<unsigned>(blocks)),
      dim3(kBlockThreads),
      0,
      stream,
      src,
      dst,
      count);
}

void launch_pack_nmajor_i8(
    const int8_t* src,
    int8_t* dst,
    int k,
    int n,
    hipStream_t stream) {
  if (k <= 0 || n <= 0) {
    return;
  }
  const dim3 block(32, 8);
  const dim3 grid(
      static_cast<unsigned>((n + 31) / 32),
      static_cast<unsigned>((k + 31) / 32));
  hipLaunchKernelGGL(
      pack_nmajor_i8_kernel, grid, block, 0, stream, src, dst, k, n);
}

void launch_identity_f32(
    const float* src,
    float* dst,
    int64_t count,
    hipStream_t stream) {
  if (count <= 0) {
    return;
  }
  const int64_t blocks = (count + kBlockThreads - 1) / kBlockThreads;
  hipLaunchKernelGGL(
      identity_f32_kernel,
      dim3(static_cast<unsigned>(blocks)),
      dim3(kBlockThreads),
      0,
      stream,
      src,
      dst,
      count);
}

}  // namespace

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
  // The timed op may only use the caller-provided out/workspace on the
  // caller stream; no host/device sync and no allocation happen here.
  if (a == nullptr || b == nullptr || x_scale == nullptr ||
      weight_scale == nullptr || out == nullptr) {
    return;
  }
  if (m <= 0 || n <= 0 || k <= 0) {
    return;
  }

  __hip_bfloat16* out_bf16 = reinterpret_cast<__hip_bfloat16*>(out);

  // Exact-shape DUMMA split-K specialization (iteration 8): the only call
  // site of w8a8_dumma_m16_splitk_kernel.  Multi-N-tile reuse plus whole-slice
  // A+B LDS staging, with two 64-lane wavefronts per block (iteration 8):
  // wave w owns one of the block's kTilesPerWave = 2 adjacent 16-wide N tiles
  // and runs its own accumulator chain, while the block stages its A slice and
  // its whole 32-column B strip into LDS (partitioned across the two waves)
  // and runs an LDS-only K loop; since iteration 13 a 512-row slice is staged
  // as two ascending 256-row phases.  The K dimension is split S ways, so
  // grid = (N/(16*T))*S blocks of 128 threads: the 8-way split gives
  // 40*8 = 320 blocks for the 120 device CUs with uniform 16-stage (512-row)
  // slices, each staged as two 256-row phases in the iteration-17
  // 15,104 B/block LDS footprint (four resident blocks/CU by capacity).  S is
  // clamped to the workspace capacity (the API guarantees 16 int32 planes) and
  // to the number of 32-K stages; a clamped split whose phase exceeded the
  // staging capacity would use the kernel's byte-for-byte direct-global loop
  // instead (unreachable at the guard, where every phase is exactly 256 rows).
  // Guarded by the exact (m, n, k)
  // triple so every other shape -- notably the paired M=2 API shape with the
  // same (N, K) -- keeps the scalar fallback below; if no usable workspace is
  // supplied the exact shape also falls through.  Iteration 9 changes only the
  // second timed dispatch: at the unclamped guard split the 8-plane combine
  // runs as a 2-D one-wave grid (n/64 x m blocks of 64 lanes, one output
  // element per lane, all 8 plane loads independent in registers) while any
  // runtime-clamped split_k < 8 keeps the original generic combine launch.
  if (m == 16 && n == 1280 && k == 4096 && workspace != nullptr) {
    const int64_t plane_elems = static_cast<int64_t>(m) * n;
    const int64_t plane_bytes =
        plane_elems * static_cast<int64_t>(sizeof(int32_t));
    const int total_stages = k / kDummaK;
    int split_k = kSplitKTarget;
    if (plane_bytes > 0) {
      const int64_t max_split = workspace_bytes / plane_bytes;
      if (split_k > max_split) {
        split_k = static_cast<int>(max_split < 0 ? 0 : max_split);
      }
    } else {
      split_k = 0;
    }
    if (split_k > total_stages) {
      split_k = total_stages;
    }

    if (split_k >= 1) {
      int32_t* partials = reinterpret_cast<int32_t*>(workspace);
      // 32-column groups: n / 32 = 40 for the guarded exact shape.  Both
      // factors are exact divisors of the guard's (n, k), so no tail path is
      // needed.
      const int groups = n / (kDummaN * kTilesPerWave);
      const dim3 grid(static_cast<unsigned>(groups * split_k));
      const dim3 block(static_cast<unsigned>(kDummaWaveSize * kTilesPerWave));
      hipLaunchKernelGGL(
          w8a8_dumma_m16_splitk_kernel,
          grid,
          block,
          0,
          stream,
          a,
          b,
          partials,
          n,
          k,
          split_k,
          groups);

      // Iteration 9: the unclamped guard split (split_k == 8 since iteration
      // 13) launches the combine on the 2-D one-wave grid (20 column groups x
      // 16 rows = 320 blocks of 64 lanes) that gives every lane one output
      // element and all eight plane loads as independent register reads; a
      // runtime-clamped split_k < 8 keeps the original linear 128-thread launch
      // and the kernel's generic dependent-plane loop.
      const int total = m * n;
      if (split_k == kCombineSplits) {
        hipLaunchKernelGGL(
            w8a8_splitk_combine_kernel,
            dim3(static_cast<unsigned>(n / kCombineColsPerBlock),
                 static_cast<unsigned>(m)),
            dim3(static_cast<unsigned>(kCombineWaveSize)),
            0,
            stream,
            partials,
            x_scale,
            weight_scale,
            out_bf16,
            total,
            n,
            split_k);
      } else {
        const int combine_blocks =
            (total + kCombineThreads - 1) / kCombineThreads;
        hipLaunchKernelGGL(
            w8a8_splitk_combine_kernel,
            dim3(static_cast<unsigned>(combine_blocks)),
            dim3(static_cast<unsigned>(kCombineThreads)),
            0,
            stream,
            partials,
            x_scale,
            weight_scale,
            out_bf16,
            total,
            n,
            split_k);
      }
      return;
    }
  }

  const int64_t total =
      static_cast<int64_t>(m) * static_cast<int64_t>(n);
  const int64_t blocks = (total + kBlockThreads - 1) / kBlockThreads;

  // Generic scalar fallback for every unmatched (m, n, k), including the
  // paired M=2 API shape with the same (N, K).
  hipLaunchKernelGGL(
      w8a8_scalar_kernel,
      dim3(static_cast<unsigned>(blocks)),
      dim3(kBlockThreads),
      0,
      stream,
      a,
      b,
      x_scale,
      weight_scale,
      out_bf16,
      m,
      n,
      k);
}

extern "C" void launch_pack_w8a8_weight(
    const int8_t* raw_weight,
    const float* weight_scale,
    int8_t* packed_weight,
    float* packed_weight_scale,
    int k,
    int n,
    hipStream_t stream) {
  if (raw_weight == nullptr || weight_scale == nullptr ||
      packed_weight == nullptr || packed_weight_scale == nullptr) {
    return;
  }
  if (k <= 0 || n <= 0) {
    return;
  }

  const int64_t weight_count =
      static_cast<int64_t>(k) * static_cast<int64_t>(n);
  if (k == kGuardK && n == kGuardN) {
    // Iteration 17: the exact-guard weight pair is transposed into the
    // n-major layout packed[n*K + k] = raw[k*N + n] consumed by the guard
    // DUMMA kernel's n-major LDS stage and by every fallback that decodes the
    // packed buffer for this (K, N).  Same element count and buffer as the
    // identity pack.
    launch_pack_nmajor_i8(raw_weight, packed_weight, k, n, stream);
  } else {
    // Generic fallback for every unmatched (K, N): identity copy.
    launch_identity_i8(raw_weight, packed_weight, weight_count, stream);
  }
  launch_identity_f32(
      weight_scale, packed_weight_scale, static_cast<int64_t>(n), stream);
}
// @@end
