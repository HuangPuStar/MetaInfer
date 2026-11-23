# 08 · DAG 节点 ↔ Profile 追踪：展示与对比

> 面向 operator 的功能说明 + 实现索引。对应 issue #94 的后续需求：
> 「选中 DAG 节点后能直接打开该节点产出的 trace；允许多个 trace 同时打开并对比」。

## 1. 体验

### 1.1 从节点打开（DAG → trace）

节点检查器（右侧）新增 **Profile 追踪** 区块：

1. 自动扫描该节点 worktree 里的 trace 文件（`results/**` 等），列出相对路径 + 大小；
2. 单选 → **打开**：切到「Profile 追踪」tab 并加载该 trace；
3. 多选 ≥2 → **对比所选**：切 tab、逐个打开，并直接进入对比表。

没有候选时给出明确空态，而不是让用户去猜绝对路径。

### 1.2 在 Profiler tab 里直接开

Profiler tab 顶部新增 **从 DAG 节点打开** 选择器：选节点 → 列出候选 → 勾选 → 打开 / 对比。
适合"先看 trace、再决定看哪个节点"的动线。

### 1.3 多 trace 对比

- 最多同时开 **8 个** trace（`MAX_TRACES`），对比表建议 2–3 列；
- 对比表按 **kernel 名对齐**，第一列是基准，`Δ` 是相对基准的耗时差；
- 每行高亮最快的那一列；表头给出各 trace 的 **kernel 总耗时**与总 Δ%；
- 行数超过 200 截断（`COMPARE_MAX_ROWS`），并提示"仅显示前 N 行"。

## 2. 实现

### 2.1 Host

| 文件 | 职责 |
|---|---|
| `host/profiler/node-traces.js` | `listNodeTraces(worktree)`：有界遍历（深度 4 / 4000 文件 / 跳过 `.git` `node_modules`），**只列出 `*.json.gz`**（operator 2026-11-23 决定：这是实验实际产出的唯一封装），不解析内容；`resolveNodeTracePath(root, relPath)`：路径必须落在 worktree 内，越界返回 `bad_request` |
| `host/profiler/compare.js` | `compareTraces(entries)`：纯函数，按 kernel 名对齐，输出 columns / totals / rows（含 `fastest`、`deltaPct`） |
| `host/profiler/store.js` | 打开上限 3 → **8**；打开时记录 `nodeId/projectId/relPath` 溯源，`list()` 回传 |
| `host/lab-service.js` | `nodeTraceCandidates(projectId,nodeId)` / `resolveNodeTrace(projectId,nodeId,relPath)` |
| `host/http.js` | `GET /trace?view=candidates`、`GET /trace?view=compare&traceIds=a,b`；`trace.open` 支持 `{projectId,nodeId,relPath}` |

安全边界：扫描只读、不跟随符号链接；打开路径二次校验包含关系，客户端拿不到 worktree 外的文件。

**为什么按后缀而不是嗅探内容**：逐个解压/解析才能判定类型既慢、又会把不能索引的文件塞进列表。
列表阶段只做后缀过滤（`*.json.gz`），**加载阶段才校验**：不是合法 chrome trace 就报错
（`trace_invalid_json` / `trace_is_tarball` / `trace_invalid_gzip`）。
裸 `.json` 与 `tar.gz` 一律不列；直接按相对路径 `trace.open` 一个 tar.gz 仍会得到 `trace_is_tarball`。

### 2.2 Client

| 位置 | 行为 |
|---|---|
| `NodeTraceSection`（检查器） | 拉 `view=candidates`，列候选、勾选、打开/对比 |
| `ProfilerTab` | 新增节点选择器 + 候选列表 + 对比表；`request` prop 接管跨面板请求 |
| `Workspace` | 监听 `metainfer:open-trace` 窗口事件 → 设 `traceRequest` + 切到 trace tab |

跨面板解耦：检查器不持有 tab 状态，只 `dispatchEvent`；Workspace 是唯一知道 tab 的地方。
事件 detail = `{ projectId, nodeId, relPaths[], at }`，`at` 保证重复选同一批文件也会重新打开。

## 3. 验证

```
node scripts/profiler-selftest.mjs       16/16  （解析/无 Perfetto 资源时的降级）
node scripts/profiler-host-selftest.mjs  20+ 项（候选扫描、越界拒绝、溯源、对比对齐）
node scripts/profiler-ui-selftest.mjs    13 项新增（节点区块、勾选解锁、对比表、Δ 渲染）
```

Host 用例覆盖：非 trace JSON 被过滤、`node_modules` 被跳过、`../../../etc/passwd` 被拒、
两条 trace 来自同一节点且 id 不同、`compare` 少于两条报 `bad_request`。

## 4. 已知限制

- 只列 `*.json.gz`；裸 json / tar.gz 不在列表里（按相对路径仍可尝试打开，非标准会失败）。
- 列表按后缀给候选，不等于是合法 trace；打开时非 chrome trace 会失败（按设计）。
- 对比按 kernel **名**聚合；同名不同 shape 的 kernel 会被合并（视图里可再看 detail）。
- Perfetto UI 需要 `npm run perfetto:fetch` 联网下载；缺失时降级为内置查看器（对比表不依赖 Perfetto）。

---

# 附：DAG 画布（10k 节点）

## 1. 为什么重写

旧画布为每个可见节点挂一张 DOM 卡片，并且**硬性截断**到 `MAX_RENDERED_NODES = 300`
（右上角提示"视口内 300/10000"）。10k 节点时两个问题同时出现：节点**看不到全**，
而且每次平移/缩放都要 React 重渲染整棵卡片树，拖动明显掉帧。

## 2. 新结构

单 `<canvas>` 承载整张图，DOM 只保留**选中的那一张**卡片（保证"继续 / 提升优先级 /
重试"等快捷操作还在）。

| 关注点 | 做法 |
|---|---|
| 绘制 | `buildDagScene()` 把节点/边压成绝对坐标的绘制模型（x 排序数组 + 邻居表），每次数据变化只建一次 |
| 平移/缩放 | 只改 `viewRef`（pan/zoom）并 `requestAnimationFrame` 合并重绘；**React 全程不重渲染**，缩放百分比最多 8 次/秒更新 |
| 可见性 | `visibleDagItems()` 用二分定位 x 区间，再按 y 过滤；只画视口内的卡片，**数据层永远是全量**（`scene.count === 节点数`） |
| 细节降级 | 视口内节点 > 1400 或 zoom < 0.35 时只画色块与状态条（仍全部绘制）；放大后自动恢复标题/状态文字 |
| 命中测试 | `hitTestDag()` 在 x 排序数组上二分 + 矩形判定；点击选中、双击打开、方向键平移、`+/-/0` 缩放 |
| 高亮 | 选中节点加粗描边、关联边用强调色、非关联节点降透明度 |

## 3. 验证（`scripts/dag-canvas-selftest.mjs`，17 项）

- 场景包含全部 **10000** 个节点与 9999 条边；
- fit 视口下可见集合 = 全图，`paint()` **实际绘制 10000 张卡片**（fill ≥ 10000），不是 300；
- 10k 可见时文字细节自动关闭（`fillText === 0`），单帧 < 120 ms（录制上下文计时）；
- 放大后可见节点收敛到 < 200，文字恢复；
- 命中测试：中心命中、间隙不命中、图外不命中；
- 挂载后：1 个 canvas、**0 个 per-node DOM 卡片**、点击能选中正确节点。

## 4. 取舍

- 悬停不再弹快捷按钮（DOM 卡片只给选中节点）；悬停有描边高亮，点一下即出现完整卡片与操作。
- 画布颜色跟随 `prefers-color-scheme`，不读 CSS 变量（canvas 需要具体色值）。
