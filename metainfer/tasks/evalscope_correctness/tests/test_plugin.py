"""Auto-registration + form schema for the evalscope-correctness plugin."""

from __future__ import annotations

import pytest

import metainfer.tasks  # noqa: F401 — triggers plugin registration


def test_task_plugin_registered():
    from metainfer.orchestrator.tasks import get_task
    plugin = get_task("evalscope-correctness")
    assert plugin.task_type == "evalscope-correctness"
    assert plugin.cli_module.endswith("orchestrator.cli")
    # Single-run task: no state graph, no copy-forward globs.
    assert plugin.phases_module == ""
    assert plugin.diagnostic_globs == ()


def test_web_plugin_registered():
    from metainfer.server.registry import get
    plugin = get("evalscope-correctness")
    assert plugin is not None
    assert plugin.type == "evalscope-correctness"
    assert plugin.detail_view_module == "app/evalscope-detail"
    assert "evalscope.css" in plugin.extra_stylesheets
    assert plugin.frontend_dir is not None
    assert plugin.extra_watch_paths is not None


def test_form_schema_shape():
    from metainfer.server.forms import load_form_schema
    schema = load_form_schema("evalscope-correctness")
    assert schema is not None
    keys = {f["key"] for f in schema["fields"]}
    for required in ("api_url", "model", "benchmarks"):
        assert required in keys
    by_key = {f["key"]: f for f in schema["fields"]}
    assert by_key["benchmarks"]["type"] == "multiselect"
    opts = {o["label"] for o in by_key["benchmarks"]["options"]}
    assert {"gsm8k", "gpqa_diamond", "humaneval"} <= opts
