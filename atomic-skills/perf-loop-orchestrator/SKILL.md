---
name: perf-loop-orchestrator
description: 永续性能优化大循环编排器。用户设定目标后，主 Agent 无限循环派发三个 subagent（可运行性与正确性门 → 端到端 Profiling 瓶颈分析 → 优化最显著瓶颈），循环永不自行终止——达标、收益枯竭、预算警戒只触发换向与里程碑报告，唯一停止方式是用户主动叫停。确定性脚本层（loopctl）托管 subagent 生命周期防卡死，状态落盘防上下文压缩漂移，全量轨迹归档供后续分析。永不向用户提问、永不暂停等待。
---

# 性能优化大循环（外层编排技能）

**何时触发**：用户给出一个性能目标并启动循环后。此后循环**永续自主运转**，唯一停止方式是用户主动叫停。

## 自主性铁律（高于一切其他规则）

1. **永不向用户提问，永不暂停等待用户**。不存在"暂停循环找用户"这种动作——任何情况下都不允许。
2. **永不自行终止循环**。Agent 无权决定停下来。达标、收益枯竭、预算警戒、硬阻塞都不是停止条件——它们只触发**换向**与**里程碑报告**，循环继续。唯一的停止方式是用户主动叫停（外部事件，Agent 只能被动接受）。
3. 用户只出现在两个时刻：**发起循环（给定目标）**、**主动叫停**。其余时间用户只会异步阅读产物。
4. 被卡住时的唯一合法动作是**自主换路**，按固定阶梯降级（见"卡点自主降级阶梯"）。
5. 所有"想问用户"的冲动，一律转化为：把问题连同已试矩阵写进 `loop/QUESTIONS.md`（待决清单），**然后继续循环**。用户什么时候看、要不要回应，完全由用户决定，循环不依赖回应。
6. 目标有歧义时：自行选择最合理的解释，把假设与理由写进 `loop/GOAL.md` 的"解释假设"段，照常开跑——不问。
7. 本铁律同样下发给每个 subagent：委派模板中明确"禁止向任何人类提问，不确定时自行决策并记录假设"。

## 三层架构

```
┌─ 确定性脚本层  harness/loopctl.py —— 状态唯一事实源、subagent 托管（心跳/超时/杀灭）、轨迹归档
├─ 主 Agent 层   只编排不写码：读状态→按决策表行动→派发→验收→提交→记录；无状态可重入
└─ subagent 层   三个步骤各自一个 subagent，行为由原子技能库约束，轨迹全量落盘
```

```
用户目标 ──► 第0步 目标冻结（一次） ──► ┌─────────── 循环（永不自行终止）───────────┐
                                        │ ① 门：不能跑→修兼容卡点；能跑→正确性测试     │
                                        │ ② Profiling：抓 trace + 瓶颈排序            │
                                        │ ③ 优化最显著瓶颈（单变量+对比+回归）         │
                                        │ 收尾：报告 iter_NNN.md + 提交 + 轨迹归档     │
                                        │ 触发阈值（达标/枯竭/预算警戒）→ 换向+里程碑   │
                                        └── 唯一出口：用户主动叫停 ──────────────────┘
```

## 第 0 步：目标冻结（发起时一次）

用户给定目标后写入 `loop/GOAL.md`，七要素：

1. 目标指标与达标线（量化）；
2. 正确性红线（不得以正确性换性能）；
3. 测量条件（规模/轮数/资源/真实部署形状/噪声带宽度）；
4. **换向与里程碑阈值**（达标线；连续 N 轮低于噪声带；预算警戒线——注意：这些触发的是**换向与里程碑报告**，不是停止，循环永不因它们终止）；
5. **步级预算**（写入 state.json 的 budget：`step_timeout_s`、`stale_s`、`step_retries`、`max_errors_per_round`）；
6. 边界（只读区、写白名单、禁区资源）；
7. 歧义解释假设（若有）。

挂接技能：`pre-register-acceptance`、`declare-scope-first`、`comparable-numbers`、`read-standing-rules-first`。

## 确定性控制器（harness/loopctl.py，主 Agent 的手和眼）

| 命令 | 作用 |
|---|---|
| `init --goal GOAL.md` | 初始化 `loop/` 骨架与 `state.json`（幂等） |
| `launch --iter N --step X --cmd "..." [--timeout S] [--attempt A]` | 后台托管启动 subagent：看门狗+心跳+输出新鲜度+硬超时 |
| `status` | 当前轮步 verdict + 建议动作（确定性决策表） |
| `kill --iter N --step X` | 终止该步进程组（含孤儿子进程），置 KILLED，轨迹保留 |
| `mark --iter N --step X --verdict pass\|fail\|skip` | 登记结果并推进轮步指针（拒绝跳步/回头） |
| `collect --iter N --step X` | 幂等追加该步轨迹到 `traces/history.jsonl` |
| `bump-goal --note` | 仅用户改目标时由用户侧使用；Agent 只读 |

`loop/` 布局：`GOAL.md`｜`state.json`（唯一事实源）｜`negatives.md`（否定假设册）｜`QUESTIONS.md`（待决清单）｜`reports/iter_NNN.md`｜`logs/`｜`steps/`（步状态）｜`traces/`（逐步轨迹 + `history.jsonl`）。

**verdict 判定（全确定性）**：`NOT_STARTED / RUNNING / STUCK(进程活但无输出进展超 stale_s) / DONE(rc=0) / FAILED / TIMEOUT / KILLED / CRASHED(看门狗死了)`。
**决策表（主 Agent 照抄执行，不自创）**：

| verdict | suggested_action | 主 Agent 动作 |
|---|---|---|
| NOT_STARTED | GENERATE_DISPATCH_THEN_LAUNCH | 从文件模板生成派发 → `launch` |
| RUNNING | WAIT_BOUNDED_THEN_RECHECK | 有界等待（`bounded-waiting`）后复查，不空转 |
| STUCK | KILL_THEN_RETRY_OR_ADVANCE | `kill` → 归档轨迹 → 按预算重试或登记 fail 前进 |
| CRASHED | KILL_ORPHAN_THEN_RETRY_OR_ADVANCE | `kill`（清孤儿）→ 同上 |
| TIMEOUT/KILLED/FAILED | RETRY_DEGRADED_ONCE / MARK_FAIL_AND_ADVANCE | attempt ≤ retries 则降级任务重试一次，否则登记失败前进 |
| DONE | VALIDATE_ARTIFACTS_THEN_MARK_PASS | 回执齐全才 `mark pass`，缺件按 FAILED 处理 |

**每轮步必有终态**：任何 subagent 异常（卡死/崩溃/超时/被杀）都在有限时间到达决策点，永不久等。

## 主 Agent 无状态协议（防上下文压缩漂移）

- **每个动作前先 `loopctl status`**；决策输入只有三个来源：`GOAL.md` 原文、`state.json`/`status` 输出、`negatives.md` + `QUESTIONS.md` 摘要。**不依赖对话记忆**。
- 每轮固定开场三读：GOAL.md 原文（重锚目标）→ `status` → negatives 摘要；然后才允许任何决策。上下文被压缩后，此开场保证行为不变（所有决策函数以磁盘为输入，天然幂等）。
- 派发提示词**从 `loop/templates/step{1,2,3}.md` 模板再生成**（第 0 步生成），不凭记忆转述目标。
- 主 Agent 会话死亡 / API 失败 / 网络中断：新会话（或重试后的会话）第一条命令就是 `status`，按决策表接续；模型调用失败按退避重试，循环控制权在脚本层，不因一次调用失败而丢失。
- `GOAL.md` 内容哈希固定在 `state.json`；每轮开场校验，发现漂移立即以 `GOAL.md` 原文为准重锚。

## 第 1 步 subagent：可运行性与正确性门

分支逻辑（subagent 自行判定）：
- 系统**不能正常推理** → 静态分析代码与当前硬件平台的兼容卡点（不支持的算子/指令/数据类型、版本或 ABI 不匹配、缺失的后端实现、依赖缺口），修复之；修后回到本分支复判。
- 系统**可正常推理** → 端到端正确性测试（覆盖真实配置关键开关组合，不只最小冒烟配置）。

产出：`runnable: yes/no + 证据`｜`correctness: pass/fail + 差异度量`｜修复提交（若有）。

挂接技能：侦察 `recon-before-action`、`probe-env-before-assume`、`smoke-test-new-paths`；修卡点 `triage-symptom-first`、`diagnose-before-fix`、`minimal-reproducer`、`branch-symbol-completeness`、`shape-stride-contract`、`mask-and-padding`、`retry-budget`；验证 `layered-verification`、`tolerance-by-contract`、`config-coverage-before-done`、`verify-what-you-test`、`regression-sweep-after-fix`、`independent-verification`。

门规则（主 Agent）：correctness 未 pass 不进第 2 步（`correctness-before-speed`）。

### 卡点自主降级阶梯（门修不动时，绝不暂停）

1. **绕过**：换等价通用实现/兼容层/回退路径，先让系统跑通（正确性优先于性能，慢路径可接受并在报告标注）；
2. **外部检索**：WebSearch 公开文档、issue 跟踪、变更记录、同类项目的已知解法，按证据落地；
3. **换角度**：最小复现隔离卡点，换归因假设重试（受 `retry-budget` 约束）；
4. **跳过**：把卡点连同已试矩阵写入 `QUESTIONS.md` 与 `negatives.md`，缩小本轮功能面（如禁用涉及该特性的配置组合）继续循环；
5. 阶梯走完仍无路 → 记录后转"方向生成器"换向，继续循环。**任何一步都不含"找用户"，也不含"停下"。**

## 第 2 步 subagent：端到端 Profiling 与瓶颈分析

产出：trace/指标抓取（真实条件、多轮中位、预热后计入）｜瓶颈清单（每项：证据、按实测可达上限算的收益上限、按"预期收益×成功概率÷实现成本"排序）｜与上轮对照（消亡/新增/回归）。

挂接技能：首轮 `baseline-before-change`；非首轮 `check-before-rerun`（代码与输入未变不重抓，复用带指纹旧产物）；数据质量 `instrument-self-check`、`median-over-singleton`、`measure-realistic-conditions`、`comparable-numbers`；分析 `probes-not-rereads`、`bound-the-gain-first`；工程 `parameterized-entry-command`、`bounded-waiting`、`background-long-waits`、`log-status-summary`。

门规则：无瓶颈清单或测量自检不过 → 打回重做；全部瓶颈收益上限低于噪声带 → 不进第 3 步，转"方向生成器"换向。

## 第 3 步 subagent：优化最显著瓶颈

产出：优化改动 + 同条件对比数据 + 回归验证 + 失败时回滚保全现场。

挂接技能：动手前 `falsifiable-hypothesis`（四要素写入任务书）；过程 `single-variable-change`、`sweep-collect-then-compare`、`cover-directions-and-boundaries`、`minimal-reproducer`、`write-once-run-many`、`retry-budget`；收口 `verify-what-you-test`、`regression-sweep-after-fix`、`rollback-on-no-result`、`checkpoint-incrementally`；验证独立 `independent-verification`。
约束：委派上下文必须附该方向已否定假设（来自 `negatives.md`）；复提已否定方案即打回。

## 收尾（主 Agent，每轮顺序固定）

1. `status` 确认 DONE → 验收回执（`evidence-in-reports`：产物绝对路径+关键数字+原样摘录，缺件按 FAILED 处理）；
2. 写 `loop/reports/iter_NNN.md`：改动/数值（附条件快照）/结论/否定项/下轮建议；
3. 代码提交：commit message 附验证证据与实测数值，与报告互链；
4. `mark` 登记并推进指针；`collect` 归档本步轨迹；更新 `negatives.md`、`QUESTIONS.md`；
5. 判定：触发任一阈值（达标/枯竭/预算警戒）→ 出里程碑报告并按"方向生成器"换向，继续循环；未触发 → 直接下一轮。观察到用户叫停 → 出总报告后结束（唯一出口）。

## 永续运转：循环永不自行停止，阈值只触发换向

**Agent 无权终止循环。** GOAL.md 中的所有阈值语义如下，无一是停止条件：

| 触发 | 动作（均不含停止） |
|---|---|
| **达标**（指标过线且正确性 pass，对照原始门槛） | 出里程碑报告 → 继续往更高处推：更优数值、更多场景正向（全形状/全配置/边界负载）、更长稳态复测 |
| **收益枯竭**（连续 N 轮低于噪声带，`stop-at-diminishing-returns` 只适用于当前方向） | 出里程碑报告 → 走方向生成器换向 |
| **预算警戒**（轮数/时间/资源越过警戒线） | 记入 `QUESTIONS.md` 与状态 → 切换不消耗已超支资源的方向继续（分析/静态工作/验证补强/文档），不停止 |
| **硬阻塞**（降级阶梯走完仍无路） | 记录 → 方向生成器换向 |
| **用户主动叫停**（唯一出口） | 出总报告后结束 |

### 方向生成器（换向时按序探测，永不返回"无事可做"）

1. 瓶颈清单剩余项 / 上一轮被更高优先级挤掉的方向；
2. **否定假设复审**：`negatives.md` 中哪些条目的前提可能已变（代码库演进、环境更新、上游修复），可重开；
3. **外部检索**：WebSearch 新技术、新算法、同类系统做法、上游变更记录，寻找未试过的优化族；
4. **场景扩展**：未覆盖的形状/配置组合、边界与尾延迟、并发与争用条件下的表现；
5. **质量与守护**：回归测试补强、验证覆盖缺口、代码清理、文档与报告沉淀；
6. **漂移重检**：重跑锚点与基线（环境可能已变化），确认既有结论仍然成立；
7. `QUESTIONS.md` 中的待决项，尝试用新一轮证据自答。
全部探测后仍无新方向 → 回到 3 强制检索新优化族；**"没有方向"本身是未检索充分的信号，不是停止理由。**

总报告（仅用户叫停时产出）：已试方向矩阵 + 各轮指标曲线 + 当前状态 + `QUESTIONS.md` 全部待决项。**不存在"等待用户答复后停"，也不存在"Agent 决定收工"。**

## 防走回头路（无限循环不退化）

- 否定假设册（`record-negatives`）：第 3 步委派必附已否定假设；
- 状态外置（`persist-progress-state`）：崩溃/重启从 `state.json` 断点续跑；
- 产物指纹（`check-before-rerun`）：trace/基线未变不重生成；
- 单变量+检查点（`single-variable-change`、`checkpoint-incrementally`）：每轮可回退可归因；
- 证据反向即停生产（`pause-when-contradicted`）：先分析再继续，不在坏方向堆实验。

## 执行轨迹全量归档（subagent 与模型服务的原始交互）

- 每个 subagent 启动时即指定追加式 transcript：`loop/traces/iter_NNN_stepX.jsonl`（API 请求/响应原始数据，只追加不截断；平台不支持直写时由 `collect` 从平台原生转录文件收编）；
- **任何结局都归档**：DONE / FAILED / TIMEOUT / KILLED / CRASHED 后必跑 `collect`，把该步轨迹幂等并入 `traces/history.jsonl`（记录 iter/step/终态/sha256/大小，fsync 落盘）；
- **被杀的部分轨迹最有分析价值**——卡死前的最后行为必须保留，禁止清理；
- `history.jsonl` 只追加、不覆盖、不删除；它是后续"迭代技能"的语料：修订技能库前先统计轨迹中的违规与浪费模式（对应本仓库 ETL 管道）。

## 委派模板（三步通用骨架；launch 时经 loopctl 托管）

```
[状态] 循环第 N 轮/第 X 步；目标与红线见 loop/GOAL.md（先完整阅读）；
       上轮结论见 loop/state.json 与 loop/reports/；本方向否定过的假设见 loop/negatives.md。
[动作] <本步骤任务，含分支判定逻辑>
[自主性] 禁止向任何人类提问；不确定时自行决策，把假设写进回执"假设"段。
[上下文] 基线数值与测量条件；相关代码/产物路径；只读区与写白名单。
[预期观察] <可机械判定的成功/失败现象>
[超时与捕获] 单步超时上限；必须捕获的输出与日志尾部；等待用探针+期限。
[失败处置] 修复预算轮数；耗尽即按模板回执（现象/已排除项/剩余假设/建议）并退出，
           禁止原样重试；改动失败按 rollback-on-no-result 处置并保全现场；
           卡点可走自主降级阶梯（绕过/WebSearch/换角度），不走阶梯外动作。
[轨迹] 本步与模型服务的全部 API 交互追加写入 loop/traces/iter_NNN_stepX.jsonl，不得截断。
[技能加载] 读取并遵守原子技能库：<本步骤技能清单>。
[回执格式] verdict + 关键数字 + 产物绝对路径 + 原样证据摘录 + 假设段（evidence-in-reports）。
```
