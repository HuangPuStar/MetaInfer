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
