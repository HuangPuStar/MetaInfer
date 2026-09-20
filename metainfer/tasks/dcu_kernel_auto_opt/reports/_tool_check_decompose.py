#!/usr/bin/env python3
"""Decompose the harness metric for hy3_tp8_shared_down_proj_m16.

per_replay_latency(G) = fixed_overhead + G * kernel_time
Graphs contain G sequential w8a8_gemm_out calls; measure with the official
protocol (samples=30, replays=100) and compare the slope with the profiler
kernel time.
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


def event_timing(graph, samples=30, replays=100):
    evs = [(torch.cuda.Event(True), torch.cuda.Event(True)) for _ in range(samples)]
    for s, e in evs:
        s.record()
        for _ in range(replays):
            graph.replay()
        e.record()
    torch.cuda.synchronize()
    per = sorted(s.elapsed_time(e) * 1000.0 / replays for s, e in evs)
    return statistics.median(per), per[0]


def profiler_kernel_us(graph, replays=50):
    with profile(activities=[ProfilerActivity.CUDA]) as prof:
        for _ in range(replays):
            graph.replay()
        torch.cuda.synchronize()
    return sum(float(getattr(e, "self_device_time_total", 0.0) or 0.0)
               for e in prof.key_averages()) / replays


bench = load_module(SRC / "w8a8_bench.py", "bench_mod")
backend = load_module(SRC / "w8a8_backend.py", "metainfer_w8a8_backend")
backend.load_extension()
api = load_module(SRC / "int8_w8a8_gemm_api.py", "metainfer_w8a8_contract")
M, N, K = 16, 4096, 192
a8, b8, a_scale, b_scale = bench.generate_w8a8_inputs(M, N, K)
out8 = torch.empty((M, N), dtype=torch.bfloat16, device="cuda")
pw, pws = api.prepare_weight(b8, b_scale)
ws = api.allocate_workspace(M, N, K, a8.device)


def gemm():
    api.w8a8_gemm_out(a8, pw, a_scale, pws, out8, ws)


# sustained warmup so clocks/state are stable before any measurement
for _ in range(3000):
    gemm()
torch.cuda.synchronize()

results = []
for g_count in (1, 2, 4, 8):
    def body():
        for _ in range(g_count):
            gemm()
    for _ in range(200):
        body()
    torch.cuda.synchronize()
    graph = torch.cuda.CUDAGraph()
    with torch.cuda.graph(graph):
        body()
    med, lo = event_timing(graph)
    ker = profiler_kernel_us(graph)
    results.append((g_count, med, lo, ker))
    print("G=%-2d event median %8.3f us (min %8.3f) | profiler kernel total %8.3f us -> per kernel %.3f us"
          % (g_count, med, lo, ker, ker / g_count), flush=True)

# linear regression over G
xs = [r[0] for r in results]
ys = [r[1] for r in results]
n = len(xs)
mx, my = sum(xs) / n, sum(ys) / n
slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sum((x - mx) ** 2 for x in xs)
intercept = my - slope * mx
print()
print("fit: per_replay(G) = %.3f us  +  G * %.3f us" % (intercept, slope))
print("  -> fixed per-replay overhead (graph launch/event boundary) = %.3f us" % intercept)
print("  -> marginal cost per gemm kernel                          = %.3f us" % slope)
print("  -> profiler per-kernel (avg)                              = %.3f us" % (
    sum(r[3] / r[0] for r in results) / n))
print()
print("recorded worker accepted median = 8.671 us ; baseline (Triton) = 17.312 us")
