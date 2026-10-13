"""The task page shows, and promotes against, THIS board's variant only.

Two requirements, both reported from the air task ``minimax-tp8-m8-1-1e22df66``:

1. (2026-09-29) the row read ``当前: 液冷 超基线 7.60x`` -- a **liquid**
   measurement shown as an air task's current variant. Those numbers are
   1.06-1.70x apart per operator (air has no HBM address hashing), so this board
   must show only this board's variant, and ``无`` when it has none.
2. (2026-10-06) clicking 加入 variant appeared to do nothing. The route lists
   *both* profiles' records for the same shape -- air first, liquid later -- so
   the page's ``Map(shape -> record)`` kept the **liquid** record, every row
   stayed ``当前: 无``, and the button kept offering 加入 instead of 更新.

And the mechanism has to match the liquid board's: a **faster** candidate
replaces this profile's variant, a **slower** one is not added at all.

The rules live in ``profileVariantIndex`` / ``currentProfileVariant`` in the
shipped browser bundle. The module cannot be imported by pytest (it is an ES
module whose bare specifiers resolve to the shell's vendored bundles), but node
can import it as-is -- so these tests execute the real functions instead of
pattern-matching the source. They skip when no node is available.
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

#: What the reported page had: one shape, a liquid variant, an air machine.
_LIQUID_VARIANT = {
    "shape": "minimax_tp8_qkv_proj_m8",
    "profile": "liquid-k500sm",
    "median_us": 17.08,
    "speedup": 7.6,
}
_AIR_VARIANT = {
    "shape": "minimax_tp8_qkv_proj_m8",
    "profile": "air-k100ai",
    "median_us": 21.5,
    "speedup": 5.788,
}


def _node() -> str:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed: cannot execute the bundle's lookup")
    return node


def _run(tmp_path: Path, cases) -> list:
    """Run the shipped index/lookup code in node, one result per case.

    Each case: ``{"variants": [...] | None, "hwProfileId": str | None,
    "shape": str}``. The result is ``{"kept": [...shapes], "found": {...}|None}``
    -- exactly what the component derives for its buttons and its 当前 column.
    """
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
        const out = {json.dumps(cases)}.map((c) => {{
          const shown = m.displayProfile(c.taskProfile, c.machineProfile);
          const index = m.profileVariantIndex(c.variants, shown);
          const found = m.currentProfileVariant(index, c.shape, shown);
          return {{
            shown: shown,
            promotable: m.canPromote(c.taskProfile, c.machineProfile),
            kept: Array.from(index.keys()),
            found: found
              ? {{ profile: found.profile, median_us: found.median_us,
                   speedup: found.speedup }}
              : null,
          }};
        }});
        process.stdout.write(JSON.stringify(out));
        """), encoding="utf-8")

    proc = subprocess.run(
        [_node(), str(probe)], capture_output=True, text=True, timeout=60,
        cwd=str(tmp_path))
    assert proc.returncode == 0, f"node failed:\n{proc.stderr}"
    return json.loads(proc.stdout)


def test_a_liquid_variant_is_not_current_on_an_air_task(tmp_path):
    """The first reported bug: air task + liquid variant -> nothing shown.

    ``None`` is what the row renders as ``当前: 无``, the pre-split behaviour for
    "this shape has no variant".
    """
    out = _run(tmp_path, [{
        "variants": [_LIQUID_VARIANT],
        "shape": _LIQUID_VARIANT["shape"],
        "taskProfile": "air-k100ai", "machineProfile": "air-k100ai",
    }])
    assert out[0]["found"] is None
    assert out[0]["kept"] == []


def test_this_boards_variant_is_current(tmp_path):
    out = _run(tmp_path, [{
        "variants": [_AIR_VARIANT],
        "shape": _AIR_VARIANT["shape"],
        "taskProfile": "air-k100ai", "machineProfile": "air-k100ai",
    }])
    assert out[0]["found"]["profile"] == "air-k100ai"
    assert out[0]["found"]["speedup"] == 5.788


def test_both_boards_present_keeps_this_boards_record(tmp_path):
    """The second reported bug, exactly as the route orders them.

    ``list_variant_index()`` walks the tree, so for a shared shape the air record
    comes first and the liquid one last: a Map built from the raw list therefore
    ends up holding the *liquid* record, which is why the page still said
    ``当前: 无`` after a successful 加入 (and why the button kept saying 加入).
    """
    out = _run(tmp_path, [{
        "variants": [_AIR_VARIANT, _LIQUID_VARIANT],      # air first, as served
        "shape": _AIR_VARIANT["shape"],
        "taskProfile": "air-k100ai", "machineProfile": "air-k100ai",
    }])
    assert out[0]["kept"] == [_AIR_VARIANT["shape"]]
    assert out[0]["found"]["profile"] == "air-k100ai"
    assert out[0]["found"]["median_us"] == 21.5


def test_a_liquid_task_still_sees_the_liquid_record(tmp_path):
    """The same code must keep the other board working, unchanged."""
    out = _run(tmp_path, [{
        "variants": [_AIR_VARIANT, _LIQUID_VARIANT],
        "shape": _LIQUID_VARIANT["shape"],
        "taskProfile": "liquid-k500sm", "machineProfile": "liquid-k500sm",
    }])
    assert out[0]["found"]["profile"] == "liquid-k500sm"
    assert out[0]["found"]["speedup"] == 7.6


def test_an_unresolved_machine_shows_no_variant(tmp_path):
    """Without a profile nothing is provably comparable (writes are refused too)."""
    out = _run(tmp_path, [{
        "variants": [_AIR_VARIANT], "shape": _AIR_VARIANT["shape"],
        "taskProfile": "", "machineProfile": "",
    }])
    assert out[0]["found"] is None and out[0]["kept"] == []
    assert out[0]["shown"] is None            # nothing to filter by
    assert out[0]["promotable"] is False


def test_missing_index_and_missing_shape_are_safe(tmp_path):
    out = _run(tmp_path, [
        {"variants": None, "shape": "s", "taskProfile": "air-k100ai",
         "machineProfile": "air-k100ai"},
        {"variants": [_AIR_VARIANT], "shape": "not_there",
         "taskProfile": "air-k100ai", "machineProfile": "air-k100ai"},
        {"variants": [{"shape": "s"}], "shape": "s",
         "taskProfile": "air-k100ai", "machineProfile": "air-k100ai"},
    ])
    assert [c["found"] for c in out] == [None, None, None]
    # ``kept`` describes the index itself: no variants -> empty, a record with no
    # profile -> dropped, and an unrelated shape simply does not resolve.
    assert [c["kept"] for c in out] == [
        [], [_AIR_VARIANT["shape"]], [],
    ]


def test_a_liquid_task_shows_the_liquid_library_from_the_air_machine(tmp_path):
    """The reported bug: opening a liquid task on the air machine looked empty.

    The page must list the library of the board the **task** was measured on
    (which is what its medians and speedups belong to), not the board this
    machine happens to be.
    """
    out = _run(tmp_path, [{
        "variants": [_AIR_VARIANT, _LIQUID_VARIANT],
        "shape": _LIQUID_VARIANT["shape"],
        "taskProfile": "liquid-k500sm",      # the task
        "machineProfile": "air-k100ai",      # the machine reading the page
    }])
    assert out[0]["shown"] == "liquid-k500sm"
    assert out[0]["found"]["profile"] == "liquid-k500sm"
    assert out[0]["found"]["speedup"] == 7.6
    # ...but it must not offer to write that task's numbers here.
    assert out[0]["promotable"] is False


def test_writing_is_only_offered_on_the_tasks_own_board(tmp_path):
    out = _run(tmp_path, [
        {"variants": [], "shape": "s", "taskProfile": "air-k100ai",
         "machineProfile": "air-k100ai"},
        {"variants": [], "shape": "s", "taskProfile": "liquid-k500sm",
         "machineProfile": "liquid-k500sm"},
        {"variants": [], "shape": "s", "taskProfile": "liquid-k500sm",
         "machineProfile": "air-k100ai"},
        {"variants": [], "shape": "s", "taskProfile": "",
         "machineProfile": "air-k100ai"},      # unrecorded task
        {"variants": [], "shape": "s", "taskProfile": "air-k100ai",
         "machineProfile": None},              # unresolved machine
    ])
    assert [c["promotable"] for c in out] == [True, True, False, False, False]


def test_an_unrecorded_task_falls_back_to_this_machines_library(tmp_path):
    """A task with no profile record still renders something sensible."""
    out = _run(tmp_path, [{
        "variants": [_AIR_VARIANT], "shape": _AIR_VARIANT["shape"],
        "taskProfile": "", "machineProfile": "air-k100ai",
    }])
    assert out[0]["shown"] == "air-k100ai"
    assert out[0]["found"]["profile"] == "air-k100ai"
    assert out[0]["promotable"] is False       # but the server refuses the write
