"""Kernel promotion: turn an evaluated task's accepted kernel into a variant.

Both DKAO tasks and harness_evolve (HE) children write the same workspace
layout (``workers/*/accepted/<shape_id>/kernel.hip`` + ``manifest.json``), so
one implementation can serve both. This module adds the conservative gates the
automatic path needs on top of :func:`variant_store.add_variant`:

* correctness must not be known-failed;
* the candidate must beat the existing variant for the same shape by at least
  ``min_improvement_percent`` (a strictly slower candidate is always rejected,
  by ``add_variant`` itself);
* every write is backed up (``add_variant``'s ``backup=True``) and reported
  with old/new medians, improvement and the backup path so a promotion can be
  audited and rolled back.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Optional

from .variant_store import (
    _parse_variant_header,
    add_variant,
    derive_variant_meta,
    variant_path,
)

#: shape-id prefix -> the model label used by the variant taxonomy.
MODEL_LABEL_BY_PREFIX = {
    "hy3": "Hy3 (Hunyuan 3)",
    "minimax": "MiniMax M3",
    "glm": "GLM5.2",
    "dsv4": "DeepSeek V4 Flash",
    "deepseek": "DeepSeek V4 Flash",
}


def model_label_for(shape_id: str, fallback: str = "") -> str:
    """Map a shape id (or model name) to a known variant-taxonomy label."""
    key = (shape_id or "").strip().lower()
    for prefix, label in MODEL_LABEL_BY_PREFIX.items():
        if key.startswith(prefix):
            return label
    return fallback


def accepted_kernel_for(workspace_dir: Path,
                        shape_id: str) -> Optional[Dict[str, Any]]:
    """Locate the accepted kernel + manifest for one shape in any worker lane."""
    root = Path(workspace_dir) / "workers"
    if not root.is_dir():
        return None
    for worker_root in sorted(root.glob("worker_*")):
        candidate = worker_root / "accepted" / shape_id / "kernel.hip"
        if not candidate.is_file():
            continue
        manifest: Dict[str, Any] = {}
        try:
            manifest = json.loads(
                (candidate.parent / "manifest.json").read_text(encoding="utf-8")
            )
        except (OSError, ValueError):
            manifest = {}
        return {
            "path": candidate,
            "manifest": manifest,
            "metrics": dict(manifest.get("metrics") or {}),
            "commit": str(manifest.get("commit") or ""),
            "shape": dict(manifest.get("shape") or {}),
        }
    return None


def _baseline_us(workspace_dir: Path, shape_id: str,
                 shape_params: Dict[str, Any]) -> Optional[float]:
    """Baseline for the recorded speedup: task table first, fixed table next."""
    report = workspace_dir / "final_report.json"
    if report.is_file():
        try:
            initial = (json.loads(report.read_text(encoding="utf-8"))
                       .get("initial_metrics") or {})
        except (OSError, ValueError):
            initial = {}
        entry = initial.get(shape_id)
        if isinstance(entry, dict) and entry.get("median_us"):
            return float(entry["median_us"])
        if isinstance(entry, (int, float)):
            return float(entry)
    try:
        from .w8a8_baselines import fixed_triton_graph_baseline
        params = dict(shape_params or {})
        return float(fixed_triton_graph_baseline(shape_id, params)["median_us"])
    except Exception:  # noqa: BLE001 - baseline is advisory
        return None


def promote_variant(
    *,
    workspace_dir: Path,
    answers: Dict[str, Any],
    shape_id: str,
    source_task: str = "",
    correctness_ok: Optional[bool] = None,
    min_improvement_percent: float = 0.0,
    tp: Optional[int] = None,
    m: Optional[int] = None,
    model_label: Optional[str] = None,
    dry_run: bool = False,
) -> Dict[str, Any]:
    """Promote one accepted kernel into the shared variant tree.

    Returns a structured outcome with ``action`` one of ``added`` | ``updated``
    | ``skipped`` | ``rejected`` | ``no_kernel`` (or ``would-add`` /
    ``would-update`` when ``dry_run``), plus old/new medians and improvement.
    """
    workspace_dir = Path(workspace_dir)
    found = accepted_kernel_for(workspace_dir, shape_id)
    if found is None:
        return {"ok": False, "action": "no_kernel", "shape": shape_id,
                "reason": f"no accepted kernel under {workspace_dir}"}
    metrics = dict(found["metrics"])
    new_median = metrics.get("median_us")
    if correctness_ok is False:
        return {"ok": False, "action": "skipped", "shape": shape_id,
                "reason": "correctness failed for this candidate",
                "new_median_us": new_median}
    if new_median is None:
        return {"ok": False, "action": "skipped", "shape": shape_id,
                "reason": "accepted manifest carries no median_us"}

    answers_eff = dict(answers or {})
    label = model_label or model_label_for(
        shape_id, str(answers_eff.get("model") or ""))
    if label:
        answers_eff["model"] = label
    meta = derive_variant_meta(answers_eff, shape_id)
    if tp is not None:
        meta["tp"] = int(tp)
    if m is not None:
        meta["m"] = int(m)

    target = variant_path(meta)
    old_median: Optional[float] = None
    if target.is_file():
        try:
            header = _parse_variant_header(
                target.read_text(encoding="utf-8", errors="replace"))
            value = header.get("median_us")
            old_median = float(value) if value is not None else None
        except OSError:
            old_median = None

    improvement: Optional[float] = None
    if old_median and new_median:
        improvement = (old_median - float(new_median)) / old_median * 100.0
        if improvement < float(min_improvement_percent):
            return {
                "ok": True, "action": "skipped", "shape": shape_id,
                "reason": (f"improvement {improvement:.2f}% < required "
                           f"{float(min_improvement_percent):.2f}%"),
                "old_median_us": old_median, "new_median_us": float(new_median),
                "improvement_percent": improvement, "path": str(target),
                "meta": meta,
            }

    baseline = _baseline_us(workspace_dir, shape_id, found["shape"])
    if baseline and metrics.get("median_us"):
        metrics["baseline_us"] = baseline
        metrics["speedup"] = float(baseline) / float(metrics["median_us"])

    if dry_run:
        return {
            "ok": True,
            "action": "would-update" if target.is_file() else "would-add",
            "shape": shape_id, "reason": "dry-run: no write performed",
            "old_median_us": old_median, "new_median_us": float(new_median),
            "improvement_percent": improvement,
            "baseline_us": metrics.get("baseline_us"),
            "speedup": metrics.get("speedup"),
            "path": str(target), "meta": meta,
        }

    try:
        result = add_variant(
            meta=meta,
            kernel_source=found["path"].read_text(encoding="utf-8",
                                                  errors="replace"),
            commit=found["commit"],
            metrics=metrics,
            source_task=source_task,
            backup=True,
            reject_slower_than_existing=True,
        )
    except ValueError as exc:
        return {"ok": False, "action": "rejected", "shape": shape_id,
                "reason": str(exc), "old_median_us": old_median,
                "new_median_us": float(new_median),
                "improvement_percent": improvement, "path": str(target),
                "meta": meta}
    return {
        "ok": True, "action": result["action"], "shape": shape_id,
        "reason": "",
        "old_median_us": old_median, "new_median_us": float(new_median),
        "improvement_percent": improvement,
        "baseline_us": metrics.get("baseline_us"),
        "speedup": metrics.get("speedup"),
        "path": result["path"], "backup": result.get("backup"),
        "meta": meta,
    }
