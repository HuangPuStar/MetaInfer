# 异步重构进度

> 计划见 [`docs/07-async-refactor-plan.md`](../07-async-refactor-plan.md)，设计条目见
> [`DESIGN-CHECKLIST.md`](DESIGN-CHECKLIST.md)，逐条落地映射见
> [`IMPLEMENTATION.md`](IMPLEMENTATION.md)。
> 本表是**本分支**的进度事实源：状态只有 todo / doing / done / blocked 四种。
> `refactor/async-foundation` 上的 P0–P3 spike 记录见文末「历史（地基分支）」。

## 分支

| 分支 | 内容 |
|---|---|
| `refactor/v2` | 基于 `refactor/async-foundation` 的彻底重构：读路径索引、确定性调度、能力表、可观测性、规模与 UI 预算 |

## 提交

| 提交 | 内容 |
|---|---|
| `dd5ca19` | P2.1(B8) 单一 `runnable` 谓词；`deferred` 是 planned 但永不可运行 |
| `8be444c` | P2.2(B3,G5) `dispatchOnce` 确定性快路，500 节点 <100 ms |
| `0170092` | P2.3(Q7) 低水位触发 + debounce + 容量等待原因 |
| `d8565d6` | P2.4(Q9) review claim：同一父节点的提案并发互斥 |
| `a03b72f` | P1.4-Q6(B25) 12 KB advisor 上下文、假设账本、`dag_query`/`dag_get`、探索预算 |
| `76300ce` | P5.1(A1,A2,B1,B2) Host 计算的状态事实、metrics 收集器、`explain_node`/`trace_explain`、cause 指针 |
| `cc792d9` | P2.5(B1,B8,G6) 把 `dispatchOnce` 接进 auto tick 与终止回调；preset 能力表在 handler 层生效；注册 dag 工具；O(1) 读 + `changes_since` |
| `f7036d4` | P6.1(A3,A5,S1–S10) 5k 读预算、`state` 瘦身 + 单节点全量、`changes_since`、优先级干预 UI、Host facts 卡片 |
| `cd18309` | P6.2(S8,S9) 视口窗口化 DAG、分页 rail、增量 `changes_since` 合并、UI 预算测试 |
| `68ddffc` | P5.2(G1) `kernel.strictWrites` 守卫（ALS 写许可）、health 暴露计数、throw 模式测试 |
| `218fe32` | P8.1(B1,B7,B15/S11) preset 默认拒绝 + `lab-chat`/`lab-merge`/`lab-dashboard` 策略；枚举/策略/处理器三表一致；优先级只走 executor，运行后拒绝 |
| `5f2ec13` | P8.2(B26,U4/U9/O8) 报告 summary 源头上限 500 + Host 派生 headline；`persistNode` 每条事件带 `causeId`；UI 原因链面板 |
| `317543c` | P9.1(S6,U11) 新增 `policy`/`tool-surface`/`priority`/`trace`/`snapshot-size`/`i18n-parity` 验收脚本；`bench:scale`；全部接入 `npm test` |
| `f67348f` | P9.3(S11,B15,O8,T1–T4) 四个假测试先红后绿；planned cancel/merge/GC 全部带 cause；dag 6 KB/24 KB 上限 + revision + 真 `sinceRevision`；`/state` 分页、transcript/replay/MCP 有界 |
| `4431441` | P9.3b(B15) `dag_walk` 截断元数据报告最终序列化字节数（`used`=24,494） |

## 状态

| WP | 状态 | 提交 | 偏差 / 说明 |
|---|---|---|---|
| P1.1 Priority 元组 | done | `a1f00d6` | 纯函数 + `fairOrder`；`fairOrder` 在 5k 节点改为 O(n×limit) 选择，去掉每次 splice |
| P1.2 journal / 冷段归档 | done | `1b2b83f` | hot 默认 50,000、10,000 条连续段；只读 zstd 段 + `.sha256`，透明合并读；`eventlog-selftest` 覆盖重启续写与坏 checksum |
| P1.3 Executor | done | `a1f00d6` | 幂等表进程内 Map；cause 指针随 mutation 写入（`node.causeId`/`lastCauseId`） |
| P1.4 Projection | done | `a1f00d6` | 启动 `load()` + `store.subscribeNodes` 兜底同步 legacy 写者 |
| P1.5 EventBus | done | `a1f00d6` | 已接 executor 与投影 |
| P1.6 Trace | done | `76300ce` | `explain_node` / `trace_explain`（阶段 proposal→approval→dispatch→start→outcome+ledger/review） |
| P1.7 迁移写者 | doing | — | 64 处 legacy 直接写仍在；`kernel.strictWrites=warn` 计数暴露，未逐个改造 |
| P1.8 读路径走 Projection | done | `cc792d9` | `state`/`status`/`metrics`/`dispatch` 全走 store 索引投影；剩余 O(N) 扫描已列在 IMPLEMENTATION.md |
| P1.9 增量 getState | done | `cc792d9` | `changes_since` 服务端 journal + 客户端增量合并（`cd18309`） |
| P1.10 Domain v2 | done | 见文末 | 离线迁移工具 `scripts/migrate-domain.mjs`（plan/run/verify/enrich）+ 11 条自测；插件只认 v2 |
| P2.1 Command 模型 | done | `8be444c` | `dispatchOnce` 只用 `node.claim` 作为提交点，无 `starting` 状态 |
| P2.2 Policy 能力表 | done | `cc792d9` `218fe32` | handler 层 `forbidden_action`；未列出的 preset 默认只读（`DEFAULT_PRESET_ACTIONS`），不再回落到全量；schema enum 仍全局（见 OPEN-QUESTIONS.md） |
| P8.1 preset 默认拒绝 | done | `218fe32` | `lab-chat`/`lab-merge`/`lab-dashboard` 显式策略；`lab-rogue` 仅 15 个只读 action；逐 preset 测试 |
| P8.2 优先级单写者 | done | `218fe32` | `setNodePriority`/`updateNode` 走 `kernel.executor.commit`；planned/proposed 之外返回 `priority_frozen`；kernel mutation 二次校验 |
| P8.3 工具面一致 | done | `218fe32` | `dag_map/walk/diff`、`nodes_page/events_page`、`claim_review/release_review/review_claims`、`health` 可调用；`get_node`/`dashboard_get` 入目录；`intent_*`/`expert_*`/`curator_*` 均已实现并三表一致 |
| P9.3 工具契约与出口 | done | `f67348f` | `dag_map` 6 KB / `dag_walk` 24 KB 硬上限；`dag_*` 带 `revision`；`dag_diff` 使用 `sinceRevision`；`/state` 1,000 节点分页；transcript/replay/MCP 列表有界 |
| P9.4 cause 全覆盖 | done | `f67348f` | planned cancel 用真实 runtime 探针；store 为 merge/GC/reconcile 等非激活写补稳定 `causeId`；`explain_node` 回退 `lastCauseId` |
| P9.5 测试真实性 | done | `f67348f` | trace 用真实事件、tool-surface 断言精确 `unknown_action`、i18n 解析未加引号键、priority 断言真实 actor |
| P2.3 低水位 | done | `0170092` | 5 min 剩余 / 60 s debounce / 30 s minGap |
| P3.6 接入 Dispatcher | done | `cc792d9` | `index.js` 构造 kernel/broker 映射；auto tick 与 `onTerminated` 都调 |
| P3 dag_map/walk/diff | done | `218fe32` | 已接 `agentTool`；`tool-surface-selftest.mjs` 驱动真实调用 |
| P3 意图日志 | done | `9bdd581` | `basis:{projectRevision,snapshotAgeMs,nodesSeen}` 对象；TTL/撤回/同目标陈旧冲突；dispatch/priority/proposal 生产写入 |
| P4.x 专家运行时 | done | `66d9ffe`/`652a545` | 描述符、绩效指标、相似度/curator、hire/drain/fire roster；专家仍只能提议 |
| P5–P7 curator / 争议 / 竞争 | doing | `66d9ffe` | curator 提名/熔断已接；Stage 5 组织化与竞争策略仍未完成 |
| A 可用性 | done | `76300ce` `f7036d4` | `explain_node`、Host facts 卡片（loading/empty/error）、优先级干预、可操作错误码 |
| B 可观测性 | done | `76300ce` | cycle 延迟、advisor 输入字节/占比、dispatch p95、队列深度、角色失败率、stall |
| S 规模与卡顿 | done | `f7036d4` `cd18309` | 5k 基准与 UI 预算见 IMPLEMENTATION.md「规模与卡顿」；本机无 Chromium/Playwright，浏览器绘制关闭为不适用 |
| G1 单一写者 | done | `68ddffc`/`137b293` | 守卫与许可覆盖删除路径；legacy 直写仍有统计，但生产写路径已收口 |
| G2 事件永不删除 | done | `a1f00d6` | `deleteEventRecord` 仅用于 recover 丢弃未确认尾部 |

## 未完成项（进入下一轮）

1. **P1.7 legacy 写点迁移**：仍有直写统计；生产写路径已走 executor，但逐个清理历史写点属于后续工作。
2. **`maxPlannedInFlight` / 预留槽 / 抢占**：会改变线上吞吐，需先有观测基线。
3. **Stage 5 组织化能力**：多专家竞争/争议/组织级预算仍是 doing。
4. **覆盖率哨兵 / schema 级 per-preset 收窄 / O12 文本审计**：设计条目仍未完成。
5. **浏览器绘制/FPS**：本机无 Chromium/Playwright，已关闭为不可测；不再作为待办反复计数。

## 2026-11-10 独立复核修复（回应 VERIFICATION.md）

| 缺陷 | 修复 | 回归测试 |
|---|---|---|
| B1 `lab-chat` 可 `delete_project` | `PRESET_POLICIES` 增补 chat/merge/dashboard；未列出 preset 走 `DEFAULT_PRESET_ACTIONS`，actor kind 为 LEGACY（连 dispatch 也拒绝） | `policy-selftest.mjs` 逐 preset 矩阵 |
| B15/S11 15 个 action `unknown_command` | 11 个接线实现（dag/page/claim/health），4 个未实现名字连同 `intent_*` 从枚举/目录移除；`get_node`/`dashboard_get` 入目录 | `tool-surface-selftest.mjs`、`policy-selftest.mjs` 三表一致 |
| B7 优先级绕过 executor | `setNodePriority`/`updateNode` 走 `executor.commit`，kernel mutation 二次校验，终态/运行中返回 `priority_frozen` | `priority-selftest.mjs`（service/kernel/updateNode） |
| B26 报告无源头上限 | schema `summary.maxLength=500`、prompt 规则、`normalizeNodeReport`（Host 派生 300 字符 headline，列表/指标有界） | `trace-selftest.mjs` |
| U4/U9/O8 原因链不在主路径 | `runtime.persistNode` 每条事件写 `causeId`；HTTP `/explain` + UI `ExplainPanel`（loading/empty/error） | `trace-selftest.mjs`、`observability-selftest.mjs` |
| 验收脚本缺失 | 新增 `policy`/`tool-surface`/`priority`/`trace`/`snapshot-size`/`i18n-parity`；`bench:scale` 别名；全部进 `npm test` | `npm test`（23 文件） |

### 第二轮复核（§14）追加修复

| 缺陷 | 修复 | 回归测试 |
|---|---|---|
| 4 个测试假绿 | trace 改真实 planned cancel；tool-surface 断言 `unknown_action`；i18n 解析未加引号键；priority 断言真实 actor | 先红后绿，`f67348f` 提交信息记录 RED 输出 |
| B15 dag 契约 | `dag_map` 6 KB（原 372,846 B）、`dag_walk` 24 KB/200 行、全部带 `revision`、`sinceRevision` 真生效 | `tool-surface-selftest.mjs` |
| O8 原因链洞 | planned cancel + merge prep + GC + reconcile 等非激活事件都有 cause | `trace-selftest.mjs`、store fallback |
| S11 无界出口 | `/state` 1,000 节点/页（客户端自动翻页）、transcript/replay limit、MCP list_nodes 分页 | `surface-bounds-selftest.mjs` |
| allowed 重复 | `allowedActions` 去重 | `policy-selftest.mjs` |

## 历史（地基分支 `refactor/async-foundation`）

| WP | 状态 | 提交 | 说明 |
|---|---|---|---|
| P0.1 cluster `acquire` 500 | done | `a1f00d6` | 专家补丁原样落地（`entry` → `request`） |
| P0.4–P0.6 派发包络 spike | done | `a1f00d6` | 纯函数 + 单测（`envelope.js` 7/7），未接运行路径 |
| P0.7 集群预取 spike | done | `a1f00d6` | `brokers.js` 适配器 + 测试 |
| P0.8 coordinator 签名 spike | done | `a1f00d6` | `gang-planner.js` 只做纯规划 |
| P0.5(K7) 提案宽度 | done | `fc81e2b` | 实测分支因子 1.43、并发 2.83/8 的直接原因 |
| P0.5(K15) `lab_cleanup` | done | `ae452ef` | 只删除不存在的工具引用 |
| P0.9 会话保留 | todo | — | D6 每次激活一个会话；DSH 无文件级 GC，需按天/字节归档 |
| P0.2 / P0.3 模拟器 | todo | — | 仅有 `sim/gang-starvation.mjs` |

## 2026-11-10 割接与首批线上数据

- 10:04:28 Host 重启完成，v2 域上线，项目 `prj-ea31447a` 在，254 节点、rev 737，启动日志无插件错误。
- 10:49:58 恢复 auto。**新代码下的第一个 cycle**（`cyc-2c0b08b1`）：

  | 指标 | 割接前 | 割接后第一个 cycle |
  |---|---|---|
  | created | 0–1 | **2** |
  | started | 1（`cyc-d98baca1` 只起 n-0215） | **10**（n-0216…n-0225、n-0241） |
  | planned 剩余 | 39 | 31 |

  这是第一次把机器填满。此前"一次只长一个节点"的判断得到现场确认。
- K16：`snapshot.js` 的 `reportSummary()` 是死代码（无调用方），删除。截断实际发生在
  建节点卡的两个内联 `truncate` 处。
- 观察：`maxRunningNodes=10` 是项目**有意**配置的，scheduler prompt 明确写了
  "GPU pool 24 单元、故意超订、节点数才是上限"。不要再按物理卡数去压它。

## 与计划的偏差（累计）

1. **P1.10 改为离线工具，插件零兼容**（S4）：新建 `metainfer_research_lab_v2`，一次性离线转换
   （`scripts/migrate-domain.mjs`），顺便把旧事件规范化；回滚就是从未被写过的 v1 目录。
2. **新增 P0.9**（S3）：D6 每次激活一个会话，而 DSH 没有会话文件 GC，5,000 节点规模下是磁盘泄漏。
3. **K7 提前**：不先解决它，P3.6 接进去也只是让每轮只产出一个节点的流水线变快。
4. **K15 只做一半**：只删掉 persona 里对不存在工具的指令，角色重设计留在 P4.7。
5. **`dispatchOnce` 预算不含实验 bootstrap**：<100 ms 指确定性选择 + lease + kernel claim +
   launcher 调用；`runtime.start` 的真实实验启动不计入。
6. **`kernel.strictWrites` 生产默认 `warn`**：不阻断线上 Host，但计数进 `health.writes`；
   测试用 `throw` 证明 executor 许可覆盖全部 kernel 写。

## 2026-11-10 第三轮验收修复 + Stage 3/4

| WP | 状态 | 提交 | 证据 |
|---|---|---|---|
| 写路径统一 | done | `6c7bb68` | `runtime/gc/reconcile/auto/orchestrator/lab-service` 全部经 `kernel.executor.commit`；`strict-writes-selftest` 静态扫描 + 真实写入探针 |
| 严格写默认 | done | `7a26956` | `strictWrites` 默认 `throw`；故意 `store.saveProject` 返回 `unpermitted_write`，stats 恰好 1 次 |
| `/replay` 客户端分页 | done | `50c8d80` | `replay-client-selftest`：3,001 节点 / 2,500 事件、4+ 次 `nodeCursor` 请求、无重复无静默截断 |
| B15 最终字节 | done | `50c8d80` | 5,000 owner `dag_map` 最终 ≤6,144 B；`dag_walk` ≤24,576 B；`bytes.used` 与序列化结果逐字节相等；walk total=4,999/5,000 |
| O8 节点指针 | done | `50c8d80` | 真实 `reconcileRunningNodes`、GC runner、merge-prep `node.put` 均使 `/explain` chain > 0 |
| S11 边界 | done | `50c8d80` | `/events` 默认 1,000；`/runs` cursor；MCP status 过滤 total=2,500；`getNode` O(1) 子索引 |
| Stage 3 意图日志 | done | `66d9ffe` | dispatch/priority/proposal 自动写 intent；`intent_submit`/`intent_list` 广告=handler=policy；claim 缺失/越界 basis/未知 kind 拒绝；目标节点可 explain |
| Stage 4 专家/curator | done | `66d9ffe` | 8 字段描述符、绩效指标、纯函数召回、curator ≤5 提名 + `curator_cannot_execute` + 20% 误杀熔断；`expert_list`/`expert_recall`/`curator_nominate` 生产入口 |
| locale 全量 | done（生成式镜像） | `791db98` | 1,338 键；`locale-selftest` 结构 key set + 占位符 parity；`npm run locale:sync` 生成 |
| 测试入口去重 | done | 未单独提交（随 `791db98`） | 27 个文件、408 checks；移除重复 `strict-writes`/`replay-client` 与旧文本 parity |

**仍开着**：冷段事件归档、dashboard 静默过期/来源徽标、7 谓词 claim 校验与
`citationErrorRate` 门控、浏览器绘制/FPS 实测、Stage 5 组织化能力。

## 2026-11-10 第四轮验收修复（G1 / locale / B17 / B20 / B21 / 4.4 / 4.5 / 3.2）

| WP | 状态 | 提交 | 证据 |
|---|---|---|---|
| G1 删除守卫 | done | `137b293` | `deleteProject` / `deleteEventRecord` 加 `guardWrite`；throw 下直接调用均 `unpermitted_write` 且数据不变；executor 路径仍成功；stats 精确 3 次拒绝 |
| locale 方向反转 | done | `027d2de` | `locale/*.json` 为唯一源；`locale-sync` 只生成客户端字典；改坏客户端一个值 → `locale-selftest` RED；恢复后绿 |
| 专家库 UI | done | `027d2de` | 设置弹窗新增只读专家库（id/persona/mayPropose/metrics/“只提议”），`GET /experts` + `fetchExperts`；空/加载/错误/刷新四态 |
| B17 真实谓词 | done | `c93e643` | promptHash 前缀、同父 + criteria、metric targets 三个谓词分别命中；节点落 `promptHash`；merge 多父排除 |
| B20 建子自动撤回 | done | `c93e643`/`0b8e5af`/`c7b6331` | 真实 executor `node.create` 同提交把 parent 的 pending curate 提名置 `withdrawn` 并写 `nomination/withdrawn{reason:child_created}`；有幼子的 parent 10 分钟内不提名 |
| B21 生命周期 | done | `c93e643`/`0b8e5af` | intent `expiresAt` 30 min、下一次写入自动 `intent/expired`、`intent_withdraw`、同目标旧 basis → `stale_basis` + conflictingIntentId；`curator_reset` 生产 action |
| curator 状态 | done | `c93e643` | 真实 dispatch/review claim 传入；10 分钟免疫边界测试；claims/reviews 排除；提名 intent 可撤回 |
| 3.2/B5 人类 p0 | done | `c93e643`/`39748a6` | 人类后继默认 `p0/by=human`；p0→dispatch claim 21 ms（<1 s），真实 dispatcher |

**测试**：`npm test` 27 个文件、436 checks 全绿。仍开着：冷段归档、dashboard 静默过期/来源徽标、
7 谓词 claim 校验与 `citationErrorRate`、浏览器绘制/FPS、Stage 5 组织化能力。

## 2026-11-10 第五轮验收修复（B21 / B27 / 冷段 / dashboard / 4.5）

| WP | 状态 | 提交 | 证据 |
|---|---|---|---|
| B21 结构化 basis | done | `9bdd581` | `kernel/intent.js` `intentBasis` 只接受 `{projectRevision,snapshotAgeMs,nodesSeen}` 三字段；标量/缺字段拒绝；`submitIntent` 只用 `basis.projectRevision` 做同目标冲突，`snapshotAgeMs`/`nodesSeen` 是证据；dispatch/priority/proposal 全部写对象 |
| B27 7 谓词 + citationErrorRate | done | `a455c1a` | `kernel/claims.js` 逐原子验证 nodeExists/statusIs/parentOf/metricIs/textContains/countWhere/reviewedBy；每次提交按 failed/total 更新 `claimStats`；`claim_invalid` 返回 failures；不可逆动作无证据/错误率 ≥5% 拒绝；`claims-selftest` 27 checks |
| P1.2/S12 冷段归档 | done | `1b2b83f` | `kernel/eventlog.js` zstd 段 + `.sha256` 原子写、只追加；`store.archiveEvents` 只移出最老连续段；`listEvents`/`pageEvents` 合并 cold+hot；hot 3 / segment 2 的真实重启测试无缺口；坏 checksum 硬失败 |
| U13/U14 dashboard 归属与过期 | done | `1daa988` | `dashboardView` 生成独立 `hostFacts`（revision/counts/resources）与 `commentary`；widget `dataSource: host|agent`、chat `source: human|agent`；stale 徽标带 age，revision drift 立即 stale；测试证明 agent prose 不进入 hostFacts |
| 4.5 hire/drain/fire | done | `652a545` | `project.config.experts` roster；hire 拒绝 expert/self；drain 保留 running 节点、只停止招募；fire 要求先 drain、running 未清返回 `expert_busy`，未完成节点 `createdBy` 交还 human；UI 按状态显示 Hire/Drain/Retire |
| 浏览器绘制 | 不适用（关闭） | — | 本机 `playwright`/`puppeteer`/`chromium`/`firefox` 均不存在，GUI URL 返回 401；无法测量首屏/交互帧。按用户裁决记一次，不再列为待办 |

**测试**：`npm test` 31 个文件、495 checks 全绿；`npm run bench:scale` 10/10。

## 第七轮（Round 6）：先关三个阻断项 + S12

| 提交 | 内容 | 证据 |
|---|---|---|
| `678981a` | P17.1(B27,C7) 5 级验证强度 + Wilson 下界/最少 20 条引用 | `claims-selftest` 44 checks；一条证据对 cancel/prune/delete 全拒；required set 通过；C7 floor/confidence 分别拒绝 |
| `5ce5279` | P17.2(U14,A20) 成功刷新记录实际读取 revision（`revision`/`dataRevision`）与写入后 `committedRevision`；失败刷新保留上次成功并永不 stale:false；可关闭告警、3 次失败降级/退避、widget 隐藏数字 | `dashboard-selftest` 10 checks；真实 `refreshDashboard` 成功/失败/连续失败；`ui-selftest` 12/12 |
| `6584441` | P17.2(U14) 把读 revision 与 dashboard 自身写入 revision 分开，freshness 用 `committedRevision` | 成功刷新 `lastRun.revision=2` 且非 stale；失败仍 stale |
| `e533164` | P18.1(D) jsdom 挂载 15 个面板 + degraded 载荷；修 `RunsPanel` 缺少 `cycles` 的崩溃 | `client-smoke` 15/15；`npm test` 32 文件 / 532 checks |
| 已落 | S12 100k 首读：`timelineCache` 归档边界预热 + hot 尾追加 | `scale-selftest` 11/11，100k 首读 0.27–0.35 ms（≤50 ms） |

状态：3 个阻断项清零；S12/A20 关闭。§22 计数 **87 PASS / 77 FAIL / 10 N/A**。
剩余 20 行只差文档/口径，57 行能力未建；本轮未开始 Stage 5。
