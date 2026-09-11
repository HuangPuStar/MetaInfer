// @@variant shape=hy3_tp4_shared_down_proj_m16 commit=49c8cf883f92c0d9a791c78c94e84604b8eafc17 added=2026-09-10
//   median_us=8.489 p90_us=8.888 speedup=2.735 baseline_us=23.22
//   source=test-9-8-8-803e5cee/iteration_001/hy3_tp4_shared_down_proj_m16
// INT8 W8A8 GEMM implementation for Hygon K500SM_AI / gfx928.
//
// Parallel-explore child worker_3, physical GPU 3.
// Assigned shape: hy3_tp4_shared_down_proj_m16  (M=16, N=4096, K=384).
//
// Iteration 11 = HIP-only occupancy-consolidation round.  The accepted
// iteration-3 kernel (median 9.092 us, one 64-lane wave per 16x16 tile,
// grid 256 = 256 wavefronts over the measured 120 CUs -> only ~2.13 resident
// waves/CU, i.e. ~0.53 waves per SIMD) is per-wave memory-latency bound:
// iteration 2 doubled resident wavefronts with in-block split-K=2 and moved
// nothing (0.148%, 512 waves = only ~1.07 waves/SIMD - still no inter-wave
// latency hiding), iteration 4 halved the grid to 128 (two N-tiles per wave
// sharing A) and regressed -25.1% (12.140 us), iteration 5 replaced the
// per-step B global waits with a block-head B-only LDS stage and regressed
// -18.97% (11.220 us), iteration 7 split the accumulator into two independent
// 6-deep v_mmac chains (regressed -2.67%, 9.341 us - the serial mma chain is
// NOT the binding constraint), and iteration 10 reordered all 12 cold-B loads
// into a one-burst register preload and regressed -38% (14.719 us - a
// front-loaded load burst starves the interleaved schedule).  The fresh
// current-best ISA (arch_vgpr 24, sgpr 32, 0 scratch, 0 LDS, grid 256) shows
// each wave issues ~220 VALU + 24 global_load_dwordx2 + 12 v_mmac around 27
// s_waitcnt and that the packed [N][K] B stream is cold per replay; with only
// ~0.5 resident wavefronts per SIMD each wave's per-step B-load vmcnt wait is
// exposed with no co-resident wave to fill it.
//
// This round consolidates the two best-measured mechanisms into one kernel:
// the iteration-3 packed-B fast path (direct col_major 8-byte fragment loads,
// exact int32 accumulation) is launched with the iteration-2 in-block split-K
// combine (validated, bit-exact LDS int32 plane merge) raised to split-K=4
// from the trusted occupancy-probe set {2,3,4,6} that divides the 12-step
// K=384 loop: blockDim 256 = four 64-lane wavefronts, grid 256, each wave
// accumulates one K quarter (96 = 3 m16n16k32 steps, K ascending) and one
// __syncthreads() orders the four int32 partial planes before all 256 lanes
// sum them in ascending-K order and store coalesced bf16.  256 blocks x 4
// waves = 1024 resident wavefronts (~8.5 waves/CU = ~2.1 waves/SIMD) so each
// SIMD can overlap one wave's B-load/mma stalls with a co-resident wave's
// work, while per-wave serial K depth drops 12 -> 3 steps.  HBM traffic is
// unchanged (each block's [16 n x 384 k] B pack slice is still read exactly
// once, A is read once per tile from L2, the 4 KiB partial planes stay
// on-chip), the epilogue store becomes fully coalesced row-major, and the
// int32 result is bit-identical to iteration 3 (no overflow: each partial is
// bounded by 96*127*127 << 2^31, and the quarter sums are combined in
// ascending-K wave order), so the scaled bf16 output stays bit-identical.
//
// Iteration 3 = data-layout + epilogue round.  The accepted iteration-1/2
// one-wave and two-wave split-K=2 DUMMA kernels (median 21.656 / 21.624 us)
// both load the B fragment directly from the *logical row-major [K][N]*
// weight with du_load_matrix_sync(matrix_b, row_major).  In that layout each
// lane's 8 fragment bytes are strided by N, so the compiler expands every B
// fragment load into ~8 scalar `global_load_ubyte` instructions plus
// reassembly, with a vmcnt wait burst before each v_mmac (PMC: 50,432 vmem
// reads / 27.36 us profiled; static ISA shows 16+ ubyte loads + 13-16
// waitcnts per K step).  Iteration-2 measured that doubling resident
// wavefronts via in-block split-K=2 changes nothing (0.148%) -> the binding
// constraint is per-wave load vectorization / issue cost, NOT grid
// parallelism.  This round removes both remaining structural costs:
//
//   * B is packed ONCE, outside the timed region, by launch_pack_w8a8_weight
//     for the exact (k, n) == (384, 4096) pair into the [N][K] n-major
//     transpose  P[n*384 + k] = W[k*4096 + n].  The M=16 DUMMA arm then loads
//     B fragments with du_load_matrix_sync(matrix_b, col_major) over P: each
//     lane's 8 fragment bytes are contiguous in P -> one 8-byte load per lane
//     per m16n16k32 step instead of the strided byte-load expansion.
//   * The epilogue drops the LDS int32 materialization + __syncthreads +
//     LDS read-back entirely and instead uses the verified gfx928 int8
//     m16n16k32 accumulator ownership (lane%16 = row, lane/16 = col%4,
//     frag.x[i] = column col%4 + 4*i): every lane fuses the fp32 scale and
//     bf16 conversion directly on its four register accumulators.  Kernel
//     static LDS becomes 0 B and there are no barriers anywhere.
//
// Geometry stays the proven iteration-1 shape: one 64-lane wavefront owns one
// 16x16 output tile, grid = N/16 = 256 blocks, explicit int32 accumulation
// over K ascending in 12 fully-unrolled m16n16k32 steps (bit-exact int8 dot
// -> bit-identical bf16 output, 0 mismatches expected), no cross-wave
// barrier.  The scalar kernel below is retained as the generic fallback for
// every unmatched (m, n, k), especially the paired M=2 API shape with the
// same (N, K); it decodes the n-major pack for (k, n) == (384, 4096) via a
// b_transposed flag and reads the identity row-major [K][N] layout for every
// other pair.  Shape-specialized launches stay behind exact (m, n, k)
// guards.
//
// Two stable host symbols are provided (declared in csrc/bindings.cpp):
//   launch_w8a8_gemm(...)            -- timed / CUDA-Graph-captured GEMM
//   launch_pack_w8a8_weight(...)     -- out-of-timed-region weight packing
// The pack is the [N][K] n-major transpose for the exact (k, n) == (384,4096)
// pair and an identity device copy otherwise; packing never occurs inside
// gemm_out.
//
// Graph-safety: gemm_out launches only on the caller-provided stream, touches
// only caller-provided tensors/workspace, and performs no allocation,
// compilation, autotuning, packing, or host/device synchronization.

// Known-good include order for this DTK: hip_runtime.h must precede
// hip_bfloat16.h and du_mma.h (du_mma.h is not self-contained otherwise).
#include <hip/hip_runtime.h>
#include <hip/hip_bfloat16.h>
#include <du_mma.h>

#include <cstdint>

namespace {

// gfx928 wavefront is 64 lanes; block size must be a multiple of 64.
constexpr int kWaveSize = 64;
constexpr int kScalarBlockThreads = 256;

// DUMMA INT8 hardware tile consumed by one wavefront per mma step.
constexpr int kTileM = 16;
constexpr int kTileN = 16;
constexpr int kTileK = 32;

// Exact guard constants for the assigned (K, N) pair: (384, 4096).
constexpr int kPackK = 384;
constexpr int kPackN = 4096;

// ---------------------------------------------------------------------------
// gfx928 DUMMA INT8 m16n16k32 in-block split-K=4 kernel (assigned-shape fast
// path, iteration 11).
//
//   acc[m, n] = sum_{kk=0}^{k-1} int32(a[m* k + kk]) * int32(b[kk*n + n0+n])
//   out[m, n0+n] = bf16( float(acc[m, n]) * x_scale[m] * weight_scale[n0+n] )
//
// Block geometry: blockDim = 256 (four 64-lane wavefronts), grid = n/16
// output tiles, split-K = 4 along K.  Wave w accumulates the K quarter
// [w*96, (w+1)*96) in ascending kTileK steps (K=384 -> 96 per wave = 3
// du_mma_sync steps), reading A row_major from the logical x_q and B
// col_major from the exact-shape [N][K] n-major pack exactly as the accepted
// iteration-3 one-wave kernel does at the same k offsets (one contiguous
// 8-byte global load per lane per step).  All four waves then publish their
// int32 partial to LDS with du_store_matrix_sync(mem_row_major), a single
// __syncthreads() orders the planes, and every one of the 256 lanes sums the
// four partials in ascending-K wave order (partial 0 = K [0,96), ..., partial
// 3 = K [288,384) -> bit-exact full-K int8 dot, identical to the iteration-3
// 12-step chain because no intermediate sum overflows int32) and writes its
// one scaled bf16 element with a coalesced row-major store.  No barrier
// exists inside the K loop; the sole __syncthreads() is reached by every
// block thread between the partial store and the combine.
//
// Occupancy consolidation: 256 blocks x 4 waves = 1024 resident wavefronts
// (~8.5 waves/CU ~= 2.1 waves/SIMD on the measured 120 CUs) instead of the
// iteration-3 ~0.53 waves/SIMD, so a wave's per-step cold-B vmcnt waits can
// be overlapped by the co-resident wave on the same SIMD, and each wave's
// serial mma depth is 3 steps instead of 12.  The 4 KiB LDS partial planes
// are on-chip (no HBM traffic change) and the kernel stays one launch, one
// barrier, graph-safe, behind the exact (m, n, k) guard.
// ---------------------------------------------------------------------------
constexpr int kSplitK = 4;  // trusted occupancy-probe split that divides the
                            // 12-step K loop and reaches ~2 waves/SIMD
constexpr int kStepsPerWave = (kPackK / kTileK) / kSplitK;  // 12 / 4 = 3

__global__ __launch_bounds__(kSplitK * kWaveSize) void
w8a8_dumma_m16n16k32_sk4_kernel(
    const int8_t* __restrict__ a,          // [16, 384] row-major int8 activations
    const int8_t* __restrict__ b,          // packed [4096, 384] n-major int8 weight
    const float* __restrict__ x_scale,     // [16] fp32 per-row scale
    const float* __restrict__ weight_scale,  // [4096] fp32 per-col scale
    __hip_bfloat16* __restrict__ out,      // [16, 4096] bf16 result
    int n) {
  const int tid = static_cast<int>(threadIdx.x);  // 0..255 (four 64-lane waves)
  const int wave = tid / kWaveSize;               // hardware wave id: 0..3
  const int n0 = static_cast<int>(blockIdx.x) * kTileN;  // this tile's columns

  __shared__ __align__(16) int32_t part[kSplitK][kTileM * kTileN];  // 4 KiB

  using namespace du::dumma;
  DUFragment<matrix_a, kTileM, kTileN, kTileK, signed char, row_major> a_frag;
  DUFragment<matrix_b, kTileM, kTileN, kTileK, signed char, col_major> b_frag;
  DUFragment<accumulator, kTileM, kTileN, kTileK, int> acc_frag;
  du_fill_fragment(acc_frag, 0);

  // The col_major B loader adds (lane%16)*ldm internally, so the pointer is
  // the tile base only: P[n0*384 + k + (lane%16)*384 + (lane>>4)*8 + i],
  // i.e. each lane's 8 fragment bytes are contiguous in P (8-byte aligned) ->
  // one 8-byte global load per lane per step.  This launch is guarded to the
  // exact (m, n, k) == (16, 4096, 384) shape, so each wave's K quarter
  // [wave*96, wave*96 + 96) is a whole number of kTileK steps.
  const int64_t b_tile_base = static_cast<int64_t>(n0) * kPackK;
  const int kStart = wave * kStepsPerWave * kTileK;

  // K quarter, ascending, exactly as the iteration-3 one-wave kernel at the
  // same k offsets (per-wave partial is bit-identical to that chain's prefix).
#pragma unroll
  for (int s = 0; s < kStepsPerWave; ++s) {
    const int koff = kStart + s * kTileK;
    // a + koff: 16 A rows (stride 384), columns = K slice [koff, koff + 32).
    du_load_matrix_sync(a_frag, a + koff, kPackK);
    du_load_matrix_sync(b_frag, b + b_tile_base + koff, kPackK);
    du_mma_sync(acc_frag, a_frag, b_frag, acc_frag);
  }

  // Publish this wave's int32 partial for K quarter [kStart, kStart + 96)
  // (ascending) into its own LDS plane.  Row-major [16][16] plane layout with
  // ldm = 16 matches du_store_matrix_sync(mem_row_major) exactly as in the
  // accepted split-K=2 lineage.
  du_store_matrix_sync(&part[wave][0], acc_frag, kTileN, mem_row_major);
  __syncthreads();

  // All 256 lanes combine the four partials in ascending split order (wave 0
  // = K [0, 96) ... wave 3 = K [288, 384) -> bit-exact full-K int32 dot) and
  // emit one scaled bf16 element each with a coalesced row-major store:
  // adjacent 16-lane groups write consecutive columns of one output row.
  const int row = tid / kTileN;      // 0..15
  const int col = tid - row * kTileN;  // 0..15
  const int32_t acc =
      part[0][tid] + part[1][tid] + part[2][tid] + part[3][tid];
  const float scaled =
      static_cast<float>(acc) * x_scale[row] * weight_scale[n0 + col];
  out[static_cast<int64_t>(row) * n + n0 + col] = __float2bfloat16(scaled);
}

void launch_dumma_m16n16_gemm(
    const int8_t* a,
    const int8_t* b,
    const float* x_scale,
    const float* weight_scale,
    void* out,
    int n,
    hipStream_t stream) {
  const unsigned int blocks = static_cast<unsigned int>(n / kTileN);
  hipLaunchKernelGGL(
      HIP_KERNEL_NAME(w8a8_dumma_m16n16k32_sk4_kernel),
      dim3(blocks),
      dim3(kSplitK * kWaveSize),
      0,
      stream,
      a,
      b,
      x_scale,
      weight_scale,
      static_cast<__hip_bfloat16*>(out),
      n);
}

// ---------------------------------------------------------------------------
// Scalar int8 dot-product kernel (generic fallback for every unmatched shape).
//
//   acc(row,col) = sum_{kk=0}^{k-1} int32(a[row*k + kk]) * int32(b[kk*n + col])
//   out[row*n + col] = bf16( (float)acc * x_scale[row] * weight_scale[col] )
//
// x_scale is the [M,1] fp32 per-token scale (contiguous -> M floats);
// weight_scale is the [N,1] fp32 per-output-channel scale (-> N floats).
// b is the packed buffer produced by launch_pack_w8a8_weight: for the exact
// (k, n) == (384, 4096) pair it is the [N][K] n-major transpose
// P[n*384 + k] = W[k*4096 + n] (logical column col starts at P[col*384] with
// unit stride); every other pair keeps the identity row-major [K][N] layout
// (logical column col has stride n).  The b_transposed branch is hoisted out
// of the K loop by the compiler.
//
// The maximum assigned K keeps the exact int8 dot well inside int32 range;
// int32 -> float is exact here, so converting only at the very end after the
// two fp32 scale multiplies matches the reference
//   (A.float() @ B.float()) * x_scale * weight_scale.T  ->  bfloat16.
// ---------------------------------------------------------------------------
__global__ __launch_bounds__(kScalarBlockThreads) void
w8a8_gemm_scalar_kernel(
    const int8_t* __restrict__ a,        // [M, K] row-major int8 activations
    const int8_t* __restrict__ b,        // packed weight buffer (see above)
    const float* __restrict__ x_scale,   // [M]   fp32 per-row scale
    const float* __restrict__ weight_scale,  // [N] fp32 per-col scale
    __hip_bfloat16* __restrict__ out,    // [M, N] bf16 result
    int m,
    int n,
    int k,
    int b_transposed) {
  const int64_t linear =
      static_cast<int64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
  const int64_t total = static_cast<int64_t>(m) * n;
  if (linear >= total) {
    return;  // tail guard for shapes where M*N is not a block multiple
  }
  const int row = static_cast<int>(linear / n);
  const int col = static_cast<int>(linear - static_cast<int64_t>(row) * n);

  const int8_t* __restrict__ a_row = a + static_cast<int64_t>(row) * k;
  const int8_t* __restrict__ b_col =
      b + (b_transposed ? static_cast<int64_t>(col) * k : col);
  const int64_t b_stride = b_transposed ? 1 : static_cast<int64_t>(n);

  int32_t acc = 0;
  for (int kk = 0; kk < k; ++kk) {
    acc += static_cast<int32_t>(a_row[kk]) *
           static_cast<int32_t>(b_col[static_cast<int64_t>(kk) * b_stride]);
  }

  // Scale in fp32 exactly as the reference does (dot first, then x_scale,
  // then weight_scale), then store bf16.
  const float scaled = static_cast<float>(acc) *
                       x_scale[row] * weight_scale[col];
  out[linear] = __float2bfloat16(scaled);
}

void launch_scalar_gemm(
    const int8_t* a,
    const int8_t* b,
    const float* x_scale,
    const float* weight_scale,
    void* out,
    int m,
    int n,
    int k,
    int b_transposed,
    hipStream_t stream) {
  const int64_t total = static_cast<int64_t>(m) * static_cast<int64_t>(n);
  if (total == 0) {
    return;
  }
  const unsigned int blocks = static_cast<unsigned int>(
      (total + kScalarBlockThreads - 1) / kScalarBlockThreads);
  hipLaunchKernelGGL(
      HIP_KERNEL_NAME(w8a8_gemm_scalar_kernel),
      dim3(blocks),
      dim3(kScalarBlockThreads),
      0,
      stream,
      a,
      b,
      x_scale,
      weight_scale,
      static_cast<__hip_bfloat16*>(out),
      m,
      n,
      k,
      b_transposed);
}

// ---------------------------------------------------------------------------
// Packing helpers (run out of the timed region / Graph).
// ---------------------------------------------------------------------------

// Simple device-to-device copy used by the identity packing (every (K, N)
// pair that is not the exact-shape transpose pair, plus all scales).
template <typename T>
__global__ __launch_bounds__(kScalarBlockThreads) void
w8a8_identity_copy_kernel(const T* __restrict__ src,
                          T* __restrict__ dst,
                          int64_t numel) {
  const int64_t i =
      static_cast<int64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
  if (i < numel) {
    dst[i] = src[i];
  }
}

// Exact-shape pack: writes the [N][K] transpose
//   dst[n*K + k] = src[k*N + n]
// for (k, n) == (384, 4096).  One thread per 16-byte k-chunk of one column;
// runs once per weight outside the timed region/Graph, so the strided byte
// loads are acceptable.  All other shapes keep the identity copy kernel.
__global__ __launch_bounds__(kScalarBlockThreads) void
w8a8_pack_b_transpose_kernel(const int8_t* __restrict__ src,
                             int8_t* __restrict__ dst,
                             int k,
                             int n) {
  const int kchunks = (k + 15) >> 4;
  const int64_t total = static_cast<int64_t>(n) * kchunks;
  const int64_t stride =
      static_cast<int64_t>(gridDim.x) * static_cast<int64_t>(blockDim.x);
  for (int64_t t = static_cast<int64_t>(blockIdx.x) * blockDim.x +
                   static_cast<int64_t>(threadIdx.x);
       t < total; t += stride) {
    const int col = static_cast<int>(t / kchunks);
    const int k0 = static_cast<int>(t % kchunks) * 16;
    alignas(16) int8_t chunk[16];
#pragma unroll
    for (int j = 0; j < 16; ++j) {
      chunk[j] = src[(static_cast<int64_t>(k0) + j) * n + col];
    }
    *reinterpret_cast<int4*>(dst + static_cast<int64_t>(col) * k + k0) =
        *reinterpret_cast<const int4*>(chunk);
  }
}

}  // namespace

// ---------------------------------------------------------------------------
// Optional out-of-timed-region weight packing entry point (registered as
// torch.ops.zth_w8a8.pack_weight through the trusted csrc/bindings.cpp).
// For the exact (k, n) == (384, 4096) pair it produces the [N][K] n-major
// transpose  P[n*384 + k] = W[k*4096 + n]  that the M=16 DUMMA arm (col_major
// B fragments) and the scalar fallback (b_transposed flag) both decode; every
// other (K, N) keeps the identity layout, and all scales keep the identity
// copy.  Asynchronous on the caller's stream: no host/device
// synchronization.
// ---------------------------------------------------------------------------
extern "C" void launch_pack_w8a8_weight(
    const int8_t* raw_weight,
    const float* weight_scale,
    int8_t* packed_weight,
    float* packed_weight_scale,
    int k,
    int n,
    hipStream_t stream) {
  const int64_t weight_numel = static_cast<int64_t>(k) * n;
  const dim3 block(kScalarBlockThreads);
  const dim3 weight_grid(static_cast<unsigned>(
      (weight_numel + kScalarBlockThreads - 1) / kScalarBlockThreads));
  if (k == kPackK && n == kPackN) {
    // Exact-shape pack: [N][K] transpose P[n*384 + k] = W[k*4096 + n], so
    // every B fragment is one contiguous 8-byte load per lane per step.
    hipLaunchKernelGGL(
        HIP_KERNEL_NAME(w8a8_pack_b_transpose_kernel),
        weight_grid, block, 0, stream,
        raw_weight, packed_weight, k, n);
  } else {
    hipLaunchKernelGGL(
        HIP_KERNEL_NAME(w8a8_identity_copy_kernel<int8_t>),
        weight_grid, block, 0, stream,
        raw_weight, packed_weight, weight_numel);
  }

  const dim3 scale_grid(static_cast<unsigned>(
      (n + kScalarBlockThreads - 1) / kScalarBlockThreads));
  hipLaunchKernelGGL(
      HIP_KERNEL_NAME(w8a8_identity_copy_kernel<float>),
      scale_grid, block, 0, stream,
      weight_scale, packed_weight_scale, n);
}

// ---------------------------------------------------------------------------
// Timed GEMM entry point (registered as torch.ops.zth_w8a8.gemm_out through
// the trusted csrc/bindings.cpp). Must stay Graph-safe: launches only on the
// current PyTorch stream, no allocation/sync/packing/autotuning, and uses
// only caller-provided `out` and `workspace`.
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
  // No inter-block split-K in this architecture (the in-block split-K=4
  // partials are combined on-chip in LDS), so the workspace is unused; it is
  // still accepted (and required to be preallocated) for API compatibility.
  (void)workspace;
  (void)workspace_bytes;

  if (m <= 0 || n <= 0 || k <= 0) {
    return;
  }

  // The exact (k, n) == (384, 4096) pack is the [N][K] n-major transpose;
  // any other (k, n) keeps the identity pack (row-major [K][N]).  Decoding
  // must follow the same rule in the scalar fallback below.
  const int b_transposed = (k == kPackK && n == kPackN) ? 1 : 0;

  // Explicit assigned-shape dispatch point.  The M=16 / N=4096 / K=384
  // assigned shape runs on the DUMMA m16n16k32 split-K=4 path.  The generic
  // scalar fallback below serves every unmatched (m, n, k), including the
  // paired M=2 API shape with the same (N, K).
  if (m == 16 && n == kPackN && k == kPackK) {
    launch_dumma_m16n16_gemm(a, b, x_scale, weight_scale, out, n, stream);
    return;
  }

  // Generic scalar fallback for every unmatched (m, n, k), including M=2:
  // decodes the n-major pack when b_transposed, row-major otherwise.
  launch_scalar_gemm(a, b, x_scale, weight_scale, out, m, n, k, b_transposed,
                     stream);
}
// @@end
