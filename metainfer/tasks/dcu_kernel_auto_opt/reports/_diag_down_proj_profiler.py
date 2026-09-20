#!/usr/bin/env python3
"""Independent cross-check for hy3_tp8_shared_down_proj_m16 (M16 N4096 K192).

Method A: CUDA-event timing over CUDA-graph replay (same as the official harness).
Method B: torch.profiler -> pure GPU kernel time (excludes host launch overhead).

Run with the worker_3 accepted build (extension cache reused, no rebuild).
"""
from __future__ import annotations

import importlib.util
import json
import os
import statistics
import sys
from pathlib import Path

import torch

WS = Path("/root/zth_agent/MetaInfer/nodes/worker29/workspaces/hy3-dsh-tp8-m16-9-8-0161e718")
ROOT = Path(sys.argv[1]) if len(sys.argv) > 1 else WS / "workers" / "worker_3"
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


bench = load_module(SRC / "w8a8_bench.py", "bench_mod")
backend = load_module(SRC / "w8a8_backend.py", "metainfer_w8a8_backend")
backend.load_extension()
api = load_module(SRC / "int8_w8a8_gemm_api.py", "metainfer_w8a8_contract")

M = int(os.environ.get("SHAPE_M", "16"))
N = int(os.environ.get("SHAPE_N", "4096"))
K = int(os.environ.get("SHAPE_K", "192"))
print(f"== shape M={M} N={N} K={K} root={ROOT.name} ==", flush=True)
a, b, a_scale, b_scale = bench.generate_w8a8_inputs(M, N, K)
out = torch.empty((M, N), dtype=torch.bfloat16, device="cuda")
packed_weight, packed_weight_scale = api.prepare_weight(b, b_scale)
workspace = api.allocate_workspace(M, N, K, a.device)


def candidate() -> None:
    api.w8a8_gemm_out(a, packed_weight, a_scale, packed_weight_scale, out, workspace)


for _ in range(100):
    candidate()
torch.cuda.synchronize()

graph = torch.cuda.CUDAGraph()
with torch.cuda.graph(graph):
    candidate()

# --- Method A: event timing, 30 samples x 100 replays (official protocol) ---
events = [(torch.cuda.Event(True), torch.cuda.Event(True)) for _ in range(30)]
for start, end in events:
    start.record()
    for _ in range(100):
        graph.replay()
    end.record()
torch.cuda.synchronize()
per_launch = [s.elapsed_time(e) * 1000.0 / 100.0 for s, e in events]
print("== Method A: CUDA-event graph replay (official protocol) ==")
print("  median_us=%.3f  min_us=%.3f  p90_us=%.3f  n=30" % (
    statistics.median(per_launch), min(per_launch),
    sorted(per_launch)[int(0.9 * len(per_launch)) - 1]))

# --- Method B: profiler kernel-only device time ---
replays = 50
from torch.profiler import ProfilerActivity, profile  # noqa: E402

with profile(activities=[ProfilerActivity.CUDA]) as prof:
    for _ in range(replays):
        graph.replay()
    torch.cuda.synchronize()

kernels = []
for entry in prof.key_averages():
    dev_us = getattr(entry, "self_device_time_total", 0.0) or 0.0
    if dev_us > 0:
        kernels.append((entry.key, int(entry.count), dev_us / replays))
kernels.sort(key=lambda item: -item[2])
total_per_launch = sum(item[2] for item in kernels)
print("== Method B: torch.profiler GPU kernel time (per graph replay) ==")
for key, count, us in kernels[:6]:
    print("  %-58s count=%-4d %8.3f us/replay" % (key[:58], count, us))
print("  TOTAL kernel time per replay = %.3f us" % total_per_launch)
print()
print("recorded worker accepted median = 8.671 us (min 7.484, p90 9.144); baseline 17.312 us")
