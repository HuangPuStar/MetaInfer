"""Canary evidence for runtime-applied expert skills.

The runtime prompt overlay stamps a machine-readable release id into the DSH
session.  This module joins that provenance with the human annotation store so a
person can inspect how many canary sessions exist and how they were reviewed
before promoting the rollout.
"""

from __future__ import annotations

from typing import Any, Dict, List

from .annotations import read_annotation
from .skills import list_releases


def canary_report(skill_id: str, service: Any) -> Dict[str, Any]:
    releases = [
        release for release in list_releases()
        if release.get("skillId") == skill_id and release.get("status") in ("canary", "runtime_applied")
    ]
    sessions = service.list_sessions(limit=1000).get("sessions", [])
    output = []
    for release in releases:
        matched = []
        for session in sessions:
            overlays = session.get("skillOverlays") or []
            if not any(item.get("releaseId") == release.get("id") for item in overlays if isinstance(item, dict)):
                continue
            annotation = read_annotation(str(session.get("id") or ""))
            matched.append({
                "sessionId": session.get("id"),
                "title": session.get("title"),
                "status": session.get("status"),
                "outcome": annotation.get("outcome"),
                "failureCategory": annotation.get("failureCategory"),
            })
        outcomes = {"pass": 0, "fail": 0, "uncertain": 0, "unreviewed": 0}
        for item in matched:
            outcome = str(item.get("outcome") or "unreviewed")
            outcomes[outcome if outcome in outcomes else "unreviewed"] += 1
        output.append({
            "releaseId": release.get("id"),
            "status": release.get("status"),
            "canaryPercent": (release.get("target") or {}).get("canaryPercent"),
            "sessions": matched,
            "outcomes": outcomes,
        })
    return {"skillId": skill_id, "releases": output}


def promotion_readiness(
    skill_id: str,
    service: Any,
    *,
    min_labeled: int = 3,
    max_failure_rate: float = 0.5,
) -> Dict[str, Any]:
    report = canary_report(skill_id, service)
    release = None
    for candidate in report["releases"]:
        if candidate.get("status") == "canary":
            release = candidate
            break
    if release is None:
        return {
            "ready": False,
            "reasons": ["no active canary release; apply a canary before promoting"],
            "minLabeled": min_labeled,
            "maxFailureRate": max_failure_rate,
        }
    outcomes = release.get("outcomes") or {}
    passed = int(outcomes.get("pass") or 0)
    failed = int(outcomes.get("fail") or 0)
    uncertain = int(outcomes.get("uncertain") or 0)
    unreviewed = int(outcomes.get("unreviewed") or 0)
    labeled = passed + failed
    failure_rate = (failed / labeled) if labeled else None
    reasons: List[str] = []
    if labeled < min_labeled:
        reasons.append(f"needs at least {min_labeled} labeled canary sessions; currently {labeled}")
    if failure_rate is not None and failure_rate > max_failure_rate:
        reasons.append(
            f"canary failure rate {failure_rate:.0%} exceeds {max_failure_rate:.0%}"
        )
    return {
        "ready": not reasons,
        "releaseId": release.get("releaseId"),
        "status": release.get("status"),
        "canaryPercent": release.get("canaryPercent"),
        "labeled": labeled,
        "passed": passed,
        "failed": failed,
        "uncertain": uncertain,
        "unreviewed": unreviewed,
        "failureRate": failure_rate,
        "minLabeled": min_labeled,
        "maxFailureRate": max_failure_rate,
        "reasons": reasons or ["canary evidence meets the promotion gate"],
    }


def lab_canary_report(skill_id: str, service: Any) -> Dict[str, Any]:
    releases = [
        release for release in list_releases()
        if release.get("skillId") == skill_id
        and (release.get("labCanaryPercent") or release.get("labApplied"))
    ]
    sessions = service.list_sessions(limit=1000).get("sessions", [])
    output = []
    for release in releases:
        matched = []
        for session in sessions:
            overlays = session.get("skillOverlays") or []
            if not any(item.get("releaseId") == release.get("id") for item in overlays if isinstance(item, dict)):
                continue
            annotation = read_annotation(str(session.get("id") or ""))
            matched.append({
                "sessionId": session.get("id"),
                "title": session.get("title"),
                "projectId": (session.get("context") or {}).get("projectId"),
                "nodeId": (session.get("context") or {}).get("nodeId"),
                "outcome": annotation.get("outcome"),
                "failureCategory": annotation.get("failureCategory"),
            })
        outcomes = {"pass": 0, "fail": 0, "uncertain": 0, "unreviewed": 0}
        for item in matched:
            outcome = str(item.get("outcome") or "unreviewed")
            outcomes[outcome if outcome in outcomes else "unreviewed"] += 1
        output.append({
            "releaseId": release.get("id"),
            "status": release.get("status"),
            "canaryPercent": release.get("labCanaryPercent"),
            "applied": bool(release.get("labApplied")),
            "sessions": matched,
            "outcomes": outcomes,
        })
    return {"skillId": skill_id, "releases": output}


def lab_promotion_readiness(
    skill_id: str,
    service: Any,
    *,
    min_labeled: int = 3,
    max_failure_rate: float = 0.5,
) -> Dict[str, Any]:
    report = lab_canary_report(skill_id, service)
    release = None
    for candidate in report["releases"]:
        percent = int(candidate.get("canaryPercent") or 100)
        if percent < 100 and not candidate.get("applied"):
            release = candidate
            break
    if release is None:
        return {
            "ready": False,
            "reasons": ["no active Lab canary release; apply a Lab canary before promoting"],
            "minLabeled": min_labeled,
            "maxFailureRate": max_failure_rate,
        }
    outcomes = release.get("outcomes") or {}
    passed = int(outcomes.get("pass") or 0)
    failed = int(outcomes.get("fail") or 0)
    uncertain = int(outcomes.get("uncertain") or 0)
    unreviewed = int(outcomes.get("unreviewed") or 0)
    labeled = passed + failed
    failure_rate = (failed / labeled) if labeled else None
    reasons: List[str] = []
    if labeled < min_labeled:
        reasons.append(f"needs at least {min_labeled} labeled Lab canary sessions; currently {labeled}")
    if failure_rate is not None and failure_rate > max_failure_rate:
        reasons.append(
            f"Lab canary failure rate {failure_rate:.0%} exceeds {max_failure_rate:.0%}"
        )
    return {
        "ready": not reasons,
        "releaseId": release.get("releaseId"),
        "canaryPercent": release.get("canaryPercent"),
        "labeled": labeled,
        "passed": passed,
        "failed": failed,
        "uncertain": uncertain,
        "unreviewed": unreviewed,
        "failureRate": failure_rate,
        "minLabeled": min_labeled,
        "maxFailureRate": max_failure_rate,
        "reasons": reasons or ["Lab canary evidence meets the promotion gate"],
    }
