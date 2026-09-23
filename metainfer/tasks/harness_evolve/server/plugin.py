"""harness_evolve Web plugin registration."""

from pathlib import Path

from metainfer.server.registry import WebPlugin, register

from .routes import build_router

PLUGIN_TYPE = "harness-evolve"
_FRONTEND_DIR = Path(__file__).resolve().parent.parent / "static"

plugin = WebPlugin(
    type=PLUGIN_TYPE,
    label="Harness Evolution (AHE)",
    description=(
        "AHE outer loop: evolve the DKAO harness across task instances with "
        "double-generation iterations, change attribution and auto rollback."
    ),
    build_router=build_router,
    detail_view_module="app/he-detail",
    frontend_dir=_FRONTEND_DIR,
    extra_stylesheets=["he.css"],
    # The AHE page embeds the DKAO task view to mirror one question of one
    # iteration (see LiveDkaoMirror in he-detail.js). Point at the DKAO
    # plugin's own bundle rather than shipping a second copy, so the embedded
    # view and the standalone DKAO page cannot drift apart. Listed explicitly
    # because auto-discovery only yields ``app/<own file stem>`` keys.
    importmap_entries={
        "app/dkao-detail":
            "/static/plugins/dcu-kernel-auto-opt/dkao-detail.js?v=CACHE_BUST",
    },
)

register(plugin)
