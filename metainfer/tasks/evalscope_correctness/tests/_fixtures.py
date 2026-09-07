"""Compact EvalScope report/prediction fixtures for tests.

The shapes here mirror the schema EvalScope 1.11 actually writes (verified
against real report JSON): schema_version 2, a ``metrics`` list keyed by
full identity, ``primary_metric_identity``, and ``execution_summary``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional


def _acc_mean(num: int, score: float) -> Dict[str, Any]:
    return {
        "identity": {"name": "accuracy", "aggregation": "mean", "dimensions": {}},
        "score": score,
        "num": num,
    }


def _pass_at_k(num: int, score: float, k: int = 1) -> Dict[str, Any]:
    return {
        "identity": {
            "name": "accuracy", "aggregation": "pass_at_k", "dimensions": {"k": k},
        },
        "score": score,
        "num": num,
    }


def gsm8k_report(num: int = 8, score: float = 0.75) -> Dict[str, Any]:
    return {
        "schema_version": 2,
        "name": "gsm8k",
        "dataset_name": "gsm8k",
        "metrics": [_acc_mean(num, score)],
        "primary_metric_identity": {"name": "accuracy", "aggregation": "mean",
                                    "dimensions": {}},
        "execution_summary": {
            "requested": num, "succeeded": num, "errored": 0, "incomplete": False,
            "subsets": {"main": {"requested": num, "succeeded": num, "errored": 0}},
        },
    }


def humaneval_report(num: int = 8, score: float = 0.5) -> Dict[str, Any]:
    """HumanEval: mean + pass@1 present; primary is pass@1 (index 1)."""
    return {
        "schema_version": 2,
        "name": "humaneval",
        "dataset_name": "humaneval",
        "metrics": [_acc_mean(num, score), _pass_at_k(num, score, k=1)],
        "primary_metric_identity": {
            "name": "accuracy", "aggregation": "pass_at_k", "dimensions": {"k": 1},
        },
        "execution_summary": {
            "requested": num, "succeeded": num, "errored": 0, "incomplete": False,
            "subsets": {"openai_humaneval": {"requested": num, "succeeded": num,
                                             "errored": 0}},
        },
    }


def custom_report(dataset: str, num: int = 8, score: float = 0.6) -> Dict[str, Any]:
    """A dataset with no declared primary metric → normalizer uses metrics[0]."""
    return {
        "schema_version": 2,
        "name": dataset,
        "dataset_name": dataset,
        "metrics": [_acc_mean(num, score)],
        "primary_metric_identity": None,
        "execution_summary": {
            "requested": num, "succeeded": num, "errored": 0, "incomplete": False,
        },
    }


def pred_row(idx: int, dataset: str, stop: str = "stop",
             error: Optional[str] = None) -> Dict[str, Any]:
    row: Dict[str, Any] = {
        "index": idx,
        "model_output": {
            "choices": [{"stop_reason": stop}],
            "error": None,
        },
        "error": None,
    }
    if error is not None:
        row["error"] = error
    return row


def write_attempt(attempt_dir: Path, dataset: str, report: Dict[str, Any],
                  rows: List[Dict[str, Any]], *, filename_prefix: str,
                  model_id: str = "Q") -> Path:
    """Write an EvalScope-shaped attempt dir; returns the attempt dir."""
    reports = attempt_dir / "reports" / model_id
    preds = attempt_dir / "predictions" / model_id
    reports.mkdir(parents=True, exist_ok=True)
    preds.mkdir(parents=True, exist_ok=True)
    (reports / f"{dataset}.json").write_text(json.dumps(report), encoding="utf-8")
    with (preds / f"{filename_prefix}_{dataset}.jsonl").open("w") as fh:
        for row in rows:
            fh.write(json.dumps(row) + "\n")
    return attempt_dir
