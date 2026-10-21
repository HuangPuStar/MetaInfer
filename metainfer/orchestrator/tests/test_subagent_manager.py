"""Focused tests for SubAgentManager backend command/parse behavior."""

from __future__ import annotations

import json
import tempfile
import time
from pathlib import Path

from metainfer.orchestrator.subagent_manager import (
    AgentHandle,
    AgentSpec,
    SubAgentManager,
)
from metainfer.orchestrator._bootstrap import make_subagent_manager


class _FakeProcess:
    def __init__(self, returncode: int = 0) -> None:
        self.returncode = returncode


def _spec(tmp: Path, *, resume_session_id: str | None = None) -> AgentSpec:
    workdir = tmp / "work"
    log_dir = tmp / "logs"
    workdir.mkdir()
    log_dir.mkdir()
    prompt = tmp / "prompt.txt"
    prompt.write_text("do work", encoding="utf-8")
    return AgentSpec(
        name="agent1",
        role="tester",
        prompt_file=prompt,
        workdir=workdir,
        log_dir=log_dir,
        resume_session_id=resume_session_id,
    )


def test_codex_command_uses_exec_json_and_current_config():
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        kb = tmp / "kb"
        kb.mkdir()
        mgr = SubAgentManager(
            agent_backend="codex",
            codex_bin="codex-dev",
            extra_add_dirs=[kb],
            default_model=None,
        )
        cmd = mgr._build_command(_spec(tmp))
        assert cmd[:5] == ["codex-dev", "exec", "--json", "--color", "never"]
        assert "--skip-git-repo-check" in cmd
        assert "--sandbox" in cmd
        assert "workspace-write" in cmd
        assert "-C" in cmd
        assert str(tmp / "work") in cmd
        assert "--add-dir" in cmd
        assert "/tmp" in cmd
        assert str(kb.resolve()) in cmd
        assert "--model" not in cmd
        assert "--ignore-user-config" not in cmd
        assert cmd[-1] == "-"


def test_codex_resume_command_threads_session():
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        mgr = SubAgentManager(agent_backend="codex", codex_bin="codex-dev",
                              default_model="gpt-5-codex")
        cmd = mgr._build_command(_spec(tmp, resume_session_id="thread-123"))
        assert cmd == [
            "codex-dev", "exec", "resume", "--json",
            "--skip-git-repo-check", "--model", "gpt-5-codex",
            "thread-123", "-",
        ]


def test_materialize_codex_jsonl_result():
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        spec = _spec(tmp)
        events = [
            {"type": "thread.started", "thread_id": "thread-123"},
            {"type": "turn.started"},
            {
                "type": "item.completed",
                "item": {"type": "agent_message", "text": "done"},
            },
            {
                "type": "turn.completed",
                "usage": {
                    "input_tokens": 10,
                    "cached_input_tokens": 8,
                    "output_tokens": 2,
                    "reasoning_output_tokens": 1,
                },
            },
        ]
        ef = spec.events_file(1)
        ef.write_text(
            "Reading additional input from stdin...\n"
            + "\n".join(json.dumps(e) for e in events)
            + "\n",
            encoding="utf-8",
        )
        handle = AgentHandle(
            spec=spec,
            attempt=1,
            process=_FakeProcess(0),  # type: ignore[arg-type]
            started_at=time.time() - 1,
            last_output_at=time.time(),
        )
        mgr = SubAgentManager(agent_backend="codex")
        result = mgr._materialize_result(handle, spec, 1)
        assert result.success
        assert result.final_text == "done"
        assert result.session_id == "thread-123"
        assert result.usage == {**events[-1], "thread_id": "thread-123"}


def test_bootstrap_factory_reads_codex_env(monkeypatch):
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        monkeypatch.setenv("METAINFER_AGENT_BACKEND", "codex")
        monkeypatch.setenv("METAINFER_CODEX_BIN", "codex-dev")
        mgr = make_subagent_manager(
            claude_bin="ccb",
            model=None,
            permission_mode="bypassPermissions",
            effort="max",
            extra_add_dirs=[],
            snapshot_file=tmp / "agents.json",
        )
        try:
            assert mgr.agent_backend == "codex"
            assert mgr.codex_bin == "codex-dev"
        finally:
            mgr.shutdown()


def test_pi_command_uses_json_print_mode():
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        kb = tmp / "kb"
        kb.mkdir()
        mgr = SubAgentManager(
            agent_backend="pi",
            pi_bin="pi-dev",
            extra_add_dirs=[kb],
            default_model="anthropic/claude-sonnet",
            effort="high",
        )
        cmd = mgr._build_command(_spec(tmp))
        assert cmd[:4] == ["pi-dev", "--mode", "json", "-p"]
        assert "--model" in cmd
        assert "anthropic/claude-sonnet" in cmd
        assert "--thinking" in cmd
        assert "high" in cmd
        # session-id pinning only when spec.session_id is set; fresh run
        # leaves it to pi to mint (captured from the stream later).
        assert "--session-id" not in cmd
        assert "--continue" not in cmd


def test_pi_command_resume_threads_session():
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        mgr = SubAgentManager(agent_backend="pi", pi_bin="pi-dev",
                              default_model="anthropic/claude-sonnet")
        cmd = mgr._build_command(_spec(tmp, resume_session_id="01abc-def"))
        assert "--session" in cmd
        assert "01abc-def" in cmd
        assert "--continue" in cmd
        assert "--model" in cmd


def test_pi_session_dir_isolates_from_user_pi_index():
    """Orchestrator sessions must land in a per-task --session-dir so a
    user running ``pi --continue`` from their shell (which indexes
    ~/.pi) cannot attach to a production orchestrator session mid-flight.
    """
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        session_dir = tmp / "pi-sessions"
        mgr = SubAgentManager(
            agent_backend="pi", pi_bin="pi-dev",
            pi_session_dir=session_dir,
        )
        cmd = mgr._build_command(_spec(tmp))
        assert "--session-dir" in cmd
        idx = cmd.index("--session-dir")
        assert cmd[idx + 1] == str(session_dir.resolve())
        # the dir is created lazily so pi can write into it
        assert session_dir.is_dir()


def test_pi_session_dir_applied_on_resume_too():
    """Resume turns must keep using the isolated session dir so the
    continued session stays out of the user's ~/.pi index.
    """
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        session_dir = tmp / "pi-sessions"
        mgr = SubAgentManager(
            agent_backend="pi", pi_bin="pi-dev",
            pi_session_dir=session_dir,
        )
        cmd = mgr._build_command(_spec(tmp, resume_session_id="01abc-def"))
        assert "--session-dir" in cmd
        assert "--session" in cmd
        assert "01abc-def" in cmd
        assert "--continue" in cmd


def test_pi_session_dir_absent_when_not_configured():
    """Legacy callers (no state_dir) keep the old behavior: pi picks its
    own default session dir. No regression for backends that never set
    pi_session_dir.
    """
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        mgr = SubAgentManager(agent_backend="pi", pi_bin="pi-dev")
        cmd = mgr._build_command(_spec(tmp))
        assert "--session-dir" not in cmd


def test_bootstrap_factory_wires_pi_session_dir_from_state_dir(monkeypatch):
    """make_subagent_manager derives pi_session_dir from state_dir so every
    task's orchestrator sessions are isolated under <state_dir>/pi-sessions.
    """
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        state_dir = tmp / "state"
        state_dir.mkdir()
        monkeypatch.setenv("METAINFER_AGENT_BACKEND", "pi")
        mgr = make_subagent_manager(
            claude_bin="ccb",
            model=None,
            permission_mode="bypassPermissions",
            effort="max",
            extra_add_dirs=[],
            snapshot_file=tmp / "agents.json",
            state_dir=state_dir,
        )
        try:
            assert mgr.agent_backend == "pi"
            assert mgr.pi_session_dir == (state_dir / "pi-sessions").resolve()
        finally:
            mgr.shutdown()


def test_bootstrap_factory_no_state_dir_leaves_pi_session_dir_none(monkeypatch):
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        monkeypatch.setenv("METAINFER_AGENT_BACKEND", "pi")
        mgr = make_subagent_manager(
            claude_bin="ccb",
            model=None,
            permission_mode="bypassPermissions",
            effort="max",
            extra_add_dirs=[],
            snapshot_file=tmp / "agents.json",
        )
        try:
            assert mgr.pi_session_dir is None
        finally:
            mgr.shutdown()


def test_pi_normalize_accepts_aliases():
    from metainfer.orchestrator.subagent_manager import _normalize_agent_backend
    assert _normalize_agent_backend("pi") == "pi"
    assert _normalize_agent_backend("PI") == "pi"
    assert _normalize_agent_backend("pi-coding-agent") == "pi"
    assert _normalize_agent_backend("earendil") == "pi"


def test_materialize_pi_jsonl_result():
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        spec = _spec(tmp)
        events = [
            {"type": "session", "version": 3, "id": "01a00ecf-aaaa-bbbb-cccc-dddddddddddd",
             "timestamp": "2026-08-17T08:21:39.437Z", "cwd": "/tmp"},
            {"type": "agent_start"},
            {"type": "turn_start"},
            {"type": "message_end", "message": {"role": "user", "content": []}},
            {"type": "message_end", "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "hello world"}],
                "usage": {"input": 581, "output": 3, "cacheRead": 0,
                          "cacheWrite": 0, "reasoning": 0, "totalTokens": 584,
                          "cost": {"input": 0, "output": 0, "cacheRead": 0,
                                   "cacheWrite": 0, "total": 0.0123}},
                "stopReason": "stop"}},
            {"type": "turn_end", "message": {"role": "assistant",
                "content": [{"type": "text", "text": "hello world"}],
                "usage": {"input": 581, "output": 3, "cacheRead": 0,
                          "cacheWrite": 0, "totalTokens": 584,
                          "cost": {"total": 0.0123}}}, "toolResults": []},
            {"type": "agent_end", "messages": [
                {"role": "user", "content": []},
                {"role": "assistant", "content": [{"type": "text", "text": "hello world"}],
                 "usage": {"input": 581, "output": 3, "cacheRead": 0,
                           "cacheWrite": 0, "cost": {"total": 0.0123}}}]},
            {"type": "agent_settled"},
        ]
        ef = spec.events_file(1)
        ef.write_text(
            "\n".join(json.dumps(e) for e in events) + "\n",
            encoding="utf-8",
        )
        handle = AgentHandle(
            spec=spec,
            attempt=1,
            process=_FakeProcess(0),  # type: ignore[arg-type]
            started_at=time.time() - 1,
            last_output_at=time.time(),
        )
        mgr = SubAgentManager(agent_backend="pi")
        result = mgr._materialize_result(handle, spec, 1)
        assert result.success
        assert result.final_text == "hello world"
        assert result.session_id == "01a00ecf-aaaa-bbbb-cccc-dddddddddddd"
        assert result.usage is not None
        assert result.usage["usage"]["input_tokens"] == 581
        assert result.usage["usage"]["output_tokens"] == 3
        assert result.usage["usage"]["cache_read_input_tokens"] == 0
        assert result.usage["usage"]["cache_creation_input_tokens"] == 0
        assert result.usage["total_cost_usd"] == 0.0123
        assert result.usage["session_id"] == "01a00ecf-aaaa-bbbb-cccc-dddddddddddd"


def test_bootstrap_factory_reads_pi_env(monkeypatch):
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        monkeypatch.setenv("METAINFER_AGENT_BACKEND", "pi")
        monkeypatch.setenv("METAINFER_PI_BIN", "/usr/local/bin/pi")
        mgr = make_subagent_manager(
            claude_bin="ccb",
            model=None,
            permission_mode="bypassPermissions",
            effort="max",
            extra_add_dirs=[],
            snapshot_file=tmp / "agents.json",
        )
        try:
            assert mgr.agent_backend == "pi"
            assert mgr.pi_bin == "/usr/local/bin/pi"
        finally:
            mgr.shutdown()
