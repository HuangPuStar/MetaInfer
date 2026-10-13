"""Fine-grained implementation variants for agent reference.

Variants are accepted kernels stored as a directory tree that mirrors the
form taxonomy, **under a hardware-profile directory**:

    variant/<profile>/<operator+dtype>/<model>/<TP>/<M>/<operator>.hip

e.g. ``variant/air-k100ai/int8w8a8-gemm/hy3/TP4/M4096/o_proj.hip``.

Why the profile level exists: two machines share one chip and one codebase but
differ in board firmware behaviour (air-cooled boards have no HBM address
hashing, so read-heavy operators are 40-87% slower there).  A variant's
``median_us`` is only meaningful against the machine that produced it, so
air-measured and liquid-measured kernels must never share a leaf.  The profile
id comes from :mod:`hw_profile` (detected, never typed in); see
``wiki-metainfer/knowledge-packs.md``.

Each leaf file carries a machine-parseable header:

    // @@variant shape=<shape_id> commit=<git sha> added=<YYYY-MM-DD>
    //   median_us=.. p90_us=.. tops=.. bandwidth_gb_s=.. speedup=.. baseline_us=..
    //   source=<task id>
    //   hw_profile=<profile id> machine=<host> measured_on=<YYYY-MM-DD>
    <kernel source>

Semantics (kept in sync with prompts.py): variants are evidence, not policy —
agents may read and adapt the file matching their (operator/dtype, model, TP,
M, operator) family, but must not be locked into it, and any reuse requires
full re-validation. The tree is staged read-only into generated kernel
repositories under ``references/<family>/`` (only the profile of the machine
that stages it) and is not part of the build.
"""

from __future__ import annotations

import re
import shutil
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from metainfer.orchestrator import hw_profile

#: Directory name shown for entries that predate the profile split (a legacy
#: ``variant/<family>/...`` layout).  Never written to; it exists so an
#: unmigrated checkout is *visible* in the index instead of silently
#: masquerading as the current machine's profile.
UNMIGRATED_PROFILE = "unmigrated"


def profile_ids() -> tuple:
    """Registered profile ids, in a stable order."""
    return tuple(sorted(hw_profile.PROFILES))


def current_profile_id() -> str:
    """The profile of *this* machine, or ``UNMIGRATED_PROFILE`` if unresolved."""
    try:
        return hw_profile.profile_id() or UNMIGRATED_PROFILE
    except hw_profile.HardwareProfileError:
        return UNMIGRATED_PROFILE


def _split_profile(rel_parts: tuple) -> tuple:
    """Return ``(profile, rest)`` for one tree-relative path tuple."""
    if rel_parts and rel_parts[0] in hw_profile.PROFILES:
        return rel_parts[0], rel_parts[1:]
    return UNMIGRATED_PROFILE, rel_parts


_HEADER_RE = re.compile(r"(?m)^// @@variant shape=(\S+)(.*?)\n(?:.*?\n)*?// @@end")
# Captures the whole header block (first line tail + ``//   key=value`` lines)
# up to ``// @@end`` for structured parsing of metrics/source/commit.
_HEADER_BLOCK_RE = re.compile(
    r"^// @@variant shape=(\S+)(.*?)\n// @@end",
    re.DOTALL | re.MULTILINE,
)

MODEL_SLUGS = {
    "deepseek v4 flash": "deepseek-v4",
    "deepseek-v4": "deepseek-v4",
    "hy3 (hunyuan 3)": "hy3",
    "hy3": "hy3",
    "minimax m3": "minimax-m3",
    "minimax-m3": "minimax-m3",
    "glm5.2": "glm52",
    "glm52": "glm52",
}

OPERATOR_TYPE_SLUGS = {
    "quantized gemm": "gemm",
    "attention": "attention",
    "rmsnorm / layernorm": "rmsnorm",
    "rope": "rope",
    "custom operator": "custom",
}


def _slug(value: str) -> str:
    # "INT8 W8A8" -> "int8w8a8", "Quantized GEMM" -> "gemm"
    return re.sub(r"[^a-z0-9]+", "", value.strip().lower())


def operator_type_slug(operator: str) -> str:
    key = operator.strip().lower()
    return OPERATOR_TYPE_SLUGS.get(key, re.sub(r"[^a-z0-9]+", "-", key).strip("-") or "custom")


def dtype_slug(dtype: str) -> str:
    return _slug(dtype) or "other"


def model_slug(label: str) -> str:
    key = label.strip().lower()
    return MODEL_SLUGS.get(key, re.sub(r"[^a-z0-9]+", "-", key).strip("-") or "unknown-model")


def parse_shape_meta(shape_id: str) -> Dict[str, Any]:
    """Split a shape id like ``hy3_tp4_o_proj_m4096`` into tp/operator/m."""
    tp_match = re.search(r"(?:^|_)(tp\d+)_", shape_id)
    tp = int(tp_match.group(1)[2:]) if tp_match else None
    m_match = re.search(r"_m(\d+)$", shape_id)
    m = int(m_match.group(1)) if m_match else None
    operator = shape_id
    if m_match:
        operator = operator[: m_match.start()]
    if tp_match:
        operator = operator[tp_match.end():]
    operator = operator.strip("_") or shape_id
    return {"tp": tp, "operator": operator, "m": m}


def derive_variant_meta(answers: Dict[str, Any], shape_id: str) -> Dict[str, Any]:
    """Derive the fine-grained taxonomy for one shape from the form answers."""
    parsed = parse_shape_meta(shape_id)
    operator = str(answers.get("operator") or "")
    dtype = str(answers.get("dtype") or "")
    return {
        "shape": shape_id,
        "operator": operator,
        "dtype": dtype,
        "family": f"{dtype_slug(dtype)}-{operator_type_slug(operator)}",
        "model": model_slug(str(answers.get("model") or "")),
        "tp": parsed["tp"],
        "operator_name": parsed["operator"],
        "m": parsed["m"],
    }


def variant_root() -> Path:
    return Path(__file__).resolve().parents[1] / "variant"


def variant_path(meta: Dict[str, Any], *, profile: Optional[str] = None) -> Path:
    """The leaf file path for one specific operator's variant.

    ``profile`` defaults to the profile detected for *this* machine: variants
    are per-hardware evidence, so writing must land in the current profile's
    subtree (an unresolved machine gets ``unmigrated``, which is visible in the
    index rather than silently wrong).
    """
    profile = profile or current_profile_id()
    tp = f"TP{meta['tp']}" if meta.get("tp") is not None else "TP?"
    m = f"M{meta['m']}" if meta.get("m") is not None else "M?"
    return (
        variant_root() / profile / meta["family"] / meta["model"] / tp / m
        / f"{meta['operator_name']}.hip"
    )


def profile_root(profile: Optional[str] = None) -> Path:
    """The per-profile subtree that staging copies into agent workspaces."""
    return variant_root() / (profile or current_profile_id())


def section_header(
    meta: Dict[str, Any],
    *,
    commit: str,
    metrics: Dict[str, Any],
    source_task: str = "",
    profile: Optional[str] = None,
    machine: str = "",
    measured_on: str = "",
) -> str:
    lines = [
        f"// @@variant shape={meta['shape']} commit={commit or '?'} "
        f"added={time.strftime('%Y-%m-%d')}",
    ]
    metric_parts = []
    for key, label in (
        ("median_us", "median_us"),
        ("p90_us", "p90_us"),
        ("logical_tops", "tops"),
        ("algorithmic_bandwidth_gb_s", "bandwidth_gb_s"),
        ("speedup", "speedup"),
        ("baseline_us", "baseline_us"),
    ):
        value = metrics.get(key)
        if value is not None:
            metric_parts.append(
                f"{label}={value:.4g}" if isinstance(value, float) else f"{label}={value}"
            )
    if metric_parts:
        lines.append("//   " + " ".join(metric_parts))
    if source_task:
        lines.append(f"//   source={source_task}")
    # Which machine produced these numbers. Read by the variant index and the
    # WebUI so a liquid variant can never be mistaken for an air measurement.
    lines.append(
        "//   hw_profile={} machine={} measured_on={}".format(
            profile or current_profile_id(),
            machine or _hostname(),
            measured_on or time.strftime("%Y-%m-%d"),
        )
    )
    lines.append("")
    return "\n".join(lines)


def _hostname() -> str:
    import os
    try:
        return os.uname().nodename
    except AttributeError:  # pragma: no cover - non-POSIX
        return "unknown"


def add_variant(
    *,
    meta: Dict[str, Any],
    kernel_source: str,
    commit: str,
    metrics: Dict[str, Any],
    source_task: str = "",
    backup: bool = True,
    reject_slower_than_existing: bool = False,
    profile: Optional[str] = None,
    require_profile: bool = False,
) -> Dict[str, Any]:
    """Write one specific operator's accepted kernel into the variant tree.

    Replaces an existing file for the same leaf (backing it up first). When
    ``reject_slower_than_existing`` is set and both the existing file's header
    and ``metrics`` carry a ``median_us``, a candidate that is strictly slower
    than the existing variant is rejected with ``ValueError`` (equal or faster
    may replace).

    The leaf lives under the detected hardware profile, so a kernel measured on
    one machine can never overwrite another machine's variant.  Pass
    ``require_profile=True`` at user-facing write boundaries to fail fast when
    the machine cannot be identified (instead of writing into ``unmigrated``).
    """
    if require_profile:
        detected = hw_profile.require().id
        if profile is not None and profile != detected:
            raise ValueError(
                f"refusing cross-profile variant write: requested profile "
                f"{profile!r} but this machine is {detected!r}"
            )
        profile = detected
    profile = profile or current_profile_id()
    target = variant_path(meta, profile=profile)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and reject_slower_than_existing:
        _reject_slower_replacement(target, metrics, profile=profile)
    header = section_header(
        meta, commit=commit, metrics=metrics, source_task=source_task,
        profile=profile,
    )
    content = header + kernel_source.rstrip() + "\n// @@end\n"
    action = "updated" if target.exists() else "added"
    backup_path = None
    if target.exists() and backup:
        backup_path = target.with_name(f"{target.name}.bak-{int(time.time() * 1000)}")
        shutil.copy2(target, backup_path)
    target.write_text(content, encoding="utf-8")
    # The reader caches the index; a promotion must be visible at once rather
    # than after the cache expires (see list_variant_index).
    invalidate_variant_index()
    return {
        "action": action,
        "shape": meta["shape"],
        "path": str(target),
        "backup": str(backup_path) if backup_path else None,
        "profile": profile,
        "meta": meta,
    }


def _reject_slower_replacement(
    target: Path, metrics: Dict[str, Any], *, profile: Optional[str] = None
) -> None:
    """Raise ValueError when the candidate is strictly slower than the
    existing variant's recorded median (both must be known).

    Only meaningful within one profile: the recorded median was measured on a
    specific machine, so a mismatch means the numbers are not comparable and
    the guard is skipped rather than applied to the wrong baseline.
    """
    existing = _parse_variant_header(target.read_text(encoding="utf-8", errors="replace"))
    existing_profile = existing.get("hw_profile")
    if profile and existing_profile and str(existing_profile) != str(profile):
        return
    existing_median = existing.get("median_us")
    new_median = metrics.get("median_us")
    if existing_median is None or new_median is None:
        # Cannot compare -> allow (guard is best-effort on known medians).
        return
    if float(new_median) > float(existing_median):
        raise ValueError(
            "rejecting slower variant replacement: existing median_us="
            f"{float(existing_median):.4g} vs candidate median_us="
            f"{float(new_median):.4g} "
            "(only an equal-or-faster candidate may replace)"
        )


# The index is a full walk + parse of every variant kernel (tens of files, a
# few hundred KB of .hip), which measures at ~0.4s. It is also read by *every*
# DKAO detail view on a timer, and each of those reads is synchronous inside
# the single WebUI event loop -- three open task tabs were enough to keep the
# whole UI (including the task list) waiting behind it. The library only
# changes when a round promotes a kernel, so the index is cached and the cache
# is invalidated by a cheap signature (file count + newest mtime) instead of
# being rebuilt per request.
_INDEX_CACHE: Dict[str, Any] = {}
_INDEX_TTL_S = 60.0


def _tree_signature(root: Path) -> tuple:
    count = 0
    newest = 0.0
    for file in root.rglob("*.hip"):
        try:
            st = file.stat()
        except OSError:
            continue
        count += 1
        newest = max(newest, st.st_mtime)
    return (count, round(newest, 3), str(root))


def list_variant_index() -> List[Dict[str, Any]]:
    """Walk the variant tree and return the section index (path-derived
    taxonomy + header fields).

    Cached: see ``_INDEX_CACHE``. A caller that just added a variant must call
    ``invalidate_variant_index()`` (the write path does), and the signature
    check catches any change made outside this process.
    """
    root = variant_root()
    if not root.exists():
        return []
    signature = _tree_signature(root)
    cached = _INDEX_CACHE.get("entry")
    if cached and cached[0] == signature \
            and (time.monotonic() - cached[1]) < _INDEX_TTL_S:
        return cached[2]
    out = _build_variant_index(root)
    _INDEX_CACHE["entry"] = (signature, time.monotonic(), out)
    return out


def invalidate_variant_index() -> None:
    """Drop the cached index (called by every write path)."""
    _INDEX_CACHE.clear()


def _build_variant_index(root: Path) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    # skip the legacy single-file variant (kept for historical reference)
    for file in sorted(root.rglob("*.hip")):
        if file.name.startswith("w8a8_gemm_variants"):
            continue
        text = file.read_text(encoding="utf-8", errors="replace")
        header = _parse_variant_header(text)
        shape = header.get("shape") or file.stem
        rel = file.relative_to(root).parts
        # variant/<profile>/<family>/<model>/<TP>/<M>/<op>.hip  (pre-split trees
        # have no profile level and report UNMIGRATED_PROFILE instead).
        path_profile, rest = _split_profile(rel)
        out.append({
            "path": str(file.relative_to(root)),
            # Layout profile (where the file lives) and the recorded profile
            # (what the header claims) are reported separately: a disagreement
            # means someone moved a file by hand.
            "profile": path_profile,
            "hw_profile": header.get("hw_profile", ""),
            "machine": header.get("machine", ""),
            "measured_on": header.get("measured_on", ""),
            "shape": shape,
            "family": rest[0] if len(rest) > 0 else "",
            "model": rest[1] if len(rest) > 1 else "",
            "tp": rest[2] if len(rest) > 2 else "",
            "m": rest[3] if len(rest) > 3 else "",
            "operator": file.stem,
            "commit": header.get("commit", ""),
            "added": header.get("added", ""),
            "source": header.get("source", ""),
            "median_us": header.get("median_us"),
            "p90_us": header.get("p90_us"),
            "speedup": header.get("speedup"),
            "baseline_us": header.get("baseline_us"),
        })
    return out


# Header fields that carry machine-readable performance evidence. Only these
# are surfaced in the variant index (and the WebUI comparison dialog); the
# rest of the header/body is opaque to the index.
_HEADER_NUMERIC_FIELDS = frozenset({
    "median_us", "p90_us", "tops", "bandwidth_gb_s", "speedup", "baseline_us",
})
_HEADER_TEXT_FIELDS = frozenset({
    "commit", "added", "source", "hw_profile", "machine", "measured_on",
})


def _parse_variant_header(text: str) -> Dict[str, Any]:
    """Parse the machine-readable variant header of one kernel file.

    Returns ``{"shape": ..., "commit": ..., "median_us": ..., ...}`` with
    numeric metric fields converted to float; unknown ``key=value`` tokens
    inside the header block are ignored.
    """
    block = _HEADER_BLOCK_RE.search(text)
    if block is None:
        return {}
    fields: Dict[str, Any] = {"shape": block.group(1)}
    for key, value in re.findall(r"(\w+)=(\S+)", block.group(2)):
        if key in _HEADER_NUMERIC_FIELDS:
            try:
                fields[key] = float(value)
            except ValueError:
                fields[key] = value
        elif key in _HEADER_TEXT_FIELDS:
            fields[key] = value
    return fields


def backfill_variant_baselines() -> Dict[str, Any]:
    """Enrich variant headers that lack ``baseline_us``/``speedup``.

    Older variants (added before the add-route baseline fallback, or from
    stopped tasks without a final report) only carry ``median_us``/``p90_us``.
    This resolves each variant's ``(K, N)`` from its model/TP operator
    catalog, reads the fixed Triton baseline, and appends ``baseline_us`` and
    ``speedup`` to the header comment block. Idempotent: files that already
    carry a speedup, or for which no median / catalog entry / baseline can be
    resolved, are skipped untouched.
    """
    from metainfer.tasks.dcu_kernel_auto_opt.api.int8w8a8gemm.int8_w8a8_gemm_api import (  # noqa: PLC0415
        GLM52_TP4_OPERATOR_KN,
        GLM52_TP8_OPERATOR_KN,
        HY3_TP4_OPERATOR_KN,
        HY3_TP8_OPERATOR_KN,
        MINIMAX_TP4_OPERATOR_KN,
        MINIMAX_TP8_OPERATOR_KN,
        TP4_OPERATOR_KN,
        TP8_OPERATOR_KN,
    )
    from metainfer.tasks.dcu_kernel_auto_opt.orchestrator.w8a8_baselines import (  # noqa: PLC0415
        fixed_triton_graph_baseline,
        trusted_baseline_us,
    )

    tables: Dict[tuple, Dict[str, tuple]] = {
        ("deepseek-v4", "TP4"): TP4_OPERATOR_KN,
        ("deepseek-v4", "TP8"): TP8_OPERATOR_KN,
        ("hy3", "TP4"): HY3_TP4_OPERATOR_KN,
        ("hy3", "TP8"): HY3_TP8_OPERATOR_KN,
        ("minimax-m3", "TP4"): MINIMAX_TP4_OPERATOR_KN,
        ("minimax-m3", "TP8"): MINIMAX_TP8_OPERATOR_KN,
        ("glm52", "TP4"): GLM52_TP4_OPERATOR_KN,
        ("glm52", "TP8"): GLM52_TP8_OPERATOR_KN,
    }
    root = variant_root()
    updated: list[str] = []
    skipped: Dict[str, int] = {
        "has_speedup": 0, "no_median": 0, "no_catalog": 0, "no_baseline": 0,
    }
    if not root.exists():
        return {"updated": updated, "skipped": skipped}
    for file in sorted(root.rglob("*.hip")):
        if file.name.startswith("w8a8_gemm_variants"):
            continue
        rel = file.relative_to(root).parts
        if len(rel) < 4:
            continue
        model, tp, m_dir = rel[1], rel[2], rel[3]
        header = _parse_variant_header(
            file.read_text(encoding="utf-8", errors="replace")
        )
        if header.get("baseline_us") is not None or header.get("speedup") is not None:
            skipped["has_speedup"] += 1
            continue
        median = header.get("median_us")
        if median is None:
            skipped["no_median"] += 1
            continue
        table = tables.get((model, tp))
        if table is None:
            skipped["no_catalog"] += 1
            continue
        kn = next(
            (
                entry
                for key, entry in table.items()
                if key.replace(".", "_") == file.stem
            ),
            None,
        )
        if kn is None or not m_dir.startswith("M"):
            skipped["no_catalog"] += 1
            continue
        k, n = kn
        m = int(m_dir[1:])
        try:
            record = fixed_triton_graph_baseline(
                header.get("shape") or file.stem,
                {
                    "tp_size": int(tp[2:]),
                    "M": m,
                    "N": n,
                    "K": k,
                },
            )
            # Only backfill from this machine's own profile: the reference table
            # belongs to the other board, so the ratio would not be reproducible.
            baseline = trusted_baseline_us(record)
        except ValueError:
            baseline = None
        if baseline is None:
            skipped["no_baseline"] += 1
            continue
        speedup = float(baseline) / float(median)
        new_line = f"//   baseline_us={float(baseline):.6g} speedup={speedup:.6g}"
        text = file.read_text(encoding="utf-8", errors="replace")
        lines = text.splitlines(keepends=True)
        # Insert immediately after the ``// @@variant`` header line. Kernel
        # source comments also start with ``//`` and there is no blank line
        # between the header and the kernel, so only the @@variant anchor is
        # reliable.
        insert_at: int | None = None
        for index, line in enumerate(lines):
            if line.startswith("// @@variant"):
                insert_at = index
                break
        if insert_at is None:
            skipped["no_catalog"] += 1
            continue
        file.write_text(
            "".join(lines[: insert_at + 1])
            + new_line + "\n"
            + "".join(lines[insert_at + 1:]),
            encoding="utf-8",
        )
        updated.append(str(file.relative_to(root)))
    return {"updated": updated, "skipped": skipped}
