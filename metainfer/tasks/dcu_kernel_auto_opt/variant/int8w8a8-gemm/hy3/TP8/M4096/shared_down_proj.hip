// @@variant shape=hy3_tp8_shared_down_proj_m4096 commit=303c7ee331a658a2b081df0b08f962d51259464c added=2026-09-06
//   median_us=89.46 p90_us=89.63 speedup=120.3 baseline_us=1.076e+04
//   source=hy3-tp8-dsh-m16-and-m4096-2-f7fa9503
// MetaInfer W8A8 INT8 GEMM backend for Hygon K500SM_AI / gfx928 (worker_3).
//
// Assigned shapes (physical GPU 3):
//   hy3_tp8_shared_down_proj_m16     M=16,   N=4096, K=192
//   hy3_tp8_shared_down_proj_m4096   M=4096, N=4096, K=192
//
// Logical operator (see int8_w8a8_gemm_api.py):
//   out[m, n] = bf16( int32_dot(x_q[m, :], weight[:, n])
//                     * x_scale[m, 0] * weight_scale[n, 0] )
//
// Pack layout: identity for every weight except the assigned TP8 down-proj
// weight ((k, n) == (192, 4096)), which is packed n-major
// packed[n*k + kk] == raw[kk*n + n_local] (each logical [K, N] column
// becomes a contiguous 192-byte run; same byte count, same buffer).
// launch_pack_w8a8_weight performs the transpose once, out of the timed
// region and Graph capture.  Every consumer of the (k, n) == (192, 4096)
// packed buffer (the M=16 kernel below, the M >= 128 tiled DUMMA path, and
// the scalar fallback including the paired M=2 shape) decodes the matching
// n-major layout; all other (k, n) keep the identity pack.
//
// Strategy:
//   * exact assigned shape (M=16, N=4096, K=192) -> native INT8 DUMMA
//     m16n16k32 kernel with a bounded whole-window LDS prefetch: one
//     64-lane wavefront per block, one 16x16 output tile per block, the wave
//     prefetches the full K=192 A/B operand window into LDS once with six
//     16-byte cooperative vector loads issued back to back before any LDS
//     store (one __syncthreads; the prologue then pays one in-flight memory
//     round trip per block instead of six serialized load->wait->write
//     chains), then the 6 m16n16k32 steps consume
//     A fragments row_major from a_tile and B fragments col_major from the
//     packed n-major stage b_tile via du_load_matrix_sync (no vmem inside
//     the K loop; every per-lane fragment byte run is one contiguous 8-byte
//     LDS read), explicit int32 accumulation, direct fragment ->
//     ((acc * x_scale) * weight_scale) -> bf16 epilogue, no barriers inside
//     the K loop.
//   * down-proj family (M >= 128, K == 192, N % kActiveBlockN == 0) -> the
//     2-D macro-tile DUMMA throughput kernel: a templated staged pipeline
//     over a (kBlockM x kBlockN) output tile with the three macro-tiles of
//     the family (64x64, 64x128, 128x64) compiled and a compile-time active
//     selection (kActiveTileIndex, see below); the tile-1 64x128 path also
//     carries a compile-time pipeline selector (kActivePipeline) between the
//     double-buffered form (w8a8_dumma_prefill_kernel) and the round-3
//     single-buffered control (w8a8_dumma_prefill_sb_kernel), both staying
//     compiled.  K = 192
//     is pipelined in kPrefillStageK = 64 chunks (3 stages): the global
//     int4 loads of stage s+1 issue before the MMAC sequence of stage s and
//     land in the alternate LDS buffer right after it (one barrier per
//     stage), so the vmcnt(0) wait and the ds_write overlap compute.  The
//     packed n-major weight ((k,n)==(192,4096), P[n*K+kk]) is staged
//     n-major into LDS (b_tile[n][k], padded 72-byte rows) and consumed
//     through col_major matrix_b fragments; A is staged row-major with
//     padded 88-byte rows and consumed row_major.  Both operand fragment
//     paths use explicit 8-byte LDS reads (load_frag8 -> ds_read_b64, the
//     4-phase conflict-free floor at these even dword strides) instead of
//     the library ds_read2_b32 lowering (2-way conflict in every phase at
//     ANY even dword row stride).  int32 accumulation stays resident over
//     the whole K loop in four 16x16 accumulator fragments per wave and the
//     epilogue is a direct fragment -> ((acc * x_scale) * weight_scale) ->
//     bf16 store.  No split-K, no raw asm, no speculative pipeline.
//   * Every other shape (including the paired M=2 API shapes with the same
//     (N, K)) -> generic scalar int8/int32 fallback.  The M=16 kernel keeps
//     an exact (m, n, k) == (16, 4096, 192) guard so paired M=2 API shapes
//     and unmatched shapes still reach the scalar fallback.
//
// Headers are included in the mandated order for this DTK: HIP runtime first
// (du_mma.h is not self-contained), then hip_bfloat16.h, then du_mma.h.

#include <hip/hip_runtime.h>
#include <hip/hip_bfloat16.h>
#include <du_mma.h>

#include <cstdint>

namespace {

constexpr int kInt8TileM = 16;  // DUMMA m16n16k32 (int8 -> int32) tiles
constexpr int kInt8TileN = 16;
constexpr int kInt8TileK = 32;

constexpr int kWaveSize = 64;  // gfx928 native wavefront size

// Large-M tiled kernel geometry (K=192 = 3 x kPrefillStageK stages).
//
// Compile-time selection of the active 2-D macro-tile of the prefill
// family:
//   0 -> 64x64, 1 -> 64x128, 2 -> 128x64.
// All three instantiations of the templated kernel are compiled so the
// family stays measurable; only the active one is launched inside the timed
// region.  The active tile is 64x128: with the (kBlockM x kBlockN) tile,
// 8 wavefronts (512 threads) and the double-buffered stage-64 pipeline the
// per-block LDS footprints are
//   64x64   : 2*(64*88 + 64*72)  = 20,480 B  (256 threads / 4 waves)
//   64x128  : 2*(64*88 + 128*72) = 29,696 B  (512 threads / 8 waves)
//   128x64  : 2*(128*88 + 64*72) = 31,744 B  (512 threads / 8 waves)
// and 2 blocks/CU stay LDS-resident for all three (40,960 / 59,392 / 63,488
// B per CU <= 64 KiB), i.e. 16 resident wavefronts per CU for the 512-thread
// tiles.  For the assigned M=4096 x N=4096 grid the 64x128 tile yields
// grid (32, 64) = 2048 blocks and re-reads each A 64-row tile across 32
// N-blocks and each B 128-column tile across 64 M-blocks (both operand
// streams stay L2-resident).
constexpr int kPrefillStageK = 64;  // K depth staged per barrier pair
constexpr int kAssignedK = 192;     // the only K the optimized guard allows
constexpr int kActiveTileIndex = 1; // 0 -> 64x64, 1 -> 64x128, 2 -> 128x64
constexpr int kActiveBlockM = kActiveTileIndex == 2 ? 128 : 64;
constexpr int kActiveBlockN = kActiveTileIndex == 1 ? 128 : 64;

// Pipeline form of the tile-1 (64x128) prefill path, compared in round 3:
//   0 -> single-buffered control (w8a8_dumma_prefill_sb_kernel, ACTIVE this
//        round): LDS 14,848 B/block, prologue + 2 barriers/stage boundary =
//        5 barriers/block for K=192, one-stage-ahead VGPR prefetch kept,
//        occupancy unchanged at 2 blocks/CU (VGPR-bound);
//   1 -> accepted double-buffered pipeline (w8a8_dumma_prefill_kernel,
//        retained and still compiled): LDS 29,696 B/block, one barrier per
//        stage (4/block incl. its dead last-stage barrier).
// Tiles 0 and 2 always use the double-buffered form (compile-time retention
// instantiations; only tile 1 is launched for the assigned M=4096 grid).
constexpr int kActivePipeline = 0;

// LDS row padding of the staged A tile (row-major, one row per output row).
// 24 keeps every row start 8-byte aligned for the two-half int64 staging
// while making the 16 m16k32-fragment row bases pairwise distinct mod the
// 32 LDS banks: row stride kAStride = 88 B = 22 dwords, and {22*r mod 32}
// for r = 0..15 is a permutation of the 16 even bank-pairs, so an 8-byte
// ds_read_b64 fragment read runs at the conflict-free 4-phase floor.
// Stride 20 dwords (pad 16) aliases rows r and r+8 onto identical bank
// pairs at any even dword stride, which is exactly why the ds_read2_b32
// lowering doubles every phase.
constexpr int kLdsPadA = 24;
constexpr int kAStride = kPrefillStageK + kLdsPadA;  // 88, % 8 == 0

// LDS row padding of the transposed (n-major) B tile: one row per output
// column, kPrefillStageK contiguous K bytes + 8 B pad -> stride 72
// (% 8 == 0 for the col_major 8-byte fragment reads and the two-half
// ds_write_b64 B staging; % 16 == 8, so the staging store is the explicit
// two-int64 form, never a 16-byte-misaligned int4 store).  {18*r mod 32}
// for r = 0..15 is likewise a permutation of the 16 even bank-pairs.
constexpr int kLdsPadB = 8;
constexpr int kBTStride = kPrefillStageK + kLdsPadB;  // 72, % 8 == 0

constexpr int kScalarThreads = 256;  // scalar fallback threads per block
constexpr int kPackThreads = 256;    // pack copy threads per block

using namespace du::dumma;

// float32 -> bfloat16 with round-to-nearest-even, stored as raw uint16 bits.
// The output tensor is at::kBFloat16 (2 bytes/element); this conversion is
// bit-identical to the hardware RNE cvt used by the reference path for all
// finite inputs and keeps the store independent of bf16 header type details.
__device__ __forceinline__ uint16_t bf16_bits_from_f32(float f) {
  uint32_t bits;
  __builtin_memcpy(&bits, &f, sizeof(bits));
  const uint32_t rounding_bias = 0x7FFFu + ((bits >> 16) & 1u);
  return static_cast<uint16_t>((bits + rounding_bias) >> 16);
}

// Store one 16x16 int32 accumulator fragment scaled to bf16 with the three
// tail-gated weight_scale operands (wv1..wv3) arriving as already-loaded
// registers.
//
// Exact-source ISA of the accepted kernel (round-6 code object,
// compile_cache_key 1df09b96..., bundle
// profiles/.../iteration7/current-best-isa/isa.txt): the compiler already
// hoists x_scale[row] into the staging prologue (global_load_dword at 0x4710,
// before the first s_waitcnt vmcnt) and issues wv0 immediately after the last
// ds_write_b128 (0x4780), but wv1..wv3 are only issued between v_mmac 1..3
// (0x4844 / 0x484C / 0x4888) and are still in flight when the epilogue
// consumes them: real s_waitcnt vmcnt waits (0x4ACC vmcnt(4), 0x4AD4 vmcnt(3),
// 0x4B20 / 0x4B48 / 0x4B6C vmcnt(3)) sit between the four
// global_store_short_d16_hi, i.e. the per-block store tail can serialize on
// ~L2-latency arrivals of per-lane weight_scale dwords issued only ~3 v_mmacs
// earlier.  The exact-shape kernel below therefore loads wv1..wv3 in its
// staging batch (same three vmem read instructions as the generic epilogue,
// moved to the front of the wave's memory FIFO so they land during the
// staging round trip plus the six-step K chain) and passes them into this
// helper, which converts, scales and stores each element purely from
// registers.  Math stays byte-identical to the generic fragment stores
// (store_prefill_fragment / the reference formula): row = lane & 15 is
// always < m == 16, and each element keeps the same left-associative
// ((float)acc_i * xv) * wv_i fp32 evaluation order with the same RNE bf16
// rounding; xv and wv0 keep their proven round-6 issue points (loaded here,
// where the round-6 compiler scheduled them), so the delta is exactly the
// three loads whose issue the round-6 code object placed inside the mmac
// chain.
template <typename AccFragment>
__device__ __forceinline__ void store_acc_fragment_tail_preloaded(
    const AccFragment& frag,
    const float* __restrict__ x_scale,
    const float* __restrict__ weight_scale,
    float wv1,
    float wv2,
    float wv3,
    uint16_t* __restrict__ out,
    int n,
    int base_col,
    int lane) {
  const int row = lane & 15;  // m == 16 guard: always in range
  const int col_mod4 = lane >> 4;
  const float xv = x_scale[row];
  const float wv0 = weight_scale[base_col + col_mod4];
  const int64_t out_base =
      static_cast<int64_t>(row) * n + base_col + col_mod4;
  // Elements i = 0..3 sit at columns base_col + col_mod4 + 4*i; each keeps the
  // same left-associative ((float)acc_i * xv) * wv_i evaluation order and RNE
  // bf16 rounding as the generic fragment stores.
  const float s0 = static_cast<float>(frag.x[0]) * xv;
  out[out_base] = bf16_bits_from_f32(s0 * wv0);
  const float s1 = static_cast<float>(frag.x[1]) * xv;
  out[out_base + 4] = bf16_bits_from_f32(s1 * wv1);
  const float s2 = static_cast<float>(frag.x[2]) * xv;
  out[out_base + 8] = bf16_bits_from_f32(s2 * wv2);
  const float s3 = static_cast<float>(frag.x[3]) * xv;
  out[out_base + 12] = bf16_bits_from_f32(s3 * wv3);
}

// ---------------------------------------------------------------------------
// Explicit 8-byte fragment loader for the int8 m16k32 operand fragments.
//
// Both library loaders (row_major matrix_a, col_major matrix_b) place the
// same 8 contiguous bytes per lane into the same x[0..7] slots - lane l ->
// row (l & 15), k-quarter (l >> 4) - and the compiler lowers them to
// ds_read2_b32 (two 4-byte dword phases per half-wave).  A ds_read2_b32
// phase groups 32 lanes (rows 0-15 of one k-quarter with rows 0-15 of the
// other) into one 32-bank cycle, so the two k-quarter row sets share every
// phase: {22*r mod 32} and {22*r+2 mod 32} (A stride 22 dwords; 18*r and
// 18*r+2 for B stride 18) are the same 16 even banks - a 2-way conflict in
// every phase (8 phases per read) at ANY even dword row stride.  Loading
// the same 8 bytes as one int64 forces the 8-byte ds_read_b64 form, whose
// phases are 16-lane groups (16 lanes x 8 B = 128 B = one bank cycle):
// within each group the 16 rows land on 16 distinct bank-pairs (A:
// 22*r mod 32 distinct for r = 0..15, B: 18*r mod 32 distinct), so every
// fragment read runs at the 4-phase conflict-free floor.  The element-to-
// slot mapping is unchanged, so fragment register contents (and therefore
// the exact int32 k-ascending MMAC accumulation) are identical to the
// library loaders.
// ---------------------------------------------------------------------------
template <typename Frag>
__device__ __forceinline__ void load_frag8(Frag& f, const int8_t* p,
                                           unsigned ldm) {
  const unsigned row = __lane_id() & 0xf;
  const unsigned kq = __lane_id() >> 4;
  const int64_t v =
      *reinterpret_cast<const int64_t*>(p + row * ldm + (kq << 3));
  reinterpret_cast<int64_t*>(f.x)[0] = v;
}

// Store one 16x16 int32 accumulator fragment scaled to bf16 (prefill
// epilogue).  gfx928 int8 m16n16k32 accumulator ownership (validated
// against du_store_matrix_sync in this DTK): lane&15 selects the row,
// lane>>4 selects col%4, and frag.x[i] holds the columns col%4 + 4*i.
// Per element the fp32 scaling keeps the same left-associative
// ((float)acc_i * x_scale) * weight_scale order and the same RNE bf16
// rounding as the reference path and as the M=16 kernel.
template <typename AccFragment>
__device__ __forceinline__ void store_prefill_fragment(
    const AccFragment& frag,
    const float* __restrict__ x_scale,
    const float* __restrict__ weight_scale,
    uint16_t* __restrict__ out,
    int m,
    int n,
    int base_row,
    int base_col,
    int lane) {
  const int row = base_row + (lane & 15);
  if (row >= m) {
    return;  // tail-M rows: never touch x_scale/out out of bounds
  }
  const int col_mod4 = lane >> 4;
  const float xs = x_scale[row];
  const int64_t out_base =
      static_cast<int64_t>(row) * n + base_col + col_mod4;
#pragma unroll
  for (int i = 0; i < 4; ++i) {
    const float scaled = static_cast<float>(frag.x[i]) * xs *
                         weight_scale[base_col + col_mod4 + 4 * i];
    out[out_base + 4 * i] = bf16_bits_from_f32(scaled);
  }
}

// Round-6 fused-epilogue transpose write, iteration-14 register-batched
// form: scale one 16x16 accumulator fragment with its row scale (xv) and
// its four column scales (wv0..wv3, arriving as already-loaded registers)
// and store the RNE bf16 result into the block's row-major out_tile at the
// element's final (row, col) position.  The caller reads the four column
// scales of each 16-column fragment base (tile_col0 and
// tile_col0 + kInt8TileN) ONCE per wave and shares them between the two
// fragments of that base (acc00/acc10 and acc01/acc11), so the per-wave
// epilogue issues 8 ds_read_b32 instead of the round-8 form's 16 in-loop
// reads and no LDS load sits between the last v_mmac and the element store
// tail.  Per element the fp32 math keeps the same left-associative
// ((float)acc_i * xv) * wv_i evaluation order and the same RNE bf16
// rounding as store_prefill_fragment, and every wv_i is the bit-identical
// float the in-loop form read (same buffer s_wscale, same index
// base + c4 + 4*i, no write to s_wscale between the prologue landing and
// the epilogue), so the bytes this lane publishes are identical; only the
// destination differs from a scattered 2-byte global store (an LDS
// transpose slot that the coalesced sweep below reads back).
template <typename AccFragment>
__device__ __forceinline__ void transpose_bf16_fragment_lane(
    const AccFragment& frag, float xv, int tile_row0, int tile_col0,
    int r_lane, int c4, float wv0, float wv1, float wv2, float wv3,
    uint16_t* __restrict__ out_tile, int out_stride) {
  const float s0 = static_cast<float>(frag.x[0]) * xv;
  out_tile[(tile_row0 + r_lane) * out_stride + tile_col0 + c4] =
      bf16_bits_from_f32(s0 * wv0);
  const float s1 = static_cast<float>(frag.x[1]) * xv;
  out_tile[(tile_row0 + r_lane) * out_stride + tile_col0 + c4 + 4] =
      bf16_bits_from_f32(s1 * wv1);
  const float s2 = static_cast<float>(frag.x[2]) * xv;
  out_tile[(tile_row0 + r_lane) * out_stride + tile_col0 + c4 + 8] =
      bf16_bits_from_f32(s2 * wv2);
  const float s3 = static_cast<float>(frag.x[3]) * xv;
  out_tile[(tile_row0 + r_lane) * out_stride + tile_col0 + c4 + 12] =
      bf16_bits_from_f32(s3 * wv3);
}

// ---------------------------------------------------------------------------
// Large-M prefill path (down-proj family: M >= 128, K == kAssignedK, N a
// multiple of the active macro-tile N).  One block computes a kBlockM x
// kBlockN output tile with (kBlockM/32) x (kBlockN/32) wavefronts (one
// 32x32 quadrant per wave, four 16x16 int32 accumulators kept resident
// over the whole K loop).  A and the packed n-major B are cooperatively
// staged into a double-buffered, bank-padded LDS in kPrefillStageK = 64
// chunks with VGPR prefetch: the global int4 loads of stage s+1 are issued
// before the MMAC sequence of stage s and the alternate LDS buffer is
// written right after it, so the vmcnt(0) wait and the ds_write overlap
// compute (one barrier per stage; prologue + 3 stages = 4 barriers per
// block for K = 192).  A stays row-major in LDS (stride kAStride = 88); B
// is n-major at pack time (packed[n][k], one contiguous K run per output
// column) and is staged n-major (stride kBTStride = 72, K-contiguous),
// consumed through col_major matrix_b fragments; both operand paths use
// the explicit 8-byte load_frag8 ds_read_b64 reads above.  Each stage is
// consumed as kStageK = 2 x kInt8TileK fully unrolled steps into two
// independent fragment register sets, so the second step's LDS latency
// overlaps the first step's MMACs.  The epilogue is the fused direct
// fragment -> ((acc * x_scale) * weight_scale) -> bf16 store.
// ---------------------------------------------------------------------------
template <int kBlockM, int kBlockN, int kStageK>
__global__ __launch_bounds__(kBlockM * kBlockN / 1024 * kWaveSize, 2) void
w8a8_dumma_prefill_kernel(
    const int8_t* __restrict__ a,
    const int8_t* __restrict__ b,
    const float* __restrict__ x_scale,
    const float* __restrict__ weight_scale,
    uint16_t* __restrict__ out,
    int m,
    int n,
    int k) {
  constexpr int kWavesN = kBlockN / 32;
  static_assert(kAStride % 8 == 0,
                "A LDS row stride must stay 8-byte aligned");
  static_assert(kBTStride % 8 == 0,
                "transposed-B LDS row stride must stay 8-byte aligned");
  static_assert(kStageK % kInt8TileK == 0,
                "K stage must be a multiple of the DUMMA K unit");
  static_assert(kStageK % sizeof(int4) == 0,
                "K stage must keep int4 staging aligned");
  static_assert(kStageK == 2 * kInt8TileK,
                "unrolled kk body assumes kStageK == 2 * kInt8TileK");

  const int tid = static_cast<int>(threadIdx.x);
  const int wave = tid / kWaveSize;
  const int lane = tid - wave * kWaveSize;
  const int wave_row = wave / kWavesN;
  const int wave_col = wave - wave_row * kWavesN;
  const int m0 = static_cast<int>(blockIdx.y) * kBlockM;
  const int n0 = static_cast<int>(blockIdx.x) * kBlockN;

  constexpr int kThreads = kBlockM * kBlockN / 1024 * kWaveSize;
  constexpr int kAInt4PerRow = kStageK / sizeof(int4);
  constexpr int kAInt4 = kBlockM * kAInt4PerRow;
  constexpr int kChunksPerBRow = kStageK / sizeof(int4);
  constexpr int kBInt4 = kBlockN * kChunksPerBRow;
  static_assert(kAInt4 <= kThreads && kBInt4 <= kThreads,
                "one int4 chunk per thread requires chunks <= blockDim");
  const int kStages = k / kStageK;

  __shared__ __align__(16) int8_t a_tile[2][kBlockM * kAStride];
  // Transposed (n-major) B tile: logical B[k0+kk][n0+n_local] lives at
  // b_tile[n_local][kk], so col_major fragment loads read 8 contiguous K
  // bytes per lane (one ds_read_b64).  The staged runs are written from the
  // n-major packed weight as two 8-byte halves per thread.
  __shared__ __align__(16) int8_t b_tile[2][kBlockN * kBTStride];

  DUFragment<matrix_a, kInt8TileM, kInt8TileN, kInt8TileK, signed char,
             row_major>
      a_frag0, a_frag1, a_frag0_1, a_frag1_1;
  DUFragment<matrix_b, kInt8TileM, kInt8TileN, kInt8TileK, signed char,
             col_major>
      b_frag0, b_frag1, b_frag0_1, b_frag1_1;
  DUFragment<accumulator, kInt8TileM, kInt8TileN, kInt8TileK, int>
      acc00, acc01, acc10, acc11;
  du_fill_fragment(acc00, 0);
  du_fill_fragment(acc01, 0);
  du_fill_fragment(acc10, 0);
  du_fill_fragment(acc11, 0);

  // Prologue: prefetch stage 0 into VGPRs and land it in buffer 0.  Every
  // source address is 16-byte aligned (k % 16 == 0 by the exact k guard and
  // n % 16 == 0 by the launch guard); A destination rows are 8-byte aligned
  // (stride 88) and B destination rows 8-byte aligned (stride 72), so all
  // staging stores are the two-half int64 form.
  int4 a_pref{0, 0, 0, 0};
  int4 b_pref{0, 0, 0, 0};
  {
    if (tid < kAInt4) {
      const int row = tid / kAInt4PerRow;
      const int seg = tid - row * kAInt4PerRow;
      const int global_row = m0 + row;
      if (global_row < m) {
        a_pref = *reinterpret_cast<const int4*>(
            a + static_cast<int64_t>(global_row) * k + seg * sizeof(int4));
      }
    }
    if (tid < kBInt4) {
      const int n_local = tid / kChunksPerBRow;
      const int kchunk = (tid - n_local * kChunksPerBRow) * sizeof(int4);
      b_pref = *reinterpret_cast<const int4*>(
          b + (static_cast<int64_t>(n0) + n_local) * k + kchunk);
    }
    if (tid < kAInt4) {
      const int row = tid / kAInt4PerRow;
      const int seg = tid - row * kAInt4PerRow;
      // Two 8-byte halves: kAStride 88 % 16 == 8 makes odd rows 16-byte
      // misaligned, so the single-int4 store is illegal; the int64 pair
      // lowers to one ds_write2_b64 per thread.
      const int64_t* src64 = reinterpret_cast<const int64_t*>(&a_pref);
      int64_t* dst64 = reinterpret_cast<int64_t*>(
          a_tile[0] + row * kAStride + seg * sizeof(int4));
      dst64[0] = src64[0];
      dst64[1] = src64[1];
    }
    if (tid < kBInt4) {
      const int n_local = tid / kChunksPerBRow;
      const int kchunk = (tid - n_local * kChunksPerBRow) * sizeof(int4);
      const int64_t* src64 = reinterpret_cast<const int64_t*>(&b_pref);
      int64_t* dst64 = reinterpret_cast<int64_t*>(
          b_tile[0] + n_local * kBTStride + kchunk);
      dst64[0] = src64[0];
      dst64[1] = src64[1];
    }
    __syncthreads();
  }

  for (int s = 0; s < kStages; ++s) {
    const int k0 = s * kStageK;
    const int buf = s & 1;

    // Issue the global loads for stage s+1 now so their latency hides
    // behind the fragment loads and MMACs below.  Out-of-range A rows are
    // zero-filled (tail-M guard).
    if (s + 1 < kStages) {
      const int k1 = k0 + kStageK;
      if (tid < kAInt4) {
        const int row = tid / kAInt4PerRow;
        const int seg = tid - row * kAInt4PerRow;
        const int global_row = m0 + row;
        if (global_row < m) {
          a_pref = *reinterpret_cast<const int4*>(
              a + static_cast<int64_t>(global_row) * k + k1 +
              seg * sizeof(int4));
        } else {
          a_pref = int4{0, 0, 0, 0};
        }
      }
      if (tid < kBInt4) {
        const int n_local = tid / kChunksPerBRow;
        const int kchunk = (tid - n_local * kChunksPerBRow) * sizeof(int4);
        b_pref = *reinterpret_cast<const int4*>(
            b + (static_cast<int64_t>(n0) + n_local) * k + k1 + kchunk);
      }
    }

    // Consume stage s from buffer buf: four fragment loads and four MMACs
    // per wave per kInt8TileK step.  kStageK = 64 = 2 kInt8TileK steps,
    // fully unrolled into two independent fragment register sets: all eight
    // 8-byte fragment reads of a stage issue before the MMACs, so the
    // second step's LDS latency overlaps the first step's MMACs.
    const int local_row = wave_row * 32;
    const int local_col = wave_col * 32;
    load_frag8(a_frag0, a_tile[buf] + local_row * kAStride, kAStride);
    load_frag8(a_frag1, a_tile[buf] + (local_row + 16) * kAStride, kAStride);
    load_frag8(b_frag0, b_tile[buf] + local_col * kBTStride, kBTStride);
    load_frag8(b_frag1, b_tile[buf] + (local_col + 16) * kBTStride,
               kBTStride);
    // Second 32-k step (kk = kInt8TileK): independent registers, issued
    // while the first step's data is still in flight.
    load_frag8(a_frag0_1, a_tile[buf] + local_row * kAStride + kInt8TileK,
               kAStride);
    load_frag8(a_frag1_1,
               a_tile[buf] + (local_row + 16) * kAStride + kInt8TileK,
               kAStride);
    // col_major: element B[k0+kk+k][n0+n] lives at b_tile[n][kk+k], so the
    // loader's p[row*ldm + k + i] reads 8 contiguous bytes per lane.
    load_frag8(b_frag0_1, b_tile[buf] + local_col * kBTStride + kInt8TileK,
               kBTStride);
    load_frag8(b_frag1_1,
               b_tile[buf] + (local_col + 16) * kBTStride + kInt8TileK,
               kBTStride);
    du_mma_sync(acc00, a_frag0, b_frag0, acc00);
    du_mma_sync(acc01, a_frag0, b_frag1, acc01);
    du_mma_sync(acc10, a_frag1, b_frag0, acc10);
    du_mma_sync(acc11, a_frag1, b_frag1, acc11);
    du_mma_sync(acc00, a_frag0_1, b_frag0_1, acc00);
    du_mma_sync(acc01, a_frag0_1, b_frag1_1, acc01);
    du_mma_sync(acc10, a_frag1_1, b_frag0_1, acc10);
    du_mma_sync(acc11, a_frag1_1, b_frag1_1, acc11);

    // Land the prefetched stage s+1 in the alternate buffer.  The compiler
    // inserts the vmcnt(0) wait here via the data dependency, so the wait
    // and the ds_write overlap the MMACs above instead of stalling before
    // them.
    if (s + 1 < kStages) {
      if (tid < kAInt4) {
        const int row = tid / kAInt4PerRow;
        const int seg = tid - row * kAInt4PerRow;
        const int64_t* src64 = reinterpret_cast<const int64_t*>(&a_pref);
        int64_t* dst64 = reinterpret_cast<int64_t*>(
            a_tile[buf ^ 1] + row * kAStride + seg * sizeof(int4));
        dst64[0] = src64[0];
        dst64[1] = src64[1];
      }
      if (tid < kBInt4) {
        const int n_local = tid / kChunksPerBRow;
        const int kchunk = (tid - n_local * kChunksPerBRow) * sizeof(int4);
        const int64_t* src64 = reinterpret_cast<const int64_t*>(&b_pref);
        int64_t* dst64 = reinterpret_cast<int64_t*>(
            b_tile[buf ^ 1] + n_local * kBTStride + kchunk);
        dst64[0] = src64[0];
        dst64[1] = src64[1];
      }
    }
    // One barrier per stage: makes the alternate-buffer writes visible to
    // the next stage's reads and retires this stage's reads before the
    // parity-flipped buffer is overwritten two stages later.  Every thread
    // reaches it.
    __syncthreads();
  }

  const int base_row = m0 + wave_row * 32;
  const int base_col = n0 + wave_col * 32;
  store_prefill_fragment(acc00, x_scale, weight_scale, out, m, n, base_row,
                         base_col, lane);
  store_prefill_fragment(acc01, x_scale, weight_scale, out, m, n, base_row,
                         base_col + kInt8TileN, lane);
  store_prefill_fragment(acc10, x_scale, weight_scale, out, m, n,
                         base_row + kInt8TileM, base_col, lane);
  store_prefill_fragment(acc11, x_scale, weight_scale, out, m, n,
                         base_row + kInt8TileM, base_col + kInt8TileN, lane);
}

// ---------------------------------------------------------------------------
// Round-3 pipeline control of the same down-proj family tile: the SINGLE-
// buffered staged pipeline (one LDS buffer per operand instead of the
// parity pair of w8a8_dumma_prefill_kernel above), kept bit-identical and
// structurally identical otherwise: same (kBlockM x kBlockN) tile and wave
// -> quadrant mapping, same one-stage-ahead int4 VGPR prefetch (stage s+1
// global loads issued before the stage-s fragment loads/MMACs), same
// 8-byte load_frag8 fragment consumption with the identical k-ascending
// int32 MMAC order.  The single buffer is overwritten in place, so every
// stage boundary needs a WAR __syncthreads (retire the stage-s fragment
// reads) before the ds_write of stage s+1 and a publish __syncthreads after
// it: prologue + 2 x (kStages - 1) = 5 barriers per block for K = 192 vs
// the double-buffered prologue + kStages = 4 (of which the last-stage loop
// barrier is dead); the final stage's MMACs run straight into the epilogue.
// The SB epilogue is the round-6 FUSED form (scale windows staged in LDS in
// the prologue, per-fragment RNE bf16 transpose through a padded out_tile,
// one publish barrier, fully-coalesced 8-byte sweep stores) - same per-
// element fp32 math and RNE bf16 bytes as the direct round-3/4 fragment
// stores of the DB arm, only the store form differs.  Static LDS grows to
// 32,512 B/block for 64x128 (5,632 A + 9,216 B + 256 s_xscale + 512
// s_wscale + 16,896 out_tile; see the in-body comment), so residency stays
// 2 blocks/CU = 16 waves/CU (2 x 32,512 = 65,024 <= 65,536; the kernel
// stays VGPR-bound at ~56-64 vgpr x 512 threads x 2 blocks <= 65,536
// VGPRs), which keeps occupancy from confounding the pipeline comparison.
// ---------------------------------------------------------------------------
template <int kBlockM, int kBlockN, int kStageK>
__global__ __launch_bounds__(kBlockM * kBlockN / 1024 * kWaveSize, 2) void
w8a8_dumma_prefill_sb_kernel(
    const int8_t* __restrict__ a,
    const int8_t* __restrict__ b,
    const float* __restrict__ x_scale,
    const float* __restrict__ weight_scale,
    uint16_t* __restrict__ out,
    int m,
    int n,
    int k) {
  constexpr int kWavesN = kBlockN / 32;
  static_assert(kAStride % 8 == 0,
                "A LDS row stride must stay 8-byte aligned");
  static_assert(kBTStride % 8 == 0,
                "transposed-B LDS row stride must stay 8-byte aligned");
  static_assert(kStageK % kInt8TileK == 0,
                "K stage must be a multiple of the DUMMA K unit");
  static_assert(kStageK % sizeof(int4) == 0,
                "K stage must keep int4 staging aligned");
  static_assert(kStageK == 2 * kInt8TileK,
                "unrolled kk body assumes kStageK == 2 * kInt8TileK");

  const int tid = static_cast<int>(threadIdx.x);
  const int wave = tid / kWaveSize;
  const int lane = tid - wave * kWaveSize;
  const int wave_row = wave / kWavesN;
  const int wave_col = wave - wave_row * kWavesN;
  const int m0 = static_cast<int>(blockIdx.y) * kBlockM;
  const int n0 = static_cast<int>(blockIdx.x) * kBlockN;

  constexpr int kThreads = kBlockM * kBlockN / 1024 * kWaveSize;
  constexpr int kAInt4PerRow = kStageK / sizeof(int4);
  constexpr int kAInt4 = kBlockM * kAInt4PerRow;
  constexpr int kChunksPerBRow = kStageK / sizeof(int4);
  constexpr int kBInt4 = kBlockN * kChunksPerBRow;
  static_assert(kAInt4 <= kThreads && kBInt4 <= kThreads,
                "one int4 chunk per thread requires chunks <= blockDim");
  // No runtime stage count: the launch guard fixes k == kAssignedK == 192,
  // so the kernel body below is the compile-time 3-stage form (k is still
  // read at runtime inside run_stage for the global A/B row stride of the
  // stage-prefetch addresses; its value is always 192 under the guard).

  // Single-buffered stage: A rows on the padded 88-B stride and the packed
  // n-major B rows on the padded 72-B stride, exactly as the double-buffered
  // kernel, minus the parity [2] dimension.
  __shared__ __align__(16) int8_t a_tile[kBlockM * kAStride];
  __shared__ __align__(16) int8_t b_tile[kBlockN * kBTStride];

  // Round-6 fused-epilogue staging:
  //   * s_xscale/s_wscale - the block's per-row x_scale[kBlockM] and
  //     per-column weight_scale[kBlockN] windows, copied cooperatively into
  //     LDS inside the stage-0 staging batch (192 dword loads issued with the
  //     operand vectors, latency hidden under the prologue barrier and the
  //     whole K chain).  The epilogue then scales and converts every
  //     accumulator element from LDS-resident scales: no global load and no
  //     vmcnt wait can sit between the last v_mmac and the final store
  //     (the round-5 exact-source ISA shows the per-fragment scale dword
  //     loads issued only ~3 v_mmacs before the store tail, with real
  //     s_waitcnt vmcnt(n) waits interleaved between the four
  //     global_store_short_d16_hi groups of each fragment).
  //   * out_tile - the block's (kBlockM x kBlockN) bf16 output tile in
  //     row-major layout with row stride kOutStride = 132 elements (264 B,
  //     % 16 == 8 -> every row start stays 8-byte aligned for the coalesced
  //     ds_read_b64 sweep, while the +4-element pad spreads the 16 fragment
  //     rows over 16 distinct LDS bank words so the fragment-layout 2-byte
  //     transpose writes run at the ~1-phase floor).  Each wave converts its
  //     four fragments to RNE bf16 and transposes them through out_tile; one
  //     extra barrier later every thread stores one contiguous 32-B run of
  //     one output row as four 8-byte vector stores (fully coalesced lines,
  //     ~8x fewer L2 write line-touches than the old per-fragment
  //     global_store_short_d16_hi tail, which scattered each 64-lane store
  //     instruction over 16 rows' 8-B segments at the 8,192-B row stride).
  // Static LDS stays 32,512 B/block (5,632 A + 9,216 B + 256 + 512 scales +
  // 16,896 out), so 2 blocks/CU = 16 waves/CU remain resident
  // (2 x 32,512 = 65,024 <= 65,536); occupancy remains VGPR-bound.
  __shared__ __align__(16) float s_xscale[kBlockM];
  __shared__ __align__(16) float s_wscale[kBlockN];
  constexpr int kOutStride = kBlockN + 4;  // 132 bf16 per row (264 B), % 8 == 0
  static_assert((kOutStride * 2) % 8 == 0,
                "out_tile rows must stay 8-byte aligned for the b64 sweep");
  __shared__ __align__(16) uint16_t out_tile[kBlockM * kOutStride];

  DUFragment<matrix_a, kInt8TileM, kInt8TileN, kInt8TileK, signed char,
             row_major>
      a_frag0, a_frag1, a_frag0_1, a_frag1_1;
  DUFragment<matrix_b, kInt8TileM, kInt8TileN, kInt8TileK, signed char,
             col_major>
      b_frag0, b_frag1, b_frag0_1, b_frag1_1;
  DUFragment<accumulator, kInt8TileM, kInt8TileN, kInt8TileK, int>
      acc00, acc01, acc10, acc11;
  du_fill_fragment(acc00, 0);
  du_fill_fragment(acc01, 0);
  du_fill_fragment(acc10, 0);
  du_fill_fragment(acc11, 0);

  int4 a_pref{0, 0, 0, 0};
  int4 b_pref{0, 0, 0, 0};

  // Prologue: fetch stage 0 into VGPRs, land it in the single buffer with
  // the two-half int64 form (kAStride/kBTStride are 8 mod 16, so a single
  // 16-byte store would be misaligned on odd rows), publish with one
  // barrier.  Identical source bytes and store addresses as stage 0 of the
  // double-buffered kernel.
  {
    // Round-6 fused-epilogue staging: the block's x_scale[kBlockM] and
    // weight_scale[kBlockN] windows are loaded here, at the FRONT of the
    // prologue batch, so their vmcnt results land while the A/B staging
    // stores and the publish barrier below drain (the fused epilogue then
    // scales/converts every accumulator element purely from LDS: no global
    // load and no vmcnt wait can sit between the last v_mmac and the final
    // store, replacing the round-3/4 tail that serialized the four
    // store_short_d16_hi groups on per-lane weight_scale dword arrivals).
    float xscale_v = 0.0f;
    float wscale_v = 0.0f;
    if (tid < kBlockM) {
      const int g_row = m0 + tid;
      if (g_row < m) {
        xscale_v = x_scale[g_row];  // tail-M rows keep 0, never used
      }
    }
    if (tid < kBlockN) {
      wscale_v = weight_scale[n0 + tid];
    }
    if (tid < kAInt4) {
      const int row = tid / kAInt4PerRow;
      const int seg = tid - row * kAInt4PerRow;
      const int global_row = m0 + row;
      if (global_row < m) {
        a_pref = *reinterpret_cast<const int4*>(
            a + static_cast<int64_t>(global_row) * k + seg * sizeof(int4));
      }
    }
    if (tid < kBInt4) {
      const int n_local = tid / kChunksPerBRow;
      const int kchunk = (tid - n_local * kChunksPerBRow) * sizeof(int4);
      b_pref = *reinterpret_cast<const int4*>(
          b + (static_cast<int64_t>(n0) + n_local) * k + kchunk);
    }
    if (tid < kAInt4) {
      const int row = tid / kAInt4PerRow;
      const int seg = tid - row * kAInt4PerRow;
      const int64_t* src64 = reinterpret_cast<const int64_t*>(&a_pref);
      int64_t* dst64 = reinterpret_cast<int64_t*>(
          a_tile + row * kAStride + seg * sizeof(int4));
      dst64[0] = src64[0];
      dst64[1] = src64[1];
    }
    if (tid < kBInt4) {
      const int n_local = tid / kChunksPerBRow;
      const int kchunk = (tid - n_local * kChunksPerBRow) * sizeof(int4);
      const int64_t* src64 = reinterpret_cast<const int64_t*>(&b_pref);
      int64_t* dst64 = reinterpret_cast<int64_t*>(
          b_tile + n_local * kBTStride + kchunk);
      dst64[0] = src64[0];
      dst64[1] = src64[1];
    }
    // Land the staged scale windows (loaded at the front of this batch,
    // above) so the prologue publish barrier makes them visible to every
    // wave's fused epilogue.
    if (tid < kBlockM) {
      s_xscale[tid] = xscale_v;
    }
    if (tid < kBlockN) {
      s_wscale[tid] = wscale_v;
    }
    __syncthreads();
  }

  // Iteration-15 exact-K stage unroll: the launch guard fixes
  // k == kAssignedK == 192 == 3 x kPrefillStageK for every launch of this
  // kernel, so the three stage passes below are written out at compile time
  // for that exact K.  Each stage keeps the byte-identical round-3/14
  // structure - stage s+1 global int4 prefetch issued before the stage-s
  // fragment loads/MMACs, WAR __syncthreads, in-place landing of the
  // prefetched stage, publish __syncthreads at the first two boundaries,
  // straight into the epilogue after the last stage - with the exact int32
  // k-ascending MMAC order, operand staging bytes, fragment slots, the 6
  // barriers per block and the a_pref/b_pref VGPR prefetch registers reused
  // per stage unchanged, so the published bytes are bit-identical.  The
  // delta vs the rolled loop is only the per-stage control the round-8 code
  // object carries (trip-count increment s19, k offset s22, per-pass
  // compare/branch and the loop back-edge): with the count compile-time
  // known, all of it disappears and the stage-2 MMACs flow straight into the
  // fused epilogue.
  //
  // Iteration-16 exact-K specialization (terminal step of the round-15
  // unroll): the runtime dispatch below ran run_stage(0..2) for the guarded
  // K and kept a rolled fallback loop for any other k.  That fallback can
  // never execute - the host guard use_tiled_dumma requires
  // k == kAssignedK == 192 for every launch of this kernel - yet the timed
  // code object still carries its full extra stage copy (8 du_mma_sync, 8
  // ds_read_b64 fragment loads, 2 ds_write2_b64 landings, 2 s_barrier and
  // the loop control: v_mmac 32 total vs the 24 the executed path runs,
  // 8 s_barrier in .text vs the 6 executed) plus the uniform
  // s_cmp_eq_u32/s_cbranch on k == kAssignedK, and the register allocator
  // still has to allocate one merged CFG containing the loop's live ranges
  // and phi copies.  This round removes the dispatch and the dead rolled
  // copy: the three compile-time stages below run unconditionally (k is
  // still read at runtime for the global A/B row stride k of the stage
  // prefetch addresses, always 192 under the guard).  The executed path -
  // stage bodies, prefetch/land pairs, the 6 barriers, the fused epilogue
  // and the sweep - is source-identical, so the published bytes stay
  // bit-identical; the code object loses only dead code, dead barriers and
  // the k compare, and the allocator's problem loses the fallback merge.
  // Round-15's linearization raised the object from 57 to 65 VGPRs (sgpr
  // 28 -> 32) at the 64-VGPR 2-blocks/CU register boundary every prior
  // guard priced; the falsifiable question of this round is how much of
  // that +8 was the never-taken fallback path's register/phi cost (then the
  // specialized object returns to <= 64 VGPRs) versus inherent ILP of the
  // straight-line three-stage schedule (then it stays at 65 and this round
  // is the honest null at parity).
  const auto run_stage = [&](int s, bool has_next) {
    // Issue the global loads for stage s+1 now, at the same point as the
    // double-buffered kernel, so their latency hides behind the fragment
    // loads and MMACs below.  Out-of-range A rows are zero-filled (tail-M
    // guard), byte-identical to the rolled zero fill.
    if (has_next) {
      const int k1 = (s + 1) * kStageK;
      if (tid < kAInt4) {
        const int row = tid / kAInt4PerRow;
        const int seg = tid - row * kAInt4PerRow;
        const int global_row = m0 + row;
        if (global_row < m) {
          a_pref = *reinterpret_cast<const int4*>(
              a + static_cast<int64_t>(global_row) * k + k1 +
              seg * sizeof(int4));
        } else {
          a_pref = int4{0, 0, 0, 0};
        }
      }
      if (tid < kBInt4) {
        const int n_local = tid / kChunksPerBRow;
        const int kchunk = (tid - n_local * kChunksPerBRow) * sizeof(int4);
        b_pref = *reinterpret_cast<const int4*>(
            b + (static_cast<int64_t>(n0) + n_local) * k + k1 + kchunk);
      }
    }

    // Consume stage s from the single buffer: identical fragment loads and
    // MMACs to the rolled loop (same padded strides, same element-to-slot
    // mapping, same k-ascending int32 order).  The second kInt8TileK step
    // uses an independent register set so its LDS latency overlaps the first
    // step's MMACs.
    const int local_row = wave_row * 32;
    const int local_col = wave_col * 32;
    load_frag8(a_frag0, a_tile + local_row * kAStride, kAStride);
    load_frag8(a_frag1, a_tile + (local_row + 16) * kAStride, kAStride);
    load_frag8(b_frag0, b_tile + local_col * kBTStride, kBTStride);
    load_frag8(b_frag1, b_tile + (local_col + 16) * kBTStride, kBTStride);
    load_frag8(a_frag0_1, a_tile + local_row * kAStride + kInt8TileK,
               kAStride);
    load_frag8(a_frag1_1,
               a_tile + (local_row + 16) * kAStride + kInt8TileK, kAStride);
    load_frag8(b_frag0_1, b_tile + local_col * kBTStride + kInt8TileK,
               kBTStride);
    load_frag8(b_frag1_1,
               b_tile + (local_col + 16) * kBTStride + kInt8TileK,
               kBTStride);
    du_mma_sync(acc00, a_frag0, b_frag0, acc00);
    du_mma_sync(acc01, a_frag0, b_frag1, acc01);
    du_mma_sync(acc10, a_frag1, b_frag0, acc10);
    du_mma_sync(acc11, a_frag1, b_frag1, acc11);
    du_mma_sync(acc00, a_frag0_1, b_frag0_1, acc00);
    du_mma_sync(acc01, a_frag0_1, b_frag1_1, acc01);
    du_mma_sync(acc10, a_frag1_1, b_frag0_1, acc10);
    du_mma_sync(acc11, a_frag1_1, b_frag1_1, acc11);

    if (has_next) {
      // WAR barrier: every stage-s fragment read in the whole block must
      // retire before the single buffer is overwritten in place with stage
      // s+1.
      __syncthreads();
      // Land the prefetched stage s+1.  The compiler inserts the vmcnt(0)
      // wait here via the a_pref/b_pref data dependency, i.e. after the
      // MMACs and the WAR barrier, never before the stage-s burst.
      if (tid < kAInt4) {
        const int row = tid / kAInt4PerRow;
        const int seg = tid - row * kAInt4PerRow;
        const int64_t* src64 = reinterpret_cast<const int64_t*>(&a_pref);
        int64_t* dst64 = reinterpret_cast<int64_t*>(
            a_tile + row * kAStride + seg * sizeof(int4));
        dst64[0] = src64[0];
        dst64[1] = src64[1];
      }
      if (tid < kBInt4) {
        const int n_local = tid / kChunksPerBRow;
        const int kchunk = (tid - n_local * kChunksPerBRow) * sizeof(int4);
        const int64_t* src64 = reinterpret_cast<const int64_t*>(&b_pref);
        int64_t* dst64 = reinterpret_cast<int64_t*>(
            b_tile + n_local * kBTStride + kchunk);
        dst64[0] = src64[0];
        dst64[1] = src64[1];
      }
      // Publish: make the stage s+1 writes visible before the next stage's
      // fragment reads.
      __syncthreads();
    }
  };
  // Iteration-16 exact-K specialization: the launch guard fixes
  // k == kAssignedK == 192 == 3 x kPrefillStageK for every launch of this
  // kernel, so the three compile-time stages run unconditionally below
  // (the round-15 rolled fallback for any other k, which could never
  // execute and whose dead stage copy, dead barriers and loop control
  // stayed in the timed code object, is removed).
  run_stage(0, true);
  run_stage(1, true);
  run_stage(2, false);

  // Round-6 fused epilogue (SB arm only): every accumulator element is
  // scaled with the prologue-staged LDS windows (s_xscale/s_wscale) and
  // converted to RNE bf16 with the identical left-associative fp32 math as
  // the direct fragment stores of rounds 3/4, but each element is transposed
  // into the block's padded row-major out_tile instead of a scattered
  // 2-byte global store.  One extra barrier later a fully-coalesced sweep
  // stores the whole tile: each thread copies one contiguous 32-B run of one
  // output row to global as four 8-byte vector stores, so the per-block
  // epilogue global-store tail collapses from 256 scattered
  // store_short_d16_hi instructions (each 64-lane instruction touching 16
  // rows' 8-B segments at the 8,192-B row stride, with vmcnt waits for
  // in-flight per-lane scale dwords between the four groups) into 32 fully
  // coalesced 8-byte store instructions with no global-load dependency at
  // all.  Every published byte is bit-identical to the round-3/4 store form.
  const int tile_row0 = wave_row * 32;  // n0/m0-relative quadrant origin
  const int tile_col0 = wave_col * 32;
  const int r_lane = lane & 15;
  const int c4 = lane >> 4;
  // Iteration-14 register-batched column scales: the four s_wscale dwords
  // of each 16-column fragment base are read ONCE per wave, back to back,
  // and shared by the two fragments of that base (acc00/acc10 use base
  // tile_col0, acc01/acc11 use base tile_col0 + kInt8TileN).  The round-8
  // form re-read them inside every fragment call's store loop (16
  // ds_read_b32/wave with one load->use dependency per element); this form
  // issues 8 ds_read_b32/wave ahead of the element math.  Every read is
  // unguarded: the index stays inside s_wscale[kBlockN] for every lane
  // (tile_col0 + kInt8TileN + c4 + 12 <= 96 + 16 + 15 <= 127) and tail-M
  // blocks simply discard the values under the row guards below, so the
  // published bytes stay bit-identical to the round-8 form.
  const int g_row0 = m0 + tile_row0 + r_lane;  // rows of acc00/acc01
  const int g_row1 = m0 + tile_row0 + kInt8TileM + r_lane;  // acc10/acc11
  const float wv00 = s_wscale[tile_col0 + c4];
  const float wv01 = s_wscale[tile_col0 + c4 + 4];
  const float wv02 = s_wscale[tile_col0 + c4 + 8];
  const float wv03 = s_wscale[tile_col0 + c4 + 12];
  const float xv0 = s_xscale[tile_row0 + r_lane];
  if (g_row0 < m) {  // row tail guard, as in the round-3/4 fragment stores
    transpose_bf16_fragment_lane(acc00, xv0, tile_row0, tile_col0, r_lane,
                                 c4, wv00, wv01, wv02, wv03, out_tile,
                                 kOutStride);
  }
  const float xv1 = s_xscale[tile_row0 + kInt8TileM + r_lane];
  if (g_row1 < m) {
    transpose_bf16_fragment_lane(acc10, xv1, tile_row0 + kInt8TileM,
                                 tile_col0, r_lane, c4, wv00, wv01, wv02,
                                 wv03, out_tile, kOutStride);
  }
  // The tile_col0 batch is consumed; only now read the second 4-dword batch
  // (column base tile_col0 + kInt8TileN, shared by acc11/acc01) so at most
  // four scale registers are live at once in the tail.
  const float wv10 = s_wscale[tile_col0 + kInt8TileN + c4];
  const float wv11 = s_wscale[tile_col0 + kInt8TileN + c4 + 4];
  const float wv12 = s_wscale[tile_col0 + kInt8TileN + c4 + 8];
  const float wv13 = s_wscale[tile_col0 + kInt8TileN + c4 + 12];
  if (g_row1 < m) {
    transpose_bf16_fragment_lane(acc11, xv1, tile_row0 + kInt8TileM,
                                 tile_col0 + kInt8TileN, r_lane, c4, wv10,
                                 wv11, wv12, wv13, out_tile, kOutStride);
  }
  if (g_row0 < m) {
    transpose_bf16_fragment_lane(acc01, xv0, tile_row0,
                                 tile_col0 + kInt8TileN, r_lane, c4, wv10,
                                 wv11, wv12, wv13, out_tile, kOutStride);
  }
  // Publish: every wave's out_tile transpose writes must be visible to the
  // coalesced sweep below (the 6th barrier of the block).
  __syncthreads();
  // Coalesced sweep: thread tid stores one contiguous 32-B run (16 bf16 =
  // four 8-byte vectors) of one output row.  kThreadsPerRow consecutive
  // threads cover one row, so every 8-byte store instruction in the sweep
  // is fully coalesced.  Global row stride n is a multiple of kBlockN by the
  // launch guard and c is a multiple of 16 elements, so both the LDS source
  // (row stride kOutStride * 2 B, 8-byte aligned by the static_assert above)
  // and the global destination stay 8-byte aligned.  Tail-M rows are skipped
  // (their out_tile slots were never transposed).
  {
    constexpr int kElemsPerThread = (kBlockM * kBlockN) / kThreads;  // 16
    constexpr int kThreadsPerRow = kBlockN / kElemsPerThread;        // 8
    static_assert(kBlockN % kElemsPerThread == 0,
                  "sweep requires an integral number of threads per row");
    static_assert((kElemsPerThread * 2) % 8 == 0,
                  "sweep copy must stay 8-byte aligned");
    const int row_local = tid / kThreadsPerRow;
    const int seg = tid - row_local * kThreadsPerRow;
    const int g_row = m0 + row_local;
    if (g_row < m) {
      const int c = seg * kElemsPerThread;
      const int64_t* __restrict__ src64 =
          reinterpret_cast<const int64_t*>(out_tile +
                                           row_local * kOutStride + c);
      int64_t* __restrict__ dst64 = reinterpret_cast<int64_t*>(
          out + static_cast<int64_t>(g_row) * n + n0 + c);
#pragma unroll
      for (int j = 0; j < (kElemsPerThread * 2) / 8; ++j) {
        dst64[j] = src64[j];
      }
    }
  }
}

// Exact assigned shape hy3_tp8_shared_down_proj_m16 (M=16, N=4096, K=192):
// one-wave INT8 DUMMA m16n16k32 kernel with a bounded whole-window LDS
// prefetch of the block's operand tiles and the packed n-major weight.
//
// The down-proj weight ((k,n)==(192,4096)) is packed once, out of the timed
// region, as P[n*K+kk] = W[kk*N+n]: each logical n column becomes a
// contiguous 192-byte run, so this block's private B window (n0..n0+15) is
// one contiguous 3,072-byte global region.  One 64-lane wavefront per block
// computes one 16x16 output tile (all 16 rows of A, columns n0..n0+15).
// Before the K loop the wave cooperatively prefetches the whole K=192 window
// into LDS with wide 16-byte vector loads -- A[16,192] (3,072 B; the same
// L2-hot bytes every block reads) into a bank-skewed 16x208 padded
// row-major stage, and the packed B strip (3,072 B, fetched from global
// exactly once, fully coalesced) into a 16x208 padded n-major stage.  The
// six 16-byte cooperative loads (A vectors lane/lane+64/lane+128 and the B
// strip vectors lane/lane+64/lane+128) are issued back to back into distinct
// registers before any ds_write, so all six global reads run in flight and
// the wave pays one memory round trip for the whole window instead of the
// six serialized global_load -> s_waitcnt vmcnt(0) -> ds_write_b128 chains
// the round-5 exact-source ISA shows (register reuse forced a full wait per
// chunk) -- then
// the six m16n16k32 steps load their fragments with du_load_matrix_sync /
// du_mma_sync straight from LDS (int32 accumulation).  A is consumed
// row_major and B is consumed col_major on its n-major stage, so each
// lane's 8 fragment bytes are one contiguous k-run: every per-lane fragment
// read is a single 8-byte LDS read (ds_read_b64) with no byte reassembly,
// the pattern the validated TP4 down-proj lineage (same N=4096 grid=256
// K-half=192 geometry, 208-byte strides) measured.  No vmem instruction or
// global-latency wait remains inside the K loop; the only __syncthreads is
// the single one after the staging stores (one wavefront, none in the
// loop), and the epilogue goes straight from the verified gfx928
// accumulator fragment ownership to the scaled bf16 store.  P is a pure
// transpose of the identity pack (P[n*K+kk] == W[kk*N+n]), so every
// fragment byte equals the byte the round-4 k-major stage delivered for the
// same (kk, n) and the k-ascending int32 accumulation order is unchanged.
__global__ __launch_bounds__(kWaveSize) void
w8a8_gemm_dumma_m16n16k32_packedb_lds_kernel(
    const int8_t* __restrict__ a,           // [16, K] row-major
    const int8_t* __restrict__ b,           // packed [N, K] n-major down-proj
    const float* __restrict__ x_scale,      // [16]
    const float* __restrict__ weight_scale, // [N]
    uint16_t* __restrict__ out,             // [16, N] bf16 bits
    int n,
    int k) {
  const int lane = static_cast<int>(threadIdx.x);  // wavefront lane 0..63
  const int n0 = static_cast<int>(blockIdx.x) * kInt8TileN;
  (void)k;  // exact-shape guard fixes k == 192 == kLdsK (compile-time bound)

  // Whole-window LDS stage (guard guarantees k == 192).  Both strides are
  // 16-byte multiples so every staging store and fragment load stays
  // 16-byte aligned; 208 = 192 + 16 is the validated TP4 down_proj skew,
  // used here for the A rows and for the B n-columns alike.
  constexpr int kLdsK = 192;        // K of the guarded shape
  constexpr int kLdsAStride = 208;  // A row stride in bytes (192 + 16 pad)
  constexpr int kLdsBStride = 208;  // B n-column stride in bytes (192 + 16 pad)
  __shared__ __align__(16) int8_t a_tile[kInt8TileM * kLdsAStride];
  __shared__ __align__(16) int8_t b_tile[kInt8TileN * kLdsBStride];

  // A: all 16 rows x 192 bytes are contiguous in global memory (3,072 B =
  // 192 int4 vectors) and B: this block's private strip is the 16 packed n
  // rows n0..n0+15, one contiguous 3,072 B region (P row n is 192 contiguous
  // k bytes).  In both windows lane l owns vectors l, l+64 and l+128, i.e.
  // six fully coalesced 16-byte loads per lane cover the whole prologue.
  // All six loads are issued into distinct registers before any LDS store:
  // the round-5 exact-source ISA shows the previous per-vector loops
  // degraded into six serialized global_load -> s_waitcnt vmcnt(0) ->
  // ds_write_b128 round trips per block (three for A, three for B), each
  // paying the full L2/HBM latency on the block's critical path.  Batching
  // keeps every source byte and every padded tile slot identical while
  // collapsing the prologue to one in-flight memory round trip.
  const int4 a_v0 = *reinterpret_cast<const int4*>(a + lane * 16);
  const int4 a_v1 =
      *reinterpret_cast<const int4*>(a + (lane + kWaveSize) * 16);
  const int4 a_v2 =
      *reinterpret_cast<const int4*>(a + (lane + 2 * kWaveSize) * 16);
  const int8_t* b_strip = b + static_cast<int64_t>(n0) * kLdsK;
  const int4 b_v0 = *reinterpret_cast<const int4*>(b_strip + lane * 16);
  const int4 b_v1 =
      *reinterpret_cast<const int4*>(b_strip + (lane + kWaveSize) * 16);
  const int4 b_v2 =
      *reinterpret_cast<const int4*>(b_strip + (lane + 2 * kWaveSize) * 16);
  // wv1..wv3 scale preload, issued inside the staging batch right behind the
  // six operand vectors (same three vmem read instructions per block as the
  // generic epilogue performs; only the issue point moves to the front of the
  // wave's vmem FIFO).  col_mod4 = lane >> 4; M == 16 fills the whole tile, so
  // these are the exact columns the epilogue scales, and every index stays
  // in range (n0 + col_mod4 + 12 <= 4095 < N).  See
  // store_acc_fragment_tail_preloaded for the round-6 ISA evidence that
  // wv1..wv3 were issued between v_mmac 1..3 and waited on between the four
  // bf16 stores.
  const int col_mod4 = lane >> 4;
  const float wv1 = weight_scale[n0 + col_mod4 + 4];
  const float wv2 = weight_scale[n0 + col_mod4 + 8];
  const float wv3 = weight_scale[n0 + col_mod4 + 12];
  constexpr int kChunksPerRow = kLdsK / 16;  // 12 x 16-B chunks per 192-B row
  // Chunk vec -> padded-tile int4 slot (row = vec / 12, k16 = (vec % 12)*16);
  // both tiles use the same 208-byte skew so the mapping is shared.
  const auto stage_slot = [](int vec) -> int {
    const int row = vec / kChunksPerRow;
    return (row * kLdsAStride + (vec - row * kChunksPerRow) * 16) / 16;
  };
  reinterpret_cast<int4*>(a_tile)[stage_slot(lane)] = a_v0;
  reinterpret_cast<int4*>(a_tile)[stage_slot(lane + kWaveSize)] = a_v1;
  reinterpret_cast<int4*>(a_tile)[stage_slot(lane + 2 * kWaveSize)] = a_v2;
  reinterpret_cast<int4*>(b_tile)[stage_slot(lane)] = b_v0;
  reinterpret_cast<int4*>(b_tile)[stage_slot(lane + kWaveSize)] = b_v1;
  reinterpret_cast<int4*>(b_tile)[stage_slot(lane + 2 * kWaveSize)] = b_v2;
  __syncthreads();

  DUFragment<matrix_a, kInt8TileM, kInt8TileN, kInt8TileK, signed char,
             row_major>
      a_frag;
  DUFragment<matrix_b, kInt8TileM, kInt8TileN, kInt8TileK, signed char,
             col_major>
      b_frag;
  DUFragment<accumulator, kInt8TileM, kInt8TileN, kInt8TileK, int> acc_frag;
  du_fill_fragment(acc_frag, 0);

  // K = 192 = 6 x kInt8TileK DUMMA steps; k ascending, int32 accumulation.
  // Fragment loads hit LDS (du_load_matrix_sync on a __shared__ pointer,
  // the same pattern the staged prefill kernel above validates), so the K
  // loop carries no vmem and no global-latency wait.  The bound is the
  // compile-time kLdsK (the exact-shape guard fixes k == 192), so the six
  // steps fully unroll and the scheduler can issue step i+1's ds_reads while
  // step i's v_mmac is still in the pipe, instead of a rolled loop in which
  // each iteration's reads can only issue after the previous step retires.
  for (int k0 = 0; k0 < kLdsK; k0 += kInt8TileK) {
    du_load_matrix_sync(a_frag, a_tile + k0, kLdsAStride);
    // col_major on the n-major stage: byte (k, n) sits at n*208 + k, so the
    // k0 step's fragment starts at b_tile + k0 and each lane's 8 bytes are
    // one contiguous run in its column (one ds_read_b64 per lane).
    du_load_matrix_sync(b_frag, b_tile + k0, kLdsBStride);
    du_mma_sync(acc_frag, a_frag, b_frag, acc_frag);
  }

  // Direct fragment -> ((acc * x_scale) * weight_scale) -> bf16 store with
  // wv1..wv3 supplied from the prologue preload: no vmem load issued inside
  // the mmac chain remains to gate the store tail (xv and wv0 load here at
  // their proven round-6 issue points).  M == 16 fills the whole tile; row is
  // always in range.
  store_acc_fragment_tail_preloaded(acc_frag, x_scale, weight_scale, wv1, wv2,
                                    wv3, out, n, n0, lane);
}

// Generic scalar int8/int32 fallback: one thread per output element, exact
// int32 accumulation over K, fp32 scaling, bf16 store.  Serves every
// unmatched (m, n, k) and all small-M API cases (including the assigned
// M=16 shape at bootstrap).  Requires only m >= 1 and the API-validated
// alignment properties; it never reads out of bounds.
__global__ __launch_bounds__(kScalarThreads)
void w8a8_gemm_scalar_fallback_kernel(
    const int8_t* __restrict__ a,
    const int8_t* __restrict__ b,
    const float* __restrict__ x_scale,
    const float* __restrict__ weight_scale,
    uint16_t* __restrict__ out,
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
  const int8_t* a_row = a + static_cast<int64_t>(row) * k;
  int32_t acc = 0;
  if (k == 192 && n == 4096) {
    // The (k, n) == (192, 4096) down-proj packed buffer is n-major
    // P[n*K+kk] = W[kk*N+n]: column col is one contiguous 192-byte run.
    const int8_t* b_col = b + static_cast<int64_t>(col) * k;
#pragma unroll 4
    for (int kk = 0; kk < k; ++kk) {
      acc += static_cast<int32_t>(a_row[kk]) *
             static_cast<int32_t>(b_col[kk]);
    }
  } else {
    const int8_t* b_col = b + col;
#pragma unroll 4
    for (int kk = 0; kk < k; ++kk) {
      acc += static_cast<int32_t>(a_row[kk]) *
             static_cast<int32_t>(b_col[static_cast<int64_t>(kk) * n]);
    }
  }
  const float scaled = static_cast<float>(acc) * x_scale[row] *
                       weight_scale[col];
  out[static_cast<int64_t>(row) * n + col] = bf16_bits_from_f32(scaled);
}

// Generic element-wise device-to-device copy used by the identity pack.
template <typename T>
__global__ void w8a8_element_copy_kernel(const T* __restrict__ src,
                                         T* __restrict__ dst,
                                         int64_t count) {
  const int64_t stride = static_cast<int64_t>(gridDim.x) * blockDim.x;
  for (int64_t i = static_cast<int64_t>(blockIdx.x) * blockDim.x +
                   threadIdx.x;
       i < count; i += stride) {
    dst[i] = src[i];
  }
}

// One-time n-major transpose pack for the TP8 down-proj weight
// ((k, n) == (192, 4096)): packed[n*k + kk] = raw[kk*n + n_local].  Every
// logical [K, N] column of the weight becomes a contiguous k-run of the
// packed buffer (same byte count, same graph-stable buffer).  Weight
// preprocessing; runs outside the timed region and Graph capture.
__global__ __launch_bounds__(kPackThreads)
void w8a8_pack_nmajor_downproj_kernel(const int8_t* __restrict__ raw,
                                      int8_t* __restrict__ packed, int k,
                                      int n) {
  const int64_t total = static_cast<int64_t>(n) * k;
  const int64_t stride = static_cast<int64_t>(gridDim.x) * blockDim.x;
  for (int64_t idx = static_cast<int64_t>(blockIdx.x) * blockDim.x +
                     threadIdx.x;
       idx < total; idx += stride) {
    const int n_local = static_cast<int>(idx / k);
    const int kk = static_cast<int>(idx - static_cast<int64_t>(n_local) * k);
    packed[idx] = raw[static_cast<int64_t>(kk) * n + n_local];
  }
}

void launch_pack_identity_impl(const int8_t* raw_weight,
                               const float* weight_scale,
                               int8_t* packed_weight,
                               float* packed_weight_scale, int k, int n,
                               hipStream_t stream) {
  const int64_t weight_count = static_cast<int64_t>(k) * n;
  const int64_t scale_count = n;
  const dim3 block(kPackThreads);
  const unsigned weight_blocks = static_cast<unsigned>(
      (weight_count + kPackThreads - 1) / kPackThreads);
  const unsigned scale_blocks = static_cast<unsigned>(
      (scale_count + kPackThreads - 1) / kPackThreads);
  if (weight_count > 0) {
    hipLaunchKernelGGL(
        HIP_KERNEL_NAME(w8a8_element_copy_kernel<int8_t>),
        dim3(weight_blocks), block, 0, stream, raw_weight, packed_weight,
        weight_count);
  }
  if (scale_count > 0) {
    hipLaunchKernelGGL(
        HIP_KERNEL_NAME(w8a8_element_copy_kernel<float>), dim3(scale_blocks),
        block, 0, stream, weight_scale, packed_weight_scale, scale_count);
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
  (void)workspace;
  (void)workspace_bytes;
  auto* out_ptr = static_cast<uint16_t*>(out);

  // Exact assigned decode shape hy3_tp8_shared_down_proj_m16.  The exact
  // (m, n, k) == (16, 4096, 192) guard keeps the paired M=2 API shape with
  // the same (N, K) on the generic scalar fallback below.
  if (m == 16 && n == 4096 && k == 192) {
    // One 64-lane wavefront per block, one 16x16 output tile per block:
    // grid = 4096 / 16 = 256 blocks, whole-window LDS prefetch of A and of
    // the packed n-major B strip, one staging barrier per block, col_major
    // B fragment consumption (one 8-byte LDS read per lane per step).
    const dim3 block(kWaveSize);
    const dim3 grid(static_cast<unsigned>(n / kInt8TileN));
    hipLaunchKernelGGL(
        HIP_KERNEL_NAME(w8a8_gemm_dumma_m16n16k32_packedb_lds_kernel), grid,
        block, 0, stream, a, b, x_scale, weight_scale, out_ptr, n, k);
    return;
  }

  // Down-proj family guard (assigned M=4096 shape).  The M < 128 shapes -
  // including the paired M=2 API shape with the same (N, K) - deliberately
  // fall through to the scalar kernel below.  The guard is shape-exact on K
  // (k == kAssignedK == 192, the only K whose weight is packed n-major) and
  // requires N to be a multiple of the active macro-tile N.  The active
  // macro-tile is fixed at compile time (kActiveTileIndex), so the timed
  // region never tunes; the other two family instantiations stay compiled
  // for compile-time A/B.
  const bool use_tiled_dumma =
      m >= 128 && k == kAssignedK && (n % kActiveBlockN) == 0;
  if (use_tiled_dumma) {
    const dim3 grid(
        static_cast<unsigned>(n / kActiveBlockN),
        static_cast<unsigned>((m + kActiveBlockM - 1) / kActiveBlockM));
    const dim3 block(static_cast<unsigned>(
        kActiveBlockM * kActiveBlockN / 1024 * kWaveSize));
    if (kActiveTileIndex == 0) {
      hipLaunchKernelGGL(
          HIP_KERNEL_NAME(w8a8_dumma_prefill_kernel<64, 64, kPrefillStageK>),
          grid, block, 0, stream, a, b, x_scale, weight_scale, out_ptr, m, n,
          k);
    } else if (kActiveTileIndex == 1) {
      if (kActivePipeline == 0) {
        // Round-3 single-buffered pipeline control (64x128 tile): same
        // bytes, MMAC order and occupancy as the double-buffered arm, LDS
        // halved to 14,848 B/block, one extra barrier per stage boundary.
        hipLaunchKernelGGL(
            HIP_KERNEL_NAME(
                w8a8_dumma_prefill_sb_kernel<64, 128, kPrefillStageK>),
            grid, block, 0, stream, a, b, x_scale, weight_scale, out_ptr, m,
            n, k);
      } else {
        // Accepted double-buffered pipeline (retention arm).
        hipLaunchKernelGGL(
            HIP_KERNEL_NAME(
                w8a8_dumma_prefill_kernel<64, 128, kPrefillStageK>),
            grid, block, 0, stream, a, b, x_scale, weight_scale, out_ptr, m,
            n, k);
      }
    } else {
      hipLaunchKernelGGL(
          HIP_KERNEL_NAME(
              w8a8_dumma_prefill_kernel<128, 64, kPrefillStageK>),
          grid, block, 0, stream, a, b, x_scale, weight_scale, out_ptr, m, n,
          k);
    }
    return;
  }

  // Generic scalar fallback (one grid row per M, columns chunked).
  const dim3 scalar_grid(
      static_cast<unsigned>((n + kScalarThreads - 1) / kScalarThreads),
      static_cast<unsigned>(m));
  const dim3 scalar_block(kScalarThreads);
  hipLaunchKernelGGL(w8a8_gemm_scalar_fallback_kernel, scalar_grid,
                     scalar_block, 0, stream, a, b, x_scale, weight_scale,
                     out_ptr, m, n, k);
}

extern "C" void launch_pack_w8a8_weight(
    const int8_t* raw_weight,
    const float* weight_scale,
    int8_t* packed_weight,
    float* packed_weight_scale,
    int k,
    int n,
    hipStream_t stream) {
  // The assigned TP8 down-proj weight ((k, n) == (192, 4096)) is packed
  // n-major (P[n*k + kk] = raw[kk*n + n_local], one contiguous k-run per n
  // column) so the M=16 kernel and the M>=128 tiled DUMMA path can consume
  // B fragments col_major with one vector LDS read per lane per step.  Every
  // other (k, n) keeps the logical [K, N] row-major identity pack (weight
  // and scale copies), which the generic fallback decodes.
  if (k == 192 && n == 4096) {
    const int64_t weight_count = static_cast<int64_t>(k) * n;
    const int64_t scale_count = n;
    const dim3 block(kPackThreads);
    if (weight_count > 0) {
      const unsigned weight_blocks = static_cast<unsigned>(
          (weight_count + kPackThreads - 1) / kPackThreads);
      hipLaunchKernelGGL(HIP_KERNEL_NAME(w8a8_pack_nmajor_downproj_kernel),
                         dim3(weight_blocks), block, 0, stream, raw_weight,
                         packed_weight, k, n);
    }
    if (scale_count > 0) {
      const unsigned scale_blocks = static_cast<unsigned>(
          (scale_count + kPackThreads - 1) / kPackThreads);
      hipLaunchKernelGGL(HIP_KERNEL_NAME(w8a8_element_copy_kernel<float>),
                         dim3(scale_blocks), block, 0, stream, weight_scale,
                         packed_weight_scale, scale_count);
    }
    return;
  }
  launch_pack_identity_impl(raw_weight, weight_scale, packed_weight,
                            packed_weight_scale, k, n, stream);
}
// @@end
