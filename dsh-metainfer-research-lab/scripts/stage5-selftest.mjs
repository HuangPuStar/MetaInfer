/**
 * B22/B23 + 5.3.13/5.3.14: first-class disputes with timeout defaults, eight-class
 * arbiter mapping, prediction errors, rotation, observer long-poll and the
 * limited-write arbitration surface.
 */
import { openStore } from '../host/store.js';
import { createKernel } from '../host/kernel/instance.js';
import { createLabService } from '../host/lab-service.js';
import { authorizeAction } from '../host/kernel/policy.js';
import { registerHttpRoutes } from '../host/http.js';
import { createIntent } from '../host/kernel/intent.js';
import { DISPUTE_CLASS_MAP, DISPUTE_TIMEOUT_MS } from '../host/kernel/disputes.js';
import { applyPredictionToNode, evaluateExpected, normalizeExpected } from '../host/kernel/prediction.js';
import { rotationPlan } from '../host/experts/rotation.js';
import { advisorTimeoutMs, DEFAULT_ADVISOR_TIMEOUT_SECONDS, roleTimeoutMs, ROLE_TIMEOUT_DEFAULTS, leadPromptParts } from '../host/orchestrator.js';
import { memoryDomain, storeContext } from './lib/memory-domain.mjs';

let failed = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`ok   ${name}`);
  else { failed += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const domain = memoryDomain();
const store = await openStore(storeContext(domain));
const kernel = createKernel({ store });
const projectId = 'stage5-p';
await store.saveProject({ id: projectId, revision: 0, counters: { eventSeq: 0 }, config: { scheduling: { rotationDays: 14 } }, createdAt: 0, updatedAt: 0 });
kernel.load(projectId);
await kernel.executor.commit(projectId, {
  actor: { kind: 'human', id: 'test' },
  mutations: [
    { op: 'node.create', node: { id: 'root', title: 'root', status: 'completed', report: { metrics: [{ name: 'score', value: 1 }] }, timestamps: { createdAt: 1, completedAt: 2 } } },
    { op: 'node.create', node: { id: 'branch-a', title: 'branch a', parentId: 'root', status: 'completed', createdBy: 'expert-a', expected: { metric: 'score', direction: 'up', magnitude: 1 }, expectedBaseline: 1, report: { metrics: [{ name: 'score', value: 1.1 }] }, timestamps: { createdAt: 3, completedAt: 4 } } },
    { op: 'node.create', node: { id: 'branch-b', title: 'branch b', parentId: 'root', status: 'completed', createdBy: 'expert-b', expected: { metric: 'score', direction: 'up', magnitude: 1 }, expectedBaseline: 1, report: { metrics: [{ name: 'score', value: 0.1 }] }, timestamps: { createdAt: 5, completedAt: 6 } } },
  ],
});
let autoState = { status: 'off', pauseReason: null };
const auto = { statusOf: () => autoState };
const service = createLabService({
  ctx: { effect: () => {}, get: () => null, logger: { info() {}, warn() {} } },
  store, kernel, git: null, runtime: null, transcript: null, orchestrator: null, auto, cluster: null, clusterAdmin: null,
});
await kernel.executor.commit(projectId, {
  actor: { kind: 'system', id: 'test' },
  mutations: [
    { op: 'node.update', nodeId: 'branch-a', set: { git: { headCommit: 'a'.repeat(40) } } },
    { op: 'node.update', nodeId: 'branch-b', set: { git: { headCommit: 'b'.repeat(40) } } },
  ],
});
const joins = [];
const joinService = createLabService({
  ctx: { effect: () => {}, get: () => null, logger: { info() {}, warn() {} } },
  store, kernel, git: {}, runtime: null, transcript: null,
  orchestrator: { createMergeNode: async (id, input) => { joins.push({ id, input }); await kernel.executor.commit(id, { actor: { kind: 'system', id: 'test' }, mutations: [{ op: 'node.create', node: { id: 'merge-auto', title: 'auto join', kind: 'merge', status: 'planned', parentIds: input.parentIds, parentId: input.parentIds[0], timestamps: { createdAt: Date.now() } } }] }); return { ok: true, node: { id: 'merge-auto' } }; } },
  auto, cluster: null, clusterAdmin: null,
});
const joined = await joinService.autoJoinCompleted(projectId);
check('5.3.7: once both committed children complete, the Host creates the join without a human finish_merge call',
  joined.ok === true && joined.created[0] === 'merge-auto' && joins.length === 1
  && JSON.stringify(joins[0].input.parentIds) === JSON.stringify(['branch-a', 'branch-b']),
  JSON.stringify({ joined, joins }));
const joinedAgain = await joinService.autoJoinCompleted(projectId);
check('5.3.7: the existing exact-parent merge suppresses a duplicate join',
  joinedAgain.created.length === 0 && joins.length === 1, JSON.stringify(joinedAgain));

const human = { agent: { session: { id: 'b22-human' } } };
const escalationIntent = await service.submitIntent(projectId, {
  kind: 'escalate',
  claim: { action: 'escalate', reasonCode: 'conflict', reason: 'the two variants disagree' },
}, human);
check('B13: a valid escalate intent is written with its checklist reasonCode',
  escalationIntent.ok === true && escalationIntent.intent.kind === 'escalate'
  && escalationIntent.intent.claim.reasonCode === 'conflict'
  && escalationIntent.intent.fallback?.executor === 'human',
  JSON.stringify(escalationIntent));
const missingReason = await service.submitIntent(projectId, {
  kind: 'escalate', claim: { action: 'escalate' },
}, human);
check('B13: a missing reasonCode is rejected at the submit write boundary',
  missingReason.ok === false && missingReason.error?.code === 'escalation_reason_required',
  JSON.stringify(missingReason));
const invalidReason = await service.submitIntent(projectId, {
  kind: 'escalate', claim: { action: 'escalate', reasonCode: 'stalled_node' },
}, human);
check('B13: an invalid reasonCode is rejected at the submit write boundary',
  invalidReason.ok === false && invalidReason.error?.code === 'escalation_reason_invalid',
  JSON.stringify(invalidReason));
check('B13: rejected escalate submits leave no intent rows',
  (store.getProject(projectId).intents ?? []).filter((intent) => intent.kind === 'escalate').length === 1,
  JSON.stringify((store.getProject(projectId).intents ?? []).filter((intent) => intent.kind === 'escalate')));

const secondHuman = { agent: { session: { id: 'b22-second-human' } } };
const thirdHuman = { agent: { session: { id: 'b22-third-human' } } };

check('5.3.8: the advisor budget defaults above the measured 180 s p90 and stays bounded',
  DEFAULT_ADVISOR_TIMEOUT_SECONDS === 240 && advisorTimeoutMs({}) === 240_000
  && advisorTimeoutMs({ config: { advisor: { timeoutSeconds: 5 } } }) === 30_000
  && advisorTimeoutMs({ config: { advisor: { timeoutSeconds: 99_999 } } }) === 1_800_000,
  JSON.stringify({ default: advisorTimeoutMs({}), low: advisorTimeoutMs({ config: { advisor: { timeoutSeconds: 5 } } }), high: advisorTimeoutMs({ config: { advisor: { timeoutSeconds: 99_999 } } }) }));

check('Round 35: branch/lead/advisor resolve a configured 300 s budget; an unconfigured project keeps role defaults',
  ROLE_TIMEOUT_DEFAULTS.branch === 60_000
  && ROLE_TIMEOUT_DEFAULTS.lead === 90_000
  && ROLE_TIMEOUT_DEFAULTS.advisor === 240_000
  && roleTimeoutMs({}, 'branch') === 60_000
  && roleTimeoutMs({}, 'lead') === 90_000
  && roleTimeoutMs({}, 'advisor') === 240_000
  && roleTimeoutMs({ config: { advisor: { timeoutSeconds: 300 } } }, 'branch') === 300_000
  && roleTimeoutMs({ config: { advisor: { timeoutSeconds: 300 } } }, 'lead') === 300_000
  && roleTimeoutMs({ config: { advisor: { timeoutSeconds: 300 } } }, 'advisor') === 300_000
  && roleTimeoutMs({ config: { advisor: { timeoutSeconds: 300 } } }, 'chief') === 180_000,
  JSON.stringify({ defaults: ROLE_TIMEOUT_DEFAULTS, configured: { branch: roleTimeoutMs({ config: { advisor: { timeoutSeconds: 300 } } }, 'branch'), lead: roleTimeoutMs({ config: { advisor: { timeoutSeconds: 300 } } }, 'lead'), advisor: roleTimeoutMs({ config: { advisor: { timeoutSeconds: 300 } } }, 'advisor') } }));

check('Round 35: the lead prompt is capped to 12 candidates, strips bulk evidence quotes, and reports before/after bytes',
  (() => {
    const reports = [{
      branchId: 'b', status: 'completed',
      output: {
        branchId: 'b', health: 'watch', escalate: false, reasonCodes: [],
        verified: Array.from({ length: 10 }, (_, i) => ({ nodeId: `n${i}`, kind: 'claim', confidence: 0.8, claim: `claim ${i}`, evidence: { nodeId: `n${i}`, field: 'report.summary', quote: 'q'.repeat(5000) } })),
        ruledOut: [], evidence: [{ nodeId: 'b', field: 'report.summary', quote: 'e'.repeat(5000) }], candidates: [],
      },
    }];
    const candidates = Array.from({ length: 24 }, (_, i) => ({
      candidateId: `cand:b:s${i}:candidate:${i}:0`, branchId: 'b', sourceNodeId: `s${i}`, sourceParentId: 'b',
      sourceStatus: i < 2 ? 'failed' : null, kind: 'candidate', priority: i % 2 ? 'p1' : 'p3', title: `candidate ${i}`,
      detail: 'd'.repeat(1000), reportAt: i, lowConfidence: i >= 8, needs: { gpu: 1 },
    }));
    const parts = leadPromptParts({ id: 'cap-p', config: { advisor: { timeoutSeconds: 300, maxLeadCandidates: 12 } } }, { branchCount: 1, activeBranchCount: 1, groupedTeams: [], escalations: [] }, reports, candidates);
    const consumed = leadPromptParts({ id: 'cap-p', config: { advisor: { maxLeadCandidates: 12 } }, candidateConsumptions: [{ branchId: 'b', sourceNodeId: 's0', kind: 'candidate' }] }, { branchCount: 1, activeBranchCount: 1, groupedTeams: [], escalations: [] }, reports, candidates);
    return parts.stats.candidateShown === 12 && parts.stats.candidateOmitted === 12
      && parts.stats.inputBytes < parts.stats.inputBytesBefore && parts.stats.inputBytes < 30_000
      && /finish within 300 seconds/.test(parts.text)
      && parts.stats.branchReportBytesAfter < parts.stats.branchReportBytesBefore
      && parts.stats.candidateBytesAfter < parts.stats.candidateBytesBefore
      && consumed.stats.dedupedConsumedKinds === 1 && consumed.stats.candidateShown === 12;
  })(),
  JSON.stringify((() => {
    const reports = [{ branchId: 'b', status: 'completed', output: { branchId: 'b', health: 'watch', verified: [], ruledOut: [], evidence: [{ nodeId: 'b', field: 'summary', quote: 'z'.repeat(5000) }] } }];
    const candidates = Array.from({ length: 24 }, (_, i) => ({ candidateId: `c${i}`, branchId: 'b', sourceNodeId: `s${i}`, kind: 'candidate', title: `c${i}`, detail: 'x'.repeat(1000), reportAt: i }));
    return leadPromptParts({ id: 'cap-p' }, { branchCount: 1 }, reports, candidates).stats;
  })()));

check('the eight conflict classes map to an authority, and only two ask a model',
  Object.keys(DISPUTE_CLASS_MAP).length === 8
  && Object.values(DISPUTE_CLASS_MAP).filter((row) => row.needsModel).length === 2
  && Object.values(DISPUTE_CLASS_MAP).every((row) => ['code', 'cfs', 'arbiter', 'human', 'curator'].includes(row.authority)),
  JSON.stringify(DISPUTE_CLASS_MAP));

const invited = await service.inviteExpert(projectId, { expertId: 'lab-advisor', ttlHours: 2 }, human);
check('5.3.5: an operator can invite a temporary expert with an expiry',
  invited.ok === true && invited.expert?.lifecycle?.temporary === true
  && invited.expert?.lifecycle?.expiresAt > Date.now()
  && invited.ttlHours === 2,
  JSON.stringify({ invited: invited.expert?.lifecycle, ttlHours: invited.ttlHours }));
const listedInvited = await service.listExperts(projectId);
check('5.3.5: the invited expert appears in the project roster while active',
  listedInvited.experts.some((row) => row.id === 'lab-advisor' && row.lifecycle?.temporary === true),
  JSON.stringify(listedInvited.experts.find((row) => row.id === 'lab-advisor')?.lifecycle));
const invitedRow = listedInvited.experts.find((row) => row.id === 'lab-advisor');
const q4Now = Date.now();
for (let index = 0; index < 5; index += 1) {
  await store.saveRun(projectId, {
    id: `q4-run-${index}`, projectId, role: 'advisor', preset: 'lab-advisor', expertId: 'lab-advisor',
    status: 'completed', startedAt: q4Now - (index + 1) * 60_000, endedAt: q4Now - (index + 1) * 60_000 + 30_000,
    queries: index === 0 ? 9 : 2,
    usage: { totalTokens: 10_000, queries: index === 0 ? 9 : 2 },
  });
}
const listedQ4 = await service.listExperts(projectId);
const q4Row = listedQ4.experts.find((row) => row.id === 'lab-advisor');
check('Q4: expert identity, lifecycle, performance and budget usage are one row',
  q4Row?.lifecycle?.status === 'active'
  && q4Row?.metrics && Number.isFinite(q4Row.metrics.proposals)
  && q4Row?.budget?.queriesPerRun >= 1
  && q4Row?.budgetUsage?.queryWindow?.maxPerRun === 9
  && q4Row?.budgetUsage?.queryWindow?.within === false
  && q4Row?.budgetUsage?.tokenWindow?.lastHourTokens === 50_000
  && q4Row?.budgetUsage?.tokenWindow?.within === true
  && q4Row?.budgetUsage?.wallClockWindow?.maxRunMs === 30_000
  && q4Row?.budgetUsage?.wallClockWindow?.within === true,
  JSON.stringify({ lifecycle: q4Row?.lifecycle, metrics: q4Row?.metrics, budget: q4Row?.budget, usage: q4Row?.budgetUsage }));

const projectWithExpired = store.getProject(projectId);
await kernel.executor.commit(projectId, {
  actor: { kind: 'system', id: 'test' },
  mutations: [{ op: 'project.update', set: { config: { ...projectWithExpired.config, experts: projectWithExpired.config.experts.map((row) => row.expertId === 'lab-advisor' ? { ...row, expiresAt: Date.now() - 1 } : row) } } }],
});
const listedExpired = await service.listExperts(projectId);
const expiredLifecycle = listedExpired.experts.find((row) => row.id === 'lab-advisor')?.lifecycle;
check('5.3.5: an expired invite is inactive but its lifecycle remains auditable',
  expiredLifecycle?.temporary === true && expiredLifecycle?.expired === true && expiredLifecycle?.active === false,
  JSON.stringify(expiredLifecycle));

const projectForRetention = store.getProject(projectId);
await kernel.executor.commit(projectId, {
  actor: { kind: 'system', id: 'test' },
  mutations: [{ op: 'project.update', set: {
    copilotSessions: [
      { id: 'hot-session', title: 'hot', createdAt: Date.now(), updatedAt: Date.now(), private: true },
      { id: 'cold-session', title: 'cold', createdAt: Date.now() - 10 * 86_400_000, updatedAt: Date.now() - 10 * 86_400_000, private: true },
      { id: 'prune-session', title: 'prune', createdAt: Date.now() - 200 * 86_400_000, updatedAt: Date.now() - 200 * 86_400_000, private: true },
    ],
    config: { ...projectForRetention.config, retention: { sessionDays: 90, coldAfterDays: 7, transcriptDays: 180 } },
  } }],
});
const retention = await service.retentionPlan(projectId);
check('5.4.2: retention plan classifies hot/cold/prune without deleting sessions',
  retention.ok === true && retention.destructive === false
  && retention.sessions.find((row) => row.id === 'hot-session')?.action === 'hot'
  && retention.sessions.find((row) => row.id === 'cold-session')?.action === 'cold'
  && retention.sessions.find((row) => row.id === 'prune-session')?.action === 'prune'
  && retention.summary.hot === 1 && retention.summary.cold === 1 && retention.summary.prune === 1,
  JSON.stringify({ summary: retention.summary, sessions: retention.sessions, policy: retention.policy }));

const opened = await service.openDispute(projectId, {
  type: 'resource_quantity',
  target: { nodeId: 'branch-a', action: 'resize' },
  rationale: 'two arithmetic positions',
  evidence: [{ nodeId: 'branch-a', field: 'needs.gpu' }],
}, human);
check('a first-class dispute is persisted with a deadline and keep_current default',
  opened.ok === true && opened.dispute.status === 'pending'
  && opened.dispute.defaultAction === 'keep_current'
  && opened.dispute.deadlineAt > opened.dispute.at
  && opened.dispute.authority === 'cfs',
  JSON.stringify(opened.dispute));

const noReason = await service.openDispute(projectId, { type: 'priority_inversion', target: { nodeId: 'branch-a' } }, human);
check('a human escalation without reasonCode is rejected', noReason.ok === false && noReason.error?.code === 'escalation_reason_required', JSON.stringify(noReason));
await kernel.executor.commit(projectId, {
  actor: { kind: 'human', id: 'test' },
  mutations: [{ op: 'project.update', set: { config: { scheduling: { rotationDays: 14 }, disputes: { escalationQuotaPerEpoch: 1 } } } }],
});
const escalation = await service.openDispute(projectId, {
  type: 'priority_inversion', reasonCode: 'human_requested_p0', target: { nodeId: 'branch-a' },
}, human);
const overQuota = await service.openDispute(projectId, {
  type: 'priority_inversion', reasonCode: 'human_requested_p0', target: { nodeId: 'branch-b' },
}, human);
check('human escalation is quota-limited per expert per epoch',
  escalation.ok === true && overQuota.ok === false && overQuota.error?.code === 'escalation_quota_exceeded',
  JSON.stringify({ escalation: escalation.ok, overQuota }));

await store.saveProject({ id: 'stage5-budget-p', revision: 0, counters: { eventSeq: 0 }, config: { disputes: { budgetPerEpoch: 1 } }, createdAt: 0, updatedAt: 0 });
kernel.load('stage5-budget-p');
const budgetFirst = await service.openDispute('stage5-budget-p', { type: 'stale_basis', target: { nodeId: 'root' } }, human);
const budgetSecond = await service.openDispute('stage5-budget-p', { type: 'stale_basis', target: { nodeId: 'root' } }, human);
const budgetReport = service.classBudgetReport('stage5-budget-p');
check('each dispute consumes a per-epoch project budget',
  budgetFirst.ok === true && budgetSecond.ok === false && budgetSecond.error?.code === 'dispute_budget_exhausted'
  && budgetReport.disputes?.budget === 1 && budgetReport.disputes?.consumed === 1,
  JSON.stringify({ budgetFirst: budgetFirst.ok, budgetSecond, report: budgetReport.disputes }));

const changed = service.changesSince(projectId, 0);
check('changes-since strips actor keys from dispute events too', !JSON.stringify(changed).includes('actorKey'), JSON.stringify(changed).slice(0, 800));

const listed = service.listDisputes(projectId);
check('the dispute table exposes the real row and never leaks actor keys',
  listed.ok === true && listed.disputes.some((row) => row.id === opened.dispute.id && row.source === 'dispute')
  && !JSON.stringify(listed).includes('actorKey')
  && listed.classes.resource_quantity.authority === 'cfs',
  JSON.stringify(listed.disputes.slice(-2)));

const selfResolved = await service.resolveDispute(projectId, opened.dispute.id, { resolution: 'keep_current', reason: 'self' }, human);
check('a raiser cannot resolve their own dispute',
  selfResolved.ok === false && selfResolved.error?.code === 'dispute_self_resolution'
  && selfResolved.error?.message?.includes('dispute_self_resolution'), JSON.stringify(selfResolved));

const aliasSession = { id: 'b22-alias' };
const aliasExec = { agent: { session: aliasSession } };
const aliasDispute = await service.openDispute(projectId, { type: 'fact_conflict', target: { nodeId: 'branch-a' } }, aliasExec);
aliasSession.id = 'b22-alias-renamed';
const aliasSelf = await service.resolveDispute(projectId, aliasDispute.dispute.id, { resolution: 'keep_current', reason: 'same key, new display spelling' }, aliasExec);
aliasSession.id = 'b22-alias';
check('a display rename cannot turn one keyed raiser into a different resolver',
  aliasSelf.ok === false && aliasSelf.error?.code === 'dispute_self_resolution', JSON.stringify(aliasSelf));

const resolved = await service.resolveDispute(projectId, opened.dispute.id, { resolution: 'apply_change', reason: 'cfs arithmetic agreed' }, secondHuman);
check('a different actor resolves the dispute with an auditable record',
  resolved.ok === true && resolved.dispute.status === 'resolved'
  && resolved.dispute.resolution === 'apply_change' && resolved.dispute.resolvedBy?.id === 'b22-second-human',
  JSON.stringify(resolved.dispute));

const reopened = await service.reopenDispute(projectId, opened.dispute.id, { evidence: [{ nodeId: 'branch-a', field: 'needs.gpu' }] }, secondHuman);
check('reopening without new evidence is rejected',
  reopened.ok === false && reopened.error?.code === 'dispute_reopen_requires_new_evidence', JSON.stringify(reopened));

const sameResolver = await service.reopenDispute(projectId, opened.dispute.id, {
  evidence: [{ nodeId: 'branch-a', field: 'needs.gpu', quote: '8' }],
}, secondHuman);
check('the resolver cannot reopen their own resolution',
  sameResolver.ok === false && sameResolver.error?.code === 'dispute_reopen_requires_different_actor', JSON.stringify(sameResolver));

const reopenedOk = await service.reopenDispute(projectId, opened.dispute.id, {
  evidence: [{ nodeId: 'branch-a', field: 'needs.gpu', quote: '8' }],
}, thirdHuman);
check('a different actor can reopen with new evidence into a fresh pending record',
  reopenedOk.ok === true && reopenedOk.dispute.status === 'pending' && reopenedOk.dispute.evidence.length === 2
  && reopenedOk.dispute.reopenedBy?.id === 'b22-third-human',
  JSON.stringify(reopenedOk.dispute));

const timed = await service.openDispute(projectId, {
  type: 'stale_basis',
  deadlineAt: Date.now() + 30,
  target: { nodeId: 'branch-a' },
}, human);
await new Promise((resolve) => setTimeout(resolve, 60));
const swept = await service.sweepDisputes(projectId);
check('an overdue dispute applies keep_current by timeout',
  swept.ok === true && swept.timedOut.includes(timed.dispute.id)
  && service.listDisputes(projectId).disputes.find((row) => row.id === timed.dispute.id)?.resolution === 'keep_current'
  && service.listDisputes(projectId).disputes.find((row) => row.id === timed.dispute.id)?.defaultApplied === true,
  JSON.stringify(swept));

const prediction = evaluateExpected({ metric: 'score', direction: 'up', magnitude: 1 }, [{ name: 'score', value: 0.1 }], 1);
check('a missed prediction opens a retro ticket with a calibration result',
  prediction?.retroOpen === true && prediction.calibration === 'direction_off' && prediction.delta === -0.9,
  JSON.stringify(prediction));
const completedNode = { expected: { metric: 'score', direction: 'up', magnitude: 1 }, expectedBaseline: 1, report: { metrics: [{ name: 'score', value: 0.1 }] } };
const firstApply = applyPredictionToNode(completedNode, 1000);
const secondApply = applyPredictionToNode(completedNode, 2000);
check('the runtime completion hook opens exactly one retro ticket per prediction',
  firstApply?.openRetroTicket === true && completedNode.expectedOutcome?.retroOpen === true
  && secondApply?.openRetroTicket === false && completedNode.expectedRetroAt === 1000,
  JSON.stringify({ firstApply, secondApply, at: completedNode.expectedRetroAt }));
check('prediction normalization rejects a directionless expectation',
  (() => { try { normalizeExpected({ metric: 'score', magnitude: 1 }); return false; } catch { return true; } })());
const intentWithExpected = createIntent({
  id: 'intent-expected-1', kind: 'proposal', actor: { kind: 'expert', id: 'expert-a' },
  claim: { action: 'propose_node' }, basis: { projectRevision: 0, snapshotAgeMs: 0, nodesSeen: 1 },
  expected: { metric: 'score', direction: 'up', magnitude: 0.5 },
});
check('intents carry an expected prediction', intentWithExpected.expected?.metric === 'score' && intentWithExpected.expected.direction === 'up');

const plan = rotationPlan({
  nodes: [
    { id: 'root', createdBy: 'expert-a', timestamps: { createdAt: Date.now() - 20 * 86_400_000 } },
    { id: 'child', parentId: 'root', createdBy: 'expert-a', timestamps: { createdAt: Date.now() - 19 * 86_400_000 } },
  ],
  experts: ['expert-a', 'expert-b'],
  now: Date.now(),
  maxDays: 14,
});
check('rotation is deterministic for an expert who owned the branch too long',
  plan.due.length === 1 && plan.due[0].expertId === 'expert-a' && plan.due[0].nextExpertId === 'expert-b',
  JSON.stringify(plan.due));

await service.hireExpert(projectId, { expertId: 'lab-advisor' }, human);
await service.hireExpert(projectId, { expertId: 'lab-reviewer' }, human);
await kernel.executor.commit(projectId, {
  actor: { kind: 'human', id: 'test' },
  mutations: [{ op: 'node.create', node: { id: 'old-branch', title: 'old branch', parentId: 'root', status: 'completed', createdBy: 'lab-advisor', timestamps: { createdAt: Date.now() - 20 * 86_400_000, completedAt: Date.now() - 19 * 86_400_000 } } }],
});
const rotationStatus = service.rotationStatus(projectId);
check('5.3.12 rotation threshold is a pinned 14-day policy value',
  rotationStatus.policy?.defaultDays === 14 && rotationStatus.policy?.maxDays === 14
  && rotationStatus.policy?.minDays === 1 && rotationStatus.policy?.maxDaysLimit === 365,
  JSON.stringify(rotationStatus.policy));
const rotationRun = await service.rotateDueExperts(projectId);
check('5.3.12 rotation consumes nextExpertId and moves the branch assignment',
  rotationStatus.due.some((row) => row.branchId === 'root')
  && rotationRun.rotated?.some((row) => row.branchId === 'root' && row.expertId === 'lab-advisor')
  && rotationRun.rotated?.some((row) => row.branchId === 'root' && row.nextExpertId === 'lab-reviewer')
  && rotationRun.rotated?.some((row) => (row.assignedNodeIds ?? []).includes('old-branch'))
  && store.getNode(projectId, 'old-branch')?.createdBy === 'lab-reviewer'
  && store.getProject(projectId).expertRotations?.root?.nextExpertId === 'lab-reviewer'
  && store.listEvents(projectId).some((event) => event.type === 'expert/rotated' && event.data?.branchId === 'root')
  && store.listEvents(projectId).some((event) => event.type === 'node/expert_assigned' && event.data?.to === 'lab-reviewer'),
  JSON.stringify({ status: rotationStatus.due, run: rotationRun, node: store.getNode(projectId, 'old-branch'), rotations: store.getProject(projectId).expertRotations }));
const rotationAfter = service.rotationStatus(projectId);
check('5.3.12 rotationPlan rebuilds the branch assignment and is not immediately due again',
  rotationAfter.assignments.some((row) => row.branchId === 'root' && row.expertId === 'lab-reviewer')
  && !rotationAfter.due.some((row) => row.branchId === 'root'),
  JSON.stringify({ assignments: rotationAfter.assignments, due: rotationAfter.due }));

const waited = await service.waitForEvents(projectId, { after: store.maxEventSeq(projectId), timeoutMs: 25, pollMs: 25 });
check('long-poll times out without inventing an event', waited.ok === true && waited.timedOut === true && waited.events.length === 0, JSON.stringify(waited));
const waitCursor = store.maxEventSeq(projectId);
const waitForArrival = service.waitForEvents(projectId, { after: waitCursor, timeoutMs: 1_000, pollMs: 25 });
setTimeout(() => {
  void kernel.executor.commit(projectId, {
    actor: { kind: 'human', id: 'test' },
    mutations: [{ op: 'event.record', type: 'node/activity', nodeId: 'branch-a', data: { activity: 'long-poll arrival' } }],
  });
}, 40);
const arrived = await waitForArrival;
check('long-poll returns an event that arrives during the wait instead of skipping it',
  arrived.ok === true && arrived.events.some((event) => event.type === 'node/activity' && event.nodeId === 'branch-a'),
  JSON.stringify(arrived));

await kernel.executor.commit(projectId, {
  actor: { kind: 'human', id: 'test' },
  mutations: [{ op: 'node.create', node: { id: 'stalled', title: 'silent node', status: 'running', timestamps: { createdAt: 1, startedAt: Date.now() - 40 * 60_000, lastActivityAt: Date.now() - 40 * 60_000 } } }],
});
const stalledSnapshot = service.observerSnapshot(projectId);
const escalated = await service.escalateStalled(projectId);
check('an idle running node is observable and escalates exactly once',
  stalledSnapshot.stalled.some((row) => row.nodeId === 'stalled')
  && escalated.escalated.includes('stalled')
  && store.listEvents(projectId).filter((event) => event.type === 'observer/escalation' && event.data?.nodeId === 'stalled').length === 1,
  JSON.stringify({ stalledSnapshot: stalledSnapshot.stalled, escalated }));

// 5.3.13: starvation, driver pause and the 60s long-poll cap are separate
// escalation conditions, not aliases of the 30-minute stalled check.
const observerProjectId = 'stage5-observer-p';
await store.saveProject({ id: observerProjectId, revision: 0, counters: { eventSeq: 0 }, config: {}, createdAt: 0, updatedAt: 0 });
kernel.load(observerProjectId);
await kernel.executor.commit(observerProjectId, {
  actor: { kind: 'human', id: 'test' },
  mutations: [{ op: 'node.create', node: { id: 'starving', title: 'starving node', status: 'planned', priority: { class: 'p2' }, timestamps: { createdAt: Date.now() - 11 * 60_000 } } }],
});
const starvedSnapshot = service.observerSnapshot(observerProjectId);
check('the observer distinguishes a starving runnable node from a stalled running node',
  starvedSnapshot.stalled.length === 0
  && starvedSnapshot.starving.some((row) => row.nodeId === 'starving' && row.waitingMs >= 10 * 60_000)
  && starvedSnapshot.pauseReason === null,
  JSON.stringify({ stalled: starvedSnapshot.stalled, starving: starvedSnapshot.starving, pauseReason: starvedSnapshot.pauseReason }));
const starvedEscalation = await service.escalateStalled(observerProjectId);
const starvedAgain = await service.escalateStalled(observerProjectId);
check('a starving node escalates once with a starving_node event',
  starvedEscalation.starving.includes('starving')
  && starvedAgain.starving.length === 0
  && store.listEvents(observerProjectId).filter((event) => event.type === 'observer/escalation' && event.data?.code === 'starving_node' && event.data?.nodeId === 'starving').length === 1,
  JSON.stringify({ first: starvedEscalation, second: starvedAgain }));

const pausedProjectId = 'stage5-paused-p';
await store.saveProject({ id: pausedProjectId, revision: 0, counters: { eventSeq: 0 }, config: {}, createdAt: 0, updatedAt: 0 });
kernel.load(pausedProjectId);
autoState = { status: 'paused', pauseReason: 'operator_pause' };
const pausedSnapshot = service.observerSnapshot(pausedProjectId);
const pausedWait = await service.waitForEvents(pausedProjectId, { after: 0, timeoutMs: 500, pollMs: 25 });
const pausedEscalation = await service.escalateStalled(pausedProjectId);
autoState = { status: 'off', pauseReason: null };
check('a paused driver is observable and escalates pauseReason without waiting for a stall',
  pausedSnapshot.pauseReason === 'operator_pause'
  && pausedWait.escalation?.code === 'observer_paused'
  && pausedWait.escalation?.pauseReason === 'operator_pause'
  && pausedEscalation.paused.includes('operator_pause')
  && store.listEvents(pausedProjectId).some((event) => event.type === 'observer/escalation' && event.data?.code === 'driver_paused' && event.data?.pauseReason === 'operator_pause'),
  JSON.stringify({ snapshot: pausedSnapshot.pauseReason, wait: pausedWait.escalation, escalate: pausedEscalation }));

// The 60s cap is behavioural, not a constant grep: advance the clock inside
// waitForEvents so the test does not actually sleep for a minute.
const capProjectId = pausedProjectId;
const capAfter = store.maxEventSeq(capProjectId);
const realNow = Date.now;
const realSetTimeout = global.setTimeout;
let fakeNow = 0;
Date.now = () => fakeNow;
global.setTimeout = (fn, ms) => { fakeNow += Number(ms) || 0; fn(); return 0; };
let capWait;
try {
  capWait = await service.waitForEvents(capProjectId, { after: capAfter, timeoutMs: 120_000, pollMs: 25 });
} finally {
  Date.now = realNow;
  global.setTimeout = realSetTimeout;
}
check('long-poll clamps the requested timeout to 60s, not 30s',
  capWait.timedOut === true && capWait.waitedMs >= 59_000 && capWait.waitedMs <= 60_500,
  JSON.stringify({ waitedMs: capWait.waitedMs, timedOut: capWait.timedOut }));

const arbiterExec = { agent: { session: { id: 'b22-arbiter', header: { meta: { agentPreset: 'lab-arbiter' } } } } };
const arbiterActor = { kind: 'expert', id: 'b22-arbiter', preset: 'lab-arbiter' };
check('the arbiter is limited to observe + arbitrate, not runtime control',
  authorizeAction(arbiterActor, 'arbitrate').ok === true
  && authorizeAction(arbiterActor, 'observe').ok === true
  && authorizeAction(arbiterActor, 'start_node').ok === false,
  JSON.stringify(authorizeAction(arbiterActor, 'start_node')));
const pendingArbitration = await service.openDispute(projectId, {
  type: 'resource_quality', target: { nodeId: 'branch-a' }, reasonCode: 'shape_differs',
}, secondHuman);
const arbitrated = await service.arbitrate(projectId, { disputeId: pendingArbitration.dispute.id, resolution: 'apply_change', reason: 'arbiter examined both shapes' }, arbiterExec);
check('a limited-write arbiter resolves a dispute without any runtime action',
  arbitrated.ok === true && arbitrated.dispute.status === 'resolved'
  && arbitrated.dispute.resolvedBy?.id === 'b22-arbiter',
  JSON.stringify(arbitrated));
const humanOnly = await service.openDispute(projectId, {
  type: 'priority_inversion', reasonCode: 'human_requested_p0', target: { nodeId: 'branch-b' },
}, secondHuman);
const arbiterCannotOverrideHuman = await service.arbitrate(projectId, { disputeId: humanOnly.dispute?.id, resolution: 'keep_current', reason: 'arbiter tries' }, arbiterExec);
check('an arbiter cannot override a human-authority dispute',
  humanOnly.ok === false || (arbiterCannotOverrideHuman.ok === false && arbiterCannotOverrideHuman.error?.code === 'human_confirmation_required'),
  JSON.stringify({ humanOnly, arbiterCannotOverrideHuman }));

// B22 authority enforcement: an expert that calls the old direct path, and the
// limited-write arbiter, are both bounded by the eight-class map. The raiser is
// a human so self-resolution never masks an authority result.
const authorityRaiser = { agent: { session: { id: 'b22-authority-raiser' } } };
const plainExpertExec = { agent: { session: { id: 'b22-plain-expert', header: { meta: { agentPreset: 'lab-advisor' } } } } };
const authorityArbiterExec = { agent: { session: { id: 'b22-authority-arbiter', header: { meta: { agentPreset: 'lab-arbiter' } } } } };
const curatorExec = { agent: { session: { id: 'b22-curator', header: { meta: { agentPreset: 'lab-curator' } } } } };
const authorityRows = {};
for (const type of Object.keys(DISPUTE_CLASS_MAP)) {
  const row = await service.openDispute(projectId, {
    type,
    target: { nodeId: 'branch-a' },
    ...(type === 'priority_inversion' ? { reasonCode: 'human_requested_p0' } : {}),
  }, authorityRaiser);
  authorityRows[type] = row;
}
const directExpert = {};
for (const type of Object.keys(DISPUTE_CLASS_MAP)) {
  directExpert[type] = await service.resolveDispute(projectId, authorityRows[type].dispute?.id, {
    resolution: 'apply_change', reason: 'expert bypass probe',
  }, plainExpertExec);
}
check('an expert cannot resolve any of the eight classes through the direct resolve path',
  Object.values(directExpert).every((row) => row.ok === false)
  && Object.values(directExpert).every((row) => row.error?.code === 'forbidden_action'),
  JSON.stringify(directExpert));

const expertTool = await service.arbitrate(projectId, {
  disputeId: authorityRows.duplicate_claim.dispute?.id,
  resolution: 'apply_change', reason: 'expert tool probe',
}, plainExpertExec);
check('an expert is denied by the same actor gate on the arbitrate tool',
  expertTool.ok === false && expertTool.error?.code === 'forbidden_action',
  JSON.stringify(expertTool));

const arbiterByClass = {};
for (const type of Object.keys(DISPUTE_CLASS_MAP)) {
  arbiterByClass[type] = await service.arbitrate(projectId, {
    disputeId: authorityRows[type].dispute?.id,
    resolution: 'apply_change',
    reason: 'authority map probe',
  }, authorityArbiterExec);
}
const arbiterAllowed = ['resource_quality', 'value_priority', 'scope_overlap'];
check('the arbiter resolves only its three classes and is denied code/cfs/curator/human',
  arbiterAllowed.every((type) => arbiterByClass[type].ok === true)
  && ['stale_basis', 'fact_conflict', 'resource_quantity', 'duplicate_claim', 'priority_inversion']
    .every((type) => arbiterByClass[type].ok === false
      && ['forbidden_authority', 'human_confirmation_required'].includes(arbiterByClass[type].error?.code)),
  JSON.stringify(Object.fromEntries(Object.entries(arbiterByClass).map(([type, row]) => [type, row.error?.code ?? 'ok']))));

const curatorDirect = await service.resolveDispute(projectId, authorityRows.duplicate_claim.dispute?.id, {
  resolution: 'keep_current', reason: 'curator owns duplicate claims',
}, curatorExec);
const curatorTool = await service.arbitrate(projectId, {
  disputeId: authorityRows.duplicate_claim.dispute?.id,
  resolution: 'keep_current', reason: 'curator tool probe',
}, curatorExec);
check('the curator is denied by the same actor gate on both direct resolve and the tool',
  curatorDirect.ok === false && curatorDirect.error?.code === 'forbidden_action'
  && curatorTool.ok === false && curatorTool.error?.code === 'forbidden_action',
  JSON.stringify({ direct: curatorDirect.error?.code, tool: curatorTool.error?.code }));

// A human may decide a known class, but an unknown authority string is a
// malformed record, not permission for the highest-privilege actor.
await kernel.executor.commit(projectId, {
  actor: { kind: 'human', id: 'test' },
  mutations: [{
    op: 'dispute.open',
    dispute: {
      id: 'bogus-authority',
      type: 'resource_quality',
      authority: 'bogus_authority',
      status: 'pending',
      defaultAction: 'keep_current',
      at: Date.now(),
      deadlineAt: Date.now() + DISPUTE_TIMEOUT_MS,
    },
  }],
});
const unknownAuthority = await service.resolveDispute(projectId, 'bogus-authority', {
  resolution: 'apply_change', reason: 'human bypass probe',
}, human);
check('an unknown authority is rejected even for a human actor',
  unknownAuthority.ok === false && unknownAuthority.error?.code === 'unknown_dispute_authority',
  JSON.stringify(unknownAuthority));

const httpRoutes = new Map();
registerHttpRoutes({
  effect: () => {},
  connection: { fetch: { register({ path, fetch }) { httpRoutes.set(path, fetch); return () => {}; } } },
}, {
  verifyOperatorToken: (candidate) => (candidate === 'stage5-operator' ? { ok: true, id: 'operator' } : { ok: false, code: 'operator_required' }),
  disputeClasses: () => ({ classes: {} }),
  openDispute: () => ({ ok: true }),
  resolveDispute: () => { httpRoutes.directResolveCalls = (httpRoutes.directResolveCalls ?? 0) + 1; return { ok: true }; },
  arbitrate: () => { httpRoutes.arbitrateCalls = (httpRoutes.arbitrateCalls ?? 0) + 1; return { ok: true }; },
});
const resolveRoute = httpRoutes.get('/api/metainfer-research-lab/disputes/resolve');
const routeResponse = await resolveRoute(new Request('http://local/api/metainfer-research-lab/disputes/resolve', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-metainfer-operator': 'stage5-operator' },
  body: JSON.stringify({ projectId, disputeId: authorityRows.duplicate_claim.dispute?.id, resolution: 'keep_current' }),
}));
const routeEnvelope = await routeResponse.json();
check('HTTP /disputes/resolve routes through arbitrate instead of calling resolveDispute directly',
  routeEnvelope.ok === true && httpRoutes.arbitrateCalls === 1 && httpRoutes.directResolveCalls === undefined,
  JSON.stringify({ routeEnvelope, arbitrateCalls: httpRoutes.arbitrateCalls, directResolveCalls: httpRoutes.directResolveCalls }));

const actualHttpRoutes = new Map();
registerHttpRoutes({
  effect: () => {},
  connection: { fetch: { register({ path, fetch }) { actualHttpRoutes.set(path, fetch); return () => {}; } } },
}, service);
const actualResolveRoute = actualHttpRoutes.get('/api/metainfer-research-lab/disputes/resolve');
const actualResolveResponse = await actualResolveRoute(new Request('http://local/api/metainfer-research-lab/disputes/resolve', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ projectId, disputeId: authorityRows.duplicate_claim.dispute?.id, resolution: 'apply_change', authority: 'code', agentPreset: 'lab-advisor', actorKey: 'ak_host_FORGED' }),
}));
const actualResolveEnvelope = await actualResolveResponse.json();
const actualArbitrateRoute = actualHttpRoutes.get('/api/metainfer-research-lab/arbitrate');
const actualArbitrateResponse = await actualArbitrateRoute(new Request('http://local/api/metainfer-research-lab/arbitrate', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ projectId, disputeId: authorityRows.duplicate_claim.dispute?.id, resolution: 'apply_change' }),
}));
const actualArbitrateEnvelope = await actualArbitrateResponse.json();
check('HTTP dispute resolution fails closed when no actor is resolvable, even with forged body fields',
  actualResolveEnvelope.ok === false && actualResolveEnvelope.error?.code === 'actor_required'
  && actualArbitrateEnvelope.ok === false && actualArbitrateEnvelope.error?.code === 'actor_required',
  JSON.stringify({ resolve: actualResolveEnvelope, arbitrate: actualArbitrateEnvelope }));

const expertMetrics = service.listExperts(projectId);
check('disputes are counted in expert performance',
  expertMetrics.ok === true
  && expertMetrics.experts.every((row) => Number.isFinite(Number(row.metrics?.disputesRaised)) && Number.isFinite(Number(row.metrics?.disputesWon))),
  JSON.stringify(expertMetrics.experts.slice(0, 2).map((row) => row.metrics)));
const observed = service.observe(projectId);
check('observe returns a bounded read surface', observed.ok === true && Array.isArray(observed.recentEvents) && Array.isArray(observed.openDisputes) && !JSON.stringify(observed).includes('actorKey'), JSON.stringify(observed).slice(0, 300));

const retro = service.listRetrospectives(projectId);
check('retrospectives read without actor keys', retro.ok === true && !JSON.stringify(retro).includes('actorKey'));

if (failed > 0) {
  console.log(`stage5-selftest: ${failed} check(s) failed`);
  process.exit(1);
}
console.log('stage5-selftest: all checks passed');
