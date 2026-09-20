"""A/B retest tool: compare a candidate kernel against the shipped variant.

Why this exists
---------------
DKAO records each candidate's median in its ``accepted/<shape>/manifest.json``
and each shipped variant's median in its header comment. Those are *records*,
not measurements: if the round that produced them ran while another workload
shared the device, the recorded number can be suppressed (we saw 884us -> 2043
-> 3047us for one unchanged shape). Before promoting a kernel — especially one
copied out of an old workspace — re-measure both sides under identical
conditions.

What "A/B" means here
---------------------
* **A** = the *candidate* kernel (what we might promote).
* **B** = the *variant* currently shipped in DKAO (the incumbent).
* Both are compiled from the same repository skeleton with only the kernel
  source swapped, benchmarked on the **same idle device**, with the **same
  sampling parameters**, and measured **alternately** (A, B, A, B...).

Alternating matters: GPU clock/thermal state and any background load drift over
time, so "measure A fully, then B fully" would mix that drift into the
difference. Interleaving makes both sides absorb the same conditions, so the
remaining difference is attributable to the kernel itself. Two rounds are run
so a single fluke cannot decide the outcome; medians are compared and a
candidate must win by ``--threshold`` percent (default 3, matching DKAO's
promotion rule) *and* reproduce its own recorded median (``--recorded-tol``)
before it is written.

Usage
-----
    python -m metainfer.tasks.dcu_kernel_auto_opt.tools.retest_variant \
        --candidate-workspace <ahe child workspace> \
        --shape hy3_tp4_o_proj_m4096 --rounds 2 [--promote]

    # or straight from an accepted kernel file
    python ...retest_variant --shape ... --candidate-kernel path/kernel.hip \
        --kernel-root <dir with csrc/ + harness>
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import statistics
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

PLUGIN_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[4]
BENCH = PLUGIN_DIR / "assets" / "w8a8_bench.py"
VARIANT_ROOT = PLUGIN_DIR / "variant" / "int8w8a8-gemm"

#: DKAO compiles for gfx928 only. The int8 DUMMA fragment specialisations in
#: /opt/dtk/include/du_mma.h sit behind ``#if defined(__gfx928__)``, so a
#: default multi-arch torch build fails with "undefined template DUFragment
#: <... signed char ...>". w8a8_pipeline sets this for the same reason.
BENCH_ENV = {"PYTORCH_ROCM_ARCH": "gfx928"}


# --------------------------------------------------------------- helpers ----

def find_variant(model: str, tp: int, m: int, operator: str,
                 root: Optional[Path] = None) -> Optional[Path]:
    """Shipped variant for a shape, tolerating model-label drift (glm -> glm52)."""
    root = Path(root or VARIANT_ROOT)
    exact = root / model / f"TP{tp}" / f"M{m}" / f"{operator}.hip"
    if exact.is_file():
        return exact
    for model_dir in sorted(root.iterdir()) if root.is_dir() else []:
        if not model_dir.name.startswith(model):
            continue
        candidate = model_dir / f"TP{tp}" / f"M{m}" / f"{operator}.hip"
        if candidate.is_file():
            return candidate
    hits = sorted(root.glob(f"*/TP{tp}/M{m}/{operator}.hip")) if root.is_dir() else []
    return hits[0] if hits else None


def parse_variant_header_median(path: Path) -> Optional[float]:
    """Median recorded in a variant's header comment (recorded, not measured)."""
    try:
        for line in path.read_text(encoding="utf-8",
                                   errors="replace").splitlines()[:8]:
            if "median_us=" in line:
                return float(line.split("median_us=")[1].split()[0])
    except (OSError, ValueError, IndexError):
        return None
    return None


def bench_env(device: int, base: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """Environment for an independent measurement on one device."""
    env = dict(base if base is not None else os.environ)
    env["HIP_VISIBLE_DEVICES"] = str(device)
    env["CUDA_VISIBLE_DEVICES"] = str(device)
    env.update(BENCH_ENV)
    return env


def decide(candidate_us: Optional[float], variant_us: Optional[float], *,
           threshold_percent: float = 3.0,
           recorded_us: Optional[float] = None,
           recorded_tol_percent: float = 5.0) -> Dict[str, Any]:
    """Promotion verdict from measured medians (+ reproducibility check)."""
    if not candidate_us or not variant_us:
        return {"verdict": "measurement_failed",
                "reason": "one side produced no median"}
    improvement = (variant_us - candidate_us) / variant_us * 100.0
    recorded_delta = None
    if recorded_us:
        recorded_delta = (candidate_us - float(recorded_us)) / float(recorded_us) * 100.0
    if improvement < float(threshold_percent):
        return {"verdict": "keep", "improvement_percent": improvement,
                "recorded_delta_percent": recorded_delta,
                "reason": (f"improvement {improvement:.2f}% < required "
                           f"{float(threshold_percent):.2f}%")}
    if recorded_delta is not None and abs(recorded_delta) > float(recorded_tol_percent):
        return {"verdict": "needs_review", "improvement_percent": improvement,
                "recorded_delta_percent": recorded_delta,
                "reason": (f"win {improvement:.2f}% but the re-measurement "
                           f"differs from the record by {recorded_delta:.2f}%")}
    return {"verdict": "promote", "improvement_percent": improvement,
            "recorded_delta_percent": recorded_delta,
            "reason": f"candidate faster by {improvement:.2f}%"}


def accepted_kernel_for(workspace: Path, shape_id: str) -> Optional[Path]:
    hits = sorted(Path(workspace).glob(
        f"workers/*/accepted/{shape_id}/kernel.hip"))
    return hits[0] if hits else None


def recorded_median_for(kernel: Path) -> Optional[float]:
    try:
        manifest = json.loads((kernel.parent / "manifest.json")
                              .read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    value = (manifest.get("metrics") or {}).get("median_us")
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def idle_device(gpu_ids: Optional[List[int]] = None) -> Optional[int]:
    """First device satisfying the operating gate (VRAM<=90 and HCU==0)."""
    try:
        sys.path.insert(0, str(REPO_ROOT))
        from metainfer.tasks.dcu_kernel_auto_opt.orchestrator.gpu_preflight import (  # noqa: E501
            preflight_gpus,
        )
    except Exception:  # noqa: BLE001
        return None
    plan = preflight_gpus(gpu_ids or [0, 1, 2, 3], samples=3, interval_s=2)
    clean = plan.get("clean_ids") or []
    return int(clean[0]) if clean else None


def prepare_repo(kernel_root: Path, kernel: Path, target: Path) -> Path:
    """Copy a kernel repo skeleton and swap in one kernel source."""
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(kernel_root, target)
    (target / "csrc" / "w8a8_gemm_hip.hip").write_text(
        Path(kernel).read_text(encoding="utf-8", errors="replace"),
        encoding="utf-8")
    return target


def measure(repo: Path, shape: Tuple[int, int, int], device: int, *,
            warmups: int = 30, samples: int = 30, replays: int = 50,
            reference_cache: Optional[Path] = None,
            timeout_s: int = 3600) -> Optional[float]:
    m, n, k = shape
    cmd = [sys.executable, str(BENCH), "--source", str(repo),
           "--m", str(m), "--n", str(n), "--k", str(k),
           "--warmups", str(warmups), "--samples", str(samples),
           "--replays-per-sample", str(replays), "--skip-correctness"]
    if reference_cache is not None and Path(reference_cache).is_dir():
        cmd += ["--reference-cache-dir", str(reference_cache)]
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=str(repo),
                          env=bench_env(device), timeout=timeout_s)
    for line in reversed((proc.stdout or "").splitlines()):
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            try:
                payload = json.loads(line)
            except ValueError:
                continue
            value = payload.get("median_us")
            return float(value) if value else None
    return None


def ab_retest(*, shape_id: str, candidate_kernel: Path, kernel_root: Path,
              model: str, tp: int, m: int, operator: str,
              shape: Tuple[int, int, int], rounds: int = 2,
              device: Optional[int] = None, warmups: int = 30, samples: int = 30,
              replays: int = 50, threshold: float = 3.0,
              recorded_tol: float = 5.0,
              reference_cache: Optional[Path] = None,
              build_root: Path = Path("/tmp/retest_build"),
              variant_path: Optional[Path] = None) -> Dict[str, Any]:
    """Interleaved A/B measurement of one candidate against the variant."""
    device = device if device is not None else idle_device()
    if device is None:
        return {"shape": shape_id, "verdict": "no_idle_device"}
    variant = variant_path or find_variant(model, tp, m, operator)
    if variant is None:
        return {"shape": shape_id, "verdict": "no_variant",
                "reason": f"no variant for {model}/TP{tp}/M{m}/{operator}"}
    cand_repo = prepare_repo(kernel_root, candidate_kernel,
                             Path(build_root) / shape_id / "cand")
    var_repo = prepare_repo(kernel_root, variant,
                            Path(build_root) / shape_id / "var")
    measured: Dict[str, List[float]] = {"cand": [], "var": []}
    for _ in range(max(1, int(rounds))):
        for label, repo in (("cand", cand_repo), ("var", var_repo)):
            value = measure(repo, shape, device, warmups=warmups,
                            samples=samples, replays=replays,
                            reference_cache=reference_cache)
            if value:
                measured[label].append(value)
    cand_median = statistics.median(measured["cand"]) if measured["cand"] else None
    var_median = statistics.median(measured["var"]) if measured["var"] else None
    verdict = decide(cand_median, var_median, threshold_percent=threshold,
                     recorded_us=recorded_median_for(candidate_kernel),
                     recorded_tol_percent=recorded_tol)
    return {"shape": shape_id, "device": device,
            "candidate_medians_us": measured["cand"],
            "variant_medians_us": measured["var"],
            "candidate_median_us": cand_median, "variant_median_us": var_median,
            "variant_path": str(variant),
            "recorded_median_us": recorded_median_for(candidate_kernel),
            **verdict}


# ------------------------------------------------------------------- CLI ----

def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(
        prog="retest-variant",
        description="A/B re-measure a candidate kernel against the shipped variant")
    ap.add_argument("--shape", required=True, help="shape id, e.g. hy3_tp4_o_proj_m4096")
    ap.add_argument("--candidate-workspace", type=Path,
                    help="AHE child workspace (accepted kernel is looked up)")
    ap.add_argument("--candidate-kernel", type=Path, help="explicit kernel.hip")
    ap.add_argument("--kernel-root", type=Path,
                    help="repo skeleton containing csrc/ (defaults to the "
                         "candidate's worker source)")
    ap.add_argument("--model", help="model label (default: parsed from the shape id)")
    ap.add_argument("--tp", type=int, help="tensor-parallel size (default: parsed)")
    ap.add_argument("--m", type=int, help="M (default: from the accepted manifest)")
    ap.add_argument("--operator", help="operator name (default: parsed from the shape id)")
    ap.add_argument("--shape-mnk", help="M,N,K of the problem, e.g. 4096,4096,2048")
    ap.add_argument("--rounds", type=int, default=2)
    ap.add_argument("--warmups", type=int, default=30)
    ap.add_argument("--samples", type=int, default=30)
    ap.add_argument("--replays", type=int, default=50)
    ap.add_argument("--threshold", type=float, default=3.0)
    ap.add_argument("--recorded-tol", type=float, default=5.0)
    ap.add_argument("--device", type=int, help="GPU id (default: pick an idle one)")
    ap.add_argument("--promote", action="store_true",
                    help="write the variant when the verdict is 'promote'")
    ap.add_argument("--json", type=Path, help="write the report to this path")
    args = ap.parse_args(argv)

    from metainfer.tasks.harness_evolve.orchestrator.pool import Pool
    pool_file = Path("/root/zth_agent/ahe-kernel-repos/registered_pool.yaml")
    pool = Pool.from_yaml(pool_file) if pool_file.is_file() else None
    inst = pool.get(args.shape) if pool is not None else None

    candidate = args.candidate_kernel
    if candidate is None:
        if not args.candidate_workspace:
            ap.error("--candidate-workspace or --candidate-kernel is required")
        candidate = accepted_kernel_for(args.candidate_workspace, args.shape)
    if candidate is None or not Path(candidate).is_file():
        ap.error(f"candidate kernel not found for {args.shape}")

    kernel_root = args.kernel_root or Path(candidate).parents[2] / "source"
    model = args.model or (inst.model if inst else args.shape.split("_tp")[0])
    tp = args.tp or (inst.tp_size if inst else 4)
    m = args.m or (inst.M if inst else 4096)
    operator = args.operator or args.shape.split("_m")[0].split("_", 2)[-1]
    if args.shape_mnk:
        mnk = tuple(int(x) for x in args.shape_mnk.split(","))
    elif inst is not None:
        mnk = (inst.M, inst.N, inst.K)
    else:
        ap.error("--shape-mnk is required when the shape is not in the pool")

    report = ab_retest(
        shape_id=args.shape, candidate_kernel=Path(candidate),
        kernel_root=Path(kernel_root), model=model, tp=int(tp), m=int(m),
        operator=operator, shape=mnk, rounds=args.rounds, device=args.device,
        warmups=args.warmups, samples=args.samples, replays=args.replays,
        threshold=args.threshold, recorded_tol=args.recorded_tol,
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if args.json:
        Path(args.json).write_text(json.dumps(report, ensure_ascii=False, indent=2),
                                   encoding="utf-8")

    if args.promote and report.get("verdict") == "promote":
        from metainfer.tasks.dcu_kernel_auto_opt.orchestrator.variant_promote import (  # noqa: E501
            model_label_for, promote_variant,
        )
        workspace = args.candidate_workspace or Path(candidate).parents[4]
        outcome = promote_variant(
            workspace_dir=Path(workspace),
            answers={"operator": "Quantized GEMM", "dtype": "INT8 W8A8",
                     "model": model, "tp_size": tp},
            shape_id=args.shape,
            source_task=f"{args.shape} (A/B retested)",
            correctness_ok=True, min_improvement_percent=args.threshold,
            tp=int(tp), m=int(m),
            model_label=(model_label_for(args.shape, str(model)) or None),
        )
        print(json.dumps({"promotion": outcome}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
