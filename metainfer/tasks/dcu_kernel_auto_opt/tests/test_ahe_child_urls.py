"""The embedded (AHE-child) view must address the routes, not a 404.

The standalone DKAO page resolves its run through the task registry in the
path (``/api/dcu-kernel-auto-opt/<task_id>/<endpoint>``). The AHE page instead
passes the child's artifact directory, which travels as a *query* parameter
(``?state_dir=...``), so every URL has to be built as

    <base>/<endpoint>?state_dir=<dir>

and never the other way round. Building it the other way round -- handing
callers a ``base`` that already carries ``?state_dir=...`` and appending
``/summary`` to it -- yields ``...?state_dir=<dir>/summary``: FastAPI routes on
the path alone, so no route matches, the three reads that fill the view
(summary / state-graph / iterations) all 404, and the mirror renders "Error:
... returned HTTP 404" under every question. The standalone page is unaffected,
which is why this stayed invisible until AHE embedded the view.

The module cannot be imported by pytest (it is a browser ES module), but node
can import it as-is: the two bare specifiers resolve to the vendored browser
bundles the shell actually serves. Executing the real URL builders is the only
way to pin argument order, so these tests do that rather than pattern-match the
source. They skip when no node is available.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import textwrap
from pathlib import Path

import pytest

_TASK_DIR = Path(__file__).resolve().parent.parent
_STATIC = _TASK_DIR / "static" / "dkao-detail.js"
_SHELL = _TASK_DIR.parent / "sys_shell" / "static"
_VENDOR = _SHELL / "vendor"

# A child directory shaped exactly like a real one, so the assertion also
# documents which URL shapes the DKAO routes have to accept.
_STATE_DIR = ("/root/zth_agent/MetaInfer/nodes/worker29/workspaces/he-run"
              "/children/iteration_002/glm_tp8_o_proj_m4096/state")

# The three reads the embedded view needs before it can render anything.
_READ_ENDPOINTS = ("/summary", "/state-graph", "/iterations")


def _node() -> str:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed: cannot execute the bundle's URLs")
    return node


def _bundle_urls(tmp_path: Path, endpoints) -> dict:
    """Import the shipped bundle in node and return the URLs it builds."""
    loader = tmp_path / "loader.mjs"
    loader.write_text(textwrap.dedent(f"""
        const MAP = {{
          "preact": {json.dumps((_VENDOR / "preact.js").as_uri())},
          "preact/hooks": {json.dumps((_VENDOR / "preact-hooks.js").as_uri())},
          "preact/jsx-runtime": {json.dumps((_VENDOR / "preact.js").as_uri())},
          "htm": {json.dumps((_VENDOR / "htm-core.js").as_uri())},
          "htm/preact": {json.dumps((_VENDOR / "htm.js").as_uri())},
          // The view also uses the shell's shared API/polling helpers; they
          // are plain modules, so the bundler-less import works here too.
          "app/api": {json.dumps((_SHELL / "components" / "api.js").as_uri())},
          "app/utils": {json.dumps((_SHELL / "components" / "utils.js").as_uri())},
        }};
        export async function resolve(specifier, context, next) {{
          if (MAP[specifier]) return {{ url: MAP[specifier], shortCircuit: true }};
          return next(specifier, context);
        }}
        """), encoding="utf-8")

    probe = tmp_path / "probe.mjs"
    probe.write_text(textwrap.dedent(f"""
        import {{ register }} from "node:module";
        register({json.dumps(loader.as_uri())});
        const m = await import({json.dumps(_STATIC.as_uri())});
        const ctx = {{ taskId: "glm_tp8_o_proj_m4096",
                       stateDir: {json.dumps(_STATE_DIR)}, readOnly: true }};
        const out = {{ base: m.apiBase(ctx), withState: {{}}, withoutState: {{}} }};
        for (const ep of {json.dumps(list(endpoints))}) {{
          out.withState[ep] = m.apiUrl(ctx, ep);
          out.withoutState[ep] = m.apiUrl({{ taskId: ctx.taskId }}, ep);
        }}
        process.stdout.write(JSON.stringify(out));
        """), encoding="utf-8")

    proc = subprocess.run(
        [_node(), str(probe)], capture_output=True, text=True, timeout=60,
        cwd=str(tmp_path))
    assert proc.returncode == 0, f"node failed:\n{proc.stderr}"
    return json.loads(proc.stdout)


def test_the_endpoint_survives_the_state_dir_query(tmp_path):
    """Each read must reach ``<base>/<endpoint>?state_dir=<dir>``.

    Asserted on the parsed URL, not the string: the endpoint has to be *path*
    and the artifact directory has to be *query*. A URL that shape-shifts the
    other way is the bug this test exists for (see the module docstring).
    """
    from urllib.parse import parse_qs, urlsplit

    urls = _bundle_urls(tmp_path, _READ_ENDPOINTS)
    base = urls["base"]
    for endpoint in _READ_ENDPOINTS:
        url = urls["withState"][endpoint]
        parts = urlsplit(url)
        assert parts.path == f"{base}{endpoint}", url
        assert parse_qs(parts.query) == {"state_dir": [_STATE_DIR]}, url
        # the endpoint must never leak into the query value
        assert not parts.query.endswith(endpoint), url


def test_the_standalone_page_still_addresses_routes_by_task_id(tmp_path):
    """No state dir -> the plain registry path, byte for byte as before."""
    urls = _bundle_urls(tmp_path, _READ_ENDPOINTS)
    for endpoint in _READ_ENDPOINTS:
        assert urls["withoutState"][endpoint] == \
            f"/api/dcu-kernel-auto-opt/glm_tp8_o_proj_m4096{endpoint}"


def test_the_write_endpoints_are_built_by_the_same_rule(tmp_path):
    """``postJson`` targets carry the query last too.

    Writes are unreachable through the read-only mirror (the routes refuse
    them), so this pins the URL shape of the ones the embedded view can still
    construct -- and documents that workers/skills are addressed under the
    state dir exactly like the reads.
    """
    from urllib.parse import parse_qs, urlsplit

    endpoints = ("/workers/worker_1/guidance", "/skills", "/skills/fuse")
    urls = _bundle_urls(tmp_path, endpoints)
    for endpoint in endpoints:
        parts = urlsplit(urls["withState"][endpoint])
        assert parts.path == f"{urls['base']}{endpoint}"
        assert parse_qs(parts.query) == {"state_dir": [_STATE_DIR]}
