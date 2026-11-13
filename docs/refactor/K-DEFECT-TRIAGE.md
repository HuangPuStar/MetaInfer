# K 缺陷逐项 triage（5.4.6）

> 5.4.6 不再是一个“整行 gate”。本表给每个 K 编号一个明确 disposition：
> `fixed`、`tracked`（有 issue/owner/范围）或 `accepted`（本重构不做，但有理由）。
> `tracked` 不等于修好；本轮没有把未修的 K 项写成 PASS。

| K | 位置 | 状态 | 处置 |
|---|---|---|---|
| K1 | `cluster.js acquire` 未定义 `entry` | fixed | P0.1 补丁，cluster-selftest 覆盖 |
| K2 | `store.js appendEvent` 删最旧事件 | fixed | P1.2 改为分段冷存，不删事件 |
| K3 | `orchestrator.persistEvent` / `auto.saveEvent` / `gc` 锁外写 | tracked | 单项目内仍可能交错；`executor.commit` 已是唯一写内核，剩余路径迁移到 `withProjectLock`。不阻塞单写 kernel 的 B22/Q12 结论 |
| K4 | `store.listNodes` 全表扫描 | tracked | 29 处调用；`pageNodes`/索引已用于 state/replay，剩余热路径逐处迁移 |
| K5 | `getState` 全量节点 | fixed | `getState` 已分页（1,000 行/2 MB）并带 cursor；`surface-bounds-selftest` 覆盖 |
| K6 | `agent-tool.js` 全局注册 49 action | tracked | issue 0001 仍开；preset allowlist 已收窄，但父会话注册面仍在 |
| K7 | advisor 宽度被压窄 | fixed | P0.5 `fc81e2b` |
| K8 | `runtime.onSessionEvent` 只处理 `turn/end` | tracked | turn 内活动不更新 `lastActivityAt`；O1 `stalled_node` 仍依赖生命周期写点。需要 runtime 事件映射 |
| K9 | `runRole` 复制大 `inputSnapshot` | accepted | 保留快照用于复现；预算护栏在 O2 限制字节，不删除 |
| K10 | `execution-log` 轨迹游离 | tracked | P4.9；不影响本仓库单项目操作面 |
| K11 | `cluster.dispatchQueue` 贪心饿死多机任务 | tracked | P3.5；本仓库默认 local，多机验收不在本轮 |
| K12 | 续约把 `expiresAt` 后推 | tracked | P3.7；coordinator 硬结束时间未落 |
| K13 | `pumpLeases` 2 秒轮询 | tracked | P3.7；推送租约未落 |
| K14 | coordinator 全量 JSON persist | tracked | P3.5.1 |
| K15 | GC preset 提到 `lab_cleanup` | fixed | persona 引用已删（`ae452ef`）；GC 工具面不在本仓库 |
| K16 | `snapshot.reportSummary` 死代码 | fixed | `76c8eed` |
| K17 | `createChild` 写 `createdBy: 'advisor'`，无 lens/专家 | tracked | 专家描述符/绩效已建；orchestrator 创建路径仍需写 expertId/lens |
| K18 | `applySchedulerOutput` 串行 start ≤20 | tracked | P3.6；确定性 dispatcher 已用于 dispatchOnce，legacy scheduler 仍串行 |

## 判定

5.4.6 的验收对象是“逐项 triage”，不是“所有 K 都已修”。本表 18 行全部有 disposition、位置和范围；其中 5 行 fixed、1 行 accepted、11 行 tracked、1 行 fixed（K15）——总计 18。仍 open 的 K 项不得被任何发布说明写成已修。
