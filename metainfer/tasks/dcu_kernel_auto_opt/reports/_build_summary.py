#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Aggregate "best variant performance" per optimized operator shape across the
7 successfully finished (status=success + final_report.json) real DKAO runs.

Input : nodes/worker29/workspaces/<task_id>/final_report.json
Output: reports/dkao_optimized_operators_bestvariant.{csv,xlsx}
"""
import csv
import datetime as _dt
import json
import os

ROOT = "/root/zth_agent/MetaInfer/nodes/worker29/workspaces"
OUT_DIR = os.path.dirname(os.path.abspath(__file__))

# (task_id, display model)
RUNS = [
    ("hy3-dsh-tp4-m16-2-368c654c",          "Hy3 (gfx928 INT8 W8A8)"),
    ("hy3-tp4-m4096-dsh-test1-bfdf3002",    "Hy3 (gfx928 INT8 W8A8)"),
    ("hy3-dsh-tp8-m4096-1-0ebb994d",        "Hy3 (gfx928 INT8 W8A8)"),
    ("hy3-dsh-tp8-m16-9-8-0161e718",        "Hy3 (gfx928 INT8 W8A8)"),
    ("minimax-dsh-tp8-m16-1-78402260",      "MiniMax-M3 (gfx928 INT8 W8A8)"),
    ("minimaxm3-dsh-tp4-m4096-1-0c2f84a9",  "MiniMax-M3 (gfx928 INT8 W8A8)"),
    ("minimaxm3-dsh-tp8-m4096-1-b0482833",  "MiniMax-M3 (gfx928 INT8 W8A8)"),
    ("glm5-2-dsh-tp8-m4096-1-e6a280a2",     "GLM5.2 (gfx928 INT8 W8A8)"),
]

STATE_VALIDATED = "最终验收通过"
STATE_WORKER_ONLY = "仅worker验收(未过最终验收)"


def short_model(repo: str) -> str:
    r = os.path.basename(repo or "")
    for key in ("hy3", "glm5.2", "glm", "minimax", "dsv4", "deepseek"):
        if r.lower().startswith(key):
            return r
    return r or "?"


def dt(ts):
    try:
        return _dt.datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")
    except Exception:
        return "?"


def collect(task_id, model_label):
    ws = os.path.join(ROOT, task_id)
    rep = json.load(open(os.path.join(ws, "final_report.json")))
    cfg = rep.get("config") or {}
    plan_shapes = cfg.get("shapes") or []
    if not plan_shapes:  # fallback: report.config may nest plan differently
        plan_shapes = (rep.get("config") or {}).get("shapes") or []
    final_target = (rep.get("final_target") or {}).get("shapes") or {}
    fv = rep.get("final_validation") or {}
    workers = rep.get("workers") or {}
    wv = rep.get("worker_validation") or {}
    rows = []
    for s in plan_shapes:
        sid = s.get("id")
        op = s.get("operator")
        tp = s.get("tp_size")
        ft = final_target.get(sid)
        fr = fv.get(sid)
        if ft is None:
            # some reports store target by sid only; try direct median from fv
            print(f"  [warn] {task_id}: no final_target entry for {sid}")
            continue
        baseline_us = ft.get("baseline_us")
        final_us = ft.get("final_us")
        improv = ft.get("improvement_percent")
        target_met = ft.get("target_met")
        passed = fr.get("passed") if fr else None
        p90 = fr.get("p90_us") if fr else None
        shape = (fr or {}).get("shape") or {}
        M = shape.get("M", s.get("M"))
        N = shape.get("N", s.get("N"))
        K = shape.get("K", s.get("K"))
        # worker best (accepted best during parallel exploration) across workers
        wbest = None
        wbest_meta = None
        for wid, wd in workers.items():
            sh = (wd.get("shapes") or {}).get(sid)
            if not sh:
                continue
            m = sh.get("metrics") or {}
            mu = m.get("median_us")
            art = sh.get("artifact") or {}
            if mu is not None and (wbest is None or mu < wbest):
                wbest = mu
                wbest_meta = (wid, art.get("source"), m.get("p90_us"))
        wv_rec = wv.get(sid)
        if wv_rec:
            wm = wv_rec.get("metrics") or {}
            wmu = wm.get("median_us")
            if wmu is not None and (wbest is None or wmu < wbest):
                wbest = wmu
                wbest_meta = (wv_rec.get("worker_id"), None, wm.get("p90_us"))
        # sanity
        if fr and final_us is not None:
            delta = abs((fr.get("median_us") or 0) - final_us)
            if delta > 1e-6 * max(1.0, final_us):
                print(f"  [note] {task_id}/{sid}: final_us={final_us} vs fv.median={fr.get('median_us')}")
        tops = None
        if final_us and M and N and K:
            tops = 2.0 * M * N * K / (final_us * 1e-6) / 1e12
        speedup = (baseline_us / final_us) if (baseline_us and final_us) else None
        rows.append({
            "task_id": task_id,
            "model": model_label,
            "kernel_repo": os.path.basename((cfg.get("kernel_repo") or "")) or short_model(cfg.get("kernel_repo")),
            "tp": tp,
            "operator": op,
            "M": M, "N": N, "K": K,
            "dtype": "INT8 W8A8",
            "baseline_us": baseline_us,
            "worker_best_us": wbest,
            "best_variant_source": (f"{wbest_meta[0]} {wbest_meta[1]}" if wbest_meta else ""),
            "final_us": final_us,
            "final_p90_us": p90,
            "speedup_x": speedup,
            "improvement_pct": improv,
            "target_met": target_met,
            "passed": passed,
            "logical_tops": tops,
            "finished_at": dt(rep.get("finished_at") or rep.get("started_at")),
            "validation_state": STATE_VALIDATED,
        })
    return rows


def collect_worker_only(task_id, model_label):
    """Rows for a run that never produced final_report.json: use the best
    worker-accepted variant measured during parallel exploration, and label the
    row as not-final-validated."""
    ws = os.path.join(ROOT, task_id)
    plan = json.load(open(os.path.join(ws, "plan.json")))
    tp_default = (plan.get("shapes") or [{}])[0].get("tp_size")
    baseline = {}
    try:
        baseline = (json.load(open(os.path.join(ws, "shared_baseline", "results.json")))
                    or {}).get("shapes") or {}
    except OSError:
        pass
    best = {}
    for wid in sorted(os.listdir(os.path.join(ws, "workers"))):
        rp = os.path.join(ws, "workers", wid, "result.json")
        if not os.path.isfile(rp):
            continue
        try:
            data = json.load(open(rp))
        except ValueError:
            continue
        for sid, rec in (data.get("shapes") or {}).items():
            met = rec.get("metrics") or {}
            med = met.get("median_us")
            if med is None:
                continue
            cur = best.get(sid)
            if cur is None or med < cur["median_us"]:
                best[sid] = {"median_us": med, "p90_us": met.get("p90_us"),
                             "samples": len(met.get("latency_samples_us") or []),
                             "worker": wid, "candidate": rec.get("candidate")}
    rows = []
    for s in plan.get("shapes") or []:
        sid = s.get("id")
        rec = best.get(sid)
        if not rec:
            print(f"  [warn] {task_id}: no worker measurement for {sid}")
            continue
        M, N, K = s.get("M"), s.get("N"), s.get("K")
        base = baseline.get(sid) or {}
        baseline_us = base.get("baseline_us") or base.get("median_us")
        final_us = rec["median_us"]
        tops = (2.0 * M * N * K / (final_us * 1e-6) / 1e12) if (M and N and K) else None
        rows.append({
            "task_id": task_id,
            "model": model_label,
            "kernel_repo": os.path.basename((plan.get("kernel_repo") or "")) or short_model(plan.get("kernel_repo")),
            "tp": s.get("tp_size", tp_default),
            "operator": s.get("operator"),
            "M": M, "N": N, "K": K,
            "dtype": "INT8 W8A8",
            "baseline_us": baseline_us,
            "worker_best_us": final_us,
            "best_variant_source": f"{rec['worker']} accepted/<shape> (n={rec['samples']} samples)",
            "final_us": final_us,
            "final_p90_us": rec.get("p90_us"),
            "speedup_x": (baseline_us / final_us) if (baseline_us and final_us) else None,
            "improvement_pct": ((baseline_us / final_us - 1) * 100) if (baseline_us and final_us) else None,
            "target_met": None,
            "passed": None,
            "logical_tops": tops,
            "finished_at": "",
            "validation_state": STATE_WORKER_ONLY,
        })
    return rows


def main():
    all_rows = []
    for tid, label in RUNS:
        print(f"== {tid} ==")
        rows = []
        rp = os.path.join(ROOT, tid, "final_report.json")
        if os.path.isfile(rp) and os.path.getsize(rp) > 0:
            try:
                if json.load(open(rp)).get("status") == "success":
                    rows = collect(tid, label)
            except ValueError as exc:
                print(f"  [warn] unreadable final_report ({exc})")
        if rows:
            print(f"   final-validated shapes={len(rows)}")
        else:
            rows = collect_worker_only(tid, label)
            print(f"   worker-only shapes={len(rows)} (no success final_report)")
        all_rows.extend(rows)
    print(f"TOTAL rows = {len(all_rows)}")

    headers = [
        "task_id", "model", "kernel_repo", "tp", "operator", "M", "N", "K", "dtype",
        "baseline_us", "worker_best_us", "best_variant_source",
        "final_us", "final_p90_us", "speedup_x", "improvement_pct",
        "target_met", "passed", "logical_tops", "finished_at", "validation_state",
    ]
    csv_path = os.path.join(OUT_DIR, "dkao_optimized_operators_bestvariant.csv")
    with open(csv_path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=headers, extrasaction="ignore")
        w.writeheader()
        w.writerows(all_rows)
    print("wrote", csv_path)

    # quick console summary
    print("\n%-20s %-16s %2s %-24s %6s %9s %9s %9s  %s" % (
        "task", "repo", "tp", "op", "M", "baseline", "final_us", "speedup", "state"))
    for r in all_rows:
        print("%-20s %-16s %2s %-24s %6s %9.2f %9.2f %8.2fx  %s" % (
            r["task_id"][:20], r["kernel_repo"][:16], r["tp"], r["operator"],
            r["M"], r["baseline_us"], r["final_us"], r["speedup_x"],
            r["validation_state"]))

    import json as _j
    with open(os.path.join(OUT_DIR, "dkao_optimized_operators_bestvariant.json"), "w") as f:
        _j.dump(all_rows, f, indent=2, ensure_ascii=False, default=str)
    return all_rows


if __name__ == "__main__":
    main()
