"""Provenance stamping for variant leaves (hardware profile in the header).

The regression this file exists for: the first version of the tool searched for
the *last* ``//   `` line before ``// @@end``.  Kernel bodies are full of
"//   " indented comments, so the provenance line landed 349 lines into a
400-line kernel instead of in the header.  The index still parsed it (the header
regex is DOTALL up to ``// @@end``), so nothing failed loudly -- only a human
reading the file would notice.  Hence: pin the insertion point.
"""

from __future__ import annotations

from metainfer.tasks.dcu_kernel_auto_opt.tools import backfill_variant_profiles as bf

_KERNEL = (
    "// @@variant shape=hy3_tp4_o_proj_m16 commit=abc added=2026-09-10\n"
    "//   median_us=8.489 p90_us=8.888\n"
    "//   source=test-9-8-8-803e5cee/iteration_001/hy3_tp4_o_proj_m16\n"
    "// body comment\n"
    "//   K=4096 is a body comment, not a header field\n"
    "//   another indented body line\n"
    "__global__ void k() {}\n"
    "// @@end\n"
)


def test_stamp_inserts_directly_after_the_header_run():
    stamped = bf.stamp(_KERNEL, "liquid-k500sm", "j20r1n08")
    lines = stamped.splitlines()
    assert lines[3] == ("//   hw_profile=liquid-k500sm machine=j20r1n08 "
                        "measured_on=2026-09-10")
    # ... and nothing was inserted into the body.
    assert lines[4] == "// body comment"
    assert stamped.count("hw_profile=") == 1


def test_stamp_uses_the_headers_own_date_not_today():
    stamped = bf.stamp(_KERNEL, "air-k100ai", "kme6")
    assert "measured_on=2026-09-10" in stamped


def test_stamp_keeps_everything_else_byte_identical():
    stamped = bf.stamp(_KERNEL, "liquid-k500sm", "j20r1n08")
    assert stamped.replace(
        "//   hw_profile=liquid-k500sm machine=j20r1n08 measured_on=2026-09-10\n",
        "", 1,
    ) == _KERNEL


def test_stamp_tolerates_a_header_without_detail_lines():
    text = ("// @@variant shape=x commit=c added=2026-01-01\n"
            "kernel body\n// @@end\n")
    stamped = bf.stamp(text, "liquid-k500sm", "j20r1n08")
    assert stamped.splitlines()[1].startswith("//   hw_profile=")


def test_has_profile_reads_only_the_header():
    assert bf._has_profile(_KERNEL) is False
    # A body mention must not count as a stamped header.
    body_only = ("// @@variant shape=x commit=c added=2026-01-01\n"
                 "// @@end\n")
    assert bf._has_profile(body_only) is False


def test_machine_names_come_from_the_registry():
    assert bf.machine_for("air-k100ai") == "kme6"
    assert bf.machine_for("liquid-k500sm") == "j20r1n08"
    assert bf.machine_for("not-a-profile") == "unknown"


def test_plan_and_apply_on_a_tree(tmp_path):
    leaf = tmp_path / "liquid-k500sm" / "int8w8a8-gemm" / "hy3" / "TP4" / "M16"
    leaf.mkdir(parents=True)
    target = leaf / "o_proj.hip"
    target.write_text(_KERNEL, encoding="utf-8")
    # The legacy single-file variant is not a leaf and must be ignored.
    (tmp_path / "w8a8_gemm_variants.hip").write_text(_KERNEL, encoding="utf-8")

    rows = bf.plan(tmp_path)
    assert [r["path"] for r in rows] == ["liquid-k500sm/int8w8a8-gemm/hy3/TP4/M16/o_proj.hip"]
    assert rows[0]["profile"] == "liquid-k500sm"
    assert rows[0]["action"] == "stamp"

    report = bf.apply(tmp_path, backup_root=tmp_path.parent / "backup")
    assert report["changed"] == [rows[0]["path"]]
    assert "hw_profile=liquid-k500sm machine=j20r1n08" in target.read_text()


def test_apply_is_idempotent(tmp_path):
    leaf = tmp_path / "liquid-k500sm" / "int8w8a8-gemm" / "hy3" / "TP4" / "M16"
    leaf.mkdir(parents=True)
    (leaf / "o_proj.hip").write_text(_KERNEL, encoding="utf-8")
    bf.apply(tmp_path)
    once = (leaf / "o_proj.hip").read_text()
    report = bf.apply(tmp_path)
    assert report["changed"] == []
    assert (leaf / "o_proj.hip").read_text() == once


def test_legacy_layout_reports_the_unmigrated_profile(tmp_path):
    leaf = tmp_path / "int8w8a8-gemm" / "hy3" / "TP4" / "M16"
    leaf.mkdir(parents=True)
    (leaf / "o_proj.hip").write_text(_KERNEL, encoding="utf-8")
    row = bf.plan(tmp_path)[0]
    assert row["profile"] is None          # no profile level in the path
    report = bf.apply(tmp_path)
    # ... and it is stamped as unmigrated rather than silently claiming a profile.
    assert "hw_profile=unmigrated" in (leaf / "o_proj.hip").read_text()
    assert report["changed"]
