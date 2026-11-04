"""Resolve the physical MetaInfer hardware profile (air / liquid board).

Probing is deliberately layered and fail-closed: a disagreement between an
authoritative card series, a VBIOS firmware line and the board type is a
conflict, never a guess.  The hot path avoids ``hyflash`` (the board-type probe
costs seconds per card); it is only used as a fallback or when ``deep=True``.
"""

from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Optional, Set

VBIOS_INVENTORY = Path("/opt/hyhal/firmware")
PROFILE_ENV = "METAINFER_HW_PROFILE"
NO_PROBE_ENV = "METAINFER_HW_PROFILE_NO_PROBE"
CACHE_ENV = "METAINFER_HW_PROFILE_CACHE"
TTL_ENV = "METAINFER_HW_PROFILE_TTL"
DEFAULT_TTL_SECONDS = 3600


class HardwareProfileError(RuntimeError):
    """The machine's profile could not be established safely."""


@dataclass(frozen=True)
class HardwareProfile:
    id: str
    cooled: str
    card_series: str
    label: str


PROFILES: Dict[str, HardwareProfile] = {
    "air-k100ai": HardwareProfile("air-k100ai", "air", "K100_AI", "K100_AI / gfx928"),
    "liquid-k500sm": HardwareProfile("liquid-k500sm", "liquid", "K500SM_AI", "K500SM_AI / gfx928"),
}

_SERIES_TO_PROFILE = {
    "K100_AI": "air-k100ai",
    "K100": "air-k100ai",
    "K500SM_AI": "liquid-k500sm",
    "K500SM": "liquid-k500sm",
}
_BOARD_TO_PROFILE = {
    "DEV-AI": "air-k100ai",
    "DEV-HPC": "liquid-k500sm",
}
_HOST_PROFILES = {"kme6": "air-k100ai"}

_CACHE: Optional["Resolution"] = None


@dataclass
class Resolution:
    profile: Optional[HardwareProfile]
    machine: str
    source: str
    conflict: bool = False
    evidence: Dict[str, Any] = field(default_factory=dict)
    resolved_at: float = field(default_factory=time.time)


def clear_cache() -> None:
    global _CACHE
    _CACHE = None


def _run(argv, timeout: float = 20.0) -> Optional[str]:
    try:
        completed = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    out = completed.stdout or ""
    # hyflash --version exits 255 on success; non-empty output is authoritative.
    return out if out.strip() else None


def _hostname() -> str:
    try:
        return socket.gethostname().strip()
    except OSError:
        return ""


def _probe_card_series() -> Optional[Set[str]]:
    output = _run(["hy-smi", "--showproductname"])
    if not output:
        return None
    found = set()
    for line in output.splitlines():
        for series in _SERIES_TO_PROFILE:
            if series.lower() in line.lower():
                found.add(series)
    return found or None


def _probe_vbios_versions() -> Optional[Set[str]]:
    output = _run(["hyflash", "--version"])
    if not output:
        return None
    found = set(re.findall(r"\b\d+\.\d+\.\d+[a-zA-Z]?\.\d+\b", output))
    return found or None


def _probe_board_types() -> Optional[Set[str]]:
    executable = "/opt/hyhal/bin/hyflash"
    if not os.access(executable, os.X_OK):
        return None
    output = _run([executable], timeout=30.0)
    if not output:
        return None
    found = set(re.findall(r"Board hardware type\s*:\s*(\S+)", output))
    normalized = {item.strip() for item in found if item.strip()}
    return normalized or None


def _firmware_line_for(versions: Optional[Set[str]]) -> Optional[str]:
    if not versions:
        return None
    lines: Set[str] = set()
    try:
        files = list(VBIOS_INVENTORY.rglob("*.bin"))
    except OSError:
        files = []
    for path in files:
        name = path.name.lower()
        if not any(version.lower() in name for version in versions):
            continue
        if "k100_ai" in name or name.startswith("ai-"):
            lines.add("ai")
        elif "hpc" in name:
            lines.add("hpc")
    if len(lines) == 1:
        return next(iter(lines))
    return None


def _profile_for_series(series: Optional[Set[str]]) -> Optional[HardwareProfile]:
    if not series:
        return None
    ids = {_SERIES_TO_PROFILE[item] for item in series if item in _SERIES_TO_PROFILE}
    if len(ids) == 1:
        return PROFILES[next(iter(ids))]
    return None


def _profile_for_board(boards: Optional[Set[str]]) -> Optional[HardwareProfile]:
    if not boards:
        return None
    ids = {_BOARD_TO_PROFILE[item] for item in boards if item in _BOARD_TO_PROFILE}
    if len(ids) == 1:
        return PROFILES[next(iter(ids))]
    return None


def _cache_file() -> Optional[Path]:
    value = os.environ.get(CACHE_ENV, "")
    if not value or value.strip().lower() == "off":
        return None
    return Path(value).expanduser()


def _ttl_seconds() -> float:
    raw = os.environ.get(TTL_ENV)
    if raw is None or raw == "":
        return DEFAULT_TTL_SECONDS
    try:
        return max(0.0, float(raw))
    except ValueError:
        return DEFAULT_TTL_SECONDS


def _read_file_cache(machine: str) -> Optional[Resolution]:
    path = _cache_file()
    if path is None or not path.is_file():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(raw, dict) or raw.get("machine") != machine:
        return None
    profile_id = raw.get("profile")
    if profile_id not in PROFILES:
        return None
    created = float(raw.get("resolved_at") or 0)
    if time.time() - created > _ttl_seconds():
        return None
    return Resolution(
        profile=PROFILES[profile_id],
        machine=machine,
        source=str(raw.get("source") or "file-cache") + "+file-cache",
        conflict=False,
        evidence=dict(raw.get("evidence") or {}),
        resolved_at=created,
    )


def _write_file_cache(resolution: Resolution) -> None:
    path = _cache_file()
    if path is None or resolution.profile is None:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "machine": resolution.machine,
            "profile": resolution.profile.id,
            "source": resolution.source,
            "evidence": resolution.evidence,
            "resolved_at": resolution.resolved_at,
        }
        tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)
    except OSError:
        return


def _hostname_resolution(machine: str, source: str = "hostname") -> Resolution:
    profile = PROFILES.get(_HOST_PROFILES.get(machine, ""))
    return Resolution(
        profile=profile,
        machine=machine,
        source=source,
        conflict=False,
        evidence={"hostname": machine},
    )


def resolve(*, deep: bool = False, refresh: bool = False) -> Resolution:
    global _CACHE
    if _CACHE is not None and not refresh:
        return _CACHE
    machine = _hostname()

    override = str(os.environ.get(PROFILE_ENV) or "").strip()
    if override:
        if override not in PROFILES:
            raise HardwareProfileError(
                f"unknown {PROFILE_ENV}={override!r}; choose one of {', '.join(sorted(PROFILES))}"
            )
        resolution = Resolution(
            profile=PROFILES[override],
            machine=machine,
            source="env-override",
            evidence={"env": override},
        )
        _CACHE = resolution
        return resolution

    if not refresh:
        cached = _read_file_cache(machine)
        if cached is not None:
            _CACHE = cached
            return cached

    if os.environ.get(NO_PROBE_ENV):
        resolution = _hostname_resolution(machine)
        _CACHE = resolution
        return resolution

    series = _probe_card_series()
    versions = _probe_vbios_versions()
    if series and len(series) > 1:
        resolution = Resolution(
            profile=None,
            machine=machine,
            source="card-series",
            conflict=True,
            evidence={"series": sorted(series)},
        )
        _CACHE = resolution
        return resolution

    series_profile = _profile_for_series(series)
    firmware_line = _firmware_line_for(versions)
    firmware_profile = (
        PROFILES["air-k100ai"] if firmware_line == "ai"
        else PROFILES["liquid-k500sm"] if firmware_line == "hpc"
        else None
    )

    boards: Optional[Set[str]] = None
    if deep or (series_profile is None and firmware_profile is None):
        boards = _probe_board_types()
    board_profile = _profile_for_board(boards)

    board_ids = {_BOARD_TO_PROFILE[item] for item in (boards or set()) if item in _BOARD_TO_PROFILE}
    if len(board_ids) > 1:
        resolution = Resolution(
            profile=None,
            machine=machine,
            source="board-type",
            conflict=True,
            evidence={"boards": sorted(boards or set())},
        )
        _CACHE = resolution
        return resolution

    candidates = [profile for profile in (series_profile, firmware_profile, board_profile) if profile is not None]
    if len({profile.id for profile in candidates}) > 1:
        resolution = Resolution(
            profile=None,
            machine=machine,
            source="probe-conflict",
            conflict=True,
            evidence={
                "series": sorted(series or set()),
                "firmware_line": firmware_line,
                "boards": sorted(boards or set()),
            },
        )
        _CACHE = resolution
        return resolution

    if candidates:
        profile = candidates[0]
        if profile is series_profile:
            source = "card-series"
        elif profile is firmware_profile:
            source = "firmware-line"
        else:
            source = "board-type"
        resolution = Resolution(
            profile=profile,
            machine=machine,
            source=source,
            conflict=False,
            evidence={
                "series": sorted(series or set()),
                "firmware_line": firmware_line,
                "boards": sorted(boards or set()),
                "deep": bool(deep),
            },
        )
    else:
        resolution = _hostname_resolution(machine)

    _CACHE = resolution
    if resolution.profile is not None:
        _write_file_cache(resolution)
    return resolution


def require() -> HardwareProfile:
    resolution = resolve()
    if resolution.profile is None:
        if resolution.conflict:
            raise HardwareProfileError(
                "hardware profile conflict; refusing to guess. "
                f"Set {PROFILE_ENV}=air-k100ai or liquid-k500sm explicitly."
            )
        raise HardwareProfileError(
            "hardware profile could not be determined; "
            f"set {PROFILE_ENV}=air-k100ai or liquid-k500sm explicitly."
        )
    return resolution.profile


def profile_id() -> Optional[str]:
    profile = resolve().profile
    return profile.id if profile is not None else None


def label(fallback: str = "Other DCU") -> str:
    profile = resolve().profile
    return profile.label if profile is not None else fallback


def snapshot() -> Dict[str, Any]:
    resolution = resolve()
    return {
        "hw_profile": resolution.profile.id if resolution.profile is not None else "unknown",
        "machine": resolution.machine,
        "hw_source": resolution.source,
        "resolved_at": resolution.resolved_at,
        "conflict": resolution.conflict,
        "evidence": resolution.evidence,
    }
