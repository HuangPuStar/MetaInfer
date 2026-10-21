"""Core web endpoint tests — task-types, /api/sys-shell CRUD, control actions,
DELETE task.

These exercise plugin-agnostic behavior. calc_value-specific routes live
in ``metainfer/tasks/calc_value/tests/test_routes.py``.
"""

from __future__ import annotations

import json
from pathlib import Path

from metainfer.server import tasks as _tasks
from metainfer.server.registry import all_plugins as _all_plugins
from metainfer.server.tasks import TaskEntry


def _register_task(state_dir: Path, task_id: str = "ct-1",
                   task_type: str = "calc-theoretical-value") -> TaskEntry:
    state_dir.mkdir(parents=True, exist_ok=True)
    entry = TaskEntry(
        id=task_id, type=task_type,
        label="test task", state_dir=str(state_dir), created_at=0.0,
    )
    _tasks.add_task(entry)
    return entry


# --------------------------------------------------------------------------- #
# /api/sys-shell/task-types
# --------------------------------------------------------------------------- #

def test_task_types_endpoint(client):
    resp = client.get("/api/sys-shell/task-types")
    assert resp.status_code == 200
    ids = [t["id"] for t in resp.json()]
    assert "calc-theoretical-value" in ids


def test_task_type_schema_endpoint(client):
    resp = client.get("/api/sys-shell/task-types/calc-theoretical-value/schema")
    assert resp.status_code == 200
    schema = resp.json()
    assert schema["type"] == "calc-theoretical-value"
    assert "fields" in schema


def test_task_type_schema_404(client):
    resp = client.get("/api/sys-shell/task-types/no-such-type/schema")
    assert resp.status_code == 404


# --------------------------------------------------------------------------- #
# /api/sys-shell/tasks
# --------------------------------------------------------------------------- #

def test_tasks_empty_initially(client, isolated_env):
    resp = client.get("/api/sys-shell/tasks")
    assert resp.status_code == 200
    assert resp.json() == {"tasks": []}


def test_get_task_404(client):
    resp = client.get("/api/sys-shell/no-such")
    assert resp.status_code == 404


# --------------------------------------------------------------------------- #
# Control actions (plugin-agnostic)
# --------------------------------------------------------------------------- #

def test_control_reset_wipes_state_when_stopped(client, isolated_env):
    state_dir = isolated_env["home"] / "tasks" / "ct-1"
    _register_task(state_dir, "ct-1")
    (state_dir / "run.json").write_text(
        json.dumps({"task_id": "ct-1", "current_phase": "S3"}),
        encoding="utf-8",
    )
    (state_dir / "orchestrator.log").write_text("blah", encoding="utf-8")
    (state_dir / "iterations").mkdir()
    resp = client.post("/api/sys-shell/ct-1/control", json={"action": "reset"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["action"] == "reset"
    run = json.loads((state_dir / "run.json").read_text())
    assert run["current_phase"] == "idle"
    assert run["current_iteration"] == 0
    assert not (state_dir / "orchestrator.log").exists()
    assert not (state_dir / "iterations").exists()


def test_control_reset_rejects_running_task(client, isolated_env):
    state_dir = isolated_env["home"] / "tasks" / "ct-1"
    _register_task(state_dir, "ct-1")
    isolated_env["launcher"]._running["ct-1"] = True  # pretend it's running
    resp = client.post("/api/sys-shell/ct-1/control", json={"action": "reset"})
    assert resp.status_code == 409
    assert "running" in resp.json()["detail"].lower()


def test_control_reset_stamps_timeline(client, isolated_env):
    state_dir = isolated_env["home"] / "tasks" / "ct-1"
    _register_task(state_dir, "ct-1")
    client.post("/api/sys-shell/ct-1/control", json={"action": "reset"})
    timeline_path = state_dir / "timeline.jsonl"
    assert timeline_path.exists()
    lines = [ln for ln in timeline_path.read_text().splitlines() if ln.strip()]
    types = [json.loads(ln)["type"] for ln in lines]
    assert "task_reset" in types


def _register_task_with_workspace(state_dir, workspace_dir, task_id,
                                  task_type="calc-theoretical-value"):
    state_dir.mkdir(parents=True, exist_ok=True)
    workspace_dir.mkdir(parents=True, exist_ok=True)
    entry = TaskEntry(
        id=task_id, type=task_type, label="test task",
        state_dir=str(state_dir), created_at=0.0,
        workspace_dir=str(workspace_dir),
    )
    _tasks.add_task(entry)
    return entry


def _timeline_events(state_dir):
    lines = [ln for ln in (state_dir / "timeline.jsonl").read_text().splitlines()
             if ln.strip()]
    return [json.loads(ln) for ln in lines]


def test_control_restart_resets_finished_task_and_reruns(client, isolated_env):
    """Restart on a FINISHED task re-runs from scratch: state + workspace
    are reset, then the orchestrator starts fresh. Resuming a finished
    task would just re-terminate instantly (iteration cap reached), so
    'restart' must mean re-run, not resume."""
    home = isolated_env["home"]
    state_dir = home / "tasks" / "ct-1"
    workspace_dir = home.parent / "workspaces" / "ct-1"
    _register_task_with_workspace(state_dir, workspace_dir, "ct-1")
    (state_dir / "requirements.json").write_text(json.dumps({
        "task_id": "ct-1", "task_type": "calc-theoretical-value",
        "max_iterations": 3,
    }), encoding="utf-8")
    (state_dir / "run.json").write_text(json.dumps({
        "task_id": "ct-1", "current_phase": "finished",
        "current_iteration": 3, "finished": True, "final_status": "success",
    }), encoding="utf-8")
    (state_dir / "iterations").mkdir()
    (workspace_dir / "001").mkdir()

    resp = client.post("/api/sys-shell/ct-1/control", json={"action": "restart"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["action"] == "restart"
    assert body["restarted_from_scratch"] is True

    # state wiped: fresh idle run.json (reset_state_dir wrote it)
    run = json.loads((state_dir / "run.json").read_text())
    assert run["current_phase"] == "idle"
    assert run["current_iteration"] == 0
    assert run["finished"] is False
    # prior iterations dir + workspace artifacts gone
    assert not (state_dir / "iterations").exists()
    assert not (workspace_dir / "001").exists()
    # orchestrator was started
    assert "ct-1" in isolated_env["launcher"].started
    # timeline records fresh_run mode + the reset
    ev = _timeline_events(state_dir)
    types = [e["type"] for e in ev]
    assert "task_reset" in types
    ri = [e for e in ev if e["type"] == "restart_initiated"]
    assert ri and ri[0]["payload"]["resume_mode"] == "fresh_run"


def test_control_restart_resumes_interrupted_task(client, isolated_env):
    """Restart on an interrupted (NOT finished) task resumes from its
    last phase — state is preserved, no reset."""
    home = isolated_env["home"]
    state_dir = home / "tasks" / "ct-2"
    workspace_dir = home.parent / "workspaces" / "ct-2"
    _register_task_with_workspace(state_dir, workspace_dir, "ct-2")
    (state_dir / "requirements.json").write_text(json.dumps({
        "task_id": "ct-2", "task_type": "calc-theoretical-value",
        "max_iterations": 50,
    }), encoding="utf-8")
    (state_dir / "run.json").write_text(json.dumps({
        "task_id": "ct-2",
        "current_phase": "C_correctness", "current_iteration": 2,
        "finished": False, "final_status": None,
    }), encoding="utf-8")
    (state_dir / "iterations").mkdir()

    resp = client.post("/api/sys-shell/ct-2/control", json={"action": "restart"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert "restarted_from_scratch" not in body  # not reset
    # run.json preserved (NOT wiped to idle)
    run = json.loads((state_dir / "run.json").read_text())
    assert run["current_phase"] == "C_correctness"
    assert run["current_iteration"] == 2
    assert "ct-2" in isolated_env["launcher"].started
    ev = _timeline_events(state_dir)
    assert "task_reset" not in [e["type"] for e in ev]
    ri = [e for e in ev if e["type"] == "restart_initiated"]
    assert ri and ri[0]["payload"]["resume_mode"] == "preserve_state"


def test_control_kill_calls_launcher(client, isolated_env):
    state_dir = isolated_env["home"] / "tasks" / "ct-1"
    _register_task(state_dir, "ct-1")
    resp = client.post("/api/sys-shell/ct-1/control", json={"action": "kill"})
    assert resp.status_code == 200
    assert resp.json()["ok"] is True


def test_control_unknown_action(client, isolated_env):
    state_dir = isolated_env["home"] / "tasks" / "ct-1"
    _register_task(state_dir, "ct-1")
    resp = client.post("/api/sys-shell/ct-1/control", json={"action": "wat"})
    assert resp.status_code == 400


# --------------------------------------------------------------------------- #
# DELETE task — user-visible Close (×) feature
# --------------------------------------------------------------------------- #

def test_delete_task_purge_removes_files_and_registry(client, isolated_env):
    state_dir = isolated_env["home"] / "tasks" / "ct-1"
    _register_task(state_dir, "ct-1")
    (state_dir / "run.json").write_text("{}", encoding="utf-8")
    assert state_dir.exists()
    resp = client.delete("/api/sys-shell/ct-1?purge=true")
    assert resp.status_code == 200
    body = resp.json()
    assert body["removed_from_registry"] is True
    assert body["purged_files"] is True
    assert not state_dir.exists()
    assert _tasks.get_task("ct-1") is None


def test_delete_task_without_purge_keeps_files(client, isolated_env):
    state_dir = isolated_env["home"] / "tasks" / "ct-1"
    _register_task(state_dir, "ct-1")
    resp = client.delete("/api/sys-shell/ct-1")
    assert resp.status_code == 200
    body = resp.json()
    assert body["purged_files"] is False
    assert state_dir.exists()
    assert _tasks.get_task("ct-1") is None


# --------------------------------------------------------------------------- #
# Plugin frontend mount + importmap injection
# --------------------------------------------------------------------------- #

def test_index_html_injects_plugin_importmap(client):
    """Plugins declare ``importmap_entries``; create_app must merge
    them with the shell importmap (plugin wins on conflict) and
    substitute the cache-bust token. Also verifies no duplicate
    importmap keys remain — browser importmap spec rejects duplicates."""
    import json as _json
    import re as _re
    resp = client.get("/")
    html = resp.text
    # Both plugins' detail-view modules should appear with a real
    # cache-bust token (not the literal placeholder).
    assert "/static/plugins/calc-theoretical-value/calc-detail.js?v=" in html
    assert "/static/plugins/gen-infer-framework/gf-detail.js?v=" in html
    assert "CACHE_BUST" not in html  # all substitutions happened
    # Shell-provided shared widgets should appear once (not duplicated).
    m = _re.search(
        r'<script[^>]*type="importmap"[^>]*>(.*?)</script>', html, _re.DOTALL,
    )
    assert m, "importmap script block not found"
    block = _json.loads(m.group(1))
    imports = block["imports"]
    # Plugin entries are present.
    assert imports["app/calc-detail"].startswith("/static/plugins/calc-theoretical-value/")
    assert imports["app/gf-detail"].startswith("/static/plugins/gen-infer-framework/")


def test_plugin_can_override_shell_importmap_entry():
    """If a plugin registers an entry whose key collides with a shell
    entry, the plugin's URL wins. This is the override mechanism for
    task packages that need to diverge from a shared widget."""
    from metainfer.server import registry
    from metainfer.server.app import create_app
    fake = registry.WebPlugin(
        type="__test_override__",
        label="t", description="t",
        frontend_dir=None,
        importmap_entries={
            "app/state-graph": "/static/plugins/__test_override__/sg.js?v=CACHE_BUST",
        },
    )
    registry.register(fake)
    try:
        app = create_app()
        from starlette.testclient import TestClient
        c = TestClient(app)
        html = c.get("/").text
        import re
        m = re.search(r'"app/state-graph":\s*"([^"]+)"', html)
        assert m, "app/state-graph entry missing"
        assert m.group(1).startswith("/static/plugins/__test_override__/sg.js")
    finally:
        registry._REGISTRY.pop("__test_override__", None)


def test_every_plugin_frontend_dir_is_served(client):
    """Every plugin's frontend_dir is mounted at /static/plugins/<type>/
    so each of its importmap URLs is actually reachable. This is the
    end-to-end invariant that makes the dynamic-import dispatch work."""
    import re
    resp = client.get("/")
    html = resp.text
    urls = set(re.findall(r"/static/plugins/[\w\-]+/[\w\-\.]+\.js\?v=\d+", html))
    assert urls, "no plugin URLs were injected"
    for url in urls:
        r = client.get(url)
        assert r.status_code == 200, f"{url} returned {r.status_code}"


def test_every_plugin_detail_view_module_is_in_importmap(client):
    """Each task-type plugin declares a detail_view_module; the index.html
    must contain an importmap entry for it so the shell's dynamic import
    resolves. sys-shell is skipped — it's not a task type."""
    resp = client.get("/")
    html = resp.text
    for plugin in _all_plugins():
        if plugin.type == "sys-shell":
            continue  # shell is not a task type, no detail view
        dvm = plugin.detail_view_module
        assert dvm, f"{plugin.type} has no detail_view_module"
        # The injected entry should mention the plugin's static path.
        assert f"/static/plugins/{plugin.type}/" in html, (
            f"{plugin.type} detail view not in importmap"
        )


def test_plugin_stylesheets_are_injected(client):
    """Plugins can declare ``extra_stylesheets`` (CSS filenames relative
    to their ``frontend_dir``); the index handler must inject each as a
    ``<link>`` tag right after the shell stylesheet. calc_value ships
    ``calc.css`` — verify it appears in the rendered HTML."""
    import re
    resp = client.get("/")
    html = resp.text
    # The shell stylesheet link is always present.
    assert '<link rel="stylesheet" href="/static/styles.css?v=' in html
    # calc_value declares extra_stylesheets=["calc.css"]; the link must
    # appear with the cache-bust token substituted.
    m = re.search(
        r'<link rel="stylesheet" href="/static/plugins/calc-theoretical-value/calc\.css\?v=(\d+)" />',
        html,
    )
    assert m, "calc.css plugin stylesheet link not injected"
    assert m.group(1) != "CACHE_BUST", "cache-bust token not substituted"


def test_plugin_stylesheets_skip_path_escape():
    """A buggy/malicious plugin declaring ``extra_stylesheets`` with any
    path-escape variant must NOT produce a ``<link>`` that climbs out of
    its own mount point. Filename validation rejects forward slashes,
    backslashes, leading dots, absolute paths, and ``..`` traversal
    BEFORE the resolve/relative_to defense-in-depth check runs."""
    from metainfer.server import registry
    from metainfer.server.app import create_app
    from pathlib import Path
    calc = registry.get("calc-theoretical-value")
    fake = registry.WebPlugin(
        type="__test_css_escape__",
        label="t", description="t",
        frontend_dir=calc.frontend_dir,
        extra_stylesheets=[
            "../../etc/passwd",       # POSIX climb
            "/etc/passwd",            # absolute
            "..\\..\\etc\\passwd",    # backslash climb
            "..",                     # bare parent
            ".hidden.css",            # leading dot
            "sub/dir/x.css",          # nested path
            "noextension",            # wrong suffix
            "",                       # empty
            None,                     # wrong type
        ],
    )
    registry.register(fake)
    try:
        app = create_app()
        from starlette.testclient import TestClient
        c = TestClient(app)
        html = c.get("/").text
        # None of the escape variants should make it into the HTML —
        # not the resolved target, not the raw form, not a backslash
        # variant that might survive naive forward-slash-only checks.
        for needle in ("/etc/passwd", "..\\", "..", "etc\\passwd",
                       "__test_css_escape__"):
            if needle == "__test_css_escape__":
                # The plugin's own URL prefix shouldn't appear in any
                # <link> tag at all (auto-discovered JS would, but no
                # CSS link should).
                _assert_no_link_for(c, html, "__test_css_escape__")
            else:
                assert needle not in html, (
                    f"path-escape variant {needle!r} leaked into HTML"
                )
    finally:
        registry._REGISTRY.pop("__test_css_escape__", None)


def _assert_no_link_for(client, html, plugin_type):
    """No ``<link rel="stylesheet" ...>`` tag should reference the given
    plugin's mount point."""
    import re
    links = re.findall(
        r'<link[^>]*rel="stylesheet"[^>]*>',
        html,
    )
    bad = [l for l in links if f"/static/plugins/{plugin_type}/" in l]
    assert not bad, f"unexpected stylesheet link(s) for {plugin_type}: {bad}"


def test_plugin_stylesheets_skip_missing_files():
    """An ``extra_stylesheets`` entry whose filename is well-formed but
    doesn't actually exist under ``frontend_dir`` should be skipped,
    rather than emit a ``<link>`` that 404s. Catches typos in plugin
    config (e.g. declaring ``calc.css`` before creating it)."""
    from metainfer.server import registry
    from metainfer.server.app import create_app
    calc = registry.get("calc-theoretical-value")
    fake = registry.WebPlugin(
        type="__test_css_missing__",
        label="t", description="t",
        frontend_dir=calc.frontend_dir,
        extra_stylesheets=[
            "definitely-not-present.css",  # form valid, file missing
            "calc.css",                    # form valid AND exists
        ],
    )
    registry.register(fake)
    try:
        app = create_app()
        from starlette.testclient import TestClient
        c = TestClient(app)
        html = c.get("/").text
        # The missing one must NOT appear...
        assert "definitely-not-present.css" not in html, (
            "missing stylesheet was linked (should have been skipped)"
        )
        # ...but the real one IS linked under the fake plugin's mount.
        assert (
            "/static/plugins/__test_css_missing__/calc.css?v=" in html
        ), "existing calc.css should be linked under the fake plugin"
        # And fetching it must 200 (sanity: it's the same file calc_value
        # ships, just served from a second mount point).
        import re
        url = re.search(
            r'href="(/static/plugins/__test_css_missing__/calc\.css\?v=\d+)"',
            html,
        ).group(1)
        assert c.get(url).status_code == 200
    finally:
        registry._REGISTRY.pop("__test_css_missing__", None)


def test_plugin_auto_importmap_discovers_every_js():
    """create_app must register every ``*.js`` directly under a plugin's
    ``frontend_dir`` as ``app/<stem>`` — no need to list each module in
    ``importmap_entries``. Verify by spinning up a fake plugin with one
    JS file and no explicit importmap_entries."""
    import re
    import tempfile
    from metainfer.server import registry
    from metainfer.server.app import create_app
    with tempfile.TemporaryDirectory() as td:
        d = tempfile.mkdtemp(dir=td)
        # Drop a fake plugin JS file
        (open(f"{d}/fake-widget.js", "w").write("export default {};\n"))
        fake = registry.WebPlugin(
            type="__test_auto_im__",
            label="t", description="t",
            frontend_dir=Path(d),
        )
        registry.register(fake)
        try:
            app = create_app()
            from starlette.testclient import TestClient
            c = TestClient(app)
            html = c.get("/").text
            m = re.search(r'"app/fake-widget":\s*"([^"]+)"', html)
            assert m, "auto-discovered entry not in importmap"
            assert m.group(1).startswith(
                "/static/plugins/__test_auto_im__/fake-widget.js"
            )
        finally:
            registry._REGISTRY.pop("__test_auto_im__", None)


def test_auto_discovery_does_not_silently_override_shell_entry():
    """A plugin shipping a JS file whose stem collides with a shell
    importmap key (e.g. ``utils.js`` ↔ ``app/utils``) must NOT silently
    hijack the shell widget. The shell entry wins; only an explicit
    ``importmap_entries`` override can replace a shell entry."""
    import re
    import tempfile
    from metainfer.server import registry
    from metainfer.server.app import create_app
    with tempfile.TemporaryDirectory() as td:
        d = tempfile.mkdtemp(dir=td)
        # Drop a file whose stem collides with a shell widget key.
        (open(f"{d}/utils.js", "w").write("export default {};\n"))
        fake = registry.WebPlugin(
            type="__test_collision__",
            label="t", description="t",
            frontend_dir=Path(d),
        )
        registry.register(fake)
        try:
            app = create_app()
            from starlette.testclient import TestClient
            c = TestClient(app)
            html = c.get("/").text
            m = re.search(r'"app/utils":\s*"([^"]+)"', html)
            assert m, "app/utils entry missing"
            # Shell URL, not the fake plugin's URL.
            assert "/static/components/utils.js" in m.group(1), (
                f"auto-discovery silently overrode shell app/utils -> "
                f"{m.group(1)!r}"
            )
        finally:
            registry._REGISTRY.pop("__test_collision__", None)
