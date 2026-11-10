# Spike 结论（本机实测，2026-11-10）

计划里 P0.4–P0.8 的五个 spike 需要在真实 DSH Host 上验证。这里记录已经做掉的三个，
以及它们对计划的**修正**。结论先行：S4 与计划默认相反，可以直接省掉 P1.10 的整段迁移。

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

## S4 · Domain 版本能否原地升级（**修正计划**）

**问**：`DOMAIN_VERSION` 能否从 1 升到 2 而不丢数据？还是要新建 v2 namespace + 搬迁？

**答**：`DomainSpec` 有 `compatibleVersions` 字段（`dsh-storage-domain/lib/types/spec.d.ts`）：

```
compatibleVersions?: readonly number[]
  Older domain versions whose stored records the current record schemas
  also accept ... Ordinary reads admit listed versions without restamping
  saved data; writes stamp the current version.
```

`dsh-storage-json` 的判定（`lib/index.js:105`）：

```js
if (version !== descriptor.version && !descriptor.compatibleVersions?.includes(version))
  throw new StorageError("version-mismatch", ...)
```

per-record 文档则用 `parseRecord(text, [current, ...compatible])`，命中即读。

**我们的实际条件**：`host/store.js` 的每个表都是 `z.any()`（"records are authored
and checked by this plugin"），所以**旧记录永远能通过新 schema 校验**。

**结论**：`DOMAIN_VERSION 1 → 2` + `compatibleVersions: [1]` **可以原地升级**。
不需要新 namespace、不需要导出导入、不需要只读期、不需要双域并存。

**因此 P1.10 从"整段迁移工作包"降级为"改一行版本号 + 跑一次启动验证"。**

### 唯一的风险：升级不可逆

`compatibleVersions` 只保证**新代码读旧数据**。第一次写入会把 unit header
重新盖成 `version: 2`；此后**旧代码（v1）会 version-mismatch 打不开**。

处理方式不是设计迁移，而是**升级前做一次整目录备份**：

```bash
cp -a ~/.dsh/storages/metainfer_research_lab ~/.dsh/storages/metainfer_research_lab.v1-backup
```

成本一条命令，回滚就是删掉目录还原备份。

---

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
| 1 | D7：`mv` 出域 + 新建 + 复制 + 只读期（P1.10 一整段） | `compatibleVersions` 支持原地升级 | **P1.10 降级为一次版本号 + 启动验证**，前置动作只是一次目录备份 |
| 2 | D9：recover 必须零截断 + writeGuard | 成立：无多记录事务 | 不变 |
| 3 | 未提会话文件保留 | DSH 无文件级 GC，D6 会放大磁盘占用 | **新增 P0.9 会话保留** |
