from __future__ import annotations

from pathlib import Path

import pytest

from ..orchestrator import variant_store as vs
from metainfer.orchestrator import hw_profile
from ..orchestrator.variant_store import (
    derive_variant_meta,
    dtype_slug,
    model_slug,
    operator_type_slug,
    parse_shape_meta,
)


@pytest.fixture
def pinned_profile(monkeypatch):
    """Pin the detected hardware profile so paths do not depend on the host.

    Variant leaves live under the profile of the machine that measured them, so
    an unpinned test would assert different paths here (kme6 = air) and on a
    GPU-less CI host (unresolved = ``unmigrated``).
    """
    monkeypatch.setenv("METAINFER_HW_PROFILE", "air-k100ai")
    hw_profile.clear_cache()
    yield "air-k100ai"
    hw_profile.clear_cache()


def _answers():
    return {"operator": "Quantized GEMM", "dtype": "INT8 W8A8",
            "model": "Hy3 (Hunyuan 3)"}


def test_slugs():
    assert operator_type_slug("Quantized GEMM") == "gemm"
    assert operator_type_slug("RMSNorm / LayerNorm") == "rmsnorm"
    assert dtype_slug("INT8 W8A8") == "int8w8a8"
    assert dtype_slug("FP16 / BF16") == "fp16bf16"
    assert model_slug("Hy3 (Hunyuan 3)") == "hy3"
    assert model_slug("DeepSeek V4 Flash") == "deepseek-v4"
    assert model_slug("MiniMax M3") == "minimax-m3"
    assert model_slug("GLM5.2") == "glm52"


def test_parse_shape_meta():
    assert parse_shape_meta("hy3_tp4_o_proj_m4096") == {
        "tp": 4, "operator": "o_proj", "m": 4096,
    }
    assert parse_shape_meta("hy3_tp4_shared_gate_up_proj_m4096") == {
        "tp": 4, "operator": "shared_gate_up_proj", "m": 4096,
    }
    assert parse_shape_meta("tp4_wqkv_a_m2") == {
        "tp": 4, "operator": "wqkv_a", "m": 2,
    }


def test_derive_variant_meta():
    answers = {"operator": "Quantized GEMM", "dtype": "INT8 W8A8", "model": "Hy3 (Hunyuan 3)"}
    meta = derive_variant_meta(answers, "hy3_tp4_o_proj_m4096")
    assert meta["family"] == "int8w8a8-gemm"
    assert meta["model"] == "hy3"
    assert meta["tp"] == 4
    assert meta["operator_name"] == "o_proj"
    assert meta["m"] == 4096


def test_variant_path_carries_the_hardware_profile(tmp_path, monkeypatch, pinned_profile):
    """A variant leaf must live under the profile that measured it.

    Regression: one shared leaf per shape meant an air-measured kernel could
    overwrite the liquid variant for the same shape (happened 2026-09-25).
    """
    monkeypatch.setattr(vs, "variant_root", lambda: tmp_path)
    meta = derive_variant_meta(_answers(), "hy3_tp4_o_proj_m4096")
    path = vs.variant_path(meta)
    assert path == (
        tmp_path / "air-k100ai" / "int8w8a8-gemm" / "hy3" / "TP4" / "M4096"
        / "o_proj.hip"
    )
    # An explicit profile overrides the detected one (used by migration tools).
    other = vs.variant_path(meta, profile="liquid-k500sm")
    assert other.parts[len(tmp_path.parts)] == "liquid-k500sm"


def test_variant_header_records_profile_machine_and_date(tmp_path, monkeypatch, pinned_profile):
    monkeypatch.setattr(vs, "variant_root", lambda: tmp_path)
    meta = derive_variant_meta(_answers(), "hy3_tp4_o_proj_m16")
    vs.add_variant(meta=meta, kernel_source="K", commit="abc",
                   metrics={"median_us": 20.0}, source_task="t-1")
    text = vs.variant_path(meta).read_text()
    assert "hw_profile=air-k100ai" in text
    assert "measured_on=" in text and "machine=" in text
    entry = next(e for e in vs.list_variant_index() if e["shape"] == meta["shape"])
    assert entry["profile"] == "air-k100ai"
    assert entry["hw_profile"] == "air-k100ai"
    assert entry["machine"]
    assert entry["measured_on"]


def test_index_reports_legacy_layout_as_unmigrated(tmp_path, monkeypatch):
    """A pre-split checkout must be visible, not silently mislabelled."""
    monkeypatch.setattr(vs, "variant_root", lambda: tmp_path)
    target = tmp_path / "int8w8a8-gemm" / "hy3" / "TP4" / "M16" / "qkv_proj.hip"
    target.parent.mkdir(parents=True)
    target.write_text(
        "// @@variant shape=hy3_tp4_qkv_proj_m16 commit=abc added=2026-08-26\n"
        "//   median_us=26.05\n// @@end\nkernel\n",
        encoding="utf-8",
    )
    entry = vs.list_variant_index()[0]
    assert entry["profile"] == vs.UNMIGRATED_PROFILE
    assert entry["family"] == "int8w8a8-gemm"  # offsets still resolved


def test_cross_profile_write_is_refused(tmp_path, monkeypatch, pinned_profile):
    """Writing into another machine's profile must fail loudly."""
    monkeypatch.setattr(vs, "variant_root", lambda: tmp_path)
    meta = derive_variant_meta(_answers(), "hy3_tp4_o_proj_m16")
    with pytest.raises(ValueError, match="cross-profile"):
        vs.add_variant(
            meta=meta, kernel_source="K", commit="abc",
            metrics={"median_us": 20.0}, profile="liquid-k500sm",
            require_profile=True,
        )
    assert not (tmp_path / "liquid-k500sm").exists()


def test_slower_replacement_guard_skips_across_profiles(tmp_path, monkeypatch):
    """The recorded median is only comparable within one profile."""
    monkeypatch.setattr(vs, "variant_root", lambda: tmp_path)
    meta = derive_variant_meta(_answers(), "hy3_tp4_qkv_proj_m16")
    vs.add_variant(meta=meta, kernel_source="OLD", commit="a",
                   metrics={"median_us": 10.0}, profile="liquid-k500sm")
    target = vs.variant_path(meta, profile="liquid-k500sm")
    # same shape, different profile: the guard must not apply the other
    # profile's median to this candidate
    vs._reject_slower_replacement(target, {"median_us": 999.0}, profile="air-k100ai")
    with pytest.raises(ValueError):
        vs._reject_slower_replacement(target, {"median_us": 999.0},
                                      profile="liquid-k500sm")


def test_add_variant_writes_and_replaces(tmp_path, monkeypatch):
    monkeypatch.setattr(vs, "variant_root", lambda: tmp_path)
    answers = {"operator": "Quantized GEMM", "dtype": "INT8 W8A8", "model": "Hy3 (Hunyuan 3)"}
    meta = derive_variant_meta(answers, "hy3_tp4_o_proj_m4096")
    r1 = vs.add_variant(
        meta=meta, kernel_source="KERNEL_OLD", commit="abc",
        metrics={"median_us": 803.9, "logical_tops": 85.48, "speedup": 24.73},
        source_task="task-1",
    )
    assert r1["action"] == "added"
    target = vs.variant_path(meta)
    assert target.is_file()
    assert "KERNEL_OLD" in target.read_text()
    assert "@@variant shape=hy3_tp4_o_proj_m4096" in target.read_text()
    assert "median_us=803.9" in target.read_text()

    r2 = vs.add_variant(
        meta=meta, kernel_source="KERNEL_NEW", commit="def",
        metrics={"median_us": 800.0},
        source_task="task-1",
    )
    assert r2["action"] == "updated"
    assert r2["backup"] is not None
    text = target.read_text()
    assert "KERNEL_NEW" in text
    assert "KERNEL_OLD" not in text


def test_list_variant_index_walks_tree(tmp_path, monkeypatch):
    monkeypatch.setattr(vs, "variant_root", lambda: tmp_path)
    answers = {"operator": "Quantized GEMM", "dtype": "INT8 W8A8", "model": "Hy3 (Hunyuan 3)"}
    vs.add_variant(
        meta=derive_variant_meta(answers, "hy3_tp4_o_proj_m4096"),
        kernel_source="A", commit="x", metrics={},
    )
    vs.add_variant(
        meta=derive_variant_meta(answers, "hy3_tp4_qkv_proj_m4096"),
        kernel_source="B", commit="y", metrics={},
    )
    index = vs.list_variant_index()
    shapes = {item["shape"] for item in index}
    assert shapes == {"hy3_tp4_o_proj_m4096", "hy3_tp4_qkv_proj_m4096"}
    o_proj = next(item for item in index if item["shape"] == "hy3_tp4_o_proj_m4096")
    assert o_proj["family"] == "int8w8a8-gemm"
    assert o_proj["model"] == "hy3"
    assert o_proj["tp"] == "TP4"
    assert o_proj["m"] == "M4096"
    assert o_proj["operator"] == "o_proj"


def test_parse_variant_header_extracts_metrics():
    text = (
        "// @@variant shape=hy3_tp4_o_proj_m16 commit=abc123 added=2026-08-26\n"
        "//   median_us=18.22 p90_us=18.24 speedup=3.0\n"
        "//   source=hy3-dsh-tp4-m16-1-7f1fb1d1\n"
        "// body comments like K=4096 must not surface\n"
        "// @@end\n"
        "kernel source...\n"
    )
    parsed = vs._parse_variant_header(text)
    assert parsed["shape"] == "hy3_tp4_o_proj_m16"
    assert parsed["commit"] == "abc123"
    assert parsed["source"] == "hy3-dsh-tp4-m16-1-7f1fb1d1"
    assert parsed["median_us"] == 18.22
    assert parsed["p90_us"] == 18.24
    assert parsed["speedup"] == 3.0
    assert "K" not in parsed
    assert "shape" not in parsed or parsed["shape"] != "m16"


def test_list_variant_index_surfaces_header_metrics(tmp_path, monkeypatch):
    monkeypatch.setattr(vs, "variant_root", lambda: tmp_path)
    target = (
        tmp_path / "int8w8a8-gemm" / "hy3" / "TP4" / "M16" / "qkv_proj.hip"
    )
    target.parent.mkdir(parents=True)
    target.write_text(
        "// @@variant shape=hy3_tp4_qkv_proj_m16 commit=abc added=2026-08-26\n"
        "//   median_us=26.05 p90_us=26.09\n"
        "//   source=task-1\n"
        "// @@end\nkernel\n",
        encoding="utf-8",
    )
    index = vs.list_variant_index()
    assert len(index) == 1
    v = index[0]
    assert v["shape"] == "hy3_tp4_qkv_proj_m16"
    assert v["median_us"] == 26.05
    assert v["p90_us"] == 26.09
    assert v["source"] == "task-1"
    assert v["commit"] == "abc"
    assert v["operator"] == "qkv_proj"


def _add_with_guard(tmp_path, monkeypatch, median_us):
    monkeypatch.setattr(vs, "variant_root", lambda: tmp_path)
    answers = {"operator": "Quantized GEMM", "dtype": "INT8 W8A8", "model": "Hy3 (Hunyuan 3)"}
    meta = derive_variant_meta(answers, "hy3_tp4_qkv_proj_m16")
    return vs.add_variant(
        meta=meta,
        kernel_source="KERNEL",
        commit="c",
        metrics={"median_us": median_us},
        source_task="task-x",
        reject_slower_than_existing=True,
    )


def test_reject_slower_replacement_guard(tmp_path, monkeypatch):
    assert _add_with_guard(tmp_path, monkeypatch, 26.05)["action"] == "added"
    # faster candidate replaces
    assert _add_with_guard(tmp_path, monkeypatch, 24.30)["action"] == "updated"
    # equal candidate replaces
    assert _add_with_guard(tmp_path, monkeypatch, 24.30)["action"] == "updated"
    # strictly slower candidate is rejected
    with pytest.raises(ValueError, match="rejecting slower variant replacement"):
        _add_with_guard(tmp_path, monkeypatch, 30.0)
    # the rejected replacement did not overwrite the variant
    text = vs.variant_path(
        derive_variant_meta(
            {"operator": "Quantized GEMM", "dtype": "INT8 W8A8", "model": "Hy3 (Hunyuan 3)"},
            "hy3_tp4_qkv_proj_m16",
        )
    ).read_text()
    assert "median_us=24.3" in text or "median_us=24.30" in text


def test_reject_slower_guard_skips_when_median_unknown(tmp_path, monkeypatch):
    monkeypatch.setattr(vs, "variant_root", lambda: tmp_path)
    answers = {"operator": "Quantized GEMM", "dtype": "INT8 W8A8", "model": "Hy3 (Hunyuan 3)"}
    meta = derive_variant_meta(answers, "hy3_tp4_o_proj_m16")
    vs.add_variant(
        meta=meta, kernel_source="OLD", commit="a",
        metrics={}, source_task="task-1",
    )
    # existing has no median in header; candidate median present -> no guard
    result = vs.add_variant(
        meta=meta, kernel_source="NEW", commit="b",
        metrics={"median_us": 999.0}, source_task="task-2",
        reject_slower_than_existing=True,
    )
    assert result["action"] == "updated"
    assert "NEW" in vs.variant_path(meta).read_text()


def test_backfill_variant_baselines(tmp_path, monkeypatch):
    # Pinned to the profile whose table holds this shape's baseline: a backfill
    # never borrows the other profile's number (see the next test).
    monkeypatch.setenv("METAINFER_HW_PROFILE", "liquid-k500sm")
    hw_profile.clear_cache()
    monkeypatch.setattr(vs, "variant_root", lambda: tmp_path)
    target = (
        tmp_path / "int8w8a8-gemm" / "deepseek-v4" / "TP4" / "M16"
        / "wqkv_a.hip"
    )
    target.parent.mkdir(parents=True)
    target.write_text(
        "// @@variant shape=tp4_wqkv_a_m16 commit=abc added=2026-08-26\n"
        "//   median_us=20.0 p90_us=21.0\n"
        "//   source=task-1\n"
        "// @@end\nkernel\n",
        encoding="utf-8",
    )
    r = vs.backfill_variant_baselines()
    # tp4 wqkv_a m16 fixed Triton baseline is 66.597 us -> speedup ~3.33
    assert r["updated"] == ["int8w8a8-gemm/deepseek-v4/TP4/M16/wqkv_a.hip"]
    text = target.read_text()
    assert "baseline_us=66.597" in text
    assert "speedup=3.329" in text
    assert text.index("baseline_us") < text.index("median_us")
    # idempotent and surfaced by the index
    assert vs.backfill_variant_baselines()["updated"] == []
    v = vs.list_variant_index()[0]
    assert v["speedup"] is not None
    assert abs(v["baseline_us"] - 66.597) < 1e-3


def test_backfill_never_borrows_another_profiles_baseline(tmp_path, monkeypatch):
    """A shape the current profile has not measured gets no backfilled ratio.

    Baselines are per hardware profile: on the air board the reference (liquid)
    number is 1.06x-1.40x optimistic, so writing it into a variant header would
    record a cross-machine comparison as fact.
    """
    monkeypatch.setenv("METAINFER_HW_PROFILE", "air-k100ai")
    hw_profile.clear_cache()
    monkeypatch.setattr(vs, "variant_root", lambda: tmp_path)
    # M=4 is in no catalogue: the reference cannot answer either, so no ratio is
    # recorded (the same code path as "this profile has not measured it").
    target = (
        tmp_path / "int8w8a8-gemm" / "deepseek-v4" / "TP4" / "M4"
        / "wqkv_a.hip"
    )
    target.parent.mkdir(parents=True)
    target.write_text(
        "// @@variant shape=tp4_wqkv_a_m4 commit=abc added=2026-08-26\n"
        "//   median_us=20.0 p90_us=21.0\n"
        "//   source=task-1\n"
        "// @@end\nkernel\n",
        encoding="utf-8",
    )
    r = vs.backfill_variant_baselines()
    assert r["updated"] == []
    assert r["skipped"]["no_baseline"] == 1
    assert "baseline_us" not in target.read_text()


# --------------------------------------------------------------------------- #
# Shipped data: no variant may advertise a ratio from the other board
# --------------------------------------------------------------------------- #


def test_the_air_variant_records_a_baseline_from_its_own_profile():
    """Regression on the one air variant in the tree.

    It was promoted on 2026-09-25 from the pre-split air task
    (``minimax-tp8-m8-1-1e22df66``), whose report baseline was the hardcoded
    reference table: the header carried ``baseline_us=19.98 speedup=1.967``
    while this board's own value for the shape is 25.936 us.  Both numbers are
    pinned here, so the wrong one cannot come back unnoticed.
    """
    from ..orchestrator.w8a8_baselines import fixed_triton_graph_baseline

    leaf = (Path(__file__).resolve().parents[1] / "variant" / "air-k100ai"
            / "int8w8a8-gemm" / "minimax-m3" / "TP8" / "M8"
            / "shared_down_proj.hip")
    if not leaf.is_file():                       # tree moved/absent: nothing to pin
        pytest.skip("air variant not present in this checkout")
    header = vs._parse_variant_header(leaf.read_text(encoding="utf-8"))
    assert header.get("hw_profile") == "air-k100ai"

    own = fixed_triton_graph_baseline(
        header["shape"], {"tp_size": 8, "M": 8, "N": 6144, "K": 384},
        hw_profile="air-k100ai",
    )
    reference = fixed_triton_graph_baseline(
        header["shape"], {"tp_size": 8, "M": 8, "N": 6144, "K": 384},
        hw_profile="liquid-k500sm",
    )
    assert own["median_us"] == 25.936
    assert reference["median_us"] == 19.984
    # The header writer renders metrics with 4 significant digits.
    assert header["baseline_us"] == float(f"{own['median_us']:.4g}") == 25.94
    assert header["baseline_us"] != float(f"{reference['median_us']:.4g}")
    assert header["speedup"] == pytest.approx(25.94 / header["median_us"], rel=1e-3)
