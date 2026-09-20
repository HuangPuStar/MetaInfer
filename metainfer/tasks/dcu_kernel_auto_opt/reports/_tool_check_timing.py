#!/usr/bin/env python3
"""Validate the measurement methodology of the DKAO W8A8 harness.

Part 1: Large bf16 GEMM -> event timing (same pattern as w8a8_bench.py) vs
        torch.profiler GPU kernel time. For a ms-scale kernel the fixed
        per-replay overhead is negligible, so both must agree: this validates
        the event primitive + report formula on this platform.
Part 2: shared_down_proj (M16 N4096 K192) -> sweep replays_per_sample to expose
        the fixed per-replay overhead, and compare with the profiler kernel time.
"""
from __future__ import annotations

import importlib.util
import json
import os
import statistics
from pathlib import Path

import torch
from torch.profiler import ProfilerActivity, profile

WS = Path("/root/zth_agent/MetaInfer/nodes/worker29/workspaces/hy3-dsh-tp8-m16-9-8-0161e718")
ROOT = WS / "workers" / "worker_3"
SRC = ROOT / "source"
BUILD = json.loads((ROOT / "cache" / "current_build.json").read_text())
os.environ["METAINFER_W8A8_COMPILE_SOURCE_DIR"] = BUILD["compile_source_dir"]
os.environ["METAINFER_W8A8_BUILD_KEY"] = BUILD["build_key"]
os.environ["TORCH_EXTENSIONS_DIR"] = str(ROOT / "cache" / "torch")


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def event_timing(graph, samples: int, replays: int) -> tuple[float, float, float]:
    evs = [(torch.cuda.Event(True), torch.cuda.Event(True)) for _ in range(samples)]
    for s, e in evs:
        s.record()
        for _ in range(replays):
            graph.replay()
        e.record()
    torch.cuda.synchronize()
    per = [s.elapsed_time(e) * 1000.0 / replays for s, e in evs]
    per.sort()
    return statistics.median(per), per[0], per[int(0.9 * len(per)) - 1]


def profiler_kernel_us(graph, replays: int) -> float:
    with profile(activities=[ProfilerActivity.CUDA]) as prof:
        for _ in range(replays):
            graph.replay()
        torch.cuda.synchronize()
    total = 0.0
    for entry in prof.key_averages():
        total += float(getattr(entry, "self_device_time_total", 0.0) or 0.0)
    return total / replays


print("=" * 78)
print("PART 1: large bf16 GEMM 4096x4096x4096 (kernel >> launch overhead)")
print("=" * 78)
a = torch.randn(4096, 4096, dtype=torch.bfloat16, device="cuda")
b = torch.randn(4096, 4096, dtype=torch.bfloat16, device="cuda")
out = torch.empty(4096, 4096, dtype=torch.bfloat16, device="cuda")


def big() -> None:
    torch.matmul(a, b, out=out)


for _ in range(10):
    big()
torch.cuda.synchronize()
gbig = torch.cuda.CUDAGraph()
with torch.cuda.graph(gbig):
    big()
med, lo, p90 = event_timing(gbig, samples=5, replays=10)
ker = profiler_kernel_us(gbig, replays=10)
flops = 2.0 * 4096 ** 3
print("  event timing  : median %9.2f us  (min %.2f, p90 %.2f)" % (med, lo, p90))
print("  profiler      : kernel %9.2f us" % ker)
print("  difference    : %+0.2f%%  -> effective %.1f TFLOPS (bf16)" % (
    (med - ker) / ker * 100.0, flops / (med * 1e-6) / 1e12))

print()
print("=" * 78)
print("PART 2: hy3_tp8_shared_down_proj_m16 (M16 N4096 K192), worker_3 accepted build")
print("=" * 78)
bench = load_module(SRC / "w8a8_bench.py", "bench_mod")
backend = load_module(SRC / "w8a8_backend.py", "metainfer_w8a8_backend")
backend.load_extension()
api = load_module(SRC / "int8_w8a8_gemm_api.py", "metainfer_w8a8_contract")

M, N, K = 16, 4096, 192
a8, b8, a_scale, b_scale = bench.generate_w8a8_inputs(M, N, K)
out8 = torch.empty((M, N), dtype=torch.bfloat16, device="cuda")
pw, pws = api.prepare_weight(b8, b_scale)
ws = api.allocate_workspace(M, N, K, a8.device)


def gemm() -> None:
    api.w8a8_gemm_out(a8, pw, a_scale, pws, out8, ws)


for _ in range(200):
    gemm()
torch.cuda.synchronize()
g8 = torch.cuda.CUDAGraph()
with torch.cuda.graph(g8):
    gemm()

print("  replays/sample sweep (samples=30, official formula = elapsed/replays):")
for replays in (1, 5, 20, 100, 500):
    med, lo, p90 = event_timing(g8, samples=30, replays=replays)
    print("    replays=%-4d median %7.3f us   min %7.3f us   p90 %7.3f us" % (
        replays, med, lo, p90))
ker8 = profiler_kernel_us(g8, replays=50)
print("  profiler pure kernel time: %.3f us  (bw %.1f GB/s of int8 weights)" % (
    ker8, (K * N) / (ker8 * 1e-6) / 1e9))
print("  recorded worker accepted median = 8.671 us / min 7.484 us / baseline 17.312 us")
