# 04 · 内核质量类（这些是 DKAO 的日常工作，不是故障）

看到这里的报错**不要**去查机器、也不要怪沙箱：它们说的是"agent 这一版内核不行"。
管线本来就靠重试/回退处理它们，处理不掉才升级成 `PROC-NO-WORKER` 之类的进程级失败。

---

### KQ-PACK-LAYOUT-CONFLICT / 同一个权重的多个 M 用了**不同 packed 布局**

> 本类由 `collect_errors.py` 独立识别（`final_layout_conflict` 事件 + `packed layout` 文案），
> **不要**当成 `KQ-CORRECTNESS`：它不是"某个内核算错了"，而是"合并把两个 M 的 pack 混用了"。
> 2026-10-08 之前的两次事故都混在 `KQ-CORRECTNESS` 里，所以第一次修完就没人回头看。

**为什么会这样**：合并产物里 `launch_pack_w8a8_weight` 每个权重 `(N,K)` 只能有一条路由
（它的 ABI 里**没有 m**），所以族内多个 M 变体必须共用一份 packed 布局。
**而这是冻结 API 的硬要求**：`api/int8w8a8gemm/int8_w8a8_gemm_api.py::prepare_weight(raw_weight, weight_scale)`
不接 M —— 真实模型里**一个权重只 pack 一次，然后被所有 M 复用**。
worker 侧契约又明确允许改布局（`prompts.py:600`："may change only its HIP implementation
**and the matching GEMM interpretation** to test packed layouts"），于是同一个 worker 在
不同 M 上换布局是可能的。

**指纹现象**：`mismatch_count` 接近满量程（99.9% 元素错）+ `max_abs_error` 只有几十~
几百（不是爆量级），`median_us` 又正好是**该 shape 自己 kernel 的正常耗时**。
→ 三条同时成立 = 布局/解释不一致，不是精度问题、不是跑错 kernel、更不是卡的问题。

**三次实例**

| 时间 | 任务 | 形态 |
|---|---|---|
| 2026-10-07 | `hy3-tp8-m8-16-4096-2-9dcfce15` | o_proj 的 m8/m16 共用一种布局，m4096 换了另一种；**三个 pack 源码逐字节相同**，静态比对抓不到 |
| 2026-10-08 | `minimax-tp8-m8-16-4096-df6fb501` | qkv_proj 的 m8 pack **不带 K-octet swizzle**，m4096 带；两份 pack 源码正文不同，实测 7,343,908 字节不同（首个差异字节 offset 8） |
| 2026-10-11 | `glm-tp8-m8-16-4096-2663a78f` | **门装了但没跑起来**：探针子进程用空 `sys.executable` 起不来 → `probed=false` → 退回单批 → 6 个族里 **5 个冲突**，挂在 `fused_qkv_a_proj_m4096`（mismatch 10738189/10774404 = 99.9%，max_abs 252.5，median 1192 µs = 该 shape 正常耗时）。根因与修法见下节「2026-10-11」。 |

df6fb501 的具体证据（本机实测，可复现）：

```bash
W=nodes/worker29/workspaces/minimax-tp8-m8-16-4096-df6fb501
grep -n 'launch_pack_w8a8_weight' -A 6 $W/final/cache/compile_sources/*/csrc/w8a8_dispatch.cpp
#   → 每个 (n,k) 一条 pack 路由，取族内最小 M = mi_..._qkv_proj_m8_launch_pack_w8a8_weight
# 把两个 prebuilt 对象各自链成 .so，用 ctypes 直接调 pack，比 packed_weight 字节：
#   pw_m8 != pw_m4096（7,343,908 字节不同）；weight_scale 相同
# 同一个 m4096 GEMM，只换 pack 来源：
#   喂 m8 pack     → mismatch_count = 5237886（复现 final 的失败）
#   喂 m4096 pack  → mismatch_count = 0
# 对照：最终产物的 m8 路径用同一份 m8 pack → mismatch_count = 0（自洽）
```

**处置（2026-10-08/09 落地：`final_layout_gate`）**

合并前对每个 `(N,K)` 族跑一次**探针**（一个子进程覆盖所有族，链上每个成员的 prebuilt 对象）：
拿**每个成员自己的 pack 内核**，用一份"字节计数图"权重、**按本族真实 (N,K)** 打一次包，
对打包结果取 SHA256 作为该成员的**布局指纹**。两条关键结论：

- **必须行为式比对**：hy3 那次三份 pack 源码**逐字节相同**却布局不同，比对源码/符号名完全抓不到。
- **必须按真实 (N,K)**：用小形状探针时 df6fb501 的两个 pack 内核**输出完全相同**（都写了同一块 32 KB），
  只有到真实 `(1280, 6144)` 才分叉 —— swizzle 只在完整 k32 网格上生效。
  实测成本：7.9 MB 镜像 **0.9 ms**、235 MB 镜像 8.3 ms，且不在任何计时区间内。
  整个任务的 5 个族一次探针 **18.6 s**（含子进程的 torch/HIP 初始化，只做一次）。

判读：**指纹相同 = 字节完全相同**，所以这些成员互相可换、可以共用一条 pack 路由；
指纹不同一律按**不兼容**处理（合并无法证明对方读得懂，而事故正是"只认自己那份镜像的读者"）。
这是偏保守的方向：只有真的产出了不同字节，才会多付一批。

分批（`family_groups` / `pack_batches`）：按指纹分组，组内自洽；再把各族的组打进**最少**的批，
每批内每个 `(N,K)` 只有一组 → 一条 pack 路由。批 0 直接渲染进 `final/source`（发布的那棵树
必须是被验收过的那批），其余批在 `final/layout_batches/batchN` 各自带 dispatch + prebuilt 编译。

探针不可用（对象缺失 / 子进程失败 / 无 GPU）→ **仍不判冲突**（`LayoutCheck.ok` 保持 true，
绝不因为探测失败废掉任务），但**不再当成"没有冲突"**：一致性只是**未被证明**，
多成员族按 `unproven_groups` **逐个成员拆批**，并发 `final_layout_probe_failed` 事件
（2026-10-11 起；旧行为是静默退回单批，正是下面这次事故）。探针可跑且指纹全同 → 仍是单批，零额外代价。

**2026-10-11：门对 WebUI 起的任务全程失效（第三个实例的根因）**

`final_layout_gate._probe_families` 用 `subprocess.run([sys.executable, "-c", ...])` 起探针；
而 `server/launcher.py` 起 orchestrator 时把 `argv[0]` 写成友好名 `metainfer-orchestrator`
（真实二进制走 `Popen(executable=...)`）。CPython 从 `argv[0]` 推 `sys.executable`，推不出来时是**空串**：

```bash
python3 -c "import subprocess,sys; print(repr(subprocess.run(
  ['metainfer-orchestrator','-c','import sys;print(repr(sys.executable))'],
  executable=sys.executable,capture_output=True,text=True).stdout))"
# → "''"        ← subprocess.run(['']) 抛 PermissionError: [Errno 13] Permission denied: ''
```

对照（`workspaces/*` + `.metainfer/tasks/*/timeline.jsonl`）：`probed=true` 只出现在
`recovered_serial_validate=true`（从 shell 手工恢复驱动）的任务上；唯一一个 WebUI 起、又跑到门这一步
的任务就是 `glm-…-2663a78f`，`probed=false`。**也就是说这道门 2026-10-08 上线后，
对 WebUI 起的任务一次都没生效过。**

修法：探针子进程统一走 `metainfer.orchestrator.interpreter.python_executable()`
（`METAINFER_PYTHON` → 可用的 `sys.executable` → PATH 上的 `python3`），
`server/launcher.py` 与 `harness_evolve/.../eval.py` 的两份同类函数也接到同一个实现；
探针失败信息里带上解释器路径；回归测试见
`tests/test_final_layout_gate.py::test_probe_spawns_a_resolvable_interpreter_without_sys_executable`
与 `metainfer/orchestrator/tests/test_interpreter.py`。

**2026-10-11 第二个坑：分批以后，第 N 批其实是拿第 0 批的扩展在测**

自动分批上线后第一次真正跑起来（同一个 `glm-…-2663a78f` 的恢复）立刻暴露：
`W8A8Runner` 在合并里**只建一次**（`runner = W8A8Runner(final, serial_gpu)` →
`self.source = final/source`），而 `_validate_layout_batch` 只把**第 N 批的树**渲染到
`final/layout_batches/batchN`，benchmark 仍走 `runner.benchmark(...)` →
**第 N 批的 shape 是被第 0 批的 dispatch 服务的**。

指纹（可静态复现，不用跑 GPU）：

```bash
# 两批各自的 build key（= sha256(bindings.cpp + dispatch + prebuilt/*.o)）
batch0 = final/source                 prebuilt=13  key 6fd5852f…
batch1 = final/layout_batches/batch1  prebuilt=5   key 5f8f2d65…
ls final/cache/compile_sources/       # → 只有 18cee70c…(旧) 与 6fd5852f…(batch0)
                                      #   batch1 的 key 根本不存在 = 它从未被编译/加载
```

后果：batch 1 的 `fused_qkv_a_proj_m4096` 走 batch 0 的 M 链退化成 **m16 kernel**
（数值正确、慢 2.28×：2721.7 µs；同形状的真产物在卡 0/3/5 实测 1188.8 / 1193.9 / 1214.0 µs，
与 worker best 1191.7 一致）→ 性能门把"从没被测量过的产物"判成回退，恢复两次都挂在这上面。

修法：每批用**自己的树**建 runner —— `W8A8Runner(..., source=batch_source)`
（`worker_root` 继续持有 references/torch/logs 缓存，所以 build key 仍按批内容寻址）；
回归测试 `tests/test_gen_pipeline.py::test_runner_can_point_at_a_layout_batch_tree`
与 `tests/test_final_layout_gate.py::test_each_batch_benchmarks_its_own_tree`。

**教训**：手动按 M 恢复（`--m-values 8/16/4096` 三次独立调用）每次都是**单批**，
所以这条路一直没暴露这个 bug；**自动分批是第一个把 batch_count>1 真正跑起来的路径**。

**DF6FB501 实测（2026-10-09，卡 3）**

```
final_layout_conflict:
  conflicts: 1280x6144  (['minimax_tp8_qkv_proj_m8']; ['minimax_tp8_qkv_proj_m4096']),
             1536x6144  (['..._qkv_proj_and_indexer_qk_m8']; ['..._qkv_proj_and_indexer_qk_m4096']),
             6144x384   (['..._shared_down_proj_m8']; ['..._shared_down_proj_m4096'])
```

即**三个族真的分叉**；`shared_gate_up_proj`（768x6144）与 `o_proj`（6144x1024）的 m8/m4096
指纹**完全相同**，仍留在同一批 —— gate 不会"见到多 M 就无脑拆"。
分派据此拆成 7 + 3 两批（批 0 含两个 M 的 o_proj / gate_up 与全部 m8）。

同任务手工两批恢复（`--m-values 8`，5 shape）实测：**`status=success`，5/5 过性能门**
（`final_target.all_shapes_met = True`），correctness `mismatch_count=0`，median 与 worker best 同量级：
o_proj 12.91 / qkv_and_indexer 34.03 / qkv 16.79 / shared_down 10.79 / shared_gate_up 15.44（µs）。

**仍然要靠流程避开的**：一个任务里同一算子放多个 M 仍有"多一份打包"的代价；
**根治（未做）**是让 worker 遵守"同一权重一份 packed 布局"（布局升级为任务级参数 +
族级契约测试）。参见 `docs/dkao_suite_protocol_v2.md` 与下一条目。

**旧的处置（`recover_serial_validate --m-values`，仍然可用）**

```bash
python3 -m metainfer.tasks.dcu_kernel_auto_opt.orchestrator.recover_serial_validate \
  <requirements.json> --state-dir <state> --workspace-dir <workspace> --m-values 8
```

`--m-values` / `--shape-ids` 只把该批次的 accepted artifact 合并进去，**不重跑任何优化轮次**。
注意：`--state-dir` 要指向**任务自己的目录**（`.../.metainfer/tasks/<task_id>`，里面才有 `run.json`），
且 `METAINFER_SERIAL_VALIDATE_GPU` 必须是该任务**已分配的 worker 卡**之一（见下）。

- **实测**（任务 `hy3-tp8-m8-16-4096-2-9dcfce15`，12 shape，卡 2，三批各 4 shape）：
  **三次全部 `status=success`，12/12 过性能门**，合并后 median 与 worker best 一致：

  | 批次 | shape | worker best | 合并后 |
  |---|---|---|---|
  | M=8 | o_proj / qkv_proj / shared_down / shared_gate_up | 12.27 / 13.43 / 9.41 / 12.02 | 12.60 / 13.81 / 9.45 / 11.89 |
  | M=16 | 同上 | 12.22 / 14.77 / 10.29 / 12.90 | 13.35 / 14.93 / 10.19 / 12.98 |
  | M=4096 | 同上 | 397.3 / 410.7 / 208.9 / 198.2 | **397.2** / 412.0 / 207.9 / 198.4 |

  对照：整任务一次合并时，同样的 artifact 在 `o_proj_m4096` 上要么跑错 kernel（1026 µs）、要么正确性失败（99.9% 元素错）。
- **两条踩过的坑**：
  1. `--state-dir` 给成 `.metainfer` 根目录 → `FileNotFoundError: no run.json at .../.metainfer/run.json`；
  2. `METAINFER_SERIAL_VALIDATE_GPU` 给成任务没分配过的卡（例如任务只用了 0–3，却给 5）
     → `serial validation GPU must be one of the completed worker GPUs [0, 1, 2, 3], got 5`。
     这是**有意**的约束：串行验收必须回到该任务自己的卡上，不能借别的任务的卡。

---

### KQ-CORRECTNESS

**内核算错（正确性/Graph 校验不过）** ｜ 状态：设计行为 ｜ 真出现 9 次 +（2026-09-22 现场 1 次）

### 两种原文

```
worker_iteration_failed: exact correctness failed:
{"device_name": "K500SM_AI", "first_mismatch": {"abs_error": 13.21875, "actual": 5.78125, "expected": -8.4375,
  "flat_index": 0, "m": 0, "n": 0}, "graph_capture_passed": true, "median_us": ...}

worker_bootstrap_attempt_failed:
child-generated kernel Graph/correctness validation failed for <shape>: {…"first_mismatch": {…}…}
```

### 判定

带 `first_mismatch`（首错位置 + 绝对误差）与 `graph_capture_passed`：
- `passed: false` + `first_mismatch` → 数值不对（归约顺序、标量边界、量化尺度/零点、累加精度…）；
- `graph_capture_passed: false` → Graph 捕获失败（动态 shape/分配、host 同步、stream 用法）。

### 现场样例（2026-09-22 13:18，任务 `dcu-kernel-auto-opt-dee7d379`）

```
worker_1 bootstrap attempt 1: passed=false, first_mismatch abs_error=10.25 @ m0/n0
13:21:03 attempt 2: passed=true → worker_bootstrap_success
```
即 **agent 第一版算错、第二版修好**，全程无需人干预——这是正常回路。

### 处置

不用处理，看后续尝试即可；只有当某个 shape **反复多次**同一个位置错时，才值得查
agent 用的参考实现/接口契约（`first_mismatch` 的 `flat_index/m/n` 指出位置）。

---

## KQ-INLINE-ASM

**`inline asm acceptance gate failed: …`** ｜ 状态：设计行为 ｜ 真出现 1 次

```
worker_3-...-iter17 failed: …; inline asm acceptance gate failed:
proposal.json is missing isa_optimization; trusted candidate gfx928 ISA audit is …
```

内联汇编（DUMMA/MTBUF 等）默认要**先有 ISA 审计证据**才允许用在候选里
（`evaluate_inline_asm_gate`：`isa_policy.raw_inline_asm_allowed` + 已核验的目标指令）。
缺 `isa_optimization` 声明或审计不可信 → 该提案被拒。处置：按提示补 ISA 证据，或让 agent 走无内联汇编路径。

---

## KQ-PERF-REGRESSION

**性能回退（最终验收不过）** ｜ 状态：设计行为 ｜ 真出现 **72** 次

```
performance regressed for m2_wqkv_a: final 12.34 us vs worker best 11.60 us   → final_synthesis_rejected
```

worker 侧接受的"最好"在**最终串行验收**（独占卡、串行重测）时没达到门限
（默认 `worker best + max(5%, 2 µs)` / 无 P90 回退；2 µs 绝对下限只作用于 best < 40 µs 的小 kernel）。
常见原因：worker 期间的测量受同批 lane/邻居负载影响（整机 4 lane 同时跑本身就是竞争负载）、
卡间差异（同一 shape 跨卡可差 4%）、环境地板漂移（同一份代码 median 从 884us 漂到 3047us 的实测记录存在）。
处置：换卡重测（`METAINFER_SERIAL_VALIDATE_GPU=<card>`）、等机器安静后重跑；
**不要**把它当成"内核变差了"。

### KQ-PERF-REGRESSION / 第二种根因：最终 dispatch 忽略 M（**控制面 bug，2026-10-07 已修并验证**）

2026-10-07 实测（任务 `hy3-tp8-m8-16-4096-2-9dcfce15`）：

```
performance regressed for hy3_tp8_qkv_proj_m4096:
  final 1026.342 us vs worker best 410.660 us (limit 431.193 us = best + 20.533 us) after 3 re-measures
```

**这次不是噪声，也不是内核变差**：4 次测量方差 < 0.5%（1026.85 / 1026.34 / 1026.34 / 1026.34，
每次间隔 5 分钟），同一张卡（`serial_gpu` = 第一个完成的 worker 卡 = 卡 2，
正是测出 410.66 µs 的那张）。

**根因**：最终合并产物的分派器**只按 `(n, k)` 路由、完全不看 `m`**。
生成它的 `gen_and_opt_pipeline._render_prebuilt_dispatch()` 用 `seen_pairs: set[(n, k)]` 去重：

```python
pair = (n, k)
if pair in seen_pairs:      # ← 同 (N,K) 的后续 M 变体直接被丢掉
    continue
```

于是**同一算子、同 (N,K)、不同 M** 的多个 artifact 里，**只有第一个拿到路由**
（artifact 按 `shape_id` 排序 → `m16` < `m4096` < `m8`，所以是 **m16**），
其余 M 变体统统落到那个分支。最终生成的
`final/source/csrc/w8a8_dispatch.cpp` 里就是：

```c
if (n == 1280 && k == 4096) {           // qkv_proj 的 m8/m16/m4096 全部命中
    mi_hy3_tp8_qkv_proj_m16_launch_w8a8_gemm(...);   // ← M=4096 也跑 M=16 调优的 kernel
```

M=4096 的 prefill 跑 M=16 调优的 kernel：**数值正确（能过正确性门）、慢 2.5×**（1026 vs 410）。

**判定特征（怎么和噪声型回退区分）**

| 特征 | 噪声型（本节上半） | 本 bug |
|---|---|---|
| 回退幅度 | 几个 % ~ 几十 % | **巨大且整齐**（本例 2.50×） |
| 重测是否抖动 | 抖 | **几乎不变**（< 0.5%） |
| 影响范围 | 随机某几个 shape | **同族大 M 变体**（小 M 变体反而"侥幸过关"，因为借 m16 的 kernel 不会更慢） |
| 任务形态 | 无关 | shape 里有**同算子、多个 M、相同 (N,K)** |
| 直接证据 | — | `final/source/csrc/w8a8_dispatch.cpp` 里的 `if (n == … && k == …)` **没有 m** |

**为什么以前 72 次都没暴露**：历史任务基本是**一个算子一个 M**（例：MiniMax TP8 M8 的 5 个 shape
= 5 个不同算子，`(N,K)` 天然唯一），`(n,k)` 键够用。本例是第一个"每个算子三个 M 变体"的任务。

**影响（比"这一次失败"更大）**：即使门侥幸过了，最终 artifact 也**不是各 worker 优化出来的那套**
——小 M 变体会静默地跑 m16 的 kernel，而报告仍写着各 shape 的 worker best。
**最终交付与 measurement 脱节**。

**证据链（可复现）**

```bash
W=nodes/worker29/workspaces/hy3-tp8-m8-16-4096-2-9dcfce15
grep -n 'if (n ==' $W/final/source/csrc/w8a8_dispatch.cpp        # 只有 n / k，没有 m
sha256sum $W/final/source/accepted_sources/hy3_tp8_qkv_proj_m4096.hip
#   = ff84f677… = 该 worker iteration15 的 csrc/w8a8_gemm_hip.hip（逐字节相同）
ls $W/main/candidates/worker_2/hy3_tp8_qkv_proj_m4096/iteration15/csrc/
#   只有 bindings.cpp + w8a8_gemm_hip.hip → worker 侧量的是自己的 kernel，没有 dispatch
```

**临时处置（不改代码）**：提交任务时**让每个算子只出现一个 M**（`(N,K)` 便唯一，分派不会再撞车）。
换卡重测**无效**（本例已证明与卡无关）。

**状态：已修（2026-10-07）并实测验证**。修法：`_render_prebuilt_dispatch()` 改为按完整
`(m, n, k)` 路由，族内是"降序 M 链"（精确 M 命中自己的 kernel；未优化的 M 落到不大于它的最大 M，
再兜底族内最小 M），`pack` 仍每族一条（ABI 无 m）；生成物额外记录 `dispatch_families`
（`final_artifact_link_launch` 事件）便于排查。测试：`test_gen_pipeline.py` 里 6 个新用例，
含"每个 artifact 都必须可达"与"顺序无关"。
**实测**：同一任务的 `qkv_proj_m4096` 从 **1026 µs → 411.96 µs**（worker best 410.66），并正确通过。
**注意**：修好之后，同族里若各 M 的 packed 布局不一致，会从"静默跑错 kernel（正确但慢）"变成
"正确性失败" —— 那是上一条根因，按 M 分批解决。

---

## 与测量层的关系

`KQ-*` 报错都建立在"测量可信"之上（闸门已过）。如果同时看到 `gate_blocked` / `ENV-GATE-TIMEOUT`，
先按 `03` 解决可信度问题——在忙卡上得出的"性能回退"完全可能只是噪声。
