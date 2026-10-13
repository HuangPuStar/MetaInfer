#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Concise operator-performance table extracted from the DKAO run records.

No benchmarking: everything is read from the task records
(``final_report.json`` for finally-validated runs, ``plan.json`` +
``shared_baseline/results.json`` + ``workers/*/result.json`` for runs that only
finished the parallel-exploration phase).

Columns: 模型 / TP / 算子 / M / N / K / 基线µs / 性能µs / 加速比 / 提升% / 带宽GB/s / TOPS / 验收状态
"""
from __future__ import annotations

import csv
import glob
import json
import os

WS_ROOT = "/root/zth_agent/MetaInfer/nodes/worker29/workspaces"
OUT_DIR = os.path.dirname(os.path.abspath(__file__))

STATE_OK = "已最终验收"
STATE_WORKER = "仅worker验收"

# (task_id, model label, TP) ; one canonical run per model×TP×M group
RUNS = [
    ("hy3-dsh-tp4-m16-2-368c654c",         "Hy3",       4),
    ("hy3-tp4-m4096-dsh-test1-bfdf3002",   "Hy3",       4),
    ("hy3-dsh-tp8-m4096-1-0ebb994d",       "Hy3",       8),
    ("hy3-dsh-tp8-m16-9-8-0161e718",       "Hy3",       8),
    ("minimax-dsh-tp8-m16-1-78402260",     "MiniMax-M3", 8),
    ("minimaxm3-dsh-tp4-m4096-1-0c2f84a9", "MiniMax-M3", 4),
    ("minimaxm3-dsh-tp8-m4096-1-b0482833", "MiniMax-M3", 8),
    ("glm5-2-dsh-tp8-m4096-1-e6a280a2",    "GLM5.2",    8),
    ("glm5-2-dsh-tp4-m4096-1-85cb689c",    "GLM5.2",    4),
    ("glm5-2-dsh-tp8-m16-test1-cb4d262c",  "GLM5.2",    8),
]


def algorithmic_bytes(m: int, n: int, k: int) -> int:
    """Same formula as the trusted harness: int8 A + int8 B + fp32 scales + bf16 out."""
    return m * k + k * n + 4 * (m + n) + 2 * m * n


def load_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return default


def row_from_validated(task_id, model, tp):
    rep = load_json(os.path.join(WS_ROOT, task_id, "final_report.json")) or {}
    if rep.get("status") != "success":
        return []
    cfg = rep.get("config") or {}
    target = (rep.get("final_target") or {}).get("shapes") or {}
    validation = rep.get("final_validation") or {}
    rows = []
    for shape in cfg.get("shapes") or []:
        sid = shape.get("id")
        info = target.get(sid)
        if not info:
            continue
        record = validation.get(sid) or {}
        dims = record.get("shape") or {}
        m = dims.get("M", shape.get("M"))
        n = dims.get("N", shape.get("N"))
        k = dims.get("K", shape.get("K"))
        base = info.get("baseline_us")
        perf = info.get("final_us")
        if not (base and perf):
            continue
        rows.append(_row(model, tp, shape.get("operator"), m, n, k, base, perf,
                         record.get("p90_us"), STATE_OK))
    return rows


def row_from_worker(task_id, model, tp):
    ws = os.path.join(WS_ROOT, task_id)
    plan = load_json(os.path.join(ws, "plan.json"))
    if not plan:
        return []
    baseline = (load_json(os.path.join(ws, "shared_baseline", "results.json")) or {}).get("shapes") or {}
    best = {}
    for wid in sorted(glob.glob(os.path.join(ws, "workers", "worker_*"))):
        result = load_json(os.path.join(wid, "result.json")) or {}
        for sid, rec in (result.get("shapes") or {}).items():
            metrics = rec.get("metrics") or {}
            median = metrics.get("median_us")
            if median is None:
                continue
            if sid not in best or median < best[sid]["perf"]:
                best[sid] = {"perf": median, "p90": metrics.get("p90_us"),
                             "bytes": metrics.get("algorithmic_bytes")}
    rows = []
    for shape in plan.get("shapes") or []:
        sid = shape.get("id")
        rec = best.get(sid)
        if not rec:
            continue
        entry = baseline.get(sid) or {}
        base = entry.get("baseline_us") or entry.get("median_us")
        if not base:
            continue
        rows.append(_row(model, shape.get("tp_size", tp), shape.get("operator"),
                         shape.get("M"), shape.get("N"), shape.get("K"),
                         base, rec["perf"], rec.get("p90"), STATE_WORKER))
    return rows


def _row(model, tp, operator, m, n, k, base, perf, p90, state):
    total_bytes = algorithmic_bytes(int(m), int(n), int(k))
    return {
        "模型": model,
        "TP": int(tp),
        "算子": operator,
        "M": int(m), "N": int(n), "K": int(k),
        "基线µs": round(float(base), 3),
        "性能µs": round(float(perf), 3),
        "加速比": round(float(base) / float(perf), 3),
        "提升%": round((float(base) / float(perf) - 1.0) * 100.0, 1),
        "带宽GB/s": round(total_bytes / (float(perf) * 1e-6) / 1e9, 1),
        "TOPS": round(2.0 * int(m) * int(n) * int(k) / (float(perf) * 1e-6) / 1e12, 2),
        "P90µs": round(float(p90), 3) if p90 else "",
        "验收状态": state,
    }


def main():
    rows = []
    for task_id, model, tp in RUNS:
        validated = row_from_validated(task_id, model, tp)
        if validated:
            rows.extend(validated)
            print(f"{task_id:42s} {model:11s} TP{tp}  validated rows={len(validated)}")
            continue
        worker = row_from_worker(task_id, model, tp)
        rows.extend(worker)
        print(f"{task_id:42s} {model:11s} TP{tp}  worker-only rows={len(worker)}")

    rows.sort(key=lambda r: (r["模型"], r["TP"], r["M"], r["算子"]))
    print(f"\nTOTAL rows = {len(rows)} "
          f"({sum(1 for r in rows if r['验收状态'] == STATE_OK)} validated, "
          f"{sum(1 for r in rows if r['验收状态'] == STATE_WORKER)} worker-only)")

    path = os.path.join(OUT_DIR, "dkao_operators_concise.csv")
    with open(path, "w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    print("wrote", path)

    print("\n%-11s %2s %-22s %6s %8s %9s %8s %8s %8s" % (
        "模型", "TP", "算子", "M", "基线µs", "性能µs", "加速比", "带宽", "TOPS"))
    for r in rows:
        print("%-11s %2d %-22s %6d %9.2f %9.2f %7.2fx %8.1f %8.2f" % (
            r["模型"], r["TP"], r["算子"], r["M"], r["基线µs"], r["性能µs"],
            r["加速比"], r["带宽GB/s"], r["TOPS"]))


if __name__ == "__main__":
    main()
