#!/usr/bin/env python3
"""Measure the fixed per-replay overhead the harness metric includes.

If (empty-graph floor) + (profiler kernel time) ~= harness per-replay number,
the harness is measuring "per graph-replay call latency" = launch overhead + kernel,
which is the explanation for 8.67us vs ~4.5us kernel-only.
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
    return statistics.median(per), per[0], per[int(0.9 * len(per)) - 1]


def profiler_kernel_us(graph, replays=50):
    with profile(activities=[ProfilerActivity.CUDA]) as prof:
        for _ in range(replays):
            graph.replay()
        torch.cuda.synchronize()
    return sum(float(getattr(e, "self_device_time_total", 0.0) or 0.0)
               for e in prof.key_averages()) / replays


# ---- 1. empty-ish graph: trivial kernel only (floor of the metric) ----
tiny_in = torch.zeros(8, dtype=torch.float32, device="cuda")
tiny_out = torch.empty_like(tiny_in)
for _ in range(50):
    tiny_out.copy_(tiny_in)
torch.cuda.synchronize()
g_tiny = torch.cuda.CUDAGraph()
with torch.cuda.graph(g_tiny):
    tiny_out.copy_(tiny_in)
med, lo, p90 = event_timing(g_tiny)
tiny_kernel = profiler_kernel_us(g_tiny)
print("== trivial-kernel graph (metric floor) ==")
print("   event per replay : median %.3f us  min %.3f  p90 %.3f" % (med, lo, p90))
print("   profiler kernel  : %.3f us" % tiny_kernel)

# ---- 2. the real shape, same protocol ----
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


for _ in range(200):
    gemm()
torch.cuda.synchronize()
g8 = torch.cuda.CUDAGraph()
with torch.cuda.graph(g8):
    gemm()
med8, lo8, p908 = event_timing(g8)
ker8 = profiler_kernel_us(g8)
print()
print("== hy3_tp8_shared_down_proj_m16 (official protocol: samples=30, replays=100) ==")
print("   event per replay : median %.3f us  min %.3f  p90 %.3f" % (med8, lo8, p908))
print("   profiler kernel  : %.3f us" % ker8)
print("   implied fixed overhead (median - kernel) : %.3f us" % (med8 - ker8))
print("   floor - tiny kernel                       : %.3f us" % (med - tiny_kernel))
print()
print("   recorded worker accepted: median 8.671 us | baseline 17.312 us")
