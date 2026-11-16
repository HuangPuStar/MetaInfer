# Node timeboxes, follow-up evidence and automatic progress

## 修改时限 / Editing a timebox

- 在节点检查器修改分钟数并保存。运行中只解锁时限，不解锁任务、模型或资源。
- 时限是**本次总预算**，不是从保存时重新计时。例如已运行 100 分钟、原预算 120 分钟，改成 240 分钟后剩余约 140 分钟；不会重启任务。
- planned/proposed 保留普通编辑；failed/cancelled/未封存 completed 可保存下次执行预算，但不会自动启动。已有后继、tag 或封存标记的历史节点不可修改。
- 只接受整数分钟 1..项目上限。项目默认上限为 240 分钟，可在项目设置提高，绝对上限 1440 分钟。修改项目默认/上限不会静默重写已有节点预算。
- 已经到期、正在启动/结束/终止的节点不能通过保存“复活”。等待状态更新，调整已停止节点的预算，再显式重试。
- 继续实验请使用 Lab 的继续对话/重试。原生会话直接输入可能绕过 Lab 管理；打开原生会话并不等于注册了一次受管续跑。

The owner-authenticated node-edit command accepts a timebox-only payload:

```json
{ "type": "node.edit", "projectId": "<project-id>", "nodeId": "<node-id>", "timeboxMinutes": 240 }
```
The native `metainfer_lab` tool exposes the same field with `action: "update_node"`. HTTP keeps its existing error envelope; callers must inspect `ok`, not only HTTP status. Running or terminal nodes reject mixed task/model/resource edits before model capability lookup or mutation. Planned/proposed mixed edits keep their previous permissions.

For a running entry, `newDeadline = oldDeadline + (newBudget - oldBudget)`. The Host preserves this attempt's elapsed time, including managed follow-ups, and updates the persisted deadline plus watchdog view together. A budget already exhausted by elapsed time is rejected. Watchdog and cancellation claim the current entry once; stale timer snapshots cannot terminate an extended or replacement attempt. Expiration still requires Host execution and cleanup: it is not a real-time guarantee that every remote process has vanished at that instant.

| Code | User action |
|---|---|
| `timebox_invalid` | Enter whole minutes in range; increase the project limit first if needed. |
| `timebox_elapsed` | Choose a total budget longer than the elapsed time. |
| `node_timebox_unavailable` | Refresh; wait for starting/stopping/expired work to settle, then retry. |
| `node_not_editable` | Send only the timebox for live/terminal nodes; use a new node for task changes. |
| `node_sealed` | Keep history immutable and configure a new node instead. |

The inspector renders these codes in its current Chinese/English language, prevents duplicate submissions, ignores late results after selection/unmount, and preserves a user's draft during polling. Unknown Host details are not printed as a raw error in this editor.

## 报告与续聊 / Current evidence and managed follow-ups

A completed local follow-up is a new managed execution, with an active entry, deadline and cancellation path. Its text replaces the current structured report, while previous structured evidence is retained as history. Text alone is not promoted to a successful structured report or invented metrics.

`nodeReportView` is the read-only selection rule used by advisor snapshots, GC input, node ancestry/merge prompts, state/dashboard responses and edit command DTOs. It also recognizes legacy follow-up evidence only when its head/text match and there is no later activation/merge evidence. It never rewrites historical records on a GET. State and edit responses use the same projection. A partial command DTO does not represent the full project revision: the UI reconciles with a full snapshot so concurrent changes to other nodes are not hidden by unchanged-revision polling.

Review identity is the selected report's version plus the Git head, not the head alone. An advisor answer is checked against the exact frozen evidence sent to it, under the project lock, before creating proposals or marking a leaf reviewed. A newer report on the same commit remains eligible for a fresh review. Old structured history and generic project heartbeats do not count as new experimental progress.

Local follow-up completion binds the real string MessageId returned by `sendMessage` to `agent/inbox/claimed`, then to `turn/end` on the exact Session object and turn. Steer can use the same turn; the Host never guesses “current turn + 1”. Receipt, claim and end may arrive out of order. Each pending execution caches at most 32 claim and 32 end metadata entries, not extra message bodies; absent/evicted evidence leaves watchdog/cancel management in place instead of inventing completion. The entrypoint listener is scoped to plugin disposal. Initial activation `handle.result` and external driver completion retain their existing paths; GPU/external follow-up restrictions are not relaxed.

## 自动暂停 / Automatic pause reasons

| Reason | Meaning / 含义 |
|---|---|
| `idle` | No remaining schedulable action; inspect the latest report. / 暂无可调度动作。 |
| `needsUserDecision` | A current advisor answer requests a human decision. / 等待你确认或补充指令。 |
| `errors` | Repeated role/scheduling failures; inspect runs. / 调度连续出错。 |
| `noProgress` | Repeated completed cycles with no output and no genuine waiting/progress. / 真正连续无产出熔断。 |

Running workers, deferred/busy role work, resource queues and proposed nodes waiting for confirmation are not empty-loop failures. New report/head evidence or new work appearing during an awaited cycle gives that work a subsequent scheduling pass; revision bumps, heartbeats and ignored historical reports do not grant a permanent exemption. A genuinely unproductive subsequent pass can still trip the fuse. Errors take their own path instead of inflating the no-progress streak.

Explicit Resume (and stop/start in the same Host lifetime) clears consecutive idle/error streaks, **not** accumulated cycle, wall-clock, token, cost or node budgets. Budget checks still take precedence when new evidence arrives. The fix does not auto-resume a paused experiment or automatically run user work.

## 安全边界 / Safety and restart boundaries

- 节点预算与 advisor/scheduler 的角色超时是独立设置；本改动不覆盖角色超时定制。
- 插件重载/Host 重启不是运行中实验的热迁移，可能将 running 节点标为 failed。更新前检查实际活动（含原生、外部、远端任务），不可把状态字段当作进程/GPU 已清理的证明。
- Persistence spans multiple storage operations, not a database transaction. A failed edit restores only its node budget fields and compensates the node write, never an older project snapshot. Revision/event-sequence reservations may leave gaps; unpersisted reservations are not guaranteed across restart. A backend write followed by an error can still leave partial persistence, and failed node compensation remains an explicit reconciliation error. This is not a CAS/ACID guarantee or evidence of remote cleanup.
- No SDK/core files, credentials or existing experiment records are patched by these capabilities.

## Offline regression

Use Node 24 with the declared dependencies available. The three new suites use fake agents, clocks, storage, Git/driver boundaries and VM hooks; they do not start experiments, query a model, use SSH/GPU, or install software.

```sh
node scripts/runtime-lifecycle-selftest.mjs
node scripts/auto-progress-selftest.mjs
node scripts/node-edit-client-selftest.mjs
node scripts/cluster-fleet-selftest.mjs
node scripts/placement-selftest.mjs
```
The existing `scripts/selftest.mjs` additionally needs a disposable committed local Git fixture named `metainfer-demo-repo` via `MIRL_DEMO_REPO` and an isolated `DSH_HOME`. Do not point tests at an active experiment repository or a live storage home. It covers service/HTTP/native-tool validation, mixed-payload rejection before model lookup, report DTO consistency, and the existing routes. Runtime tests separately cover actual watchdog/claim behavior, persistence failures, local retry/follow-up/merge/external paths, lease renewal and receipt/claim/end ordering. GUI and real remote cleanup acceptance remain distinct from these offline checks.
