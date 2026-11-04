"""Discover the HCU/DCU devices exposed by this machine.

The DCU task historically assumed four cards (0..3).  Newer air-cooled boards
expose eight.  This small module is the single place that answers "which card
indices may a task place work on?" so config validation, GPU binding, guidance
and the Web UI agree.

An explicit ``METAINFER_HCU_DEVICES`` wins (useful in CI / containers).  On a
real host we enumerate ``/sys/class/drm/card*/device`` and only count devices
whose driver is a known HCU driver.  When sysfs is unavailable (macOS, a
container without /sys, unit tests) we fall back to the historical four-card
layout so callers never lose the ability to bind card 0..3.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import List, Optional

DEVICES_ENV = "METAINFER_HCU_DEVICES"
DRM_ROOT = Path("/sys/class/drm")
HCU_DRM_DRIVERS = frozenset({"hycu", "amdgpu"})

_cache: Optional[List[int]] = None


def reset_cache() -> None:
    global _cache
    _cache = None


def _parse_override(raw: str) -> List[int]:
    values: List[int] = []
    for part in str(raw or "").replace(";", ",").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            value = int(part)
        except ValueError:
            continue
        if value >= 0 and value not in values:
            values.append(value)
    return values


def hcu_device_dirs() -> List[Path]:
    """Return sysfs device directories for HCU/DCU cards, ordered by index."""

    found = []
    if not DRM_ROOT.is_dir():
        return found
    for entry in DRM_ROOT.iterdir():
        if not entry.name.startswith("card"):
            continue
        suffix = entry.name[4:]
        if not suffix.isdigit():
            continue
        device = entry / "device"
        driver = device / "driver"
        try:
            driver_name = os.path.basename(os.readlink(driver))
        except OSError:
            continue
        if driver_name in HCU_DRM_DRIVERS:
            found.append((int(suffix), device))
    found.sort(key=lambda item: item[0])
    return [device for _index, device in found]


def devices() -> List[int]:
    """Card indices available on this machine (never empty)."""

    global _cache
    if _cache is not None:
        return list(_cache)
    override = os.environ.get(DEVICES_ENV)
    if override:
        parsed = _parse_override(override)
        if parsed:
            _cache = parsed
            return list(_cache)
    indices = []
    for device in hcu_device_dirs():
        try:
            indices.append(int(device.parent.name[4:]))
        except (ValueError, IndexError):
            continue
    _cache = indices or [0, 1, 2, 3]
    return list(_cache)


def count() -> int:
    return len(devices())


def is_addressable(gpu: int, allowed: Optional[list] = None) -> bool:
    try:
        value = int(gpu)
    except (TypeError, ValueError):
        return False
    if allowed is not None:
        try:
            return value in {int(item) for item in allowed}
        except (TypeError, ValueError):
            return False
    return value in devices()
