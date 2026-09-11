#!/usr/bin/env python3
"""Fair Triton W8A8 GEMM baselines for the model-catalog TP8 shapes at M=4096.

Same protocol as bench_triton_tp4_m4096.py / the 2026-08-12 catalog entries:
lmslim-style int8_utils.matmul_kernel into a preallocated bf16 output (output
allocation/clear excluded), GPU events, hot cache, CUDA-Graph replay,
warmups=10 / samples=20 / launches_per_sample=5. Reports median/P90/min in
microseconds.

Triton config replicates matmul_int8's built-in default for M > 1024:
    BLOCK_SIZE_M=256, BLOCK_SIZE_N=256, BLOCK_SIZE_K=64,
    GROUP_SIZE_M=8, SPLIT_K=1, num_stages=0, num_warps=8
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import statistics
import sys
from pathlib import Path

import torch
import triton


UTILS_PATH = str(Path(__file__).resolve().parent / "int8_utils.py")
M = 4096

# (shape_id, operator, K, N) -- Hy3 / MiniMax M3 / GLM5.2 TP8 at M=4096.
TP8_CASES = [
    ("hy3_tp8_qkv_proj_m4096", "qkv_proj", 4096, 1280),
    ("hy3_tp8_o_proj_m4096", "o_proj", 1024, 4096),
    ("hy3_tp8_shared_gate_up_proj_m4096", "shared_gate_up_proj", 4096, 384),
    ("hy3_tp8_shared_down_proj_m4096", "shared_down_proj", 192, 4096),
    ("minimax_tp8_qkv_proj_m4096", "qkv_proj", 6144, 1280),
    ("minimax_tp8_qkv_proj_and_indexer_qk_m4096", "qkv_proj_and_indexer_qk", 6144, 1536),
    ("minimax_tp8_o_proj_m4096", "o_proj", 1024, 6144),
    ("minimax_tp8_shared_gate_up_proj_m4096", "shared_gate_up_proj", 6144, 768),
    ("minimax_tp8_shared_down_proj_m4096", "shared_down_proj", 384, 6144),
    ("glm52_tp8_fused_qkv_a_proj_m4096", "fused_qkv_a_proj", 6144, 2624),
    ("glm52_tp8_q_b_proj_m4096", "q_b_proj", 2048, 2048),
    ("glm52_tp8_kv_b_proj_m4096", "kv_b_proj", 512, 3584),
    ("glm52_tp8_o_proj_m4096", "o_proj", 2048, 6144),
    ("glm52_tp8_shared_gate_up_proj_m4096", "shared_gate_up_proj", 6144, 512),
    ("glm52_tp8_shared_down_proj_m4096", "shared_down_proj", 256, 6144),
]

# Exact default config used by matmul_int8 when M > 1024.
CONFIG = {
    "BLOCK_SIZE_M": 256,
    "BLOCK_SIZE_N": 256,
    "BLOCK_SIZE_K": 64,
    "GROUP_SIZE_M": 8,
    "SPLIT_K": 1,
    "num_stages": 0,
    "num_warps": 8,
}


def load_int8_utils(path: str):
    spec = importlib.util.spec_from_file_location(
        "baseline_int8_utils", path
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def launch(out, a, a_scale, b, b_scale, m, n, k, utils) -> None:
    grid = (
        triton.cdiv(m, CONFIG["BLOCK_SIZE_M"])
        * triton.cdiv(n, CONFIG["BLOCK_SIZE_N"]),
        CONFIG["SPLIT_K"],
    )
    utils.matmul_kernel[grid](
        a,
        a_scale,
        b,
        b_scale,
        out,
        m,
        n,
        k,
        a.stride(0),
        a.stride(1),
        a_scale.stride(0),
        b.stride(0),
        b.stride(1),
        b_scale.stride(0),
        out.stride(0),
        out.stride(1),
        **CONFIG,
    )


def percentile(values, fraction):
    ordered = sorted(values)
    return ordered[max(0, math.ceil(fraction * len(ordered)) - 1)]


def measure(fn, warmups, samples, launches_per_sample):
    for _ in range(warmups):
        fn()
    torch.cuda.synchronize()

    start = torch.cuda.Event(enable_timing=True)
    end = torch.cuda.Event(enable_timing=True)
    times_us = []
    for _ in range(samples):
        start.record()
        for _ in range(launches_per_sample):
            fn()
        end.record()
        end.synchronize()
        times_us.append(
            start.elapsed_time(end) * 1000.0 / launches_per_sample
        )
    return {
        "median_us": statistics.median(times_us),
        "p90_us": percentile(times_us, 0.90),
        "min_us": min(times_us),
        "max_us": max(times_us),
        "samples_us": [round(v, 3) for v in times_us],
    }


def run_case(utils, case_id, operator, k, n, warmups, samples,
             launches_per_sample, mode):
    device = torch.device("cuda:0")
    torch.manual_seed(20260724 + M + n + k)
    a = torch.randint(-127, 128, (M, k), device=device, dtype=torch.int8)
    b = torch.randint(-127, 128, (k, n), device=device, dtype=torch.int8)
    a_scale = torch.rand((M, 1), device=device, dtype=torch.float32) + 0.01
    b_scale = torch.rand((n, 1), device=device, dtype=torch.float32) + 0.01
    out = torch.empty((M, n), device=device, dtype=torch.bfloat16)

    fn = lambda: launch(out, a, a_scale, b, b_scale, M, n, k, utils)

    # One untimed JIT compile pass (correctness is the production Triton path).
    fn()
    torch.cuda.synchronize()

    result = {
        "shape_id": case_id,
        "operator": operator,
        "M": M,
        "N": n,
        "K": k,
        "config": CONFIG,
    }
    if mode in ("eager", "both"):
        result["eager"] = measure(
            fn, warmups, samples, launches_per_sample
        )
    if mode in ("graph", "both"):
        fn()
        torch.cuda.synchronize()
        graph = torch.cuda.CUDAGraph()
        with torch.cuda.graph(graph):
            fn()
        torch.cuda.synchronize()
        result["graph"] = measure(
            graph.replay, warmups, samples, launches_per_sample
        )
        del graph

    del a, b, a_scale, b_scale, out
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--utils", default=UTILS_PATH)
    parser.add_argument("--warmups", type=int, default=10)
    parser.add_argument("--samples", type=int, default=20)
    parser.add_argument("--launches-per-sample", type=int, default=5)
    parser.add_argument("--mode", choices=["eager", "graph", "both"],
                        default="graph")
    parser.add_argument("--json", type=str, default="")
    args = parser.parse_args()

    utils = load_int8_utils(args.utils)
    print(
        "BENCHMARK triton=int8_utils.matmul_kernel output=preallocated "
        f"quantization=excluded allocation=excluded epilogue=included "
        f"M={M} config={json.dumps(CONFIG)} mode={args.mode}",
        flush=True,
    )
    print(
        f"{'shape_id':42s} {'N':5s} {'K':5s} {'graph_us':>10s} "
        f"{'p90_us':>10s} {'tops':>9s}",
        flush=True,
    )
    results = []
    for case_id, operator, k, n in TP8_CASES:
        res = run_case(
            utils,
            case_id,
            operator,
            k,
            n,
            args.warmups,
            args.samples,
            args.launches_per_sample,
            args.mode,
        )
        results.append(res)
        graph_us = (res.get("graph") or res.get("eager") or {}).get("median_us")
        p90_us = (res.get("graph") or res.get("eager") or {}).get("p90_us")
        tops = (
            2.0 * M * n * k / (graph_us * 1e-6) / 1e12
            if graph_us else None
        )
        print(
            f"{case_id:42s} {n:5d} {k:5d} "
            f"{graph_us:>10.3f} {p90_us:>10.3f} "
            f"{(f'{tops:.3f}' if tops else '—'):>9s}",
            flush=True,
        )
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(results, fh, indent=2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
