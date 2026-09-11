#!/usr/bin/env python3
"""Offline parity analysis: planner (v0) vs the legacy round menu.

Read-only tool over historical task repos under ``kernel-repos`` (and optionally
workspace ``iterations``). For each recorded round it reconstructs the state
(prior same-worker/same-shape records + pmc evidence), reproduces what the
legacy menu (``w8a8_round_strategy``) would mandate, asks what the
state-conditioned ``planner`` would pick, maps both to coarse plan families, and
reports agreement/divergence by M regime and iteration bucket, plus samples.

Caveats (read the output with these in mind):
- State reconstruction is approximate: pmc evidence is frequently absent in
  records, so the planner often falls back to its P4 legacy approximation.
- The menu text -> family mapping is a keyword heuristic.
- This tool never writes into the repos; it only prints / dumps a report.

Usage:
    python3 tools/planner_parity.py [--kernel-repos ROOT] [--limit-repos N]
                                    [--out /tmp/planner_parity_report.json]
"""

from __future__ import annotations

import argparse
import collections
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Make the plugin importable when run as a script from the plugin tree.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # .../dcu_kernel_auto_opt
sys.path.insert(0, str(Path(__file__).resolve().parents[4]))  # MetaInfer/

from metainfer.tasks.dcu_kernel_auto_opt.orchestrator import planner as planner_mod  # noqa: E402
from metainfer.tasks.dcu_kernel_auto_opt.orchestrator.planner import choose_plan_from_history  # noqa: E402
from metainfer.tasks.dcu_kernel_auto_opt.orchestrator.prompts import w8a8_round_strategy  # noqa: E402
from metainfer.tasks.dcu_kernel_auto_opt.orchestrator.w8a8_pipeline import isa_round_policy  # noqa: E402

_MENU_FAMILY_RULES: List[Tuple[str, str]] = [
    # Explicit markers first so generic words inside round prose do not win.
    ("faster but incorrect", "repair"),
    ("faster_wrong", "repair"),
    ("repair", "repair"),
    ("conditional inline-asm", "inline_asm"),
    ("inline asm", "inline_asm"),
    ("ISA-guided", "isa_guided"),
    ("ISA", "isa"),
    ("split-K", "grid_splitk"),
    ("split_k", "grid_splitk"),
    ("consolidat", "consolidate"),
    ("epilogue", "epilogue"),
    ("Architecture round", "architecture"),
    ("Architecture/pipeline round", "architecture"),
    ("macro-tile", "architecture"),
    ("tile-shape", "architecture"),
    ("geometry", "architecture"),
    ("tile", "architecture"),
    ("architecture", "architecture"),
    ("packing", "memory_layout"),
    ("packed", "memory_layout"),
    ("swizzle", "memory_layout"),
    ("bank", "memory_layout"),
    ("layout", "memory_layout"),
    ("double buff", "pipeline"),
    ("prefetch", "pipeline"),
    ("staging", "pipeline"),
    ("barrier", "pipeline"),
    ("pipeline", "pipeline"),
    ("occupancy", "occupancy"),
    ("waves per block", "occupancy"),
    ("VGPR", "occupancy"),
    ("register", "occupancy"),
    ("bootstrap", "bootstrap"),
    ("scalar", "bootstrap"),
]

_PLAN_TO_FAMILY = {
    "repair_faster_wrong": "repair",
    "fix_build": "repair",
    "retry_same": "repair",
    "bootstrap_correctness": "bootstrap",
    "establish_arch": "architecture",
    "architecture_explore": "architecture",
    "grid_splitk": "grid_splitk",
    "pipeline_tune": "pipeline",
    "memory_layout": "memory_layout",
    "occupancy_resource": "occupancy",
    "epilogue_fusion": "epilogue",
    "isa_guided_hip": "isa_guided",
    "conditional_inline_asm": "inline_asm",
    "consolidate": "consolidate",
}


def menu_family(text: str) -> str:
    lowered = text.lower()
    for needle, family in _MENU_FAMILY_RULES:
        if needle in lowered:
            return family
    return "unknown"


def iter_number_from_path(path: Path) -> int:
    m = re.search(r"iteration(\d+)", path.name)
    if m:
        return int(m.group(1))
    # parent dirs like .../iteration13/iteration.json
    m = re.search(r"iteration(\d+)", path.parent.name)
    return int(m.group(1)) if m else -1


def load_records(root: Path, limit_repos: Optional[int]) -> List[Tuple[str, Dict[str, Any]]]:
    """Return (repo_dir_name, record) for every candidate iteration.json."""
    records: List[Tuple[str, Dict[str, Any]]] = []
    repos = sorted(p for p in root.iterdir() if p.is_dir())
    if limit_repos:
        repos = repos[:limit_repos]
    for repo in repos:
        for path in sorted(
            p for p in repo.rglob("iteration.json")
            if "candidates" in p.parts
        ):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if isinstance(data, dict):
                records.append((repo.name, data))
    return records


def analyze(root: Path, limit_repos: Optional[int]) -> Dict[str, Any]:
    records = load_records(root, limit_repos)
    chains: Dict[Tuple[str, str, str], List[Dict[str, Any]]] = collections.defaultdict(list)
    for repo, rec in records:
        worker = str(rec.get("worker_id", "?"))
        shape = rec.get("shape_id", "?")
        iteration = iter_number_from_path(Path(str(rec.get("record_path", "iteration0")))) if False else int(rec.get("iteration", 0))
        chains[(repo, worker, shape)].append(
            {"record": rec, "iteration": iteration}
        )

    stats = collections.Counter()
    buckets: Dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    samples: List[Dict[str, Any]] = []

    for (repo, worker, shape_id), entries in chains.items():
        entries.sort(key=lambda e: e["iteration"])
        history: List[Dict[str, Any]] = []
        for entry in entries:
            rec = entry["record"]
            iteration = entry["iteration"]
            shape = rec.get("shape", {}) or {}
            m = int(shape.get("M", 0) or 0)
            regime = "prefill(M>=128)" if m >= 128 else ("m16" if m >= 16 else "small(M<16)")
            pmc = rec.get("pmc_evidence") or {}

            try:
                policy = isa_round_policy(
                    iteration=iteration,
                    max_iterations=10,
                    history=history,
                )
                menu_text = w8a8_round_strategy(
                    shape, iteration, history, pmc,
                    max_iterations=10, isa_policy=policy,
                )
            except Exception as exc:  # noqa: BLE001
                stats["menu_error"] += 1
                history.append(rec)
                continue

            menu_fam = menu_family(menu_text)
            try:
                plan_id = choose_plan_from_history(
                    history, pmc, iteration=iteration, max_iterations=10,
                    shape=shape,
                    compiler_limitation_confirmed=(
                        policy.get("phase") == "conditional_inline_asm"
                    ),
                )
            except Exception as exc:  # noqa: BLE001
                stats["planner_error"] += 1
                history.append(rec)
                continue

            plan_fam = _PLAN_TO_FAMILY.get(plan_id, "unknown")
            agree = (menu_fam == plan_fam)
            stats["total"] += 1
            stats["agree" if agree else "disagree"] += 1
            bucket_key = f"{regime}|iter{min(iteration, 12)}"
            buckets[bucket_key]["agree" if agree else "disagree"] += 1

            if not agree and len(samples) < 40:
                samples.append({
                    "repo": repo,
                    "shape_id": shape_id,
                    "iteration": iteration,
                    "regime": regime,
                    "menu_family": menu_fam,
                    "plan_family": plan_fam,
                    "plan_id": plan_id,
                    "hypothesis": str(rec.get("hypothesis") or "")[:200],
                })
            history.append(rec)

    total = stats.get("total", 0)
    return {
        "corpus": {"repos_scanned": len(set(r for r, _ in records)) if records else 0,
                    "records": len(records)},
        "stats": dict(stats),
        "agree_rate": (stats.get("agree", 0) / total) if total else None,
        "buckets": {
            k: dict(v) for k, v in sorted(buckets.items())
        },
        "samples": samples,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kernel-repos", type=Path,
                        default=Path(__file__).resolve().parents[2].parent.parent.parent / "kernel-repos")
    parser.add_argument("--limit-repos", type=int, default=None)
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    if not args.kernel_repos.is_dir():
        print(f"kernel-repos not found at {args.kernel_repos}", file=sys.stderr)
        return 2

    report = analyze(args.kernel_repos, args.limit_repos)
    total = report["stats"].get("total", 0)
    print(f"corpus: {report['corpus']['records']} records / {report['corpus']['repos_scanned']} repos")
    print(f"agree={report['stats'].get('agree',0)} disagree={report['stats'].get('disagree',0)} "
          f"agree_rate={report['agree_rate']:.1%}" if report["agree_rate"] is not None
          else f"agree={report['stats'].get('agree',0)} disagree={report['stats'].get('disagree',0)}")
    print("--- buckets (regime|iteration): agree/disagree ---")
    for k, v in list(report["buckets"].items())[:40]:
        print(f"  {k}: {v}")
    print("--- divergence samples ---")
    for s in report["samples"][:10]:
        print(f"  [{s['repo']} {s['shape_id']} it{s['iteration']} {s['regime']}] "
              f"menu={s['menu_family']} plan={s['plan_family']} ({s['plan_id']})")
        print(f"      hypo: {s['hypothesis'][:150]}")

    if args.out:
        args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2),
                            encoding="utf-8")
        print(f"report -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
