# DAG 变更日志（WAL）

## 1. 为什么需要

图变大之后，"上次观察到现在变了什么"变成了刚需：

- 调度器只想知道**新增/可派发**的节点，不必每次全图扫描；
- dashboard 只想刷新**变化的节点**，而不是 1000 个；
- agent 想用游标推进：记住上次看到的位置，下次只取增量。

原有两条设施都不够：

| 设施 | 问题 |
|---|---|
| `changes_since`（内存环形缓冲，上限 5000） | 重启即失；超过 5000 条返回 `full`；只给每个节点的**最终快照**，没有历史 |
| `events`（append-only 事件流） | 面向运行/决策事件，不是节点状态变更；没有"节点维度 + 区间 + 游标"的查询面 |

所以新增一个**专门的节点变更 WAL**。

## 2. 存储：SQLite（WAL 模式）

文件：`<DSH_HOME>/metainfer-research-lab/wal.sqlite`

选它的理由：

- 运行时自带 `node:sqlite`（Node 22），**零新依赖**；
- `PRAGMA journal_mode = WAL` 是真正的预写日志：崩溃不撕裂、读不阻塞写；
- 区间/游标/按节点查询都有索引，不需要把整表读进内存；
- 持久化——这是 `changes_since` 做不到的。

```sql
CREATE TABLE wal (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT, -- 严格递增、永不复用
  project_id TEXT    NOT NULL,
  node_id    TEXT,
  kind       TEXT    NOT NULL,
  at         INTEGER NOT NULL,                  -- 毫秒时间戳
  actor      TEXT,
  revision   INTEGER,                           -- 写入时的项目 revision
  payload    TEXT                               -- JSON：变更前后/快照
);
CREATE INDEX wal_project_seq  ON wal(project_id, seq);
CREATE INDEX wal_project_node ON wal(project_id, node_id, seq);
CREATE TABLE wal_meta (key TEXT PRIMARY KEY, value TEXT);  -- 回填标记
```

`seq` 是 `AUTOINCREMENT`，所以**删行也不会复用**，可以安全地当作游标。

## 3. 记录哪些事件

每次 `store.saveNode` / `deleteNode` 追加一条，kind 由 `describeNodeChange()` 统一判定：

| kind | 触发 |
|---|---|
| `node.created` | 新节点写入 |
| `node.status` | status 变化（planned → running → completed …） |
| `node.priority` | `priority.class` 变化 |
| `node.title` | 标题变化 |
| `node.updated` | 其它字段变化（prompt、needs、report…） |
| `node.removed` | 节点删除 |
| `node.snapshot` | 回填：日志启用前就存在的节点，一次性补一条快照 |

payload 形如：

```json
// node.status
{ "changed": ["status", "rev"],
  "before": { "status": "planned", "rev": 0, "priority": "p2", "title": "…" },
  "after":  { "status": "running", "rev": 1, "priority": "p2", "title": "…" } }
```

写入失败**不会阻塞**节点写入：捕获后 `console.warn`（日志是审计与增量读取的加速器，不是状态本身）。

## 4. 查询语义

```
fromSeq  —— 排他下界：只返回 seq > fromSeq（"我处理到 42 了，给我之后的"）
toSeq    —— 包含上界
cursor   —— 上一页的 nextCursor（编码为 "w<seq>"，保持不透明以便将来换编码）
limit    —— 1..1000，默认 100
kinds    —— 逗号分隔或数组
nodeId   —— 只看某个节点的历史
order    —— asc（默认）/ desc
```

返回：

```json
{ "projectId": "prj-…", "entries": [ … ], "count": 100,
  "hasMore": true, "nextCursor": "w4231",
  "latestSeq": 4300, "fromSeq": 4100, "toSeq": null }
```

典型用法（调度器）：

```
latest = GET /wal?projectId=P&limit=1&order=desc   → latestSeq 4300（或用 wal_latest）
消费   = GET /wal?projectId=P&fromSeq=<自己的游标>&limit=200
推进   = 游标 = 最后一条 seq；hasMore 为真就继续翻页
```

首读（`fromSeq=0`）对老项目会触发一次**回填**：把现有节点各写一条 `node.snapshot`，
之后不再重复（`wal_meta` 记标记）。

## 5. 接口

### HTTP（只读，read-only 策略）

```
GET /api/metainfer-research-lab/wal?projectId=…&fromSeq=…&toSeq=…&nodeId=…&kinds=…&limit=…&cursor=…&order=asc
```

### Agent 工具 `metainfer_lab`

| action | 用途 |
|---|---|
| `wal_query` | 主页：`{projectId, fromSeq, toSeq, nodeId, kinds, limit, cursor, order}` |
| `wal_latest` | 光标助手：`{projectId}` → `{seq, count}`（先拿最新位点，再决定要不要读增量） |

两者都是 `read` 权限，worker/lead/advisor 都可调用。

## 6. 与其它机制的关系

- **不替代 `events`**：event 流记录"发生了什么决策/运行"，WAL 记录"节点状态怎么变"。
- **不替代 store**：日志可以回放出变更序列，但权威状态仍是 nodes 表；删掉日志只会丢失增量能力，不会损坏 DAG。
- **保留策略**：目前永久保留（append-only）。单个节点写一次约 200–400 字节，936 节点的项目全量快照 < 0.5 MB，正常实验规模下无需裁剪；将来若需要可按 `at` 归档（结构已按 append-only 设计）。

## 7. 测试

`scripts/wal-selftest.mjs`（18 项）覆盖：

- seq 严格递增、分页游标不重不漏、区间 `(from, to]`；
- 按节点/按 kind 过滤；
- 关库重开后数据仍在、seq 继续增长；
- store 写入产生正确的 kind 序列与 before/after；
- 老项目一次性回填且不重复；
- HTTP `GET /wal` 的分页、区间、过滤。
