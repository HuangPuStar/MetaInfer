"""Harness workspace IO: locate the evolvable-harness seed, read components,
and copy a seed workspace to a destination.

This is the AHE "component observability" layer for dcu_kernel_auto_opt:
harness components (gates, planner policy/catalog, systemprompt, and later
skills/tools/middleware/memory) are seeded as files under ``harness_default/``
so they form a versioned, evolvable workspace driven by the ``harness_evolve``
outer loop.

Wiring status: ``gates.yaml`` is read through :mod:`gate_policy`,
``planner_policy.yaml``/``planner_catalog.yaml`` through :mod:`planner`, and
``systemprompt/round_strategy.yaml`` through :mod:`round_strategy`. Each of
those falls back to built-in defaults when its file is absent, so an untouched
harness behaves exactly as it did before the component was externalised.
Consistency tests guard every YAML seed against its Python defaults so the two
cannot drift silently.
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


def env_root() -> Path:
    """The harness root as the *environment* defines it (no explicit argument).

    Same resolution as :func:`harness_root`, named separately so components
    that already accept an explicit ``root`` argument (``gate_policy``,
    ``planner``, ``round_strategy``) can share one implementation and one
    cache key.
    """
    return harness_root()


def load_component_file(relative: str, root: Path | None = None) -> Path:
    """Path of one component file inside a harness workspace."""
    return (root or harness_root()) / str(relative)


def load_component_yaml(relative: str, root: Path | None = None,
                        ) -> tuple[Dict[str, Any], str]:
    """Read one YAML component. Returns ``(data, error)``; never raises.

    A component file that is absent yields ``({}, "")`` — "not present" is a
    normal state that makes the caller fall back to its built-in defaults. A
    file that exists but cannot be parsed yields ``({}, "<reason>")`` so the
    caller can report it instead of silently ignoring a hand-edited mistake.
    """
    path = load_component_file(relative, root)
    if not path.is_file():
        return {}, ""
    try:
        with path.open("r", encoding="utf-8") as handle:
            data = yaml.safe_load(handle)
    except (OSError, ValueError, yaml.YAMLError) as exc:
        return {}, f"{relative}: {exc}"
    if data is None:
        return {}, ""
    if not isinstance(data, dict):
        return {}, f"{relative}: expected a mapping at the top level"
    return data, ""


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
