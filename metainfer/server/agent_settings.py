"""Persisted platform-wide coding-agent backend selection.

The WebUI writes this file; every newly spawned orchestrator inherits the
selected backend through its environment.  The file is optional: without it,
the launcher preserves ``METAINFER_AGENT_BACKEND`` (or the built-in default),
so existing deployments keep their behavior until the operator opts in.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Dict, MutableMapping

from . import paths as _paths

BACKENDS = ("dsh", "claude", "codex", "pi")
DEFAULT_BACKEND = "claude"
DEFAULT_DSH_BIN = "dsh"
DEFAULT_DSH_PROFILE = "metainfer-headless"


def settings_path() -> Path:
    return _paths.home_dir() / "agent-backend.json"


def _env_backend() -> str:
    value = str(os.environ.get("METAINFER_AGENT_BACKEND") or "").strip().lower()
    return value if value in BACKENDS else DEFAULT_BACKEND


def _env_dsh_bin() -> str:
    return str(os.environ.get("METAINFER_DSH_BIN") or "").strip() or DEFAULT_DSH_BIN


def _env_dsh_profile() -> str:
    return str(os.environ.get("METAINFER_DSH_PROFILE") or "").strip() or DEFAULT_DSH_PROFILE


def _read_file() -> Dict[str, Any] | None:
    path = settings_path()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(raw, dict):
        return None
    backend = str(raw.get("backend") or "").strip().lower()
    dsh_bin = str(raw.get("dshBin") or "").strip()
    dsh_profile = str(raw.get("dshProfile") or "").strip()
    if backend not in BACKENDS:
        return None
    return {
        "backend": backend,
        "dshBin": dsh_bin or DEFAULT_DSH_BIN,
        "dshProfile": dsh_profile or DEFAULT_DSH_PROFILE,
    }


def read_settings() -> Dict[str, Any]:
    """Return the effective setting and where it came from."""

    saved = _read_file()
    if saved is not None:
        return {
            "backend": saved["backend"],
            "dshBin": saved["dshBin"],
            "dshProfile": saved["dshProfile"],
            "source": "config",
        }
    return {
        "backend": _env_backend(),
        "dshBin": _env_dsh_bin(),
        "dshProfile": _env_dsh_profile(),
        "source": "env" if os.environ.get("METAINFER_AGENT_BACKEND") else "default",
    }


def write_settings(backend: str, dsh_bin: str = "", dsh_profile: str = "") -> Dict[str, Any]:
    value = str(backend or "").strip().lower()
    if value not in BACKENDS:
        raise ValueError(f"backend must be one of {', '.join(BACKENDS)}")
    binary = str(dsh_bin or "").strip() or DEFAULT_DSH_BIN
    profile = str(dsh_profile or "").strip() or DEFAULT_DSH_PROFILE
    if len(binary) > 1024:
        raise ValueError("dsh binary path is too long")
    if not re.match(r"^[A-Za-z0-9._-]{1,120}$", profile):
        raise ValueError("invalid DSH profile name")
    payload = {"backend": value, "dshBin": binary, "dshProfile": profile}
    path = settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)
    return read_settings()


def apply_to_env(env: MutableMapping[str, str]) -> MutableMapping[str, str]:
    """Apply the saved backend to a spawned orchestrator's environment."""

    saved = _read_file()
    if saved is None:
        return env
    env["METAINFER_AGENT_BACKEND"] = saved["backend"]
    if saved["backend"] == "dsh":
        env["METAINFER_DSH_BIN"] = saved["dshBin"]
        env["METAINFER_DSH_PROFILE"] = saved["dshProfile"]
    return env


_HEADLESS_PROFILE_PATCH = """\
# MetaInfer headless: the stock headless profile disables the account and
# credentials services. Re-enable them and route the default model through the
# same DeepSeek account the Web profile uses, so one-shot task agents are
# authenticated without requiring a separate API-key environment variable.
- id: authorization
  disabled: false
- id: deepseek-account
  disabled: false
- id: credentials
  disabled: false
- id: agent-default-model
  config:
    provider: deepseek-account
    model: deepseek-flash
    reasoningEffort: max
"""


def dsh_home() -> Path:
    value = os.environ.get("DSH_HOME")
    return Path(value).expanduser().resolve() if value else (Path.home() / ".dsh")


def ensure_dsh_profile(profile: str = DEFAULT_DSH_PROFILE) -> Dict[str, Any]:
    """Create the authenticated DSH headless profile when it is absent.

    Existing profiles are never overwritten: an operator may have customized
    them.  The generated profile rides the shipped base+headless bundles and
    only changes the credential/model rows.
    """

    name = str(profile or "").strip() or DEFAULT_DSH_PROFILE
    if not re.match(r"^[A-Za-z0-9._-]{1,120}$", name):
        raise ValueError("invalid DSH profile name")
    if name != DEFAULT_DSH_PROFILE:
        raise ValueError(f"can only prepare the built-in profile {DEFAULT_DSH_PROFILE}")
    directory = dsh_home() / "profiles" / name
    if directory.is_dir():
        return {"profile": name, "path": str(directory), "created": False}
    directory.mkdir(parents=True, exist_ok=True)
    package = {
        "name": f"dsh-profile-{name}",
        "private": True,
        "dependencies": {},
        "dsh": {"profile": {"bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"]}},
    }
    files = {
        "package.json": json.dumps(package, indent=2) + "\n",
        "cordis.yml": "# dsh profile root - composed from bundle patches.\n[]\n",
        "cordis.patch.yml": _HEADLESS_PROFILE_PATCH,
        "pnpm-workspace.yaml": "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n",
    }
    for filename, content in files.items():
        path = directory / filename
        if path.exists():
            continue
        tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        tmp.write_text(content, encoding="utf-8")
        tmp.replace(path)
    return {"profile": name, "path": str(directory), "created": True}
