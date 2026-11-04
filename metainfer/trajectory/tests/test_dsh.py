"""Focused tests for the DSH-only trajectory ingestion slice."""

from __future__ import annotations

import json
from pathlib import Path

from metainfer.trajectory.dsh import analyze_session, discover_session_files
from metainfer.trajectory.service import TrajectoryService


def _write_session(root: Path, session_id: str = "session-demo") -> Path:
    session_dir = root / "workspace" / session_id
    session_dir.mkdir(parents=True)
    rows = [
        {
            "type": "session",
            "version": 4,
            "id": session_id,
            "createdAt": 1_700_000_000_000,
            "cwd": "/tmp/demo-worktree",
            "agentPreset": "lab-worker",
        },
        {"type": "turn/start", "seq": 0, "time": 1_700_000_001_000, "data": {"turn": 1}},
        {
            "type": "user/message",
            "seq": 1,
            "time": 1_700_000_002_000,
            "data": {
                "content": [{"type": "text", "text": "<!-- METAINFER_SKILL_RELEASE:skill-release-demo;ROLE:reviewer -->\nRun the smoke test"}],
                "source": {"kind": "user"},
            },
        },
        {
            "type": "assistant/message",
            "seq": 2,
            "time": 1_700_000_003_000,
            "data": {
                "message": {
                    "role": "assistant",
                    "source": {"kind": "model", "provider": "deepseek-account", "model": "deepseek-flash"},
                    "content": [{"type": "text", "text": "I will run it."}],
                },
                "usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 17},
            },
        },
        {
            "type": "tool/call",
            "seq": 3,
            "time": 1_700_000_004_000,
            "data": {
                "callId": "call-1",
                "name": "bash",
                "arguments": json.dumps({"command": "false"}),
            },
        },
        {
            "type": "tool/result",
            "seq": 4,
            "time": 1_700_000_005_000,
            "data": {
                "toolCallId": "call-1",
                "message": {
                    "role": "tool",
                    "isError": True,
                    "content": [{"type": "text", "text": "command failed"}],
                },
            },
        },
        {"type": "turn/end", "seq": 5, "time": 1_700_000_006_000, "data": {"turn": 1, "reason": {"kind": "completed"}}},
    ]
    path = session_dir / "session.v4.jsonl"
    path.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n", encoding="utf-8")
    return path


def test_analyze_session_projects_metrics_and_timeline(tmp_path: Path) -> None:
    _write_session(tmp_path)
    files, warnings = discover_session_files(tmp_path)
    assert len(files) == 1
    assert warnings == []

    session = analyze_session(files[0])
    assert session["id"] == "session-demo"
    assert session["title"] == "Run the smoke test"
    assert session["status"] == "completed"
    assert session["turns"] == 1
    assert session["toolCalls"] == 1
    assert session["toolErrors"] == 1
    assert session["tokens"] == {
        "input": 10,
        "output": 5,
        "cacheRead": 0,
        "cacheWrite": 0,
        "total": 17,
    }
    assert session["toolBreakdown"][0]["name"] == "bash"
    assert session["toolBreakdown"][0]["errors"] == 1
    assert any(item["type"] == "tool_call" for item in session["timeline"])
    assert any(item["type"] == "error" for item in session["timeline"])
    assert any("工具调用" in finding for finding in session["analysis"]["findings"])
    assert session["skillOverlays"] == [{"releaseId": "skill-release-demo", "role": "reviewer"}]


def test_service_lists_and_reads_by_session_id(tmp_path: Path) -> None:
    _write_session(tmp_path)
    service = TrajectoryService(tmp_path)

    listing = service.list_sessions(limit=10)
    assert listing["count"] == 1
    assert listing["sessions"][0]["id"] == "session-demo"
    assert "timeline" not in listing["sessions"][0]

    detail = service.get_session("session-demo")
    assert detail["id"] == "session-demo"
    assert len(detail["timeline"]) >= 4

    assert service.list_sessions(query="smoke", limit=10)["count"] == 1
    assert service.list_sessions(query="skill-release-demo", limit=10)["count"] == 1
    assert service.list_sessions(query="not-present", limit=10)["count"] == 0


def test_discovery_ignores_unsupported_versions(tmp_path: Path) -> None:
    session_dir = tmp_path / "workspace" / "old"
    session_dir.mkdir(parents=True)
    (session_dir / "session.v3.jsonl").write_text('{"type":"session","version":3,"id":"old"}\n', encoding="utf-8")
    files, warnings = discover_session_files(tmp_path)
    assert files == []
    assert any("unsupported" in warning for warning in warnings)


def test_list_sessions_filters_by_project(tmp_path: Path) -> None:
    from metainfer.trajectory.service import TrajectoryService

    path = _write_session(tmp_path)
    path.write_text(
        path.read_text(encoding="utf-8").replace(
            "/tmp/demo-worktree", "/tmp/mirl/worktrees/proj-1/node-1"
        ),
        encoding="utf-8",
    )
    service = TrajectoryService(root=tmp_path)
    assert service.list_sessions(project_id="proj-1", limit=10)["count"] == 1
    assert service.list_sessions(project_id="proj-2", limit=10)["count"] == 0
