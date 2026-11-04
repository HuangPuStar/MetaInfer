"""Versioned expert-skill packages derived from approved proposals.

A package is a repository artifact: role, evidence, and the proposed
prompt/rubric/tool-policy/few-shot changes.  Creating a version does NOT
mutate any agent; every version is explicitly marked ``applied: false`` until a
later deployment integration exists.
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

SKILL_VERSION = 1
SKILL_ID = re.compile(r"^expert-skill-[A-Za-z0-9._-]{1,180}$")
SKILL_ROLES = ("advisor", "reviewer", "worker", "scheduler", "custom")


def skills_dir() -> Path:
    return _paths.home_dir() / "trajectory" / "skills"


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def _slug(value: str) -> str:
    text = re.sub(r"[^a-z0-9]+", "-", str(value or "").lower()).strip("-")
    return text[:48] or "skill"


def _read(skill_id: str) -> Dict[str, Any]:
    value = str(skill_id or "")
    if not SKILL_ID.match(value):
        raise KeyError(f"skill not found: {value}")
    path = skills_dir() / f"{value}.json"
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise KeyError(f"skill not found: {value}") from exc
    if not isinstance(raw, dict):
        raise KeyError(f"skill not found: {value}")
    return raw


def _materialize_version(proposal: Dict[str, Any], version: int) -> Dict[str, Any]:
    return {
        "version": version,
        "status": "candidate",
        "createdAt": int(time.time() * 1000),
        "sourceProposalId": proposal.get("id"),
        "sourceProposalTitle": proposal.get("title"),
        "datasetId": proposal.get("datasetId"),
        "datasetName": proposal.get("datasetName"),
        "changes": proposal.get("actions") or [],
        "evidence": proposal.get("evidence") or {},
        "applied": False,
        "appliedAt": None,
    }


def create_skill(proposal: Dict[str, Any], name: Optional[str] = None) -> Dict[str, Any]:
    status = str(proposal.get("status") or "")
    if status != "approved_for_regression":
        raise ValueError("proposal must be approved_for_regression before it can become a skill version")
    role = str(proposal.get("role") or "custom")
    if role not in SKILL_ROLES:
        raise ValueError(f"unsupported skill role: {role}")
    title = str(name or proposal.get("title") or "").strip()[:160]
    if not title:
        raise ValueError("skill name is required")
    now = int(time.time() * 1000)
    skill_id = f"expert-skill-{_slug(role)}-{now}-{uuid.uuid4().hex[:8]}"
    package = {
        "version": SKILL_VERSION,
        "id": skill_id,
        "name": title,
        "role": role,
        "createdAt": now,
        "updatedAt": now,
        "versions": [_materialize_version(proposal, 1)],
    }
    _write_json(skills_dir() / f"{skill_id}.json", package)
    return package


def add_version(skill_id: str, proposal: Dict[str, Any]) -> Dict[str, Any]:
    package = _read(skill_id)
    if str(proposal.get("status") or "") != "approved_for_regression":
        raise ValueError("proposal must be approved_for_regression before it can become a skill version")
    if str(proposal.get("role") or "") != package.get("role"):
        raise ValueError("proposal role does not match the skill role")
    versions = package.setdefault("versions", [])
    if any(item.get("sourceProposalId") == proposal.get("id") for item in versions):
        raise ValueError("this proposal is already a version of the skill")
    next_version = max((int(item.get("version") or 0) for item in versions), default=0) + 1
    versions.append(_materialize_version(proposal, next_version))
    package["updatedAt"] = int(time.time() * 1000)
    _write_json(skills_dir() / f"{skill_id}.json", package)
    return package


def list_skills() -> List[Dict[str, Any]]:
    root = skills_dir()
    if not root.is_dir():
        return []
    output: List[Dict[str, Any]] = []
    for path in root.glob("expert-skill-*.json"):
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(raw, dict):
            continue
        versions = raw.get("versions") or []
        latest = max(versions, key=lambda item: int(item.get("version") or 0)) if versions else {}
        evaluation = latest.get("evaluation") if isinstance(latest.get("evaluation"), dict) else None
        regression = latest.get("regression") if isinstance(latest.get("regression"), dict) else None
        output.append({
            "id": raw.get("id"),
            "name": raw.get("name"),
            "role": raw.get("role"),
            "createdAt": raw.get("createdAt"),
            "updatedAt": raw.get("updatedAt"),
            "versionCount": len(versions),
            "latestVersion": latest.get("version"),
            "latestStatus": latest.get("status"),
            "applied": bool(latest.get("applied")),
            "evaluation": evaluation,
            "regression": regression,
            "activeVersion": raw.get("activeVersion"),
            "activeReleaseId": raw.get("activeReleaseId"),
            "runtimeApplied": bool(raw.get("runtimeReleaseId")),
            "canaryPercent": raw.get("runtimeCanaryPercent"),
            "labApplied": bool(raw.get("labRuntimeReleaseId")) and int(raw.get("labCanaryPercent") or 100) >= 100,
            "labCanaryPercent": raw.get("labCanaryPercent"),
        })
    output.sort(key=lambda item: int(item.get("updatedAt") or 0), reverse=True)
    return output


def get_skill(skill_id: str) -> Dict[str, Any]:
    return _read(skill_id)


def evaluate_skill_version(skill_id: str, version_number: int, evaluation: Dict[str, Any]) -> Dict[str, Any]:
    """Attach a proposal_v1 rubric evaluation to one candidate skill version."""

    if str(evaluation.get("rule") or "") != "proposal_v1":
        raise ValueError("skill versions require a proposal_v1 rubric evaluation")
    package = _read(skill_id)
    version = next(
        (item for item in package.get("versions", []) if int(item.get("version") or 0) == int(version_number)),
        None,
    )
    if version is None:
        raise KeyError(f"skill version not found: {skill_id} v{version_number}")
    if evaluation.get("datasetId") != version.get("datasetId"):
        raise ValueError("evaluation dataset does not match the skill version dataset")
    metrics = evaluation.get("metrics") if isinstance(evaluation.get("metrics"), dict) else {}
    version["status"] = "rubric_evaluated"
    version["evaluationId"] = evaluation.get("id")
    version["evaluationRule"] = "proposal_v1"
    version["evaluatedAt"] = int(time.time() * 1000)
    version["evaluation"] = {
        "id": evaluation.get("id"),
        "datasetId": evaluation.get("datasetId"),
        "datasetName": evaluation.get("datasetName"),
        "rule": evaluation.get("rule"),
        "labeled": metrics.get("labeled"),
        "accuracy": metrics.get("accuracy"),
        "precision": metrics.get("precision"),
        "recall": metrics.get("recall"),
        "f1": metrics.get("f1"),
    }
    package["updatedAt"] = int(time.time() * 1000)
    _write_json(skills_dir() / f"{skill_id}.json", package)
    return package


def attach_agent_regression(skill_id: str, version_number: int, report: Dict[str, Any]) -> Dict[str, Any]:
    """Attach a DSH-judge regression report to a candidate skill version."""

    package = _read(skill_id)
    version = next(
        (item for item in package.get("versions", []) if int(item.get("version") or 0) == int(version_number)),
        None,
    )
    if version is None:
        raise KeyError(f"skill version not found: {skill_id} v{version_number}")
    if report.get("datasetId") != version.get("datasetId"):
        raise ValueError("regression dataset does not match the skill version dataset")
    metrics = report.get("metrics") if isinstance(report.get("metrics"), dict) else {}
    version["status"] = "agent_regressed"
    version["regressionId"] = report.get("id")
    version["regressedAt"] = int(time.time() * 1000)
    version["regression"] = {
        "id": report.get("id"),
        "judge": report.get("judge"),
        "labeled": metrics.get("labeled"),
        "accuracy": metrics.get("accuracy"),
        "precision": metrics.get("precision"),
        "recall": metrics.get("recall"),
        "f1": metrics.get("f1"),
    }
    version["applied"] = False
    package["updatedAt"] = int(time.time() * 1000)
    _write_json(skills_dir() / f"{skill_id}.json", package)
    return package


RELEASE_ID = re.compile(r"^skill-release-[A-Za-z0-9._-]{1,180}$")


def releases_dir() -> Path:
    return _paths.home_dir() / "trajectory" / "releases"


def create_release(
    skill_id: str,
    version_number: int,
    reviewer: str,
    note: str,
) -> Dict[str, Any]:
    """Create a release-ready manifest for a skill version.

    This packages the reviewed skill for DSH deployment but deliberately does
    not write any preset or mark the skill as applied to a running agent.
    """

    package = _read(skill_id)
    version = next(
        (item for item in package.get("versions", []) if int(item.get("version") or 0) == int(version_number)),
        None,
    )
    if version is None:
        raise KeyError(f"skill version not found: {skill_id} v{version_number}")
    if str(version.get("status") or "") != "agent_regressed":
        raise ValueError("skill version must complete agent regression before release")
    who = str(reviewer or "").strip()[:120]
    if not who:
        raise ValueError("reviewer is required")
    release_id = f"skill-release-{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}"
    role = str(package.get("role") or "custom")
    release = {
        "version": SKILL_VERSION,
        "id": release_id,
        "createdAt": int(time.time() * 1000),
        "status": "release_ready",
        "skillId": skill_id,
        "skillName": package.get("name"),
        "skillVersion": int(version_number),
        "role": role,
        "changes": version.get("changes") or [],
        "evidence": version.get("evidence") or {},
        "regression": version.get("regression") or {},
        "reviewer": who,
        "note": str(note or "")[:4000],
        "target": {
            "kind": "dsh-task-agents",
            "role": role,
            "applied": False,
            "note": "prompt overlay for MetaInfer DSH task agents; no DSH Lab preset is modified",
        },
    }
    path = releases_dir() / f"{release_id}.json"
    _write_json(path, release)
    version["status"] = "release_ready"
    version["releaseId"] = release_id
    version["releasedAt"] = int(time.time() * 1000)
    version["applied"] = False
    package["updatedAt"] = int(time.time() * 1000)
    _write_json(skills_dir() / f"{skill_id}.json", package)
    return release


def get_release(release_id: str) -> Dict[str, Any]:
    value = str(release_id or "")
    if not RELEASE_ID.match(value):
        raise KeyError(f"release not found: {value}")
    path = releases_dir() / f"{value}.json"
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise KeyError(f"release not found: {value}") from exc
    if not isinstance(raw, dict):
        raise KeyError(f"release not found: {value}")
    return raw


def list_releases() -> List[Dict[str, Any]]:
    root = releases_dir()
    if not root.is_dir():
        return []
    output: List[Dict[str, Any]] = []
    for path in root.glob("skill-release-*.json"):
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(raw, dict):
            continue
        output.append({
            "id": raw.get("id"),
            "createdAt": raw.get("createdAt"),
            "skillId": raw.get("skillId"),
            "skillName": raw.get("skillName"),
            "skillVersion": raw.get("skillVersion"),
            "role": raw.get("role"),
            "status": raw.get("status"),
            "reviewer": raw.get("reviewer"),
            "applied": (raw.get("target") or {}).get("applied"),
            "labApplied": bool((raw.get("target") or {}).get("labApplied")),
            "labCanaryPercent": (raw.get("target") or {}).get("labCanaryPercent"),
        })
    output.sort(key=lambda item: int(item.get("createdAt") or 0), reverse=True)
    return output


def activate_release(skill_id: str, release_id: str) -> Dict[str, Any]:
    """Mark a release as active in the platform registry.

    This is a registry-level activation only: it deliberately leaves
    ``target.applied == false`` and does not rewrite any DSH preset.
    """

    package = _read(skill_id)
    release = get_release(release_id)
    if release.get("skillId") != skill_id:
        raise ValueError("release does not belong to this skill")
    if release.get("status") != "release_ready":
        raise ValueError("release is not release_ready")
    current = package.get("activeReleaseId")
    if current == release_id:
        return package
    version = next(
        (item for item in package.get("versions", []) if int(item.get("version") or 0) == int(release.get("skillVersion") or 0)),
        None,
    )
    if version is None:
        raise KeyError(f"skill version not found: {skill_id} v{release.get('skillVersion')}")
    previous = package.get("activeVersion")
    package["previousActiveVersion"] = previous
    package["activeVersion"] = version.get("version")
    package["activeReleaseId"] = release_id
    package["activatedAt"] = int(time.time() * 1000)
    version["status"] = "active_registry"
    version["activatedAt"] = package["activatedAt"]
    release["status"] = "active_registry"
    release["activatedAt"] = package["activatedAt"]
    release.setdefault("target", {})["applied"] = False
    _write_json(releases_dir() / f"{release_id}.json", release)
    _write_json(skills_dir() / f"{skill_id}.json", package)
    return package


def rollback_skill(skill_id: str) -> Dict[str, Any]:
    """Return the skill registry to no active version (runtime is untouched)."""

    package = _read(skill_id)
    release_id = package.get("activeReleaseId")
    if not release_id:
        raise ValueError("skill has no active release")
    try:
        release = get_release(release_id)
    except KeyError:
        release = None
    if release is not None:
        release["status"] = "rolled_back"
        release["rolledBackAt"] = int(time.time() * 1000)
        release.setdefault("target", {})["applied"] = False
        _write_json(releases_dir() / f"{release_id}.json", release)
    active_version = package.get("activeVersion")
    for version in package.get("versions", []):
        if int(version.get("version") or 0) == int(active_version or 0):
            version["status"] = "release_ready"
            break
    package["rolledBackReleaseId"] = release_id
    package["activeVersion"] = None
    package["activeReleaseId"] = None
    package["updatedAt"] = int(time.time() * 1000)
    _write_json(skills_dir() / f"{skill_id}.json", package)
    return package


def runtime_skills_path() -> Path:
    return _paths.home_dir() / "trajectory" / "runtime-skills.json"


def read_runtime_skills() -> Dict[str, Any]:
    try:
        raw = json.loads(runtime_skills_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"version": 1, "entries": {}}
    if not isinstance(raw, dict) or not isinstance(raw.get("entries"), dict):
        return {"version": 1, "entries": {}}
    return raw


def _write_runtime_skills(payload: Dict[str, Any]) -> None:
    _write_json(runtime_skills_path(), payload)


def apply_runtime_release(skill_id: str, release_id: str, canary_percent: int = 100) -> Dict[str, Any]:
    """Apply an active release as a prompt overlay for MetaInfer DSH task agents.

    The overlay is consumed by SubAgentManager; it is not a DSH Lab preset edit.
    """

    try:
        percent = int(canary_percent)
    except (TypeError, ValueError):
        raise ValueError("canaryPercent must be between 1 and 100")
    if percent < 1 or percent > 100:
        raise ValueError("canaryPercent must be between 1 and 100")
    package = _read(skill_id)
    if package.get("activeReleaseId") != release_id:
        raise ValueError("release must be the active registry release before runtime apply")
    release = get_release(release_id)
    if release.get("skillId") != skill_id:
        raise ValueError("release does not belong to this skill")
    if release.get("status") != "active_registry":
        raise ValueError("release must be active_registry before runtime apply")
    version = next(
        (item for item in package.get("versions", []) if int(item.get("version") or 0) == int(release.get("skillVersion") or 0)),
        None,
    )
    if version is None:
        raise KeyError(f"skill version not found: {skill_id} v{release.get('skillVersion')}")
    role = str(package.get("role") or "custom")
    now = int(time.time() * 1000)
    payload = read_runtime_skills()
    entries = payload.setdefault("entries", {})
    entries[role] = {
        "role": role,
        "skillId": skill_id,
        "skillName": package.get("name"),
        "skillVersion": version.get("version"),
        "releaseId": release_id,
        "canaryPercent": percent,
        "changes": [
            {"type": item.get("type"), "change": item.get("change")}
            for item in (version.get("changes") or [])
        ],
        "appliedAt": now,
    }
    payload["updatedAt"] = now
    _write_runtime_skills(payload)
    release["status"] = "runtime_applied" if percent >= 100 else "canary"
    release.setdefault("target", {})["applied"] = percent >= 100
    release["target"]["canaryPercent"] = percent
    release["appliedAt"] = now
    _write_json(releases_dir() / f"{release_id}.json", release)
    version["status"] = "runtime_applied" if percent >= 100 else "canary"
    version["applied"] = percent >= 100
    version["canaryPercent"] = percent
    version["appliedAt"] = now
    package["runtimeReleaseId"] = release_id
    package["runtimeAppliedAt"] = now
    package["runtimeCanaryPercent"] = percent
    package["updatedAt"] = now
    _write_json(skills_dir() / f"{skill_id}.json", package)
    return package


def promote_runtime(skill_id: str) -> Dict[str, Any]:
    """Promote a canary overlay to 100% of matching DSH task agents."""

    package = _read(skill_id)
    release_id = package.get("runtimeReleaseId")
    if not release_id:
        raise ValueError("skill has no runtime-applied release")
    payload = read_runtime_skills()
    entries = payload.get("entries") if isinstance(payload.get("entries"), dict) else {}
    role = str(package.get("role") or "custom")
    entry = entries.get(role)
    if not isinstance(entry, dict) or entry.get("releaseId") != release_id:
        raise KeyError("runtime overlay not found")
    entry["canaryPercent"] = 100
    payload["updatedAt"] = int(time.time() * 1000)
    _write_runtime_skills(payload)
    try:
        release = get_release(release_id)
    except KeyError:
        release = None
    if release is not None:
        release["status"] = "runtime_applied"
        release.setdefault("target", {})["applied"] = True
        release["target"]["canaryPercent"] = 100
        release["promotedAt"] = int(time.time() * 1000)
        _write_json(releases_dir() / f"{release_id}.json", release)
    version = next(
        (item for item in package.get("versions", []) if int(item.get("version") or 0) == int(package.get("activeVersion") or 0)),
        None,
    )
    if version is not None:
        version["status"] = "runtime_applied"
        version["applied"] = True
        version["canaryPercent"] = 100
    package["runtimeCanaryPercent"] = 100
    package["updatedAt"] = int(time.time() * 1000)
    _write_json(skills_dir() / f"{skill_id}.json", package)
    return package


def rollback_runtime(skill_id: str) -> Dict[str, Any]:
    """Remove a runtime prompt overlay while keeping the registry release active."""

    package = _read(skill_id)
    release_id = package.get("runtimeReleaseId")
    if not release_id:
        raise ValueError("skill has no runtime-applied release")
    payload = read_runtime_skills()
    entries = payload.get("entries") if isinstance(payload.get("entries"), dict) else {}
    role = str(package.get("role") or "custom")
    if isinstance(entries.get(role), dict) and entries[role].get("releaseId") == release_id:
        del entries[role]
        payload["updatedAt"] = int(time.time() * 1000)
        _write_runtime_skills(payload)
    try:
        release = get_release(release_id)
    except KeyError:
        release = None
    if release is not None:
        release["status"] = "active_registry"
        release.setdefault("target", {})["applied"] = False
        release["rolledBackAt"] = int(time.time() * 1000)
        _write_json(releases_dir() / f"{release_id}.json", release)
    version = next(
        (item for item in package.get("versions", []) if int(item.get("version") or 0) == int(package.get("activeVersion") or 0)),
        None,
    )
    if version is not None:
        version["status"] = "active_registry"
        version["applied"] = False
    package["runtimeReleaseId"] = None
    package["runtimeAppliedAt"] = None
    package["runtimeCanaryPercent"] = None
    package["updatedAt"] = int(time.time() * 1000)
    _write_json(skills_dir() / f"{skill_id}.json", package)
    return package


def lab_skills_path() -> Path:
    dsh_home = os.environ.get("DSH_HOME")
    base = Path(dsh_home).expanduser() if dsh_home else (Path.home() / ".dsh")
    return base / "metainfer-research-lab" / "active-skills.json"


def read_lab_skills() -> Dict[str, Any]:
    try:
        raw = json.loads(lab_skills_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"version": 1, "entries": {}}
    if not isinstance(raw, dict) or not isinstance(raw.get("entries"), dict):
        return {"version": 1, "entries": {}}
    return raw


def _write_lab_skills(payload: Dict[str, Any]) -> None:
    _write_json(lab_skills_path(), payload)


def apply_lab_runtime_release(skill_id: str, release_id: str, canary_percent: int = 100) -> Dict[str, Any]:
    """Publish an active release to the DSH Lab expert-prompt overlay.

    The DSH Lab orchestrator reads this file when it builds advisor/reviewer
    prompts.  It is a separate target from MetaInfer's task-agent overlay.
    """

    try:
        percent = int(canary_percent)
    except (TypeError, ValueError):
        raise ValueError("canaryPercent must be between 1 and 100")
    if percent < 1 or percent > 100:
        raise ValueError("canaryPercent must be between 1 and 100")
    package = _read(skill_id)
    if package.get("activeReleaseId") != release_id:
        raise ValueError("release must be the active registry release before lab apply")
    release = get_release(release_id)
    if release.get("skillId") != skill_id:
        raise ValueError("release does not belong to this skill")
    if release.get("status") not in ("active_registry", "canary", "runtime_applied"):
        raise ValueError("release is not active")
    version = next(
        (item for item in package.get("versions", []) if int(item.get("version") or 0) == int(release.get("skillVersion") or 0)),
        None,
    )
    if version is None:
        raise KeyError(f"skill version not found: {skill_id} v{release.get('skillVersion')}")
    role = str(package.get("role") or "custom")
    now = int(time.time() * 1000)
    payload = read_lab_skills()
    entries = payload.setdefault("entries", {})
    entries[role] = {
        "role": role,
        "skillId": skill_id,
        "skillName": package.get("name"),
        "skillVersion": version.get("version"),
        "releaseId": release_id,
        "canaryPercent": percent,
        "changes": [
            {"type": item.get("type"), "change": item.get("change")}
            for item in (version.get("changes") or [])
        ],
        "appliedAt": now,
    }
    payload["updatedAt"] = now
    _write_lab_skills(payload)
    release.setdefault("target", {})["labApplied"] = percent >= 100
    release["target"]["labCanaryPercent"] = percent
    release["target"]["labAppliedAt"] = now
    release["labAppliedAt"] = now
    _write_json(releases_dir() / f"{release_id}.json", release)
    version["labApplied"] = percent >= 100
    version["labCanaryPercent"] = percent
    version["labAppliedAt"] = now
    package["labRuntimeReleaseId"] = release_id
    package["labCanaryPercent"] = percent
    package["labAppliedAt"] = now
    package["updatedAt"] = now
    _write_json(skills_dir() / f"{skill_id}.json", package)
    return package


def promote_lab_runtime(skill_id: str) -> Dict[str, Any]:
    package = _read(skill_id)
    release_id = package.get("labRuntimeReleaseId")
    if not release_id:
        raise ValueError("skill has no lab-applied release")
    payload = read_lab_skills()
    entries = payload.get("entries") if isinstance(payload.get("entries"), dict) else {}
    role = str(package.get("role") or "custom")
    entry = entries.get(role)
    if not isinstance(entry, dict) or entry.get("releaseId") != release_id:
        raise KeyError("lab overlay not found")
    entry["canaryPercent"] = 100
    payload["updatedAt"] = int(time.time() * 1000)
    _write_lab_skills(payload)
    try:
        release = get_release(release_id)
    except KeyError:
        release = None
    if release is not None:
        release.setdefault("target", {})["labApplied"] = True
        release["target"]["labCanaryPercent"] = 100
        release["labPromotedAt"] = int(time.time() * 1000)
        _write_json(releases_dir() / f"{release_id}.json", release)
    version = next(
        (item for item in package.get("versions", []) if int(item.get("version") or 0) == int(package.get("activeVersion") or 0)),
        None,
    )
    if version is not None:
        version["labApplied"] = True
        version["labCanaryPercent"] = 100
    package["labCanaryPercent"] = 100
    package["updatedAt"] = int(time.time() * 1000)
    _write_json(skills_dir() / f"{skill_id}.json", package)
    return package


def rollback_lab_runtime(skill_id: str) -> Dict[str, Any]:
    package = _read(skill_id)
    release_id = package.get("labRuntimeReleaseId")
    if not release_id:
        raise ValueError("skill has no lab-applied release")
    payload = read_lab_skills()
    entries = payload.get("entries") if isinstance(payload.get("entries"), dict) else {}
    role = str(package.get("role") or "custom")
    if isinstance(entries.get(role), dict) and entries[role].get("releaseId") == release_id:
        del entries[role]
        payload["updatedAt"] = int(time.time() * 1000)
        _write_lab_skills(payload)
    try:
        release = get_release(release_id)
    except KeyError:
        release = None
    if release is not None:
        release.setdefault("target", {})["labApplied"] = False
        release["target"]["labCanaryPercent"] = None
        release["labRolledBackAt"] = int(time.time() * 1000)
        _write_json(releases_dir() / f"{release_id}.json", release)
    version = next(
        (item for item in package.get("versions", []) if int(item.get("version") or 0) == int(package.get("activeVersion") or 0)),
        None,
    )
    if version is not None:
        version["labApplied"] = False
        version["labCanaryPercent"] = None
    package["labRuntimeReleaseId"] = None
    package["labAppliedAt"] = None
    package["labCanaryPercent"] = None
    package["updatedAt"] = int(time.time() * 1000)
    _write_json(skills_dir() / f"{skill_id}.json", package)
    return package
