"""Agent-level skill regression through a DSH judge.

This runs one DSH headless judge per sampled trajectory.  The judge sees the
candidate skill's proposed changes and a bounded trajectory transcript, but
never the human label.  Its pass/fail verdict is compared with the curated
label.  Reports are immutable snapshots; a version is still not applied to any
expert until a separate publication step exists.
"""

from __future__ import annotations

import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from metainfer.orchestrator.subagent_manager import AgentSpec, SubAgentManager
from metainfer.server import paths as _paths

REGRESSION_VERSION = 1
REGRESSION_ID = re.compile(r"^traj-reg-[A-Za-z0-9._-]{1,160}$")
_MAX_ITEMS = 10
_JUDGE_KINDS = {"user", "assistant", "tool_call", "tool_result", "error"}


def regressions_dir() -> Path:
    return _paths.home_dir() / "trajectory" / "regressions"


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def _ratio(numerator: int, denominator: int) -> Optional[float]:
    return (numerator / denominator) if denominator else None


def parse_judge_output(text: str) -> Dict[str, Any]:
    """Extract the judge's JSON verdict from a possibly fenced answer."""

    raw = str(text or "").strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.IGNORECASE)
    raw = re.sub(r"\s*```$", "", raw)
    start = raw.find("{")
    end = raw.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("judge output did not contain a JSON object")
    parsed = json.loads(raw[start:end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("judge output JSON is not an object")
    outcome = str(parsed.get("outcome") or "").strip().lower()
    if outcome not in ("pass", "fail"):
        raise ValueError("judge JSON outcome must be pass or fail")
    evidence = parsed.get("evidence")
    if isinstance(evidence, list):
        evidence = [str(item)[:300] for item in evidence[:10]]
    else:
        evidence = []
    return {
        "outcome": outcome,
        "reason": str(parsed.get("reason") or "")[:2000],
        "evidence": evidence,
    }


def build_judge_prompt(
    item: Dict[str, Any],
    detail: Dict[str, Any],
    skill: Dict[str, Any],
    version: Dict[str, Any],
) -> str:
    changes = version.get("changes") or []
    change_lines = []
    for action in changes:
        kind = str(action.get("type") or "change")
        text = str(action.get("change") or "")
        rationale = str(action.get("rationale") or "")
        change_lines.append(f"- [{kind}] {text}\n  rationale: {rationale}")
    timeline_lines = []
    for entry in (detail.get("timeline") or []):
        if entry.get("type") not in _JUDGE_KINDS:
            continue
        text = str(entry.get("text") or "").replace("\n", " ").strip()
        if not text:
            continue
        timeline_lines.append(
            f"[seq {entry.get('seq')} · turn {entry.get('turn')} · {entry.get('type')}] {text[:700]}"
        )
        if len(timeline_lines) >= 50:
            break
    return "\n".join([
        "You are an expert reviewer evaluating one coding-agent trajectory.",
        "Apply ONLY the candidate skill changes below to decide whether the trajectory passes.",
        "The human label is deliberately hidden. Do not use tools or inspect files.",
        "",
        f"# Skill: {skill.get('name')} ({skill.get('role')}, version {version.get('version')})",
        "",
        "## Candidate changes",
        "\n".join(change_lines) or "- (no textual changes recorded)",
        "",
        "## Trajectory metadata",
        f"- title: {detail.get('title') or item.get('title') or ''}",
        f"- status: {detail.get('status') or item.get('status') or ''}",
        f"- turns: {detail.get('turns')}",
        f"- tool calls: {detail.get('toolCalls')}",
        f"- tool errors: {detail.get('toolErrors')}",
        f"- deterministic findings: {'; '.join((detail.get('analysis') or {}).get('findings') or [])}",
        "",
        "## Bounded transcript",
        "\n".join(timeline_lines) or "(no timeline records)",
        "",
        "Return ONLY one JSON object, with no markdown fence:",
        '{"outcome":"pass"|"fail","reason":"short evidence-based reason","evidence":["seq: evidence"]}',
    ])


def _default_dsh_judge(prompt: str, workdir: Path) -> str:
    """Run one DSH headless judge.  Raises when the DSH binary/profile fails."""

    from metainfer.server import agent_settings

    settings = agent_settings.read_settings()
    dsh_bin = settings.get("dshBin") or "dsh"
    dsh_profile = settings.get("dshProfile") or "metainfer-headless"
    try:
        agent_settings.ensure_dsh_profile(dsh_profile)
    except ValueError:
        # Custom externally-managed profiles are allowed; they are not created here.
        pass
    workdir.mkdir(parents=True, exist_ok=True)
    prompt_file = workdir / "judge.prompt.txt"
    prompt_file.write_text(prompt, encoding="utf-8")
    log_dir = workdir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    manager = SubAgentManager(
        agent_backend="dsh",
        dsh_bin=dsh_bin,
        dsh_profile=dsh_profile,
        max_concurrent=1,
    )
    try:
        spec = AgentSpec(
            name="trajectory-judge",
            role="regression-judge",
            prompt_file=prompt_file,
            workdir=workdir,
            log_dir=log_dir,
            timeout_s=180,
            stuck_timeout_s=120,
            max_retries=0,
        )
        manager.launch(spec)
        result = manager.result("trajectory-judge")
        if result is None:
            raise RuntimeError("DSH judge produced no result")
        if not result.success:
            raise RuntimeError(result.error or "DSH judge failed")
        return result.final_text
    finally:
        manager.shutdown()


def _metrics(items: List[Dict[str, Any]]) -> Dict[str, Any]:
    counts = {"tp": 0, "tn": 0, "fp": 0, "fn": 0}
    labeled = 0
    for item in items:
        human = item.get("humanOutcome")
        predicted = item.get("predictedOutcome")
        if human not in ("pass", "fail"):
            continue
        labeled += 1
        # A judge error counts against accuracy (the prediction is missing),
        # but cannot be placed in the pass/fail confusion matrix.
        if predicted not in ("pass", "fail"):
            continue
        truth = human == "pass"
        guess = predicted == "pass"
        if truth and guess:
            counts["tp"] += 1
        elif not truth and not guess:
            counts["tn"] += 1
        elif not truth and guess:
            counts["fp"] += 1
        else:
            counts["fn"] += 1
    correct = counts["tp"] + counts["tn"]
    precision = _ratio(counts["tp"], counts["tp"] + counts["fp"])
    recall = _ratio(counts["tp"], counts["tp"] + counts["fn"])
    f1 = (
        _ratio(2 * precision * recall, precision + recall)
        if precision is not None and recall is not None and (precision + recall) > 0
        else None
    )
    return {
        "labeled": labeled,
        "correct": correct,
        "accuracy": _ratio(correct, labeled),
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "confusion": counts,
        "mismatches": [item for item in items if item.get("humanOutcome") != item.get("predictedOutcome")],
    }


def run_skill_regression(
    dataset: Dict[str, Any],
    skill: Dict[str, Any],
    version_number: int,
    service: Any,
    *,
    max_items: int = 3,
    judge_runner: Optional[Callable[[str, Path], str]] = None,
) -> Dict[str, Any]:
    version = next(
        (item for item in skill.get("versions", []) if int(item.get("version") or 0) == int(version_number)),
        None,
    )
    if version is None:
        raise KeyError(f"skill version not found: {skill.get('id')} v{version_number}")
    candidates = [
        item for item in (dataset.get("items") or [])
        if (item.get("annotation") or {}).get("outcome") in ("pass", "fail")
    ]
    candidates.sort(key=lambda item: str(item.get("sessionId")))
    try:
        limit = max(1, min(int(max_items), _MAX_ITEMS))
    except (TypeError, ValueError):
        limit = 3
    selected = candidates[:limit]
    if not selected:
        raise ValueError("dataset has no labeled sessions for agent regression")
    run_id = f"traj-reg-{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}"
    run_dir = regressions_dir() / run_id
    runner = judge_runner or _default_dsh_judge
    items: List[Dict[str, Any]] = []
    for index, item in enumerate(selected):
        session_id = str(item.get("sessionId") or "")
        human = str((item.get("annotation") or {}).get("outcome") or "")
        entry: Dict[str, Any] = {
            "sessionId": session_id,
            "title": item.get("title"),
            "humanOutcome": human,
            "predictedOutcome": None,
            "reason": "",
            "evidence": [],
            "error": "",
        }
        try:
            detail = service.get_session(session_id)
            prompt = build_judge_prompt(item, detail, skill, version)
            raw = runner(prompt, run_dir / f"item-{index + 1}")
            parsed = parse_judge_output(raw)
            entry["predictedOutcome"] = parsed["outcome"]
            entry["reason"] = parsed["reason"]
            entry["evidence"] = parsed["evidence"]
            entry["judgeText"] = str(raw)[:4000]
        except Exception as exc:  # noqa: BLE001 - one item must not hide the rest
            entry["error"] = str(exc)
        items.append(entry)
    metrics = _metrics(items)
    return {
        "version": REGRESSION_VERSION,
        "id": run_id,
        "createdAt": int(time.time() * 1000),
        "skillId": skill.get("id"),
        "skillName": skill.get("name"),
        "skillVersion": int(version_number),
        "datasetId": dataset.get("id"),
        "datasetName": dataset.get("name"),
        "judge": "dsh-headless",
        "maxItems": limit,
        "metrics": metrics,
        "items": items,
    }


def save_regression(report: Dict[str, Any]) -> Dict[str, Any]:
    _write_json(regressions_dir() / f"{report['id']}.json", report)
    return report


def list_regressions() -> List[Dict[str, Any]]:
    root = regressions_dir()
    if not root.is_dir():
        return []
    output = []
    for path in root.glob("traj-reg-*.json"):
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
            "skillId": raw.get("skillId"),
            "skillName": raw.get("skillName"),
            "skillVersion": raw.get("skillVersion"),
            "datasetId": raw.get("datasetId"),
            "datasetName": raw.get("datasetName"),
            "labeled": metrics.get("labeled"),
            "accuracy": metrics.get("accuracy"),
            "f1": metrics.get("f1"),
        })
    output.sort(key=lambda item: int(item.get("createdAt") or 0), reverse=True)
    return output


def get_regression(regression_id: str) -> Dict[str, Any]:
    value = str(regression_id or "")
    if not REGRESSION_ID.match(value):
        raise KeyError(f"regression not found: {value}")
    path = regressions_dir() / f"{value}.json"
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise KeyError(f"regression not found: {value}") from exc
    if not isinstance(raw, dict):
        raise KeyError(f"regression not found: {value}")
    return raw
