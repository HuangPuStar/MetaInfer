"""Human curation records for DSH trajectories.

Each annotation is a single JSON file keyed by session id.  The file is the
authority for the curated labels; the viewer only derives display state from it.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, List

from metainfer.server import paths as _paths

ANNOTATION_VERSION = 1
OUTCOMES = ("unreviewed", "pass", "fail", "uncertain")
_SESSION_ID = re.compile(r"^[A-Za-z0-9._-]{1,200}$")


def _safe_session_id(session_id: str) -> str:
    value = str(session_id or "").strip()
    if _SESSION_ID.match(value):
        return value
    return "sha256-" + hashlib.sha256(value.encode("utf-8")).hexdigest()[:32]


def annotation_path(session_id: str) -> Path:
    return _paths.home_dir() / "trajectory" / "annotations" / f"{_safe_session_id(session_id)}.json"


def default_annotation(session_id: str) -> Dict[str, Any]:
    return {
        "version": ANNOTATION_VERSION,
        "sessionId": str(session_id),
        "outcome": "unreviewed",
        "failureCategory": "",
        "tags": [],
        "notes": "",
        "reviewer": "",
        "updatedAt": None,
    }


def read_annotation(session_id: str) -> Dict[str, Any]:
    path = annotation_path(session_id)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default_annotation(session_id)
    if not isinstance(raw, dict):
        return default_annotation(session_id)
    result = default_annotation(session_id)
    outcome = str(raw.get("outcome") or "unreviewed")
    result["outcome"] = outcome if outcome in OUTCOMES else "unreviewed"
    result["failureCategory"] = str(raw.get("failureCategory") or "")[:120]
    result["reviewer"] = str(raw.get("reviewer") or "")[:120]
    result["notes"] = str(raw.get("notes") or "")[:8000]
    tags = raw.get("tags")
    if isinstance(tags, list):
        result["tags"] = [str(tag)[:80] for tag in tags if str(tag).strip()][:12]
    result["updatedAt"] = raw.get("updatedAt") if isinstance(raw.get("updatedAt"), (int, float)) else None
    return result


def _clean_tags(value: Any) -> List[str]:
    if isinstance(value, str):
        value = value.split(",")
    if not isinstance(value, list):
        return []
    tags: List[str] = []
    for item in value:
        tag = str(item).strip()[:80]
        if tag and tag not in tags:
            tags.append(tag)
    return tags[:12]


def write_annotation(session_id: str, payload: Any) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("annotation must be an object")
    current = read_annotation(session_id)
    outcome = str(payload.get("outcome", current["outcome"]) or "unreviewed")
    if outcome not in OUTCOMES:
        raise ValueError(f"outcome must be one of {', '.join(OUTCOMES)}")
    annotation = {
        "version": ANNOTATION_VERSION,
        "sessionId": str(session_id),
        "outcome": outcome,
        "failureCategory": str(payload.get("failureCategory", current["failureCategory"]) or "")[:120],
        "tags": _clean_tags(payload.get("tags", current["tags"])),
        "notes": str(payload.get("notes", current["notes"]) or "")[:8000],
        "reviewer": str(payload.get("reviewer", current["reviewer"]) or "")[:120],
        "updatedAt": int(time.time() * 1000),
    }
    path = annotation_path(session_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(annotation, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)
    return annotation
