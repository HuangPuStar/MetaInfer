# 设计条目 → 代码 / 测试映射

> 设计来源：[`DESIGN-CHECKLIST.md`](DESIGN-CHECKLIST.md)（B/D/G/Q/U/O/S 编号）与
> [`docs/07-async-refactor-plan.md`](../07-async-refactor-plan.md)。
> 每条要么给出**文件 · 函数 · 测试**，要么写 `未完成` + 原因。状态只有「完成 / 未完成」，
> 没有「部分完成」——部分完成的条目拆成两条。
>
> 分支：`refactor/v2`。测试入口：`npm test`（37 个自测文件 / 676 checks，见文末）。

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
| P1.2 冷段归档（只读段 + checksum） | 完成 | `host/kernel/eventlog.js` `createEventArchive`（zstd JSONL 段 `seg-<from>-<to>.jsonl.zst` + `.sha256`，原子写、只追加）；`host/store.js` `archiveEvents` 把最老连续段移出 hot 表，`listEvents`/`pageEvents` 经 `allEvents` 透明合并 cold+hot | `eventlog-selftest.mjs`（7 事件/hot 3 段 2；跨段 list/page；重启同 domain 继续归档无缺口；坏 checksum 硬失败） |

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
| `maxPlannedInFlight` WIP 上限（Q3 机制 B） | 完成 | `host/auto.js` `maxPlannedInFlightOf` 默认 `max(2 × freeSlots, 4)`，项目可显式覆盖；`tickOne` 在队列（runnable + claimed + held）达到上限时跳过 advisor pass，`status.lastPlanSkip='maxPlannedInFlight'`；仍先走确定性 dispatch | `auto-wip-selftest.mjs` 4/4（公式、超限跳过、未超限规划、显式覆盖） |
| `reservedSlots.p0` | 完成 | `host/dispatch/reservation.js`：默认 0；p0 等待时只允许 `free - reserved` 个非 p0 进入本轮候选，无 p0 时不改变行为；`dispatchOnce` 在 `fairOrder` 之前过滤，仍是投影视图而非第二队列 | `reserved-slots-selftest` 6/6（默认 0、两种配置形状、p0 保留、无 p0 全放行、真实 dispatch 集成） |
| 项目内 p0 抢占 | 未完成 | 需要 runtime 的 preempt 入口、10 min 受害者选择与 `dispatch/preempt` 策略；当前只有集群级抢占 P3.5.9，默认关闭 | 未接线；不把 `reservedSlots.p0` 当成抢占 |

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
| 5.3.16 `resource_status` | 完成 | `policy.js` `ACTION_CATALOG.resource_status`（总数 83）、`agent-tool.js` `ACTION_ENUM`、`lab-service.resourceStatus` 真实分支；返回 pools/free/held、queue position、blockedBy、reservedStartAt | `tool-surface-selftest.mjs` 4 条（可调用、pools、queue、无 nodeId）；`policy-selftest.mjs` 83=83 |
| 分页工具 `nodes_page` / `events_page` | 完成 | `lab-service.nodesPageAction/eventsPageAction`（cursor/after + `hasMore`） | `tool-surface-selftest.mjs`（第二页 cursor） |
| claim 工具 `claim_review`/`release_review`/`review_claims` | 完成 | `lab-service` 调用 `orchestrator.reviewClaims`（服务端 actor 作 expertId） | `tool-surface-selftest.mjs` |
| Q6 探索预算 4 查询 / 20k token / 240 s | 完成 | `host/context/limits.js` 默认值；`lab-service` 每会话预算 | `context-selftest.mjs` |
| B21 意图日志（TTL/basis/幂等合并） | 完成 | `kernel/intent.js` `intentBasis`/`basisFor`（`basis:{projectRevision,snapshotAgeMs,nodesSeen}` 三字段，对象缺失/标量/越界拒绝）；`lab-service.submitIntent` 仅用 `basis.projectRevision` 做同目标陈旧冲突（返回 `stale_basis` + conflictingIntentId），`snapshotAgeMs`/`nodesSeen` 仅作证据；dispatch/priority/proposal 全部写结构化 basis | `intent-selftest.mjs`（三字段精确、标量/缺字段/超前 revision 拒绝）；`dispatch-selftest.mjs`（dispatch intent basis） |
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
| S8 UI 首屏渲染 | 完成（视口窗口化预算）；浏览器绘制不适用 | `client.js` `computeViewportWindow`（≤300 卡、边只连可见点） | `ui-selftest.mjs` 11/11（含专家库读取 Host 目录）；本机无 Chromium/Playwright，见 VERIFICATION §20.7，不再列为待办 |
| S9 UI 事件风暴 | 完成 | `client.js` `applyChangeDelta` + `api.fetchChanges` | 同上（合并/拒收两例） |
| S10 增量读 | 完成 | `store.changesSince` + `/changes` | `scale-selftest.mjs` |
| S11 分页覆盖 | 完成 | `http.js` `/state`（默认 1,000）、`/transcript`（首 200 行）、`/replay`（2,000/2,000）；MCP `list_nodes` 100 行游标、`get_node` 直取；`nodes_page`/`events_page`/`runs_page` | `surface-bounds-selftest.mjs`、`tool-surface-selftest.mjs` |
| S12 事件增长 / 冷段 | 完成 | 同 P1.2：hot 窗口默认 50,000，超出后按 10,000 条连续段归档；归档段只读、带 checksum、永不删除；`host/store.js` 的 `timelineCache` 在归档边界预热 cold+hot 合并视图，之后只追加 hot 尾部，首读不再解压/排序全部事件 | `eventlog-selftest.mjs`（热/冷合并读、分页、重启续写、checksum 失败）；`scale-selftest.mjs` 100,000 条进程内首读 0.66 ms、真实 `openStore` 重启后首读 1.93 ms（预算 50 ms）；冷段带 `*.head.json` 首屏缓存，重启首读不再解压全部冷段，也不构建 50k hot 索引 |
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
| U11 i18n 键平滑（两表键相等、占位符一致） | 完成 | `locale/en.json`/`zh.json` 均为 1,371 键；JSON 是唯一源，`scripts/locale-sync.mjs` 只生成客户端字典块，`locale-selftest.mjs` 按 key set 与每键占位符比较 | `locale-selftest.mjs`（key set/placeholder/非空/t() 覆盖；改坏客户端字典时 RED） |
| U11b 全量文案迁移到 `locale/*.json` | 完成 | 1,371 条文案在 `locale/*.json`；JSON → 客户端单向生成；漂移测试只报错、不回写 JSON；`locale:sync` 永不改 JSON | `locale-selftest.mjs`（客户端改一个值即 RED）、`npm run locale:sync` |
| U12 空/加载/错误三态 | 完成（Host facts/rail/canvas/inspector/专家库）/ 未完成（队列面板） | `client.js` `HostFactsCard`（loading/empty/error/retry）；`SettingsModal` 专家库 loading/error/empty + 刷新 | 手工 + `ui-selftest.mjs`/`surface-bounds-selftest.mjs` |
| U13 agent 数据 vs Host 数据可区分 | 完成 | `lab-service.dashboardHostFacts`（唯一 Host 事实：revision/counts/resources/computedAt）；`dashboardView` 给每个 widget 标 `dataSource: host\|agent`、chat 标 `source: human\|agent`；`client.js` `.rl-dash-facts` + `.rl-dw-source` 徽标；agent 文本只出现在 commentary/widget body，不进入 hostFacts | `dashboard-selftest.mjs`（hostFacts 不含 agent prose、chat source、widget source） |
| U14 仪表盘静默过期 | 完成 | `lab-service.dashboardView` 以 `lastSuccessAt`（失败时保留上一次成功时间）计算 `ageMs/stale`；成功刷新记录实际读取的 revision（`revision` / `dataRevision`）和写入后的 `committedRevision`，失败刷新保留上次成功 revision；失败状态无条件 `staleReason:'refresh_failed'`；连续 3 次失败 `degraded:true`，widget 隐藏数字并显示上次成功时间，`nextRunAt` 指数退避（上限 30 min）；`client.js` 显示可关闭 `.rl-dash-alert` | `dashboard-selftest.mjs`（成功 revision、失败对齐 revision 仍 stale、partial 失败也 stale + 累计 failureCount/退避、连续失败降级/退避）；`client-smoke.mjs`（partial 也渲染 `.rl-dash-alert`）；`ui-selftest.mjs`（警报可关闭、失败次数） |
| 选中节点加载全量 prompt/report | 完成 | `client.js` `api.fetchNode` + `fullNode`（state 只留索引） | `scale-selftest.mjs`（全量 prompt 仍可取） |

## 8. Stage 3–5 专家与清理

| 条目 | 状态 | 原因 |
|---|---|---|
| B17/B18 专家描述符 + 标签 | 完成 | `host/experts/registry.js` 八个字段（persona/model/tools/triggers/mayPropose/mayExecute/budget/schema）+ `computeExpertMetrics`；`expert_list`/`expert_recall` 真实工具入口 | `experts-selftest.mjs`（字段契约、metrics、确定性召回、生产 action） |
| B17 相似度谓词（promptHash 前缀 / 同父+criteria / metrics） | 完成 | `host/experts/similarity.js` `similarityEvidence`：promptHash 前缀、同 parentId + criteria Jaccard ≥0.5、metric targets 相等，外加 title/tags；节点写入 `promptHash` | `experts-selftest.mjs`（三种谓词各自命中、确定性、merge 排除） |
| 相似度召回（Jaccard/top-K） | 完成 | `host/experts/similarity.js` 纯函数穷举候选对；merge 多父节点排除；`recallExperts` 用于任务→专家 | `experts-selftest.mjs`（同输入同输出、已知重复对、merge 排除） |
| B19 curator 只提名 + 误杀熔断 | 完成 | `host/experts/curator.js` 单轮 ≤5、10 分钟免疫（自身年龄 + 有幼子的 parent）、pending claim/review 排除、`curator_cannot_execute`、`falseCloseRate > 20%` 断路；服务把真实 dispatch/review claim 传入，`curator_nominate` 写 `curate` intent；`curator_reset` 有生产 action | `experts-selftest.mjs`（免疫边界、claim 排除、提名/执行拒绝/熔断/reset） |
| B20 建子节点自动撤回 defer 提名 | 完成 | `kernel/mutations.js` `node.create`：同提交把针对 parent 的 pending curate nomination 置 `withdrawn` 并发 `nomination/withdrawn{reason:child_created}`；curator 反向免疫有幼子的 parent | `experts-selftest.mjs`（真实 executor 建 child 后 parent nomination withdrawn） |
| B24 evidence 指针与权限分级 | 完成 | 意图 claim 必带 action；描述符 `mayExecute: []`；curator 不能执行 | `intent-selftest.mjs`、`experts-selftest.mjs` |
| 4.5 专家 hire/fire/drain | 完成 | `lab-service.hireExpert/drainExpert/fireExpert`：roster 存 `project.config.experts`；hire 拒绝 expert actor/self；drain 只置 `draining` 并保留 running；fire 要求先 drain、仍 running 返回 `expert_busy`、把未完成节点 `createdBy` 交还 human；`recallExpertFor` 只招 active；`expert_list` 返回 lifecycle；设置弹窗按状态显示 Hire/Drain/Retire | `expert-lifecycle-selftest.mjs`（15 checks：策略拒绝、hire、recall、drain 保活、busy fire、retire 移交、self-hire）；`ui-selftest.mjs` |
| B27 7 谓词 claim 校验 + 5 级验证强度 | 完成 | `host/kernel/claims.js` `VERIFICATION_LEVELS` / `ACTION_VERIFICATION`：L0 planned=0、L1 defer=1、L2 cancel_running=2+chief+独立 human/system 确认、L3 prune_branch=3+chief+human/system 确认+appeal、L4 delete_project=human+human/system 确认+appeal；`gateClaimAction` 对 `IRREVERSIBLE_ACTIONS` 无条件要求 `humanConfirmed`，确认不是请求布尔值，而是 `lab-service.appealState` 从“raiser/requester/resolver 三者两两不同，且 target node + targetAction 精确匹配的 resolved appeal”派生；`submitIntent` 仍只接受 human/chief 的 `chiefConfirmed`，并持久化 `claim.gate` | `claims-selftest.mjs`（5 级映射；每个不可逆动作一条证据被拒；2/3 条、chief、appeal、human confirmation 的 required set 通过；humanConfirmed 请求布尔值单独不能解锁；请求者不能复用自己写下的 appeal resolution）；`submitIntent` 将 `{action:'appeal'}` 写成 `kind:'appeal'`，同目标 pending appeal 以 `appeal_pending` 阻断不可逆动作；withdrawn 永不因 TTL 变成许可，显式 resolution 后才 `resolved`；`appealUntil` 不接受调用方输入，窗口由 Host 写入的 appeal expiresAt（opened 时间派生）计算；`kind:'appeal'` 必须 `claim.action:'appeal'`，`resolveAppeal` 同时检查 kind 与 claim.action，mismatch 返回 `intent_action_mismatch`；L0/L1 不套 C7 floor；`claim.targetAction` 必填且必须是不可逆 action，unscoped/differently-scoped 返回 `appeal_target_mismatch`；`intent.withdraw` 并发 resolve 只有一个 `appeal/resolved`；`claims-selftest` 覆盖 unscoped、自提、cross-target、Promise.all reject/upheld |
| C7 Wilson 下界 + 最少证据 | 完成 | `host/kernel/claims.js` `wilsonLowerBound`（95% one-sided, z=1.96）；`MIN_CITATION_EVIDENCE=20`、`MIN_CITATION_LOWER_BOUND=0.80`；`gateClaimAction` 在 B27 行动门槛之后强制历史 clean-rate 下界与原始 rate<5%，两条门控共用一次调用 | `claims-selftest.mjs`（20 clean 通过；19 条 floor；20 条 4 失败 confidence 拒绝；B27+C7 同时不可绕过） |
| `experts_list` / `expert_upsert` / `curator_scan` 旧名 | 完成（移除） | 旧名保持从 `ACTION_ENUM`/`ACTION_CATALOG` 删除；`expert_list`/`expert_recall`/`intent_*`/`curator_nominate`/`curator_outcome`/`curator_reset` 是三表一致的实现 | `policy-selftest.mjs`、`tool-surface-selftest.mjs`（三表一致，不残留旧名） |
| G3 只存 id/摘要 | 完成 | `lab-service` state 瘦身、`reportText` 删除、`_truncated` |
| G4 专家只能提议 | 完成 | 能力表 `lab-worker`/`lab-advisor` 无写权限 action |

## 9. 覆盖统计

- 条目总数：**93**
- 完成：**85**；未完成：**4**（`maxPlannedInFlight`/抢占、schema 收窄、覆盖率哨兵、O12 文本审计）；拆分条目：**2**（U8、U12）
- 未完成原因集中在：`maxPlannedInFlight`/抢占、Stage 5 组织化能力、覆盖率哨兵；
  浏览器绘制在本机不可测（无 Chromium/Playwright），已关闭为不适用，不再列为待办。
- `npm test` 覆盖 **37** 个文件（**676** checks）：`strict-writes`（executor 覆盖 + 默认 throw + 删除守卫）、
  `replay-client`（真实 HTTP 分页跟随）、`intent`（结构化 basis/claim）、`claims`（7 谓词/
  citationErrorRate）、`eventlog`（冷段/checksum/重启）、`dashboard`（Host facts/stale）、
  `experts`（描述符/三谓词召回/curator/生命周期）、`locale`（JSON 源 + 结构 parity）；
  actorKey（session pin、legacy 精确回退、Unicode/namespace 真实 handler）在
  `claims-selftest` 中覆盖，无重复执行。

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
