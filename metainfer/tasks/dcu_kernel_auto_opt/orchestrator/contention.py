"""Discard a worker round that was measured while its device was shared.

The parent harness freezes a question's child when the device it holds is taken
over, and records that window in ``<child_state_dir>/contention.json``. The
child, on the way back up, must then do two things for that round:

1. **not keep the number** — a measurement taken while another workload shared
   the card is noise (the same unchanged shape has read 884us and 3047us), and
   if it is kept it also pollutes the iteration history the planner reasons
   about;
2. **go back to the previous good state** — the accepted kernel commit, the
   official best metrics and any shadow candidate from that round are undone, so
   the round can simply be re-measured instead of starting the whole question
   over.

The record is *quarantined*, never deleted: the failed number stays available as
evidence of the contamination.

Re-planning comes for free: ``plan.json`` is written once from static config,
while the per-round planner inputs (``isa_policy``, ``pmc_profile_decision``,
round mandates) are derived from ``experiments.jsonl`` at the top of every
iteration. Removing the contaminated row therefore means the next round is
planned against clean history.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

CONTENTION_FILE = "contention.json"
QUARANTINE_DIR = "contaminated"


def contention_file(child_state_dir: Optional[Path]) -> Optional[Path]:
    """Locate the parent's contention record for this child."""
    candidates: List[Path] = []
    if child_state_dir:
        candidates.append(Path(child_state_dir) / CONTENTION_FILE)
    env = str(os.environ.get("METAINFER_CHILD_STATE_DIR") or "").strip()
    if env:
        candidates.append(Path(env) / CONTENTION_FILE)
    for path in candidates:
        try:
            if path.is_file():
                return path
        except OSError:
            continue
    return None


def read_contention(child_state_dir: Optional[Path] = None) -> Dict[str, Any]:
    """The contention window recorded for this child (empty when none)."""
    path = contention_file(child_state_dir)
    if path is None:
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def iteration_is_contaminated(iteration: int, window: Dict[str, Any], *,
                              iteration_dir: Optional[Path] = None,
                              now: Optional[float] = None) -> tuple[bool, str]:
    """Whether ``iteration`` was measured inside the contention window.

    The window is ``[frozen_from, recovered_at]``: the child was frozen the
    moment contention was seen, so any round whose work lands in that interval
    (or which was still unfinished when the window closed) is suspect. A window
    that is still open contaminates the round that was running when it opened.
    """
    if not window:
        return False, "no contention recorded"
    frozen_from = window.get("frozen_from")
    if frozen_from is None:
        return False, "window has no start"
    recovered_at = window.get("recovered_at")
    stamp = float(now if now is not None else time.time())
    # where the round's work sits on disk (mtime is what we can trust: the
    # records themselves carry no timestamp)
    mtime = None
    if iteration_dir is not None:
        try:
            mtime = Path(iteration_dir).stat().st_mtime
        except OSError:
            mtime = None
    reference = mtime if mtime is not None else stamp
    if reference < float(frozen_from):
        return False, "round finished before the device was taken over"
    if recovered_at is None:
        # the window is still open: this round ran while the device was shared
        return True, "device was taken over while this round was running"
    if reference <= float(recovered_at):
        return True, "round lands inside the window while the device was shared"
    return False, "round was measured after the device recovered"


def _quarantine(experiments_path: Path, iteration: int, record: Dict[str, Any],
                meta: Dict[str, Any], *, state_dir: Optional[Path] = None,
                ) -> Optional[Path]:
    """Move one round's record out of the live history into quarantine."""
    target_dir = Path(state_dir) if state_dir else experiments_path.parent
    target_dir = target_dir / QUARANTINE_DIR
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"iteration-{int(iteration):03d}.json"
    payload = {
        "reason": "device_shared_during_measurement",
        "discarded_at": time.time(),
        "iteration": int(iteration),
        "metrics": {
            k: (record.get("metrics") or {}).get(k)
            for k in ("median_us", "p90_us", "passed", "mismatch_count")
        },
        **meta,
        "record": record,
    }
    try:
        target.write_text(json.dumps(payload, indent=2, ensure_ascii=False),
                          encoding="utf-8")
    except OSError:
        return None
    return target


def discard_contaminated_round(*, experiments_path: Path, iteration: int,
                               state_dir: Optional[Path] = None,
                               iteration_dir: Optional[Path] = None,
                               window: Optional[Dict[str, Any]] = None,
                               ) -> Dict[str, Any]:
    """Remove a contaminated round from the live history (quarantined).

    Returns ``{"discarded": bool, "reason": str, ...}``. The caller is expected
    to restore the kernel source and metrics to the previous good state (the
    discard itself only touches the history and the quarantined copy).
    """
    experiments_path = Path(experiments_path)
    window = window if window is not None else read_contention(state_dir)
    contaminated, why = iteration_is_contaminated(iteration, window,
                                                  iteration_dir=iteration_dir)
    if not contaminated:
        return {"discarded": False, "reason": why}
    if not experiments_path.is_file():
        return {"discarded": False, "reason": "no experiment history to prune"}

    rows: List[Dict[str, Any]] = []
    dropped: List[Dict[str, Any]] = []
    for line in experiments_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except ValueError:
            rows.append({"_raw": line})
            continue
        if int(row.get("iteration") or 0) == int(iteration):
            dropped.append(row)
        else:
            rows.append(row)

    quarantined = []
    for record in dropped:
        path = _quarantine(experiments_path, iteration, record, {
            "window": window, "reason_detail": why,
        }, state_dir=state_dir)
        if path is not None:
            quarantined.append(str(path))

    try:
        experiments_path.write_text(
            "".join(json.dumps(r) + "\n" for r in rows if "_raw" not in r
                    ) + "".join(r["_raw"] + "\n" for r in rows if "_raw" in r),
            encoding="utf-8")
    except OSError as exc:  # noqa: BLE001
        return {"discarded": False, "reason": f"cannot rewrite history: {exc}"}
    return {
        "discarded": True,
        "reason": why,
        "rounds_removed": len(dropped),
        "quarantined": quarantined,
        "history_remaining": len([r for r in rows if "_raw" not in r]),
        "window": window,
    }
