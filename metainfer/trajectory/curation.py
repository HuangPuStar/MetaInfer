"""Curated trajectory datasets and failure-pattern summaries.

Annotations are the authority for labels; datasets are immutable snapshots
created from those labels.  A dataset stores compact evidence (session identity,
metrics, deterministic findings, annotation), not the full event log, so it can
be used later for evaluation and skill-improvement proposals without copying
sensitive trajectories around.
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

from .annotations import read_annotation
from .evaluation import list_evaluations
from .proposals import list_proposals
from .regression import list_regressions
from .skills import list_releases, list_skills

DATASET_VERSION = 1
_DATASET_ID = re.compile(r"^traj-ds-[A-Za-z0-9._-]{1,160}$")


def datasets_dir() -> Path:
    return _paths.home_dir() / "trajectory" / "datasets"


def _compact(session: Dict[str, Any], annotation: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "sessionId": session.get("id"),
        "title": session.get("title"),
        "cwd": session.get("cwd"),
        "createdAt": session.get("createdAt"),
        "updatedAt": session.get("updatedAt"),
        "status": session.get("status"),
        "agentPreset": session.get("agentPreset"),
        "context": session.get("context"),
        "provider": session.get("provider"),
        "model": session.get("model"),
        "turns": session.get("turns"),
        "steps": session.get("steps"),
        "toolCalls": session.get("toolCalls"),
        "toolErrors": session.get("toolErrors"),
        "tokens": session.get("tokens"),
        "durationMs": session.get("durationMs"),
        "findings": (session.get("analysis") or {}).get("findings") or [],
        "hasStructuredOutput": bool((session.get("analysis") or {}).get("hasStructuredOutput")),
        "toolSuccessRate": (session.get("analysis") or {}).get("toolSuccessRate"),
        "annotation": {
            "outcome": annotation.get("outcome"),
            "failureCategory": annotation.get("failureCategory"),
            "tags": annotation.get("tags") or [],
            "notes": annotation.get("notes") or "",
            "reviewer": annotation.get("reviewer") or "",
            "updatedAt": annotation.get("updatedAt"),
        },
    }


def reviewed_sessions(service: Any, limit: int = 1000) -> List[Dict[str, Any]]:
    listing = service.list_sessions(query="", limit=limit)
    reviewed: List[Dict[str, Any]] = []
    for session in listing.get("sessions", []):
        annotation = read_annotation(session.get("id", ""))
        if annotation.get("outcome") == "unreviewed":
            continue
        reviewed.append(_compact(session, annotation))
    return reviewed


def curation_summary(service: Any) -> Dict[str, Any]:
    listing = service.list_sessions(query="", limit=1000)
    sessions: List[Dict[str, Any]] = []
    outcomes: Dict[str, int] = {"pass": 0, "fail": 0, "uncertain": 0}
    categories: Dict[str, List[str]] = {}
    tags: Dict[str, List[str]] = {}
    for session in listing.get("sessions", []):
        session_id = str(session.get("id") or "")
        annotation = read_annotation(session_id)
        if annotation.get("outcome") == "unreviewed":
            continue
        compact = _compact(session, annotation)
        sessions.append(compact)
        outcome = annotation.get("outcome")
        if outcome in outcomes:
            outcomes[outcome] += 1
        category = str(annotation.get("failureCategory") or "").strip()
        if category:
            categories.setdefault(category, []).append(session_id)
        for tag in annotation.get("tags") or []:
            tags.setdefault(tag, []).append(session_id)
    failure_patterns = [
        {"failureCategory": name, "count": len(ids), "sessionIds": ids}
        for name, ids in sorted(categories.items(), key=lambda item: (-len(item[1]), item[0]))
    ]
    tag_patterns = [
        {"tag": name, "count": len(ids), "sessionIds": ids}
        for name, ids in sorted(tags.items(), key=lambda item: (-len(item[1]), item[0]))
    ]
    return {
        "totalSessions": listing.get("total"),
        "reviewed": len(sessions),
        "outcomes": outcomes,
        "failurePatterns": failure_patterns,
        "tagPatterns": tag_patterns,
        "sessions": sessions[:300],
        "datasets": list_datasets(),
        "proposals": list_proposals(),
        "evaluations": list_evaluations(),
        "skills": list_skills(),
        "regressions": list_regressions(),
        "releases": list_releases(),
    }


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def create_dataset(
    service: Any,
    name: str,
    *,
    include_uncertain: bool = False,
) -> Dict[str, Any]:
    label = str(name or "").strip()[:120]
    if not label:
        raise ValueError("dataset name is required")
    allowed = {"pass", "fail"} | ({"uncertain"} if include_uncertain else set())
    items = [item for item in reviewed_sessions(service) if item["annotation"]["outcome"] in allowed]
    if not items:
        raise ValueError("no reviewed sessions match the selected outcomes")
    for item in items:
        # Add a stable source path for evidence navigation, not the full log.
        try:
            detail = service.get_session(item["sessionId"])
            item["sourcePath"] = detail.get("path")
            item["fileMtime"] = detail.get("fileMtime")
        except Exception:  # noqa: BLE001 - a live session may disappear
            item["sourcePath"] = None
            item["fileMtime"] = None
    dataset_id = f"traj-ds-{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}"
    counts: Dict[str, int] = {}
    for item in items:
        outcome = item["annotation"]["outcome"]
        counts[outcome] = counts.get(outcome, 0) + 1
    dataset = {
        "version": DATASET_VERSION,
        "id": dataset_id,
        "name": label,
        "createdAt": int(time.time() * 1000),
        "source": "dsh",
        "includeUncertain": bool(include_uncertain),
        "counts": counts,
        "items": items,
    }
    _write_json(datasets_dir() / f"{dataset_id}.json", dataset)
    return dataset


def _dataset_file(dataset_id: str) -> Path:
    value = str(dataset_id or "")
    if not _DATASET_ID.match(value):
        raise KeyError(f"dataset not found: {value}")
    return datasets_dir() / f"{value}.json"


def list_datasets() -> List[Dict[str, Any]]:
    root = datasets_dir()
    if not root.is_dir():
        return []
    output: List[Dict[str, Any]] = []
    for path in root.glob("traj-ds-*.json"):
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(raw, dict):
            continue
        output.append({
            "id": raw.get("id"),
            "name": raw.get("name"),
            "createdAt": raw.get("createdAt"),
            "counts": raw.get("counts") or {},
            "count": len(raw.get("items") or []),
            "includeUncertain": bool(raw.get("includeUncertain")),
        })
    output.sort(key=lambda item: int(item.get("createdAt") or 0), reverse=True)
    return output


def get_dataset(dataset_id: str) -> Dict[str, Any]:
    path = _dataset_file(dataset_id)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise KeyError(f"dataset not found: {dataset_id}") from exc
    if not isinstance(raw, dict):
        raise KeyError(f"dataset not found: {dataset_id}")
    return raw
