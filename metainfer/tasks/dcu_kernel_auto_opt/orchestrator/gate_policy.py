"""Runtime gate values, read from the harness workspace (gates.yaml).

Until now ``gates.yaml`` was a *mirror* of Python constants: the file existed
and a drift test kept it equal, but nothing read it, so an Evolve change to
gates had no effect at all (``wired: false`` in the manifest). This module
makes the component real:

* values come from ``<harness_root>/gates.yaml`` (the AHE candidate snapshot,
  or the seed for production tasks);
* a component marked ``wired: false`` in ``manifest.yaml`` is *ignored* — the
  manifest is therefore meaningful too (it decides which components apply);
* anything missing falls back to the built-in defaults, which are exactly the
  values the pipelines hard-coded before, so behaviour is unchanged until a
  harness actually edits the file.

Cache keys include both files' mtimes so a mid-run harness swap is picked up.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

_BUILTIN_GATES: Dict[str, Any] = {
    "round_acceptance_improvement_percent": 1.0,
    "p90_guard": "no_p90_regression",
    "shadow": {
        "enabled": True,
        "min_improvement_percent": 0.3,
        "max_exclusive_percent": 1.0,
    },
    "plateau": {
        "recent_valid_rounds": 3,
        "max_regression_percent": 2.0,
        "window_upper_exclusive_percent": 2.0,
    },
    "isa_gate": {
        "required_valid_isa_guided_rounds": 2,
        "required_hip_rounds_rule": "max(1, max_iterations - 2)",
        "inline_asm_requires_compiler_limitation": True,
    },
    "task_budget": {
        "default_max_iterations": 10,
    },
}

_CACHE: Dict[Tuple[str, float, float], Dict[str, Any]] = {}
_ENV_ROOT = "METAINFER_HARNESS_ROOT"


def builtin_gates() -> Dict[str, Any]:
    """The defaults that were hard-coded before this file was wired."""
    import copy

    return copy.deepcopy(_BUILTIN_GATES)


def _root(root: Optional[Path] = None) -> Path:
    if root is not None:
        return Path(root)
    env = os.environ.get(_ENV_ROOT)
    if env:
        return Path(env).expanduser()
    from .harness_io import default_harness_dir

    return default_harness_dir()


def _yaml(path: Path) -> Dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        import yaml
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _merge(base: Dict[str, Any], overlay: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(base)
    for key, value in (overlay or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _merge(out[key], value)
        else:
            out[key] = value
    return out


def component_wired(name: str, root: Optional[Path] = None) -> bool:
    """Whether ``manifest.yaml`` marks this component as actually applied."""
    manifest = _yaml(_root(root) / "manifest.yaml")
    components = manifest.get("components")
    if not isinstance(components, dict):
        return True                      # no manifest -> assume wired
    entry = components.get(name)
    if not isinstance(entry, dict):
        return True
    return bool(entry.get("wired", True))


def gates(root: Optional[Path] = None) -> Dict[str, Any]:
    """Effective gate values for this harness workspace."""
    workspace = _root(root)
    gates_path = workspace / "gates.yaml"
    manifest_path = workspace / "manifest.yaml"
    try:
        key = (str(workspace),
               gates_path.stat().st_mtime if gates_path.is_file() else 0.0,
               manifest_path.stat().st_mtime if manifest_path.is_file() else 0.0)
    except OSError:
        key = (str(workspace), 0.0, 0.0)
    cached = _CACHE.get(key)
    if cached is not None:
        return cached
    if not component_wired("gates", workspace):
        value = builtin_gates()
    else:
        data = _yaml(gates_path).get("gates")
        value = _merge(builtin_gates(), data if isinstance(data, dict) else {})
    _CACHE[key] = value
    return value


def reset_cache() -> None:
    _CACHE.clear()


def _number(path: str, default: float, root: Optional[Path] = None) -> float:
    node: Any = gates(root)
    for part in path.split("."):
        if not isinstance(node, dict):
            return default
        node = node.get(part)
    try:
        return float(node)
    except (TypeError, ValueError):
        return float(default)


def _flag(path: str, default: bool, root: Optional[Path] = None) -> bool:
    node: Any = gates(root)
    for part in path.split("."):
        if not isinstance(node, dict):
            return default
        node = node.get(part)
    if node is None:
        return default
    if isinstance(node, bool):
        return node
    return str(node).strip().lower() in {"1", "true", "yes", "on"}


# ------------------------------------------------------------- accessors ----

def round_acceptance_improvement_percent(root: Optional[Path] = None) -> float:
    return _number("round_acceptance_improvement_percent", 1.0, root)


def p90_guard_mode(root: Optional[Path] = None) -> str:
    """``no_p90_regression`` (default) or a numeric tolerance like ``1.02``."""
    node: Any = gates(root).get("p90_guard")
    return str(node if node is not None else "no_p90_regression")


def p90_tolerance(root: Optional[Path] = None) -> float:
    """Multiplier on the best p90 that still counts as a pass (1.0 = strict)."""
    mode = p90_guard_mode(root).strip().lower()
    if mode in {"no_p90_regression", "strict", ""}:
        return 1.0
    try:
        value = float(mode)
    except ValueError:
        return 1.0
    return value if value >= 1.0 else 1.0


def shadow_enabled(root: Optional[Path] = None) -> bool:
    return _flag("shadow.enabled", True, root)


def shadow_min_improvement_percent(root: Optional[Path] = None) -> float:
    return _number("shadow.min_improvement_percent", 0.3, root)


def shadow_max_exclusive_percent(root: Optional[Path] = None) -> float:
    return _number("shadow.max_exclusive_percent", 1.0, root)


def plateau_recent_valid_rounds(root: Optional[Path] = None) -> int:
    return int(_number("plateau.recent_valid_rounds", 3, root))


def plateau_max_regression_percent(root: Optional[Path] = None) -> float:
    return _number("plateau.max_regression_percent", 2.0, root)


def plateau_window_upper_exclusive_percent(root: Optional[Path] = None) -> float:
    return _number("plateau.window_upper_exclusive_percent", 2.0, root)


def isa_required_valid_rounds(root: Optional[Path] = None) -> int:
    return int(_number("isa_gate.required_valid_isa_guided_rounds", 2, root))


def inline_asm_requires_compiler_limitation(root: Optional[Path] = None) -> bool:
    return _flag("isa_gate.inline_asm_requires_compiler_limitation", True, root)


def required_hip_rounds(max_iterations: int, root: Optional[Path] = None) -> int:
    """Honour the documented rule but allow a literal override.

    ``required_hip_rounds_rule`` may stay the documented expression
    ``max(1, max_iterations - 2)`` or be replaced by an integer literal.
    """
    node: Any = gates(root).get("isa_gate")
    rule = (node or {}).get("required_hip_rounds_rule") \
        if isinstance(node, dict) else None
    if isinstance(rule, (int, float)):
        return max(1, int(rule))
    try:
        literal = int(str(rule).strip())
        return max(1, literal)
    except (TypeError, ValueError):
        return max(1, int(max_iterations) - 2)


def default_max_iterations(root: Optional[Path] = None) -> int:
    return int(_number("task_budget.default_max_iterations", 10, root))


def snapshot(state_dir: Path, root: Optional[Path] = None) -> Optional[Path]:
    """Persist the effective gate values a run used (AHE mechanism evidence).

    The harness_evolve mechanism gate compares this record with the candidate
    harness it staged, which is how a gates.yaml edit becomes verifiable
    instead of merely "unobserved".
    """
    import json

    workspace = _root(root)
    payload = {
        "harness_root": str(workspace),
        "harness_revision": _yaml(workspace / "manifest.yaml").get("revision"),
        "gates_wired": component_wired("gates", workspace),
        "gates": gates(workspace),
    }
    try:
        target = Path(state_dir) / "gates_effective.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(payload, ensure_ascii=False, indent=2,
                                     sort_keys=True), encoding="utf-8")
    except OSError:
        return None
    return target
