# v2 发布说明（草稿）

## Round 40 — resource capability and an evidence schema the model can satisfy

- **Live evidence (resources):** `state.auto.lastPlanSkip` said
  `lead made 2 proposal(s) but created 0; first rejection: unknown resource: gpu`;
  `cycle.previousLeadFeedback.firstRejection` carried the same reason with
  `code: null`. The project has `resourcePools: {}` (CPU-only), but the lead
  wrote `needs: {"machines":1}` / `gpu` without being told which keys exist.
  After one manual step, its own analysis said “本项目资源池为空”, and the next
  pass succeeded — proof that feedback existed but the capability list did not.
- **Prompt capability:** lead, branch and advisor prompts now include a
  `# Resource capability` section built from the live project config plus
  capacity (`pools`, `free`, `held`, `maxRunningNodes`, running/free slots):
  configured keys, keys with free capacity, per-pool totals/held/free, and the
  rule that an unlisted key is rejected as `unknown resource`; with no pool the
  instruction is to omit `needs` and use the default pool. `machines` remains
  the separate 1..8 concurrency key.
- **Actionable rejection:** `normalizeNeeds` returns structured
  `code: 'resource_not_available'` for an unknown or over-pool key. The reason is
  `unknown resource: gpu (available: none; omit needs to use the default pool)`
  (or a non-empty key list). `checkProposal` propagates the code into
  `applied.rejected`, candidate decisions and `previousLeadFeedback.firstRejection`;
  the successor API raises `resource_not_available` instead of `bad_request`.
- **Live evidence (evidence):** the chief emitted
  `evidence[0].field undefined is not whitelisted` for every pointer without a
  `field`, and `"successCriteria + prompt constraints" is not whitelisted` for a
  prose description. The model was never shown the allowed values.
- **Evidence contract:** `validateEvidencePointers` now distinguishes a missing
  `field` (`evidence[0] missing field`) from an unknown value, and both errors
  include the exact allowed list and the instruction to use one of those
  literals. The chief prompt (and the branch prompt) prints
  `Allowed field values (exact): title, prompt, status, report.summary,
  report.metrics, report.hypothesis, review.verdict, git.headCommit` and asks
  for `{nodeId, field, quote}` pointers.
- **Regression:** an empty-pool project with a lead proposal `needs: ["gpu"]`
  (the compact shorthand is accepted as one unit) asserts the lead/branch/advisor
  prompt text,
  the `available: none` reason and `code='resource_not_available'`, and the next
  lead activation's feedback. Evidence probes assert
  `evidence[0] missing field` and the allowed list for an unknown field.
- **Tests:** `npm test` EXIT 0, 1076 `ok`, 0 FAIL; hierarchy round-40 probes;
  plugin-smoke 6/6.

## Round 39 — a withdrawn node keeps the decision that removed it

- **Live evidence:** `n-0010` was created by `lab-lead` at
  `1794443891015` and silently withdrawn 53 s later
  (`1794443943841`). `dag_get` returned `status: cancelled` and
  `error: ""`; `explain_node` showed
  `node/high_review_resolved actor=human actorId=session-bf3a...`
  with `causeId=high-review:n-0010:withdraw`, no `reasonCode`, rationale or
  rule name. `disputes` and `status_facts.recentFailures` were empty.
- **Root cause:** `resolveHighReview` accepted a bare internal
  `{ kind: 'system', id: '...' }` execution descriptor but
  `actorFromToolExecution` only looked at `exec.agent.session`; with no
  session it fell back to `actorForSession({})`, which labels an unregistered
  caller `human`. The decision was then persisted as
  `resolvedBy: {kind:'human', id: sessionId}` and `cancelReason` was the
  bare string `high-review veto: withdraw`.
- **Structured decision:** both `resolveHighReview` (service/tool path) and
  `applyChiefActivation` (L2 path) now build one `highReviewResolution`:
  - `decision`
  - `reasonCode` (always non-empty; defaults to `high_review_<action>`)
  - `rationale`
  - `resolvedBy` as `human:<sessionId>`, `expert:<expertId>` or
    `system:<policyName>`
  - `resolvedByActor` and, for a policy, `rule: {name, whyWithdraw, whyNotDefer}`
  The `node/high_review_resolved` event carries the same fields and the full
  `cancelReason` object.
- **Node record:** a withdrawn node now has `cancelReason` (object),
  `cancelReasonText`, `cancelledBy`, `cancelledAt`, and
  `highReview.resolvedByRef`/`reasonCode`/`rationale`/`rule`. The empty
  `error` is no longer the only explanation.
- **Read surfaces:** `dag_get` includes `cancelReason` in its default row and
  accepts `cancelReasonText`, `cancelledBy`, `cancelledAt`, `highReview`;
  `explain_node` returns the node fields plus event-level `decision`,
  `reasonCode`, `rationale`, `resolvedBy`, `rule` and `cancelReason`. The
  node inspector renders a localised “Cancellation reason” section.
- **Actor policy:** a bare `{kind:'system'}`/`{kind:'expert'}`/
  `{kind:'human'}` execution descriptor is now honored instead of being
  treated as an anonymous human session. Unknown/legacy kinds map to
  `system:<kind>:<id>`, never `human`. Host high-review policies may resolve
  with a system actor; the event actor itself is system, not human.
- **Rule explanation:** when `ruleName`/`rule`/`policy` is supplied (or a
  system actor has a preset), the event records the rule name. A withdraw
  records `whyWithdraw` and `whyNotDefer`; the default explains that withdraw
  removes the node from the runnable DAG while defer only changes priority.
- **Regression:** a system-policy withdrawal asserts
  `resolvedBy==='system:candidate_overlap_guard'`, a non-empty `reasonCode`,
  the named rule, `whyWithdraw`/`whyNotDefer`, and byte-identical
  `cancelReason` on the event, node and `explain_node`. A human withdrawal
  asserts `human:s-human`. The two provenance labels cannot be confused.
- **Tests:** `npm test` EXIT 0, 1070 `ok`, 0 FAIL; hierarchy-selftest includes
  both Round 39 probes; plugin-smoke 6/6.

## Round 38 — role failures keep their cause, code, and retryability

- **Live proof:** lead `run-15781108` ended in 65.2 s with
  `stopReason=error`, no tool calls, and only
  `error: "lead stopped: error (timeoutMs=180000, source=config.advisor.timeoutSeconds)"`.
  The same cycle had successful lead `run-7939be84` through the same code path.
  The transport-style failures (`os error 110`, `Reconnecting... stream
  disconnected`) were being flattened by the subagent seam, so diagnosis
  required guessing from duration and tool-call count.
- **Structured failure record:** `runRole` now captures the child
  `agent/error` event and falls back to the durable `turn/end` error. Failure
  records keep the readable `error` and add:
  - `errorCode`
  - `retryable: boolean`
  - `errorDetail: { name, message, stack, stopReason, hasPartialOutput,
    partialOutputChars, ... }`
  - for stream failures: `disconnectReason`
  - for JSON parse failures: `parseError` and `rawTail` (last 200 characters)
  - `partialOutput` (bounded) on the run record itself
- **Error codes:**

  | Code | Retryable | Meaning |
  |---|---|---|
  | `stream_disconnected` | true | transport/stream reset (`os error 110`, `Reconnecting`, ECONNRESET, ...) |
  | `run_timeout` | true | role wall-clock timeout |
  | `provider_rate_limited` | true | 429/rate limit/overloaded |
  | `provider_unavailable` | true | 5xx/upstream unavailable |
  | `invalid_json` | false | malformed structured output; carries parser message + raw tail |
  | `invalid_schema` | false | schema/structured-output validation failure |
  | `permission_denied` | false | auth/permission/EACCES/401/403 |
  | `query_budget_exceeded` | false | role exceeded its read-call budget |
  | `model_refused` | false | provider refusal stop reason |
  | `run_cancelled` | false | cancelled/aborted |
  | `missing_structured_output` | false | schema-backed run ended without a capture |
  | `subagent_error` | false | other child/agent failure |
  | `unknown_role_error` | false | no classified cause |

- **Shared observability:** `cycle.errors[]` uses the same
  `formatRoleFailure` string that `state.auto.lastLeadError` reads, and
  `cycle.leadFailure` carries `{runId,error,errorCode,errorDetail,retryable}`.
  Auto also exposes `lastLeadErrorCode`, `lastLeadErrorDetail`, and
  `lastLeadRetryable`; run rows include `errorCode`, `errorDetail`,
  `retryable`, and `partialOutput`. The project status driver exposes the same
  fields. Failure diagnostics are never added to the lead prompt.
- **Retry policy:** auto's lead backoff now checks `retryable`. Transient
  failures keep the 60/120/240 s exponential backoff capped at 300 s;
  non-retryable failures do not enter retry backoff (the existing error breaker
  still stops repeated failures). Legacy cycles without a run record infer
  retryability from the error text.
- **Regression:** a fake lead activation rejects with
  `new Error('stream disconnected before completion')`, and another fake
  returns malformed JSON. The tests assert `stream_disconnected`/retryable
  true with the original message, and `invalid_json`/retryable false with
  `parseError` plus a ≤200-character raw tail. A third fixture models the real
  `stopReason=error + diagnostic + partial output` path. Prompt captures prove
  none of these details enter the lead input.
- **Tests:** `npm test` EXIT 0, 1068 `ok`, 0 FAIL;
  `hierarchy-selftest` includes the three Round 38 probes;
  `auto-wip-selftest` verifies retryable and non-retryable backoff paths;
  `plugin-smoke` 6/6.
- **Boundary:** live `run-15781108` was read only; Host 3080 was not restarted.

## Round 37 — lead prompts carry the timebox range and the previous rejection

- **Live proof:** project `prj-e1cbb8e1` has `nodeTimeoutMinutes: 1` and
  `maxNodeTimeoutMinutes: 2`, but lead `run-520f85d8` proposed
  `timeboxMinutes: 10` (two proposals) and `15` (one proposal). Cycle
  `cyc-31e33941` rejected all three with the old text
  `timeboxMinutes must be 1..2`, so the graph never grew. The lead had no way
  to know the bound: the prompt contained no timebox rule.
- **Prompt bounds:** `nodeTimeboxBounds(project)` resolves the same 1..max
  range used by `checkProposal`, with documented defaults (node 10 minutes,
  max 240 minutes; the 1-minute project resolves to `{min:1,max:2,default:1}`).
  Lead and branch prompts now say:

  ```text
  Timebox limit: timeboxMinutes must be an integer in 1..2 (this project's
  default node budget is 1 minute); proposals outside this range are rejected.
  ```

  Branch candidates that suggest a timebox receive the same range. The legacy
  advisor prompt also carries the limit.
- **Actionable rejection:** `checkProposal` now reports the received value:
  `timeboxMinutes must be 1..2 (got 10)`. API successor/merge validation uses
  the same message, and `invalid_timebox` is a named candidate decision.
- **Next-round feedback:** the cycle trace already stores the lead's rejected
  proposals. `mostRecentLeadFeedback` compacts the most recent rejection cycle
  into `cycle.previousLeadFeedback`, and the next lead prompt includes:

  ```text
  # Previous lead rejection feedback
  {"cycleId":"...","proposalCount":3,"rejectedCount":3,
   "firstRejection":{"title":"...","reason":"timeboxMinutes must be 1..2 (got 10)",...},
   "rejected":[... up to 3 ...]}
  ```

  `cycle.leadInputStats.previousRejectionCount` and
  `cycle.previousLeadFeedback` make this auditable. This is generic: no project
  id is referenced by the code.
- **Regression:** a synthetic project with the live budget (`1`/`2`) and a fake
  lead always returning `timeboxMinutes: 10` proves:
  1. the proposal is rejected with `(got 10)`, and `cycle.candidates.skipReason`
     carries it;
  2. the next lead prompt contains `# Previous lead rejection feedback`,
     `rejectedCount:1` and the same `got 10` reason;
  3. both lead and branch prompts contain the resolved `1..2` range and the
     `default node budget is 1 minute` sentence.
- **Tests:** `npm test` EXIT 0, 1063 `ok`, 0 FAIL; `stage5-selftest` verifies
  the bounds defaults; `hierarchy-selftest` has the Round 37 regression;
  `plugin-smoke` 6/6.
- **Boundary:** live project was read only; Host 3080 was not restarted. The
  next reloaded Host will prompt the lead with the project's actual budget.

## Round 36 — a failed replacement is retryable, with a capped chain and structural blocks

- **Live blocker:** cycle `cyc-fdd1bcaa` returned two proposals and both were
  rejected as `replacement for n-0006 already exists as n-0010` and
  `replacement for n-0008 already exists as n-0011`. Both `n-0010` and `n-0011`
  are themselves **failed** replacements, so the guard was treating a dead
  retry as a live successor. The same candidate stayed pending, consumed a lead
  slot every cycle, and exhausted the idle budget on a duplicate that could
  never succeed.
- **Chain-aware replacement:** the guard now walks `replacesNodeId` from the
  failed source through its replacement history. A failed/cancelled terminal
  replacement permits one more replacement; the new node's `replacesNodeId`
  points at that terminal (for example `A(failed) -> B(failed) -> C`, C points
  at B). A live/successful replacement still blocks. The chain is capped at
  three attempts; a fourth gets the named reason
  `replacement_chain_exhausted` and names the whole chain.
- **No self-poisoning:** a structural rejection
  (`parent_already_has_successor` / `replacement_chain_exhausted`) now persists
  `project.candidateBlocks[candidateId] = {code, reason, structureKey, at,
  cycleId}`. The queue leaves that candidate out of `pending` while the
  parent/source/replacement fingerprint is unchanged. The fingerprint includes
  the chain and sibling statuses, so a real DAG change (for example a live
  replacement failing) lets the scope be reconsidered instead of being blocked
  forever.
- **Named no-progress:** `cycle.candidates.blocked` / `blockedReason` are
  recorded, `candidateSkipReason` returns
  `all branch-report candidates structurally blocked: <code>; <chain reason>`,
  and auto's `blockedCandidateCount` still gives a fully blocked queue one
  explanatory cycle. `lastPlanSkip` and the eventual `noProgress` pause carry
  the chain rather than repeating `already exists`.
- **Probe:** a production-shaped chain probe produced:

  ```text
  step1 created: n-0004 (parent=n-0001, replacesNodeId=n-0003, planned)
  step2 rejected: replacement_chain_exhausted
                   replacement chain for n-0002 already reached live node
                   n-0004 (n-0002 -> n-0003 -> n-0004); no further attempt
  step3: leadRunId=null, blocked=1,
         skipReason="all branch-report candidates structurally blocked: ..."
  auto: pauseReason=noProgress, idleStreak=1,
        lastPlanSkip="... n-0002 -> n-0003 -> n-0004; no further attempt"
  ```

- **Tests:** `npm test` EXIT 0, 1058 `ok`, 0 FAIL; `hierarchy-selftest`
  includes the A -> B(failed) -> C / fourth-attempt / fully-blocked queue
  regression; `auto-wip-selftest` is 15/15 with a blocked-queue `noProgress`
  probe.
- **Boundary:** live project `prj-421b80bf` was read only. No live Host
  restart or project mutation was performed; the live auto remains paused and
  the next cycle on a reloaded Host will use this code.

## Round 35 — configured role timeouts, a bounded lead input, and lead-retry backoff

- **Timeout root cause:** hierarchy L0/L1/L2 passed fixed `ROLE_BUDGETS`
  values into `runRole` (`branch=60s`, `lead=90s`, `chief=180s`). Only the old
  legacy advisor path consulted `config.advisor.timeoutSeconds`, so the live
  project's configured `300` never reached the lead. The stored failed run
  `run-3e399be0` proves it: `timeoutMs=90000`, error
  `lead run exceeded 90s`.
- **Resolved budgets:** `roleTimeoutMs(project, role)` now reads
  `config.advisor.timeoutSeconds` for **branch, lead and advisor**, bounded
  30..1800 s, and falls back to documented role defaults when absent:
  branch 60 s, lead 90 s, advisor 240 s. Chief stays at its separate 180 s
  exception-window default. Prompts name the resolved seconds, run records
  carry `timeoutMs` and `timeoutSource`, and timeout errors state both:
  `lead run exceeded 300s (role=lead, timeoutMs=300000, source=config.advisor.timeoutSeconds)`.
- **Lead input budget:** the lead prompt now shows at most 8 pending candidates
  by default (project-tunable `advisor.maxLeadCandidates`, capped at 24), with
  failed-source retries first, then priority, non-low-confidence, recency and
  stable candidate id. Candidates whose branch/source/kind was already consumed
  are omitted. Candidate detail is capped at 220 characters. Branch reports
  keep at most 6 verified/ruled-out rows, 4 evidence pointers, and 240
  characters per quote (the raw `output.candidates` array is omitted because
  the queue is authoritative).
- **Measured live payload:** the previous stored lead run `run-dee7558c`
  received 20,582 bytes; the raw branch compression input measured 117,292 bytes
  (the order of magnitude behind the ~107 KB report).
  The same 18-pending live shape now builds a 11,032-byte lead prompt
  (`inputBytesBefore=20,517`), with 8 shown / 10 omitted; candidate bytes fall
  from 8,059 to 3,692 and branch-report bytes from 11,129 to 6,011. A live-copy
  probe that included the new n-0014 branch event measured 11,379 bytes before
  and 5,333 bytes after compaction.
- **Per-cycle reporting:** `cycle.leadInputBytes`, `cycle.leadInputStats` and
  `cycle.lead.inputBytes/inputBytesBefore/candidateShown/candidateOmitted/
  dedupedConsumedKinds/branchReportBytes*` record what the model actually
  received. `run.inputStats` carries the same figures.
- **Backoff:** a failed lead sets `leadFailureStreak`, `leadBackoffUntil` and
  `lastLeadError`. Retry delays are 60 s, 120 s, 240 s, capped at 300 s; ticks
  inside the window do not start another lead or add an error. The counters
  reset on a successful/non-lead cycle and on `auto_start`/`auto_resume`.
  `auto_status` exposes all four fields.
- **Tests:** configured 300 s is honoured by branch/lead/advisor and by a lead
  run record; unconfigured projects still resolve 60/90/240/180; the prompt cap
  and before/after byte accounting use a synthetic 24-candidate/50 KB-evidence
  payload; a never-resolving lead probe produces the accurate role/value/source
  error; auto backoff proves a second tick does not re-run the lead.
- **Boundary:** live 3080 still runs the previous build. No restart or live
  project mutation was performed during this round.

## Round 34 — failed-source retries are proposable and every pending candidate gets a named decision

- **Blocker:** live cycle `cyc-e7938b31` reused three BranchReports, but its lead
  run `run-a82000cd` returned two valid proposals and both were rejected by
  `checkProposal` because the completed parents `n-0004` and `n-0002` already
  had *failed* children (`n-0005`, `n-0006`). The cycle saw
  `createdNodeIds=[]` and emitted only `lead produced no proposal for 10 pending
  branch-report candidate(s)`. The lead had in fact proposed a retry and a
  decoupled replacement; the failed child was being treated as a live
  successor.
- **Retry mapping:** `checkProposal(project, proposal, nodes, candidate)` now
  recognises a candidate whose source is `failed`/`cancelled` and whose source
  parent is the proposed parent. It allows exactly one replacement sibling under
  the completed parent, even though the failed child remains in the DAG, and
  records `node.replacesNodeId = source.id`. It rejects a second replacement or
  a parent with a live successor. When the lead omits scope fields, the Host
  inherits the failed source's prompt, needs, timebox and execution profile.
- **Why the live proposals failed:** the lead's own analysis correctly chose
  `parentId:n-0004` for the `n-0005` retry and `parentId:n-0002` for the
  `n-0006` decoupled sweep. Both were rejected with
  `parent n-0004 already has a successor; propose from a leaf` /
  `parent n-0002 already has a successor; propose from a leaf`. The code changed
  in this round turns those into materialized replacements:
  `n-0009` (`replacesNodeId=n-0005`, `{gpu:1}`, 90m) and `n-0010`
  (`replacesNodeId=n-0006`, `{gpu:2}`, 120m).
- **Silent lead eliminated:** the lead schema now accepts
  `candidateDecisions: [{candidateId, decision, reason}]`; the prompt requires
  one entry for every candidate the lead does not materialize. The cycle
  persists `cycle.lead` with the actual `analysis`, `note`,
  `proposalCount/considered`, per-proposal status, Host rejections,
  `candidateDecisions`, and `decisionCounts`. The run record gets the same
  decisions plus a compact `outcome`.
- **Named per-candidate reasons:** every pending candidate has
  `reasonCode = skipReason` in `cycle.lead.decisions`:
  `created`, `blocked_by_failed_source`, `needs_human_scope_decision`,
  `duplicate_of_consumed`, `low_confidence_only`, `branch_already_advanced`,
  `deferred_by_pass_limit`, `proposal_rejected`, or `lead_declined`. A
  no-create cycle now says, for example,
  `lead returned 0 proposals for 10 pending candidate(s); low_confidence_only=4,
  blocked_by_failed_source=2, ...`, or
  `lead made 2 proposal(s) but created 0; first rejection: ...`.
- **Regression:** a project with 10 pending candidates, including two retries of
  transport-timeout nodes, creates both retry replacements under the completed
  parents and keeps `replacesNodeId` plus the source needs. A second project
  returns zero proposals: it creates nothing but records all 10 named decisions
  and the lead's intentional `analysis`, with no generic message.
- **Live simulation:** replaying the exact stored `run-a82000cd` output against
  a copy of `prj-421b80bf` now creates `n-0009` and `n-0010`, records
  `duplicate_of_consumed` for the five n-0003 candidates,
  `branch_already_advanced` for the n-0001 follow-up, and
  `low_confidence_only` for the two low-confidence n-0002 rows. No model call or
  Host restart was performed.
- **Gates:** `npm test` EXIT 0 (1047 ok / 0 FAIL); hierarchy-selftest all checks
  passed; auto-wip 12/12; plugin smoke 6/6.
- **Boundary:** live 3080 still runs the previous build; restart/reload is
  required before the paused project can create these replacements.

## Round 33 — the optimization loop plans from unconsumed BranchReport candidates

- **Blocker:** `lastPlanSkip="no completed/failed branch event"` paused
  `prj-421b80bf` after three idle cycles even though its stored BranchReports
  still contained explicit optimization candidates. A loop that only reacts to
  a new completed/failed branch event can optimize exactly once and then parks;
  this contradicts the owner requirement “不断提高，没有上限”.
- **Trigger:** `runHierarchyPass` now plans when either a fresh branch event
  exists **or** `buildBranchCandidateQueue` finds an unconsumed candidate in a
  stored BranchReport. With no fresh event it reuses the stored reports for L1
  instead of skipping L1. `cycle.hierarchy.planTrigger` records
  `branch_event` / `candidate_queue` / `noop`.
- **Identity, not text:** `host/experts/candidates.js` derives a deterministic
  `candidateId` from branch id, source node id (`nodeId`/`targetNodeId`/
  `sourceNodeId`/`parentId`), kind, priority, action and the candidate ordinal.
  Titles/rationale are prompt data only; editing prose does not make a candidate
  look new. All successful branch reports are merged, so an older report's
  candidate is not lost when the same branch reports again.
- **Consumption:** every created child/proposal carries `candidateId`; the same
  Host commit appends `{candidateId, branchId, sourceNodeId, kind, nodeId,
  runId, consumedAt}` to `project.candidateConsumptions` and emits
  `review/candidate_consumed`. The lead is asked to echo the candidate id; if it
  omits it, the Host binds by node lineage (source node is the parent/ancestor),
  then by branch. The 5,000-record cap keeps this durable without text matching.
- **Explicit reasons:** the queue reports considered/consumed/pending/skipped,
  `lowConfidence`, report/failure counts and a named `skipReason`:
  `all branch-report candidates consumed`,
  `low-confidence candidates only (N); lead produced no proposal`,
  `blocked by failed branch report`, `blocked by failed lead run; N pending`,
  `branch reports contain no candidates`, or
  `no completed/failed branch event and no branch report`. Auto uses that reason
  for `lastPlanSkip` before falling back to its old skip rows.
- **Auto trigger:** `orchestrator.pendingCandidateCount()` lets `auto` plan on a
  pending candidate even when no actionable leaf, no low-water trigger and the
  queue is not empty. It still respects `maxPlannedInFlight`.
- **Regression:** an all-completed project with one stored BranchReport holding
  four unconsumed candidates creates four lead children in one cycle and records
  four `candidateConsumptions`; the next cycle runs no lead and records
  `all branch-report candidates consumed`, with `pending:0`. Candidate identity
  is stable across prose edits; low-confidence and failed-report reasons are
  asserted separately.
- **Live read-only evidence:** the stored `prj-421b80bf` data now yields 11
  pending candidates (including the n-0003 items: Q reuse, KV double-buffered
  prefetch, output write bandwidth, per-CU residency, and the Triton L2
  relative-performance comparison), 3 successful reports and 3 failed branch
  runs. No Host was restarted and no model call was made.
- **Gates:** `npm test` EXIT 0 (1041 ok / 0 FAIL); hierarchy-selftest all checks
  passed; auto-wip 12/12; plugin smoke 6/6.
- **Boundary:** the live 3080 Host still runs the previous build. A restart (or
  reload of the plugin bundle) is required before the live paused project can
  use the candidate trigger.

## Round 32 hotfix — role presets are real and boot-resolved

- **Blocker:** phase 2 cycles died with
  `branch[n-0001]: Unknown agent preset: lab-branch`. `ROLE_PRESETS` named
  `lab-branch`/`lab-lead`/`lab-chief`, and `host/experts/registry.js` described
  the experts, but no DSH preset rows existed for those three ids. Only the
  descriptor was present.
- **Fix:** `presets.patch.yml` now registers `preset-lab-branch`,
  `preset-lab-lead`, and `preset-lab-chief` (persona + structured output).
  `host/role-presets.js` centralizes `ROLE_PRESETS` and `REQUIRED_PRESETS`;
  `index.js:apply()` calls `assertRolePresets(ctx.agentPresets)` after the
  schema gate. A missing/broken preset throws `RolePresetError` with
  `ROLE_PRESET_NOT_FOUND` and the available ids at boot.
- **Audit:** all twelve ids passed a real spare-Host resolution: advisor,
  scheduler, branch, lead, chief, worker, merge, gc, chat, intake, controller,
  dashboard.
- **Regression:** `hierarchy-selftest` rejects undeclared preset ids in
  `resolve`, `mount`, and `startActivation`; a phase-2 three-branch cycle records
  `branchReports:["branch-1","branch-2","branch-3"]`, a lead run, and a created
  proposal, with no `Unknown agent preset`.
- **Gates:** `npm test` EXIT 0 (1032 ok / 0 FAIL); plugin smoke 6/6; spare Host
  3081 health 200. Live 3080 was not restarted.
- **Boundary:** no external model call; Host restart required to load the new
  preset rows.

## Round 31 hotfix — hierarchy schema + failed-node reason

- **Blocker:** `BranchReport` failed before every L0 model call with
  `unsupported JSON schema: schema.properties._truncated.type must be a single
  type string (type arrays are not supported)`. `BRANCH_REPORT_SCHEMA` no longer
  declares the host-only `_truncated` field; the deterministic branch report
  still carries it in the prompt. All three L0 runs failed, `branchReports` was
  empty, and L1 skipped with `no successful branch report`.
- **Audit:** `host/schema-check.js` mirrors the DSH structured-output subset;
  `host/model-schemas.js` registers advisor/scheduler/branch/lead/chief/worker/
  merge/gc/dashboard schemas. `index.js:apply()` validates the whole registry at
  boot, and the same guard runs immediately before each activation. Merge is
  text-only (no `outputSchema`). A one-off audit against the actual Host
  `assertObjectJsonSchema` returned provider-ok for all nine schemas.
- **Regression:** `hierarchy-selftest` runs a real production cycle over three
  completed branches and records
  `branchReports:["branch-1","branch-2","branch-3"]`, `leadRunId`, and a created
  lead child; no `lead` skip and no branch/lead schema error.
- **Failed nodes:** `host/failure.js` records `{message, code?, stage, role}` and
  `buildBranchReport` falls back through `error` object/string,
  `executionRun.error`, attempt errors, and termination. Live `n-0005`/`n-0006`
  now produce non-empty `ruledOut[].reason` instead of an empty string.
- **Gates:** `npm test` EXIT 0 (1026 ok / 0 FAIL); hierarchy passes; spare Host
  3081 with real profile storage booted and returned health 200 (stopped after
  probe; live 3080 was not restarted).
- **Boundary:** no real model call; production orchestrator test double enforces
  the schema guard. No independent ledger movement claimed.

## Round 29/30 hotfix — storage restart + reachable migration/auto

- **Storage restart fixed:** the plugin declared `actorKeys` (uppercase K), which
  the DSH JSON storage backend rejects; opening the existing
  `metainfer_research_lab_v2` unit failed with
  `StorageError: invalid table name 'actorKeys'` and every plugin route was 404.
  `host/store.js` now derives declaration and runtime handles from
  `DOMAIN_TABLE_NAMES`, validates every name against `STORAGE_NAME_RE` at module
  load, and uses `actor_keys`. Forward addition only: an old unit without
  `actor_keys/` opens empty and the first actor-key put materializes it; no
  record rewrite or fresh unit is required.
- **Startup regression:** `plugin-smoke` now boots the real `index.js` twice on an
  existing v2 fixture without `actor_keys/`, materializes the table, and reads
  the key back after restart (6/6). The live spare Host on 3081 with the real
  profile returned `storage:"ready"` and the plugin migration route; it was
  stopped after probing and the live 3080 process was not restarted.
- **Migration now reachable:** `POST /migration/advance` is an operator-token
  route in `ROUTE_POLICY` (49 pairs), and `advance_migration` is an agent-tool
  action with `phase`/`parity`/`expertsMode`/`contestMode`/`dispatchStrategy`.
  Both call `advanceMigration` and return the same shape. Phase 2 without
  `parity.ok===true` is refused; phase 2 from `legacy-cycle` selects `hierarchy`;
  `hierarchy-selftest` runs the real orchestrator after the HTTP advance and
  observes the L0/L1 pass. Expert presets are forbidden.
- **Empty-queue auto fixed:** no more pre-cycle `pause('idle')`. An empty or
  all-completed legacy DAG gets a planning cycle; `idleStreak` advances only
  after that cycle, `lastPlanSkip` carries the advisor reason (or `noProposal`),
  and the breaker pauses at `idleCycleLimit` with `noProgress`. Auto suite 10/10.
- **Gates:** `npm test` EXIT 0 (1013 ok / 0 FAIL); route 49; plugin 6/6.
- **Boundary:** no real provider call, no independent ledger movement, and no
  claim that the old live process already serves the new route. A Host
  restart/reload is required to load the code; persisted `pauseReason:'idle'`
  needs one explicit `auto_start`.

## Round 28 — wiring and real-browser close

- **发布：SHIP（带 Host 重启边界）。** §55：**166 PASS / 0 FAIL / 8 N/A**；8 个 owner-override 行
  B11/B14/B16/Q8/5.4/C8/C14/5.3.10 全部经生产入口关闭，5.1.1/5.1.3 随之关闭。
- B11：`orchestrator.step` 真实激活 `lab-branch` → `lab-lead` → `lab-chief`；分支事件键去重，
  L0/L1/L2 预算 2/4/8 queries、60/90/180s 被执行。
- B14：`runCycle` 首行调用 `sweepDueHighReviews`；过窗节点保留为 `unreviewed`。
- B16：agent tool 暴露 `resident_open/call/close`；15 分钟 TTL、全局 cap 8。
- Q8/5.4/5.3.10：branch 输入改为原始子树；大分支 ≥3x，输入 <4KB 的极小分支显式 `smallBranch` 且 ≤20KB。
- C8：vote weight 读 `lab-lead` descriptor budget。
- C14：新增 `project.migration` reducer；`project.update` 改 migration 直接 `migration_gate_required`。
- 真实浏览器：项目菜单在打开 push/cluster 前关闭（实测 menu=0）；replay Escape 关闭；空仪表盘
  有居中空态卡；trajectory 20s 超时 + elapsed/Retry + `limit=50`（`fix-01..06` 截图）。
- **边界**：未重启 Host。`client.js` 修复当前 Host 已加载；trajectory 资产在 Host 注册时缓存，
  本轮用 Playwright route fulfillment 验证，生产需一次 Host 重启才能刷新。未调用真实 provider，
  DSH 子激活仍只返回一次 structured result。

## C14 — 迁移边界（round 27 owner override）

- **C14（round 28 已关闭）：** `advanceMigration` 逐阶段 + parity gate；`project.update` 改
  `config.migration` 现在返回 `migration_gate_required`，只有 `project.migration` reducer 能写。
- 三个 phase 的取值：dispatch `legacy-llm` → `shadow-deterministic` →
  `deterministic`；experts `legacy-cycle` → `hierarchy` → `resident`；contest
  `off` → `shadow` → `consensus`。默认仍停留 phase 1，现有项目不会被静默迁移。
- **仍然没有重启 Host**，所以本轮证据只覆盖配置、开关和 S14 parity gate；不能写成
  “生产零停机迁移已经演练”。2026-11-10 的停机重启是历史事实，不再作为 C14 的验收
  口径。

## Dispute HTTP 路由

- `GET /disputes` 与 `GET /disputes/classes` 是只读；不检查 token，也不铸造 human actor。
- `POST /disputes`、`POST /disputes/resolve`、`POST /disputes/reopen`、`POST /arbitrate` 需要 Host 注入的签名 operator token；无 token 一律 `actor_required`，不会把“缺凭据”当成 operator。
- `POST /disputes/reopen` 还要求 reopener 与 resolver 不同（system timeout 例外）；同一 resolver 不能重开自己的裁决。
- `POST /disputes/sweep` 是 scheduler-only：HTTP 固定返回 `forbidden_action`，不接受客户端 `now`。超时扫描只使用 Host 时间。

## Operator 控制面

- Dispute decisions from the browser use a Host-issued, HMAC-signed operator token injected into the owner page; the token is sent only in the `x-metainfer-operator` header. A JSON body cannot authenticate itself, and a page without the token does not render arbitration buttons.
- The token is valid for one Host lifetime; restart the page after a Host restart.
- All 14 mutating operator routes (including `POST /commands`, `/rotations`, `/retrospective`, `/dashboard*`, and `/preemption/appeal`) require that token; `GET /dashboard` is gated too because it can repair an interrupted chat write. JSON `actor`/`actorKey`/`actorId` fields are stripped, and `deleteProject`/`cancelNode` still run the claim/appeal/human gate after token verification.

## 范围

- 本说明记录 C14 的运维边界；residual 行的分类、状态和 174 行账本见 [`OPEN-QUESTIONS.md`](OPEN-QUESTIONS.md) 与 [`ACCEPTANCE-LEDGER.md`](ACCEPTANCE-LEDGER.md)。**round 28 §55：166 PASS / 0 FAIL / 8 N/A；发布：SHIP（Host 重启边界见上）。** 历史独立复核 §54.6（156/8/10）保留，不擦除。**U2 已独立 PASS；B22 已在 round 21 独立 PASS（§46.7）：48 个 method+path 全量 policy、14 个 token 路由 absent/forged 拒绝、body actor 递归剥离、`/commands` 破坏性 gate 保持。归因观察（非阻断）：部分非破坏性写使用 inline operator actorKey，不改变 token gate 结论，详见 §46.7.5。
- **§54.6 的独立证据**：B11 production step 只跑 scheduler/advisor，无 L0/L1；B14 普通 step 不清过期 pending；B16 resident 无 route/action/orchestrator call site；Q8/5.4 生产 branch 压缩比 0.552；C8 超 descriptor budget 仍计 1 票；C14 `project.update` 可绕过 parity。
- **§53 的三条独立探针**：O3 的 held 15ms、promoted 3ms，`queueWait.count=2`，promotion 的 `plannedAt/runnableAt` 在 store/projection/reload/redo 后一致；B13 的 `AGENT_TOOL_PARAMETERS` 含 `escalate` 和六码 `reasonCode` enum，AJV 拒绝未知值，真实 `tool.execute()` 落 1 行且缺失/非法 reasonCode 被服务拒绝；5.3.9 的 `freeSlots=0, planned=3` 由 helper、evaluator 和生产 observer 都在 +5min 触发 `queue_overload`。别名 `cycle`/`cycles`、`byRole`/`roles`、`advisor`/`advisorInput` 仍是同一对象引用，`advisorInput.utilization` 回退到 `p50Utilization`。
- **Standing exclusions（必须随发布说明携带）**：真实浏览器已可用并完成 35 面板 sweep + 定向修复验证（Chromium 158）；trajectory 新资产仍受 Host 注册时缓存限制。未调用外部模型，**真实 provider** 未验证；未重启 Host 重放 session 身份，**session-id rehydration** 未验证。`b27-restart` 只覆盖现有 restart 断言。
- B22 的 operator 路由 **凭据/破坏性 gate** 已完整；但 §46.7.5 记录的 inline actorKey 归因差异仍应作为后续代码质量项，不能写成“所有写路径都保留 token actorKey”。
