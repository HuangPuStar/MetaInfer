"""The DKAO live view shows the round's four questions at once.

A round is four questions on four cards (FLOW.md §1.1), so comparing them is the
point of the live view. It used to render exactly one: four tabs, one DKAO page,
three quarters of the round hidden behind a click.

These are source-level checks, the same way the rest of this plugin's front-end
contracts are pinned (the repo ships no JS test runner): the component must
render every child by default, keep the single view reachable per child, and the
grid must collapse on a narrow screen instead of squeezing four pages.
"""

from __future__ import annotations

from pathlib import Path

HE = Path(__file__).resolve().parents[1]
JS = HE / "static" / "he-detail.js"
CSS = HE / "static" / "he.css"


def _component() -> str:
    src = JS.read_text(encoding="utf-8")
    return src.split("function LiveDkaoMirror(", 1)[1].split(
        "function IterBlock(", 1)[0]


def test_every_child_is_rendered_by_default():
    component = _component()
    assert 'useState("grid")' in component, "four at once is the default"
    assert "ids.map((id) =>" in component, "every question gets a cell"
    assert "he-live-cell" in component
    assert "mirror(id, c)" in component, (
        "each cell renders that question's own DKAO page")
    assert "taskId=${id} stateDir=${c.child_state_dir}" in component, (
        "…pointed at its own state dir, so the four are independent")


def test_the_three_layouts_are_offered():
    component = _component()
    for key in ('"grid"', '"stack"', '"single"'):
        assert key in component, f"missing layout {key}"
    assert "setLayout(key)" in component


def test_the_single_view_is_still_one_click_away_per_child():
    component = _component()
    assert 'setLayout("single")' in component, (
        "drilling into one question must stay possible from the grid")


def test_a_question_without_a_state_dir_is_skipped_not_rendered_empty():
    component = _component()
    assert "if (!c.child_state_dir) return null;" in component


def test_the_grid_is_two_columns_and_collapses_on_narrow_screens():
    css = CSS.read_text(encoding="utf-8")
    block = css.split(".he-live-grid {", 1)[1].split("}", 1)[0]
    assert "repeat(2" in block
    tail = css.split(".he-live-grid {", 1)[1][:600]
    assert "@media" in tail, "narrow screens must fall back to one column"
    assert ".he-live-cell-body" in css and "overflow-x: auto" in css, (
        "a 50%-wide cell must scroll its tables, not clip them")
