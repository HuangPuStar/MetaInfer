// @@variant shape=hy3_tp8_o_proj_m16 commit=0b2614f457656239125b5d510d60e65275d45e24 added=2026-09-09
//   median_us=11.04 p90_us=11.16 speedup=2.91 baseline_us=32.14
//   source=hy3-dsh-tp8-m16-9-8-0161e718
// MetaInfer W8A8 INT8 GEMM HIP implementation.
//
// Worker:  worker_1 (physical GPU 1)
// Task:    hy3-dsh-tp8-m16-9-8-0161e718, parallel-explore child
// Shape:   hy3_tp8_o_proj_m16  M=16, N=4096, K=1024
//
// Iteration 0 = correctness bootstrap: one scalar int8 dot-product kernel,
// one thread -> one output element (no DUMMA). Official median 78.99 us.
//
// Iteration 1 = minimal native gfx928 DUMMA m16n16k32 INT8 tile with the
// installed <du_mma.h> API: one 64-thread wavefront per block, one 16x16 N
// tile per block (grid = N/16 = 256 blocks; M = 16 fits exactly one M-tile),
// 32 strictly ascending du_mma_sync steps over K = 1024 in a single int32
// accumulator fragment, zero barriers anywhere (single wavefront per block;
// the epilogue LDS store->read round-trip is intra-wavefront program order),
// exact fp32 scale chain (float(acc) * x_scale[m] * weight_scale[n]) and
// round-to-nearest-even bf16 store, one launch per replay on the caller
// stream, no workspace use. Official median 18.2465 us (1.76x vs the fixed
// Triton 32.137 us Graph baseline), but the grid is only 256 resident
// one-wave blocks = 0.53 wavefronts/SIMD (256 waves over 120 CUs x 4
// SIMDs): about half of every SIMD's issue slots are empty, so the kernel
// is co-residency / load-latency bound, not compute bound.
//
// Iteration 2 (accepted official best 15.118930/15.126930 us; architecture
// mandate: one complete launch geometry among 1/2/4 waves per block x 1/2/4 adjacent N tiles): choose
// 2 wavefronts per block x 1 adjacent N tile per block = in-block
// split-K=2. Grid stays kNTiles = 256 blocks (>= 120 device CUs, ~2.13
// blocks/CU); each 128-thread block holds two 64-thread wavefronts. Wave 0
// accumulates the contiguous ascending K slice [0, 512), wave 1 accumulates
// [512, 1024) (16 m16n16k32 steps each, direct 8-B vectorized global
// fragment loads as in iteration 1). Each wave publishes its int32 partial
// tile to a per-block LDS plane pair (2 x 1 KiB), one END-of-K
// __syncthreads(), then wave 1 adds the planes (s=0 then s=1; int32
// addition is exact, so the combined total is bit-identical to iteration
// 1's single full-K accumulator) and runs the unchanged scale/RNE-bf16
// epilogue. This doubles the wavefront count to 512 (~1.07/SIMD, 4-5
// resident waves/CU) without any extra global traffic, needs no workspace,
// and mirrors the validated N=4096 M=16 o_proj winner of the TP4 decode
// lineage (256 blocks x 2 waves, one tile/block, one END-of-K barrier).
// The exact-shape weight pack (untimed, launch_pack_w8a8_weight) switches
// from the identity copy to an n-major transpose packed[n*K + k] =
// raw[k*N + n] for exactly (k, n) == (1024, 4096) so each lane's 8-byte
// matrix_b col_major fragment is one contiguous 8-B vectorized global load
// (identity [K, N] would scatter it one byte per k row); the generic scalar
// fallback decodes that n-major layout for the exact (k, n) pair so every
// other (m, n, k) -- including the paired M=2 API shape with the same
// (N, K) -- stays byte-exact. Identity packing is retained for every other
// (K, N).
//
// Iteration 9 (this round): the accepted iteration-2 kernel (official
// 15.118930/15.126930 us) is replaced by the exact-shape reference lineage's
// validated final architecture for this geometry (hy3-dsh-tp8-m16-2-dc53295a,
// official 12.43/12.59 us on the same fixed 32.137 us Triton baseline):
// grid-level split-K=4 (1024 one-wave blocks, ~2.13 resident wavefronts/
// SIMD), each block accumulating one contiguous ascending K quarter with A
// AND B both staged through the depth-1 double-buffered LDS window pipeline
// (one 16-B uint4 per lane per window issued one window ahead; per-step
// fragment loads read LDS at the 80-B padded stride), publishing its int32
// tile to a workspace plane, with the split-K combine FUSED into the same
// kernel as a per-tile last-arrival tail (monotonic counters in the
// workspace tail) so the operator stays one launch per replay. In-lineage
// experiments that failed to beat iteration 2 are reverted and NOT replayed:
// iteration 5 (wave-1 tail scale prefetch, 15.2968/15.3360 us), iteration 7
// (rolled depth-1 register stage transport, 19.2353/19.2721 us), iteration 8
// (in-block split-K=4 occupancy probe, 15.4697/15.5025 us).
//
// Iteration 17 (this round): B-stream-locality round on the accepted
// iteration-9 kernel (official 11.320700/11.428699 us, digest 71ac0c9a,
// verified == live source before this edit; git HEAD 2dc3fd7 clean). Rounds
// 11 (publish tail surgery, 12.7361/12.7681), 14 (A register-resident,
// 12.3341/12.4781) and 15 (grid split-K 8, 14.8350/14.8526) were rejected
// and rolled back byte-for-byte, so this is a NEW bounded experiment from
// the pristine accepted source. Round-14/15 evidence leaves ONE untested
// axis of the accepted architecture: the physical layout of the once-read
// 4-MiB packed-B stream. The accepted kernel's exact-shape pack is the
// n-major transpose packed[n*K+k] = raw[k*N+n] (column stride K = 1024), so
// every one of a block's four 1-KiB window prefetches issues 16 FULL 64-B
// L2 lines strided 1 KiB apart (each block's B quarter is 16 scattered
// column chunks of 256 B over 16 KiB of address space), and the replay-wide
// 4-MiB B stream is served as ~65k single lines with no run structure at
// the DRAM row level (~377 GB/s effective read for a per-replay 4.27-MB
// footprint in 11.32 us). This round REPACKS the exact-shape buffer (same
// 4-MiB buffer, same byte count, one-time untimed pack, byte-permutation
// only) so each (split, tile) block owns one contiguous 4-KiB slot holding
// its whole B slice: slot = split*256 + tile, then window (1 KiB), then
// column (64 B), then k. Each window prefetch then reads 16 SEQUENTIAL
// 64-B lines (one contiguous 1-KiB run per block per matrix per window),
// block slots are issued in launch order (blockIdx = split*256 + tile), and
// the replay B stream decomposes into 1024 advancing 4-KiB sequential runs
// instead of 4096 scattered 1-KiB column runs -- strictly better DRAM
// row-buffer / prefetch structure for byte-identical traffic. LDS staging,
// fragment order, plane/workspace protocol, epilogue chain, launch geometry
// and every byte VALUE the kernel consumes are unchanged (the slot is
// exactly the old 16 columns x 256 k of the block in the same ascending-k
// order), so int32 accumulation is bit-identical to iteration 9; the
// generic scalar fallback and the paired M=2 path decode the same new pack
// (w8a8_pack_b_off), keeping every output byte exact. Falsifiable
// prediction: official unprofiled Graph-replay median below 11.207493 us
// (>= 1% under 11.320700 us) with p90 <= 1.05 x 11.428699 = 11.999134 us,
// 0 mismatches, Graph capture passed and the paired M=2 fallback validation
// unchanged; flat 11.2-11.6 us falsifies DRAM run-locality as the limiter
// (kernel is latency-chain bound instead) and directs the next round to
// per-wave latency reduction at unchanged geometry/traffic.
//
// Iteration 19 (this round): two-tile-per-wave A-sharing round on the
// shadow-active iteration-17 source (digest 19ec89c8, official Graph-replay
// median 11.272130/11.289730 us on the same fixed 32.137 us Triton baseline;
// git HEAD 2dc3fd7 = accepted iteration 9). Rounds 11 (publish tile_lds
// removal, 12.7361/12.7681), 14 (A register-resident with 8-B global
// fragment preloads, 12.3341/12.4781), 15 (grid split-K 8, 2048 blocks,
// 14.8350/14.8526), 17 (B block-contiguous repack, 11.2721/11.2897 -- only
// +0.43%, not accepted) and 18 (split-K 8 + A register-resident at 3588 B
// LDS, 15.0071/16.1807) bound this round. The surviving limiter reading:
// the replay wall is dominated by per-replay L2 line-REQUEST service, not by
// DRAM bytes, LDS path instructions or occupancy. Every falsified round kept
// the per-replay line-request count at 131,072 read requests (A 65,536 = 4
// splits x 256 tile-blocks x one 4-KiB/64-line A slice each, B 65,536
// compulsory once-read lines), and round 14 is the one negative control that
// MOVED the request count: its 8 x 8-B dwordx2 A preloads re-requested each
// A 64-B line twice (request count up ~50%) and the wall went up ~9%.
// This round halves the A-side requests by pairing the two adjacent 16-col
// tiles of each (split, pair) in ONE 64-lane wave that stages and loads its
// 4-KiB A slice ONCE and feeds two 16x16 accumulator tiles from the same
// a_lds window stream (grid 512 = 4 splits x 128 tile pairs; b_lds gains a
// second per-stage 1280-B plane for the paired tile; per-window MMA work
// doubles 2 -> 4 so the depth-1 window-prefetch latency cover per wave
// grows; per-block plane publish and arrival machinery now serve two tiles).
// Per-replay read requests drop to ~98,304 (-25%: A 32,768, B 65,536) at
// byte-identical per-(tile, split) traffic, DRAM bytes, workspace protocol,
// int32 accumulation order and every output byte. Falsifiable prediction:
// official unprofiled Graph-replay median below 11.207493 us (>= 1% under
// 11.320700 us) with p90 <= 11.999134 us, 0 mismatches, Graph capture passed
// and the paired M=2 fallback validation unchanged; point expectation
// ~9.6-10.9 us if request service is the wall (the tp4 o_proj M16 lineage's
// 512-wavefront final kernel streamed its once-read B at ~460-520 GB/s vs
// ~372-450 GB/s here at 1024 waves -- fewer waves with more per-wave work is
// the proven-faster regime on this exact N=4096 geometry); flat ~11.2-11.6
// us or worse falsifies request service as the limiter and shows that >= ~2
// resident waves/SIMD are required to hide the per-wave latency chain,
// directing the next round back to grid-1024 per-wave latency/tail work.
//
// Logical operator (fixed contract, see int8_w8a8_gemm_api.py):
//     out[m, n] = bf16( int32_dot(x_q[m, :], weight[:, n])
//                       * x_scale[m, 0] * weight_scale[n, 0] )
// with x_q [M, K] int8, packed_weight the exact-shape n-major [N, K] int8
// transpose (identity [K, N] for every other shape), x_scale [M, 1] fp32,
// weight_scale [N, 1] fp32 and out [M, N] bf16.
//
// Host symbols (called from csrc/bindings.cpp, which owns TORCH_LIBRARY
// registration and the current-stream lookup):
//     launch_w8a8_gemm(...)
//     launch_pack_w8a8_weight(...)
//
// Graph-safety: the gemm launch uses only caller-provided tensors and the
// passed hipStream_t (PyTorch's current stream); it never allocates, packs,
// synchronizes, or touches the default stream. The exact-shape arm uses the
// caller workspace as int32 partial planes plus a 1-KiB monotonic
// arrival-counter tail that the launcher zeros once per workspace pointer on
// its first eager use (before Graph capture; never during capture/replay).
// pack_weight runs outside the timed region and outside Graph capture.
//
// Include order is the known-good DTK order: hip_runtime.h first, then
// hip_bfloat16.h, then du_mma.h (du_mma.h is not self-contained when included
// before the HIP runtime headers; du_mma_common.h is not a public header).

#include <hip/hip_runtime.h>
#include <hip/hip_bfloat16.h>
#include <du_mma.h>

#include <cstdint>

namespace {

// ---------------------------------------------------------------------------
// Geometry / tuning constants
// ---------------------------------------------------------------------------

// Generic scalar fallback block size (multiple of the 64-lane wavefront).
constexpr int kScalarThreads = 256;

// gfx928 wavefront / DUMMA tile geometry.
constexpr int kWaveSize = 64;
constexpr int kTileM = 16;
constexpr int kTileN = 16;
constexpr int kTileK = 32;

// Exact assigned decode shape: hy3_tp8_o_proj_m16 (worker_1 / GPU 1).
// (K, N) = (1024, 4096) is also a valid paired M=2 API shape; the exact-shape
// guard below deliberately includes m == kExactM so those paired shapes keep
// reaching the generic scalar fallback (which decodes the exact-shape n-major
// pack there).
constexpr int kExactM = 16;
constexpr int kExactN = 4096;
constexpr int kExactK = 1024;

// Exact-shape DUMMA launch plan (iteration 9): one 16x16 N tile per block,
// grid-level split-K = 4 along K (uniform contiguous ascending K quarters),
// one 64-thread wavefront per block, fused per-tile last-arrival combine
// (the exact-shape reference lineage's validated final architecture for this
// geometry: 12.43/12.59 us in hy3-dsh-tp8-m16-2-dc53295a). Each block stages
// its A+B slice through a depth-1 double-buffered LDS window pipeline (see
// the kernel below); the int32 partial planes and the per-tile arrival
// counters live in the caller workspace.
constexpr int kNTiles = kExactN / kTileN;   // 256 tiles (>= 120 device CUs)
constexpr int kSkSplitK = 4;                // grid split factor along K
constexpr int kSkKPerBlock = kExactK / kSkSplitK;  // 256 k per block
constexpr int kSkTilesPerBlock = 2;  // iteration 19: adjacent N tiles per wave
constexpr int kSkTPairs = kNTiles / kSkTilesPerBlock;  // 128 tile pairs per split
constexpr int kSkGrid = kSkSplitK * kSkTPairs;  // 512 one-wave blocks (1.07/SIMD)
constexpr int kWindowKRows = 64;   // k-rows per LDS window (2 m16n16k32 steps)
constexpr int kWindowKStride = 80; // 64 k-rows + 16 pad; 16-B aligned,
                                   // non-power-of-two bank skew (<=2-way)
constexpr int kWindowBytes = kTileN * kWindowKStride;  // 1280 B per stage
constexpr int kNumLdsStages = 2;   // depth-1 double buffering
constexpr int kSkWindows = kSkKPerBlock / kWindowKRows;  // 4 windows per block

// Iteration-17 B-pack slot geometry (see w8a8_pack_b_off / the pack kernel):
// the exact-shape packed buffer stores every (split, tile) block's whole B
// slice as one contiguous 4-KiB slot (4 windows x 16 columns x 64 k), so
// each window prefetch is one contiguous 1-KiB run (16 sequential 64-B
// lines) per matrix instead of 16 lines strided by the old column stride
// K = 1024.
constexpr int kBPackSliceBytes = 1 << 12;                 // 4096 B per slot
constexpr int kBPackWindowBytes = kTileN * kWindowKRows;  // 1024 B per window
constexpr int kBPackColBytes = kWindowKRows;  // 64 B per column per window
constexpr int64_t kPlaneInts =
    static_cast<int64_t>(kExactM) * kExactN;  // 65536 int32 per split plane
constexpr int64_t kPlaneBytes = kPlaneInts * sizeof(int32_t);  // 256 KiB
constexpr int64_t kCounterInts = kNTiles;  // one arrival counter per tile

// ---------------------------------------------------------------------------
// Device helpers
// ---------------------------------------------------------------------------

// float32 -> bfloat16 with round-to-nearest-even, stored as its raw uint16
// bit pattern. This is bit-identical to __float2bfloat16() / torch's bf16
// cast for finite inputs and keeps the epilogue independent of any one
// bfloat16 class/family: out tensors are plain 16-bit bf16 storage.
__device__ __forceinline__ uint16_t float_to_bf16_rn(const float v) {
  const uint32_t bits = __float_as_uint(v);
  // Add 0x7FFF plus the LSB of the kept half (ties round to even), then keep
  // the high 16 bits.
  const uint32_t rounded = (bits + 0x7FFFu + ((bits >> 16) & 1u)) >> 16;
  return static_cast<uint16_t>(rounded);
}

// ---------------------------------------------------------------------------
// Exact-shape block-contiguous B pack decode (iteration 17)
// ---------------------------------------------------------------------------
// Byte offset of column `col` / k-row `kk` inside the exact-shape packed
// buffer. The iteration-17 pack layout is a pure byte permutation of the
// iteration-1/9 n-major transpose packed[n*K+k] = raw[k*N+n] (same buffer,
// same byte count, same logical (col, k) byte values):
//   packed[ split*256 + tile ][ window ][ col&15 ][ kk&63 ]
// with split = kk >> 8 (K quarter 0..3), window = (kk >> 6) & 3 (1-KiB
// window inside the block's 4-KiB slice), tile = col >> 4 (0..255) and
// column c = col & 15. Slot = split*256 + tile holds one block's whole B
// slice: 4 windows x 1024 B; a window holds 16 columns x 64 contiguous k.
__device__ __forceinline__ int64_t w8a8_pack_b_off(const int col,
                                                   const int kk) {
  const int64_t split = static_cast<int64_t>(kk) >> 8;    // 0..3
  const int64_t w = (static_cast<int64_t>(kk) >> 6) & 3;  // 0..3
  const int64_t tile = static_cast<int64_t>(col) >> 4;    // 0..255
  const int64_t c = static_cast<int64_t>(col) & 15;       // 0..15
  return (split * kNTiles + tile) * kBPackSliceBytes +
         w * kBPackWindowBytes + c * kBPackColBytes +
         (static_cast<int64_t>(kk) & (kBPackColBytes - 1));
}

// ---------------------------------------------------------------------------
// Generic scalar correctness kernel (fallback for every unmatched shape)
// ---------------------------------------------------------------------------

// Scalar int8 dot-product GEMM, one thread per output element. Grid:
// blockIdx.x tiles the N dimension with kScalarThreads columns per block,
// blockIdx.y selects the M row, so adjacent lanes (threadIdx.x) read
// adjacent addresses along the fastest-varying N dimension (coalesced B
// reads) and every lane of a block broadcasts the same A row.
// For the exact (k, n) == (1024, 4096) the packed weight buffer holds the
// iteration-17 block-contiguous pack (one contiguous 4-KiB slot per
// (split, tile), see w8a8_pack_b_off), so the fallback decodes that layout
// there (this keeps the paired M=2 API shape with the same (N, K)
// byte-exact; the decode is a pure permutation of the iteration-1 n-major
// transpose it supersedes); every other (k, n) keeps the identity pack
// (raw row-major [K, N]).
__global__ __launch_bounds__(kScalarThreads) void w8a8_gemm_scalar_kernel(
    const int8_t* __restrict__ a,        // [M, K] row-major int8
    const int8_t* __restrict__ b,        // [K, N] (identity) or [N, K] (exact pair)
    const float* __restrict__ x_scale,   // [M] fp32
    const float* __restrict__ weight_scale,  // [N] fp32
    uint16_t* __restrict__ out,          // [M, N] bf16 raw storage
    const int m,
    const int n,
    const int k) {
  const int col = static_cast<int>(blockIdx.x) * kScalarThreads +
                  static_cast<int>(threadIdx.x);
  const int row = static_cast<int>(blockIdx.y);
  if (row >= m || col >= n) {
    return;
  }

  // Exact k-ascending int32 accumulation. Assigned K keeps the exact int8
  // dot well inside int32 range.
  const int8_t* a_row = a + static_cast<int64_t>(row) * k;
  const bool packed_nmajor = (k == kExactK && n == kExactN);
  int32_t acc = 0;
  if (packed_nmajor) {
    // Iteration-17 block-contiguous pack decode (w8a8_pack_b_off): the
    // exact-shape buffer was repacked (same bytes, new permutation) so each
    // block's B slice is one contiguous 4-KiB slot; the fallback reads the
    // same logical (col, kk) byte values as the iteration-1/9 n-major
    // transpose it supersedes.
    for (int kk = 0; kk < k; ++kk) {
      acc += static_cast<int32_t>(a_row[kk]) *
             static_cast<int32_t>(b[w8a8_pack_b_off(col, kk)]);
    }
  } else {
    const int8_t* b_col = b + col;  // advances by n every k step
    for (int kk = 0; kk < k; ++kk) {
      acc += static_cast<int32_t>(a_row[kk]) *
             static_cast<int32_t>(*b_col);
      b_col += n;
    }
  }

  // Convert to float only for the scaled product, then store bf16:
  // (int32 dot) * x_scale[m] * weight_scale[n] == ((dot * xs) * ws).
  const float scaled =
      static_cast<float>(acc) * x_scale[row] * weight_scale[col];
  out[static_cast<int64_t>(row) * n + col] = float_to_bf16_rn(scaled);
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Exact-shape DUMMA decode kernel (iteration 19: iteration-17 source plus
// two-tile-per-wave A-sharing; grid-level split-K = 4, A+B LDS-window
// staged, fused per-tile last-arrival combine)
// ---------------------------------------------------------------------------
// Architecture lineage: iteration 9 ported this geometry's validated
// reference kernel (hy3-dsh-tp8-m16-2-dc53295a, 12.43/12.59 us) -- one 16x16
// N tile per ONE-wave block, SPLIT_K = 4 grid-level K quarters (1024 blocks,
// ~2.13 resident waves/SIMD, zero intra-pipeline barriers), A and B both
// staged through a depth-1 double-buffered LDS window pipeline, split-K
// combine FUSED into the kernel (per-tile last-arrival tail) -- and reached
// the official best 11.320700/11.428699 us; iteration 17 repacked B into
// block-contiguous 4-KiB slots (shadow 11.272130/11.289730 us, +0.43% only).
//
// Iteration 19 geometry: each of the 128 tile PAIRS per split (two adjacent
// 16-col tiles) is computed by ONE 64-lane wave, so the grid is 512 one-wave
// blocks = 4 splits x 128 pairs (1.07 waves/SIMD). The wave stages and
// loads its 4-KiB A slice ONCE per window and feeds two 16x16 accumulator
// tiles from the same a_lds window stream (a_frag shared, b_lds holds a
// second per-stage 1280-B plane for the paired tile); per-window MMA work
// doubles (2 -> 4 m16n16k32 steps) so each window's compute covers its own
// depth-1 prefetch latency longer; per-block prologue, plane-publish and
// arrival machinery now serve two tiles. This is the first lineage round
// that reduces the per-replay L2 line-request count: A-side requests halve
// (65,536 -> 32,768: one 64-line A-slice request set per 2 tiles instead of
// per tile) and total read requests drop ~25% to ~98,304 (B stays 65,536
// compulsory once-read lines; DRAM bytes, workspace protocol, plane layout,
// counter semantics and every output byte are unchanged).
//
// Window pipeline per tile (byte-for-byte the accepted data path): tile t of
// a pair owns the contiguous ascending K slice [256*split, 256*split + 256)
// and k-rows are covered window by window ([64w, 64w + 64), w = 0..3 = two
// m16n16k32 steps per tile). Lane l prefetches ONE 16-B uint4 per matrix per
// window -- 16 contiguous k-bytes at k-offset 16*(lane>>4) of the window:
// A from the logical row-major ldm-K=1024 activation at row (lane&15), B
// from the iteration-17 block-contiguous pack slots (split*256 + 2*pair)<<12
// and +4096 (each (split, tile) slot = one contiguous 4-KiB run; the pair's
// two slots are adjacent) at column (lane&15) -- issued one full window
// ahead of consumption, stored into
// a_lds[w&1][(lane&15)*80 + 16*(lane>>4)] and
// b_lds[w&1][t&1][(lane&15)*80 + 16*(lane>>4)] (16 x 64-k window planes at
// the 80-B padded k-stride = 64+16 bank skew). The per-step fragment loads
// (du_mma.hpp: lane l reads 8 contiguous bytes at row (l&15)*ldm +
// (l>>4)*8 + i) read LDS at ldm = 80 -- no global vmcnt in the mmac chain.
//
// Exact int32 accumulation: per-tile dots stay strictly k-ascending over the
// windowed m16n16k32 steps (max |partial| = 256*127*127 << 2^31), so each
// published plane tile is bit-identical to the iteration-9/17 per-(split,
// tile) blocks; the last-arrival tail sums the SPLIT_K = 4 planes in
// ascending split order (s = 0..3); int32 addition is exact, so every output
// byte is bit-identical to the accepted kernels (0 mismatches expected).
//
// Combine + epilogue (fused tail, counters != nullptr): the wave publishes
// BOTH tiles' int32 results to workspace planes `split` (per-tile contiguous
// layout workspace[split][tile][256], one 16-B vector store per lane per
// tile, through two API LDS planes tile_lds0/tile_lds1 with
// du_store_matrix_sync mem_row_major ldm 16), then lane 0 __threadfence()s
// (release), increments BOTH tiles' monotonic arrival counters (atomicAdd),
// __threadfence()s (acquire) and records for each tile whether the
// pre-increment value satisfies (arrived % SPLIT_K) == SPLIT_K - 1 in
// shared s_last0/s_last1. Each tile's LAST arrival of the replay then reads
// its 4 row-major int32 chunks of each plane in ascending split order and
// runs the UNCHANGED accepted scale/RNE-bf16 epilogue
// float(total) * x_scale[row] * weight_scale[n0 + col] for its 4 columns
// (row = lane>>2, cbase = 4*(lane&3)); the other three splits of each tile
// exit. Counters are monotonic (each replay adds exactly SPLIT_K per tile),
// so no per-replay reset is needed; the launcher zeroes them once per
// workspace pointer on first eager use, before Graph capture.
// ---------------------------------------------------------------------------
__device__ __forceinline__ void w8a8_tail_emit_tile(
    const int32_t* __restrict__ partials, const int tile,
    const float* __restrict__ x_scale,
    const float* __restrict__ weight_scale, uint16_t* __restrict__ out) {
  // Fused per-tile last-arrival epilogue (byte-for-byte the iteration-9 tail):
  // 16-B aligned reads of the per-tile-contiguous plane layout
  // workspace[split][tile][256]; plane stride kPlaneInts/4 uint4s. Only the
  // tile's last arrival calls this (guarded by the caller), so the planes it
  // reads are all released (acquire fence in the caller) and L2-fresh.
  const int lane = static_cast<int>(threadIdx.x);
  const int row = lane >> 2;         // 0..15
  const int cbase = (lane & 3) * 4;  // 0, 4, 8, 12 within the tile
  const uint4* plane = reinterpret_cast<const uint4*>(partials) +
                       static_cast<int64_t>(tile) * (kTileM * kTileN / 4) +
                       row * 4 + (lane & 3);
  int32_t acc[4] = {0, 0, 0, 0};
#pragma unroll
  for (int s = 0; s < kSkSplitK; ++s) {
    const uint4 v = plane[s * (kPlaneInts / 4)];
    acc[0] += v.x;
    acc[1] += v.y;
    acc[2] += v.z;
    acc[3] += v.w;
  }
  const float xs = x_scale[row];
  const int n0 = tile * kTileN;
  uint16_t* out_p =
      out + static_cast<int64_t>(row) * kExactN + n0 + cbase;
#pragma unroll
  for (int i = 0; i < 4; ++i) {
    const float scaled =
        static_cast<float>(acc[i]) * xs * weight_scale[n0 + cbase + i];
    out_p[i] = float_to_bf16_rn(scaled);
  }
}
__global__ __launch_bounds__(kWaveSize) void w8a8_dumma_m16_n16_sk4_lds_fused_kernel(
    const int8_t* __restrict__ a,            // [M=16, K=1024] row-major int8
    const int8_t* __restrict__ b,            // packed [N, K] n-major int8
    int32_t* __restrict__ partials,          // workspace [kSkSplitK][kPlaneInts]
    int32_t* __restrict__ counters,          // workspace tail, 256 int32
    const float* __restrict__ x_scale,       // [16] fp32
    const float* __restrict__ weight_scale,  // [N] fp32
    uint16_t* __restrict__ out) {            // [16, N] bf16 raw storage
  const int lane = static_cast<int>(threadIdx.x);   // 0..63
  const int pair = static_cast<int>(blockIdx.x) % kSkTPairs;  // 0..127
  const int split = static_cast<int>(blockIdx.x) / kSkTPairs; // 0..3 (K quarter)
  const int tile0 = pair * kSkTilesPerBlock;  // even N tile of the pair
  const int tile1 = tile0 + 1;                // adjacent odd N tile
  const int kStart = split * kSkKPerBlock;    // contiguous ascending K quarter

  // Double-buffered LDS windows (private to this single-wave block; no
  // barrier inside the pipeline: store->read ordering is per-wave program
  // order, enforced by the compiler's lgkmcnt waits). b_lds holds one
  // 1280-B window plane per stage per tile of the pair; a_lds is SHARED by
  // the two tiles (one A window load/stage feeds two 16x16 accumulators).
  __shared__ __align__(16) int8_t a_lds[kNumLdsStages][kWindowBytes];
  __shared__ __align__(16) int8_t b_lds[kNumLdsStages][kSkTilesPerBlock]
                                        [kWindowBytes];

  du::dumma::DUFragment<du::dumma::matrix_a, kTileM, kTileN, kTileK,
                        signed char, du::dumma::row_major>
      a_frag[2];
  du::dumma::DUFragment<du::dumma::matrix_b, kTileM, kTileN, kTileK,
                        signed char, du::dumma::col_major>
      b0_frag[2];
  du::dumma::DUFragment<du::dumma::matrix_b, kTileM, kTileN, kTileK,
                        signed char, du::dumma::col_major>
      b1_frag[2];
  du::dumma::DUFragment<du::dumma::accumulator, kTileM, kTileN, kTileK, int>
      acc0_frag;
  du::dumma::DUFragment<du::dumma::accumulator, kTileM, kTileN, kTileK, int>
      acc1_frag;
  du::dumma::du_fill_fragment(acc0_frag, 0);
  du::dumma::du_fill_fragment(acc1_frag, 0);

  // Per-lane base pointers: A slice = activation row (lane&15). B = the
  // pair's two contiguous 4-KiB slots of the iteration-17 block-contiguous
  // pack at (split*256 + tile0) << 12 and +4096; inside a window (1 KiB),
  // lane (lane&15) owns column c = lane&15 whose 64 k-bytes sit at c << 6,
  // so one window prefetch is one contiguous 1-KiB run per tile (a pair
  // covers 8 KiB of sequential pack slots per block). Byte values are
  // identical to the iteration-9/17 layouts.
  const int8_t* b_slot =
      b + (static_cast<int64_t>(split) * kNTiles + tile0) * kBPackSliceBytes +
      (lane & 15) * kBPackColBytes;
  const int8_t* a_row = a + static_cast<int64_t>(lane & 15) * kExactK;

  // Prologue: prefetch window 0 for A and for each tile's B plane
  // (16 contiguous k-bytes per lane per matrix per tile).
  uint4 a_prefetch = *reinterpret_cast<const uint4*>(
      a_row + kStart + 16 * (lane >> 4));
  uint4 b0_prefetch = *reinterpret_cast<const uint4*>(
      b_slot + 16 * (lane >> 4));
  uint4 b1_prefetch = *reinterpret_cast<const uint4*>(
      b_slot + kBPackSliceBytes + 16 * (lane >> 4));

#pragma unroll
  for (int w = 0; w < kSkWindows; ++w) {
    // Store the previously-prefetched window w into buffer w&1 (its vmcnt
    // wait has had the prior iteration's compute to complete), then issue
    // the next window's prefetches before computing this window from LDS.
    *reinterpret_cast<uint4*>(
        &a_lds[w & 1][(lane & 15) * kWindowKStride + 16 * (lane >> 4)]) =
        a_prefetch;
    *reinterpret_cast<uint4*>(
        &b_lds[w & 1][0][(lane & 15) * kWindowKStride + 16 * (lane >> 4)]) =
        b0_prefetch;
    *reinterpret_cast<uint4*>(
        &b_lds[w & 1][1][(lane & 15) * kWindowKStride + 16 * (lane >> 4)]) =
        b1_prefetch;
    if (w + 1 < kSkWindows) {
      a_prefetch = *reinterpret_cast<const uint4*>(
          a_row + kStart + (w + 1) * kWindowKRows + 16 * (lane >> 4));
      b0_prefetch = *reinterpret_cast<const uint4*>(
          b_slot + (w + 1) * kBPackWindowBytes + 16 * (lane >> 4));
      b1_prefetch = *reinterpret_cast<const uint4*>(
          b_slot + kBPackSliceBytes + (w + 1) * kBPackWindowBytes +
          16 * (lane >> 4));
    }

    // Two ascending m16n16k32 steps of this window PER TILE, fragments from
    // LDS. The A fragments are loaded once and shared by both tiles' MMAs,
    // so one A window global load + LDS stage serves two 16x16 tiles: the
    // per-replay A-side line requests halve vs one tile per wave. Each
    // tile's step order stays k-ascending (step 0 = lower k32 of the window,
    // step 1 = upper k32), bit-identical to the iteration-9 per-(split,
    // tile) blocks.
    const int8_t* awin = &a_lds[w & 1][0];
    const int8_t* bwin0 = &b_lds[w & 1][0][0];
    const int8_t* bwin1 = &b_lds[w & 1][1][0];
    du::dumma::du_load_matrix_sync(a_frag[0], awin, kWindowKStride);
    du::dumma::du_load_matrix_sync(a_frag[1], awin + kTileK,
                                   kWindowKStride);
    du::dumma::du_load_matrix_sync(b0_frag[0], bwin0, kWindowKStride);
    du::dumma::du_load_matrix_sync(b0_frag[1], bwin0 + kTileK,
                                   kWindowKStride);
    du::dumma::du_load_matrix_sync(b1_frag[0], bwin1, kWindowKStride);
    du::dumma::du_load_matrix_sync(b1_frag[1], bwin1 + kTileK,
                                   kWindowKStride);
    du::dumma::du_mma_sync(acc0_frag, a_frag[0], b0_frag[0], acc0_frag);
    du::dumma::du_mma_sync(acc1_frag, a_frag[0], b1_frag[0], acc1_frag);
    du::dumma::du_mma_sync(acc0_frag, a_frag[1], b0_frag[1], acc0_frag);
    du::dumma::du_mma_sync(acc1_frag, a_frag[1], b1_frag[1], acc1_frag);
  }

  // Publish this wave's two int32 partial tiles to workspace plane `split`
  // (per-tile contiguous plane layout workspace[split][tile][256], row-major
  // via the API LDS planes), one 16-B vector store per lane per tile.
  __shared__ __align__(16) int32_t tile_lds0[kTileM * kTileN];
  __shared__ __align__(16) int32_t tile_lds1[kTileM * kTileN];
  const int e = lane * 4;  // this lane's 4 consecutive row-major int32
  du::dumma::du_store_matrix_sync(&tile_lds0[0], acc0_frag, kTileN,
                                  du::dumma::mem_row_major);
  *reinterpret_cast<uint4*>(
      partials + split * kPlaneInts +
      static_cast<int64_t>(tile0) * (kTileM * kTileN) + e) =
      make_uint4(tile_lds0[e], tile_lds0[e + 1], tile_lds0[e + 2],
                 tile_lds0[e + 3]);
  du::dumma::du_store_matrix_sync(&tile_lds1[0], acc1_frag, kTileN,
                                  du::dumma::mem_row_major);
  *reinterpret_cast<uint4*>(
      partials + split * kPlaneInts +
      static_cast<int64_t>(tile1) * (kTileM * kTileN) + e) =
      make_uint4(tile_lds1[e], tile_lds1[e + 1], tile_lds1[e + 2],
                 tile_lds1[e + 3]);

  // Fused last-arrival combine tail (unchanged per-tile protocol, now for
  // two tiles). Only a tile's LAST arrival of this replay (pre-increment
  // counter value % SPLIT_K == SPLIT_K - 1) sums its 4 planes in ascending
  // split order and emits the scaled bf16 output, so each tile's combine
  // runs as soon as its splits land while sibling blocks are still
  // computing and the plane reads hit L2-fresh data.
  if (counters != nullptr) {
    __syncthreads();
    __shared__ int s_last0;
    __shared__ int s_last1;
    if (lane == 0) {
      __threadfence();  // release: this wave's plane stores (both tiles) are
                        // visible to the observers of the arrival atomics
      const int arrived0 = atomicAdd(&counters[tile0], 1);
      const int arrived1 = atomicAdd(&counters[tile1], 1);
      __threadfence();  // acquire: the plane reads below see every sibling
                        // block's store released before its arrival atomic
      s_last0 = ((arrived0 % kSkSplitK) == kSkSplitK - 1);
      s_last1 = ((arrived1 % kSkSplitK) == kSkSplitK - 1);
    }
    __syncthreads();
    if (s_last0) {
      w8a8_tail_emit_tile(partials, tile0, x_scale, weight_scale, out);
    }
    if (s_last1) {
      w8a8_tail_emit_tile(partials, tile1, x_scale, weight_scale, out);
    }
  }
}

// ---------------------------------------------------------------------------
// Pack kernels (both run outside the timed region, in launch_pack_w8a8_weight)
// ---------------------------------------------------------------------------

// Identity device-to-device copy (generic fallback for every (K, N) and the
// scale copy for all shapes).
template <typename T>
__global__ __launch_bounds__(kScalarThreads) void w8a8_identity_copy_kernel(
    const T* __restrict__ src, T* __restrict__ dst, const int64_t numel) {
  const int64_t stride =
      static_cast<int64_t>(gridDim.x) * static_cast<int64_t>(blockDim.x);
  for (int64_t i = static_cast<int64_t>(blockIdx.x) * blockDim.x +
                   threadIdx.x;
       i < numel; i += stride) {
    dst[i] = src[i];
  }
}

void launch_identity_copy_int8(const int8_t* src,
                               int8_t* dst,
                               const int64_t numel,
                               hipStream_t stream) {
  constexpr int64_t kMaxBlocks = 65535;
  int64_t blocks = (numel + kScalarThreads - 1) / kScalarThreads;
  if (blocks > kMaxBlocks) {
    blocks = kMaxBlocks;
  }
  if (blocks < 1) {
    blocks = 1;
  }
  hipLaunchKernelGGL(
      HIP_KERNEL_NAME(w8a8_identity_copy_kernel<int8_t>),
      dim3(static_cast<unsigned>(blocks)), dim3(kScalarThreads), 0, stream,
      src, dst, numel);
}

void launch_identity_copy_f32(const float* src,
                              float* dst,
                              const int64_t numel,
                              hipStream_t stream) {
  constexpr int64_t kMaxBlocks = 65535;
  int64_t blocks = (numel + kScalarThreads - 1) / kScalarThreads;
  if (blocks > kMaxBlocks) {
    blocks = kMaxBlocks;
  }
  if (blocks < 1) {
    blocks = 1;
  }
  hipLaunchKernelGGL(
      HIP_KERNEL_NAME(w8a8_identity_copy_kernel<float>),
      dim3(static_cast<unsigned>(blocks)), dim3(kScalarThreads), 0, stream,
      src, dst, numel);
}

// Exact-shape block-contiguous pack (iteration 17): for (K, N) ==
// (1024, 4096) the weight is transposed one-time (outside the timed region
// / Graph) into the iteration-17 slot layout consumed by the DUMMA kernel
// and decoded by the scalar fallback (w8a8_pack_b_off): every (split, tile)
// block owns one contiguous 4-KiB slot = 4 windows x (16 columns x 64 k),
// with the k-byte run of each column inside a window contiguous so the
// kernel's 16-B per-lane window prefetches are one contiguous 1-KiB run per
// matrix per window (16 sequential 64-B lines). Same byte count and buffer
// as the identity/n-major pack, so captured addresses are unchanged; the
// mapping is a pure byte permutation of the iteration-1 n-major transpose.
// One thread per output byte; runs once during weight prep. Only correct /
// invoked for (k, n) == (1024, 4096) (the launcher guard below).
__global__ __launch_bounds__(kScalarThreads) void w8a8_pack_nmajor_bytes_kernel(
    const int8_t* __restrict__ raw,
    int8_t* __restrict__ packed,
    const int k,
    const int n) {
  const int64_t total = static_cast<int64_t>(k) * n;
  const int64_t stride =
      static_cast<int64_t>(gridDim.x) * static_cast<int64_t>(blockDim.x);
  for (int64_t idx = static_cast<int64_t>(blockIdx.x) * blockDim.x +
                     threadIdx.x;
       idx < total; idx += stride) {
    // idx = slot * 4096 + w * 1024 + c * 64 + kk
    const int64_t slot = idx / kBPackSliceBytes;   // split*256+tile (0..1023)
    const int64_t rem = idx % kBPackSliceBytes;
    const int64_t w = rem / kBPackWindowBytes;     // 0..3 window in the slot
    const int64_t c = (rem / kBPackColBytes) & 15; // 0..15 col in the tile
    const int64_t kk = rem % kBPackColBytes;       // k inside the 64-k window
    const int k_src =
        static_cast<int>(((slot / kNTiles) << 8) | (w << 6) | kk);  // 0..1023
    const int col = static_cast<int>(((slot % kNTiles) << 4) | c);  // 0..4095
    packed[idx] = raw[static_cast<int64_t>(k_src) * n + col];
  }
}

// Generic scalar launch shared by the exact-shape-adjacent fallback path.
void launch_w8a8_gemm_scalar(const int8_t* a,
                             const int8_t* b,
                             const float* x_scale,
                             const float* weight_scale,
                             void* out,
                             const int m,
                             const int n,
                             const int k,
                             hipStream_t stream) {
  const dim3 block(kScalarThreads);
  const dim3 grid((static_cast<unsigned>(n) + kScalarThreads - 1) /
                      kScalarThreads,
                  static_cast<unsigned>(m));
  hipLaunchKernelGGL(w8a8_gemm_scalar_kernel, grid, block, 0, stream, a, b,
                     x_scale, weight_scale,
                     reinterpret_cast<uint16_t*>(out), m, n, k);
}

}  // namespace

// ---------------------------------------------------------------------------
// Host launch symbols (stable contract with csrc/bindings.cpp)
// ---------------------------------------------------------------------------

extern "C" void launch_w8a8_gemm(const int8_t* a,
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
  // Timed operator constraints: no allocation, compilation, autotuning,
  // packing, host/device synchronization, or default-stream launch. Only the
  // caller-provided out and the caller-provided workspace (int32 partial
  // planes + arrival-counter tail, iteration 9) may be written; the one-time
  // counter hipMemsetAsync below is a stream op issued before Graph capture
  // (first eager use), never during a capture/replay call.
  //
  // Exact assigned decode shape arm (hy3_tp8_o_proj_m16). Iteration 19 runs
  // the grid-level split-K=4 kernel w8a8_dumma_m16_n16_sk4_lds_fused_kernel
  // (512 one-wave blocks = 4 splits x 128 two-tile pairs, A+B LDS-window
  // staged, two adjacent 16-col tiles per wave sharing one A window stream,
  // fused last-arrival combine; iteration-9 reference architecture plus the
  // iteration-19 A-sharing request-halving round). The guard keeps
  // `m == kExactM`, so paired shapes with the same (N, K) (e.g. the M=2 API
  // shape) fall through to the generic scalar fallback below (which decodes
  // the exact-shape block-contiguous pack).
  if (m == kExactM && n == kExactN && k == kExactK) {
    // Split-K=4 fused path: 4 int32 planes (4 x 256 KiB) + 256 per-tile
    // arrival counters (1 KiB) in the caller workspace. The fixed API
    // validates workspaces for this (M=16, N=4096) shape at the 16-plane /
    // 4-MiB capacity, so the fused single-launch path is always taken; an
    // undersized workspace falls through to the generic scalar fallback and
    // never runs the tuned pipeline.
    int32_t* partials = static_cast<int32_t*>(workspace);
    constexpr int64_t kFusedBytes =
        static_cast<int64_t>(kSkSplitK) * kPlaneBytes +
        kCounterInts * static_cast<int64_t>(sizeof(int32_t));
    if (workspace_bytes >= kFusedBytes) {
      int32_t* counters = partials + kSkSplitK * kPlaneInts;
      // Counters are monotonic (each replay adds exactly kSkSplitK per tile
      // counter), so zeroing once per workspace pointer -- on its first
      // eager use, before Graph capture -- is sufficient; the zero is never
      // issued inside capture or on replay.
      static const void* s_fused_counters_ws = nullptr;
      if (s_fused_counters_ws != workspace) {
        (void)hipMemsetAsync(
            counters, 0, static_cast<size_t>(kCounterInts) * sizeof(int32_t),
            stream);
        s_fused_counters_ws = workspace;
      }
      hipLaunchKernelGGL(
          w8a8_dumma_m16_n16_sk4_lds_fused_kernel,
          dim3(static_cast<unsigned>(kSkGrid)), dim3(kWaveSize), 0, stream,
          a, b, partials, counters, x_scale, weight_scale,
          reinterpret_cast<uint16_t*>(out));
      return;
    }
  }

  // Generic scalar fallback for every unmatched (m, n, k).
  launch_w8a8_gemm_scalar(a, b, x_scale, weight_scale, out, m, n, k, stream);
}

extern "C" void launch_pack_w8a8_weight(const int8_t* raw_weight,
                                        const float* weight_scale,
                                        int8_t* packed_weight,
                                        float* packed_weight_scale,
                                        int k,
                                        int n,
                                        hipStream_t stream) {
  // Exact-shape n-major pack (iteration 1): only (k, n) == (1024, 4096) gets
  // the transposed fragment layout consumed by the exact-shape DUMMA kernel
  // (and decoded by the scalar fallback for the same (k, n)); every other
  // (K, N) keeps the byte-identical identity copy so the generic scalar
  // fallback stays correct for all other shapes.
  const int64_t weight_bytes = static_cast<int64_t>(k) * n;
  constexpr int64_t kMaxPackBlocks = 65535;
  int64_t weight_blocks = (weight_bytes + kScalarThreads - 1) / kScalarThreads;
  if (weight_blocks > kMaxPackBlocks) {
    weight_blocks = kMaxPackBlocks;
  }
  if (weight_blocks < 1) {
    weight_blocks = 1;
  }
  if (k == kExactK && n == kExactN) {
    hipLaunchKernelGGL(
        w8a8_pack_nmajor_bytes_kernel,
        dim3(static_cast<unsigned>(weight_blocks)), dim3(kScalarThreads), 0,
        stream, raw_weight, packed_weight, k, n);
  } else {
    launch_identity_copy_int8(raw_weight, packed_weight, weight_bytes,
                              stream);
  }
  launch_identity_copy_f32(weight_scale, packed_weight_scale,
                           static_cast<int64_t>(n), stream);
}
// @@end
