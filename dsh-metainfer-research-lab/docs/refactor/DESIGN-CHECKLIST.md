# 设计决策落地检查清单

| | |
|---|---|
| **文档性质** | 审计用检查清单。把设计问答实录里的每一条决策、每一个结论、每一个阶段步骤摊平成可勾选、可验证的行 |
| **权威来源（设计）** | [`metainfer-async-architecture-qa.md`](/root/mqa_baseline/metainfer-async-architecture-qa.md)，2015 行，2026-11-09，代码基线 `867d277`。**本文所有"来源"列都指向该文件的章节号** |
| **参照来源（计划）** | [`metainfer-lab-refactor-plan.md`](/root/expert-review/metainfer-lab-async-refactor/metainfer-lab-refactor-plan.md)，1491 行，与仓库内 `docs/07-async-refactor-plan.md` **逐字相同**（`diff -q` 无差异） |
| **状态来源** | [`PROGRESS.md`](PROGRESS.md)、[`spikes.md`](spikes.md)，以及 `host/` 实读 |
| **状态基线（重要）** | 分支 `refactor/async-foundation`，提交 **`d8565d6`**（"P2.4(Q9): review claims…"；其上依次是 `0170092` P2.3、`8be444c` P2.2、`dd5ca19` P2.1），审计时间 **2026-11-10 11:50 +08:00**。**审计期间该分支每 10–20 分钟就有新提交**（P2.1→P2.4 全部落在本次审计窗口内），复核时请先 `git log --oneline -5` 对齐 |
| **覆盖范围** | §1–§5 = QA 文档的决策/结论/阶段/开放问题与矛盾；§6 = 人机交互易用性；§7 = 可观测性；§8 = 验收命令清单；§9 = 规模与卡顿。§6–§9 的条目同样逐条给出来源（QA 章节号 或 `AGENTS.md`） |
| **本文不含** | 任何新决策。未在 QA 文档中出现的条目一律不写；含义不清处标 `需确认`，建议值一律标"建议·需确认" |

## 0. 阅读约定（先读这一节，否则状态列会被误读）

**状态词只有三种，定义是"接入级"而不是"代码级"：**

- `done`：代码存在、**已接入运行路径**、且该步骤的验证指标可以观测到。
- `todo`：不存在，或只有模块级实现但没有接入运行路径 / 指标不可观测。
- `blocked`：存在一个必须先裁决的设计冲突，裁决前开工没有意义。

**"在途"（不占状态词）：** 审计末期工作区仍有未提交改动：`host/context/`（`dag.js` / `ledger.js` / `limits.js` / `payload.js`）、`scripts/context-selftest.mjs`，以及被修改的 `host/orchestrator.js`、`host/snapshot.js`——这是 P4 导航/上下文那批工作，**尚未提交、尚未接入**。它们**不计为 done**。

**最重要的一条方法论：本仓库的提交信息比代码乐观。** 审计期内四个"已提交"的 WP 里，两个的模块**没有任何生产调用方**（P2.2 的 `dispatchOnce`、P2.2 的 `policy.authorizeAction`），两个真正接进了运行路径（P2.1 的 `runnableQueue`、P2.3 的 `createLowWaterPlanner`）。所以"`git log` 里有这个 commit"**不等于**"这个能力生效了"——§3 的每一行都以"有没有调用方"为判据。

**判定"接入"的硬证据（三条，全部可复现）：**

1. `grep -rn "from './kernel/\|from '../kernel/\|from './dispatch/\|from '../dispatch/" host/ index.js` → 在 `d8565d6` 上是 **8 处**：`host/auto.js:7-9`（`runnable` / `low-water` / `capacity`）、`host/snapshot.js:6`（`runnable`）、`host/orchestrator.js:17-18`（`review-claims` / `context/ledger`）、`host/kernel/projection.js:12-14`（`priority` / `mutations` / `runnable`）。**仍然零引用的**：`kernel/executor.js`、`kernel/bus.js`、`kernel/trace.js`、`kernel/policy.js`、`dispatch/dispatch-once.js`、`dispatch/dispatcher.js`、`dispatch/envelope.js`、`dispatch/round.js`、`dispatch/deterministic-strategy.js`——全部只被 `scripts/*-selftest.mjs` 引用。**`dispatch-once.js` 与 `policy.js` 是最刺眼的两处：有提交、有自测、没有调用方。**
2. 在 `d8565d6` 上 `host/` 下**仍然不存在**：`kernel/commands.js`、`kernel/intents.js`、`kernel/conflicts.js`、`kernel/verifier.js`、`kernel/triggers.js`、`kernel/eventlog.js`、`kernel/write-guard.js`、`experts/*`（整个目录）、`dispatch/legacy-llm-strategy.js`。**已存在但零调用方**：`kernel/policy.js`、`dispatch/dispatch-once.js`、`dispatch/dispatcher.js`。**已存在且已接入**：`kernel/runnable.js`、`kernel/capacity.js`、`dispatch/low-water.js`、`dispatch/review-claims.js`、`context/ledger.js`（在途）。
3. `npm test` 现在是 **12 个 selftest**（`runnable` / `advisor-merge` / `kernel` / `gang-planner` / `dispatch` / `dispatch-once` / `low-water` / `review-claims` / `context` / `migrate-domain` / `cluster-fleet` / `placement`），全绿；但**自测通过只证明被 import 的那个模块自洽**，不证明它被运行路径调用——`dispatch-once-selftest` 就是活例子：500 节点 < 100 ms 被测过，而 `dispatchOnce` 从未被调用。

**两套编号不要混：**

- QA 附录 D 是 **5 个阶段 / 21 个步骤**（1.1 … 4.5 → 5.1 … 5.4；阶段 4 有 5 步），按"每步可独立验证、可回滚"排列，**不涉及内核抽象**。
- 专家计划是 **P0–P7**（含 P3.5、P0.1–P0.9 等），按"确定性内核先行"排列。
- `PROGRESS.md` 记的是 **P 编号**。所以"附录 D 多数 todo"**不等于**"没有进展"：P1.1–P1.5、P3.1–P3.5 的模块已经落地，它们是附录 D 2.x / 3.2 的**底层**；审计时只有 **2.1** 一步因为并行改动（`dd5ca19`）真正达成了验证指标，其余步骤的指标都还不可观测（见 §3 每行依据）。

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

## 3. 附录 D 的五阶段 21 步

> 来源：§附录 D（L1961–2011）。"验证指标"列**逐字保留**原文。
> "当前状态"列的状态判定依据写在每行"依据"里：`PROGRESS.md` 的 P 编号 + `host/` 实读。

| 步骤 | 内容 | 验证指标 | 当前状态（done / todo / blocked，依据） |
|---|---|---|---|
| **1.1** | `report.summary ≤ 500` 字符（schema + prompt） | 全库存储 1.3 MB → ~200 KB | **todo**。依据：`NODE_REPORT_SCHEMA.summary` 只有 `{type:'string'}`、**无 `maxLength`**（`host/runtime.js:26`）；`host/prompts.js` 的 `WORKER_RULES` 无长度规则；快照侧仍是 `MAX_REPORT = 700`（`host/snapshot.js:8`）。PROGRESS 无对应 WP；K16 只删了无调用方的 `reportSummary()`，`报告本身仍不截断`（迁移工具注释 `scripts/migrate-domain.mjs:118`） |
| **1.2** | 截断显式化（`shown / total`） | 专家追问率 | **todo**。依据：全仓库 `grep -rn "_truncated\|shown.*total" host/ index.js` **为空**；`truncate()` 只追加一个 `…`（`host/snapshot.js:14–17`）；`metrics` 仍 `.slice(0, 8)` 无 `total`（`host/snapshot.js:125`） |
| **1.3** | `running` 补 `elapsed` / `lastActivity` | 停滞判断可行 | **todo**。依据：advisor 快照 `running[]` 只有 `startedAt` / `deadlineAt`（`host/snapshot.js:176–184`）；scheduler 快照有 `elapsedMs`（`host/snapshot.js:295`）**但没有 `lastActivity`**；节点上 `timestamps.lastActivityAt` 已在多处写入（`host/runtime.js:321 / 382 / 603 / 1211` 等），但 `onSessionEvent` 只处理 `turn/end`（`host/runtime.js:1838`）——**worker 在一次 turn 之内干了多久仍然看不见**（即 K8 未修） |
| **1.4** | 快照瘦身（`focus` 8 条 + `index`） | advisor 输入 46 KB → ~10 KB；延迟 129 s → ~40 s | **todo**。依据：`buildAdvisorSnapshot` 返回的是 `candidateParents` 全量 + `recentProposals` + `pendingProposals`，**没有 `focus` / `index` / `ledger` / `recentFailures` 字段**（`host/snapshot.js:233–260`）；`project.brief` 未截断（`host/snapshot.js:234`）。PROGRESS 未列该 WP（计划的处理方式是 P4 用导航 API 取代 `snapshot.js`，见 §5.2） |
| **2.1** | `runnable` 唯一口径（排除 deferred） | 不再误触发 `noProgress` | **done（`dd5ca19`，审计期间刚落地）**。依据：谓词抽到 `host/kernel/runnable.js`（`isRunnableNode` / `runnableQueue` / `runnableSummary`），并被**三处运行路径**引用——`host/auto.js:7,242`（`canRunPlanned` / `plannedFits` / `idleStreak` 全改用 `runnableQueue`）、`host/snapshot.js:6,271`（scheduler 快照的 `planned` 改为 `runnableQueue`）、`host/kernel/projection.js:12-14`（`runnable()` 复用它，不再各自实现）。`scripts/runnable-selftest.mjs` **11/11** 通过，其中 "a deferred node is planned but never runnable" 与 "runnableSummary counts the regression case instead of hiding it" 直接覆盖 Q5 的复现路径。**仍未做**：端到端演练（造 40 个 deferred 节点 + 3 轮空转，确认不再 `pause('noProgress')`），以及 `host/orchestrator.js:928` 与 `host/lab-service.js:744` 两处残留的 `status === 'planned'` 计数（前者是"父节点可生子"判定，后者是 UI 计数，均非派发口径） |
| **2.2** | `dispatchOnce`（无 LLM）+ 派生队列 | 启动延迟 152 s → <100 ms | **todo（代码已提交，零调用方）**。`8be444c` 提交了 `host/dispatch/dispatch-once.js` + `scripts/dispatch-once-selftest.mjs`（断言 500 节点 DAG < 100 ms），但 `grep -rn "dispatchOnce(" host/ index.js` **只命中 `host/auto.js:258` 的一行注释**（“let dispatchOnce keep the slots full”）——**没有任何生产调用**。`applySchedulerOutput` 仍是串行 `await runtime.start`（`host/orchestrator.js:833-841`），`auto.js` 的 tick 仍走 `orchestrator.step`（cycle 路径）。⇒ **启动延迟仍不可观测**（基线 p50 152.3 s）。这是全文“模块级 ≠ 落地”最干净的样本 |
| **2.3** | 低水位预触发 + 去抖 | GPU 空洞时长 | **done（机制）**：`0170092` 把 `createLowWaterPlanner` 接进 `auto.js`（`plannerOf` / `evaluate` / `beginPlanning` / `endPlanning`，`host/auto.js:29-40,247-282`），并新增 `kernel/capacity.js` 的 `anyFits` 给出容量等待原因；`scripts/low-water-selftest.mjs` 覆盖去抖与触发。**两处数值与 QA 不一致**：`debounceMs` 默认 **120 s**（QA Q7-1 说 **60 s**）、`minRemainingMs` 默认 **60 s**（QA Q7-3 说“剩余 < **5 min** 预触发”）——`host/dispatch/low-water.js:24-25`。**指标仍未测**：没有任何地方统计“GPU 空洞时长”，所以 done 只到机制层 |
| **2.4** | 审查租约（review claim） | 同父并发提案数 | **done（机制）**：`d8565d6` 新增 `host/dispatch/review-claims.js`（`DEFAULT_TTL_MS = 180_000`，`claim` :63-90 / `releaseAll`），并在 `host/orchestrator.js:780`（advisor pass 前 claim）、`:865`（`releaseAll`）接入；`scripts/review-claims-selftest.mjs` 覆盖并发与 TTL。**未验证的指标**：同父并发提案数在接入前后没有对比测量，也没有“租约冲突”计数进事件或指标 |
| **3.1** | `metainfer_lab` action 白名单（修 issue 0001） | 越权调用返回 `forbidden_action` | **todo（代码已提交，零调用方）**。`host/kernel/policy.js` 已随 P2.2 提交，内含 `ACTION_CATALOG` / `PRESET_POLICIES` / `actorForSession` / `authorizeAction`，`forbidden_action` 错误码定义在 `policy.js:221`；但 **`authorizeAction` / `allowedActions` 在 `host/` 内没有第二个引用**（`grep -rln` 只命中 `policy.js` 自己），`host/agent-tool.js` 的 `ACTION_ENUM` 仍是全局 **49** 项（`agent-tool.js:5-55`），`docs/issues/0001-agent-tool-scope-drift.md` 仍是“**待修**” |
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

**汇总（`d8565d6`）：done 3（2.1 唯一口径、2.3 低水位、2.4 审查租约） / todo 18（其中 2.2 与 3.1 **有提交但无调用方**） / blocked 0（5.4 为待裁决的 todo）。**

**怎么读这个接近 0 的数字：** P1.1–P1.5、P3.1–P3.5 的模块、以及 `scripts/runnable-selftest.mjs`（11 项）、`kernel-selftest.mjs`（15 项）、`dispatch-selftest.mjs`（7 项）、`gang-planner-selftest.mjs`（14 项）、`migrate-domain-selftest.mjs`（11 项）都通过了——**它们是 2.2 / 2.1 / 3.2 的底层零件**，但附录 D 每一步的验证指标**一个都还没有被观测过**。唯一已经发生的"线上收益"是 PROGRESS 记录的 2026-11-10 割接后第一个 cycle（`created 0–1 → 2`、`started 1 → 10`、`planned 39 → 31`），它来自 K7 修复（提案宽度），**不对应附录 D 的任何一步**。

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
| **5.2.5** | **映射表缺失** | 附录 D 21 步 | 计划 P0–P7 共 60+ 个 WP | **缺口（流程性）**。两套编号之间**没有映射表**：`PROGRESS.md` 只记 P 编号，导致"附录 D 某步是否完成"无法从进度表直接读出（本文档 §3 就是为补这个洞）。建议在 `PROGRESS.md` 增列一个"附录 D 步骤 ↔ WP"列 |

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
| **5.4.7** | `PROGRESS.md` 作为"唯一进度事实源" | 审计期间有**四个**提交绕过进度表：`dd5ca19`（P2.1）、`8be444c`（P2.2）、`0170092`（P2.3）、`d8565d6`（P2.4）全部落地（共改 20+ 文件、新增 4 个 selftest），但 `PROGRESS.md:36-38` 仍写 `P2.1 / P2.2 / P3.6 = todo`，P2.3 / P2.4 在表里**根本没有行**（P2 段只有 P2.1、P2.2 两行） | `git log --oneline -5` + `git status --short` 对比 `PROGRESS.md`；**建议**：每个提交同步改进度表，或在表头写明"本表以最后一次提交为准，`git log` 是权威"（这与 `AGENTS.md` 的"单一事实源"原则同构） |
| **5.4.8** | 低水位阈值的数值 | QA 侧：Q7-1「`planning` 状态 + 去抖窗口 **60 s**」、Q7-3「`remainingMin < 5`（即 **300 s**）且 `!planningInFlight` 就触发」；代码侧：`host/dispatch/low-water.js:24-25` 默认 `minRemainingMs = 60_000`（**1 min**）、`debounceMs = 120_000`（**2 min**）——**两个数都比 QA 更保守且方向相反**：更低的水位（1 min 而非 5 min）意味着更容易出现空洞，更长的去抖（2 min 而非 60 s）意味着反应更慢。计划 P3.2 只写“低水位预触发”，没有给数 | `git show 0170092`；可用项目配置 `config.planning.{minRemainingMs,debounceMs}` 覆盖（`planningConfigOf`）。**需负责人确认**：默认值按 QA 的 5 min / 60 s 改，还是接受当前值并回写 QA |

### 5.5 一句话总结

**设计侧（QA）与执行侧（计划）在四个点上正面冲突：专家是驻留还是无状态（B16 vs D6）、摘要该截还是不该截（B26 vs D16）、专家该分三级还是分区（B11 vs D7）、dispatcher 能不能有 LLM（B10 vs D3）。这四个点各自都改变了 P4/P5/P6 的代码形状，必须在开工前裁决。**

**同时，QA 附录 D 的"事实层"（1.1–1.4）在计划里没有 WP，而它恰恰是唯一"不改架构就能把 129 s 降到 40 s"的部分；计划把它的替代品（导航 API）推到了 P4。这是两份文档之间最大的路径差异。**

---

## 附录 E · 代码证据索引（本文档自建）

> 供复核上表每一行。路径相对 `dsh-metainfer-research-lab/`；分支 `refactor/async-foundation` @ `a9457d2`。

| 证据 | 位置 | 证明了什么 |
|---|---|---|
| 内核只接入了 `runnable` | `host/auto.js:7`、`host/snapshot.js:6`、`host/kernel/projection.js:12-14`（`dd5ca19`）；`executor` / `bus` / `trace` / `dispatcher` / `envelope` / `deterministic-strategy` **仍只被 selftest 引用** | §0 判定规则 1：除 `runnable` 外，P1/P3 模块仍是"模块级" |
| 49 个 action，全局注册 | `host/agent-tool.js:5–55`、`index.js:149–152` | B1 / §3.1：无白名单，issue 0001 未修 |
| 13 个 MCP 工具 | `grep -c "server.registerTool" host/mcp.js` → 13 | 前序 1 §1 的"1 写 + 12 读"仍成立；P2.3 未做 |
| 22 路由 + 29 命令 | `grep -c "router\." host/http.js` → 22；`grep -c "if (type === '"` → 29 | 前序 2 §L2 的"22 GET + 29 命令"仍成立 |
| 无 `_truncated` | `grep -rn "_truncated" host/` → 空 | §3 1.2 / B25 未落地 |
| 快照仍全量 | `host/snapshot.js:233–260`（`candidateParents` + `recentProposals` + `pendingProposals`，无 `focus` / `index` / `ledger`） | §3 1.4 / B15 未落地 |
| `MAX_REPORT = 700` | `host/snapshot.js:8,124` | §3 1.1 / B26 未落地（仍是 700，不是 500） |
| `NODE_REPORT_SCHEMA.summary` 无 `maxLength` | `host/runtime.js:24–49` | §3 1.1：源头没有长度约束 |
| 报告写入不截断 | `host/runtime.js:850–905`（`persistNode('node/completed')` 前无 `report.summary` 处理） | B26 未落地（也是 D16 的现状：两边都没做） |
| `auto.js` 已改用统一口径 | `host/auto.js:7,242,261,264`（`runnableQueue`）；`scripts/runnable-selftest.mjs` 11/11 | §3 2.1 **done**（`dd5ca19`）；残留：`host/orchestrator.js:928`、`host/lab-service.js:744` 仍是 `status==='planned'`（均非派发口径） |
| 2 秒轮询 | `host/auto.js:302`；`host/runtime.js:1970–1972` | §3 2.3：无事件驱动 / 无低水位预触发 |
| 串行 start | `host/orchestrator.js:833–841` | §3 2.2 / K18：dispatcher 未接入 |
| `runnable` 已抽成独立模块并接入 | `host/kernel/runnable.js:1-108`；`projection.js:143-155` 复用；`auto.js` / `snapshot.js` 引用 | B3 / B8 **模块 + 接入**均已落地；`runnableSummary` 有数据但**无端点暴露**（§7 O4） |
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
| 测试全绿（8 个 selftest） | `npm test` → runnable 11/11、advisor-merge 7、kernel 15/15、gang 14/14、dispatch 7/7、migrate 11 项、cluster/placement PASS | §0 判定规则 3：除 `runnable-selftest`（覆盖 `auto.js` 使用的谓词）外都只证明纯函数 |
| 无 `docs/refactor/baseline.json` | `ls docs/refactor/` → `PROGRESS.md`, `spikes.md`, `DESIGN-CHECKLIST.md` | P0.8 未做 → C12 无基线 |

---

## 6. 人机交互易用性

> 本节验收的是**"人能不能只靠界面做决定"**，不是"界面好不好看"。来源列：QA 章节号，或 `AGENTS.md`（本仓库的产品规则）。
> 判定口径：能在 UI 上看到 / 点到 = 有；只能读日志、读 JSON、读 transcript = 没有。

| U | 验收项（人话） | 现状（代码证据） | 验收方式（可执行 / 可观察） | 来源 |
|---|---|---|---|---|
| **U1** | 不读日志，就能回答"**现在在跑什么**" | 部分有。DAG 画布一节点一卡，`NodeCard` 显示状态 + **剩余时间倒计时**（`countdownOf(nodeDeadlineOf(node), now)`，`client.js:10308`）与忙碌标记；顶部 `ws.nodeCount` 显示 `已用/上限`（`client.js:9804`）；`ExpertChip` 显示"专家组 · N 运行中"（`client.js:9848`）。**没有**"已跑多久"（只有倒计时）与"占了多少 GPU"的汇总 | 打开项目页，**只靠界面**列出所有 running 节点、各自已跑时长（现在只有倒计时）、占用的 GPU 数、所属分支；不需要打开 `runs`、`events` 或日志 | §Q2 时间加权并发、§Q5 陷阱① |
| **U2** | 不读日志，就能回答"**接下来会启动什么、为什么是它**" | **没有**。没有队列面板；派发顺序只存在于 scheduler run 的 `output` 里（`host/orchestrator.js:825-846` 消费后即丢）；**节点的 `priority.{class,score}` 在 UI 上完全不显示**——`client.js` 里 23 处 `priority` 全是**集群调度优先级（0–100，`ws.clusterConfig.priority`）**与指南文案（`client.js:376,396,12019`），没有一处渲染节点优先级；`buildSchedulerSnapshot` 刚加了 `class`（`host/snapshot.js:303`）但只给 LLM 看 | UI 有一个"队列"视图，按**派发顺序**列出 planned 节点 + `class` + 阻塞原因（等 GPU / 等父节点 / 被 deferred / 被 hold）。对照 QA 的 `priority/delayed {blockedBy, 预计剩余}`：**该事件不存在**，视图也就无从生成 | §Q3 机制 A/C（L493、L508–513）、§Q2"队列无限膨胀" |
| **U3** | 不读日志，就能回答"**刚刚失败了什么、为什么**" | 部分有。失败状态可见；`ws.attempts.error` / `ws.report.failed` / `ws.termination.kind.*` 文案存在（`client.js` 内联字典）；但 `error.stage` 只在 debug JSON 视图里出现（`client.js:14455`），**失败归因（哪个 role、哪次 run、超时还是崩）没有面板** | 失败节点详情展示：`error.code`、失败阶段（start / run / merge / review）、最近一次 run 的 role 与 `timeoutMs`、以及**下一步可做什么**（重试 / 升级 / 取消）。QA 要求"错误信息必须说怎么办"，不满足即不通过 | §附录 D 1.3（"停滞判断可行"）、§Q2 advisor 失败率 22% |
| **U4** | 每个自动化决策（新建 / 启动 / 砍掉 / defer / 重试）都能**顺着原因链追到触发它的那一次激活** | **没有**。① 节点事件不带 `causeId`：`persistNode` 写的是 `{nodeId, ...payload}`（`host/runtime.js:415-421`），而 `causeId` 只有 kernel 的 `executor.commit` 会写（`host/kernel/executor.js:137`）——**运行路径根本不经过它**；② 只能追到阶段：`node.review{decision, runId}`（`host/orchestrator.js:786-792`）、`auto.pauseReason`（`client.js:4803` 翻译了 10 种 pause 原因）、`dashboard.lastRun`；③ `createdBy` 只到 `'advisor'` 粒度，不记 lens / 专家（K17，`host/orchestrator.js:768,774`） | 任一节点详情页能回答"谁、在哪次 run、基于哪条事件把它创建 / 启动 / 砍掉"，且能一键跳到那条 run 的 `inputSnapshot` 与输出。判定方法：随机抽 5 个已完成节点，**全程不 grep 日志**还原其创建来源 | §Q12-1（basis）、§Q13-3、§附录 B B21；`AGENTS.md`"以代码为准并记 issue" |
| **U5** | 干预：**暂停 / 恢复驱动** | 有。HTTP `POST /commands` 的 `auto/start`、`auto/stop`、`auto/resume`（`host/http.js`，29 个命令之一）；UI `ws.auto.*` 面板；`pauseReason` 回显 | 点暂停 → `state.auto.status='paused'` 且 `pauseReason` 显示为**人话**（不是枚举名）；点恢复 → 下一 tick 生效。用 `curl` 复验状态字段 | §Q3 机制 C L2、§Q5 陷阱① |
| **U6** | 干预：**取消一个节点** | 有。`cancel_node`（agent tool + HTTP）；`node/cancelled` 事件；running 节点取消会释放租约 | 取消 running 节点后：`status='cancelled'`、资源池 `free` 立即回升、session/worktree 被回收、事件可见。失败路径：取消已完成节点应报明确错误码 | §Q5（只有 planned 可 prune）、§附录 D 3.2 |
| **U7** | 干预：**提高 / 降低优先级** | **没有入口**，这是最硬的一处缺失。`updateNode` 只接受 `title` / `prompt` / `successCriteria` / `timeboxMinutes` / `model`（`host/lab-service.js:1159-1200`），**没有 `priority`**；HTTP / 命令 / UI 都没有设置优先级的路径；`node.setPriority` 只有 kernel 实现（`host/kernel/mutations.js:191`），**没有任何调用方** | UI 对 planned 节点提供 `p0/p1/p2/p3/deferred` 选择器 + 理由输入；变更产生 `node/priority_changed` 事件（含 `before` / `after` / `by`）并进入审计列表。**这是 B5"人的意图走确定性通道"在界面上唯一可兑现的地方，目前完全缺失** | §Q3 机制 C L1（"人可以直接改优先级，立即重排"）、§附录 B B5 |
| **U8** | 干预：**批准 / 拒绝提案** | 有，但**拒绝是静默删除**：`rejectProposal(projectId, nodeId)` 只收两个参数（`host/orchestrator.js:1104`），删节点、删父节点的 `review`（好让 advisor 重新提）、写 `node/rejected` 事件（`:1119`）——**不收理由、不进下一轮上下文**，同一提案会被原样再提一次 | 提案卡片上批准 → 节点进入 planned 队列；拒绝 → 提案消失**且拒绝理由进入下一轮 advisor 上下文**（可观察：下一轮 run 的 `inputSnapshot` 含该理由，且同一提案不再原样重现）。**当前两项都不成立**，理由输入框也不存在 | §Q2"proposed 等待人工确认"、§Q3 机制 C L2 |
| **U9** | 干预：**解释一个节点**（"它为什么在这、为什么停了"） | **没有**。没有 `trace_explain`、没有 `dag_query`（`grep -rn "trace_explain\|dag_query" host/` 为空）；只能人肉看 transcript（`/transcript?afterSeq=`）、replay（`/replay` 返回全量事件）或 run 记录 | 一个"解释"入口，返回结构化链条：创建者 → 父节点 → 启动它的 run → 期间事件 → 当前阻塞原因。**不接受"让用户去读 transcript"作为答案**（QA 明确要求过程可见） | §Q9-2（"过程可见"）、前序 2 §下一步（L305） |
| **U10** | 错误**可执行**：给"下一步做什么"，不是甩 stack trace | 部分有，**三个已知反例**：① `forbidden_action` 根本不存在（3.1 未落地，越权时是"能调就调"）；② `model_profile_unknown` 只回 `unknown model profile: ${id}`（`host/models.js:85,204`），**不列可用 profile**，用户无从修正；③ `dashboard_disabled` / `dashboard_empty` 文案尚可（`host/lab-service.js:840,843`），但 UI 只显示 `dashboard.error` + `firstString(lastRun.error)`（`client.js:8362`），丢掉了 code | 每个 `LabError` 至少带 `{code, message, hint}`；UI 渲染 `hint`。判定方法：故意触发这三类错误，看界面是否给出可执行下一步（"去 Settings 选一个已注册的 profile"而不是"unknown profile"） | `AGENTS.md`（"error handling"要求）、§Q12-8 权限矩阵、§附录 D 3.1 |
| **U11** | i18n 完整（`locale/en.json` + `locale/zh.json`） | **不完整**。`locale/*.json` 只有 `meta.title` / `meta.description` 两个键；全部界面文案在 `client.js` 的两张内联表里（zh `client.js:163-1485`、en `client.js:1491-2797`）。实测 **zh 1299 键 / en 1291 键，en 少 8 个**：`replay.title`、`replay.short`、`replay.toggle`、`replay.play`、`replay.pause`、`replay.loading`、`replay.close`、`dashboard.toggle` → 英文界面这几处显示原始 key | 两表键集合相等，且无 raw key 泄漏。校验：`node scripts/i18n-parity.mjs`（`待实现`；等价的临时检查见 §8 注释）。**新增 UI 面板必须同时进两张表** | `AGENTS.md`"UI discoverable … with loading/error/empty states"、§Q1 对文档失真的批评 |
| **U12** | 空 / 加载 / 错误 三态 | 部分有。画布空态 `ws.canvas.empty`、dashboard 错误条 `dashboard.error`、整页崩溃边界（`client.js:15073` 的 `crash.title/hint` + message）。**缺**：队列面板、专家库面板、解释面板都还不存在，其空/加载/错误态自然也没有；`ws.runs.status.failed` 有，但 run 列表无"加载中" | 每个新面板三态齐全；判定：断网刷新、空项目、失败项目各看一次，**界面不得白屏、不得只显示 key** | `AGENTS.md` 第 3 条 |
| **U13** | **认知负荷**：agent 生成的数据必须与 Host 确定性计算的数据可区分 | 弱。dashboard widget 有 `config.collector`（`agent` / `script`），UI 在信息行里显示"采集器"（`client.js:8158`），**但卡片本身没有视觉区分**；widget 的 `data.status` 是 **agent 自评**（`host/dashboard.js:29` 的 `ok/warn/error/idle`）；`config.query` 是自然语言，`config.script` 是可审计命令，两者在 UI 上等权 | 每个 widget 卡上标注：来源（agent / script + 脚本全文可展开）、上次刷新时间、以及**过期徽标**（超过 `2 × intervalMinutes` 未刷新）。判定：一眼能看出哪些数字是模型说的、哪些是代码算的 | `AGENTS.md`"禁止 fake/placeholder data"；§Q14（"让幻觉可检测"） |
| **U14** | 仪表盘**静默过期**属于缺陷类 | 是缺陷。`tickDashboards` 每 30 s 轮询（`host/lab-service.js:1055-1067`），刷新失败 `.catch(() => {})` **吞掉**；失败只写 `dashboard/partial` 事件与 `lastRun.error`（`host/lab-service.js:911`）；UI 仅在**手动**刷新失败后显示错误条（`client.js:8362`），后台失败**没有任何提示**，旧数据继续以 `dashboard.updatedAt` 显示 | 后台刷新失败 → 卡片出现"数据过期"标记 + 顶部一条可关闭告警；连续 N 次失败 → 自动降级为"仅显示上次成功时间，不显示数字"。判定：停掉模型 provider 等 2 个周期，界面必须**自己说出来** | `AGENTS.md`（生命周期与错误处理）、§Q2"两条关键路径都压在 LLM 上" |

**14 行。** 其中 `没有` 的 5 项：U2（队列与原因）、U4（原因链）、U7（改优先级）、U9（解释节点）、U14（静默过期）；`不完整/弱` 的 3 项：U10、U11、U13。

---

## 7. 可观测性

> 判定口径：**能被机器查出来**才算有（HTTP / MCP / 事件 / 测试），只在 UI 文案或自由文本里出现的不算。
> 现状基线：`health()` 只返回 5 个字段（`name` / `version` / `domain` / `storage` / `projects`，`host/lab-service.js:2662-2670`）——**没有任何延迟、队列、失败率**。

| O | 指标 / 能力 | 现状（代码证据） | 验收方式（可执行 / 可观察） | 来源 |
|---|---|---|---|---|
| **O1** | cycle 延迟（p50 / p90 / max，按 role 分） | **可算但未算**。`runs` 每条有 `role` / `startedAt` / `finishedAt` / `status` / `timeoutMs`（`host/orchestrator.js:387-396`），`listRuns` 可按时间倒序取 200 条（`host/store.js:234-242`），但**没有聚合、没有端点**。QA 的 152.3 s / 129.4 s / 18.4 s 全部是离线算的 | `GET /runs` 或新增 `GET /metrics` 返回 `byRole[role] = {p50, p90, max, count, failRate}`；用 `curl … \| jq` 复现 QA 的 152.3 s（±10%）即通过 | §Q2 实测表（L371–389） |
| **O2** | advisor **输入字节 / token / 调用** | **可算但未算**。`run.inputSnapshot` 存的是**整份 prompt 字符串**（`host/orchestrator.js:392`），字节数可当场算出；但没有 `inputBytes` 字段、没有 token 估算、没有按 role 的聚合。QA 的 46 KB / 205 KB 是离线 `JSON.stringify(...).length` 得来的 | run 记录上落 `inputBytes`（写入时算一次），`/metrics` 给 `advisor.inputBytes.p50/p90`；并对 100 节点夹具断言 `< 12 KB`（见 O11） | §Q6 载荷实测（L745–790）、§Q9 粒度实测（L1092） |
| **O3** | **dispatch 延迟**（runnable → claimed → started） | **不存在**。dispatcher 未接入；`dispatch-once.js` 在途，注释里承诺"decision path < 100 ms for a 500-node DAG"，但**没有 `startedAt` 打点、没有指标输出** | 每次 dispatch 决策记录 `{projectId, nodeId, decisionMs, outcome, reason}`；`/metrics` 给 p50/p99；断言 p99 < 1 s（I15）与 < 100 ms（附录 D 2.2） | §附录 D 2.2（L1979）、计划 §13.2 / I15 |
| **O4** | **队列深度**（runnable / deferred / claimed / held / 预计剩余） | **有数据、没出口**。`runnableSummary(nodes)` 返回 `{total, runnable, deferred, claimed, held, remainingMs, gpu}`（`host/kernel/runnable.js:88-108`），**但没有任何端点或快照字段引用它**（`grep -rn "runnableSummary" host/` 只命中 `auto.js` 的 import 与定义） | `state` 或 `/metrics` 里出现 `queue: runnableSummary(nodes)`；验收：造 3 个 deferred + 2 个 claimed 的夹具，`/metrics` 的 `deferred=3` / `claimed=2` 与夹具一致 | §Q3 机制 B（WIP 上限）、§Q7 backlog 深度 |
| **O5** | running / planned / failed / cancelled **计数** | 部分有。`lab-service.js:744` 只算 `planned`（且是**旧口径**，含 deferred）；UI 的 `ws.nodeCount` 用 `nodes.length` 对比 `maxNodes`；`state.pendingProposals` 有一个计数（`host/lab-service.js:684`） | 按 status 的计数进 `state`/`/metrics`；**plan 的计数必须用 `runnableQueue`**，否则会把 deferred 算成"待执行"（Q5 陷阱①的仪表盘版本） | §Q5 陷阱①（L699–704）、§Q2 并发 2.83/8 |
| **O6** | **停摆计数**（空转轮次、连续失败、最近一次 pause） | 只有内存。`idleStreak` / `errorStreak` 在 `auto.js` 的 `stateOf()` 里，**不持久化、不进 `state`**；`pause()` 只写 `pauseReason`（`host/auto.js:279`），没有"连续空转 N 轮"的可见计数 | `state.auto` 暴露 `{idleStreak, errorStreak, lastPauseAt, lastPauseReason}`；验收：造 3 轮空转，看 `idleStreak=3` 且 `pauseReason='noProgress'` | §Q5 陷阱①（9 小时停机的机制）、§Q7 空洞 |
| **O7** | **每角色失败率**（advisor / scheduler / reviewer / worker / gc） | **可算但未算**。`runs.status` 有 `failed` / `timeout`（`host/orchestrator.js:387-396` 及收尾处），`listRuns` 能取到，但没有按 role 的比率；QA 的"advisor 失败率 22%（11/49）"是离线统计 | `/metrics` 给 `byRole[role].failRate`；断言 advisor 失败率 < 20% 作为回归闸（当前 22% 会红，正好暴露问题） | §Q2（L377–381）、§Q2 建议 P1 |
| **O8** | **cause 链追踪**：causeId → 事件 → 激活 | **断的**。`kernel/trace.js` 有完整的 `ACTOR_KINDS` / `causeId` / `digest`（`host/kernel/trace.js:12`），`executor.commit` 会把 `causeId` 写进事件（`host/kernel/executor.js:137`）；但**运行路径不经过 executor**：`persistNode` 写的事件里没有 `causeId`（`host/runtime.js:415-421`），`orchestrator` 的 `persistEvent` 也没有 | 任一节点事件带 `causeId`（指向触发它的 run id / 事件 seq），并提供 `trace_explain(nodeId)` 返回链；验收：抽 3 个节点，从事件链还原"谁创建了它、谁启动了它"，**不读自由文本日志** | §Q12-1（basis）、§Q13-3、§附录 B B21 |
| **O9** | 每个状态转换都有**结构化事件** | 部分有。`persistNode` 按 `eventType` 写 `node/*`（`host/runtime.js:415-421`）；kernel 侧有 `TRANSITION_EVENT` 映射（`host/kernel/mutations.js`）但**未被运行路径使用**；`node/priority_changed` 这类事件在运行时**从不产生**（因为改优先级没有入口，见 U7），`dashboard/partial` 之类旁路事件反而存在 | 枚举 6 个状态 × 合法转换，断言每个转换恰好产生 1 个类型稳定的事件（事件目录进测试）；`node/priority_changed` / `node/claimed` / `node/dispatch_failed` 三类必须存在 | §附录 D 3.4、§Q13-3 |
| **O10** | **查询面**（不用读日志就能问"发生了什么"） | 部分有。`GET /events?after=` 有游标（`host/http.js`），但**无 `limit`**，一次返回全部增量；`GET /replay` 返回**从 0 开始的全部事件**（`host/lab-service.js:1077-1080`）；没有 `trace_explain` / `dag_query` / `dag_diff`（3.3 未落地） | 有 `trace_explain` 与分页事件接口（`limit` + `nextCursor`）；验收：用接口回答"n-0042 为什么被 defer"，不需要打开 transcript | §Q9-2 / §Q9-4（`dag_map` / `dag_walk` / `dag_diff`）、§附录 B B15 |
| **O11** | **回归护栏**：advisor 快照体积是一等度量，涨了就红 | **没有**。快照里只有截断常量 `MAX_PROMPT = 800` / `MAX_REPORT = 700`（`host/snapshot.js:8`），没有任何测试断言快照总字节数；`scripts/*-selftest.mjs` 全部不构造快照（`grep -rln "buildAdvisorSnapshot" scripts/` 为空） | 新增 `scripts/snapshot-size-selftest.mjs`：造 100 节点 / 8 分支夹具，断言 `JSON.stringify(buildAdvisorSnapshot(...)).length < 12 * 1024` 且 `candidateParents.length ≤ 8`；**阈值来自 QA（8–12 KB），不是自定** | §Q6-2（"46 KB → 8–12 KB"）、§Q9（"紧凑索引行 110–230 B"） |
| **O12** | 哪些信息**只在 LLM 生成的 dashboard 或自由文本里可见** | **清单（缺口）**：① GPU 利用率 / 空闲时长——只有 dashboard widget（`collector:'agent'`）会给；② 成本 / token 消耗——`tokensUsed()` / `costUsed()` 在 `auto.js` 里用于断路，但**不进 `state`**；③ 节点"进展叙事"——`report.summary` 自由文本，无结构字段；④ 分支健康度 / 假设台账——完全不存在；⑤ "为什么没启动"——不存在；⑥ 专家绩效（`proposalsAccepted` 等）——不存在 | ①②③ 必须有 Host 计算的结构化字段并进 `state`/`/metrics`；④⑤⑥ 在各自 WP 落地时同步给字段。判定：把 dashboard agent 与所有 summary 文本**屏蔽**，系统仍能回答"健康吗、时间花在哪" | §Q14-3②（"摘要一长指标就整段消失"）、§Q11-3（绩效）、§Q2（成本） |

**12 行。** 其中"不存在"3 项（O3、O8 的链、O11 的护栏）、"有数据没出口"3 项（O2、O4、O7）、"只有内存/自由文本"3 项（O6、O12、O5 的旧口径）。

---

## 8. 验收命令

> 规则：**只写存在的命令**；不存在的标 `待实现` 并给出预期路径与预期输出。
> 约定：`P` = projectId；`LAB=http://127.0.0.1:3080/api/metainfer-research-lab`（端口换成 `dsh web` 实际端口；路由前缀硬编码在 `host/http.js:17`）。
> 所有 `curl` 都在**有项目**的实例上跑；`jq` 必需。

| # | 证明什么 | 命令 | 期望结果 | 状态 |
|---|---|---|---|---|
| **A1** | 纯函数与离线工具全绿（§1 的 B3/B4/B6/B8、§3 的 2.1/3.2 的零件） | `cd dsh-metainfer-research-lab && npm test` | 8 个 selftest 全过：`runnable 11/11`、`advisor-merge 7`、`kernel 15/15`、`gang-planner 14/14`、`dispatch 7/7`、`migrate-domain 11`、cluster/placement `PASS` | **现有** |
| **A2** | "runnable 唯一口径"+ Q5 回归（deferred 不算待执行） | `node scripts/runnable-selftest.mjs` | `11/11 checks passed`，其中含 `a deferred node is planned but never runnable` 与 `runnableSummary counts the regression case instead of hiding it` | **现有** |
| **A3** | 派发策略 / 安全包络 / 回填 / shadow / fallback | `node scripts/dispatch-selftest.mjs` | `7/7 dispatch checks passed` | **现有** |
| **A4** | 内核：幂等、basis 陈旧、原子提交、`claim` 是提交点、事件不删 | `node scripts/kernel-selftest.mjs` | `15/15 kernel checks passed`（含 `stale basis is rejected`、`claim is the dispatch commit point`） | **现有** |
| **A5** | 存储域 v2 迁移可回放（P1.10） | `node scripts/migrate-domain-selftest.mjs` | `11` 项通过（源域不被改写、目标域 v2） | **现有** |
| **A6** | 集群 gang 调度不死锁 | `npm run sim:gang` | 输出保留/回填/整机授予三类场景 PASS（`14/14` 见 A1 的 gang-planner） | **现有** |
| **A7** | 服务活着、域版本、项目数 | `curl -s "$LAB/health" \| jq` | `{name, version, domain:"metainfer_research_lab_v2", storage:"ready", projects:N}` | **现有** |
| **A8** | 全量状态体积（§9 S4 的现状测量） | `curl -s "$LAB/state?projectId=$P" \| wc -c` | 基线：**79 节点 = 1,301,776 B**（QA §附录 A.6 / L1868 实测）；**§9 要求 5,000 节点时 < 5 MB**（`需确认`，见 §9 表） | **现有** |
| **A9** | 增量读的真实语义（§9 S10） | `R=$(curl -s "$LAB/state?projectId=$P" \| jq .revision); curl -s "$LAB/state?projectId=$P&revision=$R" \| jq .unchanged` | 当前返回 `true`（**没变才省流量，变了就全量重发**）；§9 要求"变了也能只发 delta" | **现有（证明缺口）** |
| **A10** | 事件游标是否分页（§9 S11） | `curl -s "$LAB/events?projectId=$P&after=0" \| jq '.events \| length'`；再试 `&limit=5` | 第一条返回**全部**事件数（无上限）；`limit` 参数**被忽略**（路由只读 `after`） | **现有（证明缺口）** |
| **A11** | 失败率 / 延迟能否直接读出（O1/O2/O7） | `curl -s "$LAB/runs?projectId=$P" \| jq '[.runs[] \| {role,status,startedAt,finishedAt}] \| length'` | 能拿到原始 run 列表；**拿不到 p50/p90、拿不到 inputBytes** → 需 A21 的 `/metrics` | **现有（证明缺口）** |
| **A12** | i18n 两表键集合（U11） | `node scripts/i18n-parity.mjs` | 输出 `zh=1299 en=1291 missing-in-en=[replay.title,…]`；**修复后必须相等** | **待实现**（脚本不存在；等价的临时检查：用正则提取 `client.js` 里两段 `'key': 'value'` 表做集合差；审计时已手工执行，得到 zh 1299 / en 1291、缺失 8 键） |
| **A13** | 越权调用被拒（B1 / 3.1 / U10） | `node scripts/policy-selftest.mjs` | `forbidden_action` 被返回；`ACTION_ENUM` 按 actor 求交集（worker 13 / advisor 3 / scheduler 3 / curator 只读 4） | **待实现**（`policy.js` 已提交且定义了 `forbidden_action`，但**没有任何 selftest**，也没有任何调用方；`ACTION_ENUM` 仍全局 49） |
| **A14** | dispatcher 快路径延迟（2.2 / O3） | `node scripts/dispatch-once-selftest.mjs` | 500 节点夹具下决策路径 **< 100 ms**（脚本 :87 的用例名） | **现有（`8be444c`）**——但注意：**测的是模块，不是产品**；`dispatchOnce` 仍无生产调用方，所以本命令不能证明“启动变快了” |
| **A15** | 快照体积回归（O11 / 1.4） | `node scripts/snapshot-size-selftest.mjs` | 100 节点夹具下 `JSON.stringify(snapshot).length < 12*1024`，`candidateParents.length ≤ 8` | **待实现** |
| **A16** | cause 链可追（O8 / U4） | `node scripts/trace-selftest.mjs` 或 `curl -s "$LAB/events?projectId=$P&after=$SEQ" \| jq '.events[0].causeId'` | 事件带 `causeId`；`trace_explain` 能从节点还原创建者与启动 run | **待实现**（`trace_explain` 不存在；事件无 `causeId`） |
| **A17** | 人类改优先级（U7 / B5 / 3.2） | `curl -s -XPOST "$LAB/commands" -d '{"type":"node/set_priority","projectId":"'$P'","nodeId":"n-0007","class":"p0","reason":"manual"}' \| jq` | 返回 `ok`；随后 `node/priority_changed` 事件可见；`state` 里该节点 `priority.class='p0'` 且排在队首 | **待实现**（命令类型不存在：当前 29 个命令里没有它，`updateNode` 也不收 `priority`） |
| **A18** | 规模基准（§9 全部行） | `npm run bench:scale -- --nodes 5000` | 输出一张表：`state` / `events` / `dispatch` / `snapshot` / `single-node` / `first-paint` / `interaction` 各列 p50/p99 与通过/超预算 | **待实现**（无 `bench:scale` 脚本；`package.json` 只有 `test` 与 `sim:gang`） |
| **A19** | 5000 节点可达（§9 S14） | `curl -s "$LAB/state?projectId=$P" \| jq '.project.config.maxNodes'` 与 UI 向导上限 | 当前 `maxNodes` 默认 60、向导硬上限 **1000**（`client.js:7032`）→ **5,000 规模在配置层就不可达** | **现有（证明缺口）** |
| **A20** | 后台刷新失败可见（U14） | 停掉 provider 后等 2 个刷新周期，看 UI | 卡片出现过期徽标 + 顶部告警；事件流有 `dashboard/partial` | **待实现**（目前 `.catch(()=>{})` 吞错，UI 无提示） |
| **A21** | 健康度一眼可读（O1–O7） | `curl -s "$LAB/metrics" \| jq` | `{cycle:{p50,p90}, byRole:{advisor:{p50,inputBytes,failRate}}, queue:{runnable,deferred,claimed,held,remainingMs}, dispatch:{p50,p99}}` | **待实现**（无 `/metrics` 路由；`health()` 只有 5 个静态字段） |

**21 条：现有 13（A1–A11、A14、A19）、待实现 8（A12、A13、A15–A18、A20、A21）。** 其中 A8/A9/A10/A11/A19 是"用现有命令证明缺口"的条目——它们**今天就该红**，正好作为验收基线。

---

## 9. 规模与卡顿

> 数据来源全部是 `dd5ca19` 的实读。凡标 `需实测` 的结论都是按 O() 与单记录体积推算，**不是跑出来的**；这正是本节要补的东西。
> 参考体积：QA 实测 **79 节点 = 1,301,776 B**（≈16 KB/节点，`report` 占 806 KB、`prompt` 占 283 KB，§附录 A.6 / L1868）；**82** 是 DAG 节点总数（含已砍），两者差 3 个节点。事件单条约 150–400 B（推测，`需实测`）。

| S | 操作 | 现状（O(N) 证据，file:line） | 何时开始卡 | 5,000 节点预算 | 验收方式 / 回归 |
|---|---|---|---|---|---|
| **S1** | 节点表全表扫描 | `listNodes` 遍历**整张 nodes 表**（跨所有项目）再 `startsWith(prefix)` 过滤，然后**全量浅拷贝 + 全排序**（`host/store.js:150-163`）。被 `getState`（每次全量）、`buildAdvisorSnapshot`、`buildSchedulerSnapshot`、`auto.tickOne`（**每 2 s**，每项目）、`runtime.runningNodes` 反复调用 | 单项目 ~2,000 节点时每次调用已是数百毫秒（`需实测`）；更致命的是**调用频率**：2 s × 项目数 | 全量读 ≤ **200 ms**（`需确认`）；`listNodes` 单次 ≤ **20 ms** | `bench:scale` 打点；修复方向是按项目建索引或走 Projection（计划 P1.5） |
| **S2** | 事件表全表扫描 | `listEvents(projectId, after)` 遍历**整张 events 表**、过滤、再排序（`host/store.js:216-224`）；被 `/events` 每轮轮询调用，**游标只减结果不减扫描量** | 事件表 100k 时单次调用 O(100k) 排序（`需实测`，估算 50–150 ms/次），且客户端每秒可能多次 | 事件页（limit 100）≤ **50 ms**；扫描量必须是 O(返回页) 而不是 O(全表) | `bench:scale --scenario events`；修复=按 seq 建游标索引（`eventlog.js`，P1.2） |
| **S3** | run 列表 | `listRuns` 遍历**整张 runs 表**、排序、再 `slice(0, limit)`（`host/store.js:234-242`）——**为了返回 200 条要扫全部** | 5,000 节点 × 每节点 ≥ 1 run ≈ 5k+；演练项目可到 50k | run 列表 ≤ **50 ms** | 同上；修复=按 `startedAt` 倒序索引 |
| **S4** | 全量状态序列化 | `getState` 把**所有节点 + 所有边**序列化返回（`host/lab-service.js:632-690`）；`decorateNodes` 再整表 map 一次（`host/runtime.js:1998-2004`） | **79 节点 = 1.3 MB**（QA 实测）；线性外推 **5,000 节点 ≈ 80 MB**，单次响应 1–3 s 且内存翻倍 | 全量读 ≤ **5 MB / 500 ms**（`需确认`；80 MB 显然不可接受） | `curl state \| wc -c`（A8）+ `bench:scale` |
| **S5** | replay | `getReplay` = `getState`（全量）+ `listEvents(after=0)`（**全部事件**）（`host/lab-service.js:1077-1080`），无分页、无窗口 | 10k 事件即数十 MB 响应；`Math.min(...arr)` 展开大数组在 100k 级会栈溢出（`...` 展开，`:1098-1101`） | replay 首屏 ≤ **1 MB / 2 s**，且按时间窗分段 | `curl replay \| wc -c`；修复=分页 + 窗口 + 去掉 `...` 展开 |
| **S6** | advisor 快照构建 | `buildAdvisorSnapshot` 全表扫描 + 构建 children 索引 + 取 2 层祖先（`host/snapshot.js:233-260`），**`JSON.stringify` 后整份塞进 prompt** | 与 DAG 宽度成正比而非节点数（QA：`candidateParents` 197,925 B 占 96.4%，51 条）；8 路并行 → 30+ 叶 → 400 KB+ | 快照 ≤ **12 KB**（QA 已定 8–12 KB）；构建 ≤ **50 ms** | A15 的 `snapshot-size-selftest`；**这是唯一 QA 给了硬数字的预算** |
| **S7** | scheduler 候选选择 | `buildSchedulerSnapshot` 取 `runnableQueue(nodes)`（全量 planned，`host/snapshot.js:271`）→ 全部塞进 prompt；`fairOrder` 对**全部候选**做 O(n²) 优先级归一化（`host/kernel/priority.js:97-118`），在途改动加了 `limit` 截断（未提交） | planned 数千时 `fairOrder` O(n²) 明显（5,000 → 2.5×10⁷ 次比较，`需实测`） | 候选选择 ≤ **10 ms**，且只需 top-K | 在途的 `fairOrder({limit})` 已修；需要 `bench:scale --scenario dispatch` 固化 |
| **S8** | UI 首屏渲染 | **一节点一 `NodeCard`** + 一条边一条 `<path>`（`client.js:10210-10248`），**无虚拟化、无摘要/降级模式**；`layout.positions` 也对所有节点做一次布局 | 稳定 DOM 化约 300–500 个卡片即开始掉帧；2,000 卡基本冻住 | 首屏 ≤ **1 s**，且 ≥ 2,000 节点时**必须**切到"按分支聚合 + 展开局部" | `bench:scale` 无法测 UI；需 Playwright/手测清单（`待实现`） |
| **S9** | UI 交互 / 事件风暴 | 收到一条节点更新后 `refresh()` 重新拉**全量** `state`（`client.js:5571-5590` 合并单节点后立即 `refresh()`）；一次 dispatch 启动 10 个节点 = 10 次全量刷新 | 并发启动 10 节点（PROGRESS 记录的割接首轮）即触发 10 × 80 MB | 单次交互 ≤ **16 ms**；事件应增量 patch，不整树重取 | 需要在 A9 的增量接口之上重写客户端订阅 |
| **S10** | 增量读 | **只有两态**：`sinceRevision === project.revision` → `{unchanged:true}`；否则**整份重发**（`host/lab-service.js:633-637`）。没有"变更集"概念 | 任何一次写入都会让**所有**客户端下一个 tick 全量重取 | 有真正的 `changes(sinceRevision)`：返回变更节点 id + 删除 id + 新 revision | A9；修复=在 `project` 上记 per-node revision 或事件投影 |
| **S11** | 分页覆盖 | 见下方"无界返回面"表：`/state`、`/events`、`/replay`、MCP `metainfer_list_nodes`、`metainfer_get_state`、`/transcript` 全部**无 limit**；`/runs` 有内部 limit 但无 cursor | 任一接口都可能成为单点卡死 | 所有列表接口**必须** `limit` + `nextCursor` | 逐条用 `curl` 验证（A10 的做法） |
| **S12** | 事件增长（读写） | 写：`appendEvent` 是 O(1) 单条 put（`host/store.js:190-203`），**没问题**；读：O(全表)（S2）；`recover()` 一次性加载全部尾部事件（PROGRESS P1.2 todo）；**无归档**（无 `kernel/eventlog.js`，`EVENT_RETENTION` 已删） | 10k：读 ~10–30 ms（`需实测`）；100k：~100–300 ms 且每次轮询都付；1M：秒级 + 内存压力 | 100k 事件时读 ≤ **50 ms**；≥ 50k 必须冷段归档（计划 §8.4） | `bench:scale --scenario events --count 100000`；修复=P1.2 + `eventlog.js` |
| **S13** | 规模回归测试 | **不存在**。`scripts/` 下没有 bench；唯一涉及规模的断言是 `dispatch-once.js` 注释里的"500-node DAG < 100 ms"，而它的 selftest **还没写** | — | 全部预算进 CI | A18 `npm run bench:scale` |
| **S14** | 配置层上限 | `maxNodes` 默认 **60**（`client.js:77`、向导 `client.js:7032`），向导硬上限 **1000**；`ensureCapacity` / `maxNodes` 断路在 `auto.js:232` | **5,000 节点在配置层不可达**：向导最多填 1000 | 上限必须能到 5,000（或明确"单项目上限 1,000，规模靠多项目"）→ **需确认** | A19 |

**14 行。** 三条结论：

1. **读写不对称已经成立**：写是 O(1)（事件、节点都是单条 put），**读全是 O(全表)**。所以"节点多了会卡"的准确表述是"**任何一次读都会卡**"，而读的频率由 2 s tick × 客户端轮询决定。
2. **QA 给了硬数字的只有两处**：dispatch `< 100 ms`（附录 D 2.2）与快照 `< 12 KB`（Q6/Q9）。其余预算（全量读、事件页、UI 首屏）**QA 与计划都没有给**，本表里的数值一律是 `需确认` 的建议值。
3. **5,000 节点今天连配置都到不了**（S14），所以"规模预算"必须先有一个能造出 5,000 节点的入口，否则 benches 无从跑起。

### 9.1 无界返回面（S11 的明细）

| 接口 / 工具 | 位置 | 返回 | 分页 | 现在就能打爆的动作 |
|---|---|---|---|---|
| `GET /state` | `host/http.js`（`service.getState`） | 全部节点 + 全部边 + 资源池 | **无**（只有"整份/空"两态） | 每 2 s × 每客户端 |
| `GET /events?after=` | `host/http.js` | `seq > after` 的**全部**事件 | **只有 after 游标，无 limit** | 一次 `after=0` 拉全历史 |
| `GET /replay` | `host/http.js` | 全部节点 + **全部事件**（`after=0`） | **无** | 打开 replay 面板 |
| `GET /runs` | `host/http.js` → `listRuns(limit=200)` | 200 条（**内部全表扫描**） | 有上限、无 cursor | 反复翻不了页 |
| `GET /transcript?afterSeq=` | `host/http.js` | 该 seq 之后的**全部**消息 | 只有 afterSeq 游标，无 limit | 长会话一次拉完 |
| MCP `metainfer_list_nodes` | `host/mcp.js:148-154` | 全部节点，**含 prompt / report / attempts / git** | **无**（且直接 `getState` 全量） | 一次调用即 1.3 MB+ |
| MCP `metainfer_get_state` | `host/mcp.js` | 同 `/state` | **无** | 同上 |
| `metainfer_lab` 的 `state` action | `host/agent-tool.js` | 同 `/state` | **无** | **这正是 QA 实测"325k tokens"的来源**（§Q6 现状） |
| `metainfer_lab` 的 `events` / `transcript` | `host/agent-tool.js` | 同 HTTP | 仅游标 | 同 HTTP |
| `GET /projects` | `host/http.js` | 全部项目 | **无**（项目数通常小，风险低） | — |
| `GET /cluster` | `host/http.js` | 全部租约 + 队列 | **无** | 集群规模大时 |

**结论**：**没有任何一个返回集合的接口带 `limit`/`nextCursor` 组合**；`dag_*` 系列（B15 / Q9）之所以是前置条件，不只是"给专家省 token"，也是**唯一被设计成有 `maxRows` / `maxBytes` / `cursor` 的接口族**（Q9-5：双上限 200 行 / 24 KB，超限返 `truncated:true` + `nextCursor` 而不是报错）。

---

## 10. 统计与优先级（滚总）

| 节 | 内容 | 行数 | 其中"已落地 / 未落地" |
|---|---|---|---|
| §1 | 附录 B 决策 | **27** | 3 条已完全落地（B3 / B4 / B8）；6 条有零件未接入；18 条未开工 |
| §2 | Q1–Q14 结论 | **14** | 15 处数字/字段可核对；`【已部分可用】` 3 题、`【defer】` 4 题 |
| §3 | 附录 D 阶段步骤 | **21** | **done 3（2.1 / 2.3 / 2.4） / todo 18（2.2、3.1 有提交无调用方） / blocked 0** |
| §4 | 附录 C 开放问题 | **14** | 已有提案答案 8、部分未决 4、部分已答 1、方向相反 1 |
| §5 | 矛盾与缺口 | **35** | 5.1 冲突 6、5.2 顺序/指标 5、5.3 缺口 16、5.4 不一致 8 |
| §6 | 人机交互易用性 | **14** | 明确"没有"5 项（U2/U4/U7/U9/U14） |
| §7 | 可观测性 | **12** | 不存在 3（O3/O8 链/O11 护栏）、有数据无出口 3（O2/O4/O7） |
| §8 | 验收命令 | **21** | 现有 13（含 A14）、待实现 8 |
| §9 | 规模与卡顿 | **14** | QA 给了硬数字的只有 2 处（dispatch < 100 ms、快照 < 12 KB） |

**最高价值的五件未完成事项（按"动手就能改变指标"排序）：**

1. **2.2 / P3.6 把 dispatcher 接进运行路径**（代码已提交 `8be444c`、自测已过、**零调用方**）。`dispatchOnce` 一旦被 `auto.js` 的 2 s tick 与 `runtime` 的终止钩子调用，启动就不再等 advisor 129 s + scheduler 18 s；这是唯一能把 p50 cycle 从 152 s 往下砍的结构性改动。**改动量：一个 import + 两处调用点。**
2. **3.1 / B1 的 action 白名单**（`policy.js` 已提交、`forbidden_action` 已定义、**零调用方、零 selftest**）。49 个 action 全局可见意味着任何一个专家会话都能 `delete_project`；这是安全项，也是 §6 U10 错误可执行性的前提。**改动量：`agent-tool.js` 里把 `ACTION_ENUM` 换成 `allowedActions(actor)`。**
3. **1.4 快照瘦身**（QA 承诺"单独就能把 129 s 降到 ~40 s"，但计划里**没有 WP**）。`buildAdvisorSnapshot` 仍是全量 `candidateParents`；改法在 Q6-2 / Q9 里已写死（`focus` 8 条 + `index` + 预算），不需要新架构。
4. **U7 / B5 人的优先级通道**（**零入口**）。`updateNode` 不收 `priority`，HTTP 没有该命令，UI 只显示集群优先级 0–100。B5 整条决策（"人的意图走确定性通道、< 1 s 启动"）目前没有任何可执行落点。
5. **3.3 + O4：`dag_map` / `dag_walk` / `dag_query` 与队列出口**。两者一起做才有意义：导航工具负责"变宽之后专家还能看见"，`runnableSummary` 出口负责"人能看见队列与原因"（U2）。当前 `runnableSummary` 有数据、零消费者——是所有条目里"最便宜的可见收益"。

**四个正面冲突（开工前必须裁决，见 §5.1）：** B16 驻留会话 ↔ D6 无状态激活；B26 `summary ≤ 500` ↔ D16 不截断 + `headline ≤ 300`；B11 三级 ↔ D7 分区 + 升级路由；B10 dispatcher 不含 LLM ↔ D3/§6.2 可插拔 `LegacyLlmStrategy`。
