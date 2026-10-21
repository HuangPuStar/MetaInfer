"""Resolve hardware profiles into system-owned iteration bindings for opt-kernel.

Unlike gen-cpp-infer-framework (which builds a C++ server with CMake), opt-kernel
benchmarks a single kernel callable. The agent writes Python/Triton/HIP code that
the perf oracle imports directly. This module therefore:

  - Reads the matching YAML profile (``hardware_profiles.yaml``).
  - Snapshots it into the iteration dir (immutable record of what was targeted).
  - Provides the profiler launch command and artifact globs for the perf oracle.
  - Renders the profile into agent prompts so the agent knows the exact ISA
    constraints (wavefront size, CU count, matrix instructions, do-not-assume list).

Agents write kernel code; they neither choose a profiler nor author profiling
commands — the perf oracle owns that.
"""

from __future__ import annotations

import json
import shlex
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import yaml


_PROFILES_FILE = Path(__file__).with_name("hardware_profiles.yaml")
_BINDING_DIR = ".metainfer"
_PROFILE_SNAPSHOT = "hardware-profile.json"


class HardwareProfileError(ValueError):
    """Raised when a task selects no usable hardware execution profile."""


@lru_cache(maxsize=1)
def load_hardware_profiles() -> Dict[str, Dict[str, Any]]:
    """Return form-label to hardware-profile mappings from package data."""
    raw = yaml.safe_load(_PROFILES_FILE.read_text(encoding="utf-8")) or {}
    profiles = raw.get("profiles")
    if not isinstance(profiles, dict):
        raise ValueError(f"invalid hardware profiles file: {_PROFILES_FILE}")
    return {
        str(label): profile
        for label, profile in profiles.items()
        if isinstance(profile, dict)
    }


def selected_hardware(req: Dict[str, Any]) -> Optional[str]:
    """Read the current hardware selection (via shared req_field helper)."""
    from metainfer.orchestrator.requirements import req_field
    value = req_field(req, "target_hardware")
    return str(value) if value else None


def resolve_hardware_profile(
    req: Dict[str, Any],
) -> Tuple[Optional[str], Optional[Dict[str, Any]]]:
    """Return ``(selected_label, profile)``; profile is None if not mapped."""
    selected = selected_hardware(req)
    if selected is None:
        return None, None
    return selected, load_hardware_profiles().get(selected)


def require_hardware_profile(req: Dict[str, Any]) -> Tuple[str, Dict[str, Any]]:
    """Return the selected profile or fail before any agent can guess."""
    selected, profile = resolve_hardware_profile(req)
    if selected is None:
        raise HardwareProfileError("target_hardware is required for a kernel optimization task")
    if profile is None:
        raise HardwareProfileError(
            f"no verified hardware execution profile is registered for {selected!r}"
        )
    return selected, profile


def materialize_hardware_binding(req: Dict[str, Any], iter_dir: Path) -> Path:
    """Write the immutable-on-execution profile snapshot.

    Unlike gen-cpp-infer-framework, opt-kernel does not generate a ``build.sh``
    (the agent writes Python/Triton code that the oracle imports directly).
    The snapshot is still written so the perf oracle and reviewers can read
    the exact ISA constraints that were in effect.
    """
    selected, profile = require_hardware_profile(req)
    binding_dir = iter_dir / _BINDING_DIR
    binding_dir.mkdir(parents=True, exist_ok=True)
    snapshot = binding_dir / _PROFILE_SNAPSHOT
    snapshot.write_text(
        json.dumps(
            {"selected_hardware": selected, "profile": profile},
            ensure_ascii=False, indent=2, sort_keys=True,
        ) + "\n",
        encoding="utf-8",
    )
    return snapshot


def execution_environment(req: Dict[str, Any], iter_dir: Path) -> Dict[str, str]:
    """Return the environment shared by the perf oracle and agent self-tests."""
    selected, profile = require_hardware_profile(req)
    env: Dict[str, str] = {
        "METAINFER_TARGET_HARDWARE": selected,
        "METAINFER_HARDWARE_PROFILE": str(profile["id"]),
        "METAINFER_HARDWARE_PROFILE_FILE": str(
            iter_dir / _BINDING_DIR / _PROFILE_SNAPSHOT
        ),
    }
    build_env = (profile.get("build") or {}).get("env") or {}
    for k, v in build_env.items():
        env[str(k)] = str(v)
    return env


def profiler_launch_command(req: Dict[str, Any]) -> List[str]:
    """Return the externally-owned profiler prefix for the selected profile."""
    _, profile = require_hardware_profile(req)
    profiling = profile.get("profiling") or {}
    profiler = profiling.get("profiler")
    if not profiler:
        return []
    return [str(profiler), *(str(v) for v in profiling.get("launch_args") or [])]


def profiler_artifact_globs(req: Dict[str, Any]) -> List[str]:
    """Return the external profiler artifacts expected in an iteration dir."""
    _, profile = require_hardware_profile(req)
    profiling = profile.get("profiling") or {}
    return [str(v) for v in profiling.get("artifact_globs") or []]


def profiler_key_counters(req: Dict[str, Any]) -> List[str]:
    """Return the key hardware counters for GEMM optimization analysis."""
    _, profile = require_hardware_profile(req)
    profiling = profile.get("profiling") or {}
    return [str(v) for v in profiling.get("key_counters") or []]


def render_hardware_profile(req: Dict[str, Any]) -> str:
    """Render the selected executable profile for an agent prompt."""
    selected, profile = resolve_hardware_profile(req)
    if selected is None:
        return ""
    if profile is None:
        return (
            "\n# Hardware execution profile\n"
            f"No verified execution profile is registered for {selected!r}. "
            "Do not guess compiler, operator, or profiler commands.\n"
        )
    rendered = json.dumps(profile, ensure_ascii=False, indent=2, sort_keys=True)
    return (
        "\n# Hardware execution profile (mandatory)\n"
        f"The selected platform is {selected!r}. This profile is SYSTEM-OWNED: "
        "do not invoke a profiler directly. Write only kernel code (Python/Triton/HIP) "
        "that conforms to its runtime and operator constraints.\n"
        "```json\n"
        f"{rendered}\n"
        "```\n"
    )
