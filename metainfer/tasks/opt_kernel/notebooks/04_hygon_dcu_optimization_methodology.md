# 海光 DCU 大模型推理算子优化方法论

> 本文档整理自真实生产项目（Qwen3.6-35B-A3B W8A8 × Hygon K100AI/gfx928 × vLLM，
> 200+ 轮实验）的可迁移经验。具体 tile / wave / split-K 参数只对该组合有效；
> 分析流程、验证方法和优化边界则可迁移到其他海光卡、其他国产 AI 加速卡和其他大模型。
>
> 来源：`DocPang/qwen36-k100ai-w8a8-optimization`（MIT License）。

---

## 1. 核心原则：优化真实 Shape，不优化抽象算子名称

大模型单并发 Decode 时，大量 GEMM 实际是**极小 M**（M=1/2/3/4），通用 GEMM heuristic
不一定为这种极端 skinny GEMM 调优。

### 1.1 真实 shape 采集流程

1. 用 profiler / trace 采集真实模型的 `(M, K, N, dtype, layout)` 分布；
2. 统计每种 shape 每 token 调用次数和累计耗时；
3. 对高频 shape 单独搜索最优配置；
4. 检查真实权重 stride / layout，**不能用错误的微基准布局**；
5. 把最优配置加入运行时精确 dispatch。

### 1.2 K100AI 上的真实收益案例

| Shape | 通用路径 | K100AI 专项配置 | 微基准提升 |
|---|---:|---:|---:|
| `M=1, 2048 -> 12288` | 371.99 μs | 90.03 μs | 4.13× |
| `M=1, 2048 -> 9216` | 221.75 μs | 77.53 μs | 2.86× |
| `M=2, 2048 -> 12288` | 371.34 μs | 90.47 μs | 4.10× |
| `M=2, 2048 -> 9216` | 215.13 μs | 76.98 μs | 2.79× |

补齐两个高频大投影后，无 MTP 端到端从 ~36 tok/s 跃升到 ~54 tok/s。

### 1.3 MTP / Speculative Decoding 改变真实 M

- MTP1 验证阶段常见 M=2
- MTP2 → M=3
- MTP3 → M=4
- MTP4 → M=5

**kernel 调优必须跟着 MTP 深度一起变化**。草稿头仍走 M=1，所以 M=1 路径不能丢。

---

## 2. Microbenchmark 只是筛选器，不是最终答案

本项目多次出现：**裸 kernel 看起来非常漂亮，但完整模型没有收益，甚至变慢。**

原因可能包括：
- custom-op 调用开销
- CUDAGraph 形状改变
- register / LDS 资源竞争
- 前后 kernel 无法很好重叠
- 额外量化 / 写回抵消了 GEMM 收益
- MTP 接受率发生变化
- 运行时 metadata 和 CPU 同步成为新瓶颈

### 2.1 三级质量门禁

| Gate | 内容 | 通过标准 |
|------|------|---------|
| **A: 算子正确性** | relative-L2、max abs diff、eager/compile 一致、CUDAGraph 可运行 | 数值在容差内 |
| **B: 固定完整模型 A/B** | 同卡、相同 prompt、相同输出长度、多轮热态、输出 hash/logprob 对照 | token 序列一致 |
| **C: 目标业务 A/B** | 长 System Prompt、Tool Calling、JSON、Prefix Cache 冷热、多模态、长时稳定 | 业务功能不退化 |

**只有通过 Gate C 的优化才有资格进入长期服务。**

### 2.2 典型失败案例

某次 QKVZ+BA 融合实验，微基准接近 1.8×，完整模型却没有对应收益，最终被淘汰。
某次候选端到端快 30%+，但 5 个固定 prompt 中 4 个出现贪心 token 分叉，即使回答仍连贯也未上线。

> "回答看起来正常"不能代替数值和任务级质量门禁。

---

## 3. 每次大优化后必须重新 Profile

性能优化会改变瓶颈排序：

| 阶段 | 第一热点 |
|------|---------|
| 早期 | Linear GEMM |
| Linear 优化后 | MoE 重新成为第一 |
| MoE 优化后 | dynamic INT8 quant、elementwise、runtime metadata |
| 再之后 | CPU/GPU 同步、`.item()`、event |

推荐循环：

```
Baseline → Profile → 优化最大热点 → A/B + Quality Gate → 重新 Profile → 再优化新热点
```

这是一个不断变化的 Pareto frontier。**不要拿旧 profile 指导新系统。**

---

## 4. MoE 优化：不要只盯两次 GEMM

一个 token 的 MoE 路径还包括：router、top-k、token/expert 排序与对齐、stage1 GEMM、
activation、动态量化、stage2 GEMM、router weight、reduce/sum、shared expert。

### 4.1 单 token MoE 专用路线

通用 FusedMoE 承担了为大 batch 设计的排序、padding 和通用分发成本。单 token、固定 top-k
场景可走专用路线：

1. router 直接得到固定数量的 expert id / weight；
2. 对命中专家直接分配工作，不走通用大 batch token sort；
3. stage1 epilogue 融合 activation；
4. activation 后直接量化供 stage2 使用；
5. stage2 直接乘 router weight；
6. 尾部直接 reduce；
7. 有条件时把 shared expert 一起累加。

### 4.2 MoE 中间量化融合

```
Gate/Up GEMM → SiLU * Up → dynamic INT8 quant → Down GEMM
```

如果同一个 hidden 同时送往多个投影，应优先**量化一次，多路 Linear 共享 xq/xscale**。

---

## 5. 量化优化的重点不只是"换成 INT8"

W8A8 模型中，真正的成本包括：权重读取、activation 动态量化、scale 计算、中间结果写回、
相邻算子再次读取。

### 5.1 典型融合边界

```
RMSNorm/residual → dynamic per-token INT8 quant → Linear
Gate/Up GEMM → SiLU * Up → dynamic INT8 quant → Down GEMM
```

### 5.2 静态权重预重排

推理时大多数权重是静态的，可在模型加载时一次性完成：preshuffle、tile-friendly layout、
scale 重排、合并连续投影、针对矩阵指令的内存布局。

**但必须同时看显存成本**：本项目尝试过连续预打包 QKVZ+BA，局部更快，却因额外权重/AOT
保留显著降低 KV 容量，最终没有采用。

> 正确目标不是"kernel 最快"，而是"在服务需要的上下文和并发约束下，端到端最快"。

---

## 6. Runtime 同步可能和 GEMM 一样值得优化

主要 GEMM 提速后，CPU/GPU 之间的小同步会变得非常显眼。

本项目在混合 GDN + Prefix Cache + speculative decoding 路径中发现：
- accepted-token metadata 已经在 GPU 上；
- 运行时仍然每个 decode step 发起 GPU→CPU copy；
- record event；
- 后续再次依赖 CPU 镜像构造 metadata。

通过让常规快路径直接消费 GPU 上的 accepted-token 计数，删除不再使用的 D2H/event 和
重复 scratch 分配，固定 512 Decode 从 ~73 tok/s 提升到 ~80 tok/s。

> profiler 不能只盯大 kernel，也要看每 token 之间的空隙、event、memcpy、`.item()`、
> synchronize、Python/Numpy metadata 构造。低 batch Decode 下，几十微秒的小同步乘以
> 每 token 几十/几百次，会形成非常可观的总成本。

---

## 7. Speculative Decoding 寻找甜点位

第 n 个草稿 token 的接受率通常逐级下降。MTP 不是越深越快。

必须记录：每个 draft position 的接受率、每次 target forward 平均推进 token 数、
draft head 成本、verification 成本、完整 tok/s。

本项目当前 Agent 负载上 MTP3 是甜点位；MTP2 整体更慢，MTP4 明显退化。

---

## 8. Chunked Prefill 多目标调优

`max_num_batched_tokens` 这类参数会同时改变：compile range、graph 形状、kernel 选择、
MTP 数值路径和接受率、激活峰值与 KV 容量。

本项目典型结果：
- 4096：Decode 明显更快，KV 容量几乎不受影响，综合最佳；
- 8192：Decode 再快约 1%，但 55K 冷 Prefill 恶化到 100 秒以上，淘汰。

参数调优必须用多目标指标：Decode / Prefill / TTFT / KV 容量 / MTP acceptance / 功能正确性。

---

## 9. 哪些可借鉴，哪些必须重做

### 可以直接借鉴的方法

- 真实 shape 采集与高频 shape 排序
- skinny GEMM / split-K 思路
- static weight preshuffle
- 单 token MoE 专用路径
- Norm/Activation + Quant 融合
- CPU/GPU 同步审计
- MTP position acceptance 分析
- Prefix Cache 冷热 A/B
- 同卡端到端门禁
- 失败实验记录方式

### 必须按硬件重做的参数

- tile size（BLOCK_M / BLOCK_N / BLOCK_K）
- wave / warp 数量
- split-K
- fixed grid
- block-per-CU
- LDS / VGPR 预算
- preshuffle layout
- CUDAGraph 尺寸
- batch / prefill 甜点位

> 其他海光卡用户最正确的学习方式：**复制实验流程，再为自己的卡重新搜索参数。**

---

## 10. 推荐的标准优化流程

```
[1] 定义目标业务
        ↓
[2] 锁定模型/环境/测量口径
        ↓
[3] 建立稳定热态 baseline
        ↓
[4] Profile + Shape Inventory
        ↓
[5] 优化最大热点
        ↓
[6] 算子数值门禁
        ↓
[7] 同卡完整模型 A/B
        ↓
[8] 真实业务门禁
        ↓
[9] 重新 Profile
        ↓
[10] Runtime / Fusion / Cache / MTP 联合优化
        ↓
[11] 记录失败路线和适用边界
        ↓
[12] 固化可复现脚本与自动化 recipe
```

最重要的三个原则：
1. **优化真实 shape，不优化抽象算子名称；**
2. **完整模型和真实业务优先于微基准；**
3. **每次大优化以后重新 profile，不要拿旧瓶颈指导新系统。**

---

## 11. 对 opt-kernel agent 的指导意义

当你在 K100AI / gfx928 上优化一个算子时：

- **先确认真实 shape**：不要只优化"标准"的 M=4096 prefill，decode path（M=1/2/4/8/16/32）
  往往是更大头。perf oracle 已经覆盖了 decode + prefill 两路。
- **微基准通过 ≠ 上线**：perf oracle 的 speedup 是微基准级别。如果任务要求端到端收益，
  必须考虑 custom-op 调用开销、CUDAGraph 兼容性、前后 kernel 衔接。
- **质量门禁**：perf oracle 的 correctness check（atol=1.0）是 Gate A。如果优化改变了
  数值路径，必须验证不会导致上层模型 token 分叉。
- **重新 profile**：如果你的优化让某个 shape 从 300μs 降到 90μs，下一个瓶颈可能不再是
  GEMM，而是量化、launch overhead 或 runtime 同步。reviewer 应提示下一轮关注新热点。
- **参数不通用**：你在 K100AI 上找到的最优 tile，换到 gfx936 / MI300 / H100 上必须重新搜索。
  notebooks/01 里的"不要假设的 NVIDIA 特性"清单同样适用于不同海光卡之间。
