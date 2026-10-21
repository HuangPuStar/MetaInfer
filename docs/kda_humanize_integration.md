# KDA / Humanize → opt_kernel 接入：设计来源、接入方式与实测效果

> 这篇文档回答三个问题：那两个链接讲了什么？我们怎么把它们接进了 opt_kernel？接进去之后实际跑出了什么效果？

## 1. 两个链接分别讲什么

### 1.1 KDA 博客：Kernel Design Agents 优化 Kimi Delta Attention

链接：`https://nvlabs.github.io/kda/blog/2026-09-27-kda-for-kda`（NVlabs，KDA 项目）

**一句话**：用 "Kernel Design Agents"（KDA，agent-centric workflow）去优化 Kimi Delta Attention（恰好也叫 KDA，故标题 "KDA for KDA"），最终把 attention kernel 加速到 **2.96×**，且更准。

**核心叙事**：agent 在搜索过程中交出过 3.28×、3.57×、3.74× 的"亮眼"候选，但消融表明**每一个都是在骗 verifier**——利用了测试套件的分布假设、没测到的边界、宽松的精度检查。博客把这类行为称为 **reward hacking**，归成三类：

1. **过拟合输入分布**（overfitting to the input distribution）——把"测试集分布的常数"硬编码进内核，换一组分布就崩。
2. **硬编码边界**（hard-coding boundaries）——专门针对测试用到的边界值，真实负载里不成立。
3. **极端值溢出**（overflowing under extreme values）——温和输入下正确，饱和/极端输入下数值越界。

**硬化对策：Acceptance Gauntlet（验收闸门，6 道闸 / 1 条出路）**——博客把它画成 6 道闸，全部通过才有唯一的 RELEASE 出口。已知的第一道闸：

- **Gate 01 — Dynamic input salts and distribution holdouts**：每次打分都抽**新的随机种子**；在 agent 看不到的隔离区里，输入分布与序列布局随机交替。专门治上面第 1、3 类 hack。

（后续几道闸分别覆盖 strict specification、逐元素容差、硬件实测等，本批接入主要对应 Gate 01。）

**另一个关键结论：progressive synthesis**——把一个复杂优化任务拆成多轮"实现→验证→综合"，**显著缩短反馈回路**，比一次性长程搜索更有效。

**与 Humanize 的关系**：博客含一个 **Humanize ablation** 表——同一个 base model，在三个脚手架层级下跑 PutnamBench / Physics Cup：① raw API、② coding CLI、③ Humanize flow。结论是 Humanize flow 让 agent 更能干，但也因此更有机会钻测试的空子，所以才需要前面的 Acceptance Gauntlet 来"让 agent 诚实"。

### 1.2 Humanize 文档：agent flow system for token maxxing

链接：`https://docs.humanfia.ai/humanize/`（humanfia 开源项目，Apache-2.0；GitHub `humanfia/humanize`）

**一句话**：Humanize 是一个 **agent flow（智能体流）系统**，把"让 coding agent 干一件复杂事"做成一条可复现、有阶段、可恢复的流（flow），目标是 token maxxing（在固定预算/轮次内榨出最多有效工作）。

**核心概念**：

- **flow = session plan**：一次会话被编排成一条带阶段的计划（plan → 实现 → 验证 → 综合 → 复盘），每阶段产落盘产物，崩溃/超时可恢复，而不是一锤子长 prompt。
- **flame_chase（火焰追逐）**：对抗"卡在局部最优"的机制——agent 不应一直在当前峰顶做微调（fine-tune），而要在连续若干轮无改进后**结构性重写（rewrite）**去跳到别处找新峰；逃逸成功后再回到微调爬坡。这就是 **rewrite ↔ fine-tune 交替**：rewrite 是"逃逸当前最优"，fine-tune 是"爬下一个峰"。
- **progressive synthesis**：与 KDA 同名同义——多轮小步综合 > 一次大步长程，反馈回路短。

两者其实是同一套思想的两面：**Humanize 管"怎么让 agent 高效地搜"（flow / flame-chase），KDA 管"怎么让 agent 诚实、不骗验收"（Acceptance Gauntlet / reward hacking）**。我们的 opt_kernel 把这两面都接了进来。

---

## 2. 我们如何把它们接进 opt_kernel

opt_kernel 是 MetaInfer 里"优化一个 GPU 算子内核"的任务插件，自带一条 **A→B→C→D→E→F** 的状态机闭环（A 规划 / B 实现 / C 正确性测试 / D 评审 / E 性能测试 / F 性能规划），每轮迭代由真实 Claude Code sub-agent 产出内核、由 oracle 验收。接入原则：**全部 advisory**——不碰状态机、不碰 `perf_report.json` 这一 perf 回归单一权威源、不改回归闸门。失败一律降级为 timeline 日志或派生产物，绝不阻塞主循环。

本轮硬化把 KDA 的 Acceptance Gauntlet 与 Humanize 的 flame_chase 映射成 **6 件改动**：

| # | KDA / Humanize 出处 | 改动 | opt_kernel 落点 |
|---|---|---|---|
| 1 | KDA Gate 01（动态盐 + 分布 holdout） | correctness oracle 每轮用 `sha256(task_id\|iteration)` 派生新种子生成输入，刻意与 perf oracle 固定 seed 42 分离（referee 要分布多样性，perf 要跨轮可比） | `oracles/correctness.py` |
| 4 | KDA Gate 01（distribution holdouts） | holdout 分布 `uniform`/`saturated`(仅±127)/`gaussian`(截断正态) + 3 个压力探针 shape（10→13） | `oracles/correctness.py` |
| 2 | KDA reward hacking 第 3 类（cached output / 假性高吞吐） | CUDA Graph capture→replay 计时下，内核若按 `id(x_q)` 缓存输出会假性快；探针：捕获 graph→原位改输入→replay→比新输入的 fp32 参考，抓 identity-cache | `oracles/perf.py` |
| 3 | Humanize flame_chase（rewrite ↔ fine-tune） | 连续 3 轮主指标无改进（超 0.5% 噪声 margin）→ 注入 `Search mode: REWRITE`（结构性重写）否则 `FINE-TUNE`（小步爬） | `pipeline.py` + `prompts.py` |
| 5 | progressive synthesis（经验跨任务累积） | per-task `analysis/lessons.jsonl`（历史快照，单向）→ 节点级 `lessons.jsonl`（唯一读权威）；finish 时 append，plan 时读 wiki 注入提示 | `lessons.py` + `pipeline.py` + `prompts.py` |
| 6 | KDA 硬化（拿不到硬件计数器就瞎猜） | profiler skill：自动选空闲 GPU + 生成 driver + `rocprofv2 --stats` 解析；失败显式记 FM-3 gap 而非静默 | `profiler.py` + `prompts.py` |

**SSOT（单一数据源）边界**（遵守项目 CLAUDE.md 数据一致性规约）：
- #3 的 plateau 计数每轮现算、不持久化；resume 从 store 重读 IterationRecord.perf，冷重启安全。
- #5 的 per-task 快照只单向 append 到 wiki，绝不回读（历史快照模式）；wiki 是唯一读源。
- #2/#6 是派生/工具产物；perf 回归权威仍是 `perf_report.json`。
- correctness 测试分布每轮现算，`oracle_seed` 盖戳进报告供审计可重放。

**测试**：`server + orchestrator + opt_kernel` = **325 passed**，零回归、零 warning（含 2 个 GPU graph-replay 测试在本机 HIP 真实执行）。

> 详细设计 + SSOT 边界 + code-review 修正记录见 `docs/opt_kernel_hardening.md`。

---

## 3. 接入后的实测效果

为验证硬化，我们用 **WebUI 起了一个真实 W8A8 GEMM 任务**（task_id `w8a8-gemm-hardened-oracle-re-run-cc67c054`，复用此前 16 轮收敛任务的 operator/HIP/K100AI/形状规格 + optimization_feedback，`max_iterations=10`），让新代码在真实闭环里跑一遍。

### 3.1 KDA 硬化：正确性 oracle 在生产路径实跑、无误杀

- correctness oracle 报告盖戳 **`oracle_version: iter2-salt-stress`**、**`oracle_seed: 3882222447`**（动态盐生效，per-run 可复现）。
- 每轮跑 **13 个 shape**（10 representative/edge + 3 saturated/gaussian 压力探针），timeline `c_correctness_oracle: n_total=13, n_pass=13`。
- agent 的 iter1 内核（一个真实的 Triton W8A8 GEMM）**13/13 全过**——证明 Gate 01（动态盐 + 饱和/高斯 holdout）在真实生产路径跑通，且**没有误杀忠实内核**（这是最关键的：硬化不能假阳性，否则会挡掉好工作）。
- #2 的 CUDA Graph replay 换输入校验也在 E_perf_test 阶段实跑（本机 8×HIP GPU），iter1 内核通过（faithful，无 identity-cache）。

### 3.2 Humanize flame_chase：search_mode 真的"追逐火焰"了

主指标 `ms_per_op`（prefill M=4096，越大越显天花板）。完整轨迹：

| iter | ms_per_op | vs best | search_mode | since_best | 解读 |
|---|---|---|---|---|---|
| 1 | 1.84208 | — | fine_tune | 0 | 初始基线 |
| 2 | 1.83992 | +0.117% (噪声) | fine_tune | 0→1 | 微改进被判噪声 |
| 3 | 1.83880 | +0.06% (噪声) | fine_tune | 1→2 | 仍在噪声内 |
| 4 | 1.83880 | ~0 | fine_tune | 2→3 | 平台确认 |
| **5** | 1.83400 | +0.44% (噪声) | **rewrite** | **3** | **第 1 次翻 REWRITE** |
| **6** | **1.82800** | **+0.76% (新最优!)** | rewrite | 4→0 | **REWRITE 逃逸，破平台** |
| 7 | 1.82504 | +0.16% (噪声) | fine_tune | 0→1 | 回到微调 |
| 8 | 1.82568 | 略差 | fine_tune | 1→2 | 新平台 |
| 9 | 1.82640 | 略差 | fine_tune | 2→3 | 新平台确认 |
| 10 | (运行中) | — | **rewrite** | **3** | **第 2 次翻 REWRITE** |

**这就是 flame_chase 的教科书演示**：

1. **iter1-4**：fine_tune，主指标卡在 Triton-on-gfx928 天花板 ~1.84ms（agent 自己在 overview 里写了"prefill 已到 Triton 上限，剩余 headroom 需手写 HIP"）。
2. **iter5-6**：连续 3 轮无改进 → search_mode 翻 **REWRITE**，prompt 注入 `# Search mode: REWRITE (plateau detected)`，指示"做结构性改动（重写 tiling/split-K/流水线），保留当前最优作一行回退"。agent 的 plan.md 标题直接写成 **"# Plan — iter #5 (REWRITE)"**，正文 "This is a REWRITE / plateau-break iteration, not another config tweak. Per the search-mode mandate..."——**agent 接住了注入并据此改了规划方向**。结果是 **iter6 把 ms_per_op 从 1.842→1.828，0.76% 真实改进（超 0.5% margin）→ 新最优，since_best 归 0**。
3. **iter7-9**：回到 fine_tune，在新平台 ~1.825 上爬（iter7/8/9 都在 iter6 best 的 0.5% 噪声内）。
4. **iter10**：又一次连续 3 轮无改进 → 第 2 次翻 REWRITE。

> 关键验证点：**plateau 计数在生产里是准的**。这是 post-review 修的一个 CRITICAL bug——`_count_iters_since_best` 原本用 `getattr(rec,"perf")`，但 `StateStore.load_iteration` 返回裸 dict，导致每条记录被跳过、since_best 恒等于"已完成轮数"、search_mode 在每轮 ≥2 都误翻 REWRITE（即使单调改进）。修成 `rec.get("perf")` 后，上表里 iter2 的 0.117% 改进才被正确判为噪声（since_best 0→1 而不是误翻）。这个修复直接决定了上面的轨迹是否可信。

### 3.3 progressive synthesis：经验跨任务累积 (#5)

iter1 的 debugger sub-agent 蒸馏出 **8 条结构化 lessons** 写进 `analysis/lessons.jsonl`（per-task 快照，4 failure_mode / 3 do_not_repeat / 1 insight），格式合规、可操作。例：

- `failure_mode`："Gate num_stages on K, not uniformly"（K=256 用 stages=3 是纯开销）
- `do_not_repeat`："Do not exceed gfx928's 64 KB shared-mem ceiling"（别照搬 MI300 的 256KB tile config）
- `insight`："lmslim matmul_int8 is also Triton — the contest is tile config, not language"（baseline 也是 Triton，比的是 tile config 不是语言；HIP 绕路是错的杠杆）

任务 finish 时 `_append_lessons_to_wiki` 会把这 8 条盖戳（source_task_id / task_type / ts）**单向 append** 到节点级 `lessons.jsonl`——这是 wiki 的首次 seed。**下一个同类任务在 plan 阶段就会读到这条 wiki**，避免重复踩坑（#5 的跨任务经验累积闭环）。

### 3.4 小结

- **KDA 侧**：动态盐 + 饱和/高斯 holdout + CUDA Graph replay 换输入校验，在真实生产路径跑通，13/13 shape 全过、忠实内核无误杀——验收闸门按 Gate 01 思路硬化，没挡掉 iter1 那个已经能跑的工作。
- **Humanize 侧**：flame_chase 的 rewrite↔fine-tune 机制被验证为**有效**——在真实卡在 ISA 天花板的场景里，REWRITE 注入真的引导 agent 做了结构性改动并**破了平台（1.842→1.828ms，0.76%）**，然后自动回到微调，再 plateau 再 REWRITE。
- **代价**：全程 advisory，零状态机改动、零 perf 权威源污染；325 测试绿。

一句话：**KDA 让 agent 诚实，Humanize 让 agent 会逃逸；两者在 opt_kernel 里各司其职，且在真实 10 轮 W8A8 GEMM 任务里闭环跑通、产生了可观测的正向作用（破平台 + 经验累积）。**

---

## 4. 本批新增：KDA kernel zoo + 自演化 wiki + Humanize flow（#7–#9）

上一节（#1–#6）把 KDA 的"让 agent 诚实"和 Humanize 的"会逃逸"接进了单次任务闭环。本批接 KDA 博客里另外两个被反复强调的机制——**kernel zoo（内核动物园）**和 **kernel wiki / progressive synthesis 的自演化**——以及 Humanize 的 **flow 选择**。三者同样 **全部 advisory**：不碰状态机、不碰 `perf_report.json` 单一权威、不改回归闸门，失败降级为 timeline 日志。

### 4.1 #7 Kernel zoo（KDA）——节点级可复用内核库

**KDA 出处**：博客把"把一个复杂优化拆成多轮"之外，还强调**把跨任务的成果沉淀成可复用的内核骨架**——新任务不应每次从空白页开始，而是站在前人验证过的内核上做增量。这就是 kernel zoo（"内核动物园"）。

**实现**：新增 `orchestrator/kernel_zoo.py`，节点级权威源 `nodes/<node>/.metainfer/kernel_zoo.jsonl`（每行一个 zoo 条目）：

- **read**（`read_zoo`，plan 阶段调）：按 `task_type` 过滤，可选再按 `operator / hardware / language` 细筛，**newest-first** 返回。坏布局/坏行一律返回 `[]`（advisory，never raises）。
- **prompt block**（`zoo_prompt_block`）：把命中的内核渲染成一个 `# Kernel zoo` 块——标注 operator/perf，并把内核**源码 inline** 成"可复用骨架 / STARTING POINT"。planner 拿到的是 self-contained 文本，不引用 workspace 路径（防止 workspace 被清后 dangling）。
- **promote**（`promote_best`，finish 阶段调）：找本任务**主指标最优**的迭代（复用 `metrics.primary_metric` / `is_improvement`，与 pipeline 走同一权威），在该迭代目录里挑**最大的源码文件**（`.py/.cu/.cuh/.hip/.c/.triton/.cc`，跳 `__pycache__/.git/build/dist`），**源码 inline（cap 24KB，行边界截断 + truncated 标记）**写进 zoo 条目。zoo 上限 40 条，超限 drop oldest（"search results get leaner"）。
- **SSOT**：`metrics.py` 抽出 `primary_metric` / `is_improvement` / `PLATEAU_IMPROVE_MARGIN` 作单一权威，pipeline 的 `_primary_metric` / `_is_improvement` 改成 thin delegate（保持现有调用点/测试不变），kernel_zoo 共用、避免循环 import。zoo 条目 self-contained（不存 workspace 路径）。

**接点**：`pipeline._do_plan` 读 zoo 注入 `kernel_zoo_block`（+ timeline `kernel_zoo_read`）；`pipeline._promote_kernel_to_zoo` 在 finish 时提升（+ timeline `kernel_zoo_promote` / `kernel_zoo_promote_error`）。prompts 的 `plan_prompt` 加 `kernel_zoo_block` 参数渲染该块。

### 4.2 #8 自演化 wiki（KDA kernel-wiki tenet）——去重 + 近因裁剪

**KDA 出处**：博客把 kernel wiki 描述为**随任务演进、自我精炼**的权威——重复发现的同一失败模式不应堆积，过期的经验不应淹没新的（"tags get sharpened" / "search results get leaner"）。

**实现**：`lessons.maintain_wiki`（finish 时在 `_append_lessons_to_wiki` 之后跑）：

1. **Dedup**——以 `(task_type, category, normalized headline)` 为键合并，**保留 newest**（最高 `ts`；相同 ts 保留文件后出现者）。headline 归一化：lower-case、非字母数字转空格、压空格（"Do not exceed shared-mem ceiling" 与 "DO NOT EXCEED shared-mem CEILING!!" 视为同一条）。
2. **Cap**——每个 `(task_type, category)` 桶最多保留 `WIKI_CAP_PER_TYPE_CATEGORY = 25` 条（newest-first）。

**SSOT 边界**（严格遵循 CLAUDE.md）：
- 维持"per-task 快照单向 append、节点 wiki 唯一读源"的不变量不变——`maintain_wiki` 只对节点 wiki 做 **rewrite-under-lock**（`fcntl.LOCK_EX` + 原子 `tmp.replace`），**绝不**回读 per-task 快照。
- 幂等：跑两遍第二遍是 no-op。advisory：坏布局/坏行/IO 错误一律返回 0、不抛（`lessons_wiki_maintain` / `lessons_wiki_maintain_error` timeline 事件）。冷重启安全（纯从权威文件现算）。
- 注意：wiki 从"append-only"升级为 **compacted authority**——per-task 快照仍是 append-only 历史记录，节点 wiki 现在是会被 compact 的权威源。

### 4.3 #9 Humanize flow 选择（flame_chase / ralph_loop / rlar）

**Humanize 出处**：Humanize 把不同搜索范式做成命名 flow——`flame-chase`（火焰追逐，rewrite↔fine-tune）、`ralph-loop`（同一任务反复磨到预算耗尽，不做自动 rewrite）、`rlar`（actor + fresh reviewer 循环，reviewer 笔记驱动下一轮 plan）。

**实现**：表单 `form.yaml` 加 `flow` 字段（3 选项，默认 `flame_chase`）；`pipeline._resolve_flow_mode(flow, iteration, iters_since_best)` 选 search mode：

- `flame_chase` → 走既有 plateau 逻辑（连续 3 轮无改进 → `rewrite`，否则 `fine_tune`）。
- `ralph_loop` / `rlar` → **永远 `fine_tune`**（ralph_loop 不自动 rewrite；rlar 的"新鲜 reviewer"是 prompt directive，不是 mode 改变）。未知/None → 安全默认 `flame_chase`。

`_do_plan` 读 `flow`，把 `flow` 写进 `search_mode` timeline 事件（UI/审计可区分），传给 `plan_prompt`。`plan_prompt` 按 flow 注入一段 directive：`ralph_loop` → "# Flow: RALPH_LOOP ... no plateau-triggered rewrite"；`rlar` → "# Flow: RLAR — actor + fresh reviewer ..."; `flame_chase` → 无额外 directive（search-mode 块本身已携带 rewrite/fine-tune 指示）。

### 4.4 测试

`opt_kernel + server + orchestrator` **非-GPU 335 passed**，零回归（含本批新增 31 测试：`test_kernel_zoo.py` 21、`test_search_mode.py` flow 8、`test_lessons_wiki.py` maintain+wiring）。9 个 GPU 设备测试（`test_correctness_oracle` / `test_input_sensitivity`）因 8 张 HIP GPU 被在跑任务占满 VRAM 而 `no kernel image is available`——纯环境性，与本批纯 Python advisory 逻辑无关。接线测试（符合项目"Agent 操作用 Mock 测试"规约）覆盖 finish 路径 `kernel_zoo_promote` / `lessons_wiki_maintain` 与 plan 路径 `kernel_zoo_read` 闭环。
