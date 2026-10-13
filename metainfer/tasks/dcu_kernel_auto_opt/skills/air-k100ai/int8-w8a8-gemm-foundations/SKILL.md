---
name: int8-w8a8-gemm-foundations
description: >
  Shared foundations for INT8 W8A8 GEMM on the AIR-COOLED Hygon K100_AI
  (gfx928, no HBM address hashing): operator/layout contract, DUMMA and
  epilogue rules, Graph-safe PyTorch bindings, SGLang integration, fair
  benchmarking, correctness gates. This is the air-board edition -- its
  measured numbers are kme6's. Load it together with int8-w8a8-gemm-decode
  (M<=32) or int8-w8a8-gemm-prefill (M>32).
---

<!-- metainfer-edition: air-k100ai -->

# INT8 W8A8 GEMM — Shared Foundations (air board: K100_AI / DEV-AI, gfx928)

**Which board this edition is for.** `kme6` / `air-k100ai`: K100_AI on the AI
firmware line (`DEV-AI`), where **HBM address hashing is off**. Concurrent
strided reads collapse onto the same channels, so read-heavy operators run
1.06–1.70x slower than on the liquid board (`K500SM_AI / DEV-HPC`) and the gap
is per-operator. Everything below marked *(method)* is hardware independent and
was carried over from the liquid edition; everything marked *(air measured)* is
this board's own data.

> **Never quote another board's numbers here.** The liquid edition of this skill
> family contains liquid measurements (and, in its `references/`, deep ISA
> walkthroughs written against them). Those are archived under
> `skills/liquid-k500sm/` and are **not** installed on this machine. If you need
> a baseline, read `baselines/air-k100ai.json` (or the decode/prefill editions'
> `references/air-measured-baselines.md`) -- a number that is not in this board's
> table is simply **unmeasured here**.

## 0. Phase routing (read first) *(method)*

| M | Skill to load | Kernel family | Bottleneck |
|---|---|---|---|
| **M <= 32 (decode)** | `int8-w8a8-gemm-decode` | split-K partial + fused combine, small tiles | launch/latency-bound, µs-scale |
| **M > 32 (prefill)** | `int8-w8a8-gemm-prefill` | 2D M-tile, staged LDS, no split-K | LDS/compute-bound, ms-scale |

Recipes do not transfer across that boundary, and **none of the liquid edition's
validated recipes counts as validated here** -- they are starting points to
re-measure. M in (32, 3072) is an unmeasured gap on this board: route by
measurement, keep one arm per regime.

## 1. Operator contract *(method)*

```text
x_q[M,K] int8 @ weight[K,N] int8
    -> accumulator[M,N] int32
    -> accumulator * x_scale[M,1] * weight_scale[N,1].T
    -> out[M,N] bf16
```

The timed GEMM includes integer accumulation, both scales, the bf16 conversion
and the output writeback. It excludes activation quantization, weight
preprocessing, allocation, output clearing, JIT and Graph capture.

All target K values are divisible by 128 and all N values by 64.

## 2. Shape and layout contract *(method)*

```text
hidden states x[M,K] bf16, stride=(K,1)  -> per_token_quant_int8
x_q[M,K] int8, stride=(K,1); x_scale[M,1] fp32 contiguous

checkpoint weight[N,K] int8 contiguous, stride=(K,1)
    -> layer.weight = weight.t()                  (Triton fallback layout)
    -> one-time contiguous() -> HIP weight[K,N], stride=(N,1)
```

- Keep the original transposed view for a safe fallback; register the contiguous
  HIP buffer separately. **Never** replace `layer.weight.data` with the copy --
  that changes the fallback layout and was observed to regress TTFT.
- Packed, shape-specific weight layouts are allowed as long as packing is
  one-time, outside the timed region and outside Graph capture, keeps the same
  byte count and buffer (graph-stable addresses), and correctness is checked
  against the raw logical `[K,N]` weight.

## 3. DUMMA and epilogue rules *(method)*

gfx928 wavefront = 64, so block sizes are multiples of 64. INT8 primitive:

```text
int8 x int8 -> int32, m16n16k32
```

1. `du_fill_fragment(acc, 0)` before the K loop.
2. Load A/B with `du_load_matrix_sync`, accumulate with `du_mma_sync`.
3. `du_store_matrix_sync` takes an accumulator fragment, not a raw array.
4. When materializing C in LDS, pass a scalar pointer (`&smem_c[0][0]`) and
   synchronize before other lanes read it.
5. The direct epilogue ownership on gfx928 is `row = lane & 15`,
   `col_mod4 = lane >> 4`, `frag.x[i]` -> columns `col_mod4 + 4*i`. Re-derive it
   if you change architecture or fragment type.

Direct fragment epilogues remove an accumulator LDS round trip and a barrier --
prefer them once verified.

### 3.1 ISA as an acceptance test, not a design tool *(method)*

Save the exact code object used for timing, find the exact template symbol, then
check load/MMAC/wait/LDS-store order and read VGPR/SGPR/LDS/scratch/spill from
the metadata. Reject a candidate whose compiler removed a required load, moved a
wait before MMAC, spilled prefetched values, or silently changed cache
semantics. Use raw inline asm only for a minimal, already-verified operation.
Re-run exact correctness, Graph replay, median and P90 after every ISA change.

## 4. Graph-safe PyTorch interface *(method)*

```python
gemm_out(x_q, packed_weight, x_scale, weight_scale, out)
gemm_out_optimized(x_q, packed_weight, x_scale, weight_scale, out, workspace)
gemm_out_prefill(x_q, packed_weight, x_scale, weight_scale, out)
```

Build/load the extension and allocate output/workspace **before** capture;
launch on `at::cuda::getCurrentCUDAStream(device)`. Inside capture: no stream
creation, no sync, no allocation, no autotune, no weight preprocessing, no CPU
reads of GPU values, no address changes. The launcher is shape validation +
static dispatch + async launches only.

## 5. SGLang integration *(method; paths differ on this board)*

```text
CompressedTensorsW8A8Int8.process_weights_after_loading()
    -> prepare_dcu_w8a8_layer(): keep transposed fallback, create contiguous
       HIP weight + workspace once
CompressedTensorsW8A8Int8.apply_weights()
    -> per_token_quant_int8(x) -> try_dcu_w8a8(M<=32: gemm_out_optimized /
       M>32: gemm_out_prefill / unsupported: None) -> Triton fallback
```

The liquid edition lists `/workspace/...` container paths from that board; on
this machine confirm the actual locations before relying on them. New-path
enablement is opt-in (`SGLANG_USE_ZTH_W8A8_GEMM=1` + `PYTHONPATH`), and any
unsupported condition must return `None` and keep the stock SGLang path.

## 6. Fair benchmarking *(method)*

Keep three scopes apart: (1) the existing Python operator, which may include
allocation and extra fill kernels; (2) the fair `gemm_out` with preallocated
output, timing every kernel needed for the final bf16 output; (3) PMC samples,
which are **diagnostic only** -- profiled time is never the score.

```text
excluded: input quantization, weight preprocessing, output allocation/clear
included: GEMM, scale + bf16 epilogue, split-K combine
```

Use unprofiled GPU events; report eager and Graph separately; never compare HIP
Graph against Triton eager. Identical warmups, samples, launches/sample, inputs,
output ownership and cache policy. Stable hot-cache protocol: warmups 50,
samples 50-100, launches/sample 20, report median + p90 + min.

Derived TOPS/bandwidth are logical rates (`2*M*N*K / median`), not measured HBM
traffic; use PMC `vmem_read` for real global reads.

## 7. Correctness and acceptance (shared) *(method)*

1. Compare against the reference for every requested shape.
2. Extreme int8 values and random values.
3. M = 1/2/4/8/16, tails such as 65, and the actual prefill M.
4. Exact bf16 equality when the int32 accumulation order is identical;
   otherwise define and justify a tolerance.
5. Capture Graph, update static input contents, replay, compare again.
6. Verify current-stream behaviour and absence of hidden synchronization.
7. Fair unprofiled median/P90, then PMC to explain it.
8. SGLang fallback tests plus a representative end-to-end workload.

After a killed round, restore the accepted source to its recorded digest before
the next experiment. A proposal that fails to compile is a candidate/infra
failure -- never evidence that templates/DUMMA/INT8 are unsupported.

## 8. Guardrails *(method)*

- Do not mutate the original transposed weight into contiguous storage.
- Do not count deleting `torch.zeros` as kernel acceleration.
- Do not use PMC time as final latency.
- No JIT/autotune/allocation/preprocessing/CPU reads/synchronization in capture.
- Do not call logical bytes/time "physical HBM bandwidth".
- A source change with stale profile data is not evidence.
- For M >= 3072 the CPU int64 exact reference is extremely slow; the control
  plane pre-seeds it once per shape (`w8a8_bench.py --prepare-reference`) --
  never run a large-M correctness check without the reference cache present.

## 9. This board's own facts *(air measured)*

- **Baseline table**: `baselines/air-k100ai.json` -- 219 shapes (209 Graph + 10
  TP8), aligned one-for-one with the reference board's, per-shape median of
  three independent passes (pass-to-pass median dispersion 0.72%).
- **Where the pain is**: on the TP8 M=8 family (same script and protocol on both
  sides) this board is 1.06-1.40x slower, worst on the small-K read-heavy shapes
  (`shared_down_proj` K=256: 1.399x; K=192: 1.379x) and mildest on the large-K
  compute-bound ones (`qkv_proj` K=6144: 1.059x). See
  `int8-w8a8-gemm-decode/references/air-measured-baselines.md`.
- **What that implies**: spend rounds on **longer contiguous reads** (chunked or
  contiguous weight layouts, merged/wider vector loads, one resident block
  reused) rather than on occupancy/tile/LDS micro-tuning, and do not spend any
  round on clocks, NUMA, affinity or co-tenant theories -- those cannot buy back
  a strided-read penalty.
- **Variant library**: `variant/air-k100ai/...` (this board's accepted kernels
  only, each stamped `hw_profile=air-k100ai machine=kme6 measured_on=...`). The
  liquid tree is a different library; its numbers are not comparable.

## 10. Open questions for this board

- Which shapes in the M=3072 / M=4096 prefill families recover most from
  contiguous-read restructuring? (No validated air recipe exists yet.)
- Does the M=8 decode penalty shrink once the kernel reads fewer, longer
  contiguous chunks? Measure both against the air baseline table.
- Anything found by a round here belongs in `variant/air-k100ai/` and, once
  published, in this air edition of the skill family -- not in the liquid one.
