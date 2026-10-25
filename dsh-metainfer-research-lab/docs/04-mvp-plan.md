# 04 · MVP 范围、里程碑与验收

> 结论先说：**MVP 是「单人 + 单本地 Git 仓库 + 单父 DAG」的完整闭环** —— 能建项目、跑节点、让专家组生长、让调度器分配资源、
> 手动 Step / 自动挡推进、双击看每个 Agent 的对话、任何一步都能在 Git 里找到对应 commit。
> 多父汇合、真实 GPU 隔离、成本级 token 预算等留 v2。

---

## 1. MVP 范围

### 1.1 做（In scope）

| 模块 | 内容 |
|---|---|
| 项目 | 绑定本地 Git 仓库（必须校验通过）；研究目标 brief；资源池；并发/节点上限；**默认执行时限（默认 10min）+ 单节点上限（4h）**；三个角色模型配置；提示词覆盖；自动挡预算 |
| DAG | 节点创建（根节点 / 专家组 / 用户手动）、**单父**多子分叉、父子关系、封存（派生 + tag）、取消、状态机；节点含 `proposed`（待确认）与 `planned`（已批准）两态 |
| 节点 | 提示词执行前可编辑；资源需求；完成标准；**每节点执行时限（默认 10min，创建时可改）**；报告（结构化）；失败与重试 |
| Git | 每节点独立 worktree + `dshex/...` 分支；完成自动 commit；封存打 tag；base/head commit 与 diffstat；worktree 清理入口（v1.0 可放设置里） |
| worker | 每个节点一个 subagent 会话；单任务、完成即停；结构化报告；未封存叶子可继续对话；完成后自动 commit |
| advisor | 每个 cycle 一次一次性激活；扫叶子 + 2 级祖先；输出 schema + Host 校验；**两种接入模式**：`auto`（直接创建 planned 并封存父节点）或 `confirm`（创建 proposed，等人批准；不阻塞其他节点） |
| scheduler | 每个 cycle 一次一次性激活；资源池 + `maxRunningNodes` 内决定启动；只从 **planned（已批准）** 中选；Host 硬校验 |
| 人工确认 | `advisor.acceptMode='confirm'` 时，新提案进入「待确认」队列；批准 → planned + 封存父节点；拒绝 → 删除提案（父节点不受影响）；**待确认节点不阻塞任何已建立节点的执行** |
| 编排 | 手动挡 Step（advisor pass + scheduler pass）；自动挡（事件触发 + 定时兜底 + 冷却 + 预算 + 空转/错误熔断 + 暂停原因 + 继续/停止）；自动挡只等待确认、不阻塞其他分支 |
| 持久化 | storageDomain 全量状态 + 事件日志；重启后自动挡暂停；running 节点 reconcile |
| UI | 侧栏图标 + 全屏面板；DAG 画布（平移/缩放/选中/路径高亮）；节点检查器；对话抽屉；活动日志；运行详情；新建项目向导；设置；亮/暗主题；中英双语 |
| 运维 | 错误横幅、连接退避重试、子代理容量告警、sandbox 只读检测、ErrorBoundary |

### 1.2 不做（Out of scope，明确写入 MVP 边界）

| 不做 | 原因 / 去向 |
|---|---|
| 多父节点汇合（merge 语义） | MVP 单父树；**未来融合是必然的**，v2 做 `parentIds[]` + 底层 git branch merge。落地顺序：先提供「交互式 merge Agent（人在环路）手工合并」→ 再逐步自动化。详见 01 §12 |
| 专家组多 Agent 对抗 | MVP 单 advisor；v2 加 `reviewers: N` + 汇总。**每个 reviewer 可配置不同的 provider/model 与视角**，以规避单一模型盲区 |
| 真实 GPU 隔离 / 容器 / 远程执行器 | MVP 的 `needs` 是调度账本；v2 接 nvidia-smi/cgroup/容器 |
| token 级成本预算 | MVP 用 cycle/节点/时长三重预算；v2 从 session 日志聚合 |
| 远程仓库 / push / PR | MVP 只在本地 commit + tag；v2 支持 push 与 PR 审阅 |
| 节点级环境（conda/镜像/数据挂载） | v2 |
| DAG 拖拽编辑 / 手动连边 | MVP 只能通过「添加后继」生长 |
| 多用户 / 协作 / 权限 | 单用户单进程 |
| 失败节点自动重试 | 避免自动烧钱；用户手动重试 |
| worker 后台任务管理（jobs） | 节点任务要求在 timebox 内跑完；长训练 v2 |
| 移动端 / 窄屏适配 | 保证 ≥1024px |
| 一键推送/分享 DAG 报告 | v2 |

### 1.3 默认参数（都可在项目/插件配置里改）

| 参数 | 默认值 | 说明 |
|---|---|---|
| `resourcePools` | `{ gpu: 1 }` | 资源池；键任意，Host 只做加总校验 |
| `maxRunningNodes` | `4` | 同时运行的节点上限（真正约束并发的是它和资源池；`maxActiveSubagents` 按树计，不构成瓶颈） |
| `maxNodes` | `60` | 项目节点总数上限（硬上限） |
| `nodeTimeoutMs` | `10min` | 节点默认硬超时；到点由 Host watchdog **确定性终止**（不是 Agent 决定） |
| `maxNodeTimeoutMs` | `4h` | 单节点可选择的执行时限上限 |
| `timeoutSweepMs` / `timeoutWarningRatio` | `1000` / `0.8` | watchdog 扫描周期 / 剩余 20% 时软提醒 worker |
| `advisor.maxProposalsPerPass` | `3` | 每个 cycle 最多采纳的提案数 |
| `advisor.acceptMode` | `'auto'` | `'auto'` 直接进入 planned；`'confirm'` 先进入 proposed 等人工批准（不阻塞其他节点） |
| `advisor.maxPendingProposals` | `20` | 待确认提案上限；达到后 advisor pass 暂停产新提案 |
| `advisor.ancestorDepth` | `2` | 专家组可回看祖先的层数 |
| `auto.maxCycles` | `50` | 自动挡最大 cycle 数 |
| `auto.maxWallClockMs` | `6h` | 自动挡最长运行时间 |
| `auto.idleCycleLimit` | `3` | 连续无进展熔断阈值 |
| `auto.debounceMs` / `cooldownMs` | `1500` / `5000` | 事件去抖 / 专家组冷却 |
| DSH `maxActiveSubagents` | `8`（DSH 默认，Settings → Subagent 可调） | **每棵 activation 树**的子代理容量；本设计 worker 各挂 node anchor、advisor/scheduler 挂 controller，因此通常不是瓶颈 |
| 默认角色模型 | 继承 `agentDefaultModel` | 可在项目配置里按角色覆盖 |

### 1.4 MVP 的「完成」是什么（一句话）

在真实仓库上，用户点几次 Step 或开启自动挡后，能看着 DAG 从 1 个根节点长成一棵有分叉的实验树；
每个节点都有独立 worktree、可回看的 Agent 对话、可核对的 commit/tag；资源约束始终不被突破；
整条路径可以按 Git 与 DAG 双向审计。

---

## 2. 交付物

```
dsh-metainfer-research-lab/
  package.json                 # bundle patch(数组) + client 声明 + exports/files
  cordis.patch.yml             # 宿主插件行
  presets.patch.yml            # 4 个 preset 行（worker/advisor/scheduler/controller）
  index.js                     # Host apply / inject / 路由 / 生命周期
  host/*.js                    # domain, git-engine, orchestrator, node-runner,
                               # advisor, scheduler, snapshot, prompts, http, commands
  client.js                    # Client 面板（或由 client/src/*.js 拼接）
  locale/zh.json locale/en.json
  icon.svg
  docs/                        # 本设计包
```

安装方式（实现完成后）：在 Web GUI 的 Plugins → 添加 → 安装本地 bundle 目录（`plugin_manager install_bundle`，
需要用户审批）；安装后侧栏出现 MetaInfer Research Lab 图标。

---

## 3. 里程碑

> 估时按「熟悉 DSH 插件 + 前端」的 1 名工程师，含自测；不含用户确认与真机调优。

### M0 · 骨架可安装（0.5–1 天）✅ 已完成（2026-10-23）

- [x] `package.json`（`dsh.bundle.patch` 数组 + `dependencies.zod`）/ `cordis.patch.yml`（宿主插件行）/ `presets.patch.yml`（**5** 个 preset 行）/ `index.js` / `client.js` / `locale` / `icon.svg`
- [x] 在本目录 `pnpm install`（装好 `zod`；本地链接安装不会替我们装依赖；store 指向工作区）
- [x] `ctx.effect` 注册 `ctx.connection.fetch.register` 的 `/api/metainfer-research-lab/{health,projects}`（projects 为 GET+POST 同一路由）
- [x] `ctx.storageDomain.open` 成功（domain 名 `metainfer_research_lab`，per-record；M0 表 schema 先用 permissive，v2 换 typed）
- [x] 安装 bundle：`application: applied`、无 warnings；插件行与 5 个 preset 行 `fiberPhase=active`；侧栏图标与 `main` 面板槽位 active
- 验证记录：[docs/05-verification.md](05-verification.md)；浏览器视觉待用户刷新后点图标确认

### M1 · 项目 + DAG 数据 + 画布（1.5–2 天）✅ Host/Client 已实现（2026-10-23）

- [x] `ProjectStore`（projects/nodes/events、`__` key、per-project 锁、revision、事件保留）
- [x] `GitEngine` 的 repo 校验（rev-parse / bare / branches / 默认分支 / baseCommit / dirty）
- [x] 新建项目向导（仓库验证、分支选择、brief、根节点提示词、资源池、并发/节点/超时设置）
- [x] state / events / commands 路由 + Client 轮询（revision 短路、visibility、退避）+ 错误处理
- [x] DAG 画布：分层布局、节点卡片、边、选中、平移/缩放/适应画布
- [x] 检查器只读 + 提示词/完成标准/执行时限编辑（planned）
- [x] Host 离线自测 17/17 通过（`scripts/selftest.mjs`），HTTP envelope 契约覆盖
- [ ] 用户浏览器端到端确认（刷新页面 → 创建 demo 项目 → 编辑节点 → 刷新持久化）
- 验证记录：[docs/05-verification.md](05-verification.md)（M1 章节）

### M2 · 节点执行 + Git 版本绑定（2–3 天）

- [ ] controller agent 创建/冷恢复（`agents.create` + `agents.resume` + preset mount）
- [ ] `NodeRunner.start`：校验 → 预留资源 → `git worktree add` → `startActivation(lab-worker, cwd=worktree, outputSchema)`
- [ ] 完成回调：分支校验 → commit → headCommit/report → 释放资源 → 事件 → 自动循环唤醒
- [ ] **Watchdog / Reaper**：deadline 注册 + 每秒墙钟扫描 + 确定性终止序列（cancel/dispose → jobs → /proc 进程 → nvidia-smi → finally 释放资源 → 验证）
- [ ] 每节点 `timeboxMs`（默认 10min，创建/编辑/批准节点时可改，上限 4h）+ 软提醒 + 超时失败落账
- [ ] 失败/超时/取消路径；commit 身份兜底；worktree 复用（崩溃恢复）
- [ ] 对话抽屉：transcript 路由（`sessionQuery` 读取 + 精简行）、增量轮询、工具调用折叠、报告卡片
- [ ] 继续对话：`sendMessage` → 监听 `turn/end` → 再 commit → 更新 reportText/followUps
- 验证：手动启动根节点 → worker 改文件 → 自动 commit → 节点 completed → 双击看对话 → 继续对话产生第二个 commit。

### M3 · 专家组 + 调度器 + 手动 Step（2–3 天）✅ 已实现并 E2E 验证（2026-10-23）

- [x] 三个角色 preset 真跑通（worker/advisor/scheduler；controller 不参与任务）
- [x] 快照构造（叶子 + 2 级祖先 + 资源 + 最近/待确认提案；截断规则）
- [x] advisor/scheduler activation + `outputSchema` + 结构化输出解析 + 180s 超时
- [x] Host 校验与落地：parent/标题/prompt/needs/timebox/去重/`maxNodes`、封存顺序（commit 父 → 写子 → tag+sealedAt）
- [x] `acceptMode='confirm'`：proposed 创建 / 批准（封存父）/ 拒绝（删除）/ 编辑；审批期间父节点保持可对话
- [x] 调度器校验与落地：资源账本、并发上限、逐项启动与拒绝记录（只从 planned 中选）
- [x] `Orchestrator.runCycle` + Step 按钮 + 运行记录/详情 + 活动日志
- [x] 修复：同一 pass 多提案误拒、proposed 子节点误判 sealed
- 验证记录：[docs/05-verification.md](05-verification.md)（M3 章节）；真实 Step 创建/封存/启动节点通过

### M4 · 自动挡 + 恢复 + 打磨（2 天）✅ 已实现并 E2E 验证（2026-10-23）

- [x] 自动挡（2s 扫描 + cycle 互斥；budget/暂停原因；审批后唤醒）
- [x] `waitingConfirmation`：只剩待确认提案时等待人工，运行中/已批准节点继续执行；批准后自动继续
- [x] 预算与暂停条件（maxCycles/maxWallClock/maxNodes/noProgress/idle/errors；重启后 paused）
- [x] 重启恢复：running reconcile → failed(restart)、资源释放；自动挡 hostRestarted 暂停
- [x] confirm 模式 + 设置面板（资源/模型/提示词/自动预算/默认时限/acceptMode）
- [x] 超时链路 E2E：到点确定性 kill → 回收验证 → failed(timeout)
- [x] `lab-gc` preset + 异步善后 postmortem（GC 不参与 kill、不阻塞资源释放）；GC run 记录与 UI
- [ ] 默认提示词打磨、亮暗主题人工检查（浏览器确认待做）
- [x] 验收清单 23–26 的记录已写入 `docs/05-verification.md`
- 验证：自动挡 2 个 cycle 后 maxCycles 暂停；confirm 等待→批准→唤醒；GC 成功产出 postmortem

**合计约 8–11 个工作日。**

---

## 4. 验收场景（手工 E2E 清单）

| # | 场景 | 期望 |
|---|---|---|
| 1 | 未绑定 git 路径就创建项目 | 创建按钮禁用 / Host 返回明确错误，不产生项目 |
| 2 | 在真实仓库创建项目 | 根节点 planned；`baseCommit` 等于项目创建时记录的 commit |
| 3 | 启动根节点 | 对应 worktree 目录与 `dshex/...` 分支出现；节点 running；节点会话不显示在 DSH 侧栏，但面板能打开 transcript |
| 4 | worker 正常结束 | 节点 completed；worktree 有 commit；UI 显示报告与 headCommit；资源释放 |
| 5 | 双击未封存叶子并继续对话 | 抽屉可输入；新 turn 结束产生新 commit；节点仍为叶子；review 标记清空；follow-up 不要求 structured_output |
| 6 | Step（有活跃叶子） | advisor 运行、创建后继节点；父节点**封存**：tag 存在、抽屉只读、`node.message` 被拒 |
| 7 | 资源约束 | `gpu=2`、3 个 gpu 节点 planned → 只启动 2 个；第 3 个等待；释放后下一 cycle 启动 |
| 8 | 调度器选择不启动 | 返回 `starts:[]` 合法；node 保持 planned；无报错 |
| 9 | advisor 输出非法 | run 记 failed / 部分拒绝；不创建非法节点；活动日志可见原因 |
| 10 | 自动挡跑 2–3 代 | 自动创建并启动后继；顶栏计数变化；达到预算/空转时暂停并显示原因 |
| 11 | 重启宿主（重载插件） | 自动挡 paused（hostRestarted）；节点/事件/对话完整；running 节点被 reconcile；可手动继续 |
| 12 | worker 失败 | 节点 failed；资源释放；启动阶段失败重试 → 回 planned 重跑；已有会话失败重试 → 继续对话；错误可见 |
| 13 | Git 历史审计 | `git log --all --graph --decorate` 能看到每个节点的分支与封存 tag；tag 指向 UI 记录的 headCommit |
| 14 | 两个项目并行 | 状态互不串扰；资源账本各自独立 |
| 15 | 主题/语言 | 亮暗主题均正常；中英文切换后侧栏 label、面板文案同步 |
| 16 | 封存节点双击 | 抽屉只读、无输入框、显示封存横幅 |
| 17 | 达到 maxNodes | advisor 提案被拒；自动挡暂停并提示 |
| 18 | 页面隐藏/恢复 | 轮询暂停/恢复，数据自动刷新；自动挡继续在 Host 运行 |
| 19 | confirm 模式：提案不阻塞 | 自动挡运行中产生 proposed 节点；已批准/运行中的节点继续执行不受影响；只剩 proposed 时进入 `waitingConfirmation` |
| 20 | confirm 模式：批准 | 批准后父节点被 commit + tag 封存，提案变 planned，下一 cycle 可启动；审批期间对父节点的继续对话不会被悄悄丢弃（批准时重算 baseCommit 并提示） |
| 21 | confirm 模式：拒绝 | 提案记录删除，父节点保持未封存、可继续对话；不产生 Git 分支/worktree |
| 22 | 模型盲区规避（v2 预留） | 配置多个 reviewer + 不同模型时，各 reviewer 独立输出，Host 汇总去重（v2 验收） |
| 23 | 默认 10 分钟硬超时 | worker 故意挂死超过 10min → watchdog 到点自动终止；节点 failed(stage=timeout)、资源释放；**不询问任何 Agent**；其他节点不受影响 |
| 24 | 创建节点时选执行时间 | 节点创建/编辑/批准时可选 5/10/30/60/自定义分钟；deadline 正确；超过 `maxNodeTimeoutMs` 被拒绝 |
| 25 | 确定性 kill + 回收验证 | worker 留下后台进程/占用模拟 GPU → 终止后 `/proc` 无 worktree 下 PID、该会话 jobs 清空、resourcesHeld 释放、nvidia-smi 无匹配 PID；故意制造 kill 失败 → 项目 needsAttention + 自动挡暂停 |
| 26 | GC 善后 | 超时终止后异步 GC 生成 postmortem；下一轮 advisor 快照可见 timeout 信息与 postmortem，并能决定拆小/延长/换路/放弃 |

---

## 5. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| DSH API 版本漂移（本设计基于 0.2.1-rc.2 源码） | 高 | 实现前用 `cordis_inspect_query` 复核每个要用的 Service/Event；可选服务放 `inject`；安装后先跑 M0 冒烟 |
| **sandbox 边界依赖 per-node anchor** | 高 | subagent 子会话的 header.cwd 继承 parent，`request.cwd` 只改 workingDirectory 投影；若直接挂 controller 会导致可写边界是 repoRoot。用 anchor（root Agent，cwd=worktree）隔离，并在启动后断言 `child.session.header.cwd === worktreePath`；M2 第一件事就是验证这条 |
| anchor/controller 会话管理变复杂 | 中 | 每节点 1 个 anchor + 1 个 worker 子会话，都隐藏；会话 id 预分配并持久化，崩溃后可 `agents.resume` 恢复；实现上把「确保 live」收敛成一个 `ensureAgentLive(sessionId, cwd, preset)` |
| `maxActiveSubagents` 默认 8 | 低 | 每棵 activation 树独立限额：worker 各自挂在 node anchor 下只有 1 个子级，advisor/scheduler 在 controller 树里最多 2 个；真正限制是 `maxRunningNodes` 与资源池。仍捕获 `ACTIVATION_LIMIT_REACHED` 并保留 planned |
| 插件直接跑 git（无 sandbox/审批） | 中 | 只有插件代码执行 git；worker 被禁止 git 写并做分支校验；文档标明这是信任边界 |
| worker 不遵守「不 commit / 不越界」 | 中 | 提示词强约束 + 完成时校验分支与 worktree + 违规判 failed |
| Host 依赖 `zod` 的解析 | 中 | bundle `dependencies` 声明 zod；本地链接安装先 `pnpm install`；M0 冒烟验证 `storageDomain.open` 成功。若安装器无法装依赖，退回「手写 schema-like `.parse` 校验对象」的临时方案（仅写此兜底，不默认采用） |
| 自动挡成本失控 | 高 | 三重预算 + 暂停原因 + 重启默认暂停 + 切自动确认；默认值保守 |
| confirm 档：提案与批准之间父节点基线漂移 | 中 | 提案记录父 headCommit；批准时重算 headCommit，UI 提示「基线已更新」；父节点正在运行时拒绝批准（提示稍后重试） |
| confirm 档：待确认提案堆积 / 人反馈慢 | 低 | proposed 不占资源、不参与调度、不阻塞其他节点；`maxPendingProposals=20` 后 advisor 暂停产新提案并提示；自动挡进入 `waiting` 而非空转 |
| 崩溃/竞态导致状态不一致 | 高 | 项目互斥锁 + 三段式 cycle + 派生 sealed + git 操作幂等 + 启动 reconcile；所有 mutation 走单一路径 |
| worktree 磁盘持续增长 | 中 | 文档提示；设置里提供「清理已取消/已删除节点的 worktree」；tag/branch 保留历史 |
| 模型不按 schema 输出 | 中 | structured_output 校验 + 文本兜底 + 失败可见；advisor/scheduler 最多重试 1 次（v1.1） |
| 子会话在侧栏造成干扰 | 低 | controller/anchor/worker 会话都以 `origin:'subagent'` 创建，DSH 侧栏不显示；用户从 MetaInfer Research Lab 面板进入 |
| 预设出现在普通会话的 preset 选择器 | 低 | 描述写「请勿手工选择」+ order 90+；v2 可改运行时注册 |
| 根作用域面板拿不到 Session 上下文 | 低 | 面板完全自带状态，不依赖 conversation props |
| Client 无第三方库 | 低 | 自研 SVG 布局；节点 ≤100 时性能足够；超大 DAG 的虚拟化 v2 |
| 封存节点的原生会话入口 | 低 | 所有节点/控制器会话都以 `origin:'subagent'` 创建，DSH 侧栏不显示，用户只能从 MetaInfer Research Lab 面板进入；面板与 Host API 双重校验。M4 仍加 `session/event` 告警兜底（封存节点若出现新用户消息则记录违规） |
| 长训练任务超时 | 中 | 默认 10min 硬超时；需要长的节点在创建时显式选更长 timebox（上限 4h）；v2 支持长任务与后台 job |
| **超时终止不够干净（残留进程/GPU）** | 高 | 终止序列 = cancel/dispose Agent 树 → kill jobs → `/proc` 扫描 worktree 进程 SIGTERM/SIGKILL → `nvidia-smi` 验证 → 资源释放放 `finally`；验证失败标 `needsAttention` 并暂停自动挡；GC agent 只做善后与请求确定性清理（I13–I15） |
| **Host 事件循环整体卡死** | 中 | L2 watchdog 在进程内，若事件循环卡死则无法自救；MVP 明确列为运维层 v2（外部 supervisor 心跳 + 重启 Host），不假装已解决 |
| **进程/GPU 回收的跨平台差异** | 中 | Linux（/proc + nvidia-smi）为 MVP 主路径；macOS 用 `lsof`/`ps` best-effort；回收失败一律 `needsAttention`，不静默 |

---

## 6. 测试策略

1. **Host 单元测试**（node --test，零依赖）：快照构造、advisor/scheduler 校验函数、资源账本、状态机迁移、去重哈希、prompt 渲染。
2. **GitEngine 测试**：在临时目录 `git init` 造仓库，覆盖 worktree add/commit/tag/复用/清理/身份兜底。
3. **集成测试**：用真实 DSH + 便宜模型（deepseek-flash）在玩具仓库跑 M2–M4 的验收场景；脚本化 curl 调 `/api/metainfer-research-lab/commands`。
4. **静态检查**：`node --check` 所有 JS；`package.json` / patch YAML 解析；locale 键集合一致性；icon 为合法 SVG 且 < 256 KiB。
5. **手工验收**：§4 清单逐条记录到 `docs/verification.md`，附截图/命令输出。

---

### V1 · 打磨与运维（MVP 收尾）

1. ✅ 项目删除（含可选 worktree 清理；Git 分支/tag 默认保留）
2. ✅ 失败节点重试（无 session → 回 planned 重启；有 session → 带错误上下文的 follow-up）
3. ✅ worktree 清理入口、事件保留、孤儿会话清理
4. ✅ 安装/升级/重载说明、demo 数据、验证记录与已知限制
5. ✅ 更多离线自测（19/19）与真实 E2E 复盘（记录见 05-verification.md V1 章节）

### V2 · 研究能力扩展

1. ✅ **多父 merge 节点**：`parentIds[]` + 底层 git branch merge；Host 创建 merge worktree 并尝试合并，
   冲突时启动**交互式 merge Agent（人在环路）**——用户在对话抽屉确认取舍，点「完成合并」由 Host 校验
   `git diff --diff-filter=U`、自动 stage 已解决文件后提交 merge commit；parents 在创建时封存。E2E 通过。
2. ✅ **异构模型对抗评审**：`advisor.reviewers[] = {lens, provider, model, reasoningEffort?}`（≤4）；Host 并行运行多视角 reviewer，
   汇总去重后落地；`acceptMode='confirm'` 作用于汇总结果。E2E 双 lens panel 通过。
3. ✅ **token 预算**：从会话事件聚合节点/角色 token 用量，项目级 `auto.maxTokens` 触发 `paused/maxTokens`。E2E 通过。
4. ✅ **远程协作**：`project.push` 推送实际存在的 `dshex/*` 分支与 `dshex-sealed/*` 封存 tag（PR 式审阅的底座）。E2E 通过。
5. 保留在路线图：真实 GPU 隔离/容器、DAG 拖拽编辑、多仓库、交互式 merge 的多冲突分步策略。

---

### V3 · 扩展（已实现，2026-10-23）

1. ✅ **轻量多实例整卡 GPU 协调器**：DSH 内嵌 coordinator（HTTP+JSON、Bearer token、机器/实例注册心跳、
   lease/队列/FIFO+priority、TTL reaper、GPU-秒 usage）；Host 先租后跑、排队 `resourceWait`、续约/断约终止、
   重启 releaseAllMine+reconcile；auto `awaitingGpu`。多机/多实例经 HTTP 接入；无 Slurm/K8s。
2. ✅ **节点级模型/推理强度**：`modelOptions`+角色默认+allowlist，`GET /models` 目录与价格；
   节点 `model/modelResolved/attempts`；手动 `node.escalate`/`node.retry {model|upgrade}`；自动升级开关
   （`routing.autoUpgrade`，受 maxAttempts 与 `auto.maxCostUsd` 约束）。
3. ✅ **成本**：按 modelOptions 单价计算 attempt/node cost，`auto.maxCostUsd` → `paused/maxCost`。
4. ✅ 运维层：coordinator 内置看板、CLI `scripts/cluster-status.mjs`、`GET /v1/status`、
   `clusterId` 校验、state 文件锁、machine claim 三道多协调器防护。
5. ✅ **纯 GUI 配置**：`GET /cluster/config` + `commands cluster.config`（Host 校验/持久化/热重启），
   项目列表页、工作区菜单、集群弹窗均可打开配置表单；token 掩码、只读状态、activity 预警；无需命令行/JSON/插件重载。
6. 后续：跨机执行（远程 provider/共享 FS）、配额/审计/抢占、容器/MIG 强隔离、GPU-秒计费面板、coordinator HA/leader election。

设计、实现映射、验证与限制见
[docs/06-multi-tenant-and-model-routing.md](06-multi-tenant-and-model-routing.md) 第 8 节与
[docs/05-verification.md](05-verification.md) V3 章节。

---

## 7. 已确认决策（2026-10-23）

| # | 议题 | 结论 |
|---|---|---|
| 1 | **命名** | 插件/仓库命名 **`dsh-metainfer-research-lab`**；面板标题「MetaInfer Research Lab · 科研实验台」；Host 服务 `ctx.metainferLab`；HTTP 前缀 `/api/metainfer-research-lab`；storage domain `metainfer_research_lab` |
| 2 | **多父汇合** | MVP 保持**单父**；但**融合是必然方向**：v2 支持一个节点多个父节点，对应底层 git branch 的 merge。落地路径：先做**交互式 merge Agent（人在环路）手工合并**（冲突/取舍由人确认），再逐步自动化。见 01 §12 |
| 3 | **专家组对抗评审** | MVP 单 advisor；v2 支持多 reviewer 对抗，**每个 reviewer 可配置不同 provider/model 与不同视角**，避免单一模型盲区；Host 汇总去重后落地 |
| 4 | **自动挡预算 + 人工确认档** | 预算 50 cycle / 6h / 60 节点确认；**新增「新节点人工确认」档**（`advisor.acceptMode='confirm'`），且**等待人工确认的节点不阻塞其他已建立节点的执行**（人反馈慢，不能卡住流水线） |
| 5 | **worker 联网** | 允许 `web_search`/`web_fetch`（preset 里保留 tool-web）；项目级 v2 可关 |
| 6 | **演示/验收仓库** | 新建一个最小 ML 实验仓库：`<workspace>/metainfer-demo-repo/`（纯 stdlib 的线性回归/SGD 小实验，支持 lr/ridge/seed 扫参；已 `git init` + 初始 commit），不污染 `battle-city` |
| 7 | **超时与资源回收** | 默认硬超时 **10 分钟**；创建节点时可选 5/10/30/60/自定义分钟（上限 4h）。**超时杀死由 Host 脚本确定性执行，不经过 Agent**：cancel/dispose Agent 树 → kill 会话 jobs → `/proc` 回收 worktree 下进程 → `nvidia-smi` 验证 GPU → `finally` 释放资源 → 验证无残留。杀完后异步 **lab-gc 善后 Agent** 做 postmortem / 请求确定性清理；专家组看到 timeout 失败后自行决定拆小、延时、换路或放弃 |
| 8 | **confirm 档默认与节流** | 默认 `acceptMode='auto'`；`confirm` 档用 `maxPendingProposals=20` 做节流（达到后 advisor 暂停产新提案），均确认 |

**无剩余阻塞项**：全部关键决策已确认，可以开始 M0 实现。
默认验收模型 `deepseek-flash`、默认 10min 超时；如需更保守的模型/预算可在项目设置里改。

---

## 8. Definition of Done

- [ ] 安装后侧栏出现图标，点击进入全屏面板，无 console 错误
- [ ] §4 验收场景 1–26 全部通过并记录（含 confirm 档 19–21、确定性超时/GC 23–26）
- [ ] 自动挡连续运行 ≥ 2 代后能按预算/空转正常暂停，且重启后不自动恢复
- [ ] 每个节点在 Git 中有可定位的 commit；封存节点有 tag；UI 的 headCommit 与 `git rev-parse` 一致
- [ ] 节点封存后：会话不可再输入（API 拒绝 + UI 只读）、worktree 不再变化
- [ ] 资源账本在任意时刻不超发（脚本注入并发启动请求验证）
- [ ] 超时硬杀链路：默认 10min 到点必杀、无残留进程/job/GPU、资源必释放、GC postmortem 可见
- [ ] 亮/暗主题、中英文、1024px 宽下布局正常
- [ ] 文档：README + 4 篇设计文档 + 实现后的 `verification.md`
- [ ] 插件元数据（title/description/icon/locale）在插件管理页正确显示
