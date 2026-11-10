# 异步重构进度

> 计划见 [`docs/07-async-refactor-plan.md`](../07-async-refactor-plan.md)，设计条目见
> [`DESIGN-CHECKLIST.md`](DESIGN-CHECKLIST.md)，逐条落地映射见
> [`IMPLEMENTATION.md`](IMPLEMENTATION.md)。
> 本表是**本分支**的进度事实源：状态只有 todo / doing / done / blocked 四种。
> `refactor/async-foundation` 上的 P0–P3 spike 记录见文末「历史（地基分支）」。

## 分支

| 分支 | 内容 |
|---|---|
| `refactor/v2` | 基于 `refactor/async-foundation` 的彻底重构：读路径索引、确定性调度、能力表、可观测性、规模与 UI 预算 |

## 提交

| 提交 | 内容 |
|---|---|
| `dd5ca19` | P2.1(B8) 单一 `runnable` 谓词；`deferred` 是 planned 但永不可运行 |
| `8be444c` | P2.2(B3,G5) `dispatchOnce` 确定性快路，500 节点 <100 ms |
| `0170092` | P2.3(Q7) 低水位触发 + debounce + 容量等待原因 |
| `d8565d6` | P2.4(Q9) review claim：同一父节点的提案并发互斥 |
| `a03b72f` | P1.4-Q6(B25) 12 KB advisor 上下文、假设账本、`dag_query`/`dag_get`、探索预算 |
| `76300ce` | P5.1(A1,A2,B1,B2) Host 计算的状态事实、metrics 收集器、`explain_node`/`trace_explain`、cause 指针 |
| `cc792d9` | P2.5(B1,B8,G6) 把 `dispatchOnce` 接进 auto tick 与终止回调；preset 能力表在 handler 层生效；注册 dag 工具；O(1) 读 + `changes_since` |
| `f7036d4` | P6.1(A3,A5,S1–S10) 5k 读预算、`state` 瘦身 + 单节点全量、`changes_since`、优先级干预 UI、Host facts 卡片 |
| `cd18309` | P6.2(S8,S9) 视口窗口化 DAG、分页 rail、增量 `changes_since` 合并、UI 预算测试 |
| `68ddffc` | P5.2(G1) `kernel.strictWrites` 守卫（ALS 写许可）、health 暴露计数、throw 模式测试 |

## 状态

| WP | 状态 | 提交 | 偏差 / 说明 |
|---|---|---|---|
| P1.1 Priority 元组 | done | `a1f00d6` | 纯函数 + `fairOrder`；`fairOrder` 在 5k 节点改为 O(n×limit) 选择，去掉每次 splice |
| P1.2 journal / 冷段归档 | doing | `a1f00d6` | 事件只追加不删；冷段归档（checksum + 只读段）**未完成**，见 IMPLEMENTATION.md |
| P1.3 Executor | done | `a1f00d6` | 幂等表进程内 Map；cause 指针随 mutation 写入（`node.causeId`/`lastCauseId`） |
| P1.4 Projection | done | `a1f00d6` | 启动 `load()` + `store.subscribeNodes` 兜底同步 legacy 写者 |
| P1.5 EventBus | done | `a1f00d6` | 已接 executor 与投影 |
| P1.6 Trace | done | `76300ce` | `explain_node` / `trace_explain`（阶段 proposal→approval→dispatch→start→outcome+ledger/review） |
| P1.7 迁移写者 | doing | — | 64 处 legacy 直接写仍在；`kernel.strictWrites=warn` 计数暴露，未逐个改造 |
| P1.8 读路径走 Projection | done | `cc792d9` | `state`/`status`/`metrics`/`dispatch` 全走 store 索引投影；剩余 O(N) 扫描已列在 IMPLEMENTATION.md |
| P1.9 增量 getState | done | `cc792d9` | `changes_since` 服务端 journal + 客户端增量合并（`cd18309`） |
| P1.10 Domain v2 | done | 见文末 | 离线迁移工具 `scripts/migrate-domain.mjs`（plan/run/verify/enrich）+ 11 条自测；插件只认 v2 |
| P2.1 Command 模型 | done | `8be444c` | `dispatchOnce` 只用 `node.claim` 作为提交点，无 `starting` 状态 |
| P2.2 Policy 能力表 | done | `cc792d9` | handler 层 `forbidden_action`；schema enum 仍全局（见 OPEN-QUESTIONS.md） |
| P2.3 低水位 | done | `0170092` | 5 min 剩余 / 60 s debounce / 30 s minGap |
| P3.6 接入 Dispatcher | done | `cc792d9` | `index.js` 构造 kernel/broker 映射；auto tick 与 `onTerminated` 都调 |
| P3 dag_map/walk/diff | todo | — | 模块与导出已存在（`dag.js`），`agentTool` 分支未接；下一提交优先 |
| P3 意图日志 | todo | — | 设计见 DESIGN-CHECKLIST B21；模块草稿已删除，未提交（无调用方） |
| P4.x 专家运行时 | todo | — | descriptors/similarity 草稿已删除，未提交（无调用方） |
| P5–P7 curator / 争议 / 竞争 | todo | — | 建议在 P3 指标可见后再做 |
| A 可用性 | done | `76300ce` `f7036d4` | `explain_node`、Host facts 卡片（loading/empty/error）、优先级干预、可操作错误码 |
| B 可观测性 | done | `76300ce` | cycle 延迟、advisor 输入字节/占比、dispatch p95、队列深度、角色失败率、stall |
| S 规模与卡顿 | done | `f7036d4` `cd18309` | 5k 基准与 UI 预算见 IMPLEMENTATION.md「规模与卡顿」；浏览器帧率标记为未测量 |
| G1 单一写者 | doing | `68ddffc` | 守卫与许可已上线；legacy 写点迁移未完成 |
| G2 事件永不删除 | done | `a1f00d6` | `deleteEventRecord` 仅用于 recover 丢弃未确认尾部 |

## 未完成项（进入下一轮）

1. **P3 dag_map/dag_walk/dag_diff 接线**：三个函数已在 `host/context/dag.js` 并有单测，但
   `service.agentTool` 没有对应分支，模型调用会得到 `unknown_command`。这是审计点名的
   "模块落地但无调用方"，必须与测试一起提交。
2. **P3 意图日志**：草稿（TTL、basis 过期、幂等合并、父节点 sealed 拒绝）已在工作区验证过，
   但因没有生产调用方被删除；重做时按 `OPEN-QUESTIONS.md` 的裁决接进 `node.create`。
3. **P4 专家注册表 / 相似度 / curator**：同上，草稿已删除；`experts_list`/`curator_*` 仍在工具
   枚举里但 service 不实现，应隐藏或补齐。
4. **P1.2 冷段归档**：事件永不删除的目标已达成，"归档到只读段 + checksum"未做。
5. **P1.7 legacy 写点迁移**：64 处，`strictWrites=warn` 下可见；逐个迁到 executor 是下一阶段。

## 历史（地基分支 `refactor/async-foundation`）

| WP | 状态 | 提交 | 说明 |
|---|---|---|---|
| P0.1 cluster `acquire` 500 | done | `a1f00d6` | 专家补丁原样落地（`entry` → `request`） |
| P0.4–P0.6 派发包络 spike | done | `a1f00d6` | 纯函数 + 单测（`envelope.js` 7/7），未接运行路径 |
| P0.7 集群预取 spike | done | `a1f00d6` | `brokers.js` 适配器 + 测试 |
| P0.8 coordinator 签名 spike | done | `a1f00d6` | `gang-planner.js` 只做纯规划 |
| P0.5(K7) 提案宽度 | done | `fc81e2b` | 实测分支因子 1.43、并发 2.83/8 的直接原因 |
| P0.5(K15) `lab_cleanup` | done | `ae452ef` | 只删除不存在的工具引用 |
| P0.9 会话保留 | todo | — | D6 每次激活一个会话；DSH 无文件级 GC，需按天/字节归档 |
| P0.2 / P0.3 模拟器 | todo | — | 仅有 `sim/gang-starvation.mjs` |

## 2026-11-10 割接与首批线上数据

- 10:04:28 Host 重启完成，v2 域上线，项目 `prj-ea31447a` 在，254 节点、rev 737，启动日志无插件错误。
- 10:49:58 恢复 auto。**新代码下的第一个 cycle**（`cyc-2c0b08b1`）：

  | 指标 | 割接前 | 割接后第一个 cycle |
  |---|---|---|
  | created | 0–1 | **2** |
  | started | 1（`cyc-d98baca1` 只起 n-0215） | **10**（n-0216…n-0225、n-0241） |
  | planned 剩余 | 39 | 31 |

  这是第一次把机器填满。此前"一次只长一个节点"的判断得到现场确认。
- K16：`snapshot.js` 的 `reportSummary()` 是死代码（无调用方），删除。截断实际发生在
  建节点卡的两个内联 `truncate` 处。
- 观察：`maxRunningNodes=10` 是项目**有意**配置的，scheduler prompt 明确写了
  "GPU pool 24 单元、故意超订、节点数才是上限"。不要再按物理卡数去压它。

## 与计划的偏差（累计）

1. **P1.10 改为离线工具，插件零兼容**（S4）：新建 `metainfer_research_lab_v2`，一次性离线转换
   （`scripts/migrate-domain.mjs`），顺便把旧事件规范化；回滚就是从未被写过的 v1 目录。
2. **新增 P0.9**（S3）：D6 每次激活一个会话，而 DSH 没有会话文件 GC，5,000 节点规模下是磁盘泄漏。
3. **K7 提前**：不先解决它，P3.6 接进去也只是让每轮只产出一个节点的流水线变快。
4. **K15 只做一半**：只删掉 persona 里对不存在工具的指令，角色重设计留在 P4.7。
5. **`dispatchOnce` 预算不含实验 bootstrap**：<100 ms 指确定性选择 + lease + kernel claim +
   launcher 调用；`runtime.start` 的真实实验启动不计入。
6. **`kernel.strictWrites` 生产默认 `warn`**：不阻断线上 Host，但计数进 `health.writes`；
   测试用 `throw` 证明 executor 许可覆盖全部 kernel 写。
