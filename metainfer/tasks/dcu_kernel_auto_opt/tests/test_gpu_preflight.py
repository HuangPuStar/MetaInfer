"""GPU admission pre-check: usage rule + pollution marking."""

from __future__ import annotations

import pytest

from ..orchestrator import gpu_preflight as gp

SMI_SAMPLE = """
================================= System Management Interface ==================================
================================================================================================
HCU     Temp     AvgPwr     Perf     PwrCap     VRAM%      HCU%      Mode
0       51.0C    145.0W     manual   300.0W     0%         0.0%      Normal
1       49.0C    147.0W     manual   300.0W     12%        4.5%      Normal
2       57.0C    251.0W     manual   300.0W     40%        97.0%     Normal
3       58.0C    254.0W     manual   300.0W     92%        81.7%     Normal
======================================== End of SMI Log =========================================
"""


def test_parse_hy_smi_rows():
    parsed = gp.parse_hy_smi(SMI_SAMPLE)
    assert set(parsed) == {0, 1, 2, 3}
    assert parsed[0]["vram_percent"] == 0.0
    assert parsed[2]["util_percent"] == 97.0
    assert parsed[3]["power_w"] == 254.0
    assert parsed[1]["temp_c"] == 49.0


def test_usability_is_free_vram_not_percentage():
    """The rule is `free >= 4GB`, so a 91%-used card is still usable."""
    ok = gp.check_gpu(0, {"vram_percent": 91.0, "util_percent": 0.0},
                      total_gb=64.0)
    too_full = gp.check_gpu(1, {"vram_percent": 94.0, "util_percent": 0.0},
                            total_gb=64.0)
    assert ok["usable"] is True and ok["free_gb"] == 5.76
    assert ok["measurement_suspect"] is False
    assert too_full["usable"] is False and too_full["free_gb"] == 3.84
    assert any("VRAM free" in r for r in too_full["reasons"])
    # a full device is a capacity problem, not a pollution problem
    assert too_full["measurement_suspect"] is False
    assert gp.DEFAULT_MIN_FREE_GB == 4.0


def test_busy_marks_suspect_without_blocking():
    busy = gp.check_gpu(2, {"vram_percent": 40.0, "util_percent": 97.0,
                            "power_w": 251.0}, foreign_pids=[12345])
    assert busy["usable"] is True            # usage is allowed (VRAM ok)
    assert busy["measurement_suspect"] is True
    assert any("busy" in r for r in busy["reasons"])
    assert any("power" in r for r in busy["reasons"])
    # foreign pids are informational (idle holders are harmless)
    assert any("foreign" in n for n in busy["notes"])


def test_idle_foreign_holders_are_not_suspicion():
    """A device at 0% util / idle power is clean even if other containers hold it."""
    idle = gp.check_gpu(0, {"vram_percent": 0.0, "util_percent": 0.0,
                            "power_w": 144.0}, foreign_pids=[1, 2, 3])
    assert idle["usable"] is True
    assert idle["measurement_suspect"] is False
    assert idle["reasons"] == []
    assert any("foreign" in n for n in idle["notes"])


def test_preflight_prefers_clean_then_suspect_then_over_limit(monkeypatch):
    monkeypatch.setattr(gp, "sample_gpu_state",
                        lambda ids=None, **kw: {
                            0: {"vram_percent": 1.0, "util_percent": 0.0},
                            1: {"vram_percent": 5.0, "util_percent": 55.0,
                                "power_w": 250.0},
                            2: {"vram_percent": 30.0, "util_percent": 3.0},
                            3: {"vram_percent": 97.0, "util_percent": 10.0},
                        })
    monkeypatch.setattr(gp, "foreign_kfd_pids", lambda *a, **k: [])
    monkeypatch.setattr(gp, "total_vram_gb", lambda *a, **k: 64.0)
    plan = gp.preflight_gpus([0, 1, 2, 3])
    assert plan["clean_ids"] == [0, 2]
    assert plan["suspect_ids"] == [1]
    assert plan["over_limit_ids"] == [3]
    # usable devices first (clean before suspect); the over-limit device drops
    # out while any device is within the limit
    assert plan["preferred"] == [0, 2, 1]
    assert 3 not in plan["preferred"]


def test_over_limit_devices_return_when_nothing_else_is_usable(monkeypatch):
    monkeypatch.setattr(gp, "sample_gpu_state",
                        lambda ids=None, **kw: {
                            0: {"vram_percent": 97.0, "util_percent": 5.0},
                            1: {"vram_percent": 99.0, "util_percent": 5.0},
                        })
    monkeypatch.setattr(gp, "foreign_kfd_pids", lambda *a, **k: [])
    monkeypatch.setattr(gp, "total_vram_gb", lambda *a, **k: 64.0)
    plan = gp.preflight_gpus([0, 1])
    assert plan["preferred"] == [0, 1]


def test_foreign_kfd_pids_detects_invisible_pids(tmp_path):
    (tmp_path / "1").write_text("", encoding="utf-8")          # our own pid
    (tmp_path / "99999999").write_text("", encoding="utf-8")   # foreign
    pids = gp.foreign_kfd_pids(tmp_path)
    assert 99999999 in pids
    assert 1 not in pids


def test_preflight_enabled_env_and_answers(monkeypatch):
    monkeypatch.delenv("METAINFER_GPU_PREFLIGHT", raising=False)
    assert gp.preflight_enabled({}) is True                    # default on
    assert gp.preflight_enabled({"gpu_preflight": "false"}) is False
    monkeypatch.setenv("METAINFER_GPU_PREFLIGHT", "1")
    assert gp.preflight_enabled({"gpu_preflight": "false"}) is True
    monkeypatch.setenv("METAINFER_GPU_PREFLIGHT", "off")
    assert gp.preflight_enabled({}) is False


def test_disabled_preflight_returns_default_order():
    plan = gp.preflight_gpus([0, 1, 2, 3], enabled=False)
    assert plan["enabled"] is False
    assert plan["preferred"] == [0, 1, 2, 3]
    assert plan["gpus"] == {}
