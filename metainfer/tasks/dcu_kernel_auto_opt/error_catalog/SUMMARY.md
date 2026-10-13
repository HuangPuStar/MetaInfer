# DKAO 报错汇总（自动生成）

- 扫描任务数：**165**
- 命中报错条目：**1538**（去重后）
- 生成时间：2026-10-09 00:43

由 `collect_errors.py` 生成，请勿手改；新增/调整判定规则改那里，人类解释写在 `NN-*.md`。

| 类别 | 标题 | 层 | 状态 | 次数 | 首次 | 最近 | 示例任务 |
|---|---|---|---|---:|---|---|---|
| `GEN-AGENT-EJECT` | agent 非零退出（逐次尝试） | generate | environment | 565 | 2026-07-28 09:21 | 2026-10-08 11:57 | `dcu-kernel-auto-opt-d4dd2dc5`, `glm5-2-dsh-tp8-m4096-1-e6a280a2`, `hy3-dsh-tp8-m16-2-dc53295a` … (+83) |
| `PROC-AGENT-KILLED` | agent 被 kill（含超时/OOM） | process | environment | 438 | 2026-07-27 01:42 | 2026-10-08 10:23 | `dcu-kernel-auto-opt-2e64c51b`, `dcu-kernel-auto-opt-602ee1ee`, `dcu-kernel-auto-opt-7892abc2` … (+34) |
| `MEAS-PMC-UNAVAILABLE` | PMC/hipprof 证据不可用（跳过） | measurement | by design | 226 | 2026-08-03 16:05 | 2026-10-08 00:44 | `dcu-kernel-auto-opt-7892abc2`, `dcu-kernel-auto-opt-cc86e2b2`, `dcu-kernel-auto-opt-fa8de7cc` … (+104) |
| `KQ-PERF-REGRESSION` | 性能回退（最终验收不过） | kernel-quality | by design | 78 | 2026-07-28 14:40 | 2026-10-07 23:20 | `dcu-kernel-auto-opt-7eafe2cc`, `dcu-kernel-auto-opt-8c1f2eac`, `dcu-kernel-auto-opt-c7e73766` … (+26) |
| `ENV-GATE-TIMEOUT` | 闸门等待/等超时（卡被占） | environment | by design | 69 | 2026-09-17 21:44 | 2026-09-23 19:38 | `test-9-17-1-aaea0725:iteration_001/glm_tp8_fused_qkv_a_proj_m4096`, `test-9-17-1-aaea0725:iteration_001/hy3_tp4_o_proj_m16`, `test-9-17-1-aaea0725:iteration_001/minimax_tp8_qkv_proj_m4096` … (+14) |
| `GEN-CONFLICT` | 工作区 main 已被别的 repo 占用 | generate | fixed | 64 | 2026-09-11 18:34 | 2026-09-15 16:26 | `hy3-tp8-m16-ahe-v2-ea5b8069:iteration_002/hy3_tp8_shared_down_proj_m16`, `hy3-tp8-m16-ahe-v2-ea5b8069:iteration_004/hy3_tp8_indexer_wq_b_m16`, `hy3-tp8-m16-ahe-v2-ea5b8069:iteration_004/hy3_tp8_o_proj_m16` … (+14) |
| `MEAS-CMD-FAILED` | 基准/PROBE 子进程非零退出 | measurement | environment | 55 | 2026-07-28 11:22 | 2026-09-23 21:46 | `dcu-kernel-auto-opt-2e64c51b`, `dcu-kernel-auto-opt-602ee1ee`, `dcu-kernel-auto-opt-7892abc2` … (+23) |
| `GEN-NO-KERNEL` | agent 没能产出可用内核 | generate | by design | 18 | 2026-07-28 11:49 | 2026-09-14 17:37 | `dcu-kernel-auto-opt-7892abc2`, `dcu-kernel-auto-opt-a473ffe1`, `glm5-2-dsh-tp4-m4096-1-85cb689c` … (+5) |
| `KQ-CORRECTNESS` | 内核算错（正确性/Graph 校验不过） | kernel-quality | by design | 10 | 2026-07-29 14:30 | 2026-10-09 00:40 | `dcu-kernel-auto-opt-8b6136de`, `dcu-kernel-auto-opt-c7e73766`, `dcu-kernel-auto-opt-cc86e2b2` … (+5) |
| `ENV-SHM-SANDBOX` | 无法写 /dev/shm（文件沙箱） | environment | fixed | 5 | 2026-08-21 17:15 | 2026-09-09 22:05 | `hy3-dsh-tp8-m16-9-8-0161e718`, `hy3-tp4-m4096-dsh-test1-bfdf3002`, `minimaxm3-dsh-tp4-m4096-1-0c2f84a9` |
| `GEN-OWNERSHIP` | agent 改了自己不该改的文件 | generate | by design | 4 | 2026-07-28 11:27 | 2026-07-28 11:43 | `dcu-kernel-auto-opt-a473ffe1` |
| `GEN-BINARY-MISSING` | agent 可执行文件/模块不存在 | generate | environment | 2 | 2026-08-03 16:40 | 2026-08-03 16:40 | `dcu-kernel-auto-opt-7892abc2` |
| `ENV-NO-DEVICE` | 看不到设备（No HIP GPUs are available） | environment | by design | 1 | 2026-08-20 10:43 | 2026-08-20 10:43 | `hy3-tp4-4096-sonnet-5i-1-cbcd099f` |
| `GEN-COORD-FAILED` | 生成阶段重试耗尽（外层包装） | generate | environment | 1 | 2026-07-28 19:29 | 2026-07-28 19:29 | `dcu-kernel-auto-opt-7eafe2cc` |
| `KQ-INLINE-ASM` | 内联汇编验收门不通过 | kernel-quality | by design | 1 | 2026-08-27 04:35 | 2026-08-27 04:35 | `hy3-dsh-tp8-m4096-1-0ebb994d` |
| `PROC-NO-WORKER` | 一张卡都没跑通（bootstrap 全灭） | process | by design | 1 | 2026-08-03 16:40 | 2026-08-03 16:40 | `dcu-kernel-auto-opt-7892abc2` |
| `ENV-NO-LEASE` | 租不到卡（scheduled/生产模式） | environment | environment | 0 | — | — | — |
| `ENV-PROBE-WRAPPER` | probe 重试后仍失败（外层包装） | environment | fixed | 0 | — | — | — |
| `GEN-CONTRACT` | API 契约/参考自检不可信 | generate | by design | 0 | — | — | — |
| `GEN-SCHEMA` | 表单/契约参数非法 | generate | by design | 0 | — | — | — |
| `KQ-PACK-LAYOUT-CONFLICT` | 同一权重的多个 M 用了不同 packed 布局（合并期冲突） | kernel-quality | fixed | 0 | — | — | — |
| `MEAS-REF-PREPARE` | 参考缓存准备失败 | measurement | environment | 0 | — | — | — |
| `MEAS-TIMEOUT` | 基准超时 | measurement | environment | 0 | — | — | — |
| `PROC-BUG` | DKAO 自身的代码缺陷（崩溃） | process | open | 0 | — | — | — |

> 未命中任何类别的条目不会出现在汇总里；如果某个新报错总被漏掉，就在 `CLASSES` 里加一条规则。
