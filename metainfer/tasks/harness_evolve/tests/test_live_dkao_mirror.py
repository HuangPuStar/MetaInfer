"""The AHE page embeds the DKAO task view inside each iteration.

The two halves of that feature live in different plugins, so nothing about it
is checked by either plugin's own tests:

  * the AHE detail module imports ``app/dkao-detail`` (the *other* plugin's
    bundle), which only works if the importmap carries that key -- the JS
    itself cannot be executed here (no build step, no browser), so the wiring
    is asserted where it is decidable: the module the server actually serves,
    the importmap it is served with, and the bundle's own embed interface;
  * the embedded view is addressed by the child's artifact directory, because
    HE children are spawned by the orchestrator and are not tasks.

Deliberately narrow: this does not try to be a JS test suite.
"""

from __future__ import annotations

import json
import re

HE_DETAIL = ("metainfer/tasks/harness_evolve/static/he-detail.js")
DKAO_DETAIL = "metainfer/tasks/dcu_kernel_auto_opt/static/dkao-detail.js"


def _source(rel: str) -> str:
    from pathlib import Path
    return (Path(__file__).resolve().parents[4] / rel).read_text(encoding="utf-8")


def _importmap(client) -> dict:
    resp = client.get("/")
    assert resp.status_code == 200
    block = re.search(
        r'<script[^>]*type="importmap"[^>]*>(.*?)</script>', resp.text,
        re.DOTALL)
    assert block, "the shell no longer ships an importmap"
    return json.loads(block.group(1)).get("imports", {})


def test_the_ahe_page_resolves_the_dkao_view_it_imports(client):
    """`app/dkao-detail` must exist, or the AHE page dies on import."""
    imports = _importmap(client)
    assert "app/dkao-detail" in imports, sorted(imports)
    url = imports["app/dkao-detail"]
    assert url.startswith("/static/plugins/dcu-kernel-auto-opt/")
    assert "CACHE_BUST" not in url            # substituted, not leaked
    asset = client.get(url.split("?")[0])
    assert asset.status_code == 200, url
    assert "DcuKernelAutoOptDetail" in asset.text


def test_he_detail_actually_imports_and_mounts_the_dkao_view():
    src = _source(HE_DETAIL)
    assert re.search(
        r'import\s+DcuKernelAutoOptDetail\s+from\s+"app/dkao-detail"', src), \
        "he-detail.js no longer imports the DKAO view"
    mount = re.search(r"<\$\{DcuKernelAutoOptDetail\}([^/]*)/>", src)
    assert mount, "he-detail.js never renders the DKAO view"
    # A mirrored child is read-only and located by its artifact directory;
    # without these the embedded calls would 404 or offer write controls.
    assert "stateDir=" in mount.group(1)
    assert "readOnly=${true}" in mount.group(1)


def test_the_dkao_view_supports_the_embed_contract():
    """The other side of the same contract, in the DKAO bundle."""
    src = _source(DKAO_DETAIL)
    assert "export function apiBase(" in src, \
        "dkao-detail.js no longer exports the embed URL builder"
    assert "state_dir=" in src, "apiBase no longer passes state_dir"
    assert "readOnly" in src, "dkao-detail.js dropped its read-only mode"
    # The write controls must be gated on it, not merely styled.
    for control in ("onClick=${() => addVariant(shape)}",
                    "onClick=${renameRepo}",
                    "onClick=${syncNow}"):
        idx = src.index(control)
        window = src[max(0, idx - 900):idx]
        assert "readOnly" in window, f"{control} is not gated by readOnly"


def test_the_iteration_block_hands_the_task_down_to_the_mirror():
    """Without taskId the mirror cannot fetch the iteration's children."""
    src = _source(HE_DETAIL)
    assert re.search(r"<\$\{IterBlock\}\s+iter=\$\{it\}\s+taskId=\$\{taskId\}", src), \
        "IterBlock is rendered without taskId"
    assert re.search(r"<\$\{LiveDkaoMirror\}\s+taskId=\$\{taskId\}", src), \
        "IterBlock does not mount the live DKAO mirror"


def test_the_mirror_follows_a_running_question_by_default():
    src = _source(HE_DETAIL)
    body = src[src.index("function LiveDkaoMirror("):]
    body = body[:body.index("\nfunction IterBlock(")]
    assert "!children[id].finished" in body, \
        "the switcher no longer auto-selects the running question"
    assert "getChildren(taskId, num)" in body, \
        "the mirror no longer reads the iteration's children"


# ------------------------------------------------------------------ stop button


def test_the_stop_button_is_wired_to_a_running_task():
    """Stop must be reachable, and only while there is something to stop."""
    src = _source(HE_DETAIL)
    # `status` is the shell's liveness view; without it in the props the
    # button silently never renders (it is passed, but must be destructured).
    assert re.search(r"export default function HeDetailView\(\{[^}]*\bstatus\b",
                     src), "HeDetailView does not accept the shell's status prop"
    assert re.search(r"import\s*\{[^}]*stopExperiment[^}]*\}\s*from\s*\"app/he-api\"",
                     src), "he-detail.js does not import stopExperiment"
    assert "stopExperiment(taskId)" in src, "the button calls nothing"
    # Offered exactly when the orchestrator is alive, not when it merely has
    # artifacts on disk (a stopped run keeps its current_phase).
    assert "status && status.running" in src, \
        "the Stop button is not gated on the orchestrator being alive"


def test_the_stop_api_posts_to_the_stop_route():
    src = _source("metainfer/tasks/harness_evolve/static/he-api.js")
    body = src[src.index("export async function stopExperiment"):]
    body = body[:body.index("\n}")]
    assert "${TASK_BASE(taskId)}/stop" in body
    assert 'method: "POST"' in body
