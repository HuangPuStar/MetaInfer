# rocprof 性能分析实战指南

> 本文档指导如何使用 rocprof 分析 GPU kernel 性能，解读输出，并据此优化。

---

## 1. rocprof 基础

### 1.1 三种分析模式

| 模式 | 命令 | 输出 | 用途 |
|------|------|------|------|
| `--stats` | `rocprof --stats -- cmd` | `results.stats.csv` | kernel 级统计（次数、时长）|
| `--hip-trace` | `rocprof --hip-trace -- cmd` | `results.json` | HIP API + kernel trace（Perfetto）|
| 计数器 | `rocprof -i counters.txt -- cmd` | `results.csv` | 硬件计数器（occupancy、cache hit）|

### 1.2 基本用法

```bash
# 1. Kernel 统计（最常用）
rocprof --stats -o profile/stats -- python bench.py
# 输出: profile/results.stats.csv

# 2. HIP trace（用于时间线分析）
rocprof --hip-trace -o profile/hip_trace -- python bench.py
# 输出: profile/results.json (Perfetto 格式)

# 3. 硬件计数器
echo "GPUBusy\nL2CacheHit\nWaveCount" > profile/counters.txt
rocprof -i profile/counters.txt -o profile/counters -- python bench.py
# 输出: profile/results.csv
```

---

## 2. 解读 results.stats.csv

### 2.1 列说明

| 列 | 含义 |
|----|------|
| Name | kernel 名称 |
| Calls | 调用次数 |
| TotalDuration(ns) | 总执行时间 |
| Average(ns) | 平均执行时间 |
| Percentage | 占总 GPU 时间的百分比 |

### 2.2 分析方法

```python
import csv
with open("profile/results.stats.csv") as f:
    for row in csv.DictReader(f):
        name = row.get("Name", row.get("KernelName", ""))
        calls = int(float(row.get("Calls", 0)))
        avg_ns = float(row.get("Average(ns)", 0))
        print(f"{name}: {calls} calls, {avg_ns/1000:.1f} µs avg")
```

**关键指标**：
- 找到耗时最长的 kernel（Percentage 最高的）
- 确认你的 w8a8_gemm_kernel 是否是瓶颈
- 对比 baseline (lmslim matmul_int8) 的 kernel 时间

---

## 3. 关键硬件计数器

### 3.1 计数器列表

```bash
# 列出所有基础计数器
rocprof --list-basic

# 列出所有派生计数器
rocprof --list-derived
```

### 3.2 GEMM 优化关键计数器

| 计数器 | 含义 | 优化目标 |
|--------|------|---------|
| `GPUBusy` | GPU 占用率 (%) | >80% = 计算密集 |
| `L2CacheHit` | L2 缓存命中率 (%) | 高 = 数据复用好 |
| `LDSBankConflicts` | LDS bank 冲突数 | 越低越好 |
| `WaveCount` | 启动的 wavefront 数 | 反映 occupancy |
| `InstrVALU_MFMA` | MFMA 指令数 | 确认矩阵指令被使用 |
| `InstrSALU` | 标量 ALU 指令数 | 过高 = 地址计算开销 |
| `InstrVALU` | 向量 ALU 指令数 | |
| `SQ_BUSY_CYCLES` | SQ 繁忙周期 | 高 = 计算单元饱和 |
| `MemUnitBusy` | 内存单元繁忙 (%) | 高 = 内存瓶颈 |
| `MemUnitStalled` | 内存单元停顿 (%) | 高 = 内存延迟 |

### 3.3 计数器文件示例

```
# profile/counters.txt
GPUBusy
L2CacheHit
LDSBankConflicts
WaveCount
InstrVALU_MFMA
InstrSALU
SQ_BUSY_CYCLES
```

---

## 4. Perfetto trace 分析

### 4.1 打开 trace

```bash
# 生成 trace
rocprof --hip-trace -o profile/hip_trace -- python bench.py
# 输出: profile/results.json

# 在浏览器打开 https://ui.perfetto.dev/
# 拖入 results.json
```

### 4.2 分析内容

- **时间线**：每个 kernel 的执行时间段
- **HIP API 调用**：hipLaunchKernel, hipMemcpy 等
- **kernel 间隙**：host-device 同步开销
- **重叠度**：是否有 kernel 可以并行执行

### 4.3 关键观察

1. **kernel 执行时间**：与 `--stats` 的 Average 对比
2. **launch overhead**：kernel 之间的空隙（CUDA Graph 可消除）
3. **内存拷贝**：是否有不必要的 H2D/D2H（w8a8 不应该有）
4. **kernel 数量**：是否拆成了多个小 kernel（应该是一个 fused kernel）

---

## 5. 优化决策流程

### 5.1 判断瓶颈类型

```
GPUBusy > 80%?
├── Yes → 计算密集型
│   ├── InstrVALU_MFMA 占比高? → MFMA 利用好，优化 tile 大小
│   └── InstrVALU_MFMA 占比低? → tl.dot 没映射到 MFMA，检查 dtype
└── No → 内存密集型
    ├── L2CacheHit 高? → 带宽受限，增大 tile
    └── L2CacheHit 低? → 访存模式差，调整 GROUP_M / 布局
```

### 5.2 decode vs prefill 的不同优化

**Decode (M ≤ 32)**：
- WaveCount 低 → occupancy 不足
- 解决：SPLIT_K > 1 增加 grid 数量
- 验证：WaveCount 应该接近 num_CU × max_waves_per_CU

**Prefill (M = 4096)**：
- GPUBusy 应该 > 80%
- L2CacheHit 应该 > 50%（GROUP_M ordering 生效）
- 如果 MemUnitBusy 高 → 带宽受限，增大 BLOCK_K

### 5.3 对比 baseline

```bash
# 1. profile 你的 kernel
rocprof --stats -o profile/mine -- python bench_mine.py

# 2. profile baseline
rocprof --stats -o profile/baseline -- python bench_baseline.py

# 3. 对比 Average(ns)
# 你的 kernel Average < baseline Average = 优化成功
```

---

## 6. 常见问题

### 6.1 rocprof 找不到

```bash
which rocprof
# 如果没有，检查 DTK 安装
ls /opt/dtk/bin/rocprof
export PATH=/opt/dtk/bin:$PATH
```

### 6.2 计数器不支持

```bash
# 某些计数器在 gfx928 上可能不可用
# 先查询可用列表
rocprof --list-basic | grep -i "MFMA\|L2\|Wave"
```

### 6.3 trace 文件过大

`--hip-trace` 的 `results.json` 可能很大（几百 MB）。
- 只 trace 短时间运行（减少 bench 迭代数）
- 用 `--hip-trace --limit 100` 限制事件数（如果支持）

### 6.4 rocprof 影响 performance

rocprof 本身有 overhead。`--stats` 的 overhead 较小，
`--hip-trace` 和计数器捕获的 overhead 较大。
**不要用 rocprof 的绝对时间作为性能指标**——用 CUDA Graph 计时。
