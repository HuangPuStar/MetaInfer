---
name: int8-w8a8-quantized-gemm-optimization
description: >
  Router for the INT8 W8A8 GEMM skill family on the AIR-COOLED Hygon K100_AI
  (gfx928, no HBM address hashing). Load int8-w8a8-gemm-foundations plus the
  phase skill: int8-w8a8-gemm-decode (M<=32) or int8-w8a8-gemm-prefill (M>32).
  This router carries no tuning content itself.
---

<!-- metainfer-edition: air-k100ai -->

# INT8 W8A8 GEMM — skill family router (air board: K100_AI / DEV-AI)

The installed editions of this family are this board's (`air-k100ai`, machine
`kme6`). The liquid board's editions are a **separate library**, kept under
`skills/liquid-k500sm/` in the plugin and not installed on this machine: their
measurements were taken with HBM address hashing on and are 1.06-1.70x apart
from this board's, per operator.

| M | Load |
|---|---|
| M <= 32 (decode) | `int8-w8a8-gemm-decode` + `int8-w8a8-gemm-foundations` |
| M > 32 (prefill) | `int8-w8a8-gemm-prefill` + `int8-w8a8-gemm-foundations` |

- **int8-w8a8-gemm-foundations** — operator/layout contract, DUMMA and epilogue
  rules, Graph-safe interface, SGLang integration, fair benchmarking, shared
  correctness gates, this board's measured facts.
- **int8-w8a8-gemm-decode** — split-K partial + fused combine, small-M paths,
  µs-scale acceptance with noise tolerance, and this board's TP8 M=8 / M=16
  baselines in `references/`.
- **int8-w8a8-gemm-prefill** — 2D M-tile staged-LDS kernels, no split-K,
  occupancy/LDS acceptance, and this board's TP8 M=3072 / M=4096 baselines.

Routing boundary: **M <= 32 -> decode, M > 32 -> prefill**; the in-between range
is an unmeasured gap on this board -- route by measurement and keep one arm per
regime.

No tuning content lives in this router. Every number you rely on must come from
this board: `baselines/air-k100ai.json`, `variant/air-k100ai/`, or your own
rounds.
