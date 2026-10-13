# Air-board (K100_AI / DEV-AI) measured Triton Graph baselines

Generated from `metainfer/tasks/dcu_kernel_auto_opt/baselines/air-k100ai.json`
(profile `air-k100ai`, machine `kme6`, measured 2026-09-29, per-shape median of
three independent passes of `lmslim int8_utils.matmul_kernel` = the production
W8A8 Triton baseline; GPU events, CUDA-Graph replay, hot cache).

Look any shape up with the same resolver the task uses (never by eye):

```python
from metainfer.tasks.dcu_kernel_auto_opt.orchestrator.w8a8_baselines import (
    fixed_triton_graph_baseline,
)
rec = fixed_triton_graph_baseline("<shape_id>",
                                  {"tp_size": 8, "M": 8, "N": 1280, "K": 6144})
rec["median_us"], rec["baseline_profile"], rec["profile_mismatch"]
# -> 104.736, 'air-k100ai', False        (profile_mismatch=True would mean the
#    number is the OTHER board's: it must then never become a speedup)
```

**These are the numbers for this board.** The liquid board's equivalents live in
`baselines/liquid-k500sm.json` and are NOT transferable: the ratio is 1.06-1.70x
and differs per operator (see the ratio column, and the reading rules below).

## TP=8, M=3072 (chunked prefill)

| operator | N | K | air median µs | air p90 µs |
|---|---:|---:|---:|---:|
| `fused_qkv_a_proj` | 2624 | 6144 | **41974.5** | — |
| `o_proj` | 6144 | 2048 | **35178.5** | — |
| `indexer.wq_b` | 8192 | 1024 | **23560.9** | 23584.6 |
| `qkv_proj_and_indexer_qk` | 1536 | 6144 | **19368** | — |
| `o_proj` | 6144 | 1024 | **18312.3** | — |
| `qkv_proj` | 1280 | 6144 | **16478.8** | — |
| `wqkv_a` | 1536 | 4096 | **13980.8** | 14037.7 |
| `qkv_proj` | 1280 | 4096 | **11585.8** | — |
| `wq_b_or_wo_b` | 4096 | 1024 | **11440.1** | 11474.1 |
| `q_b_proj` | 2048 | 2048 | **10070.1** | — |
| `shared_gate_up_proj` | 768 | 6144 | **9610.36** | — |
| `shared_down_proj` | 6144 | 384 | **7942.94** | — |
| `shared_gate_up_proj` | 512 | 6144 | **6326.73** | — |
| `shared_down_proj` | 6144 | 256 | **6042.75** | — |
| `kv_b_proj` | 3584 | 512 | **5548.28** | — |
| `shared_gate_up` | 512 | 4096 | **4422.59** | 4432.99 |
| `shared_gate_up_proj` | 384 | 4096 | **4411.61** | — |
| `shared_down` | 4096 | 256 | **4100.32** | 4130.3 |
| `shared_down_proj` | 4096 | 192 | **3478.65** | — |

## TP=8, M=4096 (chunked prefill)

⚠️ For this family the *reference* rows are single-pass and one of them was visibly disturbed by a co-tenant, so cross-board ratios are meaningless here (they even read as "air is faster"). Use the air column only, and prefer re-measuring both sides on one image before quoting any gap.

| operator | N | K | air median µs | air p90 µs |
|---|---:|---:|---:|---:|
| `fused_qkv_a_proj` | 2624 | 6144 | **57764.7** | — |
| `o_proj` | 6144 | 2048 | **45946.1** | — |
| `qkv_proj_and_indexer_qk` | 1536 | 6144 | **28560.4** | — |
| `o_proj` | 6144 | 1024 | **23849.3** | — |
| `qkv_proj` | 1280 | 6144 | **22144** | — |
| `qkv_proj` | 1280 | 4096 | **16439.4** | — |
| `o_proj` | 4096 | 1024 | **16403.5** | — |
| `q_b_proj` | 2048 | 2048 | **14312.8** | — |
| `shared_gate_up_proj` | 768 | 6144 | **12796.7** | — |
| `shared_down_proj` | 6144 | 384 | **10430.3** | — |
| `shared_gate_up_proj` | 512 | 6144 | **8613.86** | — |
| `shared_down_proj` | 6144 | 256 | **7961.13** | — |
| `kv_b_proj` | 3584 | 512 | **7722.22** | — |
| `shared_gate_up_proj` | 384 | 4096 | **5961.59** | — |
| `shared_down_proj` | 4096 | 192 | **4644.43** | — |

## Reading rules

1. **The air column is the baseline** for a same-board speedup on this board.
2. Do not quote a cross-board ratio for the prefill families: the reference
   rows come from different sessions, images and (for M=4096) a single pass.
3. M=3072 / M=4096 prefill kernels for this board have **no validated recipe
   yet** -- every "accepted architecture" ledger in the liquid edition was
   validated on the other board. Re-derive here and publish your own.
