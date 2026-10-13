# 05 · 进程与基础设施类

进程被谁杀、谁没跑起来、DKAO 自己崩没崩——都在这一层。

---

## PROC-AGENT-KILLED

**agent 被 kill** ｜ 状态：环境 ｜ 真出现 **432** 次（历史上最多）

```
worker_0-m16_wqkv_a-iter8 failed: killed (see events log tail)
WorkerIterationFailed: worker_1-...-iter5 failed: killed
exit 143 / SIGTERM
```

### 判定 / 根因

agent 进程被外部终止：任务被 kill、agent 栈超时/OOM、父进程退出、容器资源限制。
同样的文本既可能来自"用户点了 Stop"，也可能来自 OOM——所以**要结合同刻的事件看**：
- `task_killed {prior_pid, force}` → 人为停止（正常）；
- 没有任何 kill 事件、却出现 `killed (see events log tail)` → agent 侧被杀（查 agent 日志末尾、
  系统 `dmesg` OOM 记录、`Max resident set` 限制）。

### 处置

- 人为 kill：无需处理；
- 非人为：按"基础设施失败"处理（管线本就给它补一轮，`_MAX_INFRASTRUCTURE_RECOVERY_ROUNDS = 5`），
  同时查内存/句柄限制（`/proc/<pid>/limits`，诊断文件里有）与 agent 超时配置。

---

## PROC-NO-WORKER

**`worker bootstrap has fewer than one successful GPU worker`** ｜ 状态：设计行为 ｜ 真出现 1 次

所有 lane 的 bootstrap 都没产出可用内核（每卡 3 次尝试全灭）→ 没有基准、没有考卷，任务停止。
**这是"全灭"的汇总**：逐个 lane 看 `worker_failed` / `workers/<id>/failure.json` 才知道病因
（`GEN-BINARY-MISSING` / `GEN-NO-KERNEL` / `ENV-*` 都可能）。

处置：先修 lane 级病因（大多数是环境/工具），再重跑；只要有一个 lane 成功任务就会继续用幸存卡跑。

---

## PROC-BUG

**DKAO 自身崩溃（AttributeError / TypeError / KeyError / traceback）** ｜ 状态：待办

这次扫描里 **0 条**属于 DKAO 目录（说明近期没有这类崩溃）。
唯一命中过的同类错误 `champion_record_failed: AttributeError("'NoneType' object has no attribute 'get'")`
（09-11，26 次）来自 **harness-evolve** 的 `orchestrator/pipeline.py`，不是 DKAO 的代码路径——
所以它没进本目录。想连父任务一起收：`collect_errors.py --task-type any`。

处置：这类必须修代码（补测试），不是环境问题；排查看 traceback 的第一帧是否落在
`metainfer/tasks/dcu_kernel_auto_opt/orchestrator/*`。

---

## 僵尸/残留进程（不是报错，但常被当成报错）

- **僵尸 orchestrator**：任务被 kill/purge 后，`ps` 里可能留下
  `[metainfer-dkao] <defunct>`（父进程是 WebUI，它不 `wait()`）。**不占卡、不占 CPU**，
  重启 WebUI 即消失。看到它不等于"任务还在跑"。
- **判据**：`ps -o stat= -p <pid>` 显示 `Z`；`run.json` 的 `final_status` 已终态。
- **残留工作区**：被 kill 的任务保留 state/workspace（这是设计：留证据）；
  kernel repo 需要 `DELETE /api/sys-shell/<task_id>?purge=true` 或在 UI 里删除才清掉。

---

## 证据会消失（重要）

`purge` 会同时删 state_dir、workspace 和 kernel repo。2026-09-22 那次
`dcu-kernel-auto-opt-5ed5c157` 的现场（含 `gpu_probe_failure.json`）就是这样没了的——
所以：**值得留的报错原文，请贴进本目录对应 md**（README 里那节标本就是因此保留的）。
