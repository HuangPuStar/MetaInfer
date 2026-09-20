// @@variant shape=hy3_tp8_shared_gate_up_proj_m16 commit=d36c2aa242f6657f2fbb136f2edc7e0bf394900a added=2026-09-17
//   median_us=9.17 p90_us=9.427 speedup=7.255 baseline_us=66.53
//   source=hy3-tp8-m16-test9-16-619177f8
// MetaInfer W8A8 INT8 GEMM - HIP implementation (gfx928 / K500SM_AI).
//
// worker_2 iterations 3-5 for hy3_tp8_shared_gate_up_proj_m16:
// M = 16, N = 384, K = 4096. Iteration 3 = mandated architecture round
// (accepted). Iteration 5 = mandated packed-weight/staging round:
// the DUMMA-fragment-order weight pack + register-direct B transport
// (the B LDS stage of iteration 3 is removed).
//
// Contract:
//     out[m, n] = bf16( int32_dot(x_q[m, :], raw_weight[:, n])
//                       * x_scale[m, 0] * weight_scale[n, 0] )
//
// State after iteration 2: the 16-way uniform split-K launch measured
// 11.350 us median / 11.389 us p90 with grid = (N/16) x 16 = 384 one-wave
// blocks (3.2 blocks/CU), 9,216 B LDS/block, and a SEPARATE 24-block combine
// kernel (two dispatches per replay). Fresh PMC on that exact source reports
// lds_bank_conflicts = 254,976 (664 per block) and lds_wait_instructions =
// 6,112 concentrated in the B fragment path, because B is staged k-major
// ([k][16], leading dimension 16) and the row_major fragment loader reads each
// lane's 8 elements as 8 ds_read_u8 at stride 16 -> a structural 8-way bank
// conflict per B fragment read (verified in the exact code object:
// ds_read_u8 v3, v38 offset:4096 / 4112 / 4128 / ... stride 16). The A
// fragment already reads one ds_read2_b32 because A is staged row-major with
// the 8 elements consecutive. The same PMC block shows B staging issues 16-B
// loads at a 384-B stride (half of every 32-B sector wasted) and the second
// dispatch pays a full kernel-launch tail after the partial grid drains.
//
// This round is the mandated architecture change (one-wave, ZERO-barrier,
// CU-aligned, non-power-of-two split; trusted probe set [2,5,10,15]) plus ONE
// consolidation of the two measured B/combine bottlenecks, using the exact
// recipe previously validated on this shape:
//
//   * K is split kSplitK = 15 ways with 32-aligned non-uniform slices
//     (8 x 288 = 9 DUMMA steps + 7 x 256 = 8 steps; 8*288 + 7*256 = 4096).
//     Grid = 24 N-groups x 15 splits = 360 one-wave blocks = EXACTLY 3
//     blocks/CU on the 120 measured device CUs - integer balanced, no tail
//     wave, and a shrink of the per-block slice (288/256 vs 256) that keeps
//     3 co-resident blocks inside the LDS budget (3 x 4,868 B << 64 KiB).
//   * [iteration 3 - pack superseded by the iteration-5 block below] the
//     weight is packed once, OUTSIDE the timed region and outside the
//     Graph, by launch_pack_w8a8_weight into the per-tile slice-major-chunk
//     layout for (k,n)==(4096,384) ONLY: every 16-B chunk
//     holds 16 consecutive k of one n column and the 4,096 chunks of a tile
//     are stored in ascending (slice, n, k-chunk) order. Every other (K,N)
//     keeps the identity copy.
//   * [iteration 3 - B transport superseded by the iteration-5 block below]
//     the B slice is staged into an n-major LDS layout b_lds[n][k] (element
//     (k,n) at n*304 + k) from the contiguous packed region, so each staged
//     wave-load covers 1,024 contiguous bytes (full 32-B sectors, sequential
//     DRAM pages) and each lane's 8 B fragment elements are 8 CONSECUTIVE
//     bytes -> exactly ONE ds_read2_b32 per DUMMA step (was 8 bank-conflicted
//     ds_read_u8). The col_major loader reads the same elements as the old
//     row_major loader (x[i] = element (k0+col+i, n_base+row)), so every
//     fragment register - and therefore the exact int32 accumulation order -
//     is unchanged.
//   * A is NOT staged through LDS: each lane loads its own 8-B fragment slice
//     for every DUMMA step into a per-lane register array (int2 global loads
//     issued back-to-back) and the K loop consumes it straight from
//     registers; A is 64 KiB total and L2-resident, and removing its LDS
//     round trip drops the per-block LDS footprint to 4,868 B.
//   * the 24-block combine is FUSED into the partial kernel as a
//     last-arrival tail: every block publishes its int32 plane tile, lane 0
//     releases with __threadfence() + atomicAdd on a per-tile counter, the
//     15th arriver acquires, sums the 15 planes in ascending split order
//     (exact integer order), applies the reference float order
//     (float(acc) * x_scale[row]) * weight_scale[col], stores bf16 and resets
//     its counter. Exactly ONE dispatch per replay.
//
// ---------------------------------------------------------------------------
// Iteration 5 (this revision) - mandated packed-weight/staging round: the
// DUMMA-fragment-order weight pack + register-direct B transport.
//
// The accepted iteration-3 source (digest 77a1ea90..., 9.674 us median /
// 9.751 us p90 / 9.631 us min, 360 one-wave blocks = exactly 3 blocks/CU,
// fused last-arrival tail, ONE dispatch) carried B through LDS: 5 batched
// 16-B global loads -> `s_waitcnt vmcnt(0)` (every B byte had to arrive
// before ANY ds_write) -> 5 ds_write_b128 with per-chunk index math -> 2 full
// `s_waitcnt lgkmcnt(0)` drains -> 9 ds_read2_b32 back into the fragment
// registers. The exact iteration-4 code object shows that whole path
// (load_wait0_ds_write_windows = 5, 15 lgkmcnt(0) drains, lds_instructions
// 5,424 = 15/block, lds_bank_conflicts 14,592, lds_bytes 4,868) while the PMC
// shows only ~199 VALU instructions per 64-lane wave in ~42,829 cycles: with
// just 3 co-resident waves per CU there is no other work to hide a
// serialization stage, so every turn of the B path is exposed latency.
//
// This round changes ONE thing (the weight pack), and one stage disappears
// with it: launch_pack_w8a8_weight (outside the timed region and outside the
// Graph, same 1,572,864-byte buffer, (k,n)==(4096,384) ONLY) now emits the
// weight in the exact m16n16k32 matrix_b fragment order of the 64-lane
// wavefront, so a block's whole B slice becomes a straight sequential
// register stream and the B LDS stage is deleted:
//
//   * the 65,536 B of one 16-column tile are the 15 split slices in
//     ascending split order; inside a slice the bytes are the fragment slots
//     of the wave, TWO k32 steps per 1,024-B pair slot: byte =
//     slice_base(s) + (step>>1)*1024 + lane*16 + (step&1)*8 + i with
//     lane = ((k - k_base)>>3 & 3)*16 + (col&15), i = (k - k_base)&7;
//   * a 9-step (288-k) slice is 4 pair slots plus one 512-B single slot for
//     the odd 9th step (8 B/lane at lane*8); an 8-step (256-k) slice is 4
//     pair slots; 8*4,608 + 7*4,096 = 65,536 B per tile exactly, so the byte
//     count and the graph-stable buffer are unchanged;
//   * the timed kernel then fetches B fragment registers with 4 x int4 (one
//     per step pair, 16 B/lane, 1,024 CONTIGUOUS bytes per wave-load) plus,
//     for the 9-step slices, one int2 (8 B/lane, 512 contiguous bytes) - the
//     SAME 4/5 load instructions and the same bytes per lane as the accepted
//     staged path, but each load address is lane*16/lane*8 inside a
//     contiguous slot: no chunk-index math, no ds_write, no __syncthreads, no
//     lgkmcnt drain and no ds_read is needed, and the K loop can consume each
//     step pair as soon as it arrives instead of after the whole slice;
//   * b_slice[s].x[i] is the same element the accepted col_major LDS loader
//     produced, x[i] = element(k0 + (lane>>4)*8 + i, n_base + (lane&15)), so
//     every matrix_b fragment register - and therefore every v_mmac input and
//     the exact int32 accumulation order - is unchanged;
//   * A is unchanged (register-only, 8/9 batched int2 loads, zero LDS), the
//     grid is unchanged (24 N-groups x 15 splits = 360 one-wave blocks =
//     exactly 3 blocks/CU), and the partial-plane store, the fused
//     last-arrival combine tail, the workspace guard (15 planes + 24 counters
//     = 368,736 B <= 393,216 B) and both fallbacks are unchanged; the generic
//     scalar and unsplit M=16 DUMMA fallbacks decode the new pack elementwise
//     through the updated packed384_byte_offset, so they stay bit-exact
//     (including the paired M=2 shape).
//
// Predicted signature if the mechanism is real: LDS per block drops from
// 4,868 B to the 4-B s_is_last flag; lds_instructions 5,424 -> ~0;
// lds_bank_conflicts 14,592 -> 0; lds_wait_instructions 461 -> 0;
// group_segment_fixed_size ~4,868 -> ~4 B; waitcnt drops by ~20 (all
// lgkmcnt drains and the staging vmcnt(0) pair vanish); vmem_read_instructions
// stays ~5,832 (same B bytes and the same 4/5 B load instructions per block);
// memory_traffic.total_bytes_per_operator_replay stays ~2.05 MB. If the
// median does not improve, the B LDS round trip was fully hidden by the 3
// co-resident waves and the kernel sits at its launch/streaming floor.
// ---------------------------------------------------------------------------
//
// Iteration 7 (this revision) - mandated pipeline/buffering decision plus the
// removal of the only avoidable term left in the HBM byte ledger.
//
// MANDATED DECISION (single vs double buffering). The gate is evaluated on the
// exact accepted source: K = 4096 >= 1024 (true), l2_hit_rate_percent 51.521
// < 70 (true), doubled LDS budget 2 x 4 B = 8 B << 48 KiB (true). The round
// nevertheless keeps SINGLE buffering, because the kernel has no LDS pipeline
// stage to buffer: LDS is 4 B/block, the fused tail's s_is_last flag
// (lds_instructions 720 = 2/block, lds_bank_conflicts 0, lds_wait 8). Both
// operands travel global -> fragment registers directly; the exact gfx928
// code object of the accepted source shows 9 x global_load_dwordx2 (A) and
// 4 x global_load_dwordx4 + 1 x global_load_dwordx2 (B) issued back-to-back
// ahead of the chain, with the compiler already software-pipelining the
// consumption (s_waitcnt vmcnt(7) -> first v_mmac ... vmcnt(0) -> last
// v_mmac). BARRIERS PER K STEP = 0 for the current kernel (zero s_barrier in
// the K loop). The double-buffered alternative is the iterations 1-3 LDS
// stage, which needed 2 s_barrier and 2 full s_waitcnt lgkmcnt(0) per stage
// and whose deletion in iteration 5 measured +3.2% (9.674 -> 9.365 us). The
// single/double comparison therefore rejects double buffering on measured
// evidence, not on the gate.
//
// The round's ONE change attacks the partial planes. The accepted source's
// memory_traffic is read 1,665,856 B (= weight 1,572,864 + A 65,536 + 27,456)
// and write 381,024 B (= partials 368,640 + out 12,288 + counters 96), total
// 2,046,880 B per replay at 218.56 GB/s counter-derived; the 368,640 B of
// partial-plane write-back is 18% of all HBM bytes for values that are read
// back exactly once by the fused tail. Those 15 int32 planes are replaced by
// ONE hot per-tile int32 accumulator (24 tiles x 256 int32 = 24,576 B,
// L2-resident) updated with global atomicAdd, and the fused last-arrival tail
// reads that single accumulator, applies the reference float order
// (float(acc) * x_scale[row]) * weight_scale[col], stores bf16 and resets the
// tile to zero. Integer addition is exact and order-independent, so the summed
// int32 - and therefore every output bf16 - is bit-identical to the 15-plane
// ascending-sum chain. Unchanged: grid (24 N-groups x 15 splits = 360 one-wave
// blocks = exactly 3.0 blocks/CU on 120 CUs), slices (8 x 288 + 7 x 256,
// 32-aligned), weight pack, A register path, counter protocol, fallbacks. The
// workspace requirement drops from 368,736 B to 24,672 B, which frees the
// 393,216-B partial-plane cap that held the split at 15 - the hand-off for a
// later blocks/CU probe.
//
// Predicted signature if the mechanism is real: write_bytes_per_operator_replay
// 381,024 -> ~37,000 (out 12,288 + counters 96 + accumulator write-back
// <= 24,576), read_bytes 1,665,856 -> ~1,638,400, total 2,046,880 -> ~1,675,000
// (-18%); the kernel body's 4 global_store_dword per lane become 4 no-return
// global_atomic_add; lds_bytes stays 4 and ds_read/ds_write stay 1/1 (the
// flag); vmem_read_instructions unchanged; the last arriver's 15 int4 plane
// reads collapse to one int4 accumulator read per lane. If the median does not
// move, the 368,640 B of partial write-back was absorbed by L2 and the kernel
// is latency-bound at 3 warps/CU - which is what the freed 24,672-B workspace
// then lets the next round attack with a >= 4-6 blocks/CU split.
// ---------------------------------------------------------------------------
//
// The int32 accumulation is exact (integer addition is order independent), so
// the split cannot change the result bit-for-bit: k-ascending inside each
// slice, ascending split sum at the tail = the scalar chain.
//
// The generic scalar kernel remains the fallback for every unmatched (m,n,k)
// including the paired M=2 shape with the same (N,K) = (384,4096); it decodes
// the (k,n)==(4096,384) pack so that fallback stays exact. The unsplit M=16
// DUMMA kernel is the fallback when the caller workspace cannot hold the
// per-tile int32 accumulator + 24 counters (24,672 B as of iteration 7; it was
// 15 partial planes + counters = 368,736 B through iteration 6). The M=16
// split-K path is guarded by the full (m,n,k) triple.
//
// Host symbols (matched against csrc/bindings.cpp):
//     launch_w8a8_gemm(...)           -- assigned-shape split-K / fallbacks
//     launch_pack_w8a8_weight(...)    -- fragment-order pack / identity
//
// Known-good include order for this DTK: HIP runtime first, then the HIP
// bfloat16 header, then du_mma.h.

#include <hip/hip_runtime.h>
#include <hip/hip_bfloat16.h>
#include <du_mma.h>

#include <cstdint>

namespace {

// ---------------------------------------------------------------------------
// Layout constants of the exact (k,n)==(4096,384) DUMMA-fragment-order weight
// pack (iteration 5). One 16-column tile is 65,536 B = 15 split slices in
// ascending split order; a slice is the concatenation of the wavefront's
// matrix_b fragment slots, TWO k32 steps per 1,024-B pair slot:
//     offset_in_slice(step, lane, i) =
//         (step>>1)*1024 + lane*16 + (step&1)*8 + i
// with lane = ((k - k_base)>>3 & 3)*16 + n_local, i = (k - k_base)&7,
// n_local = col&15. The 9-step (288-k) slices have 4 pair slots plus one
// 512-B single slot for the odd 9th step (8 B/lane at lane*8); the 8-step
// (256-k) slices have 4 pair slots. 8*4,608 + 7*4,096 = 65,536 B per tile, so
// the buffer size, the pack launch and the graph-stable address are unchanged.
// ---------------------------------------------------------------------------
constexpr int kFragPackNumLong = 8;              // 8 x 288-k + 7 x 256-k
constexpr int kFragPackSliceLong = 288;
constexpr int kFragPackSliceShort = 256;
constexpr int kFragPackStepK = 32;               // kDummaK
constexpr int kFragPackPairBytes = 1024;         // 64 lanes * 16 B (2 steps)
constexpr int kFragPackLongBytes = 4608;         // 4*1024 + 512 (9 steps)
constexpr int kFragPackShortBytes = 4096;        // 4*1024 (8 steps)
constexpr int kFragPackLongRegion = 8 * 4608;    // 36,864 B of long slices
constexpr int kFragPackTileBytes = 65536;        // 4096 * 16

// Byte offset of element (k, col) inside the exact (k,n)==(4096,384)
// DUMMA-fragment-order weight pack (see the constants above and the pack
// kernel below): byte = tile*65536 + slice_base(s) + (step>>1)*1024 +
// lane*16 + (step&1)*8 + i, with s/step/i/lane derived from (k, col) exactly
// as the pack kernel derives them from the byte index. Fallback paths only
// (generic scalar and unsplit M=16 DUMMA); the timed split-K kernel reads the
// same slots directly through its own template-indexed addresses.
__device__ __forceinline__ int64_t packed384_byte_offset(int k, int col) {
  const int64_t tile = static_cast<int64_t>(col) >> 4;  // col / 16
  const int64_t n_local = static_cast<int64_t>(col) & 15;
  const int long_end = kFragPackNumLong * kFragPackSliceLong;  // 2304
  int s, k_base;
  if (k < long_end) {
    s = k / kFragPackSliceLong;
    k_base = s * kFragPackSliceLong;
  } else {
    s = kFragPackNumLong + (k - long_end) / kFragPackSliceShort;
    k_base = long_end + (s - kFragPackNumLong) * kFragPackSliceShort;
  }
  const int kk = k - k_base;
  const int step = kk >> 5;            // kk / kFragPackStepK
  const int within = kk & 31;          // kk % kFragPackStepK
  const int lane = (within >> 3) * 16 + static_cast<int>(n_local);
  const int i = within & 7;
  const int64_t base =
      (s < kFragPackNumLong)
          ? static_cast<int64_t>(s) * kFragPackLongBytes
          : static_cast<int64_t>(kFragPackLongRegion) +
                static_cast<int64_t>(s - kFragPackNumLong) *
                    kFragPackShortBytes;
  const int64_t slot =
      (s < kFragPackNumLong && step == kFragPackSliceLong / kFragPackStepK - 1)
          ? 4 * kFragPackPairBytes + static_cast<int64_t>(lane) * 8
          : static_cast<int64_t>(step >> 1) * kFragPackPairBytes +
                static_cast<int64_t>(lane) * 16 + (step & 1) * 8;
  return tile * kFragPackTileBytes + base + slot + i;
}


// ---------------------------------------------------------------------------
// Generic scalar fallback: one thread per output element.
//
// The linear index is row-major over [M, N], so adjacent lanes write adjacent
// N columns in `out` and read adjacent N columns of the weight in the raw
// layout: both streams coalesce in the fastest-changing N dimension. For
// (k,n)==(4096,384) the weight buffer instead holds the DUMMA-fragment-order
// pack, decoded per element via packed384_byte_offset so this fallback stays
// exact for the paired M=2 shape and every unmatched m.
// ---------------------------------------------------------------------------
constexpr int kScalarBlockThreads = 128;

__global__ __launch_bounds__(kScalarBlockThreads) void w8a8_gemm_scalar_kernel(
    const int8_t* __restrict__ a,             // x_q    [M, K] row-major
    const int8_t* __restrict__ b,             // weight [K, N] row-major / pack
    const float* __restrict__ x_scale,        //        [M, 1] contiguous
    const float* __restrict__ weight_scale,   //        [N, 1] contiguous
    hip_bfloat16* __restrict__ out,           //        [M, N] row-major
    int m,
    int n,
    int k) {
  const int64_t total = static_cast<int64_t>(m) * n;
  const int64_t idx =
      static_cast<int64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
  if (idx >= total) {
    return;
  }

  const int row = static_cast<int>(idx / n);
  const int col = static_cast<int>(idx - static_cast<int64_t>(row) * n);

  const int8_t* __restrict__ a_row = a + static_cast<int64_t>(row) * k;
  const bool packed_384 = (k == 4096 && n == 384);
  const int64_t b_row_stride = packed_384 ? 0 : static_cast<int64_t>(n);

  int32_t acc = 0;
#pragma unroll 8
  for (int kk = 0; kk < k; ++kk) {
    // Exact int32 accumulation: max |dot| = 128 * 128 * 4096 = 67,108,864
    // which is < 2^31 for every assigned K.
    const int8_t b_val =
        packed_384 ? b[packed384_byte_offset(kk, col)]
                   : b[static_cast<int64_t>(col) +
                       static_cast<int64_t>(kk) * b_row_stride];
    acc += static_cast<int32_t>(a_row[kk]) * static_cast<int32_t>(b_val);
  }

  // Reference order: (float(dot) * x_scale[m]) * weight_scale[n], then bf16.
  const float scaled =
      static_cast<float>(acc) * x_scale[row] * weight_scale[col];
  out[idx] = hip_bfloat16(scaled);
}

// ---------------------------------------------------------------------------
// gfx928 DUMMA INT8 m16n16k32 tile constants.
// ---------------------------------------------------------------------------
constexpr int kDummaM = 16;
constexpr int kDummaN = 16;
constexpr int kDummaK = 32;
constexpr int kDummaBlockThreads = 64;  // one 64-lane wavefront per block

// Unsplit M=16 DUMMA fallback (used only when the caller workspace cannot hold
// the per-tile int32 accumulator + counters). One wavefront owns one 16x16 tile
// with direct library fragment loads and an LDS-drained epilogue. For
// (k,n)==(4096,384) the B fragment is gathered per element from the pack.
__global__ __launch_bounds__(kDummaBlockThreads) void
w8a8_gemm_m16_dumma_kernel(
    const int8_t* __restrict__ a,             // x_q    [16, K] row-major
    const int8_t* __restrict__ b,             // weight [K, N] row-major / pack
    const float* __restrict__ x_scale,        //        [16, 1] contiguous
    const float* __restrict__ weight_scale,   //        [N, 1] contiguous
    hip_bfloat16* __restrict__ out,           //        [16, N] row-major
    int n,
    int k) {
  const int lane = static_cast<int>(threadIdx.x);  // 0..63
  const int n_base = static_cast<int>(blockIdx.x) * kDummaN;

  __shared__ __align__(16) int32_t acc_tile[kDummaM * kDummaN];

  du::dumma::DUFragment<du::dumma::matrix_a, kDummaM, kDummaN, kDummaK,
                        signed char, du::dumma::row_major>
      a_frag;
  du::dumma::DUFragment<du::dumma::matrix_b, kDummaM, kDummaN, kDummaK,
                        signed char, du::dumma::row_major>
      b_frag;
  du::dumma::DUFragment<du::dumma::accumulator, kDummaM, kDummaN, kDummaK, int>
      acc_frag;
  du::dumma::du_fill_fragment(acc_frag, 0);

  const bool packed_384 = (k == 4096 && n == 384);
#pragma unroll 4
  for (int k0 = 0; k0 < k; k0 += kDummaK) {
    du::dumma::du_load_matrix_sync(a_frag, a + k0, k);
    if (packed_384) {
      // The library row_major loader (x[i] = p[(col+i)*ldm + row], row =
      // lane&15, col = (lane>>4)*8) cannot decode the pack, so gather the
      // SAME fragment registers per element: x[i] = element
      // (k0 + (lane>>4)*8 + i, n_base + (lane&15)).
      const int n_local = lane & 15;
      const int k_off = (lane >> 4) * 8;
#pragma unroll
      for (int i = 0; i < 8; ++i) {
        b_frag.x[i] = b[packed384_byte_offset(k0 + k_off + i, n_base + n_local)];
      }
    } else {
      du::dumma::du_load_matrix_sync(
          b_frag, b + static_cast<int64_t>(n_base >> 4) * (kDummaN * k) + k0,
          k);
    }
    du::dumma::du_mma_sync(acc_frag, a_frag, b_frag, acc_frag);
  }

  du::dumma::du_store_matrix_sync(acc_tile, acc_frag, kDummaN,
                                  du::dumma::mem_row_major);
  __syncthreads();

  // Coalesced epilogue: each lane drains 256/64 = 4 accumulator elements,
  // applies the per-row/per-column float scales and stores bf16.
#pragma unroll
  for (int linear = lane; linear < kDummaM * kDummaN; linear += 64) {
    const int row = linear >> 4;
    const int col = linear & 15;
    const float scaled = static_cast<float>(acc_tile[linear]) *
                         x_scale[row] * weight_scale[n_base + col];
    out[static_cast<int64_t>(row) * n + n_base + col] = hip_bfloat16(scaled);
  }
}

// ---------------------------------------------------------------------------
// Split-K=15 one-wave, zero-barrier, CU-aligned GEMM + fused last-arrival tail
// (iteration 3) with register-direct A/B transport (iteration 5) and one hot
// per-tile int32 accumulator (iteration 7).
//
//   * block tile 16x16 (1 wavefront x 1 N-tile), 64 thr; grid = 24 N-groups x
//     15 splits = 360 one-wave blocks = EXACTLY 3 blocks/CU on 120 CUs;
//   * K=4096 -> 15 non-uniform 32-aligned slices: 8 x 288 (9 DUMMA steps) +
//     7 x 256 (8 steps); k0-ascending within each slice, exact order-free
//     int32 reduction at the tail -> bit-identical int32 sum;
//   * A is register-only (per-lane int2 fragment slice per step, no LDS);
//   * B (the once-read, cold weight) is packed DUMMA-fragment-order outside
//     the timed region (iteration 5) and read straight into its fragment
//     registers with 4 x int4 (+ 1 x int2 for the 9-step slices) per lane -
//     NO LDS stage, no barrier, no lgkmcnt drain;
//   * no __syncthreads in the block body (0 s_barrier for a 1-wave block) and
//     a zero-barrier register-only K loop (0 barriers per K step);
//   * workspace = ONE int32 accumulator per tile [24][16][16] = 24,576 B plus
//     24 arrival counters = 24,672 B (<= the caller's 393,216 B budget); each
//     slice adds its 256 int32 with global atomicAdd into its tile (hot in L2,
//     no per-replay write-back of 368,640 B of planes);
//   * fused tail: exactly ONE arrival per block (lane 0 fence + atomicAdd,
//     acquisition fence, LDS s_is_last flag, barriers); the last arriver reads
//     the single accumulated tile, applies both scales, stores bf16, resets
//     the tile accumulator and the counter. One dispatch per replay.
// ---------------------------------------------------------------------------
constexpr int kSplitK = 15;              // 15 slices; grid = 24 x 15 = 360
constexpr int kNumNGroups = 24;          // N=384 / 16 (partial block tiles)
constexpr int kNumLongSplits = 8;        // 8 x 288-row slices + 7 x 256-row
constexpr int kSliceLong = 288;          // 9 x kDummaK steps (non-uniform)
constexpr int kSliceShort = 256;         // 8 x kDummaK steps
constexpr int kStepsLong = kSliceLong / kDummaK;   // 9
constexpr int kStepsShort = kSliceShort / kDummaK; // 8
constexpr int kPartialBlockThreads = 64; // one wavefront per block
constexpr int kCounterInts = kNumNGroups;  // one arrival counter per N-group

// Iteration 7 workspace: ONE int32 accumulator per 16-column tile instead of
// 15 int32 partial planes. 24 tiles x 256 int32 = 24,576 B total, hot in L2,
// so the 368,640 B of per-replay partial-plane write-back disappears. The
// 24 arrival counters stay after the accumulator. Every accumulator element is
// zeroed once by the host (like the counters) and is reset by the tile's fused
// last-arrival tail at the end of every replay, so no clear is needed inside
// the timed region.
constexpr int kAccumIntsPerTile = kDummaM * kDummaN;      // 256
constexpr int64_t kAccumInts =
    static_cast<int64_t>(kNumNGroups) * kAccumIntsPerTile;  // 6,144
constexpr int64_t kAccumBytes =
    kAccumInts * static_cast<int64_t>(sizeof(int32_t));     // 24,576 B

// One 16x16 tile for one 32-aligned K slice. The slice body is a compile-time
// template (kSliceKT, kStepsT) so the load loops and the K loop are fully
// unrolled; the grid-uniform `split < kNumLongSplits` branch picks the 288- or
// 256-row instantiation for each block (one launch total).
//
// Iteration 5: both operands go straight into their fragment registers and NO
// LDS is used at all, so the body is just "load registers, then kStepsT
// v_mmac". A comes from the raw row-major activation; B comes from the
// DUMMA-fragment-order pack, whose per-tile slice region is the wavefront's
// matrix_b fragment slots in k-ascending order (two k32 steps per 1,024-B
// pair slot, one 512-B single slot for an odd 9th step).
// Iteration 7: the slice's 16x16 int32 result is added straight into the
// tile's single accumulator with four per-lane global atomicAdd (no plane, no
// per-split store base). Integer addition is exact and order-independent, so
// the reduction is bit-identical to the ascending 15-plane sum.
template <int kSliceKT, int kStepsT>
__device__ __forceinline__ void split15_slice_body(
    const int8_t* __restrict__ a,        // x_q       [16, K] row-major
    const int8_t* __restrict__ b,        // weight    fragment-order pack
    int32_t* __restrict__ accum,         //           [24][16][16] int32
    int k,
    int tile,
    int split,
    int k_base) {
  const int tid = static_cast<int>(threadIdx.x);

  // Register-only A transport (iteration 3, unchanged). The A slice is small
  // (16 x kSliceKT = 4,608/4,096 B, L2-hot 64-KiB activation) and every block
  // reads its own rows exactly once, so staging it through LDS only buys the
  // LDS round trip. Each lane loads its own 8-B fragment slice for EVERY DUMMA
  // step into a per-lane register array: the library matrix_a row_major loader
  // with ldm=k reads x[i] = p[row*k + k_base + s*kDummaK + col + i], row =
  // lane&15, col = (lane>>4)*8. The 8 elements are 8 CONSECUTIVE bytes of one
  // row (8-B aligned), so one explicit int2 load per lane per step and a
  // register-to-register memcpy fill the same fragment registers the LDS
  // loader produced. All kStepsT loads are issued back-to-back, ahead of the B
  // loads, so the A slice costs one memory latency and zero LDS ops.
  du::dumma::DUFragment<du::dumma::matrix_a, kDummaM, kDummaN, kDummaK,
                        signed char, du::dumma::row_major>
      a_slice[kStepsT];
  const int a_row = tid & 15;               // m index (library loader row)
  const int a_col = (tid >> 4) * 8;         // k offset (library loader col)
  const int8_t* a_base =
      a + static_cast<int64_t>(a_row) * k + k_base + a_col;
#pragma unroll
  for (int s = 0; s < kStepsT; ++s) {
    const int2 raw = *reinterpret_cast<const int2*>(a_base + s * kDummaK);
    __builtin_memcpy(a_slice[s].x, &raw, 8);
  }

  // Register-direct B transport (iteration 5). This block's split owns a
  // CONTIGUOUS region of its tile: slice_base(s) + 4 x 1,024-B pair slots,
  // followed (9-step slices only) by one 512-B single slot for the odd last
  // step. One int4 load per lane per pair slot covers 1,024 CONTIGUOUS bytes
  // per wave-load and lands BOTH matrix_b fragments of that pair in their
  // final registers: its low 8 bytes are x[i] of step 2m and its high 8 bytes
  // x[i] of step 2m+1, i.e. the same x[i] = element(k0 + (lane>>4)*8 + i,
  // n_base + (lane&15)) the accepted col_major LDS loader produced. The loads
  // are issued back-to-back with no ds_write, no __syncthreads and no lgkmcnt
  // drain in between, so the K loop can consume each step pair as soon as it
  // arrives instead of after the whole slice.
  du::dumma::DUFragment<du::dumma::matrix_b, kDummaM, kDummaN, kDummaK,
                        signed char, du::dumma::col_major>
      b_slice[kStepsT];
  constexpr int kPairSlots = kStepsT / 2;                  // 4
  const int8_t* b_split =
      b + static_cast<int64_t>(tile) * (kDummaN * k) +
      ((split < kNumLongSplits)
           ? static_cast<int64_t>(split) * kFragPackLongBytes
           : static_cast<int64_t>(kFragPackLongRegion) +
                 static_cast<int64_t>(split - kNumLongSplits) *
                     kFragPackShortBytes);
#pragma unroll
  for (int m = 0; m < kPairSlots; ++m) {
    const int4 raw = *reinterpret_cast<const int4*>(
        b_split + static_cast<int64_t>(m) * kFragPackPairBytes + tid * 16);
    __builtin_memcpy(b_slice[2 * m].x, &raw, 8);
    __builtin_memcpy(b_slice[2 * m + 1].x,
                     reinterpret_cast<const char*>(&raw) + 8, 8);
  }
  if (kStepsT % 2 != 0) {
    // 9-step slices: the odd last step is a 512-B single slot (8 B/lane).
    const int2 raw = *reinterpret_cast<const int2*>(
        b_split + kPairSlots * kFragPackPairBytes + tid * 8);
    __builtin_memcpy(b_slice[kStepsT - 1].x, &raw, 8);
  }

  // The block's one wavefront owns the whole 16x16 tile. Zero-barrier K loop:
  // kStepsT steps of kDummaK=32, A and B both straight from the preloaded
  // register arrays, one v_mmac per step (9 or 8 v_mmac per block), zero
  // s_barrier per K step. The int32 accumulation inside the slice is untouched
  // (k-ascending); across slices the addition is exact and order-free.
  du::dumma::DUFragment<du::dumma::accumulator, kDummaM, kDummaN, kDummaK, int>
      acc_frag;
  du::dumma::du_fill_fragment(acc_frag, 0);

#pragma unroll
  for (int s = 0; s < kStepsT; ++s) {
    du::dumma::du_mma_sync(acc_frag, a_slice[s], b_slice[s], acc_frag);
  }

  // Direct int32 accumulation into the per-tile accumulator (iteration 7).
  // The library mem_row_major store owns one element per lane at row = tid&15,
  // column = (tid>>4), then x[1], x[2], x[3] at +4, +8, +12 columns (the exact
  // mapping the iteration-6 candidate verified against the exact code object:
  // one 64-bit base with 0/16/32/48-byte offsets). Four no-return atomicAdd
  // publish exactly those values into accum[tile][row][col], which stays hot
  // in L2 (24,576 B total) - the 368,640-B partial-plane round trip of
  // iterations 3-6 is gone. Integer addition is exact and order-independent,
  // so the tile sum, and therefore every bf16 output, is unchanged.
  int32_t* accum_lane =
      accum + static_cast<int64_t>(tile) * kAccumIntsPerTile +
      (tid & 15) * kDummaN + (tid >> 4);
#pragma unroll
  for (int i = 0; i < 4; ++i) {
    atomicAdd(accum_lane + 4 * i, acc_frag.x[i]);
  }
}

// Fused last-arrival combine tail: removes the separate 24-block combine
// kernel -> exactly ONE kernel launch per replay.
//
// Protocol (iteration 7): every block adds its 16x16 int32 result into the
// tile's single accumulator with global atomicAdd, then lane 0
// __threadfence()es (release) and atomicAdd(&counters[tile], 1); the block
// whose atomicAdd returns kSplitK-1 is the 15th (last) arriver of its
// N-group: it acquires, reads the summed accumulator, applies both scales,
// stores bf16, resets the tile's accumulator to zero and resets its counter to
// 0 (atomicExch) so the next replay restarts from zero. The host zeroes the
// whole scratch region once before the first launch; the tail's self-reset
// keeps every later replay deterministic. Only lane 0 ever increments the
// counter (the round-9 lineage lost correctness by letting all 64 lanes
// increment).
__device__ __forceinline__ void split15_combine_tail(
    int32_t* __restrict__ accum,             // [24][16][16] int32 (hot)
    const float* __restrict__ x_scale,       // [16, 1] contiguous
    const float* __restrict__ weight_scale,  // [N, 1] contiguous
    hip_bfloat16* __restrict__ out,          // [16, N] row-major
    int32_t* __restrict__ counters,          // [kNumNGroups] monotonic
    int tile,
    int n) {
  const int lane = static_cast<int>(threadIdx.x);   // 0..63 (one wavefront)
  const int n_base = tile * kDummaN;

  __syncthreads();
  __shared__ int s_is_last;
  if (lane == 0) {
    __threadfence();                                // release this slice
    const int arrived = atomicAdd(&counters[tile], 1);
    __threadfence();                                // acquire other slices
    s_is_last = (arrived == kSplitK - 1) ? 1 : 0;
  }
  __syncthreads();
  if (s_is_last == 0) {
    return;                                         // not the last arriver
  }

  // 256 accumulators / 64 lanes = 4 CONSECUTIVE columns per lane (row = lane>>2,
  // col0 = (lane & 3) * 4): ONE aligned int4 (16-B) accumulator load per lane
  // replaces the 15 dependent int4 plane loads (15 -> 1 per lane), and the
  // accumulator is only 24,576 B (L2-resident) instead of 368,640 B of planes.
  // The value read is the exact int32 sum of all 15 slices (integer addition
  // is order-independent), so the reference float order
  // (float(acc) * x_scale[row]) * weight_scale[col] produces bit-identical
  // bf16 outputs. weight_scale is read once as a float4 (16-B aligned) and the
  // 4 adjacent bf16 stores merge into one 8-B store.
  const int row = lane >> 2;                 // 0..15 (4 lanes per row)
  const int col0 = (lane & 3) * 4;           // 0,4,8,12 (16-B aligned)
  int32_t* p =
      accum + static_cast<int64_t>(tile) * kAccumIntsPerTile +
      row * kDummaN + col0;
  const int4 v = *reinterpret_cast<const int4*>(p);
  const float4 ws =
      *reinterpret_cast<const float4*>(weight_scale + n_base + col0);
  const float xs = x_scale[row];
  hip_bfloat16* o = out + static_cast<int64_t>(row) * n + n_base + col0;
  o[0] = hip_bfloat16(static_cast<float>(v.x) * xs * ws.x);
  o[1] = hip_bfloat16(static_cast<float>(v.y) * xs * ws.y);
  o[2] = hip_bfloat16(static_cast<float>(v.z) * xs * ws.z);
  o[3] = hip_bfloat16(static_cast<float>(v.w) * xs * ws.w);

  // Every slice of this tile has already arrived (that is what made this block
  // the last arriver), so the reset cannot race with another atomicAdd: the
  // accumulator restarts at zero for the next replay, exactly like the
  // counter, and the next replay's kernel is stream-ordered after this one.
  // The store is to the same address just read, so the compiler keeps it after
  // the load that produced v.
  *reinterpret_cast<int4*>(p) = make_int4(0, 0, 0, 0);
  if (lane == 0) {
    atomicExch(&counters[tile], 0);
  }
}

// Iteration 5: no LDS slice stage at all - both operands are fetched straight
// into fragment registers (A from the raw activation, B from the
// DUMMA-fragment-order pack), so the only shared storage left in this kernel is
// the 4-B s_is_last flag of the fused combine tail.
// Iteration 7: the per-slice result is accumulated into accum[tile] with
// global atomicAdd (no per-split planes); split/n_base are only needed to pick
// the slice and its K base.
__global__ __launch_bounds__(kPartialBlockThreads) void
w8a8_gemm_m16_dumma_splitk15_lds_staged_partial_kernel(
    const int8_t* __restrict__ a,        // x_q       [16, K] row-major
    const int8_t* __restrict__ b,        // weight    fragment-order pack
    int32_t* __restrict__ accum,         //           [24][16][16] int32
    const float* __restrict__ x_scale,   //           [16, 1] contiguous
    const float* __restrict__ weight_scale,  //      [N, 1] contiguous
    hip_bfloat16* __restrict__ out,      //           [16, N] row-major
    int32_t* __restrict__ counters,      //           [kNumNGroups] monotonic
    int n,
    int k) {
  const int tile = static_cast<int>(blockIdx.x) / kSplitK;   // 0..23
  const int split = static_cast<int>(blockIdx.x) % kSplitK;  // 0..14
  const int k_base =
      (split < kNumLongSplits)
          ? split * kSliceLong
          : kNumLongSplits * kSliceLong + (split - kNumLongSplits) * kSliceShort;

  if (split < kNumLongSplits) {
    split15_slice_body<kSliceLong, kStepsLong>(a, b, accum, k, tile, split,
                                               k_base);
  } else {
    split15_slice_body<kSliceShort, kStepsShort>(a, b, accum, k, tile, split,
                                                 k_base);
  }

  split15_combine_tail(accum, x_scale, weight_scale, out, counters, tile,
                       n);
}

// ---------------------------------------------------------------------------
// Weight packing (outside the timed region).
// ---------------------------------------------------------------------------
constexpr int64_t kGateUpTotal = 4096 * 384;  // 1,572,864 bytes

__global__ void w8a8_pack_weight_identity_kernel(
    const int8_t* __restrict__ src,
    int8_t* __restrict__ dst,
    int64_t total) {
  const int64_t stride = static_cast<int64_t>(gridDim.x) * blockDim.x;
  for (int64_t i = static_cast<int64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
       i < total; i += stride) {
    dst[i] = src[i];
  }
}

// Per-tile DUMMA-fragment-order weight pack for the exact (k,n)==(4096,384)
// shape (iteration 5): byte idx inside a tile is the matrix_b fragment byte
// that the timed split-K kernel loads, so each block's B slice is a straight
// sequential register stream (4 x 16-B pair slots + one 8-B odd slot per lane)
// with no LDS stage in between. The inverse mapping (element -> byte) is
// packed384_byte_offset; the layout constants above define the geometry:
//   15 split slices in ascending split order;
//   slice s byte base: s*4608 (8 long 288-k slices, 9 steps)
//                      8*4608 + (s-8)*4096 (7 short 256-k slices, 8 steps);
//   inside a slice: (step>>1)*1024 + lane*16 + (step&1)*8 + i, with
//   lane = ((k-k_base)>>3 & 3)*16 + n_local, i = (k-k_base)&7. The odd 9th
//   step of a long slice is a single 512-B slot: 4*1024 + lane*8 + i.
// One-time, out-of-timed-region, out-of-Graph; same byte count and the same
// graph-stable buffer. Every other (K, N) keeps the identity pack. Fallbacks
// decode this order via packed384_byte_offset.
__global__ void w8a8_pack_weight_gateup_slicemajor_kernel(
    const int8_t* __restrict__ src,
    int8_t* __restrict__ dst) {
  const int64_t idx =
      static_cast<int64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
  if (idx >= kGateUpTotal) {
    return;
  }
  const int64_t tile = idx >> 16;         // / 65536
  const int64_t rem = idx - (tile << 16); // % 65536 (byte in tile)
  int s;                                  // split index
  int step;                               // DUMMA k32 step inside the slice
  int lane;                               // wavefront lane of the fragment byte
  int i;                                  // byte inside the lane's 8-B fragment
  if (rem < kFragPackLongRegion) {        // long 288-k slices
    s = static_cast<int>(rem / kFragPackLongBytes);
    const int64_t r = rem - static_cast<int64_t>(s) * kFragPackLongBytes;
    if (r < 4 * kFragPackPairBytes) {     // 4 pair slots (2 steps each)
      const int m = static_cast<int>(r >> 10);   // r / 1024
      const int rr = static_cast<int>(r & 1023);
      lane = rr >> 4;
      const int pos = rr & 15;
      step = 2 * m + (pos >> 3);
      i = pos & 7;
    } else {                              // odd 9th step: 512-B single slot
      const int rr = static_cast<int>(r - 4 * kFragPackPairBytes);
      lane = rr >> 3;
      i = rr & 7;
      step = 8;
    }
  } else {                                // short 256-k slices
    const int64_t c2 = rem - kFragPackLongRegion;
    const int64_t sidx = c2 / kFragPackShortBytes;
    s = kFragPackNumLong + static_cast<int>(sidx);
    const int64_t r = c2 - sidx * kFragPackShortBytes;
    const int m = static_cast<int>(r >> 10);
    const int rr = static_cast<int>(r & 1023);
    lane = rr >> 4;
    const int pos = rr & 15;
    step = 2 * m + (pos >> 3);
    i = pos & 7;
  }
  const int n_local = lane & 15;
  const int k_base = (s < kFragPackNumLong)
                         ? s * kFragPackSliceLong
                         : kFragPackNumLong * kFragPackSliceLong +
                               (s - kFragPackNumLong) * kFragPackSliceShort;
  const int64_t k = static_cast<int64_t>(k_base) + step * kFragPackStepK +
                    (lane >> 4) * 8 + i;
  dst[idx] = src[k * 384 + tile * 16 + n_local];
}

__global__ void w8a8_pack_scale_identity_kernel(
    const float* __restrict__ src,
    float* __restrict__ dst,
    int total) {
  const int stride = gridDim.x * blockDim.x;
  for (int i = blockIdx.x * blockDim.x + threadIdx.x; i < total; i += stride) {
    dst[i] = src[i];
  }
}

}  // namespace

// ---------------------------------------------------------------------------
// launch_w8a8_gemm
//
// Timed operator: launches on the caller-provided (PyTorch current) stream.
// No allocation, no compilation, no autotuning, no packing, no host or device
// synchronization and no default-stream launch. The assigned-shape path uses
// the caller-provided workspace for ONE int32 accumulator per 16-column tile
// (24 x 256 x 4 = 24,576 B) plus 24 arrival counters (96 B) and issues exactly
// ONE kernel per replay (split-K=15 one-wave zero-barrier GEMM with global
// atomicAdd accumulation and a fused last-arrival tail, register-direct A/B
// transport, no LDS slice stage); every accumulator element is reset by its
// tile's last arriver, so no clear is needed between replays.
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
  if (m <= 0 || n <= 0 || k <= 0 || a == nullptr || b == nullptr ||
      out == nullptr) {
    return;
  }

  hip_bfloat16* out_bf16 = reinterpret_cast<hip_bfloat16*>(out);

  // Exact-shape M=16 dispatch (hy3_tp8_shared_gate_up_proj_m16): split-K=15
  // one-wave zero-barrier partial GEMM + fused last-arrival combine tail.
  // grid = 24 N-groups x 15 K-slices = 360 one-wave blocks = exactly 3
  // blocks/CU on 120 CUs; K=4096 -> 8 x 288 + 7 x 256 (32-aligned).
  // Any other (m, n, k) - including the paired M=2 shape with the same
  // (N, K) = (384, 4096), and every other M=16 (N, K) - falls through to the
  // generic scalar fallback (which decodes the (4096,384) pack).
  if (m == 16 && n == 384 && k == 4096) {
    constexpr int64_t kCounterBytes =
        static_cast<int64_t>(kCounterInts) * sizeof(int32_t);  // 96 B
    // Workspace is the per-tile int32 accumulator (24,576 B) followed by the
    // 24 arrival counters. The caller's validated workspace is >= 393,216 B
    // (16 partial planes), so this guard is strictly more permissive than the
    // pre-iteration-7 requirement and the same exact-shape caller keeps the
    // split-K path.
    constexpr int64_t kScratchBytes = kAccumBytes + kCounterBytes;  // 24,672 B
    if (workspace != nullptr && workspace_bytes >= kScratchBytes) {
      int32_t* accum = reinterpret_cast<int32_t*>(workspace);
      int32_t* counters = accum + kAccumInts;
      // Zero the whole scratch region once before the first launch. Issued on
      // the caller stream in the eager precheck, so the captured Graph
      // contains no memset node in the normal eager-first flow; the kernel's
      // fused tail self-resets every accumulator tile and counter, so every
      // later replay restarts from zero.
      static bool scratch_zeroed = false;
      if (!scratch_zeroed) {
        scratch_zeroed = true;
        hipMemsetAsync(accum, 0, kScratchBytes, stream);
      }
      hipLaunchKernelGGL(
          w8a8_gemm_m16_dumma_splitk15_lds_staged_partial_kernel,
          dim3(kNumNGroups * kSplitK),
          dim3(kPartialBlockThreads),
          0,
          stream,
          a,
          b,
          accum,
          x_scale,
          weight_scale,
          out_bf16,
          counters,
          n,
          k);
      return;
    }
    // Workspace too small: unsplit M=16 DUMMA fallback.
    hipLaunchKernelGGL(
        w8a8_gemm_m16_dumma_kernel,
        dim3(n / kDummaN),
        dim3(kDummaBlockThreads),
        0,
        stream,
        a,
        b,
        x_scale,
        weight_scale,
        out_bf16,
        n,
        k);
    return;
  }

  const int64_t total = static_cast<int64_t>(m) * n;
  const int64_t blocks =
      (total + kScalarBlockThreads - 1) / kScalarBlockThreads;
  const dim3 grid(static_cast<unsigned>(blocks));
  const dim3 block(static_cast<unsigned>(kScalarBlockThreads));
  hipLaunchKernelGGL(
      w8a8_gemm_scalar_kernel,
      grid,
      block,
      0,
      stream,
      a,
      b,
      x_scale,
      weight_scale,
      out_bf16,
      m,
      n,
      k);
}

// ---------------------------------------------------------------------------
// launch_pack_w8a8_weight
//
// Optional out-of-timed-region weight packing. Identity device-to-device copy
// of raw_weight -> packed_weight and weight_scale -> packed_weight_scale valid
// for any (K, N); the exact (k,n)==(4096,384) shape is packed per-tile
// DUMMA-fragment-order instead (same byte count, same buffer, one-time and
// outside the timed Graph region). The packed copies are asynchronous on the
// caller stream.
// ---------------------------------------------------------------------------
extern "C" void launch_pack_w8a8_weight(
    const int8_t* raw_weight,
    const float* weight_scale,
    int8_t* packed_weight,
    float* packed_weight_scale,
    int k,
    int n,
    hipStream_t stream) {
  const int64_t total = static_cast<int64_t>(k) * n;
  if (raw_weight != nullptr && packed_weight != nullptr && total > 0) {
    constexpr int kPackBlock = 256;
    const int grid = static_cast<int>((total + kPackBlock - 1) / kPackBlock);
    if (k == 4096 && n == 384) {
      hipLaunchKernelGGL(w8a8_pack_weight_gateup_slicemajor_kernel,
                         dim3(grid), dim3(kPackBlock), 0, stream, raw_weight,
                         packed_weight);
    } else {
      hipLaunchKernelGGL(
          w8a8_pack_weight_identity_kernel,
          dim3(grid),
          dim3(kPackBlock),
          0,
          stream,
          raw_weight,
          packed_weight,
          total);
    }
  }
  if (weight_scale != nullptr && packed_weight_scale != nullptr && n > 0) {
    constexpr int kScaleBlock = 64;
    const int grid = (n + kScaleBlock - 1) / kScaleBlock;
    hipLaunchKernelGGL(
        w8a8_pack_scale_identity_kernel,
        dim3(grid),
        dim3(kScaleBlock),
        0,
        stream,
        weight_scale,
        packed_weight_scale,
        n);
  }
}
// @@end
