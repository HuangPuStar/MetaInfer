"""Tests for the profiler skill (#6, closes FM-3 rocprof gap).

Everything subprocess-backed goes through an injected ``runner`` so no test
needs a GPU or the rocprof binary. Covers: idle-GPU selection, rocprof output
parsing, driver-script generation, the profile_kernel orchestration (success
+ graceful failure), the CLI ``main``, the prompt skill text, and the
``perf_plan_prompt`` injection.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from metainfer.tasks.opt_kernel.orchestrator import profiler
from metainfer.tasks.opt_kernel.orchestrator.prompts import perf_plan_prompt


# --------------------------------------------------------------------------- #
# find_idle_gpu
# --------------------------------------------------------------------------- #

def _rocm_runner(cards):
    def r(cmd, t):
        if cmd[0] == "rocm-smi":
            obj = {f"card{i}": {"vram_used": v} for i, v in cards.items()}
            return 0, json.dumps(obj), ""
        return 1, "", "no nvidia"
    return r


def test_find_idle_gpu_picks_least_used():
    assert profiler.find_idle_gpu(runner=_rocm_runner({0: 5000, 1: 100})) == 1


def test_find_idle_gpu_respects_preferred_when_present():
    assert profiler.find_idle_gpu(runner=_rocm_runner({0: 100, 1: 5000}),
                                  preferred=1) == 1


def test_find_idle_gpu_preferred_absent_falls_back_to_least_used():
    assert profiler.find_idle_gpu(runner=_rocm_runner({0: 100, 1: 5000}),
                                  preferred=7) == 0


def test_find_idle_gpu_none_when_no_tools():
    def r(cmd, t):
        return 1, "", "neither tool"
    assert profiler.find_idle_gpu(runner=r) is None


def test_find_idle_gpu_cuda_fallback():
    def r(cmd, t):
        if cmd[0] == "nvidia-smi":
            return 0, "100\n3000\n", ""
        return 1, "", "no rocm"
    assert profiler.find_idle_gpu(runner=r) == 0  # GPU 0 less used


def test_find_idle_gpu_rocm_malformed_json_returns_none():
    def r(cmd, t):
        return 0, "not json", ""
    assert profiler.find_idle_gpu(runner=r) is None


# --------------------------------------------------------------------------- #
# parse_rocprof
# --------------------------------------------------------------------------- #

def test_parse_rocprof_csv_sums_counters_across_rows():
    text = "KernelName,gpu_id,VALUInsts,L2CacheHit\nmm,0,100.0,0.5\nmm,0,200.0,0.25\n"
    out = profiler.parse_rocprof(text)
    assert out["VALUInsts"] == 300.0
    assert out["L2CacheHit"] == pytest.approx(0.75)


def test_parse_rocprof_empty_and_garbage():
    assert profiler.parse_rocprof("") == {}
    assert profiler.parse_rocprof("nothing useful here") == {}


def test_parse_rocprof_skips_non_numeric_columns():
    text = "KernelName,gpu_id,VALUInsts\nmm,0,abc\nmm,0,50\n"
    out = profiler.parse_rocprof(text)
    assert out["VALUInsts"] == 50.0


# --------------------------------------------------------------------------- #
# build_driver_script
# --------------------------------------------------------------------------- #

def test_build_driver_script_references_path_shape_and_device(tmp_path):
    k = tmp_path / "kernel.py"
    s = profiler.build_driver_script(k, {"M": 8, "K": 16, "N": 32}, num_iters=7, device=1)
    assert str(k.parent) in s
    assert "(8, 16)" in s and "(16, 32)" in s
    assert "set_device(1)" in s
    assert "range(7)" in s


# --------------------------------------------------------------------------- #
# profile_kernel
# --------------------------------------------------------------------------- #

_ROCPROF_OK = ("KernelName,gpu_id,VALUInsts,L2CacheHit\n"
              "mm,0,12345.0,0.42\n")


def test_profile_kernel_success_writes_json_and_returns_counters(tmp_path):
    k = tmp_path / "kernel.py"
    k.write_text("VALUE = 1\n", encoding="utf-8")  # contents irrelevant; driver not run
    out = tmp_path / "profile_out.json"
    runner = MagicMock(return_value=(0, _ROCPROF_OK, ""))
    res = profiler.profile_kernel(k, {"M": 8, "K": 8, "N": 8},
                                  device=0, out_path=out, runner=runner)
    assert res is not None and res["ok"] is True
    assert res["counters"]["VALUInsts"] == 12345.0
    assert res["method"] == "rocprof" and res["device"] == 0
    written = json.loads(out.read_text())
    assert written["counters"]["VALUInsts"] == 12345.0
    # driver script was written next to the kernel
    assert (k.parent / "_profiler_driver.py").is_file()


def test_profile_kernel_failure_returns_none_and_records_gap(tmp_path):
    k = tmp_path / "kernel.py"
    k.write_text("VALUE = 1\n", encoding="utf-8")
    out = tmp_path / "profile_out.json"
    runner = MagicMock(return_value=(127, "", "rocprofv2: not found"))
    res = profiler.profile_kernel(k, {"M": 8, "K": 8, "N": 8},
                                  device=0, out_path=out, runner=runner)
    assert res is None  # advisory: caller treats as "no counters this run"
    written = json.loads(out.read_text())
    assert written["ok"] is False
    assert "rocprof run failed" in written["error"]
    assert "not found" in written["error"]  # FM-3 gap is explicit, not silent


def test_profile_kernel_no_counters_in_output_returns_none(tmp_path):
    k = tmp_path / "kernel.py"
    k.write_text("VALUE = 1\n", encoding="utf-8")
    runner = MagicMock(return_value=(0, "rocprof ran but empty", ""))
    res = profiler.profile_kernel(k, {"M": 8, "K": 8, "N": 8},
                                  device=0, runner=runner)
    assert res is None


def test_profile_kernel_picks_idle_device_when_none_given(tmp_path, monkeypatch):
    k = tmp_path / "kernel.py"
    k.write_text("VALUE = 1\n", encoding="utf-8")
    monkeypatch.setattr(profiler, "find_idle_gpu", lambda **kw: 3)
    runner = MagicMock(return_value=(0, _ROCPROF_OK, ""))
    res = profiler.profile_kernel(k, {"M": 8, "K": 8, "N": 8}, runner=runner)
    assert res["device"] == 3


# --------------------------------------------------------------------------- #
# main CLI
# --------------------------------------------------------------------------- #

def test_main_success_returns_zero(tmp_path, monkeypatch):
    k = tmp_path / "kernel.py"
    k.write_text("VALUE = 1\n", encoding="utf-8")
    monkeypatch.setattr(profiler, "profile_kernel",
                        lambda *a, **k: {"ok": True, "counters": {"VALUInsts": 1}})
    rc = profiler.main([str(k), "--M", "8", "--K", "8", "--N", "8"])
    assert rc == 0


def test_main_failure_returns_one(tmp_path, monkeypatch):
    k = tmp_path / "kernel.py"
    k.write_text("VALUE = 1\n", encoding="utf-8")
    monkeypatch.setattr(profiler, "profile_kernel", lambda *a, **k: None)
    rc = profiler.main([str(k), "--M", "8", "--K", "8", "--N", "8"])
    assert rc == 1


# --------------------------------------------------------------------------- #
# profiler_skill_text + perf_plan_prompt injection
# --------------------------------------------------------------------------- #

def test_profiler_skill_text_mentions_tool_method_and_fm3():
    txt = profiler.profiler_skill_text(Path("/repo"))
    assert "/repo" in txt
    assert "rocprof" in txt
    assert "FM-3" in txt
    assert "dedicated" in txt  # the iter-#14 methodology


def test_perf_plan_prompt_includes_profiler_hint_when_present():
    p = perf_plan_prompt(req={}, iter_dir=Path("/w"), notebooks_dir=Path("/n"),
                        iteration=2, profiler_hint="PROFILER-HINT-MARKER")
    assert "PROFILER-HINT-MARKER" in p


def test_perf_plan_prompt_omits_profiler_hint_when_absent():
    p = perf_plan_prompt(req={}, iter_dir=Path("/w"), notebooks_dir=Path("/n"),
                        iteration=2)
    assert "Profiling skill" not in p
