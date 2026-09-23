"""AgentEvolver must never crash the outer loop.

A timed-out or failed evolve turn keeps the iteration's evaluation value:
apply() returns a no-change placeholder (champion unchanged) so the pipeline
still writes evolve artifacts + report + finished.
"""

from __future__ import annotations

import subprocess

import pytest

from metainfer.tasks.harness_evolve.orchestrator import evolve as ev


def _ctx() -> dict:
    return {
        "overview": "/tmp/overview.md",
        "results": {},
        "diff": {},
        "decision": {"verdict": "BASELINE"},
        "selected": ["a"],
        "pool_ids": ["a", "b"],
    }


def test_timeout_returns_placeholder(tmp_path, monkeypatch):
    def _boom(*_a, **_kw):
        raise subprocess.TimeoutExpired(cmd="dsh_agent.py", timeout=1800)

    monkeypatch.setattr(ev.subprocess, "run", _boom)
    out = ev.AgentEvolver(timeout_seconds=1800).apply(tmp_path, 3, _ctx())
    assert out["changed"] is False
    assert out["round_plan"] is None
    assert out["manifest"]["changes"] == []
    assert out["manifest"]["verification"]["status"] == "evolve_failed"
    assert "timed out" in out["manifest"]["note"]
    assert "failed" in out["summary"]


def test_nonzero_exit_returns_placeholder(tmp_path, monkeypatch):
    class _P:
        returncode = 1
        stdout = ""
        stderr = "boom: agent crashed"

    monkeypatch.setattr(ev.subprocess, "run", lambda *a, **k: _P())
    out = ev.AgentEvolver().apply(tmp_path, 1, _ctx())
    assert out["manifest"]["verification"]["status"] == "evolve_failed"
    assert "rc=1" in out["manifest"]["note"]


def test_missing_artifacts_returns_placeholder(tmp_path, monkeypatch):
    class _P:
        returncode = 0
        stdout = ""
        stderr = ""

    monkeypatch.setattr(ev.subprocess, "run", lambda *a, **k: _P())
    out = ev.AgentEvolver().apply(tmp_path, 1, _ctx())
    assert out["manifest"]["verification"]["status"] == "evolve_failed"
    assert "did not write" in out["manifest"]["note"]


def test_successful_evolve_still_returns_artifacts(tmp_path, monkeypatch):
    class _P:
        returncode = 0
        stdout = '{"type": "result", "result": "done"}\n'
        stderr = ""

    def _run(*_a, **_kw):
        # The agent writes its artifacts during the run (apply clears them
        # before spawning), so emulate that side effect here.
        (tmp_path / ev.AgentEvolver.MANIFEST_NAME).write_text(
            '{"schema_version": 1, "iteration": 1, "changes": [{"id": "c1"}],'
            ' "verification": {"status": "pending"}}', encoding="utf-8")
        (tmp_path / ev.AgentEvolver.PLAN_NAME).write_text(
            '{"iteration": 1, "strategy": "balanced", "selected": ["a"]}',
            encoding="utf-8")
        return _P()

    monkeypatch.setattr(ev.subprocess, "run", _run)
    out = ev.AgentEvolver().apply(tmp_path, 1, _ctx())
    assert out["changed"] is True
    assert out["round_plan"]["selected"] == ["a"]
    assert out["summary"] == "done"
