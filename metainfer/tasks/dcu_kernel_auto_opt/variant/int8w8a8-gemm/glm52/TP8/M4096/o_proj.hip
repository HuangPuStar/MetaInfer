// @@variant shape=glm_tp8_o_proj_m4096 commit=41d2ef9da654ecb15154a974fa11d84df5e4fc5d added=2026-09-14
//   median_us=651.5 p90_us=654.2 speedup=84.07 baseline_us=5.478e+04
//   source=test-9-11-1/iteration_002/glm_tp8_o_proj_m4096
// INT8 W8A8 GEMM HIP implementation for Hygon K500SM_AI / gfx928.
//
// Worker: worker_0 (physical GPU 0), assigned shape:
//   glm_tp8_o_proj_m4096 : M=4096, N=6144, K=2048
//
// Round 1 (establish_arch) established ONE complete, correct DUMMA
// architecture family and measured median 753.83 us:
//
//   * family: packed_weight + staged A/B, 256x64 output macro-tile, native
//     INT8 DUMMA m16n16k32 with int32 accumulation, four 64-lane wavefronts
//     (256 threads);
//   * weight packing (outside the timed region, before Graph capture, via the
//     ABI-preserving launch_pack_w8a8_weight): for the exact (k, n) ==
//     (2048, 6144) the raw logical [K, N] int8 weight is transposed once into
//     the n-major [N, K] layout packed[col * K + kk] = raw[kk * N + col].
//     Same byte count and same caller-owned buffer as the identity layout, so
//     every captured address is graph-stable.  Every other (k, n) keeps the
//     identity device-to-device copy.
//   * fragment fills: the m16n16k32 matrix_a slot for lane (r = lane & 15,
//     kq = lane >> 4) is eight consecutive k bytes at fixed row, and the
//     matrix_b (col_major) slot is eight consecutive k bytes at fixed n on the
//     n-major tile, so BOTH operands use one contiguous 8-byte ds_read_b64 per
//     fragment (load_fragment8) with no per-byte reads and no mask/OR
//     reassembly VALU.
//   * LDS bank safety: both padded strides are odd multiples of 8 bytes
//     (A = 88 = 22 dwords, B = 72 = 18 dwords).  22*r mod 32 and 18*r mod 32
//     over r = 0..15 are permutations of the 16 even dword starts, so each
//     16-lane ds_read_b64 fragment phase lands on 16 distinct bank pairs.
//     Both strides are 8 mod 16, so the 16-byte cooperative staging stores are
//     emitted as two int64 halves (the validated ds_write2_b64 pattern).
//   * fused coalesced epilogue: the 4x4 shfl_xor register transpose keeps the
//     exact per-element multiply order float(dot) * x_scale[row] *
//     weight_scale[col] and bf16 rounding, then one 8-byte store per lane per
//     fragment (100% store-sector efficiency).  Each lane's x_scale rows and
//     weight_scale float4 columns are loaded ONCE into registers on the last
//     K stage, issued before the final protective barrier, so the epilogue
//     reads no scale inside the store chains.  The epilogue is fully fused:
//     no workspace pass, no separate combine kernel.
//
// Round 2 (mandatory decision: operand-reuse round - compare direct loads
// with cooperative A+B LDS staging, quantify A/B reuse per macro-tile, use
// vectorized coalesced global loads with a bank-safe LDS layout):
//
//   FALSIFIABLE BOTTLENECK HYPOTHESIS.  The round-1 kernel is bound by the
//   L2/global operand traffic its macro-tile reuse ratio forces, not by the
//   LDS fragment pipe, not by MMAC issue, and not by HBM.  With a
//   (tileM, tileN) = (256, 64) macro-tile every A byte is re-read N/tileN =
//   96x and every B byte M/tileM = 16x by the 1,536-block grid, i.e.
//   A 805.3 MB + B 201.3 MB = 1,006.6 MB of global reads per operator replay.
//   The exact-source PMC record (digest acb11003..., grid 1,536 x 256
//   threads, 151 VGPR, 27,136 B LDS, 957,746 grbm_gui_active cycles at
//   ~1.29 GHz) shows only 99.3 MB of HBM reads and 50.3 MB of HBM writes
//   (198.5 GB/s counter-derived HBM) against 1,044,480 vmem_read_instructions
//   of 16-B-per-lane coalesced staging, i.e. ~1.07 GB of L2 read traffic in
//   740.5 us (~1.4 TB/s).  HBM is far from its ceiling, so the traffic that
//   matters is the L2-resident operand re-read, and the only structural
//   lever on it is the macro-tile reuse ratio 1/tileM + 1/tileN.
//
//   Direct fragment loads vs cooperative A+B LDS staging.  Direct global
//   fragment fills were rejected without measuring them: the m16n16k32
//   fragment owns the k dimension and lane index, so lane (r, kq) needs
//   8 consecutive k bytes at one row; in a 64-lane wave that is 16 different
//   rows 2,048 B apart per 16-lane group (8 B useful out of a 32-B sector),
//   and each wave reads the same A fragment once per n-group.  Per block that
//   is >= 4x the L2 sectors of the 16-B-per-thread coalesced cooperative
//   staging (which touches every operand byte exactly once per block), before
//   counting the duplicated A reads.  Cooperative A+B staging therefore
//   stays, and this round moves the reuse lever: DOUBLE THE N MACRO-TILE.
//
//   Change (ONE bounded factor: the macro-tile reuse geometry).  The output
//   macro-tile becomes 256x128 at the same 256 threads / 4 wavefronts; the
//   2(m) x 2(n) wave split gives every wave a 128x64 quadrant = 8 m-groups x
//   4 n-groups = 32 m16n16k32 int32 accumulators (the A quadrant height and
//   the 88-byte A stride are unchanged, so the eight A fragment fills per kk
//   keep the exact round-1 addresses; the four B fragment fills per kk are the
//   only new ones).  Global staging stays per-thread 16-byte coalesced int4
//   loads, 6 per thread per stage (A rows [0,64),[64,128),[128,192),[192,256)
//   at k-chunk (tid&3)*16 -- unchanged from round 1 -- plus TWO B bands now:
//   n = b_row0 and b_row0 + 64 at the same k-chunk).  The single-buffered
//   64-K LDS stage becomes A[256,88] = 22,528 B + B[128,72] = 9,216 B =
//   31,744 B/block, both strides unchanged and still bank-safe, and the two
//   int64-half ds_write2_b64 staging stores are unchanged.
//
//   Quantified reuse per macro-tile (bytes of global operand read per
//   operator replay, M*K*(N/tileN) + N*K*(M/tileM)):
//     (256, 64)   ->  A 805.3 MB + B 201.3 MB = 1,006.6 MB   (round 1)
//     (256, 128)  ->  A 402.7 MB + B 201.3 MB =   604.0 MB   (this round, -40%)
//     (128, 128)  ->  A 402.7 MB + B 402.7 MB =   805.3 MB   (rejected: the
//                     halved tileM double-charges B, only -20% total)
//     (512, 64)   ->  A 805.3 MB + B 100.7 MB =   906.0 MB   (rejected: the
//                     unchanged tileN leaves the dominant A term untouched)
//   LDS fragment reads per MMAC also fall from (8+2)/16 = 0.625 to
//   (8+4)/32 = 0.375 per kk, and the block count falls 1,536 -> 768 (still
//   6.4 blocks/CU on the 120-CU part, so split-K remains unnecessary and the
//   caller workspace stays unused; the trusted occupancy-probe split
//   candidates [2,3,4,5] are irrelevant to a grid this wide).
//
//   Expected effect: if the L2 operand-traffic term is the limiter, median
//   moves from ~754 us toward ~500-620 us; if the kernel is instead at the
//   MMAC/LDS-issue floor, the larger tile stays within a few percent (the
//   extra 64 accumulator VGPRs and the 768-block tail are the only costs).
//
// Round 8 (mandatory decision: fix_build - repair the previous round's
// compile/API failure with the smallest source-owned change; no architecture
// change, no redesign).  Rounds 6 and 7 produced no built candidate because the
// worker process was terminated by an infrastructure rate limit, and the
// workspace source was restored to the accepted round-2 kernel.  Round 6's
// intended epilogue change is re-applied with the compile-safety correction
// demanded by this round.  Preserved byte-for-byte: the 256x128 macro-tile,
// 256 threads / 4 wavefronts, 88-byte A and 72-byte B padded strides, the
// single-buffered 64-K LDS stage (A 22,528 B + B 9,216 B = 31,744 B), the
// one-ds_read_b64-per-fragment fills, the 32 int32 m16n16k32 accumulators and
// their exact accumulation order, the two __syncthreads per stage, the exact
// (m,n,k) dispatch guard, the packed n-major weight path and the scalar
// generic fallback.  The only edit is the epilogue conversion.  hip's
// __float2bfloat16 lowers on this DTK to a NaN-guarded exec-masked sequence
// per element (~12 extra SALU/VALU plus a divergent branch region for each of
// the 128 conversions per lane); it is replaced by the branchless
// finite-domain RNE helper bf16_rne_finite_bits, which stores the identical
// 16-bit payload for every finite value this epilogue can produce and can
// differ only for NaN/Inf.  The 4x4 shfl_xor transpose, the per-element
// multiply order float(dot) * x_scale[row] * weight_scale[col], the tail-row
// guard, the 8-byte coalesced store and the dispatch are unchanged.
//
// Generic scalar int8/int32 fallback for every unmatched (m, n, k), including
// all small-M API cases (M=2, M=16) and M=3072 with the same (K, N): it always
// reproduces the exact int32 dot over K in ascending k order, then the fused
// float scale and bf16 store.  For (k, n) == (2048, 6144) it decodes the
// n-major packed layout produced above; every other (k, n) reads the identity
// [K, N] layout.
//
// Rules honored: headers in the known-good order (hip/hip_runtime.h,
// hip/hip_bfloat16.h, du_mma.h); wavefront = 64 and blockDim a multiple of 64;
// int32 accumulation with float conversion only for
// dot * x_scale[m] * weight_scale[n]; hipLaunchKernelGGL on the
// caller-provided PyTorch stream; no allocation / packing / synchronization /
// default-stream launch inside the timed API; no NVIDIA wmma/mma.sync/PTX/
// FP8/INT4 and no raw inline asm; all __syncthreads() on paths reached by
// every block thread; coalesced lanes follow contiguous N addresses; single
// 31,744 B LDS buffer (no double buffering); explicit exact-shape dispatch for
// the assigned shape with a preserved scalar generic fallback.

#include <hip/hip_runtime.h>
#include <hip/hip_bfloat16.h>
#include <du_mma.h>

#include <cstdint>

namespace {

using namespace du::dumma;

constexpr int kTileM = 16;
constexpr int kTileN = 16;
constexpr int kTileK = 32;  // gfx928 INT8 DUMMA primitive: m16n16k32
constexpr int kWaveSize = 64;  // gfx928 native wavefront
constexpr int kTargetM = 4096;
constexpr int kTargetN = 6144;
constexpr int kTargetK = 2048;

// Round 2: 256x128 macro-tile, four wavefronts, single-buffered 64-K stage.
// Doubling the N macro-tile halves the A re-read term M*K*(N/tileN) while the
// unchanged tileM keeps the B term N*K*(M/tileM); total global operand reads
// fall 1,006.6 -> 604.0 MB per replay (-40%).
constexpr int kBlockM = 256;
constexpr int kBlockN = 128;
constexpr int kStageK = 64;
constexpr int kBlockThreads = 4 * kWaveSize;  // 256

// A[256, 88]: m-major, 88 = 22 dwords (odd 8-byte count).  22*r mod 32 over
// r = 0..15 is a permutation of the 16 even dword starts, so every 16-lane
// ds_read_b64 A fragment phase is conflict-free; 88 % 16 == 8 forces the
// two-int64-half (ds_write2_b64) staging store.
constexpr int kAStride = kStageK + 24;  // 64 -> 88-byte A LDS row stride
// B[128, 72]: n-major (row index = n), 72 = 18 dwords.  18*r mod 32 over
// r = 0..15 is the same conflict-free permutation; 72 % 16 == 8 gives the same
// two-int64-half staging store.
constexpr int kBStride = kStageK + 8;  // 64 -> 72-byte B LDS row stride

using bf16_t = hip_bfloat16;

// Direct 8-byte LDS fragment fill.  The m16n16k32 fragment layout assigns
// x[i] = p[(row++) * ldm + col_group*8 + i] (row = lane & 15,
// col_group = lane >> 4), i.e. eight consecutive 8-bit elements per lane on a
// row-major tile.  On the m-major A tile these are eight consecutive k bytes of
// one row; on the n-major B tile (row = n) they are eight consecutive k bytes
// of one column.  Writing those bytes straight into the fragment storage keeps
// the operand bit pattern, the v_mmac inputs and the int32 accumulation order
// identical to the library loader while emitting one ds_read_b64 instead of
// eight per-byte ds_read_u8 plus a mask/OR reassembly chain per dword.
template <typename Frag>
__device__ __forceinline__ void load_fragment8(
    Frag& frag,
    const signed char* __restrict__ base,
    int stride,
    int lane) {
  const int off = (lane & 15) * stride + ((lane >> 4) << 3);
  *reinterpret_cast<unsigned long long*>(&frag.x[0]) =
      *reinterpret_cast<const unsigned long long*>(base + off);
}

// Round 8 (fix_build / epilogue): plain round-to-nearest-even fp32 -> bf16
// conversion without hip's __float2bfloat16 NaN/Inf signaling-bit fixup.  The
// arithmetic (u + 0x7fff + ((u >> 16) & 1)) >> 16 is exactly the finite-domain
// path of DTK's float_2_bfloatraw (exponent bits != all-ones), so every finite
// fp32 input - including +/-0, denormals, and values whose RNE carries into or
// out of the bf16 exponent field - produces the identical 16-bit pattern as
// __float2bfloat16; the outputs can differ only for NaN/Inf inputs, which this
// kernel's epilogue can never produce (|int32 dot| <= K*127^2 and both scale
// inputs are finite, so the scaled accumulator is always finite).  The helper
// is spelled with a union rather than __float_as_uint so it depends on no
// optional device intrinsic; this is the validated formulation from the
// accepted hy3/TP8/M4096 o_proj lineage, not a new architecture.
__device__ __forceinline__ unsigned short bf16_rne_finite_bits(float f) {
  union {
    float fp32;
    unsigned int u32;
  } u = {f};
  u.u32 += 0x7fffu + ((u.u32 >> 16) & 1u);  // round half to even at bit 16
  return static_cast<unsigned short>(u.u32 >> 16);
}

// Fused coalesced fragment store with register-batched scales.  The m16n16k32
// accumulator lane mapping (row = lane & 15, column group c4 = lane >> 4,
// frag.x[i] -> column c4 + 4*i) gives each lane four elements strided by 4
// columns, so a direct store would be four 2-byte scalar stores per lane whose
// wavefront addresses touch each 32-B sector at 25% utilization.  This
// epilogue transposes the 4-element groups within each 4-lane column group
// (lanes r, r+16, r+32, r+48 - a 4x4 transpose, two 2x2 steps with shfl_xor 16
// then 32), so lane (r, c4) ends up holding the four CONTIGUOUS columns
// 4*c4 .. 4*c4+3, converts them to bf16, packs 4 bf16 (8 B), and writes ONE
// 8-byte store per lane (100% store sector efficiency).  Only the int32 values
// are re-routed between lanes; the per-element multiply order
// (float(dot) * x_scale[row] * weight_scale[col]) and the bf16 rounding are
// unchanged, so the stored bits are identical to a direct per-element store.
// xs is this lane's x_scale[row] and ws the float4 at
// weight_scale + base_col + 4*c4, both preloaded once by the caller.  The
// row >= m guard is wavefront-uniform (all 64 lanes share the same 16-row
// window), so the shuffles never mix active and inactive lanes; base_col is a
// multiple of 16 and n*2 a multiple of 8, so the float4 scale load and the
// 8-byte store are aligned.
template <typename AccFragment>
__device__ __forceinline__ void store_prefill_fragment_coalesced_scaled(
    const AccFragment& frag,
    float xs,
    const float4& ws,
    bf16_t* __restrict__ out,
    int base_row,
    int base_col,
    int m,
    int n,
    int lane) {
  const int row = base_row + (lane & 15);
  if (row >= m) {
    return;  // tail-M masking: padded rows never write (wavefront-uniform)
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
  // base_col is a multiple of 16 and n*2 is a multiple of 8).
  const int col0 = base_col + 4 * c4;
  const float v0 = static_cast<float>(f0) * xs * ws.x;
  const float v1 = static_cast<float>(f1) * xs * ws.y;
  const float v2 = static_cast<float>(f2) * xs * ws.z;
  const float v3 = static_cast<float>(f3) * xs * ws.w;
  const uint64_t packed =
      static_cast<uint64_t>(bf16_rne_finite_bits(v0)) |
      (static_cast<uint64_t>(bf16_rne_finite_bits(v1)) << 16) |
      (static_cast<uint64_t>(bf16_rne_finite_bits(v2)) << 32) |
      (static_cast<uint64_t>(bf16_rne_finite_bits(v3)) << 48);
  *reinterpret_cast<uint64_t*>(out + static_cast<int64_t>(row) * n + col0) =
      packed;
}

// ---------------------------------------------------------------------------
// Exact-shape GEMM: 256x128 output tile per block, four wavefronts.
//
// 4 waves: wave_row = (wave >> 1) * 128 covers rows 0..255 in two 128-row
// bands (waves 2w and 2w+1 share the band), wave_col = (wave & 1) * 64 selects
// the 64-column half.  Each wave consumes a 128x64 quadrant: eight m-groups x
// four n-groups = thirty-two m16n16k32 int32 accumulators.  The eight A
// fragment addresses per kk and the 88-byte A stride are byte-identical to
// round 1; only the n-major B tile and its four fragment fills are new.
//
// Staging (6 int4 global loads per thread per stage):
//   A[256, 88]: thread t owns 16-byte A chunks at (row = t >> 2,
//               col = (t & 3) * 16) in each of the four 64-row bands; each
//               store is two int64 halves because 88 % 16 == 8.
//   B[128, 72]: thread t owns the 16-byte k-chunk at (n_row = t >> 2,
//               k16 = (t & 3) * 16) and at n_row + 64 of the packed n-major
//               weight; each store is two int64 halves because 72 % 16 == 8.
// ---------------------------------------------------------------------------
__global__ __launch_bounds__(kBlockThreads)
    void w8a8_dumma_256x128x64_packedb_kernel(
        const int8_t* __restrict__ x_q,
        const int8_t* __restrict__ packed_w,  // [N, K] n-major (exact shape)
        const float* __restrict__ x_scale,
        const float* __restrict__ weight_scale,
        bf16_t* __restrict__ out,
        int m,
        int n,
        int k) {
  const int tid = static_cast<int>(threadIdx.x);
  const int wave = tid / kWaveSize;
  const int lane = tid % kWaveSize;
  const int wave_row = (wave >> 1) * (kBlockM / 2);
  const int wave_col = (wave & 1) * (kBlockN / 2);
  const int m0 = static_cast<int>(blockIdx.y) * kBlockM;
  const int n0 = static_cast<int>(blockIdx.x) * kBlockN;
  const int local_row = wave_row;
  const int local_col = wave_col;

  // Single-buffered 64-K stage: A[256, 88] + B[128, 72] = 31,744 B/block.
  __shared__ __align__(16) int8_t a_tile[kBlockM * kAStride];
  __shared__ __align__(16) int8_t b_tile[kBlockN * kBStride];

  DUFragment<matrix_a, kTileM, kTileN, kTileK, signed char, row_major>
      a_frag0, a_frag1, a_frag2, a_frag3, a_frag4, a_frag5, a_frag6, a_frag7;
  DUFragment<matrix_b, kTileM, kTileN, kTileK, signed char, col_major>
      b_frag0, b_frag1, b_frag2, b_frag3;
  // Thirty-two m16n16k32 int32 accumulators (8 m-groups x 4 n-groups per wave).
  DUFragment<accumulator, kTileM, kTileN, kTileK, int>
      acc00, acc01, acc02, acc03, acc10, acc11, acc12, acc13,
      acc20, acc21, acc22, acc23, acc30, acc31, acc32, acc33,
      acc40, acc41, acc42, acc43, acc50, acc51, acc52, acc53,
      acc60, acc61, acc62, acc63, acc70, acc71, acc72, acc73;
  du_fill_fragment(acc00, 0);
  du_fill_fragment(acc01, 0);
  du_fill_fragment(acc02, 0);
  du_fill_fragment(acc03, 0);
  du_fill_fragment(acc10, 0);
  du_fill_fragment(acc11, 0);
  du_fill_fragment(acc12, 0);
  du_fill_fragment(acc13, 0);
  du_fill_fragment(acc20, 0);
  du_fill_fragment(acc21, 0);
  du_fill_fragment(acc22, 0);
  du_fill_fragment(acc23, 0);
  du_fill_fragment(acc30, 0);
  du_fill_fragment(acc31, 0);
  du_fill_fragment(acc32, 0);
  du_fill_fragment(acc33, 0);
  du_fill_fragment(acc40, 0);
  du_fill_fragment(acc41, 0);
  du_fill_fragment(acc42, 0);
  du_fill_fragment(acc43, 0);
  du_fill_fragment(acc50, 0);
  du_fill_fragment(acc51, 0);
  du_fill_fragment(acc52, 0);
  du_fill_fragment(acc53, 0);
  du_fill_fragment(acc60, 0);
  du_fill_fragment(acc61, 0);
  du_fill_fragment(acc62, 0);
  du_fill_fragment(acc63, 0);
  du_fill_fragment(acc70, 0);
  du_fill_fragment(acc71, 0);
  du_fill_fragment(acc72, 0);
  du_fill_fragment(acc73, 0);

  const int a_row0 = tid >> 2;        // 0..63
  const int a_col = (tid & 3) * 16;   // 0, 16, 32, 48
  const int b_n_row = tid >> 2;       // 0..63
  const int b_k16 = (tid & 3) * 16;   // 0, 16, 32, 48

  const int base_row = m0 + local_row;
  const int base_col = n0 + local_col;

  // Epilogue scale registers: each lane's 32 fragment stores cover the 8
  // m-groups (rows base_row + 16*i + r, r = lane & 15) x 4 n-groups
  // (cols base_col + 16*j + 4*c4, c4 = lane >> 4), so each lane needs exactly
  // 8 x_scale values and 4 weight_scale float4s.  They are loaded once on the
  // last K stage (uniform branch: k0 is block-uniform, so the following
  // barrier is reached by every thread) and reused by all thirty-two coalesced
  // stores; xs_m is zeroed for out-of-range tail rows.
  float xs_m[8];
  float4 ws0, ws1, ws2, ws3;

  for (int k0 = 0; k0 < k; k0 += kStageK) {
    const int4 av0 = *reinterpret_cast<const int4*>(
        x_q + static_cast<int64_t>(m0 + a_row0) * k + k0 + a_col);
    const int4 av1 = *reinterpret_cast<const int4*>(
        x_q + static_cast<int64_t>(m0 + a_row0 + kBlockM / 4) * k + k0 +
        a_col);
    const int4 av2 = *reinterpret_cast<const int4*>(
        x_q + static_cast<int64_t>(m0 + a_row0 + kBlockM / 2) * k + k0 +
        a_col);
    const int4 av3 = *reinterpret_cast<const int4*>(
        x_q + static_cast<int64_t>(m0 + a_row0 + 3 * kBlockM / 4) * k + k0 +
        a_col);
    // A rows are 88 B apart (8 mod 16), so each 16-byte staging store is two
    // int64 halves (ds_write2_b64); a single int4 store would be misaligned on
    // odd rows.
    const int64_t* asrc0 = reinterpret_cast<const int64_t*>(&av0);
    const int64_t* asrc1 = reinterpret_cast<const int64_t*>(&av1);
    const int64_t* asrc2 = reinterpret_cast<const int64_t*>(&av2);
    const int64_t* asrc3 = reinterpret_cast<const int64_t*>(&av3);
    int64_t* adst0 = reinterpret_cast<int64_t*>(
        a_tile + a_row0 * kAStride + a_col);
    int64_t* adst1 = reinterpret_cast<int64_t*>(
        a_tile + (a_row0 + kBlockM / 4) * kAStride + a_col);
    int64_t* adst2 = reinterpret_cast<int64_t*>(
        a_tile + (a_row0 + kBlockM / 2) * kAStride + a_col);
    int64_t* adst3 = reinterpret_cast<int64_t*>(
        a_tile + (a_row0 + 3 * kBlockM / 4) * kAStride + a_col);
    adst0[0] = asrc0[0];
    adst0[1] = asrc0[1];
    adst1[0] = asrc1[0];
    adst1[1] = asrc1[1];
    adst2[0] = asrc2[0];
    adst2[1] = asrc2[1];
    adst3[0] = asrc3[0];
    adst3[1] = asrc3[1];
    // B staging is n-major: 16 consecutive k bytes at fixed n (one coalesced
    // int4 global load from the packed [N, K] weight) in two 64-row bands;
    // row stride 72 is 8 mod 16, so each LDS store is two int64 halves.
    const int4 bv0 = *reinterpret_cast<const int4*>(
        packed_w + static_cast<int64_t>(n0 + b_n_row) * k + k0 + b_k16);
    const int4 bv1 = *reinterpret_cast<const int4*>(
        packed_w + static_cast<int64_t>(n0 + b_n_row + kBlockN / 2) * k + k0 +
        b_k16);
    const int64_t* bsrc0 = reinterpret_cast<const int64_t*>(&bv0);
    const int64_t* bsrc1 = reinterpret_cast<const int64_t*>(&bv1);
    int64_t* bdst0 = reinterpret_cast<int64_t*>(
        b_tile + b_n_row * kBStride + b_k16);
    int64_t* bdst1 = reinterpret_cast<int64_t*>(
        b_tile + (b_n_row + kBlockN / 2) * kBStride + b_k16);
    bdst0[0] = bsrc0[0];
    bdst0[1] = bsrc0[1];
    bdst1[0] = bsrc1[0];
    bdst1[1] = bsrc1[1];
    __syncthreads();

    // Each wave consumes its 128x64 quadrant: eight m-groups x four n-groups,
    // 32 m16n16k32 MMACs per kk, in the exact int32 accumulation order
    // (k0-outer 64, kk-inner 32, hardware k-order inside m16n16k32).  The B
    // fragments are loaded once per kk and reused by all eight m-groups; the A
    // fragments are consumed in two batches of four to bound their live range
    // to eight VGPRs at a time.
#pragma unroll
    for (int kk = 0; kk < kStageK; kk += kTileK) {
      load_fragment8(b_frag0, b_tile + local_col * kBStride + kk, kBStride,
                     lane);
      load_fragment8(b_frag1, b_tile + (local_col + kTileN) * kBStride + kk,
                     kBStride, lane);
      load_fragment8(b_frag2, b_tile + (local_col + 2 * kTileN) * kBStride + kk,
                     kBStride, lane);
      load_fragment8(b_frag3, b_tile + (local_col + 3 * kTileN) * kBStride + kk,
                     kBStride, lane);
      load_fragment8(a_frag0, a_tile + local_row * kAStride + kk, kAStride,
                     lane);
      load_fragment8(a_frag1, a_tile + (local_row + kTileM) * kAStride + kk,
                     kAStride, lane);
      load_fragment8(a_frag2, a_tile + (local_row + 2 * kTileM) * kAStride + kk,
                     kAStride, lane);
      load_fragment8(a_frag3, a_tile + (local_row + 3 * kTileM) * kAStride + kk,
                     kAStride, lane);
      du_mma_sync(acc00, a_frag0, b_frag0, acc00);
      du_mma_sync(acc01, a_frag0, b_frag1, acc01);
      du_mma_sync(acc02, a_frag0, b_frag2, acc02);
      du_mma_sync(acc03, a_frag0, b_frag3, acc03);
      du_mma_sync(acc10, a_frag1, b_frag0, acc10);
      du_mma_sync(acc11, a_frag1, b_frag1, acc11);
      du_mma_sync(acc12, a_frag1, b_frag2, acc12);
      du_mma_sync(acc13, a_frag1, b_frag3, acc13);
      du_mma_sync(acc20, a_frag2, b_frag0, acc20);
      du_mma_sync(acc21, a_frag2, b_frag1, acc21);
      du_mma_sync(acc22, a_frag2, b_frag2, acc22);
      du_mma_sync(acc23, a_frag2, b_frag3, acc23);
      du_mma_sync(acc30, a_frag3, b_frag0, acc30);
      du_mma_sync(acc31, a_frag3, b_frag1, acc31);
      du_mma_sync(acc32, a_frag3, b_frag2, acc32);
      du_mma_sync(acc33, a_frag3, b_frag3, acc33);
      load_fragment8(a_frag4, a_tile + (local_row + 4 * kTileM) * kAStride + kk,
                     kAStride, lane);
      load_fragment8(a_frag5, a_tile + (local_row + 5 * kTileM) * kAStride + kk,
                     kAStride, lane);
      load_fragment8(a_frag6, a_tile + (local_row + 6 * kTileM) * kAStride + kk,
                     kAStride, lane);
      load_fragment8(a_frag7, a_tile + (local_row + 7 * kTileM) * kAStride + kk,
                     kAStride, lane);
      du_mma_sync(acc40, a_frag4, b_frag0, acc40);
      du_mma_sync(acc41, a_frag4, b_frag1, acc41);
      du_mma_sync(acc42, a_frag4, b_frag2, acc42);
      du_mma_sync(acc43, a_frag4, b_frag3, acc43);
      du_mma_sync(acc50, a_frag5, b_frag0, acc50);
      du_mma_sync(acc51, a_frag5, b_frag1, acc51);
      du_mma_sync(acc52, a_frag5, b_frag2, acc52);
      du_mma_sync(acc53, a_frag5, b_frag3, acc53);
      du_mma_sync(acc60, a_frag6, b_frag0, acc60);
      du_mma_sync(acc61, a_frag6, b_frag1, acc61);
      du_mma_sync(acc62, a_frag6, b_frag2, acc62);
      du_mma_sync(acc63, a_frag6, b_frag3, acc63);
      du_mma_sync(acc70, a_frag7, b_frag0, acc70);
      du_mma_sync(acc71, a_frag7, b_frag1, acc71);
      du_mma_sync(acc72, a_frag7, b_frag2, acc72);
      du_mma_sync(acc73, a_frag7, b_frag3, acc73);
    }

    // Last stage only: prefetch the epilogue's per-row x_scale and per-column
    // weight_scale values into registers (uniform branch; the row < m guard
    // keeps the x_scale reads in bounds for any m tail).
    if (k0 + kStageK >= k) {
      const int r = lane & 15;
      const int c4 = lane >> 4;
#pragma unroll
      for (int i = 0; i < 8; ++i) {
        const int row = base_row + i * kTileM + r;
        xs_m[i] = (row < m) ? x_scale[row] : 0.0f;
      }
      ws0 = *reinterpret_cast<const float4*>(weight_scale + base_col +
                                             4 * c4);
      ws1 = *reinterpret_cast<const float4*>(weight_scale + base_col +
                                             kTileN + 4 * c4);
      ws2 = *reinterpret_cast<const float4*>(weight_scale + base_col +
                                             2 * kTileN + 4 * c4);
      ws3 = *reinterpret_cast<const float4*>(weight_scale + base_col +
                                             3 * kTileN + 4 * c4);
    }

    // Protect the LDS buffer from the next stage's cooperative overwrite.
    __syncthreads();
  }

  store_prefill_fragment_coalesced_scaled(acc00, xs_m[0], ws0, out, base_row,
                                          base_col, m, n, lane);
  store_prefill_fragment_coalesced_scaled(acc01, xs_m[0], ws1, out, base_row,
                                          base_col + kTileN, m, n, lane);
  store_prefill_fragment_coalesced_scaled(acc02, xs_m[0], ws2, out, base_row,
                                          base_col + 2 * kTileN, m, n, lane);
  store_prefill_fragment_coalesced_scaled(acc03, xs_m[0], ws3, out, base_row,
                                          base_col + 3 * kTileN, m, n, lane);
  store_prefill_fragment_coalesced_scaled(acc10, xs_m[1], ws0, out,
                                          base_row + kTileM, base_col, m, n,
                                          lane);
  store_prefill_fragment_coalesced_scaled(acc11, xs_m[1], ws1, out,
                                          base_row + kTileM,
                                          base_col + kTileN, m, n, lane);
  store_prefill_fragment_coalesced_scaled(acc12, xs_m[1], ws2, out,
                                          base_row + kTileM,
                                          base_col + 2 * kTileN, m, n, lane);
  store_prefill_fragment_coalesced_scaled(acc13, xs_m[1], ws3, out,
                                          base_row + kTileM,
                                          base_col + 3 * kTileN, m, n, lane);
  store_prefill_fragment_coalesced_scaled(acc20, xs_m[2], ws0, out,
                                          base_row + 2 * kTileM, base_col, m,
                                          n, lane);
  store_prefill_fragment_coalesced_scaled(acc21, xs_m[2], ws1, out,
                                          base_row + 2 * kTileM,
                                          base_col + kTileN, m, n, lane);
  store_prefill_fragment_coalesced_scaled(acc22, xs_m[2], ws2, out,
                                          base_row + 2 * kTileM,
                                          base_col + 2 * kTileN, m, n, lane);
  store_prefill_fragment_coalesced_scaled(acc23, xs_m[2], ws3, out,
                                          base_row + 2 * kTileM,
                                          base_col + 3 * kTileN, m, n, lane);
  store_prefill_fragment_coalesced_scaled(acc30, xs_m[3], ws0, out,
                                          base_row + 3 * kTileM, base_col, m,
                                          n, lane);
  store_prefill_fragment_coalesced_scaled(acc31, xs_m[3], ws1, out,
                                          base_row + 3 * kTileM,
                                          base_col + kTileN, m, n, lane);
  store_prefill_fragment_coalesced_scaled(acc32, xs_m[3], ws2, out,
                                          base_row + 3 * kTileM,
                                          base_col + 2 * kTileN, m, n, lane);
  store_prefill_fragment_coalesced_scaled(acc33, xs_m[3], ws3, out,
                                          base_row + 3 * kTileM,
                                          base_col + 3 * kTileN, m, n, lane);
  store_prefill_fragment_coalesced_scaled(acc40, xs_m[4], ws0, out,
                                          base_row + 4 * kTileM, base_col, m,
                                          n, lane);
  store_prefill_fragment_coalesced_scaled(acc41, xs_m[4], ws1, out,
                                          base_row + 4 * kTileM,
                                          base_col + kTileN, m, n, lane);
  store_prefill_fragment_coalesced_scaled(acc42, xs_m[4], ws2, out,
                                          base_row + 4 * kTileM,
                                          base_col + 2 * kTileN, m, n, lane);
  store_prefill_fragment_coalesced_scaled(acc43, xs_m[4], ws3, out,
                                          base_row + 4 * kTileM,
                                          base_col + 3 * kTileN, m, n, lane);
  store_prefill_fragment_coalesced_scaled(acc50, xs_m[5], ws0, out,
                                          base_row + 5 * kTileM, base_col, m,
                                          n, lane);
  store_prefill_fragment_coalesced_scaled(acc51, xs_m[5], ws1, out,
                                          base_row + 5 * kTileM,
                                          base_col + kTileN, m, n, lane);
  store_prefill_fragment_coalesced_scaled(acc52, xs_m[5], ws2, out,
                                          base_row + 5 * kTileM,
                                          base_col + 2 * kTileN, m, n, lane);
  store_prefill_fragment_coalesced_scaled(acc53, xs_m[5], ws3, out,
                                          base_row + 5 * kTileM,
                                          base_col + 3 * kTileN, m, n, lane);
  store_prefill_fragment_coalesced_scaled(acc60, xs_m[6], ws0, out,
                                          base_row + 6 * kTileM, base_col, m,
                                          n, lane);
  store_prefill_fragment_coalesced_scaled(acc61, xs_m[6], ws1, out,
                                          base_row + 6 * kTileM,
                                          base_col + kTileN, m, n, lane);
  store_prefill_fragment_coalesced_scaled(acc62, xs_m[6], ws2, out,
                                          base_row + 6 * kTileM,
                                          base_col + 2 * kTileN, m, n, lane);
  store_prefill_fragment_coalesced_scaled(acc63, xs_m[6], ws3, out,
                                          base_row + 6 * kTileM,
                                          base_col + 3 * kTileN, m, n, lane);
  store_prefill_fragment_coalesced_scaled(acc70, xs_m[7], ws0, out,
                                          base_row + 7 * kTileM, base_col, m,
                                          n, lane);
  store_prefill_fragment_coalesced_scaled(acc71, xs_m[7], ws1, out,
                                          base_row + 7 * kTileM,
                                          base_col + kTileN, m, n, lane);
  store_prefill_fragment_coalesced_scaled(acc72, xs_m[7], ws2, out,
                                          base_row + 7 * kTileM,
                                          base_col + 2 * kTileN, m, n, lane);
  store_prefill_fragment_coalesced_scaled(acc73, xs_m[7], ws3, out,
                                          base_row + 7 * kTileM,
                                          base_col + 3 * kTileN, m, n, lane);
}

// ---------------------------------------------------------------------------
// Generic scalar fallback: one thread per output element.  Exact int32 dot
// over K in ascending k order, then fused x_scale * weight_scale, then bf16
// store.  Handles every unmatched (m, n, k), including all small-M API cases
// (M=2, M=16) and any M with the same (K, N).  For the exact
// (k, n) == (2048, 6144) the packed_weight buffer holds the n-major transpose
// packed[col * K + kk] = raw[kk * N + col] (produced once outside the timed
// region), which this fallback decodes; every other (k, n) keeps the identity
// [K, N] row-major layout.
// ---------------------------------------------------------------------------
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
  const bool packed_nmajor = (k == kTargetK && n == kTargetN);
  const int8_t* b_ptr =
      packed_nmajor ? weight + static_cast<int64_t>(col) * k : weight + col;
  const int b_stride = packed_nmajor ? 1 : n;
  for (int kk = 0; kk < k; ++kk) {
    acc += static_cast<int32_t>(a_row[kk]) * static_cast<int32_t>(b_ptr[0]);
    b_ptr += b_stride;
  }
  const float scaled =
      static_cast<float>(acc) * x_scale[row] * weight_scale[col];
  out[linear] = __float2bfloat16(scaled);
}

// ---------------------------------------------------------------------------
// Weight packing, executed once by the trusted binding before Graph capture
// and never inside launch_w8a8_gemm.  The packed buffer keeps the same byte
// count as the raw [K, N] weight, so captured addresses are graph-stable.
// ---------------------------------------------------------------------------

// Generic identity device-to-device copy for every (k, n) that has no
// specialized packing.
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

// Exact-shape n-major transpose for (k, n) == (2048, 6144):
// packed[col * k + kk] = raw[kk * n + col].  One thread per output byte.
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

// The [N] weight scale needs no layout change.
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
  (void)workspace;  // no split-K: the GEMM does not use the workspace
  (void)workspace_bytes;
  auto* out_bf16 = reinterpret_cast<bf16_t*>(out);

  // Explicit exact-shape dispatch.  The assigned shape (M=4096, N=6144,
  // K=2048) takes the 256x128 packed-B DUMMA path, which consumes the n-major
  // packed [N, K] weight produced by launch_pack_w8a8_weight.  Every other
  // (m, n, k) - including small-M API cases (M=2, M=16) and M=3072 with the
  // same (K, N) - takes the scalar fallback, which decodes the n-major packed
  // layout when (k, n) == (2048, 6144) and the identity [K, N] layout
  // otherwise.
  if (m == kTargetM && n == kTargetN && k == kTargetK) {
    const dim3 grid(kTargetN / kBlockN, kTargetM / kBlockM);
    const dim3 block(kBlockThreads);
    hipLaunchKernelGGL(w8a8_dumma_256x128x64_packedb_kernel,
                       grid, block, 0, stream,
                       a, b, x_scale, weight_scale, out_bf16, m, n, k);
  } else {
    constexpr int kBlock = 256;
    const int64_t total = static_cast<int64_t>(m) * n;
    const dim3 grid(static_cast<unsigned>((total + kBlock - 1) / kBlock));
    const dim3 block(kBlock);
    hipLaunchKernelGGL(w8a8_gemm_scalar_fallback_kernel,
                       grid, block, 0, stream,
                       a, b, x_scale, weight_scale, out_bf16, m, n, k);
  }
  (void)hipGetLastError();
}

extern "C" void launch_pack_w8a8_weight(
    const int8_t* raw_weight,
    const float* weight_scale,
    int8_t* packed_weight,
    float* packed_weight_scale,
    int k,
    int n,
    hipStream_t stream) {
  // For the exact (k, n) == (2048, 6144) the logical [K, N] weight is
  // transposed once, outside the timed region and outside Graph capture, into
  // the n-major [N, K] layout packed[col * k + kk] = raw[kk * n + col] (same
  // byte count and same caller-owned buffer -> graph-stable addresses), so
  // every col_major B fragment is 8 contiguous K bytes; every other (k, n)
  // keeps the identity device-to-device copy.
  constexpr int kBlock = 256;
  const dim3 block(kBlock);

  const int64_t weight_count = static_cast<int64_t>(k) * n;
  const dim3 weight_grid(
      static_cast<unsigned>((weight_count + kBlock - 1) / kBlock));
  if (k == kTargetK && n == kTargetN) {
    hipLaunchKernelGGL(w8a8_pack_nmajor_i8_kernel,
                       weight_grid, block, 0, stream,
                       raw_weight, packed_weight, k, n);
  } else {
    hipLaunchKernelGGL(w8a8_pack_identity_kernel,
                       weight_grid, block, 0, stream,
                       raw_weight, packed_weight, weight_count);
  }

  const int64_t scale_count = n;
  const dim3 scale_grid(
      static_cast<unsigned>((scale_count + kBlock - 1) / kBlock));
  hipLaunchKernelGGL(w8a8_pack_scale_identity_kernel,
                     scale_grid, block, 0, stream,
                     weight_scale, packed_weight_scale, n);
  (void)hipGetLastError();
}
// @@end
