"""Evidence-backed expert-skill proposal drafts.

A proposal is generated deterministically from a frozen dataset: failure
categories select a small set of known rubric/prompt/tool-policy/few-shot
patterns.  It is a *draft* for human review, not an automatic prompt mutation.
"""

from __future__ import annotations

import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List

from metainfer.server import paths as _paths

PROPOSAL_VERSION = 1
PROPOSAL_ID = re.compile(r"^skill-prop-[A-Za-z0-9._-]{1,160}$")
ROLES = ("advisor", "reviewer", "worker", "scheduler", "custom")


def proposals_dir() -> Path:
    return _paths.home_dir() / "trajectory" / "proposals"


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def _failure_groups(dataset: Dict[str, Any]) -> Dict[str, List[Dict[str, Any]]]:
    groups: Dict[str, List[Dict[str, Any]]] = {}
    for item in dataset.get("items") or []:
        annotation = item.get("annotation") or {}
        if annotation.get("outcome") != "fail":
            continue
        category = str(annotation.get("failureCategory") or "uncategorized").strip() or "uncategorized"
        groups.setdefault(category, []).append(item)
    return groups


def _actions_for(category: str, items: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    key = category.lower()
    evidence = ", ".join(str(item.get("sessionId")) for item in items[:4])
    actions: List[Dict[str, str]] = []

    def add(kind: str, change: str, rationale: str) -> None:
        if not any(item["type"] == kind and item["change"] == change for item in actions):
            actions.append({"type": kind, "change": change, "rationale": rationale, "evidence": evidence})

    if any(word in key for word in ("verif", "test", "evidence", "check")):
        add("rubric", "Before reporting completion, run an explicit verification command and cite its output and exit code.",
            "Failures cluster around claims without verification evidence.")
        add("prompt", "Do not mark a task complete from code inspection alone; verify the changed behavior end-to-end.",
            "The expert must enforce an evidence gate rather than trust the worker's summary.")
        add("few_shot", "A passing example must include the exact command, its output, and the exit code; a failing example must show the missing verification.",
            "Concrete examples make the evidence gate less ambiguous.")
    if any(word in key for word in ("tool", "command", "bash", "error", "retry")):
        add("tool_policy", "Check every tool result for an error marker or non-zero exit code; diagnose before retrying and cap retries.",
            "Tool failures were observed without a reliable recovery policy.")
        add("rubric", "A recovered tool failure is only a pass when the final verification proves the intended behavior.",
            "Retries alone are not evidence of recovery.")
    if any(word in key for word in ("context", "token", "budget", "compact", "long")):
        add("prompt", "Summarize large tool outputs and preserve only the evidence needed for the current decision.",
            "Long trajectories inflate context and obscure the decisive evidence.")
    if any(word in key for word in ("timeout", "abort", "time", "stuck")):
        add("prompt", "Split long work into checkpointed steps and report progress before the timebox expires.",
            "Aborted sessions lost both the result and a usable handoff.")
    if any(word in key for word in ("report", "structured", "format", "output")):
        add("rubric", "Require a structured report with claim, evidence, reproduction command, and residual risks.",
            "Free-form completion reports were hard to compare and evaluate.")
    if not actions:
        add("rubric", f"Turn the observed failure category '{category}' into a concrete checklist item with cited evidence.",
            "The category is too coarse for an automatic prompt change; a human should refine the rubric.")
        add("few_shot", f"Add one positive and one negative example for '{category}', each with the decisive evidence highlighted.",
            "The proposal needs a concrete contrast before it can be evaluated.")
    return actions


def _markdown(proposal: Dict[str, Any]) -> str:
    lines = [
        f"# Skill proposal: {proposal['title']}",
        "",
        f"- Status: **{proposal['status']}**",
        f"- Role: `{proposal['role']}`",
        f"- Dataset: `{proposal['datasetName']}` (`{proposal['datasetId']}`)",
        f"- Created: {proposal['createdAt']}",
        f"- Evidence: {proposal['evidence']['failCount']} failed sessions",
        "",
        "## Observed failure patterns",
        "",
    ]
    for pattern in proposal["evidence"]["patterns"]:
        lines.append(f"- `{pattern['failureCategory']}`: {pattern['count']} session(s)")
        if pattern["sessionIds"]:
            lines.append(f"  - evidence: {', '.join(pattern['sessionIds'][:6])}")
    lines.extend(["", "## Proposed changes", ""])
    for action in proposal["actions"]:
        lines.append(f"### {action['type']}")
        lines.append("")
        lines.append(action["change"])
        lines.append("")
        lines.append(f"Rationale: {action['rationale']}")
        if action.get("evidence"):
            lines.append(f"Evidence: {action['evidence']}")
        lines.append("")
    lines.extend([
        "## Evaluation plan",
        "",
        f"1. Freeze the dataset `{proposal['datasetId']}` and keep an independent holdout.",
        "2. Apply the proposed prompt/rubric/tool policy to one expert role in shadow mode.",
        "3. Compare curated pass/fail labels, tool-error recovery, and verification evidence against the current skill.",
        "4. Publish only after human approval and a regression run; keep the previous version for rollback.",
        "",
        "This is a draft generated from curated evidence; it was not applied automatically.",
    ])
    return "\n".join(lines) + "\n"


def generate_proposal(dataset: Dict[str, Any], role: str, title: str) -> Dict[str, Any]:
    normalized_role = str(role or "").strip().lower()
    if normalized_role not in ROLES:
        raise ValueError(f"role must be one of {', '.join(ROLES)}")
    name = str(title or "").strip()[:160]
    if not name:
        raise ValueError("title is required")
    groups = _failure_groups(dataset)
    if not groups:
        raise ValueError("dataset has no failed sessions to learn from")
    patterns = [
        {
            "failureCategory": category,
            "count": len(items),
            "sessionIds": [str(item.get("sessionId")) for item in items],
        }
        for category, items in sorted(groups.items(), key=lambda pair: (-len(pair[1]), pair[0]))
    ]
    actions: List[Dict[str, str]] = []
    for category, items in sorted(groups.items()):
        for action in _actions_for(category, items):
            if not any(existing["type"] == action["type"] and existing["change"] == action["change"] for existing in actions):
                actions.append(action)
    proposal_id = f"skill-prop-{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}"
    proposal: Dict[str, Any] = {
        "version": PROPOSAL_VERSION,
        "id": proposal_id,
        "status": "draft",
        "createdAt": int(time.time() * 1000),
        "role": normalized_role,
        "title": name,
        "datasetId": dataset.get("id"),
        "datasetName": dataset.get("name"),
        "evidence": {
            "failCount": sum(len(items) for items in groups.values()),
            "patterns": patterns,
        },
        "actions": actions,
        "markdown": "",
    }
    proposal["markdown"] = _markdown(proposal)
    return proposal


def save_proposal(proposal: Dict[str, Any]) -> Dict[str, Any]:
    path = proposals_dir() / f"{proposal['id']}.json"
    _write_json(path, proposal)
    return proposal


def create_proposal(dataset: Dict[str, Any], role: str, title: str) -> Dict[str, Any]:
    return save_proposal(generate_proposal(dataset, role, title))


def list_proposals() -> List[Dict[str, Any]]:
    root = proposals_dir()
    if not root.is_dir():
        return []
    output: List[Dict[str, Any]] = []
    for path in root.glob("skill-prop-*.json"):
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(raw, dict):
            continue
        output.append({
            "id": raw.get("id"),
            "title": raw.get("title"),
            "role": raw.get("role"),
            "status": raw.get("status"),
            "datasetId": raw.get("datasetId"),
            "datasetName": raw.get("datasetName"),
            "createdAt": raw.get("createdAt"),
            "failCount": (raw.get("evidence") or {}).get("failCount"),
        })
    output.sort(key=lambda item: int(item.get("createdAt") or 0), reverse=True)
    return output


def get_proposal(proposal_id: str) -> Dict[str, Any]:
    value = str(proposal_id or "")
    if not PROPOSAL_ID.match(value):
        raise KeyError(f"proposal not found: {value}")
    path = proposals_dir() / f"{value}.json"
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise KeyError(f"proposal not found: {value}") from exc
    if not isinstance(raw, dict):
        raise KeyError(f"proposal not found: {value}")
    return raw


class ProposalGateError(ValueError):
    """A transition is valid but its required evidence is missing."""


REVIEW_STATUSES = ("reviewed", "approved_for_regression", "rejected")
_TRANSITIONS = {
    "draft": {"reviewed", "rejected"},
    "reviewed": {"approved_for_regression", "rejected"},
    "approved_for_regression": {"rejected"},
    "rejected": set(),
}


def review_proposal(
    proposal_id: str,
    status: str,
    reviewer: str,
    note: str,
    *,
    has_evaluation: bool,
) -> Dict[str, Any]:
    """Apply a human review transition; approval is gated on a dataset evaluation."""

    proposal = get_proposal(proposal_id)
    next_status = str(status or "").strip()
    if next_status not in REVIEW_STATUSES:
        raise ValueError(f"status must be one of {', '.join(REVIEW_STATUSES)}")
    current = str(proposal.get("status") or "draft")
    allowed = _TRANSITIONS.get(current, set())
    if next_status not in allowed:
        raise ValueError(f"cannot transition proposal from {current} to {next_status}")
    who = str(reviewer or "").strip()[:120]
    if not who:
        raise ValueError("reviewer is required")
    if next_status == "approved_for_regression" and not has_evaluation:
        raise ProposalGateError(
            "run a proposal_v1 rubric evaluation for this proposal's dataset before approving it for regression"
        )
    review = {
        "status": next_status,
        "reviewer": who,
        "note": str(note or "")[:4000],
        "at": int(time.time() * 1000),
    }
    proposal["status"] = next_status
    proposal["updatedAt"] = review["at"]
    proposal["review"] = review
    proposal.setdefault("reviews", []).append(review)
    markdown = str(proposal.get("markdown") or "")
    markdown = re.sub(r"- Status: \*\*[^*]+\*\*", f"- Status: **{next_status}**", markdown, count=1)
    proposal["markdown"] = markdown
    return save_proposal(proposal)


class ProposalGateError(ValueError):
    """A transition is valid but its required evidence is missing."""


REVIEW_STATUSES = ("reviewed", "approved_for_regression", "rejected")
_TRANSITIONS = {
    "draft": {"reviewed", "rejected"},
    "reviewed": {"approved_for_regression", "rejected"},
    "approved_for_regression": {"rejected"},
    "rejected": set(),
}


def review_proposal(
    proposal_id: str,
    status: str,
    reviewer: str,
    note: str,
    *,
    has_evaluation: bool,
) -> Dict[str, Any]:
    """Apply a human review transition; approval is gated on a dataset evaluation."""

    proposal = get_proposal(proposal_id)
    next_status = str(status or "").strip()
    if next_status not in REVIEW_STATUSES:
        raise ValueError(f"status must be one of {', '.join(REVIEW_STATUSES)}")
    current = str(proposal.get("status") or "draft")
    allowed = _TRANSITIONS.get(current, set())
    if next_status not in allowed:
        raise ValueError(f"cannot transition proposal from {current} to {next_status}")
    who = str(reviewer or "").strip()[:120]
    if not who:
        raise ValueError("reviewer is required")
    if next_status == "approved_for_regression" and not has_evaluation:
        raise ProposalGateError(
            "run a proposal_v1 rubric evaluation for this proposal's dataset before approving it for regression"
        )
    review = {
        "status": next_status,
        "reviewer": who,
        "note": str(note or "")[:4000],
        "at": int(time.time() * 1000),
    }
    proposal["status"] = next_status
    proposal["updatedAt"] = review["at"]
    proposal["review"] = review
    proposal.setdefault("reviews", []).append(review)
    markdown = str(proposal.get("markdown") or "")
    markdown = re.sub(r"- Status: \*\*[^*]+\*\*", f"- Status: **{next_status}**", markdown, count=1)
    proposal["markdown"] = markdown
    return save_proposal(proposal)
