# v2 发布说明（草稿）

## C14 — 迁移边界

- **C14：接受一次性停机割接是 owner 的决策，不是自动迁移能力。** v2 不会自动迁移 legacy 数据或双环状态；2026-11-10 10:04:28 的割接是 **Host 停机后重启**，不是不停机迁移，也没有 legacy/新双环长期共存承诺。发布说明不得写成“迁移已完成”或“无缝迁移”。

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

- 本说明只记录 C14 的运维边界；44 个 residual 行的分类、状态和 174 行账本见 [`OPEN-QUESTIONS.md`](OPEN-QUESTIONS.md) 与 [`ACCEPTANCE-LEDGER.md`](ACCEPTANCE-LEDGER.md)。U2 已独立 PASS；B22 的 open/reopen/sweep dispute 子面已独立 PASS；作者 round 20 已把全部 14 个 operator 写路由统一 token-gate、剥离 body actor 并去掉 destructive human fallback（§46），但独立重放尚未确认，完整 B22 仍 FAIL。
- 完整发布仍为 **NO-SHIP**，因为 14 个“必须”行（含 B22、5.3.2）尚未全部独立关闭；U2 已 PASS。
- 不能把“dispute 路由清单完整”写成“所有 operator 写路由完整”；作者 round 20 的完整清单与探针见 §46，独立重放见 §45/后续。
