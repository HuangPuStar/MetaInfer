# harness_default —— DKAO 可演化 harness 的种子目录

这是 AHE「组件可观测性」的落地目录：DKAO 的 harness（验收门阈值、轮次指令文案、
planner 策略、以及后续的 skills/工具/中间件/记忆）**文件化**在这里，成为可版本化、
可校验、可演化的组件。AHE 外循环（`harness_evolve`）以本目录为种子，拷贝出可写
workspace（git 仓库），每轮评测 pin 一个快照；Evolve Agent 只改 workspace。

## 目录内容与接线状态

```
harness_default/
├── manifest.yaml                    # 组件清单 + 每个组件的 wired 开关（AHE 可写空间的入口描述）
├── gates.yaml                       # 验收/plateau/ISA 门阈值            ← 已接线 gate_policy.gates()
├── planner_policy.yaml              # 状态→方案选择规则（P0-P4 分层）      ← 已接线 planner.policy()
├── planner_catalog.yaml             # 方案目录：稳定 plan id + 面向 worker 的描述 ← 已接线 planner.catalog()
├── systemprompt/
│   └── round_strategy.yaml          # 每轮给 worker 的指令文案（P0 修复/P1 阶段/各 M regime 组合）
│                                    #   ← 已接线 round_strategy.load_round_strategy()
├── README.md                        # 本文件
└── (后续切片加入)
    ├── systemprompt/                # 其余 prompt 模板（coordinator/bootstrap/worker/synthesis）
    ├── tools/                       # cordis 组合与 per-role 工具白名单
    ├── middleware/                  # resume/compaction/重试策略参数
    ├── skills/                      # SKILL.md 种子
    └── memory/                      # LongTermMEMORY（measured 事实）
```

## 语义（重要）

**`wired` 是总开关。** `manifest.yaml` 里每个组件标 `wired: true` 时，运行时读该文件；
标 `wired: false`（或删掉该组件项）时，运行时回落到 Python 内置默认值 —— 也就是说
**编辑一个未接线的组件不会改变任何行为**，而 `harness_evolve` 的
`_wired_scope_violations()` 会把这种"改了但不生效"的改动报出来。

**回落是逐键的。** 文件缺失、YAML 损坏、某个键写错类型或写成空串，都只让**那一个键**
回落到内置文本，其余照常生效；`RoundStrategy.notes` / 加载器会记录原因，但**绝不抛异常**
（一个手改坏的 harness 是性能问题，不该让一轮评测崩掉）。

**决策逻辑不在文件里。** 以 `round_strategy.yaml` 为例：走哪个分支由实测状态（history /
ISA 阶段 / PMC 证据 / M regime / 轮次预算）在 `orchestrator/round_strategy.py` +
`prompts.py` 里判定，文件只承载每个分支的**文案**。这样"这轮让 worker 试什么"可演化，
而选择状态机本身不可被改写。

**一致性由测试守卫**（drift guard，见 manifest 每个组件的 `drift_guard`）：
每个 YAML 种子的取值都被断言等于 Python 内置默认值，因此两条来源不会无声漂移。
`tests/test_round_strategy.py` 另外用 5400 个渲染用例的 sha256 指纹把文案钉死 —— 任何
意外改词都会让该测试失败。**有意改文案时**：同步改 `BUILTIN_STRATEGY` 与种子文件，
并有意重算指纹。

## 读取方式

- 根目录解析：`orchestrator/harness_io.harness_root()` —— 优先环境变量
  `METAINFER_HARNESS_ROOT`（AHE 用它指向本轮候选快照），否则回落本目录。
- 组件读取：`gate_policy.gates()` / `planner.policy()` / `planner.catalog()` /
  `round_strategy.load_round_strategy()`；通用 YAML 读取用
  `harness_io.load_component_yaml()`（返回 `(data, error)`，不抛异常）。
- 播种：`harness_io.seed_workspace(dst)` 或 CLI 路径上的任务建仓逻辑会把整棵树拷进
  kernel repo 的 `harness_snapshot/`，并把 `source` / `revision` / 逐文件 digest 写进
  `scaffold_manifest.json`，用于"哪一轮用了哪版 harness"的追溯。
- 缓存：各加载器按 `(路径, 文件 mtime, manifest mtime)` 缓存，所以运行中途换 harness
  会被下一轮读到（测试亦用 `reset_cache()` 隔离）。
