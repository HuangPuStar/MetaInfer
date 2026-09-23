"""Build a measured AHE question pool from historical DKAO final reports.

Sources are read-only (MetaInfer nodes/*/workspaces/*/final_report.json).
Output belongs under the isolated AHE root, e.g.
/root/zth_agent/ahe-kernel-repos/registered_pool.yaml.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict

import yaml

from .pool import family_of


def build_pool(meta_root: Path) -> Dict[str, Any]:
    entries: Dict[str, Dict[str, Any]] = {}
    for report_path in sorted(meta_root.glob("nodes/*/workspaces/*/final_report.json")):
        try:
            report = json.loads(report_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        config = report.get("config") or {}
        initial = report.get("initial_metrics") or {}
        final = report.get("final_validation") or {}
        for shape in config.get("shapes", []) or []:
            sid = str(shape.get("id") or "")
            if not sid:
                continue
            baseline = (initial.get(sid) or {}).get("baseline_us")
            if not isinstance(baseline, (int, float)) or baseline <= 0:
                continue
            metrics = final.get(sid) or {}
            median = metrics.get("median_us")
            current = entries.get(sid)
            best = (
                float(median) if isinstance(median, (int, float)) and median > 0
                else None
            )
            history = []
            if best is not None:
                history.append({
                    "accepted": True,
                    "median_us": best,
                    "p90_us": metrics.get("p90_us"),
                    "source_report": str(report_path),
                })
            row = {
                "id": sid,
                "contract": {
                    "model": str(config.get("model") or report.get("model") or
                                 report_path.parent.name),
                    "tp_size": int(shape.get("tp_size", 8)),
                    "operator": str(shape.get("operator") or ""),
                    "M": int(shape.get("M", 0)),
                    "N": int(shape.get("N", 0)),
                    "K": int(shape.get("K", 0)),
                },
                "family": family_of(int(shape.get("M", 0)),
                                    str(shape.get("operator") or "")),
                "baseline_us": float(baseline),
                "best_known_us": best,
                "history": history,
                "last_selected_round": None,
            }
            if current is None:
                entries[sid] = row
            else:
                # Keep the fixed baseline from the first valid report; merge
                # histories and retain the fastest measured best-known.
                current["history"].extend(history)
                if best is not None and (
                    current.get("best_known_us") is None
                    or best < current["best_known_us"]
                ):
                    current["best_known_us"] = best
                    current["contract"] = row["contract"]
    return {
        "schema_version": 1,
        "source": str(meta_root.resolve()),
        "instances": [entries[k] for k in sorted(entries)],
    }


def main(argv=None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--meta-root", type=Path,
                   default=Path("/root/zth_agent/MetaInfer"))
    p.add_argument("--out", type=Path,
                   default=Path("/root/zth_agent/ahe-kernel-repos/registered_pool.yaml"))
    args = p.parse_args(argv)
    data = build_pool(args.meta_root)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True),
                        encoding="utf-8")
    print(f"pool: {len(data['instances'])} instances -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
