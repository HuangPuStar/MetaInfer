"""Shared fixtures for harness_evolve plugin route tests."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from metainfer.testing import isolated_env  # noqa: F401 - re-export as fixture
from metainfer.server import app as app_module


@pytest.fixture
def app(isolated_env):
    return app_module.create_app()


@pytest.fixture
def client(app):
    return TestClient(app)
