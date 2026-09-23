"""HE pipeline promotion step: better kernels become DKAO variants."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from metainfer.tasks.dcu_kernel_auto_opt.orchestrator import variant_store as vs
from metainfer.tasks.harness_evolve.orchestrator.config import (
    ExperimentConfig, InstanceSpec,
)
from metainfer.tasks.harness_evolve.orchestrator.pipeline import (
    _promote_iteration,
)

SHAPE = "hy3_tp4_o_proj_m16"


@pytest.fixture()
def variant_root(tmp_path, monkeypatch):
    root = tmp_path / "variant"
    root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(vs, "variant_root", lambda: root)
    return root


def _cfg(tmp_path: Path, **answers) -> ExperimentConfig:
    base = {"promote_kernels": "true",
            "promote_min_improvement_percent": "3"}
    base.update(answers)
    return ExperimentConfig(
        task_id="he-promo", state_dir=tmp_path / "state",
        workspace_dir=tmp_path / "exp", suite=[], answers=base,
        execution_mode="dkao-cli", pool_source="pool.yaml",
        per_round_budget=1, max_iterations=1,
    )


def _inst() -> InstanceSpec:
    return InstanceSpec(id=SHAPE, shape={
        "model": "hy3-dsh-tp4-m16-2-368c654c", "tp_size": 4,
        "operator": "o_proj", "M": 16, "N": 4096, "K": 2048,
    }, budget_rounds=1, pass_median_us_le=20.0)


def _child_workspace(exp: Path, median_us: float) -> Path:
    leaf = (exp / "children" / "iteration_001" / SHAPE / "workspace"
            / "workers" / "worker_0" / "accepted" / SHAPE)
    leaf.mkdir(parents=True, exist_ok=True)
    (leaf / "kernel.hip").write_text("// promoted kernel\n", encoding="utf-8")
    (leaf / "manifest.json").write_text(json.dumps({
        "commit": "abc123",
        "shape": {"M": 16, "N": 4096, "K": 2048},
        "metrics": {"median_us": median_us, "p90_us": median_us * 1.01},
    }), encoding="utf-8")
    return leaf


def _seed_variant(root: Path, median_us: float) -> Path:
    meta = vs.derive_variant_meta(
        {"operator": "Quantized GEMM", "dtype": "INT8 W8A8",
         "model": "Hy3 (Hunyuan 3)"}, SHAPE)
    target = vs.variant_path(meta)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(vs.section_header(meta, commit="old", metrics={
        "median_us": median_us}) + "// old\n// @@end\n", encoding="utf-8")
    return target


def test_promotes_faster_child_and_logs(tmp_path, variant_root):
    cfg = _cfg(tmp_path)
    exp = cfg.exp_dir
    _child_workspace(exp, 8.49)
    _seed_variant(variant_root, 9.17)          # 7.4% faster -> promote
    results = {SHAPE: {"correctness_ok": True, "passed": True,
                       "median_us": 8.49}}

    payload = _promote_iteration(cfg, exp, 1, results, [_inst()])

    assert payload and payload["promoted"] == [SHAPE]
    out = payload["results"][0]
    assert out["action"] == "updated"
    assert out["improvement_percent"] == pytest.approx(7.42, abs=0.05)
    assert (exp / "runs" / "iteration_001" / "promotion.json").is_file()
    log = (exp / "promotion_log.jsonl").read_text(encoding="utf-8").strip()
    assert json.loads(log)["shape"] == SHAPE
    # the variant leaf now carries the new kernel
    assert "promoted kernel" in Path(out["path"]).read_text(encoding="utf-8")


def test_skips_below_threshold_and_ignores_missing_workspace(tmp_path, variant_root):
    cfg = _cfg(tmp_path)
    exp = cfg.exp_dir
    _child_workspace(exp, 9.10)                # only 0.8% faster than 9.17
    _seed_variant(variant_root, 9.17)
    other = InstanceSpec(id="hy3_tp4_qkv_proj_m16", shape={"M": 16}, budget_rounds=1)
    results = {SHAPE: {"correctness_ok": True, "median_us": 9.10},
               "hy3_tp4_qkv_proj_m16": {"correctness_ok": True, "median_us": 1.0}}

    payload = _promote_iteration(cfg, exp, 1, results, [_inst(), other])
    by_shape = {r["shape"]: r for r in payload["results"]}
    assert payload["promoted"] == []
    assert by_shape[SHAPE]["action"] == "skipped"
    assert "required 3.00%" in by_shape[SHAPE]["reason"]
    # a question with no child directory at all reports "no kernel", the same
    # as a child directory that produced none
    assert by_shape["hy3_tp4_qkv_proj_m16"]["action"] == "no_kernel"
    assert "no accepted kernel" in by_shape["hy3_tp4_qkv_proj_m16"]["reason"]


def test_disabled_by_default_switch_returns_none(tmp_path, variant_root):
    cfg = _cfg(tmp_path, promote_kernels="false")
    exp = cfg.exp_dir
    _child_workspace(exp, 1.0)
    assert _promote_iteration(cfg, exp, 1, {}, [_inst()]) is None
    assert not (exp / "runs" / "iteration_001" / "promotion.json").exists()


def test_failed_correctness_is_never_promoted(tmp_path, variant_root):
    cfg = _cfg(tmp_path)
    exp = cfg.exp_dir
    _child_workspace(exp, 1.0)
    payload = _promote_iteration(
        cfg, exp, 1,
        {SHAPE: {"correctness_ok": False, "median_us": 1.0}}, [_inst()])
    assert payload["promoted"] == []
    assert payload["results"][0]["action"] == "skipped"
