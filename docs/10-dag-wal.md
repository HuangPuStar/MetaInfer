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
  seq        INTEGER PRIMARY KEY AUTOINCREMENT, -- 全局行号：严格递增、永不复用
  project_seq INTEGER NOT NULL,                -- 项目内序号：每个项目从 1 开始
  project_id TEXT    NOT NULL,
  node_id    TEXT,
  kind       TEXT    NOT NULL,
  at         INTEGER NOT NULL,                  -- 毫秒时间戳
  actor      TEXT,
  revision   INTEGER,                           -- 写入时的项目 revision
  payload    TEXT                               -- JSON：变更前后/快照
);
CREATE INDEX wal_project_seq    ON wal(project_id, project_seq);  -- 游标/区间走这条
CREATE INDEX wal_project_global ON wal(project_id, seq);
CREATE INDEX wal_project_node ON wal(project_id, node_id, seq);
CREATE TABLE wal_meta (key TEXT PRIMARY KEY, value TEXT);  -- 回填标记
```

两套编号，各有用途：

| 列 | 含义 | 用途 |
|---|---|---|
| `project_seq` | **项目内**序号，每个项目从 1 开始，无空洞 | 人读、项目内游标（`fromSeq`/`cursor` 都走它） |
| `seq` | **全局**行号，`AUTOINCREMENT`，永不复用 | 排序与审计；跨项目的绝对顺序 |

为什么不是"一个项目一个文件"：那会让跨项目查询和归档变成 N 个文件的操作；单库 + 项目内序号
既能保留全局顺序，也让每个项目的日志从 1 开始。两条都建了索引，查询不会退化。

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
fromSeq  —— 排他下界：只返回 project_seq > fromSeq（"我处理到 42 了，给我之后的"）
toSeq    —— 包含上界（project_seq）
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
  "latestSeq": 4300, "latestGlobalSeq": 1_000_231,
  "fromSeq": 4100, "toSeq": null }
```

每行同时带 `projectSeq`（人读/游标）与 `seq`（全局行号，表格里作为 tooltip 显示）。

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
- 两个项目共用一个库时各自从 1 开始，全局行号仍单调；
- store 写入产生正确的 kind 序列与 before/after；
- 老项目一次性回填且不重复；
- HTTP `GET /wal` 的分页、区间、过滤。

## 8. 人类查询界面（历史弹窗）

WAL 不是只有程序能读。画布工具栏的「历史」按钮打开一个**历史模块弹窗**，里面两个 tab：

| tab | 内容 |
|---|---|
| 变更日志 | WAL 查询面板：seq 区间、节点 ID、类型筛选、每页条数；结果表（seq / 时间 / 类型 / 节点 / 变更摘要）；「查询」「最新」「下一页」（游标分页）；顶部显示最新 seq 与本页条数 |
| DAG 回放 | 原有 playback：载入回放数据后拖动时间轴、播放/暂停，画布按该时刻重建 DAG |

两个功能放同一个弹窗的理由：它们回答同一个问题的两个方向——**变更日志**说"改了什么"，
**回放**说"那一刻长什么样"；操作者排查时通常两者交替用。

实现要点：

- 面板**打开即加载最新一页**（先取 `latestSeq`，再按 `latestSeq - limit` 查），不需要先点查询；
- 结果表里的节点 ID 是按钮，点击即选中该节点（与画布联动）；
- 类型用可点选的 chip（`node.status`、`node.priority`…），与 Host 的 kind 常量一致；
- 分页只传 `cursor`，不会把上一页的区间重复发一遍；
- 错误显示在面板内（`role="alert"`），不会伪装成"没有记录"；
- 输入框用 `onInput`（而不是 `onChange`）：受控输入在合成事件下更可靠，也便于自动化验证。

测试：`scripts/wal-ui-selftest.mjs`（13 项）覆盖首屏自动加载、行渲染与摘要、kind 过滤、
区间+节点过滤透传、节点跳转、错误态、弹窗双 tab 切换与关闭。

## 9. 运维

### 9.1 探针不得写入生产日志

自检脚本会通过 `storeContext()` 打开内存存储；如果它不指定 WAL 文件，就会写进
`<DSH_HOME>/metainfer-research-lab/wal.sqlite`。曾经因此让真实项目的序号从 67 开始
（前 66 行是 `p`、`profiler-p`、`dispute-route-p` 等测试项目）。

现在 `scripts/lib/memory-domain.mjs` 的 `storeContext()` 默认给每个探针进程一个
`$TMPDIR/mirl-probe-wal-<pid>/wal.sqlite`，进程退出即删除；要覆盖就显式传
`{ kernel: { walFile } }`。

### 9.2 维护脚本

```
node scripts/wal-maintenance.mjs --purge-non-projects   # 清掉探针残留（project_id 非 prj-*）
node scripts/wal-maintenance.mjs --renumber             # 按全局顺序重算 project_seq
node scripts/wal-maintenance.mjs --file /path/to/wal.sqlite
```

两个开关都会打印每个项目的行数与 `project_seq` 区间，便于核对"是否从 1 开始"。

## 10. 历史入口与变更详情

- **入口不在画布工具栏**（WAL 查询不是高频操作）：改由顶栏的**时钟图标**打开
  「历史」弹窗；原来的"点击时钟 → 画布底部出现回放条"已删除，回放只在历史弹窗里。
- **变更详情**：表格里的摘要是一行、必然被截断，所以每行都提供
  - 点击摘要文字，或
  - 行尾的「详情」按钮

  打开**变更详情弹窗**，内容是：项目内序号 + 全局行号 + 类型 + 时间 + 节点（可点击跳转）、
  **变化的字段 before/after 对照表**、以及**完整的原始 payload（格式化 JSON，可滚动）**。
  关闭历史弹窗时会一并关闭详情，并停止可能仍在运行的回放。
