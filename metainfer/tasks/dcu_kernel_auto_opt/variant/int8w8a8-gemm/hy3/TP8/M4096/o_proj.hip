// @@variant shape=hy3_tp8_o_proj_m4096 commit=5a89acbee264bee5d61f74c281509b86c3fcd4e3 added=2026-09-06
//   median_us=266.8 p90_us=267.2 speedup=53.05 baseline_us=1.415e+04
//   source=hy3-tp8-dsh-m16-and-m4096-2-f7fa9503
// INT8 W8A8 GEMM HIP implementation for Hygon K500SM_AI / gfx928.
//
// Worker: worker_1 (physical GPU 1). Assigned shapes:
//   hy3_tp8_o_proj_m16   : M=16,   N=4096, K=1024
//   hy3_tp8_o_proj_m4096 : M=4096, N=4096, K=1024
//
// Bootstrap strategy (iteration 1, correctness-first but a usable profiling
// baseline - a large-Prefill scalar K loop would not be):
//
//   * Large-prefill path (exact (m, n, k) == (4096, 4096, 1024), m4096
//       iteration-1 architecture round - DUMMA throughput baseline with the
//       accepted lineage steady state):
//       native INT8 DUMMA m16n16k32 with int32 accumulation; one 128x64
//       output tile per block; four wavefronts (256 threads, gfx928 wavefront
//       = 64); each wave owns a 64x32 quadrant built from eight m16n16k32
//       int32 accumulator fragments. The block cooperatively vector-loads
//       A[128,64] (x_q rows m0..m0+127, row-major stride k) and B[64,64]
//       (packed [N, K] weight rows n0..n0+63, n-major stride k) into one
//       single-buffered LDS stage (16,384 B total: a_tile 128*88 + b_tile
//       64*80; A rows padded 64 -> 88 B and staged as two 8-B halves per
//       16-B vector, B rows padded 64 -> 80 B); two __syncthreads per stage
//       (one after the cooperative load, one before the next stage overwrites
//       LDS). Each DUMMA operand fragment is filled by the direct 8-byte
//       load_fragment8 LDS read (one contiguous 8-B read per lane per
//       fragment on the m-major A tile / n-major B tile - no library loader
//       byte-reassembly VALU and no per-byte ds_read_u8), two A fragments
//       live per MMAC burst, and the epilogue is fused: int32 accumulator *
//       x_scale[m] * weight_scale[n] -> bf16 through the coalesced fragment
//       store (4x4 lane transpose + one 8-byte store per lane, 100% store
//       sector efficiency).
//       Grid dim3(64, 32) = 2048 output-tile blocks dwarfs the 120 CUs, so no
//       split-K is used (nothing is ever written to the workspace).
//
//   * Decode path (exact (m, n, k) == (16, 4096, 1024), iteration 5
//       architecture round): fused single-kernel split-K=2 - one 16x16 N tile
//       per block, grid 256 x 128 threads (2.13 blocks/CU on the measured 120
//       CUs, two co-resident 64-lane wavefronts per block), wave w
//       accumulating the ascending-k half w (K/2 = 512, 16 m16n16k32 steps)
//       of the tile with the iteration-3 per-wave body (direct global
//       fragment loads: matrix_a row_major off x_q, matrix_b col_major off
//       the packed [N, K] weight, depth-1 double-buffered prefetch, no LDS in
//       the K loop). The split combine is fused into this one kernel: wave 0
//       publishes its int32 accumulator fragment to a 1-KiB shared plane, one
//       END-of-K __syncthreads makes it visible, and wave 1 adds plane 0 +
//       its own upper-K-half fragment (exact int32, ascending split order,
//       bit-identical to the unsplit ascending-k dot) and applies the fused
//       x_scale * weight_scale -> bf16 epilogue. One launch on the caller
//       stream inside the timed Graph, no caller workspace and no second
//       combine kernel: the exact-shape Graph has a single node and no
//       ~1-MiB workspace write+read round trip. Iteration 3's two-launch
//       workspace partial+combine variant and iteration 2's unsplit two-wave
//       kernel are superseded (the fused kernel needs no workspace, so no
//       workspace-fit fallback branch remains).
//
//   * Generic scalar int8/int32 fallback for every unmatched (m, n, k),
//       including the paired M=2 API shape with the same (K, N) = (1024,
//       4096) and any other M tail: one thread per output element, exact
//       int32 dot over K, packed [N, K] weight decode (column n = one
//       contiguous k-run), fused x_scale * weight_scale, bf16 store.
//
//   * launch_pack_w8a8_weight: out-of-Graph, out-of-timed device transpose
//       of the raw [K, N] weight into the packed [N, K] buffer
//       (packed[n][k] = weight[k][n]) and an identity copy of weight_scale
//       into packed_weight_scale for every (k, n). The [N, K] packed layout
//       is what every GEMM consumer below reads: for the gfx928 INT8
//       m16n16k32 matrix_b fragment each lane owns 8 consecutive k bytes of
//       one n row, so the [K, N] identity layout would force 8 scattered
//       1-byte global loads per lane per k32 step while the [N, K] layout
//       makes them one contiguous 8-B vector load per lane per step.
//       Packing never happens inside the timed GEMM and stays outside Graph
//       capture; the packed buffer keeps the same byte count (K*N) and the
//       same allocated address as raw_weight.
//
// Timed operator rules honored: no allocation, compilation, autotuning,
// weight packing, host/device synchronization, or default-stream launch; the
// GEMM runs on the caller-provided PyTorch current HIP stream; only `out` is
// written by the timed kernels (the fused decode split-K=2 kernel combines
// in block-local LDS, so the caller workspace is left untouched by every
// path).

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
constexpr int kTargetN = 4096;
constexpr int kTargetK = 1024;
constexpr int kDecodeM = 16;  // assigned decode shape M
constexpr int kBlockM = 128;
constexpr int kBlockN = 64;
constexpr int kStageK = 64;
constexpr int kPad = 16;  // B: 64 -> 80-byte LDS row stride (bank skew)
constexpr int kAPad = 24;  // A: 64 -> 88-byte LDS row stride (22 dwords/row);
                           // 88 % 16 == 8, so odd rows are only 8-B aligned
                           // and the A stage is written as two 8-B halves
                           // (ds_write_b64 class). 22 dwords/row maps the 16
                           // rows of a fragment window onto 16 distinct 4-B
                           // word phases within each fragment q phase (the
                           // 20-dword 80-B rows of the accepted port alias
                           // rows r and r+8, doubling the LDS bank pressure
                           // of every A-fragment read).
constexpr int kAStride = kStageK + kAPad;  // A tile row stride (m-major)
constexpr int kBStride = kBlockN + kPad;  // B tile row stride (n-major: row
                                          // = n, k bytes along the padded row)
constexpr int kBlockThreads = 4 * kWaveSize;  // 256 threads = 4 wavefronts
// Decode launch geometry (iteration 3 grid, iteration 5 fused combine): grid
// 256 = one 16x16 N tile per block reaches 2.13 blocks/CU on the measured 120
// CUs - the finest legal grid at the two-blocks-per-CU latency-hiding target,
// since the 256 whole 16-col N tiles (4096/16) admit no finer whole-tile
// split - and keeps two co-resident 64-lane wavefronts per 128-thread block
// (the iteration-2 latency-hiding mechanism: one wave's global-load stalls
// overlap the other wave's MMAC/address work). Wave w of block b accumulates
// the ascending-k segment [w*512, (w+1)*512) of tile b. Iteration 3 combined
// the two per-tile halves through two caller-workspace int32 planes plus a
// second combine+scale kernel launch; iteration 5 fuses that combine into the
// same kernel through a 1-KiB block-local shared plane and one END-of-K
// __syncthreads (wave 0 publishes, wave 1 sums plane 0 + its own upper half
// and stores scaled bf16), removing the second Graph node and the workspace
// round trip entirely.
constexpr int kDecodeThreads = kWaveSize * 2;         // 128 = 2 wavefronts
constexpr int kDecodeSplitK = 2;                      // K segments per tile
constexpr int kDecodeSegK = kTargetK / kDecodeSplitK;  // 512
constexpr int kDecodeSegSteps = kDecodeSegK / kTileK;  // 16 x k32 steps
constexpr int kNumDecodeTiles = kTargetN / kTileN;     // 256 16-col tiles
constexpr int kDecodeLaneInts = 4;  // int32 accumulator values per lane
constexpr int kDecodeTileInts =
    kWaveSize * kDecodeLaneInts;  // 256 int32 = 1 KiB shared plane per block

using bf16_t = hip_bfloat16;

// ---------------------------------------------------------------------------
// Large-M prefill: 128x64 output tile per block, four wavefronts of 64 lanes.
// Each wave owns a 64x32 quadrant (eight m16n16k32 int32 accumulators); the
// block cooperatively stages A[128,64] from x_q (m-major, row stride k) and
// B[64,64] from the packed n-major [N, K] weight into a single-buffered LDS
// stage. Two barriers per K stage. DUMMA operand fragments are filled by the
// direct 8-byte LDS fill (load_fragment8) and the fused scale -> bf16
// epilogue stores through the coalesced fragment store.
// ---------------------------------------------------------------------------

// Coalesced fragment store. The m16n16k32 accumulator lane mapping
// (row = lane & 15, column group c4 = lane >> 4, frag.x[i] -> column
// c4 + 4*i) gives each lane four elements strided by 4 columns, so a direct
// per-element store is four 2-byte scalar stores per lane whose wavefront
// addresses touch each 32-B sector at 25% utilization (vmem_write 262,144
// for this shape). This epilogue transposes the 4-element groups within each
// 4-lane column group (lanes r, r+16, r+32, r+48 -- a 4x4 transpose, two 2x2
// steps with __shfl_xor 16 then 32), so lane (r, c4) ends up holding the
// four CONTIGUOUS columns 4*c4 .. 4*c4+3, converts them to bf16, packs 4
// bf16 (8 B), and writes ONE 8-byte store per lane (vmem_write 65,536: 100%
// store sector efficiency). This DTK lowers __shfl_xor to ds_bpermute at the
// block tail where the LDS pipe is idle. Only the int32 values are re-routed
// between lanes; the per-element scale multiply order
// (float(dot) * x_scale[row] * weight_scale[col]) and the bf16 rounding are
// unchanged, so the stored bits are identical to the direct per-element
// store. The row >= m guard is wavefront-uniform (all 64 lanes of a wave
// share the same 16-row window), so the shuffles never mix active and
// inactive lanes; base_col is a multiple of 16 and n*2 a multiple of 8, so
// the float4 weight_scale load (col0 % 4 == 0) and the 8-byte store
// ((row*n + col0) % 4 == 0 elements -> byte offset % 8 == 0) are aligned.
// This is the exact mechanism validated on the accepted hy3 TP8 o_proj M4096
// lineage (iteration 6, vmem_write_instructions 262,144 -> 65,536).

// Plain round-to-nearest-even fp32 -> bf16 conversion (bit 16 of the fp32
// pattern), without the NaN/Inf signaling-bit fixup of hip's
// __float2bfloat16. The arithmetic (u + 0x7fff + ((u >> 16) & 1)) >> 16 is
// exactly the finite-domain path of DTK's float_2_bfloatraw (exponent bits
// != all-ones), so every finite fp32 input - including +/-0, denormals, and
// values whose RNE carries into/out of the bf16 exponent field - produces
// the identical 16-bit pattern as __float2bfloat16; the outputs can differ
// only for NaN/Inf inputs, which this kernel's epilogue can never produce
// (|int32 dot| <= K*127^2 and both scale inputs are finite, so the scaled
// accumulator is always finite). Replacing the library conversion drops the
// exec-masked special-case chain the DTK otherwise emits per element in the
// epilogue tail (v_and exponent mask + v_cmp_ne + s_and_saveexec + s_xor +
// v_bfe + v_add3 + s_andn2_saveexec + v_mov/v_or + v_cmp_eq_sdwa +
// v_cndmask + s_or in the accepted iteration-5 ISA: ~12 extra SALU/VALU per
// element x 32 elements per wave, all executed once per block tail) for 3
// VALU per element, with stored bits unchanged (verified against the
// float_2_bfloatraw source: the else-if branch it removes is reachable only
// from Inf/NaN inputs).
__device__ __forceinline__ unsigned short bf16_rne_finite_bits(float f) {
  union {
    float fp32;
    unsigned int u32;
  } u = {f};
  u.u32 += 0x7fffu + ((u.u32 >> 16) & 1u);  // round half to even at bit 16
  return static_cast<unsigned short>(u.u32 >> 16);
}

template <typename AccFragment>
__device__ __forceinline__ void store_prefill_fragment_coalesced(
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

  // Lane (r, c4) now owns columns base_col + 4*c4 .. +3 (8 B, 8-byte
  // aligned: base_col is a multiple of 16, n*2 is a multiple of 8).
  const int col0 = base_col + 4 * c4;
  const float xs = x_scale[row];
  const float4 ws = *reinterpret_cast<const float4*>(weight_scale + col0);
  // Left-associative scale order, matching the logical reference
  // (A.float() @ B.float()) * x_scale[m] * weight_scale[n].T.
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

// Direct 8-byte LDS fragment fill for the DUMMA m16n16k32 signed char
// operands on a padded tile whose row direction carries the fragment's
// 16-row index and whose columns hold the K bytes (A m-major tile row = m,
// B n-major tile row = n): the fragment slot of lane (r = lane & 15,
// kq = lane >> 4) is the eight CONSECUTIVE k-bytes at (lane & 15) * stride +
// (lane >> 4) * 8. The library du_load_matrix_sync int8 loaders make the
// compiler emit per-byte ds_read_u8 loads plus a mask/OR byte-reassembly
// chain per loaded dword that is an arithmetic identity on the v_mmac
// operand (dead issue and dead latency on the load -> v_mmac dependency
// path). Writing the same 8 bytes straight into the fragment storage (x[0..7]
// of the DUFragmentBase<signed char, 8>) keeps the operand bit pattern and
// the int32 accumulation identical and lets the compiler feed a single 8-byte
// LDS read to the v_mmac. This is the exact pattern validated on the worker-
// 29 TP4 gate_up lineage (accepted iteration 13) and the TP8 hy3 o_proj M4096
// lineage (accepted iterations 10/12: 348.27 -> 322.99 us median, VALU
// ~22.56M -> ~15.7M, SQ_WAIT_INST_LDS drop, arch_vgpr 82 -> <= 64).
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

__global__ __launch_bounds__(kBlockThreads) void w8a8_dumma_prefill_kernel(
    const int8_t* __restrict__ x_q,
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
  const int wave_row = wave >> 1;  // quadrant rows [0,1] x 64
  const int wave_col = wave & 1;   // quadrant cols [0,1] x 32
  const int m0 = static_cast<int>(blockIdx.y) * kBlockM;
  const int n0 = static_cast<int>(blockIdx.x) * kBlockN;
  const int local_row = wave_row * 64;
  const int local_col = wave_col * 32;

  // Single-buffered K-stage: A[128, 88] + B[64, 80] = 16,384 B/block.
  // Round-8 residency: the one-stage-ahead staging payload (+12 VGPR) moves
  // the code object from the accepted exact-64-VGPR 4-blocks/CU point (64 x
  // 1024 threads = 65,536 VGPR exactly) to 80 VGPR => 3 blocks/CU (80 x 256
  // x 3 = 61,440 <= 65,536 VGPR; LDS 16,384 x 3 = 49,152 B; <= 85 VGPR keeps
  // 3 blocks, no spills at the offline-verified 80).
  __shared__ __align__(16) int8_t a_tile[kBlockM * kAStride];
  __shared__ __align__(16) int8_t b_tile[kStageK * kBStride];

  // DUMMA m16n16k32 signed char operand fragments are filled by
  // load_fragment8 with the eight consecutive k-bytes each lane owns on the
  // padded tile (A m-major rows, B n-major rows of the [N, K] packed
  // weight): no library loader, no per-byte ds_read_u8, no byte-reassembly
  // VALU, one 8-byte LDS read straight into the v_mmac operand. Only two A
  // fragments are live per MMAC burst, keeping the register footprint at the
  // 4-blocks/CU occupancy point.
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

  // Cooperative staging (identity input layouts, [N, K] packed output):
  //  * A[128,64] is 512 16-B chunks -> two per thread: rows [0,64) and
  //    [64,128). Each 16-B chunk is loaded from global as two 8-B halves
  //    and written to LDS as the adjacent 8-B pair (ds_write2_b64 class)
  //    because the 88-B A row stride is 8 (mod 16): odd rows start at an
  //    8-B (not 16-B) aligned LDS offset, so a 16-B aligned LDS store would
  //    be misaligned. The 88-B stride (22 dwords/row) also maps the 16 rows
  //    of a fragment window onto 16 distinct word phases within each q
  //    phase, removing the r/r+8 alias of the old 80-B rows from the
  //    A-fragment reads.
  //  * B[64,64] of the packed [N, K] weight (packed[n][k]) is 256 int4s ->
  //    one int4 per thread; thread (tid>>2) selects the stage-local n row
  //    and (tid & 3)*16 the k offset, so global reads are 64-B contiguous
  //    per n row of the packed buffer and LDS stores are 16-B aligned along
  //    the padded n-major b_tile row (stride 80 unchanged).
  const int row_a = tid >> 2;          // 0..63 (first A row half)
  const int col_a = (tid & 3) << 4;    // 0,16,32,48 (8-B half at +8)
  const int row_b = tid >> 2;          // 0..63 (stage-local n row)
  const int col_b = (tid & 3) << 4;    // 0,16,32,48 (k offset)

  // Round-8 change: the cooperative staging below is software-pipelined one
  // k64 stage ahead. Each thread keeps the 48 B/lane it stages for stage
  // s+1 (two 16-B A row chunks + one 16-B B chunk = 12 payload VGPR) in
  // registers and issues those global loads right after stage s's LDS
  // stores/visibility barrier, so the full global round trip (~500+ cycles
  // on gfx928) overlaps stage s's LDS fragment reads and MMACs instead of
  // being exposed between the stage barriers and the LDS stores of the next
  // stage (in the accepted single-buffered code the stage-s loads are issued
  // at the top of the same stage, immediately followed by the vmcnt waits,
  // so ~one full global latency is on the per-stage critical path of every
  // wave, 16 times per block). The single LDS buffer layout, the exact
  // staged bytes, the store order, the two __syncthreads per stage and the
  // fragment-read/MMAC stream are unchanged - only the issue TIME of the
  // global loads moves one stage earlier (their results wait in registers),
  // so every int32 partial and every stored bf16 bit stays identical. The
  // 12 payload VGPR take the code object past the exact 64-VGPR
  // four-blocks/CU point to the 3-blocks/CU point (predicted arch_vgpr <=
  // 80: 80 * 256 threads * 3 blocks = 61,440 <= 65,536 VGPR, LDS 16,384 B *
  // 3 = 49,152 B): 12 resident waves per CU instead of 16, each no longer
  // stalling per stage on the global round trip - the predicted occupancy
  // arm of the experiment (no spill/scratch allowed; > 80 arch_vgpr would
  // drop residency to 2 blocks/CU and falsify the mechanism).
  const int64_t a_g0_base =
      static_cast<int64_t>(m0 + row_a) * k + col_a;  // A row 0..63, bytes
  const int64_t a_g1_base =
      static_cast<int64_t>(m0 + row_a + kBlockM / 2) * k + col_a;  // row 64..
  const int64_t b_g_base =
      static_cast<int64_t>(n0 + row_b) * k + col_b;  // packed B n row, bytes
  const int a_lds0 = row_a * kAStride + col_a;
  const int a_lds1 = (row_a + kBlockM / 2) * kAStride + col_a;
  const int b_lds = row_b * kBStride + col_b;

  // Loop-carried staging payload (48 B/lane): holds the stage-k0 chunks
  // until they are stored to LDS at the top of the iteration, then is
  // refilled with stage (k0 + kStageK) so the round trip overlaps the MMACs
  // below. Same addresses and byte patterns as the accepted staging loads.
  int k0 = 0;
  unsigned long long a0_lo = 0, a0_hi = 0, a1_lo = 0, a1_hi = 0;
  int4 b_chunk = make_int4(0, 0, 0, 0);
  if (k0 < k) {  // prologue: issue the stage-0 loads (only these are exposed)
    a0_lo = *reinterpret_cast<const unsigned long long*>(x_q + a_g0_base);
    a0_hi = *reinterpret_cast<const unsigned long long*>(x_q + a_g0_base + 8);
    a1_lo = *reinterpret_cast<const unsigned long long*>(x_q + a_g1_base);
    a1_hi = *reinterpret_cast<const unsigned long long*>(x_q + a_g1_base + 8);
    b_chunk = *reinterpret_cast<const int4*>(weight + b_g_base);
  }
  for (; k0 < k; k0 += kStageK) {
    // Barrier A (the accepted code's post-compute barrier, moved to the top
    // of the next stage): every wave has finished reading the previous
    // stage from the single LDS buffer, so the stores below may overwrite
    // it. The stage-k0 global loads were issued one full stage earlier and
    // landed during the previous stage's MMACs.
    __syncthreads();
    *reinterpret_cast<unsigned long long*>(a_tile + a_lds0) = a0_lo;
    *reinterpret_cast<unsigned long long*>(a_tile + a_lds0 + 8) = a0_hi;
    *reinterpret_cast<unsigned long long*>(a_tile + a_lds1) = a1_lo;
    *reinterpret_cast<unsigned long long*>(a_tile + a_lds1 + 8) = a1_hi;
    *reinterpret_cast<int4*>(b_tile + b_lds) = b_chunk;
    __syncthreads();  // Barrier B: stage k0 is visible to every wave

    if (k0 + kStageK < k) {  // issue stage k0 + kStageK (overlaps the MMACs
      const int64_t kn = k0 + kStageK;
      a0_lo =
          *reinterpret_cast<const unsigned long long*>(x_q + a_g0_base + kn);
      a0_hi = *reinterpret_cast<const unsigned long long*>(x_q + a_g0_base +
                                                           kn + 8);
      a1_lo =
          *reinterpret_cast<const unsigned long long*>(x_q + a_g1_base + kn);
      a1_hi = *reinterpret_cast<const unsigned long long*>(x_q + a_g1_base +
                                                           kn + 8);
      b_chunk = *reinterpret_cast<const int4*>(weight + b_g_base + kn);
    }

    // Each wave consumes its 64x32 quadrant: eight m16n16k32 MMACs per 32-k
    // chunk, operands filled by the direct 8-byte loads (A m-major stride
    // kAStride, B n-major stride kBStride). The kk order (0 then 32), the
    // per-accumulator MMAC order and the ascending-k int32 accumulation are
    // unchanged, so every accumulator partial is bit-identical to the
    // library-loader path.
#pragma unroll
    for (int kk = 0; kk < kStageK; kk += kTileK) {
      load_fragment8(b_frag0, b_tile + local_col * kBStride + kk, kBStride,
                     lane);
      load_fragment8(b_frag1,
                     b_tile + (local_col + kTileN) * kBStride + kk, kBStride,
                     lane);
      load_fragment8(a_frag0, a_tile + local_row * kAStride + kk, kAStride,
                     lane);
      load_fragment8(a_frag1, a_tile + (local_row + kTileM) * kAStride + kk,
                     kAStride, lane);
      du_mma_sync(acc00, a_frag0, b_frag0, acc00);
      du_mma_sync(acc01, a_frag0, b_frag1, acc01);
      du_mma_sync(acc10, a_frag1, b_frag0, acc10);
      du_mma_sync(acc11, a_frag1, b_frag1, acc11);
      load_fragment8(
          a_frag0, a_tile + (local_row + 2 * kTileM) * kAStride + kk,
          kAStride, lane);
      load_fragment8(
          a_frag1, a_tile + (local_row + 3 * kTileM) * kAStride + kk,
          kAStride, lane);
      du_mma_sync(acc20, a_frag0, b_frag0, acc20);
      du_mma_sync(acc21, a_frag0, b_frag1, acc21);
      du_mma_sync(acc30, a_frag1, b_frag0, acc30);
      du_mma_sync(acc31, a_frag1, b_frag1, acc31);
    }
  }

  const int base_row = m0 + local_row;
  const int base_col = n0 + local_col;
  store_prefill_fragment_coalesced(acc00, x_scale, weight_scale, out, base_row,
                         base_col, m, n, lane);
  store_prefill_fragment_coalesced(acc01, x_scale, weight_scale, out, base_row,
                         base_col + kTileN, m, n, lane);
  store_prefill_fragment_coalesced(acc10, x_scale, weight_scale, out,
                         base_row + kTileM, base_col, m, n, lane);
  store_prefill_fragment_coalesced(acc11, x_scale, weight_scale, out,
                         base_row + kTileM, base_col + kTileN, m, n, lane);
  store_prefill_fragment_coalesced(acc20, x_scale, weight_scale, out,
                         base_row + 2 * kTileM, base_col, m, n, lane);
  store_prefill_fragment_coalesced(acc21, x_scale, weight_scale, out,
                         base_row + 2 * kTileM, base_col + kTileN, m, n,
                         lane);
  store_prefill_fragment_coalesced(acc30, x_scale, weight_scale, out,
                         base_row + 3 * kTileM, base_col, m, n, lane);
  store_prefill_fragment_coalesced(acc31, x_scale, weight_scale, out,
                         base_row + 3 * kTileM, base_col + kTileN, m, n,
                         lane);
}

// Device helper for the fused split-K combine: load a lane's 4 int32
// accumulator values as one aligned 16-B vector (LDS plane offsets are
// 16-B aligned: 1-KiB plane, 16-B lane stride).
__device__ __forceinline__ void load4_ints(const int32_t* src,
                                           int32_t out[kDecodeLaneInts]) {
  const int4 v = *reinterpret_cast<const int4*>(src);
  out[0] = v.x;
  out[1] = v.y;
  out[2] = v.z;
  out[3] = v.w;
}

// ---------------------------------------------------------------------------
// Decode fused split-K=2 kernel (iteration 5, architecture round): one 16x16
// N tile per block, grid 256 = 2.13 blocks/CU on the measured 120 CUs (the
// finest legal grid at the two-blocks-per-CU target; the 256 whole 16-col N
// tiles admit no finer whole-tile split), block 128 threads = two co-resident
// 64-lane wavefronts. Wave w of block b accumulates the k segment
// [w*512, (w+1)*512) of tile b in ascending k order - 16 m16n16k32 steps with
// the exact iteration-3 per-wave body: same lane mapping, direct global
// fragment loads (matrix_a row_major off x_q, matrix_b col_major off the
// packed [N, K] weight, so each lane's 8 B bytes are one contiguous 8-B
// vector load per k32 step instead of 8 scattered byte loads), depth-1
// double-buffered fragment prefetch, no LDS and no barrier inside the K loop.
// The per-block split-K combine is fused into this single kernel: wave 0
// publishes its int32 accumulator fragment (4 int32/lane = one 16-B vector,
// lane-contiguous, 1 KiB total) to a block-local shared plane, one END-of-K
// __syncthreads (executed unconditionally by both wavefronts after the
// symmetric K loop) makes it visible, and wave 1 reads the plane back, adds
// plane 0 + its own upper-K-half fragment with exact int32 arithmetic - the
// ascending-split sum is bit-identical to the unsplit ascending-k int32 dot,
// since K=1024 keeps every partial and the total far below int32 overflow -
// and applies the fused reference epilogue chain
// ((float)acc * x_scale[row]) * weight_scale[col] -> bf16 with the verified
// fragment->out mapping. One launch on the caller stream inside the timed
// Graph: the exact-shape decode is now a single Graph node with no caller
// workspace write, no workspace read and no second combine launch (iteration
// 3's workspace partial+combine pair and iteration 2's unsplit two-wave
// kernel are superseded). 1-KiB LDS/block does not dent occupancy, and the
// one END-of-K barrier is the accepted down_proj lineage pattern at the same
// 256-block / two-wave geometry (w8a8_dumma_m16n16k32_sk2_kernel). M=16 fills
// the m16 tile exactly so every row guard is trivially satisfied; every other
// (m, n, k) including the paired M=2 API shape stays on the scalar fallback.
// ---------------------------------------------------------------------------
__global__ __launch_bounds__(kDecodeThreads) void
w8a8_dumma_m16n16_sk2_fused_kernel(
    const int8_t* __restrict__ x_q,
    const int8_t* __restrict__ weight,
    const float* __restrict__ x_scale,
    const float* __restrict__ weight_scale,
    bf16_t* __restrict__ out,
    int m,
    int n,
    int k) {
  const int wave =
      static_cast<int>(threadIdx.x) >> 6;  // k segment 0..kDecodeSplitK-1
  const int lane =
      static_cast<int>(threadIdx.x) & (kWaveSize - 1);  // lane 0..63
  const int tile = static_cast<int>(blockIdx.x);        // one tile per block
  const int n0 = tile * kTileN;
  const int k0 = wave * kDecodeSegK;  // segment base (0 or 512)

  // 1-KiB in-block int32 partial plane for the fused split-K combine: wave 0
  // publishes, wave 1 reads after the single END-of-K barrier.
  __shared__ __align__(16) int32_t s_part[kDecodeTileInts];

  DUFragment<matrix_a, kTileM, kTileN, kTileK, signed char, row_major>
      a_frag[2];
  // matrix_b col_major: the packed weight is [N, K] (n-major rows of length
  // k), so the library's col_major matrix_b loader addresses fragment slot
  // (k, n) at packed[n * ldm + k]. Each lane's 8 fragment bytes (8
  // consecutive k of one n row) are then one contiguous, 8-B-aligned vector
  // load per k32 step instead of 8 scattered byte loads with ldm = n over
  // the identity [K, N] layout.
  DUFragment<matrix_b, kTileM, kTileN, kTileK, signed char, col_major>
      b_frag[2];
  DUFragment<accumulator, kTileM, kTileN, kTileK, int> acc;
  du_fill_fragment(acc, 0);

  // Epilogue scale prefetch (iteration 17): the fused combine/scale epilogue
  // lives on the post-barrier critical tail of wave 1, where each lane
  // performs 4 unique weight_scale loads + 1 x_scale load before its FMA
  // chain. weight_scale is touched exactly once per kernel replay (each
  // 16-col tile block reads its own 16 floats of the 4096-entry array), so
  // those loads miss L1/L2 on the tail. Issue them before the K loop of the
  // segment instead: identical values and the identical left-associative
  // multiply chain keep the scaled-bf16 output bit-exact, while the global
  // latency now hides under the 16 MMAC steps instead of stalling the
  // END-of-K combine. Wave 0 never executes the branch and never reads the
  // prefetched registers.
  float xs;
  float ws[kDecodeLaneInts];
  if (wave == 1) {
    const int row = lane & 15;
    const int col_mod4 = lane >> 4;
    xs = x_scale[row];
#pragma unroll
    for (int i = 0; i < kDecodeLaneInts; ++i) {
      ws[i] = weight_scale[n0 + col_mod4 + 4 * i];
    }
  }

  // Depth-1 software pipeline over the segment (unchanged iteration-3 body:
  // the global loads for step s+1 are issued just before the mmac of step s,
  // so one full global round trip overlaps each mmac; kDecodeSegSteps = 16
  // constant-trip iterations let the scheduler hoist loads while registers
  // allow).
  du_load_matrix_sync(a_frag[0], x_q + k0, kTargetK);
  du_load_matrix_sync(b_frag[0],
                      weight + static_cast<int64_t>(n0) * kTargetK + k0,
                      kTargetK);
  int buf = 0;
#pragma unroll
  for (int s = 0; s < kDecodeSegSteps; ++s) {
    const int nxt = buf ^ 1;
    if (s + 1 < kDecodeSegSteps) {
      du_load_matrix_sync(a_frag[nxt], x_q + k0 + (s + 1) * kTileK,
                          kTargetK);
      du_load_matrix_sync(b_frag[nxt],
                          weight + static_cast<int64_t>(n0) * kTargetK + k0 +
                              (s + 1) * kTileK,
                          kTargetK);
    }
    du_mma_sync(acc, a_frag[buf], b_frag[buf], acc);
    buf = nxt;
  }

  if (wave == 0) {
    // Publish the lower-K-half partial: lane-contiguous fragment order
    // acc.x[0..3] = one 16-B vector at s_part[lane * 4] (1 KiB plane).
    *reinterpret_cast<int4*>(&s_part[lane * kDecodeLaneInts]) =
        make_int4(acc.x[0], acc.x[1], acc.x[2], acc.x[3]);
  }
  // One END-of-K barrier: both wavefronts execute it unconditionally after
  // their symmetric K loops; makes wave 0's plane visible to wave 1.
  __syncthreads();

  if (wave == 1) {
    // Wave 1 owns the upper-K-half partial in `acc`; add the lower-K-half
    // plane in ascending split order (plane 0 + plane 1 = full ascending-k
    // int32 dot, bit-identical to the unsplit dot by construction). The
    // epilogue scales were prefetched into xs/ws before the K loop above.
    int32_t p0[kDecodeLaneInts];
    load4_ints(s_part + lane * kDecodeLaneInts, p0);
    const int row = lane & 15;
    if (row >= m) {
      return;  // tail-M guard (the exact shape always has m == 16)
    }
    const int col_mod4 = lane >> 4;
#pragma unroll
    for (int i = 0; i < kDecodeLaneInts; ++i) {
      const int col = n0 + col_mod4 + 4 * i;
      const float scaled = static_cast<float>(p0[i] + acc.x[i]) * xs * ws[i];
      out[static_cast<int64_t>(row) * n + col] = __float2bfloat16(scaled);
    }
  }
}

// ---------------------------------------------------------------------------
// Generic scalar fallback: one thread per output element. Exact int32 dot
// over K (k ascending), then fused x_scale * weight_scale, then bf16 store.
// Handles every unmatched (m, n, k), including the paired M=2 API shape
// (with the same (K, N) as the assigned decode/prefill shapes) and any M
// tail. Reads the packed [N, K] weight layout for every (k, n) - column n
// is one contiguous k-run at weight + n*k - exactly as launch_pack_w8a8_weight
// fills it.
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
  // Packed weight is [N, K] (packed[n][k]), so column n is one contiguous
  // k-run starting at packed + n * k (element (k, n) at [n * k + k]).
  const int8_t* b_col = weight + static_cast<int64_t>(col) * k;
  for (int kk = 0; kk < k; ++kk) {
    acc += static_cast<int32_t>(a_row[kk]) * static_cast<int32_t>(b_col[kk]);
  }
  const float scaled =
      static_cast<float>(acc) * x_scale[row] * weight_scale[col];
  out[linear] = __float2bfloat16(scaled);
}

// ---------------------------------------------------------------------------
// Bootstrap weight packing (outside the timed region and outside Graph
// capture): out-of-Graph device transpose raw [K, N] -> packed [N, K]
// (packed[n][k] = raw[k][n]) for every (k, n), plus an identity scale copy.
// The packed buffer keeps the same byte count (K*N) and the same allocated
// address as raw_weight, so the layout is graph-stable. Every GEMM consumer
// in this file (decode DUMMA, prefill DUMMA, scalar fallback) decodes the
// [N, K] layout; the scale buffer stays n-indexed.
// ---------------------------------------------------------------------------
__global__ __launch_bounds__(256) void w8a8_pack_transpose_kernel(
    const int8_t* __restrict__ raw,
    int8_t* __restrict__ packed,
    int k,
    int n,
    int64_t count) {
  const int64_t linear =
      static_cast<int64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
  if (linear < count) {
    const int64_t k_row = linear / n;
    const int64_t n_col = linear - k_row * n;
    packed[n_col * k + k_row] = raw[linear];
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
// Both launchers are pure dispatch on the caller-provided HIP stream: no
// allocation, no packing, no synchronization, no default-stream launch; they
// are CUDA/HIP-Graph safe.
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
  auto* out_bf16 = reinterpret_cast<bf16_t*>(out);

  // Explicit dispatch:
  //   * assigned decode shape (M=16, N=4096, K=1024, iteration 5): native
  //     INT8 DUMMA fused split-K=2 - one kernel, 256 blocks (one 16-col N
  //     tile per block) x 128 threads (wave w = ascending-k half w of the
  //     tile). Wave 0 publishes its int32 partial to a 1-KiB block-local
  //     shared plane, one END-of-K __syncthreads, wave 1 sums plane 0 + its
  //     own upper-K-half fragment (exact int32) and stores scaled bf16. A
  //     single launch inside the timed Graph at 2.13 blocks/CU; no caller
  //     workspace and no second combine kernel (workspace left untouched, so
  //     the iteration-3 workspace-fit fallback no longer exists).
  //   * assigned large-prefill shape (M=4096, N=4096, K=1024): the DUMMA
  //     128x64 single-buffered path (workspace untouched).
  //   * every other (m, n, k) - including the paired M=2 API shape with the
  //     same (K, N) - takes the scalar fallback on the packed [N, K] weight
  //     layout (column n contiguous over k).
  if (m == kDecodeM && n == kTargetN && k == kTargetK) {
    const dim3 grid(kNumDecodeTiles);  // 256 blocks, one tile per block
    const dim3 block(kDecodeThreads);  // 128 threads = 2 wavefronts
    hipLaunchKernelGGL(w8a8_dumma_m16n16_sk2_fused_kernel, grid, block, 0,
                       stream, a, b, x_scale, weight_scale, out_bf16, m, n, k);
  } else if (m == kTargetM && n == kTargetN && k == kTargetK) {
    const dim3 grid(kTargetN / kBlockN, kTargetM / kBlockM);
    const dim3 block(kBlockThreads);
    hipLaunchKernelGGL(w8a8_dumma_prefill_kernel, grid, block, 0, stream,
                       a, b, x_scale, weight_scale, out_bf16, m, n, k);
  } else {
    constexpr int kBlock = 256;
    const int64_t total = static_cast<int64_t>(m) * n;
    const dim3 grid(static_cast<unsigned>((total + kBlock - 1) / kBlock));
    const dim3 block(kBlock);
    hipLaunchKernelGGL(w8a8_gemm_scalar_fallback_kernel, grid, block, 0,
                       stream, a, b, x_scale, weight_scale, out_bf16, m, n,
                       k);
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
  constexpr int kBlock = 256;
  const dim3 block(kBlock);

  // Out-of-timed device transpose of the raw [K, N] weight into the packed
  // [N, K] buffer (same byte count, same address: graph-stable). All GEMM
  // consumers in this file decode [N, K] (see launch_w8a8_gemm).
  const int64_t weight_count = static_cast<int64_t>(k) * n;
  const dim3 weight_grid(
      static_cast<unsigned>((weight_count + kBlock - 1) / kBlock));
  hipLaunchKernelGGL(w8a8_pack_transpose_kernel, weight_grid, block, 0,
                     stream, raw_weight, packed_weight, k, n, weight_count);

  const int64_t scale_count = n;
  const dim3 scale_grid(
      static_cast<unsigned>((scale_count + kBlock - 1) / kBlock));
  hipLaunchKernelGGL(w8a8_pack_scale_identity_kernel, scale_grid, block, 0,
                     stream, weight_scale, packed_weight_scale, n);
  (void)hipGetLastError();
}
// @@end
