// @@variant shape=glm_tp8_shared_gate_up_proj_m4096 commit=1aa11051ede5b81487b51f5949af8c5177ffd4a4 added=2026-09-14
//   median_us=249.9 p90_us=251.9 speedup=85.06 baseline_us=2.125e+04
//   source=test-9-11-1/iteration_002/glm_tp8_shared_gate_up_proj_m4096
// MetaInfer W8A8 INT8 GEMM backend for Hygon gfx928 (K500SM_AI).
// worker_1 (iteration 1, establish_arch round), assigned shape:
//   glm_tp8_shared_gate_up_proj_m4096 : (M, N, K) = (4096, 512, 6144)
//
// This file provides the two stable host launch symbols consumed by
// csrc/bindings.cpp:
//   * launch_w8a8_gemm(...)        - timed, graph-safe GEMM on the caller's
//                                    HIP stream; no allocation, packing,
//                                    autotuning, or synchronization. Only the
//                                    caller-provided out is touched (no
//                                    split-K, so the workspace is untouched).
//   * launch_pack_w8a8_weight(...) - out-of-timed-region packing. The assigned
//                                    gate_up weight (k, n) == (6144, 512) is
//                                    packed once as a [K, N] -> [N, K]
//                                    transpose (n-major rows, k contiguous);
//                                    every other (k, n) pair keeps the
//                                    byte-identical identity copy.
//
// Round 1 (establish_arch; architecture experiment = packed_weight family):
// the accepted bootstrap is a correct native INT8 DUMMA m16n16k32 64x64x128
// tiled kernel (431.615 us median / 432.025 us p90, 59.71 TOPS, 75.35 GB/s,
// passed, graph_capture_passed, mismatch_count 0). Its fresh PMC bundle
// exposes the dominant steady-state defect:
//   * lds_bank_conflicts = 17,301,504 over 512 blocks x 48 K-stages = 704
//     conflict cycles per block-stage, sourced by the identity [K, N] B tile:
//     the matrix_b row_major loader must gather its 8 elements per lane from
//     8 different k-rows at the kBlockN+16 = 80 B row stride, so the LDS
//     reads are byte-scattered and heavily aliased across the wavefront;
//   * lds_wait_instructions = 11,954,696 (~486 stall cycles per block-stage);
//   * lds_instructions = 7,471,104.
// This round establishes the packed-weight architecture geometry for the
// exact gate_up (K, N) pair:
//   * launch_pack_w8a8_weight transposes raw [K, N] into packed [N, K]
//     (n-major rows, k contiguous) for (k, n) == (6144, 512) ONLY. Packing
//     runs before graph capture, uses the same byte count / graph-stable
//     buffer, and is byte-exact: packed[cc * k + kk] == raw[kk * n + cc].
//   * The prefill kernel stages B[kBlockN, kStageK] from that packed layout
//     with 16-byte vectorized coalesced int4 global loads into a bank-skewed
//     LDS tile (row stride kStageK + 16 B; 80 B at the round-11 64-K packed
//     stage) and consumes it with the
//     matrix_b col_major fragment loader: each lane's 8 elements are now 8
//     CONSECUTIVE k-bytes of one packed row instead of 8 byte-scattered
//     columns, which removes the byte aliasing of the row_major path.
//   * A stays row_major from the identity [M, K] activation with the same
//     bank-skewed kStageK + 16 B LDS row stride; A staging / global traffic /
//     epilogue are unchanged.
//
// Geometry (unchanged from the accepted bootstrap, so this round isolates the
// operand-layout factor):
//   * 64x64 macro-tile, 4 wavefronts per block (256 threads), each wavefront
//     owns one 32x32 quadrant = four resident m16n16k32 int32 accumulators
//     held across the whole K loop.
//   * SINGLE-buffered K loop: cooperative vectorized (int4) coalesced A/B
//     global loads into bank-skewed LDS, then the MMAC burst, then two
//     barriers per stage. No split-K, no raw asm. Round 11 (final consolidate
//     polish) halves the PACKED arm's K stage from 128 to 64 (kPackedStageK);
//     the identity [K, N] arm keeps the 128-K stage byte-identically.
//   * Identity [K, N] arm: LDS = A[64, 144] (9,216 B) + B[128, 80]
//     (10,240 B) = 19,456 B/block -> 3 blocks/CU. Packed [N, K] arm (round 11
//     geometry): 64-K stage -> LDS = A[64, 80] (5,120 B) + B[64, 80]
//     (5,120 B) = 10,240 B/block, so it is no longer LDS-limited and reaches
//     the 4-block/CU VGPR ceiling (4 x 256 threads x 64 VGPR = 65,536, the
//     whole per-CU VGPR file; 4 x 10,240 = 40,960 B <= 64 KiB LDS), i.e. 16
//     resident waves/CU instead of 12.
//   * Grid = (N/64, ceil(M/64)) = (8, 64) = 512 blocks.
//   * Fused direct fragment -> x_scale -> weight_scale -> bf16 epilogue using
//     the gfx928 int8 DUMMA accumulator ownership (row = lane & 15,
//     col_mod4 = lane >> 4, frag.x[i] -> columns col_mod4 + 4*i). The int32
//     dot is exact for every assigned K (max |dot| = 6144*127*127 << 2^31),
//     and the exact fp32 order (dot * x_scale[m]) * weight_scale[n] then one
//     bfloat16 rounding matches the trusted int64 reference bit-for-bit.
//   * Tail M rows are zero-filled on load and masked on store, so any M >= 128
//     works with the tiled path.
//   * Every other (m, n, k) - including every M < 128 API case and the paired
//     M=2/M=16 shapes with the same (N, K) - goes to a scalar int8/int32
//     fallback that decodes the [N, K] packed layout when (k, n) ==
//     (6144, 512) and the identity [K, N] layout otherwise.
//
// Iteration 14 (consolidate; final HIP-only polish of the fixed packed_weight
// architecture): the accepted packed arm's four fragment loads per MMAC step
// are switched from the library du_load_matrix_sync lowering (ds_read2_b32
// plus per-byte v_and / v_or_b32_sdwa / v_or3 mask-OR "identity" reassembly)
// to an explicit 8-byte load_frag8 int64 (ds_read_b64) loader, for the packed
// n-major arm ONLY (new kDirectFrag template flag, set true for the exact
// (K, N) = (6144, 512) dispatch; the identity [K, N] arm keeps the library
// loaders byte-identically). Lane -> (row = lane & 15, k-quarter = lane >> 4)
// and the eight contiguous bytes at p[row * ldm + (lane >> 4) * 8] land in
// the same x[0..7] slots in the same little-endian order, so the v_mmac
// operands, the exact k0-outer / kk-inner int32 accumulation order and every
// result are unchanged. LDS strides (A = kStageK + 16, packed B = kStageK +
// 16), int4 staging, global traffic, single buffer, two barriers per stage,
// tile, grid (512 blocks), 4 waves / 256 threads, 10,240 B LDS, occupancy and
// the fused epilogue are byte-identical; both pack kernels, the host shape
// guards and the scalar fallback are untouched.
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

// Large-prefill dispatch geometry: one 32x32 DUMMA quadrant per wavefront.
constexpr int kPrefillMinM = 128;
constexpr int kPrefillStageK = 128;
constexpr int kDefaultBlockM = 64;
constexpr int kDefaultBlockN = 64;

// Exact assigned shape: the only (K, N) pair whose packed weight is stored
// n-major (transposed). Every other pair keeps the identity [K, N] layout.
constexpr int kGateUpK = 6144;
constexpr int kGateUpN = 512;

// Round 11 (consolidate): the fixed winning packed_weight architecture keeps
// its 64x64 macro-tile, 4-wave/256-thread block, single-buffered stage
// structure and 16-byte bank skew; only the PACKED arm's K stage depth is
// polished from the generic 128 down to 64. The packed arm's LDS footprint
// drops from A[64,144] + B[64,144] = 18,432 B to A[64,80] + B[64,80] =
// 10,240 B/block, so the 64 KiB per-CU LDS part no longer caps it at 3
// blocks/CU and it reaches the 4-blocks/CU VGPR ceiling (4 x 256 x 64 = the
// whole 65,536-dword per-CU VGPR file; 4 x 10,240 = 40,960 B). That is 16
// resident waves/CU instead of 12, giving +33% concurrent coverage of the
// single-buffered global-load -> barrier -> MMAC -> barrier dependency that
// dominates each stage. The current PMC confirms the stage is latency- rather
// than bandwidth-limited: 97.6 GB/s counter-derived HBM bandwidth against
// 88.8 GB/s algorithmic bandwidth at a 91.8% L2 hit rate, so the staged
// operand traffic is far from saturating the memory system.
//
// k = 6144 = 96 x 64, kPackedStageK % kTileK == 0 and the kk inner order
// still advances in 32-K DUMMA steps, so the k0-outer / kk-inner int32
// accumulation visits the exact same K sequence and every result stays
// bit-identical to the accepted 128-K stage. The identity [K, N] arm, the
// host shape guards, both pack kernels and the scalar fallback are untouched.
constexpr int kPackedStageK = 64;
static_assert(kPackedStageK % kTileK == 0,
              "packed K stage must be a multiple of the DUMMA K unit");
static_assert(kGateUpK % kPackedStageK == 0,
              "packed K stage must tile the assigned gate_up K exactly");

constexpr int kScalarThreads = 256;

using namespace du::dumma;

// Verified gfx928 INT8 DUMMA accumulator ownership:
//   row = lane & 15, col_mod4 = lane >> 4, frag.x[i] -> columns
//   col_mod4 + 4*i. Scale by x_scale[row] and weight_scale[col] and store bf16
//   directly from the fragment (no accumulator LDS round trip).
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
    out[row * n + col] = __float2bfloat16(scaled);
  }
}

// Iteration 14 (consolidate polish, packed arm only): explicit 8-byte fragment
// loader replacing the library du_load_matrix_sync calls in the packed
// n-major arm. For BOTH the library row_major matrix_a and col_major
// matrix_b m16n16k32 int8 loaders, lane l -> row (l & 15), k-quarter
// (l >> 4), and the loader fetches the same eight contiguous bytes at
// p[row * ldm + (l >> 4) * 8 .. +7] and stores them into the same x[0..7]
// slots in the same little-endian order (the accepted code object lowers the
// library calls to ds_read2_b32 plus a per-byte v_and / v_or_b32_sdwa /
// v_or3 mask-OR "identity" reassembly). Loading the same 8 bytes as one
// int64 forces the 8-byte ds_read_b64 form: the reassembly VALU disappears
// and the LDS access moves from 32-lane dword phases to 16-lane 8-byte
// phases. The element-to-slot mapping, the v_mmac operands, the
// k0-outer/kk-inner int32 accumulation order, the LDS strides (A = kStageK +
// 16, packed B = kStageK + 16), staging, barriers, tile/grid/occupancy and
// the fused epilogue are unchanged, so results stay bit-identical.
template <typename Frag>
__device__ __forceinline__ void load_frag8(
    Frag& f, const int8_t* p, unsigned ldm) {
  const unsigned row = __lane_id() & 0xf;
  const unsigned kq = __lane_id() >> 4;
  const int64_t v =
      *reinterpret_cast<const int64_t*>(p + row * ldm + (kq << 3));
  reinterpret_cast<int64_t*>(f.x)[0] = v;
}

// Stage one K tile (k0) of A[kBlockM, kStageK] and B into the caller LDS
// buffers with int4-vectorized coalesced global loads. Tail M rows are
// zero-filled so the MACs contribute nothing and the guarded store never
// writes them.
//
// kBNMajor == true stages B[kBlockN, kStageK] from the packed [N, K] layout
// (n-major rows, k contiguous) that launch_pack_w8a8_weight produces for the
// exact gate_up (k, n) pair: row = local N, columns = k, row stride
// kStageK + 16 B (80 B at the round-11 64-K packed stage). The B fragment
// consumer then reads 8 consecutive k bytes per lane (col_major), replacing
// the byte-scattered identity-layout row_major reads that source the measured
// 17.3M bank conflicts.
// kBNMajor == false stages B[kStageK, kBlockN] from the identity [K, N]
// weight with row stride kBlockN + 16 = 80 B (unchanged bootstrap path).
template <int kBlockM, int kBlockN, int kStageK, bool kBNMajor>
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
  constexpr int kInt4 = static_cast<int>(sizeof(int4));
  // 16-byte bank skew: keeps int4 staging stores aligned while spreading the
  // fragment rows across distinct LDS banks.
  constexpr int kAStride = kStageK + kInt4;
  constexpr int kBStride = kBlockN + kInt4;   // identity [K, N] rows
  constexpr int kBNStride = kStageK + kInt4;  // packed [N, K] rows
  constexpr int kAInt4PerRow = kStageK / kInt4;
  constexpr int kAInt4 = kBlockM * kAInt4PerRow;
  constexpr int kBInt4PerRow = kBlockN / kInt4;
  constexpr int kBInt4 = kStageK * kBInt4PerRow;
  constexpr int kBNInt4PerRow = kStageK / kInt4;
  constexpr int kBNInt4 = kBlockN * kBNInt4PerRow;
  // Stage A[kBlockM, kStageK] into LDS (zero-filled tail M rows).
  for (int vec = tid; vec < kAInt4; vec += kThreads) {
    const int local_row = vec / kAInt4PerRow;
    const int v = vec - local_row * kAInt4PerRow;
    const int global_row = m0 + local_row;
    const int4 val =
        global_row < m
            ? *reinterpret_cast<const int4*>(
                  x_q + static_cast<int64_t>(global_row) * k + k0 +
                  v * kInt4)
            : int4{0, 0, 0, 0};
    reinterpret_cast<int4*>(a_tile + local_row * kAStride)[v] = val;
  }
  if constexpr (kBNMajor) {
    // Stage B[kBlockN, kStageK] from the packed [N, K] weight (n-major rows,
    // k contiguous): row = local N, 16 consecutive k bytes per int4.
    static_assert(kBNInt4 % kThreads == 0,
                  "packed n-major B staging must divide evenly");
    for (int vec = tid; vec < kBNInt4; vec += kThreads) {
      const int local_col = vec / kBNInt4PerRow;
      const int v = vec - local_col * kBNInt4PerRow;
      reinterpret_cast<int4*>(b_tile + local_col * kBNStride)[v] =
          *reinterpret_cast<const int4*>(
              weight + static_cast<int64_t>(n0 + local_col) * k + k0 +
              v * kInt4);
    }
  } else {
    // Stage B[kStageK, kBlockN] from the identity [K, N] weight.
    for (int vec = tid; vec < kBInt4; vec += kThreads) {
      const int kk = vec / kBInt4PerRow;
      const int v = vec - kk * kBInt4PerRow;
      reinterpret_cast<int4*>(b_tile + kk * kBStride)[v] =
          *reinterpret_cast<const int4*>(
              weight + static_cast<int64_t>(k0 + kk) * n + n0 + v * kInt4);
    }
  }
}

// One wave's 32x32-quadrant MMAC burst for the K tile staged at a_tile/b_tile.
// k0-outer / kk-inner int32 accumulation order; stage-size changes only
// regroup exact integer sums, so results stay bit-identical to the scalar
// fallback and to the int64 reference.
//
// kBNMajor == true consumes B as matrix_b col_major fragments (8 consecutive
// k bytes per lane, row stride kStageK + 16 B) from the packed [N, K] tile; the
// element-to-slot mapping and the v_mmac operand bit patterns are the same as
// the identity row_major path, so the int32 accumulation stays bit-identical.
//
// kDirectFrag == true (iteration 14, packed arm only) replaces the four
// library du_load_matrix_sync fragment loads with the explicit 8-byte
// load_frag8 int64 loader, which halves the LDS read phase count and removes
// the per-byte mask-OR reassembly VALU; the loaded bytes and fragment slots
// are identical.
template <int kBlockM, int kBlockN, int kStageK, bool kBNMajor,
          bool kDirectFrag = false>
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
  constexpr int kInt4 = static_cast<int>(sizeof(int4));
  constexpr int kAStride = kStageK + kInt4;
  constexpr int kBStride = kBlockN + kInt4;   // identity [K, N] rows
  constexpr int kBNStride = kStageK + kInt4;  // packed [N, K] rows
  if constexpr (kBNMajor) {
    DUFragment<matrix_b, kTileM, kTileN, kTileK, signed char, col_major>
        b_frag0, b_frag1;
#pragma unroll
    for (int kk = 0; kk < kStageK; kk += kTileK) {
      if constexpr (kDirectFrag) {
        // Iteration 14: one int64 ds_read_b64 per fragment (same 8 bytes per
        // lane into the same x[0..7] slots) instead of the library
        // ds_read2_b32 + mask/OR reassembly form.
        load_frag8(a_frag0, a_tile + local_row * kAStride + kk, kAStride);
        load_frag8(a_frag1,
                   a_tile + (local_row + kTileM) * kAStride + kk, kAStride);
        load_frag8(b_frag0, b_tile + local_col * kBNStride + kk, kBNStride);
        load_frag8(b_frag1,
                   b_tile + (local_col + kTileN) * kBNStride + kk, kBNStride);
      } else {
        du_load_matrix_sync(
            a_frag0, a_tile + local_row * kAStride + kk, kAStride);
        du_load_matrix_sync(
            a_frag1, a_tile + (local_row + kTileM) * kAStride + kk, kAStride);
        du_load_matrix_sync(
            b_frag0, b_tile + local_col * kBNStride + kk, kBNStride);
        du_load_matrix_sync(
            b_frag1, b_tile + (local_col + kTileN) * kBNStride + kk,
            kBNStride);
      }
      du_mma_sync(acc00, a_frag0, b_frag0, acc00);
      du_mma_sync(acc01, a_frag0, b_frag1, acc01);
      du_mma_sync(acc10, a_frag1, b_frag0, acc10);
      du_mma_sync(acc11, a_frag1, b_frag1, acc11);
    }
  } else {
    DUFragment<matrix_b, kTileM, kTileN, kTileK, signed char, row_major>
        b_frag0, b_frag1;
#pragma unroll
    for (int kk = 0; kk < kStageK; kk += kTileK) {
      du_load_matrix_sync(
          a_frag0, a_tile + local_row * kAStride + kk, kAStride);
      du_load_matrix_sync(
          a_frag1, a_tile + (local_row + kTileM) * kAStride + kk, kAStride);
      du_load_matrix_sync(b_frag0, b_tile + kk * kBStride + local_col, kBStride);
      du_load_matrix_sync(
          b_frag1, b_tile + kk * kBStride + local_col + kTileN, kBStride);
      du_mma_sync(acc00, a_frag0, b_frag0, acc00);
      du_mma_sync(acc01, a_frag0, b_frag1, acc01);
      du_mma_sync(acc10, a_frag1, b_frag0, acc10);
      du_mma_sync(acc11, a_frag1, b_frag1, acc11);
    }
  }
}

// Single-buffered large-prefill path: one block computes a kBlockM x kBlockN
// output tile. (kBlockM/32) x (kBlockN/32) wavefronts each own a 32x32
// quadrant (four m16n16k32 DUMMA accumulators) while the block cooperatively
// stages A[kBlockM, kStageK] and B in bank-skewed LDS.
//
// kBNMajor selects the B operand layout: false is the identity [K, N] staging
// with row_major fragments (any (k, n)); true is the packed [N, K] staging
// with col_major fragments (exact gate_up (k, n) only).
//
// Grid covers N in whole tiles (dispatch guarantees N % kBlockN == 0) and M
// in ceil-divided tiles (row tail handled by the zero-fill + masked store).
//
// kDirectFrag (iteration 14) selects the explicit 8-byte load_frag8 fragment
// loader for the packed n-major arm; the identity arm and every generic
// geometry keep the library du_load_matrix_sync loaders.
template <int kBlockM, int kBlockN, int kStageK, bool kBNMajor = false,
          bool kDirectFrag = false>
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
  constexpr int kInt4 = static_cast<int>(sizeof(int4));
  constexpr int kAStride = kStageK + kInt4;
  constexpr int kBStride = kBlockN + kInt4;   // identity [K, N] rows
  constexpr int kBNStride = kStageK + kInt4;  // packed [N, K] rows
  constexpr int kABytes = kBlockM * kAStride;
  constexpr int kBBytes = kStageK * kBStride;
  constexpr int kBNBytes = kBlockN * kBNStride;
  // The B tile is sized exactly for the layout the instantiation uses, so an
  // inactive arm never allocates dead LDS: identity (kStageK=128) 128 x 80 =
  // 10,240 B, packed (kStageK=64) 64 x 80 = 5,120 B. With A[64, 80] =
  // 5,120 B the packed arm is 10,240 B/block, so the packed instantiation now
  // reaches the 4-blocks/CU VGPR ceiling (4 x 256 x 64 = 65,536 VGPR;
  // 4 x 10,240 = 40,960 <= 64 KiB LDS) instead of the 3 blocks/CU the 18,432 B
  // packed arm allowed. The identity arm keeps its 19,456 B / 3 blocks/CU.
  constexpr int kBAlloc = kBNMajor ? kBNBytes : kBBytes;
  // Consolidation guard: the packed arm must keep the 4-blocks/CU LDS budget
  // that its 64-K stage buys; this fires the build if a future stage/tile edit
  // would silently drop the packed arm back to 3 blocks/CU.
  static_assert(!kBNMajor || 4 * (kABytes + kBAlloc) <= 64 * 1024,
                "packed arm must keep 4 blocks/CU on the 64 KiB LDS part");
  static_assert(kStageK % kTileK == 0,
                "K stage must be a multiple of the DUMMA K unit");
  static_assert(kStageK % kInt4 == 0,
                "K stage must keep int4 staging aligned");
  static_assert(kAStride % kInt4 == 0,
                "A LDS row stride must stay int4 aligned");
  static_assert(kBStride % kInt4 == 0,
                "B LDS row stride must stay int4 aligned");
  static_assert(kBNStride % kInt4 == 0,
                "packed B LDS row stride must stay int4 aligned");
  static_assert(kBlockM % 32 == 0 && kBlockN % 32 == 0,
                "each wavefront owns a 32x32 DUMMA quadrant");
  static_assert(!kDirectFrag || kBNMajor,
                "direct 8-byte fragment loader is defined for the packed "
                "n-major arm only");
  static_assert(!kBNMajor || (kBlockN * (kStageK / kInt4)) %
                                      (kBlockM * kBlockN / 1024 * kWaveSize) ==
                                  0,
                "packed n-major B staging must divide evenly across threads");

  const int tid = static_cast<int>(threadIdx.x);
  const int wave = tid / kWaveSize;
  const int lane = tid % kWaveSize;
  const int wave_row = wave / kWavesN;
  const int wave_col = wave - wave_row * kWavesN;
  const int m0 = static_cast<int>(blockIdx.y) * kBlockM;
  const int n0 = static_cast<int>(blockIdx.x) * kBlockN;
  const int local_row = wave_row * 32;
  const int local_col = wave_col * 32;

  __shared__ __align__(16) int8_t a_tile[kABytes];
  __shared__ __align__(16) int8_t b_tile[kBAlloc];

  DUFragment<matrix_a, kTileM, kTileN, kTileK, signed char, row_major>
      a_frag0, a_frag1;
  DUFragment<accumulator, kTileM, kTileN, kTileK, int>
      acc00, acc01, acc10, acc11;
  du_fill_fragment(acc00, 0);
  du_fill_fragment(acc01, 0);
  du_fill_fragment(acc10, 0);
  du_fill_fragment(acc11, 0);

  for (int k0 = 0; k0 < k; k0 += kStageK) {
    // Stage A[kBlockM, kStageK] and B into the single LDS buffer, then
    // publish them to every wavefront.
    stage_prefill_tiles<kBlockM, kBlockN, kStageK, kBNMajor>(
        x_q, weight, a_tile, b_tile, tid, m0, n0, m, n, k, k0);
    __syncthreads();
    // Each wave computes its 32x32 quadrant: four m16n16k32 DUMMA tiles.
    // k0-outer / kk-inner int32 accumulation order.
    mmac_prefill_stage<kBlockM, kBlockN, kStageK, kBNMajor, kDirectFrag>(
        a_frag0, a_frag1, acc00, acc01, acc10, acc11,
        a_tile, b_tile, local_row, local_col);
    // Retire this stage's reads before the next stage's staging writes
    // overwrite the single LDS buffer (WAR hazard across waves).
    __syncthreads();
  }

  const int base_row = m0 + wave_row * 32;
  const int base_col = n0 + wave_col * 32;
  store_prefill_fragment(
      acc00, x_scale, weight_scale, out, m, n,
      base_row, base_col, lane);
  store_prefill_fragment(
      acc01, x_scale, weight_scale, out, m, n,
      base_row, base_col + kTileN, lane);
  store_prefill_fragment(
      acc10, x_scale, weight_scale, out, m, n,
      base_row + kTileM, base_col, lane);
  store_prefill_fragment(
      acc11, x_scale, weight_scale, out, m, n,
      base_row + kTileM, base_col + kTileN, lane);
}

// Generic scalar fallback: one output element per grid-stride iteration with
// exact int32 accumulation. Correct for any (m, n, k), including the small-M
// API shapes (M=2/16). The weight is the identity [K, N] row-major layout for
// every (k, n) EXCEPT the assigned gate_up pair (k, n) == (6144, 512), whose
// buffer is packed [N, K] n-major; this kernel decodes that layout so the
// paired gate_up M=2/M=16 tails stay correct.
__global__ __launch_bounds__(kScalarThreads) void
w8a8_gemm_scalar_kernel(
    const int8_t* __restrict__ x_q,
    const int8_t* __restrict__ weight,
    const float* __restrict__ x_scale,
    const float* __restrict__ weight_scale,
    hip_bfloat16* __restrict__ out,
    int m,
    int n,
    int k) {
  const bool b_nmajor = (k == kGateUpK && n == kGateUpN);
  const int64_t total = static_cast<int64_t>(m) * n;
  const int64_t stride = static_cast<int64_t>(gridDim.x) * blockDim.x;
  for (int64_t idx = static_cast<int64_t>(blockIdx.x) * blockDim.x +
                     threadIdx.x;
       idx < total; idx += stride) {
    const int row = static_cast<int>(idx / n);
    const int col = static_cast<int>(idx - static_cast<int64_t>(row) * n);
    int32_t acc = 0;
    const int8_t* a_row = x_q + static_cast<int64_t>(row) * k;
    const int8_t* b_base =
        weight + (b_nmajor ? static_cast<int64_t>(col) * k : col);
    const int64_t b_stride = b_nmajor ? 1 : n;
    for (int kk = 0; kk < k; ++kk) {
      acc += static_cast<int32_t>(a_row[kk]) *
             static_cast<int32_t>(b_base[kk * b_stride]);
    }
    const float scaled =
        static_cast<float>(acc) * x_scale[row] * weight_scale[col];
    out[idx] = __float2bfloat16(scaled);
  }
}

// Bootstrap pack: identity device-to-device copy of the raw [K, N] weight and
// the [N] fp32 scale for every (k, n) pair that is not the assigned gate_up
// pair. Runs outside the timed/CUDA-Graph region.
__global__ __launch_bounds__(kScalarThreads) void
w8a8_pack_identity_kernel(
    const int8_t* __restrict__ raw_weight,
    const float* __restrict__ weight_scale,
    int8_t* __restrict__ packed_weight,
    float* __restrict__ packed_weight_scale,
    int64_t weight_elems,
    int n) {
  const int64_t idx =
      static_cast<int64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
  if (idx < weight_elems) {
    packed_weight[idx] = raw_weight[idx];
  }
  if (idx < n) {
    packed_weight_scale[idx] = weight_scale[idx];
  }
}

// Shape-specific gate_up pack: transpose raw [K, N] -> packed [N, K]
// (n-major rows, k contiguous) for (k, n) == (6144, 512) only. Byte-exact
// index relation: packed[cc * k + kk] == raw[kk * n + cc]. Each thread
// gathers the 16 bytes of one aligned int4 k-block from 16 raw rows (stride
// n) and stores one aligned int4, keeping the packed write side fully
// coalesced. Runs outside the timed/CUDA-Graph region; same byte count, same
// graph-stable buffer.
__global__ __launch_bounds__(kScalarThreads) void
w8a8_pack_gateup_transpose_kernel(
    const int8_t* __restrict__ raw_weight,
    const float* __restrict__ weight_scale,
    int8_t* __restrict__ packed_weight,
    float* __restrict__ packed_weight_scale,
    int k,
    int n) {
  const int k4 = k / static_cast<int>(sizeof(int4));
  const int64_t total4 = static_cast<int64_t>(n) * k4;
  const int64_t stride4 = static_cast<int64_t>(gridDim.x) * blockDim.x;
  for (int64_t idx4 = static_cast<int64_t>(blockIdx.x) * blockDim.x +
                      threadIdx.x;
       idx4 < total4; idx4 += stride4) {
    const int cc = static_cast<int>(idx4 / k4);
    const int kblk = static_cast<int>(idx4 - static_cast<int64_t>(cc) * k4);
    const int kk = kblk * static_cast<int>(sizeof(int4));
    const int8_t* src = raw_weight + static_cast<int64_t>(kk) * n + cc;
    int4 v;
    char* vp = reinterpret_cast<char*>(&v);
#pragma unroll
    for (int i = 0; i < static_cast<int>(sizeof(int4)); ++i) {
      vp[i] = src[static_cast<int64_t>(i) * n];
    }
    reinterpret_cast<int4*>(
        packed_weight + static_cast<int64_t>(cc) * k + kk)[0] = v;
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
  // No split-K: the provided workspace is not touched. The timed operator
  // performs no allocation, synchronization, packing, autotuning, or
  // default-stream launch; only the caller-provided out is written.
  (void)workspace;
  (void)workspace_bytes;
  auto* out_bf16 = static_cast<hip_bfloat16*>(out);

  // Native INT8 DUMMA m16n16k32 tiled path for every shape whose geometry
  // matches the staged 64x64 tiles. The assigned shape (4096, 512, 6144)
  // takes the packed-weight (n-major B) arm with the round-11 64-K stage
  // (kPackedStageK, 10,240 B LDS -> 4 blocks/CU) and the iteration-14 direct
  // 8-byte load_frag8 fragment loader (kDirectFrag); any other matching
  // geometry keeps the identity [K, N] row_major B arm on the 128-K stage
  // with the library loaders. Unmatched geometry and M < 128 fall through to
  // the scalar fallback (no shape is specialized away).
  if (m >= kPrefillMinM && (n % kDefaultBlockN == 0) &&
      (k % kPrefillStageK == 0)) {
    const dim3 grid(n / kDefaultBlockN,
                    (m + kDefaultBlockM - 1) / kDefaultBlockM);
    const dim3 block(kDefaultBlockM * kDefaultBlockN / 1024 * kWaveSize);
    if (k == kGateUpK && n == kGateUpN) {
      hipLaunchKernelGGL(
          HIP_KERNEL_NAME(w8a8_dumma_prefill_tiled_kernel<
                          kDefaultBlockM, kDefaultBlockN, kPackedStageK,
                          true, true>),
          grid, block, 0, stream,
          a, b, x_scale, weight_scale, out_bf16, m, n, k);
    } else {
      hipLaunchKernelGGL(
          HIP_KERNEL_NAME(w8a8_dumma_prefill_tiled_kernel<
                          kDefaultBlockM, kDefaultBlockN, kPrefillStageK,
                          false>),
          grid, block, 0, stream,
          a, b, x_scale, weight_scale, out_bf16, m, n, k);
    }
    return;
  }

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
  // Assigned gate_up weight (K=6144, N=512): one-time [K, N] -> [N, K]
  // transpose pack (n-major, k contiguous) so the timed GEMM reads B
  // fragments as k-contiguous bytes from the staged LDS tile. Runs outside
  // the timed/CUDA-Graph region; same byte count, same graph-stable buffer,
  // byte-exact vs the raw logical [K, N] weight.
  if (k == kGateUpK && n == kGateUpN) {
    const int64_t total4 =
        static_cast<int64_t>(n) * (k / static_cast<int>(sizeof(int4)));
    const unsigned blocks = static_cast<unsigned>(
        (total4 + kScalarThreads - 1) / kScalarThreads);
    hipLaunchKernelGGL(
        w8a8_pack_gateup_transpose_kernel,
        dim3(blocks), dim3(kScalarThreads), 0, stream,
        raw_weight, weight_scale, packed_weight, packed_weight_scale, k, n);
    return;
  }
  // Identity device-to-device copy for every other (k, n) pair, including
  // unmatched (K, N) and the paired M=2/M=16 API tails with the assigned
  // (K, N). Runs outside the timed/CUDA-Graph region.
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
