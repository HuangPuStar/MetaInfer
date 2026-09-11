"""Kernel promotion gates (variant tree write) — no GPU calls."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from ..orchestrator import variant_store as vs
from ..orchestrator.variant_promote import (
    accepted_kernel_for, model_label_for, promote_variant,
)

ANSWERS = {"operator": "Quantized GEMM", "dtype": "INT8 W8A8"}
SHAPE = "hy3_tp4_o_proj_m16"


@pytest.fixture()
def variant_root(tmp_path, monkeypatch):
    root = tmp_path / "variant"
    root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(vs, "variant_root", lambda: root)
    return root


def _workspace(tmp_path: Path, median_us: float, *, shape: str = SHAPE,
               commit: str = "deadbeef") -> Path:
    ws = tmp_path / "ws"
    leaf = ws / "workers" / "worker_0" / "accepted" / shape
    leaf.mkdir(parents=True, exist_ok=True)
    (leaf / "kernel.hip").write_text("// kernel source\n", encoding="utf-8")
    (leaf / "manifest.json").write_text(json.dumps({
        "commit": commit,
        "shape": {"M": 16, "N": 4096, "K": 2048},
        "metrics": {"median_us": median_us, "p90_us": median_us * 1.02},
    }), encoding="utf-8")
    return ws


def _seed_variant(variant_root: Path, median_us: float) -> Path:
    meta = vs.derive_variant_meta(ANSWERS | {"model": "Hy3 (Hunyuan 3)"}, SHAPE)
    target = vs.variant_path(meta)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(vs.section_header(meta, commit="old", metrics={
        "median_us": median_us, "p90_us": median_us}) + "// old kernel\n// @@end\n",
        encoding="utf-8")
    return target


def test_adds_when_no_existing_variant(tmp_path, variant_root):
    ws = _workspace(tmp_path, 20.0)
    out = promote_variant(workspace_dir=ws, answers=ANSWERS, shape_id=SHAPE,
                          correctness_ok=True, min_improvement_percent=3.0,
                          source_task="he-test")
    assert out["action"] == "added"
    assert Path(out["path"]).is_file()
    assert "he-test" in Path(out["path"]).read_text(encoding="utf-8")


def test_updates_when_faster_than_threshold(tmp_path, variant_root):
    _seed_variant(variant_root, 100.0)
    ws = _workspace(tmp_path, 90.0)          # 10% faster
    out = promote_variant(workspace_dir=ws, answers=ANSWERS, shape_id=SHAPE,
                          correctness_ok=True, min_improvement_percent=3.0)
    assert out["action"] == "updated"
    assert out["improvement_percent"] == pytest.approx(10.0, abs=1e-6)
    assert out["backup"] and Path(out["backup"]).is_file()
    assert "median_us=90" in Path(out["path"]).read_text(encoding="utf-8")


def test_skips_improvement_below_threshold(tmp_path, variant_root):
    _seed_variant(variant_root, 100.0)
    ws = _workspace(tmp_path, 98.5)          # only 1.5% faster
    out = promote_variant(workspace_dir=ws, answers=ANSWERS, shape_id=SHAPE,
                          correctness_ok=True, min_improvement_percent=3.0)
    assert out["action"] == "skipped"
    assert "required 3.00%" in out["reason"]
    # existing variant untouched (still the old median)
    assert "median_us=100" in Path(out["path"]).read_text(encoding="utf-8")


def test_slower_candidate_is_skipped_by_default_gate(tmp_path, variant_root):
    """With the default gate (min 0%) any regression is skipped up front."""
    _seed_variant(variant_root, 100.0)
    ws = _workspace(tmp_path, 120.0)
    out = promote_variant(workspace_dir=ws, answers=ANSWERS, shape_id=SHAPE,
                          correctness_ok=True, min_improvement_percent=0.0)
    assert out["action"] == "skipped"
    assert "required 0.00%" in out["reason"]


def test_add_variant_guard_rejects_slower_when_gate_is_loosened(tmp_path, variant_root):
    """A loosened threshold still cannot overwrite with a slower kernel."""
    _seed_variant(variant_root, 100.0)
    ws = _workspace(tmp_path, 101.0)
    out = promote_variant(workspace_dir=ws, answers=ANSWERS, shape_id=SHAPE,
                          correctness_ok=True, min_improvement_percent=-10.0)
    assert out["action"] == "rejected"
    assert "slower" in out["reason"]


def test_skips_when_correctness_failed(tmp_path, variant_root):
    ws = _workspace(tmp_path, 10.0)
    out = promote_variant(workspace_dir=ws, answers=ANSWERS, shape_id=SHAPE,
                          correctness_ok=False, min_improvement_percent=3.0)
    assert out["action"] == "skipped"
    assert "correctness" in out["reason"]


def test_no_kernel_found(tmp_path, variant_root):
    out = promote_variant(workspace_dir=tmp_path / "empty", answers=ANSWERS,
                          shape_id=SHAPE)
    assert out["action"] == "no_kernel"


def test_dry_run_does_not_write(tmp_path, variant_root):
    ws = _workspace(tmp_path, 10.0)
    out = promote_variant(workspace_dir=ws, answers=ANSWERS, shape_id=SHAPE,
                          correctness_ok=True, min_improvement_percent=3.0,
                          dry_run=True)
    assert out["action"] == "would-add"
    assert not Path(out["path"]).exists()


def test_meta_taxonomy_and_overrides(tmp_path, variant_root):
    ws = _workspace(tmp_path, 10.0)
    out = promote_variant(workspace_dir=ws, answers=ANSWERS, shape_id=SHAPE,
                          correctness_ok=True)
    meta = out["meta"]
    assert (meta["family"], meta["model"], meta["tp"], meta["m"],
            meta["operator_name"]) == ("int8w8a8-gemm", "hy3", 4, 16, "o_proj")

    # shapes without tp/M in the id take them from the caller (pool contract)
    ws2 = _workspace(tmp_path / "two", 10.0, shape="m16_wqkv_a")
    out2 = promote_variant(workspace_dir=ws2, answers=ANSWERS,
                           shape_id="m16_wqkv_a", correctness_ok=True,
                           tp=8, m=16, model_label="DeepSeek V4 Flash")
    assert out2["meta"]["tp"] == 8 and out2["meta"]["m"] == 16
    assert "/TP8/M16/" in out2["path"]


def test_model_label_and_accepted_lookup(tmp_path):
    assert model_label_for("minimax_tp8_o_proj_m16") == "MiniMax M3"
    assert model_label_for("glm_tp8_o_proj_m4096") == "GLM5.2"
    ws = _workspace(tmp_path, 5.0)
    found = accepted_kernel_for(ws, SHAPE)
    assert found and found["metrics"]["median_us"] == 5.0
    assert accepted_kernel_for(ws, "nope") is None
