// @@variant shape=glm_tp8_fused_qkv_a_proj_m4096 commit=7cf8d67fe9e0c38f2b4c3c67aded1bf8cc894342 added=2026-09-14
//   median_us=693.8 p90_us=695.3 speedup=98.96 baseline_us=6.866e+04
//   source=test-9-11-1/iteration_002/glm_tp8_fused_qkv_a_proj_m4096
// MetaInfer W8A8 INT8 GEMM -- round-1 architecture establishment for
// Hygon K500SM_AI / gfx928 (worker_0, physical GPU 0).
//
// Assigned shape:
//   glm_tp8_fused_qkv_a_proj_m4096 : M=4096, N=2624, K=6144
//   (GLM5.2 TP=8 fused_qkv_a_proj, logical (K, N) = (6144, 2624))
//
// Operator contract (fixed by csrc/bindings.cpp and int8_w8a8_gemm_api.py):
//   out[m, n] = bf16( int32_dot(x_q[m, :], raw_weight[:, n])
//                     * x_scale[m, 0] * weight_scale[n, 0] )
//
// Mandatory decision this round: the tile-shape (M-tile vs N-tile aspect ratio)
// round. The packed_weight architecture, the exact-shape packed-B swizzle, the
// double-buffered 64-K stage pipeline, the bank-safe A LDS stride, the
// conflict-free swizzled B fragment reads and the fused coalesced bf16 epilogue
// are all RETAINED unchanged; only the macro-tile aspect ratio and its derived
// wave split are retuned for M=4096, N=2624, K=6144. No split-K, no workspace
// use, no allocation/compilation/packing/synchronization inside the timed API.
//
//   (1) launch_pack_w8a8_weight packs the exact (k, n) == (6144, 2624) weight
//       ONCE, outside the timed region and out of Graph capture, into a
//       fragment-interleaved swizzle of 512-byte 32-k x 16-n DUMMA B fragment
//       blocks laid out [k32][n16][k8][n][8]:
//         packed[((kk>>5)*n16g + (n>>4))*512 +
//                (((kk>>3)&3)*16 + (n&15))*8 + (kk&7)] = raw[kk*n + n],
//       n16g = n>>4 = 164. Byte-exact bijection 192 x 164 x 512 = k*n =
//       16,121,856: same byte count and same buffer allocation, so every
//       captured address is graph-stable. Every other (K, N) keeps the identity
//       device-to-device copy.
//   (2) the exact-shape guard dispatches the new
//       w8a8_dumma_prefill_packedb_db_kernel<256, 128, 64, 512, true>:
//         grid = ((N + 127)/128) x (M/256) = 21 x 16 = 336 blocks,
//         block = 512 threads = 8 gfx928 wavefronts,
//         a 64 x 64 quadrant of sixteen m16n16k32 int32 accumulator fragments
//         per wave (4 wave rows x 2 wave columns, the balanced square panel),
//         i.e. a 256 x 128 M-major operand-reuse macro-tile, 64-K
//         DOUBLE-buffered stages with ONE __syncthreads per stage and the
//         stage-(s+1) global loads issued into staging VGPRs before the stage-s
//         consume, k0-outer over 96 ascending 64-K stages with kk-inner
//         ascending m16n16k32 MMAs (exact int32 accumulation order of the
//         reference), and a fused branch-free per-row/column scale + bf16
//         epilogue emitting one coalesced 8-byte store per lane.
//       The A LDS tile uses the bank-safe 72-byte row stride (StageK + 8: an
//       odd 8-byte count, so the 16 rows of each 16-lane ds_read_b64 phase land
//       on 16 distinct bank pairs); the swizzled B tile is a flat BN x 64-byte
//       copy of the packed stage, so every col_major B fragment read is one
//       conflict-free ds_read_b64 (load_frag8_swz).
//       LDS = 2 x (A[256, 72] + B[128, 64]) = 2 x 18,432 + 2 x 8,192 =
//       53,248 B per block, so ONE resident block/CU = 8 waves/CU (the
//       two-operand global traffic falls from M*K*21 + N*K*32 = 1,044 MB to
//       M*K*21 + N*K*16 = 786 MB, -24.7%, at unchanged wave occupancy).
//   (3) the scalar int8/int32 fallback decodes the swizzled layout element-wise
//       in ascending kk for (k, n) == (6144, 2624), so the paired M=2 / M=16
//       API shapes with the same (N, K) stay byte-exact; the generic
//       single-buffered <64, 64, 128> identity arm covers every other large-M
//       shape with n % 64 == 0 and k % 128 == 0. The fallback is never replaced
//       by an unconditional shape-specialized launch.
//
// Correctness: the same weight elements reach the same fragment slots in the
// same ascending k-chunk sequence (k0-outer over 96 ascending 64-K stages,
// kk-inner ascending over two m16n16k32 steps, i.e. the identical (k0 + kk)
// k-chunk sequence 0, 32, 64, 96, ...), and the epilogue applies the exact
// reference multiply order float(dot) * x_scale[row] * weight_scale[col], so
// every bf16 output byte is bit-identical to the scalar reference. Widening BM
// only changes WHICH wave computes which output element; it never reorders the
// K stages or the int32 accumulation.
//
// Reported launch geometry for this round (iteration 4, tile shape):
//   grid_blocks         = 21 x 16 = 336
//   waves_per_block     = 512 / 64 = 8
//   estimated_active_cus = 120 (K500SM_AI has 120 CUs; 336 blocks with
//                          1 resident block/CU = 2.8 blocks/CU occupy every CU)
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
// Exact-shape packed-B prefill workgroup: 8 wavefronts = 512 threads, with the
// M-major operand-reuse macro-tile (BM=256 x BN=128) selected by the
// iteration-4 tile-shape round.
constexpr int kPackedThreads = 512;
constexpr int kPackedBM = 256;
constexpr int kPackedBN = 128;

// Exact assigned shape (K, N) after TP=8 partitioning.
constexpr int kExactN = 2624;
constexpr int kExactK = 6144;

using namespace du::dumma;

// Branch-free round-to-nearest-even fp32 -> bf16 high-16 payload:
//   bf16 = (b + 0x7fff + ((b >> 16) & 1)) >> 16,   b = __float_as_uint(v)
// For every FINITE fp32 this is exactly the normal path of __float2bfloat16,
// while dropping the ~13-instruction EXEC-bracketed Inf/NaN sequence this DTK
// emits for the library call (adding 0x7fff + the retained bit-16 LSB cannot
// carry out of the sign; the +((b>>16)&1) term rounds exact ties to an even
// LSB, max-float still rounds to +/-Inf and +/-0.0/subnormal payloads are
// preserved). Everything converted here is finite by construction: |int32 dot|
// < 2^31 and the dequantization scales are finite.
__device__ __forceinline__ unsigned int bf16_rne_high16(float v) {
  const unsigned int b = __float_as_uint(v);
  return (b + 0x7fffu + ((b >> 16) & 1u)) >> 16;
}

// Fused per-row/per-column dequantization + bf16 epilogue for the m16n16k32
// int32 accumulator of gfx928 INT8 DUMMA. Accumulator lane mapping:
//   row = lane & 15, col_mod4 = lane >> 4, frag.x[i] -> column col_mod4 + 4*i.
// A register 4x4 transpose (two 2x2 steps via shfl_xor 16 then 32) re-routes
// the values so lane (r, c4) owns the four CONTIGUOUS columns base_col +
// 4*c4 .. +3, which are then scaled in the exact reference order
// float(dot) * x_scale[row] * weight_scale[col], rounded to bf16 and stored
// with ONE 8-byte store per lane. base_col is a multiple of 64 for the
// dispatched tiles, so the float4 weight_scale load (col0 % 4 == 0) and the
// 8-byte store are both aligned. The row >= m guard is wavefront-uniform
// (lane & 15 cycles the same 16 rows in each 16-lane group), so the shuffles
// never mix active and inactive lanes.
//
// kGuarded == false is the exact-shape full-tile specialization (m % BM == 0):
// every row of every block tile is strictly inside the output, so the dead
// `row >= m` EXEC bracket around each of the eight unrolled stores is removed
// at compile time. The default kGuarded == true keeps the exact guarded
// semantics for every other m.
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

  // Lane (r, c4) now owns columns base_col + 4*c4 .. +3 (8 B, 8-byte aligned:
  // base_col is a multiple of 64 and n*2 is a multiple of 8).
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

// Explicit 8-byte int8 fragment loader for BOTH the row_major matrix_a and the
// col_major matrix_b m16n16k32 fragments: lane l -> row (l & 15), k-quarter
// (l >> 4) holds the EIGHT CONTIGUOUS bytes at p[row * ldm + (l >> 4) * 8 .. +7].
// Loading the 8 bytes as one int64 forces the ds_read_b64 form (16-lane phases,
// distinct bank pairs per group -> the 4-phase conflict-free floor with an odd
// 8-byte LDS row stride), identical fragment values to the library loader, so
// the v_mmac inputs and the exact int32 accumulation order are unchanged.
// `lane` is threadIdx.x % kWaveSize, so no wave-id builtin is required.
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

// Fragment-interleaved B swizzle helpers.
//
// Each 32-k x 16-n DUMMA B fragment block is 512 B = [k8 0..3][n 0..15][8 B]
// (n-interleaved k8 groups). The 16-byte chunk (k32, n16, k8, n_pair) holds the
// two 8-byte k-runs of n-rows 2*n_pair and 2*n_pair+1 of one k8 group, and sits
// at byte (k32 * n16g + n16) * 512 + k8 * 128 + n_pair * 16 of the packed
// [n>>4][k>>5][512 B] array (n16g = n>>4). Global elements satisfy
// packed element (col, kk) at ((kk>>5)*n16g + (col>>4))*512 +
// (((kk>>3)&3)*16 + (col&15))*8 + (kk&7) -- the exact inverse of this chunk
// map, so staging is a flat 16-byte copy and the fragment load reads the same
// bytes the library col_major loader consumes.
__device__ __forceinline__ int64_t packed_b_swz_offset(
    int k32,
    int n16,
    int n16g,
    int k8,
    int n_pair) {
  return (static_cast<int64_t>(k32) * n16g + n16) * 512 +
         static_cast<int64_t>(k8) * 128 + (n_pair << 4);
}

// col_major B fragment loader on the swizzled tile: lane (n = lane&15,
// k8 = lane>>4) reads p + k8*128 + n*8. One ds_read_b64 per fragment and each
// 16-lane phase spans exactly one 128-byte k8 block (each bank exactly once),
// so the read is conflict-free by construction. Byte placement is identical to
// load_frag8, so the v_mmac operands and the int32 accumulation stay bit-exact.
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

// Tile-shape round: balanced per-wave quadrant. Pick kWaveRows (hence
// kWaveCols = kWaves / kWaveRows) so that the wave's m16n16k32 panel
// (kWaveM16 x kWaveN16 fragments) is as square as possible. A square panel
// minimises the LDS fragment reads per v_mmac, (kWaveM16 + kWaveN16) reads for
// kWaveM16 * kWaveN16 MMAs, and keeps the live operand fragment set -- and
// therefore the VGPR bill of the 16-accumulator M-major macro-tile -- small.
// The search is restricted to exact divisor splits of both the tile fragment
// counts and the wave count so the kernel's quadrant arithmetic stays valid;
// for the retained 128 x 128 / 8-wave geometry it reproduces the historical
// 2 wave rows x 4 wave columns split exactly.
__host__ __device__ constexpr int balanced_wave_rows(int bm_frags,
                                                     int bn_frags,
                                                     int waves) {
  int best_rows = 1;
  int best_diff = 1 << 30;
  for (int rows = 1; rows <= waves; ++rows) {
    if (waves % rows != 0) continue;
    if (bm_frags % rows != 0) continue;
    const int cols = waves / rows;
    if (bn_frags % cols != 0) continue;
    const int m16 = bm_frags / rows;
    const int n16 = bn_frags / cols;
    const int diff = (m16 > n16) ? (m16 - n16) : (n16 - m16);
    if (diff < best_diff) {
      best_diff = diff;
      best_rows = rows;
    }
  }
  return best_rows;
}

// Generic native INT8 DUMMA m16n16k32 tiled prefill kernel with the identity
// [K, N] weight layout (packed_weight == raw logical weight for every (K, N)
// other than the exact assigned pair). Template parameters: BM x BN output tile
// per block, StageK K rows per single-buffered LDS stage. 256 threads =
// 4 wavefronts; each wave owns a (BM/2) x (BN/2) quadrant of m16n16k32 int32
// accumulator fragments. Grid = (N/BN) x (ceil(M/BM)).
//
// K is staged cooperatively in a SINGLE LDS buffer at StageK granularity with
// TWO __syncthreads per stage. Fragment loads use the library
// du_load_matrix_sync (row_major for both operands) and accumulate with
// du_mma_sync in ascending k order -- k0-outer over stages, kk-inner over
// kTileK steps -- preserving the exact int32 accumulation order of the scalar
// reference. The epilogue is the coalesced fragment store above.
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

// Exact-shape A-staging load. For the dispatched M=4096 every 256-row block
// tile lies fully inside the output, so the `(g_row < m)` row guard is dead:
// the exact code object would otherwise lower it to unconditional zero-fills
// plus EXEC save/restore uniform-branch pairs per K stage, i.e. dead
// instructions and an EXEC serialization in front of the very
// global_load_dwordx4s that prefetch the next tile. The kFullTile
// instantiation removes the select (one coalesced load per staging vector, no
// zero-fill), while kFullTile == false keeps the zero-fill + row mask
// semantics identical for every m % BM != 0.
template <bool kFullTile>
__device__ __forceinline__ int4 load_a_stage_vec(
    const int8_t* __restrict__ p,
    int m,
    int g_row) {
  if (kFullTile) {
    return *reinterpret_cast<const int4*>(p);
  }
  return (g_row < m) ? *reinterpret_cast<const int4*>(p) : int4{0, 0, 0, 0};
}

// Exact-shape A-staging load through the GLOBAL (non-generic) address form:
// the caller passes the kernel's `x_q` base plus the per-stage byte offset, so
// the load visits exactly the same bytes as the pointer form but through the
// global address space (global_load_dwordx4) instead of the generic
// flat_load_dwordx4 path the pointer form lowers to. Used only by the
// exact-shape full-tile instantiation.
__device__ __forceinline__ int4 load_a_stage_vec_global(
    const int8_t* __restrict__ x_q,
    int64_t offset) {
  return *reinterpret_cast<const int4*>(x_q + offset);
}

// Double-buffered packed-B prefill kernel, dispatched ONLY for
// (m >= 128, n == 2624, k == 6144). Geometry: grid ((N+127)/128) x (M/256) =
// 21 x 16 = 336 blocks, 512 threads = 8 wavefronts, and each wave owns a
// kRowsPerWave x kColsPerWave = 64 x 64 quadrant of sixteen m16n16k32 int32
// accumulator fragments (wave_row = wave / kWaveCols, wave_col = wave %
// kWaveCols, with the balanced 4 x 2 row/column split chosen by
// balanced_wave_rows), so the block macro-tile is BM x BN = 256 x 128.
//
// OPERAND REUSE (the mandated comparison). Per macro-tile every staged A
// element is consumed by the TWO wave columns (A reuse 2) and every staged B
// element by the FOUR wave rows (B reuse 4). Direct per-wave global fragment
// loads cannot replace the LDS stage: a row_major matrix_a fragment phase is
// lane (row = lane & 15, kq = lane >> 4), so 16 lanes touch 16 rows that are
// K = 6,144 B apart -- 16 x 32 B sectors for 128 useful bytes, a 4x fetch
// amplification -- and the swizzled col_major matrix_b fragments would lose
// their on-chip reuse and multiply their fetch. Global REUSE is the lever, so
// the M-major macro-tile is widened to BM = 256: A is read once per 128-column
// tile (21 re-reads) and B once per 256-row tile (16 re-reads), for a total
// global traffic of M*K*21 + N*K*16 = 786 MB against the 128 x 128 tile's
// 1,044 MB (-24.7%), at the same 8 waves/CU. The staging loads stay
// vectorized/coalesced 16-byte-per-thread and the A LDS stride stays the
// bank-safe 72 B with the flat swizzled B tile. The odd N = 20*128 + 64 is
// covered by clamping the column tile origin to n - BN, so the last block
// recomputes 64 overlapping columns (identical int32 accumulation and identical
// bf16 bytes) instead of predicating a partial tile; every staged B chunk
// therefore addresses a valid n16 group of the packed weight.
//
// The K pipeline is a 64-K DOUBLE-buffered stage: the stage-(s+1) global loads
// are issued into 2 int4 staging registers per thread BEFORE the stage-s consume
// and flushed into the idle LDS buffer after it, so the VMEM latency of stage
// s+1 overlaps the LDS/v_mmac work of stage s (one __syncthreads per stage
// instead of two). k0-outer runs over 96 ASCENDING 64-K stages with kk-inner
// ascending over two m16n16k32 steps, i.e. the same (k0 + kk) k-chunk sequence
// 0, 32, 64, ... as any other staging, so every int32 accumulator is
// bit-identical.
//
// kLdsStride = StageK + 8 = 72 B: 8-aligned with an odd 8-byte count (9) so the
// 16 rows of each 16-lane ds_read_b64 phase land on 16 distinct bank pairs
// (18r mod 32, r = 0..15) -- the conflict-free 4-phase floor -- and
// 72 % 16 == 8 keeps the two-half ds_write2_b64 staging form.
//
// The packed B operand is the fragment-interleaved swizzle (see
// w8a8_pack_bswz_i8_kernel): the LDS b_tile is the SAME [k32][n16][k8][n][8]
// layout as the pack (2 x (BN/16) 512-byte fragment blocks per 64-K stage), so
// staging is one flat 16-byte copy per thread and each col_major B fragment is
// one conflict-free ds_read_b64 (load_frag8_swz). The int32 accumulation order
// is untouched.
//
// kFullTile is true exactly when the caller's m is a multiple of BM, so every
// block tile is fully inside the output; in that instantiation the A staging
// loads drop the row guard and the epilogue drops the per-fragment row mask.
template <int BM, int BN, int StageK, int kBlockThreads, bool kFullTile = false>
__global__ __launch_bounds__(kBlockThreads) void
w8a8_dumma_prefill_packedb_db_kernel(
    const int8_t* __restrict__ x_q,          // [M, K] row-major
    const int8_t* __restrict__ packed_w,     // [n>>4][k>>5][512 B] swizzled B
                                             // fragment blocks
    const float* __restrict__ x_scale,       // [M]
    const float* __restrict__ weight_scale,  // [N]
    hip_bfloat16* __restrict__ out,          // [M, N]
    int m,
    int n,
    int k) {
  constexpr int kWaves = kBlockThreads / kWaveSize;  // 8
  // Balanced, tile-aware wave split: 4 wave rows x 2 wave columns for the
  // 256 x 128 macro-tile, i.e. a square 64 x 64 per-wave quadrant.
  constexpr int kWaveRows =
      balanced_wave_rows(BM / kTileM, BN / kTileN, kWaves);  // 4
  constexpr int kWaveCols = kWaves / kWaveRows;              // 2
  constexpr int kRowsPerWave = BM / kWaveRows;       // 64
  constexpr int kColsPerWave = BN / kWaveCols;       // 64
  constexpr int kWaveM16 = kRowsPerWave / kTileM;    // 4
  constexpr int kWaveN16 = kColsPerWave / kTileN;    // 4
  static_assert(kWaveRows * kWaveCols == kWaves,
                "wave split must tile the block exactly");
  static_assert(BM % kWaveRows == 0 && BN % kWaveCols == 0,
                "block tile must be a multiple of the wave quadrant");
  static_assert(kBlockThreads % kWaveSize == 0,
                "blockDim must be a multiple of the gfx928 wavefront size");
  constexpr int kLdsStride = StageK + 8;
  static_assert(kLdsStride % 8 == 0 && (kLdsStride / 8) % 2 == 1,
                "LDS row stride must be 8-aligned with an odd 8-byte count");
  static_assert(kLdsStride % 16 == 8,
                "LDS row stride must be 8 mod 16 for the two-half staging");
  // The packed B weight is the fragment-interleaved swizzle: one 32-k x 16-n
  // fragment block per 512 B; a 64-K stage holds 2 k32 blocks x (BN/16) n16
  // groups x 4 k8 groups x 8 n-pairs = BN*4 16-byte chunks. With 512 threads
  // and BN = 128 that is exactly one chunk per thread.
  static_assert(StageK == 64, "swizzled B pack requires StageK == 64");
  static_assert(BN % 16 == 0, "swizzled B pack requires BN % 16 == 0");

  const int tid = static_cast<int>(threadIdx.x);
  const int wave = tid / kWaveSize;
  const int lane = tid % kWaveSize;
  const int wave_row = wave / kWaveCols;  // 0 .. kWaveRows-1
  const int wave_col = wave % kWaveCols;  // 0 .. kWaveCols-1
  const int m0 = static_cast<int>(blockIdx.y) * BM;
  // Clamp the column origin so the odd (n % BN) columns are covered by an
  // overlapping tile: every staged B chunk then addresses a valid n16 group of
  // the packed weight, and the duplicated columns recompute byte-identically.
  const int n0i = static_cast<int>(blockIdx.x) * BN;
  const int n0 = (n0i + BN <= n) ? n0i : (n - BN);
  const int kStages = k / StageK;  // dispatch guarantees k % StageK == 0
  const int n16g = n >> 4;         // 16-n row groups per 32-k block of the pack

  __shared__ __align__(16) int8_t a_tile[2][BM * kLdsStride];
  // Swizzled B tile: flat [k32][n16][k8][n_pair][16 B], byte-identical to the
  // packed global layout of that stage: 2 x (BN/16) x 512 = BN x 64 B.
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

  // Flat 16-byte staging vectors per stage. For the dispatched
  // <256, 128, 64, 512> instantiation the 1024 A vectors (2 per thread) and the
  // 512 B vectors (1 per thread) map exactly onto the 512 threads, so the
  // prefetch payload is 3 int4 staging registers held live across the consume.
  constexpr int kVecsPerRow = StageK / static_cast<int>(sizeof(int4));
  constexpr int kAVectors = BM * StageK / static_cast<int>(sizeof(int4));
  constexpr int kBVectors = StageK * BN / static_cast<int>(sizeof(int4));
  constexpr int kAVecPerThread = kAVectors / kBlockThreads;
  constexpr int kBVecPerThread = kBVectors / kBlockThreads;
  static_assert(kAVectors % kBlockThreads == 0 &&
                    kBVectors % kBlockThreads == 0,
                "staging vectors must divide evenly across the block");
  // The swizzled B stage is exactly one 16-byte chunk per thread, so thread
  // `vec` = tid is also the flat [k32][n16][k8][n_pair] chunk index.
  static_assert(kBVecPerThread == 1 && kBVectors == kBlockThreads,
                "swizzled B staging must be one 16-B chunk per thread");

  int4 a_pre[kAVecPerThread];
  int4 b_pre[kBVecPerThread];

  // Per-thread GLOBAL staging byte pointers, held as loop-carried induction
  // variables: the prologue loads stage 0 from them, they are then advanced to
  // stage 1, and every steady-state iteration issues its prefetch from them and
  // walks them by the compile-time stage stride -- StageK bytes for A and one
  // 64-K swizzle band `(StageK>>5)*n16g*512` for B.
  const int8_t* a_src[kAVecPerThread];
  int a_grow[kAVecPerThread];
#pragma unroll
  for (int v = 0; v < kAVecPerThread; ++v) {
    const int vec = tid + v * kBlockThreads;
    const int local_row = vec / kVecsPerRow;
    const int k16 = vec - local_row * kVecsPerRow;
    a_grow[v] = m0 + local_row;
    a_src[v] = x_q + static_cast<int64_t>(a_grow[v]) * k + k16 * 16;
  }
  const int8_t* b_src[kBVecPerThread];
#pragma unroll
  for (int v = 0; v < kBVecPerThread; ++v) {
    // Chunk (k32, n16, k8, n_pair) of the stage: BN*2 chunks per k32 block
    // (4 k8 groups x 8 n-pairs per n16), 32 chunks per n16 group.
    const int vec = tid + v * kBlockThreads;
    const int k32 = vec / (BN * 2);
    const int rem = vec - k32 * (BN * 2);
    b_src[v] = packed_w +
               packed_b_swz_offset(
                   k32, (n0 >> 4) + ((rem >> 5) & (BN / 16 - 1)), n16g,
                   (rem >> 3) & 3, rem & 7);
  }

  // ---- Prologue: issue the stage-0 global loads, flush them into buffer 0 and
  // make the tile visible to every wavefront.
  {
#pragma unroll
    for (int v = 0; v < kAVecPerThread; ++v) {
      const int vec = tid + v * kBlockThreads;
      const int local_row = vec / kVecsPerRow;
      const int k16 = vec - local_row * kVecsPerRow;
      const int g_row = m0 + local_row;
      if (kFullTile) {
        // Exact-shape full-tile A staging through the global (non-generic)
        // address form -- the same bytes as the pointer form, but through the
        // load path that emits global_load_dwordx4.
        a_pre[v] = load_a_stage_vec_global(
            x_q, static_cast<int64_t>(g_row) * k + k16 * 16);
      } else {
        a_pre[v] = load_a_stage_vec<kFullTile>(a_src[v], m, a_grow[v]);
      }
    }
#pragma unroll
    for (int v = 0; v < kBVecPerThread; ++v) {
      // The 16-byte chunk (k32 = vec/(BN*2), n16 = (vec>>5)&(BN/16-1),
      // k8 = (vec>>3)&3, n_pair = vec&7) of the swizzled pack sits at byte
      // (k0>>5 + k32)*n16g*512 + ((n0>>4)+n16)*512 + k8*128 + n_pair*16; the
      // per-thread pointer already carries the k32/n16/k8/n_pair part for
      // k0 == 0. Consecutive lanes read consecutive 16-byte chunks, so a warp's
      // staging loads touch 8 fully-used 128-byte lines.
      b_pre[v] = *reinterpret_cast<const int4*>(b_src[v]);
    }
#pragma unroll
    for (int v = 0; v < kAVecPerThread; ++v) {
      const int vec = tid + v * kBlockThreads;
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
      const int vec = tid + v * kBlockThreads;
      // The swizzled tile is a flat copy of the packed stage, so the commit is
      // ONE 16-byte-aligned int4 (ds_write_b128) per thread.
      *reinterpret_cast<int4*>(b_tile[0] + vec * 16) = b_pre[v];
    }
  }
  __syncthreads();

  // Advance the staging pointers to stage 1. From here on every steady-state
  // half prefetches stage s+1 from these pointers and then walks them by the
  // compile-time stage stride, so both global staging addresses are pure
  // pointer increments instead of a per-stage address expression.
  const int64_t b_step = static_cast<int64_t>(StageK >> 5) * n16g * 512;
#pragma unroll
  for (int v = 0; v < kAVecPerThread; ++v) {
    a_src[v] += StageK;
  }
#pragma unroll
  for (int v = 0; v < kBVecPerThread; ++v) {
    b_src[v] += b_step;
  }

  // ---- Steady state (double-buffer parity specialization). For stage s, issue
  // the stage-(s+1) global loads into the staging registers BEFORE consuming
  // stage s from buffer s&1, then flush the prefetched vectors into the idle
  // buffer (s+1)&1 and close the stage with ONE __syncthreads (so the vmcnt wait
  // for stage s+1 lands after the MMAC burst of stage s, overlapping the VMEM
  // latency of s+1 with the stage-s LDS/v_mmac work). The last stage is consumed
  // after the loop without a trailing barrier.
  //
  // Walking the stages in compile-time PAIRS makes each half's parity a
  // constant (s = 2*sp + h with h unrolled, so s & 1 == h and (s+1) & 1 == h^1),
  // which folds the double-buffer parity offsets into the per-half LDS base
  // registers / instruction immediates. The odd leftover for the dispatched
  // k = 6144 (kStages = 96 -> kSteady = 95, one unpaired stage) is guarded by ONE
  // uniform compare in the second half of the last pair, so correctness does not
  // depend on the unroll succeeding.
  const int kSteady = kStages - 1;
  const int kPairIters = (kSteady + 1) >> 1;
  for (int sp = 0; sp < kPairIters; ++sp) {
#pragma unroll
    for (int h = 0; h < 2; ++h) {
      const int s = 2 * sp + h;
      if (h == 0 || s < kSteady) {
        // Compile-time buffer parity: cur == s & 1, nxt == (s + 1) & 1.
        const int cur = h;
        const int nxt = h ^ 1;
        // Prefetch stage s+1: issue the global loads (held in VGPRs while the
        // stage-s consume runs) from the loop-carried per-thread stage
        // pointers, which already sit at the stage-(s+1) addresses. The
        // exact-shape full-tile instantiation forms the two A staging addresses
        // in the `x_q + <int64 affine offset>` global form (so the backend
        // keeps the non-generic global_load path), while B keeps the
        // loop-carried staging pointer.
        const int k0 = (s + 1) * StageK;
#pragma unroll
        for (int v = 0; v < kAVecPerThread; ++v) {
          const int vec = tid + v * kBlockThreads;
          const int local_row = vec / kVecsPerRow;
          const int k16 = vec - local_row * kVecsPerRow;
          const int g_row = m0 + local_row;
          if (kFullTile) {
            a_pre[v] = load_a_stage_vec_global(
                x_q, static_cast<int64_t>(g_row) * k + k0 + k16 * 16);
          } else {
            a_pre[v] = load_a_stage_vec<kFullTile>(a_src[v], m, a_grow[v]);
          }
        }
#pragma unroll
        for (int v = 0; v < kBVecPerThread; ++v) {
          // One plain 16-byte staging load per thread from the stage-(s+1)
          // swizzle chunk; consecutive lanes read consecutive 16-byte chunks,
          // so a warp's staging loads touch 8 fully-used 128-byte lines.
          b_pre[v] = *reinterpret_cast<const int4*>(b_src[v]);
        }

        // Consume stage s from buffer cur: each wave accumulates its
        // kRowsPerWave x kColsPerWave quadrant with kk-ascending m16n16k32 MMAs;
        // one ds_read_b64 per fragment.
        const int local_row = wave_row * kRowsPerWave;
#pragma unroll
        for (int kk = 0; kk < StageK; kk += kTileK) {
#pragma unroll
          for (int j = 0; j < kWaveM16; ++j) {
            load_frag8(
                a_frag[j],
                a_tile[cur] + (local_row + j * kTileM) * kLdsStride + kk,
                static_cast<unsigned>(kLdsStride),
                lane);
          }
#pragma unroll
          for (int i = 0; i < kWaveN16; ++i) {
            // Fragment block (k32 = kk>>5, n16 = wave_col*kWaveN16 + i) of the
            // swizzled tile -- 512 B per 16-n x 32-k DUMMA B fragment, one
            // conflict-free ds_read_b64 per lane.
            load_frag8_swz(
                b_frag[i],
                b_tile[cur] +
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

        // Flush the prefetched stage-(s+1) vectors into the idle buffer nxt.
        {
#pragma unroll
          for (int v = 0; v < kAVecPerThread; ++v) {
            const int vec = tid + v * kBlockThreads;
            const int local_row = vec / kVecsPerRow;
            const int k16 = vec - local_row * kVecsPerRow;
            const int64_t* src64 = reinterpret_cast<const int64_t*>(&a_pre[v]);
            int64_t* dst64 = reinterpret_cast<int64_t*>(
                a_tile[nxt] + local_row * kLdsStride + k16 * 16);
            dst64[0] = src64[0];
            dst64[1] = src64[1];
          }
#pragma unroll
          for (int v = 0; v < kBVecPerThread; ++v) {
            const int vec = tid + v * kBlockThreads;
            // Flat 16-byte swizzled-tile commit (ds_write_b128).
            *reinterpret_cast<int4*>(b_tile[nxt] + vec * 16) = b_pre[v];
          }
        }
        // Walk the loop-carried staging pointers to the next stage. StageK is a
        // compile-time constant, so each A pointer advances with a single 64-bit
        // add pair; b_step is the loop-invariant swizzle band.
#pragma unroll
        for (int v = 0; v < kAVecPerThread; ++v) {
          a_src[v] += StageK;
        }
#pragma unroll
        for (int v = 0; v < kBVecPerThread; ++v) {
          b_src[v] += b_step;
        }
        __syncthreads();
      }
    }
  }

  // ---- Tail: consume the last stage (its data was flushed before the last
  // barrier; no trailing barrier needed).
  {
    const int s = kStages - 1;
    const int local_row = wave_row * kRowsPerWave;
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

  const int base_row = m0 + wave_row * kRowsPerWave;
  const int base_col = n0 + wave_col * kColsPerWave;
#pragma unroll
  for (int j = 0; j < kWaveM16; ++j) {
#pragma unroll
    for (int i = 0; i < kWaveN16; ++i) {
      // kGuarded == !kFullTile -- the full-tile instantiation skips the dead
      // per-fragment `row >= m` EXEC bracket.
      store_prefill_fragment_coalesced<!kFullTile>(
          acc[j][i], x_scale, weight_scale, out, m, n,
          base_row + j * kTileM, base_col + i * kTileN, lane);
    }
  }
}

// Generic scalar int8/int32 fallback for unmatched shapes and small-M API
// cases (including the paired M=2 and M=16 shapes with the same (N, K) -- they
// never reach the m >= 128 tiled/packed paths). One output element per
// grid-stride step; exact int32 accumulation (max assigned K = 6144 keeps the
// int8 dot well within int32 range: |dot| <= 6144*127*127 < 2^31), then the
// fused float scale (dot * x_scale[m] * weight_scale[n]) and a manual uint16
// bf16 store.
//
// For the exact (k, n) == (6144, 2624) the packed_weight buffer holds the
// fragment-interleaved swizzle (produced once, outside the timed region), so
// the fallback decodes that layout there with ascending kk (every other (K, N)
// keeps the identity [K, N] row-major copy):
//   packed[((kk>>5)*n16g + (col>>4))*512 +
//          (((kk>>3)&3)*16 + (col&15))*8 + (kk&7)],  n16g = n>>4,
// element-by-element in ascending kk -- identical elements, identical int32
// accumulators, so the paired M=2 / M=16 API shapes stay byte-exact.
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
      // Swizzle: one 8-byte k-run per (n, k8) inside a 512-byte 32-k x 16-n
      // fragment block; walk it in ascending kk.
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

// Exact-shape fragment-interleaved B swizzle: for (k, n) == (6144, 2624) the
// weight is packed once, outside the timed region and out of Graph capture,
// into 512-byte 32-k x 16-n DUMMA B fragment blocks laid out [k32][n16][k8][n][8]:
//   packed[((kk >> 5) * n16g + (n >> 4)) * 512 +
//          (((kk >> 3) & 3) * 16 + (n & 15)) * 8 + (kk & 7)] = raw[kk * n + n],
// where n16g = n >> 4 (164 for the exact shape). This is a byte-exact bijection
// 192 x 164 x 512 = k*n = 16,121,856: same byte count and buffer as the identity
// pack, so captured addresses are unchanged. Each thread packs one 16-byte chunk
// = the 8-byte k-runs of two n-rows of one k8 group (a strided 2x8 gather on the
// read side; packing is outside timing, so the gather is off the critical
// path). Consecutive chunks are consecutive packed bytes, so the kernel's B
// staging is a flat 16-byte copy and every col_major B fragment read is one
// conflict-free ds_read_b64 (see load_frag8_swz).
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
      // 16-byte chunk = [n0 row: k0..k0+7][n0+1 row: k0..k0+7] (n-major within
      // the k8 group, matching the [k8][n][8] tile layout).
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
// caller-provided stream only; never allocates, synchronizes, packs, or touches
// the default stream. The workspace is unused for this shape (no split-K):
// m*n*4 = 42,990,080 B exceeds the 16 MiB workspace budget, so
// workspace_split_k_capacity(m, n, k) is zero.
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
  // (M=4096, N=2624, K=6144). The m >= 128 guard keeps the paired M=2/M=16 API
  // shapes with the same (N, K) on the scalar fallback below. M = 16*256 is
  // exact and N = 2624 = 20*128 + 64 is covered by clamping the last column
  // tile origin to n - 128, so every block still stages a full 128-column B
  // macro-tile and no B chunk ever leaves the packed weight. The compile-time
  // kFullTile specialization is selected when m is a multiple of BM = 256, and
  // every other m with this (n, k) keeps the guarded instantiation.
  if (m >= 128 && n == kExactN && k == kExactK) {
    const dim3 grid(
        static_cast<unsigned>((n + kPackedBN - 1) / kPackedBN),
        static_cast<unsigned>((m + kPackedBM - 1) / kPackedBM));
    const dim3 block(static_cast<unsigned>(kPackedThreads));
    if ((m % kPackedBM) == 0) {
      hipLaunchKernelGGL(
          HIP_KERNEL_NAME(
              w8a8_dumma_prefill_packedb_db_kernel<
                  kPackedBM, kPackedBN, 64, kPackedThreads, true>),
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
              w8a8_dumma_prefill_packedb_db_kernel<
                  kPackedBM, kPackedBN, 64, kPackedThreads, false>),
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
  // zero-fills rows past M and the epilogue masks them, so only the exact shape
  // above avoids predication.
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

// Stable host launch symbol consumed by csrc/bindings.cpp. The exact
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
    // One thread packs one 16-byte chunk (16 bytes = 2 n-rows x 8 B).
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
