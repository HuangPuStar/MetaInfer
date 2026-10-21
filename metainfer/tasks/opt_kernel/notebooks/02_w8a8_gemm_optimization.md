# w8a8 GEMM 优化模式与调优指南

> 本文档针对 int8 weight × int8 activation scaled GEMM (w8a8) 在 gfx928 上的优化。
> 覆盖 decode path (M≤32) 和 prefill path (M=4096) 两个关键场景。

---

## 1. 问题定义

### 1.1 算子语义

```
C[M, N] = (A_int8[M, K] @ B_int8[K, N]) * scale_a[M, 1] * scale_b[1, N]
```

- **输入**：A (M, K) int8, B (K, N) int8, scale_a (M, 1) fp32, scale_b (N, 1) fp32
- **累加**：int32（int8 × int8 → int32 accumulator）
- **输出**：(M, N) bf16（或 fp16）
- **scale 融合**：在 epilogue 一次性乘 scale_a * scale_b.T

### 1.2 两个关键场景

| 场景 | M | 特点 | 优化目标 |
|------|---|------|---------|
| Decode | ≤32 (1,8,16,32) | grid 不足，延迟敏感 | 增加 SPLIT_K 并行度，减少 launch overhead |
| Prefill | 4096 | grid 充足，吞吐敏感 | 大 tile，高 occupancy，L2 复用 |

### 1.3 TP 场景

- TP=4: 每卡持有 B 的 N/4 列
- TP=8: 每卡持有 B 的 N/8 列
- **单卡 GEMM 的 N 维 = total_N / TP**
- 优化重点在单卡 GEMM 效率，跨卡通信不在本 kernel 范围

---

## 2. Triton kernel 实现模式

### 2.1 基础结构

```python
@triton.jit
def w8a8_gemm_kernel(
    a_ptr, as_ptr, b_ptr, bs_ptr, c_ptr,
    M, N, K,
    stride_am, stride_ak,
    stride_asm,
    stride_bk, stride_bn,
    stride_bsn,
    stride_cm, stride_cn,
    BLOCK_M: tl.constexpr, BLOCK_N: tl.constexpr, BLOCK_K: tl.constexpr,
    GROUP_M: tl.constexpr, SPLIT_K: tl.constexpr,
):
    # Grouped ordering for L2 reuse
    pid = tl.program_id(0)
    pid_k = tl.program_id(1)
    num_pid_m = tl.cdiv(M, BLOCK_M)
    num_pid_n = tl.cdiv(N, BLOCK_N)
    num_pid_in_group = GROUP_M * num_pid_n
    group_id = pid // num_pid_in_group
    first_pid_m = group_id * GROUP_M
    group_size_m = min(num_pid_m - first_pid_m, GROUP_M)
    pid_m = first_pid_m + (pid % group_size_m)
    pid_n = (pid % num_pid_in_group) // group_size_m

    # Pointers
    offs_m = pid_m * BLOCK_M + tl.arange(0, BLOCK_M)
    offs_n = pid_n * BLOCK_N + tl.arange(0, BLOCK_N)
    offs_k = pid_k * BLOCK_K + tl.arange(0, BLOCK_K)
    a_ptrs = a_ptr + (offs_m[:, None] * stride_am + offs_k[None, :] * stride_ak)
    b_ptrs = b_ptr + (offs_k[:, None] * stride_bk + offs_n[None, :] * stride_bn)

    # Scales
    a_scale = tl.load(as_ptr + offs_m * stride_asm, mask=offs_m < M, other=0.0)
    b_scale = tl.load(bs_ptr + offs_n * stride_bsn, mask=offs_n < N, other=0.0)

    # int8 × int8 → int32 accumulator
    acc = tl.zeros((BLOCK_M, BLOCK_N), dtype=tl.int32)
    for k in range(0, tl.cdiv(K, BLOCK_K * SPLIT_K)):
        a = tl.load(a_ptrs, mask=offs_k[None, :] < K - k * BLOCK_K * SPLIT_K, other=0)
        b = tl.load(b_ptrs, mask=offs_k[:, None] < K - k * BLOCK_K * SPLIT_K, other=0)
        acc += tl.dot(a, b)  # int8 MFMA on gfx928
        a_ptrs += BLOCK_K * SPLIT_K * stride_ak
        b_ptrs += BLOCK_K * SPLIT_K * stride_bk

    # Epilogue: scale fusion
    c = (acc.to(tl.float32) * a_scale[:, None] * b_scale[None, :]).to(c_ptr.dtype.element_ty)
    
    # Write back
    c_ptrs = c_ptr + offs_m[:, None] * stride_cm + offs_n[None, :] * stride_cn
    mask = (offs_m[:, None] < M) & (offs_n[None, :] < N)
    if SPLIT_K == 1:
        tl.store(c_ptrs, c, mask=mask)
    else:
        tl.atomic_add(c_ptrs, c, mask=mask)
```

### 2.2 Decode path 优化 (M ≤ 32)

**问题**：M 很小 → grid = cdiv(M, BLOCK_M) × cdiv(N, BLOCK_N) 很小 → GPU 利用率低

**解决方案**：
1. **SPLIT_K > 1**：沿 K 维拆分，增加 grid 数量
   - M=1, K=4096, BLOCK_K=256 → 16 个 K-tile，SPLIT_K=4 → 64 个 block
   - 用 `atomic_add` 合并结果（int32 atomic）
2. **小 BLOCK_M**：BLOCK_M=16 甚至 8（M=1 时大部分 lane 空闲，但 MFMA 需要 16×16）
3. **大 BLOCK_N**：BLOCK_N=128/256 增加 N 维并行度
4. **减少 launch overhead**：CUDA Graph 捕获

```python
# Decode 配置
configs_decode = {
    'BLOCK_M': 16, 'BLOCK_N': 128, 'BLOCK_K': 256,
    'GROUP_M': 4, 'SPLIT_K': 4, 'num_warps': 4, 'num_stages': 2
}
```

### 2.3 Prefill path 优化 (M = 4096)

**问题**：M 大 → grid 充足，但需要高计算密度和 L2 复用

**解决方案**：
1. **大 tile**：BLOCK_M=128/256, BLOCK_N=128/256 提高计算/访存比
2. **GROUP_M ordering**：沿 M 方向分组，提升 N 维 tile 的 L2 命中率
3. **SPLIT_K=1**：grid 已经足够，不需要 K 拆分
4. **num_stages > 0**：启用软件流水线，重叠访存和计算

```python
# Prefill 配置
configs_prefill = {
    'BLOCK_M': 128, 'BLOCK_N': 128, 'BLOCK_K': 128,
    'GROUP_M': 8, 'SPLIT_K': 1, 'num_warps': 8, 'num_stages': 3
}
```

### 2.4 自适应配置选择

```python
def get_config(M):
    if M <= 1:
        return {'BLOCK_M': 16, 'BLOCK_N': 64, 'BLOCK_K': 256,
                'GROUP_M': 4, 'SPLIT_K': 8, 'num_warps': 4, 'num_stages': 2}
    elif M <= 8:
        return {'BLOCK_M': 16, 'BLOCK_N': 128, 'BLOCK_K': 256,
                'GROUP_M': 4, 'SPLIT_K': 4, 'num_warps': 4, 'num_stages': 2}
    elif M <= 32:
        return {'BLOCK_M': 32, 'BLOCK_N': 128, 'BLOCK_K': 256,
                'GROUP_M': 4, 'SPLIT_K': 2, 'num_warps': 4, 'num_stages': 2}
    elif M <= 128:
        return {'BLOCK_M': 64, 'BLOCK_N': 128, 'BLOCK_K': 128,
                'GROUP_M': 4, 'SPLIT_K': 1, 'num_warps': 4, 'num_stages': 3}
    elif M <= 1024:
        return {'BLOCK_M': 128, 'BLOCK_N': 128, 'BLOCK_K': 128,
                'GROUP_M': 8, 'SPLIT_K': 1, 'num_warps': 8, 'num_stages': 3}
    else:  # prefill
        return {'BLOCK_M': 256, 'BLOCK_N': 128, 'BLOCK_K': 64,
                'GROUP_M': 8, 'SPLIT_K': 1, 'num_warps': 8, 'num_stages': 3}
```

---

## 3. CUDA Graph 兼容性

### 3.1 要求

- ✅ 静态 shape（不能有 `torch.empty` 在 kernel 内部）
- ✅ 输出 tensor 预分配
- ✅ Triton JIT kernel 天然兼容（编译后是静态的）
- ❌ 不能有 `torch.cuda.synchronize()` 在捕获区域内
- ❌ 不能有动态控制流依赖输入值

### 3.2 捕获模式

```python
def w8a8_scaled_mm(x_q, weight, x_scale, weight_scale, out_dtype=torch.bfloat16):
    M, K = x_q.shape
    _, N = weight.shape
    # 预分配输出
    c = torch.empty((M, N), device=x_q.device, dtype=out_dtype)
    
    config = get_config(M)
    grid = lambda META: (
        triton.cdiv(M, META['BLOCK_M']) * triton.cdiv(N, META['BLOCK_N']),
        META['SPLIT_K'],
    )
    
    if config['SPLIT_K'] != 1:
        c = torch.zeros((M, N), device=x_q.device, dtype=torch.float32)
    
    w8a8_gemm_kernel[grid](
        x_q, x_scale, weight, weight_scale, c,
        M, N, K,
        x_q.stride(0), x_q.stride(1),
        x_scale.stride(0),
        weight.stride(0), weight.stride(1),
        weight_scale.stride(0),
        c.stride(0), c.stride(1),
        **config,
    )
    
    if config['SPLIT_K'] != 1:
        c = c.to(out_dtype)
    return c
```

### 3.3 Graph 捕获 + 重放

```python
# 预热
for _ in range(10):
    out = w8a8_scaled_mm(x_q, weight, x_scale, weight_scale)
torch.cuda.synchronize()

# 捕获
graph = torch.cuda.CUDAGraph()
with torch.cuda.graph(graph):
    out = w8a8_scaled_mm(x_q, weight, x_scale, weight_scale)
torch.cuda.synchronize()

# 重放（零 launch overhead）
for _ in range(100):
    graph.replay()
torch.cuda.synchronize()
```

---

## 4. 性能分析方法

### 4.1 确认 MFMA 利用

```bash
# 检查 MFMA 指令数
rocprof -i counters.txt -- python bench.py
# counters.txt 包含: InstrVALU_MFMA
# 如果 InstrVALU_MFMA 很低，说明 tl.dot 没有映射到 MFMA
```

### 4.2 确认 occupancy

```bash
# 检查 wavefront 数量
rocprof -i counters.txt -- python bench.py
# WaveCount 反映实际启动的 wavefront 数
# 理论最大 = num_CU(128) × max_waves_per_CU
```

### 4.3 确认 L2 命中率

```bash
# L2CacheHit 高 = 数据复用好（GROUP_M ordering 生效）
# L2CacheHit 低 = 需要调整 tile 大小或 GROUP_M
```

### 4.4 确认内存带宽

```python
# 理论带宽利用率
bytes = M * K * 1 + K * N * 1 + M * N * 2  # int8 in, bf16 out
achieved_bw = bytes / kernel_time_us / 1e3  # GB/s
# K100_AI HBM 带宽约 ~XXX GB/s（查 rocminfo）
```

---

## 5. 常见陷阱

### 5.1 int8 累加器溢出

int32 累加器最大值 = 2^31 - 1 ≈ 2.1e9。
如果 K > 2^31 / 127^2 ≈ 134,000，int8×int8 累加会溢出。
对于 K=4096，最大累加值 = 4096 × 127 × 127 ≈ 66M，安全。

### 5.2 scale 精度

scale_a * scale_b 在 fp32 下计算，然后乘 int32 累加器。
不要在 int32 累加阶段就乘 scale（会丢失精度）。

### 5.3 权重布局

- B 矩阵 (K, N) 是 TN 布局（转置存储）
- Triton 的 `tl.dot(a, b)` 要求 a 是 row-major, b 是 col-major
- 确认 `weight.stride(0)` 和 `weight.stride(1)` 的方向

### 5.4 SPLIT_K 的 atomic_add

- SPLIT_K > 1 时用 `tl.atomic_add` 合并结果
- atomic_add 需要 fp32 输出（int32 atomic 不支持）
- 合并后再转 out_dtype

### 5.5 M=1 的退化情况

- M=1 时 BLOCK_M=16 有 15/16 的 lane 空闲
- 用 SPLIT_K 增加并行度
- 考虑是否可以 batch 多个 M=1 的请求
