# harness_evolve（v0）— AHE 外层循环（headless）

把 dcu_kernel_auto_opt 任务实例当评测单元跑 AHE evaluate→analyze→evolve 的
"第一版可用"实现。设计依据：

- **协议（固定，先读这个）：[`FLOW.md`](FLOW.md)** —— 每轮题数、取题规则、两门判据、
  HE 与 DKAO 的边界；代码必须与它一致（`tests/test_flow_contract.py` 守着）
- `MetaInfer/docs/dkao_harness_eval_protocol.md`（评测协议 v2）
- `MetaInfer/docs/ahe_dkao_integration_plan.md`（接入架构）
- 官方参考：`/root/zth_agent/ahe-ref`（MIT）

## 变体轮次协议（固定，规范文本见 [`FLOW.md`](FLOW.md)）

**协议以 [`FLOW.md`](FLOW.md) 为准**：每轮题数固定为 4 的倍数（4 张 HCU 一波铺满）、
第 1 轮随机抽 A1 并**固化为泛化考卷**、性能门 75% + 80% 地板、泛化门（仅性能门通过后开）
50% + 80% 地板、过关后等人工批准；**HE 只发起 DKAO 任务，不管理环境**。
本节只留实现要点；与 `FLOW.md` 不一致时以 `FLOW.md` + 契约测试为准。

**停止 / 续跑怎么操作**（按钮做了什么、为什么"裸杀进程"会被自动复活、哪些做法不可逆）：
见 [`FLOW.md`](FLOW.md) §9「停止与续跑（operator 操作说明）」。一句话：**页面的「停止任务」= 暂停**，
产物保留、不会被自动拉起，之后用「续跑到该轮次上限」接着跑；**直接 kill 进程或 shell 的 Kill 按钮
都不等于暂停**。

语义（先统一）：

- **baseline**：每个算子固定的 Triton 基线（`baseline_us`），永不变。
- **variant**：每个算子**当前的最优解**（成绩 + 内核），是候选必须打败的对手；
  **只在人工批准接入某一版 harness 时更新**（`variant_table.json`）。
- **harness**：搜索策略（planner/gates）。它只影响 DKAO 怎么找内核，不参与测量。


**阶段（stage）**：一次通过循环叫一个 stage，`runs/iteration_NNN/input/stage.json` 记录它是哪一个：

| stage | 轮次编号 | 做什么 | 判哪门 | 预算 |
|---|---|---|---|---|
| **baseline** | iteration 1 | 随机抽 4 题（= `A1`），交给 DKAO 实测；这 4 题**固化为泛化考卷** | **都不判** | 0 |
| **performance** | iteration 2 起 | 重新随机抽 4 题（`A2`，排除考卷），交给 DKAO 实测 | **只判性能门** | 1.0 |
| **generalization** | 与上手**同一编号** | 过关后**再用同一版 harness 发动一次 DKAO**，题目固定为 `A1` | **只判泛化门** | 0.5 |

- **第 1 轮是基线轮**：它不判任何门、不产生 `pending_promotion.json`，但**它测出来的更快 kernel
  直接写入 variant 池**（`promote_kernels_for_round`，阈值与生产一致：`promote_min_improvement_percent`，
  默认 3%；写池前自动备份池文件并追加 history）。这是"kernel 结果是事实，harness 才需要人批准"的分离。
  第 1 轮若**没能对每个算子都拿到可用测量**（子任务崩溃 / DKAO 自己的 GPU 门拒测 / 无 report）
  → 整个 HE 任务**立即停止**（`final_status=baseline_round_failed`），不留半截证据。
- **性能门**：随机抽的那 4 题**必须真正快于**各自 variant（严格优于，含 2% 噪声带）——≥75% WIN
  （4 题即至少 3 题），且没赢的不得低于 variant 的 80%。平局**不算赢**。
- **泛化门**：重考考卷那 4 题，≥50% WIN，同样 80% 地板。**平局不算输**：DKAO 子任务是
  `warm_start: best_known` 起跑，考卷上的算子正是基线轮刚写进池的 kernel，重考大概率复现同一个
  kernel（实测 delta = 0.0%）；把它判成失败等于要求"搜索策略每轮都比自己上一轮更快"。
  所以泛化门要求的是**无败场 + 真的退步就否决**（任一算子低于 variant 的 80% → 不过）。
- **过关后**：写 `pending_promotion.json`，任务停在 `awaiting_approval`，**等你人工批准**才把 harness
  接进生产 DKAO。任何一门不过 → 回退到"当前已发布/上一好 harness"、analyze→evolve、进入下一轮
  重新抽题（上限 `max_rounds`，默认 10；泛化轮算 0.5 轮，所以一个"过关再重考"的完整循环消耗 1.5 轮）。
- **harness 与 DKAO 的边界**：HE 不执行任何评测本身，它只对每个算子**起一个 DKAO 子任务**
  （`dcu_kernel_auto_opt.orchestrator.cli run`），把当前 harness 快照（`METAINFER_HARNESS_ROOT`）和
  本轮算子清单交过去；测量、GPU 门、contamination 全在 DKAO 内。泛化轮就是**再发一次**这样的任务，
  只是题目固定为考卷 —— 代码上只是再调一次 `evaluator.evaluate()`，DKAO 一行不用改。
  每一个"评估尝试"都有独立的子任务目录（`children/iteration_NNN`、重试 `..._a2`、重考 `..._generalization`），
  保证重考是"重新发动一次 DKAO"、重试也是新的一次 DKAO，而不是接着上一批继续跑。
  这一点是必须的：DKAO 会把子任务工作区的 `main` 符号链接绑死到它本次要用的 kernel repo，
  复用同一个目录会让重试**秒退**（`workspace main already points to ...`），
  于是环境一抖就烧完整个重试预算、看起来像永久失败。重试目录独立后，
  失败那次尝试的日志与状态也原样留在旁边作为证据。

**环境（卡）不是 HE 的事**：卡被占用、闸门怎么等、污染测量怎么作废，全部由 DKAO 的子进程
自己处理（`ensure_measurement_gate` / contamination），判据文本见 `FLOW.md` §0 与 §5。
HE 过去在父层做过的三件事都已移除：复查卡状态、`SIGSTOP` 冻结子任务、
按空闲卡数缩小题数（`fit_questions_to_devices`）——冻结并不会把卡让给别人，
缩题数只会让一轮考不出结论。

**机制门**（宽松）：每轮对上一轮 `change_manifest` 声明的机制做 grading，结果写进
`decision.json.mechanism_gate` 与时间线（`mechanism_gate` 事件）；它**不否决**已通过两门的候选，
但"晋升了却说不清为什么"会留痕。第 1 轮（baseline）没有门可 grade，其 `mechanism_gate` 为空。

**批准后的动作**：
- `approve`：把候选 harness 发布进 DKAO（备份上一版 + `promoted_harness.json`）、
  用**被接受那一轮**（写泛化门的那次重考）的成绩更新 variant、把该轮算子的内核写入生产池
  （逐算子"最好者胜"：低于池内 `best_known_us` 才写入，先备份池文件），任务结束
  （`final_status=promoted:<版本>`）。**只有被接受那一轮的优化进入生产，其余轮次丢弃。**
- `deny`：丢弃候选，恢复迭代。
- `rollback-harness --to last-good|h-N|seed`：把生产版本回退。

命令行：

```bash
python -m metainfer.tasks.harness_evolve.orchestrator.cli pending  --state-dir <s> --workspace-dir <w>
python -m metainfer.tasks.harness_evolve.orchestrator.cli approve  --state-dir <s> --workspace-dir <w> [--by NAME]
python -m metainfer.tasks.harness_evolve.orchestrator.cli deny     --state-dir <s> --workspace-dir <w> [--reason TEXT]
python -m metainfer.tasks.harness_evolve.orchestrator.cli rollback-harness --state-dir <s> --workspace-dir <w> --to last-good
```

WebUI：`GET /promotion` 看待批准候选与生产版本，`POST /promotion/approve|deny` 做决定。

产物：`variant_table.json`（逐算子 variant + 泛化考卷）、`variant_history.jsonl`（谁把哪个
算子刷成了多少）、`runs/iteration_NNN/input/stage.json`（这次是哪个 stage）、
`.../baseline_round.json`（第 1 轮：判定 + 入池结果）、`.../performance_gate.json`、
`.../generalization_gate.json`、`.../decision.json`、`pending_generalization.json`（冻结的重考请求）、
`pending_promotion.json`、`promoted_harness.json`、
`promotion_log.jsonl`；内核入库会更新池文件的 `best_known_us`/`history`，池文件备份在
`<exp>/promoted/<pool>.<时间戳>.yaml`。
DKAO 子任务目录：`children/<尝试目录>/<算子>`，其中尝试目录为 `iteration_NNN`（首次）、
`iteration_NNN_a2`（环境失败后的第 2 次尝试，最多 `env_retry_attempts` 次）、
`iteration_NNN_generalization`（泛化重考）；任何两个尝试都不共用目录。

回滚修复（本轮）：`workspace_revision` 现在记录**本轮自己的** commit（此前读的是上一轮
manifest 的字段，恒为空）；`champion_override.json` 缺失时不再抛异常。

## HE 不管理 GPU（2026-09-22 起，operator 规则）

**HE 只发起 DKAO 任务，卡的事归 DKAO。** 判据文本见 [`FLOW.md`](FLOW.md) §0。

- HE 不租卡、不读卡状态、不因为"卡忙"等待或否决、不冻结子进程。
- 卡干不干净由 **DKAO 子进程**在测量闸门里判（VRAM ≤ 90% 且 HCU == 0；30 分钟一次、
  最长 24 小时），写在子任务的 `state/measurement_gate.jsonl`——那是唯一存在闸门判定的地方。
- HE 侧只剩每轮的**设备布局**记录：`runs/iteration_NNN/input/benchmark/gpu_preflight.json`
  （哪道题绑了哪张卡、`index % 4`）。它是布局快照，不是占用检查。
- 子任务被 DKAO 闸门拒测（exit 75）→ HE **不重发**，本轮判 `round_incomplete`
  （cause `gpu_gate_blocked`，终态，等人工决定）；子任务崩溃 / 工具链缺失 → HE 重发一次
  （`env_retry_attempts`）。
- 逃生阀：`METAINFER_GPU_PREFLIGHT=0` 关的是 **DKAO 侧**的闸门。

## 运行（dry-run，离线可跑通闭环）

```bash
# 1) 写 requirements.json（answers 含 suite_yaml / max_iterations / execution_mode）
#    answers.execution_mode: dry-run（默认，确定性 fixture）| dkao-cli（需 worker29）
# 2) headless 运行（框架契约）
python3 -m metainfer.tasks.harness_evolve.orchestrator.cli run \
  requirements.json --state-dir <state_dir> --workspace-dir <workspace_dir>
```

## 目录布局（每轮双代际，同 ahe-ref 语义）

```
<workspace_dir>/                       # = AHE experiment root
├── workspace/                         # 可演化 harness（从 dcu harness_default 播种）
├── runs/iteration_NNN/
│   ├── input/workspace/               # 本轮评测快照
│   ├── input/benchmark/results.json
│   ├── input/diff.json                # vs 上轮（flipped/regressed）
│   ├── input/change_evaluation.json   # 上轮 change_manifest 的归因（verdicts）
│   ├── input/analysis/overview.md
│   └── evolve/change_manifest.json    # 本轮 Evolve 输出
├── best_ever.json                     # 超过则更新；低于则自动回滚 workspace
├── iteration_scores.jsonl
└── report.md
```

## Pool v2（考题协议 v2，2026-09-09）

- 新增 `orchestrator/pool.py`（注册池 + τ_family 自动判过 + 分层抽样/heldout）与
  `orchestrator/round_plan.py`（单角色出卷 + 三条护栏：池内 / 与上轮重叠 ≥60% / budget）。
- 表单新增 `pool_source`（`builtin` | 池 yaml 路径）与 `per_round_budget`；置空 = 旧 suite 模式（行为不变）。
- pool 模式下每轮 evaluate 只跑 round_plan 选中的题，`evolve/round_plan.json` 输出下轮考卷，
  决策（best_ever/回滚/归因）用重叠对口径；详见 `MetaInfer/docs/dkao_suite_protocol_v2.md`。

## 真实接入 v1（2026-09-09）

- `decision_engine.py`：BASELINE / PROMOTE / PROMOTE_UNEXPLAINED / CONFIRM_REQUIRED / NO_SIGNAL / SPECIALIZE / REJECT / REJECT_OVERFIT；性能门优先、机制门解释、held-out 可专用化。
- `DkaoCliEvaluator`：每题一个真实 DKAO 子任务，并发<=4，强制 `METAINFER_KERNEL_REPOS=/root/zth_agent/ahe-kernel-repos`；解析 final_report 与 child/repo/性能元数据。
- `AgentEvolver`：单角色 DSH Agent 同时修改 harness、写完整 change_manifest、出下一轮 round_plan；确认轮保持候选字节不变。
- 前端：每轮显示 system decision、child task/repo、median/p90、change attribution。

- 实测注册池构建：`python3 -m metainfer.tasks.harness_evolve.orchestrator.pool_builder`
  只读扫描历史 final_report → `/root/zth_agent/ahe-kernel-repos/registered_pool.yaml`（34 实例）。
- dkao-cli 模式拒绝 builtin 假池；必须使用实测池文件。
- planner 策略已数据化：`dcu_kernel_auto_opt/harness_default/planner_policy.yaml`（wired:true），
  AgentEvolver 改它即可改变下一轮状态→方案选择。

## 现状与边界（2026-09-22）

运行方式与判据：**协议见 [`FLOW.md`](FLOW.md)**（固定文本，契约测试 `tests/test_flow_contract.py` 守着）。

- ✅ **变体轮次协议是默认路径**：每轮 4 的倍数题、第 1 轮固化泛化考卷、性能门 75% + 泛化门 50%
  （各带 80% 地板）、过关后 `awaiting_approval` 等人工批准。实测状态：5 个 HE 任务里
  1 个（`test-9-17-1-07bb5cd8`）两门通过并写出 `pending_promotion.json`，**至今未被批准**；
  全库尚无 `promoted_harness.json` —— 循环还没真正闭合过一次。
- ✅ `dkao-cli` evaluator 是生产路径（不再是骨架）：每题一个真实 DKAO 子任务、并发 ≤4、
  `METAINFER_KERNEL_REPOS=/root/zth_agent/ahe-kernel-repos`、harness 快照经
  `METAINFER_HARNESS_ROOT` 传给子任务。
- ✅ `AgentEvolver` 已实现（`evolve_mode: agent`，DSH Agent 改 harness 并写 change_manifest /
  round_plan）；`evolve_mode: dry-run` 仍可用于离线闭环。
- ✅ **HE 不管理 GPU**：不租卡、不读卡、不冻结子进程、不按空闲卡缩题（细节见 `FLOW.md` §0 与
  下面「HE 不管理 GPU」节）。
- ✅ 门有三种结论 **PASS / FAIL / INCOMPLETE**：缺测且结果仍开放时不给 harness 判词（`FLOW.md` §3）。
- ⚠️ **测量噪声未标定**：门用 2% 噪声带、子任务用 `bench_profile=quick`，但"同一版 harness
  反复重测同一批题"的噪声基线还没有实测数据；判据基准（variant/pool 的 `best_known_us`）
  直接来自 DKAO 的测量，因此噪声会直接影响门的结论。
- ⚠️ **待批候选没有提醒机制**：`awaiting_approval` 是终态，不批就一直停着（上面那个候选已躺 5 天）。
- ⚠️ **旧路径（suite / legacy）保留但会自报家门**：它不判两门、不固化考卷，因此不可能产出可接入的
  harness；现在它会在日志里打 WARNING、在 timeline 写 `legacy_protocol_selected`、并在任务页面顶部
  显示黄色横幅（细节见 `FLOW.md` §8）。彻底删掉这条路径仍是**未决**：删掉会一起失去 suite 模式
  （离线 dry-run 闭环）与"Evolve Agent 出下一轮考卷"（`round_plan.json`，默认协议下这份 plan 目前
  只写不用）；在删除之前，这条告警就是防止它被误用的保障。
- ⚠️ `harness_source` 默认指向 dcu_kernel_auto_opt 的 `harness_default/` 种子；
  指向 AHE 演化出的 workspace（git 仓库）即可继续"harness 自动进化"。
- ⚠️ 历史文档 `docs/ahe_dkao_integration_plan.md` 等描述的是**父层管卡**的旧设计，已作废。
