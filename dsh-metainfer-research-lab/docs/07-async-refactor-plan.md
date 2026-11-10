# 07 · 异步专家架构重构：实施计划

> **读者**：执行本次重构的编码 agent，以及审阅它的工程师。
> **基线**：MetaInfer 仓库 `867d277`，子目录 `dsh-metainfer-research-lab/`（插件版本 0.11.0）。
> **配套补丁**：`metainfer-lab-async-foundation.patch`（在仓库根目录 `git apply`），包含本计划第 0–3.5 阶段的地基代码和测试，见 §2。
> **日期**：2026-11-09。

本文是一份可以直接执行的计划。每个工作包（WP）都写明了目标、改哪些文件、具体步骤、必须保持的不变式、测试和验收标准。按顺序做，遇到 §5 中标"需确认"的事项或 spike 结论推翻默认方案时停下来问人，其余情况按本文默认执行。

---

## 目录

- [0. 执行规则](#0-执行规则)
- [1. 背景：为什么要重构，重构成什么](#1-背景为什么要重构重构成什么)
- [2. 配套补丁里已经有什么](#2-配套补丁里已经有什么)
- [3. 基线代码事实与已知缺陷](#3-基线代码事实与已知缺陷)
- [4. 全局约束（不可违背）](#4-全局约束不可违背)
- [5. 决定清单](#5-决定清单)
- [6. 目标架构与代码布局](#6-目标架构与代码布局)
- [7. 核心契约](#7-核心契约)
- [8. 存储与迁移](#8-存储与迁移)
- [9. 开关（feature flags）](#9-开关feature-flags)
- [10. 阶段与工作包](#10-阶段与工作包)
- [11. 测试、模拟器与不变式](#11-测试模拟器与不变式)
- [12. 切换与回滚](#12-切换与回滚)
- [13. 可观测性：事件目录与指标](#13-可观测性事件目录与指标)
- [14. 风险与 spike 结论的分支处理](#14-风险与-spike-结论的分支处理)
- [15. 完工定义](#15-完工定义)
- [附录 A. 设计记录条目到工作包的映射](#附录-a-设计记录条目到工作包的映射)
- [附录 B. 文件改动索引](#附录-b-文件改动索引)

---

## 0. 执行规则

1. **分支**：从 `refactor/async-foundation`（补丁所在分支）开始；每个阶段一个分支 `refactor/p<阶段号>-<主题>`，阶段验收通过后合并。
2. **提交**：一个 WP 至少一个提交；提交信息以 WP 编号开头，例如 `P1.7c: migrate gc.js writes to executor`。不要把两个 WP 混在一个提交里。
3. **每次提交前必须通过**：`npm test`（插件目录下运行）。新增的测试脚本加进 `package.json` 的 `test` 脚本。
4. **进度记录**：维护 `docs/refactor/PROGRESS.md`，一张表：WP 编号、状态（todo / doing / done / blocked）、提交号、偏差说明。凡是没有按本文做的地方，都要在"偏差说明"里写清原因。
5. **遵守仓库规则** `AGENTS.md`：不写一次性补丁，不写硬编码 id，不留临时脚本或调试路由；新功能要有数据层、通用 API、UI、成功路径和失败路径的测试、生命周期文档。
6. **插件约束**（见 `index.js` 头注释）：不能 import `@deepseek-ai/*`，只能用 Node 内置模块、MCP SDK、`zod`；保持 Windows 兼容（路径用 `node:path`，不假设 `/`）。
7. **界面文案**：任何新的 UI 文案同时更新 `locale/en.json` 和 `locale/zh.json`。
8. **什么时候停下来问人**：
   - §5 中状态为"需确认"的决定，在对应 WP 开工前确认；
   - spike（P0.4–P0.8）的结论与 §14 中假设不符；
   - 某阶段验收失败且两次尝试后仍定位不到原因；
   - 需要删除或改写已存在的用户数据。
   其余情况不要停，按本文默认执行，并在 PROGRESS.md 记录。
9. **不做的事**：不要提前实现后续阶段的功能；不要为了让测试通过而放宽不变式；不要把 LLM 放进任何确定性组件（Executor、Projection、Dispatcher 安全包络、coordinator 规划器、Trigger Engine）。

---

## 1. 背景：为什么要重构，重构成什么

### 1.1 现在的架构

自动挡（`host/auto.js`）每 2 秒轮询一次，满足条件时跑一个 cycle（`host/orchestrator.js` `runCycle`）：

```
advisor 评审团（多个 lens，Promise.all）──► scheduler LLM ──► 逐个 runtime.start
```

- advisor 输出提案，Host 校验后建子节点；scheduler 从 planned 节点里挑要启动的；启动是串行的。
- GPU 来自本地资源池（`config.resourcePools` + `maxRunningNodes`），或者来自集群 coordinator（`host/cluster.js`，租约制）。排队的节点由 `runtime.pumpLeases` 每 2 秒轮询一次。
- 状态写入分散在 `runtime`、`orchestrator`、`auto`、`gc`、`lab-service`、`reconcile` 六个文件里，一部分在 `withProjectLock` 内，一部分在锁外。

### 1.2 设计讨论收敛出的目标

"多个专家 + 确定性派发 + 共享 DAG"：

- **专家**（原 advisor 的泛化）是无状态激活的 LLM actor。它们读共享 DAG，只能**提交意图**，不能直接改状态。
- **确定性内核**是唯一写者：校验意图、解决冲突、提交变更、发布事件。
- **Dispatcher** 是可插拔接口。默认实现是确定性策略；将来可以是 LLM agent，甚至是跨机器和其他 agent 争论 GPU 的 agent。但 GPU 只能由 coordinator 签发，所有策略的决定都要经过内核的安全包络。
- **coordinator** 演进为中心资源管理器：处理多机任务（全部机器同时空闲才能启动），用预留加回填防止大任务被饿死；签发前允许 agent 争论优先级。
- **全量可追溯**：系统里的每个事件都保留；每次专家激活的输入和输出都记录在 DeepSeek harness（DSH）的会话系统里，不另建存储。

### 1.3 规模目标

按目标形态设计，不按当前项目（约 80 节点）的现状做取舍：

| 维度 | 目标 |
|---|---|
| 单项目节点数 | 5,000（热节点）+ 归档不限 |
| 并发专家 | 30–50 |
| 项目数 | 多项目共享一个集群 |
| GPU | 多机、多租户；单任务最多跨 8 台机器 |
| 单次 commit 延迟 | p99 < 20 ms（5,000 节点） |
| 容量释放到下一个节点启动 | < 1 s（事件驱动，本地）；< 3 s（集群，推送） |
| 事件保留 | 永久 |

---

## 2. 配套补丁里已经有什么

补丁 `metainfer-lab-async-foundation.patch` 基于 `867d277`，在仓库根目录执行：

```bash
git checkout -b refactor/async-foundation 867d277
git apply --index metainfer-lab-async-foundation.patch
cd dsh-metainfer-research-lab && npm ci && npm test
```

### 2.1 内容

| 文件 | WP | 内容 | 状态 |
|---|---|---|---|
| `host/cluster.js` | P0.1 | 修复 `acquire` 本地排队分支引用未定义变量 `entry`（导致 HTTP 500 → Lab `failStart(cluster_unavailable)`） | 完成，有回归测试 |
| `host/store.js` | P1.2（部分） | 删除 `EVENT_RETENTION` 删除逻辑，事件永久保留；新增仅供崩溃恢复使用的 `deleteEventRecord`（拒绝删除已确认事件） | 完成 |
| `host/kernel/priority.js` | P3.4 / P5.3 | 优先级类别 `p0..p3, deferred`、元组比较、按来源的公平排序（CFS） | 完成 |
| `host/kernel/mutations.js` | P1.1 | 变更 reducer、状态迁移表、受保护字段、redo effects | 完成 |
| `host/kernel/executor.js` | P1.3 | 单一写者 `commit/commitLocked`、basis 陈旧判定、幂等、先写事件后写记录、`recover()` | 完成 |
| `host/kernel/projection.js` | P1.4 | 内存索引（byId / byStatus / children）、唯一的 `runnable` 口径、一致性检查 | 完成 |
| `host/kernel/bus.js` | P1.5 | 进程内事件总线（每个订阅者独立有序队列）、`waitForEvents` 长轮询 | 完成 |
| `host/kernel/trace.js` | P1.6（部分） | 会话 label 规范、`inputDigest`、`TraceRef`、环境 cause（AsyncLocalStorage）、因果链回溯 | 完成；activation 表在 P1.6 后半 |
| `host/dispatch/types.js` | P3.1 | `ResourceBroker` / `DispatchStrategy` / `DispatchDecision` 契约和校验 | 完成 |
| `host/dispatch/envelope.js` | P3.1 | 安全包络 `submit()`：校验、防双花、Policy、提交点、启动、失败回滚与退避 | 完成 |
| `host/dispatch/brokers.js` | P3.2 / P3.3 | `LocalPoolBroker`；`ClusterBroker`（包装现有 coordinator 门面） | 完成；`/v1/verify` 和推送在 P3.7 |
| `host/dispatch/deterministic-strategy.js` | P3.4 | 默认确定性策略：事件唤醒、单飞、公平排序、逐个申请租约 | 完成 |
| `host/dispatch/dispatcher.js` | P3.5 | 每项目一个生效策略 + 影子策略 + 超时回退 | 完成 |
| `host/coordinator/gang-planner.js` | P3.5.2–P3.5.4 | 多机时间线规划：多形状、约束、best-fit、EASY / 保守回填、计划校验 | 完成（纯函数，未接入 coordinator） |
| `scripts/kernel-selftest.mjs` 等 | — | 内核 15 项、规划器 14 项、派发 7 项测试；`scripts/sim/gang-starvation.mjs` 模拟 | 全部通过 |
| `package.json` | — | `files` 增加新目录（否则打包会漏掉）；`npm test`、`npm run sim:gang` | 完成 |

### 2.2 尚未做的（本计划其余部分）

补丁里的新模块**都还没有接入运行路径**，现有行为不变（只有 P0.1 和事件不再删除两处行为变化）。接入工作是 P1.7 起的各 WP。

### 2.3 补丁的测试结果（在 Node 22 上）

```
15/15 kernel checks passed
14/14 gang planner checks passed
7/7 dispatch checks passed
cluster-fleet-selftest: 7 PASS（含新增回归项：修复前该项返回 500）
placement-selftest: 全部 PASS
```

`scripts/selftest.mjs` 需要 `../metainfer-demo-repo`，在没有这个演示仓库的环境里有 14 项失败；补丁前后失败项完全一致，与本补丁无关。

模拟结果（`npm run sim:gang`，2 台 8 卡机器，单卡任务持续到达，第 30 分钟到达一个 2×8 任务）：

```
greedy       gang never started; utilization 75.5%
easy         gang started at +66.6 min (bound +68.1); utilization 79.3%
conservative gang started at +66.6 min (bound +68.1); utilization 79.3%
```

这证实了当前 coordinator 的贪心分配会让多机任务**永远**排不上，即使集群利用率只有 75%。

---

## 3. 基线代码事实与已知缺陷

### 3.1 文件地图（`host/`，共约 12,000 行）

| 文件 | 行数 | 职责 | 重构后的去向 |
|---|---|---|---|
| `lab-service.js` | 2,656 | 服务门面：项目 CRUD、getState、agentTool、Copilot、dashboard | 变薄：Command → Policy → Executor |
| `runtime.js` | 2,037 | 节点生命周期：start/finish/fail/cancel/retry/merge、租约续约、lease pump、watchdog | 保留执行职责；写入走 Executor；派发移出 |
| `cluster.js` | 1,854 | coordinator 服务端 + 客户端门面 + 放置 | 规划逻辑移到 `host/coordinator/`，保留门面 |
| `orchestrator.js` | 1,261 | cycle、advisor、scheduler、提案校验、建子节点 | advisor → 专家运行时兼容层；scheduler → `LegacyLlmStrategy` |
| `git-engine.js` | 387 | worktree、提交、tag | 不变 |
| `models.js` | 353 | 模型路由 | 不变 |
| `http.js` / `mcp.js` | 343 / 338 | HTTP 路由 / MCP | 改为构造 Command |
| `remote-run.js` | 336 | 多机远程执行（SSH / 容器） | 增加预准备（P3.5.5） |
| `auto.js` | 326 | 自动挡轮询与熔断 | 退化为触发规则 + 熔断 |
| `snapshot.js` | 315 | advisor 快照 | 被导航 API 取代，保留给兼容层 |
| `placement.js` | 318 | 自然语言放置策略 | 不变 |
| `store.js` | 246 | storageDomain 门面 | 新表、写保护 |
| `gc.js` | 172 | 终止后 GC 角色 | 改为 postmortem 专家 |
| `agent-tool.js` | 134 | 全局 `metainfer_lab` 工具，49 个 action | 按 actor 授权 |
| `reconcile.js` | 84 | 启动时修复 running 节点 | 改走 Executor，增加 claim 清理 |
| `transcript.js` / `execution-log.js` | 80 / 66 | 会话读取 / Codex 执行日志 | `TraceRef` 统一 |
| `client.js` | 15,362 | 前端（未压缩源码） | 增量订阅、新视图 |

### 3.2 已知缺陷（K 编号在后文引用）

| # | 位置 | 问题 | 处理 |
|---|---|---|---|
| K1 | `cluster.js` `acquire` 末行 | 本地排队分支引用未定义的 `entry`，抛 ReferenceError → 500 | **补丁已修**（P0.1） |
| K2 | `store.js` `appendEvent` | 超过 5,000 条删最旧事件，违反"所有事件保留" | **补丁已修**（P1.2） |
| K3 | `orchestrator.js:313` `persistEvent`、`auto.js:82` `saveEvent`、`gc.js` | 锁外写入，可能与锁内写交错 | P1.7 |
| K4 | `store.js` `listNodes` | 每次扫描所有项目的节点表，29 处调用，热路径每 1–2 秒调用 | P1.8 |
| K5 | `lab-service.js:572` `getState` | 返回全量节点；已有 `sinceRevision` 但只做"未变化"短路 | P1.9 |
| K6 | `agent-tool.js:62` | 在根 ctx 全局注册，所有 preset（含角色）都能用 49 个 action | P2.2 |
| K7 | `orchestrator.js` advisor 提示第 2 条 "prefer 1"；`mergeAdvisorOutputs` 对整个评审团截断到 `maxProposalsPerPass`；`auto` 在没有新叶子时不规划 | DAG 宽度被压窄，GPU 空闲时也不规划 | P4.6 |
| K8 | `runtime.js:1826` `onSessionEvent` | 只处理 `turn/end`，不更新 `lastActivityAt`，无法判断停滞 | P4.5 |
| K9 | `orchestrator.js:358` `runRole` | run 记录复制 `inputSnapshot`（最大约 205 KB），却没有渲染后的 prompt；金丝雀分流导致同一快照不一定对应同一 prompt | P4.2 |
| K10 | `execution-log.js` | Codex 执行轨迹游离在 DSH 会话之外 | P4.9 |
| K11 | `cluster.js` `dispatchQueue` | 贪心：队首多机任务放不下就跳过，后面的小任务拿走空卡，多机任务被饿死；没有时间维度 | P3.5 |
| K12 | `runtime.js` 续约 `ttlMs = timebox + 120s` | 每次心跳把 `expiresAt` 往后推，coordinator 不知道任务的硬结束时间 | P3.7 |
| K13 | `runtime.js:1887` `pumpLeases` | 授予靠 2 秒轮询发现，多机租约空占更久 | P3.7 |
| K14 | `cluster.js:510` `persist` | 每次把整个 coordinator 状态写成一个 JSON | P3.5.1 |
| K15 | `presets.patch.yml` GC preset | 提到不存在的工具 `lab_cleanup` | P4.7 |
| K16 | `snapshot.js` `reportSummary` | 死代码 | P4.6 删除 |
| K17 | `orchestrator.js:613` `createChild` | 封存父节点时 `createdBy: 'advisor'`，不记录 lens / 专家 | P4.6 |
| K18 | `orchestrator.js:794` `applySchedulerOutput` | 串行 `runtime.start` 最多 20 个 | P3.6 |

---

## 4. 全局约束（不可违背）

| # | 约束 | 怎么检查 |
|---|---|---|
| G1 | **单一写者**：所有 Lab 状态（项目、节点、意图、专家、笔记本……）只能通过 `executor.commit` 修改 | P1.7 结束后开启 `kernel.strictWrites`，store 写方法在 Executor 之外调用即抛错；模拟器和测试中始终开启 |
| G2 | **事件永不删除**：事件日志是审计记录，也是 redo 日志；冷数据只能归档，不能删除 | 不变式 I3；只有 `recover()` 可以删除**从未确认**的事件 |
| G3 | **完整输入输出只存 DSH 会话**：插件只存 id、摘要（`inputDigest`）和结构化结果，不复制 prompt 或对话 | 代码审查；activation 表无大文本字段（单条 < 4 KB） |
| G4 | **专家只提议**：专家能调用的写工具只有 `submit_intent`、`update_notebook`、`claim` | Policy 能力表；P2 测试 |
| G5 | **Dispatcher 是接口，安全包络不可插拔**：任何策略只能经 `submit()` 改状态；GPU 只认 broker 签发且 `verify` 通过的租约 | P3 测试；不变式 I4、I11 |
| G6 | **GPU 只由 coordinator 签发**；签发前 agent 可以争论顺序和时间，但不能指定具体设备 | P7 规则校验器 |
| G7 | **多机任务全有或全无**：从不部分签发；默认不允许"先占一部分再等其余" | 不变式 I7；规划器 `validatePlan` |
| G8 | **确定性组件不含 LLM**：Executor、Projection、Bus、Trigger Engine、安全包络、coordinator 规划器 | 代码审查 |
| G9 | **每个决定可解释**：确定性组件的每个决定写一条带理由的事件；LLM 的每个决定可回溯到 DSH 会话 | `trace_explain` 覆盖测试（P4.10） |
| G10 | **事件名向后兼容**：现有事件类型（`node/started` 等，见 §13.1）保持名字和 `data` 字段不变，UI 和回放依赖它们 | 遗留对等场景 S14 |
| G11 | **派生数据不持久化**：Projection、队列、排序都是派生视图，不写回存储（B3） | 代码审查 |
| G12 | **超时有确定性兜底**：任何等待 LLM 的环节（专家、agent 策略、争论轮次）都有 deadline 和确定性默认行为 | 模拟场景 S7、S12 |
| G13 | **可回滚**：每个阶段通过开关切换，关闭开关即回到旧路径，直到 §12 规定的移除点 | §12 |

---

## 5. 决定清单

"已定"由负责人在讨论中确认；"默认"是本计划的推荐，执行者按默认做，负责人可以推翻；"需确认"必须在对应 WP 开工前问。

| # | 决定 | 状态 | 影响的 WP |
|---|---|---|---|
| D1 | 事件全量保留 | 已定 | P1.2 |
| D2 | 专家输入输出轨迹复用 DSH 会话系统 | 已定 | P1.6、P4 |
| D3 | Dispatcher 是可插拔接口，将来可以是跨机器争论的 LLM agent | 已定 | P3、P7 |
| D4 | GPU 只由 coordinator 签发，签发前可由 agent 争论 | 已定 | P3.7、P7 |
| D5 | 支持跨多台机器的任务，所有机器同时空闲才能运行，由中心统一管理 | 已定 | P3.5 |
| D6 | 专家形态：**无状态激活 + 外置笔记本 + 事件游标**，不用驻留会话（回答 B16 / C3） | 默认 | P4 |
| D7 | 组织方式：**作用域分区 + 升级路由**，不做固定三级层级（回答 B11 / B12 / C4） | 默认 | P5 |
| D8 | 允许 storageDomain 升级到 `DOMAIN_VERSION = 2`（新增表） | 默认；具体迁移方式取决于 spike S4 | P1.10 |
| D9 | 模拟器是每个阶段的强制验收门 | 默认 | 全部 |
| D10 | 争论轮次默认 `consensus` 模式；`mediated` 以后加 | 默认 | P7 |
| D11 | 引入优先级额度（按速率补充的项目级额度） | 默认 | P7.4 |
| D12 | walltime（= 节点 timebox）作为硬上限写入租约 `hardEndAt`，续约不能推后 | 默认 | P3.7 |
| D13 | 多机任务默认"排空式凑齐"；"显式占卡"必须由任务声明或协议同意 | 默认 | P3.5.7 |
| D14 | 抢占放在 P3.5 最后一步，第一版先做预留 + 回填 | 默认 | P3.5.9 |
| D15 | DSH 会话的保留策略：如果 DSH 会清理旧会话，需要能标记永久保留或在清理前归档 | **需确认**（spike S3） | P0.6、P4 |
| D16 | `report.summary` 不在源头截断，新增 `headline`（≤ 300 字符）用于索引（反对 B26） | 默认 | P6.6 |
| D17 | 跨信任域的 peer broker 协议参考 A2A；Lab 内部始终用租约结算 | 默认 | P7.6 |
| D18 | 第一版 `contest.mode = off`，先上线 P3.5 的确定性预留，再开争论 | 默认 | P7 |

---

## 6. 目标架构与代码布局

### 6.1 架构图

```
┌──────────────────────── 接入面（变薄）─────────────────────────────────┐
│ HTTP routes · MCP(read / control) · metainfer_lab 工具 · UI 增量订阅      │
│   → Command{actor, action, target, payload, idempotencyKey, basis}       │
└────────────────────────────────┬────────────────────────────────────────┘
                                 ▼
┌──────────────────────── 确定性内核（无 LLM）─────────────────────────────┐
│ Policy      authorize(actor, action, target)；能力表 + 不可逆等级          │
│ Executor    唯一写者 commit()；basis 陈旧判定；幂等；先事件后记录；recover │
│ Projection  内存索引 byStatus/children/runnable/tags/LSH/claims；可重建    │
│ EventBus    提交后发布；订阅者独立队列；长轮询                              │
│ IntentLog   意图流水线：Policy → 陈旧 → Verifier → 冲突矩阵 → commit      │
│ Verifier    claim 谓词校验；按不可逆等级要求证据                          │
│ Trace       activation 记录；causeId 因果链；trace_explain                │
└──────┬───────────────────┬──────────────────────────┬───────────────────┘
       ▼                   ▼                          ▼
  Dispatcher          Trigger Engine              Expert Runtime
  (接口+安全包络)      哨兵规则 → 唤醒票据          注册表/生命周期/预算
  策略：确定性 /        低水位、停滞、覆盖、          无状态激活 + 笔记本 + 游标
  LegacyLLM / agent    重复候选、预测误差、          作用域工具（dag_* / submit_intent）
  broker：本地池 /      升级码                            │
  集群 / peer                          ┌──────────────────┼──────────────────┐
       │                               ▼                  ▼                  ▼
       ▼                         Explorer（按分区）    Curator（单例）   Arbiter（例外）
  Coordinator（中心资源管理器）   Lead（可选，按分区组） Postmortem（原 GC）
  准入 → 定序（可争论）→ 规划（时间线：预留 + 回填）→ 原子签发 → 推送
       │
       ▼
  Runtime（worker / anchor / git / remote-run）：执行不变，写入走 Executor
```

### 6.2 从图上消失的东西

- **scheduler LLM**：排序和占槽归 Dispatcher；取舍归专家意图（`set_priority`、`defer`）；跨分区资源分配归 Policy 配额加可选的 lead 专家。旧行为保留为 `LegacyLlmStrategy`（兼容开关）。
- **cycle 作为主驱动**：保留为一条 `interval` 触发规则，兼容旧项目。
- **轮询**：auto 2 秒、lease pump 2 秒改为事件驱动；保留慢速安全定时器（15 秒）兜底。

### 6.3 代码布局

```
host/
  kernel/            # 确定性内核（补丁已建：priority, mutations, executor, projection, bus, trace）
    policy.js        # P2.2
    commands.js      # P2.1
    intents.js       # P5.1
    conflicts.js     # P5.2 冲突矩阵
    verifier.js      # P6.1
    triggers.js      # P4.5
    eventlog.js      # P1.2 冷段归档与读取
    write-guard.js   # P1.7 strictWrites
  dispatch/          # 补丁已建：types, envelope, brokers, deterministic-strategy, dispatcher
    legacy-llm-strategy.js   # P3.6
    agent-strategy-base.js   # P7.3
    peer-broker.js           # P7.6
  coordinator/       # 补丁已建：gang-planner
    state.js         # P3.5.1 状态 + 日志式持久化
    server.js        # P3.5.1 从 cluster.js 拆出的 HTTP 服务端
    reservations.js  # P3.5.4
    rounds.js        # P7.1
    credits.js       # P7.4
  experts/
    registry.js      # P4.1
    runner.js        # P4.2
    nav-tools.js     # P4.3
    notebook.js      # P4.4
    partitioner.js   # P5.5
    curator.js       # P5.6（描述符 + 候选生成）
    similarity.js    # P5.4 MinHash/LSH
    builtin.js       # 内置专家描述符
scripts/
  lib/memory-domain.mjs      # 补丁已建
  lib/fake-dsh.mjs           # P0.2 假 agents/subagents/sessionQuery/sessions
  sim/                       # P0.3 模拟器；补丁已建 gang-starvation.mjs
docs/
  07-async-refactor-plan.md  # 本文
  refactor/PROGRESS.md       # 进度
  refactor/spikes.md         # spike 结论
  refactor/baseline.json     # 基线指标
```

---

## 7. 核心契约

契约先于实现。补丁中已实现的契约以代码为准，这里列出全貌。

### 7.1 Actor 与 Command

```ts
type ActorKind = 'human' | 'expert' | 'dispatcher' | 'mcp' | 'system' | 'legacy';
type Actor = { kind: ActorKind; id: string };     // 例：{kind:'expert', id:'exp-explorer-3'}

type Command = {
  actor: Actor;
  action: string;            // 'node.create' | 'node.approve' | 'node.cancel' | 'project.edit' | ...
  target: { projectId: string; nodeId?: string };
  payload: object;
  idempotencyKey?: string;   // MCP / HTTP 写请求必须带
  basis?: number;            // 调用方看到的 revision
};
```

`legacy` 是迁移期旧代码路径的 actor（`{kind:'legacy', id:'runtime'}` 等），P4 结束时清零。

### 7.2 变更（mutation）目录

已实现（`host/kernel/mutations.js`）：

| op | 说明 | 默认事件 |
|---|---|---|
| `node.create` | 新节点；父节点必须存在；规范化 priority | `node/created` |
| `node.update` | 改非受保护字段（`id/status/rev/priority/claim` 受保护） | `node/edited` |
| `node.transition` | 状态迁移，按迁移表校验；可选 `from` 前置条件；离开 planned 时消耗 claim | `node/started` / `node/completed` / `node/failed` / `node/cancelled` / `node/planned` |
| `node.setPriority` | 改 priority；记录 by/at | `node/priority_changed` |
| `node.claim` | 派发提交点：planned、未被 claim、非 deferred | `dispatch/claimed` |
| `node.releaseClaim` | 释放 claim（启动失败、回收） | `dispatch/claim_released` |
| `node.delete` | 只能删 proposed；`system` actor 例外 | `node/deleted` |
| `project.update` | 改项目非受保护字段 | `project/edited` |
| `event.record` | 只记录决定、不改状态（`dispatch/decided`、`trigger/fired` 等） | 调用方指定 |

每个 mutation 都可以用 `eventType` 和 `eventData` 覆盖默认事件，迁移旧代码时用它保持旧事件名（G10）。

待新增（随 WP）：

| op | WP |
|---|---|
| `run.create` / `run.update`（role run 记录，迁移期） | P1.7 |
| `activation.open` / `activation.close` | P1.6 |
| `intent.submit` / `intent.resolve` | P5.1 |
| `claim.acquire` / `claim.release`（审查租约） | P5.1 |
| `expert.upsert` / `expert.setState` | P4.1 |
| `notebook.patch` | P4.4 |
| `ledger.upsert` | P6.2 |
| `dispute.open` / `dispute.resolve` | P6.4 |
| `node.archive` / `node.restore` | P5.3 |
| `wake.enqueue` / `wake.consume` | P4.5 |

状态迁移表（`DEFAULT_TRANSITIONS`，按基线代码归纳，P1.7 迁移时逐条核对并收紧）：

```
proposed  → planned, cancelled
planned   → running, failed, cancelled
running   → completed, failed, cancelled
completed → running（叶子追问）, planned（prepareNewAttempt）
failed    → planned, running
cancelled → planned
```

### 7.3 事件信封

```jsonc
{
  "seq": 4412, "projectId": "prj-a", "at": 1762690000000, "type": "node/started",
  "nodeId": "n-0412",
  "actor": { "kind": "dispatcher", "id": "deterministic" },
  "causeId": "evt:prj-a:4409",        // 或 act:<activationId> / intent:<id> / round:<id>
  "activationId": null,
  "basis": 4405,                      // 调用方的 basis（可空）
  "revision": 1290,                   // 本次 commit 的 revision
  "commit": { "id": "cmt-…", "index": 0, "size": 2 },
  "data": { … },                      // 与旧事件兼容的业务字段
  "effects": [ … ],                   // redo 用；node.put / node.merge / node.delete / project.merge
  "evidence": [ … ]                   // 仅 commit 的第一条事件
}
```

`revision` 是项目级计数（每次 commit 加 1，沿用现有 `project.revision`，UI 已依赖它）；`seq` 是事件序号。一次 commit 可以产生多条事件。

### 7.4 Executor

```ts
executor.commit(projectId, {
  actor, mutations, basis?, allowStale?, idempotencyKey?, causeId?, activationId?, evidence?
}) → Promise<
  | { ok: true; commitId; revision; events; nodeIds; replayed? }
  | { ok: false; code; message; stale?; conflicts?; revision? }
>
executor.commitLocked(...)   // 调用方已持有 withProjectLock（迁移期）
executor.recover(projectId)  // 启动时，在任何写入之前调用
```

拒绝码：`invalid_commit`、`invalid_mutation`、`not_found`、`conflict`、`stale`、`illegal_transition`、`protected_field`、`precondition_failed`、`not_runnable`、`already_claimed`、`forbidden`、`unknown_op`。

持久化顺序：事件 → 记录 → 项目（`counters.eventSeq` 落盘即确认）。`recover()` 重做已完整写入事件的 commit，丢弃不完整 commit 的事件。

陈旧判定的粒度是**目标节点**：节点 `rev` > `basis` 才算陈旧，其他节点变化不影响。

### 7.5 Projection

```ts
projection.load(projectId)                 // 启动时每个项目扫描一次
projection.applyCommit(projectId, events)  // Executor 调用
projection.getNode / listNodes / listByStatus / countByStatus / children / isLeaf
projection.runnable(projectId, now)        // 唯一口径：planned && !claim && class≠deferred && !dispatchHold
projection.revision(projectId)
projection.checkConsistency(projectId)     // 模拟器 / 调试开关
```

P5 增加：`byTag(hypothesis)`、`similarCandidates(nodeId)`（LSH）、`claimsOn(nodeId)`、`pendingIntentsOn(nodeId)`、`scopeOf(nodeId)`、热 / 归档分层。

### 7.6 Trace

- **会话 label**：`mirl/<projectId>/<actorKind>/<actorId>/<activationId>`；身份会话省略最后一段。
- **会话树**：

  ```
  project controller（lab-controller，空壳）
   ├─ expert:<expertId>            身份会话（空壳），其下挂 subagent/catalog
   │    ├─ act-0001                一次激活 = 一个子会话
   │    └─ act-0002
   ├─ dispatcher:<strategyId>      agent 型派发策略的身份会话
   │    └─ act-…                   每次决策或争论 = 一个子会话
   └─ node anchor → worker attempts（不变）
  ```

- **Activation 记录**（表 `activations`，P1.6）：

  ```jsonc
  { "id": "act-…", "projectId", "actor": {"kind":"expert","id":"exp-explorer-3"},
    "wakeTicketId", "causeId", "basisRevision", "cursorFrom", "cursorTo",
    "sessionId", "parentSessionId", "label", "inputDigest", "model", "preset",
    "budget": {"tokens", "queries", "wallClockMs"}, "usage": {"inputTokens", "outputTokens", "costUsd"},
    "toolCalls": 7, "intentIds": ["int-…"], "status": "running|finished|failed|aborted",
    "error": null, "startedAt", "finishedAt" }
  ```

- **TraceRef**：`{kind:'dsh-session', sessionId, toolCallId?} | {kind:'execution-log', path}`。
- **因果链**：`触发事件 → 唤醒票据 → activation(sessionId) → intent(toolCallId) → commit 事件 → dispatch 决定 → node/started → worker 会话`。`trace_explain(nodeId | intentId | eventSeq)` 沿 `causeId` 回溯，遇到 `act:` / `intent:` / `round:` 时查对应表。

### 7.7 意图（P5）

```jsonc
Intent {
  "id": "int-…", "projectId",
  "kind": "create|defer|restore|resurrect|set_priority|cancel|mark_redundant|ledger|escalate|dispute|claim",
  "actor": {"kind":"expert","id":"exp-curator"}, "activationId", "sessionId", "toolCallId",
  "target": {"nodeId": "n-0079"}, "payload": {…}, "basis": 4412,
  "evidence": [ {"nodeId", "field", "quote?"} ],
  "claims": [ {"predicate": "metric(n-0031,'tflops') >= 410", "verified": true|false|"infer"} ],
  "ttlMs": 300000,
  "status": "pending|applied|rejected|withdrawn|expired|vetoed",
  "appliedRevision": null, "rejectCode": null, "rejectMessage": null,
  "createdAt", "resolvedAt"
}
```

### 7.8 专家描述符、笔记本、唤醒票据（P4）

```jsonc
ExpertDescriptor {
  "id": "exp-explorer-3", "type": "explorer|lead|curator|arbiter|postmortem|legacy-lens",
  "persona": "…", "preset": "lab-expert", "model": {"provider", "model", "effort"},
  "scope": {"kind": "partition|global|branches", "assign": "auto|fixed", "branchRoots": []},
  "triggers": ["branch.nodeTerminal", "lowWater", "coverage", "interval:600000"],
  "capabilities": {"propose": ["create", "defer:own", "set_priority:scope", "ledger", "claim", "escalate"]},
  "budget": {"tokensPerHour": 200000, "queriesPerActivation": 6, "wallClockMs": 240000, "maxConcurrent": 1},
  "output": "EXPERT_INTENTS_V1",
  "state": "active|draining|retired", "hiredAt", "retiredAt"
}

Notebook {
  "expertId", "rev", "lastSeenSeq",
  "entries": [ {"id", "kind": "hypothesis|todo|conclusion|watch", "text": "≤500 字符",
                "evidence": [{"nodeId", "field"}], "updatedAt"} ]      // 最多 50 条、16 KB
}

WakeTicket {
  "id", "expertId", "reasons": [{"rule", "eventSeq"}], "coalescedFrom": 3,
  "createdAt", "dueAt", "status": "queued|running|done|dropped", "activationId"
}
```

### 7.9 导航工具（专家作用域工具，P4.3）

所有返回值都带 `revision`；超出预算时带 `_truncated: {shown, total, next}`（B25）。

| 工具 | 输入 | 输出 |
|---|---|---|
| `dag_map` | `{scope?, depth?, statuses?, limit?}` | 分支树摘要：每个节点一行 `{id, status, headline, outcome, priority.class, children, pending[], claims[]}` |
| `dag_walk` | `{nodeId, direction: up|down|siblings, depth}` | 一次取回整条链（Q9） |
| `dag_get` | `{nodeId, fields?}` | 节点详情：prompt、report、metrics、attempts、git 信息、资源等待/预留 |
| `dag_diff` | `{sinceSeq}` | 游标之后与本作用域相关的事件摘要；游标落在快照之前时返回 `gap:true` 和快照指针 |
| `dag_query` | `{tag?, hypothesis?, status?, metric?, text?, limit}` | 索引查询（tag、LSH 近邻、状态、指标阈值） |
| `trace_explain` | `{nodeId|intentId|eventSeq}` | 因果链 |
| `resource_status` | `{nodeId?}` | 资源侧事实：排队位置、预留开始时间、阻塞原因 |
| `submit_intent` | `Intent` 的提交字段 | `{intentId, status:'pending'}`（异步处理） |
| `update_notebook` | `{ops:[add|update|remove]}` | `{rev}` |
| `claim` | `{nodeId, intent:'review'|'propose', ttlMs}` | `{claimId}` 或冲突信息 |

### 7.10 Dispatcher（补丁已实现，`host/dispatch/types.js`）

```ts
interface ResourceBroker {
  id: string;                                  // 'local-pool' | 'cluster' | 'peer:<machine>'
  acquire(req: LeaseRequest): Promise<AcquireResult>;
  renew(leaseId): Promise<{status:'renewed', lease} | {status:'lost'}>;
  release(leaseId): Promise<void>;
  verify(lease, {projectId, nodeId}): Promise<boolean>;   // 内核结算前必须调用
  preview?(req): Promise<AcquireResult>;       // 影子策略的试算
  watch?(onChange): Unsubscribe;               // 容量变化 / 授予推送
}
type AcquireResult =
  | {status:'granted', lease: LeaseGrant}
  | {status:'reserved', reservationId, startAt}
  | {status:'queued', position?, reason?}
  | {status:'contested', roundId, deadlineAt}
  | {status:'denied', reason};

interface DispatchStrategy {
  id: string; kind: 'deterministic' | 'agent' | string;
  start(ctx: DispatchContext): Promise<void>;
  stop(opts: {drain: boolean}): Promise<void>;
  poke?(): Promise<void>;
}

type DispatchDecision =
  | {kind:'start',   nodeId, lease, basis, reason, idempotencyKey?}
  | {kind:'release', leaseId, broker, reason}
  | {kind:'defer',   nodeId, untilMs, basis, reason}
  | {kind:'preempt', victimNodeId, forNodeId, basis, reason};
```

安全包络 `submit()` 对 `start` 依次检查：格式 → 节点可运行且未陈旧 → 本进程内租约未用过（防双花）→ `broker.verify`（租约真实、未过期、签给这个节点）→ Policy → commit `node.claim`（提交点）→ `launcher.start` → 失败则释放租约与 claim、指数退避（30 s 起，最长 30 min）。任何拒绝都释放租约并记录 `dispatch/rejected`。

Dispatcher 宿主：每项目一个生效策略；可选影子策略（只记录 `dispatch/shadow_decided`，broker 换成只读 `preview`）；生效策略在"有可运行节点"的情况下超过 `fallbackAfterMs` 没有成功决定，就切换到回退策略并记录 `dispatch/fallback`。

### 7.11 多机请求与租约（P3.5 / P3.7）

```jsonc
GangRequest {
  "requestId": "prj-a:n-0412:2", "holderId", "projectId", "nodeId",
  "shapes": [ {"machines": 2, "gpusPerMachine": 4}, {"machines": 1, "gpusPerMachine": 8} ],
  "constraints": { "machineIds": [], "excludeMachineIds": [], "machineLabels": {"rack": ["a","b"]},
                   "gpuModels": ["h100"], "colocate": "rack" },
  "walltimeMs": 3600000,          // = 节点 timebox，硬上限
  "class": "p1", "deadlineAt": null,
  "preemptible": false, "checkpointable": false,
  "holdIdle": { "allowed": false, "maxReservedIdleMs": 0 }
}

Lease {
  "leaseId", "requestId", "holderId", "projectId", "nodeId",
  "machines": [ {"machineId", "deviceIds": [...]} ], "shapeIndex": 0,
  "grantedAt", "hardEndAt",        // 新：= grantedAt + walltimeMs，续约不改变
  "expiresAt",                     // 存活 TTL，续约推后
  "priority", "reservationId": null
}

Reservation {
  "reservationId", "requestId", "startAt", "machines": [...], "shapeIndex",
  "createdAt", "slips": 0,          // 被推后的次数（只有机器掉线或显式 extend 才会推后）
  "state": "planned|draining|imminent|issued|cancelled"
}
```

### 7.12 争论轮次（P7）

```jsonc
Round {
  "roundId", "openedAt", "deadlineAt", "mode": "consensus|mediated",
  "resources": { "machines": [...], "window": {"from", "to"} },
  "requests": [ "requestId", … ],          // 受影响的请求
  "defaultPlan": { … },                    // 确定性规划器的默认结果（截止时采用）
  "messages": [ … ],                       // 追加写
  "agreement": null | { "order": [...], "notBefore": {...}, "maxDurationMs": {...},
                        "holdIdle": {...}, "shapes": {...}, "credits": {...}, "signatures": [...] },
  "outcome": "agreement|default|invalid", "violations": []
}
Message = claim | offer | counter | concede | agree   // 字段见 P7.3
```

---

## 8. 存储与迁移

### 8.1 表（`DOMAIN_VERSION = 2`）

| 表 | key | 说明 |
|---|---|---|
| `projects` | `projectId` | 不变；新增 `config.dispatch`、`config.experts`、`config.contest` 等开关 |
| `nodes` | `${projectId}__${nodeId}` | 新字段见 8.2 |
| `runs` | `${projectId}__run-…` | 遗留 role run；P4 后只读 |
| `cycles` | `${projectId}__cyc-…` | 遗留；兼容 cycle 规则仍写 |
| `events` | `${projectId}__e${seq:08}` | 永久保留；P1.2 冷段归档 |
| `activations` | `${projectId}__${activationId}` | P1.6 |
| `intents` | `${projectId}__${intentId}` | P5.1 |
| `claims` | `${projectId}__${claimId}` | P5.1，带 TTL |
| `experts` | `${projectId}__${expertId}` | P4.1 |
| `notebooks` | `${projectId}__${expertId}` | P4.4 |
| `wake_tickets` | `${projectId}__${ticketId}` | P4.5 |
| `ledger` | `${projectId}__${hypothesisId}` | P6.2 |
| `disputes` | `${projectId}__${disputeId}` | P6.4 |
| `snapshots` | `${projectId}__s${revision:010}` | P1.2 投影快照（每 1,000 个 revision） |
| `idempotency` | `${projectId}__${key}` | P1.3 持久化幂等（保留 7 天，由 GC 规则清理，**这不是事件**） |

### 8.2 节点新增字段

| 字段 | 说明 | WP |
|---|---|---|
| `rev` | 最后修改它的 revision（补丁已实现） | P1.1 |
| `priority` | `{class, score, by, reason, at}` | P3.8 |
| `claim` | 派发提交点 | P3.1 |
| `dispatchHold`、`dispatchFailures` | 派发退避 | P3.1 |
| `tags` | `{hypothesis, lever, variant}`（B18） | P5.4 |
| `expected` | `{metric, direction, magnitude}` | P6.3 |
| `branchId`、`ownerExpertId` | 分区 | P5.5 |
| `redundantOf`、`archivedAt` | 清理 | P5.3 |
| `headline` | ≤ 300 字符 | P6.6 |
| `needs.shapes`、`placementConstraints` | 多机形状 | P3.5.10 |
| `resourceWait.reservation` | `{reservationId, startAt, reason}` | P3.5.10 |

### 8.3 迁移步骤

1. **备份**：迁移前把整个 domain 导出为 `~/.dsh/metainfer-research-lab/backup/<timestamp>/domain-v1.jsonl.zst`（每行 `{table, key, value}`）。导出工具写成 `scripts/export-domain.mjs`，同时用于回滚。
2. **升级方式取决于 spike S4**：
   - 若 storageDomain 支持就地升级（版本号变化时允许新增表）：直接把 `DOMAIN_SPEC.version` 改为 2，新增表。
   - 否则：打开新 domain `metainfer_research_lab_v2`，启动时检测 v1 存在而 v2 为空，按表逐条复制（节点补默认字段：`priority = {class: 'p2'}`，人建节点为 `p0`；`rev = project.revision`），复制完成后在 v1 的项目记录上写 `migratedTo: 'v2'`，v1 从此只读。
3. **事件不改写**：旧事件没有 `actor`/`commit` 字段，读取方必须容忍；`walkCauses` 遇到无 `causeId` 的事件即终止。

### 8.4 事件冷段归档（P1.2 后半）

- 每个项目事件超过 `kernel.hotEvents`（默认 50,000）条时，把最早的整段（10,000 条）写到 `~/.dsh/metainfer-research-lab/eventlog/<projectId>/seg-<from>-<to>.jsonl.zst`，同时写 sha256 校验文件，校验成功后从表中移出。
- `listEvents(projectId, after, limit)` 透明地从冷段和表中读取。
- 归档是唯一允许从表中移出已确认事件的路径，且内容必须先完整落到冷段文件。

---

## 9. 开关（feature flags）

| 开关 | 位置 | 取值 | 默认（阶段完成后） | 引入 |
|---|---|---|---|---|
| `kernel.strictWrites` | Host 配置 | `off|warn|throw` | `warn`（生产），`throw`（测试/模拟） | P1.7 |
| `kernel.consistencyCheckEvery` | Host 配置 | 整数（0 关闭） | 0（生产），1（模拟） | P1.4 |
| `ui.incremental` | Host 配置 | bool | true | P1.9 |
| `dispatch.strategy` | `project.config` | `legacy-llm|deterministic|<agent id>` | `deterministic` | P3.5 |
| `dispatch.shadow` | `project.config` | 策略 id 或 null | null | P3.5 |
| `dispatch.fallback` / `fallbackAfterMs` | `project.config` | 策略 id / 毫秒 | `deterministic` / 120000 | P3.5 |
| `cluster.planner.mode` | `cluster.json` | `greedy|easy|conservative` | `easy` | P3.5.4 |
| `cluster.planner.reserveDepth` | `cluster.json` | 整数 | 1 | P3.5.4 |
| `cluster.holdIdle.enabled` | `cluster.json` | bool | false | P3.5.7 |
| `cluster.preemption.enabled` | `cluster.json` | bool | false | P3.5.9 |
| `experts.mode` | `project.config` | `legacy-cycle|runtime` | `runtime`（新项目），旧项目保持 `legacy-cycle` 直到手动切换 | P4.6 |
| `experts.curator.enabled` | `project.config` | bool | true | P5.6 |
| `experts.arbiter.enabled` | `project.config` | bool | true | P5.7 |
| `contest.mode` | `cluster.json` | `off|shadow|consensus|mediated` | `off` → `shadow` → `consensus` | P7 |

---

## 10. 阶段与工作包

依赖关系：

```
P0 ──► P1 ──┬──► P2 ──┐
            ├──► P3 ──┼──► P4 ──► P5 ──► P6
            │    │    │
            │    └──► P3.5 ──► P7
```

- P1 是所有后续阶段的硬前置。
- P2 与 P3 可以并行。P3.5 只依赖 P3 的 broker 接口，可以与 P2、P4 并行。
- P4 依赖 P2（作用域工具与能力）和 P3（专家不再负责启动节点）。
- P7 依赖 P3.5（争论建立在确定性规划器的推演之上）。

每个 WP 的格式：**目标 / 文件 / 步骤 / 不变式 / 测试 / 验收**。标 ✅ 的已在补丁中完成，执行者只需复核。

---

### P0 · 地基：测试工具、模拟器、spike、热修

#### P0.1 ✅ 修复 coordinator 本地排队崩溃（K1）

- 文件：`host/cluster.js`、`scripts/cluster-fleet-selftest.mjs`。
- 已完成：`queuePosition(entry.requestId)` → `queuePosition(request.requestId)`；新增回归测试"本地请求在满载机器上排队并返回位置"（修复前返回 500）。
- 复核：`node scripts/cluster-fleet-selftest.mjs` 全部 PASS。

#### P0.2 假 DSH 运行环境

- 目标：让 runtime / orchestrator / 专家运行时能在没有 DSH 的情况下跑。
- 文件：新建 `scripts/lib/fake-dsh.mjs`；把 `scripts/selftest.mjs` 里的 `fakeSubprocess` 移进来复用。
- 步骤：
  1. 实现 `fakeCtx({clock})`，提供 `storageDomain`（用 `memory-domain.mjs`）、`subprocess`、`agents.create/resume/get`、`subagents.startActivation`、`sessionQuery.readSurface/readSession`、`sessions.get().append`、`tools.register`、`logger`、`on('session/event')`。
  2. 假会话存储：每个会话保存 `{sessionId, parentId, label, preset, messages[], toolCalls[], usage}`，`readSurface` 返回与真实 DSH 相同形状的行（参考 `host/transcript.js` 的映射）。
  3. `startActivation` 接受一个"脚本化模型"：按 label 前缀或 preset 找到脚本，脚本根据输入返回 `structured_output` 或一串工具调用。
- 测试：用 fake ctx 跑通现有 `orchestrator.runCycle` 一次（脚本化 advisor 和 scheduler 输出）。
- 验收：`scripts/fake-dsh-selftest.mjs` 通过；runCycle 产生的事件类型序列与真实环境一致（与 `docs/refactor/baseline.json` 中记录的一次真实 cycle 对比）。

#### P0.3 模拟器

- 目标：所有阶段的规模与正确性验收。
- 文件：`scripts/sim/harness.mjs`、`scripts/sim/fake-worker.mjs`、`scripts/sim/fake-expert.mjs`、`scripts/sim/invariants.mjs`、`scripts/sim/scenarios/*.mjs`、`scripts/sim/run.mjs`。
- 步骤：
  1. **时钟注入**：`runtime.js`、`auto.js`、`cluster.js`、`orchestrator.js` 中所有 `Date.now()` 和定时器改为通过注入的 `clock` 与 `timers`（默认真实实现）。这是零行为变化的重构，单独一个提交。
  2. **虚拟时钟**：离散事件调度器（参考 `scripts/sim/gang-starvation.mjs` 的写法），支持 `advance(ms)` 和"运行到下一个事件"。
  3. **假 worker**：节点启动后按分布（耗时、成功率、metrics）在虚拟时间里完成，通过 runtime 的正常完成路径写报告。
  4. **假专家**：脚本化策略（随机提案 + 可配置重复率 + 可配置延迟），或者低成本模型（可选，默认关闭）。
  5. **不变式检查器**：每次 commit 后运行 §11.3 的不变式；失败时输出最小复现（种子 + 事件前缀）。
  6. **报告**：JSON，包含不变式结果和指标（§13.2）。
  7. 场景见 §11.2；P0 阶段实现 S1、S2、S5、S6、S9（S9 已有）。
- 验收：`node scripts/sim/run.mjs --scenario all --seed 1..5` 在基线代码上跑完，记录基线指标到 `docs/refactor/baseline.json`。基线上允许不变式失败（这正是要修的），但要如实记录。

#### P0.4 Spike S1：storageDomain 语义

- 问题：`table.get` 返回引用还是副本？`put` 是否同步持久化、是否按调用顺序落盘？`entries()` 遍历期间 `put` 的行为？单条记录大小上限？有没有多记录事务？
- 方法：在开发用 DSH Host 里加载一个只读诊断插件（放在仓库外），逐项测试；结论写进 `docs/refactor/spikes.md`。
- 影响：Executor 已经深拷贝工作集，不依赖 `get` 返回副本；但如果 `get` 返回引用，旧代码"先改对象、后失败"会污染内存状态，P1.7 迁移时要特别注意。如果 `put` 不保证顺序落盘，`recover()` 的前提不成立，见 §14。

#### P0.5 Spike S2：激活能否挂作用域工具

- 问题：`ctx.subagents.startActivation` 能否为单次激活注入工具（类似 `agents.create` 的 `setup`）？工具处理函数能否拿到调用方会话 id（用于 Policy 判断调用者）？
- 已知先例：Copilot 用 `ctx.agents.create({setup})` + `agentCtx.tools.register(copilotToolDefinition(projectId))`（`lab-service.js:1386`、`:1546`）；controller 会话用 `agents.create/resume`（`orchestrator.js:329–333`）。
- 结论分支：能注入 → 专家激活直接用 `startActivation`；不能 → 每次激活用 `agents.create({parent?, setup})` 创建子会话，并在父会话追加 `subagent/catalog` 以保持会话树（Copilot 已这样做）。

#### P0.6 Spike S3：DSH 会话保留与可写性

- 问题：DSH 是否按时间或容量清理 `~/.dsh/sessions`？能否把某些会话标记为永久保留？插件能否创建会话并写入事件（用于把 Codex 执行日志镜像进 DSH）？`readSurface` 返回的工具调用是否带稳定 id？
- 结论分支见 §14；D15 在此确认。

#### P0.7 Spike S4：domain 版本升级

- 问题：`storageDomain.open` 用新版本号打开旧数据时的行为（报错 / 迁移钩子 / 允许新增表）。
- 结论决定 §8.3 第 2 步走哪条路。

#### P0.8 基线指标采集

- 在真实项目（只读）上采集：每 cycle 的 advisor / scheduler 延迟、启动延迟、时间加权平均并发、GPU 空闲空洞时长、advisor 输入大小、store 体量。写入 `docs/refactor/baseline.json`。只用于对比，不用于决定是否做某项（见 `docs` 中的规模目标）。

**P0 验收**：P0.2、P0.3 测试通过；四个 spike 结论写入 `spikes.md`；D15 已确认；基线指标已记录。

---

### P1 · 确定性内核

#### P1.1 ✅ 变更 reducer 与状态迁移表

- 文件：`host/kernel/mutations.js`。
- 复核：迁移表与 `runtime.js` / `orchestrator.js` / `lab-service.js` / `reconcile.js` 中所有状态写入逐条核对（列表见本文 §7.2）；P1.7 迁移每个写者时如果发现表里缺少的迁移，**先确认它是合法业务路径**再加进表，并在 PROGRESS.md 记录。

#### P1.2 事件保留与冷段归档

- ✅ 删除 `EVENT_RETENTION` 的删除逻辑；新增仅限恢复使用的 `deleteEventRecord`。
- 待做：
  1. `host/kernel/eventlog.js`：冷段归档（§8.4）、`listEvents(projectId, after, limit)` 跨冷段读取、`getEvent(projectId, seq)`。
  2. `snapshots` 表：每 1,000 个 revision 写一个投影快照（节点 id → `{status, rev, priority, claim, parentIds}` 的紧凑形式），供 `dag_diff` 的 gap 处理和快速重建使用。
  3. `store.listEvents` 加 `limit` 参数（现在一次返回全部）。
- 测试：归档后 `listEvents` 结果与归档前一致；冷段校验失败时拒绝移出；快照 + 回放重建的投影与全量重建一致。

#### P1.3 ✅ Executor

- 文件：`host/kernel/executor.js`。
- 待补：
  1. 持久化幂等表（`idempotency`，保留 7 天）替换当前的进程内 Map（进程重启后 MCP 重试也能识别）。
  2. 性能：5,000 节点时单次 commit p99 < 20 ms（模拟器 S2 测）。

#### P1.4 ✅ Projection

- 文件：`host/kernel/projection.js`。
- 待补：启动时为每个项目 `load()`；`kernel.consistencyCheckEvery` 开关。

#### P1.5 ✅ EventBus

- 文件：`host/kernel/bus.js`。

#### P1.6 Trace 层

- ✅ `host/kernel/trace.js`：label、digest、TraceRef、环境 cause、因果链回溯。
- 待做：
  1. `activations` 表和 `activation.open/close` mutation；事件 `activation/started`、`activation/finished`、`activation/failed`。
  2. 现有三类 LLM 调用先接入（不改行为）：`orchestrator.runRole`（advisor / scheduler）、`gc.run`、Copilot。每次调用开一条 activation 记录，`sessionId` 指向 DSH 会话，`inputDigest` 是渲染后 prompt 的摘要；label 改为 `sessionLabel(...)` 规范（旧 label `mirl-<role>…` 在 activation 记录中保留为 `legacyLabel`）。
  3. `trace_explain` 服务方法与 HTTP / MCP 只读接口。
- 测试：一次 cycle 之后，`trace_explain(新节点)` 能回溯到 advisor 的 activation 和 DSH 会话 id。

#### P1.7 迁移所有写者（零行为变化）

- 目标：G1。这是 P1 工作量最大的部分。
- 顺序（从简单到复杂，每个文件一个提交）：
  - **P1.7a** `reconcile.js`（6 处写入）：启动修复；actor `{kind:'system', id:'reconcile'}`；顺带增加"清理残留 claim"（planned 且有 claim 的节点 → `node.releaseClaim` + 释放租约）。
  - **P1.7b** `auto.js`（2 处，含锁外 `saveEvent`，K3）：自动挡状态写入改为 `project.update` + `event.record`。
  - **P1.7c** `gc.js`（5 处，含锁外 `appendEvent`，K3）。
  - **P1.7d** `orchestrator.js`（20 处，含锁外 `persistEvent`，K3）：提案、建子节点、封存、批准 / 拒绝、run 记录、cycle 记录。`createChild` 改为在一次 commit 里同时 `node.create` 子节点和 `node.update` 父节点（原子化）。
  - **P1.7e** `runtime.js`（`persistNode` 和 3 处直接写入）：`persistNode` 改为调用 `executor.commitLocked` 的薄包装，再逐个调用点改成显式 mutation。
  - **P1.7f** `lab-service.js`（28 处）：项目 CRUD、节点编辑、dashboard、Copilot。
- 规则：
  1. 旧事件名和 `data` 字段保持不变（用 `eventType` / `eventData` 覆盖）。
  2. 旧代码中 `project.revision += 1` 的手工自增全部删除，由 Executor 统一推进。
  3. 调用方已持有 `withProjectLock` 时用 `commitLocked`，不要嵌套 `commit`（会死锁）。
  4. 每迁移一个文件，运行模拟器 S14（遗留对等）确认事件类型序列不变。
- 最后一步 **P1.7g**：`host/kernel/write-guard.js`，用 AsyncLocalStorage 标记"处于 Executor 内"，包装 store 的 `saveNode/saveProject/appendEvent/deleteNode/saveRun/saveCycle/deleteProject`；`kernel.strictWrites=throw` 时在标记外调用即抛错。
- 验收：`strictWrites=throw` 下全部测试和模拟场景通过；`grep -n "store\.\(save\|appendEvent\|delete\)" host/*.js` 只剩 `kernel/` 内的调用。

#### P1.8 读路径改走 Projection（K4）

- 29 处 `listNodes` 调用逐个改为 Projection 查询（`runnable`、`listByStatus`、`children` 等）。`store.listNodes` 保留，但只用于 `projection.load`。
- 热路径优先：`auto.tickOne`、`runtime.pumpLeases`、`runtime.runningNodes`（`ensureCapacity`）、`snapshot.*`、`getState`。
- 验收：模拟器 S2（5,000 节点 × 10 项目）中 tick 的 CPU 时间下降一个数量级以上；`checkConsistency` 始终为空。

#### P1.9 增量状态接口（K5）

- `getState(projectId, sinceRevision)` 改为：`sinceRevision` 等于当前 revision → `{unchanged:true}`（保持现状）；小于当前 revision 且在快照窗口内 → `{revision, changed:[节点], removed:[id], events:[…]}`；否则全量。
- 新增 `GET /projects/:id/events/watch?after=&timeoutMs=`（长轮询，基于 `bus.waitForEvents`），以及 SSE 变体。
- `client.js`：轮询改为长轮询；本地维护节点 Map，按增量合并。
- 验收：2,000 节点项目，UI 稳态带宽 < 10 KB/s；节点变化在 UI 上 1 秒内可见。

#### P1.10 Domain v2 迁移

- 按 §8.3 实现；`scripts/export-domain.mjs`、`scripts/import-domain.mjs`。
- 验收：用一份真实 v1 数据的导出副本做迁移，迁移后启动、`checkConsistency` 为空、UI 正常；回滚（导入备份）后 v1 代码正常启动。

**P1 验收**：§11.3 不变式 I1–I3、I8、I16 在所有场景通过；S2 性能达标；S5（随机崩溃点）恢复后不变式成立；S14 遗留对等通过。

---

### P2 · Policy 与接入面统一

#### P2.1 Command 模型

- 文件：`host/kernel/commands.js`；改 `host/http.js`、`host/mcp.js`、`host/agent-tool.js`、`lab-service.agentTool`。
- 步骤：定义 action 目录（现有 49 个 agent-tool action + HTTP 路由 + MCP 工具去重后的并集），每个 action 声明 `{irreversibility: L0..L3, target, payloadSchema(zod), handler}`；三个接入面都改成"构造 Command → `policy.authorize` → handler（handler 内部调用 Executor）"。
- 测试：每个 action 至少一个成功路径和一个失败路径。

#### P2.2 Policy 与能力表（K6，B1）

- 文件：`host/kernel/policy.js`。
- 不可逆等级：

  | 等级 | 例子 | 要求 |
  |---|---|---|
  | L0 | 读 | 任何已认证 actor |
  | L1 | 建 planned 节点、改优先级、defer planned、写笔记本 | 能力表允许 |
  | L2 | 取消 planned、复活、跨分区改优先级、批准提案 | 能力表允许 + 至少 1 条已验证证据（专家） |
  | L3 | 取消 running、删除、GC worktree、合并、抢占 | 人类，或 arbiter + 至少 2 条已验证证据 + 否决窗口 |

- 能力表（默认拒绝）：

  | actor | 允许 |
  |---|---|
  | `human`（UI） | 全部 |
  | `human`（L1 主会话 / Copilot） | 全部 L0–L2；L3 需要 UI 确认 |
  | `mcp:read` | L0 |
  | `mcp:control` | 按 token 绑定的 action 白名单 |
  | `expert:explorer` | L0；意图：`create`、`defer:own`、`set_priority:scope`、`ledger`、`claim`、`escalate`、`dispute` |
  | `expert:curator` | L0；意图：`defer`、`mark_redundant`、`ledger` |
  | `expert:arbiter` | L0；意图：全部；对 L3 只能"确认 / 否决" |
  | `expert:postmortem` | L0；意图：`ledger`、`create`（重试建议）、GC 建议 |
  | `dispatcher:*` | 只能经安全包络：`dispatch.start`、`dispatch.defer`、`dispatch.release`；`dispatch.preempt` 需 `cluster.preemption.enabled` |
  | `system` | 全部（仅内核内部） |

- `metainfer_lab` 全局工具：保留给人类会话；Lab 自己创建的 agent（worker、专家、策略）改为在 `setup` 中注册作用域工具（依赖 spike S2），并在 Policy 里按调用会话的 preset 拒绝越权调用，返回 `forbidden_action`。
- 测试：用 lab-worker preset 调 `cancel_node` → `forbidden_action`；专家调 `node.cancel` → `forbidden_action`。

#### P2.3 MCP 拆分与写能力

- read 与 control 两个端点；control 必须带 token，写请求必须带 `idempotencyKey`；新增 `watch_events`（长轮询）、`get_overview`（项目摘要：状态计数、运行中、排队与预留、最近事件）、`trace_explain`。
- 测试：重复的 `idempotencyKey` 返回第一次结果且不重复写。

#### P2.4 actor 全覆盖

- 每条事件都有 `actor`；遗留路径用 `legacy` actor，P4 结束时 `legacy` 计数为 0（模拟器统计）。

**P2 验收**：越权测试全部返回 `forbidden_action`；MCP 写入幂等；所有事件带 actor。

---

### P3 · Dispatcher

#### P3.1 ✅ 契约与安全包络

- 文件：`host/dispatch/types.js`、`host/dispatch/envelope.js`。

#### P3.2 ✅ LocalPoolBroker

- 文件：`host/dispatch/brokers.js`。
- 待补：启动时用 Projection 中 running 节点的 `lease`（broker 为 `local-pool`）调用 `adopt()` 重建内存账本。

#### P3.3 ✅ ClusterBroker（适配器）

- 待补（随 P3.7）：coordinator 提供 `/v1/verify` 后改用服务端校验；提供推送后实现 `watch`。

#### P3.4 ✅ DeterministicStrategy

- 待补：`usageBySource` 接入真实统计（按 `priority.by` 汇总已完成和运行中节点的 GPU 秒，来源于事件或 coordinator 的 `accountUsage`）。

#### P3.5 ✅ Dispatcher 宿主（生效 / 影子 / 回退）

#### P3.6 接入运行路径（切换）

- 目标：Dispatcher 成为唯一的启动路径。
- 步骤：
  1. `runtime.start(projectId, nodeId, {dispatchLease, decisionId})`：带 `dispatchLease` 时跳过项目 GPU 配额检查、`ensureCapacity` 和 `cluster.acquire`，直接把租约写入 `node.lease`（字段沿用现有形状：`leaseId/machineId/deviceIds/pool/expiresAt/renewedAt`，新增 `broker/hardEndAt/machines`）。不带时保持旧行为（兼容开关关闭时使用）。
  2. 在 `index.js` 为每个项目创建 Dispatcher（项目创建 / 删除时增删），`launcher = { start: (p, n, {lease, decisionId}) => runtime.start(p, n, {dispatchLease: lease, decisionId}) }`。
  3. `LegacyLlmStrategy`（`host/dispatch/legacy-llm-strategy.js`）：被 `dispatch/*`、`node/*` 事件唤醒（去抖 5 s），调用现有 scheduler 角色（经 P1.6 的 activation 记录），把输出的 starts 逐个转为"acquire → submit"。这是旧 `dispatch.mode: llm` 的等价物，也是第一个 agent 型策略。
  4. `orchestrator.applySchedulerOutput` 不再直接调用 `runtime.start`；`auto.tickOne` 在 `dispatch.strategy ≠ legacy-llm` 时不再跑 scheduler pass（K18）。
  5. `runtime.pumpLeases` 删除"申请"分支，只保留"已授予未启动"的恢复分支，并把它移到 Dispatcher 的启动对账里（P1.7a 的 claim 清理一起做）。
  6. 人建节点默认 `priority.class = 'p0'`（B5）：`lab-service` 建节点时设置；p0 节点不经任何 LLM。
- 不变式：I4、I5、I11、I12、I15。
- 测试：模拟器 S1、S6、S7、S8；p0 节点从提交到启动 < 1 s（本地池、有空闲容量时）。

#### P3.7 coordinator：硬结束时间、推送、校验（K12、K13）

- 文件：`host/cluster.js`（服务端部分）、`host/dispatch/brokers.js`。
- 步骤：
  1. `/v1/acquire` 接受 `walltimeMs` 和 `shapes`；签发时写 `hardEndAt = grantedAt + walltimeMs`；`/v1/renew` 只推后 `expiresAt`，不允许超过 `hardEndAt + grace`（grace 默认 120 s）。
  2. `/v1/extend {leaseId, extraMs, reason}`：显式延长，重新经过规划（P3.5 之后检查是否与预留冲突），返回 `extended | denied`。
  3. `/v1/verify {leaseId, holderId, projectId, nodeId}` → `{valid}`。
  4. `/v1/watch?holderId=&after=`：长轮询推送 `granted`、`reserved`、`reservation_moved`、`imminent`、`revoked`、`preempt_requested`；事件存在 coordinator 的追加日志里（P3.5.1）。
  5. `ClusterBroker.watch` 消费推送；收到 `granted` 后立即唤醒策略（不再等 2 秒轮询）。
  6. 兼容：老版本 Lab 不传 `walltimeMs` 时 `hardEndAt = null`，规划器把它视为"结束时间未知"（无法据此预留，见规划器测试）。
- 测试：续约不能越过 `hardEndAt + grace`；`verify` 拒绝别人的租约；授予到启动 < 3 s（模拟）。

#### P3.8 节点优先级字段落地

- 迁移时补默认值（§8.3）；UI 显示 class；人类可在 UI 改 class（L1）。

**P3 验收**：S1、S6、S7、S8 通过；I4、I5、I11、I12、I15 成立；`dispatch.strategy=legacy-llm` 时行为与旧版一致（S14）。

---

### P3.5 · 中心资源管理器（多机任务）

背景：现有 `planFleetAllocation` 已经是全有或全无的原子分配，但只看"此刻空闲"的卡，`dispatchQueue` 贪心分配导致多机任务被饿死（K11，模拟已证实）。本阶段把 coordinator 改成四段流水线：

```
请求 ─► ① 准入 ─► ② 定序（P7 起可争论）─► ③ 规划（时间线：预留 + 回填）─► ④ 原子签发 ─► 推送
触发：请求到达 / 释放 / 过期 / 机器上下线 / 轮次结束 / 定时兜底（30 s）
```

#### P3.5.1 coordinator 内部重构与日志式持久化（K14）

- 文件：新建 `host/coordinator/state.js`、`host/coordinator/server.js`；`host/cluster.js` 保留门面和 `createClusterAdmin`，服务端逻辑移入 `coordinator/`。
- 步骤：
  1. 状态变更改为追加写日志 `<stateFile>.journal.jsonl`（每行 `{seq, at, op, data}`），每 1,000 条或每 10 分钟写一次快照 `<stateFile>`，启动时快照 + 日志重放。
  2. `cluster.js` 中的放置逻辑（`machineCandidateList`、`allocateFromCandidates`、`planFleetAllocation`）改为调用 `coordinator/gang-planner.js`，**只保留一条放置路径**（CLAUDE.md 的单一路径原则）。`planFleetAllocation` 的偏好排序（`prefer`、`preferColocate`）移进规划器（规划器目前只实现了硬约束和 best-fit，偏好在这一步补上，补的时候加测试）。
- 测试：现有 `cluster-fleet-selftest`、`placement-selftest` 全部保持通过；崩溃重放后状态一致。

#### P3.5.2 ✅ 多形状与约束放置

- 文件：`host/coordinator/gang-planner.js`（`requestShapes`、`placeShape`）。
- 已实现：多形状按偏好顺序尝试；约束 `machineIds / excludeMachineIds / machineLabels / gpuModels / colocate`；best-fit（优先放在空闲卡最少但够用的机器上，把整机留给多机任务）。
- 待补：`excludeMachineLabels`、`excludeGpuModels`、`prefer`、`preferColocate`（与 `cluster.js` 现有 `sanitizeConstraints` 的字段对齐）。

#### P3.5.3 ✅ 时间线

- 已实现：运行中租约按 `hardEndAt` 占用设备；没有 `hardEndAt` 的租约视为无限占用（不猜测）；离线机器整体排除。

#### P3.5.4 ✅（规划器）/ 待接入：EASY 预留与回填

- 已实现（纯函数 `planSchedule`）：`mode = greedy | easy | conservative`；`reserveDepth`；回填只允许"在预留开始前必定结束"或"完全不碰预留设备"的请求；`validatePlan` 检查无重叠、无部分签发、无离线机器。
- 待做（接入 coordinator）：
  1. `dispatchQueue()` 改为调用 `planSchedule`（模式取 `cluster.planner.mode`）；`grants` 立即签发，`reservations` 写入 `state.reservations`。
  2. `/v1/acquire` 对有预留的请求返回 `{status:'reserved', reservationId, startAt}`；`/v1/reservations` 只读列表。
  3. 重新规划的触发点：acquire、release、reapExpired、register / 机器上下线、extend、定时 30 s。
  4. 预留稳定性：同一请求的新预留开始时间**不得晚于**上一次，除非原因是机器掉线或某租约 `extend`；违反时记 `reservation_slipped` 并计数 `slips`（不变式 I13）。
  5. 每次签发前在调试模式运行 `validatePlan`，失败则拒绝签发并告警（不变式 I6、I7）。
- 测试：模拟器 S9（已有）、S10、S11；`npm run sim:gang` 在 5 个种子上 EASY 和保守模式都满足饿死上限。

#### P3.5.5 排空与预准备

- 被预留的机器在 `startAt` 前只接受能按时结束的任务（规划器已保证）。
- `startAt - prestageLeadMs`（默认 5 分钟）时，coordinator 向持有方推送 `imminent`；Lab 收到后调用 `runtime.prepareLaunch`（新：拆出 worktree、anchor 会话、`prepareRemoteRun` 打包，不占 GPU），缩短签发后的空占时间。
- 测试：签发到 worker 实际开始的时间在多机任务上 < 60 s（模拟，假 remote-run）。

#### P3.5.6 保守回填与预留老化

- `reserveDepth > 1` 或 `conservative`；对等待超过 `agingAfterMs` 的请求提高排序（防止低优先级永远拿不到预留）。
- 指标：每个请求的"实际开始 − 第一次预留时间"分布。

#### P3.5.7 显式占卡（可选，默认关闭）

- 请求声明 `holdIdle.allowed=true` 时，coordinator 可以先锁住已空出的卡等待其余部分；占卡期间计"预留空闲 GPU 秒"，记在请求所属项目账上；超过 `maxReservedIdleMs` 全部释放、回到队列。
- 防死锁：同一时刻只允许一个请求处于占卡状态（每个机器组），占卡请求必须是排序第一。
- 测试：两个占卡请求互相等待的场景不会死锁（第二个不会进入占卡状态）。

#### P3.5.8 多机故障处理

- 运行中任一机器掉线：coordinator 撤销整个租约（推送 `revoked`），Lab 以 `terminate(kind:'resource_lost')` 结束节点，释放其余机器，立即重新规划。
- 测试：模拟器 S10。

#### P3.5.9 抢占（`cluster.preemption.enabled`，默认关闭）

- 只对 `preemptible` 的租约；需要 Policy 授权（p0 或经争论协议）；给被抢占方宽限期（默认 120 s）；Lab 实现 `launcher.preempt` → `runtime.terminate(kind:'preempted')`；`checkpointable` 的节点保存检查点后重新排队（节点回到 planned，`attempt` 不增加），否则按失败处理、允许重试。
- 计入被抢占项目的额度补偿。

#### P3.5.10 Lab 侧

- `node.needs` 扩展 `shapes`；`placementConstraints` 字段；`walltimeMs = timeboxMs`。
- `resourceWait` 显示预留信息（预计开始、阻塞原因）；UI 节点检查器和 overview 可见。
- Dispatcher 不因某个节点在等预留而停止派发其他节点（DeterministicStrategy 已经这样做）。
- 专家通过 `resource_status` 工具看到资源侧事实，可以据此提交"改为单机版本 / 拆分"的意图。

**P3.5 验收**：S9、S10、S11 通过；I6、I7、I13、I14 成立；`cluster.planner.mode=greedy` 时行为与旧版一致。

---

### P4 · 专家运行时与导航 API

#### P4.1 专家注册表

- 文件：`host/experts/registry.js`、`host/experts/builtin.js`。
- 生命周期：`hire`（创建描述符 + 身份会话 + 空笔记本）、`drain`（不再接新票据，完成当前激活）、`retire`、`handover`（把作用域与未完成票据转给另一个专家，笔记本复制一份只读引用）。
- 兼容：`config.advisor.reviewers[]` 自动转换为 `legacy-lens` 类型的描述符。
- 预算账本：每个专家一个令牌桶（`tokensPerHour`），激活结束时按 `usage` 扣减；超预算时票据推迟。

#### P4.2 激活执行器

- 文件：`host/experts/runner.js`。
- 一次激活：
  1. 从唤醒队列取票据（遵守 `maxConcurrent` 和预算）。
  2. `activation.open`：记录 `basisRevision`、`cursorFrom = notebook.lastSeenSeq`、`cursorTo = 当前 maxEventSeq`。
  3. 组装输入：persona + 职责 + 笔记本 + `dag_diff(cursorFrom..cursorTo)`（有上限，超出部分只给计数）+ 作用域地图（`dag_map` 的前 N 行）+ 预算说明。计算 `inputDigest`。
  4. 创建会话（按 spike S2 结论）：父会话是专家身份会话，label 为 `sessionLabel({projectId, actorKind:'expert', actorId, activationId})`，挂作用域工具（§7.9）。
  5. 预算强制：工具调用次数到 `queriesPerActivation` 后导航工具返回 `budget_exhausted`；`wallClockMs` 到期中止激活（`activation/failed`，reason `timeout`）。
  6. 结束：`activation.close`（usage 来自 `sessionUsage`，`intentIds`，`toolCalls`）；成功时把 `notebook.lastSeenSeq` 推进到 `cursorTo`，失败时不推进（下次重看）。
- 删除 run 记录里的 `inputSnapshot`（K9）：旧 run 记录保留，新的只有 `activationId`。
- 测试：一次激活产生完整的三层轨迹；中止时不推进游标；预算耗尽时返回明确错误。

#### P4.3 导航工具

- 文件：`host/experts/nav-tools.js`；全部基于 Projection；按 §7.9 实现。
- 输出大小上限：每个工具结果 ≤ 8 KB，超出用 `_truncated` 分页。
- 测试：在 S2 的 5,000 节点项目上，每个工具 p99 < 50 ms。

#### P4.4 笔记本

- 文件：`host/experts/notebook.js`；`notebook.patch` mutation；事件 `notebook/updated`（带 diff，便于追溯"专家什么时候形成了什么判断"）。
- 限制：50 条、16 KB；超限时拒绝并提示专家合并条目。

#### P4.5 触发引擎（K8）

- 文件：`host/kernel/triggers.js`。
- 先修 K8：`runtime.onSessionEvent` 对 worker 会话的任何事件更新 `lastActivityAt`（节流：同一节点 30 s 最多写一次，用 `node.update`，事件类型 `node/activity`，**不**进入 UI 活动日志）。
- 规则（每条规则产生 `trigger/fired` 事件和唤醒票据）：

  | 规则 | 条件 | 唤醒 |
  |---|---|---|
  | `lowWater` | 可运行节点的 timebox 总和 < 规划延迟 p90 × 安全系数（默认 1.5），且没有规划中的激活 | 负责相关分区的 explorer |
  | `nodeTerminal` | 作用域内节点完成 / 失败 | 该分区 explorer（去抖 60 s，合并） |
  | `stall` | running 节点 `lastActivityAt` 超过阈值 | postmortem（或 explorer） |
  | `coverage` | 已完成且未被审查的叶子超过 N 分钟没有 review claim | 该分区 explorer |
  | `duplicateCandidates` | 新增 LSH 候选对 ≥ K，或距上次 curator 激活超过最大间隔 | curator |
  | `predictionError` | 节点完成后 `expected` 与实际偏差超过阈值 | 提案专家（复盘票据） |
  | `escalation` | 意图带合法 reasonCode 的 `escalate` | arbiter |
  | `interval` | 兼容旧 cycle | legacy-lens 专家 |
  | `humanAsk` | UI 中人类 @ 某专家 | 该专家 |

- 合并与去抖：同一专家的排队票据合并理由；风暴（8 个节点同时完成）只产生 1 个票据。
- 探索深度与空余度成反比（Q7）：`backlogDepth > 4` 时 `queriesPerActivation = 6`，否则 1；`wallClockMs` 同理。
- 测试：S4（完成风暴）只产生 1 次激活；低水位在队列耗尽前触发。

#### P4.6 兼容层与 K7 修复

- `experts.mode = legacy-cycle`：原 advisor 评审团的每个 lens 成为一个 `legacy-lens` 专家（scope 全图，trigger `interval`），产出转换为 `create` 意图；行为与旧 cycle 等价（S14）。
- K7：删除提示里的 "prefer 1"；上限改为**每个专家**的 `maxProposalsPerActivation`，而不是整个评审团共用；GPU 空闲且没有新叶子时由 `lowWater` 触发规划。
- K16：删除 `snapshot.reportSummary`。K17：`createChild` 记录 `createdBy = {actor, activationId}`。
- 测试：S14 遗留对等；S1 中并发度（时间加权平均）相对基线提升。

#### P4.7 GC → postmortem 专家（K15）

- 原 `gc.js` 改为 `postmortem` 类型专家，由 `nodeTerminal`（失败 / 超时）和 `stall` 触发；输出意图（`ledger`、重试建议、清理建议）。
- 修 `presets.patch.yml`：删除不存在的 `lab_cleanup` 引用，改为 postmortem 的作用域工具。

#### P4.8 agent 型派发策略复用运行时

- `LegacyLlmStrategy` 和将来的 agent 策略用同一个 runner：身份会话 `dispatcher:<strategyId>`，每次决策一个激活子会话；工具：`dispatch_view`、`resource_status`、`submit_decision`（经安全包络）。

#### P4.9 Codex 轨迹收敛（K10）

- 按 spike S3 结论：能创建 DSH 会话 → 把 `ExecutionLog` 镜像成 DSH 会话，`TraceRef` 只剩 `dsh-session`；不能 → 保留 `execution-log` 类型的 `TraceRef`，并在 activation 记录里登记，`trace_explain` 两种都能展示。

#### P4.10 trace_explain 全覆盖

- 测试：对模拟器中随机抽取的 100 个 `node/started` 事件，`trace_explain` 都能回溯到触发事件，且链上每个 LLM 环节都有 `sessionId`（不变式 I9、I10）。

**P4 验收**：S1、S3、S4、S14 通过；I9、I10 成立；单次激活输入 token 相对旧 advisor 快照下降（记录对比）；`legacy` actor 计数为 0。

---

### P5 · 意图流水线、分区与组织

#### P5.1 IntentLog 与审查租约

- 文件：`host/kernel/intents.js`。
- 流水线（串行，每项目一个队列）：Policy → 陈旧判定（basis 落后且目标已变 → `rejected:stale`，并给提交者发唤醒票据"重读后重判"）→ Verifier（P6 前为空实现）→ 冲突矩阵（P5.2）→ commit → `intent/applied`。
- 意图 TTL 到期 → `intent/expired`；专家可撤回 → `intent/withdrawn`。
- 审查租约（claim）：`claim.acquire {nodeId, intent:'review'|'propose', ttlMs ≤ 10 min}`；同一节点同时只有一个 review claim；TTL 到期自动释放（代码，不经 agent）。

#### P5.2 冲突矩阵（Q12，写成代码）

文件：`host/kernel/conflicts.js`。

| # | 冲突 | 规则 |
|---|---|---|
| 1 | create 与 defer（同父） | 在 X 上成功建子节点 = 投票"X 还活着"，X 上 pending 的 defer 提名自动撤回（`nomination/withdrawn {reason:'child_created'}`）。投票计权：子节点通过查重、专家预算未超才计；同一专家对同一节点只算一票（C8） |
| 2 | defer 已生效后建子节点 | 拒绝，返回"父节点已 deferred，需要 `resurrect`（带理由）" |
| 3 | defer 与 start | 单写者串行，先到先赢；已启动的不能 defer，转为 cancel 建议（L3） |
| 4 | create 与 create（同父） | 先到者的 claim 可见；同父同 `promptHash` 拒绝；语义重复留给 curator |
| 5 | defer 与 defer（同节点） | 幂等合并，保留最早的理由 |
| 6 | claim 过期 | TTL 自动释放 |
| 7 | defer / restore 反复 | 同节点超过 2 次 → 强制升级到 arbiter |
| 8 | 新子节点后的保护期 | 节点有新子节点后 10 分钟内不可被 defer |

- 测试：每条规则一个场景测试；S3 中无死锁、无反复抖动。

#### P5.3 优先级类别、deferred 与归档

- `deferred` 是 priority class（B6），只有 planned 节点可以被 defer（B7，无级联）。
- deferred 超过 `deferredTtl`（默认 7 天）→ `node.archive`（`archivedAt`），从 Projection 热索引移出，地图上只显示聚合计数；`maxNodes` 只统计热节点，另设 `maxDeferred` 与归档配额（C1）。
- `restore` / `resurrect` 意图恢复。

#### P5.4 标签与相似度召回

- 文件：`host/experts/similarity.js`。
- 节点 `tags {hypothesis, lever, variant}`（B18）由提案专家填写；Projection 建 tag 精确索引。
- prompt shingle（5 个 token）MinHash（64 个哈希，16 band × 4 行）LSH，增量维护在 Projection 中；`similarCandidates(nodeId)` 返回 Jaccard 估计值 ≥ 0.6 的候选。
- 验收：在人工标注的 30 组样本上记录精度 / 召回（附录 A.6 方法）；5,000 节点上新增节点的召回 < 5 ms。

#### P5.5 分区器

- 文件：`host/experts/partitioner.js`。
- 分支 = 根节点的子树（或被标记为分支根的节点子树）；按活跃叶子数把分支分给 explorer；负载比超过 1.5 时再平衡（`expert/handover` 事件）；新分支自动分配；专家 retire 时其分支转交。
- 可选 lead 专家：负责一组分区之间的预算分配（输出 `set_priority:scope-group` 意图）。

#### P5.6 Curator

- 单例，只读 + 只提名（B19）。候选来自 tag 索引与 LSH。
- 约束：年轻节点（< 10 分钟）不提名；单次激活最多 5 个提名；有 pending claim 或正在审查的节点不提名；`falseCloseRate > 20%`（被撤回或被复活的提名比例，Wilson 下界）→ 熔断降权并升级。
- 按状态区别处理：planned → defer；completed → `mark_redundant`（`redundantOf`）；running → 只能提 cancel 建议（L3）。

#### P5.7 Arbiter

- 只接收触发码路由过来的例外；其他专家看不到它，不能"找它批准"（C2）。
- 乐观提交 + 否决窗口（默认 10 分钟）：L2 跨分区动作先生效，arbiter 可在窗口内否决（补偿 commit）。
- 每个专家每个 epoch 有升级配额；监控升级率（升级数 / 意图数），超过阈值告警并收紧触发码。

#### P5.8 专家库 UI

- 在职列表、描述符、预算消耗、绩效（P6.5）、hire / drain / retire 操作（L2，人类）。

**P5 验收**：S3、S13 通过；冲突矩阵测试全部通过；重复率指标可见。

---

### P6 · 校验与纠偏

#### P6.1 Verifier

- 谓词库：`exists(nodeId)`、`status(nodeId) = X`、`metric(nodeId, name) op value`、`report_has(nodeId, field)`、`report_contains(nodeId, field, text)`、`ledger(hypothesisId) = state`、`child_count(nodeId) op n`。
- 提交时同步校验；无法表达为谓词的 claim 标记 `infer`，允许提交但不计入证据（C6）。
- 按不可逆等级要求最少的已验证证据（B27）：L2 ≥ 1，L3 ≥ 2。
- `citationErrorRate` 用 Wilson 下界，并按"已验证证据数"加权，防止"少给 claim"刷低分母（C7）。

#### P6.2 台账（ledger）

- 假设台账 `{hypothesisId, statement, state: open|supported|ruledOut, evidence[], updatedBy}`；只能通过 `ledger` 意图修改，且必须带证据。

#### P6.3 预测误差复盘

- 提案时填 `expected {metric, direction, magnitude}`；节点完成后比较；偏差超阈值生成复盘票据给提案专家；结果计入专家校准度。

#### P6.4 争议（dispute）

- 表 `disputes`（Q13 的结构）；类型 → 裁决者映射（陈旧 → 代码；事实 → 代码查台账，再到 arbiter；资源量 → CFS；资源质 / 价值 → arbiter 或人；优先级倒挂 → 人）；超时默认"保持现状"；已裁决后申诉必须带新证据；每个 dispute 消耗预算并计入绩效。

#### P6.5 专家绩效

- 不看采纳率（C13），看：归因到该专家的最佳指标提升、台账确认 / 否定条数、预测校准度、被判重复率（`dupRateByExpert`）、`disputesRaised` 与 `disputesWon`。
- 轮换：同一专家在同一分区超过 N 天 → 确定性轮换。

#### P6.6 headline

- 报告 schema 新增 `headline`（≤ 300 字符），`summary` 不截断（D16）；导航工具的索引行用 `headline`。

**P6 验收**：谓词校验覆盖率（已验证 claim / 全部 claim）可统计；争议有超时默认；绩效面板可读。

---

### P7 · 签发前争论与跨机器派发

前提：P3.5 已上线，`contest.mode=off` 下系统完整可用。本阶段每一步先在 `shadow` 模式下验证：轮次照开、协议照算，但仍按默认规则签发，记录两者差异。

#### P7.1 轮次状态机与硬规则校验器（确定性）

- 文件：`host/coordinator/rounds.js`；轮次日志单独追加写 `rounds/<roundId>.jsonl`。
- 只在争用时开轮次：同一资源集合上需求超过供给，或有请求在等"即将释放"的卡；否则立即签发。
- 默认方案 = 规划器在当前顺序下的结果；deadline 到期或协议无效 → 采用默认方案。
- 硬规则：
  1. 不超发（含按时间预留的部分）；
  2. 每一方只能处置自己的请求；
  3. consensus 模式下所有受影响方签字（带 `holderId` 认证）；
  4. p0 保底；任何请求等待超过上限即强制服务；
  5. 争论窗口 = min(绝对上限, 预计作业时长 × 比例)；
  6. 协议中的 `maxDurationMs` 写进租约 `hardEndAt`；
  7. 额度记账；
  8. **空闲浪费上限**：协议导致的 `idleGpuHours` 不超过阈值；
  9. **预留不可反复推后**：同一预留最多被推后 N 次。
- 新接口：`/v1/acquire` 返回 `contested`；`GET /v1/rounds/:id`；`POST /v1/rounds/:id/messages`；`POST /v1/rounds/:id/agreement`；`GET /v1/rounds/watch?after=`。

#### P7.2 推演工具 `round_simulate`

- 基于 `planSchedule`（`preordered: true`）：输入一个提案（顺序、notBefore、形状让步、占卡），输出每个请求的预计开始 / 结束、相对默认方案的延迟、`idleGpuHours`、违反的硬规则。
- 协议提交后，coordinator 用同一个推演器再算一遍作为校验的一部分。

#### P7.3 consensus 模式与 agent 型策略

- 文件：`host/dispatch/agent-strategy-base.js`。
- 工具：`round_read`、`round_post`、`round_simulate`、`round_sign`。
- 消息：`claim {requestId, urgency{deadlineAt, waitingMs, humanP0}, justification, evidence[traceRef], bid{credits}}`、`offer {proposal}`、`counter`、`concede`、`agree`。
- 可争论：顺序与 `notBefore`、最长占用、部分满足、跨轮次交换、显式占卡与时长、时间片、抢占、形状让步。**具体设备不可争论**。
- 每次争论是 `dispatcher:<id>` 身份会话下的一个激活子会话（P4.8），全程可追溯。

#### P7.4 额度与履约统计

- 文件：`host/coordinator/credits.js`。项目级额度按速率补充；出价扣减；履约统计（声称紧急的请求实际多久开始用卡、协议承诺的释放是否兑现）影响补充速率，调解者可见。

#### P7.5 mediated 模式

- coordinator 侧中立调解 LLM（挂在 coordinator 所在 DSH 实例上），给出分配方案，同样经过硬规则校验。

#### P7.6 peer broker（跨信任域）

- `peer:<machine>` broker：对端 coordinator 签发租约，本端只认租约；线上协议参考 A2A（agent card + task 生命周期）；预留带 TTL；`budget.maxCommitGpuHours` 封顶。先在 shadow 模式评估。

**P7 验收**：S12 通过；shadow 模式下记录"协议方案 vs 默认方案"的差异分布；开启 consensus 后 I6、I7、I14 依然成立；无人回应的轮次在 deadline 后按默认签发。

---

## 11. 测试、模拟器与不变式

### 11.1 测试层次

| 层次 | 位置 | 运行 |
|---|---|---|
| 单元 / 组件自测 | `scripts/*-selftest.mjs` | `npm test`（每次提交） |
| 模拟场景 | `scripts/sim/scenarios/*.mjs` | `node scripts/sim/run.mjs --scenario <name> --seed <n>`（每个 WP 完成时跑相关场景，每阶段验收时跑全部 × 5 个种子） |
| 遗留对等 | S14 | 每个迁移类 WP |
| 真实环境冒烟 | 开发用 DSH Host | 每阶段验收（只读项目副本） |

### 11.2 场景目录

| # | 场景 | 主要检查 | 实现阶段 |
|---|---|---|---|
| S1 | 稳态：200 节点、4 GPU、3 个专家 | 并发度、GPU 空洞、启动延迟 | P0 |
| S2 | 规模：10 个项目 × 5,000 节点 | commit 延迟、投影内存、tick CPU、导航工具延迟 | P0 |
| S3 | 30 个并发专家提案（含 20% 重复） | 陈旧率、冲突规则、无抖动 | P5 |
| S4 | 完成风暴：8 个节点同一秒完成 | 唤醒合并、只有 1 次激活 | P4 |
| S5 | 随机崩溃点（每次写入后都可能崩溃） | `recover` 后 I1–I3、I8 | P0 / P1 |
| S6 | 运行中租约丢失 | 节点终止、租约释放、重新派发 | P0 / P3 |
| S7 | 慢 agent 策略（从不决定） | 回退生效、GPU 不空转 | P3 |
| S8 | 恶意策略（伪造 / 重用租约） | 安全包络全部拒绝 | P3 |
| S9 | 多机任务饿死（已实现 `gang-starvation.mjs`） | 饿死上限、利用率 | P3.5 |
| S10 | 多机任务运行中机器掉线 | 整体撤销、释放、重新规划 | P3.5 |
| S11 | 任务提前结束 | 预留只提前不推后 | P3.5 |
| S12 | 两个 Lab 争卡：一方不回应、协议超发、拖到 deadline | 硬规则、默认回退 | P7 |
| S13 | curator 误杀爆发 | 熔断、降权、升级 | P5 |
| S14 | 遗留对等：脚本化 LLM 输出下，新旧路径事件类型序列一致 | G10 | P1 起 |

### 11.3 不变式

| # | 不变式 |
|---|---|
| I1 | 每次状态变化都对应至少一条带 `actor` 的事件 |
| I2 | 每个项目的 `revision` 严格递增；事件 `revision` 单调不减 |
| I3 | 事件 `seq` 从 1 起连续（冷段 + 表合起来），已确认事件从不消失 |
| I4 | 同一节点同一次尝试最多一次 `dispatch/claimed` |
| I5 | 任何时刻每个 broker 下运行中节点占用的资源 ≤ 容量 |
| I6 | 任何时刻同一设备不在两个有效租约里 |
| I7 | 多机租约从不部分签发；签发的形状与请求的某个形状一致 |
| I8 | Projection 与存储一致（`checkConsistency` 为空） |
| I9 | 每次专家激活都有 activation 记录、`sessionId`、`inputDigest` |
| I10 | 每个 applied 意图都能链接到 `activationId`、`sessionId`、`toolCallId` |
| I11 | 每个 `dispatch/claimed` 都带 `decisionId` 和经过 `verify` 的 `leaseId` |
| I12 | deferred 节点从不被 claim |
| I13 | 预留开始时间不晚于上一次估计，除非原因是机器掉线或 extend |
| I14 | 多机任务的开始时间 ≤ 饿死上限（到达时刻 + 前方及运行中任务的最长剩余 walltime） |
| I15 | 有空闲容量时，p0 节点从提交到 claim < 1 s |
| I16 | Executor 之外没有写入（`strictWrites=throw`） |

---

## 12. 切换与回滚

| 阶段 | 切换方式 | 回滚 | 旧路径移除时间 |
|---|---|---|---|
| P1 | 写者逐文件迁移，无开关（零行为变化，由 S14 保证） | `git revert` 对应提交；数据兼容（只新增字段） | 迁移完成即移除 |
| P1.10 | 启动时自动迁移 | 用备份导入，回到旧版本代码 | — |
| P3 | `dispatch.strategy`：先 `legacy-llm` + `shadow=deterministic` 运行一周对比，再切 `deterministic` | 改回 `legacy-llm` | P4 验收后再保留一个版本 |
| P3.5 | `cluster.planner.mode`：先 `greedy`（与旧版相同），再 `easy` | 改回 `greedy` | 保留 `greedy` 作为对照模式（模拟器用） |
| P4 | `experts.mode`：新项目 `runtime`，旧项目手动切换 | 改回 `legacy-cycle` | P5 验收后再保留一个版本 |
| P7 | `contest.mode`：`off` → `shadow` → `consensus` | 改回 `off` | 不移除（`off` 是合法配置） |

---

## 13. 可观测性：事件目录与指标

### 13.1 事件目录

**保留的旧事件**（名字和 `data` 不变）：`project/created`、`project/edited`、`node/created`、`node/proposed`、`node/approved`、`node/rejected`、`node/edited`、`node/sealed`、`node/started`、`node/execution_started`、`node/completed`、`node/failed`、`node/cancelled`、`node/timeout`、`node/retried`、`node/resumed`、`node/escalated`、`node/model_changed`、`node/merge_prepared`、`node/merge_turn`、`node/remote_prepared`、`node/resource_waiting`、`node/resource_granted`、`node/resource_lost`、`run/started`、`run/completed`、`run/failed`、`run/cancelled`、`cycle/started`、`cycle/finished`、`auto/started`、`auto/stopped`、`auto/paused`、`auto/waiting`、`gc/finished`。

**新增**：

| 类别 | 事件 |
|---|---|
| 内核 | `kernel/noop`、`node/priority_changed`、`node/deleted`、`node/planned`、`node/activity`、`node/archived`、`node/restored` |
| 派发 | `dispatch/claimed`、`dispatch/claim_released`、`dispatch/start_failed`、`dispatch/held`、`dispatch/rejected`、`dispatch/released`、`dispatch/shadow_decided`、`dispatch/fallback`、`dispatch/preempting` |
| 资源 | `resource/reserved`、`resource/reservation_moved`、`resource/reservation_slipped`、`resource/imminent`、`resource/revoked`、`resource/extended` |
| 轨迹 | `activation/started`、`activation/finished`、`activation/failed` |
| 触发 | `trigger/fired`、`wake/queued`、`wake/dropped` |
| 意图 | `intent/submitted`、`intent/applied`、`intent/rejected`、`intent/withdrawn`、`intent/expired`、`intent/vetoed`、`nomination/withdrawn`、`claim/acquired`、`claim/released` |
| 专家 | `expert/hired`、`expert/draining`、`expert/retired`、`expert/handover`、`notebook/updated` |
| 纠偏 | `ledger/updated`、`dispute/opened`、`dispute/resolved`、`retro/opened` |
| 争论 | `dispatch/round_opened`、`dispatch/round_message`、`dispatch/round_agreement`、`dispatch/round_default`（Lab 侧，带 `roundId` 和轮次日志 seq） |

### 13.2 指标

| 指标 | 定义 | 目标 / 用途 |
|---|---|---|
| 时间加权平均并发 | ∑(running 节点数 × 时长) / 总时长 | 相对基线提升 |
| GPU 空洞时长 | 有可运行节点且有空闲容量的时长 | 趋近 0 |
| 派发延迟 | runnable → claimed | 本地 < 1 s，集群 < 3 s |
| commit 延迟 | p50 / p99 | p99 < 20 ms |
| 激活成本 | 每次激活的输入 / 输出 token | 相对旧快照下降 |
| 意图结果分布 | applied / rejected（按 code）/ expired | 陈旧率 < 10% |
| 重复率 | 被标 redundant 的节点比例；`dupRateByExpert` | 下降 |
| `falseCloseRate` | curator 提名被撤回 / 复活的比例 | < 20% |
| 升级率 | 升级数 / 意图数 | 监控 |
| 多机等待 | 实际开始 − 到达；与上限之比 | ≤ 1 |
| 预留推后次数 | 每个预留的 `slips` | 0（除机器故障） |
| 预留空闲 GPU 小时 | 排空和占卡导致的空闲 | 监控，受上限约束 |
| 争论结果 | 轮次数、协议率、回退率、协议相对默认方案的收益 | P7 评估 |
| 单位 GPU 小时产出 | 每 GPU 小时完成的节点数、指标提升 | 归一化评估（C12） |

---

## 14. 风险与 spike 结论的分支处理

| 风险 / spike | 如果结论是…… | 处理 |
|---|---|---|
| S1：storageDomain `put` 不保证顺序落盘 | `recover()` 依赖"事件先于记录落盘" | 改为每次 commit 写一条"commit 记录"（单 key，包含全部 effects），记录写完后再写各表；恢复时以 commit 记录为准。Executor 接口不变 |
| S1：单条记录大小有上限 | 大节点（报告）或大 effects 超限 | `node.put` effects 里的大字段（`report`、`prompt`）改为引用（`{ref:'node', rev}`），恢复时从节点记录取 |
| S2：激活无法注入工具 | 专家没有作用域工具 | 用 `agents.create({setup})` 创建子会话 + `subagent/catalog` 维持会话树（Copilot 的做法） |
| S2：工具处理函数拿不到调用会话 | Policy 无法区分调用者 | 每个 Lab 创建的 agent 只注册自己的作用域工具；全局 `metainfer_lab` 改为仅在人类会话 preset 中可见（`presets.patch.yml` 的工具白名单） |
| S3：DSH 会清理旧会话且不能标记保留 | 轨迹会丢，违反 D2 的前提 | 在 DSH 清理之前由插件把会话归档到 `~/.dsh/metainfer-research-lab/trace-archive/`（原始 `session.v4.jsonl.zstd` 复制，加 sha256），`TraceRef` 增加 `archived` 字段；需要负责人确认（D15） |
| S3：插件不能创建 DSH 会话 | Codex 轨迹无法收敛 | 保留 `execution-log` 类型的 `TraceRef`（P4.9 已有分支） |
| S4：domain 不能就地升级 | 需要新 domain | §8.3 第 2 步的复制迁移 |
| 迁移期双写者 | P1.7 期间新旧写入交错 | 同一文件内一次性迁移完；`strictWrites=warn` 记录残留写入；S14 每个提交都跑 |
| 专家成本失控 | 多专家 + 多轮查询 | 令牌桶、`queriesPerActivation`、全局规划预算（按实验 GPU 小时的 X% 折算），超预算时票据推迟而不是丢弃 |
| 争论被"会说的一方"主导 | LLM 被更笃定的陈述说服 | 代价信号（额度）、事后问责（履约统计）、证据可追溯（traceRef）、deadline 后确定性默认 |
| 规划器估计错误 | 任务提前结束或 walltime 太保守 | 提前结束触发重规划（预留只会提前）；walltime 由 watchdog 强制，不会更晚 |

---

## 15. 完工定义

全部满足才算完成：

1. 所有 WP 在 PROGRESS.md 中为 done，偏差均有说明。
2. `npm test` 全部通过；模拟场景 S1–S14 在 5 个种子上全部通过，不变式 I1–I16 全部成立。
3. §13.2 的指标在 S1 / S2 上达到目标，并与 `baseline.json` 对比记录在 `docs/refactor/results.md`。
4. `strictWrites=throw` 在生产配置中开启一周无报错后，作为默认值。
5. 文档：`docs/01-architecture.md`、`docs/02-agents-orchestration.md` 更新为新架构；本文末尾追加"实施结果"。
6. 旧路径按 §12 的时间表移除。

---

## 附录 A. 设计记录条目到工作包的映射

### A.1 附录 B 决策

| # | 决策 | 处理 | WP |
|---|---|---|---|
| B1 | `metainfer_lab` 按 preset 收敛 action | 接受，扩展为全 actor 能力表 | P2.2 |
| B2 | 专家 = 描述符 | 接受 | P4.1 |
| B3 | 队列是派生视图 | 接受（G11） | P1.4 |
| B4 | 优先级四元组 + 提交点 | 接受；提交点 = `node.claim` | P3 ✅ |
| B5 | 人的节点默认 p0，不经 LLM | 接受 | P3.6 |
| B6 | prune = `deferred` 类别 | 接受，加归档层 | P5.3 |
| B7 | 只有 planned 可被 prune，无级联 | 接受 | P5.3 |
| B8 | 唯一可执行口径 | 接受（`projection.runnable`） | P1.4 ✅ |
| B9 | 专家只提议 | 接受（G4） | P2、P5 |
| B10 | dispatcher 不含 LLM | 修改：dispatcher 是接口，默认确定性；LLM 策略可插拔但受安全包络约束 | P3 |
| B11 | 专家三级 | 修改为作用域分区 + 升级路由（D7） | P5.5 |
| B12 | 单个 chief 作为例外仲裁 | 接受为 arbiter，加不可见性和配额 | P5.7 |
| B13 | 上报由确定性触发码驱动 | 接受 | P4.5、P5.7 |
| B14 | 乐观提交 + 否决窗口 | 接受 | P5.7 |
| B15 | 小推送 + `dag_*` | 接受，增加 `dag_query`、`trace_explain`、`resource_status` | P4.3 |
| B16 | 驻留会话 | 修改为无状态激活 + 笔记本 + 游标（D6） | P4.2、P4.4 |
| B17 | 确定性召回 + 专家裁决 | 接受；召回索引化（tag + LSH） | P5.4、P5.6 |
| B18 | `tag:{hypothesis, variant}` | 接受，加 `lever` | P5.4 |
| B19 | 单个 curator | 接受 | P5.6 |
| B20 | 建子节点 = 投票 | 接受，加计权 | P5.2 |
| B21 | 意图日志 + basis | 接受 | P1.3 ✅、P5.1 |
| B22 | 冲突默认保持现状 | 接受 | P6.4 |
| B23 | 预测误差复盘，不投票 | 接受 | P6.3 |
| B24 | claim 谓词化 | 接受，加 `infer` 标记与 Wilson 下界 | P6.1 |
| B25 | 截断显式化 | 接受 | P4.3 |
| B26 | `summary ≤ 500` | 反对；改为新增 `headline`（D16） | P6.6 |
| B27 | 不可逆动作的验证强度分级 | 接受（L0–L3） | P2.2、P6.1 |

### A.2 附录 C 开放问题

| # | 回答 | WP |
|---|---|---|
| C1 | deferred 积压：TTL 后归档，热索引移出，地图聚合显示，`maxDeferred` | P5.3 |
| C2 | arbiter 退化：不可见、配额、升级率监控 | P5.7 |
| C3 | 驻留会话代价：不用驻留会话（D6） | P4 |
| C4 | 三级过重：不做固定层级（D7） | P5.5 |
| C5 | 代码执行边界：语义动作由专家以意图提出，代码执行；无法以意图表达的动作升级到 arbiter 或人 | P5.1 |
| C6 | 谓词覆盖不到的 claim：允许，标 `infer`，不计证据 | P6.1 |
| C7 | 对抗"少给 claim"：Wilson 下界 + 按证据数加权 + 按不可逆等级要求最少证据 | P6.1 |
| C8 | 刷节点保分支：投票计权、配额 | P5.2 |
| C9 | 误杀不对称：planned defer 阈值放宽；running cancel 需 arbiter；completed 只标记 | P5.6 |
| C10 | 成本模型：令牌桶 + 全局规划预算按实验 GPU 小时折算 | P4.1 |
| C11 | curator 频率：候选对数量触发 + 最大间隔兜底 | P4.5 |
| C12 | 成功度量：并发度、GPU 空洞，加单位 GPU 小时产出 | §13.2 |
| C13 | Goodhart：绩效看结果和校准度，不看采纳率 | P6.5 |
| C14 | 不停机迁移：开关 + 影子模式 + 遗留对等场景 | §12 |

---

## 附录 B. 文件改动索引

| 文件 | 改动 WP |
|---|---|
| `index.js` | P1.4（load 投影）、P1.3（启动时 recover）、P3.6（创建 Dispatcher）、P4（专家运行时生命周期） |
| `host/store.js` | ✅ P1.2；P1.2（limit、冷段）、P1.7g（写保护）、P1.10（v2 表） |
| `host/runtime.js` | P1.7e、P1.8、P3.6（`dispatchLease`、删除申请型 pump）、P3.5.5（`prepareLaunch`）、P3.5.8–9、P4.5（K8） |
| `host/orchestrator.js` | P1.6、P1.7d、P3.6、P4.6 |
| `host/auto.js` | P1.7b、P1.8、P3.6、P4.6 |
| `host/gc.js` | P1.6、P1.7c、P4.7 |
| `host/lab-service.js` | P1.7f、P1.8、P1.9、P2.1、P3.6（p0 默认）、P5.8 |
| `host/reconcile.js` | P1.7a |
| `host/cluster.js` | ✅ P0.1；P3.5.1（拆分）、P3.7 |
| `host/snapshot.js` | P1.8、P4.6（删 `reportSummary`） |
| `host/agent-tool.js` | P2.1、P2.2 |
| `host/http.js`、`host/mcp.js` | P1.9、P2.1、P2.3 |
| `host/transcript.js`、`host/execution-log.js` | P4.9 |
| `host/remote-run.js` | P3.5.5 |
| `presets.patch.yml` | P2.2、P4.1（`lab-expert` 系列 preset）、P4.7（K15） |
| `client.js`、`locale/*.json` | P1.9、P3.5.10、P5.8、P6.5 |
| `package.json` | ✅ `files`、`scripts` |
