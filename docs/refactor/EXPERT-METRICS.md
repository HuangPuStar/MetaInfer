# 专家绩效指标边界（C13）

`computeExpertMetrics` 暴露 `proposals` / `accepted` / `completed` / `pruned` /
`costUsd` / `avgCycleLatency`，其中 `accepted` 只表示“该专家创建后进入非
proposed 状态的节点数”，是**观测字段**，不是排序、奖励或自动晋升依据。

C13 所反对的 Goodhart 用法是“用采纳率给专家打分并据此分配任务”。本分支没有
这样的路径：

- `accepted` 不写回 roster，也不影响 `expert_hire` / `expert_drain` / `expert_fire`。
- curator 只看确定性召回与 `falseCloseRate`，不看 `accepted`。
- 评审/提案的取舍走 `submitIntent` 的 claim 谓词与 C7 引用记录，不接受
  “采纳率高”作为证据。

因此 QA §Q4-4-6 的 `accepted` 字段与 C13 的“不看采纳率”不矛盾：字段用于诊断
吞吐与工作量，不用于评价质量。质量信号是 `citationErrorRate`、归因到专家的指标
提升、预测校准和 `dupRateByExpert`（后两项仍是 5.3 能力项，未在本行冒充完成）。
