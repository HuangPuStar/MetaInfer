"""GPU admission pre-check: usage rule + pollution marking."""

from __future__ import annotations

import json

import pytest

from ..orchestrator import gpu_preflight as gp

import importlib.util
from pathlib import Path

_GPU_BROKER_AVAILABLE = (
    importlib.util.find_spec("metainfer.orchestrator.gpu_broker") is not None
)
requires_gpu_broker = pytest.mark.skipif(
    not _GPU_BROKER_AVAILABLE,
    reason="metainfer.orchestrator.gpu_broker is not available in this tree",
)
_DTK_HIPPROF_AVAILABLE = Path("/opt/dtk/bin/hipprof").is_file()
requires_dtk_hipprof = pytest.mark.skipif(
    not _DTK_HIPPROF_AVAILABLE,
    reason="/opt/dtk/bin/hipprof is required (DCU toolchain is absent)",
)

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

#: What hy-smi actually prints inside a container that cannot open the
#: management interface: the HCU% column (and every other utilisation value)
#: is a placeholder, NOT a zero.
SMI_UNAVAILABLE = """
================================= System Management Interface ==================================
================================================================================================
HCU     Temp     AvgPwr     Perf     PwrCap     VRAM%      HCU%      Mode
0       52.0C    146.0W     high     300.0W     0%         N/A       Normal
1       50.0C    149.0W     high     300.0W     0%         N/A       Normal
2       50.0C    148.0W     high     300.0W     0%         N/A       Normal
3       51.0C    148.0W     high     300.0W     0%         N/A       Normal
======================================== End of SMI Log =========================================
"""


def test_parse_hy_smi_rows():
    parsed = gp.parse_hy_smi(SMI_SAMPLE)
    assert set(parsed) == {0, 1, 2, 3}
    assert parsed[0]["vram_percent"] == 0.0
    assert parsed[2]["util_percent"] == 97.0
    assert parsed[3]["power_w"] == 254.0
    assert parsed[1]["temp_c"] == 49.0


def test_na_utilisation_is_unknown_not_zero():
    """``N/A`` must not become ``0.0``: that is what admitted busy cards."""
    parsed = gp.parse_hy_smi(SMI_UNAVAILABLE)
    assert set(parsed) == {0, 1, 2, 3}
    assert "util_percent" not in parsed[0]          # unknown, not idle
    assert parsed[0]["power_w"] == 146.0            # real fields are kept
    assert gp.smi_is_incomplete(SMI_UNAVAILABLE) is True
    assert gp.smi_is_incomplete(SMI_SAMPLE) is False


def test_sample_falls_back_to_sysfs_and_gates_busy_cards():
    """hy-smi cannot see HCU%: sysfs decides, and a busy card stays blocked."""
    def sysfs():
        return {0: {"util_percent": 0.0, "vram_percent": 2.0},
                1: {"util_percent": 0.0, "vram_percent": 2.0},
                2: {"util_percent": 74.0, "vram_percent": 20.0},
                3: {"util_percent": 0.0, "vram_percent": 95.0}}

    states = gp.sample_gpu_state([0, 1, 2, 3], samples=1, interval_s=0,
                                 smi_reader=lambda: SMI_UNAVAILABLE,
                                 sysfs_reader=sysfs)
    assert states[2]["util_percent"] == 74.0
    assert states[3]["vram_percent"] == 95.0
    assert not any(row.get("unavailable") for row in states.values())
    checks = {g: gp.check_gpu(g, states[g], total_gb=64.0) for g in range(4)}
    assert [g for g in range(4) if checks[g]["usable"]] == [0, 1]
    assert checks[2]["usable"] is False and checks[3]["usable"] is False


def test_no_source_at_all_means_unavailable(monkeypatch):
    states = gp.sample_gpu_state([0, 1], samples=1, interval_s=0,
                                 smi_reader=lambda: "",
                                 sysfs_reader=lambda: {})
    assert states[0]["unavailable"] == 1.0
    assert gp.check_gpu(0, states[0])["usable"] is False


def test_usability_requires_vram_limit_and_idle_device():
    """Operator rule: VRAM <= 90% *and* HCU == 0, nothing else counts."""
    ok = gp.check_gpu(0, {"vram_percent": 89.0, "util_percent": 0.0},
                      total_gb=64.0)
    assert ok["usable"] is True and ok["measurement_suspect"] is False

    too_full = gp.check_gpu(1, {"vram_percent": 91.0, "util_percent": 0.0},
                            total_gb=64.0)
    assert too_full["usable"] is False
    assert any("VRAM 91%" in r for r in too_full["reasons"])

    busy = gp.check_gpu(2, {"vram_percent": 10.0, "util_percent": 3.0},
                        total_gb=64.0)
    assert busy["usable"] is False                  # HCU must be 0
    assert any("HCU 3.0%" in r for r in busy["reasons"])

    assert gp.DEFAULT_VRAM_LIMIT_PERCENT == 90.0
    assert gp.DEFAULT_UTIL_TOLERANCE == 0.0


def test_busy_device_is_unusable_and_suspect():
    busy = gp.check_gpu(2, {"vram_percent": 40.0, "util_percent": 97.0,
                            "power_w": 251.0}, foreign_pids=[12345])
    assert busy["usable"] is False           # a busy device is never used
    assert busy["measurement_suspect"] is True
    assert any("busy" in r for r in busy["reasons"])
    # power draw is recorded for diagnosis but is not part of the gate
    assert busy["power_w"] == 251.0
    assert not any("power" in r for r in busy["reasons"])
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


def test_an_idle_card_passes_even_at_high_board_power():
    """The gate is exactly "VRAM <= 90% and HCU == 0" — nothing else blocks."""
    check = gp.check_gpu(1, {"vram_percent": 5.0, "util_percent": 0.0,
                             "power_w": 250.0})
    assert check["usable"] is True
    assert check["reasons"] == []


def test_preflight_gate_lists_all_and_only_passing_devices(monkeypatch):
    monkeypatch.setattr(gp, "sample_gpu_state",
                        lambda ids=None, **kw: {
                            0: {"vram_percent": 1.0, "util_percent": 0.0},
                            1: {"vram_percent": 5.0, "util_percent": 0.0,
                                "power_w": 250.0},
                            2: {"vram_percent": 30.0, "util_percent": 4.0},
                            3: {"vram_percent": 97.0, "util_percent": 0.0},
                        })
    monkeypatch.setattr(gp, "foreign_kfd_pids", lambda *a, **k: [])
    monkeypatch.setattr(gp, "total_vram_gb", lambda *a, **k: 64.0)
    plan = gp.preflight_gpus([0, 1, 2, 3])
    assert plan["clean_ids"] == [0, 1]
    assert plan["suspect_ids"] == []
    assert plan["blocked_ids"] == [2, 3]
    assert plan["over_limit_ids"] == [3]
    # only gate-passing devices are ever offered
    assert plan["preferred"] == [0, 1]
    assert "HCU 4.0%" in plan["gate_reasons"]["2"][0]


def test_blocked_devices_are_never_offered_for_a_measurement(monkeypatch):
    """Both cards full: the gate offers nothing so the caller waits and re-checks.

    Waiting 30 min and retrying (up to 48 times) is the operator rule; silently
    measuring on a device that failed the gate is what this prevents.
    """
    monkeypatch.setattr(gp, "sample_gpu_state",
                        lambda ids=None, **kw: {
                            0: {"vram_percent": 97.0, "util_percent": 5.0},
                            1: {"vram_percent": 99.0, "util_percent": 5.0},
                        })
    monkeypatch.setattr(gp, "foreign_kfd_pids", lambda *a, **k: [])
    monkeypatch.setattr(gp, "total_vram_gb", lambda *a, **k: 64.0)
    plan = gp.preflight_gpus([0, 1])
    assert plan["preferred"] == []
    assert plan["clean_ids"] == []
    assert plan["blocked_ids"] == [0, 1]
    assert "VRAM 97% > 90% limit" in plan["gate_reasons"]["0"]


def test_unreadable_device_state_is_not_usable(monkeypatch):
    """No HCU/VRAM reading must never be treated as "idle"."""
    monkeypatch.setattr(gp, "foreign_kfd_pids", lambda *a, **k: [])
    check = gp.check_gpu(0, {"unavailable": 1.0,
                             "missing_fields": ["vram_percent", "util_percent"]})
    assert check["usable"] is False
    assert check["unavailable"] is True
    assert any("state unavailable" in r for r in check["reasons"])


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


# ---------------------------------------------------------------- sub-task gate
# A DKAO child iterates for hours, so the device can be taken over long after
# the parent admitted it. These tests pin the *child-side* rule: no timed
# benchmark and no PMC profile may start on a device that fails the gate.

def test_measurement_gate_waits_then_admits(monkeypatch, tmp_path):
    from ..orchestrator import w8a8_pipeline as wp

    blocked = {"gpus": {2: {"usable": False, "util_percent": 91.0,
                            "vram_percent": 10.0,
                            "reasons": ["device busy: HCU 91.0% > 0.0%"]}}}
    ok = {"gpus": {2: {"usable": True, "util_percent": 0.0,
                       "vram_percent": 5.0, "state_source": "hy-smi"}}}
    plans = [blocked, ok]
    calls = []

    def fake_preflight(ids, **kw):
        calls.append((list(ids), kw.get("vram_limit_percent"),
                      kw.get("util_tolerance")))
        return plans.pop(0)

    sleeps = []
    monkeypatch.setattr("metainfer.tasks.dcu_kernel_auto_opt.orchestrator"
                        ".gpu_preflight.preflight_gpus", fake_preflight)
    monkeypatch.setattr(wp, "_env_flag_off", lambda env: False)
    monkeypatch.setattr(wp.time, "sleep", lambda s: sleeps.append(s))

    check = wp.ensure_measurement_gate(2, state_dir=tmp_path, wait_seconds=1800,
                                       max_waits=48, site="benchmark")
    assert check["usable"] is True
    assert sleeps == [1800]                       # exactly one 30-minute re-check
    assert calls[0][0] == [2]                     # only the assigned device
    assert calls[0][1] == 90.0 and calls[0][2] == 0.0   # the operator's gate

    rows = [json.loads(l) for l in
            (tmp_path / "measurement_gate.jsonl").read_text().splitlines()]
    assert [r["event"] for r in rows] == ["gate_blocked", "gate_ok"]
    assert rows[0]["site"] == "benchmark" and rows[0]["gpu"] == 2
    assert rows[1]["util_percent"] == 0.0


def test_measurement_gate_gives_up_after_max_waits(monkeypatch, tmp_path):
    from ..orchestrator import w8a8_pipeline as wp

    always = {"gpus": {3: {"usable": False, "util_percent": 0.0,
                           "vram_percent": 96.0,
                           "reasons": ["VRAM 96% > 90% limit"]}}}
    monkeypatch.setattr("metainfer.tasks.dcu_kernel_auto_opt.orchestrator"
                        ".gpu_preflight.preflight_gpus",
                        lambda ids, **kw: always)
    monkeypatch.setattr(wp, "_env_flag_off", lambda env: False)
    sleeps = []
    monkeypatch.setattr(wp.time, "sleep", lambda s: sleeps.append(s))

    with pytest.raises(wp.MeasurementGateBlocked) as excinfo:
        wp.ensure_measurement_gate(3, state_dir=tmp_path, wait_seconds=1800,
                                   max_waits=3)
    assert excinfo.value.gpu == 3
    assert excinfo.value.checks == 3              # 3 re-checks, then give up
    assert "VRAM 96%" in excinfo.value.gate_reason
    assert sleeps == [1800, 1800, 1800]
    rows = (tmp_path / "measurement_gate.jsonl").read_text().splitlines()
    assert len(rows) == 4                        # 3 blocked + the final blocked


def test_measurement_gate_fails_closed_when_the_probe_breaks(monkeypatch, tmp_path):
    from ..orchestrator import w8a8_pipeline as wp

    def boom(*_a, **_k):
        raise RuntimeError("hy-smi exploded")

    monkeypatch.setattr("metainfer.tasks.dcu_kernel_auto_opt.orchestrator"
                        ".gpu_preflight.preflight_gpus", boom)
    monkeypatch.setattr(wp, "_env_flag_off", lambda env: False)
    monkeypatch.setattr(wp.time, "sleep", lambda s: None)
    with pytest.raises(wp.MeasurementGateBlocked):
        wp.ensure_measurement_gate(0, state_dir=tmp_path, wait_seconds=0,
                                   max_waits=1)


def test_runner_gates_every_measurement(monkeypatch, tmp_path):
    """benchmark() and profile_pmc() both pass the gate before launching."""
    from ..orchestrator import w8a8_pipeline as wp

    gated = []
    monkeypatch.setattr(wp.W8A8Runner, "_ensure_gate",
                        lambda self, site: gated.append((self.gpu, site)))
    monkeypatch.setattr(wp.time, "sleep", lambda s: None)   # no real gate waits

    runner = object.__new__(wp.W8A8Runner)
    runner.worker_root = tmp_path
    runner.source = tmp_path
    runner.harness = tmp_path / "w8a8_bench.py"
    runner.env = {"METAINFER_GPU_PREFLIGHT": "1"}
    runner.gpu = 1
    monkeypatch.setattr(wp.W8A8Runner, "_prepare_compile_cache",
                        lambda self: {"build_key": "k"})
    monkeypatch.setattr(wp.W8A8Runner, "_ensure_reference_cache",
                        lambda self, m, n, k: None)
    monkeypatch.setattr(wp, "_run",
                        lambda *a, **k: type("R", (), {"stdout": "{}"})())
    monkeypatch.setattr(wp, "_last_json", lambda out: {})

    runner.benchmark({"M": 16, "N": 64, "K": 32})
    assert gated == [(1, "benchmark")]

    (tmp_path / "profile_pmc.sh").write_text("#!/bin/bash\n", encoding="utf-8")
    monkeypatch.setattr(wp, "parse_pmc_csv",
                        lambda path: {"available": False, "counters": {}})
    runner.profile_pmc({"M": 16, "N": 64, "K": 32}, tmp_path / "out")
    assert gated == [(1, "benchmark"), (1, "profile_pmc")]


def test_any_measurement_gate_picks_an_idle_sibling(monkeypatch, tmp_path):
    """A busy GPU 0 must not park the task while GPU 1 is free."""
    from ..orchestrator import w8a8_pipeline as wp

    plan = {"gpus": {
        0: {"usable": False, "util_percent": 98.0, "vram_percent": 97.0,
            "reasons": ["device busy: HCU 98.0% > 0.0%"]},
        1: {"usable": True, "util_percent": 0.0, "vram_percent": 5.0,
            "state_source": "sysfs"},
    }}
    calls = []
    monkeypatch.setattr(
        "metainfer.tasks.dcu_kernel_auto_opt.orchestrator.gpu_preflight"
        ".preflight_gpus",
        lambda ids, **kw: (calls.append(list(ids)), plan)[1])
    monkeypatch.setattr(wp, "_env_flag_off", lambda env: False)
    sleeps = []
    monkeypatch.setattr(wp.time, "sleep", lambda s: sleeps.append(s))

    chosen = wp.ensure_any_measurement_gate([0, 1, 2, 3], state_dir=tmp_path,
                                            wait_seconds=1800, site="probe")
    assert chosen == 1                    # an idle sibling, not the busy GPU 0
    assert sleeps == []                   # and no waiting at all
    assert calls == [[0, 1, 2, 3]]        # the whole candidate set is checked
    rows = [json.loads(l) for l in
            (tmp_path / "measurement_gate.jsonl").read_text().splitlines()]
    assert rows[0]["event"] == "gate_ok" and rows[0]["passing"] == [1]


def test_any_measurement_gate_waits_when_no_candidate_passes(monkeypatch, tmp_path):
    from ..orchestrator import w8a8_pipeline as wp

    busy = {"gpus": {d: {"usable": False, "util_percent": 99.0,
                         "vram_percent": 96.0,
                         "reasons": [f"gpu{d} VRAM 96% > 90% limit"]}
                     for d in (0, 1)}}
    monkeypatch.setattr(
        "metainfer.tasks.dcu_kernel_auto_opt.orchestrator.gpu_preflight"
        ".preflight_gpus", lambda ids, **kw: busy)
    monkeypatch.setattr(wp, "_env_flag_off", lambda env: False)
    sleeps = []
    monkeypatch.setattr(wp.time, "sleep", lambda s: sleeps.append(s))

    with pytest.raises(wp.MeasurementGateBlocked) as excinfo:
        wp.ensure_any_measurement_gate([0, 1], state_dir=tmp_path,
                                       wait_seconds=1800, max_waits=2)
    assert sleeps == [1800, 1800]         # 30-minute re-checks, then give up
    assert "gpu0" in excinfo.value.gate_reason
    assert "gpu1" in excinfo.value.gate_reason


def test_any_measurement_gate_prefers_the_tasks_own_device(monkeypatch, tmp_path):
    from ..orchestrator import w8a8_pipeline as wp

    free = {"gpus": {d: {"usable": True, "util_percent": 0.0,
                         "vram_percent": 1.0} for d in (0, 3)}}
    monkeypatch.setattr(
        "metainfer.tasks.dcu_kernel_auto_opt.orchestrator.gpu_preflight"
        ".preflight_gpus", lambda ids, **kw: free)
    monkeypatch.setattr(wp, "_env_flag_off", lambda env: False)
    # 3 is the task's own card and is free: the probe stays on it
    assert wp.ensure_any_measurement_gate([3, 0], env={"METAINFER_GPU_PREFLIGHT": "1"}) == 3


def _fake_scaffold(root):
    """A scaffold that satisfies the trusted Generate preflight file checks."""
    from ..orchestrator import gen_and_opt_pipeline as gp

    root.mkdir(parents=True, exist_ok=True)
    for name in (gp._HARNESS_FILENAME, gp.W8A8_API_FILENAME,
                 gp._GIT_ATTRIBUTES_FILE, "scaffold_manifest.json",
                 *gp._SCAFFOLD_FILES):
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("", encoding="utf-8")
    (root / "profile_pmc.sh").write_text(
        "#!/bin/bash\n/opt/dtk/bin/hipprof --pmc --pmc-type 3 "
        '"$source_dir" "$output_dir"\n', encoding="utf-8")
    return root


@requires_dtk_hipprof
def test_generate_probe_runs_on_a_device_that_passed_the_gate(monkeypatch, tmp_path):
    """The probe is gated, but not pinned to GPU 0 (a busy card must not park it)."""
    from ..orchestrator import gen_and_opt_pipeline as gp

    source = _fake_scaffold(tmp_path / "scaffold")
    contract = gp.file_digest(source / gp.W8A8_API_FILENAME)
    seen = {}

    def fake_run(cmd, **kwargs):
        if cmd[-1] == "--self-test":
            return type("R", (), {"stdout": '{"passed": true}'})()
        if cmd[-1] == "--probe":
            env = kwargs.get("env") or {}
            seen["probe_gpu"] = env.get("HIP_VISIBLE_DEVICES")
            # DTK filters twice when both variables name the same non-zero
            # index, which hides the device ("No HIP GPUs are available" on
            # GPU 1 while GPU 0 survived): binding must set HIP only.
            seen["probe_env"] = dict(env)
            return type("R", (), {"stdout": json.dumps({
                "visible_devices": 1, "cudagraph_available": True})})()
        return type("R", (), {"stdout": ""})()

    monkeypatch.setattr(gp, "_run", fake_run)
    monkeypatch.setattr(gp, "_gate_preflight_enabled", lambda: True)

    calls = []

    def fake_gate(devices, **kwargs):
        calls.append((list(devices), kwargs))
        return 1

    monkeypatch.setattr(gp, "ensure_any_measurement_gate", fake_gate)
    out = gp._validate_generate_scaffold(
        source, contract_sha256=contract, shapes={"s1": {"M": 16}},
        probe_devices=[0, 1, 2, 3], state_dir=tmp_path / "state")

    assert calls[0][0] == [0, 1, 2, 3]     # every candidate may answer
    # the wait is auditable in the task's own state dir, not silently invisible
    assert calls[0][1]["state_dir"] == tmp_path / "state"
    assert calls[0][1]["site"] == "generate_probe"
    assert seen["probe_gpu"] == "1"        # and the probe honours the choice
    assert "ROCR_VISIBLE_DEVICES" not in seen["probe_env"]
    assert out["gpu_probe"]["visible_devices"] == 1


@requires_gpu_broker
def test_probe_candidates_put_the_tasks_own_devices_first():
    from ..orchestrator import gen_and_opt_pipeline as gp

    class _Cfg:
        assignments = [type("A", (), {"gpu": 2})(), type("A", (), {"gpu": 0})()]

    devices = gp._probe_gate_devices(_Cfg())
    assert devices[:2] == [2, 0]           # the task's own cards, in order
    assert 1 in devices and 3 in devices   # then the idle siblings
    assert len(devices) == len(set(devices))
