# gfx928 手写 HIP Kernel 实战：v_mmac 矩阵核

> 本文档整理自真实生产项目：在 gfx928 (K100AI / CDNA3-class) 上手写 HIP kernel，
> 用 `v_mmac` 矩阵核指令加速 W4A16 MoE GEMM，比 sglang 自带 Triton W4A16 kernel
> 快最多约 3×（小 batch decode 阶段，主要在 GEMM2）。
>
> 来源：`benyuereal/quant-eagle3-hygon`（MIT License），`sglang_patches/hip_moe_w4a16/`。
> 该项目是 MiniMax-M3 在海光 DCU 上的 W8A8 / W4A16 量化 + EAGLE3 投机解码链路。

---

## 1. 什么时候需要手写 HIP（而不是 Triton）

Triton 在 gfx928 上能覆盖大部分场景，但以下情况手写 HIP 有优势：

1. **Triton 后端尚未支持的数据类型组合**（如 W4A16 MoE 的 int4 权重反量化 + GEMM 融合）
2. **需要精确控制寄存器布局**以命中 `v_mmac` 指令
3. **需要绕过 Triton 的 autotune 开销**，为固定 shape 写死最优配置
4. **MoE 场景下需要融合 router weight / activation / 量化**到单个 kernel

本项目案例：sglang 原生 Triton W4A16 kernel 在 decode 阶段（小 M）不够快，手写 HIP
kernel 用 `v_mmac` 快路径获得显著收益。大 M 自动回落原生 Triton，行为不变。

---

## 2. gfx928 的 v_mmac 指令

### 2.1 指令形态

gfx928（CDNA3-class，与 MI300 同代）支持 `v_mmac` 系列矩阵核指令。本项目用的是
fp16 输入 → fp32 累加的形态：

```c
// v_mmac_f32_16x16x16_f16: 16x16x16 的矩阵乘，fp16 输入，fp32 累加
// 语义: C[16x16] += A[16x16] @ B[16x16]  (K=16)
asm volatile("v_mmac_f32_16x16x16_f16 %0, %1, %2, %0"
    : "+v"(c) : "v"(a), "v"(b));
```

- `a` / `b` 是 `half4_t`（4 个 fp16 打包成一个 64-bit 寄存器）
- `c` 是 `float4_t`（4 个 fp32）
- `+v` 表示 `c` 同时是输入和输出（累加语义）

### 2.2 关键陷阱：B fragment 的寄存器布局

**这是本项目最核心的经验。**

`v_mmac` 期望 B 操作数在特定的向量寄存器布局里。如果你直接从标量构造 `half4_t`：

```c
// ❌ 错误：从标量构造 half4_t，寄存器布局不匹配 v_mmac 期望
half4_t b_frag;
b_frag[0] = __float2half(d0);
b_frag[1] = __float2half(d1);
b_frag[2] = __float2half(d2);
b_frag[3] = __float2half(d3);
acc = mmac_f16(a_frag, b_frag, acc);  // 数值错误或性能退化
```

编译器无法保证这个标量构造出来的 `half4_t` 落在 `v_mmac` 期望的寄存器通道上。

### 2.3 正确做法：scratch LDS roundtrip

```c
// ✅ 正确：反量化后写共享内存，再用 ds_read_b64 读回，强制正确寄存器布局
__shared__ __half smem_scratch[NUM_THREADS * 4];

// 反量化，写 4 个 fp16 到自己的 scratch slot
__half* my_scratch = &smem_scratch[tid * 4];
my_scratch[0] = __float2half(d0);
my_scratch[1] = __float2half(d1);
my_scratch[2] = __float2half(d2);
my_scratch[3] = __float2half(d3);

// 读回为 half4_t — ds_read_b64 指令正确地把数据放到 v_mmac 期望的寄存器
half4_t b_frag = *reinterpret_cast<const half4_t*>(my_scratch);

acc = mmac_f16(a_frag, b_frag, acc);
```

**原理**：`ds_read_b64`（64-bit LDS load）会把数据放到正确的向量寄存器通道，
而标量构造 + 寄存器分配不保证这一点。这个 scratch LDS roundtrip 看起来多余，
但它是让 `v_mmac` 正确工作的关键。

> 这个经验来自真实调试：早期版本用 packed uint8 B in LDS + on-the-fly dequant，
> 数值正确但性能不达标；改成 scratch LDS roundtrip 后才真正命中 `v_mmac` 快路径。

---

## 3. 完整 kernel 结构（W4A16 MoE GEMM）

### 3.1 tile 与 launch 配置

```c
constexpr int BM = 16;          // M 维 tile（decode 小 M）
constexpr int BN = 64;          // N 维 tile
constexpr int BK = 64;          // K 维 tile
constexpr int NUM_THREADS = 256;
constexpr int NUM_WARPS = NUM_THREADS / 64;  // gfx928 wavefront=64

// LDS 带 padding 避免 bank conflict
constexpr int LDS_A_STRIDE = BK + 4;       // 68 (避免 64 对齐导致 4-bank 冲突)
constexpr int LDS_B_STRIDE = BK / 2 + 8;   // 40 (int4 打包, multiple of 8)
```

### 3.2 grid 映射

```c
// MoE: 每个 block 处理一个 expert 的一个 (BM, BN) tile
const int num_n_blocks = (N + BN - 1) / BN;
const int block_id = blockIdx.x;
const int block_m_id = block_id / num_n_blocks;  // 决定 expert
const int block_n_id = block_id % num_n_blocks;
const int expert_id = expert_ids[block_m_id];
if (expert_id < 0) return;
```

### 3.3 wavefront 映射

```c
const int tid = threadIdx.x;
const int warp_id = tid / 64;      // wavefront=64, 不是 32!
const int lane_id = tid % 64;
const int warp_n_offset = warp_id * 16;  // 每个 wavefront 处理 16 列
```

### 3.4 K 循环 + v_mmac

```c
for (int ki = 0; ki < num_k_iters; ki++) {
    const int k_base = ki * BK;

    // --- Load A to LDS (BM × BK) ---
    // 每个 thread 加载 4 个 fp16，coalesced

    // --- Load B (packed uint8, 2 个 int4 per byte) to LDS ---

    __syncthreads();

    // --- Compute using v_mmac ---
    #pragma unroll
    for (int kk = 0; kk < BK; kk += 16) {  // v_mmac K=16
        // A fragment: 16x16, 每个 lane 取一行
        int a_row = lane_id % 16;
        int a_k_base = kk + (lane_id / 16) * 4;
        half4_t a_frag = *reinterpret_cast<const half4_t*>(
            &smem_A[a_row * LDS_A_STRIDE + a_k_base]);

        // B fragment: 反量化 + scratch LDS roundtrip (见 §2.3)
        int b_col = warp_n_offset + (lane_id % 16);
        int b_k = kk + (lane_id / 16) * 4;
        // ... 解包 int4, 乘 scale, 减 zp, 写 scratch, 读回 half4_t ...

        acc = mmac_f16(a_frag, b_frag, acc);  // 命中 v_mmac
    }
    __syncthreads();
}
```

### 3.5 输出写回

```c
// v_mmac 的 C fragment: lane_id 决定 (row, col_group)
int out_row_local = lane_id % 16;
int out_col_group = lane_id / 16;
int out_row_global = m_start + out_row_local;

if (out_row_global < EM) {
    int tok = sorted_token_ids[out_row_global];
    if (tok < num_valid_tokens) {
        float moe_w = mul_routed_weight ? topk_weights[tok] : 1.0f;
        #pragma unroll
        for (int i = 0; i < 4; i++) {
            int nc = n_start + warp_n_offset + out_col_group + i * 4;
            if (nc < N) {
                C[out_row_global * stride_cm + nc * stride_cn] =
                    __float2half(acc[i] * moe_w);
            }
        }
    }
}
```

---

## 4. 架构分叉：gfx928 vs gfx936

```c
__device__ __forceinline__ float4_t mmac_f16(half4_t a, half4_t b, float4_t c) {
#if __gfx928__
    asm volatile("v_mmac_f32_16x16x16_f16 %0, %1, %2, %0"
        : "+v"(c) : "v"(a), "v"(b));
#else
    // gfx936 (CDNA2/MI200) 等架构: v_mmac 不可用, 走标量 fallback
    // 能编译加载、结果正确, 但无加速 (基本等同不用本 kernel)
    // gfx936 真要加速需另写 mfma 版
    for (int i = 0; i < 4; i++) c[i] += (float)a[i] * (float)b[i];
#endif
    return c;
}
```

| 架构 | 路径 | 矩阵指令 | 说明 |
|------|------|---------|------|
| gfx928 (K100AI / CDNA3) | `v_mmac` 快路径 | `v_mmac_f32_16x16x16_f16` | 性能收益所在 |
| gfx936 (BW100 / CDNA2) | 标量 fallback | `mfma`（需另写） | 编译加载正确，但无加速 |

> **注意**：gfx928 在本项目文档里被标注为 "CDNA3/MI300" 同代。海光 K100AI 的
> `rocminfo` 报 gfx928，矩阵指令用 `v_mmac`（不是 `mfma`）。这与 notebooks/01 里
> "MFMA" 的描述需要核对——gfx928 可能同时支持 `mfma` 和 `v_mmac`，但 `v_mmac` 是
> 更新的矩阵核指令形态。agent 在写 kernel 前应先用 `rocminfo` / 编译器探测确认。

---

## 5. 编译与部署

### 5.1 编译命令

```bash
hipcc -O3 --offload-arch=gfx928 -std=c++17 -ffast-math \
      moe_w4a16_dcu.hip -o moe_w4a16_dcu.so -shared -fPIC \
      $(python3 -c "import torch; print(torch.utils.cpp_extension.include_paths()[0])")
```

或用 PyTorch 的 `cpp_extension.load` 现场编译：

```python
from torch.utils.cpp_extension import load
mod = load(
    name='hip_moe_w4a16_dcu',
    sources=['moe_w4a16_dcu.hip'],
    extra_cuda_cflags=['-O3', '--offload-arch=gfx928', '-std=c++17', '-ffast-math'],
    verbose=True, with_cuda=True,
)
```

### 5.2 fat binary（多架构）

预编译 `.so` 可以同时打包 gfx928 + gfx936：

```bash
hipcc -O3 --offload-arch=gfx928 --offload-arch=gfx936 -std=c++17 \
      -shared -fPIC moe_w4a16_dcu.hip -o hip_moe_w4a16_dcu.so
```

两架构都能直接加载，运行时按 `#if __gfx928__` 分叉。

### 5.3 monkey-patch 集成

本项目通过 monkey-patch 替换 sglang 的 `invoke_fused_moe_kernel`，在 decode 阶段
（小 M, token 数 ≤ 512）走手写 kernel，大 M 自动回落原生 Triton：

```python
# 受环境变量开关保护
if os.environ.get("SGLANG_USE_HIP_MOE_W4A16", "1") == "1":
    import hip_moe_w4a16_patch
```

---

## 6. 对 opt-kernel agent 的指导意义

当 opt-kernel 任务选择 "HIP" 作为 kernel_language 时：

1. **优先考虑 Triton**：Triton 的 `tl.dot` 在 gfx928 上能自动映射到矩阵指令，
   开发效率高。只有 Triton 不支持的 dtype/融合场景才手写 HIP。

2. **手写 HIP 时用 `v_mmac`**：gfx928 的矩阵核指令。参考本文档的 scratch LDS
   roundtrip 技巧——这是让 `v_mmac` 正确工作的关键，不是可选优化。

3. **架构分叉必须用 `#if __gfx928__`**：不要假设所有海光卡都支持 `v_mmac`。
   gfx936 等老架构需要 `mfma` 版本或标量 fallback。

4. **wavefront=64**：所有 wave 级代码（`__shfl_*`、reduction、lane 映射）用 64，
   不是 NVIDIA 的 32。

5. **LDS padding**：bank conflict 在 gfx928 上很敏感。A stride 用 `BK+4`、B stride
   用 `BK/2+8` 这种 padding 是实战经验，不是理论推导。

6. **MoE 场景的 grid 映射**：每个 block 处理一个 expert 的一个 tile，通过
   `expert_ids[block_m_id]` 索引。这与普通 GEMM 的 grid 映射不同。

7. **perf oracle 的接口契约**：opt-kernel 的 perf oracle 期望 `kernel.py` 暴露
   `w8a8_scaled_mm(x_q, weight, x_scale, weight_scale, out_dtype)`。如果你写的是
   HIP kernel，需要用 `torch.utils.cpp_extension.load` 加载并包装成 Python callable，
   或用 `torch.ops` 注册自定义 op。

---

## 7. 参考实现

完整源码（含 W4A16 反量化、scale/zp 处理、MoE router weight 融合）见：
`benyuereal/quant-eagle3-hygon` / `sglang_patches/hip_moe_w4a16/moe_w4a16_dcu.hip`

关键文件：
- `moe_w4a16_dcu.hip` — kernel 源码（~200 行，含详细注释）
- `hip_moe_w4a16_patch.py` — sglang monkey-patch
- `install_hip_moe_w4a16.sh` — 安装脚本
- `README.md` — 架构分叉、开关、编译说明
