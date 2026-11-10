# 174 行验收账本（round 24 修复后，待独立重放）

> 本文件是**账本**，不是独立的关闭记录。最后一个独立依据是 `VERIFICATION.md` §50（HEAD `06964cc`，150/14/10）；§51 是作者对 §50 四个反证的修复，作者账面为 154/10/10，尚待独立重放。这里确保每个 ID 恰好一个状态，且 residual 可加总。

## 汇总

| 状态 | 数量 |
|---|---:|
| PASS | **154** |
| FAIL | **10** |
| N/A（未测量/不适用） | **10** |
| 合计 | **174** |

推导：round 21 独立重放为 `121 / 43 / 10`；round 22 抽样把 11 行改判 FAIL，得到 `143 / 21 / 10`。§49 修复 11 行后作者账面为 `154 / 10 / 10`；§50 独立重放发现 **O3/C1/B13/5.3.9 四行仍 FAIL**，独立账面为 `150 / 14 / 10`。§51 按 §50 的语义重新修复这四行（runnable→claimed 起点、Projection byId、escalate reasonCode、共享 queue-overload 定义），作者账面回到 `154 / 10 / 10`；N/A 仍 10。

## residual 范围

| 范围 | 行数 |
|---|---:|
| 必须 | **0** |
| 应该 | **0** |
| 明确不做 | **10** |
| 合计 | **10** |

10 = **0 必须 + 0 应该 + 10 明确不做**。10 个明确不做：`B11`、`B12`、`B14`、`B16`、`Q8`、`5.4`、`C2`、`C8`、`C14`、`5.3.10`。B22/U2 已独立 PASS，不计入。`A11`、`S5`、`5.3.7`、`5.4.2`、`5.4.6` 保持 PASS（见 §48.1）；§49 的 O1/O2/O4/O5/A21/Q4/5.3.12 已由 §50 关闭；§50 的 O3/C1/B13/5.3.9 由 §51 关闭，待独立重放。

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
| B11 | FAIL | 明确不做 | D7 已选作用域分区，不建 branch/lead/chief 三级。 |
| B12 | FAIL | 明确不做 | D7 无固定层级，不设单点 chief。 |
| B13 | PASS | 应该 | §51：`INTENT_KINDS`/`INTENT_ACTIONS` 加入 `escalate`，`semanticFallback` 路由到 human dispute；`createIntent` 与 `submitIntent` 都要求 `claim.reasonCode` ∈ 六码，缺失/非法分别返回 `escalation_reason_required`/`escalation_reason_invalid`，测试覆盖 kernel 与服务两个写边界。 |
| B14 | FAIL | 明确不做 | chief 审批闸门不成立；dispute/arbiter 取代否决窗口。 |
| B15 | PASS | — | §17 |
| B16 | FAIL | 明确不做 | D6 明确不做驻留会话与 submit 工具。 |
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
| Q8 | FAIL | 明确不做 | D7 取消固定三级评审。 |
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
| 5.4 | FAIL | 明确不做 | D7 已取消分层评审，明确不做。 |
| C1 | PASS | 应该 | §51：Projection 的 `indexNode` 遇到 `archivedAt` 直接不写入 `byId`，archive 的 `node.merge` 经 `putNode` 先 unindex 再跳过；`projection.getNode` 返回 `undefined`，`checkConsistency` 为空，`store.listNodes`/`getState`/metrics 同步消失。 |
| C2 | FAIL | 明确不做 | 以单一 chief 为前提，v2 不设 chief。 |
| C3 | N/A | — | 真实浏览器绘制/时区 N/A；未测量。 |
| C4 | N/A | — | 真实 provider/LLM 端到端 N/A。 |
| C5 | PASS | 必须 | §47：`semanticFallback` 枚举 14 个动作；无 code/expert 出口的动作落 `human_review`，intent 记录携带 fallback；`claims-selftest` 3 探针通过。 |
| C6 | PASS | 应该 | §47：7/7 claim predicates 有可执行探针（100% ≥ 90%）；`claims-selftest` 通过。 |
| C7 | PASS | — | §23 |
| C8 | FAIL | 明确不做 | 建子节点即投票的计权治理不属于 v2。 |
| C9 | N/A | — | 自然人和双人审批 N/A。 |
| C10 | N/A | — | 真实 Host restart/provider 组合 N/A。 |
| C11 | N/A | — | 真实浏览器交互/截图 N/A。 |
| C12 | PASS | — | §24/§25 |
| C13 | PASS | — | §24/§25 |
| C14 | FAIL | 明确不做 | 接受一次性停机割接；迁移不是自动的。 |
| 5.1.1 | N/A | — | B16/D6 方向待 owner 裁决。 |
| 5.1.2 | PASS | — | §24/§25 |
| 5.1.3 | N/A | — | B11/D7 方向待 owner 裁决。 |
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
| 5.3.9 | PASS | 应该 | §51：`queueOverloadState` 是唯一 overload 定义（`planned > 2×freeSlots`），`observerSnapshot` 与 `evaluateThresholdTriggers` 共用；3 planned（含 1 deferred）、freeSlots=1 时 t0 不报、+5min 报 `queue_overload`，detail 为 `planned=3,queue=2`。 |
| 5.3.10 | FAIL | 明确不做 | 与 D7 三级评审冲突，明确不做。 |
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
| O3 | PASS | 必须 | §51：`runnableSince(node)` 取 `plannedAt`、`deferUntil`、`dispatchHold.untilMs` 的最大值，生产 dispatch 从该时刻算到 started；同一 1h-old/1ms-release fixture 的 `waitMs` 小于 5s，不再把 hold 时间算作 queue wait。 |
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
- PASS 154 + FAIL 10 + N/A 10 = 174。
- FAIL 10 = **0 必须 + 0 应该 + 10 明确不做**。
- `B22` 已在 round 21 独立 PASS（§46.7；48 对、token 矩阵、body actor、破坏性 gate）；`U2` 已独立 PASS；`5.2`、`5.3`、`5.3.3`、`Q3` 是独立 PASS，不是“由 B22/B23 覆盖”。
- 最后一个独立重放（§50）为 150/14/10；§51 的 154/10/10 是作者修复后的账面，尚待独立重放，不能声称已是独立结论。
