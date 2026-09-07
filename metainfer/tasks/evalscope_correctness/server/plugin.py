"""WebPlugin for evalscope-correctness — registers routes + detail view."""

from __future__ import annotations

from pathlib import Path
from typing import List

from metainfer.server._helpers import state_dir_for
from metainfer.server.registry import WebPlugin, register

from .routes import build_router

PLUGIN_TYPE = "evalscope-correctness"
_FRONTEND_DIR = Path(__file__).resolve().parent.parent / "static"


def _extra_watch_paths(entry) -> List[Path]:
    """Tell the SSE watcher when ``result.json`` changes so the detail
    view refetches the moment a run completes.

    ``result.json`` lives under ``state_dir`` (already watched via
    run.json/timeline.jsonl), but the shell's watcher only monitors a fixed
    relpath set by default; pointing it at the authoritative result file
    keeps the UI fresh without an arbitrary polling interval in the browser.
    """
    return [state_dir_for(entry) / "result.json"]


plugin = WebPlugin(
    type=PLUGIN_TYPE,
    label="EvalScope Correctness",
    description=(
        "Run EvalScope correctness benchmarks (GSM8K, GPQA-Diamond, HumanEval, "
        "or custom datasets) against an OpenAI-compatible endpoint and report "
        "normalized per-dataset scores with optional minimum-score gates."
    ),
    build_router=build_router,
    detail_view_module="app/evalscope-detail",
    detail_view_export="default",
    frontend_dir=_FRONTEND_DIR,
    importmap_entries={},
    extra_stylesheets=["evalscope.css"],
    extra_watch_paths=_extra_watch_paths,
)

register(plugin)
