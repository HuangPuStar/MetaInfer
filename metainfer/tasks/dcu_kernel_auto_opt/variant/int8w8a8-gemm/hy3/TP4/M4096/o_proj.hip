// @@variant shape=hy3_tp4_o_proj_m4096 commit=a030cfe61386a23a42e172497185fff364c58a85 added=2026-09-14
//   median_us=453.2 p90_us=454.2 speedup=43.87 baseline_us=1.988e+04
//   source=test-9-11-1/iteration_002/hy3_tp4_o_proj_m4096 (retested A/B)
// INT8 W8A8 GEMM HIP implementation for Hygon K500SM_AI / gfx928.
//
// Worker: worker_0 (physical GPU 0). Assigned shape:
//   hy3_tp4_o_proj_m4096 : M=4096, N=4096, K=2048   (logical (K, N) = (2048, 4096))
//
// Iteration 1 - architecture establishment (one bounded DUMMA geometry round).
//
//   * Exact assigned-shape path (m, n, k) == (4096, 4096, 2048): native gfx928
//     INT8 DUMMA m16n16k32 with int32 accumulation and a 128x64 output macro-
//     tile per block.
//       - Four wavefronts (256 threads); each wave owns a 64x32 quadrant built
//         from eight m16n16k32 accumulator fragments (acc00..acc31).
//       - Grid is (N/64) x (M/128) = 64 x 32 = 2048 blocks. With /64 KiB LDS
//         and this kernel's 30,720 B/block the resource budget allows two
//         resident blocks per CU, so the 2048-block grid covers all 120 CUs
//         (~8.5 waves of 240 resident blocks).
//       - 64-deep K stages, double buffered: the ping-pong LDS pair holds
//         A[128,64] and packed-B[64,64] panels (2 x 20 KiB + 2 x 5 KiB
//         buffers, 30,720 B total). The loop-carried int4 payload for stage
//         k0 + 64 is published into the idle buffer at the top of stage k0
//         (before the MMAC burst) and the global prefetch for stage k0 + 128
//         has a full stage of lead, so global load latency retires under the
//         burst and only one __syncthreads per K stage is needed.
//       - Both LDS tiles use an 80-byte row stride (five 16-byte bank phases)
//         instead of the power-of-two 64-byte stride, which breaks the
//         periodicity that made every DUMMA fragment load collide on a handful
//         of LDS banks; all cooperative int4 staging stores stay 16-byte
//         aligned.
//       - The epilogue fuses float(dot) * x_scale[m] * weight_scale[n] and
//         stores bf16 directly from the accumulator fragments (no extra LDS
//         round trip, no separate epilogue kernel): verified gfx928 int8
//         m16n16k32 ownership is lane&15 -> row, lane>>4 -> col%4, and x[i] ->
//         columns col%4 + 4*i.
//       - No split-K: the 2048-block MxN grid already exposes ample
//         parallelism, so the workspace is never touched and no combine pass
//         is paid inside the timed region.
//
// Iteration 2 - B-operand LDS transpose for vectorized fragment loads:
//   PMC/ISA audit of the iteration-1 source (11,272,192 LDS instructions,
//   31,457,280 bank conflicts) showed the operand split exactly. The A
//   operand's row-major loader emits one 8-byte ds_read2_b32 per m16n16k32
//   fragment (its per-lane bytes are contiguous in K), but the B operand's
//   row-major loader walks the 80-byte LDS row stride, so each B fragment
//   costs eight scalar ds_read_u8: 32 of the 40 loop LDS reads per 64-K
//   stage. This round quantifies operand reuse per 128x64 macro-tile and
//   keeps cooperative A+B LDS staging (direct global operand loads would
//   re-request ~1 GB of A plus ~0.5 GB of B per replay and lean on L2). The
//   focused change is the B staging layout: the tile is now n-major
//   ([64 n][64 k] with the same 80-byte bank-phase stride) and is consumed
//   with the col_major loader, whose per-lane bytes are eight contiguous K
//   bytes. Each B fragment therefore collapses from eight ds_read_u8 to a
//   single ds_read2_b32, cutting the loop LDS reads from ~40 to ~12 per
//   stage. The global B panel is repacked to [N/64, 64, K] (same byte count)
//   so the cooperative int4 stage load stays one coalesced 64-byte segment
//   per n row and no transpose is paid inside the timed GEMM. A/B reuse per
//   macro-tile is unchanged (each staged A byte feeds 64 output columns, each
//   staged B byte 128 output rows), the LDS footprint stays 30,720 B, and two
//   blocks/CU remain resident.
//
// Iteration 3 - single-buffered K pipeline (round's mandated single-vs-double
// buffering comparison):
//   PMC/ISA of the accepted iteration-2 source (3,932,160 LDS instructions,
//   18,874,368 bank conflicts = 4.80 conflict cycles/LDS,
//   lds_wait_instructions 3,680,076 = 93.6% of LDS instructions, 1,089,536 VMEM
//   read instructions, 30,720 B LDS, 80 VGPR) shows the kernel is latency
//   bound, not LDS-instruction bound: after the iteration-2 vectorization the
//   LDS stream is only 12 ds_read2_b32 per 64-K stage, yet almost every one
//   still registers a wait, and the only resource that keeps residency at 2
//   blocks/CU is LDS (30,720 * 3 > 65,536) while the 80-VGPR budget already
//   allows 3 (61,440 <= 65,536). The round therefore drops the ping-pong pair
//   for a single 15,360 B A+B tile and re-publishes the next stage after the
//   burst instead of at the top of the stage. This trades one extra barrier per
//   K stage and the publish-under-burst overlap for a third resident block
//   (12 waves/CU instead of 8). Falsifiable: if the kernel is truly stall-bound,
//   the extra block hides enough LDS/VMEM latency to move median below
//   736.46 us; if the exposed LDS store latency and doubled barrier count
//   dominate, median regresses and double buffering is retained per the round's
//   decision rule. Fragment loads, MMAC schedule, staging mapping, global
//   access pattern, packed layout, and the generic fallback are unchanged.
//
// Iteration 4 - square macro-tile (M-tile : N-tile aspect-ratio round):
//   PMC/ISA of the accepted iteration-3 source (3,932,160 LDS instructions,
//   18,874,368 bank conflicts = 4.80 conflict cycles/LDS, 8,923,656
//   lds_wait_instructions, 1,089,536 VMEM reads, 15,360 B LDS at 88 arch VGPR,
//   2048 blocks, 594 us of the 655 us median) shows the residual cost is
//   per-MAC issue overhead, not LDS capacity: with the 2:1 128x64 macro-tile
//   the block still issues 60 LDS wave-instructions (48 fragment reads + 12
//   cooperative stage stores), 12 VMEM loads and 2 barriers for every 524,288
//   MACs, and each 64x32 wave quadrant pays six 8-byte fragment loads for only
//   eight m16n16k32 MMACs (0.75 LDS loads/MMAC). This round retunes the
//   M-tile : N-tile aspect ratio from 2:1 to 1:1 with the same K depth and the
//   same single-buffered pipeline: the macro-tile becomes 128x128 (grid
//   32x32 = 1024 blocks, still 8.5 blocks per each of the 120 CUs) and each of
//   the four wavefronts owns a 64x64 quadrant built from sixteen m16n16k32
//   accumulators. A square quadrant is the fragment-shape optimum: eight
//   8-byte fragment loads feed sixteen MMACs (0.5 LDS loads/MMAC, -33%), a
//   stage store grows to four int4 per thread so the block pays 4 VMEM loads
//   instead of 3 for twice the MACs (-33% VMEM loads/MAC), and the two
//   barriers are amortized over 2x the work (-50% barriers/MAC). A 1:1 tile
//   also balances the reconvergent operand traffic exactly -- each staged A
//   byte feeds 128 output columns and each staged B byte feeds 128 output
//   rows, so per-replay L2 reads fall from ~768 MB (A 512 MB + B 256 MB) to
//   ~512 MB (A 256 MB + B 256 MB). LDS is 20,480 B (A[128,80] + B[128,80]),
//   so two blocks stay resident (40,960 B); VGPR grows by the eight extra int32
//   accumulator fragments (~115 expected, under the 128-VGPR two-block cap).
//   Falsifiable: if the residual time is per-MAC instruction/latency overhead
//   that a square quadrant and half the barriers can hide, median_us drops
//   below the current 654.9467849731445; if the kernel instead needs the 12
//   resident waves of the 128x64 tile (or 16 accumulators push VGPR past 128),
//   median rises and the 2:1 tile is retained. K depth, the single-buffer
//   publish schedule, the 80-byte five-bank-phase strides, the exact int32
//   accumulation order, the packed layout, the shape guards and the scalar
//   fallback are unchanged.
//
// Iteration 5 - packed-B fragment-interleaved swizzle (round's mandated
// packing/swizzle round):
//   PMC/ISA of the accepted iteration-4 source (2,621,440 LDS instructions,
//   12,582,912 LDS bank conflicts = 4.80 conflict cycles per LDS instruction,
//   4,869,824 lds_wait_instructions, 827,392 VMEM reads, 20,480 B LDS at 128
//   arch VGPR, 1024 blocks, 500.3 us profiled against the 544.8 us median)
//   shows the B operand is already one 8-byte vector LDS read per fragment but
//   still not bank-safe: the n-major B tile's 80-byte (20-word) row stride
//   makes the 16-row sweep of every col_major B fragment alias the same bank
//   pairs, so the conflicts survive the iteration-2 vectorization. This round
//   replaces the [N/64, 64, K] panel layout with ONE fragment-interleaved
//   swizzle, still a byte-count-preserving permutation of the logical [K, N]
//   weight. For each 64-K stage and each 128-column block the packed data is
//   sixteen 512-byte fragment blocks ordered [k32][n16], each block stored as
//   [k8 0..3][n 0..15][8 B]:
//     packed[((k>>6)*(N/128) + (n>>7))*16 + ((k>>5)&1)*8 + ((n>>4)&7)]*512
//           + (((k>>3)&3)*16 + (n&15))*8 + (k&7)
//   An explicit col_major 8-byte loader (lane n = lane&15, k8 = lane>>4 reads
//   p + k8*128 + n*8) then puts each 16-lane phase on exactly one 128-byte k8
//   block -- all 32 banks exactly once, conflict-free by construction. The
//   block's 64-K B stage is one contiguous 8 KiB region, so the cooperative
//   stage store becomes two flat 16-byte copies per thread (chunk tid and
//   chunk tid+256) instead of two strided n-row vectors, and the global read
//   is a fully coalesced 8 KiB stream. The explicit loader's byte placement is
//   identical to du_load_matrix_sync<col_major>, so every v_mmac operand, the
//   k0-outer/kk-inner accumulation order and every int32 accumulator are
//   bit-identical. A keeps its row-major 80-byte stride and the single-
//   buffered 64-K pipeline with its publish schedule is unchanged; LDS/block
//   falls from 20,480 B to 18,432 B (10,240 A + 8,192 B), so two blocks still
//   stay resident at the 128-VGPR launch bound. Falsifiable: if the residual
//   LDS cost is bank-conflict serialization, lds_bank_conflicts fall sharply
//   and median_us drops below the current 544.7953414916992; if the conflicts
//   were already covered by the two resident blocks and the explicit loader
//   only adds address ALU, median rises and the panel layout is retained.
//
// Iteration 6 - fused coalesced epilogue (round's mandated epilogue round):
//   PMC/ISA of the accepted iteration-5 source (2,097,152 LDS instructions,
//   6,291,456 LDS bank conflicts, 4,884,093 lds_wait_instructions, 827,392
//   VMEM reads, 262,144 VMEM writes, 18,432 B LDS at 120 arch VGPR, 1024
//   blocks, 435.5 us profiled against the 479.2 us median) shows the residual
//   non-GEMM cost is the epilogue store, not the compute loop: the direct
//   accumulator store issues four 2-byte scalar global stores per lane per
//   fragment, and because the m16n16k32 ownership gives each lane four columns
//   strided by 4 (row = lane&15, c4 = lane>>4, x[i] -> c4 + 4*i) a store
//   instruction scatters over 16 rows x 8 bytes and touches each 32-byte
//   sector at 25% utilization, so the epilogue pays 262,144 wave-level store
//   instructions hauling 4x the output sectors it needs. This round fuses the
//   per-row/per-column scales and the bf16 conversion into ONE register-only
//   transpose store: a 4x4 in-wave transpose (two 2x2 steps, __shfl_xor 16
//   then 32; this DTK lowers it to ds_bpermute at the block tail where the LDS
//   pipe is idle) re-routes the four int32 values so lane (r, c4) ends up
//   holding the four CONTIGUOUS columns 4*c4..4*c4+3, which are then scaled,
//   converted to bf16 and written as ONE 8-byte store per lane. Every 32-byte
//   sector is 100% utilized and the epilogue issues 4x fewer store
//   instructions (16 per wave instead of 64); the per-column weight scale also
//   collapses from four scalar loads to one float4 load per fragment. Only the
//   int32 values are re-routed between lanes, and the per-element multiply
//   order float(dot) * x_scale[row] * weight_scale[col] plus
//   __float2bfloat16 are unchanged, so every stored bf16 bit is identical. The
//   kernel already performs no split-K and never touches the workspace (the
//   timed operator is a single compute dispatch), so no workspace/combine pass
//   exists to remove; LDS stays 18,432 B, and the single-buffered 64-K
//   pipeline, the fragment loaders, the exact int32 accumulation order, the
//   shape guards and the scalar fallback are unchanged. Falsifiable: if the
//   residual time is store-sector over-fetch and the shuffle ALU is hidden,
//   vmem_write instructions fall ~4x and median_us drops below the current
//   479.2323112487793; if the transpose ds_bpermute/v_cndmask chain contends
//   with the LDS pipe or the extra live scale registers spill, median rises
//   and the direct store is retained.
//
//   * launch_pack_w8a8_weight packs exactly (k, n) == (2048, 4096) into the
//     fragment-interleaved swizzle above (byte-count preserving, same
//     allocation and same graph-stable captured addresses). Every other
//     (k, n) keeps the identity device-to-device copy, and
//     packed_weight_scale is always the identity copy of weight_scale. Packing
//     happens before Graph capture and never inside the timed GEMM.
//
//   * Generic scalar int8/int32 fallback for every unmatched (m, n, k),
//     including all M < 128 API cases and the paired small-M shape with the
//     same (N, K) == (4096, 2048). The fallback decodes the fragment-
//     interleaved swizzle for that exact (k, n) pair and the identity layout
//     otherwise, so it is correct for every packed/unpacked weight.
//
// The timed operator performs no allocation, compilation, autotuning, weight
// packing, host/device synchronization, or default-stream launch; it uses only
// the caller-provided out and workspace and launches on the caller-provided
// PyTorch HIP stream, so it is CUDA-Graph safe. This round does not use the
// workspace at all.
//
// Include order is known-good for this DTK: hip_runtime.h first, then
// hip_bfloat16.h, then du_mma.h (du_mma.h is not self-contained before the HIP
// runtime headers; du_mma_common.h is not an installed public header).

#include <hip/hip_runtime.h>
#include <hip/hip_bfloat16.h>
#include <du_mma.h>

#include <cstdint>

namespace {

using namespace du::dumma;

constexpr int kTileM = 16;
constexpr int kTileN = 16;
constexpr int kTileK = 32;   // gfx928 INT8 DUMMA primitive: m16n16k32
constexpr int kWaveSize = 64;  // gfx928 native wavefront

constexpr int kTargetM = 4096;
constexpr int kTargetN = 4096;
constexpr int kTargetK = 2048;

constexpr int kBlockM = 128;   // output tile rows per block
constexpr int kBlockN = 128;   // output tile columns per block
constexpr int kStageK = 64;    // K depth staged per barrier
constexpr int kBPad = 16;      // 64 -> 80-byte A LDS row stride (five bank phases)
constexpr int kAStride = kStageK + kBPad;
constexpr int kBlockThreads = 4 * kWaveSize;

// Iteration 5 - fragment-interleaved packed-B swizzle. Each 32-k x 16-n DUMMA
// B fragment block is 512 B stored as [k8 0..3][n 0..15][8 B]; a 64-K stage of
// a 128-column block is (kStageK/kTileK) * (kBlockN/kTileN) = 16 such blocks,
// i.e. 8,192 B held in exactly the packed global order. The cooperative stage
// store is therefore two flat 16-byte copies per thread (chunk tid and chunk
// tid + kBlockThreads) and the col_major fragment load is one 8-byte read per
// lane at p + k8*128 + n*8.
constexpr int kSwzBlock = 512;  // bytes per fragment block
constexpr int kKGroup = 8;      // int8 k bytes owned by one col_major lane
constexpr int kBSwzBlocks = (kStageK / kTileK) * (kBlockN / kTileN);
constexpr int kBSwzBytes = kBSwzBlocks * kSwzBlock;
constexpr int kBChunks = kBSwzBytes / static_cast<int>(sizeof(int4));
static_assert(kBChunks == 2 * kBlockThreads,
              "each thread stages exactly two int4 chunks of packed B");
static_assert(kBSwzBytes == kBlockN * kStageK,
              "the swizzle is byte-count preserving for the B stage");

using bf16_t = hip_bfloat16;

// ---------------------------------------------------------------------------
// Iteration 6 - fused, fully coalesced epilogue. The per-row x_scale, the
// per-column weight_scale, the bf16 conversion and the store all happen here
// inside the compute kernel (no separate epilogue/combine pass and no
// workspace traffic).
//
// Verified gfx928 int8 m16n16k32 accumulator ownership (cross-checked against
// du_store_matrix_sync): lane & 15 selects the fragment row, lane >> 4 selects
// the column group c4, and x[i] maps to columns c4 + 4*i. A direct store is
// therefore four 2-byte scalar stores per lane whose wavefront addresses touch
// each 32-byte sector at 25% utilization. This helper transposes the 4-element
// groups within each 4-lane column group (lanes r, r+16, r+32, r+48 -- a 4x4
// transpose done as two 2x2 steps with __shfl_xor 16 then 32; this DTK lowers
// __shfl_xor to ds_bpermute at the block tail where the LDS pipe is idle), so
// lane (r, c4) ends up holding the four CONTIGUOUS columns 4*c4 .. 4*c4+3, and
// writes them as ONE 8-byte store (100% sector efficiency). The per-column
// weight scale collapses from four scalar loads to one float4 load. Only the
// int32 values are re-routed between lanes; the per-element multiply order
// (float(dot) * x_scale[row] * weight_scale[col]) and the __float2bfloat16
// rounding are unchanged, so the stored bits are identical to the direct
// per-element store. The row >= m guard is wavefront-uniform (base_row is a
// multiple of 16 and m is a multiple of 16 on every launched path), so the
// shuffles never mix active and inactive lanes.
// ---------------------------------------------------------------------------
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

  // Lane (r, c4) now owns columns base_col + 4*c4 .. +3 (8 B, 8-byte aligned:
  // base_col is a multiple of 16, n*2 is a multiple of 8).
  const int col0 = base_col + 4 * c4;
  const float xs = x_scale[row];
  const float4 ws = *reinterpret_cast<const float4*>(weight_scale + col0);
  const float v0 = static_cast<float>(f0) * xs * ws.x;
  const float v1 = static_cast<float>(f1) * xs * ws.y;
  const float v2 = static_cast<float>(f2) * xs * ws.z;
  const float v3 = static_cast<float>(f3) * xs * ws.w;
  const uint64_t packed =
      static_cast<uint64_t>(
          static_cast<unsigned short>(__float2bfloat16(v0))) |
      (static_cast<uint64_t>(
           static_cast<unsigned short>(__float2bfloat16(v1)))
       << 16) |
      (static_cast<uint64_t>(
           static_cast<unsigned short>(__float2bfloat16(v2)))
       << 32) |
      (static_cast<uint64_t>(
           static_cast<unsigned short>(__float2bfloat16(v3)))
       << 48);
  *reinterpret_cast<uint64_t*>(out + static_cast<int64_t>(row) * n + col0) =
      packed;
}

// ---------------------------------------------------------------------------
// Iteration 5 - explicit col_major B fragment loader on the fragment-
// interleaved swizzled tile. The gfx928 int8 m16n16k32 col_major matrix_b
// mapping is n = lane & 15, k8 = lane >> 4 (each lane owns eight contiguous k
// bytes), so on a [k8 0..3][n 0..15][8 B] block the lane's data sits at
// p + k8*128 + n*8. One 8-byte vector LDS read per lane, and each 16-lane
// phase spans exactly one 128-byte k8 block -- all 32 banks exactly once, so
// the fragment load is conflict-free by construction. The byte placement is
// identical to du_load_matrix_sync<col_major>, so the
// v_mmac_i32_16x16x32_i8 operands and the int32 accumulation are bit-identical
// to the previous n-major panel layout.
// ---------------------------------------------------------------------------
__device__ __forceinline__ void load_b_frag8_swizzled(
    DUFragment<matrix_b, kTileM, kTileN, kTileK, signed char, col_major>& frag,
    const int8_t* __restrict__ p,
    int lane) {
  const unsigned n = static_cast<unsigned>(lane) & 0xfu;
  const unsigned k8 = static_cast<unsigned>(lane) >> 4;
  const int64_t v = *reinterpret_cast<const int64_t*>(p + (k8 << 7) + (n << 3));
  *reinterpret_cast<int64_t*>(&frag.x[0]) = v;
}

// ---------------------------------------------------------------------------
// Exact-shape prefill: 128x128 output tile per block, four wavefronts of 64
// lanes. Each wave owns a 64x64 quadrant (sixteen m16n16k32 accumulators); the
// block cooperatively stages A[128,64] (row-major, k-major per lane) and the
// fragment-interleaved packed-B 64-K stage (16 x 512 B = 8,192 B, [k32][n16]
// block order with each block stored [k8][n][8 B]) in ONE 64-K buffer (18,432 B
// total) with two barriers per stage (iteration-3 pipeline). The swizzled B
// tile plus the explicit col_major 8-byte loader makes every B fragment one
// conflict-free ds_read_b64 (each 16-lane phase spans exactly one 128-byte k8
// block), and the square 64x64 quadrant pays eight fragment loads per sixteen
// MMACs instead of six per eight.
// ---------------------------------------------------------------------------
// The 2 in the launch bound asks the compiler to keep two blocks (eight waves)
// resident per CU, which caps the VGPR budget at 128 per thread: with sixteen
// int32 accumulator fragments (64 VGPRs) plus the four-int4 pipeline payload
// the natural allocation lands under that cap, and the bound prevents a
// compiler choice that would silently drop residency to one block (four
// waves) per CU.
__global__ __launch_bounds__(kBlockThreads, 2) void
w8a8_dumma_128x128x64_packed_kernel(
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
  const int wave_row = wave >> 1;
  const int wave_col = wave & 1;
  const int m0 = static_cast<int>(blockIdx.y) * kBlockM;
  const int n0 = static_cast<int>(blockIdx.x) * kBlockN;
  // Iteration-5 packed layout: for each 64-K stage and each 128-column block the
  // weight is stored as 16 fragment blocks of 512 B in [k32][n16] order, so this
  // block's whole 64-K B stage is ONE contiguous kBSwzBytes region at
  // ((k0/64) * (N/128) + blockIdx.x) * kBSwzBytes. The staging is therefore a
  // flat 16-byte copy per chunk (no transpose, no padding).
  const int b_colblocks = kTargetN / kBlockN;
  const int local_row = wave_row * 64;
  const int local_col = wave_col * 64;

  // Iteration 5 - square macro-tile with the swizzled B stage. A[128,64] rows
  // keep the 80-byte five-bank-phase stride (128 * 80 = 10,240 B) and the
  // packed-B 64-K stage is a dense 8,192 B swizzled region, so the block uses
  // 18,432 B. Two blocks stay resident (36,864 B of the 64 KiB LDS budget) and
  // the 16 accumulator fragments land under the 128-VGPR two-block cap.
  __shared__ __align__(16) int8_t a_tile[kBlockM * kAStride];
  __shared__ __align__(16) int8_t b_tile[kBSwzBytes];

  DUFragment<matrix_a, kTileM, kTileN, kTileK, signed char, row_major>
      a_frag0, a_frag1, a_frag2, a_frag3;
  DUFragment<matrix_b, kTileM, kTileN, kTileK, signed char, col_major>
      b_frag0, b_frag1, b_frag2, b_frag3;
  DUFragment<accumulator, kTileM, kTileN, kTileK, int>
      acc00, acc01, acc02, acc03,
      acc10, acc11, acc12, acc13,
      acc20, acc21, acc22, acc23,
      acc30, acc31, acc32, acc33;
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

  // Prologue: cooperative vectorized staging of stage 0 straight into the one
  // LDS tile. Each thread owns one int4 in A rows [0,64), one in A rows
  // [64,128) (tid/4 is the row, (tid%4)*16 the K chunk) and two int4 of the
  // packed-B stage (chunk tid and chunk tid + 256). A's tiles keep their
  // 80-byte row stride; the packed-B stage is contiguous in global memory and
  // in LDS, so both of its 16-byte copies are flat and fully coalesced.
  constexpr int kInt4 = static_cast<int>(sizeof(int4));
  const int vector_byte_offset = tid * kInt4;
  const int stage_row = vector_byte_offset / kStageK;
  const int stage_col = vector_byte_offset - stage_row * kStageK;
  const int b_stage_base0 = static_cast<int>(blockIdx.x) * kBSwzBytes;
  *reinterpret_cast<int4*>(a_tile + stage_row * kAStride + stage_col) =
      *reinterpret_cast<const int4*>(
          x_q + static_cast<int64_t>(m0 + stage_row) * k + stage_col);
  *reinterpret_cast<int4*>(a_tile +
                           (stage_row + kBlockM / 2) * kAStride + stage_col) =
      *reinterpret_cast<const int4*>(
          x_q + static_cast<int64_t>(m0 + stage_row + kBlockM / 2) * k +
          stage_col);
  *reinterpret_cast<int4*>(b_tile + tid * kInt4) =
      *reinterpret_cast<const int4*>(weight + b_stage_base0 + tid * kInt4);
  *reinterpret_cast<int4*>(b_tile + (tid + kBlockThreads) * kInt4) =
      *reinterpret_cast<const int4*>(weight + b_stage_base0 +
                                     (tid + kBlockThreads) * kInt4);
  __syncthreads();

  // Loop-carried register payload for stage kStageK, the first stage that has
  // to be republished into the single buffer. It is consumed by the stage-0
  // burst first and only published after that burst retires, so it keeps a
  // one-full-stage lead from load to LDS store, exactly as before.
  int4 cur_a0{};
  int4 cur_a1{};
  int4 cur_b0{};
  int4 cur_b1{};
  if (k > kStageK) {
    cur_a0 = *reinterpret_cast<const int4*>(
        x_q + static_cast<int64_t>(m0 + stage_row) * k + kStageK + stage_col);
    cur_a1 = *reinterpret_cast<const int4*>(
        x_q + static_cast<int64_t>(m0 + stage_row + kBlockM / 2) * k +
        kStageK + stage_col);
    cur_b0 = *reinterpret_cast<const int4*>(
        weight + (b_colblocks + static_cast<int>(blockIdx.x)) * kBSwzBytes +
        tid * kInt4);
    cur_b1 = *reinterpret_cast<const int4*>(
        weight + (b_colblocks + static_cast<int>(blockIdx.x)) * kBSwzBytes +
        (tid + kBlockThreads) * kInt4);
  }

  for (int k0 = 0; k0 < k; k0 += kStageK) {
    // Each wave consumes its 64x64 quadrant from the single LDS tile: sixteen
    // m16n16k32 MMACs per kk from four A and four B fragments (0.5 LDS loads
    // per MMAC instead of the 0.75 of the 128x64 tile).
#pragma unroll
    for (int kk = 0; kk < kStageK; kk += kTileK) {
      // Swizzled B block index of this wave's four 16-n fragments: k32 half
      // (kk/32) selects the [k32] outer index, and this wave's 64-column
      // quadrant starts at n16 group wave_col*4.
      const int b_swz = ((kk >> 5) << 3) + (wave_col << 2);
      load_b_frag8_swizzled(b_frag0, b_tile + (b_swz + 0) * kSwzBlock, lane);
      load_b_frag8_swizzled(b_frag1, b_tile + (b_swz + 1) * kSwzBlock, lane);
      du_load_matrix_sync(
          a_frag0, a_tile + (local_row + 0 * kTileM) * kAStride + kk,
          kAStride);
      du_load_matrix_sync(
          a_frag1, a_tile + (local_row + 1 * kTileM) * kAStride + kk,
          kAStride);
      du_mma_sync(acc00, a_frag0, b_frag0, acc00);
      du_mma_sync(acc01, a_frag0, b_frag1, acc01);
      du_mma_sync(acc10, a_frag1, b_frag0, acc10);
      du_mma_sync(acc11, a_frag1, b_frag1, acc11);
      load_b_frag8_swizzled(b_frag2, b_tile + (b_swz + 2) * kSwzBlock, lane);
      load_b_frag8_swizzled(b_frag3, b_tile + (b_swz + 3) * kSwzBlock, lane);
      du_load_matrix_sync(
          a_frag2, a_tile + (local_row + 2 * kTileM) * kAStride + kk,
          kAStride);
      du_load_matrix_sync(
          a_frag3, a_tile + (local_row + 3 * kTileM) * kAStride + kk,
          kAStride);
      du_mma_sync(acc02, a_frag0, b_frag2, acc02);
      du_mma_sync(acc03, a_frag0, b_frag3, acc03);
      du_mma_sync(acc12, a_frag1, b_frag2, acc12);
      du_mma_sync(acc13, a_frag1, b_frag3, acc13);
      du_mma_sync(acc22, a_frag2, b_frag2, acc22);
      du_mma_sync(acc23, a_frag2, b_frag3, acc23);
      du_mma_sync(acc32, a_frag3, b_frag2, acc32);
      du_mma_sync(acc33, a_frag3, b_frag3, acc33);
      du_mma_sync(acc20, a_frag2, b_frag0, acc20);
      du_mma_sync(acc21, a_frag2, b_frag1, acc21);
      du_mma_sync(acc30, a_frag3, b_frag0, acc30);
      du_mma_sync(acc31, a_frag3, b_frag1, acc31);
    }
    // Single-buffer hazard: the tile must not be overwritten while any wave is
    // still reading it. This is the extra barrier the single-buffered pipeline
    // pays per K stage (the ping-pong version published into the idle buffer
    // at the top of the stage and needed only one barrier).
    __syncthreads();

    const int next_k = k0 + kStageK;
    if (next_k < k) {
      // Publish stage next_k into the now-idle single tile. The store latency
      // is no longer hidden under a burst, so the second barrier below is
      // required before the next stage's first fragment loads.
      *reinterpret_cast<int4*>(a_tile + stage_row * kAStride + stage_col) =
          cur_a0;
      *reinterpret_cast<int4*>(a_tile +
                               (stage_row + kBlockM / 2) * kAStride +
                               stage_col) = cur_a1;
      *reinterpret_cast<int4*>(b_tile + tid * kInt4) = cur_b0;
      *reinterpret_cast<int4*>(b_tile + (tid + kBlockThreads) * kInt4) =
          cur_b1;
      __syncthreads();
      // Refill the register payload one stage further out; the lead from this
      // load to its publish at the end of the next iteration is still one full
      // stage, so the global->register latency is covered as before.
      const int load_k = k0 + 2 * kStageK;
      if (load_k < k) {
        cur_a0 = *reinterpret_cast<const int4*>(
            x_q + static_cast<int64_t>(m0 + stage_row) * k + load_k +
            stage_col);
        cur_a1 = *reinterpret_cast<const int4*>(
            x_q + static_cast<int64_t>(m0 + stage_row + kBlockM / 2) * k +
            load_k + stage_col);
        const int b_load_base =
            ((load_k >> 6) * b_colblocks + static_cast<int>(blockIdx.x)) *
            kBSwzBytes;
        cur_b0 = *reinterpret_cast<const int4*>(weight + b_load_base +
                                                tid * kInt4);
        cur_b1 = *reinterpret_cast<const int4*>(
            weight + b_load_base + (tid + kBlockThreads) * kInt4);
      }
    }
  }

  const int base_row = m0 + local_row;
  const int base_col = n0 + local_col;
  store_prefill_fragment_coalesced(acc00, x_scale, weight_scale, out,
                                   base_row, base_col, m, n, lane);
  store_prefill_fragment_coalesced(acc01, x_scale, weight_scale, out,
                                   base_row, base_col + kTileN, m, n, lane);
  store_prefill_fragment_coalesced(acc02, x_scale, weight_scale, out,
                                   base_row, base_col + 2 * kTileN, m, n,
                                   lane);
  store_prefill_fragment_coalesced(acc03, x_scale, weight_scale, out,
                                   base_row, base_col + 3 * kTileN, m, n,
                                   lane);
  store_prefill_fragment_coalesced(acc10, x_scale, weight_scale, out,
                                   base_row + kTileM, base_col, m, n, lane);
  store_prefill_fragment_coalesced(acc11, x_scale, weight_scale, out,
                                   base_row + kTileM, base_col + kTileN, m, n,
                                   lane);
  store_prefill_fragment_coalesced(acc12, x_scale, weight_scale, out,
                                   base_row + kTileM, base_col + 2 * kTileN, m,
                                   n, lane);
  store_prefill_fragment_coalesced(acc13, x_scale, weight_scale, out,
                                   base_row + kTileM, base_col + 3 * kTileN, m,
                                   n, lane);
  store_prefill_fragment_coalesced(acc20, x_scale, weight_scale, out,
                                   base_row + 2 * kTileM, base_col, m, n,
                                   lane);
  store_prefill_fragment_coalesced(acc21, x_scale, weight_scale, out,
                                   base_row + 2 * kTileM, base_col + kTileN, m,
                                   n, lane);
  store_prefill_fragment_coalesced(acc22, x_scale, weight_scale, out,
                                   base_row + 2 * kTileM, base_col + 2 * kTileN,
                                   m, n, lane);
  store_prefill_fragment_coalesced(acc23, x_scale, weight_scale, out,
                                   base_row + 2 * kTileM, base_col + 3 * kTileN,
                                   m, n, lane);
  store_prefill_fragment_coalesced(acc30, x_scale, weight_scale, out,
                                   base_row + 3 * kTileM, base_col, m, n,
                                   lane);
  store_prefill_fragment_coalesced(acc31, x_scale, weight_scale, out,
                                   base_row + 3 * kTileM, base_col + kTileN, m,
                                   n, lane);
  store_prefill_fragment_coalesced(acc32, x_scale, weight_scale, out,
                                   base_row + 3 * kTileM, base_col + 2 * kTileN,
                                   m, n, lane);
  store_prefill_fragment_coalesced(acc33, x_scale, weight_scale, out,
                                   base_row + 3 * kTileM, base_col + 3 * kTileN,
                                   m, n, lane);
}

// ---------------------------------------------------------------------------
// Generic scalar fallback: one thread per output element. Exact int32 dot over
// K, then fused x_scale * weight_scale, then bf16 store. Handles every
// unmatched (m, n, k), including all M < 128. When (k, n) matches the packed
// pair (2048, 4096) the weight is read from the iteration-5 fragment-
// interleaved swizzle; otherwise from the identity layout.
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
  if (n == kTargetN && k == kTargetK) {
    // Decode the same swizzle the packer writes (ascending kk, exact order).
    const int colblock = col / kBlockN;
    const int n16 = (col % kBlockN) / kTileN;
    const int r = col % kTileN;
    for (int kk = 0; kk < k; ++kk) {
      const int ks = kk % kStageK;
      const int block = ((kk / kStageK) * (kTargetN / kBlockN) + colblock) *
                            kBSwzBlocks +
                        (ks / kTileK) * (kBlockN / kTileN) + n16;
      const int64_t idx =
          static_cast<int64_t>(block) * kSwzBlock +
          static_cast<int64_t>((ks % kTileK) / kKGroup) * (kTileN * kKGroup) +
          static_cast<int64_t>(r) * kKGroup + (kk % kKGroup);
      acc += static_cast<int32_t>(x_q[static_cast<int64_t>(row) * k + kk]) *
             static_cast<int32_t>(weight[idx]);
    }
  } else {
    const int8_t* a_row = x_q + static_cast<int64_t>(row) * k;
    const int8_t* b_col = weight + col;
    for (int kk = 0; kk < k; ++kk) {
      acc += static_cast<int32_t>(a_row[kk]) *
             static_cast<int32_t>(b_col[static_cast<int64_t>(kk) * n]);
    }
  }
  const float scaled = static_cast<float>(acc) * x_scale[row] *
                       weight_scale[col];
  out[linear] = __float2bfloat16(scaled);
}

// ---------------------------------------------------------------------------
// Weight packing: the exact (k, n) == (2048, 4096) weight is permuted once,
// outside the timed region and outside Graph capture, into the iteration-5
// fragment-interleaved swizzle. For each 64-K stage and each 128-column block
// there are kBSwzBlocks = 16 fragment blocks of 512 B ordered [k32][n16], each
// stored as [k8 0..3][n 0..15][8 B]. Every packed 16-byte chunk is therefore a
// flat 16-byte store of two 8-byte k-runs (n rows 2*n_pair and 2*n_pair+1 of
// one k8 group), which is exactly the chunk the cooperative stage store later
// copies into LDS. The byte count k*n, the allocation and the graph-stable
// captured addresses are unchanged; every other (k, n) keeps the identity
// device-to-device copy, and the scales are always copied identity.
// ---------------------------------------------------------------------------
__global__ __launch_bounds__(256) void w8a8_pack_bswz_i8_kernel(
    const int8_t* __restrict__ raw_weight,
    int8_t* __restrict__ packed_weight) {
  const int chunk = static_cast<int>(blockIdx.x) * blockDim.x + threadIdx.x;
  constexpr int kChunks =
      kTargetK * kTargetN / static_cast<int>(sizeof(int4));
  if (chunk >= kChunks) {
    return;
  }
  constexpr int kChunksPerBlock = kSwzBlock / static_cast<int>(sizeof(int4));
  constexpr int kPairsPerK8 = kTileN / 2;  // 16-byte chunks per k8 group
  const int within = chunk % kChunksPerBlock;
  const int block = chunk / kChunksPerBlock;
  const int kk8 = within / kPairsPerK8;
  const int n_pair = within % kPairsPerK8;
  const int n16 = block % (kBlockN / kTileN);
  const int k32 = (block / (kBlockN / kTileN)) % (kStageK / kTileK);
  const int colblock = (block / kBSwzBlocks) % (kTargetN / kBlockN);
  const int stage = block / (kBSwzBlocks * (kTargetN / kBlockN));
  const int kk_base = stage * kStageK + k32 * kTileK + kk8 * kKGroup;
  const int col0 = colblock * kBlockN + n16 * kTileN + n_pair * 2;
  // Transposed gather: one 16-byte chunk = two 8-byte k-runs of adjacent n.
  int4 value;
  int8_t* bytes = reinterpret_cast<int8_t*>(&value);
#pragma unroll
  for (int i = 0; i < kKGroup; ++i) {
    bytes[i] = raw_weight[static_cast<int64_t>(kk_base + i) * kTargetN + col0];
    bytes[kKGroup + i] =
        raw_weight[static_cast<int64_t>(kk_base + i) * kTargetN + col0 + 1];
  }
  *reinterpret_cast<int4*>(packed_weight +
                           chunk * static_cast<int>(sizeof(int4))) = value;
}

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
// Stable host launch symbols consumed by csrc/bindings.cpp. Both launchers are
// pure dispatch: no allocation, no packing, no synchronization, no
// default-stream launch; they run on the caller-provided PyTorch stream and
// are CUDA-Graph safe.
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
  (void)workspace;        // no split-K: the GEMM never touches the workspace
  (void)workspace_bytes;
  auto* out_bf16 = reinterpret_cast<bf16_t*>(out);

  // Explicit dispatch. The assigned shape (M=4096, N=4096, K=2048) takes the
  // swizzled-packed DUMMA 128x128 path; every other (m, n, k) - including every
  // M < 128 API case and the paired small-M shape with the same (N, K) - takes
  // the scalar fallback, which understands the fragment-interleaved swizzle.
  if (m == kTargetM && n == kTargetN && k == kTargetK) {
    const dim3 grid(static_cast<unsigned>(kTargetN / kBlockN),
                    static_cast<unsigned>(kTargetM / kBlockM));
    const dim3 block(kBlockThreads);
    hipLaunchKernelGGL(w8a8_dumma_128x128x64_packed_kernel, grid, block, 0,
                       stream, a, b, x_scale, weight_scale, out_bf16, m, n, k);
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
  if (k == kTargetK && n == kTargetN) {
    constexpr int kPackVectors =
        kTargetK * kTargetN / static_cast<int>(sizeof(int4));
    const dim3 weight_grid(
        static_cast<unsigned>((kPackVectors + kBlock - 1) / kBlock));
    const dim3 block(kBlock);
    hipLaunchKernelGGL(w8a8_pack_bswz_i8_kernel, weight_grid, block, 0,
                       stream, raw_weight, packed_weight);
  } else {
    const int64_t weight_count = static_cast<int64_t>(k) * n;
    if (weight_count > 0) {
      const dim3 weight_grid(
          static_cast<unsigned>((weight_count + kBlock - 1) / kBlock));
      const dim3 block(kBlock);
      hipLaunchKernelGGL(w8a8_pack_identity_kernel, weight_grid, block, 0,
                         stream, raw_weight, packed_weight, weight_count);
    }
  }
  if (n > 0) {
    const dim3 scale_grid(static_cast<unsigned>(
        (static_cast<int64_t>(n) + kBlock - 1) / kBlock));
    const dim3 block(kBlock);
    hipLaunchKernelGGL(w8a8_pack_scale_identity_kernel, scale_grid, block, 0,
                       stream, weight_scale, packed_weight_scale, n);
  }
  (void)hipGetLastError();
}
// @@end
