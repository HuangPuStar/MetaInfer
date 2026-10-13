"""The skill panel offers writes only on the task's own board.

Companion to ``test_skill_write_profile_gate.py``: that file pins the server
half (409 + the reason in ``GET /skills``), this one pins the visible half so the
operator is never offered a button that fails.

The rule: fusion and publishing write into the skill library of **this machine's**
profile (``~/.dsh/skills``), while the pending skill's numbers came from the
task's board -- and on this machine 47 of 48 tasks are recorded
``liquid-k500sm``, so an air page showing liquid tasks is the normal case.

Like ``test_variant_panel_profile_filter.py`` this executes the *shipped*
function through node instead of pattern-matching the source: the module's bare
specifiers resolve to the shell's vendored bundles, so node can import it as-is.
It skips when node is unavailable.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import textwrap
from pathlib import Path

import pytest

_TASK_DIR = Path(__file__).resolve().parent.parent
_STATIC = _TASK_DIR / "static" / "dkao-detail.js"
_SHELL = _TASK_DIR.parent / "sys_shell" / "static"
_VENDOR = _SHELL / "vendor"

AIR = "air-k100ai"
LIQUID = "liquid-k500sm"


def _node() -> str:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed: cannot execute the shipped gate")
    return node


def _decide(tmp_path: Path, cases) -> list:
    """Run the shipped gate in node; one ``{allowed, blocked}`` per case."""
    loader = tmp_path / "loader.mjs"
    loader.write_text(textwrap.dedent(f"""
        const MAP = {{
          "preact": {json.dumps((_VENDOR / "preact.js").as_uri())},
          "preact/hooks": {json.dumps((_VENDOR / "preact-hooks.js").as_uri())},
          "preact/jsx-runtime": {json.dumps((_VENDOR / "preact.js").as_uri())},
          "htm": {json.dumps((_VENDOR / "htm-core.js").as_uri())},
          "htm/preact": {json.dumps((_VENDOR / "htm.js").as_uri())},
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
        const out = {json.dumps(cases)}.map((c) => ({{
          allowed: m.canWriteSkills(c.taskProfile, c.machineProfile),
        }}));
        process.stdout.write(JSON.stringify(out));
        """), encoding="utf-8")

    proc = subprocess.run(
        [_node(), str(probe)], capture_output=True, text=True, timeout=60,
        cwd=str(tmp_path))
    assert proc.returncode == 0, f"node failed:\n{proc.stderr}"
    return json.loads(proc.stdout)


def test_a_liquid_tasks_page_cannot_write_on_the_air_machine(tmp_path):
    """The reported case: opening a liquid task on the air board.

    47 of 48 registered tasks here are recorded ``liquid-k500sm``; offering 融合
    on them would fold liquid findings into the air edition.
    """
    out = _decide(tmp_path, [
        {"taskProfile": LIQUID, "machineProfile": AIR},
        {"taskProfile": AIR, "machineProfile": LIQUID},
    ])
    assert [item["allowed"] for item in out] == [False, False]


def test_the_tasks_own_board_may_write(tmp_path):
    out = _decide(tmp_path, [
        {"taskProfile": AIR, "machineProfile": AIR},
        {"taskProfile": LIQUID, "machineProfile": LIQUID},
    ])
    assert [item["allowed"] for item in out] == [True, True]


def test_an_unrecorded_task_cannot_write(tmp_path):
    """No record -> unknown whose numbers these are: the server 409s, so hide it."""
    out = _decide(tmp_path, [{"taskProfile": "", "machineProfile": AIR}])
    assert out[0]["allowed"] is False


def test_an_unresolved_machine_cannot_write(tmp_path):
    """An unresolvable board has no edition to file findings under."""
    out = _decide(tmp_path, [{"taskProfile": AIR, "machineProfile": ""}])
    assert out[0]["allowed"] is False


def test_the_panel_gates_every_write_control_on_that_gate():
    """Source guard for the wiring the executed function cannot see.

    ``canWriteSkills`` says *whether* a write is offered; this pins that the
    component actually consults it for both controls, and that the server's own
    ``write_blocked_reason`` outranks the comparison (belt and braces).
    """
    src = _STATIC.read_text(encoding="utf-8")
    start = src.index("function SkillLibrary(")
    end = src.index("export default function DcuKernelAutoOptDetail", start)
    panel = src[start:end]
    assert "canWriteSkills(taskProfile, machineProfile)" in panel, (
        "the panel no longer asks the gate"
    )
    assert "write_blocked_reason" in panel, (
        "the panel ignores the server's verdict"
    )
    assert "canPublish=${canWrite}" in panel and "canFuse=${canWrite}" in panel, (
        "a write control is not gated on canWrite"
    )
    assert "!ctx.readOnly" in panel, "the read-only mirror must stay closed"


def test_the_entry_button_and_the_panel_are_still_wired():
    """The regression from 2026-10-07: the panel must be reachable and render.

    ``SkillLibrary`` referenced a bare ``readOnly``, so clicking "View skill
    library" threw ``ReferenceError`` at render time and the panel never
    appeared (see ``test_static_readonly_scope.py`` for the scope guard).
    """
    src = _STATIC.read_text(encoding="utf-8")
    assert "View skill library" in src
    assert "${showSkills ? html`" in src
