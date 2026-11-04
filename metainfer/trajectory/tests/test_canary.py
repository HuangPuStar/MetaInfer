"""Tests for canary provenance/evidence aggregation."""

from __future__ import annotations

from pathlib import Path

import pytest

from metainfer.trajectory import canary
from metainfer.trajectory.annotations import write_annotation


class _Service:
    def list_sessions(self, limit=1000):
        return {"sessions": [
            {"id": "session-a", "title": "a", "status": "completed",
             "skillOverlays": [{"releaseId": "rel-1", "role": "advisor"}]},
            {"id": "session-b", "title": "b", "status": "completed",
             "skillOverlays": [{"releaseId": "rel-1", "role": "advisor"}]},
            {"id": "session-c", "title": "c", "status": "completed", "skillOverlays": []},
        ]}


@pytest.fixture
def platform_home(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("METAINFER_ROOT", str(tmp_path / "root"))
    monkeypatch.setenv("METAINFER_NODE_ID", "test-node")
    return tmp_path / "root"


def test_canary_evidence_joins_provenance_with_annotations(platform_home: Path, monkeypatch) -> None:
    write_annotation("session-a", {"outcome": "pass"})
    write_annotation("session-b", {"outcome": "fail", "failureCategory": "verification"})
    monkeypatch.setattr(canary, "list_releases", lambda: [{
        "id": "rel-1", "skillId": "skill-1", "status": "canary",
        "target": {"canaryPercent": 10},
    }])
    report = canary.canary_report("skill-1", _Service())
    release = report["releases"][0]
    assert release["canaryPercent"] == 10
    assert [item["sessionId"] for item in release["sessions"]] == ["session-a", "session-b"]
    assert release["outcomes"] == {"pass": 1, "fail": 1, "uncertain": 0, "unreviewed": 0}


def test_promotion_readiness_requires_three_labels(platform_home: Path, monkeypatch) -> None:
    write_annotation("session-a", {"outcome": "pass"})
    write_annotation("session-b", {"outcome": "fail"})
    monkeypatch.setattr(canary, "list_releases", lambda: [{
        "id": "rel-1", "skillId": "skill-1", "status": "canary",
        "target": {"canaryPercent": 10},
    }])
    gate = canary.promotion_readiness("skill-1", _Service())
    assert gate["ready"] is False
    assert gate["labeled"] == 2
    assert any("at least 3" in reason for reason in gate["reasons"])

    write_annotation("session-c", {"outcome": "pass"})
    # _Service has no skillOverlays on session-c; add a temporary service.
    class _Three(_Service):
        def list_sessions(self, limit=1000):
            data = super().list_sessions(limit)
            data["sessions"].append({
                "id": "session-c", "title": "c", "status": "completed",
                "skillOverlays": [{"releaseId": "rel-1", "role": "advisor"}],
            })
            return data
    gate = canary.promotion_readiness("skill-1", _Three())
    assert gate["ready"] is True
    assert gate["labeled"] == 3


def test_lab_canary_report_joins_project_context(platform_home: Path, monkeypatch) -> None:
    write_annotation("session-a", {"outcome": "pass"})
    write_annotation("session-b", {"outcome": "fail"})
    monkeypatch.setattr(canary, "list_releases", lambda: [{
        "id": "rel-lab", "skillId": "skill-1", "status": "active_registry",
        "labCanaryPercent": 10, "labApplied": False,
    }])

    class _LabService(_Service):
        def list_sessions(self, limit=1000):
            data = super().list_sessions(limit)
            for item in data["sessions"]:
                item["context"] = {"kind": "research-lab", "projectId": "prj-1", "nodeId": "n-1"}
                item["skillOverlays"] = [{"releaseId": "rel-lab", "role": "advisor"}]
            return data

    report = canary.lab_canary_report("skill-1", _LabService())
    release = report["releases"][0]
    assert release["canaryPercent"] == 10
    assert release["applied"] is False
    assert release["outcomes"]["pass"] == 1
    assert release["outcomes"]["fail"] == 1
    assert release["sessions"][0]["projectId"] == "prj-1"


def test_lab_promotion_readiness_requires_labels(platform_home: Path, monkeypatch) -> None:
    write_annotation("session-a", {"outcome": "pass"})
    write_annotation("session-b", {"outcome": "fail"})
    monkeypatch.setattr(canary, "list_releases", lambda: [{
        "id": "rel-lab", "skillId": "skill-1", "status": "active_registry",
        "labCanaryPercent": 10, "labApplied": False,
    }])

    class _LabService(_Service):
        def list_sessions(self, limit=1000):
            data = super().list_sessions(limit)
            for item in data["sessions"]:
                item["context"] = {"kind": "research-lab", "projectId": "prj-1", "nodeId": "n-1"}
                item["skillOverlays"] = [{"releaseId": "rel-lab", "role": "advisor"}]
            return data

    gate = canary.lab_promotion_readiness("skill-1", _LabService())
    assert gate["ready"] is False
    assert gate["labeled"] == 2
    assert any("at least 3" in reason for reason in gate["reasons"])

    write_annotation("session-c", {"outcome": "pass"})

    class _Three(_LabService):
        def list_sessions(self, limit=1000):
            data = super().list_sessions(limit)
            data["sessions"] = [
                item for item in data["sessions"] if item.get("id") != "session-c"
            ]
            data["sessions"].append({
                "id": "session-c", "title": "c", "status": "completed",
                "context": {"kind": "research-lab", "projectId": "prj-1", "nodeId": "n-2"},
                "skillOverlays": [{"releaseId": "rel-lab", "role": "advisor"}],
            })
            return data

    gate = canary.lab_promotion_readiness("skill-1", _Three())
    assert gate["ready"] is True
    assert gate["labeled"] == 3
