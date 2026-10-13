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
# The panel's self-contained leading section: the M-value constants, the model
# workloads, modelCatalog() and the DeepSeek default list. Everything after it
# needs the React runtime, so the harness stops at the default list's closing
# ``);`` rather than pulling in the rest of the file.
MODEL_CATALOG_MARKERS = (
    "var W8A8_M_VALUES",
    'var DEFAULT_W8A8_SHAPES = modelCatalog("DeepSeek V4 Flash")',
)
MODEL_CATALOG_END = "\n);"
# Models whose TP8 catalog carries the M=8 short-decode boundary. DeepSeek V4
# Flash joined them on 2026-10-11 (its DeepSeek TP8 M=8 / M=4096 Triton
# baselines were measured on this air board); the DeepSeek-only *default*
# workload is untouched by that, see test_default_workload_stays_deepseek_only.
M8_MODELS = ("Hy3 (Hunyuan 3)", "MiniMax M3", "GLM5.2", "DeepSeek V4 Flash")
# Models whose TP8 catalog carries the M=4096 large-prefill boundary.
M4096_MODELS = M8_MODELS


def _frontend_catalogs() -> dict[str, object]:
    """The shipped panel catalog: every model's shapes + the default list."""
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is required to evaluate the panel shape catalog")
    text = STATIC_JS.read_text(encoding="utf-8")
    start, default_marker = MODEL_CATALOG_MARKERS
    head = text.index(start)
    tail = text.index(MODEL_CATALOG_END, text.index(default_marker)) + len(
        MODEL_CATALOG_END
    )
    harness = (
        text[head:tail]
        + "\nvar out = {models: {}, default: DEFAULT_W8A8_SHAPES};\n"
        + "Object.keys(MODEL_WORKLOADS).forEach(function (label) {\n"
        + "  out.models[label] = modelCatalog(label);\n"
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
    return _frontend_catalogs()["models"]


@pytest.fixture(scope="module")
def frontend_default() -> list[dict[str, object]]:
    return _frontend_catalogs()["default"]


def test_panel_catalog_exposes_m8_for_model_tp8(catalogs):
    # The M=8 short-decode boundary added on 2026-09-20 must be offered for
    # Hy3 / MiniMax M3 / GLM5.2 TP8 operators (DeepSeek V4 Flash joined on
    # 2026-10-11).
    for model in M8_MODELS:
        tp8 = [s for s in catalogs[model] if s["tp_size"] == 8]
        assert tp8, model
        assert all(s["M"] in (8, 2, 16, 3072, 4096) for s in tp8), model
        assert any(s["M"] == 8 for s in tp8), model
        assert sorted({int(s["M"]) for s in tp8}) == [2, 8, 16, 3072, 4096]


def test_panel_catalog_exposes_m4096_for_model_tp8(catalogs):
    # The M=4096 large-prefill boundary for the TP8 catalogs: added for
    # Hy3 / MiniMax M3 / GLM5.2 on 2026-08-27, DeepSeek V4 Flash on 2026-10-11.
    for model in M4096_MODELS:
        tp8 = [s for s in catalogs[model] if s["tp_size"] == 8]
        m4096 = [s for s in tp8 if s["M"] == 4096]
        assert m4096, model
        # One M=4096 shape per catalog operator.
        assert len(m4096) == len({s["operator"] for s in tp8}), model
        for shape in m4096:
            validate_optimization_shape(shape)
            record = fixed_triton_graph_baseline(str(shape["id"]), shape)
            assert record["timing_scope"] == "prefill_graph_replay", shape
            assert record["profile_mismatch"] is False, (
                f"{model} M=4096 {shape['operator']} resolves from the reference "
                "profile: it has no baseline on this board"
            )


def test_default_workload_stays_deepseek_only_and_unchanged(catalogs):
    """Offering more M values must not move the default workload.

    ``DEFAULT_OPTIMIZATION_SHAPES`` (contract) is the DeepSeek-only default set
    and the serial-validation fallback scope. Widening the *panel* catalog is a
    manual-selection affordance ("Selected shapes only"); the 42-shape default
    and its M=2/16/3072 (= TP4 + 4096) values are pinned separately in
    ``test_contract_snapshot.py``.
    """
    from ..api.int8w8a8gemm.int8_w8a8_gemm_api import (
        DEFAULT_OPTIMIZATION_M_VALUES,
        DEFAULT_OPTIMIZATION_SHAPES,
        TP4_EXTRA_OPTIMIZATION_M_VALUES,
    )

    assert len(DEFAULT_OPTIMIZATION_SHAPES) == 42
    assert DEFAULT_OPTIMIZATION_M_VALUES == (2, 16, 3072)
    assert TP4_EXTRA_OPTIMIZATION_M_VALUES == (4096,)
    # The panel's extra M values stay opt-in: they never enter the default set.
    default_m = {int(shape["M"]) for shape in DEFAULT_OPTIMIZATION_SHAPES}
    assert default_m == {2, 16, 3072, 4096}
    for shape in DEFAULT_OPTIMIZATION_SHAPES:
        assert int(shape["M"]) != 8


def test_frontend_default_catalog_equals_the_contract_default(
    frontend_default,
):
    """The panel's empty-shape-field default == the contract's default set.

    Both lists describe the same workload ("All API shapes" with no explicit
    shape list), so they must agree exactly: same ids, same M/N/K, same
    operators. Adding the DeepSeek TP8 M=8 / M=4096 shapes to the *panel* must
    therefore leave this list untouched.
    """
    from ..api.int8w8a8gemm.int8_w8a8_gemm_api import (
        DEFAULT_OPTIMIZATION_SHAPES,
    )

    def row(shape):
        return (
            str(shape["id"]),
            int(shape["tp_size"]),
            str(shape["operator"]),
            int(shape["M"]),
            int(shape["N"]),
            int(shape["K"]),
        )

    frontend = {row(shape) for shape in frontend_default}
    contract = {row(shape) for shape in DEFAULT_OPTIMIZATION_SHAPES}
    assert frontend == contract, (
        "panel default and contract default disagree: "
        f"only-in-panel={sorted(frontend - contract)}, "
        f"only-in-contract={sorted(contract - frontend)}"
    )


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
            # A decode baseline must come from *this* board: silently resolving
            # the air profile from the liquid reference would compare an air run
            # against a liquid number (1.06x-1.40x apart, operator dependent).
            assert record["profile_mismatch"] is False, (
                f"{model} M=8 {shape['operator']} has no baseline on this "
                f"board (resolved {record['baseline_profile']} instead)"
            )
