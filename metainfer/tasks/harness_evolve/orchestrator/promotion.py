"""Human-approved promotion of an evolved harness into production DKAO.

The operator's rule: an HE run exists to produce one promotable harness, and
nothing is written to DKAO without a human decision. So a candidate that passes
both gates does **not** publish itself:

1. the round writes ``pending_promotion.json`` (candidate revision, snapshot,
   both gate records) and the run parks in ``awaiting_approval``;
2. ``approve`` copies the candidate harness into production (backing up the
   previous version), records it, updates the variant table and finishes the
   run;
3. ``deny`` throws the candidate away and the caller keeps iterating.

``rollback_harness`` puts the previous production version back, which is what
makes an approval safe to make.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Dict, Optional

from .attribution import copy_tree, replace_tree, save_json
from .state import append_timeline

PENDING_FILE = "pending_promotion.json"
PROMOTED_FILE = "promoted_harness.json"
PROMOTION_LOG = "promotion_log.jsonl"


def _load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _ts() -> str:
    return time.strftime("%Y%m%d-%H%M%S")


def _log(exp_dir: Path, **fields: Any) -> None:
    row = {"ts": time.time(), **fields}
    try:
        Path(exp_dir).mkdir(parents=True, exist_ok=True)
        with (Path(exp_dir) / PROMOTION_LOG).open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    except OSError:
        pass


def version_for(iteration: int) -> str:
    """The harness version label used in records (h-1 is the seed)."""
    return f"h-{int(iteration)}"


def write_pending_promotion(exp_dir: Path, *, iteration: int, revision: str,
                            snapshot_dir: str,
                            performance_gate: Dict[str, Any],
                            generalization_gate: Dict[str, Any],
                            results: Dict[str, Any]) -> Path:
    """Record a candidate that passed both gates and is awaiting approval."""
    exp_dir = Path(exp_dir)
    payload = {
        "schema_version": 1,
        "created_at": time.time(),
        "iteration": iteration,
        "version": version_for(iteration),
        "revision": revision,
        "snapshot_dir": snapshot_dir,
        "performance_gate": performance_gate,
        "generalization_gate": generalization_gate,
        "operator_results": {
            iid: {k: row.get(k) for k in
                  ("median_us", "p90_us", "passed", "correctness_ok",
                   "status", "repo_path")}
            for iid, row in (results or {}).items() if isinstance(row, dict)
        },
        "awaiting": "human approval (approve / deny)",
    }
    save_json(exp_dir / PENDING_FILE, payload)
    _log(exp_dir, action="pending_promotion", iteration=iteration,
         version=payload["version"], revision=revision)
    return exp_dir / PENDING_FILE


def read_pending(exp_dir: Path) -> Optional[Dict[str, Any]]:
    data = _load_json(Path(exp_dir) / PENDING_FILE)
    return data if isinstance(data, dict) else None


def clear_pending(exp_dir: Path) -> None:
    try:
        (Path(exp_dir) / PENDING_FILE).unlink()
    except OSError:
        pass


def promoted_harness(exp_dir: Path) -> Optional[Dict[str, Any]]:
    data = _load_json(Path(exp_dir) / PROMOTED_FILE)
    return data if isinstance(data, dict) else None


def _production_dir() -> Path:
    from .config import harness_seed_dir
    return harness_seed_dir("dcu_default")


def _versioned_backup(exp_dir: Path, version: str) -> Path:
    """Keep a named copy of what production looked like before a promotion."""
    target = _production_dir()
    backup_root = Path(exp_dir) / "promoted"
    backup_root.mkdir(parents=True, exist_ok=True)
    backup = backup_root / version
    if target.is_dir() and not backup.exists():
        copy_tree(target, backup)
    return backup


def promote_harness(exp_dir: Path, pending: Dict[str, Any], *,
                    approved_by: str = "operator") -> Dict[str, Any]:
    """Write the approved candidate harness into production DKAO.

    The previous production tree is kept as a named copy (and a timestamped
    one) so a promotion is always reversible.
    """
    exp_dir = Path(exp_dir)
    snapshot = Path(str(pending.get("snapshot_dir") or ""))
    if not snapshot.is_dir():
        return {"ok": False, "errors": [f"candidate snapshot missing: {snapshot}"]}
    target = _production_dir()
    version = str(pending.get("version") or version_for(pending.get("iteration", 0)))
    previous = promoted_harness(exp_dir) or {}
    previous_version = previous.get("version") or "h-1"
    backup = _versioned_backup(exp_dir, previous_version)
    live_backup = target.parent / f"{target.name}.{_ts()}"
    if target.is_dir():
        copy_tree(target, live_backup)
    replace_tree(snapshot, target)

    record = {
        "schema_version": 1,
        "version": version,
        "iteration": pending.get("iteration"),
        "revision": pending.get("revision"),
        "snapshot_dir": str(snapshot),
        "production_dir": str(target),
        "backup_dir": str(backup),
        "previous_version": previous_version,
        "previous_backup": str(live_backup),
        "approved_by": approved_by,
        "approved_at": time.time(),
        "performance_gate": {
            "status": (pending.get("performance_gate") or {}).get("status"),
            "wins": (pending.get("performance_gate") or {}).get("wins"),
        },
        "generalization_gate": {
            "status": (pending.get("generalization_gate") or {}).get("status"),
            "wins": (pending.get("generalization_gate") or {}).get("wins"),
            "paper": (pending.get("generalization_gate") or {}).get("operators"),
        },
    }
    save_json(exp_dir / PROMOTED_FILE, record)
    _log(exp_dir, action="promoted", version=version,
         iteration=pending.get("iteration"), revision=pending.get("revision"),
         production_dir=str(target), backup=str(backup),
         previous_version=previous_version, approved_by=approved_by)
    return {"ok": True, "record": record, "backup": str(backup),
            "previous_backup": str(live_backup)}


def rollback_harness(exp_dir: Path, *, to: str = "last-good") -> Dict[str, Any]:
    """Restore a previously promoted harness version into production.

    ``to`` accepts a version label (``h-2``), ``last-good`` (the version the
    current one replaced) or ``seed`` (the built-in harness).
    """
    exp_dir = Path(exp_dir)
    current = promoted_harness(exp_dir) or {}
    target = _production_dir()
    if to == "seed":
        source = harness_seed_source()
        label = "seed"
    elif to in {"last-good", "last_good", ""}:
        source = Path(str(current.get("backup_dir") or ""))
        label = str(current.get("previous_version") or "seed")
        if not source.is_dir():
            source = harness_seed_source()
            label = "seed"
    else:
        source = exp_dir / "promoted" / str(to)
        label = str(to)
    if not Path(source).is_dir():
        return {"ok": False, "errors": [f"no harness tree to restore: {source}"]}
    live_backup = target.parent / f"{target.name}.{_ts()}"
    if target.is_dir():
        copy_tree(target, live_backup)
    replace_tree(Path(source), target)
    record = {
        "schema_version": 1,
        "version": f"rollback:{label}",
        "rolled_back_at": time.time(),
        "production_dir": str(target),
        "restored_from": str(source),
        "replaced_backup": str(live_backup),
        "replaced_version": current.get("version"),
    }
    save_json(exp_dir / PROMOTED_FILE, record)
    _log(exp_dir, action="rollback", to=label, restored_from=str(source),
         replaced_backup=str(live_backup))
    return {"ok": True, "record": record, "restored_from": str(source)}


def harness_seed_source() -> Path:
    """The built-in seed harness that ships with the plugin (h-1)."""
    here = Path(__file__).resolve().parents[2]
    return here / "dcu_kernel_auto_opt" / "harness_default"


def restore_promoted_harness(cfg: Any, exp_dir: Path,
                             live_workspace: Path) -> Dict[str, Any]:
    """Put the experiment workspace back to the promoted (production) harness.

    A rejected round must not leave its own edit live, and it must not fall all
    the way back to the seed either: the reference for the next round is what
    production currently runs.
    """
    promoted = promoted_harness(exp_dir)
    source: Optional[Path] = None
    revision = ""
    if promoted and promoted.get("snapshot_dir"):
        candidate = Path(str(promoted["snapshot_dir"]))
        if candidate.is_dir():
            source = candidate
            revision = str(promoted.get("revision") or "")
    if source is None:
        source = harness_seed_source()
    replace_tree(source, live_workspace)
    if revision:
        import subprocess
        try:
            subprocess.run(["git", "reset", "--hard", revision],
                           cwd=live_workspace, check=True,
                           stdout=subprocess.DEVNULL)
        except (OSError, subprocess.CalledProcessError):
            pass
    append_timeline(cfg.state_dir, "workspace_restored_to_promoted", {
        "from": str(source),
        "revision": revision or None,
        "version": (promoted or {}).get("version"),
    })
    return {"restored_from": str(source), "revision": revision}


def _versioned_pool_backup(exp_dir: Path, pool_path: Path) -> Path:
    """Copy the pool next to the experiment before rewriting production data."""
    import shutil
    root = Path(exp_dir) / "promoted"
    root.mkdir(parents=True, exist_ok=True)
    backup = root / f"{pool_path.stem}.{_ts()}{pool_path.suffix}"
    try:
        shutil.copy2(pool_path, backup)
    except OSError:
        return pool_path
    return backup


def promote_kernels_for_round(exp_dir: Path, pool_path: Path,
                              results: Dict[str, Any], *,
                              version: str, iteration: int,
                              reason: str = "harness promotion",
                              ) -> Dict[str, Any]:
    """Write an accepted round's operator kernels into the production pool.

    Only the operators this round actually measured are touched, and only when
    they beat what the pool already records — "best known wins", applied
    surgically instead of rescanning every historical child report. The pool is
    backed up before being rewritten.
    """
    import yaml
    from .variant import _num

    pool_path = Path(pool_path)
    if not pool_path.is_file():
        return {"ok": False, "updated": [],
                "errors": [f"pool file missing: {pool_path}"]}
    try:
        data = yaml.safe_load(pool_path.read_text(encoding="utf-8")) or {}
    except (OSError, ValueError) as exc:  # noqa: BLE001
        return {"ok": False, "updated": [], "errors": [str(exc)]}
    instances = {str(i.get("id")): i for i in (data.get("instances") or [])
                 if isinstance(i, dict)}
    updated: List[Dict[str, Any]] = []
    for iid, row in (results or {}).items():
        if not isinstance(row, dict):
            continue
        entry = instances.get(str(iid))
        if entry is None:
            continue
        median = _num(row.get("median_us"))
        if median is None or row.get("correctness_ok") is False:
            continue
        best = _num(entry.get("best_known_us"))
        if best is not None and median >= best:
            continue
        entry["best_known_us"] = float(median)
        history = entry.setdefault("history", [])
        if isinstance(history, list):
            history.append({
                "accepted": True,
                "median_us": float(median),
                "p90_us": row.get("p90_us"),
                "source_report": row.get("repo_path") or row.get("child_task_id"),
                "harness_version": version,
                "iteration": iteration,
            })
        updated.append({"operator_id": str(iid), "median_us": float(median),
                        "previous_best_us": best})
    if not updated:
        return {"ok": True, "updated": [], "pool": str(pool_path),
                "reason": reason}
    backup = _versioned_pool_backup(exp_dir, pool_path)
    pool_path.write_text(
        yaml.safe_dump(data, sort_keys=False, allow_unicode=True),
        encoding="utf-8")
    _log(exp_dir, action="kernels_promoted", version=version,
         iteration=iteration, pool=str(pool_path), updated=updated,
         backup=str(backup))
    return {"ok": True, "updated": updated, "pool": str(pool_path),
            "backup": str(backup), "reason": reason}


def resolve_question_pool(exp_dir: Path) -> Optional[Path]:
    """The pool file this experiment draws its operators from, if any."""
    exp_dir = Path(exp_dir)
    for name in ("requirements.json", "config_snapshot.json"):
        data = _load_json(exp_dir / name)
        if not isinstance(data, dict):
            continue
        answers = (data.get("answers")
                   if isinstance(data.get("answers"), dict) else data)
        for key in ("question_pool", "pool_source"):
            raw = str((answers or {}).get(key) or "").strip()
            if raw and raw != "builtin":
                candidate = Path(raw).expanduser()
                if candidate.is_file():
                    return candidate
    return None


def approve_promotion(cfg: Any, exp_dir: Path, *,
                      approved_by: str = "operator") -> Dict[str, Any]:
    """Approve the pending candidate: promote it, update variants, finish run."""
    from .variant import load_variant_table, record_variants

    exp_dir = Path(exp_dir)
    pending = read_pending(exp_dir)
    if not pending:
        return {"ok": False, "errors": ["no pending promotion"]}
    result = promote_harness(exp_dir, pending, approved_by=approved_by)
    if not result.get("ok"):
        return result
    version = result["record"]["version"]
    table = load_variant_table(exp_dir)
    # The candidate won on the operators it measured; those become the new
    # variants (and therefore the reference for the next HE run).
    variant_update = record_variants(
        exp_dir, table, pending.get("operator_results") or {},
        version=version, iteration=int(pending.get("iteration") or 0),
        groups={"generalization_ids":
                (pending.get("generalization_gate") or {}).get("operators") or []})
    # ... and their kernels go into production, so the accepted round is the
    # only one whose optimizations survive.
    pool_path = resolve_question_pool(exp_dir)
    if pool_path is not None:
        kernel_update = promote_kernels_for_round(
            exp_dir, pool_path, pending.get("operator_results") or {},
            version=version, iteration=int(pending.get("iteration") or 0))
    else:
        kernel_update = {"ok": True, "updated": [],
                         "skipped": "no question pool configured"}
    clear_pending(exp_dir)
    append_timeline(cfg.state_dir, "harness_promoted", {
        "version": version,
        "iteration": pending.get("iteration"),
        "approved_by": approved_by,
        "variant_updates": variant_update.get("updated"),
        "kernels_promoted": [u["operator_id"]
                             for u in kernel_update.get("updated", [])],
        "backup": result.get("backup"),
    })
    try:
        from .state import set_run
        set_run(cfg.state_dir, final_status=f"promoted:{version}")
    except Exception:  # noqa: BLE001
        pass
    return {**result, "variant_update": variant_update,
            "kernel_update": kernel_update, "version": version}


def deny_promotion(cfg: Any, exp_dir: Path, *, reason: str = "operator") -> Dict[str, Any]:
    """Throw the pending candidate away; the run keeps iterating."""
    exp_dir = Path(exp_dir)
    pending = read_pending(exp_dir)
    if not pending:
        return {"ok": False, "errors": ["no pending promotion"]}
    clear_pending(exp_dir)
    _log(exp_dir, action="denied", iteration=pending.get("iteration"),
         version=pending.get("version"), reason=reason)
    append_timeline(cfg.state_dir, "promotion_denied", {
        "iteration": pending.get("iteration"),
        "version": pending.get("version"), "reason": reason,
    })
    return {"ok": True, "denied": pending.get("version")}
