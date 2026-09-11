"""Validation-budget knobs (scope + bench sampling) shared by DKAO and AHE."""

from __future__ import annotations

import pytest

from ..orchestrator.gen_and_opt_pipeline import _validation_shape_list
from ..orchestrator.validation_budget import (
    ENV_BENCH_SAMPLES, ENV_BENCH_WARMUPS, ENV_VALIDATE_SCOPE, QUICK_BENCH,
    resolve_bench_kwargs, resolve_validation_scope,
)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for name in (ENV_VALIDATE_SCOPE, ENV_BENCH_WARMUPS, ENV_BENCH_SAMPLES,
                 "METAINFER_BENCH_REPLAYS"):
        monkeypatch.delenv(name, raising=False)


def test_scope_defaults_to_full_api(monkeypatch):
    assert resolve_validation_scope({}) == "api"
    assert resolve_validation_scope(None) == "api"


def test_scope_reads_form_labels(monkeypatch):
    assert resolve_validation_scope({"validation_scope": "Task shapes only"}) == "task"
    assert resolve_validation_scope({"validation_scope": "All API shapes"}) == "api"
    assert resolve_validation_scope({"validation_scope": "task"}) == "task"


def test_scope_env_wins(monkeypatch):
    monkeypatch.setenv(ENV_VALIDATE_SCOPE, "task")
    assert resolve_validation_scope({"validation_scope": "All API shapes"}) == "task"


def test_bench_kwargs_default_and_quick(monkeypatch):
    assert resolve_bench_kwargs({}) == {}
    assert resolve_bench_kwargs({"bench_profile": "quick"}) == QUICK_BENCH
    assert resolve_bench_kwargs({"bench_profile": "full"}) == {}


def test_bench_kwargs_explicit_and_env_priority(monkeypatch):
    out = resolve_bench_kwargs({"bench_profile": "quick", "bench_samples": 7})
    assert out["samples"] == 7 and out["warmups"] == QUICK_BENCH["warmups"]
    monkeypatch.setenv(ENV_BENCH_SAMPLES, "5")
    assert resolve_bench_kwargs({"bench_samples": 7})["samples"] == 5


def test_validation_shape_list_scopes():
    optimized = [{"id": "a"}]
    fallback = [{"id": "b"}, {"id": "c"}]
    assert [s["id"] for s in _validation_shape_list(optimized, fallback, "task")] == ["a"]
    assert [s["id"] for s in _validation_shape_list(optimized, fallback, "api")] == ["a", "b", "c"]
