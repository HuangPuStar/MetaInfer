"""Parse + validate an evalscope-correctness evaluation request.

Turns the flat ``requirements.json`` (form answers spread to the top
level, per CLAUDE.md) into a validated :class:`EvalConfig`. All reads go
through :func:`metainfer.orchestrator.requirements.req_field*` so legacy
nested form/answers fixtures keep working.

Two things this module owns that matter for correctness:

* **Secret handling.** Only the NAME of an env var holding the API key is
  accepted and stored (``api_key_env_var``). The secret itself is never a
  form field and never lands in ``requirements.json``; the runner resolves
  it from the environment at run time and injects it into the child
  process's env only.
* **The restart fingerprint.** :meth:`EvalConfig.fingerprint` covers every
  immutable field that determines *what* EvalScope computes. Changing a
  quality **gate** or ``model_id`` must NOT invalidate already-complete
  evaluations, so those are excluded from the fingerprint. On resume, the
  supervisor reuses datasets already evaluated under the same fingerprint
  and only evaluates the missing/incomplete ones.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

from metainfer.orchestrator.requirements import (
    req_field,
    req_field_float,
    req_field_int,
)

# Preset EvalScope dataset names offered in form.yaml.
PRESET_GSM8K = "gsm8k"
PRESET_GPQA = "gpqa_diamond"
PRESET_HUMANEVAL = "humaneval"
PRESET_IDS = (PRESET_GSM8K, PRESET_GPQA, PRESET_HUMANEVAL)

# Datasets whose scoring requires executing generated code in a sandbox.
SANDBOX_DATASETS = frozenset({PRESET_HUMANEVAL})

# Defaults mirroring the plan's safe correctness posture.
DEFAULT_MAX_TOKENS = 8192
DEFAULT_TIMEOUT_SECONDS = 300
DEFAULT_SEED = 42
DEFAULT_KEY_ENV_VAR = "EVALSCOPE_API_KEY"
ALLOWED_BATCH_SIZES = (1, 2, 4)
TEMPERATURE = 0.0

# Env-var name pattern (for api_key_env_var). We accept a NAME only.
_ENV_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
# Custom dataset name pattern (anything EvalScope could reasonably address).
_DATASET_NAME_RE = re.compile(r"^[A-Za-z0-9_\-\.]+$")

# Which form gate key feeds which preset.
_PRESET_GATE_KEY = {
    PRESET_GSM8K: "gate_gsm8k",
    PRESET_GPQA: "gate_gpqa_diamond",
    PRESET_HUMANEVAL: "gate_humaneval",
}


class ConfigError(ValueError):
    """Raised when a request cannot be turned into a valid evaluation."""


@dataclass(frozen=True)
class EvalTarget:
    """One dataset to evaluate.

    ``dataset`` is the exact EvalScope dataset ``name`` passed to
    ``TaskConfig.datasets``. ``gate`` is an optional minimum score in
    [0, 1] (None = report-only for this dataset). ``needs_sandbox`` flags
    datasets whose reference scoring executes generated code.
    """

    dataset: str
    gate: Optional[float] = None
    needs_sandbox: bool = False


@dataclass
class EvalConfig:
    """Validated evaluation request.

    Fields are deliberately plain so the module is pure and testable with
    no dependency on EvalScope itself.
    """

    api_url: str
    model: str
    targets: List[EvalTarget]
    model_id: str = ""
    seed: int = DEFAULT_SEED
    temperature: float = TEMPERATURE
    eval_batch_size: int = 2
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS
    max_tokens: int = DEFAULT_MAX_TOKENS
    limit: Optional[int] = None
    dataset_cache_dir: str = ""
    api_key_env_var: str = DEFAULT_KEY_ENV_VAR
    gate_custom_json: Dict[str, float] = field(default_factory=dict)

    # -- derived queries -------------------------------------------------- #

    @property
    def dataset_ids(self) -> List[str]:
        """Requested EvalScope dataset names, in request order."""
        return [t.dataset for t in self.targets]

    @property
    def requires_key(self) -> bool:
        """True if the request needs a real API key (env var named + set)."""
        return bool(self.api_key_env_var)

    def gate_for(self, dataset: str) -> Optional[float]:
        for t in self.targets:
            if t.dataset == dataset:
                return t.gate
        return None

    def fingerprint(self) -> str:
        """Stable id of the immutable eval request.

        Restart semantics: an evaluation already complete for this
        fingerprint is reused on resume. Quality gates and ``model_id`` are
        intentionally excluded — adjusting a minimum score must not force a
        re-run of an already-complete dataset.
        """
        canon = {
            "api_url": self.api_url,
            "model": self.model,
            "datasets": sorted(self.dataset_ids),
            "seed": int(self.seed),
            "temperature": float(self.temperature),
            "max_tokens": int(self.max_tokens),
            "eval_batch_size": int(self.eval_batch_size),
            "limit": int(self.limit) if self.limit is not None else None,
        }
        blob = json.dumps(canon, sort_keys=True, separators=(",", ":")).encode("utf-8")
        return "sha256:" + hashlib.sha256(blob).hexdigest()

    def to_child_json(self) -> Dict[str, Any]:
        """Non-secret config passed to the isolated EvalScope child.

        Never contains the API key — only ``api_key_env_var`` (the name).
        The child reads the actual secret from its own environment.
        """
        return {
            "api_url": self.api_url,
            "model": self.model,
            "model_id": self.model_id or self.model,
            "datasets": self.dataset_ids,
            "temperature": self.temperature,
            "seed": self.seed,
            "eval_batch_size": self.eval_batch_size,
            "timeout_seconds": self.timeout_seconds,
            "max_tokens": self.max_tokens,
            "limit": self.limit,
            "dataset_cache_dir": self.dataset_cache_dir,
            "api_key_env_var": self.api_key_env_var,
        }


# --------------------------------------------------------------------------- #
# Parsing helpers
# --------------------------------------------------------------------------- #

def _split_csv(value: Any) -> List[str]:
    """Split a possibly-list / comma-separated string into trimmed pieces."""
    if value is None:
        return []
    if isinstance(value, str):
        parts = value.split(",")
    elif isinstance(value, (list, tuple, set)):
        parts = value
    else:
        raise ConfigError(f"expected list or comma-separated string, got {type(value).__name__}")
    return [str(p).strip() for p in parts if str(p).strip()]


def _require_text(req: Dict[str, Any], key: str) -> str:
    v = req_field(req, key)
    if v is None or not str(v).strip():
        raise ConfigError(f"'{key}' is required")
    return str(v).strip()


def _validate_gate(value: Any, label: str) -> Optional[float]:
    """Validate an optional gate; returns None when blank/unset."""
    if value is None or str(value).strip() == "":
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        raise ConfigError(f"{label} must be a number in [0, 1]")
    if not (0.0 <= f <= 1.0):
        raise ConfigError(f"{label} must be in [0, 1], got {f}")
    return f


def _parse_gate_custom(req: Dict[str, Any]) -> Dict[str, float]:
    raw = req_field(req, "gate_custom_json")
    if raw is None or str(raw).strip() == "":
        return {}
    if isinstance(raw, dict):
        data = raw
    else:
        text = str(raw).strip()
        try:
            data = json.loads(text)
        except ValueError as exc:
            raise ConfigError(f"gate_custom_json is not valid JSON: {exc}")
    if not isinstance(data, dict):
        raise ConfigError("gate_custom_json must be a JSON object mapping dataset -> gate")
    out: Dict[str, float] = {}
    for k, v in data.items():
        gate = _validate_gate(v, f"custom gate for '{k}'")
        out[str(k)] = gate
    return out


def parse_requirements(req: Dict[str, Any]) -> EvalConfig:
    """Validate + normalize a request into an :class:`EvalConfig`.

    Raises :class:`ConfigError` with a human-readable message on any
    invalid input. The caller turns a ConfigError into a ``stopped``
    run rather than a crash.
    """
    if not isinstance(req, dict):
        raise ConfigError("requirements must be a JSON object")

    api_url = _require_text(req, "api_url")
    _validate_url(api_url)
    model = _require_text(req, "model")

    model_id = str(req_field(req, "model_id") or "").strip()

    # -- dataset selection ------------------------------------------------ #
    preset_labels = _split_csv(req_field(req, "benchmarks"))
    # Normalize selected preset labels to their dataset ids (hand-writers may
    # use the id directly; the form emits the label, which equals the id).
    presets = [p for p in preset_labels if p in PRESET_IDS]
    unknown = [p for p in preset_labels if p not in PRESET_IDS]
    if unknown:
        raise ConfigError(f"unknown benchmark selections: {', '.join(unknown)}")

    custom_names = []
    for name in _split_csv(req_field(req, "custom_benchmarks")):
        if name in PRESET_IDS:
            # Already selected via the preset list; dedupe quietly.
            if name not in presets:
                presets.append(name)
            continue
        if not _DATASET_NAME_RE.match(name):
            raise ConfigError(
                f"custom benchmark name {name!r} has invalid characters "
                "(allowed: letters, digits, _ - .)"
            )
        if name not in custom_names:
            custom_names.append(name)

    if not presets and not custom_names:
        raise ConfigError("select at least one benchmark (or a custom dataset)")

    # -- gates ------------------------------------------------------------- #
    gate_custom = _parse_gate_custom(req)
    if custom_names:
        # A custom gate key that references a non-requested dataset is a typo.
        for name in gate_custom:
            if name not in custom_names:
                raise ConfigError(
                    f"custom gate for '{name}' references a dataset that was not requested"
                )
    elif gate_custom:
        raise ConfigError("gate_custom_json given but no custom benchmarks requested")

    targets: List[EvalTarget] = []
    for preset in presets:
        gate = _validate_gate(req_field(req, _PRESET_GATE_KEY[preset]), f"gate for {preset}")
        targets.append(
            EvalTarget(
                dataset=preset,
                gate=gate,
                needs_sandbox=preset in SANDBOX_DATASETS,
            )
        )
    for name in custom_names:
        targets.append(
            EvalTarget(
                dataset=name,
                gate=gate_custom.get(name),
                needs_sandbox=False,
            )
        )

    # -- numerics ---------------------------------------------------------- #
    max_tokens = req_field_int(req, "max_tokens", DEFAULT_MAX_TOKENS)
    if max_tokens is not None and max_tokens < 1:
        raise ConfigError("max_tokens must be >= 1")

    timeout = req_field_int(req, "timeout_seconds", DEFAULT_TIMEOUT_SECONDS)
    if timeout is None or timeout < 1:
        raise ConfigError("timeout_seconds must be >= 1")

    batch = req_field_int(req, "eval_batch_size", 2)
    if batch not in ALLOWED_BATCH_SIZES:
        raise ConfigError(f"eval_batch_size must be one of {list(ALLOWED_BATCH_SIZES)}")

    seed = req_field_int(req, "seed", DEFAULT_SEED)
    if seed is None:
        seed = DEFAULT_SEED

    limit_raw = req_field(req, "limit")
    limit: Optional[int] = None
    if limit_raw is not None and str(limit_raw).strip() != "":
        limit = req_field_int(req, "limit")
        if limit is None or limit < 1:
            raise ConfigError("limit must be a positive integer")

    cache_dir = str(req_field(req, "dataset_cache_dir") or "").strip()

    # -- auth -------------------------------------------------------------- #
    key_env = str(req_field(req, "api_key_env_var") or "").strip()
    if key_env == "":
        key_env = ""  # no auth
    elif not _ENV_NAME_RE.match(key_env):
        raise ConfigError(
            "api_key_env_var must be the NAME of an environment variable "
            "(letters/digits/_ only), not a secret value"
        )

    return EvalConfig(
        api_url=api_url,
        model=model,
        targets=targets,
        model_id=model_id,
        seed=int(seed),
        temperature=TEMPERATURE,
        eval_batch_size=int(batch),
        timeout_seconds=int(timeout),
        max_tokens=int(max_tokens),
        limit=limit,
        dataset_cache_dir=cache_dir,
        api_key_env_var=key_env,
        gate_custom_json=gate_custom,
    )


def _validate_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ConfigError(f"api_url must be an http(s) URL, got {url!r}")


def safe_basename(value: str) -> str:
    """Collapse a free-text model id into a filesystem-safe artifact name."""
    cleaned = re.sub(r"[^A-Za-z0-9_.\-]", "_", value).strip("._")
    return cleaned or "model"
