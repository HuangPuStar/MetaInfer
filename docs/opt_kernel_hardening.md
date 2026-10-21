# opt_kernel × AHE 硬化补丁（KDA / Humanize 对照）

> 本批六件改动：用 KDA（Acceptance Gauntlet / reward-hacking 分类）和 Humanize（flame-chase flow）的思路，给 opt_kernel 的 advisory 闭环补上实验里暴露的真实缺口。全部 **advisory**：不动 ABCDEF 状态机、不碰 `perf_report.json` 单一权威源、不改回归闸门。失败一律降级为 timeline 日志或派生产物，绝不阻塞主循环。

## 0. 背景：16 轮实验暴露的缺口

`docs/ahe_experiment_report.md` 记录的真实 16 轮 W8A8 GEMM 任务暴露了四个可证伪的问题：

1. **正确性 oracle 的测试分布是固定的**（`torch.manual_seed(42)` + 均匀 randint）——agent 能把"测试集分布的常数"硬编码进内核通过 gate（KDA hack A）。
2. **perf oracle 用 CUDA Graph capture→replay 计时，但只在单一输入上验证过一次**——agent 若把输出按 `id(x_q)` 缓存，单次正确性检查通过、graph 捕获的是"返回缓存"的廉价路径 → 假性高吞吐（KDA hack C）。
3. **没有平台期逃逸机制**——agent 在 prefill 1610µs 上卡了 14 轮，fintune 反复微调同一局部最优，无结构性重写（Humanize flame-chase 的 rewrite↔fine-tune 缺失）。
4. **经验不跨任务累积**——debugger 蒸馏的 FM-1~FM-15 失败模式 + do-not-repeat 清单只活在单个任务的 `analysis/overview.md`，下一个任务从零开始。
5. **拿不到硬件计数器**（FM-3）——默认 GPU 卡争抢、rocprof 没接，agent 瞎猜微架构瓶颈 14 轮，直到 iter#14 自己即兴造了"绑专用卡 + A/B"。

本批六件对应补这五个缺口（#1+#4 合一文件）。

---

## 1. correctness oracle 动态盐 + holdout 分布（#1）+ 压力探针 shape（#4）

**文件**：`orchestrator/oracles/correctness.py`

**#1 动态盐**：新增 `_oracle_seed(task_id, iteration) -> int`，用 `sha256(f"{task_id}|{iteration}")` 前 4 字节派生种子；`_gen_inputs` 用该种子生成每轮输入。per-run 变化（agent 无法预测测试分布），但同 `(task_id, iter)` 可复现（失败可重放）。`CorrectnessReport` 新增 `oracle_seed: Optional[int]` 字段，`run()` 计算并盖戳到报告。

> **刻意与 perf oracle 的固定 seed 42 分道**：perf 要跨轮可比（同一输入反复计时），correctness 这个 referee 要分布多样性（覆盖更广）。两者现在在不同输入上验正确性——注释里写明了此 divergence rationale。

**#1 holdout 分布** `_gen_inputs(M,K,N,device,seed,fill)`：新增 `fill` 三模式：
- `uniform`（legacy，向后兼容）；
- `saturated`（只取 ±127 + 大 scale，压极端量化/溢出路径）；
- `gaussian`（截断正态，分布形状异于均匀——硬编码均匀分布常数的内核会在此失败）。

**#4 压力探针 shape**：`_resolve_correctness_shapes` 末尾加 3 个 stress shape（shape 集 10→13）：
- `{"M":1,"K":K,"N":N,"fill":"saturated"}`、`{"M":4096,"K":K,"N":N,"fill":"saturated"}`、`{"M":1,"K":K,"N":N,"fill":"gaussian"}`。
- representative/edge shape 无 `fill` key → 走 `uniform`（向后兼容）。
- `_check_shape` 读 `shape.get("fill","uniform")` 调 `_gen_inputs`。

oracle 版本 `iter1-edge-case-gating → iter2-salt-stress`。

**测试**（`test_correctness_oracle.py`，+7）：shape count 稳定=13、stress probe 存在且尊重 override K/N、seed 可复现且变化、三种 fill 分布可区分、`run()` 盖 seed 戳、正确内核在 stress shape 上也过、count 测试改 13。

---

## 2. CUDA Graph replay 换输入校验（#2）

**文件**：`orchestrator/oracles/perf.py`（新增 `_input_sensitivity_check`，接进 `_benchmark_gemm` 计时后、baseline 前）

**威胁模型**：perf oracle 用 graph capture→replay（或重复调用同一输入张量）计时。agent 内核若把输出按 `id(x_q)` 缓存，单次正确性检查（只见过一组输入）通过；warmup+计时全是 cache 命中 → graph 捕获"返回缓存"廉价路径 → 假性高吞吐（KDA hack C）。

**防御**：
- **CUDA 路径（graph-replay 校验）**：捕获 graph 并持有输出引用 → **原位改写输入张量**（同对象同 `id()`，用 seed=7777 的新值）→ 算 PyTorch 参考（新输入）→ replay graph → 比对输出。忠实内核重新读输入、输出随输入变；identity-cache 返回旧缓存 → 失配 → 抓。
- **CPU / 捕获失败**：退回直接调用探测（原位改输入 + 直接调内核 + 比参考），同样抓 identity-cache。
- 失败 → `sr.correct = False`、`error = "input-insensitivity: ..."`、speedup 归零（内核不是输入的忠实函数 = 不正确）。
- `finally` 原位还原输入，baseline/下游不受影响。

**SSOT 边界**：本检查是 perf oracle **正确性 gate 的一部分**（更强的正确性校验），不改 perf 数字权威源——`perf_report.json` 仍是唯一权威；本检查只决定 `correct` 布尔。

**测试**（`test_input_sensitivity.py`，+7）：faithful 通过、常量输出被抓、identity-cache 被**抓**（先 warmup 填缓存再探测，模拟真实）、输入原位还原（逐字节校验）、崩溃内核不抛只报错；集成：经 `_benchmark_gemm` 的 identity-cache 内核模块 → `correct=False`+error 含 "input-insensitivity"，faithful 模块 → `correct=True`。本机有 GPU(HIP)，graph-replay 路径实测：faithful 无假阳性、identity-cache 被抓。

---

## 3. search_mode：flame-chase 式重写↔微调（#3）

**文件**：`orchestrator/pipeline.py`（四个纯函数 + 接进 `_do_plan`）、`orchestrator/prompts.py`（`plan_prompt` 注入）

Humanize 的 `flame_chase` flow：单 fintune agent 卡在最近局部最优；它交替 **rewrite**（结构性改、逃逸最优）与 **fine-tune**（爬下一个峰）。我们 deterministic 触发 `rewrite`：当主指标在连续 `PLATEAU_WINDOW` 个已完成迭代内无改进（超出噪声 margin）。

**纯函数**（pipeline 模块级，trivially unit-testable）：
- `_primary_metric(perf) -> Optional[(value, direction)]`：偏好序 `ms_per_op`(decrease) → `tokens_per_sec`(increase) → `speedup`(increase) → `gflops`(increase)。
- `_is_improvement(new, best, direction)`：改进须超过 0.5% 相对 margin（抗噪，mirrors perf oracle 的抗噪姿态但更小——这是 nudge 不是 gate）。
- `_count_iters_since_best(store, workspace) -> int`：**无状态**从 store 读历史 IterationRecord.perf，算"距上次新最优几轮"。resume-safe（重启重算同值，不靠内存计数器）。
- `_resolve_search_mode(iteration, iters_since_best, plateau_window=3) -> "fine_tune"|"rewrite"`：`iteration>1 且 iters_since_best>=3` → `rewrite`。

**接线**（`_do_plan`，stateless）：每轮 plan 前算 `iters_since_best` + `search_mode`，记 `search_mode` timeline 事件，传给 `plan_prompt` 新参 `search_mode`。

**prompt 注入**：`REWRITE` 指示"做结构性改动（重写 tiling/split-K/流水线 或换实现路径），保留当前最优作一行回退兜底"；`FINE-TUNE` 指示"小步可验证改进"。正好治 16 轮 prefill 卡 1610µs 14 轮的平台期。

**SSOT 边界**：advisory——只改 planner prompt，不碰状态机、不改 perf gate、不读 `perf_report.json` 之外的任何权威源。`_count_iters_since_best` 读 `IterationRecord.perf`（运行时状态权威源 `run.json` 体系内），重启安全。

**测试**（`test_search_mode.py`，+15）：四个纯函数全路径 + fake store/workspace 的 plateau 检测 + 跳过无 perf 记录 + resume-safe + plan_prompt 注入/省略 + window 可配置。

---

## 4. 跨任务 lessons wiki（#5）

**文件**：`orchestrator/lessons.py`（新）、`pipeline.py`（finish 写 + plan 读）、`prompts.py`（debugger 写快照 + plan 注入）

**权威源**：节点级 `nodes/<node>/.metainfer/lessons.jsonl`——append-only，fcntl 锁防并发任务 finish 交错。每行 `{ts, source_task_id, task_type, category, headline, detail}`，`category` 限定 `failure_mode`/`do_not_repeat`/`insight`，非法行跳过（不让 agent 自由文本污染 wiki）。

**SSOT 约束**（见 CLAUDE.md §数据一致性）：
- **per-task `analysis/lessons.jsonl`** = **历史快照**（debugger 在 close 时写，orchestrator 在 finish 时**一次性追加**到 wiki，之后不再回读）。符合"historical record, runtime reads from <other_file>"标注模式。
- **节点 wiki** = 唯一权威读源。单向：task 快照 → wiki（append）；无 wiki → 回写 task。无双向同步。
- 新任务只读 wiki；冷重启从磁盘重读，resume-safe。

**写路径**（`_append_lessons_to_wiki`，finish 块）：读 debugger 写的 per-task 快照 → 盖 `ts`/`source_task_id`/`task_type` 戳 → 追加到节点 wiki → 记 `lessons_wiki_append` timeline。无快照 → 0；全程 try/except（崩了只记 `lessons_wiki_error`，绝不阻塞 finish）。

**读路径**（`_do_plan`）：读 wiki（按 `task_type` 过滤，limit）→ `lessons_prompt_block` 渲染（最新在前、category 大写标签）→ 注入 `plan_prompt` 新参 `cross_task_lessons`。空 wiki → 不注入（`lessons_prompt_block` 返回 None）。

**debugger 写快照**：`debugger_prompt` 加第 3 个交付物指令——让 agent 写结构化 `analysis/lessons.jsonl`（0-8 行，每行一个 JSON 对象，`category`/`headline`/`detail`）。agent 行为；orchestrator 只追加不解释。

**路径校验**：`node_metainfer_dir(state_dir)` 验证 `state_dir.parent.parent` 名为 `.metainfer`——错布局**显式报错**而非静默写错地方（否则新任务读不到）。

**测试**（`test_lessons_wiki.py`，+14）：纯模块（stamp/filter、按类型过滤+limit、prompt 渲染、路径校验抛错）+ 接线（finish 追加+timeline、无快照0记录、错误被吞、plan 注入/空wiki不注入）。

---

## 5. profiler skill：治 FM-3 rocprof 缺失（#6）

**文件**：`orchestrator/profiler.py`（新）、`prompts.py`（`perf_plan_prompt` 注入）、`pipeline.py`（F 阶段传 hint）

agent 14 轮里拿不到硬件计数器（默认卡争抢、rocprof 没接），微架构瓶颈瞎猜，直到 iter#14 自己即兴造了"绑专用卡 + A/B"。本件给一个 ready、可测的 profiling 能力，而非让每个任务重新发现。

**模块**（`profiler.py`，subprocess 全可注入，测试不碰 GPU/rocprof）：
- `find_idle_gpu(runner, preferred)`：rocm-smi JSON → nvidia-smi CSV 回退，选 VRAM 占用最低设备；工具缺失 → None（降级默认）。`runner` 可注入。
- `parse_rocprof(text)`：纯解析 CSV/表格式计数器输出，跨行求和，garbage → `{}`，永不抛。
- `build_driver_script(kernel_path, shape, num_iters, device)`：纯生成 in-process 内核 driver（加载 kernel.py + shape + warmup + N 次），rocprof 包它跑。
- `profile_kernel(...)`：编排——选空闲设备（或指定）→ 写 driver → `rocprofv2 --stats` → 解析 → 写 `profile_out.json`。失败时 JSON **显式记 FM-3 gap**（`error: "rocprof run failed..."`）而非静默 None——让 agent 看清是工具缺失，回退 iter#14 方法论。返回 dict（成功）或 None（失败，advisory）。
- `main(argv)` CLI：`python -m metainfer.tasks.opt_kernel.orchestrator.profiler <kernel.py> --M .. --out ..`（已加 `__main__` guard，`--help` 验证通过）。
- `profiler_skill_text(repo_root)`：prompt 段，告诉 perf planner 工具存在 + 调用命令 + iter#14 方法论 + 显式标 FM-3。注入 `perf_plan_prompt` 新参 `profiler_hint`，F 阶段 `_do_perf_plan` 从 `cfg.repo_root` 构造传入。

**SSOT 边界**：`profile_out.json` 是**派生产物**（只指导 plan），perf 回归权威仍是 `perf_report.json`。profiler 不被状态机自动调用——是 agent 可选调用的工具 + 方法论提示。

**测试**（`test_profiler_skill.py`，+19）：idle GPU 选择（rocm/cuda/缺失/malformed/preferred）、rocprof 解析（求和/空/非数值列跳过）、driver 脚本、profile_kernel（成功写JSON+返回计数 / 失败返回None+记gap / 空输出 / 自动选设备）、main（rc 0/1）、skill 文本含工具+FM-3+方法论、perf_plan_prompt 注入/省略。

---

## 6. SSOT 与 advisory 约束总览

| 数据 | 权威源 | 派生/历史快照 |
|---|---|---|
| perf 数字 / 回归判定 | `perf_report.json` | `change_evaluation.json` / `analysis/*`（只展示/喂 agent） |
| #2 input-sensitivity 结果 | perf oracle 的 `correct` 布尔（写 `perf_report.json::results[].correct`） | — |
| #3 search_mode | 每轮 `_do_plan` 从 store 现算（不持久化） | `search_mode` timeline 事件（展示用） |
| #5 跨任务 lessons | 节点级 `lessons.jsonl` | per-task `analysis/lessons.jsonl`（快照，追加后不回读） |
| #6 profiler 计数器 | —（派生产物） | `profile_out.json`（只指导 plan） |
| correctness 测试分布 | 每轮 `_oracle_seed` 现算 | `correctness_report.json::oracle_seed`（审计可重放） |

**反模式规避**：
- 无双写：#3 的 plateau 计数每轮现算（不持久化计数器）；#5 的 task 快照只单向追加到 wiki。
- 无双向同步：#5 wiki 只被新任务读、只被 task 快照追加；无"wiki 改回写 task"。
- 冷重启安全：#3 从 store 读 IterationRecord.perf 重算；#5 从磁盘读 wiki；#2/#6 无状态。
- 历史快照标注：`analysis/lessons.jsonl` 明确"historical record, runtime reads from node-level lessons.jsonl"。

## 7. 测试

`server + orchestrator + opt_kernel` = **325 passed**（257 → 325，+68 新测试），零回归、零 warning。其中 2 个 graph-replay 测试在本机 HIP GPU 上真实执行（非 skip）。

| 测试文件 | 新增 |
|---|---|
| `test_correctness_oracle.py` | +8（含 #1+#4 + saturated 生产 K 回归） |
| `test_input_sensitivity.py`（新） | +9（#2，含 2 个 GPU graph-replay 分支） |
| `test_search_mode.py`（新） | +17（#3，含真 StateStore 集成） |
| `test_lessons_wiki.py`（新） | +16（#5，含 SSOT 不变量 + never-raises） |
| `test_profiler_skill.py`（新） | +19（#6） |

## 9. Code-review 回收与修正（post-review）

两路 code-reviewer 子 agent 并行审完。采纳的关键修正（全部已落地 + 测试绿）：

- **R2-CRITICAL（#3 plateau 探测生产环墙）**：`_count_iters_since_best` 原用 `getattr(rec, "perf")`，但 `StateStore.load_iteration` 返回的是**裸 dict**（shell 不再 ship IterationRecord dataclass）→ 每条记录都被跳过 → 返回 `last` → `search_mode=rewrite` 在每个 ≥2 轮都触发，即使指标在单调改进——**与 flame-chase 本意相反**。修正：改 `rec.get("perf")`，无可用信号时返回 `0`（→ fine_tune）。原测试因 `_FakeStore` 返了带 `.perf` 属性的对象而绿——**测试验的是 mock 不是真 contract**。补：`_FakeStore` 改返 dict + 新增真 `StateStore` 集成测试（写真实 `iterations/NNN.json`，断言 plateau/单调两种序列）。
- **R1-#2（saturated 生产 K 假阳性）**：±127-only 输入方差 ≈3× uniform，即使用 uniform 档 scale，K=4096 下输出 max 仍 ~170-572（rtol 主导）→ 忠实但非位一致（bf16 累加）内核可能被误拒。修正：saturated scale 缩 ~10×（`*0.001+0.0001`，mean 0.0006）→ 生产 K 输出 max ~1.7（atol 主导），仍保留 ±127 极端输入压力。补生产 K 回归测试断言 max<50。
- **R2-#3（read_wiki_lessons “never raises” 名不符实）**：`node_metainfer_dir` 在布局错误时抛 `ValueError`，`read_wiki_lessons` 未拦 → 非标布局会让 A phase 崩。修正：`read_wiki_lessons` 内 catch `ValueError` 返回 `[]`（读路径 never-raise；写路径仍 fail-loud）。补 plan-path never-raises 测试。
- **R2-#4（SSOT 不变量无测试）**：补 `test_plan_reads_wiki_never_the_per_task_snapshot`——在 plan 路径放一个只存于 per-task 快照的 marker + 一个只存于 wiki 的 marker，断言 prompt 含 wiki marker、不含快照 marker（钉住“快照不被回读”这一 SSOT 不变量）。
- **R1-#1（#2 只在 gate-absent 路径）经核实为伪问题**：全仓**没有任何代码写 `gate_result.json`**，真实任务目录里也没有该文件 → `_load_gate` 恒返回 None → `_benchmark_gemm`（#2 路径）**就是生产路径**。perf.py 里关于“C-phase gate 是 timing 权威”的注释是历史遗留描述，与现状不符（属既有差异，非本批引入）。
- **小项**：`_oracle_seed` 文档分隔符 `:`→`|` 对齐代码；fcntl 锁文件开模式 `w`→`a`。

未采纳/范围外：tolerance 常量三处重复（`atol=1.0/rtol=1e-2` 在 correctness.py/perf.py 各一份）——reviewer 建议导出共享；保留现状（perf oracle 硬编码是其 contract 一部分，本批不扩散改动面，注释已标可审计）。#2 进阶（content-keyed cache 不被 graph-replay 抓）仍属范围外。

## 8. 范围外（后续）

- **#2 进阶**：content-keyed cache（而非 identity-keyed）目前不被 graph-replay 探针抓——但 content-keyed 在输入变化时必须重算，无法加速计时，现实威胁低。可在 graph-replay 探针里加"内容哈希变化"校验，低优先。
- **#5 进阶**：lessons 去重/衰减（同一 failure_mode 跨多任务重复出现时合并权重）；wiki 增长无界时的滚动窗口。
- **#6 进阶**：torch.profiler 真回退实现（当前 rocprof 失败时记 gap，agent 回退 iter#14 方法论）；rocprofv2 之外支持 `omniperf`。
- **P3 harness meta-evolution**（`docs/opt_kernel_ahe.md` §8 backlog）：让闭环除 kernel 外也调 planner/reviewer prompt、oracle 阈值。仍是范式扩展，待 #3/#5 稳定后评估。
