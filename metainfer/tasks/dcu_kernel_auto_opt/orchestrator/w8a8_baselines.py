"""Profile-scoped Triton W8A8 Graph baselines.

Baselines are **hardware dependent**, so they are stored per hardware profile:

    baselines/<profile>.json

Background (see ``wiki-metainfer/knowledge-packs.md``): the two machines share
one chip and one codebase, but the air-cooled board has no HBM address hashing,
so its concurrent strided reads lose about half the bandwidth.  Measured on
2026-09-29 against 15 TP8 M=8 shapes, the air Triton baseline is **1.06x-1.40x
slower** than the liquid one, and the gap is *operator dependent* (worst on
small-K, read-heavy ``shared_down_proj`` shapes; smallest on large-K compute
bound ones).  A single scaling factor would therefore be wrong, and comparing an
air measurement against a liquid baseline silently overstates the gap.

Lookup order for a shape:

1. the machine's own profile table      -> ``profile_mismatch=False``
2. the reference (liquid) table         -> ``profile_mismatch=True``, and the
   record says so; callers that record knowledge (variant speedups, backfills)
   must **not** turn this into a "speedup"
3. neither table                        -> :class:`BaselineUnavailable`

Records keep the historical field set (``median_us``, ``baseline_us``,
``baseline_kind``, ``case``, ``tp_size``, ``shape``, ``timing_scope``,
``distribution_stats_available``, plus the TP8 distribution fields) and add the
provenance: ``baseline_profile``, ``baseline_machine``, ``baseline_measured_on``,
``profile_mismatch``, ``profile_note``.

To measure a new profile (or extend one), run the recorded protocol and write
the result into its JSON: ``baseline/bench_triton_tp8_m4096.py`` and
``baseline/bench_triton_tp8_m8.py`` (three independent passes, per-shape median).
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, Mapping, Optional, Tuple

from metainfer.orchestrator import hw_profile as _hw_profile

BASELINES_DIR = Path(__file__).resolve().parents[1] / "baselines"

#: Every measurement made before 2026-09-25 came from this board.  It is the
#: fallback *reference* (never silently presented as a local measurement).
REFERENCE_PROFILE = "liquid-k500sm"


class BaselineUnavailable(ValueError):
    """No baseline exists for this shape in any profile.

    Subclasses ``ValueError`` on purpose: existing call sites already guard the
    baseline lookup with ``except ValueError`` and degrade to "no baseline".
    """


@lru_cache(maxsize=8)
def _load_profile(profile: str) -> Dict[str, Any]:
    """Read one profile's table file (missing file = empty table, not an error)."""
    path = BASELINES_DIR / f"{profile}.json"
    if not path.is_file():
        return {"graph": {}, "tp8": {}, "meta": {"hw_profile": profile}}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        payload = None
    if not isinstance(payload, dict):
        return {"graph": {}, "tp8": {}, "meta": {"hw_profile": profile}}
    return {
        "graph": payload.get("graph") or {},
        "tp8": payload.get("tp8") or {},
        "meta": payload,
    }


def reload_tables() -> None:
    """Drop the per-process table cache (after adding measurements)."""
    _load_profile.cache_clear()


def profiles_with_baselines() -> Dict[str, int]:
    """How many shapes each profile has measured (for the UI / diagnostics)."""
    counts: Dict[str, int] = {}
    if not BASELINES_DIR.is_dir():
        return counts
    for path in sorted(BASELINES_DIR.glob("*.json")):
        table = _load_profile(path.stem)
        counts[path.stem] = len(table["graph"]) + len(table["tp8"])
    return counts


def _key(shape: Mapping[str, Any]) -> Tuple[int, int, int, int]:
    try:
        return (
            int(shape.get("tp_size", 4)),
            int(shape["M"]),
            int(shape["N"]),
            int(shape["K"]),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError(f"invalid W8A8 shape: {shape}") from exc


def _key_str(key: Tuple[int, int, int, int]) -> str:
    return "%d,%d,%d,%d" % key


def current_profile() -> Optional[str]:
    """The detected profile of this machine, or None when it is unknown."""
    try:
        return _hw_profile.profile_id()
    except _hw_profile.HardwareProfileError:
        return None


def _measurement(table: Dict[str, Any], key: str) -> Tuple[Optional[tuple], str]:
    """(measurement, kind) from one profile table, preferring the TP8 rows."""
    found = table["tp8"].get(key)
    if found is not None:
        return found, "tp8"
    return table["graph"].get(key), "graph"


def baseline_origin(record: Any) -> Tuple[str, bool]:
    """``(profile, mismatch)`` of a baseline *number*, whatever produced it.

    Two shapes of record exist in this workspace:

    1. records from :func:`fixed_triton_graph_baseline`, which carry
       ``baseline_profile`` / ``profile_mismatch`` (i.e. proven provenance);
    2. records written before the profile split, e.g. a task report whose
       ``initial_metrics`` came from the hardcoded table
       (``source: user_supplied_fixed_table``) -- a bare number or a dict with no
       provenance field at all.

    Shape 2 is **not** neutral: the hardcoded table *is* the reference board's
    data, so such a number is attributed to :data:`REFERENCE_PROFILE` rather
    than being trusted as "this machine's".  That attribution is what stops a
    pre-split task on the air board from recording a cross-profile speedup
    (measured case: an air variant carried ``baseline_us=19.98 speedup=1.967``
    from the liquid table while this board's own value for the same shape is
    25.936 us).
    """
    if isinstance(record, Mapping):
        profile = record.get("baseline_profile")
        if profile:
            return str(profile), bool(record.get("profile_mismatch"))
    return REFERENCE_PROFILE, False


def trusted_baseline_us(
    record: Any,
    *,
    profile: Optional[str] = None,
    allow_reference_profile: bool = False,
) -> Optional[float]:
    """``median_us`` of ``record``, but only when it provably came from ``profile``.

    Returns ``None`` when the number belongs to another board (or to an
    unknown one) -- callers that *record knowledge* (variant promotion, header
    backfill, reports) must then omit ``baseline_us``/``speedup`` instead of
    filing a ratio that cannot be reproduced here.  A machine whose profile
    cannot be resolved has nothing provably local, so it gets ``None`` too.

    ``allow_reference_profile=True`` is the explicit opt-in used when the
    reference number is only displayed, never recorded as a same-machine
    comparison.
    """
    if isinstance(record, Mapping):
        median = record.get("median_us")
        if median is None:
            median = record.get("baseline_us")
    else:
        median = record
    if median is None:
        return None
    used_profile, mismatch = baseline_origin(record)
    current = profile if profile is not None else current_profile()
    if current is None:
        return None
    if used_profile == current and not mismatch:
        return float(median)
    if allow_reference_profile and used_profile == REFERENCE_PROFILE:
        return float(median)
    return None


def fixed_triton_graph_baseline(
    shape_id: str,
    shape: Mapping[str, Any],
    *,
    bootstrap_metrics: Optional[Mapping[str, Any]] = None,
    hw_profile: Optional[str] = None,
    allow_reference_profile: bool = True,
) -> Dict[str, Any]:
    """Return the immutable Graph baseline for one exact M/N/K shape.

    Resolution is per hardware profile; when this machine's profile has not
    measured the shape, the reference table is used only if
    ``allow_reference_profile`` is set, and the returned record is flagged with
    ``profile_mismatch=True`` so no caller can mistake it for a same-machine
    comparison.

    ``bootstrap_metrics`` remains separate because it describes the current
    child HIP source used for PMC, rollback and iterative improvement.
    """
    profile = hw_profile if hw_profile is not None else current_profile()
    key = _key(shape)
    key_str = _key_str(key)
    lookup_profile = profile or REFERENCE_PROFILE

    table = _load_profile(lookup_profile)
    measurement, kind = _measurement(table, key_str)
    used_profile = lookup_profile
    mismatch = False
    used_meta = table["meta"]

    if measurement is None and lookup_profile != REFERENCE_PROFILE:
        reference = _load_profile(REFERENCE_PROFILE)
        if allow_reference_profile:
            measurement, kind = _measurement(reference, key_str)
            if measurement is not None:
                mismatch = True
                used_profile = REFERENCE_PROFILE
                used_meta = reference["meta"]

    if measurement is None:
        raise BaselineUnavailable(
            "no fixed Triton Graph baseline for "
            f"{shape_id} with TP={key[0]}, M={key[1]}, N={key[2]}, K={key[3]} "
            f"(profile {lookup_profile!r} has no entry, and the "
            f"{REFERENCE_PROFILE!r} reference has none either)"
        )

    if kind == "tp8":
        case, eager_median_us, eager_p90_us, latency_us, graph_p90_us = measurement
        distribution = True
    else:
        case, latency_us = measurement
        distribution = False
        eager_median_us = eager_p90_us = graph_p90_us = None

    record: Dict[str, Any] = {
        "median_us": latency_us,
        "baseline_us": latency_us,
        "baseline_kind": "triton_graph",
        "case": case,
        "tp_size": key[0],
        "shape": {"M": key[1], "N": key[2], "K": key[3]},
        "source": f"profile_table:{used_profile}",
        "timing_scope": (
            "prefill_graph_replay" if key[1] > 16
            else "decode_graph_replay"
        ),
        "distribution_stats_available": distribution,
        # Provenance: which machine produced this number.
        "baseline_profile": used_profile,
        "baseline_machine": used_meta.get("machine"),
        "baseline_measured_on": used_meta.get("measured_on"),
        "profile_mismatch": mismatch,
    }
    if mismatch:
        record["profile_note"] = (
            f"no {lookup_profile!r} baseline for this shape; using the "
            f"{REFERENCE_PROFILE!r} reference. speedup against it is NOT a "
            "same-machine comparison (air boards have no HBM address hashing, "
            "so the reference is 1.06x-1.40x faster depending on the shape)."
        )
    if distribution:
        record.update(
            {
                "p90_us": graph_p90_us,
                "eager_median_us": eager_median_us,
                "eager_p90_us": eager_p90_us,
                "cache_state": "hot",
                "measurement_protocol": {
                    "warmups": 50 if key[1] == 16 else 10,
                    "samples": 50 if key[1] == 16 else 20,
                    "launches_per_sample": 20 if key[1] == 16 else 5,
                },
            }
        )
    if bootstrap_metrics is not None:
        record["bootstrap_metrics"] = dict(bootstrap_metrics)
    return record
