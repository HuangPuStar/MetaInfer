# 设计决策落地检查清单

| | |
|---|---|
| **文档性质** | 审计用检查清单。把设计问答实录里的每一条决策、每一个结论、每一个阶段步骤摊平成可勾选、可验证的行 |
| **权威来源（设计）** | [`metainfer-async-architecture-qa.md`](/root/mqa_baseline/metainfer-async-architecture-qa.md)，2015 行，2026-11-09，代码基线 `867d277`。**本文所有"来源"列都指向该文件的章节号** |
| **参照来源（计划）** | [`metainfer-lab-refactor-plan.md`](/root/expert-review/metainfer-lab-async-refactor/metainfer-lab-refactor-plan.md)，1491 行，与仓库内 `docs/07-async-refactor-plan.md` **逐字相同**（`diff -q` 无差异） |
| **状态来源** | [`PROGRESS.md`](PROGRESS.md)、[`spikes.md`](spikes.md)，以及 `host/` 实读 |
| **状态基线（重要）** | 分支 `refactor/async-foundation`，提交 **`dd5ca19`**（2026-11-10 11:26，"P2.1(B8): one runnable predicate"），审计时间 **2026-11-10 11:30 +08:00**。审计期间该分支**正被并行修改**（见下方"在途"），复核时请先 `git log --oneline -5` 对齐 |
| **本文不含** | 任何新决策。未在 QA 文档中出现的条目一律不写；含义不清处标 `需确认` |

## 0. 阅读约定（先读这一节，否则状态列会被误读）

**状态词只有三种，定义是"接入级"而不是"代码级"：**

- `done`：代码存在、**已接入运行路径**、且该步骤的验证指标可以观测到。
- `todo`：不存在，或只有模块级实现但没有接入运行路径 / 指标不可观测。
- `blocked`：存在一个必须先裁决的设计冲突，裁决前开工没有意义。

**"在途"（不占状态词）：** 审计期间工作区里存在尚未提交的实现（`host/dispatch/round.js`、`host/dispatch/dispatch-once.js`、`host/kernel/policy.js`、以及 `deterministic-strategy.js` / `priority.js` 的 `fairOrder` 改动）。它们**不计为 done**，在 §3 的行内以 `todo（在途：文件名）` 标注。**这也是本文档唯一可能在你读到时就已过期的部分。**

**判定"接入"的硬证据（三条，全部可复现）：**

1. `grep -rn "from './kernel/\|from '../kernel/\|from './dispatch/\|from '../dispatch/" host/ index.js` → 在 `dd5ca19` 上**只有 3 处命中**：`host/auto.js:7`（`kernel/runnable.js`）、`host/snapshot.js:6`（`kernel/runnable.js`）、`host/kernel/projection.js:12-14`（`priority.js` / `mutations.js` / `runnable.js`）。即 **`executor` / `bus` / `trace` / `dispatcher` / `deterministic-strategy` / `envelope` 仍只被 `scripts/*-selftest.mjs` 引用**，没有参与任何运行路径。
2. 在 `dd5ca19` 上 `host/` 下**仍然不存在**：`kernel/commands.js`、`kernel/intents.js`、`kernel/conflicts.js`、`kernel/verifier.js`、`kernel/triggers.js`、`kernel/eventlog.js`、`kernel/write-guard.js`、`experts/registry.js`、`experts/runner.js`、`experts/nav-tools.js`、`experts/notebook.js`、`experts/curator.js`、`experts/similarity.js`、`experts/partitioner.js`、`dispatch/legacy-llm-strategy.js`。**已存在**：`kernel/runnable.js`（新）、`kernel/policy.js`（在途）。
3. `npm test` 全绿（`11/11 runnable`、`15/15 kernel`、`14/14 gang planner`、`7/7 dispatch`、advisor-merge 7、`11 migrate-domain`、cluster/placement 全 PASS），但**除 `runnable-selftest` 之外都是纯函数与离线工具的自测**，不构成接入证据。

**两套编号不要混：**

- QA 附录 D 是 **5 个阶段 / 17 个步骤**（1.1 … 5.4），按"每步可独立验证、可回滚"排列，**不涉及内核抽象**。
- 专家计划是 **P0–P7**（含 P3.5、P0.1–P0.9 等），按"确定性内核先行"排列。
- `PROGRESS.md` 记的是 **P 编号**。所以"附录 D 全部 todo"**不等于**"没有进展"：P1.1–P1.5、P3.1–P3.5 的模块已经落地，它们是附录 D 2.x / 3.2 的**底层**，但没有**任何一步**达成其验证指标（见 §3 每行依据）。

---

## 1. 附录 B 的 27 条决策

> 来源：§附录 B（L1892–1925）。原文状态列全部是"提议"；⚠️ 标记为"最需要挑战"的 4 条（B6 / B7 / B12 / B16）已在 §5 单列。
> 本表只记"决策内容 + 怎么验证它真的落地"，**落地状态见 §3 对应步骤**，不在此重复。

| ID | 决策摘要（一句话，中文） | 来源（Q编号） | 验收方式（可执行 / 可观察） |
|---|---|---|---|
| B1 | `metainfer_lab` 按 preset 收敛 action 白名单，且是**代码级强制**（不是 persona 里的君子协定） | §Q1 缺陷 A（L355）、§Q11-4（L1391–1400） | 用 `lab-worker` / `lab-advisor` preset 的会话调 `delete_project`、`cancel_node`、`auto_stop`，必须返回 `forbidden_action`；`ACTION_ENUM` 不再是全局单一 49 项枚举，而是按 actor 求交集；issue `0001-agent-tool-scope-drift.md` 状态改为已修 |
| B2 | 专家 = 描述符：`persona` / `model` / `tools` / `triggers` / `mayPropose` / `mayExecute` / `budget` / `schema` | §Q11-3（L1370–1389） | 换掉一个专家只需替换这份描述符，不改 `host/` 代码；描述符能被 `GET` 出来（8 个字段齐全）；`mayExecute: []` 的专家在代码层不持有任何执行 action |
| B3 | 队列是**派生视图，不落盘**；DAG（`node.status`）是唯一事实源 | §Q3 陷阱 1（L457–469） | 存储域里不存在 `queue` / `ready` 表（`~/.dsh/storages/metainfer_research_lab_v2` 逐表核对）；`readyQueue(nodes)` 是纯函数 `filter(status==='planned').sort(comparePriority)`；杀掉进程后重建队列结果逐字节一致 |
| B4 | 优先级 = `(class, score, age, seq)` **字典序** + **提交点**；不是加权求和 | §Q3 机制 A（L479–493） | `comparePriority` 单测：class 先决；同 class 内 `score` 降序（clamp 到 `[-1000, 1000]`）；再 `timestamps.createdAt`；再 `seq`。提交点之后改优先级只影响**下一轮**派发，且每次变更写 `node/priority_changed`（带 `before` / `after`）。已有覆盖：`scripts/kernel-selftest.mjs:82` / `:121` |
| B5 | 人的节点**默认 `p0`**，走确定性快路径，**完全不经 LLM** | §Q3 机制 C（L505–513）、§Q3 三问（L536） | 人在 UI / HTTP 建节点后 `node.priority.class === 'p0'`；该节点从提交到 claim **< 1 s**（本地池有空闲容量时，对应计划 I15）；它启动时**不产生** advisor / scheduler run 记录；现状对照：人加一个节点要等 2.5 分钟（2 s 轮询 + advisor 129 s + scheduler 18 s） |
| B6 | ⚠️ prune = `priority.class='deferred'`，**不新增状态**；具名 class，不是 `priority=-999` | §Q5（L665–684） | `NODE_STATUSES` 里没有 `pruned`（当前 6 个：`proposed/planned/running/completed/failed/cancelled`，`host/kernel/mutations.js:15`）；对 planned 节点设 `deferred` 后 `status` 仍为 `planned`；写的是 `node/priority_changed` 而非状态事件；`priority.reason` 可回答"砍了多少 / 谁砍的 / 为什么 / 被恢复过几次" |
| B7 | ⚠️ 只有 `planned`（构造上必为叶子）可被 prune，**无级联** | §Q5（L652–663、L723） | 对 `running` / `completed` 节点设 `deferred` 必须被拒绝（QA 未规定拒绝码，`需确认`）；"只有 completed 能生孩子"的四处拦截仍在（`host/orchestrator.js:491 / 995 / 1045 / 1113`）；代码里无级联剪枝路径 |
| B8 | 唯一可执行队列口径：`planned && class !== 'deferred'` | §Q5-①（L697–704） | 全仓库只有一处定义（`projection.runnable`）；`host/auto.js` 的 `planned` / `canRunPlanned` / `idleStreak` / `maxNodes` 全部改用它；`grep -n "status === 'planned'" host/` 只剩 kernel 内 |
| B9 | 专家只**提议**，代码执行；"执行任何变更"**仅代码持有** | §Q11-4（L1386–1400）、§Q12-8（L1551–1561） | 专家可见的写工具只有 `submit_intent` / `update_notebook` / `claim`；§Q12-8 权限矩阵 5 行 × 6 列逐格有成功 / 失败测试；`delete_project` 对 `expert:*` 返回 `forbidden_action` |
| B10 | dispatcher **不含 LLM**；scheduler 的判断权上移给专家 | §Q4-2（L559–571）、§Q9-7（L1215–1222） | `host/dispatch/*` 内无任何模型调用（`grep -n "llm\|model\|prompt\|runRole" host/dispatch/` 为空）；`dispatch.strategy=deterministic` 时 `runs` 表不再新增 scheduler 记录；容量够就直接启动，LLM 超时 / 空返回按 FIFO 兜底 |
| B11 | 专家分三级 `branch` / `lead` / `chief`，低层**不能物化节点** | §Q8-3（L979–1012） | L0 输出 `BranchReport`，`mayPropose` 不含 create；只有 L1 能 create；L0 触发是"该分支有节点完成 / 失败"，不是全局周期；L0 查询预算 2 次、延迟预算 30–60 s。**注：与计划 D7 冲突，见 §5.1** |
| B12 | ⚠️ 只有 **1 个 chief**，且它是"例外仲裁者"而非审批闸门 | §Q8-4（L1014–1016） | 每项目 chief 数 = 1；通过 chief 的节点占比远小于 100%（统计 `chief 激活次数 / 节点完成数`）；未触发上报码的节点**不经过** chief 即落地 |
| B13 | 上报由**确定性触发码**驱动，不由专家自行决定 | §Q8-5（L1028–1037） | 6 个触发码在代码里有判定：`conflict` / `budget_shift` / `new_direction` / `branch_death` / `low_confidence`（`confidence < 0.6`）/ `ledger_conflict`；`escalate` 意图缺合法 `reasonCode` 一律拒收 |
| B14 | 乐观提交 + 否决窗口，把 chief 移出关键路径 | §Q8-4②（L1018–1026） | L1 提案立即物化为 `p2`；命中上报条件时打 `pendingHighReview` + **10 分钟**裁决窗口；窗口内否决 → 降为 `deferred` 或撤回；窗口超时 → 保持并记 `unreviewed` |
| B15 | 专家导航 = 小推送 + `dag_map` / `dag_walk` / `dag_get` / `dag_diff` | §Q6-4（L802–830）、§Q9-4（L1147–1192） | advisor 输入 p50 **46 KB → 8–12 KB**；`dag_map ≤ 6 KB`；`dag_walk` 默认 `maxRows 200 / maxBytes 24000`；四个工具都存在且返回值带 `revision`。**注：计划另加 `dag_query` / `trace_explain` / `resource_status`，见 §5.4** |
| B16 | ⚠️ 专家从"一次性单发"改为**驻留会话 + `submit` 工具** | §Q9-3（L1137–1145） | 一次激活内工具调用次数 > 1；`structured_output` 从"终止输出"变成"一个工具"；有 compaction 纪律与查询预算（`maxQueries 4` / `20k tokens` / `240 s`）。**注：计划 D6 明确反对，见 §5.1** |
| B17 | 重复检测 = **确定性召回 + 专家裁决**；不让专家去"找" | §Q10-2（L1241–1267） | 代码侧产出候选对（`promptHash` 前缀 / 标题 Jaccard ≥ θ / 同父 + 相似 `successCriteria` / 同 metrics 目标），全量且成本≈0；curator 每轮只看 top-K **5–10 对**；"找"的路径不调用模型 |
| B18 | 节点带 `tag:{hypothesis, variant}`，**同 H 同 V = 重复** | §Q10-5①（L1294–1302） | 新节点必须有 `tags`；`同 hypothesis + 同 variant` 判重复、`同 hypothesis + 不同 variant` **不**判重复；参数扫描样本（`block_n 64→128`、`threads=512`、epilogue）不被误杀 |
| B19 | 只设 **1 个** curator（无复制），只读 + 只提名 | §Q11-5（L1402–1412）、§Q12-2（L1468–1481） | curator 实例数 = 1（**不是** `clamp(ceil(nodes/80),1,3)`）；`mayExecute: []`；工具集仅 `dag_map` / `dag_walk` / `dag_get` / `dag_query`；单轮提名 ≤ 5 |
| B20 | 「建子节点 = 投票存活」→ **自动撤回** defer 提名 | §Q12-4（L1495–1504） | X 上有 pending defer 且有人在 X 上成功建子节点 → 写 `nomination/withdrawn{reason:'child_created'}`；反向约束：节点有新子节点后 **10 分钟**内不可被 defer；全过程纯代码、零模型调用 |
| B21 | 意图日志 + `basis` 版本号；**陈旧分歧由代码消解** | §Q13-3（L1618–1629）、§Q12-1（L1455–1466） | `intents` 只追加、带 TTL、可撤回；每条带 `basis:{projectRevision, snapshotAgeMs, nodesSeen}`；两个冲突意图 basis 不同 → 直接丢弃陈旧方并强制重读重判，**不产生 dispute、不消耗模型调用** |
| B22 | 冲突默认动作 = **保持现状**；升级需 `reasonCode` + 配额 | §Q13-4 / §Q13-5 / §Q13-7（L1631–1686） | 每条 dispute 有 `deadlineAt` 与默认动作"保持现状"；§Q13-4 的 8 类冲突 → 裁决者映射逐行有测试（其中只有 2 类需要模型）；到人的升级必须带 `reasonCode` 且每项目 / 每专家每 epoch 有上限 |
| B23 | 纠偏靠**预测误差复盘**，不靠辩论；**不引入多数表决** | §Q13-6 / §Q13-7（L1661–1686） | 提案 `rationale` 带 `expected`（方向 + 量级）；节点完成后与 `report.metrics` 比对，超阈值生成 retro 议题；代码里不存在"投票 / 辩论 / 多模型表决"路径；轮换规则（同一专家同一分支超 N 天）存在 |
| B24 | claim **谓词化** + 提交时**同步校验** + `citationErrorRate` 门控权限 | §Q14-2（L1727–1767） | claim 只能是 7 个谓词之一：`nodeExists` / `statusIs` / `parentOf` / `metricIs` / `textContains` / `countWhere` / `reviewedBy`；提交时同步校验、失败立刻回给专家；`citationErrorRate = 失败 claim 数 / 总 claim 数`；`< 5%` 允许提议不可逆动作，`> 15%` 降级为只能提名 |
| B25 | 截断**显式化**：`_truncated: {shown, total}` | §Q14-3③（L1782–1792） | 被截断字段返回 `shown` / `total`（例：`report._truncated.summary = {shown:700, total:2886}`、`metrics {shown:6, total:19}`）；不再只有单个 `…`；模型能据 `total` 触发 `dag_get` 拉全文 |
| B26 | `report.summary` **≤ 500 字符**（schema + prompt） | §Q14-3（L1715 实测 2,886 字符）、§附录 D 1.1（L1969） | `NODE_REPORT_SCHEMA.summary` 有 `maxLength: 500`（或 prompt 硬规则 + Host 写入时拒绝 / 截断并记 `_truncated`）；全库存储 **1.3 MB → ~200 KB**。**注：计划 D16 明确反对，见 §5.1** |
| B27 | 不可逆动作的**验证强度分级** | §Q14-4（L1796–1806） | 5 级表全部落地：建 planned = 父存在且未被 deferred（0 证据）；提名 defer = **1 条**已验证证据；cancel running = **2 条** + 首席确认；砍整条分支 = **3 条** + 首席 + 人可申诉窗口；删除项目 = **只能人做**。代码层对应 `delete_project` 对非 human 返回 `forbidden` |

**27 行。** ⚠️ 的 4 条（B6 / B7 / B12 / B16）与专家计划的关系见 §5.1。

---

## 2. Q1–Q14 的结论

> 一行一题。标记含义：`【更正】` = 该题是在更正前序结论；`【已部分可用】` = 结论明说"其实已经有了"；`【defer】` = 结论明说"以后再说 / 最后再放开"；`【已具备】` = 结论列举的现状优势。
> 保留所有数字与字段名，不做改写。

| Q | 议题 | 结论要点 | 需要落地的具体动作（可执行条目） |
|---|---|---|---|
| **Q1** | 现分层架构与代码是否一致 | 【更正】主要来自代码，但**4 处错、其中 2 处是从 preset 注释推断**：①"L1 唯一持有 `metainfer_lab`"❌（standard 33 / worker 13 / advisor 3 / scheduler 3 全都有）；②"角色 agent 无工具"❌（有 3 个：`metainfer_lab` + `working_directory` + `structured_output`，advisor 实际调用 93 次、scheduler 95 次）；③"anchor 跨重试存活"❌（`prepareNewAttempt` 同时重置 `sessionId` 与 `anchorSessionId`）；④"anchor 是一个 agent 层"❌（75 个 `lab-controller` 会话：0 条 assistant 消息、0 次工具调用）；⑤ action 数 44 ❌ 实为 **49**；⑥"worker 自己 commit"⚠️ 半错（Host 做 `git.commitWorktree`）。正确答案：**3 层会思考（L1/L3/L5）+ 1 层空壳（L4）**。两个结构缺陷：A 49 action 全开；B 父会话空壳、链路上无仲裁者 | 1) 修 issue `0001`（B1）；2) 把 `docs/01` / `docs/02` 里的 44 改成 49、把"角色无工具"改成实际 3 个；3) 在 `docs/01-architecture.md §7.3` 保留"anchor 存在的理由是 sandbox 取父会话 `header.cwd`"这条解释；4) `lab_cleanup` 在全仓库不存在，删除 persona 引用（已做，K15 前半）；5) 明确"父会话不运行 ⇒ 没有上级审批下级"，不要再把 L4 当决策层 |
| **Q2** | 各层之间是纯异步还是有等待 | **不是纯异步，三种耦合混在一起**：cycle 内部严格串行、节点之间完全异步、整个驱动靠 **2 秒**轮询。实测：cycle p50 **152.3 s**（p90 264.8 / max 332.4，52 个 cycle）；其中 advisor p50 **129.4 s**、p90 **180.5 s**（= 超时线）、失败率 **22%（11/49）**；scheduler p50 18.4 s；每 cycle 启动 **1.37** 个节点；节点时长 p50 **42.3 min**；时间加权并发 **2.83 / 8**（峰值 10）；DAG 分支因子 **1.43**（41/54 父节点只生 1 个孩子）。【已具备】三件好事：无跨 LLM 长事务锁（`withProjectLock` 只包落库几毫秒）、节点故障天然隔离、状态可重建。核心问题：**两条关键路径都压在 LLM 上**；真正的瓶颈是 **DAG 太窄**（42 min 摊 152 s 只占 6%） | 1) **P0 启动快路径**：事件驱动 + 容量算术 + CAS，不调模型，**< 100 ms**；2) **P0 scheduler 降级为建议**：容量够就启动，模型只定优先级，超时 / 空返回按 FIFO 兜底；3) **P1 让 DAG 变宽**：advisor 从"提 1 个后继"改成"提 **3–5 个**互不依赖的兄弟节点"，且"在跑节点数 < 空闲 GPU 数时必须提并行分支"；4) **P1 advisor 稳定性**：180 s 超时正好卡 p90，需提高超时或裁剪快照；5) **P2 真 join 原语**：merge 在父节点全部 completed 时自动触发（现状 `finish_merge` 要人、要 `MERGE_HEAD`）；6) `gc` 的 `.catch(() => {})` 改成可观测失败 |
| **Q3** | 能否完全异步、用 DAG + 队列做共享状态、优先级可动态改 | **方向正确，但两个隐含假设会致命**：陷阱 1 队列若独立存储会成为**第二份事实**（"取消但还在队列 / 人工改 failed 队列不知道 / 崩了队列没落盘"，`CLAUDE.md` 里 `pid` 三处存储就是同类教训）→ **队列必须派生视图**；陷阱 2 人的优先级若写成一个字段就会被 LLM 忽略（人的意图被压缩进一个 129 s 超时、22% 失败的模型上下文）→ **人的意图必须走确定性通道**。四机制：A 四元组 + 提交点；B 调度权拆成排序 / 限流 / 砍单三件事（现状"限流：无上限"、"砍单：做不到"）；C 人的通道三级；D 多来源 CFS 公平份额。三个具体回答：优先级动态改 = 版本号 + 重排序 + 提交点；advisor 重要性**不要打 1–10 绝对分**（LLM 打分系统性偏高、跨专家不可比、无语义）；人的方向靠 p0 快路径（现状要等 2.5 分钟，是设计缺陷不是性能问题） | 1) `readyQueue(nodes)` 纯函数化、不落盘；2) 优先级四元组 + 字典序 + `revision` CAS + `starting` 之后只影响下一轮；3) **WIP 上限 `maxPlannedInFlight = max(2 × freeSlots, 4)`，超了跳过 advisor pass**（现状 63 节点 / 并发 2.83，队列无限膨胀，plan 排 3 小时早过时）；4) **`reservedSlots.p0`（默认 0）**；有 p0 等待且无空槽 → 允许抢占 `p2/p3` 且已跑 **> 10 min** 的节点；5) **p0 等待 > 30 s 发 `priority/delayed {blockedBy, 预计剩余}`**；6) `vtime[origin] += estimatedCost(node) / weight[origin]`，**`weight: human = 100, advisor = 10`**，按 vtime 最小派发；7) `score = w1*depthBonus + w2*failureRecoveryBonus + w3*hypothesisDiversity - w4*expectedCost`（**定性判断给 LLM，定量打分给代码**）；8) 做法二成对比较作为备选（"新提案 A 与队列最差 B 谁先跑"） |
| **Q4** | 砍需求归专家吗；调度器是不是专家；专家库 / 在职列表怎么设计 | 【已部分可用】砍需求归专家——对，但**单一专家只能砍自己提的 / 自己域内的节点**，跨域是组合决策（理由：判断"方向还有没有价值"需要领域语义，而砍单是**不可逆的信息销毁**，用摘要做不可逆决策是最差组合）。"调度器 = 专家"**判断层成立、机制层不成立**：现在的 scheduler 同时干 ①排序 ②分配槽位 ③取舍，bug 是 **③ 被偷偷塞进了 ①②**；结论是"**调度器不应该有判断权**"，判断权回专家、机制归代码；跨域取舍不交给"总专家"（会讨好提出者、会过度自信）。【已部分可用】**系统里其实已经有专家库**：`project.config.advisor.reviewers[]` 就是专家名册（lens + model），节点已有归属 `createdBy: advisor 71 / user 6 / seed 2`——**不是新建，是补身份、状态、预算、绩效**。缺的四样：身份（只有 `lens` 字符串）、状态（每轮重建 prompt、无记忆 = 129 s 的来源）、预算（共用项目预算）、绩效（无，人不知该解聘谁） | 1) 解聘要"**排空**"不是"断电"：`drain`（默认）/ `handover` / `abort`；2) 离职后归属不能悬空：转给 `human` 并标注"**孤儿节点**"；3) 每专家独立预算与节奏：`reviewEvery` / `maxProposals` / `tokenBudget` / `maxConcurrent`（否则 5 个专家 × 129 s = 一个 cycle 11 分钟）；4) **专家要有记忆**：`note: {hypotheses, ruledOut, openQuestions}`，Host 每轮注入、专家只做增量（可能把 129 s 压到 30 s 以内）；5) 邀请专家：**深度 ≤ 1**、一个问题、预算封顶、回答完即退场、可见；6) 绩效指标：`proposals / accepted / completed / pruned / costUsd / avgCycleLatency`；7) 6 条**确定性触发**：队列超载（`planned > 2 × freeSlots` 持续 **5 min**）、停滞（无进展且 `running > 0` 超 **15 min**）、重复失败（同 `errorKind` 连续 **3** 次）、**专家无效（连续 5 次提案被拒）**、预算告警（消耗速率 **> 80%**）、方向收敛（同一假设连续 **3** 个节点失败）；8) 决策归属表 7 行落地（调度器从表里消失）；9)【defer】跨域 portfolio 角色"只做预算分配"是可选项，不在第一版 |
| **Q5** | 更正：级联剪枝不存在，砍掉的只能是未执行的叶子 | 【更正】**这是对的，而且比"人为规定"更强——状态机已经保证了它**：`orchestrator.js` 四处拦截（491 / 995 / 1045 / 1113）"只有 completed 能生孩子"，所以 planned 在构造上必为叶子。**prune 不该是状态**（不需要 `pruned` / tombstone / `restorable` / 重新物化 / 重复 hash 校验）。但**要写成具名 class**：`{"class":"deferred","reason":"supersededBy:n-0041","by":"expert-3"}`——前者能回答"砍了多少 / 谁砍的 / 为什么 / 被恢复过几次"，`priority=-999` 只能比大小；**砍单是需要被审计的行为**。四个副作用：① 让 auto 误判"无进展"→ **这就是之前 9 小时停机的机制**（deferred 让 `canRunPlanned` 恒真 → cycle 照跑 129 s → 一个都不启动 → `progress===0` 连续 3 次 → `pause('noProgress')`）；② `maxNodes` 被占死（40 个被砍仍计数 → advisor 再也提不出新节点）；③ advisor 快照污染；④ UI 噪声。抖动从"状态翻转"变成"优先级翻转"（更隐蔽：改一个字段成本≈0）。对先前三条说法全部更正（级联砍 / 恢复要重新物化 / prune 需 tombstone 都不成立）；仍成立的两条：**deferred 必须从容量 / 进度计算里排除**、**优先级变更要版本化 + 限频 + 审计** | 1) 唯一口径 `const runnable = nodes.filter(n => n.status === 'planned' && n.priority?.class !== 'deferred')`，**各处都用它**；2) deferred **不计入 `maxNodes`**，单独设 `maxDeferred`，超了才真正归档；3) deferred 在 advisor 快照里只出现一行摘要，或干脆不进快照；4) UI 加"显示 / 隐藏已砍掉"开关（默认隐藏但保留）；5) 约束优先级抖动：`revision` 校验 + 同节点同专家 **30 分钟冷却** + 每次变更写事件 + 统计"**被恢复率**"；6) 状态机**不变**（5 状态模型） |
| **Q6** | 专家的上下文怎么构造，能否自主查询 DAG | 不是对话，是**一次性单发**：persona + lens + prompt + 10 条硬规则 + `JSON.stringify(buildAdvisorSnapshot(...))` → 一次 activation → 必须一次吐出 `structured_output`。实测载荷：advisor p50 **46 KB（≈11.5k tokens）**、p90 147 KB、max **205 KB**；scheduler p50 4.7 KB。最大那份 **`candidateParents` 占 197,925 B = 96.4%**（51 条 = 18 leaf + 33 ancestor，平均 3,879 B/条）。三个结构性问题：① 上下文是 **O(宽度)**，与"让 DAG 变宽"直接冲突（8 路并行 → 30+ 叶子 → 100+ 候选 → 400 KB → 必然超时）；② 视野只有 **2 层**，但 prompt 第 5 条要求"别重复"——**不是没想到分支，而是看不见已经试过什么**；③ running 节点**没有进度信息**（只有 `startedAt` / `deadlineAt`）。【已部分可用】**"自主查询"其实已经有了，但不可用**：advisor 有全量 49 action、实际调用 93 次，但 `getState` 返回整个项目 **79 节点 = 1,301,776 B ≈ 325k tokens**（report 806 KB、prompt 283 KB）——**粒度只有"全部"，等于没有查询能力** | 1) 给 `running` 补 `elapsed` / `lastActivity`（最小一步，让停滞判断可行）；2) 快照瘦身：`project.brief` 截断到 **1500**、`focus` **≤ 8 条**（prompt 400 + report 400）、`recentFailures` 5 条、`ledger{open, ruledOut, confirmed}`、`index{byStatus, byOrigin, nodes}`，目标 p50 **46 KB → 8–12 KB**；3) `dag_query({filter:{status, createdBy, class, tag, subtreeOf, depth, since, text}, select, limit:50, cursor})`，行级紧凑（`finding ≤ 160` 字符、每行 ~120 B）、必须分页；4) **假设台账 `ledger`**（10–20 条，专家每轮必须更新）——比查询工具更值钱；5) 有界探索：`maxQueries 4` / `maxQueryTokens 20k` / `wallClock 240 s` / 无工具时退回焦点窗口；【defer】第 5 项是"放开前必须就位"的最后一步，排在第 4 项之后 |
| **Q7** | 既然完全异步，专家延迟还是问题吗 | 【更正】"K 次查询会让延迟变成 300 秒"**只在 dispatch 被 plan 阻塞时成立**（当前代码成立、异步架构下前提消失）。正确表述：**专家延迟不是关键路径问题，是"队列深度不足时的空洞"问题**——backlog=3 时延迟完全被隐藏，backlog=0 时出现 129 s 的空洞。四种仍咬人的场景：**饥饿（现状）/ 爬坡 / 收尾 / 人工 p0（已由快路径解决）**。触发条件不该是"节点完成"，要**预测式**：`remainingMin < 5 && !planningInFlight → triggerPlanning()`（规划 p90 265 s、节点 p50 42 min）。异步化带来三个新问题：① 触发风暴（8 节点同时完成 → 8 次规划、提案高度重复）；② 同父并发提案；③ 探索深度应与空余度**成反比** | 1) `planning` 状态 + 去抖窗口 **60 s** + 事件合并；2) 审查租约 `reviewClaim: {nodeId, expertId, until}`（例中 until=1762690000000）；3) 探索预算随 backlog 动态：`maxQueries = backlogDepth > 4 ? 6 : 1`；`maxWallClock = backlogDepth > 4 ? 240_000 : 60_000`；4) 低水位预触发（**目标从"降延迟"改成"防空洞"**）；5) 坚持"专家不能慢慢想"：延迟一旦超过队列剩余工作时长就立刻变回 GPU 空洞 |
| **Q8** | 分层评审（低 / 中 / 高）怎么设计 | 本质是**上下文压缩树**：现在 1 个 advisor × 205 KB → 129 s（p90 撞超时），加宽到 8 路 → 400 KB+；分层后每层都是**常数**（L0 每分支 20 KB 并行 30–60 s → 1 KB 摘要 → L1 8×1 KB + 全局索引 10 KB → L2 20 KB）。**关键区别：现在是"冗余"，分层必须是"切片"**——3 个 lens 读**同一份 197 KB** 快照只换了视角，这叫冗余投票；切片规则是**按子树切，不按 lens 切**。三层：L0 分支评审员（≤ 15 节点 / 20 KB、`BranchReport`、**不能创建节点**、事件驱动、30–60 s、**查询预算 2 次**）、L1 方向负责人（1–2 个、可创建 + 优先级 + 上报、60–90 s）、L2 首席（**恰好 1 个**、可创建 + 可否决、120–180 s、查询 6–8 次且**强制至少 1 次原始数据验证**）。"只有一个高层"对，但两个前提：**它必须是例外仲裁者不是审批闸门**（否则吞吐 = 每 4 分钟一个节点）、**宕机必须有确定性兜底 = 乐观提交 + 否决权**。上报 6 个触发码；防信息衰减三板：证据指针（无指针的 claim 在 schema 层拒绝）、L2 强制抽查、**深度硬上限 3 且每层 token 至少压缩 3 倍**。风险 7 条含动态编组 `ceil(活跃分支/2)`、`createdBy` 记 L1 / `ratifiedBy` 记 L2 / `evidenceChain` 全留 | 1) L0 只产出 `BranchReport`（健康度、已验证 / 已否定假设、下一步候选**文本建议不物化**、上报标志）；2) 上报码 `conflict` / `budget_shift` / `new_direction` / `branch_death` / `low_confidence(<0.6)` / `ledger_conflict` 写进代码；3) 证据指针 `evidence:[{nodeId, field, quote}]`，Host 校验节点存在 + 字段白名单；4) L2 `verifiedEvidence` 非空、至少验一条；5) 触发码路由 + 每 L1 每 epoch 上限防上报风暴；6) **⚠️ 与计划 D7 冲突（计划不做固定三级），开工前需裁决**；另：`daily` 层数 3 是硬上限，不要再加层 |
| **Q9** | 两个极端之间：自主遍历 + 一次性链式检索 | 两种极端都是"宿主替专家决定看什么"；第三种 = **宿主给地图和检索工具，专家自己决定往哪走、放大到多大**。粒度实测：全量节点记录 ≈ **16 KB/节点** → 82 节点 1.3 MB（325k tokens）；**紧凑索引行 110–230 B/节点 → 82 节点只有 9–18 KB**；**完整报告摘要平均 2,886 字符/节点 ← 元凶**。"看整张图"其实只要 9–18 KB。四机制：① 地图（不是快照，推结构 + 摘要）；② 增量 `dag_diff({sinceSeq})`（通常 1–3 KB，"把专家每轮重读全局彻底干掉，比换模型有效得多"）；③ 意图广播 `claim`（重叠读没问题，重叠做才有问题：**读 → 发现缺口 → 公开声明意图 → 提案**）；④ 覆盖兜底 `coverage` 哨兵（兴趣有结构性盲区，纯代码找 `unreviewed > K` 的已完成节点）。**必须承认的机制改动：一次性单发 → 驻留会话**（`structured_output` 从终止输出变成工具、上下文累积需 compaction、成本从固定变按探索深度——所以必须有查询预算与 wall-clock 上限）。**批量检索的理由不只是减少调用次数，而是每次工具调用都要重发整个上下文**：6 次串行 135 KB vs 1 次批量 45 KB，**3 倍差距且随轮数线性恶化**。`dag_walk` 是核心工具（**4 行约 600 字节，代替 4 次工具调用 + 4 次上下文重发**） | 1) `dag_map({groupBy:'branch'})` ≤ **6 KB**（节点数影响分支数不影响字节数）；2) `dag_diff({sinceSeq})`；3) `dag_walk({start, direction: up/down/both, depth:99, select, include, maxRows:200, maxBytes:24000, order})` → `{rows, truncated, nextCursor, total}`；4) `dag_get({ids, include:["prompt","report","run","transcript"]})`；5) 预算与截断语义：**双上限 200 行 / 24 KB**、超限返 `truncated:true` + `nextCursor`（**不报错**）、优先保留"失败 > 前沿 > 最近变更 > 其余"、**每条字段独立截断 title ≤ 80 / finding ≤ 120**；6) claims 出现在地图里；7) coverage ticket；8) 宿主保留四项确定性职责：预算、覆盖哨兵、claim 可见性、全局 WIP 上限；9) 每轮目标 **4 次调用、约 50–60 KB 输入**（现在是 1 次 205 KB）；10)【已部分可用】`metainfer_lab` 的 `state` 已有，但必须被 `dag_*` 取代而不是复用 |
| **Q10** | 专家能自己发现重复并 close 吗；是否是负反馈稳定机制 | **能，而且系统里已经发生了一次**：`n-0031`（父 n-0019）与 `n-0079`（父 n-0051）是同一个假设（fold fp32 head weights into the kernel/CTA），**相隔 48 个节点、两个都跑完 → 真实烧掉一次实验**，重复率 **1/82 ≈ 1.2%**。【已有实测证据】"专家自己发现"召回率不够：82 节点标题 Jaccard ≥ 0.34 得到 **30 组配对**，人工分类 = 真重复 **1** 组 / 合法递进 **1** 组 / 参数扫描多数 / merge 噪声若干 → **天真相似度精度很低**（30 组里只有 1 组该关）。所以结构是**两段式**：确定性召回（代码、全量、成本≈0）+ 专家裁决（LLM、只看 top-K **5–10 对**，判 duplicate / variant / extension / unrelated）。**关键：不要让专家去"找"重复，让它去"判"重复**——找是检索问题，判是语义问题。`close` 要按状态分：`planned` → 降 `deferred`（成本 0、完全可逆）；`running` → `cancel`（算力作废、不可逆）；`completed` → 标 `redundantOf: n-XXXX`（记账、可撤销）；**真正的清理应发生在 planned 阶段**（分代回收：年轻代激进、老年代只标记）。负反馈三前提：检测随 k 单调、**限幅（一次最多关 N 个，如 5）**、关闭成本独立于探索预算。两类误杀必防：参数扫描（结构化标签 `{hypothesis, variant, lever}`）与 merge 节点（`status` 或 `parentIds.length > 1` 不参与候选）。执行者：**专家提名，代码执行**；**预防优先于清理**（台账 / claims 广播 / promptHash 去重更便宜）。指标：`duplicateRate` / `closeLatency` / **`falseCloseRate`（> 20% 说明判太凶）**。额外收益：从重复节点长出的后代要**打折计算增量价值** | 1) 相似度扫描写成纯函数并穷举；2) 候选对 → curator top-K；3) `close` 输出 `{action:"close", nodeId, duplicateOf, kind, confidence, evidence[]}`，代码校验（节点存在 / 是 planned 或 completed / `duplicateOf` 合法 / 目标还活着）；4) planned → `class='deferred'`、completed → 打 `redundantOf`；5) 写事件 + 计数（进专家绩效）；6) 限幅 5；7) 三指标进仪表盘；8) `redundantOf` 参与后代增量价值计算；9) merge 节点排除在候选外 |
| **Q11** | 能否增加专职清理专家；专家协作是不是插件机制 | 应该单独设 curator，三条理由：**利益冲突**（探索专家目标是扩张，让它关自己的节点是激励错配）、**注意力分布相反**（探索靠兴趣不均匀，清理要均匀覆盖）、**技能与模型不同**（判重复是跨分支相似性推理，可用更便宜更快模型、更高频率）——**清理应该是廉价的、高频的、低风险的**。命名必须分开：`lab-gc` = 生命周期 GC（worktree / 租约 / 残留进程 / 失败复盘，**确定性、属于代码**）；`lab-curator` = 语义清理（重复节点 / 死分支 / 陈旧 planned / 过期 claim，**属于 agent**）。curator 职责 6 项（含"陈旧 planned 排队 > 2h"、"自身误杀率上报给人"）。【已部分可用】**「专家 = 插件」成立，且仓库已有雏形**：`presets.patch.yml` 已经是 agent 插件清单——要做的不是发明机制，而是把描述能力从"人格 + 模型"扩展到"触发 + 权限 + 预算 + schema"。**插件化必须带能力契约**：现在 49 action 全局注册、"advisor 只读"只写在 persona 里是君子协定，curator 可以直接 `cancel_node` / `delete_project`。史密斯隐喻：该学**弹性复制**`curatorCount = clamp(ceil(nodes / 80), 1, 3)`，该防**自利优化**（目标"减少重复"的最优解是"把所有节点判成重复"）→ 五道防护（只能提名 / 每轮 ≤ 5、每小时 ≤ 20 / `falseCloseRate > 20%` 自动降权 / 人类急停 / 指标里同时含 `exploredBranches`）。**谁清理清理者：确定性 TTL，不是另一个 agent**（再用一个 agent 管它只会无限退行） | 1) **【defer / 已撤回】复制能力**：Q11-5 给的 `clamp(ceil(nodes/80),1,3)` 被 Q12 的后续决策**撤回**——**只要 1 个 curator，不要复制能力**；2) 相似度召回（纯函数）；3) curator 描述符 + `CURATOR_OUTPUT` schema（示例：`model cheap-fast`、`tools` 只读 4 个、`triggers ["duplicate.candidates>=5","interval:15m"]`、`mayPropose ["close","defer","release_claim"]`、`mayExecute []`、`budget {tokensPerHour:40000, queriesPerRun:8}`）；4) **代码级权限校验（`mayPropose` 白名单）——顺手修掉 issue 0001**；5) dispatch 执行提名（planned → deferred）；6) `falseCloseRate` 指标 + 自动降权；7) TTL 回收 curator 自己的垃圾；8) 落地顺序按"先用只读插件把权限校验做对，再谈放开其它专家的写权限" |
| **Q12** | 清理专家只要一个：如何配合、如何共享 DAG 操作 | **最关键一句：没有任何 agent 拥有 DAG 的写权限。** 所有 agent 共享的是：**一份只读视图 + 一张追加式意图日志**，唯一写者是 Host 的单一执行路径。三张表：`nodes` / `project`（DAG 本体）**只有 Host 能写**；`intents`（create / defer / claim / ledger / restore）各 agent 追加、带 basis + TTL + 可撤回；`events` Host 追加、永不修改。**"如何共享操作"的答案 = 他们把"想做什么"写进意图日志，Host 串行地把意图变成状态变更；没有共享锁，没有临界区**。为什么一个 curator 够：**召回是代码做的，curator 只做裁决**（覆盖率由确定性扫描保证、吞吐由 K 对 + 频率决定）。冲突矩阵 **7** 条（create vs defer / defer 后建子 / defer vs start / create vs create / defer vs defer / claim 过期 / defer→restore 反复超 2 次）。核心仲裁：**建子节点是一种"它还活着"的投票** → pending defer 提名**自动撤回**；反向约束 **10 分钟内不可 defer**。curator 五约束（`mayExecute: []`、`age < 10 min` 不提名、单轮 ≤ 5、`falseCloseRate > 20%` 熔断、有 pending claim / review 中不 defer）。**意图必须出现在地图里**（`pending` / `claims` 带 `expiresInSec`）——"共享操作"的正面回答不是共享锁，**是共享可见性**；`t3` 是关键：**探索专家不需要收到通知，它读地图时就看到了清理结果**。权限矩阵 5 行 × 6 列，"执行任何变更"只有代码那一行。失败模式无死锁（curator 挂 = **fail-open**，重复率缓慢上升；意图积压安全因为意图只是建议）——**没有任何 agent 持有"别人必须等的资源"** | 1) `intents` 表（只追加、带 basis / TTL）；2) 冲突矩阵 7 条写成代码 + 每条一个场景测试；3) "建子节点 → 撤回 defer" 与 10 分钟免疫期；4) 地图 / `dag_walk` 行里带 `pending[]` / `claims[]`；5) 权限矩阵逐格校验（探索专家可 create + 域内改优先级、curator 只能提名、`dispatch` 只能启动、`executor` 才全能）；6) 指标：curator `nominationsApplied / nominationsProposed`（采纳率）、`falseCloseRate`（> 20% 熔断）、`coveragePerHour`；explorers `proposalsAccepted / proposals`、**`dupRateByExpert`**；system `duplicateRate`、`avgNodeAgeAtDefer`（越老说明清理越滞后） |
| **Q13** | 人类社会的争执—纠偏机制能否引入 | **可以，但引入的是"争执的结构"，不是"争执的行为"。** 不做自由辩论三理由：LLM 没有利益 / 记忆 / 问责，不会真正坚持立场；高度相关（同族模型同数据同偏差）→ **辩论常收敛到同一个错误答案且更自信**；每次冲突两次以上调用，而冲突是**廉价可生产的**。人类组织起作用的是**围绕争的程序**（事先约定决策权、事后可纠错、输了可申诉、责任可追溯），这套程序大部分能变成确定性代码。能迁移：RACI → 权限矩阵 + 冲突→裁决者映射；举证责任 → claim 必带 evidence 且 Host 校验；申诉 → `dispute` 可重开但须附**新**证据；复盘 → 预测误差复盘。不能迁移：讨价还价（LLM 没有偏好）、声誉与人际压力（模型只会顺从"说得更笃定的一方"）、多数表决（⚠️ 相关性误差）。**最大收益点：把"误解"从"争执"里拆出来**——每个意图携带 `basis:{projectRevision, snapshotAgeMs, nodesSeen}`，两个冲突意图 basis 不同 → **这不是分歧，是"看到的世界不同"** → 代码直接丢弃陈旧一方并强制重读重判，**不进入 dispute、不消耗任何模型调用**；**先做 basis 对齐，再谈冲突**（顺序反了就会用昂贵的模型调用解决廉价的时序问题）。冲突分类 8 行，**只有两行需要模型**。争执一等对象 `Dispute` + 四条纪律（立场带证据、必须有 deadline 和默认、**默认动作是"保持现状"**、resolved 后申诉须带新证据）。**纠偏的真正机制是"预测误差"**（提案写预期 +15%、实际 +2% → 生成 retro 议题；三问：为什么偏了 / 台账哪条要修正 / 提出者校准度如何）+ **轮换**（防"专家和自己的历史结论共谋"）。三个必须防的退化：不投票、**冲突必须收费**、**升级配额**（"升级如果免费，就没人自己解决问题"） | 1) `basis`（版本 + 快照年龄）随意图传——**一条字段，消掉大多数"假冲突"**；2) evidence 指针强制化；3) `dispute` 表 + 类型→裁决者映射 + 超时默认；4) 预测误差复盘（`rationale` 里加 `expected` 字段）；5) 申诉 / 轮换 / 解聘（复用专家库）；6) 每 dispute 消耗预算并计入绩效（`disputesRaised` 高而 `disputesWon` 低 = 制造噪音）；7) 到人的升级必须 `reasonCode` + 上限 |
| **Q14** | agent 的误解来自上下文压缩和幻觉，不好解决 | **这是对的；前一节的 basis 只覆盖"版本错位"这一小类。三类要分开**：事实幻觉（可完全验证 → claim 原子化 + 确定性验证器）、压缩 / 截断丢失（可设计规避 → 上下文当缓存、指针化、截断显式化）、判断错误（不可验证 → 只能靠结果反馈）。**关键：前两类不需要"让模型更谨慎"，需要"让输出机器可校验"**。现状缺陷（`host/snapshot.js`）：`report.summary` 平均 **2,886** 字符、截到 **700** → **静默丢掉 76%**；`summary` 与 `metrics` 拼成一个字符串再截断 → **摘要一长指标就整段消失**，模型甚至不知道曾经有指标；`metrics` 静默砍掉第 **7** 个以后；截断标记只有一个 `…`。事实幻觉解法：claim 拆成原子谓词（7 个）+ **提交时同步验证**（比事后审计有效得多）+ `citationErrorRate = 失败的 claim 数 / 总 claim 数` 做**权限试用期**（`< 5%` 允许不可逆动作，`> 15%` 降级为只能提名）。压缩丢失原则：**任何必须"活过压缩"的信息都不能只存在于上下文里**；四条规则（结构化写入散文只做输入 / 压缩只允许丢指针不允许改写事实 / 截断显式且可追问 / 压缩只发生在边界）。**不可逆性 ∝ 验证强度**（5 级表）。【defer】**确实解决不了的那类**（引用 5 条全真证据得出"分支已死"）只能靠：预测误差复盘 + 申诉窗口 + **降低单次决策的影响面**。投入产出 6 步：**截断显式化（10 行代码，性价比最高）** > claim 原子化 > `citationErrorRate` > 台账外置 > 分级不可逆性 > 预测误差复盘 | 1) 截断显式化（`total` 字段）；2) claim 原子化 + 提交时同步校验；3) `citationErrorRate` + 权限分级；4) 台账外置；5) 分级不可逆性；6) 预测误差复盘；7) 一句话原则写进 code review 清单：**"不以减小幻觉为目标（不可测不可实现），以让幻觉可检测、可归零、损失有界为目标"** |

**14 行。** 含 `【已部分可用】` 的题：Q4、Q6、Q11（另 Q10 有"已发生的实测证据"）。含 `【defer】` 的题：Q4（portfolio 角色可选）、Q6（有界探索最后放开）、Q11（复制能力被撤回）、Q14（第三类留给结果反馈）。

---

## 3. 附录 D 的五阶段 17 步

> 来源：§附录 D（L1961–2011）。"验证指标"列**逐字保留**原文。
> "当前状态"列的状态判定依据写在每行"依据"里：`PROGRESS.md` 的 P 编号 + `host/` 实读。

| 步骤 | 内容 | 验证指标 | 当前状态（done / todo / blocked，依据） |
|---|---|---|---|
| **1.1** | `report.summary ≤ 500` 字符（schema + prompt） | 全库存储 1.3 MB → ~200 KB | **todo**。依据：`NODE_REPORT_SCHEMA.summary` 只有 `{type:'string'}`、**无 `maxLength`**（`host/runtime.js:26`）；`host/prompts.js` 的 `WORKER_RULES` 无长度规则；快照侧仍是 `MAX_REPORT = 700`（`host/snapshot.js:8`）。PROGRESS 无对应 WP；K16 只删了无调用方的 `reportSummary()`，`报告本身仍不截断`（迁移工具注释 `scripts/migrate-domain.mjs:118`） |
| **1.2** | 截断显式化（`shown / total`） | 专家追问率 | **todo**。依据：全仓库 `grep -rn "_truncated\|shown.*total" host/ index.js` **为空**；`truncate()` 只追加一个 `…`（`host/snapshot.js:14–17`）；`metrics` 仍 `.slice(0, 8)` 无 `total`（`host/snapshot.js:125`） |
| **1.3** | `running` 补 `elapsed` / `lastActivity` | 停滞判断可行 | **todo**。依据：advisor 快照 `running[]` 只有 `startedAt` / `deadlineAt`（`host/snapshot.js:176–184`）；scheduler 快照有 `elapsedMs`（`host/snapshot.js:295`）**但没有 `lastActivity`**；节点上 `timestamps.lastActivityAt` 已在多处写入（`host/runtime.js:321 / 382 / 603 / 1211` 等），但 `onSessionEvent` 只处理 `turn/end`（`host/runtime.js:1838`）——**worker 在一次 turn 之内干了多久仍然看不见**（即 K8 未修） |
| **1.4** | 快照瘦身（`focus` 8 条 + `index`） | advisor 输入 46 KB → ~10 KB；延迟 129 s → ~40 s | **todo**。依据：`buildAdvisorSnapshot` 返回的是 `candidateParents` 全量 + `recentProposals` + `pendingProposals`，**没有 `focus` / `index` / `ledger` / `recentFailures` 字段**（`host/snapshot.js:233–260`）；`project.brief` 未截断（`host/snapshot.js:234`）。PROGRESS 未列该 WP（计划的处理方式是 P4 用导航 API 取代 `snapshot.js`，见 §5.2） |
| **2.1** | `runnable` 唯一口径（排除 deferred） | 不再误触发 `noProgress` | **done（`dd5ca19`，审计期间刚落地）**。依据：谓词抽到 `host/kernel/runnable.js`（`isRunnableNode` / `runnableQueue` / `runnableSummary`），并被**三处运行路径**引用——`host/auto.js:7,242`（`canRunPlanned` / `plannedFits` / `idleStreak` 全改用 `runnableQueue`）、`host/snapshot.js:6,271`（scheduler 快照的 `planned` 改为 `runnableQueue`）、`host/kernel/projection.js:12-14`（`runnable()` 复用它，不再各自实现）。`scripts/runnable-selftest.mjs` **11/11** 通过，其中 "a deferred node is planned but never runnable" 与 "runnableSummary counts the regression case instead of hiding it" 直接覆盖 Q5 的复现路径。**仍未做**：端到端演练（造 40 个 deferred 节点 + 3 轮空转，确认不再 `pause('noProgress')`），以及 `host/orchestrator.js:928` 与 `host/lab-service.js:744` 两处残留的 `status === 'planned'` 计数（前者是"父节点可生子"判定，后者是 UI 计数，均非派发口径） |
| **2.2** | `dispatchOnce`（无 LLM）+ 派生队列 | 启动延迟 152 s → <100 ms | **todo（在途）**：审计时工作区里正在写 `host/dispatch/dispatch-once.js`（文件头注释已写明"wired into the auto driver's 2s tick and into the runtime's termination hook"与"<100 ms for a 500-node DAG"）、`host/dispatch/round.js`（strategy 与 fast path 共用的单轮）、`host/kernel/policy.js`（`DISPATCH_POLICY`），均**未提交、未被 `auto.js` / `runtime.js` 引用**（`grep -rn "dispatch-once" host/*.js` 只命中注释）。依据（`dd5ca19` 上）：模块级已具备且测试 7/7 通过（`host/dispatch/deterministic-strategy.js`、`envelope.js`、`dispatcher.js`、`host/kernel/priority.js` 的 `fairOrder`），但 **`index.js` / `runtime.js` / `orchestrator.js` 零引用**；`applySchedulerOutput` 仍是串行 `await runtime.start`（`host/orchestrator.js:833–841`）；PROGRESS `P3.6 接入 Dispatcher = todo`（明确写"最高价值：把启动从 LLM cycle 里拆出来"）。指标不可观测（基线 cycle p50 152.3 s） |
| **2.3** | 低水位预触发 + 去抖 | GPU 空洞时长 | **todo**。依据：不存在 `host/kernel/triggers.js`；`host/auto.js:302` 仍是 `setInterval(tick, 2000)`；无 `planning` 状态、无 60 s 去抖、无事件合并；`runtime.js` 的租约泵同样 2 s 轮询（`host/runtime.js:1970–1972`） |
| **2.4** | 审查租约（review claim） | 同父并发提案数 | **todo**。依据：`grep -rn "reviewClaim" host/` **为空**；唯一的 `claim` 是派发提交点 `node.claim`（`host/kernel/mutations.js:209`），与"评审租约"不是一回事；`project.review` 只是 `{reviewedAt, reviewedHeadCommit, runId, decision}`（`host/orchestrator.js:786–792`），没有 TTL / expertId |
| **3.1** | `metainfer_lab` action 白名单（修 issue 0001） | 越权调用返回 `forbidden_action` | **todo**。依据：`ACTION_ENUM` 仍是 **49** 项（`host/agent-tool.js:5–55`，实测 49）；工具在**插件根 ctx 全局注册**（`index.js:149–152`）；不存在 `host/kernel/policy.js`；全仓库无 `forbidden_action` 错误码；`docs/issues/0001-agent-tool-scope-drift.md` 状态仍是"**待修**"、严重度"高" |
| **3.2** | 优先级四元组 + 提交点 | p0 从提交到启动 < 1 s | **todo**。依据：四元组比较已实现（`host/kernel/priority.js:55–68`，class → score 降序 → createdAt → seq，score clamp `[-1000,1000]`）；`node.setPriority` / `node.claim` 已实现（`host/kernel/mutations.js:191 / 209`）；但**未接入创建路径**（`runtime.js` / `orchestrator.js` 建节点仍直接 `store.saveNode`），`HUMAN_PRIORITY_CLASS = 'p0'` 只有声明**没有调用方**；目前只有离线迁移工具写 `priority`（`scripts/migrate-domain.mjs:98`，`user → p0`） |
| **3.3** | `dag_map` / `dag_walk` / `dag_diff` | 单轮输入 token、决策所需调用次数 | **todo**。依据：`grep -rn "dag_map\|dag_walk\|dag_query\|dag_diff" host/ index.js` **为空**；唯一入口仍是 `buildAdvisorSnapshot` 的全量推送（`host/snapshot.js:173`），`metainfer_lab` 的 `state` 仍返回全量（~325k tokens 的来源） |
| **3.4** | `claim` + `basis` + 意图日志 | 陈旧分歧占比 | **todo**。依据：`executor.commit` 已有 `basis` 陈旧判定（`host/kernel/executor.js:97–105`，只比"目标节点 `rev`"）与进程内幂等表（`:51–57`）；**不存在 `intents` 表 / 意图日志 / 审查租约表**；agent 侧输出（`ADVISOR_SCHEMA` 的 proposals）**不带 `basis`** |
| **4.1** | 专家描述符 + 绩效指标 | — | **todo**。依据：不存在 `host/experts/registry.js`；专家仍以 `project.config.advisor.reviewers[]`（lens + model）表达（`host/orchestrator.js:879–897`），无身份 / 状态 / 预算 / 绩效字段；`K17` 未修（`host/orchestrator.js:768,774` 仍写 `createdBy: 'advisor'`，不记 lens / 专家） |
| **4.2** | 相似度召回（纯函数） | 精度 / 召回（人工标注 30 组） | **todo**。依据：不存在 `host/experts/similarity.js`；无 `tags` 字段的运行时写入（`tags` 只出现在迁移工具的 `--enrich` 入参与输出，`scripts/migrate-domain.mjs:27,136`）；无 LSH / MinHash 代码 |
| **4.3** | curator（只读 + 只提名）+ 误杀率熔断 | `falseCloseRate` | **todo**。依据：不存在 `host/experts/curator.js`；`grep -rn "curator" host/` 只有 `host/kernel/trace.js:12` 的 `ACTOR_KINDS` 常量里出现该字符串；无 `nomination` 概念、无 `falseCloseRate` 计算 |
| **4.4** | 「建子节点自动撤回 defer」 | 仲裁人工介入次数 | **todo**。依据：无 defer 提名机制（`deferred` 只存在于 kernel 的 `priority` / `mutations` / `projection`）；无 `nomination/withdrawn` 事件；无 10 分钟免疫期 |
| **4.5** | 专家库 UI（入职 / 解聘 / 排空） | 专家绩效可读 | **todo**。依据：`client.js` 有"专家组 · N 运行中"的运行态 chip 与 `ws.experts.*` 文案（`client.js:1367–1378`），展示的是 advisor / reviewer / scheduler / GC 的**后台运行**，**不是**可入职 / 解聘 / 排空的专家名册；无 `hire / drain / retire` 操作入口 |
| **5.1** | `claim` 谓词化 + 同步校验 | `citationErrorRate` | **todo**。依据：不存在 `host/kernel/verifier.js`；7 个谓词无实现；无 `citationErrorRate`；claim 目前只是 proposals 里的 `rationale` 散文 + `expectedInfoGain`（`host/orchestrator.js:88`） |
| **5.2** | `dispute` 表 + 裁决者映射 + 超时默认 | 升级到人的次数 | **todo**。依据：不存在 `disputes` 表；无 8 类冲突 → 裁决者映射；无 `deadlineAt` / 默认"保持现状"；`grep -rn "dispute" host/` 只有 `ACTOR_KINDS` 里的 `arbiter` 字符串 |
| **5.3** | 预测误差复盘 | 预测 vs 实际偏差分布 | **todo**。依据：无 `expected {metric, direction, magnitude}` 字段（`expected` 的现有命中是 `expectedInfoGain` 与错误消息里的字面量，不是该字段）；无 `retro/opened` 事件；无偏差阈值 |
| **5.4** | 分层评审（如需要） | 覆盖率 / 压缩比 | **todo**（**blocked-by-decision**：计划 D7 已改为"作用域分区 + 升级路由，不做固定三级"，QA 附录 C 的 C4 仍在问"三级是否过重"，两侧未闭环 → 开工前必须先裁决，见 §5.2）。依据：无三级评审代码；`reviewers[]` 仍是"多个 lens 读**同一份** snapshot"（`host/orchestrator.js:879–897`，即 Q8 说的"冗余投票"） |

**汇总：done 0 / todo 17 / blocked 0（5.4 为待裁决的 todo）。**

**怎么读这个 0：** P1.1–P1.5、P3.1–P3.5 的模块、以及 `scripts/kernel-selftest.mjs`（15 项）、`dispatch-selftest.mjs`（7 项）、`gang-planner-selftest.mjs`（14 项）、`migrate-domain-selftest.mjs`（11 项）都通过了——**它们是 2.2 / 2.1 / 3.2 的底层零件**，但附录 D 每一步的验证指标**一个都还没有被观测过**。唯一已经发生的"线上收益"是 PROGRESS 记录的 2026-11-10 割接后第一个 cycle（`created 0–1 → 2`、`started 1 → 10`、`planned 39 → 31`），它来自 K7 修复（提案宽度），**不对应附录 D 的任何一步**。

---

## 4. 附录 C 的 14 个开放问题

> 来源：§附录 C（L1928–1958）。"原文要点"保留原句关键措辞（数字与字段名不改）。
> "现状"分三档：`未决`（QA 内没有答案、外部计划也未回答）/ `部分已答`（外部计划给了提案但阈值 / 参数未定，或只回答了一半）/ `已有提案答案`（外部计划明确给了方案，但仍属"默认"而非"已定"，且未实现）。

| C | 开放问题（原文要点） | 现状（是否已有答案） |
|---|---|---|
| **C1** | **B6/B7 是否真的消除了复杂度？** prune 退化为优先级之后，"deferred 节点永远留在 DAG 里"会不会在长跑中积累成噪声（**1000 节点里 700 个 deferred**），从而让地图本身失效？ | **已有提案答案（未实现）**。专家计划附录 A.2 C1 的回答：`deferred` 超过 `deferredTtl`（**默认 7 天**）→ `node.archive`（`archivedAt`），从 Projection 热索引移出，地图上只显示聚合计数；`maxNodes` 只统计热节点，另设 `maxDeferred` 与归档配额。**该回答同时引入了 QA 没有的"归档层"，属对 B6 的扩展，需确认**。代码：无 archive 字段（`grep archivedAt host/` 为空） |
| **C2** | **B12 的单点 chief 是否是正确选择？** 它被设计成"例外仲裁者"，但例外定义的漂移（触发码被滥用）会不会让它事实上变成审批闸门？ | **已有提案答案（未实现）**。计划 C2：arbiter **不可见**（其他专家看不到它、不能"找它批准"）+ 每个专家每个 epoch 升级配额 + 升级率监控（升级数 / 意图数，超阈值告警并收紧触发码）。**注意：计划 D7 已不采用固定三级，C2 的答案建立在"还有 arbiter"这一前提上，与 D7 张力见 §5.1** |
| **C3** | **B16 驻留会话的代价是否被低估？** 上下文累积、compaction 丢失、成本不可预测——有没有更简单的替代（例如每次仍是一次性激活，但限 3 次批量检索）？ | **已有倾向性答案，但方向相反**。计划 D6 直接选择"**无状态激活 + 外置笔记本 + 事件游标**，不用驻留会话"，等于用"不做 B16"回答 C3；状态是**默认**（非"已定"），负责人可推翻。**这是全文最重要的一处未闭环：QA 的 B16 与计划的 D6 正面冲突，见 §5.1** |
| **C4** | **三级分层是否过重？** 两级（branch + lead）是否足够？什么条件下才值得引入 chief？ | **已有提案答案（未实现，且与 D7 冲突）**。计划 D7：改为"作用域分区 + 升级路由"，**不做固定三级**；"什么条件下引入 chief"这个问题**没有正面回答**（等于回避）。QA 侧也未回答。→ **部分未决** |
| **C5** | **B9 的"代码执行"边界在哪？** 代码能执行 create/defer/cancel，但"改方向"这类语义动作仍需专家，会不会出现"代码无法执行、专家无权执行"的空档？ | **已有提案答案（未实现）**。计划 C5：语义动作由专家以意图提出、代码执行；无法以意图表达的动作升级到 arbiter 或人。**空档存在于"意图种类没覆盖到的语义动作"，计划没有枚举该集合** → `需确认` |
| **C6** | **B24 的谓词化验证覆盖度如何？** 估计能覆盖 **90%** 的事实性 claim，剩下 **10%** 怎么办——拒绝、降权、还是允许但标记？ | **已有提案答案（未实现）**。计划 C6：允许提交但标 `infer`、**不计入证据**（P6.1）。**"90%" 这个估计没有被任何实测支撑** → 数值 `需确认` |
| **C7** | **`citationErrorRate` 门控权限是否会被对抗性利用？** 专家可以通过"少给 claim"来降低错误率（分母变小），如何防止？ | **已有提案答案（未实现）**。计划 C7：用 **Wilson 下界** + 按"已验证证据数"加权 + 按不可逆等级要求**最少证据**（B27）。代码：无 |
| **C8** | **B20 的"建子节点即投票"会不会鼓励刷节点？** 愿意建节点的专家等于获得了"保住分支"的票权，是否需要配额？ | **已有提案答案（未实现）**。计划 C8：投票**计权**——子节点通过查重、专家预算未超才计；**同一专家对同一节点只算一票**；另加配额。代码：无 |
| **C9** | **重复检测的语义判定错误代价不对称**：误杀一个合法实验的成本 vs 放过一个重复实验的成本，阈值应该定在哪？ | **部分未决**。计划 C9 给了处理方式而非阈值：planned 的 defer 阈值放宽、running 的 cancel 需 arbiter、completed 只标记。**判定阈值本身仍未定**（QA/Q10 的 `falseCloseRate > 20%` 是**熔断**阈值，不是"判重"阈值）→ 阈值 `需确认` |
| **C10** | **专家数量与成本的可控性**：多专家 + 多轮查询 + 争议处理，token 成本会不会超过"多做几次实验"的成本？需要什么样的预算模型？ | **部分未决**。计划 C10：令牌桶（`tokensPerHour`）+ `queriesPerActivation` + **全局规划预算按实验 GPU 小时的 X% 折算**——**X 未定**；"超预算时票据推迟而不是丢弃"已定 → X `需确认` |
| **C11** | **curator 的调用频率如何确定？** 固定间隔 vs 候选对数量触发 vs 队列压力触发？ | **部分未决**。计划 C11：**候选对数量触发 + 最大间隔兜底**（P4.5 的 `duplicateCandidates` 规则：新增 LSH 候选对 ≥ K 或距上次超过最大间隔）。**K 与最大间隔未定**；QA Q11 描述符示例里的 `interval:15m` / `duplicate.candidates>=5` 是**示例值不是决策** → K / 间隔 `需确认` |
| **C12** | **如何衡量"改造是否成功"？** 候选指标是"时间加权平均并发"（**2.83 → ?**）和"GPU 空洞时长"，是否足够？是否需要"单位 GPU 小时的产出"这类归一化指标？ | **部分已答**。计划 §13.2 采纳了"**单位 GPU 小时产出**"（每 GPU 小时完成的节点数、指标提升），作为 C12 的回答；但目标值只写"相对基线提升"，**没有绝对值**（"2.83 → ?" 依然没有答案）；基线记录在 `docs/refactor/baseline.json` 的 WP（P0.8）**仍是 todo**（PROGRESS 未列，`docs/refactor/baseline.json` 不存在）→ 目标值 `需确认` |
| **C13** | **专家绩效指标是否会导致 Goodhart 效应？** `proposalsAccepted` 会不会鼓励提保守的、容易成功的提案？ | **已有提案答案，但与 QA 自身冲突**。计划 C13：**不看采纳率**，改看归因到该专家的最佳指标提升 / 台账确认与否定条数 / 预测校准度 / `dupRateByExpert` / `disputesRaised` 与 `disputesWon`。**但 QA §Q4-4-6 明确把 `accepted` 列为绩效字段**（`proposals / accepted / completed / pruned / costUsd / avgCycleLatency`）→ 两侧不一致，见 §5.3 |
| **C14** | **能否分阶段迁移而不停机？** 现有 `cycle` 语义与新 `dispatch/planning` 双环能否共存一段时间？ | **已答（方案层面），但实际割接不是"不停机"**。计划 §12：每阶段一个开关（`dispatch.strategy` 先 `legacy-llm` + `shadow=deterministic` 跑一周 → 再切 `deterministic`；`experts.mode` 新项目 `runtime` / 旧项目 `legacy-cycle`；`contest.mode` `off → shadow → consensus`）+ S14 遗留对等场景。**P1 例外：写者逐文件迁移"无开关"，只靠 S14 保证零行为变化**。实际割接记录（PROGRESS 2026-11-10）："**10:04:28 Host 重启完成，v2 域上线**"——是**停机重启**，不是不停机迁移 |

**14 行。** 分布：`未决` 0 / `部分未决` 4（C4、C9、C10、C11）/ `部分已答` 1（C12）/ `已有提案答案` 8（C1、C2、C5、C6、C7、C8、C13、C14）/ `方向相反的答案` 1（C3）。

---

## 5. 矛盾与缺口

> 只列"两侧文本对撞"或"一侧有、另一侧没有"的条目，每条都给章节号与代码证据。**判定口径**：`矛盾` = 两侧给出不同结论；`缺口` = QA 已决定但计划无 WP；`不一致` = 计划文本与当前代码 / PROGRESS 不符。

### 5.1 附录 B ↔ 计划 §5 / 附录 A.1 的直接冲突

| # | 冲突 | QA 侧 | 计划侧 | 性质与后果 |
|---|---|---|---|---|
| **5.1.1** | **专家形态：驻留会话 vs 无状态激活** | §Q9-3（L1137–1145）"**必须承认的机制改动：一次性单发 → 驻留会话**"；§附录 B **B16**（L1913）"专家从一次性单发改为驻留会话 + submit 工具"（⚠️ 标记） | §5 **D6**（L233）"专家形态：**无状态激活 + 外置笔记本 + 事件游标**，不用驻留会话（回答 B16 / C3）"；附录 A.1 B16（L1437）"**修改**为无状态激活 + 笔记本 + 游标" | **正面矛盾**。计划版更省上下文、可预测成本；QA 版能做多步验证。**C3 因此无闭环**（计划用"不做"回答）。若采纳 D6，Q9 的"每轮 4 次调用 / 50–60 KB"与 Q9-3 的 compaction 纪律都要重写；若采纳 B16，P4.2 / P4.4 的注入方式（`dag_diff` 游标 + 笔记本）失去意义 |
| **5.1.2** | **`report.summary` 是否在源头截断** | §Q14-3（L1715）实测 2,886 字符被截到 700、静默丢 76%；§附录 B **B26**（L1923）"`report.summary` 限制 ≤ 500 字符"；§附录 D **1.1**（L1969）"`report.summary ≤ 500` 字符（schema + prompt）" | §5 **D16**（L243）"`report.summary` **不在源头截断**，新增 `headline`（≤ 300 字符）用于索引（**反对 B26**）"；附录 A.1 B26（L1447）"**反对**；改为新增 `headline`（D16）"；P6.6（L1220–1222） | **正面矛盾**。现状很有意思：**迁移工具已经按 D16 实现了 `headline`**（`scripts/migrate-domain.mjs:101–107,134–135`，首次有意义行 + 截 300），但**运行时 schema 既没有 `headline`、也没有 `summary` 上限**（`host/runtime.js:26`）——即**两侧都还没落地**，而离线数据已经先有了 D16 的形状 |
| **5.1.3** | **专家层级：三级 vs 不做固定层级** | §Q8-3（L979–1012）完整定义 L0/L1/L2 与预算；§附录 B **B11**（L1908）"专家分三级（branch / lead / chief），低层不能物化节点"；§附录 D **5.4**（L2009）"分层评审（如需要）" | §5 **D7**（L234）"组织方式：**作用域分区 + 升级路由**，不做固定三级层级（回答 B11 / B12 / C4）"；附录 A.1 B11（L1432）"**修改**为作用域分区 + 升级路由"；P5.5（L1168–1172） | **正面矛盾**。后果：**附录 D 5.4 在计划里没有对应 WP**（P0–P7 无一项做分层评审），Q8 的 6 个上报码只剩 1 个（`escalation`）有落点；C4"两级够不够"因此无人回答 |
| **5.1.4** | **dispatcher 是否允许 LLM** | §Q4-2（L559–571）"调度器不应该有判断权"；§附录 B **B10**（L1907）"**dispatcher 不含 LLM**；scheduler 的判断权上移给专家" | §5 **D3**（L230）"Dispatcher 是**可插拔接口**，将来可以是跨机器争论的 LLM agent"；§6.2（L286）"scheduler LLM 归 Dispatcher…旧行为保留为 **`LegacyLlmStrategy`**（兼容开关）"；P3.6-3（L943）、P4.8（L1113–1115）、P7.3（L1254–1260） | **字面矛盾、语义可调和**：默认确定性 + LLM 策略可插拔且受安全包络约束。但 B10 的原话"dispatcher 不含 LLM"在计划里被明确改成"确定性**默认** + LLM 可插拔"，**需要负责人确认这是对 B10 的修订而不是遗漏** |
| **5.1.5** | **defer 提名是否必须带证据** | §Q14-4（L1800–1806）表：提名 defer = 完全可逆、要求 **1 条已验证证据**；§附录 B **B27**（L1924）"不可逆动作的验证强度分级" | P2.2 L1 行（L881）："**建 planned 节点、改优先级、defer planned、写笔记本**" → 只要求"能力表允许"，**0 条证据**；L2 才要"至少 1 条已验证证据" | **数值矛盾**。QA 要求 defer 也要 1 条证据，计划的 L1 是 0 条。按 B27 原文，defer 属于"完全可逆"但仍需 1 条；计划把它降到 L1（无证据）→ **门槛被降低，需要确认** |
| **5.1.6** | **"提交点"在哪个状态 / 字段** | §Q3 机制 A（L493）"节点进入 **`starting`**（占住槽位）后，优先级修改只影响下一次派发"；§Q5 修订后模型（L720）状态机 = `planned / running / completed / failed / cancelled`（**无 `starting`**） | §7.2（L367）/附录 A.1 B4（L1425）："提交点 = **`node.claim`**"；`NODE_STATUSES` 实为 **6** 个，含 `proposed`（`host/kernel/mutations.js:15`） | **术语与状态集合三处不一致**：QA 正文说 `starting`、QA 模型说 5 状态、代码/计划是 6 状态 + `claim` 字段。**B4 的"提交点"应以 `node.claim` 为准，但 QA 的 `starting` 必须删掉或改写**，否则实现者会去找一个不存在的状态 |

### 5.2 附录 D ↔ 计划阶段（P0–P7）的冲突：顺序、指标、缺 WP

| # | 冲突 | QA 侧 | 计划侧 | 性质与后果 |
|---|---|---|---|---|
| **5.2.1** | **启动延迟目标差 10 倍** | §附录 D **2.2**（L1979）"启动延迟 **152 s → <100 ms**" | §13.2 指标（L1370）"派发延迟 runnable → claimed：**本地 < 1 s**、集群 < 3 s"；不变式 **I15**（L1326）"p0 节点从提交到 claim **< 1 s**" | **数值矛盾**。< 100 ms 是"容量算术 + CAS 应该有多快"的工程目标；< 1 s 是可观测的 SLO。**验收时用哪个？需确认**（建议：I15 作为验收线，100 ms 作为设计目标，两者都记录） |
| **5.2.2** | **阶段顺序：事实层快速收益 vs 内核先行** | §附录 D 结尾（L2011）"**阶段 1 与 2 不依赖任何新 agent**，且**阶段 1.4 单独就能把 advisor 延迟从 129 秒降到 ~40 秒——可以先验证收益，再决定是否继续**" | §10（L712）"**P1 是所有后续阶段的硬前置**"；§3.1（L168）`snapshot.js` 的去向是"**被导航 API 取代，保留给兼容层**"（P4 之后），即 1.4 被推到 P4 | **顺序矛盾**。QA 主张"先摘低垂果实再决定是否重构"，计划主张"先建内核"。后果：**1.1 / 1.2 / 1.4 在计划里没有任何 WP**（只有 K8 的 `lastActivityAt` 部分覆盖 1.3），QA 承诺的"单独一步降 129 s → 40 s"在计划里**无法按序执行** |
| **5.2.3** | **附录 D 阶段 1 全部无 WP** | §附录 D 1.1–1.4（L1965–1972） | P0–P7 中 **没有** 对应"report 长度 / 截断显式化 / running 进度 / 快照瘦身"的 WP；最接近的是 P4.6（删 `reportSummary`，K16）、P6.6（`headline`，D16）、P4.3（`_truncated`，B25） | **缺口**。4 步里有 3 步依赖"计划不打算做的事"（B26 被反对、快照被导航 API 取代）；只有 1.3 的 `lastActivityAt` 落在 P4.5（K8） |
| **5.2.4** | **附录 D 阶段 5 的 5.4 无 WP** | §附录 D 5.4（L2009）"分层评审（如需要）" | 无对应 P 阶段（D7 已取消固定层级） | **缺口 + 需裁决**（同 5.1.3）。当前状态按 `todo（blocked-by-decision）` 记 |
| **5.2.5** | **映射表缺失** | 附录 D 17 步 | 计划 P0–P7 共 60+ 个 WP | **缺口（流程性）**。两套编号之间**没有映射表**：`PROGRESS.md` 只记 P 编号，导致"附录 D 某步是否完成"无法从进度表直接读出（本文档 §3 就是为补这个洞）。建议在 `PROGRESS.md` 增列一个"附录 D 步骤 ↔ WP"列 |

### 5.3 QA 已决定、计划没有覆盖的具体条目（缺口）

| # | QA 条目 | 内容 | 计划覆盖情况 | 后果 |
|---|---|---|---|---|
| **5.3.1** | §Q3 机制 B（L500） | WIP 上限：`maxPlannedInFlight = max(2 × freeSlots, 4)`，超了**跳过 advisor pass** | **无 WP**（P4.6 只改提案上限 `maxProposalsPerActivation`，不是"超载就跳过规划"） | 队列膨胀（63 节点 / 并发 2.83 / plan 排 3 小时）没有确定性闸门 |
| **5.3.2** | §Q3 机制 C（L509） | `reservedSlots.p0`（默认 **0**）；有 p0 等待且无空槽 → 允许抢占 `p2/p3` 且**已跑 > 10 min** 的节点 | **无 WP**。计划只有**集群级**抢占（P3.5.9，`cluster.preemption.enabled` 默认关闭），没有"项目内 p0 抢占"；`reservedSlots` 在计划全文未出现 | p0 保底只剩"快路径"，没有"保底槽位"；空闲度不足时 p0 仍要等 |
| **5.3.3** | §Q3 机制 C L3（L510） | p0 等待 **> 30 s** 发事件 `priority/delayed {blockedBy, 预计剩余}` | **无 WP**；计划 §13.1 事件目录（L1350–1362）**没有 `priority/delayed`** | "可解释性"缺失——而 QA 明说"L3 最易被忽略，但决定人信不信这个系统" |
| **5.3.4** | §Q3 机制 D（L517） | CFS 权重 `weight: human = 100, advisor = 10` | 计划 `fairOrder(nodes, usageBySource)` 的 **weight 默认 1**（`host/kernel/priority.js:91–93`）；真实统计 `usageBySource` 是 P3.4 的"**待补**"项（L933） | 公平份额目前是"等权 + 空统计"，与 QA 的 100:10 相差一个量级 |
| **5.3.5** | §Q4-4-5（L614） | 邀请专家：**深度 ≤ 1**、范围限定（一个问题）、预算封顶、回答完即退场、可见 | **无 WP**（P4.1 只有 hire/drain/retire/handover，没有"临时邀请"形态） | 专家不能临时借调，硬编码成"在职列表"一种形态 |
| **5.3.6** | §Q4-4-2（L604） | 离职后归属不能悬空：**转给 `human`**，并标注"**孤儿节点**" | **无 WP**。P5.5 只说"专家 retire 时其分支转交"（转给谁没写）；`human` 兜底与"孤儿节点"标记缺失 | 专家离职后节点归属可能悬空；`createdBy` 指向不存在的专家 |
| **5.3.7** | §Q2 建议 P2（L447） | **真 join 原语**：merge 在父节点全部 completed 时**自动触发** | **无 WP**（`finish_merge` 仍要人 + `MERGE_HEAD`；`host/agent-tool.js:35`、`host/http.js:307`、`host/git-engine.js:295`） | 多父合并仍是"隐形的人肉 join"，收尾场景的 GPU 空洞无人解 |
| **5.3.8** | §Q2 建议 P1（L446） | advisor 180 s 超时**正好卡在 p90**，需提高超时或裁剪快照 | **无显式 WP**（P4.6 只删 "prefer 1"、改上限）；当前默认仍是 **180 s**（`host/orchestrator.js:367`、`:18` `ROLE_RUN_TIMEOUT_MS = 180_000`） | 22% 的 advisor 失败率不会被这项改动降低（只有 1.4 快照瘦身能降） |
| **5.3.9** | §Q4-5 六条确定性触发（L621–628） | 队列超载 `planned > 2×freeSlots` 持续 5 min / 停滞 15 min / 重复失败 3 次 / **专家无效连续 5 次被拒** / **预算告警 > 80%** / **方向收敛连续 3 节点失败** | 计划 P4.5（L1084–1096）9 条规则里：`lowWater` 用**完全不同的口径**（`timebox 总和 < 规划延迟 p90 × 1.5`）、`stall` 近似"停滞"；**"专家无效 / 预算告警 / 方向收敛"三条完全没有对应规则**，其阈值（5 次 / 80% / 3 节点）在计划中均未出现 | 4/6 条 QA 触发条件没有落点；两条"有"的口径也不同 → 触发行为不可对齐 |
| **5.3.10** | §Q8 全部（L979–1077） | 三级评审、6 个上报码、证据指针强制、L2 强制抽查、深度 ≤ 3、每层 ≥ 3x 压缩、动态编组 `ceil(活跃分支/2)`、`createdBy`/`ratifiedBy`/`evidenceChain` | 只有 `escalation` 触发码（P4.5 的 `escalation` 规则）与"升级"概念被保留；**其余全部缺失**（D7 取消了三级） | Q8 的整章内容在实施路径上没有归属 → 5.4 无法验收 |
| **5.3.11** | §Q11-6（L1428–1430） | **谁清理清理者：确定性 TTL**（提名、query 缓存、claim、解聘后残留会话） | **无显式 WP**（P5.6 只写 curator 运行约束；TTL 只在 `claims` 表设计里出现） | curator 自己的垃圾无回收路径 |
| **5.3.12** | §Q13-6（L1678） | **轮换**：同一专家同一分支**超 N 天** → 确定性轮换 | P6.5 有"轮换"但没有 **N**，也没有轮换的判定代码 | 阈值未定 → 无法实现（`需确认`） |
| **5.3.13** | 前序 1 §4.2（L198） | "**别让强模型贴着 GPU 跑循环**"：让便宜的本地 observer 持有 MCP 连接、每 60 s 长轮询、只在 `stalls` / `starving` / `pauseReason` 命中时升级强模型 | **无 WP**（P2.3 只做 MCP 控制面 + `watch_events` + `get_overview`；observer 本身与"升级触发条件"没有工作包） | 外部监控模型会"每次看一眼都烧一遍 60 个节点的快照"——正是 Q2/Q6 要消除的成本 |
| **5.3.14** | 前序 2 §下一步（L305–307） | 外部监控模型作为 **L7 观测层**：接入点**只能挂 L2 门面**（不能挂 L1，否则两个控制者打架）、需要**仲裁规则（谁能 start/stop）**、"过程可见"怎么落到 L4/L5 | **无 WP**。计划 P7.6 是 **peer broker**（跨信任域租约结算），不是"外部模型观察 + 有限写权限 + 与 L1 的仲裁" | 前序 1–2 的整个交付目标（外部强模型监控）在计划的 60+ WP 里**没有对应项**，只在 P2.3 有"MCP 写能力"这一半 |
| **5.3.15** | §Q6-7 落地顺序（L864–870）| 5 步：running 进度 → 快照瘦身 → `dag_query` → **`ledger`** → 有界探索 | `ledger` 排在计划 **P6.2（最后阶段）**，而 QA 把 ledger 排在第 **4** 步（早于有界探索） | **顺序冲突**：QA 认为"台账比查询工具更值钱"，计划把它放到 P6 |
| **5.3.16** | §Q6-4 / §Q9-4 工具集 | Q6 提 `dag_query({filter, select, limit, cursor})`；Q9 与附录 B B15 只列 `dag_map` / `dag_walk` / `dag_get` / `dag_diff`（**无 `dag_query`**） | 计划 §7.9 用**并集**：`dag_map` / `dag_walk` / `dag_get` / `dag_diff` / **`dag_query`** / `trace_explain` / `resource_status` | **QA 文档内部不一致**（Q6 vs Q9/B15）；计划选了并集，等于替 QA 做了决定 → `需确认` 是否接受 7 个工具而非 4 个 |

### 5.4 计划文本 ↔ 当前代码 / PROGRESS 的不一致

| # | 位置 | 不一致 | 证据 |
|---|---|---|---|
| **5.4.1** | 计划 §8.3-3（L670）与 §8.1 | 计划仍写"**事件不改写**：旧事件没有 `actor`/`commit` 字段，**读取方必须容忍**"；实际项目决定是**离线迁移工具规范化旧事件**（补 `actor.kind='legacy'`、`commit=null`、`revision=0`、`legacy=true`），插件**零 v1 兼容代码** | `spikes.md` S4（L35–60）；`PROGRESS.md` 偏差 1（L46–52）；`host/store.js:24–33`；`scripts/migrate-domain.mjs`。**计划文本未同步**（仓库内 `docs/07` 与外部计划逐字相同） |
| **5.4.2** | 计划 §14 / D15 | 计划说 S3 结论"见 §14；**D15 在此确认**"，但 spikes.md 只回答了"DSH 无文件级 GC / 无保留策略"，**D15 仍是"需确认"**；实际用新增 WP **P0.9**（会话保留 + 冷存归档，按天/字节双阈值，删前登记事件）来兜 | `spikes.md` S3（L62–75）；`PROGRESS.md` L23（P0.9 todo）+ 偏差 2 |
| **5.4.3** | 计划 §10 P0 验收（L780） | P0 验收要求"**P0.2、P0.3 测试通过**；四个 spike 结论写入；D15 已确认；基线指标已记录"；实际 **P0.2 / P0.3 / P0.9 / P0.8 全部 todo**，而 P1.1–P1.5 / P3.1–P3.5 已经先落地 | `PROGRESS.md` L23–25、L26–32；`docs/refactor/baseline.json` **不存在**（P0.8 基线指标未落盘，C12 因此无法回答） |
| **5.4.4** | 计划 §3.1 文件地图 | 行数与实际不符（`lab-service.js` 写 2,656 / 实际 2,735；`runtime.js` 写 2,037 / 实际 2,049；`orchestrator.js` 写 1,261 / 实际 1,294），且说 `snapshot.js` 315 行 / 实际 307 | `wc -l host/*.js`。**轻微**，但"文件地图"是执行者的第一入口，过期会误导改动范围判断 |
| **5.4.5** | 计划 §8.1 `events` 表 + §8.4 | 计划承诺事件"永久保留 + 冷段归档（> 50,000 条时把最早 10,000 条写 `eventlog/<projectId>/seg-*.jsonl.zst` + sha256）"；实际只做了**不删除**（`EVENT_RETENTION` 已删），**冷段归档与 `eventlog.js` 不存在** | `host/store.js:209` 只有 `deleteEventRecord`；`kernel/eventlog.js` MISSING；`PROGRESS.md` L27（P1.2 todo："`recover()` 目前一次性加载全部尾部事件"） |
| **5.4.6** | 计划 §3.2 缺陷表 K 编号 | K1/K2 已修（补丁）、K16 已修（`76c8eed`）、K7 已修（`fc81e2b`）、K15 **半修**（只删 persona 引用）；**K3 / K4 / K5 / K6 / K8 / K9 / K10 / K11 / K12 / K13 / K14 / K17 / K18 全部未修** | 逐一核对：K3 锁外写仍在（`host/auto.js:82–87` `saveEvent` 手工 `project.revision += 1`）；K4 `listNodes` 仍全表扫描；K6 = issue 0001 待修；K8 `onSessionEvent` 只处理 `turn/end`（`host/runtime.js:1838`）；K17 `createdBy: 'advisor'`（`host/orchestrator.js:768,774`）；K18 `starts.slice(0,20)` + 串行 start（`host/orchestrator.js:833–841`） |

### 5.5 一句话总结

**设计侧（QA）与执行侧（计划）在四个点上正面冲突：专家是驻留还是无状态（B16 vs D6）、摘要该截还是不该截（B26 vs D16）、专家该分三级还是分区（B11 vs D7）、dispatcher 能不能有 LLM（B10 vs D3）。这四个点各自都改变了 P4/P5/P6 的代码形状，必须在开工前裁决。**

**同时，QA 附录 D 的"事实层"（1.1–1.4）在计划里没有 WP，而它恰恰是唯一"不改架构就能把 129 s 降到 40 s"的部分；计划把它的替代品（导航 API）推到了 P4。这是两份文档之间最大的路径差异。**

---

## 附录 E · 代码证据索引（本文档自建）

> 供复核上表每一行。路径相对 `dsh-metainfer-research-lab/`；分支 `refactor/async-foundation` @ `a9457d2`。

| 证据 | 位置 | 证明了什么 |
|---|---|---|
| 内核 / 派发模块零引用 | `grep -rn "kernel/\|dispatch/" host/*.js index.js` → 空 | §0 判定规则 1：所有 P1/P3 模块都是"模块级"，未接入 |
| 49 个 action，全局注册 | `host/agent-tool.js:5–55`、`index.js:149–152` | B1 / §3.1：无白名单，issue 0001 未修 |
| 13 个 MCP 工具 | `grep -c "server.registerTool" host/mcp.js` → 13 | 前序 1 §1 的"1 写 + 12 读"仍成立；P2.3 未做 |
| 22 路由 + 29 命令 | `grep -c "router\." host/http.js` → 22；`grep -c "if (type === '"` → 29 | 前序 2 §L2 的"22 GET + 29 命令"仍成立 |
| 无 `_truncated` | `grep -rn "_truncated" host/` → 空 | §3 1.2 / B25 未落地 |
| 快照仍全量 | `host/snapshot.js:233–260`（`candidateParents` + `recentProposals` + `pendingProposals`，无 `focus` / `index` / `ledger`） | §3 1.4 / B15 未落地 |
| `MAX_REPORT = 700` | `host/snapshot.js:8,124` | §3 1.1 / B26 未落地（仍是 700，不是 500） |
| `NODE_REPORT_SCHEMA.summary` 无 `maxLength` | `host/runtime.js:24–49` | §3 1.1：源头没有长度约束 |
| 报告写入不截断 | `host/runtime.js:850–905`（`persistNode('node/completed')` 前无 `report.summary` 处理） | B26 未落地（也是 D16 的现状：两边都没做） |
| `auto.js` 仍用旧口径 | `host/auto.js:238,257,271,279` | §3 2.1：`runnable` 唯一口径未接入；`noProgress` 复现路径仍在 |
| 2 秒轮询 | `host/auto.js:302`；`host/runtime.js:1970–1972` | §3 2.3：无事件驱动 / 无低水位预触发 |
| 串行 start | `host/orchestrator.js:833–841` | §3 2.2 / K18：dispatcher 未接入 |
| `runnable` 已定义但无调用方 | `host/kernel/projection.js:149–155` | B8 的零件在，接入不在 |
| `fairOrder` weight 默认 1 | `host/kernel/priority.js:89–98` | §5.3.4：不是 human=100 / advisor=10 |
| `deferred` 只是 class | `host/kernel/priority.js:14–17,71–73`；`host/kernel/mutations.js:215–217` | B6 / B7 的零件在 |
| `claim` 是派发提交点 | `host/kernel/mutations.js:209–231` | B4 / §3 3.2 的零件在；`reviewClaim` 不存在（§3 2.4） |
| `basis` 陈旧判定 | `host/kernel/executor.js:97–105` | B21 / §3 3.4 的零件在；无 intents 表 |
| 幂等是进程内 Map | `host/kernel/executor.js:51–57` | P1.3 待补项（计划 L804） |
| 无 `lastActivity` 的会话级更新 | `host/runtime.js:1838`（`if (event?.type !== 'turn/end') return;`） | §3 1.3 / K8 |
| `createdBy: 'advisor'` 不记 lens | `host/orchestrator.js:768,774` | K17（计划 P4.6 未做） |
| 多 lens 读同一份 snapshot | `host/orchestrator.js:879–897` | §3 5.4：仍是 Q8 说的"冗余投票"，不是切片 |
| 唯一专家名册是 `reviewers[]` | `host/orchestrator.js:879` | Q4-3 "系统里其实已经有专家库" |
| 无 `host/experts/*` | `ls host/experts` → No such file | §3 4.1–4.5 |
| `headline` 只在迁移工具里 | `scripts/migrate-domain.mjs:101–107,134–135` | §5.1.2：D16 的形状先出现在离线数据里 |
| `priority` 只在迁移工具里写 | `scripts/migrate-domain.mjs:98,126–133`（`user → p0`、`seed → p1`、`advisor → p2`） | §3 3.2：运行时创建路径还没有 p0 默认 |
| 事件永不删除（但无归档） | `host/store.js:36–41,209`；无 `kernel/eventlog.js` | §5.4.5 |
| v2 干净断代 | `host/store.js:24–33`；`scripts/migrate-domain.mjs` 存在 + 11 项自测 | P1.10 已按偏差 1 落地 |
| 测试全绿 | `npm test` → kernel 15/15、gang 14/14、dispatch 7/7、migrate 11 项、cluster/placement PASS | §0 判定规则 3：只证明纯函数 |
| 无 `docs/refactor/baseline.json` | `ls docs/refactor/` → `PROGRESS.md`, `spikes.md`, `DESIGN-CHECKLIST.md` | P0.8 未做 → C12 无基线 |
