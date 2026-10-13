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

## TP=8, M=8 (decode; this board vs the reference board)

This is the one family where the two sides were measured with the same script and protocol, so the ratio is quotable **as a direction** (read-heavy, small-K shapes suffer most). It is still not a conversion factor for other shapes.

| operator | N | K | air median µs | air p90 µs | liquid µs | air/liquid |
|---|---:|---:|---:|---:|---:|---:|
| `qkv_proj_and_indexer_qk` | 1536 | 6144 | **106.032** | — | 99.473 | 1.066 |
| `qkv_proj` | 1280 | 6144 | **104.736** | — | 98.865 | 1.059 |
| `shared_gate_up_proj` | 768 | 6144 | **100.336** | — | 92.928 | 1.080 |
| `shared_gate_up_proj` | 512 | 6144 | **97.584** | — | 88.448 | 1.103 |
| `fused_qkv_a_proj` | 2624 | 6144 | **94.768** | — | 87.2 | 1.087 |
| `qkv_proj` | 1280 | 4096 | **80.768** | — | 66.432 | 1.216 |
| `o_proj` | 6144 | 2048 | **66.96** | — | 58.864 | 1.138 |
| `shared_gate_up_proj` | 384 | 4096 | **63.824** | — | 57.008 | 1.120 |
| `q_b_proj` | 2048 | 2048 | **43.84** | — | 36.704 | 1.194 |
| `o_proj` | 4096 | 1024 | **39.936** | — | 31.472 | 1.269 |
| `o_proj` | 6144 | 1024 | **39.52** | — | 32.96 | 1.199 |
| `shared_down_proj` | 6144 | 384 | **25.936** | — | 19.984 | 1.298 |
| `kv_b_proj` | 3584 | 512 | **21.408** | — | 15.808 | 1.354 |
| `shared_down_proj` | 6144 | 256 | **21.168** | — | 15.136 | 1.399 |
| `shared_down_proj` | 4096 | 192 | **20.128** | — | 14.592 | 1.379 |

## TP=8, M=16 (decode)

Reference rows for this family come from other sessions/images, so no ratio is shown: use the air column only.

| operator | N | K | air median µs | air p90 µs |
|---|---:|---:|---:|---:|
| `qkv_proj_and_indexer_qk` | 1536 | 6144 | **107.56** | — |
| `qkv_proj` | 1280 | 6144 | **106.732** | — |
| `shared_gate_up_proj` | 768 | 6144 | **99.984** | — |
| `fused_qkv_a_proj` | 2624 | 6144 | **96.848** | — |
| `shared_gate_up_proj` | 512 | 6144 | **94.112** | — |
| `wqkv_a` | 1536 | 4096 | **79.084** | 79.936 |
| `qkv_proj` | 1280 | 4096 | **77.368** | — |
| `shared_gate_up` | 512 | 4096 | **69.92** | 70.576 |
| `shared_gate_up_proj` | 384 | 4096 | **66.552** | — |
| `o_proj` | 6144 | 2048 | **63.532** | — |
| `indexer.wq_b` | 8192 | 1024 | **61.708** | 62.448 |
| `q_b_proj` | 2048 | 2048 | **44.604** | — |
| `wq_b_or_wo_b` | 4096 | 1024 | **41.012** | 41.696 |
| `o_proj` | 6144 | 1024 | **39.528** | — |
| `shared_down_proj` | 6144 | 384 | **25.804** | — |
| `shared_down_proj` | 6144 | 256 | **21.804** | — |
| `shared_down` | 4096 | 256 | **21.056** | 22.736 |
| `kv_b_proj` | 3584 | 512 | **20.964** | — |
| `shared_down_proj` | 4096 | 192 | **20.02** | — |

## Reading rules

1. **The air column is the baseline** for a same-board speedup. It is what
   `baseline_us` in a promoted variant is computed against.
2. The ratio column answers "why is this board slower here", not "what will
   this kernel do after optimization" -- never multiply a liquid number by it.
3. Coverage: this profile has 219 shapes (209 Graph + 10 TP8), aligned
   one-for-one with the reference table. Any shape missing from it is
   **unmeasured on this board**; do not substitute the liquid value.
