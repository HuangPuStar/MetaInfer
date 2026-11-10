# Spike 结论（本机实测，2026-11-10）

计划里 P0.4–P0.8 的五个 spike 需要在真实 DSH Host 上验证。这里记录已经做掉的三个，
以及它们对计划的**修正**。结论先行：S4 的结论变了两次——技术上能原地升级，但项目决定
不做兼容层，改成离线迁移工具，于是 P1.10 从"迁移 + 兼容读取"变成"一个工具 + 一次运行"。

验证方式：读 `/usr/local/lib/node_modules/@deepseek-ai/dsh/` 下的实现，
配合本仓库 `host/store.js` 的实际声明。

---

## S1 · `storageDomain` 的 put/get 语义

**问**：`put` 是否同步落盘？多次 put 是否保证顺序？`get` 返回引用还是副本？

**答**（`dsh-storage-domain/lib/index.js`，`KvTableImpl`）：

| 问题 | 实际 |
|---|---|
| put 是否同步落盘 | 否。`put` 返回 `host.enqueue(async () => unit.putRecord(...))`，是**每条记录一次异步写**，通过**单个 per-domain 写链**串行化 |
| 多次 put 的顺序 | 保证调用顺序（同一个 enqueue 链），但每条之间不原子 |
| get 返回引用还是副本 | **引用**（`return this.records.get(key)`），改它不会落盘 |
| 有没有多记录事务 | 没有 |

**对本仓库的含义**：

1. Executor 的"先写事件、再写记录、最后写 project"顺序**成立**——每条 `await store.appendEvent(...)` 完成后才写记录，写链保证不交叉。
2. `get` 返回引用 = 计划 §8.1 说的"先改对象、后失败"风险**真实存在**。`createWorkingSet` 已经 `structuredClone`，这条风险已经被地基代码处理掉。
3. 没有多记录事务 → 崩溃窗口必然存在 → `recover()` 是必需的，不能省。

**与计划一致，无需修改。**

---

## S4 · Domain 版本升级（**已被项目决定取代**）

**问**：`DOMAIN_VERSION` 能否从 1 升到 2 而不丢数据？还是要新建 v2 namespace + 搬迁？

**技术事实**：`DomainSpec` 有 `compatibleVersions` 字段，`dsh-storage-json` 放行列出的旧版本
（`lib/index.js:105`）。所以**技术上**可以原地升级。

**但项目决定是不用它**：这次是重构，不为无感升级保留兼容层。理由：

1. `compatibleVersions` 换来的是"**每个读者**永久容忍两种形状"——缺 `actor`/`commit`/`revision`/`priority`
   的记录。兼容成本从一次性迁移变成永久的 if 分支。
2. 它还是**会静默丢数据**：per-record 文档用 `parseRecord(text, [current, ...compatible])` 解析，
   版本不在列表里的记录直接返回 `undefined` 被丢弃，不报错。
3. 数据量根本不值得：254 节点 / 1,702 事件 / 27 MB，离线转换几秒。

**采用的方案**：新建 domain `metainfer_research_lab_v2`，由离线工具
[`scripts/migrate-domain.mjs`](../../scripts/migrate-domain.mjs) 一次性转换。

- 插件只认 v2，**没有一行 v1 兼容代码**；
- 工具顺便把 v1 事件规范化（补 `actor.kind='legacy'`、`commit=null`、`revision=0`、
  `legacy=true`），这样 `recover()` 天然跳过 pre-kernel 历史，运行时不需要判断"事件是新的还是旧的"；
- 回滚就是那块 v1 目录，工具从不写它；
- `store.js` 在 v2 为空而 v1 存在时**直接抛错**并提示跑迁移，避免"项目凭空消失"的静默故障。

**这条修正推翻了原计划的 P1.10**（原方案：`mv` 出域 → 新建 → 复制 → 只读期 → 回滚演练），
也推翻了本文件最初的 S4 结论。工作包从"一整段迁移 + 兼容读取"变成"一个工具 + 一次运行"。

## S3 · DSH 会话文件的保留策略

**问**：DSH 会不会自动删除会话文件？"每次激活一个会话"会不会撑爆磁盘？

**答**：在 `dsh-session*` 包里没有找到会话文件的保留/删除策略（只有会话**内容**
的 `TextRetainer` 截断，没有文件级 GC）。

**实测**：本项目控制者会话压缩后 4.0 MB；82 个节点各至少一个 anchor + worker 会话。
按 D6（每次激活一个会话）在 5,000 节点规模下，单项目预计数百 GB 级。

**结论**：D6 本身没问题（不常驻会话是对的），但**会话文件必须有保留策略**，
否则这是重跑一次就翻倍的磁盘泄漏。这一条计划里没有，需要补一个 WP
（P0.9：会话保留 + 冷存归档，按天数/字节双阈值，删前登记到事件流）。

---

## 对计划的三处修正（汇总）

| # | 计划原样 | 实测结论 | 改动 |
|---|---|---|---|
| 1 | D7：`mv` 出域 + 新建 + 复制 + 只读期（P1.10 一整段） | 项目决定不做兼容层 | **P1.10 改为离线迁移工具**（`scripts/migrate-domain.mjs`），v2 是干净断代，插件零 v1 兼容代码 |
| 2 | D9：recover 必须零截断 + writeGuard | 成立：无多记录事务 | 不变 |
| 3 | 未提会话文件保留 | DSH 无文件级 GC，D6 会放大磁盘占用 | **新增 P0.9 会话保留** |
