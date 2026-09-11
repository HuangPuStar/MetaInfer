---
name: int8-w8a8-gemm-foundations
description: >
  Shared foundations for INT8 W8A8 GEMM on Hygon K500SM_AI/gfx928: operator
  and layout contracts, DUMMA/epilogue rules, Graph-safe PyTorch bindings,
  SGLang integration, fair benchmarking, and correctness gates. Always load
  this together with the phase skill: int8-w8a8-gemm-decode (M<=32) or
  int8-w8a8-gemm-prefill (M>32).
---

# INT8 W8A8 GEMM — Shared Foundations (gfx928 / SGLang TP4)

This skill records the implementation and evidence validated on worker29 with
DTK 26.04. It supersedes generic rules when the exact TP4 shapes below match.
Do not transfer measured latency or routing to another architecture, TP size,
DTK version, or weight layout without rerunning the benchmark.

## 0. Phase routing (read first)

The INT8 W8A8 GEMM skill family is split by execution phase because the two
regimes have non-transferable recipes, different bottlenecks, and different
acceptance protocols:

| M | Skill to load | Kernel family | Bottleneck |
|---|---|---|---|
| **M <= 32 (decode)** | `int8-w8a8-gemm-decode` | split-K partial + fused combine, small tiles | launch/latency-bound, µs-scale |
| **M > 32 (prefill)** | `int8-w8a8-gemm-prefill` | 2D M-tile, staged LDS, no split-K | LDS/compute-bound, ms-scale |

Load **this foundations skill together with the phase skill**. Recipes do NOT
transfer across the boundary: the M=16 decode kernel's direct-B-from-global
win does not transfer to prefill, and prefill's "no split-K" rule does not
apply to decode. M in (32, 128] is a measured-boundary gap (validated decode
covers M<=16, validated prefill starts at M=3072): route by measurement and
keep both a staged prefill arm and a decode-compatible arm until measured.

## 1. Operator Contract

```text
x_q[M,K] int8 @ weight[K,N] int8
    -> accumulator[M,N] int32
    -> accumulator * x_scale[M,1] * weight_scale[N,1].T
    -> out[M,N] bf16
```

The timed GEMM includes integer accumulation, both scales, bf16 conversion,
and output writeback. It excludes activation quantization, weight
preprocessing, tensor allocation, output clearing, JIT compilation, and
Graph capture.

Target TP4 shapes:

| Layer | K | N |
|---|---|---:|
| wqkv_a | 4096 | 1536 |
| wq_b / indexer.wq_b | 1024 | 8192 |
| wo_b | 2048 | 4096 |
| shared gate_up_proj | 4096 | 1024 |
| shared down_proj | 512 | 4096 |

All target K values are divisible by 128 and all N values by 64.

The M=4096 chunked-prefill family adds four fixed-M shapes (see
`int8-w8a8-gemm-prefill`): `hy3_tp4_qkv_proj_m4096` (M,N,K = 4096,2560,4096),
`hy3_tp4_o_proj_m4096` (4096,4096,2048),
`hy3_tp4_shared_gate_up_proj_m4096` (4096,768,4096), and
`hy3_tp4_shared_down_proj_m4096` (4096,4096,384).

## 2. Shape and Layout Contract

SGLang data flow:

```text
hidden states x[M,K] bf16, stride=(K,1)
    -> per_token_quant_int8
x_q[M,K] int8, stride=(K,1)
x_scale[M,1] fp32, contiguous
```

Checkpoint and runtime weight flow:

```text
checkpoint weight[N,K] int8, contiguous, stride=(K,1)
    -> layer.weight = weight.t()
SGLang Triton weight[K,N], non-contiguous, stride=(1,K)
    -> one-time contiguous() after loading
HIP weight[K,N], contiguous, stride=(N,1)
```

Keep both layouts:

- Preserve `layer.weight` as the original transposed view for safe fallback.
- Register a non-persistent contiguous HIP buffer once after checkpoint load.
- Never replace `layer.weight.data` with the contiguous copy. Doing so changes
  the Triton fallback layout and was observed to regress TTFT.
- Weight preprocessing is allowed by the task and must remain outside timed
  execution and Graph capture.

For the M=4096 lineage the packed weight layout is shape-specific and opaque
(o_proj: `[N/64, K, 64]` int8 panels; gate_up: `[K,N]→[N,K]` transpose;
down_proj: n-major `packed[n][k]`; qkv: n-major `packed[n][k]` for
(k,n)==(4096,2560)); packing is one-time, out-of-timed-region, out-of-Graph,
keeps the same byte count and buffer (graph-stable addresses unchanged), and
correctness is always checked against the raw logical `[K,N]` weight.

## 3. DUMMA and Epilogue Rules

gfx928 uses wavefront=64. Block size must be a multiple of 64.

For INT8, the supported primitive is:

```text
int8 x int8 -> int32, m16n16k32
```

API rules:

1. `du_fill_fragment(acc, 0)` before the K loop.
2. Load matrix A/B with `du_load_matrix_sync`.
3. Accumulate with `du_mma_sync`.
4. `du_store_matrix_sync` accepts an accumulator fragment, not a raw array.
5. If materializing C in LDS, pass a scalar pointer such as
   `&smem_c[0][0]` and synchronize before other lanes read it.
6. A direct epilogue may use the verified gfx928 accumulator ownership:
   `row=lane&15`, `col_mod4=lane>>4`, `frag.x[i]` maps to columns
   `col_mod4+4*i`. Re-derive this mapping when changing architecture or
   fragment type.

Prefer direct fragment epilogues when they are verified: they remove the
accumulator LDS round trip and one barrier. For the final non-split `wo_b`
kernel, the resource report was 40 VGPR, 32 SGPR, 6144 bytes LDS, and zero
scratch.

### 3.1 ISA use for memory-compute overlap

Use ISA as an acceptance test after HIP/DUMMA architecture choices have been
measured, not as a substitute for tile and stage exploration:

1. Save the exact gfx928 code object used by the timing run.
2. Locate the exact template symbol; do not disassemble a stale sibling.
3. Check load/MMAC/wait/LDS-store order in the steady-state stage.
4. Read VGPR, SGPR, LDS, scratch, and spill fields from code-object metadata.
5. Reject a candidate if the compiler removes a required load, moves the wait
   before MMAC, spills prefetched values, or changes cache semantics silently.
6. Use raw inline assembly only for a minimal operation whose constraint and
   hazard behavior is already verified on the current DTK/gfx928 toolchain.
7. Re-run exact correctness, Graph replay with changed contents, median, and
   P90 after every ISA-level change.

For large-M prefill, prefer HIP/DUMMA for loads and MMAC. The accepted raw asm
is limited to `s_waitcnt vmcnt(0)` before alternate-LDS writes and the
validated LDS-ready sequence `s_waitcnt lgkmcnt(0); s_barrier`. Do not copy
raw global-load/store or raw MMAC templates without a lane-layout microtest.

## 4. Graph-Safe PyTorch Interface

Preferred API:

```python
gemm_out(x_q, packed_weight, x_scale, weight_scale, out)
gemm_out_optimized(
    x_q, packed_weight, x_scale, weight_scale, out, workspace
)
gemm_out_prefill(x_q, packed_weight, x_scale, weight_scale, out)
```

Requirements:

- Build/load the extension before capture.
- Allocate output and workspace before capture for the low-level interface.
- Launch on `at::cuda::getCurrentCUDAStream(device)`.
- Do not create streams, synchronize, allocate device memory, autotune,
  preprocess weights, inspect GPU values on the CPU, or change tensor
  addresses inside capture.
- The launcher should contain only shape validation, static dispatch, and
  asynchronous kernel launches.
- A Graph replay may update tensor contents but not captured addresses or
  shapes.

Python exposure:

```text
w8a8_gemm.py
  -> torch.utils.cpp_extension.load (before capture)
  -> TORCH_LIBRARY / TORCH_LIBRARY_IMPL registration
  -> torch.ops.zth_w8a8.gemm_out*
  -> HIP launcher on current PyTorch stream
```

## 5. SGLang Integration

Integration flow:

```text
CompressedTensorsW8A8Int8.process_weights_after_loading()
    -> prepare_dcu_w8a8_layer()
    -> preserve transposed fallback weight
    -> create contiguous HIP weight/workspace once

CompressedTensorsW8A8Int8.apply_weights()
    -> per_token_quant_int8(x)
    -> try_dcu_w8a8(...)
       M<=32: gemm_out_optimized
       M>32 : gemm_out_prefill
       unsupported: return None
    -> existing Triton fallback
```

Files on worker29:

```text
/workspace/int8w8a8gemm/w8a8_gemm.py
/workspace/int8w8a8gemm/csrc/bindings.cpp
/workspace/int8w8a8gemm/csrc/w8a8_gemm_hip.hip
/workspace/sglang-v0.5.10_dpsk_v4/python/sglang/srt/layers/quantization/dcu_w8a8_gemm.py
/workspace/sglang-v0.5.10_dpsk_v4/python/sglang/srt/layers/quantization/compressed_tensors/schemes/compressed_tensors_w8a8_int8.py
```

Enable before server start:

```bash
export PYTHONPATH="/workspace/int8w8a8gemm:${PYTHONPATH:-}"
export SGLANG_USE_ZTH_W8A8_GEMM=1
```

Unsupported conditions must return `None` and retain the original SGLang
path. Current custom path excludes non-TP4 target K/N shapes, bias, non-bf16
output, wrong dtype/rank/scale shape, non-contiguous HIP buffers, and weights
that were not prepared.

## 6. Fair Benchmarking

Keep three scopes separate:

1. Existing Python operator: may include `torch.zeros`, allocation, and extra
   fill kernels.
2. Fair `gemm_out`: preallocated output; times all kernels needed to produce
   final bf16 output.
3. PMC kernel sample: diagnostic only; profiler timing is not the final score.

Formal fair baseline:

```text
input quantization       excluded
weight preprocessing     excluded
output allocation/clear  excluded
GEMM                     included
scale + bf16 epilogue    included
split-K combine          included
```

Use unprofiled GPU Events for acceptance. Report eager and Graph separately:

```text
Triton eager vs HIP eager
Triton Graph vs HIP Graph
```

Never compare HIP Graph against Triton eager. Use identical warmups, samples,
launches/sample, inputs, output ownership, and cache policy.

Recommended stable hot-cache protocol:

```text
warmups=50
samples=50 or 100
launches_per_sample=20
median + p90 + min
```

Use PMC after timing to explain VGPR/LDS/scratch, bank conflicts, MFMA use,
and cache behavior. Do not treat lower VGPR or bank conflicts alone as a
performance win. `lds_wait ≈ lds_instructions` alone is not a bottleneck
signal (true in accepted kernels too). Profiled durations are perturbed —
never use PMC time as the score. Derived TOPS / bandwidth numbers are
`2*M*N*K / median` style logical rates, not measured HBM traffic; use PMC
vmem_read for real global reads. Phase-specific acceptance protocols live in
the decode / prefill skills.

## 7. Correctness and Acceptance (shared)

Before accepting a variant:

1. Compare against the reference for all five TP4 shapes.
2. Test extreme int8 values and random values.
3. Test M=1/2/4/8/16, M tails such as 65, and actual prefill M=3072.
4. Require exact bf16 equality when comparing implementations with identical
   int32 accumulation order; otherwise define and justify tolerance.
5. Capture Graph, update static input contents, replay, and compare again.
6. Verify current stream behavior and absence of hidden synchronization.
7. Run fair unprofiled median/P90.
8. Then use hipprof/PMC to explain the result.
9. Run SGLang fallback tests and a representative end-to-end workload.

After a killed/aborted round, restore the accepted source to its recorded
digest before the next experiment. `hipLaunchKernelGGL` +
`HIP_KERNEL_NAME(templated<...>)` is valid and used by every accepted kernel;
compile failures of a proposal are candidate/infra failures, never evidence
that templates/DUMMA/INT8 are unsupported.

Relevant tests:

```bash
HIP_VISIBLE_DEVICES=0 python /workspace/int8w8a8gemm/tests/test_correctness_graph.py --full --m 16
HIP_VISIBLE_DEVICES=0 python /workspace/int8w8a8gemm/tests/test_sglang_integration.py
HIP_VISIBLE_DEVICES=0 python /workspace/int8w8a8gemm/tests/benchmark_prefill.py --case tp4_decode --m 3072
```

## 8. Shared Guardrails (rejected evidence)

- Do not mutate the original SGLang transposed weight into contiguous storage;
  it silently changes fallback performance.
- Do not count deletion of `torch.zeros` as GEMM kernel acceleration.
- Do not use PMC time as final latency.
- Do not perform JIT, autotuning, allocation, preprocessing, CPU reads, or
  synchronization during Graph capture.
- Do not call event-derived logical bytes/time "physical HBM bandwidth".
  Report it as program-level logical request bandwidth unless PMC and a
  cache-cold protocol prove actual HBM bytes.
- A source change with unchanged/stale profile data is not evidence. Confirm
  the code object/source digest and rerun unprofiled timing.
- Reference cache: for M>=3072 the CPU int64 exact reference takes ~10+
  minutes (torch.mm int64 at ~0.2 GFLOPS). The control plane pre-seeds it
  once per shape (`w8a8_bench.py --prepare-reference`, 3600s budget) before
  the timed benchmark; never re-run a correctness check without the reference
  cache present, or the 900s subprocess budget is blown.

## 9. End-to-end evidence

TP4 test service with `num_hidden_layers=5`, chunked prefill size 3072,
16 prompts, 20k input, 64 output, max concurrency 16, warmup requests 0:

| Metric | Original | HIP decode+prefill | Change |
|---|---:|---:|---:|
| duration | 79.03 s | 52.20 s | -33.9% |
| mean TTFT | 41.81 s | 27.09 s | -35.2% |
| mean TPOT | 590.3 ms | 398.1 ms | -32.6% |
| input throughput | 4049 tok/s | 6130 tok/s | 1.51x |

This is a five-layer validation service, not full 43-layer model performance.
