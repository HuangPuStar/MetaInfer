#!/usr/bin/env python3
"""Collect the errors DKAO actually produced into one reviewable file.

The WebUI shows one sentence when a task dies. This walks the task state dirs
(and the worker workspaces) under ``nodes/*/``, extracts every error-ish string,
tags it with one of the classes declared below, and writes:

    samples.jsonl   one row per (task, class, event, message) with a count
    SUMMARY.md      counts per class, first/last seen, example task ids

Run it after a failure to put the evidence in the repository rather than in a
chat log::

    python3 -m metainfer.tasks.dcu_kernel_auto_opt.error_catalog.collect_errors \
        --root nodes --out metainfer/tasks/dcu_kernel_auto_opt/error_catalog

The classes are the contract: adding a symptom means adding a rule with a
matching section in one of the ``NN-*.md`` files, so "what is this" and "what do
I do" stay one click apart.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Sequence, Tuple

#: Raw evidence is trimmed to keep samples.jsonl greppable.
MAX_RAW_CHARS = 1200


@dataclass(frozen=True)
class ErrorClass:
    """One recurring failure signature.

    ``status`` is the operationally important field:

    * ``fixed`` — a code change removed the cause; recurrence means a new cause
      wearing the same words (see ENV-SHM-SANDBOX);
    * ``by design`` — the pipeline refusing to produce a number it cannot trust
      (a gate, an ownership check). Not a bug, and it should recur;
    * ``environment`` — correct behaviour on a machine somebody else is using;
    * ``open`` — known, not yet addressed.
    """

    id: str
    title: str
    layer: str
    status: str
    patterns: Tuple[str, ...]
    doc: str
    note: str = ""

    def matches(self, text: str) -> bool:
        return any(re.search(p, text) for p in self.patterns)


#: Ordered most specific first: the first match wins, so a message that contains
#: both "shm_open" and "probe failed" is filed under the sandbox, not the wrapper.
CLASSES: Tuple[ErrorClass, ...] = (
    # ---------------------------------------------------------------- environment
    ErrorClass(
        "ENV-SHM-SANDBOX", "无法写 /dev/shm（文件沙箱）", "environment", "fixed",
        (r"shm_open: (permission denied|invalid argument)",
         r"fchmod: bad file descriptor",
         r"can'?t initialize amdsmi"),
        "01-environment.md",
        "ROCm/amdsmi 用 /dev/shm 会合文件起 GPU 栈；被文件沙箱关住就必然失败。"
        "2026-09-22 已修：probe 先自检、不再空重试、报错指名启动方；"
        "WebUI 启动侧也有三道护栏。",
    ),
    ErrorClass(
        "ENV-NO-DEVICE", "看不到设备（No HIP GPUs are available）", "environment", "by design",
        (r"no hip gpus are available", r"visible_devices.{0,12}(0|none)"),
        "01-environment.md",
        "两种成因：栈没起来（见 ENV-SHM-SANDBOX），或 HIP/ROCR 可见设备被双重过滤"
        "（同一非零 index 同时设 HIP_VISIBLE_DEVICES 与 ROCR_VISIBLE_DEVICES）。",
    ),
    ErrorClass(
        "ENV-NO-LEASE", "租不到卡（scheduled/生产模式）", "environment", "environment",
        (r"no gpu lease became available", r"no device passed the admission gate"),
        "01-environment.md",
    ),
    ErrorClass(
        "ENV-GATE-TIMEOUT", "闸门等待/等超时（卡被占）", "environment", "by design",
        (r"did not pass the measurement gate", r"gate probe failed",
         r"no device state was read", r"gate_blocked", r"gate_blocked\b"),
        "03-measurement-and-gate.md",
        "`gate_blocked` 审计行代表\"卡不干净、这一轮不测\"；等满 24h 的最终形态是 "
        "MeasurementGateBlocked。两者都是设计行为，不是故障。",
    ),
    ErrorClass(
        "ENV-PROBE-WRAPPER", "probe 重试后仍失败（外层包装）", "environment", "fixed",
        (r"gpu probe failed after \d+ attempt",),
        "01-environment.md",
        "真正的病因在下一行；本类只是 DKAO 的重试包装，不要据此判断环境好坏。",
    ),
    # ------------------------------------------------------------- generate/agent
    ErrorClass(
        "GEN-CONFLICT", "工作区 main 已被别的 repo 占用", "generate", "fixed",
        (r"already points to",),
        "02-generate-and-agent.md",
    ),
    ErrorClass(
        "GEN-SCHEMA", "表单/契约参数非法", "generate", "by design",
        (r"tp_size must be 4 or 8", r"gpu_mode must be",
         r"execution_profile must be", r"unknown task_type"),
        "02-generate-and-agent.md",
    ),
    ErrorClass(
        "GEN-CONTRACT", "API 契约/参考自检不可信", "generate", "by design",
        (r"staged api contract digest is not trusted",
         r"trusted pytorch reference self-test failed",
         r"generate scaffold unexpectedly contains a hip implementation"),
        "02-generate-and-agent.md",
    ),
    ErrorClass(
        "GEN-OWNERSHIP", "agent 改了自己不该改的文件", "generate", "by design",
        (r"outside its hip ownership", r"changed files outside"),
        "02-generate-and-agent.md",
    ),
    ErrorClass(
        "GEN-BINARY-MISSING", "agent 可执行文件/模块不存在", "generate", "environment",
        (r"no such file or directory: '(ccb|claude|dsh)'", r"no module named '"),
        "02-generate-and-agent.md",
    ),
    ErrorClass(
        "GEN-AGENT-EJECT", "agent 非零退出（逐次尝试）", "generate", "environment",
        (r"generate agent attempt \d+ failed: nonzero exit",
         r"failed: nonzero exit \d+"),
        "02-generate-and-agent.md",
    ),
    ErrorClass(
        "GEN-NO-KERNEL", "agent 没能产出可用内核", "generate", "by design",
        (r"could not generate a valid initial hip kernel",
         r"did not generate", r"did not write proposal\.json"),
        "02-generate-and-agent.md",
    ),
    ErrorClass(
        "GEN-COORD-FAILED", "生成阶段重试耗尽（外层包装）", "generate", "environment",
        (r"kernel coordination failed after",),
        "02-generate-and-agent.md",
    ),
    # ---------------------------------------------------------------- measurement
    ErrorClass(
        "MEAS-REF-PREPARE", "参考缓存准备失败", "measurement", "environment",
        (r"--prepare-reference failed", r"reference cache"),
        "03-measurement-and-gate.md",
    ),
    ErrorClass(
        "MEAS-PMC-UNAVAILABLE", "PMC/hipprof 证据不可用（跳过）", "measurement", "by design",
        (r"worker_pmc_skipped", r"pmc .*(unavailable|not available)",
         r"hipprof"),
        "03-measurement-and-gate.md",
        "不是失败：这一轮按无 PMC 证据继续，调优少了 ISA 依据但不影响正确性。",
    ),
    ErrorClass(
        "MEAS-CMD-FAILED", "基准/PROBE 子进程非零退出", "measurement", "environment",
        (r"returned non-zero exit status", r"command '\[",
         r"failed \(\d+\):", r"--probe failed"),
        "03-measurement-and-gate.md",
    ),
    ErrorClass(
        "MEAS-TIMEOUT", "基准超时", "measurement", "environment",
        (r"timed out", r"timeout"),
        "03-measurement-and-gate.md",
    ),
    # ------------------------------------------------------------- kernel quality
    ErrorClass(
        "KQ-PACK-LAYOUT-CONFLICT",
        "同一权重的多个 M 用了不同 packed 布局（合并期冲突）",
        "kernel-quality", "fixed",
        (r"packed layout conflicts", r"packed layout disagrees",
         r"layout_conflict", r"packed layouts? disagree",
         r"members of one \(n, k\) family pack"),
        "04-kernel-quality.md",
        "冻结的 prepare_weight ABI 没有 M，同族必须共用一份 packed 镜像；"
        "final_layout_gate 在合并前比对每个成员的 pack 指纹，冲突时按布局分批验收。",
    ),
    ErrorClass(
        "KQ-CORRECTNESS", "内核算错（正确性/Graph 校验不过）", "kernel-quality", "by design",
        (r"exact correctness failed", r"graph/correctness validation failed",
         r"mismatch_count", r"paired m=2 fallback failed"),
        "04-kernel-quality.md",
        "这是 DKAO 的日常工作：agent 第一版内核经常不对，重试/repair 会处理。",
    ),
    ErrorClass(
        "KQ-INLINE-ASM", "内联汇编验收门不通过", "kernel-quality", "by design",
        (r"inline asm acceptance gate failed",),
        "04-kernel-quality.md",
    ),
    ErrorClass(
        "KQ-PERF-REGRESSION", "性能回退（最终验收不过）", "kernel-quality", "by design",
        (r"performance regressed", r"final_synthesis_rejected", r"p90 .*regress"),
        "04-kernel-quality.md",
    ),
    # ------------------------------------------------------------ process/infra
    ErrorClass(
        "PROC-AGENT-KILLED", "agent 被 kill（含超时/OOM）", "process", "environment",
        (r"failed: killed", r"see events log tail", r"exit 143", r"sigkill|sigterm"),
        "05-process-and-infra.md",
    ),
    ErrorClass(
        "PROC-NO-WORKER", "一张卡都没跑通（bootstrap 全灭）", "process", "by design",
        (r"fewer than one successful gpu worker",),
        "05-process-and-infra.md",
    ),
    ErrorClass(
        "PROC-BUG", "DKAO 自身的代码缺陷（崩溃）", "process", "open",
        (r"attributeerror", r"typeerror", r"keyerror", r"traceback \(most recent call last\)",
         r"nonetype' object has no attribute"),
        "05-process-and-infra.md",
    ),
)

#: Events worth extracting even when their payload has no obvious error field.
_ERRORISH_EVENT_TOKENS = (
    "error", "failed", "blocked", "rejected", "discarded", "exhausted",
    "incomplete", "killed", "skipped", "timeout", "retry",
    # A packed-layout conflict is reported as its own event (the merge repairs
    # it by batching, so no exception is raised) and must still be counted.
    "conflict",
)


def classify(text: str) -> Optional[ErrorClass]:
    """The class of one message, or ``None`` when nothing matches."""
    lowered = str(text or "").lower()
    for cls in CLASSES:
        if cls.matches(lowered):
            return cls
    return None


@dataclass
class Record:
    """One extracted error occurrence."""

    class_id: str
    task_id: str
    task_type: str
    source: str
    event: str
    ts: Optional[float]
    raw: str
    run_id: Optional[str] = None
    occurrences: int = 1

    def to_json(self) -> Dict[str, Any]:
        return {
            "class_id": self.class_id,
            "task_id": self.task_id,
            "run_id": self.run_id,
            "task_type": self.task_type,
            "source": self.source,
            "event": self.event,
            "ts": self.ts,
            "occurrences": self.occurrences,
            "raw": self.raw,
        }


def _trim(text: Any, limit: int = MAX_RAW_CHARS) -> str:
    s = str(text if text is not None else "")
    s = re.sub(r"\s+", " ", s).strip()
    return s if len(s) <= limit else s[: limit - 1] + "…"


def _first_text(payload: Dict[str, Any]) -> str:
    for key in ("error", "reason", "detail", "message", "stderr", "failure"):
        if payload.get(key):
            return _trim(payload[key])
    return _trim(json.dumps(payload, ensure_ascii=False))


def _is_errorish(event_type: str, payload: Dict[str, Any]) -> bool:
    lowered = str(event_type).lower()
    if any(tok in lowered for tok in _ERRORISH_EVENT_TOKENS):
        return True
    return any(payload.get(k) for k in ("error", "failure"))


def _read_jsonl(path: Path) -> Iterator[Dict[str, Any]]:
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if isinstance(row, dict):
                    yield row
    except OSError:
        return


def _read_json(path: Path) -> Optional[Dict[str, Any]]:
    try:
        data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _task_type(state_dir: Path) -> str:
    run = _read_json(state_dir / "run.json") or {}
    req = _read_json(state_dir / "requirements.json") or {}
    return str(run.get("task_type") or req.get("task_type") or "unknown")


def _task_label(state_dir: Path) -> str:
    """A readable id for an embedded DKAO run.

    Children of a harness run are all called ``state``, so the directory name
    alone would file every one of them under the same useless id. Their path
    carries the information: ``workspaces/<parent>/children/<iteration>/<shape>``.
    """
    parts = state_dir.parts
    if state_dir.name == "state" and "children" in parts:
        idx = parts.index("children")
        parent = parts[idx - 1] if idx >= 1 else "?"
        tail = "/".join(parts[idx + 1:-1]) or state_dir.parent.name
        return f"{parent}:{tail}"
    return state_dir.name


def scan_task(state_dir: Path, workspace_dir: Optional[Path] = None,
              ) -> List[Record]:
    """Every classifiable error string inside one task's evidence."""
    task_id = _task_label(state_dir)
    task_type = _task_type(state_dir)
    run = _read_json(state_dir / "run.json")
    run_id = str((run or {}).get("task_id") or "") or None
    out: List[Record] = []

    def add(source: str, event: str, ts: Optional[float], text: Any) -> None:
        cls = classify(f"{event} {text}")
        if cls is None:
            return
        out.append(Record(class_id=cls.id, task_id=task_id, task_type=task_type,
                          source=source, event=str(event), run_id=run_id,
                          ts=float(ts) if ts else None, raw=_trim(text)))

    if run:
        ts = run.get("last_update") or run.get("created_at")
        if run.get("notes"):
            add("run.json", f"note:{run.get('final_status') or 'note'}", ts,
                run["notes"][-1])
        elif str(run.get("final_status") or "") in {"stopped", "failed"}:
            add("run.json", f"final_status:{run.get('final_status')}",
                ts, run.get("last_outcome"))

    for row in _read_jsonl(state_dir / "timeline.jsonl"):
        payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
        event = str(row.get("type") or "")
        if not _is_errorish(event, payload):
            continue
        add("timeline.jsonl", event, row.get("ts"), _first_text(payload))

    probe = _read_json(state_dir / "gpu_probe_failure.json")
    if probe:
        shm = probe.get("dev_shm_write") if isinstance(probe.get("dev_shm_write"), dict) else {}
        text = (
            f"gpu probe failed; dev_shm_write={json.dumps(shm, ensure_ascii=False)}; "
            f"attempts={probe.get('attempts')} "
            f"performed={probe.get('attempts_performed')}"
        )
        if not shm.get("ok", True):
            text = ("shm_open: " + str(shm.get("error")) + " " + text)
        add("gpu_probe_failure.json", "probe_diagnostics", probe.get("ts"), text)

    for row in _read_jsonl(state_dir / "measurement_gate.jsonl"):
        if row.get("event") == "gate_blocked":
            add("measurement_gate.jsonl", "gate_blocked", row.get("ts"),
                f"gpu{row.get('gpu')} site={row.get('site')} "
                f"vram={row.get('vram_percent')} util={row.get('util_percent')} "
                f"reasons={row.get('reasons')}")

    if workspace_dir and workspace_dir.is_dir():
        for failure in sorted(workspace_dir.glob("workers/*/failure.json")):
            data = _read_json(failure) or {}
            add("workers/failure.json",
                f"worker:{data.get('worker_id')}:{data.get('stage')}",
                data.get("timestamp"), data.get("error") or json.dumps(data))
        for status in sorted(workspace_dir.glob("workers/*/status.json")):
            data = _read_json(status) or {}
            if str(data.get("state") or "") in {"failed", "timed_out", "error"}:
                add("workers/status.json",
                    f"worker:{data.get('worker_id')}:{data.get('state')}",
                    data.get("last_update"), json.dumps(data, ensure_ascii=False))
    return out


def _is_state_dir(path: Path) -> bool:
    return (path / "run.json").is_file() or (path / "timeline.jsonl").is_file()


def _node_roots(root: Path) -> List[Path]:
    """Directories that hold ``.metainfer/`` and/or ``workspaces/``.

    Accepts whatever the operator points at: the ``nodes`` directory, one node
    directory, or something in between. Getting this wrong is silent and costly
    — pointing the collector at a node dir used to find only the WebUI tasks and
    quietly drop every harness child, which is where most environment failures
    are recorded.
    """
    if (root / ".metainfer").is_dir() or (root / "workspaces").is_dir():
        return [root]
    if root.name == "tasks" and root.parent.name == ".metainfer":
        return [root.parent.parent]
    return [p for p in sorted(root.glob("*"))
            if p.is_dir() and ((p / ".metainfer").is_dir()
                               or (p / "workspaces").is_dir())]


def _task_dirs(root: Path, *, task_type: Optional[str] = None) -> List[Path]:
    """Every DKAO state dir under ``root``.

    Two layouts hold them and both matter:

    * ``nodes/<node>/.metainfer/tasks/<id>`` — a task started from the WebUI;
    * ``nodes/<node>/workspaces/<parent>/children/**/state`` — a DKAO task
      started by the harness-evolve parent, one per question per attempt. These
      are where most of the *environment* failures live, so skipping them would
      leave the interesting half of the history out.
    """
    if _is_state_dir(root):
        candidates = [root]
    else:
        candidates = []
        for node in _node_roots(root):
            tasks = node / ".metainfer" / "tasks"
            if tasks.is_dir():
                candidates.extend(sorted(p for p in tasks.iterdir() if p.is_dir()))
            workspaces = node / "workspaces"
            if workspaces.is_dir():
                candidates.extend(sorted(workspaces.glob("*/children/**/state")))
    found = [p for p in candidates if p.is_dir() and _is_state_dir(p)]
    if task_type:
        found = [p for p in found if _task_type(p) == task_type]
    # A task dir may be reachable through two patterns; keep each once.
    seen: Dict[str, Path] = {}
    for path in found:
        seen.setdefault(str(path.resolve()), path)
    return sorted(seen.values())


def _workspace_for(state_dir: Path) -> Optional[Path]:
    """The artifact tree next to a state dir, in either layout."""
    sibling = state_dir.parent / "workspace"
    if sibling.is_dir():
        return sibling
    parts = list(state_dir.parts)
    if ".metainfer" in parts:
        idx = len(parts) - 1 - parts[::-1].index(".metainfer")
        if idx > 0:
            candidate = Path(*parts[: idx - 1]) / "workspaces" / state_dir.name
            if candidate.is_dir():
                return candidate
    return None


@dataclass
class Collection:
    records: List[Record] = field(default_factory=list)
    scanned: int = 0

    def by_class(self) -> Dict[str, List[Record]]:
        out: Dict[str, List[Record]] = {}
        for rec in self.records:
            out.setdefault(rec.class_id, []).append(rec)
        return out


def collect(roots: Sequence[Path], *,
            task_type: Optional[str] = "dcu-kernel-auto-opt") -> Collection:
    """Scan every root; identical messages collapse into one counted record."""
    merged: Dict[Tuple[str, str, str, str], Record] = {}
    collection = Collection()
    for root in roots:
        for state_dir in _task_dirs(Path(root), task_type=task_type):
            collection.scanned += 1
            for rec in scan_task(state_dir, _workspace_for(state_dir)):
                key = (rec.class_id, rec.task_id, rec.source, rec.raw)
                if key in merged:
                    merged[key].occurrences += 1
                else:
                    merged[key] = rec
    collection.records = sorted(
        merged.values(), key=lambda r: (r.class_id, r.task_id, r.source))
    return collection


def render_summary(collection: Collection, *, examples: int = 3) -> str:
    """A markdown table: class, count, first/last seen, example tasks."""
    import datetime

    buckets = collection.by_class()
    lines = [
        "# DKAO 报错汇总（自动生成）",
        "",
        f"- 扫描任务数：**{collection.scanned}**",
        f"- 命中报错条目：**{len(collection.records)}**（去重后）",
        f"- 生成时间：{datetime.datetime.now().strftime('%Y-%m-%d %H:%M')}",
        "",
        "由 `collect_errors.py` 生成，请勿手改；新增/调整判定规则改那里，"
        "人类解释写在 `NN-*.md`。",
        "",
        "| 类别 | 标题 | 层 | 状态 | 次数 | 首次 | 最近 | 示例任务 |",
        "|---|---|---|---|---:|---|---|---|",
    ]
    ordered = sorted(
        CLASSES, key=lambda c: (-len(buckets.get(c.id, [])), c.id))
    for cls in ordered:
        rows = buckets.get(cls.id) or []
        stamps = sorted(r.ts for r in rows if r.ts)
        first = (datetime.datetime.fromtimestamp(stamps[0]).strftime("%Y-%m-%d %H:%M")
                 if stamps else "—")
        last = (datetime.datetime.fromtimestamp(stamps[-1]).strftime("%Y-%m-%d %H:%M")
                if stamps else "—")
        seen: List[str] = []
        for rec in rows:
            if rec.task_id not in seen:
                seen.append(rec.task_id)
        shown = ", ".join(f"`{t}`" for t in seen[:examples])
        if len(seen) > examples:
            shown += f" … (+{len(seen) - examples})"
        lines.append(
            f"| `{cls.id}` | {cls.title} | {cls.layer} | {cls.status} | "
            f"{len(rows)} | {first} | {last} | {shown or '—'} |")
    lines += ["", "> 未命中任何类别的条目不会出现在汇总里；"
                  "如果某个新报错总被漏掉，就在 `CLASSES` 里加一条规则。"]
    return "\n".join(lines) + "\n"


def main(argv: Optional[Sequence[str]] = None) -> int:
    here = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(
        prog="dkao-collect-errors",
        description="把 DKAO 的历史报错抽出来，落到 error_catalog/ 下。")
    parser.add_argument("--root", action="append", default=None,
                        help="nodes 目录、某个节点的 .metainfer/tasks，"
                             "或单个任务 state 目录（可重复）")
    parser.add_argument("--task-type", default="dcu-kernel-auto-opt",
                        help="只收这个 task_type 的任务（默认 dcu-kernel-auto-opt；"
                             "传 any 收全部）")
    parser.add_argument("--out", default=str(here),
                        help="输出目录（默认就是本目录）")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)

    roots = [Path(r) for r in (args.root or [])]
    if not roots:
        repo = here.parents[3]          # …/MetaInfer
        nodes = repo / "nodes"
        roots = [nodes] if nodes.is_dir() else [repo]
    wanted = None if str(args.task_type).strip().lower() == "any" else args.task_type
    collection = collect(roots, task_type=wanted)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    with (out / "samples.jsonl").open("w", encoding="utf-8") as fh:
        for rec in collection.records:
            fh.write(json.dumps(rec.to_json(), ensure_ascii=False) + "\n")
    (out / "SUMMARY.md").write_text(render_summary(collection), encoding="utf-8")
    if not args.quiet:
        buckets = collection.by_class()
        print(f"scanned {collection.scanned} task dir(s) from "
              f"{', '.join(str(r) for r in roots)}")
        for cls in sorted(CLASSES, key=lambda c: -len(buckets.get(c.id, []))):
            n = len(buckets.get(cls.id, []))
            if n:
                print(f"  {n:>4}  {cls.id:<20} {cls.title}")
        print(f"wrote {out / 'samples.jsonl'} and {out / 'SUMMARY.md'}")
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI
    raise SystemExit(main())
