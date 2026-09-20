"""A/B retest tool: variant lookup, header parsing, verdict and environment."""

from __future__ import annotations

from pathlib import Path

from ..tools.retest_variant import (
    BENCH_ENV, bench_env, decide, find_variant, parse_variant_header_median,
)


def test_find_variant_tolerates_model_label_drift(tmp_path):
    """glm should find the shipped glm52 directory."""
    root = tmp_path / "variant" / "int8w8a8-gemm"
    glm = root / "glm52" / "TP8" / "M4096"
    glm.mkdir(parents=True)
    (glm / "shared_down_proj.hip").write_text("// kernel\n", encoding="utf-8")
    assert find_variant("glm", 8, 4096, "shared_down_proj", root) == (
        glm / "shared_down_proj.hip")
    assert find_variant("glm", 8, 16, "shared_down_proj", root) is None
    assert find_variant("hy3", 4, 4096, "o_proj", root) is None


def test_parse_variant_header_median_reads_the_record():
    text = ("// @@variant shape=hy3_tp4_o_proj_m4096 commit=abc added=2026-09-14\n"
            "//   median_us=453.2 p90_us=454.2 speedup=43.87 baseline_us=1.988e+04\n"
            "// code follows\n")
    path = Path("/tmp/_variant_header_test.hip")
    path.write_text(text, encoding="utf-8")
    try:
        assert parse_variant_header_median(path) == 453.2
    finally:
        path.unlink(missing_ok=True)
    assert parse_variant_header_median(Path("/tmp/does-not-exist.hip")) is None


def test_bench_env_pins_gfx928_and_the_device():
    env = bench_env(2, base={})
    assert env["PYTORCH_ROCM_ARCH"] == BENCH_ENV["PYTORCH_ROCM_ARCH"] == "gfx928"
    assert env["HIP_VISIBLE_DEVICES"] == "2"
    assert env["CUDA_VISIBLE_DEVICES"] == "2"


def test_decide_requires_margin_and_reproducibility():
    # a clear, reproducible win
    assert decide(140.0, 280.0, recorded_us=140.0)["verdict"] == "promote"
    # too small a margin
    assert decide(275.0, 280.0, recorded_us=275.0)["verdict"] == "keep"
    # fast but the re-measurement disagrees with the record -> review
    assert decide(140.0, 280.0, recorded_us=100.0)["verdict"] == "needs_review"
    # missing measurement
    assert decide(None, 280.0)["verdict"] == "measurement_failed"
