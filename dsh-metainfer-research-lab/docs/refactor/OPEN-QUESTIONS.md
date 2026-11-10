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

### A5. `kernel.strictWrites` 生产默认 `warn`

- **问题**：64 处 legacy 直接写（runtime/gc/reconcile）还没迁到 executor；`throw` 会打断线上 Host。
- **裁决**：默认 `warn`，计数进 `health.writes`，测试用 `throw` 证明 executor 的 ALS 许可覆盖
  `commit` 与 `recover`；**不做** store 写入 → executor 的自动桥（会掩盖迁移债）。
- **影响**：线上可观测、不阻断；迁移完成后把默认改 `throw`。
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

## 未决（下一轮开工前需要确认）

1. **`dag_map` / `dag_walk` / `dag_diff` 的接线顺序**：函数已实现且测试过，但 `agentTool`
   没有分支。是先把三个 action 接上（小、可逆），还是与意图日志/claims 一起接（一次改完
   地图语义）？当前倾向：先接 `dag_map`/`dag_walk`，`dag_diff` 等冷段归档。
2. **意图日志的写入口**：`node.create` 的意图应该由 advisor 工具直接提交，还是由
   `proposeNode` 服务统一生成？前者简单，后者能保证 basis 一致。
3. **拒绝提案的理由**：`rejectProposal` 现在静默删除；理由要进下一轮 advisor 上下文，
   需要改快照 schema（`rejectedProposals` 字段）。是否值得在本轮做？
4. **`experts_list` / `expert_upsert` / `curator_*` 工具名**已在枚举里但没有 service 实现。
   方案 A：实现（Stage 4）；方案 B：从枚举与 persona 移除，等实现再加。倾向 B，避免
   "工具存在但永远报错"。
5. **i18n 全量迁移**：`locale/en.json` / `zh.json` 只有 meta，真正的 UI 文案在 `client.js`
   两张内联表（zh 1299 / en 1291）。新面板已双表加键，但没有 parity 脚本。是否要求
   一次性迁移？工作量在文案，建议单独排练。
6. **5 MB `getState` 预算**来自本轮审计，不是原设计条目；若未来 20,000 节点项目成为常态，
   需要把预算改成"每节点 ≤ 0.9 KB"并按规模线性化。

## 环境事实（避免重复踩坑）

- Node v24.22.2；测试用 `scripts/lib/memory-domain.mjs` 的内存 domain，不碰真实存储。
- DSH storage 表 key 必须匹配 `^[a-zA-Z0-9_-]+$`（节点 key 用 `${projectId}__${nodeId}`）。
- 插件以符号链接安装进 live profile；改动在**下一次 Host 重启**生效；本轮未重启 Host，
  也**没有**写 `~/.dsh/storages/*`（只读）。
- 浏览器绘制未测量：本仓库测试环境无 Playwright/浏览器；`ui-selftest.mjs` 只测 view-model，
  IMPLEMENTATION.md 明确标注 `未测量`，不伪造帧率。
