"""rocprof profiler wrapper for opt-kernel.

Encapsulates the invocation and output parsing of ``rocprof`` so the perf
oracle can capture kernel-level statistics, HIP API traces, and hardware
counters without the agent needing to know profiler commands.

Supported capture modes (driven by the hardware profile's ``profiling.captures``):

  - ``kernel_stats``  → ``rocprof --stats``        → ``results.stats.csv``
  - ``hip_api_trace`` → ``rocprof --hip-trace``     → ``results.json``
  - ``counter_capture`` → ``rocprof -i <counters>`` → ``results.csv``

All artifacts land in the iteration's ``profile/`` subdirectory. The perf
oracle reads them back into structured JSON for ``perf_report.json``.
"""

from __future__ import annotations

import csv
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional


def _find_rocprof() -> Optional[str]:
    """Locate the rocprof binary on PATH."""
    return shutil.which("rocprof")


def _find_rocprof_compute() -> Optional[str]:
    """Locate rocprof-compute (roofline tool), if installed."""
    return shutil.which("rocprof-compute") or shutil.which("rocprof-compute-cli")


def run_kernel_stats(
    workdir: Path,
    command: List[str],
    env: Optional[Dict[str, str]] = None,
    timeout_s: int = 300,
) -> Dict[str, Any]:
    """Run ``rocprof --stats`` on a command and parse ``results.stats.csv``.

    Returns a dict with ``collected: bool``, ``kernels: [...]``, and
    ``raw_csv_path``. If rocprof is unavailable or the run fails, returns
    ``collected: False`` with an error message — the perf oracle continues
    without profile artifacts rather than failing the whole benchmark.
    """
    rocprof = _find_rocprof()
    if rocprof is None:
        return {"collected": False, "error": "rocprof not found on PATH"}

    profile_dir = workdir / "profile"
    profile_dir.mkdir(parents=True, exist_ok=True)
    output_base = profile_dir / "stats"

    cmd = [rocprof, "--stats", "-o", str(output_base), "--"] + command
    try:
        proc = subprocess.run(
            cmd, cwd=str(workdir), env=env,
            capture_output=True, text=True, timeout=timeout_s,
        )
    except subprocess.TimeoutExpired:
        return {"collected": False, "error": f"rocprof --stats timed out after {timeout_s}s"}
    except Exception as exc:  # noqa: BLE001
        return {"collected": False, "error": f"rocprof --stats crashed: {exc!r}"}

    # rocprof writes results.stats.csv (or results.csv depending on version)
    stats_csv = profile_dir / "results.stats.csv"
    if not stats_csv.exists():
        # Try alternate names
        for candidate in ["results.csv", "stats.results.csv", "results.stats.csv"]:
            p = profile_dir / candidate
            if p.exists():
                stats_csv = p
                break
    if not stats_csv.exists():
        return {
            "collected": False,
            "error": f"rocprof produced no stats CSV (rc={proc.returncode})",
            "stdout_tail": (proc.stdout or "")[-500:],
            "stderr_tail": (proc.stderr or "")[-500:],
        }

    kernels = _parse_stats_csv(stats_csv)
    return {
        "collected": True,
        "kind": "kernel_stats",
        "path": str(stats_csv.relative_to(workdir)),
        "kernels": kernels,
        "returncode": proc.returncode,
    }


def _parse_stats_csv(path: Path) -> List[Dict[str, Any]]:
    """Parse a rocprof stats CSV into a list of per-kernel stat dicts.

    rocprof --stats output columns typically include:
      Name, Calls, TotalDuration(ns), Average(ns), Percentage
    Column names vary by version, so we normalize.
    """
    kernels: List[Dict[str, Any]] = []
    try:
        with open(path, encoding="utf-8", errors="replace", newline="") as f:
            reader = csv.DictReader(f)
            for row in reader:
                entry: Dict[str, Any] = {}
                for key, val in row.items():
                    k = (key or "").strip()
                    v = (val or "").strip()
                    if not k:
                        continue
                    # Normalize common column names
                    kl = k.lower()
                    if "name" in kl and "kernel" not in kl:
                        entry["kernel"] = v
                    elif "kernel" in kl:
                        entry["kernel"] = v
                    elif "call" in kl:
                        entry["calls"] = _to_int(v)
                    elif "total" in kl and "duration" in kl:
                        entry["total_ns"] = _to_float(v)
                    elif "average" in kl or ("avg" in kl):
                        entry["avg_ns"] = _to_float(v)
                    elif "percentage" in kl or "percent" in kl:
                        entry["percentage"] = _to_float(v)
                    elif "duration" in kl:
                        entry["total_ns"] = _to_float(v)
                    else:
                        entry[k] = _to_number_or_str(v)
                if entry:
                    kernels.append(entry)
    except Exception:  # noqa: BLE001
        pass
    return kernels


def run_hip_trace(
    workdir: Path,
    command: List[str],
    env: Optional[Dict[str, str]] = None,
    timeout_s: int = 300,
) -> Dict[str, Any]:
    """Run ``rocprof --hip-trace`` and return the trace JSON path.

    The trace file (``results.json``) is a Perfetto-compatible JSON trace.
    It can be large, so we only return the path — the frontend offers a
    download link rather than inlining the content.
    """
    rocprof = _find_rocprof()
    if rocprof is None:
        return {"collected": False, "error": "rocprof not found on PATH"}

    profile_dir = workdir / "profile"
    profile_dir.mkdir(parents=True, exist_ok=True)
    output_base = profile_dir / "hip_trace"

    cmd = [rocprof, "--hip-trace", "-o", str(output_base), "--"] + command
    try:
        proc = subprocess.run(
            cmd, cwd=str(workdir), env=env,
            capture_output=True, text=True, timeout=timeout_s,
        )
    except subprocess.TimeoutExpired:
        return {"collected": False, "error": f"rocprof --hip-trace timed out after {timeout_s}s"}
    except Exception as exc:  # noqa: BLE001
        return {"collected": False, "error": f"rocprof --hip-trace crashed: {exc!r}"}

    trace_json = profile_dir / "results.json"
    if not trace_json.exists():
        return {
            "collected": False,
            "error": f"rocprof --hip-trace produced no results.json (rc={proc.returncode})",
        }
    size = trace_json.stat().st_size
    return {
        "collected": True,
        "kind": "hip_trace",
        "path": str(trace_json.relative_to(workdir)),
        "size_bytes": size,
        "returncode": proc.returncode,
    }


def run_counters(
    workdir: Path,
    command: List[str],
    counters: List[str],
    env: Optional[Dict[str, str]] = None,
    timeout_s: int = 300,
) -> Dict[str, Any]:
    """Run ``rocprof -i <counters-file>`` to capture hardware counters.

    Writes a counters file, runs rocprof, and parses ``results.csv``.
    """
    rocprof = _find_rocprof()
    if rocprof is None:
        return {"collected": False, "error": "rocprof not found on PATH"}
    if not counters:
        return {"collected": False, "error": "no counters specified"}

    profile_dir = workdir / "profile"
    profile_dir.mkdir(parents=True, exist_ok=True)

    # Write the counters input file
    counters_file = profile_dir / "counters.txt"
    counters_file.write_text("\n".join(counters) + "\n", encoding="utf-8")

    output_base = profile_dir / "counters"
    cmd = [rocprof, "-i", str(counters_file), "-o", str(output_base), "--"] + command
    try:
        proc = subprocess.run(
            cmd, cwd=str(workdir), env=env,
            capture_output=True, text=True, timeout=timeout_s,
        )
    except subprocess.TimeoutExpired:
        return {"collected": False, "error": f"rocprof counters timed out after {timeout_s}s"}
    except Exception as exc:  # noqa: BLE001
        return {"collected": False, "error": f"rocprof counters crashed: {exc!r}"}

    results_csv = profile_dir / "results.csv"
    if not results_csv.exists():
        return {
            "collected": False,
            "error": f"rocprof counters produced no results.csv (rc={proc.returncode})",
        }

    metrics = _parse_counters_csv(results_csv)
    return {
        "collected": True,
        "kind": "counters",
        "path": str(results_csv.relative_to(workdir)),
        "metrics": metrics,
        "returncode": proc.returncode,
    }


def _parse_counters_csv(path: Path) -> Dict[str, Any]:
    """Parse a rocprof counters CSV into a {counter_name: value} dict.

    The CSV typically has one row per kernel with counter columns.
    We aggregate by taking the max/sum across kernels for each counter.
    """
    metrics: Dict[str, List[float]] = {}
    try:
        with open(path, encoding="utf-8", errors="replace", newline="") as f:
            reader = csv.DictReader(f)
            for row in reader:
                for key, val in row.items():
                    k = (key or "").strip()
                    if not k:
                        continue
                    num = _to_float(val)
                    if num is not None:
                        metrics.setdefault(k, []).append(num)
    except Exception:  # noqa: BLE001
        pass
    # Aggregate: for rate counters take max, for event counters take sum
    summary: Dict[str, float] = {}
    for k, vals in metrics.items():
        if vals:
            kl = k.lower()
            if "hit" in kl or "busy" in kl or "util" in kl or "rate" in kl:
                summary[k] = round(max(vals), 4)
            else:
                summary[k] = round(sum(vals), 4)
    return summary


def collect_profile(
    workdir: Path,
    command: List[str],
    env: Optional[Dict[str, str]] = None,
    key_counters: Optional[List[str]] = None,
    timeout_s: int = 300,
) -> List[Dict[str, Any]]:
    """Run all available profile captures and return a list of artifact dicts.

    This is the main entry point for the perf oracle. It runs:
      1. ``rocprof --stats`` (always — kernel-level timing)
      2. ``rocprof -i <counters>`` (if key_counters are provided)
      3. ``rocprof --hip-trace`` (best-effort, may be slow)

    Each capture is independent — a failure in one does not block the others.
    """
    artifacts: List[Dict[str, Any]] = []

    # 1. Kernel stats (always)
    stats = run_kernel_stats(workdir, command, env, timeout_s)
    if stats.get("collected"):
        artifacts.append(stats)
    else:
        artifacts.append({"kind": "kernel_stats", "collected": False,
                          "error": stats.get("error", "unknown")})

    # 2. Hardware counters (if configured)
    if key_counters:
        counters = run_counters(workdir, command, key_counters, env, timeout_s)
        if counters.get("collected"):
            artifacts.append(counters)
        else:
            artifacts.append({"kind": "counters", "collected": False,
                              "error": counters.get("error", "unknown")})

    # 3. HIP trace (best-effort, longer timeout)
    trace = run_hip_trace(workdir, command, env, timeout_s=max(timeout_s, 600))
    if trace.get("collected"):
        artifacts.append(trace)
    else:
        artifacts.append({"kind": "hip_trace", "collected": False,
                          "error": trace.get("error", "unknown")})

    return artifacts


def _to_float(val: str) -> Optional[float]:
    try:
        return float(val.strip().rstrip("%"))
    except (ValueError, AttributeError):
        return None


def _to_int(val: str) -> Optional[int]:
    try:
        return int(float(val.strip()))
    except (ValueError, AttributeError):
        return None


def _to_number_or_str(val: str):
    f = _to_float(val)
    return f if f is not None else val
