// @@variant shape=glm_tp8_kv_b_proj_m4096 commit=547eec13f53e3cee7da02bbdd17763f46e71761e added=2026-09-11
//   median_us=120.1 p90_us=120.9 speedup=57.78 baseline_us=6940
//   source=test-9-11-1-b01955b3/iteration_001/glm_tp8_kv_b_proj_m4096
// INT8 W8A8 GEMM HIP implementation for Hygon K500SM_AI / gfx928.
//
// Worker: worker_2 (physical GPU 2).  Assigned shape:
//   glm_tp8_kv_b_proj_m4096 : M=4096, N=3584, K=512
//
// Logical operation (exact contract):
//   out[m, n] = bf16( int32_dot(x_q[m, :], raw_weight[:, n])
//                     * x_scale[m] * weight_scale[n] )
//
// Iteration 9 (consolidate round): the exact-shape arm keeps its winning
// 128x128 macro-tile, its 512-thread / eight-wavefront geometry, its
// 16,384-B single-buffered swizzled-A + plane-B staging, its direct 8-byte
// fragment loads, its k0-outer/kk-inner int32 order and its coalesced
// 8-byte epilogue.  The one consolidated defect is the bf16 CONVERSION
// lowering: the exact gfx928 code object of the current best
// (compile_cache_key 0ece2e0cdbddfe2f512228e2bde5e23189f88fc22d01ae5ae49daf4a97a80f77,
// source_hip_digest 95dab478d6509cacbb6ca0888d90635197ed82d9202aead00ed49f50c4c7c9ac)
// shows hip's __float2bfloat16 emitting, for EVERY element each lane
// converts, an exec-masked inf/NaN fixup - v_and 0x7f800000, v_cmp_ne,
// s_and_saveexec, v_bfe, v_add3, v_or 0x10000, v_cndmask, s_andn2_saveexec
// (code-object addresses 0x5EEC..0x77E0 of
// w8a8_dumma_prefill_128x128_nmajor_kernel) - i.e. ~9 vector instructions
// plus two scalar EXEC manipulations per element against the 3-instruction
// rounding the value actually needs.  With M*N = 14.68M converted elements
// and 6,931,456 measured valu_instructions, the block-tail epilogue is the
// single largest VALU consumer in the kernel, and the
// s_and_saveexec/s_andn2_saveexec pairs serialize the wavefront there where
// the only other work left is the second co-resident block.  This round
// replaces ONLY that conversion, ONLY in the exact-shape epilogue, with a
// plain RNE form (bf16_rne_u16: u += 0x7fff + ((u >> 16) & 1); u >> 16) -
// the same lineage-validated fix the same-shape sibling reference
// references/int8w8a8-gemm/glm52/TP8/M4096/kv_b_proj.hip applies on this
// exact DTK 26.04 / gfx928.  The formula is bit-identical to hip's own
// non-masked branch for every finite float, and int32 accumulators times
// finite scales can only produce finite floats, so mismatch_count 0 /
// max_abs_error 0 is expected on the unchanged pre-seeded reference data.
// Everything else - the dense swizzle, the tile-contiguous pack and its
// scalar decode, the fragment placement, the k0/kk accumulation order, the
// exact (k, n) == (512, 3584) guard, the identity-layout 128x64 arm, the
// pack kernels and the generic scalar fallback - is byte-identical.
//
// Iteration 10 (consolidate round): final HIP-only polish on the same winning
// architecture.  The one consolidated defect is the dead per-fragment tail-M
// masking in the exact-shape epilogue.  The exact gfx928 code object of the
// current best (compile_cache_key 0f7ddb1a6c31e6f3cdd7772a8760e5b20dcea6da9ffca5d556e35790d7e25113,
// source_hip_digest 8c2468b4dfc603de4dd4a957ebf58d891830cbac940a07c58aed7c52030a8def,
// arch_vgpr 64, 0 scratch, 16,384 B LDS, 896 blocks) shows the block tail
// split into eight exec-masked basic blocks
// (s_and_saveexec / s_cbranch_execz / s_or_b64 around each of the eight
// fragment epilogues) even though the dispatch guard for this arm is
// m >= 128 with m % 128 == 0, so every row of every 128-row tile is in bounds
// and neither the (row >= m) early return in the store helper nor the two
// (rs < m) x_scale ternaries in the kernel can ever fire.  Because each
// fragment epilogue sits in its own basic block, the compiler also repeats the
// fragment-independent shuffle scaffolding per fragment (v_mbcnt_lo /
// v_mbcnt_hi lane-id, the two __shfl_xor partner indices, the two comparison
// and cndmask pairs, ~13 VALU per fragment x 8).  This round removes ONLY that
// dead masking from the exact-shape arm: the store helper drops its
// (row >= m) early return and its now-unused m argument, and the caller loads
// x_scale[rs0] / x_scale[rs1] directly.  Nothing else changes: the 128x128
// macro-tile, the 512-thread / eight-wavefront block, the 16,384-B
// single-buffered swizzled-A + plane-B staging, the direct 8-byte fragment
// loads, the k0-outer/kk-inner int32 order, the 4x4 shfl_xor transpose and
// the single 8-byte bf16 store per lane are all untouched, so the written
// bytes are bit-identical (removing a mask that is never asserted cannot
// change any output).  The 128x64 identity-layout arm keeps its own
// store_fragment_scaled bounds check and the generic scalar fallback keeps its
// linear bounds check, both byte-identical.  Falsifiable signature: the eight
// exec-masked guard blocks disappear from the 128x128 code object, the
// per-fragment duplicate lane-id / shuffle-index VALU is hoisted, and the
// dynamic valu_instructions fall from 5,512,192 without changing
// lds_instructions 1,089,536, lds_bank_conflicts 458,752,
// vmem_write_instructions 57,344 or the 16 v_mmac per stage.
//
// Iteration 13 (consolidate round, 13/13): final HIP-only polish on the
// unchanged winning exact-shape architecture, one bounded mechanism.  The
// exact current-best code object (source_hip_digest
// 8010314fdb6ba5ec0da98d662fc3911763b088245fa7c316bf0986572499207d,
// compile_cache_key 3fbcc466cfb5087e6f7057b3f26684e598046f28d0f71e0d794962688901c1c7,
// arch_vgpr 64, scratch 0, 16,384 B static LDS, 896 blocks x 512 threads) puts
// the whole 64-K stage wall on the EXPOSED cooperative-staging round trip: the
// two global_load_dwordx4 A/B chunks are issued only after the previous stage's
// trailing s_barrier and are then drained within ~8 instructions by
// s_waitcnt vmcnt(1) / vmcnt(0) in front of the three ds_write_b64/b128
// commits (0x5D1C..0x5D5C), so no part of the A+B L2 latency overlaps any
// arithmetic or the barrier wait.  Iteration 7 raised the staging depth to 2 to
// overlap exactly that round trip, but it doubled LDS to 32,768 B/block and
// gave up the 2-blocks/CU residency point, so the prefetch mechanism itself was
// never measured.  This round re-introduces ONLY the single-buffered register
// prefetch: the A row base and the B per-stage stride are hoisted out of the K
// loop, the next stage's A and B int4 chunks are loaded BEFORE the trailing
// barrier and consumed by the next stage's ds_write commits, while LDS stays
// 16,384 B, __launch_bounds__(kNMBlockThreads, 2), the 64-VGPR residency point
// and the two barriers per stage are all untouched, and the last stage re-reads
// its own chunk (k1 == k0) instead of reading past the last K block.  The
// swizzled A tile, the tile-contiguous plane-B layout, the direct 8-byte
// fragment loads, the k0-outer/kk-inner ascending int32 order, the coalesced
// RNE epilogue, the exact (k, n) == (512, 3584) dispatch guard, the 128x64
// identity-layout arm, the pack kernels and the generic scalar fallback are
// byte-identical, so every stored bit is unchanged.  Falsifiable signature: the
// global_load_dwordx4 pair for stage s+1 is scheduled before the trailing
// s_barrier and its vmcnt drain moves to the next stage's top, while arch_vgpr
// stays 64 with vgpr_spill_count 0 and scratch_bytes 0; if the machine
// scheduler keeps the loads where they already are the object is unchanged and
// the round is flat.
//
// Iteration 5 (packing round): the exact (k, n) == (512, 3584) weight is
// re-packed once, outside the timed/Graph region, from the n-major [N, K]
// transpose to a TILE-CONTIGUOUS 64-K-stage layout
//   packed[(((k0*(n/128) + nt)*8 + kc)*128 + row)*8 + b] = raw[kk*n + col]
//   kk = k0*64 + kc*8 + b,  nt = col/128,  row = col%128,
// i.e. every (64-K stage, 128-N tile) DUMMA B tile is ONE contiguous 8192-B
// global region laid out as [kc = 8-byte k sub-chunk][128 N rows][8 bytes],
// which is exactly the plane order the B fragments are read from in LDS.  The
// GEMM's cooperative B staging therefore becomes a plain 2 x 16-B contiguous
// vector copy per thread (global_load_dwordx4 -> ds_write_b128) with
// consecutive lanes on consecutive 16-B slots: the global reads are fully
// coalesced (the n-major [N, K] layout made a wave touch 16 rows 512 B apart)
// and the 16-B LDS stores have no bank conflicts.  The B fragment load becomes
// lane-linear (kc*(128*8) + row*8, no swizzle arithmetic) and each 16-lane
// phase covers all 32 banks exactly once, so B is now both vector-loadable and
// LDS-bank-safe; the swizzled 8-byte-group map is retained for A only (x_q is
// a runtime activation and cannot be pre-packed).  The int32 accumulation is
// untouched: identical per-lane fragment placement (row = row0 + (lane & 15),
// k group kc = (lane >> 4) + (kk >> 3), 8 consecutive natural-order k bytes)
// and identical k0-outer/kk-inner ascending order, so every output byte is
// bit-identical.  Falsifiable signature: the B half of the 917,504 measured
// lds_bank_conflicts disappears (32 -> 16 per stage per wave), the B staging's
// 4 x ds_write_b64 become 2 x ds_write_b128, lds_instructions fall
// 688,128 -> 630,784, and the median improves only if the global/LDS staging
// latency chain, not the 16-MMAC burst, is the limiter.
//
// Iteration 6 (mandated epilogue round): the fused scale/bf16 epilogue has
// been inside the compute kernel since iteration 1 and the workspace is
// already ignored ((void)workspace in launch_w8a8_gemm), so the remaining
// epilogue inefficiency of the exact (512, 3584) arm is the STORE pattern:
// store_fragment_scaled issues one 2-byte bf16 store per lane per element -
// 64 scattered stores per wave, each wavefront store touching 16 rows x 4
// columns so every 32-B store sector is only 25% utilized (the bootstrapped
// PMC counts vmem_write_instructions == 229,376 == 896 x 4 x 16 x 4 exactly).
// The new epilogue is register-batched: the per-row x_scale is loaded once per
// 16-row row-block and the four per-column scales of each fragment's owned
// columns are one aligned float4 load, so the epilogue issues 4 scalar + 16
// vector vmem loads per lane instead of 80 scalar loads.  It then transposes
// the four-element groups within each 4-lane column group in registers (two
// 2x2 shfl_xor steps, 16 then 32 - the lineage-validated pattern ported from
// references/int8w8a8-gemm/glm52/TP8/M4096/kv_b_proj.hip, which lowers to
// ds_bpermute at the block tail where the LDS pipe is idle) so lane (r, c4)
// ends up holding the four CONTIGUOUS columns 4*c4 .. +3, converts them to
// bf16 and writes ONE 8-byte store per lane per fragment: 16 coalesced stores
// per wave instead of 64 scattered ones at 100% sector efficiency, i.e.
// vmem_write 229,376 -> 57,344.  The scale multiply order
// (float(dot) * x_scale[row] * weight_scale[col]) and the __float2bfloat16
// rounding are unchanged, so the stored bits are identical; no LDS, no
// barrier, and no workspace/combine pass is added.  Everything else - the A
// swizzle, the tile-contiguous plane-B staging, the k0-outer/kk-inner
// ascending int32 order, the exact (k, n) == (512, 3584) guard, the
// identity-layout 128x64 arm, the pack kernels and the generic scalar
// fallback - is byte-identical.
//
// Iteration 8 (resource round): the exact-shape 128x128 n-major arm keeps its
// winning tile family, its tile-contiguous plane-B pack, its A swizzle, its
// direct 8-byte fragment loads, its k0-outer/kk-inner int32 order and its
// coalesced epilogue, and changes only the occupancy resources: waves per
// block, the VGPR live range and the per-thread LDS staging payload.
//   * Measured occupancy of the current best (iteration-6 source): arch_vgpr
//     120, static LDS 16,384 B/block, __launch_bounds__(256, 2) -> 2 blocks/CU
//     x 4 waves = 8 waves/CU = 2 waves/SIMD with 16 int32 accumulator VGPR
//     fragments + 8 operand fragments + 4 live int4 staging registers per
//     thread.  The PMC says the kernel is issue-stalled, not LDS-bandwidth- or
//     MMAC-bound: 195,964 cycles for 7,168 block-stages, 974,848
//     lds_instructions (4.97 per GPU cycle over 120 CUs) and 1,404,478
//     lds_wait_instructions against a theoretical LDS issue rate of 1/cycle/CU
//     - i.e. the SIMDs are starved of co-resident waves, not of LDS slots.
//   * Focused change: the same 128x128 macro-tile is covered by EIGHT
//     wavefronts of 64 lanes (512 threads, kNMBlockThreads = 8*64) instead of
//     four; each wave now owns a 32x64 quadrant = kAccM 2 A fragments x
//     kAccN 4 B fragments = 8 m16n16k32 int32 accumulators, i.e. 32
//     accumulator VGPR per thread instead of 64.  The staging payload per
//     thread halves to exactly one int4 of A (row = tid >> 2, 16-byte K group
//     (tid & 3) * 16) and one int4 of B (offset tid * 16), and the arm is
//     pinned by __launch_bounds__(kNMBlockThreads, 2) to the 64-VGPR /
//     2-blocks/CU point (65536 VGPR per CU / (2 x 512 lanes) = 64), i.e.
//     2 blocks x 8 waves = 16 waves/CU = 4 waves/SIMD, twice the currently
//     measured wave count.  LDS stays 16,384 B/block, so 2 blocks use 32,768 B
//     of the 65,536-B per-CU LDS (no exact-fit cliff like iteration 7's
//     32,768 B/block double buffer).
//   * Why exactly this point: the trusted occupancy-probe candidate list for
//     the measured 120-CU device is [2, 3, 4, 5, 6, 7, 8] waves per block; 8
//     is the largest value that still tiles the 128x128 macro-tile with
//     rectangular m16n16k32 quadrants (4 M row groups x 2 N column groups) and
//     it gives the top of the trusted residency range (8 waves/CU -> 16
//     waves/CU = 4/SIMD).  The direct sibling evidence is the lineage reference
//     references/int8w8a8-gemm/glm52/TP8/M4096/kv_b_proj.hip (same exact
//     M=4096/N=3584/K=512 shape, same DTK 26.04/gfx928): its 8-wave/512-thread
//     16-waves/CU recipe (config 3, arch_vgpr <= 64, 2 blocks/CU) is the
//     recorded 137.4 us winner of that family versus 169.3 us for its
//     12-waves/CU 128x64 form, which is the same occupancy axis this round
//     probes while keeping our better 1:1 macro-tile and 0.75-fragment/MMAC
//     quadrant instead of that reference's 1.0-fragment/MMAC 32x32 quadrants.
//   * Falsifiers: the exact code object must show vgpr_spill_count == 0,
//     scratch_bytes == 0 and arch_vgpr <= 64 (else residency falls to 1
//     block/CU = 8 waves/CU, cancelling the whole point); the LDS-read volume
//     per MMAC rises 0.5 -> 0.75 fragments, so the median improves only if the
//     doubled wave count hides more LDS/barrier latency than the +50% fragment
//     reads cost.  The int32 accumulation is untouched (exact integer
//     additions of the same products), every fragment placement is the same
//     8-byte per-lane operand, and the exact (k, n) == (512, 3584) guard, the
//     identity-layout 128x64 arm, the pack kernels and the generic scalar
//     fallback are byte-identical.
//
// Iteration 4 (tile-shape round): the exact-shape n-major arm moves from the
// 128x64 macro-tile (M:N = 2:1) to a 128x128 macro-tile (M:N = 1:1) for the
// exact (M, N, K) = (4096, 3584, 512) shape; the four-wavefront/256-thread
// block and the direct 8-byte swizzled fragment path are unchanged.  Each
// wave now owns a 64x64 quadrant built from sixteen m16n16k32 int32
// accumulators (kAccM = 4 A fragments x kAccN = 4 B fragments = 16 MMACs per
// kk) instead of a 64x32 quadrant with eight.  Why the aspect/area change is
// the lever for this exact M/N/K:
//   * Per-block-stage cooperative-load bytes are fixed by the tile shape:
//     128*64 (A) + 128*64 (B) = 16 KiB for 128x128 versus 8 KiB + 4 KiB =
//     12 KiB for 128x64, but the 128x128 tile holds 2x the outputs, so the
//     global/L2 read traffic for the whole operator drops from
//     M*N*K*(1/128 + 1/64) = 176.2 MB to M*N*K*(1/128 + 1/128) = 117.4 MB
//     (-33%).  Concretely: A is re-read once per N-tile column (56 -> 28) so
//     A traffic halves 117.4 -> 58.7 MB, while B keeps its 32 M-tile re-reads
//     at 58.7 MB.  The 128x64 arm's 2:1 A:B read imbalance becomes 1:1, which
//     is the aspect balance this round is for; the smaller A (2 MiB) and B
//     (1.75 MiB) both stay L2-resident either way.
//   * LDS fragment reads per MMAC drop 6/8 -> 8/16 (-33%): the 64x32 quadrant
//     needed 4 A + 2 B = 6 direct 8-byte reads for 8 MMACs, the 64x64
//     quadrant needs 4 A + 4 B = 8 reads for 16 MMACs.
//   * The measured per-stage wall is dominated by the exposed A+B L2 round
//     trip in front of the MMAC burst (exact code object: 3 x
//     global_load_dwordx4 -> s_waitcnt vmcnt(2)/(1)/(0) -> 6 x ds_write_b64,
//     per 64-K stage).  Halving the macro-tile count (grid 1792 -> 896) halves
//     the number of exposed stage walls for the same total work.
//   * 896 blocks is still ~3.7 waves of the 240 co-resident blocks
//     (2 blocks/CU x 120 CU), i.e. enough blocks to occupy every CU; no
//     split-K and the workspace stays unused.
// Residency: LDS 16,384 B/block (2 x 16,384 = 32,768 <= 64 KiB) and the
// sixteen accumulators cost 64 VGPR, so the arm is pinned to 2 blocks/CU =
// 8 waves/CU by an explicit __launch_bounds__(256, 2) register cap at
// 128 VGPR (floor(16384 VGPR/SIMD / (128 x 64 lanes)) = 2 waves/SIMD);
// falsified if the exact code object shows > 128 VGPR or any spill -> 1
// block/CU = 4 waves/CU.
// Everything else is byte-identical to iteration 2/3: the dense 8-byte-group
// swizzle, load_frag8_swizzled placement, the one-time n-major packed B, the
// k0-outer/kk-inner ascending int32 order, the exact (k, n) == (512, 3584)
// guard, the identity-layout 128x64 arm, the pack kernels and the generic
// scalar fallback.
//
// Iteration 2 (operand-reuse round): keep the cooperative A+B LDS staging
// (the reuse argument below favours it over per-fragment global loads) but
// replace the two structural costs the bootstrap PMC exposes on the assigned
// (M, N, K) = (4096, 3584, 512) shape:
//   * lds_instructions    2,465,792 and lds_wait_instructions 7,165,860:
//     the installed du_load_matrix_sync int8 loaders lower to a per-byte
//     ds_read_u8 gather plus mask/OR reassembly VALU for EVERY fragment.
//   * lds_bank_conflicts  6,881,280: the 80-byte padded row stride has bank
//     period 8 over a fragment's 16 rows, so lanes r and r+8 collide.
// Reuse accounting for one 128x64 macro-tile / 64-K stage (the reason direct
// global operand loads are rejected):
//   A[128,64] = 8 KiB staged; each A fragment row-block feeds two B fragments
//     (kAccN = 2) and two kk sub-steps, i.e. every staged A byte is consumed
//     by 4 or more MMAC operand reads; a direct global fragment load would
//     re-fetch it per fragment (4x redundant global traffic).
//   B[64,64] = 4 KiB staged; each B fragment feeds all four A row-blocks
//     (kAccM = 4), i.e. 4x reuse. So cooperative staging is retained and the
//     real lever is the *read* path and the LDS conflict structure.
// Change (one mechanism, both tiles):
//   * Both LDS tiles become dense 64-byte-row swizzled 8-byte-group layouts
//     (no pad). group(row, c) = (((row & 15) + 4*(c & 3)) & 15) + 16*c +
//     128*(row >> 4); the writers emit two 8-byte LDS stores per 16-byte
//     global chunk at group(row, 2j) / group(row, 2j+1) and the fragment
//     loader reads the swizzle back. Every 16-lane fragment load then touches
//     16 distinct bank pairs (zero conflicts) instead of the period-8
//     collision.
//   * Every A and B fragment read becomes ONE 8-byte LDS load per lane
//     (load_frag8_swizzled), reproducing du_load_matrix_sync's per-lane
//     (row = row0 + (lane & 15), c = (lane >> 4) + (kk >> 3), 8 consecutive
//     k bytes in natural order) placement, so the int32 accumulation is
//     bit-identical.
//   * B is read col_major from a one-time n-major transpose
//     packed[n*k + kk] = raw[kk*n + n] (produced outside the timed/Graph
//     region by launch_pack_w8a8_weight for exactly (k, n) == (512, 3584));
//     this makes each lane's 8 k bytes contiguous. The identity [K, N] copy
//     is kept for every other (k, n).
// Iteration-2 geometry (superseded for the n-major arm by the iteration-4
// 128x128 tile above; the identity-layout arm still uses it): one 128x64
// tile/block, four gfx928 wavefronts of 64 lanes (256 threads), each wave
// owning a 64x32 quadrant (kAccM = 4, kAccN = 2, eight m16n16k32 int32
// accumulators), 2 barriers per 64-K stage, no split-K, grid
// dim3(N/64, M/128) = (56, 32) = 1792 blocks, LDS = 8 KiB + 4 KiB = 12,288
// B/block.
//   * The fused int32 * x_scale * weight_scale -> bf16 epilogue keeps the
//     verified gfx928 int8 m16n16k32 accumulator ownership (row = lane & 15,
//     col = (lane >> 4) + 4*i), multiply order (float(dot) * x_scale[row] *
//     weight_scale[col]) and bf16 rounding of the harness reference.
//   * The identity-layout 128x64 DUMMA arm is retained for every non-packed
//     large shape, and the generic scalar int8/int32 fallback covers every
//     unmatched (m, n, k), including all small-M API cases (M=2, M=16) and
//     M < 128 with the same (K, N): one thread per output element, exact
//     int32 dot over K, then float(acc) * x_scale[row] * weight_scale[col] ->
//     bf16.  For exactly (512, 3584) the fallback decodes the n-major pack.
//   * launch_pack_w8a8_weight runs outside the timed/Graph region, allocates
//     nothing, keeps the same byte count and graph-stable addresses: the
//     n-major transpose for exactly (k, n) == (512, 3584), identity for every
//     other (k, n), fp32 scale always copied identity.
//
// The timed operator performs no allocation, compilation, autotuning, weight
// packing, host/device synchronization, or default-stream launch; it uses only
// the caller-provided out and workspace and launches on PyTorch's current HIP
// stream via hipLaunchKernelGGL.

#include <hip/hip_runtime.h>
#include <hip/hip_bfloat16.h>
#include <du_mma.h>

#include <cstdint>

namespace {

using namespace du::dumma;

constexpr int kTileM = 16;
constexpr int kTileN = 16;
constexpr int kTileK = 32;  // gfx928 INT8 DUMMA primitive: m16n16k32
constexpr int kWaveSize = 64;  // gfx928 native wavefront, not 32
constexpr int kBlockM = 128;
constexpr int kBlockN = 64;
constexpr int kStageK = 64;
constexpr int kPad = 16;  // 16 B LDS row padding (64 -> 80 B rows)
constexpr int kAStride = kStageK + kPad;
constexpr int kBStride = kBlockN + kPad;
constexpr int kBlockThreads = 4 * kWaveSize;  // 256 = four gfx928 wavefronts

// Iteration-4 tile-shape round: the exact-shape n-major arm uses a 128x128
// macro-tile (M:N = 1:1) instead of the 128x64 identity-arm geometry.
// Iteration-8 resource round: the same 128x128 macro-tile is covered by EIGHT
// wavefronts of 64 lanes (512 threads), each owning a 32x64 quadrant built
// from kAccM = 2 A fragments x kAccN = 4 B fragments = eight m16n16k32 int32
// accumulators (32 VGPR of accumulator per thread instead of 64).  The block
// is pinned to 2 blocks/CU by __launch_bounds__(512, 2), i.e. a 64-VGPR cap:
// 2 blocks x 8 waves = 16 waves/CU = 4 waves/SIMD instead of the
// measured 2 blocks x 4 waves = 8 waves/CU = 2 waves/SIMD.
constexpr int kNMBlockM = 128;
constexpr int kNMBlockN = 128;
constexpr int kNMQuadM = 32;  // per-wave M extent (4 row groups)
constexpr int kNMQuadN = 64;  // per-wave N extent (2 col groups)
constexpr int kNMBlockThreads = 8 * kWaveSize;  // 512 = eight gfx928 wavefronts

// Exact (k, n) pair whose weight buffer uses the iteration-5 tile-contiguous
// 64-K-stage pack packed[(((k0*(n/128) + nt)*8 + kc)*128 + row)*8 + b] =
// raw[kk*n + col] (identity [K, N] for every other pair).
constexpr int kPackK = 512;
constexpr int kPackN = 3584;
constexpr int kPackTileN = 128;  // N rows per tile-contiguous pack region
constexpr int kPackStageK = 64;  // k bytes per pack stage

using bf16_t = hip_bfloat16;

inline bool is_tile_major_pack(int k, int n) {
  return k == kPackK && n == kPackN;
}

// ---------------------------------------------------------------------------
// Direct fragment epilogue for one m16n16k32 accumulator fragment.
// Verified gfx928 int8 m16n16k32 accumulator ownership (matches
// du_store_matrix_sync): lane & 15 selects the row, lane >> 4 selects
// col % 4, and x[i] maps to columns col%4 + 4*i.  The scale multiply order
// (float(dot) * x_scale[row] * weight_scale[col]) and the bf16 rounding match
// the harness reference ((dot.float() * x_scale) * weight_scale.T -> bf16), so
// the stored bf16 bits are identical.
// ---------------------------------------------------------------------------
template <typename AccFragment>
__device__ __forceinline__ void store_fragment_scaled(
    const AccFragment& frag,
    const float* __restrict__ x_scale,
    const float* __restrict__ weight_scale,
    bf16_t* __restrict__ out,
    int base_row,
    int base_col,
    int m,
    int n,
    int lane) {
  const int row = base_row + (lane & 15);
  if (row >= m) {
    return;  // tail-M masking: padded rows never write
  }
  const int col_mod4 = lane >> 4;
#pragma unroll
  for (int i = 0; i < 4; ++i) {
    const int col = base_col + col_mod4 + 4 * i;
    const float scaled = static_cast<float>(frag.x[i]) *
                         x_scale[row] * weight_scale[col];
    out[static_cast<int64_t>(row) * n + col] = __float2bfloat16(scaled);
  }
}

// ---------------------------------------------------------------------------
// Bank-safe dense 8-byte-group LDS map for the exact-shape swizzled arm.
// group(row, c) is the 8-byte group index of tile position (row, k 8-byte
// group c). For a fragment load the 16 lanes of a group share row0 and kk, so
// row & 15 ranges over 0..15 and c is fixed; (row & 15) -> ((row & 15) +
// 4*(c & 3)) & 15 is a permutation, giving 16 distinct bank pairs and zero
// bank conflicts over the whole fragment read.
// ---------------------------------------------------------------------------
__device__ __forceinline__ int swizzle_group(int row, int c) {
  return (((row & 15) + 4 * (c & 3)) & 15) + 16 * c + 128 * (row >> 4);
}

// One 8-byte LDS store of each half of a 16-byte global chunk.
__device__ __forceinline__ void store_chunk16_swizzled(
    int8_t* __restrict__ p, int row, int j, const int4& v) {
  *reinterpret_cast<int2*>(p + swizzle_group(row, 2 * j) * 8) =
      *reinterpret_cast<const int2*>(&v);
  *reinterpret_cast<int2*>(p + swizzle_group(row, 2 * j + 1) * 8) =
      *reinterpret_cast<const int2*>(reinterpret_cast<const char*>(&v) + 8);
}

// Direct 8-byte fragment load that reproduces du_load_matrix_sync's per-lane
// placement exactly: row = row0 + (lane & 15), k group c = (lane >> 4) +
// (kk >> 3), eight consecutive k bytes in natural order. Writing them
// straight into the fragment storage lets the compiler emit one 8-byte LDS
// read per fragment with none of the library's per-byte gather/reassembly
// VALU, so the int32 accumulation is bit-identical.
__device__ __forceinline__ void load_frag8_swizzled(
    DUFragmentBase<signed char, 8>& frag,
    const signed char* __restrict__ p,
    int lane,
    int row0,
    int kk) {
  const int row = row0 + (lane & 15);
  const int c = (lane >> 4) + (kk >> 3);
  *reinterpret_cast<unsigned long long*>(&frag.x[0]) =
      *reinterpret_cast<const unsigned long long*>(p + swizzle_group(row, c) * 8);
}

// Iteration-5 (packing round) B fragment loader for the tile-contiguous plane
// LDS layout b_tile[kc][n][8] (kc = 8-byte k sub-chunk; plane stride
// kNMBlockN*8 = 1024 B).  Lane l reads the same 8 consecutive k bytes as
// load_frag8_swizzled's placement (n row = row0 + (lane & 15), k group
// kc = (lane >> 4) + (kk >> 3)) but from the lane-linear address
//   kc * (kNMBlockN * 8) + row * 8,
// i.e. ((lane >> 4) * 1024) + ((lane & 15) * 8) relative to row0's plane
// origin, so each 16-lane group of a 128-B LDS phase spans all 32 banks
// exactly once (zero bank conflicts) and the compiler emits one ds_read_b64.
__device__ __forceinline__ void load_frag8_plane(
    DUFragmentBase<signed char, 8>& frag,
    const signed char* __restrict__ p,
    int lane,
    int row0,
    int kk) {
  const int row = row0 + (lane & 15);
  const int kc = (lane >> 4) + (kk >> 3);
  *reinterpret_cast<unsigned long long*>(&frag.x[0]) =
      *reinterpret_cast<const unsigned long long*>(
          p + kc * (kNMBlockN * 8) + row * 8);
}

// ---------------------------------------------------------------------------
// Iteration 9 (consolidate round): plain round-to-nearest-even fp32 -> bf16
// conversion, bit-identical to hip's __float2bfloat16 for every finite input
// (the only values this GEMM can produce: int32 accumulators times finite
// scales), but without the exec-masked inf/NaN fixup sequence the DTK 26.04
// gfx928 lowering emits around it (see the header note).  The canonical RNE
// bit trick: add 0x7fff plus the retained LSB so ties round to even, then
// truncate.  Same form as the sibling reference
// references/int8w8a8-gemm/glm52/TP8/M4096/kv_b_proj.hip on this DTK.
// ---------------------------------------------------------------------------
__device__ __forceinline__ unsigned short bf16_rne_u16(float x) {
  union {
    float f;
    uint32_t u;
  } c;
  c.f = x;
  const uint32_t u = c.u + 0x7fff + ((c.u >> 16) & 1);
  return static_cast<unsigned short>(u >> 16);
}

// ---------------------------------------------------------------------------
// Iteration-6 (epilogue round): register-batched COALESCED direct-fragment
// epilogue for the exact-shape arm, ported from the lineage-validated sibling
// reference references/int8w8a8-gemm/glm52/TP8/M4096/kv_b_proj.hip.  The
// per-element variant (store_fragment_scaled) issues one 2-byte bf16 store per
// lane per element: four scattered stores per fragment, 64 per wave, each
// wavefront store touching 16 rows x 4 columns so every 32-B store sector is
// only 25% utilized (the bootstrap PMC's 229,376 vmem_write instructions =
// 896 blocks x 4 waves x 16 fragments x 4).  This epilogue transposes the
// four-element groups within each 4-lane column group (lanes r, r+16, r+32,
// r+48 - a 4x4 transpose done as two 2x2 steps with shfl_xor 16 then 32, the
// lineage-validated pattern that lowers to ds_bpermute at the block tail
// where the LDS pipe is idle), so lane (r, c4) ends up holding the four
// CONTIGUOUS columns base_col + 4*c4 .. +3, converts them to bf16 and writes
// ONE 8-byte store (100% store sector efficiency; 16 stores per wave instead
// of 64).  Only the int32 values are re-routed between lanes; the per-element
// scale multiply order (float(dot) * x_scale[row] * weight_scale[col]) and the
// __float2bfloat16 rounding are unchanged, so the stored bits are identical.
// xs is batched by the caller (one load per 16-row row-block) and ws is the
// float4 of the four per-column scales at col0, 16-B aligned because base_col
// is a multiple of 16, so the epilogue issues 2 scalar + 8 vector vmem loads
// per lane instead of 80 scalar loads.  Only the exact-shape n-major arm calls
// this helper, and its dispatch guard is m >= 128 with m % 128 == 0, so every
// row of every block is in bounds and no tail-M mask is needed: the shuffles
// never mix active and inactive lanes, and n*2 is a multiple of 8, so the
// 8-byte store is aligned.
//
// Iteration 9 (consolidate round): the bf16 conversion below is a plain RNE
// (bf16_rne_u16) instead of __float2bfloat16.  The exact code object of the
// current best showed the DTK 26.04 lowering wrapping every element in an
// exec-masked inf/NaN fixup (~9 vector instructions + two s_and_saveexec /
// s_andn2_saveexec scalar manipulations) whose only effect vs RNE is on
// inf/NaN inputs; int32 accumulators times finite scales are always finite,
// and for finite floats the two forms produce the identical 16-bit pattern.
// ---------------------------------------------------------------------------
template <typename AccFragment>
__device__ __forceinline__ void store_fragment_coalesced_scaled(
    const AccFragment& frag,
    float xs,
    const float* __restrict__ weight_scale,
    bf16_t* __restrict__ out,
    int base_row,
    int base_col,
    int n,
    int lane) {
  const int row = base_row + (lane & 15);
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

  // Lane (r, c4) now owns columns base_col + 4*c4 .. +3 (8 B, 8-byte aligned:
  // base_col is a multiple of 16 and n is a multiple of 4); ws is the float4
  // of per-column scales at col0.
  const int col0 = base_col + 4 * c4;
  const float4 ws = *reinterpret_cast<const float4*>(weight_scale + col0);
  const float v0 = static_cast<float>(f0) * xs * ws.x;
  const float v1 = static_cast<float>(f1) * xs * ws.y;
  const float v2 = static_cast<float>(f2) * xs * ws.z;
  const float v3 = static_cast<float>(f3) * xs * ws.w;
  const uint64_t packed =
      static_cast<uint64_t>(bf16_rne_u16(v0)) |
      (static_cast<uint64_t>(bf16_rne_u16(v1)) << 16) |
      (static_cast<uint64_t>(bf16_rne_u16(v2)) << 32) |
      (static_cast<uint64_t>(bf16_rne_u16(v3)) << 48);
  *reinterpret_cast<uint64_t*>(
      out + static_cast<int64_t>(row) * n + col0) = packed;
}

// ---------------------------------------------------------------------------
// Large-M prefill: 128x64 output tile per block, four wavefronts of 64 lanes.
// Each wave owns a 64x32 quadrant (eight m16n16k32 int32 accumulators); the
// block cooperatively stages A[128,64] from x_q (row-major, stride k) and
// B[64,64] from the raw [K, N] row-major weight into a single-buffered LDS
// stage.  Two barriers per 64-K stage: one after the cooperative load, one
// before the next stage overwrites the buffer.  Dispatch guarantees
// m % 128 == 0, n % 64 == 0, k % 64 == 0, so every global load/store is
// in-bounds and 16-byte aligned.
// ---------------------------------------------------------------------------
__global__ __launch_bounds__(kBlockThreads) void
w8a8_dumma_prefill_128x64_kernel(const int8_t* __restrict__ x_q,
                                 const int8_t* __restrict__ weight,
                                 const float* __restrict__ x_scale,
                                 const float* __restrict__ weight_scale,
                                 bf16_t* __restrict__ out,
                                 int m,
                                 int n,
                                 int k) {
  const int tid = static_cast<int>(threadIdx.x);
  const int wave = tid / kWaveSize;
  const int lane = tid % kWaveSize;
  const int wave_row = wave >> 1;  // 0 or 1
  const int wave_col = wave & 1;   // 0 or 1
  const int m0 = static_cast<int>(blockIdx.y) * kBlockM;
  const int n0 = static_cast<int>(blockIdx.x) * kBlockN;
  const int local_row = wave_row * 64;
  const int local_col = wave_col * 32;

  // Single-buffered stage: A[128, 80] + B[64, 80] = 15,360 B/block (four
  // blocks fit the 64 KiB per-CU LDS budget; the padded 80-byte strides are
  // 16-byte aligned and break the 64-byte LDS bank periodicity).
  __shared__ __align__(16) int8_t a_tile[kBlockM * kAStride];
  __shared__ __align__(16) int8_t b_tile[kStageK * kBStride];

  DUFragment<matrix_a, kTileM, kTileN, kTileK, signed char, row_major>
      a_frag0, a_frag1;
  DUFragment<matrix_b, kTileM, kTileN, kTileK, signed char, row_major>
      b_frag0, b_frag1;
  DUFragment<accumulator, kTileM, kTileN, kTileK, int>
      acc00, acc01, acc10, acc11, acc20, acc21, acc30, acc31;
  du_fill_fragment(acc00, 0);
  du_fill_fragment(acc01, 0);
  du_fill_fragment(acc10, 0);
  du_fill_fragment(acc11, 0);
  du_fill_fragment(acc20, 0);
  du_fill_fragment(acc21, 0);
  du_fill_fragment(acc30, 0);
  du_fill_fragment(acc31, 0);

  // Cooperative staging: A[128,64] is 512 int4s (two per thread), B[64,64] is
  // 256 int4s (one per thread).
  //   A: thread tid owns row (tid*16)/64 and the 16-byte K-column group
  //      (tid*16)%64 for rows [0,64) and [64,128).
  //   B: raw [K, N] row-major; thread tid owns K row tid>>2 and the 16-byte
  //      N-column group (tid&3)*16 (16 consecutive N values at a fixed K row,
  //      one aligned int4 in global and in LDS).
  const int vector_byte_offset = tid * static_cast<int>(sizeof(int4));
  const int stage_row = vector_byte_offset / kStageK;  // 0..63
  const int stage_col = vector_byte_offset - stage_row * kStageK;
  const int b_k = tid >> 2;         // K row 0..63
  const int b_nc = (tid & 3) * 16;  // N-column group 0/16/32/48

  for (int k0 = 0; k0 < k; k0 += kStageK) {
    *reinterpret_cast<int4*>(a_tile + stage_row * kAStride + stage_col) =
        *reinterpret_cast<const int4*>(
            x_q + static_cast<int64_t>(m0 + stage_row) * k + k0 + stage_col);
    *reinterpret_cast<int4*>(a_tile +
                             (stage_row + kBlockM / 2) * kAStride + stage_col) =
        *reinterpret_cast<const int4*>(
            x_q + static_cast<int64_t>(m0 + stage_row + kBlockM / 2) * k + k0 +
            stage_col);
    *reinterpret_cast<int4*>(b_tile + b_k * kBStride + b_nc) =
        *reinterpret_cast<const int4*>(
            weight + static_cast<int64_t>(k0 + b_k) * n + n0 + b_nc);
    __syncthreads();

    // Each wave consumes its 64x32 quadrant: eight m16n16k32 MMACs per kk.
    // Accumulation order: k0-outer over 64-K stages, kk-inner (kk = 0 then
    // 32), matching the reference int32 accumulation exactly.
#pragma unroll
    for (int kk = 0; kk < kStageK; kk += kTileK) {
      du_load_matrix_sync(b_frag0, b_tile + kk * kBStride + local_col,
                          kBStride);
      du_load_matrix_sync(b_frag1,
                          b_tile + kk * kBStride + local_col + kTileN,
                          kBStride);
      du_load_matrix_sync(a_frag0, a_tile + local_row * kAStride + kk,
                          kAStride);
      du_load_matrix_sync(a_frag1,
                          a_tile + (local_row + kTileM) * kAStride + kk,
                          kAStride);
      du_mma_sync(acc00, a_frag0, b_frag0, acc00);
      du_mma_sync(acc01, a_frag0, b_frag1, acc01);
      du_mma_sync(acc10, a_frag1, b_frag0, acc10);
      du_mma_sync(acc11, a_frag1, b_frag1, acc11);
      du_load_matrix_sync(a_frag0,
                          a_tile + (local_row + 2 * kTileM) * kAStride + kk,
                          kAStride);
      du_load_matrix_sync(a_frag1,
                          a_tile + (local_row + 3 * kTileM) * kAStride + kk,
                          kAStride);
      du_mma_sync(acc20, a_frag0, b_frag0, acc20);
      du_mma_sync(acc21, a_frag0, b_frag1, acc21);
      du_mma_sync(acc30, a_frag1, b_frag0, acc30);
      du_mma_sync(acc31, a_frag1, b_frag1, acc31);
    }

    // Protect the LDS buffer from the next stage's cooperative overwrite.
    __syncthreads();
  }

  const int base_row = m0 + local_row;
  const int base_col = n0 + local_col;
  store_fragment_scaled(acc00, x_scale, weight_scale, out, base_row, base_col,
                        m, n, lane);
  store_fragment_scaled(acc01, x_scale, weight_scale, out, base_row,
                        base_col + kTileN, m, n, lane);
  store_fragment_scaled(acc10, x_scale, weight_scale, out,
                        base_row + kTileM, base_col, m, n, lane);
  store_fragment_scaled(acc11, x_scale, weight_scale, out,
                        base_row + kTileM, base_col + kTileN, m, n, lane);
  store_fragment_scaled(acc20, x_scale, weight_scale, out,
                        base_row + 2 * kTileM, base_col, m, n, lane);
  store_fragment_scaled(acc21, x_scale, weight_scale, out,
                        base_row + 2 * kTileM, base_col + kTileN, m, n, lane);
  store_fragment_scaled(acc30, x_scale, weight_scale, out,
                        base_row + 3 * kTileM, base_col, m, n, lane);
  store_fragment_scaled(acc31, x_scale, weight_scale, out,
                        base_row + 3 * kTileM, base_col + kTileN, m, n, lane);
}

// ---------------------------------------------------------------------------
// Exact-shape (k, n) == (512, 3584) large-M prefill: 128x128 macro-tile per
// block, EIGHT gfx928 wavefronts of 64 lanes (512 threads). Each wave owns a
// 32x64 quadrant = kAccM 2 A fragments x kAccN 4 B fragments = eight
// m16n16k32 int32 accumulators (8 MMACs per kk). Cooperative A+B LDS staging
// is retained (each A row-block feeds 4 B fragments x 2 kk, each B fragment
// feeds 2 A row-blocks x 2 kk) and every fragment read is one direct 8-byte
// LDS load. A comes from the identity [M, K] x_q (row-major, stride k) and
// keeps the dense swizzled 8-byte-group LDS layout; B comes from the
// iteration-5 one-time tile-contiguous 64-K-stage pack
// packed[(((k0*(n/128)+nt)*8+kc)*128+row)*8+b] = raw[kk*n+col] and uses the
// plane LDS layout [kc][128][8], so its staging is a plain contiguous 16-B
// vector copy and its fragment loads are lane-linear and bank-conflict-free.
// Two barriers per 64-K stage, single-buffered, int32 accumulation resident
// through the whole K loop, no split-K (grid dim3(28, 32) = 896 blocks over
// 120 CUs, ~3.7 waves of the 240 co-resident blocks). Dispatch guarantees
// k == 512, n == 3584, m >= 128 and m % 128 == 0, so every global load is
// in-bounds and 16-byte aligned. The two-argument __launch_bounds__ caps the
// register file at the 64-VGPR 2-blocks/CU residency point for 512-thread
// blocks (65536 VGPR per CU / (2 x 512 lanes) = 64): 2 blocks x 8 waves =
// 16 waves/CU = 4 waves/SIMD instead of the measured 120-VGPR 128x128
// four-wave form at 2 waves/SIMD.  The iteration-6 epilogue is kept
// register-only: 2 batched per-row scale loads, one aligned float4 per-column
// scale load per fragment and one 8-byte coalesced store per lane per
// fragment, so it adds no LDS, no barrier and no occupancy pressure.
// ---------------------------------------------------------------------------
__global__ __launch_bounds__(kNMBlockThreads, 2) void
w8a8_dumma_prefill_128x128_nmajor_kernel(const int8_t* __restrict__ x_q,
                                         const int8_t* __restrict__ weight,
                                         const float* __restrict__ x_scale,
                                         const float* __restrict__ weight_scale,
                                         bf16_t* __restrict__ out,
                                         int m,
                                         int n,
                                         int k) {
  // Iteration 10 (consolidate round): the dispatch guard for this arm is
  // is_tile_major_pack(k, n) && m >= kNMBlockM && m % kNMBlockM == 0, so the
  // 128-row tile is always fully in bounds and no tail-M masking is needed.
  (void)m;
  const int tid = static_cast<int>(threadIdx.x);
  const int wave = tid / kWaveSize;  // 0..7
  const int lane = tid % kWaveSize;
  const int wave_row = wave >> 1;  // 0..3
  const int wave_col = wave & 1;   // 0..1
  const int m0 = static_cast<int>(blockIdx.y) * kNMBlockM;
  const int n0 = static_cast<int>(blockIdx.x) * kNMBlockN;
  const int local_row = wave_row * kNMQuadM;  // 0, 32, 64, 96
  const int local_col = wave_col * kNMQuadN;  // 0 or 64

  // A 8 KiB (dense swizzled 8-byte groups) + B 8 KiB (iteration-5
  // tile-contiguous plane [kc][128][8]) = 16,384 B/block.
  __shared__ __align__(16) int8_t a_tile[kNMBlockM * kStageK];
  __shared__ __align__(16) int8_t b_tile[kNMBlockN * kStageK];

  DUFragment<matrix_a, kTileM, kTileN, kTileK, signed char, row_major>
      a_frag0, a_frag1;
  DUFragment<matrix_b, kTileM, kTileN, kTileK, signed char, col_major>
      b_frag0, b_frag1, b_frag2, b_frag3;
  DUFragment<accumulator, kTileM, kTileN, kTileK, int>
      acc00, acc01, acc02, acc03, acc10, acc11, acc12, acc13;
  du_fill_fragment(acc00, 0);
  du_fill_fragment(acc01, 0);
  du_fill_fragment(acc02, 0);
  du_fill_fragment(acc03, 0);
  du_fill_fragment(acc10, 0);
  du_fill_fragment(acc11, 0);
  du_fill_fragment(acc12, 0);
  du_fill_fragment(acc13, 0);

  // Cooperative staging (iteration-8 resource round): with 512 threads each
  // thread owns exactly ONE 16-byte chunk of A and ONE 16-byte chunk of B, so
  // the staging payload per thread halves (1 int4 + 1 int4 instead of
  // 2 + 2) - this is what keeps the live-range budget compatible with the
  // 64-VGPR / 2-blocks/CU occupancy point.
  //   A: thread tid owns row tid >> 2 and the 16-byte K column group
  //      (tid & 3) * 16; the swizzled 8-byte-group LDS store is unchanged.
  //   B (iteration-5 packing round): the tile-contiguous pack lays each
  //      (64-K stage, 128-N tile) B tile out as one contiguous 8192-B region
  //      already in the LDS plane order [kc][128 N rows][8 bytes], so staging
  //      is a plain 1 x 16-B contiguous vector copy per thread.
  const int vector_byte_offset = tid * static_cast<int>(sizeof(int4));
  const int stage_row = vector_byte_offset / kStageK;             // 0..127
  const int stage_col = vector_byte_offset - stage_row * kStageK;  // 0,16,32,48
  const int b_tile_off = vector_byte_offset;                       // 0..8176

  // Iteration 13 (consolidate round): one-stage register prefetch of the
  // cooperative staging payload.  The A row base and the B per-stage stride are
  // loop-invariant, so the next 64-K A/B chunks are loaded while the current
  // stage's fragment reads and MMACs are still draining; at the consumer side
  // the load is already in flight across the trailing __syncthreads() instead
  // of being issued and drained within a handful of instructions at the stage
  // top.  The loaded values, their order, the LDS bytes and the int32
  // accumulation are unchanged, so every stored bit is unchanged.
  const int8_t* const a_stage_base =
      x_q + static_cast<int64_t>(m0 + stage_row) * k + stage_col;
  const int64_t b_stage_step =
      static_cast<int64_t>(n / kNMBlockN) * (kNMBlockN * kStageK);
  const int64_t b_stage_base =
      static_cast<int64_t>(n0 / kNMBlockN) * (kNMBlockN * kStageK);
  int4 a_chunk = *reinterpret_cast<const int4*>(a_stage_base);
  int4 b_chunk =
      *reinterpret_cast<const int4*>(weight + b_stage_base + b_tile_off);

  for (int k0 = 0; k0 < k; k0 += kStageK) {
    store_chunk16_swizzled(a_tile, stage_row, stage_col >> 4, a_chunk);
    *reinterpret_cast<int4*>(b_tile + b_tile_off) = b_chunk;
    __syncthreads();

    // Each wave consumes its 32x64 quadrant: eight m16n16k32 MMACs per kk.
    // Accumulation order: k0-outer over 64-K stages, kk-inner (kk = 0 then
    // 32), matching the reference int32 accumulation exactly (the DUMMA
    // accumulator is exact int32 addition, so the 2 x 4 fragment partition
    // over the same products is bit-identical).
#pragma unroll
    for (int kk = 0; kk < kStageK; kk += kTileK) {
      load_frag8_plane(b_frag0, b_tile, lane, local_col, kk);
      load_frag8_plane(b_frag1, b_tile, lane, local_col + kTileN, kk);
      load_frag8_plane(b_frag2, b_tile, lane, local_col + 2 * kTileN, kk);
      load_frag8_plane(b_frag3, b_tile, lane, local_col + 3 * kTileN, kk);
      load_frag8_swizzled(a_frag0, a_tile, lane, local_row, kk);
      load_frag8_swizzled(a_frag1, a_tile, lane, local_row + kTileM, kk);
      du_mma_sync(acc00, a_frag0, b_frag0, acc00);
      du_mma_sync(acc01, a_frag0, b_frag1, acc01);
      du_mma_sync(acc02, a_frag0, b_frag2, acc02);
      du_mma_sync(acc03, a_frag0, b_frag3, acc03);
      du_mma_sync(acc10, a_frag1, b_frag0, acc10);
      du_mma_sync(acc11, a_frag1, b_frag1, acc11);
      du_mma_sync(acc12, a_frag1, b_frag2, acc12);
      du_mma_sync(acc13, a_frag1, b_frag3, acc13);
    }

    // Iteration 13 (consolidate round): issue the next 64-K stage's A and B
    // chunks before the trailing barrier so their L2 round trip overlaps the
    // barrier wait and the next stage's commit instead of being drained
    // immediately at the stage top.  The last stage re-reads its own chunk
    // (k1 == k0) rather than running past the final K block, so every
    // prefetch address stays in bounds.
    {
      const int k1 = (k0 + kStageK < k) ? (k0 + kStageK) : k0;
      a_chunk = *reinterpret_cast<const int4*>(a_stage_base + k1);
      b_chunk = *reinterpret_cast<const int4*>(
          weight + static_cast<int64_t>(k1 / kStageK) * b_stage_step +
          b_stage_base + b_tile_off);
    }

    // Protect the LDS buffers from the next stage's cooperative overwrite.
    __syncthreads();
  }

  // ---------------------------------------------------------------------
  // Iteration-6 (epilogue round): register-batched coalesced epilogue, kept
  // unchanged; the iteration-8 eight-wave quadrant only changes how many
  // fragments each wave owns (2 row-blocks x 4 col-blocks = 8 fragments).
  // Iteration 10 (consolidate round): the dead per-fragment tail-M guard is
  // removed from this arm.  The dispatch guard is m >= 128 with m % 128 == 0,
  // so base_row + (lane & 15) is always < m and the two (rs < m) x_scale
  // ternaries and the (row >= m) early return in the store helper never fire;
  // as written they forced each of the eight fragment epilogues into its own
  // exec-masked basic block (eight s_and_saveexec / s_or_b64 / s_cbranch
  // groups and eight redundant lane-id / shuffle-index computations in the
  // iteration-10 code object).  Removing them keeps the exact 128x128 tile,
  // the eight-wave geometry, the 16,384-B single-buffered staging, the LDS
  // fragment loads, the int32 accumulation and the coalesced 8-byte store,
  // and lets the eight independent fragment epilogues issue as one
  // straight-line block.  The 128x64 generic arm and the scalar fallback keep
  // their own bounds checks unchanged.
  // ---------------------------------------------------------------------
  const int gcol_base = n0 + local_col;
  const int rs0 = m0 + local_row + (lane & 15);
  const float xs0 = x_scale[rs0];
  const int rs1 = rs0 + kTileM;
  const float xs1 = x_scale[rs1];
  store_fragment_coalesced_scaled(acc00, xs0, weight_scale, out,
                                  m0 + local_row, gcol_base, n, lane);
  store_fragment_coalesced_scaled(acc01, xs0, weight_scale, out,
                                  m0 + local_row, gcol_base + kTileN, n, lane);
  store_fragment_coalesced_scaled(acc02, xs0, weight_scale, out,
                                  m0 + local_row, gcol_base + 2 * kTileN, n,
                                  lane);
  store_fragment_coalesced_scaled(acc03, xs0, weight_scale, out,
                                  m0 + local_row, gcol_base + 3 * kTileN, n,
                                  lane);
  store_fragment_coalesced_scaled(acc10, xs1, weight_scale, out,
                                  m0 + local_row + kTileM, gcol_base, n, lane);
  store_fragment_coalesced_scaled(acc11, xs1, weight_scale, out,
                                  m0 + local_row + kTileM, gcol_base + kTileN,
                                  n, lane);
  store_fragment_coalesced_scaled(acc12, xs1, weight_scale, out,
                                  m0 + local_row + kTileM,
                                  gcol_base + 2 * kTileN, n, lane);
  store_fragment_coalesced_scaled(acc13, xs1, weight_scale, out,
                                  m0 + local_row + kTileM,
                                  gcol_base + 3 * kTileN, n, lane);
}

// ---------------------------------------------------------------------------
// Generic scalar fallback: one thread per output element.  Exact int32 dot
// over K, then fused x_scale * weight_scale, then bf16 store.  kPackedNMajor
// == true decodes the iteration-5 tile-contiguous 64-K-stage pack
// packed[(((k0*(n/128) + nt)*8 + kc)*128 + row)*8 + b] = raw[kk*n + col] for
// exactly (k, n) == (512, 3584); false reads the identity [K, N] row-major
// layout.  Handles every unmatched (m, n, k), including all small-M API cases
// (M=2, M=16), the paired same-(K, N) shapes, and M < 128 with the exact
// packed pair.
// ---------------------------------------------------------------------------
template <bool kPackedNMajor>
__global__ __launch_bounds__(256) void w8a8_gemm_scalar_fallback_kernel(
    const int8_t* __restrict__ x_q,
    const int8_t* __restrict__ weight,
    const float* __restrict__ x_scale,
    const float* __restrict__ weight_scale,
    bf16_t* __restrict__ out,
    int m,
    int n,
    int k) {
  const int64_t linear =
      static_cast<int64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
  const int64_t total = static_cast<int64_t>(m) * n;
  if (linear >= total) {
    return;
  }
  const int row = static_cast<int>(linear / n);
  const int col = static_cast<int>(linear - static_cast<int64_t>(row) * n);
  int32_t acc = 0;
  const int8_t* a_row = x_q + static_cast<int64_t>(row) * k;
  if constexpr (kPackedNMajor) {
    // Tile-contiguous pack: packed[(((k0*(n/128) + nt)*8 + kc)*128 + row)*8+b]
    // == raw[kk*n + col] with kk = k0*64 + kc*8 + b, nt = col/128,
    // row = col%128.
    const int n_row = col & (kPackTileN - 1);
    const int nt = col / kPackTileN;
    for (int kk = 0; kk < k; ++kk) {
      const int k0 = kk / kPackStageK;
      const int kc = (kk >> 3) & 7;
      const int b = kk & 7;
      const int64_t tile =
          static_cast<int64_t>(k0) * (n / kPackTileN) + nt;
      const int8_t* p =
          weight + ((tile * 8 + kc) * kPackTileN + n_row) * 8 + b;
      acc += static_cast<int32_t>(a_row[kk]) * static_cast<int32_t>(*p);
    }
  } else {
    // identity [K, N] row-major: column col is strided by n.
    const int8_t* b_col = weight + col;
    for (int kk = 0; kk < k; ++kk) {
      acc += static_cast<int32_t>(a_row[kk]) *
             static_cast<int32_t>(b_col[static_cast<int64_t>(kk) * n]);
    }
  }
  const float scaled =
      static_cast<float>(acc) * x_scale[row] * weight_scale[col];
  out[linear] = __float2bfloat16(scaled);
}

// ---------------------------------------------------------------------------
// Iteration-5 packing round: one-time tile-contiguous 64-K-stage permutation
// for exactly (k, n) == (512, 3584):
//   packed[(((k0*(n/128) + nt)*8 + kc)*128 + row)*8 + b] = raw[kk*n + col],
//   kk = k0*64 + kc*8 + b,  nt = col/128,  row = col%128.
// Every (64-K stage, 128-N tile) DUMMA B tile is ONE contiguous 8192-B global
// region laid out as [kc = 8-byte k sub-chunk][128 N rows][8 bytes], which is
// exactly the plane order the GEMM stages into LDS, so the staging is a plain
// contiguous 16-B vector copy and the B fragment reads are lane-linear and
// bank-conflict-free.  Byte-wise (one thread per byte) so the permutation is
// trivially correct; runs once outside the timed region and outside Graph
// capture, keeping the same byte count and the same graph-stable buffer
// address.
// ---------------------------------------------------------------------------
__global__ __launch_bounds__(256) void w8a8_pack_tile_major_kernel(
    const int8_t* __restrict__ raw,
    int8_t* __restrict__ packed,
    int k,
    int n) {
  const int64_t linear =
      static_cast<int64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
  const int64_t total = static_cast<int64_t>(k) * n;
  if (linear < total) {
    const int kk = static_cast<int>(linear / n);
    const int col = static_cast<int>(linear - static_cast<int64_t>(kk) * n);
    const int k0 = kk / kPackStageK;
    const int kc = (kk >> 3) & 7;
    const int b = kk & 7;
    const int nt = col / kPackTileN;
    const int row = col & (kPackTileN - 1);
    const int64_t tile = static_cast<int64_t>(k0) * (n / kPackTileN) + nt;
    packed[((tile * 8 + kc) * kPackTileN + row) * 8 + b] = raw[linear];
  }
}

// ---------------------------------------------------------------------------
// Bootstrap identity device-to-device packing for every (k, n) except the
// exact tile-major-packed pair.  Runs once outside the timed
// region and outside Graph capture, keeps the same byte count and
// graph-stable buffer addresses, and is the generic fallback for every
// (k, n).
// ---------------------------------------------------------------------------
__global__ __launch_bounds__(256) void w8a8_pack_identity_kernel(
    const int8_t* __restrict__ raw,
    int8_t* __restrict__ packed,
    int64_t count) {
  const int64_t linear =
      static_cast<int64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
  if (linear < count) {
    packed[linear] = raw[linear];
  }
}

__global__ __launch_bounds__(256) void w8a8_pack_scale_identity_kernel(
    const float* __restrict__ raw,
    float* __restrict__ packed,
    int count) {
  const int linear = static_cast<int>(blockIdx.x) * blockDim.x + threadIdx.x;
  if (linear < count) {
    packed[linear] = raw[linear];
  }
}

}  // namespace

// ---------------------------------------------------------------------------
// Stable host launch symbols consumed by csrc/bindings.cpp.
// Both launchers are pure dispatch: no allocation, no packing, no
// synchronization, no default-stream launch; they run on the caller-provided
// PyTorch stream and are CUDA-Graph safe.
// ---------------------------------------------------------------------------
extern "C" void launch_w8a8_gemm(const int8_t* a,
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
  (void)workspace;  // no split-K: the GEMM does not use the workspace
  (void)workspace_bytes;
  auto* out_bf16 = reinterpret_cast<bf16_t*>(out);

  // Explicit dispatch.  For exactly (k, n) == (512, 3584) the weight is the
  // one-time tile-contiguous 64-K-stage pack: large-M uses the 128x128
  // plane-B direct-load DUMMA arm (iteration-8 resource round: eight
  // wavefronts / 512 threads per block, the wavefront=64 geometry of the
  // exact-shape arm), every other m (small-M API cases and M < 128) decodes
  // the packed layout in the scalar fallback.  Every other (m, n, k) keeps
  // the bootstrap behaviour: the identity-layout 128x64 DUMMA arm (four
  // wavefronts / 256 threads) for large shapes, the scalar fallback
  // otherwise.
  if (is_tile_major_pack(k, n) && m >= kNMBlockM && m % kNMBlockM == 0) {
    const dim3 grid(static_cast<unsigned>(n / kNMBlockN),
                    static_cast<unsigned>(m / kNMBlockM));
    const dim3 block(kNMBlockThreads);
    hipLaunchKernelGGL(w8a8_dumma_prefill_128x128_nmajor_kernel, grid, block, 0,
                       stream, a, b, x_scale, weight_scale, out_bf16, m, n, k);
  } else if (is_tile_major_pack(k, n)) {
    constexpr int kBlock = 256;
    const int64_t total = static_cast<int64_t>(m) * n;
    const dim3 grid(static_cast<unsigned>((total + kBlock - 1) / kBlock));
    const dim3 block(kBlock);
    hipLaunchKernelGGL(
        HIP_KERNEL_NAME(w8a8_gemm_scalar_fallback_kernel<true>), grid, block, 0,
        stream, a, b, x_scale, weight_scale, out_bf16, m, n, k);
  } else if (m >= kBlockM && m % kBlockM == 0 && n % kBlockN == 0 &&
             k % kStageK == 0) {
    const dim3 grid(static_cast<unsigned>(n / kBlockN),
                    static_cast<unsigned>(m / kBlockM));
    const dim3 block(kBlockThreads);
    hipLaunchKernelGGL(w8a8_dumma_prefill_128x64_kernel, grid, block, 0, stream,
                       a, b, x_scale, weight_scale, out_bf16, m, n, k);
  } else {
    constexpr int kBlock = 256;
    const int64_t total = static_cast<int64_t>(m) * n;
    const dim3 grid(static_cast<unsigned>((total + kBlock - 1) / kBlock));
    const dim3 block(kBlock);
    hipLaunchKernelGGL(
        HIP_KERNEL_NAME(w8a8_gemm_scalar_fallback_kernel<false>), grid, block,
        0, stream, a, b, x_scale, weight_scale, out_bf16, m, n, k);
  }
}

extern "C" void launch_pack_w8a8_weight(const int8_t* raw_weight,
                                        const float* weight_scale,
                                        int8_t* packed_weight,
                                        float* packed_weight_scale,
                                        int k,
                                        int n,
                                        hipStream_t stream) {
  constexpr int kBlock = 256;
  const dim3 block(kBlock);
  const int64_t weight_count = static_cast<int64_t>(k) * n;
  if (is_tile_major_pack(k, n)) {
    // Iteration-5 packing round: one-time tile-contiguous 64-K-stage pack so
    // the DUMMA arm stages each B tile with contiguous 16-B vector loads and
    // LDS stores and loads B fragments lane-linearly with zero bank conflicts.
    const dim3 tile_grid(
        static_cast<unsigned>((weight_count + kBlock - 1) / kBlock));
    hipLaunchKernelGGL(w8a8_pack_tile_major_kernel, tile_grid, block, 0, stream,
                       raw_weight, packed_weight, k, n);
  } else {
    const dim3 weight_grid(
        static_cast<unsigned>((weight_count + kBlock - 1) / kBlock));
    hipLaunchKernelGGL(w8a8_pack_identity_kernel, weight_grid, block, 0, stream,
                       raw_weight, packed_weight, weight_count);
  }

  const dim3 scale_grid(static_cast<unsigned>((n + kBlock - 1) / kBlock));
  hipLaunchKernelGGL(w8a8_pack_scale_identity_kernel, scale_grid, block, 0,
                     stream, weight_scale, packed_weight_scale, n);
}
// @@end
