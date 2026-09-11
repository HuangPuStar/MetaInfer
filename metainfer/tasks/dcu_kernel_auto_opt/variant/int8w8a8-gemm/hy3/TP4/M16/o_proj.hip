// @@variant shape=hy3_tp4_o_proj_m16 commit=71d1281fd4cc5068bc425a5f9a49d5b8d40e90ec added=2026-09-11
//   median_us=14.73 p90_us=14.79 speedup=3.707 baseline_us=54.62
//   source=test-9-11-1-b01955b3/iteration_001/hy3_tp4_o_proj_m16
// MetaInfer W8A8 INT8 GEMM - HIP implementation for K500SM_AI / gfx928.
//
// Assigned shape: hy3_tp4_o_proj_m16  (M=16, N=4096, K=2048).
//
// Round 1 (mandate: establish_arch - first correct DUMMA geometry).  The
// scalar bootstrap is replaced by a native gfx928 DUMMA INT8 m16n16k32
// architecture for the exact assigned shape:
//   * grid = N / (16 * 2) = 128 blocks, one block per pair of adjacent 16x16
//     N tiles (128 >= 120 device CUs), 128 threads = 2 x 64-lane wavefronts;
//   * in-block split-K=2: wave w owns 8 interleaved K=128 stages (K=1024,
//     stages w, w + 2, ...) of BOTH tiles as two independent int32 accumulator
//     fragments, so the A fragments loaded per K stage are shared across the
//     two tiles from registers; combined with the group-major packed-B layout
//     the block's aggregate walk is one 8 KiB window per iteration and the whole
//     128-block grid tiles those windows into a single dense advancing stream;
//   * B is pre-packed once (untimed, outside Graph capture) into a
//     tile-pair-interleaved [k_step_group][n_tile_pair][k_step_within][lane][16]
//     layout: one lane's 16 bytes hold tile0's 8 B fragment bytes followed by
//     tile1's 8 B fragment bytes for the same (k_step, lane), so a single
//     aligned 16-byte dwordx4 load covers both tiles and every B byte is read
//     exactly once.  Grouping the kStepsPerGroup = 8 k_steps one K-loop
//     iteration consumes outermost makes the 128 blocks' concurrent 8 KiB
//     packed-B windows tile ONE contiguous monotonic group region (1 MiB at
//     n = 4096) instead of 128 windows 64 KiB apart, so the whole grid presents
//     the DRAM/L2 queues a single dense advancing stream;
//   * register-only K=128-stage transport with depth-1 prefetch (4 A dwordx2
//     shared by both tiles + 4 B dwordx4 = 8 loads, 6 KiB in flight per wait);
//   * the only barrier is one END-of-K __syncthreads() before the fused
//     partial combine + scale -> bf16 epilogue; barriers per K step = 0.
//
// The timed operator (launch_w8a8_gemm) only launches kernels on the
// caller-provided stream and touches only caller-provided buffers: no
// allocation, no compilation, no packing, no host or device synchronization,
// no default-stream fallback.  In-block split-K needs no cross-block partials,
// so the caller workspace is deliberately untouched.
//
// Scalar fallback: one thread per output element for every shape other than
// the exact M=16 assignment, including the paired M=2 shape that shares the
// same (N, K); for (n, k) == (4096, 2048) it decodes the packed tile-pair
// layout elementwise, so the paired validation stays exact.
//
// pack_weight: for the exact (k, n) == (2048, 4096) o_proj weight it is the
// one-time permutation into the packed fragment-slot layout (byte count
// unchanged, 8 MiB); every other (K, N) keeps the generic identity
// device-to-device copy.  packed_weight_scale[n] = weight_scale[n] always.
//
// Host launch symbols (stable, C linkage, consumed by csrc/bindings.cpp):
//   launch_w8a8_gemm(...)
//   launch_pack_w8a8_weight(...)
//
// Include order is known-good for this DTK: hip_runtime.h first, then
// hip_bfloat16.h, then du_mma.h.

#include <hip/hip_runtime.h>
#include <hip/hip_bfloat16.h>
#include <du_mma.h>

#include <cstdint>

namespace {

constexpr int kScalarThreads = 256;

// Exact assigned shape (M=16, N=4096, K=2048).
constexpr int kTargetM = 16;
constexpr int kTargetN = 4096;
constexpr int kTargetK = 2048;

// ---------------------------------------------------------------------------
// DUMMA geometry for the exact assigned shape: gfx928 INT8 m16n16k32 tile.
// Each block owns TWO adjacent 16x16 N tiles (T=2) and 2 x 64-thread
// wavefronts; wave w accumulates the int32 dot over its 8-of-16 interleaved
// K=128 stages (K=1024) for BOTH tiles, so the A fragments of each K=128 stage
// are loaded once and reused across the two tiles from registers.
// ---------------------------------------------------------------------------
constexpr int kDummaBlockThreads = 64;    // one gfx928 wavefront
constexpr int kDummaWavesPerBlock = 2;    // in-block split-K=2
constexpr int kDummaTilesPerBlock = 2;    // multi-N-tile reuse (T=2)
constexpr int kDummaTileM = 16;
constexpr int kDummaTileN = 16;
constexpr int kDummaTileK = 32;

// Tile-pair-interleaved packed-B slot: one (k_step) slot holds BOTH tiles of a
// block in 16 B per lane - tile0's 8 fragment bytes (bytes 0..7) followed by
// tile1's 8 fragment bytes (bytes 8..15) - so one aligned 16-byte (dwordx4)
// load per lane covers one k_step of both tiles: 64 lanes * 16 B = 1 KiB
// contiguous per load.  k_steps are ordered GROUP-major: the kStepsPerGroup = 8
// k_steps one K-loop iteration of a block consumes are adjacent across pairs,
// and the per-pair slot stride inside a group is kStepsPerGroup *
// kPackedPairBytes (see kStepsPerGroup below).
constexpr int kPackedPairBytes = kDummaBlockThreads * 16;  // 1024

// Padded row stride (in int32 lanes) of one 16x16 int32 combine plane.
// du_store_matrix_sync stores the int8 m16n16k32 accumulator fragment with
// row = lane & 15 and col = (lane >> 4) + 4 * i (x[i] at +4i dwords), so with
// the natural stride 16 every lane lands on bank 16*(row & 1) + (col & 7):
// only 8 of the 32 LDS banks are touched and the store serializes (~28 extra
// bank-conflict cycles per store, 28,672 per operator replay - the only
// non-compulsory counter left in the current best).
// Stride 24 = 16 + 8 spreads the same 128 dwords exactly 4-per-bank (the
// hardware minimum) for the store, and keeps the epilogue's (row, row + 8)
// read pair 8 * 24 = 192 = 3 * 64 dwords apart, so the compiler can still emit
// one ds_read2st64 per pair and those reads also stay at the 4-phase minimum.
// Same int32 values, same row/col meaning, order-independent combine.
constexpr int kCombineStride = kDummaTileN + 8;  // 24

// K=128 stage: 4 DUMMA steps per stage, 8 loads per stage per wave (4 A
// dwordx2 shared by both tiles + 4 B dwordx4, one per k_step covering both
// tiles = 6 KB in flight), 8 v_mmac per stage per wave (4 steps x 2 tiles).
constexpr int kStageK = 128;                        // K elements per stage
constexpr int kStageSteps = kStageK / kDummaTileK;  // 4 DUMMA steps per stage

// Packed-B group: the kStepsPerGroup = 8 k_steps (2 waves x kStageSteps) that
// one K-loop iteration of a block consumes.  This is the outermost packed
// dimension, so at loop iteration s the whole grid reads one contiguous
// group_stride region: block b's 8 KiB window sits at pair-slot b inside it.
// Dense monotonic footprint instead of 128 windows 64 KiB apart.
constexpr int kStepsPerGroup =
    kDummaWavesPerBlock * (kStageK / kDummaTileK);  // 8

// ---------------------------------------------------------------------------
// Packed-B decode for the generic scalar fallback: returns logical
// weight[kk, n] from the group-major
// [k_step_group][n_tile_pair][k_step_within][lane][16] tile-pair-interleaved
// layout (see the pack kernel for the exact permutation).
// ---------------------------------------------------------------------------
__device__ __forceinline__ int8_t
packed_b_element(const int8_t* __restrict__ packed, int n, int kk) {
  const int n_tile = n >> 4;
  const int pair = n_tile >> 1;   // n_tile_pair (block id)
  const int sub = n_tile & 1;     // 0 -> bytes 0..7, 1 -> bytes 8..15
  const int nn = n & 15;
  const int k_step = kk >> 5;
  const int kk8 = kk & 31;
  const int lane = (kk8 >> 3) * 16 + nn;
  const int i = kk8 & 7;
  // Group-major packed layout [k_step_group][n_tile_pair][k_step_within][lane].
  const int n_pairs = kTargetN / (2 * kDummaTileN);
  const int group = k_step / kStepsPerGroup;
  const int within = k_step % kStepsPerGroup;
  return packed[static_cast<int64_t>(group) * n_pairs * kStepsPerGroup *
                    kPackedPairBytes +
                static_cast<int64_t>(pair) * kStepsPerGroup * kPackedPairBytes +
                static_cast<int64_t>(within) * kPackedPairBytes + lane * 16 +
                sub * 8 + i];
}

// One thread computes one output element out[row, col]:
//   acc = sum_k a[row,k] * b[k,col]          (exact int32, k ascending)
//   out = bf16(acc * x_scale[row] * weight_scale[col])
// Bounds-checked, so it is a valid generic fallback for every (m, n, k).  For
// the exact (n, k) == (4096, 2048) pair the weight tensor is the group-major
// [k_step_group][n_tile_pair][k_step_within][lane][16] layout, decoded
// elementwise.
__global__ __launch_bounds__(kScalarThreads) void w8a8_gemm_scalar_kernel(
    const int8_t* __restrict__ a,            // [m, k] row-major
    const int8_t* __restrict__ b,            // [k, n] (packed for 4096x2048)
    const float* __restrict__ x_scale,       // [m]
    const float* __restrict__ weight_scale,  // [n]
    hip_bfloat16* __restrict__ out,          // [m, n]
    int m,
    int n,
    int k) {
  const int row = static_cast<int>(blockIdx.y);
  const int col =
      static_cast<int>(blockIdx.x) * kScalarThreads +
      static_cast<int>(threadIdx.x);
  if (row >= m || col >= n) {
    return;
  }

  const int8_t* __restrict__ a_row = a + static_cast<int64_t>(row) * k;
  const bool packed_b = (n == kTargetN && k == kTargetK);

  int32_t acc = 0;
  for (int kk = 0; kk < k; ++kk) {
    const int8_t b_val = packed_b ? packed_b_element(b, col, kk)
                                  : b[static_cast<int64_t>(kk) * n + col];
    acc += static_cast<int32_t>(a_row[kk]) * static_cast<int32_t>(b_val);
  }

  const float scaled = static_cast<float>(acc) * x_scale[row] *
                       weight_scale[col];
  out[static_cast<int64_t>(row) * n + col] = __float2bfloat16(scaled);
}

// ---------------------------------------------------------------------------
// Stage prefetch helper (multi-N-tile reuse): issue the eight loads for one
// K=128 stage - the 4 A dwordx2 fragments (shared by both tiles) plus 4 B
// dwordx4 fragment-pair loads (one per k_step, each covering BOTH tiles) -
// into caller-provided u64 registers.
//   * A: four 8-byte loads of one activation row at ldm = k, 32 B apart (the
//     four DUMMA steps of the stage).  Lane ownership is loop-invariant
//     (du_mma.hpp matrix_a row_major loader: row = lane & 0xf,
//     col = (lane >> 4) << 3, x[i] = p[row*ldm + col + i], 8 consecutive
//     bytes).  A stays the logical row-major 32 KiB activation (L2-hot) and
//     feeds BOTH accumulator tiles.
//   * B (tile-pair-interleaved, group-major layout): per k_step one aligned
//     16-byte load from the [k_step_group][n_tile_pair][k_step_within][lane][16]
//     slot whose bytes 0..7 are tile0's fragment bytes and bytes 8..15 tile1's
//     fragment bytes for the same (k_step, lane) - byte-order identical to the
//     library matrix_b row_major loader (x[i] = p[(col + i) * ldm + row]) per
//     tile, so the two 8-byte halves feed b_frag0.x / b_frag1.x directly.
//   * The caller's k0_base K-slice offset plus the k0_stride stage stride make
//     each split wave walk its own packed k_step sequence; group_stride is the
//     byte size of one k_step_group across all n_tile_pairs.  The four k_steps
//     of one stage are consecutive inside their group, so all four 16-byte
//     loads are 16 B aligned (kPackedPairBytes apart) on a 16 B-aligned
//     packed buffer.
// ---------------------------------------------------------------------------
__device__ __forceinline__ void load_stage_fragments_t2(
    const int8_t* __restrict__ x_q,
    const int8_t* __restrict__ weight,
    int lane, int a_row, int a_col, int64_t b_base, int k,
    int64_t k0_base, int64_t k0_stride, int64_t group_stride, int s,
    uint64_t& a0, uint64_t& a1, uint64_t& a2, uint64_t& a3,
    uint64_t& b00, uint64_t& b01, uint64_t& b02, uint64_t& b03,
    uint64_t& b10, uint64_t& b11, uint64_t& b12, uint64_t& b13) {
  const int64_t k0 = k0_base + static_cast<int64_t>(s) * k0_stride;
  const int64_t a_off = static_cast<int64_t>(a_row) * k + k0 + a_col;
  a0 = *reinterpret_cast<const uint64_t*>(x_q + a_off);
  a1 = *reinterpret_cast<const uint64_t*>(x_q + a_off + kDummaTileK);
  a2 = *reinterpret_cast<const uint64_t*>(x_q + a_off + 2 * kDummaTileK);
  a3 = *reinterpret_cast<const uint64_t*>(x_q + a_off + 3 * kDummaTileK);
  // Group-major packed-B slot: k_step decides the group (outermost) and the
  // position inside it; b_base is this block's n_tile_pair offset in a group.
  const int64_t k_step = k0 / kDummaTileK;
  const int64_t pair_off = (k_step / kStepsPerGroup) * group_stride +
                           (k_step % kStepsPerGroup) * kPackedPairBytes +
                           static_cast<int64_t>(lane) * 16;
  const int64_t b_off = b_base + pair_off;
  // One 16-byte load per k_step covers both tiles: bytes 0..7 = tile0's
  // fragment, bytes 8..15 = tile1's fragment (little-endian word order).
  const uint4 bv0 = *reinterpret_cast<const uint4*>(weight + b_off);
  const uint4 bv1 =
      *reinterpret_cast<const uint4*>(weight + b_off + kPackedPairBytes);
  const uint4 bv2 =
      *reinterpret_cast<const uint4*>(weight + b_off + 2 * kPackedPairBytes);
  const uint4 bv3 =
      *reinterpret_cast<const uint4*>(weight + b_off + 3 * kPackedPairBytes);
  b00 = (static_cast<uint64_t>(bv0.y) << 32) | bv0.x;  // tile0, k_step 0
  b01 = (static_cast<uint64_t>(bv1.y) << 32) | bv1.x;  // tile0, k_step 1
  b02 = (static_cast<uint64_t>(bv2.y) << 32) | bv2.x;  // tile0, k_step 2
  b03 = (static_cast<uint64_t>(bv3.y) << 32) | bv3.x;  // tile0, k_step 3
  b10 = (static_cast<uint64_t>(bv0.w) << 32) | bv0.z;  // tile1, k_step 0
  b11 = (static_cast<uint64_t>(bv1.w) << 32) | bv1.z;  // tile1, k_step 1
  b12 = (static_cast<uint64_t>(bv2.w) << 32) | bv2.z;  // tile1, k_step 2
  b13 = (static_cast<uint64_t>(bv3.w) << 32) | bv3.z;  // tile1, k_step 3
}

// Float32 -> bf16 round-to-nearest-even WITHOUT the __float2bfloat16 NaN/Inf
// branch.  Every converted value here is finite (the int32 dot is bounded by
// 2048*127*127 << 2^31 and both scales are finite), so the guarded branch is
// pure tail cost sitting between the LDS reads and the stores.  This helper
// emits only the finite RNE path: r = u + 0x7fff + ((u >> 16) & 1), high 16
// bits kept - bit-identical to __float2bfloat16 for every finite input (same
// rounding, same carry into the exponent at the bf16 range edge); the only
// divergence is NaN payload bits, which cannot occur here.
__device__ __forceinline__ hip_bfloat16 bf16_rne_finite(float f) {
  uint32_t u;
  __builtin_memcpy(&u, &f, sizeof(u));
  u += 0x7fffu + ((u >> 16) & 1u);
  const uint16_t h = static_cast<uint16_t>(u >> 16);
  hip_bfloat16 b;
  __builtin_memcpy(&b, &h, sizeof(h));
  return b;
}

// ---------------------------------------------------------------------------
// Exact assigned shape (M=16, N=4096, K=2048): gfx928 DUMMA INT8 m16n16k32
// tile, weight pre-packed into tile-pair-interleaved B fragment slots,
// MULTI-N-TILE REUSE.
//   * Geometry: 128 blocks (grid = N/(16*2), one block per pair of adjacent
//     16x16 N tiles; 128 >= 120 device CUs) x 128 threads = 2 x 64-lane
//     wavefronts.
//   * In-block split-K=2: wave w owns 8 x K=128 stages (K=1024) and
//     accumulates BOTH tiles over that slice - two independent accumulator
//     fragments per wave.  The two waves' stage ownership is INTERLEAVED
//     (wave w owns stages w, w + 2, ...) and the packed-B layout is
//     group-major, so at each K-loop iteration the two waves cover one
//     contiguous 8 KiB window and the 128 blocks' windows tile one dense
//     group region that advances monotonically (a single dense DRAM stream).
//     Per K=128 stage per wave: 4 A dwordx2 + 4 B dwordx4 (one 16-byte load per
//     k_step covering both tiles) = 8 loads (6 KB in flight) covering an
//     8-v_mmac burst (4 steps x 2 tiles).  Every B byte is read exactly once; A
//     is read once per block.
//   * REGISTER-ONLY K-loop transport with depth-1 prefetch: the current
//     stage's fragments live in registers, the NEXT stage's 8 loads are issued
//     BEFORE the current 8-MMAC burst, and the compiler-inserted vmcnt wait
//     lands at the next iteration's first fragment fill (global_load ->
//     v_mmac burst -> wait, no LDS hop, no lgkmcnt wait in the K loop).
//   * LDS holds only the four int32 partial planes (2 waves x 2 tiles, each
//     16 x kCombineStride = 16 x 24 int32, 6 KiB/block, padded so the fragment
//     store and the epilogue read are bank-conflict-free); the ONLY barrier is
//     the single END-of-K __syncthreads() before the fused partial combine +
//     scale -> bf16 epilogue (all 128 threads, 4 elements each).  Barriers per
//     K step = 0.
//   * Correctness: per element the int32 accumulation is ascending over each
//     wave's own stage sequence (the two waves own interleaved K=128 stages),
//     then the two waves' partials are summed in LDS
//     (order-independent int32, no overflow: max |dot| = 2048*127*127 <<
//     2^31).  The packed layout is coherent across the pack kernel, the DUMMA
//     loads and the scalar fallback decode (same (tile, k_step, lane, byte)
//     -> logical (k, n) mapping), so the paired M=2 validation stays exact.
//   * Graph-safe: static smem only, no allocation/sync/default-stream launch,
//     pure dispatch on the caller-provided stream.  Workspace untouched.
// ---------------------------------------------------------------------------
__global__ __launch_bounds__(kDummaWavesPerBlock * kDummaBlockThreads) void
w8a8_gemm_m16_dumma_packedb_multint_kernel(
    const int8_t* __restrict__ x_q,
    const int8_t* __restrict__ weight,  // packed group-major B fragment slots
    const float* __restrict__ x_scale,
    const float* __restrict__ weight_scale,
    hip_bfloat16* __restrict__ out,
    int n,
    int k) {
  const int tid = static_cast<int>(threadIdx.x);
  const int wave = tid / kDummaBlockThreads;  // K-slice owner, 0..1
  const int lane = tid % kDummaBlockThreads;  // wavefront lane 0..63
  // Block b owns the two adjacent N tiles 2b and 2b+1.
  const int n_tile0 = static_cast<int>(blockIdx.x) * kDummaTilesPerBlock;
  const int n0 = n_tile0 * kDummaTileN;

  du::dumma::DUFragment<du::dumma::matrix_a, kDummaTileM, kDummaTileN,
                        kDummaTileK, signed char, du::dumma::row_major>
      a_frag;
  du::dumma::DUFragment<du::dumma::matrix_b, kDummaTileM, kDummaTileN,
                        kDummaTileK, signed char, du::dumma::row_major>
      b_frag0;
  du::dumma::DUFragment<du::dumma::matrix_b, kDummaTileM, kDummaTileN,
                        kDummaTileK, signed char, du::dumma::row_major>
      b_frag1;
  du::dumma::DUFragment<du::dumma::accumulator, kDummaTileM, kDummaTileN,
                        kDummaTileK, int> acc0;
  du::dumma::DUFragment<du::dumma::accumulator, kDummaTileM, kDummaTileN,
                        kDummaTileK, int> acc1;
  du::dumma::du_fill_fragment(acc0, 0);
  du::dumma::du_fill_fragment(acc1, 0);

  // Group-major packed-B layout: one k_step_group (the kStepsPerGroup = 8
  // k_steps a K-loop iteration consumes) holds ALL n_tile_pairs, one
  // kStepsPerGroup * kPackedPairBytes slot each, so the 128 blocks' concurrent
  // 8 KiB windows tile one contiguous group_stride region (1 MiB at n = 4096)
  // and consecutive loop iterations advance that dense region monotonically.
  // b_base is this block's pair slot inside every group.
  const int64_t n_pairs = static_cast<int64_t>(n) / (2 * kDummaTileN);
  const int64_t group_stride =
      n_pairs * kStepsPerGroup * kPackedPairBytes;
  const int64_t b_base =
      static_cast<int64_t>(blockIdx.x) * kStepsPerGroup * kPackedPairBytes;

  // Per-lane A fragment ownership is loop-invariant: row = lane & 0xf,
  // col = (lane >> 4) << 3.
  const int a_row = lane & 15;
  const int a_col = (lane >> 4) << 3;

  // Prefetch the four per-thread scale values BEFORE the stage-0 fragment
  // loads so the fused epilogue has zero exposed global latency on the block's
  // finishing tail: the four vmem reads (x_scale[row], x_scale[row2],
  // weight_scale[n0+col], weight_scale[n0+16+col] - each used twice) move into
  // the cold-start window, where their L2 round trip overlaps the first
  // B-load DRAM latency.  Same 4 loads, same values, bit-identical math.
  const int row = tid >> 4;            // epilogue rows 0..7 (and row2 = +8)
  const int col = tid & 15;            // epilogue column within the tile
  const int row2 = row + (kDummaTileM >> 1);
  const float x_scale_lo = x_scale[row];
  const float x_scale_hi = x_scale[row2];
  const float ws_lo = weight_scale[n0 + col];
  const float ws_hi = weight_scale[n0 + kDummaTileN + col];

  // Four bank-conflict-free int32 partial planes: [wave][tile][16 rows x
  // kCombineStride] (16 x 24 int32 = 1.5 KiB per plane, 6 KiB static LDS per
  // block).  The padded row stride is the only change versus the natural
  // 16-column layout: the same fragment values are stored and the same 2-wave
  // order-independent int32 sums are read back, so the result is bit-identical.
  __shared__ __align__(16) int32_t
      acc_planes[kDummaWavesPerBlock * kDummaTilesPerBlock * kDummaTileM *
                 kCombineStride];

  // 16 stages of K=128 partitioned UNIFORMLY across the 2 waves (8 stages of
  // K=1024 per wave); ascending-K order per wave and the byte-exact fragment
  // loads are unchanged, and the end-of-K int32 combine is order-independent.
  //
  // Stage ownership is INTERLEAVED: wave w owns stages w, w + 2, ..., so the
  // two waves of a block walk ADJACENT K=128 stages (4 KiB apart) in lockstep
  // instead of two 32 KiB-apart streams.  Combined with the group-major packed
  // layout, at loop iteration s the block reads its 8 KiB window
  // [s * group_stride, (s+1) * group_stride) at pair-slot offset, and because
  // blockIdx.x tiles those slots the WHOLE GRID reads one contiguous dense
  // group_stride region per iteration that advances monotonically - a single
  // dense DRAM/L2 stream instead of 128 windows 64 KiB apart.  Every wave still
  // covers exactly 8 stages = K=1024 and the per-wave k order is still
  // ascending; the bytes, the addresses (as a permutation) and the LDS combine
  // are unchanged, and the int32 sums are order-independent.
  const int total_stages = k / kStageK;  // 16
  const int n_stages = total_stages / kDummaWavesPerBlock;  // 8 stages of K=128
  const int64_t k0_base = static_cast<int64_t>(wave) * kStageK;
  const int64_t k0_stage_stride =
      static_cast<int64_t>(kDummaWavesPerBlock) * kStageK;

  // Prologue: the wave's first stage fragments land directly in registers (one
  // cold-start DRAM latency per wave, amortized over 8 stages and staggered
  // across the 2 waves).
  uint64_t ca0, ca1, ca2, ca3;                    // current stage's A
  uint64_t cb00, cb01, cb02, cb03;                // current stage's B, tile 0
  uint64_t cb10, cb11, cb12, cb13;                // current stage's B, tile 1
  load_stage_fragments_t2(x_q, weight, lane, a_row, a_col, b_base, k, k0_base,
                          k0_stage_stride, group_stride, 0, ca0, ca1, ca2, ca3,
                          cb00, cb01, cb02, cb03, cb10, cb11, cb12, cb13);

  for (int s = 0; s < n_stages; ++s) {
    // Issue the NEXT stage's eight global loads (4 A dwordx2 + 4 B dwordx4)
    // BEFORE this stage's MMAC burst so DRAM/L2 latency overlaps the burst;
    // the compiler-inserted s_waitcnt vmcnt(0) for these loads lands at the
    // next iteration's first read of the prefetched registers (the fragment
    // fill below) - 6 KB of in-flight bytes per wait, no LDS hop.
    uint64_t na0, na1, na2, na3;
    uint64_t nb00, nb01, nb02, nb03, nb10, nb11, nb12, nb13;
    if (s + 1 < n_stages) {
      load_stage_fragments_t2(x_q, weight, lane, a_row, a_col, b_base, k,
                              k0_base, k0_stage_stride, group_stride, s + 1,
                              na0, na1, na2, na3, nb00, nb01, nb02, nb03, nb10,
                              nb11, nb12, nb13);
    }
    // Stage-s MMAC burst straight from registers, in the exact a_frag.x /
    // b_frag.x byte order du_mma_sync consumes: the same A fragment feeds
    // both tiles (multi-N-tile reuse - A loaded once per stage).
#pragma unroll
    for (int t = 0; t < kStageSteps; ++t) {
      const uint64_t av =
          (t == 0) ? ca0 : (t == 1) ? ca1 : (t == 2) ? ca2 : ca3;
      const uint64_t b0v =
          (t == 0) ? cb00 : (t == 1) ? cb01 : (t == 2) ? cb02 : cb03;
      const uint64_t b1v =
          (t == 0) ? cb10 : (t == 1) ? cb11 : (t == 2) ? cb12 : cb13;
      __builtin_memcpy(a_frag.x, &av, 8);
      __builtin_memcpy(b_frag0.x, &b0v, 8);
      __builtin_memcpy(b_frag1.x, &b1v, 8);
      du::dumma::du_mma_sync(acc0, a_frag, b_frag0, acc0);
      du::dumma::du_mma_sync(acc1, a_frag, b_frag1, acc1);
    }
    // Rotate: the prefetched stage s+1 becomes the current stage.  No LDS WOR
    // hazard; the vmcnt wait for the prefetch is satisfied before the next
    // iteration's first use.
    if (s + 1 < n_stages) {
      ca0 = na0;
      ca1 = na1;
      ca2 = na2;
      ca3 = na3;
      cb00 = nb00;
      cb01 = nb01;
      cb02 = nb02;
      cb03 = nb03;
      cb10 = nb10;
      cb11 = nb11;
      cb12 = nb12;
      cb13 = nb13;
    }
  }

  // Combine the two wavefronts' int32 partials in LDS (exact int32 sums,
  // order independent) after a single barrier at the END of K - barrier count
  // per K step stays 0.  Each wave stores its two tiles' planes with the
  // padded kCombineStride leading dimension, which spreads the fragment lanes
  // over all 32 banks instead of 8.
  du::dumma::du_store_matrix_sync(
      acc_planes + (wave * kDummaTilesPerBlock) * kDummaTileM * kCombineStride,
      acc0, kCombineStride, du::dumma::mem_row_major);
  du::dumma::du_store_matrix_sync(
      acc_planes + (wave * kDummaTilesPerBlock + 1) * kDummaTileM *
                       kCombineStride,
      acc1, kCombineStride, du::dumma::mem_row_major);
  __syncthreads();

  // Cooperative epilogue over the two 16x16 tiles: all 128 threads, 4 elements
  // each - for tile t: (row = tid >> 4, col = tid & 15) for rows 0..7 and
  // (row + 8, col) for rows 8..15; sum the 2 planes per element (int32 add is
  // order-independent), then fused dot * x_scale[row] * weight_scale[col] ->
  // bf16 store.  The four scale values were prefetched at the kernel top, and
  // bf16_rne_finite replaces the branchy __float2bfloat16 conversion.
  int32_t t0_lo = 0, t0_hi = 0, t1_lo = 0, t1_hi = 0;
#pragma unroll
  for (int w = 0; w < kDummaWavesPerBlock; ++w) {
    const int plane_base =
        w * kDummaTilesPerBlock * kDummaTileM * kCombineStride;
    // Element (row, col) lives at row * kCombineStride + col; the second
    // element of each thread is (row + 8, col), exactly 8 * kCombineStride =
    // 192 dwords away (an integral ds_read2st64 offset), and tile 1's plane is
    // one full 16 x kCombineStride plane further on.
    const int lo = plane_base + row * kCombineStride + col;
    const int hi = lo + (kDummaTileM / 2) * kCombineStride;
    const int tile1 = kDummaTileM * kCombineStride;
    t0_lo += acc_planes[lo];
    t0_hi += acc_planes[hi];
    t1_lo += acc_planes[lo + tile1];
    t1_hi += acc_planes[hi + tile1];
  }
  const float s0_lo = static_cast<float>(t0_lo) * x_scale_lo * ws_lo;
  out[static_cast<int64_t>(row) * n + n0 + col] = bf16_rne_finite(s0_lo);
  const float s0_hi = static_cast<float>(t0_hi) * x_scale_hi * ws_lo;
  out[static_cast<int64_t>(row2) * n + n0 + col] = bf16_rne_finite(s0_hi);
  const float s1_lo = static_cast<float>(t1_lo) * x_scale_lo * ws_hi;
  out[static_cast<int64_t>(row) * n + n0 + kDummaTileN + col] =
      bf16_rne_finite(s1_lo);
  const float s1_hi = static_cast<float>(t1_hi) * x_scale_hi * ws_hi;
  out[static_cast<int64_t>(row2) * n + n0 + kDummaTileN + col] =
      bf16_rne_finite(s1_hi);
}

// Generic grid-stride device-to-device copy (int8) - identity pack for every
// (K, N) except the exact (2048, 4096) o_proj shape.
__global__ void w8a8_copy_i8_kernel(const int8_t* __restrict__ src,
                                    int8_t* __restrict__ dst,
                                    int64_t count) {
  const int64_t stride = static_cast<int64_t>(gridDim.x) * blockDim.x;
  for (int64_t i = static_cast<int64_t>(blockIdx.x) * blockDim.x +
                   static_cast<int64_t>(threadIdx.x);
       i < count; i += stride) {
    dst[i] = src[i];
  }
}

// Generic grid-stride device-to-device copy (float).
__global__ void w8a8_copy_f32_kernel(const float* __restrict__ src,
                                     float* __restrict__ dst,
                                     int64_t count) {
  const int64_t stride = static_cast<int64_t>(gridDim.x) * blockDim.x;
  for (int64_t i = static_cast<int64_t>(blockIdx.x) * blockDim.x +
                   static_cast<int64_t>(threadIdx.x);
       i < count; i += stride) {
    dst[i] = src[i];
  }
}

constexpr int kMaxCopyBlocks = 65535;

// ---------------------------------------------------------------------------
// One-time pack for the exact (k, n) == (2048, 4096) o_proj weight: permute
// the logical [K, N] int8 layout into the group-major
// packed[k_step_group][n_tile_pair][k_step_within][lane][16] B fragment slots -
// tile-pair-interleaved: for the same (k_step, lane), bytes 0..7 are the 8
// fragment bytes of tile (2*pair) and bytes 8..15 the 8 fragment bytes of tile
// (2*pair+1) (du_mma.hpp matrix_b row_major lane mapping: row = lane & 0xf,
// col = (lane >> 4) << 3, x[i] = p[(col + i) * ldm + row]).  k_step_group is
// k_step / kStepsPerGroup (the 8 k_steps one K-loop iteration consumes), so all
// n_tile_pairs of a group are adjacent: the grid's concurrent 8 KiB windows
// tile one dense monotonic group region.  One thread per (pair, k_step, lane):
// 64 k_steps x 128 pairs x 64 lanes = 524,288 threads, each writing one aligned
// 16-byte slot.  Runs once per weight, outside the timed GEMM and outside Graph
// capture; byte count is unchanged (8 MiB), so the packed tensor is a same-size
// permutation.
// ---------------------------------------------------------------------------
__global__ __launch_bounds__(kScalarThreads) void w8a8_pack_o_proj_m16_kernel(
    const int8_t* __restrict__ raw,
    int8_t* __restrict__ packed,
    int k,
    int n) {
  const int64_t idx =
      static_cast<int64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
  const int64_t total = (static_cast<int64_t>(k) / kDummaTileK) *
                        (n / (2 * kDummaTileN)) * kDummaBlockThreads;
  if (idx >= total) {
    return;
  }
  const int pair = static_cast<int>(idx >> 12);  // idx / (64 * 64)
  const int rem = static_cast<int>(idx & 4095);  // idx % (64 * 64)
  const int k_step = rem >> 6;                   // idx / 64 % 64
  const int lane = rem & 63;                     // idx % 64
  const int row = lane & 15;
  const int col = (lane >> 4) << 3;
  const int8_t* src0 =
      raw + (static_cast<int64_t>(k_step) * kDummaTileK + col) * n +
      (pair * 2) * kDummaTileN + row;
  const int8_t* src1 = src0 + kDummaTileN;  // tile (2*pair + 1)
  uint64_t v0 = 0;                          // tile 2*pair   (bytes 0..7)
  uint64_t v1 = 0;                          // tile 2*pair+1 (bytes 8..15)
#pragma unroll
  for (int i = 0; i < 8; ++i) {
    v0 |= (static_cast<uint64_t>(static_cast<uint8_t>(
               src0[static_cast<int64_t>(i) * n])))
          << (8 * i);
    v1 |= (static_cast<uint64_t>(static_cast<uint8_t>(
               src1[static_cast<int64_t>(i) * n])))
          << (8 * i);
  }
  uint4 slot;
  slot.x = static_cast<uint32_t>(v0 & 0xffffffffu);
  slot.y = static_cast<uint32_t>(v0 >> 32);
  slot.z = static_cast<uint32_t>(v1 & 0xffffffffu);
  slot.w = static_cast<uint32_t>(v1 >> 32);
  // Group-major destination: [k_step_group][n_tile_pair][k_step_within][lane].
  const int64_t n_pairs = static_cast<int64_t>(n) / (2 * kDummaTileN);
  const int group = k_step / kStepsPerGroup;
  const int within = k_step % kStepsPerGroup;
  *reinterpret_cast<uint4*>(
      packed + static_cast<int64_t>(group) * n_pairs * kStepsPerGroup *
                   kPackedPairBytes +
      static_cast<int64_t>(pair) * kStepsPerGroup * kPackedPairBytes +
      static_cast<int64_t>(within) * kPackedPairBytes + lane * 16) = slot;
}

}  // namespace

// Stable host launch symbol used by the trusted binding for
// torch.ops.zth_w8a8.gemm_out.  Runs entirely on the caller-provided stream:
// no allocation, no synchronization, no default-stream launch, no workspace
// writes.  Returns nothing; the binding returns the caller-provided out.
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
  (void)workspace;  // in-block split-K: no cross-block partials, no workspace
  (void)workspace_bytes;

  hip_bfloat16* out_bf16 = reinterpret_cast<hip_bfloat16*>(out);

  if (m == kTargetM && n == kTargetN && k == kTargetK) {
    // Exact assigned shape hy3_tp4_o_proj_m16: packed-B two-wave in-block
    // split-K=2 DUMMA m16n16k32 kernel with multi-N-tile reuse (128 blocks,
    // two adjacent 16x16 N tiles per block, 2 x 64-thread wavefronts, K=128
    // stages, depth-1 register prefetch).  The scalar fallback below stays
    // untouched and still covers every unmatched shape, including the paired
    // M=2 shape with the same (N, K).
    const dim3 grid(static_cast<unsigned>(
        kTargetN / (kDummaTileN * kDummaTilesPerBlock)));
    const dim3 block(kDummaBlockThreads * kDummaWavesPerBlock);
    hipLaunchKernelGGL(w8a8_gemm_m16_dumma_packedb_multint_kernel, grid,
                       block, 0, stream, a, b, x_scale, weight_scale,
                       out_bf16, n, k);
    return;
  }

  // Generic scalar fallback for every unmatched (m, n, k).  This also covers
  // the paired M=2 API shape that shares the same (N, K): it must never be
  // routed through an M=16-only specialization.
  const dim3 grid(
      static_cast<unsigned>((n + kScalarThreads - 1) / kScalarThreads),
      static_cast<unsigned>(m));
  const dim3 block(kScalarThreads);
  hipLaunchKernelGGL(w8a8_gemm_scalar_kernel, grid, block, 0, stream, a, b,
                     x_scale, weight_scale, out_bf16, m, n, k);
}

// Stable host launch symbol used by the optional out-of-timed-region
// torch.ops.zth_w8a8.pack_weight.  For the exact (k, n) == (2048, 4096)
// o_proj weight this permutes into the packed-B fragment-slot layout
// (one-time, untimed, outside Graph capture); every other (K, N) keeps the
// generic identity device-to-device copy.  Weight scales are always copied
// through.
extern "C" void launch_pack_w8a8_weight(
    const int8_t* raw_weight,
    const float* weight_scale,
    int8_t* packed_weight,
    float* packed_weight_scale,
    int k,
    int n,
    hipStream_t stream) {
  if (k == kTargetK && n == kTargetN) {
    // Exact o_proj M=16 weight: permute into the group-major
    // [k_step_group][n_tile_pair][k_step_within][lane][16] B fragment slots
    // (one-time, untimed, outside Graph capture).
    const int64_t total = (static_cast<int64_t>(k) / kDummaTileK) *
                          (n / (2 * kDummaTileN)) * kDummaBlockThreads;
    const dim3 grid(
        static_cast<unsigned>((total + kScalarThreads - 1) / kScalarThreads));
    const dim3 block(kScalarThreads);
    hipLaunchKernelGGL(w8a8_pack_o_proj_m16_kernel, grid, block, 0, stream,
                       raw_weight, packed_weight, k, n);
  } else {
    const int64_t weight_count = static_cast<int64_t>(k) * n;
    const int64_t weight_blocks =
        (weight_count + kScalarThreads - 1) / kScalarThreads;
    const unsigned weight_grid =
        static_cast<unsigned>(weight_blocks > kMaxCopyBlocks
                                  ? kMaxCopyBlocks
                                  : weight_blocks);
    hipLaunchKernelGGL(w8a8_copy_i8_kernel, dim3(weight_grid),
                       dim3(kScalarThreads), 0, stream, raw_weight,
                       packed_weight, weight_count);
  }

  const int64_t scale_count = static_cast<int64_t>(n);
  const int64_t scale_blocks =
      (scale_count + kScalarThreads - 1) / kScalarThreads;
  const unsigned scale_grid =
      static_cast<unsigned>(scale_blocks > kMaxCopyBlocks ? kMaxCopyBlocks
                                                          : scale_blocks);
  hipLaunchKernelGGL(w8a8_copy_f32_kernel, dim3(scale_grid),
                     dim3(kScalarThreads), 0, stream, weight_scale,
                     packed_weight_scale, scale_count);
}
// @@end
