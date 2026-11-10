# 附录 D → WP 映射（5.2.5）

> 本表回答“附录 D 的 21 步落在哪个 WP、当前是否可验证”。它是进度表的补充，
> 不替代 `PROGRESS.md`；状态以 `refactor/v2` 的代码与 `npm test` 为准。
> 生成基线：`2c50c54`（第八轮独立复核）；1.3 的状态按 §26 修正，不再声称 done。
> 步骤编号来自 QA 附录 D（L1965–2009）。

| 附录 D | 内容 | WP / 提交 | 状态 | 验收证据 |
|---|---|---|---|---|
| 1.1 | `report.summary ≤ 500`（schema + prompt） | P6.6 / `5f2ec13`；`host/runtime.js` `REPORT_LIMITS` | done | `trace-selftest`：500 字截断、headline 派生、prompt 写明上限 |
| 1.2 | 截断显式化（`shown/total`） | P4.3 / `f67348f`；`_truncated` | done | `surface-bounds-selftest`、`dag_walk` 字节上限 |
| 1.3 | `running` 补 `elapsed` / `lastActivity` | P4.5-K8（todo），**无 turn 内实现** | **FAIL（未完成）** | `host/runtime.js` `onSessionEvent` 仍只处理 `turn/end`；一次 turn 内的 assistant/tool 活动不会移动 `lastActivityAt`。生命周期写点只覆盖 start/finish/escalate，不能冒充 1.3 |
| 1.4 | 快照瘦身（focus 8 + index） | P1.4-Q6 / `a03b72f` | done | `context-selftest`：500 节点 <12 KB，体积不随 N 增长 |
| 2.1 | `runnable` 唯一口径（排除 deferred） | P2.1 / `8be444c` | done | `runnable-selftest` |
| 2.2 | `dispatchOnce`（无 LLM）+ 派生队列 | P2.2 / `8be444c` | done | `dispatch-once-selftest`；100k/5k bench |
| 2.3 | 低水位预触发 + 去抖 | P2.3 / `0170092` | done | `low-water-selftest` |
| 2.4 | 审查租约（review claim） | P2.4 / `d8565d6` | done | `review-claims-selftest` |
| 3.1 | action 白名单（issue 0001） | P8.1 / `218fe32` | done | `policy-selftest` 5×6 矩阵；`tool-surface-selftest` |
| 3.2 | 优先级四元组 + 提交点 | P8.2 / `218fe32` | done | `priority-selftest`；`node/priority_changed` |
| 3.3 | `dag_map` / `dag_walk` / `dag_diff` | P3 / `218fe32` | done | `tool-surface-selftest` |
| 3.4 | claim + basis + 意图日志 | P3 / `9bdd581` | done | `intent-selftest`；`state-events-selftest` |
| 4.1 | 专家描述符 + 绩效指标 | P4.x / `66d9ffe` | done | `experts-selftest` |
| 4.2 | 相似度召回（纯函数） | P4.x / `66d9ffe` | done | `experts-selftest` |
| 4.3 | curator（只读/只提名）+ 误杀熔断 | P4.x / `66d9ffe` | done | `experts-selftest`；`curator_outcome` |
| 4.4 | 建子节点自动撤回 defer | B20 | done | kernel `node.create` 撤回 pending nomination |
| 4.5 | 专家库 UI（入职/解聘/排空） | — | **partial** | Host API 有 hire/drain/fire；独立专家库面板仍属 5.3.6/UI 能力，未计入本行 |
| 5.1 | claim 谓词化 + 同步校验 | P5.1 / `678981a` | done | `claims-selftest`（7 谓词、C7、B27） |
| 5.2 | `dispute` 表 + 裁决者映射 + 超时默认 | — | **missing** | 无 dispute 表；意图/上诉是当前可执行的替代路径 |
| 5.3 | 预测误差复盘 | — | **missing** | 无预测记录表 |
| 5.4 | 分层评审（如需要） | D7 决策 | **not needed** | D7 明确不做固定三级层级；本行不是实现缺口 |

## 5.2.2 / 5.2.3 的顺序裁决

计划选择 **kernel-first**（P1 是硬前置）。阶段 1 的四步不是全部完成：

- 1.1 → P6.6（report 500/headline 300）**done**
- 1.2 → P4.3（`_truncated`）**done**
- 1.3 → P4.5-K8（todo）只覆盖生命周期写点；**turn 内活动仍无实现**，本表明确标 **FAIL**
- 1.4 → P1.4-Q6（快照预算）**done**

所以 5.2.2 的裁决是“kernel-first，且阶段 1 仍有 1.3 未完成”，不是
“1.1–1.4 已全部落地”。收益验证由 `context-selftest`、`snapshot-size-selftest`
和 `scale-selftest` 覆盖；1.3 的缺口留给后续 WP，不在本轮冒充完成。

## 5.2.4 的裁决

附录 D 5.4“分层评审（如需要）”与 D7“不做固定三级层级”冲突。设计决策是
D7；5.4 标记为 **not needed**，不新建 WP，也不把“没有分层评审”算成实现缺口。
如果未来要恢复层级，必须先改 D7 并补 B11/B12 的证据，不能只加一个 P 编号。
