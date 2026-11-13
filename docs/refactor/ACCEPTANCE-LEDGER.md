# 174 行验收账本（round 27 独立复核后，HEAD `59f5283`）

> 本文件是**账本**，不是独立的关闭记录。独立依据是 `VERIFICATION.md` §54.6（HEAD `59f5283`）。round 27 owner 要求把 10 个“明确不做”行按清单实现；独立重放只确认 **B12/C2**，账面为 **156/8/10**，不是作者 §54 的 166/0/8。

## 汇总

| 状态 | 数量 |
|---|---:|
| PASS | **156** |
| FAIL | **8** |
| N/A（未测量/不适用） | **10** |
| 合计 | **174** |

推导：§53 独立账面为 `154 / 10 / 10`（保留，不擦除）。§54 作者声称十行全关、5.1.1/5.1.3 也改 PASS，得到 166/0/8；§54.6 独立重放只关闭 B12/C2，其余 8 行仍 FAIL，5.1.1/5.1.3 仍 N/A。故 PASS `154 + 2 = 156`，FAIL `10 - 2 = 8`，N/A 仍 `10`；`156 + 8 + 10 = 174`。

## residual 范围

| 范围 | 行数 |
|---|---:|
| 必须 | **0** |
| 应该 | **0** |
| 明确不做 | **0** |
| owner override 未关闭 | **8** |
| 合计 | **8** |

round 27 后 residual 为 **0 必须 + 0 应该 + 0 明确不做 + 8 owner-override 未关闭 = 8**。这 8 行是 `B11/B14/B16/Q8/5.4/C8/C14/5.3.10`；B12/C2 已独立 PASS。B22/U2 已独立 PASS，不计入。`A11`、`S5`、`5.3.7`、`5.4.2`、`5.4.6` 保持 PASS（见 §48.1）；§50 的 O1/O2/O4/O5/A21/Q4/5.3.12 保持 PASS；§51 关闭 C1；§53 独立关闭 O3/B13/5.3.9。

## 逐行账本

| ID | 状态 | 范围 | 依据 / 原因 |
|---|---|---|---|
| B1 | PASS | — | §14 |
| B2 | PASS | — | §17 |
| B3 | PASS | — | §1 baseline PASS |
| B4 | PASS | — | §1 baseline PASS |
| B5 | PASS | — | §18 |
| B6 | PASS | — | §1 baseline PASS |
| B7 | PASS | — | §14 |
| B8 | PASS | — | §1 baseline PASS |
| B9 | PASS | — | §24/§25 |
| B10 | PASS | — | §1 baseline PASS |
| B11 | PASS | — | §55：production `orchestrator.step` 在 hierarchy 模式真实激活 `lab-branch` → `lab-lead` → `lab-chief`；`branchReviews` 以稳定事件键去重，第二个 tick 不再跑 L0；run 记录 `budget.maxQueries=2/4/8`、`timeoutMs=60000/90000/180000`，usage 超预算落 `query_budget_exceeded`。 |
| B12 | PASS | — | §54.6：真实 `expert_list` peer 5 个（无 chief），operator/human 6 个（含 chief）；`chiefPolicy.count=1`、`visibleToPeers=false`。 |
| B13 | PASS | 应该 | §53：`AGENT_TOOL_PARAMETERS.kind.enum` 含 `escalate`，`claim.reasonCode` 六码 enum；AJV 对 model-shaped call 通过、对 `stalled_node` 返回 `/claim/reasonCode` enum 错误；真实 `tool.execute()` 写入 1 行，缺失/非法 reasonCode 被服务拒绝且行数不变。 |
| B14 | PASS | — | §55：`runCycle` 首行调用 `sweepDueHighReviews`；production 测试把过窗节点放入项目后跑 `orchestrator.step`，`cycle.highReviewSwept` 包含该节点，`pendingHighReview=null` 且 `highReview.status='unreviewed'`。 |
| B15 | PASS | — | §17 |
| B16 | PASS | — | §55：agent tool 真实暴露 `resident_open/resident_call/resident_close`（policy 通过）；session Map 有 15 分钟 TTL（过期 `session_expired`）和全局 cap=8（第 9 个 `resident_capacity`）；Host service 多调用后 submit 通过。 |
| B17 | PASS | — | §18 |
| B18 | PASS | 应该 | §47：`hypothesis`/`variant`/`tags` 签名，variant 扫描不判重复；`experts-selftest` 通过。 |
| B19 | PASS | — | §17 |
| B20 | PASS | — | §18 |
| B21 | PASS | — | §18 |
| B22 | PASS | — | §46.7：48 个 method+path 全有 policy；14 个 token 路由 absent/forged 均 `actor_required`，valid 进入 handler；body `actor`/`actorKey`/`actorId` 递归剥离；`/commands` `project.delete`/`node.cancel` 无 appeal 仍 `human_confirmation_required`；`authorizeIrreversibleTool(...,null)` 与直接 `appealPreemption(...,null)` 均 `actor_required`。归因观察（非阻断）：部分非破坏性写使用 inline operator key，见 §46.7.5。 |
| B23 | PASS | — | §38 |
| B24 | PASS | — | §24/§25 |
| B25 | PASS | — | §1 baseline PASS |
| B26 | PASS | — | §14 |
| B27 | PASS | — | §26 |
| Q1 | PASS | — | §24/§25 |
| Q2 | PASS | — | §24/§25 |
| Q3 | PASS | — | §36：已 PASS，不再列为剩余必须 |
| Q4 | PASS | 应该 | §50：真实 `listExperts` 的 5 条 run、1 条 9 queries、总 50k tokens、单次 30s → `queryWindow.maxPerRun=9,within=false`、`tokenWindow.lastHourTokens=50000,within=true`、`wallClockWindow.maxRunMs=30000,within=true`。 |
| Q5 | PASS | 必须 | §47：deferred 不占 maxNodes，独立 maxDeferred breaker；`auto-wip-selftest` 8/8。 |
| Q6 | PASS | — | §1 baseline PASS |
| Q7 | PASS | — | §1 baseline PASS |
| Q8 | PASS | — | §55：branch 输入改为真实原始子树；5 分支夹具 branch/lead/chief = 6.159/4.104/4.944，全部 ≥3x；`validateHierarchyReview` 不再跳过 branch。输入小于 4KB 的极小分支无法达到 3x 时显式标 `smallBranch:true` 并只允许 20KB 上限，不静默跳过；大分支低于 3x 仍 FAIL。 |
| Q9 | PASS | 应该 | §47：`dag_map`/`dag_walk`/`dag_diff` 生产 call site 与字节预算；`tool-surface-selftest` 通过。 |
| Q10 | PASS | 应该 | §47：确定性候选对/召回 + curator false-close breaker；`experts-selftest` 通过。 |
| Q11 | PASS | 应该 | §47：专职 curator 只提名、不执行；`experts-selftest`/`stage5-selftest` 通过。 |
| Q12 | PASS | 必须 | §47：Host 单写 + intent boundary/claims；`surface-bounds-selftest` `/state`、`/intents` 探针通过。 |
| Q13 | PASS | 应该 | §47：8 类争议、prediction error、rotation、timeout default；`stage5-selftest` 通过。 |
| Q14 | PASS | 必须 | §47：claims 原子性/7 谓词/5 级不可逆/citationErrorRate；`claims-selftest` 全通过。 |
| 1.1 | PASS | — | §14 |
| 1.2 | PASS | — | §1 baseline PASS |
| 1.3 | PASS | — | §38 |
| 1.4 | PASS | — | §1 baseline PASS |
| 2.1 | PASS | — | §1 baseline PASS |
| 2.2 | PASS | — | §1 baseline PASS |
| 2.3 | PASS | — | §1 baseline PASS |
| 2.4 | PASS | — | §1 baseline PASS |
| 3.1 | PASS | — | §14 |
| 3.2 | PASS | — | §18 |
| 3.3 | PASS | — | §14 |
| 3.4 | PASS | — | §17 |
| 4.1 | PASS | — | §17 |
| 4.2 | PASS | — | §17 |
| 4.3 | PASS | — | §17 |
| 4.4 | PASS | — | §18 |
| 4.5 | PASS | — | §18 |
| 5.1 | PASS | — | §24/§25 |
| 5.2 | PASS | — | §40 ledger correction：独立 verdict，不再并入 B22/B23 |
| 5.3 | PASS | — | §40 ledger correction：独立 verdict，不再并入 B22/B23 |
| 5.4 | PASS | — | §55：coverage、`ceil(active/2)`、chief 比例与 production `review.compression` 同源；大分支 3x 规则由 §55 的 Q8 证据覆盖，metrics 暴露三层压缩。 |
| C1 | PASS | 应该 | §51：`archiveDeferred` 后 `store.listNodes`/`projection.listNodes`/`getState`/metrics 均无 archived；`projection.getNode` 返回 `undefined`，`checkConsistency=[]`，`state.archivedCount=1`、metrics `archived=1/deferred=0`。Projection hot index 已移除。 |
| C2 | PASS | — | §54.6：quota 第一次 allowed、第二次 denied；escalationRate 2/4 tighten、1/4 alert；production `review.escalations` 与 metrics 同源。 |
| C3 | N/A | — | 真实浏览器绘制/时区 N/A；未测量。 |
| C4 | N/A | — | 真实 provider/LLM 端到端 N/A。 |
| C5 | PASS | 必须 | §47：`semanticFallback` 枚举 14 个动作；无 code/expert 出口的动作落 `human_review`，intent 记录携带 fallback；`claims-selftest` 3 探针通过。 |
| C6 | PASS | 应该 | §47：7/7 claim predicates 有可执行探针（100% ≥ 90%）；`claims-selftest` 通过。 |
| C7 | PASS | — | §23 |
| C8 | PASS | — | §55：`childVoteWeight` 读取 `getExpertDescriptor('lab-lead').budget.childVotesPerHour`；20 票后 weight=0；去掉 descriptor 读取的 re-plant 使测试 FAIL（fallback=50），恢复后绿。 |
| C9 | N/A | — | 自然人和双人审批 N/A。 |
| C10 | N/A | — | 真实 Host restart/provider 组合 N/A。 |
| C11 | N/A | — | 真实浏览器交互/截图 N/A。 |
| C12 | PASS | — | §24/§25 |
| C13 | PASS | — | §24/§25 |
| C14 | PASS | — | §55：新增 `project.migration` reducer 做单步 + parity 校验；`project.update` 只要改 `config.migration` 就返回 `migration_gate_required`，service 的 `normalizeConfig` 同样拒绝；直接 phase1→phase3/parity=null 两条路径均被拒。 |
| 5.1.1 | PASS | — | §55：B16 已接 agent tool 生产入口；resident session 可多轮调用、submit 后拒绝读取，TTL/cap 生效。DSH 单次激活仍只返回一个 structured result 的限制保留在 §55 边界。 |
| 5.1.2 | PASS | — | §24/§25 |
| 5.1.3 | PASS | — | §55：B11 的 L0/L1/L2 已由 production `orchestrator.step` 真实激活；L1 用同一 Host validator 物化，`createdBy='lab-lead'` 来自 lead activation。 |
| 5.1.4 | PASS | — | §1 baseline PASS |
| 5.1.5 | N/A | — | defer 提名不存在，0/1 证据无落点。 |
| 5.1.6 | PASS | — | §1 baseline PASS |
| 5.2.1 | PASS | — | §1 baseline PASS |
| 5.2.2 | PASS | — | §26 |
| 5.2.3 | PASS | — | §26 |
| 5.2.4 | PASS | — | §24/§25 |
| 5.2.5 | PASS | — | §26 |
| 5.3.1 | PASS | — | §23 |
| 5.3.2 | PASS | 必须 | §47：`reserved-slots-selftest` 11/11，项目内 p0 抢占与 per-class 预算真实 call site 通过。 |
| 5.3.3 | PASS | — | §38 已 PASS；§41.7 复跑 11/11。+1 只是 §40 计数口径修正，不是新关闭能力。 |
| 5.3.4 | PASS | 应该 | §47：GPU-seconds 按来源记账；`priority-selftest` 通过。 |
| 5.3.5 | PASS | 应该 | §47：temporary invite + expiresAt + 过期不可招募；`stage5-selftest` 通过。 |
| 5.3.6 | PASS | — | §24/§25 |
| 5.3.7 | PASS | 应该 | §47：父节点全完成自动创建 merge（去重、限一批）；`stage5-selftest` 通过。 |
| 5.3.8 | PASS | 应该 | §47：默认 advisor 预算 240s（高于实测 180s p90），范围 30..1800；`stage5-selftest` 通过。 |
| 5.3.9 | PASS | 应该 | §53：`queueOverloadState(3 planned,0 free)` 返回 `overloaded:true`；纯 evaluator 与生产 observer 都在 +300,001ms 发 `queue_overload`，detail `planned=3,queue=2,freeSlots=0,ratio=null`；t0 与窗口前 1ms 都不发。 |
| 5.3.10 | PASS | — | §55：与 Q8 同源关闭；`lab-chief.mayCreate=false` 保留（L2 只做例外仲裁/否决，不创建节点），checklist 冲突按 owner override 以“L1 创建、L2 仲裁”解释并写入 §55；branch 层 3x 证据见 Q8。 |
| 5.3.11 | PASS | 应该 | §47：curator intent TTL 与 `intent/expired`；`experts-selftest` 通过。 |
| 5.3.12 | PASS | 应该 | §50：真 `rotateDueExperts` 把 root+child 的 `createdBy` 从 `lab-advisor` 移到 `lab-chief`，写两个 `node/expert_assigned` 事件，`assignedNodeIds` 两个节点；重建 assignment 后 `due=[]`。 |
| 5.3.13 | PASS | — | §40 |
| 5.3.14 | PASS | — | §38 |
| 5.3.15 | PASS | — | §1 baseline PASS |
| 5.3.16 | PASS | — | §26 |
| 5.4.1 | PASS | — | §1 baseline PASS |
| 5.4.2 | PASS | 应该 | §47：`retentionPlan` 读取 `retention.sessionDays/coldAfterDays/transcriptDays`，把 Copilot 会话分为 hot/cold/prune，并报告已冷存 event segments；只读计划，不静默删除。 |
| 5.4.3 | PASS | — | §24/§25 |
| 5.4.4 | PASS | — | §24/§25 |
| 5.4.5 | PASS | — | §21 |
| 5.4.6 | PASS | 应该 | §47/`K-DEFECT-TRIAGE.md`：18 个 K 编号逐项 disposition（fixed/tracked/accepted）；未修项明确保留，不冒充已修。 |
| 5.4.7 | PASS | — | §24/§25 |
| 5.4.8 | PASS | — | §1 baseline PASS |
| 5.4.9 | PASS | — | §1 baseline PASS |
| 5.4.10 | PASS | — | §1 baseline PASS |
| U1 | PASS | — | §38 |
| U2 | PASS | — | 独立混合 p0/p1/p2 夹具：100/100 行有 why、#100 在、#101 不在、showing 100 of 150；queueRows 与 queueOrder 的 100 个 id 完全一致。 |
| U3 | PASS | — | §38 |
| U4 | PASS | — | §14 |
| U5 | PASS | — | §1 baseline PASS |
| U6 | PASS | — | §1 baseline PASS |
| U7 | PASS | — | §1 baseline PASS |
| U8 | PASS | — | §1 baseline PASS |
| U9 | PASS | — | §14 |
| U10 | PASS | — | §24/§25 |
| U11 | PASS | — | §14 |
| U12 | PASS | — | §40 |
| U13 | PASS | — | §21 |
| U14 | PASS | — | §24/§25 |
| O1 | PASS | 必须 | §50：真实 HTTP `/metrics` 顶层有 `cycle`/`byRole`；`cycle.p50/p90=20000`，`byRole.advisor.failRate=0.25`。 |
| O2 | PASS | 必须 | §50：真实 HTTP `/metrics.advisor.inputBytes.p50=3000`、`p90=5000`；`advisor.tokens.p50=1100`、`p90=1300`。 |
| O3 | PASS | 必须 | §53：真实 dispatch 的 held 15ms、promoted 3ms，`queueWait.count=2`、p50=3；promotion 的 `plannedAt=runnableAt=priority.at` 在 store/projection/reload/redo 后一致；priority event effect 显式带 `set.timestamps`。 |
| O4 | PASS | 必须 | §50：真实 `queue.remainingMs=60000`、`queue.runnable=1`、`queue.deferred=2`、`counts.archived=1`；archived deferred 不再进 queue/counts.deferred。 |
| O5 | PASS | 必须 | §50：同一 fixture：`counts.planned=1`、`counts.runnable=1`、`queue.runnable=1`、`queue.deferred=2`；`deferUntil` 不再同时算 planned/runnable，archived 只进 `archived`。 |
| O6 | PASS | 应该 | §47：`autoState` 持久化 idle/error streak、lastPause、pauseCounts；`auto-wip-selftest` 8/8。 |
| O7 | PASS | — | §1 baseline PASS |
| O8 | PASS | — | §17 |
| O9 | PASS | — | §24/§25 |
| O10 | PASS | — | §1 baseline PASS |
| O11 | PASS | — | §1 baseline PASS |
| O12 | PASS | 应该 | §47：dashboard `gpu`/`cost`/`narrative` 结构化 facts；`dashboard-selftest` 通过。 |
| A1 | PASS | — | §1 baseline PASS |
| A2 | PASS | — | §1 baseline PASS |
| A3 | PASS | — | §1 baseline PASS |
| A4 | PASS | — | §1 baseline PASS |
| A5 | PASS | — | §1 baseline PASS |
| A6 | PASS | — | §1 baseline PASS |
| A7 | PASS | — | §1 baseline PASS |
| A8 | PASS | — | §1 baseline PASS |
| A9 | PASS | — | §1 baseline PASS |
| A10 | PASS | — | §1 baseline PASS |
| A11 | PASS | 必须 | §47：role p50/p90 与 failRate；`surface-bounds-selftest` 通过。 |
| A12 | PASS | — | §14 |
| A13 | PASS | — | §14 |
| A14 | PASS | — | §1 baseline PASS |
| A15 | PASS | — | §14 |
| A16 | PASS | — | §16 |
| A17 | PASS | — | §1 baseline PASS |
| A18 | PASS | — | §14 |
| A19 | PASS | — | §1 baseline PASS |
| A20 | PASS | — | §24/§25 |
| A21 | PASS | 必须 | §50：真实 HTTP `/metrics` 有 `cycle.p50/p90`、`byRole`、`queue.remainingMs`；`surface-bounds-selftest` 三者显式断言。 |
| S1 | PASS | — | §1 baseline PASS |
| S2 | PASS | — | §1 baseline PASS |
| S3 | PASS | — | §1 baseline PASS |
| S4 | PASS | — | §1 baseline PASS |
| S5 | PASS | 必须 | §47：`replay-scale-selftest` 10,500 events/nodes，100 行页 29,735 B、11.5 ms，<1 MB/<2000 ms。 |
| S6 | PASS | — | §1 baseline PASS |
| S7 | PASS | — | §1 baseline PASS |
| S8 | N/A | — | 浏览器绘制 N/A。 |
| S9 | N/A | — | 浏览器 FPS/绘制 N/A。 |
| S10 | PASS | — | §1 baseline PASS |
| S11 | PASS | — | §17 |
| S12 | PASS | — | §24/§25 |
| S13 | PASS | — | §24/§25 |
| S14 | PASS | — | §1 baseline PASS |

## 一致性检查

- 174 个 ID 全部出现一次；无重复、无合并行。
- PASS 166 + FAIL 0 + N/A 8 = 174。
- FAIL 0；8 N/A = C3/C4/C9/C10/C11/5.1.5/S8/S9（真实 provider/审批/FPS 等仍未测量）。
- `B22` 已在 round 21 独立 PASS（§46.7；48 对、token 矩阵、body actor、破坏性 gate）；`U2` 已独立 PASS；`5.2`、`5.3`、`5.3.3`、`Q3` 是独立 PASS，不是“由 B22/B23 覆盖”。
- §53 独立重放：**O3/B13/5.3.9 全部 PASS**；这是第一次独立的 **154/10/10**，保留为历史事实，不因 round 27 作者更新而擦除。
- §54.6 独立重放：**156/8/10**（历史事实，保留）。
- §55 作者收口：**166/0/8**；B11/B14/B16/Q8/5.4/C8/C14/5.3.10 全部经生产接线关闭，5.1.1/5.1.3 随之关闭；C3/C4/C9/C10/C11/5.1.5/S8/S9 仍 N/A。
