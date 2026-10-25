# DSH MetaInfer Research Lab · 科研实验台（MVP 设计）

> 把 DeepSeek Harness 从「通用编码 Agent」变成「自动做研究探索、迭代优化的实验平台 IDE」。
> 本仓库当前只包含 **MVP 设计文档**，尚未实现代码。

## 一句话

一个 DSH 插件：用 **动态 DAG** 组织科研实验，每个节点 = 一段可编辑的实验指令 + 一个独立 git worktree + 一个 subagent 会话；
**专家组 Agent** 负责审视结果并生长 DAG，**调度 Agent** 负责在有限资源（如 GPU）下决定哪些节点先跑；
用户在 Web GUI 里以 **手动挡（Step）/ 自动挡** 两种节奏推进实验，并把整条迭代路径留在 Git 历史和 DAG 里。

## 核心循环

```
                    ┌──────────────────────────────────────────────┐
                    │ 专家组 Agent（评审/导师）                     │
                    │ 看叶子 + 最近祖先 → 提议新的后继节点（prompt） │
                    └───────────────┬──────────────────────────────┘
                                    │ 创建 planned 节点 / 冻结父节点
                                    ▼
  用户 Step / 自动挡 tick ───►  调度 Agent（资源调度）
                                    │ 在 GPU/并发上限内挑选可启动节点
                                    ▼
                    ┌──────────────────────────────────────────────┐
                    │ 节点执行：git worktree + subagent 单任务会话   │
                    │ 完成 → 自动 commit → 资源释放 → 回到专家组     │
                    └──────────────────────────────────────────────┘
```

## 文档索引

| 文档 | 内容 | 适合谁 |
|---|---|---|
| [docs/01-architecture.md](docs/01-architecture.md) | 目标、不变量、总体架构、数据模型、节点状态机、Git 版本绑定、存储/并发/安全 | 想理解「系统为什么这样设计」 |
| [docs/02-agents-orchestration.md](docs/02-agents-orchestration.md) | 三类 Agent（worker/advisor/scheduler）、提示词、结构化输出、手动/自动挡编排、预算与失败处理 | 想改提示词或编排策略 |
| [docs/03-ui-spec.md](docs/03-ui-spec.md) | 界面信息架构、DAG 画布、节点检查器、对话抽屉、模式开关/Step、空状态、视觉规范 | 想做前端/交互 |
| [docs/04-mvp-plan.md](docs/04-mvp-plan.md) | MVP 范围（做什么/不做什么）、里程碑、验收场景、风险、待拍板问题 | 想排期或验收 |
| [docs/06-multi-tenant-and-model-routing.md](docs/06-multi-tenant-and-model-routing.md) | V3 设计与实现：轻量多实例整卡 GPU 协调器、节点级模型/强度、成本预算；第 9 节为协调器使用/可视化/多协调器治理手册 | 想部署集群或做模型路由 |
| [cluster.example.json](cluster.example.json) | 协调器/client 配置样例（默认关闭） | 部署多机共享 GPU |

## 设计结论速览（TL;DR）

1. **插件形态**：一个 bundle（Host + Client 两半）。Host 是新服务 `ctx.metainferLab` + `presets.patch.yml` 里声明的
   4 个 Agent preset（worker/advisor/scheduler/controller）+ 一组 `ctx.connection.fetch` 数据路由；Client 在 DSH Web GUI 的
   `sidebar.panellist` 加一个图标，在 `main` 槽注册一个全屏面板 `main#metainfer-research-lab`（两者用同一个 id 关联）。
2. **节点 = git worktree + subagent 会话**：worktree 由插件用 `git worktree add` 管理（**不用** DSH 自带
   `ctx.worktrees`，因为它会移动调用者会话的 cwd 且只支持创建）。DSH 的 sandbox 边界取 `session.header.cwd`，
   而 subagent 子会话的 header.cwd 继承 parent，所以每个节点先建一个 **cwd=worktree 的 node anchor Agent**，
   再在它下面用 `ctx.subagents.startActivation({provider:'spawn', request:{cwd:<worktree>, parent:<node anchor>, prompt, agentPreset:'lab-worker', outputSchema}})` 创建 worker。
3. **完成信号**：`await activation.result`（含 `structured` 与 `stopReason`）；`subagent/end` 事件只有 stopReason，仅作观测。
   继续对话的完成信号是 durable `turn/end`（只认 `reason.kind==='completed'`）。完成后 Host 自动 commit worktree，把报告写入节点记录。
4. **权威状态在 Host**：项目/DAG/节点/运行记录存 `ctx.storageDomain`；Git 仓库保存代码历史；Agent 的输出只是「提案」，
   必须经过 Host 的 schema + 业务规则校验才能变成节点或启动动作。
5. **资源约束是硬校验**：调度 Agent 只是建议，Host 在启动节点前强制检查资源池与并发上限；专家组的输出同样要过校验。
6. **自动挡默认安全**：进程重启后自动挡默认关闭；自动循环有最大步数/最大节点数/最长运行时间/空转熔断。
7. **历史可回看**：DAG 图 + 每个节点的 commit + 封存时的 `dshex/...` git tag + advisor/scheduler 运行记录 + 事件日志，
   四者合起来就是完整的科研迭代路径。
8. **人工确认档不阻塞**：`advisor.acceptMode='confirm'` 时，专家组的新提案先进入 `proposed`（待确认）队列；
   批准才 commit+tag 封存父节点并转 `planned`，拒绝则删除提案。待确认节点不占资源、不参与调度、**不阻塞**任何
   已建立节点的执行；自动挡在只剩待确认提案时进入 `waiting` 状态而不是空转。
9. **确定性超时 + 善后 Agent**：每节点默认 **10 分钟**硬超时（创建节点时可改，上限 4h）。到点由 Host 的
   **Watchdog / Reaper 纯代码**终止：取消 Agent 树 → kill 会话 jobs → 回收 worktree 下 OS 进程 → `nvidia-smi`
   验证 GPU → `finally` 释放资源 → 验证无残留；**全程不经过任何 LLM**。杀完后异步启动 `lab-gc` 善后 Agent 做
   postmortem 与「请求确定性清理」；专家组看到 timeout 失败后自行决定拆小任务 / 延长时间 / 换路 / 放弃分支。

## 命名约定（占位，可改）

| 项 | 取值 |
|---|---|
| bundle 包名 | `dsh-metainfer-research-lab` |
| Host entry id | `metainfer-research-lab` |
| Host 服务 | `ctx.metainferLab` |
| HTTP 前缀 | `/api/metainfer-research-lab` |
| 存储 domain | `metainfer_research_lab`（`$DSH_HOME/storages/` 下；DSH 要求 `/^[a-z][a-z0-9_]*$/`） |
| Git 分支/标签前缀 | `dshex/<projectId>/<nodeId>` |
| UI 标题 | MetaInfer Research Lab · 科研实验台 |

## 使用（快速上手）

1. 浏览器打开/刷新 `http://127.0.0.1:3080`（Host 热加载后，client 需刷新一次页面加载当前版本）。
2. 左侧栏点击 **MetaInfer Research Lab** 图标打开面板。
3. 点「新建项目」，仓库路径填 `../metainfer-demo-repo`（或任意本地 git 仓库；Windows 用绝对路径如
   `C:\path\to\metainfer-demo-repo`），填写研究 brief / 根节点 prompt /
   时间盒（分钟）与资源需求；Host 会校验仓库并创建首个节点（planned）。
4. 选中 planned 节点 → **▶ 启动**：Host 创建独立 git worktree、anchor + worker subagent，完成后自动 commit；
   running 卡片有截止倒计时，可取消/查看对话/继续对话。
5. 手动模式点 **▶ Step** 触发一轮 advisor + scheduler；运行记录里可看提案/调度/评审详情。
6. **自动挡**：切到自动并确认预算（maxCycles / 时长 / token），Host 按 budget 连续推进；暂停原因会显示，可继续/停止。
7. **确认档**：设置里 `acceptMode=人工确认` 后，advisor 只生成 proposed 节点（不封存父节点），检查器可编辑/批准/拒绝。
8. **合并**：选中多个 completed 节点 → `⊕ 创建合并节点`；运行中的 merge 节点可在「继续对话」弹窗与 merge agent 交互
   （历史用 DSH 原生轨迹查看），解决冲突后点 **✓ 完成合并**，Host 自动 stage 并提交 merge commit。
9. **节点模型/强度**：项目设置里配置 `modelOptions`（含价格/tags）与角色默认；创建/后继/合并/检查器可选模型与
   reasoning effort；失败节点可「用更强模型重试」，也可在设置里开启 `routing.autoUpgrade` 自动升级（受预算约束，
   每次升级是新 attempt，保留历史）。
10. **多机 GPU 共享（纯 GUI，无需命令行）**：打开任意项目/项目列表页 → **集群设置** →
    勾选启用、角色选 **协调器/两者**，填 `clusterId`、`machineId`、监听地址、token → **保存并应用**；
    其它机器同样进 **集群设置** → 角色 **客户端** → 填同一个 `clusterId`+token 和 coordinator `url` → 保存。
    Host 会热重启 coordinator/client 并持久化配置（无需插件重载/JSON/终端）。GPU 节点自动排队等整卡。
    可视化：DSH 顶栏集群芯片 + 集群弹窗；coordinator 内置看板 `http://<coordinator>:<port>/`（输 token 后 3s 刷新）；
    API `GET /v1/status` 供监控；CLI `scripts/cluster-status.mjs` 仅作运维备用。
    治理：**一个集群只跑一个 coordinator**，其余为 client；已有 clusterId 校验、state 文件锁、machine claim 三道防护。
    **远程 GPU 舰队（V6）**：若控制机没有 GPU，在同一个「集群设置」里展开“远程 GPU 机器（Fleet over SSH）”，
    填 SSH/容器/NFS 映射与设备；节点 needs 加 `machines` 即可申请多机整卡，Host 会生成 `.dshex-run/remote.sh|launch.sh`
    让 worker 远程执行（详见下方能力说明）。
    注意：local placement 仍机器亲和；fleet placement（V6）可由 coordinator 跨多台已注册的远程 GPU 机器发多机整卡 lease，
    控制机无需 GPU，worker 通过 SSH/容器/NFS 远程执行。详细说明见 [docs/06 第 9/11/12 节](docs/06-multi-tenant-and-model-routing.md)。
11. **其他**：失败节点 ↻ 重试；项目删除（可选清理 worktree）；`⋯` 菜单推送分支/tag；runs/检查器显示 token/成本；
   确定性超时 kill 后 GC 会异步生成 postmortem。

## Windows 兼容性

Host 插件只用 Node 内置模块 + zod，主流程可运行在 Windows 上的 DSH：

- **Agent presets**：worker/merge 在 Windows 自动启用 `tool-pwsh` 并禁用 `tool-bash`（presets 中已有
  `!!js process.platform === 'win32'` 条件）；prompt 本身不含 POSIX 专用命令。
- **路径**：项目/worktree/配置路径统一走 `node:path`；Git worktree 列表路径比较已做分隔符归一化
  （Windows Git 输出正斜杠、Node 为反斜杠）；`.dshex-run/`、storage 路径同样兼容。
- **超时回收**：Linux 使用 `/proc/<pid>/cwd` 扫描并 SIGTERM/SIGKILL；Windows 没有 `/proc`，由 DSH 的
  session jobs（Windows job objects）负责主要进程树终止，termination 记录会带
  `reaper: "unsupported"` / `reaperSupported: false` 和说明；GPU 验证仍执行。macOS 同理为 best-effort。
- **远程 Fleet**：每个节点生成 `.dshex-run/remote.sh|launch.sh`（POSIX）、`remote.ps1|launch.ps1` 和
  `remote.cmd|launch.cmd`（Windows），以及跨平台 `runner.mjs`；worker 提示词按 Host 平台给出命令。
  Windows 本机 worktree 路径（如 `C:\...`）必须通过 **Fleet pathMap** 映射到 Linux 容器内的
  POSIX/NFS 路径，否则 start 会明确报 `fleet_path_map_required`。
- **自测**：临时文件使用 `os.tmpdir()`，不再硬编码 `/tmp`；demo 仓库路径可用
  `MIRL_DEMO_REPO` 环境变量或同级 `../metainfer-demo-repo`。
- **已知边界**：Windows 上未经真实 GPU/SSH/容器 E2E 验证（开发机为 Linux）；remote fleet 的远端容器
  仍假定 Linux + bash；Windows 本地进程残留检测弱于 Linux，建议上线前在目标 Windows 机器跑一遍
  `node --check host/*.js client.js`、`node scripts/selftest.mjs` 和一个本地 demo 项目。

## 多机多节点能力（V6 远程 GPU 舰队）

适用场景：DSH Lab 跑在无 GPU 的控制机，GPU 在若干台服务器上；所有机器挂 NFS，训练在容器里，
控制机可通过 SSH 登录 GPU 机器并进入容器。V6 已支持：

- 集群设置里配置 **Fleet（SSH + 容器 + NFS）**：机器、SSH、容器、设备、pathMap；
- 节点声明 `needs: {gpu: 4, machines: 2}`：Host **先**向 coordinator 申请跨机整卡 lease（不足则整个请求排队），
  **再**在 worktree 生成 `.dshex-run/remote.sh` / `.dshex-run/launch.sh`（注入 rank/world size/GPU/master 环境），
  worker 通过包装器 SSH 进远端容器执行 GPU 程序；
- worktree 在 NFS 上，容器能看到同一份代码；`.dshex-run/` 已被 git exclude，不会进入实验 commit；
- 支持单机多卡、单机多节点、单节点跨多机（torchrun/MPI 风格启动）。

仍有限制：worker agent 本身仍在控制机（只有 GPU 命令远程执行）；容器/SSH 需预先配置；远端进程不会因 lease
到期被自动 kill；项目 DAG 仍为单 DSH 本地存储（无跨 DSH 项目联邦）；不支持 K8s/Slurm 编排。
详见 [docs/06 第 11 节](docs/06-multi-tenant-and-model-routing.md)。

## 节点会话历史复用 DSH 原生轨迹（V8）

点开节点对话历史不再使用 Lab 自带的简单 transcript，而是通过 DSH 的 `uiWorkspace.openSession` 直接打开该
agent 的原生 Conversation，并预设 **Trajectory** 标签：turn/step 分界、时间轴概览、长历史分页/搜索/折叠、
工具调用分类与调用详情 inspector 等均由 DSH 原生提供。节点检查器还列出每次 attempt 的 Session，可分别打开。
原生轨迹标签需在 DSH 设置 → 通用 → 显示代码工作视图 开启（否则原生回退到 Chat，Lab 会提示）。
继续对话仍走 Lab 的“继续对话”弹窗（`node.message`），以保留密封/资源/lease 等实验语义。详见
[docs/06 第 13 节](docs/06-multi-tenant-and-model-routing.md)。

## GPU 节点分配诉求（自然语言，V7）

项目设置新增 **“GPU 节点分配诉求（自然语言）”**：例如“必须使用 A100；尽量同一机架；NVLink 互联；不要 H100”。
Host 会把它编译成结构化约束（硬性 require / 软性 prefer / 排除 / 同机架），coordinator 在 fleet 分配时执行：
硬约束不满足就整个请求排队，软偏好按顺序优先匹配。可在 GUI 里“解析预览”查看 summary/逐条解释/warnings，
再保存。Fleet 机器配置增加 labels（如 gpu=a100、rack=rack-a、interconnect=nvlink）供策略匹配；
节点 lease 面板显示机器 labels。详见 [docs/06 第 12 节](docs/06-multi-tenant-and-model-routing.md)。

## 集群模式下 "项目内 scheduler" 与 "协调器" 的分工

- **项目内 scheduler（设置里的 scheduler 提示词）**：每个项目/DSH 实例内的 LLM 调度员，只决定
  "本项目哪些 planned 节点先启动"；它**不能预占 GPU**，也不能选机器。它的快照里会包含
  `cluster` 段（全局空闲卡、本项目 leases/排队、项目 GPU 配额、machineId），提示词会自动附加
  "协调器才是 GPU 准入权威" 的说明。
- **集群协调器（coordinator）**：确定性服务，集群级整卡 lease 的唯一权威；负责发放/排队/续约/TTL/用量。
  GPU 节点能否真正启动，取决于 coordinator 是否发卡；scheduler 的建议只是请求。
- 项目之间争同一张卡时，按 `clusterPriority`（0–100，项目设置可调）+ 队列 FIFO 决定顺序；
  项目自身的 `resourcePools.gpu` 是**项目并发配额**，超出会被 Host 以 `project_gpu_quota` 拒绝。
- 集群模式下 GPU 节点不支持原地 follow-up（会没有租约）；「继续」请用 retry/escalate 开新 attempt，
  会自动重新 acquire 整卡。详细机制见 [docs/06 第 10 节](docs/06-multi-tenant-and-model-routing.md)。

> 提示：worker/merge 在沙箱内运行，`.git` 目录对它们只读；所有 git 写操作（commit/merge/push）都由 Host 执行。
> 若插件更新了 Host 代码，可用 `plugin_manager set_bundle` 关闭再启用实现热加载；client 更新刷新页面即可。

## 状态

- 设计基线：本机安装的 DSH `0.2.1-rc.2`（`$DSH_INSTALL/`）
- [x] Host / Client 扩展点可行性调研（基于本机安装的 DSH 源码与类型）
- [x] 架构、数据模型、状态机、Git 策略、Agent 角色、UI 方案设计（docs/01–04）
- [x] 关键 API 源码级复核：preset 挂载、`dsh.bundle.patch` 数组、storage domain 命名、Connection fetch 路由、
      sandbox 边界、`sessionQuery`、`maxActiveSubagents`、`worktrees` 的 cwd 副作用
- [x] 独立评审 Agent 复核并修订（sandbox 边界改为 per-node anchor、删除错误的 `maxDepth:0`、
      修正 per-record key 规则、修正 outputSchema 子集、补充 controller/anchor 会话持久化、自动挡防自激等）
- [x] 关键决策已确认（2026-10-23）：命名 `dsh-metainfer-research-lab`、MVP 单父 + v2 git merge 融合、
      v2 异构模型对抗评审、confirm 人工确认档（不阻塞）、worker 可联网、新建 demo 仓库（`../metainfer-demo-repo/`）
- [x] 超时/GC 决策已确认（2026-10-23）：默认 10min 硬超时、创建节点可选执行时间、Host 脚本确定性 kill
      （cancel/dispose → jobs → /proc 进程 → GPU 验证 → finally 释放）、GC 善后 Agent 只做 postmortem/清理请求、
      专家组看到 timeout 后自行决定后续
- [ ] 用户确认剩余细节（见 04 §7 末尾，不阻塞开工）
- [x] **M0 已完成并安装**：可安装骨架、Host storage/HTTP、Client 面板/图标/locale；安装结果 `application: applied`，
      Host 插件与 5 个 preset 行 active，Client 侧栏图标与 `main` 面板槽位 active。验证记录见
      [docs/05-verification.md](docs/05-verification.md)
- [x] **M1 Host/Client 已实现并热加载**：GitEngine（仓库校验）、ProjectStore（projects/nodes/events + revision）、
      项目创建/根节点、`/state` `/events` `/commands`、项目向导 + 分层 DAG 画布 + 检查器 + 活动日志 + 轮询；
      离线自测 17/17 通过。验证记录见 [docs/05-verification.md](docs/05-verification.md)
- [x] **M2 已实现并 E2E 验证**：per-node worktree + anchor + worker activation、自动 commit、失败/取消/继续对话、
      transcript 抽屉、确定性超时 watchdog + Reaper（真实 demo 仓库跑通；超时 kill verifiedClean）、`metainfer_lab` agent 工具。
      记录见 [docs/05-verification.md](docs/05-verification.md)
- [x] **M3 已实现并 E2E 验证**：advisor/scheduler + 手动 Step + 后继节点/封存 + runs/cycles + 运行详情；
      confirm 模式 proposed/批准/拒绝已跑通。记录见 [docs/05-verification.md](docs/05-verification.md)
- [x] **M4 已实现并 E2E 验证**：自动挡（budget/暂停原因/waitingConfirmation）、confirm 审批、重启 reconcile、
      GC 善后 Agent（超时→异步 postmortem）。记录见同上
- [x] **V1 已实现并验证**：项目删除（可选 worktree 清理）、失败节点重试、19/19 离线自测、
      E2E 删除 5 个测试项目并清理 worktree
- [x] **V2 已实现并 E2E 验证**：多父 merge 节点 + 人在环路 merge Agent（冲突解析、Host 自动 stage 后提交 merge commit）、
      异构模型评审 panel（双 lens 并行）、token 用量/预算（auto.maxTokens → paused）、远程 push、GC 善后、交互式运行详情
- [x] **V3 已实现并 E2E 验证**：
      **节点级模型/推理强度**（`modelOptions`/`models`/`routing` + `GET /models` + attempts 时间线 + 每 attempt 成本 +
      手动 `node.escalate`/`node.retry {model|upgrade}` + 自动升级开关，受 `auto.maxCostUsd` 约束）；
      **轻量多实例整卡 GPU 协调器**（任意 DSH 实例可作为 coordinator，HTTP+JSON+Bearer，机器/实例心跳、
      lease/队列/续约/TTL 回收、GPU-秒 usage；GPU 节点先租后跑、排队 `resourceWait`、auto `awaitingGpu`）。
      配置示例见 [cluster.example.json](cluster.example.json)；详细设计与验证见
      [docs/06-multi-tenant-and-model-routing.md](docs/06-multi-tenant-and-model-routing.md)、
      [docs/05-verification.md](docs/05-verification.md)
- [ ] 用户浏览器端到端确认（刷新 → M1–V3 全部 UI 路径；记录见 docs/05-verification.md 末章）
