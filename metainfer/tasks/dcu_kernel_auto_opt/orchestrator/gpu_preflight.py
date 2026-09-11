"""GPU admission pre-check shared by production DKAO tasks and AHE children.

Two different questions are answered separately, because they need different
rules:

* **Can we run here at all?**  Only VRAM pressure decides that. Our W8A8
  kernels need a few GB at most, so the operating rule is simple: a device is
  usable while its used-VRAM percentage is at or below
  ``vram_limit_percent`` (default 85). Above that the caller prefers another
  device, and only then waits.
* **Will the measurement be trustworthy?**  Busy compute (high HCU%, high
  board power) or foreign processes hold the device (KFD lists pids invisible
  inside this container) do NOT block the run — they only mark the question as
  ``measurement_suspect`` so a polluted reading cannot silently decide an
  A/B comparison.

The module is deliberately dependency-free: it parses ``hy-smi`` text and the
KFD sysfs listing, so it works inside the task containers without extra tools.
"""

from __future__ import annotations

import os
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

#: A device is usable while at least this much VRAM stays free. Absolute free
#: memory is the right unit for us (one W8A8 worker needs ~1-3GB), whereas a
#: percentage punishes big cards that hold idle reservations.
DEFAULT_MIN_FREE_GB = 4.0
#: Assumed total VRAM when the driver sysfs does not expose it (K500SM_AI).
DEFAULT_TOTAL_GB = 65.5
#: Above this average HCU% the device is considered shared with other work.
DEFAULT_UTIL_SUSPECT_PERCENT = 20.0
#: Above this board power (W) another workload is almost certainly running.
DEFAULT_POWER_SUSPECT_W = 230.0

KFD_PROC_ROOT = Path("/sys/class/kfd/kfd/proc")
_SMI_ROW = re.compile(
    r"^(?P<index>\d+)\s+"          # device index
    r"(?P<temp>[\d.]+)C\s+"
    r"(?P<power>[\d.]+)W\s+"
    r"\S+\s+"                       # perf mode
    r"[\d.]+W\s+"                   # power cap
    r"(?P<vram>[\d.]+)%\s+"
    r"(?P<util>[\d.]+)%"
)


def parse_hy_smi(text: str) -> Dict[int, Dict[str, float]]:
    """Parse ``hy-smi`` output into ``{index: {vram_percent, util_percent, power_w, temp_c}}``."""
    out: Dict[int, Dict[str, float]] = {}
    for line in (text or "").splitlines():
        match = _SMI_ROW.match(line.strip())
        if not match:
            continue
        index = int(match.group("index"))
        out[index] = {
            "vram_percent": float(match.group("vram")),
            "util_percent": float(match.group("util")),
            "power_w": float(match.group("power")),
            "temp_c": float(match.group("temp")),
        }
    return out


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
                     smi_reader=read_hy_smi) -> Dict[int, Dict[str, float]]:
    """Average a few hy-smi samples per device (drops idle flicker)."""
    acc: Dict[int, Dict[str, List[float]]] = {}
    for attempt in range(max(1, samples)):
        parsed = parse_hy_smi(smi_reader())
        for index, row in parsed.items():
            if gpu_ids is not None and index not in gpu_ids:
                continue
            bucket = acc.setdefault(index, {"vram_percent": [], "util_percent": [],
                                            "power_w": [], "temp_c": []})
            for key, value in row.items():
                bucket.setdefault(key, []).append(value)
        if attempt + 1 < samples:
            time.sleep(max(0.0, interval_s))
    out: Dict[int, Dict[str, float]] = {}
    for index, bucket in acc.items():
        out[index] = {
            key: (sum(values) / len(values) if values else 0.0)
            for key, values in bucket.items()
        }
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
              util_suspect_percent: float = DEFAULT_UTIL_SUSPECT_PERCENT,
              power_suspect_w: float = DEFAULT_POWER_SUSPECT_W,
              foreign_pids: Optional[List[int]] = None,
              ) -> Dict[str, Any]:
    """Decide usability (free VRAM >= ``min_free_gb``) and suspicion (busy)."""
    vram = float(state.get("vram_percent") or 0.0)
    util = float(state.get("util_percent") or 0.0)
    power = float(state.get("power_w") or 0.0)
    foreign = list(foreign_pids or [])
    total = float(total_gb if total_gb is not None else total_vram_gb())
    free_gb = total * max(0.0, 100.0 - vram) / 100.0
    usable = free_gb >= float(min_free_gb)
    reasons: List[str] = []
    if util > float(util_suspect_percent):
        reasons.append(f"busy: HCU {util:.0f}% > {util_suspect_percent:.0f}%")
    if power > float(power_suspect_w):
        reasons.append(f"high power draw {power:.0f}W > {power_suspect_w:.0f}W")
    # Foreign KFD entries alone are NOT evidence of contention: idle holders
    # (long-lived runtimes in other containers) keep their handle while the
    # device sits at 0% util / idle power, which is harmless for us. They are
    # reported as notes, and the busy/power signals above decide suspicion.
    notes: List[str] = []
    if foreign:
        notes.append(f"{len(foreign)} foreign KFD pid(s) hold this GPU")
    if not usable:
        reasons.append(
            f"only {free_gb:.1f}GB VRAM free (< {float(min_free_gb):.1f}GB)")
    return {
        "gpu": gpu_id,
        "usable": usable,
        "free_gb": round(free_gb, 2),
        "total_gb": round(total, 1),
        "min_free_gb": float(min_free_gb),
        "vram_percent": round(vram, 1),
        "util_percent": round(util, 1),
        "power_w": round(power, 1),
        "temp_c": round(float(state.get("temp_c") or 0.0), 1),
        "foreign_pids": foreign[:8],
        "measurement_suspect": bool(any(
            r for r in reasons if "VRAM free" not in r)),
        "reasons": reasons,
        "notes": notes,
    }


def preflight_gpus(gpu_ids: List[int], *, samples: int = 3,
                   interval_s: float = 3.0, enabled: bool = True,
                   min_free_gb: float = DEFAULT_MIN_FREE_GB,
                   **kwargs: Any) -> Dict[str, Any]:
    """Return ``{gpu_id: check}`` plus a preferred order (clean devices first)."""
    if not enabled:
        return {"enabled": False, "gpus": {}, "preferred": list(gpu_ids),
                "suspect_ids": []}
    states = sample_gpu_state(gpu_ids, samples=samples, interval_s=interval_s)
    foreign = foreign_kfd_pids()
    checks: Dict[int, Dict[str, Any]] = {}
    for gpu_id in gpu_ids:
        checks[gpu_id] = check_gpu(
            gpu_id, states.get(gpu_id) or {}, min_free_gb=min_free_gb,
            foreign_pids=foreign, **kwargs,
        )
    usable = [g for g in gpu_ids if checks[g]["usable"]]
    clean = [g for g in usable if not checks[g]["measurement_suspect"]]
    suspect = [g for g in usable if checks[g]["measurement_suspect"]]
    busy_but_usable = [g for g in gpu_ids if not checks[g]["usable"]]
    # Devices over the VRAM limit stay usable in principle (configuration
    # choice), but when any device is within the limit they are pushed to the
    # back so concurrent children do not collide with a full device.
    preferred = (clean + suspect + busy_but_usable) if not usable \
        else (clean + suspect)
    return {
        "enabled": True,
        "gpus": checks,
        "preferred": preferred,
        "clean_ids": clean,
        "suspect_ids": suspect,
        "over_limit_ids": busy_but_usable,
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
