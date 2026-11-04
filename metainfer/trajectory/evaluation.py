"""Deterministic evaluation of curated trajectory datasets.

The first evaluator is intentionally simple: it predicts pass from observable
session facts and compares that prediction with the human labels.  It is a
baseline, not a judge of a new skill.  Reports are immutable JSON snapshots so
later skill versions can be compared against the same frozen dataset.
"""

from __future__ import annotations

import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from metainfer.server import paths as _paths

EVALUATION_VERSION = 1
EVALUATION_ID = re.compile(r"^traj-eval-[A-Za-z0-9._-]{1,160}$")
RULE_BASELINE = "baseline_v1"
RULE_PROPOSAL = "proposal_v1"
RULES = (RULE_BASELINE, RULE_PROPOSAL)


def evaluations_dir() -> Path:
    return _paths.home_dir() / "trajectory" / "evaluations"


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def _ratio(numerator: int, denominator: int) -> Optional[float]:
    return (numerator / denominator) if denominator else None


def _predict(item: Dict[str, Any], rule: str) -> tuple[bool, str]:
    if rule not in RULES:
        raise ValueError(f"unknown evaluation rule: {rule}")
    status = str(item.get("status") or "")
    try:
        errors = int(item.get("toolErrors") or 0)
    except (TypeError, ValueError):
        errors = 0
    if status != "completed":
        return False, f"status={status or 'unknown'}"
    if errors > 0:
        return False, f"toolErrors={errors}"
    if rule == RULE_PROPOSAL and not bool(item.get("hasStructuredOutput")):
        return False, "no structured output evidence"
    return True, "completed with no tool errors" + (" and structured evidence" if rule == RULE_PROPOSAL else "")


def evaluate_dataset(dataset: Dict[str, Any], rule: str = RULE_BASELINE) -> Dict[str, Any]:
    if rule not in RULES:
        raise ValueError(f"rule must be one of {', '.join(RULES)}")
    items: List[Dict[str, Any]] = []
    counts = {"tp": 0, "tn": 0, "fp": 0, "fn": 0}
    labeled = 0
    for item in dataset.get("items") or []:
        annotation = item.get("annotation") or {}
        label = str(annotation.get("outcome") or "")
        if label not in ("pass", "fail"):
            continue
        predicted, reason = _predict(item, rule)
        truth = label == "pass"
        if truth and predicted:
            counts["tp"] += 1
        elif not truth and not predicted:
            counts["tn"] += 1
        elif not truth and predicted:
            counts["fp"] += 1
        else:
            counts["fn"] += 1
        labeled += 1
        items.append({
            "sessionId": item.get("sessionId"),
            "title": item.get("title"),
            "humanOutcome": label,
            "predictedOutcome": "pass" if predicted else "fail",
            "correct": predicted == truth,
            "reason": reason,
            "failureCategory": annotation.get("failureCategory") or "",
        })
    correct = counts["tp"] + counts["tn"]
    precision = _ratio(counts["tp"], counts["tp"] + counts["fp"])
    recall = _ratio(counts["tp"], counts["tp"] + counts["fn"])
    f1 = _ratio(2 * precision * recall, precision + recall) if precision is not None and recall is not None and (precision + recall) > 0 else None
    metrics = {
        "labeled": labeled,
        "correct": correct,
        "accuracy": _ratio(correct, labeled),
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "confusion": counts,
        "mismatches": [entry for entry in items if not entry["correct"]],
    }
    evaluation_id = f"traj-eval-{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}"
    return {
        "version": EVALUATION_VERSION,
        "id": evaluation_id,
        "createdAt": int(time.time() * 1000),
        "datasetId": dataset.get("id"),
        "datasetName": dataset.get("name"),
        "rule": rule,
        "metrics": metrics,
        "items": items,
    }


def save_evaluation(report: Dict[str, Any]) -> Dict[str, Any]:
    path = evaluations_dir() / f"{report['id']}.json"
    _write_json(path, report)
    return report


def evaluate_and_save(dataset: Dict[str, Any], rule: str = RULE_BASELINE) -> Dict[str, Any]:
    report = evaluate_dataset(dataset, rule)
    return save_evaluation(report)


def list_evaluations() -> List[Dict[str, Any]]:
    root = evaluations_dir()
    if not root.is_dir():
        return []
    output: List[Dict[str, Any]] = []
    for path in root.glob("traj-eval-*.json"):
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(raw, dict):
            continue
        metrics = raw.get("metrics") or {}
        output.append({
            "id": raw.get("id"),
            "createdAt": raw.get("createdAt"),
            "datasetId": raw.get("datasetId"),
            "datasetName": raw.get("datasetName"),
            "rule": raw.get("rule"),
            "labeled": metrics.get("labeled"),
            "accuracy": metrics.get("accuracy"),
            "precision": metrics.get("precision"),
            "recall": metrics.get("recall"),
            "f1": metrics.get("f1"),
        })
    output.sort(key=lambda item: int(item.get("createdAt") or 0), reverse=True)
    return output


def get_evaluation(evaluation_id: str) -> Dict[str, Any]:
    value = str(evaluation_id or "")
    if not EVALUATION_ID.match(value):
        raise KeyError(f"evaluation not found: {value}")
    path = evaluations_dir() / f"{value}.json"
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise KeyError(f"evaluation not found: {value}") from exc
    if not isinstance(raw, dict):
        raise KeyError(f"evaluation not found: {value}")
    return raw
