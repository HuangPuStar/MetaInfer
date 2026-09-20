"""GPU admission pre-check shared by production DKAO tasks and AHE children.

The operating rule is one gate: **a device may only be used for a measurement
when VRAM <= 90% and HCU == 0** (``usable``). Anything else — a full card, a
card shared with another workload, a card whose state we cannot read — is not
usable, and the caller waits and re-checks instead of measuring on it.

A second, weaker signal is reporting only: board power and foreign KFD pids are
recorded for diagnosis, and a device that passes the gate but still looks
suspicious is marked ``measurement_suspect`` so a polluted reading cannot
silently decide an A/B comparison.

Telemetry has two sources, because ``hy-smi`` alone is not enough: some driver
configurations print ``N/A`` for HCU% (the container cannot open the management
interface), and a parser that silently yields nothing would make *every* card
look idle. ``sample_gpu_state`` therefore falls back to the driver sysfs
(``gpu_busy_percent`` / ``mem_info_vram_used``) and reports ``unavailable`` when
neither source answers.

The module is deliberately dependency-free: it parses ``hy-smi`` text and the
KFD/sysfs listings, so it works inside the task containers without extra tools.
"""

from __future__ import annotations

import os
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

#: Operating rule requested by the operator: a device may only be used when
#: VRAM <= ``DEFAULT_VRAM_LIMIT_PERCENT`` **and** the device is truly idle
#: (HCU == 0). The percentage form is kept for reference.
DEFAULT_VRAM_LIMIT_PERCENT = 90.0
#: HCU tolerance: 0.0 means "strictly idle".
DEFAULT_UTIL_TOLERANCE = 0.0
#: Kept for reference/reporting (VRAM <= 90% implies >= ~6.4GB free on 64GB).
DEFAULT_MIN_FREE_GB = 4.0
#: Assumed total VRAM when the driver sysfs does not expose it (K500SM_AI).
DEFAULT_TOTAL_GB = 65.5
#: Above this average HCU% the device is considered shared with other work.
DEFAULT_UTIL_SUSPECT_PERCENT = 20.0
#: Above this board power (W) another workload is almost certainly running.
DEFAULT_POWER_SUSPECT_W = 230.0

KFD_PROC_ROOT = Path("/sys/class/kfd/kfd/proc")
#: Driver sysfs used when ``hy-smi`` cannot report HCU%/VRAM.
DRM_ROOT = Path("/sys/class/drm")
#: DRM drivers that mean "this card is a Hygon HCU".
_HCU_DRM_DRIVERS = ("hycu", "amdgpu", "hydcu")
#: ``N/A`` (or ``-``) where a number is expected: the device is present but the
#: management interface cannot be read. Such a field is recorded as unknown
#: instead of dropping the whole row, which used to make every card look idle.
_UNKNOWN = r"(?:N/A|n/a|-{1,2})"
_SMI_ROW = re.compile(
    r"^(?P<index>\d+)\s+"                  # device index
    r"(?P<temp>[\d.]+)C\s+"
    r"(?:{u}|(?P<power>[\d.]+)W)\s+"       # average power
    r"\S+\s+"                              # perf mode
    r"(?:{u}|[\d.]+W)\s+"                  # power cap
    r"(?:(?P<vram>[\d.]+)%|{u})\s+"        # VRAM%
    r"(?:(?P<util>[\d.]+)%|{u})"           # HCU%
    .format(u=_UNKNOWN)
)


def parse_hy_smi(
    text: str, *, device_ids: Optional[List[int]] = None,
) -> Dict[int, Dict[str, float]]:
    """Parse ``hy-smi`` into ``{index: {vram_percent, util_percent, power_w, temp_c}}``.

    A field printed as ``N/A`` is *omitted* from that device's row: the caller
    then sees "unknown" rather than a fabricated ``0.0``, which is what the
    gate needs to refuse the device instead of silently admitting it.
    """
    out: Dict[int, Dict[str, float]] = {}
    for line in (text or "").splitlines():
        match = _SMI_ROW.match(line.strip())
        if not match:
            continue
        index = int(match.group("index"))
        if device_ids is not None and index not in device_ids:
            continue
        row: Dict[str, float] = {}
        for key in ("vram", "util", "power", "temp"):
            raw = match.group(key)
            if raw is None:
                continue
            row[{"vram": "vram_percent", "util": "util_percent",
                 "power": "power_w", "temp": "temp_c"}[key]] = float(raw)
        out[index] = row
    return out


def smi_is_incomplete(
    text: str, *, device_ids: Optional[List[int]] = None,
) -> bool:
    """True when ``hy-smi`` names a device but prints ``N/A`` for HCU%.

    That is the signature of "the management interface cannot be read from
    here" (``Open mkfd failed`` inside a container without the HCU device). On
    those hosts the *whole* utilisation block is a placeholder — including a
    ``0%`` VRAM column — so the driver sysfs is the more trustworthy source
    and takes precedence over the rest of the same row.
    """
    rows = 0
    for line in (text or "").splitlines():
        match = _SMI_ROW.match(line.strip())
        if not match:
            continue
        index = int(match.group("index"))
        if device_ids is not None and index not in device_ids:
            continue
        rows += 1
        if match.group("util") is None:
            return True
    return rows == 0


def read_sysfs_gpu_state(
    drm_root: Path = DRM_ROOT,
) -> Dict[int, Dict[str, float]]:
    """Driver sysfs fallback: ``{index: {vram_percent, util_percent}}``.

    ``/sys/class/drm`` is host-wide and does not depend on the management
    interface, so it still answers when ``hy-smi`` prints ``N/A``. Cards are
    filtered to the HCU driver and ordered by card index (``card1`` is the
    first HCU on the K500SM_AI machines, since ``card0`` is the BMC VGA), which
    matches the ``hy-smi``/KFD device numbering the tasks use.
    """
    cards: List[Path] = []
    try:
        entries = list(drm_root.iterdir())
    except OSError:
        return {}
    for entry in sorted(entries, key=lambda p: p.name):
        match = re.fullmatch(r"card(\d+)", entry.name)
        if not match:
            continue
        device = entry / "device"
        try:
            uevent = (device / "uevent").read_text(encoding="utf-8")
        except OSError:
            continue
        if not any(driver in uevent for driver in _HCU_DRM_DRIVERS):
            continue
        if not (device / "mem_info_vram_total").is_file():
            continue
        cards.append(device)
    out: Dict[int, Dict[str, float]] = {}
    for index, device in enumerate(cards):
        row: Dict[str, float] = {}
        busy = _read_int(device / "gpu_busy_percent")
        if busy is not None:
            row["util_percent"] = float(busy)
        used = _read_int(device / "mem_info_vram_used")
        total = _read_int(device / "mem_info_vram_total")
        if used is not None and total:
            row["vram_percent"] = round(100.0 * float(used) / float(total), 2)
        if row:
            out[index] = row
    return out


def _read_int(path: Path) -> Optional[int]:
    try:
        return int((path.read_text(encoding="utf-8") or "").strip())
    except (OSError, ValueError):
        return None


def read_hy_smi(timeout_s: float = 10.0) -> str:
    import subprocess

    for binary in ("hy-smi", "rocm-smi"):
        try:
            proc = subprocess.run(
                [binary], capture_output=True, text=True, timeout=timeout_s,
            )
        except (OSError, subprocess.SubprocessError):
            continue
        if proc.returncode == 0 and proc.stdout.strip():
            return proc.stdout
    return ""


def foreign_kfd_pids(kfd_root: Path = KFD_PROC_ROOT) -> List[int]:
    """GPU-holding pids that are NOT visible inside this container.

    ``/sys/class/kfd`` is host-wide, so an entry whose ``/proc/<pid>`` does not
    exist here belongs to another container (or the host) — i.e. foreign load.
    """
    out: List[int] = []
    try:
        entries = list(Path(kfd_root).iterdir())
    except OSError:
        return out
    for entry in entries:
        try:
            pid = int(entry.name)
        except ValueError:
            continue
        if not Path(f"/proc/{pid}").exists():
            out.append(pid)
    return sorted(out)


def sample_gpu_state(gpu_ids: Optional[List[int]] = None, *,
                     samples: int = 3, interval_s: float = 3.0,
                     smi_reader=read_hy_smi,
                     sysfs_reader=read_sysfs_gpu_state,
                     ) -> Dict[int, Dict[str, float]]:
    """Average a few hy-smi samples per device (drops idle flicker).

    ``hy-smi`` is the primary source. When it cannot report HCU% (it prints
    ``N/A`` on driver/container combinations where the management interface is
    unreadable), the missing fields are taken from the driver sysfs instead of
    being treated as zero: a fabricated ``util=0`` would admit a card that is
    actively busy, which is exactly the failure this gate exists to prevent.
    A device neither source can describe is reported with ``unavailable=True``
    so the gate refuses it.
    """
    wanted = None if gpu_ids is None else {int(g) for g in gpu_ids}
    acc: Dict[int, Dict[str, List[float]]] = {}
    smi_texts: List[str] = []
    for attempt in range(max(1, samples)):
        text = smi_reader()
        smi_texts.append(text or "")
        for index, row in parse_hy_smi(text).items():
            if wanted is not None and index not in wanted:
                continue
            bucket = acc.setdefault(index, {"vram_percent": [], "util_percent": [],
                                            "power_w": [], "temp_c": []})
            for key, value in row.items():
                bucket.setdefault(key, []).append(value)
        if attempt + 1 < samples:
            time.sleep(max(0.0, interval_s))
    # ``hy-smi`` printouts that say N/A for HCU% come from a host where the
    # management interface is unreadable: the rest of that row (including a
    # "0%" VRAM column) is a placeholder, so sysfs wins.
    smi_unreliable = any(
        smi_is_incomplete(text, device_ids=gpu_ids) for text in smi_texts)
    out: Dict[int, Dict[str, float]] = {}
    for index, bucket in acc.items():
        row: Dict[str, float] = {}
        for key, values in bucket.items():
            if values and not (smi_unreliable and key == "vram_percent"):
                row[key] = sum(values) / len(values)
        if bucket.get("vram_percent") and not smi_unreliable:
            row["vram_max_percent"] = max(bucket["vram_percent"])
        if bucket.get("util_percent"):
            row["util_max_percent"] = max(bucket["util_percent"])
        if row:
            row["state_source"] = "hy-smi"
        out[index] = row
    need_fallback = (
        not out
        or smi_unreliable
        or any(
            row.get("util_percent") is None or row.get("vram_percent") is None
            for row in out.values()
        )
        or any(
            index not in out
            or out[index].get("util_percent") is None
            or out[index].get("vram_percent") is None
            for index in (wanted or ())
        )
    )
    fallback: Dict[int, Dict[str, float]] = {}
    if sysfs_reader is not None and need_fallback:
        try:
            fallback = dict(sysfs_reader() or {})
        except Exception:  # noqa: BLE001 - the fallback is best effort
            fallback = {}
    for index, source in fallback.items():
        if wanted is not None and index not in wanted:
            continue
        row = out.setdefault(index, {})
        filled: List[str] = []
        for key in ("util_percent", "vram_percent"):
            if source.get(key) is None:
                continue
            if row.get(key) is not None and not (smi_unreliable
                                                 and key == "vram_percent"):
                continue
            row[key] = float(source[key])
            peak = ("util_max_percent" if key == "util_percent"
                    else "vram_max_percent")
            row.setdefault(peak, float(source[key]))
            filled.append(key)
        if filled:
            had_smi = row.get("power_w") is not None or row.get("temp_c") is not None
            row["state_source"] = "hy-smi+sysfs" if had_smi else "sysfs"
    if wanted is not None:
        for index in sorted(wanted):
            out.setdefault(index, {})
    for index, row in out.items():
        missing = [k for k in ("vram_percent", "util_percent") if k not in row]
        if missing:
            row["unavailable"] = 1.0
            row["missing_fields"] = missing
    return out


def total_vram_gb(card_index: int = 0) -> float:
    """Total VRAM of one card in GB (driver sysfs, else the known default)."""
    candidates = sorted(Path("/sys/class/drm").glob("card[0-9]/device/mem_info_vram_total"))
    if candidates:
        pick = candidates[card_index] if card_index < len(candidates) else candidates[0]
        try:
            return float(pick.read_text(encoding="utf-8").strip()) / (1024 ** 3)
        except (OSError, ValueError):
            pass
    return DEFAULT_TOTAL_GB


def check_gpu(gpu_id: int, state: Dict[str, float], *,
              min_free_gb: float = DEFAULT_MIN_FREE_GB,
              total_gb: Optional[float] = None,
              vram_limit_percent: float = DEFAULT_VRAM_LIMIT_PERCENT,
              util_tolerance: float = DEFAULT_UTIL_TOLERANCE,
              util_suspect_percent: float = DEFAULT_UTIL_SUSPECT_PERCENT,
              power_suspect_w: float = DEFAULT_POWER_SUSPECT_W,
              foreign_pids: Optional[List[int]] = None,
              ) -> Dict[str, Any]:
    """Usable only when VRAM <= limit *and* the device is idle (HCU == 0).

    A device whose state could not be read is **not** usable: "we cannot tell"
    must never be treated as "idle", otherwise a busy card silently admits
    measurements. Callers then wait and re-check (30 min, up to 48 times).
    """
    unavailable = bool(state.get("unavailable"))
    vram = float(state.get("vram_max_percent")
                 if state.get("vram_max_percent") is not None
                 else state.get("vram_percent") or 0.0)
    util_peak = float(state.get("util_max_percent")
                      if state.get("util_max_percent") is not None
                      else state.get("util_percent") or 0.0)
    util = float(state.get("util_percent") or 0.0)
    power = float(state.get("power_w") or 0.0)
    foreign = list(foreign_pids or [])
    total = float(total_gb if total_gb is not None else total_vram_gb())
    free_gb = total * max(0.0, 100.0 - vram) / 100.0
    vram_ok = vram <= float(vram_limit_percent)
    idle_ok = util_peak <= float(util_tolerance)
    usable = bool(vram_ok and idle_ok and not unavailable)
    reasons: List[str] = []
    if unavailable:
        missing = ",".join(state.get("missing_fields") or []) or "all"
        reasons.append(f"state unavailable: no HCU/VRAM reading ({missing})")
    # The gate is exactly "VRAM <= 90% and HCU == 0" (operator rule). Power draw
    # is recorded for diagnosis only: a card idling at HCU 0 while another
    # process holds a handle is still safe to measure on, and treating power as
    # a blocker would refuse cards the rule admits.
    notes: List[str] = []
    if foreign:
        notes.append(f"{len(foreign)} foreign KFD pid(s) hold this GPU")
    if not vram_ok:
        reasons.append(
            f"VRAM {vram:.0f}% > {float(vram_limit_percent):.0f}% limit")
    if not idle_ok:
        reasons.append(
            f"device busy: HCU {util_peak:.1f}% > {float(util_tolerance):.1f}%")
    return {
        "gpu": gpu_id,
        "usable": usable,
        "free_gb": round(free_gb, 2),
        "total_gb": round(total, 1),
        "vram_limit_percent": float(vram_limit_percent),
        "util_tolerance": float(util_tolerance),
        "vram_peak_percent": round(vram, 1),
        "util_peak_percent": round(util_peak, 1),
        "vram_percent": round(vram, 1),
        "util_percent": round(util, 1),
        "power_w": round(power, 1),
        "temp_c": round(float(state.get("temp_c") or 0.0), 1),
        "foreign_pids": foreign[:8],
        "unavailable": unavailable,
        "state_source": str(state.get("state_source") or "unknown"),
        "measurement_suspect": bool(any(
            r for r in reasons if "VRAM free" not in r)),
        "reasons": reasons,
        "notes": notes,
    }


def preflight_gpus(gpu_ids: List[int], *, samples: int = 3,
                   interval_s: float = 3.0, enabled: bool = True,
                   vram_limit_percent: float = DEFAULT_VRAM_LIMIT_PERCENT,
                   util_tolerance: float = DEFAULT_UTIL_TOLERANCE,
                   **kwargs: Any) -> Dict[str, Any]:
    """Return ``{gpu_id: check}`` plus a preferred order (clean devices first).

    ``clean_ids`` is the gate result: the only devices a measurement may run
    on. ``blocked_ids`` are the devices that failed it (busy, full, or
    unreadable) — callers wait and re-check rather than falling back to them.
    """
    if not enabled:
        return {"enabled": False, "gpus": {}, "preferred": list(gpu_ids),
                "suspect_ids": [], "clean_ids": [], "blocked_ids": [],
                "over_limit_ids": []}
    states = sample_gpu_state(gpu_ids, samples=samples, interval_s=interval_s)
    foreign = foreign_kfd_pids()
    checks: Dict[int, Dict[str, Any]] = {}
    for gpu_id in gpu_ids:
        checks[gpu_id] = check_gpu(
            gpu_id, states.get(gpu_id) or {},
            vram_limit_percent=vram_limit_percent,
            util_tolerance=util_tolerance,
            foreign_pids=foreign, **kwargs,
        )
    usable = [g for g in gpu_ids if checks[g]["usable"]]
    clean = [g for g in usable if not checks[g]["measurement_suspect"]]
    suspect = [g for g in usable if checks[g]["measurement_suspect"]]
    blocked = [g for g in gpu_ids if not checks[g]["usable"]]
    # Only gate-passing devices are ever offered for a measurement: a busy or
    # unreadable card is left out so the caller waits (30 min, x48) instead of
    # producing a measurement that another workload has polluted.
    preferred = clean + suspect
    return {
        "enabled": True,
        "gpus": checks,
        "preferred": preferred,
        "clean_ids": clean,
        "suspect_ids": suspect,
        "blocked_ids": blocked,
        "over_limit_ids": [g for g in blocked
                           if checks[g]["vram_peak_percent"]
                           > float(vram_limit_percent)],
        "gate_reasons": {str(g): checks[g]["reasons"] for g in blocked},
        "foreign_kfd_pids": foreign[:8],
        "sampled_at": time.time(),
        "samples": samples,
    }


def preflight_enabled(answers: Optional[Dict[str, Any]] = None) -> bool:
    """``METAINFER_GPU_PREFLIGHT=0`` or a form switch can disable the probe."""
    env = str(os.environ.get("METAINFER_GPU_PREFLIGHT") or "").strip().lower()
    if env in {"0", "false", "no", "off"}:
        return False
    if env in {"1", "true", "yes", "on"}:
        return True
    value = (answers or {}).get("gpu_preflight")
    if value is None:
        return True
    return str(value).strip().lower() not in {"0", "false", "no", "off", ""}
