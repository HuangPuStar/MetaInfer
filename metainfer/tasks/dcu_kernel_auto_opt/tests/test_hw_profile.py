"""Tests for the hardware-profile resolver (air / liquid).

Every probe is monkeypatched, so these tests never touch a GPU, ``hy-smi`` or
``hyflash`` -- they pin the *decision logic*: agreement, conflict, fallback
order, caching, and the fail-fast behaviour at the write boundary.
"""

from __future__ import annotations

import pytest

from metainfer.orchestrator import hw_profile as hp


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    """No cached resolution, no environment leakage between tests.

    The cross-process cache is disabled by default so every test exercises the
    decision logic; the cache tests below point it at ``tmp_path`` explicitly.
    """
    hp.clear_cache()
    for name in (
        "METAINFER_HW_PROFILE",
        "METAINFER_HW_PROFILE_NO_PROBE",
        "METAINFER_HW_PROFILE_TTL",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("METAINFER_HW_PROFILE_CACHE", "off")
    yield
    hp.clear_cache()


def _patch_probes(
    monkeypatch,
    *,
    series=None,
    versions=None,
    boards=None,
    host="kme6",
    counters=None,
):
    """Install fake probes; ``counters`` records how often each one ran."""
    counts = counters if counters is not None else {}

    def _series():
        counts["series"] = counts.get("series", 0) + 1
        return series

    def _versions():
        counts["versions"] = counts.get("versions", 0) + 1
        return versions

    def _boards():
        counts["boards"] = counts.get("boards", 0) + 1
        return boards

    monkeypatch.setattr(hp, "_probe_card_series", _series)
    monkeypatch.setattr(hp, "_probe_vbios_versions", _versions)
    monkeypatch.setattr(hp, "_probe_board_types", _boards)
    monkeypatch.setattr(hp, "_hostname", lambda: host)
    return counts


# --------------------------------------------------------------------------- #
# happy paths
# --------------------------------------------------------------------------- #

def test_air_machine_resolves_from_card_series(monkeypatch):
    _patch_probes(monkeypatch, series={"K100_AI"})
    resolution = hp.resolve()
    assert resolution.profile is not None
    assert resolution.profile.id == "air-k100ai"
    assert resolution.profile.cooled == "air"
    assert resolution.source == "card-series"
    assert not resolution.conflict


def test_liquid_machine_resolves_from_card_series(monkeypatch):
    _patch_probes(monkeypatch, series={"K500SM_AI"})
    assert hp.require().id == "liquid-k500sm"
    assert hp.label() == "K500SM_AI / gfx928"


def test_air_machine_resolves_from_board_type_when_series_silent(monkeypatch):
    _patch_probes(monkeypatch, series=None, versions=None, boards={"DEV-AI"})
    resolution = hp.resolve()
    assert resolution.profile is not None
    assert resolution.profile.id == "air-k100ai"
    assert resolution.source == "board-type"


def test_liquid_machine_resolves_from_board_type(monkeypatch):
    _patch_probes(monkeypatch, series=None, versions=None, boards={"DEV-HPC"})
    assert hp.require().id == "liquid-k500sm"


def test_deep_resolution_agrees_across_probes(monkeypatch):
    _patch_probes(
        monkeypatch, series={"K100_AI"}, versions=None, boards={"DEV-AI"}
    )
    resolution = hp.resolve(deep=True)
    assert resolution.profile is not None
    assert resolution.profile.id == "air-k100ai"
    assert resolution.evidence["deep"] is True


# --------------------------------------------------------------------------- #
# conflict and consistency
# --------------------------------------------------------------------------- #

def test_mixed_board_types_are_a_conflict_not_a_guess(monkeypatch):
    """A machine mixing DEV-AI and DEV-HPC must not silently use card 0."""
    _patch_probes(monkeypatch, series=None, versions=None, boards={"DEV-AI", "DEV-HPC"})
    resolution = hp.resolve()
    assert resolution.profile is None
    with pytest.raises(hp.HardwareProfileError) as excinfo:
        hp.require()
    assert "conflict" in str(excinfo.value).lower()


def test_disagreeing_probes_are_a_conflict(monkeypatch):
    """Series says air, board type says liquid -> refuse to decide."""
    _patch_probes(monkeypatch, series={"K100_AI"}, versions=None, boards={"DEV-HPC"})
    resolution = hp.resolve(deep=True)
    assert resolution.conflict is True
    assert resolution.profile is None
    with pytest.raises(hp.HardwareProfileError):
        hp.require()


def test_mixed_card_series_is_a_conflict(monkeypatch):
    """Two card models in one machine: no single profile is right for all of it."""
    _patch_probes(monkeypatch, series={"K100_AI", "K500SM_AI"}, host="unknown-host")
    resolution = hp.resolve()
    assert resolution.profile is None
    assert resolution.conflict is True
    with pytest.raises(hp.HardwareProfileError):
        hp.require()


# --------------------------------------------------------------------------- #
# fallback order
# --------------------------------------------------------------------------- #

def test_hostname_is_a_fallback_only(monkeypatch):
    _patch_probes(monkeypatch, host="kme6")
    resolution = hp.resolve()
    assert resolution.profile is not None
    assert resolution.profile.id == "air-k100ai"
    assert resolution.source == "hostname"


def test_hostname_never_overrides_a_probe(monkeypatch):
    """A liquid card on a host named kme6 is liquid: probes win."""
    _patch_probes(monkeypatch, series={"K500SM_AI"}, host="kme6")
    assert hp.require().id == "liquid-k500sm"


def test_unregistered_hardware_is_unresolved_and_fails_fast(monkeypatch):
    _patch_probes(monkeypatch, series={"SOMETHING_NEW"}, host="new-host")
    resolution = hp.resolve()
    assert resolution.profile is None
    assert hp.profile_id() is None
    assert hp.label() == "Other DCU"  # never another machine's label
    with pytest.raises(hp.HardwareProfileError) as excinfo:
        hp.require()
    assert "METAINFER_HW_PROFILE" in str(excinfo.value)  # tells you the way out


# --------------------------------------------------------------------------- #
# environment knobs
# --------------------------------------------------------------------------- #

def test_env_override_short_circuits_probing(monkeypatch):
    counts = _patch_probes(monkeypatch, series={"K100_AI"})
    monkeypatch.setenv("METAINFER_HW_PROFILE", "liquid-k500sm")
    resolution = hp.resolve()
    assert resolution.profile is not None
    assert resolution.profile.id == "liquid-k500sm"
    assert resolution.source == "env-override"
    assert counts == {}  # no probe was needed


def test_unknown_env_override_is_a_config_error(monkeypatch):
    _patch_probes(monkeypatch, series={"K100_AI"})
    monkeypatch.setenv("METAINFER_HW_PROFILE", "not-a-profile")
    with pytest.raises(hp.HardwareProfileError):
        hp.resolve()


def test_no_probe_mode_uses_hostname_then_gives_up(monkeypatch):
    counts = _patch_probes(monkeypatch, series={"K100_AI"})
    monkeypatch.setenv("METAINFER_HW_PROFILE_NO_PROBE", "1")
    assert hp.require().id == "air-k100ai"
    assert counts == {}


def test_no_probe_mode_on_an_unknown_host_is_unresolved(monkeypatch):
    _patch_probes(monkeypatch, host="ci-runner")
    monkeypatch.setenv("METAINFER_HW_PROFILE_NO_PROBE", "1")
    assert hp.resolve().profile is None


# --------------------------------------------------------------------------- #
# cost guarantees (the reason deep probing is opt-in)
# --------------------------------------------------------------------------- #

def test_default_resolution_never_runs_the_slow_board_probe(monkeypatch):
    """hyflash costs ~8.5 s per card; the hot path must not call it."""
    counts = _patch_probes(monkeypatch, series={"K100_AI"})
    hp.resolve()
    assert counts.get("boards", 0) == 0


def test_resolution_is_cached(monkeypatch):
    counts = _patch_probes(monkeypatch, series={"K100_AI"})
    hp.resolve()
    hp.resolve()
    hp.resolve()
    assert counts.get("series") == 1


def test_refresh_bypasses_the_cache(monkeypatch):
    counts = _patch_probes(monkeypatch, series={"K100_AI"})
    hp.resolve()
    hp.resolve(refresh=True)
    assert counts.get("series") == 2


# --------------------------------------------------------------------------- #
# VBIOS -> firmware line mapping (pure logic, against a fake inventory)
# --------------------------------------------------------------------------- #

def test_firmware_line_mapping(tmp_path, monkeypatch):
    ai_dir = tmp_path / "ZD"
    ai_dir.mkdir()
    (ai_dir / "K100_AI-5.719.001200r.710209.bin").write_bytes(b"")
    (ai_dir / "hpc-5.719.001000p.710209.bin").write_bytes(b"")
    monkeypatch.setattr(hp, "VBIOS_INVENTORY", tmp_path)

    assert hp._firmware_line_for({"5.719.001200r.710209"}) == "ai"
    assert hp._firmware_line_for({"5.719.001000p.710209"}) == "hpc"
    # Unknown, ambiguous and empty inputs never invent an answer.
    assert hp._firmware_line_for({"9.9.9.9"}) is None
    assert hp._firmware_line_for({"5.719.001200r.710209", "5.719.001000p.710209"}) is None
    assert hp._firmware_line_for(None) is None


def test_vbios_line_reaches_the_profile(monkeypatch, tmp_path):
    ai_dir = tmp_path / "ZD"
    ai_dir.mkdir()
    (ai_dir / "K100_AI-5.719.001200r.710209.bin").write_bytes(b"")
    monkeypatch.setattr(hp, "VBIOS_INVENTORY", tmp_path)
    _patch_probes(monkeypatch, series=None, versions={"5.719.001200r.710209"})
    resolution = hp.resolve()
    assert resolution.profile is not None
    assert resolution.profile.id == "air-k100ai"
    assert resolution.source == "firmware-line"
    assert resolution.evidence["firmware_line"] == "ai"


# --------------------------------------------------------------------------- #
# cross-process cache (probes cost seconds on a busy shared machine)
# --------------------------------------------------------------------------- #

def test_file_cache_is_written_and_reused(tmp_path, monkeypatch):
    cache = tmp_path / "hw.json"
    monkeypatch.setenv("METAINFER_HW_PROFILE_CACHE", str(cache))
    counts = _patch_probes(monkeypatch, series={"K100_AI"})
    first = hp.resolve()
    assert first.profile is not None and cache.is_file()
    assert counts.get("series") == 1

    # A fresh process (no in-process cache) must not pay for the probes again.
    hp.clear_cache()
    _patch_probes(monkeypatch, series=None, host="kme6")
    second = hp.resolve()
    assert second.profile is not None
    assert second.profile.id == "air-k100ai"
    assert second.source.endswith("+file-cache")


def test_file_cache_is_ignored_for_another_host(tmp_path, monkeypatch):
    cache = tmp_path / "hw.json"
    monkeypatch.setenv("METAINFER_HW_PROFILE_CACHE", str(cache))
    _patch_probes(monkeypatch, series={"K100_AI"}, host="kme6")
    hp.resolve()
    assert cache.is_file()

    hp.clear_cache()
    _patch_probes(monkeypatch, series=None, host="some-other-box")
    assert hp.resolve().profile is None  # the kme6 cache must not leak


def test_file_cache_respects_ttl(tmp_path, monkeypatch):
    cache = tmp_path / "hw.json"
    monkeypatch.setenv("METAINFER_HW_PROFILE_CACHE", str(cache))
    _patch_probes(monkeypatch, series={"K100_AI"})
    hp.resolve()

    hp.clear_cache()
    monkeypatch.setenv("METAINFER_HW_PROFILE_TTL", "0")
    counts = _patch_probes(monkeypatch, series=None, host="kme6")
    resolution = hp.resolve()
    # The expired entry must not answer: probes run again (here they answer
    # nothing, so the hostname fallback decides).
    assert "file-cache" not in resolution.source
    assert counts.get("series") == 1
    assert resolution.source == "hostname"


def test_refresh_bypasses_the_file_cache(tmp_path, monkeypatch):
    cache = tmp_path / "hw.json"
    monkeypatch.setenv("METAINFER_HW_PROFILE_CACHE", str(cache))
    _patch_probes(monkeypatch, series={"K100_AI"})
    hp.resolve()

    hp.clear_cache()
    counts = _patch_probes(monkeypatch, series={"K500SM_AI"}, host="kme6")
    assert hp.resolve(refresh=True).profile.id == "liquid-k500sm"
    assert counts.get("series") == 1


def test_cache_off_disables_the_file(tmp_path, monkeypatch):
    cache = tmp_path / "hw.json"
    monkeypatch.setenv("METAINFER_HW_PROFILE_CACHE", "off")
    _patch_probes(monkeypatch, series={"K100_AI"})
    hp.resolve()
    assert not cache.exists()


# --------------------------------------------------------------------------- #
# vendor-tool quirks (regressions we already paid for once)
# --------------------------------------------------------------------------- #

class _FakeCompleted:
    def __init__(self, stdout: str, returncode: int):
        self.stdout = stdout
        self.stderr = ""
        self.returncode = returncode


def test_run_accepts_nonzero_exit_with_output(monkeypatch):
    """``hyflash --version`` exits 255 on SUCCESS (measured on kme6).

    Treating a non-zero exit as failure made the authoritative board-type check
    silently do nothing, so this pins the tolerant behaviour.
    """
    monkeypatch.setattr(
        hp.subprocess,
        "run",
        lambda *a, **k: _FakeCompleted("Board hardware type : DEV-AI\n", 255),
    )
    assert hp._run(["hyflash"], timeout=1) == "Board hardware type : DEV-AI\n"


def test_run_returns_none_when_the_tool_says_nothing(monkeypatch):
    monkeypatch.setattr(
        hp.subprocess, "run", lambda *a, **k: _FakeCompleted("", 0)
    )
    assert hp._run(["hy-smi"], timeout=1) is None


def test_board_types_parses_a_255_exit(monkeypatch):
    """The whole probe path, with the real 255 exit code and real output shape."""
    output = (
        "HyFlash version 1.5.0-k100\n"
        "\tVBios Version                    : 5.719.001200r.710209\n"
        "\tBoard hardware type              : DEV-AI        \n"
    )
    monkeypatch.setattr(hp.os, "access", lambda *a, **k: True)
    monkeypatch.setattr(
        hp.subprocess, "run", lambda *a, **k: _FakeCompleted(output, 255)
    )
    assert hp._probe_board_types() == {"DEV-AI"}


# --------------------------------------------------------------------------- #
# record snapshot
# --------------------------------------------------------------------------- #

def test_snapshot_carries_profile_machine_and_source(monkeypatch):
    _patch_probes(monkeypatch, series={"K100_AI"}, host="kme6")
    snap = hp.snapshot()
    assert snap["hw_profile"] == "air-k100ai"
    assert snap["machine"] == "kme6"
    assert snap["hw_source"] == "card-series"
    assert snap["resolved_at"]


def test_snapshot_marks_unknown_instead_of_guessing(monkeypatch):
    _patch_probes(monkeypatch, host="mystery-host")
    assert hp.snapshot()["hw_profile"] == "unknown"
