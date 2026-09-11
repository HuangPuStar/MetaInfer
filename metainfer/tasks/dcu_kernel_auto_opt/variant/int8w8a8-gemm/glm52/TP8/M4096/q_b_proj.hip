// @@variant shape=glm_tp8_q_b_proj_m4096 commit=9510ab4d00ea72a47db8821d2b56b35395c23ba5 added=2026-09-11
//   median_us=209.5 p90_us=210.2 speedup=68.68 baseline_us=1.439e+04
//   source=test-9-11-1-b01955b3/iteration_001/glm_tp8_q_b_proj_m4096
// INT8 W8A8 GEMM HIP implementation for Hygon K500SM_AI / gfx928.
//
// Worker worker_3 (physical GPU 3), assigned shapes:
//   glm_tp8_q_b_proj_m4096 : M=4096, N=2048, K=2048
//
// Logical operation (exact contract):
//   out[m, n] = bf16( int32_dot(x_q[m, :], raw_weight[:, n])
//                     * x_scale[m] * weight_scale[n] )
//
// Iteration 1 bootstrap (correctness-first):
//   * Large-M DUMMA path (m >= 128 && m % 128 == 0 && n % 64 == 0 &&
//     k % 64 == 0): native INT8 DUMMA m16n16k32 tiled kernel, one 128x64
//     output tile per block, four gfx928 wavefronts of 64 lanes (256
//     threads).  The block cooperatively stages A[128,64] (row-major,
//     16-byte int4 loads) and B[64,64] (raw [K, N] row-major, 16-byte int4
//     loads) into a single-buffered LDS stage (128*80 + 64*80 = 15,360 B
//     with 16-byte per-row padding for bank skew) and performs two
//     __syncthreads per K stage.  Each wave owns a 64x32 quadrant built from
//     eight m16n16k32 int32 accumulator fragments (four M x two N).  Int32
//     accumulation order is k0-outer over 64-K stages, kk-inner (kk=0 then
//     kk=32).  The fused epilogue computes
//     float(dot) * x_scale[row] * weight_scale[col] and stores bf16 directly
//     from the accumulator fragments using the verified gfx928 int8
//     m16n16k32 lane mapping (row = lane & 15, col = (lane >> 4) + 4*i).
//     Grid = (N/64, M/128); for the assigned shape that is 32 x 32 = 1024
//     blocks, far more than the 120 CUs, so no split-K is needed.
//   * launch_pack_w8a8_weight is the bootstrap identity device-to-device copy
//     for both the int8 weight and the fp32 scale (for every (k, n) except the
//     exact pair that iteration 2 packs n-major below), so the GEMM consumes
//     the raw [K, N] row-major weight directly.
//   * Generic scalar int8/int32 fallback (one thread per output element) for
//     every unmatched (m, n, k), including all small-M API cases (M=2, M=16)
//     and any M in (0, 128) sharing the assigned (N, K).
//
// Iteration 2 (operand-reuse round): the exact (k, n) == (2048, 2048)
// q_b_proj pair keeps the 128x64 macro-tile and the cooperative A+B LDS
// staging (each staged byte is consumed by two of the four waves and each
// staged fragment by two MMACs, so cooperative staging halves global operand
// traffic versus direct-to-register global fragment loads: ~402 MiB instead of
// ~805 MiB for the assigned shape).  The staged B path is made direct,
// vectorized and bank-safe instead:
//   * The weight is packed once (outside the timed region, outside Graph
//     capture, same byte count and same graph-stable buffer) to n-major
//     packed[n * K + k] == raw[k * N + n], so 16 consecutive k bytes of one n
//     row are one aligned, perfectly coalesced int4 global read.
//   * The B LDS tile is stored n-major with a 72-byte (18-word) bank-skewed
//     row stride; each lane's 8-byte col_major fragment slot then starts on
//     bank (18 * (lane & 15) + 2 * (lane >> 4)) mod 32, and 18 * r mod 32 is a
//     permutation of the 16 even bank residues, so a 16-lane LDS phase covers
//     all 32 banks exactly once (zero conflicts) and every staged access is
//     8-byte aligned.
//   * Each B fragment is loaded with one 8-byte LDS read (load_fragment8)
//     instead of the row_major loader's eight strided ds_read_u8 byte gathers
//     plus mask/OR reassembly VALU.  The 8 operand bytes are identical in the
//     same fragment slots, so the int32 accumulation is still bit-identical.
// The exact (k, n) == (2048, 2048) pair takes this arm; every other (k, n)
// keeps the identity pack and the byte-identical raw [K, N] k-major arm.
//
// Iteration 4 (tile-aspect round): for the exact (k, n) == (2048, 2048)
// q_b_proj arm the 128x64 macro-tile is widened along N to a 128x128 tile
// (w8a8_dumma_prefill_128x128_nmajor_kernel), giving an M:N tile aspect of
// 1:1.  The 128x64 best kernel re-reads A once per N/64 = 32 column tiles
// (~268 MiB A traffic) against B's ~134 MiB (A:B = 2:1) and issues 6 LDS
// fragment reads per 8 MMACs in each 64x32 wave quadrant; the 128x128 tile
// halves the A-side re-reads (A reuse 32 -> 16, ~134 MiB) while B reuse stays
// 32 (~134 MiB), balancing per-byte A:B tile traffic at 1:1 and cutting total
// staged tile traffic ~402 -> ~268 MiB (-33%).  Each wave now owns a 64x64
// quadrant (four A x four B fragments, sixteen int32 accumulators) and issues
// 8 LDS fragment reads per 16 MMACs (-33% per MMAC).  The n-major stride-72 B
// layout and the direct load_fragment8 reads from iteration 2 are kept
// unchanged; the block stages A[128,64] (two int4/thread, 80-byte-strided
// rows) and the packed B[128,64] (two 16-byte n-row chunks/thread into the
// 72-byte-strided n-major tile) into a 19,456 B single buffer, so two
// blocks/CU still co-reside.  Accumulation order (k0-outer, kk-inner) and the
// fragment element-to-slot mapping are unchanged, so the int32 accumulation is
// bit-identical; the scalar fallback and the 128x64 raw [K, N] arm for every
// other (k, n) are untouched.
//
// Iteration 5 (packing round): the exact (k, n) == (2048, 2048) q_b_proj
// weight is packed FRAGMENT-MAJOR instead of n-major.  One DUMMA matrix_b
// tile (m16n16k32 -> 16 n x 32 k int8 = 512 contiguous bytes) is one
// graph-stable, 16-byte-aligned block, so:
//   * the packer writes a pure permutation of the same K * N bytes into the
//     same buffer: byte (`n`, `k`) of the tile (`n/16`, `k/32`) sits at
//     block * 512 + (k % 32) / 8 * 128 + (n % 16) * 8 + (k % 8);
//   * the cooperative stage copies each packed 16-byte chunk with ONE aligned
//     int4 global read and ONE aligned int4 LDS store (no 8-byte halves and
//     no shift/or recombine VALU), and every staged 16-byte chunk is
//     16-byte aligned by construction;
//   * each wave-level B fragment is one 8-byte LDS read per lane at
//     (lane & 15) * 8 + (lane >> 4) * 128, i.e. word 2 * (lane & 15) plus a
//     32-word k-group stride inside the 512-byte tile, so a 16-lane LDS
//     phase (lane & 15 = 0..15) covers all 32 banks exactly once with zero
//     padding (bank-conflict-free, fully vector-loadable).
// The fragment bytes, their (k, n) slots and the k0-outer/kk-inner int32
// accumulation order are unchanged, so correctness is bit-identical; the
// scalar fallback decodes the same permutation for the unmatched-M cases of
// the exact (k, n) pair.
//
// Iteration 6 (epilogue round): the fused dot * x_scale[m] * weight_scale[n]
// -> bf16 epilogue has been in-kernel since iteration 1 and the workspace is
// never used ((void)workspace; no split-K, no combine pass anywhere in the
// call chain), so the remaining epilogue inefficiency of the exact
// (k, n) == (2048, 2048) 128x128 arm is the STORE pattern:
// store_prefill_fragment issues one 2-byte bf16 store per lane per element -
// 64 scattered stores per wave per fragment set, each touching 16 rows x 4
// columns, so every 32-byte store sector is only 25% utilized (PMC: 131,072
// vmem_write_instructions = 512 blocks x 4 waves x 64).  The new epilogue
// transposes each 16x16 fragment's 4-element groups inside the 4-lane column
// group (lanes r, r+16, r+32, r+48; a 4x4 register transpose in two 2x2 steps
// with __shfl_xor 16 then 32), so lane (r, c4) owns the four CONTIGUOUS
// columns 4*c4 .. +3 and writes ONE aligned 8-byte store per lane (100% store
// sector efficiency; vmem_write 131,072 -> 32,768).  Only int32 values move
// between lanes: the per-element multiply order (float(dot) * x_scale[row] *
// weight_scale[col]) and the bf16 rounding are unchanged, so stored bits are
// identical.  The per-row x_scale (4 rows per lane) and per-column
// weight_scale float4s (4 per lane) are additionally register-batched on the
// last K stage before the final protective __syncthreads, so the epilogue is
// pure compute + 16 coalesced stores with no interleaved vmem loads.  The
// 128x64 arm keeps the byte-identical per-element epilogue and the generic
// scalar fallback is untouched.
//
// Iteration 7 (compute-pipeline round): the 128x128 packed arm's per-K-stage
// critical path still begins with four cooperative 16-byte global staging loads
// whose latency is drained immediately by the s_waitcnt vmcnt(3)/(2)/(1)/(0)
// sequence that precedes the four ds_write_b128 (the code object shows the load
// and its store in the same step, so the L2/HBM round trip sits inside the
// barrier-to-barrier wall of every one of the 32 K stages; the PMC LDS wait
// count and the ~0.05 MMAC/cycle/SIMD issue rate show the warp stalling far
// more than issuing).  The staging loop now carries a ONE-K-STAGE register
// lookahead: this thread's four staging chunks (A rows stage_row and
// stage_row + 64, packed B tiles b_blk and b_blk + 8) are loaded for K stage
// s + 1 right AFTER the publish barrier of stage s and BEFORE stage s's twelve
// fragment ds_reads and thirty-two v_mmac, so their latency is covered by the
// whole stage-s compute burst and the trailing WAR barrier, and the stage-s + 1
// ds_write_b128 no longer waits on a just-issued load.  The payload is four
// int4 (16 VGPRs) live across the compute; LDS size, barrier count (still two
// per K stage), staged bytes, the k0-outer/kk-inner int32 accumulation order
// and every fragment address are unchanged, so the int32 accumulation and the
// stored bits are bit-identical.  The 128x64 packed/k-major arms and the
// generic scalar fallback are untouched.
//
// Iteration 9 (A-fragment direct-load round): the 128x128 packed arm reads its
// four A fragments per kk with the library du_load_matrix_sync row_major
// loader.  du_mma.h defines that loader with the same
//   x[i] = p[(lane & 15) * ldm + ((lane >> 4) << 3) + i]
// eight-contiguous-bytes mapping as the matrix_b col_major loader (the comment
// on load_fragment8_block below records exactly that mapping for both), but on
// this gfx928 code object the A fragments come out as pairs of ds_read2_b32 -
// two 4-byte LDS reads plus a byte reassembly chain per 8-byte fragment - and
// they sit between the LDS read and the dependent v_mmac, while the B side,
// direct since iterations 2 and 5, reads each fragment with one wide LDS
// access.  Iteration 9 replaces the four library A loads with the direct
// 8-byte load_fragment8 on the A tile (row stride kAStride = 80 B), so each
// lane's x[0..7] is filled by one aligned 64-bit LDS read at
// (lane & 15) * kAStride + ((lane >> 4) << 3).  The operand bytes, the
// k0-outer/kk-inner int32 accumulation order and every fragment address are
// unchanged, so the int32 accumulation stays bit-identical; only the
// redundant reassembly VALU and its lgkmcnt wait states leave the LDS->MMAC
// critical path.  The A-tile layout, both barriers per K step, the staged
// bytes, the one-K-stage staging lookahead, the coalesced epilogue, the
// 128x64 packed/k-major arms and the generic scalar fallback are untouched.
//
// Iteration 10 (consolidation round, final HIP-only polish on the fixed
// 128x128 packed architecture): the arm's last measured LDS inefficiency is
// the A tile's 80-byte (20-word) row stride.  The exact-source PMC of the
// accepted iteration-9 source (digest 4f7eee6f..., arch_vgpr 152, workgroup
// 256, grid 512, lds_bytes 18,432) reports lds_instructions 1,048,576 = the
// eight 8-byte fragment reads per kk (4 A + 4 B) x 32 stages x 4 waves x 512
// blocks, and lds_bank_conflicts 3,145,728 = 3 x lds_instructions exactly.
// The B side is conflict-free by construction (fragment-major tiles: a lane's
// 8 bytes start at word 2*(lane&15), so a 16-lane phase touches all 32 banks
// once), so all 3,145,728 conflicts are A-side, i.e. 6 per A wave-instruction:
// with a 20-word stride the start word of row r is 20*r mod 32, which has
// period 8 (20*8 == 160 == 0 mod 32 == 0 mod 128 B), so lanes r and r+8 always
// land on the same bank pair and each 16-lane LDS phase runs at 2x the minimum
// (the exact aliasing the iteration-7 and iteration-9 hypotheses recorded and
// the sibling reference also left in place).  A 16-byte-aligned row start can
// only ever produce 8 distinct bank residues mod 32 (starts are multiples of
// 4 words), so no padding of the existing 80-byte layout can remove it; the
// fix has to be an 8-byte-granular row stride.  Focused change, 128x128 packed
// arm only: the A tile row stride becomes kAStride128 = 72 (18 words).  18 has
// gcd(18, 32) = 2, so 18*r mod 32 has period 16 and r = 0..15 is a permutation
// of the 16 even bank residues: every lane's 8-byte read occupies one distinct
// even bank and its following odd bank, i.e. all 32 banks exactly once per
// 16-lane phase (zero conflicts, the 4-cycle minimum for a 512-B fragment).
// Because 72 is only 8-byte aligned, the cooperative A staging keeps its two
// aligned int4 global loads per thread but publishes each 16-byte chunk with
// two aligned 8-byte (`int2`) LDS stores at +0/+8, so all LDS addresses stay
// naturally aligned; the whole-kernel LDS stage shrinks 18,432 -> 17,408 B
// (A 10,240 -> 9,216 B) and every staged byte keeps its exact (row, k) slot.
// The A fragment operand bytes, the 128-byte global A reads, the packed-B
// path, both barriers per K step, the one-K-stage staging lookahead, the
// coalesced epilogue, the k0-outer/kk-inner int32 accumulation order and the
// 128x64 packed/k-major arms plus the generic scalar fallback are untouched,
// so the int32 accumulation and the stored bits are bit-identical.
//
// Iteration 12 (consolidation round, final HIP-only polish on the fixed
// 128x128 packed architecture): the last measured LDS inefficiency is the
// A-staging publish mapping.  The exact-source PMC of the accepted
// iteration-10 source (source_hip_digest 9386d564..., arch_vgpr 152, workgroup
// 256, grid 512, lds_bytes 17,408) reports lds_bank_conflicts 1,048,576 with
// lds_instructions 1,048,576, and that conflict total is exactly the A publish:
// four 8-byte staging halves per thread per K stage (two int2 halves for each
// of the two payloads) x 4 LDS phases x 1 extra cycle x 32 stages x 4 waves x
// 512 blocks = 1,048,576, while the B publish (linear tid * 16), both fragment
// ds_reads and the coalesced epilogue are conflict-free.  18 has gcd(18, 32)
// = 2, so the 72-byte A row stride makes the fragment reads conflict-free, but
// the publish mapping (thread tid owns A row tid / 4 with 16-byte group
// (tid % 4) * 16) puts the four rows of one 16-lane phase at 18 r mod 32 for
// r = 0..3 - only four of the sixteen even bank residues - so every 8-byte
// staging half needs two LDS cycles instead of one; no 16-byte-aligned stride
// can remove it (such strides are multiples of four words, so a phase reaches
// at most eight residues).  Focused change, 128x128 packed arm only: the A
// publish mapping becomes
//   row = 16 * (tid / 64) + 2 * ((tid % 64) / 16)
//         + 8 * (((tid / 4) % 4) & 1) + (((tid / 4) % 4) >> 1)
//   col = 16 * (tid % 4)
// so the four rows of each 16-lane phase are (2p, 2p + 8, 2p + 1, 2p + 9) and
// their publish word starts 18 r mod 32 are exactly the sixteen even residues
// for both the +0 and the +8 half: each phase touches all 32 LDS banks once
// (one cycle, zero conflicts).  Every 4-lane group still publishes one A row's
// 64 contiguous bytes, so the global A read set, its L1 line/sector pattern
// and the 128-byte row reads are identical to the previous tid-linear mapping;
// the A tile layout (72-byte rows), both barrier-separated fragment reads, the
// B staging, the one-K-stage staging lookahead, the coalesced epilogue, the
// k0-outer/kk-inner int32 accumulation order and the 128x64 arms plus the
// generic scalar fallback are untouched, so the int32 accumulation and the
// stored bits are bit-identical.
//
// Iteration 18 (consolidation round, final HIP-only polish on the fixed
// 128x128 packed architecture): the last measured fixed-region waste of the
// arm is the bf16 conversion in the fused epilogue.  The exact gfx928 code
// object of the accepted iteration-12 source shows every __float2bfloat16(v)
// inside store_prefill_fragment_coalesced_scaled lowered to the Inf/NaN-guarded
// software sequence of amd_hip_bfloat16.h float_to_bfloat16: v_and
// 0x7f800000, v_cmp_ne, s_and_saveexec_b64, s_xor_b64, v_bfe_u32 (round bit),
// v_add3_u32 (0x7fff), s_andn2_saveexec_b64, v_mov_b32 0, v_or_b32 0x10000,
// v_cmp_eq_u32_sdwa, v_cndmask_b32, s_or_b64 exec - roughly a dozen
// VALU/scalar instructions and two exec-mask branches for each of the 64
// values a wave converts (16 fragments x 4 elements), and those branches split
// the epilogue into many small basic blocks.  That Inf/NaN arm is unreachable
// on this arm: its operand is an int32 dot product (|dot| <= 2048 * 127 * 127
// < 2^25) times the finite x_scale and weight_scale values of this operator
// family, so every converted value is finite and the library's finite path is
// just the round-to-nearest-even increment u += 0x7fff + ((u >> 16) & 1)
// followed by u >> 16.  Focused change, 128x128 packed arm only: the coalesced
// epilogue converts its four accumulators per fragment with a straight-line
// bf16_rne_finite() helper (four integer instructions, no s_mov_b32
// 0x7f800000 constant, no exec mask, no branch), which stores bit-identical
// bf16 for every finite input (the 8-byte coalesced stores are untouched).  The
// K loop, the LDS layouts, both barriers per K step, the one-K-stage staging
// lookahead, the in-loop scale batch, the fragment mapping, the store pattern
// and the 128x64 packed/k-major arms plus the generic scalar fallback (which
// keep the library __float2bfloat16 for their per-element stores) are
// byte-identical.
//
// The timed operator performs no allocation, compilation, autotuning, weight
// packing, host synchronization, device synchronization, or default-stream
// launch; both launchers run on the caller-provided PyTorch HIP stream and are
// CUDA/HIP-Graph safe.

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
constexpr int kBlockM = 128;
constexpr int kBlockN = 64;
// Iteration 4 tile-aspect arm: the exact (k, n) == (2048, 2048) packed pair
// takes a 128-wide N tile (M:N tile aspect 1:1) instead of kBlockN == 64.
constexpr int kBlockN128 = 128;
constexpr int kStageK = 64;
// Fragment-major packed B (iteration 5).  One DUMMA matrix_b tile
// (m16n16k32 -> 16 n x 32 k int8) is kTileN * kTileK = 512 contiguous bytes:
// byte (n, k) of tile (n/16, k/32) sits at
//   (k % 32) / 8 * 128 + (n % 16) * 8 + (k % 8).
// Every 16-byte chunk of a tile is therefore one aligned int4 LDS store /
// global read, and a lane's 8-byte fragment slot inside the tile is at
//   (lane & 15) * 8 + (lane >> 4) * 128
// i.e. word 2 * (lane & 15) plus a 32-word k-group stride, so the 16-lane LDS
// phase (lane & 15 = 0..15) covers all 32 banks exactly once: bank-conflict-
// free with zero padding.
constexpr int kBFragBytes = kTileN * kTileK;  // 512
// Legacy raw [K, N] k-major arm: 64 -> 80-byte row stride (16-byte aligned so
// the cooperative staging stays one 128-bit LDS store).
constexpr int kBStride = kBlockN + 16;
constexpr int kAStride = kStageK + 16;  // 64 -> 80-byte A row stride
// Iteration 10 (consolidation round): the 128x128 packed arm uses a 72-byte
// (18-word) A row stride.  72 is 8-byte aligned (so every 8-byte fragment read
// and every split int2 staging store is naturally aligned) but NOT 16-byte
// aligned, and 18*r mod 32 for r = 0..15 is exactly the 16 even bank residues,
// so a 16-lane 8-byte fragment phase touches all 32 LDS banks once instead of
// the 2-way aliasing of the 20-word (80-byte) stride.  The 128x64 arm keeps
// the accepted 80-byte stride via kAStride above.
constexpr int kAStride128 = kStageK + 8;  // 64 -> 72-byte A row stride
constexpr int kBlockThreads = 4 * kWaveSize;

// Exact (k, n) pair whose packed weight buffer is fragment-major for this
// worker's assigned shape (glm_tp8_q_b_proj_m4096).  Every other (k, n) keeps
// the identity device-to-device pack and the raw [K, N] k-major arm.
constexpr int kPackFragMajorK = 2048;
constexpr int kPackFragMajorN = 2048;

using bf16_t = hip_bfloat16;

// ---------------------------------------------------------------------------
// Direct fragment epilogue for one m16n16k32 accumulator fragment.
// Verified gfx928 int8 m16n16k32 accumulator ownership: lane & 15 selects the
// row, lane >> 4 selects col % 4, and frag.x[i] maps to columns col%4 + 4*i.
// The scale multiply order (float(dot) * x_scale[row] * weight_scale[col]) and
// the bf16 rounding match the harness reference
// ((dot.float() * x_scale) * ws.T).to(bfloat16), so the stored bits match.
// ---------------------------------------------------------------------------
template <typename AccFragment>
__device__ __forceinline__ void store_prefill_fragment(
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
    return;  // tail-M masking: padded rows never write
  }
  const int col_mod4 = lane >> 4;
#pragma unroll
  for (int i = 0; i < 4; ++i) {
    const int col = base_col + col_mod4 + 4 * i;
    const float scaled = static_cast<float>(frag.x[i]) *
                         x_scale[row] * weight_scale[col];
    out[static_cast<int64_t>(row) * n + col] = __float2bfloat16(scaled);
  }
}

// ---------------------------------------------------------------------------
// Iteration 18 (consolidation round): straight-line round-to-nearest-even
// float -> bfloat16 for the coalesced epilogue.  This is exactly the finite
// path of amd_hip_bfloat16.h float_to_bfloat16
//   u += 0x7fff + ((u >> 16) & 1);  return u >> 16;
// with the Inf/NaN special case omitted; the 128x128 packed q_b_proj arm only
// ever converts finite values (int32 dot x finite scales), so the bf16 bits
// are identical to __float2bfloat16 while the exec-masked compare/branch pair
// and the s_mov_b32 0x7f800000 / v_or_b32 0x10000 fixups leave the epilogue.
// The per-element 128x64 arm and the generic scalar fallback keep the library
// conversion byte-identically.
// ---------------------------------------------------------------------------
__device__ __forceinline__ unsigned short bf16_rne_finite(float v) {
  unsigned int u = __float_as_uint(v);
  u += 0x7fffu + ((u >> 16) & 1u);  // round to nearest, ties to even
  return static_cast<unsigned short>(u >> 16);
}

// ---------------------------------------------------------------------------
// Iteration 6 (epilogue round): register-batched COALESCED direct-fragment
// epilogue for the exact (k, n) == (2048, 2048) q_b_proj 128x128 arm.  The
// per-element variant above issues one 2-byte bf16 store per lane per
// element: 64 scattered stores per wave per fragment set, each store touching
// 16 rows x 4 columns, so every 32-byte store sector is only 25% utilized
// (PMC: 131,072 vmem_write_instructions = 512 blocks x 4 waves x 64).
//
// This epilogue transposes the four int32 values inside each 4-lane column
// group (lanes r, r+16, r+32, r+48 - a 4x4 register transpose, two 2x2 steps
// with __shfl_xor 16 then 32, which lowers to ds_bpermute at the block tail
// where the LDS pipe is idle), so lane (r, c4) ends up owning the four
// CONTIGUOUS columns base_col + 4*c4 .. +3.  It converts those to bf16, packs
// four bf16 into one 8-byte value and writes ONE 8-byte store per lane (100%
// store sector efficiency; the previous 64 stores become 16 per lane).
//
// Only the int32 accumulator values are re-routed between lanes; the
// per-element multiply order (float(dot) * x_scale[row] * weight_scale[col])
// and the __float2bfloat16 rounding are unchanged, so the stored bits are
// identical.  xs and ws come from caller registers batched on the last K
// stage, so the epilogue issues no interleaved vmem loads.  base_col is a
// multiple of 16 and n*2 is a multiple of 8, so the 8-byte store is aligned;
// the 128x128 arm is only dispatched for m % 128 == 0, so the row >= m guard
// is always false and the shuffles never mix active and inactive lanes.
// ---------------------------------------------------------------------------
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
    return;  // tail-M masking: never fires for m % 128 == 0
  }
  const int c4 = lane >> 4;  // 0..3  (column group inside the m16n16 tile)
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

  // Lane (r, c4) now owns columns base_col + 4*c4 .. +3 of row `row`; ws is
  // the float4 at weight_scale + base_col + 4*c4 preloaded by the caller.
  const int col0 = base_col + 4 * c4;
  const float v0 = static_cast<float>(f0) * xs * ws.x;
  const float v1 = static_cast<float>(f1) * xs * ws.y;
  const float v2 = static_cast<float>(f2) * xs * ws.z;
  const float v3 = static_cast<float>(f3) * xs * ws.w;
  // Iteration 18: straight-line RNE conversion (finite path), bit-identical
  // to the library __float2bfloat16 for this arm's finite values.
  const uint64_t packed =
      static_cast<uint64_t>(bf16_rne_finite(v0)) |
      (static_cast<uint64_t>(bf16_rne_finite(v1)) << 16) |
      (static_cast<uint64_t>(bf16_rne_finite(v2)) << 32) |
      (static_cast<uint64_t>(bf16_rne_finite(v3)) << 48);
  *reinterpret_cast<uint64_t*>(out + static_cast<int64_t>(row) * n + col0) =
      packed;
}

// ---------------------------------------------------------------------------
// Direct 8-byte staged-fragment load.  du_mma.h defines both the matrix_a
// row_major and the matrix_b col_major int8 loaders as
//   x[i] = p[(lane & 15) * ldm + ((lane >> 4) << 3) + i],
// i.e. eight CONTIGUOUS bytes per lane, but the generic slot-by-slot loader
// lowers to per-byte LDS byte gathers plus a mask/shift/OR reassembly chain.
// Writing those same 8 bytes with one 64-bit LDS read keeps the fragment
// storage bit-identical (the int32 accumulation is unchanged) and shortens the
// LDS -> MMAC critical path.
//
// Iteration 5 form: `block` is the base of one 512-byte fragment-major DUMMA
// matrix_b tile, whose layout puts the lane's 8 bytes at
//   (lane & 15) * 8 + (lane >> 4) * 128
// (word 2 * (lane & 15) plus a 32-word k-group stride).  A 16-lane LDS phase
// therefore touches each of the 32 banks exactly once, and the access is a
// single aligned 64-bit read.  Operand bytes are byte-for-byte identical to
// the n-major layout, so correctness is unaffected.
// ---------------------------------------------------------------------------
__device__ __forceinline__ void load_fragment8_block(
    DUFragmentBase<signed char, 8>& frag,
    const signed char* __restrict__ block,
    int lane) {
  const int off = (lane & 15) * 8 + ((lane >> 4) << 7);
  *reinterpret_cast<unsigned long long*>(&frag.x[0]) =
      *reinterpret_cast<const unsigned long long*>(block + off);
}

// ---------------------------------------------------------------------------
// Iteration 9 (A-fragment direct-load round): direct 8-byte staged A-fragment
// load, the A-side twin of load_fragment8_block above.  du_mma.h defines the
// matrix_a row_major int8 loader with the same
//   x[i] = p[(lane & 15) * ldm + ((lane >> 4) << 3) + i]
// mapping as the matrix_b col_major loader, i.e. eight contiguous memory-order
// bytes per lane: the identical mapping the load_fragment8_block comment above
// records for both loaders.  The library wrapper passes base = the fragment
// origin and ldm = the LDS row stride, so the direct read below (base + off,
// off = (lane & 15) * stride + ((lane >> 4) << 3)) addresses exactly the same
// bytes.  It fills the same x[0..7] storage with one 64-bit LDS read, letting
// the compiler feed v_mmac directly instead of materializing the value through
// a pair of ds_read2_b32 plus the byte reassembly chain; the operand bytes and
// therefore the int32 accumulation are bit-identical.  `base + off` is 8-byte
// aligned for the 128x128 arm: a_tile is 16-byte aligned, the row stride is
// 72 (kAStride128, iteration 10) or 80 (kAStride, the 128x64 arm), local_row
// is a multiple of 64, kk is 0 or 32 and every term is a multiple of 8.
// ---------------------------------------------------------------------------
__device__ __forceinline__ void load_fragment8(
    DUFragmentBase<signed char, 8>& frag,
    const signed char* __restrict__ base,
    int stride,
    int lane) {
  const int off = (lane & 15) * stride + ((lane >> 4) << 3);
  *reinterpret_cast<unsigned long long*>(&frag.x[0]) =
      *reinterpret_cast<const unsigned long long*>(base + off);
}

// Byte offset of the 512-byte fragment-major DUMMA B tile for output-column
// fragment n_frag (= n / 16) and k fragment k_frag (= k / 32).  Used by both
// the cooperative staging (global read) and by the scalar fallback decode.
__device__ __forceinline__ int64_t b_frag_block_offset(int n_frag,
                                                       int k_frag,
                                                       int k) {
  return (static_cast<int64_t>(n_frag) * (k / kTileK) + k_frag) *
         kBFragBytes;
}

// ---------------------------------------------------------------------------
// Compile-time B staged-layout selector.  row_major / col_major are tag types
// in du::dumma, so the layout template argument has to be selected as a type.
//   kNMajorB == true  (fragment-major packed B, exact (k, n) == (2048, 2048)):
//     the LDS tile is a contiguous array of 512-byte DUMMA B tiles, each
//     staged with one aligned int4 read/store and each read with the
//     bank-conflict-free load_fragment8_block.
//   kNMajorB == false (raw [K, N] row-major B): k-major tile with the accepted
//     library loader (unchanged).
// ---------------------------------------------------------------------------
template <bool kNMajorB>
struct b_frag_layout {
  using type = row_major;
};
template <>
struct b_frag_layout<true> {
  using type = col_major;
};

// ---------------------------------------------------------------------------
// Large-M prefill: one 128x64 output tile per block, four wavefronts of 64
// lanes.  Each wave owns a 64x32 quadrant (eight m16n16k32 int32
// accumulators); the block cooperatively stages A[128,64] from x_q (row-major,
// stride k) and B[64,64] into a single-buffered LDS stage.  Two barriers per
// stage: one after the cooperative load, one before the next stage overwrites
// LDS.  Dispatch guarantees m % 128 == 0, n % 64 == 0, k % 64 == 0, so every
// global load / store is in-bounds and 16-byte aligned.
//
// B is templated on its staged layout:
//   * kNMajorB == true  (exact (k, n) == (2048, 2048)): B is the
//     fragment-major packed weight; each thread stages one aligned 16-byte
//     chunk of the 8 contiguous 512-byte DUMMA B tiles (4 n fragments x 2 k
//     fragments) with one coalesced int4 global read and one aligned int4 LDS
//     store, and each col_major fragment is one bank-conflict-free 8-byte LDS
//     read per lane (load_fragment8_block).
//   * kNMajorB == false: B is the raw [K, N] identity layout staged k-major
//     with the library row_major loader (unchanged arm).
//
// LDS budget: A[128, 80] = 10,240 B + B (8 * 512 = 4,096 B on the packed arm,
// B[64,80] = 5,120 B on the k-major arm) <= 15,360 B/block, well inside the
// 64 KiB per-CU LDS capacity (4 blocks/CU by LDS alone).
// ---------------------------------------------------------------------------
template <bool kNMajorB>
__global__ __launch_bounds__(kBlockThreads) void w8a8_dumma_prefill_128x64_kernel(
    const int8_t* __restrict__ x_q,
    const int8_t* __restrict__ weight,
    const float* __restrict__ x_scale,
    const float* __restrict__ weight_scale,
    bf16_t* __restrict__ out,
    int m,
    int n,
    int k) {
  constexpr int kBBlocksB =
      kNMajorB ? (kBlockN / kTileN) * (kStageK / kTileK) : kStageK;
  constexpr int kBStrideB = kNMajorB ? kBFragBytes : kBStride;
  const int tid = static_cast<int>(threadIdx.x);
  const int wave = tid / kWaveSize;
  const int lane = tid % kWaveSize;
  const int wave_row = wave >> 1;
  const int wave_col = wave & 1;
  const int m0 = static_cast<int>(blockIdx.y) * kBlockM;
  const int n0 = static_cast<int>(blockIdx.x) * kBlockN;
  const int local_row = wave_row * 64;
  const int local_col = wave_col * 32;

  __shared__ __align__(16) int8_t a_tile[kBlockM * kAStride];
  __shared__ __align__(16) int8_t b_tile[kBBlocksB * kBStrideB];

  DUFragment<matrix_a, kTileM, kTileN, kTileK, signed char, row_major>
      a_frag0, a_frag1;
  DUFragment<matrix_b, kTileM, kTileN, kTileK, signed char,
             typename b_frag_layout<kNMajorB>::type>
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

  // Cooperative staging: A[128,64] is 512 int4s (two per thread, rows
  // [0,64) and [64,128)); B[64,64] is 256 int4s (one per thread).  Thread tid
  // owns A row tid>>2 and 16-byte column group (tid & 3) * 16, and B row
  // tid>>2 with 16-byte group (tid & 3) * 16 (k-major K row for the identity
  // arm, packed fragment-major B tile for the packed arm).
  const int vector_byte_offset = tid * static_cast<int>(sizeof(int4));
  const int stage_row = vector_byte_offset / kStageK;  // 0..63
  const int stage_col = vector_byte_offset - stage_row * kStageK;

  for (int k0 = 0; k0 < k; k0 += kStageK) {
    *reinterpret_cast<int4*>(a_tile + stage_row * kAStride + stage_col) =
        *reinterpret_cast<const int4*>(
            x_q + static_cast<int64_t>(m0 + stage_row) * k + k0 + stage_col);
    *reinterpret_cast<int4*>(a_tile +
                             (stage_row + kBlockM / 2) * kAStride + stage_col) =
        *reinterpret_cast<const int4*>(
            x_q + static_cast<int64_t>(m0 + stage_row + kBlockM / 2) * k +
            k0 + stage_col);
    if constexpr (kNMajorB) {
      // Fragment-major packed B: thread tid stages 16-byte chunk tid of the
      // 8 contiguous 512-byte DUMMA B tiles (4 n fragments x 2 k fragments):
      // one aligned int4 global read and one aligned int4 LDS store at LDS
      // byte offset tid * 16 (contiguous across the wave).
      const int b_blk = tid >> 5;   // 0..7 packed B tile index
      const int b_slot = tid & 31;  // 0..31 16-byte chunk inside the tile
      *reinterpret_cast<int4*>(b_tile + b_blk * kBFragBytes + b_slot * 16) =
          *reinterpret_cast<const int4*>(
              weight + b_frag_block_offset(n0 / kTileN + (b_blk >> 1),
                                           k0 / kTileK + (b_blk & 1), k) +
              b_slot * 16);
    } else {
      // Raw [K, N] row-major B: 16 consecutive n bytes of the (k0 + b_n) row.
      const int b_n = tid >> 2;         // B row (K)
      const int b_nc = (tid & 3) * 16;  // 16-byte group inside that row
      *reinterpret_cast<int4*>(b_tile + b_n * kBStrideB + b_nc) =
          *reinterpret_cast<const int4*>(
              weight + static_cast<int64_t>(k0 + b_n) * n + n0 + b_nc);
    }
    __syncthreads();

    // Each wave consumes its 64x32 quadrant: eight m16n16k32 MMACs per kk.
    // Accumulation order: k0-outer over 64-K stages, kk-inner (kk = 0 then
    // kk = 32), matching the reference int32 accumulation.
#pragma unroll
    for (int kk = 0; kk < kStageK; kk += kTileK) {
      if constexpr (kNMajorB) {
        // Fragment-major LDS tile: the wave's two B fragments are the two
        // contiguous 512-byte DUMMA B tiles (local_col/16 + i, kk/32), each
        // read with one aligned bank-conflict-free 8-byte LDS read per lane.
        load_fragment8_block(
            b_frag0,
            b_tile + ((local_col / kTileN) * 2 + (kk / kTileK)) * kBFragBytes,
            lane);
        load_fragment8_block(
            b_frag1,
            b_tile + (((local_col / kTileN) + 1) * 2 + (kk / kTileK)) *
                         kBFragBytes,
            lane);
      } else {
        du_load_matrix_sync(b_frag0, b_tile + kk * kBStrideB + local_col,
                            kBStrideB);
        du_load_matrix_sync(b_frag1,
                            b_tile + kk * kBStrideB + local_col + kTileN,
                            kBStrideB);
      }
      du_load_matrix_sync(a_frag0, a_tile + local_row * kAStride + kk,
                          kAStride);
      du_load_matrix_sync(a_frag1,
                          a_tile + (local_row + kTileM) * kAStride + kk,
                          kAStride);
      du_mma_sync(acc00, a_frag0, b_frag0, acc00);
      du_mma_sync(acc01, a_frag0, b_frag1, acc01);
      du_mma_sync(acc10, a_frag1, b_frag0, acc10);
      du_mma_sync(acc11, a_frag1, b_frag1, acc11);
      du_load_matrix_sync(a_frag0,
                          a_tile + (local_row + 2 * kTileM) * kAStride + kk,
                          kAStride);
      du_load_matrix_sync(a_frag1,
                          a_tile + (local_row + 3 * kTileM) * kAStride + kk,
                          kAStride);
      du_mma_sync(acc20, a_frag0, b_frag0, acc20);
      du_mma_sync(acc21, a_frag0, b_frag1, acc21);
      du_mma_sync(acc30, a_frag1, b_frag0, acc30);
      du_mma_sync(acc31, a_frag1, b_frag1, acc31);
    }

    // Protect the LDS buffer from the next stage's cooperative overwrite.
    __syncthreads();
  }

  const int base_row = m0 + local_row;
  const int base_col = n0 + local_col;
  store_prefill_fragment(acc00, x_scale, weight_scale, out, base_row,
                         base_col, m, n, lane);
  store_prefill_fragment(acc01, x_scale, weight_scale, out, base_row,
                         base_col + kTileN, m, n, lane);
  store_prefill_fragment(acc10, x_scale, weight_scale, out,
                         base_row + kTileM, base_col, m, n, lane);
  store_prefill_fragment(acc11, x_scale, weight_scale, out,
                         base_row + kTileM, base_col + kTileN, m, n, lane);
  store_prefill_fragment(acc20, x_scale, weight_scale, out,
                         base_row + 2 * kTileM, base_col, m, n, lane);
  store_prefill_fragment(acc21, x_scale, weight_scale, out,
                         base_row + 2 * kTileM, base_col + kTileN, m, n, lane);
  store_prefill_fragment(acc30, x_scale, weight_scale, out,
                         base_row + 3 * kTileM, base_col, m, n, lane);
  store_prefill_fragment(acc31, x_scale, weight_scale, out,
                         base_row + 3 * kTileM, base_col + kTileN, m, n, lane);
}

// ---------------------------------------------------------------------------
// Iteration 4 (tile-aspect round): 128x128 macro-tile for the exact
// (k, n) == (2048, 2048) q_b_proj arm (fragment-major packed weight), four
// wavefronts of 64 lanes, each wave owning a 64x64 quadrant built from four A
// x four B m16n16k32 fragments (sixteen int32 accumulators).  Widening the
// N-tile 64 -> 128 makes the M:N tile aspect 1:1: the A-side global re-read
// halves (A reuse 32 -> 16, ~268 -> ~134 MiB) while B reuse stays 32
// (~134 MiB), so total staged tile traffic drops ~402 -> ~268 MiB (-33%), and
// each wave issues 8 LDS fragment reads per 16 MMACs instead of 6 per 8.
//
// The block stages A[128,64] (two int4/thread, rows tid>>2 and tid>>2 + 64;
// iteration 10 makes the A row stride 72 B = kAStride128, so each 16-byte
// chunk is published with two aligned int2 LDS stores) and the fragment-major
// packed B[128,64] (16 contiguous 512-byte DUMMA B tiles: two 16-byte
// chunks/thread, one aligned int4 global read and one aligned int4 LDS store
// each) into one single-buffered LDS stage: A[128,72] (9,216 B) + B
// (16 * 512 = 8,192 B) = 17,408 B/block, well inside the 64 KiB LDS budget.
// A fragments use the iteration-9 direct 8-byte load_fragment8 (the 72-byte
// stride makes each 16-lane 8-byte phase touch all 32 banks exactly once, i.e.
// zero A-side bank conflicts); B fragments use the bank-conflict-free
// fragment-major load_fragment8_block.  Two __syncthreads per K stage.
// Dispatch guarantees m % 128 == 0, n % 128 == 0 and k % 64 == 0 for this
// arm, so every global load/store is in-bounds and 16-byte aligned.
// Accumulation order (k0-outer over 64-K stages, kk-inner 0 then 32) and the
// fragment element-to-slot mapping are identical to the 128x64 arm, so the
// int32 accumulation is bit-identical.
// ---------------------------------------------------------------------------
__global__ __launch_bounds__(kBlockThreads) void
w8a8_dumma_prefill_128x128_nmajor_kernel(
    const int8_t* __restrict__ x_q,
    const int8_t* __restrict__ weight,
    const float* __restrict__ x_scale,
    const float* __restrict__ weight_scale,
    bf16_t* __restrict__ out,
    int m,
    int n,
    int k) {
  constexpr int kBBlocksB =
      (kBlockN128 / kTileN) * (kStageK / kTileK);  // 16 packed B tiles
  const int tid = static_cast<int>(threadIdx.x);
  const int wave = tid / kWaveSize;
  const int lane = tid % kWaveSize;
  const int wave_row = wave >> 1;  // 0..1
  const int wave_col = wave & 1;   // 0..1
  const int m0 = static_cast<int>(blockIdx.y) * kBlockM;
  const int n0 = static_cast<int>(blockIdx.x) * kBlockN128;
  const int local_row = wave_row * (kBlockM / 2);     // 0 or 64
  const int local_col = wave_col * (kBlockN128 / 2);  // 0 or 64
  const int base_row = m0 + local_row;
  const int base_col = n0 + local_col;

  // Iteration 6 (epilogue round): per-lane register-batched scales.  Each lane
  // owns 4 rows (base_row + 16*i + (lane & 15), i = 0..3) and 4
  // weight_scale float4s (base_col + 16*j + 4*(lane >> 4), j = 0..3) across
  // its 16 accumulator fragments; they are loaded exactly once on the last K
  // stage before the final protective __syncthreads, so the coalesced
  // epilogue below is pure compute + 16 eight-byte stores with no
  // interleaved vmem loads.
  float xs_m[4];
  float4 ws_m[4];

  __shared__ __align__(16) int8_t a_tile[kBlockM * kAStride128];
  __shared__ __align__(16) int8_t b_tile[kBBlocksB * kBFragBytes];

  DUFragment<matrix_a, kTileM, kTileN, kTileK, signed char, row_major>
      a_frag0, a_frag1, a_frag2, a_frag3;
  DUFragment<matrix_b, kTileM, kTileN, kTileK, signed char, col_major>
      b_frag0, b_frag1, b_frag2, b_frag3;
  DUFragment<accumulator, kTileM, kTileN, kTileK, int>
      acc00, acc01, acc02, acc03, acc10, acc11, acc12, acc13,
      acc20, acc21, acc22, acc23, acc30, acc31, acc32, acc33;
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

  // Cooperative staging: A[128,64] is 512 int4s (two per thread: M rows
  // stage_row and stage_row + 64, 16-byte k group stage_col) and the packed
  // B[128,64] is 16 contiguous 512-byte DUMMA B tiles = 512 16-byte chunks
  // (two per thread: tile b_blk = tid>>5 and b_blk + 8, 16-byte slot
  // tid & 31).  Each chunk is one aligned int4 global read; the B chunks are
  // also one aligned int4 LDS store, while the A chunks (72-byte strided rows,
  // iteration 10) are two aligned int2 LDS stores at +0/+8.  Iteration 12
  // remaps which lane publishes which A chunk (stage_row / stage_col below) so
  // that every 16-lane publish phase covers all 32 LDS banks exactly once while
  // each 4-lane group still keeps one A row's 64 contiguous bytes.
  //
  // Iteration 7 (compute-pipeline round): the four chunks are loaded ONE K
  // STAGE AHEAD.  The prologue loads K stage 0 into the payload registers; in
  // the loop the payload of stage s is stored to LDS first, then (for
  // k0 + kStageK < k) stage s + 1 is loaded into the same registers BEFORE the
  // fragment ds_reads and the 32 v_mmac of stage s, so the global-load latency
  // is covered by the stage-s compute burst plus the trailing WAR barrier
  // rather than being drained by a just-issued `s_waitcnt vmcnt(N)` at the
  // stage top.  The payload stays four int4 (16 VGPRs); the LDS stage, both
  // barriers per K step, every staged byte and every fragment address are
  // unchanged.
  // Iteration 12 (consolidation round): A-staging lane mapping.  The four rows
  // of a 16-lane LDS phase are (2p, 2p + 8, 2p + 1, 2p + 9), so the publish
  // word starts 18 * row mod 32 of the phase are exactly the sixteen even bank
  // residues (4p + {0, 2, 4, ..., 30}): each 8-byte staging half touches all
  // 32 LDS banks once instead of twice.
  const int a_phase = lane >> 4;            // 0..3  16-lane LDS phase
  const int a_slot = (lane >> 2) & 3;       // 0..3  4-lane row group
  const int stage_row = wave * 16 + 2 * a_phase + 8 * (a_slot & 1) +
                        (a_slot >> 1);      // 0..63
  const int stage_col = (lane & 3) << 4;    // 0,16,32,48
  const int b_blk = tid >> 5;   // 0..7  packed B tile index
  const int b_slot = tid & 31;  // 0..31 16-byte chunk inside the tile

  const int64_t a_row0 = static_cast<int64_t>(m0 + stage_row) * k;
  const int64_t a_row1 =
      static_cast<int64_t>(m0 + stage_row + kBlockM / 2) * k;
  const int64_t b_step =
      4 * (static_cast<int64_t>(k / kTileK) * kBFragBytes);  // +4 n fragments
  int4 a_payload0 = make_int4(0, 0, 0, 0);
  int4 a_payload1 = make_int4(0, 0, 0, 0);
  int4 b_payload0 = make_int4(0, 0, 0, 0);
  int4 b_payload1 = make_int4(0, 0, 0, 0);
  if (k > 0) {
    a_payload0 = *reinterpret_cast<const int4*>(x_q + a_row0 + stage_col);
    a_payload1 = *reinterpret_cast<const int4*>(x_q + a_row1 + stage_col);
    const int64_t b_off0 =
        b_frag_block_offset(n0 / kTileN + (b_blk >> 1), (b_blk & 1), k);
    b_payload0 =
        *reinterpret_cast<const int4*>(weight + b_off0 + b_slot * 16);
    b_payload1 =
        *reinterpret_cast<const int4*>(weight + b_off0 + b_step + b_slot * 16);
  }

  for (int k0 = 0; k0 < k; k0 += kStageK) {
    // Publish the payload prefetched one K stage ago (prologue for k0 == 0).
    // Iteration 10: the 128x128 arm's A rows are 72-byte strided, so each
    // 16-byte chunk is published with two 8-byte (`int2`) LDS stores at +0 and
    // +8 (row*72 + stage_col is 8-byte aligned for every row); the staged
    // bytes keep their exact (row, k) slots.
    int8_t* const a_dst0 = a_tile + stage_row * kAStride128 + stage_col;
    int8_t* const a_dst1 =
        a_tile + (stage_row + kBlockM / 2) * kAStride128 + stage_col;
    *reinterpret_cast<int2*>(a_dst0) = make_int2(a_payload0.x, a_payload0.y);
    *reinterpret_cast<int2*>(a_dst0 + 8) =
        make_int2(a_payload0.z, a_payload0.w);
    *reinterpret_cast<int2*>(a_dst1) = make_int2(a_payload1.x, a_payload1.y);
    *reinterpret_cast<int2*>(a_dst1 + 8) =
        make_int2(a_payload1.z, a_payload1.w);
    *reinterpret_cast<int4*>(b_tile + b_blk * kBFragBytes + b_slot * 16) =
        b_payload0;
    *reinterpret_cast<int4*>(b_tile + (b_blk + 8) * kBFragBytes +
                             b_slot * 16) = b_payload1;
    __syncthreads();

    if (k0 + kStageK < k) {
      // Prefetch K stage s + 1 before consuming stage s: four aligned int4
      // global reads whose latency overlaps the fragment reads and MMACs.
      const int k1 = k0 + kStageK;
      a_payload0 =
          *reinterpret_cast<const int4*>(x_q + a_row0 + k1 + stage_col);
      a_payload1 =
          *reinterpret_cast<const int4*>(x_q + a_row1 + k1 + stage_col);
      // Tiles 0..7 cover n fragments 0..3 (k fragment = b_blk & 1); tiles
      // 8..15 cover n fragments 4..7 with the same two k fragments.
      const int64_t b_off0 =
          b_frag_block_offset(n0 / kTileN + (b_blk >> 1),
                              k1 / kTileK + (b_blk & 1), k);
      b_payload0 =
          *reinterpret_cast<const int4*>(weight + b_off0 + b_slot * 16);
      b_payload1 =
          *reinterpret_cast<const int4*>(weight + b_off0 + b_step +
                                         b_slot * 16);
    }

    // Each wave consumes its 64x64 quadrant: sixteen m16n16k32 MMACs per kk.
    // Accumulation order: k0-outer over 64-K stages, kk-inner (kk = 0 then
    // kk = 32), matching the reference int32 accumulation.
#pragma unroll
    for (int kk = 0; kk < kStageK; kk += kTileK) {
      // Iteration 9 (A-fragment direct-load round): the four A fragments are
      // read with the direct 8-byte load_fragment8 instead of the library
      // du_load_matrix_sync row_major loader.  The loader has the identical
      // x[i] = p[(lane & 15) * stride + ((lane >> 4) << 3) + i] mapping
      // (eight contiguous memory-order bytes per lane), but on this gfx928
      // code object it lowers to a pair of ds_read2_b32 plus a byte
      // reassembly chain between the LDS read and the dependent v_mmac,
      // whereas the B side (already direct since iterations 2/5) reads its
      // fragment with one wide LDS access.  Filling the same x[0..7] with one
      // aligned 64-bit LDS read keeps the operand bytes bit-identical (the
      // int32 accumulation is unchanged) and removes the reassembly VALU and
      // its lgkmcnt wait states from the LDS->MMAC critical path.
      //
      // Iteration 10 (consolidation round): the A tile row stride is now
      // kAStride128 = 72 (18 words) instead of 80, so the start word of row r
      // is 18*r mod 32, a permutation of the 16 even bank residues: a 16-lane
      // 8-byte fragment phase occupies each of the 32 banks exactly once and
      // the A-side 2-way bank aliasing (80*8 == 640 == 0 mod 128) is gone.
      load_fragment8(a_frag0, a_tile + local_row * kAStride128 + kk,
                     kAStride128, lane);
      load_fragment8(a_frag1,
                     a_tile + (local_row + kTileM) * kAStride128 + kk,
                     kAStride128, lane);
      load_fragment8(a_frag2,
                     a_tile + (local_row + 2 * kTileM) * kAStride128 + kk,
                     kAStride128, lane);
      load_fragment8(a_frag3,
                     a_tile + (local_row + 3 * kTileM) * kAStride128 + kk,
                     kAStride128, lane);
      // Fragment-major LDS tile: the wave's four B fragments are four
      // contiguous 512-byte DUMMA B tiles (local_col/16 + i, kk/32), each read
      // with one aligned bank-conflict-free 8-byte LDS read per lane.
      load_fragment8_block(
          b_frag0,
          b_tile + ((local_col / kTileN) * 2 + (kk / kTileK)) * kBFragBytes,
          lane);
      load_fragment8_block(
          b_frag1,
          b_tile + (((local_col / kTileN) + 1) * 2 + (kk / kTileK)) *
                       kBFragBytes,
          lane);
      load_fragment8_block(
          b_frag2,
          b_tile + (((local_col / kTileN) + 2) * 2 + (kk / kTileK)) *
                       kBFragBytes,
          lane);
      load_fragment8_block(
          b_frag3,
          b_tile + (((local_col / kTileN) + 3) * 2 + (kk / kTileK)) *
                       kBFragBytes,
          lane);
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
    }

    // Last stage only: prefetch the epilogue's per-row x_scale and per-column
    // weight_scale values into registers.  k0 is block-uniform, so the
    // barrier below is still reached by every thread; the row < m guard keeps
    // the x_scale reads in bounds (never fires for m % 128 == 0).  The vmem
    // latency overlaps the barrier below and the dead a_frag/b_frag VGPR slots
    // are reused, so the epilogue is pure compute + coalesced stores.
    if (k0 + kStageK >= k) {
      const int r = lane & 15;
      const int c4 = lane >> 4;
#pragma unroll
      for (int i = 0; i < 4; ++i) {
        const int row = base_row + i * kTileM + r;
        xs_m[i] = (row < m) ? x_scale[row] : 0.0f;
      }
#pragma unroll
      for (int j = 0; j < 4; ++j) {
        ws_m[j] = *reinterpret_cast<const float4*>(
            weight_scale + base_col + j * kTileN + 4 * c4);
      }
    }

    // Protect the LDS buffer from the next stage's cooperative overwrite.
    __syncthreads();
  }

  // Iteration 6 (epilogue round): coalesced direct-fragment epilogue.  Each
  // lane owns four contiguous bf16 columns of its fragment row and writes ONE
  // 8-byte store per fragment (16 stores per wave vs 64 scattered 2-byte
  // stores before); the scales come from the registers batched on the last K
  // stage, so no vmem loads are interleaved with the stores.  The int32
  // accumulation is untouched and the multiply order / bf16 rounding are
  // identical to the old per-element store, so output bits are unchanged.
  store_prefill_fragment_coalesced_scaled(acc00, xs_m[0], ws_m[0], out,
                                          base_row, base_col, m, n, lane);
  store_prefill_fragment_coalesced_scaled(acc01, xs_m[0], ws_m[1], out,
                                          base_row, base_col + kTileN, m, n,
                                          lane);
  store_prefill_fragment_coalesced_scaled(acc02, xs_m[0], ws_m[2], out,
                                          base_row, base_col + 2 * kTileN, m,
                                          n, lane);
  store_prefill_fragment_coalesced_scaled(acc03, xs_m[0], ws_m[3], out,
                                          base_row, base_col + 3 * kTileN, m,
                                          n, lane);
  store_prefill_fragment_coalesced_scaled(acc10, xs_m[1], ws_m[0], out,
                                          base_row + kTileM, base_col, m, n,
                                          lane);
  store_prefill_fragment_coalesced_scaled(acc11, xs_m[1], ws_m[1], out,
                                          base_row + kTileM,
                                          base_col + kTileN, m, n, lane);
  store_prefill_fragment_coalesced_scaled(acc12, xs_m[1], ws_m[2], out,
                                          base_row + kTileM,
                                          base_col + 2 * kTileN, m, n, lane);
  store_prefill_fragment_coalesced_scaled(acc13, xs_m[1], ws_m[3], out,
                                          base_row + kTileM,
                                          base_col + 3 * kTileN, m, n, lane);
  store_prefill_fragment_coalesced_scaled(acc20, xs_m[2], ws_m[0], out,
                                          base_row + 2 * kTileM, base_col, m,
                                          n, lane);
  store_prefill_fragment_coalesced_scaled(acc21, xs_m[2], ws_m[1], out,
                                          base_row + 2 * kTileM,
                                          base_col + kTileN, m, n, lane);
  store_prefill_fragment_coalesced_scaled(acc22, xs_m[2], ws_m[2], out,
                                          base_row + 2 * kTileM,
                                          base_col + 2 * kTileN, m, n, lane);
  store_prefill_fragment_coalesced_scaled(acc23, xs_m[2], ws_m[3], out,
                                          base_row + 2 * kTileM,
                                          base_col + 3 * kTileN, m, n, lane);
  store_prefill_fragment_coalesced_scaled(acc30, xs_m[3], ws_m[0], out,
                                          base_row + 3 * kTileM, base_col, m,
                                          n, lane);
  store_prefill_fragment_coalesced_scaled(acc31, xs_m[3], ws_m[1], out,
                                          base_row + 3 * kTileM,
                                          base_col + kTileN, m, n, lane);
  store_prefill_fragment_coalesced_scaled(acc32, xs_m[3], ws_m[2], out,
                                          base_row + 3 * kTileM,
                                          base_col + 2 * kTileN, m, n, lane);
  store_prefill_fragment_coalesced_scaled(acc33, xs_m[3], ws_m[3], out,
                                          base_row + 3 * kTileM,
                                          base_col + 3 * kTileN, m, n, lane);
}

// ---------------------------------------------------------------------------
// Generic scalar fallback: one thread per output element, exact int32 dot over
// K, then the fused x_scale[row] * weight_scale[col] epilogue and one bf16
// store.  Handles every unmatched (m, n, k), including all small-M API cases
// (M=2, M=16) and any M < 128 with the same (N, K) as the tiled path.
// kNMajorPack == true decodes the fragment-major packed weight of the exact
// (k, n) == (2048, 2048) pair; otherwise the weight is the raw [K, N]
// identity layout.
// ---------------------------------------------------------------------------
template <bool kNMajorPack>
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
  const int8_t* a_row = x_q + static_cast<int64_t>(row) * k;
  int32_t acc = 0;
  if constexpr (kNMajorPack) {
    // Fragment-major pack: decode the 512-byte DUMMA B tile offset of
    // (n = col, k = kk) exactly as w8a8_pack_fragment_major_i8_kernel wrote it.
    const int n_frag = col / kTileN;
    const int n_rem = col % kTileN;
    const int k_frags = k / kTileK;
    for (int kk = 0; kk < k; ++kk) {
      const int k_frag = kk / kTileK;
      const int kk8 = (kk % kTileK) / 8;
      const int kk8r = kk % 8;
      const int64_t idx =
          ((static_cast<int64_t>(n_frag) * k_frags + k_frag) * kBFragBytes) +
          (kk8 * 128) + (n_rem * 8) + kk8r;
      acc += static_cast<int32_t>(a_row[kk]) *
             static_cast<int32_t>(weight[idx]);
    }
  } else {
    // Identity [K, N]: column col is strided by n.
    const int8_t* b_col = weight + col;
    for (int kk = 0; kk < k; ++kk) {
      acc += static_cast<int32_t>(a_row[kk]) *
             static_cast<int32_t>(b_col[static_cast<int64_t>(kk) * n]);
    }
  }
  const float scaled =
      static_cast<float>(acc) * x_scale[row] * weight_scale[col];
  out[linear] = __float2bfloat16(scaled);
}

// ---------------------------------------------------------------------------
// Iteration 5 fragment-major permutation for the exact (k, n) == (2048, 2048)
// q_b_proj weight: one DUMMA matrix_b tile (16 n x 32 k int8 = kBFragBytes =
// 512 B) is one contiguous, 16-byte-aligned block,
//   packed[((n / 16) * (K / 32) + k / 32) * 512
//          + (k % 32) / 8 * 128 + (n % 16) * 8 + (k % 8)]
//       == raw[k * N + n],
// i.e. a pure permutation of the same K * N bytes into the same graph-stable
// buffer.  Runs once outside the timed region and outside Graph capture.  The
// layout lets every 16-byte staged chunk become one aligned int4 global read
// plus one aligned int4 LDS store, and every per-lane 8-byte fragment read
// covers all 32 LDS banks exactly once per 16-lane phase.
// ---------------------------------------------------------------------------
__global__ __launch_bounds__(256) void w8a8_pack_fragment_major_i8_kernel(
    const int8_t* __restrict__ raw,
    int8_t* __restrict__ packed,
    int k,
    int n) {
  const int64_t linear =
      static_cast<int64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
  const int64_t total = static_cast<int64_t>(n) * k;
  if (linear >= total) {
    return;
  }
  const int k_frags = k / kTileK;  // K / 32
  const int blk = static_cast<int>(linear / kBFragBytes);
  const int off =
      static_cast<int>(linear - static_cast<int64_t>(blk) * kBFragBytes);
  const int kk8 = off >> 7;          // (k % 32) / 8, 0..3
  const int rem = off & 127;         // 0..127
  const int n_rem = rem >> 3;        // n % 16
  const int kk8r = rem & 7;          // k % 8
  const int n_frag = blk / k_frags;  // n / 16
  const int k_frag = blk - n_frag * k_frags;  // k / 32
  const int n_idx = (n_frag * kTileN) + n_rem;
  const int k_idx = (k_frag * kTileK) + (kk8 * 8) + kk8r;
  packed[linear] = raw[static_cast<int64_t>(k_idx) * n + n_idx];
}

// ---------------------------------------------------------------------------
// Bootstrap identity device-to-device packing (outside the timed region and
// outside Graph capture) for every (k, n) except the exact fragment-major pair
// above.
// The packed buffers keep the same byte count and the same graph-stable
// addresses, so the GEMM consumes the raw [K, N] row-major layout directly.
// ---------------------------------------------------------------------------
__global__ __launch_bounds__(256) void w8a8_pack_identity_i8_kernel(
    const int8_t* __restrict__ raw,
    int8_t* __restrict__ packed,
    int64_t count) {
  const int64_t linear =
      static_cast<int64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
  if (linear < count) {
    packed[linear] = raw[linear];
  }
}

__global__ __launch_bounds__(256) void w8a8_pack_identity_f32_kernel(
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
// Both launchers are pure dispatch: no allocation, no packing decision, no
// synchronization, no default-stream launch; they run on the caller-provided
// PyTorch stream and are CUDA/HIP-Graph safe.
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

  // Explicit dispatch.  The assigned large-prefill shape (M=4096, N=2048,
  // K=2048) takes the native INT8 DUMMA tiled path; every other (m, n, k) -
  // including all small-M API cases (M=2, M=16) and M < 128 - takes the
  // scalar fallback.  The geometry guard is exact so the paired small-M API
  // shape with the same (N, K) can never enter the tiled kernel.  Within the
  // tiled path, only the exact (k, n) == (2048, 2048) pair - whose weight the
  // packer permuted fragment-major - takes the packed arm: iteration 4 gives
  // it the 128x128 tile-aspect arm when n is a multiple of 128, and the
  // 128x64 arm otherwise.  Every other pair keeps the byte-identical raw
  // [K, N] identity 128x64 arm.
  const bool packed_pair = (k == kPackFragMajorK && n == kPackFragMajorN);
  if (m >= kBlockM && m % kBlockM == 0 && n % kBlockN == 0 &&
      k % kStageK == 0) {
    const dim3 grid(static_cast<unsigned>(n / kBlockN),
                    static_cast<unsigned>(m / kBlockM));
    const dim3 block(kBlockThreads);
    if (packed_pair && n % kBlockN128 == 0) {
      // Exact q_b_proj (2048, 2048): iteration-4 tile-aspect arm, 128x128
      // tile (M:N aspect 1:1) with the iteration-5 fragment-major packed B
      // layout; grid (N/128, M/128) = 512 blocks for M=4096.  n == 2048 is
      // divisible by 128 by the exact guard, and the outer tiled guard already
      // implies m % 128 == 0 and k % 64 == 0.
      const dim3 grid128(static_cast<unsigned>(n / kBlockN128),
                         static_cast<unsigned>(m / kBlockM));
      hipLaunchKernelGGL(
          HIP_KERNEL_NAME(w8a8_dumma_prefill_128x128_nmajor_kernel),
          grid128, block, 0, stream,
          a, b, x_scale, weight_scale, out_bf16, m, n, k);
    } else if (packed_pair) {
      hipLaunchKernelGGL(
          HIP_KERNEL_NAME(w8a8_dumma_prefill_128x64_kernel<true>),
          grid, block, 0, stream,
          a, b, x_scale, weight_scale, out_bf16, m, n, k);
    } else {
      hipLaunchKernelGGL(
          HIP_KERNEL_NAME(w8a8_dumma_prefill_128x64_kernel<false>),
          grid, block, 0, stream,
          a, b, x_scale, weight_scale, out_bf16, m, n, k);
    }
  } else {
    constexpr int kBlock = 256;
    const int64_t total = static_cast<int64_t>(m) * n;
    const dim3 grid(static_cast<unsigned>((total + kBlock - 1) / kBlock));
    const dim3 block(kBlock);
    if (packed_pair) {
      hipLaunchKernelGGL(
          HIP_KERNEL_NAME(w8a8_gemm_scalar_fallback_kernel<true>),
          grid, block, 0, stream,
          a, b, x_scale, weight_scale, out_bf16, m, n, k);
    } else {
      hipLaunchKernelGGL(
          HIP_KERNEL_NAME(w8a8_gemm_scalar_fallback_kernel<false>),
          grid, block, 0, stream,
          a, b, x_scale, weight_scale, out_bf16, m, n, k);
    }
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

  // Iteration 5 pack: fragment-major permutation of the exact
  // (k, n) == (2048, 2048) q_b_proj weight (one 512-byte DUMMA B tile per
  // (n/16, k/32) pair); identity device-to-device copy for every other
  // (k, n).  Same byte count as the raw weight either way, so the buffer size
  // / address is stable across Graph capture and replay.
  const int64_t weight_count = static_cast<int64_t>(k) * n;
  const dim3 weight_grid(
      static_cast<unsigned>((weight_count + kBlock - 1) / kBlock));
  if (k == kPackFragMajorK && n == kPackFragMajorN) {
    hipLaunchKernelGGL(w8a8_pack_fragment_major_i8_kernel,
                       weight_grid, block, 0, stream,
                       raw_weight, packed_weight, k, n);
  } else {
    hipLaunchKernelGGL(w8a8_pack_identity_i8_kernel,
                       weight_grid, block, 0, stream,
                       raw_weight, packed_weight, weight_count);
  }

  const int64_t scale_count = n;
  const dim3 scale_grid(
      static_cast<unsigned>((scale_count + kBlock - 1) / kBlock));
  hipLaunchKernelGGL(w8a8_pack_identity_f32_kernel,
                     scale_grid, block, 0, stream,
                     weight_scale, packed_weight_scale, static_cast<int>(n));
  (void)hipGetLastError();
}
// @@end
