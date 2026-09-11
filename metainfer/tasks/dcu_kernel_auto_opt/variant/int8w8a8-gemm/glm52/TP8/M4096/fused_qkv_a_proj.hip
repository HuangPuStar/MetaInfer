// @@variant shape=glm_tp8_fused_qkv_a_proj_m4096 commit=99b9a733eddfc7196f3d186b80affe4324351ac4 added=2026-09-11
//   median_us=883.7 p90_us=885.5 speedup=77.7 baseline_us=6.866e+04
//   source=test-9-11-1-b01955b3/iteration_001/glm_tp8_fused_qkv_a_proj_m4096
// MetaInfer W8A8 INT8 GEMM -- round-1 architecture establishment for
// Hygon K500SM_AI / gfx928 (worker_0, physical GPU 0).
//
// Assigned shape:
//   glm_tp8_fused_qkv_a_proj_m4096 : M=4096, N=2624, K=6144
//
// Operator contract (fixed by the control plane):
//   out[m, n] = bf16( int32_dot(x_q[m, :], raw_weight[:, n])
//                     * x_scale[m] * weight_scale[n] )
//
// Round 1 (mandatory establish_arch) -- packed_weight architecture family:
//
//   Bottleneck hypothesis, from the trusted PMC of the current best source
//   (the correctness-first bootstrap: w8a8_dumma_prefill_tiled_kernel
//   <128, 64, 128>, identity [K, N] weight, library du_load_matrix_sync
//   loaders, LDS row strides 128 (A) / 64 (B), grid 41 x 32 = 1312 blocks,
//   256 threads, 2 blocks/CU):
//     median 2920.88 us / p90 2962.82 us, lds_instructions 21,999,616,
//     lds_bank_conflicts 274,071,552 (~12.5 per LDS instruction),
//     lds_wait_instructions 50,181,819, valu_instructions 86,560,512,
//     vmem_read_instructions 1,574,400, and a counter-derived operator HBM
//     bandwidth of only 50.6 GB/s (147.8 MB per replay at a 90.7% L2 hit
//     rate). The exact-shape stage loop is LDS-issue/conflict bound, not
//     MMA- or HBM-bound: both LDS row strides alias every row onto one bank
//     phase (128 mod 32 == 0, 64 mod 32 == 0), and the row_major matrix_b
//     loader of du_load_matrix_sync lowers each m16n16k32 int8 B fragment to
//     8 ds_read_u8 at 16-byte spacing plus a byte-reassembly chain.
//
//   Focused change (ONE architecture family -- packed_weight -- entirely
//   inside csrc/w8a8_gemm_hip.hip):
//     (1) launch_pack_w8a8_weight packs the exact (k, n) == (6144, 2624)
//         weight ONCE, outside the timed region and out of Graph capture,
//         into the n-major layout packed[n * k + kk] = raw[kk * n + n]
//         (same byte count, same buffer allocation, so every captured
//         address is unchanged). Every other (K, N) keeps the identity
//         device-to-device copy.
//     (2) the exact-shape guard dispatches the new
//         w8a8_dumma_prefill_packedb_kernel<128, 64, 128>. It keeps the
//         EXACT bootstrap geometry -- grid (N/64) x (M/128) = 41 x 32 = 1312
//         blocks, 256 threads = 4 gfx928 wavefronts, one 64 x 32 quadrant of
//         eight m16n16k32 int32 accumulator fragments per wave, the same
//         single-buffered 128-K LDS stage with two __syncthreads per stage,
//         the same k0-outer / kk-inner ascending int32 accumulation order and
//         the same coalesced bf16 epilogue -- and changes only the operand
//         path to the packed-weight architecture:
//           * B is staged n-major (b_tile[n_row][k]) from the packed [N, K]
//             weight, so a col_major matrix_b fragment is 8 contiguous K
//             bytes per lane and every staging vector is one coalesced
//             16-byte global read;
//           * both LDS tiles use the bank-safe row stride StageK + 8 = 136
//             bytes (34 dwords): 8-byte aligned with an odd 8-byte count
//             (136/8 = 17), so the 16 rows of each 16-lane ds_read_b64 phase
//             land on 16 distinct bank pairs (the conflict-free 4-phase
//             floor), and 136 % 16 == 8 keeps the two-half int64 staging
//             form;
//           * both fragment loaders are the explicit load_frag8: ONE aligned
//             8-byte load per lane per fragment (row = lane & 15, k-quarter =
//             lane >> 4), replacing the byte-reassembly library path with a
//             single ds_read_b64 while producing identical fragment values.
//     (3) LDS/block grows 24,576 -> 26,112 B (A[128, 136] + B[64, 136]);
//         2 x 26,112 = 52,224 <= 65,536 B keeps TWO resident blocks/CU =
//         8 waves/CU, so grid_blocks (1312), waves_per_block (4) and the
//         active CU count (120) are unchanged.
//     (4) the scalar fallback decodes the n-major layout when
//         (k, n) == (6144, 2624) with ascending kk, so the paired M=2 /
//         M=16 API shapes with the same (N, K) stay byte-exact; the generic
//         <64, 64, 128> identity arm is untouched.
//
//   Correctness: the same weight elements reach the same fragment slots in
//   the same ascending k-chunk sequence (k0 outer over 48 stages of 128 K,
//   kk inner ascending over four m16n16k32 steps), so every int32
//   accumulator -- and therefore every bf16 output byte -- is identical to
//   the bootstrap kernel and to the scalar reference.
//
// Round 2 (mandated operand-reuse round: cooperative A+B LDS staging vs direct
// loads, quantified A/B reuse per macro-tile, vectorized coalesced global loads
// with a bank-safe LDS layout):
//
//   Operand-reuse accounting for the accepted <128, 64, 128> macro-tile
//   (M=4096, N=2624, K=6144):
//     * per block the unique operand bytes are A = 128 x 6144 = 786,432 and
//       B = 6144 x 64 = 393,216; the 41 N-blocks re-read every A row-slab
//       (M*K*41 = 1.03 GB/replay, 41x amplification of the 25.2 MB unique A)
//       and the 32 M-blocks re-read every B column-slab (K*N*32 = 0.52
//       GB/replay, 32x of the 16.1 MB unique B): 1.55 GB/replay of staged
//       global traffic;
//     * inside one block each staged 16-B vector is re-read from LDS by the two
//       wave columns (A) / the two wave rows (B), i.e. exactly 2x wave-level
//       reuse per staged byte, so the LDS read traffic is 2x the staged bytes
//       (4.72 GB/replay, ~23 B/cycle/CU at the measured 1.271 GHz -- far below
//       the LDS bandwidth), and the counter-derived HBM rate is only
//       108.4 GB/s (147.8 MB/replay at a 90.7% L2 hit rate). The kernel is
//       therefore NOT HBM- or LDS-bandwidth bound, so a direct per-wave global
//       fragment path is rejected up front: it would issue 4x more vmem
//       instructions (4 waves x 48 stages of 8-B fragment loads) and every 8-B
//       fragment load would be a row-strided multi-line access instead of the
//       coalesced 16-B staging vectors of the cooperative path. Cooperative
//       A+B LDS staging is RETAINED -- the round improves it instead.
//
//   Remaining exposed cost of the retained path: the VMEM round trip in front
//   of every stage consume. The accepted source (PMC digest daf403b3...,
//   profiles/.../iteration2/pmc.json: profiled 1368.793 us, grid 1312 blocks,
//   2 blocks/CU, 26,112 B LDS, lds_instructions 7,892,992 with
//   lds_wait 4,535,391, lds_bank_conflicts 0, vmem_read 1,574,400,
//   grbm_gui_active == grbm_count) issues per 128-K stage 24 wave-level
//   global_load_dwordx4 + 24 ds_write2_b64 and then, per the exact-source ISA,
//   strictly serializes global_load_dwordx4 -> s_waitcnt vmcnt(0) ->
//   ds_write2_b64 -> s_barrier -> 24x ds_read_b64 -> 32x v_mmac -> s_barrier:
//   with 8 resident waves/CU the GPU is 100% GRBM GUI-active yet issues only
//   ~4.6% of its slots, i.e. the stage boundary -- not HBM, LDS bandwidth or
//   MMA throughput -- sets the pace.
//
//   Focused change (ONE mechanism -- the K stage pipeline -- entirely inside
//   csrc/w8a8_gemm_hip.hip): the exact-shape guard now dispatches
//   w8a8_dumma_prefill_packedb_db_kernel<128, 64, 64>. It keeps the SAME
//   macro-tile (grid 41 x 32 = 1312 blocks, 256 threads = 4 wavefronts, 64 x 32
//   quadrant of eight m16n16k32 int32 accumulators per wave), the SAME packed
//   n-major B (16-B coalesced staging vectors), the SAME explicit load_frag8
//   fragment reads, the SAME bank-safe LDS stride form and the SAME coalesced
//   epilogue -- and changes only how the K stages are staged:
//     * the single-buffered 128-K stage (TWO __syncthreads per stage, full
//       VMEM latency exposed in front of every consume) becomes a
//       DOUBLE-buffered 64-K stage with ONE __syncthreads per stage: the
//       stage-(s+1) global loads (2 int4 A + 1 int4 B per thread) are issued
//       into staging VGPRs BEFORE the stage-s consume and flushed into the idle
//       LDS buffer after it, so the stage-(s+1) VMEM latency overlaps the
//       stage-s LDS/v_mmac work.
//
//   Resources: LDS = 2 x (A[128, 72] + B[64, 72]) = 2 x 13,824 = 27,648 B/block
//   (26,112 -> 27,648 B, +5.9%); 2 x 27,648 = 55,296 <= 65,536 B keeps TWO
//   resident blocks/CU = 8 waves/CU, occupancy UNCHANGED. kLdsStride = 72 =
//   StageK + 8: 8-aligned with an odd 8-byte count (72/8 = 9) so the 16 rows of
//   each 16-lane ds_read_b64 phase land on 16 distinct bank pairs (18r mod 32,
//   r = 0..15) -- the same conflict-free 4-phase floor as the accepted kernel --
//   and 72 % 16 == 8 keeps the two-half ds_write2_b64 staging form. 12 extra
//   VGPR hold the prefetch payload (~72 -> ~84, still <= the 128/thread budget
//   of 2 blocks/CU; 0 spills expected).
//
//   Correctness: k0-outer over 96 ASCENDING 64-K stages with kk-inner ascending
//   over two m16n16k32 steps gives the identical (k0 + kk) k-chunk sequence
//   0, 32, 64, 96, ... as the accepted 48 x 128-K stages, with the identical
//   element-to-slot fragment mapping, so every int32 accumulator -- and every
//   bf16 output byte -- is bit-identical to the accepted kernel and to the
//   scalar reference. The n-major pack, the scalar-fallback n-major decode, the
//   generic <64, 64, 128> identity arm and every shape guard are untouched.
//
// Round 3 (mandated pipeline round: compare single and double buffering across
// K tiles; retain double buffering only on ISA/PMC evidence of reduced VMEM
// stalls without harmful LDS or occupancy growth):
//
//   * Mandatory comparison (exact trusted PMC/ISA of the two accepted arms):
//       arm                        median us  LDS B/blk  blocks/CU  VGPR
//       single 128-K <128,64,128>  1363.078   26,112     2/8 waves   72
//       double  64-K <128,64,64>   1153.970   27,648     2/8 waves   96
//     A single 64-K arm is not built: with NO prefetch it can only add
//     barriers (2 per 64-K stage = 192 per block vs the 128-K arm's 96) while
//     exposing the same VMEM round trip, so it is strictly dominated and
//     rejected by construction.
//     RETAINED -- double buffering. Evidence: median 1363.078 -> 1153.970 us
//     (-15.3%) and p90 1364.825 -> 1164.522 us (-14.7%); the exact-source PMC
//     of the double-buffered arm (digest ee609c3f..., iteration3/pmc.json)
//     shows lds_wait_instructions 4,562,210 -> 3,590,796 (-21.3%) with
//     grbm_gui_active == grbm_count (100% GUI-active), LDS 27,648 B/block
//     (2 x 27,648 = 55,296 <= 65,536 so the trusted occupancy-probe split 2
//     is unchanged = 8 waves/CU), arch_vgpr 96 with 0 spills (<= the
//     128/thread budget of 2 blocks/CU) and sgpr 32. The ISA confirms the
//     mechanism: the stage-(s+1) global_load_dwordx4s are issued BEFORE the
//     stage-s ds_read_b64 / v_mmac burst and the vmcnt(0) wait lands on the
//     ds_write2_b64 flush AFTER the MMACs, while the 128-K arm serializes
//     global_load_dwordx4 -> s_waitcnt vmcnt(0) -> ds_write2_b64 -> s_barrier
//     with zero compute overlap. So the prefetch converted exposed VMEM
//     latency into overlapped work without trading away occupancy.
//     LDS-growth verdict: the +1,536 B/block stays inside the 2-block budget
//     and lds_wait FELL (the LDS path is not harmed in the net); the new
//     lds_bank_conflicts 12,091,392 is exactly 6 x 4 x 4 x 96 x 1312 = one
//     conflict per 16-lane phase of every merged ds_read2_b64, i.e. the
//     bank-preserving alias of the +16-row second fragment offset
//     (16 x 72 = 1152 B = 9 x 128 B; for ANY 8-aligned uniform row stride S,
//     16 rows = 4S dwords with 4S % 32 == 0). The unmerged ds_read_b64
//     control at the same 72/136-byte strides measured 0 conflicts, so this
//     is an alias of the merged read form, not a layout defect.
//     Every other K-tile pipeline is rejected inside the 65,536 B budget:
//     StageK=96 double buffer = 39,936 B/block, StageK=128 double buffer =
//     52,224 B/block and 3 x 64-K = 41,472 B/block all exceed the 32,768
//     B/block that 2 resident blocks/CU permit (each would drop to 1
//     block/CU = 4 waves/CU, a 2x occupancy loss, explicitly excluded), and a
//     32-K stage leaves only 128 B staging vectors per block (half the 256
//     threads idle) while carrying a single m16n16k32 step per stage (too
//     little consume work to amortize the barrier). StageK=64 x 2 buffers is
//     therefore the unique 2-resident-block K pipeline and is retained.
//
//   * Focused change (ONE mechanism -- the B operand's global-memory layout --
//     entirely inside csrc/w8a8_gemm_hip.hip). The pipeline round's own PMC
//     identifies the next exposed cost: the accepted source reads
//     170,221,184 B/replay at only an 86.938% L2 hit rate (3,250,848 misses)
//     and 166.147 GB/s counter-derived HBM, while the unique operands are only
//     25.2 MB (A) + 16.1 MB (B). The B side causes it: the n-major pack
//     packed[n*K + kk] lays a [64, 64] B tile out as 64 separate 64-byte
//     column chunks at a 6,144-byte stride, so every one of the 8 warp-level
//     16-byte staging loads touches 32 half-used 128-byte lines.
//     launch_pack_w8a8_weight now packs the exact (k, n) == (6144, 2624)
//     weight once, outside the timed region and out of Graph capture, into 41
//     B panels of [K, 64] int8 with 16-byte k-runs per column:
//       packed[(n>>6)*(k*64) + (kk>>4)*1024 + (n&63)*16 + (kk&15)]
//         = raw[kk*n + n]
//     (byte-exact bijection 41 x 384 x 64 x 16 = k*n = 16,121,856; same byte
//     count, same buffer and same captured addresses; every other (K, N)
//     keeps the identity copy). Each [64, 64] B tile of a 64-K stage is then
//     FOUR contiguous 1-KiB slabs (one per 16-k-run) and every staging vector
//     is a 16-byte-aligned contiguous k-run of one column, so a warp's 32
//     x 16-byte B staging loads touch 4 FULLY-USED 128-byte lines instead of
//     32 half-used ones (8x fewer line requests per warp-load; the tile's line
//     footprint is 32 fully-used lines instead of 64 half-used ones).
//     The ONLY kernel change is the two B global-load sites (prologue +
//     steady-state prefetch) of the dispatched
//     w8a8_dumma_prefill_packedb_db_kernel<128, 64, 64>: byte
//     (n0>>6)*(k*64) + ((k0>>4)+k16)*1024 + n_row*16 replaces
//     (n0+n_row)*k + k0 + k16*16. The LDS staging layout b_tile[2][64][72]
//     (two-half ds_write2_b64), the col_major load_frag8 consumes, the
//     k0-outer/kk-inner ascending int32 accumulation order, the coalesced
//     epilogue, the grid (41 x 32 = 1312 blocks), the block size (256 = 4
//     wavefronts), the retained double-buffered 64-K pipeline (one
//     __syncthreads per stage), LDS/block 27,648 B (2 blocks/CU = 8 waves/CU)
//     and the VGPR budget are ALL unchanged, so this is a pure global-layout
//     A/B.
//   * Correctness: the same weight elements reach the same fragment slots in
//     the same ascending k-chunk sequence, so every int32 accumulator -- and
//     every bf16 output byte -- is bit-identical to the accepted kernel and to
//     the scalar reference. The scalar fallback for (k, n) == (6144, 2624)
//     decodes the panel layout in ascending 16-byte k-runs (the paired M=2 /
//     M=16 API shapes with the same (N, K) stay byte-exact); the generic
//     identity arm, the round-2 n-major pack kernel (kept compiled as the
//     layout control) and every shape guard are untouched. Packing stays
//     outside the timed region and out of Graph capture.
//   * Predicted deltas: vmem_read_instructions unchanged (1,574,400), LDS
//     counters unchanged (lds_instructions 4,901,632, lds_wait 3,590,796,
//     conflicts at the merged-read alias floor 12,091,392), L2 misses strictly
//     below 3,250,848 with the hit rate up, operator read bytes strictly below
//     170,221,184 (B line fetches halve), median < 1153.970 us.
//   * Superseded by Round 5: the B-panel pack and the b_tile[2][64][72] LDS
//     form below are replaced by the fragment-interleaved swizzle.
//
// Round 5 (mandated packing round: one weight packing/swizzle that makes each
// DUMMA B tile vector-loadable and LDS-bank-safe):
//
//   * Baseline: the accepted double-buffered <128, 64, 64> kernel (official
//     median 937.431 us / p90 939.452 us; exact-source PMC
//     profiles/.../iteration4/pmc.json: profiled 889.453 us, grid 41x32 =
//     1312 blocks, 2 blocks/CU = 8 waves/CU, 27,648 B LDS, arch_vgpr 96 with
//     0 spills, lds_instructions 4,901,632 = 9.7 per wave-stage (6 merged
//     ds_read2_b64 + 3 ds_write2_b64), lds_wait 3,828,676,
//     lds_bank_conflicts 12,091,392 = 6 x 4 x 4 x 96 x 1312, vmem_read
//     1,574,400, L2 hit 90.39%). The surviving exposed LDS cost is the
//     b_tile row-major layout: each col_major B fragment is one ds_read_b64
//     at a 72-byte row stride, and the compiler merges the fragment pairs
//     into ds_read2_b64 whose +16-row second offset (16 x 72 = 1152 B =
//     9 x 128 B) aliases the same bank pairs -- one conflict per 16-lane
//     phase, exactly the measured 12,091,392 conflicts.
//   * Mechanism (ONE packing/swizzle, entirely in this file): replace the
//     Round-3 B-panel pack with a fragment-interleaved swizzle. For each
//     32-k x 16-n DUMMA B fragment block the 4 k8 groups x 16 n-rows x 8 B
//     are stored n-interleaved as [k8][n][8] (512 B per fragment block),
//     32-k major inside the 64-K stage:
//       packed[((kk>>5)*n16g + (col>>4))*512 +
//              (((kk>>3)&3)*16 + (col&15))*8 + (kk&7)] = raw[kk*n + col],
//     with n16g = n>>4 (164 for the exact shape). Byte-exact bijection
//     192 x 164 x 512 = k*n = 16,121,856: same byte count, same buffer and
//     same captured addresses (graph-stable), and packing still runs once,
//     outside the timed region and out of Graph capture.
//   * Kernel-side effect: every 16-byte B staging vector is now 2 n-rows x
//     8 B of one k8 of one fragment block, so the staging store is ONE
//     16-byte-aligned int4 (ds_write_b128) flat copy per thread (256 chunks
//     = one per thread per 64-K stage; a warp reads 8 fully-used 128-byte
//     lines) and every col_major B fragment is load_frag8_swz: lane
//     (n = lane&15, k8 = lane>>4) reads p + k8*128 + n*8, i.e. one
//     ds_read_b64 whose 16-lane phase spans exactly one 128-byte k8 block --
//     all 32 banks exactly once per phase, conflict-free by construction.
//     The A tile keeps its bank-safe 72-byte stride, and the double-buffered
//     64-K pipeline, the k0-outer/kk-inner ascending int32 order, the
//     coalesced epilogue, the grid (41x32 = 1312 blocks), the block
//     (256 threads = 4 wavefronts) and the occupancy (2 blocks/CU = 8
//     waves/CU) are all unchanged, so this is a pure packing/swizzle A/B.
//   * LDS: b_tile shrinks from 2 x [64, 72] = 9,216 B to 2 x 4,096 B; the
//     block total is 18,432 (A) + 8,192 (B) = 26,624 B, so 2 x 26,624 =
//     53,248 <= 65,536 B keeps 2 resident blocks/CU = 8 waves/CU.
//   * Correctness: the same weight elements reach the same fragment slots in
//     the same k0-outer/kk-inner ascending k-chunk sequence, so every int32
//     accumulator -- and every bf16 output byte -- is bit-identical to the
//     accepted kernel and to the scalar reference. The scalar fallback for
//     (k, n) == (6144, 2624) decodes the swizzle element-wise in ascending
//     kk (the paired M=2 / M=16 API shapes stay byte-exact); the generic
//     identity arm, the Round-2 n-major pack control and every shape guard
//     are untouched.
//   * Predicted deltas: vmem_read_instructions unchanged (~1,574,400),
//     LDS/block 27,648 -> 26,624 B, lds_bank_conflicts strictly below
//     12,091,392, lds_wait below 3,828,676, median < 937.431 us.
//     Falsifiable: retained only if median_us < 937.4308013916016,
//     mismatch_count == 0, max_abs_error == 0.0,
//     graph_capture_passed == true, the exact code object shows 0 spills /
//     LDS == 26,624 B / VGPR <= 128 (2 blocks/CU), and the PMC shows
//     lds_bank_conflicts and lds_wait strictly below the baseline with
//     vmem_read not growing; any regression restores the iteration-3 source.
//
// Round 6 (mandated epilogue round: fuse per-row/per-column scales, bf16
// conversion and the final coalesced store into the compute kernel; remove any
// unnecessary workspace/combine pass):
//
//   * Fusion audit (nothing to remove, so the fused epilogue is made cheaper).
//     The accepted source ALREADY fuses everything: store_prefill_fragment_
//     coalesced applies x_scale[row](per-row) * weight_scale[col](per-column),
//     converts to bf16 and writes one coalesced 8-byte store per lane, and the
//     exact-shape operator replay is a SINGLE dispatch -- the trusted PMC
//     (profiles/glm_tp8_fused_qkv_a_proj_m4096/iteration6/pmc.json, digest
//     7e5731dc..., compile key 120c807e...) reports operator_aggregate
//     kernel_count == 1, scratch_bytes == 0, vmem_write_instructions 41,984 =
//     8 x 4 x 1312 and write_bytes_per_operator_replay 21,500,384 = m*n*2, i.e.
//     there is no workspace, no split-K combine pass and no second Graph node
//     to remove; workspace_bytes is unused and workspace_split_k_capacity is
//     zero for this shape. The remaining epilogue cost is therefore the
//     conversion itself.
//   * Measured cost of the fused epilogue (exact gfx928 code object of the
//     current best, iteration6/current-best-isa/isa.txt). The dispatched
//     kernel is ~1,920 instructions; the steady-state K-stage loop body is 107
//     instructions (one `s_branch 65428` back-edge at 0x6BB8 -> 0x6A0C) and
//     the prologue is ~259, so the fused epilogue is ~1,490 static
//     instructions -- roughly 13% of the dynamic instruction stream over
//     96 stages. The dominant term is that this DTK lowers EACH of the 32
//     per-lane __float2bfloat16 calls to a ~13-instruction EXEC-masked
//     Inf/NaN sequence:
//       v_and_b32 (b & 0x7f800000) / v_cmp_ne_u32 / s_and_saveexec_b64 /
//       s_xor_b64 / v_bfe_u32 (bit 16) / v_add3_u32 (b + lsb + 0x7fff) /
//       s_andn2_saveexec_b64 / v_mov_b32 0 / v_or_b32 (b | 0x10000) /
//       v_cmp_eq_u32_sdwa / v_cndmask_b64 / s_or_b64 (restore EXEC)
//     so ~420 instructions per lane plus 4 x (3 shifts + 3 ors) of packing,
//     with 32 dependent SALU EXEC save/restore pairs that cannot be software-
//     pipelined and serialise the wavefront (the epilogue is the only place
//     VALU issues drop while the exact-shape kernel is 100% GRBM GUI-active).
//   * Focused change (ONE mechanism -- the bf16 conversion of the fused
//     epilogue -- entirely inside csrc/w8a8_gemm_hip.hip). Replace the library
//     conversion + shift/or pack in store_prefill_fragment_coalesced with the
//     branch-free round-to-nearest-even integer identity
//       bf16_rne_high16(v) = (b + 0x7fff + ((b >> 16) & 1)) >> 16,
//       b = __float_as_uint(v),
//     which the disassembly proves is exactly what the normal (finite) path of
//     the library conversion computes (v_bfe bit 16, v_add3 b + lsb + 0x7fff).
//     Adding 0x7fff + the retained bit-16 LSB cannot carry out of the sign, the
//     +((b>>16)&1) term rounds exact ties to an even LSB (RNE), max-float still
//     rounds to +/-Inf and 0.0/-0.0 and subnormal encodings are preserved, so
//     every 16-bit payload is identical. Every value converted here is finite
//     by construction (|int32 dot| < 2^31 times finite dequant scales), so the
//     removed Inf/NaN special case is unreachable. Four values now pack into
//     one 8-byte word with three VALU ops (v_bfe/v_and + v_add3 + v_lshrrev)
//     instead of ~13 EXEC-bracketed instructions each, and the 32 EXEC
//     save/restore chains disappear. The epilogue structure, the per-row
//     x_scale gather, the per-column float4 weight_scale gather, the register
//     4x4 shuffle transpose, the multiply order float(dot) * x_scale *
//     weight_scale, the 8-byte-aligned coalesced store address, the grid
//     (41 x 32 = 1312), the block (256 = 4 wavefronts), the double-buffered
//     64-K pipeline, the swizzled packed B, LDS/block 26,624 B (2 blocks/CU =
//     8 waves/CU) and the 65,536 B workspace budget are ALL unchanged, so this
//     is a pure conversion A/B. The scalar fallback keeps __float2bfloat16 (it
//     is not on the timed path); the generic identity arm and every shape
//     guard are untouched.
//   * Predicted deltas: grid_blocks 1312, LDS/block 26,624 B, 2 blocks/CU =
//     8 waves/CU, vmem_read 1,574,400 and vmem_write 41,984 unchanged;
//     valu_instructions strictly below 23,920,384 and the epilogue's static
//     EXEC/SALU count down by >1,000; median < 918.191 us with no p90
//     regression. Falsifiable: retained only if median_us <= 909.0 us
//     (>= 1% round acceptance) and p90_us <= 919.530 us, mismatch_count == 0,
//     max_abs_error == 0.0, graph_capture_passed == true, the exact code
//     object shows 0 spills / LDS == 26,624 B / VGPR <= 128 (2 blocks/CU) and
//     no __float2bfloat16 EXEC sequence remains in the epilogue; otherwise the
//     iteration-5 source is restored.
//
// Round 9 (late ISA-diagnosis round; the control-plane plateau gate is CLOSED
// for this round -- phase hip_only, plateau false, raw inline asm and ISA
// Skills forbidden -- so this stays a HIP-only round):
//
//   * Bottleneck evidence (exact trusted gfx928 ISA of the current best,
//     profiles/glm_tp8_fused_qkv_a_proj_m4096/iteration6/current-best-isa/
//     isa.txt, digest 7e5731dc...; the round-6 source differs from that
//     profiled official best only in the bf16 conversion, so the steady-state
//     loop analysed here is the dispatched loop). The steady-state stage body
//     is 107 instructions (0x6A0C..0x6BB8, one back-edge `s_branch 65428` at
//     0x6BB8 -> 0x6A0C) and roughly 14 of them are pure A-row tail
//     predication:
//       0x6A0C..0x6A20  six unconditional `v_mov_b32` zero-fills of the two
//                       int4 staging vectors (v33/v34 and v37..v40),
//       0x6A24..0x6A34  `s_and_saveexec_b64` / `s_cbranch_execz` /
//                       `global_load_dwordx4` / `s_or_b64` for A vector 0,
//       0x6A38..0x6A50  two more `v_mov_b32` zero-fills (v35/v36) plus the
//                       same EXEC save/restore + uniform branch for A
//                       vector 1.
//     The guard source `a_pre[v] = (g_row < m) ? load : int4{0,0,0,0}` is
//     never false for the dispatched M=4096 (M / BM = 4096 / 128 = 32 exact),
//     yet its zero-fills execute unconditionally in every one of the 96
//     stages and its two EXEC read-modify-writes serialize the wavefront in
//     front of the very global loads that prefetch the next tile. That is
//     ~14/107 = 13% of the hot loop's instruction stream, on top of the
//     epilogue's per-fragment `row >= m` EXEC bracket (s_and_saveexec /
//     s_xor_b64 / s_andn2_saveexec_b64 / s_cbranch_execz / s_or_b64 around
//     each of the eight unrolled fragment stores), for a kernel the PMC shows
//     100% GRBM GUI-active yet issuing only ~0.42 instructions per cycle per
//     CU (lds_wait_instructions 5,302,705 against lds_instructions
//     4,901,632).
//   * Focused change (ONE mechanism -- exact-shape full-tile specialization,
//     entirely inside csrc/w8a8_gemm_hip.hip): the dispatched kernel gains a
//     compile-time `bool kFullTile` template parameter. The exact-shape guard
//     keeps `(m >= 128, n == 2624, k == 6144)` and the same grid (N/64 x
//     ceil(M/128)) and block (256 = 4 wavefronts), and selects
//     `kFullTile == true` exactly when the caller's m is a multiple of
//     BM = 128 -- i.e. when every block tile lies fully inside the output (the
//     assigned M=4096 case). In that instantiation the A staging loads
//     (prologue AND steady state) drop the `(g_row < m)` select / zero-fill
//     and the epilogue drops the per-fragment `row >= m` early return, so the
//     loop body keeps only the address math and the three coalesced
//     `global_load_dwordx4`. Every other m keeps the guarded instantiation
//     byte-for-byte (zero-fill, epilogue row mask, tail-block coverage), and
//     the paired M=2/M=16 API shapes with the same (N, K) still take the
//     scalar fallback because the `m >= 128` guard is untouched.
//   * Why this is the remaining lever and not a new pipeline: rounds 7
//     (deeper register prefetch / stage pairs) and 8 (smaller macro-tile, more
//     resident waves) both regressed, so the double-buffered 64-K stage (ONE
//     __syncthreads per stage, LDS 26,624 B/block, 2 blocks/CU = 8 waves/CU),
//     the 128 x 64 macro-tile, the fragment-interleaved packed B swizzle, the
//     load_frag8 / load_frag8_swz consumes, the k0-outer / kk-inner ascending
//     m16n16k32 int32 accumulation order and the fused branch-free bf16
//     epilogue are ALL retained unchanged. The round removes instructions that
//     are provably dead for this shape without touching any resource, any
//     memory access order or any MMA input.
//   * Correctness: for m % 128 == 0 no block tile crosses m, so the removed
//     guard predicate is never false and the removed zero-fill never reaches an
//     accumulator; the surviving assignments, the ascending k-chunk sequence
//     and the exact `float(dot) * x_scale * weight_scale` multiply order are
//     bit-identical to the guarded path (mismatch 0 / max_abs_error 0.0
//     expected). The guarded instantiation preserves the exact current
//     semantics for every m % 128 != 0.
//   * Predicted deltas: steady-state loop 107 -> ~93 instructions (the eight
//     zero-fills and the two EXEC save/restore + uniform-branch pairs removed),
//     valu_instructions strictly below 23,920,384, grid_blocks 1312,
//     block_threads 256, LDS/block 26,624 B, arch_vgpr <= 128 with 0 spills,
//     vmem_read_instructions 1,574,400, vmem_write_instructions 41,984 and the
//     epilogue store count all unchanged. Falsifiable: retained only if
//     median_us < 912.7147674560547 (the current shadow base) with no p90
//     regression, mismatch_count == 0, max_abs_error == 0.0,
//     graph_capture_passed == true, the exact code object shows 0 spills /
//     LDS == 26,624 B / VGPR <= 128 (2 blocks/CU) and the kFullTile symbol's
//     loop body no longer contains the A-guard
//     `s_and_saveexec`/`s_cbranch_execz`/zero-fill sequence; any median/p90
//     regression, mismatch, spill or occupancy loss restores the round-6
//     source.
//
// Include order is fixed by the control plane: hip_runtime, hip_bfloat16,
// then du_mma (this DTK's du_mma.h is not self-contained otherwise).

#include <hip/hip_runtime.h>
#include <hip/hip_bfloat16.h>
#include <du_mma.h>

#include <cstdint>

namespace {

constexpr int kWaveSize = 64;  // gfx928 native wavefront size
constexpr int kTileM = 16;
constexpr int kTileN = 16;
constexpr int kTileK = 32;  // INT8 DUMMA unit: m16n16k32, int32 accumulation
// 4 wavefronts; must remain a multiple of the gfx928 wavefront size (64).
constexpr int kThreadsPerBlock = 256;

// Exact assigned shape (K, N) after TP=8 partitioning.
constexpr int kExactN = 2624;
constexpr int kExactK = 6144;

using namespace du::dumma;

// Coalesced accumulator epilogue for gfx928 INT8 m16n16k32: the accumulator
// lane mapping is row = lane & 15, col_mod4 = lane >> 4, frag.x[i] maps to
// columns col_mod4 + 4*i. A register 4x4 transpose (two 2x2 steps with
// shfl_xor 16 then 32, one v_cndmask per element per step) re-routes the
// int32 values so lane (r, c4) owns the four CONTIGUOUS columns
// base_col + 4*c4 .. +3; they are scaled (float(dot) * x_scale[row] *
// weight_scale[col], the exact reference multiply order), converted to bf16,
// packed and stored with ONE 8-byte store per lane. The row >= m guard is
// wavefront-uniform (lane & 15 cycles the same 16 rows in every 16-lane
// group), so the shuffles never mix active and inactive lanes. base_col is a
// multiple of 64 for the dispatched tiles, so the float4 weight_scale load
// (col0 % 4 == 0) and the 8-byte store (n even -> offset a multiple of 8) are
// aligned.
//
// Round 6: the fused bf16 conversion itself is made branch-free. The exact
// gfx928 code object of the previous best lowers each of the 32 per-lane
// __float2bfloat16 calls to a ~13-instruction sequence that brackets an
// Inf/NaN special case with EXEC save/restore:
//   v_and_b32 (b & 0x7f800000) / v_cmp_ne_u32 / s_and_saveexec_b64 / s_xor_b64
//   / v_bfe_u32 (bit 16) / v_add3_u32 (b + lsb + 0x7fff) / s_andn2_saveexec_b64
//   / v_mov_b32 0 / v_or_b32 (b | 0x10000) / v_cmp_eq_u32_sdwa / v_cndmask_b64
//   / s_or_b64 (restore EXEC)
// The EXEC manipulation cannot be software-pipelined and serialises the
// wavefront. For every FINITE fp32 the library conversion is exactly
// round-to-nearest-even at bit 16, which is the branch-free integer identity
//     bf16 = (b + 0x7fff + ((b >> 16) & 1)) >> 16,   b = __float_as_uint(v)
// (adding 0x7fff + the retained bit-16 LSB never carries out of the sign, and
// the +((b>>16)&1) term breaks exact ties toward an even LSB, so max-float
// still rounds to +/-Inf and -0.0/0.0 are preserved). Every value converted
// here is finite by construction: |int32 dot| < 2^31 and the dequant scales
// are finite, so no Inf/NaN can reach the conversion. This yields the exact
// same 16-bit payloads as __float2bfloat16 while dropping the EXEC sequence
// and the separate shift/or pack (four bf16 pairs become three VALU ops per
// 8-byte word instead of 4 x 13 + 3).
__device__ __forceinline__ unsigned int bf16_rne_high16(float v) {
  const unsigned int b = __float_as_uint(v);
  return (b + 0x7fffu + ((b >> 16) & 1u)) >> 16;
}

// Round 9 adds the compile-time `kGuarded` flag: kGuarded == false is the
// exact-shape full-tile specialization (m % BM == 0), for which every row of
// every block tile is strictly inside the output, so the `row >= m` early
// return -- which the exact code object lowers to an EXEC save/restore pair
// plus a uniform branch around each of the eight unrolled fragment stores --
// is removed at compile time. The default kGuarded == true keeps the exact
// current semantics for every other m (including the generic arm and the
// single-buffered siblings, which never pass the flag).
template <bool kGuarded = true, typename AccFragment>
__device__ __forceinline__ void store_prefill_fragment_coalesced(
    const AccFragment& frag,
    const float* __restrict__ x_scale,
    const float* __restrict__ weight_scale,
    hip_bfloat16* __restrict__ out,
    int m,
    int n,
    int base_row,
    int base_col,
    int lane) {
  const int row = base_row + (lane & 15);
  if (kGuarded) {
    if (row >= m) {
      return;
    }
  }
  const int c4 = lane >> 4;  // 0..3
  const int x0 = frag.x[0];
  const int x1 = frag.x[1];
  const int x2 = frag.x[2];
  const int x3 = frag.x[3];
  // Step 1: transpose the 2x2 in-block pairs (c4 bit0 <-> element bit0).
  const int s0 = __shfl_xor(x0, 16, kWaveSize);
  const int s1 = __shfl_xor(x1, 16, kWaveSize);
  const int s2 = __shfl_xor(x2, 16, kWaveSize);
  const int s3 = __shfl_xor(x3, 16, kWaveSize);
  const bool lo = (c4 & 1) == 0;
  const int a0 = lo ? x0 : s1;
  const int a1 = lo ? s0 : x1;
  const int a2 = lo ? x2 : s3;
  const int a3 = lo ? s2 : x3;
  // Step 2: transpose the 2x2 blocks (c4 bit1 <-> element bit1).
  const int t0 = __shfl_xor(a0, 32, kWaveSize);
  const int t1 = __shfl_xor(a1, 32, kWaveSize);
  const int t2 = __shfl_xor(a2, 32, kWaveSize);
  const int t3 = __shfl_xor(a3, 32, kWaveSize);
  const bool hi = (c4 & 2) == 0;
  const int f0 = hi ? a0 : t2;
  const int f1 = hi ? a1 : t3;
  const int f2 = hi ? t0 : a2;
  const int f3 = hi ? t1 : a3;

  // Lane (r, c4) now owns columns base_col + 4*c4 .. +3 (8 B, 8-byte
  // aligned: base_col is a multiple of 64, n*2 is a multiple of 8).
  const int col0 = base_col + 4 * c4;
  const float xs = x_scale[row];
  const float4 ws = *reinterpret_cast<const float4*>(weight_scale + col0);
  const float v0 = static_cast<float>(f0) * xs * ws.x;
  const float v1 = static_cast<float>(f1) * xs * ws.y;
  const float v2 = static_cast<float>(f2) * xs * ws.z;
  const float v3 = static_cast<float>(f3) * xs * ws.w;
  const uint64_t packed =
      static_cast<uint64_t>(
          bf16_rne_high16(v0) |
          (bf16_rne_high16(v1) << 16)) |
      (static_cast<uint64_t>(
           bf16_rne_high16(v2) |
           (bf16_rne_high16(v3) << 16))
       << 32);
  *reinterpret_cast<uint64_t*>(out + static_cast<int64_t>(row) * n + col0) =
      packed;
}

// Explicit 8-byte int8 fragment loader (lineage-validated load_frag8): for
// BOTH the row_major matrix_a and the col_major matrix_b m16n16k32 fragments,
// lane l -> row (l & 15), k-quarter (l >> 4) holds the EIGHT CONTIGUOUS bytes
// at p[row * ldm + (l >> 4) * 8 .. +7]. Loading the 8 bytes as one int64
// forces the ds_read_b64 form (16-lane phases, distinct bank pairs per group
// -> the 4-phase conflict-free floor with an odd 8-byte LDS row stride),
// identical fragment values to the library loader, so the v_mmac inputs and
// the exact int32 accumulation order are unchanged. `lane` is
// threadIdx.x % kWaveSize, so no wave-id builtin is required.
template <typename Frag>
__device__ __forceinline__ void load_frag8(
    Frag& f,
    const int8_t* __restrict__ p,
    unsigned ldm,
    int lane) {
  const unsigned row = static_cast<unsigned>(lane) & 0xfu;
  const unsigned kq = static_cast<unsigned>(lane) >> 4;
  const int64_t v = *reinterpret_cast<const int64_t*>(p + row * ldm + (kq << 3));
  reinterpret_cast<int64_t*>(f.x)[0] = v;
}

// Round-5 fragment-interleaved B swizzle helpers.
//
// Each 32-k x 16-n DUMMA B fragment block is 512 B = [k8 0..3][n 0..15][8 B]
// (n-interleaved k8 groups). The 16-byte chunk (k32, n16, k8, n_pair) holds
// the two 8-byte k-runs of n-rows 2*n_pair and 2*n_pair+1 of one k8 group,
// and sits at byte (k32 * n16g + n16) * 512 + k8 * 128 + n_pair * 16 of the
// packed [n>>4][k>>5][512 B] array (n16g = n>>4). Global elements satisfy
// packed element (col, kk) at ((kk>>5)*n16g + (col>>4))*512 +
// (((kk>>3)&3)*16 + (col&15))*8 + (kk&7) -- the exact inverse of this chunk
// map, so staging is a flat 16-byte copy and the fragment load reads the
// same bytes the Round-3 layout delivered.
__device__ __forceinline__ int64_t packed_b_swz_offset(
    int k32,
    int n16,
    int n16g,
    int k8,
    int n_pair) {
  return (static_cast<int64_t>(k32) * n16g + n16) * 512 +
         static_cast<int64_t>(k8) * 128 + (n_pair << 4);
}

// Round-5 col_major B fragment loader on the swizzled tile: lane (n = lane&15,
// k8 = lane>>4) reads p + k8*128 + n*8. One ds_read_b64 per fragment and each
// 16-lane phase spans exactly one 128-byte k8 block (each bank exactly once),
// so the read is conflict-free by construction. Byte placement is identical to
// load_frag8, so the v_mmac operands and the int32 accumulation stay
// bit-exact.
template <typename Frag>
__device__ __forceinline__ void load_frag8_swz(
    Frag& f,
    const int8_t* __restrict__ p,
    int lane) {
  const unsigned n = static_cast<unsigned>(lane) & 0xfu;
  const unsigned k8 = static_cast<unsigned>(lane) >> 4;
  const int64_t v =
      *reinterpret_cast<const int64_t*>(p + (k8 << 7) + (n << 3));
  reinterpret_cast<int64_t*>(f.x)[0] = v;
}

// Generic native INT8 DUMMA m16n16k32 tiled prefill kernel with the identity
// [K, N] weight layout (packed_weight == raw logical weight for every (K, N)
// other than the exact assigned pair). Template parameters: BM x BN output
// tile per block, StageK K rows per single-buffered LDS stage. 256 threads =
// 4 wavefronts; each wave owns a (BM/2) x (BN/2) quadrant of m16n16k32 int32
// accumulator fragments. Grid = (N/BN) x (ceil(M/BM)).
//
// K is staged cooperatively in a SINGLE LDS buffer at StageK granularity with
// TWO __syncthreads per stage (one after the staging stores, one after all
// waves consumed the buffer):
//   * A[BM, StageK] is staged row-major with flat 16-byte vectors (each thread
//     strides over kAVectors = BM*StageK/16 vectors); rows past M are
//     zero-filled and masked in the epilogue.
//   * B[StageK, BN] is staged row-major from the logical [K, N] weight with
//     flat 16-byte vectors. The dispatch guarantees n % BN == 0 and
//     k % StageK == 0, so every global vector is aligned and in-bounds.
//   * Fragment loads use the library du_load_matrix_sync (row_major for both
//     operands) and accumulate with du_mma_sync in ascending k order --
//     k0-outer over stages, kk-inner over kTileK steps -- preserving the exact
//     int32 accumulation order of the scalar reference.
//   * The epilogue is the coalesced fragment store above.
template <int BM, int BN, int StageK>
__global__ __launch_bounds__(kThreadsPerBlock) void
w8a8_dumma_prefill_tiled_kernel(
    const int8_t* __restrict__ x_q,          // [M, K] row-major
    const int8_t* __restrict__ weight,       // [K, N] row-major (identity pack)
    const float* __restrict__ x_scale,       // [M]
    const float* __restrict__ weight_scale,  // [N]
    hip_bfloat16* __restrict__ out,          // [M, N]
    int m,
    int n,
    int k) {
  constexpr int kWaveM16 = BM / 32;
  constexpr int kWaveN16 = BN / 32;
  static_assert(BM % 32 == 0 && BN % 32 == 0,
                "block tile must be a multiple of the wave quadrant");
  static_assert(kThreadsPerBlock % kWaveSize == 0,
                "blockDim must be a multiple of the gfx928 wavefront size");

  const int tid = static_cast<int>(threadIdx.x);
  const int wave = tid / kWaveSize;
  const int lane = tid % kWaveSize;
  const int wave_row = wave >> 1;  // 0 or 1
  const int wave_col = wave & 1;   // 0 or 1
  const int m0 = static_cast<int>(blockIdx.y) * BM;
  const int n0 = static_cast<int>(blockIdx.x) * BN;

  __shared__ __align__(16) int8_t a_tile[BM * StageK];
  __shared__ __align__(16) int8_t b_tile[StageK * BN];

  DUFragment<matrix_a, kTileM, kTileN, kTileK, signed char, row_major>
      a_frag[kWaveM16];
  DUFragment<matrix_b, kTileM, kTileN, kTileK, signed char, row_major>
      b_frag[kWaveN16];
  DUFragment<accumulator, kTileM, kTileN, kTileK, int>
      acc[kWaveM16][kWaveN16];
#pragma unroll
  for (int j = 0; j < kWaveM16; ++j) {
#pragma unroll
    for (int i = 0; i < kWaveN16; ++i) {
      du_fill_fragment(acc[j][i], 0);
    }
  }

  // Flat 16-byte staging vectors per stage (compile-time; the dispatch
  // guarantees k % StageK == 0 and n % BN == 0).
  constexpr int kAVectors = BM * StageK / static_cast<int>(sizeof(int4));
  constexpr int kBVectors = StageK * BN / static_cast<int>(sizeof(int4));

  for (int k0 = 0; k0 < k; k0 += StageK) {
    // Stage A[BM, StageK]: thread `vec` owns the 16-byte chunk at flat byte
    // offset vec*16 (row = offset / StageK, k-run = offset % StageK).
    for (int vec = tid; vec < kAVectors; vec += kThreadsPerBlock) {
      const int byte_off = vec * static_cast<int>(sizeof(int4));
      const int local_row = byte_off / StageK;
      const int kk = byte_off - local_row * StageK;
      const int g_row = m0 + local_row;
      reinterpret_cast<int4*>(a_tile)[vec] =
          (g_row < m)
              ? *reinterpret_cast<const int4*>(
                    x_q + static_cast<int64_t>(g_row) * k + k0 + kk)
              : int4{0, 0, 0, 0};
    }
    // Stage B[StageK, BN] from the logical [K, N] weight: thread `vec` owns
    // the 16-byte chunk at (kk = offset / BN, col = offset % BN).
    for (int vec = tid; vec < kBVectors; vec += kThreadsPerBlock) {
      const int byte_off = vec * static_cast<int>(sizeof(int4));
      const int kk = byte_off / BN;
      const int col = byte_off - kk * BN;
      reinterpret_cast<int4*>(b_tile)[vec] =
          *reinterpret_cast<const int4*>(
              weight + static_cast<int64_t>(k0 + kk) * n + n0 + col);
    }
    // Make the staged tiles visible to every wavefront.
    __syncthreads();

    // Consume the stage: each wave accumulates its (BM/2) x (BN/2) quadrant
    // with kk-ascending m16n16k32 MMAs.
    const int local_row = wave_row * (BM / 2);
    const int local_col = wave_col * (BN / 2);
#pragma unroll
    for (int kk = 0; kk < StageK; kk += kTileK) {
#pragma unroll
      for (int j = 0; j < kWaveM16; ++j) {
        du_load_matrix_sync(
            a_frag[j], a_tile + (local_row + j * kTileM) * StageK + kk,
            StageK);
      }
#pragma unroll
      for (int i = 0; i < kWaveN16; ++i) {
        du_load_matrix_sync(
            b_frag[i], b_tile + kk * BN + local_col + i * kTileN, BN);
      }
#pragma unroll
      for (int j = 0; j < kWaveM16; ++j) {
#pragma unroll
        for (int i = 0; i < kWaveN16; ++i) {
          du_mma_sync(acc[j][i], a_frag[j], b_frag[i], acc[j][i]);
        }
      }
    }
    // Single buffer: every wavefront must finish reading LDS before the next
    // stage's stores overwrite it.
    __syncthreads();
  }

  const int base_row = m0 + wave_row * (BM / 2);
  const int base_col = n0 + wave_col * (BN / 2);
#pragma unroll
  for (int j = 0; j < kWaveM16; ++j) {
#pragma unroll
    for (int i = 0; i < kWaveN16; ++i) {
      store_prefill_fragment_coalesced(
          acc[j][i], x_scale, weight_scale, out, m, n,
          base_row + j * kTileM, base_col + i * kTileN, lane);
    }
  }
}

// Round-1 packed-weight architecture kernel, kept as the single-buffered
// 128-K sibling of the dispatched <128, 64, 64> double-buffered kernel below
// (Round 2 moved the exact-shape dispatch to that sibling; Round 3 keeps this
// kernel compiled but undispatched as the n-major layout / single-buffer
// control, and only the double-buffered kernel reads the packed B; Round 5
// replaces that packed B layout with the fragment-interleaved swizzle, so this
// n-major control no longer matches the pack either). It is defined for
// the n-major packed_weight[n * K + kk] = raw[kk * N + n] layout produced by
// launch_pack_w8a8_weight. SAME geometry as the bootstrap
// w8a8_dumma_prefill_tiled_kernel<128, 64, 128>:
// grid (N/64) x (M/128) = 41 x 32 = 1312 blocks, 256 threads = 4 wavefronts,
// one 64 x 32 quadrant of eight m16n16k32 int32 accumulators per wave,
// single-buffered 128-K LDS stage with TWO __syncthreads per stage, same
// k0-outer/kk-inner ascending int32 accumulation order, same coalesced
// fragment epilogue. The two differences, both inside the operand path:
//   * B is staged n-major (b_tile[n_row][kk] from the packed [N, K] weight)
//     so col_major B fragments are 8 contiguous K bytes per lane and staging
//     is one coalesced 16-byte vector per (n_row, k16) pair;
//   * A and B LDS row strides are 136 B (StageK + 8): 8-byte aligned with an
//     odd 8-byte count (136/8 = 17) so the 16 rows of each 16-lane ds_read_b64
//     phase land on 16 distinct bank pairs (the conflict-free 4-phase floor),
//     and 136 % 16 == 8 keeps the two-half int64 staging form.
// Both fragment loaders are the explicit load_frag8 above; the staged bytes
// are the same matrix elements in the same fragment slots as the library
// loaders produced from the identity layout, so every v_mmac input and the
// exact int32 accumulation (k0-outer over 48 stages, kk-inner ascending over
// four m16n16k32 steps) are bit-identical to the bootstrap kernel and to the
// scalar reference.
template <int BM, int BN, int StageK>
__global__ __launch_bounds__(kThreadsPerBlock) void
w8a8_dumma_prefill_packedb_kernel(
    const int8_t* __restrict__ x_q,          // [M, K] row-major
    const int8_t* __restrict__ packed_w,     // [N, K] n-major (exact shape)
    const float* __restrict__ x_scale,       // [M]
    const float* __restrict__ weight_scale,  // [N]
    hip_bfloat16* __restrict__ out,          // [M, N]
    int m,
    int n,
    int k) {
  constexpr int kWaveM16 = BM / 32;
  constexpr int kWaveN16 = BN / 32;
  static_assert(BM % 32 == 0 && BN % 32 == 0,
                "block tile must be a multiple of the wave quadrant");
  static_assert(kThreadsPerBlock % kWaveSize == 0,
                "blockDim must be a multiple of the gfx928 wavefront size");
  // Bank-safe LDS row stride: StageK + 8 bytes = 34 dwords for StageK = 128.
  // 8-aligned with an odd 8-byte count -> every lane's 8-byte fragment is a
  // ds_read_b64 at the 4-phase conflict-free floor (see the kernel comment
  // above); 8 mod 16 keeps the two-half staging store form.
  constexpr int kLdsStride = StageK + 8;
  static_assert(kLdsStride % 8 == 0 && (kLdsStride / 8) % 2 == 1,
                "LDS row stride must be 8-aligned with an odd 8-byte count");
  static_assert(kLdsStride % 16 == 8,
                "LDS row stride must be 8 mod 16 for the two-half staging");

  const int tid = static_cast<int>(threadIdx.x);
  const int wave = tid / kWaveSize;
  const int lane = tid % kWaveSize;
  const int wave_row = wave >> 1;  // 0 or 1
  const int wave_col = wave & 1;   // 0 or 1
  const int m0 = static_cast<int>(blockIdx.y) * BM;
  const int n0 = static_cast<int>(blockIdx.x) * BN;

  __shared__ __align__(16) int8_t a_tile[BM * kLdsStride];
  __shared__ __align__(16) int8_t b_tile[BN * kLdsStride];

  DUFragment<matrix_a, kTileM, kTileN, kTileK, signed char, row_major>
      a_frag[kWaveM16];
  DUFragment<matrix_b, kTileM, kTileN, kTileK, signed char, col_major>
      b_frag[kWaveN16];
  DUFragment<accumulator, kTileM, kTileN, kTileK, int>
      acc[kWaveM16][kWaveN16];
#pragma unroll
  for (int j = 0; j < kWaveM16; ++j) {
#pragma unroll
    for (int i = 0; i < kWaveN16; ++i) {
      du_fill_fragment(acc[j][i], 0);
    }
  }

  // Flat 16-byte staging vectors per stage (the dispatch guarantees
  // k % StageK == 0 and n % BN == 0). 8 vectors per StageK row for 128.
  constexpr int kVecsPerRow = StageK / static_cast<int>(sizeof(int4));
  constexpr int kAVectors = BM * StageK / static_cast<int>(sizeof(int4));
  constexpr int kBVectors = StageK * BN / static_cast<int>(sizeof(int4));

  for (int k0 = 0; k0 < k; k0 += StageK) {
    // Stage A[BM, StageK] row-major with the bank-safe row stride: thread
    // `vec` owns the 16-byte chunk at (local_row, k16); rows past M are
    // zero-filled and masked in the epilogue.
    for (int vec = tid; vec < kAVectors; vec += kThreadsPerBlock) {
      const int local_row = vec / kVecsPerRow;
      const int k16 = vec - local_row * kVecsPerRow;
      const int g_row = m0 + local_row;
      int4 v{0, 0, 0, 0};
      if (g_row < m) {
        v = *reinterpret_cast<const int4*>(
            x_q + static_cast<int64_t>(g_row) * k + k0 + k16 * 16);
      }
      // Two 8-byte halves: the row stride is 8 mod 16, so odd rows are not
      // 16-byte aligned and a single int4 LDS store is illegal. The int64
      // pair lowers to one ds_write2_b64 per thread.
      const int64_t* src64 = reinterpret_cast<const int64_t*>(&v);
      int64_t* dst64 = reinterpret_cast<int64_t*>(
          a_tile + local_row * kLdsStride + k16 * 16);
      dst64[0] = src64[0];
      dst64[1] = src64[1];
    }
    // Stage B[BN, StageK] n-major from the packed [N, K] weight: thread `vec`
    // owns the 16-byte chunk at (n_row, k16); the K axis is always in range.
    for (int vec = tid; vec < kBVectors; vec += kThreadsPerBlock) {
      const int n_row = vec / kVecsPerRow;
      const int k16 = vec - n_row * kVecsPerRow;
      const int4 v = *reinterpret_cast<const int4*>(
          packed_w + static_cast<int64_t>(n0 + n_row) * k + k0 + k16 * 16);
      const int64_t* src64 = reinterpret_cast<const int64_t*>(&v);
      int64_t* dst64 = reinterpret_cast<int64_t*>(
          b_tile + n_row * kLdsStride + k16 * 16);
      dst64[0] = src64[0];
      dst64[1] = src64[1];
    }
    // Make the staged tiles visible to every wavefront.
    __syncthreads();

    // Consume the stage: each wave accumulates its (BM/2) x (BN/2) quadrant
    // with kk-ascending m16n16k32 MMAs; one ds_read_b64 per fragment.
    const int local_row = wave_row * (BM / 2);
    const int local_col = wave_col * (BN / 2);
#pragma unroll
    for (int kk = 0; kk < StageK; kk += kTileK) {
#pragma unroll
      for (int j = 0; j < kWaveM16; ++j) {
        load_frag8(
            a_frag[j],
            a_tile + (local_row + j * kTileM) * kLdsStride + kk,
            static_cast<unsigned>(kLdsStride),
            lane);
      }
#pragma unroll
      for (int i = 0; i < kWaveN16; ++i) {
        load_frag8(
            b_frag[i],
            b_tile + (local_col + i * kTileN) * kLdsStride + kk,
            static_cast<unsigned>(kLdsStride),
            lane);
      }
#pragma unroll
      for (int j = 0; j < kWaveM16; ++j) {
#pragma unroll
        for (int i = 0; i < kWaveN16; ++i) {
          du_mma_sync(acc[j][i], a_frag[j], b_frag[i], acc[j][i]);
        }
      }
    }
    // Single buffer: every wavefront must finish reading LDS before the next
    // stage's stores overwrite it.
    __syncthreads();
  }

  const int base_row = m0 + wave_row * (BM / 2);
  const int base_col = n0 + wave_col * (BN / 2);
#pragma unroll
  for (int j = 0; j < kWaveM16; ++j) {
#pragma unroll
    for (int i = 0; i < kWaveN16; ++i) {
      store_prefill_fragment_coalesced(
          acc[j][i], x_scale, weight_scale, out, m, n,
          base_row + j * kTileM, base_col + i * kTileN, lane);
    }
  }
}

// Round 9 exact-shape A-staging load. For the dispatched M=4096 every 128-row
// block tile lies fully inside the output, so the `(g_row < m)` row guard is
// dead: the exact code object lowers it to eight unconditional zero-fill
// `v_mov_b32` plus two EXEC save/restore (`s_and_saveexec_b64` /
// `s_cbranch_execz` / `s_or_b64`) uniform-branch pairs per K stage, i.e. ~14
// of the 107 steady-state loop instructions and an EXEC serialization in
// front of the very `global_load_dwordx4`s that prefetch the next tile. The
// kFullTile instantiation removes the select (one coalesced load per staging
// vector, no zero-fill), while kFullTile == false keeps the zero-fill + row
// mask semantics identical to the current kernel for every m % 128 != 0.
template <bool kFullTile>
__device__ __forceinline__ int4 load_a_stage_vec(
    const int8_t* __restrict__ x_q,
    int64_t offset,
    int m,
    int g_row) {
  if (kFullTile) {
    return *reinterpret_cast<const int4*>(x_q + offset);
  }
  return (g_row < m) ? *reinterpret_cast<const int4*>(x_q + offset)
                     : int4{0, 0, 0, 0};
}

// Round-2 double-buffered packed-B prefill kernel, dispatched ONLY for
// (m >= 128, n == 2624, k == 6144). SAME macro-tile and SAME operand path as
// the accepted w8a8_dumma_prefill_packedb_kernel<128, 64, 128>: grid
// (N/64) x (M/128) = 41 x 32 = 1312 blocks, 256 threads = 4 wavefronts, one
// 64 x 32 quadrant of eight m16n16k32 int32 accumulators per wave, packed
// n-major B, explicit load_frag8 reads, coalesced epilogue. The ONLY change is
// the K pipeline (see the Round-2 section of the file header):
//   * 64-K DOUBLE-buffered stages (2 x 13,824 = 27,648 B LDS/block, still
//     2 blocks/CU = 8 waves/CU): the stage-(s+1) global loads are issued into
//     3 int4 staging registers per thread BEFORE the stage-s consume and
//     flushed into the idle LDS buffer after it, so the VMEM latency of stage
//     s+1 overlaps the LDS/v_mmac work of stage s (one __syncthreads per
//     stage instead of two);
//   * k0-outer over 96 ASCENDING 64-K stages with kk-inner ascending over two
//     m16n16k32 steps, i.e. the same (k0 + kk) k-chunk sequence
//     0, 32, 64, 96, ... as the accepted 48 x 128-K stages, so every int32
//     accumulator is bit-identical.
// kLdsStride = StageK + 8 = 72 B: 8-aligned with an odd 8-byte count (9) so
// the 16 rows of each 16-lane ds_read_b64 phase land on 16 distinct bank pairs
// (18r mod 32, r = 0..15) -- the conflict-free 4-phase floor -- and
// 72 % 16 == 8 keeps the two-half ds_write2_b64 staging form.
//
// Round 5 additionally reads the packed B operand from the fragment-
// interleaved swizzle (see w8a8_pack_bswz_i8_kernel and the Round-5 header
// section): the LDS b_tile is now the SAME [k32][n16][k8][n][8] layout as the
// pack (2 x 256 16-byte chunks per 64-K stage), so staging is one flat
// 16-byte copy per thread and each col_major B fragment is one conflict-free
// ds_read_b64 (load_frag8_swz). The int32 accumulation order is untouched.
//
// Round 9 adds the compile-time `kFullTile` flag: it is true exactly when the
// caller's m is a multiple of BM, so every block tile is fully inside the
// output. In that instantiation the A staging loads drop the row guard (see
// load_a_stage_vec) and the epilogue drops the per-fragment row mask (see
// store_prefill_fragment_coalesced<false>); false keeps the guarded form
// byte-for-byte. Geometry, resources, operand path and accumulation order are
// identical in both instantiations.
template <int BM, int BN, int StageK, bool kFullTile = false>
__global__ __launch_bounds__(kThreadsPerBlock) void
w8a8_dumma_prefill_packedb_db_kernel(
    const int8_t* __restrict__ x_q,          // [M, K] row-major
    const int8_t* __restrict__ packed_w,     // [n>>4][k>>5][512 B] swizzled B
                                             // fragment blocks (round-5 layout)
    const float* __restrict__ x_scale,       // [M]
    const float* __restrict__ weight_scale,  // [N]
    hip_bfloat16* __restrict__ out,          // [M, N]
    int m,
    int n,
    int k) {
  constexpr int kWaveM16 = BM / 32;
  constexpr int kWaveN16 = BN / 32;
  static_assert(BM % 32 == 0 && BN % 32 == 0,
                "block tile must be a multiple of the wave quadrant");
  static_assert(kThreadsPerBlock % kWaveSize == 0,
                "blockDim must be a multiple of the gfx928 wavefront size");
  constexpr int kLdsStride = StageK + 8;
  static_assert(kLdsStride % 8 == 0 && (kLdsStride / 8) % 2 == 1,
                "LDS row stride must be 8-aligned with an odd 8-byte count");
  static_assert(kLdsStride % 16 == 8,
                "LDS row stride must be 8 mod 16 for the two-half staging");
  // Round 5: the packed B weight is the fragment-interleaved swizzle (see
  // w8a8_pack_bswz_i8_kernel), defined for BN == 64 and StageK == 64 (one
  // 32-k x 16-n fragment block per 512 B; 2 k32 blocks x 4 n16 groups x 4 k8
  // groups x 8 n-pairs = 256 16-byte chunks per stage, one per thread). Only
  // <128, 64, 64> is ever dispatched by the exact-shape guard, so the chunk
  // index math below is exact.
  static_assert(BN == 64 && StageK == 64,
                "swizzled B pack requires BN == 64 and StageK == 64");

  const int tid = static_cast<int>(threadIdx.x);
  const int wave = tid / kWaveSize;
  const int lane = tid % kWaveSize;
  const int wave_row = wave >> 1;  // 0 or 1
  const int wave_col = wave & 1;   // 0 or 1
  const int m0 = static_cast<int>(blockIdx.y) * BM;
  const int n0 = static_cast<int>(blockIdx.x) * BN;
  const int kStages = k / StageK;  // dispatch guarantees k % StageK == 0
  const int n16g = n >> 4;         // 16-n row groups per 32-k block of the pack

  __shared__ __align__(16) int8_t a_tile[2][BM * kLdsStride];
  // Round-5 swizzled B tile: flat [k32][n16][k8][n_pair][16 B] = 4,096 B per
  // 64-K stage, byte-identical to the packed global layout of that stage.
  __shared__ __align__(16) int8_t b_tile[2][BN * StageK];

  DUFragment<matrix_a, kTileM, kTileN, kTileK, signed char, row_major>
      a_frag[kWaveM16];
  DUFragment<matrix_b, kTileM, kTileN, kTileK, signed char, col_major>
      b_frag[kWaveN16];
  DUFragment<accumulator, kTileM, kTileN, kTileK, int>
      acc[kWaveM16][kWaveN16];
#pragma unroll
  for (int j = 0; j < kWaveM16; ++j) {
#pragma unroll
    for (int i = 0; i < kWaveN16; ++i) {
      du_fill_fragment(acc[j][i], 0);
    }
  }

  // Flat 16-byte staging vectors per stage. For the dispatched <128, 64, 64>
  // instantiation the 512 A vectors and 256 B vectors divide evenly over the
  // 256 threads (2 + 1 per thread), so the prefetch payload is 3 int4 staging
  // registers held live across the consume.
  constexpr int kVecsPerRow = StageK / static_cast<int>(sizeof(int4));
  constexpr int kAVectors = BM * StageK / static_cast<int>(sizeof(int4));
  constexpr int kBVectors = StageK * BN / static_cast<int>(sizeof(int4));
  constexpr int kAVecPerThread = kAVectors / kThreadsPerBlock;
  constexpr int kBVecPerThread = kBVectors / kThreadsPerBlock;
  static_assert(kAVectors % kThreadsPerBlock == 0 &&
                    kBVectors % kThreadsPerBlock == 0,
                "staging vectors must divide evenly across the block");
  // Round 5: the swizzled B stage is exactly one 16-byte chunk per thread, so
  // thread `vec` = tid is also the flat [k32][n16][k8][n_pair] chunk index.
  static_assert(kBVecPerThread == 1 && kBVectors == kThreadsPerBlock,
                "swizzled B staging must be one 16-B chunk per thread");

  int4 a_pre[kAVecPerThread];
  int4 b_pre[kBVecPerThread];

  // ---- Prologue: issue the stage-0 global loads, flush them into buffer 0 and
  // make the tile visible to every wavefront.
  {
    const int k0 = 0;
#pragma unroll
    for (int v = 0; v < kAVecPerThread; ++v) {
      const int vec = tid + v * kThreadsPerBlock;
      const int local_row = vec / kVecsPerRow;
      const int k16 = vec - local_row * kVecsPerRow;
      const int g_row = m0 + local_row;
      a_pre[v] = load_a_stage_vec<kFullTile>(
          x_q, static_cast<int64_t>(g_row) * k + k0 + k16 * 16, m, g_row);
    }
#pragma unroll
    for (int v = 0; v < kBVecPerThread; ++v) {
      const int vec = tid + v * kThreadsPerBlock;
      // Round 5: the 16-byte chunk (k32 = vec>>7, n16 = (vec>>5)&3,
      // k8 = (vec>>3)&3, n_pair = vec&7) of the swizzled pack sits at byte
      // ((k0>>5)+k32)*n16g*512 + ((n0>>4)+n16)*512 + k8*128 + n_pair*16;
      // consecutive lanes read consecutive 16-byte chunks, so a warp's
      // staging loads touch 8 fully-used 128-byte lines.
      b_pre[v] = *reinterpret_cast<const int4*>(
          packed_w +
          packed_b_swz_offset((k0 >> 5) + (vec >> 7),
                              (n0 >> 4) + ((vec >> 5) & 3), n16g,
                              (vec >> 3) & 3, vec & 7));
    }
#pragma unroll
    for (int v = 0; v < kAVecPerThread; ++v) {
      const int vec = tid + v * kThreadsPerBlock;
      const int local_row = vec / kVecsPerRow;
      const int k16 = vec - local_row * kVecsPerRow;
      const int64_t* src64 = reinterpret_cast<const int64_t*>(&a_pre[v]);
      int64_t* dst64 = reinterpret_cast<int64_t*>(
          a_tile[0] + local_row * kLdsStride + k16 * 16);
      dst64[0] = src64[0];
      dst64[1] = src64[1];
    }
#pragma unroll
    for (int v = 0; v < kBVecPerThread; ++v) {
      const int vec = tid + v * kThreadsPerBlock;
      // Round 5: the swizzled tile is a flat copy of the packed stage, so the
      // commit is ONE 16-byte-aligned int4 (ds_write_b128) per thread.
      *reinterpret_cast<int4*>(b_tile[0] + vec * 16) = b_pre[v];
    }
  }
  __syncthreads();

  // ---- Steady state: for stage s, issue the stage-(s+1) global loads into the
  // staging registers BEFORE consuming stage s from buffer s&1, then flush the
  // prefetched vectors into the idle buffer (s+1)&1 and close the stage with
  // ONE __syncthreads (so the vmcnt wait for stage s+1 lands after the MMAC
  // burst of stage s, overlapping the VMEM latency of s+1 with the stage-s
  // LDS/v_mmac work). The last stage is consumed after the loop without a
  // trailing barrier.
  for (int s = 0; s < kStages - 1; ++s) {
    // Prefetch stage s+1: issue the global loads (held in VGPRs while the
    // stage-s consume runs).
    const int k0 = (s + 1) * StageK;
#pragma unroll
    for (int v = 0; v < kAVecPerThread; ++v) {
      const int vec = tid + v * kThreadsPerBlock;
      const int local_row = vec / kVecsPerRow;
      const int k16 = vec - local_row * kVecsPerRow;
      const int g_row = m0 + local_row;
      a_pre[v] = load_a_stage_vec<kFullTile>(
          x_q, static_cast<int64_t>(g_row) * k + k0 + k16 * 16, m, g_row);
    }
#pragma unroll
    for (int v = 0; v < kBVecPerThread; ++v) {
      const int vec = tid + v * kThreadsPerBlock;
      // Round 5: the 16-byte chunk (k32 = vec>>7, n16 = (vec>>5)&3,
      // k8 = (vec>>3)&3, n_pair = vec&7) of the swizzled pack sits at byte
      // ((k0>>5)+k32)*n16g*512 + ((n0>>4)+n16)*512 + k8*128 + n_pair*16;
      // consecutive lanes read consecutive 16-byte chunks, so a warp's
      // staging loads touch 8 fully-used 128-byte lines.
      b_pre[v] = *reinterpret_cast<const int4*>(
          packed_w +
          packed_b_swz_offset((k0 >> 5) + (vec >> 7),
                              (n0 >> 4) + ((vec >> 5) & 3), n16g,
                              (vec >> 3) & 3, vec & 7));
    }

    // Consume stage s from buffer s&1: each wave accumulates its (BM/2) x
    // (BN/2) quadrant with kk-ascending m16n16k32 MMAs; one ds_read_b64 per
    // fragment.
    const int local_row = wave_row * (BM / 2);
#pragma unroll
    for (int kk = 0; kk < StageK; kk += kTileK) {
#pragma unroll
      for (int j = 0; j < kWaveM16; ++j) {
        load_frag8(
            a_frag[j],
            a_tile[s & 1] + (local_row + j * kTileM) * kLdsStride + kk,
            static_cast<unsigned>(kLdsStride),
            lane);
      }
#pragma unroll
      for (int i = 0; i < kWaveN16; ++i) {
        // Round 5: fragment block (k32 = kk>>5, n16 = wave_col*kWaveN16 + i)
        // of the swizzled tile -- 512 B per 16-n x 32-k DUMMA B fragment, one
        // conflict-free ds_read_b64 per lane.
        load_frag8_swz(
            b_frag[i],
            b_tile[s & 1] +
                ((kk >> 5) * (BN / 16) + wave_col * kWaveN16 + i) * 512,
            lane);
      }
#pragma unroll
      for (int j = 0; j < kWaveM16; ++j) {
#pragma unroll
        for (int i = 0; i < kWaveN16; ++i) {
          du_mma_sync(acc[j][i], a_frag[j], b_frag[i], acc[j][i]);
        }
      }
    }

    // Flush the prefetched stage-(s+1) vectors into the idle buffer.
    {
      const int buf = (s + 1) & 1;
#pragma unroll
      for (int v = 0; v < kAVecPerThread; ++v) {
        const int vec = tid + v * kThreadsPerBlock;
        const int local_row = vec / kVecsPerRow;
        const int k16 = vec - local_row * kVecsPerRow;
        const int64_t* src64 = reinterpret_cast<const int64_t*>(&a_pre[v]);
        int64_t* dst64 = reinterpret_cast<int64_t*>(
            a_tile[buf] + local_row * kLdsStride + k16 * 16);
        dst64[0] = src64[0];
        dst64[1] = src64[1];
      }
#pragma unroll
      for (int v = 0; v < kBVecPerThread; ++v) {
        const int vec = tid + v * kThreadsPerBlock;
        // Round 5: flat 16-byte swizzled-tile commit (ds_write_b128).
        *reinterpret_cast<int4*>(b_tile[buf] + vec * 16) = b_pre[v];
      }
    }
    __syncthreads();
  }

  // ---- Tail: consume the last stage (its data was flushed before the last
  // barrier; no trailing barrier needed).
  {
    const int s = kStages - 1;
    const int local_row = wave_row * (BM / 2);
#pragma unroll
    for (int kk = 0; kk < StageK; kk += kTileK) {
#pragma unroll
      for (int j = 0; j < kWaveM16; ++j) {
        load_frag8(
            a_frag[j],
            a_tile[s & 1] + (local_row + j * kTileM) * kLdsStride + kk,
            static_cast<unsigned>(kLdsStride),
            lane);
      }
#pragma unroll
      for (int i = 0; i < kWaveN16; ++i) {
        // Round 5: fragment block (k32 = kk>>5, n16 = wave_col*kWaveN16 + i)
        // of the swizzled tile -- 512 B per 16-n x 32-k DUMMA B fragment, one
        // conflict-free ds_read_b64 per lane.
        load_frag8_swz(
            b_frag[i],
            b_tile[s & 1] +
                ((kk >> 5) * (BN / 16) + wave_col * kWaveN16 + i) * 512,
            lane);
      }
#pragma unroll
      for (int j = 0; j < kWaveM16; ++j) {
#pragma unroll
        for (int i = 0; i < kWaveN16; ++i) {
          du_mma_sync(acc[j][i], a_frag[j], b_frag[i], acc[j][i]);
        }
      }
    }
  }

  const int base_row = m0 + wave_row * (BM / 2);
  const int base_col = n0 + wave_col * (BN / 2);
#pragma unroll
  for (int j = 0; j < kWaveM16; ++j) {
#pragma unroll
    for (int i = 0; i < kWaveN16; ++i) {
      // Round 9: kGuarded == !kFullTile -- the full-tile instantiation skips
      // the dead per-fragment `row >= m` EXEC bracket (see the helper above).
      store_prefill_fragment_coalesced<!kFullTile>(
          acc[j][i], x_scale, weight_scale, out, m, n,
          base_row + j * kTileM, base_col + i * kTileN, lane);
    }
  }
}

// Generic scalar int8/int32 fallback for unmatched shapes and small-M API
// cases (including the paired M=2 and M=16 shapes with the same (N, K) --
// they never reach the m >= 128 tiled/packed paths). One output element per
// grid-stride step; exact int32 accumulation (max assigned K = 6144 keeps the
// int8 dot well within int32 range: |dot| <= 6144*127*127 < 2^31), then the
// fused float scale (dot * x_scale[m] * weight_scale[n]) and a manual uint16
// bf16 store.
//
// Round 1: for the exact (k, n) == (6144, 2624) the packed_weight buffer
// holds a packed layout (produced once, outside the timed region), so the
// fallback decodes that layout there with ascending kk (every other (K, N)
// keeps the identity [K, N] row-major copy). The int32 accumulation stays
// kk-ascending 0..k-1 in both arms; integer addition is exact and commutative,
// so the int32 dot -- and the paired M=2 / M=16 API shapes -- remain
// byte-exact against the identity-layout reference. Round 5 replaces the
// exact-shape pack with the fragment-interleaved swizzle (see
// w8a8_pack_bswz_i8_kernel), so the exact-shape decode below walks
//   packed[((kk>>5)*n16g + (col>>4))*512 +
//          (((kk>>3)&3)*16 + (col&15))*8 + (kk&7)],  n16g = n>>4,
// element-by-element in ascending kk -- identical elements, identical int32
// accumulators.
__global__ __launch_bounds__(256) void w8a8_scalar_gemm_kernel(
    const int8_t* __restrict__ a,            // [M, K] row-major
    const int8_t* __restrict__ b,            // packed weight (swizzled/identity)
    const float* __restrict__ x_scale,       // [M]
    const float* __restrict__ weight_scale,  // [N]
    hip_bfloat16* __restrict__ out,          // [M, N]
    int m,
    int n,
    int k) {
  const int64_t total = static_cast<int64_t>(m) * n;
  const int64_t stride = static_cast<int64_t>(gridDim.x) * blockDim.x;
  const bool packed_swz = (k == kExactK && n == kExactN);
  for (int64_t idx = static_cast<int64_t>(blockIdx.x) * blockDim.x +
                     threadIdx.x;
       idx < total;
       idx += stride) {
    const int row = static_cast<int>(idx / n);
    const int col = static_cast<int>(idx - static_cast<int64_t>(row) * n);
    const int8_t* a_row = a + static_cast<int64_t>(row) * k;
    int32_t acc = 0;
    if (packed_swz) {
      // Round-5 swizzle: one 8-byte k-run per (n, k8) inside a 512-byte
      // 32-k x 16-n fragment block; walk it in ascending kk.
      const int64_t n16g = static_cast<int64_t>(n) >> 4;
      for (int kk = 0; kk < k; ++kk) {
        const int64_t off =
            ((static_cast<int64_t>(kk >> 5) * n16g + (col >> 4)) << 9) +
            ((((kk >> 3) & 3) * 16 + (col & 15)) << 3) + (kk & 7);
        acc += static_cast<int32_t>(a_row[kk]) *
               static_cast<int32_t>(b[off]);
      }
    } else {
      const int8_t* b_ptr = b + col;
      for (int kk = 0; kk < k; ++kk) {
        acc += static_cast<int32_t>(a_row[kk]) * static_cast<int32_t>(b_ptr[0]);
        b_ptr += n;
      }
    }
    const float scaled =
        static_cast<float>(acc) * x_scale[row] * weight_scale[col];
    reinterpret_cast<unsigned short*>(out)[idx] =
        static_cast<unsigned short>(__float2bfloat16(scaled));
  }
}

// Identity device-to-device byte copy (pack_weight bootstrap, valid for any
// (K, N)).
__global__ __launch_bounds__(256) void w8a8_pack_identity_i8_kernel(
    const int8_t* __restrict__ src,
    int8_t* __restrict__ dst,
    int64_t count) {
  const int64_t stride = static_cast<int64_t>(gridDim.x) * blockDim.x;
  for (int64_t i = static_cast<int64_t>(blockIdx.x) * blockDim.x +
                   threadIdx.x;
       i < count;
       i += stride) {
    dst[i] = src[i];
  }
}

// Round-1 exact-shape n-major pack: for (k, n) == (6144, 2624) the weight is
// transposed once, outside the timed region and out of Graph capture, into
// packed[n * k + kk] = raw[kk * n + n] so every col_major B fragment is 8
// contiguous K bytes in the packed buffer and every staging vector is one
// coalesced 16-byte read. Same byte count and buffer as the identity pack, so
// the captured addresses are unchanged. One thread per output byte; runs once
// during weight preparation.
__global__ __launch_bounds__(256) void w8a8_pack_nmajor_i8_kernel(
    const int8_t* __restrict__ raw,
    int8_t* __restrict__ packed,
    int k,
    int n) {
  const int64_t total = static_cast<int64_t>(k) * n;
  const int64_t stride = static_cast<int64_t>(gridDim.x) * blockDim.x;
  for (int64_t idx = static_cast<int64_t>(blockIdx.x) * blockDim.x +
                     threadIdx.x;
       idx < total;
       idx += stride) {
    const int col = static_cast<int>(idx / k);
    const int kk = static_cast<int>(idx - static_cast<int64_t>(col) * k);
    packed[idx] = raw[static_cast<int64_t>(kk) * n + col];
  }
}

// Round-5 exact-shape fragment-interleaved B swizzle: for (k, n) ==
// (6144, 2624) the weight is packed once, outside the timed region and out of
// Graph capture, into 512-byte 32-k x 16-n DUMMA B fragment blocks laid out
// [k32][n16][k8][n][8]:
//   packed[((kk >> 5) * n16g + (n >> 4)) * 512 +
//          (((kk >> 3) & 3) * 16 + (n & 15)) * 8 + (kk & 7)] = raw[kk * n + n],
// where n16g = n >> 4 (164 for the exact shape). This is a byte-exact
// bijection 192 x 164 x 512 = k*n = 16,121,856: same byte count and buffer as
// the identity/n-major/panel packs, so captured addresses are unchanged. Each
// thread packs one 16-byte chunk = the 8-byte k-runs of two n-rows of one k8
// group (a strided 2x8 gather on the read side; packing is outside timing, so
// the gather is off the critical path). Consecutive chunks are consecutive
// packed bytes, so the kernel's B staging is a flat 16-byte copy and every
// col_major B fragment read is one conflict-free ds_read_b64 (see
// load_frag8_swz). The round-2 n-major pack kernel above stays compiled as the
// layout control.
__global__ __launch_bounds__(256) void w8a8_pack_bswz_i8_kernel(
    const int8_t* __restrict__ raw,
    int8_t* __restrict__ packed,
    int k,
    int n) {
  const int64_t chunks = (static_cast<int64_t>(k) * n) >> 4;
  const int64_t stride = static_cast<int64_t>(gridDim.x) * blockDim.x;
  const int n16g = n >> 4;
  for (int64_t c = static_cast<int64_t>(blockIdx.x) * blockDim.x +
                   threadIdx.x;
       c < chunks;
       c += stride) {
    const int k32 =
        static_cast<int>(c / (static_cast<int64_t>(n16g) * 32));
    const int rem =
        static_cast<int>(c - static_cast<int64_t>(k32) * n16g * 32);
    const int n16 = rem >> 5;
    const int w = rem & 31;
    const int k8 = w >> 3;
    const int np = w & 7;
    const int n0 = (n16 << 4) + (np << 1);
    const int k0 = (k32 << 5) + (k8 << 3);
    int8_t* dst16 = packed + (c << 4);
#pragma unroll
    for (int i = 0; i < 8; ++i) {
      // 16-byte chunk = [n0 row: k0..k0+7][n0+1 row: k0..k0+7] (n-major
      // within the k8 group, matching the [k8][n][8] tile layout).
      dst16[i] = raw[static_cast<int64_t>(k0 + i) * n + n0];
      dst16[8 + i] = raw[static_cast<int64_t>(k0 + i) * n + n0 + 1];
    }
  }
}

// Identity device-to-device float copy for the weight scales.
__global__ __launch_bounds__(256) void w8a8_pack_identity_f32_kernel(
    const float* __restrict__ src,
    float* __restrict__ dst,
    int64_t count) {
  const int64_t stride = static_cast<int64_t>(gridDim.x) * blockDim.x;
  for (int64_t i = static_cast<int64_t>(blockIdx.x) * blockDim.x +
                   threadIdx.x;
       i < count;
       i += stride) {
    dst[i] = src[i];
  }
}

}  // namespace

// Stable host launch symbol consumed by csrc/bindings.cpp. Dispatches on the
// caller-provided stream only; never allocates, synchronizes, packs, or
// touches the default stream. The workspace is unused for this shape
// (single-buffered, no split-K): m*n*4 = 42,990,080 B exceeds the 16 MiB
// workspace budget, so workspace_split_k_capacity is zero.
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
  if (m <= 0 || n <= 0 || k <= 0) {
    return;
  }
  auto* out_ptr = static_cast<hip_bfloat16*>(out);

  // Exact assigned shape guard: glm_tp8_fused_qkv_a_proj_m4096
  // (M=4096, N=2624, K=6144). The m >= 128 guard keeps the paired M=2/M=16
  // API shapes with the same (N, K) on the scalar fallback below. Round 2
  // keeps the accepted packed-weight architecture (the exact-fit 2-D macro-tile
  // <128, 64, ...> with the packed weight produced once, out of the
  // timed region, by launch_pack_w8a8_weight, the bank-safe LDS row strides and
  // the explicit 8-byte load_frag8 fragment loads) and changes ONLY the K-stage
  // pipeline: the dispatch goes to the 64-K double-buffered prefetch kernel
  // <128, 64, 64> instead of the single-buffered <128, 64, 128> one, so the
  // stage-(s+1) VMEM latency overlaps the stage-s LDS/v_mmac work. Round 3
  // retains that double-buffered 64-K pipeline unchanged (it is the unique
  // 2-resident-block K pipeline inside the 65,536 B LDS budget: 2 x 27,648 =
  // 55,296 <= 65,536) and changes only the packed B layout consumed by the two
  // B global-load sites -- the weight is now the B-panel layout, so a warp's B
  // staging loads touch 4 fully-used 128-byte lines instead of 32 half-used
  // ones. Round 5 keeps the kernel, geometry and occupancy identical and
  // changes only the packed B layout again: the B-panel pack is replaced by the
  // fragment-interleaved swizzle, so the B stage is a flat 16-byte copy and
  // every col_major B fragment is one conflict-free ds_read_b64
  // (load_frag8_swz). M = 32*128 and N = 41*64 are both exact, so no tail
  // predication is introduced. Round 9 keeps that kernel, geometry and
  // occupancy and only selects a compile-time tail-predication specialization:
  // when m is a multiple of BM = 128 every block tile is fully inside the
  // output, so the instantiation with kFullTile == true drops the dead A-row
  // zero-fill/select in both staging sites and the dead epilogue row mask
  // (see the Round-9 header section); every other m keeps the guarded
  // instantiation byte-for-byte.
  if (m >= 128 && n == kExactN && k == kExactK) {
    const dim3 grid(
        static_cast<unsigned>(n / 64),
        static_cast<unsigned>((m + 127) / 128));
    const dim3 block(static_cast<unsigned>(kThreadsPerBlock));
    if ((m & 127) == 0) {
      hipLaunchKernelGGL(
          HIP_KERNEL_NAME(
              w8a8_dumma_prefill_packedb_db_kernel<128, 64, 64, true>),
          grid,
          block,
          0,
          stream,
          a,
          b,
          x_scale,
          weight_scale,
          out_ptr,
          m,
          n,
          k);
    } else {
      hipLaunchKernelGGL(
          HIP_KERNEL_NAME(
              w8a8_dumma_prefill_packedb_db_kernel<128, 64, 64, false>),
          grid,
          block,
          0,
          stream,
          a,
          b,
          x_scale,
          weight_scale,
          out_ptr,
          m,
          n,
          k);
    }
    return;
  }

  // Generic native INT8 DUMMA prefill path for every other large-M shape with
  // N % 64 == 0 and K % 128 == 0 (identity [K, N] layout). The A row guard
  // zero-fills rows past M and the epilogue masks them, so only the exact
  // shape above avoids predication.
  if (m >= 128 && (n % 64) == 0 && (k % 128) == 0) {
    const dim3 grid(
        static_cast<unsigned>(n / 64),
        static_cast<unsigned>((m + 63) / 64));
    const dim3 block(static_cast<unsigned>(kThreadsPerBlock));
    hipLaunchKernelGGL(
        HIP_KERNEL_NAME(w8a8_dumma_prefill_tiled_kernel<64, 64, 128>),
        grid,
        block,
        0,
        stream,
        a,
        b,
        x_scale,
        weight_scale,
        out_ptr,
        m,
        n,
        k);
    return;
  }

  // Scalar int8/int32 fallback for every unmatched (m, n, k) and all small-M
  // API cases.
  const int64_t total = static_cast<int64_t>(m) * n;
  constexpr int kFallbackThreads = 256;
  int64_t blocks = (total + kFallbackThreads - 1) / kFallbackThreads;
  if (blocks > 4096) {
    blocks = 4096;
  }
  if (blocks < 1) {
    blocks = 1;
  }
  const dim3 grid(static_cast<unsigned>(blocks));
  const dim3 block(kFallbackThreads);
  hipLaunchKernelGGL(
      w8a8_scalar_gemm_kernel,
      grid,
      block,
      0,
      stream,
      a,
      b,
      x_scale,
      weight_scale,
      out_ptr,
      m,
      n,
      k);
}

// Stable host launch symbol consumed by csrc/bindings.cpp. Round 5: the exact
// (k, n) == (6144, 2624) int8 weight is packed once (outside the timed region
// and out of Graph capture) into the fragment-interleaved swizzle
// packed[((kk>>5)*n16g + (n>>4))*512 + (((kk>>3)&3)*16 + (n&15))*8 + (kk&7)]
// = raw[kk*n + n] with n16g = n>>4, consumed by the packed-weight prefill
// kernel's flat B stage copy and by the scalar fallback's element decode; every
// other (K, N) keeps the identity copy of the logical [K, N] row-major weight.
// The [N] fp32 scales are always copied unchanged. Same byte count (k*n and n),
// same allocations, so the captured addresses stay graph-stable.
extern "C" void launch_pack_w8a8_weight(
    const int8_t* raw_weight,
    const float* weight_scale,
    int8_t* packed_weight,
    float* packed_weight_scale,
    int k,
    int n,
    hipStream_t stream) {
  constexpr int kPackThreads = 256;
  const int64_t weight_count = static_cast<int64_t>(k) * n;
  if (k == kExactK && n == kExactN) {
    // Round 5: one thread packs one 16-byte chunk (16 bytes = 2 n-rows x 8 B).
    const int64_t chunks = weight_count >> 4;
    int64_t blocks = (chunks + kPackThreads - 1) / kPackThreads;
    if (blocks > 4096) {
      blocks = 4096;
    }
    if (blocks < 1) {
      blocks = 1;
    }
    hipLaunchKernelGGL(
        w8a8_pack_bswz_i8_kernel,
        dim3(static_cast<unsigned>(blocks)),
        dim3(kPackThreads),
        0,
        stream,
        raw_weight,
        packed_weight,
        k,
        n);
  } else if (weight_count > 0) {
    int64_t blocks = (weight_count + kPackThreads - 1) / kPackThreads;
    if (blocks > 4096) {
      blocks = 4096;
    }
    if (blocks < 1) {
      blocks = 1;
    }
    hipLaunchKernelGGL(
        w8a8_pack_identity_i8_kernel,
        dim3(static_cast<unsigned>(blocks)),
        dim3(kPackThreads),
        0,
        stream,
        raw_weight,
        packed_weight,
        weight_count);
  }
  if (n > 0) {
    int64_t blocks = (static_cast<int64_t>(n) + kPackThreads - 1) /
                     kPackThreads;
    if (blocks > 4096) {
      blocks = 4096;
    }
    if (blocks < 1) {
      blocks = 1;
    }
    hipLaunchKernelGGL(
        w8a8_pack_identity_f32_kernel,
        dim3(static_cast<unsigned>(blocks)),
        dim3(kPackThreads),
        0,
        stream,
        weight_scale,
        packed_weight_scale,
        n);
  }
}
// @@end
