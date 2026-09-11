---
name: int8-w8a8-quantized-gemm-optimization
description: >
  Router for the INT8 W8A8 GEMM skill family on Hygon K500SM_AI/gfx928.
  This skill is split by execution phase into three skills — load
  int8-w8a8-gemm-foundations plus the phase skill: int8-w8a8-gemm-decode
  (M<=32) or int8-w8a8-gemm-prefill (M>32). This router exists for backward
  compatibility; it carries no tuning content itself.
---

# INT8 W8A8 GEMM — skill family router

The former single "int8-w8a8-quantized-gemm-optimization" skill was split by
execution phase (2026-08-23) because decode and prefill have non-transferable
recipes, different bottlenecks, and different acceptance protocols. Load the
following instead:

| M | Load |
|---|---|
| M <= 32 (decode) | `int8-w8a8-gemm-decode` + `int8-w8a8-gemm-foundations` |
| M > 32 (prefill) | `int8-w8a8-gemm-prefill` + `int8-w8a8-gemm-foundations` |

- **int8-w8a8-gemm-foundations** — operator/layout contract, DUMMA and
  epilogue rules, Graph-safe PyTorch interface, SGLang integration, fair
  benchmarking, shared correctness gates and guardrails, E2E evidence.
- **int8-w8a8-gemm-decode** — split-K partial kernels + fused combine,
  M=1..16 validated recipes, M=16<M<=32 boundary guidance, µs-scale
  acceptance with noise tolerance, decode evidence and rejected ideas.
- **int8-w8a8-gemm-prefill** — 2D M-tile staged-LDS kernels, no split-K,
  M=3072 / M=4096 validated recipes and evidence, occupancy/LDS acceptance,
  prefill rejected ideas.

Routing boundary: **M <= 32 -> decode, M > 32 -> prefill**. M in (32, 128]
(decode side) and (32, 3072) (prefill side) are measured-boundary gaps — route
by measurement and keep both an arm per regime until measured.

No tuning content lives in this router; always load the foundations skill plus
the matching phase skill.
