# HE 流程（固定协议）

> **这是 harness_evolve（AHE 外层循环）的规范文本，不是设计笔记。**
> 代码必须与本文一致；改协议 = 改本文 + 改代码 + 改契约测试
> （`tests/test_flow_contract.py` 会检查本文存在且关键约束仍在）。
> 实现位置见文末「代码对应」。

---

## 0. 边界：HE 只发起 DKAO 任务

**HE 的唯一职责：把这一轮的算子清单交给 DKAO，等它交回测量结果，据此判门、决定下一步。**

| 事项 | 归属 |
|---|---|
| 取题 / 组卷（这一轮测哪些算子） | **HE** |
| 把每个算子起成一个 DKAO 子任务、传 harness 快照、等它跑完、收测量结果 | **HE** |
| 判性能门 / 泛化门、决定 analyze→evolve 还是待批 | **HE** |
| 每轮题数 = 4 的倍数（一波铺满 4 张 HCU） | **HE**（只做这个尺寸决定） |
| 卡干不干净（VRAM ≤ 90% 且 HCU == 0）、等卡、闸门超时 | **DKAO**（`ensure_measurement_gate`） |
| 卡被抢导致的污染测量作废 / 回滚 | **DKAO**（contamination 处理） |
| 内核编译、基准、正确性、PMC、最终验收 | **DKAO** |
| 子任务崩溃/工具链缺失等"环境欠一次测量"的重试 | **HE**（重发一次 DKAO，见 §5） |

HE **不做**的事（照这条检查任何新代码）：

- 不租卡（不调用 GPU broker）、不读卡状态、不因为"卡忙"等待或否决；
- 不 `SIGSTOP`/冻结子进程（那是早前为"卡被抢"设计的机制，已废弃：卡的事是 DKAO 的事）；
- 不判 `measurement_suspect`、不写污染窗口；
- 不因为自身对环境的判断而终止一轮——能终止一轮的只有"子任务没交回可用测量"这件事本身。

HE 为每道题只做一个**布局决定**：设备 `= index % 4`（第 i 道题绑第 i%4 张卡），
它只保证"一波不超过 4 道题、一题一张卡"，不代表 HE 认为那张卡空闲。
把每道题**立刻**发给 DKAO；卡不空时，是 DKAO 的子进程在闸门那里等。

---

## 1. 取题与组卷

### 1.1 每轮题数固定为 4 的倍数

- 机器 4 张 HCU（`GPU_COUNT = 4`），**一波 = 4 题**；一轮题数只能是 4 的倍数。
- 表单字段 `per_round_budget`（Round budget）只提供 4 的倍数选项；CLI/接口传非 4 倍数时**向上取整**
  （3→4、5→8、7→8），合法值原样保留（4→4、12→12）；非法/空 → 默认 4（`OPERATORS_PER_GATE`）。
- 题数**只按配置抽**，不按空闲卡数缩水：卡忙是 DKAO 的事，缩题数会让一轮考不出结论。
  （历史上那个 `fit_questions_to_devices` 反向开关已移除。）

### 1.2 抽题规则

从注册池（`pool_source`，真实实测池）中抽，**随机**，且：

- 只抽**可判**算子：既有 variant 又有可用基线的才抽（否则算不出 win/loss，只会稀释比例）；
  可判算子不足一波（4 个）时**直接停任务**（`final_status=no_question_pool`，事件
  `variant_pool_too_small`）——缩到 3 题会改变门的含义（"≥75% 赢"在 3 题上等于"必须全胜"）；
- **保证同时含 decode 与 prefill**：至少 1 个 decode（`M ≤ 32`）和 1 个 prefill（`M > 32`）；
  其余名额随机填满——一轮只考一类 shape 会把更难、更有价值的那一半漏掉；
- 第 1 轮（baseline）：随机抽 4 题 = **A1**，这 4 题**同时固化为本轮的泛化考卷**（只写一次，之后永不替换）；
- 第 2 轮起（performance）：**重新随机抽 4 题 = A_i**，并**排除考卷**（`A_i ≠ A1`，也不同于上一轮的题）；
- **抽题可复现**：随机种子由 `(task_id, iteration, stage)` 派生（表单 `round_seed` 可显式钉住），
  并写进该轮的 `variant_round_selection` 事件（`seed` / `count` / `judgeable_in_pool`），
  这样"为什么抽到这 4 题"事后能查、那一轮也能重跑。

---

## 2. 轮次与阶段

一次"通过"叫一个 stage，记录在 `runs/iteration_NNN/input/stage.json`：

| stage | 轮次编号 | 做什么 | 判哪门 | 消耗轮次 |
|---|---|---|---|---|
| **baseline** | iteration 1 | 抽 A1（4 题）交 DKAO 实测；这 4 题固化为考卷 | 都不判 | 0 |
| **performance** | iteration 2 起 | 抽新题 A_i（排除考卷）交 DKAO 实测 | 只判性能门 | 1.0 |
| **generalization** | 紧随其后的那一趟（"第 2.5 轮"） | 同一版 harness **再发一次 DKAO**，题目固定为 A1 | 只判泛化门 | 0.5 |

> "紧随其后的那一趟"= 性能门通过后**立刻**用同一版 harness 再发一次评测（占下一趟 pass，
> 有自己的 `runs/iteration_NNN` 目录），不是在同一趟里重测；批准时记录的是**赢下性能门的那一轮编号**。

- **第 1 轮不判门**：它只负责"量出基线"。它测出来的更快 kernel **直接写进 variant 池**
  （阈值 `promote_min_improvement_percent`，默认 3%），不需要人工批准——"kernel 是事实，harness 才要批"。
  若第 1 轮有任一算子没拿到可用测量 → 整个 HE 任务立刻停（`baseline_round_failed`），不留半截证据。
- **一轮的完整生命周期**（第 2 轮起）：
  1. 抽新题 A_i（4 的倍数、含 decode+prefill、排除考卷）→ 一题一个 DKAO 子任务；
  2. 判**性能门**（§3）；不过 → 回退到上一好 harness → analyze → evolve 产出新 harness → 下一轮重新随机抽题；
  3. 过了性能门 → 用**同一版 harness**再发一次 DKAO，题目 = 固化考卷 A1 → 判**泛化门**（§4）；
  4. 两门都过 → 写 `pending_promotion.json`，任务停在 `awaiting_approval`，**等人工批准**才接入生产 DKAO；
     任何一门不过 → 同上走 analyze→evolve→下一轮。

---

## 3. 性能门（performance stage）

对手是**每个算子当前的 variant**（该算子目前的最优解：成绩 + 内核）。

- **赢** = 严格快于 variant（含 2% 噪声带；平局不算赢）；
- 通过条件：**≥75% 的题赢**（4 题即至少 3 题），**且没赢的那些不得低于 variant 的 80%**。

## 4. 泛化门（generalization stage）

**仅在性能门通过后开**。不抽新题：**重考第 1 轮那份固化考卷 A1**，同一版 harness 再发一次 DKAO。

- 通过条件：**≥50% 的题赢**，同样 **80% 地板**（任一题低于 variant 的 80% → 不过）；
- **平局不算输**：子任务以 `best_known` 热身起跑，考卷上的算子正是第 1 轮刚写进池的 kernel，
  重考大概率复现同一个 kernel；把"复现自己"判成失败等于要求搜索策略每轮都超越自己。
  泛化门要的是"无败场 + 真退步就否决"。

### 门的三种结论：PASS / FAIL / **INCOMPLETE**

门是对 **harness** 的断言，所以只有在这轮真的产出了证据时才允许下结论：

| 结论 | 何时 | 循环怎么走 |
|---|---|---|
| **PASS** | 全部题都测到，且满足比例 + 地板 | 性能门过 → 冻结重考；泛化门过 → 写 `pending_promotion`，停 `awaiting_approval` 等批准 |
| **FAIL** | 已测到的部分**已经决定输**：有题低于 80% 地板，或"已赢 + 未测"仍达不到所需胜场数 | 回退上一好 harness → analyze → evolve → 下一轮重新抽题 |
| **INCOMPLETE** | 有题没测到，而结果**仍然开放** | **本轮不下结论**：记 `round_incomplete`，不写候选、不改判 harness；下一趟重新测量（泛化门缺测时**保留**冻结的重考请求，考卷仍欠一个判决） |

这条分界很重要：过去任何缺测都直接判 FAIL，等于把"机器没给数"记成"harness 退步"，
既让循环去修一个没坏的 harness，也会在泛化重考时把候选白白花掉。

## 5. 测量没拿到怎么办（唯一允许的重发）

- 子任务**崩溃/工具链缺失/无 report** → HE 认为"环境欠一次测量"，**重发一次 DKAO**
  （重发是全新的一次 DKAO、独立子任务目录；上限 `env_retry_attempts`，默认 3 次尝试）。
- 子任务**被 DKAO 自己的闸门拒测**（exit 75 / `gate_blocked`）→ **不重发**：DKAO 已经在它那张卡上
  等满自己的预算（30 分钟一次 × 48 = 24 小时）才给的否决，HE 没有可换的卡，重发等于无视它的结论。
  该轮判 `round_incomplete`（cause `gpu_gate_blocked`）→ **终态**，等人工决定（不会被自动 resume）。
- 某一轮**有题缺测但结果仍开放**（见 §3 的 INCOMPLETE）→ 该轮不下结论，事件 `round_incomplete`
  （`gate` / `unmeasured` / `measured`），循环按 §3 的表继续。
- 每次尝试都写独立目录（`children/iteration_NNN`、`..._a2`、`..._generalization`），
  失败那次的日志原样留档；DKAO 会把子任务工作区的 `main` 绑定到本次 kernel repo，共用目录会让重试秒退。

---

## 6. 判据与产物

| 文件 | 内容 |
|---|---|
| `variant_table.json` | 逐算子 variant + 固化考卷（`groups.generalization_ids`） |
| `runs/iteration_NNN/input/stage.json` | 这次是哪个 stage + `round_cost` |
| `.../baseline_round.json` | 第 1 轮：判定 + 入池结果 |
| `.../performance_gate.json` / `.../generalization_gate.json` | 两门的逐题判定（wins/needed/floor） |
| `.../decision.json` | 本轮 system decision |
| `pending_generalization.json` | 冻结的重考请求 |
| `pending_promotion.json` / `promoted_harness.json` | 待批候选 / 已接入版本 |
| `children/<尝试目录>/<算子>/` | 每个算子一次 DKAO 运行（独立目录） |

批准后的动作：`approve` 把候选 harness 接入 DKAO（备份上一版）、用**写泛化门那次重考**的成绩更新 variant、
把该轮算子内核按"最好者胜"写进生产池；任务结束（`promoted:<版本>`）。**只有被接受那一轮的优化进入生产。**

---

## 7. 代码对应（改协议时一并改）

| 协议条目 | 实现 |
|---|---|
| 题数 = 4 的倍数、一波 4 题 | `orchestrator/rounds.py`: `GPU_COUNT` / `OPERATORS_PER_GATE` / `normalized_per_gate` |
| 取题（随机 / 可判 / decode+prefill / 排除考卷） | `orchestrator/rounds.py`: `sample_operators` / `regime_of` |
| 轮次与阶段、考卷固化 | `orchestrator/rounds.py`: `select_round_questions` / `record_paper` / `round_stage` |
| 两门判据（75% / 50% + 80% 地板 + 2% 噪声带） | `orchestrator/decision_engine.py`（`gate_verdict`）+ `rounds.py: evaluate_gate` |
| 每轮把算子清单发给 DKAO、设备 = index % 4 | `orchestrator/adapters/eval.py`: `DkaoCliEvaluator.evaluate` / `_run_wave` |
| 环境相关的重发与终态 | `adapters/eval.py`: `_env_failed` / `_stop_on_incomplete_round` |
| 表单题数只给 4 的倍数 | `form.yaml`: `per_round_budget` |
| 契约测试 | `tests/test_flow_contract.py` |

**环境相关的判据不在本文件**：卡干净与否、等多久、污染怎么作废，全部写在 DKAO 侧
（`dcu_kernel_auto_opt/orchestrator/gpu_preflight.py`、`w8a8_pipeline.py` 的测量闸门、
`contention.py`；DKAO 侧的报错归档见 `dcu_kernel_auto_opt/error_catalog/`）。

---

## 8. 旧路径（suite / legacy）：保留，但必须自报家门

新任务**一律**用本文件的固定协议（配一个实测池文件）。旧的 suite/legacy 路径仍然保留
（离线套件、2026-09-15 之前的老实验），但它**不固化考卷、不判两门、不按 4 的倍数取题**——
它的轮次不可能产出可接入 DKAO 的 harness。所以从 2026-09-22 起，它必须自己说出来：

| 说给谁看 | 形式 |
|---|---|
| 盯着进程的人 | orchestrator 日志一条 `WARNING: running the LEGACY protocol (…). New tasks must use a measured pool file — see FLOW.md` |
| 任务的审计记录 | timeline 事件 `legacy_protocol_selected`（含 `reason` / `pool_source` / `pool_file` / `policy`） |
| 页面上的人 | 实验目录写 `protocol.json`，任务详情页据此在顶部显示黄色横幅「⚠ 本任务未按固定协议运行」 |

**触发条件**（任一即判定为旧路径）：`round_questions: legacy|suite|off`；没配池文件（只用内联 suite）；
池文件路径不存在；用了 `builtin` 假池。

> 结论性的取舍（要不要彻底删掉这条路径）见 `README.md` 的「现状与边界」；在删除之前，
> 这条告警是防止它被误用的唯一保障。

---

## 9. 停止与续跑（operator 操作说明）

**停止 = 暂停，不是杀进程。** 这两件事在本系统里必须分得很清：一个进程"只是没了"和"崩了"在判据上
完全一样，而 supervisor / janitor / `should_launch_resume` 的存在就是为了把崩掉的跑起来——所以
"只杀进程的停止"会在几秒到 5 分钟内被自动复活。

### 9.1 点按钮（推荐）

任务详情页（HE 页面）状态机下方那一行：**「停止任务」**（琥珀色边框，仅在 `running` 时出现）。

一次点击按固定顺序做完六步（代码：`server/routes.py: stop`）：

| # | 动作 | 为什么必须在这个位置 |
|---|---|---|
| 1 | 写 `workspace/operator_stop.json` | **标记先落地**：janitor 一旦先看到"没人在跑"，就会自动拉起它 |
| 2 | 停 supervisor（写 `supervisor.stop` + SIGTERM） | 它存在的意义就是"把死掉的实验拉起来"，必须先停它 |
| 3 | 杀掉本轮所有 DKAO 子任务（按 cmdline 匹配 workspace 路径） | 子任务各自 `start_new_session`，父进程死了它们还活着 |
| 4 | 杀掉 HE 编排器（`_run_alive`：`orchestrator.pid` → `resume.pid` → cmdline 扫描） | 最后杀，避免它在子任务写到一半时被打断 |
| 5 | **再扫一次子任务** | 编排器把"子任务消失"当环境失败，会在第 3~4 步之间发一波新的（`env_retry_attempts`）；漏掉它，页面写着"已停止"而新子任务还在卡上跑几小时 |
| 6 | `run.json` 写 `finished: true` / `final_status: stopped_by_operator` | 让所有自动路径收手；`finished` 同时是 `/resume` 的前置条件 |

**关键点**：运行中的编排器**自己不读** `operator_stop.json`——只有 janitor（`_operator_stopped`）和
supervisor 读它，CLI 只在"刻意重启"时删它。所以标记只防"自动复活"，**不会**让活着的进程停下来，
第 4 步不能省。

### 9.2 停止后一定不会被自动拉起

janitor 每 300 s 扫一遍，命中标记就跳过；`stopped_by_operator` 也在 `TERMINAL_STATUSES` 里，
`should_launch_resume` 直接返回 False。想确认，看 WebUI 日志（`/root/zth_agent/webui-8765.log`）：

```
[he-janitor] {'task': '<task_id>', 'action': 'skip', 'reason': 'stopped by operator'}
```

### 9.3 续跑

页面上「续跑到该轮次上限」，或 `POST /api/harness-evolve/<task_id>/resume {"target": N}`。
`_launch_resume` 会**先删掉 operator-stop 标记**再起进程，所以续跑不会被自己的标记挡住。

被停掉的那一轮**重跑**：抽题种子由 `(task_id, iteration, stage)` 派生 → 抽到的还是**同样那批题**；
那一轮没有判完，所以它的成绩**不会**写回 variant（写回只发生在"轮次判完"或"harness 被人工批准"时）。
已经跑完的子任务证据留在磁盘上，但同样不计入。

### 9.4 不要做什么

| 做法 | 后果 |
|---|---|
| `kill -9 <编排器 pid>`（任何"只杀进程"） | 看起来像崩溃 → janitor 在 ≤5 分钟内 `supervisor+resume` 自动拉起；子任务在各自 session 里**不会**被杀，变成孤儿继续占卡 |
| shell 任务页的 **Kill** 按钮 | 它会按路径杀整棵树（比裸 kill 干净），但写的是 `final_status: killed`，**不在终态集合里**；没有 operator-stop 标记时，janitor 仍会按"未达目标轮数"把它拉起来 |
| shell 任务页的 **Reset** | 那是真删除：日志 / 迭代产物 / 运行记录全清，只留 `requirements.json`，不可恢复 |
| 手删 `operator_stop.json` | 等于解除暂停保护：下一次 janitor tick 就会把它当崩溃恢复 |

### 9.5 代码对应

| 事项 | 位置 |
|---|---|
| 停止的六步顺序 | `server/routes.py: stop` |
| 宽口径活性判断（orchestrator.pid → resume.pid → cmdline） | `server/routes.py: _run_alive`（窄口径 `_resume_running` 只认 `resume.pid`，New Task 起的任务没有它） |
| 子任务定位（各自独立 session，靠 cmdline 认领） | `server/routes.py: _live_dkao_children` |
| 信号发送（先 `killpg` 再 `kill`，僵尸算已停） | `server/routes.py: _terminate_pid` |
| 终态集合 / 自动复活判据 | `server/routes.py: TERMINAL_STATUSES` / `should_launch_resume` |
| 续跑并清除标记 | `server/routes.py: _launch_resume`、`orchestrator/cli.py: _clear_operator_stop` |
| 契约测试 | `tests/test_operator_stop.py` |
