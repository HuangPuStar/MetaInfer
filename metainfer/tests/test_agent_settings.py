"""Tests for the UI-persisted coding-agent backend setting."""

from __future__ import annotations

from pathlib import Path

import pytest

from metainfer.server import agent_settings


@pytest.fixture(autouse=True)
def _root(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("METAINFER_ROOT", str(tmp_path / "root"))
    monkeypatch.setenv("METAINFER_NODE_ID", "test-node")
    monkeypatch.delenv("METAINFER_AGENT_BACKEND", raising=False)
    monkeypatch.delenv("METAINFER_DSH_BIN", raising=False)
    yield


def test_default_without_file_is_claude():
    settings = agent_settings.read_settings()
    assert settings["backend"] == "claude"
    assert settings["source"] == "default"


def test_write_dsh_settings_and_apply_to_spawn_env():
    saved = agent_settings.write_settings("dsh", "/usr/local/bin/dsh")
    assert saved["backend"] == "dsh"
    assert saved["dshBin"] == "/usr/local/bin/dsh"
    assert saved["source"] == "config"

    env = {"UNCHANGED": "1"}
    applied = agent_settings.apply_to_env(env)
    assert applied["METAINFER_AGENT_BACKEND"] == "dsh"
    assert applied["METAINFER_DSH_BIN"] == "/usr/local/bin/dsh"
    assert applied["UNCHANGED"] == "1"


def test_invalid_backend_is_rejected():
    with pytest.raises(ValueError):
        agent_settings.write_settings("not-a-backend")


def test_file_can_override_environment(monkeypatch):
    monkeypatch.setenv("METAINFER_AGENT_BACKEND", "claude")
    agent_settings.write_settings("dsh", "dsh")
    assert agent_settings.read_settings()["source"] == "config"
    env = agent_settings.apply_to_env({})
    assert env["METAINFER_AGENT_BACKEND"] == "dsh"


def test_ensure_authenticated_headless_profile(tmp_path, monkeypatch):
    monkeypatch.setenv("DSH_HOME", str(tmp_path / "dsh-home"))
    first = agent_settings.ensure_dsh_profile("metainfer-headless")
    assert first["created"] is True
    profile = Path(first["path"])
    assert (profile / "package.json").is_file()
    assert "deepseek-account" in (profile / "cordis.patch.yml").read_text()
    second = agent_settings.ensure_dsh_profile("metainfer-headless")
    assert second["created"] is False
    with pytest.raises(ValueError):
        agent_settings.ensure_dsh_profile("another-profile")


def test_settings_round_trip_includes_dsh_profile():
    saved = agent_settings.write_settings("dsh", "/usr/local/bin/dsh", "metainfer-headless")
    assert saved["dshProfile"] == "metainfer-headless"
    env = agent_settings.apply_to_env({})
    assert env["METAINFER_DSH_PROFILE"] == "metainfer-headless"
