#!/usr/bin/env python3
"""Fair Triton W8A8 GEMM baseline for the six TP4 logical shapes at M=4096.

Timed region launches only lmslim-style int8_utils.matmul_kernel into a
preallocated bf16 output (output allocation/clear excluded), matching the
MetaInfer fair-baseline scope. Uses GPU events, hot cache, and reports
median/P90/min in microseconds plus effective INT8 TOPS.

The Triton config replicates matmul_int8's built-in default for M > 1024:
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

# (shape_id, operator, K, N) -- the six TP4 logical operators.
TP4_CASES = [
    ("tp4_wqkv_a_m4096", "wqkv_a", 4096, 1536),
    ("tp4_wq_b_m4096", "wq_b", 1024, 8192),
    ("tp4_indexer_wq_b_m4096", "indexer.wq_b", 1024, 8192),
    ("tp4_wo_b_m4096", "wo_b", 2048, 4096),
    ("tp4_shared_gate_up_proj_m4096", "shared_gate_up_proj", 4096, 1024),
    ("tp4_shared_down_proj_m4096", "shared_down_proj", 512, 4096),
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


@torch.no_grad()
def reference_us(a, b, a_scale, b_scale, device):
    dot = torch.mm(
        a.to("cpu", dtype=torch.int64),
        b.to("cpu", dtype=torch.int64),
    )
    scaled = (
        dot.to(torch.float32)
        * a_scale.to("cpu", dtype=torch.float32)
        * b_scale.to("cpu", dtype=torch.float32).T
    )
    return scaled.to(torch.bfloat16).to(device)


def run_case(utils, case_id, operator, k, n, warmups, samples,
             launches_per_sample, skip_check, mode):
    device = torch.device("cuda:0")
    torch.manual_seed(20260724 + M + n + k)
    a = torch.randint(-127, 128, (M, k), device=device, dtype=torch.int8)
    b = torch.randint(-127, 128, (k, n), device=device, dtype=torch.int8)
    a_scale = torch.rand((M, 1), device=device, dtype=torch.float32) + 0.01
    b_scale = torch.rand((n, 1), device=device, dtype=torch.float32) + 0.01
    out = torch.empty((M, n), device=device, dtype=torch.bfloat16)

    fn = lambda: launch(out, a, a_scale, b, b_scale, M, n, k, utils)

    # One untimed JIT compile + correctness sanity pass.
    fn()
    torch.cuda.synchronize()
    errors = None
    if not skip_check:
        ref = reference_us(a, b, a_scale, b_scale, device)
        diff = (out.float() - ref.float()).abs()
        denom = ref.float().abs().clamp_min(1e-6)
        errors = {
            "max_abs": float(diff.max().item()),
            "max_rel": float((diff / denom).max().item()),
            "mismatch_count": int((out != ref).sum().item()),
        }
        del ref

    result = {
        "shape_id": case_id,
        "operator": operator,
        "M": M,
        "N": n,
        "K": k,
        "config": CONFIG,
        "errors": errors,
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
                        default="both")
    parser.add_argument("--skip-check", action="store_true")
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
        f"{'shape_id':28s} {'N':5s} {'K':5s} {'eager_us':>10s} "
        f"{'graph_us':>10s} {'tops':>9s}",
        flush=True,
    )
    results = []
    for case_id, operator, k, n in TP4_CASES:
        res = run_case(
            utils,
            case_id,
            operator,
            k,
            n,
            args.warmups,
            args.samples,
            args.launches_per_sample,
            args.skip_check,
            args.mode,
        )
        results.append(res)
        eager_us = res.get("eager", {}).get("median_us")
        graph_us = res.get("graph", {}).get("median_us")
        tops = (
            2.0 * M * n * k / ((graph_us or eager_us) * 1.0e-6) / 1.0e12
            if (graph_us or eager_us) else float("nan")
        )
        print(
            f"{case_id:28s} {n:5d} {k:5d} "
            f"{(eager_us if eager_us is not None else float('nan')):10.3f} "
            f"{(graph_us if graph_us is not None else float('nan')):10.3f} "
            f"{tops:9.3f}",
            flush=True,
        )
        for key in ("eager", "graph"):
            if key in res:
                m_ = res[key]
                print(
                    f"  {key}: median={m_['median_us']:.3f}us "
                    f"p90={m_['p90_us']:.3f}us min={m_['min_us']:.3f}us "
                    f"max={m_['max_us']:.3f}us errors={res['errors']}",
                    flush=True,
                )
    if args.json:
        with open(args.json, "w", encoding="utf-8") as handle:
            json.dump(
                {
                    "scope": "gemm_out",
                    "triton_source": args.utils,
                    "M": M,
                    "warmups": args.warmups,
                    "samples": args.samples,
                    "launches_per_sample": args.launches_per_sample,
                    "mode": args.mode,
                    "results": results,
                },
                handle,
                indent=2,
                ensure_ascii=False,
            )
        print(f"wrote {args.json}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
