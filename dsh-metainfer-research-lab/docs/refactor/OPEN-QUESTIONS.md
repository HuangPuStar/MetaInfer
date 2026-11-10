# 重构中的裁决与未决问题

> 规则：遇到歧义 → 选**最简单且可逆**的方案 → 记录在这里；能靠代码/测试回答的，不留在文档里。
> 每条形如「问题 → 裁决 → 影响 → 可逆性」。

## 已裁决（本轮落地）

### A1. 每个 preset 的 schema 收窄做不到

- **问题**：B1 要求"advisor 只能调只读工具"，但 DSH 的 `ctx.tools.register` schema 是**全局静态**的，
  同一 action 枚举对所有会话可见，没有 per-session schema。
- **裁决**：schema 保持全局；在 `host/agent-tool.js` 的 `execute(args, exec)` 里用
  `actorFromToolExecution(exec)` 取 `session.header.meta.agentPreset`，交给
  `authorizeAction`，越权返回 `forbidden_action` + `allowed` + `nextStep`。
- **影响**：模型仍能看到全部 action 名字（persona 里已不再列出），但调用会被拒；issue 0001 的
  "能调就调"变成"调了被拒且知道该找谁"。
- **可逆性**：若 DSH 将来支持 per-session schema，删掉 handler 分支即可。

### A2. `dispatchOnce` 的 100 ms 预算不含实验 bootstrap

- **问题**：`runtime.start` 会起 git worktree / 子 agent 会话，耗时秒级；把它算进 100 ms 不可能。
- **裁决**：预算定义为「确定性选择 + broker lease + kernel `node.claim` + launcher 调用」；
  `runtime.start` 在 launcher 里异步执行，不计入。测试在 `dispatch-once-selftest.mjs`
  与 `scale-selftest.mjs` 用 fake launcher 度量。
- **影响**：指标诚实反映"调度快路"，不会被实验启动时间污染。
- **可逆性**：无（定义问题，不是实现选择）。

### A3. 账本（ledger）是事件投影，不是新表

- **问题**：B21/ledger 需要读写，但新增表会引入第二份事实（CLAUDE.md 的 SSOT 规则）。
- **裁决**：`ledger/*` 事件为唯一事实，`host/context/ledger.js` 的 reader 按 `seq` 增量投影；
  `ledger_update` 只追加事件、bump revision。
- **影响**：重启安全、可 replay；代价是首次读要扫事件（有索引后 O(1) 增量）。
- **可逆性**：高（reader 可丢）。

### A4. 预算/水位/上限取审计值，不取旧计划值

- **问题**：旧计划写探索 40 查询 / 60k token / 10 min、低水位 60 s、`maxNodes` 1000。
- **裁决**：取审计裁决：探索 **4 / 20,000 / 240 s**；低水位 **剩余 300 s / debounce 60 s /
  minGap 30 s**；`maxNodes` 向导与 service 上限 **20,000**（默认仍 60）。
- **影响**：advisor 上下文更省；规划更早触发；大规模项目可导入。
- **可逆性**：改常量即可。

### A5. `kernel.strictWrites` 生产默认 `throw`

- **问题**：早期 64 处 legacy 直接写（runtime/gc/reconcile）还没迁到 executor；`throw` 会打断线上 Host。
- **裁决**：所有生产写已迁到 `kernel.executor`（`commit`/`recover`/`deleteProject` 持有 ALS 许可），
  store 的 `save*/appendEvent/deleteProject/deleteEventRecord` 全部 `guardWrite`；默认改为 `throw`。
  **不做** store 写入 → executor 的自动桥（会掩盖迁移债）。
- **影响**：任何绕过 executor 的写都会 `unpermitted_write` 并计数；测试同时覆盖服务成功路径与
  直接删除被拒。
- **可逆性**：配置项。

### A6. `state` 是索引，单节点详情单独取

- **问题**：全量 `state` 在 5k 节点约 80 MB（含 report/prompt）；UI 轮询不能背这个。
- **裁决**：`getState` 用 `slimStateNode`（prompt 400 字符、report 只留 `headline ≤300`、
  删除 `reportText`，附 `promptChars/promptComplete/reportChars/reportAvailable`）；
  选中节点由 `GET /node` 取全量并缓存，保存后刷新。**存储的报告永不截断**（D16）。
- **影响**：4.13 MB / 47 ms @5k；"报告被截断"只发生在索引层，且字段显式。
- **可逆性**：高（返回全量即可）。

### A7. 客户端增量：能合则合，不能合则整取

- **问题**：`changes_since` 的 changed 行只有索引字段，直接合并可能丢字段。
- **裁决**：`applyChangeDelta` 只在「所有 id 都认识」时合并索引字段；未知/新建/溢出
  （`full:true`）一律退回全量 `state`。合并后的节点标 `_delta`，选中时仍走 `/node` 全量。
- **影响**：1.5 s 轮询从 MB 级降到 KB 级；正确性由"回退整取"兜底。
- **可逆性**：高。

### A8. preset 未列出 = 默认拒绝，operator 例外

- **问题**：`PRESET_POLICIES` 没有 `lab-chat`/`lab-merge`/`lab-dashboard`，`allowedActions`
  对未知 preset 回落到全量，导致 `lab-chat` 会话能 `delete_project`（复核 B1）。
- **裁决**：未列出的 **preset** 走 `DEFAULT_PRESET_ACTIONS`（15 个只读 action），actor kind
  记为 `LEGACY`，连 dispatch 授权也拒绝；只有**没有 preset** 的 operator/UI 会话保留全量。
  三个真实 preset 补显式策略（chat 可改 planned、merge/dashboard 只读）。
- **影响**：issue 0001 的默认分支从"全量"变"只读"；新 preset 必须先写策略。
- **可逆性**：高（改常量）。

### A9. 未实现的 action 从枚举移除；实现的 action 三表一致

- **问题**：`intent_*`/`experts_*`/`curator_*` 早期在 schema enum 里但没有 service 分支，调用必
  `unknown_command`（复核 B15/S11）。
- **裁决**：未实现就不广告；`intent_submit/list/withdraw`、`expert_list/recall`、
  `curator_nominate/outcome/reset` 在 `ACTION_ENUM`、`ACTION_CATALOG` 与 handler 三处同时存在，
  `dag_*`/分页/claim 三件套/`health` 同理。旧名 `experts_list`/`expert_upsert`/`curator_scan`
  永久移除。`ACTION_ENUM == ACTION_CATALOG == 有 handler 的集合` 由测试守住。
- **影响**：新增 action 必须三处同步；测试会提醒。
- **可逆性**：高。

### A10. 报告 summary 的源头上限 vs D16「不截断存储报告」

- **问题**：D16 说存储报告永不截断，复核 B26 说报告没有源头上限（summary 无 `maxLength`）。
- **裁决**：上限放在**写入边界**而不是读/索引层——`structured_output` schema 直接拒绝
  超过 500 字符的 summary，prompt 明示；external driver 绕过 schema 时
  `normalizeNodeReport` 在落库前 clamp，并派生 Host-owned `headline ≤300`。
  因此落库后的报告仍是完整的、从不被 UI 二次截断；A6 的索引瘦身只取 headline。
- **影响**：更长的叙述必须进 `changes/metrics/reproduce`，索引字段不再承载长文。
- **可逆性**：中（放宽 schema 即回到旧行为）。

### A11. 测试必须能在缺陷上变红

- **问题**：复核发现 4 个测试在功能坏掉时仍绿（grep `causeId`、`thrown === null`、
  只解析带引号键、actor 硬编码）。测试通过不等于路径可用。
- **裁决**：每个断言必须驱动真实路径（store+kernel+service+工具包装器/runtime）；
  无法自然变红的断言加"变异检查"（对静默接受/错误 code 的假结果必须判负）。
  四个测试均先运行并记录 RED 输出，修复后转绿。
- **可逆性**：高。

### A12. `dag_*` 的硬字节预算

- **问题**：`dag_map` 在 5,000 个 owner 下 372,846 B；`dag_walk` 只有行数上限。
- **裁决**：`dag_map` 默认 6 KB、`dag_walk` 24 KB/200 行；二分前缀保证含截断元数据的
  整个响应不超预算；全部 `dag_*` 带 `revision`；`dag_diff` 用进程内 16 份快照历史兑现
  `sinceRevision`，未知/超前 revision 返回 `diff_unavailable`，不伪造差异。
- **可逆性**：高（常量/参数）。

### A13. HTTP 列表默认分页

- **问题**：`/state` 5,000 节点 4.13 MB；transcript/replay/MCP 列表无界。
- **裁决**：`/state` 默认 1,000 节点/页 + `nextCursor`，客户端 `fetchStateAll` 自动翻页；
  transcript 默认 200 行、replay 2,000/2,000、MCP list_nodes 100 行；内部 `getState`
  仍可显式取全量（scale 测试），但 HTTP 出口必须有界并带 `_truncated`。
- **可逆性**：高。

## 能力行范围裁决（2026-11-10，round 17 修订）

> 目的：把仍未关闭的能力行分成**承诺**、**可延后**、**明确不做**三档，
> 并让 174 行账本每行恰好一个状态。逐行账本见
> [`ACCEPTANCE-LEDGER.md`](ACCEPTANCE-LEDGER.md)；本节只保留 45 个 residual
> 的范围裁决。独立验证者仍以 `VERIFICATION.md` §40 为准；作者侧的
> 119 / 45 / 10 是账本校正，不冒充独立重放。

### 裁决口径

- **必须**：已进入 v2 验收承诺，或不做会直接破坏正确性、安全、可运维性、规模预算；
  未关闭前不能宣称完整发布。
- **应该**：有明确价值，但可以在 v2 后按优先级排期；不阻塞当前验收，也不假装已完成。
- **明确不做**：与已裁决的 D6/D7 或 v2 架构方向冲突，或已被更简单的机制替代；保留在
  清单中作为“已知不做”，不再作为 FAIL 追着补。**明确不做不得引用不存在的替代机制。**

### 剩余具体行（45 行，逐行分类）

| 行 | 分类 | 一句话理由 |
|---|---|---|
| B11 | 明确不做 | D7 已选择“作用域分区 + 升级路由”，不再建 branch/lead/chief 三级和 `BranchReport`。 |
| B12 | 明确不做 | 单点 chief 的“例外仲裁者”模型与 D7 的无固定层级冲突，不设 chief。 |
| B13 | 应该 | 6 个确定性触发码仍值得作为代码判定保留，但它服务的是升级路由，不是发布阻断。 |
| B14 | 明确不做 | 10 分钟否决窗口以 chief 审批闸门为前提；v2 用 dispute/arbiter 处理例外，不建该窗口。 |
| B16 | 明确不做 | D6 已明确拒绝驻留会话 + `submit` 工具，v2 继续一次性激活。 |
| B18 | 应该 | `tag:{hypothesis,variant}` 能降低重复实验，但当前先靠 Q10 的候选对与人工判重，不阻塞发布。 |
| B22 | 必须 | authority 必须在 tool/HTTP/direct 三条路径都执行；作者已补 Host 签名 operator token + 无 token 隐藏按钮，独立探针仍待重放。 |
| Q4 | 应该 | 专家身份/状态/预算/绩效是专家库质量项；现有 lifecycle 已可用，完整化可排后。 |
| Q5 | 必须 | deferred 不能占 `maxNodes`、不能让 auto 误判“有进展”，这是已发生过停机的正确性缺陷。 |
| Q8 | 明确不做 | 固定三级评审被 D7 取消；上下文切片价值转入 Q9/Q14 的地图与预算。 |
| Q9 | 应该 | `dag_map`/`dag_walk`/`dag_diff` 能显著降上下文成本，但不是当前验收的硬前置。 |
| Q10 | 应该 | 重复节点检测有真实收益，但 curator/相似度扫描属于质量优化，不阻塞发布。 |
| Q11 | 应该 | 专职 curator 是质量角色；`lab-gc` 已覆盖确定性生命周期清理，语义清理可后置。 |
| Q12 | 必须 | “agent 只写意图、Host 单写 DAG”是 v2 的并发/安全底座，不能退回多写者。 |
| Q13 | 应该 | B22 的争议结构与 B23 的复盘/轮换已覆盖核心；扩展的争执程序不是发布阻断。 |
| Q14 | 必须 | claim 原子化、确定性验证、截断显式化直接决定专家输出能否被机器校验。 |
| 5.3.2 | 必须 | Q3 已 PASS，但项目内 p0 抢占这一实现行仍未建，不能把 Q3 的 PASS 借给它。 |
| 5.3.4 | 应该 | human:advisor = 100:10 是公平性策略；当前等权不会破坏正确性，但会拖慢人的方向。 |
| 5.3.5 | 应该 | 临时邀请专家是 staffing 便利，现有 hire/drain/retire 已能表达常驻专家。 |
| 5.3.7 | 应该 | 父节点全完成自动 join 能减少 GPU 空洞，但手工 `finish_merge` 仍是安全兜底。 |
| 5.3.8 | 应该 | advisor 180 s 超时确实卡 p90；先由 O1/O2 给出真实分布再调，避免拍脑袋放宽。 |
| 5.3.9 | 应该 | 六条触发与 5.3.13/auto 有重叠；保留为增强规则，不作为本轮验收门槛。 |
| 5.3.10 | 明确不做 | 与 Q8/5.4 同一套三级评审，D7 已取消；不重复实现。 |
| 5.3.11 | 应该 | curator 产物的 TTL 是清理者自身的卫生问题；在 curator 真正启用前不阻塞。 |
| 5.3.12 | 应该 | 轮换阈值 N 需要 owner 决定；B23 已有机制，缺的是策略值，不是发布阻断。 |
| 5.4 | 明确不做 | “分层评审（如需要）”已被 D7 的 scope 分区取代，不再作为待建能力。 |
| 5.4.2 | 应该 | 会话保留/冷存归档是运维策略，按实际存储压力排期，不影响功能验收。 |
| 5.4.6 | 应该 | K 缺陷表是多个独立缺陷的集合，应按 K3/K4 等逐项 triage，不再作为整行 gate。 |
| A11 | 必须 | 失败率/延迟读不出 p50/p90 就无法验收调度与超时，属于可运维性硬需求。 |
| A21 | 必须 | `/metrics` 的 queue/dispatch/byRole 契约是 O1–O7 的统一出口，必须先定。 |
| C1 | 应该 | **未建**：`host/` 没有 `maxDeferred`，也没有 deferred archive；不再引用不存在的替代品，保留为后续能力。 |
| C2 | 明确不做 | 该问题以“存在单一 chief”为前提；v2 不设 chief，前提不成立。 |
| C5 | 必须 | 若语义动作既不能由代码执行、也不能由专家表达，会形成无法升级的死角，必须给 fallback。 |
| C6 | 应该 | “90% 谓词覆盖”没有实测支撑；先允许标 `infer` 且不计证据，不把估计值写成承诺。 |
| C8 | 明确不做 | “建子节点即投票”的计权治理不属于 v2 的 intent/claim 模型，不引入投票配额。 |
| C14 | 明确不做 | 接受一次性停机割接；迁移不是自动能力，release note 必须写清。 |
| O1 | 必须 | cycle p50/p90/max 按 role 是延迟验收的第一指标，必须先可读。 |
| O2 | 必须 | advisor 输入字节/token 是上下文预算的回归护栏，涨了必须能红。 |
| O3 | 必须 | dispatch runnable→claimed 的 p50/p99 是 I15 与 100 ms 目标的唯一证据。 |
| O4 | 必须 | 队列 runnable/deferred/claimed/held 必须进 `state`/`/metrics`，否则 UI 和调度各说各话。 |
| O5 | 必须 | 按 status 的计数必须用 `runnableQueue` 口径，不能把 deferred 算成待执行。 |
| O6 | 应该 | idle/error streak 与 lastPause 已部分可见；完整持久化是运维增强，不阻塞调度正确性。 |
| O12 | 应该 | GPU/成本/叙事结构化是 dashboard 质量项，先把 O1–O5 的硬指标做完。 |
| S5 | 必须 | replay 必须分页/窗口化，10k 事件全量响应会直接突破 1 MB/2 s 预算。 |
| U2 | 必须 | 150 queued 必须显示 showing 100/150，且每一行都要有 `facts.why`；作者已改为单一 queueRows 顺序，独立探针待重放。 |

> 计数：**必须 15 / 应该 20 / 明确不做 10 = 45**。Q3 已 PASS，不再出现在本表；
> B22、U2 是仍未独立关闭的必须行；5.2/5.3/5.3.3 不再用“由 B22/B23 覆盖”代替
> 自己的 verdict，见 [`ACCEPTANCE-LEDGER.md`](ACCEPTANCE-LEDGER.md)。

### 已关闭或已独立 PASS、不再作为剩余范围的行

| 行 | 状态 | 处理 |
|---|---|---|
| B22 | **FAIL（待独立重放）** | tool/direct/HTTP 都 default-deny；本轮补 Host 注入的签名 operator token，合法按钮可真实仲裁，伪造 body 仍拒绝。独立 §40 尚未重放。 |
| U2 | **FAIL（待独立重放）** | 已改为单一 `queueRows` 顺序，position/why/truncation 一致；独立 §40 尚未重放。 |
| U12 | §40 PASS | 五个面板的 loading/error/Retry 已由独立 jsdom 复核。 |
| 5.3.13 | §40 PASS | 60 s cap、starving/pauseReason 已由独立 probe 复核。 |
| 5.2 | PASS（本账本独立 verdict） | 争议表 + 8 类映射 + 超时默认本身已落地；authority 执行问题归 B22，不再把 5.2 合并进 B22。 |
| 5.3 | PASS（本账本独立 verdict） | B23 的 expected/retro/rotation 已独立 PASS；5.3 不再被 B23 的 verdict 吞掉。 |
| 5.3.3 | §38 PASS | `priority/delayed` 已在 31 s 探针通过，不再列入剩余，也不在 45 行中重复计数。 |
| Q3 | §36 PASS | 项目内抢占已 PASS；只从“剩余必须”表移除，不重复计数。 |
| 1.3 / 5.3.2 / U1 / U3 / B23 / 5.3.14 | §38 已结论 | 其中 5.3.2 仍 FAIL（见上表），其余独立 PASS；不因范围表被翻回。 |
| A20 / S12 | 前轮 PASS | dashboard partial 告警与 restart 首读预算已关闭。 |

### 影响

- 账本校正为 **119 PASS / 45 FAIL / 10 N/A**；§40 的 **116/48** 是独立验证者
  起点，尚未按本账本重放，不能把 119/45 写成新的独立结论。
- **必须 15 行**全部关闭前，完整发布仍是 NO-SHIP；**应该 20 行**可以带已知缺口发布，
  但必须在 release note 中列出；**明确不做 10 行**不阻塞发布。
- C1 不再是 won't-do：它没有 `maxDeferred` 或 archive 实现，保留为 should/未建。
- C14 的停机割接边界见 [`RELEASE-NOTES.md`](RELEASE-NOTES.md)。

## 未决（下一轮开工前需要确认）

1. ~~意图日志写入口~~：已定为由 `createProposed` / `setNodePriority` / dispatch envelope
   在同一个 executor commit 内生成 intent，保证 basis 与动作同 revision；工具也可
   `intent_submit` 追加专家判断。
2. **拒绝提案的理由**：`rejectProposal` 仍静默删除；理由进下一轮 advisor 上下文需要改
   快照 schema（`rejectedProposals`）。本轮不做。
3. ~~`experts_list` / `curator_*`~~：Stage 4 已实现 `expert_list` / `expert_recall` /
   `curator_nominate` / `curator_outcome`；`experts_list`/`expert_upsert`/`curator_scan`
   这些旧名仍保持移除。
4. ~~i18n 全量迁移~~：`locale/{en,zh}.json` 已含 1,347 键，且是**唯一源**；客户端字典由
   `npm run locale:sync` 单向生成，`locale-selftest` 在客户端漂移时报红（不回写 JSON）。
5. **5 MB `getState` 预算**来自本轮审计，不是原设计条目；若未来 20,000 节点项目成为常态，
   需要把预算改成"每节点 ≤ 0.9 KB"并按规模线性化。

## 环境事实（避免重复踩坑）

- Node v24.22.2；测试用 `scripts/lib/memory-domain.mjs` 的内存 domain，不碰真实存储。
- DSH storage 表 key 必须匹配 `^[a-zA-Z0-9_-]+$`（节点 key 用 `${projectId}__${nodeId}`）。
- 插件以符号链接安装进 live profile；改动在**下一次 Host 重启**生效；本轮未重启 Host，
  也**没有**写 `~/.dsh/storages/*`（只读）。
- 浏览器绘制未测量：本仓库测试环境无 Playwright/浏览器；`ui-selftest.mjs` 只测 view-model，
  IMPLEMENTATION.md 明确标注 `未测量`，不伪造帧率。
