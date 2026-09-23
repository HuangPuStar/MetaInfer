"""The four-card overview: what the page shows, and where the numbers come from.

Two halves, and both are pinned because each has been wrong in production:

1. **Membership** — which card a question is shown under. It comes from HE's
   layout record for the round, *not* from the child's last gate row: the
   generate-stage probe may run on any passing device, so three children pinned
   to GPU0/1/2 were all listed under GPU2 and the page showed two cards instead
   of four. (``tests/test_gpu_cards.py`` pins the precedence in detail; here the
   payload contract the view reads is pinned.)
2. **Content** — the view reads only fields the endpoint really provides, and it
   is wired into the detail page (a component nobody renders is not a feature).
"""

from __future__ import annotations

import json
from pathlib import Path

from metainfer.tasks.harness_evolve.server.routes import _gpu_cards

HE = Path(__file__).resolve().parents[1]
JS = HE / "static" / "he-detail.js"
CSS = HE / "static" / "he.css"


def _seed(exp: Path, num: int, qid: str, *, layout_gpu: int, phase: str = "parallel_explore") -> None:
    attempt = exp / "children" / f"iteration_{num:03d}" / qid
    state = attempt / "state"
    state.mkdir(parents=True, exist_ok=True)
    (state / "run.json").write_text(json.dumps({
        "task_id": qid, "task_type": "dcu-kernel-auto-opt",
        "current_phase": phase, "current_iteration": 2,
        "finished": False, "last_update": 1790066400.0,
    }), encoding="utf-8")
    (attempt / "requirements.json").write_text(json.dumps({
        "task_id": qid,
        "shape_config": ("model: m\nassignment_mode: manual\nshapes:\n- id: " + qid
                         + "\nassignments:\n  worker_0:\n    gpu: " + str(layout_gpu)
                         + "\n    shapes:\n    - " + qid + "\n"),
    }), encoding="utf-8")


def _layout(exp: Path, num: int, mapping: dict) -> None:
    bench = exp / "runs" / f"iteration_{num:03d}" / "input" / "benchmark"
    bench.mkdir(parents=True, exist_ok=True)
    (bench / "gpu_preflight.json").write_text(json.dumps({
        "iteration": num, "gpu_count": 4, "managed_by": "dcu_kernel_auto_opt",
        "devices": mapping,
    }), encoding="utf-8")


def test_a_four_question_round_becomes_four_cards(tmp_path):
    exp = tmp_path / "exp"
    questions = {"q0": 0, "q1": 1, "q2": 2, "q3": 3}
    _layout(exp, 1, questions)
    for qid, gpu in questions.items():
        _seed(exp, 1, qid, layout_gpu=gpu)

    cards = _gpu_cards(exp, 1)

    assert [c["gpu"] for c in cards] == [0, 1, 2, 3], (
        "one card per question — the view must be able to show all four")
    for card in cards:
        assert len(card["questions"]) == 1
        q = card["questions"][0]
        # every field the overview renders
        assert {"gpu", "question", "current_phase", "current_iteration",
                "best_median_us", "rounds", "finished", "last_update",
                "gate", "gate_audit", "gpu_source"} <= set(q)
        assert q["gpu_source"] == "layout"
        assert q["gate_audit"].get("devices") is not None


def test_a_grouped_card_still_carries_every_question(tmp_path):
    """Two questions on one card (a second wave) must both be listed."""
    exp = tmp_path / "exp"
    _layout(exp, 2, {"q0": 0, "q1": 0})
    _seed(exp, 2, "q0", layout_gpu=0)
    _seed(exp, 2, "q1", layout_gpu=0)

    cards = _gpu_cards(exp, 2)

    assert len(cards) == 1 and cards[0]["gpu"] == 0
    assert [q["question"] for q in cards[0]["questions"]] == ["q0", "q1"]


# --------------------------------------------------------------- the view side

def test_the_four_card_component_exists_and_is_rendered():
    src = JS.read_text(encoding="utf-8")
    assert "function FourCardOverview(" in src
    assert "<${FourCardOverview} data=${iterGpu}" in src, (
        "the overview must be rendered with the round's card payload")
    assert 'class="he-four-cards"' in src


def test_the_view_reads_only_fields_the_endpoint_provides():
    src = JS.read_text(encoding="utf-8")
    component = src.split("function FourCardOverview(", 1)[1].split(
        "function PromotionPanel(", 1)[0]
    for field in ("current_phase", "current_iteration", "best_median_us",
                  "rounds", "finished", "last_update", "gate_audit",
                  "gpu_source", "question"):
        assert field in component, f"the card cell should show {field}"
    # and it must not invent a metric the backend never sends
    assert "p90_us" not in component


def test_the_grid_is_four_columns_with_a_narrow_screen_fallback():
    css = CSS.read_text(encoding="utf-8")
    block = css.split(".he-four-cards {", 1)[1].split("}", 1)[0]
    assert "repeat(4" in block, "four cards side by side"
    assert "@media" in css.split(".he-four-cards {", 1)[1][:400], (
        "narrow screens fall back to two columns")


def test_the_overview_click_opens_the_child_drilldown():
    src = JS.read_text(encoding="utf-8")
    component = src.split("function FourCardOverview(", 1)[1].split(
        "function PromotionPanel(", 1)[0]
    assert "onSelect(q.question)" in component
    assert "onSelect=${(id) => setSelChild(id)}" in src
