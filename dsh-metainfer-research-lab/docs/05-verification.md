# 05 · M0 实现与验证记录

> 日期：2026-10-23 · DSH `0.2.1-rc.2` · profile `web` · GUI `http://127.0.0.1:3080`
> 工作区：`<workspace>` · 插件目录：`dsh-metainfer-research-lab/`

## 1. M0 交付物

| 文件 | 内容 |
|---|---|
| `package.json` | bundle 清单：`dsh.bundle.patch` 数组（`cordis.patch.yml` + `presets.patch.yml`）、`dsh.client`（platform=web, immediately, inject layout/sidebar）、`exports`、`files`、`dependencies.zod` |
| `cordis.patch.yml` | Host 插件行 `id: metainfer-research-lab` |
| `presets.patch.yml` | 5 个 preset 行：`lab-worker` / `lab-advisor` / `lab-scheduler` / `lab-controller` / `lab-gc` |
| `index.js` | Host apply：打开 storage domain → `ctx.provide('metainferLab')` → 注册 HTTP 路由 |
| `host/store.js` | `metainfer_research_lab` domain（per-record）+ M0 项目记录读写（`createProject` 为 M1 预留 stub） |
| `host/http.js` | `/api/metainfer-research-lab/{health,projects}`（GET/POST，Connection 鉴权栅栏后） |
| `client.js` | ModuleLoader bundle：locale `metainferLab`、`main` 面板、`sidebar.panellist` 图标、health/projects 读取与 loading/error/empty/list 状态、ErrorBoundary、仅主题 token |
| `locale/en.json`、`locale/zh.json` | 插件展示元数据（title/description） |
| `icon.svg` | 原创 DAG 图形图标（64×64，953 B） |

依赖与静态检查：

```text
pnpm install --ignore-scripts --store-dir <workspace>/.pnpm-store   → zod 4.6.7 installed
node --check index.js / host/store.js / host/http.js / client.js     → all PASS
JSON.parse(locale/en.json, locale/zh.json)                          → PASS
python3 xml.dom.minidom.parse(icon.svg)                               → PASS
```

> 说明：本机 pnpm 默认 store 位于只读路径，安装时用 `--store-dir` 指向工作区；后续 `pnpm install` 复用该 store。
> `node_modules/zod` 位于插件 checkout 内，DSH 以 `link:` 安装插件后按真实路径解析到它。

## 2. 安装结果

```text
plugin_manager install_bundle target=<workspace>/dsh-metainfer-research-lab
→ application: applied
→ bundle: dsh-metainfer-research-lab · version 0.1.0
→ warnings: []
```

首次安装失败：`ERR_PNPM_ADDING_TO_ROOT`（profile 是 pnpm workspace root，`pnpm add` 默认拒绝写根依赖）。
处理：在 profile 写入 `.npmrc`（`ignore-workspace-root-check=true`）后重试成功；这是 pnpm 官方开关，仅影响该 profile 的安装命令。

环境变更记录：

- `~/.dsh/profiles/web/package.json`：新增 `"dsh-metainfer-research-lab": "link:<workspace>/dsh-metainfer-research-lab"`，并加入 `dsh.profile.bundles`
- `~/.dsh/profiles/web/.npmrc`：`ignore-workspace-root-check=true`
- `<workspace>/.pnpm-store/`：pnpm store（工作区内，避免只读路径）
- 插件内 `node_modules/zod`（zod 4.6.7）

## 3. 运行时验证

### 3.1 Host

| 检查 | 结果 |
|---|---|
| `plugin_manager list_plugins` | `include:metainfer-research-lab` · module `dsh-metainfer-research-lab` · enabled=true · **fiberPhase=active** |
| 5 个 preset 行 | `include:preset-lab-{worker,advisor,scheduler,controller,gc}` 全部 enabled=true · fiberPhase=active |
| `dsh --profile web --dump-config` | 插件行与 5 个 preset 行均出现在组合结果中；无解析错误 |
| `Config.listConfigs name=dsh-metainfer-research-lab` | entry 存在，config status=`absent`（本插件未声明 Config schema，符合预期） |
| `Service.listService service=metainferLab` | 未出现在 Inspect 目录：该目录只收录 DSH 已知/typert 编目的 Service，第三方 `ctx.provide` 的 Service 不会被编目；fiberPhase=active 表明 `apply` 已完成（domain open → provide → routes 注册） |

推断关系：`apply` 中 `await openStore(ctx)` 成功后才 `ctx.provide` 与注册路由；fiberPhase=active 证明这两步没有抛出。

### 3.2 Client（实时槽位）

```text
Slots.listSubTree root=sidebar.panellist
→ occupants: plugins(0), schedules(10), metainfer-research-lab(20, active=true)

Slots.listSubTree root=main
→ occupants: plugins, conversation, schedules, metainfer-research-lab (active=true)
```

说明：Client module 已加载并注册成功，侧栏图标与全屏面板入口都处于 active 状态。

### 3.3 未验证项与限制

- **浏览器视觉**：本会话无浏览器控制，未截图；需用户刷新 GUI 后点击侧栏「科研实验台」图标，确认 M0 面板渲染、亮/暗主题与中文文案。
- **HTTP 往返**：路由位于 Connection 鉴权栅栏后，未搜索/使用页面 token；路径匹配为静态核对（Host 注册 `/api/metainfer-research-lab/health`，Client 用相对 `api/metainfer-research-lab/health`）。面板打开时会显示 `Host 已就绪 · 项目数 0`；这是用户可完成的最终确认。
- **存储写入**：M0 只打开 domain、未写记录（`createProject` 为 stub），写入路径在 M1 项目向导里首次实测。

## 4. 下一步（M1）

1. GitEngine：仓库校验（`rev-parse --show-toplevel` / `--is-bare-repository` / branches / baseCommit）。
2. 项目创建向导 + `project` 持久化真实字段（brief、repo、config、counters）。
3. DAG 数据模型（节点/边/计划状态）与根节点 `planned`。
4. DAG 画布（分层布局、节点卡片、边、选中、平移缩放）与节点检查器（只读 + 提示词编辑）。
5. `/state`、`/events`、`/commands` 路由与 Client 轮询。

---

# M1 实现与验证记录（2026-10-23，同日续）

## M1 交付

| 部分 | 内容 |
|---|---|
| `host/git-engine.js` | `git rev-parse --show-toplevel/--is-bare-repository/--absolute-git-dir`、branch 列表、默认分支、baseCommit、dirty；所有命令经 `ctx.subprocess.spawn`（bounded、collect 输出、超时 abort） |
| `host/store.js` | `metainfer_research_lab` domain 的 projects/nodes/runs/cycles/events 访问层、`__` 复合 key、per-project async 锁、事件序与 5000 条保留 |
| `host/lab-service.js` | 项目创建（git 校验 + baseCommit + 根节点 `planned`）、state 投影（revision 短路、资源视图）、events 分页、`node.edit` / `project.update`（revision+事件） |
| `host/http.js` | 6 条路由：`/health`、`/projects`(GET+POST)、`/repo`、`/state`、`/events`、`/commands`；统一 `{ok,data}` / `{ok,error}` envelope |
| `index.js` | 打开 domain → GitEngine → LabService → `ctx.provide('metainferLab')` → 路由 effect；`inject = ['connection','storageDomain','subprocess']` |
| `client.js` | M1 全量 UI：项目列表/创建向导（仓库验证、分支选择、brief/初始 prompt、资源池、并发/节点/超时设置）、工作台（顶栏、节点分组栏、分层 DAG 画布 + 平移/缩放/fit/选中、检查器编辑 prompt/完成标准/时限、活动日志）、1500/2000ms 轮询 + revision 短路 + visibility 暂停 + 退避重试 |
| `scripts/selftest.mjs` | 离线自测：真实 demo 仓库 + 内存 storage + 本地 subprocess 适配器 + 直接调用 HTTP handler |

## 自测结果（17/17 通过）

```text
PASS validateRepo(demo repo) / non-repo rejected / relative path rejected
PASS createProject（根节点 planned、baseCommit、worktree 路径、事件 2 条）
PASS getState + revision short-circuit
PASS updateNode prompt / updateProject brief（revision 2、3）
PASS events 有序分页 / listProjects / 非法 config 拒绝 / 未知 project 拒绝 / health
PASS routes: 6 条端点注册（GET/POST 方法匹配）
PASS HTTP health / repo validation envelope（ok + not_git error）
PASS HTTP project list + create + state + events + node.edit + unknown_command
PASS HTTP malformed JSON 返回 ok:false bad_request
```

运行方式：`cd dsh-metainfer-research-lab && node scripts/selftest.mjs`

## 运行时加载验证

- 通过 bundle 关闭再启用（`set_bundle false/true`）触发 HMR 重组合，Host 插件以 **M1 代码**重新激活：
  `~/.dsh/metainfer-research-lab/activation.json` → `version: 0.2.0-m1`，Host PID 未变化（无需重启）。
- `plugin_manager list_plugins`：`include:metainfer-research-lab` fiberPhase=active；5 个 preset 行 active。
- Client 槽位（live）：`sidebar.panellist` 中 `metainfer-research-lab`（order 20, active），`main` 中同 key active。
- 客户端静态检查：`node --check client.js` 通过；172 个 zh/en locale key 对齐；仅 `--dsw-alias-*` token；无字面颜色；无 JSX；仅 `require('react')`。

## 未验证项与限制

- **浏览器端到端**：本会话无浏览器控制（且路由位于 Connection 鉴权栅栏后，未获取页面 token），
  以下需用户刷新页面后实测：
  1. 侧栏「科研实验台」→ 项目列表/创建向导；
  2. 用 `demo-research-repo` 路径验证仓库 → 创建项目 → 看到根节点 cards；
  3. 画布平移/缩放/fit/选中、活动日志；
  4. 检查器修改根节点 prompt/完成标准/时限并保存（revision 自增，刷新后仍在）；
  5. 刷新页面后项目与根节点仍在（storageDomain 持久化）。
- Client 更新后浏览器需要 **刷新页面** 才能加载新的 `client.js`（client 插件不走 dev watcher）。

## 开发期重载方式（记录给后续里程碑）

- Host 代码改动：`plugin_manager set_bundle dsh-metainfer-research-lab enabled:false → true`（或触发 profile patch 重组合）即可热替换，无需重启 Host。
- Client 代码改动：刷新浏览器页面。
- 数据目录：`~/.dsh/storages/metainfer_research_lab/`（domain 数据）、`~/.dsh/metainfer-research-lab/activation.json`（激活标记）、
  `~/.dsh/metainfer-research-lab/worktrees/<projectId>/`（M2 起创建 worktree）。

---

# M2 实现与验证记录（2026-10-23，同日续）

## M2 交付

| 部分 | 内容 |
|---|---|
| `host/runtime.js` | node anchor Agent（cwd=worktree）+ worker subagent activation（`lab-worker` preset、`outputSchema` NodeReport）；worktree 创建/复用、自动 commit、完成/失败/取消、follow-up 消息与 `turn/end` 等待、每秒 watchdog + 确定性终止（cancel → dispose → jobs kill → `/proc` cwd 扫描 SIGTERM/SIGKILL → nvidia-smi GPU 校验 → finally 释放资源 → verifiedClean）、资源账本与 `maxRunningNodes`/资源池硬校验 |
| `host/transcript.js` | `ctx.sessionQuery.readSurface` → 扁平 transcript 行（user/assistant/reasoning/tool/tool-result，seq 游标排他，同一 step 多行共享 seq） |
| `host/agent-tool.js` | 全局 `metainfer_lab` 工具：projects/status/create_project/state/start_node/cancel_node/message_node/transcript，与 UI 走同一 service 方法 |
| `host/http.js` | 新增 `GET /transcript` 与 `node.start` / `node.cancel` / `node.message` 命令 |
| `client.js` | M2 执行 UI（4,248 行）：启动/取消/继续对话、running 倒计时、报告卡片、timeout/termination 面板、followUps、transcript 抽屉（1s 轮询、复合行去重、工具调用折叠、Esc 关闭）、composer（仅 completed 未封存叶子） |
| `presets.patch.yml` | 修正 `dsh-tool-todo` 必填 config（`allowParallelInProgress: true`），worker preset 可正常挂载 |

## 离线自测

`node scripts/selftest.mjs` → **17/17 通过**（7 条路由、HTTP 契约、GitEngine、ProjectStore；runtime 不在离线测试内）。

## 真实 E2E（通过 `metainfer_lab` 工具驱动，demo 仓库）

1. **节点执行成功**（项目 `prj-2bad3d4e`）：
   - worktree 创建于 `~/.dsh/.../worktrees/prj-2bad3d4e/n-0001`，分支 `dshex/prj-2bad3d4e/n-0001`，基于 demo 仓库 baseCommit；
   - worker 在 worktree 中执行两条 `train.py` 命令并写 `notes/lr_baseline.md`；
   - 结构化报告落库（9 条 metrics、next/risks），Host 自动 commit `5ed4826`，`resourcesHeld` 释放；
   - transcript 行序与工具调用内容正确。
2. **继续对话**：`node.message` → anchor 冷恢复 + `sendMessage` → 新 turn 完成 → 第二次 commit `63ac93c`，
   `followUps=1`、`reportText` 更新、资源再次释放。
3. **确定性超时**（1 分钟 timebox）：deadline 后 ~1s 内节点 failed（stage=timeout），
   `termination.verifiedClean=true`、`gpuFreed=true`、无 leftover、资源释放；transcript 末尾工具调用为 `tool call aborted`。
4. **孤儿进程测试**：worker 用 `nohup sleep 240 &` + 前台 `sleep 240`；终止后宿主侧无该 worktree cwd 进程。
   观察：DSH bash 沙箱使用 `bwrap --unshare-pid --die-with-parent`，工具取消时沙箱进程树随之终止；
   插件 Reaper 仍作为兜底（非沙箱/detach 场景），本次 `killedPids=[]` 表示沙箱已先清理。
5. **启动失败路径**：故意触发 preset 配置错误时，节点 failed(stage=start)、资源释放、可重新创建项目重试（自动 retry 命令留 M4/V1）。

## 未验证项

- 浏览器视觉/交互（启动按钮、倒计时、报告卡、transcript 抽屉、composer）：需刷新页面后人工确认（无浏览器控制）。
- Client 更新需刷新页面；Host 更新通过 bundle 关闭/启用热替换（本次 PID 未变）。

## 已知问题

- 首次启动失败是 preset 配置缺 `tool-todo.allowParallelInProgress`；已修复。后续会补 V1 的「失败节点重试」命令。
- 测试产生了 4 个 demo 项目与若干隐藏会话；V1 会提供项目删除与 worktree 清理。

---

# M3 实现与验证记录（2026-10-23，同日续）

## M3 交付

| 部分 | 内容 |
|---|---|
| `host/snapshot.js` | advisor 快照（叶子 + 2 级祖先、预算、资源、failed/timeout、recentProposals、pendingProposals）与 scheduler 快照 |
| `host/orchestrator.js` | advisor / scheduler 一次性 activation（preset `lab-advisor`/`lab-scheduler`、`outputSchema`、180s 超时）；提案校验（parent、title/prompt、needs、timebox、去重、maxNodes）；创建子节点 + commit + tag + 封存父节点；scheduler 逐项 `runtime.start` 并记录拒绝；`project.step` cycle（cycle 锁、advisor pass + scheduler pass、runs/cycles 持久化、事件） |
| `host/store.js` | runs/cycles 表访问（`projectId__runId` / `projectId__cycId`） |
| `host/lab-service.js` | step / createSuccessor / listRuns / getRun；state 派生 `sealed`/`isLeaf`（只统计已批准子节点） |
| `host/http.js` | `GET /runs`、`project.step`、`node.successor` |
| `host/agent-tool.js` | `metainfer_lab` 新增 step/successor/runs/run 动作 |
| `client.js` | M3（5,327 行）：Step 按钮 + 摘要、添加后继模态、运行记录面板（2s 轮询 + 详情）、封存 UI、活动日志新事件 |

## E2E 验证

- **手动 Step（auto 采纳模式）**（`prj-2bad3d4e`）：root 完成后 Step → advisor run `run-aaa3a7e0` 提议 3 个后继，
  Host 创建 `n-0002` 并封存 root（tag `dshex/prj-2bad3d4e/n-0001`），scheduler run `run-3654f294` 启动 `n-0002`；
  `n-0002` 在 8 分钟 timebox 内正常执行并产出报告。
- **confirm 模式提案**（`prj-588d22f1`，`acceptMode=confirm`）：root 完成后 Step → advisor 生成 `n-0002`/`n-0003` 两个
  proposed 节点；root **保持未封存**（`sealed:false`），scheduler 无 planned 可启动（skipped）。
- **批准/拒绝**：`node.approve n-0002` → parent `sealedAt` 写入、子节点转 planned（baseCommit 重算为父 HEAD）；
  `node.reject n-0003` → 记录删除、pendingProposals 归零；再 Step → advisor 跳过（无可评审叶子）、scheduler 启动 `n-0002`。
- **运行记录**：`GET /runs` 返回 advisor/scheduler 的 model、耗时、stopReason、analysis、inputSnapshot、output、rejected；
  `GET /runs?runId` 返回完整详情。
- **修复的 bug**：① 同一 advisor pass 的第 2/3 条提案曾被误拒（封存后重算候选集）→ 改为本 pass 内冻结候选集；
  ② proposed 子节点曾让父节点显示 `sealed:true` → 改为只有**已批准**子节点才计入封存/叶子判定（follow-up/auto 同步修正）。

# M4 实现与验证记录（2026-10-23，同日续）

## M4 交付

| 部分 | 内容 |
|---|---|
| `host/auto.js` | 自动挡控制器：auto.start/stop/resume、2s 扫描、budget（maxCycles/maxWallClock/maxNodes/idleCycle/errors）、`waiting`（待确认）、暂停原因与事件、批准/拒绝后唤醒 |
| confirm 流程 | advisor 生成 `proposed`（不封存父节点、不建 worktree）；`node.approve`（commit 父 + tag/seal + 转 planned）/`node.reject`（删除记录、父节点恢复可评审）；`maxPendingProposals` 限制 |
| `host/gc.js` | 超时/取消终止后异步 spawn `lab-gc`，产出结构化 postmortem（cause/leftovers/cleanupRequested/recommendation/summary），写 run 与 `termination.gcRunId/gcPostmortem`；不阻塞资源释放 |
| `host/reconcile.js` | 插件加载时把 stale `running` 节点标记 failed（termination.kind=restart）、释放资源并写事件 |
| 配置 | `config.advisor.{acceptMode,maxProposalsPerPass,ancestorDepth,maxPendingProposals}`、`config.auto.*`、`config.models/prompts/git` 的合并式校验与更新 |
| `host/http.js` / `agent-tool.js` / `lab-service.js` | `auto.start/stop/resume`、`node.approve/reject`、auto_status；state 增加 `auto`、`pendingProposals`；`node.edit` 允许 proposed |
| `client.js` | M4（6,542 行）：自动挡开关/状态芯片/确认模态、proposed 卡片与批准/拒绝、设置面板、GC postmortem 与 `gc` 运行详情 |

## E2E 验证

- **自动挡 + confirm**（`prj-588d22f1`）：`auto.start` → cycle 1 生成 proposed 后进入 `waiting/awaitingConfirmation`
  （不阻塞其他工作）；批准 `n-0004` 后自动唤醒 → cycle 2 启动 `n-0004` → 达到 `maxCycles=2` 后
  `paused/maxCycles`；`n-0004` 完成后保持在 paused（预算不自动放宽）。
- **重启恢复**：插件热重载时 `n-0002`（当时 running）被 reconcile 标记 failed(stage=run, termination.kind=restart)，
  资源释放，不再永久卡在 running。
- **GC 善后**：1 分钟 timeout 节点被确定性终止后，`lab-gc` 异步运行成功（role=gc），postmortem 指出
  「prompt 故意要求 sleep 300 超出 1 分钟 timebox」并给出 `recommendation=none`；GC 失败不阻塞资源释放。
  期间修复了 `lab-gc` preset 缺失 `tool-fs-search.sampleOverCapGlobResults` 配置的问题。
- **配置**：项目创建时写入完整 `advisor/auto` 默认配置；`project.update {config}` 支持嵌套合并（client 设置面板使用）。

## 仍未做浏览器端到端确认

Client M3/M4 均为静态 + stub-React 验证；需要刷新 GUI 后人工确认 Step、运行记录、自动挡、批准/拒绝、设置与 GC 面板。

---

# V1 实现与验证记录（2026-10-23，同日续）

## V1 交付

| 部分 | 内容 |
|---|---|
| `node.retry` | `runtime.retry`：start 阶段失败 → 回 planned 重启；run 阶段失败 → 带错误上下文的 follow-up（冷恢复 anchor + `sendMessage`，复用 follow-up 完成/失败路径） |
| `project.delete` | 拒绝运行中项目（`project_busy`）；停自动挡；可选 `removeWorktrees` 逐个 `git worktree remove --force` + 删除 worktree 根目录；删除 projects/nodes/runs/cycles/events；分支与 tag 默认保留 |
| 自测 | `scripts/selftest.mjs` 19/19（新增 retry 委托、deleteProject 记录清理两个用例） |
| `client.js` | V1（6,868 行）：失败节点 `↻ 重试`、项目列表删除（worktree 复选框默认关）、顶栏项目菜单删除并返回列表 |

## E2E 验证

- **project.delete**：真实删除 5 个测试项目（`prj-89c138fb/prj-838e4ea3/prj-c35f8c94/prj-34c22b08/prj-94c0a614`），`worktreesRemoved=1` 每个，
  列表/状态/事件记录消失，隐藏 worktree 目录被移除，Git 分支与 tag 保留。
- **node.retry**：merge 节点被热重载 reconcile 成 failed(restart) 后，`retry_node` 冷恢复 merge 会话并带失败上下文继续；
  随后 `finish_merge` 成功提交（见 V2 章节），说明 run 阶段重试路径可用。
- 失败 start 阶段回 planned 的路径由 selftest 的 runtime 桩覆盖；真实场景由 M2 preset 配置错误场景佐证（当时只能重建项目，现在可重试）。

# V2 实现与验证记录（2026-10-23，同日续）

## V2 交付

| 能力 | 实现 |
|---|---|
| **多父 merge 节点** | NodeRecord 新增 `kind:'merge'`、`parentIds[]`、`merge{state,conflictFiles,prepared,committedAt,headCommit}`；`node.merge` 创建（2–4 个 completed 父节点，冻结并封存父节点；tag 改为 `dshex-sealed/<project>/<node>` 避免与分支 ref 歧义）；`runtime.start` 对 merge 节点先 Host 侧 `git merge --no-ff --no-commit` 准备，冲突时启动 `lab-merge` 交互式 Agent（无 structured_output，不自动完成）；`node.finish_merge` 由 Host 校验 `git diff --diff-filter=U`，自动 stage agent 已解决冲突的文件（检查无 `<<<<<<<` 标记）后提交 merge commit 并完成节点；running merge 节点允许 `node.message` 继续对话；超时/取消走同一确定性终止链路 |
| **异构模型对抗评审** | `advisor.reviewers[] = {lens,provider,model,reasoningEffort?}`（≤4）；Host 并行运行多个 advisor activation（presets `lab-advisor`，不同 lens/模型），记录 `lens/panelSize`，Host 汇总去重（parentId+promptHash）、封顶后落库；单 advisor 仍是默认路径 |
| **token 预算** | 从节点/角色会话 `assistant/message` 的 `usage` 聚合 `node.usage` 与 run.usage；`auto.maxTokens>0` 时 `tokensUsed` 超限自动 `paused/maxTokens`；state/runs/client 展示 |
| **远程 push** | `project.push`：推送实际存在的 `refs/heads/dshex/<project>/...` 与 `refs/tags/dshex-sealed/...`；`config.git.remote` 可配置 |
| **agent tool** | `metainfer_lab` 增加 create_merge/finish_merge/push_project/update_project/retry_node/delete_project/auto_* 等动作 |
| `client.js` | V2（7,775 行）：merge 创建/卡片/冲突面板/完成合并/运行中 merge 对话、reviewers 设置、runs 的 lens/panelSize/usage、token 展示与 maxTokens、push 菜单 |

## E2E 验证

1. **多父 merge（冲突→交互→提交）**（`prj-852ce8b5`）：root 完成后手工创建两个 sibling（改写同一 `notes/shared.md`），
   两者分别 commit `4bb9faf`/`6711524`；`node.merge parentIds=[n-0002,n-0003]` → merge 节点 n-0004，两个父节点被封存；
   start 后 merge 准备状态 `conflict`（冲突文件 `notes/shared.md`），`lab-merge` 首轮自动把双方结论都保留；
   `finish_merge` 提交 merge commit `ff1a823`，`git rev-list --parents` 显示两个父提交，A/B 均为 HEAD 祖先，工作区干净。
2. **自动 stage 修复验证**（`prj-80401352`）：同样冲突场景，merge agent 只改文件、不 `git add`（worktree 的 .git 在沙箱只读），
   `finish_merge` 由 Host 检测无冲突标记 → 自动 `git add` → commit `a310551`（双父、A/B 祖先、内容含双方结论），
   期间还验证了「热重载 reconcile failed(restart) → retry_node → finish_merge」路径。
3. **异构评审 panel**（`prj-d53b72c0`）：`advisor.reviewers` 两个 lens（methodology / compute）+ 两路并行 advisor run
   （`run-1286e59c`/`run-5f738114`，均带 lens、usage、panelSize 字段）；Host 汇总生成 2 个节点，scheduler 按 `maxRunningNodes=1` 只启动 1 个，
   另一节点等待（`n-0003` planned）。
4. **token 预算**：panel 后 `auto.tokensUsed=247,875`；`update_project auto.maxTokens=200000` 后 `auto_start`
   立即 `paused/maxTokens`（未跑新 cycle）。
5. **push**：`project.push` 推送 2 个实验分支 + 1 个封存 tag 到本地 bare remote（`<workspace>/metainfer-remote.git`），
   `git --git-dir ... show-ref` 确认 refs 与提交哈希一致。
6. **修复的问题**：
   - 多 reviewer 并发创建同一个 controller 会话冲突 → `ensureController` 增加 promise 锁；
   - seal tag 与节点分支同名导致 `git merge` ref 歧义 → tag 改名 `dshex-sealed/...` + merge 使用 `refs/heads/...`；
   - merge staging 函数缺少 `readFile` import（异常被 catch 误判为未解决）→ 修复并重测；
   - push 包含尚未创建的 planned 节点分支 → 改为只推实际存在的 ref。

## 最终离线检查

`node scripts/selftest.mjs` → **19/19 通过**；所有 Host 模块 `node --check` 通过；`client.js` `node --check` 通过；
Host 插件版本 `0.6.0-v2` 已热加载（PID 不变），client 需刷新页面后加载 7,775 行新版本。

## 仍需人工确认（无浏览器控制）

- 刷新 GUI 后的视觉/交互：M1–M4 + V1/V2 全部 UI 路径（创建/执行/对话/Step/运行记录/自动挡/审批/设置/GC/重试/删除/merge/评审 panel/token/push）。
- 亮暗主题下的样式细节；真实 GPU 环境下的资源隔离与 `nvidia-smi` 校验（本机无 GPU 时为空操作，已按 best-effort 处理）。


---

# V3 实现与验证记录（2026-10-23，同日续）

## 交付

| 部分 | 内容 |
|---|---|
| `host/models.js` | 节点/角色模型解析、provider/model/effort/allowlist 校验、`GET /models` 目录与价格、成本计算、下一档模型 |
| 节点模型与 attempts | `node.model/modelResolved/attempts/usage/costUsd`；`node.edit`/successor/merge/advisor 可设模型；手动 `node.escalate`/`node.retry {model|upgrade}`；自动升级（`routing.autoUpgrade`，受 maxAttempts 与 `auto.maxCostUsd` 约束） |
| 成本预算 | `auto.maxCostUsd` + `auto.costUsed` + `paused/maxCost`；按 `modelOptions` 单价计算 |
| `host/cluster.js` | 轻量 coordinator（HTTP+JSON，Bearer token，机器/实例注册、整卡 lease、FIFO 队列、心跳、TTL reaper、GPU-秒 usage）+ client manager（register/acquire/renew/release/releaseAllMine/status） |
| 运行时接入 | GPU 节点先租后跑；排队 `resourceWait`；2s pump；心跳续约；`resource_lost` 终止；`releaseNode` 幂等释放；重启 `releaseAllMine` + reconcile 清理；auto `waiting/awaitingGpu` |
| API/UI 契约 | `GET /models`、`GET /cluster`；state 增加 model/attempts/cost/lease/resourceWait/auto.costUsed/cluster；agent tool 增加 models/cluster/escalate 等动作 |
| client | V3（进行中，task-8）：模型选择器、attempts/成本、手动升级、集群面板与等待徽标 |

## 离线检查

`node scripts/selftest.mjs` → **19/19 通过**（10 条路由，含 `/cluster`）；Host 版本 `0.8.0-v3` 热加载。

## E2E 证据

- 节点模型：显式 profile 启动后 attempt 记录 model/effort，cancel 后 usage 47386 tokens / cost 0.005632；
  非法 provider → `model_unavailable`；timeout 自动升级 attempt 2 使用 premium profile，累计 cost 0.000716；
  手动 `node.escalate` 同样开新 attempt。
- 集群：1 张 fake GPU 下项目 A 获得 lease、项目 B 排队；取消 A 后 ~2s 内 lease 转给 B 并自动启动；
  热重载后 B failed(restart)、lease 释放、usage 记录；第二台机器通过 HTTP 注册并可获得远程整卡 lease，
  短 TTL 到期后 reaper 回收；错误 token 401。
- 修复：coordinator HTTP server 退出关闭、reconcile 清理 lease/resourceWait、`newSessionId` 导入。

## 已知限制

- 机器亲和：lease 只来自本机；跨机执行需要目标机也跑 DSH 或后续远程 provider。
- 无抢占/配额/容器隔离；GPU 整卡独占依赖 Host 约定与运行时环境变量提示。
- 仿真设备用于本机验证；真实集群需在 `cluster.json` 配置 `devices:null`（nvidia-smi）或显式设备列表。

---

# V3 运维增补验证（2026-10-24）

## 协调器身份/看板/多协调器防护

- **内置 Dashboard**：coordinator `port 8898` 下 `GET /` 返回 HTML（含 clusterId/coordinatorId），
  浏览器输入 token 后 3s 轮询 `/v1/status`；`GET /v1/status` 返回 clusterId/coordinatorId/url/machines/pools/leases/queue/usage。
- **clusterId 校验**：错误 clusterId 的 register 请求返回 **409 `cluster-mismatch`**（expected/got 字段）。
- **state 文件锁**：同一 stateFile 已有存活 pid 时，第二个 coordinator 启动返回
  `coordinator-already-running (pid …, url …)`；正常退出会写/删 `*.lock`。
- **machine claim**：模拟"另一个存活进程 + 不同 coordinatorUrl"的 claim 文件后，新实例启动 `blocked=true`，
  `error=machine-claimed-by-other-coordinator`，acquire 被拒绝；`allowMultipleCoordinators:true` 可覆盖。
- **CLI**：`node scripts/cluster-status.mjs --url … --token …` 正确输出集群/机器/租约/队列/用量表格，
  `--json` 输出原始 JSON；错误 token/不可达时给出定位提示并非零退出。
- **Dashboard/锁/claim 均为只读或防护逻辑**，不影响已有 lease 生命周期与运行时行为。

## 状态

Host 版本 `0.8.1-v3`（`paused/cluster` 默认关闭）；离线自测 19/19；cluster 默认配置为 disabled，
样例见仓库 `cluster.example.json`，详细操作手册见 `docs/06` 第 9 节。


## V4 增补：纯 GUI 集群配置（2026-10-24）

- 新增 Host API：`GET /cluster/config`（返回 config/status/activeLeases/warnings，token 只回传 tokenSet/tokenMasked）
  与 `commands {type:'cluster.config'}`（合并 patch → 校验 → 原子写 `cluster.json` → 在进程内 stop 旧 manager、
  创建并 start 新 manager；无需重载插件）。
- 实测（通过 `metainfer_lab` 工具，无命令行）：
  1. GET 初始 `enabled:false`；
  2. 提交 `{enabled:true, role:'both', clusterId:'gui-cluster', machineId:'local-machine', token:'gui-token', devices:[fake]}` →
     立即返回 `connected:true`、coordinator 在 8794 监听；`curl /health`、`GET /` 看板、`/v1/status` 均正常；
     `cluster.json` 自动写入（权限 0600），machine-claim 文件生成。
  3. 再提交仅 `{heartbeatMs:5000}`（不带 token）→ token 保留、coordinator 热重启成功（coordinatorId 变化）。
  4. 提交 `{enabled:false}` → 监听关闭（/health down）、claim 文件删除、状态回到 local；
     重置为默认 disabled 配置后删除旧 cluster-state.json。
- 结论：coordinator/client 的配置可完全通过 GUI 完成；CLI/JSON 仅作为运维自动化备用。

## V4 客户端：纯 GUI 集群配置（2026-10-24）

- `client.js` 8,948 → **9,953 行**：新增共享 `ClusterConfigModal`，入口为项目列表页 `⚙ 集群设置`
  （集群关闭时也可见）、工作区 `⋯` 菜单、集群弹窗「配置集群」；设置页保留只读集群状态。
- 表单覆盖 `enabled/role/clusterId/machineId/userId/instanceId/coordinatorId/url/listen/token/heartbeatMs/
  leaseTtlMs/devices(auto|手动)/priority/dashboard/allowMultipleCoordinators/claimDir/stateFile`；
  token 为密码框，留空保持已设置值，支持显式清除；状态卡展示 connected/blocked/claimConflict/error/
  pools/machines/activeLeases/warnings；按钮：保存并应用、关闭集群、重新加载、打开看板、复制协调器地址。
- 保存调用 `POST commands {type:'cluster.config'}`：Host 校验→原子写 `cluster.json`→**热重启 coordinator/client**，
  返回新 config/status；应用后刷新项目 state，集群芯片/弹窗立即生效；`cluster_busy` 本地化提示并保留对话框。
- 静态审计：746/746 zh/en keys、606 literal `t()` keys、全部 15 个 `--dsw-alias-*` 变量、无 JSX、只 `require('react')`；
  stub-React + fake-Host V4 harness 全部通过；`node --check client.js` 通过。
- 结论：协调器与 client 的启用/角色/地址/token/设备等配置可完全通过 GUI 完成，无需命令行、JSON 编辑或插件重载；
  刷新页面即可使用新 UI。

## V5 增补：scheduler 与 coordinator 语义修正（2026-10-24）

- Host 修复：scheduler/advisor 快照加入 cluster 段；默认与自定义 scheduler prompt 追加 two-layer authority；
  `resourcePools.gpu` 在集群模式作为项目 GPU 配额（`project_gpu_quota`）；`config.clusterPriority`（0–100）
  参与 coordinator 排队；auto `capacityFor` 在集群模式使用 coordinator free/配额。
- 恢复修复：planned + 残留 lease 的节点由 lease pump 先 renew 再带 lease 启动；失败则释放清理。
- 语义边界：集群模式下 GPU 节点的 follow-up 被拒绝（避免无租约运行），retry/escalate 改为新 attempt
  （新 session + 重新 acquire lease）。
- E2E（fake GPU / cluster enabled / gpuQuota=1）：
  - 失败 GPU 节点 retry → attempt 2 + lease → running；
  - GPU 已占时 retry 另一节点 → `project_gpu_quota`（held 1/1）；
  - Step scheduler run `run-7e0ad40b` 的 `inputSnapshot.cluster` 含 pools/free/quota/leases/authority；
    LLM 分析明确 "No GPU is claimed here; n-0004 will still have to acquire a whole-GPU lease..."，
    只启动 1 个节点（尊重 quota），coordinator 随后授予 lease；
  - 快照单测（node import）验证 cluster 段字段与 prompt 文案。
- UI（V5 client）：scheduler 提示词标签/说明改为「项目内实验调度提示词（不分配 GPU）」；新增
  「集群调度优先级（0–100）」设置（project.update config.clusterPriority，Host 0–100 校验）；集群状态/配置
  弹窗增加协调器权威提示；等待节点增加 "等待集群协调器发放整卡；项目 scheduler 无法预留 GPU"。
- `node --check client.js` 通过；client 9,989 行；locale 752/752；Host 自测 19/19。

## 能力边界澄清（2026-10-24）

- 明确"多机多节点"支持的边界并写入 docs/06 第 11 节与 README：当前 lease 机器亲和，
  coordinator 只做 GPU 准入/排队/用量，不做跨机 placement；一个实验节点不能跨机执行；
  单个 DAG 也不能跨 DSH 实例共享。
- 已支持：单机多节点并发、单节点本机多卡（needs.gpu:N）、多机独立项目共享 coordinator、
  同项目 merge 汇总；未支持：MPI/torch.distributed 多机作业、远程执行器、共享项目存储、
  K8s/Slurm provider。
- 替代方案与未来实现路径（Remote Runner / 共享 FS + out-of-process subagent / Slurm-K8s / 共享 DB）
  已记录在设计文档中，避免把"多机共享 GPU 使用权"误解为"多机协同执行一个任务"。


## V6 增补：远程 GPU 舰队（SSH + 容器 + NFS）与多机整卡 lease（2026-10-24）

### 交付

- cluster config 新增 `fleet`（机器列表：SSH/容器/设备/pathMap；placementMode local|fleet|auto；masterPort；
  全局 pathMap）；控制机 DSH 通过 SSH（或显式 devices）发现远程 GPU 并注册到 coordinator，GPU 机器无需安装 DSH。
- coordinator acquire 支持 fleet 请求：`{amount, machines, placement:'fleet'}`，跨在线机器做**整卡、跨机、
  全有或全无**的均衡分配（base/rem），不足则整个请求排队；lease 增加 `machines:[{machineId,deviceIds}]`；
  release/renew/usage 覆盖整组。
- runtime：`needs.machines>1` 或 placementMode=fleet → 先 acquire 多机 lease（项目 GPU 配额检查），
  写 worktree `.dshex-run/{manifest.json, runner.mjs, remote.sh, launch.sh, README.md}`；
  manifest 含每台机器 rank、CUDA_VISIBLE_DEVICES、远端 worktree、master 地址、容器信息；
  `.dshex-run/` 写入 git info/exclude，不进入 commit；worker prompt 追加远程执行说明与示例。
- 节点/状态：`node.lease.machines`、`lease.placement`、`node.remote`；needs 支持 machines；
  cluster status 增加 fleet 机器/设备/错误。
- GUI（V6 client 已完成，client.js 10,855 行）：Fleet 机器编辑器（SSH/容器/devices/pathMap/placementMode）、
  集群状态 fleet 表、节点 machines needs 编辑、远程舰队徽标与 lease/包装器面板；locale 819/819。

### 验证

- 新增 `scripts/cluster-fleet-selftest.mjs`（离线，无 DSH）：**6/6 通过**
  - 4 卡/2 机 fleet lease `amount=4,machines=2` → 跨两机 2+2 卡；
  - 容量不足的 `amount=2,machines=2` 整体排队；
  - 释放后排队请求自动获得 2 机 ×1 卡 lease；
  - GPU-秒 usage、renew、全部释放后 free=4。
- 真实 DSH E2E（fake 远端机器，控制机无 GPU；clusterId=fleet-test）：
  - 控制机注册 2 台 fleet 机器（各 2×fake A100，显式 devices，无需真实 SSH）；
  - 项目节点 `needs:{gpu:2,machines:2}`、quota gpu=2 → start 获得 `lease-b70bcbbd`，
    `lease.machines=[gpu-node-1:1卡, gpu-node-2:1卡]`，`node.remote.mode=fleet`；
  - worktree 生成 `.dshex-run/manifest.json`（rank0/rank1、CUDA_VISIBLE_DEVICES=0、master、NFS 路径）与
    `remote.sh`/`launch.sh`；worker 读取 manifest 并写 notes/fleet_check.md 后完成；
  - 节点完成后 lease 释放（coordinator leases=[]，free=4），usage 记录 ~49 GPU-秒；
  - `.dshex-run` 未进入 commit（`git ls-tree` 无该目录），`.git/info/exclude` 自动写入。
- 包装器静态/桩测试：`remote.sh` 生成 ssh + `docker exec -e CUDA_VISIBLE_DEVICES... -w <path> <container>`
  命令（本机用 `/bin/echo` 代替 ssh 验证参数）；runner.mjs `node --check` 通过。
- 真实 SSH/容器执行未在本机验证（本机无 SSH server/docker fleet）；已在部署文档中列出前置条件。

### 已知限制

- worker agent 仍在控制机；只有 GPU 命令通过 SSH/容器在远端执行。
- 依赖预先配置的 SSH key、容器和 NFS；pathMap 必须正确。
- lease 到期/释放不会自动 kill 远端 SSH 启动的进程；实验脚本需自行清理（后续可加 supervisor）。
- 项目 DAG 仍为单 DSH 本地存储；不支持跨 DSH 项目联邦、K8s/Slurm 编排、无 SSH 的远程执行。

## V7 增补：自然语言 GPU 节点分配诉求（2026-10-24）

### 交付

- `fleet.machines[].labels`（GUI 键值对，Host 小写化）；coordinator 注册/status/lease.machines 均携带 labels。
- 项目 `placementPolicy`：`{text, spec, compiledAt, explanation, warnings, compiler, summary}`；
  `project.compile_placement` 命令（规则式编译器 `host/placement.js`）。
- 编译器语义：必须/只能/唯一→require；优先/尽量→prefer；不要/排除→exclude；同机架（硬/软）→colocate/preferColocate；
  匹配 fleet 实际存在的机器标签、GPU 型号、machineId；未知短语→warnings。
- coordinator acquire 支持 `constraints`，fleet 分配按 require 过滤、prefer 排序、colocate/preferColocate 分组；
  不满足时整个请求排队并返回具体 reason。
- scheduler/advisor 快照包含 `fleetMachines`（labels/型号/空闲卡）、`placementPolicy`；prompt 说明机器选择由 coordinator 执行。
- GUI（V7 client 已完成，client.js 11,394 行）：项目设置自然语言策略编辑/解析预览/保存/清除；Fleet labels 键值编辑器；
  fleet 表与 lease 面板 labels 展示；locale 869/869。

### 验证

- 新增 `scripts/placement-selftest.mjs`（离线）：**9/9 通过**
  - 编译器：硬 A100+硬同机架、软 H100/NVLink/软同机架、排除 H100、不可用硬约束 warnings；
  - coordinator：硬 GPU 型号只选 A100 机器；软偏好优先 H100；标签 rack-a 过滤；不可满足要求 → queued
    `no-matching-machines`；全部释放后 free=8；规格摘要可用。
- 真实 DSH E2E（fleet：a100-1/a100-2 各 2×A100 rack-a nvlink；h100-1/h100-2 各 2×H100 rack-b）：
  - 项目设置自然语言“必须使用 A100；尽量同一机架” → compile 返回 require gpu=a100/gpuModels a100 +
    preferColocate rack，warnings 空；
  - 保存后节点 `needs:{gpu:4,machines:2}` 启动，coordinator 授予
    `lease.machines=[a100-1(2卡),a100-2(2卡)]`，labels 均为 rack-a/a100/nvlink；未选择任何 H100；
  - `.dshex-run/manifest.json` 含机器 labels；worker 读取并写报告确认“A100 + 同 rack + 4 卡 2 机”；
  - 节点完成释放 lease（usage 记录），`.dshex-run` 未进入 commit。
- 本机无真实 SSH/容器 fleet；fleet 执行路径用显式 devices + manifest/包装器验证，真实远端命令需在部署环境验证。

### 边界

- 规则词汇受限于 fleet 实际标签/型号；项目级策略（无节点级覆盖）；硬约束不满足只排队不降级；
  本地 placement 不经过 coordinator；复杂语义后续可加 LLM 编译 + 结构化规则手改。

## V8 增补：会话历史复用 DSH 原生 Conversation / Trajectory（2026-10-24）

### 交付

- Client 注入 `sessions` + `uiWorkspace`；新增 `openNativeSession`：
  - 解析 `node.sessionId`（回退 `attempts[].sessionId`）；
  - 写 `localStorage['dsh.conversation.<sessionId>']` 的 `view`（`trajectory`/`chat`，保留其它键）；
  - 调 `ctx.sessions.subagentAddress?.(id) ?? id` + `ctx.uiWorkspace.openSession(target)`；
- 节点卡片双击 / sealed 叶子“查看对话”直接打开原生轨迹；检查器新增“会话与轨迹（DSH 原生）”区域
  （轨迹/对话按钮、Session id、每次 attempt 的独立打开、developer-tools 提示）；
- 删除客户端自有 transcript 渲染：`useTranscript`、`TranscriptRow`、`TranscriptDrawer`、`fetchTranscript`、
  `ROUTES.transcript`、抽屉状态/轮询/样式全部移除；Host `/transcript` 端点保留给 agent tool；
- 新增“继续对话”弹窗：复用 needs/free 提示，通过 `node.message` 发送，保持 completed leaf & unsealed /
  running merge 条件，弹窗内不渲染 transcript；
- locale zh/en 键集一致（896/896），新增 `ws.native.*`；无自绘轨迹。
- 版本：host `0.8.5-v3`，package `0.7.0`，client 11,293 行。

### 验证

- stub-React + fake Client ctx harness（teammate 执行）：全部通过
  - 打开轨迹写入 `view:'trajectory'` 并调用 `openSession('sub:session-1')`，保留 localStorage 其它键；
  - 对话按钮写 `view:'chat'`；attempt 2 按钮打开 `sub:session-att-2`；卡片双击走同一 opener；
  - 无 Session 节点显示本地化错误“该节点还没有可打开的会话”；
  - 继续对话弹窗发送 `node.message {text}` 并显示“消息已发送”；running merge 也发送；
  - 断言不再存在 `rl-transcript-row`；无 console.error。
- 静态审计：`node --check client.js` 通过；无 `useTranscript`/`TranscriptDrawer`/`TranscriptRow`/
  `fetchTranscript`/`ROUTES.transcript`；注入列表/注册/ErrorBoundary 保留；theme token only、无 JSX/ESM。
- 浏览器视觉验证未执行（无浏览器自动化）；需要用户刷新页面后点击节点双击/检查器按钮确认原生轨迹标签。

### 未做的部分

- 原生会话输入框的只读限制未实现；继续对话仍推荐 Lab 弹窗。
- 打开原生视图会离开 Lab 主面板；返回依赖左侧 Lab 图标（DSH 原生导航行为）。
- Trajectory 标签依赖 DSH developer-tools 设置；Lab 只提示不修改全局设置。

## V9 增补：Windows 兼容性检查与修复（2026-10-25）

开发/验证机为 Linux，无法运行真实 Windows GPU/SSH/容器 E2E；以下为代码级修复 + 平台模拟验证。

### 修复

- **`host/runtime.js` 进程回收**：把 `/proc` 扫描限定为 Linux；新增平台事实
  `reaper/reaperSupported/reaperNote` 写入 `termination` 与事件（Windows 为 unsupported，依赖 DSH session jobs
  / job objects；macOS 为 best-effort）。Windows 使用 `process.kill(pid)` 分支；GPU 验证命令在 Windows 使用
  `nvidia-smi.exe`。
- **`host/cluster.js`**：本地 GPU 探测在 Windows 使用 `nvidia-smi.exe`。
- **`host/git-engine.js`**：Git 输出的 worktree 路径（正斜杠）与 Node 路径（反斜杠）比较前统一分隔符；
  Windows 大小写不敏感；修复 `removeWorktree` 无法匹配的问题。
- **`host/remote-run.js`**：生成跨平台 bundle：除 `.sh` 外新增 `remote.ps1`/`launch.ps1`/`remote.cmd`/`launch.cmd`
  和跨平台 `runner.mjs`；manifest 增加 `hostPlatform`/`nodePath`；prompt 按平台输出命令（PowerShell 单引号保留
  `$DSHEX_*` 给远端 bash 展开）；pathMap 统一分隔符/大小写；Windows 未映射的 `C:\\...` 远端路径明确报
  `fleet_path_map_required`。
- **self-tests**：`scripts/selftest.mjs` 改用 `MIRL_DEMO_REPO`/同级 demo repo、`os.tmpdir()` 替代 `/tmp`；
  fleet/placement selftest 的 stateFile 也用 `os.tmpdir()`。
- **GUI**：Fleet 路径映射提示补充 Windows 路径示例；presets 已有 `tool-pwsh`/`tool-bash` 平台切换，无需改动。

### 验证

- Linux 全量：`node --check` 所有 Host/Client/scripts 通过；`node scripts/selftest.mjs` **19/19**；
  `scripts/cluster-fleet-selftest.mjs` 6/6；`scripts/placement-selftest.mjs` 9/9。
- 平台模拟（child node 设置 `process.platform='win32'` 后调用 `prepareRemoteRun`）：
  - prompt 输出 `node .dshex-run/runner.mjs remote/launch` 与 PowerShell 包装器；
  - 生成 `remote.ps1`（`$PSScriptRoot` + 绝对 node 路径）、`remote.cmd`；
  - 未配置 pathMap 的 `C:/work/wt` 被 `fleet_path_map_required` 拒绝；`C:\\work → /nfs` 映射得到 `/nfs/wt`；
  - bundle 内 `runner.mjs` `node --check` 通过。
- **未验证**：真实 Windows 上的 DSH Host、PowerShell tool、任务回收、SSH/容器执行。建议在 Windows 目标机执行
  `node --check host/*.js client.js`、`node scripts/selftest.mjs` 与一个本地 demo 项目后上线。

### 版本

Host `0.8.6-v3`，package `0.8.0`，client 11,293 行。
