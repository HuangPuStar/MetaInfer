# [bug] Agent 工具作用域漂移：所有 preset 都拿到全量 49-action `metainfer_lab`

- **状态**：待修
- **严重度**：高（越权面 + 与设计文档不符）
- **发现时间**：2026-11-09
- **发现方式**：核对运行时 `request/header.tools` 与 `docs/02-agents-orchestration.md §1` 的设计表
- **受影响版本**：`dsh-metainfer-research-lab` @ `867d277`

---

## 1. 现象

`docs/02-agents-orchestration.md §1 角色总览` 明确规定：

| 角色 | 文档中声明的工具 |
|---|---|
| advisor (`lab-advisor`) | **无文件/命令工具**，只有自动注入的 `structured_output` |
| scheduler (`lab-scheduler`) | **无工具**，只有 `structured_output` |
| controller (`lab-controller`) | **无** |
| worker (`lab-worker`) | coding 工具（bash/fs/fs-search/todo/web）+ compaction |
| GC (`lab-gc`) | 只读 fs + `lab_cleanup`（**仅 GC 可见**） |

但实际运行时（解压 `~/.dsh/sessions/*/session-*/session.v4.jsonl.zstd`，读 `request/header`）拿到的工具清单是：

```
lab-advisor       3   metainfer_lab, structured_output, working_directory
lab-scheduler     3   metainfer_lab, structured_output, working_directory
lab-worker       13   bash, edit, glob, grep, metainfer_lab, read, read_image, structured_output,
                      todo_write, web_fetch, web_search, working_directory, write
standard         33   ...(主会话)..., metainfer_lab, ...
```

即：**`metainfer_lab` 在全部 4 类 preset 里都可见**，而它的 action 枚举有 **49 个**（`host/agent-tool.js` 的 `ACTION_ENUM`），其中包含：

```
start_node  cancel_node  delete_project  update_project  update_node
retry_node  escalate_node  approve_node  reject_node  auto_start  auto_stop
push_project  create_merge  finish_merge  create_project  ...
```

`delete_project`、`start_node`、`auto_stop` 这类破坏性 action 对**每一个实验 worker** 都是可调用的。

## 2. 影响

1. **越权面**：worker 与 advisor 只要"想"，就能删除项目、启动/取消任意节点、关闭 auto driver。它们与人类控制者共用同一个全权工具。
2. **约束只存在于 prompt**：`presets.patch.yml` 里 advisor 的 persona 写的是"You never write code and never run experiments"，这是一条**君子协定**，没有任何工具级强制。
3. **已经实际发生**：advisor 在 44 个会话里通过该工具发起了 **93 次**调用，scheduler **95 次**——它们**确实在用**这个工具（用的都是 `state`/`status`/`projects`/`node_files`/`transcript` 等只读 action，但这只说明模型选择了克制，不代表权限被限制）。
4. **与文档冲突**：`docs/02` 的设计表是本项目"agent 分工"的唯一事实来源，现在它和实现不一致，会让后续所有基于文档的判断（包括架构评审、外部监控模型接入）出错。

## 3. 复现

```bash
python3 - <<'PY'
import zstandard, json, glob
dctx = zstandard.ZstdDecompressor()
def load(f):
    with open(f,'rb') as fh:
        return [json.loads(l) for l in dctx.stream_reader(fh).read().decode('utf8','ignore').splitlines() if l.strip()]
res = {}
for d in sorted(glob.glob('/root/.dsh/sessions/*/session-*/session.v4.jsonl.zstd')):
    try: recs = load(d)
    except Exception: continue
    preset = recs[0].get('agentPreset') or '?'
    for r in recs:
        if r.get('type') != 'request/header': continue
        h = (r.get('data') or {}).get('header') or {}
        tools = h.get('tools') or (h.get('config') or {}).get('tools') or []
        if tools: res.setdefault(preset, set()).add(tuple(x['name'] for x in tools))
for p, s in sorted(res.items()):
    for t in s: print(p, len(t), ','.join(t))
PY
```

注意 `request/header` 有两种 schema（`data.header.tools` 与 `data.header.config.tools`），只查一种会得到空结果。

## 4. 根因

`index.js` 里工具是**全局注册**的：

```js
ctx.effect(
  () => registerAgentTool(ctx, service),
  'metainfer-research-lab: agent tool',
);
```

这里注册在插件根 context 上，因此进入"所有 agent 可见"的工具池。`presets.patch.yml` 里的 preset 只是**追加**自己的工具（`tool-bash`、`tool-fs`…），没有任何一处做**移除/白名单**，所以角色之间的工具差异只取决于"谁没被追加"，而不取决于"谁被禁止"。

## 5. 修复方案

### 方案 A（推荐）：按 preset 收敛 action，而不是收敛工具

保留 `metainfer_lab` 一个工具，但在注册时接受 `ctx` 所属的 preset，并给每个角色一个 action 白名单：

| 角色 | 允许的 action |
|---|---|
| worker | `projects` `status` `state` `node_files` `transcript` `runs` `run` `replay`（**只读**） |
| advisor | 同上（只读） |
| scheduler | 同上（只读） |
| gc | 只读 + `node_files` |
| controller / main | 全量 49 |
| intake | `intake_read` `intake_patch` `intake_ready` |
| copilot | 只读 |

实现位置：`host/agent-tool.js` 的 schema `enum` 与 handler 双重校验。schema `enum` 负责让模型**看不见**不许用的 action（这是第一道防线，模型不会去猜），handler 负责**拒绝**绕过 schema 的调用（第二道防线）。

优点：改动集中在一个文件，能同时解决"外部监控模型接入时的权限隔离"（见 #2）。

### 方案 B：每个角色注册不同的工具名

如 `lab_read` / `lab_control` / `lab_cleanup` 分开注册，preset 各挂各的。

优点：语义最清晰；也与 `docs/02` 里已经写的 `lab_cleanup`（GC 专用）一致。
缺点：要改 DSH 的工具注册作用域机制，改动面大；工具名变多，prompt 里要写清楚。

**推荐 A + 顺手补 `lab_cleanup`**（见下）。

## 6. 验收标准

1. `lab-worker` / `lab-advisor` / `lab-scheduler` / `lab-gc` 的 `metainfer_lab` schema `enum` 不含任何写 action。
2. 直接构造一个越权调用（例如在 worker session 里调 `metainfer_lab(action="delete_project")`），必须返回 `forbidden_action` 错误，且**不产生任何副作用**。
3. `docs/02-agents-orchestration.md §1` 的工具列与实际 `request/header.tools` 一致（用一个自动比对测试守住）。
4. 现有只读调用（advisor 93 次 / scheduler 95 次）不受影响。

## 7. 测试计划

- `scripts/tool-scope-selftest.mjs`：对每个 preset 构造 tool schema，断言允许/禁止的 action 集合；越权调用返回 `forbidden_action`。
- 契约测试：解析 `docs/02` 的表格（或维护一份 `presets.policy.json` 作为唯一事实来源），与代码里的白名单比对，不一致则失败。

## 8. 附带发现（同一次核对）

1. **`lab_cleanup` 工具不存在**：`docs/02` 与 `preset-lab-gc` 的 persona 都要求 GC "only request cleanup through the `lab_cleanup` tool"，但全仓库 `grep lab_cleanup` 无任何实现。GC 实际拿到的是 `metainfer_lab`，而它没有 cleanup action → **GC 被指示去用一个不存在的工具**。
2. **`docs/02` 的 "controller 无工具"**：`lab-controller` 会话确实从不运行（75 个会话、0 条 assistant 消息），所以"无工具"在效果上成立；但它的工具清单只要启动过一次就会和其他角色一样包含 `metainfer_lab`——属于同一根因。
3. **文档本身是准确的**（`01-architecture.md §7.3` 明确写了 "anchor 不调用 LLM，只占一个空会话"）。这次的漂移是**实现偏离文档**，不是文档过期。修复后应把文档表格当作契约来测。
