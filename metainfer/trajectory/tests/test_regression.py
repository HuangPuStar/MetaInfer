"""Tests for the DSH-judge regression runner (judge execution is faked)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from metainfer.trajectory.regression import (
    parse_judge_output,
    run_skill_regression,
    save_regression,
)
from metainfer.trajectory.skills import attach_agent_regression, create_skill


@pytest.fixture
def platform_home(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("METAINFER_ROOT", str(tmp_path / "root"))
    monkeypatch.setenv("METAINFER_NODE_ID", "test-node")
    return tmp_path / "root"


class _FakeService:
    def get_session(self, session_id: str):
        return {
            "id": session_id,
            "title": session_id,
            "status": "completed",
            "turns": 1,
            "toolCalls": 1,
            "toolErrors": 0,
            "analysis": {"findings": ["observation"]},
            "timeline": [
                {"seq": 1, "turn": 1, "type": "user", "text": "do it"},
                {"seq": 2, "turn": 1, "type": "assistant", "text": "done"},
            ],
        }


def _dataset():
    return {
        "id": "traj-ds-reg",
        "name": "regression-demo",
        "items": [
            {"sessionId": "session-a", "title": "a", "status": "completed",
             "toolErrors": 0, "annotation": {"outcome": "pass"}},
            {"sessionId": "session-b", "title": "b", "status": "completed",
             "toolErrors": 0, "annotation": {"outcome": "fail"}},
        ],
    }


def _proposal():
    return {
        "id": "skill-prop-demo",
        "title": "Advisor gate",
        "role": "advisor",
        "status": "approved_for_regression",
        "datasetId": "traj-ds-reg",
        "datasetName": "regression-demo",
        "actions": [{"type": "rubric", "change": "require evidence", "rationale": "x", "evidence": "a"}],
        "evidence": {"failCount": 1, "patterns": []},
    }


def test_parse_judge_output_accepts_fenced_json():
    parsed = parse_judge_output('```json\n{"outcome":"fail","reason":"no test","evidence":["seq 4"]}\n```')
    assert parsed["outcome"] == "fail"
    assert parsed["evidence"] == ["seq 4"]
    with pytest.raises(ValueError):
        parse_judge_output("I think it passes")


def test_agent_regression_compares_judge_with_human_labels(platform_home: Path) -> None:
    skill = create_skill(_proposal(), "Advisor gate")

    def judge(prompt: str, workdir: Path) -> str:
        # First sampled item is session-a; always passing yields TP + FP.
        return json.dumps({"outcome": "pass", "reason": "looks complete", "evidence": []})

    report = run_skill_regression(_dataset(), skill, 1, _FakeService(), max_items=2, judge_runner=judge)
    assert report["judge"] == "dsh-headless"
    assert report["metrics"]["labeled"] == 2
    assert report["metrics"]["confusion"] == {"tp": 1, "tn": 0, "fp": 1, "fn": 0}
    assert len(report["metrics"]["mismatches"]) == 1

    saved = save_regression(report)
    assert saved["id"] == report["id"]
    updated = attach_agent_regression(skill["id"], 1, report)
    version = updated["versions"][0]
    assert version["status"] == "agent_regressed"
    assert version["regressionId"] == report["id"]
    assert version["applied"] is False


def test_agent_regression_reports_judge_errors(platform_home: Path) -> None:
    skill = create_skill(_proposal(), "Advisor gate")

    def broken(prompt: str, workdir: Path) -> str:
        raise RuntimeError("dsh unavailable")

    report = run_skill_regression(_dataset(), skill, 1, _FakeService(), max_items=1, judge_runner=broken)
    assert report["metrics"]["labeled"] == 1
    assert report["items"][0]["error"] == "dsh unavailable"
    assert report["items"][0]["predictedOutcome"] is None


def test_release_manifest_requires_agent_regression(platform_home: Path) -> None:
    from metainfer.trajectory.skills import create_release, get_release, list_releases

    skill = create_skill(_proposal(), "Advisor gate")
    with pytest.raises(ValueError):
        create_release(skill["id"], 1, "alice", "ready")

    def judge(prompt: str, workdir: Path) -> str:
        return json.dumps({"outcome": "pass", "reason": "ok", "evidence": []})

    report = run_skill_regression(_dataset(), skill, 1, _FakeService(), max_items=2, judge_runner=judge)
    save_regression(report)
    attach_agent_regression(skill["id"], 1, report)

    release = create_release(skill["id"], 1, "alice", "approved evidence")
    assert release["status"] == "release_ready"
    assert release["target"]["applied"] is False
    assert release["regression"]["id"] == report["id"]
    assert get_release(release["id"])["skillId"] == skill["id"]
    assert any(item["id"] == release["id"] for item in list_releases())


def test_release_activation_and_registry_rollback(platform_home: Path) -> None:
    from metainfer.trajectory.skills import (
        activate_release,
        create_release,
        get_release,
        get_skill,
        rollback_skill,
    )

    skill = create_skill(_proposal(), "Advisor gate")

    def judge(prompt: str, workdir: Path) -> str:
        return json.dumps({"outcome": "pass", "reason": "ok", "evidence": []})

    report = run_skill_regression(_dataset(), skill, 1, _FakeService(), max_items=1, judge_runner=judge)
    save_regression(report)
    attach_agent_regression(skill["id"], 1, report)
    release = create_release(skill["id"], 1, "alice", "ready")

    active = activate_release(skill["id"], release["id"])
    assert active["activeVersion"] == 1
    assert active["activeReleaseId"] == release["id"]
    assert get_release(release["id"])["status"] == "active_registry"
    assert get_release(release["id"])["target"]["applied"] is False
    assert get_skill(skill["id"])["versions"][0]["status"] == "active_registry"

    rolled = rollback_skill(skill["id"])
    assert rolled["activeVersion"] is None
    assert rolled["activeReleaseId"] is None
    assert get_release(release["id"])["status"] == "rolled_back"
    assert get_skill(skill["id"])["versions"][0]["status"] == "release_ready"


def test_runtime_overlay_apply_and_rollback(platform_home: Path) -> None:
    from metainfer.trajectory.skills import (
        activate_release,
        apply_runtime_release,
        create_release,
        get_release,
        read_runtime_skills,
        rollback_runtime,
    )

    skill = create_skill(_proposal(), "Advisor gate")

    def judge(prompt: str, workdir: Path) -> str:
        return json.dumps({"outcome": "pass", "reason": "ok", "evidence": []})

    report = run_skill_regression(_dataset(), skill, 1, _FakeService(), max_items=1, judge_runner=judge)
    save_regression(report)
    attach_agent_regression(skill["id"], 1, report)
    release = create_release(skill["id"], 1, "alice", "ready")
    activate_release(skill["id"], release["id"])

    applied = apply_runtime_release(skill["id"], release["id"])
    assert applied["runtimeReleaseId"] == release["id"]
    entries = read_runtime_skills()["entries"]
    assert entries["advisor"]["releaseId"] == release["id"]
    assert entries["advisor"]["changes"][0]["change"] == "require evidence"
    assert get_release(release["id"])["status"] == "runtime_applied"
    assert get_release(release["id"])["target"]["applied"] is True

    rolled = rollback_runtime(skill["id"])
    assert rolled["runtimeReleaseId"] is None
    assert "advisor" not in read_runtime_skills()["entries"]
    assert get_release(release["id"])["status"] == "active_registry"
    assert get_release(release["id"])["target"]["applied"] is False


def test_runtime_canary_can_be_promoted(platform_home: Path) -> None:
    from metainfer.trajectory.skills import (
        activate_release,
        apply_runtime_release,
        create_release,
        get_release,
        promote_runtime,
        read_runtime_skills,
    )

    skill = create_skill(_proposal(), "Advisor gate")

    def judge(prompt: str, workdir: Path) -> str:
        return json.dumps({"outcome": "pass", "reason": "ok", "evidence": []})

    report = run_skill_regression(_dataset(), skill, 1, _FakeService(), max_items=1, judge_runner=judge)
    save_regression(report)
    attach_agent_regression(skill["id"], 1, report)
    release = create_release(skill["id"], 1, "alice", "ready")
    activate_release(skill["id"], release["id"])

    applied = apply_runtime_release(skill["id"], release["id"], 10)
    assert applied["runtimeCanaryPercent"] == 10
    assert get_release(release["id"])["status"] == "canary"
    assert get_release(release["id"])["target"]["applied"] is False
    assert read_runtime_skills()["entries"]["advisor"]["canaryPercent"] == 10

    promoted = promote_runtime(skill["id"])
    assert promoted["runtimeCanaryPercent"] == 100
    assert get_release(release["id"])["status"] == "runtime_applied"
    assert get_release(release["id"])["target"]["applied"] is True
    assert read_runtime_skills()["entries"]["advisor"]["canaryPercent"] == 100


def test_lab_runtime_overlay_apply_and_rollback(platform_home: Path, tmp_path: Path, monkeypatch) -> None:
    from metainfer.trajectory.skills import (
        activate_release,
        apply_lab_runtime_release,
        create_release,
        get_release,
        promote_lab_runtime,
        read_lab_skills,
        rollback_lab_runtime,
    )

    monkeypatch.setenv("DSH_HOME", str(tmp_path / "dsh-home"))
    skill = create_skill(_proposal(), "Advisor gate")

    def judge(prompt: str, workdir: Path) -> str:
        return json.dumps({"outcome": "pass", "reason": "ok", "evidence": []})

    report = run_skill_regression(_dataset(), skill, 1, _FakeService(), max_items=1, judge_runner=judge)
    save_regression(report)
    attach_agent_regression(skill["id"], 1, report)
    release = create_release(skill["id"], 1, "alice", "ready")
    activate_release(skill["id"], release["id"])

    applied = apply_lab_runtime_release(skill["id"], release["id"], 10)
    assert applied["labRuntimeReleaseId"] == release["id"]
    assert applied["labCanaryPercent"] == 10
    entries = read_lab_skills()["entries"]
    assert entries["advisor"]["releaseId"] == release["id"]
    assert entries["advisor"]["canaryPercent"] == 10
    assert entries["advisor"]["changes"][0]["change"] == "require evidence"
    assert get_release(release["id"])["target"]["labApplied"] is False
    assert get_release(release["id"])["target"]["labCanaryPercent"] == 10

    promoted = promote_lab_runtime(skill["id"])
    assert promoted["labCanaryPercent"] == 100
    assert get_release(release["id"])["target"]["labApplied"] is True
    assert read_lab_skills()["entries"]["advisor"]["canaryPercent"] == 100

    rolled = rollback_lab_runtime(skill["id"])
    assert rolled["labRuntimeReleaseId"] is None
    assert "advisor" not in read_lab_skills()["entries"]
    assert get_release(release["id"])["target"]["labApplied"] is False
