# 06 · 扩展方案：跨项目/跨用户 GPU 协调 与 节点级模型路由

> 状态：**V3 已实现并在本机验证**（2026-10-23；节点级模型 + 轻量多实例整卡 GPU 协调器）。原始设计保留在正文，实现映射与验证见第 8 节。对应两个后续方向：
> 1. 多项目 / 多用户共享 GPU 集群时的全局资源协调；
> 2. 不同节点使用不同模型与推理强度（reasoning effort）。
>
> 本文基于当前已实现的 `0.6.0-v2` 代码与 DSH `0.2.1-rc.2` 的真实 API 事实（文末列出处），给出数据模型、调度算法、失效处理、迁移路径与验收标准。

---

## 0. 结论先行

| 优先级 | 能力 | 建议形态 | 风险 | 预计 |
|---|---|---|---|---|
| P1 | **节点级模型 + 推理强度** | 节点字段 + 项目 allowlist + 有效值解析 + 成本核算 | 低（不改调度语义） | 1–2 天 |
| P2 | **单 Host 全局 GPU 协调器** | 进程内 Coordinator + 全局 lease 表 + 公平队列 + 等待态 UI | 中（start 生命周期改造） | 3–5 天 |
| P3 | **多实例/多用户集群协调** | 独立 coordinator 服务（HTTP + SQLite/Postgres）+ 心跳/配额/鉴权 | 高（部署/运维/隔离） | 2–3 周 |

关键判断：

- **GPU 协调不能继续放在 project.config 里**。当前每项目各自维护 `resourcePools` 与 `held` 账本，10 个项目各自 `{gpu:1}` 会同时认为独占一张卡。必须把「容量事实」提升为**集群级、单一权威的 lease 账本**，项目只声明「申请量 + 配额」。
- **模型/强度是节点执行属性，不是项目属性**。当前 `project.config.models[role]` 只能按角色配一个模型；研究型 DAG 恰恰需要「便宜模型跑扫参、强模型做归因/合并」。节点级覆盖是低成本高收益改动。
- 两者最终会交汇于**成本**：GPU 租约按 GPU-秒计价，推理按 token 计价；统一到「节点成本 + 项目预算 + 用户配额」才能做真正的多租户公平调度。

---

## 1. 现状与代码事实（设计约束）

| 事实 | 位置 | 含义 |
|---|---|---|
| 资源账本只在项目内 | `host/runtime.js` `ensureCapacity()`、`releaseNode()`；`project.config.resourcePools` | 无跨项目视角；多个项目会重复超卖同一张卡 |
| 调度快照只含本项目 | `host/snapshot.js` `buildSchedulerSnapshot()` | advisor/scheduler 看不到集群排队与其它项目占用 |
| 自动挡按项目独立 | `host/auto.js` `tickOne()` | 一个项目预算耗尽不影响其它项目，符合预期，但资源等待需要新暂停原因/退避 |
| 模型按角色配置 | `host/runtime.js` `roleModel(project, role)`；`project.config.models` | 节点无模型字段；`agentDefaultModel.currentSelection()` 兜底 |
| 每个节点一个工作会话 | `runtime.start()` 里 `childId: node.sessionId`、`agentOptions: roleModel(...)` | 模型在工作会话创建时绑定；`sendMessage` 的 options 只有 `signal`，**后续对话无法换模型** |
| 模型能力可查询 | DSH `ctx.llm.listModels(provider)`、`ctx.llm.resolveModel(provider, model)` | 可拿到 `reasoning.efforts[]` / `defaultEffort` / contextWindow，用于校验强度取值 |
| 模型覆盖点统一 | `SubagentStartRequest.agentOptions`（provider/model/reasoningEffort/maxTokens） | worker/merge/reviewer 都可按节点传不同模型 |
| 存储是本 Profile 本地域 | `host/store.js`（storageDomain `metainfer_research_lab`） | 多 DSH 实例之间不共享；跨实例协调必须外置服务 |
| 崩溃恢复已有基础 | `host/reconcile.js` | 可扩展为「回收本 holder 的所有 lease」 |

---

## 2. 方向 A：节点级模型与推理强度

### 2.1 数据模型

```ts
// 节点执行属性（NodeRecord 增补）
model?: {
  provider?: string;          // 省略=沿用项目/角色
  model?: string;
  reasoningEffort?: string;   // 适配器自有 id，如 'low'|'high'|'max'
  profileId?: string;         // 引用 project.modelOptions[].id，二选一
  source?: 'user' | 'advisor' | 'escalation';
  reason?: string;            // 为什么选它（advisor 提案/升级理由）
};
attempt?: {                   // 模型升级/重试会开新 attempt
  index: number;
  sessionId: string;
  anchorSessionId: string;
  model: ModelSelection;
  startedAt: number;
  endedAt?: number;
  stopReason?: string;
  usage?: TokenUsage;
};

// 项目配置增补
modelOptions?: Array<{         // 管理员/项目 owner 定义的可选项
  id: string;                  // 'flash-max' / 'reasoner-high'
  provider: string;
  model: string;
  reasoningEffort?: string;
  tags?: Array<'cheap' | 'strong' | 'long-context' | 'vision'>;
  pricePerMTokIn?: number;     // 用于成本估算
  pricePerMTokOut?: number;
}>;
models?: {
  default?: ModelRef;          // 项目缺省
  roles: { worker; advisor; scheduler; controller; merge; gc };
  allowed?: string[];          // modelOptions id / provider:model 白名单；空=全部
};
routing?: {
  advisorMaySelectModels?: boolean;   // advisor 提案可带 recommendedModel
  escalation?: {
    onTimeout: 'same' | 'next-tier' | 'strongest';
    onRunFailure: 'same' | 'next-tier';
    maxEscalations: number;           // 默认 1
  };
  requireEffortWithinBudget?: boolean;
};
```

### 2.2 有效值解析顺序（新增 `host/models.js`）

```
resolveModel(project, node, role):
  1. node.model（planned/running 时可被用户编辑；proposed 时作为建议值）
  2. project.config.models.roles[role]
  3. project.config.models.default
  4. ctx.agentDefaultModel.currentSelection().{provider,model,reasoningEffort}

resolveEffort(selection):
  node.model.reasoningEffort
  > project.config.models.roles[role].reasoningEffort
  > provider 默认（ctx.llm.resolveModel(provider,model).reasoning.defaultEffort）
```

校验规则：

- **规划期校验**（创建/编辑节点时）：`ctx.llm.resolveModel(provider, model)` 能解析，且请求的 effort 在 `reasoning.efforts[].id` 中；解析失败 → 400/422，附「可用模型/强度」列表。
- **启动期兜底**：`runtime.start()` 再校验一次（模型目录可能变化）；失败按 `stage='start'` 处理，节点 failed(start) 且错误信息可操作，可 `node.retry`。
- **不允许静默回退到别的模型**：显式选择失败就失败，避免「以为用了强模型其实用了默认」的研究不可复现问题。

### 2.3 谁能设置模型/强度

| 来源 | 行为 |
|---|---|
| 用户 | 创建项目/后继/合并节点、编辑 planned（或 proposed）节点时选择；从 `GET /models` 渲染选择器 |
| advisor | 提案可选带 `recommendedModel { profileId 或 provider/model/effort, rationale }`；Host 校验白名单与预算，落库为 `node.model.source='advisor'`；confirm 模式下由人最终批准 |
| scheduler | 不选模型（只做资源调度）；避免调度器同时承担质量决策 |
| 自动升级 | timeout/失败后按 `routing.escalation` 策略升级模型/强度：**新 attempt、新 session**，保留旧 session 作为历史 |
| reviewer panel | 现有 `advisor.reviewers[]` 已含 provider/model/effort，统一改为引用 `modelOptions`，避免两套配置 |

### 2.4 关键限制：模型只能在「新 attempt」时切换

DSH 事实：`SubagentSendMessageOptions` 只有 `signal`，没有模型字段。于是：

- 模型/强度在 worker session 创建时通过 `agentOptions` 固定；
- **follow-up（继续对话）沿用原会话模型**——这是可接受且可解释的；
- 要换模型，必须为节点开新 attempt（新 `sessionId`/`anchorSessionId`，沿用同一 worktree/branch）。节点记录保留 `attempts[]`，transcript 抽屉可切换 attempt 标签页。
- 升级策略 = 新 attempt；普通 retry = 同模型 follow-up（当前行为）。

### 2.5 API / UI 变更

```
GET  /models?projectId=            -> { defaults, roles, options[], routing, availability }
POST /commands node.edit           -> 允许 { model, reasoningEffort }（planned/proposed）
POST /commands node.successor|node.merge -> payload 允许 model
POST /commands project.update      -> config.models/modelOptions/routing 合并校验
GET  /state                        -> node.modelResolved（生效值）、node.modelSource、node.attempts[]
GET  /runs                         -> run.model/effort/usage/cost
```

UI：

- 卡片徽标：`flash·max` / `reasoner·high`，成本级别小圆点；
- 检查器：模型选择器（按 tags/价格排序，显示 effort 档位与预估成本），planned 可编辑；
- 新建后继/合并、advisor 提案卡：显示建议模型并可一键采纳；
- 设置：`modelOptions` 表格（provider/model/effort/价格/tags）、角色默认、advisor 是否可选模型、升级策略；
- 运行记录：每次 attempt 的模型/effort/token/成本；
- 预算：项目/自动挡增加 `maxCostUsd`，按 `tokens × price` 累计，超限暂停 `paused/maxCost`。

### 2.6 成本核算

- 复用现有 `node.usage`（已从 `assistant/message.usage` 聚合）。
- 新增 `cost = inputTokens*inPrice/1e6 + outputTokens*outPrice/1e6 + cacheRead*price*折扣`（价格来自 `modelOptions`）。
- 角色运行（advisor/scheduler/reviewer/gc）同样计入项目/用户成本。
- 自动挡预算增加 `maxCostUsd`；升级策略受剩余预算约束（不足则不升级，记录 skipped reason）。

### 2.7 验收标准（P1）

1. 节点 A 显式选 `model X + effort high`，启动后子会话确实使用该路由（检查 session 模型/运行记录）。
2. 节点 B 不选，沿用项目角色默认；节点 C 继承项目 default；
3. 选择不存在的 provider/model 或非法 effort → 创建/编辑时 4xx，错误里列出可用值；
4. advisor 提案带推荐模型，Host 校验通过后落库；白名单外被拒绝并记录 rejected；
5. 超时升级：attempt 2 使用更强模型，attempt 1 保留可查；预算不足时不升级并记录原因；
6. 成本显示与预算暂停正确（可用假价格单测 + 真实 token 累计 E2E）。

---

## 3. 方向 B：跨项目/跨用户 GPU 集群协调

### 3.1 目标与不变量

目标：让 N 个 DSH 实例 / M 个用户 / K 个项目共享同一 GPU 集群时，满足：

1. **不超卖**：任何时刻所有 active lease 的占用 ≤ 物理容量；
2. **先租后用**：节点必须先拿到 lease 才允许创建 agent/worktree 并运行；
3. **公平**：按用户权重/配额与项目优先级分配，避免大项目饿死小项目；
4. **可恢复**：实例崩溃/插件热重载后，lease 会过期并被回收，不会永久占卡；
5. **可观测**：谁在用什么卡、排队位置、GPU-秒/token 成本可查；
6. **强隔离可选**：至少「按卡独占 + CUDA_VISIBLE_DEVICES + 进程清理」，更强用容器/MIG。

### 3.2 分层架构

```
DSH instance A (lab plugin) ─┐
DSH instance B (lab plugin) ─┼─ HTTP/Unix socket ─> ClusterCoordinator
DSH instance C (lab plugin) ─┘                       ├─ Inventory providers: local / slurm / k8s / ssh
                                                     ├─ Lease store (SQLite WAL / Postgres)
                                                     ├─ Fair queue + quotas + usage accounting
                                                     └─ Audit log / admin API
```

- **Embedded 模式（P2）**：Coordinator 作为 lab 插件的可选 Host 子服务（或独立 Host 插件 `dsh-metainfer-cluster`），进程内调用 + 本地持久化。适合单机单实例、多项目共享。
- **Standalone 模式（P3）**：独立服务（Node + SQLite/Postgres），DSH 实例通过 `cluster.url + token` 接入；多用户/多机/多实例。
- **External allocator（P3+）**：Slurm/K8s 作为真正分配者，Coordinator 负责把 lease 映射成 `salloc`/Pod，并做排队与审计。

### 3.3 数据模型

```sql
-- 物理容量（由 provider 同步/管理员声明）
pools(id, key, unit /* device|mib|mig */, provider, node, meta_json)
devices(id PK, pool_id, vendor, model, memory_mib, mig_profile, state, lease_id, updated_at)

-- 租约（唯一权威账本）
leases(
  lease_id PK, idempotency_key UNIQUE,
  holder_id          -- dsh instance id
  user_id, project_id, node_id,
  pool_id, amount, device_ids_json,
  state /* pending|active|releasing|expired */,
  priority, generation,
  acquired_at, renewed_at, expires_at,
  meta_json
)

-- 排队
queue(id PK, request_json, user_id, project_id, node_id,
      priority, fair_key, enqueued_at, not_before, state)

-- 配额与用量
quotas(user_id, max_gpus, max_gpu_hours_per_day, max_cost_usd_per_day, weight, priority_class)
usage(user_id, project_id, pool_id, gpu_seconds, tokens_in, tokens_out, cost_usd, day,
      PRIMARY KEY(user_id, project_id, pool_id, day))
audit(id, at, actor, action, lease_id, detail_json)
```

- **全卡独占模式（推荐 MVP）**：`amount` 只允许整数卡，分配若干 `device_id`，lease 状态迁移 `pending→active→releasing→expired`。
- **显存模式**：`unit='mib'`，允许共享；必须配合 MPS/MIG 才有实际隔离，MVP 不做。
- **MIG 模式**：把每个 MIG slice 当作独立 device 入池，天然支持独占与公平。

### 3.4 调度算法

1. 请求入队：`needs` → pool 匹配 + 优先级 + 公平键。
2. 每次心跳/释放触发一次调度：
   - 过滤可用 device；
   - 按 `(priority_class, fair_key)` 排序：`fair_key = 该用户窗口内已用 GPU-秒 / weight`，越小越先；同键 FIFO；
   - 头部请求可分配则分配，不可分配则跳过（避免队头阻塞），但设置老化上限防止饿死；
   - 记录 `queue_position` 与预计等待（可选）。
3. 反压：无可用资源时不反复 cycle；Host 侧节点进入「等待资源」元数据，监听/轮询 `lease` 状态。
4. 抢占：MVP 不做；P3+ 可选「只抢占排队者」或「运行中抢占 + 宽限期 + 节点 marked preempted → retry」。研究任务通常应选择排队而非抢占，避免丢实验。
5. 公平性指标：per-user GPU-秒曲线、队列长度、平均等待、拒绝率。

### 3.5 生命周期与故障处理（Host 侧）

```
start(node):
  lock: node.status='reserving'（新中间态，避免重复启动）
  unlock
  lease = cluster.acquire({holderId,userId,projectId,nodeId,needs,ttl:timebox+5min,priority})
       ├─ 有卡 → 返回 lease
       └─ 无卡 → 返回 queued（不阻塞进程；轮询/长轮询）
  lock: 若拿到 → node.leaseId=...; status='running'; resourcesHeld=...
        若排队 → status='planned'; node.resourceWait={queuePosition,pool,since}; 事件 node/resource_waiting
  // 再创建 anchor/worktree/activation
```

- **心跳**：watchdog 每 10s 对 active lease 续约（TTL ≥ timebox + grace）；续约失败 → 按 `resource_lost` 确定性终止节点。
- **释放**：`finish/terminate/cancel/finishMerge/failNode` 的 `finally` 里 `cluster.release(leaseId)`，幂等。
- **崩溃恢复**：插件加载 → `cluster.listLeases(holderId)` → 全部释放；本地 running 节点按现有 `reconcile.js` 标记 failed(restart)。
- **孤儿进程**：释放前执行现有 worktree reaper；全卡独占模式下，分配前 provider 校验该 device 无残留 CUDA 上下文（nvidia-smi），不干净则 quarantine 并告警。
- **锁顺序**：项目锁绝不在 `cluster.acquire` 网络等待期间持有；采用「reserving → acquire → 再锁提交」的两阶段，避免长事务与死锁。

### 3.6 与现有代码的集成点

| 现有 | 改造 |
|---|---|
| `runtime.ensureCapacity` / `resourcePools` | 保留为「项目配额上限」（可空）；实际容量由 `cluster.pools` 提供；`ensureCapacity` 改为配额校验，`cluster.acquire` 做真实分配 |
| `runtime.start/terminate/finish/finishMerge` | 增加 leaseId 字段、两阶段开始、finally 释放、心跳续约 |
| `runtime.tick` | 增加 lease renew；lease 失效视为终止原因 |
| `host/reconcile.js` | 增加释放本 holder 的全部 lease |
| `host/snapshot.js` | 调度快照带 `cluster: {pools, free, queuePosition, eta, userQuota}`；advisor 看到全局资源 |
| `host/auto.js` | 新暂停/等待原因 `resourcesQueued`；避免无卡空转 cycle |
| `host/lab-service.js` `getState` | 增加 `cluster` 快照、`node.resourceWait/leaseId` |
| `client.js` | 集群面板（pools/devices/leases/queue）、节点等待徽标、lease 详情、管理员配额页 |
| 新插件 | `dsh-metainfer-cluster` Host 插件（P2）；standalone 服务（P3） |
| 新注入 | lab `inject` 增加可选 `metainferCluster`（用 `ctx.get()` 可选获取，缺失时回退本地模式） |

**兼容策略**：未配置 cluster 时保持现有单项目行为；配置后 `project.config.resourcePools` 变成项目配额，不再当作物理容量。

### 3.7 多用户 / 多实例

- **身份**：`ProjectRecord.owner`（userId）；coordinator 的 token 绑定 user/instance；lease 记录 user/project/node/holder；
- **鉴权**：DSH Host 持有 cluster token（只在 Host，不下发给 agent）；coordinator 校验 token 的 user/instance 权限；
- **隔离**：P2 用「整卡独占 + CUDA_VISIBLE_DEVICES + 进程清理 + 审计」；P3 推荐容器/K8s Device Plugin 或 Slurm GRES，实现真正隔离；
- **配额**：per-user 并发卡数、每日 GPU-小时、每日成本；超限返回 `quota_exceeded`，节点 `failed(start)` 或排队（可配置）；
- **审计**：谁在何时拿了哪张卡、用于哪个项目/节点、释放原因；便于团队结算与排障；
- **多用户 UI**：普通用户只看自己项目的队列/用量；管理员看全局池、租约、配额与审计。

### 3.8 部署形态与迁移

| 阶段 | 部署 | 适用 | 关键风险 |
|---|---|---|---|
| C0 | 进程内 Coordinator + JSON/SQLite | 单机、单 DSH、多项目 | 无跨实例公平；进程崩溃短暂泄漏（TTL 恢复） |
| C1 | standalone Coordinator(HTTP+SQLite WAL，共享盘/本地) + N 个 DSH | 多实例、同机多用户 | SQLite 写并发/共享盘锁；建议 coordinator 单写 |
| C2 | Coordinator + Postgres + Slurm/K8s provider + 容器隔离 | 多机/团队集群 | 运维复杂度、provider 适配、权限模型 |

迁移：`project.config.resourcePools` 保留为项目上限；新增 `cluster` 配置（pools/provider/url/token）；UI 先显示「本地模式/集群模式」；灰度时可按项目开关是否使用集群。

### 3.9 验收标准（P2/P3）

1. 两个项目各申请 1 张 GPU，集群只有 1 张：A 获得 lease 并运行，B 等待；A 结束/取消后 B 在 ≤ 2 个 tick 内启动；
2. Host 热重载/崩溃：重启后原 lease 过期被回收，新请求可分配；节点标记 restart；
3. 心跳：调度器暂停续约 → lease 在 TTL 后释放，节点 terminated(resource_lost)；
4. 配额：用户超 max_gpus 被拒绝/排队，错误可解释；管理员可查看/调整；
5. 公平：两个用户权重不同，长期 GPU-秒比例接近权重（模拟 10 个短任务）；
6. 审计：任意 lease 可追溯 user/project/node/holder/时间/释放原因；
7. 隔离：被终止节点的 GPU 上下文被清理（nvidia-smi 无残留），否则 device quarantine；
8. 多实例（C1）：两个 DSH 实例同时申请，只有 1 个获得；token 错误被拒绝；实例下线后 lease 自动过期。

---

## 4. 两者交汇：成本感知调度

- **租约成本**：pool 可配置 `pricePerGpuHour`；lease 结束时写 `usage.gpu_seconds` 与成本。
- **推理成本**：per-node model 价格 → token 成本（见 2.6）。
- **统一预算**：项目 `budget {maxGpuHours, maxCostUsd, maxTokens}`；自动挡预算可按任一维度暂停；用户级日配额由 coordinator 执行。
- **调度策略增强（P3+）**：scheduler 快照加入「集群排队 + 用户配额 + 成本」，让 advisor/scheduler 在「等卡」与「换便宜模型/小任务」之间做显式取舍；策略可配置（如 GPU 紧张时优先 cheap 模型扫参）。

---

## 5. 实施路线（建议）

1. **M5（P1，1–2 天）**：`models.js` + 节点字段/UI/校验 + 成本显示；不动调度。
2. **C1（P2，3–5 天）**：单 Host 全局 Coordinator、lease 生命周期、排队/等待态、集群面板、E2E 双项目抢 1 卡。
3. **C2（P3，2–3 周）**：standalone 服务（HTTP+SQLite→Postgres）、多实例接入、鉴权、配额/用量、审计。
4. **C3（P3+）**：Slurm/K8s provider、容器/MIG 隔离、抢占/检查点、成本感知调度、计费面板。

每阶段都保持：默认关闭（未配置即旧行为）、离线自测 + 真机 E2E、热加载不破坏运行中节点。

---

## 6. 已拍板（2026-10-23）

1. **多用户形态**：多台 DSH 实例、多机共享；协调器作为 DSH Host 插件提供，不引入额外服务。
2. **GPU 粒度**：整卡独占。
3. **调度器**：不使用 Slurm/K8s；尽可能轻量，有 DSH 即可用。
4. **模型选择**：用户自由选择；升级更贵模型提供**手动 + 自动**两种路径，自动升级由项目配置开关决定（默认关闭）。
5. **未定项**：配额/计费单位、抢占策略、容器级隔离留待后续（当前实现已记录 usage/GPU-秒，可在此基础上加配额）。

---

## 7. 附：DSH API 事实出处

- `ctx.agentDefaultModel.currentSelection()`：`@deepseek-ai/dsh-agent-default-model/lib/types/index.d.ts`
- `AgentOptions { provider?, model?, reasoningEffort?, maxTokens? }`：`@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts`
- `SubagentStartRequest.agentOptions`：`@deepseek-ai/dsh-subagent/lib/types/types.d.ts`
- `SubagentSendMessageOptions { signal }`（无模型覆盖）：同上
- `ctx.llm.listModels(provider)` / `resolveModel(provider, model)` / `LlmResolvedModelInfo.reasoning.efforts`：`@deepseek-ai/dsh-llm/lib/types/index.d.ts`、`types.d.ts`
- 现有实现：`host/runtime.js`、`host/snapshot.js`、`host/auto.js`、`host/reconcile.js`、`host/store.js`、`host/orchestrator.js`


---

## 8. V3 实现与验证（2026-10-23）

### 8.1 节点级模型 + 推理强度

- 新模块 `host/models.js`：`resolveModelSelection`（node > role > project default > agentDefaultModel）、
  `validateModelSelection`（provider 注册、`resolveModelInfo` 解析、effort 枚举、allowlist）、
  `buildModelCatalog`（`GET /models`：配置项 + provider/model 目录 + 角色默认 + routing）、
  `costOfUsage`（按 `modelOptions` 单价计费）与 `nextTierSelection`（升级档位）。
- 项目 config 增补：`modelOptions[{id,provider,model,reasoningEffort,tags,pricePerMTokIn/Out}]`、
  `models.default`（兼容旧 `models.<role>` 扁平写法）、`routing{advisorMaySelectModels,autoUpgrade,maxAttempts}`。
- 节点增补：`model`、`modelResolved`、`attempts[]`（每次运行一个 attempt：session/model/startedAt/endedAt/
  status/stopReason/usage/costUsd）、`usage`、`costUsd`；`node.edit` / `node.successor` / `node.merge` / advisor
  proposal `recommendedModel` 均可设置模型；`GET /models` 供 UI 选择。
- 新 attempt 语义：模型在 worker session 创建时绑定，DSH `sendMessage` 无模型参数，因此**换模型 = 新 attempt（新 session，
  沿用同一 worktree/branch）**；follow-up 仍沿用原模型。
- 升级两条路径：
  - 手动：`node.escalate`（失败或 completed 未封存叶子）或 `node.retry {model|upgrade}`；
  - 自动：`routing.autoUpgrade=true` 时，`timeout`/run 失败且 attempt 数 < `maxAttempts` 时，Host 自动开新 attempt
    使用下一档更贵 profile（受 `auto.maxCostUsd` 预算限制，merge 节点不自动升级）。
- 成本：`auto.maxCostUsd` 预算 + `auto.costUsed` + `paused/maxCost`；节点/attempt/自动挡/运行详情均展示 token 与美元成本。

**验证**：

1. `prj-d53b72c0/n-0003`：设置 `model.profileId=flash-max` → start 后 `modelResolved`、attempt 1 使用该 profile，
   cancel 后 `usage/costUsd=0.005632`（单价配置生效）。
2. 非法模型 `{provider:no-such-provider}`：`node.edit` 返回 `model_unavailable`（provider-unregistered），
   `GET /models` 也可展示可选 provider/model。
3. `prj-319bed92`：1 分钟 timeout + `autoUpgrade=true`：attempt 1 cheap 超时（usage 5174 tokens, cost 0.000191）→
   `node/model_changed`/escalation 进入 attempt 2 con premium profile（cost 0.000525，累计 0.000716）；手动
   `node.escalate` 同样工作。
4. 自动升级早期 bug（`newSessionId` 未导入导致 attempt 2 未启动）已修复并重测。

### 8.2 轻量多实例整卡 GPU 协调器

- `host/cluster.js`：
  - **Coordinator**（可运行在任意 DSH 实例内）：`node:http` + JSON 状态文件
    `~/.dsh/metainfer-research-lab/cluster-state.json`；Bearer token 鉴权；接口
    `GET /health`、`GET /v1/status`、`POST /v1/register|acquire|renew|release`。
  - **机器/实例注册**：每个 DSH 实例上报 `machineId + instanceId + devices[]`（默认 `nvidia-smi` 枚举，
    也可在配置里显式列出，便于无 GPU 环境测试）；心跳 10s，30s 离线判定。
  - **整卡 lease**：按 `requestId` 幂等；`machineId` 亲和（lease 只能来自请求实例所在机器）；无空闲卡入 FIFO
    队列（priority 优先）；释放/TTL 到期后自动调度队列；2s TTL reaper；GPU-秒 usage 按 user/project 记账。
  - **Client manager**：启动时注册并周期心跳；`acquire/renew/release/releaseAllMine/getStatus`；
    coordinator 与 client 可以是 same instance（`role:'both'`）。
- 运行时集成：
  - GPU 节点（`needs.gpu>0`）在 `runtime.start` 前先取 lease；无卡时节点保持 `planned` 并写
    `resourceWait{requestId,position,machineId,amount}`（不进入 agent/worktree 创建，不占 CPU 子代理）；
  - `startLeasePump` 每 2s 轮询等待节点，lease 到手后写入 `node.lease` 并继续启动；
  - watchdog 每秒调度、每心跳续约 lease，续约失败按 `resource_lost` 确定性终止；
  - `finish/terminate/cancel/finishMerge/failNode` 的 `releaseNode` 统一释放 lease；插件加载时
    `releaseAllMine()` + `reconcileRunningNodes()` 清理崩溃实例的租约与 stale 节点；
  - auto 模式遇到 `resourceWait`/GPU 无空闲时进入 `waiting/awaitingGpu`，不空转 cycle；
  - `getState.cluster`、`GET /cluster`、`metainfer_lab action=cluster` 暴露 pools/machines/leases/queue/usage。
- 配置：`~/.dsh/metainfer-research-lab/cluster.json`（默认关闭；示例见仓库 `cluster.example.json`）。

**验证**：

1. 本机启动 coordinator（`role:'both'`，fake 1 GPU）：auth 关闭/错误 token → 401；health/status 正常；
   机器 inventory 与心跳可见。
2. 项目 A（needs gpu=1）start → 获得 lease `lease-...`，`node.lease.deviceIds=['local-machine:gpu0']`；
   项目 B（needs gpu=1）start → `queued position=1`，`resourceWait` 写入、无 deadline/agent。
3. 取消 A → lease 释放；pump 在 ~2s 内把 lease 转给 B 并自动启动 B（无需人工 Step）。
4. 插件热重载：B 被 reconcile 为 failed(restart)，`releaseAllMine` 释放其 lease；usage 记录 GPU-秒
   （A 10.1s / B 50.3s）；reconcile 后 lease/resourceWait 字段被清理（修复）。
5. 多机/多实例：通过 HTTP 注册第二台机器（2×fake GPU，instance `dsh-remote-1`，user alice）→
   `GET /v1/status` 显示 3 卡、按机器分解；远程机器 acquire 获得 `remote-machine:gpu0`；
   `ttlMs=2000` 到期后 reaper 自动回收并写 usage；token 缺失 → 401。
6. 修复：coordinator 退出时未关闭 HTTP server 导致热重载后端口被旧实例占用、reaper 失效 → 现在
   `coordinator.close()` 关闭 server + 清理 timer（旧代码实例残留的 8791 端口仅影响开发机，已切到 8794 配置）。
7. 离线自测 19/19（新增 `/cluster` 路由）；Host 版本 `0.8.0-v3` 热加载。

### 8.3 已知限制

- **机器亲和**：lease 只分配请求实例所在机器的 GPU；跨机使用 GPU 需要目标机器上也运行 DSH（worktree 与
  subagent 在本机执行）。真·跨机执行需要共享 FS + 远程 subagent provider，属于后续工作。
- 无抢占/配额/容器隔离；整卡独占模式由 Host 侧约定 + `CUDA_VISIBLE_DEVICES` 类提示实现，
  强隔离需要后续容器/MIG 支持。
- 多机网络需能访问 coordinator 的 HTTP 端口，token 需自行配置为长随机串；协调器状态为单文件 JSON
  （单写者、轻量场景足够）。
- 自动升级策略目前是「按价格下一档」，尚未实现按评测/成功率的自适应策略。

---

## 9. 协调器使用、可视化与"多协调器"治理（2026-10-24 增补）

### 9.1 协调器如何使用（**纯 GUI**，推荐）

**无需命令行、无需编辑 JSON、无需重载插件。** 所有配置都在 DSH 界面里完成：

1. **coordinator 机器**：刷新 DSH 页面 → 打开任意项目（或项目列表页）→ 点击 **「集群设置」**
   （项目列表页头、工作区 `⋯` 菜单、集群芯片旁齿轮、集群弹窗「配置集群」均可进入）。
2. 在表单里填写：勾选 **启用集群**；角色选 **协调器** 或 **两者**；`clusterId`（全集群唯一）；
   `machineId`（本机唯一）；`listen` host/port（例如 `0.0.0.0:8794`）；**token**（长随机串）；
   设备模式保持 **自动（nvidia-smi）** 或切换为手动列表；`dashboard` 开启。
3. 点 **保存并应用**。Host 会校验并持久化配置，然后**在进程内热重启** coordinator（关闭旧监听、写
   `cluster.json`、启动新 coordinator、注册本机），响应里直接返回新状态；界面显示
   `enabled/connected/clusterId/coordinatorId/pools/machines` 和 **打开看板** 按钮。
4. **其它机器**：同样进「集群设置」→ 勾选启用 → 角色选 **客户端** → `clusterId` 与 token 与协调器一致 →
   `url` 填 `http://<coordinator-ip>:<port>` → 保存并应用。状态显示 connected 与机器池即成功。
5. 之后在 DSH 里正常创建/启动节点即可：GPU 节点自动排队等整卡；集群芯片/弹窗实时可见。

> token 是密码输入框：留空表示保持已保存 token；填新值才覆盖；界面只显示 `tokenSet` 掩码。
> 保存时若仍有节点持有 GPU lease，Host 会拒绝（409 `cluster_busy`），先等节点结束或停止它即可。
> 保存不会重载插件，也不要求刷新页面；首次安装新版客户端需刷新一次页面以加载 GUI。

**配置字段说明（GUI 表单一一对应）**

| 字段 | 说明 |
|---|---|
| `enabled` | 总开关；关闭后协调器监听/心跳/租约全部停止，节点走本地模式 |
| `role` | `coordinator` / `client` / `both`；一个集群只应有一个包含 coordinator 的实例 |
| `clusterId` | 全集群唯一；client 与 coordinator 不一致会被 409 `cluster-mismatch` 拒绝 |
| `instanceId` / `machineId` | 实例与机器标识；machineId 用于整卡归属与 machine claim 冲突检测 |
| `coordinatorId` | 可选，协调器显示名 |
| `url` | client 访问 coordinator 的地址；coordinator 自身也用它自连 |
| `listen.host/port` | coordinator 监听地址；跨机需 `0.0.0.0` 并放行防火墙 |
| `token` | Bearer 鉴权；GUI 只显示是否已设置；留空保持不变；留空+已设置=保留 |
| `heartbeatMs` / `leaseTtlMs` | 心跳周期与租约 TTL（GUI 用秒/分钟输入） |
| `devices` | `null`=自动 nvidia-smi；或手动 `[{id,model,memoryMiB}]`（无 GPU 测试也可用） |
| `dashboard` | 是否在 coordinator 提供内置只读看板 |
| `allowMultipleCoordinators` | 允许同机不同协调器（默认 false，用于覆盖 machine claim 保护） |

**进阶/备用方式（仅限运维自动化，不是必需）**

- 配置文件仍是 `~/.dsh/metainfer-research-lab/cluster.json`（GUI 自动写入，权限 0600），可纳入配置管理；
- `GET /cluster/config`、`POST /commands {type:'cluster.config'}` 由 GUI 使用，也可用于自动化；
- `node scripts/cluster-status.mjs` 与 coordinator 内置看板供值班/监控使用；
- 只有 `needs.gpu > 0` 的节点走集群：start 先取整卡 lease，无卡时保持 planned + `resourceWait{position,...}`
  （不创建 worktree/子代理），lease 到手后自动继续；取消/完成/超时会释放。

**常用运维操作**

| 目的 | 操作 |
|---|---|
| 暂停集群调度 | 把所有节点取消/等待；coordinator 配置 `enabled:false` 后热加载 |
| 清理崩溃实例遗留 | 重启 coordinator 实例（加载时自动回收过期 lease）+ 各实例热加载触发 `releaseAllMine` |
| 验证 token | 错误 token 返回 HTTP 401 |
| 查看 coordinator 状态文件 | `~/.dsh/metainfer-research-lab/cluster-state.json`（仅 coordinator 写） |
| 重置集群 | 停掉所有实例 → 删除 state 文件与 `*.lock` → 重新启动 coordinator |

### 9.2 如何可视化展示集群状态

提供四种互补视图：

1. **DSH 面板（操作入口）**：项目工作区顶栏的 **集群芯片**（启用时显示 `mode · GPU free/total · 队列长度`），
   点击打开**集群弹窗**：总览（clusterId/coordinator/machines/gpu 汇总）、按机器的设备列表、活跃 leases
   （项目/节点/用户/机器/设备/到期）、队列位置与等待时长、usage（GPU-秒）；弹窗只在打开时每 2s 轮询。
   节点卡片/检查器还会显示 `等待资源（gpu×N）· #位置` 与 lease（machine/device/到期），等待时启动/重试按钮禁用。
2. **Coordinator 内置 Dashboard**：浏览器直接打开 `http://<coordinator-ip>:8794/`（`dashboard:true` 时）。
   页面是零依赖 HTML：输入 token 后每 3s 自动刷新，展示总览、机器/GPU、leases、queue、usage；
   适合值班大屏或没有 DSH 客户端的运维同学。token 只保存在浏览器 localStorage。
3. **CLI**：`node scripts/cluster-status.mjs [--url URL --token TOKEN] [--json] [--watch 3]`，
   默认读取本机 `cluster.json`；打印人类可读表格或 JSON，只读、无副作用。
4. **API**：`GET /v1/status`（Bearer token）返回完整 JSON，可接 Prometheus/自建监控；`GET /v1/health` 无鉴权，
   适合负载均衡健康检查。

此外节点级事件 `node/resource_waiting|granted|lost` 会进入项目活动日志，可追踪单个节点排队/获租/失租。

### 9.3 如果不同用户启动了多个协调器怎么办？

**语义**：协调器是**单写者**。多个协调器 = 多个互相独立、互不可见的"集群孤岛"；它们各自维护自己的
machines/leases/queue，**不会**互相协调。如果同一批 GPU 的 client 分别指向不同协调器，理论上可能被重复租用，
这是必须避免的配置错误。

**已实现的三道防线**

1. **`clusterId` 一致性**：client 的 register/acquire/renew/release 都携带 `clusterId`，coordinator 发现不一致时返回
   `409 cluster-mismatch`，不会把机器/租约混入错误的集群。
2. **state 文件锁**：coordinator 启动时对 `stateFile`（默认 `cluster-state.json`）加 `*.lock`（含 pid/url）；
   若另一个存活的 coordinator 已持有同一 state 文件，新 coordinator 拒绝启动并返回
   `coordinator-already-running (pid …, url …)`。这能阻止同一台机器/同一用户重复启动 coordinator。
3. **机器占用声明（machine claim）**：每个启用集群的 DSH 会在
   `~/.dsh/metainfer-research-lab/machine-claim-<machineId>.json` 写 `{machineId,pid,coordinatorUrl,clusterId,at}`；
   若同一 machine 上另一个存活 DSH 进程声明的 `coordinatorUrl` 不同且未过期（120s），新实例会进入
   `blocked=true`，`error='machine-claimed-by-other-coordinator'`，并拒绝 acquire；可配置
   `allowMultipleCoordinators:true` 显式覆盖（不推荐）。

**运维规则（推荐）**

- **一个集群只跑一个 coordinator**：管理员机器 `role:"both"`（或 `"coordinator"`），所有其他机器 `role:"client"`；
  统一 `clusterId` 与 token，并用防火墙只允许集群网段访问端口。
- **不同集群必须物理/逻辑隔离**：不同 `clusterId`、不同端口、不同 token、不同机器集合；不要共享 GPU 机器。
- **故障转移**：当前是单写者无 HA。coordinator 挂了以后，其 state 文件仍在；重启后 lease 会按 TTL 过期回收，
  client 心跳会自动重连（每次 heartbeat 重新 register/status）。重启前请确保旧进程已退出，否则 state 文件锁会阻止
  新进程接管（这是有意的保护）。
- **诊断**：`/v1/status` 的 `clusterId/coordinatorId`、client 的 `state.cluster.error/blocked/claimConflict`、
  coordinator 日志 `metainfer-cluster: coordinator listening on …`、`cluster-status.mjs` 都能定位"连错协调器"。

**残留风险（已知）**：machine claim 只能覆盖**同一台机器**；如果某台机器的 DSH 故意指向另一个 coordinator，
它本身不会知道另一台机器上的 coordinator 也在管理同一批机器。跨机器场景仍要靠部署纪律 + 防火墙 +
clusterId 治理。真正需要多协调器容灾时，应引入共享数据库/租约服务（Postgres/etcd）与 leader election，
这超出了当前"轻量、有 DSH 就能用"的范围。

---

## 10. 项目内 Scheduler 与集群 Coordinator 的关系（多机多节点）

### 10.1 先回答"是不是遗留"

**部分是的。** 项目设置里的 "scheduler 提示词" 来自 M3 的单项目编排阶段，当时只有项目内
`resourcePools` 账本，没有集群概念；V3 引入 coordinator 后，最初的 snapshot/prompt 仍只描述项目资源，
因此存在"两套 scheduler 语义"的表述遗留。现已做如下修正：

1. `buildSchedulerSnapshot` 增加 `cluster` 段（全局 pools/free、本机 machineId、本项目 leases/队列、
   项目 GPU 配额），并明确 coordinator 的权威地位；
2. 默认 scheduler prompt 增加 "Two-layer authority" 说明；**用户自定义 prompt 也会追加同一段环境事实**
   （避免自定义提示词里假设 "scheduler 能预留 GPU"）；
3. 集群模式下 `project.config.resourcePools.gpu` 明确作为**项目级 GPU 并发配额**执行；
4. 新增 `project.config.clusterPriority`（0–100）作为 coordinator 队列优先级；
5. auto 控制器在集群模式下用 coordinator 的 free/项目配额判断能否启动，不再用本地 pools 误判；
6. UI 文案在 V5 更新（scheduler 提示词说明、clusterPriority、协调器权威提示）。

### 10.2 两个 "scheduler" 是不同层

| 层 | 是什么 | 谁运行 | 决策权限 |
|---|---|---|---|
| **项目内 Scheduler（LLM role 'scheduler'）** | 读取本项目 DAG/planned 节点/项目配额/集群快照，输出 `starts:[{nodeId,reason}]` | 每个项目、每个 DSH 实例内的一次人员 activation；提示词就是项目设置里的 `prompts.scheduler` | **建议**：本项目哪些 planned 节点先启动、顺序；不能预占 GPU、不能跨项目/跨机分配 |
| **集群 Coordinator（确定性服务）** | 整卡 lease 账本：机器注册、acquire/renew/release、队列、TTL、usage | 集群中唯一权威实例（DSH Host 内 HTTP 服务，无 LLM） | **硬权威**：是否授予某张卡、何时授予；不读 DAG/提示词，也不关心实验内容 |
| Runtime / Auto | 把建议转成执行；先配额检查再 acquire lease；排队 pump、心跳续约、结束释放；auto 等待 | 每个 DSH Host | 执行/守门：scheduler 的建议只有拿到 lease 才真正启动 |

### 10.3 "听谁的"——冲突解决规则

1. **GPU 准入听 coordinator**。scheduler 说 start 不等于能 start：runtime 必须向 coordinator
   acquire 整卡；无卡时节点进入 `planned + resourceWait`（coordinator 队列），lease pump 拿到卡才真正创建
   worktree/agent。scheduler 不能覆盖、预占或跨项目抢卡。
2. **项目内先启动谁听 scheduler**（在可被准入的范围内）。coordinator 只按队列优先级/FIFO 决定发卡顺序，
   不做"哪个实验更有价值"的语义判断；`project.config.clusterPriority` 是项目之间争卡时的唯一权重。
3. **项目 GPU 配额听 Host**：`resourcePools.gpu` 是项目级并发上限；超了 runtime 直接 `project_gpu_quota`
   拒绝（scheduler 应从快照里看到 quota 并避免）。
4. **实验该不该做听 advisor/人**：advisor 生成 DAG；人可批准/拒绝/取消；coordinator 与 scheduler 都不改变
   实验内容。
5. 租约丢失/续约失败：Host 确定性终止节点（`resource_lost`），scheduler 下一轮看到 failed，不参与 kill。

### 10.4 一次多机多节点请求的完整时序

```
Advisor(LLM)  ──提案──▶  planned nodes (DAG)
                                      │
Auto/Step ──▶ 项目 Scheduler(LLM, prompts.scheduler)
                                      │ starts:[nodeId...]
                                      ▼
                              Host Orchestrator
                                      │ runtime.start(node)
                                      ▼
                     项目 GPU 配额检查 (resourcePools.gpu)
                                      │
                                      ▼
                 Coordinator.acquire(whole GPU, machine-affine, priority)
                         │ granted                    │ no free card
                         ▼                            ▼
                 node=running, lease            node=planned + resourceWait
                 heartbeat renew                2s lease pump 重试 acquire
                         │                            │
                         ▼                            ▼
                 worker/merge agent            lease 到手后自动 start
                         │
                         └── finish/cancel/timeout ──▶ release lease
```

**多机含义**：每个 DSH 实例维护自己的项目 scheduler。两种 placement：
- **local**：节点在 DSH 本机执行，lease 机器亲和；
- **fleet**（V6）：DSH 控制机可以没有 GPU；节点申请 `needs.machines>1` 或项目 placementMode=fleet 时，
  coordinator 从多台已注册的远程 GPU 机器一次性发放整卡组合（mult-machine lease）；worker 仍在控制机运行
  （本地 worktree、NFS 共享可见），但 GPU 命令由生成的 `.dshex-run` 包装器通过 SSH 进入远端容器执行。
scheduler 仍只建议 node id，不选机器；coordinator 决定发哪几台机器。

### 10.5 项目设置里的 scheduler 提示词还有用吗？

有用，但职责被限定为**项目内实验启动策略**：优先级、探索顺序、成本/时限偏好、避免重复实验等。
在集群模式下推荐这样写：

- "优先启动不需要 GPU 的节点；GPU 节点仅在快照 `cluster.pools.gpu.free > 0` 或明确接受排队时建议启动"；
- "尊重 `cluster.project.gpuQuota` 和 `maxRunningNodes`"；
- "不要把 scheduler 当作资源预留；实际启动由 coordinator 决定"。

即使自定义提示词写了 "全部启动"，Host 仍会逐项配额校验 + acquire，coordinator 仍可能排队，因此不会破坏安全性。

### 10.6 本次修复与实测（2026-10-24）

**已修正的"遗留"点**

1. `buildSchedulerSnapshot(store, project, cluster)` 新增 `cluster` 段：全局 pools/free、本机 `machineId`、
   本项目 leases/队列、项目 `gpuHeld/gpuQuota`，并明确 authority 文案；
2. 默认 scheduler prompt 增加 "Two-layer authority"；**自定义 scheduler 提示词也会附加同一段环境事实**
   （它只限制"项目内建议"，不会让 scheduler 误以为能预留 GPU）；
3. 集群模式下 `project.config.resourcePools.gpu` 作为**项目 GPU 并发配额**执行：
   runtime 在 acquire 前检查，超限直接 `project_gpu_quota`；
4. 新增 `config.clusterPriority`（0–100，GUI 可设），coordinator acquire 时按它排队；
5. auto 控制器在集群模式下用 coordinator free/项目配额判断 `canRunPlanned`，不再用本地 pools 误判；
6. UI（V5）：设置里 scheduler 提示词改名为「项目内实验调度提示词（不分配 GPU）」并加说明；
   集群状态/配置弹窗加"协调器是 GPU 准入最终权威"提示；等待节点增加"scheduler 无法预留 GPU"；
   新增"集群调度优先级"设置。
7. 恢复/边界修复：
   - 热重载后"已获 lease 但节点仍 planned"的孤儿状态，pump 会先 renew lease，然后带 lease 启动；
     lease 丢失/启动失败则释放并清理；
   - 集群模式下对 GPU 节点做 follow-up（继续对话）会**拒绝并提示**（因为 follow-up 不经过租约），
     改用 `node.retry`/`node.escalate` 开新 attempt（新 session + 重新 acquire 整卡）；
8. scheduler run 记录现在包含 `inputSnapshot.cluster`，方便审计"它当时看到了什么"。

**E2E（本项目内，fake 1×GPU、clusterId=sched-test、project gpuQuota=1）**

- 项目根节点完成后，两个 GPU planned 节点；启动第一个后再次 `start_node` 第二个 → coordinator 队列
  （旧代码路径）；重载后修正为：
- `retry_node` 失败 GPU 节点 → 新 attempt、重新 acquire lease → running；
- 在 GPU 被占（held 1/1）时 `retry_node` 另一 GPU 节点 → **`project_gpu_quota: project GPU quota reached: held 1/1, node needs 1`**；
- 清空 GPU 后 Step（只有 scheduler pass）→ scheduler run `run-7e0ad40b` 的 `inputSnapshot.cluster` 包含
  `pools.gpu.free=1, project.gpuQuota=1, machineId=local-machine, leases:[], authority:"coordinator is final authority..."`；
  LLM 输出明确写道 "No GPU is claimed here; n-0004 will still have to acquire a whole-GPU lease from the
  coordinator at start"，且只提出 n-0004 一个 start（尊重 quota），随后 coordinator 授予 lease 并启动。

**结论**：项目内 scheduler 仍是项目级"建议者"；coordinator 是集群级"发卡/排队权威"；runtime 是执行守门人。
多机场景下每个 DSH 的项目 scheduler 只看本机可用的整卡（machine-affine），跨机公平由 coordinator 的
queue/priority/usage 承担；真正的"把任务派到另一台机器"仍属于未来远程执行能力。

---

## 11. 远程 GPU 舰队（SSH + 容器 + NFS）与"多机多节点"支持

### 11.1 适用场景（V6 已支持）

典型部署：**DSH Lab 跑在一台没有 GPU 的控制机**上；GPU 在若干台 GPU 服务器上；所有机器挂载同一 NFS；
每台 GPU 机器的训练环境在容器里；控制机可以用 SSH 登录这些 GPU 机器并 `docker exec` 进容器。
worktree 在 NFS 上，因此远端容器能看到同样的代码路径。

V6 的 fleet 模式就是为这个场景实现的：

```
控制机 DSH (无 GPU)
 ├─ worker agent + git worktree(本地/NFS)
 ├─ 向 coordinator 申请多机整卡 lease（needs: {gpu:N, machines:M}）
 ├─ Host 生成 worktree/.dshex-run/{manifest.json, remote.sh, launch.sh, runner.mjs}
 └─ worker 通过 .dshex-run 包装器 SSH 到租用机器 → docker exec 容器 → 执行 GPU 程序
GPU 机器（由控制机 DSH 注册，不需要在 GPU 机器上装 DSH）
 ├─ 已存在的容器（runtime docker/podman/apptainer/none）
 ├─ 挂载同一 NFS（pathMap 把本地 worktree 映射到容器路径）
 └─ 每台 N 张整卡，由 coordinator 统一租给控制机
```

### 11.2 机制（"先申请，再使用"）

1. 在集群 GUI 配置 **Fleet**：机器列表（machineId、SSH host/user/port/keyPath、container、workdir、devices、
   pathMap），以及 `placementMode`、`masterPort`、全局 pathMap。
2. 控制机 DSH 启动/心跳时通过 SSH（或显式配置 devices）发现每台 GPU 机器的卡，并注册到 coordinator；
   GPU 机器无需安装 DSH。
3. 节点需要多机时声明 `needs: {gpu: 4, machines: 2}`（**先申请**）。Host 检查项目 GPU 配额后向 coordinator
   申请 fleet lease：coordinator 在所有在线 fleet 机器上做**整卡、跨机器、全有或全无**分配；不足则整个请求
   排队，不会只给一半。
4. lease 批下来后（**再使用**），Host 在 worktree 写 `.dshex-run/`：
   - `manifest.json`：lease、每台机器、rank、CUDA_VISIBLE_DEVICES、远端 worktree 路径、master 地址；
   - `remote.sh <machineId> <cmd...>`：在指定机器容器内执行命令；
   - `launch.sh "<cmd with $DSHEX_*>"`：在所有租用机器上并发执行同一命令，注入 rank/world size/GPU 数/
     master 地址等环境变量（适合 `torchrun`/MPI 启动脚本）；
   - leader 脚本通过 SSH 执行，容器内运行；`.dshex-run/` 已加入 git exclude，不会被 commit 进实验历史。
5. 心跳续约 lease；完成/取消/超时释放整组 lease，并记录 GPU-秒 usage。

### 11.3 支持矩阵（更新）

| 需求形态 | 当前 | 说明 |
|---|---|---|
| 单项目单机多节点并发 | ✅ | local placement；整卡 lease |
| 单节点申请本机多张卡 | ✅ | local placement (`needs.gpu:N`) |
| **控制机无 GPU，GPU 全在远程机器** | ✅ | fleet placement；SSH + 容器 + NFS |
| **一个节点跨多台 GPU 机器（torchrun/MPI 多机）** | ✅（V6） | `needs.machines>1`；coordinator 多机整卡 lease；`.dshex-run/launch.sh` 启动 |
| 多机各自运行独立项目/节点，共享 coordinator | ✅ | 全局队列/配额/GPU-秒 usage |
| 同一项目 DAG 跨多个 DSH 实例共享 | ❌ | 项目状态仍为单 DSH 本地存储 |
| 无 SSH 的远程执行/容器编排 | ❌ | 依赖已配置的 SSH、容器与 NFS；不内置容器编排 |
| K8s/Slurm 多机作业 | ❌ | 不在轻量方案范围；可作为后续 allocator provider |
| 远程 agent/DSH 进程分发 | ❌ | worker agent 仍在控制机，只有 GPU 命令远程执行 |

### 11.4 GUI 配置字段（无需命令行）

集群设置弹窗 → 远程 GPU 机器（Fleet）：
- 总开关、placementMode（local/fleet/auto）、masterPort、全局 pathMap；
- 每台机器：machineId、SSH host/user/port/keyPath/options、容器 runtime/name/workdir/user/env、
  设备自动发现或手动列表、机器级 pathMap；
- pathMap 示例：本地 `/home/lab/.dsh/metainfer-research-lab/worktrees` →
  容器内 `/nfs/dsh/worktrees`（如果两边路径相同可不填）。

节点侧：在检查器 needs 里增加 `machines`（整数，≤ gpu 总数）；worker 的提示词会自动包含
"必须通过 `.dshex-run` 执行、不要用本地 GPU" 的说明以及示例命令。

### 11.5 GUI（V6 已完成）

集群设置弹窗新增“远程 GPU 机器（Fleet over SSH）”可折叠区域：fleet.enabled、placementMode、masterPort、
全局 pathMap、机器列表（SSH/容器/设备自动或手动/机器级 pathMap）。集群状态弹窗展示 fleet 机器表。
节点检查器 needs 支持 `machines`（提示 ≤ gpu 总数），fleet 节点卡片显示“远程舰队 · N机M卡”，
检查器展示 lease.machines/masterPort/`.dshex-run` 包装器提示。全部通过 GUI 完成，无需命令行/JSON。

### 11.6 边界与注意事项

- **SSH 密钥/权限**：Host 使用配置的 keyPath 执行 ssh；worker 调用包装器时也继承该 SSH 配置/权限。
  建议为实验准备专用 SSH key、限制远端 shell，避免 worker 绕过 lease 直连其它机器。
- **容器需预先存在**：Host 只做 `docker exec`/`podman exec`/`apptainer exec`，不负责拉镜像/启动容器。
- **NFS 路径映射**：如果容器内路径与控制机不一致，必须配置 pathMap，否则远端找不到代码。
  **Windows 控制机**的本地 worktree 形如 `C:\...`，必须映射为 Linux 容器内 POSIX/NFS 路径；否则 Host 以
  `fleet_path_map_required` 拒绝启动。
- **远端进程清理**：lease 释放/超时不会自动 kill 远端已启动的进程（SSH 启动的进程可能继续运行）。
  实验脚本应自行 trap/清理；后续可加远端 job supervisor。
- **网络**：控制机需能 SSH 到 GPU 机器；多机 rendezvous 需要 GPU 机器之间能互通（masterAddr/masterPort）。
- **无项目联邦**：每台 DSH 的项目/DAG 仍是本地存储；远程 fleet 只是 GPU 执行资源。
- **真实环境验证**：本机 E2E 用显式 fake 设备验证了 coordinator 多机分配、lease/队列、`...dshex-run` 生成、
  worker 读取 manifest 与 git 排除；实际 SSH/容器执行需在真实 fleet 环境验证（本机无 SSH server/容器编排）。

---

## 12. 自然语言 GPU 节点分配诉求（V7）

### 12.1 目标

fleet 里的机器可能 GPU 型号不同、网络互联不同、机架/区域不同。除了 `needs:{gpu,machines}` 的数量诉求，
项目还需要表达**"应该分到哪些机器"的倾向**，例如：

- "必须使用 A100；尽量同一机架；NVLink 互联；不要 H100"
- "优先 2 台 H100，如果不可用可接受 A100，但不要跨机架"
- "只在 rack-a 里跑"

V7 在项目设置中增加自然语言字段 `placementPolicy.text`，Host 将其编译为结构化规则
`placementPolicy.spec`，由 coordinator 在 fleet 分配时执行。

### 12.2 编译规则（确定性、catalog 驱动）

编译器只匹配 **Fleet 配置里真实存在的机器标签与 GPU 型号**（`host/placement.js`）：

| 文本语义 | 结构化规则 | 说明 |
|---|---|---|
| 必须/只能/唯一/require/only/must | `require` | 硬约束；不满足则整个请求排队（不会降级） |
| 优先/尽量/最好/prefer/ideally | `prefer`（有序） | 软倾向；按规则顺序选择更匹配的机器 |
| 不要/排除/except/exclude | `excludeGpuModels` / `excludeMachineLabels` / `excludeMachineIds` | 排除 |
| 机器标签值（如 `rack-a`, `nvlink`, `a100`） | `machineLabels: {rack:["rack-a"]}` 等 | 大小写不敏感，可 `key=value` |
| GPU 型号词（A100/H100/4090…） | `gpuModels: ["a100"]` | 匹配设备 model 子串 |
| 同一机架/同 rack | 硬：`require.colocate="rack"`；软：`preferColocate="rack"` | 同一 zone/network 同理 |
| 指定 machineId | `machineIds` 或 `excludeMachineIds` | 直接按注册 id |

- **未知短语**不会静默生效，会返回 warnings 给 UI（例如 "未能从某句识别出已配置标签/型号"）。
- 硬约束在 catalog 中不可能满足时（如必须 V100 但 fleet 没有 V100），编译结果仍会保存并显示
  "会一直排队"的警告；是否清理由用户决定。
- 编译是**纯本地、零 token** 的规则解析；更复杂的语义（"训练任务适合高带宽节点"）可后续增加 LLM 编译器，
  但结构化规则仍由 Host 校验/coordinator 执行。

### 12.3 Coordinator 如何执行

fleet acquire 请求新增 `constraints`：

```json
{"require":{"machineLabels":{"gpu":["a100"]},"gpuModels":["a100"],"excludeGpuModels":[],
             "machineIds":[],"excludeMachineIds":[],"excludeMachineLabels":{},
             "colocate":null},
 "preferColocate":"rack",
 "prefer":[]}
```

分配流程：
1. 过滤在线机器：machineIds/exclude、require 标签、require 排除标签、排除 GPU 型号；
2. 只保留有足够"符合型号要求"的空闲整卡的机器；
3. 按 `prefer` 规则顺序打分排序（越早匹配越优先），再按空闲卡数；
4. 选择 M 台机器做均衡分配（base/rem），全部满足才发 lease；否则整个请求排队；
5. `preferColocate`（软同机架）先尝试同值分组分配，失败再回退到普通分配；
6. `require.colocate`（硬同机架）只接受同一 label 值的机器组，不满足则排队。
7. 排队原因会返回 `no-matching-machines` / `insufficient-matching-capacity` /
   `colocate-constraint-unsatisfiable` / `machines-exceed-gpus`，UI 可展示。

### 12.4 Scheduler 能看到什么

scheduler/advisor 快照的 `cluster` 段增加：
- `fleetMachines`：每台 fleet 机器的 labels、GPU 型号、空闲/总卡数、在线状态；
- `placementPolicy`：项目自然语言文本、编译摘要、结构化 spec。

scheduler prompt 明确：它仍然只选 node id，机器选择由 coordinator 按上述规则执行；如果符合约束的空闲机器为 0，
优先 `starts: []`，避免无意义排队。

### 12.5 Fleet 机器的标签

在 Fleet 机器配置中增加 `labels`（GUI 键值对），例如：

```json
{"gpu":"a100","rack":"rack-a","interconnect":"nvlink","zone":"zone-1"}
```

Host 会自动小写化并注册到 coordinator；`status.fleet` 与 `lease.machines[].labels` 都会带出。
GPU 型号默认来自每台机器 devices 的 model 字段（自动发现或手动配置）。

### 12.6 GUI（V7 已完成）

项目设置 → **GPU 节点分配诉求（自然语言）**：
- 输入自然语言（提供示例）；
- **解析预览**调用 `project.compile_placement`，显示 summary、逐条解释、warnings、可用标签/型号 chips；
- **保存策略**写入 `project.update config.placementPolicy`（Host 校验 spec）；支持清除；
- 未编译/未保存状态有提示；fleet 未配置时提示策略暂不生效。

Fleet 机器编辑器增加 labels 键值；集群 fleet 表/节点 remote lease 面板展示 labels。

### 12.7 边界

- 规则词汇来自 fleet 实际配置；没有标签的机器无法被自然语言精确区分（会进入 warnings）。
- 项目级策略对所有 GPU 节点生效；暂未提供节点级覆盖。
- 硬约束不满足时**只排队、不降级**（研究可复现性优先）；需要"尽力而为"时请用"优先/尽量"措辞。
- 本地 placement（单机模式）不经过 coordinator，策略不生效；只有 fleet/多机路径使用。
- 编译是规则式；复杂自然语言可能需要手工用结构化规则修正（后续可加 LLM 编译器并从 UI 编辑结构化规则）。

---

## 13. 节点会话历史：复用 DSH 原生 Conversation / Trajectory（V8）

### 13.1 为什么不再自己画轨迹

早期 Lab 的“节点对话”抽屉只是自行轮询 `/transcript` 并渲染简单行，缺少 DSH 原生的能力：
turn/step 分界、交互式时间轴概览、长历史分页/虚拟滚动、搜索/折叠、工具调用与嵌套 subtool 的分类、
调用详情 inspector（token/耗时/输入输出/图片/附件/时序）等。重复实现既难维护，也打不过原生体验。

V8 改为**直接打开该 agent 的 DSH 原生 Session 视图**，Lab 不再渲染对话历史。

### 13.2 接入方式

- 客户端注入 DSH 的 `sessions` 和 `uiWorkspace` 服务；
- 打开节点会话时：
  1. 从 `node.sessionId`（没有则回退到 `attempts[].sessionId`）取目标 Session；
  2. 写 `localStorage['dsh.conversation.<sessionId>']` 的 `view` 字段为 `trajectory` 或 `chat`
     （保留 JSON 中其它键，如草稿），让原生 Conversation 恢复对应标签；
  3. `ctx.uiWorkspace.openSession(ctx.sessions.subagentAddress?.(sessionId) ?? sessionId)`：
     已知 Session 或“持久直接父 subagent 地址”都可以；同步切换主面板到原生 Conversation，
     历史加载发生在该 Session 视图内。
- 原生 Conversation 由 DSH 提供 Chat 和 Trajectory 两个标签；Trajectory 即 DSH 默认轨迹工具。
- 若 `ui-trajectory` 的 Trajectory 标签因“显示代码工作视图”未开启而隐藏，原生会回退到 Chat；
  Lab 的“会话与轨迹（DSH 原生）”区域会提示去 **DSH 设置 → 通用 → 显示代码工作视图** 开启。

### 13.3 UI 入口

- 节点卡片**双击** → 原生轨迹；已完成且 sealed 的叶子节点“查看对话” → 原生轨迹；
- 未 sealed 的已完成叶子“继续” / running merge → Lab 的“继续对话”弹窗（见 13.4）；
- 节点检查器新增 **“会话与轨迹（DSH 原生）”**：
  - Session id；
  - “在 DSH 中打开轨迹 / 在 DSH 中打开对话”；
  - 每次 attempt 一行，可分别打开该 attempt 自己的 Session 轨迹；
  - 原生轨迹能力与 developer-tools 提示。
- Lab 不再轮询 `/transcript`，也不再渲染自带 transcript 行；Host 的 `/transcript` API 仍保留，
  供 agent tool（`transcript` action）和自动化/测试使用。

### 13.4 后续对话仍走 Lab

原生视图用于**只读历史**；继续对话仍通过 Lab 的“继续对话”弹窗发送 `node.message`，以便：
- 受节点密封/叶子/状态条件约束；
- 继续占用项目/GPU 资源时由 Lab runtime 记录 follow-up、检查 lease/配额；
- 不让浏览器直接向 subagent Session 注入用户消息而绕过实验状态机。

### 13.5 边界

- 打开原生视图后主面板离开 Lab；返回用左侧 Lab 图标（原生导航由 DSH 管理，见 ui-workspace）。
- 原生 Conversation 的输入框对 subagent Session 可能可见/可编辑，但 Lab 的推荐路径仍是 13.4；
  如需完全禁止直接输入，后续可在原生 Session 上增加只读策略。
- 轨迹标签是否显示取决于 DSH developer-tools 设置；Lab 不改全局设置，只提示用户开启。
- 浏览器端没有自动化截图验证；以 stub harness + 静态审计验证打开调用、视图偏好、attempt 目标和 no-transcript 约束。
