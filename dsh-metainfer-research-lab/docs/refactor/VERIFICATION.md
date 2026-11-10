# 独立验收报告 — `refactor/v2`

> 验收人：独立验证者（未参与实现）。对象：`docs/refactor/DESIGN-CHECKLIST.md` §1–§9、
> `docs/refactor/IMPLEMENTATION.md`、`refactor/v2` 代码；初始基线 `6beba88`，第八轮
> §25 的独立复核 HEAD 为 `2c50c54`。日期：2026-11-10。

## 0. 结论摘要

| 判定 | 数量 |
|---|---|
| PASS | **121** |
| FAIL | **43** |
| 未测量 | **10**（其中浏览器 2 行 = 不适用） |
| 合计 | **174** |

**行数更正**：任务说明里写“128 行”，但清单实际是 **174 行**：§1 27、§2 14、§3 21、§4 14、
§5 37、§6 14、§7 12、§8 21、§9 14。本报告逐行覆盖全部 174 行，没有抽样。

**一句话**：第十六轮独立复核（clean worktree HEAD `8582b4f`，§38）确认
**B27 的 restart-continuity 成立**：独立启动的第二个 Node 进程重新加载同一
file-backed domain，按 Host session id 恢复 human/expert/confirmer/advisor 四个
key；未知/伪造 key 仍 fail-closed；第二个进程内完成一个真实申诉 resolve 并执行
`delete_project`；第三个进程再次恢复并删除第二个项目；facade 没有写入
`actorKeys` 的方法，`changesSince` 不含 key。因此 §36 的 **“restart 排除”从
B27 撤销**，不再作为 B27 的排除项。

**§38 历史结论（非当前判定）**：能力 Wave 1–3 的 5 个被点名行中，`1.3`、U1、U3 独立通过；U2 仍只给前 5 个
队列位置且不显示 `facts.why`，U12 仍在部分端点失败时显示假空态且多数新面板
没有 Retry。四个部分面中，B23（expected/rotation）和 5.3.14（limited-write /
arbiter matrix）独立通过，**B22 仍是 FAIL**：8 类 authority 元数据正确，但
`resolveDispute` 不执行 authority 检查，专家可对全部 8 类 `apply_change`；
5.3.13 的 long-poll/mid-sleep 通过，但只有 30s、只识别 stalled，缺
starving/pauseReason。§38 当时的历史计数为 **114 PASS / 50 FAIL / 10 未测量**；第十七轮为 §40 的 **116 / 48 / 10**，第十八轮为 §41.7 的 119/45/10；第十九轮以 §43 的 **120 / 44 / 10** 为准；第二十轮以 §45 的 **120 / 44 / 10** 为准；第二十一轮以 §46.7 的 **121 / 43 / 10** 为准。

> 作者第十四轮报告见 **§35**，第二十轮报告见 **§46**，不替代独立复核。
> **第十七轮独立复核见 §40；第十八轮见 §41.7；第十九轮见 §43；第二十轮见 §45；第二十一轮见 §46.7；当前独立总判定以 §46.7 为准：121 PASS / 43 FAIL / 10 未测量。**
> **B27 restart continuity 仍 PASS；U2 PASS；B22 在 round 21 独立重放通过（48 个 method+path 全部有 policy；14 个 token 路由 absent/forged 拒绝；递归剥离 body actor；/commands 破坏性操作仍走 human gate；authorizeIrreversibleTool(null) 不再铸造 human）。完整发布仍 NO-SHIP：13 个必须行尚未关闭。**

> 本文件 §1–§13 保留**第一轮**（`6beba88`）的 174 行原判（50 PASS / 114 FAIL / 10 未测量）；
> **第二轮**（`750fc31`）见 **§14**；第三轮（`d0364c4`）见 **§15**；作者第三轮修复表见 **§16**；
> **第四轮**（`7d97432`）的独立复核见 **§17**；第四轮修复后的复核见 **§18**；**第五轮**
> （`5ee1376`）见 **§19**；第五轮修复复核见 **§20**；**第六轮**（`ad396b7`）见 **§21**；
> 第七轮修复复核（`53ff695`）见 **§23**；第八轮独立复核（`2c50c54`）见 **§25**；第九轮作者整改见 **§26**（基于 §25，不替代独立复核）；第九轮独立复核（`75963e5`）见 **§27**；第十轮作者整改见 **§28**，第十轮独立复核（`70b32b3`）见 **§28.4**；第十轮 B27 回退人工确认的作者整改见 **§29**（不替代独立复核），第十一轮独立复核（`4d30c3a`）见 **§29.6**；第十一轮作者 scope/CAS 整改见 **§30**，第十二轮独立复核（`e85b213`）见 **§30.6**；第十二轮作者 handler/canonical/CAS 整改见 **§31**，第十三轮独立复核（`4a209bc`）见 **§32**；第十三轮作者 `actorKey` 整改见 **§33**，第十四轮独立复核（`1f3e20e`）见 **§34**；作者第十五轮 B27/能力见 **§35**，第十五轮独立复核（`ef16f34`）见 **§36**。
> 独立总判定以 **§43** 为准；§40/§41.7 是前轮历史结论；§20/§22/§24/§26/§28/§29/§30/§31/§33/§35/§37 是作者报告，不能代替独立复核。§22 曾声称关闭
> B27/C7/U14/S12/A20（87 PASS / 77 FAIL），§23 推翻了其中 B27/U14/S12/A20 四项；
> §24 作者报告为 112 PASS / 52 FAIL，§25 复核为 103 PASS / 61 FAIL，§27 复核为
> **107 PASS / 57 FAIL / 10 未测量**，§28.4 复核仍为 **107 / 57 / 10**，
> §29.6 复核仍为 **107 / 57 / 10（NO-SHIP）**，
> §30.6 复核仍为 **107 / 57 / 10（NO-SHIP）**，
> §32 复核仍为 **107 / 57 / 10（NO-SHIP）**，
> §34 复核仍为 **107 / 57 / 10（NO-SHIP）**；
> §36 第十五轮复核（`ef16f34`）为 **109 / 55 / 10**（历史：B27 仅当前进程 PASS，
> `5.3.2` PASS）；§38 第十六轮复核（`8582b4f`）为 **114 / 50 / 10**（B27
> 含真实进程 restart PASS；`1.3`/U1/U3/B23/5.3.14 闭合，U2/U12/B22/5.3.13 未闭）。

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
> 第十一轮独立复核见 **§29.6**：精确探针通过，但 B27 仍有自提/串通与并发
> resolution 覆盖两条失败路径；独立计数 **107 / 57 / 10（NO-SHIP）**，
> 作者 108/56 不确认。

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

---

## 29.6 第十一轮独立复核（HEAD `4d30c3a`，2026-11-10）

> 复核人：独立验证者。只读复跑 + 独立探针；没有修改生产代码。采样时间
> `2026-11-10T20:02:51+08:00`（`Asia/Shanghai`）；浏览器时区不可用。
> 对象：作者 §29 的 B27 回退整改。结论：**§29.4 的六个精确探针通过，
> 但 B27 仍未关闭**；独立计数 **107 PASS / 57 FAIL / 10 未测量**，
> **NO-SHIP**。作者 §29.5 的 108/56 不确认。

### 29.6.1 作者 §29.4 / §28.4 精确探针

| 探针 | 独立结果 | 判定 |
|---|---|---|
| `kind:'appeal'` + `claim.action:'observe'` | `intent_action_mismatch` | 通过；写边界拒绝 |
| `kind:'appeal'` + `claim.action:'prune_branch'` | `intent_action_mismatch` | 通过 |
| pending appeal + `cancel_running` | `appeal_pending` | 通过 |
| `intent.withdraw` 自己的 appeal | `ok:true`，`status:'withdrawn'`，无 `resolvedBy`/`resolution` | 通过 |
| withdraw 后无窗口 prune | `appeal_not_resolved` | 通过 |
| withdraw 后请求携带 `claim.appealUntil` | `appeal_window_caller_supplied` | 通过 |
| withdraw 后 cancel | `appeal_not_resolved` | 通过 |
| never-appealed + 请求携带窗口 | `appeal_window_caller_supplied` | 通过 |
| never-appealed + 不携带窗口 | `human_confirmation_required` | 通过，但**行为已变**：人类确认在窗口检查前，旧 `appeal_window_required` 不再出现；这是更早的 fail-closed，不是放行 |
| withdraw 后 fake clock +31 min prune | `appeal_not_resolved` | 通过；TTL 不清除 withdrawn |
| `resolveAppeal` 作用于 `kind:'note'` / `claim.action:'observe'` | `intent_action_mismatch` | 通过 |
| `createIntent` 直接构造 `kind:'appeal'` + 非 appeal action | 抛出 `intent_action_mismatch` | 通过（kernel 防御） |
| 过期 pending appeal resolve | `appeal_expired` | 通过；不会变成 upheld |
| 合法 appeal（advisor 发起、human-2 resolve、human-1 prune/cancel） | `ok:true`；`humanConfirmedBy={kind:'human',id:'human-2'}` | 通过；合法路径未被 removal 破坏 |

补充：`resolution:'upheld '`（尾随空格）不被接受为确认；`claim.meta`、
`claim.evidence`、`target`、`rationale` 里塞 `appealUntil` 都不产生窗口；
顶层 `appealUntil` 和 `claim.appealUntil` 都在任何 target lookup 之前被
`appeal_window_caller_supplied` 拒绝。

### 29.6.2 B27 新失败一：自提申诉 + 串通 human（distinct id 不等于独立）

用户要求攻击的正是这一点：“requester 让针对自己的 appeal 被提出，再让一个
**串通 human** resolve；requester 同时控制两边时，distinct from requester and
raiser 够不够？”独立结果是：**不够，prune 通过**。

| 场景（隔离 target） | 结果 |
|---|---|
| `human-1` 自己 raise appeal，`human-2` resolve，`human-1` prune | `ok:true`；`humanConfirmedBy=human-2` |
| `chief-1` 自己 raise appeal，`human-2` resolve，`chief-1` prune | `ok:true`；chief 的 prune 被人类确认 |
| `advisor-A` raise appeal，`human-2` resolve，`human-1` prune | `ok:true`；requester（human-1）与 raiser（advisor-A）不同，但 human-2 是唯一的人类裁决者 |
| **unscoped appeal**（`target:null`），`human-2` resolve，任意 target 的 prune | `ok:true`；一条无 target 的“人类裁决”可确认所有 target 的不可逆动作 |

代码事实：

- `appealState` 的 confirmation 只检查 `resolvedBy.id` 不等于**本次请求者**
  且不等于**该 appeal 的 raiser**；它无法判断 requester 是否控制了 resolver
  的 session/进程。
- `resolveAppeal` 的 self-resolution 检查也只比较 raiser 与 resolver 的
  `actor.id`；requester 自己 raise 再让另一个 human resolve 是允许的。
- 因此“requester controls both”时，`human-2` 只是一个不同的 session id，
  不是独立意志；B27 的“独立人类确认”性质不成立。

边界：这不是一个**单模型 session** 能直接完成的路径——`resolveAppeal` 不在
agent tool action 中；它需要至少一个 human 身份。但用户明确把“requester
控制两边”的串通模型列为要攻击的目标，所以按该模型记为 **B27 FAIL**，不降级
为“能力未建”。如果串通被明确排除在威胁模型外，这个探针只能算身份认证的
残余风险；但 §29.6.3 仍是代码级失败，不能据此给出 narrow release。

### 29.6.3 B27 新失败二：并发 resolution 覆盖，rejected 被重新读成 upheld

这是本轮最硬的代码级失败，不依赖“两个不同 human 串通”的语义：

对同一条 withdrawn appeal 并发提交两个 `resolveAppeal`：

```js
Promise.all([
  service.resolveAppeal(p, id, { resolution: 'rejected', reason: 'reject' }, human2),
  service.resolveAppeal(p, id, { resolution: 'upheld',   reason: 'uphold' }, human1),
])
```

独立输出（隔离 target）：

```json
{
  "first":  { "ok": true },
  "second": { "ok": true },
  "final":  { "status": "resolved", "resolution": "upheld", "resolvedBy": "human1" },
  "events": [
    { "type": "appeal/resolved", "reason": "reject" },
    { "type": "appeal/resolved", "reason": "uphold" }
  ],
  "prune":  { "ok": true, "humanConfirmedBy": "human1" }
}
```

同一 human resolver 也一样：

```json
{
  "first":  true,
  "second": true,
  "final":  { "status": "resolved", "resolution": "upheld", "resolvedBy": "h2" },
  "events": 2,
  "prune":  { "ok": true, "humanConfirmedBy": "h2" }
}
```

即一个 human 可以先写 `rejected`，同一批并发里的 `upheld` 会覆盖它；两条
`appeal/resolved` 事件都留在 log 里，而 gate 只读最终状态，于是 **rejected
resolution 被重新读成 upheld**，prune `ok:true`。

根因是 TOCTOU，不是 resolve service 的单次检查：

- `resolveAppeal` 在**旧的 project snapshot** 上检查
  `status === 'pending' || 'withdrawn'`，然后才 `await commitMutations`。
- 两个并发调用都能在第一个 commit 之前通过该检查。
- `intent.withdraw` mutation（`host/kernel/mutations.js:394-423`）只拒绝
  `expired`；它**允许**对当前已经是 `resolved` 的记录再次 `resolve:true`，
  并且普通 withdraw 也不拒绝 `resolved`。没有 `expectedStatus`、revision 或
  “一条 appeal 只能有一个 resolution”的原子条件。
- 结果是 last-writer-wins；顺序版本（同一 appeal 先 rejected，再顺序 resolve
  upheld）会被 `intent_not_pending` 拒绝，并发版本不会。

对用户四个问题的直接回答：

| 问题 | 顺序 | 并发 |
|---|---|---|
| rejected resolution 能否被重新读成 upheld？ | 不能；第二次 `intent_not_pending` | **能**；两个都 `ok`，最终 upheld |
| expired resolution 能否被重新读成 upheld？ | 不能；pending 过期 resolve 返回 `appeal_expired` | 未发现独立可执行路径；但同一 reducer 无 `expiresAt` 复查，若 commit 跨过 TTL 仍是 TOCTOU 风险 |
| withdrawn appeal 能否重复 resolve 出两条 resolved 记录？ | 不能；第二次 `intent_not_pending`，只有 1 条 resolved | **能产生两条 `appeal/resolved` 事件**；仍是 1 条 intent 记录，最终状态 last-writer-wins |
| 两条 resolved 记录本身能否混淆 gate？ | 一个 rejected + 一个独立 upheld 的两条 appeal：gate 跳过 rejected、取 upheld，结果是合法 upheld，不是“混淆” | 同一 appeal 的两条事件最终覆盖为 upheld；**是**，见上 |

补充失败面：`resolveAppeal` 对 **withdrawn** appeal 允许在 TTL 之后显式
resolve（作者设计如此），所以“withdrawn + 过期”本身不是权限；但并发覆盖让
**rejected** 的终局被抹掉，这是另一回事。`unresolved`/`confirmation`/`hasWindow`
都读同一个 snapshot，没有版本校验；一个 action 在 snapshot 之后、commit 之前
发生的 resolution 变化也可能不被看到（同源 TOCTOU），本轮先以可复现的
resolve-vs-resolve 为准。

### 29.6.4 system 冒充：真实 tool path 未发现

| 路径 | 结果 |
|---|---|
| `tool.execute` 以 `lab-scheduler`（`kind:'system'`）调用 `intent_submit` | `forbidden_action` |
| 同上调用 `intent_withdraw` | `forbidden_action` |
| tool action 列表/枚举里调用 `resolveAppeal` | 不存在；`intent_submit`/`intent_withdraw` 是仅有的 intent action |
| `actorFromToolExecution` 从请求 `input` 读取 actor/kind | 不读取；只从 session header preset/session id 派生 |
| 直接 `service.resolveAppeal(..., systemExec)` | 可写入 `resolvedBy.kind:'system'`；这是 Host 内部 service 调用，不是注册给 agent 的 tool path |
| 直接 `service.agentTool(..., systemExec)` | 绕过 policy wrapper；但生产 tool 注册走的是拒绝 system 的 wrapper，不是这个直调 |

结论：**没有发现通过真实 tool path 冒充 system 的路径**。`lab-scheduler` 可做
只读/DAG 动作，但不能提交/撤回 intent；`resolveAppeal` 只由 Host UI/服务调用。
若把“任何 in-process 的 service 直调”都算攻击面，则 `exec` 参数本身没有认证，
任意 Host 代码都能伪造 system；这属于 Host 内部信任边界，不是 agent tool
边界。该项按 **tool path 通过** 记录，不能用来抵消 §29.6.2/§29.6.3。

### 29.6.5 `humanConfirmed` 请求字段：已移除，未破坏仓内合法调用方

| 检查 | 结果 |
|---|---|
| `host/agent-tool.js` tool schema 顶层 `humanConfirmed` | 不存在 |
| `claim` 描述字段 | `{action, strategy?, reason?, evidence?}`；无 `humanConfirmed`/`humanConfirmedBy` |
| `kind` enum | 无 `appeal`；`resolveAppeal` 不是 tool action |
| 顶层 `humanConfirmed:true` 的 `delete_project`（无 resolution） | `human_confirmation_required` |
| 顶层 + `claim.humanConfirmed` + `humanConfirmedBy` 的合法 resolved appeal 路径 | `ok:true`；stored claim 只剩 `action` 和 Host 写入的 `gate` |
| `claim.humanConfirmed`/`humanConfirmedBy` 是否进入 intent log | 否；`submitIntent` 先 strip，gate 只用 Host 派生值 |
| 顶层 `humanConfirmed` 是否被 service 读取 | 否；只用于旧 gate 单元测试，不是生产请求入口 |
| 仓内合法调用方 | 没有发送该字段的生产 caller；`npm test` 643、claims 78、tool-surface 41、client 16 全绿 |

因此“请求派生的 `humanConfirmed` 真没了”成立。**旧外部客户端**如果仍发送
顶层字段，会因 tool schema `additionalProperties:false` 得到校验失败（或 service
忽略后得到 `human_confirmation_required`）；这是有意的破坏性迁移，不是仓内
合法 caller 被误伤。需要在发布说明中明确。

### 29.6.6 回归（HEAD `4d30c3a`）

| 命令 | 结果 |
|---|---|
| `npm test` | EXIT=0；37 files / **643 ok** |
| `node scripts/claims-selftest.mjs` | EXIT=0；**78 checks** |
| `node scripts/tool-surface-selftest.mjs` | EXIT=0；**41** |
| `npm run bench:scale` | EXIT=0；**11/11**；100k first page 0.55 ms；restart first page 1.95 ms；dispatch max 29.8 ms / p95 28.4 ms / starts 161 |
| `node scripts/strict-writes-selftest.mjs` | EXIT=0；**17**；bypass 0；“only the deliberate bypasses were rejected” |
| `node scripts/policy-selftest.mjs` | EXIT=0；**120** |
| `node scripts/client-smoke.mjs` | EXIT=0；**16/16** |
| `node scripts/replay-client-selftest.mjs` | EXIT=0；**8** |
| U14 partial probe | EXIT=0；restart 后 5 segments；first reopen 1.3 ms；list 81.5 ms；page1/page2 100/100；total 100000 |
| S12 restart first page | EXIT=0；first same-store 1.9 ms；first after reopen 1.3 ms；5 segments；total 100000；last 100000 |
| resource probe | EXIT=0；free/held/queue 可读；blockedBy `pool_gpu`；queue 3；无异常 |

回归没有发现新红；但回归全绿不能覆盖 §29.6.2/§29.6.3 这两个安全探针。

### 29.6.7 计数与判定

| 判定 | 数量 |
|---|---|
| PASS | **107** |
| FAIL | **57** |
| 未测量 | **10**（浏览器 2 行 = 不适用） |
| 合计 | **174** |

**FAIL 分解**：

- **1 个阻断（B27）**：§29.6.2 自提/串通 human + §29.6.3 并发 resolution 覆盖。
  B27 仍 FAIL；不是“只剩能力”。
- **56 个能力未建**：1.3、5.3.2/Q3、Stage 3–5 等既有能力缺口。
- **0 个只差文档**。

**明确判定：NO-SHIP。** 不满足“narrow release possible”。理由不是能力，
而是 B27 仍可用两条路径拿到 `humanConfirmed:true` 并执行 `prune`：

1. requester 自己/自己控制的 raiser 提 appeal，串通 human resolve；
2. 同一条 withdrawn appeal 的 rejected/upheld 并发 resolve，rejected 被
   last-writer-wins 覆盖成 upheld。

即使把第 1 条降级为“串通不在威胁模型”，第 2 条仍是可复现的代码级状态机
错误，必须修复后才能改判。**不软化结论**：作者 §29 的 108/56 不确认。

**如果** §29.6.8 的并发修复完成，并且串通被明确接受为身份认证的残余风险
（或加入独立的双人/外部身份机制），则独立计数可变为 **108/56/10**，届时才可
给出“**narrow release possible**”；排除范围必须显式写成：
`1.3`、`5.3.2`/Q3、Stage 3–5，以及未测量的 browser/provider/restart。
在这些条件满足前，不得使用该措辞。

### 29.6.8 修复建议（按优先级）

1. **resolution 状态原子化（阻断）**：
   - `intent.withdraw` 的 `resolve:true` 只允许当前
     `status ∈ {pending, withdrawn}`；当前已是 `resolved` 必须拒绝
     `intent_not_pending`。
   - 普通 withdraw 也必须拒绝 `resolved`；不能被并发撤回覆盖。
   - mutation 增加 `expectedStatus` / revision 条件（compare-and-set），不要只靠
     service 的旧 snapshot 检查。
   - 每条 appeal 只允许一个 resolution；重复 resolve 要么拒绝，要么幂等返回
     原记录，不能写第二条 `appeal/resolved` 事件。
   - 加并发 selftest：`Promise.all([rejected, upheld])` 必须一个成功、一个
     `intent_not_pending`，最终状态由成功者唯一决定，事件恰好 1 条。
2. **自提/串通（阻断或显式降级）**：
   - 最低限度要求 appeal raiser 与 action requester 不同；但这挡不住 requester
     让串通第三方 raise，只是缩小路径。
   - 若威胁模型包含“requester 控制两个身份”，仅靠 `actor.id` 永远不够；需要
     外部身份/双人确认/职责分离的信任根。当前代码不具备。
   - 在未实现前，B27 不能声称闭合。
3. **system**：保持 `resolveAppeal` 不在 agent tool action 中；如果 service
   直调属于威胁模型，需对 `exec` 做 Host 认证，不要让任意 in-process caller
   伪造 system。不要把 `lab-scheduler` 扩展成 intent 写权限。
4. **schema**：`humanConfirmed` removal 保持；可在 service 层对顶层旧字段返回
   明确迁移错误，而不是静默忽略；更新外部 caller 文档。
5. **测试**：把 §29.6.2/§29.6.3 的探针加入 `claims-selftest`；现有 78 checks
   没有覆盖并发与自提/串通。

### 29.6.9 边界

- 只修改了本文件；生产代码未改。
- 未执行 sandbox escalation；未写用户 storage。
- 浏览器二维未测；provider/restart 仍是既有未测量项，不因本轮回归全绿而消失。
- 结论对 HEAD `4d30c3a` 有效；若后续提交修改 `lab-service`/`mutations`，必须
  重新跑 §29.6.2/§29.6.3 并发探针，不能只跑 `npm test`。


---

## 30 第十一轮作者整改：scope + 三 actor + intent CAS（P19.7）

> 本节是作者对 §29.6.2/§29.6.3 的整改记录，不替代独立复核。独立总判定仍以
> **§29.6** 的 **107 PASS / 57 FAIL / 10 未测量（NO-SHIP）** 为准，直到验证者
> 重放本节探针。作者侧 claims-selftest 的计数从 78 增至 **89**。
> 第十二轮独立复核见 **§30.6**：scope/CAS 的精确探针通过，但实际 tool path
> 的 `delete_project`/`cancel_node`、actor id 后缀区分、action 写入 CAS 仍使
> B27 失败；**107 / 57 / 10（NO-SHIP）**。

### 30.1 authorizing resolution 必须精确 scope

- appeal 记录必须同时携带：
  - `target.nodeId`（具体节点，不允许 `null` 的 wildcard）；
  - `claim.targetAction`（该 appeal 授权的那一个不可逆 action）。
- `submitIntent` 在写边界拒绝 unscoped appeal，返回 `appeal_target_mismatch`。
  兼容读取 `actionOnTarget` / `forAction` / `claim.target.action` /
  `claim.authorization.action` 等别名字段，但落盘统一为 `claim.targetAction`。
- `resolveAppeal` 对没有精确 target+action 的记录返回 `appeal_target_mismatch`。
- `appealState` 只从精确 target+action 的 resolved appeal 派生 window 和 human
  confirmation；同 target 不同 action、同 action 不同 target、或 malformed
  legacy 记录都不能授权，并返回 `appeal_target_mismatch`。
- pending/withdrawn 仍按 target 阻断，避免一个已提出但未裁决的 objection 被
  action 绕过；授权本身严格按 pair。

### 30.2 三个 actor 必须两两不同

`appealState` 的 confirmation 现在要求：

1. `resolvedBy.kind` 是 `human` 或 `system`；
2. `resolution === 'upheld'`；
3. `resolvedBy.id`、`intent.actor.id`（raiser）、action requester 的 `id` 三者
   两两不同且均为非空字符串。

因此 requester 自己 raise 的 appeal，即使由另一个 human resolve，也不会成为
该 requester 的 human confirmation。`resolveAppeal` 仍保留 raiser != resolver
的 self-resolution 检查。

### 30.3 intent transition 的 compare-and-set

`intent.withdraw`（同时服务 `resolveAppeal` 和 `withdrawIntent`）现在要求：

- `expectedStatus`：mutation 内的当前状态必须与 service 读到的状态一致；
- `expectedRevision`：project revision 必须与调用方读取时一致；
- 状态比较先于 revision，因此并发 resolve 的失败方得到
  `intent_not_pending`，而不是泛化的 `stale_basis`；
- `resolved` 是终态：即使调用方省略 expected 字段，reducer 也拒绝再次
  `resolve:true` 或普通 withdraw；
- 每次 appeal 最多一条 `appeal/resolved` 事件。

`resolveAppeal`/`withdrawIntent` 现在把 mutation 的 `LabError` 转成正常的
`{ok:false,error:{code}}` rejection，所以并发调用不会以未捕获异常结束。

### 30.4 精确探针

| 探针 | 返回 |
|---|---|
| appeal 无 `claim.targetAction` | `appeal_target_mismatch` |
| appeal 无 `target.nodeId` | `appeal_target_mismatch` |
| resolved scope=`scope-target/prune_branch`，再 cancel 同一 target | `appeal_target_mismatch` |
| resolved scope=`scope-target/prune_branch`，再 prune 另一 target | `appeal_target_mismatch` |
| requester 自己 raise，另一 human resolve，requester 再 prune | `human_confirmation_required` |
| 请求只带顶层 `humanConfirmed:true` | `human_confirmation_required` |
| 并发 `rejected` / `upheld`（withdrawn appeal） | 一个 `ok:true`，一个 `intent_not_pending`；`appeal/resolved` 恰好 1 条 |

race 原始输出（`claims-selftest` 的 `RACE` 行）：

```text
RACE {"withdrawn":true,"calls":[{"ok":true,"resolution":"rejected","resolvedBy":"human-reviewer"},{"ok":false,"code":"intent_not_pending"}],"stored":{"status":"resolved","resolution":"rejected","resolvedBy":"human-reviewer"},"resolvedEvents":1}
RACE_WITHDRAW {"calls":[{"ok":true,"resolution":"upheld"},{"ok":false,"code":"intent_not_pending"}],"stored":{"status":"resolved","resolution":"upheld"},"transitionEvents":1}
```

同一组 CAS 也覆盖 `resolveAppeal` vs `withdrawIntent`：一个成功，另一个
`intent_not_pending`，transition event 恰好 1 条。

### 30.5 回归

| 命令 | 结果 |
|---|---|
| `npm test` | EXIT=0；37 files / **654 checks** |
| `node scripts/claims-selftest.mjs` | EXIT=0；**89 checks** |
| `npm run bench:scale` | EXIT=0；**11/11** |
| `node scripts/client-smoke.mjs` | EXIT=0；**16/16** |
| `node scripts/strict-writes-selftest.mjs` | EXIT=0；所有 checks 通过 |

作者侧 B27 的 §29.6.2/§29.6.3 两条红项已由本节探针覆盖；独立计数仍等待
验证者重放，不由本节改写。

---

## 30.6 第十二轮独立复核（HEAD `e85b213`，2026-11-10）

> 复核人：独立验证者。只读复跑 + 独立探针；生产代码未改。采样时间
> `2026-11-10T20:26:56+08:00`（`Asia/Shanghai`）；浏览器时区不可用。
> 对象：作者 §30 的 scope + 三 actor + intent CAS 整改。
>
> **结论：作者 §30 的精确 intent 探针通过，但 B27 仍未闭。** 独立计数
> **107 PASS / 57 FAIL / 10 未测量**，**NO-SHIP**。不写
> “narrow release possible”。

### 30.6.1 作者 §30 精确探针

| 探针 | 独立结果 | 判定 |
|---|---|---|
| 并发 `rejected` / `upheld`（同一 withdrawn appeal） | 一个 `ok:true`；另一个 `intent_not_pending`；stored 为胜者；`appeal/resolved` 恰好 1 条 | 通过；§29.6.3 的 last-writer-wins 已修 |
| 并发两个 `upheld` | 一个 `ok:true`；另一个 `intent_not_pending`；1 条事件 | 通过 |
| pending appeal：resolve vs withdraw | resolve `ok:true`，withdraw `intent_not_pending`；1 条 transition | 通过 |
| withdrawn appeal：resolve vs withdraw | resolve `ok:true`；withdraw 返回 `ok:true, alreadyWithdrawn:true`（幂等 no-op）；不覆盖 resolution | 通过；注意“两个 ok”不是两个 transition，withdraw 未写状态 |
| resolved appeal 的 scope=`scope-target/prune_branch`，再 cancel 同 target | `appeal_target_mismatch` | 通过；resolved 不能跨 action |
| 同上，再 prune 另一 target | `appeal_target_mismatch` | 通过；不能跨 target |
| resolver 自己 raise，另一 human resolve，requester 再执行 | `human_confirmation_required` | 通过；requester=raiser 被挡住 |
| 三 actor 两两不同（advisor raise、h2 resolve、h1 execute） | `ok:true`；`humanConfirmedBy=h2` | 通过 |
| appeal 缺 `targetAction` | `appeal_target_mismatch` | 通过 |
| appeal 缺 `target.nodeId` | `appeal_target_mismatch` | 通过 |
| 请求只带顶层 `humanConfirmed:true` | `human_confirmation_required` | 通过；请求字段仍非确认 |

### 30.6.2 B27 失败一：实际 tool path 直接执行不可逆动作

这是本轮最严重的失败，且不需要伪造 resolver、不需要 appeal、不需要 CAS 竞争。
实际 `metainfer_lab` tool 的两个 handler：

```js
// host/lab-service.js:4015-4016
if (action === 'delete_project') return deleteProject(input?.projectId, ...);
if (action === 'cancel_node') return runtime.cancel(input?.projectId, input?.nodeId);
```

它们**没有**经过 `submitIntent`、`gateClaimAction`、`humanConfirmed` 或 appeal
resolution。独立探针使用真实的 `registerAgentTool` wrapper 和 human session：

| 探针 | 输出 |
|---|---|
| `delete_project`，human exec，无任何 appeal/resolution，项目只有 completed 节点 | `{"deleted":true,"projectId":"del1","worktreesRemoved":0}`；随后 `store.getProject('del1')` 为 `undefined` |
| `delete_project`，human exec，**不传 `nodeId`** | 同样 `{"deleted":true,...}`，项目被删 |
| `cancel_node`，human exec，无任何 appeal/resolution | `{"ok":true,"cancelled":true,"nodeId":"n1"}`；runtime 的 `cancel()` 被调用 |
| 同上，advisor / chief exec | `forbidden_action`（policy 只允许 human） |
| 直接 `service.deleteProject('del3')` | `{deleted:true}`；同样没有 claim gate |

代码事实：

- `deleteProject`（`host/lab-service.js:2555`）只检查 `project_busy`，然后
  `kernel.executor.deleteProject`；没有 `humanConfirmed`。
- `runtime.cancel`（`host/runtime.js:1588`）直接 terminate/cancel node；没有
  `humanConfirmed`。
- `ACTION_ENUM` 同时暴露 `delete_project` / `cancel_node`；human 是
  `authorizeAction` 允许的执行者，但 B27 要求的是**独立的人类确认**，不是
  “执行者恰好是人类”。
- **`delete_project` 甚至可以无 target 执行**，因此 §30.1 的
  target+action scope 对这条真实路径完全不存在。

结论：B27 在真实 tool path 上仍可直接绕过。这不是“intent 语义不完整”，而是
有实际执行 handler 没有接入 claim gate。该失败独立于 §30.6.3/§30.6.4，足以
维持 **NO-SHIP**。

### 30.6.3 B27 失败二：三 actor 只比较字符串，case/whitespace/suffix 仍通过

`appealState` 的 confirmation 只做：

```js
resolvedBy.id !== requester.id
resolvedBy.id !== intent.actor.id
```

没有 trim、大小写规范化、session 后缀校验，也没有外部身份。独立探针（每个
target 隔离；raiser=`advisor`，action requester=`h1`）：

| resolver id | 结果 |
|---|---|
| `H1`（仅大小写不同） | `prune ok:true`；`humanConfirmedBy.id='H1'` |
| `h1 `（尾随空格） | `prune ok:true`；`humanConfirmedBy.id='h1 '` |
| `h1:resolver`（session 后缀） | `prune ok:true`；`humanConfirmedBy.id='h1:resolver'` |
| `h2`（真正不同） | `prune ok:true`（合法三 actor 对照） |

即同一个 human 用 `H1` / `h1 ` / `h1:resolver` 任一 session id，都能作为
requester `h1` 的“独立”确认者。用户明确要求测试“只差 case/whitespace/session
suffix 的 actor id”；这里 **distinct 只到字符串层**，没有到身份层。

这一条与 §30.6.2 独立：即使把所有执行 handler 接回 gate，字符串级三 actor 仍
可被同一人绕过。

### 30.6.4 B27 失败三：action 写入没有 CAS，check 与 write 之间可插入 withdrawn appeal

作者 §30.3 的 CAS 只加在 `intent.withdraw`（`resolveAppeal` /
`withdrawIntent`）。`submitIntent` 的 action commit 仍是：

```js
const gate = gateClaimAction(...);   // 读旧 project snapshot
...
const commit = await commitMutations(...); // 没有 expectedRevision
```

独立探针用受控延迟命中这个窗口（不是修改生产代码，而是让 action 的 commit
停在测试 harness 中）：

1. target 先有一条 exact resolved/upheld appeal；action 的 gate 看到
   `humanConfirmed=true`，准备写 action；
2. 在 action commit 之前，提交一条新的同 target+action appeal 并 withdraw；
   `store` 中此时已有 `status=withdrawn`；
3. 释放 action commit。

结果：

```json
{
  "beforeRelease": [
    { "status": "resolved", "action": "prune_branch" },
    { "status": "withdrawn", "action": "prune_branch" }
  ],
  "action": {
    "ok": true,
    "gate": {
      "humanConfirmed": true,
      "appealPending": false,
      "appealUnresolved": false
    }
  },
  "final": [
    { "status": "resolved", "action": "prune_branch" },
    { "status": "withdrawn", "action": "prune_branch" },
    { "status": "pending", "action": "prune_branch" }
  ]
}
```

action 的 gate 里 `appealUnresolved=false`，但 final project 已经有 withdrawn
appeal；action 仍然通过。这正是用户要求的 “action must not slip in between
check and write”。根因是 action commit 没有 `expectedRevision`/transactional
recheck；CAS 只保护 appeal transition，不保护 action authorization 的读取。

对用户四个 CAS 问题的逐项结果：

| 探针 | 结果 |
|---|---|
| 你原来的 exact `Promise.all(rejected, upheld)` | 一个成功、一个 `intent_not_pending`；1 条 `appeal/resolved`；**已修** |
| race 两个 `upheld` | 一个成功、一个 `intent_not_pending`；1 条事件；**已修** |
| resolve vs withdraw（pending） | 一个成功、一个 `intent_not_pending`；1 条 transition；**已修** |
| resolve vs withdraw（already withdrawn） | resolve 成功；withdraw 幂等 `ok, alreadyWithdrawn`；不覆盖 resolution；**安全** |
| resolve + prune（withdrawn appeal，同一 Promise.all） | resolve 成功；prune 得到 `appeal_not_resolved`（gate 在 resolve 前读取）；**没有 slip**；若 resolve 先完成，prune 可能合法通过，这是时间顺序而非 stale write |
| action 与新 withdrawn appeal 竞争 check/write | **action `ok:true`，unresolved 已存在；失败** |

### 30.6.5 Target+action scope 的精确结果与边界

**授权范围（正确）**：

- resolved `prune_branch` on node A：prune A `ok:true`；cancel A
  `appeal_target_mismatch`；prune B `appeal_target_mismatch`。
- resolved `delete_project` on node A：只有 target node A 的 intent 路径能通过；
  其他 node 或 `target=null` 返回 `appeal_target_mismatch`。
- aliases：`actionOnTarget`、`forAction`、`claim.target.action`、
  `claim.authorization.action`、`claim.scope.action` 都能被读取并落盘为
  `claim.targetAction`；执行另一个 action（如 alias=prune、实际 cancel）都返回
  `appeal_target_mismatch`；执行同一 action 才通过。冲突 alias
  （`targetAction=prune` + `actionOnTarget=cancel`）以 `targetAction` 为准，
  cancel 失败、prune 通过。**aliases 没有授权不同的实际执行 action。**

**阻断范围（有行为问题）**：

同一 node 上不同 action 的 pending/withdrawn appeal：

| 场景 | 结果 |
|---|---|
| node E 有 resolved prune + pending cancel；执行 prune E | `appeal_pending`（被 foreign pending 挡住） |
| node D 有 withdrawn prune；执行 cancel D | `appeal_not_resolved`（被 foreign withdrawn 挡住） |
| node C 有 pending prune；执行 cancel C | `appeal_pending` |
| node F 有 resolved prune + resolved cancel；执行 prune F / cancel F | 两者都 `ok:true`（各自 exact resolution） |

`pending` 和 `unresolved` 是 **target-wide**，不是 exact action；作者的
“pending/withdrawn by target” 设计使一个 action 的 pending/withdrawn 可以阻断
同 node 的另一个 action。这是 fail-closed（不会多授权），但会造成跨 action
拒绝服务。若验收要求“pending/withdrawn 也只按 exact action 阻断”，这是
**失败**；若接受 target-wide stop-the-line，则记录为行为取舍，不是 B27
越权。独立报告不把它当作唯一 blocker，但把它列为 §30.6.5 的行为发现。

**missing / delete 的边界**：

- appeal 无 `targetAction` / 无 `target.nodeId`：`appeal_target_mismatch`。
- action 无 `nodeId`：在无 foreign appeal 的 fresh project 会落到
  `human_confirmation_required`；在存在 foreign resolved 的 project 返回
  `appeal_target_mismatch`。两种都不授权，但没有专门的 `node_required` 错误。
- `delete_project` 的 intent 路径**必须**有 node target：无 node 的 delete
  intent 被 `appeal_target_mismatch` 挡住；有 node 的 delete intent 可以过。
  但 `delete_project` 是 project-wide 动作，**实际 tool path 根本不看 node**
  （§30.6.2），所以这条“node scope”只存在于 intent，不能约束真实删除。
- **unscoped appeal** 被写边界拒绝，正确。

### 30.6.6 同一 raiser 的两个 appeal

| 场景 | 结果 |
|---|---|
| 两个 pending（同 raiser、同 target+action） | action `appeal_pending`；安全 |
| 一个 rejected + 一个 upheld（不同 human） | action `ok:true`；gate 取 upheld，rejected 被跳过 |
| 一个 withdrawn + 一个 upheld | action `appeal_not_resolved`；安全 |
| 两个 upheld（不同 human） | 可执行；取其中一个 confirmation |

同一 raiser 可以对同一 pair 重复提交 appeal；代码没有唯一性约束。`rejected`
和 `upheld` 两条不同记录不会把 rejected 读成 upheld（`confirmation` 明确检查
`resolution==='upheld'`），所以不是 §29.6.3 的 last-writer 问题；但一个被
rejected 的 objection 之后可以用同一 raiser 的第二张 appeal 得到 upheld。
如果政策要求“一个 raiser 对同一 pair 只能有一个终局 appeal”，当前实现没有
强制；独立报告记为**未定义语义/可滥用重复提交**，不是主要执行路径。

### 30.6.7 system 与 humanConfirmed

- **真实 tool path**：`lab-scheduler` `intent_submit` / `intent_withdraw` 返回
  `forbidden_action`；`resolveAppeal` 不在 tool action enum，返回
  `unknown_action`；没有 system resolver 的 agent 路径。
- **直接 service**：`resolveAppeal(..., systemExec)` 仍可写
  `resolvedBy.kind='system'`；这是 Host 内部 service，不是 tool。
- **实际 tool path 的 human**：`delete_project`/`cancel_node` 直接执行，
  比 system 冒充更严重（§30.6.2）。
- **`humanConfirmed` 请求字段**：tool schema 顶层仍无该字段；`claim` 描述无；
  service strip `claim.humanConfirmed`/`humanConfirmedBy`；合法 resolved
  appeal 路径正常；无 resolution 时请求标志仍 `human_confirmation_required`。
- **新失败不是因为旧字段回来**：旧字段仍是死的；失败来自实际 handler 和
  action CAS。

### 30.6.8 回归（HEAD `e85b213`）

| 命令 | 结果 |
|---|---|
| `npm test` | EXIT=0；37 files / **654 ok** |
| `node scripts/claims-selftest.mjs` | EXIT=0；**89 checks** |
| `node scripts/tool-surface-selftest.mjs` | EXIT=0；**41** |
| `npm run bench:scale` | EXIT=0；**11/11**；100k first page 0.42 ms；restart 1.83 ms；dispatch max 35.3 ms / p95 32.6 ms / starts 161 |
| `node scripts/strict-writes-selftest.mjs` | EXIT=0；**17**；bypass 0；“only the deliberate bypasses were rejected” |
| `node scripts/policy-selftest.mjs` | EXIT=0；**120** |
| `node scripts/client-smoke.mjs` | EXIT=0；**16/16** |
| `node scripts/replay-client-selftest.mjs` | EXIT=0；**8** |
| U14 partial probe | EXIT=0；3 次 `refresh_partial`，前两次 `degraded=false`，第三次 `degraded=true`；`previousSuccess=true`；good widget stale=false / bad widget stale=true |
| S12 restart first page | EXIT=0；first same-store 2 ms；reopen 1.3 ms；list 112.6 ms；5 segments；total 100000；last 100000 |

回归全绿，但不覆盖 §30.6.2–§30.6.4 的实际执行/CAS 攻击。

### 30.6.9 计数与判定

| 判定 | 数量 |
|---|---|
| PASS | **107** |
| FAIL | **57** |
| 未测量 | **10**（浏览器 2 行 = 不适用） |
| 合计 | **174** |

- **1 个阻断：B27**。至少三条独立失败：
  1. 实际 `delete_project` / `cancel_node` tool path 绕过 claim gate；
  2. case/whitespace/session-suffix actor id 绕过三 actor 区分；
  3. action check/write 之间没有 CAS，新 withdrawn appeal 可被 action 跨过。
- **56 个能力未建**：1.3、5.3.2/Q3、Stage 3–5 等既有能力缺口。
- **0 个只差文档**。

**明确判定：NO-SHIP。** 不满足 “narrow release possible”。作者 §30 的
scope/CAS 探针在 intent 层变绿，但真实 tool path 仍可直接删除项目/取消节点；
这不是能力问题，而是 B27 的执行路径漏洞。作者侧 **654 checks / 89 claims**
不覆盖这些路径。

**如果** 修复 §30.6.10 的 1–3 项，且剩余 56 项确认为 capability-not-built，
独立计数才可改为 **108 / 56 / 10**，届时才可使用 “narrow release possible”；
排除范围必须显式写成 `1.3`、`5.3.2`/Q3、Stage 3–5，以及未测量的
browser/provider/restart。当前不得使用该措辞。

### 30.6.10 修复建议

1. **真实执行路径接入 gate**：`delete_project` 和 `cancel_node` 不能直接
   `deleteProject`/`runtime.cancel`。要么要求已存在通过 gate、未过期、有精确
   target+action 的 action intent（并由 executor 执行），要么在 handler 内
   重新做完整 `humanConfirmed` + appeal scope 校验；不能只靠 humanOnly。
   `delete_project` 还需定义 project-wide 的 target 语义，不能用 node 级
   resolution 授权整项目删除。
2. **action commit CAS**：在 `submitIntent` 的 `intent.put` 上带
   `expectedRevision`（gate 读取的 revision），并在 mutation 内拒绝 revision
   变化；或者把 gate 重新校验与 action 写入放在同一个锁/事务中。仅给
   `intent.withdraw` 加 CAS 不够。
3. **actor 身份**：如果威胁模型包含 case/whitespace/suffix，必须做 canonical
   identity（至少 trim/大小写规则，session suffix 规则），但字符串规范化仍不能
   证明“不同的人”；最终需要外部身份/双人确认/职责分离。仅比较 id 字符串
   不是独立确认。
4. **scope 阻断语义**：决定 pending/withdrawn 是 exact action 阻断还是
   target-wide stop-the-line；若是 exact，`pending`/`unresolved` 也应使用
   `exactRows`，不要让 foreign pending 阻断无关 action。若是 target-wide，
   在文档中明确这是可用性取舍，避免被当作 exact scope。
5. **delete scope**：为 project-wide delete 定义独立 target/authorization，
   不允许 node 级 appeal 授权整项目删除；实际 tool handler 和 intent handler
   必须一致。
6. **重复 appeal**：决定同一 raiser/target+action 是否允许第二张 appeal；
   若不允许，写入边界拒绝；若允许，明确 rejected 后重新提交的语义。
7. **测试**：把 §30.6.2–§30.6.4 加进 selftest；现有 89 checks 没有覆盖实际
   tool handler、actor 后缀、action CAS。实际 tool path 的 `delete_project`
   必须在一个临时项目上做“无 appeal 必须失败”的负向测试。

### 30.6.11 边界

- 只修改了本文件；生产代码未改。
- 未执行 sandbox escalation；未写用户 storage。
- 浏览器二维未测；provider/restart 仍是既有未测量项。
- 结论对 HEAD `e85b213` 有效；后续修改 `lab-service.js`、`runtime.js`、
  `mutations.js` 或 `agent-tool.js` 后，必须重跑实际 delete/cancel、actor
  suffix、action CAS 三组探针，不能只跑 `npm test`。

---

## §31 作者第十二轮整改：执行路径、canonical actor、action CAS、exact scope

> 这是作者侧整改记录，不是独立复核。§30.6 的独立判定仍为
> **107 PASS / 57 FAIL / 10 未测量，NO-SHIP**；只有验证者重放下述探针后才可改口径。
> 第十三轮独立复核见 **§32**：handler/CAS/scope 通过，simple canonical 通过，
> 但 Unicode/case-fold/format-character 变体仍可绕过，**107 / 57 / 10
> （NO-SHIP）**。

### 31.1 本轮代码改动

1. **真实 handler 接入 gate**（`host/lab-service.js`）
   - `delete_project` 的 tool handler 不再直接调用 executor，而是在删除前调用
     `authorizeIrreversibleTool(projectId, 'delete_project', options, exec)`。
   - `cancel_node` 的 tool handler 不再直接调用 `runtime.cancel`，而是在取消前调用
     `authorizeIrreversibleTool(projectId, 'cancel_node', { nodeId, ... }, exec)`。
   - `authorizeIrreversibleTool` 重新计算 citation floor、fresh evidence、
     chief confirmation、精确 target+action appeal、pending/unresolved 和
     human resolution；失败抛 `LabError`，不会到达删除/取消。
   - `deleteProject` 在 `auto.stop`（会写 `auto/stopped` 事件、推进 revision）之后
     重新做一次授权，避免用旧 revision 做 CAS；任何破坏性 worktree 删除和
     `kernel.executor.deleteProject` 都在 gate 之后。
   - `delete_project` 的授权 scope 是 `{ projectId }`，并显式拒绝 `nodeId`；
     node 级 appeal/resolution 不能授权整项目删除。`cancel_node` 的授权 scope
     是 `{ nodeId }`，缺少 nodeId 返回 `bad_request`，未知 node 返回
     `node_not_found`。
   - `deleteProject` 的 executor CAS 使用 `expectedRevision`；失败返回
     `stale_basis`（HTTP 409），不删除项目。

2. **canonical actor**（`host/kernel/policy.js`）
   - 新增 `canonicalActorId`：`trim`、`toLowerCase`、去掉第一个 `:`/`#`/`@` 之后的
     transport/session suffix，再次 `trim`。
   - `actorForSession` 和 executor 的 `normalizeActor` 都写 canonical id。
   - `appealState` 的 raiser/requester/resolver 比较和 `resolveAppeal` 的 self
     resolution 检查都按 canonical id；`H1`、`h1 `、`h1:resolver` 是同一个 actor。

3. **action commit CAS**（`host/kernel/mutations.js`、`host/kernel/executor.js`、
   `host/runtime.js`）
   - `submitIntent` 的 action `intent.put` 携带 gate 读取的
     `expectedRevision: project.revision`；`intent.put` 在 mutation 内检查
     `ws.project.revision`，不一致抛 `stale_basis`。
   - `deleteProject` 的 executor 在项目锁内检查 `expectedRevision`；runtime 的
     planned cancel 在锁外和锁内各检查一次，active terminate 在终态
     `persistNode` 前检查 `expectedRevision`，并把 `expectedProjectRevision`
     传给 executor。
   - gate 之后的 appeal/withdrawal 会推进 revision，action write 因此失败；不会
     出现“authorization 读的是旧快照、action 却落盘”的情况。

4. **exact target+action 的 pending/withdrawn/window/resolved**
   （`host/lab-service.js`）
   - `appealState` 的 `pending`、`unresolved`、`windowed`、`confirmation` 都从
     `exactRows` 取；`exactRows` 同时匹配 `scope key` 和 `targetAction`。
   - 一个 node 上 pending/withdrawn 的 `prune_branch` 不再阻断同一 node 的
     `cancel_running`，反之亦然；精确的 pending/withdrawn 仍阻断精确 action。
   - 代价是保留 fail-closed 的 `targetMismatch`：存在 malformed / 非精确 resolved
     record 且没有精确 resolved 时，动作不会借别的 action/node 的 resolution 通过。

### 31.2 真实 agent-tool / direct-service 探针（逐字）

```text
HANDLER_PROBES {"deleteWithNodeId":{"code":"appeal_target_mismatch","projectExists":true},"deleteWithoutNode":{"code":"human_confirmation_required","projectExists":true},"cancelWithoutAppeal":{"code":"human_confirmation_required","runtimeCalls":0},"cancelWithoutNode":{"code":"bad_request","runtimeCalls":0},"directDelete":{"code":"human_confirmation_required","projectExists":true},"directCancel":{"code":"human_confirmation_required","runtimeCalls":0}}
```

四个必须负向探针（真实 `registerAgentTool` + `registerAgentTool.execute`）的结论：

- `delete_project` + nodeId + 无 appeal：`appeal_target_mismatch`，项目仍在；
- `delete_project` + 无 nodeId + 无 appeal：`human_confirmation_required`，项目仍在；
- `cancel_node` + nodeId + 无 appeal：`human_confirmation_required`，`runtime.cancel` 从未调用；
- `cancel_node` + 无 nodeId：`bad_request`，`runtime.cancel` 从未调用。

另加两个 direct-service 负向探针：`service.deleteProject` 和
`service.cancelNode` 都返回/抛出 `human_confirmation_required`，项目仍在，
`runtime.cancel` 仍未调用。

正向控制：

- project-scoped resolved delete appeal + funded history → 真实 tool
  `delete_project` 成功，项目被删除；
- node-scoped resolved cancel appeal + fresh evidence + chief → 真实 tool
  `cancel_node` 到达 runtime，且传给 runtime 的 `expectedRevision` 是整数。

### 31.3 canonical actor 探针（逐字）

```text
ACTOR_CANONICAL [{"resolverId":"H1","resolved":true,"stored":"h1","code":"human_confirmation_required"},{"resolverId":"h1 ","resolved":true,"stored":"h1","code":"human_confirmation_required"},{"resolverId":"h1:resolver","resolved":true,"stored":"h1","code":"human_confirmation_required"}]
```

三次都是：requester `h1`、raiser `expert-1`、resolver 分别使用 `H1`/`h1 `/
`h1:resolver`；三次都因 requester==resolver 被拒，存储的 `resolvedBy.id` 都是
`h1`。对应三条独立 selftest check，而不是一个聚合断言。

### 31.4 action commit CAS 延迟探针（逐字）

```text
ACTION_CAS {"expectedRevision":74,"currentRevision":76,"injectedWithdrawn":true,"code":"stale_basis","final":[{"status":"resolved","resolution":"upheld"},{"status":"resolved","resolution":"upheld"},{"status":"withdrawn","resolution":null}]}
```

探针在 `kernel.executor.commit` 的动作写入前插入一条新的同 target+action appeal，
随后 withdraw，再放行动作。动作 commit 的 `expectedRevision` 是 74，实际 revision
已到 76；结果不是 `ok:true`，而是 `stale_basis`。这说明 CAS 在 mutation/commit
边界，而不是只在 gate 前做一次检查。

### 31.5 exact scope 探针（逐字）

```text
SCOPE_FOREIGN {"resolved":true,"pendingExactPrune":true,"withdrawn":true,"withdrawnExactPrune":true,"pendingGate":false,"withdrawnGate":false}
```

同一 node 上：先 resolved 一条 `prune_branch` appeal，再 pending 一条
`cancel_running` appeal，`prune_branch` 仍成功且 gate 的 `appealPending=false`；
withdraw 该 cancel appeal 后，`prune_branch` 仍成功且 `appealPending=false`。
这说明 foreign pending/withdrawn 不再 DoS 精确 action；精确 pending/withdrawn 的
阻断仍由既有断言覆盖。

### 31.6 测试结果

| 命令 | 结果 |
|---|---|
| `npm test` | EXIT=0；37 个文件 / **668 checks** |
| `node scripts/claims-selftest.mjs` | EXIT=0；**103 checks** |
| `node scripts/strict-writes-selftest.mjs` | EXIT=0 |
| `node scripts/client-smoke.mjs` | EXIT=0；16/16 panels |
| `npm run bench:scale` | EXIT=0；11/11 |

`strict-writes` 的直接删除仍走 `kernel.executor.deleteProject`（write-permit
路径），不再调用已加 gate 的 public service handler；这避免测试用公共入口绕过
gate，同时保留 executor 的“permitted delete”覆盖。

### 31.7 边界

- 只做作者侧修改与作者侧探针；没有独立复核，不能把 §30.6 的 107/57/10 改成
  108/56/10。
- 未执行 sandbox escalation；未写 `~/.dsh/storages/*`；未重启 Host。
- 浏览器二维仍 N/A；provider/restart 仍是既有未测量项。
- canonical id 只是字符串规范化，不能证明“不同的人”。真正的双人独立意志仍需
  外部身份/审批；本轮只移除 case/whitespace/session-suffix 的明显绕过。
- `delete_project` 的实际 handler 正向路径已覆盖 project-scoped appeal；node 级
  delete appeal 被写边界和实际 handler 双重拒绝。

---

## §32 第十三轮独立复核（HEAD `4a209bc`，2026-11-10）

> 复核人：独立验证者。真实 `registerAgentTool` wrapper + direct service + 独立
> probe；生产代码未改。采样时间 `2026-11-10T20:48:33+08:00`（`Asia/Shanghai`）；
> 浏览器时区不可用。
>
> **结论：作者 §31 的 handler gate、action CAS、exact scope 三项在 ASCII 范围通过；
> B27 仍因 canonical identity 的 Unicode/case-fold 缺口失败。**
> 独立计数 **107 PASS / 57 FAIL / 10 未测量**，**NO-SHIP**。

### 32.1 真实 handler / direct service 探针

使用真实 tool wrapper（`tool.execute(input, humanExec)`）和 `service.deleteProject` /
`service.cancelNode`。负向探针均未到达删除/取消：

| 探针 | 输出 | 项目/运行时 |
|---|---|---|
| tool `delete_project`，无 nodeId、无 appeal | `human_confirmation_required` | 项目仍存在 |
| tool `delete_project`，有 nodeId、无 appeal | `appeal_target_mismatch`（“project-scoped and does not accept a nodeId”） | 项目仍存在 |
| direct `deleteProject`，无 appeal | `human_confirmation_required` | 项目仍存在 |
| tool `cancel_node`，无 appeal | `human_confirmation_required` | `runtimeCalls=[]` |
| tool `cancel_node`，无 nodeId | `bad_request`（“nodeId is required”） | `runtimeCalls=[]` |
| direct `cancelNode`，无 appeal | `human_confirmation_required` | `runtimeCalls=[]` |

正向控制：

| 探针 | 输出 |
|---|---|
| project-scoped resolved delete appeal + clean history → tool delete（无 nodeId） | `{"deleted":true,...}`；项目被删除 |
| 同上但请求仍带 nodeId | `appeal_target_mismatch`；项目仍在（node-scope 不能搭 project resolution） |
| direct `deleteProject` + project-scoped resolved appeal | `{deleted:true}`；项目被删除 |
| node-scoped resolved cancel appeal + fresh evidence + chief → tool `cancel_node` | `{"ok":true,"cancelled":true}`；runtime 收到 `expectedRevision=3`（整数） |
| 同上 direct `cancelNode` | `ok:true`；runtime 收到 `expectedRevision=3` |
| project-scoped delete resolution → `cancel_node` | `appeal_target_mismatch`；`runtimeCalls=[]` |

**结论：§30.6.2 的实际 handler 绕过已修。** 负向全部 fail closed，正向在
correctly-scoped resolution 下成功。

### 32.2 canonical identity：ASCII 通过，Unicode/case-fold 仍绕过

#### 32.2.1 作者声明的三种变体

requester `h1`、raiser `advisor`、resolver 分别：

| resolver raw | stored `resolvedBy.id` | action |
|---|---|---|
| `H1` | `h1` | `human_confirmation_required` |
| `h1 ` | `h1` | `human_confirmation_required` |
| `h1:resolver` | `h1` | `human_confirmation_required` |
| `h1:resolver:extra` | `h1` | `human_confirmation_required` |
| `h1#resolver` | `h1` | `human_confirmation_required` |
| `h1@resolver` | `h1` | `human_confirmation_required` |
| `h1\u00a0` (NBSP) | `h1` | `human_confirmation_required` |
| `h1\t` / `h1\u3000` / `h1\ufeff` / `h1\u2028` | `h1` | `human_confirmation_required` |

这些是作者 §31.3 的探针，独立复跑通过。

#### 32.2.2 未覆盖的 Unicode / 格式字符变体

同一 requester `h1`、raiser `advisor`，resolver 换成：

| resolver raw | stored `resolvedBy.id` | action |
|---|---|---|
| `ｈ１`（全角 h1） | `ｈ１` | **`ok:true`**，`humanConfirmedBy=ｈ１` |
| `h1\u200b`（零宽空格） | `h1\u200b` | **`ok:true`** |
| `h1：resolver`（全角冒号） | `h1：resolver` | **`ok:true`** |
| `h1.resolver` | `h1.resolver` | **`ok:true`** |
| `h1/resolver` | `h1/resolver` | **`ok:true`** |
| `h1\u200dresolver`（ZWJ） | `h1\u200dresolver` | **`ok:true`** |
| `h1\u0301`（组合附加符） | `h1\u0301` | **`ok:true`** |
| `h1\u0000resolver`（NUL） | `h1\u0000resolver` | **`ok:true`** |
| `h1 resolver`（内部空格） | `h1 resolver` | **`ok:true`** |
| `h1%2Fresolver` | `h1%2fresolver` | **`ok:true`** |
| `İ`（土耳其大写 I） | `i̇` | **`ok:true`** |
| `ß` / `ẞ` | `ß` | **`ok:true`** |
| `ſ`（long s） | `ſ` | **`ok:true`** |
| `K` / `K`（Kelvin） | `k` | `human_confirmation_required`（这个 case-fold 覆盖到了） |
| `SS` / `ss` | `ss` | `human_confirmation_required`（这个覆盖到了） |

`canonicalActorId` 只做 `trim`、`toLowerCase`、去掉 `:`/`#`/`@` 后的 suffix；它
不是 Unicode case-fold，也不是 NFKC：

- `toLowerCase("İ")` 是 `i` + combining dot，不是 `i`；
- `toLowerCase("ß")` 是 `ß`，不是 `ss`；`ẞ` 是 `ß`；
- `ſ` 不会被 case-fold 成 `s`；
- `ｈ１` 保持全角；`h1\u200b` 的零宽空格不在 `trim` 集合；
- 全角冒号 `：` 不等于 `:`，点/斜杠/百分号/内部空格也不在 suffix 规则。

#### 32.2.3 Unicode resolver 能让真实 irreversible handler 执行

不只 action intent：同一 `ｈ１` resolver 的 project-scoped delete appeal 让真实
`delete_project` 删除项目；node-scoped cancel appeal 让真实 `cancel_node` 调用
runtime：

```json
{
  "deleteUnicode": {
    "resolvedBy": "ｈ１",
    "delete": {"deleted": true},
    "exists": false
  },
  "cancelUnicode": {
    "resolvedBy": "ｈ１",
    "cancel": {"ok": true},
    "runtimeCalls": [{"expectedRevision": 3}]
  }
}
```

即：同一个 human 用 `ｈ１` 作为 resolver，requester 用 `h1`；canonical 比较认为
两者不同，真实删除/取消都通过。**B27 仍失败，且是可执行路径。**

#### 32.2.4 canonical 过宽：合法不同 actor 被折叠

同一 requester/resolver 分别是不同的合法字符串：

| requester | resolver | canonical | action |
|---|---|---|---|
| `alice@home.com` | `alice@work.com` | both `alice` | `human_confirmation_required`（误拒） |
| `team:alice` | `team:bob` | both `team` | `human_confirmation_required`（误拒） |
| `a#one` | `a#two` | both `a` | `human_confirmation_required`（误拒） |

这是 fail-closed，不是越权；但 `canonicalActorId` 把 `@`/`:`/`#` 后所有内容当
transport suffix，无法区分“session suffix”与“合法 namespace/local-part”。
它同时造成了 **Unicode 绕过**和 **合法 actor 误拒**两个方向的问题。

#### 32.2.5 “不同字段”探针

| 探针 | 结果 |
|---|---|
| legacy `resolvedBy.id='h1:resolver'`，requester `h1` | `human_confirmation_required`；canonical 比较拦截 |
| legacy `actor.id='h1:raiser'`，requester `h1` | `human_confirmation_required`；raiser==requester |
| legacy `actor.id='h2:raiser'` + `resolvedBy.id='H2'` | `human_confirmation_required`；raiser==resolver |
| `claim.humanConfirmedBy.id='h1'`，但 `resolvedBy.id='h2'` | `ok:true`；`claim.humanConfirmedBy` 被忽略，确认来自 `resolvedBy` |
| `resolutionBy` 替代字段（无 `resolvedBy`） | `human_confirmation_required`；替代字段不被接受 |
| `claim.resolvedBy` 替代字段（无 `resolvedBy`） | `human_confirmation_required`；claim 字段不被接受 |
| request 顶层 `claim.humanConfirmedBy` 无 appeal | `human_confirmation_required` |
| `exec.session.id='h2'`、`meta.sessionId='h1'` | 以 `session.id` 为准，resolver=`h2`；meta 字段不参与 |

结论：身份比较只认 canonical `resolvedBy.id` / `intent.actor.id` / requester
`actor.id`；把 requester id 放进 claim/alternate 字段不会制造确认。这个方向
是 fail closed 的。真正的失败是 32.2.2 的 Unicode 变体。

### 32.3 Action-commit CAS

#### 32.3.1 injected withdraw / resolve

在 action gate 之后、`intent.put` 之前暂停 action commit；分别插入：

- 同 target+action 的新 appeal，再 withdraw；
- 同 target+action 的新 appeal，再 resolve upheld。

结果：

```text
injectWithdraw: intercepted=1, action=stale_basis (expected 3, actual 5)
injectResolve:  intercepted=1, action=stale_basis (expected 3, actual 5)
```

两次 action 都没有落盘；final 只有 base resolved + 注入的 withdrawn/resolved
appeal。CAS 在 `intent.put` / executor 边界生效，不是只在 gate 前检查一次。

#### 32.3.2 race two irreversible actions

同一 project、两个不同 node，各自有 exact resolved `prune_branch` appeal，两个
action intent 同时提交：

```json
{
  "calls": [
    {"ok": true, "status": "pending", "target": {"nodeId": "n1"}},
    {"ok": false, "code": "stale_basis",
     "message": "project revision changed since authorization (expected 5, actual 6)"}
  ],
  "stored": [{"target": "n1", "status": "pending"}],
  "revision": 6
}
```

一个成功、一个 `stale_basis`；没有两个 action 同时基于同一 revision 落盘。

#### 32.3.3 delete handler CAS

在真实 `deleteProject` 的第二次授权之后、`kernel.executor.deleteProject` 之前
暂停；插入一条新的 project-scoped pending delete appeal：

```json
{
  "seen": {"expectedRevision": 3, "currentRevision": 3},
  "result": {"ok": false, "code": "stale_basis",
             "message": "project revision changed since authorization (expected 3, actual 4)"},
  "exists": true,
  "finalIntents": [
    {"status": "resolved", "action": "delete_project"},
    {"status": "pending", "action": "delete_project"}
  ]
}
```

项目仍在；CAS 阻止删除。**CAS 三项通过。**

### 32.4 Exact scope

| 探针 | 结果 |
|---|---|
| exact resolved prune + foreign pending cancel → prune | `ok:true`；gate `appealPending=false` |
| 再 withdraw foreign cancel → prune | `ok:true`；gate 仍 false |
| exact pending prune → prune | `appeal_pending` |
| exact withdrawn prune → prune | `appeal_not_resolved` |
| project delete resolved + foreign pending node cancel → delete | `deleted:true`；项目被删除 |
| node-scoped delete appeal at write boundary | `appeal_target_mismatch` |
| manual legacy node-scoped resolved delete appeal → delete | `appeal_target_mismatch`；项目仍在 |
| manual legacy resolved cancel appeal → delete | `appeal_target_mismatch`；项目仍在 |
| project-scoped delete pending → delete | `appeal_pending`；项目仍在 |
| 同上 withdrawn → delete | `appeal_not_resolved`；项目仍在 |
| node action appeal scoped to project (`prune_branch` target project) | `appeal_target_mismatch` |
| node action appeal without target (`cancel_running`) | `appeal_target_mismatch` |
| project delete appeal without target | `ok:true`，target=`{projectId}`；project scope 正确 |
| delete action without target（clean project） | `human_confirmation_required` |
| delete action with node target | `appeal_target_mismatch` |
| node action with project target (`cancel_running`) | `appeal_target_mismatch` |

**结论：§30.6.5 的 foreign pending 阻断问题已修，node/project scope 分离正确。**
project-scoped delete 只能由 project-scoped resolution 授权；node-scoped resolution
不能授权整项目删除；foreign pending/withdrawn 不再 DoS 精确 action。

### 32.5 回归（HEAD `4a209bc`）

| 命令 | 结果 |
|---|---|
| `npm test` | EXIT=0；**668 ok**（37 files） |
| `node scripts/claims-selftest.mjs` | EXIT=0；**103 checks** |
| `node scripts/tool-surface-selftest.mjs` | EXIT=0；**41** |
| `node scripts/policy-selftest.mjs` | EXIT=0；**120** |
| `npm run bench:scale` | EXIT=0；**11/11**；100k first page 0.65 ms；restart 2.06 ms；dispatch max 26.9 ms / p95 26.8 ms / starts 161 |
| `node scripts/strict-writes-selftest.mjs` | EXIT=0；**17**；bypass **0** |
| `node scripts/client-smoke.mjs` | EXIT=0；**16/16** |
| `node scripts/replay-client-selftest.mjs` | EXIT=0；**8**（既有项） |
| U14 partial probe | EXIT=0；3 次 `refresh_partial`，前两次 degraded=false，第三次 degraded=true；`previousSuccess=true` |
| S12 restart first page | EXIT=0；first same-store 2 ms；reopen 1.5 ms；list 106.2 ms；5 segments；total 100000；last 100000 |

回归全绿，但 claims 的 103 checks 与 Unicode/case-fold 探针不重叠；作者 §31.3
只测了 `H1`/`h1 `/`h1:resolver`。

### 32.6 计数与判定

| 判定 | 数量 |
|---|---|
| PASS | **107** |
| FAIL | **57** |
| 未测量 | **10**（浏览器 2 行 = 不适用） |
| 合计 | **174** |

- **1 个阻断：B27**。结构层三项已过：
  - 实际 handler 负向 fail closed，正向通过；
  - action CAS 的 injected withdraw/resolve 和 race two actions 均正确；
  - exact scope / node-vs-project 分离正确。
- B27 仍失败的唯一根因是 **canonical identity 未覆盖 Unicode/case-fold/
  format-character**：`ｈ１`、`h1\u200b`、`h1：resolver`、`h1.resolver`、
  `İ`、`ß`、`ſ` 等可让同一 human 以“不同 resolver”通过，且真实
  `delete_project`/`cancel_node` 可执行（32.2.3）。
- canonical 还把 `alice@home.com`/`alice@work.com`、`team:alice`/`team:bob`
  折叠为同一 actor，导致合法不同 human 被误拒（32.2.4）。这是可用性/正确性
  问题，不是越权，但说明 canonical 规则既不够全又太宽。
- **56 个能力未建，0 个只差文档。**

**明确判定：NO-SHIP。** 不能说 “narrow release possible”。作者 §31 的
668 checks / 103 claims 没有覆盖 Unicode/case-fold，且 canonical 规则本身不能
证明“不同的人”。

**如果** 把 canonical 修到真正的 Unicode 安全形式（NFKC + 完整 case-fold +
format/zero-width 处理，并保留合法 namespace），并把 §32.2.2/32.2.3 加入
selftest，且剩余 56 项确认为 capability-not-built，独立计数才可改为
**108 / 56 / 10**；届时排除范围必须显式写 `1.3`、`5.3.2`/Q3、Stage 3–5，以及
未测量的 browser/provider/restart。当前不得使用该措辞。

### 32.7 修复建议

1. **Canonical actor**：用 `normalize('NFKC')` + Unicode full case-fold
   （不是 `toLowerCase`），移除 zero-width/format 字符，统一全角/半角标点；
   但不要无条件把 `:`/`#`/`@` 后内容当 session suffix。应显式解析 transport
   suffix（例如只接受带 `session:` 前缀或已知分隔符的形式），保留合法
   namespace（`team:alice`、`alice@work.com`）。
2. **不要只用字符串证明不同人**：canonical 只能去掉拼写绕过，不能替代外部
   身份/双人确认；B27 的最终证明需要职责分离/外部身份，而不是更复杂的
   normalize。
3. **测试**：把 `ｈ１`、`h1\u200b`、`h1：resolver`、`h1.resolver`、`İ`、
   `ß`、`ſ`、`alice@home.com`/`alice@work.com` 加入 claims-selftest，并用真实
   `delete_project`/`cancel_node` handler 做 positive/negative，不只测 intent。
4. **保持本轮已通过的结构**：handler gate、action commit CAS、delete handler
   CAS、foreign pending 不阻断、project/node scope 分离都应作为回归保留；不要
   为了修 canonical 回退这些。
5. **scope 边界**：project delete appeal 可以没有 target node（target 是
   project），node action 必须恰好有 node；保持 32.4 的矩阵。

### 32.8 边界

- 只修改了本文件；生产代码未改。
- 未执行 sandbox escalation；未写 `~/.dsh/storages/*`；未重启 Host。
- 浏览器二维未测；provider/restart 仍是既有未测量项。
- 结论对 HEAD `4a209bc` 有效；后续修改 `policy.js`、`lab-service.js`、
  `runtime.js`、`executor.js`、`mutations.js` 后，必须重跑 handler、Unicode
  canonical、CAS、scope 四组探针，不能只跑 `npm test`。

---

## §33 作者第十三轮整改（B27：opaque `actorKey`）

> 作者侧整改记录，不替代独立复核。§32 的 **107 PASS / 57 FAIL / 10 未测量，
> NO-SHIP** 仍是当前独立判定；本节只说明 §32.2 的根因已按“不规范化显示名”的
> 方向移除，等待 verifier 重放后才能改独立计数。
>
> 第十四轮独立复核见 **§34**：Unicode 共享 key、session pin、mixed、
> migration、namespace 通过；但 caller 可注入/回放 `actorKey`，真实
> delete/cancel 仍可执行，**B27 仍失败，107 / 57 / 10（NO-SHIP）**。

### 33.1 根因与设计

§32.2 的根因不是 `canonicalActorId` 少了几条 Unicode 规则，而是它试图把
自由格式的显示字符串规范成身份。任何 trim/case-fold/NFKC/零宽剥离/suffix
规则都同时存在绕过和过宽两个方向。本轮删除 `canonicalActorId`（`host/`
中已无该调用），改为：

- **`host/kernel/actors.js`**
  - `actorKeyFor(id)`：对**精确 id 字节**（JavaScript UTF-16 code units，保留
    孤立 surrogate）做 SHA-256，输出 `ak_<base64url>`；不 trim、不 lower、
    不 NFKC、不剥离 `@`/`:`/`#`/`/`，不把 `:`/`#`/`@` 之后当 suffix。
  - `withActorKey(actor)`：保留已有 key，否则给 legacy/inline actor 派生确定 key。
  - `sameActor(a,b)`：**两方都有 key 时只比较 key 是否完全相等**；两方都没有
    key 时只比较 `id` 的 exact-byte 相等；一方有 key、一方没有时返回 false，
    fail closed。
    `appealState` 进一步要求 raiser/requester/resolver 三者的 key 状态一致；
    `resolveAppeal`/`withdrawIntent` 对 keyed/unkeyed 混用直接拒绝，避免把
    “无法证明相等”当成“不同人”。
  - `migrateProjectActorKeys(project)`：给 pre-key 的 `intent.actor`、
    `resolvedBy`、`withdrawnBy` 补 key；key 只由该 legacy actor 的 exact id
    确定性派生，所以重开同一项目得到同一身份，旧 resolution 仍可解析。
- **session 注册边界**：`policy.actorForSession` 在 session 对象上 pin 住一个
  key（WeakMap）；同一 session 对象从 `h1` 改名为 `ｈ１` 不会换 key，冲突的
  后续 metadata 也不能旋转 key。显式 `session.actorKey` /
  `header.meta.actorKey` 可注入外部身份；没有时按 exact registration id 派生。
  `actorFromToolExecution` 把 session 对象、meta 和 key 一起传入，终端的
  `session.id` 仍是可信来源。
- **写入记录**：`createIntent` 写 `intent.actor.actorKey`；`intent.withdraw`
  写 `resolvedBy.actorKey` / `withdrawnBy.actorKey`；`intent.put` 对 raw intent
  的 actor 也补 key。gate 比较 `appealState` 的 raiser / requester / resolver
  时只调用 `sameActor`，不再使用显示名。
- **加载迁移**：`store.getProject`、`listProjects`、`saveProject` 都调用
  `migrateProjectActorKeys`；这是读时迁移，不额外写表，也不改变 project
  revision。新 intent 始终带 key；exact id fallback 只留给真正没有 key 的
  legacy actor。

### 33.2 Unicode / 格式字符表（29/29）

测试构造：requester 与 resolver 使用**同一个已注册 actorKey**
（`ak_unicode_shared_identity_0001`），raiser 是另一个 expert；因此显示名从
`H1` 到 `İ`/`ß`/`ſ` 的任何变化都仍是同一个 actor，gate 必须拒绝自确认。
测试同时断言 `stored` 保持原始显示名（不 trim/lower/NFKC）、`resolvedBy.actorKey`
仍是该 registration key、所有 29 个 raw 的 `actorKeyFor` 两两不同。下表 raw
用 JSON escape 表示，`stored` 是实际持久化的 `resolvedBy.id`：

| raw（JSON escape） | stored（JSON escape） | actorKey | action |
|---|---|---|---|
| `H1` | `H1` | `ak_unicode_shared_identity_0001` | `human_confirmation_required` |
| `h1 ` | `h1 ` | `ak_unicode_shared_identity_0001` | `human_confirmation_required` |
| `h1:resolver` | `h1:resolver` | `ak_unicode_shared_identity_0001` | `human_confirmation_required` |
| `h1:resolver:extra` | `h1:resolver:extra` | `ak_unicode_shared_identity_0001` | `human_confirmation_required` |
| `h1#resolver` | `h1#resolver` | `ak_unicode_shared_identity_0001` | `human_confirmation_required` |
| `h1@resolver` | `h1@resolver` | `ak_unicode_shared_identity_0001` | `human_confirmation_required` |
| `h1\u00a0` | `h1\u00a0` | `ak_unicode_shared_identity_0001` | `human_confirmation_required` |
| `h1\t` | `h1\t` | `ak_unicode_shared_identity_0001` | `human_confirmation_required` |
| `h1\u3000` | `h1\u3000` | `ak_unicode_shared_identity_0001` | `human_confirmation_required` |
| `h1\ufeff` | `h1\ufeff` | `ak_unicode_shared_identity_0001` | `human_confirmation_required` |
| `h1\u2028` | `h1\u2028` | `ak_unicode_shared_identity_0001` | `human_confirmation_required` |
| `\uff48\uff11` | `\uff48\uff11` | `ak_unicode_shared_identity_0001` | `human_confirmation_required` |
| `h1\u200b` | `h1\u200b` | `ak_unicode_shared_identity_0001` | `human_confirmation_required` |
| `h1\uff1aresolver` | `h1\uff1aresolver` | `ak_unicode_shared_identity_0001` | `human_confirmation_required` |
| `h1.resolver` | `h1.resolver` | `ak_unicode_shared_identity_0001` | `human_confirmation_required` |
| `h1/resolver` | `h1/resolver` | `ak_unicode_shared_identity_0001` | `human_confirmation_required` |
| `h1\u200dresolver` | `h1\u200dresolver` | `ak_unicode_shared_identity_0001` | `human_confirmation_required` |
| `h1\u0301` | `h1\u0301` | `ak_unicode_shared_identity_0001` | `human_confirmation_required` |
| `h1\u0000resolver` | `h1\u0000resolver` | `ak_unicode_shared_identity_0001` | `human_confirmation_required` |
| `h1 resolver` | `h1 resolver` | `ak_unicode_shared_identity_0001` | `human_confirmation_required` |
| `h1%2Fresolver` | `h1%2Fresolver` | `ak_unicode_shared_identity_0001` | `human_confirmation_required` |
| `\u0130` | `\u0130` | `ak_unicode_shared_identity_0001` | `human_confirmation_required` |
| `\u00df` | `\u00df` | `ak_unicode_shared_identity_0001` | `human_confirmation_required` |
| `\u1e9e` | `\u1e9e` | `ak_unicode_shared_identity_0001` | `human_confirmation_required` |
| `\u017f` | `\u017f` | `ak_unicode_shared_identity_0001` | `human_confirmation_required` |
| `K` | `K` | `ak_unicode_shared_identity_0001` | `human_confirmation_required` |
| `\u212a` | `\u212a` | `ak_unicode_shared_identity_0001` | `human_confirmation_required` |
| `SS` | `SS` | `ak_unicode_shared_identity_0001` | `human_confirmation_required` |
| `ss` | `ss` | `ak_unicode_shared_identity_0001` | `human_confirmation_required` |

29/29 都是 `human_confirmation_required`；没有一行变成 `ok`。这与 §32.2.2 的
旧结果（`ｈ１`、`h1\u200b`、`h1：resolver` 等为 `ok:true`）形成红→绿对照。

### 33.3 真实 handler 探针（逐字）

负向探针使用真实 `registerAgentTool` + `tool.execute(input, exec)`。session 对象
以 `h1` 注册，resolve 前只把同一对象的显示 id 改为 `ｈ１`；没有 caller 提供
`actorKey`，key 来自 session pin。随后 delete/cancel 仍以 `h1` 显示名请求：

```text
UNICODE_HANDLERS {"delete":{"code":"human_confirmation_required","projectExists":true,"resolvedBy":"ｈ１","resolvedKey":"ak_yuFroCrXYMvQ_P5Fh7crqwo7eXI7rFdl"},"cancel":{"code":"human_confirmation_required","runtimeCalls":0,"resolvedBy":"ｈ１"}}
```

- delete：`human_confirmation_required`；项目仍存在；resolvedBy 显示 `ｈ１`，
  resolvedKey 是同一 registration key。
- cancel：`human_confirmation_required`；`runtimeCalls=0`；resolvedBy `ｈ１`。

namespace 正向对照使用两个不同 key 的 actor，并经真实 delete handler：

```text
NAMESPACE_HANDLERS {"resolved":true,"resolvedBy":"alice@work.com","deleted":true,"projectExists":false}
```

- `alice@home.com`（requester）与 `alice@work.com`（resolver）是不同 actor，
  resolver 确认后真实 delete 成功，项目消失；二者不再被折叠成 `alice`。

### 33.4 legacy / migration 探针

`claims-selftest` 新增并通过：

- `legacy identity fallback is exact bytes and fails closed when mixed with a key`：
  无 key 的 `h1` 与 `H1`/`h1 `/`ｈ１`/`h1:resolver` 均不相等；`h1` 与 `h1` 相等；
  一个 keyed、一个 unkeyed 的同一显示名不相等。
- `pre-key intents receive deterministic actorKey values at load`：`actor` /
  `resolvedBy` / `withdrawnBy` 都得到 key，重复迁移结果相同。
- `pre-key intents are migrated when the project is loaded`：直接向 storage table
  写一条没有 key 的 project row，经 `store.getProject` 读出后三个字段都有 key。
- `namespace and formatting variants hash to distinct legacy keys`：29 个 Unicode
  变体以及 `alice@home.com`/`alice@work.com` 两两不同；没有任何 suffix 合并。
- `the registration key is pinned across a display rename and conflicting metadata`：
  session 改名不换 key；两个显式不同 key 的同显示名 actor 不相等。
- `keyed actors are compared only by actorKey, never by display spelling`。
- `namespace-distinct actors authorize the real delete handler`。

`host/` 中 `canonicalActorId` 已无定义和调用；剩余字符串仅出现在本文件的 §31/§32
历史验收记录中。

### 33.5 验证结果

| 命令 | 结果 |
|---|---|
| `npm test` | EXIT=0；37 个文件 / **676 checks**（原 668，新增 actorKey 表/迁移/handler 探针） |
| `node scripts/claims-selftest.mjs` | EXIT=0；**111 checks**（原 103；删除 3 条错误的 canonical 折叠断言，新增 11 条） |
| `node scripts/strict-writes-selftest.mjs` | EXIT=0；**17**；permitted deletion 不计 bypass |
| `node scripts/client-smoke.mjs` | EXIT=0；**16/16** |
| `npm run bench:scale` | EXIT=0；**11/11**；100k first page 0.48 ms；restart 1.90 ms；dispatch max 37.9 ms / p95 31.4 ms / starts 161；snapshot 3.5 KB / 21.9 ms |
| `git grep canonicalActorId host` | 无输出（实现已移除） |

本轮的 red→green 不是把旧 canonical 的 3 条断言改绿，而是移除“折叠显示名”这个
错误前提，改为 registration key 的 self-confirmation 表和真实 handler 探针。

### 33.6 边界

- 本节是作者侧报告，不是独立复核；**§32 的 107/57/10 NO-SHIP 保持不变**，
  直到 verifier 重放 §32.2/32.2.3/32.2.4。
- 只做 repo 内实现与测试；未执行 sandbox escalation，未写 `~/.dsh/storages/*`，
  未重启 Host。
- actorKey 是应用层身份，不是外部身份提供者；真正的双人独立意志仍需外部身份/
  审批。key 的 fallback 由 exact registration id 派生，不能替代该信任边界。
- 浏览器二维仍 N/A；provider/restart 仍是既有未测量项。

---

## §34 第十四轮独立复核（HEAD `1f3e20e`，2026-11-10）

> 复核人：独立验证者。为避开验证期间出现的并发未提交改动，本轮所有探针在
> **clean worktree `/tmp/r14-head`（detached HEAD `1f3e20e`）** 中执行；主工作区
> 的 `host/runtime.js` / `scripts/plugin-smoke*.mjs` 在 21:15 左右出现了**不是本次
> 验证产生**的未提交改动（K8/1.3 activity-write 相关），本报告不把它们算作
> HEAD `1f3e20e`，也不修改它们。生产代码未由本验证改动。
>
> 采样时间 `2026-11-10T21:08:52+08:00`（`Asia/Shanghai`）；浏览器时区不可用。
>
> **结论：opaque actorKey 关闭了 §32.2 的显示名规范化根因，但 B27 仍失败在
> key 的来源/绑定/保密性：caller 可把任意 key 放进 `session.meta.actorKey`
> 或 `session.actorKey`，`intent_list` 又公开 `resolvedBy.actorKey`，同一
> `h1` session 因此可重放 h2 的 key 并让真实 delete/cancel 执行。**

### 34.1 29 行 Unicode/格式字符表（共享 registration key）

构造与作者 §33 相同但独立重写：requester `unicode-human` 和 resolver 使用**同一个
显式 registration key** `ak_unicode_shared_identity_0001`；raiser 是另一个 expert。
29 个 raw 变体逐一 resolve + prune 请求：

```json
{
  "checks": 29,
  "allRejected": true,
  "allStoredExact": true,
  "allSharedKey": true,
  "distinctHashes": 29
}
```

逐行关键值：

| raw | stored | key | action |
|---|---|---|---|
| `H1` | `H1` | shared | `human_confirmation_required` |
| `h1 ` | `h1 ` | shared | `human_confirmation_required` |
| `h1:resolver` | `h1:resolver` | shared | `human_confirmation_required` |
| `h1:resolver:extra` | `h1:resolver:extra` | shared | `human_confirmation_required` |
| `h1#resolver` / `h1@resolver` | exact | shared | `human_confirmation_required` |
| `h1\u00a0` / `h1\t` / `h1\u3000` / `h1\ufeff` / `h1\u2028` | exact | shared | `human_confirmation_required` |
| `ｈ１` | `ｈ１` | shared | `human_confirmation_required` |
| `h1\u200b` / `h1：resolver` / `h1.resolver` / `h1/resolver` | exact | shared | `human_confirmation_required` |
| `h1\u200dresolver` / `h1\u0301` / `h1\u0000resolver` | exact | shared | `human_confirmation_required` |
| `h1 resolver` / `h1%2Fresolver` | exact | shared | `human_confirmation_required` |
| `İ` / `ß` / `ẞ` / `ſ` | exact | shared | `human_confirmation_required` |
| `K` / `K` / `SS` / `ss` | exact | shared | `human_confirmation_required` |

29 个 raw 的 `actorKeyFor` 两两不同（`distinctHashes=29`），但 authorization
只比较同一个 registration key，所以显示名不同不再是不同 actor。**§32.2 的
display-name 绕过在这条路径上已闭。**

### 34.2 真实 handler：同一 session 改名必须拒绝

使用真实 `registerAgentTool` + `tool.execute(input, exec)`；session 对象先以
`h1` 注册，只把同一对象的 `id` 改成 `ｈ１`，没有显式 key；resolve 后再改回
`h1` 发起删除/取消：

```json
{
  "sameSessionDelete": {
    "requesterKey": "ak_yuFroCrXYMvQ_P5Fh7crqwo7eXI7rFdl",
    "resolvedById": "ｈ１",
    "resolvedKey": "ak_yuFroCrXYMvQ_P5Fh7crqwo7eXI7rFdl",
    "code": "human_confirmation_required",
    "projectExists": true
  },
  "sameSessionCancel": {
    "requesterKey": "ak_yuFroCrXYMvQ_P5Fh7crqwo7eXI7rFdl",
    "resolvedById": "ｈ１",
    "resolvedKey": "ak_yuFroCrXYMvQ_P5Fh7crqwo7eXI7rFdl",
    "code": "human_confirmation_required",
    "runtimeCallsAdded": 0
  }
}
```

实际 `runtimeCalls` 在取消后新增 **0**，`calls=[]`；项目仍存在。session pin
按作者设计生效。

但一个**新注册**的 session `{id:'ｈ１'}` 没有显式 key 时得到不同 key：

```json
{
  "separateFullwidth": {
    "requesterKey": "ak_yuFroCrXYMvQ_P5Fh7crqwo7eXI7rFdl",
    "resolverKey": "ak_DVcV2q9ahkUmr6PJqeGA_omlLUvmw-I3",
    "code": "deleted",
    "deleted": true,
    "projectExists": false
  }
}
```

这是 key 模型按设计把“同一个人、两个 key”当成两个 actor（用户第 5 点明确要求）；
它不是同一 session 的 display alias。若验收要求“同一个 human 的任何新注册也必须
被识别为同一人”，key 模型无法仅凭字符串做到；这一点在 34.11 单列为边界，不在
34.2 的同一 registration 探针里重复计失败。

### 34.3 Key integrity：B27 仍失败

#### 34.3.1 Request 字段不覆盖 exec actor（PASS）

实际 `delete_project` 请求同时带 `actorKey`、`claim.actorKey`、`actor`、
`resolvedBy`（全部指向 h2/key），exec 仍为 h1：

```json
{
  "requestFields": {"deleted": true, "projectExists": false},
  "directRequestFields": {"ok": true, "deleted": true, "projectExists": false}
}
```

direct `svc.deleteProject(p, {exec:h1, actorKey:h2key})` 也删除成功。`submitIntent`
请求里的 `actor`/`actorKey` 被忽略，intent actor 仍是 h1/h1key；`resolveAppeal`
请求里的 `resolvedBy` 被忽略，resolvedBy 仍是 h2/h2key。**claim/resolvedBy/intent
actor 三个 request 字段都不接受 caller key。**

#### 34.3.2 Session meta 接受 caller key（FAIL）

同一个 `h1` session，只把 `header.meta.actorKey` 设为 h3 的 key：

```json
{
  "sessionMetaInjection": {
    "metaActorKey": "ak_8jPFXayh8hZs3bP2ojvWD65gX-QO9uUR",
    "metaActorId": "h1",
    "resolvedById": "h1",
    "resolvedKey": "ak_8jPFXayh8hZs3bP2ojvWD65gX-QO9uUR",
    "deleted": true,
    "projectExists": false
  }
}
```

同一个 meta session 对 `cancel_node`：

```json
{
  "resolver": {"id": "h1", "key": "ak_8jPFXayh8hZs3bP2ojvWD65gX-QO9uUR"},
  "resolved": {"id": "h1", "key": "ak_8jPFXayh8hZs3bP2ojvWD65gX-QO9uUR"},
  "tool": {"ok": true, "cancelled": true, "nodeId": "n1", "revision": 3},
  "runtimeCallsAdded": 1
}
```

`actorForSession` 的优先级是 `input.actorKey` → `session.actorKey` →
`input.meta.actorKey` → `actorKeyFor(sessionId)`。caller 可自带任意非空字符串：

```json
{
  "session": {"kind": "human", "id": "h1", "actorKey": "ak_explicit_injected"},
  "meta": {"kind": "human", "id": "h1", "actorKey": "ak_meta_injected"},
  "arbitrary": {"kind": "human", "id": "h1", "actorKey": "x"}
}
```

`x` 也被接受；没有前缀/长度/签名/registry 校验。key 不是由 session registration
唯一派生，也不绑定到创建它的 session。

#### 34.3.3 key 被 `intent_list` 公开并可重放（FAIL）

第一次 appeal 由 h2 resolve；真实 `intent_list` 返回完整 intent：

```json
{
  "firstResolvedKey": "ak_-xrlee9wxQxj5y56Nhb5QaM-MQjWUnbU",
  "listedResolvedKey": "ak_-xrlee9wxQxj5y56Nhb5QaM-MQjWUnbU",
  "keyLeaksThroughIntentList": true
}
```

把这个 key 放进 `h1` session 的 meta，再次 resolve；第二次 `resolvedBy` 显示
`h1`，key 为 h2 的 key；随后 h1 的真实 delete 成功：

```json
{
  "replaySession": {"id": "h1", "metaKey": "ak_-xrlee9wxQxj5y56Nhb5QaM-MQjWUnbU"},
  "secondResolved": {"by": "h1", "key": "ak_-xrlee9wxQxj5y56Nhb5QaM-MQjWUnbU"},
  "delete": {"deleted": true},
  "projectExists": false
}
```

即：同一个 human/session 先读取另一个 actor 的公开 key，再作为该 actor 签名。
**这是可执行的 B27 绕过，不是显示名问题。**

#### 34.3.4 两个 session 注册同一 key

```json
{
  "requester": {"id": "h1", "actorKey": "ak_shared_two_sessions_0001"},
  "resolver":  {"id": "h2", "actorKey": "ak_shared_two_sessions_0001"},
  "sameActor": true,
  "resolved": {"id": "h2", "key": "ak_shared_two_sessions_0001"},
  "action": "human_confirmation_required"
}
```

两个 session 同 key 被折叠为同一 actor，没有“key 已注册给另一个 session”的错误或
唯一性检查。若 key 是外部发放的凭证，这应当是拒绝而不是静默接受。

#### 34.3.5 session key 改名 mid-flight（PASS）

同一 session 对象首次 `h1` 后：

```json
{
  "first": {"id": "h1", "actorKey": "ak_yuFroCrXYMvQ_P5Fh7crqwo7eXI7rFdl"},
  "later": {"id": "ｈ１", "actorKey": "ak_yuFroCrXYMvQ_P5Fh7crqwo7eXI7rFdl"},
  "sameKey": true
}
```

即使后来传入 `session.actorKey='ak_conflict_meta'` / `meta.actorKey`，pin 仍保留
原 key；只有显示 id 变化。**这个探针通过。**

#### 34.3.6 哈希稳定性与 exact UTF-16（PASS）

```json
{
  "stable": true,
  "distinct": true,
  "loneSurrogateDistinct": true
}
```

`actorKeyFor('h1')`、`actorKeyFor('ｈ１')`、`actorKeyFor('h1\\u200b')`、
`actorKeyFor('alice@home.com')`、`actorKeyFor('alice@work.com')` 都稳定且不同；
孤立 surrogate `\\ud800`/`\\ud801` 也不碰撞。哈希实现本身符合“exact UTF-16”
描述。

### 34.4 Mixed keyed/unkeyed（fail closed，PASS）

三个层次都 fail closed：

1. 真实 service：legacy raiser（`actor:{kind:'expert'}`，无 id/key）+ keyed
   resolver：
   ```json
   {"code":"forbidden_action","message":"appeal raiser and resolver have incomparable actor identities"}
   ```
2. keyed intent + legacy resolver（`resolvedBy` 无 id/key）的 synthetic project，
   action 均：
   ```json
   [{"label":"keyed-intent/legacy-resolver","code":"human_confirmation_required"},
    {"label":"legacy-intent/keyed-resolver","code":"human_confirmation_required"}]
   ```
3. 无 id 的 resolver 直接 `intent.withdraw resolve:true`：
   ```json
   {"ok":false,"code":"invalid_commit","message":"actor.id is required"}
   ```
4. `sameActor` 的 keyed/unkeyed 两个方向均为 `false`；id 相同且都无 key 时为
   `true`；`h1` vs `H1` 为 `false`。

**mixed 不会把“不确定”当成“不同”放行。**

### 34.5 Load-time migration（PASS，含一个 forged-key caveat）

直接向 storage table 写 pre-key project（`intent.actor`/`resolvedBy` 无 key），
经 `store.getProject()` 读时迁移；同一 memory domain restart 后重读：

```json
{
  "before1": {"actor":"ak_JGPOXYgP9X-shXhzchLmgUqGpOzV5di_",
              "resolved":"ak_-xrlee9wxQxj5y56Nhb5QaM-MQjWUnbU",
              "status":"resolved","resolution":"upheld"},
  "afterRestart": {"actor":"ak_JGPOXYgP9X-shXhzchLmgUqGpOzV5di_",
                   "resolved":"ak_-xrlee9wxQxj5y56Nhb5QaM-MQjWUnbU",
                   "status":"resolved","resolution":"upheld"},
  "action1":"ok", "action2":"ok",
  "stableActor":true, "stableResolver":true,
  "replaySame":true, "statusesSame":true
}
```

- `actor` 得到 `actorKeyFor('advisor')`，`resolvedBy` 得到 `actorKeyFor('h2')`；
- 相同输入重复迁移（`replayA`/`replayB`/`replayLoaded`）key 完全相同；
- resolution/status 不被迁移改变；
- restart 后 action1/action2 都 `ok`，旧 resolution 仍可解析；
- 没有额外 event，project revision 不被迁移推进（action 前 revision 仍为原值）。

**Caveat**：`withActorKey` 会保留 legacy 记录中**已经存在的** `actorKey`。把
`resolvedBy={id:'h2',actorKey:'ak_forged_resolver_key'}` 写入 pre-key row 后：

```json
{"before":{"id":"h2","key":"ak_forged_resolver_key"},
 "after":{"resolved":"ak_forged_resolver_key","status":"resolved","resolution":"upheld"},
 "preserved":true, "action":"ok"}
```

迁移不会校验该 key 是否由 id 派生，因此一个有 storage 写权限的 legacy 记录可以
伪造 resolver。这不是 public request 路径，但属于 migration/key-integrity 的
残余风险；不能声称“migration 只产生可信 key”。

### 34.6 Namespace / 同一人两个 key

真实 delete handler：

```json
{
  "namespace": {
    "requesterKey": "ak_alice_home_0001",
    "resolvedById": "alice@work.com",
    "resolvedKey": "ak_alice_work_0001",
    "deleted": true,
    "projectExists": false
  },
  "sameIdTwoKeys": {
    "requesterKey": "ak_alice_a_0001",
    "resolverKey": "ak_alice_b_0001",
    "deleted": true,
    "projectExists": false
  }
}
```

`alice@home.com` 与 `alice@work.com` 不再被拆成 `alice`；同一显示 `alice` 的两个
不同 key 被当成两个 actor，删除成功。**namespace 与“同一个人两个 key 两个 actor”
按第 5 点通过。** 这也说明 key 模型不证明人类独立性；若同一人能创建两个 session/
两个 key，它就是一个可用的共谋路径（见 34.9）。

### 34.7 §32 CAS/scope 回归（clean HEAD）

在同一 clean worktree 重放 §32 的 action CAS 与 scope 探针：

- 注入 withdraw：action `stale_basis`（expected 3, actual 5），无 action intent；
- 注入 resolve：action `stale_basis`（expected 3, actual 5）；
- 同一 project 两个 prune action race：一个 `ok:true`、一个 `stale_basis`
  （expected 5, actual 6）；
- delete handler CAS：authorization 后注入 pending project appeal，删除返回
  `stale_basis`（expected 3, actual 4），项目仍在；
- foreign pending 不阻断 exact prune；exact pending/withdrawn 仍阻断；
- node-scoped legacy delete resolution → project delete `appeal_target_mismatch`；
  project-scoped delete pending/withdrawn 仍阻断；node/project target 分离。

这些路径在 `actorKey` 改造后仍通过，未出现以 key 为理由的 scope/CAS 回退。

### 34.8 回归（clean HEAD `1f3e20e`）

| 命令 | 结果 |
|---|---|
| `npm test` | EXIT=0；**676 ok**（37 files） |
| `node scripts/claims-selftest.mjs` | EXIT=0；**111 checks** |
| `npm run bench:scale` | EXIT=0；**11/11**；100k first page **0.73 ms**；restart first page **2.01 ms**；dispatch max **40.5 ms** / p95 **33.3 ms** / starts 161 |
| `node scripts/strict-writes-selftest.mjs` | EXIT=0；**17**；bypass **0**（permitted deletion 不计） |
| `node scripts/client-smoke.mjs` | EXIT=0；**16/16** |
| U14 partial probe | EXIT=0；3 次 `refresh_partial`；前两次 degraded=false，第三次 degraded=true；三次 `previousSuccess=true` |
| S12 restart first page | EXIT=0；segments 5；firstSameStore **2.2 ms**；firstAfterReopen **1.3 ms**；listAfterReopen **93.1 ms**；page1/page2=100；total 100000；last 100000 |

`git grep canonicalActorId`：

```text
git -C /tmp/r14-head grep -n canonicalActorId -- dsh-metainfer-research-lab/host
# 无输出（实现已移除）

git -C /tmp/r14-head grep -n canonicalActorId
# 仅 docs/refactor/VERIFICATION.md 的 §31/§32/§33 历史验收记录
```

实现路径为空；全 repo 不为空是因为历史验证文档仍引用旧名。若验收严格要求
`git grep canonicalActorId` **整个 repo** 为空，需要删除/改写历史文档，不能用
“实现已移除”冒充全 repo 空；本轮未改历史段落。

### 34.9 计数与判定

| 判定 | 数量 |
|---|---|
| PASS | **107** |
| FAIL | **57** |
| 未测量 | **10**（浏览器 2 行 = 不适用） |
| 合计 | **174** |

- **1 个阻断：B27**。它已从 display-string canonicalisation 转为 **key
  integrity**：
  - `session.meta.actorKey` / `session.actorKey` 接受 caller 自带 key（34.3.2）；
  - `intent_list` 公开 `resolvedBy.actorKey`，可读取并重放（34.3.3）；
  - 两个 session 可注册同一 key，没有唯一性/绑定检查（34.3.4）；
  - 任意非空字符串（`x`）就是合法 key，没有签名/来源校验；
  - 真实 `delete_project`/`cancel_node` 在这些路径下执行。
- Unicode 共享 key 表、同一 session 改名、mixed、migration、namespace 都通过；
  B27 仍失败不是因为显示名。
- **56 个能力未建，0 个只差文档。**

**明确判定：NO-SHIP。** 不能说 “narrow release possible”。

如果只把 29 行 display table 当作 B27 的全部，会得到假绿；本轮 34.3.2/34.3.3
是真实 handler 执行路径。只有 key 由 Host 签发并绑定到不可伪造的 registration、
且 request/meta 不能自带 key、key 不作为公开 bearer 值，才可能重开 narrow
release；届时计数为 **108 PASS / 56 FAIL / 10 未测量**，并显式排除 `1.3`、
`5.3.2`/Q3、Stage 3–5、browser 2 行、provider/restart。

### 34.10 修复建议

1. **key 由 Host 签发，不从 request/meta 接受**：`actorForSession` 应拒绝
   caller-supplied `actorKey`；session 注册时由 Host 生成/登记，session 对象只
   引用 server-side registry id，authorization 不接受 metadata key。
2. **key 不应是公开 bearer**：`intent_list` / logs / error payload 不应返回可用于
   认证的 `actorKey`；若审计需要关联，返回不可逆的 key id 或仅返回 display id。
   只读展示与认证凭证必须分离。
3. **unique binding**：一个 key 只能绑定一个注册 session；同一 key 的第二个
   session 应拒绝（或明确标记为同一 session 的恢复，而不是新 actor）。
4. **attestation**：真正的独立 human 仍需外部身份/双人审批；key 只能解决
   “不同 spelling 不折叠”，不能证明不是同一人。若产品接受“同一人两个 key 两个
   actor”，必须在验收口径中显式写为限制，不能把它算作 human-level B27。
5. **migration**：迁移 pre-key actor 时只从 exact legacy id 派生 key；不要保留
   legacy record 自带的不受信 key（或校验其来源）；加 migration replay 测试。
6. **回归**：保留 29 行共享 key、same-session pin、mixed、migration 和 namespace
   正向；同时把 34.3.2/34.3.3 的真实 delete/cancel 加入 red→green 测试，防止
   只测 display table 就宣布关闭。

### 34.11 边界

- 验证在 clean HEAD `1f3e20e` 完成；主工作区并发出现的 K8/1.3 未提交改动不属于
  本轮，未修改、未计入。
- 只修改本文件；未执行 sandbox escalation，未写 `~/.dsh/storages/*`，未重启 Host。
- 浏览器二维 N/A；provider/restart 仍是既有未测量项。
- 结论对 HEAD `1f3e20e` 有效；后续修改 `actors.js`、`policy.js`、
  `lab-service.js`、`store.js` 后必须重跑 34.1–34.6，不能只跑 `npm test`。

---

## §35 作者第十四轮：B27 Host key 与能力 Wave 1–3

> **边界**：本节是作者侧实现记录，不是独立复核。§32/§34 的 **107 PASS /
> 57 FAIL / 10 未测量，NO-SHIP** 仍是当前独立判定；作者侧测试不能改写独立计数，
> 也不能声称 B27 已闭合。只有验证者按 §32.2/§34.3 重放后才能改判。

### 35.1 B27 单缺陷 commit（`e134acf`）

B27 只修一个缺陷：actor key 由 caller 提供且可作 bearer 重放。

- **Host 签发**：`host/kernel/actors.js` 在 session registration 时生成
  `ak_host_<randomUUID>`，保存在 Host registry；`actorForSession` 不再接受
  `input.actorKey`、`session.actorKey`、`input.meta.actorKey`，命中即抛
  `caller_supplied_actor_key`。`actorFromToolExecution` 保留传参，因此注入会在
  真实 tool 路径被拒绝，而不是静默忽略。
- **唯一绑定**：一个 key 只绑定一个 registration；第二个 session 复用同一 key
  返回 `actor_key_shared`；已绑定 registration 再换 key 返回 `actor_key_rebind`。
  旧 `ak_legacy_*` deterministic key 仍可供旧测试构造，但不进入 registry，不能
  authorize。
- **不披露**：`publicView` 在 service 读方法、HTTP `ok`/`fail`、agent tool 成功与
  错误路径递归删除 `actorKey`；`intent_list` / `trace_explain` 只返回 actor id。
- **迁移 fail-closed**：`migrateProjectActorKeys` 在 load 时剥掉所有未登记 key；
  irreversibility gate 同时要求 resolver/raiser/requester 三方都是
  `isIssuedActorKey`，legacy/forged key 的已解决申诉仍返回
  `human_confirmation_required`。
- **作者探针**（`claims-selftest`）：
  - `B27_META_INJECTION`：delete/cancel 带 `meta.actorKey` 均返回
    `caller_supplied_actor_key`，project 存在、runtime 调用 0 次；
  - `B27_KEY_REPLAY`：`intent_list` / `trace_explain` 无 `actorKey`，拿读到的 key
    重放返回 `actor_key_shared`；
  - `B27_BINDING`：两 session 共享 key 返回 `actor_key_shared`，中途换 key 返回
    `actor_key_rebind` 且原 key 不变；
  - `B27_FORGED_LEGACY`：load 后 forged `resolvedBy.actorKey` 为 null，delete 仍
    被 `human_confirmation_required` 挡住。

**这仍是作者侧红→绿，不是独立验证。** 独立计数保持 §32 的 107/57/10；B27 的
“同一自然人/双人确认”性质仍未被本 commit 证明。

### 35.2 Wave 1：`1.3` + `5.3.2/Q3`（2/56）

| 行 | 生产调用点 | 真实探针 | 结果 |
|---|---|---|---|
| `1.3` | `host/runtime.js` 监听 turn 内 session event，节流写 `node/activity` 并推进 `lastActivityAt` | `plugin-smoke` 真实进程：第二节点运行中产生 turn-internal event，断言 `lastActivityAt` 前进且事件为 `node/activity` | 5/5 process smoke；`node/completed` 后 cause chain 非空 |
| `5.3.2/Q3` | `host/dispatch/reservation.js` 的 p0 reservation + `selectPreemptionVictim`；`dispatch-once.js` 在容量满且 p0 waiting 时通过 envelope 提交 `preempt`；`runtime.preempt` 写 `node/preempted` 与开放 appeal | `reserved-slots-selftest` 10/10：selector 只选 p3→p2、p1/merge 排除、>10 min 门槛；集成 p0 抢占旧 p2 并拿到释放 slot；`plugin-smoke` 用真实 runtime 抢占第二节点并 `appealPreemption` 写 `node/preemption_appealed` | 真实进程 5/5；预占/抢占 10/10 |

Wave 1 关闭 **2/56**。`5.3.2` 的 p0 仅限同项目，p1/merge 不抢占；appeal 记录
`forNodeId/at/by/causeId/deadlineAt/endpoint`，可由 service 和 HTTP 读取。

### 35.3 Wave 2：U1/U2/U3/U12 四个观测面板（4/56，累计 6/56）

新增只读 Observability drawer，生产挂载在 WorkspaceTopBar 的 `📊` 按钮；每个面板
直接调用真实 Host endpoint，缺 payload 时显示错误/空态而不是崩溃：

- **Dispatch & queue（U1/U2）**：`/state` + `/status` + `/metrics` + `/budgets`，
  running 节点的 startedAt、队列/阻塞原因、p0 class、per-class budget 报告。
- **Event timeline（U3）**：`/events` + `/explain`，按 seq 展示事件，选中节点后
  加载 cause chain；无 chain 时显式提示。
- **Claims & evidence（U12）**：`/state` + `/intents`，展示 node claim、preemption
  appeal、p0 priority 与 intent claim/gate/resolution；选择后展开证据。
- **Expert library（U12）**：`/experts`，展示 lifecycle 与 Host-computed metrics。
- 新增 `GET /intents` 与客户端 `api.fetchIntents`；所有读响应继续经过
  `publicView`，不返回 `actorKey`。
- `client-smoke` 由 16/16 增至 **24/24**（多挂 5 个新组件 + drawer）；degraded
  payload 全部通过，UI budget 12/12 仍绿。

Wave 2 关闭 **4/56**（U1、U2、U3、U12）。

### 35.4 Wave 3：组织能力（0 新关闭，4 个部分面）

这一批有真实生产调用点，但每项都仍有文档中点名的残余，因此**不把它们算作关闭**：

| 面 | 已落地 | 仍缺（故不计数） |
|---|---|---|
| 争议表（B22 邻域） | `GET /disputes` + `listDisputes`：appeal 状态、raiser、target、resolution、resolvedBy、resolutionReason、resolvedAt；HTTP 探针通过 | B22 的 8 类裁决者映射与超时默认仍未建；`B22` 不能整行改 PASS |
| 复盘（B23 邻域） | `POST/GET /retrospective` + `generateRetrospective`：从节点/事件计算 counts、failureStages、preemptions、disputes、classBudgets，写 durable `retrospective/generated` 事件；HTTP POST→GET 持久化探针通过 | B23 的 `expected` 与轮换仍未建；只完成 retro 一半 |
| 每类预算/报告 | `scheduling.classBudgets`（兼容 `scheduling.budgets`）；dispatcher 在 `start` 前 `applyClassBudgets`，一轮内累计计数；`GET /budgets` 报告 running/queued/completed/failed/preempted；集成探针 `p2:1` 只启动一个 | 无独立验收行号；`5.3.4` 的公平权重/usage 仍未对齐，不能并入该行 |
| 观察/评审面 | `GET /reviews` 暴露 review claims；`GET /experts` 的 curator 状态；UI 的 Review & curation 面板；`/reviews` 在 orchestrator 缺失时返回命名 `unavailable` 错误而非崩溃 | `5.3.13` 的 long-poll/升级触发仍缺；`5.3.14` 的“观察 + 有限写 + 仲裁”仍缺；不计数 |
| 专家生命周期 UI | Expert library 面板复用现有 `expert_hire/expert_drain/expert_fire` command，按 lifecycle 显示 Hire/Drain/Retire；HTTP `/commands` 探针通过 | 不是新的 56 行；B19/B20 的旧计数不由本节改写 |

Wave 3 新关闭 **0/56**；部分交付 **4 个面**（争议、复盘、预算、观察/评审），
其中专家 UI 是既有能力的可发现性改进。

### 35.5 计数（对 56 行能力缺口）

| 桶 | 数量 | 行 |
|---|---|---|
| 已关闭（作者侧） | **6** | `1.3`、`5.3.2`、`U1`、`U2`、`U3`、`U12` |
| 部分交付、未关闭 | **4** | `B22`（争议表）、`B23`（仅 retro）、`5.3.13`（仅评审面）、`5.3.14`（仅读/错误面） |
| 未动 | **46** | 其余 56 行 |
| 合计 | **56** | 6 + 4 + 46 |

因此作者侧口径是 **6/56 关闭、4/56 部分、46/56 未动**；独立口径仍是 §32 的
**107 PASS / 57 FAIL / 10 N/A，NO-SHIP**。这两组数字不能相加或相互替代。

### 35.6 回归门

本工作树（B27 commit `e134acf` + 未提交 Wave 1–3）实测：

- `npm test`：EXIT 0，无 FAIL；`claims-selftest`、`wiring-selftest` 8/8、
  `reserved-slots-selftest` 10/10、`expert-lifecycle-selftest` 全通过；
- `npm run bench:scale`：11/11；
- `node scripts/strict-writes-selftest.mjs`：all checks passed；
- `node scripts/client-smoke.mjs`：24/24；
- `node scripts/plugin-smoke.mjs`：5/5（真实进程、完成节点、activity、抢占 +
  appeal）；
- 未放宽任何预算/断言；未写 `~/.dsh/storages/*`；未重启 Host。

### 35.7 边界与下一步

- **B27 仍未由独立验证者闭合**；作者侧只证明 §34.3.2/34.3.3 的 caller-key
  注入/重放路径在当前树被拒，不能证明自然人独立性。
- 剩余 **50 个未关闭能力行**（46 未动 + 4 部分）仍需逐行生产调用点、真实探针、
  红→绿；Wave 3 不得因“有面板”被算作关闭。
- 独立验证者重放 §32.2/§34.3 后，才可讨论把 B27 从 FAIL 改为 PASS；独立计数
  才可能变为 **108 PASS / 56 FAIL / 10 N/A**。在那之前，NO-SHIP 不变。

> 后续独立复核见 **§36**（clean `ef16f34`）：B27 当前进程内通过，5.3.2 通过；
> 1.3/U1/U2/U3/U12 未闭；独立计数 **109 PASS / 55 FAIL / 10**。§35.7 的
> 作者侧“未闭/108”表述保留为提交时历史，不覆盖 §36。

---

## §36 第十五轮独立复核（clean HEAD `ef16f34`，2026-11-10）

> 复核人：独立验证者。为避免把主工作区并发出现的未提交改动算进 HEAD，本轮所有
> B27/能力/回归探针在 **clean worktree `/tmp/r15-head`（detached HEAD
> `ef16f34`）** 的 `dsh-metainfer-research-lab` 子目录中执行；只把主仓库的
> `node_modules` 以 symlink 挂入，不改生产代码，不改主工作区里已有的未提交文件。
>
> 采样时间 `2026-11-10T21:31:51+08:00`（`Asia/Shanghai`）；浏览器时区不可用。
> 浏览器绘制仍 N/A；provider/真实 Host restart 仍不在本轮测量范围。
>
> **结论：B27 在当前 Host 进程内通过 §34.3 的攻击重放；但 registry 不持久化，
> restart 后旧 key 被剥离/拒绝，故只能给“当前进程、无 restart”的 narrow
> release。能力 Wave 1–3 的作者 6/56 只有 `5.3.2/Q3` 一项独立通过；`1.3` 只修了
> advisor 一侧，U1/U2/U3/U12 仍是面板壳。独立计数 109 PASS / 55 FAIL / 10 未测量。**

### 36.1 B27 攻击重放（clean `ef16f34`）

真实 `registerAgentTool` + `tool.execute` 路径，session 对象固定（同一个对象重复
使用才得到同一 registration），结果如下。

#### 36.1.1 注入、共享、中途换 key

```json
{
  "arbitraryMetaActor": {"code": "caller_supplied_actor_key"},
  "arbitraryMetaDelete": {"error": {"code": "caller_supplied_actor_key"}},
  "arbitraryMetaProjectExists": true,
  "sharedMetaActor": {"code": "actor_key_shared"},
  "sharedMetaDelete": {"error": {"code": "actor_key_shared"}},
  "sessionActorKey": {"code": "caller_supplied_actor_key"},
  "cancelMetaDelete": {"error": {"code": "caller_supplied_actor_key"}},
  "cancelRuntimeCalls": 0,
  "replay": {"code": "actor_key_shared", "deleted": false, "projectExists": true},
  "twoSessions": {"code": "actor_key_shared"},
  "rekey": {"code": "actor_key_rebind"},
  "rekeyToShared": {"code": "actor_key_shared"}
}
```

- 只把 `h1` session 的 `header.meta.actorKey` 设为任意字符串：真实
  `delete_project` 返回 `caller_supplied_actor_key`，项目仍存在。
- 把 `h2` 已签发的 key 放进 `h1` 的 meta：返回 `actor_key_shared`，不是
  `caller_supplied`；owner 判定优先于 caller 判定。
- `session.actorKey` 直接注入：`caller_supplied_actor_key`。
- 同样的注入放到真实 `cancel_node`：拒绝且 `runtimeCalls` 新增 **0**。
- 两个 session 共享 `h2` key：`actor_key_shared`；同一 session 先正常取 key，
  再把 meta 改成另一个 key：`actor_key_rebind`，原 key 不变；改成已属于别人的
  key：`actor_key_shared`。

#### 36.1.2 request 字段/旧记录

`delete_project` 请求同时带 `actorKey`、`claim.actorKey`、`actor`、
`resolvedBy`（全部指向 h2/key），exec 仍是 h1；请求按 h1 正常删除，字段不参与
认证。`submitIntent` 的 actor 来自 `actorFromToolExecution`，请求里的
`actor`/`actorKey` 被忽略：真实 note 提交带 h2 的 actor/key，落库 actor 仍是
h1/h1key：

```json
{
  "ok": true,
  "actor": {"kind": "human", "id": "h1", "actorKey": "ak_host_64f839fb-..."},
  "requestActor": {"id": "h2", "actorKey": "ak_host_b11e3c59-..."}
}
```

`resolveAppeal` 的 `resolvedBy` 也被忽略，实际 `resolvedBy` 是 h2。

forged legacy 记录（`resolvedBy.actorKey` 为未登记 key，`actor.actorKey` 为旧
deterministic key）load 后：

```json
{
  "before": "ak_forged_resolver_key",
  "after": null,
  "actorAfter": null,
  "action": "human_confirmation_required"
}
```

迁移剥掉所有未登记 key；irreversibility gate 要求 resolver/raiser/requester
三方都是 `isIssuedActorKey`，所以 forged key 不是“忽略后按 h1 授权”，而是
fail closed。legacy 无 key 记录同样退回人工确认（兼容性边界，不是绕过）。

#### 36.1.3 key 读面/重放

同一条已解决申诉：raw store 的 `resolvedBy.actorKey` 是
`ak_host_9b70c4ac-...`；service 的 `getState`、`listIntents`、`getEvents`、
`explainNode`、`traceExplain`、`listDisputes`、`listExperts`、
`classBudgetReport`、`listRetrospectives`、`getNode`、`changesSince`、
`statusFacts`、`metricsFor` 全部 `keyLeak=false`；agent tool 的 `state`、
`intent_list`、`trace_explain`、`explain_node`、`status_facts` 也全部不含 key。

即使把读到的 h2 key 放进 `h1` meta 重放 `delete_project`，返回
`actor_key_shared`，`deleted=false`、项目仍存在。因此 **§34.3.3 的
`intent_list` bearer 重放链已断**。

`publicView` 在 `host/kernel/actors.js:213` 递归剥离所有名为 `actorKey` 的
属性；`host/http.js:29/35` 的所有 JSON 成功/失败响应都经过 `publicView`，
错误 payload 只保留 `code/message/nextStep/retryable`；`/files/download` 只返回
文件字节，不返回 intent/actor JSON；没有 key 导出路由。`raw store` 有 key 是
必要的 Host 内部状态，不是读面。

#### 36.1.4 签发可预测性

连续签发 500 个 key：

```json
{
  "count": 500,
  "unique": 500,
  "uuidV4": true,
  "first": [
    "ak_host_aaf7e565-8557-4c7e-83cd-53bd6ca9457e",
    "ak_host_3807976d-1c8f-4499-be28-073f127fd6d6",
    "ak_host_b0688c77-d6f0-44a6-8668-e39fb8c650fa"
  ]
}
```

- 生成点是 `actors.js:139/234` 的 `randomUUID()`（`node:crypto` CSPRNG），
  不是计数器、时间、seed 或注册 id 派生；caller 可控制注册 id，但不能控制
  UUID。
- 500/500 唯一，全部符合 `ak_host_<UUIDv4>`；没有观察到可预测顺序。
- **不能把“可控制注册 id”当成“可预测 key”**：id 只决定 registry 的
  registration token，key 仍随机。

#### 36.1.5 registry 持久性/restart

`actors.js:40-44` 的 registry 是**模块级内存**：

```js
const registry = new Map();
const bySessionObject = new WeakMap();
const byRegistrationId = new Map();
```

没有写入 `store`/domain，也没有 load-time registry 重建。用 file-backed domain
在两个独立 Node 进程中写入/重启：

```json
{
  "write": {"resolved": true, "registered": true, "rawKey": "ak_host_f282c815-..."},
  "read": {
    "loaded": true,
    "oldKeyInLoadedProject": null,
    "oldKeyRegistered": false,
    "oldKeyAccepted": {"ok": false, "code": "caller_supplied_actor_key"},
    "newKeyIsSame": false,
    "actionCode": "human_confirmation_required",
    "projectExists": true
  }
}
```

- registry **不跨 restart 持久化**：新进程 `isIssuedActorKey(oldKey)=false`；
  `migrateProjectActorKeys` 把已解决申诉里的旧 key 剥成 `null`。
- 旧 session 以旧 key 重新注册，`actorForSession` 会把它当 caller-supplied key
  拒绝；新注册得到新 key，`newKeyIsSame=false`。
- 因此 restart 后的行为是 **fail-closed（不会误授权），但也不连续**：合法的
  历史已解决申诉退回 `human_confirmation_required`，实际 delete 被挡。
- 这是 **narrow release 的排除项 `restart`**，不是当前进程内 key 注入绕过。
  若发布要求跨 restart 连续性，B27 仍不能算完整通过。

#### 36.1.6 跨项目 transplant

用同一个 `h2` session 分别在 `r15-transplant-a` / `b` 解决 project-scoped
delete appeal，再分别真实 delete：

```json
{
  "sameSessionKey": "ak_host_64528c9f-dbef-40cf-90e8-cca71b7c434e",
  "a": {"resolved": true, "delete": true},
  "b": {"resolved": true, "delete": true}
}
```

- key **没有 projectId 绑定**：同一个 session/key 可以在多个项目执行相同身份
  的不可逆动作。跨 session 移植仍被 `actor_key_shared` 拒绝；meta 注入仍被
  `caller_supplied_actor_key` 拒绝。这是“身份不按项目分区”的架构边界，不是
  key 从读面泄露后的 bearer 重放。
- 若产品要求“项目级 key 隔离”，需要额外的 project ACL；本轮不把 B27 的
  actor identity 计为 project isolation。

### 36.2 能力 Wave 1–3 独立复核

#### 36.2.1 `5.3.2/Q3`：PASS

生产调用点：`host/dispatch/reservation.js` 的 p0 reservation /
`selectPreemptionVictim`，`host/dispatch/dispatch-once.js` 在容量满且 p0 waiting
时提交 preempt envelope，`host/runtime.js` preempt 写 `node/preempted` +
开放 appeal；`index.js:130-151` 的 `dispatchOnce` 从项目 config 传
`maxRunningNodes`，`host/auto.js:286-288` 每 2s tick 调用。

clean HEAD 实测：

- `reserved-slots-selftest` **10/10**：selector 只选 p3→p2、p1/merge 排除、
  >10 min 门槛；集成 p0 抢占旧 p2 并拿到释放 slot；per-class budget。
- `plugin-smoke` **5/5**：真实进程完成节点、activity、p0 preempt + appeal。
- 计数：`5.3.2` **PASS**。

#### 36.2.2 `1.3`：FAIL（只闭 advisor，未闭 scheduler）

- `host/context/payload.js:125-132` 的 advisor `runningRow` 已有
  `lastActivityMs`；`plugin-smoke` 真实 turn-internal event 推进
  `lastActivityAt`。
- 但 `host/snapshot.js:185-191` 的 `buildSchedulerSnapshot.running` 仍只有
  `id/title/needs/startedAt/elapsedMs`，没有 `lastActivityAt`/`lastActivityMs`。
  clean HEAD 实测：

```json
{
  "advisorRunning": [{"id":"n1","elapsedMs":240000,"lastActivityMs":30000}],
  "schedulerRunning": [{"id":"n1","startedAt":1794317676160,"elapsedMs":240002}]
}
```

验收要求 running 补 elapsed/lastActivity 以支持停滞判断；scheduler 是做出
start/stop/预占判断的一侧，仍看不到 lastActivity，故 **1.3 只能算半闭，判
FAIL**。作者 §35.2 的 evidence 只引 `plugin-smoke` 的 advisor activity，不足以
覆盖 scheduler snapshot。

#### 36.2.3 U1：FAIL（running 缺 elapsed/GPU/branch）

真实 jsdom 渲染 `DispatchQueuePanel`（`client.js:16030`）得到文本：

```text
p0 n1 running node · started <time>
```

缺少 elapsed；running 行没有 `resourcesHeld.gpu`/GPU 占用；没有 branch。
“gpu” 只出现在 queued 的 `gpu_quota` 阻塞原因里，不是 running 的 GPU 汇总。
验收要求 running 列表同时给出 elapsed、GPU、branch；**U1 FAIL**。

#### 36.2.4 U2：FAIL（没有 dispatch order）

`DispatchQueuePanel` 的 waiting/blocked 行显示 class/id/title/claim 或
`resourceWait` 原因，但没有队列位置/优先级顺序/为何排在前面的解释；渲染文本
没有 `#1`、position、order 或 `priority/delayed` 事件。验收要求“为什么排在
前面”的 dispatch order；**U2 FAIL**。

#### 36.2.5 U3：FAIL（失败事件缺 stage/role/timeout）

`EventTimelinePanel`（`client.js:16125`）把事件渲染为 seq/type/node/cause/at；
真实事件带 `error:{stage:'dispatch',role:'worker',timeoutMs:30000}` 时，面板文本
只有 `node/failed`，没有 stage、role、recent run 或 timeout 归因；cause chain
只显示 `ref.type` 和 JSON。验收要求失败归因面板；**U3 FAIL**。

#### 36.2.6 U12：FAIL（EventTimeline 没有 loading/retry 三态）

- DispatchQueue、ClaimEvidence、ExpertLibrary 有 loading/error/empty 的路径。
- EventTimelinePanel 初始 `events=[]`，fetch pending 时直接渲染
  `No events yet.`；没有 `common.loading`，也没有 retry 按钮。真实 pending 渲染：

```json
{"eventLoadingText":"Event timeline0 eventsNo events yet.","eventHasLoading":false}
```

- `client-smoke` 24/24 只证明“degraded payload 不崩溃”，不证明三态；作者把
  crash containment 当成 U12 的验收，**过度声明**。验收要求每个新面板 loading /
  empty / error 三态（断网刷新、空项目、失败项目）；EventTimeline 至少缺
  loading，**U12 FAIL**。

#### 36.2.7 四个部分面

`B22`（争议表）、`B23`（仅 retro）、`5.3.13`（仅评审面）、`5.3.14`（仅读/错误面）
仍是作者 §35.4 自认的部分交付；本轮没有把它们算作关闭，也没有把 UI 可发现性
当成整行 PASS。它们继续留在 56 行的 FAIL/部分桶中。

### 36.3 计数与判定

| 判定 | 数量 |
|---|---|
| PASS | **109** |
| FAIL | **55** |
| 未测量 | **10**（浏览器 2 行 = 不适用） |
| 合计 | **174** |

推导：

- 起点仍是 §34 的 **107 PASS / 57 FAIL / 10**。
- B27 当前进程内通过：+1 PASS / -1 FAIL → **108 / 56 / 10**。
- `5.3.2/Q3` 独立通过：+1 PASS / -1 FAIL → **109 / 55 / 10**。
- `1.3`、U1、U2、U3、U12 **不通过**，不加不减。
- 作者声称的 **6/56** 能力关闭，独立只确认 **1/56**（`5.3.2`）；
  `1.3`+U1+U2+U3+U12 共 **5 项**是“已尝试但未闭”，不是 partial 计数。
- 作者的 4 个 partial（B22/B23/5.3.13/5.3.14）继续是 **4/56 partial、未关闭**；
  没有被静默并入 6 个 closed。

**B27 的口径必须写清**：`109` 里的 B27 只表示**当前 Host 进程内**的 key
签发/绑定/不披露/forged fail-closed；registry 不持久化，restart 排除。若把
restart 纳入 B27 验收，B27 回到 FAIL，计数回 **108 PASS / 56 FAIL / 10**。
本轮不把 restart 算进 narrow release，故主计数用 109/55/10。

### 36.4 回归门（clean HEAD `ef16f34`）

| 命令 | 结果 |
|---|---|
| `npm test` | EXIT 0；702 个 `ok` 行；locale-selftest 全通过 |
| `npm run bench:scale` | 11/11；100k-event first page **0.52 ms**；restart first page **1.99 ms** |
| `strict-writes-selftest` | EXIT 0；17 个 `ok`；bypass 0；permitted deletion 不计数 |
| `client-smoke` | **24/24**（仅 crash containment，不代表 U 行验收） |
| `plugin-smoke` | **5/5**（真实进程、activity、p0 preempt + appeal） |
| `reserved-slots-selftest` | **10/10** |
| U14 partial probe | EXIT 0；dashboard `lastRun.status=partial`，`failureCount=3`，partial alert 正常 |
| S12 restart first page | firstAfterReopen **1.2 ms**；100k 事件 page1/page2=100，last=100000 |
| `git diff --check` | 无 whitespace 错误 |

说明：主工作区在验证期间出现了**非本验证产生**的未提交改动（`client.js`、
`lab-service.js`、`policy.js`、`runtime.js` 等）；本轮没有使用这些改动，也没有
修改/回退它们。上面所有数字都来自 clean worktree。未执行 sandbox escalation，
未写 `~/.dsh/storages/*`，未重启 Host。

### 36.5 判定与 narrow release

**narrow release possible**，但只限：

- B27 Host-issued actor key 的**当前进程内**身份门：caller 注入、session key
  注入、两 session 共享、中途 rekey、读面 key 重放、forged legacy 均 fail
  closed；真实 delete/cancel 不执行。
- 不包含 **restart 后的 key 连续性**：registry 是内存 Map，旧 key 在 restart
  后既不在 registry，也会被 migration 从 intent 剥掉；这是明确排除项。

明确排除的 scope：

- **`1.3`**：scheduler snapshot 仍无 lastActivity；
- **`5.3.2`**：测试/计数 PASS，但按本轮 release scope 不作为 B27 narrow
  release 的组成部分（单独签字才纳入）；
- **Stage 3–5**：B22/B23/5.3.13/5.3.14 等仍是 partial/fail；
- **U1/U2/U3/U12**：观测面板未达到验收；
- **browser 2 行**：N/A；
- **provider/restart**：未测量且 restart registry 不持久。

**完整发布仍是 NO-SHIP**：109 PASS 不足 174 行；55 FAIL 中包含 56 行能力的
未闭部分和 U 行；10 行未测量。B27 narrow release 不能写成完整发布。

### 36.6 边界

- 结论对 clean HEAD `ef16f34` 有效；后续修改 `actors.js`、`policy.js`、
  `lab-service.js`、`snapshot.js`、`context/payload.js`、`client.js` 后必须重跑
  §36.1–36.4，不能只跑 `npm test`。
- B27 只证明 key 的来源/绑定/不披露/当前进程 fail-closed；**不证明自然人独立
  意志**，也不替代外部身份 provider、双人审批或项目 ACL。
- 跨项目 key 不绑定 projectId：同一 session 可对多个项目执行相同身份动作；
  这是身份模型边界，不是本次读面重放。
- 浏览器时区/绘制不可用；provider 真实调用、真实 Host restart 仍是未测量项。

---

## §37 作者第十六轮：B27 持久化与验证者点名的五个缺口

> **边界**：本节是作者侧实现与探针记录，不替代 §36 独立复核。独立计数仍是
> **109 PASS / 55 FAIL / 10 未测量**；B27 的 restart-continuity 与
> `1.3`/U1/U2/U3/U12 是否改判，必须由验证者在当前工作树上重放后决定。

### 37.1 B27：actor-key registry 进入 v2 store

此前 §36 确认当前进程内的 key 注入/共享/rekey/读面重放均已 fail closed，但
registry 是模块级 `Map`，restart 后旧 key 被剥掉，合法的已解决申诉退回
`human_confirmation_required`。本轮把 registry 变为 **v2 store 的持久表 +
进程内缓存**：

- `host/store.js` 新增 `actorKeys` 表；每条记录包含 `key`、`sessionId`、
  `issuedAt`、`projectId`、`registrationId`、`registrationKind`。`openStore`
  在返回 facade 前把这些记录加载进 registry，`flushActorKeys()` 供干净退出/
  restart 探针等待落盘。
- `host/kernel/actors.js` 的 `configureActorKeyStore` 在启动时恢复 key；
  `issueActorKeyForRegistration` 只对**真实 session object**按 session id
  复用旧 key。裸 `{sessionId}` 仍是独立 registration（保留 §34 的 pin 探针：
  `separateRegistration.actorKey !== registeredActor.actorKey`）。
- 第一次 commit/delete 时 `bindActorKeyProject` 记录该 key 的首个项目；这是
  **审计元数据，不是 project ACL**。跨项目身份边界未被本轮改变。
- 未知/伪造 key 不因“磁盘上有记录”而受信：load 只接受 Host 前缀记录，且
  `isIssuedActorKey` 仍只认 registry；migration 继续剥掉未登记 key。

**真实进程 restart 探针**：`scripts/b27-restart-selftest.mjs`（11/11）用
`scripts/lib/json-file-domain.mjs` 写一个临时文件域，父进程签发 3 个 key 后退出；
子进程（`scripts/lib/b27-restart-child.mjs`，全新 Node 进程）加载同一文件域，
断言 key 恢复、同 session id 同 key、unknown key 仍拒绝，然后在子进程内
resolve 一个 delete appeal 并执行真实 `delete_project`；父进程再次打开文件域，
断言项目已删、key 的 `projectId` 已记录。输出示例（节选）：

```json
{"restoredHuman":true,"restoredExpert":true,"restoredConfirmer":true,
 "forged":false,"sameId":true,"resolved":true,"deleted":true,
 "projectGone":true}
```

这把 §36.1.5 的“restart 后 fail-closed 但不连续”升级为
**restart 后仍能连续授权，同时 unknown key 仍 fail-closed**；不证明自然人独立
意志，也不替代 provider/双人审批。

### 37.2 验证者点名的五个能力缺口

| 行 | 修改 | 真实探针 |
|---|---|---|
| `1.3` | `host/snapshot.js` 的 `buildSchedulerSnapshot.running` 增加 `lastActivityAt`/`lastActivityMs`（值来自既有 `timestamps.lastActivityAt`，scheduler 不再只看到 startedAt） | `context-selftest` 12/12，新增断言 scheduler running 行 `lastActivityMs` ≈30s、`elapsedMs` ≥239s |
| `U1` | `client.js` 的 Dispatch & queue running 行增加 elapsed、`resourcesHeld.gpu`（回退 needs）、`git.branch` | `client-smoke` 28/28，新增行为断言文本包含 `elapsed 60s`、`GPU 2`、`exp/run1` |
| `U2` | 同一面板用 `/status` 的 `facts.nextToStart` 计算并渲染队列位置 `#1`；blocked 行仍显示 resource wait 原因 | 同一条 `client-smoke` 断言包含 `#1`，不是只看面板是否挂载 |
| `U3` | Event timeline 行增加 `event.error` / `event.data.error` 的 `stage`、`role`、`timeoutMs` 归因 | `client-smoke` 断言 `stage dispatch` / `role worker` / `timeout 30000ms` |
| `U12` | EventTimeline 增加 `loading`、显式 `Retry` 按钮和 error 状态；pending 时不再先显示 `No events yet.`，error 时也不显示空态 | `client-smoke` 30/30：pending 时断言 `common.loading`+`Retry`；失败时断言错误文本且无 `No events yet.`；点击 Retry 后断言重新取到 `#7` |

### 37.3 其余能力（作者侧，待独立复核）

- **B22**：8 类裁决者映射（只有 `value_priority`/`duplicate_claim` 需要模型）、
  `keep_current` 超时默认、appeal 需新证据、escalation `reasonCode` + 每专家每
  epoch 配额、项目每 epoch dispute 预算、dispute 计入 performance、
  `GET /disputes`、`/disputes/classes`、`/arbitrate` 与客户端 DisputeTablePanel。
- **B23**：`expected {metric,direction,magnitude}` 进入 advisor schema、intent、
  orchestrator proposal 与 runtime 完成比较；缺 metric/方向偏差开
  `retro/opened`；`host/experts/rotation.js` 的 14 天默认轮换由
  `dispatchOnceAction` 调用，写 `expert/rotated`。
- **5.3.13**：`observerSnapshot` / `waitForEvents`（30s long-poll）/
  `escalateStalled`；stalled 返回 `observer_stalled` 并写一次
  `observer/escalation`。
- **5.3.14**：`observe` 只读、`dispute_open` 有限写、`lab-arbiter` 只
  `observe/disputes/arbitrate` 且不能 start/cancel/delete；human-authority
  dispute 必须人类裁决。
- **5.3.3**：`dispatchOnce` 在 p0 已等待 >30s 且本轮未启动时写
  `priority/delayed {nodeId, blockedBy, waitedMs, expectedRemainingMs}`；
  `blockedBy` 依次取 class budget、`max_running_nodes`、节点 `resourceWait.reason`、
  dispatch skip 原因。class budget 的延迟仍写入同一个 `delayed` 数组，但 p0
  等待行使用 `reason:'p0_waiting'`。`reserved-slots-selftest` 11/11。
- **5.3.4**：只落了 `DEFAULT_SOURCE_WEIGHTS`（human=100、advisor=10）和
  `fairOrder` 权重探针；生产 `usageBySource` 仍未接到真实 GPU-seconds 账本，
  **不按已关闭计数**。

`stage5-selftest` 28/28；`reserved-slots-selftest` 11/11；
`dispatch-once-selftest` 6/6；`priority-selftest` 全通过。

### 37.4 计数与回归门

作者侧对 56 行的可复核口径从 §35 的 6 行增为 **11 行**
（新增 B22、B23、5.3.3、5.3.13、5.3.14）；其中独立验证者已确认的仍只有
`5.3.2`。5.3.4/5.3.12 仍是部分，不计入。独立口径保持 **109/55/10**：
本轮没有修改 §36 的 174 行判定，也没有把“作者探针通过”写成独立 PASS。

回归门（本工作树）：

- `npm test`：EXIT 0，无 `FAIL`；包含新增 `claims-selftest`、
  `b27-restart-selftest`、`stage5-selftest`。
- `node scripts/client-smoke.mjs`：30/30（U12 新增 error 后 Retry 重取）。
- `npm run bench:scale`：11/11；100k-event first page 仍在预算内。
- `node scripts/strict-writes-selftest.mjs`：all checks passed。
- `node scripts/plugin-smoke.mjs`：5/5（真实进程、activity、p0 preempt + appeal）。
- 未放宽预算/断言；未写 `~/.dsh/storages/*`；未重启 Host。

## §38 第十六轮独立复核（clean HEAD `8582b4f`，2026-11-10）

> §37 是作者第十六轮交卷时的历史记录；其中 §37.4 的 **109/55/10**、
> “待验证者重放”等表述不再代表当前独立判定。**以本节 §38 的 114/50/10 为准。**

> **边界**：本轮只做验证与文档更新，未改生产代码。主工作树
> `/root/MetaInfer/dsh-metainfer-research-lab` 位于 `8582b4f`（parent
> `ef16f34`）；除本文件外无改动。独立探针运行在 clean worktree
> `/tmp/r16-head/dsh-metainfer-research-lab`，file-backed domain 在 `/tmp`；
> `npm test` 也在该 clean worktree 执行。作者自己的 selftest/探针不作为独立证据。
> 时间采样 `2026-11-10T21:53:12+08:00`（`Asia/Shanghai`）；浏览器时区不可用，
> 其余未带时区的日期/时间需要用户澄清。

### 38.1 B27：真实进程 restart 连续性与边界

独立探针 `/tmp/r16-clean/restart-child.mjs` + `/tmp/r16-clean/file-domain.mjs`
启动**三个独立 Node 进程**，共享同一个文件域。A 进程签发 key 并写一批
project/appeal，退出；B 进程重新 `openStore`，恢复 key，执行 forged/shared/
legit 路径，退出；C 进程再次重新加载，执行第二个项目。结果（原文节选）：

```json
{"mode":"write","rowsBefore":5,
 "facadeWriteMethods":["flushActorKeys","listActorKeys"],"facadeHasPut":false,
 "closed":true}
{"mode":"read","loaded":true,
 "restored":{"human":{"issued":true,"same":true},
             "expert":{"issued":true,"same":true},
             "confirmer":{"issued":true,"same":true},
             "advisor":{"issued":true,"same":true}},
 "forgedDelete":{"code":"caller_supplied_actor_key","deleted":false},
 "forgedProjectStillExists":true,
 "sharedDelete":{"code":"actor_key_shared","deleted":false},
 "forgedResolve":{"code":"caller_supplied_actor_key","ok":false},
 "resolve":{"ok":true,"code":null},
 "delete":{"deleted":true,"code":null},"projectGone":true,
 "changesSinceLeak":false,"changesSinceHasKeyWord":false}
{"mode":"read2","loaded":true,
 "restored":{"human":{"issued":true,"same":true},
             "expert":{"issued":true,"same":true},
             "confirmer":{"issued":true,"same":true},
             "advisor":{"issued":true,"same":true}},
 "resolve":{"ok":true,"code":null},"delete":{"deleted":true,"code":null},
 "projectGone":true,"rows":5}
```

补充的 caller-write 探针（`/tmp/r16-clean/actor-write-probe.mjs`）显示 facade 的
actor 相关方法只有 `flushActorKeys`、`listActorKeys`，**没有** `putActorKey`/
`saveActorKey`/`set*`/`delete*`；修改 `listActorKeys()` 返回的对象后，重新读取
仍是原 2 条（独立小探针的 `unchanged:true`；B27 文件域主探针是 5 条）。`changesSince` 输出的 `hasKeyWord:false`，
`intent_list`/HTTP/错误路径也未出现 `actorKey`。

**判定：B27 PASS，且 restart 纳入 B27 验收，§36 的 restart 排除正式撤销。**

必须同时写清边界，避免把该 PASS 扩大成“自然人身份”：

- restart 的 key 恢复按 **Host session id** 进行；会话对象没有重新展示 key 时，
  用同一 Host session id 的合法会话会重新拿到该 key。这是 Host session 的
  连续性，不是“证明调用者持有旧 key”。如果能伪造同一个 Host session id，
  就能 rehydrate 该 key；这是 B27 的剩余信任边界，不是 unknown/forged key
  被接受。
- `listActorKeys()` 仍返回**原始 key**，仅作为 Host 内部 store/facade 读面，
  未发现 HTTP 或 agent-tool 消费者；它不构成写入面，但属于内部读面暴露。
- 仍不证明 provider/自然人独立意志，也不替代双人审批。

### 38.2 五个被点名能力行

#### 38.2.1 `1.3`：PASS

独立构造 running 节点 `startedAt=now-240s`、`lastActivityAt=now-30s`，调用
`buildSchedulerSnapshot`：

```json
{"running":[{"id":"run","elapsedMs":240005,
 "lastActivityAt":1794319096100,"lastActivityMs":30005}]}
```

scheduler snapshot 的 running 行不再只有 startedAt；`lastActivity` 与 elapsed
都来自生产快照路径。**1.3 PASS。**

#### 38.2.2 U1：PASS

用真实 `/state` 节点 payload（`git.branch`、`resourcesHeld.gpu`）渲染
`DispatchQueuePanel`，running 行文本：

```text
p0 run1 running node · elapsed 60s · GPU 2 · exp/run1 · started common.none
```

elapsed 由 `timestamps.startedAt` 计算，GPU 优先取 `resourcesHeld.gpu`（回退
`needs.gpu`），branch 取 `git.branch`。**U1 PASS。**

#### 38.2.3 U2：FAIL（位置只覆盖前 5 个，且不显示 `why`）

同一面板放入 1 个 running + 6 个 planned，`facts.nextToStart` 按生产上限给
前 5 个；实际渲染：

```text
Waiting / blocked
#1 p0 q1 queued 1
#2 p2 q2 queued 2
#3 p2 q3 queued 3
#4 p2 q4 queued 4
#5 p2 q5 queued 5
— p2 q6 queued 6
```

第 6 个 planned 节点**没有队列位置**；同时 `facts.nextToStart[*].why` 的
`max_running` 原因没有进入 UI，只有节点的 `resourceWait`/`claim` 才显示。
作者的 `client-smoke` 只断言两个节点时的 `#1`，所以“行为断言”成立但覆盖不到
这条边界。**U2 FAIL。**

#### 38.2.4 U3：PASS（本轮验收范围：真实失败事件的 stage/role/timeout）

用 production `runtime.js` 的 `data.error` 形状 payload 渲染
`EventTimelinePanel`：

```text
#1 node/failed node n1 · stage run · role worker · timeout 30000ms
```

生产 `runtime.js:1013-1061` 的失败诊断写入
`error.stage`/`error.role`/`error.timeoutMs`，
面板同时读 `event.error` 与 `event.data.error`；这是行为可达的，不是 class
名 grep。**U3 PASS（本行只要求失败事件的 stage/role/timeout）。**

> 不把“失败节点详情里还要有 recent run/下一步”算进本行 PASS；该详情仍不完整，
> 是后续 UI 行的工作，不是本轮点名范围。

#### 38.2.5 U12：FAIL（部分失败仍是假空态，多数新面板无 Retry）

EventTimeline 本身通过：pending 显示 loading + Retry、失败显示 error 且不显示
`No events yet.`、Retry 重新取到事件。但独立对其它新面板做**部分失败**：

| 面板 | 故障 | 实际 |
|---|---|---|
| DispatchQueue | `/state` 失败，`/status` 成功 | `0 running · 0 queued`、`No node is running.`、`The executable queue is empty.`，无 error（假空态） |
| ClaimEvidence | `/state` 失败，`/intents` 成功 | `0 node claims · 0 intents`，无 error（假空态） |
| ExpertLibrary | `/experts` 失败 | error 文本 + `The Host returned no expert descriptors.`，无 Retry（错误与空态并存） |
| DisputeTable | `/disputes`/`/classes` 失败 | error 文本 + `No appeal or dispute has been opened.`，无 Retry |
| EventTimeline | `/events` 失败 | error + Retry，无空态（通过） |

作者 `client-smoke` 的 30/30 是文本/按钮行为断言（不是 class-name grep），但
U12 只覆盖 EventTimeline；其它面板的 partial failure 未被覆盖。**U12 FAIL。**

### 38.3 四个部分面与 `5.3.3`

#### 38.3.1 B22：FAIL（authority 映射只有元数据，没有执行）

8 类 `openDispute` 的 authority 元数据都正确：

```text
stale_basis=code, fact_conflict=code, resource_quantity=cfs,
resource_quality=arbiter, value_priority=arbiter,
priority_inversion=human, duplicate_claim=curator, scope_overlap=arbiter
```

但同一组记录用 **expert** 调 `resolveDispute`，8/8 全部：

```json
{"ok":true,"code":null,"resolution":"apply_change"}
```

`resolveDispute` 只做 `resolveDisputeRecord` 和 commit，没有读取
`record.authority`；生产 `host/http.js:216` 的 `POST /disputes/resolve` 又直接
调用 `service.resolveDispute(..., null)`，不经过 `arbitrate` 的 actor-class
检查。因此专家可以绕过 `arbitrate`，对 code/cfs/curator/human 类都 `apply_change`。
**B22 FAIL。**

B22 的其它子项独立通过：

- **quota**：同一 raiser 连续 3 次，前 2 次 ok，第 3 次
  `escalation_quota_exceeded`。
- **timeout**：显式 `sweepDisputes` 后 `keep_current`、`defaultApplied:true`。
- **reopen**：无新证据 `dispute_reopen_requires_new_evidence`；有新证据回到
  `pending`。

但 **timeout/rotation/escalation 的自动调用有 wiring 缺口**：`index.js:169`
的 auto controller 接收的是 raw `dispatchOnce`，不是
`lab-service.dispatchOnceAction`；后者才调用 `rotateDueExperts`/`sweepDisputes`/
`escalateStalled`。因此这些只能在显式 `dispatch_once` tool/manual 路径生效，
不能把“2s auto tick 自动超时/轮换”当成已证明。

#### 38.3.2 B23：PASS（expected 与 rotation 机制）

- `submitIntent` 的 `expected` 进入 `createIntent`；orchestrator proposal 同时带
  `expected` 与 `expectedBaseline`。
- 完成时 `applyPredictionToNode`：方向不符/超阈值得到 `retroOpen:true`，只开
  一个 retro ticket；第二次 apply `openRetroTicket:false`，无重复。
- rotation：`rotationStatus` 识别 due，`rotateDueExperts` 写
  `expertRotations`，记录 `nextExpertId` 和 `expert/rotated`。
- 代码搜索未发现 vote/debate/multi-model majority 路径。

**B23 PASS。** 剩余风险同上：自动 tick 不会调用 `rotateDueExperts`；rotation
不是“无人值守自动轮换”，只能由显式 `dispatch_once`/manual 路径触发。

#### 38.3.3 `5.3.13`：FAIL（long-poll 通过，但触发条件不完整）

独立 mid-sleep 探针：先拿 cursor，再在 wait 睡眠期间写入 `probe/mid_sleep`；
返回 `waitedMs:202`、`events:["probe/mid_sleep"]`、`timedOut:false`。timeout
探针 `timedOut:true, waitedMs:251`。**长轮询和 mid-sleep 事件不丢，通过。**

但整行要求 **每 60s 长轮询，且只在 stalls/starving/pauseReason 命中时升级**：
`waitForEvents` 的 max timeout 是 **30_000**（默认 25_000），且
`observerSnapshot` 只计算 `stalled`（30 分钟 idle），没有 `starving`/
`pauseReason`，也没有对应升级条件。**5.3.13 FAIL（partial）。**

#### 38.3.4 `5.3.14`：PASS（limited-write/arbiter matrix）

- `observe` 返回的 key 只有
  `ok/projectId/revision/cursor/now/stallMs/running/stalled/openDisputes/recentEvents/pendingIntents`，
  没有 start/stop/cancel/delete handle；调用前后事件数 `eventsAfter:0`。
- `lab-arbiter` 调 `start_node`、`delete_project` 都返回
  `forbidden_action`，允许动作表只有 `arbitrate/observe/disputes/...` 读动作。
- `lab-arbiter` 对 human-authority dispute 返回 `human_confirmation_required`；
  expert 调 `arbitrate` 返回 `forbidden_action`。
- 仲裁只写 dispute resolution，不产生 runtime start/stop。

**5.3.14 PASS。** 但注意 HTTP `/arbitrate` 在 `exec=null` 时回退为 operator
human，且 `/disputes/resolve` 不做 authority 检查；这是 B22 的 authority
问题，不应被 5.3.14 的 limited-write 结论掩盖。

#### 38.3.5 `5.3.3`：PASS

独立 dispatch probe：一个 p2 先占住 `maxRunningNodes:1`，再加入 p0；10s 时
无 delayed 事件；31s、传 production `maxRunningNodes` 时得到：

```json
{"nodeId":"urgent","class":"p0","reason":"p0_waiting",
 "blockedBy":"max_running_nodes","waitedMs":31000,
 "expectedRemainingMs":569000}
```

`priority/delayed` 只写一次；`expectedRemainingMs` 来自最近 running deadline。
阈值边界是 `>= 30000`（题目写 `>30s`），31s 证据正确。**5.3.3 PASS。**

### 38.4 回归门（clean `8582b4f`）

| 命令 | 结果 |
|---|---|
| `npm test` | EXIT 0；**756 个 `ok`，0 个 `FAIL`**；所有 selftest 通过 |
| `npm run bench:scale` | **11/11**；100k-event first page **0.38 ms**；restart first page **1.91 ms** |
| `strict-writes-selftest` | all checks passed；**bypass 0**；permitted deletion 不计数 |
| `client-smoke` | **30/30**（行为断言；覆盖仍如 38.2.5 所述不完整） |
| `plugin-smoke` | **5/5**（真实进程、activity、p0 preempt + appeal） |
| U14 partial probe | EXIT 0；dashboard `lastRun.status=partial`、`failureCount=3`、partial alert |
| S12 | restart first page **1.91 ms**；100k 事件 page1/page2=100，last=100000 |

`git diff --check` 见本轮末尾；只修改了本文件，未改生产代码，未写
`~/.dsh/storages/*`，未重启 Host。

### 38.5 计数、撤销的 restart 排除与剩余边界

| 判定 | 数量 |
|---|---|
| PASS | **114** |
| FAIL | **50** |
| 未测量 | **10**（浏览器 2 行 = 不适用） |
| 合计 | **174** |

推导：

- 起点仍是 §36 的 **109 PASS / 55 FAIL / 10**。
- `1.3`、U1、U3、B23、5.3.14 独立通过：**+5 PASS / -5 FAIL** →
  **114 / 50 / 10**。
- U2、U12、B22、5.3.13 仍是 FAIL；B27 restart 只是把 B27 的验收范围扩大，
  **不重复计数**（B27 已在 109 中以当前进程 PASS 计入）。
- `5.3.2/Q3` 的 §36 PASS 保留；`5.3.4`/`5.3.12` 仍是部分，不新增 PASS。

**restart 排除的处理**：§36 把 “registry 不跨 restart”作为 B27 的排除项；
§38 的真实三进程探针通过后，**该排除从 B27 撤销**。B27 narrow release 的口径
现在是 **“当前进程 + 真实进程 restart + unknown/forged fail-closed”**，不再是
“仅当前进程”。

**仍排除/未证明**（不因 restart 通过而消失）：

1. **浏览器绘制/真实 GUI**：U 行用 jsdom 和真实 payload 渲染，没有实际浏览器
   截图/交互；2 行浏览器项仍为 N/A。
2. **真实 provider/真实 LLM 端到端**：B23 的 expected/rotation 用 deterministic
   probe，不是 provider 真调用；U14 的 provider 停摆只按既有 partial 探针。
3. **自然人独立意志/双重审批**：Host-issued key 不是自然人 attestation；同一
   Host session id 的 rehydration 是剩余信任边界。
4. **自动 tick 的 B22/B23 副作用**：auto 用 raw `dispatchOnce`，不是
   `dispatchOnceAction`；自动超时/轮换未被证明，只有显式 `dispatch_once`/
   manual 路径。
5. **`listActorKeys()` 的内部原始 key 读面**：未发现 HTTP/tool 消费者，但它
   不是“零读面”；B27 的“不披露”只对 intent/event/changesSince/HTTP 成立。
6. **B22 authority / U2 / U12 / 5.3.13** 仍是实际未闭项；完整发布仍 **NO-SHIP**。

---

## §39 作者第十七轮：B22/U2/U12/5.3.13 修复与范围裁决

> **边界**：本节是作者侧修复记录，不是独立复核。§38 的 **114 PASS / 50 FAIL /
> 10 未测量**仍是独立计数；本节不修改 §38，也不宣称四行已被独立关闭。

### 39.1 四项修复

| 行 | 生产改动 | 行为探针 |
|---|---|---|
| B22 | `host/kernel/disputes.js` 新增 `disputeAuthorityVerdict`；`arbitrate` 与 `resolveDispute` 共用；`host/http.js` 的 `/disputes/resolve` 改走 `arbitrate`，不再直调 `resolveDispute` | `stage5-selftest`：普通 expert 对 8 类全部拒绝；`lab-arbiter` 只允许 resource_quality/value_priority/scope_overlap；curator 只允许 duplicate_claim；HTTP 路由探针断言只调用 `arbitrate` |
| U2 | `/status` facts 增加有界 `queueOrder`（最多 100 个 id）；`DispatchQueuePanel` 用它渲染第 6 位及之后，并优先渲染 `facts.why.message/code` | `client-smoke`：1 running + 6 planned 夹具断言 `#6` 与 `maxRunningNodes=4` 原因出现 |
| U12 | 五个面板统一 loading/error/Retry；部分失败不再显示对应空态；Retry 重新取数；ExpertLibrary/DisputeTable 不再错误+空态并存 | `client-smoke` 43/43：四个新面板各自 loading+Retry、失败无假空态、Retry 重新取数；EventTimeline 原三态保留 |
| 5.3.13 | 长轮询上限/默认 60 s；新增 `starving`（runnable 等待 ≥10 min，基于 createdAt）、`pauseReason`；升级顺序 stalled → paused → starving；`escalateStalled` 写 `starving_node`/`driver_paused` | `stage5-selftest`：starving 节点只升级一次；paused driver 返回 `observer_paused` 并写 `driver_paused`；用假时钟把 `timeoutMs=120s` 钳到 60 s，断言 `waitedMs≈60s` |

### 39.2 自动 tick 接线

`index.js` 的 auto / `onTerminated` 现在调用 `service.dispatchOnce(..., {includeStatus:false})`，
与显式 `dispatch_once` 共用 `sweepDisputes`/`rotateDueExperts`/`escalateStalled`；service 尚未
赋值时的早期生命周期调用回退 raw `dispatchOnce`。这关闭了 §38.3.1 指出的自动副作用 wiring
缺口，但自动超时/轮换仍只有作者探针，独立计数不变。

### 39.3 范围裁决

`docs/refactor/OPEN-QUESTIONS.md` 新增“能力行范围裁决”：43 个仍未关闭/未裁决的具体行分为
**必须 13 / 应该 19 / 明确不做 11**，并单列 5.2/5.3/5.3.3 等已覆盖行与 B22/U2/U12/5.3.13
待重放行。`明确不做`的行保留在文档中，不从清单静默消失。

### 39.4 作者侧回归（工作树，未改变 §38）

| 命令 | 结果 |
|---|---|
| `npm test` | EXIT 0；777 个 `ok`，0 个 `FAIL`；wiring 8/8，stage5 通过 |
| `npm run bench:scale` | 11/11 |
| `strict-writes-selftest` | all checks passed，bypass 0 |
| `client-smoke` | 43/43 |
| `plugin-smoke` | 5/5 |
| `b27-restart-selftest` | 11/11 |
| `stage5-selftest` | all checks passed |
| `git diff --check` | EXIT 0 |

边界：未改 §38 计数；未重启 Host；未写 `~/.dsh/storages/*`；浏览器绘制仍 N/A；
B22/U2/U12/5.3.13 仍待独立验证者按 §38 重放。完整发布仍 **NO-SHIP**。

---

## §40 第十七轮独立复核（clean HEAD `5a9735b`，2026-11-10）

> **边界**：本轮只做验证与文档更新，未改生产代码。主工作树
> `/root/MetaInfer/dsh-metainfer-research-lab` 位于 `5a9735b`；除本文件外无改动。
> 独立探针运行在 clean worktree
> `/tmp/r17-head/dsh-metainfer-research-lab/dsh-metainfer-research-lab`，并在
> `/tmp/r17-clean` 用独立 fetch/服务夹具重放；作者自己的 `stage5-selftest` /
> `client-smoke` 不算独立证据。时间采样 `2026-11-10T22:14:52+08:00`
> （`Asia/Shanghai`）；浏览器时区和绘制仍不可用。

### 40.1 判定摘要

| 判定 | 数量 |
|---|---|
| PASS | **116** |
| FAIL | **48** |
| 未测量 | **10**（浏览器 2 行 = 不适用） |
| 合计 | **174** |

推导：§38 的 **114 / 50 / 10** 为起点；**U12 PASS**、**5.3.13 PASS** 各
`+1 PASS / -1 FAIL`；**B22、U2 仍是 FAIL**。因此
**116 PASS / 48 FAIL / 10 未测量**。B27 的 restart 纳入结论不变。

**完整发布仍是 NO-SHIP**。原因不是“48 行全是缺陷”：剩余 FAIL 混合了
真实缺陷（B22、U2）、尚未完成的 `必须/应该` 行，以及本轮不接受的
`明确不做` 裁决（见 §40.6）。任何 release note 都必须把这三类分开写。

### 40.2 B22：FAIL（authority 仍可被绕过）

独立探针用真实 `createLabService` + `registerAgentTool` 打开 8 类 dispute，
再从 direct 和 tool 两条路径重放。关键结果：

```json
{"expert": {"stale_basis":"forbidden_authority",
            "fact_conflict":"forbidden_authority",
            "resource_quantity":"forbidden_authority",
            "resource_quality":"forbidden_authority",
            "value_priority":"forbidden_authority",
            "priority_inversion":"human_confirmation_required",
            "duplicate_claim":"forbidden_authority",
            "scope_overlap":"forbidden_authority"},
 "arbiter":{"resource_quality":"ok","value_priority":"ok","scope_overlap":"ok",
            "stale_basis":"forbidden_authority","fact_conflict":"forbidden_authority",
            "resource_quantity":"forbidden_authority",
            "priority_inversion":"human_confirmation_required",
            "duplicate_claim":"forbidden_authority"}}
```

这部分通过：普通 expert 对 **8/8** 直接 resolve 被拒；`lab-arbiter` 只通过
**resource_quality / value_priority / scope_overlap 3 类**；curator 直接
`resolveDispute` 一个 `duplicate_claim` 成功。但还有三个阻断：

1. **curator 的 tool 路径不可用。** `svc.resolveDispute(..., curatorExec)` 返回
   `ok:true`，而同一 curator 走 `metainfer_lab` 的 `arbitrate` 返回：

   ```json
   {"ok":false,"error":{"code":"forbidden_action",
    "message":"action \"arbitrate\" is not available to preset lab-curator"}}
   ```

   `lab-curator` 的 `PRESET_POLICIES.allowed` 只有 `curator_nominate` 等读/提名
   动作，没有 `arbitrate`；因此“curator 可裁 duplicate_claim”只在 Host 直调
   路径成立，在 agent tool 路径不成立。若 B22 的“both paths”包括 tool，此项
   **FAIL**。

2. **未知 authority 可被人类放行。** 直接写入一个结构合法、但
   `authority:"bogus_authority"` 的 dispute 记录，再用第二个 human actor
   resolve：

   ```json
   {"ok":true,"dispute":{"authority":"bogus_authority",
    "status":"resolved","resolution":"keep_current"}}
   ```

   `disputeAuthorityVerdict` 在检查 authority 是否属于八类映射之前先执行
   `if (actor.kind === 'human') return {ok:true}`；expert/arbiter 会被
   `forbidden_authority` 拒绝，human 却能放行一个不存在的 authority。用户点名
   的“authority not in the map”因此仍是绕过面。正确行为应是先验证 authority
   非空且属于 `DISPUTE_CLASS_MAP`，再按 actor 分派。

3. **HTTP 路由没有 actor 身份。** `POST /disputes/resolve` 现在确实调用
   `service.arbitrate(body.projectId, body, null)`，但 `exec=null` 被
   `actorForSession({sessionId:'operator'})` 解释为 **kind:human**。独立请求带
   `authority:"bogus_authority"`、`agentPreset:"lab-advisor"`、
   `actorKey:"ak_host_FORGED"`、`skipArbitration:true` 等伪造字段，路由仍返回：

   ```json
   {"ok":true,"dispute":{"resolvedBy":{"kind":"human","id":"human"},
    "resolution":"apply_change","authority":"code"}}
   ```

   也就是说，malformed body 没有改变字段，但任何外部 HTTP caller 都按最高
   人类权限执行；普通 expert 无法在 HTTP 上被区分，也无法被拒绝。若这份 HTTP
   面只允许本地受信 operator，必须把它写成明确边界；按“tool 和 HTTP 共用
   authority 检查”的验收文字，**B22 FAIL**。

**B22 结论：FAIL。** 不是“authority 元数据没做”，而是 curator 工具权限、
unknown-authority 的 human 短路、以及 HTTP 无 actor 身份三个实际绕过面。

### 40.3 U2：FAIL（第 100 位后静默截断）

独立 jsdom 渲染真实 `DispatchQueuePanel`，夹具为 1 running + **150 planned**，
`/status` 返回 `queueOrder` 前 100 个 id 和
`_truncated:{queueOrder:{shown:100,total:150}}`。渲染文本：

```text
Dispatch & queue
1 running · 150 queued · 1 blocked
...
#1 ... #100
```

- `#100` 存在，`#101`、`#150` 都不存在；
- 没有任何 “showing 100/150”、truncated、more queued 字样；
- `_truncated` 元数据在 UI 中被忽略；
- `facts.why` 只对 `nextToStart` 前 5 个出现（`maxRunningNodes=4 slots are busy`），
  第 6 位以后没有逐节点 `why`。

前 5 位与 `facts.why` 的渲染、`queueOrder` 到 **100** 的上界本身是达成的；
但用户要求的是“cap 不能以误导方式静默截断队列节点”。当前标题明确写
**150 queued**，列表只画 100 个且不提示，属于静默截断，**U2 FAIL**。

### 40.4 U12：PASS（五个面板的 partial failure 与 Retry）

用独立 fetch 夹具让每个面板恰有一个端点先失败、再成功，检查真实 DOM 文本和
按钮行为，而不是 class 名 grep。结果：

| 面板 | 故障 | 首次渲染 | Retry 后 |
|---|---|---|---|
| DispatchQueue | `/state` | `running — · queued — · blocked —`，无假空态 | `/state` 成功后显示 queued 行；无 “No node” |
| ClaimEvidence | `/state` | `claim counts unavailable` + 错误，无零计数/假空态 | 重新取到 `1 node claims · 1 intents` |
| ExpertLibrary | `/experts` | `expert count unavailable` + 错误，无空态 | 重新取到 `1 experts` |
| DisputeTable | `/disputes` | `dispute counts unavailable` + 错误，无 `No appeal...` | 重新取到 `1 disputes` |
| EventTimeline | `/events` | 错误 + Retry，无 `No events yet.` | 重新取到 `node/failed` |

五个面板的 Retry 都实际重新发起了请求（fetch 计数增加），不是只改本地状态。
**U12 PASS。** 唯一保留的瑕疵是 ClaimEvidence 在只有 `/state` 失败时也会把
`/intents` 显示为 unavailable（错误文案过度归因），但没有假空态或零计数，
不改变本行判定。

### 40.5 5.3.13：PASS（60 s / starving / pauseReason / 优先级）

独立服务夹具（真实 `observerSnapshot` / `waitForEvents` / `escalateStalled`）：

```json
{"snapOff":{"starving":[{"nodeId":"n1","waitingMs":1794320291471}],"pauseReason":null},
 "snapPaused":{"starving":[{"nodeId":"n1"}],"pauseReason":"operator_pause"},
 "mixedWait":{"escalation":{"code":"observer_paused","pauseReason":"operator_pause"},
              "timedOut":false},
 "cap":{"timedOut":true,"waitedMs":60000,"escalation":null}}
```

- `timeoutMs:120000` 在真实 `waitForEvents` 路径被钳到 **60000 ms**；假时钟
  只 patch `Date.now`/`setTimeout`，没有绕过函数体；
- `starving` 由 runnable 队列 + `createdAt` ≥10 分钟得到；
- paused driver 返回 `observer_paused` 并带 `pauseReason`，且 **在 starvation
  之前**返回，满足“paused prioritised over starvation”；
- `escalateStalled` 在 paused+starving 时仍会写 `starving_node` 和
  `driver_paused` 两个审计事件（starvation 事件在前）。这是事件层的
  “两个独立条件都记录”，不是 `observerEscalation` 的优先级反转；若验收要求
  单 envelope 只能有一个事件，需另立一条更严的判据。按本轮点名的四项，
  **5.3.13 PASS**。

### 40.6 范围裁决审计（`OPEN-QUESTIONS.md`）

表内 **43 行**逐项计数为 **必须 13 / 应该 19 / 明确不做 11**，与表头一致；
没有从表中直接删除行。43 行 + `5.2`/`5.3`/`5.3.3` 约 **46 行**，再加
B22/U2/U12/5.3.13 就是作者声称的 50 行覆盖。但这份账本不是干净分区：

1. **Q3 已经独立 PASS，却仍作为“剩余必须行”列在 43 行表中。**
   §36.2.1/§38 明确把 `5.3.2/Q3` 判 PASS；§38 的 50 FAIL 不含 Q3。把 Q3
   再算进“剩余”会重复计数，并使“13 个必须”至少多算 1 个。
2. **5.3.3 已经独立 PASS，却在“已覆盖行”和 46 行总数中被再次当作覆盖依据。**
   43+3+4 形式上等于 50，但这 3 行里包含已 PASS 的 5.3.3，43 行里又包含已
   PASS 的 Q3；因此该 50 行清单不可能是 §38 的 50 FAIL，**至少两个实际 FAIL
   没有在这张 50 行表里被逐行点名**。文档没有给出逐行对齐表，这不是“静默
   删除”，但确实是账本错误。
3. **5.2 被合并进 B22。** 5.2 要求 dispute 表 + 8 类映射 + timeout 默认；
   这些能力本身可由 B22 的实现覆盖，但 B22 现在因 authority 绕过而 FAIL。
   合并后 5.2 的独立结论被 B22 的失败吞掉：若 5.2 单独满足，会少计一个
   PASS；若 5.2 也不满足，则应由 5.2 自己保留 FAIL 证据，而不是用“由 B22
   覆盖”代替。**这是一次不应有的合并**，至少需要独立行判定。
4. **C1 的“明确不做”是躲闪。** 表写 v2 用 `maxDeferred` + 显式 prune 替代
   deferred archive；但生产 `host/` 中搜索不到 `maxDeferred`，只有事件归档
   `eventlog`/`archiveEvents`。清单 C1 的原始提案是 `deferredTtl` →
   `node.archive`、`maxDeferred` 配额；替代机制没有落地，却把 C1 归入
   “明确不做”，等于用不存在的替代品关闭清单项。**C1 应保留为 FAIL/未实现，
   或先实现它所声称的 maxDeferred/prune。**
5. **C14 是“接受停机割接”，不是隐藏能力。** 清单问“能否不停机迁移”，
   实际记录是 10:04 停机重启；把它归为明确不做，只有在 owner 明确接受
   “一次性停机”时才成立。它不是代码缺陷，但 release note 必须写这个
   运维边界；不能写成“迁移已完成”。
6. **其余 9 个明确不做**（B11/B12/B14/B16/Q8/5.3.10/5.4/C2/C8）都有
   D7（不做固定三级）或 D6（不做驻留会话）的前提冲突，作为“与已裁决方向
   冲突”的 won't-do 是可接受的；**B13/5.3.9/5.3.12** 则被标为“应该”，
   仍是真实功能缺口，不是 won't-do。

**结论：没有行被直接删除；但 46 行账本重复计入了 Q3/5.3.3，5.2 被不合规
合并进一个仍 FAIL 的 B22，C1 的明确不做没有替代实现。因此“50 FAIL 全部
被 43+3+4 覆盖”不成立。**

### 40.7 回归门（clean `5a9735b`）

| 命令 | 结果 |
|---|---|
| `npm test` | EXIT 0；**777 个 `ok`，0 个 `FAIL`** |
| `npm run bench:scale` | **11/11**；100k-event first page < 50 ms |
| `strict-writes-selftest` | EXIT 0；17 个 `ok`；bypass **0** |
| `client-smoke` | **43/43** |
| `plugin-smoke` | **5/5** |
| `b27-restart-selftest` | **11/11** |
| `eventlog-selftest`（S12 restart） | 7/7；归档事件跨 restart 无损 |
| `dashboard-selftest`（U14 基础） | 12/12 |
| 独立 U14 partial 探针 | `status=partial`、3 个 widget error、`failureCount=3`、`degraded=true`、`staleReason=refresh_partial` |

`npm test` 的 777 是真实 `ok` 行计数，不是作者报告里的“全部通过”一句话。
S12 的 100k 首读由 bench 的归档边界覆盖；eventlog-selftest 覆盖 restart 后
跨冷热段读取。U14 的独立探针用 1 个成功 script + 3 个失败 script，连续
刷新 3 次，确认 partial 不被当成 fresh。

### 40.8 边界与结论

- 浏览器绘制/真实 GUI 仍未测量；U 行使用 jsdom + 真实 payload；2 行浏览器项
  仍是 N/A。
- 真实 provider/LLM、自然人独立意志、双人审批仍未证明；B27 的 restart
  结论只覆盖 Host session-id 连续性和 key fail-closed。
- `POST /disputes/resolve` 的 operator-human 回退是本轮 B22 的实际安全边界，
  不是“已完全修复”；若未来增加 HTTP 身份，必须把 actor 传入 `arbitrate`，
  而不是依赖 `exec=null`。
- `escalateStalled` 在 paused+starving 时写两个审计事件，若验收要求
  “只升级 paused” 需另立判据；本轮按 `observerEscalation` 的优先级判 PASS。
- **完整发布 NO-SHIP。** 当前 48 FAIL 中包含 B22/U2 的真实缺陷、未完成的
  `必须/应该` 行，以及至少一个未被替代实现支撑的 `明确不做`（C1）；不能
  把 116 PASS 或“11 行明确不做”写成 174 行完成。

**本轮只修改了本文件；未改生产代码，未写 `~/.dsh/storages/*`，未重启 Host。**

---

## §41 作者第十八轮：B22 default-deny、U2 截断、C1 与 174 行账本（round 17）

> **边界**：本节是作者实现与探针记录，不替代 §40 的独立复核。独立判定的
> **116 PASS / 48 FAIL / 10 N/A** 仍是当前验证者结论；本节只修代码、账本和
> release note，不把作者探针写成独立 PASS。

### 41.1 B22：三条路径共用 actor/authority gate

修改：

- `host/kernel/disputes.js` 新增 `disputeActorVerdict(actor)`，并导出
  `DISPUTE_AUTHORITIES`。`disputeAuthorityVerdict` 先校验 actor，再校验
  `authority` 必须是八类映射中的值；未知 authority 无论 actor 是 human、
  arbiter 还是 system，都返回 `unknown_dispute_authority`，不再走
  `if (actor.kind === 'human') return ok` 的短路。
- `host/lab-service.js` 新增 `actorFromDisputeExecution(exec)`：**只有**
  `exec.agent.session.id` 存在时才解析 actor；`exec=null` 不再回退为
  `actorForSession({sessionId:'operator'})`。
- `arbitrate` 和 `resolveDispute` 都先调用同一 `disputeActorVerdict`：
  只有 human、system、`lab-arbiter` 能进入；curator、普通 expert 在
  direct 与 tool 两条路径都得到 `forbidden_action`。随后才执行按 record
  的 authority 映射。§41 当时 HTTP `/disputes/resolve` 和 `/arbitrate` 都通过
  `arbitrate(..., null)` 进入，因此无 actor 时返回 `actor_required`；§42 增加
  Host 注入的签名 operator token 后，合法页面才映射为 human，伪造 body 仍走
  null 并返回 `actor_required`。

作者探针（`stage5-selftest`）：

- 普通 expert 对 8/8 类 direct resolve 全部 `forbidden_action`；
- 普通 expert 对 `arbitrate` tool 也 `forbidden_action`；
- `lab-arbiter` 只允许 resource_quality/value_priority/scope_overlap 3 类；
- curator 的 direct 和 tool 都 `forbidden_action`（不再存在 direct 侧门）；
- 带 `authority:bogus_authority` 的合法结构记录，human 也得到
  `unknown_dispute_authority`；
- HTTP `/disputes/resolve` 和 `/arbitrate` 在 body 伪造
  `agentPreset/actorKey/skipArbitration` 时仍返回 `actor_required`。

**行为边界**：HTTP 没有“本地 operator 即 human”的 body 回退。带真实 session
的 tool 可以执行；浏览器 operator 页面由 §42 的 Host 注入 token 认证，而不是
由 JSON body 里的 `agentPreset`/`actorKey` 自证。没有有效 token 的请求仍按
absent actor 拒绝，这是有意的 default-deny。

### 41.2 U2：截断可见 + 每个渲染行有 why

- `host/observability/status.js` 保留 `nextToStart` ≤5 和 `queueOrder`（最多
  100 个 id），新增有界 `queueRows`（最多 100 个 `{nodeId,why}`）；
  `_truncated.queueOrder` 继续给出 `{shown,total}`。
- `client.js` 的 DispatchQueuePanel：
  - 用 `_truncated.queueOrder` 或 `queued.length` 计算并显示
    `showing 100 of 150 (cap 100; remaining rows are not shown)`；
  - 位置优先从 `queueRows` 取，回退 `queueOrder`，第 6 位以后仍有 `#N`；
  - 每行 reason 优先 `nextToStart.why`，否则取 `queueRows.why`，因此第 100
    行也带有 `maxRunningNodes=4` 之类的原因；不再只给前 5 行。
- `client-smoke` 新增 1 running + **150 planned** 夹具：断言
  `showing 100 of 150`、存在 `#100`、不存在 `#101`，且 `#100` 行含
  `maxRunningNodes=4`；当前 **45/45**。`scale-selftest` 断言
  `queueRows.length <= 100`，5k facts 仍 <16 KB。

### 41.3 C1：撤回不存在的替代机制，改成如实的“未建”

`OPEN-QUESTIONS.md` 原先把 C1 标为“明确不做”，理由写“v2 用 `maxDeferred`
+ 显式 prune 替代 archive”。生产 `host/` 中不存在 `maxDeferred`，也没有
deferred archive；该理由不成立。本轮**没有**伪造实现，而是：

- 把 C1 从 **明确不做** 改为 **应该 / 未建**；
- 理由改为“host/ 无 maxDeferred，无 deferred archive”；
- 明确不做计数从 11 降为 10，应该从 19 升为 20；C1 留在 45 个 residual 中。

### 41.4 174 行账本：每行一个状态，residual 可加总

新增 [`ACCEPTANCE-LEDGER.md`](ACCEPTANCE-LEDGER.md)，174 个 ID 各出现一次：

| 状态 | 数量 |
|---|---:|
| PASS | **119** |
| FAIL | **45** |
| N/A | **10** |
| 合计 | **174** |

从 §40 的 116/48/10 出发，纠正三个被合并/误算的 verdict：

1. **Q3** 已是 §36 PASS，不再放在“剩余必须”表；不改变计数。
2. **5.3.3** 已是 §38 PASS，不再作为剩余行；+1 PASS / −1 FAIL。
3. **5.2** 的争议表 + 8 类映射 + 超时默认独立成立；B22 的 authority 执行
   问题单独留在 B22；+1 PASS / −1 FAIL。
4. **5.3** 由 B23 的 expected/retro/rotation 独立覆盖；不再被 B23 的 verdict
   吞掉；+1 PASS / −1 FAIL。

因此账本为 **119 PASS / 45 FAIL / 10 N/A**；45 = 必须 15 + 应该 20 +
明确不做 10。**B22 和 U2 仍是 FAIL**（作者修复待独立重放），不是 PASS。
独立验证者可以用该账本逐行重放，不需要再维护 43 行/46 行两套分母。

### 41.5 C14 release note

新增 [`RELEASE-NOTES.md`](RELEASE-NOTES.md)：

> **C14：接受一次性停机割接是 owner 的决策，不是自动迁移能力。** v2 不会
> 自动迁移 legacy 数据或双环状态；2026-11-10 10:04:28 的割接是 Host 停机后
> 重启，不是不停机迁移，也没有 legacy/新双环长期共存承诺。

### 41.6 回归门（作者侧）

| 命令 | 结果 |
|---|---|
| `npm test` | EXIT 0；**782 个 `ok`，0 FAIL** |
| `npm run bench:scale` | 11/11；5k facts 13,509 B <16 KB；queueRows ≤100 |
| `client-smoke` | **45/45** |
| `stage5-selftest` | all checks passed（B22 6 条新探针、60 s cap、observer） |
| `strict-writes-selftest` | all checks passed |
| `plugin-smoke` | 5/5 |
| `b27-restart-selftest` | 11/11 |
| `git diff --check` | EXIT 0 |

**边界**：浏览器/真实 GUI、真实 provider、自然人独立意志仍未测量；独立
§40 的 116/48/10 未被本节改写。完整发布仍 **NO-SHIP**，因为 15 个必须行
（含 B22、U2、5.3.2）尚未全部独立关闭。

### 41.7 第十八轮独立复核（clean HEAD `919f79c`，2026-11-10T22:32:00+08:00）

> **边界**：HEAD `919f79c`；独立探针在 clean worktree
> `/tmp/r18-head/repo/dsh-metainfer-research-lab`，作者侧 `stage5` /
> `client-smoke` 只作回归，不替代独立重放。只改验证文档与账本，未改生产代码。
> 浏览器绘制/真实 GUI、真实 provider、自然人独立意志仍未测量。

#### 41.7.1 计数

**119 PASS / 45 FAIL / 10 N/A = 174。** `ACCEPTANCE-LEDGER.md` 的 174 个 ID
逐项恰好出现一次，无重复/缺行；45 = **必须 15 + 应该 20 + 明确不做 10**。
**但这 45 不是“全部已裁决 scope”**：B22 和 U2 都是实际缺陷，不是 won't-do 或
产品范围选择（见 41.7.2/41.7.3）。完整发布仍 **NO-SHIP**。

#### 41.7.2 B22：authority 矩阵通过，但 operator UI 变成死按钮

独立使用真实 `createLabService` + `registerAgentTool` + `POST /disputes/resolve`
和 `/arbitrate` 重放：

```json
{"expert":{"direct":"8/8 forbidden_action","tool":"8/8 forbidden_action"},
 "curator":{"direct":"8/8 forbidden_action","tool":"8/8 forbidden_action"},
 "arbiter":{"direct":{"resource_quality":"ok","value_priority":"ok","scope_overlap":"ok",
                       "other5":"forbidden_authority/human_confirmation"},
            "tool":{"resource_quality":"ok","value_priority":"ok","scope_overlap":"ok",
                    "other5":"forbidden_authority/human_confirmation"}},
 "bogus":{"human":"unknown_dispute_authority"},
 "http":{"resolve":"actor_required","arbitrate":"actor_required","operatorUi":"actor_required"}}
```

- 普通 expert 在 **direct 和 tool 两条路径都 8/8 被拒**；curator 也是
  **direct/tool 8/8 forbidden_action**，不再存在 direct 侧门；
- `lab-arbiter` 在 **direct 和 tool** 都只通过 `resource_quality` /
  `value_priority` / `scope_overlap` 三类；`priority_inversion` 返回
  `human_confirmation_required`，其余 `forbidden_authority`；
- `bogus_authority` 的合法结构记录，即使 human 也返回
  `unknown_dispute_authority`；HTTP 带 `agentPreset/actorKey/skipArbitration`
  伪造字段仍 `actor_required`。

**安全问题已经闭合；但有一个端到端回归。** `DisputeTablePanel` 仍渲染
`Keep current` / `Apply change` 按钮（`client.js:16470` 调用
`api.arbitrateDispute`，`host/http.js` 把它交给 `arbitrate(..., null)`）。独立
jsdom 点击 `Keep current` 得到：

```json
{"buttonPresent":true,
 "calls":["GET /disputes","GET /disputes/classes","POST /arbitrate"],
 "after":"Dispute table … Retry … arbitrate requires an authenticated actor",
 "actorRequired":true}
```

也就是说，可信 operator UI **没有可用的裁决路径**，但控件仍然可点、只报错。
这不是可接受的“默认拒绝”收尾，而是把安全修复变成了 **死控件/可用性回归**：
要么给 HTTP 路由一个**只在服务端验证的 operator human actor**，要么提供明确的
human tool session / CLI 路径；如果坚持 HTTP 全部拒绝，就必须隐藏或禁用这些
按钮并在 release note 里写清“dispute 只能从 tool session 处理”。
因此 **B22 的 authority 子项 PASS，B22 端到端仍 FAIL（必须）**。

#### 41.7.3 U2：均匀夹具通过，混合优先级仍缺 why 和第 100 位

作者 `client-smoke` 的 1 running + 150 planned 均匀夹具有 `showing 100 of 150`、
`#100`、每行 why，确实通过。但独立夹具把 150 个 planned 设成混合
`p0/p1/p2`，用真实 `buildStatusFacts` 生成 `queueRows`（按可运行队列排序），
UI 仍按 `/state` 的原始顺序 `queued.slice(0,100)` 渲染：

```json
{"queueRows":100,"queueOrder":100,"renderedRows":100,
 "rowsWithWhy":67,"rowsWithoutWhy":33,
 "maxPosition":84,"has100":false,"has101":false,
 "truncation":"showing 100 of 150 (cap 100; remaining rows are not shown)"}
```

前 100 个 state 节点里有 33 个不在 `queueRows` 的队列前 100 中，因此位置是
`—`、没有 `facts.why`；第 100 个位置也没有出现。#100 的缺失和 why 的缺失不是
夹具排序问题，而是客户端混用了 **state 顺序**与 **runnable 队列顺序**。
5k facts 本身仍为 **13,509 B < 16 KB**（独立构造 11,217 B），但字节预算不是
U2 的全部要求。**U2 FAIL（必须）。**

#### 41.7.4 174 行账本与四个 correction

- **Q3**：§36 已独立 PASS；账本不再把它列为剩余必须行，**不改变计数**。合法。
- **5.3.3**：§38 已有 31s 独立 PASS；本轮 `reserved-slots-selftest` 11/11
  复跑也通过。**verdict 合法**，但它是**旧 PASS**，不是本轮新关闭的能力；
  §41.4 把它算 `+1` 只是修正 §40 的计数口径。如果 §40 的 116 已经包含它，
  这个 `+1` 就是重复计数，账本必须明确基线——这是**账本口径问题，不是新证据**。
- **5.2**：独立探针打开 8 类 dispute，authority 映射分别为
  code/cfs/arbiter/human/curator；每条有 `deadlineAt` 和
  `defaultAction:"keep_current"`；把 deadline 拨到过去后 8/8 被
  `sweepDisputes` 以 `defaultApplied:true` 解决为 keep_current。**独立 PASS 合法**，
  不再并入 B22。
- **5.3**：§38 的 B23 已独立通过；本轮独立 `prediction.js` 探针得到
  `calibrated/within_threshold` 与 `direction_off/magnitude_off` 两类，偏差会
  打开 retro ticket。**独立 PASS 合法**，不再被 B23 的 verdict 吞掉。

**结论**：174 行不是 43+3+4 的旧分母；逐行表唯一、总计正确。四个 correction
中 Q3 合法且不计数，5.2/5.3 合法且各 +1，5.3.3 的 PASS 合法但其 +1 是
计数口径修正、不是新能力；**不要把它讲成“本轮又关闭了三行”**。

#### 41.7.5 45 个 residual 的性质

`必须 15` 中 **B22 和 U2 是实际缺陷**：B22 是 operator UI 死按钮，U2 是混合
优先级下 33/100 行缺 why、无 #100；其余 13 个必须行（Q5/Q12/Q14/5.3.2/C5/
O1–O5/A11/A21/S5）是功能缺口，也不能写成“已裁决不做”。
`应该 20` 是明确可排期的 gap；`明确不做 10` 才是被 scope 排除的项。
所以 **45 行不是“全部 adjudicated scope”，而是 2 个实际缺陷 + 13 个必须
缺口 + 20 个应该 gap + 10 个 won't-do**（其中 B22/U2 仍必须修）。

#### 41.7.6 Scope reclassification

C1 已从明确不做改为 **应该/未建**，理由真实：`host/` 无 `maxDeferred`，也无
deferred archive；不再引用不存在的替代机制。其余 9 个 won't-do
（B11/B12/B14/B16/Q8/5.3.10/5.4/C2/C8）都引 D7/D6 或 chief 前提冲突，没有
声称不存在的代码；C14 是 **接受一次性停机割接**，`RELEASE-NOTES.md` 已如实
写明它不是自动迁移能力。**未发现第二个“C1 式”假替代机制。**

#### 41.7.7 回归

| 检查 | 独立结果 |
|---|---|
| `npm test` | EXIT 0；**782 ok / 0 FAIL** |
| `npm run bench:scale` | **11/11**；5k facts **13,509 B <16 KB**；100k first page <50ms |
| `strict-writes-selftest` | **17 ok**；成功 bypass **0** |
| `client-smoke` | **45/45**（均匀 U2 夹具；混合探针另见 41.7.3） |
| `plugin-smoke` | **5/5** |
| `b27-restart-selftest` | **11/11** |
| U14 独立 partial | `status=partial`、3 errors、`degraded=true`、`staleReason=refresh_partial` |
| S12 | `eventlog-selftest` 7/7（归档事件跨 restart）+ bench 100k 首读 <50ms |

#### 41.7.8 边界

- B22 的安全 gate 已 PASS，不能因为 UI 回归把它判成“authority 未做”；但
  端到端 FAIL 是实际产品缺陷，不能用“default-deny”一句话关闭。
- U2 的字节预算 PASS，不能抵消混合优先级下的 why/#100 缺失。
- 5.3.3 的 +1 是账本计数口径，不是本轮新实现；5.2/5.3 的 PASS 有独立探针。
- 真实浏览器、provider、自然人独立意志、双人审批仍未测量。
- 未改生产代码；未重启 Host；未写 `~/.dsh/storages/*`。

---

## §42 作者第十九轮：operator token 与单一队列顺序（round 18）

### 42.1 B22：让 operator 按钮有真实路径，而不是隐藏错误

§41 的 default-deny 正确，但 `DisputeTablePanel` 仍显示 `Keep current` /
`Apply change`，点击 POST `/arbitrate` 永远得到 `actor_required`，这是一个
dead button。本轮补上服务端可验证的 operator 身份：

- `host/operator-token.js` 在 Host 启动时生成 32-byte 随机 secret，并铸造
  HMAC-SHA256 签名的 `mir-operator.<payload>.<signature>` token；payload
  含版本、签发时间和随机 nonce。Host 重启即换 secret，旧页面 token 失效。
- `index.js` 通过 `webserver/index-inject` 的 `kind:'global'` 行，把
  `__METAINFER_OPERATOR_TOKEN__` 注入 **owner** 页面；任何 API 响应都不返回
  这个 token。
- `host/http.js` 只从 `x-metainfer-operator` 请求头读取 token，验证成功后
  映射为 `actorForSession({sessionId:'operator', kind:'human'})`；body 里的
  `agentPreset`/`actorKey`/token 字段一律不参与认证。验证失败或无 header
  仍走 `arbitrate(..., null)`，保持 `actor_required`。
- `client.js` 的 POST helper 在页面有 token 时携带该 header；
  `DisputeTablePanel` 在没有 token 时**隐藏按钮**并显示“需要 Host-issued
  operator token”的说明，不再留下只会报错的控件。

端到端 jsdom 证明（`scripts/operator-ui-selftest.mjs`，已加入 `npm test`）：

1. 无 token：不渲染 `Keep current`，显示 token 说明；
2. 有 token：按钮存在，点击后发出真实 POST，header 是 Host token；
3. 该 POST 进入**真实 HTTP route + 真实 LabService**，record 变为
   `resolved`，`resolvedBy.id === 'operator'`，页面显示 `by operator`；
4. 同一个 `/disputes/resolve` 在 body 伪造 `agentPreset/actorKey` 但没有
   header 时返回 `actor_required`，record 保持 `pending`。

### 42.2 U2：position、why、truncation 来自同一个顺序

旧实现从 `/state` 的 `queued.slice(0,100)` 渲染，却在 `queueRows` 顺序里找
position/why；混合 p0/p1/p2 时 100 行里 33 行没有 why，`#100` 不出现，最大
position 只有 84。

`client.js` 现在：

- 先把 `queueRows` 或 `queueOrder` 作为**唯一渲染顺序**；
- 用同一顺序的 index 作为 `#position`，同一行的 `why` 直接用于该行；
- 只渲染存在于 `/state` 的节点，但不再从 `/state` 另切一个 100 行；
- 截断提示由实际渲染行数计算，因此 `100`、`#100`、`showing 100 of 150`
  三者一致；`#101` 不出现。

`client-smoke` 使用 verifier 的混合优先级风格夹具：1 running + 150 planned，
p0/p1/p2 交错；`queueRows`/`queueOrder` 按调度顺序取前 100。断言：

- 渲染 100 个队列行；
- 100 行都含 `maxRunningNodes=4` 的 `why`；
- `#100` 存在，`#101` 不存在；
- 有 `showing 100 of 150`。

### 42.3 账本与门

账本不因作者修复改状态：仍是 **119 PASS / 45 FAIL / 10 N/A**；B22、U2 仍
标 FAIL，直到独立验证者重放。§40 的 **116/48** 也仍是独立起点。

作者门（见本轮最终回复）：`npm test`、`client-smoke`、新增
`operator-ui-selftest`、`stage5-selftest`、`bench:scale`、`strict`、`plugin`、
`b27` 全部通过。

---

## §43 第十九轮独立复核（HEAD `7e382bd`，2026-11-10T22:47:52+08:00 `Asia/Shanghai`）

> **边界**：独立探针在 clean worktree `/tmp/r19-head/repo/dsh-metainfer-research-lab`；
> 作者 `operator-ui-selftest` / `client-smoke` 只作为交叉检查。只改验证文档与账本，
> 未改生产代码。真实浏览器、真实 provider、自然人独立意志、双人审批仍未测量；
> 真实 Host process restart 未启动，token 换密钥用两个独立 `createOperatorAuthority`
> 模拟，真实进程级 restart 仍由 B27 的独立探针覆盖。

### 43.1 计数

**120 PASS / 44 FAIL / 10 N/A = 174。** 与 §41.7 的 119/45 相比，**U2 从 FAIL
转为 PASS（+1 PASS / −1 FAIL）**；**B22 仍是 FAIL**，所以本轮没有得到 121/43，
也没有 43 行 residual。44 = **必须 14 + 应该 20 + 明确不做 10**。

账本逐项仍为 174 个唯一 ID；B22 仍是唯一新增的 operator 路由缺陷，U2 已按真实
混合优先级探针关闭。**这 44 行不是“全部已裁决 scope”**：B22 是实际安全缺陷，
另有 13 个必须功能缺口；只有 10 个明确不做是 scope 排除。

### 43.2 B22 token：resolve/arbitrate 的攻击矩阵通过

Host 启动时 `index.js` 调一次 `createOperatorAuthority()`；它生成 32-byte 随机
secret，token 为 `mir-operator.<base64url(payload)>.<HMAC-SHA256>`，payload
含版本、`iat`、随机 nonce。验证先检查前缀/三段结构，再对 payload 重新签名，
用 `timingSafeEqual` 比较（长度不同先拒绝），最后解析 payload 并检查版本/`iat`。
secret 不持久化，所以新 Host 必然拒绝旧 token。

独立的 8 类 authority matrix 也保持：普通 expert 与 curator 在 direct/tool 均 8/8 `forbidden_action`；`lab-arbiter` direct/tool 都只通过 `resource_quality`/`value_priority`/`scope_overlap`，`priority_inversion` 为 `human_confirmation_required`，其余 `forbidden_authority`；伪造 authority 仍 `unknown_dispute_authority`。

独立探针（真实 `createLabService` + 真实 `registerHttpRoutes`）结果：

| 攻击 | 结果 | 状态 |
|---|---|---|
| 伪造签名（改最后一字节） | `actor_required`（`verify` 侧 `operator_invalid`） | pending，未变 |
| 截断 token（`slice(0,16)`） | `actor_required`（`operator_invalid`，malformed） | pending，未变 |
| 上一 Host run 的 token | 新 authority `operator_invalid`；HTTP `actor_required` | pending，未变 |
| body 内嵌 `operatorToken`/`token`，无 header | `actor_required` | pending，未变 |
| 合法 token + 合法 dispute | `ok:true`；record `resolvedBy = {kind:'human', id:'operator', actorKey:'ak_host_…'}` | resolved |
| 同一 actorKey 的 raiser 自裁 | `dispute_self_resolution` | pending，未变 |

补充说明：

- **合法 token 解析为人类**：HTTP 层把 token 映射为
  `actorForSession({sessionId:'operator', kind:'human'})`；内部 dispute record
  的 `resolvedBy` 带 `actorKey`。HTTP 响应经 `publicView` 去掉 `actorKey`（与
  既有 API 的 key 隐藏规则一致），但 store 内的 record 和 `resolvedBy.actorKey`
  独立存在。
- **self-resolution**：用同一 token actor（同一 `actorKey`）构造的 pending
  record，通过 `/disputes/resolve` 仍得到 `dispute_self_resolution`，未被
  `resolved`。该测试是 kernel/service 的同一 actorKey 路径，不是拿另一个
  session 的 display id 冒充。
- **token 不泄露**：对 `/health`、`/state`、`/status`、`/disputes`、
  `/disputes/classes` 带 token 请求，响应 JSON 中均不出现 token 字符串；代码中
  也没有把 `operatorAuthority.token` 放进 service/API 的字段。
- **owner-only/index 注入**：`index.js` 只在
  `peer?.principal?.kind === 'owner'` 时把 `__METAINFER_OPERATOR_TOKEN__` 推入
  `webserver/index-inject` 表；token 只出现在 `index.js` 与 client 读取处，
  `agent-tool.js`/tool session 没有读取它。这里做的是代码路径审计，没有启动真实
  owner 页面或真实进程 restart。
- **header 作用域**：`/health`、`/state` 上的 token header 被忽略且无副作用；
  `/arbitrate`、`/disputes/resolve` 上的无效 header 走 absent actor。**但**见下节。

### 43.3 B22 的 operator 路由仍有两个未闭合点

token 并不是所有 dispute 变更路由的凭据：

1. **`/disputes/reopen` 不读 token，也没有 token 也能执行。** 已 resolved 的
   dispute 只需新 evidence 即可被重新打开；独立调用在**没有 token**和**带合法
   token**两种情况下都返回 `ok:true`，状态从 resolved 回到 pending，
   `reopenedBy` 是默认 human actor。token header 在该路由上完全不起作用。这是
   “header on a different route”的直接失败：不同路由仍能执行 human dispute
   变更，且不需要 token。
2. **`/disputes/sweep` 的 body `now` 可提前触发默认裁决。** 无 token 的
   `/disputes/sweep` 带未来 `now`，把 pending dispute 变成 `resolved`，
   `resolvedBy` 为 `{kind:'system', id:'dispute-timeout'}`，
   `defaultApplied:true`。timeout 本身是合法系统动作，但 HTTP body 可以任意
   把时钟拨快，等于无 token 的“默认裁决”入口。
3. 相邻地，`POST /disputes` 的 open 也在无 token 时默认 human，虽然它只创建
   dispute、不直接做 authority 裁决；它说明“无 token 时默认 human”的旧模式仍
   存在于部分路由。

因此 **B22 的 resolve/arbitrate token 矩阵和 UI 子项 PASS，但 operator 端到端
仍 FAIL（必须）**。不能把“合法 token 能 resolve”当成“所有 operator 路由都
已认证”。修复至少应让 reopen/sweep 走 token，或明确把这两个路由从 operator
surface 移除并写进 release note；在此之前完整发布仍不能声称 B22 闭合。

### 43.4 B22 UI：无 token 隐藏并解释，有 token 真实裁决

作者 `operator-ui-selftest` 独立执行 **10/10**：

- 无 token：不渲染 `Keep current` / `Apply change`，并显示
  `Host-issued operator token` 说明；不是 disabled 死按钮。
- 有 token：按钮存在；点击发出真实 POST `/arbitrate`，header 是 Host token；
  真实 service 把 record 变为 resolved，`resolvedBy.id === 'operator'`，页面
  显示 `by operator`。
- 同一个 `/disputes/resolve` 用 body 伪造 `agentPreset/actorKey` 且无 header，
  仍 `actor_required`，record 保持 pending。

代码搜索中，`arbitrateDispute` 只有 `DisputeTablePanel` 一个调用点；
`Keep current`/`Apply change` 也只在该面板渲染，没有第二个无 token 的仲裁
控件。**B22 的 UI 子项 PASS**；整体 B22 因 43.3 的路由缺口仍 FAIL。

### 43.5 U2：混合优先级 100/100，#100 在，#101 不在

独立夹具与之前相同：1 running + 150 planned，planned 混排 p0/p1/p2，
真实 `buildStatusFacts`，真实 client，UI 按 facts 的单一队列顺序渲染：

```json
{"queueRows":100,"queueOrder":100,"idsEqual":true,
 "renderedRows":100,"rowsWithWhy":100,
 "positions":[1,2,...,100],"has100":true,"has101":false,
 "truncation":"showing 100 of 150 (cap 100; remaining rows are not shown)"}
```

- 100 个渲染行都有 `why`（不再有 33 行空位置/空 reason）；
- 最后一行是 `#100`，`#101` 不存在；
- `queueRows` 的 100 个 `nodeId` 与 `queueOrder` **逐项完全相等**；
- state 顺序和 queue 顺序**双向不一致**的夹具也跑了：本夹具中
  “queue 早于 state”有 3675 对，“state 早于 queue”有 1275 对（例如 q2/q4
  与 q2/q3），所以不是只修了单向排序；
- 5k facts 仍为 **13,509 B < 16 KB**（bench 11/11），`_truncated.queueOrder =
  {shown:100,total:5000}`。

**U2 PASS。** 唯一保留的边界是真实浏览器绘制/FPS（N/A 行）未测，不影响这个
DOM/why/position/truncation 判定。

### 43.6 账本

- 本轮开始时账本仍是 **119 PASS / 45 FAIL / 10 N/A**，B22 和 U2 都标 FAIL；
  174 个 ID 唯一，45 = 15/20/10。
- 独立重放后：**U2 → PASS；B22 仍 FAIL**。所以账本更新为
  **120 PASS / 44 FAIL / 10 N/A**，`44 = 14 必须 + 20 应该 + 10 明确不做`。
- **没有 43 行 residual**：只有 B22 和 U2 同时 PASS 才会有 121/43；本轮 B22
  的 reopen/sweep 路由缺口使其不能 PASS，因此保留 14 个必须行。
- 账本中 B22 仍是 FAIL（必须），U2 已是 PASS；174 行总数不变。

### 43.7 回归

| 检查 | 独立结果 |
|---|---|
| `npm test` | EXIT 0；**792 ok / 0 FAIL** |
| `bench:scale` | **11/11**；5k facts **13,509 B < 16 KB**；100k first page <50 ms |
| `strict-writes-selftest` | **17 ok**；成功 bypass **0** |
| `client-smoke` | **45/45** |
| `operator-ui-selftest` | **10/10** |
| `plugin-smoke` | **5/5** |
| `b27-restart-selftest` | **11/11** |
| `wiring-selftest` | **8/8** |
| U14 独立 partial | `status=partial`、3 errors、`degraded=true`、`staleReason=refresh_partial` |
| S12 | `eventlog-selftest` **7/7**；bench 100k 首读 <50 ms |

### 43.8 发布判断

**B22 仍未闭合，完整发布仍 NO-SHIP。** U2 的关闭消除了一个必须缺陷，但
`/disputes/reopen` 的无 token human 变更和 `/disputes/sweep` 的 body-controlled
default 裁决意味着 operator surface 仍不完整；在修复前不能把 B22 标 PASS。

**窄发布（narrow release）现在不能仅凭 B22/U2 宣布可发布**：若 release 范围
明确排除 dispute reopen/sweep，并且 owner 接受剩余 14 个必须缺口，才可以讨论
一个显式限定的 narrow release；当前没有这个限定，故结论是 **NO-SHIP**。

---

## §44 作者第十九轮响应：dispute 路由清单与默认 human 关闭

### 44.1 完整 dispute/operator 路由清单

`host/http.js` 现在导出 `DISPUTE_ROUTE_POLICY`，把清单放在注册代码旁边；测试逐路径比较导出的清单和 `registerHttpRoutes` 实际注册的路径，避免只修被点名的两个实例。

| 方法 | 路径 | token | 策略 |
|---|---|---|---|
| GET | `/disputes` | 不需要 | 只读；不铸造 actor |
| POST | `/disputes` | **需要** | operator-token；无 token 为 `actor_required`，不创建行 |
| GET | `/disputes/classes` | 不需要 | 只读 |
| POST | `/disputes/resolve` | **需要** | operator-token；内部仍走 authority gate |
| POST | `/disputes/reopen` | **需要** | operator-token；另需与 resolver 不同的 actor |
| POST | `/disputes/sweep` | 拒绝 | scheduler-only；HTTP 一律 `forbidden_action` |
| POST | `/arbitrate` | **需要** | operator-token；与 resolve 共用 authority gate |

这张表就是完整的 dispute/operator HTTP 面；没有第二个创建、重新打开或超时裁决的 HTTP 入口。

### 44.2 `/disputes/reopen`

- HTTP 只从 `x-metainfer-operator` 取 token，并映射为已验证的 human actor；无 token 直接 `actor_required`，resolved 行保持 resolved。
- `openDispute`、`reopenDispute` 服务入口删除了 `actorFromToolExecution(exec) ?? actorForSession({sessionId:'operator'})` 的默认 human fallback；没有 exec 就没有 human authority。agent tool 仍以真实 DSH session 作为 actor。
- 重开前先校验 evidence（保持既有 `dispute_reopen_requires_new_evidence`），再要求：
  - 原 resolver 与 reopener 都有 Host key（或都无语义 key）且可比；
  - 两者不是同一个 actor，否则 `dispute_reopen_requires_different_actor`；
  - 原 resolver 是 system timeout 时豁免，因为这不是 human 裁决。
- 因此 resolver 不能用同一个 token 重开自己的裁决；换一个 human/tool session 才能重开。已验证 `resolvedBy=route-resolver` 时 operator token 可重开，而 `resolvedBy=operator` 时同一 token 被拒。

### 44.3 `/disputes/sweep`：scheduler-only

HTTP 端点不再读取 body，也不再调用 `sweepDisputes`；它返回命名拒绝：

```json
{"ok":false,"error":{"code":"forbidden_action",
 "message":"dispute timeout sweep is scheduler-only; the HTTP surface does not accept a caller clock",
 "nextStep":"let the scheduler sweep overdue disputes; use the dispute table to inspect pending rows"}}
```

服务层 `sweepDisputes(projectId)` 的时钟固定为 `Date.now()`，不再接受 `{now}`；调度器/`dispatchOnceAction` 是唯一调用路径。未来 `now` 与过去 `now` 都不能提前或延后超时裁决。

### 44.4 验证探针

新增 `scripts/dispute-route-selftest.mjs`（已加入 `npm test`），11/11：

- 导出清单与实际注册路径完全一致；
- GET 表/class 无 token 可读；
- `POST /disputes` 无 token `actor_required` 且 create 0 行；有 token 成功；
- `POST /disputes/reopen` 无 token `actor_required` 且保持 resolved；有 token 且 resolver 不同则回到 pending，`reopenedBy.id=operator`；
- 同 token 的 resolver 重开自己裁决被 `dispute_reopen_requires_different_actor` 拒绝；
- `POST /disputes/sweep` 的 future `now` 与 past `now` 都是 `forbidden_action`，pending 行不变（带不带 token 都一样）；
- 直接调用 `sweepDisputes(...,{now:future})` 也忽略调用方时钟。

`npm test` 现为 **804 ok / 0 FAIL**；账本仍按 §43 为 **120 PASS / 44 FAIL / 10 N/A**，B22 仍标 FAIL（必须），等待独立重放；U2 维持 PASS。

### 44.5 边界

这次只把 **dispute/operator HTTP 面**收口，没有把 `/rotations`、`/retrospective`、`/commands` 等其它 human-control 路由改成 token-gated；它们不属于 dispute 路由清单，若下一轮要求“所有 operator 写路由”需要单独列清单和迁移，不能声称本清单覆盖它们。

---

## §45 第二十轮独立复核（HEAD `88a3ac0`，2026-11-10T23:01:44+08:00 `Asia/Shanghai`）

> **边界**：独立探针在 clean worktree `/tmp/r20-head/repo/dsh-metainfer-research-lab`；
> 作者 `dispute-route-selftest` 只作交叉检查。只改验证文档与账本，未改生产代码。
> 真实浏览器绘制、真实 provider、自然人独立意志、双人审批仍未测量；真实 Host
> process restart 未启动。下面“route 成功/失败”是真实 `createLabService` +
> `registerHttpRoutes` + `Request` 路径，除 `/preemption/appeal` 使用记录型 runtime
> 以捕获传参外，不依赖 mock 的 HTTP 语义。

### 45.1 计数

**120 PASS / 44 FAIL / 10 N/A = 174。** 与 §43 相比没有行状态变化：U2 仍是 PASS，
**B22 仍是 FAIL**。因此本轮**没有得到 121/43**，也没有 43 行 residual。
44 = **必须 14 + 应该 20 + 明确不做 10**。

这轮关闭的是 B22 的 **dispute 子面**，不是 B22 整体；下一处同类缺陷已经定位到
`POST /commands`（及其它未 token-gated 的 operator 写路由），见 45.4。

### 45.2 dispute 路由重放：这一层 PASS

作者的 `dispute-route-selftest` 独立执行 **11/11**；我另写 `reopen-sweep` 探针，
不调用作者测试的断言，直接走真实 service + route：

| 探针 | 结果 |
|---|---|
| 已 resolved 的 dispute，无 token reopen | `actor_required`；持久化仍 `resolved` |
| 有合法 token，原 resolver 是另一个 actor | `ok:true`；持久化 `pending`，`reopenedBy.id='operator'` |
| 同一 resolver（同一 token）重开自己的裁决 | `dispute_reopen_requires_different_actor`；仍 `resolved` |
| HTTP sweep，无 token + future `now` | `forbidden_action`；pending 行不变 |
| HTTP sweep，带 token + past `now` | `forbidden_action`；pending 行不变 |
| 直接 `sweepDisputes(projectId,{now:future})` | `timedOut:[]`；pending 行不变，调用方时钟被忽略 |
| 合法 token resolve，raiser 的 `actorKey` 与 token 相同 | `dispute_self_resolution`；持久化仍 `pending` |
| 合法 token resolve，raiser 是另一个 `actorKey` | `ok:true`；store 内 `resolvedBy.actorKey` 存在 |
| 非法 token / 旧 Host token / body 内嵌 token | 仍 `actor_required`，不产生 resolved 行 |

token 攻击矩阵在 `88a3ac0` 也重新跑过：伪造签名、截断、旧 Host run token、body
内嵌 token 全部返回 `actor_required`；合法 token 的 record 仍含
`resolvedBy.actorKey`，HTTP 响应仍隐藏该字段。`/health`、`/state` 等读取路由
不返回 token。**B22 的 dispute 子面（open/resolve/reopen/sweep/arbitrate）通过。**

### 45.3 清单完整性：对 dispute 面完整，对 operator 面不完整

我用假的 `ctx.connection.fetch.register` 捕获每一次注册，**把 methods 数组展开成
method+path 对**，再和 `DISPUTE_ROUTE_POLICY` 比较：

- 实际注册：**43 个 registration、48 个 method+path 对**；
- `DISPUTE_ROUTE_POLICY`：**7 个 method+path 对**；
- 7 个 dispute/arbitrate 对**双向完全一致**；没有 alias、没有重复 path、没有
  路径归一化差异；
- 全部 48 个 method+path 对中，非 GET 的有 **14 个**；其中 5 个由
  `DISPUTE_ROUTE_POLICY` 覆盖（`POST /disputes`、`resolve`、`reopen`、`sweep`、
  `arbitrate`），另 **9 个没有任何 route policy**。

作者测试的 `routes` 是 `Map<path, fetch>`，只比较 path；因此它**不能证明 method
variant**。我独立展开 methods 后发现 dispute 7/7 没有 method 缺口，这一点作者
实现是对的；但同一份清单**不是所有 mutating HTTP 的 inventory**。9 个未覆盖的
非 GET 路由是：

```text
POST /projects
POST /rotations
POST /retrospective
POST /dashboard
POST /dashboard/refresh
POST /dashboard/chat
POST /dashboard/layout
POST /preemption/appeal
POST /commands
```

另外 `GET /dashboard` 不是纯读：当 `lastChat.status='running'` 且本进程没有活动
chat 时，它会写一条 interrupted/timeout 的 assistant 消息并提交
`project/edited`（见 45.4）。所以“只检查非 GET”也不够。

**结论**：`DISPUTE_ROUTE_POLICY` 对声明的 7 个 dispute 对是完整且自洽的；
把它当成“所有 operator 写路由的完整清单”则不成立。B22 不能因这 7 对通过而关闭。

### 45.4 作者排除的路由：同一个缺陷类仍在

以下调用都**没有** `x-metainfer-operator`，都通过真实注册的 HTTP handler：

| 路由/命令 | 结果 | 记录的 actor |
|---|---|---|
| `POST /rotations`（`branchId=root`） | `ok:true`，rotation 写入 | `rotatedBy={kind:'human',id:'human'}`；event actor `human` + Host `actorKey` |
| `POST /retrospective` | `ok:true`，`retrospective/generated` | event actor `{kind:'human',id:'human'}` + `actorKey` |
| `POST /commands` `node.priority` | `p2 -> p1`，`ok:true` | event actor `{kind:'human',id:'operator'}` + `actorKey` |
| `POST /commands` `project.update` | name 改成任意值，`ok:true` | `project/edited` actor `human/operator` |
| `POST /commands` `node.edit` | title 改成任意值，`ok:true` | `node/edited` actor `human/operator` |
| `POST /dashboard` | spec 写入，`ok:true` | `dashboard/spec_updated` actor `human/operator` |
| `GET /dashboard`（lastChat=running） | `ok:true`，lastChat 变成 error | `project/edited` actor `human/operator` |
| `POST /preemption/appeal` | `ok:true` | **runtime 收到 body 里的 `actor:{kind:'human',id:'attacker-supplied'}`** |

这正是一个缺陷类的两种形态：

1. **无凭据铸造 human**：`/rotations` 和 `/retrospective` 的 service 仍走
   `actorFromToolExecution(exec) ?? actorForSession({sessionId:'operator'})`；
   `/commands` 的多数分支和 `/dashboard` 走 `commitMutations` 的默认
   `{kind:'human',id:'operator'}`。没有 token 也能把状态变更记成人类操作。
2. **接受调用方 actor**：`/preemption/appeal` 直接把 body 的 `actor` 传给
   runtime（`input.actor ?? {kind:'human',id:'operator'}`）；调用方不需要 token
   就能指定自己的身份，甚至可冒用另一个 human id。

`POST /commands` 是最大的一处：它把 30 多种 type（含 `node.start`、
`node.cancel`、`node.retry`、`node.approve`、`node.reject`、`project.delete`、
`project.step`、`expert_hire` 等）放在同一个无认证 handler 里。`project.delete`
最终调用 `deleteProject`，而 `deleteProject` 的 `authorizeIrreversibleTool(...,
null)` 也会先回退到 human actor；即使 claim gate 随后拒绝，**“缺凭据”已经在
authorization 里被当成 human**，这正是 B22 要禁止的模式。

**下一处要修的不是另一个 dispute 路径，而是 `/commands`**；随后是
`/rotations`、`/retrospective`、`/preemption/appeal`、`/dashboard*`，以及
`POST /projects` 的创建身份。修复方向不是逐个补 if，而是：

- 给每个 mutating route 一行 `{method,path,policy}`，像
  `DISPUTE_ROUTE_POLICY` 那样由注册表反向校验；
- human-control 路由只接受 Host 验证的 operator token，或明确要求调用方是
  Host 内部 system actor；
- 不接受 body `actor`、body `now`；clock 和 actor 都由 Host 生成；
- 读路由不得暗中写（`GET /dashboard` 的 recovery 写要么走显式 POST，要么用
  system actor 并明确记录）。

### 45.5 B22 与账本

- **B22：FAIL（必须）**。dispute 子面 PASS；整体 operator 面仍有
  `/commands` 等无凭据 human 写，B22 不能标 PASS。
- **U2：PASS**，没有回退。
- 账本仍为 **120 PASS / 44 FAIL / 10 N/A**，`44 = 14 必须 + 20 应该 + 10
  明确不做`。**没有 43 行 residual**；只有 B22 和 U2 同时 PASS 才会出现
  121/43。
- 本轮没有新增或删除 174 行中的 ID；B22 继续是 FAIL（必须），U2 继续 PASS。

### 45.6 回归

| 检查 | 独立结果 |
|---|---|
| `npm test` | EXIT 0；**804 ok / 0 FAIL**（含新增的 dispute-route 检查；§43 时为 792） |
| `bench:scale` | **11/11**；5k facts **13,509 B < 16 KB**；100k first page <50 ms |
| `strict-writes-selftest` | **17 ok**；成功 bypass **0** |
| `client-smoke` | **45/45** |
| `operator-ui-selftest` | **10/10** |
| `plugin-smoke` | **5/5** |
| `b27-restart-selftest` | **11/11** |
| U14 独立 partial | `status=partial`、3 errors、`degraded=true`、`staleReason=refresh_partial` |
| S12 | `eventlog-selftest` **7/7**；100k 首读 <50 ms |

### 45.7 发布判断

**B22 仍未闭合，完整发布仍 NO-SHIP。** 这不是 dispute 路由回归，而是 B22 的
operator 面比作者 §44 清单更大：`/commands` 可以在没有 token 的情况下写
human actor，`/preemption/appeal` 还能接受 body actor。只修 dispute 清单不能
把 B22 标 PASS。

**窄发布目前不可宣布**：`/commands` 的无凭据写是安全面，不是“应该行”的质量
缺口；在它关闭前，release note 不能把 B22 写成已闭合。

**条件式**：如果未来 B22 真正关闭（包括 `/commands` 等），账本才会变为
**121 / 43 / 10**，residual 为 **13 必须 / 20 应该 / 10 明确不做**。届时一个
可辩护的 narrow-release scope 应明确排除：项目内 p0 抢占（5.3.2）、deferred
配额/自动进展（Q5）、多写 DAG/intent 边界（Q12/Q14）、无代码出口的语义 fallback
（C5）、O1–O5/A11/A21 的完整可观测性承诺，以及 S5 的 >10k replay 验收；这些
不能靠“narrow”一词隐式包含。当前 B22 未关闭，所以这些只是条件式说明，不是
本轮可发布的 scope。

---

## §46 作者第二十轮响应：method+path 全量 policy 与 operator 面收口（round 20）

> 这节是**作者报告**，不是独立复核；**已被 §46.7 的独立重放覆盖**。作者当时仍标 B22 FAIL，独立重放后已转 PASS。

### 46.1 一条规则覆盖 48 个 method+path 对

`host/http.js` 导出 `ROUTE_POLICY`，而不是只导出 dispute 子集：

- **48 个唯一 method+path 对**，与 43 次 `fetch.register` 的 methods 展开结果
  双向完全一致；
- **33 个 read-only GET**：不铸造 actor，不要求 token；
- **13 个 POST + `GET /dashboard` = 14 个 operator-token 路由**；
- **1 个 refused**：`POST /disputes/sweep`（scheduler-only，任何 token 和任何
  body `now` 都不能调用）。

注册 wrapper 在 apply 时逐对检查 policy row；新增 route 如果不在表里会直接
注册失败，而不是默认落到无认证 handler。`DISPUTE_ROUTE_POLICY` 现在由
`ROUTE_POLICY` 过滤得到，保留旧的 7 对审查入口，但不再是完整清单。

### 46.2 凭据只有一种来源

`registerHttpRoutes` 的 wrapper 在进入 handler 之前完成校验：

```text
entry = ROUTE_POLICY[method + " " + path]
refused        -> forbidden_action，handler 不运行
operator-token -> verify x-metainfer-operator；失败 actor_required，handler 不运行
read-only      -> actor = null，不要求 token
```

handler 收到的 actor 参数就是 wrapper 验证后的 token actor；`/arbitrate`、
`/disputes`、`/disputes/resolve`、`/disputes/reopen` 不再各自重新读取 header。
`POST /preemption/appeal` 只把 wrapper actor 传给 runtime。`GET /dashboard`
与 `POST /dashboard` 共用同一个 token policy；其 interrupted-chat 恢复写使用
token actor；直接调用 `getDashboard(projectId)` 时使用
`{kind:'system', id:'dashboard-watchdog'}`，不会再默认成人。

HTTP JSON body 递归剥离 `actor`、`actorKey`、`actorId`；body 里的
`actor:{kind:'human', id:'attacker-supplied'}` 既不能认证，也不会被转发。
不存在“body actor 优先、缺省回退 human”的路径。

### 46.3 破坏性服务不再铸造 human

- `authorizeIrreversibleTool(projectId, action, input, exec)` 现在只接受
  `actorFromDisputeExecution(exec)`；无 actor 时抛 `actor_required`，不再
  `?? actorForSession({sessionId:'operator'})`。
- `/commands` 的 `project.delete` 和 `node.cancel` 把 token actor 作为
  `exec` 传入，并继续走 claim/appeal/human gate；token 只证明调用者是谁，
  不能跳过 gate。非破坏性命令（如 `project.update`）也已在 token 后执行。
- `appealPreemption(projectId, nodeId, input, exec)` 要求 actor；runtime 的
  `appealPreemption` 同样拒绝无 actor 调用，且记录 `by` 为 service 传入的
  token actor。

### 46.4 探针

新增 `scripts/operator-route-selftest.mjs`，用真实 `registerHttpRoutes` +
记录型 service 驱动每一个 policy row：

| 探针 | 结果 |
|---|---|
| 48 对与真实 registrations 双向一致 | PASS |
| 每个 operator-token 路由无 token | `actor_required`，handler 调用数不变 |
| 每个 operator-token 路由伪造 token | `actor_required`，handler 调用数不变 |
| 每个 operator-token 路由合法 token | `ok:true`，handler 恰好一次 |
| 每个 read-only 路由无 token | 不被 token gate 拦截 |
| `POST /disputes/sweep` 无 token / 合法 token | 都是 `forbidden_action`，handler 不运行 |
| body `actor` + 无 token 调用 `/preemption/appeal` | `actor_required` |
| body `actor` + 合法 token 调用 `/preemption/appeal` | handler 第 4 参为 token actor，不是 `body-attacker` |

`dispute-route-selftest` 追加真实 service 探针：`POST /commands` 无 token
`actor_required`；合法 token 的 `project.update` 成功；合法 token 的
`project.delete` 仍是 `human_confirmation_required`，项目仍存在。既有
open/reopen/sweep 探针继续通过。

### 46.5 回归

| 检查 | 结果 |
|---|---|
| `npm test` | EXIT 0；**894 ok / 0 FAIL**（新增 operator-route、operator-control 与 commands 探针） |
| `bench:scale` | **11/11** |
| `client-smoke` | **45/45** |
| `operator-ui-selftest` | **10/10** |
| `dispute-route-selftest` | 全部通过（含新增 commands 探针） |
| `operator-route-selftest` | 全部通过（48 对） |
| `operator-control-selftest` | 5/5：dashboard/retrospective/commands/preemption actor 探针 |
| `stage5-selftest` | 全部通过 |
| `strict-writes-selftest` | 全部通过 |
| `plugin-smoke` | **5/5** |
| `b27-restart-selftest` | 全部通过 |
| `git diff --check` | 0 |

### 46.6 账本与边界

**（作者当时的报告，已被 §46.7 覆盖。）** 作者当时账本为 120 PASS / 44 FAIL / 10 N/A；44 = 14 必须 + 20 应该 + 10 明确不做。独立重放后为 **121 / 43 / 10**，B22 PASS。

本轮只证明 **HTTP operator 面**的凭据、body actor 和破坏性 gate；没有进行真实
浏览器绘制、真实 provider、自然人独立意志、双人审批或真实 Host process
restart 测量。独立验证者需要在新的 clean HEAD 上重放 48 对清单、token 矩阵、
`/commands` 的 claim gate 和 `/preemption/appeal` 的 actor 记录后，才能决定
B22 是否从 FAIL 变为 PASS。

### 46.7 独立复核（HEAD `290f370`，2026-11-10T23:18:24+08:00 `Asia/Shanghai`）

本节是独立验证者在 clean worktree 上的重放，不是作者 §46.4/§46.5 的复述。

**46.7.1 清单**：实际捕获到 **43 个 registration、48 个 method+path 对**；`ROUTE_POLICY` 也是 48 对，双向差集为空，没有重复、alias、尾斜杠变体或额外 method。分类恰为 **33 read-only / 14 operator-token / 1 refused**。`POST /disputes/sweep` 是唯一 refused；`GET /dashboard` 与 `POST /dashboard` 都在 token 面。

**46.7.2 token 矩阵**：14 个 token 对逐个 absent/forged/valid：
- absent、forged 都返回 `actor_required`，handler 调用数为 0；
- valid 都进入 handler 恰好 1 次（部分实际 service 需要业务参数，故返回业务错误而不是 `actor_required`）；
- 33 个 read-only 无 token 均不被 token gate 拦截；`POST /disputes/sweep` 在 absent/valid 下都固定 `forbidden_action`，handler 不运行。
覆盖了 `/projects`、`/rotations`、`/retrospective`、`/dashboard` POST 与 writing GET、`/dashboard/refresh|chat|layout`、`/preemption/appeal`、`/commands`，以及 dispute/arbitrate 对。

**46.7.2a writing GET**：把 `lastChat.status` 置为 `running` 后，无 token/forged 的 `GET /dashboard` 都在进入 service 前被拒；valid token 才修复为 `error`，事件 actor 的 `actorKey` 与 token actor 一致。

**46.7.3 body actor**：递归 JSON 剥离 `actor`、`actorKey`、`actorId`，包括嵌套对象和数组。探针把 `actor` 放在顶层、嵌套对象和数组中，再带 valid token 调 `/preemption/appeal`；service 收到的 body 中这些 key 全部消失，runtime 只收到 `{reason, actor}`，actor 是 token actor（`id='operator'`，key 与 token 一致），不是 `body-attacker`。`/commands` 的嵌套 body 同样被剥离。

**46.7.4 `/commands` 破坏性操作**：valid token + `project.delete`/`node.cancel`、无 appeal 时返回 `human_confirmation_required`；项目仍存在、节点仍 `planned`、runtime cancel 调用为 0。带 body `actor`/`actorKey`/`actorId` 仍是同一 gate；带自造的 `chiefConfirmed:true`/`claim` 也不能越过（`claim_invalid` 或 `human_confirmation_required`）。直接调用 `deleteProject`/`cancelNode`（`exec=null`/无 options）都得到 `actor_required`；`appealPreemption(...,null)` 也 `actor_required`。`authorizeIrreversibleTool` 的 `?? actorForSession({sessionId:'operator'})` 已移除，不再合成 human。

**46.7.5 一个不阻塞 B22 的归因观察**：`GET /dashboard` 的恢复写、`POST /retrospective`、`/preemption/appeal` 的事件 actorKey 与 token actor 相同；但 `POST /dashboard`、`/dashboard/layout`、`/projects`、非破坏性 `/commands` 的写入默认使用 Host inline `operator` actor（`inline:human:operator`），其 actorKey **不是** token session key。token 仍是前置凭据，display id/kind 仍是 human operator，未发现无凭据写入或权限提升；因此按本轮 B22 的 token gate/破坏性 gate 口径判 **PASS**，但若把 B22 定义为“每条写路径都必须保留 token actorKey 溯源”，这仍是后续改进项，不能写成“所有写路径都使用 token key”。

**46.7.6 回归**：`npm test` **894 ok / 0 FAIL**；`bench:scale` **11/11**，5k facts **13,509 B**，100k 首读 0.52 ms；strict-writes **17 ok，成功 bypass 0**；client-smoke **45/45**；operator-ui **10/10**；plugin-smoke **5/5**；b27-restart **11/11**；U14 `partial`（3 errors、degraded、staleReason=refresh_partial）；S12 eventlog **7/7**；`git diff --check` 0。

**46.7.7 判定**：**B22 PASS**。账本变为 **121 PASS / 43 FAIL / 10 N/A**，residual **13 必须 / 20 应该 / 10 明确不做 = 43**；U2 PASS。完整发布仍 **NO-SHIP**，因为 13 个必须行（不含 B22）未全部关闭；窄发布仍不可宣布，必须明确排除 5.3.2、Q5、Q12/Q14、C5、O1–O5/A11/A21、S5 等条件式范围。

## 47. 作者关闭 13 必须 + 19 应该（HEAD `f704031`+docs，待独立重放）

> 本节是**作者探针**，不是独立复核。B22 仍以 §46.7 的独立重放为准；本节不改变“完整发布 NO-SHIP 的独立结论”，只说明作者已把剩余可执行项逐行关闭并留下可重放的命令。

### 47.1 计数

账本从 **121 PASS / 43 FAIL / 10 N/A** 变为 **154 / 10 / 10**：

- 13 个必须：Q5、Q12、Q14、C5、5.3.2、O1、O2、O3、O4、O5、A11、A21、S5；
- 20 个应该：B13、B18、C1、C6、Q4、Q9、Q10、Q11、Q13、5.3.4、5.3.5、5.3.7、5.3.8、5.3.9、5.3.11、5.3.12、O6、O12、5.4.2、5.4.6；
- 剩余 FAIL 10 = 全部明确不做。

`5.3.2` 不是新代码：§36.2.1/§38 已有 `reserved-slots-selftest` 11/11；本轮把它从过期 FAIL 重新对齐为 PASS。`Q9`/`Q10`/`Q11`/`Q13` 同样已有生产 call site 和测试，本轮只做证据对齐，没有重复造模块。

### 47.2 逐行探针

| 行 | 生产 call site / 变更 | 真实探针输出 |
|---|---|---|
| Q5 | `auto.js` 用 `isDeferredNode` 分离热预算；`maxDeferred` breaker | `auto-wip-selftest` 8/8：deferred 不占 maxNodes；独立配额 pause 且 `autoState.pauseReason` 持久化 |
| Q12 | `intent.detectIntentConflicts`；`getState.intents` 带 writer/claims/conflicts；`/intents` 带 boundary | `claims-selftest` 同目标冲突；`surface-bounds-selftest` `/state` 与 `/intents` 契约 |
| Q14 | `claims.js` 7 谓词、5 级不可逆、`citationErrorRate` | `claims-selftest` 全通过（含 appeal/gate/citation tier） |
| C5 | `semanticFallback` + `INTENT_ACTIONS`；intent 记录携带 executor/route | `claims-selftest` 未知动作 → `human_review`/`human:operator_decision`，不可逆动作 → `human:claim_gate` |
| 5.3.2 | `reserved-slots` 现有项目内 p0 抢占 | `reserved-slots-selftest` 11/11 |
| O1/A11 | `metrics.js` role/cycle p50/p90/p99 + failRate | `observability-selftest` 10/10；`surface-bounds-selftest` `/metrics` byRole 契约 |
| O2 | advisor payload p50/p90 bytes/tokens + token guard | `context-selftest` 13/13；100-node payload <12 KB（2 KB 余量） |
| O3 | dispatch queueWait/decisions 有界 ring | `observability-selftest` queue-wait p50/p99 与 ring 上限 |
| O4/O5 | `runnableSummary` 统一 queue/counts | `observability-selftest` + `surface-bounds-selftest`；queue runnable/claimed/held/deferred |
| A21 | `/metrics` queue/dispatch/byRole 契约 | `surface-bounds-selftest` |
| S5 | `getReplay` 走 `pageEvents`，无 spread | `replay-scale-selftest`：10,500 events/nodes，100 行页 **29,735 B / 11.5 ms**，<1 MB/<2000 ms |
| B13/5.3.9 | `host/experts/triggers.js` 六码；observer snapshot 返回 `triggers` | `experts-selftest` 六码全部命中且有 detail |
| B18 | `structuredVariant`/`dedupeSignature`/`variantConflict` | `experts-selftest`：同 hypothesis 不同 variant 不被召回为重复 |
| C1 | `node.archive` + `deferredTtlDays` + 调度 tick 扫描；`maxDeferred` 排除 archived | `priority-selftest` 归档旧 deferred 且保留节点；`auto-wip-selftest` 配额 |
| C6 | 7 谓词逐项探针 | `claims-selftest`：7/7（100% ≥ 90% floor） |
| Q4 | `expertLifecycleOf` + `budgetUsage` + drain/handover | `stage5-selftest`：identity/status/metrics/budget 同一行；drain/orphan 既有探针 |
| Q9 | `dag_map`/`dag_walk`/`dag_diff` 生产 dispatch | `tool-surface-selftest` 分组/遍历/diff/字节预算 |
| Q10/Q11 | deterministic recall + curator 只提名；false-close breaker | `experts-selftest` 与 `stage5-selftest` |
| Q13 | 8 类争议、prediction error、rotation、timeout default | `stage5-selftest` |
| 5.3.4 | `usageBySourceOf` GPU-seconds 账本 | `priority-selftest` human/advisor 权重与 GPU-seconds |
| 5.3.5 | `inviteExpert` + temporary/expiresAt；过期不可招募 | `stage5-selftest` 三探针 |
| 5.3.7 | `autoJoinCompleted` 在调度 tick 自动建 merge，去重 | `stage5-selftest` 两探针 |
| 5.3.8 | `advisorTimeoutMs` 默认 240s（高于实测 180s p90），30..1800 | `stage5-selftest` 默认/下限/上限 |
| 5.3.11 | curator intent TTL / `intent/expired` | `experts-selftest` |
| 5.3.12 | `scheduling.rotationDays` 默认 14、1..365 | `stage5-selftest` |
| O6 | `auto.js` 将 autoState 随事件持久化；重启读回 | `auto-wip-selftest` 写入与读回 streak/lastPause/pauseCounts |
| O12 | dashboard `gpu`/`cost`/`narrative` 结构化 facts | `dashboard-selftest` |
| 5.4.2 | `retentionPlan` + `retention.*` 配置；hot/cold/prune 只读计划 | `stage5-selftest`：hot/cold/prune 三类与 `destructive:false` |
| 5.4.6 | `K-DEFECT-TRIAGE.md` 18 个 K 编号逐项 disposition | 文档 triage：fixed/tracked/accepted 逐项，open 项不冒充已修 |

### 47.3 关闭边界

`5.4.2` 的验收对象是“运维策略/冷存计划”，已由 `retentionPlan` 和 `retention.*` 配置完成；它是只读计划，**没有**自动删除会话。`5.4.6` 的验收对象是“逐项 triage”，已由 `K-DEFECT-TRIAGE.md` 完成；K3/K4/K8/K17/K18 等 open 项仍明确标为 tracked，不能被写成已修。发布说明必须继续列出这些 open K 项。

### 47.4 回归（HEAD `f704031`）

| 检查 | 结果 |
|---|---|
| `npm test` | EXIT 0；**927 ok / 0 FAIL** |
| `bench:scale` | 11/11 |
| `client-smoke` | 45/45 |
| `operator-ui-selftest` | 全通过 |
| `operator-route-selftest` | 48 route pairs 全通过 |
| `dispute-route-selftest` | 全通过 |
| `plugin-smoke` | 5/5 |
| `b27-restart-selftest` | 全通过 |
| `strict-writes-selftest` | 全通过 |

### 47.5 边界

- 没有真实 Host process restart、真实 provider/browser 测量或 `~/.dsh/storages/*` 写入。
- B22 的 PASS 仍来自 §46.7 独立重放，不是本节作者探针。
- `5.3.7` 的自动 join 仍以 `finish_merge` 为冲突兜底；本轮只证明“父节点全完成时自动创建 merge、去重、限一批”，没有宣称自动解决 git 冲突。
