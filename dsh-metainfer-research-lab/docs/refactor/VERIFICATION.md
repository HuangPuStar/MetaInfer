# 独立验收报告 — `refactor/v2`

> 验收人：独立验证者（未参与实现）。对象：`docs/refactor/DESIGN-CHECKLIST.md` §1–§9、
> `docs/refactor/IMPLEMENTATION.md`、`refactor/v2` 代码（HEAD `6beba88`）。
> 日期：2026-11-10。

## 0. 结论摘要

| 判定 | 数量 |
|---|---|
| PASS | **50** |
| FAIL | **114** |
| 未测量 | **10** |
| 合计 | **174** |

**行数更正**：任务说明里写“128 行”，但清单实际是 **174 行**：§1 27、§2 14、§3 21、§4 14、
§5 37、§6 14、§7 12、§8 21、§9 14。本报告逐行覆盖全部 174 行，没有抽样。

**一句话**：内核的“零件”和规模预算大多真实可用（`npm test` 17 个文件全绿；5,000 节点读预算、
12 KB 快照、`dispatchOnce` 快路径都有会红的测试），但**权限面、工具面、Stage 3–5、可观测性出口**
远没有达到清单要求；其中权限面有一条可复现的越权路径，因此**今天不能上生产**。

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

## 13. 上生产结论

**否。** 权限面存在可复现的越权删除，且工具面/可观测性/Stage 3–5 大量半接线；当前只适合作为
`refactor/v2` 的继续开发分支，不应切生产。
