# wqkv_a M=3072: DUMMA prefetch and ISA evidence

## Contents

- [Scope and result](#scope-and-result)
- [Selected pipeline](#selected-pipeline)
- [Why stage64 won](#why-stage64-won)
- [ISA audit](#isa-audit)
- [Bandwidth accounting](#bandwidth-accounting)
- [Reproduction and artifacts](#reproduction-and-artifacts)

## Scope and result

Validated on worker29, K500SM_AI/gfx928, DTK 26.04:

```text
M=3072, K=4096, N=1536
int8 A x int8 B -> int32 -> x_scale * weight_scale -> bf16
```

Every accepted candidate matched the full bf16 torch float32-GEMM reference
exactly and passed HIP Graph replay. The selected result was:

```text
tile                 64x64
workgroup            256 threads / four wave64
stage-K              64
LDS                  16 KiB, two alternating 8 KiB buffers
VGPR / SGPR           63 / 43
scratch / spills     0 / 0
median / P90         598.983 / 605.783 us
INT8 throughput      64.534 TOPS
```

A longer 100-warmup/300-sample run measured 615.996 us median and 621.276 us
P90. Preserve both the alternating comparison and sustained result; the gap
is thermal/frequency drift, not a correctness change.

## Selected pipeline

Each block owns a 64x64 output tile. Four waves each own one 32x32 quadrant,
represented by four m16n16 accumulators. For every stage:

```text
issue next A/B global_load_dwordx4 into VGPR
load current A/B fragments from current LDS buffer
execute eight v_mmac_i32_16x16x32_i8 per wave
s_waitcnt vmcnt(0)
write prefetched int4 vectors to alternate LDS with ds_write_b128
s_waitcnt lgkmcnt(0)
s_barrier
swap current/alternate LDS buffers
```

Each thread carries two 16-byte next-stage vectors for stage64. Keep those
registers live only across the current MMAC group; extending their lifetime
raises VGPR pressure without improving overlap.

## Why stage64 won

| Candidate | Median us | P90 us | INT8 TOPS | Diagnosis |
|---|---:|---:|---:|---|
| original stage128, single LDS | 841.748 | 844.148 | 45.922 | no VMEM/MMAC overlap |
| double LDS stage32 | 819.212 | 832.112 | 47.185 | twice as many stage barriers |
| double LDS stage64 | 602.054 | 610.554 | 64.205 | best latency/occupancy balance |
| double LDS stage128 | 883.311 | 885.871 | 43.761 | 85 VGPR + 32 KiB LDS pressure |
| stage64 + raw LDS-ready barrier | 598.983 | 605.783 | 64.534 | selected |

Do not infer that shallower stages are always better. stage32 reduced LDS and
prefetch registers but doubled synchronization frequency. stage128 doubled
work per barrier but expanded LDS and live prefetch state enough to regress.

One-node Graph was best. Ordinary stage64 measured approximately
603.035/610.055/613.035/614.690 us per call at Graph depths 1/4/8/16.

## ISA audit

Use the code object extracted from the same JIT extension that produced the
timing. Match the exact symbol containing `ILi64ELb1E`; `Li64` is stage64 and
`Lb1` is the accepted raw-ready-barrier specialization.

Required steady-state evidence:

1. A next-stage `global_load_dwordx4` appears before the current MMAC group.
2. Eight `v_mmac_i32_16x16x32_i8` sites appear before the load's
   `s_waitcnt vmcnt(0)`.
3. `ds_write_b128` consumes the prefetched VGPR tuple after the VMEM wait.
4. `s_waitcnt lgkmcnt(0); s_barrier` protects the LDS-ready boundary.
5. Metadata reports 63 VGPR, 43 SGPR, 16,384 bytes LDS, zero private segment,
   and zero spills.

Reject source-only claims. In the pure-memory precursor, LLVM commoned two
nominal A reads; timing looked faster, but ISA showed only five loads instead
of the required six. An opaque VGPR index was needed to retain the second
ordinary GLOBAL load. The general rule is to count required memory sites and
inspect their cache modifiers before accepting bytes/time.

Use raw asm only after proving a compiler limitation or synchronization
redundancy. Do not hand-write raw global memory or raw MMAC here: tuple
constraints, EXEC/VCC/SCC effects, cache flags, and fragment lane ownership
must be independently verified.

## Bandwidth accounting

Keep these metrics separate:

```text
unique API bytes/call                         28,329,984
tiled A/B requests                            603,979,776
output stores                                   9,437,184
tiled operand+output request bytes            613,416,960
```

At 598.983 us, unique API bytes give about 47.30 GB/s, while tiled
operand+output requests give about 1.024 TB/s. The first reflects useful tensor
footprint; the second shows that the global request pipeline remains busy
while MMAC executes. Repeated tile requests can hit cache, so neither is a
physical-HBM claim without PMC plus a cache-cold protocol.

The pure-memory M=3072 proxy reached 805.651 GB/s using 56,659,968 explicit
read+write bytes per call and a 16-node cold-ring Graph. Do not compare that
copy-program metric directly with real GEMM's unique-byte metric.

## Reproduction and artifacts

```bash
cd /workspace/ISA_test_codex/wqkv_a_compute_tuning
HIP_VISIBLE_DEVICES=0 python benchmark_prefill_m3072.py \
  --stage-k=65 --warmups=50 --samples=150 --nodes=1 --check
```

`stage-k=65` is only the retained tuning identifier for stage64 plus the raw
LDS-ready barrier. The public `gemm_out_prefill(...)` dispatches the same
kernel.

Artifacts:

```text
/workspace/ISA_test_codex/wqkv_a_compute_tuning/w8a8_gemm_compute.hip
/workspace/ISA_test_codex/wqkv_a_compute_tuning/M3072_RESULTS.md
/workspace/ISA_test_codex/wqkv_a_compute_tuning/wqkv_a_m3072_compute_gfx928.co
/workspace/ISA_test_codex/wqkv_a_compute_tuning/wqkv_a_m3072_compute_stage64_raw.isa
/workspace/ISA_test_codex/wqkv_a_compute_tuning/wqkv_a_m3072_compute.notes
```
