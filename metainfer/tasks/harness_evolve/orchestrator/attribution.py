"""Attribution / flip / rollback helpers (ported semantics from ahe-ref)."""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any, Dict, List


def pass_rate(results: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    items = list(results.values())
    n = len(items)
    n_pass = sum(1 for r in items if r.get("passed") is True)
    return {
        "n_total": n,
        "n_pass": n_pass,
        "pass_rate": (n_pass / n) if n else 0.0,
    }


def diff_results(
    prev: Dict[str, Dict[str, Any]] | None,
    curr: Dict[str, Dict[str, Any]],
) -> Dict[str, Any]:
    """Cross-iteration diff (bool-level; three-state noise lives in real eval).

    flipped: fail -> pass   regressed: pass -> fail   unchanged otherwise.
    """
    prev = prev or {}
    flipped: List[str] = []
    regressed: List[str] = []
    for inst_id, r in curr.items():
        p_ok = bool((prev.get(inst_id) or {}).get("passed") is True)
        c_ok = bool(r.get("passed") is True)
        if not p_ok and c_ok:
            flipped.append(inst_id)
        elif p_ok and not c_ok:
            regressed.append(inst_id)
    return {
        "flipped": sorted(flipped),
        "regressed": sorted(regressed),
        "net": len(flipped) - len(regressed),
    }


def evaluate_changes(manifest: Dict[str, Any], diff: Dict[str, Any]) -> Dict[str, Any]:
    """change_manifest -> per-change verdicts (schema mirrors ahe-ref)."""
    flipped_set = set(diff.get("flipped", []))
    regressed_set = set(diff.get("regressed", []))
    all_predicted = set()
    all_risk = set()
    evaluations: List[Dict[str, Any]] = []

    for chg in manifest.get("changes", []):
        predicted = list(chg.get("predicted_fixes", []) or [])
        risks = list(chg.get("risk_tasks", []) or [])
        all_predicted.update(predicted)
        all_risk.update(risks)
        actually_fixed = [t for t in predicted if t in flipped_set]
        still_failed = [t for t in predicted if t not in flipped_set]
        risk_realized = [t for t in risks if t in regressed_set]
        n_fixed = len(actually_fixed)
        n_pred = len(predicted)
        n_risk = len(risk_realized)

        if n_risk > 0 and n_fixed == 0:
            verdict = "HARMFUL"
        elif n_risk > 0 and n_fixed > 0:
            verdict = "MIXED"
        elif n_pred and n_fixed == n_pred:
            verdict = "EFFECTIVE"
        elif n_fixed > 0:
            verdict = "PARTIALLY_EFFECTIVE"
        else:
            verdict = "INEFFECTIVE"

        evaluations.append({
            "change_id": chg.get("id", "unknown"),
            "description": chg.get("description", ""),
            "files": list(chg.get("files", []) or []),
            "predicted_fixes": predicted,
            "actually_fixed": actually_fixed,
            "still_failed": still_failed,
            "predicted_risks": risks,
            "risk_realized": risk_realized,
            "hit_rate": f"{n_fixed}/{n_pred}" if n_pred else "0/0",
            "verdict": verdict,
        })

    unattributed = sorted(
        t for t in regressed_set if t not in (all_predicted | all_risk)
    )
    return {
        "evaluating_iteration": int(manifest.get("iteration", 0)),
        "change_evaluations": evaluations,
        "unattributed_regressions": unattributed,
        "summary": ", ".join(
            f"{e['change_id']}: {e['verdict']}" for e in evaluations
        ),
    }


def copy_tree(src: Path, dst: Path) -> None:
    dst.mkdir(parents=True, exist_ok=True)
    for item in src.iterdir():
        if item.name == ".git":
            continue
        target = dst / item.name
        if item.is_dir():
            shutil.copytree(item, target, dirs_exist_ok=True)
        else:
            shutil.copy2(item, target)


def replace_tree(src: Path, dst: Path) -> None:
    """Replace dst's non-git content with src (true rollback semantics)."""
    dst.mkdir(parents=True, exist_ok=True)
    for item in list(dst.iterdir()):
        if item.name == ".git":
            continue
        if item.is_dir():
            shutil.rmtree(item)
        else:
            item.unlink()
    copy_tree(src, dst)


def save_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2),
                   encoding="utf-8")
    tmp.replace(path)
