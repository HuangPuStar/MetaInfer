# 独立验收报告 — `refactor/v2`

> 验收人：独立验证者（未参与实现）。对象：`docs/refactor/DESIGN-CHECKLIST.md` §1–§9、
> `docs/refactor/IMPLEMENTATION.md`、`refactor/v2` 代码（HEAD `6beba88`）。
> 日期：2026-11-10。

## 0. 结论摘要

| 判定 | 数量 |
|---|---|
| PASS | **80** |
| FAIL | **84** |
| 未测量 | **10** |
| 合计 | **174** |

**行数更正**：任务说明里写“128 行”，但清单实际是 **174 行**：§1 27、§2 14、§3 21、§4 14、
§5 37、§6 14、§7 12、§8 21、§9 14。本报告逐行覆盖全部 174 行，没有抽样。

**一句话**：第四轮修复（`137b293`…`39748a6`）关闭了 G1 删除守卫、locale 方向、B17/B20/B21、
4.4/4.5 与人类 p0；`npm test` 27 文件 / 427 checks 全绿。仍不能上生产的是冷段归档、dashboard
过期、7 谓词 claim 门控和浏览器绘制/FPS（见 §18）。

> 本文件 §1–§13 保留**第一轮**（`6beba88`）的 174 行原判（50 PASS / 114 FAIL / 10 未测量）；
> **第二轮**（`750fc31`）见 **§14**；第三轮（`d0364c4`）见 **§15**；作者第三轮修复表见 **§16**；
> **第四轮**（`7d97432`）的独立复核见 **§17**；第四轮修复后的复核见 **§18**。总判定以 §18 为准。

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

### 0.2 本次实际执行的命令

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
  置 `withdrawn` 并写 `intent/withdrawn`；测试用真实 executor 建 `child-of-d1` 后检查。
- **B21**：intent 带 `status:'pending'` 与 30 分钟 `expiresAt`；`intent_withdraw` 可撤回；
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

`npm test`：**27 个文件、427 checks，exit 0**（`/tmp/npmtest-r4b.log`）。新增/扩展：
`strict-writes`、`experts`（谓词/免疫/claims/生命周期）、`priority`（人类 p0）、
`dispatch`（p0→claim）、`surface-bounds`（`/experts`）、`ui`（专家库）、`locale`（漂移）。

仍 FAIL：`B27` 7 谓词 claim 校验与 `citationErrorRate`；`P1.2/S12` 冷段归档；`U14` dashboard
静默过期；`U13` dashboard 来源徽标；`O12` 文本审计；浏览器绘制/FPS 未测量；Stage 5 组织化。
