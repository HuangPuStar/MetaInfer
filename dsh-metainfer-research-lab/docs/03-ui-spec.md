# 03 · UI 设计（Client 面板）

> 目标：在 DSH Web GUI 里提供一个**全屏实验工作台**：看 DAG、改提示词、观察每个 Agent 的对话、切换手动/自动挡、点 Step。
> 面板是 DSH 的 `main` 槽（keyed）中的一个 key，入口是 `sidebar.panellist` 的一个图标；两者用同一个字符串 id 关联。

---

## 1. 注册方式（已验证的 DSH 契约）

| 项 | 值 |
|---|---|
| 面板 key | `metainfer-research-lab` |
| `main` 注册 | `ctx.slots.inject('main', () => ctx.slots.register({ name:'main', key:'metainfer-research-lab', locale:'metainferLab', inject: () => ({}) }, MetainferLabPage))` |
| 侧栏入口 | `ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name:'sidebar.panellist', id:'metainfer-research-lab', order:20, locale:'metainferLab', label:() => t('panel') }, MetainferLabIcon))` |
| 点击行为 | DSH sidebar 自己调用 `ctx.layout.selectPanel('metainfer-research-lab')`；**`main` key 未注册时点击会抛错**，所以两个注册必须同时存在且 id 一致 |
| 作用域 | `main` 是 root-scoped：没有 Session 绑定、没有 `useConversation`/`useInput`；面板自带所有状态，通过 Host HTTP 路由取数据 |
| Client 依赖 | `inject: ['slots', 'locale', 'timer', 'uiWorkspace']`（`timer` 轮询；`uiWorkspace` 用于向导的目录选择 `pickDirectory()`；如需「回到对话」再加 `layout`；无需 `remote`） |
| 模块加载 | `client.js` 用 `window.__ModuleLoader__.load({ id, factory(require) {...} })`；React 18 从模块表 `require('react')`；**不能 import 任意 npm 包**（无 dagre/elkjs/React Flow），DAG 布局自己算 |

```js
window.__ModuleLoader__.load({
  id: 'dsh-metainfer-research-lab',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const PANEL_ID = 'metainfer-research-lab';
    const NS = 'metainferLab';

    return {
      inject: ['slots', 'locale', 'timer', 'uiWorkspace'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'metainfer-research-lab: dictionaries');
        const t = ctx.locale.bind(NS);
        ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ t }) }, MetainferLabPage));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 20, locale: NS,
            label: () => t('panel') }, MetainferLabIcon));
      },
    };
  },
});
```

- 所有可见文案走 `ctx.locale`；`label: () => t('panel')` 用 thunk，切语言时自动重投影。
- 样式：类名前缀 `rl-`，只用 `--dsw-alias-*` token；面板内用 `<style>` 元素随组件卸载清理，或 `styles.insert`。
- 组件必须防御性渲染（slot entry 崩溃会整块空白），外层包一个 ErrorBoundary。

---

## 2. 信息架构

```
MetaInfer Research Lab（main 面板）
├── 顶栏：项目切换 / 仓库信息 / 模式开关 / Step / 自动挡控制 / 资源 / 设置
├── 状态横幅（按需）：自动挡暂停原因、容量告警、存储错误
├── 主体
│   ├── 左栏：任务列表（待确认 / 待执行 / 运行中 / 已完成叶子 / 失败 / 已取消）
│   ├── 中央：DAG 画布（平移/缩放/选中/双击开抽屉）
│   └── 右栏：节点检查器（提示词、资源、Git、报告、操作）
├── 底部：活动日志（可折叠）
├── 抽屉：节点对话 / 事件 / Git 历史
└── 模态：新建项目向导、设置、添加后继、运行详情、确认框
```

---

## 3. 线框

### 3.1 空状态（还没有项目）

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ◈ MetaInfer Research Lab                                             [＋ 新建项目]     │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│                    ┌──────────────────────────────────────┐                  │
│                    │  ◈  把研究变成可回看的实验 DAG         │                  │
│                    │                                      │                  │
│                    │  MetaInfer Research Lab 需要绑定一个 Git 仓库。 │                  │
│                    │  每个实验节点会获得独立的 worktree     │                  │
│                    │  和独立的 Agent 会话。                │                  │
│                    │                                      │                  │
│                    │  仓库路径  [ ~/work/my-research  ]  📁 │                  │
│                    │  项目名称  [ my-research           ]  │                  │
│                    │                                      │                  │
│                    │            [ 验证并创建项目 → ]       │                  │
│                    └──────────────────────────────────────┘                  │
│                                                                              │
│   已有项目：  · LLM-finetune-0721   · scRNA-clustering                       │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 工作台（手动挡）

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│ ◈ MetaInfer Research Lab  [LLM-finetune-0721 ▾]   repo: llm-exp  main@3f2a1b0  [手动|自动]  [Step ▶]     │
│                                          GPU 1/2 · 节点 8/60 · cycle 12   [⚙]                    │
├──────────────┬───────────────────────────────────────────────────────────────┬───────────────────┤
│ 待确认 (2) ⏳  │            ┌──────────┐        ┌──────────┐                   │  n-0007  ridge  │
│ ? n-0012 ... │            │ n-0001   │───────▶│ n-0003   │──┐                │  ─────────────    │
│ ? n-0013 ... │            │ baseline │        │ lr-sweep │  │                │  状态: 已完成     │
│ 待执行 (2)    │            └──────────┘        └──────────┘  │                │  提示词 [编辑]    │
│ ● n-0010 ... │                                    │        │                │  ┌─────────────┐  │
│ ● n-0011 ... │            ┌──────────┐             ▼        ▼                │  │…            │  │
│              │            ┌──────────┐             ▼        ▼                │  └─────────────┘  │
│ 已完成叶子 (1)│            │ n-0002   │        ┌──────────┐ ┌──────────┐     │  Git: dshex/…     │
│ ✓ n-0007 ... │            │ seed-42  │───────▶│ n-0005   │ │ n-0008 ◐ │     │  base 3f2a1b0     │
│              │            └──────────┘        │ lr×bs    │ │ lora-r16 │     │  head 9c1e0f2     │
│ 失败 (0)      │                                └──────────┘ └──────────┘     │  [查看对话] [加后继]│
│ 已取消 (0)    │                                                               │                   │
├──────────────┴───────────────────────────────────────────────────────────────┴───────────────────┤
│ 活动日志 ▾   12:03 step → 新建 2 节点、启动 1 节点   11:58 advisor → 建议 lora-r16 ...          │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.3 自动挡 + 暂停横幅

```
│ [手动|自动●]  自动运行中 · cycle 12/50 · 已运行 01:24:30   [停止]                                │
├──────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ⚠ 自动挡已暂停：连续 3 轮没有新进展。  [继续]  [切回手动]                                        │
```

### 3.4 节点检查器 + 对话抽屉

```
┌──────────────┬──────────────────────────────┬───────────────────────────────────────────────────┐
│  任务列表     │        DAG 画布               │ 对话：n-0007 ridge-sweep            [封印🔒] [×] │
│              │                              │ ─────────────────────────────────────────────────  │
│              │                              │  用户  ▶ 执行节点：在 seed-42 上扫 ridge…          │
│              │                              │  Agent ▸ 我先检查仓库结构…                          │
│              │                              │    ⚙ bash  "ls -la"                    [展开]      │
│              │                              │    ⚙ edit  src/train.py                [展开]      │
│              │                              │  Agent ▸ 训练完成：val_loss 0.84 → 0.79…           │
│              │                              │  ✅ structured_output  报告已提交                  │
│              │                              │ ─────────────────────────────────────────────────  │
│              │                              │  该节点已有后继节点，对话与 worktree 已封存只读。    │
│              │                              │  [对话] [事件] [Git 历史]                          │
└──────────────┴──────────────────────────────┴───────────────────────────────────────────────────┘
```

---

## 4. 顶栏

| 区域 | 元素 | 行为 |
|---|---|---|
| 左 | 图标 + `MetaInfer Research Lab` | 点击回到项目列表/空状态 |
| 左 | 项目切换下拉 | 列出所有项目 + 「＋ 新建项目」；切换时重置面板状态 |
| 中 | 仓库 chip | `repo名 · baseBranch@baseCommit短哈希`，hover 显示绝对路径，点击复制 |
| 中 | 模式分段控件 | `手动 / 自动`；切自动弹确认（展示预算/成本提示）；切手动会停止自动循环 |
| 中 | 接入模式 chip（confirm 档） | `自动采纳 / 人工确认`；`人工确认` 时显示 `N 待确认` 徽标，点击跳左栏「待确认」分组 |
| 中 | `Step ▶`（仅手动档） | 触发一个 cycle；`cycleInFlight` 时禁用并显示 spinner；完成后弹出摘要 toast/inline |
| 中 | 自动挡控制（仅自动档） | 运行中：`cycle n/max · 时长` + `停止`；暂停：`原因` + `继续` + `切回手动`；`waiting`：`等待人工确认 N` + 停止 |
| 右 | 资源 chips | 每个资源池 `gpu 1/2`；超发不可能（Host 校验），耗尽时 chip 变 warn 色 |
| 右 | 节点计数 | `节点 8/60`，接近上限变 warn 色 |
| 右 | 刷新 / 设置 | 手动刷新状态；打开设置模态 |

**Step 的语义提示**（hover tooltip）：「专家组评审一次（可能新增节点）+ 调度器决策一次（可能启动节点）」。
Step 完成后在活动日志插入一条 `cycle` 摘要，并在顶栏短暂显示 `+2 节点 / +1 启动`。

---

## 5. 左侧任务栏

- 六个可折叠分组（本地 UI 状态，不持久化）：
  - **待确认 proposed**（仅 confirm 档显示）：按提案时间升序；行内显示父节点 + 提案摘要；
    hover 出现 `✓ 批准` / `✕ 拒绝`；点击选中并在检查器里编辑。**这些节点不占用资源、不阻塞其他节点执行。**
  - **待执行 planned**：按创建时间升序；行内显示 needs chip；hover 显示「立即启动」按钮（Host 仍会做资源校验）。
  - **运行中 running**：按开始时间；显示已运行时长 + needs；hover 显示「中断」。
  - **已完成叶子 active leaves**：`completed && children==0`，按完成时间降序；显示 commit 短哈希与是否已评审。
  - **失败 failed**：显示错误摘要。
  - **已取消 cancelled**：默认折叠。
- 点击行 = 选中该节点：画布居中并高亮祖先/后代路径，右栏显示检查器。
- 面板宽度 < 1100px 时左栏自动折叠为图标条（hover 展开浮层）；宽度 < 900px 时右栏改为底部抽屉（MVP 可只保证 ≥ 1024px，不做移动端）。

---

## 6. DAG 画布

### 6.1 渲染方案

- 两层结构：底层 `<svg>` 画边（bezier + 箭头 marker），上层绝对定位的节点卡片（HTML div，便于文本省略/按钮/hover）。
- 外层 `div` 使用 `transform: translate(px) scale(z)` 做平移缩放；画布尺寸按节点包围盒 + 80px padding 计算。
- **布局算法**（无外部依赖）：
  1. `depth(node) = parent ? depth(parent)+1 : 0`（DAG 无环，单父时即树深度）。
  2. 按 depth 分层；层内顺序按父节点顺序 + 创建时间，保证稳定。
  3. x = layer * (cardW + 64)，y = index * (cardH + 32) + 居中偏移；同一父节点的子节点连续排列。
  4. 布局结果缓存（node id → position），节点/边变化时只重算变化部分或整体重算（≤100 节点时全量重算足够快）。
- 缩放：`0.25 ~ 1.5`，滚轮以指针为中心缩放；按钮 `+ / − / 适应画布`；初次打开项目自动 fit。
- 平移：背景拖拽（pointer events）；触控板双指滚动=平移，Ctrl+滚轮=缩放（MVP 可选）。

### 6.2 节点卡片

```
┌────────────────────────────────┐
│ ● n-0007  ridge-sweep       🔒 │   ← 状态点 + id + 标题 + 封存锁
│   seed-42 → 扫 ridge 正则化     │   ← 父节点标题 / 提示词摘要（1 行省略）
│ [GPU×1] [9c1e0f2] [2 轮]       │   ← 资源 / commit 短哈希 / 对话轮次
└────────────────────────────────┘
```

| 状态 | 视觉（token） | 动效 |
|---|---|---|
| proposed（待确认） | 虚线边框 `--dsw-alias-state-warn-primary`，状态点同色，右上角 `?` 徽标 | 无 |
| planned | 边框 `--dsw-alias-border-l2`，状态点 `--dsw-alias-label-tertiary` | 无 |
| running | 边框/状态点 `--dsw-alias-brand-primary`，左侧细条 | 呼吸点动画（`prefers-reduced-motion` 时关闭） |
| completed | 状态点 `--dsw-alias-state-success-primary` | 无 |
| failed | 状态点 `--dsw-alias-state-error-primary`；`error.stage==='timeout'` 时再加 `⏱ 超时` 徽标 | 无 |
| cancelled | 整体 40% 透明度 + 删除线标题 | 无 |
| sealed | 右上角 🔒，边框 `--dsw-alias-border-l3` | 无 |
| selected | 外圈 `--dsw-alias-brand-primary` 2px + 阴影 | 无 |

- hover：右上角出现快捷操作（proposed=✓批准/✕拒绝；planned=▶启动；running=⏹中断；completed 未封存=💬继续对话）。
- 双击：打开对话抽屉（proposed/planned 节点没有会话 → 打开检查器；proposed 打开「提案编辑」视图）。
- 选中节点时：祖先/后代路径边高亮，非相关节点降透明度到 0.45；再点空白取消选中。

### 6.3 画布空状态 / 提示

- 项目刚创建（只有根节点 planned）：「根节点已就绪 —— 编辑提示词后点 ▶ 启动，或点 Step 让专家组/调度器决定」。
- 全空（不应出现）：「没有节点，检查项目状态」+ 刷新。
- 右下角图例（可折叠）：状态颜色 + 资源 chip + 🔒 含义。

---

## 7. 节点检查器（右栏 360px）

按状态显示不同区块与操作：

| 区块 | 内容 | 可编辑条件 |
|---|---|---|
| 头部 | 标题、状态 pill、创建者（user/advisor）、节点 id；proposed 时显示「待人工确认」倒计时/年龄 | proposed/planned 可改标题 |
| 提案信息（仅 proposed） | advisor 的 rationale、expectedInfoGain、proposal run 链接、提案时的父节点 head | 只读 |
| 提示词 | textarea + 保存/重置；字数 | proposed/planned |
| 资源需求 | key-value chip 编辑器（键限制在项目资源池键内） | proposed/planned |
| 完成标准 | 文本 | proposed/planned |
| **执行时限** | `timebox` 选择器（5/10/30/60/自定义分钟，上限 `maxNodeTimeoutMs`）；running 时显示「剩余 mm:ss · 到点将被确定性终止」；failed(timeout) 显示终止时间线 | proposed/planned 可改 |
| Git | branch、worktree 路径（复制）、base/head commit、tag、变更文件数 | 只读 |
| 报告 | 结构化报告：summary / metrics 表格 / changes / reproduce / next / risks；未结构化时显示文本报告 | 只读 |
| 后续对话 | 最近 N 轮 user→assistant 摘要 + 新 commit | 只读 |
| 错误 | error message + stage + 时间；超时额外展示：`termination`（killed PIDs/jobs、GPU 是否释放、是否验证干净）、GC postmortem 链接 | 只读 |
| 时间 | created/started/completed/sealed | 只读 |

**操作矩阵**：

| 节点状态 | 按钮 |
|---|---|
| proposed（待确认） | `✓ 批准`（进入 planned，可能同时封存父节点）、`✕ 拒绝`（删除提案）、`编辑提示词`、`💬 查看父节点对话` |
| planned | `▶ 立即启动`、`编辑提示词`、`✕ 取消` |
| running | `⏹ 中断`、`💬 查看对话` |
| completed（未封存） | `💬 继续对话`、`＋ 添加后继`、`✕ 丢弃` |
| completed（已封存） | `👁 查看对话（只读）`、`＋ 添加后继（从该基线分叉）` |
| failed | `↻ 重试`、`💬 查看对话`、`✕ 取消` |
| cancelled | 仅只读展示（无「删除」操作；节点记录永久保留，避免破坏「封存由子节点派生」的不变量） |

所有按钮的禁用都要有可解释的 tooltip（例：「资源不足：GPU 0/1 可用」「该节点已封存」「父节点正在运行，稍后再批准」）。

**「批准提案」的交互**：批准前校验父节点状态；若提案期间父节点 head 已变化，UI 显示
「父节点基线已更新：{old} → {new}，批准后将从此新基线分叉」，用户确认后提交 `node.approve`。
拒绝会二次确认（提示「提案将被删除，父节点保持可继续对话」）。

**「添加后继」模态**：

```
＋ 在 n-0005 上添加后继实验
父节点将在创建后封存（worktree 打 tag、对话变只读）。
标题   [ ridge × batch-size 交互          ]
任务提示词
┌──────────────────────────────────────────────┐
│ 在父节点基线上，固定其他超参，扫描 ridge…       │
└──────────────────────────────────────────────┘
资源需求  [gpu ▾][1] [＋]
执行时限  [10 分钟 ▾]   （到点由实验台脚本强制终止，不询问 Agent）
完成标准  [ val_loss 显著低于 0.84 且复现命令写入报告 ]
                              [取消]  [创建节点]
```

创建即 `planned`，不自动启动（等调度器/用户点启动）。

---

## 8. 对话抽屉

- 打开方式：双击节点 / 检查器按钮 / 活动日志里的节点链接。右侧滑入，宽 560px（可拖拽调整 420–900px），Esc 关闭。
- 数据：`GET api/metainfer-research-lab/transcript?projectId&nodeId&afterSeq`（相对 URL），打开时全量，之后按 `seq` 增量轮询（1s）；
  对话内容由 Host 从 `ctx.sessionQuery.readSession/readSurface` 读取并转成精简行，客户端不接触原始事件。
- 行类型：
  - `user`：任务提示词 / 用户后续消息。
  - `assistant`：正文（预格式化文本；支持 ``` 代码块与列表的最小渲染，不引入 markdown 库）。
  - `tool`：默认折叠为一行 `⚙ bash · 命令摘要`，点击展开参数与结果（结果超 4KB 截断 + 「查看完整」载荷分页）。
  - `report`：`structured_output` 成功 → 渲染成报告卡片（summary + metrics 表格）。
  - `error`：红色行（turn error / 工具失败）。
- 底部输入框（仅未封存叶子）：
  - placeholder：「继续与该实验 Agent 对话（会再占用资源：GPU×1）」
  - `Cmd/Ctrl+Enter` 发送；发送后状态变为 running，完成后自动刷新并 commit 新版本。
  - 封存节点：显示只读横幅，输入框替换为「该节点已封存」。
- 标签页：`对话`、`事件`（节点事件流）、`Git`（`base..head` 的 commit 列表 + `git show --stat` 摘要 + 复制命令）。

---

## 9. 活动日志（底部）

- 折叠时一行高：显示最近一条事件；展开约 180px，可滚动。
- 行内容：时间、类型图标、摘要（`新建 n-0010 “lora r16”` / `启动 n-0009` / `advisor 运行完成：2 提案 / 1 拒绝` / `自动挡暂停：noProgress`），可点击跳节点或打开 run 详情。
- 超时相关行：`n-0009 超时终止（10min）：kill 3 个进程 / 1 个 job / GPU 已释放`、`GC postmortem 完成：建议 split_into_smaller_nodes`，失败时用 warn 色标出。
- 「运行详情」模态：角色（advisor / scheduler / **gc**）、模型、耗时、stopReason、输入快照（可折叠的格式化 JSON）、结构化输出、被拒绝提案及原因、原始文本兜底；超时/GC run 额外展示 reaper 报告、postmortem 与 leftover。
- 刷新方式：随状态轮询增量拉取 `events?after=seq`；自动滚动到底部（用户上滚时暂停自动滚动）。

---

## 10. 手动挡 / 自动挡交互

| 动作 | 前置 | 结果 |
|---|---|---|
| 点 `Step` | 手动档、无进行中 cycle | POST `project.step`；按钮 spinner；返回后顶栏闪摘要 + 日志追加 |
| 切到自动 | 无进行中 cycle（有则先提示等待/结束） | 确认模态（展示 maxCycles/时长/节点上限、提示会产生模型费用）→ POST `auto.start` |
| 自动暂停后点「继续」 | reason 可恢复 | POST `auto.start`（重置 idle/error 计数，保留总预算计数） |
| 批准/拒绝待确认提案 | 节点为 proposed | POST `node.approve` / `node.reject`；不影响正在运行的节点；完成后自动排下一轮（confirm 档的自动循环从 `waiting` 恢复） |
| 点「停止」/切手动 | — | POST `auto.stop`；进行中的 cycle 允许跑完，但不再排下一轮 |
| 自动挡运行中隐藏 `Step` | — | 避免双入口；手动档才显示 |
| 页面关闭/隐藏 | — | 轮询暂停；Host 自动循环**不依赖页面**，继续运行 |

确认模态文案要明确：「自动挡会持续调用模型并占用资源；达到 50 个 cycle / 6 小时 / 60 个节点任一上限后自动暂停。」
所有危险操作（中断运行节点、丢弃节点、删除项目）二次确认。

---

## 11. 新建项目向导

分两步（MVP 不做分页动画，左右结构）：

**Step 1 · 绑定 Git 仓库**
- 仓库路径：文本输入 + `📁 选择目录`（client `ctx.uiWorkspace.pickDirectory()`）+ `验证` 按钮。
  - Host 返回 `{ok, repoRoot, branches[], defaultBranch, baseCommit}` 或明确错误（不是 git 仓库/裸仓库/无提交）。
  - 校验通过后展示 repo 名、默认分支、当前 commit；用户可选 base branch（下拉）或保持默认。
- 项目名称：默认取仓库目录名，可改。
- 若未选择仓库 → 「创建」按钮禁用，并提示「MetaInfer Research Lab 必须绑定 Git 仓库」。

**Step 2 · 研究设定**
- 研究目标 / 假设 `brief`（textarea，必填，≤ 4000 字）。
- 根节点提示词（textarea，预填模板；必填）。
- 资源池：key-value 编辑器（默认 `gpu: 1`），+ 添加资源键。
- 并发上限 `maxRunningNodes`（默认 4）、节点上限（默认 60）。
- **默认执行时限** `nodeTimeoutMs`（默认 **10 分钟**，可改为 5/10/30/60/自定义分钟）与**单节点上限** `maxNodeTimeoutMs`（默认 4 小时）。
- 三个角色模型：`使用默认模型` 开关（默认开）；关闭后填 provider/model/reasoningEffort。
- **新节点接入模式**：`自动采纳（auto）` / `人工确认（confirm）` 单选，默认 auto；confirm 模式下方显示「待确认提案不阻塞其他节点执行」的说明。
- 高级（折叠）：提示词覆盖、自动挡预算、`advisor.maxPendingProposals`（默认 20）。
- 创建 → `POST /api/metainfer-research-lab/projects`（与列表 GET 同一路由）→ 面板切换到工作台；根节点已 `planned`。

---

## 12. 数据接口（Host 侧，`ctx.connection.fetch.register`）

> 全部是同源路由，**Host 注册的 path 以 `/api/` 开头**（与 DSH 的 `dsh-client-ui-deliverables` 一致：
> `{ path: '/api/present.host', ... }`）；**Client 端用去掉前导 `/` 的相对 URL**（`fetch('api/metainfer-research-lab/state')`），
> 这样在带 mount 前缀的部署下也能工作。Host 插件的完整依赖声明为
> `export const inject = ['connection','storageDomain','agents','agentPresets','subagents','sessionQuery','sessions','sandboxPolicy','agentDefaultModel','subprocess']`
> （缺任何一个都会让对应能力在激活时不可用；若想让插件在缺服务的 profile 里也能加载，可用 `ctx.inject([...])` 做可选分支）。
> 每个路由用
> `ctx.connection.fetch.register({ path, methods, requestBody:'buffered', fetch })` 注册；路由在 Connection 鉴权栅栏后。

| 路由 | 方法 | 参数 | 返回 |
|---|---|---|---|
| `/api/metainfer-research-lab/projects` | **GET + POST**（一次注册，`methods:['GET','POST']`） | GET 列表；POST `{name, repoPath, brief, baseBranch?, initialPrompt, config, prompts?}` | GET `{projects:[...]}`；POST `{projectId}` 或 `{ok:false,error}` |
| `/api/metainfer-research-lab/repo` | GET | `?path=` | `{ok, repoRoot, branches, defaultBranch, baseCommit}` 或错误 |
| `/api/metainfer-research-lab/state` | GET | `?projectId=&revision=` | 全量状态；`revision` 未变返回 `{unchanged:true}` |
| `/api/metainfer-research-lab/events` | GET | `?projectId=&after=` | `{events:[...], next}` |
| `/api/metainfer-research-lab/transcript` | GET | `?projectId=&nodeId=&afterSeq=` | `{rows:[...], nextSeq, running}` |
| `/api/metainfer-research-lab/runs` | GET | `?projectId=&runId=` | run 详情（含输入快照/输出/拒绝） |
| `/api/metainfer-research-lab/commands` | POST | `{type, ...}` | 命令结果（见下） |

**commands 类型**：

| type | 载荷 | 作用 |
|---|---|---|
| `project.step` | `{projectId}` | 手动执行一个 cycle |
| `auto.start` | `{projectId}` | 启动自动循环并把 `project.mode='auto'`；暂停后「继续」也用这个命令（重置 idle/error 计数，保留总预算计数） |
| `auto.stop` | `{projectId}` | 停止自动循环并把 `project.mode='manual'` |
| `project.update` | `{projectId, config?, prompts?, brief?}` | 更新配置（含 `advisor.acceptMode`、`advisor.maxPendingProposals`） |
| `project.delete` | `{projectId, removeWorktrees?}` | 删除项目（可选清理 worktree；Git 分支/tag 默认保留） |
| `node.edit` | `{projectId, nodeId, title?, prompt?, needs?, successCriteria?, timeboxMinutes?}` | proposed / planned |
| `node.approve` | `{projectId, nodeId}` | confirm 档批准提案：commit+tag 封存父节点（若首次）、节点转 planned |
| `node.reject` | `{projectId, nodeId}` | confirm 档拒绝提案：删除提案记录，父节点保持未封存 |
| `node.start` | `{projectId, nodeId}` | 手动启动（Host 仍校验资源；proposed 不可直接启动） |
| `node.cancel` | `{projectId, nodeId}` | 取消 planned/running/failed |
| `node.retry` | `{projectId, nodeId}` | 失败重试：没有 `sessionId`（启动阶段失败）→ 回到 planned 重新启动；已有会话 → 发 follow-up 消息（带错误上下文） |
| `node.successor` | `{projectId, nodeId, title, prompt, needs?, successCriteria?, timeboxMinutes?}` | 手动添加后继（封存父节点；timebox 默认取项目默认值） |
| `node.message` | `{projectId, nodeId, text}` | 继续对话（仅未封存叶子） |
| `node.seal` | — | 不提供：封存只能由「创建后继」间接触发 |

**统一响应**：`{ok:true, data}` 或 `{ok:false, error:{code, message, details?}}`；HTTP 状态 200 表达业务结果。
所有命令走 Host 的 `ctx.metainferLab` 服务方法（UI 与未来 Agent 工具共用同一实现）。

**轮询策略**：
- 面板可见且 `document.visibilityState==='visible'` 时：`state` 1.5s；`transcript`（抽屉打开时）1s；`events` 2s。
- 页面隐藏时暂停所有轮询；恢复可见立即拉一次。
- 请求失败：指数退避（1.5 → 3 → 5s 封顶），顶部显示「连接中断，重试中」；成功后清除。
- 每次请求带 `AbortController`，切换项目/关闭抽屉时 abort。

---

## 13. 视觉规范

| 用途 | Token |
|---|---|
| 面板背景 | `--dsw-alias-bg-base` |
| 顶栏/左栏/检查器背景 | `--dsw-alias-bg-layer-1` |
| 卡片/输入框背景 | `--dsw-alias-bg-layer-2`（浮层 `-bg-overlay`） |
| 边框（默认/强调） | `--dsw-alias-border-l1` / `--dsw-alias-border-l2` |
| 主文本/次文本/辅助文本 | `--dsw-alias-label-primary` / `-label-secondary` / `-label-tertiary` |
| 主色/选中/链接 | `--dsw-alias-brand-primary` / `--dsw-alias-link` |
| 状态：运行 | `--dsw-alias-brand-primary`（或 `-state-business-primary`） |
| 状态：成功/完成 | `--dsw-alias-state-success-primary` |
| 状态：等待 | `--dsw-alias-state-warn-primary` |
| 状态：失败 | `--dsw-alias-state-error-primary` |
| 状态：取消/空闲 | `--dsw-alias-state-idle-primary` |
| 边 | `--dsw-alias-border-l2`；高亮边 `--dsw-alias-brand-primary` |
| 代码/hash | `font-family: ui-monospace, SFMono-Regular, Menlo, monospace` |

- 字号：标题 14、正文 13、辅助 12、hash/chip 11；间距 4/8/12/16/24。
- 圆角：卡片 10px，chip 6px，按钮 8px。
- 亮/暗两套主题都必须验证（DSH 通过 `body[data-ds-dark-theme]` 切换）。
- 图标：自绘 SVG（DAG 分叉图标），`currentColor` 着色；侧栏入口 active 时用品牌色。
- 动效：运行中节点 2s 呼吸点；抽屉 160ms 滑入；`prefers-reduced-motion` 时全部关闭。

---

## 14. 多语言与插件元数据

- Client 字典内嵌在 `client.js`（`zh` 为键集来源，`en` 完整对应），命名空间 `metainferLab`；所有字符串经 `t()`。
- `package.json` 导出 `./locale/*.json`，文件只放插件展示元数据：
  - `locale/zh.json`: `{"meta":{"title":"MetaInfer Research Lab · 科研实验台","description":"用动态 DAG 组织科研实验：每个节点绑定独立 git worktree 与 subagent，专家组生长计划、调度器分配资源，支持手动 Step 与自动挡。"}}`
  - `locale/en.json`: 对应英文。
- 插件图标：`icon.svg`（原创 DAG 分叉图形，< 256 KiB，随包导出 `./icon`）。

---

## 15. 空/错/边界状态

| 场景 | UI |
|---|---|
| 无项目 | §3.1 空状态 + 已有项目列表 |
| 仓库校验失败 | 向导内联错误（不是 git 仓库 / bare / 无 commit / 路径不可读） |
| 部署 sandbox 为 read-only | 顶栏红色横幅「当前部署禁止文件写入，实验台无法执行节点」+ 设置指引 |
| 子代理容量告警 | 仅当 `ACTIVATION_LIMIT_REACHED` 实际发生（同一棵 activation 树瞬时并发过高）时显示；提示检查 Settings → Subagent 的 `maxActiveSubagents`（默认 8，正常足够） |
| 自动挡暂停 | 黄色横幅 + 原因文案 + 继续/切手动 |
| 自动挡 `waiting`（confirm 档） | 蓝色/中性横幅「等待人工确认 N 个提案；已批准节点继续执行」+ 「查看待确认」按钮；不影响 running 节点 |
| 待确认提案堆积 | 当 pendingProposals ≥ `maxPendingProposals` 时提示横幅；advisor pass 暂停产新提案，直到人工处理 |
| 节点超时（正常路径） | 节点卡片变红并带 `⏱ 超时` 徽标；检查器显示终止时间线与「部分报告」；活动日志出现「确定性终止 + GC postmortem」；自动挡不暂停 |
| reaper 验证失败（残留进程/GPU） | 红色横幅「终止后仍有残留：…」+ `needsAttention` + 自动挡暂停 + 「立即清理」（再次触发确定性 reaper）/「查看 GC」 |
| 存储写失败 | 红色横幅 + 自动挡暂停，禁止继续操作直到恢复 |
| 轮询中断 | 顶栏小字「连接中断，重试中…」 |
| slot 组件异常 | ErrorBoundary 显示「面板渲染异常」+ 重试按钮，不让整个 slot 空白 |
| 项目已删除（多标签页） | 拉取 404 → 回到项目列表并提示 |

---

## 16. 实现文件结构（建议）

```
dsh-metainfer-research-lab/
  package.json                 # dsh.bundle.patch(数组) + dsh.client + exports/files
  cordis.patch.yml             # 宿主插件行
  presets.patch.yml            # 4 个 @deepseek-ai/dsh-agent-preset 行
  index.js                     # Host apply：inject、路由、服务、生命周期
  host/
    domain.js                  # storageDomain spec + ProjectStore
    git-engine.js              # exec spawn 封装 + worktree/commit/tag
    orchestrator.js            # cycle / auto / 预算 / 锁
    node-runner.js             # 节点生命周期 + subagent 调用
    advisor.js  scheduler.js   # 快照 + 校验 + activation
    snapshot.js  prompts.js    # 快照构造 / 提示词模板
    http.js  commands.js        # 路由 + 命令分发
  client.js                    # Client bundle（可再由 client/src/*.js 拼接生成）
  client/src/
    page.js topbar.js rail.js canvas.js node-card.js inspector.js
    drawer.js activity.js create-wizard.js settings.js run-modal.js
    api.js layout.js poll.js locale.js error-boundary.js
  locale/en.json  locale/zh.json  icon.svg
  scripts/build-client.mjs     # 无构建依赖：按 import 顺序拼接成 client.js（或手工维护单文件）
```

- Client 不允许任意 npm import，因此**不引入构建链**：`client.js` 可以直接手写为单文件（MVP 控制在 ~2–3k 行），
  或用 20 行的拼接脚本把 `client/src/*.js` 合并（顺序 import → 单 IIFE），Client 侧零运行时依赖。
- Host 侧依赖：Node 内置模块 + DSH 注入的服务（通过 `inject`）+ **`zod`**（用于 storageDomain 的 value schema）。
  `zod` 在 bundle `dependencies` 里声明；本地链接安装不会替我们装依赖，所以 M0 先在本目录跑一次 `pnpm install`
  （生成的 `node_modules/zod` 会被插件进程按真实路径解析到）。**不要** import 任何 `@deepseek-ai/dsh-*` 包——
  本地 bundle 是链接安装，Node 解析不到 DSH 安装目录。
- 所有节点/控制器会话都以 `origin:'subagent'` 创建，DSH 侧栏不显示；用户从 MetaInfer Research Lab 面板进入。

---

# 附：M3–V2 UI 增补（2026-10-23）

- **Step/运行记录**：手动 Step（spinner + 摘要）、运行/循环面板（2s 轮询、详情 JSON、rejected、lens/panelSize/usage）、活动日志运行链接。
- **确认档**：proposed 卡片/候选组、检查器批准/拒绝（confirm 对话框）、父节点审批前不封存。
- **自动挡**：手动/自动切换 + budget 确认模态；running/paused/waiting 芯片（暂停原因本地化、继续/停止、预算 tokens）。
- **设置**：acceptMode、提案/待确认上限、auto 预算（含 maxTokens）、默认/最大时限、并发与资源池、角色模型、reviewers 编辑器、prompts。
- **失败/运维**：失败节点 ↻ 重试；项目删除（worktree 清理复选框）；GC postmortem 面板与 gc 运行详情。
- **V2 merge**：创建合并节点模态（完成节点多选 2–4）、merge 徽标/多父副标题、运行中 merge 检查器（冲突文件、父基线、lastReport、✓ 完成合并）、
  running merge 的对话 composer。
- **V2 评审/token/push**：runs 的 lens/评审组/token 芯片与详情；节点/自动挡/settings 的 token 展示；项目菜单推送分支/tag 模态。
