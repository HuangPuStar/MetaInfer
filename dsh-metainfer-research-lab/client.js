/**
 * MetaInfer Research Lab — Client half (M1: project wizard + DAG workspace).
 *
 * Loaded by the Web shell through the ModuleLoader bundle format: `factory` is
 * lazy and free of side effects; everything is registered from `apply` so plugin
 * unload removes the page, the sidebar entry and the dictionaries together.
 *
 * The panel is a full-page `main` slot occupant. It keeps only local UI state
 * (selected project / node); authoritative project, DAG and event state always
 * comes from the Host HTTP routes polled below. Visible copy goes through the
 * `metainferLab` Client locale namespace; chrome colors come from
 * `--dsw-alias-*` theme tokens only.
 */
window.__ModuleLoader__.load({
  id: 'dsh-metainfer-research-lab',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // #region constants
    /** Key shared by the `main` page and its `sidebar.panellist` icon entry. */
    const PANEL_ID = 'metainfer-research-lab';
    /** Client locale namespace owned by this plugin. */
    const NS = 'metainferLab';

    /** Host routes, always fetched as relative URLs so mount prefixes keep working. */
    const ROUTES = {
      models: 'api/metainfer-research-lab/models',
      cluster: 'api/metainfer-research-lab/cluster',
      clusterConfig: 'api/metainfer-research-lab/cluster/config',
      health: 'api/metainfer-research-lab/health',
      projects: 'api/metainfer-research-lab/projects',
      repo: 'api/metainfer-research-lab/repo',
      state: 'api/metainfer-research-lab/state',
      events: 'api/metainfer-research-lab/events',
      commands: 'api/metainfer-research-lab/commands',
      runs: 'api/metainfer-research-lab/runs',
    };

    /** Poll cadence while the page is visible. */
    const POLL_STATE_MS = 1500;
    const POLL_EVENTS_MS = 2000;
    /** Transcript drawer cadence while it is open and the page is visible. */
    /** Runs panel cadence while it is open (state/events keep 1500/2000ms). */
    const RUNS_POLL_MS = 2000;
    const POLL_CLUSTER_MS = 2000;
    /** Error backoff steps (1.5s → 3s → 5s, capped at the last step). */
    const BACKOFF_MS = [1500, 3000, 5000];
    /** Activity log keeps only the newest entries. */
    const MAX_LOG_EVENTS = 200;

    /** DAG canvas geometry (layer = column, one node per row cell). */
    const NODE_W = 208;
    const NODE_H = 84;
    const GAP_X = 72;
    const GAP_Y = 28;
    const CANVAS_PAD = 80;
    const MIN_ZOOM = 0.25;
    const MAX_ZOOM = 1.5;
    const FIT_PAD = 48;

    /** Status order used by the left rail and by fallback normalization. */
    const STATUS_ORDER = ['proposed', 'planned', 'running', 'completed', 'failed', 'cancelled'];

    /** Wizard defaults; the Host applies the same defaults server-side. */
    const DEFAULT_CONFIG = {
      maxRunningNodes: 4,
      maxNodes: 60,
      nodeTimeoutMinutes: 10,
      maxNodeTimeoutMinutes: 240,
    };
    /** Documented limit used before a project config is available. */
    const FALLBACK_MAX_TIMEOUT_MINUTES = 240;

    /** Known Host event types mapped to locale keys; unknown types render raw. */
    const EVENT_LABEL_KEYS = {
      // Host M1 emits `domain/verb` types; dotted variants are tolerated too.
      'project/created': 'log.type.project.created',
      'project/edited': 'log.type.project.updated',
      'project/updated': 'log.type.project.updated',
      'node/created': 'log.type.node.created',
      'node/edited': 'log.type.node.edited',
      'node/proposed': 'log.type.node.proposed',
      'node/approved': 'log.type.node.approved',
      'node/rejected': 'log.type.node.rejected',
      'node/started': 'log.type.node.started',
      'node/completed': 'log.type.node.completed',
      'node/failed': 'log.type.node.failed',
      'node/cancelled': 'log.type.node.cancelled',
      'node/messaged': 'log.type.node.messaged',
      'node/terminated': 'log.type.node.terminated',
      'node/sealed': 'log.type.node.sealed',
      'node/resource_waiting': 'log.type.node.resource_waiting',
      'node/resource_granted': 'log.type.node.resource_granted',
      'node/resource_lost': 'log.type.node.resource_lost',
      'node/escalated': 'log.type.node.escalated',
      'node/model_changed': 'log.type.node.model_changed',
      'node/retried': 'log.type.node/retried',
      'cycle/started': 'log.type.cycle.started',
      'cycle/finished': 'log.type.cycle.finished',
      'advisor/started': 'log.type.advisor.started',
      'advisor/finished': 'log.type.advisor.finished',
      'scheduler/started': 'log.type.scheduler.started',
      'scheduler/finished': 'log.type.scheduler.finished',
      'gc/started': 'log.type.gc.started',
      'gc/finished': 'log.type.gc.finished',
      'auto/started': 'log.type.auto.started',
      'auto/stopped': 'log.type.auto.stopped',
      'auto/resumed': 'log.type.auto.resumed',
      'auto/paused': 'log.type.auto.paused',
      'cycle/completed': 'log.type.cycle.completed',
      'auto/started': 'log.type.auto.started',
      'auto/stopped': 'log.type.auto.stopped',
      'project.created': 'log.type.project.created',
      'project.updated': 'log.type.project.updated',
      'node.created': 'log.type.node.created',
      'node.edited': 'log.type.node.edited',
      'node.proposed': 'log.type.node.proposed',
      'node.approved': 'log.type.node.approved',
      'node.rejected': 'log.type.node.rejected',
      'node.started': 'log.type.node.started',
      'node.completed': 'log.type.node.completed',
      'node.failed': 'log.type.node.failed',
      'node.cancelled': 'log.type.node.cancelled',
      'cycle.completed': 'log.type.cycle.completed',
      'auto.started': 'log.type.auto.started',
      'auto.stopped': 'log.type.auto.stopped',
      'node.sealed': 'log.type.node.sealed',
      'node.resource_waiting': 'log.type.node.resource_waiting',
      'node.resource_granted': 'log.type.node.resource_granted',
      'node.resource_lost': 'log.type.node.resource_lost',
      'node.escalated': 'log.type.node.escalated',
      'node.model_changed': 'log.type.node.model_changed',
      'node.retried': 'log.type.node.retried',
      'cycle.started': 'log.type.cycle.started',
      'cycle.finished': 'log.type.cycle.finished',
      'advisor.started': 'log.type.advisor.started',
      'advisor.finished': 'log.type.advisor.finished',
      'scheduler.started': 'log.type.scheduler.started',
      'scheduler.finished': 'log.type.scheduler.finished',
      'gc.started': 'log.type.gc.started',
      'gc.finished': 'log.type.gc.finished',
      'auto.resumed': 'log.type.auto.resumed',
      'auto.paused': 'log.type.auto.paused',
    };

    /** Monospace stack the Host uses for ids, paths and hashes. */
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    // #endregion

    // #region dictionaries — `zh` is the key-set source of truth; `en` mirrors it.
    const zh = {
      panel: '科研实验台',
      title: 'MetaInfer Research Lab · 科研实验台',
      subtitle: '用动态 DAG 组织科研实验：每个节点绑定独立 git worktree 与 subagent 会话。',
      badge: 'M1 · 项目与 DAG 画布',
      'intl.locale': 'zh-CN',

      'common.retry': '重试',
      'common.refresh': '刷新',
      'common.cancel': '取消',
      'common.save': '保存',
      'common.remove': '移除',
      'common.loading': '加载中…',
      'common.unknown': '未知',
      'common.none': '—',

      'error.network': '无法连接 Host 服务',
      'error.http': '请求失败（HTTP {status}）',
      'error.unknown': '请求失败',
      'error.unauthorized': '没有访问权限',

      'landing.projects.title': '实验项目',
      'landing.projects.count': '共 {count} 个项目',
      'landing.projects.empty': '还没有项目，请在右侧创建第一个项目。',
      'landing.projects.loading': '正在加载项目列表…',
      'landing.projects.error': '无法加载项目列表',
      'landing.projects.open': '打开',
      'landing.projects.nodes': '{count} 个节点',
      'landing.projects.updated': '更新于 {time}',
      'landing.projects.mode.manual': '手动挡',
      'landing.projects.mode.auto': '自动挡',
      'landing.host.ready': 'Host 服务就绪',
      'landing.host.down': 'Host 服务不可用',
      'landing.host.version': '版本 {version}',

      'wizard.title': '新建项目',
      'wizard.intro': '绑定一个 Git 仓库，为根节点写好实验指令。',
      'wizard.section.repo': '① 绑定 Git 仓库',
      'wizard.section.research': '② 研究设定',
      'wizard.repoPath': '仓库路径',
      'wizard.repoPath.placeholder': '/absolute/path/to/git/repo',
      'wizard.repoPath.required': '请先填写仓库路径',
      'wizard.validate': '验证仓库',
      'wizard.validating': '正在验证…',
      'wizard.repo.valid': '仓库校验通过',
      'wizard.repo.root': '仓库根目录',
      'wizard.repo.gitDir': 'Git 目录',
      'wizard.repo.baseBranch': '基准分支',
      'wizard.repo.commit': '基准提交',
      'wizard.repo.branches': '共 {count} 个分支',
      'wizard.repo.dirty': '工作区有未提交改动',
      'wizard.repo.clean': '工作区干净',
      'wizard.repo.error': '仓库校验失败',
      'wizard.repo.error.invalid_repo': '路径不是有效的 Git 仓库',
      'wizard.repo.error.not_git': '目录不是 Git 仓库',
      'wizard.repo.error.bare': '不支持裸仓库',
      'wizard.repo.error.bad_path': '路径无效或不可读',
      'wizard.repo.error.no_commits': '仓库还没有任何提交，无法创建项目',
      'wizard.name': '项目名称',
      'wizard.name.placeholder': '默认使用仓库目录名',
      'wizard.brief': '研究目标 / 假设',
      'wizard.brief.placeholder': '例如：验证在 seed-42 上扫描 ridge 正则化系数能否降低 val_loss。',
      'wizard.initialPrompt': '根节点提示词',
      'wizard.initialPrompt.placeholder': '描述根节点要执行的第一个实验、约束与要产出的报告。',
      'wizard.pools': '资源池',
      'wizard.pools.hint': '键值对，例如 gpu: 1；调度器按资源池容量分配节点。',
      'wizard.pools.required': '至少需要一个有效的资源池',
      'wizard.pools.duplicate': '资源名不能重复',
      'wizard.pool.key': '资源',
      'wizard.pool.value': '数量',
      'wizard.pool.add': '＋ 添加资源',
      'wizard.pool.remove': '移除资源',
      'wizard.limits': '运行上限',
      'wizard.maxRunningNodes': '并发节点上限',
      'wizard.maxNodes': '节点总数上限',
      'wizard.timeouts': '执行时限（分钟）',
      'wizard.nodeTimeoutMinutes': '默认执行时限',
      'wizard.maxNodeTimeoutMinutes': '单节点时限上限',
      'wizard.timeouts.hint': '时限到达后由 Host 确定性终止；单节点上限 {max} 分钟。',
      'wizard.create': '创建项目',
      'wizard.creating': '正在创建…',
      'wizard.error': '创建项目失败',
      'wizard.required.repo': '请先验证仓库并选择基准分支',
      'wizard.required.name': '请填写项目名称',
      'wizard.required.brief': '请填写研究目标 / 假设',
      'wizard.required.prompt': '请填写根节点提示词',
      'wizard.error.noProject': 'Host 未返回项目 id',

      'ws.back': '← 项目列表',
      'ws.project.unknown': '未命名项目',
      'ws.mode': '模式',
      'ws.mode.manual': '手动',
      'ws.mode.auto': '自动',
      'ws.mode.autoHint': '自动挡在后续阶段提供',
      'ws.step': '▶ Step',
      'ws.step.hint': '手动执行一轮：专家组评审 + 调度器决策。',
      'ws.dirty': '有未提交改动',
      'ws.resourceChip': '{key} {free}/{total}',
      'ws.nodeCount': '节点 {count}/{max}',
      'ws.revision': '版本 {revision}',
      'ws.rail.title': '任务列表',
      'ws.rail.empty': '还没有节点',
      'ws.canvas.empty': '没有节点，检查项目状态后刷新。',
      'ws.canvas.hint': '拖拽平移 · 滚轮缩放 · 点击节点查看详情',
      'ws.canvas.fit': '适应画布',
      'ws.canvas.zoomIn': '放大',
      'ws.canvas.zoomOut': '缩小',
      'ws.node.parentPrefix': '来自 ',
      'ws.node.minutes': '{minutes} 分钟',
      'ws.node.root': '根节点',
      'status.proposed': '待确认',
      'status.planned': '待执行',
      'status.running': '运行中',
      'status.completed': '已完成',
      'status.failed': '失败',
      'status.cancelled': '已取消',
      'createdBy.user': '用户',
      'createdBy.advisor': '专家组',
      'createdBy.seed': '种子',
      'ws.inspector.title': '节点检查',
      'ws.inspector.empty': '在画布或左栏选择一个节点。',
      'ws.inspector.prompt': '提示词',
      'ws.inspector.prompt.placeholder': '节点任务提示词',
      'ws.inspector.prompt.chars': '{count} 字符',
      'ws.inspector.promptRequired': '提示词不能为空',
      'ws.inspector.successCriteria': '完成标准',
      'ws.inspector.successCriteria.placeholder': '可选的验收标准，例如：val_loss < 0.84 且报告含复现命令。',
      'ws.inspector.timebox': '执行时限',
      'ws.inspector.timebox.hint': '1–{max} 分钟',
      'ws.inspector.timebox.invalid': '请输入 1–{max} 之间的整数分钟',
      'ws.inspector.savePrompt': '保存提示词',
      'ws.inspector.saveTimebox': '保存时限',
      'ws.inspector.saving': '保存中…',
      'ws.inspector.saved': '已保存',
      'ws.inspector.readonly': '当前状态为「{status}」，该节点不可编辑。',
      'ws.inspector.error': '保存失败',
      'ws.inspector.git': 'Git',
      'ws.inspector.branch': '分支',
      'ws.inspector.worktree': 'worktree 路径',
      'ws.inspector.baseCommit': '基准提交',
      'ws.inspector.headCommit': '最新提交',
      'ws.inspector.tag': '标签',
      'ws.inspector.parent': '父节点',
      'ws.inspector.createdBy': '创建者',
      'ws.inspector.timestamps': '时间',
      'ws.inspector.createdAt': '创建',
      'ws.inspector.updatedAt': '更新',
      'ws.inspector.startedAt': '开始',
      'ws.inspector.completedAt': '完成',
      'ws.inspector.errorLabel': '错误',
      'ws.inspector.worktreeRoot': 'worktree 根目录',
      'ws.log.title': '活动日志',
      'ws.log.empty': '暂无事件',
      'ws.log.collapse': '折叠',
      'ws.log.expand': '展开',
      'ws.log.count': '{count} 条',
      'ws.poll.offline': '连接中断，正在重试…',
      'ws.poll.nextRetry': '下一次重试约 {seconds}s 后',
      'ws.poll.retry': '立即重试',
      'ws.loading': '正在加载项目状态…',
      'ws.loadError': '无法加载项目状态',
      'ws.loadingHint': '拉取 state / events 失败时会按 1.5s → 3s → 5s 退避重试。',
      'log.type.project.created': '项目创建',
      'log.type.project.updated': '项目更新',
      'log.type.node.created': '节点创建',
      'log.type.node.edited': '节点编辑',
      'log.type.node.proposed': '节点提案',
      'log.type.node.approved': '节点批准',
      'log.type.node.rejected': '节点拒绝',
      'log.type.node.started': '节点启动',
      'log.type.node.completed': '节点完成',
      'log.type.node.failed': '节点失败',
      'log.type.node.cancelled': '节点取消',
      'log.type.cycle.completed': '循环完成',
      'log.type.auto.started': '自动挡启动',
      'log.type.auto.stopped': '自动挡停止',
      'ws.actions': '操作',
      'ws.action.start': '▶ 启动',
      'ws.action.starting': '正在启动…',
      'ws.action.cancel': '■ 取消',
      'ws.action.cancelling': '正在取消…',
      'ws.action.failed': '操作失败',
      'ws.action.openTranscript': '查看对话',
      'ws.action.continue': '继续对话',
      'ws.action.dismiss': '关闭提示',
      'ws.runningCount': '运行中 {count}',
      'ws.held': '{key} 占用 {held}',
      'ws.running.title': '运行中',
      'ws.running.deadline': '截止时间',
      'ws.running.remaining': '剩余 {time}',
      'ws.running.overdue': '已超时',
      'ws.running.held': '占用资源',
      'ws.running.hint': '超过截止时间后由 Host 强制终止。',
      'ws.card.remaining': '⏱ {time}',
      'ws.report.title': '实验报告',
      'ws.report.success': '成功',
      'ws.report.failed': '未达成',
      'ws.report.summary': '摘要',
      'ws.report.metrics': '指标',
      'ws.report.changes': '变更',
      'ws.report.reproduce': '复现',
      'ws.report.next': '后续建议',
      'ws.report.risks': '风险',
      'ws.report.blockers': '阻塞项',
      'ws.report.text': '报告文本',
      'ws.report.metricName': '指标',
      'ws.report.metricValue': '值',
      'ws.termination.title': '终止记录',
      'ws.termination.kind': '类型',
      'ws.termination.kind.timeout': '超时终止',
      'ws.termination.kind.cancel': '取消',
      'ws.termination.kind.failure': '失败',
      'ws.termination.killedAt': '终止时间',
      'ws.termination.pids': '终止进程',
      'ws.termination.jobs': '终止任务',
      'ws.termination.gpuFreed': 'GPU 已释放',
      'ws.termination.verifiedClean': '已验证无残留',
      'ws.termination.leftover': '残留',
      'ws.termination.yes': '是',
      'ws.termination.no': '否',
      'ws.followUps.title': '后续对话',
      'ws.followUps.head': '提交 {commit}',
      'ws.transcript.title': '节点对话',
      'ws.transcript.empty': '暂无对话记录',
      'ws.transcript.emptyRunning': '节点尚未产生对话内容。',
      'ws.transcript.loading': '正在加载对话…',
      'ws.transcript.error': '对话加载失败',
      'ws.transcript.running': '节点运行中…',
      'ws.transcript.user': '用户',
      'ws.transcript.assistant': 'Agent',
      'ws.transcript.tool': '工具调用',
      'ws.transcript.toolResult': '工具结果',
      'ws.transcript.reasoning': '推理',
      'ws.transcript.expand': '展开',
      'ws.transcript.collapse': '收起',
      'ws.transcript.args': '参数',
      'ws.transcript.result': '结果',
      'ws.transcript.close': '关闭对话',
      'ws.transcript.count': '{count} 条',
      'ws.composer.placeholder': '继续与该节点的实验 Agent 对话（会再占用资源）。',
      'ws.composer.send': '发送',
      'ws.composer.sending': '发送中…',
      'ws.composer.hint': '按 Cmd/Ctrl+Enter 发送',
      'ws.composer.needs': '本次继续将占用：{needs}',
      'ws.composer.free': '当前可用：{free}',
      'ws.composer.insufficient': '资源不足：{needs}，当前可用 {free}',
      'ws.composer.disabled.running': '节点运行中，暂时无法继续对话。',
      'ws.composer.disabled.notLeaf': '该节点已有后继节点，对话已封存只读。',
      'ws.composer.disabled.sealed': '该节点已封存，对话只读。',
      'ws.composer.disabled.status': '仅已完成的叶子节点可继续对话。',
      'ws.composer.error': '发送失败',
      'log.type.node.messaged': '节点对话',
      'log.type.node.terminated': '节点终止',
      'ws.step.running': '正在执行 Step…',
      'ws.step.cycleBusy': '上一轮循环仍在进行，请稍后再试。',
      'ws.step.summary': 'Step 完成：新建 {created} · 启动 {started}',
      'ws.step.skipped': '跳过 {count} 项',
      'ws.step.errors': '错误 {count} 条',
      'ws.step.error': 'Step 失败',
      'ws.step.dismiss': '关闭',
      'ws.busy': '执行中…',
      'ws.sealed': '已封存',
      'ws.sealed.readonly': '该节点已封存，对话只读。',
      'ws.sealed.successorHint': '在已封存基线上添加后继（从当前 HEAD 分叉）。',
      'ws.successor.action': '＋ 添加后继',
      'ws.successor.title': '在 {title} 上添加后继实验',
      'ws.successor.intro': '创建后父节点会被封存（HEAD 打 tag，对话转为只读），新节点为待执行状态。',
      'ws.successor.field.title': '标题',
      'ws.successor.field.titlePlaceholder': '例如：ridge × batch-size 交互',
      'ws.successor.field.prompt': '任务提示词',
      'ws.successor.field.promptPlaceholder': '描述在父节点基线上要执行的后继实验、约束与报告要求。',
      'ws.successor.field.criteria': '完成标准',
      'ws.successor.field.criteriaPlaceholder': '可选的验收标准。',
      'ws.successor.field.timebox': '执行时限（分钟）',
      'ws.successor.field.needs': '资源需求',
      'ws.successor.needKey': '资源',
      'ws.successor.needValue': '数量',
      'ws.successor.addNeed': '＋ 添加资源',
      'ws.successor.removeNeed': '移除资源',
      'ws.successor.submit': '创建节点',
      'ws.successor.creating': '正在创建…',
      'ws.successor.cancel': '取消',
      'ws.successor.close': '关闭后继对话框',
      'ws.successor.error': '创建后继失败',
      'ws.successor.required.title': '请填写标题',
      'ws.successor.required.prompt': '请填写任务提示词',
      'ws.successor.required.promptMin': '任务提示词至少需要 10 个字符',
      'ws.runs.open': '运行记录',
      'ws.runs.title': '运行记录',
      'ws.runs.close': '关闭运行记录',
      'ws.runs.loading': '正在加载运行记录…',
      'ws.runs.error': '无法加载运行记录',
      'ws.runs.empty': '还没有 advisor / scheduler 运行记录。',
      'ws.runs.count': '运行 {runs} · 循环 {cycles}',
      'ws.runs.tab.runs': '专家运行',
      'ws.runs.tab.cycles': '循环',
      'ws.runs.role.advisor': '专家组',
      'ws.runs.role.scheduler': '调度器',
      'ws.runs.status.running': '运行中',
      'ws.runs.status.completed': '已完成',
      'ws.runs.status.failed': '失败',
      'ws.runs.duration': '耗时 {time}',
      'ws.runs.created': '新建 {count}',
      'ws.runs.started': '启动 {count}',
      'ws.runs.rejected': '拒绝 {count}',
      'ws.runs.stopReason': '结束原因',
      'ws.runs.trigger': '触发',
      'ws.runs.skipped': '跳过 {count}',
      'ws.runs.errors': '错误 {count}',
      'ws.runs.openDetail': '查看运行详情',
      'ws.runs.back': '← 返回列表',
      'ws.runs.detail': '运行详情',
      'ws.runs.detail.loading': '正在加载运行详情…',
      'ws.runs.detail.error': '无法加载运行详情',
      'ws.runs.detail.analysis': '分析',
      'ws.runs.detail.input': '输入快照',
      'ws.runs.detail.output': '结构化输出',
      'ws.runs.detail.rejected': '被拒绝的提案',
      'ws.runs.detail.errorLabel': '错误',
      'ws.runs.detail.session': '会话',
      'ws.runs.detail.model': '模型',
      'ws.runs.detail.refresh': '刷新详情',
      'ws.runs.noSelection': '选择一条运行记录查看详情。',
      'ws.log.openRun': '查看运行',
      'log.type.cycle.started': '循环开始',
      'log.type.cycle.finished': '循环完成',
      'log.type.advisor.started': '专家组开始',
      'log.type.advisor.finished': '专家组完成',
      'log.type.scheduler.started': '调度器开始',
      'log.type.scheduler.finished': '调度器完成',
      'log.type.node.sealed': '节点封存',
      'ws.auto.title': '自动挡',
      'ws.auto.confirmTitle': '切换到自动挡？',
      'ws.auto.confirmIntro': '自动挡会持续调用模型并占用资源，达到任一预算上限后自动暂停。',
      'ws.auto.budget.cycles': '最大 cycle 数：{count}',
      'ws.auto.budget.wallClock': '最长运行时间：{hours} 小时',
      'ws.auto.budget.nodes': '节点上限：{count}',
      'ws.auto.budget.idle': '空转熔断：连续 {count} 轮无进展',
      'ws.auto.costHint': '这会持续消耗模型额度与资源。',
      'ws.auto.start': '启动自动挡',
      'ws.auto.cancel': '取消',
      'ws.auto.running': '自动运行中',
      'ws.auto.paused': '自动挡已暂停',
      'ws.auto.waiting': '等待人工确认',
      'ws.auto.off': '手动',
      'ws.auto.pause.maxCycles': '已达最大 cycle 数',
      'ws.auto.pause.maxWallClock': '已达最长运行时间',
      'ws.auto.pause.maxNodes': '已达节点上限',
      'ws.auto.pause.noProgress': '连续多轮没有新进展',
      'ws.auto.pause.idle': '空转熔断',
      'ws.auto.pause.errors': '连续错误过多',
      'ws.auto.pause.awaitingConfirmation': '等待人工确认提案',
      'ws.auto.pause.hostRestarted': 'Host 重启后自动挡已停止，请确认后继续',
      'ws.auto.pause.unknown': '未知原因',
      'ws.auto.cycles': 'cycle {count}/{max}',
      'ws.auto.elapsed': '已运行 {time}',
      'ws.auto.resume': '继续',
      'ws.auto.stop': '停止',
      'ws.auto.viewPending': '查看待确认',
      'ws.auto.busy': '正在切换…',
      'ws.auto.error': '自动挡操作失败',
      'ws.confirm.approveTitle': '批准该提案？',
      'ws.confirm.approveBody': '批准后节点进入待执行队列；若这是父节点的第一个子节点，父节点将被封存。',
      'ws.confirm.rejectTitle': '拒绝该提案？',
      'ws.confirm.rejectBody': '提案将被删除，父节点保持可继续对话。',
      'ws.confirm.approve': '批准',
      'ws.confirm.reject': '拒绝',
      'ws.confirm.cancel': '取消',
      'ws.confirm.close': '关闭确认',
      'ws.proposed.badge': '待确认',
      'ws.proposed.title': '待确认提案',
      'ws.proposed.rationale': '提案理由',
      'ws.proposed.infoGain': '预期信息增益',
      'ws.proposed.createdAt': '提案时间',
      'ws.proposed.run': '提案运行',
      'ws.proposed.approve': '✓ 批准',
      'ws.proposed.reject': '✕ 拒绝',
      'ws.proposed.working': '处理中…',
      'ws.inspector.needs': '资源需求',
      'ws.inspector.saveNeeds': '保存资源需求',
      'ws.inspector.noNeeds': '无资源需求',
      'ws.inspector.needsInvalid': '资源名或数量无效',
      'ws.settings.open': '项目设置',
      'ws.settings.title': '项目设置',
      'ws.settings.close': '关闭项目设置',
      'ws.settings.section.advisor': '专家组与确认',
      'ws.settings.section.auto': '自动挡预算',
      'ws.settings.section.limits': '运行上限',
      'ws.settings.section.pools': '资源池',
      'ws.settings.section.models': '角色模型（可选）',
      'ws.settings.section.prompts': '提示词覆盖（可选）',
      'ws.settings.acceptMode': '新提案接入模式',
      'ws.settings.acceptMode.auto': '自动采纳',
      'ws.settings.acceptMode.confirm': '人工确认',
      'ws.settings.acceptMode.hint': '人工确认模式下新提案先进入待确认队列，不阻塞已建立节点的执行。',
      'ws.settings.maxProposalsPerPass': '每轮最多提案数',
      'ws.settings.maxPendingProposals': '待确认提案上限',
      'ws.settings.maxCycles': '最大 cycle 数',
      'ws.settings.maxWallClockMinutes': '最长运行时间（分钟）',
      'ws.settings.idleCycleLimit': '空转熔断（连续无进展轮数）',
      'ws.settings.nodeTimeoutMinutes': '默认执行时限（分钟）',
      'ws.settings.maxNodeTimeoutMinutes': '单节点时限上限（分钟）',
      'ws.settings.maxRunningNodes': '并发节点上限',
      'ws.settings.maxNodes': '节点总数上限',
      'ws.settings.pools.hint': '键值对，例如 gpu: 1。',
      'ws.settings.models.hint': '留空使用 profile 默认模型；同时填写 provider 与 model 才生效。',
      'ws.settings.model.provider': 'provider',
      'ws.settings.model.model': 'model',
      'ws.settings.model.worker': 'worker',
      'ws.settings.model.advisor': 'advisor',
      'ws.settings.model.scheduler': 'scheduler',
      'ws.settings.prompts.workerPrefix': 'worker 前缀',
      'ws.settings.prompts.advisor': 'advisor 提示词',
      'ws.settings.prompts.scheduler': '项目内实验调度提示词（不分配 GPU）',
      'ws.settings.prompts.schedulerHint': '这段提示词只决定本项目哪些 planned 节点先开始；GPU 能否启动由集群协调器决定，节点可能排队等待整卡。',
      'ws.settings.clusterPriority': '集群调度优先级（0–100）',
      'ws.settings.clusterPriorityHint': '多个项目竞争同一块 GPU 时，数值越大越早获得协调器租约；仅在集群模式下有意义。',
      'ws.settings.clusterPriority.invalid': '集群调度优先级需要在 0–100 之间',
      'ws.cluster.twoLayerNote': '协调器是 GPU 准入的最终权威；项目内 scheduler/自动挡只是提出启动请求，GPU 节点可能排队等待整卡。',
      'ws.cluster.waitSchedulerHint': '等待集群协调器发放整卡；项目 scheduler 无法预留 GPU。',
      'ws.settings.save': '保存设置',
      'ws.settings.saving': '正在保存…',
      'ws.settings.reset': '重置',
      'ws.settings.cancel': '取消',
      'ws.settings.invalid': '请检查数字字段与资源池设置',
      'ws.settings.error': '保存设置失败',
      'ws.settings.saved': '设置已保存',
      'ws.gc.title': '善后报告（GC）',
      'ws.gc.cause': '原因',
      'ws.gc.leftovers': '残留',
      'ws.gc.cleanupRequested': '已请求清理',
      'ws.gc.recommendation': '建议',
      'ws.gc.summary': '摘要',
      'ws.gc.run': '善后运行',
      'ws.gc.empty': '无',
      'ws.gc.openRun': '查看善后运行',
      'ws.runs.role.gc': '善后',
      'log.type.gc.started': '善后开始',
      'log.type.gc.finished': '善后完成',
      'log.type.auto.resumed': '自动挡继续',
      'log.type.auto.paused': '自动挡暂停',
      'landing.delete': '删除项目',
      'landing.delete.confirmTitle': '删除项目「{name}」？',
      'landing.delete.body': '项目记录与节点数据将被删除。Git 分支与 tag 默认保留。',
      'landing.delete.worktrees': '同时删除节点 worktree（Git 分支与 tag 保留）',
      'landing.delete.warning': '此操作不可撤销。',
      'landing.delete.confirm': '删除项目',
      'landing.delete.cancel': '取消',
      'landing.delete.deleting': '正在删除…',
      'landing.delete.error': '删除项目失败',
      'landing.delete.error.project_busy': '项目仍有节点在运行，无法删除',
      'landing.delete.error.project_not_found': '项目不存在或已被删除',
      'landing.delete.close': '关闭删除确认',
      'ws.projectMenu': '项目操作',
      'ws.projectMenu.delete': '删除项目',
      'ws.projectMenu.close': '关闭项目菜单',
      'ws.retry.action': '↻ 重试',
      'ws.retry.cancelled': '↻ 重新运行',
      'ws.retry.cancelledHint': '节点被取消后不能原地恢复；重新运行会创建一个新 attempt（保留历史）。',
      'ws.retry.cancelledConfirmTitle': '重新运行已取消的节点？',
      'ws.retry.cancelledConfirmBody': '取消的节点不能原地恢复；会保留历史并创建一个新的 attempt 重新执行。若自动挡已暂停，重新运行后请点自动挡条的「继续」。',
      'ws.retry.confirmTitle': '重试该失败节点？',
      'ws.retry.confirmBody': '启动阶段失败会回到待执行并重新启动；运行阶段失败会发送重试跟进消息并重新运行。',
      'ws.retry.confirm': '重试',
      'ws.retry.cancel': '取消',
      'ws.retry.busy': '正在重试…',
      'ws.retry.error': '重试失败',
      'ws.merge.createAction': '⊕ 创建合并节点',
      'ws.merge.createTitle': '创建合并节点',
      'ws.merge.close': '关闭合并节点对话框',
      'ws.merge.intro': '选择 2–4 个已完成节点作为父节点；创建后父节点将封存。',
      'ws.merge.parents': '父节点（2–4 个）',
      'ws.merge.selected': '已选 {count}/{max}',
      'ws.merge.field.title': '标题',
      'ws.merge.field.titlePlaceholder': '例如：合并 lr sweep 与 ridge sweep',
      'ws.merge.field.prompt': '合并说明（可选）',
      'ws.merge.field.promptPlaceholder': '说明如何融合各分支的证据；留空使用默认合并提示词。',
      'ws.merge.field.timebox': '执行时限（分钟）',
      'ws.merge.submit': '创建合并节点',
      'ws.merge.creating': '正在创建…',
      'ws.merge.required.parents': '请选择 2–4 个父节点',
      'ws.merge.required.title': '请填写标题',
      'ws.merge.error': '创建合并失败',
      'ws.merge.badge': '⊕ 合并',
      'ws.merge.parentCount': '{count} 父节点',
      'ws.merge.title': '合并状态',
      'ws.merge.state.pending': '待合并',
      'ws.merge.state.conflict': '存在冲突',
      'ws.merge.state.clean': '无冲突',
      'ws.merge.state.committed': '已提交',
      'ws.merge.conflicts': '冲突文件',
      'ws.merge.prepared': '父节点基线',
      'ws.merge.finish': '✓ 完成合并',
      'ws.merge.finishTitle': '完成合并',
      'ws.merge.finishIntro': '确认冲突已解决后提交合并；可选填写合并摘要。',
      'ws.merge.finishSummary': '合并摘要（可选）',
      'ws.merge.finishSubmit': '提交合并',
      'ws.merge.finishing': '正在提交…',
      'ws.merge.conflictsError': '合并仍有冲突：{message}',
      'ws.merge.finishError': '完成合并失败',
      'ws.merge.parentsTitle': '父节点',
      'ws.merge.headCommit': '合并提交',
      'ws.merge.committedAt': '合并时间',
      'ws.merge.lastReport': '最近报告',
      'ws.merge.clean': '干净',
      'ws.merge.dirty': '有冲突',
      'ws.merge.composerPlaceholder': '向合并 Agent 说明如何解决冲突或继续合并…',
      'ws.merge.composerHint': '合并运行中可以直接与合并 Agent 对话。',
      'ws.merge.contributors': '合并来源',
      'ws.settings.section.reviewers': '异构评审组',
      'ws.settings.reviewers.hint': '最多 4 个评审；lens 是评审视角（例如 stats / systems / skeptic）。',
      'ws.settings.reviewer.add': '＋ 添加评审',
      'ws.settings.reviewer.remove': '移除评审',
      'ws.settings.reviewer.lens': '视角 (lens)',
      'ws.settings.reviewer.provider': 'provider',
      'ws.settings.reviewer.model': 'model',
      'ws.settings.reviewer.effort': '推理强度',
      'ws.settings.reviewer.effort.auto': '默认',
      'ws.settings.reviewer.max': '最多 4 个评审',
      'ws.settings.maxTokens': '自动挡 token 预算（0 = 关闭）',
      'ws.runs.lens': '视角 {lens}',
      'ws.runs.lensLabel': '评审视角',
      'ws.runs.panelLabel': '评审组人数',
      'ws.runs.panel': '评审组 {count}',
      'ws.usage.title': 'Token 用量',
      'ws.usage.total': '总计 {count}',
      'ws.usage.input': '输入 {count}',
      'ws.usage.output': '输出 {count}',
      'ws.usage.cacheRead': '缓存读 {count}',
      'ws.usage.cacheWrite': '缓存写 {count}',
      'ws.usage.chip': '{count} tokens',
      'ws.auto.tokens': 'tokens {used}/{max}',
      'ws.auto.pause.maxTokens': '已达 token 预算',
      'ws.projectMenu.push': '推送分支与 tag',
      'ws.push.title': '推送分支与 tag',
      'ws.push.close': '关闭推送对话框',
      'ws.push.intro': '把插件管理的 Git 分支与封存 tag 推送到远端仓库。',
      'ws.push.remote': '远端名称',
      'ws.push.remotePlaceholder': 'origin',
      'ws.push.submit': '推送',
      'ws.push.pushing': '正在推送…',
      'ws.push.error': '推送失败',
      'ws.push.done': '已推送 {count} 个引用',
      'ws.push.stdout': '输出',
      'ws.push.nothingToPush': '没有可推送的引用',
      'ws.push.gitPushFailed': 'git push 失败',
      'ws.push.cancel': '取消',
      'ws.model.title': '模型',
      'ws.model.inherit': '继承项目默认',
      'ws.model.inheritHint': '留空时沿用项目角色或默认模型',
      'ws.model.effort': '推理强度',
      'ws.model.effort.inherit': '默认强度',
      'ws.model.free': '手动填写 provider / model',
      'ws.model.freeProvider': 'provider',
      'ws.model.freeModel': 'model',
      'ws.model.resolved': '生效模型',
      'ws.model.source': '模型来源',
      'ws.model.none': '未指定',
      'ws.model.loading': '正在加载模型列表…',
      'ws.model.error': '模型列表加载失败',
      'ws.model.retry': '重新加载模型',
      'ws.model.unavailable': '不可用：{reason}',
      'ws.model.tags': '标签：{tags}',
      'ws.model.priceIn': '输入 ${price}/M',
      'ws.model.priceOut': '输出 ${price}/M',
      'ws.model.context': '上下文 {count}',
      'ws.inspector.saveModel': '保存模型',
      'ws.model.source.user': '用户指定',
      'ws.model.source.advisor': '顾问选择',
      'ws.model.source.escalation': '自动升级',
      'ws.model.source.project-role': '项目角色默认',
      'ws.model.source.project-default': '项目默认',
      'ws.model.source.default': '全局默认',
      'ws.attempts.title': '尝试记录',
      'ws.attempts.index': '第 {index} 次',
      'ws.attempts.model': '模型',
      'ws.attempts.status': '状态',
      'ws.attempts.duration': '耗时',
      'ws.attempts.tokens': 'Tokens',
      'ws.attempts.cost': '成本',
      'ws.attempts.error': '错误：{message}',
      'ws.attempts.stopReason': '终止：{reason}',
      'ws.attempts.empty': '还没有尝试记录',
      'ws.attempts.running': '运行中',
      'ws.cost.total': '累计成本',
      'ws.cost.unpriced': '未计价',
      'ws.cost.chip': '${amount}',
      'ws.escalate.action': '⇧ 用更强模型重试',
      'ws.escalate.busy': '正在升级…',
      'ws.escalate.error': '升级失败',
      'ws.escalate.hint': '使用下一档更强模型开始一次新尝试',
      'ws.auto.cost': 'cost {used}/{max}',
      'ws.auto.pause.maxCost': '已达成本预算',
      'ws.auto.pause.resourcesQueued': '集群资源排队中',
      'ws.settings.section.routing': '路由与升级',
      'ws.settings.routing.hint': '控制顾问选模、失败自动升级与单节点最大尝试次数。',
      'ws.settings.advisorMaySelectModels': '允许顾问选择模型',
      'ws.settings.autoUpgrade': '失败后自动升级模型',
      'ws.settings.maxAttempts': '单节点最大尝试次数',
      'ws.settings.maxCostUsd': '自动挡成本预算 USD（0 = 关闭）',
      'ws.settings.section.modelOptions': '模型选项',
      'ws.settings.modelOptions.hint': '定义可路由的模型档位；每项包含 id、provider、model 与价格（每百万 token）。',
      'ws.settings.modelOption.add': '＋ 添加模型选项',
      'ws.settings.modelOption.remove': '移除模型选项',
      'ws.settings.modelOption.id': 'ID',
      'ws.settings.modelOption.provider': 'provider',
      'ws.settings.modelOption.model': 'model',
      'ws.settings.modelOption.effort': '默认推理强度',
      'ws.settings.modelOption.tags': '标签（逗号分隔）',
      'ws.settings.modelOption.priceIn': '输入价格/M',
      'ws.settings.modelOption.priceOut': '输出价格/M',
      'ws.settings.cluster.title': '集群状态（只读）',
      'ws.settings.cluster.hint': '在顶部集群面板中查看并刷新详细租约与队列。',
      'ws.settings.cluster.mode': '模式：{mode}',
      'ws.settings.cluster.connected': '协调器已连接',
      'ws.settings.cluster.disconnected': '协调器未连接',
      'ws.settings.cluster.machines': '机器：{count}',
      'ws.settings.cluster.queue': '队列：{count}',
      'ws.settings.cluster.pools': '资源池：{pools}',
      'ws.cluster.chip': '{mode} · GPU {free}/{total} · 队列 {queue}',
      'ws.cluster.title': '集群协调器',
      'ws.cluster.close': '关闭集群面板',
      'ws.cluster.refresh': '刷新',
      'ws.cluster.refreshing': '刷新中…',
      'ws.cluster.loading': '正在加载集群状态…',
      'ws.cluster.error': '集群状态加载失败',
      'ws.cluster.disabled': '集群未启用',
      'ws.cluster.mode': '模式',
      'ws.cluster.instance': '实例',
      'ws.cluster.machine': '机器',
      'ws.cluster.connected': '协调器连接',
      'ws.cluster.coordinator': '协调器地址',
      'ws.cluster.heartbeat': '最近心跳',
      'ws.cluster.pools': '资源池',
      'ws.cluster.machines': '机器与设备',
      'ws.cluster.devices': '设备',
      'ws.cluster.memory': '显存 {memory} MiB',
      'ws.cluster.leases': '租约',
      'ws.cluster.queueTitle': '排队请求',
      'ws.cluster.usage': '使用统计',
      'ws.cluster.empty': '暂无数据',
      'ws.cluster.byMachine': '按机器：{detail}',
      'ws.cluster.mode.local': '本地',
      'ws.cluster.mode.coordinator': '协调器',
      'ws.cluster.mode.client': '客户端',
      'ws.cluster.mode.both': '双向',
      'ws.cluster.nodeWait': '等待资源（{pool}×{amount}）',
      'ws.cluster.nodeWaitPosition': '队列位置 {position}',
      'ws.cluster.nodeWaitReason': '原因：{reason}',
      'ws.cluster.lease': '租约',
      'ws.cluster.leaseMachine': '机器：{machine}',
      'ws.cluster.leaseDevices': '设备：{devices}',
      'ws.cluster.leaseExpires': '到期：{time}',
      'ws.cluster.leaseExpiresLabel': '租约到期',
      'ws.cluster.waitHint': '资源排队中，暂时无法启动或重试',
      'ws.cluster.queued': '队列 {count}',
      'ws.cluster.poolRow': '{pool}: {used}/{total}（空闲 {free}）',
      'ws.cluster.leaseHolder': '持有者',
      'ws.cluster.leaseNode': '节点',
      'ws.cluster.queueNode': '节点',
      'ws.cluster.queueAmount': '数量',
      'log.type.node/resource_waiting': '节点等待资源',
      'log.type.node/resource_granted': '节点获得资源',
      'log.type.node/resource_lost': '节点资源丢失',
      'log.type.node/escalated': '节点模型升级',
      'log.type.node/model_changed': '节点模型变更',
      'log.type.node/retried': '节点重试',
      'landing.clusterConfig': '集群设置',
      'ws.projectMenu.clusterConfig': '集群设置',
      'ws.clusterConfig.title': '集群设置',
      'ws.clusterConfig.close': '关闭集群设置',
      'ws.clusterConfig.loading': '正在加载集群配置…',
      'ws.clusterConfig.loadError': '集群配置加载失败',
      'ws.clusterConfig.reload': '重新加载',
      'ws.clusterConfig.reloading': '重新加载中…',
      'ws.clusterConfig.save': '保存并应用',
      'ws.clusterConfig.saving': '正在应用…',
      'ws.clusterConfig.saved': '配置已保存并热应用',
      'ws.clusterConfig.noChanges': '没有需要应用的更改',
      'ws.clusterConfig.canApplyFalse': '当前无法应用配置',
      'ws.clusterConfig.status.title': '集群状态',
      'ws.clusterConfig.status.path': '配置文件',
      'ws.clusterConfig.status.enabled': '启用',
      'ws.clusterConfig.status.mode': '模式',
      'ws.clusterConfig.status.connected': '协调器连接',
      'ws.clusterConfig.status.blocked': '启动受阻',
      'ws.clusterConfig.status.claimConflict': '机器声明冲突',
      'ws.clusterConfig.status.error': '错误',
      'ws.clusterConfig.status.clusterId': 'clusterId',
      'ws.clusterConfig.status.coordinatorId': 'coordinatorId',
      'ws.clusterConfig.status.url': '访问地址',
      'ws.clusterConfig.status.machines': '机器/设备',
      'ws.clusterConfig.status.pools': '资源池',
      'ws.clusterConfig.status.activeLeases': '当前有 {count} 个节点持有 GPU 租约；变更配置前请等待或停止这些节点。',
      'ws.clusterConfig.status.warnings': '警告',
      'ws.clusterConfig.status.disabled': '集群未启用（本地模式）',
      'ws.clusterConfig.section.basic': '基础',
      'ws.clusterConfig.enabled': '启用集群',
      'ws.clusterConfig.enabledHint': '启用后本实例会以协调器或客户端身份加入集群。',
      'ws.clusterConfig.role': '角色',
      'ws.clusterConfig.role.coordinator': '协调器',
      'ws.clusterConfig.role.client': '客户端',
      'ws.clusterConfig.role.both': '两者',
      'ws.clusterConfig.clusterId': 'clusterId',
      'ws.clusterConfig.machineId': 'machineId',
      'ws.clusterConfig.userId': 'userId',
      'ws.clusterConfig.priority': '优先级',
      'ws.clusterConfig.section.token': '认证',
      'ws.clusterConfig.token': '共享 token',
      'ws.clusterConfig.token.setHint': '已设置，留空保持不变',
      'ws.clusterConfig.token.emptyHint': '未设置；启用集群前建议设置共享 token。',
      'ws.clusterConfig.token.clear': '清除 token',
      'ws.clusterConfig.token.cleared': '保存后将清除 token',
      'ws.clusterConfig.token.undoClear': '撤销清除',
      'ws.clusterConfig.section.timing': '心跳与租约',
      'ws.clusterConfig.heartbeat': '心跳间隔（秒）',
      'ws.clusterConfig.leaseTtl': '租约有效期（分钟）',
      'ws.clusterConfig.section.devices': '设备',
      'ws.clusterConfig.devices.mode': '设备模式',
      'ws.clusterConfig.devices.auto': '自动探测（nvidia-smi）',
      'ws.clusterConfig.devices.manual': '手动列表',
      'ws.clusterConfig.devices.add': '＋ 添加设备',
      'ws.clusterConfig.devices.remove': '移除设备',
      'ws.clusterConfig.devices.id': '设备 ID',
      'ws.clusterConfig.devices.model': '型号',
      'ws.clusterConfig.devices.memory': '显存 MiB',
      'ws.clusterConfig.devices.empty': '没有手动设备',
      'ws.clusterConfig.section.options': '选项',
      'ws.clusterConfig.dashboard': '启用 Web 看板',
      'ws.clusterConfig.allowMultipleCoordinators': '允许同机多个协调器',
      'ws.clusterConfig.advanced': '高级设置',
      'ws.clusterConfig.advanced.show': '展开高级设置',
      'ws.clusterConfig.advanced.hide': '收起高级设置',
      'ws.clusterConfig.advanced.hint': '仅在明确需要自定义监听地址、claim 目录或状态文件时修改。',
      'ws.clusterConfig.instanceId': 'instanceId',
      'ws.clusterConfig.coordinatorId': 'coordinatorId',
      'ws.clusterConfig.url': '协调器 URL（客户端角色）',
      'ws.clusterConfig.urlHint': '客户端角色需要填写协调器地址，例如 {example}',
      'ws.clusterConfig.listenHost': '监听地址',
      'ws.clusterConfig.listenPort': '监听端口',
      'ws.clusterConfig.claimDir': 'claim 目录',
      'ws.clusterConfig.stateFile': '状态文件',
      'ws.clusterConfig.action.dashboard': '打开看板',
      'ws.clusterConfig.action.copyUrl': '复制协调器地址',
      'ws.clusterConfig.action.copied': '已复制',
      'ws.clusterConfig.action.copyFailed': '复制失败，请手动选择',
      'ws.clusterConfig.action.stopCluster': '关闭集群',
      'ws.clusterConfig.action.stopConfirm': '确认关闭集群？关闭后将回到本地模式。',
      'ws.clusterConfig.action.stopConfirmYes': '确认关闭',
      'ws.clusterConfig.action.stopCancel': '取消',
      'ws.clusterConfig.closing': '正在关闭…',
      'ws.clusterConfig.dashboardUnavailable': '当前没有可打开的看板地址',
      'ws.clusterConfig.error.busy': '仍有节点持有 GPU 租约，无法应用集群配置；请等待任务完成或停止相关节点后重试。',
      'ws.clusterConfig.error.invalid': '集群配置无效',
      'ws.clusterConfig.error.unavailable': 'Host 未启用集群管理',
      'ws.clusterConfig.warning.title': '警告',
      'ws.clusterConfig.devices.summary': '{count} 个设备',
      'ws.clusterConfig.pools.summary': 'GPU {free}/{total}',
      'ws.clusterConfig.roleHint': '协调器负责调度与租约；客户端负责执行节点；两者可在单机同时启用。',
      'ws.clusterConfig.appliedNote': '已热应用，无需重启插件。',
      'ws.clusterConfig.token.copyHint': '出于安全考虑 token 只显示掩码，从不回传明文。',
      'ws.clusterConfig.fleet.title': '远程 GPU 机器（Fleet over SSH）',
      'ws.clusterConfig.fleet.hint': '控制机 DSH 可能没有本地 GPU；worker 会通过 SSH 进入远程容器执行，代码/worktree 位于共享 NFS。若容器内看到的路径与本地不同，请设置路径映射（Windows 本机路径如 C:\\... 必须映射到容器内 POSIX/NFS 路径）。',
      'ws.clusterConfig.fleet.show': '展开远程舰队设置',
      'ws.clusterConfig.fleet.hide': '收起远程舰队设置',
      'ws.clusterConfig.fleet.enabled': '启用远程舰队',
      'ws.clusterConfig.fleet.placementMode': '放置模式',
      'ws.clusterConfig.fleet.placement.local': '仅本地 GPU',
      'ws.clusterConfig.fleet.placement.fleet': '仅远程舰队',
      'ws.clusterConfig.fleet.placement.auto': '自动（优先本地，不足转远程）',
      'ws.clusterConfig.fleet.masterPort': 'Master 通信端口',
      'ws.clusterConfig.fleet.pathMap': '全局路径映射（本地 → 容器/NFS）',
      'ws.clusterConfig.fleet.pathMap.add': '＋ 添加路径映射',
      'ws.clusterConfig.fleet.pathMap.from': '本地路径',
      'ws.clusterConfig.fleet.pathMap.to': '远程路径',
      'ws.clusterConfig.fleet.pathMap.remove': '移除路径映射',
      'ws.clusterConfig.fleet.machines': '远程机器',
      'ws.clusterConfig.fleet.machines.empty': '还没有远程机器',
      'ws.clusterConfig.fleet.machine.add': '＋ 添加远程机器',
      'ws.clusterConfig.fleet.machine.remove': '移除远程机器',
      'ws.clusterConfig.fleet.machine.id': 'machineId',
      'ws.clusterConfig.fleet.machine.masterAddr': 'masterAddr（可选）',
      'ws.clusterConfig.fleet.machine.advanced': '机器高级设置',
      'ws.clusterConfig.fleet.machine.pathMap': '该机器的路径映射',
      'ws.clusterConfig.fleet.ssh.host': 'SSH 主机',
      'ws.clusterConfig.fleet.ssh.user': 'SSH 用户',
      'ws.clusterConfig.fleet.ssh.port': 'SSH 端口',
      'ws.clusterConfig.fleet.ssh.keyPath': 'SSH 私钥路径',
      'ws.clusterConfig.fleet.ssh.options': 'SSH 额外选项（每行一个）',
      'ws.clusterConfig.fleet.ssh.command': 'SSH 命令（默认 ssh）',
      'ws.clusterConfig.fleet.container.runtime': '容器运行时',
      'ws.clusterConfig.fleet.container.name': '容器名',
      'ws.clusterConfig.fleet.container.workdir': '容器工作目录',
      'ws.clusterConfig.fleet.container.user': '容器内用户',
      'ws.clusterConfig.fleet.container.env': '环境变量（每行 KEY=VALUE）',
      'ws.clusterConfig.fleet.container.env.invalid': '环境变量每行应为 KEY=VALUE 格式',
      'ws.clusterConfig.fleet.devices': '设备',
      'ws.clusterConfig.fleet.devices.auto': '自动探测（SSH nvidia-smi）',
      'ws.clusterConfig.fleet.devices.manual': '手动设备列表',
      'ws.clusterConfig.fleet.devices.add': '＋ 添加设备',
      'ws.clusterConfig.fleet.devices.remove': '移除设备',
      'ws.clusterConfig.fleet.devices.id': '设备 ID',
      'ws.clusterConfig.fleet.devices.localId': 'localId',
      'ws.clusterConfig.fleet.devices.model': '型号',
      'ws.clusterConfig.fleet.devices.memory': '显存 MiB',
      'ws.cluster.fleet.title': '远程舰队',
      'ws.cluster.fleet.machine': '机器',
      'ws.cluster.fleet.ssh': 'SSH 端点',
      'ws.cluster.fleet.container': '容器',
      'ws.cluster.fleet.devices': '设备',
      'ws.cluster.fleet.status': '状态',
      'ws.cluster.fleet.online': '在线',
      'ws.cluster.fleet.offline': '离线',
      'ws.cluster.fleet.empty': '没有远程舰队机器',
      'ws.cluster.fleet.placement': '放置模式',
      'ws.fleet.badge': '远程舰队 · {machines}机{gpus}卡',
      'ws.fleet.panel': '远程舰队租约',
      'ws.fleet.placement': '放置',
      'ws.fleet.placement.local': '本地',
      'ws.fleet.placement.fleet': '远程舰队',
      'ws.fleet.machines': '机器与设备',
      'ws.fleet.masterPort': 'Master 端口',
      'ws.fleet.remoteDir': '远程管线目录',
      'ws.fleet.workerHint': 'worker 会自动使用 Host 在 worktree 生成的 .dshex-run/remote.sh / launch.sh 包装脚本在远程机器上执行；这些脚本由 Host 维护，请勿手动修改。',
      'ws.fleet.needsHint': '远程机器数（≤ gpu 总数）— 仅 fleet 模式生效。',
      'ws.fleet.machineRow': '{machineId}：{devices}',
      'ws.fleet.devicesNone': '（自动）',
      'ws.settings.section.placement': 'GPU 节点分配诉求（自然语言）',
      'ws.settings.placement.text': '分配诉求',
      'ws.settings.placement.placeholder': '例如：必须使用 A100；尽量同一机架；NVLink 互联；不要 H100。',
      'ws.settings.placement.hint': '仅对远程舰队（fleet）GPU 节点生效；协调器强制执行“必须/排除”规则，“优先”规则用于排序。',
      'ws.settings.placement.compile': '解析预览',
      'ws.settings.placement.compiling': '正在解析…',
      'ws.settings.placement.save': '保存策略',
      'ws.settings.placement.saving': '正在保存…',
      'ws.settings.placement.clear': '清除策略',
      'ws.settings.placement.clearing': '正在清除…',
      'ws.settings.placement.needCompile': '请先解析预览，再保存策略。',
      'ws.settings.placement.preview': '解析结果',
      'ws.settings.placement.summary': '摘要',
      'ws.settings.placement.explanation': '规则说明',
      'ws.settings.placement.warnings': '警告',
      'ws.settings.placement.catalog': '可用标签与 GPU 型号',
      'ws.settings.placement.catalogEmpty': '当前 fleet 没有可用标签或 GPU 型号；配置 Fleet 后策略才会生效。',
      'ws.settings.placement.machineCount': '已配置 {count} 台 fleet 机器',
      'ws.settings.placement.savedPolicy': '已保存策略',
      'ws.settings.placement.status.saved': '已保存',
      'ws.settings.placement.status.unsaved': '未保存改动',
      'ws.settings.placement.status.empty': '未设置',
      'ws.settings.placement.status.previewed': '已解析，待保存',
      'ws.settings.placement.savedMessage': '分配策略已保存',
      'ws.settings.placement.clearedMessage': '分配策略已清除',
      'ws.settings.placement.error': '分配策略操作失败',
      'ws.settings.placement.invalid': '分配策略无效',
      'ws.settings.placement.rules': '规则',
      'ws.settings.placement.rule.requireLabels': '{key}={values}（必须）',
      'ws.settings.placement.rule.requireModel': 'GPU 型号 = {values}（必须）',
      'ws.settings.placement.rule.excludeModel': '排除 GPU 型号：{values}',
      'ws.settings.placement.rule.requireMachines': '必须机器：{values}',
      'ws.settings.placement.rule.excludeMachines': '排除机器：{values}',
      'ws.settings.placement.rule.excludeLabels': '{key}={values}（排除）',
      'ws.settings.placement.rule.colocate': '{key} 相同（必须）',
      'ws.settings.placement.rule.preferColocate': '{key} 相同（优先）',
      'ws.settings.placement.rule.preferLabels': '{key}={values}（优先）',
      'ws.settings.placement.rule.preferModel': 'GPU 型号 = {values}（优先）',
      'ws.settings.placement.rule.preferMachines': '优先机器：{values}',
      'ws.settings.placement.noRules': '没有已编译规则',
      'ws.settings.placement.compiledAt': '编译时间 {time}',
      'ws.clusterConfig.fleet.machine.labels': 'labels 键值',
      'ws.clusterConfig.fleet.machine.labelsHint': '自然语言分配策略会匹配这些标签（如 gpu=a100、rack=rack-a、interconnect=nvlink）与 GPU 型号。',
      'ws.clusterConfig.fleet.machine.labels.add': '＋ 添加标签',
      'ws.clusterConfig.fleet.machine.labels.key': '键',
      'ws.clusterConfig.fleet.machine.labels.value': '值',
      'ws.clusterConfig.fleet.machine.labels.remove': '移除标签',
      'ws.cluster.fleet.labels': '标签',
      'ws.fleet.labels': '标签',
      'ws.fleet.noLabels': '（无标签）',
      'ws.native.title': '会话与轨迹（DSH 原生）',
      'ws.native.hint': '轨迹时间线、搜索、折叠与工具调用详情由 DSH 原生 Conversation 提供；插件不再渲染自有对话记录。',
      'ws.native.trajectory': '在 DSH 中打开轨迹',
      'ws.native.chat': '在 DSH 中打开对话',
      'ws.native.sessionId': 'Session',
      'ws.native.attempts': '尝试会话',
      'ws.native.attemptOpen': '尝试 {index} 轨迹',
      'ws.native.openFailed': '无法打开原生会话',
      'ws.native.noSession': '该节点还没有可打开的会话',
      'ws.native.devHint': '如果 Trajectory 标签未显示，请在 DSH 设置 → 通用 → 显示代码工作视图 中开启；未开启时会自动回退到对话。',
      'ws.native.continue': '继续对话',
      'ws.native.continueTitle': '继续对话',
      'ws.native.continueHint': '消息通过 node.message 发送给该节点的 agent；历史轨迹请在 DSH 原生视图中只读查看。',
      'ws.native.continuePlaceholder': '向该节点 agent 发送消息…',
      'ws.native.continueSend': '发送',
      'ws.native.continueSending': '发送中…',
      'ws.native.continueClose': '关闭',
      'ws.native.continueSuccess': '消息已发送',
      'ws.native.continueError': '发送失败',
      'ws.native.continueDisabled': '当前节点状态不允许继续对话',
      'ws.native.continueNeeds': '需要 {needs} · 空闲 {free}',
      'ws.native.continueInsufficient': '资源不足：需要 {needs} · 空闲 {free}',
      'ws.native.runningMerge': '合并运行中；消息会直接发给合并 agent。',
      'ws.native.cardHint': '双击打开 DSH 原生轨迹',
      'ws.native.noAttempts': '没有尝试记录',
      'ws.native.openTrajectoryShort': '轨迹',
      'ws.native.openChatShort': '对话',
      'crash.title': '面板渲染异常',
      'crash.hint': '错误已被隔离，页面其余部分不受影响。',
    };

    const en = {
      panel: 'Research Lab',
      title: 'MetaInfer Research Lab',
      subtitle: 'Organise research experiments as a living DAG: every node owns its own git worktree and subagent session.',
      badge: 'M1 · projects & DAG canvas',
      'intl.locale': 'en-US',

      'common.retry': 'Retry',
      'common.refresh': 'Refresh',
      'common.cancel': 'Cancel',
      'common.save': 'Save',
      'common.remove': 'Remove',
      'common.loading': 'Loading…',
      'common.unknown': 'Unknown',
      'common.none': '—',

      'error.network': 'Could not reach the Host service',
      'error.http': 'Request failed (HTTP {status})',
      'error.unknown': 'Request failed',
      'error.unauthorized': 'Not authorised',

      'landing.projects.title': 'Experiment projects',
      'landing.projects.count': '{count} projects',
      'landing.projects.empty': 'No projects yet — create your first one on the right.',
      'landing.projects.loading': 'Loading projects…',
      'landing.projects.error': 'Could not load the project list',
      'landing.projects.open': 'Open',
      'landing.projects.nodes': '{count} nodes',
      'landing.projects.updated': 'Updated {time}',
      'landing.projects.mode.manual': 'Manual',
      'landing.projects.mode.auto': 'Auto',
      'landing.host.ready': 'Host service ready',
      'landing.host.down': 'Host service unavailable',
      'landing.host.version': 'version {version}',

      'wizard.title': 'New project',
      'wizard.intro': 'Bind a Git repository and write the root node instruction.',
      'wizard.section.repo': '① Bind a Git repository',
      'wizard.section.research': '② Research setup',
      'wizard.repoPath': 'Repository path',
      'wizard.repoPath.placeholder': '/absolute/path/to/git/repo',
      'wizard.repoPath.required': 'Enter a repository path first',
      'wizard.validate': 'Validate repository',
      'wizard.validating': 'Validating…',
      'wizard.repo.valid': 'Repository validated',
      'wizard.repo.root': 'Repository root',
      'wizard.repo.gitDir': 'Git directory',
      'wizard.repo.baseBranch': 'Base branch',
      'wizard.repo.commit': 'Base commit',
      'wizard.repo.branches': '{count} branches',
      'wizard.repo.dirty': 'Working tree has uncommitted changes',
      'wizard.repo.clean': 'Working tree clean',
      'wizard.repo.error': 'Repository validation failed',
      'wizard.repo.error.invalid_repo': 'The path is not a valid Git repository',
      'wizard.repo.error.not_git': 'The directory is not a Git repository',
      'wizard.repo.error.bare': 'Bare repositories are not supported',
      'wizard.repo.error.bad_path': 'The path is invalid or unreadable',
      'wizard.repo.error.no_commits': 'The repository has no commits yet',
      'wizard.name': 'Project name',
      'wizard.name.placeholder': 'Defaults to the repository directory name',
      'wizard.brief': 'Research goal / hypothesis',
      'wizard.brief.placeholder': 'For example: check whether sweeping ridge regularisation on seed-42 lowers val_loss.',
      'wizard.initialPrompt': 'Root node prompt',
      'wizard.initialPrompt.placeholder': 'Describe the first experiment the root node should run, its constraints and the report it must produce.',
      'wizard.pools': 'Resource pools',
      'wizard.pools.hint': 'Key/value pairs, e.g. gpu: 1; the scheduler allocates nodes within pool capacity.',
      'wizard.pools.required': 'At least one valid resource pool is required',
      'wizard.pools.duplicate': 'Resource names must be unique',
      'wizard.pool.key': 'Resource',
      'wizard.pool.value': 'Amount',
      'wizard.pool.add': 'Add resource',
      'wizard.pool.remove': 'Remove resource',
      'wizard.limits': 'Run limits',
      'wizard.maxRunningNodes': 'Max concurrent nodes',
      'wizard.maxNodes': 'Max total nodes',
      'wizard.timeouts': 'Time limits (minutes)',
      'wizard.nodeTimeoutMinutes': 'Default node timebox',
      'wizard.maxNodeTimeoutMinutes': 'Max node timebox',
      'wizard.timeouts.hint': 'The Host terminates a node deterministically when its timebox expires; per-node cap {max} minutes.',
      'wizard.create': 'Create project',
      'wizard.creating': 'Creating…',
      'wizard.error': 'Could not create the project',
      'wizard.required.repo': 'Validate a repository and choose a base branch first',
      'wizard.required.name': 'Enter a project name',
      'wizard.required.brief': 'Enter the research goal / hypothesis',
      'wizard.required.prompt': 'Enter the root node prompt',
      'wizard.error.noProject': 'The Host did not return a project id',

      'ws.back': '← Projects',
      'ws.project.unknown': 'Untitled project',
      'ws.mode': 'Mode',
      'ws.mode.manual': 'Manual',
      'ws.mode.auto': 'Auto',
      'ws.mode.autoHint': 'Auto mode arrives in a later phase',
      'ws.step': '▶ Step',
      'ws.step.hint': 'Run one manual cycle: advisor review + scheduler decisions.',
      'ws.dirty': 'Uncommitted changes',
      'ws.resourceChip': '{key} {free}/{total}',
      'ws.nodeCount': 'Nodes {count}/{max}',
      'ws.revision': 'rev {revision}',
      'ws.rail.title': 'Task list',
      'ws.rail.empty': 'No nodes yet',
      'ws.canvas.empty': 'No nodes — check the project state and refresh.',
      'ws.canvas.hint': 'Drag to pan · scroll to zoom · click a node for details',
      'ws.canvas.fit': 'Fit',
      'ws.canvas.zoomIn': 'Zoom in',
      'ws.canvas.zoomOut': 'Zoom out',
      'ws.node.parentPrefix': 'from ',
      'ws.node.minutes': '{minutes} min',
      'ws.node.root': 'Root node',
      'status.proposed': 'Proposed',
      'status.planned': 'Planned',
      'status.running': 'Running',
      'status.completed': 'Completed',
      'status.failed': 'Failed',
      'status.cancelled': 'Cancelled',
      'createdBy.user': 'user',
      'createdBy.advisor': 'advisor',
      'createdBy.seed': 'seed',
      'ws.inspector.title': 'Node inspector',
      'ws.inspector.empty': 'Select a node on the canvas or in the task list.',
      'ws.inspector.prompt': 'Prompt',
      'ws.inspector.prompt.placeholder': 'Node task prompt',
      'ws.inspector.prompt.chars': '{count} chars',
      'ws.inspector.promptRequired': 'The prompt must not be empty',
      'ws.inspector.successCriteria': 'Success criteria',
      'ws.inspector.successCriteria.placeholder': 'Optional acceptance criteria, e.g. val_loss < 0.84 with a reproduce command in the report.',
      'ws.inspector.timebox': 'Timebox',
      'ws.inspector.timebox.hint': '1–{max} minutes',
      'ws.inspector.timebox.invalid': 'Enter an integer between 1 and {max} minutes',
      'ws.inspector.savePrompt': 'Save prompt',
      'ws.inspector.saveTimebox': 'Save timebox',
      'ws.inspector.saving': 'Saving…',
      'ws.inspector.saved': 'Saved',
      'ws.inspector.readonly': 'Status is “{status}”; this node is not editable.',
      'ws.inspector.error': 'Save failed',
      'ws.inspector.git': 'Git',
      'ws.inspector.branch': 'Branch',
      'ws.inspector.worktree': 'Worktree path',
      'ws.inspector.baseCommit': 'Base commit',
      'ws.inspector.headCommit': 'Head commit',
      'ws.inspector.tag': 'Tag',
      'ws.inspector.parent': 'Parent',
      'ws.inspector.createdBy': 'Created by',
      'ws.inspector.timestamps': 'Timestamps',
      'ws.inspector.createdAt': 'Created',
      'ws.inspector.updatedAt': 'Updated',
      'ws.inspector.startedAt': 'Started',
      'ws.inspector.completedAt': 'Completed',
      'ws.inspector.errorLabel': 'Error',
      'ws.inspector.worktreeRoot': 'Worktree root',
      'ws.log.title': 'Activity log',
      'ws.log.empty': 'No events yet',
      'ws.log.collapse': 'Collapse',
      'ws.log.expand': 'Expand',
      'ws.log.count': '{count} entries',
      'ws.poll.offline': 'Connection lost — retrying…',
      'ws.poll.nextRetry': 'next retry in ~{seconds}s',
      'ws.poll.retry': 'Retry now',
      'ws.loading': 'Loading project state…',
      'ws.loadError': 'Could not load project state',
      'ws.loadingHint': 'state / events polls back off 1.5s → 3s → 5s while failing.',
      'log.type.project.created': 'project created',
      'log.type.project.updated': 'project updated',
      'log.type.node.created': 'node created',
      'log.type.node.edited': 'node edited',
      'log.type.node.proposed': 'node proposed',
      'log.type.node.approved': 'node approved',
      'log.type.node.rejected': 'node rejected',
      'log.type.node.started': 'node started',
      'log.type.node.completed': 'node completed',
      'log.type.node.failed': 'node failed',
      'log.type.node.cancelled': 'node cancelled',
      'log.type.cycle.completed': 'cycle completed',
      'log.type.auto.started': 'auto started',
      'log.type.auto.stopped': 'auto stopped',
      'ws.actions': 'Actions',
      'ws.action.start': '▶ Start',
      'ws.action.starting': 'Starting…',
      'ws.action.cancel': '■ Cancel',
      'ws.action.cancelling': 'Cancelling…',
      'ws.action.failed': 'Action failed',
      'ws.action.openTranscript': 'View conversation',
      'ws.action.continue': 'Continue conversation',
      'ws.action.dismiss': 'Dismiss',
      'ws.runningCount': 'Running {count}',
      'ws.held': '{key} held {held}',
      'ws.running.title': 'Running',
      'ws.running.deadline': 'Deadline',
      'ws.running.remaining': 'Remaining {time}',
      'ws.running.overdue': 'Overdue',
      'ws.running.held': 'Resources held',
      'ws.running.hint': 'The Host terminates the node deterministically when the deadline passes.',
      'ws.card.remaining': '⏱ {time}',
      'ws.report.title': 'Experiment report',
      'ws.report.success': 'Succeeded',
      'ws.report.failed': 'Not achieved',
      'ws.report.summary': 'Summary',
      'ws.report.metrics': 'Metrics',
      'ws.report.changes': 'Changes',
      'ws.report.reproduce': 'Reproduce',
      'ws.report.next': 'Next steps',
      'ws.report.risks': 'Risks',
      'ws.report.blockers': 'Blockers',
      'ws.report.text': 'Report text',
      'ws.report.metricName': 'Metric',
      'ws.report.metricValue': 'Value',
      'ws.termination.title': 'Termination record',
      'ws.termination.kind': 'Kind',
      'ws.termination.kind.timeout': 'Timeout',
      'ws.termination.kind.cancel': 'Cancelled',
      'ws.termination.kind.failure': 'Failure',
      'ws.termination.killedAt': 'Terminated at',
      'ws.termination.pids': 'Killed PIDs',
      'ws.termination.jobs': 'Killed jobs',
      'ws.termination.gpuFreed': 'GPU released',
      'ws.termination.verifiedClean': 'Verified clean',
      'ws.termination.leftover': 'Leftover',
      'ws.termination.yes': 'yes',
      'ws.termination.no': 'no',
      'ws.followUps.title': 'Follow-up conversations',
      'ws.followUps.head': 'commit {commit}',
      'ws.transcript.title': 'Node conversation',
      'ws.transcript.empty': 'No conversation yet',
      'ws.transcript.emptyRunning': 'The node has not produced conversation rows yet.',
      'ws.transcript.loading': 'Loading conversation…',
      'ws.transcript.error': 'Could not load the conversation',
      'ws.transcript.running': 'Node running…',
      'ws.transcript.user': 'User',
      'ws.transcript.assistant': 'Agent',
      'ws.transcript.tool': 'Tool call',
      'ws.transcript.toolResult': 'Tool result',
      'ws.transcript.reasoning': 'Reasoning',
      'ws.transcript.expand': 'Expand',
      'ws.transcript.collapse': 'Collapse',
      'ws.transcript.args': 'Arguments',
      'ws.transcript.result': 'Result',
      'ws.transcript.close': 'Close conversation',
      'ws.transcript.count': '{count} rows',
      'ws.composer.placeholder': 'Continue the conversation with this node Agent (uses resources again).',
      'ws.composer.send': 'Send',
      'ws.composer.sending': 'Sending…',
      'ws.composer.hint': 'Press Cmd/Ctrl+Enter to send',
      'ws.composer.needs': 'Continuing will hold: {needs}',
      'ws.composer.free': 'Currently free: {free}',
      'ws.composer.insufficient': 'Not enough resources: needs {needs}, free {free}',
      'ws.composer.disabled.running': 'The node is running; the conversation cannot be continued right now.',
      'ws.composer.disabled.notLeaf': 'This node already has successors, so its conversation is sealed read-only.',
      'ws.composer.disabled.sealed': 'This node is sealed; the conversation is read-only.',
      'ws.composer.disabled.status': 'Only completed leaf nodes can continue their conversation.',
      'ws.composer.error': 'Could not send the message',
      'log.type.node.messaged': 'node message',
      'log.type.node.terminated': 'node terminated',
      'ws.step.running': 'Running Step…',
      'ws.step.cycleBusy': 'A cycle is still running; try again shortly.',
      'ws.step.summary': 'Step finished: {created} created · {started} started',
      'ws.step.skipped': '{count} skipped',
      'ws.step.errors': '{count} errors',
      'ws.step.error': 'Step failed',
      'ws.step.dismiss': 'Dismiss',
      'ws.busy': 'Working…',
      'ws.sealed': 'Sealed',
      'ws.sealed.readonly': 'This node is sealed; the conversation is read-only.',
      'ws.sealed.successorHint': 'Add a successor on the sealed baseline (forks from the current HEAD).',
      'ws.successor.action': '＋ Add successor',
      'ws.successor.title': 'Add a successor experiment on {title}',
      'ws.successor.intro': 'The parent is sealed on creation (HEAD is tagged, its conversation becomes read-only) and the new node starts as planned.',
      'ws.successor.field.title': 'Title',
      'ws.successor.field.titlePlaceholder': 'e.g. ridge × batch-size interaction',
      'ws.successor.field.prompt': 'Task prompt',
      'ws.successor.field.promptPlaceholder': 'Describe the successor experiment on the parent baseline, its constraints and report requirements.',
      'ws.successor.field.criteria': 'Success criteria',
      'ws.successor.field.criteriaPlaceholder': 'Optional acceptance criteria.',
      'ws.successor.field.timebox': 'Timebox (minutes)',
      'ws.successor.field.needs': 'Resource needs',
      'ws.successor.needKey': 'Resource',
      'ws.successor.needValue': 'Amount',
      'ws.successor.addNeed': 'Add resource',
      'ws.successor.removeNeed': 'Remove resource',
      'ws.successor.submit': 'Create node',
      'ws.successor.creating': 'Creating…',
      'ws.successor.cancel': 'Cancel',
      'ws.successor.close': 'Close successor dialog',
      'ws.successor.error': 'Could not create the successor',
      'ws.successor.required.title': 'Enter a title',
      'ws.successor.required.prompt': 'Enter the task prompt',
      'ws.successor.required.promptMin': 'The task prompt must be at least 10 characters',
      'ws.runs.open': 'Runs',
      'ws.runs.title': 'Run history',
      'ws.runs.close': 'Close run history',
      'ws.runs.loading': 'Loading runs…',
      'ws.runs.error': 'Could not load runs',
      'ws.runs.empty': 'No advisor / scheduler runs yet.',
      'ws.runs.count': '{runs} runs · {cycles} cycles',
      'ws.runs.tab.runs': 'Agent runs',
      'ws.runs.tab.cycles': 'Cycles',
      'ws.runs.role.advisor': 'Advisor',
      'ws.runs.role.scheduler': 'Scheduler',
      'ws.runs.status.running': 'Running',
      'ws.runs.status.completed': 'Completed',
      'ws.runs.status.failed': 'Failed',
      'ws.runs.duration': 'Took {time}',
      'ws.runs.created': '{count} created',
      'ws.runs.started': '{count} started',
      'ws.runs.rejected': '{count} rejected',
      'ws.runs.stopReason': 'Stop reason',
      'ws.runs.trigger': 'Trigger',
      'ws.runs.skipped': '{count} skipped',
      'ws.runs.errors': '{count} errors',
      'ws.runs.openDetail': 'View run details',
      'ws.runs.back': '← Back to list',
      'ws.runs.detail': 'Run details',
      'ws.runs.detail.loading': 'Loading run details…',
      'ws.runs.detail.error': 'Could not load run details',
      'ws.runs.detail.analysis': 'Analysis',
      'ws.runs.detail.input': 'Input snapshot',
      'ws.runs.detail.output': 'Structured output',
      'ws.runs.detail.rejected': 'Rejected proposals',
      'ws.runs.detail.errorLabel': 'Error',
      'ws.runs.detail.session': 'Session',
      'ws.runs.detail.model': 'Model',
      'ws.runs.detail.refresh': 'Refresh details',
      'ws.runs.noSelection': 'Select a run to see its details.',
      'ws.log.openRun': 'View run',
      'log.type.cycle.started': 'cycle started',
      'log.type.cycle.finished': 'cycle finished',
      'log.type.advisor.started': 'advisor started',
      'log.type.advisor.finished': 'advisor finished',
      'log.type.scheduler.started': 'scheduler started',
      'log.type.scheduler.finished': 'scheduler finished',
      'log.type.node.sealed': 'node sealed',
      'ws.auto.title': 'Auto mode',
      'ws.auto.confirmTitle': 'Switch to auto mode?',
      'ws.auto.confirmIntro': 'Auto mode keeps calling models and using resources until any budget limit pauses it.',
      'ws.auto.budget.cycles': 'Max cycles: {count}',
      'ws.auto.budget.wallClock': 'Max wall clock: {hours} h',
      'ws.auto.budget.nodes': 'Max nodes: {count}',
      'ws.auto.budget.idle': 'Idle fuse: {count} consecutive cycles without progress',
      'ws.auto.costHint': 'This keeps consuming model quota and resources.',
      'ws.auto.start': 'Start auto mode',
      'ws.auto.cancel': 'Cancel',
      'ws.auto.running': 'Auto running',
      'ws.auto.paused': 'Auto paused',
      'ws.auto.waiting': 'Waiting for approval',
      'ws.auto.off': 'Manual',
      'ws.auto.pause.maxCycles': 'Max cycles reached',
      'ws.auto.pause.maxWallClock': 'Max wall clock reached',
      'ws.auto.pause.maxNodes': 'Max nodes reached',
      'ws.auto.pause.noProgress': 'No progress for several cycles',
      'ws.auto.pause.idle': 'Idle fuse tripped',
      'ws.auto.pause.errors': 'Too many consecutive errors',
      'ws.auto.pause.awaitingConfirmation': 'Waiting for proposal approval',
      'ws.auto.pause.hostRestarted': 'Auto mode stopped after the Host restarted; confirm to resume',
      'ws.auto.pause.unknown': 'Unknown reason',
      'ws.auto.cycles': 'cycle {count}/{max}',
      'ws.auto.elapsed': 'elapsed {time}',
      'ws.auto.resume': 'Resume',
      'ws.auto.stop': 'Stop',
      'ws.auto.viewPending': 'View pending proposals',
      'ws.auto.busy': 'Switching…',
      'ws.auto.error': 'Auto mode action failed',
      'ws.confirm.approveTitle': 'Approve this proposal?',
      'ws.confirm.approveBody': 'The node joins the planned queue; if it is the parent\'s first child the parent is sealed.',
      'ws.confirm.rejectTitle': 'Reject this proposal?',
      'ws.confirm.rejectBody': 'The proposal is deleted and the parent stays unsealed.',
      'ws.confirm.approve': 'Approve',
      'ws.confirm.reject': 'Reject',
      'ws.confirm.cancel': 'Cancel',
      'ws.confirm.close': 'Close confirmation',
      'ws.proposed.badge': 'Pending approval',
      'ws.proposed.title': 'Pending proposal',
      'ws.proposed.rationale': 'Rationale',
      'ws.proposed.infoGain': 'Expected information gain',
      'ws.proposed.createdAt': 'Proposed at',
      'ws.proposed.run': 'Proposal run',
      'ws.proposed.approve': '✓ Approve',
      'ws.proposed.reject': '✕ Reject',
      'ws.proposed.working': 'Working…',
      'ws.inspector.needs': 'Resource needs',
      'ws.inspector.saveNeeds': 'Save resource needs',
      'ws.inspector.noNeeds': 'No resource needs',
      'ws.inspector.needsInvalid': 'Invalid resource name or amount',
      'ws.settings.open': 'Project settings',
      'ws.settings.title': 'Project settings',
      'ws.settings.close': 'Close project settings',
      'ws.settings.section.advisor': 'Advisor & approvals',
      'ws.settings.section.auto': 'Auto-mode budget',
      'ws.settings.section.limits': 'Run limits',
      'ws.settings.section.pools': 'Resource pools',
      'ws.settings.section.models': 'Role models (optional)',
      'ws.settings.section.prompts': 'Prompt overrides (optional)',
      'ws.settings.acceptMode': 'New-proposal intake',
      'ws.settings.acceptMode.auto': 'Auto-adopt',
      'ws.settings.acceptMode.confirm': 'Human approval',
      'ws.settings.acceptMode.hint': 'In human-approval mode new proposals wait in the pending queue without blocking established nodes.',
      'ws.settings.maxProposalsPerPass': 'Max proposals per pass',
      'ws.settings.maxPendingProposals': 'Max pending proposals',
      'ws.settings.maxCycles': 'Max cycles',
      'ws.settings.maxWallClockMinutes': 'Max wall clock (minutes)',
      'ws.settings.idleCycleLimit': 'Idle fuse (consecutive no-progress cycles)',
      'ws.settings.nodeTimeoutMinutes': 'Default node timebox (minutes)',
      'ws.settings.maxNodeTimeoutMinutes': 'Max node timebox (minutes)',
      'ws.settings.maxRunningNodes': 'Max concurrent nodes',
      'ws.settings.maxNodes': 'Max total nodes',
      'ws.settings.pools.hint': 'Key/value pairs, e.g. gpu: 1.',
      'ws.settings.models.hint': 'Leave blank to use the profile default; both provider and model are required to take effect.',
      'ws.settings.model.provider': 'provider',
      'ws.settings.model.model': 'model',
      'ws.settings.model.worker': 'worker',
      'ws.settings.model.advisor': 'advisor',
      'ws.settings.model.scheduler': 'scheduler',
      'ws.settings.prompts.workerPrefix': 'worker prefix',
      'ws.settings.prompts.advisor': 'advisor prompt',
      'ws.settings.prompts.scheduler': 'Project experiment scheduler prompt (does NOT allocate GPUs)',
      'ws.settings.prompts.schedulerHint': 'This prompt only decides which planned nodes of this project start next; GPU admission is decided by the cluster coordinator and nodes may queue for a whole GPU.',
      'ws.settings.clusterPriority': 'Cluster scheduling priority (0–100)',
      'ws.settings.clusterPriorityHint': 'When several projects contend for the same GPU, higher values are granted coordinator leases sooner; only meaningful in cluster mode.',
      'ws.settings.clusterPriority.invalid': 'Cluster scheduling priority must be between 0 and 100',
      'ws.cluster.twoLayerNote': 'The coordinator is the final authority for GPU admission; the project scheduler/auto mode only requests starts, and GPU nodes may queue for a whole GPU.',
      'ws.cluster.waitSchedulerHint': 'Waiting for the cluster coordinator to grant a whole GPU; the project scheduler cannot reserve GPUs.',
      'ws.settings.save': 'Save settings',
      'ws.settings.saving': 'Saving…',
      'ws.settings.reset': 'Reset',
      'ws.settings.cancel': 'Cancel',
      'ws.settings.invalid': 'Check the numeric fields and resource pools',
      'ws.settings.error': 'Could not save settings',
      'ws.settings.saved': 'Settings saved',
      'ws.gc.title': 'Postmortem (GC)',
      'ws.gc.cause': 'Cause',
      'ws.gc.leftovers': 'Leftovers',
      'ws.gc.cleanupRequested': 'Cleanup requested',
      'ws.gc.recommendation': 'Recommendation',
      'ws.gc.summary': 'Summary',
      'ws.gc.run': 'GC run',
      'ws.gc.empty': 'none',
      'ws.gc.openRun': 'View GC run',
      'ws.runs.role.gc': 'GC',
      'log.type.gc.started': 'GC started',
      'log.type.gc.finished': 'GC finished',
      'log.type.auto.resumed': 'auto resumed',
      'log.type.auto.paused': 'auto paused',
      'landing.delete': 'Delete project',
      'landing.delete.confirmTitle': 'Delete project “{name}”?',
      'landing.delete.body': 'The project record and node data are deleted. Git branches and tags are kept by default.',
      'landing.delete.worktrees': 'Also delete node worktrees (Git branches and tags are kept)',
      'landing.delete.warning': 'This action cannot be undone.',
      'landing.delete.confirm': 'Delete project',
      'landing.delete.cancel': 'Cancel',
      'landing.delete.deleting': 'Deleting…',
      'landing.delete.error': 'Could not delete the project',
      'landing.delete.error.project_busy': 'A node is still running in this project; it cannot be deleted',
      'landing.delete.error.project_not_found': 'The project does not exist or was already deleted',
      'landing.delete.close': 'Close delete confirmation',
      'ws.projectMenu': 'Project actions',
      'ws.projectMenu.delete': 'Delete project',
      'ws.projectMenu.close': 'Close project menu',
      'ws.retry.action': '↻ Retry',
      'ws.retry.cancelled': '↻ Run again',
      'ws.retry.cancelledHint': 'A cancelled node cannot resume in place; running it again creates a fresh attempt and keeps the history.',
      'ws.retry.cancelledConfirmTitle': 'Run this cancelled node again?',
      'ws.retry.cancelledConfirmBody': 'A cancelled node cannot resume in place; it will keep its history and start a fresh attempt. If auto mode is paused, click Resume on the auto bar after it starts.',
      'ws.retry.confirmTitle': 'Retry this failed node?',
      'ws.retry.confirmBody': 'A start-stage failure returns to planned and restarts; a run-stage failure sends a retry follow-up and runs again.',
      'ws.retry.confirm': 'Retry',
      'ws.retry.cancel': 'Cancel',
      'ws.retry.busy': 'Retrying…',
      'ws.retry.error': 'Retry failed',
      'ws.merge.createAction': '⊕ Create merge node',
      'ws.merge.createTitle': 'Create merge node',
      'ws.merge.close': 'Close merge node dialog',
      'ws.merge.intro': 'Pick 2–4 completed nodes as parents; creating the merge seals the parents.',
      'ws.merge.parents': 'Parents (2–4)',
      'ws.merge.selected': 'Selected {count}/{max}',
      'ws.merge.field.title': 'Title',
      'ws.merge.field.titlePlaceholder': 'e.g. merge lr sweep with ridge sweep',
      'ws.merge.field.prompt': 'Merge instructions (optional)',
      'ws.merge.field.promptPlaceholder': 'Explain how to combine evidence from the branches; leave blank for the default merge prompt.',
      'ws.merge.field.timebox': 'Timebox (minutes)',
      'ws.merge.submit': 'Create merge node',
      'ws.merge.creating': 'Creating…',
      'ws.merge.required.parents': 'Select 2–4 parents',
      'ws.merge.required.title': 'Enter a title',
      'ws.merge.error': 'Could not create the merge',
      'ws.merge.badge': '⊕ merge',
      'ws.merge.parentCount': '{count} parents',
      'ws.merge.title': 'Merge state',
      'ws.merge.state.pending': 'Pending',
      'ws.merge.state.conflict': 'Conflict',
      'ws.merge.state.clean': 'Clean',
      'ws.merge.state.committed': 'Committed',
      'ws.merge.conflicts': 'Conflict files',
      'ws.merge.prepared': 'Parent baselines',
      'ws.merge.finish': '✓ Finish merge',
      'ws.merge.finishTitle': 'Finish merge',
      'ws.merge.finishIntro': 'Commit the merge once conflicts are resolved; optionally add a merge summary.',
      'ws.merge.finishSummary': 'Merge summary (optional)',
      'ws.merge.finishSubmit': 'Commit merge',
      'ws.merge.finishing': 'Committing…',
      'ws.merge.conflictsError': 'The merge still has conflicts: {message}',
      'ws.merge.finishError': 'Could not finish the merge',
      'ws.merge.parentsTitle': 'Parents',
      'ws.merge.headCommit': 'Merge commit',
      'ws.merge.committedAt': 'Merged at',
      'ws.merge.lastReport': 'Latest report',
      'ws.merge.clean': 'clean',
      'ws.merge.dirty': 'conflicts',
      'ws.merge.composerPlaceholder': 'Tell the merge agent how to resolve conflicts or continue the merge…',
      'ws.merge.composerHint': 'While the merge is running you can talk to the merge agent directly.',
      'ws.merge.contributors': 'Merge sources',
      'ws.settings.section.reviewers': 'Heterogeneous reviewers',
      'ws.settings.reviewers.hint': 'Up to 4 reviewers; lens is the review perspective (e.g. stats / systems / skeptic).',
      'ws.settings.reviewer.add': 'Add reviewer',
      'ws.settings.reviewer.remove': 'Remove reviewer',
      'ws.settings.reviewer.lens': 'lens',
      'ws.settings.reviewer.provider': 'provider',
      'ws.settings.reviewer.model': 'model',
      'ws.settings.reviewer.effort': 'reasoning effort',
      'ws.settings.reviewer.effort.auto': 'default',
      'ws.settings.reviewer.max': 'Up to 4 reviewers',
      'ws.settings.maxTokens': 'Auto-mode token budget (0 = off)',
      'ws.runs.lens': 'lens {lens}',
      'ws.runs.lensLabel': 'Review lens',
      'ws.runs.panelLabel': 'Panel size',
      'ws.runs.panel': 'panel {count}',
      'ws.usage.title': 'Token usage',
      'ws.usage.total': 'total {count}',
      'ws.usage.input': 'input {count}',
      'ws.usage.output': 'output {count}',
      'ws.usage.cacheRead': 'cache read {count}',
      'ws.usage.cacheWrite': 'cache write {count}',
      'ws.usage.chip': '{count} tokens',
      'ws.auto.tokens': 'tokens {used}/{max}',
      'ws.auto.pause.maxTokens': 'Token budget reached',
      'ws.projectMenu.push': 'Push branches & tags',
      'ws.push.title': 'Push branches & tags',
      'ws.push.close': 'Close push dialog',
      'ws.push.intro': 'Push the plugin-managed Git branches and sealed tags to the remote repository.',
      'ws.push.remote': 'Remote name',
      'ws.push.remotePlaceholder': 'origin',
      'ws.push.submit': 'Push',
      'ws.push.pushing': 'Pushing…',
      'ws.push.error': 'Push failed',
      'ws.push.done': 'Pushed {count} refs',
      'ws.push.stdout': 'Output',
      'ws.push.nothingToPush': 'Nothing to push',
      'ws.push.gitPushFailed': 'git push failed',
      'ws.push.cancel': 'Cancel',
      'ws.model.title': 'Model',
      'ws.model.inherit': 'Inherit project default',
      'ws.model.inheritHint': 'Leave empty to use the project role or default model',
      'ws.model.effort': 'Reasoning effort',
      'ws.model.effort.inherit': 'Default effort',
      'ws.model.free': 'Enter provider / model manually',
      'ws.model.freeProvider': 'provider',
      'ws.model.freeModel': 'model',
      'ws.model.resolved': 'Effective model',
      'ws.model.source': 'Model source',
      'ws.model.none': 'not set',
      'ws.model.loading': 'Loading model catalog…',
      'ws.model.error': 'Could not load the model catalog',
      'ws.model.retry': 'Reload models',
      'ws.model.unavailable': 'Unavailable: {reason}',
      'ws.model.tags': 'tags: {tags}',
      'ws.model.priceIn': 'in ${price}/M',
      'ws.model.priceOut': 'out ${price}/M',
      'ws.model.context': 'context {count}',
      'ws.inspector.saveModel': 'Save model',
      'ws.model.source.user': 'User-selected',
      'ws.model.source.advisor': 'Advisor-selected',
      'ws.model.source.escalation': 'Auto-escalated',
      'ws.model.source.project-role': 'Project role default',
      'ws.model.source.project-default': 'Project default',
      'ws.model.source.default': 'Global default',
      'ws.attempts.title': 'Attempt history',
      'ws.attempts.index': 'Attempt {index}',
      'ws.attempts.model': 'Model',
      'ws.attempts.status': 'Status',
      'ws.attempts.duration': 'Duration',
      'ws.attempts.tokens': 'Tokens',
      'ws.attempts.cost': 'Cost',
      'ws.attempts.error': 'Error: {message}',
      'ws.attempts.stopReason': 'Stop: {reason}',
      'ws.attempts.empty': 'No attempts yet',
      'ws.attempts.running': 'running',
      'ws.cost.total': 'Cumulative cost',
      'ws.cost.unpriced': 'unpriced',
      'ws.cost.chip': '${amount}',
      'ws.escalate.action': '⇧ Retry with a stronger model',
      'ws.escalate.busy': 'Escalating…',
      'ws.escalate.error': 'Escalation failed',
      'ws.escalate.hint': 'Start a new attempt with the next stronger model tier',
      'ws.auto.cost': 'cost {used}/{max}',
      'ws.auto.pause.maxCost': 'Cost budget reached',
      'ws.auto.pause.resourcesQueued': 'Queued for cluster resources',
      'ws.settings.section.routing': 'Routing & escalation',
      'ws.settings.routing.hint': 'Controls advisor model selection, auto-upgrade and the per-node attempt limit.',
      'ws.settings.advisorMaySelectModels': 'Let the advisor choose models',
      'ws.settings.autoUpgrade': 'Auto-upgrade model after failures',
      'ws.settings.maxAttempts': 'Max attempts per node',
      'ws.settings.maxCostUsd': 'Auto-mode cost budget USD (0 = off)',
      'ws.settings.section.modelOptions': 'Model options',
      'ws.settings.modelOptions.hint': 'Define routable model tiers: id, provider, model and prices per million tokens.',
      'ws.settings.modelOption.add': '+ Add model option',
      'ws.settings.modelOption.remove': 'Remove model option',
      'ws.settings.modelOption.id': 'ID',
      'ws.settings.modelOption.provider': 'provider',
      'ws.settings.modelOption.model': 'model',
      'ws.settings.modelOption.effort': 'Default reasoning effort',
      'ws.settings.modelOption.tags': 'tags (comma separated)',
      'ws.settings.modelOption.priceIn': 'Input price/M',
      'ws.settings.modelOption.priceOut': 'Output price/M',
      'ws.settings.cluster.title': 'Cluster status (read-only)',
      'ws.settings.cluster.hint': 'Open the top-bar cluster panel to inspect leases and queue with refresh.',
      'ws.settings.cluster.mode': 'mode: {mode}',
      'ws.settings.cluster.connected': 'coordinator connected',
      'ws.settings.cluster.disconnected': 'coordinator disconnected',
      'ws.settings.cluster.machines': 'machines: {count}',
      'ws.settings.cluster.queue': 'queue: {count}',
      'ws.settings.cluster.pools': 'pools: {pools}',
      'ws.cluster.chip': '{mode} · GPU {free}/{total} · queue {queue}',
      'ws.cluster.title': 'Cluster coordinator',
      'ws.cluster.close': 'Close cluster panel',
      'ws.cluster.refresh': 'Refresh',
      'ws.cluster.refreshing': 'Refreshing…',
      'ws.cluster.loading': 'Loading cluster status…',
      'ws.cluster.error': 'Could not load cluster status',
      'ws.cluster.disabled': 'Cluster is disabled',
      'ws.cluster.mode': 'Mode',
      'ws.cluster.instance': 'Instance',
      'ws.cluster.machine': 'Machine',
      'ws.cluster.connected': 'Coordinator connection',
      'ws.cluster.coordinator': 'Coordinator URL',
      'ws.cluster.heartbeat': 'Last heartbeat',
      'ws.cluster.pools': 'Resource pools',
      'ws.cluster.machines': 'Machines & devices',
      'ws.cluster.devices': 'Devices',
      'ws.cluster.memory': '{memory} MiB',
      'ws.cluster.leases': 'Leases',
      'ws.cluster.queueTitle': 'Queued requests',
      'ws.cluster.usage': 'Usage',
      'ws.cluster.empty': 'No data',
      'ws.cluster.byMachine': 'by machine: {detail}',
      'ws.cluster.mode.local': 'local',
      'ws.cluster.mode.coordinator': 'coordinator',
      'ws.cluster.mode.client': 'client',
      'ws.cluster.mode.both': 'both',
      'ws.cluster.nodeWait': 'Waiting for resources ({pool}×{amount})',
      'ws.cluster.nodeWaitPosition': 'Queue position {position}',
      'ws.cluster.nodeWaitReason': 'Reason: {reason}',
      'ws.cluster.lease': 'Lease',
      'ws.cluster.leaseMachine': 'machine: {machine}',
      'ws.cluster.leaseDevices': 'devices: {devices}',
      'ws.cluster.leaseExpires': 'expires: {time}',
      'ws.cluster.leaseExpiresLabel': 'Lease expires',
      'ws.cluster.waitHint': 'Queued for resources; start and retry are disabled for now',
      'ws.cluster.queued': 'queue {count}',
      'ws.cluster.poolRow': '{pool}: {used}/{total} (free {free})',
      'ws.cluster.leaseHolder': 'Holder',
      'ws.cluster.leaseNode': 'Node',
      'ws.cluster.queueNode': 'Node',
      'ws.cluster.queueAmount': 'Amount',
      'log.type.node/resource_waiting': 'Node waiting for resources',
      'log.type.node/resource_granted': 'Node got resources',
      'log.type.node/resource_lost': 'Node lost resources',
      'log.type.node/escalated': 'Node model escalated',
      'log.type.node/model_changed': 'Node model changed',
      'log.type.node/retried': 'Node retried',
      'landing.clusterConfig': 'Cluster settings',
      'ws.projectMenu.clusterConfig': 'Cluster settings',
      'ws.clusterConfig.title': 'Cluster settings',
      'ws.clusterConfig.close': 'Close cluster settings',
      'ws.clusterConfig.loading': 'Loading cluster configuration…',
      'ws.clusterConfig.loadError': 'Could not load the cluster configuration',
      'ws.clusterConfig.reload': 'Reload',
      'ws.clusterConfig.reloading': 'Reloading…',
      'ws.clusterConfig.save': 'Save & apply',
      'ws.clusterConfig.saving': 'Applying…',
      'ws.clusterConfig.saved': 'Configuration saved and hot-applied',
      'ws.clusterConfig.noChanges': 'No changes to apply',
      'ws.clusterConfig.canApplyFalse': 'Applying the configuration is currently unavailable',
      'ws.clusterConfig.status.title': 'Cluster status',
      'ws.clusterConfig.status.path': 'Config file',
      'ws.clusterConfig.status.enabled': 'Enabled',
      'ws.clusterConfig.status.mode': 'Mode',
      'ws.clusterConfig.status.connected': 'Coordinator connection',
      'ws.clusterConfig.status.blocked': 'Startup blocked',
      'ws.clusterConfig.status.claimConflict': 'Machine claim conflict',
      'ws.clusterConfig.status.error': 'Error',
      'ws.clusterConfig.status.clusterId': 'clusterId',
      'ws.clusterConfig.status.coordinatorId': 'coordinatorId',
      'ws.clusterConfig.status.url': 'URL',
      'ws.clusterConfig.status.machines': 'Machines / devices',
      'ws.clusterConfig.status.pools': 'Resource pools',
      'ws.clusterConfig.status.activeLeases': '{count} node(s) currently hold a GPU lease; wait for them to finish or stop them before changing the configuration.',
      'ws.clusterConfig.status.warnings': 'Warnings',
      'ws.clusterConfig.status.disabled': 'Cluster is disabled (local mode)',
      'ws.clusterConfig.section.basic': 'Basics',
      'ws.clusterConfig.enabled': 'Enable cluster',
      'ws.clusterConfig.enabledHint': 'When enabled this instance joins the cluster as coordinator and/or client.',
      'ws.clusterConfig.role': 'Role',
      'ws.clusterConfig.role.coordinator': 'Coordinator',
      'ws.clusterConfig.role.client': 'Client',
      'ws.clusterConfig.role.both': 'Both',
      'ws.clusterConfig.clusterId': 'clusterId',
      'ws.clusterConfig.machineId': 'machineId',
      'ws.clusterConfig.userId': 'userId',
      'ws.clusterConfig.priority': 'Priority',
      'ws.clusterConfig.section.token': 'Authentication',
      'ws.clusterConfig.token': 'Shared token',
      'ws.clusterConfig.token.setHint': 'Already set; leave empty to keep the current token',
      'ws.clusterConfig.token.emptyHint': 'Not set; set a shared token before enabling the cluster.',
      'ws.clusterConfig.token.clear': 'Clear token',
      'ws.clusterConfig.token.cleared': 'Token will be cleared on save',
      'ws.clusterConfig.token.undoClear': 'Undo clear',
      'ws.clusterConfig.section.timing': 'Heartbeat & leases',
      'ws.clusterConfig.heartbeat': 'Heartbeat interval (seconds)',
      'ws.clusterConfig.leaseTtl': 'Lease TTL (minutes)',
      'ws.clusterConfig.section.devices': 'Devices',
      'ws.clusterConfig.devices.mode': 'Device mode',
      'ws.clusterConfig.devices.auto': 'Auto-detect (nvidia-smi)',
      'ws.clusterConfig.devices.manual': 'Manual list',
      'ws.clusterConfig.devices.add': '+ Add device',
      'ws.clusterConfig.devices.remove': 'Remove device',
      'ws.clusterConfig.devices.id': 'Device ID',
      'ws.clusterConfig.devices.model': 'Model',
      'ws.clusterConfig.devices.memory': 'Memory MiB',
      'ws.clusterConfig.devices.empty': 'No manual devices',
      'ws.clusterConfig.section.options': 'Options',
      'ws.clusterConfig.dashboard': 'Enable web dashboard',
      'ws.clusterConfig.allowMultipleCoordinators': 'Allow multiple coordinators per machine',
      'ws.clusterConfig.advanced': 'Advanced',
      'ws.clusterConfig.advanced.show': 'Show advanced settings',
      'ws.clusterConfig.advanced.hide': 'Hide advanced settings',
      'ws.clusterConfig.advanced.hint': 'Only change listen address, claim directory or state file if you explicitly need to.',
      'ws.clusterConfig.instanceId': 'instanceId',
      'ws.clusterConfig.coordinatorId': 'coordinatorId',
      'ws.clusterConfig.url': 'Coordinator URL (client role)',
      'ws.clusterConfig.urlHint': 'The client role needs a coordinator URL, e.g. {example}',
      'ws.clusterConfig.listenHost': 'Listen host',
      'ws.clusterConfig.listenPort': 'Listen port',
      'ws.clusterConfig.claimDir': 'Claim directory',
      'ws.clusterConfig.stateFile': 'State file',
      'ws.clusterConfig.action.dashboard': 'Open dashboard',
      'ws.clusterConfig.action.copyUrl': 'Copy coordinator URL',
      'ws.clusterConfig.action.copied': 'Copied',
      'ws.clusterConfig.action.copyFailed': 'Copy failed; please select the URL manually',
      'ws.clusterConfig.action.stopCluster': 'Stop cluster',
      'ws.clusterConfig.action.stopConfirm': 'Stop the cluster? This returns to local mode.',
      'ws.clusterConfig.action.stopConfirmYes': 'Stop cluster',
      'ws.clusterConfig.action.stopCancel': 'Cancel',
      'ws.clusterConfig.closing': 'Stopping…',
      'ws.clusterConfig.dashboardUnavailable': 'No dashboard URL is available right now',
      'ws.clusterConfig.error.busy': 'A node still holds a GPU lease, so the cluster configuration cannot be applied; wait for it to finish or stop the node and retry.',
      'ws.clusterConfig.error.invalid': 'Invalid cluster configuration',
      'ws.clusterConfig.error.unavailable': 'Cluster administration is not enabled on the Host',
      'ws.clusterConfig.warning.title': 'Warnings',
      'ws.clusterConfig.devices.summary': '{count} device(s)',
      'ws.clusterConfig.pools.summary': 'GPU {free}/{total}',
      'ws.clusterConfig.roleHint': 'Coordinator schedules and leases; clients execute nodes; both can run on a single machine.',
      'ws.clusterConfig.appliedNote': 'Hot-applied; no plugin reload needed.',
      'ws.clusterConfig.token.copyHint': 'For security only a mask is shown; the plaintext token is never returned.',
      'ws.clusterConfig.fleet.title': 'Remote GPU machines (Fleet over SSH)',
      'ws.clusterConfig.fleet.hint': 'The DSH control machine may have no local GPU; workers execute over SSH inside remote containers while the code/worktree lives on shared NFS. Set a path map when the container sees a different path (Windows paths such as C:\\... must map to a POSIX/NFS path inside the Linux container).',
      'ws.clusterConfig.fleet.show': 'Show remote fleet settings',
      'ws.clusterConfig.fleet.hide': 'Hide remote fleet settings',
      'ws.clusterConfig.fleet.enabled': 'Enable remote fleet',
      'ws.clusterConfig.fleet.placementMode': 'Placement mode',
      'ws.clusterConfig.fleet.placement.local': 'Local GPUs only',
      'ws.clusterConfig.fleet.placement.fleet': 'Remote fleet only',
      'ws.clusterConfig.fleet.placement.auto': 'Auto (prefer local, spill to fleet)',
      'ws.clusterConfig.fleet.masterPort': 'Master port',
      'ws.clusterConfig.fleet.pathMap': 'Global path map (local → container/NFS)',
      'ws.clusterConfig.fleet.pathMap.add': '+ Add path mapping',
      'ws.clusterConfig.fleet.pathMap.from': 'Local path',
      'ws.clusterConfig.fleet.pathMap.to': 'Remote path',
      'ws.clusterConfig.fleet.pathMap.remove': 'Remove path mapping',
      'ws.clusterConfig.fleet.machines': 'Remote machines',
      'ws.clusterConfig.fleet.machines.empty': 'No remote machines yet',
      'ws.clusterConfig.fleet.machine.add': '+ Add remote machine',
      'ws.clusterConfig.fleet.machine.remove': 'Remove remote machine',
      'ws.clusterConfig.fleet.machine.id': 'machineId',
      'ws.clusterConfig.fleet.machine.masterAddr': 'masterAddr (optional)',
      'ws.clusterConfig.fleet.machine.advanced': 'Machine advanced settings',
      'ws.clusterConfig.fleet.machine.pathMap': 'Per-machine path map',
      'ws.clusterConfig.fleet.ssh.host': 'SSH host',
      'ws.clusterConfig.fleet.ssh.user': 'SSH user',
      'ws.clusterConfig.fleet.ssh.port': 'SSH port',
      'ws.clusterConfig.fleet.ssh.keyPath': 'SSH key path',
      'ws.clusterConfig.fleet.ssh.options': 'Extra SSH options (one per line)',
      'ws.clusterConfig.fleet.ssh.command': 'SSH command (default ssh)',
      'ws.clusterConfig.fleet.container.runtime': 'Container runtime',
      'ws.clusterConfig.fleet.container.name': 'Container name',
      'ws.clusterConfig.fleet.container.workdir': 'Container workdir',
      'ws.clusterConfig.fleet.container.user': 'Container user',
      'ws.clusterConfig.fleet.container.env': 'Environment (one KEY=VALUE per line)',
      'ws.clusterConfig.fleet.container.env.invalid': 'Each environment line must be KEY=VALUE',
      'ws.clusterConfig.fleet.devices': 'Devices',
      'ws.clusterConfig.fleet.devices.auto': 'Auto-detect (SSH nvidia-smi)',
      'ws.clusterConfig.fleet.devices.manual': 'Manual device list',
      'ws.clusterConfig.fleet.devices.add': '+ Add device',
      'ws.clusterConfig.fleet.devices.remove': 'Remove device',
      'ws.clusterConfig.fleet.devices.id': 'Device ID',
      'ws.clusterConfig.fleet.devices.localId': 'localId',
      'ws.clusterConfig.fleet.devices.model': 'Model',
      'ws.clusterConfig.fleet.devices.memory': 'Memory MiB',
      'ws.cluster.fleet.title': 'Remote fleet',
      'ws.cluster.fleet.machine': 'Machine',
      'ws.cluster.fleet.ssh': 'SSH endpoint',
      'ws.cluster.fleet.container': 'Container',
      'ws.cluster.fleet.devices': 'Devices',
      'ws.cluster.fleet.status': 'Status',
      'ws.cluster.fleet.online': 'Online',
      'ws.cluster.fleet.offline': 'Offline',
      'ws.cluster.fleet.empty': 'No remote fleet machines',
      'ws.cluster.fleet.placement': 'Placement mode',
      'ws.fleet.badge': 'Remote fleet · {machines} machine(s) / {gpus} GPU(s)',
      'ws.fleet.panel': 'Remote fleet lease',
      'ws.fleet.placement': 'Placement',
      'ws.fleet.placement.local': 'Local',
      'ws.fleet.placement.fleet': 'Remote fleet',
      'ws.fleet.machines': 'Machines & devices',
      'ws.fleet.masterPort': 'Master port',
      'ws.fleet.remoteDir': 'Remote bundle directory',
      'ws.fleet.workerHint': 'The worker automatically uses the Host-generated .dshex-run/remote.sh / launch.sh wrappers on the remote machines; these scripts are Host-managed and must not be edited manually.',
      'ws.fleet.needsHint': 'Number of remote machines (≤ total GPUs) — only effective in fleet mode.',
      'ws.fleet.machineRow': '{machineId}: {devices}',
      'ws.fleet.devicesNone': '(auto)',
      'ws.settings.section.placement': 'GPU placement request (natural language)',
      'ws.settings.placement.text': 'Placement request',
      'ws.settings.placement.placeholder': 'e.g. must use A100; prefer the same rack; NVLink interconnect; exclude H100.',
      'ws.settings.placement.hint': 'Only applies to fleet GPU nodes; the coordinator enforces must/exclude rules and uses prefer rules for ordering.',
      'ws.settings.placement.compile': 'Parse preview',
      'ws.settings.placement.compiling': 'Parsing…',
      'ws.settings.placement.save': 'Save policy',
      'ws.settings.placement.saving': 'Saving…',
      'ws.settings.placement.clear': 'Clear policy',
      'ws.settings.placement.clearing': 'Clearing…',
      'ws.settings.placement.needCompile': 'Parse the preview first, then save the policy.',
      'ws.settings.placement.preview': 'Parse result',
      'ws.settings.placement.summary': 'Summary',
      'ws.settings.placement.explanation': 'Rule explanation',
      'ws.settings.placement.warnings': 'Warnings',
      'ws.settings.placement.catalog': 'Available labels and GPU models',
      'ws.settings.placement.catalogEmpty': 'No fleet labels or GPU models yet; the policy takes effect after the fleet is configured.',
      'ws.settings.placement.machineCount': '{count} fleet machine(s) configured',
      'ws.settings.placement.savedPolicy': 'Saved policy',
      'ws.settings.placement.status.saved': 'Saved',
      'ws.settings.placement.status.unsaved': 'Unsaved changes',
      'ws.settings.placement.status.empty': 'Not set',
      'ws.settings.placement.status.previewed': 'Parsed, not saved',
      'ws.settings.placement.savedMessage': 'Placement policy saved',
      'ws.settings.placement.clearedMessage': 'Placement policy cleared',
      'ws.settings.placement.error': 'Placement policy operation failed',
      'ws.settings.placement.invalid': 'Invalid placement policy',
      'ws.settings.placement.rules': 'Rules',
      'ws.settings.placement.rule.requireLabels': '{key}={values} (required)',
      'ws.settings.placement.rule.requireModel': 'GPU model = {values} (required)',
      'ws.settings.placement.rule.excludeModel': 'Excluded GPU models: {values}',
      'ws.settings.placement.rule.requireMachines': 'Required machines: {values}',
      'ws.settings.placement.rule.excludeMachines': 'Excluded machines: {values}',
      'ws.settings.placement.rule.excludeLabels': '{key}={values} (excluded)',
      'ws.settings.placement.rule.colocate': 'Same {key} (required)',
      'ws.settings.placement.rule.preferColocate': 'Same {key} (preferred)',
      'ws.settings.placement.rule.preferLabels': '{key}={values} (preferred)',
      'ws.settings.placement.rule.preferModel': 'GPU model = {values} (preferred)',
      'ws.settings.placement.rule.preferMachines': 'Preferred machines: {values}',
      'ws.settings.placement.noRules': 'No compiled rules',
      'ws.settings.placement.compiledAt': 'Compiled {time}',
      'ws.clusterConfig.fleet.machine.labels': 'labels',
      'ws.clusterConfig.fleet.machine.labelsHint': 'The natural-language placement policy matches these labels (e.g. gpu=a100, rack=rack-a, interconnect=nvlink) and GPU models.',
      'ws.clusterConfig.fleet.machine.labels.add': '+ Add label',
      'ws.clusterConfig.fleet.machine.labels.key': 'Key',
      'ws.clusterConfig.fleet.machine.labels.value': 'Value',
      'ws.clusterConfig.fleet.machine.labels.remove': 'Remove label',
      'ws.cluster.fleet.labels': 'Labels',
      'ws.fleet.labels': 'Labels',
      'ws.fleet.noLabels': '(no labels)',
      'ws.native.title': 'Session & trajectory (DSH native)',
      'ws.native.hint': 'The trajectory timeline, search, folding and tool-call details come from DSH Conversation; the plugin no longer renders its own transcript.',
      'ws.native.trajectory': 'Open trajectory in DSH',
      'ws.native.chat': 'Open chat in DSH',
      'ws.native.sessionId': 'Session',
      'ws.native.attempts': 'Attempt sessions',
      'ws.native.attemptOpen': 'Attempt {index} trajectory',
      'ws.native.openFailed': 'Could not open the native session',
      'ws.native.noSession': 'This node has no session to open yet',
      'ws.native.devHint': 'If the Trajectory tab is hidden, enable DSH Settings → General → Show code work view; otherwise DSH falls back to Chat automatically.',
      'ws.native.continue': 'Continue conversation',
      'ws.native.continueTitle': 'Continue conversation',
      'ws.native.continueHint': 'Messages are delivered to this node’s agent via node.message; read history read-only in the native DSH view.',
      'ws.native.continuePlaceholder': 'Send a message to this node’s agent…',
      'ws.native.continueSend': 'Send',
      'ws.native.continueSending': 'Sending…',
      'ws.native.continueClose': 'Close',
      'ws.native.continueSuccess': 'Message sent',
      'ws.native.continueError': 'Send failed',
      'ws.native.continueDisabled': 'The current node state does not allow continuing the conversation',
      'ws.native.continueNeeds': 'needs {needs} · free {free}',
      'ws.native.continueInsufficient': 'Insufficient resources: needs {needs} · free {free}',
      'ws.native.runningMerge': 'Merge is running; messages go straight to the merge agent.',
      'ws.native.cardHint': 'Double-click to open the native DSH trajectory',
      'ws.native.noAttempts': 'No attempts yet',
      'ws.native.openTrajectoryShort': 'Trajectory',
      'ws.native.openChatShort': 'Chat',
      'crash.title': 'The panel failed to render',
      'crash.hint': 'The error was contained; the rest of the page keeps working.',
    };
    // #endregion

    // #region styles
    /**
     * Component-scoped CSS. `rl-` is this plugin's class prefix; the sheet is
     * emitted from inside the panel and removed with it. Chrome colors use only
     * `--dsw-alias-*` theme tokens; geometry stays literal.
     */
    const STYLE_TEXT = [
      '.rl-landing { box-sizing: border-box; height: 100%; width: 100%; overflow: auto; padding: 28px clamp(20px, 3.5vw, 44px) 48px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 13px; line-height: 20px; }',
      '.rl-page-head { box-sizing: border-box; display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; width: 100%; max-width: 1280px; margin: 0 auto; }',
      '.rl-page-heading { display: flex; flex-direction: column; gap: 4px; min-width: 0; }',
      '.rl-page-title { margin: 0; font-size: 20px; font-weight: 500; line-height: 28px; }',
      '.rl-page-subtitle { margin: 0; max-width: 760px; color: var(--dsw-alias-label-secondary); font-size: 12.5px; line-height: 20px; }',
      '.rl-badge { box-sizing: border-box; display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 10px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 18px; white-space: nowrap; flex: none; }',
      '.rl-badge-dot { width: 6px; height: 6px; border-radius: 3px; background: var(--dsw-alias-brand-primary); flex: none; }',
      '.rl-landing-grid { display: grid; grid-template-columns: minmax(280px, 380px) minmax(0, 1fr); gap: 20px; align-items: start; width: 100%; max-width: 1280px; margin: 20px auto 0; }',
      '@media (max-width: 980px) { .rl-landing-grid { grid-template-columns: minmax(0, 1fr); } }',
      '.rl-card { box-sizing: border-box; display: flex; flex-direction: column; gap: 12px; min-width: 0; padding: 16px 18px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }',
      '.rl-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }',
      '.rl-card-title { margin: 0; font-size: 14px; font-weight: 500; line-height: 22px; }',
      '.rl-card-meta { flex: none; color: var(--dsw-alias-label-tertiary); font-size: 11.5px; line-height: 18px; white-space: nowrap; }',
      '.rl-chip { box-sizing: border-box; display: inline-flex; align-items: center; max-width: 100%; height: 20px; padding: 0 7px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
      '.rl-chip-mono { font-family: ' + MONO + '; }',
      '.rl-btn { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 28px; padding: 0 12px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 8px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; line-height: 18px; white-space: nowrap; cursor: pointer; flex: none; }',
      '.rl-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }',
      '.rl-btn:disabled { opacity: 0.5; cursor: not-allowed; }',
      '.rl-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }',
      '.rl-btn-primary { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary-inverted, var(--dsw-alias-bg-base)); }',
      '.rl-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); opacity: 0.92; }',
      '.rl-btn-ghost { border-color: transparent; }',
      '.rl-btn-ghost:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }',
      '.rl-btn-sm { height: 24px; padding: 0 9px; font-size: 11.5px; }',
      '.rl-input, .rl-textarea, .rl-select { box-sizing: border-box; width: 100%; min-width: 0; padding: 6px 10px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12.5px; line-height: 18px; outline: none; }',
      '.rl-input:focus, .rl-textarea:focus, .rl-select:focus { border-color: var(--dsw-alias-brand-primary); box-shadow: inset 0 0 0 0.5px var(--dsw-alias-brand-primary); }',
      '.rl-input:disabled, .rl-textarea:disabled, .rl-select:disabled { opacity: 0.6; cursor: not-allowed; }',
      '.rl-textarea { min-height: 76px; line-height: 20px; resize: vertical; }',
      '.rl-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }',
      '.rl-label { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }',
      '.rl-hint { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }',
      '.rl-error-text { margin: 0; color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }',
      '.rl-form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }',
      '.rl-form-row { display: flex; align-items: flex-end; gap: 8px; }',
      '.rl-form-actions { display: flex; justify-content: flex-end; gap: 8px; }',
      '.rl-form-row > .rl-input { flex: 1 1 auto; }',
      '.rl-form-row > .rl-input[type=number] { flex: 0 0 96px; }',
      '.rl-form-row > .rl-btn { flex: none; }',
      '.rl-repo-info { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }',
      '.rl-repo-info-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }',
      '.rl-info-row { display: grid; grid-template-columns: minmax(76px, auto) minmax(0, 1fr); gap: 8px; align-items: baseline; font-size: 12px; line-height: 18px; }',
      '.rl-info-label { color: var(--dsw-alias-label-tertiary); }',
      '.rl-info-value { min-width: 0; overflow-wrap: anywhere; }',
      '.rl-mono { font-family: ' + MONO + '; }',
      '.rl-project-row { box-sizing: border-box; display: flex; align-items: center; gap: 12px; width: 100%; min-width: 0; padding: 10px; border: 0.5px solid transparent; border-radius: 8px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }',
      '.rl-project-row:hover { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); }',
      '.rl-project-row:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }',
      '.rl-project-main { display: flex; flex-direction: column; gap: 3px; flex: 1 1 auto; min-width: 0; }',
      '.rl-project-title { font-size: 13px; font-weight: 500; line-height: 20px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.rl-project-path { color: var(--dsw-alias-label-tertiary); font-family: ' + MONO + '; font-size: 11px; line-height: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.rl-project-chips { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; margin-top: 2px; }',
      '.rl-project-side { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; flex: none; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }',
      '.rl-project-open { color: var(--dsw-alias-brand-primary); font-size: 11.5px; }',
      '.rl-project-open { color: var(--dsw-alias-brand-primary); font-size: 11.5px; }',
      '.rl-loading-row { display: flex; align-items: center; gap: 10px; padding: 8px 2px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }',
      '.rl-empty-state { box-sizing: border-box; padding: 18px 12px; border: 0.5px dashed var(--dsw-alias-border-l2); border-radius: 10px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; text-align: center; }',
      '.rl-spinner { box-sizing: border-box; flex: none; width: 14px; height: 14px; border: 2px solid var(--dsw-alias-border-l2); border-top-color: var(--dsw-alias-brand-primary); border-radius: 50%; animation: rl-spin 900ms linear infinite; }',
      '@keyframes rl-spin { to { transform: rotate(360deg); } }',
      '.rl-workspace { position: relative; box-sizing: border-box; display: flex; flex-direction: column; height: 100%; width: 100%; overflow: hidden; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 13px; line-height: 20px; }',
      '.rl-topbar { position: relative; box-sizing: border-box; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; flex: none; min-width: 0; padding: 9px 16px; border-bottom: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }',
      '.rl-topbar-project { display: flex; align-items: center; gap: 10px; min-width: 0; }',
      '.rl-topbar-title { margin: 0; max-width: 300px; font-size: 15px; font-weight: 500; line-height: 22px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.rl-topbar-spacer { flex: 1 1 auto; }',
      '.rl-topbar-chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }',
      '.rl-topbar-controls { display: flex; align-items: center; gap: 8px; flex: none; }',
      '.rl-segment { display: inline-flex; gap: 2px; padding: 2px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 8px; }',
      '.rl-segment-item { padding: 1px 8px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11.5px; line-height: 18px; cursor: pointer; }',
      '.rl-segment-item:disabled { opacity: 0.6; cursor: not-allowed; }',
      '.rl-segment-active { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }',
      '.rl-workspace-grid { display: grid; grid-template-columns: 240px minmax(0, 1fr) 320px; flex: 1 1 auto; min-height: 0; }',
      '.rl-rail { display: flex; flex-direction: column; gap: 10px; min-height: 0; padding: 12px 10px; border-right: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); overflow: auto; }',
      '.rl-rail-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 0 4px; }',
      '.rl-rail-group { display: flex; flex-direction: column; gap: 2px; }',
      '.rl-rail-group-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 6px 2px; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }',
      '.rl-rail-row { box-sizing: border-box; display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; padding: 6px 8px; border: 0; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; line-height: 18px; text-align: left; cursor: pointer; }',
      '.rl-rail-row:hover { background: var(--dsw-alias-bg-layer-2); }',
      '.rl-rail-row:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }',
      '.rl-rail-row-active { background: var(--dsw-alias-bg-layer-2); box-shadow: inset 2px 0 0 var(--dsw-alias-brand-primary); }',
      '.rl-rail-row-main { display: flex; flex-direction: column; gap: 1px; flex: 1 1 auto; min-width: 0; }',
      '.rl-rail-row-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.rl-rail-row-sub { color: var(--dsw-alias-label-tertiary); font-family: ' + MONO + '; font-size: 11px; line-height: 15px; }',
      '.rl-rail-row-meta { flex: none; color: var(--dsw-alias-label-tertiary); font-size: 11px; }',
      '.rl-empty-note { margin: 0; padding: 6px 6px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }',
      '.rl-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-label-tertiary); }',
      '.rl-dot-proposed { background: var(--dsw-alias-state-warn-primary); }',
      '.rl-dot-running { background: var(--dsw-alias-brand-primary); animation: rl-pulse 2s ease-in-out infinite; }',
      '.rl-dot-completed { background: var(--dsw-alias-state-success-primary); }',
      '.rl-dot-failed { background: var(--dsw-alias-state-error-primary); }',
      '.rl-dot-cancelled { background: var(--dsw-alias-state-idle-primary); }',
      '@keyframes rl-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }',
      '.rl-canvas { position: relative; min-width: 0; min-height: 0; overflow: hidden; background: var(--dsw-alias-bg-base); cursor: grab; touch-action: none; }',
      '.rl-canvas-dragging { cursor: grabbing; }',
      '.rl-canvas-inner { position: absolute; left: 0; top: 0; will-change: transform; }',
      '.rl-canvas-svg { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }',
      '.rl-edge { fill: none; stroke: var(--dsw-alias-border-l2); stroke-width: 1.5; }',
      '.rl-edge-active { stroke: var(--dsw-alias-brand-primary); stroke-width: 2; }',
      '.rl-node { position: absolute; box-sizing: border-box; display: flex; flex-direction: column; gap: 3px; overflow: hidden; padding: 9px 11px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-family: inherit; text-align: left; cursor: pointer; transition: border-color 120ms ease, background 120ms ease; }',
      '.rl-node:hover { background: var(--dsw-alias-bg-layer-2); }',
      '.rl-node:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }',
      '.rl-node-selected { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; background: var(--dsw-alias-bg-layer-2); }',
      '.rl-node-dim { opacity: 0.45; }',
      '.rl-node-running { border-color: var(--dsw-alias-brand-primary); }',
      '.rl-node-proposed { border-style: dashed; border-color: var(--dsw-alias-state-warn-primary); }',
      '.rl-node-failed { border-color: var(--dsw-alias-state-error-primary); }',
      '.rl-node-cancelled { opacity: 0.6; }',
      '.rl-node-head { display: flex; align-items: center; gap: 6px; min-width: 0; }',
      '.rl-node-id { flex: none; color: var(--dsw-alias-label-tertiary); font-family: ' + MONO + '; font-size: 11px; line-height: 16px; }',
      '.rl-node-title { flex: 1 1 auto; min-width: 0; font-size: 12.5px; font-weight: 500; line-height: 18px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.rl-node-sub { color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.rl-node-chips { display: flex; align-items: center; gap: 4px; margin-top: auto; overflow: hidden; }',
      '.rl-canvas-toolbar { position: absolute; top: 12px; right: 12px; z-index: 2; display: flex; align-items: center; gap: 4px; padding: 3px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }',
      '.rl-canvas-zoom { min-width: 40px; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; font-variant-numeric: tabular-nums; text-align: center; }',
      '.rl-canvas-hint { position: absolute; bottom: 12px; left: 12px; z-index: 2; padding: 2px 8px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; pointer-events: none; }',
      '.rl-canvas-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 24px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; text-align: center; }',
      '.rl-inspector { display: flex; flex-direction: column; gap: 14px; min-height: 0; padding: 14px 16px; border-left: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); overflow: auto; }',
      '.rl-inspector-head { display: flex; flex-direction: column; gap: 4px; }',
      '.rl-inspector-title { margin: 0; font-size: 14px; font-weight: 500; line-height: 22px; overflow-wrap: anywhere; }',
      '.rl-inspector-id { color: var(--dsw-alias-label-tertiary); font-family: ' + MONO + '; font-size: 11px; line-height: 16px; }',
      '.rl-inspector-empty { padding: 24px 4px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }',
      '.rl-section { display: flex; flex-direction: column; gap: 8px; padding-top: 12px; border-top: 0.5px solid var(--dsw-alias-border-l2); }',
      '.rl-section-title { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 500; line-height: 18px; }',
      '.rl-status-pill { display: inline-flex; align-items: center; gap: 6px; align-self: flex-start; height: 20px; padding: 0 8px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; }',
      '.rl-status-failed { color: var(--dsw-alias-state-error-primary); }',
      '.rl-notice { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }',
      '.rl-saved { color: var(--dsw-alias-state-success-primary); font-size: 11px; line-height: 16px; }',
      '.rl-banner { box-sizing: border-box; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; flex: none; padding: 6px 16px; border-bottom: 0.5px solid var(--dsw-alias-state-error-primary); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }',
      '.rl-banner-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-state-error-primary); }',
      '.rl-banner-text { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }',
      '.rl-banner-meta { flex: none; color: var(--dsw-alias-label-tertiary); font-size: 11px; }',
      '.rl-workspace-center { display: flex; align-items: center; justify-content: center; flex: 1 1 auto; min-height: 0; padding: 24px; }',
      '.rl-center-card { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; max-width: 460px; padding: 18px 20px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }',
      '.rl-log { display: flex; flex-direction: column; flex: none; max-height: 200px; min-height: 34px; border-top: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }',
      '.rl-log-head { display: flex; align-items: center; gap: 10px; min-height: 34px; padding: 6px 16px; }',
      '.rl-log-toggle { display: inline-flex; align-items: center; gap: 6px; padding: 0; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 18px; cursor: pointer; }',
      '.rl-log-toggle:hover { color: var(--dsw-alias-label-primary); }',
      '.rl-log-toggle:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }',
      '.rl-log-latest { min-width: 0; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.rl-log-list { display: flex; flex-direction: column; gap: 1px; min-height: 0; margin: 0; padding: 0 8px 8px; overflow: auto; list-style: none; }',
      '.rl-log-list-item { margin: 0; padding: 0; }',
      '.rl-log-row, .rl-log-row-btn { box-sizing: border-box; display: grid; grid-template-columns: 64px 96px minmax(0, 1fr); gap: 10px; align-items: baseline; width: 100%; padding: 2px 8px; border-radius: 6px; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11.5px; line-height: 18px; text-align: left; }',
      '.rl-log-row-btn { border: 0; background: transparent; cursor: pointer; }',
      '.rl-log-row:hover, .rl-log-row-btn:hover { background: var(--dsw-alias-bg-layer-2); }',
      '.rl-log-row-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }',
      '.rl-log-time { color: var(--dsw-alias-label-tertiary); font-family: ' + MONO + '; font-size: 11px; font-variant-numeric: tabular-nums; }',
      '.rl-log-type { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.rl-log-detail { color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.rl-log-empty { margin: 0; padding: 2px 16px 12px; color: var(--dsw-alias-label-tertiary); font-size: 11.5px; line-height: 18px; }',
      '.rl-node { cursor: pointer; }',
      '.rl-node-completed { border-color: var(--dsw-alias-state-success-primary); }',
      '.rl-node-cancelled { border-color: var(--dsw-alias-border-l2); }',
      '.rl-node-actions { position: absolute; top: 5px; right: 5px; z-index: 2; display: flex; align-items: center; gap: 3px; opacity: 0; pointer-events: none; transition: opacity 120ms ease; }',
      '.rl-node:hover .rl-node-actions, .rl-node:focus-within .rl-node-actions { opacity: 1; pointer-events: auto; }',
      '.rl-node-action { box-sizing: border-box; display: inline-flex; align-items: center; height: 18px; padding: 0 6px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 5px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; font-size: 10px; line-height: 15px; white-space: nowrap; cursor: pointer; }',
      '.rl-node-action:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }',
      '.rl-node-action:disabled { opacity: 0.5; cursor: not-allowed; }',
      '.rl-node-action:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }',
      '.rl-countdown { color: var(--dsw-alias-brand-primary); font-variant-numeric: tabular-nums; }',
      '.rl-countdown-overdue { color: var(--dsw-alias-state-error-primary); }',
      '.rl-inspector-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }',
      '.rl-running-panel { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border: 0.5px solid var(--dsw-alias-brand-primary); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }',
      '.rl-running-head { display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-primary); font-size: 12px; font-weight: 500; line-height: 18px; }',
      '.rl-running-time { color: var(--dsw-alias-brand-primary); font-family: ' + MONO + '; font-size: 12px; font-variant-numeric: tabular-nums; }',
      '.rl-running-time-overdue { color: var(--dsw-alias-state-error-primary); }',
      '.rl-report { display: flex; flex-direction: column; gap: 8px; }',
      '.rl-report-status { display: inline-flex; align-items: center; align-self: flex-start; height: 20px; padding: 0 8px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 6px; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; }',
      '.rl-report-status-ok { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }',
      '.rl-report-status-bad { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }',
      '.rl-report-summary { margin: 0; color: var(--dsw-alias-label-primary); font-size: 12.5px; line-height: 20px; white-space: pre-wrap; overflow-wrap: anywhere; }',
      '.rl-report-section { display: flex; flex-direction: column; gap: 2px; }',
      '.rl-report-section-title { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }',
      '.rl-report-list { display: flex; flex-direction: column; gap: 2px; margin: 0; padding-left: 16px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }',
      '.rl-report-blockers { color: var(--dsw-alias-state-error-primary); }',
      '.rl-metrics { width: 100%; border-collapse: collapse; font-size: 12px; }',
      '.rl-metrics th, .rl-metrics td { padding: 3px 6px; border-bottom: 0.5px solid var(--dsw-alias-border-l2); text-align: left; }',
      '.rl-metrics th { color: var(--dsw-alias-label-tertiary); font-weight: 500; }',
      '.rl-metrics td { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }',
      '.rl-text-prewrap { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; white-space: pre-wrap; overflow-wrap: anywhere; }',
      '.rl-termination { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border: 0.5px solid var(--dsw-alias-state-error-primary); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }',
      '.rl-termination-title { margin: 0; color: var(--dsw-alias-state-error-primary); font-size: 12px; font-weight: 500; line-height: 18px; }',
      '.rl-followups { display: flex; flex-direction: column; gap: 8px; }',
      '.rl-followup { display: flex; flex-direction: column; gap: 2px; padding: 6px 8px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }',
      '.rl-followup-head { display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }',
      '.rl-followup-user { margin: 0; color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 18px; white-space: pre-wrap; overflow-wrap: anywhere; }',
      '.rl-followup-assistant { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; white-space: pre-wrap; overflow-wrap: anywhere; }',
      '.rl-action-error { box-sizing: border-box; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; flex: none; padding: 6px 16px; border-bottom: 0.5px solid var(--dsw-alias-state-error-primary); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }',
      '.rl-action-error-text { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }',
      '.rl-drawer-layer { position: absolute; inset: 0; z-index: 6; display: flex; justify-content: flex-end; pointer-events: none; }',
      '.rl-drawer { box-sizing: border-box; display: flex; flex-direction: column; pointer-events: auto; width: min(580px, 76%); min-width: 340px; max-width: 100%; height: 100%; border-left: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }',
      '.rl-drawer-head { display: flex; align-items: center; gap: 8px; flex: none; padding: 10px 14px; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }',
      '.rl-drawer-title { flex: 1 1 auto; min-width: 0; margin: 0; font-size: 14px; font-weight: 500; line-height: 22px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.rl-drawer-meta { flex: none; display: flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }',
      '.rl-drawer-body { display: flex; flex-direction: column; gap: 8px; flex: 1 1 auto; min-height: 0; padding: 10px 14px; overflow: auto; }',
      '.rl-drawer-foot { display: flex; flex-direction: column; gap: 8px; flex: none; padding: 10px 14px; border-top: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }',
      '.rl-transcript-row { display: flex; flex-direction: column; gap: 3px; padding: 6px 8px; border: 0.5px solid transparent; border-radius: 8px; }',
      '.rl-transcript-row-user { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }',
      '.rl-transcript-row-tool, .rl-transcript-row-tool-result { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }',
      '.rl-transcript-row-reasoning { opacity: 0.8; }',
      '.rl-transcript-kind { display: flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-tertiary); font-size: 10.5px; line-height: 16px; }',
      '.rl-transcript-kind-user { color: var(--dsw-alias-brand-primary); }',
      '.rl-transcript-text { margin: 0; color: var(--dsw-alias-label-primary); font-size: 12.5px; line-height: 20px; white-space: pre-wrap; overflow-wrap: anywhere; }',
      '.rl-transcript-text-reasoning { color: var(--dsw-alias-label-tertiary); font-style: italic; }',
      '.rl-transcript-toggle { display: flex; align-items: center; gap: 6px; width: 100%; padding: 0; border: 0; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; line-height: 18px; text-align: left; cursor: pointer; overflow-wrap: anywhere; }',
      '.rl-transcript-toggle:hover { color: var(--dsw-alias-brand-primary); }',
      '.rl-transcript-toggle:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }',
      '.rl-transcript-pre { margin: 2px 0 0; padding: 6px 8px; border-radius: 6px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); font-family: ' + MONO + '; font-size: 11px; line-height: 16px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 220px; overflow: auto; }',
      '.rl-transcript-empty { padding: 18px 4px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; text-align: center; }',
      '.rl-transcript-error { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 6px 8px; border: 0.5px solid var(--dsw-alias-state-error-primary); border-radius: 8px; }',
      '.rl-drawer-foot-hint { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }',
      '.rl-drawer-foot-warn { margin: 0; color: var(--dsw-alias-state-warn-primary); font-size: 11px; line-height: 16px; }',
      '.rl-composer-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }',
      '.rl-btn .rl-spinner { width: 12px; height: 12px; border-width: 2px; }',
      '.rl-step-banner { box-sizing: border-box; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; flex: none; padding: 6px 16px; border-bottom: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }',
      '.rl-step-banner-error { border-bottom-color: var(--dsw-alias-state-error-primary); }',
      '.rl-step-banner-text { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }',
      '.rl-step-banner-meta { flex: none; color: var(--dsw-alias-label-tertiary); font-size: 11px; }',
      '.rl-step-banner-ok { color: var(--dsw-alias-state-success-primary); }',
      '.rl-sealed-banner { box-sizing: border-box; display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 11.5px; line-height: 17px; }',
      '.rl-lock-badge { flex: none; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }',
      '.rl-overlay-layer { position: absolute; inset: 0; z-index: 7; display: flex; align-items: center; justify-content: center; padding: 24px; background: var(--dsw-alias-bg-mask-2, transparent); pointer-events: auto; }',
      '.rl-overlay-layer-drawer-above { z-index: 8; }',
      '.rl-modal { box-sizing: border-box; display: flex; flex-direction: column; width: min(760px, 100%); max-height: 100%; min-height: 0; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 13px; line-height: 20px; }',
      '.rl-modal-wide { width: min(880px, 100%); }',
      '.rl-modal-head { display: flex; align-items: center; gap: 10px; flex: none; padding: 12px 16px; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }',
      '.rl-modal-title { flex: 1 1 auto; min-width: 0; margin: 0; font-size: 14px; font-weight: 500; line-height: 22px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.rl-modal-body { display: flex; flex-direction: column; gap: 12px; flex: 1 1 auto; min-height: 0; padding: 14px 16px; overflow: auto; }',
      '.rl-modal-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex: none; padding: 10px 16px; border-top: 0.5px solid var(--dsw-alias-border-l2); }',
      '.rl-modal-foot-note { flex: 1 1 auto; margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }',
      '.rl-tabs { display: inline-flex; gap: 2px; padding: 2px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 8px; align-self: flex-start; }',
      '.rl-tab { padding: 1px 10px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11.5px; line-height: 18px; cursor: pointer; }',
      '.rl-tab-active { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }',
      '.rl-tab:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }',
      '.rl-run-list { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }',
      '.rl-run-row { box-sizing: border-box; display: flex; flex-direction: column; gap: 3px; width: 100%; padding: 8px 10px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 8px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; text-align: left; cursor: pointer; }',
      '.rl-run-row:hover { background: var(--dsw-alias-bg-layer-2); }',
      '.rl-run-row:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }',
      '.rl-run-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }',
      '.rl-run-role { font-size: 12.5px; font-weight: 500; line-height: 18px; }',
      '.rl-run-status { display: inline-flex; align-items: center; gap: 5px; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; }',
      '.rl-run-status-running { color: var(--dsw-alias-brand-primary); }',
      '.rl-run-status-failed { color: var(--dsw-alias-state-error-primary); }',
      '.rl-run-meta { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }',
      '.rl-run-chips { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }',
      '.rl-run-error { margin: 0; color: var(--dsw-alias-state-error-primary); font-size: 11.5px; line-height: 17px; overflow-wrap: anywhere; }',
      '.rl-cycle-row { box-sizing: border-box; display: flex; flex-direction: column; gap: 3px; padding: 8px 10px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 8px; }',
      '.rl-cycle-ids { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }',
      '.rl-json { border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }',
      '.rl-json > summary { padding: 6px 10px; color: var(--dsw-alias-label-secondary); font-size: 11.5px; line-height: 17px; cursor: pointer; list-style-position: inside; }',
      '.rl-json > summary:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }',
      '.rl-json-pre { margin: 0; padding: 8px 10px; border-top: 0.5px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); font-family: ' + MONO + '; font-size: 11px; line-height: 16px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 260px; overflow: auto; }',
      '.rl-successor-needs { display: flex; flex-direction: column; gap: 6px; }',
      '.rl-need-row { display: flex; align-items: flex-end; gap: 8px; }',
      '.rl-need-row > .rl-input { flex: 1 1 auto; }',
      '.rl-need-row > .rl-input[type=number] { flex: 0 0 96px; }',
      '.rl-modal-note { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 11.5px; line-height: 17px; }',
      '.rl-overlay-layer-top { z-index: 9; }',
      '.rl-overlay-layer-confirm { z-index: 10; }',
      '.rl-modal-narrow { width: min(480px, 100%); }',
      '.rl-confirm-text { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12.5px; line-height: 20px; }',
      '.rl-auto-chip { box-sizing: border-box; display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 2px 8px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; }',
      '.rl-auto-chip-running { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }',
      '.rl-auto-chip-paused, .rl-auto-chip-waiting { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }',
      '.rl-auto-meta { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }',
      '.rl-auto-actions { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }',
      '.rl-budget-list { display: flex; flex-direction: column; gap: 3px; margin: 0; padding: 0 0 0 16px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }',
      '.rl-chip-warn { border: 0.5px solid var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }',
      '.rl-proposal-panel { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border: 0.5px dashed var(--dsw-alias-state-warn-primary); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }',
      '.rl-proposal-title { margin: 0; color: var(--dsw-alias-state-warn-primary); font-size: 12px; font-weight: 500; line-height: 18px; }',
      '.rl-settings-section { display: flex; flex-direction: column; gap: 10px; padding-top: 12px; border-top: 0.5px solid var(--dsw-alias-border-l2); }',
      '.rl-settings-section-title { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 500; line-height: 18px; }',
      '.rl-settings-model-row { display: grid; grid-template-columns: 110px minmax(0, 1fr) minmax(0, 1fr); gap: 8px; align-items: end; }',
      '.rl-settings-model-role { padding-bottom: 6px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }',
      '.rl-settings-details { border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }',
      '.rl-settings-details > summary { padding: 6px 10px; color: var(--dsw-alias-label-secondary); font-size: 11.5px; line-height: 17px; cursor: pointer; list-style-position: inside; }',
      '.rl-settings-details > summary:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }',
      '.rl-settings-details-body { display: flex; flex-direction: column; gap: 8px; padding: 8px 10px; border-top: 0.5px solid var(--dsw-alias-border-l2); }',
      '.rl-settings-actions { display: flex; align-items: center; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }',
      '.rl-gc-panel { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border: 0.5px dashed var(--dsw-alias-state-warn-primary); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }',
      '.rl-gc-title { margin: 0; color: var(--dsw-alias-state-warn-primary); font-size: 12px; font-weight: 500; line-height: 18px; }',
      '.rl-project-row-wrap { display: flex; align-items: stretch; gap: 6px; min-width: 0; }',
      '.rl-project-row-wrap > .rl-project-row { flex: 1 1 auto; min-width: 0; }',
      '.rl-project-delete { box-sizing: border-box; flex: none; width: 32px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 8px; background: transparent; color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 14px; line-height: 18px; cursor: pointer; }',
      '.rl-project-delete:hover { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }',
      '.rl-project-delete:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }',
      '.rl-project-delete:disabled { opacity: 0.5; cursor: not-allowed; }',
      '.rl-menu-wrap { position: relative; display: inline-flex; flex: none; }',
      '.rl-menu { position: absolute; top: calc(100% + 4px); right: 0; z-index: 12; display: flex; flex-direction: column; gap: 2px; min-width: 140px; padding: 4px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }',
      '.rl-menu-item { box-sizing: border-box; display: flex; align-items: center; width: 100%; padding: 6px 10px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; line-height: 18px; text-align: left; cursor: pointer; white-space: nowrap; }',
      '.rl-menu-item:hover { background: var(--dsw-alias-bg-layer-2); }',
      '.rl-menu-item-danger { color: var(--dsw-alias-state-error-primary); }',
      '.rl-menu-item:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }',
      '.rl-delete-option { display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; cursor: pointer; }',
      '.rl-delete-option input { width: 14px; height: 14px; margin: 0; accent-color: var(--dsw-alias-brand-primary); flex: none; }',
      '.rl-delete-warning { margin: 0; color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; }',
      '.rl-node-merge { border-color: var(--dsw-alias-brand-primary); }',
      '.rl-chip-merge { border: 0.5px solid var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }',
      '.rl-chip-usage { font-family: ' + MONO + '; }',
      '.rl-merge-panel { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border: 0.5px solid var(--dsw-alias-brand-primary); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }',
      '.rl-merge-title { margin: 0; color: var(--dsw-alias-brand-primary); font-size: 12px; font-weight: 500; line-height: 18px; }',
      '.rl-merge-conflicts { margin: 0; padding-left: 16px; color: var(--dsw-alias-state-error-primary); font-size: 11.5px; line-height: 17px; overflow-wrap: anywhere; }',
      '.rl-merge-parent { display: flex; flex-direction: column; gap: 1px; padding: 4px 6px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 6px; }',
      '.rl-merge-parent-title { color: var(--dsw-alias-label-primary); font-size: 11.5px; line-height: 17px; overflow-wrap: anywhere; }',
      '.rl-merge-parent-meta { color: var(--dsw-alias-label-tertiary); font-family: ' + MONO + '; font-size: 10.5px; line-height: 16px; overflow-wrap: anywhere; }',
      '.rl-merge-node-list { display: flex; flex-direction: column; gap: 4px; max-height: 240px; overflow: auto; padding: 2px; }',
      '.rl-merge-option { display: flex; align-items: center; gap: 8px; padding: 5px 6px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 8px; color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 18px; cursor: pointer; }',
      '.rl-merge-option:hover { background: var(--dsw-alias-bg-layer-2); }',
      '.rl-merge-option input { width: 14px; height: 14px; margin: 0; accent-color: var(--dsw-alias-brand-primary); flex: none; }',
      '.rl-merge-option-main { display: flex; flex-direction: column; gap: 1px; min-width: 0; }',
      '.rl-merge-option-id { color: var(--dsw-alias-label-tertiary); font-family: ' + MONO + '; font-size: 10.5px; line-height: 15px; }',
      '.rl-reviewer-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr) 132px auto; gap: 6px; align-items: end; }',
      '.rl-reviewer-actions { display: flex; align-items: flex-end; }',
      '.rl-model-option-row { display: grid; grid-template-columns: 110px minmax(0, 1fr) minmax(0, 1fr) 118px minmax(0, 1fr) 88px 88px auto; gap: 6px; align-items: end; }',
      '.rl-settings-checkbox-row { display: flex; align-items: center; flex-wrap: wrap; gap: 16px; }',
      '.rl-model-picker { display: flex; flex-direction: column; gap: 6px; }',
      '.rl-node-waiting { border-style: dashed; }',
      '.rl-wait-panel { border-color: var(--dsw-alias-state-warn-primary, var(--dsw-alias-brand-primary)); }',
      '.rl-wait-hint { margin: 0; }',
      '.rl-attempts { display: flex; flex-direction: column; gap: 4px; }',
      '.rl-attempt { display: flex; flex-direction: column; gap: 2px; padding: 5px 7px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 8px; }',
      '.rl-attempt-head { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }',
      '.rl-attempt-index { color: var(--dsw-alias-label-primary); font-size: 11.5px; font-weight: 500; line-height: 17px; }',
      '.rl-attempt-meta { display: flex; flex-wrap: wrap; gap: 10px; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }',
      '.rl-attempt-error { color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }',
      '.rl-cluster-chip { cursor: pointer; }',
      '.rl-cluster-body { display: flex; flex-direction: column; gap: 8px; }',
      '.rl-cluster-line { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 11.5px; line-height: 17px; overflow-wrap: anywhere; }',
      '.rl-cluster-mono { font-family: ' + MONO + '; color: var(--dsw-alias-label-primary); }',
      '.rl-cluster-card { display: flex; flex-direction: column; gap: 1px; padding: 5px 7px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 8px; }',
      '.rl-cluster-config { display: flex; flex-direction: column; gap: 10px; }',
      '.rl-page-head .rl-btn { flex: none; }',
      '.rl-config-section { display: flex; flex-direction: column; gap: 8px; padding: 8px 10px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 8px; }',
      '.rl-config-section-title { margin: 0; color: var(--dsw-alias-label-primary); font-size: 12px; font-weight: 500; line-height: 18px; }',
      '.rl-config-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }',
      '.rl-config-grid-3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }',
      '.rl-config-check-row { display: flex; align-items: center; flex-wrap: wrap; gap: 18px; }',
      '.rl-config-device-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 110px auto; gap: 6px; align-items: end; }',
      '.rl-config-status { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }',
      '.rl-config-warning { margin: 0; padding-left: 16px; color: var(--dsw-alias-state-error-primary); font-size: 11.5px; line-height: 17px; overflow-wrap: anywhere; }',
      '.rl-config-success { margin: 0; color: var(--dsw-alias-state-success-primary); font-size: 12px; line-height: 18px; }',
      '.rl-config-token-row { display: flex; align-items: flex-end; gap: 8px; }',
      '.rl-config-token-row > .rl-field { flex: 1 1 auto; min-width: 0; }',
      '.rl-config-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }',
      '.rl-config-actions-meta { margin-left: auto; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }',
      '.rl-config-machine { background: var(--dsw-alias-bg-layer-1); }',
      '.rl-config-machine-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }',
      '.rl-node-fleet { box-shadow: inset 0 0 0 1px var(--dsw-alias-brand-primary); }',
      '.rl-fleet-panel { border-color: var(--dsw-alias-brand-primary); }',
      '.rl-native-attempt { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }',
      '.rl-push-result { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border: 0.5px solid var(--dsw-alias-state-success-primary); border-radius: 8px; }',
      '.rl-push-result-title { margin: 0; color: var(--dsw-alias-state-success-primary); font-size: 12px; font-weight: 500; line-height: 18px; }',
      '.rl-push-stdout { margin: 0; max-height: 160px; overflow: auto; padding: 6px 8px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-family: ' + MONO + '; font-size: 11px; line-height: 16px; white-space: pre-wrap; overflow-wrap: anywhere; }',
      '@media (prefers-reduced-motion: reduce) { .rl-spinner { animation: none; } .rl-dot-running { animation: none; } .rl-node { transition: none; } .rl-node-actions { transition: none; } }',
    ].join('\n');
    // #endregion

    // #region Host API client
    /** Error carrying the Host error-envelope code (or a transport code). */
    class LabRequestError extends Error {
      constructor(code, message, status) {
        super(typeof message === 'string' && message.length > 0 ? message : code);
        this.name = 'LabRequestError';
        this.code = typeof code === 'string' ? code : 'request_failed';
        this.status = typeof status === 'number' ? status : 0;
      }
    }

    /** Abort errors are control flow, never user-visible failures. */
    function isAbortError(error) {
      return Boolean(error) && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
    }

    /** Turn a thrown value into one localized line. */
    function describeError(error, t) {
      if (error instanceof LabRequestError) return error.message || t('error.unknown');
      if (error && error.name === 'TypeError') return t('error.network');
      if (error instanceof Error && error.message) return error.message;
      return t('error.unknown');
    }

    /**
     * Fetch one JSON envelope. Host responses are `{ok:true,data}` or
     * `{ok:false,error:{code,message}}`; a flat `{ok:true,...}` body is tolerated.
     * @param path relative route including its query string.
     * @param options `{method, body, signal}`.
     * @param t locale-bound translator.
     */
    async function requestJson(path, options, t) {
      const settings = options === null || options === undefined ? {} : options;
      const init = {
        method: settings.method === 'POST' ? 'POST' : 'GET',
        headers: { accept: 'application/json' },
      };
      if (settings.signal) init.signal = settings.signal;
      if (settings.body !== undefined) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(settings.body);
      }
      const response = await fetch(path, init);
      let payload = null;
      try {
        payload = await response.json();
      } catch (error) {
        payload = null;
      }
      const envelopeError = payload !== null && typeof payload === 'object' && payload.ok === false
        ? (payload.error !== null && typeof payload.error === 'object' ? payload.error : {})
        : null;
      if (response.status === 401 || response.status === 403) {
        const message = envelopeError && typeof envelopeError.message === 'string' && envelopeError.message
          ? envelopeError.message
          : t('error.unauthorized');
        throw new LabRequestError('unauthorized', message, response.status);
      }
      if (!response.ok && envelopeError === null) {
        throw new LabRequestError('http_' + response.status, t('error.http', { status: response.status }), response.status);
      }
      if (payload === null || typeof payload !== 'object') {
        throw new LabRequestError('bad_body', t('error.unknown'), response.status);
      }
      if (envelopeError !== null) {
        const code = typeof envelopeError.code === 'string' && envelopeError.code ? envelopeError.code : 'command_failed';
        const message = typeof envelopeError.message === 'string' && envelopeError.message
          ? envelopeError.message
          : t('error.unknown');
        throw new LabRequestError(code, message, response.status);
      }
      if (payload.data !== undefined) return payload.data;
      const flat = {};
      for (const key of Object.keys(payload)) if (key !== 'ok') flat[key] = payload[key];
      return flat;
    }

    /** Typed Host calls; query strings are always URL-encoded. */
    const api = {
      health(signal, t) {
        return requestJson(ROUTES.health, { signal }, t);
      },
      inspectRepo(repoPath, signal, t) {
        return requestJson(ROUTES.repo + '?path=' + encodeURIComponent(repoPath), { signal }, t);
      },
      listProjects(signal, t) {
        return requestJson(ROUTES.projects, { signal }, t);
      },
      createProject(body, signal, t) {
        return requestJson(ROUTES.projects, { method: 'POST', body, signal }, t);
      },
      fetchState(projectId, revision, signal, t) {
        let path = ROUTES.state + '?projectId=' + encodeURIComponent(projectId);
        if (typeof revision === 'number' && Number.isFinite(revision)) path += '&revision=' + encodeURIComponent(String(revision));
        return requestJson(path, { signal }, t);
      },
      fetchEvents(projectId, after, signal, t) {
        const cursor = typeof after === 'number' && Number.isFinite(after) ? after : 0;
        // `cursor` is the first unseen seq. Send one before it so a Host that
        // treats `after` as exclusive cannot skip an event; the hook filters
        // duplicates, so an inclusive Host is safe too.
        const afterParam = cursor > 0 ? cursor - 1 : 0;
        return requestJson(
          ROUTES.events + '?projectId=' + encodeURIComponent(projectId) + '&after=' + encodeURIComponent(String(afterParam)),
          { signal },
          t,
        );
      },
      fetchRuns(projectId, signal, t) {
        return requestJson(ROUTES.runs + '?projectId=' + encodeURIComponent(projectId), { signal }, t);
      },
      fetchModels(projectId, signal, t) {
        return requestJson(ROUTES.models + '?projectId=' + encodeURIComponent(projectId), { signal }, t);
      },
      fetchCluster(projectId, signal, t) {
        return requestJson(ROUTES.cluster + '?projectId=' + encodeURIComponent(projectId), { signal }, t);
      },
      fetchClusterConfig(signal, t) {
        return requestJson(ROUTES.clusterConfig, { signal }, t);
      },
      fetchRun(projectId, runId, signal, t) {
        return requestJson(
          ROUTES.runs + '?projectId=' + encodeURIComponent(projectId) + '&runId=' + encodeURIComponent(runId),
          { signal },
          t,
        );
      },
      command(body, signal, t) {
        return requestJson(ROUTES.commands, { method: 'POST', body, signal }, t);
      },
    };
    // #endregion

    // #region model helpers (defensive: every Host field is optional on the wire)
    function asObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }
    function asArray(value) {
      return Array.isArray(value) ? value : [];
    }
    function firstString() {
      for (let index = 0; index < arguments.length; index += 1) {
        const value = arguments[index];
        if (typeof value === 'string' && value.length > 0) return value;
      }
      return '';
    }
    function finiteNumber(value) {
      if (value === null || value === undefined || value === '') return null;
      const numeric = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(numeric) ? numeric : null;
    }
    function numberOr(value, fallback) {
      const numeric = finiteNumber(value);
      return numeric === null ? fallback : numeric;
    }

    function projectIdOf(project) {
      const record = asObject(project);
      return firstString(record.id, record.projectId);
    }
    function projectNameOf(project) {
      return firstString(asObject(project).name);
    }
    function projectRepoPath(project) {
      const record = asObject(project);
      return firstString(asObject(record.repo).path, record.repoPath);
    }
    function projectBranch(project) {
      const record = asObject(project);
      return firstString(asObject(record.repo).baseBranch, record.baseBranch);
    }
    function projectBaseCommit(project) {
      const record = asObject(project);
      return firstString(asObject(record.repo).baseCommit, record.baseCommit);
    }
    function projectGitDirty(project) {
      const record = asObject(project);
      const repo = asObject(record.repo);
      return repo.dirty === true || record.dirty === true;
    }
    function projectWorktreeRoot(project) {
      const record = asObject(project);
      return firstString(asObject(record.repo).worktreeRoot, record.worktreeRoot);
    }
    function projectConfig(project) {
      return asObject(asObject(project).config);
    }
    function projectMaxNodes(project) {
      return numberOr(projectConfig(project).maxNodes, DEFAULT_CONFIG.maxNodes);
    }
    function projectMaxRunningNodes(project) {
      return numberOr(projectConfig(project).maxRunningNodes, DEFAULT_CONFIG.maxRunningNodes);
    }
    function projectDefaultTimeoutMinutes(project) {
      const config = projectConfig(project);
      const minutes = finiteNumber(config.nodeTimeoutMinutes);
      if (minutes !== null && minutes > 0) return minutes;
      const milliseconds = finiteNumber(config.nodeTimeoutMs);
      if (milliseconds !== null && milliseconds > 0) return Math.round(milliseconds / 60000);
      return DEFAULT_CONFIG.nodeTimeoutMinutes;
    }
    function projectMaxTimeoutMinutes(project) {
      const config = projectConfig(project);
      const minutes = finiteNumber(config.maxNodeTimeoutMinutes);
      if (minutes !== null && minutes > 0) return minutes;
      const milliseconds = finiteNumber(config.maxNodeTimeoutMs);
      if (milliseconds !== null && milliseconds > 0) return Math.round(milliseconds / 60000);
      return FALLBACK_MAX_TIMEOUT_MINUTES;
    }

    function nodeIdOf(node) {
      const record = asObject(node);
      return firstString(record.id, record.nodeId);
    }
    function nodeTitleOf(node, t) {
      const record = asObject(node);
      const title = firstString(record.title, record.name);
      if (title) return title;
      const id = nodeIdOf(record);
      return id || (typeof t === 'function' ? t('common.unknown') : '');
    }
    function nodeStatusOf(node) {
      const status = asObject(node).status;
      return typeof status === 'string' && STATUS_ORDER.indexOf(status) >= 0 ? status : 'planned';
    }
    function nodePromptOf(node) {
      return firstString(asObject(node).prompt);
    }
    function nodeSuccessCriteriaOf(node) {
      return firstString(asObject(node).successCriteria);
    }
    function nodeParentIdOf(node) {
      const record = asObject(node);
      return firstString(record.parentId, record.parent);
    }
    function nodeNeedsOf(node) {
      return asObject(asObject(node).needs);
    }
    function nodeNeedsEntries(node) {
      const needs = nodeNeedsOf(node);
      return Object.keys(needs)
        .map((key) => ({ key, amount: numberOr(needs[key], 0) }))
        .filter((entry) => entry.amount > 0);
    }
    function nodeGitOf(node) {
      return asObject(asObject(node).git);
    }
    function nodeBranchOf(node) {
      return firstString(nodeGitOf(node).branch);
    }
    function nodeWorktreeOf(node) {
      const git = nodeGitOf(node);
      return firstString(git.worktreePath, git.worktree);
    }
    function nodeBaseCommitOf(node) {
      return firstString(nodeGitOf(node).baseCommit);
    }
    function nodeHeadCommitOf(node) {
      return firstString(nodeGitOf(node).headCommit);
    }
    function nodeTagOf(node) {
      return firstString(nodeGitOf(node).tag);
    }
    function nodeTimestampsOf(node) {
      return asObject(asObject(node).timestamps);
    }
    function nodeCreatedByOf(node) {
      return firstString(asObject(node).createdBy);
    }
    function nodeErrorOf(node) {
      return asObject(asObject(node).error);
    }
    function nodeTimeboxMinutesOf(node, project) {
      const record = asObject(node);
      const minutes = finiteNumber(record.timeboxMinutes);
      if (minutes !== null && minutes > 0) return Math.round(minutes);
      const milliseconds = finiteNumber(record.timeboxMs);
      if (milliseconds !== null && milliseconds > 0) return Math.max(1, Math.round(milliseconds / 60000));
      return Math.round(projectDefaultTimeoutMinutes(project));
    }

    function nodeDeadlineOf(node) {
      return finiteNumber(asObject(node).deadlineAt);
    }
    function nodeResourcesHeldOf(node) {
      return asObject(asObject(node).resourcesHeld);
    }
    function nodeReportOf(node) {
      const report = asObject(node).report;
      return report !== null && typeof report === 'object' ? report : null;
    }
    function nodeReportTextOf(node) {
      return firstString(asObject(node).reportText);
    }
    function nodeTerminationOf(node) {
      const termination = asObject(node).termination;
      return termination !== null && typeof termination === 'object' ? termination : null;
    }
    function nodeFollowUpsOf(node) {
      return asArray(asObject(node).followUps).filter((entry) => entry !== null && typeof entry === 'object');
    }
    function nodeSealedOf(node) {
      if (asObject(node).sealed === true) return true;
      if (finiteNumber(nodeTimestampsOf(node).sealedAt) !== null) return true;
      return nodeTagOf(node) !== '';
    }
    function nodeHasChildrenOf(node, nodes) {
      const id = nodeIdOf(node);
      if (!id) return false;
      return asArray(nodes).some((candidate) => nodeParentIdOf(candidate) === id);
    }
    /** Prefer the Host-derived `isLeaf` flag; fall back to scanning parent links. */
    function nodeIsLeafOf(node, nodes) {
      const derived = asObject(node).isLeaf;
      if (typeof derived === 'boolean') return derived;
      return !nodeHasChildrenOf(node, nodes);
    }
    /** Prefer the Host-derived `sealed` flag; fall back to sealedAt/tag. */
    function nodeSealedFlagOf(node) {
      return nodeSealedOf(node);
    }
    function nodeKindOf(node) {
      return firstString(asObject(node).kind);
    }
    function nodeIsMergeOf(node) {
      return nodeKindOf(node) === 'merge';
    }
    function nodeParentIdsOf(node) {
      const record = asObject(node);
      const ids = idListOf(record.parentIds);
      if (ids.length > 0) return ids;
      const single = nodeParentIdOf(record);
      return single ? [single] : [];
    }
    function nodeMergeOf(node) {
      const merge = asObject(node).merge;
      return merge !== null && typeof merge === 'object' && Object.keys(merge).length > 0 ? merge : null;
    }
    function mergeStateOf(node) {
      const merge = nodeMergeOf(node);
      const state = merge === null ? '' : firstString(merge.state);
      return state === 'pending' || state === 'conflict' || state === 'clean' || state === 'committed' ? state : '';
    }
    function mergeStateLabelKeyOf(state) {
      return state === 'pending' || state === 'conflict' || state === 'clean' || state === 'committed'
        ? 'ws.merge.state.' + state
        : 'ws.merge.state.pending';
    }
    function mergeConflictFilesOf(node) {
      const merge = nodeMergeOf(node);
      return merge === null ? [] : stringListOf(merge.conflictFiles);
    }
    function mergePreparedOf(node) {
      const merge = nodeMergeOf(node);
      return merge === null ? [] : asArray(merge.prepared).filter((entry) => entry !== null && typeof entry === 'object');
    }

    /** Session id for a node: node.sessionId, else the latest attempt's session. */
    function nodeSessionIdOf(node) {
      const direct = firstString(asObject(node).sessionId);
      if (direct !== '') return direct;
      const attempts = nodeAttemptsOf(node);
      for (let index = attempts.length - 1; index >= 0; index -= 1) {
        const attempt = asObject(attempts[index]);
        const id = firstString(attempt.sessionId, attempt.anchorSessionId);
        if (id !== '') return id;
      }
      return '';
    }
    function attemptSessionIdOf(attempt) {
      const record = asObject(attempt);
      return firstString(record.sessionId, record.anchorSessionId);
    }
    function nodeCanContinueOf(node, nodes) {
      const status = nodeStatusOf(node);
      const isLeaf = nodeIsLeafOf(node, nodes);
      const sealed = nodeSealedOf(node);
      const isMerge = nodeIsMergeOf(node);
      return (status === 'completed' && isLeaf && !sealed) || (status === 'running' && isMerge);
    }

    /** Preset the native conversation tab without clobbering other stored keys. */
    function presetConversationView(sessionId, view) {
      const id = firstString(sessionId);
      if (id === '') return false;
      const preferred = view === 'chat' ? 'chat' : 'trajectory';
      try {
        if (typeof localStorage === 'undefined' || localStorage === null) return false;
        const key = 'dsh.conversation.' + id;
        let record = {};
        try {
          const raw = localStorage.getItem(key);
          if (typeof raw === 'string' && raw !== '') {
            const parsed = JSON.parse(raw);
            if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) record = parsed;
          }
        } catch (error) {
          record = {};
        }
        record.view = preferred;
        localStorage.setItem(key, JSON.stringify(record));
        return true;
      } catch (error) {
        return false;
      }
    }

    /** Build the native opener bound to the plugin client context (sessions + uiWorkspace). */
    function buildNativeOpener(ctx) {
      return (sessionId, view) => {
        const id = firstString(sessionId);
        if (id === '') return { ok: false, error: 'no-session' };
        presetConversationView(id, view);
        try {
          let target = id;
          if (ctx !== null && ctx !== undefined && ctx.sessions !== null && ctx.sessions !== undefined && typeof ctx.sessions.subagentAddress === 'function') {
            const address = ctx.sessions.subagentAddress(id);
            if (address !== undefined && address !== null && String(address) !== '') target = address;
          }
          if (ctx !== null && ctx !== undefined && ctx.uiWorkspace !== null && ctx.uiWorkspace !== undefined && typeof ctx.uiWorkspace.openSession === 'function') {
            ctx.uiWorkspace.openSession(target);
            return { ok: true, sessionId: id, target };
          }
          return { ok: false, error: 'ui-workspace-unavailable' };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      };
    }

    function nodeUsageOf(node) {
      const usage = asObject(node).usage;
      return usage !== null && typeof usage === 'object' && Object.keys(usage).length > 0 ? usage : null;
    }
    function usageTotalOf(usage) {
      const record = asObject(usage);
      const total = finiteNumber(record.totalTokens);
      if (total !== null) return total;
      return numberOr(record.inputTokens, 0) + numberOr(record.outputTokens, 0);
    }
    function formatTokenCount(value) {
      const numeric = finiteNumber(value);
      if (numeric === null) return '0';
      try {
        return new Intl.NumberFormat('en-US').format(Math.max(0, Math.round(numeric)));
      } catch (error) {
        return String(Math.round(numeric));
      }
    }
    function runLensOf(run) {
      return firstString(asObject(run).lens);
    }
    function runPanelSizeOf(run) {
      return finiteNumber(asObject(run).panelSize);
    }
    function runUsageOf(run) {
      const usage = asObject(run).usage;
      return usage !== null && typeof usage === 'object' && Object.keys(usage).length > 0 ? usage : null;
    }
    function projectReviewersOf(project) {
      return asArray(configAdvisorOf(project).reviewers).filter((entry) => entry !== null && typeof entry === 'object');
    }
    function projectPushErrorTextOf(error, t) {
      if (error instanceof LabRequestError) {
        if (error.code === 'nothing_to_push') return t('ws.push.nothingToPush');
        if (error.code === 'git_push_failed') return t('ws.push.gitPushFailed');
        return error.message || t('ws.push.error');
      }
      return describeError(error, t);
    }

    function projectModelOptionsOf(project) {
      return asArray(projectConfig(project).modelOptions).filter((entry) => entry !== null && typeof entry === 'object');
    }
    function projectRoutingOf(project) {
      const routing = asObject(projectConfig(project).routing);
      return {
        advisorMaySelectModels: routing.advisorMaySelectModels === true,
        autoUpgrade: routing.autoUpgrade === true,
        maxAttempts: Math.max(1, Math.min(20, Math.round(numberOr(routing.maxAttempts, 2)))),
      };
    }
    function projectAutoMaxCostUsd(project) {
      return Math.max(0, numberOr(configAutoOf(project).maxCostUsd, 0));
    }
    function nodeModelOf(node) {
      const model = asObject(node).model;
      return model !== null && typeof model === 'object' && Object.keys(model).length > 0 ? model : null;
    }
    function nodeModelResolvedOf(node) {
      const resolved = asObject(node).modelResolved;
      if (resolved !== null && typeof resolved === 'object' && Object.keys(resolved).length > 0) return resolved;
      return nodeModelOf(node);
    }
    function modelLabelOf(model) {
      const record = asObject(model);
      const name = firstString(record.model, record.provider, record.profileId);
      if (name === '') return '';
      const effort = firstString(record.reasoningEffort);
      return effort === '' ? name : name + '·' + effort;
    }
    function nodeModelLabelOf(node) {
      return modelLabelOf(nodeModelResolvedOf(node));
    }
    function modelSourceLabelKeyOf(source) {
      const value = firstString(source);
      const known = ['user', 'advisor', 'escalation', 'project-role', 'project-default', 'default'];
      return known.indexOf(value) >= 0 ? 'ws.model.source.' + value : 'ws.model.source.default';
    }
    function nodeAttemptsOf(node) {
      return asArray(asObject(node).attempts).filter((attempt) => attempt !== null && typeof attempt === 'object');
    }
    function nodeCostUsdOf(node) {
      return finiteNumber(asObject(node).costUsd);
    }
    function nodeCostPricedOf(node) {
      return asObject(node).costPriced === true;
    }
    function nodeLeaseOf(node) {
      const lease = asObject(node).lease;
      return lease !== null && typeof lease === 'object' && Object.keys(lease).length > 0 ? lease : null;
    }
    function nodeResourceWaitOf(node) {
      const wait = asObject(node).resourceWait;
      return wait !== null && typeof wait === 'object' && Object.keys(wait).length > 0 ? wait : null;
    }
    function attemptDurationTextOf(attempt) {
      const record = asObject(attempt);
      const startedAt = finiteNumber(record.startedAt);
      if (startedAt === null) return '';
      const endedAt = finiteNumber(record.endedAt);
      return formatDurationBetween(startedAt, endedAt === null ? null : endedAt);
    }
    function formatUsdAmount(value) {
      const amount = finiteNumber(value);
      if (amount === null) return '';
      if (amount <= 0) return '$0';
      if (amount < 0.01) return '$' + amount.toFixed(4);
      return '$' + amount.toFixed(2);
    }
    function modelPayloadOf(model) {
      const record = asObject(model);
      const effort = firstString(record.reasoningEffort);
      const profileId = firstString(record.profileId);
      if (profileId !== '') return Object.assign({ profileId }, effort === '' ? {} : { reasoningEffort: effort });
      const provider = firstString(record.provider);
      const name = firstString(record.model);
      if (provider !== '' && name !== '') return Object.assign({ provider, model: name }, effort === '' ? {} : { reasoningEffort: effort });
      return undefined;
    }
    function normalizeModelCatalog(data) {
      const record = asObject(data);
      const options = asArray(record.options)
        .filter((option) => option !== null && typeof option === 'object')
        .map((option) => ({
          id: firstString(option.id),
          provider: firstString(option.provider),
          model: firstString(option.model),
          reasoningEffort: firstString(option.reasoningEffort),
          tags: stringListOf(option.tags),
          priceIn: Math.max(0, numberOr(option.pricePerMTokIn, 0)),
          priceOut: Math.max(0, numberOr(option.pricePerMTokOut, 0)),
          available: option.available === true,
          reason: firstString(option.reason),
          efforts: stringListOf(option.efforts),
          defaultEffort: firstString(option.defaultEffort),
          contextWindow: finiteNumber(option.contextWindow),
        }))
        .filter((option) => option.id !== '' || (option.provider !== '' && option.model !== ''));
      const routing = asObject(record.routing);
      return {
        options,
        routing: {
          advisorMaySelectModels: routing.advisorMaySelectModels === true,
          autoUpgrade: routing.autoUpgrade === true,
          maxAttempts: Math.max(1, Math.round(numberOr(routing.maxAttempts, 2))),
        },
        roles: asObject(record.roles),
        defaultModel: asObject(record.default),
        providers: asArray(record.providers),
        allowlist: stringListOf(record.allowlist),
      };
    }
    function clusterOf(snapshot) {
      const cluster = asObject(asObject(snapshot).cluster);
      return cluster !== null && Object.keys(cluster).length > 0 ? cluster : null;
    }
    function clusterEnabledOf(cluster) {
      return asObject(cluster).enabled === true;
    }
    function clusterModeOf(cluster) {
      const mode = firstString(asObject(cluster).mode);
      return ['local', 'coordinator', 'client', 'both'].indexOf(mode) >= 0 ? mode : 'local';
    }
    function clusterLeasesOf(cluster) {
      return asArray(asObject(cluster).leases).filter((entry) => entry !== null && typeof entry === 'object');
    }
    function clusterQueueOf(cluster) {
      return asArray(asObject(cluster).queue).filter((entry) => entry !== null && typeof entry === 'object');
    }
    function clusterMachinesOf(cluster) {
      return asArray(asObject(cluster).machines).filter((entry) => entry !== null && typeof entry === 'object');
    }
    function clusterPoolsOf(cluster) {
      return asObject(asObject(cluster).pools);
    }

    const CLUSTER_CONFIG_ROLES = ['coordinator', 'client', 'both'];

    /** Defensive parse of GET /cluster/config / cluster.config responses. */
    const PLACEMENT_EMPTY_POLICY = { text: '', spec: null, compiledAt: null, explanation: [], warnings: [], compiler: null, summary: '' };

    function placementPolicyOf(project) {
      const policy = asObject(projectConfig(project).placementPolicy);
      return {
        text: firstString(policy.text),
        spec: policy.spec !== null && typeof policy.spec === 'object' && Object.keys(policy.spec).length > 0 ? policy.spec : null,
        compiledAt: finiteNumber(policy.compiledAt),
        explanation: stringListOf(policy.explanation),
        warnings: stringListOf(policy.warnings),
        compiler: firstString(policy.compiler),
        summary: firstString(policy.summary),
      };
    }

    function placementCompileResultOf(data) {
      const record = asObject(data);
      const rawPolicy = asObject(record.policy);
      const policy = {
        text: firstString(rawPolicy.text),
        spec: rawPolicy.spec !== null && typeof rawPolicy.spec === 'object' && Object.keys(rawPolicy.spec).length > 0 ? rawPolicy.spec : null,
        compiledAt: finiteNumber(rawPolicy.compiledAt),
        explanation: stringListOf(rawPolicy.explanation),
        warnings: stringListOf(rawPolicy.warnings),
        compiler: firstString(rawPolicy.compiler),
        summary: firstString(rawPolicy.summary),
      };
      return {
        policy,
        explanation: stringListOf(record.explanation, policy.explanation),
        warnings: stringListOf(record.warnings, policy.warnings),
        summary: firstString(record.summary, policy.summary),
        catalog: placementCatalogOf(record),
      };
    }

    function placementCatalogOf(data) {
      const record = asObject(data);
      const catalog = asObject(record.catalog);
      const labels = asObject(catalog.labels);
      return {
        machines: asArray(catalog.machines).filter((machine) => machine !== null && typeof machine === 'object'),
        labelKeys: Object.keys(labels),
        labels,
        models: stringListOf(catalog.models),
        machineCount: Math.max(0, Math.round(numberOr(record.machineCount, 0))),
      };
    }

    /** Flatten a compiled placement spec into localized rule chips. */
    function placementRuleChipsOf(policy, t) {
      const spec = asObject(policy.spec);
      if (policy.spec === null || Object.keys(spec).length === 0) return [];
      const chips = [];
      const require = asObject(spec.require);
      const requireLabels = asObject(require.machineLabels);
      for (const key of Object.keys(requireLabels)) {
        chips.push(t('ws.settings.placement.rule.requireLabels', { key, values: stringListOf(requireLabels[key]).join(',') }));
      }
      if (stringListOf(require.gpuModels).length > 0) {
        chips.push(t('ws.settings.placement.rule.requireModel', { values: stringListOf(require.gpuModels).join(',') }));
      }
      if (stringListOf(require.excludeGpuModels).length > 0) {
        chips.push(t('ws.settings.placement.rule.excludeModel', { values: stringListOf(require.excludeGpuModels).join(',') }));
      }
      if (stringListOf(require.machineIds).length > 0) {
        chips.push(t('ws.settings.placement.rule.requireMachines', { values: stringListOf(require.machineIds).join(',') }));
      }
      if (stringListOf(require.excludeMachineIds).length > 0) {
        chips.push(t('ws.settings.placement.rule.excludeMachines', { values: stringListOf(require.excludeMachineIds).join(',') }));
      }
      const excludeLabels = asObject(require.excludeMachineLabels);
      for (const key of Object.keys(excludeLabels)) {
        chips.push(t('ws.settings.placement.rule.excludeLabels', { key, values: stringListOf(excludeLabels[key]).join(',') }));
      }
      if (firstString(require.colocate) !== '') {
        chips.push(t('ws.settings.placement.rule.colocate', { key: firstString(require.colocate) }));
      }
      if (firstString(spec.preferColocate) !== '') {
        chips.push(t('ws.settings.placement.rule.preferColocate', { key: firstString(spec.preferColocate) }));
      }
      for (const preference of asArray(spec.prefer)) {
        const prefer = asObject(preference);
        const preferLabels = asObject(prefer.machineLabels);
        for (const key of Object.keys(preferLabels)) {
          chips.push(t('ws.settings.placement.rule.preferLabels', { key, values: stringListOf(preferLabels[key]).join(',') }));
        }
        if (stringListOf(prefer.gpuModels).length > 0) {
          chips.push(t('ws.settings.placement.rule.preferModel', { values: stringListOf(prefer.gpuModels).join(',') }));
        }
        if (stringListOf(prefer.machineIds).length > 0) {
          chips.push(t('ws.settings.placement.rule.preferMachines', { values: stringListOf(prefer.machineIds).join(',') }));
        }
      }
      return chips;
    }

    function placementErrorTextOf(error, t) {
      if (error instanceof LabRequestError) {
        if (error.code === 'bad_request' || error.code === 'cluster_config_invalid') {
          return t('ws.settings.placement.invalid') + ': ' + (error.message || '');
        }
        return error.message || t('ws.settings.placement.error');
      }
      return describeError(error, t);
    }

    function fleetLabelsOf(raw) {
      const labels = asObject(raw);
      const result = {};
      for (const key of Object.keys(labels)) {
        const value = firstString(labels[key]);
        if (key !== '' && value !== '') result[key] = value;
      }
      return result;
    }
    function fleetLabelChipsOf(raw) {
      const labels = fleetLabelsOf(raw);
      return Object.keys(labels).map((key) => ({ key, value: labels[key], text: key + '=' + labels[key] }));
    }

    const CLUSTER_FLEET_PLACEMENTS = ['local', 'fleet', 'auto'];
    const CLUSTER_FLEET_RUNTIMES = ['docker', 'podman', 'apptainer', 'none'];

    function fleetPairsOf(raw) {
      return asArray(raw)
        .filter((pair) => pair !== null && typeof pair === 'object')
        .map((pair) => ({ from: firstString(pair.from), to: firstString(pair.to) }))
        .filter((pair) => pair.from !== '' && pair.to !== '');
    }

    function fleetMachineOf(raw, index) {
      const machine = asObject(raw);
      const ssh = asObject(machine.ssh);
      const container = asObject(machine.container);
      const env = asObject(container.env);
      return {
        machineId: firstString(machine.machineId) || 'gpu-node-' + String(index + 1),
        masterAddr: firstString(machine.masterAddr),
        ssh: {
          host: firstString(ssh.host),
          user: firstString(ssh.user) || 'root',
          port: Math.max(1, Math.min(65535, Math.round(numberOr(ssh.port, 22)))),
          keyPath: firstString(ssh.keyPath),
          options: stringListOf(ssh.options),
          command: firstString(ssh.command) || 'ssh',
        },
        container: {
          runtime: CLUSTER_FLEET_RUNTIMES.indexOf(firstString(container.runtime)) >= 0 ? firstString(container.runtime) : 'docker',
          name: firstString(container.name),
          workdir: firstString(container.workdir),
          user: firstString(container.user),
          env: Object.keys(env).reduce((result, key) => {
            result[key] = String(env[key] === undefined || env[key] === null ? '' : env[key]);
            return result;
          }, {}),
        },
        devices: machine.devices === null || machine.devices === undefined
          ? null
          : asArray(machine.devices)
            .filter((device) => device !== null && typeof device === 'object')
            .map((device, deviceIndex) => ({
              id: firstString(device.id) || String(deviceIndex),
              localId: firstString(device.localId) || firstString(device.id) || String(deviceIndex),
              model: firstString(device.model) || 'GPU',
              memoryMiB: Math.max(0, Math.round(numberOr(device.memoryMiB, 0))),
            })),
        pathMap: fleetPairsOf(machine.pathMap),
        labels: fleetLabelsOf(machine.labels),
      };
    }

    function fleetConfigOf(raw) {
      const fleet = asObject(raw);
      return {
        enabled: fleet.enabled === true,
        placementMode: CLUSTER_FLEET_PLACEMENTS.indexOf(firstString(fleet.placementMode)) >= 0 ? firstString(fleet.placementMode) : 'local',
        masterPort: Math.max(1024, Math.min(65535, Math.round(numberOr(fleet.masterPort, 29500)))),
        pathMap: fleetPairsOf(fleet.pathMap),
        machines: asArray(fleet.machines)
          .filter((machine) => machine !== null && typeof machine === 'object')
          .map((machine, index) => fleetMachineOf(machine, index)),
      };
    }

    /** Editable fleet draft: scalar fields are strings, env/options are text lines. */
    function fleetDraftOf(fleet) {
      return {
        enabled: fleet.enabled === true,
        placementMode: CLUSTER_FLEET_PLACEMENTS.indexOf(firstString(fleet.placementMode)) >= 0 ? firstString(fleet.placementMode) : 'local',
        masterPort: String(Math.round(numberOr(fleet.masterPort, 29500))),
        pathMap: fleet.pathMap.map((pair, index) => ({ key: 'fleet-path-' + index, from: pair.from, to: pair.to })),
        machines: fleet.machines.map((machine, index) => ({
          key: 'fleet-machine-' + index,
          machineId: machine.machineId,
          masterAddr: machine.masterAddr,
          sshHost: machine.ssh.host,
          sshUser: machine.ssh.user,
          sshPort: String(machine.ssh.port),
          sshKeyPath: machine.ssh.keyPath,
          sshOptions: machine.ssh.options.join('\n'),
          sshCommand: machine.ssh.command,
          containerRuntime: machine.container.runtime,
          containerName: machine.container.name,
          containerWorkdir: machine.container.workdir,
          containerUser: machine.container.user,
          containerEnv: Object.keys(machine.container.env).map((key) => key + '=' + machine.container.env[key]).join('\n'),
          devicesMode: machine.devices === null ? 'auto' : 'manual',
          devices: asArray(machine.devices).map((device, deviceIndex) => ({
            key: 'fleet-device-' + index + '-' + deviceIndex,
            id: device.id,
            localId: device.localId,
            model: device.model,
            memoryMiB: String(Math.round(numberOr(device.memoryMiB, 0))),
          })),
          pathMap: machine.pathMap.map((pair, pairIndex) => ({ key: 'fleet-machine-path-' + index + '-' + pairIndex, from: pair.from, to: pair.to })),
          labels: Object.keys(machine.labels).map((key, labelIndex) => ({ key: 'fleet-machine-label-' + index + '-' + labelIndex, name: key, value: machine.labels[key] })),
          advancedOpen: false,
        })),
      };
    }

    /** Build the API fleet object from the draft; returns { fleet } or { error }. */
    function fleetConfigFromDraft(draft, t) {
      const pathMap = asArray(draft.pathMap)
        .map((row) => ({ from: clusterConfigTrimmed(row.from), to: clusterConfigTrimmed(row.to) }))
        .filter((row) => row.from !== '' && row.to !== '');
      const machines = [];
      for (const row of asArray(draft.machines)) {
        const machineId = clusterConfigTrimmed(row.machineId);
        const sshHost = clusterConfigTrimmed(row.sshHost);
        if (machineId === '' && sshHost === '') continue;
        const env = {};
        for (const line of String(row.containerEnv === undefined || row.containerEnv === null ? '' : row.containerEnv).split('\n')) {
          const trimmed = line.trim();
          if (trimmed === '') continue;
          const separator = trimmed.indexOf('=');
          if (separator <= 0) return { error: t('ws.clusterConfig.fleet.container.env.invalid') };
          env[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
        }
        const manualDevices = asArray(row.devices)
          .map((device) => ({
            id: clusterConfigTrimmed(device.id),
            localId: clusterConfigTrimmed(device.localId) || clusterConfigTrimmed(device.id),
            model: clusterConfigTrimmed(device.model) || 'GPU',
            memoryMiB: Math.max(0, Math.round(numberOr(device.memoryMiB, 0))),
          }))
          .filter((device) => device.id !== '');
        machines.push({
          machineId: machineId === '' ? 'gpu-node-' + String(machines.length + 1) : machineId,
          masterAddr: clusterConfigTrimmed(row.masterAddr) === '' ? null : clusterConfigTrimmed(row.masterAddr),
          ssh: {
            host: sshHost,
            user: clusterConfigTrimmed(row.sshUser) || 'root',
            port: Math.max(1, Math.min(65535, Math.round(numberOr(row.sshPort, 22)))),
            keyPath: clusterConfigTrimmed(row.sshKeyPath),
            options: String(row.sshOptions === undefined || row.sshOptions === null ? '' : row.sshOptions)
              .split('\n')
              .map((line) => line.trim())
              .filter((line) => line !== ''),
            command: clusterConfigTrimmed(row.sshCommand) || 'ssh',
          },
          container: {
            runtime: CLUSTER_FLEET_RUNTIMES.indexOf(firstString(row.containerRuntime)) >= 0 ? firstString(row.containerRuntime) : 'docker',
            name: clusterConfigTrimmed(row.containerName),
            workdir: clusterConfigTrimmed(row.containerWorkdir),
            user: clusterConfigTrimmed(row.containerUser),
            env,
          },
          devices: row.devicesMode === 'auto' ? null : manualDevices,
          labels: (() => {
            const labels = {};
            for (const labelRow of asArray(row.labels)) {
              const key = clusterConfigTrimmed(labelRow.name).toLowerCase();
              const value = clusterConfigTrimmed(labelRow.value).toLowerCase();
              if (key !== '' && value !== '') labels[key] = value;
            }
            return labels;
          })(),
          pathMap: asArray(row.pathMap)
            .map((pair) => ({ from: clusterConfigTrimmed(pair.from), to: clusterConfigTrimmed(pair.to) }))
            .filter((pair) => pair.from !== '' && pair.to !== ''),
        });
      }
      return {
        fleet: {
          enabled: draft.enabled === true,
          placementMode: CLUSTER_FLEET_PLACEMENTS.indexOf(firstString(draft.placementMode)) >= 0 ? firstString(draft.placementMode) : 'local',
          masterPort: Math.max(1024, Math.min(65535, Math.round(numberOr(draft.masterPort, 29500)))),
          pathMap,
          machines,
        },
      };
    }

    /** Node fleet helpers (remote execution + multi-machine lease). */
    function nodeRemoteOf(node) {
      const remote = asObject(asObject(node).remote);
      return remote !== null && typeof remote === 'object' && firstString(remote.mode) === 'fleet' ? remote : null;
    }
    function nodeLeaseMachinesOf(node) {
      const lease = asObject(asObject(node).lease);
      if (lease === null || typeof lease !== 'object') return [];
      return asArray(lease.machines).filter((group) => group !== null && typeof group === 'object');
    }
    function nodeIsFleetOf(node) {
      return nodeRemoteOf(node) !== null || nodeLeaseMachinesOf(node).length > 1;
    }
    function nodeFleetMachineCountOf(node) {
      const remote = nodeRemoteOf(node);
      const machineIds = remote === null ? [] : stringListOf(remote.machineIds);
      if (machineIds.length > 0) return machineIds.length;
      return Math.max(1, nodeLeaseMachinesOf(node).length || 1);
    }
    function nodeFleetGpuCountOf(node) {
      const machines = nodeLeaseMachinesOf(node);
      let count = 0;
      for (const group of machines) count += stringListOf(group.deviceIds).length;
      if (count > 0) return count;
      const needs = nodeNeedsOf(node);
      return Math.max(1, numberOr(needs.gpu, numberOr(needs.machines, 1)));
    }
    function nodeFleetBadgeTextOf(node, t) {
      return t('ws.fleet.badge', { machines: nodeFleetMachineCountOf(node), gpus: nodeFleetGpuCountOf(node) });
    }

    function clusterConfigPayloadOf(data) {
      const record = asObject(data);
      const raw = asObject(record.config);
      const listen = asObject(raw.listen);
      return {
        path: firstString(record.path),
        config: {
          enabled: raw.enabled === true,
          role: CLUSTER_CONFIG_ROLES.indexOf(firstString(raw.role)) >= 0 ? firstString(raw.role) : 'both',
          clusterId: firstString(raw.clusterId) || 'default',
          instanceId: firstString(raw.instanceId),
          machineId: firstString(raw.machineId),
          coordinatorId: firstString(raw.coordinatorId),
          userId: firstString(raw.userId) || 'default',
          url: firstString(raw.url),
          listenHost: firstString(listen.host) || '127.0.0.1',
          listenPort: Math.max(1, Math.round(numberOr(listen.port, 8791))),
          tokenSet: raw.tokenSet === true,
          tokenMasked: firstString(raw.tokenMasked),
          heartbeatMs: Math.max(1000, Math.round(numberOr(raw.heartbeatMs, 10000))),
          leaseTtlMs: Math.max(1000, Math.round(numberOr(raw.leaseTtlMs, 900000))),
          devices: raw.devices === null || raw.devices === undefined
            ? null
            : asArray(raw.devices)
              .filter((device) => device !== null && typeof device === 'object')
              .map((device) => ({
                id: firstString(device.id),
                model: firstString(device.model),
                memoryMiB: Math.max(0, Math.round(numberOr(device.memoryMiB, 0))),
              })),
          priority: Math.round(numberOr(raw.priority, 0)),
          dashboard: raw.dashboard !== false,
          allowMultipleCoordinators: raw.allowMultipleCoordinators === true,
          claimDir: firstString(raw.claimDir),
          stateFile: firstString(raw.stateFile),
          fleet: fleetConfigOf(raw.fleet),
        },
        status: asObject(record.status),
        activeLeases: Math.max(0, Math.round(numberOr(record.activeLeases, 0))),
        canApply: record.canApply !== false,
        warnings: stringListOf(record.warnings),
      };
    }

    /** Form draft (all scalar inputs are strings; token is never prefilled). */
    function clusterConfigDraftOf(payload) {
      const config = asObject(payload).config;
      const status = asObject(asObject(payload).status);
      const devices = asArray(config.devices);
      const listenPort = Math.max(1, Math.round(numberOr(config.listenPort, 8791)));
      const derivedUrl = 'http://127.0.0.1:' + String(listenPort);
      return {
        enabled: config.enabled === true,
        role: CLUSTER_CONFIG_ROLES.indexOf(firstString(config.role)) >= 0 ? firstString(config.role) : 'both',
        clusterId: firstString(config.clusterId) || 'default',
        machineId: firstString(config.machineId) || firstString(status.machineId),
        userId: firstString(config.userId) || 'default',
        instanceId: firstString(config.instanceId),
        coordinatorId: firstString(config.coordinatorId),
        url: firstString(config.url) || derivedUrl,
        listenHost: firstString(config.listenHost) || '127.0.0.1',
        listenPort: String(listenPort),
        heartbeatSeconds: String(Math.round(numberOr(config.heartbeatMs, 10000) / 1000)),
        leaseTtlMinutes: String(Math.round(numberOr(config.leaseTtlMs, 900000) / 60000)),
        tokenInput: '',
        tokenClear: false,
        devicesMode: config.devices === null ? 'auto' : 'manual',
        devices: devices.map((device, index) => ({
          key: 'cluster-device-' + index,
          id: firstString(device.id),
          model: firstString(device.model),
          memoryMiB: String(Math.round(numberOr(device.memoryMiB, 0))),
        })),
        dashboard: config.dashboard !== false,
        allowMultipleCoordinators: config.allowMultipleCoordinators === true,
        priority: String(Math.round(numberOr(config.priority, 0))),
        claimDir: firstString(config.claimDir),
        stateFile: firstString(config.stateFile),
        fleet: fleetDraftOf(fleetConfigOf(config.fleet)),
      };
    }

    function clusterConfigTrimmed(value) {
      return String(value === undefined || value === null ? '' : value).trim();
    }

    /** Build the POST patch (and inline error) from only the fields the user changed. */
    function clusterConfigPatchOf(draft, payload, t) {
      const config = asObject(payload).config;
      const patch = {};
      const role = CLUSTER_CONFIG_ROLES.indexOf(firstString(draft.role)) >= 0 ? firstString(draft.role) : 'both';
      const clusterId = clusterConfigTrimmed(draft.clusterId) || 'default';
      const machineId = clusterConfigTrimmed(draft.machineId);
      const userId = clusterConfigTrimmed(draft.userId) || 'default';
      const priority = Math.round(numberOr(draft.priority, 0));
      if (draft.enabled === true !== (config.enabled === true)) patch.enabled = draft.enabled === true;
      if (role !== firstString(config.role)) patch.role = role;
      if (clusterId !== firstString(config.clusterId)) patch.clusterId = clusterId;
      if (machineId !== firstString(config.machineId)) patch.machineId = machineId === '' ? null : machineId;
      if (userId !== firstString(config.userId)) patch.userId = userId;
      if (priority !== Math.round(numberOr(config.priority, 0))) patch.priority = priority;
      if ((draft.dashboard === true) !== (config.dashboard !== false)) patch.dashboard = draft.dashboard === true;
      if ((draft.allowMultipleCoordinators === true) !== (config.allowMultipleCoordinators === true)) {
        patch.allowMultipleCoordinators = draft.allowMultipleCoordinators === true;
      }
      const instanceId = clusterConfigTrimmed(draft.instanceId);
      const coordinatorId = clusterConfigTrimmed(draft.coordinatorId);
      const url = clusterConfigTrimmed(draft.url);
      const listenHost = clusterConfigTrimmed(draft.listenHost) || '127.0.0.1';
      const listenPort = Math.max(1, Math.round(numberOr(draft.listenPort, 8791)));
      const claimDir = clusterConfigTrimmed(draft.claimDir);
      const stateFile = clusterConfigTrimmed(draft.stateFile);
      if (instanceId !== firstString(config.instanceId)) patch.instanceId = instanceId === '' ? null : instanceId;
      if (coordinatorId !== firstString(config.coordinatorId)) patch.coordinatorId = coordinatorId === '' ? null : coordinatorId;
      if (url !== firstString(config.url)) patch.url = url === '' ? null : url;
      if (claimDir !== firstString(config.claimDir)) patch.claimDir = claimDir === '' ? null : claimDir;
      if (stateFile !== firstString(config.stateFile)) patch.stateFile = stateFile === '' ? null : stateFile;
      if (listenHost !== firstString(config.listenHost) || listenPort !== Math.round(numberOr(config.listenPort, 8791))) {
        patch.listen = { host: listenHost, port: listenPort };
      }
      const heartbeatSeconds = Math.max(1, Math.round(numberOr(draft.heartbeatSeconds, 10)));
      const leaseTtlMinutes = Math.max(1, Math.round(numberOr(draft.leaseTtlMinutes, 15)));
      if (heartbeatSeconds * 1000 !== Math.round(numberOr(config.heartbeatMs, 10000))) patch.heartbeatMs = heartbeatSeconds * 1000;
      if (leaseTtlMinutes * 60000 !== Math.round(numberOr(config.leaseTtlMs, 900000))) patch.leaseTtlMs = leaseTtlMinutes * 60000;
      const manualDevices = asArray(draft.devices)
        .map((device) => ({
          id: clusterConfigTrimmed(device.id),
          model: clusterConfigTrimmed(device.model),
          memoryMiB: Math.max(0, Math.round(numberOr(device.memoryMiB, 0))),
        }))
        .filter((device) => device.id !== '');
      const devicesChanged = draft.devicesMode === 'auto'
        ? config.devices !== null
        : JSON.stringify(manualDevices) !== JSON.stringify(config.devices === null ? [] : config.devices);
      if (devicesChanged) patch.devices = draft.devicesMode === 'auto' ? null : manualDevices;
      if (draft.tokenClear === true) patch.token = '';
      else if (clusterConfigTrimmed(draft.tokenInput) !== '') patch.token = String(draft.tokenInput).trim();
      const builtFleet = fleetConfigFromDraft(draft.fleet, t);
      if (builtFleet.error !== undefined) return { patch, error: builtFleet.error };
      if (JSON.stringify(builtFleet.fleet) !== JSON.stringify(fleetConfigOf(config.fleet))) patch.fleet = builtFleet.fleet;
      return { patch, error: '' };
    }

    function clusterConfigErrorTextOf(error, t) {
      if (error instanceof LabRequestError) {
        if (error.code === 'cluster_busy') return t('ws.clusterConfig.error.busy');
        if (error.code === 'bad_request' || error.code === 'cluster_config_invalid') {
          return t('ws.clusterConfig.error.invalid') + ': ' + (error.message || '');
        }
        if (error.code === 'unavailable') return t('ws.clusterConfig.error.unavailable');
        return error.message || t('ws.clusterConfig.loadError');
      }
      return describeError(error, t);
    }

    function clusterConfigStatusUrlOf(status) {
      const record = asObject(status);
      return firstString(record.url, record.coordinatorUrl);
    }

    function clusterConfigMachinesSummaryOf(status, t) {
      const machines = clusterMachinesOf(asObject(status));
      if (machines.length === 0) return t('ws.cluster.empty');
      return machines.map((machine) => {
        const devices = asArray(machine.devices);
        return (firstString(machine.machineId) || '—') + ' · ' + t('ws.clusterConfig.devices.summary', { count: devices.length });
      }).join(' · ');
    }

    async function copyTextToClipboard(value) {
      const text = String(value === undefined || value === null ? '' : value);
      if (text === '') return false;
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch (error) {
        return false;
      }
      return false;
    }

    function clusterPoolSummaryTextOf(cluster, t) {
      const pools = clusterPoolsOf(cluster);
      const keys = Object.keys(pools);
      if (keys.length === 0) return t('ws.cluster.empty');
      return keys.map((key) => {
        const pool = asObject(pools[key]);
        return t('ws.cluster.poolRow', {
          pool: key,
          used: Math.round(numberOr(pool.used, 0)),
          total: Math.round(numberOr(pool.total, 0)),
          free: Math.round(numberOr(pool.free, 0)),
        });
      }).join(' · ');
    }

    function useModelCatalog(projectId, t) {
      const [state, setState] = React.useState({ phase: 'loading', catalog: null, error: '' });
      const [attempt, setAttempt] = React.useState(0);
      React.useEffect(() => {
        if (!projectId) return undefined;
        let alive = true;
        const controller = new AbortController();
        setState((previous) => ({ phase: previous.catalog === null ? 'loading' : 'ready', catalog: previous.catalog, error: '' }));
        api.fetchModels(projectId, controller.signal, t)
          .then((data) => {
            if (!alive) return;
            setState({ phase: 'ready', catalog: normalizeModelCatalog(data), error: '' });
          })
          .catch((error) => {
            if (!alive || isAbortError(error)) return;
            setState((previous) => ({ phase: previous.catalog === null ? 'error' : 'ready', catalog: previous.catalog, error: describeError(error, t) }));
          });
        return () => {
          alive = false;
          controller.abort();
        };
      }, [projectId, attempt, t]);
      const retry = React.useCallback(() => setAttempt((value) => value + 1), []);
      return { state, retry };
    }

    function useCluster(projectId, t, open) {
      const [state, setState] = React.useState({ phase: 'idle', cluster: null, error: '' });
      const [attempt, setAttempt] = React.useState(0);
      React.useEffect(() => {
        if (!open || !projectId) return undefined;
        let alive = true;
        let timer = null;
        let controller = null;
        const doc = typeof document !== 'undefined' ? document : null;
        const load = async () => {
          if (doc !== null && doc.visibilityState === 'hidden') {
            if (alive) timer = setTimeout(load, POLL_CLUSTER_MS);
            return;
          }
          if (controller) controller.abort();
          controller = new AbortController();
          try {
            const data = await api.fetchCluster(projectId, controller.signal, t);
            if (!alive) return;
            setState({ phase: 'ready', cluster: asObject(data), error: '' });
          } catch (error) {
            if (!alive || isAbortError(error)) return;
            setState((previous) => ({ phase: previous.cluster === null ? 'error' : 'ready', cluster: previous.cluster, error: describeError(error, t) }));
          }
          if (alive) timer = setTimeout(load, POLL_CLUSTER_MS);
        };
        void load();
        return () => {
          alive = false;
          if (timer !== null) clearTimeout(timer);
          if (controller) controller.abort();
        };
      }, [projectId, open, attempt, t]);
      const refresh = React.useCallback(() => setAttempt((value) => value + 1), []);
      return { state, refresh };
    }

    function nodeProposalOf(node) {
      const proposal = asObject(node).proposal;
      return proposal !== null && typeof proposal === 'object' && Object.keys(proposal).length > 0 ? proposal : null;
    }
    function nodeApprovedAtOf(node) {
      return finiteNumber(asObject(node).approvedAt);
    }
    function terminationGcPostmortemOf(node) {
      const termination = nodeTerminationOf(node);
      if (termination === null) return null;
      const postmortem = termination.gcPostmortem;
      return postmortem !== null && typeof postmortem === 'object' ? postmortem : null;
    }
    function terminationGcRunIdOf(node) {
      const termination = nodeTerminationOf(node);
      return termination === null ? '' : firstString(termination.gcRunId);
    }

    function autoStatusOf(auto) {
      const status = firstString(asObject(auto).status);
      return status === 'off' || status === 'running' || status === 'paused' || status === 'waiting' ? status : 'off';
    }
    function autoPauseReasonOf(auto) {
      const reason = firstString(asObject(auto).pauseReason);
      return reason;
    }
    function autoPauseLabelKeyOf(reason) {
      const known = ['maxCycles', 'maxWallClock', 'maxNodes', 'noProgress', 'idle', 'errors', 'awaitingConfirmation', 'hostRestarted', 'maxTokens', 'maxCost', 'resourcesQueued'];
      return known.indexOf(reason) >= 0 ? 'ws.auto.pause.' + reason : 'ws.auto.pause.unknown';
    }
    function autoLimitsOf(auto, project) {
      const limits = asObject(asObject(auto).limits);
      const config = projectConfig(project);
      const autoConfig = asObject(config.auto);
      return {
        maxCycles: numberOr(limits.maxCycles, numberOr(autoConfig.maxCycles, 50)),
        maxWallClockMs: numberOr(limits.maxWallClockMs, numberOr(autoConfig.maxWallClockMs, 6 * 60 * 60 * 1000)),
        idleCycleLimit: numberOr(limits.idleCycleLimit, numberOr(autoConfig.idleCycleLimit, 3)),
        maxNodes: numberOr(limits.maxNodes, numberOr(config.maxNodes, 60)),
        maxTokens: numberOr(limits.maxTokens, numberOr(autoConfig.maxTokens, 0)),
        maxCostUsd: numberOr(limits.maxCostUsd, numberOr(autoConfig.maxCostUsd, 0)),
      };
    }
    function configAdvisorOf(project) {
      return asObject(projectConfig(project).advisor);
    }
    function configAutoOf(project) {
      return asObject(projectConfig(project).auto);
    }
    function configModelsOf(project) {
      return asObject(projectConfig(project).models);
    }
    function configPromptsOf(project) {
      return asObject(projectConfig(project).prompts);
    }
    /** Localize project.delete failures; unknown errors fall back to the envelope message. */
    function projectDeleteErrorTextOf(error, t) {
      if (error instanceof LabRequestError) {
        if (error.code === 'project_busy') return t('landing.delete.error.project_busy');
        if (error.code === 'project_not_found') return t('landing.delete.error.project_not_found');
        return error.message || t('landing.delete.error');
      }
      return describeError(error, t);
    }

    function formatHoursFromMs(milliseconds) {
      const value = finiteNumber(milliseconds);
      if (value === null || value <= 0) return '0';
      return String(Math.round((value / 3600000) * 10) / 10);
    }
    function runRoleLabelOf(role, t) {
      if (role === 'advisor' || role === 'scheduler' || role === 'gc') return t('ws.runs.role.' + role);
      return role || t('common.unknown');
    }
    function gcPostmortemTextOf(postmortem, field) {
      return firstString(asObject(postmortem)[field]);
    }
    function gcPostmortemListOf(postmortem, field) {
      return stringListOf(asObject(postmortem)[field]);
    }
    function runGcSummaryOf(run) {
      const record = asObject(run);
      const output = asObject(record.output);
      return firstString(record.summary, output.summary, output.postmortemSummary);
    }
    function runGcRecommendationOf(run) {
      const record = asObject(run);
      const output = asObject(record.output);
      return firstString(record.recommendation, output.recommendation, output.nextStep);
    }

    /** `mm:ss` / `h:mm:ss` remaining time, plus an overdue flag. */
    function countdownOf(deadlineAt, now) {
      const deadline = finiteNumber(deadlineAt);
      if (deadline === null) return null;
      const diff = deadline - (finiteNumber(now) === null ? Date.now() : now);
      const remaining = Math.max(0, diff);
      const totalSeconds = Math.ceil(remaining / 1000);
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      const mmss = pad2(minutes) + ':' + pad2(seconds);
      const text = hours > 0 ? String(hours) + ':' + pad2(minutes) + ':' + pad2(seconds) : mmss;
      return { text, overdue: diff <= 0, remainingMs: diff };
    }
    function pad2(value) {
      return value < 10 ? '0' + value : String(value);
    }
    /** Normalize a report list (strings or scalar objects) into display strings. */
    function stringListOf(value) {
      const out = [];
      for (const item of asArray(value)) {
        if (typeof item === 'string') {
          if (item.trim()) out.push(item.trim());
        } else if (typeof item === 'number' || typeof item === 'boolean') {
          out.push(String(item));
        } else if (item !== null && typeof item === 'object') {
          try {
            out.push(JSON.stringify(item));
          } catch (error) {
            /* non-serializable entry: skip */
          }
        }
      }
      return out;
    }
    function needsSummaryOf(needs) {
      const record = asObject(needs);
      return Object.keys(record)
        .filter((key) => numberOr(record[key], 0) > 0)
        .map((key) => key + '×' + numberOr(record[key], 0))
        .join(', ');
    }
    function freeResourcesOf(resources) {
      return asObject(asObject(resources).free);
    }

    function formatDurationBetween(startedAt, endedAt) {
      const start = finiteNumber(startedAt);
      if (start === null) return '—';
      const end = finiteNumber(endedAt);
      const milliseconds = Math.max(0, (end === null ? Date.now() : end) - start);
      if (milliseconds < 1000) return String(Math.round(milliseconds)) + 'ms';
      if (milliseconds < 60000) return (milliseconds / 1000).toFixed(1) + 's';
      const totalSeconds = Math.floor(milliseconds / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      if (minutes < 60) return String(minutes) + 'm ' + pad2(totalSeconds % 60) + 's';
      const hours = Math.floor(minutes / 60);
      return String(hours) + 'h ' + pad2(minutes % 60) + 'm';
    }
    function runRoleOf(run) {
      const role = firstString(asObject(run).role);
      return role === 'advisor' || role === 'scheduler' ? role : role;
    }
    function runStatusOf(run) {
      const status = firstString(asObject(run).status);
      return status === 'running' || status === 'completed' || status === 'failed' ? status : 'completed';
    }
    function runIdOf(run) {
      return firstString(asObject(run).id, asObject(run).runId);
    }
    function runErrorTextOf(run) {
      const record = asObject(run);
      const error = record.error;
      if (typeof error === 'string' && error.length > 0) return error;
      const message = firstString(asObject(error).message);
      return message;
    }
    function idListOf(value) {
      return asArray(value).filter((item) => typeof item === 'string' && item.length > 0);
    }
    function normalizeRuns(data) {
      const record = asObject(data);
      return {
        runs: asArray(record.runs).filter((run) => run !== null && typeof run === 'object'),
        cycles: asArray(record.cycles).filter((cycle) => cycle !== null && typeof cycle === 'object'),
      };
    }
    function shortCommitOf(value) {
      return shortCommit(value);
    }

    function shortCommit(value) {
      const text = firstString(value);
      return text.length > 7 ? text.slice(0, 7) : text;
    }
    function formatDateTime(value, t) {
      const numeric = finiteNumber(value);
      if (numeric === null) return typeof t === 'function' ? t('common.none') : '—';
      try {
        return new Intl.DateTimeFormat(t('intl.locale'), { dateStyle: 'short', timeStyle: 'short' }).format(new Date(numeric));
      } catch (error) {
        return t('common.none');
      }
    }
    function formatClock(value, t) {
      const numeric = finiteNumber(value);
      if (numeric === null) return '--:--:--';
      try {
        return new Intl.DateTimeFormat(t('intl.locale'), {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        }).format(new Date(numeric));
      } catch (error) {
        return '--:--:--';
      }
    }
    function basenameOfPath(value) {
      const text = firstString(value).replace(/[\\/]+$/, '');
      if (!text) return '';
      const parts = text.split(/[\\/]/);
      return parts.length > 0 ? parts[parts.length - 1] : '';
    }
    function parseInteger(value, fallback) {
      const text = value === null || value === undefined ? '' : String(value).trim();
      const numeric = Number.parseInt(text, 10);
      return Number.isFinite(numeric) ? numeric : fallback;
    }

    /** Normalize the GET /projects payload into an array of project records. */
    function normalizeProjects(data) {
      const list = Array.isArray(data) ? data : asArray(asObject(data).projects);
      return list.filter((project) => project !== null && typeof project === 'object');
    }

    /** Normalize the GET /repo payload (branches may be absent on malformed input). */
    function normalizeRepoInfo(data) {
      const record = asObject(data);
      const branches = asArray(record.branches).filter((branch) => typeof branch === 'string' && branch.length > 0);
      const defaultBranch = firstString(record.defaultBranch, branches.length > 0 ? branches[0] : '');
      return {
        repoRoot: firstString(record.repoRoot, record.root),
        gitDir: firstString(record.gitDir, record.gitdir),
        branches,
        defaultBranch,
        baseCommit: firstString(record.baseCommit, record.commit),
        dirty: record.dirty === true,
      };
    }

    /** Normalize the GET /state payload. Edges fall back to node.parentId. */
    function normalizeState(data) {
      const record = asObject(data);
      const project = asObject(record.project);
      const nodes = asArray(record.nodes).filter((node) => node !== null && typeof node === 'object');
      const known = {};
      for (const node of nodes) {
        const id = nodeIdOf(node);
        if (id) known[id] = true;
      }
      let edges = asArray(record.edges)
        .map((edge) => {
          const raw = asObject(edge);
          return { from: firstString(raw.from, raw.parentId, raw.parent), to: firstString(raw.to, raw.childId, raw.child) };
        })
        .filter((edge) => edge.from.length > 0 && edge.to.length > 0 && known[edge.from] === true && known[edge.to] === true);
      if (edges.length === 0) {
        edges = nodes
          .map((node) => {
            const parent = nodeParentIdOf(node);
            const id = nodeIdOf(node);
            return parent && id && known[parent] === true ? { from: parent, to: id } : null;
          })
          .filter((edge) => edge !== null);
      }
      const rawResources = record.resources;
      const resources = rawResources !== null && typeof rawResources === 'object'
        ? {
            pools: asObject(rawResources.pools),
            held: asObject(rawResources.held),
            free: asObject(rawResources.free),
          }
        : null;
      const rawAuto = record.auto;
      const auto = rawAuto !== null && typeof rawAuto === 'object' ? rawAuto : null;
      const rawCluster = record.cluster;
      const cluster = rawCluster !== null && typeof rawCluster === 'object' ? rawCluster : null;
      return {
        project,
        nodes,
        edges,
        resources,
        worktreeRoot: firstString(record.worktreeRoot, projectWorktreeRoot(project)),
        revision: finiteNumber(record.revision),
        auto,
        cluster,
        pendingProposals: Math.max(0, Math.round(numberOr(record.pendingProposals, 0))),
      };
    }
    // #endregion

    // #region layered DAG layout (no graph library; see docs/03-ui-spec §6.1)
    function nodeTimeOf(node) {
      return numberOr(nodeTimestampsOf(node).createdAt, 0);
    }

    /** Stable ordering helper: creation time, then the original list order. */
    function creationOrder(leftNode, leftOrder, rightNode, rightOrder) {
      const leftAt = nodeTimeOf(leftNode);
      const rightAt = nodeTimeOf(rightNode);
      if (leftAt !== rightAt) return leftAt - rightAt;
      return leftOrder - rightOrder;
    }

    /**
     * Layered layout: depth = parent depth + 1, one layer per column, one card per
     * row cell, each layer vertically centred. Returns card positions plus canvas
     * bounds. Single-parent MVP: the first edge into a node wins.
     */
    function computeLayout(nodes, edges) {
      if (nodes.length === 0) return { positions: new Map(), width: 0, height: 0, depth: 0 };
      const recordById = new Map();
      const orderById = new Map();
      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        const id = nodeIdOf(node);
        if (!id) continue;
        recordById.set(id, node);
        orderById.set(id, index);
      }
      const parentOf = new Map();
      const childrenOf = new Map();
      const addChild = (parentId, childId) => {
        const existing = childrenOf.get(parentId);
        if (existing === undefined) childrenOf.set(parentId, [childId]);
        else existing.push(childId);
      };
      for (const edge of edges) {
        if (!recordById.has(edge.from) || !recordById.has(edge.to) || edge.from === edge.to) continue;
        if (parentOf.has(edge.to)) continue;
        parentOf.set(edge.to, edge.from);
        addChild(edge.from, edge.to);
      }
      for (const id of recordById.keys()) {
        if (parentOf.has(id)) continue;
        const parent = nodeParentIdOf(recordById.get(id));
        if (parent && parent !== id && recordById.has(parent)) {
          parentOf.set(id, parent);
          addChild(parent, id);
        }
      }
      const depth = new Map();
      const roots = [];
      for (const id of recordById.keys()) if (!parentOf.has(id)) roots.push(id);
      roots.sort((left, right) => creationOrder(recordById.get(left), orderById.get(left), recordById.get(right), orderById.get(right)));
      const queue = roots.map((id) => ({ id, depth: 0 }));
      let guard = 0;
      while (queue.length > 0 && guard < 10000) {
        guard += 1;
        const current = queue.shift();
        if (depth.has(current.id)) continue;
        depth.set(current.id, current.depth);
        const children = (childrenOf.get(current.id) || []).slice().sort((left, right) =>
          creationOrder(recordById.get(left), orderById.get(left), recordById.get(right), orderById.get(right)));
        for (const child of children) if (!depth.has(child)) queue.push({ id: child, depth: current.depth + 1 });
      }
      for (const id of recordById.keys()) if (!depth.has(id)) depth.set(id, 0);
      let maxDepth = 0;
      for (const value of depth.values()) if (value > maxDepth) maxDepth = value;
      const layers = [];
      for (let index = 0; index <= maxDepth; index += 1) layers.push([]);
      for (const id of recordById.keys()) layers[depth.get(id)].push(id);
      for (const layer of layers) {
        layer.sort((left, right) => creationOrder(recordById.get(left), orderById.get(left), recordById.get(right), orderById.get(right)));
      }
      const positions = new Map();
      const columnWidth = NODE_W + GAP_X;
      const rowHeight = NODE_H + GAP_Y;
      let maxRows = 1;
      for (const layer of layers) if (layer.length > maxRows) maxRows = layer.length;
      for (let column = 0; column < layers.length; column += 1) {
        const layer = layers[column];
        const top = CANVAS_PAD + ((maxRows - layer.length) / 2) * rowHeight;
        for (let rowIndex = 0; rowIndex < layer.length; rowIndex += 1) {
          positions.set(layer[rowIndex], {
            x: CANVAS_PAD + column * columnWidth,
            y: top + rowIndex * rowHeight,
          });
        }
      }
      return {
        positions,
        width: CANVAS_PAD * 2 + layers.length * columnWidth - GAP_X,
        height: CANVAS_PAD * 2 + maxRows * rowHeight - GAP_Y,
        depth: maxDepth,
      };
    }

    /** Bezier edge from the right edge of the parent card to the left edge of the child. */
    function edgePath(from, to) {
      const x1 = from.x + NODE_W;
      const y1 = from.y + NODE_H / 2;
      const x2 = to.x;
      const y2 = to.y + NODE_H / 2;
      const bend = Math.max(36, Math.abs(x2 - x1) * 0.5);
      return 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + bend) + ' ' + y1 + ', ' + (x2 - bend) + ' ' + y2 + ', ' + x2 + ' ' + y2;
    }

    /** Ids on the selected node's ancestor/descendant paths (used for dimming). */
    function relatedNodeIds(selectedId, edges) {
      const related = new Set();
      if (selectedId === null) return related;
      const parentOf = new Map();
      const childrenOf = new Map();
      for (const edge of edges) {
        parentOf.set(edge.to, edge.from);
        const existing = childrenOf.get(edge.from);
        if (existing === undefined) childrenOf.set(edge.from, [edge.to]);
        else existing.push(edge.to);
      }
      let cursor = parentOf.get(selectedId);
      let guard = 0;
      while (cursor !== undefined && guard < 10000) {
        guard += 1;
        related.add(cursor);
        cursor = parentOf.get(cursor);
      }
      const stack = (childrenOf.get(selectedId) || []).slice();
      guard = 0;
      while (stack.length > 0 && guard < 10000) {
        guard += 1;
        const id = stack.pop();
        if (related.has(id)) continue;
        related.add(id);
        for (const child of childrenOf.get(id) || []) stack.push(child);
      }
      return related;
    }
    // #endregion

    // #region hooks
    /** Load the project list and a non-blocking Host health probe for the landing page. */
    function useProjectsData(t) {
      const [state, setState] = React.useState({ phase: 'loading', projects: [], health: null, error: null });
      const [attempt, setAttempt] = React.useState(0);
      React.useEffect(() => {
        const controller = new AbortController();
        let alive = true;
        setState((previous) => ({
          ...previous,
          phase: previous.projects.length > 0 ? 'ready' : 'loading',
          error: null,
        }));
        (async () => {
          try {
            const payload = await api.listProjects(controller.signal, t);
            let health = null;
            try {
              health = await api.health(controller.signal, t);
            } catch (error) {
              if (isAbortError(error)) throw error;
            }
            if (!alive) return;
            setState({
              phase: 'ready',
              projects: normalizeProjects(payload),
              health: health !== null && typeof health === 'object' ? health : null,
              error: null,
            });
          } catch (error) {
            if (!alive || isAbortError(error)) return;
            setState((previous) => ({
              phase: 'error',
              projects: previous.projects,
              health: previous.health,
              error: describeError(error, t),
            }));
          }
        })();
        return () => {
          alive = false;
          controller.abort();
        };
      }, [attempt, t]);
      const retry = React.useCallback(() => {
        setAttempt((value) => value + 1);
      }, []);
      /** Drop one project from the local list after a successful delete. */
      const removeProject = React.useCallback((projectId) => {
        setState((previous) => ({
          ...previous,
          projects: previous.projects.filter((project) => projectIdOf(project) !== projectId),
        }));
      }, []);
      return { state, retry, removeProject };
    }

    /**
     * Poll one project: `/state` every 1.5s with revision short-circuit, `/events`
     * every 2s with an `after` cursor. Polling pauses while the document is
     * hidden and resumes with an immediate refetch; failures back off
     * 1.5s → 3s → 5s and surface through the inline banner.
     */
    function useProjectWorkspace(projectId, t) {
      const [snapshot, setSnapshot] = React.useState({
        phase: 'loading',
        project: null,
        nodes: [],
        edges: [],
        resources: null,
        worktreeRoot: '',
        revision: null,
        auto: null,
        cluster: null,
        pendingProposals: 0,
        error: null,
      });
      const [events, setEvents] = React.useState([]);
      const [offline, setOffline] = React.useState(null);
      const revisionRef = React.useRef(null);
      const eventsNextRef = React.useRef(0);
      /** Highest event seq already shown; Host `next` may be last-seq or last+1. */
      const lastEventSeqRef = React.useRef(0);
      const stateBackoffRef = React.useRef(0);
      const eventsBackoffRef = React.useRef(0);
      const refreshRef = React.useRef(null);
      const retryRef = React.useRef(null);

      React.useEffect(() => {
        let alive = true;
        revisionRef.current = null;
        eventsNextRef.current = 0;
        lastEventSeqRef.current = 0;
        stateBackoffRef.current = 0;
        eventsBackoffRef.current = 0;
        setSnapshot({
          phase: 'loading',
          project: null,
          nodes: [],
          edges: [],
          resources: null,
          worktreeRoot: '',
          revision: null,
          auto: null,
          cluster: null,
          pendingProposals: 0,
          error: null,
        });
        setEvents([]);
        setOffline(null);

        const doc = typeof document !== 'undefined' ? document : null;
        const timers = { state: null, events: null };
        const flights = { state: null, events: null };
        /** Per-channel failure flags: the banner clears only when both recover. */
        const failing = { state: false, events: false };
        const visible = () => doc === null || doc.visibilityState === 'visible';
        const clearTimer = (name) => {
          const timer = timers[name];
          if (timer !== null) {
            clearTimeout(timer);
            timers[name] = null;
          }
        };
        const schedule = (name, delay, run) => {
          clearTimer(name);
          if (!alive || !visible()) return;
          timers[name] = setTimeout(() => {
            timers[name] = null;
            if (alive && visible()) void run();
          }, delay);
        };
        const abortFlight = (name) => {
          const controller = flights[name];
          if (controller === null) return;
          flights[name] = null;
          try {
            controller.abort();
          } catch (error) {
            /* the request may already be settled */
          }
        };
        const backoffDelay = (counterRef) => BACKOFF_MS[Math.min(counterRef.current, BACKOFF_MS.length - 1)];
        const recordFailure = (name, counterRef, error, nextRun) => {
          failing[name] = true;
          const delay = backoffDelay(counterRef);
          counterRef.current = Math.min(counterRef.current + 1, BACKOFF_MS.length - 1);
          const message = describeError(error, t);
          setOffline({ message, delay });
          setSnapshot((previous) => (previous.phase === 'ready' ? previous : { ...previous, phase: 'error', error: message }));
          schedule(name, delay, nextRun);
        };
        const clearFailure = (name) => {
          failing[name] = false;
          if (!failing.state && !failing.events) setOffline(null);
        };

        const pollState = async () => {
          if (!alive || !visible()) return;
          abortFlight('state');
          const controller = new AbortController();
          flights.state = controller;
          try {
            const data = await api.fetchState(projectId, revisionRef.current, controller.signal, t);
            if (!alive) return;
            flights.state = null;
            if (data !== null && typeof data === 'object' && data.unchanged === true) {
              const revision = finiteNumber(data.revision);
              if (revision !== null) revisionRef.current = revision;
            } else {
              const normalized = normalizeState(data);
              revisionRef.current = normalized.revision;
              setSnapshot({
                phase: 'ready',
                project: normalized.project,
                nodes: normalized.nodes,
                edges: normalized.edges,
                resources: normalized.resources,
                worktreeRoot: normalized.worktreeRoot,
                revision: normalized.revision,
                auto: normalized.auto,
                pendingProposals: normalized.pendingProposals,
                cluster: normalized.cluster,
                error: null,
              });
            }
            stateBackoffRef.current = 0;
            clearFailure('state');
            schedule('state', POLL_STATE_MS, pollState);
          } catch (error) {
            if (!alive || isAbortError(error)) return;
            flights.state = null;
            recordFailure('state', stateBackoffRef, error, pollState);
          }
        };

        const pollEvents = async () => {
          if (!alive || !visible()) return;
          abortFlight('events');
          const controller = new AbortController();
          flights.events = controller;
          try {
            const data = await api.fetchEvents(projectId, eventsNextRef.current, controller.signal, t);
            if (!alive) return;
            flights.events = null;
            const payload = asObject(data);
            const incoming = asArray(payload.events).filter((event) => event !== null && typeof event === 'object');
            const fresh = [];
            let highest = lastEventSeqRef.current;
            for (const event of incoming) {
              const seq = finiteNumber(asObject(event).seq);
              if (seq === null) {
                fresh.push(event);
                continue;
              }
              if (seq > lastEventSeqRef.current) fresh.push(event);
              if (seq > highest) highest = seq;
            }
            lastEventSeqRef.current = highest;
            if (fresh.length > 0) {
              setEvents((previous) => {
                const merged = previous.concat(fresh);
                return merged.length > MAX_LOG_EVENTS ? merged.slice(merged.length - MAX_LOG_EVENTS) : merged;
              });
            }
            const next = finiteNumber(payload.next);
            if (next !== null) eventsNextRef.current = next;
            eventsBackoffRef.current = 0;
            clearFailure('events');
            schedule('events', POLL_EVENTS_MS, pollEvents);
          } catch (error) {
            if (!alive || isAbortError(error)) return;
            flights.events = null;
            recordFailure('events', eventsBackoffRef, error, pollEvents);
          }
        };

        const onVisibilityChange = () => {
          if (!alive) return;
          if (!visible()) {
            clearTimer('state');
            clearTimer('events');
            abortFlight('state');
            abortFlight('events');
            return;
          }
          stateBackoffRef.current = 0;
          eventsBackoffRef.current = 0;
          clearTimer('state');
          clearTimer('events');
          void pollState();
          void pollEvents();
        };

        if (doc !== null && typeof doc.addEventListener === 'function') {
          doc.addEventListener('visibilitychange', onVisibilityChange);
        }
        refreshRef.current = () => {
          if (!alive) return;
          stateBackoffRef.current = 0;
          eventsBackoffRef.current = 0;
          failing.state = false;
          failing.events = false;
          clearTimer('state');
          clearTimer('events');
          void pollState();
          void pollEvents();
        };
        retryRef.current = () => {
          stateBackoffRef.current = 0;
          eventsBackoffRef.current = 0;
          setOffline(null);
          const run = refreshRef.current;
          if (run) run();
        };
        void pollState();
        void pollEvents();

        return () => {
          alive = false;
          clearTimer('state');
          clearTimer('events');
          abortFlight('state');
          abortFlight('events');
          if (doc !== null && typeof doc.removeEventListener === 'function') {
            doc.removeEventListener('visibilitychange', onVisibilityChange);
          }
          refreshRef.current = null;
          retryRef.current = null;
        };
      }, [projectId, t]);

      const refresh = React.useCallback(() => {
        const run = refreshRef.current;
        if (run) run();
      }, []);
      const retry = React.useCallback(() => {
        const run = retryRef.current;
        if (run) run();
      }, []);
      /** Force a full state refetch (bypasses the revision short-circuit). */
      const reload = React.useCallback(() => {
        revisionRef.current = null;
        const run = refreshRef.current;
        if (run) run();
      }, []);
      /** Apply an auto-mode command result (status object, or `{auto}`/`{revision}`). */
      const applyAutoResult = React.useCallback((data) => {
        const payload = asObject(data);
        const nested = payload.auto !== null && typeof payload.auto === 'object' ? payload.auto : null;
        const candidate = nested !== null
          ? nested
          : (typeof payload.status === 'string' ? payload : null);
        const revision = finiteNumber(payload.revision);
        if (revision !== null) revisionRef.current = revision;
        setSnapshot((previous) => ({
          ...previous,
          auto: candidate !== null ? candidate : previous.auto,
          revision: revision !== null ? revision : previous.revision,
        }));
        const run = refreshRef.current;
        if (run) run();
      }, []);
      /** Apply a command result locally, then reconcile with the Host. */
      const applyCommandResult = React.useCallback((data) => {
        const payload = asObject(data);
        const revision = finiteNumber(payload.revision);
        if (revision !== null) revisionRef.current = revision;
        const nextNode = payload.node !== null && typeof payload.node === 'object' ? payload.node : null;
        const nextProject = payload.project !== null && typeof payload.project === 'object' ? payload.project : null;
        setSnapshot((previous) => {
          let nodes = previous.nodes;
          if (nextNode !== null) {
            const id = nodeIdOf(nextNode);
            if (id) {
              let found = false;
              nodes = nodes.map((node) => {
                if (nodeIdOf(node) === id) {
                  found = true;
                  return { ...node, ...nextNode };
                }
                return node;
              });
              if (!found) nodes = nodes.concat([nextNode]);
            }
          }
          return {
            ...previous,
            phase: 'ready',
            nodes,
            project: nextProject !== null ? nextProject : previous.project,
            revision: revision !== null ? revision : previous.revision,
            error: null,
          };
        });
        refresh();
      }, [refresh]);

      return { snapshot, events, offline, refresh, retry, reload, applyAutoResult, applyCommandResult };
    }

    /** Wall-clock ticker (1s) for running-node countdowns; only active while needed. */
    function useNow(active) {
      const [now, setNow] = React.useState(() => Date.now());
      React.useEffect(() => {
        if (!active) return undefined;
        let alive = true;
        let timer = null;
        const tick = () => {
          if (!alive) return;
          setNow(Date.now());
          timer = setTimeout(tick, 1000);
        };
        setNow(Date.now());
        timer = setTimeout(tick, 1000);
        return () => {
          alive = false;
          if (timer !== null) clearTimeout(timer);
        };
      }, [active]);
      return now;
    }

    /**
     * Poll `/runs` every 2s while the runs panel is mounted (the panel component
     * exists only while open). Full-list refresh, visibility pause, 1.5/3/5s
     * backoff, AbortController cleanup.
     */
    function useRuns(projectId, t) {
      const [state, setState] = React.useState({ phase: 'loading', runs: [], cycles: [], error: null, delay: 0 });
      const backoffRef = React.useRef(0);
      const refreshRef = React.useRef(null);
      const retryRef = React.useRef(null);

      React.useEffect(() => {
        let alive = true;
        backoffRef.current = 0;
        setState({ phase: 'loading', runs: [], cycles: [], error: null, delay: 0 });
        const doc = typeof document !== 'undefined' ? document : null;
        let timer = null;
        let flight = null;
        const visible = () => doc === null || doc.visibilityState === 'visible';
        const clearTimer = () => {
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
        };
        const abortFlight = () => {
          if (flight === null) return;
          try {
            flight.abort();
          } catch (error) {
            /* already settled */
          }
          flight = null;
        };
        const schedule = (delay) => {
          clearTimer();
          if (!alive || !visible()) return;
          timer = setTimeout(() => {
            timer = null;
            if (alive && visible()) void poll();
          }, delay);
        };
        const poll = async () => {
          if (!alive || !visible()) return;
          abortFlight();
          const controller = new AbortController();
          flight = controller;
          try {
            const data = await api.fetchRuns(projectId, controller.signal, t);
            if (!alive) return;
            flight = null;
            const normalized = normalizeRuns(data);
            setState({ phase: 'ready', runs: normalized.runs, cycles: normalized.cycles, error: null, delay: 0 });
            backoffRef.current = 0;
            schedule(RUNS_POLL_MS);
          } catch (error) {
            if (!alive || isAbortError(error)) return;
            flight = null;
            const delay = BACKOFF_MS[Math.min(backoffRef.current, BACKOFF_MS.length - 1)];
            backoffRef.current = Math.min(backoffRef.current + 1, BACKOFF_MS.length - 1);
            setState((previous) => ({
              ...previous,
              phase: previous.runs.length > 0 || previous.cycles.length > 0 ? 'ready' : 'error',
              error: describeError(error, t),
              delay,
            }));
            schedule(delay);
          }
        };
        const onVisibilityChange = () => {
          if (!alive) return;
          if (!visible()) {
            clearTimer();
            abortFlight();
            return;
          }
          backoffRef.current = 0;
          clearTimer();
          void poll();
        };
        if (doc !== null && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', onVisibilityChange);
        refreshRef.current = () => {
          if (!alive) return;
          backoffRef.current = 0;
          clearTimer();
          void poll();
        };
        retryRef.current = () => {
          backoffRef.current = 0;
          setState((previous) => ({ ...previous, error: null, delay: 0 }));
          const run = refreshRef.current;
          if (run) run();
        };
        void poll();
        return () => {
          alive = false;
          clearTimer();
          abortFlight();
          if (doc !== null && typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', onVisibilityChange);
          refreshRef.current = null;
          retryRef.current = null;
        };
      }, [projectId, t]);

      const refresh = React.useCallback(() => {
        const run = refreshRef.current;
        if (run) run();
      }, []);
      const retry = React.useCallback(() => {
        const run = retryRef.current;
        if (run) run();
      }, []);
      return { state, refresh, retry };
    }

    /** Fetch one full run record (input snapshot/output/rejected) once per run id. */
    function useRunDetail(projectId, runId, t) {
      const [state, setState] = React.useState({ phase: 'idle', run: null, error: null });
      const [attempt, setAttempt] = React.useState(0);
      React.useEffect(() => {
        if (runId === null || runId === '') {
          setState({ phase: 'idle', run: null, error: null });
          return undefined;
        }
        const controller = new AbortController();
        let alive = true;
        setState({ phase: 'loading', run: null, error: null });
        (async () => {
          try {
            const data = await api.fetchRun(projectId, runId, controller.signal, t);
            if (!alive) return;
            setState({ phase: 'ready', run: asObject(asObject(data).run), error: null });
          } catch (error) {
            if (!alive || isAbortError(error)) return;
            setState({ phase: 'error', run: null, error: describeError(error, t) });
          }
        })();
        return () => {
          alive = false;
          controller.abort();
        };
      }, [projectId, runId, attempt, t]);
      const retry = React.useCallback(() => {
        setAttempt((value) => value + 1);
      }, []);
      return { state, retry };
    }
    // #endregion

    // #region primitives
    /** Component-owned stylesheet; unmounting the panel removes it again. */
    function LabStyle() {
      return h('style', { key: 'metainfer-research-lab-styles' }, STYLE_TEXT);
    }

    /** Small shared button. */
    function LabButton({ label, onClick, variant, disabled, title }) {
      let className = 'rl-btn';
      if (variant === 'primary') className += ' rl-btn-primary';
      else if (variant === 'ghost') className += ' rl-btn-ghost';
      return h(
        'button',
        {
          type: 'button',
          className,
          disabled: disabled === true,
          title: typeof title === 'string' ? title : undefined,
          onClick: typeof onClick === 'function' ? onClick : undefined,
        },
        label,
      );
    }

    /** Single-line controlled input. */
    function LabInput({ value, placeholder, type, disabled, ariaLabel, onChange }) {
      return h('input', {
        className: 'rl-input',
        type: type === 'number' ? 'number' : type === 'password' ? 'password' : 'text',
        value: value,
        placeholder: placeholder,
        disabled: disabled === true,
        'aria-label': ariaLabel,
        spellCheck: false,
        onChange: onChange,
      });
    }

    /** Multi-line controlled input. */
    function LabTextarea({ value, placeholder, disabled, ariaLabel, rows, onChange, onKeyDown }) {
      return h('textarea', {
        className: 'rl-textarea',
        value: value,
        placeholder: placeholder,
        disabled: disabled === true,
        'aria-label': ariaLabel,
        rows: typeof rows === 'number' ? rows : 4,
        spellCheck: false,
        onChange: onChange,
        onKeyDown: typeof onKeyDown === 'function' ? onKeyDown : undefined,
      });
    }

    /** Controlled native select. */
    function LabSelect({ value, options, disabled, ariaLabel, onChange }) {
      return h(
        'select',
        {
          className: 'rl-select',
          value: value,
          disabled: disabled === true,
          'aria-label': ariaLabel,
          onChange: onChange,
        },
        options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
      );
    }

    /** Label + control + optional hint. */
    function LabField({ label, hint, children }) {
      return h(
        'label',
        { className: 'rl-field' },
        label ? h('span', { className: 'rl-label' }, label) : null,
        children,
        hint ? h('span', { className: 'rl-hint' }, hint) : null,
      );
    }

    /** Label/value row used by the repository summary and inspector readbacks. */
    function LabInfoRow({ label, value, mono }) {
      return h(
        'div',
        { className: 'rl-info-row' },
        h('span', { className: 'rl-info-label' }, label),
        h('span', { className: 'rl-info-value' + (mono === true ? ' rl-mono' : '') }, value === '' || value === null || value === undefined ? '—' : value),
      );
    }

    /** Loading line with spinner. */
    function LabLoading({ label }) {
      return h(
        'div',
        { className: 'rl-loading-row', role: 'status' },
        h('span', { className: 'rl-spinner', 'aria-hidden': true }),
        h('span', null, label),
      );
    }

    /** Status dot shared by the rail and the canvas cards. */
    function StatusDot({ status }) {
      return h('span', { className: 'rl-dot rl-dot-' + status, 'aria-hidden': true });
    }

    /** Map a Host repo error code to a localized wizard message when known. */
    function localizedRepoError(error, t) {
      const known = ['invalid_repo', 'not_git', 'bare', 'bad_path', 'no_commits'];
      if (error instanceof LabRequestError && known.indexOf(error.code) >= 0) {
        return t('wizard.repo.error.' + error.code);
      }
      return describeError(error, t);
    }
    // #endregion

    // #region landing + project list
    /** Landing page: existing projects beside the create-project wizard. */
    function LandingScreen({ t, onOpenProject }) {
      const { state, retry, removeProject } = useProjectsData(t);
      const [clusterConfigOpen, setClusterConfigOpen] = React.useState(false);
      const [deleteTarget, setDeleteTarget] = React.useState(null);
      const [deleteBusy, setDeleteBusy] = React.useState(false);
      const [deleteError, setDeleteError] = React.useState('');

      const requestDelete = React.useCallback((project) => {
        setDeleteError('');
        setDeleteTarget(project !== null && typeof project === 'object' ? project : null);
      }, []);
      const cancelDelete = React.useCallback(() => {
        if (deleteBusy) return;
        setDeleteTarget(null);
        setDeleteError('');
      }, [deleteBusy]);
      const confirmDelete = React.useCallback(async (removeWorktrees) => {
        const target = deleteTarget;
        if (target === null) return;
        const id = projectIdOf(target);
        if (!id) return;
        setDeleteBusy(true);
        setDeleteError('');
        try {
          await api.command(
            { type: 'project.delete', projectId: id, removeWorktrees: removeWorktrees === true },
            undefined,
            t,
          );
          removeProject(id);
          setDeleteTarget(null);
        } catch (error) {
          if (isAbortError(error)) return;
          setDeleteError(projectDeleteErrorTextOf(error, t));
        } finally {
          setDeleteBusy(false);
        }
      }, [deleteTarget, removeProject, t]);

      return h(
        'section',
        { className: 'rl-landing', 'data-testid': 'metainfer-research-lab-landing' },
        h(LabStyle),
        h(
          'header',
          { className: 'rl-page-head' },
          h(
            'div',
            { className: 'rl-page-heading' },
            h('h1', { className: 'rl-page-title' }, t('title')),
            h('p', { className: 'rl-page-subtitle' }, t('subtitle')),
          ),
          h(
            'span',
            { className: 'rl-badge' },
            h('span', { className: 'rl-badge-dot', 'aria-hidden': true }),
            t('badge'),
          ),
          h(LabButton, {
            label: '⚙ ' + t('landing.clusterConfig'),
            variant: 'ghost',
            title: t('ws.clusterConfig.title'),
            onClick: () => setClusterConfigOpen(true),
          }),
        ),
        h(
          'div',
          { className: 'rl-landing-grid' },
          h(ProjectsPanel, { state, onRetry: retry, onOpen: onOpenProject, onDelete: requestDelete, t }),
          h(CreateProjectWizard, { t, onCreated: onOpenProject }),
        ),
        clusterConfigOpen
          ? h(ClusterConfigModal, {
              onClose: () => setClusterConfigOpen(false),
              onApplied: () => retry(),
              t,
            })
          : null,
        deleteTarget !== null
          ? h(DeleteProjectDialog, {
              projectName: projectNameOf(deleteTarget) || projectIdOf(deleteTarget) || t('common.unknown'),
              busy: deleteBusy,
              error: deleteError,
              onConfirm: confirmDelete,
              onCancel: cancelDelete,
              t,
            })
          : null,
      );
    }

    /** Existing project list with loading / error / empty states. */
    function ProjectsPanel({ state, onRetry, onOpen, onDelete, t }) {
      const projects = state.projects;
      const health = state.health;
      let body;
      if (state.phase === 'loading' && projects.length === 0) {
        body = h(LabLoading, { label: t('landing.projects.loading') });
      } else if (state.phase === 'error' && projects.length === 0) {
        body = h(
          'div',
          { className: 'rl-field' },
          h('p', { className: 'rl-error-text', role: 'alert' }, state.error || t('landing.projects.error')),
          h(LabButton, { label: t('common.retry'), variant: 'ghost', onClick: onRetry }),
        );
      } else if (projects.length === 0) {
        body = h('p', { className: 'rl-empty-state' }, t('landing.projects.empty'));
      } else {
        body = h(
          'div',
          { className: 'rl-field', role: 'list' },
          projects.map((project, index) =>
            h(ProjectRow, {
              key: projectIdOf(project) || 'project-' + index,
              project,
              onOpen,
              onDelete,
              t,
            })),
        );
      }
      let hostChip = null;
      if (health !== null && typeof health === 'object') {
        hostChip = h(
          'span',
          { className: 'rl-chip' },
          t('landing.host.ready') + (firstString(health.version) ? ' · ' + t('landing.host.version', { version: firstString(health.version) }) : ''),
        );
      } else if (state.phase === 'ready') {
        hostChip = h('span', { className: 'rl-chip' }, t('landing.host.down'));
      }
      return h(
        'section',
        { className: 'rl-card', 'aria-label': t('landing.projects.title') },
        h(
          'div',
          { className: 'rl-card-head' },
          h('h2', { className: 'rl-card-title' }, t('landing.projects.title')),
          h('span', { className: 'rl-card-meta' }, t('landing.projects.count', { count: projects.length })),
        ),
        hostChip !== null ? h('div', { className: 'rl-project-chips' }, hostChip) : null,
        state.phase === 'error' && projects.length > 0
          ? h('p', { className: 'rl-error-text', role: 'alert' }, state.error)
          : null,
        body,
      );
    }

    /** One clickable project summary row with a separate delete action. */
    function ProjectRow({ project, onOpen, onDelete, t }) {
      const record = asObject(project);
      const id = projectIdOf(record);
      const name = projectNameOf(record) || id || t('common.unknown');
      const repoPath = projectRepoPath(record);
      const branch = projectBranch(record);
      const commit = shortCommit(projectBaseCommit(record));
      const mode = record.mode === 'auto' ? 'auto' : 'manual';
      const count = finiteNumber(record.nodeCount);
      return h(
        'div',
        { className: 'rl-project-row-wrap' },
        h(
          'button',
          {
            type: 'button',
            className: 'rl-project-row',
            onClick: () => onOpen(id),
            'aria-label': t('landing.projects.title') + ': ' + name,
          },
          h(
            'span',
            { className: 'rl-project-main' },
          h('span', { className: 'rl-project-title' }, name),
          repoPath ? h('span', { className: 'rl-project-path', title: repoPath }, repoPath) : null,
          h(
            'span',
            { className: 'rl-project-chips' },
            branch || commit
              ? h('span', { className: 'rl-chip rl-chip-mono' }, [branch, commit].filter((part) => part !== '').join('@'))
              : null,
            h('span', { className: 'rl-chip' }, mode === 'auto' ? t('landing.projects.mode.auto') : t('landing.projects.mode.manual')),
            count !== null ? h('span', { className: 'rl-chip' }, t('landing.projects.nodes', { count })) : null,
          ),
        ),
          h(
            'span',
            { className: 'rl-project-side' },
            h('span', null, formatDateTime(record.updatedAt, t)),
            h('span', { className: 'rl-project-open' }, t('landing.projects.open') + ' →'),
          ),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'rl-project-delete',
            title: t('landing.delete'),
            'aria-label': t('landing.delete') + ': ' + name,
            onClick: (event) => {
              event.stopPropagation();
              if (typeof onDelete === 'function') onDelete(project);
            },
          },
          '🗑',
        ),
      );
    }
    // #endregion

    // #region create-project wizard
    /**
     * Two-section wizard: validate the Git repository (GET /repo) and collect the
     * research setup, then POST one project and open its workspace.
     */
    function CreateProjectWizard({ t, onCreated }) {
      const [repoPath, setRepoPath] = React.useState('');
      const [repoPhase, setRepoPhase] = React.useState('idle');
      const [repoInfo, setRepoInfo] = React.useState(null);
      const [repoError, setRepoError] = React.useState('');
      const [baseBranch, setBaseBranch] = React.useState('');
      const [name, setName] = React.useState('');
      const [nameTouched, setNameTouched] = React.useState(false);
      const [brief, setBrief] = React.useState('');
      const [initialPrompt, setInitialPrompt] = React.useState('');
      const [pools, setPools] = React.useState([{ id: 'pool-1', key: 'gpu', value: '1' }]);
      const [maxRunningNodes, setMaxRunningNodes] = React.useState(String(DEFAULT_CONFIG.maxRunningNodes));
      const [maxNodes, setMaxNodes] = React.useState(String(DEFAULT_CONFIG.maxNodes));
      const [nodeTimeoutMinutes, setNodeTimeoutMinutes] = React.useState(String(DEFAULT_CONFIG.nodeTimeoutMinutes));
      const [maxNodeTimeoutMinutes, setMaxNodeTimeoutMinutes] = React.useState(String(DEFAULT_CONFIG.maxNodeTimeoutMinutes));
      const [createPhase, setCreatePhase] = React.useState('idle');
      const [createError, setCreateError] = React.useState('');
      const poolSeqRef = React.useRef(1);
      const repoAbortRef = React.useRef(null);
      const createAbortRef = React.useRef(null);

      React.useEffect(() => () => {
        if (repoAbortRef.current !== null) repoAbortRef.current.abort();
        if (createAbortRef.current !== null) createAbortRef.current.abort();
      }, []);

      const validateRepo = async () => {
        const path = repoPath.trim();
        if (!path) {
          setRepoPhase('error');
          setRepoError(t('wizard.repoPath.required'));
          return;
        }
        if (repoAbortRef.current !== null) repoAbortRef.current.abort();
        const controller = new AbortController();
        repoAbortRef.current = controller;
        setRepoPhase('validating');
        setRepoError('');
        setRepoInfo(null);
        try {
          const payload = await api.inspectRepo(path, controller.signal, t);
          const info = normalizeRepoInfo(payload);
          if (!info.repoRoot && info.branches.length === 0) {
            throw new LabRequestError('invalid_repo', t('wizard.repo.error.invalid_repo'));
          }
          setRepoInfo(info);
          setRepoPhase('valid');
          setBaseBranch((previous) => (previous && info.branches.indexOf(previous) >= 0 ? previous : info.defaultBranch));
          setName((previous) => {
            if (nameTouched && previous.trim()) return previous;
            const suggested = basenameOfPath(info.repoRoot || path);
            return suggested || previous;
          });
        } catch (error) {
          if (isAbortError(error)) return;
          setRepoPhase('error');
          setRepoError(localizedRepoError(error, t));
        }
      };

      const updatePool = (id, field, value) => {
        setPools((previous) => previous.map((pool) => (pool.id === id ? { ...pool, [field]: value } : pool)));
      };
      const addPool = () => {
        poolSeqRef.current += 1;
        setPools((previous) => previous.concat([{ id: 'pool-' + poolSeqRef.current, key: '', value: '1' }]));
      };
      const removePool = (id) => {
        setPools((previous) => previous.filter((pool) => pool.id !== id));
      };
      /** Validate pool rows into a `{key: amount}` map. */
      const collectPools = () => {
        const resourcePools = {};
        for (const pool of pools) {
          const key = String(pool.key === undefined || pool.key === null ? '' : pool.key).trim();
          const amount = parseInteger(pool.value, 0);
          if (!key || amount <= 0) return { error: t('wizard.pools.required') };
          if (Object.prototype.hasOwnProperty.call(resourcePools, key)) return { error: t('wizard.pools.duplicate') };
          resourcePools[key] = amount;
        }
        if (Object.keys(resourcePools).length === 0) return { error: t('wizard.pools.required') };
        return { value: resourcePools };
      };

      const create = async () => {
        if (createPhase === 'creating') return;
        if (repoInfo === null || repoPhase !== 'valid') {
          setCreateError(t('wizard.required.repo'));
          return;
        }
        if (!name.trim()) {
          setCreateError(t('wizard.required.name'));
          return;
        }
        if (!brief.trim()) {
          setCreateError(t('wizard.required.brief'));
          return;
        }
        if (!initialPrompt.trim()) {
          setCreateError(t('wizard.required.prompt'));
          return;
        }
        const collected = collectPools();
        if (collected.error) {
          setCreateError(collected.error);
          return;
        }
        setCreatePhase('creating');
        setCreateError('');
        const controller = new AbortController();
        createAbortRef.current = controller;
        try {
          const payload = await api.createProject(
            {
              name: name.trim(),
              brief: brief.trim(),
              repoPath: repoInfo.repoRoot || repoPath.trim(),
              baseBranch: baseBranch || repoInfo.defaultBranch,
              initialPrompt: initialPrompt.trim(),
              config: {
                resourcePools: collected.value,
                maxRunningNodes: parseInteger(maxRunningNodes, DEFAULT_CONFIG.maxRunningNodes),
                maxNodes: parseInteger(maxNodes, DEFAULT_CONFIG.maxNodes),
                nodeTimeoutMinutes: parseInteger(nodeTimeoutMinutes, DEFAULT_CONFIG.nodeTimeoutMinutes),
                maxNodeTimeoutMinutes: parseInteger(maxNodeTimeoutMinutes, DEFAULT_CONFIG.maxNodeTimeoutMinutes),
              },
            },
            controller.signal,
            t,
          );
          const record = asObject(payload);
          const project = record.project !== null && typeof record.project === 'object' ? record.project : null;
          const createdId = project !== null ? projectIdOf(project) : firstString(record.projectId, record.id);
          if (!createdId) {
            setCreateError(t('wizard.error.noProject'));
            setCreatePhase('idle');
            return;
          }
          onCreated(createdId);
        } catch (error) {
          if (isAbortError(error)) return;
          setCreateError(describeError(error, t));
          setCreatePhase('idle');
        }
      };

      const validating = repoPhase === 'validating';
      const creating = createPhase === 'creating';
      let branchOptions = [];
      if (repoInfo !== null) {
        const branches = repoInfo.branches.length > 0
          ? repoInfo.branches
          : (repoInfo.defaultBranch ? [repoInfo.defaultBranch] : []);
        const choices = baseBranch && branches.indexOf(baseBranch) < 0 ? [baseBranch].concat(branches) : branches;
        branchOptions = choices.map((branch) => ({ value: branch, label: branch }));
      }

      return h(
        'section',
        { className: 'rl-card', 'aria-label': t('wizard.title') },
        h(
          'div',
          { className: 'rl-card-head' },
          h('h2', { className: 'rl-card-title' }, t('wizard.title')),
          h('span', { className: 'rl-card-meta' }, t('wizard.section.repo')),
        ),
        h('p', { className: 'rl-hint' }, t('wizard.intro')),

        h(
          'div',
          { className: 'rl-section' },
          h(
            'div',
            { className: 'rl-field' },
            h('span', { className: 'rl-label' }, t('wizard.repoPath')),
            h(
              'div',
              { className: 'rl-form-row' },
              h(LabInput, {
                value: repoPath,
                placeholder: t('wizard.repoPath.placeholder'),
                ariaLabel: t('wizard.repoPath'),
                onChange: (event) => {
                  setRepoPath(event.target.value);
                  if (repoPhase !== 'idle') setRepoPhase('idle');
                  if (repoInfo !== null) setRepoInfo(null);
                  if (repoError) setRepoError('');
                },
              }),
              h(LabButton, {
                label: validating ? t('wizard.validating') : t('wizard.validate'),
                variant: 'ghost',
                disabled: validating,
                onClick: validateRepo,
              }),
            ),
          ),
          repoPhase === 'error'
            ? h(
                'p',
                { className: 'rl-error-text', role: 'alert' },
                t('wizard.repo.error') + ': ' + repoError,
              )
            : null,
          repoInfo !== null
            ? h(
                'div',
                { className: 'rl-repo-info' },
                h(
                  'div',
                  { className: 'rl-repo-info-head' },
                  h('span', { className: 'rl-chip' }, t('wizard.repo.valid')),
                  h('span', { className: 'rl-chip' }, t('wizard.repo.branches', { count: repoInfo.branches.length })),
                  h('span', { className: 'rl-chip' }, repoInfo.dirty ? t('wizard.repo.dirty') : t('wizard.repo.clean')),
                ),
                h(LabInfoRow, { label: t('wizard.repo.root'), value: repoInfo.repoRoot }),
                repoInfo.gitDir ? h(LabInfoRow, { label: t('wizard.repo.gitDir'), value: repoInfo.gitDir, mono: true }) : null,
                h(LabInfoRow, { label: t('wizard.repo.commit'), value: repoInfo.baseCommit, mono: true }),
                branchOptions.length > 0
                  ? h(
                      'div',
                      { className: 'rl-field' },
                      h('span', { className: 'rl-label' }, t('wizard.repo.baseBranch')),
                      h(LabSelect, {
                        value: baseBranch,
                        options: branchOptions,
                        ariaLabel: t('wizard.repo.baseBranch'),
                        onChange: (event) => setBaseBranch(event.target.value),
                      }),
                    )
                  : null,
              )
            : null,
        ),

        h(
          'div',
          { className: 'rl-section' },
          h('h3', { className: 'rl-section-title' }, t('wizard.section.research')),
          h(
            'div',
            { className: 'rl-form-grid' },
            h(
              'div',
              { className: 'rl-field' },
              h('span', { className: 'rl-label' }, t('wizard.name')),
              h(LabInput, {
                value: name,
                placeholder: t('wizard.name.placeholder'),
                ariaLabel: t('wizard.name'),
                onChange: (event) => {
                  setName(event.target.value);
                  setNameTouched(true);
                },
              }),
            ),
          ),
          h(
            'div',
            { className: 'rl-field' },
            h('span', { className: 'rl-label' }, t('wizard.brief')),
            h(LabTextarea, {
              value: brief,
              placeholder: t('wizard.brief.placeholder'),
              ariaLabel: t('wizard.brief'),
              rows: 3,
              onChange: (event) => setBrief(event.target.value),
            }),
          ),
          h(
            'div',
            { className: 'rl-field' },
            h('span', { className: 'rl-label' }, t('wizard.initialPrompt')),
            h(LabTextarea, {
              value: initialPrompt,
              placeholder: t('wizard.initialPrompt.placeholder'),
              ariaLabel: t('wizard.initialPrompt'),
              rows: 4,
              onChange: (event) => setInitialPrompt(event.target.value),
            }),
          ),

          h(
            'div',
            { className: 'rl-field' },
            h('span', { className: 'rl-label' }, t('wizard.pools')),
            h('span', { className: 'rl-hint' }, t('wizard.pools.hint')),
            h(
              'div',
              { className: 'rl-field' },
              pools.map((pool) =>
                h(
                  'div',
                  { key: pool.id, className: 'rl-form-row' },
                  h(LabInput, {
                    value: pool.key,
                    placeholder: t('wizard.pool.key'),
                    ariaLabel: t('wizard.pool.key'),
                    onChange: (event) => updatePool(pool.id, 'key', event.target.value),
                  }),
                  h(LabInput, {
                    type: 'number',
                    value: pool.value,
                    ariaLabel: t('wizard.pool.value'),
                    onChange: (event) => updatePool(pool.id, 'value', event.target.value),
                  }),
                  h(LabButton, {
                    label: '✕',
                    variant: 'ghost',
                    title: t('wizard.pool.remove'),
                    onClick: () => removePool(pool.id),
                  }),
                )),
            ),
            h(LabButton, { label: t('wizard.pool.add'), variant: 'ghost', onClick: addPool }),
          ),

          h(
            'div',
            { className: 'rl-form-grid' },
            h(LabField, { label: t('wizard.maxRunningNodes') },
              h(LabInput, {
                type: 'number',
                value: maxRunningNodes,
                ariaLabel: t('wizard.maxRunningNodes'),
                onChange: (event) => setMaxRunningNodes(event.target.value),
              })),
            h(LabField, { label: t('wizard.maxNodes') },
              h(LabInput, {
                type: 'number',
                value: maxNodes,
                ariaLabel: t('wizard.maxNodes'),
                onChange: (event) => setMaxNodes(event.target.value),
              })),
          ),
          h('h3', { className: 'rl-section-title' }, t('wizard.timeouts')),
          h(
            'div',
            { className: 'rl-form-grid' },
            h(LabField, { label: t('wizard.nodeTimeoutMinutes') },
              h(LabInput, {
                type: 'number',
                value: nodeTimeoutMinutes,
                ariaLabel: t('wizard.nodeTimeoutMinutes'),
                onChange: (event) => setNodeTimeoutMinutes(event.target.value),
              })),
            h(LabField, { label: t('wizard.maxNodeTimeoutMinutes') },
              h(LabInput, {
                type: 'number',
                value: maxNodeTimeoutMinutes,
                ariaLabel: t('wizard.maxNodeTimeoutMinutes'),
                onChange: (event) => setMaxNodeTimeoutMinutes(event.target.value),
              })),
          ),
          h(
            'p',
            { className: 'rl-hint' },
            t('wizard.timeouts.hint', { max: parseInteger(maxNodeTimeoutMinutes, DEFAULT_CONFIG.maxNodeTimeoutMinutes) }),
          ),
        ),

        createError
          ? h('p', { className: 'rl-error-text', role: 'alert' }, t('wizard.error') + ': ' + createError)
          : null,
        h(
          'div',
          { className: 'rl-form-actions' },
          h(LabButton, {
            label: creating ? t('wizard.creating') : t('wizard.create'),
            variant: 'primary',
            disabled: creating,
            onClick: create,
          }),
        ),
      );
    }
    // #endregion

    /** DSH-native session/trajectory controls for one node (read-only history). */
    function NativeSessionPanel({ node, onOpenSession, t }) {
      const sessionId = nodeSessionIdOf(node);
      const attempts = nodeAttemptsOf(node).filter((attempt) => attemptSessionIdOf(attempt) !== '');
      return h(
        'div',
        { className: 'rl-section' },
        h('h3', { className: 'rl-section-title' }, t('ws.native.title')),
        h('p', { className: 'rl-hint' }, t('ws.native.hint')),
        sessionId !== ''
          ? h(LabInfoRow, { label: t('ws.native.sessionId'), value: sessionId, mono: true })
          : h('p', { className: 'rl-hint' }, t('ws.native.noSession')),
        h(
          'div',
          { className: 'rl-form-actions' },
          sessionId !== ''
            ? h(LabButton, { label: t('ws.native.trajectory'), onClick: () => onOpenSession(sessionId, 'trajectory') })
            : null,
          sessionId !== ''
            ? h(LabButton, { label: t('ws.native.chat'), onClick: () => onOpenSession(sessionId, 'chat') })
            : null,
        ),
        attempts.length > 0
          ? h(
              'div',
              { className: 'rl-report-section' },
              h('h4', { className: 'rl-report-section-title' }, t('ws.native.attempts')),
              attempts.map((attempt, index) => h(
                'div',
                { key: String(numberOr(attempt.index, index + 1)), className: 'rl-native-attempt' },
                h(
                  'span',
                  { className: 'rl-hint' },
                  t('ws.native.attemptOpen', { index: numberOr(attempt.index, index + 1) })
                    + (modelLabelOf(attempt.model) !== '' ? ' · ' + modelLabelOf(attempt.model) : ''),
                ),
                h(LabButton, {
                  label: t('ws.native.openTrajectoryShort'),
                  onClick: () => onOpenSession(attemptSessionIdOf(attempt), 'trajectory'),
                }),
                h(LabButton, {
                  label: t('ws.native.openChatShort'),
                  onClick: () => onOpenSession(attemptSessionIdOf(attempt), 'chat'),
                }),
              )),
            )
          : h('p', { className: 'rl-hint' }, t('ws.native.noAttempts')),
        h('p', { className: 'rl-hint' }, t('ws.native.devHint')),
      );
    }

    /** Follow-up composer: sends node.message; history stays in the native DSH view. */
    function ContinueDialog({ node, nodes, resources, onClose, onSend, t }) {
      const [draft, setDraft] = React.useState('');
      const [sending, setSending] = React.useState(false);
      const [error, setError] = React.useState('');
      const [success, setSuccess] = React.useState(false);
      const canContinue = nodeCanContinueOf(node, nodes);
      const isMerge = nodeIsMergeOf(node);
      const needs = nodeNeedsEntries(node);
      const free = freeResourcesOf(resources);
      const needsText = needsSummaryOf(nodeNeedsOf(node));
      const freeText = needs.map((entry) => entry.key + '×' + numberOr(free[entry.key], 0)).join(', ');
      const insufficient = needs.some((entry) => numberOr(free[entry.key], 0) < entry.amount);
      const send = async () => {
        if (!canContinue || sending) return;
        const text = draft.trim();
        if (text === '') return;
        setSending(true);
        setError('');
        setSuccess(false);
        const result = await onSend(text);
        setSending(false);
        if (result !== null && result !== undefined && result.ok === true) {
          setDraft('');
          setSuccess(true);
        } else {
          setError(result && result.error ? result.error : t('ws.native.continueError'));
        }
      };
      return h(
        'div',
        { className: 'rl-overlay-layer rl-overlay-layer-top' },
        h(
          'div',
          { className: 'rl-modal rl-modal-narrow', role: 'dialog', 'aria-label': t('ws.native.continueTitle') },
          h(
            'div',
            { className: 'rl-modal-head' },
            h('h2', { className: 'rl-modal-title' }, t('ws.native.continueTitle') + ' · ' + nodeTitleOf(node, t)),
            h(LabButton, { label: '✕', variant: 'ghost', title: t('ws.native.continueClose'), onClick: onClose }),
          ),
          h(
            'div',
            { className: 'rl-modal-body' },
            h('p', { className: 'rl-modal-note' }, t('ws.native.continueHint')),
            isMerge ? h('p', { className: 'rl-hint' }, t('ws.native.runningMerge')) : null,
            h('p', { className: 'rl-hint' }, t('ws.native.devHint')),
            needs.length > 0
              ? h(
                  'p',
                  { className: 'rl-hint' + (insufficient ? ' rl-drawer-foot-warn' : '') },
                  insufficient
                    ? t('ws.native.continueInsufficient', { needs: needsText, free: freeText })
                    : t('ws.native.continueNeeds', { needs: needsText, free: freeText }),
                )
              : null,
            canContinue
              ? h(LabTextarea, {
                  value: draft,
                  rows: 3,
                  disabled: sending,
                  ariaLabel: t('ws.native.continuePlaceholder'),
                  placeholder: t('ws.native.continuePlaceholder'),
                  onChange: (event) => {
                    setDraft(event.target.value);
                    setError('');
                    setSuccess(false);
                  },
                  onKeyDown: (event) => {
                    if (event.key === 'Enter' && (event.metaKey === true || event.ctrlKey === true)) {
                      event.preventDefault();
                      void send();
                    }
                  },
                })
              : h('p', { className: 'rl-hint' }, t('ws.native.continueDisabled')),
            error !== '' ? h('p', { className: 'rl-error-text', role: 'alert' }, t('ws.native.continueError') + ': ' + error) : null,
            success ? h('p', { className: 'rl-config-success', role: 'status' }, t('ws.native.continueSuccess')) : null,
          ),
          h(
            'div',
            { className: 'rl-modal-foot' },
            h(LabButton, { label: t('ws.native.continueClose'), variant: 'ghost', onClick: onClose }),
            h(LabButton, {
              label: sending ? t('ws.native.continueSending') : t('ws.native.continueSend'),
              variant: 'primary',
              disabled: !canContinue || sending || draft.trim().length === 0,
              onClick: send,
            }),
          ),
        ),
      );
    }

    // #region workspace
    /** Full workspace: top bar, node rail, DAG canvas, inspector, log and transcript drawer. */
    function WorkspaceScreen({ projectId, onBack, openNativeSession, t }) {
      const { snapshot, events, offline, retry, reload, applyAutoResult, applyCommandResult } = useProjectWorkspace(projectId, t);
      const [selectedId, setSelectedId] = React.useState(null);
      const [continueNodeId, setContinueNodeId] = React.useState(null);
      const [busyKey, setBusyKey] = React.useState('');
      const [actionError, setActionError] = React.useState('');
      const [stepBusy, setStepBusy] = React.useState(false);
      const [stepInfo, setStepInfo] = React.useState(null);
      const [successorOpen, setSuccessorOpen] = React.useState(false);
      const [successorNodeId, setSuccessorNodeId] = React.useState(null);
      const [runsOpen, setRunsOpen] = React.useState(false);
      const [runsInitialRunId, setRunsInitialRunId] = React.useState(null);
      const [autoBusy, setAutoBusy] = React.useState(false);
      const [autoConfirmOpen, setAutoConfirmOpen] = React.useState(false);
      const [settingsOpen, setSettingsOpen] = React.useState(false);
      const [confirmRequest, setConfirmRequest] = React.useState(null);
      const [projectMenuOpen, setProjectMenuOpen] = React.useState(false);
      const [deleteOpen, setDeleteOpen] = React.useState(false);
      const [deleteBusy, setDeleteBusy] = React.useState(false);
      const [deleteError, setDeleteError] = React.useState('');
      const [mergeCreateOpen, setMergeCreateOpen] = React.useState(false);
      const [mergeCreateSeed, setMergeCreateSeed] = React.useState(null);
      const [finishMergeNodeId, setFinishMergeNodeId] = React.useState(null);
      const [pushOpen, setPushOpen] = React.useState(false);
      const [clusterOpen, setClusterOpen] = React.useState(false);
      const [clusterConfigOpen, setClusterConfigOpen] = React.useState(false);
      const busyRef = React.useRef('');
      const stepBusyRef = React.useRef(false);
      const autoBusyRef = React.useRef(false);
      const nodes = snapshot.nodes;
      const edges = snapshot.edges;
      const project = snapshot.project;
      const layout = React.useMemo(() => computeLayout(nodes, edges), [nodes, edges]);
      const runningCount = React.useMemo(
        () => nodes.filter((node) => nodeStatusOf(node) === 'running').length,
        [nodes],
      );
      const pendingProposalsCount = React.useMemo(
        () => nodes.filter((node) => nodeStatusOf(node) === 'proposed').length,
        [nodes],
      );
      const autoState = snapshot.auto;
      const autoStatus = autoStatusOf(autoState);
      const now = useNow(runningCount > 0 || autoStatus === 'running');
      const modelCatalog = useModelCatalog(projectId, t);
      const modelOptions = modelCatalog.state.catalog === null ? [] : asArray(modelCatalog.state.catalog.options);

      React.useEffect(() => {
        if (selectedId === null) return;
        for (const node of nodes) if (nodeIdOf(node) === selectedId) return;
        setSelectedId(null);
      }, [nodes, selectedId]);

      React.useEffect(() => {
        if (continueNodeId === null) return;
        for (const node of nodes) if (nodeIdOf(node) === continueNodeId) return;
        setContinueNodeId(null);
      }, [nodes, continueNodeId]);

      React.useEffect(() => {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined;
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          if (confirmRequest !== null) {
            setConfirmRequest(null);
            return;
          }
          if (mergeCreateOpen) {
            setMergeCreateOpen(false);
            setMergeCreateSeed(null);
            return;
          }
          if (finishMergeNodeId !== null) {
            setFinishMergeNodeId(null);
            return;
          }
          if (pushOpen) {
            setPushOpen(false);
            return;
          }
          if (clusterOpen) {
            setClusterOpen(false);
            return;
          }
          if (clusterConfigOpen) {
            setClusterConfigOpen(false);
            return;
          }
          if (deleteOpen) {
            setDeleteOpen(false);
            setDeleteError('');
            return;
          }
          if (projectMenuOpen) {
            setProjectMenuOpen(false);
            return;
          }
          if (autoConfirmOpen) {
            setAutoConfirmOpen(false);
            return;
          }
          if (settingsOpen) {
            setSettingsOpen(false);
            return;
          }
          if (successorOpen) {
            setSuccessorOpen(false);
            setSuccessorNodeId(null);
            return;
          }
          if (runsOpen) {
            setRunsOpen(false);
            setRunsInitialRunId(null);
            return;
          }
          if (continueNodeId !== null) setContinueNodeId(null);
          else setSelectedId(null);
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
      }, [continueNodeId, successorOpen, runsOpen, confirmRequest, autoConfirmOpen, settingsOpen, deleteOpen, projectMenuOpen, mergeCreateOpen, finishMergeNodeId, pushOpen, clusterOpen, clusterConfigOpen]);

      React.useEffect(() => {
        if (confirmRequest === null) return;
        for (const node of nodes) if (nodeIdOf(node) === confirmRequest.nodeId) return;
        setConfirmRequest(null);
      }, [nodes, confirmRequest]);

      React.useEffect(() => {
        if (!successorOpen) return;
        for (const node of nodes) if (nodeIdOf(node) === successorNodeId) return;
        setSuccessorOpen(false);
        setSuccessorNodeId(null);
      }, [nodes, successorOpen, successorNodeId]);

      const selectedNode = React.useMemo(() => {
        if (selectedId === null) return null;
        for (const node of nodes) if (nodeIdOf(node) === selectedId) return node;
        return null;
      }, [nodes, selectedId]);

      const continueNode = React.useMemo(() => {
        if (continueNodeId === null) return null;
        for (const node of nodes) if (nodeIdOf(node) === continueNodeId) return node;
        return null;
      }, [nodes, continueNodeId]);

      const successorParent = React.useMemo(() => {
        if (successorNodeId === null) return null;
        for (const node of nodes) if (nodeIdOf(node) === successorNodeId) return node;
        return null;
      }, [nodes, successorNodeId]);

      const saveNode = React.useCallback(async (patch) => {
        if (selectedNode === null) return { ok: false, error: t('ws.inspector.error') };
        try {
          const data = await api.command(
            { type: 'node.edit', projectId, nodeId: nodeIdOf(selectedNode), ...patch },
            undefined,
            t,
          );
          applyCommandResult(data);
          return { ok: true };
        } catch (error) {
          if (isAbortError(error)) return { ok: false, error: t('error.unknown') };
          return { ok: false, error: describeError(error, t) };
        }
      }, [applyCommandResult, projectId, selectedNode, t]);

      /** Run one node command once at a time; errors surface in a dismissible banner. */
      const runNodeCommand = React.useCallback(async (type, nodeId, extra) => {
        if (busyRef.current !== '') return { ok: false, error: t('ws.action.failed') };
        const key = type + ':' + nodeId;
        busyRef.current = key;
        setBusyKey(key);
        setActionError('');
        try {
          const data = await api.command(
            { type, projectId, nodeId, ...(extra === undefined ? {} : extra) },
            undefined,
            t,
          );
          applyCommandResult(data);
          return { ok: true };
        } catch (error) {
          if (isAbortError(error)) return { ok: false, error: t('error.unknown') };
          const message = describeError(error, t);
          setActionError(message);
          return { ok: false, error: message };
        } finally {
          busyRef.current = '';
          setBusyKey('');
        }
      }, [applyCommandResult, projectId, t]);

      const handleNodeAction = React.useCallback((type, nodeId) => {
        void runNodeCommand(type, nodeId);
      }, [runNodeCommand]);
      /** Open a session in DSH's native conversation (trajectory/chat preset). */
      const openSessionNative = React.useCallback((sessionId, view) => {
        if (typeof openNativeSession !== 'function') {
          setActionError(t('ws.native.openFailed'));
          return;
        }
        const result = openNativeSession(sessionId, view === 'chat' ? 'chat' : 'trajectory');
        if (result === null || result === undefined || result.ok !== true) {
          setActionError(t('ws.native.openFailed'));
        }
      }, [openNativeSession, t]);
      const openNodeNative = React.useCallback((nodeId, view) => {
        setSelectedId(nodeId);
        let target = null;
        for (const node of nodes) if (nodeIdOf(node) === nodeId) target = node;
        const sessionId = target === null ? '' : nodeSessionIdOf(target);
        if (sessionId === '') {
          setActionError(t('ws.native.noSession'));
          return;
        }
        openSessionNative(sessionId, view);
      }, [nodes, openSessionNative, t]);
      const requestContinue = React.useCallback((nodeId) => {
        setSelectedId(nodeId);
        setContinueNodeId(nodeId);
      }, []);
      const closeContinue = React.useCallback(() => setContinueNodeId(null), []);
      const sendContinue = React.useCallback(async (text) => {
        if (continueNodeId === null) return { ok: false, error: t('error.unknown') };
        return runNodeCommand('node.message', continueNodeId, { text });
      }, [continueNodeId, runNodeCommand, t]);

      /** Manual Step: one advisor + scheduler cycle, then a summary or inline error. */
      const runStep = React.useCallback(async () => {
        if (stepBusyRef.current) return;
        stepBusyRef.current = true;
        setStepBusy(true);
        setStepInfo(null);
        try {
          const data = await api.command({ type: 'project.step', projectId }, undefined, t);
          const result = asObject(data);
          const created = idListOf(result.created).length;
          const started = idListOf(result.started).length;
          const skipped = asArray(result.skipped).length;
          const errors = stringListOf(result.errors).length;
          const meta = [
            skipped > 0 ? t('ws.step.skipped', { count: skipped }) : '',
            errors > 0 ? t('ws.step.errors', { count: errors }) : '',
          ].filter((part) => part !== '').join(' · ');
          setStepInfo({ kind: 'summary', text: t('ws.step.summary', { created, started }), meta });
          reload();
        } catch (error) {
          if (isAbortError(error)) return;
          const message = error instanceof LabRequestError && error.code === 'cycle_busy'
            ? t('ws.step.cycleBusy')
            : describeError(error, t);
          setStepInfo({ kind: 'error', text: t('ws.step.error') + ': ' + message });
        } finally {
          stepBusyRef.current = false;
          setStepBusy(false);
        }
      }, [projectId, reload, t]);

      const openSuccessor = React.useCallback((nodeId) => {
        setSuccessorNodeId(nodeId);
        setSuccessorOpen(true);
      }, []);
      const closeSuccessor = React.useCallback(() => {
        setSuccessorOpen(false);
        setSuccessorNodeId(null);
      }, []);
      const submitSuccessor = React.useCallback(async (payload) => {
        try {
          const data = await api.command(
            {
              type: 'node.successor',
              projectId,
              nodeId: payload.nodeId,
              title: payload.title,
              prompt: payload.prompt,
              needs: payload.needs,
              successCriteria: payload.successCriteria,
              timeboxMinutes: payload.timeboxMinutes,
            },
            undefined,
            t,
          );
          applyCommandResult(data);
          const createdNode = asObject(asObject(data).node);
          if (nodeIdOf(createdNode)) setSelectedId(nodeIdOf(createdNode));
          reload();
          return { ok: true };
        } catch (error) {
          if (isAbortError(error)) return { ok: false, error: t('error.unknown') };
          return { ok: false, error: describeError(error, t) };
        }
      }, [applyCommandResult, projectId, reload, t]);

      const openRuns = React.useCallback((runId) => {
        setRunsInitialRunId(typeof runId === 'string' && runId.length > 0 ? runId : null);
        setRunsOpen(true);
      }, []);
      const closeRuns = React.useCallback(() => {
        setRunsOpen(false);
        setRunsInitialRunId(null);
      }, []);

      /** One auto-mode command at a time; response carries the new auto status. */
      const runAutoCommand = React.useCallback(async (type) => {
        if (autoBusyRef.current) return { ok: false, error: t('ws.auto.busy') };
        autoBusyRef.current = true;
        setAutoBusy(true);
        setActionError('');
        try {
          const data = await api.command({ type, projectId }, undefined, t);
          applyAutoResult(data);
          reload();
          return { ok: true };
        } catch (error) {
          if (isAbortError(error)) return { ok: false, error: t('error.unknown') };
          const message = describeError(error, t);
          setActionError(t('ws.auto.error') + ': ' + message);
          return { ok: false, error: message };
        } finally {
          autoBusyRef.current = false;
          setAutoBusy(false);
        }
      }, [applyAutoResult, projectId, reload, t]);

      const confirmAutoStart = React.useCallback(() => {
        setAutoConfirmOpen(false);
        void runAutoCommand('auto.start');
      }, [runAutoCommand]);
      const cancelAutoStart = React.useCallback(() => setAutoConfirmOpen(false), []);
      const switchToManual = React.useCallback(() => {
        if (autoStatusOf(snapshot.auto) === 'off') return;
        void runAutoCommand('auto.stop');
      }, [runAutoCommand, snapshot.auto]);
      const stopAuto = React.useCallback(() => {
        void runAutoCommand('auto.stop');
      }, [runAutoCommand]);
      const resumeAuto = React.useCallback(() => {
        void runAutoCommand('auto.resume');
      }, [runAutoCommand]);
      const viewPendingProposals = React.useCallback(() => {
        for (const node of nodes) {
          if (nodeStatusOf(node) !== 'proposed') continue;
          setSelectedId(nodeIdOf(node));
          return;
        }
      }, [nodes]);

      /** Propose approve/reject behind a confirmation dialog. */
      const requestProposalAction = React.useCallback((kind, nodeId) => {
        setSelectedId(nodeId);
        setConfirmRequest({ kind: kind === 'reject' ? 'reject' : 'approve', nodeId });
      }, []);
      const runProposalAction = React.useCallback(async (type, nodeId) => {
        if (busyRef.current !== '') return { ok: false, error: t('ws.action.failed') };
        const key = type + ':' + nodeId;
        busyRef.current = key;
        setBusyKey(key);
        setActionError('');
        try {
          const data = await api.command({ type, projectId, nodeId }, undefined, t);
          applyCommandResult(data);
          reload();
          return { ok: true };
        } catch (error) {
          if (isAbortError(error)) return { ok: false, error: t('error.unknown') };
          const message = describeError(error, t);
          setActionError(message);
          return { ok: false, error: message };
        } finally {
          busyRef.current = '';
          setBusyKey('');
        }
      }, [applyCommandResult, projectId, reload, t]);
      const confirmProposal = React.useCallback(() => {
        const request = confirmRequest;
        if (request === null) return;
        setConfirmRequest(null);
        if (request.kind === 'retry') {
          void runNodeCommand('node.retry', request.nodeId).then((result) => {
            if (result !== null && result !== undefined && result.ok === true) reload();
          });
          return;
        }
        void runProposalAction(request.kind === 'reject' ? 'node.reject' : 'node.approve', request.nodeId);
      }, [confirmRequest, reload, runNodeCommand, runProposalAction]);
      const cancelConfirm = React.useCallback(() => setConfirmRequest(null), []);

      /** Failed-node retry (server decides planned-restart vs follow-up re-run). */
      const requestRetry = React.useCallback((nodeId) => {
        setSelectedId(nodeId);
        setConfirmRequest({ kind: 'retry', nodeId });
      }, []);

      /** Project deletion from the top-bar menu: same dialog, then back to the list. */
      const requestDeleteProject = React.useCallback(() => {
        setProjectMenuOpen(false);
        setDeleteError('');
        setDeleteOpen(true);
      }, []);
      const cancelDeleteProject = React.useCallback(() => {
        if (deleteBusy) return;
        setDeleteOpen(false);
        setDeleteError('');
      }, [deleteBusy]);
      const confirmDeleteProject = React.useCallback(async (removeWorktrees) => {
        if (deleteBusy) return;
        setDeleteBusy(true);
        setDeleteError('');
        try {
          await api.command(
            { type: 'project.delete', projectId, removeWorktrees: removeWorktrees === true },
            undefined,
            t,
          );
          setDeleteOpen(false);
          onBack();
        } catch (error) {
          if (isAbortError(error)) return;
          setDeleteError(projectDeleteErrorTextOf(error, t));
        } finally {
          setDeleteBusy(false);
        }
      }, [deleteBusy, onBack, projectId, t]);

      /** Save the project settings draft through `project.update {config}`. */
      const saveProjectConfig = React.useCallback(async (config) => {
        try {
          const data = await api.command({ type: 'project.update', projectId, config }, undefined, t);
          applyCommandResult(data);
          reload();
          return { ok: true };
        } catch (error) {
          if (isAbortError(error)) return { ok: false, error: t('error.unknown') };
          return { ok: false, error: describeError(error, t) };
        }
      }, [applyCommandResult, projectId, reload, t]);
      const openSettings = React.useCallback(() => setSettingsOpen(true), []);
      const closeSettings = React.useCallback(() => setSettingsOpen(false), []);

      /** Merge creation from the inspector: 2..4 completed parents. */
      const openMergeCreate = React.useCallback((nodeId) => {
        setMergeCreateSeed(typeof nodeId === 'string' && nodeId.length > 0 ? nodeId : null);
        setMergeCreateOpen(true);
      }, []);
      const closeMergeCreate = React.useCallback(() => {
        setMergeCreateOpen(false);
        setMergeCreateSeed(null);
      }, []);
      const submitMerge = React.useCallback(async (payload) => {
        try {
          const data = await api.command(
            {
              type: 'node.merge',
              projectId,
              parentIds: idListOf(payload.parentIds),
              title: payload.title,
              prompt: payload.prompt,
              timeboxMinutes: payload.timeboxMinutes,
            },
            undefined,
            t,
          );
          applyCommandResult(data);
          const createdNode = asObject(asObject(data).node);
          if (nodeIdOf(createdNode)) setSelectedId(nodeIdOf(createdNode));
          reload();
          return { ok: true };
        } catch (error) {
          if (isAbortError(error)) return { ok: false, error: t('error.unknown') };
          return { ok: false, error: describeError(error, t) };
        }
      }, [applyCommandResult, projectId, reload, t]);

      const openFinishMerge = React.useCallback((nodeId) => {
        setSelectedId(nodeId);
        setFinishMergeNodeId(nodeId);
      }, []);
      const closeFinishMerge = React.useCallback(() => setFinishMergeNodeId(null), []);
      const submitFinishMerge = React.useCallback(async (payload) => {
        if (finishMergeNodeId === null) return { ok: false, error: t('ws.merge.finishError') };
        try {
          const data = await api.command(
            { type: 'node.finish_merge', projectId, nodeId: finishMergeNodeId, ...(payload === undefined ? {} : payload) },
            undefined,
            t,
          );
          applyCommandResult(data);
          reload();
          return { ok: true };
        } catch (error) {
          if (isAbortError(error)) return { ok: false, error: t('error.unknown') };
          if (error instanceof LabRequestError && error.code === 'merge_conflicts') {
            return { ok: false, error: t('ws.merge.conflictsError', { message: error.message }) };
          }
          return { ok: false, error: describeError(error, t) };
        }
      }, [applyCommandResult, finishMergeNodeId, projectId, reload, t]);

      /** Push branches/tags; the dialog keeps pushed refs and git output inline. */
      /** Placement policy save (project.update config.placementPolicy). */
      const savePlacementPolicy = React.useCallback(async (policy) => {
        try {
          const data = await api.command(
            { type: 'project.update', projectId, config: { placementPolicy: policy } },
            undefined,
            t,
          );
          applyCommandResult(data);
          return { ok: true };
        } catch (error) {
          if (isAbortError(error)) return { ok: false, error: t('error.unknown') };
          return { ok: false, error: placementErrorTextOf(error, t) };
        }
      }, [applyCommandResult, projectId, t]);

      /** GUI cluster configuration: one modal shared by every entry point. */
      const openClusterConfig = React.useCallback(() => {
        setClusterOpen(false);
        setClusterConfigOpen(true);
      }, []);

      /** Manual model escalation: new attempt with the next stronger tier. */
      const handleEscalate = React.useCallback(async (nodeId) => {
        const result = await runNodeCommand('node.escalate', nodeId);
        if (result !== null && result !== undefined && result.ok === true) reload();
      }, [reload, runNodeCommand]);

      const openPush = React.useCallback(() => setPushOpen(true), []);
      const closePush = React.useCallback(() => setPushOpen(false), []);
      const submitPush = React.useCallback(async (remote) => {
        try {
          const data = await api.command(
            { type: 'project.push', projectId, remote: typeof remote === 'string' && remote.length > 0 ? remote : 'origin' },
            undefined,
            t,
          );
          return { ok: true, result: data };
        } catch (error) {
          if (isAbortError(error)) return { ok: false, error: t('error.unknown') };
          return { ok: false, error: projectPushErrorTextOf(error, t) };
        }
      }, [projectId, t]);

      let body;
      if (snapshot.phase === 'ready') {
        body = h(
          'div',
          { className: 'rl-workspace-grid' },
          h(NodeRail, { project, nodes, selectedId, onSelect: setSelectedId, t }),
          h(DagCanvas, {
            nodes,
            edges,
            layout,
            selectedId,
            now,
            busyKey,
            onSelect: setSelectedId,
            onOpenNative: openNodeNative,
            onContinue: requestContinue,
            onNodeAction: handleNodeAction,
            onProposalAction: requestProposalAction,
            onRetryRequest: requestRetry,
            onEscalate: handleEscalate,
            t,
          }),
          h(NodeInspector, {
            project,
            nodes,
            node: selectedNode,
            now,
            busyKey,
            onSave: saveNode,
            onAction: handleNodeAction,
            onOpenSession: openSessionNative,
            onContinue: requestContinue,
            onSuccessor: openSuccessor,
            onProposalAction: requestProposalAction,
            onOpenRun: openRuns,
            onRetryRequest: requestRetry,
            onOpenMergeCreate: openMergeCreate,
            onFinishMerge: openFinishMerge,
            onEscalate: handleEscalate,
            modelOptions,
            clusterEnabled: clusterEnabledOf(snapshot.cluster),
            t,
          }),
        );
      } else if (snapshot.phase === 'error') {
        body = h(
          'div',
          { className: 'rl-workspace-center' },
          h(
            'div',
            { className: 'rl-center-card' },
            h('h2', { className: 'rl-card-title' }, t('ws.loadError')),
            h('p', { className: 'rl-hint' }, snapshot.error || t('error.unknown')),
            h('p', { className: 'rl-hint' }, t('ws.loadingHint')),
            h(LabButton, { label: t('common.retry'), onClick: retry }),
          ),
        );
      } else {
        body = h('div', { className: 'rl-workspace-center' }, h(LabLoading, { label: t('ws.loading') }));
      }

      return h(
        'section',
        { className: 'rl-workspace', 'data-testid': 'metainfer-research-lab-workspace' },
        h(LabStyle),
        h(WorkspaceTopBar, {
          project,
          resources: snapshot.resources,
          revision: snapshot.revision,
          nodeCount: nodes.length,
          runningCount,
          stepBusy,
          auto: autoState,
          pendingProposals: Math.max(pendingProposalsCount, Math.round(numberOr(snapshot.pendingProposals, 0))),
          autoBusy,
          onStep: runStep,
          onOpenRuns: () => openRuns(null),
          onAutoStart: () => setAutoConfirmOpen(true),
          onAutoStop: stopAuto,
          onAutoResume: resumeAuto,
          onManualMode: switchToManual,
          onViewPending: viewPendingProposals,
          onOpenSettings: openSettings,
          projectMenuOpen,
          onToggleProjectMenu: () => setProjectMenuOpen((value) => !value),
          onDeleteProject: requestDeleteProject,
          onPush: openPush,
          onOpenClusterConfig: openClusterConfig,
          cluster: snapshot.cluster,
          onOpenCluster: () => setClusterOpen(true),
          onBack,
          t,
        }),
        offline !== null ? h(PollBanner, { offline, onRetry: retry, t }) : null,
        actionError !== ''
          ? h(
              'div',
              { className: 'rl-action-error', role: 'alert' },
              h('span', { className: 'rl-action-error-text' }, t('ws.action.failed') + ': ' + actionError),
              h(LabButton, { label: t('ws.action.dismiss'), variant: 'ghost', onClick: () => setActionError('') }),
            )
          : null,
        stepInfo !== null ? h(StepBanner, { info: stepInfo, onDismiss: () => setStepInfo(null), t }) : null,
        body,
        h(ActivityLog, { events, onSelectNode: setSelectedId, onOpenRun: openRuns, t }),
        continueNode !== null
          ? h(ContinueDialog, {
              node: continueNode,
              nodes,
              resources: snapshot.resources,
              onClose: closeContinue,
              onSend: sendContinue,
              t,
            })
          : null,
        runsOpen ? h(RunsPanel, { projectId, initialRunId: runsInitialRunId, onClose: closeRuns, t }) : null,
        successorOpen && successorParent !== null
          ? h(SuccessorModal, {
              project,
              parent: successorParent,
              onClose: closeSuccessor,
              onSubmit: submitSuccessor,
              modelOptions,
              t,
            })
          : null,
        autoConfirmOpen
          ? h(AutoConfirmModal, {
              project,
              onConfirm: confirmAutoStart,
              onClose: cancelAutoStart,
              t,
            })
          : null,
        settingsOpen
          ? h(SettingsModal, {
              project,
              projectId,
              onClose: closeSettings,
              onSave: saveProjectConfig,
              onSavePlacementPolicy: savePlacementPolicy,
              cluster: snapshot.cluster,
              t,
            })
          : null,
        mergeCreateOpen
          ? h(MergeCreateModal, {
              project,
              nodes,
              initialNodeId: mergeCreateSeed,
              onClose: closeMergeCreate,
              onSubmit: submitMerge,
              modelOptions,
              t,
            })
          : null,
        finishMergeNodeId !== null
          ? h(FinishMergeDialog, {
              onSubmit: submitFinishMerge,
              onClose: closeFinishMerge,
              t,
            })
          : null,
        pushOpen ? h(PushDialog, { onClose: closePush, onPush: submitPush, t }) : null,
        clusterOpen
          ? h(ClusterModal, {
              projectId,
              onClose: () => setClusterOpen(false),
              onOpenConfig: openClusterConfig,
              t,
            })
          : null,
        clusterConfigOpen
          ? h(ClusterConfigModal, {
              onClose: () => setClusterConfigOpen(false),
              onApplied: () => reload(),
              t,
            })
          : null,
        deleteOpen
          ? h(DeleteProjectDialog, {
              projectName: projectNameOf(project) || t('ws.project.unknown'),
              busy: deleteBusy,
              error: deleteError,
              onConfirm: confirmDeleteProject,
              onCancel: cancelDeleteProject,
              t,
            })
          : null,
        confirmRequest !== null
          ? h(ConfirmDialog, {
              title: confirmRequest.kind === 'approve'
                ? t('ws.confirm.approveTitle')
                : confirmRequest.kind === 'reject'
                  ? t('ws.confirm.rejectTitle')
                  : (confirmRequest.kind === 'retry' && nodes.some((node) => nodeIdOf(node) === confirmRequest.nodeId && nodeStatusOf(node) === 'cancelled'))
                    ? t('ws.retry.cancelledConfirmTitle')
                    : t('ws.retry.confirmTitle'),
              body: confirmRequest.kind === 'approve'
                ? t('ws.confirm.approveBody')
                : confirmRequest.kind === 'reject'
                  ? t('ws.confirm.rejectBody')
                  : (confirmRequest.kind === 'retry' && nodes.some((node) => nodeIdOf(node) === confirmRequest.nodeId && nodeStatusOf(node) === 'cancelled'))
                    ? t('ws.retry.cancelledConfirmBody')
                    : t('ws.retry.confirmBody'),
              confirmLabel: confirmRequest.kind === 'approve'
                ? t('ws.confirm.approve')
                : confirmRequest.kind === 'reject'
                  ? t('ws.confirm.reject')
                  : t('ws.retry.confirm'),
              danger: confirmRequest.kind === 'reject',
              onConfirm: confirmProposal,
              onCancel: cancelConfirm,
              t,
            })
          : null,
      );
    }

    /** Top bar: project identity, repo chip, resources, running count, mode, runs and Step. */
    function WorkspaceTopBar({
      project,
      resources,
      revision,
      nodeCount,
      runningCount,
      stepBusy,
      auto,
      pendingProposals,
      autoBusy,
      onStep,
      onOpenRuns,
      onAutoStart,
      onAutoStop,
      onAutoResume,
      onManualMode,
      onViewPending,
      onOpenSettings,
      projectMenuOpen,
      onToggleProjectMenu,
      onDeleteProject,
      onPush,
      onOpenClusterConfig,
      cluster,
      onOpenCluster,
      onBack,
      t,
    }) {
      const autoStatus = autoStatusOf(auto);
      const name = projectNameOf(project) || t('ws.project.unknown');
      const branch = projectBranch(project);
      const commit = shortCommit(projectBaseCommit(project));
      const repoPath = projectRepoPath(project);
      const dirty = projectGitDirty(project);
      const maxNodes = Math.round(projectMaxNodes(project));
      const chips = resourceChips(resources, projectConfig(project));
      return h(
        'header',
        { className: 'rl-topbar' },
        h(LabButton, { label: t('ws.back'), variant: 'ghost', onClick: onBack }),
        h(
          'div',
          { className: 'rl-topbar-project' },
          h('h1', { className: 'rl-topbar-title', title: name }, name),
          branch || commit
            ? h(
                'span',
                { className: 'rl-chip rl-chip-mono', title: repoPath },
                [branch, commit].filter((part) => part !== '').join('@') + (dirty ? ' *' : ''),
              )
            : null,
        ),
        h('div', { className: 'rl-topbar-spacer' }),
        h(ClusterChip, { cluster, onOpen: onOpenCluster, t }),
        h(
          'div',
          { className: 'rl-topbar-chips' },
          chips.map((chip) =>
            h('span', { key: 'resource-' + chip.key, className: 'rl-chip' }, t('ws.resourceChip', {
              key: chip.key,
              free: chip.free,
              total: chip.total,
            }))),
          heldEntriesOf(resources).map((entry) =>
            h('span', { key: 'held-' + entry.key, className: 'rl-chip' }, t('ws.held', {
              key: entry.key,
              held: entry.held,
            }))),
          h('span', { className: 'rl-chip' }, t('ws.runningCount', { count: runningCount })),
          h('span', { className: 'rl-chip' }, t('ws.nodeCount', { count: nodeCount, max: maxNodes })),
          revision !== null ? h('span', { className: 'rl-chip rl-chip-mono' }, t('ws.revision', { revision })) : null,
          dirty ? h('span', { className: 'rl-chip' }, t('ws.dirty')) : null,
        ),
        h(
          'div',
          { className: 'rl-topbar-controls' },
          h(
            'div',
            { className: 'rl-segment', role: 'group', 'aria-label': t('ws.mode') },
            h(
              'button',
              {
                type: 'button',
                className: 'rl-segment-item' + (autoStatus === 'off' ? ' rl-segment-active' : ''),
                'aria-pressed': autoStatus === 'off',
                disabled: autoBusy === true,
                onClick: onManualMode,
              },
              t('ws.mode.manual'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'rl-segment-item' + (autoStatus !== 'off' ? ' rl-segment-active' : ''),
                'aria-pressed': autoStatus !== 'off',
                disabled: autoBusy === true,
                title: autoStatus === 'off' ? t('ws.auto.confirmTitle') : undefined,
                onClick: autoStatus === 'off' ? onAutoStart : undefined,
              },
              t('ws.mode.auto'),
            ),
          ),
          h(AutoStatusChip, {
            auto,
            project,
            pendingProposals,
            busy: autoBusy === true,
            onResume: onAutoResume,
            onStop: onAutoStop,
            onViewPending,
            t,
          }),
          h(LabButton, { label: '⚙', variant: 'ghost', title: t('ws.settings.open'), onClick: onOpenSettings }),
          h(
            'div',
            { className: 'rl-menu-wrap' },
            h(LabButton, {
              label: '⋯',
              variant: 'ghost',
              title: t('ws.projectMenu'),
              onClick: onToggleProjectMenu,
            }),
            projectMenuOpen
              ? h(
                  'div',
                  { className: 'rl-menu', role: 'menu', 'aria-label': t('ws.projectMenu') },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'rl-menu-item',
                      role: 'menuitem',
                      onClick: onOpenClusterConfig,
                    },
                    t('ws.projectMenu.clusterConfig'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'rl-menu-item',
                      role: 'menuitem',
                      onClick: onPush,
                    },
                    t('ws.projectMenu.push'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'rl-menu-item rl-menu-item-danger',
                      role: 'menuitem',
                      onClick: onDeleteProject,
                    },
                    t('ws.projectMenu.delete'),
                  ),
                )
              : null,
          ),
          h(LabButton, { label: t('ws.runs.open'), variant: 'ghost', onClick: onOpenRuns }),
          autoStatus === 'off'
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'rl-btn rl-btn-primary',
                  disabled: stepBusy === true,
                  title: t('ws.step.hint'),
                  onClick: onStep,
                },
                stepBusy === true ? h('span', { className: 'rl-spinner', 'aria-hidden': true }) : null,
                stepBusy === true ? t('ws.step.running') : t('ws.step'),
              )
            : null,
        ),
      );
    }

    /** Resources currently held by running nodes (`gpu -> held`). */
    function heldEntriesOf(resources) {
      const held = asObject(asObject(resources).held);
      return Object.keys(held)
        .map((key) => ({ key, held: numberOr(held[key], 0) }))
        .filter((entry) => entry.held > 0);
    }

    /** `gpu free/total` chips, using state.resources with project config as fallback. */
    function resourceChips(resources, config) {
      const record = asObject(resources);
      const pools = asObject(record.pools);
      const free = asObject(record.free);
      const configured = asObject(config.resourcePools);
      const keys = {};
      for (const key of Object.keys(pools)) keys[key] = true;
      for (const key of Object.keys(free)) keys[key] = true;
      for (const key of Object.keys(configured)) keys[key] = true;
      return Object.keys(keys).map((key) => ({
        key,
        free: numberOr(free[key], 0),
        total: numberOr(pools[key], numberOr(configured[key], 0)),
      }));
    }

    /** Left rail: nodes grouped by status with counts; clicking selects. */
    function NodeRail({ project, nodes, selectedId, onSelect, t }) {
      const grouped = React.useMemo(() => {
        const buckets = {};
        for (const status of STATUS_ORDER) buckets[status] = [];
        for (const node of nodes) {
          const status = nodeStatusOf(node);
          if (buckets[status] === undefined) buckets[status] = [];
          buckets[status].push(node);
        }
        for (const status of STATUS_ORDER) {
          buckets[status] = buckets[status].slice().sort((left, right) => nodeTimeOf(left) - nodeTimeOf(right));
        }
        return buckets;
      }, [nodes]);
      const groups = [];
      for (const status of STATUS_ORDER) {
        const bucket = grouped[status];
        if (bucket.length === 0) continue;
        groups.push(
          h(
            'div',
            { key: status, className: 'rl-rail-group' },
            h(
              'div',
              { className: 'rl-rail-group-head' },
              h('span', null, t('status.' + status)),
              h('span', null, String(bucket.length)),
            ),
            bucket.map((node) => {
              const id = nodeIdOf(node);
              const active = id === selectedId;
              const minutes = nodeTimeboxMinutesOf(node, project);
              return h(
                'button',
                {
                  key: id,
                  type: 'button',
                  className: 'rl-rail-row' + (active ? ' rl-rail-row-active' : ''),
                  'aria-pressed': active,
                  title: nodeTitleOf(node, t),
                  onClick: () => onSelect(id),
                },
                h(StatusDot, { status: nodeStatusOf(node) }),
                h(
                  'span',
                  { className: 'rl-rail-row-main' },
                  h('span', { className: 'rl-rail-row-title' }, nodeTitleOf(node, t)),
                  h('span', { className: 'rl-rail-row-sub' }, id),
                ),
                h('span', { className: 'rl-rail-row-meta' }, t('ws.node.minutes', { minutes })),
              );
            }),
          ),
        );
      }
      return h(
        'aside',
        { className: 'rl-rail', 'aria-label': t('ws.rail.title') },
        h(
          'div',
          { className: 'rl-rail-head' },
          h('span', { className: 'rl-card-title' }, t('ws.rail.title')),
          h('span', { className: 'rl-card-meta' }, String(nodes.length)),
        ),
        nodes.length === 0 ? h('p', { className: 'rl-empty-note' }, t('ws.rail.empty')) : null,
        groups,
      );
    }

    /**
     * DAG canvas: one SVG for edges under absolutely positioned node cards.
     * Background drag pans, wheel zooms around the pointer, the toolbar fits the
     * graph, and clicking empty space clears the selection.
     */
    function DagCanvas({ nodes, edges, layout, selectedId, now, busyKey, onSelect, onOpenNative, onContinue, onNodeAction, onProposalAction, onRetryRequest, onEscalate, t }) {
      const viewportRef = React.useRef(null);
      const [pan, setPan] = React.useState({ x: 0, y: 0 });
      const [zoom, setZoom] = React.useState(1);
      const [dragging, setDragging] = React.useState(false);
      const panRef = React.useRef(pan);
      const zoomRef = React.useRef(zoom);
      const dragRef = React.useRef(null);
      const movedRef = React.useRef(0);
      const fittedRef = React.useRef(false);

      React.useEffect(() => {
        panRef.current = pan;
      }, [pan]);
      React.useEffect(() => {
        zoomRef.current = zoom;
      }, [zoom]);

      const clampZoom = (value) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));

      const fit = React.useCallback(() => {
        const viewport = viewportRef.current;
        if (!viewport || layout.width <= 0 || layout.height <= 0) {
          setZoom(1);
          setPan({ x: 0, y: 0 });
          return;
        }
        const rect = viewport.getBoundingClientRect();
        const width = Math.max(rect.width, 10);
        const height = Math.max(rect.height, 10);
        const scale = clampZoom(Math.min(
          (width - FIT_PAD * 2) / layout.width,
          (height - FIT_PAD * 2) / layout.height,
          1,
        ));
        setZoom(scale);
        setPan({ x: (width - layout.width * scale) / 2, y: (height - layout.height * scale) / 2 });
      }, [layout]);

      React.useEffect(() => {
        if (fittedRef.current) return;
        if (layout.width <= 0 || layout.height <= 0) return;
        fittedRef.current = true;
        fit();
      }, [fit, layout.width, layout.height]);

      React.useEffect(() => {
        const viewport = viewportRef.current;
        if (!viewport || typeof viewport.addEventListener !== 'function') return undefined;
        const onWheel = (event) => {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          const rect = viewport.getBoundingClientRect();
          const pointerX = event.clientX - rect.left;
          const pointerY = event.clientY - rect.top;
          const current = zoomRef.current;
          const next = clampZoom(current * Math.exp(-event.deltaY * 0.0015));
          if (next === current) return;
          const ratio = next / current;
          setPan((previous) => ({
            x: pointerX - (pointerX - previous.x) * ratio,
            y: pointerY - (pointerY - previous.y) * ratio,
          }));
          setZoom(next);
        };
        viewport.addEventListener('wheel', onWheel, { passive: false });
        return () => viewport.removeEventListener('wheel', onWheel);
      }, []);

      const zoomBy = (factor) => {
        const viewport = viewportRef.current;
        if (!viewport) return;
        const rect = viewport.getBoundingClientRect();
        const pointerX = rect.width / 2;
        const pointerY = rect.height / 2;
        const current = zoomRef.current;
        const next = clampZoom(current * factor);
        if (next === current) return;
        const ratio = next / current;
        setPan((previous) => ({
          x: pointerX - (pointerX - previous.x) * ratio,
          y: pointerY - (pointerY - previous.y) * ratio,
        }));
        setZoom(next);
      };

      const onPointerDown = (event) => {
        if (event.button !== 0) return;
        const target = event.target;
        if (target && typeof target.closest === 'function' && target.closest('.rl-node') !== null) return;
        dragRef.current = {
          startX: event.clientX,
          startY: event.clientY,
          panX: panRef.current.x,
          panY: panRef.current.y,
        };
        movedRef.current = 0;
        setDragging(true);
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch (error) {
          /* pointer capture is best effort */
        }
      };
      const onPointerMove = (event) => {
        const drag = dragRef.current;
        if (drag === null) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        movedRef.current = Math.max(movedRef.current, Math.abs(dx) + Math.abs(dy));
        setPan({ x: drag.panX + dx, y: drag.panY + dy });
      };
      const endDrag = (event) => {
        if (dragRef.current === null) return;
        dragRef.current = null;
        setDragging(false);
        try {
          if (event.currentTarget.hasPointerCapture && event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        } catch (error) {
          /* ignore */
        }
      };
      const onCanvasClick = (event) => {
        if (movedRef.current > 4) {
          movedRef.current = 0;
          return;
        }
        const target = event.target;
        if (target && typeof target.closest === 'function' && target.closest('.rl-node') !== null) return;
        onSelect(null);
      };

      const related = React.useMemo(() => relatedNodeIds(selectedId, edges), [edges, selectedId]);
      const innerStyle = {
        width: layout.width,
        height: layout.height,
        transform: 'translate(' + pan.x + 'px, ' + pan.y + 'px) scale(' + zoom + ')',
        transformOrigin: '0 0',
      };

      return h(
        'div',
        {
          className: 'rl-canvas' + (dragging ? ' rl-canvas-dragging' : ''),
          ref: viewportRef,
          onPointerDown,
          onPointerMove,
          onPointerUp: endDrag,
          onPointerCancel: endDrag,
          onClick: onCanvasClick,
        },
        layout.width > 0
          ? h(
              'div',
              { className: 'rl-canvas-inner', style: innerStyle },
              h(
                'svg',
                {
                  className: 'rl-canvas-svg',
                  width: layout.width,
                  height: layout.height,
                  viewBox: '0 0 ' + layout.width + ' ' + layout.height,
                  'aria-hidden': true,
                },
                edges.map((edge, index) => {
                  const from = layout.positions.get(edge.from);
                  const to = layout.positions.get(edge.to);
                  if (!from || !to) return null;
                  const active = selectedId !== null && (edge.from === selectedId || edge.to === selectedId);
                  return h('path', {
                    key: 'edge-' + index + '-' + edge.from + '-' + edge.to,
                    className: 'rl-edge' + (active ? ' rl-edge-active' : ''),
                    d: edgePath(from, to),
                  });
                }),
              ),
              nodes.map((node) => {
                const id = nodeIdOf(node);
                const position = layout.positions.get(id);
                if (!position) return null;
                return h(NodeCard, {
                  key: id,
                  node,
                  position,
                  selected: id === selectedId,
                  dim: selectedId !== null && id !== selectedId && !related.has(id),
                  parentTitle: parentTitleOf(node, nodes),
                  isLeaf: nodeIsLeafOf(node, nodes),
                  sealed: nodeSealedFlagOf(node),
                  busyKey,
                  now,
                  onSelect,
                  onOpenNative,
                  onContinue,
                  onNodeAction,
                  onProposalAction,
                  onRetryRequest,
                  onEscalate,
                  t,
                });
              }),
            )
          : h('div', { className: 'rl-canvas-empty' }, t('ws.canvas.empty')),
        h(
          'div',
          { className: 'rl-canvas-toolbar' },
          h(LabButton, { label: t('ws.canvas.fit'), variant: 'ghost', onClick: fit, title: t('ws.canvas.fit') }),
          h(LabButton, { label: '＋', variant: 'ghost', onClick: () => zoomBy(1.2), title: t('ws.canvas.zoomIn') }),
          h('span', { className: 'rl-canvas-zoom' }, Math.round(zoom * 100) + '%'),
          h(LabButton, { label: '－', variant: 'ghost', onClick: () => zoomBy(1 / 1.2), title: t('ws.canvas.zoomOut') }),
        ),
        nodes.length > 0 ? h('div', { className: 'rl-canvas-hint' }, t('ws.canvas.hint')) : null,
      );
    }

    /** Parent title lookup for a node card subtitle (merge nodes list all parents). */
    function parentTitleOf(node, nodes) {
      const parentIds = nodeParentIdsOf(node);
      if (parentIds.length === 0) return '';
      const titles = parentIds.map((parentId) => {
        for (const candidate of nodes) if (nodeIdOf(candidate) === parentId) return nodeTitleOf(candidate);
        return parentId;
      });
      if (titles.length === 1) return titles[0];
      return titles.slice(0, 2).join(' + ') + (titles.length > 2 ? ' +…' : '');
    }

    /** One absolutely positioned node card with hover quick actions. */
    function NodeCard({
      node,
      position,
      selected,
      dim,
      parentTitle,
      isLeaf,
      sealed,
      busyKey,
      now,
      onSelect,
      onOpenNative,
      onContinue,
      onNodeAction,
      onProposalAction,
      onRetryRequest,
      onEscalate,
      t,
    }) {
      const status = nodeStatusOf(node);
      const id = nodeIdOf(node);
      const title = nodeTitleOf(node, t);
      const prompt = nodePromptOf(node);
      const needs = nodeNeedsEntries(node);
      const minutes = nodeTimeboxMinutesOf(node, null);
      const head = nodeHeadCommitOf(node);
      const countdown = countdownOf(nodeDeadlineOf(node), now);
      const busy = typeof busyKey === 'string' && busyKey.endsWith(':' + id);
      const isMergeNode = nodeIsMergeOf(node);
      const usage = nodeUsageOf(node);
      const isFleet = nodeIsFleetOf(node);
      const modelLabel = nodeModelLabelOf(node);
      const nodeCost = nodeCostUsdOf(node);
      const wait = nodeResourceWaitOf(node);
      const blocked = busy || wait !== null;
      const actions = [];
      if (status === 'planned') {
        actions.push({ key: 'start', label: t('ws.action.start'), run: () => onNodeAction('node.start', id) });
      } else if (status === 'running') {
        actions.push({ key: 'cancel', label: t('ws.action.cancel'), run: () => onNodeAction('node.cancel', id) });
        if (isMergeNode) actions.push({ key: 'continue', label: t('ws.native.continue'), run: () => onContinue(id) });
      } else if (status === 'completed' && isLeaf === true) {
        actions.push({
          key: 'continue',
          label: sealed === true ? t('ws.action.openTranscript') : t('ws.action.continue'),
          run: () => (sealed === true ? onOpenNative(id, 'trajectory') : onContinue(id)),
        });
      } else if (status === 'proposed') {
        actions.push({ key: 'approve', label: t('ws.proposed.approve'), run: () => onProposalAction('approve', id) });
        actions.push({ key: 'reject', label: t('ws.proposed.reject'), run: () => onProposalAction('reject', id) });
      } else if (status === 'failed') {
        actions.push({ key: 'retry', label: t('ws.retry.action'), run: () => onRetryRequest(id) });
        actions.push({ key: 'escalate', label: t('ws.escalate.action'), run: () => onEscalate(id) });
      } else if (status === 'cancelled') {
        actions.push({ key: 'retry', label: t('ws.retry.cancelled'), run: () => onRetryRequest(id) });
      }
      let className = 'rl-node rl-node-' + status;
      if (isMergeNode) className += ' rl-node-merge';
      if (isFleet) className += ' rl-node-fleet';
      if (wait !== null) className += ' rl-node-waiting';
      if (selected) className += ' rl-node-selected';
      if (dim) className += ' rl-node-dim';
      return h(
        'div',
        {
          role: 'button',
          tabIndex: 0,
          className,
          style: { left: position.x, top: position.y, width: NODE_W, height: NODE_H },
          title,
          'aria-pressed': selected,
          onClick: (event) => {
            event.stopPropagation();
            onSelect(id);
          },
          onDoubleClick: (event) => {
            event.stopPropagation();
            onOpenNative(id, 'trajectory');
          },
          onKeyDown: (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            onSelect(id);
          },
        },
        h(
          'span',
          { className: 'rl-node-head' },
          h(StatusDot, { status }),
          h('span', { className: 'rl-node-id' }, id),
          h('span', { className: 'rl-node-title' }, title),
          sealed === true ? h('span', { className: 'rl-lock-badge', title: t('ws.sealed') }, '🔒') : null,
        ),
        actions.length > 0
          ? h(
              'span',
              { className: 'rl-node-actions' },
              actions.map((action) =>
                h(
                  'button',
                  {
                    key: action.key,
                    type: 'button',
                    className: 'rl-node-action',
                    disabled: blocked,
                    title: blocked && wait !== null ? t('ws.cluster.waitHint') : action.label,
                    onClick: (event) => {
                      event.stopPropagation();
                      action.run();
                    },
                  },
                  action.label,
                )),
            )
          : null,
        h(
          'span',
          { className: 'rl-node-sub' },
          parentTitle ? t('ws.node.parentPrefix') + parentTitle : (prompt || t('common.none')),
        ),
        h(
          'span',
          { className: 'rl-node-chips' },
          status === 'proposed' ? h('span', { className: 'rl-chip rl-chip-warn' }, t('ws.proposed.badge')) : null,
          isMergeNode ? h('span', { className: 'rl-chip rl-chip-merge' }, t('ws.merge.badge')) : null,
          isMergeNode ? h('span', { className: 'rl-chip' }, t('ws.merge.parentCount', { count: nodeParentIdsOf(node).length })) : null,
          isFleet ? h('span', { className: 'rl-chip rl-chip-merge' }, nodeFleetBadgeTextOf(node, t)) : null,
          needs.map((entry) => h('span', { key: entry.key, className: 'rl-chip' }, entry.key + '×' + entry.amount)),
          status === 'running' && countdown !== null
            ? h(
                'span',
                {
                  className: 'rl-chip rl-countdown' + (countdown.overdue ? ' rl-countdown-overdue' : ''),
                  title: t('ws.running.remaining', { time: countdown.text }),
                },
                countdown.overdue ? t('ws.running.overdue') : t('ws.card.remaining', { time: countdown.text }),
              )
            : h('span', { className: 'rl-chip' }, t('ws.node.minutes', { minutes })),
          head ? h('span', { className: 'rl-chip rl-chip-mono' }, shortCommit(head)) : null,
          usage !== null ? h('span', { className: 'rl-chip rl-chip-usage' }, t('ws.usage.chip', { count: formatTokenCount(usageTotalOf(usage)) })) : null,
          modelLabel !== '' ? h('span', { className: 'rl-chip rl-chip-mono' }, modelLabel) : null,
          nodeCost !== null ? h('span', { className: 'rl-chip' }, formatUsdAmount(nodeCost)) : null,
          wait !== null
            ? h('span', { className: 'rl-chip rl-chip-warn' }, t('ws.cluster.nodeWait', {
                pool: firstString(wait.pool) || 'gpu',
                amount: numberOr(wait.amount, 0),
              }) + (finiteNumber(wait.position) !== null ? ' · #' + String(numberOr(wait.position, 0)) : ''))
            : null,
        ),
      );
    }

    /**
     * Right inspector: prompt + success criteria and timebox editors (planned
     * nodes only), plus read-only Git/timestamp readback.
     */
    function NodeInspector({ project, nodes, node, now, busyKey, onSave, onAction, onOpenSession, onContinue, onSuccessor, onProposalAction, onOpenRun, onRetryRequest, onOpenMergeCreate, onFinishMerge, onEscalate, modelOptions, clusterEnabled, t }) {
      const nodeKey = node === null ? '' : nodeIdOf(node);
      const [promptDraft, setPromptDraft] = React.useState('');
      const [criteriaDraft, setCriteriaDraft] = React.useState('');
      const [timeboxDraft, setTimeboxDraft] = React.useState('');
      const [savingField, setSavingField] = React.useState('');
      const [saved, setSaved] = React.useState(false);
      const [saveError, setSaveError] = React.useState('');
      const [modelDraft, setModelDraft] = React.useState(null);

      React.useEffect(() => {
        if (node === null) {
          setPromptDraft('');
          setCriteriaDraft('');
          setTimeboxDraft('');
          setModelDraft(null);
          setSaved(false);
          setSaveError('');
          return;
        }
        setModelDraft(nodeModelOf(node));
        setPromptDraft(nodePromptOf(node));
        setCriteriaDraft(nodeSuccessCriteriaOf(node));
        setTimeboxDraft(String(nodeTimeboxMinutesOf(node, project)));
        setSaved(false);
        setSaveError('');
      }, [nodeKey]); // eslint-disable-line react-hooks/exhaustive-deps

      if (node === null) {
        return h(
          'aside',
          { className: 'rl-inspector', 'aria-label': t('ws.inspector.title') },
          h('h2', { className: 'rl-card-title' }, t('ws.inspector.title')),
          h('p', { className: 'rl-inspector-empty' }, t('ws.inspector.empty')),
        );
      }

      const status = nodeStatusOf(node);
      const editable = status === 'planned' || status === 'proposed';
      const maxMinutes = Math.round(projectMaxTimeoutMinutes(project));
      const timestamps = nodeTimestampsOf(node);
      const createdBy = nodeCreatedByOf(node);
      const createdByLabel = createdBy === ''
        ? ''
        : (['user', 'advisor', 'seed'].indexOf(createdBy) >= 0 ? t('createdBy.' + createdBy) : createdBy);
      const errorMessage = firstString(nodeErrorOf(node).message);
      const nodeKeyId = nodeIdOf(node);
      const busy = typeof busyKey === 'string' && busyKey.endsWith(':' + nodeKeyId);
      const countdown = countdownOf(nodeDeadlineOf(node), now);
      const nodeReport = nodeReportOf(node);
      const reportText = nodeReportTextOf(node);
      const termination = nodeTerminationOf(node);
      const followUps = nodeFollowUpsOf(node);
      const held = nodeResourcesHeldOf(node);
      const heldEntries = Object.keys(held)
        .map((key) => ({ key, amount: numberOr(held[key], 0) }))
        .filter((entry) => entry.amount > 0);
      const sealedNode = nodeSealedFlagOf(node);
      const leafAndOpen = nodeIsLeafOf(node, nodes) && !sealedNode;
      const proposal = nodeProposalOf(node);
      const isMergeNode = nodeIsMergeOf(node);
      const nodeUsage = nodeUsageOf(node);
      const lastReportText = firstString(asObject(node).lastReport);
      const resolvedModel = nodeModelResolvedOf(node);
      const resolvedModelLabel = modelLabelOf(resolvedModel);
      const resolvedModelSource = firstString(asObject(resolvedModel).source);
      const nodeCost = nodeCostUsdOf(node);
      const nodeCostPriced = nodeCostPricedOf(node);
      const attempts = nodeAttemptsOf(node);
      const lease = nodeLeaseOf(node);
      const remote = nodeRemoteOf(node);
      const leaseMachines = nodeLeaseMachinesOf(node);
      const isFleet = remote !== null || leaseMachines.length > 1;
      const wait = nodeResourceWaitOf(node);
      const waiting = wait !== null;
      const blocked = busy || waiting;

      const savePrompt = async () => {
        if (!editable || savingField !== '') return;
        const prompt = promptDraft.trim();
        if (!prompt) {
          setSaveError(t('ws.inspector.promptRequired'));
          setSaved(false);
          return;
        }
        setSavingField('prompt');
        setSaveError('');
        const result = await onSave({ prompt, successCriteria: criteriaDraft.trim() });
        setSavingField('');
        if (result.ok) {
          setSaved(true);
        } else {
          setSaved(false);
          setSaveError(result.error || t('ws.inspector.error'));
        }
      };
      const saveModel = async () => {
        if (!editable || savingField !== '') return;
        setSavingField('model');
        setSaveError('');
        const payload = modelPayloadOf(modelDraft);
        if (payload === undefined) {
          setSavingField('');
          setSaved(false);
          setSaveError(t('ws.model.inheritHint'));
          return;
        }
        const result = await onSave({ model: payload });
        setSavingField('');
        if (result.ok) setSaved(true);
        else {
          setSaved(false);
          setSaveError(result.error || t('ws.inspector.error'));
        }
      };
      const saveTimebox = async () => {
        if (!editable || savingField !== '') return;
        const minutes = parseInteger(timeboxDraft, 0);
        if (minutes < 1 || minutes > maxMinutes) {
          setSaveError(t('ws.inspector.timebox.invalid', { max: maxMinutes }));
          setSaved(false);
          return;
        }
        setSavingField('timebox');
        setSaveError('');
        const result = await onSave({ timeboxMinutes: minutes });
        setSavingField('');
        if (result.ok) {
          setSaved(true);
        } else {
          setSaved(false);
          setSaveError(result.error || t('ws.inspector.error'));
        }
      };

      return h(
        'aside',
        { className: 'rl-inspector', 'aria-label': t('ws.inspector.title') },
        h(
          'div',
          { className: 'rl-inspector-head' },
          h('h2', { className: 'rl-inspector-title' }, nodeTitleOf(node, t)),
          h(
            'span',
            { className: 'rl-status-pill' + (status === 'failed' ? ' rl-status-failed' : '') },
            h(StatusDot, { status }),
            t('status.' + status),
          ),
          h('span', { className: 'rl-inspector-id' }, nodeIdOf(node)),
          sealedNode ? h('span', { className: 'rl-chip' }, '🔒 ' + t('ws.sealed')) : null,
        ),
        proposal !== null
          ? h(ProposalPanel, { proposal, t })
          : null,
        resolvedModelLabel !== '' || editable
          ? h(
              'div',
              { className: 'rl-section' },
              h('h3', { className: 'rl-section-title' }, t('ws.model.title')),
              h(LabInfoRow, { label: t('ws.model.resolved'), value: resolvedModelLabel || t('ws.model.none'), mono: true }),
              resolvedModelSource !== ''
                ? h(LabInfoRow, { label: t('ws.model.source'), value: t(modelSourceLabelKeyOf(resolvedModelSource)) })
                : null,
              editable
                ? h(ModelPicker, { model: modelDraft, onChange: setModelDraft, modelOptions, disabled: savingField !== '', t })
                : null,
              editable
                ? h(
                    'div',
                    { className: 'rl-form-actions' },
                    h(LabButton, {
                      label: savingField === 'model' ? t('ws.settings.saving') : t('ws.inspector.saveModel'),
                      disabled: savingField !== '',
                      onClick: saveModel,
                    }),
                  )
                : null,
            )
          : null,
        waiting
          ? h(
              'div',
              { className: 'rl-merge-panel rl-wait-panel' },
              h('p', { className: 'rl-merge-title' }, t('ws.cluster.nodeWait', {
                pool: firstString(wait.pool) || 'gpu',
                amount: numberOr(wait.amount, 0),
              })),
              finiteNumber(wait.position) !== null
                ? h(LabInfoRow, { label: t('ws.cluster.queueTitle'), value: t('ws.cluster.nodeWaitPosition', { position: numberOr(wait.position, 0) }) })
                : null,
              firstString(wait.machineId) ? h(LabInfoRow, { label: t('ws.cluster.machine'), value: firstString(wait.machineId), mono: true }) : null,
              h('p', { className: 'rl-hint' }, t('ws.cluster.waitHint')),
              clusterEnabled === true ? h('p', { className: 'rl-hint' }, t('ws.cluster.waitSchedulerHint')) : null,
            )
          : null,
        lease !== null
          ? h(
              'div',
              { className: 'rl-merge-panel' },
              h('p', { className: 'rl-merge-title' }, t('ws.cluster.lease')),
              h(LabInfoRow, { label: t('ws.cluster.machine'), value: firstString(lease.machineId) || '—', mono: true }),
              h(LabInfoRow, { label: t('ws.cluster.devices'), value: stringListOf(lease.deviceIds).join(', ') || '—' }),
              finiteNumber(lease.expiresAt) !== null
                ? h(LabInfoRow, { label: t('ws.cluster.leaseExpiresLabel'), value: formatDateTime(lease.expiresAt, t) })
                : null,
            )
          : null,
        isFleet
          ? h(
              'div',
              { className: 'rl-merge-panel rl-fleet-panel' },
              h('p', { className: 'rl-merge-title' }, t('ws.fleet.panel')),
              h(LabInfoRow, {
                label: t('ws.fleet.placement'),
                value: firstString(asObject(lease).placement) === 'fleet' || remote !== null ? t('ws.fleet.placement.fleet') : t('ws.fleet.placement.local'),
              }),
              leaseMachines.length > 0
                ? h(
                    'div',
                    { className: 'rl-report-section' },
                    h('h4', { className: 'rl-report-section-title' }, t('ws.fleet.machines')),
                    leaseMachines.map((group, index) => h(
                      'div',
                      { key: firstString(group.machineId) || 'group-' + index, className: 'rl-merge-parent' },
                      h('span', { className: 'rl-merge-parent-title' }, firstString(group.machineId) || '—'),
                      h('span', { className: 'rl-merge-parent-meta' }, stringListOf(group.deviceIds).join(', ')),
                      fleetLabelChipsOf(group.labels).length > 0
                        ? h(
                            'div',
                            { className: 'rl-project-chips' },
                            h('span', { className: 'rl-hint' }, t('ws.fleet.labels') + ':'),
                            fleetLabelChipsOf(group.labels).map((labelChip) => h(
                              'span',
                              { key: labelChip.key, className: 'rl-chip rl-chip-mono' },
                              labelChip.text,
                            )),
                          )
                        : null,
                    )),
                  )
                : (remote !== null
                    ? h(LabInfoRow, { label: t('ws.fleet.machines'), value: stringListOf(remote.machineIds).join(', ') || '—' })
                    : null),
              remote !== null && finiteNumber(remote.masterPort) !== null
                ? h(LabInfoRow, { label: t('ws.fleet.masterPort'), value: String(Math.round(numberOr(remote.masterPort, 0))) })
                : null,
              remote !== null && firstString(remote.dir) !== ''
                ? h(LabInfoRow, { label: t('ws.fleet.remoteDir'), value: firstString(remote.dir), mono: true })
                : null,
              h('p', { className: 'rl-hint' }, t('ws.fleet.workerHint')),
            )
          : null,
        h(
          'div',
          { className: 'rl-inspector-actions' },
          status === 'proposed'
            ? h(LabButton, {
                label: busy ? t('ws.proposed.working') : t('ws.proposed.approve'),
                variant: 'primary',
                disabled: busy,
                onClick: () => onProposalAction('approve', nodeKeyId),
              })
            : null,
          status === 'proposed'
            ? h(LabButton, {
                label: t('ws.proposed.reject'),
                disabled: busy,
                onClick: () => onProposalAction('reject', nodeKeyId),
              })
            : null,
          status === 'planned'
            ? h(LabButton, {
                label: busy ? t('ws.action.starting') : t('ws.action.start'),
                variant: 'primary',
                disabled: blocked,
                onClick: () => onAction('node.start', nodeKeyId),
              })
            : null,
          status === 'running'
            ? h(LabButton, {
                label: busy ? t('ws.action.cancelling') : t('ws.action.cancel'),
                variant: 'primary',
                disabled: busy,
                onClick: () => onAction('node.cancel', nodeKeyId),
              })
            : null,
          status === 'failed'
            ? h(LabButton, {
                label: busy ? t('ws.retry.busy') : t('ws.retry.action'),
                variant: 'primary',
                disabled: blocked,
                onClick: () => onRetryRequest(nodeKeyId),
              })
            : null,
          status === 'cancelled'
            ? h(LabButton, {
                label: busy ? t('ws.retry.busy') : t('ws.retry.cancelled'),
                variant: 'primary',
                disabled: blocked,
                title: t('ws.retry.cancelledHint'),
                onClick: () => onRetryRequest(nodeKeyId),
              })
            : null,
          (status === 'failed' || (status === 'completed' && leafAndOpen))
            ? h(LabButton, {
                label: busy ? t('ws.escalate.busy') : t('ws.escalate.action'),
                disabled: blocked,
                title: t('ws.escalate.hint'),
                onClick: () => onEscalate(nodeKeyId),
              })
            : null,
          waiting ? h('p', { className: 'rl-hint rl-wait-hint' }, t('ws.cluster.waitHint')) : null,
          nodeCanContinueOf(node, nodes)
            ? h(LabButton, {
                label: t('ws.native.continue'),
                onClick: () => onContinue(nodeKeyId),
              })
            : null,
          status === 'completed'
            ? h(LabButton, {
                label: t('ws.successor.action'),
                onClick: () => onSuccessor(nodeKeyId),
              })
            : null,
          status === 'completed' && !isMergeNode
            ? h(LabButton, {
                label: t('ws.merge.createAction'),
                onClick: () => onOpenMergeCreate(nodeKeyId),
              })
            : null,
        ),
        h(NativeSessionPanel, { node, onOpenSession, t }),
        isMergeNode
          ? h(MergeSection, { node, nodes, busy, onFinish: () => onFinishMerge(nodeKeyId), t })
          : null,
        isMergeNode && lastReportText !== ''
          ? h(
              'div',
              { className: 'rl-section' },
              h('h3', { className: 'rl-section-title' }, t('ws.merge.lastReport')),
              h('p', { className: 'rl-text-prewrap' }, lastReportText),
            )
          : null,
        status === 'running'
          ? h(
              'div',
              { className: 'rl-running-panel' },
              h(
                'div',
                { className: 'rl-running-head' },
                h('span', { className: 'rl-spinner', 'aria-hidden': true }),
                h('span', null, t('ws.running.title')),
                countdown !== null
                  ? h(
                      'span',
                      {
                        className: 'rl-running-time' + (countdown.overdue ? ' rl-running-time-overdue' : ''),
                      },
                      countdown.overdue
                        ? t('ws.running.overdue')
                        : t('ws.running.remaining', { time: countdown.text }),
                    )
                  : null,
              ),
              finiteNumber(nodeDeadlineOf(node)) !== null
                ? h(LabInfoRow, { label: t('ws.running.deadline'), value: formatDateTime(nodeDeadlineOf(node), t) })
                : null,
              heldEntries.length > 0
                ? h(
                    'div',
                    { className: 'rl-project-chips' },
                    heldEntries.map((entry) =>
                      h('span', { key: entry.key, className: 'rl-chip' }, t('ws.held', {
                        key: entry.key,
                        held: entry.amount,
                      }))),
                  )
                : null,
              h('p', { className: 'rl-hint' }, t('ws.running.hint')),
            )
          : null,
        editable ? null : h('p', { className: 'rl-notice' }, t('ws.inspector.readonly', { status: t('status.' + status) })),

        h(
          'div',
          { className: 'rl-section' },
          h('h3', { className: 'rl-section-title' }, t('ws.inspector.prompt')),
          h(LabTextarea, {
            value: promptDraft,
            placeholder: t('ws.inspector.prompt.placeholder'),
            ariaLabel: t('ws.inspector.prompt'),
            rows: 5,
            disabled: !editable,
            onChange: (event) => {
              setPromptDraft(event.target.value);
              setSaved(false);
              setSaveError('');
            },
          }),
          h('span', { className: 'rl-hint' }, t('ws.inspector.prompt.chars', { count: promptDraft.length })),
          h('span', { className: 'rl-label' }, t('ws.inspector.successCriteria')),
          h(LabTextarea, {
            value: criteriaDraft,
            placeholder: t('ws.inspector.successCriteria.placeholder'),
            ariaLabel: t('ws.inspector.successCriteria'),
            rows: 3,
            disabled: !editable,
            onChange: (event) => {
              setCriteriaDraft(event.target.value);
              setSaved(false);
              setSaveError('');
            },
          }),
          h(
            'div',
            { className: 'rl-form-actions' },
            h(LabButton, {
              label: savingField === 'prompt' ? t('ws.inspector.saving') : t('ws.inspector.savePrompt'),
              variant: 'primary',
              disabled: !editable || savingField !== '',
              onClick: savePrompt,
            }),
          ),
        ),

        h(
          'div',
          { className: 'rl-section' },
          h('h3', { className: 'rl-section-title' }, t('ws.inspector.timebox')),
          h(
            'div',
            { className: 'rl-form-row' },
            h(LabInput, {
              type: 'number',
              value: timeboxDraft,
              disabled: !editable,
              ariaLabel: t('ws.inspector.timebox'),
              onChange: (event) => {
                setTimeboxDraft(event.target.value);
                setSaved(false);
                setSaveError('');
              },
            }),
            h(LabButton, {
              label: savingField === 'timebox' ? t('ws.inspector.saving') : t('ws.inspector.saveTimebox'),
              disabled: !editable || savingField !== '',
              onClick: saveTimebox,
            }),
          ),
          h('span', { className: 'rl-hint' }, t('ws.inspector.timebox.hint', { max: maxMinutes })),
        ),

        editable
          ? h(
              'div',
              { className: 'rl-section' },
              h(NeedsEditor, {
                key: 'needs-' + nodeKeyId,
                node,
                busy,
                onSave: (needs) => onSave({ needs }),
                t,
              }),
            )
          : null,

        saved ? h('span', { className: 'rl-saved' }, t('ws.inspector.saved')) : null,
        saveError ? h('p', { className: 'rl-error-text', role: 'alert' }, t('ws.inspector.error') + ': ' + saveError) : null,

        nodeReport !== null || reportText !== ''
          ? h(
              'div',
              { className: 'rl-section' },
              h('h3', { className: 'rl-section-title' }, t('ws.report.title')),
              nodeReport !== null
                ? h(ReportCard, { report: nodeReport, t })
                : h('p', { className: 'rl-text-prewrap' }, reportText),
            )
          : null,

        termination !== null
          ? h(
              'div',
              { className: 'rl-section' },
              h('h3', { className: 'rl-section-title' }, t('ws.termination.title')),
              h(TerminationPanel, { termination, onOpenRun, t }),
            )
          : null,

        followUps.length > 0
          ? h(
              'div',
              { className: 'rl-section' },
              h('h3', { className: 'rl-section-title' }, t('ws.followUps.title')),
              h(FollowUpsList, { followUps, t }),
            )
          : null,

        nodeUsage !== null
          ? h(
              'div',
              { className: 'rl-section' },
              h('h3', { className: 'rl-section-title' }, t('ws.usage.title')),
              h(UsageRows, { usage: nodeUsage, t }),
            )
          : null,
        attempts.length > 0 || nodeCost !== null
          ? h(AttemptsPanel, { node, t })
          : null,

        h(
          'div',
          { className: 'rl-section' },
          h('h3', { className: 'rl-section-title' }, t('ws.inspector.git')),
          h(LabInfoRow, { label: t('ws.inspector.branch'), value: nodeBranchOf(node), mono: true }),
          h(LabInfoRow, { label: t('ws.inspector.worktree'), value: nodeWorktreeOf(node), mono: true }),
          h(LabInfoRow, { label: t('ws.inspector.baseCommit'), value: nodeBaseCommitOf(node), mono: true }),
          nodeHeadCommitOf(node) ? h(LabInfoRow, { label: t('ws.inspector.headCommit'), value: nodeHeadCommitOf(node), mono: true }) : null,
          nodeTagOf(node) ? h(LabInfoRow, { label: t('ws.inspector.tag'), value: nodeTagOf(node), mono: true }) : null,
          projectWorktreeRoot(project)
            ? h(LabInfoRow, { label: t('ws.inspector.worktreeRoot'), value: projectWorktreeRoot(project), mono: true })
            : null,
        ),

        h(
          'div',
          { className: 'rl-section' },
          h('h3', { className: 'rl-section-title' }, t('ws.inspector.timestamps')),
          h(LabInfoRow, { label: t('ws.inspector.parent'), value: parentTitleOf(node, nodes) || t('ws.node.root') }),
          createdByLabel ? h(LabInfoRow, { label: t('ws.inspector.createdBy'), value: createdByLabel }) : null,
          h(LabInfoRow, { label: t('ws.inspector.createdAt'), value: formatDateTime(timestamps.createdAt, t) }),
          finiteNumber(timestamps.lastActivityAt) !== null
            ? h(LabInfoRow, { label: t('ws.inspector.updatedAt'), value: formatDateTime(timestamps.lastActivityAt, t) })
            : null,
          finiteNumber(timestamps.startedAt) !== null
            ? h(LabInfoRow, { label: t('ws.inspector.startedAt'), value: formatDateTime(timestamps.startedAt, t) })
            : null,
          finiteNumber(timestamps.completedAt) !== null
            ? h(LabInfoRow, { label: t('ws.inspector.completedAt'), value: formatDateTime(timestamps.completedAt, t) })
            : null,
        ),

        errorMessage
          ? h(
              'div',
              { className: 'rl-section' },
              h('h3', { className: 'rl-section-title' }, t('ws.inspector.errorLabel')),
              h('p', { className: 'rl-error-text' }, errorMessage),
            )
          : null,
      );
    }

    /** Structured NodeReport card: summary, blockers, metrics and lists. */
    function ReportCard({ report, t }) {
      const record = asObject(report);
      const success = record.success === true;
      const summary = firstString(record.summary);
      const metrics = asArray(record.metrics).filter((metric) => metric !== null && typeof metric === 'object');
      const section = (title, items, extraClass) => {
        if (items.length === 0) return null;
        return h(
          'div',
          { className: 'rl-report-section' },
          h('h4', { className: 'rl-report-section-title' }, title),
          h(
            'ul',
            { className: 'rl-report-list' + (extraClass === undefined ? '' : ' ' + extraClass) },
            items.map((item, index) => h('li', { key: index }, item)),
          ),
        );
      };
      return h(
        'div',
        { className: 'rl-report' },
        h(
          'span',
          { className: 'rl-report-status ' + (success ? 'rl-report-status-ok' : 'rl-report-status-bad') },
          success ? t('ws.report.success') : t('ws.report.failed'),
        ),
        summary ? h('p', { className: 'rl-report-summary' }, summary) : null,
        section(t('ws.report.blockers'), stringListOf(record.blockers), 'rl-report-blockers'),
        metrics.length > 0
          ? h(
              'div',
              { className: 'rl-report-section' },
              h('h4', { className: 'rl-report-section-title' }, t('ws.report.metrics')),
              h(
                'table',
                { className: 'rl-metrics' },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', null, t('ws.report.metricName')),
                    h('th', null, t('ws.report.metricValue')),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  metrics.map((metric, index) => {
                    const entry = asObject(metric);
                    const value = firstString(String(asObject(entry).value === undefined ? '' : entry.value));
                    const unit = firstString(entry.unit);
                    return h(
                      'tr',
                      { key: index },
                      h('td', null, firstString(entry.name) || '—'),
                      h('td', null, value === '' ? '—' : unit ? value + ' ' + unit : value),
                    );
                  }),
                ),
              ),
            )
          : null,
        section(t('ws.report.changes'), stringListOf(record.changes)),
        section(t('ws.report.reproduce'), stringListOf(record.reproduce)),
        section(t('ws.report.next'), stringListOf(record.next)),
        section(t('ws.report.risks'), stringListOf(record.risks)),
      );
    }

    /** Deterministic termination record (timeout/cancel/failure reaper output). */
    function TerminationPanel({ termination, t, onOpenRun }) {
      const record = asObject(termination);
      const kind = firstString(record.kind);
      const kindLabel = ['timeout', 'cancel', 'failure'].indexOf(kind) >= 0
        ? t('ws.termination.kind.' + kind)
        : (kind || t('common.unknown'));
      const pids = asArray(record.killedPids).map((pid) => String(pid));
      const jobs = asArray(record.killedJobs).map((job) => String(job));
      const leftover = stringListOf(record.leftover);
      const flag = (value) => {
        if (value === true) return t('ws.termination.yes');
        if (value === false) return t('ws.termination.no');
        return t('common.unknown');
      };
      return h(
        'div',
        { className: 'rl-termination' },
        h('p', { className: 'rl-termination-title' }, kindLabel),
        finiteNumber(record.killedAt) !== null
          ? h(LabInfoRow, { label: t('ws.termination.killedAt'), value: formatDateTime(record.killedAt, t) })
          : null,
        h(LabInfoRow, { label: t('ws.termination.pids'), value: pids.length > 0 ? pids.join(', ') : '—' }),
        h(LabInfoRow, { label: t('ws.termination.jobs'), value: jobs.length > 0 ? jobs.join(', ') : '—' }),
        record.gpuFreed !== undefined
          ? h(LabInfoRow, { label: t('ws.termination.gpuFreed'), value: flag(record.gpuFreed) })
          : null,
        record.verifiedClean !== undefined
          ? h(LabInfoRow, { label: t('ws.termination.verifiedClean'), value: flag(record.verifiedClean) })
          : null,
        leftover.length > 0
          ? h(
              'div',
              { className: 'rl-report-section' },
              h('h4', { className: 'rl-report-section-title' }, t('ws.termination.leftover')),
              h(
                'ul',
                { className: 'rl-report-list rl-report-blockers' },
                leftover.map((item, index) => h('li', { key: index }, item)),
              ),
            )
          : null,
        record.gcPostmortem !== null && typeof record.gcPostmortem === 'object'
          ? h(GcPanel, {
              postmortem: record.gcPostmortem,
              gcRunId: firstString(record.gcRunId),
              onOpenRun,
              t,
            })
          : null,
      );
    }

    /** Follow-up conversation summaries appended by `node.message` rounds. */
    function FollowUpsList({ followUps, t }) {
      return h(
        'div',
        { className: 'rl-followups' },
        followUps.map((entry, index) => {
          const record = asObject(entry);
          const head = firstString(record.headCommit);
          const user = firstString(record.user);
          const assistant = firstString(record.assistant);
          return h(
            'div',
            { key: index, className: 'rl-followup' },
            h(
              'div',
              { className: 'rl-followup-head' },
              h('span', null, formatDateTime(record.at, t)),
              head ? h('span', { className: 'rl-chip rl-chip-mono' }, shortCommit(head)) : null,
            ),
            user ? h('p', { className: 'rl-followup-user' }, user) : null,
            assistant ? h('p', { className: 'rl-followup-assistant' }, assistant) : null,
          );
        }),
      );
    }

    /** Stable identity of one transcript row (seq may repeat within a step). */
    function transcriptRowKey(row) {
      const record = asObject(row);
      try {
        return JSON.stringify([
          record.seq,
          record.kind,
          record.at,
          record.name,
          record.text,
          record.args,
          record.result,
          record.error,
        ]);
      } catch (error) {
        return String(record.seq) + ':' + String(record.kind);
      }
    }
    function transcriptKeyOf(row, index) {
      const seq = finiteNumber(asObject(row).seq);
      return seq === null ? 'transcript-row-' + index : 'transcript-row-' + seq;
    }
    function rowKindOf(row) {
      const kind = firstString(asObject(row).kind, asObject(row).type).toLowerCase();
      if (kind === 'user' || kind === 'assistant' || kind === 'tool' || kind === 'reasoning') return kind;
      if (kind === 'tool-result' || kind === 'tool_result' || kind === 'toolresult') return 'tool-result';
      return 'assistant';
    }
    function rowTextOf(row) {
      const record = asObject(row);
      return firstString(record.text, record.content, record.message);
    }
    function stringifyPayload(value) {
      if (value === null || value === undefined) return '';
      if (typeof value === 'string') return value;
      try {
        return JSON.stringify(value, null, 2);
      } catch (error) {
        return String(value);
      }
    }

    /** Remote GPU fleet editor (SSH + containers + NFS path maps). */
    function FleetEditor({ fleet, open, onToggle, onField, onMachine, onAddMachine, onRemoveMachine, onDevice, onAddDevice, onRemoveDevice, onPath, onAddPath, onRemovePath, onLabel, onAddLabel, onRemoveLabel, t }) {
      const pathRows = (listField, machineKey, rows, keyPrefix) =>
        h(
          'div',
          { className: 'rl-field' },
          h('span', { className: 'rl-label' }, t(listField === 'pathMap' ? 'ws.clusterConfig.fleet.pathMap' : 'ws.clusterConfig.fleet.machine.pathMap')),
          asArray(rows).length === 0 ? h('p', { className: 'rl-hint' }, keyPrefix) : null,
          asArray(rows).map((pair) => h(
            'div',
            { key: pair.key, className: 'rl-config-device-row' },
            h(LabInput, {
              value: pair.from,
              placeholder: t('ws.clusterConfig.fleet.pathMap.from'),
              ariaLabel: t('ws.clusterConfig.fleet.pathMap.from') + ' ' + pair.key,
              onChange: (event) => onPath(listField, machineKey, pair.key, 'from', event.target.value),
            }),
            h(LabInput, {
              value: pair.to,
              placeholder: t('ws.clusterConfig.fleet.pathMap.to'),
              ariaLabel: t('ws.clusterConfig.fleet.pathMap.to') + ' ' + pair.key,
              onChange: (event) => onPath(listField, machineKey, pair.key, 'to', event.target.value),
            }),
            h('div', { className: 'rl-reviewer-actions' },
              h(LabButton, {
                label: '✕',
                variant: 'ghost',
                title: t('ws.clusterConfig.fleet.pathMap.remove'),
                onClick: () => onRemovePath(listField, machineKey, pair.key),
              })),
          )),
          h('div', { className: 'rl-form-actions' },
            h(LabButton, {
              label: t('ws.clusterConfig.fleet.pathMap.add'),
              variant: 'ghost',
              onClick: () => onAddPath(listField, machineKey),
            })),
        );
      return h(
        'div',
        { className: 'rl-config-section' },
        h('h3', { className: 'rl-config-section-title' }, t('ws.clusterConfig.fleet.title')),
        h('p', { className: 'rl-hint' }, t('ws.clusterConfig.fleet.hint')),
        h(LabButton, {
          label: open ? t('ws.clusterConfig.fleet.hide') : t('ws.clusterConfig.fleet.show'),
          variant: 'ghost',
          onClick: onToggle,
        }),
        open
          ? h(
              'div',
              { className: 'rl-cluster-config' },
              h(
                'label',
                { className: 'rl-delete-option' },
                h('input', {
                  type: 'checkbox',
                  checked: fleet.enabled === true,
                  onChange: (event) => onField('enabled', event.target.checked === true),
                }),
                h('span', null, t('ws.clusterConfig.fleet.enabled')),
              ),
              h(
                'div',
                { className: 'rl-config-grid' },
                h(LabField, { label: t('ws.clusterConfig.fleet.placementMode') },
                  h(LabSelect, {
                    value: fleet.placementMode,
                    ariaLabel: t('ws.clusterConfig.fleet.placementMode'),
                    options: CLUSTER_FLEET_PLACEMENTS.map((mode) => ({ value: mode, label: t('ws.clusterConfig.fleet.placement.' + mode) })),
                    onChange: (event) => onField('placementMode', event.target.value),
                  })),
                h(LabField, { label: t('ws.clusterConfig.fleet.masterPort') },
                  h(LabInput, {
                    type: 'number',
                    value: fleet.masterPort,
                    ariaLabel: t('ws.clusterConfig.fleet.masterPort'),
                    onChange: (event) => onField('masterPort', event.target.value),
                  })),
              ),
              pathRows('pathMap', null, fleet.pathMap, t('ws.clusterConfig.fleet.pathMap')),
              h('h4', { className: 'rl-config-section-title' }, t('ws.clusterConfig.fleet.machines')),
              asArray(fleet.machines).length === 0
                ? h('p', { className: 'rl-hint' }, t('ws.clusterConfig.fleet.machines.empty'))
                : asArray(fleet.machines).map((machine) => h(
                    'div',
                    { key: machine.key, className: 'rl-config-section rl-config-machine' },
                    h(
                      'div',
                      { className: 'rl-config-machine-head' },
                      h('span', { className: 'rl-config-section-title' }, machine.machineId || t('ws.clusterConfig.fleet.machine.id')),
                      h(LabButton, {
                        label: '✕',
                        variant: 'ghost',
                        title: t('ws.clusterConfig.fleet.machine.remove'),
                        onClick: () => onRemoveMachine(machine.key),
                      }),
                    ),
                    h(
                      'div',
                      { className: 'rl-config-grid' },
                      h(LabField, { label: t('ws.clusterConfig.fleet.machine.id') },
                        h(LabInput, {
                          value: machine.machineId,
                          ariaLabel: t('ws.clusterConfig.fleet.machine.id') + ' ' + machine.key,
                          onChange: (event) => onMachine(machine.key, 'machineId', event.target.value),
                        })),
                      h(LabField, { label: t('ws.clusterConfig.fleet.ssh.host') },
                        h(LabInput, {
                          value: machine.sshHost,
                          ariaLabel: t('ws.clusterConfig.fleet.ssh.host') + ' ' + machine.key,
                          onChange: (event) => onMachine(machine.key, 'sshHost', event.target.value),
                        })),
                      h(LabField, { label: t('ws.clusterConfig.fleet.ssh.user') },
                        h(LabInput, {
                          value: machine.sshUser,
                          ariaLabel: t('ws.clusterConfig.fleet.ssh.user') + ' ' + machine.key,
                          onChange: (event) => onMachine(machine.key, 'sshUser', event.target.value),
                        })),
                      h(LabField, { label: t('ws.clusterConfig.fleet.ssh.port') },
                        h(LabInput, {
                          type: 'number',
                          value: machine.sshPort,
                          ariaLabel: t('ws.clusterConfig.fleet.ssh.port') + ' ' + machine.key,
                          onChange: (event) => onMachine(machine.key, 'sshPort', event.target.value),
                        })),
                      h(LabField, { label: t('ws.clusterConfig.fleet.ssh.keyPath') },
                        h(LabInput, {
                          value: machine.sshKeyPath,
                          ariaLabel: t('ws.clusterConfig.fleet.ssh.keyPath') + ' ' + machine.key,
                          onChange: (event) => onMachine(machine.key, 'sshKeyPath', event.target.value),
                        })),
                      h(LabField, { label: t('ws.clusterConfig.fleet.container.runtime') },
                        h(LabSelect, {
                          value: machine.containerRuntime,
                          ariaLabel: t('ws.clusterConfig.fleet.container.runtime') + ' ' + machine.key,
                          options: CLUSTER_FLEET_RUNTIMES.map((runtime) => ({ value: runtime, label: runtime })),
                          onChange: (event) => onMachine(machine.key, 'containerRuntime', event.target.value),
                        })),
                      h(LabField, { label: t('ws.clusterConfig.fleet.container.name') },
                        h(LabInput, {
                          value: machine.containerName,
                          ariaLabel: t('ws.clusterConfig.fleet.container.name') + ' ' + machine.key,
                          onChange: (event) => onMachine(machine.key, 'containerName', event.target.value),
                        })),
                      h(LabField, { label: t('ws.clusterConfig.fleet.container.workdir') },
                        h(LabInput, {
                          value: machine.containerWorkdir,
                          ariaLabel: t('ws.clusterConfig.fleet.container.workdir') + ' ' + machine.key,
                          onChange: (event) => onMachine(machine.key, 'containerWorkdir', event.target.value),
                        })),
                      h(LabField, { label: t('ws.clusterConfig.fleet.container.user') },
                        h(LabInput, {
                          value: machine.containerUser,
                          ariaLabel: t('ws.clusterConfig.fleet.container.user') + ' ' + machine.key,
                          onChange: (event) => onMachine(machine.key, 'containerUser', event.target.value),
                        })),
                    ),
                    h(LabField, { label: t('ws.clusterConfig.fleet.container.env') },
                      h(LabTextarea, {
                        value: machine.containerEnv,
                        rows: 2,
                        ariaLabel: t('ws.clusterConfig.fleet.container.env') + ' ' + machine.key,
                        onChange: (event) => onMachine(machine.key, 'containerEnv', event.target.value),
                      })),
                    h(LabField, { label: t('ws.clusterConfig.fleet.devices') },
                      h(LabSelect, {
                        value: machine.devicesMode,
                        ariaLabel: t('ws.clusterConfig.fleet.devices') + ' ' + machine.key,
                        options: [
                          { value: 'auto', label: t('ws.clusterConfig.fleet.devices.auto') },
                          { value: 'manual', label: t('ws.clusterConfig.fleet.devices.manual') },
                        ],
                        onChange: (event) => onMachine(machine.key, 'devicesMode', event.target.value),
                      })),
                    machine.devicesMode === 'manual'
                      ? h(
                          'div',
                          { className: 'rl-field' },
                          asArray(machine.devices).map((device, deviceIndex) => h(
                            'div',
                            { key: device.key, className: 'rl-config-device-row' },
                            h(LabInput, {
                              value: device.id,
                              placeholder: t('ws.clusterConfig.fleet.devices.id'),
                              ariaLabel: t('ws.clusterConfig.fleet.devices.id') + ' ' + machine.key + ' ' + String(deviceIndex + 1),
                              onChange: (event) => onDevice(machine.key, device.key, 'id', event.target.value),
                            }),
                            h(LabInput, {
                              value: device.localId,
                              placeholder: t('ws.clusterConfig.fleet.devices.localId'),
                              ariaLabel: t('ws.clusterConfig.fleet.devices.localId') + ' ' + machine.key + ' ' + String(deviceIndex + 1),
                              onChange: (event) => onDevice(machine.key, device.key, 'localId', event.target.value),
                            }),
                            h(LabInput, {
                              value: device.model,
                              placeholder: t('ws.clusterConfig.fleet.devices.model'),
                              ariaLabel: t('ws.clusterConfig.fleet.devices.model') + ' ' + machine.key + ' ' + String(deviceIndex + 1),
                              onChange: (event) => onDevice(machine.key, device.key, 'model', event.target.value),
                            }),
                            h(LabInput, {
                              type: 'number',
                              value: device.memoryMiB,
                              placeholder: t('ws.clusterConfig.fleet.devices.memory'),
                              ariaLabel: t('ws.clusterConfig.fleet.devices.memory') + ' ' + machine.key + ' ' + String(deviceIndex + 1),
                              onChange: (event) => onDevice(machine.key, device.key, 'memoryMiB', event.target.value),
                            }),
                            h('div', { className: 'rl-reviewer-actions' },
                              h(LabButton, {
                                label: '✕',
                                variant: 'ghost',
                                title: t('ws.clusterConfig.fleet.devices.remove'),
                                onClick: () => onRemoveDevice(machine.key, device.key),
                              })),
                          )),
                          h('div', { className: 'rl-form-actions' },
                            h(LabButton, {
                              label: t('ws.clusterConfig.fleet.devices.add'),
                              variant: 'ghost',
                              onClick: () => onAddDevice(machine.key),
                            })),
                        )
                      : null,
                    h('p', { className: 'rl-hint' }, t('ws.clusterConfig.fleet.machine.labelsHint')),
                    h(
                      'div',
                      { className: 'rl-field' },
                      h('span', { className: 'rl-label' }, t('ws.clusterConfig.fleet.machine.labels')),
                      asArray(machine.labels).map((labelRow) => h(
                        'div',
                        { key: labelRow.key, className: 'rl-config-device-row' },
                        h(LabInput, {
                          value: labelRow.name,
                          placeholder: t('ws.clusterConfig.fleet.machine.labels.key'),
                          ariaLabel: t('ws.clusterConfig.fleet.machine.labels.key') + ' ' + labelRow.key,
                          onChange: (event) => onLabel(machine.key, labelRow.key, 'name', event.target.value),
                        }),
                        h(LabInput, {
                          value: labelRow.value,
                          placeholder: t('ws.clusterConfig.fleet.machine.labels.value'),
                          ariaLabel: t('ws.clusterConfig.fleet.machine.labels.value') + ' ' + labelRow.key,
                          onChange: (event) => onLabel(machine.key, labelRow.key, 'value', event.target.value),
                        }),
                        h('div', { className: 'rl-reviewer-actions' },
                          h(LabButton, {
                            label: '✕',
                            variant: 'ghost',
                            title: t('ws.clusterConfig.fleet.machine.labels.remove'),
                            onClick: () => onRemoveLabel(machine.key, labelRow.key),
                          })),
                      )),
                      h('div', { className: 'rl-form-actions' },
                        h(LabButton, {
                          label: t('ws.clusterConfig.fleet.machine.labels.add'),
                          variant: 'ghost',
                          onClick: () => onAddLabel(machine.key),
                        })),
                    ),
                    h(LabButton, {
                      label: t('ws.clusterConfig.fleet.machine.advanced'),
                      variant: 'ghost',
                      onClick: () => onMachine(machine.key, 'advancedOpen', machine.advancedOpen !== true),
                    }),
                    machine.advancedOpen === true
                      ? h(
                          'div',
                          { className: 'rl-form-grid' },
                          h(LabField, { label: t('ws.clusterConfig.fleet.machine.masterAddr') },
                            h(LabInput, {
                              value: machine.masterAddr,
                              ariaLabel: t('ws.clusterConfig.fleet.machine.masterAddr') + ' ' + machine.key,
                              onChange: (event) => onMachine(machine.key, 'masterAddr', event.target.value),
                            })),
                          h(LabField, { label: t('ws.clusterConfig.fleet.ssh.command') },
                            h(LabInput, {
                              value: machine.sshCommand,
                              ariaLabel: t('ws.clusterConfig.fleet.ssh.command') + ' ' + machine.key,
                              onChange: (event) => onMachine(machine.key, 'sshCommand', event.target.value),
                            })),
                          h(LabField, { label: t('ws.clusterConfig.fleet.ssh.options') },
                            h(LabTextarea, {
                              value: machine.sshOptions,
                              rows: 2,
                              ariaLabel: t('ws.clusterConfig.fleet.ssh.options') + ' ' + machine.key,
                              onChange: (event) => onMachine(machine.key, 'sshOptions', event.target.value),
                            })),
                          pathRows('machinePathMap', machine.key, machine.pathMap, t('ws.clusterConfig.fleet.machine.pathMap')),
                        )
                      : null,
                  )),
              h('div', { className: 'rl-form-actions' },
                h(LabButton, {
                  label: t('ws.clusterConfig.fleet.machine.add'),
                  variant: 'ghost',
                  onClick: onAddMachine,
                })),
            )
          : null,
      );
    }

    /** GUI cluster configuration (coordinator/client); Host validates + hot-applies. */
    function ClusterConfigModal({ onClose, onApplied, t }) {
      const [attempt, setAttempt] = React.useState(0);
      const [state, setState] = React.useState({ phase: 'loading', payload: null, draft: null, error: '' });
      const [busy, setBusy] = React.useState('');
      const [reloading, setReloading] = React.useState(false);
      const [error, setError] = React.useState('');
      const [success, setSuccess] = React.useState('');
      const [copied, setCopied] = React.useState(false);
      const [advancedOpen, setAdvancedOpen] = React.useState(false);
      const [stopConfirm, setStopConfirm] = React.useState(false);
      const deviceSeqRef = React.useRef(1);
      const fleetSeqRef = React.useRef(1);
      const [fleetOpen, setFleetOpen] = React.useState(false);
      const payload = state.payload;
      const draft = state.draft;

      React.useEffect(() => {
        let alive = true;
        const controller = new AbortController();
        setReloading(true);
        api.fetchClusterConfig(controller.signal, t)
          .then((data) => {
            if (!alive) return;
            const parsed = clusterConfigPayloadOf(data);
            setState({ phase: 'ready', payload: parsed, draft: clusterConfigDraftOf(parsed), error: '' });
            setError('');
          })
          .catch((fetchError) => {
            if (!alive || isAbortError(fetchError)) return;
            setState((previous) => ({
              phase: previous.payload === null ? 'error' : 'ready',
              payload: previous.payload,
              draft: previous.draft,
              error: clusterConfigErrorTextOf(fetchError, t),
            }));
          })
          .finally(() => {
            if (alive) setReloading(false);
          });
        return () => {
          alive = false;
          controller.abort();
        };
      }, [attempt, t]); // eslint-disable-line react-hooks/exhaustive-deps

      React.useEffect(() => {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined;
        const onKeyDown = (event) => {
          if (event.key !== 'Escape' || busy !== '') return;
          onClose();
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
      }, [busy, onClose]);

      const setField = (field, value) => {
        setState((previous) => ({ ...previous, draft: Object.assign({}, previous.draft, { [field]: value }) }));
        setError('');
        setSuccess('');
      };
      const setDevice = (key, field, value) => {
        setState((previous) => ({
          ...previous,
          draft: Object.assign({}, previous.draft, {
            devices: asArray(previous.draft.devices).map((row) => (row.key === key ? Object.assign({}, row, { [field]: value }) : row)),
          }),
        }));
        setError('');
      };
      const addDevice = () => {
        deviceSeqRef.current += 1;
        setState((previous) => ({
          ...previous,
          draft: Object.assign({}, previous.draft, {
            devices: asArray(previous.draft.devices).concat([{
              key: 'cluster-device-' + deviceSeqRef.current,
              id: '',
              model: '',
              memoryMiB: '0',
            }]),
          }),
        }));
      };
      const removeDevice = (key) => {
        setState((previous) => ({
          ...previous,
          draft: Object.assign({}, previous.draft, {
            devices: asArray(previous.draft.devices).filter((row) => row.key !== key),
          }),
        }));
      };
      const setFleetField = (field, value) => {
        setState((previous) => ({
          ...previous,
          draft: Object.assign({}, previous.draft, {
            fleet: Object.assign({}, previous.draft.fleet, { [field]: value }),
          }),
        }));
        setError('');
        setSuccess('');
      };
      const setFleetMachine = (key, field, value) => {
        setState((previous) => ({
          ...previous,
          draft: Object.assign({}, previous.draft, {
            fleet: Object.assign({}, previous.draft.fleet, {
              machines: asArray(previous.draft.fleet.machines).map((row) => (row.key === key ? Object.assign({}, row, { [field]: value }) : row)),
            }),
          }),
        }));
        setError('');
      };
      const addFleetMachine = () => {
        fleetSeqRef.current += 1;
        setState((previous) => ({
          ...previous,
          draft: Object.assign({}, previous.draft, {
            fleet: Object.assign({}, previous.draft.fleet, {
              machines: asArray(previous.draft.fleet.machines).concat([{
                key: 'fleet-machine-' + fleetSeqRef.current,
                machineId: 'gpu-node-' + String(asArray(previous.draft.fleet.machines).length + 1),
                masterAddr: '',
                sshHost: '',
                sshUser: 'root',
                sshPort: '22',
                sshKeyPath: '',
                sshOptions: '',
                sshCommand: 'ssh',
                containerRuntime: 'docker',
                containerName: '',
                containerWorkdir: '',
                containerUser: '',
                containerEnv: '',
                devicesMode: 'auto',
                devices: [],
                pathMap: [],
                advancedOpen: false,
              }]),
            }),
          }),
        }));
        setError('');
        setSuccess('');
      };
      const removeFleetMachine = (key) => {
        setState((previous) => ({
          ...previous,
          draft: Object.assign({}, previous.draft, {
            fleet: Object.assign({}, previous.draft.fleet, {
              machines: asArray(previous.draft.fleet.machines).filter((row) => row.key !== key),
            }),
          }),
        }));
        setError('');
      };
      const setFleetMachineLabel = (machineKey, labelKey, field, value) => {
        setState((previous) => ({
          ...previous,
          draft: Object.assign({}, previous.draft, {
            fleet: Object.assign({}, previous.draft.fleet, {
              machines: asArray(previous.draft.fleet.machines).map((row) => (row.key === machineKey
                ? Object.assign({}, row, {
                    labels: asArray(row.labels).map((labelRow) => (labelRow.key === labelKey ? Object.assign({}, labelRow, { [field]: value }) : labelRow)),
                  })
                : row)),
            }),
          }),
        }));
        setError('');
      };
      const addFleetMachineLabel = (machineKey) => {
        fleetSeqRef.current += 1;
        setState((previous) => ({
          ...previous,
          draft: Object.assign({}, previous.draft, {
            fleet: Object.assign({}, previous.draft.fleet, {
              machines: asArray(previous.draft.fleet.machines).map((row) => (row.key === machineKey
                ? Object.assign({}, row, {
                    labels: asArray(row.labels).concat([{ key: 'fleet-machine-label-' + fleetSeqRef.current, name: '', value: '' }]),
                  })
                : row)),
            }),
          }),
        }));
      };
      const removeFleetMachineLabel = (machineKey, labelKey) => {
        setState((previous) => ({
          ...previous,
          draft: Object.assign({}, previous.draft, {
            fleet: Object.assign({}, previous.draft.fleet, {
              machines: asArray(previous.draft.fleet.machines).map((row) => (row.key === machineKey
                ? Object.assign({}, row, { labels: asArray(row.labels).filter((labelRow) => labelRow.key !== labelKey) })
                : row)),
            }),
          }),
        }));
      };
      const setFleetMachineDevice = (machineKey, deviceKey, field, value) => {
        setState((previous) => ({
          ...previous,
          draft: Object.assign({}, previous.draft, {
            fleet: Object.assign({}, previous.draft.fleet, {
              machines: asArray(previous.draft.fleet.machines).map((row) => (row.key === machineKey
                ? Object.assign({}, row, {
                    devices: asArray(row.devices).map((device) => (device.key === deviceKey ? Object.assign({}, device, { [field]: value }) : device)),
                  })
                : row)),
            }),
          }),
        }));
        setError('');
      };
      const addFleetMachineDevice = (machineKey) => {
        fleetSeqRef.current += 1;
        setState((previous) => ({
          ...previous,
          draft: Object.assign({}, previous.draft, {
            fleet: Object.assign({}, previous.draft.fleet, {
              machines: asArray(previous.draft.fleet.machines).map((row) => (row.key === machineKey
                ? Object.assign({}, row, {
                    devices: asArray(row.devices).concat([{
                      key: 'fleet-device-' + fleetSeqRef.current,
                      id: '',
                      localId: '',
                      model: '',
                      memoryMiB: '0',
                    }]),
                  })
                : row)),
            }),
          }),
        }));
      };
      const removeFleetMachineDevice = (machineKey, deviceKey) => {
        setState((previous) => ({
          ...previous,
          draft: Object.assign({}, previous.draft, {
            fleet: Object.assign({}, previous.draft.fleet, {
              machines: asArray(previous.draft.fleet.machines).map((row) => (row.key === machineKey
                ? Object.assign({}, row, { devices: asArray(row.devices).filter((device) => device.key !== deviceKey) })
                : row)),
            }),
          }),
        }));
      };
      const setFleetPath = (listField, machineKey, pairKey, field, value) => {
        setState((previous) => {
          const fleet = previous.draft.fleet;
          const updateRows = (rows) => asArray(rows).map((pair) => (pair.key === pairKey ? Object.assign({}, pair, { [field]: value }) : pair));
          if (listField === 'pathMap') {
            return { ...previous, draft: Object.assign({}, previous.draft, { fleet: Object.assign({}, fleet, { pathMap: updateRows(fleet.pathMap) }) }) };
          }
          return {
            ...previous,
            draft: Object.assign({}, previous.draft, {
              fleet: Object.assign({}, fleet, {
                machines: asArray(fleet.machines).map((row) => (row.key === machineKey
                  ? Object.assign({}, row, { pathMap: updateRows(row.pathMap) })
                  : row)),
              }),
            }),
          };
        });
        setError('');
      };
      const addFleetPath = (listField, machineKey) => {
        fleetSeqRef.current += 1;
        const pair = { key: 'fleet-path-' + fleetSeqRef.current, from: '', to: '' };
        setState((previous) => {
          const fleet = previous.draft.fleet;
          if (listField === 'pathMap') {
            return { ...previous, draft: Object.assign({}, previous.draft, { fleet: Object.assign({}, fleet, { pathMap: asArray(fleet.pathMap).concat([pair]) }) }) };
          }
          return {
            ...previous,
            draft: Object.assign({}, previous.draft, {
              fleet: Object.assign({}, fleet, {
                machines: asArray(fleet.machines).map((row) => (row.key === machineKey
                  ? Object.assign({}, row, { pathMap: asArray(row.pathMap).concat([pair]) })
                  : row)),
              }),
            }),
          };
        });
      };
      const removeFleetPath = (listField, machineKey, pairKey) => {
        setState((previous) => {
          const fleet = previous.draft.fleet;
          if (listField === 'pathMap') {
            return { ...previous, draft: Object.assign({}, previous.draft, { fleet: Object.assign({}, fleet, { pathMap: asArray(fleet.pathMap).filter((pair) => pair.key !== pairKey) }) }) };
          }
          return {
            ...previous,
            draft: Object.assign({}, previous.draft, {
              fleet: Object.assign({}, fleet, {
                machines: asArray(fleet.machines).map((row) => (row.key === machineKey
                  ? Object.assign({}, row, { pathMap: asArray(row.pathMap).filter((pair) => pair.key !== pairKey) })
                  : row)),
              }),
            }),
          };
        });
      };

      const applyServerPayload = (parsed) => {
        setState({ phase: 'ready', payload: parsed, draft: clusterConfigDraftOf(parsed), error: '' });
        setSuccess(t('ws.clusterConfig.saved'));
        setCopied(false);
        if (typeof onApplied === 'function') onApplied(parsed);
      };
      const save = async () => {
        if (busy !== '' || payload === null || draft === null || payload.canApply === false) return;
        const built = clusterConfigPatchOf(draft, payload, t);
        if (built.error !== '') {
          setError(built.error);
          return;
        }
        const patch = built.patch;
        if (Object.keys(patch).length === 0) {
          setSuccess(t('ws.clusterConfig.noChanges'));
          setError('');
          return;
        }
        setBusy('save');
        setError('');
        setSuccess('');
        try {
          const data = await api.command({ type: 'cluster.config', config: patch }, undefined, t);
          applyServerPayload(clusterConfigPayloadOf(data));
        } catch (saveError) {
          if (isAbortError(saveError)) return;
          setError(clusterConfigErrorTextOf(saveError, t));
        } finally {
          setBusy('');
        }
      };
      const stopCluster = async () => {
        if (busy !== '') return;
        setBusy('stop');
        setError('');
        setSuccess('');
        try {
          const data = await api.command({ type: 'cluster.config', config: { enabled: false } }, undefined, t);
          applyServerPayload(clusterConfigPayloadOf(data));
          setStopConfirm(false);
        } catch (stopError) {
          if (isAbortError(stopError)) return;
          setError(clusterConfigErrorTextOf(stopError, t));
        } finally {
          setBusy('');
        }
      };
      const reload = () => {
        if (busy !== '') return;
        setError('');
        setSuccess('');
        setAttempt((value) => value + 1);
      };
      const status = asObject(payload === null ? null : payload.status);
      const dashboardUrl = clusterConfigStatusUrlOf(status);
      const copyUrl = async () => {
        const target = dashboardUrl || (draft === null ? '' : clusterConfigTrimmed(draft.url));
        const didCopy = await copyTextToClipboard(target);
        setCopied(didCopy);
        if (!didCopy) setError(t('ws.clusterConfig.action.copyFailed'));
        else setSuccess('');
      };
      const openDashboard = () => {
        if (dashboardUrl === '' || (payload !== null && payload.config.dashboard === false)) {
          setError(t('ws.clusterConfig.dashboardUnavailable'));
          return;
        }
        try {
          if (typeof window !== 'undefined' && typeof window.open === 'function') window.open(dashboardUrl, '_blank');
          else setError(t('ws.clusterConfig.dashboardUnavailable'));
        } catch (openError) {
          setError(t('ws.clusterConfig.dashboardUnavailable'));
        }
      };

      let body;
      if (state.phase === 'loading' && payload === null) {
        body = h(LabLoading, { label: t('ws.clusterConfig.loading') });
      } else if (state.phase === 'error' && payload === null) {
        body = h(
          'div',
          { className: 'rl-field' },
          h('p', { className: 'rl-error-text', role: 'alert' }, t('ws.clusterConfig.loadError') + ': ' + (state.error || t('error.unknown'))),
          h(LabButton, { label: t('common.retry'), variant: 'ghost', onClick: reload }),
        );
      } else {
        body = h(
          'div',
          { className: 'rl-cluster-config' },
          h(
            'div',
            { className: 'rl-config-status' },
            h('h3', { className: 'rl-config-section-title' }, t('ws.clusterConfig.status.title')),
            h('p', { className: 'rl-hint' }, t('ws.cluster.twoLayerNote')),
            payload.path !== ''
              ? h(LabInfoRow, { label: t('ws.clusterConfig.status.path'), value: payload.path, mono: true })
              : null,
            h(LabInfoRow, {
              label: t('ws.clusterConfig.status.enabled'),
              value: payload.config.enabled ? '✓' : '—',
            }),
            h(LabInfoRow, { label: t('ws.clusterConfig.status.mode'), value: t('ws.cluster.mode.' + clusterModeOf(status)) }),
            h(LabInfoRow, {
              label: t('ws.clusterConfig.status.connected'),
              value: status.connected === true ? '✓' : '—',
            }),
            status.blocked === true ? h(LabInfoRow, { label: t('ws.clusterConfig.status.blocked'), value: '⚠' }) : null,
            firstString(status.claimConflictUrl, status.claimConflict)
              ? h(LabInfoRow, {
                  label: t('ws.clusterConfig.status.claimConflict'),
                  value: firstString(status.claimConflictUrl, asObject(status.claimConflict).coordinatorUrl, JSON.stringify(asObject(status.claimConflict))),
                  mono: true,
                })
              : null,
            firstString(status.error) ? h(LabInfoRow, { label: t('ws.clusterConfig.status.error'), value: firstString(status.error) }) : null,
            firstString(status.clusterId) || payload.config.clusterId
              ? h(LabInfoRow, { label: t('ws.clusterConfig.status.clusterId'), value: firstString(status.clusterId) || payload.config.clusterId, mono: true })
              : null,
            firstString(status.coordinatorId)
              ? h(LabInfoRow, { label: t('ws.clusterConfig.status.coordinatorId'), value: firstString(status.coordinatorId), mono: true })
              : null,
            dashboardUrl !== ''
              ? h(LabInfoRow, { label: t('ws.clusterConfig.status.url'), value: dashboardUrl, mono: true })
              : null,
            h(LabInfoRow, { label: t('ws.clusterConfig.status.machines'), value: clusterConfigMachinesSummaryOf(status, t) }),
            Object.keys(clusterPoolsOf(status)).length > 0
              ? h(LabInfoRow, { label: t('ws.clusterConfig.status.pools'), value: clusterPoolSummaryTextOf(status, t) })
              : null,
            payload.activeLeases > 0
              ? h('p', { className: 'rl-hint rl-merge-conflicts' }, t('ws.clusterConfig.status.activeLeases', { count: payload.activeLeases }))
              : null,
            payload.warnings.length > 0
              ? h(
                  'div',
                  { className: 'rl-report-section' },
                  h('h4', { className: 'rl-report-section-title' }, t('ws.clusterConfig.status.warnings')),
                  h('ul', { className: 'rl-config-warning' }, payload.warnings.map((warning, index) => h('li', { key: index }, warning))),
                )
              : null,
          ),
          h(
            'div',
            { className: 'rl-config-section' },
            h('h3', { className: 'rl-config-section-title' }, t('ws.clusterConfig.section.basic')),
            h(
              'label',
              { className: 'rl-delete-option' },
              h('input', {
                type: 'checkbox',
                checked: draft.enabled === true,
                onChange: (event) => setField('enabled', event.target.checked === true),
              }),
              h('span', null, t('ws.clusterConfig.enabled')),
            ),
            h('p', { className: 'rl-hint' }, t('ws.clusterConfig.enabledHint')),
            h(
              'div',
              { className: 'rl-config-grid' },
              h(LabField, { label: t('ws.clusterConfig.role'), hint: t('ws.clusterConfig.roleHint') },
                h(LabSelect, {
                  value: draft.role,
                  ariaLabel: t('ws.clusterConfig.role'),
                  options: CLUSTER_CONFIG_ROLES.map((role) => ({ value: role, label: t('ws.clusterConfig.role.' + role) })),
                  onChange: (event) => setField('role', event.target.value),
                })),
              h(LabField, { label: t('ws.clusterConfig.clusterId') },
                h(LabInput, {
                  value: draft.clusterId,
                  ariaLabel: t('ws.clusterConfig.clusterId'),
                  onChange: (event) => setField('clusterId', event.target.value),
                })),
              h(LabField, { label: t('ws.clusterConfig.machineId') },
                h(LabInput, {
                  value: draft.machineId,
                  ariaLabel: t('ws.clusterConfig.machineId'),
                  placeholder: firstString(status.machineId),
                  onChange: (event) => setField('machineId', event.target.value),
                })),
              h(LabField, { label: t('ws.clusterConfig.userId') },
                h(LabInput, {
                  value: draft.userId,
                  ariaLabel: t('ws.clusterConfig.userId'),
                  onChange: (event) => setField('userId', event.target.value),
                })),
              h(LabField, { label: t('ws.clusterConfig.priority') },
                h(LabInput, {
                  type: 'number',
                  value: draft.priority,
                  ariaLabel: t('ws.clusterConfig.priority'),
                  onChange: (event) => setField('priority', event.target.value),
                })),
            ),
          ),
          h(
            'div',
            { className: 'rl-config-section' },
            h('h3', { className: 'rl-config-section-title' }, t('ws.clusterConfig.section.token')),
            h(
              'div',
              { className: 'rl-config-token-row' },
              h(LabField, {
                label: t('ws.clusterConfig.token'),
                hint: payload.config.tokenSet ? t('ws.clusterConfig.token.setHint') : t('ws.clusterConfig.token.emptyHint'),
              },
                h(LabInput, {
                  type: 'password',
                  value: draft.tokenInput,
                  ariaLabel: t('ws.clusterConfig.token'),
                  disabled: draft.tokenClear === true,
                  placeholder: payload.config.tokenSet ? payload.config.tokenMasked : '',
                  onChange: (event) => setField('tokenInput', event.target.value),
                })),
              payload.config.tokenSet
                ? h(LabButton, {
                    label: draft.tokenClear === true ? t('ws.clusterConfig.token.undoClear') : t('ws.clusterConfig.token.clear'),
                    variant: 'ghost',
                    onClick: () => setField('tokenClear', draft.tokenClear !== true),
                  })
                : null,
            ),
            draft.tokenClear === true ? h('p', { className: 'rl-hint' }, t('ws.clusterConfig.token.cleared')) : null,
            h('p', { className: 'rl-hint' }, t('ws.clusterConfig.token.copyHint')),
          ),
          h(
            'div',
            { className: 'rl-config-section' },
            h('h3', { className: 'rl-config-section-title' }, t('ws.clusterConfig.section.timing')),
            h(
              'div',
              { className: 'rl-config-grid' },
              h(LabField, { label: t('ws.clusterConfig.heartbeat') },
                h(LabInput, {
                  type: 'number',
                  value: draft.heartbeatSeconds,
                  ariaLabel: t('ws.clusterConfig.heartbeat'),
                  onChange: (event) => setField('heartbeatSeconds', event.target.value),
                })),
              h(LabField, { label: t('ws.clusterConfig.leaseTtl') },
                h(LabInput, {
                  type: 'number',
                  value: draft.leaseTtlMinutes,
                  ariaLabel: t('ws.clusterConfig.leaseTtl'),
                  onChange: (event) => setField('leaseTtlMinutes', event.target.value),
                })),
            ),
          ),
          h(
            'div',
            { className: 'rl-config-section' },
            h('h3', { className: 'rl-config-section-title' }, t('ws.clusterConfig.section.devices')),
            h(LabField, { label: t('ws.clusterConfig.devices.mode') },
              h(LabSelect, {
                value: draft.devicesMode,
                ariaLabel: t('ws.clusterConfig.devices.mode'),
                options: [
                  { value: 'auto', label: t('ws.clusterConfig.devices.auto') },
                  { value: 'manual', label: t('ws.clusterConfig.devices.manual') },
                ],
                onChange: (event) => setField('devicesMode', event.target.value),
              })),
            draft.devicesMode === 'manual'
              ? h(
                  'div',
                  { className: 'rl-field' },
                  draft.devices.length === 0 ? h('p', { className: 'rl-hint' }, t('ws.clusterConfig.devices.empty')) : null,
                  draft.devices.map((row, index) => h(
                    'div',
                    { key: row.key, className: 'rl-config-device-row' },
                    h(LabInput, {
                      value: row.id,
                      placeholder: t('ws.clusterConfig.devices.id'),
                      ariaLabel: t('ws.clusterConfig.devices.id') + ' ' + String(index + 1),
                      onChange: (event) => setDevice(row.key, 'id', event.target.value),
                    }),
                    h(LabInput, {
                      value: row.model,
                      placeholder: t('ws.clusterConfig.devices.model'),
                      ariaLabel: t('ws.clusterConfig.devices.model') + ' ' + String(index + 1),
                      onChange: (event) => setDevice(row.key, 'model', event.target.value),
                    }),
                    h(LabInput, {
                      type: 'number',
                      value: row.memoryMiB,
                      placeholder: t('ws.clusterConfig.devices.memory'),
                      ariaLabel: t('ws.clusterConfig.devices.memory') + ' ' + String(index + 1),
                      onChange: (event) => setDevice(row.key, 'memoryMiB', event.target.value),
                    }),
                    h('div', { className: 'rl-reviewer-actions' },
                      h(LabButton, {
                        label: '✕',
                        variant: 'ghost',
                        title: t('ws.clusterConfig.devices.remove'),
                        onClick: () => removeDevice(row.key),
                      })),
                  )),
                  h('div', { className: 'rl-form-actions' },
                    h(LabButton, { label: t('ws.clusterConfig.devices.add'), variant: 'ghost', onClick: addDevice })),
                )
              : null,
          ),
          h(FleetEditor, {
            fleet: draft.fleet,
            open: fleetOpen,
            onToggle: () => setFleetOpen((value) => !value),
            onField: setFleetField,
            onMachine: setFleetMachine,
            onAddMachine: addFleetMachine,
            onRemoveMachine: removeFleetMachine,
            onDevice: setFleetMachineDevice,
            onAddDevice: addFleetMachineDevice,
            onRemoveDevice: removeFleetMachineDevice,
            onPath: setFleetPath,
            onAddPath: addFleetPath,
            onRemovePath: removeFleetPath,
            onLabel: setFleetMachineLabel,
            onAddLabel: addFleetMachineLabel,
            onRemoveLabel: removeFleetMachineLabel,
            t,
          }),
          h(
            'div',
            { className: 'rl-config-section' },
            h('h3', { className: 'rl-config-section-title' }, t('ws.clusterConfig.section.options')),
            h(
              'div',
              { className: 'rl-config-check-row' },
              h(
                'label',
                { className: 'rl-delete-option' },
                h('input', {
                  type: 'checkbox',
                  checked: draft.dashboard === true,
                  onChange: (event) => setField('dashboard', event.target.checked === true),
                }),
                h('span', null, t('ws.clusterConfig.dashboard')),
              ),
              h(
                'label',
                { className: 'rl-delete-option' },
                h('input', {
                  type: 'checkbox',
                  checked: draft.allowMultipleCoordinators === true,
                  onChange: (event) => setField('allowMultipleCoordinators', event.target.checked === true),
                }),
                h('span', null, t('ws.clusterConfig.allowMultipleCoordinators')),
              ),
            ),
            h(LabButton, {
              label: advancedOpen ? t('ws.clusterConfig.advanced.hide') : t('ws.clusterConfig.advanced.show'),
              variant: 'ghost',
              onClick: () => setAdvancedOpen((value) => !value),
            }),
            advancedOpen
              ? h(
                  'div',
                  { className: 'rl-form-grid' },
                  h('p', { className: 'rl-hint' }, t('ws.clusterConfig.advanced.hint')),
                  h(
                    'div',
                    { className: 'rl-config-grid' },
                    h(LabField, { label: t('ws.clusterConfig.instanceId') },
                      h(LabInput, {
                        value: draft.instanceId,
                        ariaLabel: t('ws.clusterConfig.instanceId'),
                        onChange: (event) => setField('instanceId', event.target.value),
                      })),
                    h(LabField, { label: t('ws.clusterConfig.coordinatorId') },
                      h(LabInput, {
                        value: draft.coordinatorId,
                        ariaLabel: t('ws.clusterConfig.coordinatorId'),
                        onChange: (event) => setField('coordinatorId', event.target.value),
                      })),
                  ),
                  h(LabField, { label: t('ws.clusterConfig.url'), hint: t('ws.clusterConfig.urlHint', { example: 'http://127.0.0.1:8791' }) },
                    h(LabInput, {
                      value: draft.url,
                      ariaLabel: t('ws.clusterConfig.url'),
                      onChange: (event) => setField('url', event.target.value),
                    })),
                  h(
                    'div',
                    { className: 'rl-config-grid' },
                    h(LabField, { label: t('ws.clusterConfig.listenHost') },
                      h(LabInput, {
                        value: draft.listenHost,
                        ariaLabel: t('ws.clusterConfig.listenHost'),
                        onChange: (event) => setField('listenHost', event.target.value),
                      })),
                    h(LabField, { label: t('ws.clusterConfig.listenPort') },
                      h(LabInput, {
                        type: 'number',
                        value: draft.listenPort,
                        ariaLabel: t('ws.clusterConfig.listenPort'),
                        onChange: (event) => setField('listenPort', event.target.value),
                      })),
                  ),
                  h(
                    'div',
                    { className: 'rl-config-grid' },
                    h(LabField, { label: t('ws.clusterConfig.claimDir') },
                      h(LabInput, {
                        value: draft.claimDir,
                        ariaLabel: t('ws.clusterConfig.claimDir'),
                        onChange: (event) => setField('claimDir', event.target.value),
                      })),
                    h(LabField, { label: t('ws.clusterConfig.stateFile') },
                      h(LabInput, {
                        value: draft.stateFile,
                        ariaLabel: t('ws.clusterConfig.stateFile'),
                        onChange: (event) => setField('stateFile', event.target.value),
                      })),
                  ),
                )
              : null,
          ),
          error !== '' ? h('p', { className: 'rl-error-text', role: 'alert' }, error) : null,
          success !== '' ? h('p', { className: 'rl-config-success', role: 'status' }, success + ' · ' + t('ws.clusterConfig.appliedNote')) : null,
          payload.canApply === false
            ? h('p', { className: 'rl-hint' }, t('ws.clusterConfig.canApplyFalse'))
            : null,
          stopConfirm
            ? h(
                'div',
                { className: 'rl-merge-panel' },
                h('p', { className: 'rl-merge-title' }, t('ws.clusterConfig.action.stopConfirm')),
                h(
                  'div',
                  { className: 'rl-form-actions' },
                  h(LabButton, {
                    label: busy === 'stop' ? t('ws.clusterConfig.closing') : t('ws.clusterConfig.action.stopConfirmYes'),
                    variant: 'primary',
                    disabled: busy !== '',
                    onClick: stopCluster,
                  }),
                  h(LabButton, {
                    label: t('ws.clusterConfig.action.stopCancel'),
                    disabled: busy !== '',
                    onClick: () => setStopConfirm(false),
                  }),
                ),
              )
            : null,
          h(
            'div',
            { className: 'rl-config-actions' },
            h(LabButton, {
              label: busy === 'save' ? t('ws.clusterConfig.saving') : t('ws.clusterConfig.save'),
              variant: 'primary',
              disabled: busy !== '' || payload.canApply === false,
              onClick: save,
            }),
            h(LabButton, {
              label: t('ws.clusterConfig.action.stopCluster'),
              variant: 'ghost',
              disabled: busy !== '',
              onClick: () => setStopConfirm(true),
            }),
            h(LabButton, {
              label: reloading ? t('ws.clusterConfig.reloading') : t('ws.clusterConfig.reload'),
              variant: 'ghost',
              disabled: busy !== '' || reloading,
              onClick: reload,
            }),
            h(LabButton, {
              label: t('ws.clusterConfig.action.dashboard'),
              variant: 'ghost',
              disabled: dashboardUrl === '',
              onClick: openDashboard,
            }),
            h(LabButton, {
              label: copied ? t('ws.clusterConfig.action.copied') : t('ws.clusterConfig.action.copyUrl'),
              variant: 'ghost',
              disabled: dashboardUrl === '',
              onClick: copyUrl,
            }),
            h('span', { className: 'rl-config-actions-meta' }, payload.path),
          ),
        );
      }
      return h(
        'div',
        { className: 'rl-overlay-layer rl-overlay-layer-top' },
        h(
          'div',
          { className: 'rl-modal', role: 'dialog', 'aria-label': t('ws.clusterConfig.title') },
          h(
            'div',
            { className: 'rl-modal-head' },
            h('h2', { className: 'rl-modal-title' }, t('ws.clusterConfig.title')),
            h(LabButton, { label: '✕', variant: 'ghost', title: t('ws.clusterConfig.close'), disabled: busy !== '', onClick: onClose }),
          ),
          h('div', { className: 'rl-modal-body' }, body),
        ),
      );
    }

    /** Top-bar cluster chip: mode, GPU free/total and queue length. */
    function ClusterChip({ cluster, onOpen, t }) {
      if (!clusterEnabledOf(cluster)) return null;
      const pools = clusterPoolsOf(cluster);
      const gpu = asObject(pools.gpu);
      const free = Math.round(numberOr(gpu.free, 0));
      const total = Math.round(numberOr(gpu.total, 0));
      const queue = clusterQueueOf(cluster).length;
      return h(
        'button',
        { type: 'button', className: 'rl-chip rl-cluster-chip', title: t('ws.cluster.title'), onClick: onOpen },
        t('ws.cluster.chip', { mode: t('ws.cluster.mode.' + clusterModeOf(cluster)), free, total, queue }),
      );
    }

    /** Cluster coordinator panel: machines, devices, leases, queue and usage. */
    function ClusterModal({ projectId, onClose, onOpenConfig, t }) {
      const { state, refresh } = useCluster(projectId, t, true);
      const cluster = asObject(state.cluster);
      const machines = clusterMachinesOf(cluster);
      const leases = clusterLeasesOf(cluster);
      const queue = clusterQueueOf(cluster);
      const fleet = asObject(asObject(cluster).fleet);
      const fleetMachines = asArray(fleet.machines).filter((machine) => machine !== null && typeof machine === 'object');
      const pools = clusterPoolsOf(cluster);
      const poolKeys = Object.keys(pools);
      let body;
      if (state.phase === 'loading' && state.cluster === null) {
        body = h(LabLoading, { label: t('ws.cluster.loading') });
      } else {
        body = h(
          'div',
          { className: 'rl-cluster-body' },
          h('p', { className: 'rl-hint' }, t('ws.cluster.twoLayerNote')),
          state.error !== '' ? h('p', { className: 'rl-error-text', role: 'alert' }, t('ws.cluster.error') + ': ' + state.error) : null,
          clusterEnabledOf(cluster)
            ? h(
                'div',
                { className: 'rl-report-section' },
                h(LabInfoRow, { label: t('ws.cluster.mode'), value: t('ws.cluster.mode.' + clusterModeOf(cluster)) }),
                h(LabInfoRow, { label: t('ws.cluster.instance'), value: firstString(cluster.instanceId) || '—', mono: true }),
                h(LabInfoRow, { label: t('ws.cluster.machine'), value: firstString(cluster.machineId) || '—', mono: true }),
                h(LabInfoRow, { label: t('ws.cluster.connected'), value: cluster.connected === true ? '✓' : '—' }),
                firstString(cluster.coordinatorUrl)
                  ? h(LabInfoRow, { label: t('ws.cluster.coordinator'), value: firstString(cluster.coordinatorUrl), mono: true })
                  : null,
                finiteNumber(cluster.heartbeatAt) !== null
                  ? h(LabInfoRow, { label: t('ws.cluster.heartbeat'), value: formatDateTime(cluster.heartbeatAt, t) })
                  : null,
              )
            : h('p', { className: 'rl-hint' }, t('ws.cluster.disabled')),
          firstString(cluster.error) ? h('p', { className: 'rl-error-text', role: 'alert' }, firstString(cluster.error)) : null,
          poolKeys.length > 0
            ? h(
                'div',
                { className: 'rl-report-section' },
                h('h4', { className: 'rl-report-section-title' }, t('ws.cluster.pools')),
                poolKeys.map((key) => h(
                  'p',
                  { key, className: 'rl-cluster-line' },
                  t('ws.cluster.poolRow', {
                    pool: key,
                    used: Math.round(numberOr(asObject(pools[key]).used, 0)),
                    total: Math.round(numberOr(asObject(pools[key]).total, 0)),
                    free: Math.round(numberOr(asObject(pools[key]).free, 0)),
                  }),
                )),
              )
            : null,
          h(
            'div',
            { className: 'rl-report-section' },
            h('h4', { className: 'rl-report-section-title' }, t('ws.cluster.machines')),
            machines.length === 0
              ? h('p', { className: 'rl-hint' }, t('ws.cluster.empty'))
              : machines.map((machine, index) => h(
                  'div',
                  { key: firstString(machine.machineId) || 'machine-' + index, className: 'rl-cluster-card' },
                  h('p', { className: 'rl-cluster-line rl-cluster-mono' }, firstString(machine.machineId) || '—'),
                  asArray(machine.devices).map((device, deviceIndex) => h(
                    'p',
                    { key: deviceIndex, className: 'rl-cluster-line' },
                    t('ws.cluster.devices') + ': ' + firstString(device.id) + ' · ' + firstString(device.model)
                      + (finiteNumber(device.memoryMiB) !== null ? ' · ' + t('ws.cluster.memory', { memory: Math.round(numberOr(device.memoryMiB, 0)) }) : ''),
                  )),
                  finiteNumber(machine.lastHeartbeatAt) !== null
                    ? h('p', { className: 'rl-cluster-line rl-hint' }, t('ws.cluster.heartbeat') + ': ' + formatDateTime(machine.lastHeartbeatAt, t))
                    : null,
                )),
          ),
          h(
            'div',
            { className: 'rl-report-section' },
            h('h4', { className: 'rl-report-section-title' }, t('ws.cluster.leases')),
            leases.length === 0
              ? h('p', { className: 'rl-hint' }, t('ws.cluster.empty'))
              : leases.map((lease, index) => h(
                  'div',
                  { key: firstString(lease.leaseId) || 'lease-' + index, className: 'rl-cluster-card' },
                  h('p', { className: 'rl-cluster-line rl-cluster-mono' }, t('ws.cluster.leaseNode') + ': ' + (firstString(lease.nodeId) || '—')),
                  h('p', { className: 'rl-cluster-line' }, t('ws.cluster.leaseMachine', { machine: firstString(lease.machineId) || '—' })),
                  h('p', { className: 'rl-cluster-line' }, t('ws.cluster.leaseDevices', { devices: stringListOf(lease.deviceIds).join(', ') || '—' })),
                  finiteNumber(lease.expiresAt) !== null
                    ? h('p', { className: 'rl-cluster-line rl-hint' }, t('ws.cluster.leaseExpires', { time: formatDateTime(lease.expiresAt, t) }))
                    : null,
                )),
          ),
          h(
            'div',
            { className: 'rl-report-section' },
            h('h4', { className: 'rl-report-section-title' }, t('ws.cluster.queueTitle')),
            queue.length === 0
              ? h('p', { className: 'rl-hint' }, t('ws.cluster.empty'))
              : queue.map((entry, index) => h(
                  'p',
                  { key: firstString(entry.requestId) || 'queue-' + index, className: 'rl-cluster-line' },
                  '#' + String(numberOr(entry.position, index + 1)) + ' · '
                    + t('ws.cluster.queueNode') + ': ' + (firstString(entry.nodeId) || '—') + ' · '
                    + t('ws.cluster.queueAmount') + ': ' + String(numberOr(entry.amount, 0)) + ' · '
                    + (firstString(entry.machineId) || '—'),
                )),
          ),
          fleet.enabled === true
            ? h(
                'div',
                { className: 'rl-report-section' },
                h('h4', { className: 'rl-report-section-title' }, t('ws.cluster.fleet.title')),
                h(LabInfoRow, {
                  label: t('ws.cluster.fleet.placement'),
                  value: t('ws.clusterConfig.fleet.placement.' + (CLUSTER_FLEET_PLACEMENTS.indexOf(firstString(fleet.placementMode)) >= 0 ? firstString(fleet.placementMode) : 'local')),
                }),
                fleetMachines.length === 0
                  ? h('p', { className: 'rl-hint' }, t('ws.cluster.fleet.empty'))
                  : fleetMachines.map((machine, index) => {
                      const container = asObject(machine.container);
                      const devices = asArray(machine.devices);
                      const errorText = firstString(machine.error);
                      return h(
                        'div',
                        { key: firstString(machine.machineId) || 'fleet-' + index, className: 'rl-cluster-card' },
                        h('p', { className: 'rl-cluster-line rl-cluster-mono' }, t('ws.cluster.fleet.machine') + ': ' + (firstString(machine.machineId) || '—')),
                        h('p', { className: 'rl-cluster-line' }, t('ws.cluster.fleet.ssh') + ': ' + (firstString(machine.sshHost) || '—') + (firstString(machine.sshUser) ? '@' + firstString(machine.sshUser) : '')),
                        h('p', { className: 'rl-cluster-line' }, t('ws.cluster.fleet.container') + ': ' + firstString(container.runtime) + (firstString(container.name) ? ' / ' + firstString(container.name) : '')),
                        h('p', { className: 'rl-cluster-line' }, t('ws.cluster.fleet.devices') + ': ' + (devices.length > 0 ? devices.map((device) => firstString(device.id) + (firstString(device.model) ? ' (' + firstString(device.model) + ')' : '')).join(', ') : '—')),
                        h(
                          'div',
                          { className: 'rl-project-chips' },
                          h('span', { className: 'rl-hint' }, t('ws.cluster.fleet.labels') + ':'),
                          asArray(fleetLabelChipsOf(machine.labels)).length === 0
                            ? h('span', { className: 'rl-hint' }, t('ws.fleet.noLabels'))
                            : fleetLabelChipsOf(machine.labels).map((labelChip) => h(
                                'span',
                                { key: labelChip.key, className: 'rl-chip rl-chip-mono' },
                                labelChip.text,
                              )),
                        ),
                        h('p', { className: 'rl-cluster-line ' + (errorText === '' ? 'rl-hint' : 'rl-cluster-mono') },
                          t('ws.cluster.fleet.status') + ': ' + (errorText === '' ? t('ws.cluster.fleet.online') : t('ws.cluster.fleet.offline') + ' — ' + errorText)),
                      );
                    }),
              )
            : null,
          h(JsonBlock, { title: t('ws.cluster.usage'), value: asObject(cluster.usage) }),
        );
      }
      return h(
        'div',
        { className: 'rl-overlay-layer rl-overlay-layer-top' },
        h(
          'div',
          { className: 'rl-modal', role: 'dialog', 'aria-label': t('ws.cluster.title') },
          h(
            'div',
            { className: 'rl-modal-head' },
            h('h2', { className: 'rl-modal-title' }, t('ws.cluster.title')),
            typeof onOpenConfig === 'function'
              ? h(LabButton, { label: t('ws.clusterConfig.title'), variant: 'ghost', onClick: onOpenConfig })
              : null,
            h(LabButton, {
              label: state.phase === 'loading' ? t('ws.cluster.refreshing') : t('ws.cluster.refresh'),
              variant: 'ghost',
              disabled: state.phase === 'loading',
              onClick: refresh,
            }),
            h(LabButton, { label: '✕', variant: 'ghost', title: t('ws.cluster.close'), onClick: onClose }),
          ),
          h('div', { className: 'rl-modal-body' }, body),
        ),
      );
    }

    /** Per-node attempt timeline with tokens and cost. */
    function AttemptsPanel({ node, t }) {
      const attempts = nodeAttemptsOf(node);
      const costUsd = nodeCostUsdOf(node);
      const priced = nodeCostPricedOf(node);
      return h(
        'div',
        { className: 'rl-section' },
        h('h3', { className: 'rl-section-title' }, t('ws.attempts.title')),
        attempts.length === 0
          ? h('p', { className: 'rl-hint' }, t('ws.attempts.empty'))
          : h(
              'div',
              { className: 'rl-attempts' },
              attempts.map((attempt, index) => {
                const usage = asObject(attempt.usage);
                const modelLabel = modelLabelOf(attempt.model);
                const status = firstString(attempt.status);
                const stopReason = firstString(attempt.stopReason);
                const errorText = firstString(attempt.error);
                return h(
                  'div',
                  { key: String(numberOr(attempt.index, index + 1)), className: 'rl-attempt' },
                  h(
                    'div',
                    { className: 'rl-attempt-head' },
                    h('span', { className: 'rl-attempt-index' }, t('ws.attempts.index', { index: numberOr(attempt.index, index + 1) })),
                    modelLabel ? h('span', { className: 'rl-chip rl-chip-mono' }, modelLabel) : null,
                    status ? h('span', { className: 'rl-hint' }, t('status.' + status)) : null,
                    attemptDurationTextOf(attempt) ? h('span', { className: 'rl-hint' }, attemptDurationTextOf(attempt)) : null,
                    finiteNumber(attempt.costUsd) !== null ? h('span', { className: 'rl-chip' }, t('ws.cost.chip', { amount: formatUsdAmount(attempt.costUsd) })) : null,
                  ),
                  h(
                    'div',
                    { className: 'rl-attempt-meta' },
                    h('span', null, t('ws.attempts.tokens') + ': ' + formatTokenCount(usageTotalOf(usage))),
                    stopReason ? h('span', null, t('ws.attempts.stopReason', { reason: stopReason })) : null,
                    errorText ? h('span', { className: 'rl-attempt-error' }, t('ws.attempts.error', { message: errorText })) : null,
                  ),
                );
              }),
            ),
        costUsd !== null
          ? h(LabInfoRow, {
              label: t('ws.cost.total'),
              value: formatUsdAmount(costUsd) + (priced === false ? ' (' + t('ws.cost.unpriced') + ')' : ''),
              mono: true,
            })
          : null,
      );
    }

    /** Token usage readback (node/report/runs panels). */
    function UsageRows({ usage, title, t }) {
      const record = asObject(usage);
      return h(
        'div',
        { className: 'rl-report-section' },
        title ? h('h4', { className: 'rl-report-section-title' }, title) : null,
        h(LabInfoRow, { label: t('ws.usage.total'), value: formatTokenCount(usageTotalOf(record)) }),
        h(LabInfoRow, { label: t('ws.usage.input'), value: formatTokenCount(record.inputTokens) }),
        h(LabInfoRow, { label: t('ws.usage.output'), value: formatTokenCount(record.outputTokens) }),
        finiteNumber(record.cacheReadTokens) !== null
          ? h(LabInfoRow, { label: t('ws.usage.cacheRead'), value: formatTokenCount(record.cacheReadTokens) })
          : null,
        finiteNumber(record.cacheWriteTokens) !== null
          ? h(LabInfoRow, { label: t('ws.usage.cacheWrite'), value: formatTokenCount(record.cacheWriteTokens) })
          : null,
      );
    }

    /** Merge readback: state, conflict files, parent baselines and the finish action. */
    function MergeSection({ node, nodes, busy, onFinish, t }) {
      const merge = nodeMergeOf(node);
      if (merge === null) return null;
      const state = mergeStateOf(node);
      const conflicts = mergeConflictFilesOf(node);
      const prepared = mergePreparedOf(node);
      const parentIds = nodeParentIdsOf(node);
      const parentTitleOfId = (id) => {
        for (const candidate of asArray(nodes)) if (nodeIdOf(candidate) === id) return nodeTitleOf(candidate, t);
        return id;
      };
      const rows = prepared.length > 0 ? prepared : parentIds.map((id) => ({ parentId: id }));
      return h(
        'div',
        { className: 'rl-merge-panel' },
        h('p', { className: 'rl-merge-title' }, t('ws.merge.title')),
        h(
          'div',
          { className: 'rl-project-chips' },
          state ? h('span', { className: 'rl-chip rl-chip-merge' }, t(mergeStateLabelKeyOf(state))) : null,
          h('span', { className: 'rl-chip' }, t('ws.merge.parentCount', { count: parentIds.length })),
        ),
        conflicts.length > 0
          ? h(
              'div',
              { className: 'rl-report-section' },
              h('h4', { className: 'rl-report-section-title' }, t('ws.merge.conflicts')),
              h('ul', { className: 'rl-merge-conflicts' }, conflicts.map((file, index) => h('li', { key: index }, file))),
            )
          : null,
        rows.length > 0
          ? h(
              'div',
              { className: 'rl-report-section' },
              h('h4', { className: 'rl-report-section-title' }, t('ws.merge.prepared')),
              rows.map((entry, index) => {
                const record = asObject(entry);
                const parentId = firstString(record.parentId);
                const branch = firstString(record.branch);
                const commit = shortCommit(firstString(record.headCommit));
                const clean = record.clean === true ? t('ws.merge.clean') : (record.clean === false ? t('ws.merge.dirty') : '');
                return h(
                  'div',
                  { key: parentId || 'parent-' + index, className: 'rl-merge-parent' },
                  h('span', { className: 'rl-merge-parent-title' }, parentTitleOfId(parentId)),
                  h(
                    'span',
                    { className: 'rl-merge-parent-meta' },
                    [parentId, branch, commit, clean].filter((part) => part !== '').join(' · '),
                  ),
                );
              }),
            )
          : null,
        finiteNumber(merge.committedAt) !== null
          ? h(LabInfoRow, { label: t('ws.merge.committedAt'), value: formatDateTime(merge.committedAt, t) })
          : null,
        firstString(merge.headCommit)
          ? h(LabInfoRow, { label: t('ws.merge.headCommit'), value: firstString(merge.headCommit), mono: true })
          : null,
        nodeStatusOf(node) === 'running' && state !== 'committed' && typeof onFinish === 'function'
          ? h(
              'div',
              { className: 'rl-form-actions' },
              h(LabButton, { label: t('ws.merge.finish'), variant: 'primary', disabled: busy === true, onClick: onFinish }),
            )
          : null,
      );
    }

    /** Create a merge node from 2..4 completed parents. */
    function MergeCreateModal({ project, nodes, initialNodeId, onClose, onSubmit, modelOptions, t }) {
      const completed = asArray(nodes).filter((node) => nodeStatusOf(node) === 'completed' && !nodeIsMergeOf(node));
      const [selected, setSelected] = React.useState(
        typeof initialNodeId === 'string' && initialNodeId.length > 0 ? [initialNodeId] : [],
      );
      const [title, setTitle] = React.useState('');
      const [prompt, setPrompt] = React.useState('');
      const [timebox, setTimebox] = React.useState(String(Math.round(projectDefaultTimeoutMinutes(project))));
      const [submitting, setSubmitting] = React.useState(false);
      const [error, setError] = React.useState('');
      const [model, setModel] = React.useState(null);
      const maxMinutes = Math.round(projectMaxTimeoutMinutes(project));
      const toggle = (id) => {
        setError('');
        setSelected((previous) => {
          if (previous.indexOf(id) >= 0) return previous.filter((entry) => entry !== id);
          if (previous.length >= 4) return previous;
          return previous.concat([id]);
        });
      };
      const submit = async () => {
        if (submitting) return;
        if (selected.length < 2 || selected.length > 4) {
          setError(t('ws.merge.required.parents'));
          return;
        }
        const minutes = parseInteger(timebox, 0);
        if (minutes < 1 || minutes > maxMinutes) {
          setError(t('ws.inspector.timebox.invalid', { max: maxMinutes }));
          return;
        }
        const modelPayload = modelPayloadOf(model);
        setSubmitting(true);
        setError('');
        const result = await onSubmit({
          type: 'node.merge',
          parentIds: selected,
          title: title.trim(),
          prompt: prompt.trim(),
          timeboxMinutes: minutes,
          ...(modelPayload === undefined ? {} : { model: modelPayload }),
        });
        setSubmitting(false);
        if (result !== null && result !== undefined && result.ok === true) onClose();
        else setError((result && result.error) || t('ws.merge.error'));
      };
      return h(
        'div',
        { className: 'rl-overlay-layer rl-overlay-layer-top' },
        h(
          'div',
          { className: 'rl-modal', role: 'dialog', 'aria-label': t('ws.merge.createTitle') },
          h(
            'div',
            { className: 'rl-modal-head' },
            h('h2', { className: 'rl-modal-title' }, t('ws.merge.createTitle')),
            h(LabButton, { label: '✕', variant: 'ghost', title: t('ws.merge.close'), onClick: onClose }),
          ),
          h(
            'div',
            { className: 'rl-modal-body' },
            h('p', { className: 'rl-modal-note' }, t('ws.merge.intro')),
            h(
              'div',
              { className: 'rl-field' },
              h(
                'span',
                { className: 'rl-label' },
                t('ws.merge.parents') + ' · ' + t('ws.merge.selected', { count: selected.length, max: 4 }),
              ),
              completed.length === 0
                ? h('p', { className: 'rl-hint' }, t('ws.merge.required.parents'))
                : h(
                    'div',
                    { className: 'rl-merge-node-list' },
                    completed.map((node) => {
                      const id = nodeIdOf(node);
                      const checked = selected.indexOf(id) >= 0;
                      return h(
                        'label',
                        { key: id, className: 'rl-merge-option' },
                        h('input', { type: 'checkbox', checked, onChange: () => toggle(id) }),
                        h(
                          'span',
                          { className: 'rl-merge-option-main' },
                          h('span', null, nodeTitleOf(node, t)),
                          h(
                            'span',
                            { className: 'rl-merge-option-id' },
                            id + (nodeHeadCommitOf(node) ? ' · ' + shortCommit(nodeHeadCommitOf(node)) : ''),
                          ),
                        ),
                      );
                    }),
                  ),
            ),
            h(
              'div',
              { className: 'rl-form-grid' },
              h(LabField, { label: t('ws.merge.field.title') },
                h(LabInput, {
                  value: title,
                  placeholder: t('ws.merge.field.titlePlaceholder'),
                  ariaLabel: t('ws.merge.field.title'),
                  onChange: (event) => setTitle(event.target.value),
                })),
              h(LabField, { label: t('ws.merge.field.timebox'), hint: t('ws.inspector.timebox.hint', { max: maxMinutes }) },
                h(LabInput, {
                  type: 'number',
                  value: timebox,
                  ariaLabel: t('ws.merge.field.timebox'),
                  onChange: (event) => setTimebox(event.target.value),
                })),
            ),
            h(LabField, { label: t('ws.merge.field.prompt') },
              h(LabTextarea, {
                value: prompt,
                placeholder: t('ws.merge.field.promptPlaceholder'),
                ariaLabel: t('ws.merge.field.prompt'),
                rows: 4,
                onChange: (event) => setPrompt(event.target.value),
              })),
            h(LabField, { label: t('ws.model.title'), hint: t('ws.model.inheritHint') },
              h(ModelPicker, { model, onChange: setModel, modelOptions, disabled: submitting, t })),
            error ? h('p', { className: 'rl-error-text', role: 'alert' }, t('ws.merge.error') + ': ' + error) : null,
          ),
          h(
            'div',
            { className: 'rl-modal-foot' },
            h(LabButton, { label: t('ws.successor.cancel'), variant: 'ghost', onClick: onClose }),
            h(LabButton, {
              label: submitting ? t('ws.merge.creating') : t('ws.merge.submit'),
              variant: 'primary',
              disabled: submitting,
              onClick: submit,
            }),
          ),
        ),
      );
    }

    /** Finish a running merge node; surfaces unresolved conflict paths inline. */
    function FinishMergeDialog({ onSubmit, onClose, t }) {
      const [summary, setSummary] = React.useState('');
      const [submitting, setSubmitting] = React.useState(false);
      const [error, setError] = React.useState('');
      const submit = async () => {
        if (submitting) return;
        setSubmitting(true);
        setError('');
        const result = await onSubmit(summary.trim() ? { summary: summary.trim() } : {});
        setSubmitting(false);
        if (result !== null && result !== undefined && result.ok === true) onClose();
        else setError((result && result.error) || t('ws.merge.finishError'));
      };
      return h(
        'div',
        { className: 'rl-overlay-layer rl-overlay-layer-top' },
        h(
          'div',
          { className: 'rl-modal rl-modal-narrow', role: 'dialog', 'aria-label': t('ws.merge.finishTitle') },
          h(
            'div',
            { className: 'rl-modal-head' },
            h('h2', { className: 'rl-modal-title' }, t('ws.merge.finishTitle')),
            h(LabButton, { label: '✕', variant: 'ghost', title: t('ws.merge.close'), onClick: onClose }),
          ),
          h(
            'div',
            { className: 'rl-modal-body' },
            h('p', { className: 'rl-modal-note' }, t('ws.merge.finishIntro')),
            h(LabField, { label: t('ws.merge.finishSummary') },
              h(LabTextarea, {
                value: summary,
                rows: 3,
                ariaLabel: t('ws.merge.finishSummary'),
                onChange: (event) => setSummary(event.target.value),
              })),
            error ? h('p', { className: 'rl-error-text', role: 'alert' }, error) : null,
          ),
          h(
            'div',
            { className: 'rl-modal-foot' },
            h(LabButton, { label: t('ws.successor.cancel'), variant: 'ghost', onClick: onClose }),
            h(LabButton, {
              label: submitting ? t('ws.merge.finishing') : t('ws.merge.finishSubmit'),
              variant: 'primary',
              disabled: submitting,
              onClick: submit,
            }),
          ),
        ),
      );
    }

    /** Push plugin-managed branches/tags to a remote, showing refs and output. */
    function PushDialog({ onClose, onPush, t }) {
      const [remote, setRemote] = React.useState('origin');
      const [pushing, setPushing] = React.useState(false);
      const [error, setError] = React.useState('');
      const [result, setResult] = React.useState(null);
      const submit = async () => {
        if (pushing) return;
        setPushing(true);
        setError('');
        const outcome = await onPush(remote.trim());
        setPushing(false);
        if (outcome !== null && outcome !== undefined && outcome.ok === true) setResult(asObject(outcome.result));
        else setError((outcome && outcome.error) || t('ws.push.error'));
      };
      const refs = result === null ? [] : stringListOf(result.pushedRefs);
      return h(
        'div',
        { className: 'rl-overlay-layer rl-overlay-layer-top' },
        h(
          'div',
          { className: 'rl-modal rl-modal-narrow', role: 'dialog', 'aria-label': t('ws.push.title') },
          h(
            'div',
            { className: 'rl-modal-head' },
            h('h2', { className: 'rl-modal-title' }, t('ws.push.title')),
            h(LabButton, { label: '✕', variant: 'ghost', title: t('ws.push.close'), onClick: onClose }),
          ),
          h(
            'div',
            { className: 'rl-modal-body' },
            h('p', { className: 'rl-modal-note' }, t('ws.push.intro')),
            h(LabField, { label: t('ws.push.remote') },
              h(LabInput, {
                value: remote,
                placeholder: t('ws.push.remotePlaceholder'),
                ariaLabel: t('ws.push.remote'),
                disabled: pushing || result !== null,
                onChange: (event) => setRemote(event.target.value),
              })),
            error ? h('p', { className: 'rl-error-text', role: 'alert' }, error) : null,
            result !== null
              ? h(
                  'div',
                  { className: 'rl-push-result' },
                  h('p', { className: 'rl-push-result-title' }, t('ws.push.done', { count: refs.length })),
                  firstString(result.stdout) ? h('pre', { className: 'rl-push-stdout' }, firstString(result.stdout)) : null,
                )
              : null,
          ),
          h(
            'div',
            { className: 'rl-modal-foot' },
            h(LabButton, { label: t('ws.push.cancel'), variant: 'ghost', onClick: onClose }),
            result === null
              ? h(LabButton, {
                  label: pushing ? t('ws.push.pushing') : t('ws.push.submit'),
                  variant: 'primary',
                  disabled: pushing,
                  onClick: submit,
                })
              : null,
          ),
        ),
      );
    }

    /** Delete-project confirmation with the optional worktree removal checkbox. */
    function DeleteProjectDialog({ projectName, busy, error, onConfirm, onCancel, t }) {
      const [removeWorktrees, setRemoveWorktrees] = React.useState(false);
      React.useEffect(() => {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined;
        const onKeyDown = (event) => {
          if (event.key === 'Escape' && busy !== true) onCancel();
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
      }, [busy, onCancel]);
      return h(
        'div',
        { className: 'rl-overlay-layer rl-overlay-layer-confirm' },
        h(
          'div',
          { className: 'rl-modal rl-modal-narrow', role: 'dialog', 'aria-label': t('landing.delete.confirmTitle', { name: projectName }) },
          h(
            'div',
            { className: 'rl-modal-head' },
            h('h2', { className: 'rl-modal-title' }, t('landing.delete.confirmTitle', { name: projectName })),
            h(LabButton, { label: '✕', variant: 'ghost', title: t('landing.delete.close'), onClick: busy ? undefined : onCancel }),
          ),
          h(
            'div',
            { className: 'rl-modal-body' },
            h('p', { className: 'rl-modal-note' }, t('landing.delete.body')),
            h(
              'label',
              { className: 'rl-delete-option' },
              h('input', {
                type: 'checkbox',
                checked: removeWorktrees,
                disabled: busy === true,
                onChange: (event) => setRemoveWorktrees(event.target.checked === true),
              }),
              h('span', null, t('landing.delete.worktrees')),
            ),
            h('p', { className: 'rl-delete-warning' }, t('landing.delete.warning')),
            error ? h('p', { className: 'rl-error-text', role: 'alert' }, t('landing.delete.error') + ': ' + error) : null,
          ),
          h(
            'div',
            { className: 'rl-modal-foot' },
            h(LabButton, { label: t('landing.delete.cancel'), variant: 'ghost', disabled: busy === true, onClick: onCancel }),
            h(LabButton, {
              label: busy === true ? t('landing.delete.deleting') : t('landing.delete.confirm'),
              variant: 'ghost',
              disabled: busy === true,
              onClick: () => onConfirm(removeWorktrees),
            }),
          ),
        ),
      );
    }

    /** Small confirmation dialog used for proposal approve/reject. */
    function ConfirmDialog({ title, body, confirmLabel, cancelLabel, danger, onConfirm, onCancel, t }) {
      return h(
        'div',
        { className: 'rl-overlay-layer rl-overlay-layer-confirm' },
        h(
          'div',
          { className: 'rl-modal rl-modal-narrow', role: 'dialog', 'aria-label': title },
          h(
            'div',
            { className: 'rl-modal-head' },
            h('h2', { className: 'rl-modal-title' }, title),
            h(LabButton, { label: '✕', variant: 'ghost', title: t('ws.confirm.close'), onClick: onCancel }),
          ),
          h('div', { className: 'rl-modal-body' }, h('p', { className: 'rl-confirm-text' }, body)),
          h(
            'div',
            { className: 'rl-modal-foot' },
            h(LabButton, { label: cancelLabel || t('ws.confirm.cancel'), variant: 'ghost', onClick: onCancel }),
            h(LabButton, { label: confirmLabel, variant: danger === true ? 'ghost' : 'primary', onClick: onConfirm }),
          ),
        ),
      );
    }

    /** Budget summary shown before switching to auto mode. */
    function AutoConfirmModal({ project, onConfirm, onClose, t }) {
      const limits = autoLimitsOf(null, project);
      return h(
        'div',
        { className: 'rl-overlay-layer rl-overlay-layer-confirm' },
        h(
          'div',
          { className: 'rl-modal rl-modal-narrow', role: 'dialog', 'aria-label': t('ws.auto.confirmTitle') },
          h(
            'div',
            { className: 'rl-modal-head' },
            h('h2', { className: 'rl-modal-title' }, t('ws.auto.confirmTitle')),
            h(LabButton, { label: '✕', variant: 'ghost', title: t('ws.auto.cancel'), onClick: onClose }),
          ),
          h(
            'div',
            { className: 'rl-modal-body' },
            h('p', { className: 'rl-modal-note' }, t('ws.auto.confirmIntro')),
            h(
              'ul',
              { className: 'rl-budget-list' },
              h('li', null, t('ws.auto.budget.cycles', { count: limits.maxCycles })),
              h('li', null, t('ws.auto.budget.wallClock', { hours: formatHoursFromMs(limits.maxWallClockMs) })),
              h('li', null, t('ws.auto.budget.nodes', { count: limits.maxNodes })),
              h('li', null, t('ws.auto.budget.idle', { count: limits.idleCycleLimit })),
            ),
            h('p', { className: 'rl-modal-note' }, t('ws.auto.costHint')),
          ),
          h(
            'div',
            { className: 'rl-modal-foot' },
            h(LabButton, { label: t('ws.auto.cancel'), variant: 'ghost', onClick: onClose }),
            h(LabButton, { label: t('ws.auto.start'), variant: 'primary', onClick: onConfirm }),
          ),
        ),
      );
    }

    /** Auto-mode chip with status, runtime/limits and resume/stop controls. */
    function AutoStatusChip({ auto, project, pendingProposals, busy, onResume, onStop, onViewPending, t }) {
      const status = autoStatusOf(auto);
      if (status === 'off') return null;
      const limits = autoLimitsOf(auto, project);
      const cycles = numberOr(asObject(auto).cycles, 0);
      const startedAt = finiteNumber(asObject(auto).startedAt);
      const elapsed = startedAt === null ? '' : formatDurationBetween(startedAt, null);
      const tokensUsed = numberOr(asObject(auto).tokensUsed, 0);
      const tokensText = limits.maxTokens > 0
        ? ' · ' + t('ws.auto.tokens', { used: formatTokenCount(tokensUsed), max: formatTokenCount(limits.maxTokens) })
        : '';
      const costUsed = numberOr(asObject(auto).costUsed, 0);
      const costText = limits.maxCostUsd > 0
        ? ' · ' + t('ws.auto.cost', { used: formatUsdAmount(costUsed), max: formatUsdAmount(limits.maxCostUsd) })
        : '';
      let label;
      let meta;
      if (status === 'running') {
        label = t('ws.auto.running');
        meta = t('ws.auto.cycles', { count: cycles, max: limits.maxCycles }) + (elapsed ? ' · ' + t('ws.auto.elapsed', { time: elapsed }) : '');
      } else if (status === 'paused') {
        label = t('ws.auto.paused');
        meta = t(autoPauseLabelKeyOf(autoPauseReasonOf(auto)));
      } else {
        label = t('ws.auto.waiting');
        meta = t('ws.auto.viewPending') + ' ' + String(pendingProposals);
      }
      meta = (meta ? meta : '') + tokensText + costText;
      const actions = [];
      if (status === 'paused') {
        actions.push(h(LabButton, { key: 'resume', label: t('ws.auto.resume'), variant: 'primary', disabled: busy, onClick: onResume }));
        actions.push(h(LabButton, { key: 'stop', label: t('ws.auto.stop'), disabled: busy, onClick: onStop }));
      } else if (status === 'running') {
        actions.push(h(LabButton, { key: 'stop', label: t('ws.auto.stop'), disabled: busy, onClick: onStop }));
      } else if (status === 'waiting') {
        actions.push(h(LabButton, { key: 'view', label: t('ws.auto.viewPending'), disabled: busy, onClick: onViewPending }));
        actions.push(h(LabButton, { key: 'stop', label: t('ws.auto.stop'), disabled: busy, onClick: onStop }));
      }
      return h(
        'span',
        { className: 'rl-auto-chip rl-auto-chip-' + status },
        h('span', null, label),
        meta ? h('span', { className: 'rl-auto-meta' }, meta) : null,
        busy ? h('span', { className: 'rl-spinner', 'aria-hidden': true }) : null,
        actions.length > 0 ? h('span', { className: 'rl-auto-actions' }, actions) : null,
      );
    }

    /** Proposal detail readback for a `proposed` node. */
    function ProposalPanel({ proposal, t }) {
      const record = asObject(proposal);
      const rationale = firstString(record.rationale);
      const infoGain = firstString(record.expectedInfoGain);
      const runId = firstString(record.runId);
      return h(
        'div',
        { className: 'rl-proposal-panel' },
        h('p', { className: 'rl-proposal-title' }, t('ws.proposed.title')),
        rationale ? h(LabInfoRow, { label: t('ws.proposed.rationale'), value: rationale }) : null,
        infoGain ? h(LabInfoRow, { label: t('ws.proposed.infoGain'), value: infoGain }) : null,
        finiteNumber(record.createdAt) !== null
          ? h(LabInfoRow, { label: t('ws.proposed.createdAt'), value: formatDateTime(record.createdAt, t) })
          : null,
        runId ? h(LabInfoRow, { label: t('ws.proposed.run'), value: runId, mono: true }) : null,
      );
    }

    /** GC postmortem block shown inside the termination panel. */
    function GcPanel({ postmortem, gcRunId, onOpenRun, t }) {
      const record = asObject(postmortem);
      const cause = gcPostmortemTextOf(record, 'cause');
      const summary = gcPostmortemTextOf(record, 'summary');
      const recommendation = gcPostmortemTextOf(record, 'recommendation');
      const leftovers = gcPostmortemListOf(record, 'leftovers');
      const cleanupRequested = record.cleanupRequested === true
        ? t('ws.termination.yes')
        : record.cleanupRequested === false ? t('ws.termination.no') : '';
      return h(
        'div',
        { className: 'rl-gc-panel' },
        h('p', { className: 'rl-gc-title' }, t('ws.gc.title')),
        cause ? h(LabInfoRow, { label: t('ws.gc.cause'), value: cause }) : null,
        summary ? h(LabInfoRow, { label: t('ws.gc.summary'), value: summary }) : null,
        recommendation ? h(LabInfoRow, { label: t('ws.gc.recommendation'), value: recommendation }) : null,
        cleanupRequested ? h(LabInfoRow, { label: t('ws.gc.cleanupRequested'), value: cleanupRequested }) : null,
        leftovers.length > 0
          ? h(
              'div',
              { className: 'rl-report-section' },
              h('h4', { className: 'rl-report-section-title' }, t('ws.gc.leftovers')),
              h('ul', { className: 'rl-report-list rl-report-blockers' }, leftovers.map((item, index) => h('li', { key: index }, item))),
            )
          : null,
        gcRunId && typeof onOpenRun === 'function'
          ? h(
              'div',
              { className: 'rl-form-actions' },
              h(LabButton, { label: t('ws.gc.openRun'), variant: 'ghost', onClick: () => onOpenRun(gcRunId) }),
            )
          : null,
      );
    }

    /** Key-value editor for node.needs (planned/proposed nodes). */
    function NeedsEditor({ node, busy, onSave, t }) {
      const [rows, setRows] = React.useState(() =>
        nodeNeedsEntries(node).map((entry, index) => ({ id: 'needs-' + index, key: entry.key, value: String(entry.amount) })));
      const [saving, setSaving] = React.useState(false);
      const [error, setError] = React.useState('');
      const seqRef = React.useRef(rows.length);
      const update = (id, field, value) => {
        setRows((previous) => previous.map((row) => (row.id === id ? { ...row, [field]: value } : row)));
        setError('');
      };
      const add = () => {
        seqRef.current += 1;
        setRows((previous) => previous.concat([{ id: 'needs-' + seqRef.current, key: '', value: '1' }]));
      };
      const remove = (id) => {
        setRows((previous) => previous.filter((row) => row.id !== id));
      };
      const save = async () => {
        if (saving || busy) return;
        const needs = {};
        for (const row of rows) {
          const key = String(row.key === undefined || row.key === null ? '' : row.key).trim();
          if (!key) continue;
          const amount = parseInteger(row.value, 0);
          if (amount <= 0) {
            setError(t('ws.inspector.needsInvalid'));
            return;
          }
          if (Object.prototype.hasOwnProperty.call(needs, key)) {
            setError(t('wizard.pools.duplicate'));
            return;
          }
          needs[key] = amount;
        }
        setSaving(true);
        setError('');
        const result = await onSave(needs);
        setSaving(false);
        if (!(result !== null && result !== undefined && result.ok === true)) {
          setError((result && result.error) || t('ws.inspector.error'));
        }
      };
      return h(
        'div',
        { className: 'rl-field' },
        h('span', { className: 'rl-label' }, t('ws.inspector.needs')),
        rows.length === 0 ? h('p', { className: 'rl-hint' }, t('ws.inspector.noNeeds')) : null,
        rows.map((row) =>
          h(
            'div',
            { key: row.id, className: 'rl-need-row' },
            h(LabInput, {
              value: row.key,
              placeholder: t('wizard.pool.key'),
              ariaLabel: t('wizard.pool.key'),
              onChange: (event) => update(row.id, 'key', event.target.value),
            }),
            h(LabInput, {
              type: 'number',
              value: row.value,
              ariaLabel: t('wizard.pool.value'),
              onChange: (event) => update(row.id, 'value', event.target.value),
            }),
            h(LabButton, { label: '✕', variant: 'ghost', title: t('wizard.pool.remove'), onClick: () => remove(row.id) }),
          )),
        h('div', { className: 'rl-form-actions' },
          h(LabButton, { label: t('wizard.pool.add'), variant: 'ghost', onClick: add }),
          h(LabButton, {
            label: saving ? t('ws.inspector.saving') : t('ws.inspector.saveNeeds'),
            disabled: saving || busy === true,
            onClick: save,
          })),
        h('p', { className: 'rl-hint' }, t('ws.fleet.needsHint')),
        error ? h('p', { className: 'rl-error-text', role: 'alert' }, error) : null,
      );
    }

    /** Draft for the project settings form (string fields keep inputs controlled). */
    function settingsDraftOf(project) {
      const config = projectConfig(project);
      const advisor = configAdvisorOf(project);
      const auto = configAutoOf(project);
      const pools = asObject(config.resourcePools);
      const models = configModelsOf(project);
      const prompts = configPromptsOf(project);
      const modelOf = (role) => ({ provider: firstString(asObject(models[role]).provider), model: firstString(asObject(models[role]).model) });
      const worker = modelOf('worker');
      const advisorModel = modelOf('advisor');
      const schedulerModel = modelOf('scheduler');
      const poolKeys = Object.keys(pools);
      const routing = projectRoutingOf(project);
      return {
        acceptMode: advisor.acceptMode === 'confirm' ? 'confirm' : 'auto',
        maxProposalsPerPass: String(numberOr(advisor.maxProposalsPerPass, 3)),
        maxPendingProposals: String(numberOr(advisor.maxPendingProposals, 20)),
        maxCycles: String(numberOr(auto.maxCycles, 50)),
        maxWallClockMinutes: String(Math.round(numberOr(auto.maxWallClockMs, 6 * 3600000) / 60000)),
        idleCycleLimit: String(numberOr(auto.idleCycleLimit, 3)),
        nodeTimeoutMinutes: String(Math.round(projectDefaultTimeoutMinutes(project))),
        maxNodeTimeoutMinutes: String(Math.round(projectMaxTimeoutMinutes(project))),
        maxRunningNodes: String(Math.round(projectMaxRunningNodes(project))),
        maxNodes: String(Math.round(projectMaxNodes(project))),
        autoMaxTokens: String(numberOr(auto.maxTokens, 0)),
        autoMaxCostUsd: String(projectAutoMaxCostUsd(project)),
        clusterPriority: String(Math.round(numberOr(projectConfig(project).clusterPriority, 0))),
        advisorMaySelectModels: routing.advisorMaySelectModels,
        autoUpgrade: routing.autoUpgrade,
        routingMaxAttempts: String(routing.maxAttempts),
        modelOptions: projectModelOptionsOf(project).map((option, index) => ({
          id: 'settings-model-option-' + index,
          optionId: firstString(option.id),
          provider: firstString(option.provider),
          model: firstString(option.model),
          reasoningEffort: firstString(option.reasoningEffort),
          tags: stringListOf(option.tags).join(', '),
          priceIn: String(numberOr(option.pricePerMTokIn, 0)),
          priceOut: String(numberOr(option.pricePerMTokOut, 0)),
        })),
        reviewers: projectReviewersOf(project).map((reviewer, index) => ({
          id: 'settings-reviewer-' + index,
          lens: firstString(reviewer.lens),
          provider: firstString(reviewer.provider),
          model: firstString(reviewer.model),
          reasoningEffort: firstString(reviewer.reasoningEffort),
        })),
        pools: poolKeys.length > 0
          ? poolKeys.map((key, index) => ({ id: 'settings-pool-' + index, key, value: String(numberOr(pools[key], 0)) }))
          : [{ id: 'settings-pool-default', key: 'gpu', value: '1' }],
        workerProvider: worker.provider,
        workerModel: worker.model,
        advisorProvider: advisorModel.provider,
        advisorModel: advisorModel.model,
        schedulerProvider: schedulerModel.provider,
        schedulerModel: schedulerModel.model,
        workerPrefix: firstString(prompts.workerPrefix),
        advisorPrompt: firstString(prompts.advisor),
        schedulerPrompt: firstString(prompts.scheduler),
      };
    }

    /** Build the partial project config sent by `project.update`. */
    function settingsConfigFromDraft(draft, project) {
      const config = projectConfig(project);
      const advisor = Object.assign({}, asObject(config.advisor));
      const auto = Object.assign({}, asObject(config.auto));
      const models = Object.assign({}, asObject(config.models));
      const prompts = Object.assign({}, asObject(config.prompts));
      advisor.acceptMode = draft.acceptMode === 'confirm' ? 'confirm' : 'auto';
      advisor.maxProposalsPerPass = parseInteger(draft.maxProposalsPerPass, 3);
      advisor.maxPendingProposals = parseInteger(draft.maxPendingProposals, 20);
      auto.maxCycles = parseInteger(draft.maxCycles, 50);
      auto.maxWallClockMs = Math.max(1, parseInteger(draft.maxWallClockMinutes, 360)) * 60000;
      auto.idleCycleLimit = parseInteger(draft.idleCycleLimit, 3);
      auto.maxTokens = Math.max(0, parseInteger(draft.autoMaxTokens, 0));
      const maxCostRaw = Number(draft.autoMaxCostUsd);
      auto.maxCostUsd = Number.isFinite(maxCostRaw) && maxCostRaw > 0 ? maxCostRaw : 0;
      const clusterPriorityRaw = Number(draft.clusterPriority);
      const clusterPriority = Number.isFinite(clusterPriorityRaw)
        ? Math.max(0, Math.min(100, Math.round(clusterPriorityRaw)))
        : 0;
      const routing = {
        advisorMaySelectModels: draft.advisorMaySelectModels === true,
        autoUpgrade: draft.autoUpgrade === true,
        maxAttempts: Math.max(1, Math.min(3, parseInteger(draft.routingMaxAttempts, 2))),
      };
      const modelOptions = [];
      for (const row of asArray(draft.modelOptions)) {
        const provider = String(row.provider === undefined || row.provider === null ? '' : row.provider).trim();
        const model = String(row.model === undefined || row.model === null ? '' : row.model).trim();
        if (!provider || !model) continue;
        const id = String(row.optionId === undefined || row.optionId === null ? '' : row.optionId).trim();
        const effort = String(row.reasoningEffort === undefined || row.reasoningEffort === null ? '' : row.reasoningEffort).trim();
        const tags = String(row.tags === undefined || row.tags === null ? '' : row.tags)
          .split(',').map((tag) => tag.trim()).filter((tag) => tag.length > 0).slice(0, 8);
        const priceIn = Number(row.priceIn);
        const priceOut = Number(row.priceOut);
        if (!Number.isFinite(priceIn) || priceIn < 0 || !Number.isFinite(priceOut) || priceOut < 0) {
          throw new Error(t('ws.settings.invalid'));
        }
        modelOptions.push(Object.assign(
          { provider, model },
          id ? { id } : {},
          effort ? { reasoningEffort: effort } : {},
          tags.length > 0 ? { tags } : {},
          { pricePerMTokIn: priceIn, pricePerMTokOut: priceOut },
        ));
        if (modelOptions.length >= 50) break;
      }
      const reviewers = [];
      for (const row of asArray(draft.reviewers)) {
        const lens = String(row.lens === undefined || row.lens === null ? '' : row.lens).trim();
        const provider = String(row.provider === undefined || row.provider === null ? '' : row.provider).trim();
        const model = String(row.model === undefined || row.model === null ? '' : row.model).trim();
        const effort = String(row.reasoningEffort === undefined || row.reasoningEffort === null ? '' : row.reasoningEffort).trim();
        if (!lens && !provider && !model) continue;
        reviewers.push({
          lens,
          provider,
          model,
          ...(effort ? { reasoningEffort: effort } : {}),
        });
        if (reviewers.length >= 4) break;
      }
      advisor.reviewers = reviewers;
      const pools = {};
      for (const row of draft.pools) {
        const key = String(row.key === undefined || row.key === null ? '' : row.key).trim();
        const amount = parseInteger(row.value, 0);
        if (!key || amount <= 0) continue;
        pools[key] = amount;
      }
      const setModel = (role, provider, model) => {
        const p = String(provider === undefined || provider === null ? '' : provider).trim();
        const m = String(model === undefined || model === null ? '' : model).trim();
        if (p && m) models[role] = { provider: p, model: m };
        else delete models[role];
      };
      setModel('worker', draft.workerProvider, draft.workerModel);
      setModel('advisor', draft.advisorProvider, draft.advisorModel);
      setModel('scheduler', draft.schedulerProvider, draft.schedulerModel);
      const setPrompt = (key, value) => {
        const text = String(value === undefined || value === null ? '' : value).trim();
        if (text) prompts[key] = text;
        else delete prompts[key];
      };
      setPrompt('workerPrefix', draft.workerPrefix);
      setPrompt('advisor', draft.advisorPrompt);
      setPrompt('scheduler', draft.schedulerPrompt);
      return {
        resourcePools: pools,
        maxRunningNodes: Math.max(1, parseInteger(draft.maxRunningNodes, 4)),
        maxNodes: Math.max(1, parseInteger(draft.maxNodes, 60)),
        nodeTimeoutMinutes: Math.max(1, parseInteger(draft.nodeTimeoutMinutes, 10)),
        maxNodeTimeoutMinutes: Math.max(1, parseInteger(draft.maxNodeTimeoutMinutes, 240)),
        advisor,
        auto,
        models,
        prompts,
        routing,
        modelOptions,
        clusterPriority,
      };
    }

    /** Project settings modal (advisor/auto budgets/limits/pools/models/prompts). */
    function SettingsModal({ project, projectId, cluster, onClose, onSave, onSavePlacementPolicy, t }) {
      const [draft, setDraft] = React.useState(() => settingsDraftOf(project));
      const [saving, setSaving] = React.useState(false);
      const [error, setError] = React.useState('');
      const poolSeqRef = React.useRef(1);
      const reviewerSeqRef = React.useRef(asArray(draft.reviewers).length);
      const initialPlacement = placementPolicyOf(project);
      const [placementText, setPlacementText] = React.useState(initialPlacement.text);
      const [savedPlacement, setSavedPlacement] = React.useState(initialPlacement);
      const [compileState, setCompileState] = React.useState({ busy: false, result: null, error: '' });
      const [placementAction, setPlacementAction] = React.useState('');
      const [placementMessage, setPlacementMessage] = React.useState('');
      const [placementError, setPlacementError] = React.useState('');
      const compilePlacement = async () => {
        if (compileState.busy === true) return;
        setPlacementError('');
        setPlacementMessage('');
        setCompileState((previous) => ({ ...previous, busy: true, error: '' }));
        try {
          const data = await api.command(
            { type: 'project.compile_placement', projectId, text: placementText },
            undefined,
            t,
          );
          setCompileState({ busy: false, result: placementCompileResultOf(data), error: '' });
        } catch (compileError) {
          if (isAbortError(compileError)) {
            setCompileState((previous) => ({ ...previous, busy: false }));
            return;
          }
          setCompileState({ busy: false, result: null, error: placementErrorTextOf(compileError, t) });
        }
      };
      const savePlacement = async () => {
        if (placementAction !== '' || compileState.busy === true) return;
        const result = compileState.result;
        if (result === null || result.policy.text !== placementText) {
          setPlacementError(t('ws.settings.placement.needCompile'));
          return;
        }
        setPlacementAction('save');
        setPlacementError('');
        setPlacementMessage('');
        const outcome = await onSavePlacementPolicy(result.policy);
        setPlacementAction('');
        if (outcome !== null && outcome !== undefined && outcome.ok === true) {
          setSavedPlacement(result.policy);
          setPlacementMessage(t('ws.settings.placement.savedMessage'));
        } else {
          setPlacementError((outcome && outcome.error) || t('ws.settings.placement.error'));
        }
      };
      const clearPlacement = async () => {
        if (placementAction !== '' || compileState.busy === true) return;
        setPlacementAction('clear');
        setPlacementError('');
        setPlacementMessage('');
        const outcome = await onSavePlacementPolicy({
          text: '',
          spec: null,
          compiledAt: null,
          explanation: [],
          warnings: [],
          compiler: null,
          summary: '',
        });
        setPlacementAction('');
        if (outcome !== null && outcome !== undefined && outcome.ok === true) {
          setSavedPlacement(PLACEMENT_EMPTY_POLICY);
          setPlacementText('');
          setCompileState({ busy: false, result: null, error: '' });
          setPlacementMessage(t('ws.settings.placement.clearedMessage'));
        } else {
          setPlacementError((outcome && outcome.error) || t('ws.settings.placement.error'));
        }
      };
      const modelOptionSeqRef = React.useRef(asArray(draft.modelOptions).length);
      const setField = (field, value) => {
        setDraft((previous) => ({ ...previous, [field]: value }));
        setError('');
      };
      const setPool = (id, field, value) => {
        setDraft((previous) => ({
          ...previous,
          pools: previous.pools.map((row) => (row.id === id ? { ...row, [field]: value } : row)),
        }));
        setError('');
      };
      const addPool = () => {
        poolSeqRef.current += 1;
        setDraft((previous) => ({
          ...previous,
          pools: previous.pools.concat([{ id: 'settings-pool-' + poolSeqRef.current, key: '', value: '1' }]),
        }));
      };
      const removePool = (id) => {
        setDraft((previous) => ({ ...previous, pools: previous.pools.filter((row) => row.id !== id) }));
      };
      const setReviewer = (id, field, value) => {
        setDraft((previous) => ({
          ...previous,
          reviewers: asArray(previous.reviewers).map((row) => (row.id === id ? { ...row, [field]: value } : row)),
        }));
        setError('');
      };
      const addReviewer = () => {
        setDraft((previous) => {
          const rows = asArray(previous.reviewers);
          if (rows.length >= 4) return previous;
          reviewerSeqRef.current += 1;
          return {
            ...previous,
            reviewers: rows.concat([{
              id: 'settings-reviewer-' + reviewerSeqRef.current,
              lens: '',
              provider: '',
              model: '',
              reasoningEffort: '',
            }]),
          };
        });
      };
      const setModelOption = (id, field, value) => {
        setDraft((previous) => ({
          ...previous,
          modelOptions: asArray(previous.modelOptions).map((row) => (row.id === id ? { ...row, [field]: value } : row)),
        }));
        setError('');
      };
      const addModelOption = () => {
        setDraft((previous) => {
          const rows = asArray(previous.modelOptions);
          if (rows.length >= 50) return previous;
          modelOptionSeqRef.current += 1;
          return {
            ...previous,
            modelOptions: rows.concat([{
              id: 'settings-model-option-' + modelOptionSeqRef.current,
              optionId: '',
              provider: '',
              model: '',
              reasoningEffort: '',
              tags: '',
              priceIn: '0',
              priceOut: '0',
            }]),
          };
        });
      };
      const removeModelOption = (id) => {
        setDraft((previous) => ({
          ...previous,
          modelOptions: asArray(previous.modelOptions).filter((row) => row.id !== id),
        }));
      };
      const removeReviewer = (id) => {
        setDraft((previous) => ({
          ...previous,
          reviewers: asArray(previous.reviewers).filter((row) => row.id !== id),
        }));
      };
      const reset = () => {
        setDraft(settingsDraftOf(project));
        setError('');
      };
      const save = async () => {
        if (saving) return;
        const config = settingsConfigFromDraft(draft, project);
        if (Object.keys(config.resourcePools).length === 0) {
          setError(t('wizard.pools.required'));
          return;
        }
        if (config.nodeTimeoutMinutes > config.maxNodeTimeoutMinutes) {
          setError(t('ws.settings.invalid'));
          return;
        }
        const priorityRaw = String(draft.clusterPriority === undefined || draft.clusterPriority === null ? '' : draft.clusterPriority).trim();
        const priorityValue = Number(priorityRaw);
        if (priorityRaw === '' || !Number.isFinite(priorityValue) || priorityValue < 0 || priorityValue > 100) {
          setError(t('ws.settings.clusterPriority.invalid'));
          return;
        }
        setSaving(true);
        setError('');
        const result = await onSave(config);
        setSaving(false);
        if (result !== null && result !== undefined && result.ok === true) {
          onClose();
        } else {
          setError((result && result.error) || t('ws.settings.error'));
        }
      };
      const modelField = (role, providerKey, modelKey) =>
        h(
          'div',
          { className: 'rl-settings-model-row' },
          h('span', { className: 'rl-settings-model-role' }, t('ws.settings.model.' + role)),
          h(LabInput, {
            value: draft[providerKey],
            placeholder: t('ws.settings.model.provider'),
            ariaLabel: t('ws.settings.model.' + role) + ' ' + t('ws.settings.model.provider'),
            onChange: (event) => setField(providerKey, event.target.value),
          }),
          h(LabInput, {
            value: draft[modelKey],
            placeholder: t('ws.settings.model.model'),
            ariaLabel: t('ws.settings.model.' + role) + ' ' + t('ws.settings.model.model'),
            onChange: (event) => setField(modelKey, event.target.value),
          }),
        );
      return h(
        'div',
        { className: 'rl-overlay-layer rl-overlay-layer-top' },
        h(
          'div',
          { className: 'rl-modal rl-modal-wide', role: 'dialog', 'aria-label': t('ws.settings.title') },
          h(
            'div',
            { className: 'rl-modal-head' },
            h('h2', { className: 'rl-modal-title' }, t('ws.settings.title')),
            h(LabButton, { label: '✕', variant: 'ghost', title: t('ws.settings.close'), onClick: onClose }),
          ),
          h(
            'div',
            { className: 'rl-modal-body' },
            h(
              'div',
              { className: 'rl-settings-section' },
              h('h3', { className: 'rl-settings-section-title' }, t('ws.settings.section.advisor')),
              h(LabField, { label: t('ws.settings.acceptMode'), hint: t('ws.settings.acceptMode.hint') },
                h(LabSelect, {
                  value: draft.acceptMode,
                  ariaLabel: t('ws.settings.acceptMode'),
                  options: [
                    { value: 'auto', label: t('ws.settings.acceptMode.auto') },
                    { value: 'confirm', label: t('ws.settings.acceptMode.confirm') },
                  ],
                  onChange: (event) => setField('acceptMode', event.target.value),
                })),
              h(
                'div',
                { className: 'rl-form-grid' },
                h(LabField, { label: t('ws.settings.maxProposalsPerPass') },
                  h(LabInput, {
                    type: 'number',
                    value: draft.maxProposalsPerPass,
                    ariaLabel: t('ws.settings.maxProposalsPerPass'),
                    onChange: (event) => setField('maxProposalsPerPass', event.target.value),
                  })),
                h(LabField, { label: t('ws.settings.maxPendingProposals') },
                  h(LabInput, {
                    type: 'number',
                    value: draft.maxPendingProposals,
                    ariaLabel: t('ws.settings.maxPendingProposals'),
                    onChange: (event) => setField('maxPendingProposals', event.target.value),
                  })),
              ),
            ),
            h(
              'div',
              { className: 'rl-settings-section' },
              h('h3', { className: 'rl-settings-section-title' }, t('ws.settings.section.reviewers')),
              h('p', { className: 'rl-hint' }, t('ws.settings.reviewers.hint')),
              asArray(draft.reviewers).map((row, index) =>
                h(
                  'div',
                  { key: row.id, className: 'rl-reviewer-row' },
                  h(LabInput, {
                    value: row.lens,
                    placeholder: t('ws.settings.reviewer.lens'),
                    ariaLabel: t('ws.settings.reviewer.lens') + ' ' + String(index + 1),
                    onChange: (event) => setReviewer(row.id, 'lens', event.target.value),
                  }),
                  h(LabInput, {
                    value: row.provider,
                    placeholder: t('ws.settings.reviewer.provider'),
                    ariaLabel: t('ws.settings.reviewer.provider') + ' ' + String(index + 1),
                    onChange: (event) => setReviewer(row.id, 'provider', event.target.value),
                  }),
                  h(LabInput, {
                    value: row.model,
                    placeholder: t('ws.settings.reviewer.model'),
                    ariaLabel: t('ws.settings.reviewer.model') + ' ' + String(index + 1),
                    onChange: (event) => setReviewer(row.id, 'model', event.target.value),
                  }),
                  h(LabSelect, {
                    value: row.reasoningEffort,
                    ariaLabel: t('ws.settings.reviewer.effort') + ' ' + String(index + 1),
                    options: [
                      { value: '', label: t('ws.settings.reviewer.effort.auto') },
                      { value: 'minimal', label: 'minimal' },
                      { value: 'low', label: 'low' },
                      { value: 'medium', label: 'medium' },
                      { value: 'high', label: 'high' },
                      { value: 'max', label: 'max' },
                    ],
                    onChange: (event) => setReviewer(row.id, 'reasoningEffort', event.target.value),
                  }),
                  h(
                    'div',
                    { className: 'rl-reviewer-actions' },
                    h(LabButton, { label: '✕', variant: 'ghost', title: t('ws.settings.reviewer.remove'), onClick: () => removeReviewer(row.id) }),
                  ),
                )),
              h(
                'div',
                { className: 'rl-form-actions' },
                h(LabButton, {
                  label: t('ws.settings.reviewer.add'),
                  variant: 'ghost',
                  disabled: asArray(draft.reviewers).length >= 4,
                  title: asArray(draft.reviewers).length >= 4 ? t('ws.settings.reviewer.max') : undefined,
                  onClick: addReviewer,
                }),
              ),
            ),
            h(
              'div',
              { className: 'rl-settings-section' },
              h('h3', { className: 'rl-settings-section-title' }, t('ws.settings.section.modelOptions')),
              h('p', { className: 'rl-hint' }, t('ws.settings.modelOptions.hint')),
              asArray(draft.modelOptions).map((row, index) =>
                h(
                  'div',
                  { key: row.id, className: 'rl-model-option-row' },
                  h(LabInput, {
                    value: row.optionId,
                    placeholder: t('ws.settings.modelOption.id'),
                    ariaLabel: t('ws.settings.modelOption.id') + ' ' + String(index + 1),
                    onChange: (event) => setModelOption(row.id, 'optionId', event.target.value),
                  }),
                  h(LabInput, {
                    value: row.provider,
                    placeholder: t('ws.settings.modelOption.provider'),
                    ariaLabel: t('ws.settings.modelOption.provider') + ' ' + String(index + 1),
                    onChange: (event) => setModelOption(row.id, 'provider', event.target.value),
                  }),
                  h(LabInput, {
                    value: row.model,
                    placeholder: t('ws.settings.modelOption.model'),
                    ariaLabel: t('ws.settings.modelOption.model') + ' ' + String(index + 1),
                    onChange: (event) => setModelOption(row.id, 'model', event.target.value),
                  }),
                  h(LabSelect, {
                    value: row.reasoningEffort,
                    ariaLabel: t('ws.settings.modelOption.effort') + ' ' + String(index + 1),
                    options: [{ value: '', label: t('ws.model.effort.inherit') }].concat(
                      ['minimal', 'low', 'medium', 'high', 'max'].map((effort) => ({ value: effort, label: effort })),
                    ),
                    onChange: (event) => setModelOption(row.id, 'reasoningEffort', event.target.value),
                  }),
                  h(LabInput, {
                    value: row.tags,
                    placeholder: t('ws.settings.modelOption.tags'),
                    ariaLabel: t('ws.settings.modelOption.tags') + ' ' + String(index + 1),
                    onChange: (event) => setModelOption(row.id, 'tags', event.target.value),
                  }),
                  h(LabInput, {
                    type: 'number',
                    value: row.priceIn,
                    placeholder: t('ws.settings.modelOption.priceIn'),
                    ariaLabel: t('ws.settings.modelOption.priceIn') + ' ' + String(index + 1),
                    onChange: (event) => setModelOption(row.id, 'priceIn', event.target.value),
                  }),
                  h(LabInput, {
                    type: 'number',
                    value: row.priceOut,
                    placeholder: t('ws.settings.modelOption.priceOut'),
                    ariaLabel: t('ws.settings.modelOption.priceOut') + ' ' + String(index + 1),
                    onChange: (event) => setModelOption(row.id, 'priceOut', event.target.value),
                  }),
                  h(
                    'div',
                    { className: 'rl-reviewer-actions' },
                    h(LabButton, { label: '✕', variant: 'ghost', title: t('ws.settings.modelOption.remove'), onClick: () => removeModelOption(row.id) }),
                  ),
                )),
              h(
                'div',
                { className: 'rl-form-actions' },
                h(LabButton, { label: t('ws.settings.modelOption.add'), variant: 'ghost', onClick: addModelOption }),
              ),
            ),
            h(
              'div',
              { className: 'rl-settings-section' },
              h('h3', { className: 'rl-settings-section-title' }, t('ws.settings.section.routing')),
              h('p', { className: 'rl-hint' }, t('ws.settings.routing.hint')),
              h(
                'div',
                { className: 'rl-settings-checkbox-row' },
                h(
                  'label',
                  { className: 'rl-delete-option' },
                  h('input', {
                    type: 'checkbox',
                    checked: draft.advisorMaySelectModels === true,
                    onChange: (event) => setField('advisorMaySelectModels', event.target.checked === true),
                  }),
                  h('span', null, t('ws.settings.advisorMaySelectModels')),
                ),
                h(
                  'label',
                  { className: 'rl-delete-option' },
                  h('input', {
                    type: 'checkbox',
                    checked: draft.autoUpgrade === true,
                    onChange: (event) => setField('autoUpgrade', event.target.checked === true),
                  }),
                  h('span', null, t('ws.settings.autoUpgrade')),
                ),
              ),
              h(LabField, { label: t('ws.settings.maxAttempts') },
                h(LabInput, {
                  type: 'number',
                  value: draft.routingMaxAttempts,
                  ariaLabel: t('ws.settings.maxAttempts'),
                  onChange: (event) => setField('routingMaxAttempts', event.target.value),
                })),
            ),
            h(
              'div',
              { className: 'rl-settings-section' },
              h('h3', { className: 'rl-settings-section-title' }, t('ws.settings.section.auto')),
              h(
                'div',
                { className: 'rl-form-grid' },
                h(LabField, { label: t('ws.settings.maxCycles') },
                  h(LabInput, {
                    type: 'number',
                    value: draft.maxCycles,
                    ariaLabel: t('ws.settings.maxCycles'),
                    onChange: (event) => setField('maxCycles', event.target.value),
                  })),
                h(LabField, { label: t('ws.settings.maxWallClockMinutes') },
                  h(LabInput, {
                    type: 'number',
                    value: draft.maxWallClockMinutes,
                    ariaLabel: t('ws.settings.maxWallClockMinutes'),
                    onChange: (event) => setField('maxWallClockMinutes', event.target.value),
                  })),
                h(LabField, { label: t('ws.settings.idleCycleLimit') },
                  h(LabInput, {
                    type: 'number',
                    value: draft.idleCycleLimit,
                    ariaLabel: t('ws.settings.idleCycleLimit'),
                    onChange: (event) => setField('idleCycleLimit', event.target.value),
                  })),
                h(LabField, { label: t('ws.settings.maxTokens') },
                  h(LabInput, {
                    type: 'number',
                    value: draft.autoMaxTokens,
                    ariaLabel: t('ws.settings.maxTokens'),
                    onChange: (event) => setField('autoMaxTokens', event.target.value),
                  })),
                h(LabField, { label: t('ws.settings.maxCostUsd') },
                  h(LabInput, {
                    type: 'number',
                    value: draft.autoMaxCostUsd,
                    ariaLabel: t('ws.settings.maxCostUsd'),
                    onChange: (event) => setField('autoMaxCostUsd', event.target.value),
                  })),
                h(LabField, { label: t('ws.settings.clusterPriority'), hint: t('ws.settings.clusterPriorityHint') },
                  h(LabInput, {
                    type: 'number',
                    value: draft.clusterPriority,
                    ariaLabel: t('ws.settings.clusterPriority'),
                    onChange: (event) => setField('clusterPriority', event.target.value),
                  })),
              ),
            ),
            h(
              'div',
              { className: 'rl-settings-section' },
              h('h3', { className: 'rl-settings-section-title' }, t('ws.settings.cluster.title')),
              h('p', { className: 'rl-hint' }, t('ws.settings.cluster.hint')),
              cluster !== null && clusterEnabledOf(cluster)
                ? h(
                    'div',
                    { className: 'rl-report-section' },
                    h(LabInfoRow, { label: t('ws.cluster.mode'), value: t('ws.cluster.mode.' + clusterModeOf(cluster)) }),
                    h(LabInfoRow, {
                      label: t('ws.cluster.connected'),
                      value: asObject(cluster).connected === true ? t('ws.settings.cluster.connected') : t('ws.settings.cluster.disconnected'),
                    }),
                    h(LabInfoRow, { label: t('ws.cluster.machines'), value: String(clusterMachinesOf(cluster).length) }),
                    h(LabInfoRow, { label: t('ws.cluster.queueTitle'), value: String(clusterQueueOf(cluster).length) }),
                    h(LabInfoRow, { label: t('ws.cluster.pools'), value: clusterPoolSummaryTextOf(cluster, t) }),
                  )
                : h('p', { className: 'rl-hint' }, t('ws.cluster.disabled')),
            ),
            h(
              'div',
              { className: 'rl-settings-section' },
              h('h3', { className: 'rl-settings-section-title' }, t('ws.settings.section.limits')),
              h(
                'div',
                { className: 'rl-form-grid' },
                h(LabField, { label: t('ws.settings.nodeTimeoutMinutes') },
                  h(LabInput, {
                    type: 'number',
                    value: draft.nodeTimeoutMinutes,
                    ariaLabel: t('ws.settings.nodeTimeoutMinutes'),
                    onChange: (event) => setField('nodeTimeoutMinutes', event.target.value),
                  })),
                h(LabField, { label: t('ws.settings.maxNodeTimeoutMinutes') },
                  h(LabInput, {
                    type: 'number',
                    value: draft.maxNodeTimeoutMinutes,
                    ariaLabel: t('ws.settings.maxNodeTimeoutMinutes'),
                    onChange: (event) => setField('maxNodeTimeoutMinutes', event.target.value),
                  })),
                h(LabField, { label: t('ws.settings.maxRunningNodes') },
                  h(LabInput, {
                    type: 'number',
                    value: draft.maxRunningNodes,
                    ariaLabel: t('ws.settings.maxRunningNodes'),
                    onChange: (event) => setField('maxRunningNodes', event.target.value),
                  })),
                h(LabField, { label: t('ws.settings.maxNodes') },
                  h(LabInput, {
                    type: 'number',
                    value: draft.maxNodes,
                    ariaLabel: t('ws.settings.maxNodes'),
                    onChange: (event) => setField('maxNodes', event.target.value),
                  })),
              ),
            ),
            h(
              'div',
              { className: 'rl-settings-section' },
              h('h3', { className: 'rl-settings-section-title' }, t('ws.settings.section.pools')),
              h(
                'div',
                { className: 'rl-successor-needs' },
                draft.pools.map((row) =>
                  h(
                    'div',
                    { key: row.id, className: 'rl-need-row' },
                    h(LabInput, {
                      value: row.key,
                      placeholder: t('wizard.pool.key'),
                      ariaLabel: t('wizard.pool.key'),
                      onChange: (event) => setPool(row.id, 'key', event.target.value),
                    }),
                    h(LabInput, {
                      type: 'number',
                      value: row.value,
                      ariaLabel: t('wizard.pool.value'),
                      onChange: (event) => setPool(row.id, 'value', event.target.value),
                    }),
                    h(LabButton, { label: '✕', variant: 'ghost', title: t('wizard.pool.remove'), onClick: () => removePool(row.id) }),
                  )),
              ),
              h('p', { className: 'rl-hint' }, t('ws.settings.pools.hint')),
              h('div', { className: 'rl-form-actions' }, h(LabButton, { label: t('wizard.pool.add'), variant: 'ghost', onClick: addPool })),
            ),
            h(
              'div',
              { className: 'rl-settings-section' },
              h('h3', { className: 'rl-settings-section-title' }, t('ws.settings.section.models')),
              h('p', { className: 'rl-hint' }, t('ws.settings.models.hint')),
              modelField('worker', 'workerProvider', 'workerModel'),
              modelField('advisor', 'advisorProvider', 'advisorModel'),
              modelField('scheduler', 'schedulerProvider', 'schedulerModel'),
            ),
            h(
              'div',
              { className: 'rl-settings-section' },
              h('h3', { className: 'rl-settings-section-title' }, t('ws.settings.section.prompts')),
              h(
                'details',
                { className: 'rl-settings-details' },
                h('summary', null, t('ws.settings.prompts.workerPrefix')),
                h('div', { className: 'rl-settings-details-body' },
                  h(LabTextarea, {
                    value: draft.workerPrefix,
                    rows: 2,
                    ariaLabel: t('ws.settings.prompts.workerPrefix'),
                    onChange: (event) => setField('workerPrefix', event.target.value),
                  })),
              ),
              h(
                'details',
                { className: 'rl-settings-details' },
                h('summary', null, t('ws.settings.prompts.advisor')),
                h('div', { className: 'rl-settings-details-body' },
                  h(LabTextarea, {
                    value: draft.advisorPrompt,
                    rows: 3,
                    ariaLabel: t('ws.settings.prompts.advisor'),
                    onChange: (event) => setField('advisorPrompt', event.target.value),
                  })),
              ),
              h(
                'details',
                { className: 'rl-settings-details' },
                h('summary', null, t('ws.settings.prompts.scheduler')),
                h('div', { className: 'rl-settings-details-body' },
                  h('p', { className: 'rl-hint' }, t('ws.settings.prompts.schedulerHint')),
                  h(LabTextarea, {
                    value: draft.schedulerPrompt,
                    rows: 3,
                    ariaLabel: t('ws.settings.prompts.scheduler'),
                    onChange: (event) => setField('schedulerPrompt', event.target.value),
                  })),
              ),
            ),
            h(
              'div',
              { className: 'rl-settings-section' },
              h('h3', { className: 'rl-settings-section-title' }, t('ws.settings.section.placement')),
              h('p', { className: 'rl-hint' }, t('ws.settings.placement.hint')),
              (() => {
                const savedText = savedPlacement.text;
                const dirty = placementText !== savedText;
                const previewMatches = compileState.result !== null && compileState.result.policy.text === placementText;
                const statusKey = dirty
                  ? (previewMatches ? 'previewed' : 'unsaved')
                  : (savedPlacement.spec !== null ? 'saved' : 'empty');
                return h(
                  'div',
                  { className: 'rl-project-chips' },
                  h('span', { className: 'rl-chip' }, t('ws.settings.placement.status.' + statusKey)),
                  savedPlacement.compiledAt !== null
                    ? h('span', { className: 'rl-chip rl-chip-mono' }, t('ws.settings.placement.compiledAt', { time: formatDateTime(savedPlacement.compiledAt, t) }))
                    : null,
                );
              })(),
              h(LabTextarea, {
                value: placementText,
                rows: 3,
                ariaLabel: t('ws.settings.placement.text'),
                placeholder: t('ws.settings.placement.placeholder'),
                disabled: compileState.busy === true || placementAction !== '',
                onChange: (event) => {
                  setPlacementText(event.target.value);
                  setPlacementError('');
                  setPlacementMessage('');
                },
              }),
              h(
                'div',
                { className: 'rl-form-actions' },
                h(LabButton, {
                  label: compileState.busy ? t('ws.settings.placement.compiling') : t('ws.settings.placement.compile'),
                  disabled: compileState.busy === true || placementAction !== '',
                  onClick: compilePlacement,
                }),
                h(LabButton, {
                  label: placementAction === 'save' ? t('ws.settings.placement.saving') : t('ws.settings.placement.save'),
                  variant: 'primary',
                  disabled: compileState.busy === true || placementAction !== '',
                  onClick: savePlacement,
                }),
                h(LabButton, {
                  label: placementAction === 'clear' ? t('ws.settings.placement.clearing') : t('ws.settings.placement.clear'),
                  variant: 'ghost',
                  disabled: compileState.busy === true || placementAction !== '' || savedPlacement.spec === null,
                  onClick: clearPlacement,
                }),
              ),
              compileState.error !== '' ? h('p', { className: 'rl-error-text', role: 'alert' }, compileState.error) : null,
              placementError !== '' ? h('p', { className: 'rl-error-text', role: 'alert' }, placementError) : null,
              placementMessage !== '' ? h('p', { className: 'rl-config-success', role: 'status' }, placementMessage) : null,
              compileState.result !== null
                ? h(
                    'div',
                    { className: 'rl-report-section' },
                    h('h4', { className: 'rl-report-section-title' }, t('ws.settings.placement.preview')),
                    h(LabInfoRow, { label: t('ws.settings.placement.summary'), value: compileState.result.summary }),
                    compileState.result.explanation.length > 0
                      ? h(
                          'div',
                          { className: 'rl-report-section' },
                          h('h4', { className: 'rl-report-section-title' }, t('ws.settings.placement.explanation')),
                          h('ul', { className: 'rl-report-list' }, compileState.result.explanation.map((item, index) => h('li', { key: index }, item))),
                        )
                      : null,
                    compileState.result.warnings.length > 0
                      ? h(
                          'div',
                          { className: 'rl-report-section' },
                          h('h4', { className: 'rl-report-section-title' }, t('ws.settings.placement.warnings')),
                          h('ul', { className: 'rl-config-warning' }, compileState.result.warnings.map((item, index) => h('li', { key: index }, item))),
                        )
                      : null,
                    h('p', { className: 'rl-hint' }, t('ws.settings.placement.machineCount', { count: compileState.result.catalog.machineCount })),
                    compileState.result.catalog.labelKeys.length === 0 && compileState.result.catalog.models.length === 0
                      ? h('p', { className: 'rl-hint' }, t('ws.settings.placement.catalogEmpty'))
                      : h(
                          'div',
                          { className: 'rl-project-chips' },
                          compileState.result.catalog.labelKeys.map((key) => h(
                            'span',
                            { key: 'label-' + key, className: 'rl-chip rl-chip-mono' },
                            key + ': ' + stringListOf(compileState.result.catalog.labels[key]).join(', '),
                          )),
                          compileState.result.catalog.models.map((model) => h(
                            'span',
                            { key: 'model-' + model, className: 'rl-chip' },
                            model,
                          )),
                        ),
                  )
                : null,
              savedPlacement.spec !== null
                ? h(
                    'div',
                    { className: 'rl-report-section' },
                    h('h4', { className: 'rl-report-section-title' }, t('ws.settings.placement.savedPolicy')),
                    savedPlacement.summary !== '' ? h('p', { className: 'rl-text-prewrap' }, savedPlacement.summary) : null,
                    h(
                      'div',
                      { className: 'rl-project-chips' },
                      placementRuleChipsOf(savedPlacement, t).map((chip, index) => h('span', { key: index, className: 'rl-chip' }, chip)),
                    ),
                    savedPlacement.warnings.length > 0
                      ? h('ul', { className: 'rl-config-warning' }, savedPlacement.warnings.map((item, index) => h('li', { key: index }, item)))
                      : null,
                  )
                : null,
            ),
            error ? h('p', { className: 'rl-error-text', role: 'alert' }, t('ws.settings.error') + ': ' + error) : null,
          ),
          h(
            'div',
            { className: 'rl-modal-foot' },
            h(LabButton, { label: t('ws.settings.reset'), variant: 'ghost', onClick: reset }),
            h(LabButton, { label: t('ws.settings.cancel'), variant: 'ghost', onClick: onClose }),
            h(LabButton, {
              label: saving ? t('ws.settings.saving') : t('ws.settings.save'),
              variant: 'primary',
              disabled: saving,
              onClick: save,
            }),
          ),
        ),
      );
    }

    /** Inline Step result banner (summary or localized error). */
    function StepBanner({ info, onDismiss, t }) {
      const record = asObject(info);
      const isError = record.kind === 'error';
      return h(
        'div',
        { className: 'rl-step-banner' + (isError ? ' rl-step-banner-error' : ''), role: 'status' },
        h('span', { className: 'rl-step-banner-text' + (isError ? '' : ' rl-step-banner-ok') }, record.text || ''),
        record.meta ? h('span', { className: 'rl-step-banner-meta' }, record.meta) : null,
        h(LabButton, { label: t('ws.step.dismiss'), variant: 'ghost', onClick: onDismiss }),
      );
    }

    /** One collapsed JSON document (details/summary, no state needed). */
    function JsonBlock({ title, value, open }) {
      const text = stringifyPayload(value);
      return h(
        'details',
        { className: 'rl-json', open: open === true || undefined },
        h('summary', null, title),
        h('pre', { className: 'rl-json-pre' }, text === '' ? '—' : text),
      );
    }

    function rejectedTextsOf(run) {
      const out = [];
      for (const entry of asArray(asObject(run).rejected)) {
        if (typeof entry === 'string') {
          if (entry.trim()) out.push(entry.trim());
          continue;
        }
        const reason = firstString(asObject(entry).reason);
        if (reason) out.push(reason);
        else {
          const text = stringifyPayload(entry);
          if (text) out.push(text);
        }
      }
      return out;
    }

    /** Full run record: analysis, rejected proposals and collapsible JSON payloads. */
    function RunDetailView({ state, onBack, onRetry, t }) {
      if (state.phase === 'loading' || state.phase === 'idle') {
        return h('div', { className: 'rl-modal-body' }, h(LabLoading, { label: t('ws.runs.detail.loading') }));
      }
      if (state.phase === 'error') {
        return h(
          'div',
          { className: 'rl-modal-body' },
          h('p', { className: 'rl-error-text', role: 'alert' }, t('ws.runs.detail.error') + ': ' + state.error),
          h('div', { className: 'rl-form-actions' }, h(LabButton, { label: t('common.retry'), onClick: onRetry })),
        );
      }
      const run = asObject(state.run);
      const role = runRoleOf(run);
      const status = runStatusOf(run);
      const analysis = firstString(run.analysis);
      const errorText = runErrorTextOf(run);
      const rejected = rejectedTextsOf(run);
      const roleLabel = runRoleLabelOf(role, t);
      const statusLabel = status === 'running' || status === 'completed' || status === 'failed'
        ? t('ws.runs.status.' + status)
        : status;
      const gcSummary = role === 'gc' ? runGcSummaryOf(run) : '';
      const gcRecommendation = role === 'gc' ? runGcRecommendationOf(run) : '';
      return h(
        'div',
        { className: 'rl-modal-body' },
        h(
          'div',
          { className: 'rl-run-head' },
          h('span', { className: 'rl-run-role' }, roleLabel),
          h('span', { className: 'rl-run-status rl-run-status-' + status }, h(StatusDot, { status: status === 'running' ? 'running' : status === 'failed' ? 'failed' : 'completed' }), statusLabel),
          h('span', { className: 'rl-run-meta' }, t('ws.runs.duration', { time: formatDurationBetween(run.startedAt, run.endedAt) })),
          runIdOf(run) ? h('span', { className: 'rl-chip rl-chip-mono' }, runIdOf(run)) : null,
        ),
        h(LabInfoRow, { label: t('ws.runs.detail.session'), value: firstString(run.sessionId), mono: true }),
        h(LabInfoRow, { label: t('ws.runs.detail.model'), value: firstString(asObject(run.model).model, run.model), mono: true }),
        runLensOf(run) ? h(LabInfoRow, { label: t('ws.runs.lensLabel'), value: runLensOf(run) }) : null,
        runPanelSizeOf(run) !== null ? h(LabInfoRow, { label: t('ws.runs.panelLabel'), value: formatTokenCount(runPanelSizeOf(run)) }) : null,
        runUsageOf(run) !== null ? h(UsageRows, { usage: runUsageOf(run), title: t('ws.usage.title'), t }) : null,
        firstString(run.stopReason) ? h(LabInfoRow, { label: t('ws.runs.stopReason'), value: firstString(run.stopReason) }) : null,
        errorText ? h('p', { className: 'rl-run-error', role: 'alert' }, t('ws.runs.detail.errorLabel') + ': ' + errorText) : null,
        analysis ? h('div', { className: 'rl-report-section' }, h('h4', { className: 'rl-report-section-title' }, t('ws.runs.detail.analysis')), h('p', { className: 'rl-text-prewrap' }, analysis)) : null,
        gcSummary ? h('div', { className: 'rl-report-section' }, h('h4', { className: 'rl-report-section-title' }, t('ws.gc.summary')), h('p', { className: 'rl-text-prewrap' }, gcSummary)) : null,
        gcRecommendation ? h('div', { className: 'rl-report-section' }, h('h4', { className: 'rl-report-section-title' }, t('ws.gc.recommendation')), h('p', { className: 'rl-text-prewrap' }, gcRecommendation)) : null,
        rejected.length > 0
          ? h(
              'div',
              { className: 'rl-report-section' },
              h('h4', { className: 'rl-report-section-title' }, t('ws.runs.detail.rejected')),
              h('ul', { className: 'rl-report-list rl-report-blockers' }, rejected.map((item, index) => h('li', { key: index }, item))),
            )
          : null,
        h(JsonBlock, { title: t('ws.runs.detail.input'), value: run.inputSnapshot }),
        h(JsonBlock, { title: t('ws.runs.detail.output'), value: run.output }),
        h(
          'div',
          { className: 'rl-form-actions' },
          h(LabButton, { label: t('ws.runs.back'), variant: 'ghost', onClick: onBack }),
          h(LabButton, { label: t('ws.runs.detail.refresh'), onClick: onRetry }),
        ),
      );
    }

    /** One advisor/scheduler run row; clicking opens the full record. */
    function RunRow({ run, onOpen, t }) {
      const role = runRoleOf(run);
      const status = runStatusOf(run);
      const created = idListOf(asObject(run).createdNodeIds).length;
      const started = idListOf(asObject(run).startedNodeIds).length;
      const rejected = asArray(asObject(run).rejected).length;
      const roleLabel = runRoleLabelOf(role, t);
      const errorText = runErrorTextOf(run);
      const gcSummary = role === 'gc' ? runGcSummaryOf(run) : '';
      const gcRecommendation = role === 'gc' ? runGcRecommendationOf(run) : '';
      const lens = runLensOf(run);
      const panelSize = runPanelSizeOf(run);
      const usage = runUsageOf(run);
      return h(
        'li',
        null,
        h(
          'button',
          { type: 'button', className: 'rl-run-row', 'aria-label': t('ws.runs.openDetail'), onClick: onOpen },
          h(
            'span',
            { className: 'rl-run-head' },
            h('span', { className: 'rl-run-role' }, roleLabel),
            h(
              'span',
              { className: 'rl-run-status rl-run-status-' + status },
              h(StatusDot, { status: status === 'running' ? 'running' : status === 'failed' ? 'failed' : 'completed' }),
              t('ws.runs.status.' + status),
            ),
            h('span', { className: 'rl-run-meta' }, t('ws.runs.duration', { time: formatDurationBetween(run.startedAt, run.endedAt) })),
          ),
          h(
            'span',
            { className: 'rl-run-chips' },
            h('span', { className: 'rl-chip' }, t('ws.runs.created', { count: created })),
            h('span', { className: 'rl-chip' }, t('ws.runs.started', { count: started })),
            rejected > 0 ? h('span', { className: 'rl-chip' }, t('ws.runs.rejected', { count: rejected })) : null,
            lens ? h('span', { className: 'rl-chip rl-chip-merge' }, t('ws.runs.lens', { lens })) : null,
            panelSize !== null ? h('span', { className: 'rl-chip' }, t('ws.runs.panel', { count: panelSize })) : null,
            usage !== null ? h('span', { className: 'rl-chip rl-chip-usage' }, t('ws.usage.chip', { count: formatTokenCount(usageTotalOf(usage)) })) : null,
            firstString(run.stopReason) ? h('span', { className: 'rl-chip' }, t('ws.runs.stopReason') + ': ' + firstString(run.stopReason)) : null,
          ),
          errorText ? h('p', { className: 'rl-run-error' }, errorText) : null,
          gcRecommendation ? h('p', { className: 'rl-run-meta' }, t('ws.gc.recommendation') + ': ' + gcRecommendation) : null,
          gcSummary ? h('p', { className: 'rl-run-meta' }, t('ws.gc.summary') + ': ' + gcSummary) : null,
        ),
      );
    }

    /** One cycle row with trigger, counts, skipped stages and errors. */
    function CycleRow({ cycle, t }) {
      const record = asObject(cycle);
      const created = idListOf(record.createdNodeIds).length;
      const started = idListOf(record.startedNodeIds).length;
      const skipped = asArray(record.skipped);
      const errors = stringListOf(record.errors);
      return h(
        'li',
        null,
        h(
          'div',
          { className: 'rl-cycle-row' },
          h(
            'span',
            { className: 'rl-run-head' },
            h('span', { className: 'rl-run-role' }, firstString(record.trigger) || t('ws.runs.tab.cycles')),
            h('span', { className: 'rl-run-meta' }, t('ws.runs.duration', { time: formatDurationBetween(record.startedAt, record.endedAt) })),
            firstString(record.id) ? h('span', { className: 'rl-chip rl-chip-mono' }, firstString(record.id)) : null,
          ),
          h(
            'span',
            { className: 'rl-run-chips' },
            h('span', { className: 'rl-chip' }, t('ws.runs.created', { count: created })),
            h('span', { className: 'rl-chip' }, t('ws.runs.started', { count: started })),
            skipped.length > 0 ? h('span', { className: 'rl-chip' }, t('ws.runs.skipped', { count: skipped.length })) : null,
            errors.length > 0 ? h('span', { className: 'rl-chip' }, t('ws.runs.errors', { count: errors.length })) : null,
          ),
          skipped.length > 0
            ? h(
                'span',
                { className: 'rl-run-meta' },
                skipped.map((entry, index) => {
                  const item = asObject(entry);
                  const stage = firstString(item.stage);
                  const reason = firstString(item.reason);
                  return (stage || reason) ? (index > 0 ? ' · ' : '') + [stage, reason].filter((part) => part !== '').join(': ') : '';
                }),
              )
            : null,
          errors.length > 0 ? h('p', { className: 'rl-run-error' }, errors.join(' · ')) : null,
        ),
      );
    }

    /** Runs/cycles panel: list + detail; polls `/runs` every 2s while mounted. */
    function RunsPanel({ projectId, initialRunId, onClose, t }) {
      const { state, retry } = useRuns(projectId, t);
      const [tab, setTab] = React.useState('runs');
      const [selectedRunId, setSelectedRunId] = React.useState(
        typeof initialRunId === 'string' && initialRunId.length > 0 ? initialRunId : null,
      );
      const detail = useRunDetail(projectId, selectedRunId, t);

      let listBody;
      if (state.phase === 'loading') {
        listBody = h(LabLoading, { label: t('ws.runs.loading') });
      } else if (state.phase === 'error') {
        listBody = h(
          'div',
          { className: 'rl-field' },
          h('p', { className: 'rl-error-text', role: 'alert' }, t('ws.runs.error') + ': ' + state.error),
          h(LabButton, { label: t('common.retry'), onClick: retry }),
        );
      } else if (tab === 'runs') {
        listBody = state.runs.length === 0
          ? h('p', { className: 'rl-transcript-empty' }, t('ws.runs.empty'))
          : h(
              'ul',
              { className: 'rl-run-list' },
              state.runs.map((run, index) =>
                h(RunRow, {
                  key: runIdOf(run) || 'run-' + index,
                  run,
                  onOpen: () => setSelectedRunId(runIdOf(run)),
                  t,
                })),
            );
      } else {
        listBody = state.cycles.length === 0
          ? h('p', { className: 'rl-transcript-empty' }, t('ws.runs.empty'))
          : h(
              'ul',
              { className: 'rl-run-list' },
              state.cycles.map((cycle, index) => h(CycleRow, { key: firstString(asObject(cycle).id) || 'cycle-' + index, cycle, t })),
            );
      }

      return h(
        'div',
        { className: 'rl-overlay-layer' },
        h(
          'div',
          { className: 'rl-modal rl-modal-wide', role: 'dialog', 'aria-label': t('ws.runs.title') },
          h(
            'div',
            { className: 'rl-modal-head' },
            h('h2', { className: 'rl-modal-title' }, selectedRunId === null ? t('ws.runs.title') : t('ws.runs.detail')),
            h('span', { className: 'rl-card-meta' }, t('ws.runs.count', { runs: state.runs.length, cycles: state.cycles.length })),
            h(LabButton, { label: '✕', variant: 'ghost', title: t('ws.runs.close'), onClick: onClose }),
          ),
          selectedRunId !== null
            ? h(RunDetailView, { state: detail.state, onBack: () => setSelectedRunId(null), onRetry: detail.retry, t })
            : h(
                'div',
                { className: 'rl-modal-body' },
                state.error !== null
                  ? h(
                      'div',
                      { className: 'rl-transcript-error', role: 'alert' },
                      h('span', { className: 'rl-error-text' }, state.error),
                      h(LabButton, { label: t('common.retry'), variant: 'ghost', onClick: retry }),
                    )
                  : null,
                h(
                  'div',
                  { className: 'rl-tabs', role: 'tablist' },
                  h(
                    'button',
                    { type: 'button', className: 'rl-tab' + (tab === 'runs' ? ' rl-tab-active' : ''), 'aria-selected': tab === 'runs', onClick: () => setTab('runs') },
                    t('ws.runs.tab.runs'),
                  ),
                  h(
                    'button',
                    { type: 'button', className: 'rl-tab' + (tab === 'cycles' ? ' rl-tab-active' : ''), 'aria-selected': tab === 'cycles', onClick: () => setTab('cycles') },
                    t('ws.runs.tab.cycles'),
                  ),
                ),
                listBody,
              ),
        ),
      );
    }

    /** Successor dialog: creates one planned child from the parent HEAD and seals it. */
    /** Catalog-backed model selector: option profile or free provider/model, plus effort. */
    function ModelPicker({ model, onChange, modelOptions, disabled, t }) {
      const record = asObject(model);
      const options = asArray(modelOptions);
      const profileId = firstString(record.profileId);
      const hasFreeRef = profileId === '' && (firstString(record.provider) !== '' || firstString(record.model) !== '');
      const selectValue = profileId !== '' ? 'profile:' + profileId : hasFreeRef ? '__free' : '';
      const selected = options.filter((option) => option.id === profileId)[0] || null;
      const effortValue = firstString(record.reasoningEffort);
      const effortChoices = selected !== null && selected.efforts.length > 0
        ? selected.efforts
        : ['minimal', 'low', 'medium', 'high', 'max'];
      const labelOfOption = (option) => {
        const parts = [option.provider + '/' + option.model];
        if (option.reasoningEffort) parts.push('·' + option.reasoningEffort);
        if (option.priceIn > 0 || option.priceOut > 0) {
          parts.push('(' + formatUsdAmount(option.priceIn) + '/' + formatUsdAmount(option.priceOut) + ')');
        }
        const tag = option.tags.length > 0 ? '[' + option.tags[0] + '] ' : '';
        return tag + option.id + ' · ' + parts.join(' ');
      };
      const choices = [{ value: '', label: t('ws.model.inherit') }]
        .concat(options.map((option) => ({ value: 'profile:' + option.id, label: labelOfOption(option) })))
        .concat([{ value: '__free', label: t('ws.model.free') }]);
      const changeEffort = (value) => {
        if (hasFreeRef || selectValue === '__free') {
          const next = { provider: firstString(record.provider), model: firstString(record.model) };
          if (value !== '') next.reasoningEffort = value;
          onChange(next);
          return;
        }
        if (profileId === '') {
          onChange(value === '' ? null : { reasoningEffort: value });
          return;
        }
        const next = { profileId };
        if (value !== '') next.reasoningEffort = value;
        onChange(next);
      };
      const changeFree = (field, value) => {
        const next = {
          provider: field === 'provider' ? value : firstString(record.provider),
          model: field === 'model' ? value : firstString(record.model),
        };
        if (effortValue !== '') next.reasoningEffort = effortValue;
        if (next.provider === '' && next.model === '' && next.reasoningEffort === undefined) onChange(null);
        else onChange(next);
      };
      return h(
        'div',
        { className: 'rl-model-picker' },
        h(
          'div',
          { className: 'rl-form-grid' },
          h(LabField, { label: t('ws.model.title'), hint: t('ws.model.inheritHint') },
            h(LabSelect, {
              value: selectValue,
              ariaLabel: t('ws.model.title'),
              disabled: disabled === true,
              options: choices,
              onChange: (event) => {
                const value = event.target.value;
                if (value === '') {
                  onChange(null);
                  return;
                }
                if (value === '__free') {
                  onChange({ provider: firstString(record.provider), model: firstString(record.model) });
                  return;
                }
                const id = value.slice('profile:'.length);
                const option = options.filter((entry) => entry.id === id)[0];
                if (!option) return;
                const next = { profileId: option.id };
                const effort = option.defaultEffort || option.reasoningEffort;
                if (effort) next.reasoningEffort = effort;
                onChange(next);
              },
            })),
          h(LabField, { label: t('ws.model.effort') },
            h(LabSelect, {
              value: effortValue,
              ariaLabel: t('ws.model.effort'),
              disabled: disabled === true || selectValue === '',
              options: [{ value: '', label: t('ws.model.effort.inherit') }].concat(
                effortChoices.map((effort) => ({ value: effort, label: effort })),
              ),
              onChange: (event) => changeEffort(event.target.value),
            })),
        ),
        selected !== null && selected.available === false
          ? h('p', { className: 'rl-hint rl-merge-conflicts' }, t('ws.model.unavailable', { reason: selected.reason || '' }))
          : null,
        selectValue === '__free' || options.length === 0
          ? h(
              'div',
              { className: 'rl-form-grid' },
              h(LabField, { label: t('ws.model.freeProvider') },
                h(LabInput, {
                  value: firstString(record.provider),
                  ariaLabel: t('ws.model.freeProvider'),
                  disabled: disabled === true,
                  onChange: (event) => changeFree('provider', event.target.value),
                })),
              h(LabField, { label: t('ws.model.freeModel') },
                h(LabInput, {
                  value: firstString(record.model),
                  ariaLabel: t('ws.model.freeModel'),
                  disabled: disabled === true,
                  onChange: (event) => changeFree('model', event.target.value),
                })),
            )
          : null,
      );
    }

    function SuccessorModal({ project, parent, onClose, onSubmit, modelOptions, t }) {
      const parentId = nodeIdOf(parent);
      const parentTitle = nodeTitleOf(parent, t);
      const parentNeeds = nodeNeedsEntries(parent);
      const [title, setTitle] = React.useState('');
      const [prompt, setPrompt] = React.useState('');
      const [criteria, setCriteria] = React.useState('');
      const [timebox, setTimebox] = React.useState(String(nodeTimeboxMinutesOf(parent, project)));
      const [needs, setNeeds] = React.useState(
        parentNeeds.length > 0
          ? parentNeeds.map((entry, index) => ({ id: 'need-' + index, key: entry.key, value: String(entry.amount) }))
          : [],
      );
      const [submitting, setSubmitting] = React.useState(false);
      const [error, setError] = React.useState('');
      const [model, setModel] = React.useState(null);
      const needSeqRef = React.useRef(needs.length);
      const maxMinutes = Math.round(projectMaxTimeoutMinutes(project));

      const updateNeed = (id, field, value) => {
        setNeeds((previous) => previous.map((need) => (need.id === id ? { ...need, [field]: value } : need)));
      };
      const addNeed = () => {
        needSeqRef.current += 1;
        setNeeds((previous) => previous.concat([{ id: 'need-' + needSeqRef.current, key: '', value: '1' }]));
      };
      const removeNeed = (id) => {
        setNeeds((previous) => previous.filter((need) => need.id !== id));
      };

      const submit = async () => {
        if (submitting) return;
        if (!title.trim()) {
          setError(t('ws.successor.required.title'));
          return;
        }
        if (!prompt.trim()) {
          setError(t('ws.successor.required.prompt'));
          return;
        }
        if (prompt.trim().length < 10) {
          setError(t('ws.successor.required.promptMin'));
          return;
        }
        const minutes = parseInteger(timebox, 0);
        if (minutes < 1 || minutes > maxMinutes) {
          setError(t('ws.inspector.timebox.invalid', { max: maxMinutes }));
          return;
        }
        const needsMap = {};
        for (const need of needs) {
          const key = String(need.key === undefined || need.key === null ? '' : need.key).trim();
          if (!key) continue;
          const amount = parseInteger(need.value, 0);
          if (amount <= 0) continue;
          if (Object.prototype.hasOwnProperty.call(needsMap, key)) {
            setError(t('wizard.pools.duplicate'));
            return;
          }
          needsMap[key] = amount;
        }
        const modelPayload = modelPayloadOf(model);
        setSubmitting(true);
        setError('');
        const result = await onSubmit({
          type: 'node.successor',
          nodeId: parentId,
          title: title.trim(),
          prompt: prompt.trim(),
          successCriteria: criteria.trim(),
          timeboxMinutes: minutes,
          needs: needsMap,
          ...(modelPayload === undefined ? {} : { model: modelPayload }),
        });
        setSubmitting(false);
        if (result !== null && result !== undefined && result.ok === true) {
          onClose();
        } else {
          setError((result && result.error) || t('ws.successor.error'));
        }
      };

      return h(
        'div',
        { className: 'rl-overlay-layer rl-overlay-layer-drawer-above' },
        h(
          'div',
          { className: 'rl-modal', role: 'dialog', 'aria-label': t('ws.successor.title', { title: parentTitle }) },
          h(
            'div',
            { className: 'rl-modal-head' },
            h('h2', { className: 'rl-modal-title' }, t('ws.successor.title', { title: parentTitle })),
            h(LabButton, { label: '✕', variant: 'ghost', title: t('ws.successor.close'), onClick: onClose }),
          ),
          h(
            'div',
            { className: 'rl-modal-body' },
            h('p', { className: 'rl-modal-note' }, t('ws.successor.intro')),
            h(LabField, { label: t('ws.successor.field.title') },
              h(LabInput, {
                value: title,
                placeholder: t('ws.successor.field.titlePlaceholder'),
                ariaLabel: t('ws.successor.field.title'),
                onChange: (event) => {
                  setTitle(event.target.value);
                  setError('');
                },
              })),
            h(LabField, { label: t('ws.successor.field.prompt') },
              h(LabTextarea, {
                value: prompt,
                placeholder: t('ws.successor.field.promptPlaceholder'),
                ariaLabel: t('ws.successor.field.prompt'),
                rows: 5,
                onChange: (event) => {
                  setPrompt(event.target.value);
                  setError('');
                },
              })),
            h(LabField, { label: t('ws.successor.field.criteria') },
              h(LabTextarea, {
                value: criteria,
                placeholder: t('ws.successor.field.criteriaPlaceholder'),
                ariaLabel: t('ws.successor.field.criteria'),
                rows: 2,
                onChange: (event) => setCriteria(event.target.value),
              })),
            h(
              'div',
              { className: 'rl-form-grid' },
              h(LabField, { label: t('ws.successor.field.timebox'), hint: t('ws.inspector.timebox.hint', { max: maxMinutes }) },
                h(LabInput, {
                  type: 'number',
                  value: timebox,
                  ariaLabel: t('ws.successor.field.timebox'),
                  onChange: (event) => {
                    setTimebox(event.target.value);
                    setError('');
                  },
                })),
            ),
            h(
              'div',
              { className: 'rl-field' },
              h('span', { className: 'rl-label' }, t('ws.successor.field.needs')),
              h(
                'div',
                { className: 'rl-successor-needs' },
                needs.map((need) =>
                  h(
                    'div',
                    { key: need.id, className: 'rl-need-row' },
                    h(LabInput, {
                      value: need.key,
                      placeholder: t('ws.successor.needKey'),
                      ariaLabel: t('ws.successor.needKey'),
                      onChange: (event) => updateNeed(need.id, 'key', event.target.value),
                    }),
                    h(LabInput, {
                      type: 'number',
                      value: need.value,
                      ariaLabel: t('ws.successor.needValue'),
                      onChange: (event) => updateNeed(need.id, 'value', event.target.value),
                    }),
                    h(LabButton, { label: '✕', variant: 'ghost', title: t('ws.successor.removeNeed'), onClick: () => removeNeed(need.id) }),
                  )),
              ),
              h('div', { className: 'rl-form-actions' }, h(LabButton, { label: t('ws.successor.addNeed'), variant: 'ghost', onClick: addNeed })),
            ),
            h(LabField, { label: t('ws.model.title'), hint: t('ws.model.inheritHint') },
            h(ModelPicker, { model, onChange: setModel, modelOptions, disabled: submitting, t })),
          error ? h('p', { className: 'rl-error-text', role: 'alert' }, t('ws.successor.error') + ': ' + error) : null,
          ),
          h(
            'div',
            { className: 'rl-modal-foot' },
            h('p', { className: 'rl-modal-foot-note' }, t('ws.sealed.successorHint')),
            h(LabButton, { label: t('ws.successor.cancel'), variant: 'ghost', onClick: onClose }),
            h(LabButton, {
              label: submitting ? t('ws.successor.creating') : t('ws.successor.submit'),
              variant: 'primary',
              disabled: submitting,
              onClick: submit,
            }),
          ),
        ),
      );
    }

    /** Bottom activity log fed by `/events`; clickable rows select their node. */
    function ActivityLog({ events, onSelectNode, onOpenRun, t }) {
      const [expanded, setExpanded] = React.useState(true);
      const listRef = React.useRef(null);
      const followRef = React.useRef(true);
      const latest = events.length > 0 ? events[events.length - 1] : null;

      React.useEffect(() => {
        const list = listRef.current;
        if (list && followRef.current) list.scrollTop = list.scrollHeight;
      }, [events]);

      const onScroll = () => {
        const list = listRef.current;
        if (!list) return;
        followRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
      };

      return h(
        'section',
        { className: 'rl-log', 'aria-label': t('ws.log.title') },
        h(
          'div',
          { className: 'rl-log-head' },
          h(
            'button',
            {
              type: 'button',
              className: 'rl-log-toggle',
              'aria-expanded': expanded,
              onClick: () => setExpanded((value) => !value),
            },
            (expanded ? '▾ ' : '▸ ') + t('ws.log.title'),
          ),
          h('span', { className: 'rl-card-meta' }, t('ws.log.count', { count: events.length })),
          !expanded && latest !== null ? h('span', { className: 'rl-log-latest' }, eventSummary(latest, t)) : null,
        ),
        expanded
          ? events.length === 0
            ? h('p', { className: 'rl-log-empty' }, t('ws.log.empty'))
            : h(
                'ul',
                { className: 'rl-log-list', ref: listRef, onScroll },
                events.map((event, index) =>
                  h(ActivityLogRow, { key: eventKeyOf(event, index), event, onSelectNode, onOpenRun, t })),
              )
          : null,
      );
    }

    function eventKeyOf(event, index) {
      const seq = finiteNumber(asObject(event).seq);
      return seq === null ? 'event-' + index : 'event-' + seq;
    }
    function eventLabelOf(event, t) {
      const type = firstString(asObject(event).type, asObject(event).kind);
      if (!type) return t('common.unknown');
      const localeKey = EVENT_LABEL_KEYS[type];
      return localeKey === undefined ? type : t(localeKey);
    }
    function eventDetailOf(event) {
      const data = asObject(asObject(event).data);
      const candidates = ['message', 'summary', 'title', 'reason', 'detail'];
      for (const key of candidates) {
        const value = data[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
      }
      return '';
    }
    function eventSummary(event, t) {
      const record = asObject(event);
      const node = firstString(record.nodeId);
      return formatClock(record.at, t) + ' · ' + eventLabelOf(event, t) + (node ? ' · ' + node : '');
    }
    function ActivityLogRow({ event, onSelectNode, onOpenRun, t }) {
      const record = asObject(event);
      const data = asObject(record.data);
      const nodeId = firstString(record.nodeId, record.node);
      const runId = firstString(data.runId, record.runId);
      const cycleId = firstString(data.cycleId, record.cycleId);
      const content = [
        h('span', { key: 'time', className: 'rl-log-time' }, formatClock(record.at, t)),
        h('span', { key: 'type', className: 'rl-log-type' }, eventLabelOf(event, t) + (nodeId ? ' · ' + nodeId : '')),
        h('span', { key: 'detail', className: 'rl-log-detail' }, eventDetailOf(event)),
      ];
      if (nodeId) {
        return h(
          'li',
          { className: 'rl-log-list-item' },
          h('button', { type: 'button', className: 'rl-log-row-btn', onClick: () => onSelectNode(nodeId) }, content),
        );
      }
      if (runId || cycleId) {
        return h(
          'li',
          { className: 'rl-log-list-item' },
          h(
            'button',
            {
              type: 'button',
              className: 'rl-log-row-btn',
              title: t('ws.log.openRun'),
              onClick: () => onOpenRun(runId || null),
            },
            content,
          ),
        );
      }
      return h('li', { className: 'rl-log-list-item' }, h('div', { className: 'rl-log-row' }, content));
    }

    /** Inline polling-failure banner with countdown hint and immediate retry. */
    function PollBanner({ offline, onRetry, t }) {
      const info = asObject(offline);
      const delay = finiteNumber(info.delay);
      return h(
        'div',
        { className: 'rl-banner', role: 'alert' },
        h('span', { className: 'rl-banner-dot', 'aria-hidden': true }),
        h('span', { className: 'rl-banner-text' }, t('ws.poll.offline') + (info.message ? ' · ' + info.message : '')),
        delay !== null
          ? h('span', { className: 'rl-banner-meta' }, t('ws.poll.nextRetry', { seconds: Math.round(delay / 100) / 10 }))
          : null,
        h(LabButton, { label: t('ws.poll.retry'), variant: 'ghost', onClick: onRetry }),
      );
    }
    // #endregion

    // #region page, error boundary, sidebar icon
    /** Inline chrome for the crash fallback (the panel stylesheet may not be mounted). */
    const CRASH_STYLE = {
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      height: '100%',
      padding: 24,
      background: 'var(--dsw-alias-bg-base)',
      color: 'var(--dsw-alias-label-primary)',
      fontFamily: 'inherit',
      fontSize: 13,
      lineHeight: '20px',
    };
    const CRASH_TITLE_STYLE = {
      margin: 0,
      color: 'var(--dsw-alias-state-error-primary)',
      fontSize: 14,
      fontWeight: 500,
      lineHeight: '22px',
    };
    const CRASH_LINE_STYLE = {
      margin: 0,
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: 12,
      lineHeight: '18px',
      overflowWrap: 'anywhere',
    };

    /**
     * Contain a render crash to this slot entry: the framework blanks a slot entry
     * whose component throws, so the panel renders its own inline fallback instead.
     */
    class MetainferLabErrorBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error, info) {
        console.error('[metainfer-research-lab] panel crashed:', error, info);
      }

      render() {
        if (this.state.error === null) return this.props.children;
        const t = typeof this.props.t === 'function' ? this.props.t : (key) => key;
        const message = this.state.error instanceof Error ? this.state.error.message : String(this.state.error);
        return h(
          'section',
          { role: 'alert', style: CRASH_STYLE },
          h('p', { style: CRASH_TITLE_STYLE }, t('crash.title')),
          h('p', { style: CRASH_LINE_STYLE }, t('crash.hint')),
          h('p', { style: CRASH_LINE_STYLE }, message),
        );
      }
    }

    /**
     * Keyed `main` slot page. The only local routing state is the selected project
     * id; everything else is fetched from the Host by the screen below it.
     */
    function MetainferLabPage(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const openNativeSession = typeof props.openNativeSession === 'function' ? props.openNativeSession : null;
      const [activeProjectId, setActiveProjectId] = React.useState(null);
      const openProject = React.useCallback((projectId) => {
        setActiveProjectId(typeof projectId === 'string' && projectId.length > 0 ? projectId : null);
      }, []);
      const backToList = React.useCallback(() => {
        setActiveProjectId(null);
      }, []);
      return h(
        MetainferLabErrorBoundary,
        { t },
        activeProjectId === null
          ? h(LandingScreen, { key: 'landing', t, onOpenProject: openProject })
          : h(WorkspaceScreen, {
              key: activeProjectId,
              projectId: activeProjectId,
              onBack: backToList,
              openNativeSession,
              t,
            }),
      );
    }

    /**
     * Original DAG glyph for the sidebar rail: one root, two branches and one
     * merge, drawn with `currentColor`. Decorative — the sidebar row owns the
     * accessible label, and the active row asks for the brand color.
     */
    function MetainferLabIcon({ size, active }) {
      const edge = typeof size === 'number' && size > 0 ? size : 16;
      const color = active === true
        ? 'var(--dsw-alias-brand-primary)'
        : 'var(--dsw-alias-label-secondary)';
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: edge,
          height: edge,
          'aria-hidden': true,
          focusable: 'false',
          style: { display: 'block', flex: 'none', color },
        },
        h(
          'g',
          { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' },
          h('path', { d: 'M8 3.4 L3.6 8' }),
          h('path', { d: 'M8 3.4 L12.4 8' }),
          h('path', { d: 'M3.6 8 L8 12.6' }),
          h('path', { d: 'M12.4 8 L8 12.6' }),
        ),
        h('circle', { cx: 8, cy: 3.4, r: 1.6, fill: 'currentColor' }),
        h('circle', { cx: 3.6, cy: 8, r: 1.35, fill: 'currentColor' }),
        h('circle', { cx: 12.4, cy: 8, r: 1.35, fill: 'currentColor' }),
        h('circle', { cx: 8, cy: 12.6, r: 1.6, fill: 'currentColor' }),
      );
    }
    // #endregion

    return {
      inject: ['slots', 'locale', 'sessions', 'uiWorkspace'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, { zh, en }),
          'metainfer-research-lab: dictionaries',
        );
        const t = ctx.locale.bind(NS);
        const openNativeSession = buildNativeOpener(ctx);

        ctx.slots.inject('main', () =>
          ctx.slots.register(
            { name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ t, openNativeSession }) },
            MetainferLabPage,
          ),
        );

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 20,
              locale: NS,
              label: () => t('panel'),
            },
            MetainferLabIcon,
          ),
        );
      },
    };
  },
});
