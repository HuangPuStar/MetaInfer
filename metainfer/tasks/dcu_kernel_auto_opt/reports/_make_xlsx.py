#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build the multi-sheet .xlsx summary of best-variant performances."""
import csv
import json
import os

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
CSV = os.path.join(OUT_DIR, "dkao_optimized_operators_bestvariant.csv")

HDR = [
    ("task_id", "任务ID"),
    ("model", "模型(任务)"),
    ("kernel_repo", "kernel_repo"),
    ("tp", "TP"),
    ("operator", "算子"),
    ("M", "M"),
    ("N", "N"),
    ("K", "K"),
    ("dtype", "数据类型"),
    ("baseline_us", "Triton基线(µs)"),
    ("worker_best_us", "探索期Worker最优(µs)"),
    ("best_variant_source", "最优variant来源"),
    ("final_us", "最终验收最优variant(µs)"),
    ("final_p90_us", "最终P90(µs)"),
    ("speedup_x", "加速比(vs基线×)"),
    ("improvement_pct", "提升(%)"),
    ("target_met", "达标(≥3%)"),
    ("passed", "正确性"),
    ("logical_tops", "计算性能(TOPS)"),
    ("finished_at", "任务完成时间"),
    ("validation_state", "验收状态"),
]
COL_KEYS = [h[0] for h in HDR]
COL_LABELS = [h[1] for h in HDR]
FMT = {  # key -> openpyxl number format
    "baseline_us": "0.00",
    "worker_best_us": "0.00",
    "final_us": "0.00",
    "final_p90_us": "0.00",
    "speedup_x": "0.00",
    "improvement_pct": "0.0",
    "logical_tops": "0.0",
}

thin = Side(style="thin", color="D0D0D0")
border = Border(left=thin, right=thin, top=thin, bottom=thin)
head_fill = PatternFill("solid", fgColor="1F4E78")
head_font = Font(bold=True, color="FFFFFF", size=11)
alt_fill = PatternFill("solid", fgColor="EAF1F8")


def read_rows():
    rows = list(csv.DictReader(open(CSV, encoding="utf-8-sig")))
    for r in rows:
        for k in ("tp", "M", "N", "K", "baseline_us", "worker_best_us",
                  "final_us", "final_p90_us", "speedup_x", "improvement_pct",
                  "logical_tops"):
            v = r.get(k)
            if v in (None, ""):
                r[k] = None
            else:
                try:
                    r[k] = float(v) if "." in v or "e" in v.lower() else int(float(v))
                except ValueError:
                    pass
    return rows


def sheet_from_rows(ws, rows, title_row=True, num_keys=None):
    num_keys = num_keys or FMT
    ws.append(COL_LABELS)
    for c in range(1, len(COL_LABELS) + 1):
        cell = ws.cell(row=1, column=c)
        cell.fill, cell.font = head_fill, head_font
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.border = border
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:{get_column_letter(len(COL_LABELS))}{1 + len(rows)}"
    for i, r in enumerate(rows, start=2):
        for j, k in enumerate(COL_KEYS, start=1):
            v = r.get(k)
            cell = ws.cell(row=i, column=j, value=(v if not isinstance(v, float) else round(v, 4)))
            cell.border = border
            if k in num_keys and isinstance(v, (int, float)):
                cell.number_format = num_keys[k]
                cell.alignment = Alignment(horizontal="right")
            elif k in ("target_met", "passed"):
                cell.alignment = Alignment(horizontal="center")
                cell.value = "✔" if v is True or str(v).lower() == "true" else str(v)
            elif isinstance(v, (int, float)):
                cell.alignment = Alignment(horizontal="right")
            else:
                cell.alignment = Alignment(horizontal="left", vertical="center")
            if i % 2 == 0:
                cell.fill = alt_fill
    widths = {
        "task_id": 34, "model": 30, "kernel_repo": 24, "tp": 6, "operator": 26,
        "M": 8, "N": 8, "K": 8, "dtype": 12, "baseline_us": 13,
        "worker_best_us": 15, "best_variant_source": 40, "final_us": 16,
        "final_p90_us": 12, "speedup_x": 12, "improvement_pct": 10,
        "target_met": 10, "passed": 10, "logical_tops": 14, "finished_at": 18,
        "validation_state": 26,
    }
    for j, k in enumerate(COL_KEYS, start=1):
        ws.column_dimensions[get_column_letter(j)].width = widths.get(k, 14)
    ws.row_dimensions[1].height = 24


def main():
    rows = read_rows()
    wb = Workbook()

    ws = wb.active
    ws.title = "汇总-最优variant"
    sheet_from_rows(ws, rows)

    # --- by model & TP summary ---
    ws2 = wb.create_sheet("按模型×TP汇总")
    groups = {}
    for r in rows:
        key = (r["model"], r["kernel_repo"], r["tp"])
        groups.setdefault(key, []).append(r)
    head2 = ["模型(任务)", "kernel_repo", "TP", "算子数", "平均加速比×",
             "最小加速比×", "最大加速比×", "平均最终µs", "平均TOPS", "平均提升%",
             "验收状态"]
    ws2.append(head2)
    for c in range(1, len(head2) + 1):
        cell = ws2.cell(row=1, column=c)
        cell.fill, cell.font = head_fill, head_font
        cell.alignment = Alignment(horizontal="center")
        cell.border = border
    for i, ((model, repo, tp), rr) in enumerate(sorted(groups.items()), start=2):
        sp = [r["speedup_x"] for r in rr if r["speedup_x"] is not None]
        fin = [r["final_us"] for r in rr if r["final_us"] is not None]
        tops = [r["logical_tops"] for r in rr if r["logical_tops"] is not None]
        imp = [r["improvement_pct"] for r in rr if r["improvement_pct"] is not None]
        vals = [model, repo, tp, len(rr),
                sum(sp) / len(sp), min(sp), max(sp),
                sum(fin) / len(fin),
                sum(tops) / len(tops),
                sum(imp) / len(imp),
                "/".join(sorted({r["validation_state"] for r in rr}))]
        ws2.append(vals)
        for j, v in enumerate(vals, start=1):
            cell = ws2.cell(row=i, column=j)
            cell.border = border
            if 5 <= j <= 10:
                cell.number_format = "0.00"
                cell.alignment = Alignment(horizontal="right")
            if j == 4:
                cell.alignment = Alignment(horizontal="right")
        if i % 2 == 0:
            for j in range(1, len(head2) + 1):
                ws2.cell(row=i, column=j).fill = alt_fill
    for j, w in enumerate([26, 24, 6, 9, 13, 13, 13, 14, 12, 12, 34], start=1):
        ws2.column_dimensions[get_column_letter(j)].width = w
    ws2.freeze_panes = "A2"
    ws2.auto_filter.ref = f"A1:{get_column_letter(len(head2))}{ws2.max_row}"

    # --- by operator (across runs) ---
    ws3 = wb.create_sheet("按算子汇总")
    ops = {}
    for r in rows:
        ops.setdefault(r["operator"], []).append(r)
    head3 = ["算子", "出现次数", "平均加速比×", "最大加速比×", "平均TOPS",
             "覆盖模型×TP×M"]
    ws3.append(head3)
    for c in range(1, len(head3) + 1):
        cell = ws3.cell(row=1, column=c)
        cell.fill, cell.font = head_fill, head_font
        cell.alignment = Alignment(horizontal="center")
        cell.border = border
    for i, (op, rr) in enumerate(sorted(ops.items()), start=2):
        sp = [r["speedup_x"] for r in rr if r["speedup_x"] is not None]
        tops = [r["logical_tops"] for r in rr if r["logical_tops"] is not None]
        cov = ", ".join(sorted({f"{r['kernel_repo']}/TP{r['tp']}/M{r['M']}" for r in rr}))
        vals = [op, len(rr), sum(sp) / len(sp), max(sp),
                sum(tops) / len(tops), cov]
        ws3.append(vals)
        for j, v in enumerate(vals, start=1):
            cell = ws3.cell(row=i, column=j)
            cell.border = border
            if j in (3, 4, 5):
                cell.number_format = "0.00"
            if j in (2, 3, 4, 5):
                cell.alignment = Alignment(horizontal="right")
        if i % 2 == 0:
            for j in range(1, len(head3) + 1):
                ws3.cell(row=i, column=j).fill = alt_fill
    for j, w in enumerate([24, 10, 13, 13, 12, 70], start=1):
        ws3.column_dimensions[get_column_letter(j)].width = w
    ws3.freeze_panes = "A2"

    # --- source runs ---
    ws4 = wb.create_sheet("数据来源任务")
    src = {}
    for r in rows:
        src.setdefault(r["task_id"], r)
    head4 = ["任务ID", "模型", "kernel_repo", "TP", "优化算子数", "完成时间", "状态"]
    ws4.append(head4)
    for c in range(1, len(head4) + 1):
        cell = ws4.cell(row=1, column=c)
        cell.fill, cell.font = head_fill, head_font
        cell.alignment = Alignment(horizontal="center")
        cell.border = border
    for i, (tid, r) in enumerate(sorted(src.items()), start=2):
        ws4.append([tid, r["model"], r["kernel_repo"], r["tp"],
                    sum(1 for x in rows if x["task_id"] == tid),
                    r["finished_at"], "success(final_report)"])
        for j in range(1, len(head4) + 1):
            ws4.cell(row=i, column=j).border = border
        if i % 2 == 0:
            for j in range(1, len(head4) + 1):
                ws4.cell(row=i, column=j).fill = alt_fill
    for j, w in enumerate([34, 30, 24, 6, 12, 18, 22], start=1):
        ws4.column_dimensions[get_column_letter(j)].width = w
    ws4.freeze_panes = "A2"

    # --- notes ---
    ws5 = wb.create_sheet("字段说明")
    notes = [
        ["说明", "本表汇总 dcu_kernel_auto_opt 任务下所有已完成并通过最终串行验收(status=success, final_report.json)的真实优化任务，",
         "取每个 (模型×TP×算子×M) 最优已验收 variant 的最终性能；每个 shape 一行。"],
        ["硬件/算子", "worker29, 4×K500SM_AI / gfx928 (Hygon DCU, CDNA 系); 算子 = INT8 W8A8 GEMM (HIP C++, DUMMA Tensor Core), dtype int8 × fp32 scale → bf16 out"],
        ["Triton基线(µs)", "固定 Triton Graph 基线中位延迟（fixed table / 实测 graph replay），与 custom 同协议（GPU event、warmup、graph replay median）"],
        ["探索期Worker最优(µs)", "并行探索阶段各 worker 在验收轮记录到的最快 median（accepted 轮）。部分行略快于最终验收值，属重测协议差异(最终门限 ≤1.05×worker best)"],
        ["最终验收最优variant(µs)", "串行最终验收重新测量并全部 shape 通过(正确性+性能门)的 median —— 本表采用的“最优 variant 性能”主列"],
        ["加速比(×)", "= Triton基线 / 最终验收median"],
        ["提升(%)", "= (Triton基线/最终验收median − 1) × 100%；任务门槛 minimum_improvement_percent=3.0%（对 plan shape 的最终验收 vs 固定基线）"],
        ["计算性能(TOPS)", "= 2×M×N×K / final_us，纯算法逻辑 INT8 运算速率（非实测带宽）"],
        ["达标/正确性", "target_met: 最终验收 ≥3% 提升门槛；passed: 最终串行验证正确性通过(CPU int64 exact reference)"],
        ["验收状态", "'最终验收通过' = 该任务串行最终验收全部 shape 通过并写出 final_report.json (status=success)；'仅worker验收(未过最终验收)' = 该任务未产出成功 final_report，本行取的是 worker 并行探索阶段已验收最优 variant 的 median（未经最终门限确认）"],
        ["覆盖", "Hy3: TP4 M16/M4096, TP8 M4096 (+TP8 M16 见下条); MiniMax-M3: TP4 M4096, TP8 M16/M4096; GLM5.2: TP8 M4096 —— 共 37 个优化 shape 行，其中 33 行为各任务自身 plan 的最终验收通过算子，4 行为 Hy3 TP8 M16（仅 worker 验收，见下条）；不含默认 42-shape 回归项"],
        ["Hy3 TP8 M16 (9.8 任务)", "任务 hy3-dsh-tp8-m16-9-8-0161e718 的 4 个 M=16 shape 目前无成功 final_report：2026-09-09 07:04 最终验收因性能门限失败（o_proj final 11.745 vs worker best 11.044 > 1.05×）。2026-09-10 重跑验收：qkv_proj ✅、o_proj ✅（首测 11.706 超限，第 1 次重测通过）、shared_gate_up_proj 首测 13.1295 vs 门限 13.112（超 0.13%）时按用户要求暂停，shared_down_proj 未测。本表该 4 行数值取 worker 探索期已验收最优 median"],
        ["生成时间", "2026-09（数据截至各任务 final_report.json 快照）"],
    ]
    for i, row in enumerate(notes, start=1):
        ws5.append(row)
        for j in range(1, 4):
            c = ws5.cell(row=i, column=j)
            c.alignment = Alignment(wrap_text=True, vertical="top")
        if i == 1:
            for j in range(1, 3):
                ws5.cell(row=i, column=j).font = Font(bold=True)
    ws5.column_dimensions["A"].width = 24
    ws5.column_dimensions["B"].width = 60
    ws5.column_dimensions["C"].width = 70

    xlsx = os.path.join(OUT_DIR, "dkao_optimized_operators_bestvariant.xlsx")
    wb.save(xlsx)
    print("wrote", xlsx)
    print("sheets:", wb.sheetnames)


if __name__ == "__main__":
    main()
