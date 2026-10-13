# 02 · 生成阶段与 agent 类报错

发生在 `generate_kernel_repo` / worker bootstrap：**内核还没开始优化**，报错来自 agent 进程、
脚手架校验、或工作区归属检查。

---

## GEN-CONFLICT

**`workspace main already points to <X>, not requested <Y>`** ｜ 状态：**已修** ｜ 真出现 **64** 次（09-11 ~ 09-15）

### 原文

```
workspace main already points to /root/zth_agent/ahe-kernel-repos/ahe-hy3-tp8-m16-ahe-v2-ea5b8069-it002-candidate-hy3-tp8-shared-down-proj-m16-c9edab,
not requested kernel repo /root/zth_agent/ahe-kernel-repos/ahe-...-it002-candidate-hy3-tp8-shared-down-proj-m16-<other>
```

### 根因

harness-evolve 的"环境失败重试"会给同一道题**换一个新的 kernel repo 名**，却**复用同一个子任务目录**
`children/iteration_NNN/<题号>/workspace`。DKAO 会把该工作区的 `main` 符号链接**绑死**到本次要用的 repo
（`_prepare_worktrees` 的所有权校验），于是第二次尝试一进去就失败——本来 3 秒就能自愈的环境抖动，
被放大成"必然失败 3 次"，64 条记录里绝大多数是这一条。

### 处置 / 修法

让**每个评估尝试拥有独立目录**（结构上杜绝复用）：`children/iteration_001`、环境失败后的
`iteration_001_a2`、`_a3`、泛化重考的 `iteration_00N_generalization`；
`rounds.py` 新增 `stage_dir_name` / `attempt_dirs` / `resolve_child_dir`（最新尝试获胜）。
任何两个 DKAO run 不再共用目录，失败那次的日志原样留在旁边当证据。
**再看到这条**：说明有新的调用方在复用目录，按"尝试目录必须唯一"去查。

---

## GEN-SCHEMA

**表单/契约参数非法** ｜ 状态：设计行为

| 原文 | 说明 |
|---|---|
| `tp_size must be 4 or 8, got 1` | 前端形状编辑器曾为每个模型提供 `tp_size: 1` 的拓扑，而算子契约只认 4/8；选到 TP1 必死（`int8_w8a8_gemm_api.py`）。前端已修 |
| `gpu_mode must be occupy or scheduled` | 表单/接口传了未知模式 |
| `execution_profile must be 'default' or 'production'` | 同上 |

这条报错是**契约在拦人**，不是环境问题：按提示改成合法值即可。

---

## GEN-CONTRACT

**脚手架/参考不可信** ｜ 状态：设计行为

| 原文 | 根因 |
|---|---|
| `staged API contract digest is not trusted` | 落地的 `int8_w8a8_gemm_api.py` 与受信摘要不一致（被改动或拷贝不完整） |
| `trusted PyTorch reference self-test failed` | `w8a8_bench.py --self-test` 没过：参考实现本身不可信，拒绝在其上做测量 |
| `Generate scaffold unexpectedly contains a HIP implementation` | "新建 repo"模式要求脚手架里没有任何现成 HIP 实现（避免继承旧代码） |

处置：不要绕过。前者查契约文件来源/摘要；后者删掉仓库里多出来的实现文件或改用"接入已有 repo"模式。

---

## GEN-OWNERSHIP

**`bootstrap Agent changed files outside its HIP ownership: [...]`** ｜ 状态：设计行为 ｜ 真出现 4 次（07-28）

agent 只被允许改 `_GENERATED_KERNEL_FILE`，改动清单里出现别的路径就会被拒绝：

```
bootstrap Agent changed files outside its HIP ownership:
['__pycache__/w8a8_backend.cpython-310.pyc', 'csrc/bindings_hip.cpp']
```

`__pycache__/*.pyc` 是**最常见的误报来源**（agent 只是 import 了一下）。处置：清理缓存产物 /
确认 `PYTHONDONTWRITEBYTECODE`，真改了别人的文件则必须回退。

---

## GEN-BINARY-MISSING

**agent 可执行文件/模块不存在** ｜ 状态：环境 ｜ 真出现 2 次（08-03）

```
[Errno 2] No such file or directory: 'ccb'
→ worker_3 could not generate a valid initial HIP kernel after 3 attempts
```

根因：宿主没有 agent 二进制（`METAINFER_CLAUDE_BIN` / PATH 缺失），三个 bootstrap 尝试全在同一处失败。
处置：确认 `METAINFER_CLAUDE_BIN`（本机 `/usr/local/bin/ccb`）存在且可执行；
本类报错**必须**先修环境再重跑，否则只是重复失败。

---

## GEN-AGENT-EJECT

**`Generate agent attempt N failed: nonzero exit 1`** ｜ 状态：环境 ｜ 真出现 **543** 次（最多的一类）

### 判定

agent 进程非零退出（不是 DKAO 的判断）。同一任务里往往连出 attempt 1/2/3，然后外层包装成
`GEN-COORD-FAILED`。**先看 agent 自己的日志**：`<workspace>/main/.metainfer-generate-logs/*.attemptN.log`
（或 worker 的 `workers/<id>/logs/*.log`），错误原因在那里。

### 常见根因

agent 侧超时/OOM 被杀、模型/凭据不可用、prompt 里引用的文件不存在、agent CLI 版本不匹配。
处置：按 agent 日志修环境或输入，再重跑；不要盲目加大重试次数。

---

## GEN-NO-KERNEL

**agent 没能产出可用内核** ｜ 状态：设计行为 ｜ 真出现 18 次

| 原文 | 说明 |
|---|---|
| `bootstrap Agent did not generate <kernel file>` | agent 没写目标文件 |
| `agent did not write proposal.json` | 缺少提案文件（迭代轮） |
| `worker_N could not generate a valid initial HIP kernel after 3 attempts` | 3 次尝试后仍无可用内核 → 该 lane 判失败（`PROC-NO-WORKER` 的前置） |

处置：看 agent 日志与最后一次 `bootstrap_progress.json`；这是"生成质量"问题，通常伴随 `GEN-AGENT-EJECT`。

---

## GEN-COORD-FAILED

**`Kernel coordination failed after 3 attempts. Last failure: …`** ｜ 状态：环境

`generate_kernel_repo` 阶段的主 agent 重试耗尽（`_MAX_GENERATE_RETRIES`）。这是**外层包装**：
真正的理由在 `Last failure:` 后面（通常是 `GEN-AGENT-EJECT` 或契约/归属类）。
任务会以 `stopped / infra_fail` 结束在生成阶段——**不要**据此说"GPU 坏了"。
