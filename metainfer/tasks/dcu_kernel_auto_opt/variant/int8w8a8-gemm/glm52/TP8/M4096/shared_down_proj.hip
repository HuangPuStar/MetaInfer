// @@variant shape=glm_tp8_shared_down_proj_m4096 commit=44018b50c8c0557effd9aa58807ccc6a69dead1f added=2026-09-14
//   median_us=146.7 p90_us=147.2 speedup=120.7 baseline_us=1.77e+04
//   source=test-9-11-1/iteration_002/glm_tp8_shared_down_proj_m4096 (retested A/B)
// MetaInfer W8A8 INT8 GEMM backend for Hygon gfx928 (K500SM_AI).
//
// worker_0 (iteration 2, operand-reuse round). Assigned shape:
//   glm_tp8_shared_down_proj_m4096 : (M, N, K) = (4096, 6144, 256)
//
// This file provides the two stable host launch symbols consumed by the
// trusted csrc/bindings.cpp:
//   * launch_w8a8_gemm(...)        - timed, graph-safe GEMM on the caller's
//                                    HIP stream. No allocation, no packing, no
//                                    autotuning, no host/device synchronization
//                                    and no default-stream launch. Only the
//                                    caller-provided out is written; the
//                                    caller-provided workspace is unused
//                                    because there is no split-K.
//   * launch_pack_w8a8_weight(...) - out-of-timed-region packing. The exact
//                                    down_proj (k, n) == (256, 6144) pair is
//                                    packed once into the round-5 panel layout
//                                    [N/128][K/64][128][64] (n-major rows of
//                                    64 k-bytes per panel) so the timed GEMM
//                                    consumes each 128x64 B stage tile as ONE
//                                    contiguous 8 KiB region and each lane's
//                                    fragment stays k-contiguous; every other
//                                    (k, n) stays the identity device-to-device
//                                    copy of the logical [K, N] weight.
//
// Round 1 (bootstrap, accepted at 313.66 us median): native INT8 DUMMA
// m16n16k32 tiled kernel with exact int32 accumulation for every M >= 128.
//   * 64x128 macro-tile: 8 wavefronts, one 32x32 quadrant per wavefront, four
//     m16n16k32 int32 accumulators kept resident across the whole K loop. A and
//     B are staged cooperatively into bank-skewed LDS and consumed with the
//     library du_load_matrix_sync fragment loaders.
//   * SINGLE-buffered K loop, K stage 128 (A[64,128] + B[128,128] = 27,648
//     B/block -> 2 blocks/CU): two barriers per stage, no split-K, no raw asm,
//     no speculative double-buffer pipeline. K=256 is two stages.
//   * Fused direct fragment -> x_scale -> weight_scale -> bf16 epilogue using
//     the verified gfx928 accumulator ownership (row = lane & 15,
//     col_mod4 = lane >> 4, frag.x[i] -> columns col_mod4 + 4*i). The int32 dot
//     is exact for every allowed K and the fp32 left-associated multiply chain
//     matches the mathematical reference.
//   * A second 64x64 arm covers large-M shapes whose N is a multiple of 64 but
//     not of 128. Every other (m, n, k) - including every M < 128 API case and
//     the paired M=2/M=16 shapes with the same (N, K) - goes to the scalar
//     int8/int32 fallback.
//
// Round 2 (this session, mandated operand-reuse decision): compare direct
// per-wave global loads with cooperative A+B LDS staging on the exact
// (4096, 6144, 256) shape.
//   * Reuse accounting for the 64x128 macro-tile with one 32x32 quadrant per
//     wave: every A element participates in kBlockN = 128 output MACs and every
//     B element in kBlockM = 64 MACs, so cooperative staging keeps ONE global
//     read and ONE LDS write per element while direct per-wave fragment loads
//     would re-read the A tile kBlockN/32 = 4 times and the B tile
//     kBlockM/32 = 2 times from global (per 64-K stage: 12,288 B staged vs
//     32,768 B of fragment reads, a 2.67x global-traffic amplification on an
//     already L2-resident operand stream). Direct loads are rejected on that
//     amplification and on the sibling lineage's measured 7.9x direct-arm
//     regressions.
//   * The bootstrap exact-shape arm reads the identity [K, N] B layout with
//     byte-scattered row_major library fragment loads: its exact code object
//     and PMC show 3,686,400 LDS instructions, 7,864,320 LDS bank conflicts,
//     5,131,888 LDS waits and 17.4M VALU per operator replay at 313.66 us
//     median (11% issue utilization).
//   * Focused change: the exact (m, n, k) == (4096, 6144, 256) guard now routes
//     to w8a8_dumma_proj_operand_reuse_kernel<64, 128, 64>, which keeps
//     cooperative A+B LDS staging, keeps 16-byte vectorized coalesced global
//     staging loads on both operands, and fixes the LDS consumer side:
//       - the one-time pack transposes B to the n-major [N, K] layout, so the
//         staged B tile is [kBlockN, kStageK] with k contiguous and each
//         matrix_b col_major fragment lane owns 8 contiguous bytes (the
//         identity-layout row_major B reads are the bank-conflict source);
//         round 5 keeps the identical staged LDS bytes but re-orders the
//         packed buffer into the [N/128][K/64][128][64] panel layout so each
//         block-stage B tile is one contiguous global region (see below);
//       - A and B fragments are read with the explicit 8-byte load_frag8
//         loader (ONE 8-byte LDS read per fragment) instead of the library
//         per-byte loaders plus reassembly VALU; the element-to-slot mapping
//         is identical, so the MMAC operands and accumulation are unchanged;
//       - LDS row strides are the bank-safe 8-mod-16 values A = 88 (64+24) and
//         B = 72 (64+8): 22*r and 18*r mod 32 are 16 distinct values over
//         r = 0..15, so every 16-lane ds_read_b64 fragment phase lands on 16
//         distinct bank pairs. The 8-mod-16 row starts forbid 16-byte stores,
//         so each staged int4 is written as two 8-byte halves;
//       - 64-K STAGE single buffer: 2 barriers/stage (8 per block for K=256),
//         LDS A[64,88] + B[128,72] = 14,848 B/block -> 2 blocks/CU (occupancy
//         unchanged from the bootstrap's 27,648 B / 2 blocks/CU), 64x128 tile,
//         512 threads / 8 waves, grid (48, 64) = 3072 blocks.
//     The k0-outer / kk-inner int32 accumulation order, the element-to-slot
//     fragment mapping and the fused epilogue are unchanged, so results stay
//     bit-identical (mismatch 0 / max_abs_error 0.0 expected).
//   * Expected measured effect: lds_instructions 3,686,400 -> ~540,672,
//     lds_bank_conflicts 7,864,320 -> ~1,179,648, lds_wait 5,131,888 ->
//     ~162,664, VALU 17.4M -> ~6M, median 313.66 us -> ~275-290 us.
//   * Every other shape keeps the bootstrap arms. The scalar fallback decodes
//     the packed [N, K] layout for (k, n) == (256, 6144) so the paired M=2/M=16
//     API shapes stay correct, and the packed pair never reaches an
//     identity-layout tiled arm.
//
// Round 5 (this session, mandated PACKING round): test one weight
// packing/swizzle that makes each DUMMA B tile vector-loadable and
// LDS-bank-safe, with the pack outside timing and the graph-stable packed
// layout validated.
//   * The accepted round-2 arm stages its 128x64 B tile from the plain
//     n-major [N, K] packed weight: per block-stage the 512 int4 loads are 16
//     n-rows x 4 int4 per 64-lane warp at a 256-B row stride, i.e. every warp
//     instruction touches 16 DISTINCT 128-B lines with only 64 B used in each
//     (the same line is completed by another stage of the same block). Still
//     16-byte vector loads, but scattered at line granularity.
//   * Focused change: the one-time pack for (k, n) == (256, 6144) ONLY becomes
//     the panel layout [N/128][K/64][128][64] (n-major 64-k-byte rows per
//     panel, panels ordered n-tile outer / k-tile inner). Byte-exact index
//     relation: packed[((nt*(k/64)+kt)*128+nn)*64+kk64] ==
//     raw[(nt*128+nn)*k + kt*64+kk64]. Each block's per-stage B tile
//     (n0 == 128*blockIdx.x, k0 == 64*stage) is now ONE contiguous 8 KiB
//     region, so a 64-lane warp instruction reads 1 KiB contiguous (full
//     128-B line utilization) instead of 16 half-used lines; the per-thread
//     address stays one base + one local_col*kStageK + v*16 offset.
//   * Everything else is byte-identical: same 64-K single-buffered stage with
//     two barriers, same 64x128 tile / 512 threads / 8 waves / 32x32 quadrant
//     per wave, same grid (48, 64) = 3072 blocks, same LDS A[64,88] +
//     B[128,72] = 14,848 B/block -> 2 blocks/CU, same ds_write2_b64 8-byte-half
//     staging stores and same conflict-free load_frag8 ds_read_b64 fragment
//     reads (the LDS-bank-safe strides 88/72 and the staged LDS bytes are
//     untouched - only the GLOBAL byte order of the packed buffer changes),
//     same k0-outer/kk-inner int32 order, same fused epilogue -> mismatch 0 /
//     max_abs_error 0.0 expected. The scalar fallback decodes the panel layout
//     for (k, n) == (256, 6144) so the paired M=2/M=16 tails stay correct;
//     every other (k, n) keeps the identity copy. Packing runs
//     out-of-timed/out-of-Graph in launch_pack_w8a8_weight, same byte count
//     (256*6144), same grid (n*k/16 threads), same graph-stable buffer.
//   * Falsifiable gate: median_us < 273.2886219024658 AND p90_us <
//     275.1925849914551 (and mismatch 0 / graph capture true) -> the
//     line-scattered B staging was binding and the panel pack wins; otherwise
//     the plain n-major pack is retained and this round records that the B
//     stream is L2-resident (90.4% hit, same 32 sectors/warp either way) and
//     NOT binding on the latency-stalled critical path.
//
// Round 6 (this session, mandated EPILOGUE round): fuse per-row x per-column
// scaling, bf16 conversion and a fully coalesced final store into the compute
// kernel and remove any unnecessary workspace/combine pass.
//   * The accepted arm already fuses the scaling, conversion and store into
//     w8a8_dumma_proj_operand_reuse_kernel, and the operator never allocates or
//     reads the caller workspace (there is no split-K partial and no combine
//     kernel), so there is no pass to remove. What the round-2..5 epilogue did
//     NOT do is store coalesced: the gfx928 fragment ownership (row = lane & 15,
//     col = (lane >> 4) + 4*i) makes each 64-lane *bf16* store instruction
//     carry 16 rows x 4 columns, i.e. 16 distinct 128-B global lines with only
//     8 useful bytes in each. The exact code object confirms it: 16
//     global_store_short_d16_hi per thread, interleaved with ~20 scalar
//     x_scale/weight_scale loads (the 21 static global loads) and s_waitcnt
//     vmcnt chains, and the counter-derived write traffic is 57,966,336 B for a
//     50,331,648 B bf16 output (1.152x sector overhead) out of 61,997,440 B
//     total per operator replay.
//   * Focused change: the exact-arm epilogue now (a) cooperatively stages the
//     64 x_scale and 128 weight_scale values into the retired A LDS tile with
//     one coalesced load per thread, (b) writes each thread's 16 scaled bf16
//     results into a 64-row x 64-column half of the retired B LDS tile with the
//     bank-safe 8-mod-16 element stride 68 (136 B), and (c) after one barrier
//     writes the half back with 16-byte stores - 8 threads cover one full
//     128-B output line, so a 64-lane store instruction moves 8 complete lines
//     instead of 16 partial ones. Two column halves plus one scale-publish
//     barrier (5 extra barriers per block); the staged bytes are the same
//     values in the same logical [M, N] order, and the scale multiply order
//     ((float)acc * x_scale * weight_scale) and the bf16 conversion are
//     byte-identical, so results stay bit-exact (mismatch 0 / max_abs_error 0.0
//     expected).
//   * The A/B staging buffers are dead after the K loop, so the epilogue reuses
//     them: LDS stays 14,848 B/block -> 2 blocks/CU, the grid stays (48, 64) =
//     3072 blocks and the tile stays 64x128 / 512 threads / 8 waves. Every
//     other shape keeps the bootstrap arms and the scalar fallback (including
//     the shared pair M=2/M=16 down_proj tails) untouched.
//   * Falsifiable gate: median_us < 270.556 us (>= 1% under the 273.2886219 us
//     official best) AND p90_us <= 275.1925849914551, with the coalesced store
//     cutting write_bytes_per_operator_replay from 57,966,336 toward the
//     50,331,648 B theoretical minimum and replacing 393,216 vmem_write
//     instructions with ~98,304 (16 bytes each). If the median does not clear
//     the 1% bar, the direct 2-byte-scatter epilogue is restored.
//
// Round 15 (final consolidate / HIP-only polish on the frozen winning arm):
// move the exact arm's scale delivery from the retired-A LDS slab to
// per-thread registers.
//   * Frozen winning architecture (accepted best 158.0229902267456 us median /
//     158.49021911621094 us p90, source digest c548257a): 64x128 macro-tile,
//     512 threads / 8 waves with a 32x32 quadrant per wave, 64-K
//     single-buffered two-barrier stages, round-5 panel pack
//     [N/128][K/64][128][64], grid (48,64) = 3072 blocks, A[64,88] + B[128,72]
//     = 14,848 B LDS -> 2 blocks/CU (arch_vgpr 48), round-6 LDS-staged
//     coalesced fused epilogue.
//   * Evidence this round acts on: the exact-source PMC (120 CU, 3072 x 512,
//     147.532 us profiled) reports lds_instructions 1,631,232 with
//     lds_wait_instructions 1,486,046 at ~11% SIMD issue utilization, i.e. ~66
//     LDS instructions per wave of which ~60 stall; the epilogue's scale
//     read-back alone is ~10 of those LDS reads per wave (x_scale[row + r] and
//     the four weight_scale columns of each of the two column groups, once per
//     accumulator fragment), all of them on the post-K-loop critical path. The
//     per-block tail is otherwise serialized behind 5 barriers (scale publish +
//     publish/WAR per 64-column half).
//   * Focused change (one bounded mechanism, exact `(m,n,k) == (4096,6144,256)`
//     arm only): each thread loads its OWN two row scales (rows
//     local_row + (lane & 15) and local_row + kTileM + (lane & 15)) and eight
//     column scales (columns local_col + (lane >> 4) + 4*i for the two kTileN
//     column groups) into registers ONCE before the K loop, and
//     stage_epilogue_fragment consumes those registers instead of reading
//     xs_tile/ws_tile from the retired A tile. Consequences: (a) no
//     x_scale/weight_scale is staged into or read back from LDS anywhere in the
//     exact arm, (b) the per-block scale-publish barrier disappears (block
//     barriers 13 -> 12: 8 K-loop + 4 epilogue), (c) the 10 global scale loads
//     per thread are issued before the K loop, so their latency hides behind the
//     four 64-K stages instead of sitting in front of the staging multiplies.
//   * Byte-identical data path: the values are the same x_scale[m0 + row] /
//     weight_scale[n0 + col], the multiply order
//     ((float)acc * x_scale * weight_scale) and the bf16 conversion are
//     unchanged, and every staged LDS address (stride 68) and every coalesced
//     16-byte global store address is unchanged, so mismatch 0 / max_abs_error
//     0.0 are expected. The guard launches exactly grid(n/128, m/64) with
//     m == 4096 and n == 6144, so the registered rows/columns are always in
//     range (m0 + local_row + kTileM + 15 <= 4095, n0 + local_col + kTileN +
//     3 + 12 <= 6139).
//   * Everything else stays byte-identical: tile, grid, waves, K stage,
//     single buffering, panel pack, A/B strides and vectorized staging, LDS
//     14,848 B, kernel name / launch ABI, all shape guards, the generic
//     prefill arms and the scalar fallback.
//   * Falsifiable prediction: median_us <= 158.0229902267456 (expected
//     ~155.8-158.0 us) AND p90_us <= 158.49021911621094, with lds_instructions
//     per wave down by ~10 and lds_wait down by a similar amount while
//     arch_vgpr stays <= 64 (no spills) and the LDS footprint stays 14,848 B.
//     If the median does not improve, the register scales were not on the
//     critical path (the LDS broadcast reads were already cheap) and the
//     round-6 LDS slab is restored.
//
// Round 17 (fix_build, final round): restore a compiling candidate on the
// frozen round-15 winning arm after round 16 produced no valid proposal (the
// worker process exited on a rate-limit crash before any build ran). The only
// landed correction is the round-16 dead-code cleanup of the exact arm's A
// staging helper, re-applied with a consistent API so the definition and its
// single call site agree:
//   * stage_proj_tiles is instantiated ONLY by the exact arm, whose host guard
//     requires m == kExactM and launches exactly grid(n/kBlockN, m/kBlockM), so
//     every staged row m0 + local_row is in range and the per-int4
//     `global_row < m` compare/select/zero-fill was dead. The helper drops its
//     now-unused `m` parameter (the call site drops the argument) and gains a
//     static_assert that the exact arm covers whole kBlockM row tiles; every
//     staged A byte is unchanged, so results stay bit-exact.
//   * Deliberately NOT included: the round-13/16 final-half post-store barrier
//     skip. That is a runtime change whose measured p90 regressed at the 158-us
//     baseline; this round is a build fix, not a latency change.
//   * Everything else is byte-identical to the accepted round-15 best: 64x128
//     macro-tile, 512 threads / 8 waves with a 32x32 quadrant per wave, 64-K
//     single-buffered two-barrier stages, round-5 panel pack
//     [N/128][K/64][128][64], round-15 register scales, round-6 LDS-staged
//     coalesced epilogue (both epilogue barriers kept), A[64,88] + B[128,72] =
//     14,848 B LDS, grid (48,64) = 3072 blocks, 2 blocks/CU, kernel name /
//     launch ABI, every shape guard and the generic scalar fallback.
//   * Falsifiable prediction: build_success true, correctness exact (mismatch 0
//     / max_abs_error 0.0), graph capture true, median_us flat at the accepted
//     best 148.41579914093018 us (the removed compare/select was not on the
//     critical path), p90_us <= 148.8046169281006, arch_vgpr <= 64,
//     scratch_bytes 0 and LDS 14,848 B.
//
// Header order is fixed by the control plane: hip_runtime first (du_mma.h is
// not self-contained before it), hip_bfloat16 second, du_mma.h last.

#include <hip/hip_runtime.h>
#include <hip/hip_bfloat16.h>
#include <du_mma.h>

#include <cstdint>

namespace {

// gfx928 INT8 DUMMA primitive: m16n16k32, int8 x int8 -> int32.
constexpr int kTileM = 16;
constexpr int kTileN = 16;
constexpr int kTileK = 32;

// gfx928 wavefront is 64 lanes; every blockDim must be a multiple of 64.
constexpr int kWaveSize = 64;

// Large-prefill dispatch geometry. Each macro-tile config owns a 32x32
// quadrant per wavefront, so waves per block = (BlockM/32) * (BlockN/32).
constexpr int kPrefillMinM = 128;
constexpr int kDefaultBlockM = 64;
constexpr int kDefaultBlockN = 128;
constexpr int kDefaultStageK = 128;

// Round 2 exact-shape arm: the assigned (4096, 6144, 256) shape only.
constexpr int kExactM = 4096;
constexpr int kExactN = 6144;
constexpr int kExactK = 256;
constexpr int kProjBlockM = 64;
constexpr int kProjBlockN = 128;
constexpr int kProjStageK = 64;
// The exact-shape arm uses the bank-safe 8-mod-16 LDS row strides A = 88
// (kProjStageK + 24) and B = 72 (kProjStageK + 8); see the round-2 header
// comment. The stride scheme assumes kStageK == 64.

// Round 6 (epilogue round) LDS staging geometry for the fused epilogue: the
// 64x128 bf16 output tile is staged one 64-column half at a time (kEpiCols)
// into the retired B staging buffer with the bank-safe 8-mod-16 element row
// stride kEpiStride = 68 bf16 = 136 B (16 row starts land on 16 distinct LDS
// banks and the stride stays 8-byte aligned for the int64 read-back). The
// retired A staging buffer holds the 64 x_scale and 128 weight_scale values.
constexpr int kEpiCols = 64;
constexpr int kEpiStride = 68;

constexpr int kScalarThreads = 256;

using namespace du::dumma;

// Verified gfx928 INT8 DUMMA accumulator ownership:
//   row = lane & 15, col_mod4 = lane >> 4, frag.x[i] -> columns
//   col_mod4 + 4*i.
// Scale by x_scale[row] and weight_scale[col] and store bf16 directly from the
// fragment (no accumulator LDS round trip). Tail rows (row >= m) are masked.
template <typename AccFragment>
__device__ __forceinline__ void store_prefill_fragment(
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
  if (row >= m) {
    return;
  }
  const int col_mod4 = lane >> 4;
  const float xs = x_scale[row];
#pragma unroll
  for (int i = 0; i < 4; ++i) {
    const int col = base_col + col_mod4 + 4 * i;
    const float scaled =
        static_cast<float>(frag.x[i]) * xs * weight_scale[col];
    out[static_cast<int64_t>(row) * n + col] = __float2bfloat16(scaled);
  }
}

// Round 2 exact-shape fragment loader. The library row_major matrix_a and
// col_major matrix_b m16n16k32 int8 loaders both map lane l -> row (l & 15),
// k-quarter (l >> 4), and fetch the eight contiguous bytes at
// p[row*ldm + (l >> 4)*8 .. +7] into the fragment's x[0..7] slots in the same
// little-endian order. Loading those 8 bytes as one int64 emits a single
// 8-byte LDS read instead of the library's byte-wise loads plus per-byte
// reassembly VALU; the element-to-slot mapping is identical, so the MMAC
// operands and the exact int32 accumulation are unchanged.
template <typename Frag>
__device__ __forceinline__ void load_frag8(Frag& f,
                                           const int8_t* p,
                                           unsigned ldm,
                                           int lane) {
  const unsigned row = static_cast<unsigned>(lane) & 0xf;
  const unsigned kq = static_cast<unsigned>(lane) >> 4;
  const int64_t v =
      *reinterpret_cast<const int64_t*>(p + row * ldm + (kq << 3));
  reinterpret_cast<int64_t*>(f.x)[0] = v;
}

// Stage one K tile (k0) of A[kBlockM, kStageK] (row-major, zero-filled tail M
// rows) and B[kStageK, kBlockN] (identity [K, N] layout) into LDS with
// 16-byte-vectorized coalesced global loads. The B row stride kBlockN + 16 is
// the non-power-of-two bank skew that spreads the row_major fragment reads.
template <int kBlockM, int kBlockN, int kStageK>
__device__ __forceinline__ void stage_prefill_tiles(
    const int8_t* __restrict__ x_q,
    const int8_t* __restrict__ weight,
    int8_t* a_tile,
    int8_t* b_tile,
    int tid,
    int m0,
    int n0,
    int m,
    int n,
    int k,
    int k0) {
  constexpr int kThreads = kBlockM * kBlockN / 1024 * kWaveSize;
  constexpr int kAStride = kStageK + sizeof(int4);
  constexpr int kBStride = kBlockN + sizeof(int4);
  constexpr int kAInt4PerRow = kStageK / sizeof(int4);
  constexpr int kAInt4 = kBlockM * kAInt4PerRow;
  constexpr int kBInt4PerRow = kBlockN / sizeof(int4);
  constexpr int kBInt4 = kStageK * kBInt4PerRow;
  static_assert(kAStride % sizeof(int4) == 0,
                "A LDS row stride must stay int4 aligned");
  static_assert(kBStride % sizeof(int4) == 0,
                "B LDS row stride must stay int4 aligned");

  // Stage A[kBlockM, kStageK]; rows beyond m contribute zeros.
  for (int vec = tid; vec < kAInt4; vec += kThreads) {
    const int local_row = vec / kAInt4PerRow;
    const int v = vec - local_row * kAInt4PerRow;
    const int global_row = m0 + local_row;
    const int4 val =
        global_row < m
            ? *reinterpret_cast<const int4*>(
                  x_q + static_cast<int64_t>(global_row) * k + k0 +
                  v * static_cast<int>(sizeof(int4)))
            : int4{0, 0, 0, 0};
    reinterpret_cast<int4*>(a_tile + local_row * kAStride)[v] = val;
  }

  // Stage B[kStageK, kBlockN] from the identity [K, N] weight (n%kBlockN == 0
  // is guaranteed by dispatch, so there is no N tail).
  for (int vec = tid; vec < kBInt4; vec += kThreads) {
    const int kk = vec / kBInt4PerRow;
    const int v = vec - kk * kBInt4PerRow;
    reinterpret_cast<int4*>(b_tile + kk * kBStride)[v] =
        *reinterpret_cast<const int4*>(
            weight + static_cast<int64_t>(k0 + kk) * n + n0 +
            v * static_cast<int>(sizeof(int4)));
  }
}

// One wavefront's 32x32-quadrant MMAC burst for the K tile staged at
// a_tile/b_tile. k0-outer / kk-inner int32 accumulation order; the int8 dot is
// exact in int32 for every allowed K.
template <int kBlockM, int kBlockN, int kStageK>
__device__ __forceinline__ void mmac_prefill_stage(
    DUFragment<matrix_a, kTileM, kTileN, kTileK, signed char, row_major>&
        a_frag0,
    DUFragment<matrix_a, kTileM, kTileN, kTileK, signed char, row_major>&
        a_frag1,
    DUFragment<accumulator, kTileM, kTileN, kTileK, int>& acc00,
    DUFragment<accumulator, kTileM, kTileN, kTileK, int>& acc01,
    DUFragment<accumulator, kTileM, kTileN, kTileK, int>& acc10,
    DUFragment<accumulator, kTileM, kTileN, kTileK, int>& acc11,
    int8_t* a_tile,
    int8_t* b_tile,
    int local_row,
    int local_col) {
  constexpr int kAStride = kStageK + sizeof(int4);
  constexpr int kBStride = kBlockN + sizeof(int4);
  DUFragment<matrix_b, kTileM, kTileN, kTileK, signed char, row_major>
      b_frag0, b_frag1;
#pragma unroll
  for (int kk = 0; kk < kStageK; kk += kTileK) {
    du_load_matrix_sync(
        a_frag0, a_tile + local_row * kAStride + kk, kAStride);
    du_load_matrix_sync(
        a_frag1, a_tile + (local_row + kTileM) * kAStride + kk, kAStride);
    du_load_matrix_sync(
        b_frag0, b_tile + kk * kBStride + local_col, kBStride);
    du_load_matrix_sync(
        b_frag1, b_tile + kk * kBStride + local_col + kTileN, kBStride);
    du_mma_sync(acc00, a_frag0, b_frag0, acc00);
    du_mma_sync(acc01, a_frag0, b_frag1, acc01);
    du_mma_sync(acc10, a_frag1, b_frag0, acc10);
    du_mma_sync(acc11, a_frag1, b_frag1, acc11);
  }
}

// Round 2 exact-shape staging: A[kBlockM, kStageK] from the row-major [M, K]
// activation (zero-filled tail rows) and B[kBlockN, kStageK] from the packed
// weight, both with 16-byte vectorized coalesced global int4 loads. The LDS
// row strides are the bank-safe 8-mod-16 values A = 88 / B = 72; 8-mod-16 row
// starts forbid 16-byte stores, so each int4 is written as two 8-byte halves
// (ds_write_b64 pair, same LDS bytes as a single 16-byte store would produce).
//
// kBPanel (round 5, exact-shape arm only, default true): B is read from the
// panel layout [N/128][K/64][128][64] instead of the plain n-major [N, K]
// transpose. Within a panel (nt = n0/128, kt = k0/64) the B rows are
// kStageK = 64 bytes apart with k contiguous, so local_col*kStageK + v*16 ==
// vec*16 and the whole 64-lane warp instruction reads kBlockN*kStageK/8 = 1 KiB
// of consecutive bytes. The staged LDS bytes are byte-identical to the plain
// form (the same int4 of the same logical [K, N] element block lands at the
// same LDS address), so the LDS-bank-safe fragment side is untouched.
template <int kBlockM, int kBlockN, int kStageK, bool kBPanel = true>
__device__ __forceinline__ void stage_proj_tiles(
    const int8_t* __restrict__ x_q,
    const int8_t* __restrict__ weight,
    int8_t* a_tile,
    int8_t* b_tile,
    int tid,
    int m0,
    int n0,
    int k,
    int k0) {
  constexpr int kThreads = kBlockM * kBlockN / 1024 * kWaveSize;
  constexpr int kAStride = kStageK + 24;
  constexpr int kBStride = kStageK + 8;
  constexpr int kAInt4PerRow = kStageK / sizeof(int4);
  constexpr int kAInt4 = kBlockM * kAInt4PerRow;
  constexpr int kBInt4PerRow = kStageK / sizeof(int4);
  constexpr int kBInt4 = kBlockN * kBInt4PerRow;
  static_assert(kAStride % 8 == 0 && kBStride % 8 == 0,
                "8-mod-16 strides must stay 8-byte aligned");
  static_assert(kAInt4 <= kThreads && kBInt4 <= kThreads,
                "one staging pass per thread is enough for this arm");
  static_assert(!kBPanel || (kBlockN == kProjBlockN && kStageK == kProjStageK),
                "panel pack is specialized to the 128x64 B stage tile");
  static_assert(kExactM % kBlockM == 0,
                "exact-arm guard launches whole kBlockM row tiles, so no M "
                "tail can reach this staging helper");

  // Stage A[kBlockM, kStageK]. The exact-arm host guard requires m == kExactM
  // and launches exactly grid(n/kBlockN, m/kBlockM), so every staged row
  // m0 + local_row is in range and the former `global_row < m`
  // compare/select/zero-fill was dead code (round 17 fix_build). Every staged
  // A byte is identical to the zero-filled form.
  for (int vec = tid; vec < kAInt4; vec += kThreads) {
    const int local_row = vec / kAInt4PerRow;
    const int v = vec - local_row * kAInt4PerRow;
    const int4 val = *reinterpret_cast<const int4*>(
        x_q + static_cast<int64_t>(m0 + local_row) * k + k0 +
        v * static_cast<int>(sizeof(int4)));
    int8_t* dst =
        a_tile + local_row * kAStride + v * static_cast<int>(sizeof(int4));
    reinterpret_cast<int64_t*>(dst)[0] =
        reinterpret_cast<const int64_t*>(&val)[0];
    reinterpret_cast<int64_t*>(dst)[1] =
        reinterpret_cast<const int64_t*>(&val)[1];
  }

  // Stage B[kBlockN, kStageK] from the packed weight: the round-5 panel
  // layout [N/128][K/64][128][64] (one contiguous kBlockN*kStageK = 8 KiB
  // region per timed block-stage, fully coalesced 1 KiB per 64-lane warp) or
  // the round-2 plain n-major [N, K] transpose. Both forms place the same
  // bytes at the same LDS address, so only the global read side changes.
  for (int vec = tid; vec < kBInt4; vec += kThreads) {
    const int local_col = vec / kBInt4PerRow;
    const int v = vec - local_col * kBInt4PerRow;
    int4 val;
    if constexpr (kBPanel) {
      // Panel (nt = n0/kBlockN, kt = k0/kStageK) base in bytes. Within a
      // panel the local B rows are kStageK bytes apart and k is contiguous,
      // so local_col*kStageK + v*16 == vec*16.
      const int64_t panel_base =
          (static_cast<int64_t>(n0) / kBlockN) * (k / kStageK) *
              (static_cast<int64_t>(kBlockN) * kStageK) +
          (static_cast<int64_t>(k0) / kStageK) *
              (static_cast<int64_t>(kBlockN) * kStageK);
      val = *reinterpret_cast<const int4*>(
          weight + panel_base + static_cast<int64_t>(local_col) * kStageK +
          v * static_cast<int>(sizeof(int4)));
    } else {
      // Plain n-major [N, K]: packed[col * k + kk] == raw[kk * n + col].
      val = *reinterpret_cast<const int4*>(
          weight + static_cast<int64_t>(n0 + local_col) * k + k0 +
          v * static_cast<int>(sizeof(int4)));
    }
    int8_t* dst =
        b_tile + local_col * kBStride + v * static_cast<int>(sizeof(int4));
    reinterpret_cast<int64_t*>(dst)[0] =
        reinterpret_cast<const int64_t*>(&val)[0];
    reinterpret_cast<int64_t*>(dst)[1] =
        reinterpret_cast<const int64_t*>(&val)[1];
  }
}

// Round 2 exact-shape MMAC burst: eight explicit 8-byte load_frag8 fragment
// reads (A row_major / B col_major, bank-safe 88/72 strides) and the same
// eight m16n16k32 MMACs in the same k0-outer / kk-inner int32 order the
// library-loader bootstrap used, so the accumulation is bit-identical.
template <int kBlockM, int kBlockN, int kStageK>
__device__ __forceinline__ void mmac_proj_stage(
    DUFragment<matrix_a, kTileM, kTileN, kTileK, signed char, row_major>&
        a_frag0,
    DUFragment<matrix_a, kTileM, kTileN, kTileK, signed char, row_major>&
        a_frag1,
    DUFragment<accumulator, kTileM, kTileN, kTileK, int>& acc00,
    DUFragment<accumulator, kTileM, kTileN, kTileK, int>& acc01,
    DUFragment<accumulator, kTileM, kTileN, kTileK, int>& acc10,
    DUFragment<accumulator, kTileM, kTileN, kTileK, int>& acc11,
    int8_t* a_tile,
    int8_t* b_tile,
    int local_row,
    int local_col,
    int lane) {
  constexpr int kAStride = kStageK + 24;
  constexpr int kBStride = kStageK + 8;
  static_assert(kStageK == 2 * kTileK,
                "exact-shape arm unrolls the two 32-K steps of a 64-K stage");
  DUFragment<matrix_a, kTileM, kTileN, kTileK, signed char, row_major>
      a_frag0_1, a_frag1_1;
  DUFragment<matrix_b, kTileM, kTileN, kTileK, signed char, col_major>
      b_frag0, b_frag1, b_frag0_1, b_frag1_1;
  load_frag8(a_frag0, a_tile + local_row * kAStride, kAStride, lane);
  load_frag8(a_frag1, a_tile + (local_row + kTileM) * kAStride, kAStride, lane);
  load_frag8(b_frag0, b_tile + local_col * kBStride, kBStride, lane);
  load_frag8(b_frag1, b_tile + (local_col + kTileN) * kBStride, kBStride, lane);
  load_frag8(a_frag0_1, a_tile + local_row * kAStride + kTileK, kAStride, lane);
  load_frag8(a_frag1_1, a_tile + (local_row + kTileM) * kAStride + kTileK,
             kAStride, lane);
  load_frag8(b_frag0_1, b_tile + local_col * kBStride + kTileK, kBStride, lane);
  load_frag8(b_frag1_1, b_tile + (local_col + kTileN) * kBStride + kTileK,
             kBStride, lane);
  du_mma_sync(acc00, a_frag0, b_frag0, acc00);
  du_mma_sync(acc01, a_frag0, b_frag1, acc01);
  du_mma_sync(acc10, a_frag1, b_frag0, acc10);
  du_mma_sync(acc11, a_frag1, b_frag1, acc11);
  du_mma_sync(acc00, a_frag0_1, b_frag0_1, acc00);
  du_mma_sync(acc01, a_frag0_1, b_frag1_1, acc01);
  du_mma_sync(acc10, a_frag1_1, b_frag0_1, acc10);
  du_mma_sync(acc11, a_frag1_1, b_frag1_1, acc11);
}

// Round 6 (EPILOGUE round) fused-epilogue helpers.
//
// Rounds 2-5 converted each accumulator fragment straight to bf16 and issued 16
// scattered 2-byte global stores per thread. One 64-lane store instruction
// carried 16 rows x 4 columns, i.e. 16 distinct 128-B lines with only 8 useful
// bytes in each, and the exact gfx928 code object shows the epilogue
// serialized behind 16 global_store_short plus ~20 scalar x_scale /
// weight_scale loads per thread. Round 6 keeps the per-row x per-column scale
// multiply and the bf16 conversion inside the compute kernel but routes the
// result through a shared-memory staging tile and writes the tile back with
// fully coalesced 16-byte stores: 8 threads cover one full 128-B row segment,
// so a 64-lane store instruction moves 8 complete lines instead of 16
// fragments of lines. The per-row / per-column scales are staged cooperatively
// into LDS once per block (one coalesced global load per thread), which removes
// the scalar global scale loads entirely; round 15 later replaces that LDS slab
// with per-thread scale registers (see below).
//
// The staged half tile is written as plain bf16 elements; the 8-mod-16 row
// stride (136 B) keeps the 16 row starts on distinct LDS banks and stays
// 8-byte aligned for the int64 read-back.
//
// Round 15 (final consolidate polish): the two row scales and the four
// per-column scales this wave needs for one kTileN column group are passed in
// as registers instead of being read back from an LDS scale slab. The wave's
// rows are local_row + (lane & 15) and local_row + kTileM + (lane & 15), and
// its columns are col + (lane >> 4) + 4*i, so every thread owns exactly two row
// scales and eight column scales (four per column group). They are loaded once
// per thread before the K loop, their global-load latency hides behind the four
// 64-K stages, and the epilogue therefore issues no scale LDS reads at all.
// The multiply order ((float)acc * x_scale * weight_scale), the bf16 conversion
// and every staged LDS / stored global address are unchanged, so results stay
// bit-exact.
template <int kStride, typename AccFragment>
__device__ __forceinline__ void stage_epilogue_fragment(
    const AccFragment& frag,
    float xs,
    const float (&ws)[4],
    hip_bfloat16* __restrict__ epi,
    int row,
    int col,
    int col_base,
    int lane) {
  const int r = lane & 15;
  const int q = lane >> 4;
#pragma unroll
  for (int i = 0; i < 4; ++i) {
    const float scaled = static_cast<float>(frag.x[i]) * xs * ws[i];
    epi[(row + r) * kStride + (col - col_base) + q + 4 * i] =
        __float2bfloat16(scaled);
  }
}

// Coalesced write-back of one staged 64-column bf16 half: thread `tid` owns a
// 16-byte segment of one output row (8 threads per 128-B line), so the whole
// block writes each half with one 16-byte store per thread and fully-used
// 128-B lines, in the same logical [M, N] bf16 order the scalar fallback
// produces. The staged LDS row stride (136 B) is only 8-byte aligned, so the
// LDS side reads two int64 halves and the global side re-forms the aligned
// 16-byte vector.
struct alignas(16) EpiQuad {
  int64_t lo;
  int64_t hi;
};

__device__ __forceinline__ void store_epilogue_half(
    const hip_bfloat16* __restrict__ epi,
    hip_bfloat16* __restrict__ out,
    int m0,
    int n0,
    int col_base,
    int n,
    int tid) {
  const int row = tid >> 3;
  const int seg = tid & 7;
  const int64_t* src =
      reinterpret_cast<const int64_t*>(epi + row * kEpiStride + seg * 8);
  EpiQuad q;
  q.lo = src[0];
  q.hi = src[1];
  hip_bfloat16* dst = out + static_cast<int64_t>(m0 + row) * n + n0 +
                      col_base + seg * 8;
  *reinterpret_cast<EpiQuad*>(dst) = q;
}

// Round 2 exact-shape kernel: one block computes a kBlockM x kBlockN output
// tile of the assigned (4096, 6144, 256) shape. (kBlockM/32) * (kBlockN/32)
// wavefronts each own a 32x32 quadrant (four m16n16k32 DUMMA accumulators),
// while the block cooperatively stages A[kBlockM, kStageK] from the
// row-major [M, K] activation and B[kBlockN, kStageK] from the round-5 panel
// packed weight. Single-buffered 64-K stages (two barriers per stage). The
// round-6 fused epilogue stages the scaled bf16 output through LDS and writes
// it back coalesced; there is no workspace use and no separate convert or
// combine pass anywhere in this operator.
template <int kBlockM, int kBlockN, int kStageK>
__global__ __launch_bounds__(kBlockM * kBlockN / 1024 * kWaveSize) void
w8a8_dumma_proj_operand_reuse_kernel(
    const int8_t* __restrict__ x_q,
    const int8_t* __restrict__ weight,
    const float* __restrict__ x_scale,
    const float* __restrict__ weight_scale,
    hip_bfloat16* __restrict__ out,
    int m,
    int n,
    int k) {
  constexpr int kWavesN = kBlockN / 32;
  constexpr int kAStride = kStageK + 24;
  constexpr int kBStride = kStageK + 8;
  constexpr int kABytes = kBlockM * kAStride;
  constexpr int kBBytes = kBlockN * kBStride;
  static_assert(kStageK == 2 * kTileK,
                "exact-shape arm unrolls the two 32-K steps of a 64-K stage");
  static_assert(kAStride % 8 == 0 && kBStride % 8 == 0,
                "8-mod-16 strides must stay 8-byte aligned");
  static_assert(kBlockM % 32 == 0 && kBlockN % 32 == 0,
                "macro-tile must be a whole number of 32x32 quadrants");
  static_assert(kBlockM % kTileM == 0 && kBlockN % kTileN == 0,
                "macro-tile must be a whole number of DUMMA tiles");

  const int tid = static_cast<int>(threadIdx.x);
  const int wave = tid / kWaveSize;
  const int lane = tid - wave * kWaveSize;
  const int wave_row = wave / kWavesN;
  const int wave_col = wave - wave_row * kWavesN;
  const int m0 = static_cast<int>(blockIdx.y) * kBlockM;
  const int n0 = static_cast<int>(blockIdx.x) * kBlockN;
  const int local_row = wave_row * 32;
  const int local_col = wave_col * 32;

  __shared__ __align__(16) int8_t a_tile[kABytes];
  __shared__ __align__(16) int8_t b_tile[kBBytes];

  DUFragment<matrix_a, kTileM, kTileN, kTileK, signed char, row_major>
      a_frag0, a_frag1;
  DUFragment<accumulator, kTileM, kTileN, kTileK, int>
      acc00, acc01, acc10, acc11;
  du_fill_fragment(acc00, 0);
  du_fill_fragment(acc01, 0);
  du_fill_fragment(acc10, 0);
  du_fill_fragment(acc11, 0);

  // Round 15 register scales: the two row scales and the eight column scales
  // this wave's epilogue needs are loaded ONCE per thread here, before the K
  // loop, so their global-load latency is hidden behind the four 64-K stages
  // and the epilogue neither stages nor reads any scale through LDS. local_row
  // / local_col are wave_row*32 / wave_col*32; the exact arm always has
  // m0 == 64*blockIdx.y so m0 + local_row + kTileM + 15 <= 4095 < m, and
  // n0 + local_col + kTileN + 3 + 12 <= 6139 < n, so no tail masking is needed.
  const int epi_r = lane & 15;
  const int epi_q = lane >> 4;
  const float xs0 = x_scale[m0 + local_row + epi_r];
  const float xs1 = x_scale[m0 + local_row + kTileM + epi_r];
  float ws_a[kTileN / 4];
  float ws_b[kTileN / 4];
#pragma unroll
  for (int i = 0; i < kTileN / 4; ++i) {
    ws_a[i] = weight_scale[n0 + local_col + epi_q + 4 * i];
    ws_b[i] = weight_scale[n0 + local_col + kTileN + epi_q + 4 * i];
  }

  for (int k0 = 0; k0 < k; k0 += kStageK) {
    stage_proj_tiles<kBlockM, kBlockN, kStageK>(
        x_q, weight, a_tile, b_tile, tid, m0, n0, k, k0);
    __syncthreads();

    mmac_proj_stage<kBlockM, kBlockN, kStageK>(
        a_frag0, a_frag1, acc00, acc01, acc10, acc11, a_tile, b_tile,
        local_row, local_col, lane);
    // Retire this stage's fragment reads before the next stage's staging
    // writes overwrite the single LDS buffer (WAR hazard across waves).
    __syncthreads();
  }

  // ---- Round 6 fused coalesced epilogue (round-15 register scales) ------
  // The A and B staging buffers are dead after the K loop (the final
  // __syncthreads retires the last fragment reads), so the B tile becomes the
  // bf16 output staging area: same 14,848 B footprint, same 2 blocks/CU
  // occupancy. The scale factors live in the per-thread registers loaded before
  // the K loop, so the retired A tile is not touched here and no scale-publish
  // barrier is needed. Rows are always in range for this arm because the host
  // guard launches exactly grid(n / kBlockN, m / kBlockM).
  constexpr int kEpiHalfBytes = kBlockM * kEpiStride * sizeof(hip_bfloat16);
  static_assert(kEpiHalfBytes <= kBBytes,
                "one 64-column bf16 half must fit the retired B tile");
  static_assert(kBlockN % kEpiCols == 0, "epilogue halves must tile kBlockN");
  auto* epi = reinterpret_cast<hip_bfloat16*>(b_tile);

#pragma unroll
  for (int half = 0; half < kBlockN / kEpiCols; ++half) {
    const int col_base = half * kEpiCols;
    if (local_col >= col_base && local_col < col_base + kEpiCols) {
      stage_epilogue_fragment<kEpiStride>(
          acc00, xs0, ws_a, epi, local_row, local_col, col_base, lane);
      stage_epilogue_fragment<kEpiStride>(
          acc01, xs0, ws_b, epi, local_row, local_col + kTileN, col_base,
          lane);
      stage_epilogue_fragment<kEpiStride>(
          acc10, xs1, ws_a, epi, local_row + kTileM, local_col, col_base,
          lane);
      stage_epilogue_fragment<kEpiStride>(
          acc11, xs1, ws_b, epi, local_row + kTileM, local_col + kTileN,
          col_base, lane);
    }
    __syncthreads();
    store_epilogue_half(epi, out, m0, n0, col_base, n, tid);
    // Retire this half's staging reads before the next half overwrites the
    // single staging buffer (WAR hazard across waves).
    __syncthreads();
  }
}

// Large-prefill path: one block computes a kBlockM x kBlockN output tile.
// (kBlockM/32) * (kBlockN/32) wavefronts each own a 32x32 quadrant (four
// m16n16k32 DUMMA accumulators), while the block cooperatively stages
// A[kBlockM, kStageK] and B[kStageK, kBlockN] in bank-skewed LDS.
//
// Single-buffered K loop (two barriers per stage): stage s+1's global loads
// cannot start until the stage-s barrier, so each stage serializes one
// global-load round trip in front of its MMAC burst. Co-resident blocks hide
// that latency at the CU level, and the bootstrap deliberately avoids the
// copy/pipeline complexity that later rounds may add.
template <int kBlockM, int kBlockN, int kStageK>
__global__ __launch_bounds__(kBlockM * kBlockN / 1024 * kWaveSize) void
w8a8_dumma_prefill_tiled_kernel(
    const int8_t* __restrict__ x_q,
    const int8_t* __restrict__ weight,
    const float* __restrict__ x_scale,
    const float* __restrict__ weight_scale,
    hip_bfloat16* __restrict__ out,
    int m,
    int n,
    int k) {
  constexpr int kWavesN = kBlockN / 32;
  constexpr int kAStride = kStageK + sizeof(int4);
  constexpr int kBStride = kBlockN + sizeof(int4);
  constexpr int kABytes = kBlockM * kAStride;
  constexpr int kBBytes = kStageK * kBStride;
  static_assert(kStageK % kTileK == 0,
                "K stage must be a multiple of the DUMMA K unit");
  static_assert(kStageK % static_cast<int>(sizeof(int4)) == 0,
                "K stage must keep int4 staging aligned");
  static_assert(kBlockM % 32 == 0 && kBlockN % 32 == 0,
                "macro-tile must be a whole number of 32x32 quadrants");
  static_assert(kBlockM % kTileM == 0 && kBlockN % kTileN == 0,
                "macro-tile must be a whole number of DUMMA tiles");

  const int tid = static_cast<int>(threadIdx.x);
  const int wave = tid / kWaveSize;
  const int lane = tid - wave * kWaveSize;
  const int wave_row = wave / kWavesN;
  const int wave_col = wave - wave_row * kWavesN;
  const int m0 = static_cast<int>(blockIdx.y) * kBlockM;
  const int n0 = static_cast<int>(blockIdx.x) * kBlockN;
  const int local_row = wave_row * 32;
  const int local_col = wave_col * 32;

  __shared__ __align__(16) int8_t a_tile[kABytes];
  __shared__ __align__(16) int8_t b_tile[kBBytes];

  DUFragment<matrix_a, kTileM, kTileN, kTileK, signed char, row_major>
      a_frag0, a_frag1;
  DUFragment<accumulator, kTileM, kTileN, kTileK, int>
      acc00, acc01, acc10, acc11;
  du_fill_fragment(acc00, 0);
  du_fill_fragment(acc01, 0);
  du_fill_fragment(acc10, 0);
  du_fill_fragment(acc11, 0);

  for (int k0 = 0; k0 < k; k0 += kStageK) {
    stage_prefill_tiles<kBlockM, kBlockN, kStageK>(
        x_q, weight, a_tile, b_tile, tid, m0, n0, m, n, k, k0);
    __syncthreads();

    mmac_prefill_stage<kBlockM, kBlockN, kStageK>(
        a_frag0, a_frag1, acc00, acc01, acc10, acc11, a_tile, b_tile,
        local_row, local_col);
    // Retire this stage's fragment reads before the next stage's staging
    // writes overwrite the single LDS buffer (WAR hazard across waves).
    __syncthreads();
  }

  const int base_row = m0 + wave_row * 32;
  const int base_col = n0 + wave_col * 32;
  store_prefill_fragment(
      acc00, x_scale, weight_scale, out, m, n, base_row, base_col, lane);
  store_prefill_fragment(
      acc01, x_scale, weight_scale, out, m, n, base_row, base_col + kTileN,
      lane);
  store_prefill_fragment(
      acc10, x_scale, weight_scale, out, m, n, base_row + kTileM, base_col,
      lane);
  store_prefill_fragment(
      acc11, x_scale, weight_scale, out, m, n, base_row + kTileM,
      base_col + kTileN, lane);
}

// Generic scalar fallback: one output element per grid-stride iteration with
// exact int32 accumulation. Correct for any (m, n, k), including the small-M
// API shapes (M=2/16) and any unmatched geometry. The weight buffer is the
// identity [K, N] row-major layout for every (k, n) EXCEPT the packed
// down_proj pair (k, n) == (256, 6144), whose buffer is the round-5 panel
// layout [N/128][K/64][128][64]
// (packed[((nt*4+kt)*128+nn)*64+kk64] == raw[(nt*128+nn)*k + kt*64+kk64]
// with nt = col/128, nn = col%128, kt = kk/64, kk64 = kk%64); this kernel
// decodes that layout so the paired M=2/M=16 down_proj tails stay correct.
__global__ __launch_bounds__(kScalarThreads) void w8a8_gemm_scalar_kernel(
    const int8_t* __restrict__ x_q,
    const int8_t* __restrict__ weight,
    const float* __restrict__ x_scale,
    const float* __restrict__ weight_scale,
    hip_bfloat16* __restrict__ out,
    int m,
    int n,
    int k) {
  const bool b_panel = (k == kExactK && n == kExactN);
  const int64_t total = static_cast<int64_t>(m) * n;
  const int64_t stride = static_cast<int64_t>(gridDim.x) * blockDim.x;
  for (int64_t idx = static_cast<int64_t>(blockIdx.x) * blockDim.x +
                     threadIdx.x;
       idx < total; idx += stride) {
    const int row = static_cast<int>(idx / n);
    const int col = static_cast<int>(idx - static_cast<int64_t>(row) * n);
    const int8_t* a_row = x_q + static_cast<int64_t>(row) * k;
    int32_t acc = 0;
    if (b_panel) {
      // Round-5 panel decode: the logical [K, N] element (row kk, column
      // col) lives at ((nt*(k/64)+kt)*128 + nn)*64 + kk64.
      const int nt = col / kProjBlockN;
      const int nn = col - nt * kProjBlockN;
      const int64_t panel_base =
          static_cast<int64_t>(nt) * (k / kProjStageK) *
              (kProjBlockN * kProjStageK) +
          static_cast<int64_t>(nn) * kProjStageK;
      for (int kk = 0; kk < k; ++kk) {
        const int kt = kk / kProjStageK;
        const int kk64 = kk - kt * kProjStageK;
        acc += static_cast<int32_t>(a_row[kk]) *
               static_cast<int32_t>(
                   weight[panel_base +
                          static_cast<int64_t>(kt) *
                              (kProjBlockN * kProjStageK) +
                          kk64]);
      }
    } else {
      for (int kk = 0; kk < k; ++kk) {
        acc += static_cast<int32_t>(a_row[kk]) *
               static_cast<int32_t>(
                   weight[static_cast<int64_t>(kk) * n + col]);
      }
    }
    const float scaled =
        static_cast<float>(acc) * x_scale[row] * weight_scale[col];
    out[idx] = __float2bfloat16(scaled);
  }
}

// Bootstrap pack: identity device-to-device copy of the logical [K, N] weight
// and the [N] weight scale. Runs outside the timed/CUDA-Graph region; the
// destination buffers are the graph-stable ones returned by pack_weight.
__global__ __launch_bounds__(kScalarThreads) void w8a8_pack_identity_kernel(
    const int8_t* __restrict__ raw_weight,
    const float* __restrict__ weight_scale,
    int8_t* __restrict__ packed_weight,
    float* __restrict__ packed_weight_scale,
    int64_t weight_elems,
    int n) {
  const int64_t stride = static_cast<int64_t>(gridDim.x) * blockDim.x;
  for (int64_t idx = static_cast<int64_t>(blockIdx.x) * blockDim.x +
                     threadIdx.x;
       idx < weight_elems; idx += stride) {
    packed_weight[idx] = raw_weight[idx];
  }
  for (int64_t idx = static_cast<int64_t>(blockIdx.x) * blockDim.x +
                     threadIdx.x;
       idx < n; idx += stride) {
    packed_weight_scale[idx] = weight_scale[idx];
  }
}

// Round 5 (PACKING round) down_proj pack: raw [K, N] -> panel layout
// [N/128][K/64][128][64] for (k, n) == (256, 6144) only. Byte-exact index
// relation (verified by the int4 decode below):
//   packed[((nt * (k/64) + kt) * 128 + nn) * 64 + kk64] ==
//     raw[(nt * 128 + nn) * k + (kt * 64 + kk64)]
// with nt in [0, n/128), kt in [0, k/64), nn in [0, 128), kk64 in [0, 64).
// Each packed int4 (idx4) decodes as v = idx4 % 4, row_p = idx4 / 4,
// nn = row_p % 128, kt = (row_p / 128) % (k/64), nt = (row_p / 128) / (k/64),
// kk = kt * 64 + v * 16, cc = nt * 128 + nn; the 16 stored bytes are the same
// 16-row gather at column cc as the round-2 transpose, so every thread still
// stores one aligned int4 and the packed write side stays fully coalesced.
// The panel layout makes each timed block's per-stage B tile (128 n x 64 k =
// 8 KiB) ONE contiguous region, so a 64-lane warp's B staging load reads 1 KiB
// contiguous instead of 16 rows x 64 B at a 256-B row stride (16 distinct
// 128-B lines per warp, half of each line used). Runs outside the
// timed/CUDA-Graph region; same byte count, same grid, same graph-stable
// buffer, byte-exact vs the raw logical [K, N] weight.
__global__ __launch_bounds__(kScalarThreads) void
w8a8_pack_downproj_panel_kernel(
    const int8_t* __restrict__ raw_weight,
    const float* __restrict__ weight_scale,
    int8_t* __restrict__ packed_weight,
    float* __restrict__ packed_weight_scale,
    int k,
    int n) {
  const int64_t total4 =
      (static_cast<int64_t>(n) * k) / static_cast<int>(sizeof(int4));
  const int64_t stride4 = static_cast<int64_t>(gridDim.x) * blockDim.x;
  for (int64_t idx4 = static_cast<int64_t>(blockIdx.x) * blockDim.x +
                      threadIdx.x;
       idx4 < total4; idx4 += stride4) {
    const int v = static_cast<int>(idx4 & 3);
    const int64_t row_p = idx4 >> 2;
    const int nn = static_cast<int>(row_p % kProjBlockN);
    const int64_t kt_tmp = row_p / kProjBlockN;      // nt * (k/64) + kt
    const int kt = static_cast<int>(kt_tmp % (k / kProjStageK));
    const int nt = static_cast<int>(kt_tmp / (k / kProjStageK));
    const int kk = kt * kProjStageK + v * static_cast<int>(sizeof(int4));
    const int cc = nt * kProjBlockN + nn;
    const int8_t* src = raw_weight + static_cast<int64_t>(kk) * n + cc;
    int4 val;
    char* vp = reinterpret_cast<char*>(&val);
#pragma unroll
    for (int i = 0; i < static_cast<int>(sizeof(int4)); ++i) {
      vp[i] = src[static_cast<int64_t>(i) * n];
    }
    // The panel offset of idx4 is exactly idx4 * 16 bytes:
    // ((nt*(k/64)+kt)*128 + nn)*64 + v*16.
    reinterpret_cast<int4*>(packed_weight + idx4 * 16)[0] = val;
  }
  const int64_t stride = static_cast<int64_t>(gridDim.x) * blockDim.x;
  for (int64_t idx = static_cast<int64_t>(blockIdx.x) * blockDim.x +
                     threadIdx.x;
       idx < n; idx += stride) {
    packed_weight_scale[idx] = weight_scale[idx];
  }
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
  // No split-K: the caller-provided workspace is intentionally unused, and the
  // timed operator performs no allocation, synchronization, packing, or
  // default-stream launch.
  (void)workspace;
  (void)workspace_bytes;
  auto* out_bf16 = static_cast<hip_bfloat16*>(out);

  // Native INT8 DUMMA m16n16k32 tiled path for M >= 128. Explicit dispatch by
  // launch geometry; every unmatched shape falls through to the scalar path.
  if (m >= kPrefillMinM) {
    if (m == kExactM && n == kExactN && k == kExactK) {
      // Round 2 operand-reuse arm + round 5 panel pack + round 6 coalesced
      // fused epilogue + round 15 register scales: cooperative A+B staging with
      // the panel-packed B operand consumed as col_major fragments, explicit
      // 8-byte load_frag8 reads and bank-safe 8-mod-16 LDS strides (A=88,
      // B=72), 64-K single-buffered stages, then an LDS-staged bf16 epilogue
      // that applies the per-thread register x_scale/weight_scale, converts and
      // writes 16-byte coalesced stores (no workspace, no separate
      // convert/combine pass, no LDS scale slab). 64x128 tile, 8 waves
      // (32x32 quadrant per wave), grid (6144/128, 4096/64) = (48, 64) = 3072
      // blocks, LDS A[64,88] + B[128,72] = 14,848 B/block (B reused by the
      // epilogue) -> 2 blocks/CU, K=256 = four 64-K stages. Weight layout: the
      // round-5 panel [N/128][K/64][128][64] (see launch_pack_w8a8_weight).
      const dim3 grid(n / kProjBlockN, m / kProjBlockM);
      const dim3 block(8 * kWaveSize);
      hipLaunchKernelGGL(
          HIP_KERNEL_NAME(w8a8_dumma_proj_operand_reuse_kernel<
                          kProjBlockM, kProjBlockN, kProjStageK>),
          grid, block, 0, stream,
          a, b, x_scale, weight_scale, out_bf16, m, n, k);
      return;
    }
    if (!(k == kExactK && n == kExactN)) {
      if (n % kDefaultBlockN == 0 && k % kDefaultStageK == 0) {
        // 64x128 tile, 8 waves (32x32 quadrant per wave): grid (48, 64) =
        // 3072 blocks for the assigned shape, 27,648 B LDS/block -> 2
        // blocks/CU, K=256 = two 128-K stages.
        const dim3 grid(n / kDefaultBlockN, (m + kDefaultBlockM - 1) /
                                                kDefaultBlockM);
        const dim3 block(8 * kWaveSize);
        hipLaunchKernelGGL(
            HIP_KERNEL_NAME(w8a8_dumma_prefill_tiled_kernel<
                            kDefaultBlockM, kDefaultBlockN, kDefaultStageK>),
            grid, block, 0, stream,
            a, b, x_scale, weight_scale, out_bf16, m, n, k);
        return;
      }
      if (n % 64 == 0 && k % 64 == 0) {
        // 64x64 tile, 4 waves: covers large-M shapes whose N is a multiple of
        // 64 but not of 128, grid (n/64, ceil(m/64)), 10,240 B LDS/block.
        const dim3 grid(n / 64, (m + 63) / 64);
        const dim3 block(4 * kWaveSize);
        hipLaunchKernelGGL(
            HIP_KERNEL_NAME(w8a8_dumma_prefill_tiled_kernel<64, 64, 64>),
            grid, block, 0, stream,
            a, b, x_scale, weight_scale, out_bf16, m, n, k);
        return;
      }
    }
    // The packed (k, n) == (256, 6144) buffer must never reach an
    // identity-layout tiled arm: any non-exact large-M shape with that pair
    // drops to the layout-decoding scalar fallback below.
  }

  // Generic scalar fallback for every unmatched (m, n, k), every M < 128, and
  // the paired M=2/M=16 API shapes with the same (N, K). It decodes the packed
  // panel [N/128][K/64][128][64] layout when (k, n) == (256, 6144).
  const int64_t total = static_cast<int64_t>(m) * n;
  const unsigned blocks = static_cast<unsigned>(
      (total + kScalarThreads - 1) / kScalarThreads);
  hipLaunchKernelGGL(
      w8a8_gemm_scalar_kernel,
      dim3(blocks), dim3(kScalarThreads), 0, stream,
      a, b, x_scale, weight_scale, out_bf16, m, n, k);
}

extern "C" void launch_pack_w8a8_weight(
    const int8_t* raw_weight,
    const float* weight_scale,
    int8_t* packed_weight,
    float* packed_weight_scale,
    int k,
    int n,
    hipStream_t stream) {
  // Round 5: the assigned down_proj weight (k, n) == (256, 6144) is packed
  // once into the panel layout [N/128][K/64][128][64] (n-major 64-k-byte rows
  // per panel) so each timed block-stage reads its 128x64 B tile as ONE
  // contiguous 8 KiB region while the staged LDS bytes stay identical to the
  // round-2 n-major [N, K] transpose. One-time, out-of-timed/out-of-Graph,
  // same byte count, same graph-stable buffer, byte-exact vs the raw logical
  // [K, N] weight.
  if (k == kExactK && n == kExactN) {
    const int64_t total4 = static_cast<int64_t>(n) * (k / 16);
    const unsigned blocks = static_cast<unsigned>(
        (total4 + kScalarThreads - 1) / kScalarThreads);
    hipLaunchKernelGGL(
        w8a8_pack_downproj_panel_kernel,
        dim3(blocks), dim3(kScalarThreads), 0, stream,
        raw_weight, weight_scale, packed_weight, packed_weight_scale, k, n);
    return;
  }
  // Identity device-to-device copy for every other (k, n) pair, including
  // unmatched (K, N). Runs outside the timed/CUDA-Graph region; same byte
  // count and same graph-stable destination buffers.
  const int64_t weight_elems = static_cast<int64_t>(k) * n;
  const int64_t total = weight_elems > n ? weight_elems : n;
  const unsigned blocks = static_cast<unsigned>(
      (total + kScalarThreads - 1) / kScalarThreads);
  hipLaunchKernelGGL(
      w8a8_pack_identity_kernel,
      dim3(blocks), dim3(kScalarThreads), 0, stream,
      raw_weight, weight_scale, packed_weight, packed_weight_scale,
      weight_elems, n);
}
// @@end
