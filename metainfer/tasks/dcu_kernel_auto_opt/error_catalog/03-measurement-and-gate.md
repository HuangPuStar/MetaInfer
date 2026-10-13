# 03 · 测量与闸门类

DKAO 的核心纪律：**卡不干净就不给数字**。所以这一层"报错"很多时候是**故意的拒绝**，
先分清"拒绝测量"（设计行为）和"工具/环境坏了"（环境类）。

闸门（measurement gate）判据只有一条：**VRAM ≤ 90% 且 HCU == 0**（`gpu_preflight.py`），
检查时机：每次**计时 benchmark 之前**、每次 **PMC profile 之前**（检查自己那张卡），
以及生成阶段的 probe（`ensure_any_measurement_gate`：自己卡优先，否则任意空闲卡）。
每查一次往 `<task_state>/measurement_gate.jsonl` 写一行 `gate_ok` / `gate_blocked`
（含 gpu / site / attempt / util% / VRAM% / reasons）。

---

## ENV-GATE-TIMEOUT

**闸门等待 / 等超时** ｜ 状态：设计行为 ｜ 真出现 **84** 次（19 个 DKAO 子任务）

两种原文，都是同一件事：

```
# ① 等待中的审计行（<task_state>/measurement_gate.jsonl）
{"event": "gate_blocked", "site": "benchmark", "gpu": 0, "attempt": 4, "max_waits": 48,
 "wait_seconds": 1800, "usable": false, "vram_percent": 34.0, "util_percent": 100.0,
 "reasons": ["device busy: HCU 100.0% > 0.0%"]}

# ② 等满 24h 后的最终形态
GPU 0 did not pass the measurement gate (VRAM <=90% and HCU ==0) after 48 checks: …
```

**真实样例**：2026-09-17 `test-9-17-1-07bb5cd8` 的 `hy3_tp8_o_proj_m4096` 子任务，17:57 / 18:27 /
20:47 / 21:17 / 23:47 … 每 30 分钟一条 `gate_blocked`，`gpu0` 的 HCU 一直是 100%——
**这就是"卡被占住时 DKAO 的样子"**：不测、不报错、每半小时重查一次，日志里留痕。

### 语义（看清这几条，基本不会误判）

| 项 | 值 / 行为 |
|---|---|
| 重查间隔 | 30 min（`METAINFER_GATE_WAIT_SECONDS`，默认 1800s） |
| 上限 | 48 次 ≈ **24 小时/每次调用**（`METAINFER_GATE_MAX_WAITS`） |
| 等待期间 | **不测**（宁可不给数，也不给被污染的数），只写 `gate_blocked` 审计行 |
| 超时后 | 抛 `MeasurementGateBlocked` → 该轮记 `worker_iteration_failed`（"record failed round, restore best commit, and continue"） |
| lane 之间 | **不互相阻塞**：别人占的卡在等，其它卡的 lane 照常优化；但整个 phase 要等所有 lane 收尾 |
| 判定为基础设施故障吗 | **不算**。`is_infrastructure_failure()` 只认 `timeout/timed out/killed/no result/exit 143`，闸门阻塞不计入那 5 次 infra 恢复额度 |
| 预算粒度 | **每次 gate 调用独立 24h**（bootstrap 每卡最多 3 次尝试 → 卡一直没空时可能挂很久） |

### 处置

1. 先确认卡是不是真的被占：`hy-smi` / `foreign_kfd_pids()` / `gpu_preflight.sample_gpu_state`
   （本机 2026-09-22 13:26 的实测：4 张卡 util 100%，GPU2/3 VRAM 87%，外来 KFD 进程 10 个 → 邻居容器在跑）。
2. 等卡空；或换卡；或把等待调小让它早点报出来（`METAINFER_GATE_WAIT_SECONDS=300 METAINFER_GATE_MAX_WAITS=6`）。
3. 彻底关闸门：`METAINFER_GPU_PREFLIGHT=0`（**卡忙也照测，数字会被污染，别用于生产/验收**）。

---

## MEAS-CMD-FAILED

**基准/probe 子进程非零退出** ｜ 状态：环境 ｜ 真出现 **53** 次

```
python3 .../w8a8_bench.py --source ... --m 1 --n 1 --k 1 --prepare-reference failed (1): shm_open: Permission denied
Command '['python3', '.../w8a8_bench.py', ...]' returned non-zero exit status 1
```

判定顺序：**先在同一行后面找真病因**（`shm_open` → `ENV-SHM-SANDBOX`；traceback → 编译/接口错误；
`--prepare-reference` → 见下条）。处置：修病因后重跑；这类失败会被记为基础设施类并自动补一轮。

---

## MEAS-REF-PREPARE

**参考缓存准备失败** ｜ 状态：环境

`--prepare-reference` 用来生成 int64 精确参考（正确性判据）。失败原因通常是：
磁盘/缓存目录不可写、`/dev/shm` 受限（同 `ENV-SHM-SANDBOX`）、显存不足、或参考协议版本不一致。
处置：确认 `<worker_root>/cache/references/` 可写、卡上无并发占用；参考缓存可复用（同名 shape 不必重算）。

---

## MEAS-TIMEOUT

**基准超时** ｜ 状态：环境

单次 benchmark 上限 `_BENCHMARK_TIMEOUT_S = 1200`（20 分钟）。卡被外部作业拖慢、内核死循环/
挂死（`Graph` 捕获卡住）都会命中。处置：看是不是被占（闸门通过≠全程独占），或内核本身挂死
（后者按 `04` 处理，属于候选代码问题）。

---

## MEAS-PMC-UNAVAILABLE

**`worker_pmc_skipped … available: false`** ｜ 状态：设计行为 ｜ 真出现 **210** 次（高频，但**不是失败**）

hipprof/PMC 证据拿不到时（权限、驱动、卡不支持某组 counter、profiler 冲突），这一轮**跳过 PMC 采集继续跑**：
调优少了 ISA 级依据，正确性与性能结论不受影响。只有把它错当成"报错"才会误导判断——
它**不会**导致任务停止。处置：无需处理；若长期全任务都缺 PMC，检查 `hipprof` 可用性
（`hipprof_executable` 在 `generation_preflight.json` 里有记录）。

---

## 测量中"被抢"（污染处置）

设计上：父侧把被抢的时间窗写进 `<child_state>/contention.json`，子侧收尾时
`discard_if_contaminated()` 会**丢掉这一轮的数、隔离到 `contaminated/`、并把源码 git 回滚到
上一次被接受的 commit**，然后重测（timeline `worker_round_discarded_contended`）。

**现状（2026-09-22 核查）**：仓库里**只有读方、没有写方**——harness-evolve 明确删掉了自己的
contention watch（`adapters/eval.py`：*"a contention window: gone entirely … DKAO's gate and
contamination handling do"*）。也就是说这条"事后作废"路径目前**休眠**，真正生效的是：
测前闸门 + `measurement_suspect` 可疑标记（功率异常/外来 KFD pid → 只报告并排在 clean 卡后面）
+ 最终串行验收重测。看到 `worker_round_discarded_contended` 说明**有人**在写这个文件，需要确认是谁。

### 最终串行验收**自己也**会落在污染窗口里（2026-10-11 实例）

**现象**：第 5 步报

```
performance regressed for <shape>: final X us vs worker best Y us
  (limit ... = best + ...) after 3 re-measures
```

而且 X **非常稳**（`latency_samples_us` 紧到 ±0.1%），看起来像"结构性变慢"。

**实例**（`glm-tp8-m8-16-4096-2663a78f` 的恢复运行，卡 0）：17:00–17:31 这个窗口里**两个 shape 同时偏慢**

| shape | worker best | 窗口内实测 | 窗口后同一产物重测 |
|---|---|---|---|
| `glm_tp8_fused_qkv_a_proj_m4096` | 1191.7 | 2721.7 / 2720.8 / 2720.8 / 2720.8 | **1191.8 / 1188.8**（卡 0）、1214.0（卡 5）、1193.9（卡 3） |
| `glm_tp8_shared_down_proj_m16` | 10.23 | 13.65 / 13.60 | — |

重测命令（合并产物原样，不重编、不改 kernel）：

```bash
cd <task>/final/layout_batches/batch1     # 或 final/source
HIP_VISIBLE_DEVICES=0 python3 w8a8_bench.py --source . \
  --m 4096 --n 2624 --k 6144 \
  --reference-cache-dir <task>/final/cache/references \
  --warmups 30 --samples 10 --replays-per-sample 50
```

**为什么重测救不回来**：`_PERF_GATE_RETRY_INTERVAL_S = 300`（3 次重测共 ~15 分钟），
一个 ~30 分钟的共租户窗口把**每一次**重测都罩住了。窗口越界 → 4 次测量全废 → 任务挂在第 5 步。

**判据（真回归 vs 污染）**：同一棵合并产物、同一张卡、稍后重测一次。回到 ≈ worker best = 污染；
仍然慢 = 真回归，再去查路由/pack/workspace。

### 污染是**按卡**的，而 `hy-smi` 的 0% 看不出来（2026-10-11 实测）

同一分钟、同一棵产物、同一个 µs 级 shape（`glm_tp8_shared_down_proj_m8`，门限 11.556 µs）：

| 卡 | median | 结论 |
|---|---|---|
| 1 | 9.507 / 9.779 | 干净 |
| 3 | 9.672（p90 9.696，极紧） | 干净 |
| 2 | 16.544 | 被污染 |
| 5 | 12.771 / 10.040 | 时好时坏 |
| 0 | 13.040（同批另一个 shape 20.416） | 被污染 |

而这几张卡在 `hy-smi` 上都显示 **DCU% = 0**（采样瞬间看不到别人**短 kernel 突发**；
1.2 ms 的大 kernel 对同一种污染几乎不敏感 —— 同一张卡 0 测 M=4096 仍是 1188.8 µs = best）。

**所以"等 hy-smi 全 0% 再跑"是不够的。**正确的前置检查是**先量一个已知 shape**：

```bash
# 用已知 worker best 的 µs 级 shape 在候选卡上打一发，比 best 高 >5% 就换卡
HIP_VISIBLE_DEVICES=<card> python3 <tree>/w8a8_bench.py --source <tree> \
  --m 8 --n 6144 --k 256 --reference-cache-dir <task>/final/cache/references \
  --warmups 30 --samples 30 --replays-per-sample 50
```

`recover_serial_validate` 的默认卡本来就是 **3**（`METAINFER_SERIAL_VALIDATE_GPU` 的
`setdefault`，注释写的"default to a non-zero card"）—— 恢复时**不要**随手覆盖成 0。

**处置**：等 `hy-smi` 全部 0% 再跑恢复；在污染窗口内得出的性能结论一律标可疑。
（本机是**风冷**卡、显存地址散列没开 → 共租户的"跳行读"会让带宽直接腰斩，比液冷机敏感得多，
见 `wiki-metainfer/machines.md` 与 `gotchas/air-machine-no-address-hashing.md`。）
