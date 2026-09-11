# M=2 decode search and validated wqkv_a route on gfx928

Use this reference only for `M=2` W8A8 decode. Optimize Graph replay first;
use eager timing only as a secondary launch/binding check.

## Fair Triton Graph baselines

| K,N | Graph baseline |
|---|---:|
| 4096,1536 | 66.924 us |
| 1024,8192 | 47.181 us |
| 2048,4096 | 54.453 us |
| 4096,1024 | 60.389 us |
| 512,4096 | 18.975 us |

Do not choose scalar or DUMMA from M alone. Padded DUMMA wastes 14 of 16
rows; scalar code gives up matrix throughput. Benchmark both under the same
Graph scope.

## Candidate A: specialized padded DUMMA

1. Start with one wave per N16 tile.
2. Keep `A[16,K_STAGE]` in LDS, but initialize padded rows 2..15 once outside
   the K loop and copy only the two real rows per stage.
3. Sweep `K_STAGE={64,128,256}` and reject resource/occupancy regressions.
4. Load packed row-major B directly first; add B LDS only after measured reuse
   or load-stall evidence.
5. Store only accumulator rows 0 and 1 through the verified direct epilogue.
   Lanes with `(lane&15)<2` write; all lanes still execute DUMMA.
6. Fuse scales, bf16 conversion, and output writeback.

## Candidate B: two-row skinny dot

Try only when padded DUMMA lacks a robust win. Let one thread own N columns,
compute two int32 accumulators, and reuse each B value across the two rows.
Keep adjacent lanes on adjacent N columns. Start with one wave and 64 columns
per block. Do not use packed casts or `sdot4` until DTK ISA and an appropriate
load-time packed weight layout are verified. Reject row fusion if reduced grid
parallelism outweighs B reuse.

## Starting grids

| K,N | N16 blocks | First candidates |
|---|---:|---|
| 4096,1536 | 96 | 1-wave DUMMA; split-K=2/4 |
| 1024,8192 | 512 | 1-wave; 2-wave A reuse; no split initially |
| 2048,4096 | 256 | 1-wave; no split initially |
| 4096,1024 | 64 | 1-wave; split-K=2/4/8 |
| 512,4096 | 256 | 1-wave, stage64/128; avoid split initially |

For split-K, store only `[split_k,2,N] int32`, not 16 padded rows. Include the
combine kernel in total timing.

## Validated wqkv_a route: M=2, K=4096, N=1536

Worker29, K500SM_AI/gfx928, DTK 26.04, preallocated output/workspace, 50
warmups, 100 samples, and 20 operations/event produced these retained Graph
results:

| Candidate | Median us | P90 us | Status |
|---|---:|---:|---|
| generic M<16 padded DUMMA | 197.585 | 197.793 | baseline |
| direct M2 Stage64 | 92.066 | 92.146 | retained |
| direct M2 Stage128 | 69.781 | 70.225 | retained |
| direct M2 Stage256 | 41.625 | 42.161 | retained |
| direct M2 Stage512 | 40.213 | 40.624 | best no-workspace route |
| direct M2 Stage1024 | 40.884 | 41.368 | rejected |
| direct M2 Stage2048 | 41.480 | 41.905 | rejected |
| split2 Stage512 | 26.564 | 26.736 | retained |
| split4 Stage256 | 22.684 | 23.312 | retained |
| split8 Stage512, one wave, combine256 | 20.544 | 21.360 | superseded |
| split8 Stage512, two waves, combine64 | 20.280 | 20.696 | selected architecture |
| B coalesced global-to-LDS staging | 32.712 | 32.912 | rejected |
| paired B-fragment prefetch | 20.488 | 20.856 | rejected |
| uneven split10 | 21.381 | 21.681 | rejected |
| fused atomic last-arriver finalize | 21.892 | 22.008 | rejected |

After static dispatch integration, three independent selected-path Graph
median/P90 runs were:

```text
20.004 / 21.592 us
20.024 / 20.448 us
19.944 / 20.336 us
```

This clears the 66.924 us Triton Graph baseline by about 3.35x. Exact bf16
comparison passed for every retained stage and for split8 after changing all
captured input tensor contents before Graph replay.

### Selected algorithm

1. Split the 128 K32 MMAC tiles uniformly eight ways; launch
   `96 N16 tiles x 8 splits`.
2. Put two adjacent N16 waves in each block. Let both waves share one
   `A[16,512]` LDS stage.
3. Zero padded A rows 2..15 once per block and copy only rows 0..1 with
   aligned 16-byte HIP vector loads.
4. Load row-major B directly through `du_load_matrix_sync`; execute 16
   `m16n16k32` MMAC instructions per split.
5. Store only two accumulator rows into `[8,2,N] int32` workspace using the
   verified direct fragment lane mapping.
6. Use a separate 64-thread vectorized combine kernel for scaling and bf16
   output. Allocate output and workspace before Graph capture.

The public no-workspace fallback uses direct Stage512. The optimized Graph
API uses split8/two-wave/combine64.

### ISA and PMC evidence

The exact accepted code object confirms:

```text
16  v_mmac_i32_16x16x32_i8
128 global_load_ubyte
16  ds_read2_b32
2   ds_write_b128
1   global_load_dwordx4
4   global_store_dword
77  s_waitcnt
2   s_barrier
```

PMC reports 64 architecture VGPR, 32 SGPR, 8192 bytes LDS, zero scratch, and
about 98,560 external 64-byte read requests per main-kernel invocation
(approximately 6.31 MB). The byte loads are not proof that DUMMA is absent:
the MMAC is present. They arise from the row-major B fragment mapping, where
each lane's eight K values are separated by leading dimension N.

Do not write raw MMAC merely to satisfy an inline-assembly goal. DUMMA already
emits the target instruction. Raw VMEM is also not justified here: previous
gfx928 raw global-load constraints require independent correctness proof, and
the B elements needed by one lane are not a contiguous dword. Prefer a
prepacked weight experiment only when one-time preprocessing and an explicit
packed-layout contract are allowed.

### Bandwidth labels

At about 19.99 us, unique logical tensor bytes imply roughly 316 GB/s;
including split-workspace writes and reads implies roughly 326 GB/s. Label
both as event-derived program rates, not physical peak HBM bandwidth. The
kernel performs real computation and the fixed DUMMA M16 tile pads 14 of 16
rows, so comparison with a 500-800 GB/s pure-memory proxy is invalid.

To pursue 500+ GB/s without removing computation, change one of the contracts:

- prepack B into a fragment/lane-friendly layout outside timed execution;
- batch/fuse multiple M2 requests so the physical M16 tile has more live rows;
- fuse adjacent operators so split/combine and launch costs are amortized.

Remeasure fallback layout and end-to-end TTFT after any weight preprocessing.

## Experiment and acceptance order

```text
Triton baseline -> generic padded DUMMA -> M2-specialized DUMMA
-> stage/wave sweep -> selected split-K -> skinny dot if needed
-> PMC explanation -> SGLang Graph replay
```

Accept a dispatch only after exact bf16 random/extreme tests, changed-content
Graph replay, at least 5% median Graph improvement in three independent runs,
no material P90 regression, no scratch/spill, combine-inclusive timing, and no
eager/end-to-end regression that erases the Graph gain. Otherwise retain
Triton. Historical vectorization/ILP failures apply only to those measured
implementations, not to all tiny-M kernels.
