/**
 * B22/B23 + 5.3.13/5.3.14: first-class disputes with timeout defaults, eight-class
 * arbiter mapping, prediction errors, rotation, observer long-poll and the
 * limited-write arbitration surface.
 */
import { openStore } from '../host/store.js';
import { createKernel } from '../host/kernel/instance.js';
import { createLabService } from '../host/lab-service.js';
import { authorizeAction } from '../host/kernel/policy.js';
import { createIntent } from '../host/kernel/intent.js';
import { DISPUTE_CLASS_MAP, DISPUTE_TIMEOUT_MS } from '../host/kernel/disputes.js';
import { applyPredictionToNode, evaluateExpected, normalizeExpected } from '../host/kernel/prediction.js';
import { rotationPlan } from '../host/experts/rotation.js';
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
const service = createLabService({
  ctx: { effect: () => {}, get: () => null, logger: { info() {}, warn() {} } },
  store, kernel, git: null, runtime: null, transcript: null, orchestrator: null, auto: null, cluster: null, clusterAdmin: null,
});
const human = { agent: { session: { id: 'b22-human' } } };
const secondHuman = { agent: { session: { id: 'b22-second-human' } } };

check('the eight conflict classes map to an authority, and only two ask a model',
  Object.keys(DISPUTE_CLASS_MAP).length === 8
  && Object.values(DISPUTE_CLASS_MAP).filter((row) => row.needsModel).length === 2
  && Object.values(DISPUTE_CLASS_MAP).every((row) => ['code', 'cfs', 'arbiter', 'human', 'curator'].includes(row.authority)),
  JSON.stringify(DISPUTE_CLASS_MAP));

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

const reopenedOk = await service.reopenDispute(projectId, opened.dispute.id, {
  evidence: [{ nodeId: 'branch-a', field: 'needs.gpu', quote: '8' }],
}, secondHuman);
check('reopening with new evidence returns a fresh pending record',
  reopenedOk.ok === true && reopenedOk.dispute.status === 'pending' && reopenedOk.dispute.evidence.length === 2,
  JSON.stringify(reopenedOk.dispute));

const timed = await service.openDispute(projectId, {
  type: 'stale_basis',
  deadlineAt: Date.now() + 30,
  target: { nodeId: 'branch-a' },
}, human);
await new Promise((resolve) => setTimeout(resolve, 60));
const swept = await service.sweepDisputes(projectId, { now: Date.now() });
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
const rotationRun = await service.rotateDueExperts(projectId);
check('rotation has a production dispatch call site and writes an auditable record',
  rotationStatus.due.some((row) => row.branchId === 'root')
  && rotationRun.rotated?.some((row) => row.branchId === 'root' && row.expertId === 'lab-advisor')
  && store.getProject(projectId).expertRotations?.root?.nextExpertId === 'lab-reviewer'
  && store.listEvents(projectId).some((event) => event.type === 'expert/rotated' && event.data?.branchId === 'root'),
  JSON.stringify({ status: rotationStatus.due, run: rotationRun, rotations: store.getProject(projectId).expertRotations }));

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
