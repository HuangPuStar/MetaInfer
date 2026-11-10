# 独立复核问题的修复记录

> 输入：[`VERIFICATION.md`](VERIFICATION.md)（50 PASS / 114 FAIL / 10 未测量，结论"今天不能上生产"）。
> 本轮只修复核点名的 5 个缺陷并补验收脚本，**不新增功能**。
> 分支 `refactor/v2`，提交 `218fe32`、`5f2ec13`、`317543c`（本文件为文档提交）。

| # | 复核缺陷 | 修复 | 提交 | 回归测试 |
|---|---|---|---|---|
| 1 | **安全 B1**：`PRESET_POLICIES` 缺 `lab-chat`/`lab-merge`/`lab-dashboard`，未列出的 preset 回落到 77 个 action，`lab-chat` 可 `delete_project` | 补三条显式策略；未列出 preset 走 `DEFAULT_PRESET_ACTIONS`（15 个只读），actor kind=`legacy`；只有无 preset 的 operator 保留全量 | `218fe32` | `policy-selftest.mjs`：逐 preset 断言危险 action 被拒；`lab-chat` 的 `delete_project`/`start_node`/`cancel_node`/`auto_stop` 全部 `forbidden_action`；`lab-rogue` 只读；operator 全量 |
| 2 | **半接线 B15/S11**：15 个枚举 action 无 handler（`unknown_command`）；`get_node`/`dashboard_get` 有实现但不在目录 | 11 个补齐：`dag_map/walk/diff`、`nodes_page/events_page`、`claim_review/release_review/review_claims`、`health`；`get_node`/`dashboard_get` 入 `ACTION_CATALOG`；未实现的 `intent_*`/`experts_*`/`curator_*` 从枚举和目录移除 | `218fe32` | `tool-surface-selftest.mjs` 逐个真实调用；`policy-selftest.mjs` 断言枚举≡目录且每个 action 有 handler |
| 3 | **B7 优先级绕过 executor**：`setNodePriority` 直接 `store.saveNode`，对 running/completed 也返回 ok | `setNodePriority` 与 `updateNode` 都走 `kernel.executor.commit`（`node.setPriority`）；planned/proposed 之外返回 `priority_frozen`（含 nextStep），kernel mutation 二次校验 | `218fe32` | `priority-selftest.mjs`：planned 接受且产生一条 executor 事件；running/completed 被拒且节点/事件不变；kernel 直调同样拒绝 |
| 4 | **B26 报告无源头上限**：`summary` 无 `maxLength`，prompt 无限制，运行时不产 `headline` | schema `summary.maxLength=500`；`WORKER_RULES` 明示 500/300 规则；`normalizeNodeReport` 落库前 clamp 并派生 Host-owned `headline ≤300`，列表字段有界 | `5f2ec13` | `trace-selftest.mjs`：900 字符 summary→500、headline→300、空 summary→null、schema/prompt 规则存在 |
| 5 | **U4/U9/O8 原因链不在主路径**：`persistNode` 事件无 `causeId`，UI 无解释入口 | `persistNode` 为每条事件写 `causeId`（start/resume 生成 activation cause，之后沿用）；HTTP `GET /explain`；Inspector 新增 `ExplainPanel`（loading/empty/error/retry） | `5f2ec13` | `trace-selftest.mjs`：事件全带 causeId、链可解析、phase 带 causeId、HTTP/UI 调用路径存在；`observability-selftest.mjs` 继续覆盖 explain API |

## 验收脚本（复核要求"claims 必须由脚本守住"）

| 脚本 | 覆盖 | 接入 |
|---|---|---|
| `scripts/policy-selftest.mjs` | preset 矩阵、默认拒绝、三表一致 | `npm test` |
| `scripts/tool-surface-selftest.mjs` | 11 个曾 `unknown_command` 的 action、移除项不再广告 | `npm test` |
| `scripts/priority-selftest.mjs` | service/kernel/updateNode 三条写路径 | `npm test` |
| `scripts/trace-selftest.mjs` | causeId 端到端、explain 三态、报告上限 | `npm test` |
| `scripts/snapshot-size-selftest.mjs` | 2,000 节点、<12 KB、<50 ms | `npm test` |
| `scripts/i18n-parity.mjs` | 内联 zh/en 键相等、无重复、占位符一致、locale 结构相等 | `npm test` |
| `npm run bench:scale` | 5,000 节点预算（同 `scale-selftest.mjs`） | `package.json` |

## 修复后仍存在的风险（不在本轮范围）

- 64 处 legacy `store.saveNode`/`appendEvent` 仍在（`kernel.strictWrites=warn` 可见）；只有优先级、
  节点创建/转移、dispatch claim 等主路径在 executor 上。
- `getState` 仍返回全部节点索引（5k=4.13 MB）；单节点全量靠 `/node`。
- UI 原因链面板只做静态接线与三态检查，**没有浏览器自动化**；绘制/FPS 仍标记未测量。
- Stage 3–5（意图日志、专家注册表/相似度、curator）未实现，对应 action 已从枚举移除。
- `locale/*.json` 仍只有 meta，UI 文案在 `client.js` 内联表（parity 已守住，迁移未做）。

## 复核结论对照

| 复核项 | 修复前 | 修复后 |
|---|---|---|
| `lab-chat` → `delete_project` | 成功删除项目 | `forbidden_action` |
| 15 个 action | `unknown_command` | 有 handler 或被移除 |
| 优先级改 running/completed | 返回 ok | `priority_frozen`，节点不变 |
| summary 长度 | 无上限 | schema 500 / 落库 clamp / headline 300 |
| 事件 causeId | 运行路径为空 | 每条运行事件带 causeId，UI 可查 |
