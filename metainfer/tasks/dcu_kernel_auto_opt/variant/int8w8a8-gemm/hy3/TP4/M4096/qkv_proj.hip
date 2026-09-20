// @@variant shape=hy3_tp4_qkv_proj_m4096 commit=2eebb654a8b34a0ec8bdca109fa8daef07be1e91 added=2026-09-14
//   median_us=625.3 p90_us=626.8 speedup=38.45 baseline_us=2.405e+04
//   source=test-9-11-1/iteration_002/hy3_tp4_qkv_proj_m4096 (retested A/B)
// MetaInfer W8A8 INT8 GEMM for gfx928 (K500SM_AI), CHILD worker_0.
//
// Assigned shape (iteration 1 / establish_arch round, packed_weight family):
//   hy3_tp4_qkv_proj_m4096 : M=4096, N=2560, K=4096
//
// Frozen logical contract (validated in int8_w8a8_gemm_api.py):
//   out[m, n] = bf16( int32_dot(x_q[m, :], weight[:, n])
//                     * x_scale[m] * weight_scale[n] )
// The bootstrap packed weight was the logical [K, N] row-major int8 weight
// (identity copy). This session keeps that layout for every shape except the
// exact assigned pair (K=4096, N=2560), which launch_pack_w8a8_weight packs
// once (outside the timed region and outside Graph capture) into the
// 16-byte-chunk layout packed16[(k/16) * N + n] with the same k*n byte count.
//
// Strategy: native INT8 DUMMA m16n16k32 tiled kernel with int32 accumulation.
//   * Large-M generic path (m >= 128, n % 128 == 0, k % 64 == 0): one 64x128
//     output macro-tile per block, 256 threads = 4 gfx928 wavefronts of 64
//     lanes. Each wave owns a 32x64 quadrant = eight m16n16k32 int32
//     accumulator fragments (2 row halves x 4 column quarters). K is staged
//     cooperatively in a SINGLE LDS buffer at 64-K granularity, consumed by a
//     32-K unrolled fragment/MMA loop. Exactly two __syncthreads per stage;
//     no split-K, no double buffering, no raw asm.
//   * Exact-shape path (m >= 128, n == 2560, k == 4096): the SAME 64x128
//     macro-tile / 4-wavefront / single-buffered-64-K geometry, but B is
//     packed 16-byte-chunk and consumed with one ds_read2_b64 per m16n16k32
//     fragment instead of eight ds_read_u8. Measured motivation (PMC on the
//     bootstrap digest): lds_wait_instructions 42,668,821 = 1.76x
//     lds_instructions (24,248,320), lds_bank_conflicts 7,864,320 = 32% of
//     LDS instructions -> the LDS pipe is the dominant stall class at
//     99.6 TOPS, and the byte-granular row-major B fragment loads are the
//     primary contributor.
//   * Grid for the assigned shape: (2560 / 128) x (4096 / 64) = 20 x 64 =
//     1280 blocks, 4 waves/block, 13,568 B LDS/block -> 3 resident
//     blocks/CU on the 120-CU K500SM_AI.
//   * Scalar int8/int32 grid-stride fallback for every unmatched (m, n, k)
//     and for small-M API cases (m < 128), which keeps the paired M=2 shape
//     on the fallback path; that fallback decodes the packed layout for the
//     exact (k, n) pair and the logical [K, N] layout otherwise.
//
// The timed operator (launch_w8a8_gemm) only dispatches kernels on the
// caller-provided HIP stream: it never allocates, compiles, autotunes, packs
// weights, synchronizes the host or device, or launches on the default stream.
// launch_pack_w8a8_weight performs the one-time exact-shape chunk packing
// and an identity copy for every other (K, N); both are outside Graph capture.
//
// Include order is fixed by the control plane: hip_runtime, then
// hip_bfloat16, then du_mma (this DTK's du_mma.h is not self-contained when
// included before the HIP runtime headers). Do not include du_mma_common.h.

#include <hip/hip_runtime.h>
#include <hip/hip_bfloat16.h>
#include <du_mma.h>

#include <cstdint>

namespace {

using namespace du::dumma;

// gfx928 native wavefront is 64 lanes; blockDim must be a multiple of 64.
constexpr int kWaveSize = 64;

// Native INT8 DUMMA shape.
constexpr int kTileM = 16;
constexpr int kTileN = 16;
constexpr int kTileK = 32;

// 64x128 macro-tile, single-buffered 64-K LDS stage, 4 wavefronts.
constexpr int kBlockM = 64;
constexpr int kBlockN = 128;
constexpr int kStageK = 64;
constexpr int kThreadsPerBlock = 256;

// Odd-word (4-byte-padded) LDS row strides: 17 and 33 words.
constexpr int kAStride = kStageK + 4;   // 68 bytes per A row
constexpr int kBStride = kBlockN + 4;   // 132 bytes per B row

// Iteration 2 (operand-reuse round) strategy: keep the accepted iteration-1
// cooperative A+B LDS staging decision and fix ONLY the packed B LDS layout to
// be bank-safe. Operand-reuse accounting per 64x128 macro-tile per 64-K stage
// (A[64,64] + B[64,128] = 12,288 staged bytes): the 2x2 wave grid reads every
// staged A element 2x and every staged B element 2x (48 m16n16k32 fragment
// loads per block stage, contiguous 512-byte fragments), i.e. the cooperative
// path moves 12,288 global bytes but only 2x that through LDS. Loading the
// DUMMA fragments directly from global would instead refetch both operands
// twice with 4,096-byte-strided (>32x uncoalesced) per-lane 8-byte addresses,
// so cooperative A+B staging is retained and only its LDS layout changes:
//   * the weight is now packed once (untimed, outside Graph capture) into a
//     16-byte-chunk layout packed16[(k/16) * N + n] holding
//     weight[16*(c/N) .. +15][c%N], same k*n byte count, so the GEMM's B
//     staging reads become 4 coalesced 256-byte runs per 64-lane wavefront
//     (consecutive lanes -> consecutive 16-byte chunks) at unchanged volume;
//   * the B LDS tile uses an 8-byte-aligned 72-byte (18-word) row stride and
//     the staging map lane = kq*16 + row4 (row4 = lane & 15 = n-row inside a
//     16-row group, kq = (lane >> 4) & 3 = 16-byte k-chunk), so both the
//     col_major m16n16k32 fragment read (n = lane & 15, k = 8*(lane>>4)+i; bank
//     = 18*row4 + 2*kq) and the staged commit at n_local*72 + 16*kq spread the
//     16-lane issue phase over 16 distinct even banks plus their odd
//     neighbours. The previous 80-byte (20-word) row stride left only 8
//     distinct banks per 16-row phase; the fresh PMC on the iteration-1 digest
//     records lds_bank_conflicts 23,592,960 over lds_instructions 3,932,160
//     (6.0 events per LDS read instruction), the largest LDS defect.
//   * the chunk commit is two alignment-provable 8-byte qword stores (the tile
//     is declared as int64_t), the fragment registers receive byte-identical
//     values, and the int32 k0-outer/kk-inner accumulation order is unchanged.
// LDS/block = 64*68 + 128*72 = 13,568 B; the 64x128 geometry, 256 threads /
// 4 wavefronts, single-buffered 64-K stage, two barriers per stage, 3
// blocks/CU occupancy, fused scale/bf16 epilogue, exact shape guards, the
// generic 64x128 fallback, the scalar fallback (which decodes the chunked
// layout for the exact (k, n)) and every other shape's path are unchanged.
//
// Iteration 3 (fix_build round): the iteration-2 candidate above failed to
// compile for exactly one reason -- launch_pack_w8a8_weight still referenced
// the removed w8a8_pack_nmajor_b_kernel symbol after the pack kernel was
// rewritten as w8a8_pack_k16chunk_b_kernel. The only change this round is
// rebinding that host call to the defined 16-byte-chunk pack kernel (plus
// comment text); the kernel bodies, geometry, guards and layouts are byte-for-
// byte the iteration-2 candidate.
//
// Iteration 1 (establish_arch round, packed_weight family) for the exact
// assigned shape (K=4096, N=2560): launch_pack_w8a8_weight transposed the
// logical [K, N] row-major weight once, outside the timed region and outside
// Graph capture, into an n-major layout with the SAME byte count (k*n), so
// allocation and graph-stable addresses are unchanged. Every DUMMA m16n16k32 B
// fragment collapsed to ONE contiguous 8-byte lane chunk (one ds_read2_b64)
// instead of eight byte-granular ds_read_u8 at the 132-byte row_major stride.
//
// Iteration 2 (operand-reuse round): the pack is now a 16-byte-chunk layout
// packed16[(k/16) * N + n] (chunk c = weight[16*(c/N) .. +15][c%N]) so the
// staging global reads are 4 coalesced 256-byte runs per wavefront, and the B
// LDS tile row stride becomes 72 bytes (18 words, 8-byte aligned) with the
// staging map lane = kq*16 + row4. A 16-row phase then touches 16 distinct
// even banks (18*row4) plus their odd neighbours instead of the 8 banks the
// 20-word stride produced, removing the measured 6.0 bank-conflict events per
// LDS read instruction (23,592,960 conflicts / 3,932,160 LDS instructions).
constexpr int kPackedBStride = 72;  // 64 data + 8 pad bytes (18 words)
constexpr int kPackedBWords = kPackedBStride / 8;  // 9 qwords per n-row
constexpr int kPackedBK = 4096;     // exact K of the packed assigned shape
constexpr int kPackedBN = 2560;     // exact N of the packed assigned shape

// Fallback launch geometry.
constexpr int kFallbackThreads = 256;
constexpr int kPackThreads = 256;

// Direct accumulator epilogue for the gfx928 INT8 m16n16k32 DUMMA lane
// mapping (verified against du_store_matrix_sync): row = lane & 15,
// col_mod4 = lane >> 4, and frag.x[i] maps to columns col_mod4 + 4*i. Stores
// bf16(float(dot) * x_scale[row] * weight_scale[col]); out-of-range rows are
// masked so a partial M tail is handled safely. Adjacent lanes stay on
// adjacent columns in the fastest-changing N dimension.
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
#pragma unroll
  for (int i = 0; i < 4; ++i) {
    const int col = base_col + col_mod4 + 4 * i;
    const float scaled = static_cast<float>(frag.x[i]) *
                         x_scale[row] * weight_scale[col];
    out[row * n + col] = __float2bfloat16(scaled);
  }
}

// Large-M prefill kernel: 64x128 output tile per block, single-buffered 64-K
// K stage, 256 threads / 4 wavefronts.
__global__ __launch_bounds__(kThreadsPerBlock) void
w8a8_dumma_prefill_64x128_kernel(
    const int8_t* __restrict__ x_q,
    const int8_t* __restrict__ weight,
    const float* __restrict__ x_scale,
    const float* __restrict__ weight_scale,
    hip_bfloat16* __restrict__ out,
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

  __shared__ __align__(16) int8_t a_tile[kBlockM * kAStride];
  __shared__ __align__(16) int8_t b_tile[kStageK * kBStride];

  DUFragment<matrix_a, kTileM, kTileN, kTileK, signed char, row_major>
      a_frag0, a_frag1;
  DUFragment<matrix_b, kTileM, kTileN, kTileK, signed char, row_major>
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

  const int num_stages = k / kStageK;

  // Cooperative staging mapping (fixed per thread, reused every stage):
  //   A[64, 64]  -> 256 int4 vectors; thread `tid` owns vector `tid`
  //                 (row = tid/4, 16-B column group = (tid%4)*16).
  //   B[64, 128] -> 512 int4 vectors; thread `tid` owns vectors `tid` and
  //                 `tid+256` (kk = tid/8, 16-B column group = (tid%8)*16),
  //                 i.e. kk rows 0..31 and 32..63.
  const int a_row = tid >> 2;
  const int a_col16 = (tid & 3) << 4;
  const int b_kk0 = tid >> 3;
  const int b_col16 = (tid & 7) << 4;

  // One-stage register payload (3 x int4 = 12 VGPR), loaded just before it is
  // committed; there is no stage-ahead overlap in this bootstrap.
  int4 vA, vB0, vB1;

  // Prologue: load stage 0 into registers, commit it to the single buffer,
  // and make it visible before the first burst.
  {
    const int g_row = m0 + a_row;
    vA = (g_row < m)
             ? *reinterpret_cast<const int4*>(x_q + g_row * k + a_col16)
             : int4{0, 0, 0, 0};
    vB0 = *reinterpret_cast<const int4*>(
        weight + b_kk0 * n + n0 + b_col16);
    vB1 = *reinterpret_cast<const int4*>(
        weight + (b_kk0 + kStageK / 2) * n + n0 + b_col16);
    // Commit as int32 stores: the odd-word strides leave the rows 4-byte but
    // not 16-byte aligned, so four ds_write_b32 per 16-byte vector.
    int32_t* adst = reinterpret_cast<int32_t*>(
        a_tile + a_row * kAStride + a_col16);
    adst[0] = vA.x;
    adst[1] = vA.y;
    adst[2] = vA.z;
    adst[3] = vA.w;
    int32_t* bdst0 = reinterpret_cast<int32_t*>(
        b_tile + b_kk0 * kBStride + b_col16);
    bdst0[0] = vB0.x;
    bdst0[1] = vB0.y;
    bdst0[2] = vB0.z;
    bdst0[3] = vB0.w;
    // kBStride is a whole number of int32 words, so the second half-row is
    // exactly (kStageK/2) rows away.
    int32_t* bdst1 = bdst0 + (kStageK / 2) * (kBStride / 4);
    bdst1[0] = vB1.x;
    bdst1[1] = vB1.y;
    bdst1[2] = vB1.z;
    bdst1[3] = vB1.w;
    __syncthreads();
  }

  for (int s = 0; s < num_stages; ++s) {
    // Consume the single buffer: each wave does eight m16n16k32 MMAs per
    // 32-K step over its own 32x64 quadrant.
    const int local_row = wave_row * 32;
    const int local_col = wave_col * 64;
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
      du_load_matrix_sync(
          b_frag2, b_tile + kk * kBStride + local_col + 2 * kTileN, kBStride);
      du_load_matrix_sync(
          b_frag3, b_tile + kk * kBStride + local_col + 3 * kTileN, kBStride);
      du_mma_sync(acc00, a_frag0, b_frag0, acc00);
      du_mma_sync(acc01, a_frag0, b_frag1, acc01);
      du_mma_sync(acc02, a_frag0, b_frag2, acc02);
      du_mma_sync(acc03, a_frag0, b_frag3, acc03);
      du_mma_sync(acc10, a_frag1, b_frag0, acc10);
      du_mma_sync(acc11, a_frag1, b_frag1, acc11);
      du_mma_sync(acc12, a_frag1, b_frag2, acc12);
      du_mma_sync(acc13, a_frag1, b_frag3, acc13);
    }
    // Every wavefront must finish reading the single buffer before the next
    // stage overwrites it.
    __syncthreads();

    // Load stage s+1 from global and commit it into the same buffer. The
    // `s + 1 < num_stages` guard is block-uniform, so the barrier below is
    // reached by every thread in the block.
    if (s + 1 < num_stages) {
      const int s1 = (s + 1) * kStageK;
      const int g_row = m0 + a_row;
      vA = (g_row < m)
               ? *reinterpret_cast<const int4*>(x_q + g_row * k + s1 + a_col16)
               : int4{0, 0, 0, 0};
      vB0 = *reinterpret_cast<const int4*>(
          weight + (s1 + b_kk0) * n + n0 + b_col16);
      vB1 = *reinterpret_cast<const int4*>(
          weight + (s1 + b_kk0 + kStageK / 2) * n + n0 + b_col16);
      int32_t* adst = reinterpret_cast<int32_t*>(
          a_tile + a_row * kAStride + a_col16);
      adst[0] = vA.x;
      adst[1] = vA.y;
      adst[2] = vA.z;
      adst[3] = vA.w;
      int32_t* bdst0 = reinterpret_cast<int32_t*>(
          b_tile + b_kk0 * kBStride + b_col16);
      bdst0[0] = vB0.x;
      bdst0[1] = vB0.y;
      bdst0[2] = vB0.z;
      bdst0[3] = vB0.w;
      int32_t* bdst1 = bdst0 + (kStageK / 2) * (kBStride / 4);
      bdst1[0] = vB1.x;
      bdst1[1] = vB1.y;
      bdst1[2] = vB1.z;
      bdst1[3] = vB1.w;
      // Make the stage s+1 stores visible before the next burst.
      __syncthreads();
    }
  }

  const int base_row = m0 + wave_row * 32;
  const int base_col = n0 + wave_col * 64;
  store_prefill_fragment(
      acc00, x_scale, weight_scale, out, m, n, base_row, base_col, lane);
  store_prefill_fragment(
      acc01, x_scale, weight_scale, out, m, n, base_row, base_col + kTileN,
      lane);
  store_prefill_fragment(
      acc02, x_scale, weight_scale, out, m, n, base_row,
      base_col + 2 * kTileN, lane);
  store_prefill_fragment(
      acc03, x_scale, weight_scale, out, m, n, base_row,
      base_col + 3 * kTileN, lane);
  store_prefill_fragment(
      acc10, x_scale, weight_scale, out, m, n, base_row + kTileM, base_col,
      lane);
  store_prefill_fragment(
      acc11, x_scale, weight_scale, out, m, n, base_row + kTileM,
      base_col + kTileN, lane);
  store_prefill_fragment(
      acc12, x_scale, weight_scale, out, m, n, base_row + kTileM,
      base_col + 2 * kTileN, lane);
  store_prefill_fragment(
      acc13, x_scale, weight_scale, out, m, n, base_row + kTileM,
      base_col + 3 * kTileN, lane);
}

// Iteration 1/2 (packed_weight family): explicit 8-byte loader for the
// col_major m16n16k32 B fragment. With the n-major LDS tile at row stride
// ldm (72 bytes in iteration 2, 80 in iteration 1), the col_major fragment
// mapping (n = lane & 15, k = 8 * (lane >> 4) + i) places each lane's 8
// elements at p[(lane & 15) * ldm + ((lane >> 4) << 3) .. +7]: one contiguous,
// 8-byte-aligned chunk (ldm and every k offset are multiples of 8), so this is
// ONE ds_read2_b64 instead of eight ds_read_u8 + mask/OR reassembly. The bytes
// placed in the fragment registers are exactly what
// du_load_matrix_sync<col_major> would produce, so the
// v_mmac_i32_16x16x32_i8 operands and the int32 accumulation are unchanged.
__device__ __forceinline__ void load_b_frag8(
    DUFragment<matrix_b, kTileM, kTileN, kTileK, signed char, col_major>& f,
    const int8_t* __restrict__ p,
    int ldm,
    int lane) {
  const int row = lane & 15;
  const int col = (lane >> 4) << 3;
  const int64_t v = *reinterpret_cast<const int64_t*>(p + row * ldm + col);
  *reinterpret_cast<int64_t*>(&f.x[0]) = v;
}

// Iteration 2 (operand-reuse round): assemble one 8-byte qword from the two
// low 32-bit halves of a packed 16-byte staging vector. The chunk commit uses
// two of these per 16-byte vector (72-byte LDS rows are only 8-byte aligned),
// which keeps the store side of the B tile bank-safe at identical byte volume.
__device__ __forceinline__ int64_t pack_lo32_pair(int lo, int hi) {
  return static_cast<int64_t>(static_cast<uint32_t>(lo)) |
         (static_cast<int64_t>(static_cast<uint32_t>(hi)) << 32);
}

// Iteration 1/2 (packed_weight family): packed B variant of the 64x128
// macro-tile for the exact assigned shape (K=4096, N=2560). The geometry,
// K staging depth (64), barrier count (two __syncthreads per stage), A path
// (row-major, 68-byte odd-word stride, 4 x ds_write_b32 per 16-byte vector),
// 8-MMA-per-32-K burst, fused scale/bf16 epilogue and 3-blocks/CU occupancy
// target are the same as the generic kernel. ONLY the B operand path changes:
//   * staging (iteration 2): lane = b_kq*16 + b_row4 with b_row4 = lane & 15
//     (n-row inside a 16-row group) and b_kq = (lane >> 4) & 3 (16-byte
//     k-chunk of the 64-K stage); wave w owns n-rows w*32 + b_row4 and
//     w*32 + b_row4 + 16. Consecutive lanes read consecutive 16-byte chunks of
//     packed16[(k/16)*N + n] (4 fully coalesced 256-byte runs per wavefront),
//     and each chunk commits as two alignment-provable 8-byte qword stores into
//     the bank-safe 72-byte-stride LDS tile at n_local*72 + 16*b_kq.
//   * consume: load_b_frag8 reads each lane's 8 B bytes as ONE ds_read2_b64
//     (vs 8 ds_read_u8 at stride 132); with the 18-word row stride the
//     16-lane phase spreads over 16 distinct even banks + their odd
//     neighbours (the 20-word stride left 8), removing the measured 6.0 bank
//     conflicts per LDS read instruction.
// LDS/block = 64x68 + 128x72 = 13,568 B (fits the single-buffer 48 KiB
// headroom rule); grid = (2560 / 128) x (4096 / 64) = 20 x 64 = 1280 blocks.
__global__ __launch_bounds__(kThreadsPerBlock) void
w8a8_dumma_prefill_64x128_packedb_kernel(
    const int8_t* __restrict__ x_q,
    const int8_t* __restrict__ packed_b,
    const float* __restrict__ x_scale,
    const float* __restrict__ weight_scale,
    hip_bfloat16* __restrict__ out,
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

  __shared__ __align__(16) int8_t a_tile[kBlockM * kAStride];
  // Iteration 2: n-major B tile, 128 n-rows of 72 bytes (64 data + 8 pad),
  // declared as qwords so each 8-byte chunk commit is alignment-provable.
  __shared__ __align__(16) int64_t b_tile[kBlockN * kPackedBWords];

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

  const int num_stages = k / kStageK;

  // A staging mapping unchanged. Iteration 2 B staging mapping for the chunked
  // packed layout: lane = b_kq*16 + b_row4 with b_row4 = lane & 15 (n-row
  // inside a 16-row group) and b_kq = (lane >> 4) & 3 (16-byte k-chunk of the
  // 64-K stage); wave w owns n-rows w*32 + b_row4 and w*32 + b_row4 + 16.
  const int a_row = tid >> 2;
  const int a_col16 = (tid & 3) << 4;
  const int b_row4 = lane & 15;
  const int b_kq = (lane >> 4) & 3;
  const int b_n0 = wave * 32 + b_row4;
  const int b_n1 = b_n0 + 16;
  const int b_kqo = b_kq << 1;  // qword offset of this 16-byte chunk

  // Iteration 18 (consolidate round, final HIP-only polish): every staging
  // address inside the 64-stage loop is a loop-invariant base plus a constant
  // per-stage byte stride, and every per-stage offset fits in 32 bits.
  //   * A: the row offset g_row*k (int64) is formed once (iteration 16); the
  //     stage-dependent part is a 32-bit running offset advanced by kStageK.
  //   * B: ((kg + b_kq)*n + n0 + b_n) << 4 for stage s is
  //     ((b_kq*n + n0 + b_n) << 4) + s*(kStageK/16)*n*16. The base is at most
  //     (3*2560 + 2559 + 127) << 4 = 165,856 and the running offset at most
  //     63*163,840 + 165,856 = 10,487,776, both inside int32, so the compiler
  //     no longer emits a 64-bit v_mad_i64_i32 multiply per B operand per
  //     stage; only a 32-bit add. The two B pointers differ by exactly
  //     (b_n1 - b_n0) << 4 = 256 bytes, so one running offset serves both.
  //   * the LDS commit destinations are loop-invariant and hoisted as well.
  // Same bytes from the same addresses into the same registers and LDS slots:
  // every fragment byte and every int32 accumulator is bit-identical.
  const int g_row = m0 + a_row;
  const bool a_row_ok = (g_row < m);
  const int64_t a_row_off = static_cast<int64_t>(g_row) * k;
  int a_stage_off = a_col16;  // s1 + a_col16, advanced by kStageK
  const int a_step = kStageK;
  int b_off = (b_kq * n + n0 + b_n0) << 4;  // 32-bit packed-B byte offset
  const int b_off_n1 = b_off + (16 << 4);
  const int b_step = ((kStageK >> 4) * n) << 4;
  int32_t* const adst = reinterpret_cast<int32_t*>(
      a_tile + a_row * kAStride + a_col16);
  int64_t* const bdst0 = b_tile + b_n0 * kPackedBWords + b_kqo;
  int64_t* const bdst1 = b_tile + b_n1 * kPackedBWords + b_kqo;

  int4 vA, vB0, vB1;

  // Prologue: load stage 0 into registers, commit it to the single buffers,
  // and make it visible before the first burst.
  {
    vA = a_row_ok ? *reinterpret_cast<const int4*>(x_q + a_row_off + a_stage_off)
                  : int4{0, 0, 0, 0};
    // Chunk c = (k/16)*n + n_idx holds packed_b[c*16 .. +15] =
    // weight[16*(c/n) .. 16*(c/n)+15][c%n]; stage 0 uses k-chunks 0..3.
    vB0 = *reinterpret_cast<const int4*>(packed_b + b_off);
    vB1 = *reinterpret_cast<const int4*>(packed_b + b_off_n1);
    // Commit A as int32 stores (68-byte rows are 4 mod 16 -> no b128).
    adst[0] = vA.x;
    adst[1] = vA.y;
    adst[2] = vA.z;
    adst[3] = vA.w;
    // Commit B as two 8-byte qword stores per 16-byte chunk (72-byte rows are
    // 8 mod 16, so no single b128); n_local*72 + 16*b_kq is a multiple of 8.
    bdst0[0] = pack_lo32_pair(vB0.x, vB0.y);
    bdst0[1] = pack_lo32_pair(vB0.z, vB0.w);
    bdst1[0] = pack_lo32_pair(vB1.x, vB1.y);
    bdst1[1] = pack_lo32_pair(vB1.z, vB1.w);
    __syncthreads();
  }

  for (int s = 0; s < num_stages; ++s) {
    // Consume the single buffer: each wave does eight m16n16k32 MMAs per
    // 32-K step over its own 32x64 quadrant.
    const int local_row = wave_row * 32;
    const int local_col = wave_col * 64;
    const int8_t* abase = a_tile + local_row * kAStride;
    const int8_t* bbase =
        reinterpret_cast<const int8_t*>(b_tile) + local_col * kPackedBStride;
#pragma unroll
    for (int kk = 0; kk < kStageK; kk += kTileK) {
      du_load_matrix_sync(a_frag0, abase + kk, kAStride);
      du_load_matrix_sync(a_frag1, abase + kTileM * kAStride + kk, kAStride);
      load_b_frag8(b_frag0, bbase + kk, kPackedBStride, lane);
      load_b_frag8(
          b_frag1, bbase + kTileN * kPackedBStride + kk, kPackedBStride, lane);
      load_b_frag8(
          b_frag2, bbase + 2 * kTileN * kPackedBStride + kk, kPackedBStride,
          lane);
      load_b_frag8(
          b_frag3, bbase + 3 * kTileN * kPackedBStride + kk, kPackedBStride,
          lane);
      du_mma_sync(acc00, a_frag0, b_frag0, acc00);
      du_mma_sync(acc01, a_frag0, b_frag1, acc01);
      du_mma_sync(acc02, a_frag0, b_frag2, acc02);
      du_mma_sync(acc03, a_frag0, b_frag3, acc03);
      du_mma_sync(acc10, a_frag1, b_frag0, acc10);
      du_mma_sync(acc11, a_frag1, b_frag1, acc11);
      du_mma_sync(acc12, a_frag1, b_frag2, acc12);
      du_mma_sync(acc13, a_frag1, b_frag3, acc13);
    }
    // Every wavefront must finish reading the single buffer before the next
    // stage overwrites it.
    __syncthreads();

    // Load stage s+1 from global and commit it into the same buffers. The
    // `s + 1 < num_stages` guard is block-uniform, so the barrier below is
    // reached by every thread in the block.
    if (s + 1 < num_stages) {
      // Iteration 18: advance the hoisted 32-bit staging offsets by the
      // compile-time per-stage strides instead of re-forming the full row /
      // chunk index (and its 64-bit multiply) in every one of the 64 stages.
      a_stage_off += a_step;
      b_off += b_step;
      vA = a_row_ok
               ? *reinterpret_cast<const int4*>(x_q + a_row_off + a_stage_off)
               : int4{0, 0, 0, 0};
      vB0 = *reinterpret_cast<const int4*>(packed_b + b_off);
      vB1 = *reinterpret_cast<const int4*>(packed_b + b_off + (16 << 4));
      adst[0] = vA.x;
      adst[1] = vA.y;
      adst[2] = vA.z;
      adst[3] = vA.w;
      bdst0[0] = pack_lo32_pair(vB0.x, vB0.y);
      bdst0[1] = pack_lo32_pair(vB0.z, vB0.w);
      bdst1[0] = pack_lo32_pair(vB1.x, vB1.y);
      bdst1[1] = pack_lo32_pair(vB1.z, vB1.w);
      // Make the stage s+1 stores visible before the next burst.
      __syncthreads();
    }
  }

  const int base_row = m0 + wave_row * 32;
  const int base_col = n0 + wave_col * 64;
  store_prefill_fragment(
      acc00, x_scale, weight_scale, out, m, n, base_row, base_col, lane);
  store_prefill_fragment(
      acc01, x_scale, weight_scale, out, m, n, base_row, base_col + kTileN,
      lane);
  store_prefill_fragment(
      acc02, x_scale, weight_scale, out, m, n, base_row,
      base_col + 2 * kTileN, lane);
  store_prefill_fragment(
      acc03, x_scale, weight_scale, out, m, n, base_row,
      base_col + 3 * kTileN, lane);
  store_prefill_fragment(
      acc10, x_scale, weight_scale, out, m, n, base_row + kTileM, base_col,
      lane);
  store_prefill_fragment(
      acc11, x_scale, weight_scale, out, m, n, base_row + kTileM,
      base_col + kTileN, lane);
  store_prefill_fragment(
      acc12, x_scale, weight_scale, out, m, n, base_row + kTileM,
      base_col + 2 * kTileN, lane);
  store_prefill_fragment(
      acc13, x_scale, weight_scale, out, m, n, base_row + kTileM,
      base_col + 3 * kTileN, lane);
}

// Generic scalar int8/int32 fallback for every unmatched (m, n, k) and for
// small-M API cases (m < 128, including the paired M=2 shape). One output
// element per grid-stride step; exact int32 accumulation (the assigned K
// keeps the int8 dot well inside int32 range), then the fused float scale and
// bf16 store.
__global__ __launch_bounds__(kFallbackThreads) void w8a8_scalar_gemm_kernel(
    const int8_t* __restrict__ a,
    const int8_t* __restrict__ b,
    const float* __restrict__ x_scale,
    const float* __restrict__ weight_scale,
    hip_bfloat16* __restrict__ out,
    int m,
    int n,
    int k) {
  const int64_t total = static_cast<int64_t>(m) * n;
  const int64_t stride = static_cast<int64_t>(gridDim.x) * blockDim.x;
  for (int64_t idx = static_cast<int64_t>(blockIdx.x) * blockDim.x +
                     threadIdx.x;
       idx < total;
       idx += stride) {
    const int row = static_cast<int>(idx / n);
    const int col = static_cast<int>(idx - static_cast<int64_t>(row) * n);
    const int8_t* a_row = a + static_cast<int64_t>(row) * k;
    // Iteration 2 (operand-reuse round): the exact assigned shape
    // (K=4096, N=2560) is packed by launch_pack_w8a8_weight into the chunked
    // packed16[(k/16) * N + n] layout, so this fallback must decode that layout
    // for the paired M=2 API shape: element (kk, col) lives at
    // packed16[((kk >> 4) * n + col) * 16 + (kk & 15)]. Every other (k, n)
    // keeps the logical [K, N] row-major layout. Grid-uniform per launch.
    const bool packed_b = (k == kPackedBK && n == kPackedBN);
    const int8_t* b_col = b + col;
    int32_t acc = 0;
    for (int kk = 0; kk < k; ++kk) {
      const int32_t bw =
          packed_b
              ? static_cast<int32_t>(
                    b[(static_cast<int64_t>(kk >> 4) * n + col) * 16 +
                      (kk & 15)])
              : static_cast<int32_t>(b_col[static_cast<int64_t>(kk) * n]);
      acc += static_cast<int32_t>(a_row[kk]) * bw;
    }
    const float scaled = static_cast<float>(acc) *
                         x_scale[row] * weight_scale[col];
    out[idx] = __float2bfloat16(scaled);
  }
}

// Identity device-to-device byte copy (pack_weight bootstrap, valid for any
// (K, N)).
__global__ __launch_bounds__(kPackThreads) void w8a8_pack_identity_i8_kernel(
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

// Identity device-to-device float copy for the weight scales.
__global__ __launch_bounds__(kPackThreads) void w8a8_pack_identity_f32_kernel(
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

// Iteration 2 (operand-reuse round): one-time 16-byte-chunk packing of the
// logical [K, N] row-major weight into packed16[(k/16) * N + n], where chunk
// c holds packed16[c*16 + i] = weight[(c / N) * 16 + i][c % N] for i in 0..15.
// Runs only from launch_pack_w8a8_weight, outside the timed region and outside
// Graph capture. The packed buffer keeps the same byte count (k*n) as the
// identity pack, so allocations and graph-stable addresses are unchanged. Each
// thread owns one 16-byte chunk: the 16 strided byte gathers (stride N) are
// fully coalesced across the wavefront's threads and the 16-byte store is
// contiguous, so the pack stays bandwidth-clean. The guard requires
// k % 16 == 0, true for the exact assigned shape.
__global__ __launch_bounds__(kPackThreads) void w8a8_pack_k16chunk_b_kernel(
    const int8_t* __restrict__ src,
    int8_t* __restrict__ dst,
    int k,
    int n) {
  const int64_t chunks = (static_cast<int64_t>(k) >> 4) * n;
  const int64_t stride = static_cast<int64_t>(gridDim.x) * blockDim.x;
  for (int64_t c = static_cast<int64_t>(blockIdx.x) * blockDim.x +
                   threadIdx.x;
       c < chunks;
       c += stride) {
    const int64_t kg = c / n;
    const int n_idx = static_cast<int>(c - kg * n);
    const int8_t* scol = src + (kg << 4) * n + n_idx;
    int8_t* d = dst + (c << 4);
#pragma unroll
    for (int i = 0; i < 16; ++i) {
      d[i] = scol[static_cast<int64_t>(i) * n];
    }
  }
}

inline int64_t capped_blocks(int64_t elements, int threads) {
  int64_t blocks = (elements + threads - 1) / threads;
  if (blocks > 4096) {
    blocks = 4096;
  }
  if (blocks < 1) {
    blocks = 1;
  }
  return blocks;
}

}  // namespace

// Stable host launch symbol consumed by csrc/bindings.cpp. Dispatches on the
// caller-provided stream only; never allocates, synchronizes, packs, or
// touches the default stream.
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

  // Iteration 1/2 (packed_weight family): the exact assigned shape
  // (K=4096, N=2560) routes to the packed 16-byte-chunk B variant of the
  // 64x128 kernel, whose B operand comes from the one-time packed16[(k/16)*N+n]
  // layout prepared by launch_pack_w8a8_weight. The guard is exact (m >= 128,
  // n == 2560, k == 4096) and sits BEFORE the generic path; every other
  // (m, n, k) keeps its existing path and the identity-packed layout. The
  // m >= 128 guard keeps the paired M=2 API shape on the scalar fallback,
  // which decodes the chunked layout for this exact (k, n).
  if (m >= 128 && n == kPackedBN && k == kPackedBK) {
    const dim3 grid(
        static_cast<unsigned>(n / kBlockN),
        static_cast<unsigned>((m + kBlockM - 1) / kBlockM));
    const dim3 block(static_cast<unsigned>(kThreadsPerBlock));
    hipLaunchKernelGGL(
        w8a8_dumma_prefill_64x128_packedb_kernel,
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

  // Native INT8 DUMMA m16n16k32 prefill path for every large-M shape with
  // compatible geometry (covers the assigned M=4096, N=2560, K=4096 shape:
  // 2560 % 128 == 0 and 4096 % 64 == 0). The explicit m >= 128 guard keeps
  // the small-M API shapes on the scalar fallback.
  if (m >= 128 && (n % kBlockN) == 0 && (k % kStageK) == 0) {
    const dim3 grid(
        static_cast<unsigned>(n / kBlockN),
        static_cast<unsigned>((m + kBlockM - 1) / kBlockM));
    const dim3 block(static_cast<unsigned>(kThreadsPerBlock));
    hipLaunchKernelGGL(
        w8a8_dumma_prefill_64x128_kernel,
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

  // Scalar int8/int32 fallback for unmatched (m, n, k) and small-M API cases.
  const int64_t total = static_cast<int64_t>(m) * n;
  const dim3 grid(static_cast<unsigned>(capped_blocks(total, kFallbackThreads)));
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

// Stable host launch symbol consumed by csrc/bindings.cpp. Iteration 2
// (operand-reuse round) behaviour: for the exact assigned pair (K=4096,
// N=2560) it performs the one-time 16-byte-chunk packing
// packed16[(k/16) * N + n] (outside the timed region and Graph capture) and
// for every other (K, N) the identity device-to-device copy of the logical
// [K, N] int8 weight. The N fp32 weight scales are copied identically in both
// cases. Both layouts keep the same byte count as the raw weight, so
// allocation and graph-stable addresses are unchanged.
//
// Iteration 3 (fix_build round) correction: this host call previously
// referenced the removed w8a8_pack_nmajor_b_kernel symbol, which was the only
// compile error of the iteration-2 candidate. It now binds the defined
// w8a8_pack_k16chunk_b_kernel; nothing else in this file changed.
extern "C" void launch_pack_w8a8_weight(
    const int8_t* raw_weight,
    const float* weight_scale,
    int8_t* packed_weight,
    float* packed_weight_scale,
    int k,
    int n,
    hipStream_t stream) {
  const int64_t weight_count = static_cast<int64_t>(k) * n;
  if (weight_count > 0) {
    if (k == kPackedBK && n == kPackedBN) {
      // Iteration 2 (operand-reuse round): exact assigned shape
      // (K=4096, N=2560) -> one-time 16-byte-chunk packing
      // packed16[(k/16) * N + n]. Same k*n byte count as the identity pack, so
      // the allocation and the graph-stable packed layout are unchanged.
      // Outside the timed region.
      const int64_t chunks = weight_count >> 4;
      const dim3 grid(
          static_cast<unsigned>(capped_blocks(chunks, kPackThreads)));
      const dim3 block(kPackThreads);
      hipLaunchKernelGGL(
          w8a8_pack_k16chunk_b_kernel,
          grid,
          block,
          0,
          stream,
          raw_weight,
          packed_weight,
          k,
          n);
    } else {
      const dim3 grid(
          static_cast<unsigned>(capped_blocks(weight_count, kPackThreads)));
      const dim3 block(kPackThreads);
      hipLaunchKernelGGL(
          w8a8_pack_identity_i8_kernel,
          grid,
          block,
          0,
          stream,
          raw_weight,
          packed_weight,
          weight_count);
    }
  }
  if (n > 0) {
    const dim3 grid(
        static_cast<unsigned>(capped_blocks(n, kPackThreads)));
    const dim3 block(kPackThreads);
    hipLaunchKernelGGL(
        w8a8_pack_identity_f32_kernel,
        grid,
        block,
        0,
        stream,
        weight_scale,
        packed_weight_scale,
        static_cast<int64_t>(n));
  }
}
// @@end
