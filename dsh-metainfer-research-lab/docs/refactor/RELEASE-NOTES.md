# v2 发布说明（草稿）

## Round 28 — wiring and real-browser close

- **发布：SHIP（带 Host 重启边界）。** §55：**166 PASS / 0 FAIL / 8 N/A**；8 个 owner-override 行
  B11/B14/B16/Q8/5.4/C8/C14/5.3.10 全部经生产入口关闭，5.1.1/5.1.3 随之关闭。
- B11：`orchestrator.step` 真实激活 `lab-branch` → `lab-lead` → `lab-chief`；分支事件键去重，
  L0/L1/L2 预算 2/4/8 queries、60/90/180s 被执行。
- B14：`runCycle` 首行调用 `sweepDueHighReviews`；过窗节点保留为 `unreviewed`。
- B16：agent tool 暴露 `resident_open/call/close`；15 分钟 TTL、全局 cap 8。
- Q8/5.4/5.3.10：branch 输入改为原始子树；大分支 ≥3x，输入 <4KB 的极小分支显式 `smallBranch` 且 ≤20KB。
- C8：vote weight 读 `lab-lead` descriptor budget。
- C14：新增 `project.migration` reducer；`project.update` 改 migration 直接 `migration_gate_required`。
- 真实浏览器：项目菜单在打开 push/cluster 前关闭（实测 menu=0）；replay Escape 关闭；空仪表盘
  有居中空态卡；trajectory 20s 超时 + elapsed/Retry + `limit=50`（`fix-01..06` 截图）。
- **边界**：未重启 Host。`client.js` 修复当前 Host 已加载；trajectory 资产在 Host 注册时缓存，
  本轮用 Playwright route fulfillment 验证，生产需一次 Host 重启才能刷新。未调用真实 provider，
  DSH 子激活仍只返回一次 structured result。

## C14 — 迁移边界（round 27 owner override）

- **C14（round 28 已关闭）：** `advanceMigration` 逐阶段 + parity gate；`project.update` 改
  `config.migration` 现在返回 `migration_gate_required`，只有 `project.migration` reducer 能写。
- 三个 phase 的取值：dispatch `legacy-llm` → `shadow-deterministic` →
  `deterministic`；experts `legacy-cycle` → `hierarchy` → `resident`；contest
  `off` → `shadow` → `consensus`。默认仍停留 phase 1，现有项目不会被静默迁移。
- **仍然没有重启 Host**，所以本轮证据只覆盖配置、开关和 S14 parity gate；不能写成
  “生产零停机迁移已经演练”。2026-11-10 的停机重启是历史事实，不再作为 C14 的验收
  口径。

## Dispute HTTP 路由

- `GET /disputes` 与 `GET /disputes/classes` 是只读；不检查 token，也不铸造 human actor。
- `POST /disputes`、`POST /disputes/resolve`、`POST /disputes/reopen`、`POST /arbitrate` 需要 Host 注入的签名 operator token；无 token 一律 `actor_required`，不会把“缺凭据”当成 operator。
- `POST /disputes/reopen` 还要求 reopener 与 resolver 不同（system timeout 例外）；同一 resolver 不能重开自己的裁决。
- `POST /disputes/sweep` 是 scheduler-only：HTTP 固定返回 `forbidden_action`，不接受客户端 `now`。超时扫描只使用 Host 时间。

## Operator 控制面

- Dispute decisions from the browser use a Host-issued, HMAC-signed operator token injected into the owner page; the token is sent only in the `x-metainfer-operator` header. A JSON body cannot authenticate itself, and a page without the token does not render arbitration buttons.
- The token is valid for one Host lifetime; restart the page after a Host restart.
- All 14 mutating operator routes (including `POST /commands`, `/rotations`, `/retrospective`, `/dashboard*`, and `/preemption/appeal`) require that token; `GET /dashboard` is gated too because it can repair an interrupted chat write. JSON `actor`/`actorKey`/`actorId` fields are stripped, and `deleteProject`/`cancelNode` still run the claim/appeal/human gate after token verification.

## 范围

- 本说明记录 C14 的运维边界；residual 行的分类、状态和 174 行账本见 [`OPEN-QUESTIONS.md`](OPEN-QUESTIONS.md) 与 [`ACCEPTANCE-LEDGER.md`](ACCEPTANCE-LEDGER.md)。**round 28 §55：166 PASS / 0 FAIL / 8 N/A；发布：SHIP（Host 重启边界见上）。** 历史独立复核 §54.6（156/8/10）保留，不擦除。**U2 已独立 PASS；B22 已在 round 21 独立 PASS（§46.7）：48 个 method+path 全量 policy、14 个 token 路由 absent/forged 拒绝、body actor 递归剥离、`/commands` 破坏性 gate 保持。归因观察（非阻断）：部分非破坏性写使用 inline operator actorKey，不改变 token gate 结论，详见 §46.7.5。
- **§54.6 的独立证据**：B11 production step 只跑 scheduler/advisor，无 L0/L1；B14 普通 step 不清过期 pending；B16 resident 无 route/action/orchestrator call site；Q8/5.4 生产 branch 压缩比 0.552；C8 超 descriptor budget 仍计 1 票；C14 `project.update` 可绕过 parity。
- **§53 的三条独立探针**：O3 的 held 15ms、promoted 3ms，`queueWait.count=2`，promotion 的 `plannedAt/runnableAt` 在 store/projection/reload/redo 后一致；B13 的 `AGENT_TOOL_PARAMETERS` 含 `escalate` 和六码 `reasonCode` enum，AJV 拒绝未知值，真实 `tool.execute()` 落 1 行且缺失/非法 reasonCode 被服务拒绝；5.3.9 的 `freeSlots=0, planned=3` 由 helper、evaluator 和生产 observer 都在 +5min 触发 `queue_overload`。别名 `cycle`/`cycles`、`byRole`/`roles`、`advisor`/`advisorInput` 仍是同一对象引用，`advisorInput.utilization` 回退到 `p50Utilization`。
- **Standing exclusions（必须随发布说明携带）**：真实浏览器已可用并完成 35 面板 sweep + 定向修复验证（Chromium 158）；trajectory 新资产仍受 Host 注册时缓存限制。未调用外部模型，**真实 provider** 未验证；未重启 Host 重放 session 身份，**session-id rehydration** 未验证。`b27-restart` 只覆盖现有 restart 断言。
- B22 的 operator 路由 **凭据/破坏性 gate** 已完整；但 §46.7.5 记录的 inline actorKey 归因差异仍应作为后续代码质量项，不能写成“所有写路径都保留 token actorKey”。
