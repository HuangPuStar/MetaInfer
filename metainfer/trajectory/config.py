"""Persisted DSH trajectory source configuration.

The file is the single authority for a user-selected DSH sessions directory.
An environment override (``DSH_SESSIONS_DIR``) wins for CI/advanced setups;
the UI reports which source is active so the operator is never guessing.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from metainfer.server import paths as _paths

CONFIG_VERSION = 1


def config_path() -> Path:
    return _paths.home_dir() / "trajectory" / "config-v1.json"


def default_root() -> Path:
    return (Path.home() / ".dsh" / "sessions").resolve()


def _resolve(value: str) -> Path:
    return Path(value).expanduser().resolve()


def read_config() -> Dict[str, Any]:
    path = config_path()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"version": CONFIG_VERSION, "root": None}
    root = raw.get("root") if isinstance(raw, dict) else None
    return {
        "version": CONFIG_VERSION,
        "root": str(root) if isinstance(root, str) and root.strip() else None,
    }


def write_config(root: str) -> Dict[str, Any]:
    value = str(root or "").strip()
    if not value:
        raise ValueError("root is required")
    resolved = _resolve(value)
    if not resolved.is_dir():
        raise ValueError(f"not a directory: {resolved}")
    config = {"version": CONFIG_VERSION, "root": str(resolved)}
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)
    return config


def source_root() -> Tuple[Path, str]:
    """Return ``(root, source)`` where source is env/config/default."""

    env = os.environ.get("DSH_SESSIONS_DIR")
    if env:
        return _resolve(env), "env"
    config = read_config()
    if config["root"]:
        return _resolve(config["root"]), "config"
    return default_root(), "default"
