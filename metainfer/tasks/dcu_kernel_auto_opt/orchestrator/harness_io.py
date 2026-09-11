"""Harness workspace IO: locate the evolvable-harness seed, read components,
and copy a seed workspace to a destination.

This is the first piece of AHE "component observability" for dcu_kernel_auto_opt:
harness components (gates, and later prompts/planner/skills/tools/middleware/
memory) are seeded as files under ``harness_default/`` so they can become a
versioned, evolvable workspace driven by the ``harness_evolve`` outer loop.

Slice-1 semantics (important): this module is **read-only/additive**.
Runtime pipelines still read the current Python constants (``config.py``,
``w8a8_pipeline.py``); ``harness_io`` only exposes the seed for inspection and
copying. Consistency tests guard the YAML seed against the Python constants so
the two sources cannot drift before the loader/renderer wiring lands in a later
slice (wiring will make the harness workspace the single source of truth).
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Any, Dict

import yaml

#: Name of the seed directory inside the dcu_kernel_auto_opt plugin tree.
HARNESS_DEFAULT_DIRNAME = "harness_default"
#: Optional env override for the harness root (used by AHE experiments to point
#: at an evolved workspace instead of the built-in seed).
ENV_HARNESS_ROOT = "METAINFER_HARNESS_ROOT"


def plugin_dir() -> Path:
    """Return the dcu_kernel_auto_opt plugin root (parent of orchestrator/)."""
    return Path(__file__).resolve().parents[1]


def default_harness_dir() -> Path:
    """Built-in seed directory (this plugin's harness_default/)."""
    return plugin_dir() / HARNESS_DEFAULT_DIRNAME


def harness_root() -> Path:
    """Resolve the active harness root.

    Prefers ``METAINFER_HARNESS_ROOT`` (absolute or relative-to-plugin path),
    otherwise falls back to the built-in ``harness_default/`` seed.
    """
    override = os.environ.get(ENV_HARNESS_ROOT, "").strip()
    if override:
        path = Path(override).expanduser()
        if not path.is_absolute():
            path = plugin_dir() / path
        return path.resolve()
    return default_harness_dir().resolve()


def _load_yaml(path: Path) -> Dict[str, Any]:
    if not path.is_file():
        return {}
    with path.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle)
    return data if isinstance(data, dict) else {}


def load_manifest(root: Path | None = None) -> Dict[str, Any]:
    """Load the component inventory (manifest.yaml) of a harness workspace."""
    root = (root or harness_root())
    return _load_yaml(root / "manifest.yaml")


def load_gates(root: Path | None = None) -> Dict[str, Any]:
    """Load the gates component (acceptance/plateau/ISA values) of a workspace."""
    root = (root or harness_root())
    return _load_yaml(root / "gates.yaml")


def seed_workspace(dst: Path, root: Path | None = None) -> Path:
    """Copy the harness seed tree into ``dst`` (creating dirs as needed).

    Used by task staging / AHE experiments to materialize a fresh, evolvable
    harness workspace snapshot from the seed.
    """
    src = (root or harness_root())
    if not src.is_dir():
        raise FileNotFoundError(f"harness seed not found: {src}")
    dst = Path(dst)
    dst.mkdir(parents=True, exist_ok=True)
    for item in src.iterdir():
        target = dst / item.name
        if item.is_dir():
            shutil.copytree(item, target, dirs_exist_ok=True)
        else:
            shutil.copy2(item, target)
    return dst
