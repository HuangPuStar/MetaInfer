# DKAO 报错档案（error_catalog）

这里专门收 DKAO（`dcu-kernel-auto-opt`）**真实出现过的报错**：原文、判定特征、根因、处置、以及是否已经修掉。

为什么要单独建目录：同一个报错文本会**以不同根因反复出现**。最典型的是 `shm_open: Permission denied` ——
2026-08-20 / 08-21 / 08-23 / 09-09 / 09-20~09-22 都报过，前几次被当成"容器 GPU 栈偶发抖动"，
直到 09-22 才确认是**启动方被文件沙箱关住**（`01-environment.md`）。UI 只给你那一句话，
这里给你"这句话属于哪一类、该干什么"。

## 怎么用

1. **先按报错原文查**（`samples.jsonl` 里 grep 最方便）：
   ```bash
   grep -i "shm_open" metainfer/tasks/dcu_kernel_auto_opt/error_catalog/samples.jsonl
   ```
2. 看 `class_id`，打开对应的 `NN-*.md` 里的那一节：判定 / 根因 / 处置 / 状态。
3. **新报错**：在 `collect_errors.py` 的 `CLASSES` 里加一条规则（id + 正则 + 状态 + 指向的 md），
   在执行目录里补一节解释，然后重跑收集器；测试在 `tests/test_error_catalog.py`。

```bash
# 重新收集（默认扫 nodes/ 下所有 dcu-kernel-auto-opt 任务，含 harness 子任务）
python3 -m metainfer.tasks.dcu_kernel_auto_opt.error_catalog.collect_errors
# 只扫某个任务
python3 -m ...collect_errors --root nodes/worker29/.metainfer/tasks/dcu-kernel-auto-opt-7892abc2
# 连 harness-evolve 父任务的报错一起收
python3 -m ...collect_errors --task-type any
```

产物：`samples.jsonl`（每条：类别 / 任务 / 来源文件 / 事件 / 时间 / 原文，按原文去重并计数）、
`SUMMARY.md`（各分类的次数、首末时间、示例任务）。两者都是**生成物，别手改**。

## 类别总览

| 类别 | 一句话 | 层 | 状态 | 详见 |
|---|---|---|---|---|
| `ENV-SHM-SANDBOX` | 进程树写不了 `/dev/shm`（文件沙箱），GPU 栈起不来 | 环境 | **已修** | [01](01-environment.md#env-shm-sandbox) |
| `ENV-NO-DEVICE` | `No HIP GPUs are available`：栈没起来 或 可见设备被双重过滤 | 环境 | 设计行为 | [01](01-environment.md#env-no-device) |
| `ENV-PROBE-WRAPPER` | `GPU probe failed after N attempt(s)`（外层包装，病因在下一行） | 环境 | 已修 | [01](01-environment.md#env-probe-wrapper) |
| `ENV-NO-LEASE` | scheduled/生产模式租不到卡 | 环境 | 环境 | [01](01-environment.md#env-no-lease) |
| `ENV-GATE-TIMEOUT` | 闸门等满 24h：卡长期被占，宁可不测 | 环境 | 设计行为 | [03](03-measurement-and-gate.md#env-gate-timeout) |
| `GEN-CONFLICT` | `workspace main already points to …`（子任务目录被复用） | 生成 | **已修** | [02](02-generate-and-agent.md#gen-conflict) |
| `GEN-SCHEMA` | 表单/契约参数非法（如 `tp_size must be 4 or 8`） | 生成 | 设计行为 | [02](02-generate-and-agent.md#gen-schema) |
| `GEN-CONTRACT` | API 契约摘要不可信 / 参考自检失败 | 生成 | 设计行为 | [02](02-generate-and-agent.md#gen-contract) |
| `GEN-OWNERSHIP` | agent 改了自己不该改的文件 | 生成 | 设计行为 | [02](02-generate-and-agent.md#gen-ownership) |
| `GEN-BINARY-MISSING` | agent 可执行文件/模块不存在（`'ccb'`） | 生成 | 环境 | [02](02-generate-and-agent.md#gen-binary-missing) |
| `GEN-AGENT-EJECT` | `Generate agent attempt N failed: nonzero exit` | 生成 | 环境 | [02](02-generate-and-agent.md#gen-agent-eject) |
| `GEN-NO-KERNEL` | agent 没能产出可用内核 | 生成 | 设计行为 | [02](02-generate-and-agent.md#gen-no-kernel) |
| `GEN-COORD-FAILED` | `Kernel coordination failed after 3 attempts`（外层包装） | 生成 | 环境 | [02](02-generate-and-agent.md#gen-coord-failed) |
| `MEAS-CMD-FAILED` | 基准/probe 子进程非零退出 | 测量 | 环境 | [03](03-measurement-and-gate.md#meas-cmd-failed) |
| `MEAS-REF-PREPARE` | 参考缓存准备失败 | 测量 | 环境 | [03](03-measurement-and-gate.md#meas-ref-prepare) |
| `MEAS-TIMEOUT` | 基准超时 | 测量 | 环境 | [03](03-measurement-and-gate.md#meas-timeout) |
| `MEAS-PMC-UNAVAILABLE` | PMC/hipprof 证据不可用（**跳过，不是失败**） | 测量 | 设计行为 | [03](03-measurement-and-gate.md#meas-pmc-unavailable) |
| `KQ-CORRECTNESS` | 内核算错（正确性/Graph 校验不过） | 内核质量 | 设计行为 | [04](04-kernel-quality.md#kq-correctness) |
| `KQ-INLINE-ASM` | 内联汇编验收门不通过 | 内核质量 | 设计行为 | [04](04-kernel-quality.md#kq-inline-asm) |
| `KQ-PERF-REGRESSION` | 性能回退（最终验收不过） | 内核质量 | 设计行为 | [04](04-kernel-quality.md#kq-perf-regression) |
| `PROC-AGENT-KILLED` | agent 被 kill（超时/OOM/外部） | 进程 | 环境 | [05](05-process-and-infra.md#proc-agent-killed) |
| `PROC-NO-WORKER` | 一张卡都没跑通 | 进程 | 设计行为 | [05](05-process-and-infra.md#proc-no-worker) |
| `PROC-BUG` | DKAO 自身崩溃（AttributeError 之类） | 进程 | 待办 | [05](05-process-and-infra.md#proc-bug) |

状态含义：**已修** = 代码层面消除了成因，再出现要按新根因查；**设计行为** = 管线拒绝给出不可信的数，
本来就会反复出现；**环境** = 机器被别人占用/工具缺失时的正常表现；**待办** = 已知未处理。

## 标本：2026-09-22 那次（现在已经修掉）

任务 `dcu-kernel-auto-opt-5ed5c157`（WebUI 发起，shape `tp4_wqkv_a_m2`，12:53:04 → 12:53:58 就死了）：

```
Task stopped in generate_kernel_repo:GPU probe failed after 3 attempt(s) (RuntimeError):
python3 /root/zth_agent/kernel-repos/dcu-kernel-auto-opt-5ed5c157/w8a8_bench.py --source ... --m 1 --n 1 --k 1 --probe
failed (3): shm_open: Permission denied
/usr/local/lib/python3.10/dist-packages/torch/cuda/__init__.py:817: UserWarning: Can't initialize amdsmi - Error code: 32
...
{"ts": 1790052837.94, "attempts": 3, "visible_devices_env": "0", "uid": 0, "gid": 0,
 "dev_shm": [rocm_smi_card1..4(mode 0o777), c3000_topology_info, sem.mp-...],
 "admission": {"checked": true, "usable": true, "device": 0, "vram_percent": 0.01, "util_percent": 0.0,
               "reason": "card is idle"}}
```

**判定过程（可复现）**：卡是空闲的（0.01% VRAM）；同一个 repo、同一条命令在**无沙箱** shell 里
`rc=0`、`device_name=K500SM_AI`；在**沙箱**里逐字复现 `shm_open: Permission denied`。
用 DSH 自带的 `landlock-run`（授权范围 = workspace-write）也能复现，且 `open("/dev/shm/x", O_CREAT)`
与 `open("/dev/shm/rocm_smi_card1", O_RDWR)` 都返回 `EACCES`，`O_RDONLY` 正常——
即 `/dev/shm` 对该进程树是只读的。根因：WebUI（`serve.py` 8765）是 09-21 15:31 从
**workspace-write 沙箱会话**里重启的，Landlock 域被它拉起的每个 orchestrator/probe 继承，
而子进程无法解除。详见 [`01-environment.md`](01-environment.md#env-shm-sandbox)。

> ⚠️ 该任务与 kernel repo 后来被清理（purge）了，所以 `samples.jsonl` 里已经没有它的记录——
> 这正是本目录存在的理由：**值得记住的原文请贴进对应 md**，磁盘上的证据会被删，文字不会。

## 快照信息

`samples.jsonl` / `SUMMARY.md` 是收集器在某一刻对磁盘证据的抓取，任务被 purge 后对应记录就没了。
最近一次抓取：见 `SUMMARY.md` 顶部的「生成时间」与「扫描任务数」。
