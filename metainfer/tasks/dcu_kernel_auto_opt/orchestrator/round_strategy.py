"""Round-strategy texts: the per-round mandate menu, as evolvable data.

``w8a8_round_strategy`` in :mod:`prompts` used to embed every round mandate as
a Python string literal, so nothing about it could be versioned, reviewed or
evolved. This module is the *data* half of that function:

* :data:`BUILTIN_STRATEGY` holds the historical texts, byte-identical to the
  literals they replace, so an un-evolved harness behaves exactly as before;
* :func:`load_round_strategy` reads ``<harness_root>/systemprompt/
  round_strategy.yaml`` when the ``systemprompt`` component is marked wired in
  ``manifest.yaml``, and falls back to the built-in defaults otherwise
  (missing file, unwired component, malformed YAML — the same layering
  ``gates.yaml`` and ``planner_policy.yaml`` already use).

The decision *logic* stays in code: which branch applies is determined by
measured state (history, phase, PMC evidence, M, iteration budget), and only
the wording of each branch is data. That split is deliberate — it keeps
"what we tell the worker to do this round" evolvable without making the
round-selection state machine itself writable.

Templates use ``str.format`` fields. The only fields any template may use are
``iteration``, ``speedup``, ``artifact_dir``, ``completed``, ``split_candidates``,
``grid_blocks`` and ``cu_count``.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Tuple

from .harness_io import env_root, load_component_yaml

#: Component name in ``manifest.yaml``; ``wired: false`` makes this file inert.
COMPONENT = "systemprompt"
#: Path of the strategy menu inside a harness workspace.
RELATIVE_PATH = "systemprompt/round_strategy.yaml"

#: ``max_iterations`` below this makes the late-round branch unreachable.
LATE_START_FLOOR = 9

# --------------------------------------------------------------------------- #
# Built-in defaults (the historical literals, verbatim)
# --------------------------------------------------------------------------- #

REPAIR_UNKNOWN = (
    "Highest priority: repair the faster but incorrect candidate from "
    "iteration {iteration} (measured speedup "
    "{speedup}x). Read its archived source at "
    "`{artifact_dir}` and preserve the fast mapping. "
    "Fix only the smallest correctness defect: signed int8 unpacking, "
    "tail bounds, scale indexing, bf16 conversion, or a race. Do not "
    "replace it with an unrelated architecture."
)

REPAIR_INFRASTRUCTURE = (
    "The preceding attempt failed in the agent infrastructure. "
    "Return to the accepted best source and start a new bounded "
    "experiment; do not repair or replay a partially written "
    "candidate. This failure does not count as a completed "
    "optimization round."
)

REPAIR_BUILD = (
    "Repair the immediately preceding candidate from iteration "
    "{iteration} at `{artifact_dir}`. "
    "Keep its strategy and make only the minimum compile/API/syntax "
    "correction; do not start another redesign this round."
)

ISA_GUIDED = (
    "ISA-guided HIP round. This is successful ISA experiment "
    "{completed} of at least 2. Select one measured memory or "
    "compute bottleneck, compare the exact primary-kernel ISA with "
    "the preceding code object, and make one HIP/DUMMA/intrinsic "
    "code-shaping change. Raw inline asm remains forbidden. Record "
    "a compiler limitation only when the before/after binary proves "
    "it and name the exact target instructions."
)

CONDITIONAL_INLINE_ASM = (
    "Conditional inline-asm experiment. Target only the compiler "
    "limitation and exact instructions verified by the immediately "
    "preceding ISA-guided HIP round. Keep the asm block minimal, "
    "preserve complete constraints/clobbers, and reject it unless "
    "the candidate ISA, exact correctness, median, P90, and resources "
    "all validate. Do not write raw global/buffer/flat loads or MMAC."
)

#: Evidence-qualified suffixes appended after a portfolio mandate. The leading
#: space is added by the caller, never stored here: the same text is used both
#: as the built-in fallback and as the template loaded from the harness file,
#: and the two paths have to render identically.
APPEND_SPLIT_CANDIDATES = (
    "Trusted occupancy-probe split candidates for the measured CU "
    "count are {split_candidates}. They include non-power-of-two "
    "values where useful, are not a whitelist, and must fit the "
    "workspace and stage-alignment constraints. Explore outside this "
    "set when evidence supports it."
)

APPEND_GRID_WARNING = (
    "Trusted control-plane warning: current grid has {grid_blocks} "
    "blocks for {cu_count} CUs, below the two-blocks-per-CU latency-"
    "hiding target. Before micro-optimization, benchmark a finer "
    "one-wave zero-barrier grid or multiple legal split-K candidates "
    "including combine cost."
)

#: Shared late-round mandates (the 9th/10th slot of the >=128 and 16..127
#: portfolios; the <16 portfolio never reaches them).
LATE_ISA_DIAGNOSIS = (
    "Late ISA-diagnosis round. Only if the control-plane plateau gate "
    "is open, use one selected ISA Skill and trusted disassembly to "
    "shape compiler output through HIP/DUMMA/intrinsics. Raw inline "
    "asm remains forbidden. Otherwise continue HIP-only exploration."
)

LATE_CONDITIONAL_INLINE_ASM = (
    "Final conditional inline-asm round. Raw asm is allowed only when "
    "the control plane confirms a HIP plateau and the prior ISA-guided "
    "round recorded one concrete compiler limitation plus target "
    "instructions. Otherwise make one HIP-only consolidation change."
)

SMALL: Dict[int, str] = {
    1: "Vectorize contiguous K loads with exact signed-int8 semantics.",
    2: (
        "Increase instruction-level parallelism with independent int32 "
        "accumulators or adjacent N outputs; avoid per-K-tile LDS barriers."
    ),
    3: (
        "Stage all of tiny A once with at most one barrier, or tune unroll "
        "one step if whole-A staging is not cheaper."
    ),
    4: (
        "Change one launch variable only: waves per block, N columns per "
        "wave, or unroll factor."
    ),
    5: (
        "HIP-only memory round: change one vector-load width, contiguous "
        "N mapping, or whole-A reuse decision. Raw inline asm is forbidden."
    ),
    6: (
        "HIP-only pipeline round: reduce one dependency chain or barrier "
        "using ordinary HIP/intrinsics. Raw inline asm is forbidden."
    ),
    7: (
        "HIP-only resource round: tune one block size, unroll factor, or "
        "live range while preserving coalescing. Raw inline asm is forbidden."
    ),
    8: (
        "HIP-only consolidation round: revisit the fastest correct archived "
        "mapping and make one final architecture/codegen improvement. Raw "
        "inline asm is forbidden."
    ),
}

M16: Dict[int, str] = {
    1: (
        "Establish a minimal 16x16x32 DUMMA tile with the exact API below, "
        "one wave per output tile and explicit int32 accumulation. If the "
        "seed already has a correct DUMMA kernel, preserve it and instead "
        "test the smallest one-wave-per-block, one-N-tile geometry with no "
        "cross-wave barrier; do not spend the round reimplementing it."
    ),
    2: (
        "Architecture round: measure grid parallelism before polishing. "
        "Explore one complete launch geometry among 1/2/4 waves per block "
        "and 1/2/4 adjacent N tiles. Prefer enough independent blocks to "
        "cover at least all device CUs; report grid_blocks, waves_per_block "
        "and estimated_active_cus in proposal.json."
    ),
    3: (
        "Architecture round: if the unsplit grid has fewer than two "
        "blocks per device CU and K >= 1024, implement and measure "
        "split-K=2 plus at least one CU-aligned candidate (which may be "
        "non-power-of-two), or test a one-wave zero-barrier geometry that "
        "reaches the same parallelism. Write int32 partials into the "
        "caller workspace and include the combine+scale kernel in the "
        "timed Graph."
    ),
    4: (
        "Architecture/pipeline round: explore one of multi-N-tile reuse, "
        "A-only staging, or bounded register/LDS prefetch. Retain enough "
        "blocks to cover all CUs, state which A/B bytes are reused, and "
        "measure whether the change improves normal median/P90."
    ),
    5: (
        "HIP-only packed-weight/staging round: compare one packed layout, "
        "A-only staging, or B-only staging design. Raw inline asm is forbidden."
    ),
    6: (
        "Pipeline round: choose exactly one staging family from direct, "
        "A-only LDS, B-only LDS, or A+B LDS using L2/VMEM evidence. Use "
        "coalesced 8- or 16-byte cooperative loads and report HBM/LDS byte "
        "changes; do not claim asynchronous overlap without evidence."
    ),
    7: (
        "Pipeline round: compare single buffering with double buffering "
        "only when K>=1024, L2 hit rate is below 70%, and the doubled LDS "
        "budget stays below 48 KiB. Count barriers per K step."
    ),
    8: (
        "HIP-only resource round: tune one occupancy limiter using actual "
        "PMC evidence: waves per block, VGPR live range, LDS footprint, "
        "or spill removal. Do not trade repeated HBM reads for occupancy."
    ),
    9: LATE_ISA_DIAGNOSIS,
    10: LATE_CONDITIONAL_INLINE_ASM,
}

LARGE: Dict[int, str] = {
    1: (
        "Establish a correct DUMMA throughput baseline using a 2-D "
        "macro-tile. Benchmark 64x64, 64x128, and 128x64 block tiles; "
        "record waves per block, VGPRs, LDS bytes, occupancy and TOPS."
    ),
    2: (
        "Operand-reuse round: compare direct loads with cooperative "
        "A+B LDS staging. Quantify A/B reuse per macro-tile and use "
        "vectorized coalesced global loads with a bank-safe LDS layout."
    ),
    3: (
        "Pipeline round: compare single and double buffering across K "
        "tiles. Retain double buffering only when ISA/PMC evidence shows "
        "reduced VMEM stalls without harmful LDS or occupancy growth."
    ),
    4: (
        "Tile-shape round: tune M-tile versus N-tile aspect ratio for "
        "this exact M/N/K, balancing B reuse, A reuse and enough blocks "
        "to occupy every CU. Do not inherit decode launch geometry."
    ),
    5: (
        "Packing round: test one weight packing/swizzle that makes each "
        "DUMMA B tile vector-loadable and LDS-bank-safe. Include packing "
        "outside timing and validate the graph-stable packed layout."
    ),
    6: (
        "Epilogue round: fuse per-row and per-column scales, bf16 "
        "conversion and the final coalesced store into the compute "
        "kernel; remove any unnecessary workspace/combine pass."
    ),
    7: (
        "Compute-pipeline round: tune DUMMA issue grouping, prefetch "
        "distance and accumulator independence using ISA stall evidence. "
        "Raw inline asm remains forbidden."
    ),
    8: (
        "Resource round: tune waves per block, VGPR live ranges and LDS "
        "footprint from measured occupancy. Recheck the best tile family "
        "with normal median/P90 measurements."
    ),
    9: LATE_ISA_DIAGNOSIS,
    10: LATE_CONDITIONAL_INLINE_ASM,
}

BUILTIN_STRATEGY: Dict[str, Any] = {
    "repair": {
        "faster_wrong": REPAIR_UNKNOWN,
        "infrastructure_failure": REPAIR_INFRASTRUCTURE,
        "build_failure": REPAIR_BUILD,
    },
    "phases": {
        "isa_guided_hip": ISA_GUIDED,
        "conditional_inline_asm": CONDITIONAL_INLINE_ASM,
    },
    "append": {
        "split_candidates": APPEND_SPLIT_CANDIDATES,
        "grid_warning": APPEND_GRID_WARNING,
    },
    "portfolios": {
        "small": {str(k): v for k, v in SMALL.items()},
        "m16": {str(k): v for k, v in M16.items()},
        "large": {str(k): v for k, v in LARGE.items()},
    },
}

#: Regime keys a harness file may define; a subset falls back per-key.
_PORTFOLIOS = ("small", "m16", "large")


# --------------------------------------------------------------------------- #
# Loading
# --------------------------------------------------------------------------- #

_CACHE_KEY: Optional[Tuple[str, float, float]] = None
_CACHE_VALUE: Optional["RoundStrategy"] = None


@dataclass(frozen=True)
class RoundStrategy:
    """Round mandates for one harness workspace (built-in or harness file)."""

    repair: Mapping[str, str]
    phases: Mapping[str, str]
    append: Mapping[str, str]
    portfolios: Mapping[str, Mapping[str, str]]
    source: str = "builtin"
    #: Non-fatal problems found while loading (reported, never raised).
    notes: Tuple[str, ...] = field(default=())

    def text(self, key: str, **fields: Any) -> str:
        """Render one template by key path (``repair.build_failure``)."""
        node: Any = {
            "repair": self.repair,
            "phases": self.phases,
            "append": self.append,
        }
        for part in key.split("."):
            node = (node or {}).get(part) if isinstance(node, Mapping) else None
        if not isinstance(node, str) or not node:
            return ""
        try:
            return node.format(**fields)
        except (KeyError, IndexError, ValueError):
            return node

    def mandate(self, regime: str, iteration: int) -> Optional[str]:
        """The portfolio entry for one round, or None when it has no slot."""
        portfolio = self.portfolios.get(regime) or self.portfolios.get("m16") or {}
        entry = portfolio.get(str(int(iteration)))
        return entry if isinstance(entry, str) and entry else None

    def slot(self, regime: str, slot: int) -> str:
        """A numbered slot, falling back within the portfolio (never raises)."""
        portfolio = self.portfolios.get(regime) or {}
        for candidate in (str(int(slot)), str(LATE_START_FLOOR)):
            entry = portfolio.get(candidate)
            if isinstance(entry, str) and entry:
                return entry
        # Last resort: the highest-numbered slot the portfolio does define.
        keys = sorted((k for k in portfolio if str(k).isdigit()), key=int)
        return str(portfolio[keys[-1]]) if keys else ""


def builtin_strategy() -> Dict[str, Any]:
    """A deep-ish copy of the historical defaults (safe to mutate)."""
    return {
        "repair": dict(BUILTIN_STRATEGY["repair"]),
        "phases": dict(BUILTIN_STRATEGY["phases"]),
        "append": dict(BUILTIN_STRATEGY["append"]),
        "portfolios": {
            name: dict(BUILTIN_STRATEGY["portfolios"][name])
            for name in _PORTFOLIOS
        },
    }


def _component_wired(root: Optional[Path]) -> bool:
    """``manifest.yaml`` decides whether the systemprompt component applies."""
    try:
        from . import gate_policy as _gates
        return _gates.component_wired(COMPONENT, root)
    except Exception:  # noqa: BLE001 - a missing manifest means "apply it"
        return True


def _merge(defaults: Dict[str, Any], overlay: Mapping[str, Any],
           notes: List[str]) -> Dict[str, Any]:
    """Overlay a harness file onto the defaults, key by key.

    A key the file omits keeps its built-in value, so a partial harness file
    never blanks out a branch. Wrong types are ignored and reported in
    ``notes`` instead of raising: a malformed harness must not stop a run.
    """
    out = builtin_strategy()
    if not isinstance(overlay, Mapping):
        notes.append("strategy file is not a mapping; built-in defaults used")
        return out
    for section in ("repair", "phases", "append"):
        data = overlay.get(section)
        if data is None:
            continue
        if not isinstance(data, Mapping):
            notes.append(f"{section}: expected a mapping, ignored")
            continue
        for key, value in data.items():
            if isinstance(value, str) and value.strip():
                out[section][str(key)] = value
            else:
                notes.append(f"{section}.{key}: expected a non-empty string, ignored")
    portfolios = overlay.get("portfolios")
    if portfolios is not None:
        if not isinstance(portfolios, Mapping):
            notes.append("portfolios: expected a mapping, ignored")
        else:
            for name, entries in portfolios.items():
                if name not in _PORTFOLIOS:
                    notes.append(f"portfolios.{name}: unknown regime, ignored")
                    continue
                if not isinstance(entries, Mapping):
                    notes.append(f"portfolios.{name}: expected a mapping, ignored")
                    continue
                for slot, value in entries.items():
                    if isinstance(value, str) and value.strip():
                        out["portfolios"][str(name)][str(slot)] = value
                    else:
                        notes.append(
                            f"portfolios.{name}.{slot}: expected a non-empty "
                            "string, ignored")
    return out


def load_round_strategy(root: Optional[Path] = None,
                        *, use_cache: bool = True) -> RoundStrategy:
    """Effective round-strategy texts for this harness workspace.

    Order: ``<root>/systemprompt/round_strategy.yaml`` when the component is
    wired -> built-in defaults. Cached on (path, file mtime, manifest mtime) so
    a mid-run harness swap is picked up, exactly like :mod:`gate_policy`.
    """
    global _CACHE_KEY, _CACHE_VALUE

    workspace = Path(root) if root is not None else env_root()
    path = workspace / RELATIVE_PATH
    manifest = workspace / "manifest.yaml"
    try:
        key = (str(path),
               path.stat().st_mtime if path.is_file() else 0.0,
               manifest.stat().st_mtime if manifest.is_file() else 0.0)
    except OSError:
        key = (str(path), 0.0, 0.0)

    if use_cache and _CACHE_KEY == key and _CACHE_VALUE is not None:
        return _CACHE_VALUE

    notes: List[str] = []
    source = "builtin"
    data: Dict[str, Any] = builtin_strategy()
    if not _component_wired(workspace):
        notes.append(f"{COMPONENT} component is wired:false; built-in defaults used")
    else:
        overlay, error = load_component_yaml(RELATIVE_PATH, root=workspace)
        if error:
            notes.append(error)
        elif overlay:
            data = _merge(data, overlay, notes)
            source = str(path)

    value = RoundStrategy(
        repair=data["repair"], phases=data["phases"], append=data["append"],
        portfolios=data["portfolios"], source=source, notes=tuple(notes),
    )
    if use_cache:
        _CACHE_KEY, _CACHE_VALUE = key, value
    return value


def reset_cache() -> None:
    """Drop the memoised strategy (tests and mid-run swaps)."""
    global _CACHE_KEY, _CACHE_VALUE
    _CACHE_KEY, _CACHE_VALUE = None, None
