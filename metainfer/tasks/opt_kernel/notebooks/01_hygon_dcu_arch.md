# 海光 DCU K100_AI (gfx928) 底层架构与 HIP/Triton 优化知识库

> 本知识库用于指导海光 Hygon K100_AI DCU 的 GPU kernel 优化。
> K100_AI 基于 gfx928 架构（CDNA2-class），使用 DTK（DCU Toolkit）工具链，
> 兼容 ROCm/HIP 生态。

---

## 1. 硬件规格

### 1.1 K100_AI 关键参数

| 参数 | 值 | 说明 |
|------|-----|------|
| 架构 | gfx928 | CDNA2-class，与 MI200 系列同代 |
| 计算单元 (CU) | 128 | 每个 CU 含 4 个 SIMD16 |
| Wavefront | 64 | **wavefront_size=64**（非 NVIDIA 的 32） |
| 矩阵指令 | MFMA | 支持 int8/fp16/bf16/fp32 MFMA |
| LDS / CU | 64 KB | Local Data Share（类似 shared memory） |
| 最大 workgroup | 1024 | 即 16 个 wavefront |
| 工具链 | DTK 25.10 / HIP 6.2 | hipcc + rocprof + rocm-smi |

### 1.2 系统拓扑检测

```bash
# 确认 GPU 数量和型号
rocm-smi --showproductname
# 确认架构
hipconfig --full | grep -i arch
# 确认 CU 数量
rocminfo | grep -i "Compute Unit"
```

### 1.3 多 GPU / TP 场景

K100_AI 系统通常有 8 张卡（8 × renderD128-135）。对于 TP=4/8 的 w8a8 GEMM：
- 每张卡持有 weight 的 1/N 列（N=TP size）
- per-rank 的 N 维度 = total_N / TP
- **优化重点**：单卡内的 GEMM 效率，而非跨卡通信

---

## 2. gfx928 指令集与矩阵指令

### 2.1 MFMA 指令

gfx928 支持 MFMA（Matrix Fused Multiply-Add）指令：

| 数据类型 | MFMA shape | 说明 |
|----------|-----------|------|
| int8 | 32×32×32 (C×K×B) | int8 输入 → int32 累加 |
| fp16 | 16×16×16 | |
| bf16 | 16×16×16 / 32×32×8 | |
| fp32 | 16×16×8 | |

**关键**：int8 MFMA 的累加器是 int32。Triton 的 `tl.dot(int8, int8)` 在 gfx928 上
会映射到 MFMA 指令，输出 int32 累加器。

### 2.2 Wavefront 语义

gfx928 的 wavefront_size=64（与 NVIDIA 的 warp=32 不同）：
- `__shfl_*` 操作的 width 参数默认是 wavefront 宽度（64）
- Triton 的 `num_warps` 参数实际映射到 wavefront 数量
- 一个 workgroup 最多 16 个 wavefront（1024 线程）

### 2.3 不要假设的 NVIDIA 特性

- ❌ `cp.async`（NVIDIA Ampere+ 的异步拷贝）— gfx928 用不同的异步拷贝机制
- ❌ TMA（Hopper Tensor Memory Accelerator）
- ❌ WGMMA（Hopper 指令）— gfx928 用 MFMA
- ❌ warp=32 语义 — gfx928 是 wavefront=64
- ❌ `__syncwarp()` 的 32 线程语义

---

## 3. Triton on gfx928

### 3.1 Triton 编译目标

```python
# Triton 自动检测 GPU arch，但可以显式指定
import triton
# gfx928 通常被自动检测
# 如果需要显式指定：
# os.environ["TRITON_OVERRIDE_ARCH"] = "gfx928"
```

### 3.2 tl.dot 的 int8 支持

```python
# Triton 的 tl.dot 支持 int8 → int32 累加
accumulator = tl.zeros((BLOCK_M, BLOCK_N), dtype=tl.int32)
for k in range(0, K, BLOCK_K):
    a = tl.load(a_ptrs)  # int8
    b = tl.load(b_ptrs)  # int8
    accumulator += tl.dot(a, b)  # int8 × int8 → int32
```

### 3.3 关键调优参数

| 参数 | 说明 | gfx928 典型值 |
|------|------|--------------|
| BLOCK_SIZE_M | M 维 tile | 16-256（decode 用小值，prefill 用大值）|
| BLOCK_SIZE_N | N 维 tile | 32-256 |
| BLOCK_SIZE_K | K 维 tile | 64-256（影响 K 循环次数）|
| num_warps | wavefront 数 | 4-8（影响 occupancy）|
| num_stages | 流水线级数 | 0-4（gfx928 支持软件流水线）|
| SPLIT_K | K 维拆分 | 1（默认）或 >1（当 M×N grid 太小时）|

### 3.4 decode vs prefill 的不同配置

**Decode path (M ≤ 32)**：
- M 很小，grid 不足 → 需要大 BLOCK_SIZE_N + SPLIT_K 来增加并行度
- 典型：`BLOCK_M=16, BLOCK_N=32, BLOCK_K=256, SPLIT_K=4, num_warps=4`
- 延迟敏感：减少 launch overhead

**Prefill path (M = 4096)**：
- M 大，grid 充足 → 用大 tile 提高计算密度
- 典型：`BLOCK_M=128, BLOCK_N=128, BLOCK_K=64, SPLIT_K=1, num_warps=8`
- 吞吐敏感：提高 occupancy 和 L2 复用

---

## 4. rocprof 性能分析

### 4.1 rocprof --stats（kernel 级统计）

```bash
rocprof --stats -o profile/stats -- python bench.py
# 输出: profile/results.stats.csv
# 列: kernel name, calls, total duration, average, percentage
```

### 4.2 rocprof --hip-trace（API trace）

```bash
rocprof --hip-trace -o profile/hip_trace -- python bench.py
# 输出: profile/results.json (Perfetto 格式)
# 可在 https://ui.perfetto.dev/ 打开
```

### 4.3 硬件计数器

```bash
# 列出可用计数器
rocprof --list-basic
rocprof --list-derived

# 捕获关键计数器
cat > profile/counters.txt << EOF
SQ_BUSY_CYCLES
GPUBusy
L2CacheHit
LDSBankConflicts
WaveCount
InstrVALU_MFMA
EOF

rocprof -i profile/counters.txt -o profile/counters -- python bench.py
# 输出: profile/results.csv
```

### 4.4 关键性能指标解读

| 计数器 | 含义 | 优化目标 |
|--------|------|---------|
| GPUBusy | GPU 占用率 | >80% 表示计算密集 |
| L2CacheHit | L2 缓存命中率 | 高命中率 = 数据复用好 |
| LDSBankConflicts | LDS bank 冲突 | 越低越好 |
| WaveCount | wavefront 数量 | 反映 occupancy |
| InstrVALU_MFMA | MFMA 指令数 | 反映矩阵计算量 |
| SQ_BUSY_CYCLES | SQ 繁忙周期 | 高 = 计算单元饱和 |

---

## 5. w8a8 GEMM 优化模式

### 5.1 算子语义

```
C[M, N] = (A_int8[M, K] × B_int8[K, N]) * scale_a[M, 1] * scale_b[1, N]
```

- A: int8 激活（per-token 量化，scale_a 是 per-row）
- B: int8 权重（per-channel 量化，scale_b 是 per-column）
- 累加器: int32 → 转 fp32 → 乘 scale → 转 bf16 输出

### 5.2 优化要点

1. **int8 MFMA 利用**：确保 `tl.dot(a, b)` 映射到 MFMA 而非标量乘加
2. **Scale 融合**：在 epilogue（K 循环结束后）一次性乘 scale，不要在循环内
3. **权重布局**：B 矩阵用 TN 布局（转置）利于 coalesced load
4. **L2 cache 复用**：用 grouped ordering（GROUP_SIZE_M）提升 N 维 tile的 L2 命中
5. **SPLIT_K**：当 M×N grid 不足时（decode path），用 SPLIT_K 增加 K 维并行度

### 5.3 CUDA Graph 兼容性

CUDA Graph（HIP Graph）要求：
- ✅ 静态 shape（不能有动态分配）
- ✅ 不能在 kernel 内做 host-side `malloc` / `cudaMalloc`
- ✅ 输出 tensor 预分配
- ✅ Triton kernel 天然兼容（JIT 编译后是静态的）

```python
# CUDA Graph 捕获模式
g = torch.cuda.CUDAGraph()
with torch.cuda.graph(g):
    out = kernel_fn(x_q, weight, x_scale, weight_scale)
# 重放
g.replay()
```

### 5.4 Python 调用接口

```python
# kernel.py — agent 必须暴露的接口
import torch

def w8a8_scaled_mm(
    x_q: torch.Tensor,        # (M, K) int8
    weight: torch.Tensor,      # (K, N) int8
    x_scale: torch.Tensor,     # (M, 1) fp32
    weight_scale: torch.Tensor,# (N, 1) fp32
    out_dtype: torch.dtype = torch.bfloat16,
) -> torch.Tensor:            # (M, N) out_dtype
    # 实现 w8a8 scaled matmul
    ...
```

### 5.5 Baseline (lmslim matmul_int8)

```python
from lmslim.layers.gemm.int8_utils import matmul_int8

# baseline 调用
out = matmul_int8(x_q, x_scale, weight, weight_scale, out_dtype, config=None)
# config=None 时根据 M 自动选择 tile 配置
```

Baseline 的 tile 配置（按 M 分桶）：
- M ≤ 32: `BLOCK_M=16, BLOCK_N=32, BLOCK_K=256, SPLIT_K=1, num_warps=4`
- M ≤ 64: `BLOCK_M=32, BLOCK_N=32, BLOCK_K=256, SPLIT_K=1, num_warps=4`
- M ≤ 128: `BLOCK_M=64, BLOCK_N=64, BLOCK_K=256, SPLIT_K=1, num_warps=4`
- M ≤ 1024: `BLOCK_M=128, BLOCK_N=128, BLOCK_K=256, SPLIT_K=1, num_warps=8`
- M > 1024: `BLOCK_M=256, BLOCK_N=256, BLOCK_K=64, SPLIT_K=1, num_warps=8`

**优化方向**：
- decode (M≤32): baseline 用 SPLIT_K=1，可以尝试 SPLIT_K=4 增加并行度
- prefill (M=4096): baseline 用 BLOCK_K=64，可以尝试 BLOCK_K=128/256 减少 K 循环
- scale 融合：baseline 已经在 epilogue 融合了 scale，确认没有额外开销

---

## 6. 参考实现

### 6.1 PyTorch reference (correctness)

```python
def reference_w8a8_scaled_mm(x_q, weight, x_scale, weight_scale, out_dtype=torch.bfloat16):
    x_f32 = x_q.to(torch.float32)
    w_f32 = weight.to(torch.float32)
    acc = torch.mm(x_f32, w_f32)  # (M, N) fp32
    out = acc * x_scale * weight_scale.squeeze(-1).unsqueeze(0)
    return out.to(out_dtype)
```

### 6.2 per-token 量化（kernel 外部完成）

```python
def per_token_quant_int8(x_bf16):
    x_absmax = x_bf16.abs().max(dim=-1, keepdim=True).values.float()
    x_scale = x_absmax / 127.0
    x_q = (x_bf16.float() / x_scale).round().clamp(-128, 127).to(torch.int8)
    return x_q, x_scale
```

**注意**：量化开销不计入 kernel 性能。kernel 接收已量化的 int8 输入。
