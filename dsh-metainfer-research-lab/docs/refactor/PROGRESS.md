# 异步重构进度

> 计划见 [`docs/07-async-refactor-plan.md`](../07-async-refactor-plan.md)。
> 本表是唯一的进度事实源：**状态只有 todo / doing / done / blocked 四种**，
> 凡与计划不一致的地方必须写进"偏差"列。

## 分支

| 分支 | 内容 |
|---|---|
| `refactor/async-foundation` | 专家地基补丁（P0.1–P3.5）+ 本仓库已有的 title/profile 修复 + K7 + K15 |

## 状态

| WP | 状态 | 提交 | 偏差 / 说明 |
|---|---|---|---|
| P0.1 cluster `acquire` 500 | done | `a1f00d6` | 专家补丁原样落地（`entry` → `request`） |
| P0.4–P0.6 派发包络 spike | done | `a1f00d6` | 以纯函数 + 单测形式落地（`envelope.js` 7/7），未接运行路径 |
| P0.7 集群预取 spike | done | `a1f00d6` | `brokers.js` 适配器 + 测试 |
| P0.8 coordinator 签名 spike | done | `a1f00d6` | `gang-planner.js` 只做纯规划，不改 coordinator 内部 |
| P0.5(K7) 提案宽度 | done | `fc81e2b` | 提前到 P1 之前做：它是当前并发上不去的直接原因（实测分支因子 1.43、并发 2.83/8） |
| P0.5(K15) `lab_cleanup` | done | `ae452ef` | 只做"删掉不存在的工具引用"这一半；P4.7 的 postmortem 专家重设计不动 |
| P0.9 会话保留 | todo | — | **新增**：D6（每次激活一个会话）在 DSH 没有文件级 GC 的前提下会持续占用磁盘，见 `spikes.md` S3 |
| P0.2 Fake DSH | todo | — | 未开工；当前先用手工单测覆盖 |
| P0.3 模拟器 | todo | — | 仅有 `sim/gang-starvation.mjs`（集群侧），域模拟器未做 |
| P1.1 Priority | done | `a1f00d6` | 纯函数，未接 dispatcher |
| P1.2 journal / 冷段 | todo | — | `recover()` 目前一次性加载全部尾部事件 |
| P1.3 Executor | done | `a1f00d6` | 幂等表仍是进程内 Map（P1.3 待补项） |
| P1.4 Projection | done | `a1f00d6` | 未接启动时 `load()` |
| P1.5 EventBus | done | `a1f00d6` | 未接运行路径 |
| P1.6 Trace | doing | `a1f00d6` | label/digest/TraceRef 已有；`activations` 表与 `trace_explain` 未做 |
| P1.7 迁移写者 | todo | — | P1 的主要工作量，未开始 |
| P1.8 读路径走 Projection | todo | — | — |
| P1.9 增量 getState | todo | — | — |
| P1.10 Domain v2 | done | 见下 | **改为离线迁移工具**：`scripts/migrate-domain.mjs`（plan/run/verify/enrich）+ 11 条自测；插件只认 v2，零兼容代码 |
| P2.1 Command 模型 | todo | — | — |
| P2.2 Policy 能力表 | todo | — | issue 0001（全局工具注册）在这里一次性解决 |
| P3.6 接入 Dispatcher | todo | — | 最高价值：把"启动"从 LLM cycle 里拆出来 |
| P4.x 专家运行时 | todo | — | — |
| P5–P7 curator / 争议 / 竞争 | todo | — | 我建议这三阶段在 P3 上线、指标可见之后再决定是否做 |

## Spike 结论

见 [`spikes.md`](spikes.md)。已做 S1 / S3 / S4，其中 **S4 推翻了计划的默认方案**。

## 与计划的偏差（累计）

1. **P1.10 改为离线工具，插件零兼容**（S4，项目决定）：这次是重构，不为无感升级保留兼容层。
   `compatibleVersions` 虽然在技术可用，但它要求每个读者永久容忍两种形状，而且 per-record
   解析对未列版本的记录**静默丢弃**。改为：新建 `metainfer_research_lab_v2`，一次性离线转换
   （`scripts/migrate-domain.mjs`），顺便把旧事件规范化成 v2 形状，回滚就是那块从未被写过的
   v1 目录。`store.js` 在 v2 为空、v1 存在时直接抛错，避免"项目凭空消失"。
2. **新增 P0.9**（S3）：D6 每次激活一个会话，而 DSH 没有会话文件 GC，5,000 节点规模下是磁盘泄漏。
   需要按天/字节双阈值归档，删前登记事件。
3. **K7 提前**（计划排在 P0.5 之后的 P1 阶段内）：不先解决它，P3.6 接进去也只是让一个每轮只产出
   1 个节点的流水线变快，DAG 仍然是单链。
4. **K15 只做一半**：只删掉 persona 里对不存在工具的指令，角色重设计留在 P4.7。
