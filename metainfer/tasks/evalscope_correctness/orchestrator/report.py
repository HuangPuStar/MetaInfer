"""Normalize EvalScope outputs into ``result.json``.

The single authority for a run's correctness outcome is
``state_dir/result.json`` (written atomically by the supervisor). Raw
EvalScope files under the workspace are immutable evidence only — this
module reads them and derives the normalized result, but never mutates
them.

Two independent judgments live in the result:

* **Completeness** (``complete``) — did EvalScope evaluate every sample
  cleanly? Fails on a malformed prediction row, a per-row model error, a
  missing/unschema'd report, a sample-count mismatch, or any
  ``choices[].stop_reason == "length"`` truncation. A truncated sample must
  be re-run with a higher ``max_tokens``; it must never silently contribute
  to a final correctness number.
* **Quality gate** (``quality``) — optional per-dataset minimums the user
  configured. A complete run may still FAIL its quality gate; that is a
  *legitimate result*, not a run failure. Only infra/config/incomplete
  outcomes make ``run.json.final_status == "stopped"``.

Primary-metric selection is by **full identity** (name + aggregation +
dimensions), never by ``metrics[0]`` order. For the preset datasets the rule
is fixed; for custom datasets we honor the report's own
``primary_metric_identity`` when it resolves to a real metric, else the
first metric.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

# Human-readable metric id → EvalScope metric identity.
ACC_MEAN = {"name": "accuracy", "aggregation": "mean", "dimensions": {}}
PASS_AT_1 = {"name": "accuracy", "aggregation": "pass_at_k", "dimensions": {"k": 1}}

# Fixed primary-metric rules for the built-in presets.
PRESET_PRIMARY_IDENTITY = {
    "gsm8k": ACC_MEAN,
    "gpqa_diamond": ACC_MEAN,
    "humaneval": PASS_AT_1,
}

# Report schema versions this normalizer understands.
SUPPORTED_SCHEMA_VERSION = 2


class ReportError(ValueError):
    """A report/prediction set could not be normalized into a dataset row."""


# --------------------------------------------------------------------------- #
# Identity helpers
# --------------------------------------------------------------------------- #

def identity_key(identity: Optional[Dict[str, Any]]) -> Tuple:
    """Stable, comparable key for a metric identity dict."""
    if not isinstance(identity, dict):
        return ()
    dims = identity.get("dimensions") or {}
    return (
        identity.get("name"),
        identity.get("aggregation"),
        tuple(sorted((str(k), str(v)) for k, v in dims.items())),
    )


def find_metric(
    metrics: Sequence[Dict[str, Any]], identity: Dict[str, Any]
) -> Optional[Dict[str, Any]]:
    """Return the metric whose identity matches ``identity`` exactly."""
    want = identity_key(identity)
    for m in metrics:
        if identity_key(m.get("identity")) == want:
            return m
    return None


def metric_id(identity: Dict[str, Any]) -> str:
    """Short human label, e.g. ``accuracy/mean`` or ``accuracy/pass_at_k(k=1)``."""
    agg = identity.get("aggregation", "?")
    dims = identity.get("dimensions") or {}
    if dims:
        extra = ", ".join(f"{k}={v}" for k, v in sorted(dims.items()))
        return f"{identity.get('name', '?')}/{agg}({extra})"
    return f"{identity.get('name', '?')}/{agg}"


def primary_identity_for(
    report: Dict[str, Any], dataset: str
) -> Optional[Dict[str, Any]]:
    """Resolve the primary metric identity for a report.

    Order:
      1. The report's own ``primary_metric_identity``, if it resolves to a
         real metric in ``report['metrics']``.
      2. The fixed preset rule (gsm8k / gpqa_diamond / humaneval).
      3. ``metrics[0]`` identity (custom datasets without a primary id).
    """
    metrics = report.get("metrics") or []
    declared = report.get("primary_metric_identity")
    if isinstance(declared, dict) and find_metric(metrics, declared) is not None:
        return declared
    preset = PRESET_PRIMARY_IDENTITY.get(dataset)
    if preset is not None:
        return preset
    if metrics:
        ident = metrics[0].get("identity")
        if isinstance(ident, dict):
            return ident
    return None


def extract_primary(
    report: Dict[str, Any], dataset: str
) -> Tuple[Optional[Dict[str, Any]], Optional[float], Optional[int]]:
    """Return ``(identity, score, num)`` for the primary metric.

    ``score``/``num`` are None if the primary metric cannot be located or
    has no score — the caller treats that as an incomplete dataset.
    """
    identity = primary_identity_for(report, dataset)
    if identity is None:
        return None, None, None
    metric = find_metric(report.get("metrics") or [], identity)
    if metric is None:
        return identity, None, None
    score = metric.get("score")
    if not isinstance(score, (int, float)):
        score = None
    return identity, score, metric.get("num")


# --------------------------------------------------------------------------- #
# Prediction-row analysis
# --------------------------------------------------------------------------- #

def classify_row(row: Any) -> str:
    """Classify one parsed prediction row: ``ok`` | ``error`` | ``truncated``.

    An explicit model error beats truncation; otherwise a stop_reason of
    ``"length"`` marks the row truncated. A non-dict row is ``malformed``
    (a defensive case — the loader already filters to JSON objects).
    """
    if not isinstance(row, dict):
        return "malformed"
    if row.get("error"):
        return "error"
    model_output = row.get("model_output")
    if isinstance(model_output, dict) and model_output.get("error"):
        return "error"
    choices = model_output.get("choices") if isinstance(model_output, dict) else None
    if isinstance(choices, list) and choices:
        first = choices[0]
        if isinstance(first, dict) and first.get("stop_reason") == "length":
            return "truncated"
    return "ok"


def analyze_rows(rows: Sequence[Any], parse_failures: int = 0) -> Dict[str, int]:
    """Tally row classifications + unparseable JSONL lines."""
    counts = {
        "total": len(rows),
        "ok": 0,
        "error": 0,
        "truncated": 0,
        "malformed": parse_failures,
    }
    for row in rows:
        cls = classify_row(row)
        if cls not in counts:
            cls = "malformed"
        counts[cls] += 1
    return counts


def _trim_perf(report: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Bounded, rounded performance summary from the report (may be None)."""
    summary = (report.get("perf_metrics") or {}).get("summary")
    if not isinstance(summary, dict):
        return None

    def _rounded(value: Any) -> Any:
        if isinstance(value, dict):
            return {k: _rounded(v) for k, v in value.items()}
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return round(float(value), 4)
        return value

    out = {k: _rounded(v) for k, v in summary.items()}
    latency = out.get("latency")
    if isinstance(latency, dict):
        out["latency"] = {
            k: latency[k] for k in ("mean", "p99") if k in latency
        }
    return out


# --------------------------------------------------------------------------- #
# Per-dataset normalization
# --------------------------------------------------------------------------- #

def normalize_dataset(
    report: Dict[str, Any],
    rows: Sequence[Any],
    *,
    dataset: str,
    threshold: Optional[float] = None,
    raw_relative: Optional[str] = None,
    parse_failures: int = 0,
) -> Dict[str, Any]:
    """Turn a parsed report + prediction rows into one dataset result dict.

    Pure function — no I/O, easy to unit test with fixtures. Raises
    :class:`ReportError` only if the report is not an EvalScope-shaped JSON
    object (no ``metrics`` list).
    """
    if not isinstance(report, dict):
        raise ReportError("report is not a JSON object")
    if not isinstance(report.get("metrics"), list):
        raise ReportError("report has no 'metrics' list (not an EvalScope report)")

    reasons: List[str] = []
    schema_version = report.get("schema_version")
    if not isinstance(schema_version, int) or schema_version < SUPPORTED_SCHEMA_VERSION:
        reasons.append(
            f"report schema_version {schema_version!r} < {SUPPORTED_SCHEMA_VERSION}"
        )

    identity, score, num = extract_primary(report, dataset)
    if identity is None:
        reasons.append("could not determine primary metric")
    elif score is None:
        reasons.append("primary metric has no score")

    counts = analyze_rows(rows, parse_failures=parse_failures)
    if counts["malformed"]:
        reasons.append(f"{counts['malformed']} malformed prediction line(s)")
    if counts["error"]:
        reasons.append(f"{counts['error']} prediction(s) had model errors")
    if counts["truncated"]:
        reasons.append(
            f"{counts['truncated']} sample(s) truncated (stop_reason='length'); "
            "re-run with a higher max_tokens"
        )

    execution = report.get("execution_summary") or {}
    requested = execution.get("requested")
    if requested is not None and requested != counts["total"]:
        reasons.append(
            f"sample-count mismatch: report requested {requested}, "
            f"found {counts['total']} prediction line(s)"
        )

    complete = not reasons
    threshold_met: Optional[bool] = None
    if threshold is not None:
        # A truncated/incomplete run must never silently "pass" its gate: the
        # quality verdict only counts against a fully-executed evaluation.
        threshold_met = (
            complete and score is not None and float(score) >= float(threshold)
        )

    return {
        "dataset": dataset,
        "status": "complete" if complete else "incomplete",
        "complete": complete,
        "has_report": True,
        "primary_metric": metric_id(identity) if identity else None,
        "primary_metric_identity": identity,
        "score": score,
        "num": num,
        "requested": requested if requested is not None else counts["total"],
        "predicted": counts["total"],
        "errored": counts["error"],
        "truncated": counts["truncated"],
        "malformed": counts["malformed"],
        "threshold": threshold,
        "threshold_met": threshold_met,
        "performance": _trim_perf(report),
        "reasons": reasons,
        "raw_relative": raw_relative,
    }


def missing_dataset_row(
    dataset: str,
    *,
    threshold: Optional[float] = None,
    reason: str = "no EvalScope report/predictions produced",
) -> Dict[str, Any]:
    """Dataset result for a target EvalScope never produced artifacts for."""
    return {
        "dataset": dataset,
        "status": "incomplete",
        "complete": False,
        "has_report": False,
        "primary_metric": None,
        "primary_metric_identity": None,
        "score": None,
        "num": None,
        "requested": None,
        "predicted": 0,
        "errored": 0,
        "truncated": 0,
        "malformed": 0,
        "threshold": threshold,
        "threshold_met": None,
        "performance": None,
        "reasons": [reason],
        "raw_relative": None,
    }


# --------------------------------------------------------------------------- #
# I/O helpers (thin; kept out of the pure core above)
# --------------------------------------------------------------------------- #

def load_predictions(file_paths: Iterable[Path]) -> Tuple[List[Any], int]:
    """Parse prediction JSONL rows, returning ``(rows, parse_failures)``."""
    rows: List[Any] = []
    failures = 0
    for path in file_paths:
        try:
            with path.open(encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rows.append(json.loads(line))
                    except ValueError:
                        failures += 1
        except OSError:
            failures += 1
    return rows, failures


def locate_report(report_root: Path, dataset: str) -> Optional[Path]:
    """Find the EvalScope report file whose ``dataset_name`` matches.

    Matches by content (``dataset_name``), not filename — the file lives
    under a ``<model_id>/`` subdir that varies with the request.
    """
    if not report_root.is_dir():
        return None
    for path in sorted(report_root.rglob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            continue
        if isinstance(data, dict) and data.get("dataset_name") == dataset:
            return path
    return None


def load_report_file(path: Path) -> Dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def normalize_attempt_dir(
    attempt_dir: Path,
    dataset: str,
    *,
    threshold: Optional[float] = None,
    raw_relative: Optional[str] = None,
) -> Dict[str, Any]:
    """Normalize one EvalScope attempt dir into a dataset result row.

    Thin glue: locate + parse the report and predictions EvalScope wrote
    into ``attempt_dir``, then run the pure :func:`normalize_dataset`.
    Returns a :func:`missing_dataset_row` when EvalScope produced no report.
    """
    report_path = locate_report(attempt_dir / "reports", dataset)
    if report_path is None:
        return missing_dataset_row(
            dataset, threshold=threshold,
            reason="no EvalScope report produced for this dataset",
        )
    report = load_report_file(report_path)
    pred_files = locate_predictions(attempt_dir / "predictions", dataset)
    rows, failures = load_predictions(pred_files)
    return normalize_dataset(
        report,
        rows,
        dataset=dataset,
        threshold=threshold,
        raw_relative=raw_relative,
        parse_failures=failures,
    )


def locate_predictions(pred_root: Path, dataset: str) -> List[Path]:
    """Return the prediction JSONL files for a dataset.

    File layout varies (``<model_id>/<dataset>_<subset>.jsonl``), so we match
    by filename prefix first, then fall back to the first row's
    ``metadata.task_id`` ("<Dataset>/<n>").
    """
    if not pred_root.is_dir():
        return []
    matched = []
    for path in sorted(pred_root.rglob("*.jsonl")):
        if _prediction_matches_dataset(path, dataset):
            matched.append(path)
    return matched


def _prediction_matches_dataset(path: Path, dataset: str) -> bool:
    if path.name.startswith(dataset + "_") or path.name == dataset + ".jsonl":
        return True
    try:
        with path.open(encoding="utf-8") as fh:
            for line in fh:
                if not line.strip():
                    continue
                try:
                    first = json.loads(line)
                except ValueError:
                    return False
                task_id = (first.get("metadata") or {}).get("task_id") or ""
                return task_id.startswith(dataset + "/")
    except OSError:
        return False
    return False
