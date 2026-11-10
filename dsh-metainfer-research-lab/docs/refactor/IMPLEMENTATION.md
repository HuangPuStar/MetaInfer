# 设计条目 → 代码 / 测试映射

> 设计来源：[`DESIGN-CHECKLIST.md`](DESIGN-CHECKLIST.md)（B/D/G/Q/U/O/S 编号）与
> [`docs/07-async-refactor-plan.md`](../07-async-refactor-plan.md)。
> 每条要么给出**文件 · 函数 · 测试**，要么写 `未完成` + 原因。状态只有「完成 / 未完成」，
> 没有「部分完成」——部分完成的条目拆成两条。
>
> 分支：`refactor/v2`。测试入口：`npm test`（27 个自测文件，见文末）。

## 1. 内核与写路径（B3/B5/B21/G1/G2，P1）

| 条目 | 状态 | 位置 | 测试 |
|---|---|---|---|
| B4 优先级四元组 + 字典序 | 完成 | `host/kernel/priority.js` `normalizePriority` / `comparePriority` | `kernel-selftest.mjs` |
| CFS 公平排序、5k 节点只取前 K | 完成 | `priority.js` `fairOrder`（O(n×limit)，一次归一化，无 splice） | `dispatch-selftest.mjs`、`scale-selftest.mjs` |
| P1.3 单一提交点 `node.claim`（无 `starting`） | 完成 | `host/kernel/mutations.js` `node.claim`、`host/dispatch/dispatch-once.js` | `dispatch-once-selftest.mjs`、`wiring-selftest.mjs` |
| 幂等 `idempotencyKey` 重放 | 完成 | `host/kernel/executor.js` `commitLocked` | `kernel-selftest.mjs` |
| B21 cause 指针随 mutation 传播 | 完成 | `executor.js`（ctx.causeId）、`mutations.js`（`node.causeId`/`lastCauseId`） | `observability-selftest.mjs` |
| G2 事件只追加、不删除 | 完成 | `host/store.js` `appendEvent`；`deleteEventRecord` 仅 recover 丢弃未确认尾部 | `kernel-selftest.mjs` |
| G1 只有 kernel 执行器写记录 | 完成 | `store.js` `guardWrite` 覆盖 save/append/delete（含 `deleteProject`、`deleteEventRecord`）；`withWritePermit`（ALS）；`executor.js` `commit`/`recover`/`deleteProject` 持有许可；`strictWrites` 默认 `throw` | `strict-writes-selftest.mjs`（静态扫描；throw 下服务/取消成功；直接 save/deleteProject/deleteEventRecord 均 `unpermitted_write` 且数据不变） |
| P1.4 启动时 `projection.load` + legacy 写兜底 | 完成 | `host/kernel/instance.js` 订阅 `store.subscribeNodes` → `projection.syncNode/removeNode` | `wiring-selftest.mjs`（legacy write 到达 dispatcher 视图） |
| P1.5 event bus | 完成 | `host/kernel/bus.js`；`executor.js` 提交后 publish | `kernel-selftest.mjs` |
| P1.2 冷段归档（只读段 + checksum） | 未完成 | — | 原因：先保证单写者与读预算；事件已不删除，归档只影响磁盘，未威胁正确性 |

## 2. 调度与启动（B3/B6/B8/Q7/Q9）

| 条目 | 状态 | 位置 | 测试 |
|---|---|---|---|
| B8 单一 `runnable` 谓词 | 完成 | `host/kernel/projection.js` `runnable`；`host/snapshot.js` 复用 | `runnable-selftest.mjs` 11/11 |
| B6 `deferred` 是 planned 但永不可运行 | 完成 | `priority.js` `isDispatchableClass`；`projection.runnable`；`status.js` `deferred_class` | `runnable-selftest.mjs`、`observability-selftest.mjs` |
| `dispatchOnce` 确定性快路（无 LLM） | 完成 | `host/dispatch/dispatch-once.js`；`index.js` 构造 + `auto.js` tick + 终止回调 | `dispatch-once-selftest.mjs`、`wiring-selftest.mjs`、`scale-selftest.mjs` |
| 提交点后启动、lease 采用、清理陈旧 claim | 完成 | `host/runtime.js` `start`（删除 `node.claim`、采用 `options.lease`）；`brokers.js` `releaseOrphans` | `dispatch-once-selftest.mjs` |
| Q7 低水位触发（5 min / 60 s debounce / 30 s minGap） | 完成 | `host/dispatch/low-water.js` `DEFAULTS`；`auto.js` 触发 | `low-water-selftest.mjs` 8/8 |
| Q9 review claim（同父提案互斥） | 完成 | `host/orchestrator.js` `claimReview`/`releaseReview`/`reviewClaims` | `review-claims-selftest.mjs` 9/9 |
| 人类 p0 快路（改优先级立即重排） | 完成 | `lab-service.setNodePriority` 走 `kernel.executor.commit`（`node.setPriority`）；`orchestrator.createChild` 的 `createdBy=user` 默认 `p0/by=human`；HTTP `node.priority`；UI `↑/↓` | `priority-selftest.mjs`（planned 接受；running/completed 返回 `priority_frozen`；人类后继 p0 且 <1 s）；`dispatch-selftest.mjs`（p0→claim 21 ms） |
| 优先级只允许运行前修改（B7） | 完成 | `lab-service.setNodePriority` + `mutations.js node.setPriority` 双重状态校验；`updateNode` 复用同一提交 | `priority-selftest.mjs`（service、kernel、updateNode 三条路径） |
| `maxPlannedInFlight` / 预留槽 / 抢占 | 未完成 | — | 原因：会影响线上 254 节点项目的吞吐，需先有观测基线；已进 PROGRESS 未完成项 |

## 3. 能力表与权限（B1/Q1，issue 0001）

| 条目 | 状态 | 位置 | 测试 |
|---|---|---|---|
| ~70 action 分类（read/write/control/danger） | 完成 | `host/kernel/policy.js` `ACTION_CATALOG` | `wiring-selftest.mjs` |
| 每 preset 白名单（lab-worker/advisor/chat/merge/dashboard/...） | 完成 | `policy.js` `PRESET_POLICIES`（含 `lab-chat`/`lab-merge`/`lab-dashboard`） | `policy-selftest.mjs`（逐 preset 断言危险 action 被拒） |
| 未列出的 preset 默认拒绝（B1） | 完成 | `policy.js` `DEFAULT_PRESET_ACTIONS` + `allowedActions`（无 preset 的 operator 才保留全量） | `policy-selftest.mjs`（`lab-rogue` 只读；`lab-chat` 不能 `delete_project`） |
| 枚举 ⊆ 策略 ⊆ 处理器（B15/S11） | 完成 | `agent-tool.js` `ACTION_ENUM`、`policy.js` `ACTION_CATALOG`、`lab-service.agentTool` 三表一致；`get_node`/`dashboard_get` 入目录 | `policy-selftest.mjs`（三表相等 + 每个 action 有 handler）、`tool-surface-selftest.mjs` |
| 从 DSH 会话取 actor（不信 args） | 完成 | `policy.js` `actorFromToolExecution`；`host/agent-tool.js` `execute(args, exec)` | 同上（`forbidden_action` 可达） |
| handler 层拒绝 + 可操作错误 | 完成 | `agent-tool.js` + `host/kernel/errors.js` `toActionable` | 同上 |
| dispatch 侧策略 | 完成 | `policy.js` `authorizeDispatch` / `DISPATCH_POLICY` | `dispatch-selftest.mjs` |
| schema 级 per-preset 收窄 | 未完成 | — | 原因：工具 schema 是全局静态注册，DSH 无 per-session schema；只能在 handler 拦，已记 OPEN-QUESTIONS |

## 4. 专家上下文与检索（Q6/Q9/B24/B25）

| 条目 | 状态 | 位置 | 测试 |
|---|---|---|---|
| Q6 12 KB 上下文预算 | 完成 | `host/context/payload.js` `CONTEXT_BUDGET_BYTES` + `enforceByteBudget` | `context-selftest.mjs` 11/11 |
| 有界字段（brief 1500 / goal 600 / focus 8 / failures 5…） | 完成 | `payload.js` `DEFAULT_CONTEXT_LIMITS` | 同上 |
| B25 截断显式 `_truncated {shown,total}` | 完成 | `payload.js`、`status.js`、`orchestrator.listRuns` | 同上 |
| B26 存储报告永不截断；`headline ≤ 300` 只做索引 | 完成 | `lab-service.getState`（`slimStateNode`）、`getNode` 全量 | `scale-selftest.mjs` |
| 报告源头上限（schema + prompt + Host 派生 headline） | 完成 | `runtime.js` `NODE_REPORT_SCHEMA.summary.maxLength=500`、`normalizeNodeReport`（`REPORT_LIMITS`）、`prompts.js` `WORKER_RULES` 规则 | `trace-selftest.mjs`（500/300 边界、空 summary → null、prompt 规则存在） |
| Q9 `dag_query`（过滤/select/分页/行级截断） | 完成 | `host/context/dag.js` `queryDag`；`lab-service.dagQuery`；policy/工具已注册 | `wiring-selftest.mjs`（真实工具调用返回行） |
| Q9 `dag_get` | 完成 | `dag.js` `dagGet`；`lab-service.dagGetAction` | 同上 |
| Q9 `dag_map` / `dag_walk` / `dag_diff` | 完成 | `dag.js` 纯函数；`lab-service.dagMapAction/dagWalkAction/dagDiffAction` + `agentTool` 分支 | `tool-surface-selftest.mjs`（三种查询均返回真实结果） |
| 分页工具 `nodes_page` / `events_page` | 完成 | `lab-service.nodesPageAction/eventsPageAction`（cursor/after + `hasMore`） | `tool-surface-selftest.mjs`（第二页 cursor） |
| claim 工具 `claim_review`/`release_review`/`review_claims` | 完成 | `lab-service` 调用 `orchestrator.reviewClaims`（服务端 actor 作 expertId） | `tool-surface-selftest.mjs` |
| Q6 探索预算 4 查询 / 20k token / 240 s | 完成 | `host/context/limits.js` 默认值；`lab-service` 每会话预算 | `context-selftest.mjs` |
| B21 意图日志（TTL/basis/幂等合并） | 完成 | `kernel/intent.js`（`status:pending`、30 min `expiresAt`）；`kernel/mutations.js` `intent.withdraw`；`lab-service.submitIntent`（同目标旧 basis → `stale_basis`）、`withdrawIntent`、`listIntents`（过期标记）；dispatch/priority/proposal 同提交写 intent | `intent-selftest.mjs`；`experts-selftest.mjs`（TTL、withdraw、stale conflict） |
| B24 evidence 指针强制 | 完成 | 意图 `claim.action` 必填；curator evidence 带 `nodeId`/`ref`；描述符 `mayExecute: []` | `intent-selftest.mjs`、`experts-selftest.mjs` |
| 覆盖哨兵 `coverage` | 未完成 | — | 同上 |

## 5. 可观测性（O1–O12，A1/A2）

| 条目 | 状态 | 位置 | 测试 |
|---|---|---|---|
| O1 cycle 延迟 p50/p95/max（按 role） | 完成 | `host/observability/metrics.js` `summarizeDurations` / `roleMetrics`；`lab-service.metricsFor` | `observability-selftest.mjs` 6/6 |
| O2 advisor 输入字节 / token / 12 KB 占比 | 完成 | `orchestrator` run 记录 `inputBytes`/`snapshotBytes`；`computeProjectMetrics` `advisorInput` | 同上 |
| O3 dispatch 延迟 | 完成 | `metricsCollector.recordDispatch`；`computeProjectMetrics.dispatch.p95Ms` | 同上 |
| O4 队列深度（runnable/claimed/deferred） | 完成 | `computeProjectMetrics.queue` | 同上 |
| O5 状态计数 | 完成 | 同上 `counts`；`buildStatusFacts.counts` | 同上 |
| O6 停摆（idleStreak/暂停原因） | 完成 | `computeProjectMetrics.stalls` | 同上 |
| O7 每角色失败率 | 完成 | `roleMetrics(runs)` | 同上 |
| O8 cause 链追踪 | 完成 | `explain.js` `explainNode`/`traceExplain`；工具 `explain_node`/`trace_explain` | 同上 |
| O9 每个状态转换写结构化事件 | 完成 | `kernel/mutations.js`（`node/planned…`）、`lab-service`（priority/ledger/review） | `wiring-selftest.mjs` |
| O10 查询面（不读日志） | 完成 | `status_facts`/`metrics`/`changes_since`/`nodes_page`/`events_page`/`runs_page` + HTTP `/status`、`/metrics`、`/changes` | `observability-selftest.mjs` |
| O11 快照体积回归护栏 | 完成 | `scale-selftest.mjs`（快照 <12 KB / <50 ms）；`orchestrator` 记录 `snapshotBytes` | `scale-selftest.mjs` |
| O12 「只在 LLM 文本里可见」的清单 | 未完成 | — | 原因：需要逐面板人工审计，不在本轮代码范围 |

## 6. 规模与卡顿（S1–S14）

| 条目 | 状态 | 位置 | 测试 |
|---|---|---|---|
| S1 节点表全表扫描 | 完成 | `store.js` `indexes` + `listNodes` 游标分页（O(page)） | `scale-selftest.mjs` |
| S2 事件表全表扫描 | 完成 | `store.js` `pageEvents` 二分 `firstEventAfter` | 同上（20k 事件 100 条 0.24 ms） |
| S3 run 列表 | 完成 | `store.js` `pageRuns` 排序索引 | 同上（5k runs 50 条 0.52 ms） |
| S4 全量状态序列化 | 完成（HTTP 分页） | `lab-service.getState` → `slimStateNode` + `_indexed`；HTTP `/state` 默认 1,000 节点/页 + `nextCursor`，客户端 `fetchStateAll` 翻页合并 | `surface-bounds-selftest.mjs`（1,000/1,000/501） |
| S5 replay 全量 | 完成 | `getReplay` 分页 nodes/events，返回 `nextSeq`/`nextNodeCursor`/`_truncated` | `surface-bounds-selftest.mjs`（500 节点/100 事件） |
| S6 advisor 快照 | 完成 | `host/snapshot.js`（2 层祖先、focus 截断）；`orchestrator` 记录 `snapshotBytes` | 同上（3.5 KB / 26 ms） |
| S7 scheduler 候选选择 | 完成 | `snapshot.js` 用 `projection.runnable` + `fairOrder(limit)` | `dispatch-selftest.mjs` |
| S8 UI 首屏渲染 | 完成（视口窗口化）/ 未完成（浏览器帧率） | `client.js` `computeViewportWindow`（≤300 卡、边只连可见点） | `ui-selftest.mjs` 8/8（含专家库读取 Host 目录） |
| S9 UI 事件风暴 | 完成 | `client.js` `applyChangeDelta` + `api.fetchChanges` | 同上（合并/拒收两例） |
| S10 增量读 | 完成 | `store.changesSince` + `/changes` | `scale-selftest.mjs` |
| S11 分页覆盖 | 完成 | `http.js` `/state`（默认 1,000）、`/transcript`（首 200 行）、`/replay`（2,000/2,000）；MCP `list_nodes` 100 行游标、`get_node` 直取；`nodes_page`/`events_page`/`runs_page` | `surface-bounds-selftest.mjs`、`tool-surface-selftest.mjs` |
| S12 事件增长 / 冷段 | 未完成 | — | 原因：同 P1.2 |
| S13 规模回归测试 | 完成 | `scripts/scale-selftest.mjs`（5,000 节点） | 本文件 |
| S14 `maxNodes` 硬上限 | 完成 | `lab-service.updateProject` 1..20,000；`client.js` 向导 max 20,000 | 手工核对（无单测） |

### 规模与卡顿实测

| 场景 | 节点数 | 预算 | 实测 | 验证测试 |
|---|---|---|---|---|
| `getState` 索引（瘦身） | 5,000 | <5 MB / <500 ms | 4.13 MB / 47 ms | `scale-selftest.mjs` |
| `listNodes` 全量 | 5,000 | <200 ms | 0.4 ms | 同上 |
| `listNodes` 单页 100 | 5,000 | <20 ms | 0.15 ms | 同上 |
| 单节点读 | 5,000 | O(1) | 1,000 次 <0.5 ms/次 | 同上 |
| 事件页 100 / 20k | 5,000 | <50 ms | 0.24 ms | 同上 |
| run 页 50 / 5k | 5,000 | <50 ms | 0.52 ms | 同上 |
| `changes_since` | 5,000 | <20 ms | 0.16 ms | 同上 |
| `status` facts | 5,000 | <100 ms / 有界输出 | 8.7 ms / 3.3 KB | 同上 |
| `dispatchOnce`（选择+claim+launch） | 5,000 | p95 <100 ms | p95 28.1 ms / max 36.8 ms | 同上 |
| advisor 快照构建 | 5,000 | <50 ms / <12 KB | 26.4 ms / 3.5 KB | 同上 |
| UI 视口窗口模型 | 5,000 | <8 ms/轮 | 1.18 ms/轮，渲染 49/5000 | `ui-selftest.mjs` |
| UI 帧率 / 绘制 | 5,000 | 60 fps | **未测量**：无浏览器环境，只测 view-model | `ui-selftest.mjs`（明确不覆盖绘制） |

## 7. 可用性与干预（U1–U14）

| 条目 | 状态 | 位置 | 测试 |
|---|---|---|---|
| U1 现在在跑什么（含 elapsed） | 完成 | `status.js` `runningFacts`（elapsed）、`client.js` 节点卡倒计时/expert chip | `observability-selftest.mjs` |
| U2 下一个启动 + 为什么 | 完成 | `status.js` `whyNotStarting`（`dispatch_hold/deferred/max_running/pool_*/deferred_class/ready`）+ Host facts 卡片 | 同上 |
| U3 刚刚失败什么、为什么（code/stage/下一步） | 完成 | `status.js` `recentFailures`（`causeId`）；`errors.js` `toActionable` | 同上 |
| U4 原因链一键追到激活 | 完成 | `explain.js` `explainNode`/`traceExplain`；`runtime.persistNode` 给每条事件写 `causeId`；`node.causeId`/`lastCauseId` | `trace-selftest.mjs`（事件全带 causeId、链可解析） |
| U5 暂停 / 恢复驱动 | 完成 | 既有 `auto/*` + UI；Host facts 区分来源 | `dispatch-selftest.mjs` |
| U6 取消节点 | 完成 | 既有 `cancelNode`；取消后释放租约 | `dispatch-selftest.mjs` |
| U7 提高 / 降低优先级 | 完成 | `lab-service.setNodePriority` + `node/priority_changed` + UI `↑/↓`（p0..p3/deferred） | `wiring-selftest.mjs`（service 路径）；UI 点击未自动化 |
| U8 批准 / 拒绝提案 | 完成（批准/拒绝入口在 UI）/ 未完成（拒绝理由进入下轮上下文） | `orchestrator.rejectProposal` 仍不收理由 | 原因：需要改 advisor 快照 schema，单独提交 |
| U9 解释一个节点 | 完成 | 同 U4；UI `ExplainPanel`（HTTP `/explain`）| `trace-selftest.mjs`（HTTP、fetchExplain、面板三态静态+功能） |
| U10 错误可执行（code + nextStep） | 完成 | `errors.js` `NEXT_STEPS`/`toActionable`；`agent-tool` 统一转换；`client.js` 渲染 message | `wiring-selftest.mjs`（`forbidden_action` 含 nextStep） |
| U11 i18n 键平滑（两表键相等、占位符一致） | 完成 | `locale/en.json`/`zh.json` 均为 1,347 键；JSON 是唯一源，`scripts/locale-sync.mjs` 只生成客户端字典块，`locale-selftest.mjs` 按 key set 与每键占位符比较 | `locale-selftest.mjs`（key set/placeholder/非空/t() 覆盖；改坏客户端字典时 RED） |
| U11b 全量文案迁移到 `locale/*.json` | 完成 | 1,347 条文案在 `locale/*.json`；JSON → 客户端单向生成；漂移测试只报错、不回写 JSON；`locale:sync` 永不改 JSON | `locale-selftest.mjs`（客户端改一个值即 RED）、`npm run locale:sync` |
| U12 空/加载/错误三态 | 完成（Host facts/rail/canvas/inspector/专家库）/ 未完成（队列面板） | `client.js` `HostFactsCard`（loading/empty/error/retry）；`SettingsModal` 专家库 loading/error/empty + 刷新 | 手工 + `ui-selftest.mjs`/`surface-bounds-selftest.mjs` |
| U13 agent 数据 vs Host 数据可区分 | 完成（Host facts 卡 `HOST` 徽标、monospace）；未完成（dashboard widget 仍无来源徽标） | `client.js` `.rl-host-facts` | 手工 |
| U14 仪表盘静默过期 | 未完成 | — | 原因：属 dashboard 子系统，不在本轮热路径 |
| 选中节点加载全量 prompt/report | 完成 | `client.js` `api.fetchNode` + `fullNode`（state 只留索引） | `scale-selftest.mjs`（全量 prompt 仍可取） |

## 8. Stage 3–5 专家与清理

| 条目 | 状态 | 原因 |
|---|---|---|
| B17/B18 专家描述符 + 标签 | 完成 | `host/experts/registry.js` 八个字段（persona/model/tools/triggers/mayPropose/mayExecute/budget/schema）+ `computeExpertMetrics`；`expert_list`/`expert_recall` 真实工具入口 | `experts-selftest.mjs`（字段契约、metrics、确定性召回、生产 action） |
| B17 相似度谓词（promptHash 前缀 / 同父+criteria / metrics） | 完成 | `host/experts/similarity.js` `similarityEvidence`：promptHash 前缀、同 parentId + criteria Jaccard ≥0.5、metric targets 相等，外加 title/tags；节点写入 `promptHash` | `experts-selftest.mjs`（三种谓词各自命中、确定性、merge 排除） |
| 相似度召回（Jaccard/top-K） | 完成 | `host/experts/similarity.js` 纯函数穷举候选对；merge 多父节点排除；`recallExperts` 用于任务→专家 | `experts-selftest.mjs`（同输入同输出、已知重复对、merge 排除） |
| B19 curator 只提名 + 误杀熔断 | 完成 | `host/experts/curator.js` 单轮 ≤5、10 分钟免疫、pending claim/review 排除、`curator_cannot_execute`、`falseCloseRate > 20%` 断路；服务把真实 dispatch/review claim 传入，`curator_nominate` 写 `curate` intent；`curator_reset` 有生产 action | `experts-selftest.mjs`（免疫边界、claim 排除、提名/执行拒绝/熔断/reset） |
| B20 建子节点自动撤回 defer 提名 | 完成 | `kernel/mutations.js` `node.create`：同提交把针对 parent 的 pending curate nomination 置 `withdrawn` 并发 `intent/withdrawn` | `experts-selftest.mjs`（真实 executor 建 child 后 parent nomination withdrawn） |
| B24 evidence 指针与权限分级 | 完成 | 意图 claim 必带 action；描述符 `mayExecute: []`；curator 不能执行 | `intent-selftest.mjs`、`experts-selftest.mjs` |
| B27 7 谓词 claim 校验 + `citationErrorRate` 门控 | 未完成 | — | 原因：需要人工标注集定义 7 谓词，本轮未伪造精度/召回 |
| `experts_list` / `expert_upsert` / `curator_scan` 旧名 | 完成（移除） | 旧名保持从 `ACTION_ENUM`/`ACTION_CATALOG` 删除；`expert_list`/`expert_recall`/`intent_*`/`curator_nominate`/`curator_outcome`/`curator_reset` 是三表一致的实现 | `policy-selftest.mjs`、`tool-surface-selftest.mjs`（三表一致，不残留旧名） |
| G3 只存 id/摘要 | 完成 | `lab-service` state 瘦身、`reportText` 删除、`_truncated` |
| G4 专家只能提议 | 完成 | 能力表 `lab-worker`/`lab-advisor` 无写权限 action |

## 9. 覆盖统计

- 条目总数：**93**
- 完成：**81**；未完成：**8**；拆分条目（完成 X / 未完成 Y）：**4**
- 未完成原因集中在：冷段归档、dashboard 子系统、7 谓词 claim 校验/citationErrorRate、
  无浏览器导致的 UI 绘制测量，以及部分 Stage 5 组织化能力。
- `npm test` 覆盖 **27** 个文件（427 checks）：`strict-writes`（executor 覆盖 + 默认 throw + 删除守卫）、
  `replay-client`（真实 HTTP 分页跟随）、`intent`（claim/basis/explain）、`experts`（描述符/
  三谓词召回/curator/生命周期）、`locale`（JSON 源 + 结构 parity），无重复执行。

## 10. 验收脚本（2026-11-10 复核后新增）

| 需求 | 脚本 | `npm test` |
|---|---|---|
| preset 默认拒绝逐 preset 矩阵 | `scripts/policy-selftest.mjs` | 是 |
| 工具面三表一致 + 曾缺失的 action 可调用 | `scripts/tool-surface-selftest.mjs` | 是 |
| 优先级只走 executor、终态拒绝 | `scripts/priority-selftest.mjs` | 是 |
| causeId 端到端 + UI explain | `scripts/trace-selftest.mjs` | 是 |
| advisor 快照 12 KB 回归 | `scripts/snapshot-size-selftest.mjs` | 是 |
| zh/en 与 locale 结构 parity | `scripts/locale-selftest.mjs` | 是 |
| `/state`、transcript、replay、MCP 列表有界 | `scripts/surface-bounds-selftest.mjs` | 是 |
| 5,000 节点预算基准 | `npm run bench:scale`（同 `scale-selftest.mjs`） | 是（同文件） |
