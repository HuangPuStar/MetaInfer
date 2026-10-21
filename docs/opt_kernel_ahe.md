# opt_kernel × AHE：可证伪预测 + Agent Debugger 经验可观测

> 设计文档（design doc）。参考：
> - AHE 论文/官方仓库 `china-qijizhifeng/agentic-harness-engineering`（基于 NexAU）
> - AHE blog：`dawning-road.github.io/blog/agentic-harness-engineering`、`.../blog/agent-debugger`
> - NexAU 框架：`nex-agi/NexAU`

## 1. 背景：AHE 的三支柱

AHE（Agentic Harness Engineering）固定基座模型，把 coding agent 周围的 **harness 组件**
（systemprompt / tool_descriptions / tools / middleware / skills / sub_agents / LongTermMEMORY）
作为可学习、可演进的"适应面"。每轮 `evaluate → analyze → improve`，三个可观测支柱：

| 支柱 | AHE 做法 |
|---|---|
| ① 组件可观测 | 7 个正交组件都是文件、git-tracked，每个改动可审计可回滚 |
| ② 经验可观测 | **Agent Debugger** 把 ~10M token 原始轨迹蒸馏成分层、带溯源的报告：`analysis/overview.md`（跨任务根因汇总）+ `analysis/detail/{task}.md`（逐任务深挖），每条结论链回原始轨迹。optimizer 默认读摘要，需要时下钻 |
| ③ 决策可观测 | **Evolve Agent** 每个改动必须写 4 字段：失败证据 / 根因 / 针对性修复 / **预测影响**（哪些任务会翻盘、哪些有风险）。下一轮验证，预测不成立就回滚 |

## 2. opt_kernel 现状对照

opt_kernel 也是固定模型 + 闭环（`A_plan → B_implement → C_test → D_review → E_perf_test → F_perf_plan`），
但**演进目标不同**：AHE 演进 harness 求通过率；opt_kernel 演进 **kernel 产物**求性能。

| 支柱 | opt_kernel 现状 | 差距 |
|---|---|---|
| ① 组件可观测 | `prompts.py`/`phases.py`/oracles 都是文件 ✓；kernel 产物在 `workspace/NNN/` ✓ | harness 组件**不是演进目标**，无 per-iteration 版本清单 |
| ② 经验可观测 | 有 `timeline.jsonl`、`retrospective.md`、reviews、`perf_report.json` | planner 只看**上一轮**的 `failure`/`review_feedback`/`perf_plan`（1 步窗口），**无跨迭代蒸馏的根因证据库** |
| ③ 决策可观测 | planner 写 `plan.md`（含 rationale）；perf oracle 有 `regression` 二值标记 | **无结构化可证伪预测**（期望哪个指标变多少、为什么），perf 结果也**不绑定到具体预测**来判定成立/回滚 |

**核心洞察**：opt_kernel 的 planner 是"只记一步的记忆"——看不到"过去 5 轮里凡是
triton tiling 的都 correctness 回归"这种跨轮模式。这正是 AHE Agent Debugger 解决的。

## 3. 设计目标与边界

- **演进目标不变**：仍演进 kernel 产物求性能（不做 P3 harness meta-evolution，见 §8）。
- **搬过来的是"可观测闭环"件**：P2（可证伪预测）+ P1（Agent Debugger 跨迭代证据）。
  这两件与"演进什么"无关，是通用的闭环增强。
- **非阻塞、可降级、向后兼容**：所有新增件都 advisory——失败/缺失时降级到当前行为，
  **绝不**改变 phase 状态机 / outcome / transition（照抄 `_maybe_run_e2e_oracle` 的 advisory 姿态）。
- **单一数据源合规**（见 CLAUDE.md）：perf 数字权威源是 `perf_report.json`（oracle）。
  本设计新增的 `predictions.json` / `change_evaluation.json` / `analysis/*.md` 全部
  标注为**派生历史快照**——写完只用于喂 planner 上下文，**不回写权威源**，不驱动 runtime 状态。

## 4. P2 — 可证伪预测（决策可观测）

> 优先实现。改动最小、风险最低、立刻让迭代"带方向感"。

### 4.1 数据结构

**planner 产出** `predictions.json`（A_plan 阶段，与 `plan.md`/`test_spec.md` 同目录）：

```json
{
  "iteration": 3,
  "baseline_perf": {"tokens_per_sec": 1200.0, "ms_per_op": 0.8, "speedup": 1.2},
  "predictions": [
    {
      "id": "p1",
      "change": "shared-memory tiling for M dimension (tile=64)",
      "target_metric": "tokens_per_sec",
      "direction": "increase",
      "expected_delta_pct": 15.0,
      "reason": "reduces global memory reads ~4x for the M-tile hot path",
      "at_risk_metrics": ["ms_per_op", "correctness"],
      "confidence": 0.7
    }
  ]
}
```

- `direction`：`increase`（越大越好，如 tokens_per_sec/speedup/gflops/bandwidth）或
  `decrease`（越小越好，如 ms_per_op）。
- `baseline_perf`：planner 从上一轮 `perf_report.json` 读到的基线（planner 自填，仅供比对参考；
  比对的**权威基线**是 `_evaluate_predictions` 从 `store.load_iteration(n-1).perf` 取的，见 §4.3）。
- 字段全部 **optional**：缺任何一个 prediction/prediction 整体缺失都不影响主流程。

**post-perf 产出** `change_evaluation.json`（E_perf_test 后、F_perf_plan 前由 orchestrator 计算）：

```json
{
  "iteration": 3,
  "baseline_perf": {"tokens_per_sec": 1200.0, "ms_per_op": 0.8, "speedup": 1.2},
  "actual_perf":   {"tokens_per_sec": 1380.0, "ms_per_op": 0.72, "speedup": 1.38},
  "regression": {"regressed": false, "drop": null, "threshold": 0.20},
  "predictions": [
    {
      "id": "p1",
      "target_metric": "tokens_per_sec",
      "direction": "increase",
      "expected_delta_pct": 15.0,
      "actual_delta_pct": 15.0,
      "verdict": "confirmed",
      "at_risk_regression": false,
      "at_risk_actual": {"ms_per_op_delta_pct": -10.0, "correctness": "pass"}
    }
  ],
  "summary": "1/1 predictions confirmed; 0 at-risk regressions",
  "verdict_text": "p1 CONFIRMED (tokens_per_sec +15.0% expected vs +15.0% actual)"
}
```

- `verdict`：`confirmed` | `falsified` | `inconclusive`
  - `confirmed`：actual_delta 与 direction 一致且 |actual| ≥ 50%·|expected|（容差带，避免噪声误判）
  - `falsified`：actual_delta 与 direction **相反**，或 |actual| 远低于 expected 且有回归
  - `inconclusive`：无 prev 基线 / 目标 metric 缺失 / 实际数据不可用
- `at_risk_regression`：该 prediction 声明的 `at_risk_metrics` 里是否真有回归
  （从 oracle `report.regression` + 实际 perf delta 判定）。

### 4.2 状态机影响：无

P2 **纯 advisory，不进 transition 表**。`_evaluate_predictions` 在 `_do_perf_test` 返回 OK 后、
`_do_perf_plan` 之前调用，照抄 `_maybe_run_e2e_oracle` 的"写文件 + timeline 事件，返回 None，
任何异常 catch 后只记 timeline"模式。`PERF_REGRESSION` 路径完全不动（oracle 仍是回归权威）。

### 4.3 计算位置与流程

```
E_perf_test (OK, perf)
   └─> _evaluate_predictions(n, iter_dir, rec, this_perf)
          1. 读 iter_dir/predictions.json  (planner 在 A 写的；缺失 → no-op return)
          2. baseline = store.load_iteration(n-1).perf  (权威基线)
          3. 对每个 prediction 比对 this_perf vs baseline → verdict
          4. 写 iter_dir/change_evaluation.json
          5. timeline 事件 "prediction_evaluated"
          6. 返回 verdict_text (str|None) → 挂到 ctx 供 F/下一轮 A 读
F_perf_plan  (prompt 注入 verdict_text)
   └─> (iteration consume) close_iteration
下一轮 A_plan: plan_prompt(prev_failures=..., prediction_verdict=ctx.prediction_verdict)
```

- `ctx`（`IterationContext`）新增字段 `prediction_verdict: Optional[str] = None`。
- F_perf_plan prompt 末尾追加 `# Previous change-evaluation verdict` 段（若有）。
- 下一轮 A_plan：`plan_prompt` 新增参数 `prediction_verdict`，注入在 `# Previous failures` **之前**
  （先看自己上轮的预测对不对，再看失败）。`prev_failures` 保留作 fallback。
- 权威基线用 `load_iteration(n-1).perf`（IterationRecord 是已持久化的派生记录），
  而非 planner 自填的 `baseline_perf`——后者仅作 sanity 校验/展示，不参与判定。

### 4.4 单一数据源标注（CLAUDE.md 合规）

- `perf_report.json`（oracle）= **权威源**（perf 数字 + regression）。
- `predictions.json` = planner 的**历史声明快照**（historical record；runtime 不据此改状态）。
- `change_evaluation.json` = **派生快照**（从 `perf_report.json` + `predictions.json` 计算，
  注释写明 "historical record, runtime reads from perf_report.json"）。仅作 planner 上下文。
- 不写入 `run.json` / `registry.json` / `IterationRecord` 的权威字段。
  `IterationRecord` 可**新增**两个可选路径字段（`predictions_path`/`change_eval_path`）供审计——
  纯 additive，`from_dict` 已忽略未知字段，向后兼容。

### 4.5 降级与边界

- 第一轮 / `predictions.json` 缺失 / JSON 解析失败 → `_evaluate_predictions` 直接 return，无 timeline 事件。
- `actual_perf` 缺目标 metric → 该 prediction `inconclusive`，不 crash。
- 无 prev 基线 → 全部 `inconclusive`。
- `_evaluate_predictions` 抛异常 → catch，记 timeline `prediction_eval_error`，主流程继续。

### 4.6 测试计划（P2）

纯函数 `evaluate_predictions(predictions, baseline_perf, actual_perf, regression) -> dict`，模块级、可单测：

1. `confirmed`：direction=increase, expected=15, actual=+15 → confirmed
2. `falsified`：direction=increase, expected=15, actual=-12 → falsified
3. `falsified`：direction=increase, expected=15, actual=+2（< 50%·expected）→ falsified
4. `inconclusive`：无 baseline / metric 缺失
5. `at_risk_regression`：at_risk 含 ms_per_op 且实际 ms_per_op 上升 > 阈值 → true
6. `predictions.json` 缺失 → `_evaluate_predictions` no-op（pipeline 层 mock manager 验证不调用）
7. 异常路径 → timeline `prediction_eval_error`，outcome 不变（pipeline 层 mock）
8. planner prompt 含 verdict_text；F prompt 含 verdict 段（prompt 构造单测）

## 5. P1 — Agent Debugger（经验可观测）

> P2 完成后实现。价值更大但工作量高一档：加分析步 + 跨迭代聚合。

### 5.1 两层证据库（照抄 AHE 的 overview/detail 分层）

- `analysis/detail/iter_NNN.md` — **单轮深挖**：debugger agent 读该轮**完整轨迹**
  （timeline 事件 + logs + `plan.md` + 代码 + reviews + `perf_report.json` +
  `predictions.json` + `change_evaluation.json` + retrospective），产出结构化根因分析，
  每条结论**链回**具体 timeline 事件 / 文件行。包含：本轮改了什么、为什么 perf 移动、
  哪个预测被证伪及根因、反复出现的失败模式标记。
- `analysis/overview.md` — **跨迭代汇总**：debugger agent 读所有 `detail/iter_*.md` +
  `iterations/*.json` + perf 历史，产出跨轮根因汇总：哪些改动模式帮助/伤害（如
  "shared-mem tiling 3 次有 2 次 correctness 回归"）、反复出现的失败模式、
  已被证伪的"禁区"清单、建议方向。每轮迭代后**重新生成**（覆盖写）。

### 5.2 状态机影响：无（advisory，照抄 e2e oracle）

新增 `_maybe_run_debugger(n, iter_dir, rec, this_perf)`，在 F_perf_plan 之后
（或 `close_iteration` 内）调用。和 `_maybe_run_e2e_oracle` 同构：
- `cfg.agent_debugger.enabled`（默认 True）/ `.interval`（默认 1，每轮跑）/ 可独立 LLM。
- 任何异常 → catch + timeline `debugger_error`，返回 None，不改 outcome。
- timeline 事件 `agent_debugger`（写了哪些 detail/overview）。

### 5.3 planner 上下文：overview 替代单步 prev_failures

`plan_prompt` 新增 `debugger_overview: Optional[str]`，注入在 `# Previous failures` **之前**
的 `# Cross-iteration debugger evidence` 段（capped ~4KB）：

- overview 存在 → 注入 overview 摘要，`prev_failures` 仍保留（最新一步的快速召回）。
- overview 缺失（首轮 / debugger 禁用 / 失败降级）→ 退化为当前行为（只看 prev_failures）。

**这正是治"只记一步"的药**：planner 默认读跨轮 overview 摘要，需要时下钻 detail。

### 5.4 落点（符合 CLAUDE.md 目录约定）

`analysis/` 放在 **workspace ``iterations_root``**（``<iterations_root>/analysis/``），
与各迭代目录 ``001/``、``002/`` 并列——因为 debugger agent 的 cwd 设为
``iterations_root``（这样才能读兄弟迭代目录、并在 ``analysis/`` 下写文件），
而 ``state_dir`` 不在 agent 的可访问目录里。轨迹数据（timeline / 迭代记录）由
orchestrator 用 Python 读出后**嵌入 prompt 文本**，agent 不直接访问 ``state_dir``。
planner 同理：orchestrator 用 Python 读 ``overview.md`` 后以文本注入 plan_prompt，
planner agent 本身不触碰 ``analysis/``。
- ``<iterations_root>/analysis/detail/iter_NNN.md``
- ``<iterations_root>/analysis/overview.md``

注释标明：`analysis/*` = derived historical record, computed from timeline.jsonl
+ iterations/*.json + perf_report.json（runtime 仍从这些权威源读，analysis 不回写）。

### 5.5 配置与实现

```python
@dataclass
class AgentDebuggerConfig:
    enabled: bool = True
    interval: int = 1            # 每 N 轮跑一次（0=禁用）
    detail_timeout_s: int = 900
    llm_model: Optional[str] = None   # None = 主模型
    overview_cap_chars: int = 4096    # 注入 planner prompt 的上限
```

挂在 ``OrchestratorConfig.agent_debugger``（additive，默认开启但可关）。

**单 agent 调用写两个文件**：debugger 一次调用同时产出 ``detail/iter_NNN.md``
与重写 ``overview.md``（overview 从所有 detail + 迭代记录重新综合）。debugger
cwd = ``iterations_root``，轨迹上下文（iteration summary + timeline 摘要 + prior
detail 路径）由 orchestrator 预计算并嵌入 prompt。

### 5.6 测试计划（P1）

1. `_maybe_run_debugger` 在 enabled 且 interval 命中时调用 manager.launch（mock manager，
   验证 prompt 含 timeline/iterations/perf 上下文）。
2. detail/overview 文件被写（mock agent 写固定 md）。
3. planner prompt 在 overview 存在时含 `# Cross-iteration debugger evidence` 段（构造单测）。
4. overview 缺失 → planner 退化为只看 prev_failures。
5. debugger agent 抛异常 → timeline `debugger_error`，outcome 不变（pipeline mock）。
6. `enabled=False` → 不调用 manager。
7. interval=2 → 只在偶数轮调用。

## 6. 不动的东西（明确边界）

- `phases.TRANSITIONS` / `Phase` / `Outcome` 枚举：**不改**。
- `_regression_failure` / oracle 回归判定：**不改**（oracle 仍是回归权威）。
- `run.json` / `registry.json` schema：**不改**（P2/P1 全程不写权威状态）。
- `_close_iteration` 的 status/outcome 逻辑：**不改**。
- 既有 `prev_failures`/`review_feedback`/`perf_plan`/`user_feedback` 通路：**保留**作 fallback。

## 7. 实现顺序与里程碑

1. **P2 主体**：`evaluate_predictions` 纯函数 + 单测（无 pipeline 依赖，先绿）。✅
2. **P2 接线**：`_do_perf_test` 末尾调 `_evaluate_predictions`；`ctx.prediction_verdict`；
   `plan_prompt`/`perf_plan_prompt` 注入 verdict；`predictions.json` 让 planner 在 A 写
   （prompt 指令 + 降级）。✅
3. **P2 集成测**：pipeline 层 mock manager，验证 advisory 不改 outcome + timeline 事件 + prompt 注入。✅
4. **P1**：`AgentDebuggerConfig` + `_maybe_run_debugger` + detail/overview agent prompt +
   planner 注入 overview + 单测/集成测。✅
5. 文档随实现更新本文档的"已实现"标记。✅

**当前状态**：P2 + P1 均已实现并测试。opt_kernel 127 测 + orchestrator/server 124 测
全绿，无回归。

## 8. 范围外（backlog，不在本次）

- **P3 — harness meta-evolution**：让闭环除 kernel 外也调 planner/reviewer prompt、
  oracle 阈值、form 参数。这是 AHE 本体（演进 harness 产出通用工程经验，能跨模型/跨 benchmark
  迁移），但对 opt_kernel 是范式扩展、风险高，需 P1+P2 稳定后再评估。AHE blog 也强调
  "AHE 强大但不是魔法"，harness 演进的迁移性是它特有的，不宜盲目照搬。
- **NexAU 借鉴件**（低优先）：
  - Tracer/Langfuse：导出 timeline 到可观测后端做跨 run 分析。
  - Skills（Claude 兼容）：把 "triton tiling"/"hip-prof" 抽成可复用 skill。
  - Middleware：上下文压缩 / failover（pi session 隔离属此类）。
  - Tool 定义/实现解耦（YAML + binding）：oracle/工具更模块化。

## 9. 与既有 PR 的关系

- 本工作在 `/tmp/MetaInfer`（pr17 工作区）进行，与 pi-agent-backend PR（`feat/pi-agent-backend`，
  PR #32，base `next-app`）**独立**。pi 后端是"用哪个 agent 跑这些 phase"，AHE 件是
  "phase 之间如何闭环学习"，正交。
- pi PR 已合入后，opt_kernel 的 AHE 增强会随 pr17 一起回流（pr17 的 feedback/profile/correctness
  + 本 AHE 件同属一个会话线）。
