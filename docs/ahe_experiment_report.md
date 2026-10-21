# opt_kernel × AHE：可证伪预测与 Agent Debugger 闭环

> 真实实验：W8A8 GEMM 内核优化（gfx928 / K100_AI），16 轮迭代（已收敛）

## 一句话

给 GPU 内核优化 agent 加了两个 **advisory 闭环**——让 agent 对优化决策下**可证伪预测**，并让 **debugger agent 跨轮蒸馏经验**。在一个真实 W8A8 GEMM 任务上跑了 16 轮直到收敛：性能上 decode 重点 shape 改善 30–45%、相对官方 baseline 1.12–1.38×。更重要的是实验暴露了闭环的一个真实局限——**当 oracle 自身的 baseline 测量坏了，框架的自动判定会退化**，而 agent 通过自建独立测量权威补偿了这一缺口，debugger 则成为收敛判定的主力。

---

## 1. 背景

opt_kernel 是 ABCDEF 六阶段循环的内核优化 agent（规划→实现→正确性→评审→性能→性能规划）。两个痛点：

- **决策不可观测**：planner 每轮说"我改 X，预期涨 Y%"，但没人回头核对"真涨了吗？是因为 X 吗？"。改完就忘，下轮重复犯错。
- **经验不可累积**：每轮只看上一轮的失败，跨轮模式（"每次提议加 BK 都被 64 KB shared-mem 顶住"）从不被显式总结。

AHE（Agentic Harness Engineering）的核心正好对治这两点：让 agent 写可证伪预测 + 用 debugger 跨轮蒸馏经验。

---

## 2. 架构

两个闭环都叠在 opt_kernel 既有的 ABCDEF 主循环**之上**，**不改状态机、不改 oracle 回归判定**，失败只降级为 timeline 日志——所以叫 advisory（建议性，非阻塞）。

```
              opt_kernel ABCDEF 主循环（不变）
              A_plan → B → C → D → E_perf → F_perf_plan
                          │              │
   ┌──────────────────────┘              └───────────────────┐
   │  P2 可证伪预测                        P1 Agent Debugger   │
   │                                                         │
   │  A: planner 写 predictions.json    每轮 _close_iteration │
   │      (change/指标/预期Δ/原因)         末尾: debugger agent │
   │                                       读全轨迹 →          │
   │  E 后: evaluate_predictions            analysis/detail/    │
   │      → change_evaluation.json        iter_NNN.md          │
   │      (confirmed/falsified/         + 重写跨轮 overview.md │
   │       inconclusive + at-risk)                            │
   │                                       下一轮 A 读 overview │
   │  verdict ──┐                          摘要替代单步 failures │
   │            ↓                                              
   │  F + 下一轮 A 收到"上轮被证伪了什么"                       
   └─────────────────────────────────────────────────────────
```

**数据流**：planner（A）写 `predictions.json` → E 后 orchestrator 比对实测写 `change_evaluation.json` → verdict 回灌 F 和下一轮 A。每轮收尾 debugger 把轨迹折叠进 `analysis/detail/iter_NNN.md`，并**重写**跨轮 `analysis/overview.md`；下一轮 planner 读 overview 摘要。

**单一数据源约束**：性能数字和正式回归判定的权威源始终是 `perf_report.json`（oracle）。`predictions.json` / `change_evaluation.json` / `analysis/*` 都是 **derived 历史快照**，只用于展示和喂给 agent，绝不回写权威源、不驱动运行时状态。

**访问边界**：debugger 的 cwd = 工作区的 iterations 根目录（能读兄弟 iter、写 `analysis/`），但不碰 state_dir；轨迹数据由 orchestrator 以文本注入其 prompt，agent 无法直接读元数据。

---

## 3. 实验结果（真实测量）

任务：W8A8 int8 GEMM on gfx928（64 KB shared-mem/CU），重点优化 decode（M≤16）与 prefill（M=4096），baseline 为官方 `lmslim.matmul_int8`。16 轮后**收敛关闭**。

### 3.1 性能

| 指标 | iter#1 | iter#11（最优） | iter#15（收敛） | 改善 |
|---|---|---|---|---|
| Decode M=1 (µs) | 133 | 73 | 77 | −45% |
| Decode M=8 (µs) | 118 | 77 | 82 | −35% |
| Decode M=16 (µs) | 127 | — | 83 | −35% |
| Decode M=32 (µs) | 112 | — | 101 | −10% |
| Prefill M=4096 (µs) | 1861 | 1622 | 1622 | −13% |

相对官方 baseline：decode 重点 shape **1.12–1.38×**，TP=1 **1.34×**，prefill **38.14×**。iter#15 与 iter#11 **byte-identical**（纯验证轮），两张独立 dedicated-card 两次独立测量吻合（1.187× / 1.174×），debugger 据此宣布收敛：**"除非授权离开 Triton / 加 rocprof，否则无需再迭代"**。

### 3.2 预测判定统计（35 个预测）

| 判定 | 数量 |
|---|---|
| confirmed | 1 |
| falsified | 0 |
| **inconclusive** | **34** |

### 3.3 核心发现：oracle 坏了的时候，框架判定会退化——agent 靠自建测量权威补偿

这是 16 轮实验里**最关键、也最诚实**的发现。P2 框架的自动判定在这里**几乎全部 inconclusive（34/35）**，根因不是预测质量，而是 **oracle 自身的 baseline 测量坏了 15/15 轮**：测试在争抢中的默认 GPU 卡上跑，`lmslim` baseline OOM，导致 `speedup=0.0`，框架没有可比对基线，自然无法 confirm/falsify。

但证伪纪律**并没有消失**——它转移了：

- **agent 自建测量权威**：从 iter#14 起 `test.sh` 绑定一张专用空闲卡、直接 import 真实 `lmslim.matmul_int8`、用交错 A/B + 中位数-50 + ≥2% 抗噪发货闸门，把判据从坏掉的 oracle 迁到自建的 `test_out.json`。
- **A/B 证伪照样发生**：iter#14 两个 gated probe（P0 `BN=64→32` 回退、P1 `num_stages 1→2`）被 A/B 证伪（P0: 21/30 回退；P1: st2 全 6 shape 慢 12–14%）；iter#15 第三次复核仍 HOLD。
- **debugger 显式记录了这个 schema 缺口**："p2 的指标活在 `test_out.json`，不在 oracle schema 内"——即框架 verdict 的 inconclusive 是**构造性的**，不是真"不知道"。

**结论**：P2 闭环的价值**依赖 oracle 可测**；当 oracle 失能，自动判定退化，但 AHE 的另一半（P1 debugger + planner 的可证伪心智模型）仍能把证伪纪律维持下来，甚至驱动 agent 主动修复测量权威。两个闭环互补，而非冗余。

### 3.4 P1 Debugger：收敛判定的主力

15 次 overview 重写，逐步长出一套 **FM-1~FM-15 失败模式分类**和一条 **10 轮纪律记录**（#6 ship / #7 hold / #8 hold / #9 ship / #10 hold / #11 hold / #12 closure / #13 tie-HOLD / #14 double-falsification-HOLD / #15 verification-HOLD）。关键产物：

- **收敛检测**：两轮独立测量吻合 → 静态宣布"campaign closed"，避免无意义继续迭代。
- **失败模式传承**：如 FM-5"64 KB shared-mem 天花板"、FM-15"用户给的旧版 perf 数字不能直接当现状"被显式记录并跨轮复用，替代"每轮只记一步"的旧 `prev_failures`。
- **do-not-repeat 清单**：BN=64→32 已 shipped 不可回退、num_stages 不可乱调等，作为下一轮 planner 的硬约束。

---

## 4. 结论

两个 advisory 闭环以**不动状态机、不碰权威源**的低成本，换来了决策可观测性和经验累积。16 轮真实任务上，性能收敛（decode −35~45%、1.12–1.38× over baseline），并且实验诚实地暴露了闭环的边界：**P2 自动判定强依赖 oracle 可测**，oracle 失能时退化，但 P1 debugger + 可证伪心智模型能补偿，驱动 agent 自建测量权威并最终收敛。

下一步：① 提交本次改动；② 用更高迭代数验证"do-not-repeat 清单"是否真减重复犯错、debugger overview 是否跨更多轮持续收敛；③ 评估 P3（让闭环除 kernel 外也能调 prompt/oracle 阈值）。

> 实验数据均来自真实产物 `perf_report.json` / `change_evaluation.json` / `analysis/overview.md`，性能权威源为 `perf_report.json`。
