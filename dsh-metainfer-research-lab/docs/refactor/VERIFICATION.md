# 独立验收报告 — `refactor/v2`

> 验收人：独立验证者（未参与实现）。对象：`docs/refactor/DESIGN-CHECKLIST.md` §1–§9、
> `docs/refactor/IMPLEMENTATION.md`、`refactor/v2` 代码；初始基线 `6beba88`，第八轮
> §25 的独立复核 HEAD 为 `2c50c54`。日期：2026-11-10。

## 0. 结论摘要

| 判定 | 数量 |
|---|---|
| PASS | **107** |
| FAIL | **57** |
| 未测量 | **10**（其中浏览器 2 行 = 不适用） |
| 合计 | **174** |

**行数更正**：任务说明里写“128 行”，但清单实际是 **174 行**：§1 27、§2 14、§3 21、§4 14、
§5 37、§6 14、§7 12、§8 21、§9 14。本报告逐行覆盖全部 174 行，没有抽样。

**一句话**：第十轮独立复核（HEAD `70b32b3`，§28.4）确认 §27 的四个正向探针
已经变绿：撤回后 prune/cancel 被 `appeal_not_resolved` 挡住，调用方提供的
`appealUntil` 被 `appeal_window_caller_supplied` 拒绝，never-appealed 目标没有窗口。
但 **B27 仍未闭**：`intent_submit` 接受 `kind:'appeal'` 搭配非 appeal 的
`claim.action:'observe'`，再由另一 human resolve，就能**制造**一个不存在的
Host 窗口并 prune `ok:true`；此外等待 `INTENT_TTL_MS` 后，withdrawn 的
`appeal_not_resolved` 会被清除且 `hasWindow` 仍为真，prune 成功。因此独立计数
仍是 **107 PASS / 57 FAIL / 10 未测量**：1 个阻断（B27）、56 个能力未建、
0 个只差文档。作者 §28 的 108/56 没有确认。浏览器绘制仍 N/A。

> 本文件 §1–§13 保留**第一轮**（`6beba88`）的 174 行原判（50 PASS / 114 FAIL / 10 未测量）；
> **第二轮**（`750fc31`）见 **§14**；第三轮（`d0364c4`）见 **§15**；作者第三轮修复表见 **§16**；
> **第四轮**（`7d97432`）的独立复核见 **§17**；第四轮修复后的复核见 **§18**；**第五轮**
> （`5ee1376`）见 **§19**；第五轮修复复核见 **§20**；**第六轮**（`ad396b7`）见 **§21**；
> 第七轮修复复核（`53ff695`）见 **§23**；第八轮独立复核（`2c50c54`）见 **§25**；第九轮作者整改见 **§26**（基于 §25，不替代独立复核）；第九轮独立复核（`75963e5`）见 **§27**；第十轮作者整改见 **§28**，第十轮独立复核（`70b32b3`）见 **§28.4**；第十轮 B27 回退人工确认的作者整改见 **§29**（不替代独立复核）。
> 独立总判定以 **§28.4** 为准；§20/§22/§24/§26/§28/§29 是作者报告，不能代替独立复核。§22 曾声称关闭
> B27/C7/U14/S12/A20（87 PASS / 77 FAIL），§23 推翻了其中 B27/U14/S12/A20 四项；
> §24 作者报告为 112 PASS / 52 FAIL，§25 复核为 103 PASS / 61 FAIL，§27 复核为
> **107 PASS / 57 FAIL / 10 未测量**，§28.4 复核仍为 **107 / 57 / 10**。

### 0.1 判定口径

- **PASS**：有可执行证据（测试 + 生产调用方），或代码在运行路径上直接满足该行验收。
- **FAIL**：代码/行为与行文矛盾，或只接了一半（有模块、有枚举名、有 policy 条目，但没有调用方/
  没有 service 分支/没有 UI）。
- **未测量**：该行的验收指标在本环境不可测（浏览器绘制、端到端真实延迟），或该行本身是
  尚未裁决的设计问题（§4 C3/C4/C9/C10/C11、§5 的纯文本冲突）。
- §4 是“开放问题”，PASS 仅表示“已有答案且代码与答案一致”；FAIL 表示“已有答案但未实现”；
  未测量表示“问题仍未决”。§5 是“矛盾/缺口”，PASS 表示“该矛盾/缺口已闭合”，FAIL 表示仍存在。
- 对 §2/§3/§4 这类设计条目，作者在 `IMPLEMENTATION.md` 里标“未完成”的行，本报告同样判 FAIL，
  并在备注里注明“作者已自认”，**不把“承认未做”当成 PASS**。

### 0.2 第一轮实际执行的命令（第九轮命令见 §27.6）

| 命令 | 结果 |
|---|---|
| `npm test` | 17 个 selftest 全绿，EXIT=0（日志 `/tmp/npmtest.log`） |
| `node scripts/context-selftest.mjs` | 11/11 |
| `node scripts/scale-selftest.mjs` | 10/10；`getState` 4.13 MB / 55 ms；快照 3.5 KB / 30.6 ms；dispatch p95 22.3 ms |
| `node scripts/ui-selftest.mjs` | 7/7（只测 view-model） |
| `node scripts/wiring-selftest.mjs` | 7/7 |
| `/tmp/mir-audit/probe2.mjs`（真 service + 真工具） | 逐 preset 调用，见 B1/B2/U10 |
| `/tmp/mir-audit/probe3.mjs` | `running` / `completed` 节点接受 `deferred`，见 B7 |
| `/tmp/mir-mut` 突变测试 | 去掉快照预算 → context 9/11、scale 快照 FAIL（224 ms）；去掉 `slimStateNode` → getState FAIL、scale 8/10 |
| `node scripts/{i18n-parity,policy-selftest,trace-selftest,snapshot-size-selftest}.mjs` | 四个文件均 `Cannot find module` |
| `npm run bench:scale` | `npm error Missing script: "bench:scale"` |

---

## 1. 附录 B 的 27 条决策

| ID | 判定 | 证据（命令 + 关键输出，或 file:line） | 备注 |
|---|---|---|---|
| B1 | FAIL | 工具层对 `lab-worker`/`lab-advisor` 确实返回 `forbidden_action`（wiring 7/7）；但 `ACTION_ENUM` 仍是全局 77 项（`host/agent-tool.js`），`docs/issues/0001-agent-tool-scope-drift.md` 仍“待修”；`PRESET_POLICIES` 没有 `lab-chat`/`lab-merge`/`lab-dashboard`，probe 中 `lab-chat` 调 `delete_project` **越过授权并把项目删掉** | 安全项；见 §0.1 与 §10 |
| B2 | FAIL | `ls host/experts` → No such file；preset 只有 persona/model/tools；没有 8 字段描述符，也没有 GET 出口 | 作者 Stage 3–5 未做 |
| B3 | PASS | 存储域仅 `projects/nodes/runs/cycles/events`（`host/store.js:24-33`），无 queue/ready 表；`runnableQueue` 为纯函数；`runnable-selftest` 11/11 | — |
| B4 | PASS | `comparePriority` 字典序有测试（`scripts/kernel-selftest.mjs:228`）；`node.claim` 为提交点（`host/kernel/mutations.js:209`）；`node/priority_changed` 事件存在（`:206`、`host/lab-service.js:2775`） | 改优先级直接 `saveNode` 绕开 executor，见 B7/§3 3.2 |
| B5 | FAIL | `HUMAN_PRIORITY_CLASS='p0'` 只有声明（`host/kernel/priority.js:18`）；`createProject`/`createSuccessor` 建节点不写 priority，默认 `p2`；p0 只能事后手工改；<1 s 无端到端测量 | IMPLEMENTATION 把“改优先级”当成了 B5 |
| B6 | PASS | `NODE_STATUSES` 6 个且无 `pruned`（`host/kernel/mutations.js:15`）；`deferred` 是 priority class；`runnable-selftest` 覆盖“planned 但永不可运行” | — |
| B7 | FAIL | `setNodePriority`/`node.setPriority` 都不校验状态；probe3：对 `running` 和 `completed` 节点设 `deferred` 均返回 `ok:true` 且落盘 | 违反“只有 planned 可 prune” |
| B8 | PASS | `host/kernel/runnable.js` 单一定义；`auto.js`、`snapshot.js`、`projection.js` 均复用它；runnable 11/11 | 计数侧仍有裸 `status==='planned'`，见 O5 |
| B9 | FAIL | 没有 5×6 权限矩阵测试；`metainfer_lab` 仍向 worker 暴露 `cancel_node`/`start_node` 等控制 action；probe 只覆盖 2 个 preset | — |
| B10 | PASS | `host/dispatch/*` 无模型调用（grep 仅注释）；默认确定性策略 | LLM 策略可插拔只是接口，未实现 |
| B11 | FAIL | 无 `branch`/`lead`/`chief` 三级；无 `BranchReport` | — |
| B12 | FAIL | 无 chief，更无“每项目 1 个” | — |
| B13 | FAIL | 6 个触发码没有代码判定；只有低水位/stall/escalation 近似 | — |
| B14 | FAIL | 无 `pendingHighReview`、10 分钟否决窗口 | — |
| B15 | FAIL | `dag_query`/`dag_get` 可用；`dag_map`/`dag_walk`/`dag_diff` 无 service 分支（probe：`unknown_command`） | 行文要求四个工具都存在 |
| B16 | FAIL | 仍是一次性激活；无驻留会话、无 `submit` 工具、无 compaction 纪律 | 计划 D6 选择相反方向，见 5.1.1 |
| B17 | FAIL | 无相似度召回纯函数，无候选对 | — |
| B18 | FAIL | 节点无 `tags`；无 hypothesis/variant 判重 | — |
| B19 | FAIL | 无 curator；无 `mayExecute: []` 描述符 | — |
| B20 | FAIL | 无 nomination、无 `nomination/withdrawn`、无 10 分钟免疫期 | — |
| B21 | FAIL | `basis` 陈旧判定存在（`host/kernel/executor.js:97-105`）；`intents` 表/意图日志完全不存在 | 作者把 B21 拆成“cause 指针完成 / 意图日志未完成” |
| B22 | FAIL | 无 dispute 表、无 8 类裁决者映射、无超时默认 | — |
| B23 | FAIL | 无 `expected`、无 retro、无轮换 | — |
| B24 | FAIL | 无 7 谓词验证器；无 `citationErrorRate` | — |
| B25 | PASS | `payload.js`/`status.js`/`listRuns` 产出 `_truncated {shown,total}`；context 11/11 断言显式截断 | 三处各有一套，未合并 |
| B26 | FAIL | `NODE_REPORT_SCHEMA.summary` 无 `maxLength`（`host/runtime.js:24-49`）；`host/prompts.js` 无 500 字符规则；运行时也无 `headline` 写入；`headline` 只在 `slimStateNode` 里由 `summary` 现切 | 作者用 D16 替代 B26，但清单没改 |
| B27 | FAIL | 无 5 级验证强度表；只有 dispatch 侧“专家不得取 claim”一个检查（dispatch-once 6/6） | — |

---

## 2. Q1–Q14 结论

| ID | 判定 | 证据（命令 + 关键输出，或 file:line） | 备注 |
|---|---|---|
| Q1 | FAIL | 结论的落点是修 issue 0001；issue 仍“待修”，`ACTION_ENUM` 仍全局 77，`get_node`/`dashboard_get` 被 policy 判 `unknown_action`，另有三类 preset 不受 policy 约束 | 结论未落地 |
| Q2 | FAIL | `dispatchOnce` 快路径已接（`index.js:145/152/164`、`auto.js:257`），但 `auto` 在没启动到节点时仍走完整 cycle（advisor + scheduler 串行）；152 s → <100 ms 只有决策段测试，没有端到端 | 端到端未测 |
| Q3 | FAIL | 四元组有；WIP 上限、`reservedSlots.p0`、抢占、`priority/delayed`、CFS `human=100/advisor=10` 全无；`fairOrder` weight 默认 1 | 缺 5 个机制 |
| Q4 | FAIL | 仍只有 `reviewers[]`；无身份/状态/预算/绩效，无 drain/handover/孤儿归属，无 6 条确定性触发 | 专家库未建 |
| Q5 | FAIL | `deferred` 已排除出 runnable，但 `newNodeCount` 仍是 `nodes.length`（`host/auto.js:11`），deferred 照占 `maxNodes`；无 `maxDeferred`；UI 无“显示/隐藏已砍”开关 | 容量口径未改 |
| Q6 | PASS | 12 KB 预算 + focus 8 + `dag_query`/`dag_get` + ledger + 有界探索（4/20k/240 s）全部有测试；遗留 K8（会话内 lastActivity 不更新） | K8 遗留 |
| Q7 | PASS | `low-water.js` DEFAULTS = 300 s / 60 s / 30 s；review claim 9/9；`dispatchOnce` 已接 tick 与终止回调 | 机制已接 |
| Q8 | FAIL | 无三级评审、无切片、无 6 上报码；多 lens 仍读同一份快照 | 未做 |
| Q9 | FAIL | `dag_query`/`dag_get` + ledger 落地；`dag_map`/`dag_walk`/`dag_diff`、驻留会话、coverage 哨兵均无 | 半套 |
| Q10 | FAIL | 无相似度扫描、无 curator 裁决、无 `redundantOf`/`falseCloseRate` | 未做 |
| Q11 | FAIL | 无 curator；`lab-gc` 是生命周期 GC，不是语义清理；权限仍是君子协定（见 B1） | 未做 |
| Q12 | FAIL | 无 `intents` 表、无冲突矩阵、无 pending/claims 地图字段 | 未做 |
| Q13 | FAIL | 只有 `basis` 判定；无 dispute/默认保持现状/申诉/预测误差/轮换 | 未做 |
| Q14 | FAIL | 截断显式化、ledger 外置有；claim 原子化、`citationErrorRate`、5 级不可逆性、retro 全无 | 半套 |

---

## 3. 附录 D 的 21 步

| ID | 判定 | 证据（命令 + 关键输出，或 file:line） | 备注 |
|---|---|---|
| 1.1 | FAIL | 同 B26：schema 无 `maxLength`、prompt 无长度规则、写入不截断；`MAX_REPORT=700` 也已从 snapshot 删除但没有替代上限 | 源头未约束 |
| 1.2 | PASS | `_truncated {shown,total}` + `full:true`；context 11/11 覆盖预算降级与标记 | 机制完成 |
| 1.3 | FAIL | 快照 running 行有 `elapsedMs`/`lastActivityMs`，但 `onSessionEvent` 仍只处理 `turn/end`（`host/runtime.js:1841`），一次 turn 内的活动看不见（K8） | K8 使指标不成立 |
| 1.4 | PASS | `buildContextPayload` + 12 KB 预算；500 节点 <12 KB，5,000 节点快照 3.5 KB / 30 ms；延迟 129→40 s 未测 | 机制完成 |
| 2.1 | PASS | `runnable` 唯一谓词，auto/snapshot/projection 接入；runnable 11/11 覆盖 deferred 回归 | 已接 |
| 2.2 | PASS | `index.js:121/145/152/164` → `auto.js:257` + 终止回调；dispatch-once 6/6、wiring 7/7、scale 10/10 | 已接 |
| 2.3 | PASS | 5 min / 60 s / 30 s；low-water 8/8；`anyFits` 给出容量原因 | 已接 |
| 2.4 | PASS | `review-claims.js` + orchestrator `claimReview`/`releaseAll`；9/9 | 已接 |
| 3.1 | FAIL | handler 能拒 worker/advisor 的越权；但 issue 0001 未修、schema 未收窄、3 个真实 preset 无 policy、15 个 action 无实现 | handler 有，面没收 |
| 3.2 | FAIL | 四元组 + `set_priority` 有；人类建节点不默认 p0，p0→claim <1 s 未测；改优先级绕过 executor | 半套 |
| 3.3 | FAIL | `dag_map`/`dag_walk`/`dag_diff` 函数存在但零调用方；probe 返回 `unknown_command` | 半套 |
| 3.4 | FAIL | `basis` 有；`intents` 表/意图日志无 | 半套 |
| 4.1 | FAIL | 无 `host/experts/*`；无描述符/绩效 | 未做 |
| 4.2 | FAIL | 无相似度纯函数 | 未做 |
| 4.3 | FAIL | 无 curator、无 `falseCloseRate` | 未做 |
| 4.4 | FAIL | 无 defer 提名，无自动撤回 | 未做 |
| 4.5 | FAIL | 无专家库 UI | 未做 |
| 5.1 | FAIL | 无谓词验证器 | 未做 |
| 5.2 | FAIL | 无 dispute 表 | 未做 |
| 5.3 | FAIL | 无预测误差复盘 | 未做 |
| 5.4 | FAIL | 无分层评审（D7 选择不做，但清单未闭环） | 未做 |

---

## 4. 附录 C 的 14 个开放问题

| ID | 判定 | 证据（命令 + 关键输出，或 file:line） | 备注 |
|---|---|---|
| C1 | FAIL | 归档答案（`deferredTtl`/`archivedAt`/`maxDeferred`）未实现；deferred 仍占 `maxNodes` | 答案未实现 |
| C2 | FAIL | arbiter 不可见、升级配额、升级率监控均无 | 答案未实现 |
| C3 | 未测量 | D6 选择“不做 B16”，代码确实没有驻留会话；但这是与 QA 方向相反的默认答案，没有 owner 裁决，问题本身未闭环 | 答案未闭环 |
| C4 | 未测量 | “什么条件下引入 chief”没有正面回答；D7 只说不做固定三级 | 问题未决 |
| C5 | FAIL | 意图种类未枚举，“代码不能执行、专家无权执行”的空档未回答 | 答案未实现 |
| C6 | FAIL | `infer` 标记与 90% 覆盖未实现，90% 也无实测 | 答案未实现 |
| C7 | FAIL | Wilson 下界、最少证据要求未实现 | 答案未实现 |
| C8 | FAIL | 投票计权/配额未实现 | 答案未实现 |
| C9 | 未测量 | 只有处理方式，没有判重阈值 | 阈值未定 |
| C10 | 未测量 | 令牌桶/全局预算有提案，X 未定 | 参数未定 |
| C11 | 未测量 | K 与最大间隔未定 | 参数未定 |
| C12 | FAIL | `docs/refactor/baseline.json` 不存在；2.83 → 目标值无答案 | 基线缺失 |
| C13 | FAIL | 绩效指标定义与 QA 冲突，且专家库未实现 | 定义冲突 |
| C14 | FAIL | P1 无开关；PROGRESS 记录的割接是 Host 停机重启，不是不停机迁移 | 停机割接 |

---

## 5. 矛盾与缺口（37 行）

| ID | 判定 | 证据（命令 + 关键输出，或 file:line） | 备注 |
|---|---|---|
| 5.1.1 | 未测量 | B16（驻留）vs D6（无状态）仍两说；代码选了无状态，但没有 owner 裁决记录 | 待裁决 |
| 5.1.2 | FAIL | 运行时既无 `summary` 上限也无 `headline`；D16 只出现在 `slimStateNode` 的索引视图与迁移工具 | 两侧都未落地 |
| 5.1.3 | 未测量 | B11（三级）vs D7（分区）仍两说；代码没有层级 | 待裁决 |
| 5.1.4 | PASS | 默认确定性（`dispatch/*` 无 LLM），旧 LLM scheduler 保留为 cycle 路径，符合计划“确定性默认 + 兼容开关” | 按计划落地 |
| 5.1.5 | 未测量 | defer 提名本身不存在，0/1 条证据之争没有落点 | 提名不存在 |
| 5.1.6 | PASS | 代码以 `node.claim` 为提交点、6 状态；QA 文本里的 `starting` 仍未删（文档债） | 代码已定 |
| 5.2.1 | PASS | OPEN-QUESTIONS A2 裁决：决策段 <100 ms、SLO <1 s 分别记录；100 ms 有测试，1 s 无端到端 | 已裁决 |
| 5.2.2 | FAIL | 顺序冲突未解；1.x 仍没有 WP 映射 | 未解 |
| 5.2.3 | FAIL | 1.1/1.3 仍无 WP；1.2/1.4 已做但无回滚安排 | 未解 |
| 5.2.4 | FAIL | 5.4 仍无 WP | 未解 |
| 5.2.5 | FAIL | PROGRESS 仍只有 P 编号，没有“附录 D 步骤 ↔ WP”映射表 | 未解 |
| 5.3.1 | FAIL | 无 `maxPlannedInFlight`；`auto` 没有“超载跳过 advisor pass” | 缺口仍在 |
| 5.3.2 | FAIL | 无 `reservedSlots.p0`，无项目内抢占 | 缺口仍在 |
| 5.3.3 | FAIL | 无 `priority/delayed` 事件 | 缺口仍在 |
| 5.3.4 | FAIL | `fairOrder` weight 默认 1；`usageBySource` 有接口但无 human=100/advisor=10 | 缺口仍在 |
| 5.3.5 | FAIL | 无临时邀请专家 | 缺口仍在 |
| 5.3.6 | FAIL | 无 drain/handover/孤儿归属 | 缺口仍在 |
| 5.3.7 | FAIL | 无自动 join；`finish_merge` 仍要人 | 缺口仍在 |
| 5.3.8 | FAIL | advisor 超时仍 180 s；快照瘦身有，但 22% 失败率未复测 | 缺口仍在 |
| 5.3.9 | FAIL | 6 条触发只有 lowWater/stall 近似，4 条无落点 | 缺口仍在 |
| 5.3.10 | FAIL | Q8 整章无归属 | 缺口仍在 |
| 5.3.11 | FAIL | curator 自身 TTL 无 | 缺口仍在 |
| 5.3.12 | FAIL | 轮换 N 未定，无代码 | 缺口仍在 |
| 5.3.13 | FAIL | 无 observer/长轮询/升级触发 | 缺口仍在 |
| 5.3.14 | FAIL | MCP 有只读面 + create，但没有“观察 + 有限写 + 仲裁” | 缺口仍在 |
| 5.3.15 | PASS | ledger 与有界探索均已落地，原“顺序冲突”已无实际影响 | 已闭合 |
| 5.3.16 | FAIL | 并集 7 工具只落地 `dag_query`/`dag_get`/`trace_explain`；`dag_map`/`dag_walk`/`dag_diff` 无工具面 | 半套 |
| 5.4.1 | PASS | 迁移工具规范化旧事件、插件零 v1 兼容，符合偏差 1 | 已闭合 |
| 5.4.2 | FAIL | P0.9 会话保留/冷存归档未做 | 未做 |
| 5.4.3 | FAIL | P0.2/0.3/0.8/0.9 仍 todo；`baseline.json` 不存在 | 未做 |
| 5.4.4 | FAIL | 计划文件地图行数仍过期（本次未同步） | 未同步 |
| 5.4.5 | FAIL | 无 `kernel/eventlog.js`，无 50k 冷段归档 | 未做 |
| 5.4.6 | FAIL | K3/K4/K8/K17/K18 等仍存在；K6（issue 0001）仍开 | 多数未修 |
| 5.4.7 | FAIL | 提交清单已补 P2.4/P2.5（`docs/refactor/PROGRESS.md:19-25`），但 WP 表 44-48 行仍只有 P2.1–P2.3/P3.6，P2.4/P2.5 无行 | 半补 |
| 5.4.8 | PASS | `low-water.js` 默认已改为 300 s / 60 s / 30 s，与 QA 一致 | 已闭合 |
| 5.4.9 | PASS | prompt 引用的 `dag_query`/`dag_get` 已注册且有 service 分支（probe：真工具返回行）；`dag_map/walk/diff` 仍不可调，但 prompt 不再点名 | 已闭合 |
| 5.4.10 | PASS | `limits.js` 默认 4 查询 / 20k token / 240 s，与 QA 一致 | 已闭合 |

---

## 6. 人机交互（U1–U14）

| ID | 判定 | 证据（命令 + 关键输出，或 file:line） | 备注 |
|---|---|---|
| U1 | FAIL | `HostFactsCard` 只显示 running/queued/failed 计数；节点卡只有倒计时，没有“已跑多久”，也没有 GPU 汇总 | 无 elapsed |
| U2 | FAIL | 卡片只显示第一条 `nextToStart` 的 why；没有按派发顺序的队列视图、class 与全部阻塞原因 | 仅一条 next |
| U3 | FAIL | 失败卡片只显示 error 文本；没有 stage/role/最近 run/timeout 面板；重试/升级按钮存在 | 无归因面板 |
| U4 | FAIL | `explain_node` 只是工具，UI 没有入口；运行路径事件仍不带 `causeId` | 无 UI |
| U5 | PASS | `/commands` auto/start/stop/resume + `ws.auto.*` 面板 + pauseReason 回显 | 已有 |
| U6 | PASS | `cancelNode` + `node/cancelled` + 释放租约 | 已有 |
| U7 | PASS | 节点卡 ↑/↓（`client.js:10710` 附近）+ `node.priority` 命令 + `node/priority_changed` | 已有 |
| U8 | PASS | proposed 节点有 approve/reject 按钮；拒绝理由进上下文未做（作者已自认） | 按钮已有，拒因未落 |
| U9 | FAIL | 无解释节点面板；与 U4 同因 | 无 UI |
| U10 | FAIL | `forbidden_action` 有 nextStep；但 `model_profile_unknown` 仍只回一句、三 preset 可越权、15 个 action 报 `unknown_command` | 半套 |
| U11 | FAIL | zh 1324 / en 1316，仍缺 8 键：`replay.title/short/toggle/play/pause/loading/close`、`dashboard.toggle`；无 parity 脚本 | 缺 8 键 |
| U12 | FAIL | `HostFactsCard` 有 loading/empty/error/retry；队列、专家库、解释面板不存在，三态无从谈起 | 新面板不存在 |
| U13 | FAIL | Host facts 有 HOST 徽标；dashboard widget 仍无来源/脚本全文/过期徽标 | 半套 |
| U14 | FAIL | 后台失败会写 `lastRun.error`，`status==='error'` 时 UI 显示错误条；但没有过期徽标、没有连续失败降级、`partial` 不提示 | 无过期徽标 |

---

## 7. 可观测性（O1–O12）

| ID | 判定 | 证据（命令 + 关键输出，或 file:line） | 备注 |
|---|---|---|
| O1 | FAIL | `summarizeDurations` 只有 count/avg/p95/max/min；无 p50/p90；role 维度同样只有 p95 | 仅 p95 |
| O2 | FAIL | run 记录有 `inputBytes`，`advisorInput` 有 last/max/avgTokens；无 p50/p90，无“100 节点 <12 KB”断言 | 无 p50/p90 |
| O3 | FAIL | `dispatch` 有 count/avg/p95/max/started/skipReasons；没有逐决策记录，没有 p50/p99 | 无逐决策 |
| O4 | FAIL | `queue.depth` 直接数 `status==='planned'`（`host/observability/metrics.js:179`），deferred 只用 `deferUntil` 识别；没有 runnable/claimed/held | 口径错 |
| O5 | FAIL | `counts` 按 status 计数，`planned` 仍含 deferred；没有用 `runnableQueue` | 口径错 |
| O6 | FAIL | `stalls` 有 idleStreak/errorStreak/pauseReason；没有 `lastPauseAt` | 缺 lastPauseAt |
| O7 | PASS | `roleMetrics.failRate` 有；observability 6/6 | 已接 |
| O8 | FAIL | kernel 事件有 `causeId`；`persistNode` 运行路径事件没有，`trace_explain` 只能从 kernel 事件还原 | 运行路径缺 causeId |
| O9 | FAIL | 状态事件存在；没有 6 状态×转换测试，也没有 `node/dispatch_failed` | 无转换测试 |
| O10 | PASS | `trace_explain` + `/events?limit` 且返回 `nextSeq/hasMore` 游标；`dag_diff` 不在工具面（不阻塞本行） | 已接 |
| O11 | PASS | context 断言 500 节点 <12 KB；scale 断言 5,000 节点 <12 KB / <50 ms；突变后两处都会红 | 已接 |
| O12 | FAIL | GPU 利用率、成本、叙事仍只在 LLM dashboard/自由文本；Host 侧只有 tokensUsed/costUsed 汇总 | 未做 |

---

## 8. 验收命令（A1–A21）

| ID | 判定 | 证据（命令 + 关键输出，或 file:line） | 备注 |
|---|---|---|
| A1 | PASS | `npm test` 17 个文件全绿，EXIT=0 | 全绿 |
| A2 | PASS | runnable 11/11；deferred 回归用例在 | 已接 |
| A3 | PASS | dispatch 7/7，含 shadow fallback/backfill/lease 拒绝 | 已接 |
| A4 | PASS | kernel 15/15（幂等/basis/原子/claim/事件不删） | 已接 |
| A5 | PASS | migrate-domain 11/11 | 已接 |
| A6 | PASS | gang-planner 14/14、placement 通过 | 已接 |
| A7 | PASS | `/health` 返回 name/version/domain/storage/projects/writes（`host/lab-service.js:2933`） | 代码证据 |
| A8 | PASS | scale：4.13 MB / 55 ms < 5 MB / 500 ms | 已测 |
| A9 | PASS | `/changes` + `changes_since`；scale 断言 delta | 已接 |
| A10 | PASS | `/events?limit` + `pageEvents`；20k 事件 0.24 ms | 已接 |
| A11 | FAIL | 无 p50/p90；只有 p95 | 缺 p50/p90 |
| A12 | FAIL | `node scripts/i18n-parity.mjs` → Cannot find module | 脚本缺失 |
| A13 | FAIL | `node scripts/policy-selftest.mjs` → Cannot find module；但 handler 拒绝本身可用（wiring） | 脚本缺失 |
| A14 | PASS | dispatch-once：500 节点 8 个启动 <100 ms | 已测 |
| A15 | FAIL | `node scripts/snapshot-size-selftest.mjs` → Cannot find module；等价断言在 context/scale | 脚本缺失 |
| A16 | FAIL | `node scripts/trace-selftest.mjs` → Cannot find module；等价断言在 observability，且运行路径 causeId 缺失 | 脚本缺失 |
| A17 | PASS | 能力存在：`node.priority` + `setNodePriority`；清单写的 `node/set_priority` 不是实际命令名（备注差异） | 命令名不符 |
| A18 | FAIL | `npm run bench:scale` → Missing script | 脚本缺失 |
| A19 | PASS | 向导 `maxNodes` max=20000（`client.js:7140`） | 代码证据 |
| A20 | FAIL | 无过期徽标/顶部告警；只有 `lastRun.status==='error'` 的错误条 | 未做 |
| A21 | FAIL | `/metrics` 存在，但缺 p50/p90、queue 的 runnable/claimed/held、dispatch p50/p99 | 部分 |

---

## 9. 规模与卡顿（S1–S14）

| ID | 判定 | 证据（命令 + 关键输出，或 file:line） | 备注 |
|---|---|---|
| S1 | PASS | listNodes 单页 0.15 ms，5,000 节点全量 0.4 ms（scale） | 已测 |
| S2 | PASS | 20k 事件页 100 条 0.24 ms，O(page) | 已测 |
| S3 | PASS | 5k runs 页 50 条 0.52 ms | 已测 |
| S4 | PASS | `slimStateNode` + `_indexed`；4.13 MB / 55 ms；`getNode` 仍可取全量 prompt | 已测 |
| S5 | FAIL | `getReplay` 仍是 getState + 全部事件，无分页；`Math.min(...arr)` 展开仍在 | 未做 |
| S6 | PASS | 500 节点 <12 KB，5,000 节点 3.5 KB / 30.6 ms；突变测试 224 ms 会红 | 已测 |
| S7 | PASS | `fairOrder(limit)` O(n×limit)；dispatch 5,000 节点 p95 22.3 ms / max 30.9 ms | 已测 |
| S8 | 未测量 | viewport 只渲染 49/5000、边裁剪有测试；无浏览器，首屏 1 s 与“按分支聚合”都未验证（聚合也没实现） | 无绘制测量 |
| S9 | 未测量 | `applyChangeDelta` 合并/拒收有测试；16 ms 交互与绘制不可测 | 无绘制测量 |
| S10 | PASS | `changesSince` + `/changes`；delta 0.16 ms | 已接 |
| S11 | FAIL | `/state` 无 limit/cursor；`/transcript`、`/replay` 无 limit；MCP `metainfer_list_nodes` 仍全量；`nodes_page`/`events_page` 无 service 分支 | 未做 |
| S12 | FAIL | 20k 事件可接受；100k 未测，无冷段归档，`eventlog.js` 不存在 | 未做 |
| S13 | FAIL | `scale-selftest` 在 `npm test` 里，但 `bench:scale` 不存在，UI 绘制不在 CI；“全部预算进 CI”不成立 | 无 bench |
| S14 | PASS | `updateProject` 1..20000；向导 max 20000；无单测（手工核对） | 代码证据 |

---

## 10. 不能证明的部分

1. **UI 首屏 ≤1 s、交互 ≤16 ms、60 fps**：无浏览器/Playwright；`ui-selftest` 只测 view-model（作者也在 `IMPLEMENTATION.md:116` 承认）。
2. **端到端启动延迟 152 s → <100 ms**：`dispatch-once` 只测“选择 + claim + launch 调用”，不含 worktree/anchor/worker bootstrap（OPEN-QUESTIONS A2 自认）。
3. **p0 从提交到 claim <1 s**：没有端到端计时；且人类建节点默认不是 p0。
4. **advisor 延迟 129 s → 40 s**：没有任何真实 provider 计时记录。
5. **真实 advisor 输入 p50 46 KB → 8–12 KB**：只有合成 DAG 的字节断言，没有真实 run 的 `inputBytes` 分布。
6. **严格写守卫的生产覆盖**：作者说 64 处 legacy 直写，我静态枚举到 **70 处**（方法：`host/**/*.js` 中 `store.saveNode|saveProject|saveRun|saveCycle|appendEvent|deleteEventRecord|deleteProject`，排除 `store.js` 与 `kernel/executor.js`；分布 auto 2、gc 5、lab-service 34、orchestrator 20、reconcile 6、runtime 3）；这个数字没有测试断言，且 `strictWrites` 默认 `warn` 只记日志、不阻断。
7. **§4 C5–C11 的阈值/边界**：C9/C10/C11 明确未定；C5/C6/C7 的答案依赖未落地的意图/验证器。
8. **§5 的纯文本冲突**（5.1.1/5.1.3/5.1.5）：需要 owner 裁决，代码无法证明。
9. **真实 Host 进程下的权限逃逸面**：probe 用内存 store + 假 ctx；`lab-chat` 越权删除已复现，但其它入口（HTTP `/commands`、MCP）未做渗透测试。
10. **5,000 节点可达性**：只有配置层上限（20000）与内存测试，没有真实向导/项目跑到 5,000 的演练。

---

## 11. 与 `IMPLEMENTATION.md` 判定不同的行

`IMPLEMENTATION.md` 标「完成」、本报告判 FAIL 的共 **19 行**：

| ID | IMPLEMENTATION 说 | 本报告 | 原因 |
|---|---|---|---|
| B1 | 每 preset 白名单完成 | FAIL | 3 个真实 preset 不受 policy 约束；`lab-chat` 可删项目；enum 仍全局；issue 0001 未修 |
| B5 | 人类 p0 快路完成 | FAIL | 只做了“改优先级”，没做“人类建节点默认 p0”；<1 s 未测 |
| B26 | 存储报告不截断 + headline 完成 | FAIL | 清单要求 `summary` 源头 ≤500；schema/prompt/写入都没有；headline 只在索引视图 |
| O1 | p50/p95/max 按 role 完成 | FAIL | 代码只有 p95，无 p50/p90 |
| O2 | advisor 输入字节/token/占比完成 | FAIL | 无 p50/p90，无 100 节点 <12 KB 断言 |
| O3 | dispatch 延迟完成 | FAIL | 无逐决策记录、无 p99 |
| O4 | 队列深度完成 | FAIL | 用裸 `planned` 计数，deferred 只认 `deferUntil`，没有 claimed/held |
| O5 | 状态计数完成 | FAIL | `planned` 未走 `runnableQueue`，把 deferred 算成待执行 |
| O6 | 停摆计数完成 | FAIL | 缺 `lastPauseAt` |
| O8 | cause 链完成 | FAIL | 运行路径 `persistNode` 事件不带 `causeId`，只能追 kernel 事件 |
| O9 | 每个状态转换都有结构化事件 | FAIL | 无转换矩阵测试，无 `node/dispatch_failed` |
| O10 | 查询面完成（含 nodes_page/events_page） | FAIL | 两个 action 没有 service 分支，返回 `unknown_command` |
| U1 | 现在在跑什么完成 | FAIL | 只有计数/倒计时，没有每个 running 节点的已跑时长与 GPU 汇总 |
| U2 | 下一个启动 + 为什么完成 | FAIL | 只有一条 next，没有队列视图/class/全部阻塞原因 |
| U3 | 失败原因完成 | FAIL | 没有 stage/role/run/timeout 面板 |
| U4 | 原因链一键追到激活完成 | FAIL | 只有工具，没有 UI 入口 |
| U9 | 解释节点完成 | FAIL | 同 U4 |
| U10 | 错误可执行完成 | FAIL | `model_profile_unknown` 仍不可操作；三 preset 可越权；15 个 action 报 unknown_command |
| S11 | state/events/runs/nodes 分页完成 | FAIL | `/state` 无 limit/cursor；`nodes_page` 未实现；MCP/transcript/replay 仍无界 |

另有大量作者已自认“未完成”的条目（Stage 3–5、意图日志、归档、i18n、dashboard 过期、UI 绘制、
`dag_map/walk/diff` 等），本报告同样判 FAIL —— 这不是判定冲突，而是“未做”本身就不满足清单。

---

## 12. 五个最严重的 FAIL

1. **B1 / Q1 / 3.1 — 权限面有真实越权路径。** `PRESET_POLICIES` 漏了 `lab-chat`/`lab-merge`/`lab-dashboard`；probe 里 `lab-chat` 调 `delete_project` 直接删掉项目。`ACTION_ENUM` 仍全局 77 项，issue 0001 仍“待修”。
2. **B15 / 3.3 / S11 — 工具面半接线。** `dag_map`/`dag_walk`/`dag_diff`、`nodes_page`/`events_page`、`intent_*`、`review_*`、`experts_*`、`curator_*` 共 15 个 action 返回 `unknown_command`；`get_node`/`dashboard_get` 有实现却被 policy 判 `unknown_action`。模型看到枚举名却调不通。
3. **B7 / 3.2 — 优先级写路径破坏提交点。** `running`/`completed` 节点可以被设成 `deferred`（probe3 两次 `ok:true`）；`setNodePriority` 直接 `store.saveNode`，不经 executor，`strictWrites=warn` 只记录不阻断。
4. **B26 / 1.1 — 报告体积没有源头约束。** `summary` 无 `maxLength`、prompt 无 500 字符规则、运行时无 `headline`；5 MB 预算只靠 `slimStateNode` 的索引视图达标，存储本身仍无界增长。
5. **U4 / U9 / O8 — 原因链不可用。** 运行路径事件不带 `causeId`，UI 没有解释节点/原因链入口；人仍然只能读事件与日志来回答“为什么建/为什么停”。

---

## 13. 上生产结论（第一轮，已被 §14 取代）

**否。** 第一轮时权限面存在可复现的越权删除，且工具面/可观测性/Stage 3–5 大量半接线。
第二轮已关闭越权，但仍不满足上生产条件；最新结论见 §14.5。


---

## 14. 第二轮复核（HEAD `750fc31`，4 个新提交）

> 复核对象：`218fe32`、`5f2ec13`、`317543c`、`750fc31`。工作树干净。
> 方法同第一轮：先跑测试，再用真实 service + 真工具包装器探针；测试通过但生产路径不成立的，
> 仍判 FAIL。第一轮表保留原判，本节给出变更与最新总数。

### 14.1 最新总数与 delta

| 判定 | 第一轮 | 第二轮 | 变化 |
|---|---|---|---|
| PASS | 50 | **63** | +13 |
| FAIL | 114 | **101** | −13 |
| 未测量 | 10 | **10** | 0 |
| 合计 | 174 | **174** | — |

**FAIL → PASS（13 行）**：`B1`、`B7`、`B26`、`U4`、`U9`、`U11`、`1.1`、`3.1`、`3.3`、
`A12`、`A13`、`A15`、`A18`。

**仍 FAIL 的上一轮点名行（4 行）**：`B15`、`O8`、`S11`、`A16`。其中 `B15` 与 `A16` 是
**“工具/脚本已存在，但契约没守住”**；`O8` 是**数据仍有洞**；`S11` 未改动。

**PASS 回归**：`npm test` 23 个 selftest 全绿（EXIT=0，298 个 `ok`）；`npm run bench:scale`
EXIT=0（10/10）；context 11/11、wiring 7/7、ui 7/7、observability 6/6、scale 10/10 均未回退。

### 14.2 行级变更（只列变更行）

| ID | 第一轮 | 第二轮 | 证据（命令 + 关键输出，或 file:line） | 备注 |
|---|---|---|---|---|
| B1 | FAIL | **PASS** | `probe5`：`lab-chat`/`lab-rogue`/`lab-worker`/`lab-merge`/`lab-dashboard` 调 `delete_project` 均 `forbidden_action` 且 `store.getProject('p')` 仍存在；`probe6`：`lab-worker`/`lab-advisor` 的 `cancel_node`/`auto_stop` 也 `forbidden_action`；`policy-selftest` 78/78 | 越权面已关；`ACTION_ENUM` 仍全局 71（OPEN-QUESTIONS A1 判为 schema 不可收窄），issue 0001 仍写“待修”（文档债） |
| B7 | FAIL | **PASS** | `probe4`：running/completed `priority_frozen`、`eventsAdded:0`、class 仍 p2；planned 接受且产生 1 条 `node/priority_changed`；`updateNode` running 抛 `priority_frozen` 且未改名；kernel 直调 `node.setPriority` 同样拒绝；`priority-selftest` 17/17 | 服务层 + kernel 双重校验，提交点恢复 |
| B26 | FAIL | **PASS** | `probe4`：schema `summary.maxLength=500`；900 字符 summary→500、headline→300、空 summary→null；`runtime.js:899/1861` 两处落库前 `normalizeNodeReport`；`prompts.js:31-33` 写明 500/300 | 源头上限与 Host 派生 headline 均落地；`reportText` 仍 8k 上限（非本行） |
| U4 | FAIL | **PASS** | `client.js:10858` `ExplainPanel` + `fetchExplain` + `ROUTES.explain`；`http.js:142` `GET /explain`；`trace-selftest` 21/21（三态/重试静态断言） | 有 UI 入口；无浏览器，绘制未测 |
| U9 | FAIL | **PASS** | 同 U4；Inspector 挂载 `h(ExplainPanel, …)`（`client.js:11478`） | 同上 |
| U11 | FAIL | **PASS** | `i18n-parity` 11/11；`client.js` zh/en 各 1342 条词条（4 组重复，去重 1338），8 个 replay/dashboard 键已补 | 见 14.4：字典仍有 4 组同名键（`panel/title/subtitle/badge`），新加的带引号键被后面未加引号的旧键覆盖；脚本只查带引号键 |
| 1.1 | FAIL | **PASS** | 同 B26；`NODE_REPORT_SCHEMA` + `WORKER_RULES` + `normalizeNodeReport` 三处都在 | 全库聚合 1.3 MB→200 KB 未实测 |
| 3.1 | FAIL | **PASS** | `probe5/6` 越权全部 `forbidden_action`；`policy-selftest` 断言每个 preset 的拒绝矩阵；`agent-tool.js` 已调用 `authorizeAction` | 越权调用可执行性已达标；issue 0001 状态仍未改 |
| 3.3 | FAIL | **PASS** | `probe4`：`dag_map`/`dag_walk`/`dag_diff` 均走到 handler（`dag_walk` 缺参时是 `bad_request`，不是 `unknown_command`）；`tool-surface` 25/25 | 工具面已开；B15 的 revision/字节上限契约仍 FAIL（见 14.3） |
| A12 | FAIL | **PASS** | `node scripts/i18n-parity.mjs` → 11/11，EXIT=0；已接入 `npm test` | 脚本会漏掉未加引号的重复键（14.4） |
| A13 | FAIL | **PASS** | `node scripts/policy-selftest.mjs` → 78/78，EXIT=0；已接入 `npm test`；真工具探针交叉验证 | 断言是真实的 `authorizeAction`，不是文本 grep |
| A15 | FAIL | **PASS** | `node scripts/snapshot-size-selftest.mjs` → 11/11；2,000 节点 6,256 B / 2.8–6.2 ms | 脚本用 2,000 而非 5,000；5,000 的同一预算仍由 scale 10/10 覆盖 |
| A18 | FAIL | **PASS** | `npm run bench:scale` → EXIT=0，10/10；`package.json` 已加脚本，指向 `scale-selftest.mjs` | 是 5,000 节点预算的真执行；不是独立基准工具 |

### 14.3 五个严重项：哪些真关了，哪些只是“有名字”

| 严重项 | 结论 | 依据 |
|---|---|---|
| **B1 权限越权** | **真关闭（安全面）** | `lab-chat`/未列出 preset/worker/advisor 的删除、启动、取消、auto_stop 全部 `forbidden_action`，项目仍在；3 个真实 preset 已有显式策略。遗留：全局 enum（A1）、issue 文档未改 |
| **B15 工具面** | **只关了“可调用”，契约仍 FAIL** | 71 个 enum 全部有 handler，0 个 `unknown_command`；但 `dag_map` 在 5,000 个不同 owner 下输出 **372,846 B**（要求 ≤6 KB）；`dag_walk` 默认 `limit=100`，没有 `maxRows=200 / maxBytes=24000`；`dag_map/walk/diff/get/query` 返回值都没有 `revision`（`probe7`）；`dag_diff` 收 `sinceRevision` 但完全不用 |
| **B7 优先级写路径** | **真关闭** | running/completed 拒绝、0 事件、kernel 二次拒绝；planned 恰好 1 条 executor 事件 |
| **B26 报告体积** | **真关闭（源头上限）** | schema 500 + 落库 clamp + headline 300；两处 report 写入都过 `normalizeNodeReport` |
| **U4/U9/O8 原因链** | **UI 关了，数据没全关** | ExplainPanel/`/explain` 存在；但 `persistNode` 只在 start/resume/retry 生成 cause，planned 节点 `runtime.cancel()` 的事件 **`causeId:null`**（`probe4`），`explain_node` 对该节点 `causeChain:0`。merge 准备等非激活事件同样可能为空 |

### 14.4 修复引入的新半接线 / 测试盲点

1. **`dag_map` 无字节上限**：`host/context/dag.js:220` 按 owner 分组时不截断；5,000 个 owner → **372,846 B**，远超 B15 的 6 KB，也足以打爆 12 KB 上下文。
2. **`dag_walk` 上限不符**：`walkDag` 默认 `limit=100`、无 `maxBytes`；B15 要求 200 行 / 24,000 B。
3. **`dag_*` 无 `revision`**：`probe7` 对 `dag_map/walk/diff/get/query` 的返回均无 `revision` 字段；B15 明确要求“返回值带 revision”。
4. **`dag_diff` 的 `sinceRevision` 是摆设**：`host/lab-service.js:2735-2745` 把 `since` 解析出来后没有传给 `diffCache.diff`；`host/context/dag.js:347` 的 `diff()` 也没有 since 参数。冷启动返回全量 `added`，之后只和进程内上一份缓存比。
5. **`trace-selftest` 的“live path”是静态正则**：`scripts/trace-selftest.mjs:78-80` 只 grep `runtime.js` 文本；真实的 planned cancel 事件没有 causeId，脚本仍全绿。`A16` 因此判 FAIL，而不是 PASS。
6. **`tool-surface-selftest` 的“移除项不被静默接受”是空断言**：`scripts/tool-surface-selftest.mjs:90` 写的是 `thrown === null || thrown.code === 'unknown_command'`；如果 action 被静默接受（`thrown===null`），这条也通过。实际服务确实抛 `unknown_command`，但测试本身守不住回归。
7. **`i18n-parity` 的“无重复键”只查带引号的键**：`parseDict` 正则 `^\s+'([^']+)':` 忽略 `panel:`/`title:` 这类未加引号键；实际 zh/en 各有 4 组重复（`panel/title/subtitle/badge`），新加的 `'panel': 'MetaInfer Research Lab'` 被后面的 `panel: '科研实验台'` 覆盖。8 个缺失键本身已补齐。
8. **优先级事件 actor 被硬编码为 human**：`host/lab-service.js:2830` 的 `setNodePriority` 固定 `{kind:'human', id:'operator'}`；`lab-chat` 调 `set_priority` 时事件也记成人类，审计上无法区分专家干预。
9. **allowed 列表重复**：`READ` 与 `DAG` 有交集，`lab-chat` 的 `forbidden_action.allowed` 出现 `dag_diff/dag_get/dag_map/dag_query/dag_walk` 各两次；不影响权限，但属于新代码的脏输出。

### 14.5 第二轮上生产结论

**否。** 越权、优先级、报告上限已真关闭；但 `B15` 的 `dag_map` 372 KB / 无 revision、`O8` 的 planned
cancel 无 causeId、`S11` 的 `/state` 等出口仍无界，且 101 行仍 FAIL；只能继续作为 `refactor/v2`
的开发分支。

---

## 15. 第三轮复核（HEAD `d0364c4`，4 个新提交）

> 复核对象：`f67348f`、`c293a92`、`4431441`、`d0364c4`。工作树在复核前干净。
> 方法仍是“先跑测试，再用真实 service/Host 路径探针”；对四个“先红后绿”的声明，另在
> `/tmp/r3-*` 的 HEAD 副本里**手动重植缺陷**，确认强化后的测试确实会红。

### 15.1 最新总数与 delta

| 判定 | 第二轮 | 第三轮 | 变化 |
|---|---|---|---|
| PASS | 63 | **64** | +1 |
| FAIL | 101 | **100** | −1 |
| 未测量 | 10 | **10** | 0 |
| 合计 | 174 | **174** | — |

**FAIL → PASS（1 行）**：`A16`。**仍 FAIL 的上一轮点名行**：`B15`、`O8`、`S11`。
`A16` 的窄验收（真实 runtime planned cancel + `trace_explain` 相位）已过；但 `O8` 的
GC/reconcile/merge 直写仍解释为空，二者不矛盾。

**回归**：`npm test` 24 个 selftest 全绿（EXIT=0，344 个 `ok`）；`npm run bench:scale`
EXIT=0（10/10）；auth/priority/report 三个旧 PASS 行仍成立。**新回归**：`replay` 的
服务端默认 2,000 节点/事件，客户端仍只请求一次、不跟 `nextNodeCursor`，5,001 节点的回放
从“全量”退化为“前 2,000”；这是 S11 修复引入的回归，见 15.5。

### 15.2 行级变更

| ID | 第二轮 | 第三轮 | 证据 | 备注 |
|---|---|---|---|---|
| A16 | FAIL | **PASS** | `scripts/trace-selftest.mjs` 改用 `createKernel` + 真实 `runtime.cancel()`；planned cancel 现在 `causeId=node/cancelled:cancel:a1`，`explain_node` chain=1；`trace_explain` 的 start/outcome 相位与 causeId 均有断言。RED 复现见 15.2.1 | 只覆盖计划取消与显式 cause 的正常路径；GC/reconcile 直写的缺口归 O8 |
| B15 | FAIL | **FAIL** | 5,000 个不同 owner、变长 key 的真实 `dag_map` 响应 **6,150 B > 6,144 B**，`_truncated.bytes.used` 只写 6,117；`dag_walk` 的 `bytes.used` 也比最终响应小 38 B（24,386 vs 24,424）；直接 `walkDag` 的 5,000 子节点形状得到 24,585 B > 24,576 | 作者测试只覆盖一种固定形状；见 15.3 |
| O8 | FAIL | **FAIL** | HTTP `/explain`：planned cancel chain=1；但真实 `reconcileRunningNodes` 的 legacy running 节点 event cause=`reconcile:legacy`，`node.causeId/lastCauseId` 均为 null，`causeChain=0`；直接 merge/GC 事件同样 chain=0 | store fallback 只给事件补 cause，不建立 node→cause 指针；见 15.4 |
| S11 | FAIL | **FAIL** | `/state` 5,001 节点分 6 页、无丢节点；`/transcript` 500 行分 11 页；但 `/replay` 默认只回 2,000/5,001 节点和 2,000/5,000 事件，`client.js:3683` 仍只调一次、`client.js:9274` 不跟 `nextNodeCursor`；`/events` 无 limit 时仍返回全部 5,000 | 服务端多数已分页；客户端 replay 和 `/events` 默认值仍未关；见 15.5 |

#### 15.2.1 四个“先红后绿”证据（独立重植）

在 `/tmp/r3-{trace,tool,i18n,priority}`（HEAD `d0364c4` 的 git archive 副本，node_modules 软链）中，
基线均 EXIT=0；然后各重植一个缺陷：

| 测试 | 重植的缺陷 | RED 输出 | 结论 |
|---|---|---|---|
| `trace-selftest` | `host/runtime.js` 的 `causeId` 去掉 `actionCause` 回退（恢复“非激活事件无 cause”） | EXIT=1；`FAIL planned cancel is explainable — []` | 真会红；不是静态 grep |
| `tool-surface-selftest` | `authorizeAction` 的 `unknown_action` 改成 `unknown_command` | EXIT=1；6 个 removed action 全部 `FAIL ... unknown_action — {"ok":false,"code":"unknown_command"}` | 真会红；精确 code 被守住 |
| `i18n-parity` | 在 zh 词典插入重复的 `'panel': '重复'` | EXIT=1；`FAIL client dictionaries have no duplicate keys (zh) — panel` | 真会红；现在解析未加引号键并比较 resolved map |
| `priority-selftest` | `setNodePriority` 把 `commitActor` 硬编码回 `{kind:'human',id:'operator'}` | EXIT=1；`FAIL priority event is attributed to the calling session — {"kind":"human","id":"operator"}`，kind 行也红 | 真会红；actor 归属被守住 |

四个测试的基线在副本里均为绿，重植后均为红；因此“RED evidence”不是作者的口头声明。

### 15.3 B15：预算与元数据仍不成立

1. `dag_map`：真实工具包装器、5,000 个不同 `createdBy`、变长 key（`'o'.repeat(1 + ((i*7+19*13)%120)) + i`）：
   **6,150 B**，超 `6*1024=6,144`；`_truncated.groups={shown:83,total:5000}` 正确，但
   `_truncated.bytes.used=6,117`，不是最终序列化字节。原因是 `mapDag` 在加 `projectId`/`revision`
   之前计算 `used`、也只按内部 envelope 裁剪。
2. `dag_walk`：5,000 个子节点、长 id/title 的形状下，服务响应 24,424 B（本次未超），但
   `truncated.bytes.used=24,386`，比最终响应小 38 B；直接调用 `walkDag` 的同一类形状可到
   **24,585 B > 24,576**。`truncated.total` 写的是 200（`discovered` 上限），不是真实可达总数
   5,000；`shown=57,total=200,discovered=200,reason='bytes'` 的“total”会误导。
3. 作者 `tool-surface-selftest` 的预算用例固定为 `owner-${i}`、`title:'x'.repeat(300)`，通过；
   换一种合法 owner 长度分布就红。测试没有覆盖 envelope 加上 `projectId`/`revision` 的最终字节。
4. `dag_map/walk/diff/get/query` 现在都带 `revision`（`probe2`：diff revision=4；`probe1`：
   map/walk revision=123），这点已修。
5. `dag_diff` 的真 `sinceRevision` 对**精确快照**有效：第一次 diff→R1，新增节点后
   `since=R1` 只回 `n2`；`since=999`（ahead）→`diff_unavailable`。但 `since=3` 而历史只有
   R1/R2 时，代码退到 R2 并把 `fromRevision=2` 返回，同时 `sinceRevision=3`；这不是
   `diff_unavailable`，调用方会收到一个“从 2 开始”的 delta 却以为从 3 开始（多报，不会少报）。
   `DIFF_HISTORY=16` 的缓存没有 dedupe/reset；32 个项目 × 16 份全量 byId 快照，5,000 节点时
   是数十万到百万级对象的常驻内存，且 `reset` 没有调用方。

### 15.4 O8：只有 planned cancel 的链真正闭合

HTTP `/explain` 实测（`probe6`）：

| 路径 | event.causeId | node.causeId/lastCauseId | causeChain |
|---|---|---|---|
| planned cancel（真实 `runtime.cancel`） | `node/cancelled:cancel:a1` | 有 | **1** |
| legacy running → `reconcileRunningNodes` | `reconcile:legacy` | **null / null** | **0** |
| 直接 `node/merge_prepared`（无 node cause） | `node/merge_prepared:p:2` | **null / null** | **0** |
| 直接 `gc/finished`（无 node cause） | `gc/finished:p:3` | **null / null** | **0** |

`host/store.js` 的 fallback 只保证**事件行**有 `causeId`，它不知道 node 的 cause 指针；
`explain.js` 仍从 `node.causeId ?? node.lastCauseId` 起走，故直写事件无法被解释。作者的
`trace-selftest` 对 GC/merge 只断言 `event.causeId`（见 `trace-selftest.mjs` 的
`gc event has a causeId` / `merge prep event has a causeId`），没有断言 `explain_node` 的
chain，所以测试绿而 O8 仍红。real reconcile 是最有力的反例：它是 Host 启动路径，不是人造调用。

### 15.5 S11：服务端多数已分页，客户端 replay 仍丢节点

`probe7`（5,001 节点、5,000 事件、500 transcript 行）：

| 面 | 结果 | 判定 |
|---|---|---|
| `/state` 默认 | 6 页，unique=5,001，last `nextCursor=null`，edges=4,999 | **bounded，客户端 `fetchStateAll` 会跟页** |
| `/transcript?limit=50` | 11 页（含最后空页），unique=500 | **bounded，cursor 可续** |
| `/replay` 默认 | nodes=2,000/5,001，events=2,000/5,000，`nextNodeCursor=n-1999`，`nextSeq=2000` | **服务端 bounded；客户端只调一次，丢 3,001 节点/3,000 事件** |
| `/events` 无 limit | 5,000 条一次返回，`page=null` | **无默认上限，S11 仍 FAIL** |
| MCP `list_nodes`（status=completed, limit=10） | 501 页，匹配 1,667 个；无丢节点 | bounded；但 `total=5,001` 是全部节点，`_truncated` 的 shown/total 不代表筛选结果 |
| MCP `get_node` | 单节点直接返回 | bounded |

`client.js:3683` 的 `fetchReplay` 不传 `limit`/`nodeLimit`，`client.js:9274` 只调用一次，
从未消费 `nextNodeCursor`；5,001 节点的回放面板只显示前 2,000，且边也只来自这一页。
这是 S11 修复引入的**回归**（此前 replay 返回全量，虽然无界）。`/state` 的客户端
`fetchStateAll` 有 `pages < 20` 的硬上限，超过 20,000 节点会静默截断并返回
`_truncated:null`；5,000 场景下 6 页，未触发。

### 15.6 新半接线 / 测试盲点

1. **`surface-bounds-selftest` 已接入 `npm test`，但不是全链路**：它直接调
   `service.listNodesPage` 而不是真实 MCP transport；只测 replay 服务端，不测
   `client.js` 的 replay 翻页；不测 `/events` 默认值；不测 20 页客户端上限。因此它绿，
   但 15.5 的 replay 回归仍存在。
2. **`dag_map` 的 6 KB 测试是固定形状**：`tool-surface-selftest` 只用一个 owner 分布；
   变长 key 即超（6,150 B）。测试把 `bytes.used` 当作最终字节，实际 `used` 早于
   `projectId`/`revision` 注入。
3. **`dag_walk` 的 `bytes.used` 不是最终字节**：`dag.js` 在加 `truncated.bytes`
   字段后没有再裁剪一次；`used` 与最终响应差 38 B，最坏形状直接超过 24,576。
4. **diff history cache 是内存放大器**：每个项目 16 份全量 `byId` 快照，32 个项目；
   没有 `reset` 调用方，没有按节点数/字节数的预算；`since` 落在两个快照之间时返回较老
   快照而非 `diff_unavailable`。
5. **explain fallback 只补事件、不补 node 指针**：store 的 `appendEvent` fallback 让
   `event.causeId` 非空，但 `explain_node` 的起点仍是 node；GC/reconcile/merge 直写
   在无 node cause 时 chain=0。
6. **MCP `list_nodes` 的 status 过滤是后过滤**：limit=10 时扫描 501 页才找完 1,667 个
   completed 节点；`total` 仍是全部节点。没有丢节点，但不是“按 status 分页”，且每页
   `count` 可能远小于 limit。
7. **`getState` 的 `full=1` 仍可放大响应**：HTTP 仍强制 1,000 节点/页，但 `full`
   会返回未 slim 的节点；S11 的字节上限只测默认 slim 页。
8. **`get_node` 是“直接查找”但 `getNode` 仍 `store.listNodes(projectId)` 全量遍历**
   来计算 sealed/isLeaf；5,000 节点可用，但不是 O(1)，与测试描述“direct lookup”不符。

### 15.7 第三轮上生产结论

**否。** 四个假测试已真 RED→GREEN，`A16` 窄验收关闭；但 `B15` 仍可超 6 KB 且
`used` 不准确、`O8` 的 reconcile/GC/merge 直写 chain=0、`S11` 的 replay 客户端丢 3,001
节点且 `/events` 无默认上限；另引入 replay 回归。整体仍是 100 行 FAIL，不能上生产。

## 16. 第三轮修复复核（2026-11-10）

| §15 剩余项 | 修复 | 复现/回归证据 |
|---|---|---|
| replay 客户端只取一页，丢 3,001/5,001 | `client.js` 的 `fetchReplayAll` 跟随 `nextNodeCursor`/`nextSeq`，按 id 合并 nodes/edges/events；`openReplay` 改用它 | `replay-client-selftest.mjs`：3,001 节点、2,500 事件、4+ 次请求，节点/事件无缺失无重复，末页 `_truncated=null` |
| B15 `dag_map` 6,150 B、`used` 早于 envelope | `mapDag` 接受 `envelope`（projectId/revision）并在最终对象上稳定计算 `used`；fit 后再次按最终字节裁剪 | `tool-surface-selftest`：5,000 个变长 owner 最终 ≤6,144 B，`used === 序列化字节` |
| B15 `dag_walk` 24,585 B、total 只报 200 | 同样纳入 envelope；`truncated.total=reachable`，`shown` 与 reason 区分 bytes/limit；稳定 `used` 后裁剪 | 同一测试：最终 ≤24,576 B、`used` 精确、total=4,999/5,000、reason=bytes |
| diff `since` 落在中间返回旧快照 | 只接受精确 revision 的快照，否则 `diff_unavailable`；缓存加全局节点预算，删除项目时 `reset` | `tool-surface-selftest` 直接构造 rev 1/2 后查 rev 3 → `diff_unavailable`；`reset` 后仍不可用 |
| O8 reconcile/GC/merge 只有事件 cause | `node.put` 写 `causeId/lastCauseId`；`intent.put` 同时指向目标节点 | `trace-selftest` 用真实 `reconcileRunningNodes`、`createGcRunner.run`、merge-prep `node.put`，三者 `/explain` chain > 0 |
| `/events` 无默认上限 | HTTP 默认 1,000，仍支持 after 分页 | `surface-bounds-selftest`：1,200 事件首屏 1,000 且 hasMore，下一页 seq 前进 |
| `/runs` 无 cursor | `store.pageRuns` + `service.listRunsPage`，HTTP 接受 cursor | 同一测试：3 runs、limit=1 两页不同 id |
| MCP list status 后过滤、total 全量 | 先按 status 过滤再切片，`total`/`_truncated.nodes.total` 为过滤后数量 | 同一测试通过真实 `McpServer` 注册的 `metainfer_list_nodes.handler` 断言 10/2,500 |
| `getNode` 仍全量 `listNodes` | store 维护 `children` 索引 + `hasChildren`；`getNode` 直接查询 | 同一测试 `metainfer_get_node` 返回 isLeaf，且不再调用 `listNodes` |
| HTTP `full=1` 绕过 slim 字节预算 | HTTP 路由不再转发 `full`，强制 slim + 1,000/页 | `surface-bounds-selftest`：`full=1` 仍 `_indexed=true`、<2 MB |

**结论**：§15 的 FAIL 路径均已关闭；`npm test` 27 个文件、408 checks 全绿（2026-11-10）。
仍 `未测量` 的只有浏览器绘制/FPS；仍 `未完成` 的见 IMPLEMENTATION §9。

---

## 17. 第四轮复核（HEAD `7d97432`，9 个新提交）

> 复核对象：`e5cff93`、`6c7bb68`、`7a26956`、`50c8d80`、`66d9ffe`、`791db98`、`f57e5d9`、
> `e719554`、`7d97432`（实际 9 个，含文档提交）。只读验证，未改生产代码；报告外的一切
> 实验都在 `/tmp/r4-*`。

### 17.1 最新总数与 delta

| 判定 | 第三轮 | 第四轮 | 变化 |
|---|---|---|---|
| PASS | 64 | **73** | +9 |
| FAIL | 100 | **91** | −9 |
| 未测量 | 10 | **10** | 0 |
| 合计 | 174 | **174** | — |

**FAIL → PASS（9 行）**：`B2`、`B15`、`B19`、`O8`、`S11`、`3.4`、`4.1`、`4.2`、`4.3`。
**仍 FAIL 的相邻行**：`B17`（确定性召回存在，但候选谓词不全、无人工标注精度/召回）；
`B20`、`B21`、`4.4`、`4.5`、`3.2`/`B5`。
**跨切面新增（不占 checklist 行）**：单写者（G1）现在真实可跑；`store` 仍有两个未加守卫的
删除方法，详见 17.2。

### 17.2 单写者：精确枚举与真实路径

静态枚举（`grep -rn "\.save...|appendEvent|\.put(" host/ index.js`；`node_modules` 除外）：

| 写面 | 数量 | 位置 |
|---|---|---|
| `store.saveProject/saveNode/saveRun/saveCycle` | **9** | 全部在 `host/kernel/executor.js`（`:153,154,159,162,268,270,271,274,296`） |
| `store.appendEvent` | **1** | `executor.js:148`（另一处是 `store.js:423` 的定义） |
| `tables.*.put` | **5** | `store.js:332/389/442/549/566`，均在 `saveProject/saveNode/appendEvent/saveRun/saveCycle` 内部 |
| `store.deleteProject` | **3 调用点** | `service` 走 `kernel.executor.deleteProject`；`executor` 内部 `store.deleteProject` 两处 |
| `store.deleteNode` | **1 调用点** | `executor.js`（`store.js` 是定义） |

**生产越权调用点 = 0。** 9 个 save 调用都在 executor 内，executor 的 `commit`/`commitLocked`
在 `withWritePermit` 内；`store.appendEvent` 只在 executor 内被调用；5 个 table.put 都在
store 自己的 guard 内。`strictWrites` 默认为 `throw`（`index.js:78-79`）。

真路径探针（`/tmp/r4-ops-probe.mjs`，setup 完成后 `setStrictWrites('throw')`）依次执行：
`reconcileRunningNodes` → `reconcileRunningRuns` → 真实 `createGcRunner.run` → 真实
`runtime.start` 的 merge 路径 → `auto.start/stop`。结果：

```
reconcile: ["p/legacy"]; runs: ["p/r1"]
gc: completed; writeStats: {"mode":"throw","unpermitted":0,"byOp":{}}
autoStart: running
```

**插件在 throw 下能跑。** 但守卫不是全覆盖：

- `store.deleteProject` **没有** `guardWrite`；在 `throw` 下直接调用
  `store.deleteProject('p')` 返回成功，项目被删除。
- `store.deleteEventRecord` 同样没有 `guardWrite`；当前只有 `executor.recoverLocked` 在
  permit 内调用它。
- 因此准确说法是：**0 个可达越权调用点，2 个未加守卫的写方法**。当前代码没有第 3 个
  调用方，所以不阻塞运行；但“任何新的直接写都会失败”的守卫承诺对这两个方法不成立。
  `strict-writes-selftest` 的静态列表只查 6 个文件，也没有直接调用这两个方法。

### 17.3 Replay 客户端：真正跟页

`scripts/replay-client-selftest.mjs` 用真实 HTTP route 注入 `fetchReplayAll`（从 `client.js`
抽取），不是重写 helper。独立探针（`/tmp/r4-replay-probe.mjs`，5,001 节点、4,500 事件、
默认 `nodeLimit/limit=2000`）结果：

```
ok   client replay follows every node page at default limits
ok   client replay keeps every event page at default limits
ok   client replay has no duplicate nodes
ok   client replay reports completion
ok   client replay requests multiple pages at default limits
ok   default helper returns all nodes
```

独立重植：在 `/tmp/r4-replay/client.js` 把 `maxPages` 默认 50 改成 1，`replay-client-selftest`
EXIT=1：

```
FAIL client replay follows every node page — nodes=1000/3001
FAIL client replay keeps every event page — events=1000/2500
FAIL client replay reports completion — {"pages":1,"nodes":true,"events":true}
FAIL client replay requests multiple pages — calls=1
```

**S11 replay 回归真关。** `maxPages=50` 的上限仍在，>100k 节点/事件会显式 `_truncated`
（不是静默丢），但该上限未纳入测试。

### 17.4 B15：最终字节成立

`/tmp/r4-b15-probe.mjs` 用 5,001 节点、5,000 个不同且变长的 owner（不是固定 `owner-${i}`）：

| 检查 | 结果 |
|---|---|
| `dag_map` 最终 JSON | **6,120 B ≤ 6,144**；`_truncated.bytes.used=6,120`，等于实际序列化长度；`groups={shown:85,total:5001}`；`revision=0` |
| `dag_walk` 最终 JSON | **24,376 B ≤ 24,576**；`truncated.bytes.used=24,376`，等于实际；`shown=145,total=5000,discovered=5001,reason='bytes'`；`revision=0` |
| `dag_diff` 精确 since | R0→R1 `fromRevision=0,toRevision=1,added=5002`；R1→R2 `added=['d2']` |
| `dag_diff` 跨过未缓存 R3 | `since=3` → `ok:false, code:'diff_unavailable', message:'no snapshot at or before revision 3'` |
| `dag_diff` ahead | `since=999` → `diff_unavailable` |

`envelope`（projectId/revision）现在在 fit 前注入；`stabilizeByteCount` 后再次裁剪，`used`
与实际长度相等；`total` 用 reachable 而非 200 页上限。**B15 通过。**

### 17.5 O8：real reconcile / GC / merge 的 node 指针

`/tmp/r4-ops-probe.mjs` 在 `strictWrites=throw` 下：

| 路径 | node.causeId / lastCauseId | chain |
|---|---|---|
| 真实 `reconcileRunningNodes`（legacy running，无 cause） | `reconcile:legacy` / `reconcile:legacy` | **1**（`node/failed`） |
| 真实 `createGcRunner.run`（fake activation，真实 commit） | `gcn-gc-run-...` / 同 | **1** |
| 真实 `runtime.start` merge 路径（`prepareMerge` 写 `node/merge_prepared`） | `m1-a1` / `m1-a1` | **1**；`mergeState='clean'` |

三条路径均由 `node.put` 在 `mutations.js:166-170` 写 `lastCauseId`，不是只靠
`store.appendEvent` 的 fallback；`/explain` 可用。**O8 通过**（merge 的 cause 指向 activation
`m1-a1`，不是 merge 事件本身的专用 id；链非空，语义上仍可追到启动动作）。

### 17.6 Stage 3/4：生产调用方计数

`grep -rn "from './kernel/intent.js'|from './experts/..." host --include=*.js` 的结果：

| 功能 | 生产调用方（模块 / 调用点） | 结论 |
|---|---|---|
| intent log (`kernel/intent.js`) | **3 模块 / 4 个 `createIntent` 点**：`dispatch/envelope.js:72`、`orchestrator.js:674`、`lab-service.js:2990`、`:3097`；`intent_list` 也在 `agentTool` | 有生产调用；`intent.put` 持久化；3.4 PASS |
| expert descriptors (`experts/registry.js`) | **1 模块 / 2 个 `listExpertDescriptors` 点**：`lab-service.js:2951`、`:2962`；`computeExpertMetrics` 同处 | 有生产调用；B2 PASS |
| recall (`experts/similarity.js`) | **2 模块 / 2 个生产点**：`lab-service.js` `recallExperts`；`curator.js` `recallCandidates` | 有生产调用；4.2 PASS |
| curator (`experts/curator.js`) | **1 模块 / 3 个生产点**：`createCurator`、`nominate`、`recordOutcome`；`applyNomination` 也在 `recordCuratorOutcome` | 有生产调用；4.3 PASS |

零调用方 / 只测试的死代码（不改变上面的“主功能有调用方”，但要记录）：

- `getExpertDescriptor` 在 `lab-service.js:30` **只 import，从未调用**（0 production call site）。
- `curator.reset()` **0 production call site**；false-close 断路器一旦打开，没有 Host action
  能复位，只能重启。
- `curator.applyNomination()` 由 `curator_outcome` 的 `apply` 分支使用；不是执行路径。

**仍 FAIL 的 Stage 3/4：**

- **B17**：`nodeSimilarity` 只做 title/criteria/tags Jaccard + `promptHash` 完全相等
  boost；没有 promptHash 前缀、同父 + 相似 successCriteria、同 metrics 目标；也没有
  人工标注 30 组的 precision/recall。它是“确定性召回”，但不是 B17 的完整候选谓词。
- **B20**：没有 `nomination/withdrawn`、没有“建子节点自动撤回 defer”、没有生产路径的
  10 分钟免疫（`nominateDuplicates` 的 `claims/reviews` **硬编码空数组**，
  `curator.nominate` 的 10 分钟 recent 过滤对真实 claim/review 不生效）。
- **B21**：intent log 只是 append，`intent.put` 没有 TTL、撤回、或“两条 intent basis 不同
  → 丢弃陈旧方”的代码；`executor` 的 basis 只校验 node rev，不处理 intent 分歧。
- **4.4**：无 defer 提名自动撤回；**4.5**：无专家库 UI。
- **3.2/B5**：人类建节点仍不默认 p0；p0→claim <1 s 仍未测。

### 17.7 Locale mirror：结构 parity 真会红，但 sync 方向会“洗白”

`/tmp/r4-locale`（HEAD 副本）：

| 操作 | 结果 |
|---|---|
| `npm run locale:sync` | 1338 en / 1338 zh；`locale-selftest` EXIT=0 |
| 在 `locale/zh.json` 加一个 `drift.key` | EXIT=1：`FAIL en and zh key sets are identical — 1338 vs 1339`、`FAIL client zh dictionary matches locale/zh.json` |
| 改 `client.js` 的 zh `panel` 值 | EXIT=1：client 与 JSON 不一致 |
| 先改 client，再 `npm run locale:sync` | 又 EXIT=0；JSON 被写成 `panel: "被篡改的界面"` |

结论：**结构 parity 测试是真的**，bundle 的两张内联表与 `locale/*.json` 确实相等；但
`locale:sync` 是从 **client 内联表生成 JSON**，不是从 JSON 生成 bundle。它不是 validator，
而是 overwriter：先改 client 再 sync，可以把不一致“洗白”成一致；先改 JSON 再 sync，翻译
会被覆盖。A12/U11 的“键集合相等”通过，但“reviewable source of truth”不成立；如果要求
bundle 消费 mirror 而不是内联副本，则仍未接线。

### 17.8 回归与风险

- `npm test`：**EXIT=0**，27 个 selftest，**408 个 `ok`**（含 strict-writes、replay-client、
  intent、experts、locale）。
- `npm run bench:scale`：**EXIT=0**，10/10。
- `r3probe8`：auth 三个 preset 全 `forbidden_action`；running/completed priority
  `priority_frozen`；report schema 500 / normalized 500 / headline 300；planned-cancel
  cause chain 1。
- 单写者回归：`/tmp/r4-ops-probe.mjs` 中 `unpermitted=0`；但 `deleteProject` 直调在 throw
  下仍成功（17.2）。
- 新风险：`store.deleteProject`/`deleteEventRecord` 无 guard；`locale:sync` 反向覆盖；
  `nominateDuplicates` 传空 claims/reviews；`getExpertDescriptor`/`curator.reset` 死代码；
  `maxPages=50` 的 replay 上限未测。

### 17.9 结论

**上生产：否。** 单写者主路径、replay 客户端、B15 最终字节、O8 三条真实 cause 链、
B2/B19/3.4/4.1/4.2/4.3 都已真关；但 B17/B20/B21、4.4/4.5、3.2/B5 仍 FAIL，store 仍有
两个未守卫的删除方法，locale:sync 仍可把 client 漂移写成 JSON。剩余 91 行 FAIL，继续
不能上生产。


---

## 18. 第四轮修复后复核（HEAD `39748a6`）

> 复核对象：`137b293`（G1 删除守卫）、`027d2de`（locale 方向 + 专家库 UI）、`c93e643`
> （B17/B20/B21 + curator 状态 + 人类 p0）、`39748a6`（p0→claim 测量）。只读验证；
> 测试全部用内存 domain，不写 `~/.dsh/storages`。

### 18.1 总数变化

| 判定 | §17 | §18 | 变化 |
|---|---|---|---|
| PASS | 73 | **80** | +7 |
| FAIL | 91 | **84** | −7 |
| 未测量 | 10 | **10** | 0 |
| 合计 | 174 | **174** | — |

**FAIL → PASS（7 行）**：`B17`、`B20`、`B21`、`4.4`、`4.5`、`3.2`、`B5`。
**跨切面**：G1 单写者、locale 生成方向不再是缺陷。`B27`（7 谓词/`citationErrorRate`）仍是
FAIL —— 本轮只关闭 B17 的结构谓词，没有伪造人工标注的精度/召回。

### 18.2 G1：两个删除方法真的被守卫

`host/store.js` 的 `deleteProject` 与 `deleteEventRecord` 现在第一步都是 `guardWrite(op)`。
在 `strictWrites='throw'` 下直接调用，二者均抛 `unpermitted_write`；项目仍在，事件未删：

```
deleteProject unpermitted_write
deleteEventRecord unpermitted_write
project alive true
writeStats: {mode:'throw', unpermitted:2, byOp:{deleteProject:1,deleteEventRecord:1}}
```

真实 executor 的 `recover`/`deleteProject` 走 `withWritePermit`，维护路径不需要绕过守卫。
`strict-writes-selftest.mjs` 现在同时断言：服务写入/取消成功、直接 `saveProject`/
`deleteProject`/`deleteEventRecord` 被拒、`unpermitted===3` 且 `byOp` 精确。

### 18.3 locale：JSON 是源，漂移只变红

`locale/{en,zh}.json` 现有 1,347 键，是唯一源；`scripts/locale-sync.mjs` 只从 JSON 生成
`client.js` 的 `#region locale-generated`，**不再写 JSON**。把客户端一个值改成 `MUTATED`
后运行 `locale-selftest.mjs`：

```
drift_exit=1
FAIL client zh dictionary matches locale/zh.json
```

恢复后 1,347 键逐键相等。`locale:sync` 重跑只更新客户端块；JSON 内容不变。

### 18.4 B17/B19/B20/B21

- **B17**：`similarityEvidence` 实装三类结构谓词，测试分别命中
  `promptHashPrefix`、`sameParentCriteria`、`metricTargets`；节点创建时落 `promptHash`，
  多父 merge 节点仍排除。
- **B19**：`nominateDuplicates` 传入真实 dispatch claim + `reviewClaims.list()`；测试断言
  被 claim 的 d1 不进入提名。10 分钟免疫用真实 `clock` 边界验证：11 分钟旧对入选，
  9 分钟节点被排除。
- **B20**：`node.create` reducer 在同一次 commit 内把针对 parent 的 pending curate nomination
  置 `withdrawn` 并写 `nomination/withdrawn{reason:child_created}`；curator 反向免疫有幼子的 parent；
  测试用真实 executor 建 `child-of-d1` 后检查事件与状态。
- **B21**：intent 带 `status:'pending'` 与 30 分钟 `expiresAt`；下一次 `intent.put` 自动把过期项
  置 `expired` 并写 `intent/expired`；`intent_withdraw` 可撤回；
  同目标已有更高 basis 时新提交返回 `stale_basis` + `conflictingIntentId`；`curator_reset`
  是可调用的生产 action，重置熔断。

### 18.5 4.4/4.5/3.2/B5

- **4.4**：建子自动撤回（同 B20），不再靠人工清理 defer。
- **4.5**：设置弹窗有只读专家库，数据来自 `GET /experts`（`service.listExperts`），
  显示 persona/mayPropose/metrics/“只提议，不执行”；加载中/错误/空/刷新四态。
- **3.2/B5**：`orchestrator.createChild` 对人类后继默认 `p0/by=human`；
  `priority-selftest` 用真实 `createSuccessor` + fake git 验证；`dispatch-selftest` 用真实
  dispatcher 测量 `p0→dispatch/claimed` = **21 ms**（预算 <1,000 ms）。

### 18.6 测试与剩余

`npm test`：**27 个文件、436 checks，exit 0**（`/tmp/npmtest-r4b.log`）。新增/扩展：
`strict-writes`、`experts`（谓词/免疫/claims/生命周期）、`priority`（人类 p0）、
`dispatch`（p0→claim）、`surface-bounds`（`/experts`）、`ui`（专家库）、`locale`（漂移）。

仍 FAIL：`B27` 7 谓词 claim 校验与 `citationErrorRate`；`P1.2/S12` 冷段归档；`U14` dashboard
静默过期；`U13` dashboard 来源徽标；`O12` 文本审计；浏览器绘制/FPS 未测量；Stage 5 组织化。

---

## 19. 第五轮复核（HEAD `5ee1376`）

> 复核对象：`39748a6` 之后的 12 个提交（`37f7a7a`…`5ee1376`）。只读验证，没有改生产代码；
> 所有探针都在 `/tmp/r5-*`。本轮的 174 行口径不变。

### 19.1 总数变化

| 判定 | §18（39748a6） | §19（5ee1376） | 变化 |
|---|---|---|---|
| PASS | 80 | **79** | −1 |
| FAIL | 84 | **85** | +1 |
| 未测量 | 10 | **10** | 0 |
| 合计 | 174 | **174** | — |

**本轮唯一回退行：`B21`。** §18 把 B21 判 PASS，只验了 TTL/撤回/冲突码；清单 B21
还要求每条意图带 `basis:{projectRevision, snapshotAgeMs, nodesSeen}`，当前只有整数
`basis`，没有 `snapshotAgeMs`/`nodesSeen`。`B17`、`B19`、`B20`、`4.4`、`4.5`、`3.2`、
`B5` 保持 PASS；`B21` 的 TTL/撤回/冲突子行为本身是真通过（见 19.5）。

### 19.2 删除守卫：8 个写方法全部有 guard

`host/store.js` 现在：

```
saveProject :331  saveNode :375  deleteNode :393  deleteProject :407
appendEvent :425  deleteEventRecord :455  saveRun :546  saveCycle :563
```

每个方法第一行都是 `guardWrite(op)`；`deleteProject`/`deleteEventRecord` 的
`tables.*.delete` 也在 guard 之后。`tables.*.put/delete` 只出现在这些方法内部，没有
第二个未守卫的导出方法（store 导出的其余方法均为读/锁/统计）。

在 `strictWrites='throw'` 下直接调用 **全部 8 个写方法**，均返回
`unpermitted_write`，项目仍在：

```
saveProject,deleteProject,deleteEventRecord,saveNode,deleteNode,
appendEvent,saveRun,saveCycle -> unpermitted_write
alive true
writeStats: {mode:'throw',unpermitted:8,byOp:{...每项1}}
```

随后 `kernel.executor.deleteProject('p')`（真实 `withWritePermit`）返回
`{ok:true}`，项目删除成功，`unpermitted` 仍为 8（没有把许可路径算成 bypass）。
`strict-writes-selftest` 也断言了 direct delete 被拒 + executor delete 成功。
**G1 删除守卫真关。**

### 19.3 Locale：JSON 是源，sync 只写 client

在 `/tmp/r5-locale`（HEAD 的 git archive + node_modules 软链）独立操作：

1. 基线 `locale-selftest` EXIT=0；`locale/zh.json` 与 `locale/en.json` 各 1,347 键。
2. 把 `locale/zh.json` 的 `panel` 改成 `被篡改的界面`：测试 EXIT=1，明确报
   `FAIL client zh dictionary matches locale/zh.json`；此时 client.js 不含该值。
3. 运行 `node scripts/locale-sync.mjs`：client.js 的 zh 块出现 `被篡改的界面`，
   `locale/zh.json` 的值仍是 `被篡改的界面`（没有被覆盖）；测试随后 EXIT=0。
4. 恢复基线后连续运行 `locale:sync` 两次：两次 EXIT=0，`git status --short` 为空；
   client.js、locale/zh.json、locale/en.json 的 sha256 完全不变。
5. 审计脚本：`import { readFile, writeFile }`；唯一的 `writeFile` 是
   `scripts/locale-sync.mjs:39` 的 `writeFile(clientPath, next, 'utf8')`；没有写 locale
   JSON 的调用，源码中的 `locale/*.json` 只出现在 `readFile`。

**locale 方向已反转；漂移只变红，不会再被 sync 洗白。** 仍是静态 UI 文案测试，没有浏览器绘制。

### 19.4 B17/B19：真实谓词、真实 claims/reviews

独立探针 `/tmp/r5-stage-probe.mjs` 用真实 `kernel.executor.commit` 建节点、真实
`createLabService` + `registerAgentTool` 调 `curator_nominate`。节点不是测试私有的纯对象：

```
promptHashPrefix  {"score":0.4,"reasons":["promptHashPrefix","tagOverlap"], ...}
sameParentCriteria {"score":0.6,"reasons":["sameParentCriteria","tagOverlap"], ...}
metricTargets     {"score":0.5,"reasons":["metricTargets","titleOverlap","tagOverlap"], ...}
candidates=3
nominations=[sib-a~sib-b (sameParentCriteria), met-a~met-b (metricTargets), prompt-a~prompt-b (promptHashPrefix)]
```

生产 `nominateDuplicates` 同时拿到了非空 claims/reviews：

- 一条 `reviewClaims.list()` 的 `claim-a` review 使 `claim-a~claim-b` **没有进入候选**；
- 一个 2 分钟前创建的 young pair **没有进入候选**；
- 一个 30 分钟前的 `p-old` 因为有一个 2 分钟前的 `p-child`，**没有进入候选**（反向免疫）。

`createCurator` 生产只有一个实例（`host/lab-service.js:2940`）；描述符 tools 仅
`dag_map/dag_walk/dag_get/dag_query`，`mayExecute=[]`；单轮 `maxNominations=5`。
**B17/B19 PASS。**

### 19.5 B20/B21：生命周期行为通过，B21 的 basis 形状不通过

**B20 通过。** 生产 `node.create` 建 `p-child2` 后，pending curate 意图：

```
status: withdrawn
withdrawReason: "child p-child2 created under p-old"
event: nomination/withdrawn
data: {intentId, nominationId, reason:"child_created", childId:"p-child2"}
```

10 分钟免疫已在生产 `nominateDuplicates` 中验证：幼节点、以及“旧 parent + 新鲜 child”
的 parent 都不在候选。**B20/4.4 PASS。**

**B21 生命周期子行为通过：**

- `createIntent` 默认 `expiresAt = at + 30 * 60_000`；探针实测 `expiresAt-at=1,800,000`。
- 过期 pending 意图在下一次 `intent.put` 变 `expired`，并写 `intent/expired`（探针
  `expired-r5` 的 status=expired，事件 data 带 intentId）。
- `intent_withdraw` 成功把 note 意图置 `withdrawn`，并写 `intent/withdrawn`；
  curate 类型写 `nomination/withdrawn`。
- 先提交 `basis=20` 的同目标意图，再提交 `basis=0`：返回
  `stale_basis`，并带 `conflictingIntentId=intent-note-21-...`、`basis=20`。
- `curator_reset` 是可调用的生产 action；`curator_reset` 有 `resetCurator()` 调用。

**B21 行仍 FAIL 的唯一硬缺口：** 实际意图记录是

```
{id, kind, status:"pending", expiresAt, actor, claim, basis:15, target, ...}
```

没有 `basis.projectRevision`、`basis.snapshotAgeMs`、`basis.nodesSeen`。这正是
DESIGN-CHECKLIST B21 的“每条带 `basis:{projectRevision, snapshotAgeMs, nodesSeen}`”。
其他子项通过不能替代该字段；因此 §18 的 B21 PASS 回退为 FAIL（79/85 的来源）。

### 19.6 4.5/3.2/B5：GET /experts、人类 p0、独立时延

**4.5 通过（按“专家绩效可读”的窄验收）：**

- 真实 HTTP 路由 `/api/metainfer-research-lab/experts`：status 200、`ok:true`、4 个专家、
  `mayExecute` 全为 0、每个专家有 metrics、curator.status 可读（探针 `/tmp/r5-http-experts.mjs`）。
- `client.js:3724` `fetchExperts`；`SettingsModal` 在 `:14064` 加载、`:14863` 渲染
  `rl-expert-library`，显示 persona / mayPropose / metrics / “只提议，不执行”，含
  loading/error/empty/refresh 四态；`ui-selftest` 静态断言通过。
- **注意：** 这是只读目录，不含 4.5 标题里的 hire/fire/drain（入职/解聘/排空）按钮；
  清单的验收文字只要求“专家绩效可读”，故按窄验收 PASS，但标题语义仍不完整。

**3.2/B5 通过。** 独立探针 `/tmp/r5-p0-probe.mjs` 用真实 `orchestrator.createSuccessor`
（fake git）建人类后继，再用真实 dispatcher：

```
priority: {class:"p0", by:"human", reason:"human request"}
createMs: 2.38
claimMs: 5.72        < 1,000 ms
claimed: true
runsAfterCreate: 0   // 没有 advisor/scheduler run
```

`claimMs` 是从 dispatcher.start 到 `dispatch/claimed` 的独立测量，不是复用作者的 21 ms；
本机得到 5.72 ms，仍然满足 <1 s，且 `p0/by:human` 与“不产生专家 run”均成立。

### 19.7 新调用方计数

| 导出 | 生产调用点 | 结论 |
|---|---|---|
| `getExpertDescriptor` | `host/lab-service.js:2972`（`recallExpertFor`） | **1 个生产调用**；`registry.js:69` 是定义，`:30` 是 import |
| `curator.reset` | `host/lab-service.js:3114`（`resetCurator`）← `:3329` 的 `curator_reset` action / `:3359` 导出 | **1 个生产 action 路径**；`agent-tool.js:36` 在 action 枚举中，policy 归 control |

两者都不再是死代码。

### 19.8 回归

- `npm test`：**EXIT=0**，27 个文件，**436 个 `ok`**（`/tmp/r5-npmtest.log`）。
- `npm run bench:scale`：**EXIT=0**，10/10（`/tmp/r5-bench.log`）。
- `/tmp/mir-audit/r3probe8.mjs`：auth 三个 preset 全 `forbidden_action`；running/completed
  priority `priority_frozen`；report schema 500 / normalized 500 / headline 300；planned
  cancel cause chain 1。
- replay：`replay-client-selftest` 全绿；独立 5,001 节点/4,500 事件默认分页探针
  `/tmp/r4-replay-probe.mjs` 全绿，无丢节点/重复。
- 单写者：静态 9 个 `store.save*` + 1 个 `appendEvent` 全在 executor；5 个 table.put
  全在 guard 方法内；生产 bypass 调用点 **0**；真实 reconcile/GC/merge/auto 的
  `unpermitted=0`（`/tmp/r4-ops-probe.mjs`）。

### 19.9 结论

**上生产：否。** G1 删除守卫、locale 单方向、B17/B19/B20/4.4/4.5/3.2/B5 的窄验收
都真关；B21 的 TTL/撤回/冲突码也真通过，但 B21 的 `basis` 对象仍缺失，所以总数由
80/84 回退到 **79/85**。剩余 FAIL 还包含 B27、冷段归档、dashboard 过期、浏览器绘制/FPS
等，不能上生产。

---

## 20. 第五轮修复复核（`9bdd581`…`652a545` + 工作区）

> 复核对象：§19 指出的五个硬缺口及其修复提交。除浏览器外均为真实代码 + `npm test` 路径，
> 不采信文档声明。

### 20.1 缺口关闭表

| 缺口 | §19 判定 | 本轮证据 | 结论 |
|---|---|---|---|
| B21 `basis` 形状 | FAIL | `intent-selftest`：意图 `basis` 精确等于 `{projectRevision:0,snapshotAgeMs:0,nodesSeen:2}`；标量、缺字段、`projectRevision` 超前均拒绝；陈旧冲突只读 `basis.projectRevision` | **PASS** |
| B27 7 谓词 + `citationErrorRate` | FAIL | `claims-selftest` 27 checks：7 谓词全过；逐个篡改每个谓词都被纯函数与真实 `submitIntent` 拒绝；4.9%/5%/15%/15.1% 边界；不可逆动作无证据/≥5% 门控 | **PASS** |
| P1.2/S12 冷段归档 | FAIL | `eventlog-selftest` 7 checks：hot 3、segment 2、7 事件生成 2 个 zstd 段 + checksum；跨 cold/hot 的 list/page；同一 memory domain 重启后续写无缺口；坏 checksum 硬失败 | **PASS** |
| U13/U14 dashboard | FAIL | `dashboard-selftest` 7 checks：`hostFacts` 不含 `AGENT PROSE/AGENT COMMENTARY`；widget `dataSource`、chat `source`；age/revision drift 均 stale；阈值 2×interval；UI 有 facts strip、来源徽标、带 age 的 stale 徽标 | **PASS** |
| 4.5 hire/fire/drain | FAIL（只读） | `expert-lifecycle-selftest` 16 checks：策略拒绝、hire、recall、drain 保活 running、busy fire、retire 移交、self-hire、HTTP `/commands` 真实路由；UI 三按钮 | **PASS** |

### 20.2 B21：字段与冲突键

- `host/kernel/intent.js` `intentBasis` 只返回/接受三个整数字段，`createIntent` 强制调用；
  `basisFor(projectRevision,nodesSeen,snapshotAgeMs=0)` 是唯一生产构造器。
- `lab-service.submitIntent` 的陈旧判定：
  `candidate.basis.projectRevision > incoming.basis.projectRevision`，返回
  `stale_basis{conflictingIntentId,basis,currentRevision}`；`snapshotAgeMs`/`nodesSeen` 只随
  intent 持久化，不参与比较。
- dispatch/priority/proposal 都改为对象 basis；dispatch 测试断言 claim 前 revision。

### 20.3 B27：每个谓词都真的能拒绝

`host/kernel/claims.js` 的 `verifyClaim` 逐原子返回 `{ok,predicate,claim,failure}`；
`verifyClaims` 汇总 failed/total/rate/tier。`claims-selftest` 先构造 7 谓词全过的 claim，
再逐个改坏 `nodeExists/statusIs/parentOf/metricIs/textContains/countWhere/reviewedBy`，
每次都断言失败谓词与 `claim_invalid`。提交失败会写 `claim/rejected` 且累计 `claimStats`，
连续错误率 ≥5% 时不可逆动作返回 `citation_error_rate`。

### 20.4 冷段归档不读不回退

- 段文件 `seg-<from>-<to>.jsonl.zst` + `.sha256`；checksum 侧车先写、临时文件 rename、
  已存在段拒绝覆盖。
- `store.archiveEvents` 只移动最老连续段，写事件时自动归档；`allEvents` 合并 cold+hot，
  `listEvents`/`pageEvents` 调用方无感。事件只从 hot 表移出，没有删除。
- 重启测试复用同一个 memory domain，新的 `store` 继续写后段序号连续。

### 20.5 Dashboard：事实与评论分离

- `dashboardHostFacts` 只输出 `{source:'host',computedAt,projectRevision,counts,resources}`，
  不含 widget body/chat。
- `dashboardView` 给 widget 标 `dataSource`（script=host，agent=agent），chat 标
  `source`（user=human，其余=agent）；`commentary` 是独立对象。
- stale 条件是 2×interval（下限 60 s）或 `lastRun.revision !== projectRevision`；
  `lastRun.revision` 在 refresh 开始时捕获。UI 显示 `Stale · {age}` 和 revision tooltip。

### 20.6 4.5：drain 不是 kill

- roster 在 `project.config.experts`；`hire` 拒绝 expert actor 和 self-hire，且 `mayExecute`
  非空拒绝；`drain` 只写 `draining`，把 running 节点列在 `runningPreserved`，不取消；
  `fire` 必须先 drain，仍有 running 返回 `expert_busy`；退休时非完成节点 `createdBy`
  改为 `human` 并记 `orphanedFrom`。
- `expert_list` 返回 lifecycle；`recallExpertFor` 只召回 active（roster 为空时保留目录语义）；
  UI 按状态显示 Hire/Drain/Retire，并显示 drain 安全说明。
- HTTP `/commands` 已接 `expert_hire/expert_drain/expert_fire`；测试真实 POST，避免按钮
  只在 service 层可用。

### 20.7 浏览器绘制：一次探测，关闭为不适用

本机探测结果（2026-11-10）：

```
command -v chromium chromium-browser google-chrome firefox  → 全空
require.resolve('playwright'|'playwright-core'|'puppeteer'|'@playwright/test') → 全 missing
npx --no-install playwright --version → 无
GUI http://10.16.1.89:3080/ → 401 authentication required
```

因此无法测量首屏/交互帧或做真实 DOM 点击；`ui-selftest` 仍只覆盖 view-model 预算。
按任务裁决，这一点只记录一次并**关闭为不适用**，不再作为待办反复计数。若要真测，
需要先在本机安装 Chromium/Playwright 并能通过 GUI 鉴权。

### 20.8 回归

- `npm test`：**EXIT=0**，31 个文件，**495 个 `ok`**。
- `npm run bench:scale`：**EXIT=0**，10/10；dispatch p95 32.9 ms、max 40.2 ms（5,000 节点）。
- locale：`locale/en.json`/`zh.json` 均 1,371 键；`locale-selftest` 绿，JSON 仍是唯一源。

### 20.9 结论

§19 的五个硬缺口（B21、B27、P1.2/S12、U13/U14、4.5）均已关闭；浏览器绘制按环境限制
关闭为不适用。仍不在本轮范围的是 O12 文本审计、Stage 5 组织化、`maxPlannedInFlight`/
抢占、schema 级 per-preset 收窄和覆盖率哨兵，不能据此宣称 174 行全部 PASS。

---

## 21. 第六轮独立复核（HEAD `ad396b7`，`5ee1376` 之后 7 个提交）

> 只读验证。所有探针在 `/tmp/r6-*`，未改生产代码；本轮唯一改动是本文件。作者 §20 的
> “五个硬缺口全部关闭”按独立证据逐项重放，不采信 selftest 名称或提交说明。

### 21.1 最新总数与 delta

| 判定 | §19（`5ee1376`） | §21（`ad396b7`） | 变化 |
|---|---|---|---|
| PASS | 79 | **82** | +3 |
| FAIL | 85 | **82** | −3 |
| 未测量 | 10 | **10** | 0 |
| 合计 | 174 | **174** | — |

**FAIL → PASS（3 行）**：`B21`、`5.4.5`、`U13`。
**仍未关闭的相邻行**：`B27`、`S12`、`U14`（§20 把三者写成 PASS，但独立探针不成立）。
`4.5` 在 §18 已是 PASS，本轮复核继续成立，不重复计入 delta。

**关于浏览器**：`S8`/`S9` 由“未测量”明确记为**不适用（N/A）**，不再当作 FAIL 行；本机
`command -v chromium chromium-browser google-chrome google-chrome-stable firefox` 全空，
`playwright`/`playwright-core`/`puppeteer`/`@playwright/test` 均无法解析，
`npx --no-install playwright --version` 失败，GUI `http://10.16.1.89:3080/` 返回 **HTTP 401**。
此项只记录这一次；10 个“未测量”中包含这 2 个 N/A 和 8 个设计/端到端未测项。

### 21.2 B21：精确 basis 与冲突键 — PASS

独立探针 `/tmp/r6-b21-probe.mjs` 走真实 `lab-service.submitIntent`：

- 不传 basis 时，持久化对象精确为 `{projectRevision:1,snapshotAgeMs:0,nodesSeen:1}`，
  事件上的 basis 同形；自定义 `snapshotAgeMs:123` 原样保留。
- 标量 `7`、缺字段 `{projectRevision,snapshotAgeMs}` 均返回 `bad_request`。
- `projectRevision:999` 返回 `basis_ahead`。
- 先以当前 revision 建立 pending intent，再用旧 revision 提交，返回
  `stale_basis{conflictingIntentId,basis,currentRevision}`；比较键确实是
  `basis.projectRevision`，不是节点/时间等旁路。
- `snapshotAgeMs`/`nodesSeen` 只被持久化，不参与冲突比较；这与 B21 原文一致。
- `intent-selftest` 18 checks 通过，作为交叉证据。

### 21.3 B27：7 谓词/错误率通过，5 级验证强度仍未落地 — FAIL

**已通过的子项**：`claims-selftest` 27 checks 全过；7 个谓词
`nodeExists/statusIs/parentOf/metricIs/textContains/countWhere/reviewedBy` 都能在纯函数与
真实 `submitIntent` 中被逐个改坏并拒绝；`citationTier` 的 4.9%/5%/15%/15.1% 边界存在；
累计错误率 ≥5% 时不可逆动作被 `citation_error_rate` 拒绝。

**仍 FAIL 的硬缺口**：B27 原文的 5 级表要求 cancel running = **2 条证据 + 首席确认**，
砍整条分支 = **3 条 + 首席 + 人可申诉窗口**，删除项目 = **只能人做**。当前
`host/kernel/claims.js` 的 `gateClaimAction` 只检查 `total > 0 && rate < 5%`，没有动作级
证据条数、首席确认或申诉窗口。独立探针 `/tmp/r6-b27-levels.mjs` 在干净统计下用**一条**
`nodeExists` 证据分别提交 `cancel_running`、`prune_branch`、`delete_project`，三次都返回
`ok:true`，`tier:'full'`，`verification:{total:1,failed:0}`。这直接绕过了 2/3 条证据和
首席门槛，属于不可逆动作的安全/正确性缺口，不能因 7 谓词测试全绿而判 PASS。

### 21.4 冷段归档：功能关闭，S12 预算未达 — `5.4.5` PASS / `S12` FAIL

**`5.4.5`（功能）PASS**：`eventlog-selftest` 7 checks 通过；真实 store 在 hot 表保留
3 条时生成 2 个 `seg-*.jsonl.zst` + `.sha256`；`listEvents`/`pageEvents` 跨 cold+hot
透明返回；同一 memory domain 重启后继续写，seq 无缺口；篡改段文件后 checksum 校验抛
`archive_checksum_mismatch`，不是静默返回空/旧值；归档只把事件移出 hot，不删除。
这些覆盖了本轮要求的“透明读、重启续写、坏 checksum 硬失败、事件不丢”。

**`S12`（100k 读预算）FAIL**：独立探针 `/tmp/r6-cold-page.mjs` 造 100,000 条事件
（hot 50,000、5 个段），**第一次** `pageEvents({after:0,limit:100})` 耗时 **60.9 ms**，
超过清单的 **≤50 ms**；`listEvents` 首次约 68.5 ms。冷缓存已热后 page 约 5–7 ms，说明
首读把全部 cold 段解压进 `allEvents` 仍是 O(全部)，不是按页读。`5.4.5` 的“有归档”与
`S12` 的“100k 首读 ≤50 ms”是两行，不能合并判 PASS。
附带证据：`getReplay` 仍先 `store.listEvents(projectId,afterSeq)` 再切片，
`Math.min(...nodeTimes)` 也未消除，`S5` 的 O(全部) 路径仍在。

### 21.5 Dashboard：hostFacts/归属通过，U14 过期货真值仍错 — `U13` PASS / `U14` FAIL

**`U13` PASS**：`dashboardHostFacts` 只返回 `{source:'host',computedAt,projectRevision,
counts,resources}`，不含 widget body/chat 散文；widget 有 `dataSource`，chat 有
`source`；stale 徽标带 `ageMs`，revision 不一致时有 tooltip；2×interval 下限 60 s 也成立。
`dashboard-selftest` 7 checks 通过。

**`U14` FAIL（且是本轮回归）**：成功刷新后仍被判 stale。独立探针
`/tmp/r6-dash-success.mjs` 的结果是 `lastRun.revision:0`、`projectRevision:2`、
`stale:true, staleReason:"revision_changed"`。根因在 `refreshDashboard`：它在写 widget/
dashboard 之前捕获 `lastRun.revision = project.revision`，而后续 commit 又递增
`project.revision`，所以每次成功刷新都留下 revision 漂移，徽标永远显示过期。

失败刷新更危险：`/tmp/r6-dash-fail2.mjs` 把一次失败刷新的 `lastRun.revision` 对齐到当前
revision 后，`dashboardView` 返回 `stale:false`、`staleReason:null`，尽管
`lastRun.status:"error"` 且 widget 仍是旧数据。也就是说顶栏可以用“时间新”掩盖失败；
现有 UI 只有一个不可关闭的 `role="alert"` 错误段，没有失败次数/连续失败降级，也没有
可关闭的顶部过期告警（`A20` 同样仍 FAIL）。这不是“徽标没有 age”，而是 age/revision
真值在成功与失败两条路径都不成立。`U14` 判 FAIL。

### 21.6 4.5 生命周期 — PASS

独立探针 `/tmp/r6-lifecycle-http.mjs` 通过真实 HTTP `POST /api/metainfer-research-lab/commands`
驱动，不直接调 service：

- `expert_hire` → HTTP 200，lifecycle `active`。
- `expert_drain` → HTTP 200，lifecycle `draining`，`runningPreserved:["run"]`，running
  节点仍在。
- running 未结束时 `expert_fire` → HTTP 200、`ok:false`、`expert_busy`。
- 把 running 完成后 `expert_fire` → HTTP 200，lifecycle `retired`，未完成 planned 节点
  重派为 `createdBy:"human"`、`orphanedFrom:"lab-advisor"`。
- 专家 actor 调 `expert_hire` → `forbidden_action`（tool policy 先于 service 拒绝）；
  service 层 self-hire 也返回 `self_hire_forbidden`。测试 16 checks 与上述独立结果一致。

### 21.7 回归与测试

- `npm test`：**EXIT=0**，31 个文件，**495 个 `ok`**。
- `npm run bench:scale`：**EXIT=0**，10/10；dispatch p95 30.9 ms、max 35.6 ms（5,000 节点）。
- 新 selftest：intent 18、claims 27、eventlog 7、dashboard 7、expert-lifecycle 16，均通过。
- `ui-selftest`：11/11；但它只验证 view-model，不验证真实 DOM/帧率。
- 没有测试回归；但 §21.5 的“成功刷新永久 stale”是行为回归/真值错误，§21.3/§21.4 是
  未达清单的硬缺口。全绿测试不能覆盖这三项。

### 21.8 82 个剩余 FAIL 的三分解

分桶定义（严格一桶一行）：

- **阻断上线**：会在真实运行路径上破坏正确性/安全，或让不可逆动作绕过应有门槛。
- **能力未建**：清单要求的能力在代码里没有落点，或只有半套接口/枚举而没有运行路径。
- **只差文档/口径**：实现已存在，但清单行是旧证据、纯文本冲突/未复核，或验收口径比
  当前构建更严而未重新裁决。

| 分桶 | 行数 |
|---|---|
| 阻断上线 | **3** |
| 能力未建 | **59** |
| 只差文档/口径 | **20** |
| **合计** | **82** |

#### 阻断上线（3 行，逐行）

| 行 | 为什么阻断 | 独立证据 |
|---|---|---|
| **B27** | 不可逆动作的 5 级证据强度未实现；1 条证据即可提交 cancel/prune/delete，无首席确认/申诉窗口 | `/tmp/r6-b27-levels.mjs`：三次 `ok:true`、`tier:"full"`、`total:1`；`gateClaimAction` 只看 total>0 且 rate<5% |
| **C7** | 引用错误率没有 Wilson 下界/最少证据要求；少量证据即可把 rate 压到 <5%，与 B27 叠加可绕过不可逆门槛 | `claims.js` 只有 `failed/total` 比率；`citationTier` 无样本量修正；B27 探针已证明 1 条证据即 full |
| **U14** | 成功刷新永久 `revision_changed` stale；失败刷新在 revision 对齐时顶栏 `stale:false`，会把旧数据显示成新数据，且没有可关闭告警/连续失败降级 | `/tmp/r6-dash-success.mjs`（lastRun 0 vs project 2）、`/tmp/r6-dash-fail2.mjs`（status error 但 stale false）；A20 同因 FAIL |

#### 能力未建（59 行）

组织/评审：`B11`、`B12`、`B13`、`B14`、`B16`、`B18`、`B22`、`B23`。
调度/专家/评审/记忆：`Q3`、`Q4`、`Q5`、`Q8`、`Q9`、`Q10`、`Q11`、`Q12`、`Q13`、`Q14`。
进度：`1.3`。
计划缺口：`5.2`、`5.3`、`5.3.1`、`5.3.2`、`5.3.3`、`5.3.4`、`5.3.5`、`5.3.7`、
`5.3.8`、`5.3.9`、`5.3.10`、`5.3.11`、`5.3.12`、`5.3.13`、`5.3.14`、`5.4`、
`5.4.2`、`5.4.6`。
可观测性：`A11`、`A20`、`A21`。
开放问题：`C1`、`C2`、`C5`、`C6`、`C8`、`C14`。
指标：`O1`、`O2`、`O3`、`O4`、`O5`、`O6`、`O12`。
规模：`S5`、`S12`。
UI：`U1`、`U2`、`U3`、`U12`。

> 这些行的共同证据是“没有运行路径/没有实现”，不是文档没写。典型例子：`B11/B12` 无
> branch/lead/chief；`B16` 明确选择无驻留会话；`B22` 无 dispute 表；`B23` 无 expected/
> retro；`Q3` 无 WIP/reservedSlots/抢占；`Q5` 的 deferred 仍占 `maxNodes`；`5.3.1` 无
> `maxPlannedInFlight`；`5.3.13` 无 observer；`A21` 无 queue runnable/claimed/held；
> `O4/O5` 的 queue/counts 口径错；`S12` 100k 首读 60.9 ms >50 ms；`U1/U2/U3/U12`
> 的 elapsed/队列/失败归因/三态面板不存在。

#### 只差文档/口径（20 行）

`B9`、`B24`、`Q1`、`Q2`、`5.1`、`5.1.2`、`5.2.2`、`5.2.3`、`5.2.4`、`5.2.5`、
`5.3.6`、`5.3.16`、`5.4.3`、`5.4.4`、`5.4.7`、`C12`、`C13`、`O9`、`S13`、`U10`。

> 这 20 行都有实现或测试侧落点，但没有按原行重新验收：`B9` 有 policy/真实拒绝但无
> 5×6 矩阵；`B24`/`5.1` 的 7 谓词/rate 已存在（5 级缺口归 B27）；`5.1.2` 的
> summary/headline 已由 B26 落地，但该行是计划冲突未裁决；`5.3.6` 已由 4.5 的
> drain/fire 移交覆盖；`5.3.16` 的 dag 工具已存在；`S13` 的 `bench:scale` 已存在，
> 只剩 UI 绘制 N/A；`B9/Q1/Q2` 是旧证据/issue/端到端口径，不是新能力。`C12/C13`、
> `5.2.2–5.2.5`、`5.4.3/5.4.4/5.4.7` 是 WP/基线/文本冲突；`O9` 是缺 6 状态转换测试；
> `U10` 的 `forbidden_action` nextStep 已有，旧“三 preset 越权”证据已被 policy 推翻。

> 三桶覆盖 §19 的 85 行减去 B21、5.4.5、U13 三个 FAIL→PASS 后的 82 行；B27/S12/U14
> 重新放回 FAIL。没有第 83 行，也没有一行同时归属两桶。S8/S9 是 N/A，不在三桶内。

### 21.9 结论与上线裁决

**NO-SHIP。**

- 3 个阻断上线项：B27（不可逆动作 1 条证据即可 full）、C7（引用错误率无样本量下界，
  与 B27 叠加可绕过门槛）、U14（旧 dashboard 真值可显示为新）。
- 82 个 FAIL 中 59 个是能力未建，主要是 Stage 3–5 的组织/争议/预算/观测和 UI 面板；
  这不是“补文档”能解决的。
- 20 个只差文档/口径的行可以并行收尾，但不能拿它们掩盖 3 个阻断项。
- 浏览器绘制是环境性 N/A，不据此判 FAIL；但它也意味着真实 DOM/帧率没有被本轮验收。
- 本轮没有修改生产代码；唯一改动是本文件。建议先修 B27/C7/U14 和 S12 首读预算，
  再重跑 495 checks、100k 冷读探针与真实 HTTP 生命周期探针。

---

## 22. 第七轮修复复核（B27 / C7 / U14 / S12）

> 实现提交：`678981a`（B27+C7）、`5ce5279`（U14+A20），以及此前已落的 `S12` 冷读索引。
> 本节的数字由本次工作区重新执行；§21 是第六轮独立报告，保留原判。

### 22.1 最新总数与 delta

| 判定 | §21（`ad396b7`） | §22（`5ce5279`） | 变化 |
|---|---|---|---|
| PASS | 82 | **88** | +6 |
| FAIL | 82 | **76** | −6 |
| 未测量 | 10（含 2 N/A） | **10** | 0 |
| 合计 | 174 | **174** | — |

**FAIL → PASS（6 行）**：`B27`、`C7`、`U14`、`S12`、`A20`、`5.3.1`。
剩余 **76 FAIL** = 20 个只差文档/口径 + 56 个能力未建；3 个阻断项已清零。
因此可以继续做文档收尾与能力建设，但**仍不能**据此宣称 174 行全部上线。

### 22.2 B27：5 级验证强度

`host/kernel/claims.js` 现在导出：

| 等级 | 动作 | 本次证据 | 额外门槛 |
|---|---|---|---|
| L0 | `create_planned` | 0 | parent exists and not deferred（概念层） |
| L1 | `defer_planned` / `apply_nomination` | 1 | — |
| L2 | `cancel_running` | 2 | chief confirmation |
| L3 | `prune_branch` | 3 | chief confirmation + live appeal window |
| L4 | `delete_project` | 0 | human actor + explicit human confirmation + live appeal window |

`gateClaimAction(action, stats, context)` 把「本次提交的 evidence 数」与「累计
citation 历史」分开：`context.submitted` 是前者，`stats.total` 是后者。
`submitIntent` 只接受 human / system / `lab-chief` 的 `chiefConfirmed`，并把
行动门槛、human confirmation、appeal 窗口和 Wilson 下界写进 `claim.gate`。

`claims-selftest.mjs` 真实 service 测试：

- 一条 `nodeExists` 对 `cancel_running`、`prune_branch`、`delete_project` 全部拒绝
  （分别为 `claim_evidence_required` / `claim_evidence_required` /
  `human_confirmation_required`）。
- required set 通过：cancel 2 条 + chief；prune 3 条 + chief + 未来
  `appealUntil`；delete human + `humanConfirmed` + 未来 `appealUntil`。
- 非 human 的 delete 返回 `human_only`；expert 不能自封 chief；缺 appeal 返回
  `appeal_window_required`。

### 22.3 C7：Wilson 下界 + 最少证据

`wilsonLowerBound(successes,total,z=1.96)` 计算 clean-citation rate 的 95% 单侧下界。
门控要求 `total >= 20` 且下界 `>= 0.80`，并继续要求原始 `failed/total < 5%`；它和
B27 在同一个 `gateClaimAction` 调用里，不能只满足其中一条：

- 20 clean、required evidence 2 + chief → PASS；
- 19 clean → `citation_evidence_floor`；
- 20 条中 4 失败（即使 `submitted` 够）→ `citation_confidence_too_low`；
- 一条干净证据无法让 2/3/4 级动作通过（B27 先拒绝）。

### 22.4 U14：成功/失败真值

`dashboardView` 现在用 `lastSuccessAt`（不是本次失败尝试的 `endedAt`）计算年龄；
`lastRun.status === 'error'` 无条件 stale，`staleReason='refresh_failed'`。
成功刷新把 `lastRun.revision` / `dataRevision` 记为实际读取的 revision，另记
`lastRun.committedRevision` 为 dashboard 自身元数据写入后的 revision 供 freshness
比较；失败刷新保留上一次成功的 `revision` / `committedRevision` / `lastSuccessAt`，
不写入本次失败的时间或 revision。

连续失败 3 次后：

- `commentary.degraded = true`，widgets 带 `degraded:true`，UI 隐藏数字并显示
  “last success” 年龄；
- `nextRunAt` 指数退避，正常间隔 × 2^(n−1)，上限 30 分钟；
- 顶部出现可关闭的 `role="alert"`，`failureAt` 变化后重新出现；
- 后台失败写 `dashboard/failed` 事件，不再只有 `dashboard/partial`。

`dashboard-selftest.mjs` 用真实 `refreshDashboard` 与脚本 widget 验证：
成功时 `lastRun.revision === 2`、`committedRevision === project.revision` 且非 stale；
删掉 revision 对齐后写失败标记再刷新，仍为 stale/`refresh_failed`；连续三次失败
`degraded` 且退避 > 正常间隔。

### 22.5 S12：100k 首读

`host/store.js` 新增 `timelineCache`：归档边界预热 cold+hot 合并数组，后续只把
hot 尾部追加进去；首读不再解压/排序全部 cold 段。`scale-selftest.mjs` 造
100,000 事件（50k hot + 5 个 10k 冷段），首读 100 条：

```
100k-event first page in 0.27 ms   (another run 0.35 ms)
11/11 scale checks passed
```

预算 ≤50 ms，未放宽。

### 22.6 回归

- `npm test`：**EXIT=0**，34 个文件，**539 个 `ok`**（新增 claims 17、dashboard 3、
  ui 1、jsdom 15、auto WIP 4、process smoke 3 等）。
- `npm run bench:scale`：**EXIT=0**，11/11；新增 100k 首读断言。
- `locale-selftest`：en/zh 均 1,375 keys，client 字典同步。
- `ui-selftest`：12/12；新增可关闭失败告警与降级断言（仍不测真实 DOM/帧率）。

### 22.9 5.3.1：`maxPlannedInFlight`

`host/auto.js` 新增 `maxPlannedInFlightOf(project, capacity)`：默认
`max(2 × freeSlots, 4)`，项目可显式配置 `config.maxPlannedInFlight`。`tickOne`
把 runnable + claimed + held 的 planned 节点合计为 in-flight；达到上限时只跳过
advisor pass，确定性 dispatch 仍先执行，`status.lastPlanSkip` 暴露原因。

`auto-wip-selftest.mjs` 4/4：默认公式三组；5 个 runnable、容量 2（上限 4）时
`orchestrator.step` 0 次；2 个 runnable 时 1 次；显式上限 1 时 2 个也跳过。
这关闭 5.3.1，但 **Q3 的 `reservedSlots.p0` 与项目内抢占仍未做**，所以 Q3 整体
仍是 FAIL。

### 22.8 D 类：面板降级 smoke

新增 `scripts/client-smoke.mjs`（jsdom + React 19），按真实 `window.__ModuleLoader__`
合同加载 `client.js`，设置 `window.__METAINFER_TEST__` 后取得私有组件句柄，逐个挂载
15 个面板：Landing、Workspace、Projects、Dashboard、Runs、Explain、Proposal、GC、
Settings、FinishMerge、Push、DeleteProject、Confirm、Attempts、Trajectory。
所有 fetch 返回空/错误/degraded 结构，断言不进入组件树外的未捕获异常、不显示
`crash.title` 边界。

首次运行就抓到 `RunsPanel` 在 `runsState.cycles` 缺失时的
`Cannot read properties of undefined (reading 'length')`；已把 `runsState` 归一化为
`runs: []` / `cycles: []`。现在 **15/15 panel smoke checks passed**。

进程级 smoke 也已加入：`scripts/plugin-smoke.mjs` 在**独立 Node 进程**里 import
`index.js`，用 Host-like ctx 调用 `apply`（memory storage domain、真实 git
subprocess、stub agents/subagents），创建临时 git 仓库上的项目，`startNode`，等
`node/completed`，再用 `explainNode` 断言非空 `causeChain` 和 `node/completed`
事件。子进程出现 `uncaughtException` 或 `unhandledRejection` 即失败。

实际结果：**3/3 process smoke checks passed**（completed、summary 非空、cause
chain 长度 1、completed 事件在解释中）。这把 D 类补到进程级；仍未覆盖真实模型
provider、真实 DSH Host 与浏览器帧。

### 22.7 结论

**三个阻断项已关闭，S12 预算达标，A20 随之可见。** 但 174 行仍有 76 FAIL：
20 行需要把文档/验收口径落实，56 行是 Stage 3–5 组织、争议、预算、观测与 UI 能力。
本轮没有开始 Stage 5，也没有用文档改写替代代码证据。

---

## 23. 第七轮独立复核（HEAD `53ff695`，Round 7）

> 复核对象：`ad396b7..53ff695` 的代码与文档提交；其中包括 `678981a`（B27/C7）、
> `5ce5279`（U14/A20）、`6584441`（成功刷新 revision）、`7c7d48c`（5.3.1）和
> `e533164`（client-smoke）。只读验证，未改生产代码；所有探针在 `/tmp/r7-*`。
> §22 是作者报告，本节按独立证据重放，不采信其中的 PASS 数字。

### 23.1 最新总数与 delta

| 判定 | §21（`ad396b7`） | §23（`53ff695`） | 变化 |
|---|---|---|---|
| PASS | 82 | **84** | +2 |
| FAIL | 82 | **80** | −2 |
| 未测量 | 10（含 2 N/A） | **10** | 0 |
| 合计 | 174 | **174** | — |

**FAIL → PASS（2 行）**：`C7`、`5.3.1`。
**§22 声称关闭但独立复核仍 FAIL 的 4 行**：`B27`、`U14`、`S12`、`A20`。
其中 `B27` 和 `U14` 是阻断上线项；`S12` 是 100k 冷读预算；`A20` 是 partial
失败的告警路径。`5.3.1` 的 WIP cap 确实关闭；`C7` 的 Wilson 算术确实关闭，但
它对 L0/L1 的过头门控仍由 B27 承担。

### 23.2 B27：五级表存在，但“申诉”不是活机制 — FAIL

**已通过的窄项**（`/tmp/r7-b27-exact.mjs`，真实 service，预先建立 20 条干净历史）：

- 一条证据：`cancel_running` / `prune_branch` 都返回 `claim_evidence_required`；
  `delete_project` 返回 `human_confirmation_required`，不是 full。
- 必需集合：`cancel_running` 2 条 + chief、`prune_branch` 3 条 + chief + 未来
  `appealUntil`、`delete_project` 人工 + `humanConfirmed` + 未来 `appealUntil` 均通过。
- 普通专家 `lab-advisor` 写 `chiefConfirmed:true` 被 `chief_confirmation_required`
  拒绝；`lab-chief`（kind=expert）可以确认自己的 claim。若“expert actor 不能
  self-confirm”按字面包含 lab-chief，这仍是缺口；按“chief 是唯一例外”的口径则通过。
- `claims-selftest` 的 44 checks 全过，但它没有测试“真有 appeal 进入窗口”。

**仍 FAIL 的硬缺口：申诉窗口只有时间戳，没有申诉动作。** 全仓 `grep appeal` 只找到
`appealUntil` 的数值检查；没有 `appeal` intent kind、没有 dispute/appeal 表、没有
取消/挂起 pending intent 的路径。探针先提交 `{action:'appeal',reason:'I object'}`，
它只被当成一条普通 note intent；随后同一 prune 仍然 `ok:true`。因此
“appeal during the window blocks the action”不成立：`appealUntil` 只是要求未来时间，
并不等待或监听申诉。

**另一个 B27 缺口：C7 门控越界到 L0/L1。** `gateClaimAction` 对
`create_planned`（0 证据）和 `defer_planned`（1 证据）也执行 `total >= 20` 的 C7
floor；探针直接返回 `citation_evidence_floor`。这使新专家无法完成 B27 的 L0/L1，
与“planned=0、defer=1”表格冲突。作者测试只覆盖取消/剪枝/删除，未覆盖这两级。

结论：B27 **FAIL**，不是“三个阻断项已清零”。

### 23.3 C7：Wilson 算术与同门控 — PASS（但请注意上节越界）

独立结果（同一 `gateClaimAction`，没有单独入口）：

- `total=20, failed=0`（20 clean）→ `ok`，Wilson lower bound `0.83887`。
- `total=19` → `citation_evidence_floor`（即使提交 2 条证据）。
- `total=20, failed=4` → `citation_confidence_too_low`（lower bound `0.58398`）。
- 20 clean 的真实 `submitIntent` 必需集合通过；19/4 在同一个 gate 拒绝。
- 代码里 C7 就在 `gateClaimAction` 的 B27 检查之后，没有第二条可绕过路径；故
  C7 行判 **PASS**。但“C7 floor 对所有 action 都执行”是 B27 L0/L1 的问题，
  不能把两行一起判 PASS。

### 23.4 U14：总失败已修，partial 失败仍 fresh — FAIL

**通过的子项**（`/tmp/r7-u14-probe.mjs`）：

- 成功刷新：`lastRun.revision=8` 是读取 revision，`committedRevision=10` 等于
  `projectRevision=10`，`stale:false`，`staleReason:null`。
- 全部 widget 失败：每次 `status:'error'`、`stale:true`、
  `staleReason:'refresh_failed'`；第 3 次失败 `degraded:true`，`nextRunAt`
  从约 2 分钟退到 4 分钟，符合指数退避；成功后再刷新恢复 `degraded:false`。
- 不可关闭/重开的 DOM 逻辑存在：`failureAt` 使用 `failedAt/endedAt`，
  `dismissedFailureAt` 改变后重新显示；这是针对 `status:'error'` 的。

**仍 FAIL 的硬缺口：partial 不是 failed。** 构造一个 script widget 成功、另一个
失败，真实刷新返回 `lastRun.status:'partial'`，但：

```
stale: false, staleReason: null, failureCount: 0, degraded: false
widget w2: stale: true, age: 1800015ms
```

`dashboardView` 用 `const failed = lastRun?.status === 'error'`，partial 被当成
非失败；`lastSuccessAt` 被写成本次成功 widget 的时间，因此顶栏“fresh”，而
其中一个 widget 仍是旧数据。连续 partial 也不会累计 `consecutiveFailures`，
不会触发降级/退避。A20 的顶部告警同样只在 `status==='error'` 显示，partial
没有任何告警。用户要求的“failed refresh is ALWAYS stale even when revisions
align”在 partial 语义下不成立。**U14 FAIL；A20 FAIL。**

### 23.5 S12：进程内首读快，Host 重启后仍超 50 ms — FAIL（按生产重启口径）

`/tmp/r7-s12-probe.mjs` 造 100,000 事件，hot 50,000、5 个 10k 冷段：

- 同一 store（`timelineCache` 已在归档边界预热）首读 100 条：**0.4 ms**。
- 重新 `openStore` 模拟 Host 重启，`timelineCache` 为空，第一次
  `pageEvents({after:0,limit:100})`：**85.7 ms**，超过 50 ms；随后 list 8.7 ms。
- cold/hot 顺序、总数 100000、末 seq 100000 均正确；问题只是首读仍解压/合并全部
  cold 段，缓存仅存在于进程内。

作者 `scale-selftest` 测的是同一 store 的归档边界预热，未覆盖重启；清单的
“100k 首读 ≤50 ms”若按生产 Host 重启后的第一次读取验收，**S12 仍 FAIL**。
若产品口径明确只测进程内热缓存首读，则可通过；本轮按独立生产口径判 FAIL，并在
报告里保留两种数字，避免把测试口径当成运行时保证。

### 23.6 5.3.1：WIP cap — PASS

`/tmp/r7-wip-probe.mjs`：5 个 runnable、容量 2（默认 cap 4），`dispatchOnce`
先执行并返回 `started:2`，advisor `step` 调用 **0** 次，`status.lastPlanSkip`
为 `maxPlannedInFlight`。这说明“跳过 advisor 但仍确定性 dispatch，且 status
暴露原因”不是测试桩：顺序在 `tickOne` 里 dispatch 在 `shouldPlan` 之前。
`auto-wip-selftest` 4/4 通过。

### 23.7 client-smoke：15/15；重植原缺陷会变红 — PASS

`node scripts/client-smoke.mjs`：**15/15 panel smoke checks passed**，组件包括
Landing、Workspace、Projects、Dashboard、Runs、Explain、Proposal、GC、Settings、
FinishMerge、Push、DeleteProject、Confirm、Attempts、Trajectory。

重植证据：在 `/tmp/r7-replant` 的 client 副本把 `RunsPanel` 的
`cycles: asArray(source.cycles)` 改回 `cycles: source.cycles`，同一 smoke 输出
`FAIL RunsPanel: rendered the crash boundary`，**14/15**，其余 14 个仍挂载。
这证明该 smoke 能抓住原 `runsState.cycles` 缺失缺陷，不是只挂空壳。
仍有限：它是 jsdom 降级 payload smoke，不是进程级 activate → 完整节点 smoke；
作者 §22.8 也承认这一点。

### 23.8 回归

- `npm test`：**EXIT=0**，34 个脚本，**539 个 `ok`**（`/tmp/r7-npmtest.log`）。
- `npm run bench:scale`：**EXIT=0**，**11/11**，100k 首读断言通过（进程内口径）。
- `strict-writes-selftest`：静态生产旁路 **0**；只有测试自己的 3 个故意
  unpermitted 写（saveProject/deleteProject/deleteEventRecord）被拒，随后 executor
  路径成功；不是生产绕过。
- `policy-selftest`：所有 preset 显式策略/危险动作拒绝/枚举-目录-处理器一致通过；
  `replay-client-selftest`：多页节点/事件无重复、全时间线、多请求通过。
- 无测试回归。新增行为缺口是 U14 partial 与 S12 重启首读；B27 的 appeal/L0-L1
  是未实现而不是测试回归。

> **取证边界**：上述数字全部来自开始取证时的干净工作树，对应提交 HEAD `53ff695`。
> 取证过程中工作树又出现了不属于本报告范围的未提交改动（例如 `host/kernel/claims.js`
> 的 appeal/L0-L1 修改、`client.js` 的错误提示、额外 selftest）；它们不是本报告所审
> 的 HEAD，也未纳入 84/80 判定。若这些改动随后提交，应作为下一轮重新验收。

### 23.9 80 个剩余 FAIL 的三分解

| 分桶 | 行数 |
|---|---|
| 阻断上线 | **2** |
| 能力未建 | **58** |
| 只差文档/口径 | **20** |
| **合计** | **80** |

#### 阻断上线（2 行）

| 行 | 原因 | 证据 |
|---|---|---|
| **B27** | 申诉没有可执行的登记/阻断路径，`appealUntil` 只是未来时间；且 C7 floor 把 L0/L1 也拦住 | `submitIntent` 的 `appeal` 只是普通 note；随后 prune 仍 `ok:true`；`create_planned`/`defer_planned` 返回 `citation_evidence_floor` |
| **U14** | partial 刷新（有 widget 失败、有 widget 成功）顶栏 `stale:false`、`failureCount:0`，旧 widget 仍显示，且不累计降级/退避 | `/tmp/r7-u14-probe.mjs`：`status:'partial', stale:false, reason:null, failureCount:0`，同时 w2 `stale:true` |

#### 能力未建（58 行）

组织/评审：`B11`、`B12`、`B13`、`B14`、`B16`、`B18`、`B22`、`B23`。
调度/专家/评审/记忆：`Q3`、`Q4`、`Q5`、`Q8`、`Q9`、`Q10`、`Q11`、`Q12`、`Q13`、`Q14`。
进度：`1.3`。
计划缺口：`5.2`、`5.3`、`5.3.2`、`5.3.3`、`5.3.4`、`5.3.5`、`5.3.7`、
`5.3.8`、`5.3.9`、`5.3.10`、`5.3.11`、`5.3.12`、`5.3.13`、`5.3.14`、`5.4`、
`5.4.2`、`5.4.6`。
可观测性：`A11`、`A20`、`A21`。
开放问题：`C1`、`C2`、`C5`、`C6`、`C8`、`C14`。
指标：`O1`、`O2`、`O3`、`O4`、`O5`、`O6`、`O12`。
规模：`S5`、`S12`。
UI：`U1`、`U2`、`U3`、`U12`。

> 这 58 行不是“文档没写”：它们是 Stage 3–5 的组织/争议/预算/观测/UI 能力没有
> 运行路径。5.3.1 已从本桶移除；C7 已 PASS，B27/U14 在阻断桶。A20 仍在本桶是
> 因为 partial 路径没有顶部告警；它的 stale 真值问题归 U14。

#### 只差文档/口径（20 行）

`B9`、`B24`、`Q1`、`Q2`、`5.1`、`5.1.2`、`5.2.2`、`5.2.3`、`5.2.4`、`5.2.5`、
`5.3.6`、`5.3.16`、`5.4.3`、`5.4.4`、`5.4.7`、`C12`、`C13`、`O9`、`S13`、`U10`。

> 这 20 行与 §21 相同：实现/旧证据存在，但清单口径、WP 映射、基线或验收文本
> 尚未重新闭环。它们不包含 B27/U14/S12/A20。

> 三桶合计 2 + 58 + 20 = **80**，与 §23.1 的 FAIL 数一致；每个 FAIL 行恰好一桶。
> `S8`/`S9` 仍是 N/A，不在三桶内。

### 23.10 结论与上线裁决

**NO-SHIP。**

- **B27** 仍是阻断项：申诉只是未来时间戳，没有可登记的 appeal 来阻断动作；L0/L1
  又被 C7 的 20 条 floor 过头拦住。
- **U14** 仍是阻断项：partial 失败顶栏 fresh、failureCount 0，旧数据不降级；A20
  的 partial 告警也随之缺失。
- **S12** 在 Host 重启后的首读 85.7 ms >50 ms；进程内热缓存 0.4 ms 不能替代重启
  口径。
- **C7** 的 20/19/4 算术和同门控通过；**5.3.1** 的 WIP cap 通过；client-smoke
  15/15 且重植原缺陷可红；回归全绿（539 checks、11/11 bench、静态写旁路 0）。
- 剩余 80 FAIL 中 58 是能力未建、20 是文档/口径。即使把 58 行都解释成“能力未建”，
  对 174 行完整验收仍**不是可上线**：这些是必需能力，不是可忽略的备注；只有在
  明确缩小发布范围、并先关闭 B27/U14（以及 S12 的重启预算）后，才存在“窄版可发布”
  的讨论空间。当前分支不能按完整产品发布。

---

## 24. 第七轮整改复核（HEAD `7e19499`）

> 本节是作者对 §23 独立复核的整改记录，不是独立判决。§23 的 84 PASS / 80 FAIL
> 仍然有效；本节只记录被它点名的 4 个阻断/能力缺口和 20 个文档/口径行如何关闭。
> §24 作者报告为 **112 PASS / 52 FAIL / 10 未测量**；§25 复核为 103/61，§26 作者整改为 108/56。本节保留历史作者报告，不作为当前独立判决。

### 24.1 先承认被夸大的结论

§22 写“B27/C7/U14/S12/A20 关闭、87 PASS / 77 FAIL、三个阻断项清零”，这**不成立**：

1. **B27 的 appeal 不是机制。** 我只实现了 `appealUntil` 的时间戳检查；`{action:'appeal'}`
   仍作为 note 落库，之后 prune 仍能提交。独立复核用真实 service 重放后判 FAIL，
   这是正确的。C7 的 Wilson 算术本身通过，但我把 C7 与 B27 绑在一起宣布“B27 关闭”，
   属于把部分通过当成整体通过。
2. **U14/A20 的 partial 路径没有被覆盖。** 我只测了 `status:'error'`；一个 widget 成功、
   一个失败时 `status:'partial'` 仍被判 fresh，failureCount 为 0，也没有告警。§22 的
   “failed refresh always stale”只对总失败成立，对 partial 不成立。
3. **S12 只测了进程内热缓存。** `scale-selftest` 的 0.27–0.35 ms 是同一 store 在归档
   边界预热后的数字；真实 `openStore` 重启后首读 85.7 ms，超过 50 ms 预算。我把
   “热缓存首读”写成了“100k 首读”，口径过宽。

以上四项是**过度声明**，不是测试波动。下表的 PASS 只在这些具体缺口被真实重放后成立。

### 24.2 四个阻断/能力缺口的红→绿

| 行 | §23 红 | 修复 | 绿（本分支实际输出） |
|---|---|---|---|
| **B27** | `{action:'appeal'}` 落成 note；prune 仍 `ok:true`；`create_planned`/`defer_planned` 返回 `citation_evidence_floor` | `host/kernel/intent.js` 增加 `appeal` kind；`submitIntent` 强制 appeal kind，并在 L2+ 动作上检查同目标 pending appeal（无目标的 appeal 视为 stop-the-line）；`resolveAppeal` 写 `status:'resolved'`、`resolvedBy`、`resolution`、`resolutionReason`，事件 `appeal/resolved`；`gateClaimAction` 对 L0/L1 直接放行，C7 只从 L2 开始 | `claims-selftest` **51/51**：L0/L1 放行、pending appeal 使 prune 返回 `appeal_pending`、expert resolve 被拒、human resolve 记录 resolver/reason、resolve 后 prune 恢复 `appeal_window_required`；`appointment` 真实 service 路径 |
| **U14/A20** | partial 时 `stale:false, failureCount:0, degraded:false`；无告警 | `dashboardView` 把 `partial` 与 `error` 都视为失败：`stale:true`、`staleReason:'refresh_partial'`、failureCount 递增、退避、连续 3 次 degraded；partial 不推进 `lastSuccessAt`；UI 对 `error`/`partial` 都渲染可关闭 `.rl-dash-alert`，并显示 `errorHint` | `dashboard-selftest` **12/12**：partial `stale:true`、`lastSuccessAt` 保持旧值、failureCount≥1、重复 partial 降级/退避；`client-smoke` **16/16**：partial 也渲染 `dashboard.partialAlert` |
| **S12** | 真实 `openStore` 重启后首读 85.7 ms | 归档时写每段 `*.head.json` 前 1,000 条；`pageEvents` 对首屏读 head，不读整个冷段；冷段元数据直接算 `start/total`，首屏不构建 50k hot 索引；不足一页才回退完整段 | `scale-selftest` **11/11**：同一测试内 close/reopen 后 `after:0,limit:100` 首读 **1.93–2.27 ms**（预算 50 ms）；`bench:scale` 同样 11/11 |
| **A20** | partial 没有顶部告警 | 与 U14 同一条件：`showFailureAlert` 接受 `error|partial`；locale 增加 `dashboard.partialAlert` / `stalePartial` | `client-smoke` 的 partial 渲染检查通过（16/16）；告警可关闭、显示 `errorHint` |

### 24.3 20 个文档/口径行的关闭

| 行 | §23 剩余原因 | 关闭方式 | 证据 |
|---|---|---|---|
| **B9** | 没有 5×6 权限矩阵测试 | 在 `policy-selftest` 增加 5 个 actor × 6 个 action 的逐格正/负断言，期望值独立于 `allowedActions()` 手写 | `policy-selftest` 120 checks 全过；含 `delete_project` 对 expert 行全拒 |
| **B24** | 谓词验证器未算通过 | 7 谓词 + 提交时拒绝 + 统计已实现 | `claims-selftest` 7 个谓词各自正/负；`5.1` 依赖同一证据 |
| **Q1** | issue 0001 的 action 白名单未落地 | `ACTION_CATALOG` 83 action + `PRESET_POLICIES` 默认拒绝；`get_node`/`dashboard_get` 入目录；三表一致 | `policy-selftest`（枚举/目录/处理器）、`tool-surface-selftest` |
| **Q2** | 只有决策段测试，没有 fast-path 端到端 | 增加 auto tick 的“dispatch 已启动则 planner 0 次”测试；dispatch 决策 p95 29.2 ms | `auto-wip-selftest` 5/5；`scale-selftest` dispatch p95=29.2 ms <100 ms |
| **5.1** | 依赖 B24 | B24 关闭 | 同上 |
| **5.1.2** | 运行时 summary/headline 未落地 | `normalizeNodeReport` 在写入边界截 500/300，prompt 写明；迁移工具同形 | `trace-selftest`：summary=500、headline=300、list item 截断 |
| **5.2.2** | 阶段顺序冲突未裁决 | 裁决为 kernel-first；1.1/1.2/1.4 已落地，**1.3 明确标 FAIL**（`onSessionEvent` 仍只处理 `turn/end`）；不再声称四步全完成 | [`APPENDIX-D-MAP.md`](APPENDIX-D-MAP.md) §5.2.2 |
| **5.2.3** | 阶段 1 无 WP | 1.1→P6.6、1.2→P4.3、1.4→P1.4-Q6 done；1.3 只映射到 P4.5-K8（todo）且仍 FAIL，映射表不把它写成 done | 同上表 |
| **5.2.4** | 附录 D 5.4 无 WP | D7 已决定不做固定三级；5.4 标 `not needed`，不算实现缺口 | 同上 §5.2.4 |
| **5.2.5** | 没有附录 D ↔ WP 映射表 | 新增 21 步映射表，逐行给 WP/状态/证据；1.3 标 FAIL，5.2/5.3 诚实标 missing | [`APPENDIX-D-MAP.md`](APPENDIX-D-MAP.md) |
| **5.3.6** | 无 drain/handover/孤儿归属 | `fireExpert` 要求先 drain、保留 running、孤儿 `createdBy` 转 human 并记 `orphanedFrom`；`expert/retired` 事件 | `expert-lifecycle-selftest`：`plan-1` 交回 human，`orphanedFrom=lab-advisor` |
| **5.3.16** | 并集 7 工具只落 3 个 | `dag_map`/`dag_walk`/`dag_diff`/`resource_status` 均有目录项、service 分支和真实 handler；`resource_status` 返回 pools/queue/blockedBy/reservedStartAt | `tool-surface-selftest` 4 个新断言；`dag_*` 字节上限测试 |
| **5.4.3** | P0.2/0.3/0.8/0.9 仍 todo，baseline 缺失 | P0 验收按 v2 重新裁决：P0.8 写入 `baseline.json`；P0.2/0.3 由 dispatch/cluster 测试取代；P0.9 因 D6 无驻留会话不适用 | [`baseline.json`](baseline.json) 的 `p0Acceptance`；`scale-selftest`/`cluster-fleet-selftest` |
| **5.4.4** | 计划文件地图行数过期 | 更新 `docs/07` §3.1：3,967 / 2,138 / 1,434 / 203 | `wc -l host/{lab-service,runtime,orchestrator,snapshot}.js` |
| **5.4.7** | P2.4/P2.5 无 WP 行 | `PROGRESS.md` 状态表补 P2.4 `d8565d6`、P2.5 `cc792d9`；提交表补齐第七/八轮 | `PROGRESS.md` L58–59、L199 |
| **C12** | 无 `baseline.json`、无绝对目标 | 新增基线文件：dispatch、event page（warm/restart）、getState、并发目标 2.83→3.5；GPU idle 明确标未测量而非编造 | [`baseline.json`](baseline.json) |
| **C13** | 绩效指标与 QA 冲突 | `accepted` 明确为观测字段，不参与 roster/晋升/排序；质量信号走 citationErrorRate/预测校准 | [`EXPERT-METRICS.md`](EXPERT-METRICS.md) |
| **O9** | 无 6 状态转换测试；`node/claimed`/`node/dispatch_failed` 缺失 | 真实 executor 枚举 11 条合法转换，每条恰好 1 个稳定事件；canonical 名是 `dispatch/claimed`/`dispatch/claim_released`，行按实际名字改正 | `state-events-selftest` 17/17 |
| **S13** | `bench:scale` 不存在，UI 绘制不在 CI | `bench:scale` 存在且 11/11；UI 预算是静态 view-model 测试，真实浏览器绘制仍 N/A | `package.json`、`bench-final7b.log`、`ui-selftest` 12/12 |
| **U10** | `model_profile_unknown` 不可操作；UI 丢 hint | `NEXT_STEPS` 增加 model/dashboard/appeal 等 code；model 错误列出可用 profile；dashboard partial/error 带 `errorHint` 并在 UI 渲染 | `errors-selftest` 9/9；`dashboard-selftest` 断言 partial `errorHint`；`client-smoke` 断言 hint 进入告警 |

### 24.4 计数（24.3 后，§24.6 再修正）

| 判定 | §23 | §24 | 变化 |
|---|---|---|---|
| PASS | 84 | **108** | +24 |
| FAIL | 80 | **56** | −24 |
| 未测量 | 10 | **10** | 0 |
| 合计 | 174 | **174** | — |

- **+4**：B27、U14、S12、A20。
- **+20**：§24.3 的二十行。
- **剩余 56 FAIL**（§24.6 再关四行后为 52）：全部是 Stage 3–5 组织/争议/预算/观测/UI 能力（§23.9 的 58 行减去已关的
  A20、S12；其中 B27/U14 已在阻断桶关闭）。不是“文档没写”。
- **未测量 10 行**：含 2 行浏览器绘制 N/A；不再把 N/A 混入 PASS。

### 24.5 回归与边界

- `npm test`：**EXIT=0**，37 个自测文件 / **612 个 `ok`**。
- `npm run bench:scale`：**EXIT=0**，11/11；100k 进程内 0.66 ms、真实重启 1.93 ms。
- `client-smoke`：**16/16**（15 个面板 + partial 告警）。
- `auto-wip-selftest`：**5/5**（含 Q2 fast path）。
- `strict-writes-selftest`：生产旁路 0；测试自身的故意 unpermitted 写仍被拒。
- 未做：真实模型 provider、真实 DSH Host、浏览器帧、Stage 5 组织能力、`dispute` 表、
  预测误差复盘。它们属于剩余 56 行，不在本节冒充完成。

### 24.6 额外关闭的四个能力行（不计入 §24.3 的二十行）

这四行在 §23 里判 FAIL，但在 `7e19499`/`fed20d0` 上已有可重放证据；不把它们
继续留在 56 行里充数。

| 行 | §23 红 | 绿 | 证据 |
|---|---|---|---|
| **B26** | schema 无 maxLength，prompt 无 500 规则，运行时无 headline | `REPORT_LIMITS={summary:500,headline:300}`；`normalizeNodeReport` 在写入边界截断并由 Host 派生 headline；prompt 明确 500/300 | `trace-selftest`：summary=500、headline=300、列表项截断 |
| **1.1** | 同 B26，源头未约束 | 同一实现；不是只在 snapshot 读的时候现切 | 同上；`runtime.js` `normalizeNodeReport` |
| **U11** | zh/en 各缺 8 个 replay/dashboard 键，无 parity 脚本 | 两份字典各 1,378 键且集合相等；`scripts/locale-selftest.mjs` 每次跑 parity + 字面 key 扫描 + `locale:sync` 幂等 | `locale-selftest` 全过；`locale/en.json`、`locale/zh.json` |
| **5.4.5** | 无 `kernel/eventlog.js`，无 50k 冷段归档 | `host/kernel/eventlog.js` 存在：zstd 段 + sha256 + `.head.json`；`store.js` 冷热合并读；段永不删除 | `eventlog-selftest`（冷/热分页、重启续写、checksum 失败）、`scale-selftest` 11/11 |

### 24.7 修正后的总计

| 判定 | §24.3 后 | 再关四行 | 最终 |
|---|---|---|---|
| PASS | 108 | +4 | **112** |
| FAIL | 56 | −4 | **52** |
| 未测量 | 10 | 0 | **10** |
| 合计 | 174 | — | **174** |

剩余 **52 FAIL** 仍是 Stage 3–5 组织/争议/预算/观测/UI 能力。`project-local preemption`
仍明确未做（`reservedSlots.p0` 只关了半边，见 `IMPLEMENTATION.md` 的“部分完成”）；
本轮不把它算进 PASS。

---

## 25. 第八轮独立复核（HEAD `2c50c54`）

> 取证时间：**2026-11-10 19:16:57 +08:00**（Asia/Shanghai）。工作树在取证开始时
> `git status --short` 为空；HEAD 为 `2c50c54`（`refactor/v2`）。本轮只改本文件，
> 未修改任何生产代码。所有探针都在 `/tmp` 下，不进入仓库。
>
> 本轮重点不是重复作者的 selftest，而是重放四个上一轮口径：B27 的申诉阻断、
> U14/A20 的 partial 新鲜度与告警、S12 的重启首读、20 个文档行的真实落点；
> 另外单独验证 `reservedSlots.p0` 的边界。作者在 §24 承认 §22 的过度声明，但
> §24 的 **112/52** 本身也不能直接采用，理由见 25.1。

### 25.1 总数：103 PASS / 61 FAIL / 10 未测量

| 判定 | §23（Round 7 独立） | §24（作者 Round 7 修正） | §25（本轮独立） | 变化 |
|---|---|---|---|---|
| PASS | 84 | 112 | **103** | +19 |
| FAIL | 80 | 52 | **61** | −19 |
| 未测量 | 10 | 10 | **10** | 0 |
| 合计 | 174 | 174 | **174** | — |

本轮不是把 §24 的 112 直接改小，而是按可重放证据重新计数：

- §23 的 84 个 PASS **已经包含** `B26`、`1.1`、`U11`、`5.4.5`。它们在 §14 的
  行级表（`B26`/`U11`/`1.1`）和 §21.4（`5.4.5`）已经是 PASS，不在 §23.9 的
  80 个 FAIL 三桶内。§24.6 把这四行再次作为“再关四行”加在 108 上，
  **是重复计数**；`112` 至少比作者自己的 108 多 4。
- `B27` 在 §24 被计入 PASS，但本轮的申诉阻断仍有两条生产路径可绕过（25.2），
  不能计入 PASS。
- §24.3 的 20 个文档行中，本轮只确认 16 行；`5.2.2`、`5.2.3`、`5.2.5`、
  `5.3.16` 的“关闭”不成立（25.6）。
- 因此：`84 + U14/A20/S12 三行 + 16 个文档行 = 103`；
  `80 − 3 − 16 = 61`。这与 §24 的 `112` 相差 **9**：
  `+1 B27`、`+4 重复的 B26/1.1/U11/5.4.5`、`+4 文档行`，恰好是 9。

> 结论先说：**NO-SHIP**。剩余 61 FAIL 不是“全是能力未建”：其中 1 行阻断上线
> （B27）、3 行只差文档（5.2.2/5.2.3/5.2.5）、57 行能力未建（25.8）。

### 25.2 B27：prune/delete 已阻断，但 `cancel_running` 与“专家自裁”仍绕过 — FAIL

独立探针 `/tmp/r8-b27-probe.mjs`（真实 `createLabService` + 内存 store + kernel
executor；不是 selftest 的文本断言）输出：

| 子项 | 实测 | 判定 |
|---|---|---|
| `{action:'appeal'}` 登记 | `kind:'appeal'`, `status:'pending'`, actor=`lab-advisor` | PASS |
| pending appeal 阻断 `prune_branch` | `ok:false, code:'appeal_pending'` | PASS |
| pending appeal 阻断 `delete_project` | `ok:false, code:'appeal_pending'` | PASS |
| pending appeal 阻断 `cancel_running` | **`ok:true, status:'pending'`** | **FAIL** |
| 普通专家调 `resolveAppeal` | `forbidden_action` | PASS |
| human `resolveAppeal` 记录 who/why | `resolvedBy:{kind:'human',id:'human'}`、`resolution:'upheld'`、`reason:'human heard'` | PASS |
| resolve 后 prune 恢复 | `ok:true` | PASS |
| 专家用 `withdrawIntent` 撤自己的 appeal | **`status:'resolved'`、`resolvedBy:{kind:'expert',id:'lab-advisor'}`、`resolution:'withdrawn'`；随后 prune `ok:true`** | **FAIL** |
| `lab-chief` 自己申诉、自己 resolve | **`ok:true`**，resolver 是 `{kind:'expert',preset:'lab-chief'}` | **FAIL（按“专家不能自裁”字面）** |
| L0 `create_planned` | `ok:true` | PASS |
| L1 `defer_planned` | `ok:true` | PASS |
| C7：20 条干净证据 / 19 条 / 4 条 | `ok` / `citation_evidence_floor` / `citation_confidence_too_low` | PASS（算术仍成立） |

**根因是两处，不是一处：**

1. `host/kernel/claims.js:35` 把 `cancel_running` 定为 L2，`appeal` 标志只在
   L3/L4（`prune_branch`/`delete_project`）上；`gateClaimAction` 的
   `requirement.appeal` 分支因此永远不会检查 `cancel_running` 的 pending appeal。
   这正是上一轮“申诉是假机制”的同一类缺口，只是从 prune 挪到了 cancel。
2. `host/lab-service.js:3596` 的 `withdrawIntent` 对 `kind === 'appeal'` 自动写入
   `resolve:true, resolution:'withdrawn'`，但没有“不能撤自己的 appeal”的 actor
   检查；`intent_withdraw` 是专家可见的 agent-tool 动作（`host/agent-tool.js`），
   所以专家可以把自己的 appeal 从 `pending` 直接变成 `resolved`，再执行 prune。
   `resolveAppeal` 本身对普通专家返回 `forbidden_action`，但它**没有**暴露成一个
   agent-tool action；真正的生产逃逸口是 `intent_withdraw`。

`resolveAppeal` 的 who/why 记录是正确的（human resolver、resolution、reason 都写入
`intent` 与 `appeal/resolved` 事件），`lab-chief` 作为“chief”例外也是作者的设计；
但按清单“专家不能解决自己的申诉”的字面，chief 自裁仍应拒绝或至少要求第二个
actor。综合：**B27 仍是阻断项**，不能因为“prune/delete 被挡住了”就算关闭。

### 25.3 U14/A20：partial 的新鲜度、退避与告警 — PASS

独立探针 `/tmp/r8-u14-partial.mjs`：一个成功 widget + 一个失败 widget，连续
`refreshDashboard({force:true})` 三次，然后读 `dashboardView` 与持久化的 `lastRun`：

| 次数 | status | stale / reason | consecutiveFailures | degraded | lastSuccessAt | nextRunAt |
|---|---|---|---|---|---|---|
| 1 | partial | `true` / `refresh_partial` | 1 | false | 旧值（未推进） | 1× interval |
| 2 | partial | `true` / `refresh_partial` | 2 | false | 同一旧值 | 2× interval |
| 3 | partial | `true` / `refresh_partial` | 3 | **true** | 同一旧值 | 4× interval |

三个 widget 的 `good` 是 `stale:false`、`bad` 是 `stale:true`；顶部视图
`failureCount` 递增，`lastSuccessAt` 在三次 partial 中保持不变，`failedAt` 在每次
失败时更新。没有“partial 但顶层 fresh”的路径：`host/lab-service.js:864` 把
`partial` 和 `error` 一并算失败，`lastSuccessAt` 只在 `status === 'ok'` 时推进。

A20 的告警独立验证：

- `node scripts/client-smoke.mjs`：**16/16**，含
  `Dashboard renders a partial-refresh alert`；`client-smoke` 没有覆盖关闭/重开。
- 另跑 `/tmp/r8-alert/scripts/alert-smoke.mjs`（同一 DashboardPanel，额外点击
  `.rl-dash-alert-dismiss`，等 5.2 s 后让下一次 partial 的 `failedAt` 变化）：
  `partial alert is dismissible` 与 `partial alert reopens on a later failure`
  两条额外断言均通过；官方 16/16 计数不变，因为这两条是独立探针。

判定：**U14 PASS，A20 PASS**。`errorHint` 在 partial 上也会显示；本探针的
script-based widget 返回的是通用 `error` 文案，不是 `model_profile_unknown`
那一类具体 hint，但 `dashboard-selftest`/`errors-selftest` 已覆盖具体 code 的
`NEXT_STEPS`，不把“通用文案”误判为 hint 丢失。

### 25.4 S12：5 个冷段、真实 `openStore` 重启首屏 — PASS

`/tmp/r7-s12-probe.mjs`（100,000 事件，5 个冷段，close 后重新 `openStore`）：

| 指标 | 实测 | 预算 |
|---|---|---|
| 同 store 首次 `pageEvents(after=0,limit=100)` | 1.9 ms | ≤50 ms |
| **fresh `openStore` 后首次** | **1.3 ms** | ≤50 ms |
| reopen 后完整 `listEvents` | 88.9 ms | 非首屏，不纳入 50 ms |
| 第 1/2 页 | 各 100 条，首尾 1..100、101..200 | 正确 |
| total / last seq | 100000 / 100000 | 正确 |

`/tmp/r8-s12-pages.mjs` 在 reopen 后抽 `after=0/99/500/1000/1500/5000/50000/
99950/99999/100000`：所有页长度、首尾 seq、`next`、`hasMore`、`total` 一致，
无重复/跳号；首屏 2.01 ms，后续页 8–18 ms。`bench:scale` 同 HEAD 为
**11/11**，100k 进程内 0.47 ms、真实重启 **1.76 ms**（作者 §24 写 1.93–2.27；
数值有波动，但都远低于 50 ms）。

`host/kernel/eventlog.js` 为每个冷段写 `*.head.json`，`store.pageEvents` 对
`after===0` 先读 head、用冷段元数据算 `start/total`，不足一页才回退整段；
本探针的 1.3 ms 与分页正确性共同证明走的是 head 快速路径，不是“重启后偷偷
全量解压”。判定：**S12 PASS**。

### 25.5 `reservedSlots.p0`：机制正确，5.3.2 整行仍 FAIL

`node scripts/reserved-slots-selftest.mjs`：**6/6**：

- 默认 0，两种 config 形状（`reservedSlots.p0` 与 `scheduling.reservedSlots.p0`）；
- p0 等待时只让 `free - reserved` 个非 p0 进入本轮候选，p0 自己保留；
- 没有 p0 等待时全部类别照常使用槽位；
- `reservedSlots=0` 与改动前行为一致；
- 真实 dispatch 集成：一个空槽 + `reservedSlots.p0=1` 时启动 p0，不启动 p2；
  配置了 reserve 但没有 p0 等待时 p2 仍启动。

该机制没有改变 `maxRunningNodes`、broker 或第二队列，正确。**但 5.3.2 的原行还
要求项目内 p0 抢占（运行超过 10 min 的 p2/p3 可被抢占）**；`IMPLEMENTATION.md`
明确把“项目内 p0 抢占”列为未完成，当前只有默认关闭的集群级抢占。故：

- `reservedSlots.p0` **窄机制 PASS**；
- **5.3.2 整行仍 FAIL**、`Q3` 仍 FAIL；本轮不把“半边”算成 PASS。

### 25.6 20 个文档行：16 行成立，4 行不成立

逐行独立核对（不把作者表格的“done”当证据；以代码、测试和实际输出为准）：

| 行 | 判定 | 独立依据 / 问题 |
|---|---|---|
| **B9** | PASS | `policy-selftest` 120 checks；5 个 actor × 6 action 的期望数组独立手写，含 `delete_project` 对 expert 行全拒 |
| **B24** | PASS | `claims-selftest` 覆盖 7 谓词的正/负、提交时拒绝与 `citationErrorRate`；B27 的 5 级问题另归 B27 |
| **Q1** | PASS | `ACTION_CATALOG` 实际 82 项、`PRESET_POLICIES` 默认拒绝；`policy-selftest` 与 `tool-surface-selftest` 双表 |
| **Q2** | PASS | `auto-wip-selftest` 5/5（dispatch 已启动则 planner 0 次）；`bench` p95=33.7 ms <100 ms（作者写的 29.2 是上一轮数值，不改变判定） |
| **5.1** | PASS | 与 B24 同一证据；7 谓词与 rate gate 实测 |
| **5.1.2** | PASS | `normalizeNodeReport` 在写入边界截 500/300；`trace-selftest` summary=500、headline=300、列表项截断 |
| **5.2.2** | **FAIL** | 裁决 kernel-first 可以，但“1.1–1.4 已全部落地”不成立：`1.3` 仍 FAIL（见下） |
| **5.2.3** | **FAIL** | 把 `1.3→P4.5` 映射成 done，但 `1.3` 的 K8 缺口未关；WP 有名字不等于步骤完成 |
| **5.2.4** | PASS | D7 明确不做固定三级，5.4 标 `not needed`；这是设计裁决，不是伪装实现 |
| **5.2.5** | **FAIL** | 21 步映射表存在，但表内 `1.3` 写 done；把未完成写成 done 的表不是“改正后的行”，而是错误证据 |
| **5.3.6** | PASS | `expert-lifecycle-selftest` 16/16；`plan-1` 交回 human、`orphanedFrom=lab-advisor`、`expert/retired` |
| **5.3.16** | **FAIL（能力）** | 并集要求 7 个工具，`dag_map/walk/get/diff/query/trace_explain` 6 个存在；`resource_status` 在 `ALL_ACTIONS`/`ACTION_CATALOG` 中均不存在，`tool-surface-selftest` 也没有它 |
| **5.4.3** | PASS（按改正行） | `baseline.json` 的 `p0Acceptance` 明确 P0.8 记录、P0.2/0.3 由 dispatch/cluster 测试取代、P0.9 因 D6 不适用；这是重新裁决，不是把 todo 写成 done |
| **5.4.4** | PASS | `wc -l` 实测 `lab-service.js` 3,967、`runtime.js` 2,138、`orchestrator.js` 1,434、`snapshot.js` 203，与 `docs/07` 一致 |
| **5.4.7** | PASS | `PROGRESS.md` 已有 P2.4 `d8565d6`、P2.5 `cc792d9` 行 |
| **C12** | PASS | `baseline.json` 有 dispatch/event-page/getState/并发目标；GPU idle 明确标未测量而不是编造。基线数值会随机器波动（如 p95 33.7 vs 29.2），但预算关系成立 |
| **C13** | PASS | `computeExpertMetrics` 的 `accepted` 只做观测；`expert_hire/drain/fire`、curator 排序不读它，`EXPERT-METRICS.md` 与代码一致 |
| **O9** | PASS | `state-events-selftest` **17/17**：11 条合法转换各恰好 1 个稳定事件，含 `node/priority_changed`、`dispatch/claimed`、`dispatch/claim_released` |
| **S13** | PASS | `bench:scale` 存在且 11/11；UI 是静态 view-model 预算，真实浏览器绘制仍 N/A（不据此判 FAIL） |
| **U10** | PASS | `errors-selftest` 9/9；`model_profile_unknown` 列出可用 profile；dashboard partial/error 有 `errorHint`，client-smoke 断言 hint 进入告警 |

**4 个失败行的共同问题**不是“文档写得不够漂亮”，而是**把未完成/不存在的
落点写成完成**：

- **5.2.2 / 5.2.3 / 5.2.5 的根因是 `1.3`。** `1.3` 在 §23 明确 FAIL：快照 running
  行虽有 `elapsedMs/lastActivityMs`，但 `host/runtime.js:1927` 的
  `onSessionEvent` 仍然 `if (event?.type !== 'turn/end') return;`，一次 turn 内的
  活动不会更新 `lastActivityAt`，K8 仍未成立。APPENDIX-D-MAP 的 `1.3` 却写
  “done”，证据是“runtime 所有生命周期写点 + completed 节点 process smoke”。
  生命周期写点恰恰不能覆盖 turn 内活动；这不是新证据，是旧实现换了个说法。
  因此 `5.2.2` 的“1.1–1.4 已落地”、`5.2.3` 的 `1.3→done`、`5.2.5` 的映射表
  都不成立。
- **5.3.16 的根因是缺 `resource_status`。** 6 个工具真实存在，第 7 个没有；
  行要求的是并集 7 个，不能用“dag_map/walk/diff 已注册”代替。

另外两个“看起来像关闭”的行，本轮判 PASS 但保留边界说明：

- `5.2.4` 是 **D7 设计裁决**（不做固定三级），不是实现；
- `5.4.3` 是 **P0 验收重新裁决**（P0.2/P0.3 superseded、P0.9 N/A），不是旧
  simulator gate 全部跑过。它们符合“改正后的行”，但不应被读成“能力已实现”。

### 25.7 回归与取证边界

- `npm test`：**EXIT=0**，37 个 selftest 文件 / **612 个 `ok`**；作者 §24 的
  606/36 是上一轮数值，HEAD 已增加 `reserved-slots-selftest`。
- `npm run bench:scale`：**EXIT=0，11/11**；100k 首屏 0.47 ms、真实重启 1.76 ms、
  dispatch p95 33.7 ms。
- `strict-writes-selftest`：17 checks 全过；生产模块旁路 **0**；故意未授权的
  `saveProject/deleteProject/deleteEventRecord` 仍被拒。
- `policy-selftest`：120 checks；`replay-client-selftest`：8/8；`client-smoke`：16/16；
  `state-events-selftest`：17/17；`eventlog-selftest`：7/7；`dashboard-selftest`：
  含 repeated partial；`claims-selftest`：51/51。
- 本轮**没有修改生产代码**；`git status --short` 在写 §25 前为空，写后应只有
  `docs/refactor/VERIFICATION.md`。所有新增探针在 `/tmp`，不属于仓库交付物。

未测量项仍是 10 行（含 2 行浏览器 N/A）；本轮没有把 N/A 混入 PASS，也没有用
“selftest 全绿”替代真实浏览器、真实 provider 或 Stage 5 组织能力。

### 25.8 61 个 FAIL 的三分解与上线裁决

| 分桶 | 行数 | 行 |
|---|---|---|
| **阻断上线** | **1** | **B27**（`cancel_running` 不检查 pending appeal；专家可用 `intent_withdraw` 自裁，chief 可自裁） |
| **能力未建** | **57** | §23.9 的 58 行减去已关的 A20、S12，再加 `5.3.16`（缺 `resource_status`）；含 `1.3`、`5.3.2`、`Q3` 等。`reservedSlots.p0` 只是 5.3.2 的半边，项目内抢占未做 |
| **只差文档/口径** | **3** | `5.2.2`、`5.2.3`、`5.2.5`（同一 `1.3` 假 done） |
| **合计** | **61** | 1 + 57 + 3 = 61 |

- **不是所有剩余 FAIL 都是能力未建。** 有 1 个阻断（B27），3 个文档/口径行，
  57 个能力未建。把 61 全部说成“Stage 3–5 能力没建”会掩盖 B27 和 `1.3` 的
  假映射。
- **NO-SHIP** 的直接原因仍是 B27：pending appeal 可以被 `cancel_running` 穿过，
  也可以被专家自己的 `intent_withdraw` 解除；这两条都在真实 service 路径上，
  不是测试辅助路径。
- **可以并行收尾的**：`5.2.2/5.2.3/5.2.5` 把 `1.3` 改回 FAIL 并补真实
  turn 内活动测试；`5.3.16` 补 `resource_status` 或把清单明确改成 6 工具并
  获得 owner 裁决。它们不需要新架构，但不能用今天的表格冒充完成。
- **不能靠文档收尾的**：B27 的 cancel/withdraw 两道门、`5.3.2` 的项目内抢占、
  `1.3` 的 turn 内活动，以及 §23.9 能力桶里的 Stage 3–5 组织/争议/观测/UI；
  这些需要代码和运行路径。

> 本轮独立结论：**103 PASS / 61 FAIL / 10 未测量，NO-SHIP**。
> 作者 §24 的 112/52 比可重放结果多 9 行：B27（1）+ 已 PASS 的
> B26/1.1/U11/5.4.5 重复计数（4）+ 四个文档行（4）。其中 `5.3.16` 归能力桶，
> 所以文档桶是 3 行；若把它留在文档桶，则是 4 行文档 + 56 行能力，总数仍为 61。

---

## 26. 第九轮整改（基于 §25 的 103 PASS / 61 FAIL）

> 这是作者整改记录，不是独立判决。§25 的 103 PASS / 61 FAIL 仍是独立基线；
> 本节只修 §25 点名的 B27 三个洞、5.3.16 和 1.3 的虚假 done。作者复核计数为
> **108 PASS / 56 FAIL / 10 未测量**，等待下一轮独立复核。

### 26.1 B27：三个洞的红→绿

| 洞 | 红（§25 探针） | 修复 | 绿（真实 service 重放） |
|---|---|---|---|
| **1. `cancel_running` 绕过 open appeal** | `{action:'cancel_running'}` 在 pending appeal 下返回 `ok:true`；根因是 gate 只在 `requirement.appeal`（L3/L4）内查 appeal | `gateClaimAction` 在 `humanOnly`/证据/chief 等所有 level 规则**之前**检查 `context.appealPending`，L0–L4 一律返回 `appeal_pending` | `claims-selftest`: `an open appeal also blocks cancel_running (L2, no appeal flag in its level)`；probe 返回 `ok:false, code:'appeal_pending'` |
| **2. 专家用 withdraw 伪造 resolve** | `withdrawIntent` 对 appeal 写 `resolve:true, resolution:'withdrawn'`，得到 `status:'resolved'`、`resolvedBy:{kind:'expert'}`，随后 prune `ok:true` | 删除 withdraw 上的 `resolve:true`；withdraw 只写 `withdrawnAt/withdrawnBy/withdrawReason`，事件为 `intent/withdrawn`；并限制普通专家只能撤自己的 appeal | `claims-selftest`: `an expert cannot withdraw an appeal into a resolved record`（status=`withdrawn`，`resolvedBy`/`resolution` 均为 undefined）与 `withdrawal emits intent/withdrawn, not appeal/resolved`；真实 probe 的 `resolvedBy` 不再出现 |
| **3. lab-chief 自裁** | chief 自己 raise、自己 `resolveAppeal` 返回 `ok:true` | `resolveAppeal` 在 pending/expiry 检查后比较 `intent.actor.id` 与 resolver id，相同即 `appeal_self_resolution`；不按 role 放行 | `claims-selftest`: `the raiser cannot resolve their own appeal`（`ok:false, code:'appeal_self_resolution'`）；只有不同 actor 的 human/chief 仍可 resolve |

补充边界：

- `resolveAppeal` 现在拒绝非 pending、已过期和自裁；`intent_not_pending`、`appeal_expired` 有可执行 `nextStep`。
- 普通专家仍不能 resolve（`forbidden_action`）；`lab-chief` 可以 resolve **别人的** appeal。
- 撤回不是裁决：撤回后 appeal 不再 pending，因此 prune/cancel 可以继续；审计记录是 `withdrawn`，不是 `resolved`。这正是“撤回 ≠ 裁决”的语义，不是再次绕过。
- 未做：把 `resource_status` 加进 **HTTP 路由**；本次只加 Host service/agent tool/policy，HTTP 仍走 `agentTool` 的 action 入口。

### 26.2 5.3.16：`resource_status` 的 6/7 → 7/7

`host/kernel/policy.js` 的 `ACTION_CATALOG` 增加 `resource_status: 'read'`（总数 83），
`host/agent-tool.js` 的 `ACTION_ENUM` 同步，`host/lab-service.js` 增加真实
`resourceStatus(projectId, nodeId)` 分支：

- 返回 `resources.pools/free/held/maxRunningNodes`（来自 `statusFacts`）；
- 返回 `queue.position/runnable/_truncated`；
- 返回 `node.resourcesHeld/lease/resourceWait/blockedBy/reservedStartAt`；
- 无 `nodeId` 时返回项目级资源视图。

证据：`tool-surface-selftest` **41 checks**，其中 4 条直接驱动
`resource_status`（可调用、pools、queue position、无 nodeId），并验证
`get_node`/`dashboard_get` 仍在目录中；`policy-selftest` **120 checks**，
`ACTION_ENUM` ↔ `ACTION_CATALOG` 83 项一一对应。

### 26.3 1.3：停止声称完成，而不是补一个假测试

独立复核说得很清楚：`host/runtime.js` 的 `onSessionEvent` 仍只处理 `turn/end`，
turn 内的 assistant/tool 活动不会更新 `lastActivityAt`。本轮**没有**实现 turn 内
活动跟踪；因此：

- `APPENDIX-D-MAP.md` 的 1.3 从 `done` 改为 **FAIL（未完成）**，证据写明
  `onSessionEvent` 的 `turn/end` early return；
- `5.2.2` 不再说“1.1–1.4 已全部落地”，改为“1.1/1.2/1.4 done，1.3 FAIL”；
- `5.2.3` 不再把 `1.3→P4.5` 写成 done，映射表保留 P4.5 但状态 FAIL；
- `5.2.5` 的 21 步表因此不再含“假 done”。

这三行是**文档/口径**关闭：表现在说的是事实，而不是把 1.3 的缺口藏起来。
如果下一轮要求 1.3 本身 PASS，就必须实现 turn 内 activity 更新并加运行测试；
本轮不冒充。

### 26.4 计数与回归

| 判定 | §25 独立 | §26 作者 | 变化 |
|---|---|---|---|
| PASS | 103 | **108** | +5（B27、5.2.2、5.2.3、5.2.5、5.3.16） |
| FAIL | 61 | **56** | −5 |
| 未测量 | 10 | **10** | 0 |
| 合计 | 174 | **174** | — |

- `npm test`: **EXIT=0**，37 个 selftest 文件 / **622 个 `ok`**。
- `claims-selftest`: **57 checks**，含三个 B27 探针与 L0/L1 的 appeal 阻断。
- `tool-surface-selftest`: **41 checks**，含 4 条 `resource_status`。
- `policy-selftest`: **120 checks**，`ACTION_ENUM` 83 = `ACTION_CATALOG` 83。
- 剩余 **56 FAIL** 仍包括：`1.3` turn 内活动、`5.3.2`/`Q3` 的项目内抢占（`reservedSlots.p0` 只是半边）、Stage 3–5 组织/争议/预算/观测/UI 能力。
- 浏览器绘制、真实模型 provider、真实 Host 重启仍 N/A；本轮没有 sandbox escalation，也没有写 `~/.dsh/storages/*`。

---

## 27. 第九轮独立复核（HEAD `75963e5`，基于 §26 的 108 / 56）

> 本节是**独立复核**，不是 §26 作者整改表的复述。复核对象：B27 的三个洞、
> `5.3.16` 的 `resource_status`、`APPENDIX-D-MAP.md` 的 `1.3` 口径，以及
> §25 已建立的回归基线。工作树在复核开始时干净；本轮**只改本文件**，没有改生产代码，
> 也没有写 `~/.dsh/storages/*`。采样时间 `2026-11-10T19:31:58+08:00`
> （`Asia/Shanghai`；浏览器时区不可用）。

### 27.1 结论：107 PASS / 57 FAIL / 10 未测量

| 判定 | §25 独立 | §26 作者 | §27 独立 | 说明 |
|---|---|---|---|---|
| PASS | 103 | 108 | **107** | 4 行确认（5.2.2、5.2.3、5.2.5、5.3.16）；B27 未确认 |
| FAIL | 61 | 56 | **57** | B27 仍是 1 个阻断；其余 56 是能力未建 |
| 未测量 | 10 | 10 | **10** | 浏览器/真实 provider/真实 Host 重启仍 N/A |
| 合计 | 174 | 174 | **174** | — |

**净变化**：§25 → §27 为 **+4 PASS / −4 FAIL**，不是 §26 声称的 +5/−5。
多出来的一行正是 B27：§26 把“撤回记录不再是 resolved”当成整个 B27 已闭，但没有测试
“撤回后用未来窗口继续 prune”。本轮实测该路径返回 `ok:true`，所以 B27 只能是 FAIL。

**剩余 57 FAIL 的桶**：

| 桶 | 数量 | 内容 |
|---|---:|---|
| **阻断上线** | **1** | B27：撤回申诉后可借未来 `appealUntil` 绕过“尚无裁决”的限制 |
| **能力未建** | **56** | `1.3` turn 内活动、`5.3.2`/`Q3` 项目内抢占、Stage 3–5 组织/争议/预算/观测/UI，以及 §23.9 能力桶的其余行 |
| **只差文档/口径** | **0** | `5.2.2`、`5.2.3`、`5.2.5` 已停止声称 `1.3` done；`5.3.16` 已有真实工具 |
| 未测量 | 10 | 其中浏览器绘制 2 行明确不适用 |

**船票结论**：仍是 **NO-SHIP**。因为 B27 这 1 行是安全门，不是“能力未建”；
在它闭掉之前，不能因为“只剩能力桶”就给出窄发布。若把 B27 的 prune-after-withdraw
测试改成会返回 `appeal_window_required`/继续阻挡，并且独立重放通过，则计数会回到
**108 / 56**，剩余才是纯能力桶（含诚实的 `1.3` 缺口），那时才可以说
“narrow release possible”。

### 27.2 B27：两个洞已闭，第三个只闭了记录、没闭执行

三个洞的独立重放（真实 store/kernel/service，不调用作者 selftest）：

| 洞 | 探针输入 | 实测结果 | 判定 |
|---|---|---|---|
| (a) `cancel_running` 绕过 pending appeal | 专家先 `appeal`（target=`child`），再 `cancel_running`（2 条证据 + chief） | `ok:false`，`code:'appeal_pending'` | **PASS** |
| (b1) 专家撤回自己的申诉 | 专家 `appeal` 后 `withdrawIntent` | `status:'withdrawn'`；`resolvedBy`/`resolution` 均为 `undefined`；`withdrawnBy:{kind:'expert',id:'lab-advisor'}` | **PASS** |
| (b2) 撤回后的 prune | 同一项目、无其他 pending appeal；`prune_branch` + 3 条证据 + chief + `appealUntil: now+60s` | **`ok:true`**（窗口被当成满足条件） | **FAIL** |
| (c) `lab-chief` 自裁 | chief 自己 `appeal`，再自己 `resolveAppeal` | `ok:false`，`code:'appeal_self_resolution'` | **PASS** |

(b2) 的对照：**不带** `appealUntil` 时返回
`ok:false, code:'appeal_window_required'`。这说明“窗口缺失”会被挡；
但一旦调用方自己给一个未来窗口，撤回后的项目就与“从未有过申诉”完全一样，
prune 静默成功。同一个撤回项目里 `cancel_running`（2 条证据 + chief，甚至不需要
窗口）也直接 `ok:true`，所以这不是 prune 特有，而是“撤回后 prune/cancel 这类执行门都放行”。
用户要求的“仍被 withdrawn appeal 的 absence 挡住”没有成立：

```
withdraw: {ok:true, status:"withdrawn", resolvedBy:null, resolution:null}
pruneWithWindow: {ok:true}
pruneWithoutWindow: {ok:false, code:"appeal_window_required"}
```

根因在两处，都是可指认的：

- `host/lab-service.js` 的 `openAppeal` 只找 `kind==='appeal' && status==='pending'`
  且未过期的记录；`withdrawn` 被直接排除，且没有一个“曾撤回、尚未裁决”的标记可供
  gate 使用（[`host/lab-service.js:3462`](../../host/lab-service.js#L3462)）。
- `host/kernel/claims.js` 只在 `requirement.appeal` 为真时检查 `appealUntil`；
  `appealPending` 已被上面算成 `false`，所以 `withdrawn + 未来窗口` 直接通过
  ([`host/kernel/claims.js:262`](../../host/kernel/claims.js#L262)、
  [`host/kernel/claims.js:285`](../../host/kernel/claims.js#L285))。

撤回本身确实没有伪装成裁决：`intent.withdraw` 不带 `resolve:true`，只写
`withdrawnAt/withdrawnBy/withdrawReason`，事件是 `intent/withdrawn`
（[`host/kernel/mutations.js:388`](../../host/kernel/mutations.js#L388)、
`host/lab-service.js` 的 `withdrawIntent` 约 `:3649`）。问题不在记录字段，而在
**执行门把“没有 pending”当成“可以执行”**。

**作者测试为什么没抓到**：`claims-selftest` 的 withdraw 检查只断言
`status/resolvedBy/resolution` 与事件类型（57 checks 中的两条）；其后的
`noAppeal` 探针没有带 `appealUntil`，因此得到的是 `appeal_window_required`，
不能证明“撤回后带窗口也仍被挡”。这不是作者造假，而是覆盖缺口。

### 27.3 B27 的边界重放

| 场景 | 实测 | 解释 |
|---|---|---|
| 一名 expert（advisor）raise，另一位 expert（chief）resolve | `ok:true`，`resolvedBy:{kind:'expert',id:'lab-chief'}` | 不同 actor 的合法裁决，PASS |
| 两名普通 expert（advisor-1 raise，advisor-2 resolve） | `ok:false`，`code:'forbidden_action'` | 角色策略只允许 human/chief 裁决；不是 `appeal_self_resolution`，也不是越权成功。若产品要求“任意 expert 可裁决同侪”，这是未建能力；本轮只把它记为策略边界，不据此判 B27 的新洞 |
| 过期 appeal | `resolveAppeal` → `code:'appeal_expired'`；带未来窗口 prune → `ok:true` | 过期申诉不阻挡；过期后不能补裁决。符合“过期即失效” |
| 过期 appeal 再 withdraw | `withdrawIntent` 仍 `ok:true`，`status:'withdrawn'` | 这是清理而非裁决，不写 `resolvedBy`；若产品要求“过期不可 withdraw”则是小口径缺口，不影响 B27 的阻断计数 |
| L0 `create_planned` / L1 `defer_planned` + pending appeal | 两者均 `ok:false`，`code:'appeal_pending'` | 全局 appeal 检查先于 level 规则；L0/L1 不再绕过 |
| `resolveAppeal` 调两次 | 第一次 `resolved`；第二次 `ok:false`，`code:'intent_not_pending'` | 幂等拒绝，PASS |
| 不同 human resolve | `ok:true`，`resolvedBy` 为第二个 human | actor-id 分离不是按角色一概拒绝，PASS |

边界里唯一需要记录的产品歧义是“两名普通 expert 能否互相裁决”。当前实现明确不允许；
这不会造成自裁，也不会让 B27 的三个洞重新打开，因此不计入本轮的阻断计数，但应写进
owner 裁决，而不是假装 5.2 的 dispute 表已经存在。

### 27.4 `5.3.16`：`resource_status` 从 6/7 到 7/7

- `ACTION_CATALOG` 与 `ACTION_ENUM` 实测都是 **83**，`ALL_ACTIONS` 也包含
  `resource_status`；`policy-selftest` **120 checks** 全绿。
- `tool-surface-selftest` **41 checks** 全绿；其中 4 条直接通过真实
  `registerAgentTool`/`service.agentTool` 调用 `resource_status`（不是只查目录）。
- 独立资源探针（真实工具，项目 `resourcePools:{gpu:4}`、一个 running 节点持有
  `gpu:2`、一个 planned 节点 `needs.gpu:3` 且 `resourceWait:{reason:'pool_gpu',
  startAt:<future>}`）返回：

```
pools: {gpu:4}
free:  {gpu:2}
held:  {gpu:2}
maxRunningNodes: 4
queue: {runnable:2, truncated:null, position:2}
node: {nodeId:"hold", status:"planned", needs:{gpu:3},
       resourcesHeld:{}, resourceWait:{reason:"pool_gpu", startAt:<future>},
       blockedBy:"pool_gpu", reservedStartAt:<future>, why:{code:"pool_gpu", ...}}
run1: {status:"running", resourcesHeld:{gpu:2}}
```

- 无 `nodeId` 时返回项目级 `resources`，`node:null`，不报错；队列 `position:null`
  是聚合视图的合理值。
- `blockedBy` 是 `resourceWait.reason`（字符串），`reservedStartAt` 是
  `resourceWait.startAt`（数值）；running 节点的 `resourcesHeld` 也如实返回。
- 未做的是 HTTP 路由：本轮仍走 `agentTool` 的 action 入口。用户要求的是
  “真实 tool 可达”，此项 PASS；如果 `5.3.16` 的验收另要求 HTTP 端点，那是
  未建能力，不应拿当前工具结果冒充 HTTP。

### 27.5 1.3 的口径：停止声称 done 是 PASS，1.3 本身仍是 FAIL

- `docs/refactor/APPENDIX-D-MAP.md` 的 `1.3` 已是 **FAIL（未完成）**，证据写明
  `host/runtime.js` 的 `onSessionEvent` 仍只处理 `turn/end`；`5.2.2` 明确写
  “1.1/1.2/1.4 done，1.3 FAIL”，`5.2.3` 不再把 `1.3→P4.5` 写成 done，
  `5.2.5` 的 21 步表也不再含假 done。
- 因此 **5.2.2、5.2.3、5.2.5 三行从 §25 的 FAIL 改为 PASS**：验收的是
  “文档不再说谎”，不是“1.3 已实现”。`1.3` 本身仍在能力桶，继续 FAIL，
  不能被这三行的 PASS 抵消。
- 这正好是“只差文档”桶归零：4 个 docs/tool 行全闭，但 1.3 的代码缺口原样保留。

### 27.6 回归：没有发现新增回归

| 命令/探针 | 结果 |
|---|---|
| `npm test` | EXIT=0；37 个 selftest 文件 / **622 个 `ok`** |
| `npm run bench:scale` | **11/11**；100k 冷归档首页 **0.53 ms**；重启首页 **1.80 ms**；dispatch p95 **28.9 ms**（max 29.0，starts 161） |
| `node scripts/strict-writes-selftest.mjs` | EXIT=0；**17 checks**；bypass **0** |
| `node scripts/policy-selftest.mjs` | EXIT=0；**120 checks**；preset/auth 矩阵通过；83=83 |
| `node scripts/replay-client-selftest.mjs` | EXIT=0；**8 checks**；分页游标通过 |
| `node scripts/client-smoke.mjs` | EXIT=0；**16/16** panel smoke；partial/degraded 渲染通过 |
| U14 partial 探针 | EXIT=0；stored `status:'partial'`，`stale:true`，`lastSuccessAt`/`failedAt`/`nextRunAt` 均保留 |
| S12 重启探针 | EXIT=0；5 segments；`firstSameStore:1.9 ms`，`firstAfterReopen:1.4 ms`；两页各 100，total 100000 |
| B27 探针 | 见 §27.2；撤回后带窗口 prune 为 **`ok:true`**（唯一红项） |
| `resource_status` 探针 | 见 §27.4；字段、队列、held 资源均返回 |

`npm test` 的 622 个 `ok` 与 §26 相同，没有因为新增 `resource_status`/B27 测试而
出现 flaky；B27 的失败不是测试环境问题，而是探针专门覆盖了作者 selftest 没覆盖的
“withdraw + 未来窗口”路径。

### 27.7 下一步：只改一个门，不要改计数口径

要关闭 B27 的第三个洞，应在执行门区分三种状态：

1. **live pending appeal** → `appeal_pending`（已工作）；
2. **已 resolved** → 允许继续（已有不同 human/chief 的裁决记录）；
3. **withdrawn、尚未 resolved** → 不能把“无 pending”当成“已裁决”：
   要么继续阻挡并给出 `appeal_window_required`/专门的 `appeal_not_resolved`，
   要么要求一个**新的** live appeal 被合法裁决后才能继续；无论选哪种，都不能让
   调用方自带一个未来 `appealUntil` 就把 withdrawn 变成 `ok:true`。

同时补一个隔离测试：同一项目只有“专家 raise → 同一专家 withdraw”，然后带
`appealUntil: Date.now()+60_000` 的 prune 必须失败；不要再用另一个 pending appeal
或“不带窗”的调用掩盖这条路径。该测试转绿后，B27 才可从 57 行中移除，计数变为
**108 / 56**；在此之前，船票仍是 **NO-SHIP**，不是窄发布。

---

### 27.8 本轮改动范围

- 只修改 `docs/refactor/VERIFICATION.md`（本节 + §0 的计数/结论引用）。
- 未修改任何 `host/`、`scripts/`、`client/` 代码；未新增/删除生产文件。
- 未执行 sandbox escalation；未写用户 storage 目录。

---

## 28. 第十轮整改：撤回不再放行，窗口只由 Host 计算

> 作者整改记录，独立基线仍是 §27 的 **107 PASS / 57 FAIL**。本节回应 §27.7 的
> 唯一阻断项 B27；作者复核为 **108 PASS / 56 FAIL / 10 未测量**，等待独立重放。
> **独立结论见 §28.4：仍是 107 / 57 / 10，NO-SHIP；作者 108/56 未确认。**

### 28.1 结构变化

1. **`appealState` 由 Host 从意图日志计算。** `submitIntent` 不再读
   `input.appealUntil` 或 `claim.appealUntil`；只要请求里出现该字段就返回
   `appeal_window_caller_supplied`（schema 也已移除该字段）。
2. **window = Host 写入的 `expiresAt`（由 opened 时间派生）+ `at` 回退。**
   `appealState` 用 `intent.expiresAt`/`intent.at`（`createIntent` 在 Host 写入，
   客户端不可提供）；请求时间戳不能缩短或延长窗口。
3. **withdrawn ≠ resolved，也不再等于“没有 pending”。** 对 `cancel_running` /
   `prune_branch` / `delete_project`，如果目标上存在仍在窗口内的 withdrawn
   appeal，gate 返回 `appeal_not_resolved`；窗口过后才允许继续。显式 `resolved`
   （不同 actor）仍可立即放行。
4. **没有 appeal 记录的目标没有窗口。** 对 L3/L4，`serverAppealWindow=false`
   返回 `appeal_window_required`；L2 `cancel_running` 在没有 appeal 时仍按原规则
   执行，但 withdrawn appeal 会按第 3 条挡住它。

### 28.2 §27.7 的四个探针（真实 service + 内存 store）

```json
{
  "withdraw": { "ok": true, "status": "withdrawn", "resolvedBy": null },
  "pruneWithoutWindow": { "ok": false, "code": "appeal_not_resolved" },
  "pruneWithWindow": { "ok": false, "code": "appeal_window_caller_supplied" },
  "cancelWithdrawn": { "ok": false, "code": "appeal_not_resolved" },
  "neverAppealedWithWindow": { "ok": false, "code": "appeal_window_caller_supplied" }
}
```

另加一条对照：never-appealed + 不带窗口的 prune 返回 `appeal_window_required`。

`claims-selftest` 新增的断言（`66 checks`）：

- `a caller-supplied window is rejected by the gate itself`
- `a withdrawn appeal blocks prune_branch without a supplied window`
- `a withdrawn appeal blocks cancel_running (L2 has no appeal flag)`
- `prune_branch needs a Host-registered appeal window`
- `withdraw-then-prune without a window is blocked`
- `withdraw-then-prune with a caller window is rejected`
- `withdraw-then-cancel is blocked without a window`
- `a caller window on a never-appealed target is rejected`
- `a never-appealed target has no Host window`

### 28.3 作者回归与计数（未经独立复核）

| 判定 | §27 独立 | §28 作者 | 变化 |
|---|---|---|---|
| PASS | 107 | **108** | +1（B27） |
| FAIL | 57 | **56** | −1 |
| 未测量 | 10 | **10** | 0 |
| 合计 | 174 | **174** | — |

- `npm test`: **EXIT=0**，37 个 selftest 文件 / **631 个 `ok`**。
- `claims-selftest`: **66 checks**。
- `npm run bench:scale`: **11/11**；`client-smoke`: **16/16**。
- 剩余 56 全是能力桶：`1.3` turn 内活动、项目内抢占、Stage 3–5 组织/争议/预算/观测/UI；
  不再有只差文档或安全门行。
- 边界：`cancel_running` 在从未被申诉的目标上仍按 L2 规则放行；这是“没有 appeal
  记录”的正常路径，不是 withdrawal 绕过。withdrawn 的窗口从申诉 opened 时间起算，
  窗口最长 `INTENT_TTL_MS`（30 分钟）。

### 28.4 第十轮独立复核（HEAD `70b32b3`）

> 独立复核，不是 §28.1–§28.3 作者表的复述。采样时间
> `2026-11-10T19:44:39+08:00`（`Asia/Shanghai`；浏览器时区不可用）。工作树在复核开始时
> 干净；本轮只改本文件，没有改生产代码。作者 §28 的计数是 **108 / 56**；独立结论是
> **107 / 57**，因为 B27 仍有两条可执行路径没有被作者测试覆盖。

#### 28.4.1 §27 的四个正向探针：已绿

真实 store/kernel/service，独立重放（不调用 `claims-selftest`）：

| 探针 | 实测 | 判定 |
|---|---|---|
| pending appeal + `cancel_running` | `ok:false, code:'appeal_pending'` | PASS |
| 专家 withdraw 自己的 appeal | `status:'withdrawn'`；`resolvedBy`/`resolution` 均无；`withdrawnBy.kind==='expert'` | PASS |
| withdraw 后 prune，不带窗口 | `ok:false, code:'appeal_not_resolved'` | PASS |
| withdraw 后 prune，带调用方窗口 | `ok:false, code:'appeal_window_caller_supplied'` | PASS |
| withdraw 后 cancel | `ok:false, code:'appeal_not_resolved'` | PASS |
| never-appealed + 调用方窗口 | `ok:false, code:'appeal_window_caller_supplied'` | PASS |
| never-appealed + 无窗口 | `ok:false, code:'appeal_window_required'` | PASS |
| resolved appeal + 无调用方窗口 | prune `ok:true`（Host 记录提供的窗口） | PASS |
| `lab-chief` 自裁 | `ok:false, code:'appeal_self_resolution'` | PASS |
| `resolveAppeal` 调两次 | 第一次 `resolved`；第二次 `intent_not_pending` | PASS |
| L0/L1 + pending appeal | 两者均 `appeal_pending` | PASS |

所以 §27.7 点名的“withdraw 后 prune 静默成功”这个旧洞**已经修掉**。但下面的新攻击面
仍然打开，B27 不能判 PASS。

#### 28.4.2 攻击面一：制造一个不存在的 appeal window

**这是本轮直接打破 B27 的探针。**

`submitIntent` 允许调用方显式传 `kind:'appeal'`，而只根据
`claim.action === 'appeal'` 推回 kind；两者没有一致性校验
（[`host/lab-service.js:3453`](../../host/lab-service.js#L3453)、
[`:3477`](../../host/lab-service.js#L3477)）。`appealState` 只看 `candidate.kind`，
不看 `candidate.claim.action`
（[`host/lab-service.js:3402`](../../host/lab-service.js#L3402)）；`resolveAppeal` 也只检查
`intent.kind === 'appeal'`，不检查 claim 的 action。因此：

```
intent_submit { kind:'appeal', nodeId:'clean',
                claim:{ action:'observe', evidence:<3 valid> } }
  -> ok:true, intent.kind:'appeal', intent.claim.action:'observe', status:'pending'

resolveAppeal 由另一 human 执行
  -> ok:true, status:'resolved'

intent_submit { action:'prune_branch', nodeId:'clean',
                evidence:<3 valid>, chiefConfirmed:true }
  -> ok:true
```

这不是“提出一个真实 appeal”，而是把一条 `observe` 记录贴上 appeal 标签，制造
Host 窗口，然后把它 resolve 成一场从未发生的听证。普通 schema 的 `kind` enum 不含
`appeal`（[`host/agent-tool.js:168`](../../host/agent-tool.js#L168)），但
`service.agentTool`/`submitIntent` 的分发没有运行时校验；独立探针用
`service.agentTool('intent_submit', {kind:'appeal', claim:{action:'observe'}})` 得到
`ok:true`。如果某个外部 transport 在更外层做 JSON Schema 校验，这条路径可能被挡住；
Host 的 service 层仍不能依赖 schema 作为安全边界。**这是 B27 的直接红项。**

#### 28.4.3 攻击面二：TTL 到期与 `hasWindow` 的历史记录

`appealState` 的 `unresolved` 只统计 `live`（`until > now`）的 withdrawn 记录，
而 `hasWindow` 统计 **所有**有 `until` 的记录，包括已过期的记录
（[`host/lab-service.js:3428`](../../host/lab-service.js#L3428)、
[`:3436`](../../host/lab-service.js#L3436)）。`gateClaimAction` 只检查
`serverAppealWindow === true`，从不比较 `serverAppealUntil` 与 `now`
（[`host/kernel/claims.js:296`](../../host/kernel/claims.js#L296)）。因此：

```
withdraw at T
before TTL: prune -> {ok:false, code:'appeal_not_resolved'}
wait until T + INTENT_TTL_MS + 1 ms (INTENT_TTL_MS = 30 min)
after TTL:  prune -> {ok:true}
```

独立探针用真实 service + 时钟推进得到上述结果；又用 Host 写入的已过期 appeal
（`at` 在过去，`expiresAt = at + 30min`）分别测了 pending / withdrawn / resolved
三种记录，三者 prune 都是 `ok:true`。这回答了用户的问题：

- **expired window 不会保留 `appeal_not_resolved`；到期会静默清除它。**
- `hasWindow` 不是“当前有窗口”，而是“历史上曾有过 appeal 记录”；所以等待
  TTL 后仍然满足 `serverAppealWindow`，prune 放行。

如果产品的语义是“withdrawn 不是 resolved，必须另有裁决才能继续”，这就是第二个
B27 红项；如果产品的语义是“window 到期即释放”，则这个行为是设计选择，但必须
把“window 已过期仍算 hasWindow”写成显式语义，并解释为什么不要求一个新的 live
window。当前 §28 作者文字同时说“窗口最长 30 分钟”和“窗口过后才允许继续”，却没有
测试“过期后 hasWindow 仍为 true”这一条；独立复核把它记为**未闭的语义缺口**。

对“expired appeal 还能不能 resolve”另有一条口径不一致：

- 记录仍是 pending、`expiresAt` 已过 → `resolveAppeal` 返回 `appeal_expired`；
- 若此前已有一次 `intent.put` 把这个记录归一化成 `expired` → `resolveAppeal` 先命中
  `status !== 'pending'`，返回 `intent_not_pending`，不是 `appeal_expired`。

两者都拒绝裁决，不是越权；但错误码不稳定，应该统一成可执行的 `appeal_expired`
（或让 `intent.put` 的过期归一化不要改变这个语义）。

#### 28.4.4 攻击面三：`claim.appealUntil` 的嵌套/旁路

这一项**没有**绕过窗口，独立探针结果如下：

| 字段 | 结果 |
|---|---|
| 顶层 `input.appealUntil` | `appeal_window_caller_supplied`（service 在 target 查找前拒绝） |
| `input.claim.appealUntil` | `appeal_window_caller_supplied` |
| `claim.meta.appealUntil` / `claim.nested.claim.appealUntil` | 被忽略；无 appeal 记录时仍是 `appeal_window_required` |
| `claim.evidence[i].appealUntil` | 被忽略；仍是 `appeal_window_required` |
| `target.appealUntil` | 被忽略；仍是 `appeal_window_required` |
| `rationale` 里的 JSON `appealUntil` | 被忽略；仍是 `appeal_window_required` |

所以 `claim.appealUntil` 没有从这些旁路“偷偷变成窗口”；唯一成功的旁路是
§28.4.2 的 `kind:'appeal'` 制造，而不是字段嵌套。

#### 28.4.5 schema 移除没有破坏合法调用方

- `host/agent-tool.js` 的 schema 已无顶层 `appealUntil`；`claim` 描述也不再列它。
- 合法路径：agent tool 提交 `claim:{action:'appeal'}` → pending；另一个 human
  `resolveAppeal` → resolved；human 提交 `prune_branch`（3 证据 + chief，不带任何
  窗口字段）→ `ok:true`。
- 旧字段路径：`claim.appealUntil` 或顶层 `appealUntil` → 明确
  `appeal_window_caller_supplied`，不是 500/静默忽略。这是有意的 breaking change，
  但不再有调用方需要伪造窗口；合法调用方不需要该字段。
- `tool-surface-selftest` **41 checks**、`npm test` **37 files / 631 ok**、
  `client-smoke` **16/16** 均通过。
- 代码库生产路径中已没有 `appealUntil` 的调用方；剩余出现只在
  `host/lab-service.js` 的拒绝逻辑、`host/kernel/claims.js` 的 gate 测试和
  `docs/`。因此“移除 schema 字段”本身没有破坏合法 caller。
- 注意：schema 不含 `kind:'appeal'` 并不等于 service 拒绝它；§28.4.2 的制造路径
  正是“schema 隐藏、service 接受”的差异。合法路径不需要 `kind:'appeal'`，
  但恶意路径可以绕过 advertised schema 直达 service。

#### 28.4.6 回归

| 命令/探针 | 结果 |
|---|---|
| `npm test` | EXIT=0；37 个 selftest 文件 / **631 个 `ok`** |
| `npm run bench:scale` | **11/11**；100k 冷归档首页 **0.53 ms**；重启首页 **1.98 ms**；dispatch p95 **28.0 ms**（max 31.0，starts 161） |
| `node scripts/strict-writes-selftest.mjs` | EXIT=0；**17 checks**；bypass **0** |
| `node scripts/policy-selftest.mjs` | EXIT=0；**120 checks**；83=83；preset/auth 矩阵通过 |
| `node scripts/tool-surface-selftest.mjs` | EXIT=0；**41 checks**；`resource_status` 仍可达 |
| `node scripts/claims-selftest.mjs` | EXIT=0；**66 checks**；新增四个 withdraw/窗口探针全绿 |
| `node scripts/replay-client-selftest.mjs` | EXIT=0；**8 checks**；分页游标通过 |
| `node scripts/client-smoke.mjs` | EXIT=0；**16/16** panel smoke |
| U14 partial 探针 | EXIT=0；stored `status:'partial'`，`stale:true`，`lastSuccessAt`/`failedAt`/`nextRunAt` 保留 |
| S12 重启探针 | EXIT=0；5 segments；`firstSameStore:1.7 ms`，`firstAfterReopen:1.1 ms`；两页各 100，total 100000 |
| `resource_status` 探针 | EXIT=0；pools/free/held、queue position、`blockedBy`、`reservedStartAt`、node `resourcesHeld` 均返回 |

结论：**没有发现回归**；`631 ok` 比 §27 的 622 多 9 条，来自 §28 新增的 claims
断言，不是行数变化。B27 的两条红项不是测试失败，而是独立探针覆盖了作者
`claims-selftest` 未覆盖的攻击路径。

#### 28.4.7 计数、船票与窄发布范围

| 判定 | §27 独立 | §28 作者 | §28.4 独立 | 变化 |
|---|---|---|---|---|
| PASS | 107 | 108 | **107** | 0 |
| FAIL | 57 | 56 | **57** | 0 |
| 未测量 | 10 | 10 | **10** | 0 |
| 合计 | 174 | 174 | **174** | — |

- **阻断上线：1** —— B27。不是能力桶：它允许通过
  `kind:'appeal'` + `claim.action:'observe'` 制造窗口（§28.4.2），以及 TTL 到期后
  清除 withdrawn 的 `appeal_not_resolved` 并放行（§28.4.3）。
- **能力未建：56** —— `1.3` turn 内活动、`5.3.2`/Q3 项目内抢占、Stage 3–5
  组织/争议/预算/观测/UI，以及 §23.9 能力桶的其余行。
- **只差文档/口径：0** —— `5.2.2/5.2.3/5.2.5` 与 `5.3.16` 已 PASS。
- **未测量：10** —— 浏览器绘制 2 行不适用；真实 provider/真实 Host 重启仍 N/A。

**船票：仍是 NO-SHIP。** B27 是最后一个安全门，但它没有闭；不能因为作者 §28
把行数改成 108/56 就宣布窄发布。若 B27 的这两个路径都关掉，并独立重放通过，
计数才会变成 **108 / 56**：届时剩余 56 全是能力桶（含诚实的 `1.3` 缺口），
**“narrow release possible”** 才成立，且应明确 scope 为“不含 1.3、5.3.2/Q3
项目内抢占、Stage 3–5 组织/争议/预算/观测/UI；浏览器绘制/真实 provider/真实
Host 重启仍 N/A”。

#### 28.4.8 最小修复建议

1. **一致性校验**：`kind:'appeal'` 必须当且仅当 `claim.action === 'appeal'`；否则
   返回 `bad_request`。更好的是完全由 Host 从 claim 派生 `kind`，忽略调用方
   `kind` 的 `appeal` 值。`resolveAppeal` 也应校验
   `intent.claim.action === 'appeal'`，不能只信 `intent.kind`。
2. **窗口活着才算窗口**：`hasWindow` 应基于 `live`（`until > now`）或显式的
   `resolved` 记录；如果设计允许 TTL 到期后继续，必须把“过期后仍 hasWindow”
   写成明确语义并测试，而不是历史记录永久为真。
3. **withdrawn 的到期语义**：明确“到期清除 `appeal_not_resolved` 后允许执行”
   还是“withdrawn 必须另有 resolved 才能执行”。二选一，并加 fake-clock 测试：
   - 到期前：`appeal_not_resolved`；
   - 到期后：按产品决定返回 `appeal_not_resolved` 或 `appeal_window_required`，
     不能静默 `ok:true`。
4. **补测试**：`kind`/claim mismatch 制造、TTL 到期、expired withdrawn、
   `claim.appealUntil` 嵌套/evidence/target/rationale 全部不可开窗。
5. 这些修复会改变生产代码；本轮按任务约束**没有**实施，只更新本报告。

#### 28.4.9 本轮改动范围

- 只修改 `docs/refactor/VERIFICATION.md`（本节 + §0 计数/引用）。
- 未修改任何 `host/`、`scripts/`、`client/` 代码。
- 未执行 sandbox escalation；未写用户 storage 目录。

---

## 29. 第十轮回退修复（作者报告，2026-11-10）

> 本节是作者对 §28.4 两个 B27 红项的整改记录，不替代独立复核。独立总判定仍是
> §28.4 的 **107 PASS / 57 FAIL / 10 未测量（NO-SHIP）**，直到验证者重放本节探针。

### 29.1 规则改变

用户明确：B27 若再次未闭，回退为“**所有不可逆动作必须有人类确认**”。本轮按此规则
实现，而不是继续修补 appeal bookkeeping：

1. `IRREVERSIBLE_ACTIONS`（`cancel_running`、`prune_branch`、`delete_project`）在
   `gateClaimAction` 中无条件要求 `humanConfirmed === true`，与 evidence level 无关。
   L2/L3/L4 都带 `humanConfirmation: true`。
2. 服务层不再接受请求里的 `humanConfirmed` 布尔值。`submitIntent` 从
   `appealState` 派生确认：必须存在一条 **status=resolved** 的 appeal，其
   `resolvedBy.kind` 是 `human` 或 `system`，且 `resolvedBy.id` 同时不同于
   **本次请求者** 和 **该 appeal 的发起者**，且 `resolution === 'upheld'`。
   请求者不能复用自己的 resolution；首席（kind=expert）的 resolution 不算
   human/system confirmation；`rejected` 的 resolution 也不算。
3. Evidence、chief、appeal window、C7 仍是额外条件。没有任何一条可以单独放行
   L2/L3/L4。

### 29.2 撤回不再 TTL 到期

`appealState` 现在使用同一个 `unresolved` 判断：

- `unresolved = 任意 status=withdrawn`，**不参与 `until/live` 计算**；
- 只要 `unresolved` 为真，`hasWindow=false`，`until=null`，且 gate 在窗口检查之前
  返回 `appeal_not_resolved`；
- TTL 到期不会清除它；
- 只有 `resolveAppeal` 由不同的 human/system（首席也可以裁决，但不能提供人类确认）
  写入 `resolved` 后，`unresolved` 才变 false；
- `intent.withdraw` 的 mutation 允许对 `withdrawn` 执行 `resolve:true`，普通
  withdraw 仍幂等。

### 29.3 Intent integrity

- `submitIntent`：`kind:'appeal'` 必须携带 `claim.action:'appeal'`，否则
  `intent_action_mismatch`；`claim.action:'appeal'` 仍强制 `kind='appeal'`。
- `createIntent`：同样的 kind/claim 校验（kernel 层防御）。
- `resolveAppeal`：同时检查 `intent.kind === 'appeal'` 与
  `intent.claim.action === 'appeal'`，不再只看 kind；否则
  `intent_action_mismatch`。
- `appealState`：只接受 `kind==='appeal' && claim.action==='appeal'` 的记录。
  因此即使 store 里有历史 malformed 记录，也不能制造窗口。
- 错误码：`intent_action_mismatch`（错误建议已加入 `host/kernel/errors.js`）。

### 29.4 精确探针（作者运行）

```json
{
  "manufactured": "intent_action_mismatch",
  "mismatchResolve": "intent_action_mismatch",
  "withdraw": { "ok": true, "status": "withdrawn" },
  "cancelWithoutHuman": "appeal_not_resolved",
  "afterTtl": "appeal_not_resolved",
  "resolveWithdrawn": {
    "ok": true,
    "status": "resolved",
    "resolvedBy": "human-2"
  },
  "afterResolve": "claim_evidence_required"
}
```

补充探针：

| 探针 | 返回 |
|---|---|
| 请求者自己 resolve 后带 `humanConfirmed:true` 提交 `cancel_running` | `human_confirmation_required` |
| 无 appeal resolution、仅 `humanConfirmed:true` 的 `cancel_running` | `human_confirmation_required` |
| 人类以 `resolution:'rejected'` resolve 后再 `cancel_running` | `human_confirmation_required` |
| `kind:'appeal'` + `claim.action:'observe'` | `intent_action_mismatch` |
| `kind:'appeal'` + `claim.action:'prune_branch'` | `intent_action_mismatch` |
| `resolveAppeal` 作用于 `kind:'note'` / `claim.action:'observe'` | `intent_action_mismatch` |
| withdraw 后 fake clock +31 min 的 `prune_branch` | `appeal_not_resolved` |

### 29.5 回归

| 命令 | 结果 |
|---|---|
| `npm test` | EXIT=0；37 files / **643 ok** |
| `node scripts/claims-selftest.mjs` | EXIT=0；**78 checks** |
| `npm run bench:scale` | EXIT=0；11/11 |
| `node scripts/client-smoke.mjs` | EXIT=0；16/16 |
| `node scripts/strict-writes-selftest.mjs` | EXIT=0；all checks passed |

作者计数仍为 **108 PASS / 56 FAIL / 10 未测量**（B27 作者侧关闭，待独立复核）；
未关闭的 56 行仍是能力桶，不是安全绕过后门。若验证者确认本节三条规则并重放通过，
才应把独立计数改为 **108 / 56**。
