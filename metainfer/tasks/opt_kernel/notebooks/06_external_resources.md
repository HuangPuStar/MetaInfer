# 海光 DCU 外部资源索引

> 本文档索引海光 DCU（K100AI / K100 / BW100 / Z100L 等）相关的开源项目、官方仓库、
> 社区资料，供 opt-kernel agent 在规划阶段查阅。按"对算子优化的相关度"排序。

---

## 1. 官方仓库（HYGON-AI 组织）

海光官方在 GitHub 的 `HYGON-AI` 组织维护 DCU 适配的推理框架插件。这些是**下游适配
仓库**（fork 自上游社区版本，加 DCU 适配），不是算子库本身，但能反映 DCU 上的真实
kernel 路径和已知问题。

| 仓库 | 说明 | 对算子优化的价值 |
|------|------|----------------|
| [HYGON-AI/sglang-das](https://github.com/HYGON-AI/sglang-das) | sglang 的 DCU 适配 | `benchmark/kernels/fused_moe_triton/` 有 MoE kernel tuning 工具；`docs/internal/dcu-main-conflict-ledger.md` 记录 DCU 适配的冲突决策 |
| [HYGON-AI/vllm-plugin-das](https://github.com/HYGON-AI/vllm-plugin-das) | vLLM 的 DCU 插件 | W8A8 / FP8 / MoE 在 DCU 上的适配路径 |
| [HYGON-AI/inference-cookbook-das](https://github.com/HYGON-AI/inference-cookbook-das) | HCU 硬件部署 cookbook | 模型部署清单（K100_AI / BW1000 / BW1100），偏部署非算子 |
| [HYGON-AI/apex-das](https://github.com/HYGON-AI/apex-das) | PyTorch Apex 的 DAS/HCU 扩展 | 混合精度、分布式训练、HCU/HIP Kernel 融合 |
| [HYGON-AI/verl-das](https://github.com/HYGON-AI/verl-das) | verl 的 DCU 适配 | 训练框架适配 |

### 1.1 sglang-das 里值得看的目录

```
benchmark/kernels/fused_moe_triton/      # MoE kernel tuning 工具（TP/EP 模式）
  ├── tuning_fused_moe_triton.py         # 统一 tuning（支持 w8a8 dtype）
  ├── tuning_fused_moe_triton_sep.py      # 分离 kernel tuning（stage1/stage2 独立，TMA 支持）
  └── README.md
benchmark/kernels/quantization/bench_int8_quant.py   # INT8 量化基准
benchmark/kernels/decoding_attention_triton/         # decode attention
benchmark/kernels/sliding_window_attention_triton/   # SWA
benchmark/kernels/verify_splitkv_triton/             # split-KV
docs/internal/dcu-main-conflict-ledger.md  # DCU 适配冲突决策记录
```

### 1.2 conflict ledger 的价值

`dcu-main-conflict-ledger.md` 记录了 DCU 适配与上游 sglang 的冲突点，策略包括：
`ours`（保留 DCU 实现）、`theirs`（取上游）、`manual merge`、`drop DCU patch`、
`port to new API`。这能帮助理解哪些 kernel 路径在 DCU 上有特殊处理。

---

## 2. 算子优化实战项目

### 2.1 DocPang/qwen36-k100ai-w8a8-optimization ⭐ 最相关

> Qwen3.6-35B-A3B W8A8 在 Hygon K100AI / gfx928 上的单卡低并发 Decode 性能优化，
> 200+ 轮实验。**本项目 notebooks/04 的方法论即整理自此仓库。**

- 仓库：https://github.com/DocPang/qwen36-k100ai-w8a8-optimization
- License: MIT
- 核心价值：
  - 真实 shape 驱动的 skinny GEMM（M=1/2/3/4）专项配置
  - Microbenchmark vs End-to-end 的失败案例
  - 三级质量门禁（算子 / 模型 / 业务）
  - MoE 优化、量化融合、Runtime 同步审计
  - MTP 甜点位分析
- 关键文档：
  - `docs/面向国产AI加速卡的大模型推理专项优化方法.md` — 方法论（见 notebooks/04）
  - `docs/200+轮实验：研究路线、失败尝试与结论.md` — 实验记录
  - `docs/ADAPTIVE_MTP_SCHEDULING.md` — 自适应 MTP 调度
- 关键数据：单卡 W8A8 从 19.8 tok/s 优化到 88+ tok/s（短上下文峰值）

### 2.2 benyuereal/quant-eagle3-hygon ⭐ 最相关

> MiniMax-M3 在海光 DCU (gfx936 / gfx928) 上的 W8A8 / W4A16 量化 + sglang 适配 +
> EAGLE3 投机解码。**本项目 notebooks/05 的 v_mmac kernel 实战即整理自此仓库。**

- 仓库：https://github.com/benyuereal/quant-eagle3-hygon
- License: MIT
- 核心价值：
  - gfx928 手写 HIP kernel 用 `v_mmac` 矩阵核指令（W4A16 MoE decode 加速）
  - scratch LDS roundtrip 技巧（解决 B fragment 寄存器布局）
  - gfx928 vs gfx936 架构分叉（`v_mmac` vs 标量 fallback）
  - sglang monkey-patch 集成模式
- 关键文件：
  - `sglang_patches/hip_moe_w4a16/moe_w4a16_dcu.hip` — kernel 源码（见 notebooks/05）
  - `sglang_patches/hip_moe_w4a16/README.md` — 架构分叉、编译、部署说明
  - `docs/MiniMax-M3-量化工作记录.md` — W4A8 → W8A8 → W4A16 探索记录（26 章）

### 2.3 FlyAIBox/dcu-in-action

> 国产加速卡-海光 DCU 实战指南（大模型训练、微调、推理）。

- 仓库：https://github.com/FlyAIBox/dcu-in-action
- 核心价值：偏部署（vLLM / LLaMA Factory / Xinference），算子层面较少
- DCU 型号覆盖：BW100 / K100-AI / K100 / Z100L / Z100
- 工具链：DTK 25.04+ / ROCK 6.3.8+ / PyTorch 2.4+

### 2.4 其他算子相关项目

| 仓库 | 说明 |
|------|------|
| [XinyiLiu577086410/DCU-Winograd-Conv2d](https://github.com/XinyiLiu577086410/DCU-Winograd-Conv2d) | Winograd conv2d 在 DCU 上的实现 |
| [benyuereal/quant-eagle3-hygon](https://github.com/benyuereal/quant-eagle3-hygon) | （同 §2.2）|
| [lutianshu824/dcu-bench](https://github.com/lutianshu824/dcu-bench) | DCU LLM 推理 benchmark（Claude Code skill）|
| [lutianshu824/bitsandbytes-dcu](https://github.com/lutianshu824/bitsandbytes-dcu) | bitsandbytes 4-bit (NF4/FP4) for DCU gfx936 / DTK 26.04 |
| [lutianshu824/mxfp4-gfx936](https://github.com/lutianshu824/mxfp4-gfx936) | OCP MXFP4 software fallback for gfx936 |
| [DocPang/qwen36-k100ai-w8a8-optimization](https://github.com/DocPang/qwen36-k100ai-w8a8-optimization) | （同 §2.1）|

---

## 3. baseline 库：lmslim

opt-kernel 的 perf oracle 默认 baseline 是 `lmslim.layers.gemm.int8_utils.matmul_int8`
（Triton w8a8 baseline）。

```python
from lmslim.layers.gemm.int8_utils import matmul_int8
out = matmul_int8(x_q, x_scale, weight, weight_scale, out_dtype, config=None)
# config=None 时根据 M 自动选择 tile 配置
```

lmslim 是 Infer Team 维护的 DTK 适配版本（`0.3.1+das.opt4.dtk2604.torch290`），
其 baseline tile 配置（按 M 分桶）见 notebooks/02 §5.5。**优化方向**：
- decode (M≤32): baseline 用 SPLIT_K=1，可尝试 SPLIT_K=4 增加并行度
- prefill (M=4096): baseline 用 BLOCK_K=64，可尝试 BLOCK_K=128/256 减少 K 循环

---

## 4. DCU 型号与架构对照

| 型号 | 架构 | 矩阵指令 | wavefront | 工具链 | 说明 |
|------|------|---------|-----------|--------|------|
| K100_AI | gfx928 | `v_mmac` / `mfma` | 64 | DTK 25.10 / HIP 6.2 | CDNA3-class，与 MI300 同代 |
| K100 | gfx928 | 同上 | 64 | 同上 | K100_AI 的非 AI 版本变体 |
| BW100 | gfx936 | `mfma` | 64 | DTK 26.04 | CDNA2-class，与 MI200 同代 |
| BW1000 / BW1100 | (待确认) | (待确认) | 64 | DTK 26.04+ | 新型号 |
| Z100L / Z100 | (较早) | `mfma` | 64 | DTK 较早版本 | |

> **注意**：`v_mmac` 是 gfx928（CDNA3）的矩阵核指令；gfx936（CDNA2）用 `mfma`。
> 写 kernel 前必须用 `rocminfo` 确认目标架构，用 `#if __gfx928__` / `#if __gfx936__`
> 分叉。详见 notebooks/05 §4。

---

## 5. 工具链与检测命令

```bash
# 确认 GPU 型号和架构
rocm-smi --showproductname
hipconfig --full | grep -i arch
rocminfo | grep -i "Compute Unit\|Name\|gfx"

# 确认工具链
which hipcc && hipcc --version
which rocprof && rocprof --version
python3 -c "import torch; print(torch.__version__, torch.version.hip)"

# 确认 Triton
python3 -c "import triton; print('Triton', triton.__version__)"

# 确认 lmslim baseline
python3 -c "from lmslim.layers.gemm.int8_utils import matmul_int8; print('lmslim OK')"
```

DTK（DCU Toolkit）路径通常在 `/opt/dtk/`，rocprof 可能在 `/opt/dtk/bin/`。

---

## 6. 社区资料（微信公众号 / 博客）

`FlyAIBox/dcu-in-action` 整理的 DCU 文档系列（微信公众号文章）：

1. [国产"芯"力量：深度解析海光 DCU 加速卡](https://mp.weixin.qq.com/s/l8PO6bXYbV6-QaZKkdY2Iw)
2. [善事需利器：海光 DCU 常用工具深度解析](https://mp.weixin.qq.com/s/5_1F7BL0OGzWcybMreHhUQ)
3. [DCU/AMD 加速卡监控：从命令行到可视化面板](https://mp.weixin.qq.com/s/43bnv64T2R9QSyCEh_n1OQ)
4. [实战 LLaMA Factory：在国产 DCU 上高效微调 Llama 3 模型](https://mp.weixin.qq.com/s/C5hUzbXbKbfT6GNFak01gQ)
5. [实战 Xinference：打造高性能私有 AI 推理服务](https://mp.weixin.qq.com/s/pZXOadsvZHvqcNLK3JcUPQ)

> 这些资料偏部署和应用层，算子优化细节较少。算子层面的深度资料主要来自
> §2.1 和 §2.2 两个实战项目。

---

## 7. 对 opt-kernel agent 的使用建议

1. **规划阶段（A_plan）**：先读 notebooks/01-05，再查本文档 §2 的两个实战项目，
   确认目标算子 / 硬件 / baseline 的真实优化路径。

2. **实现阶段（B_implement）**：
   - W8A8 GEMM → 参考 notebooks/02（Triton）+ §2.1（真实 shape 配置）
   - 手写 HIP → 参考 notebooks/05（v_mmac + scratch LDS roundtrip）
   - MoE → 参考 §2.1（单 token 专用路线）+ §2.2（W4A16 MoE kernel）

3. **review 阶段（D_review）**：用 notebooks/04 的三级质量门禁和"microbenchmark ≠
   end-to-end"原则审查实现。

4. **perf 分析（E_perf_test）**：用 notebooks/03 的 rocprof 流程 + notebooks/04 的
   "重新 profile"原则定位新瓶颈。

5. **架构确认**：写 kernel 前必须 `rocminfo` 确认目标架构，`v_mmac`（gfx928）vs
   `mfma`（gfx936）的代码分叉不能搞错。
