# 174 行验收账本（作者侧，round 17）

> 本文件是**账本**，不是新的独立复核。独立验证者的 §40 仍以 `VERIFICATION.md` 为准；这里只做逐行对齐，确保每个 ID 恰好一个状态，且 residual 可加总。

## 汇总

| 状态 | 数量 |
|---|---:|
| PASS | **119** |
| FAIL | **45** |
| N/A（未测量/不适用） | **10** |
| 合计 | **174** |

推导：§40 的 **116 / 48 / 10** 起点；`5.2`（争议表 + 8 类映射 + 超时默认）、`5.3`（B23 已独立 PASS）和 `5.3.3`（§38 已 PASS）各自拿回独立 verdict，于是 PASS +3、FAIL −3，得到 **119 / 45 / 10**。`Q3` 已是 PASS，只从“剩余必须”表中移除，不改变计数。**注意**：5.3.3 不是本轮新关闭的能力，它的 +1 只是把 §40 的计数口径纠正；若 §40 的 116 已包含它，这个 +1 会成为重复计数，账本必须明确该基线。

## 45 个 residual 的范围

| 范围 | 行数 |
|---|---:|
| 必须 | **15** |
| 应该 | **20** |
| 明确不做 | **10** |
| 合计 | **45** |

`必须` = 原有 12（Q3 PASS 后移除）+ B22（安全）+ U2（队列截断/why）+ 5.3.2（项目内抢占）。`应该` = 原 19 + C1。`明确不做` = 原 11 − C1。C1 不再引用不存在的 `maxDeferred`。

## 逐行账本

| ID | 状态 | 范围 | 依据 / 原因 |
|---|---|---|---|
| B1 | PASS | — | §14 |
| B2 | PASS | — | §17 |
| B3 | PASS | — | §1 baseline PASS |
| B4 | PASS | — | §1 baseline PASS |
| B5 | PASS | — | §18 |
| B6 | PASS | — | §1 baseline PASS |
| B7 | PASS | — | §14 |
| B8 | PASS | — | §1 baseline PASS |
| B9 | PASS | — | §24/§25 |
| B10 | PASS | — | §1 baseline PASS |
| B11 | FAIL | 明确不做 | D7 已选作用域分区，不建 branch/lead/chief 三级。 |
| B12 | FAIL | 明确不做 | D7 无固定层级，不设单点 chief。 |
| B13 | FAIL | 应该 | 6 个确定性触发码仍未落为代码判定。 |
| B14 | FAIL | 明确不做 | chief 审批闸门不成立；dispute/arbiter 取代否决窗口。 |
| B15 | PASS | — | §17 |
| B16 | FAIL | 明确不做 | D6 明确不做驻留会话与 submit 工具。 |
| B17 | PASS | — | §18 |
| B18 | FAIL | 应该 | 节点 tags / hypothesis / variant 判重尚未实现。 |
| B19 | PASS | — | §17 |
| B20 | PASS | — | §18 |
| B21 | PASS | — | §18 |
| B22 | FAIL | 必须 | authority matrix 已独立通过；round 18 补 Host 签名 operator token、真实 HTTP/actor 路径，无 token 时隐藏按钮；端到端 jsdom 已过，独立重放仍待。 |
| B23 | PASS | — | §38 |
| B24 | PASS | — | §24/§25 |
| B25 | PASS | — | §1 baseline PASS |
| B26 | PASS | — | §14 |
| B27 | PASS | — | §26 |
| Q1 | PASS | — | §24/§25 |
| Q2 | PASS | — | §24/§25 |
| Q3 | PASS | — | §36：已 PASS，不再列为剩余必须 |
| Q4 | FAIL | 应该 | 专家身份/状态/预算/绩效完整化未做。 |
| Q5 | FAIL | 必须 | deferred 仍可能占 maxNodes/被 auto 误判，正确性缺陷。 |
| Q6 | PASS | — | §1 baseline PASS |
| Q7 | PASS | — | §1 baseline PASS |
| Q8 | FAIL | 明确不做 | D7 取消固定三级评审。 |
| Q9 | FAIL | 应该 | dag_map/walk/diff 已有，但完整上下文切片价值未验收。 |
| Q10 | FAIL | 应该 | 重复 claim 的候选对/召回未完成。 |
| Q11 | FAIL | 应该 | 专职 curator 的语义清理未启用。 |
| Q12 | FAIL | 必须 | Host 单写 DAG / intent 边界仍是硬承诺，未全闭。 |
| Q13 | FAIL | 应该 | 争议程序扩展仍依赖 B22 的 authority 闭包。 |
| Q14 | FAIL | 必须 | claim 原子性/确定性验证/截断显式化仍有缺口。 |
| 1.1 | PASS | — | §14 |
| 1.2 | PASS | — | §1 baseline PASS |
| 1.3 | PASS | — | §38 |
| 1.4 | PASS | — | §1 baseline PASS |
| 2.1 | PASS | — | §1 baseline PASS |
| 2.2 | PASS | — | §1 baseline PASS |
| 2.3 | PASS | — | §1 baseline PASS |
| 2.4 | PASS | — | §1 baseline PASS |
| 3.1 | PASS | — | §14 |
| 3.2 | PASS | — | §18 |
| 3.3 | PASS | — | §14 |
| 3.4 | PASS | — | §17 |
| 4.1 | PASS | — | §17 |
| 4.2 | PASS | — | §17 |
| 4.3 | PASS | — | §17 |
| 4.4 | PASS | — | §18 |
| 4.5 | PASS | — | §18 |
| 5.1 | PASS | — | §24/§25 |
| 5.2 | PASS | — | §40 ledger correction：独立 verdict，不再并入 B22/B23 |
| 5.3 | PASS | — | §40 ledger correction：独立 verdict，不再并入 B22/B23 |
| 5.4 | FAIL | 明确不做 | D7 已取消分层评审，明确不做。 |
| C1 | FAIL | 应该 | 未建：host/ 无 maxDeferred, 无 deferred archive；从明确不做改回应该，不再引用不存在的替代机制。 |
| C2 | FAIL | 明确不做 | 以单一 chief 为前提，v2 不设 chief。 |
| C3 | N/A | — | 真实浏览器绘制/时区 N/A；未测量。 |
| C4 | N/A | — | 真实 provider/LLM 端到端 N/A。 |
| C5 | FAIL | 必须 | 语义动作若无代码/专家出口会形成升级死角，fallback 未闭。 |
| C6 | FAIL | 应该 | 90% 谓词覆盖无实测，不能写成承诺。 |
| C7 | PASS | — | §23 |
| C8 | FAIL | 明确不做 | 建子节点即投票的计权治理不属于 v2。 |
| C9 | N/A | — | 自然人和双人审批 N/A。 |
| C10 | N/A | — | 真实 Host restart/provider 组合 N/A。 |
| C11 | N/A | — | 真实浏览器交互/截图 N/A。 |
| C12 | PASS | — | §24/§25 |
| C13 | PASS | — | §24/§25 |
| C14 | FAIL | 明确不做 | 接受一次性停机割接；迁移不是自动的。 |
| 5.1.1 | N/A | — | B16/D6 方向待 owner 裁决。 |
| 5.1.2 | PASS | — | §24/§25 |
| 5.1.3 | N/A | — | B11/D7 方向待 owner 裁决。 |
| 5.1.4 | PASS | — | §1 baseline PASS |
| 5.1.5 | N/A | — | defer 提名不存在，0/1 证据无落点。 |
| 5.1.6 | PASS | — | §1 baseline PASS |
| 5.2.1 | PASS | — | §1 baseline PASS |
| 5.2.2 | PASS | — | §26 |
| 5.2.3 | PASS | — | §26 |
| 5.2.4 | PASS | — | §24/§25 |
| 5.2.5 | PASS | — | §26 |
| 5.3.1 | PASS | — | §23 |
| 5.3.2 | FAIL | 必须 | 项目内 p0 抢占仍未建（Q3 已 PASS，本行独立 FAIL）。 |
| 5.3.3 | PASS | — | §38 已 PASS；§41.7 复跑 11/11。+1 只是 §40 计数口径修正，不是新关闭能力。 |
| 5.3.4 | FAIL | 应该 | usageBySource 未接真实 GPU-seconds 账本，公平份额仅部分。 |
| 5.3.5 | FAIL | 应该 | 临时邀请专家未建。 |
| 5.3.6 | PASS | — | §24/§25 |
| 5.3.7 | FAIL | 应该 | 父节点全完成自动 join 未建；手工 finish_merge 仍是兜底。 |
| 5.3.8 | FAIL | 应该 | advisor 180s 超时未调，缺真实 p90 分布。 |
| 5.3.9 | FAIL | 应该 | 六条触发规则未完整落地。 |
| 5.3.10 | FAIL | 明确不做 | 与 D7 三级评审冲突，明确不做。 |
| 5.3.11 | FAIL | 应该 | curator 产物 TTL 未建。 |
| 5.3.12 | FAIL | 应该 | 轮换阈值 N 的策略值未定（机制已有）。 |
| 5.3.13 | PASS | — | §40 |
| 5.3.14 | PASS | — | §38 |
| 5.3.15 | PASS | — | §1 baseline PASS |
| 5.3.16 | PASS | — | §26 |
| 5.4.1 | PASS | — | §1 baseline PASS |
| 5.4.2 | FAIL | 应该 | 会话保留/冷存归档是运维策略，未建。 |
| 5.4.3 | PASS | — | §24/§25 |
| 5.4.4 | PASS | — | §24/§25 |
| 5.4.5 | PASS | — | §21 |
| 5.4.6 | FAIL | 应该 | K 缺陷表尚未逐项 triage。 |
| 5.4.7 | PASS | — | §24/§25 |
| 5.4.8 | PASS | — | §1 baseline PASS |
| 5.4.9 | PASS | — | §1 baseline PASS |
| 5.4.10 | PASS | — | §1 baseline PASS |
| U1 | PASS | — | §38 |
| U2 | FAIL | 必须 | 均匀夹具通过；混合优先级 150 行独立探针曾仅 67/100 行有 why、无 #100；round 18 改为单一 queueRows 顺序，作者夹具 100/100 通过，独立重放待。 |
| U3 | PASS | — | §38 |
| U4 | PASS | — | §14 |
| U5 | PASS | — | §1 baseline PASS |
| U6 | PASS | — | §1 baseline PASS |
| U7 | PASS | — | §1 baseline PASS |
| U8 | PASS | — | §1 baseline PASS |
| U9 | PASS | — | §14 |
| U10 | PASS | — | §24/§25 |
| U11 | PASS | — | §14 |
| U12 | PASS | — | §40 |
| U13 | PASS | — | §21 |
| U14 | PASS | — | §24/§25 |
| O1 | FAIL | 必须 | cycle p50/p90/max by role 未完整可读。 |
| O2 | FAIL | 必须 | advisor 输入字节/token 预算护栏未完整。 |
| O3 | FAIL | 必须 | dispatch runnable→claimed p50/p99 未完整。 |
| O4 | FAIL | 必须 | queue runnable/deferred/claimed/held 未统一进 state/metrics。 |
| O5 | FAIL | 必须 | 按 status 计数仍未全部使用 runnableQueue 口径。 |
| O6 | FAIL | 应该 | idle/error streak 与 lastPause 持久化未完整。 |
| O7 | PASS | — | §1 baseline PASS |
| O8 | PASS | — | §17 |
| O9 | PASS | — | §24/§25 |
| O10 | PASS | — | §1 baseline PASS |
| O11 | PASS | — | §1 baseline PASS |
| O12 | FAIL | 应该 | GPU/成本/叙事结构化 dashboard 未完成。 |
| A1 | PASS | — | §1 baseline PASS |
| A2 | PASS | — | §1 baseline PASS |
| A3 | PASS | — | §1 baseline PASS |
| A4 | PASS | — | §1 baseline PASS |
| A5 | PASS | — | §1 baseline PASS |
| A6 | PASS | — | §1 baseline PASS |
| A7 | PASS | — | §1 baseline PASS |
| A8 | PASS | — | §1 baseline PASS |
| A9 | PASS | — | §1 baseline PASS |
| A10 | PASS | — | §1 baseline PASS |
| A11 | FAIL | 必须 | 失败率/延迟 p50/p90 未完整。 |
| A12 | PASS | — | §14 |
| A13 | PASS | — | §14 |
| A14 | PASS | — | §1 baseline PASS |
| A15 | PASS | — | §14 |
| A16 | PASS | — | §16 |
| A17 | PASS | — | §1 baseline PASS |
| A18 | PASS | — | §14 |
| A19 | PASS | — | §1 baseline PASS |
| A20 | PASS | — | §24/§25 |
| A21 | FAIL | 必须 | /metrics queue/dispatch/byRole 契约未完整。 |
| S1 | PASS | — | §1 baseline PASS |
| S2 | PASS | — | §1 baseline PASS |
| S3 | PASS | — | §1 baseline PASS |
| S4 | PASS | — | §1 baseline PASS |
| S5 | FAIL | 必须 | replay 分页/窗口化的 10k/1MB 验收仍有缺口。 |
| S6 | PASS | — | §1 baseline PASS |
| S7 | PASS | — | §1 baseline PASS |
| S8 | N/A | — | 浏览器绘制 N/A。 |
| S9 | N/A | — | 浏览器 FPS/绘制 N/A。 |
| S10 | PASS | — | §1 baseline PASS |
| S11 | PASS | — | §17 |
| S12 | PASS | — | §24/§25 |
| S13 | PASS | — | §24/§25 |
| S14 | PASS | — | §1 baseline PASS |

## 一致性检查

- 174 个 ID 全部出现一次；无重复、无合并行。
- PASS 119 + FAIL 45 + N/A 10 = 174。
- FAIL 45 = 必须 15 + 应该 20 + 明确不做 10。
- `B22`、`U2` 仍是独立 FAIL；`5.2`、`5.3`、`5.3.3`、`Q3` 是独立 PASS，不是“由 B22/B23 覆盖”。
