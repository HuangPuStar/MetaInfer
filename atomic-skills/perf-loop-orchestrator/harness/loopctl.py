#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""perf-loop 确定性控制器。

唯一事实源：loop/state.json（原子写、幂等）。主 Agent 每个动作前先跑 `status`，
按返回的 verdict/suggested_action 决策，不依赖对话记忆。

子命令：
  init    --goal GOAL.md            初始化 loop/ 骨架与 state.json（幂等）
  launch  --iter N --step X --cmd "..." [--timeout S] [--trace-file F] [--attempt A]
                                    后台托管启动 subagent（看门狗+心跳+硬超时）
  status                               当前轮步状态 + 健康裁决 + 建议动作（JSON）
  kill    --iter N --step X          终止该步进程组，置 KILLED（轨迹保留）
  mark    --iter N --step X --verdict pass|fail|skip [--note ...] [--commit ...]
                                    登记步骤结果并推进轮步指针
  collect --iter N --step X [--files F ...]  幂等追加该步轨迹到 traces/history.jsonl
  bump-goal --note "..."             目标变更留痕（goal_version+1）
"""
import argparse
import hashlib
import json
import os
import shlex
import subprocess
import sys
import time
from pathlib import Path

HB_TICK = 15  # 看门狗心跳间隔（秒）
VERDICT_STATES = ("RUNNING", "DONE", "FAILED", "TIMEOUT", "KILLED", "CRASHED")


# ---------- 基础工具 ----------
def loop_dir(a) -> Path:
    d = Path(a.loop_dir).resolve() if a.loop_dir else Path.cwd() / "loop"
    return d


def atomic_write_json(p: Path, obj):
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, p)


def read_json(p: Path, default=None):
    if not p.exists():
        return default
    return json.loads(p.read_text(encoding="utf-8"))


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def pid_alive(pid: int) -> bool:
    if not pid or pid < 0:
        return False
    try:
        if os.name == "nt":
            # tasklist 输出为控制台码页，按字节匹配避免解码问题
            r = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}"],
                capture_output=True, timeout=15,
            )
            return str(pid).encode() in (r.stdout or b"")
        os.kill(pid, 0)
        return True
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return False


def kill_tree(pid: int):
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                           capture_output=True, timeout=30)
        else:
            import signal
            os.killpg(os.getpgid(pid), signal.SIGKILL)
    except (OSError, subprocess.TimeoutExpired):
        if pid_alive(pid):
            try:
                os.kill(pid, 9)
            except OSError:
                pass


def detach_flags():
    if os.name == "nt":
        return 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    return 0


def step_paths(L: Path, it: int, st: int):
    tag = f"iter_{it:03d}_step{st}"
    return {
        "step": L / "steps" / f"{tag}.json",
        "out": L / "logs" / f"{tag}.out",
        "err": L / "logs" / f"{tag}.err",
        "hb": L / "logs" / f"{tag}.hb",
        "trace": L / "traces" / f"{tag}.jsonl",
    }


def default_budget():
    return {"step_timeout_s": 1800, "stale_s": 900, "step_retries": 1,
            "max_errors_per_round": 3}


# ---------- 子命令 ----------
def cmd_init(a):
    L = loop_dir(a)
    for sub in ("steps", "logs", "traces", "reports"):
        (L / sub).mkdir(parents=True, exist_ok=True)
    goal = Path(a.goal).resolve()
    if not goal.exists():
        sys.exit(f"goal file not found: {goal}")
    if not (L / "GOAL.md").exists():
        (L / "GOAL.md").write_text(goal.read_text(encoding="utf-8"), encoding="utf-8")
    st = read_json(L / "state.json")
    if st is None:
        st = {
            "goal_version": 1,
            "goal_sha256": sha256_file(L / "GOAL.md"),
            "budget": default_budget(),
            "iter": 1, "step": 1,
            "iters": [], "errors": [],
            "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }
        atomic_write_json(L / "state.json", st)
    print(json.dumps({"ok": True, "loop_dir": str(L),
                      "goal_sha256": st["goal_sha256"]}, ensure_ascii=False))


def cmd_launch(a):
    L = loop_dir(a)
    st = read_json(L / "state.json") or sys.exit("state.json missing: run init first")
    sp = step_paths(L, a.iter, a.step)
    sp["step"].parent.mkdir(parents=True, exist_ok=True)
    (L / "logs").mkdir(exist_ok=True)
    (L / "traces").mkdir(exist_ok=True)
    timeout = a.timeout or st["budget"]["step_timeout_s"]
    trace = Path(a.trace_file).resolve() if a.trace_file else sp["trace"]
    # 先复位步骤文件（清掉旧终态/旧pid），launch_id 用于识别本轮写入、防陈旧竞态
    meta = {
        "launch_id": str(time.time_ns()),
        "iter": a.iter, "step": a.step, "attempt": a.attempt or 1,
        "cmd": a.cmd, "timeout_s": timeout,
        "trace_file": str(trace), "started": time.time(),
        "state": "RUNNING", "pid": None, "rc": None,
    }
    atomic_write_json(sp["step"], meta)
    # 看门狗自身独立会话，父进程退出不影响
    watch_cmd = [sys.executable, str(Path(__file__).resolve()), "_watch",
                 "--loop-dir", str(L), "--iter", str(a.iter), "--step", str(a.step)]
    w = subprocess.Popen(watch_cmd, creationflags=detach_flags(),
                         start_new_session=(os.name != "nt"),
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         stdin=subprocess.DEVNULL)
    # 等 _watch 回写 pid（须匹配本轮 launch_id）
    ok = False
    for _ in range(100):
        time.sleep(0.1)
        m = read_json(sp["step"])
        if m and m.get("launch_id") == meta["launch_id"] and m.get("pid"):
            meta = m
            ok = True
            break
    print(json.dumps({"ok": ok, "iter": a.iter, "step": a.step,
                      "pid": meta.get("pid"), "watchdog": w.pid,
                      "attempt": meta.get("attempt"),
                      "timeout_s": timeout, "trace_file": str(trace),
                      "error": None if ok else "watchdog did not start, inspect loop/logs"},
                     ensure_ascii=False))


def cmd_watch(a):
    """内部：托管子进程——重定向日志、心跳、硬超时、终态回写。不面向用户。"""
    L = Path(a.loop_dir).resolve()
    st = read_json(L / "state.json") or sys.exit(1)
    sp = step_paths(L, a.iter, a.step)
    meta = read_json(sp["step"]) or {
        "iter": a.iter, "step": a.step, "attempt": 1,
        "cmd": "", "timeout_s": st["budget"]["step_timeout_s"],
        "trace_file": str(sp["trace"]), "started": time.time(),
        "state": "RUNNING",
    }
    timeout = meta["timeout_s"]
    sp["hb"].touch()
    out = open(sp["out"], "ab")
    err = open(sp["err"], "ab")
    kw = {}
    if os.name != "nt":
        kw["start_new_session"] = True  # 子进程独立进程组，kill 可整树终止
    child = subprocess.Popen(meta["cmd"], shell=True, stdout=out, stderr=err,
                             stdin=subprocess.DEVNULL, **kw)
    meta["pid"] = child.pid
    atomic_write_json(sp["step"], meta)
    deadline = meta["started"] + timeout
    rc, state = None, "RUNNING"
    while True:
        rc = child.poll()
        if rc is not None:
            state = "DONE" if rc == 0 else "FAILED"
            break
        if time.time() > deadline:
            kill_tree(child.pid)
            rc, state = None, "TIMEOUT"
            break
        sp["hb"].touch()
        time.sleep(HB_TICK)
    # 外部 kill 已置 KILLED 时保留该判定，不覆写
    cur = read_json(sp["step"]) or meta
    if cur.get("state") == "KILLED":
        state = "KILLED"
    meta.update({"state": state, "rc": rc, "ended": time.time()})
    atomic_write_json(sp["step"], meta)


def freshness(sp: dict, meta: dict) -> float:
    """最近一次可观测输出（日志/心跳/轨迹）距今秒数——卡死判据用输出新鲜度。"""
    cands = [sp["hb"], sp["out"], sp["err"]]
    tf = meta.get("trace_file")
    if tf:
        cands.append(Path(tf))
    mt = [p.stat().st_mtime for p in cands if p.exists()]
    return (time.time() - max(mt)) if mt else float("inf")


def verdict_of(meta, sp) -> str:
    if meta is None:
        return "NOT_STARTED"
    state = meta.get("state")
    if state in ("DONE", "FAILED", "TIMEOUT", "KILLED"):
        return state
    # state == RUNNING：核对进程真实存活
    if not pid_alive(meta.get("pid") or -1):
        return "CRASHED"  # 进程没了但没人回写终态（看门狗也死了）
    return "RUNNING"


def suggest(v: str, meta, st: dict) -> str:
    retries = st["budget"]["step_retries"]
    att = (meta or {}).get("attempt", 1)
    if v == "NOT_STARTED":
        return "GENERATE_DISPATCH_THEN_LAUNCH"
    if v == "RUNNING":
        return "WAIT_BOUNDED_THEN_RECHECK"
    if v == "STUCK":
        return "KILL_THEN_RETRY_OR_ADVANCE"  # 进程活着但无输出进展：先杀再按预算
    if v == "CRASHED":
        return "KILL_ORPHAN_THEN_RETRY_OR_ADVANCE"  # 看门狗死了，子进程可能成孤儿仍占资源
    if v in ("TIMEOUT", "KILLED", "FAILED"):
        return ("RETRY_DEGRADED_ONCE" if att <= retries
                else "MARK_FAIL_AND_ADVANCE")
    if v == "DONE":
        return "VALIDATE_ARTIFACTS_THEN_MARK_PASS"
    return "INSPECT_MANUALLY"


def cmd_status(a):
    L = loop_dir(a)
    st = read_json(L / "state.json") or sys.exit("state.json missing: run init first")
    it, x = st["iter"], st["step"]
    sp = step_paths(L, it, x)
    meta = read_json(sp["step"])
    v = verdict_of(meta, sp)
    fr = freshness(sp, meta) if meta else None
    stale = bool(meta) and fr is not None and fr > st["budget"]["stale_s"]
    if v == "RUNNING" and stale:
        v = "STUCK"
    out = {
        "loop_dir": str(L), "goal_version": st["goal_version"],
        "goal_sha256": st["goal_sha256"],
        "iter": it, "step": x,
        "verdict": v,
        "pid": (meta or {}).get("pid"),
        "attempt": (meta or {}).get("attempt", 0),
        "elapsed_s": round(time.time() - meta["started"], 1) if meta else None,
        "freshness_s": round(fr, 1) if fr and fr != float("inf") else None,
        "stale": stale,
        "budget": st["budget"],
        "iters_completed": len(st.get("iters", [])),
        "errors_recent": st.get("errors", [])[-3:],
        "suggested_action": suggest(v, meta, st),
    }
    print(json.dumps(out, ensure_ascii=False, indent=1))


def cmd_kill(a):
    L = loop_dir(a)
    sp = step_paths(L, a.iter, a.step)
    meta = read_json(sp["step"]) or sys.exit(f"no such step: iter{a.iter} step{a.step}")
    if meta.get("state") in VERDICT_STATES and meta["state"] != "RUNNING":
        pass  # 已终态，幂等
    else:
        if pid_alive(meta.get("pid") or -1):
            kill_tree(meta["pid"])
        meta.update({"state": "KILLED", "rc": None, "ended": time.time()})
        atomic_write_json(sp["step"], meta)
    print(json.dumps({"ok": True, "state": meta["state"],
                      "note": "logs/traces preserved for postmortem"},
                     ensure_ascii=False))


def cmd_mark(a):
    L = loop_dir(a)
    st = read_json(L / "state.json") or sys.exit("state.json missing")
    if a.verdict not in ("pass", "fail", "skip"):
        sys.exit("verdict must be pass|fail|skip")
    if a.iter != st["iter"] or a.step != st["step"]:
        sys.exit(f"pointer at iter {st['iter']} step {st['step']}; "
                 f"refusing to mark iter {a.iter} step {a.step} (防跳步/防回头)")
    iters = st.setdefault("iters", [])
    rec = next((r for r in iters if r["n"] == a.iter), None)
    if rec is None:
        rec = {"n": a.iter, "steps": {}, "commit": None, "conclusion": None}
        iters.append(rec)
    rec["steps"][str(a.step)] = {
        "verdict": a.verdict, "note": a.note or "",
        "commit": a.commit or None, "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    if a.verdict == "fail":
        st.setdefault("errors", []).append(
            {"iter": a.iter, "step": a.step, "note": a.note or "",
             "ts": time.strftime("%Y-%m-%dT%H:%M:%S")})
    # 推进指针：step3 之后进入下一轮
    if st["step"] < 3:
        st["step"] += 1
    else:
        st["iter"] += 1
        st["step"] = 1
    atomic_write_json(L / "state.json", st)
    print(json.dumps({"ok": True, "next": {"iter": st["iter"], "step": st["step"]}},
                     ensure_ascii=False))


def cmd_collect(a):
    L = loop_dir(a)
    st = read_json(L / "state.json") or sys.exit("state.json missing")
    sp = step_paths(L, a.iter, a.step)
    meta = read_json(sp["step"])
    files = [Path(f) for f in (a.files or [])] or \
            ([Path(meta["trace_file"])] if meta and meta.get("trace_file") else []) or \
            ([sp["trace"]] if sp["trace"].exists() else [])
    hist = L / "traces" / "history.jsonl"
    seen = {}
    if hist.exists():
        for line in hist.read_text(encoding="utf-8").splitlines():
            try:
                r = json.loads(line)
                seen[(r.get("iter"), r.get("step"), r.get("sha256"))] = True
            except json.JSONDecodeError:
                continue
    added = 0
    with open(hist, "a", encoding="utf-8") as h:
        for f in files:
            if not f.exists():
                continue
            sha = sha256_file(f)
            key = (a.iter, a.step, sha)
            if key in seen:
                continue  # 幂等：同内容不重复归档
            rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
                   "iter": a.iter, "step": a.step,
                   "state": (meta or {}).get("state"),
                   "file": str(f), "sha256": sha,
                   "size": f.stat().st_size}
            h.write(json.dumps(rec, ensure_ascii=False) + "\n")
            h.flush()
            os.fsync(h.fileno())
            seen[key] = True
            added += 1
    print(json.dumps({"ok": True, "added": added,
                      "history": str(hist)}, ensure_ascii=False))


def cmd_bump_goal(a):
    L = loop_dir(a)
    st = read_json(L / "state.json") or sys.exit("state.json missing")
    st["goal_version"] += 1
    st["goal_sha256"] = sha256_file(L / "GOAL.md")
    st.setdefault("goal_changes", []).append(
        {"version": st["goal_version"], "note": a.note or "",
         "sha256": st["goal_sha256"],
         "ts": time.strftime("%Y-%m-%dT%H:%M:%S")})
    atomic_write_json(L / "state.json", st)
    print(json.dumps({"ok": True, "goal_version": st["goal_version"]},
                     ensure_ascii=False))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--loop-dir", default=None, help="loop 目录（默认 ./loop）")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("init");       s.add_argument("--goal", required=True); s.set_defaults(f=cmd_init)
    s = sub.add_parser("launch")
    s.add_argument("--iter", type=int, required=True); s.add_argument("--step", type=int, required=True)
    s.add_argument("--cmd", required=True); s.add_argument("--timeout", type=int, default=None)
    s.add_argument("--trace-file", default=None); s.add_argument("--attempt", type=int, default=1)
    s.set_defaults(f=cmd_launch)
    s = sub.add_parser("status");     s.set_defaults(f=cmd_status)
    s = sub.add_parser("kill");       s.add_argument("--iter", type=int, required=True)
    s.add_argument("--step", type=int, required=True); s.set_defaults(f=cmd_kill)
    s = sub.add_parser("mark")
    s.add_argument("--iter", type=int, required=True); s.add_argument("--step", type=int, required=True)
    s.add_argument("--verdict", required=True); s.add_argument("--note", default=None)
    s.add_argument("--commit", default=None);    s.set_defaults(f=cmd_mark)
    s = sub.add_parser("collect")
    s.add_argument("--iter", type=int, required=True); s.add_argument("--step", type=int, required=True)
    s.add_argument("--files", nargs="*", default=None); s.set_defaults(f=cmd_collect)
    s = sub.add_parser("bump-goal"); s.add_argument("--note", required=True); s.set_defaults(f=cmd_bump_goal)
    s = sub.add_parser("_watch")
    s.add_argument("--iter", type=int, required=True); s.add_argument("--step", type=int, required=True)
    s.add_argument("--loop-dir", default=None)  # 看门狗自调用时此参数位于子命令之后
    s.set_defaults(f=cmd_watch)

    a = p.parse_args()
    a.f(a)


if __name__ == "__main__":
    main()
