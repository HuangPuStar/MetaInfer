# v2 发布说明（草稿）

## C14 — 迁移边界（round 27 owner override）

- **C14：按清单改为逐阶段开关，不要求一次性停机割接。** `migrationStatus` 暴露
  `dispatch.strategy` / `expertsMode` / `contest.mode` 三个开关；`advanceMigration`
  一次只允许推进一个 phase，phase 2/3 没有 `parity.ok=true` 时返回
  `parity_required`，不会静默切换。
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

- 本说明只记录 C14 的运维边界；residual 行的分类、状态和 174 行账本见 [`OPEN-QUESTIONS.md`](OPEN-QUESTIONS.md) 与 [`ACCEPTANCE-LEDGER.md`](ACCEPTANCE-LEDGER.md)。**round 27 作者账面为 166 PASS / 0 FAIL / 8 N/A（`VERIFICATION.md` §54）；§53 的 154/10/10 仍是最后一次独立复核。**10 个旧“明确不做”行已按 owner override 实现并有作者探针，但独立重放尚未发生；发布说明不得把 §54 写成独立 PASS。**U2 已独立 PASS；B22 已在 round 21 独立 PASS（§46.7）：48 个 method+path 全量 policy、14 个 token 路由 absent/forged 拒绝、body actor 递归剥离、`/commands` 破坏性 gate 保持。归因观察（非阻断）：部分非破坏性写使用 inline operator actorKey，不改变 token gate 结论，详见 §46.7.5。
- **§53 的三条独立探针**：O3 的 held 15ms、promoted 3ms，`queueWait.count=2`，promotion 的 `plannedAt/runnableAt` 在 store/projection/reload/redo 后一致；B13 的 `AGENT_TOOL_PARAMETERS` 含 `escalate` 和六码 `reasonCode` enum，AJV 拒绝未知值，真实 `tool.execute()` 落 1 行且缺失/非法 reasonCode 被服务拒绝；5.3.9 的 `freeSlots=0, planned=3` 由 helper、evaluator 和生产 observer 都在 +5min 触发 `queue_overload`。别名 `cycle`/`cycles`、`byRole`/`roles`、`advisor`/`advisorInput` 仍是同一对象引用，`advisorInput.utilization` 回退到 `p50Utilization`。
- **Standing exclusions（必须随发布说明携带）**：本环境没有 Playwright/浏览器，**浏览器**的绘制、交互、真实页面未验证；未调用外部模型，**真实 provider** 未验证；未重启 Host 重放 session 身份，**session-id rehydration** 未验证。`b27-restart` 只覆盖现有 restart 断言。
- B22 的 operator 路由 **凭据/破坏性 gate** 已完整；但 §46.7.5 记录的 inline actorKey 归因差异仍应作为后续代码质量项，不能写成“所有写路径都保留 token actorKey”。
