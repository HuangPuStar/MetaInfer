"""What the round table's gate column shows, and where those numbers come from.

The page used to print ``tau_family * baseline_us`` — the *pool* criterion — under
the header "pass gate ≤ us". On the variant-round protocol (FLOW.md §3, the fixed
protocol for every HE task since 2026-09-15) that number is not the gate: a round
is judged by pairing each question against that operator's current **variant**,
needing a strict win for >= 75% of the questions with nothing below 80% of its
variant. Showing the pool criterion there made a 20.00x requirement look like the
bar while the real bar was ~163x, i.e. it hid the very thing the round is judged
on — and on an old run it read as if a kernel 2-4x slower than the variant had
passed a variant comparison.

Two halves, both pinned because each can be wrong independently:

* the endpoint must serve the round's real criterion (``_real_gate_map``, driven
  end to end through ``_children_live``);
* the view must read it, keep the pool criterion only as a labelled annotation,
  and still render the legacy path — which really *was* judged by that number.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

from metainfer.tasks.harness_evolve.server.routes import (
    _children_live,
    _iterations,
)

HE = Path(__file__).resolve().parents[1]
JS = HE / "static" / "he-detail.js"

#: One pool instance whose *pool* criterion (tau * baseline = 0.5 * 1000) is far
#: from its variant (200): the two can never be confused in an assertion.
POOL_BASELINE_US = 1000.0
POOL_VARIANT_US = 200.0
POOL_TARGET_US = 500.0


def _pool_file(tmp_path: Path) -> Path:
    path = tmp_path / "registered_pool.yaml"
    path.write_text(yaml.safe_dump({
        "schema_version": 1,
        "instances": [{
            "id": "q0",
            "contract": {"model": "m", "tp_size": 8, "operator": "o_proj",
                         "M": 4096, "N": 64, "K": 32},
            "family": "prefill__fam",
            "baseline_us": POOL_BASELINE_US,
            "best_known_us": POOL_VARIANT_US,
            # One accepted record with ratio 0.5 pins tau_family at 0.5.
            "history": [{"accepted": True, "median_us": POOL_TARGET_US}],
        }],
    }), encoding="utf-8")
    return path


def _child(exp: Path, num: int, qid: str = "q0") -> None:
    """A finished-looking DKAO child with one accepted measurement."""
    d = exp / "children" / f"iteration_{num:03d}" / qid
    (d / "state").mkdir(parents=True, exist_ok=True)
    (d / "state" / "run.json").write_text(json.dumps({
        "task_id": qid, "task_type": "dcu-kernel-auto-opt",
        "current_phase": "finished", "current_iteration": 3,
        "finished": True, "final_status": "success",
    }), encoding="utf-8")
    run = d / "workspace" / "workers" / "worker_0" / "runs" / qid
    run.mkdir(parents=True, exist_ok=True)
    (run / "experiments.jsonl").write_text(json.dumps({
        "iteration": 1, "accepted": True, "metrics": {"median_us": 150.0},
    }) + "\n", encoding="utf-8")


def _variant_table(exp: Path, median_us: float = POOL_VARIANT_US,
                   kernel_source: str = "pool:best_known") -> None:
    (exp / "variant_table.json").write_text(json.dumps({
        "schema_version": 1, "operators": {
            "q0": {"median_us": median_us, "kernel_source": kernel_source,
                   "conditions": {"origin": "registered_pool"}},
        }, "groups": {},
    }), encoding="utf-8")


def _round(exp: Path, num: int, stage: str | None, *,
           gate: dict | None = None, gate_name: str = "performance_gate.json",
           ) -> None:
    i_dir = exp / "runs" / f"iteration_{num:03d}" / "input"
    (i_dir / "benchmark").mkdir(parents=True, exist_ok=True)
    if stage is not None:
        (i_dir / "stage.json").write_text(json.dumps({
            "iteration": num, "stage": stage, "round_cost": 1.0,
        }), encoding="utf-8")
    if gate is not None:
        (i_dir / gate_name).write_text(json.dumps(gate), encoding="utf-8")


def _gate_doc(status: str = "PASS", verdict: str = "WIN",
              delta: float = 12.5) -> dict:
    return {
        "kind": "performance", "status": status, "win_ratio": 1.0,
        "required_win_ratio": 0.75, "operators": ["q0"], "wins": ["q0"],
        "losses": [], "ties": [], "counted": 1, "wins_needed": 1,
        "unmeasured": [], "below_floor": [], "reasons": [],
        "comparison": {"per_instance": {"q0": {
            "champion_median_us": POOL_VARIANT_US,
            "candidate_median_us": 175.0,
            "delta_percent": delta,
            "verdict": verdict,
        }}},
    }


def _answers(pool: Path) -> dict:
    return {"pool_source": str(pool)}


# ----------------------------------------------------------- what the gate is


def test_a_performance_round_is_judged_against_the_variant(tmp_path):
    exp = tmp_path / "exp"
    pool = _pool_file(tmp_path)
    _child(exp, 2)
    _variant_table(exp)
    _round(exp, 2, "performance", gate=_gate_doc())

    gate = _children_live(exp, 2, _answers(pool))["q0"]["gate"]

    assert gate["protocol"] == "variant"
    assert gate["stage"] == "performance"
    # the number the question must beat is the variant, not tau * baseline
    assert gate["variant_us"] == POOL_VARIANT_US
    assert gate["target_us"] == POOL_VARIANT_US
    assert gate["judged"]["verdict"] == "WIN"
    assert gate["judged"]["delta_percent"] == 12.5
    assert gate["win_ratio"] == 0.75
    assert gate["floor_percent"] == 0.80
    assert gate["noise_percent"] == 2.0


def test_the_pool_criterion_is_served_separately_and_labelled(tmp_path):
    """It must still be reachable (old runs used it) — but never as the gate."""
    exp = tmp_path / "exp"
    pool = _pool_file(tmp_path)
    _child(exp, 2)
    _variant_table(exp)
    _round(exp, 2, "performance", gate=_gate_doc())

    live = _children_live(exp, 2, _answers(pool))["q0"]

    assert live["gate"]["target_us"] != live["pool_reference"]["target_us"], (
        "the two criteria must not collapse into one number")
    assert live["pool_reference"]["target_us"] == POOL_TARGET_US
    assert live["pool_reference"]["tau_family"] == 0.5
    assert live["pool_reference"]["baseline_us"] == POOL_BASELINE_US
    assert live["gate_protocol"] == "variant"


def test_the_baseline_round_has_an_opponent_but_no_verdict(tmp_path):
    """Round 1 judges nothing (FLOW.md §2) — but it does fix the opponent."""
    exp = tmp_path / "exp"
    pool = _pool_file(tmp_path)
    _child(exp, 1)
    _variant_table(exp)
    _round(exp, 1, "baseline")

    gate = _children_live(exp, 1, _answers(pool))["q0"]["gate"]

    assert gate["protocol"] == "variant"
    assert gate["stage"] == "baseline"
    assert gate["judged"] is None
    assert gate["target_us"] == POOL_VARIANT_US


def test_a_legacy_round_keeps_the_criterion_it_was_judged_by(tmp_path):
    """No stage, no gate document, no variant table: the pre-2026-09-15 path.

    Those rounds were decided by pool.auto_pass, so that is the target their page
    must keep showing — labelled as legacy, not as a variant comparison.
    """
    exp = tmp_path / "exp"
    pool = _pool_file(tmp_path)
    _child(exp, 3)
    _round(exp, 3, None)

    live = _children_live(exp, 3, _answers(pool))["q0"]

    assert live["gate"]["protocol"] == "legacy"
    assert live["gate"]["judged"] is None
    assert live["gate"]["target_us"] == POOL_TARGET_US
    assert live["pool_reference"]["target_us"] == POOL_TARGET_US


def test_the_round_payload_carries_its_stage_and_gate(tmp_path):
    """The page renders the round's own gate document, so serve it per round."""
    exp = tmp_path / "exp"
    _child(exp, 2)
    _round(exp, 2, "performance", gate=_gate_doc(status="FAIL",
                                                 verdict="LOSS", delta=-18.0))

    entry = _iterations(exp)[0]

    assert entry["stage"]["stage"] == "performance"
    assert entry["performance_gate"]["status"] == "FAIL"
    assert entry["performance_gate"]["wins_needed"] == 1


def test_a_gate_round_without_a_stage_document_is_still_read(tmp_path):
    """The 2026-09-18 transitional build wrote the gate but no stage.json."""
    exp = tmp_path / "exp"
    pool = _pool_file(tmp_path)
    _child(exp, 1)
    _round(exp, 1, None, gate=_gate_doc())

    gate = _children_live(exp, 1, _answers(pool))["q0"]["gate"]

    assert gate["protocol"] == "variant"
    assert gate["judged"]["verdict"] == "WIN"


# --------------------------------------------------------------- the view side


def _js() -> str:
    return JS.read_text(encoding="utf-8")


def _component(name: str, end: str = "\nfunction ") -> str:
    src = _js()
    assert f"function {name}(" in src, f"{name} is gone"
    return src.split(f"function {name}(", 1)[1].split(end, 1)[0]


def test_the_gate_column_no_longer_advertises_the_pool_criterion():
    src = _js()
    assert "pass gate ≤ us" not in src, (
        "the column must not be titled like a gate it does not show")
    assert "必须打败（variant）" in src, "the column must name the real opponent"
    component = _component("QuestionGateCell")
    assert "gate.variant_us" in component, (
        "the cell must render the variant, not a family baseline")
    assert "gate.judged" in component, (
        "a judged round must show WIN/LOSS, not just a number")


def test_the_pool_number_is_only_an_explicitly_labelled_annotation():
    component = _component("QuestionGateCell")
    assert "poolRef" in component, (
        "the pool criterion must arrive as its own argument")
    assert "本协议不判门" in component, (
        "showing tau * baseline without saying it is not the gate is the bug")
    # `≥N× baseline` may only survive inside the legacy branch.
    if "× baseline" in component:
        legacy = component.split('gate.protocol === "legacy"', 1)[1]
        assert "baseline_us / poolRef.target_us" in legacy, (
            "the × baseline phrasing belongs to the legacy criterion only")


def test_the_view_keeps_the_legacy_path_readable():
    component = _component("QuestionGateCell")
    assert 'gate.protocol === "legacy"' in component, (
        "legacy rounds were judged by the family criterion; say so")
    src = _js()
    assert "legacy 判据" in src


def test_the_round_shows_which_gate_it_owed_and_what_it_concluded():
    src = _js()
    assert "function RoundGateLine(" in src
    assert "<${RoundGateLine} iter=${selIterObj} />" in src, (
        "the round's gate line must be rendered with the round on screen")
    line = _component("RoundGateLine")
    for field in ("performance_gate", "generalization_gate", "wins_needed",
                  "below_floor"):
        assert field in line, f"the gate line should show {field}"


def test_the_child_result_column_is_not_presented_as_the_gate():
    src = _js()
    assert "子任务验收" in src, (
        "the r.passed column is DKAO's own acceptance, not the performance gate")
    assert "DKAO 子任务自己的验收" in src


def test_the_four_card_target_is_the_rounds_real_bar():
    """The cards read the same `target_us`; it must be the variant on-protocol."""
    component = _component("FourCardOverview", "\nfunction PromotionPanel(")
    assert "必须打败 ≤" in component
    assert "target = g.target_us" in component


#: The repo ships no JS test runner (see tests/test_live_dkao_mirror.py), so the
#: module is only *parsed*, not executed: a syntax error in a file with no build
#: step would otherwise surface as a blank page and nothing else.
@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_the_detail_module_parses(tmp_path):
    copy = tmp_path / "he-detail.mjs"
    copy.write_text(_js(), encoding="utf-8")
    proc = subprocess.run(["node", "--check", str(copy)],
                          capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr


# ------------------------------------------------- the cell, actually executed

#: Parsing is not rendering: reading ``g.baseline_us`` off the wrong object
#: renders "-" instead of raising, which is how the pool criterion came to be
#: shown as the gate in the first place. So the cell is also executed — with the
#: repo's own vendored htm/preact (no browser, no bundler, no network): the vnode
#: tree htm returns is plain data and can be walked for its text.
VENDOR = HE.parent / "sys_shell" / "static" / "vendor"

_RENDER_DRIVER = """
import { QuestionGateCell } from "./he-detail.mjs";
function text(v, out = []) {
  if (v == null || v === false || v === true) return out;
  if (typeof v === "string" || typeof v === "number") { out.push(String(v)); return out; }
  if (Array.isArray(v)) { for (const x of v) text(x, out); return out; }
  if (typeof v === "object") {
    const p = v.props || {};
    if (typeof v.type === "function") return text(v.type(p), out);
    if (p.children != null) text(p.children, out);
  }
  return out;
}
const poolRef = { baseline_us: 1000.0, tau_family: 0.5, target_us: 500.0 };
const base = { variant_source: "variant", kernel_source: "pool:best_known",
               target_us: 200.0, variant_us: 200.0, win_ratio: 0.75,
               floor_percent: 0.8, noise_percent: 2.0 };
const cases = {
  baseline: { ...base, protocol: "variant", stage: "baseline", judged: null },
  judged: { ...base, protocol: "variant", stage: "performance",
            judged: { verdict: "WIN", candidate_median_us: 175.0, delta_percent: 12.5 } },
  tie: { ...base, protocol: "variant", stage: "performance",
         judged: { verdict: "NO_SIGNAL", candidate_median_us: 200.0, delta_percent: 0.0 } },
  legacy: { ...base, protocol: "legacy", stage: null, judged: null,
            target_us: 500.0 },
};
const out = {};
for (const [k, gate] of Object.entries(cases)) {
  out[k] = text(QuestionGateCell({ gate, poolRef })).join(" ").replace(/\\s+/g, " ").trim();
}
out.none = text(QuestionGateCell({ gate: null, poolRef: null })).join(" ").trim();
console.log(JSON.stringify(out));
"""


def _imported_names(src: str) -> set:
    """Every named import he-detail.js takes from the app/* modules.

    Derived from the source so the stub cannot rot: adding an import to the view
    must not turn a render check into an unrelated failure.
    """
    names = set()
    for match in re.finditer(r'import\s*\{([^}]*)\}\s*from\s*"(app/[^"]+)"', src):
        for part in match.group(1).split(","):
            name = part.strip().split(" as ")[0].strip()
            if name:
                names.add(name)
    assert names, "he-detail.js imports nothing from app/*? update this test"
    return names


def _render_gate_cell(tmp_path: Path) -> dict:
    """Render ``QuestionGateCell`` in node against the vendored htm/preact."""
    if not VENDOR.is_dir():
        pytest.skip("vendored htm/preact is missing")
    work = tmp_path / "render"
    work.mkdir()
    # The vendor bundles import each other by bare specifier (the browser reads
    # them through the shell importmap); a flat dir with relative specifiers is
    # the node equivalent.
    for name in ("htm.js", "htm-core.js", "preact.js", "preact-hooks.js"):
        src = (VENDOR / name).read_text(encoding="utf-8")
        src = src.replace('from"preact"', 'from"./preact.js"')
        src = src.replace('from"htm"', 'from"./htm-core.js"')
        (work / name).write_text(src, encoding="utf-8")
    (work / "stub.js").write_text(
        "const noop = async () => ({});\n"
        + "\n".join(f"export const {n} = noop;"
                    for n in sorted(_imported_names(_js())))
        + "\nexport default function Stub() { return null; }\n",
        encoding="utf-8")
    src = _js()
    for spec in ("app/he-api", "app/utils", "app/dkao-detail",
                 "htm/preact", "preact/hooks"):
        assert f'from "{spec}"' in src, f"{spec} import moved; update this test"
    src = src.replace('from "app/he-api"', 'from "./stub.js"')
    src = src.replace('from "app/utils"', 'from "./stub.js"')
    src = src.replace('from "app/dkao-detail"', 'from "./stub.js"')
    src = src.replace('from "htm/preact"', 'from "./htm.js"')
    src = src.replace('from "preact/hooks"', 'from "./preact-hooks.js"')
    src += "\nexport { QuestionGateCell };\n"
    (work / "he-detail.mjs").write_text(src, encoding="utf-8")
    (work / "driver.mjs").write_text(_RENDER_DRIVER, encoding="utf-8")
    proc = subprocess.run(["node", str(work / "driver.mjs")],
                          capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_the_cell_renders_the_variant_and_labels_the_pool_number(tmp_path):
    rendered = _render_gate_cell(tmp_path)

    # The opponent is the variant; the pool number is never bare.
    assert "≤ 200.00 µs" in rendered["baseline"]
    assert "variant" in rendered["baseline"]
    assert "第 1 轮不判门" in rendered["baseline"]
    assert "500.00 µs" in rendered["baseline"], (
        "the pool criterion should still be visible — as an annotation")
    assert "本协议不判门" in rendered["baseline"]


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_the_cell_renders_the_verdict_and_stays_empty_without_data(tmp_path):
    rendered = _render_gate_cell(tmp_path)

    assert "赢" in rendered["judged"] and "12.50" in rendered["judged"]
    assert "平·不算赢" in rendered["tie"], "a tie is not a win for this gate"
    assert rendered["none"] == "-", "no gate data must not invent a number"
    # The legacy path keeps the number that judged it, and says so.
    assert "legacy 判据" in rendered["legacy"]
    assert "≥2.00× baseline" in rendered["legacy"]
