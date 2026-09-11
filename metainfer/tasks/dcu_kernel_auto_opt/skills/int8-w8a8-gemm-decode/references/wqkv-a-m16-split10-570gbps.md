# wqkv_a M16 split10: 570 GB/s logical request bandwidth

## Contents

- Evidence and metric contract
- Final kernel structure
- Why non-uniform split-K=10 wins
- Logical-byte derivation
- Optimization sequence and rejected evidence

## Evidence and metric contract

This case was validated on worker29 K500SM_AI/gfx928, DTK 26.04:

```text
M=16, K=4096, N=1536
int8 A x int8 B -> int32 -> scales -> bf16
```

Use unprofiled GPU events with CUDA/HIP Graph, 100 warmups, 300 samples, and
20 operator calls per event sample. Time partial plus combine. Exact eager,
Graph, and changed-input-at-captured-address bf16 checks passed.

The reported 570.0 GB/s is `known program-level global requests / event time`.
It is not a hardware-counter measurement of physical HBM traffic. Hot Graph
replay can hit caches. To claim HBM bandwidth, use a cache-cold ring whose
footprint exceeds cache and verify HBM bytes with appropriate PMC counters.

## Final kernel structure

- Use block-N=64: four wave64 compute four 16x16 tiles and share A.
- Use stage-K=64 and two LDS buffers.
- Issue stage `i+1` aligned 16-byte A/B global loads before the two current
  `v_mmac_i32_16x16x32_i8` operations.
- Place `s_waitcnt vmcnt(0)` immediately before writing the alternate LDS
  buffer. Keep the cross-wave barrier; the validated synchronization variant
  uses a raw first `s_barrier` and compiler-managed second barrier.
- Write split-major int32 partials and use a separate 256-thread combine
  kernel for ten partials, scales, bf16 conversion, and output.

Do not infer a working software pipeline from HIP source alone. Require final
ISA to show next-stage `global_load_dwordx4` before current MMAC and its wait
near `ds_write_b128` into alternate LDS.

Final partial-kernel metadata:

```text
40 VGPR, 27 SGPR, 10240 B LDS
private/scratch 0, VGPR spill 0, SGPR spill 0
workgroup 256, wavefront 64
```

## Why non-uniform split-K=10 wins

K contains 64 stage-K=64 units. Divide them as `4x7 + 6x6`, so every split
boundary remains stage/DUMMA aligned. With `N/64=24` N tiles:

```text
partial blocks = 24 * 10 = 240
device CUs     = 120
grid batches   = exactly 2 blocks/CU
```

This avoids the 192-block split8 grid's second batch containing only 72
blocks. It also avoids split16's extra workspace/combine traffic. Generalize
the method, not the literal split: scan
`ceil(N/blockN) * splitK` around integer multiples of the target CU count,
while measuring block lifetime, residency, partial bytes, and combine cost.

## Logical-byte derivation

```text
B read once                         4096*1536       = 6,291,456 B
A reread for each of 24 N blocks   16*4096*24     = 1,572,864 B
10 partial planes written          10*16*1536*4   =   983,040 B
10 partial planes read             10*16*1536*4   =   983,040 B
bf16 output                         16*1536*2      =    49,152 B
fp32 scales                         (16+1536)*4    =     6,208 B
total                                                9,885,760 B
```

At the default optimized API Graph median of 17.344 us:

```text
9,885,760 B / 17.344 us = 570.0 GB/s
2*M*N*K / 17.344 us     = 11.608 INT8 TOPS
P90                     = 17.616 us
```

The 300-sample direct tuner result was 17.432 us median / 17.888 us P90.
The same-session split8/w4 baseline was 18.312 us / 18.512 us.

## Optimization sequence and rejected evidence

1. Reduce stage-K to 64 to shorten wait/barrier granularity.
2. Double-buffer LDS and overlap next-stage VMEM with current MMAC.
3. Move from three to four waves: A logical reads fall from 32 copies to 24,
   and the partial kernel uses a 16x64 block tile.
4. Use the validated raw-first-barrier synchronization mode.
5. Replace uniform split8 with stage-aligned non-uniform split10 to match the
   120-CU grid.

Retain these negative results as search boundaries:

| Candidate | Graph median | Reason |
|---|---:|---|
| waves8, split8 | 18.848 us | only 96 blocks; insufficient CU coverage |
| waves4, split4 | 22.338 us | only 96 blocks despite lower partial traffic |
| waves3/4, split16 | 20.604--22.144 us | excess partial/combine traffic |
| atomic last-arriver fused finalize | 18.864 us | atomic and tail imbalance erase launch saving |
| cooperative grid finalize | unusable in Graph | DTK 26.04 captured an empty Graph |

Do not optimize only the partial kernel. Separately measure partial and
combine for diagnosis, then accept only full-operator Graph timing. Preserve
working and rejected symbols so later DTK versions can revisit Graph capture
or synchronization without losing evidence.
