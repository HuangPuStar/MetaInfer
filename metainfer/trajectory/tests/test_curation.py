"""Curation/config tests for the DSH trajectory surface."""

from __future__ import annotations

from pathlib import Path

import pytest

from metainfer.trajectory import config, reset_service
from metainfer.trajectory.annotations import read_annotation, write_annotation


@pytest.fixture
def platform_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("METAINFER_ROOT", str(tmp_path / "root"))
    monkeypatch.setenv("METAINFER_NODE_ID", "test-node")
    monkeypatch.delenv("DSH_SESSIONS_DIR", raising=False)
    reset_service()
    return tmp_path / "root"


def test_source_config_round_trip(platform_home: Path, tmp_path: Path) -> None:
    sessions = tmp_path / "sessions"
    sessions.mkdir()
    saved = config.write_config(str(sessions))
    assert saved["root"] == str(sessions.resolve())
    assert config.read_config()["root"] == str(sessions.resolve())

    resolved, source = config.source_root()
    assert resolved == sessions.resolve()
    assert source == "config"

    with pytest.raises(ValueError):
        config.write_config(str(tmp_path / "missing"))


def test_source_env_overrides_config(platform_home: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    configured = tmp_path / "configured"
    configured.mkdir()
    env_root = tmp_path / "env-sessions"
    env_root.mkdir()
    config.write_config(str(configured))
    monkeypatch.setenv("DSH_SESSIONS_DIR", str(env_root))
    resolved, source = config.source_root()
    assert resolved == env_root.resolve()
    assert source == "env"


def test_annotation_round_trip_and_defaults(platform_home: Path) -> None:
    assert read_annotation("session-demo")["outcome"] == "unreviewed"
    saved = write_annotation("session-demo", {
        "outcome": "fail",
        "failureCategory": "missing_verification",
        "tags": ["verification", "regression"],
        "notes": "The agent stopped before running the test.",
        "reviewer": "alice",
    })
    assert saved["outcome"] == "fail"
    assert saved["tags"] == ["verification", "regression"]
    assert saved["updatedAt"]

    loaded = read_annotation("session-demo")
    assert loaded["failureCategory"] == "missing_verification"
    assert loaded["reviewer"] == "alice"
    assert loaded["notes"].startswith("The agent")

    with pytest.raises(ValueError):
        write_annotation("session-demo", {"outcome": "not-a-verdict"})


def _session_file(root: Path, session_id: str, title: str = "demo") -> None:
    import json

    session_dir = root / "ws" / session_id
    session_dir.mkdir(parents=True, exist_ok=True)
    rows = [
        {"type": "session", "version": 4, "id": session_id, "createdAt": 1_700_000_000_000, "cwd": "/tmp/work"},
        {"type": "turn/start", "seq": 0, "time": 1_700_000_001_000, "data": {"turn": 1}},
        {"type": "user/message", "seq": 1, "time": 1_700_000_002_000, "data": {
            "content": [{"type": "text", "text": title}], "source": {"kind": "user"},
        }},
        {"type": "turn/end", "seq": 2, "time": 1_700_000_003_000, "data": {
            "turn": 1, "reason": {"kind": "completed"},
        }},
    ]
    (session_dir / "session.v4.jsonl").write_text(
        "\n".join(json.dumps(row) for row in rows) + "\n",
        encoding="utf-8",
    )


def test_curation_summary_and_dataset_freeze(platform_home: Path, tmp_path: Path) -> None:
    from metainfer.trajectory.curation import (
        create_dataset,
        curation_summary,
        get_dataset,
        list_datasets,
    )
    from metainfer.trajectory.service import TrajectoryService

    sessions = tmp_path / "sessions"
    _session_file(sessions, "session-a", "missing verification")
    _session_file(sessions, "session-b", "good run")
    write_annotation("session-a", {
        "outcome": "fail", "failureCategory": "missing_verification",
        "tags": ["verification"], "reviewer": "alice",
    })
    write_annotation("session-b", {"outcome": "pass", "reviewer": "bob"})

    service = TrajectoryService(sessions)
    summary = curation_summary(service)
    assert summary["reviewed"] == 2
    assert summary["outcomes"]["fail"] == 1
    assert summary["outcomes"]["pass"] == 1
    assert summary["failurePatterns"][0]["failureCategory"] == "missing_verification"
    assert summary["tagPatterns"][0]["tag"] == "verification"

    dataset = create_dataset(service, "verification-v1")
    assert dataset["counts"] == {"fail": 1, "pass": 1}
    assert len(dataset["items"]) == 2
    loaded = get_dataset(dataset["id"])
    assert loaded["name"] == "verification-v1"
    assert {item["annotation"]["outcome"] for item in loaded["items"]} == {"fail", "pass"}
    assert any(item["id"] == dataset["id"] for item in list_datasets())


def test_skill_proposal_from_failure_evidence(platform_home: Path, tmp_path: Path) -> None:
    from metainfer.trajectory.curation import create_dataset
    from metainfer.trajectory.proposals import create_proposal, get_proposal, list_proposals
    from metainfer.trajectory.service import TrajectoryService

    sessions = tmp_path / "sessions"
    _session_file(sessions, "session-a", "missing verification")
    _session_file(sessions, "session-b", "good run")
    write_annotation("session-a", {
        "outcome": "fail", "failureCategory": "missing_verification",
        "tags": ["verification"], "reviewer": "alice",
    })
    write_annotation("session-b", {"outcome": "pass", "reviewer": "bob"})
    dataset = create_dataset(TrajectoryService(sessions), "verification-v1")

    proposal = create_proposal(dataset, "advisor", "Advisor verification gate v1")
    assert proposal["status"] == "draft"
    assert proposal["role"] == "advisor"
    assert proposal["evidence"]["failCount"] == 1
    assert any(action["type"] == "rubric" for action in proposal["actions"])
    assert "session-a" in proposal["markdown"]
    assert "not applied automatically" in proposal["markdown"]

    loaded = get_proposal(proposal["id"])
    assert loaded["title"] == "Advisor verification gate v1"
    assert any(item["id"] == proposal["id"] for item in list_proposals())


def test_baseline_evaluation_metrics_and_report(platform_home: Path) -> None:
    from metainfer.trajectory.evaluation import (
        evaluate_and_save,
        get_evaluation,
        list_evaluations,
    )

    dataset = {
        "id": "traj-ds-test",
        "name": "eval-demo",
        "items": [
            {"sessionId": "session-a", "title": "false positive", "status": "completed",
             "toolErrors": 0, "annotation": {"outcome": "fail", "failureCategory": "verification"}},
            {"sessionId": "session-b", "title": "true positive", "status": "completed",
             "toolErrors": 0, "annotation": {"outcome": "pass"}},
            {"sessionId": "session-c", "title": "true negative", "status": "aborted",
             "toolErrors": 2, "annotation": {"outcome": "fail"}},
        ],
    }
    report = evaluate_and_save(dataset)
    metrics = report["metrics"]
    assert metrics["labeled"] == 3
    assert metrics["confusion"] == {"tp": 1, "tn": 1, "fp": 1, "fn": 0}
    assert metrics["accuracy"] == pytest.approx(2 / 3)
    assert metrics["precision"] == pytest.approx(0.5)
    assert metrics["recall"] == pytest.approx(1.0)
    assert metrics["f1"] == pytest.approx(2 / 3)
    assert get_evaluation(report["id"])["datasetName"] == "eval-demo"
    assert any(item["id"] == report["id"] for item in list_evaluations())


def test_proposal_review_requires_evaluation_before_approval(platform_home: Path, tmp_path: Path) -> None:
    from metainfer.trajectory.curation import create_dataset
    from metainfer.trajectory.evaluation import evaluate_and_save
    from metainfer.trajectory.proposals import (
        ProposalGateError,
        create_proposal,
        review_proposal,
    )
    from metainfer.trajectory.service import TrajectoryService

    sessions = tmp_path / "sessions"
    _session_file(sessions, "session-a", "missing verification")
    write_annotation("session-a", {"outcome": "fail", "failureCategory": "verification"})
    dataset = create_dataset(TrajectoryService(sessions), "verification-v1")
    proposal = create_proposal(dataset, "advisor", "Advisor gate")

    with pytest.raises(ValueError):
        review_proposal(proposal["id"], "approved_for_regression", "alice", "ok", has_evaluation=False)

    reviewed = review_proposal(proposal["id"], "reviewed", "alice", "checked evidence", has_evaluation=False)
    assert reviewed["status"] == "reviewed"
    assert reviewed["review"]["reviewer"] == "alice"

    with pytest.raises(ProposalGateError):
        review_proposal(proposal["id"], "approved_for_regression", "alice", "approve", has_evaluation=False)

    baseline = evaluate_and_save(dataset)
    assert baseline["rule"] == "baseline_v1"
    rubric = evaluate_and_save(dataset, "proposal_v1")
    assert rubric["rule"] == "proposal_v1"
    approved = review_proposal(proposal["id"], "approved_for_regression", "alice", "rubric evaluated", has_evaluation=True)
    assert approved["status"] == "approved_for_regression"
    assert approved["markdown"].count("approved_for_regression") >= 1

    with pytest.raises(ValueError):
        review_proposal(proposal["id"], "published", "alice", "publish", has_evaluation=True)


def test_proposal_rubric_requires_structured_evidence(platform_home: Path) -> None:
    from metainfer.trajectory.evaluation import evaluate_dataset

    dataset = {
        "id": "traj-ds-rubric",
        "name": "rubric-demo",
        "items": [
            {"sessionId": "a", "status": "completed", "toolErrors": 0,
             "hasStructuredOutput": False, "annotation": {"outcome": "fail"}},
            {"sessionId": "b", "status": "completed", "toolErrors": 0,
             "hasStructuredOutput": True, "annotation": {"outcome": "pass"}},
        ],
    }
    baseline = evaluate_dataset(dataset, "baseline_v1")
    rubric = evaluate_dataset(dataset, "proposal_v1")
    assert baseline["metrics"]["confusion"] == {"tp": 1, "tn": 0, "fp": 1, "fn": 0}
    assert rubric["metrics"]["confusion"] == {"tp": 1, "tn": 1, "fp": 0, "fn": 0}
    assert rubric["metrics"]["accuracy"] == 1.0
    with pytest.raises(ValueError):
        evaluate_dataset(dataset, "unknown")


def test_skill_package_is_versioned_and_not_applied(platform_home: Path, tmp_path: Path) -> None:
    from metainfer.trajectory.curation import create_dataset
    from metainfer.trajectory.proposals import create_proposal, review_proposal
    from metainfer.trajectory.service import TrajectoryService
    from metainfer.trajectory.skills import add_version, create_skill, get_skill, list_skills

    sessions = tmp_path / "sessions"
    _session_file(sessions, "session-a", "missing verification")
    _session_file(sessions, "session-b", "another failure")
    write_annotation("session-a", {"outcome": "fail", "failureCategory": "verification"})
    write_annotation("session-b", {"outcome": "fail", "failureCategory": "tool_error"})
    dataset = create_dataset(TrajectoryService(sessions), "skills-v1")
    first = create_proposal(dataset, "advisor", "Advisor gate v1")
    review_proposal(first["id"], "reviewed", "alice", "ok", has_evaluation=False)
    first = review_proposal(first["id"], "approved_for_regression", "alice", "rubric", has_evaluation=True)

    skill = create_skill(first, "Advisor evidence gate")
    assert skill["role"] == "advisor"
    assert skill["versions"][0]["status"] == "candidate"
    assert skill["versions"][0]["applied"] is False
    assert "Advisor evidence gate" in [item["name"] for item in list_skills()]

    second = create_proposal(dataset, "advisor", "Advisor gate v2")
    review_proposal(second["id"], "reviewed", "alice", "ok", has_evaluation=False)
    second = review_proposal(second["id"], "approved_for_regression", "alice", "rubric", has_evaluation=True)
    updated = add_version(skill["id"], second)
    assert len(updated["versions"]) == 2
    assert updated["versions"][1]["version"] == 2
    assert get_skill(skill["id"])["versions"][1]["sourceProposalId"] == second["id"]


def test_skill_version_requires_proposal_rubric_evaluation(platform_home: Path, tmp_path: Path) -> None:
    from metainfer.trajectory.curation import create_dataset
    from metainfer.trajectory.evaluation import evaluate_and_save
    from metainfer.trajectory.proposals import create_proposal, review_proposal
    from metainfer.trajectory.service import TrajectoryService
    from metainfer.trajectory.skills import create_skill, evaluate_skill_version

    sessions = tmp_path / "sessions"
    _session_file(sessions, "session-a", "missing verification")
    write_annotation("session-a", {"outcome": "fail", "failureCategory": "verification"})
    dataset = create_dataset(TrajectoryService(sessions), "skill-eval-v1")
    proposal = create_proposal(dataset, "advisor", "Advisor gate")
    review_proposal(proposal["id"], "reviewed", "alice", "ok", has_evaluation=False)
    proposal = review_proposal(proposal["id"], "approved_for_regression", "alice", "ok", has_evaluation=True)
    skill = create_skill(proposal, "Advisor gate")

    baseline = evaluate_and_save(dataset, "baseline_v1")
    with pytest.raises(ValueError):
        evaluate_skill_version(skill["id"], 1, baseline)

    rubric = evaluate_and_save(dataset, "proposal_v1")
    updated = evaluate_skill_version(skill["id"], 1, rubric)
    version = updated["versions"][0]
    assert version["status"] == "rubric_evaluated"
    assert version["evaluationId"] == rubric["id"]
    assert version["evaluation"]["rule"] == "proposal_v1"
    assert version["applied"] is False
