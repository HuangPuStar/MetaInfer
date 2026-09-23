"""Publish gate: promote an AHE experiment's champion into production DKAO.

Nothing is ever written to the production DKAO automatically. Publish only
happens through this explicit gate, and only when the requested evidence is on
disk:

Harness publish (champion -> dcu_kernel_auto_opt/harness_default):
  required: a promoted iteration (verdict PROMOTE / PROMOTE_UNEXPLAINED) with a
            held-out gate that did NOT fail; target dir is backed up first and
            a publish_log.jsonl record is appended for rollback.

Kernel publish (new best-knowns -> registered pool):
  scans AHE child DKAO runs for final-success shapes whose median beats the pool
  best_known; the pool YAML is backed up, then best_known/history are updated.

Every publish creates a timestamped backup of the destination before writing.
"""

from __future__ import annotations

import json
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import yaml

from .attribution import copy_tree, replace_tree, save_json

PUBLISH_LOG = "publish_log.jsonl"
_PROMOTABLE = {"PROMOTE", "PROMOTE_UNEXPLAINED"}


def _ts() -> str:
    return time.strftime("%Y%m%d-%H%M%S")


def _backup(path: Path, suffix: str) -> Path:
    """Copy destination into a timestamped backup (keep production live)."""
    if not path.exists():
        return path  # nothing to back up yet
    backup = path.parent / f"{path.name}.{suffix}-{_ts()}"
    if path.is_dir():
        copy_tree(path, backup)
    else:
        backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, backup)
    return backup


def _decision_at(exp: Path, iteration: int) -> Optional[Dict[str, Any]]:
    path = exp / "runs" / f"iteration_{iteration:03d}" / "input" / "decision.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _best_ever(exp: Path) -> Optional[Dict[str, Any]]:
    path = exp / "best_ever.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def check_publishable(exp: Path) -> Dict[str, Any]:
    """Validate the experiment carries promotable, non-overfit evidence."""
    best = _best_ever(exp)
    if not best:
        return {"ok": False, "errors": ["no best_ever.json (nothing promoted)"]}
    iteration = int(best.get("iteration", 0))
    decision = _decision_at(exp, iteration)
    if not decision:
        return {"ok": False, "errors": [f"no decision.json at iteration {iteration}"]}
    verdict = decision.get("verdict")
    errors: List[str] = []
    if verdict not in _PROMOTABLE:
        errors.append(f"iteration {iteration} verdict {verdict!r} is not promotable")
    held = ((decision.get("heldout_gate") or {}).get("status"))
    if held == "FAIL":
        errors.append("held-out gate failed (overfit guard)")
    snapshot = best.get("snapshot_dir")
    if not snapshot or not Path(snapshot).is_dir():
        errors.append("best snapshot dir missing")
    if errors:
        return {"ok": False, "errors": errors}
    return {
        "ok": True,
        "iteration": iteration,
        "verdict": verdict,
        "snapshot_dir": str(snapshot),
        "workspace_revision": best.get("workspace_revision"),
    }


def publish_harness(exp: Path, *, target: Path, reason: str = "explicit publish"
                    ) -> Dict[str, Any]:
    """Copy the champion harness snapshot over the production default seed."""
    gate = check_publishable(exp)
    if not gate["ok"]:
        return {"ok": False, "errors": gate["errors"], "published": False}
    source = Path(gate["snapshot_dir"])
    backup = _backup(target, "pre-publish")
    replace_tree(source, target)
    record = {
        "ts": time.time(),
        "kind": "harness",
        "iteration": gate["iteration"],
        "verdict": gate["verdict"],
        "source_snapshot": str(source),
        "workspace_revision": gate.get("workspace_revision"),
        "target": str(target),
        "backup": str(backup) if backup != target else None,
        "reason": reason,
    }
    _append_log(exp, record)
    return {"ok": True, "published": True, "record": record}


def _child_reports(exp: Path) -> List[Tuple[str, Dict[str, Any]]]:
    reports: List[Tuple[str, Dict[str, Any]]] = []
    for path in sorted((exp / "children").glob("*/*/workspace/final_report.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(data, dict):
            reports.append((str(path), data))
    return reports


def publish_kernels(exp: Path, *, pool_path: Path, reason: str = "explicit publish"
                    ) -> Dict[str, Any]:
    """Update pool best_known/history from final-success child DKAO runs."""
    if not pool_path.is_file():
        return {"ok": False, "published": False,
                "errors": [f"pool file missing: {pool_path}"]}
    try:
        data = yaml.safe_load(pool_path.read_text(encoding="utf-8")) or {}
    except (OSError, ValueError) as exc:
        return {"ok": False, "published": False, "errors": [str(exc)]}
    instances = {i["id"]: i for i in data.get("instances", [])}
    updated: List[str] = []
    for src, report in _child_reports(exp):
        if report.get("status") != "success":
            continue
        final = report.get("final_validation") or {}
        config = report.get("config") or {}
        for shape in config.get("shapes", []) or []:
            sid = str(shape.get("id") or "")
            entry = instances.get(sid)
            metrics = final.get(sid) or {}
            median = metrics.get("median_us")
            if (
                entry is None
                or not isinstance(median, (int, float))
                or median <= 0
            ):
                continue
            best = entry.get("best_known_us")
            if best is None or float(median) < float(best):
                entry["best_known_us"] = float(median)
                hist = entry.setdefault("history", [])
                hist.append({
                    "accepted": True,
                    "median_us": float(median),
                    "p90_us": metrics.get("p90_us"),
                    "source_report": src,
                })
                updated.append(sid)
    if not updated:
        return {"ok": True, "published": False, "updated": [],
                "record": {"kind": "kernels", "reason": reason}}
    backup = _backup(pool_path, "pre-publish")
    pool_path.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True),
                         encoding="utf-8")
    record = {
        "ts": time.time(),
        "kind": "kernels",
        "updated": updated,
        "target": str(pool_path),
        "backup": str(backup) if backup != pool_path else None,
        "reason": reason,
    }
    _append_log(exp, record)
    return {"ok": True, "published": True, "updated": updated, "record": record}


def _append_log(exp: Path, record: Dict[str, Any]) -> None:
    with (exp / PUBLISH_LOG).open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False) + "\n")
