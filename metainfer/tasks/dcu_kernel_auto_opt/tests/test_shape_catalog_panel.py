"""Panel <-> contract <-> baseline integration for the model shape catalog.

``static/dkao-shape-input.js`` is what the DKAO "New Task" panel offers the
operator, so it is the source of truth for which shapes a task can submit.
Every shape it can submit must

* satisfy the frozen operator contract (``validate_optimization_shape``), and
* have a fixed Triton Graph baseline (``fixed_triton_graph_baseline``),

otherwise the run dies in the ``baseline`` phase with a ValueError long after
the task was created. These tests read the *real* frontend catalog (by
evaluating its self-contained leading section under node, so the assertions
cannot drift from the shipped UI) and check that the three layers agree.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from ..api.int8w8a8gemm.int8_w8a8_gemm_api import (
    MODEL_TP8_EXTRA_OPTIMIZATION_M_VALUES,
    validate_optimization_shape,
)
from ..orchestrator.w8a8_baselines import fixed_triton_graph_baseline


STATIC_JS = Path(__file__).resolve().parent.parent / "static" / "dkao-shape-input.js"
MODEL_CATALOG_MARKERS = (
    "var W8A8_M_VALUES",
    'var DEFAULT_W8A8_SHAPES = modelCatalog("DeepSeek V4 Flash");',
)
# Models whose TP8 catalog carries the M=8 short-decode boundary.
M8_MODELS = ("Hy3 (Hunyuan 3)", "MiniMax M3", "GLM5.2")


def _frontend_catalogs() -> dict[str, list[dict[str, object]]]:
    """Return {model label: [shape, ...]} from the shipped panel catalog."""
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is required to evaluate the panel shape catalog")
    text = STATIC_JS.read_text(encoding="utf-8")
    start, end = MODEL_CATALOG_MARKERS
    head = text.index(start)
    tail = text.index(end) + len(end)
    harness = (
        text[head:tail]
        + "\nvar out = {};\n"
        + "Object.keys(MODEL_WORKLOADS).forEach(function (label) {\n"
        + "  out[label] = modelCatalog(label);\n"
        + "});\n"
        + "console.log(JSON.stringify(out));\n"
    )
    proc = subprocess.run(
        [node, "-e", harness],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


@pytest.fixture(scope="module")
def catalogs() -> dict[str, list[dict[str, object]]]:
    return _frontend_catalogs()


def test_panel_catalog_exposes_m8_for_model_tp8(catalogs):
    # The M=8 short-decode boundary added on 2026-09-20 must be offered for
    # Hy3 / MiniMax M3 / GLM5.2 TP8 operators.
    for model in M8_MODELS:
        tp8 = [s for s in catalogs[model] if s["tp_size"] == 8]
        assert tp8, model
        assert all(s["M"] in (8, 2, 16, 3072, 4096) for s in tp8), model
        assert any(s["M"] == 8 for s in tp8), model
        assert sorted({int(s["M"]) for s in tp8}) == [2, 8, 16, 3072, 4096]


def test_panel_catalog_keeps_deepseek_tp8_defaults(catalogs):
    # DeepSeek TP8 intentionally keeps the three original M values, so the
    # DeepSeek-only default workload and its validation scope are unchanged.
    tp8 = [s for s in catalogs["DeepSeek V4 Flash"] if s["tp_size"] == 8]
    assert sorted({int(s["M"]) for s in tp8}) == [2, 16, 3072]


def test_panel_m8_shapes_match_the_extra_m_value_contract(catalogs):
    assert 8 in MODEL_TP8_EXTRA_OPTIMIZATION_M_VALUES
    for model in M8_MODELS:
        m8 = [s for s in catalogs[model] if s["tp_size"] == 8 and s["M"] == 8]
        # One M=8 shape per catalog operator.
        assert len(m8) == len(
            {s["operator"] for s in catalogs[model] if s["tp_size"] == 8}
        )
        for shape in m8:
            validate_optimization_shape(shape)


def test_every_panel_tp4_tp8_shape_is_submittable(catalogs):
    # A shape the panel offers must both pass the frozen contract and resolve a
    # fixed baseline; otherwise the task fails in the baseline phase.
    checked = 0
    for model, shapes in catalogs.items():
        for shape in shapes:
            if shape["tp_size"] not in (4, 8):
                continue
            validate_optimization_shape(shape)
            record = fixed_triton_graph_baseline(str(shape["id"]), shape)
            assert record["median_us"] > 0, (model, shape)
            checked += 1
    assert checked >= 70


def test_panel_m8_shapes_resolve_decode_baselines(catalogs):
    for model in M8_MODELS:
        for shape in catalogs[model]:
            if shape["tp_size"] != 8 or shape["M"] != 8:
                continue
            record = fixed_triton_graph_baseline(str(shape["id"]), shape)
            assert record["timing_scope"] == "decode_graph_replay"
            assert record["baseline_kind"] == "triton_graph"
            assert record["case"], shape
