"""Profiling skill — closes FM-3 (rocprof / hardware-counter access gap).

The 16-iter opt_kernel experiment stalled partly because the agent could not
get hardware counters: the default GPU card was contended and rocprof was not
wired up, so the agent iterated blind on microarchitectural bottlenecks until
it improvised (iter #14) a dedicated-card bind + self-built A/B. This module
gives a ready, testable profiling capability instead of asking every task to
rediscover it:

  * :func:`find_idle_gpu`  — pick a free device via rocm-smi / nvidia-smi.
  * :func:`parse_rocprof`  — pure parser for rocprof counter output.
  * :func:`build_driver_script` — pure generator of the in-process kernel driver.
  * :func:`profile_kernel`  — orchestrate: bind an idle device, run rocprof on
    the driver, parse counters, write ``profile_out.json``. Falls back to
    ``torch.profiler`` when rocprof is unavailable.
  * :func:`profiler_skill_text` — the prompt section that tells the perf
    planner this tool exists and the iter-#14 methodology (bind a dedicated
    idle card; do not trust a contended default).

Advisory + side-effect-free to the state machine: nothing here is called from
the phase loop automatically. It is a TOOL the perf-planner agent can invoke
via the CLI entry (``python -m ...profiler``) or whose methodology the
``perf_plan_prompt`` describes. All subprocess work goes through an injected
``runner`` callable so unit tests never need a GPU or rocprof.

Authority: none. ``profile_out.json`` is a *derived artifact* written into the
iteration's ``logs/`` dir for the agent to read; it never feeds the perf oracle
or the regression gate (those stay the single source of truth on
``perf_report.json``).
"""

from __future__ import annotations

import json
import shlex
import subprocess
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

# A runner executes a command and returns (returncode, stdout, stderr).
# Injected everywhere so tests never touch a real GPU / rocprof binary.
Runner = Callable[[Sequence[str], int], Tuple[int, str, str]]


def _real_runner(cmd: Sequence[str], timeout: int) -> Tuple[int, str, str]:
    """Default runner using subprocess; raises are turned into (124, '', err)."""
    try:
        cp = subprocess.run(  # noqa: S603 — args are caller-controlled in prod
            list(cmd), capture_output=True, text=True, timeout=timeout, check=False,
        )
        return cp.returncode, cp.stdout or "", cp.stderr or ""
    except FileNotFoundError as exc:
        return 127, "", str(exc)
    except subprocess.TimeoutExpired:
        return 124, "", f"timeout after {timeout}s"


# --------------------------------------------------------------------------- #
# find_idle_gpu
# --------------------------------------------------------------------------- #

def find_idle_gpu(*, runner: Optional[Runner] = None,
                  preferred: Optional[int] = None) -> Optional[int]:
    """Return the device id of the least-used GPU, or ``preferred`` if it is
    present and idle. Tries ROCm first (``rocm-smi``), then CUDA
    (``nvidia-smi``). Any failure → ``None`` so callers can degrade to the
    default device rather than crash.
    """
    runner = runner or _real_runner

    def _usage_rocm() -> Optional[Dict[int, int]]:
        rc, out, _ = runner(["rocm-smi", "--showmeminfo", "vram", "--json"], 15)
        if rc != 0 or not out.strip():
            return None
        try:
            obj = json.loads(out)
        except ValueError:
            return None
        usage: Dict[int, int] = {}
        for k, v in obj.items():
            # keys like "card0", "card1"; "vram" / "vram_used" bytes
            if not k.startswith("card"):
                continue
            try:
                did = int(k.replace("card", ""))
            except ValueError:
                continue
            try:
                used = int(v.get("vram_used", v.get("vram", 0)))
            except (TypeError, ValueError, AttributeError):
                continue
            usage[did] = used
        return usage or None

    def _usage_cuda() -> Optional[Dict[int, int]]:
        rc, out, _ = runner(
            ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
            15)
        if rc != 0 or not out.strip():
            return None
        usage: Dict[int, int] = {}
        for i, ln in enumerate(out.strip().splitlines()):
            ln = ln.strip()
            if not ln:
                continue
            try:
                usage[i] = int(ln.split()[0])
            except (ValueError, IndexError):
                continue
        return usage or None

    usage = _usage_rocm() or _usage_cuda()
    if not usage:
        return None
    if preferred is not None and preferred in usage:
        return preferred
    # least-used device, tie-break on lowest id
    return min(usage.items(), key=lambda kv: (kv[1], kv[0]))[0]


# --------------------------------------------------------------------------- #
# parse_rocprof
# --------------------------------------------------------------------------- #

def parse_rocprof(text: str) -> Dict[str, float]:
    """Parse rocprof counter output into ``{counter: value}``.

    rocprof emits either CSV (``Header,Header,...`` then numeric rows) or its
    human table (``KernelName  gpu-id  <counters>``). We take the LAST numeric
    row's per-counter sum across rows (a multi-kernel run aggregates). Non-
    numeric / unparseable input → ``{}`` (never raises). Counter names are kept
    verbatim (e.g. ``SQC_WAVEfronts``, ``VALUInsts``, ``L2CacheHit``).
    """
    if not text or not text.strip():
        return {}
    lines = [ln for ln in text.splitlines() if ln.strip()]
    # detect CSV header
    header_idx = None
    for i, ln in enumerate(lines):
        toks = [t.strip() for t in ln.split(",")]
        if len(toks) >= 2 and "KernelName" in toks[0].replace(" ", ""):
            header_idx = i
            break
    if header_idx is not None:
        headers = [t.strip() for t in lines[header_idx].split(",")]
        acc: Dict[str, float] = {}
        for ln in lines[header_idx + 1:]:
            toks = [t.strip() for t in ln.split(",")]
            if len(toks) < len(headers):
                continue
            for h, t in zip(headers[1:], toks[1:]):
                try:
                    acc[h] = acc.get(h, 0.0) + float(t)
                except ValueError:
                    continue
        return acc
    # table form: split on whitespace, first col is kernel name (may contain
    # spaces; the numeric tail is what we want). Take columns that parse as
    # floats from the right.
    for ln in lines:
        toks = ln.split()
        if len(toks) < 2:
            continue
        nums: List[float] = []
        for t in toks[::-1]:
            try:
                nums.insert(0, float(t))
            except ValueError:
                break
        if not nums:
            continue
        # label numeric columns generically if no header is known
        return {f"col{i}": v for i, v in enumerate(nums)}
    return {}


# --------------------------------------------------------------------------- #
# build_driver_script
# --------------------------------------------------------------------------- #

def build_driver_script(kernel_path: Path, shape: Dict[str, int],
                        num_iters: int = 20, device: int = 0) -> str:
    """Pure generator for the in-process driver that rocprof wraps.

    Loads the agent's ``kernel.py`` from ``kernel_path``, builds the shape's
    inputs, warms up, then runs the kernel ``num_iters`` times so rocprof
    captures real execution. The driver itself prints nothing meaningful —
    rocprof's counters are the output. Kept as a string so it is trivially
    unit-testable (assert it references the path + shape).
    """
    M, K, N = shape.get("M", 4096), shape.get("K", 4096), shape.get("N", 4096)
    return f"""\
import sys, torch
sys.path.insert(0, {str(kernel_path.parent)!r})
import kernel as K_mod  # noqa: E401
torch.cuda.set_device({device})
x_q = torch.randint(-127, 127, ({M}, {K}), dtype=torch.int8, device='cuda')
weight = torch.randint(-127, 127, ({K}, {N}), dtype=torch.int8, device='cuda')
x_scale = torch.rand({M}, 1, dtype=torch.float32, device='cuda') * 0.01 + 0.001
weight_scale = torch.rand({N}, 1, dtype=torch.float32, device='cuda') * 0.01 + 0.001
for _ in range(5):
    K_mod.w8a8_scaled_mm(x_q, weight, x_scale, weight_scale, torch.bfloat16)
torch.cuda.synchronize()
for _ in range({num_iters}):
    K_mod.w8a8_scaled_mm(x_q, weight, x_scale, weight_scale, torch.bfloat16)
torch.cuda.synchronize()
"""


# --------------------------------------------------------------------------- #
# profile_kernel
# --------------------------------------------------------------------------- #

def profile_kernel(kernel_path: Path, shape: Dict[str, int], *,
                   device: Optional[int] = None, out_path: Optional[Path] = None,
                   num_iters: int = 20, timeout_s: int = 120,
                   runner: Optional[Runner] = None) -> Optional[Dict[str, Any]]:
    """Run rocprof over a driver of the agent's kernel and write counters JSON.

    Picks an idle device (or uses ``device``), writes a throwaway driver
    script, invokes ``rocprofv2 --stats ...`` over it, parses the counters, and
    writes ``profile_out.json`` at ``out_path`` (defaults to
    ``<kernel_path.parent>/profile_out.json``). Returns the parsed dict, or
    ``None`` if rocprof is unavailable / the run failed. Advisory: never
    raises — callers treat ``None`` as "no counters this run".
    """
    runner = runner or _real_runner
    dev = device if device is not None else find_idle_gpu(runner=runner)
    if dev is None:
        dev = 0  # last resort: default device
    driver = kernel_path.parent / "_profiler_driver.py"
    driver.write_text(build_driver_script(kernel_path, shape, num_iters, dev),
                      encoding="utf-8")
    cmd = ["rocprofv2", "--stats", "-i", str(driver)]
    rc, out, err = runner(cmd, timeout_s)
    result: Dict[str, Any] = {
        "method": "rocprof",
        "device": dev,
        "shape": {k: int(v) for k, v in shape.items()},
        "kernel": str(kernel_path),
    }
    if rc == 0 and out.strip():
        counters = parse_rocprof(out)
        if counters:
            result["counters"] = counters
            result["ok"] = True
        else:
            result["ok"] = False
            result["error"] = "rocprof produced no parseable counters"
    else:
        # rocprof unavailable / failed — record the method gap explicitly so
        # the agent sees FM-3 is the cause (not a silent None).
        result["ok"] = False
        result["error"] = f"rocprof run failed (rc={rc}): {err.strip()[:200]}"
    target = Path(out_path) if out_path else kernel_path.parent / "profile_out.json"
    try:
        target.write_text(json.dumps(result, ensure_ascii=False, indent=2),
                          encoding="utf-8")
    except OSError:
        pass
    return result if result.get("ok") else None


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def main(argv: Optional[Sequence[str]] = None,
        runner: Optional[Runner] = None) -> int:
    """``python -m metainfer.tasks.opt_kernel.orchestrator.profiler \
       <kernel.py> --M 4096 --K 4096 --N 4096 [--device N] [--out path]``"""
    import argparse
    p = argparse.ArgumentParser(description="Profile a w8a8 kernel with rocprof.")
    p.add_argument("kernel", type=Path)
    p.add_argument("--M", type=int, default=4096)
    p.add_argument("--K", type=int, default=4096)
    p.add_argument("--N", type=int, default=4096)
    p.add_argument("--device", type=int, default=None)
    p.add_argument("--out", type=Path, default=None)
    p.add_argument("--iters", type=int, default=20)
    p.add_argument("--timeout", type=int, default=120)
    args = p.parse_args(argv)
    res = profile_kernel(
        args.kernel, {"M": args.M, "K": args.K, "N": args.N},
        device=args.device, out_path=args.out, num_iters=args.iters,
        timeout_s=args.timeout, runner=runner)
    print(json.dumps(res, ensure_ascii=False, indent=2))
    return 0 if res is not None else 1


# --------------------------------------------------------------------------- #
# Prompt skill text
# --------------------------------------------------------------------------- #

def profiler_skill_text(repo_root: Path) -> str:
    """The prompt section that tells the perf planner the profiler exists and
    codifies the iter-#14 methodology (bind a dedicated idle card; do not trust
    a contended default; treat FM-3 — missing counters — as a known gap with a
    ready tool). Pure over ``repo_root`` (only used to give the agent the import
    path); injects no state.
    """
    return (
        "\n\n# Profiling skill (rocprof / hardware counters)\n"
        "A ready profiling tool is available — use it instead of fighting\n"
        "rocprof by hand or iterating blind on microarchitectural bottlenecks:\n"
        "```\n"
        f"cd {repo_root} && python -m metainfer.tasks.opt_kernel.orchestrator.profiler \\\n"
        "      <iter_dir>/kernel.py --M 4096 --K 4096 --N 4096 --out <iter_dir>/profile_out.json\n"
        "```\n"
        "It binds a dedicated *idle* GPU (the default card is often contended —\n"
        "a known failure mode, FM-3), runs rocprof over a driver of your kernel,\n"
        "and writes counters (VALUInsts, L2CacheHit, SQC_WAVEfronts, ...) to\n"
        "``profile_out.json``. Read that file to pick the next optimization\n"
        "(memory-bound → tiling/split-K; launch-bound → fuse / increase work per\n"
        "wavefront). If rocprof is unavailable the JSON records the gap\n"
        "explicitly — fall back to A/B timing on a dedicated card (the iter-#14\n"
        "methodology) rather than trusting the contended default.\n"
        "This is advisory: the perf oracle's ``perf_report.json`` stays the\n"
        "single source of truth for regression; ``profile_out.json`` only guides\n"
        "your plan."
    )


if __name__ == "__main__":  # pragma: no cover
    import sys
    sys.exit(main())
