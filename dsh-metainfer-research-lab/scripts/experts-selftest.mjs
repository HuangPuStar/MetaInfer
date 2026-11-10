/**
 * Stage 4.1-4.3: descriptors are data with the eight contract fields, similarity
 * recall is deterministic/pure, and the curator only nominates — with a
 * false-close circuit breaker and an explicit refusal to execute.
 */
import { openStore } from '../host/store.js';
import { createKernel } from '../host/kernel/instance.js';
import { createLabService } from '../host/lab-service.js';
import { registerAgentTool } from '../host/agent-tool.js';
import { listExpertDescriptors, computeExpertMetrics } from '../host/experts/registry.js';
import { dedupeSignature, nodeSimilarity, recallCandidates, recallExperts, similarityEvidence, variantConflict } from '../host/experts/similarity.js';
import { applyNomination, createCurator } from '../host/experts/curator.js';
import { ESCALATION_TRIGGER_CODES, THRESHOLD_TRIGGER_CODES, evaluateEscalationTriggers, evaluateThresholdTriggers } from '../host/experts/triggers.js';
import { ACTION_CATALOG, allowedActions } from '../host/kernel/policy.js';
import { memoryDomain, storeContext } from './lib/memory-domain.mjs';

let failed = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`ok   ${name}`);
  else { failed += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const fields = ['id', 'persona', 'model', 'tools', 'triggers', 'mayPropose', 'mayExecute', 'budget', 'schema'];
const descriptors = listExpertDescriptors();
check('registry exposes every expert', descriptors.length >= 3 && descriptors.every((descriptor) => typeof descriptor.id === 'string'));
check('every descriptor has the eight contract fields', descriptors.every((descriptor) => fields.filter((field) => field !== 'id').every((field) => descriptor[field] !== undefined)), JSON.stringify(Object.keys(descriptors[0])));
check('no expert holds an execution action', descriptors.every((descriptor) => Array.isArray(descriptor.mayExecute) && descriptor.mayExecute.length === 0));
const curatorDescriptor = descriptors.find((descriptor) => descriptor.id === 'lab-curator');
check('curator is read-only and nominates', curatorDescriptor && curatorDescriptor.tools.every((tool) => ['dag_map', 'dag_walk', 'dag_get', 'dag_query'].includes(tool)), JSON.stringify(curatorDescriptor?.tools));
check('descriptors are copies, not shared mutable state', listExpertDescriptors()[0] !== listExpertDescriptors()[0]);

const CHECKLIST_ESCALATION_CODES = ['conflict', 'budget_shift', 'new_direction', 'branch_death', 'low_confidence', 'ledger_conflict'];
const CHECKLIST_THRESHOLD_CODES = ['queue_overload', 'stalled', 'repeated_failure', 'expert_rejected', 'budget_alert', 'direction_converged'];
check('B13/5.3.9: implementation exports the literal checklist code sets',
  JSON.stringify([...ESCALATION_TRIGGER_CODES]) === JSON.stringify(CHECKLIST_ESCALATION_CODES)
  && JSON.stringify([...THRESHOLD_TRIGGER_CODES]) === JSON.stringify(CHECKLIST_THRESHOLD_CODES),
  JSON.stringify({ escalation: ESCALATION_TRIGGER_CODES, threshold: THRESHOLD_TRIGGER_CODES }));
const triggerNow = Date.now();
const escalationFixtures = [
  { id: 'c1', status: 'planned', hypothesis: 'same hypothesis', variant: 'lr=1e-3' },
  { id: 'c2', status: 'planned', hypothesis: 'same hypothesis', variant: 'lr=3e-4' },
  { id: 'nd', status: 'planned', hypothesis: 'a brand new direction' },
  { id: 'bd', status: 'failed', branchDead: true },
  { id: 'lc', status: 'planned', confidence: 0.59 },
];
const escalation = evaluateEscalationTriggers({
  nodes: escalationFixtures,
  project: { counters: { tokensUsed: 900, costUsd: 0 }, config: { auto: { maxTokens: 1_000 } } },
  knownHypotheses: ['the old direction'],
  ledger: [{ id: 'l1', target: 'c1', value: 'keep' }, { id: 'l2', target: 'c1', value: 'change' }],
  now: triggerNow,
});
const escalationCodes = escalation.map((row) => row.code);
check('B13: the six checklist escalation codes fire from deterministic facts',
  CHECKLIST_ESCALATION_CODES.every((code) => escalationCodes.includes(code))
  && new Set(escalationCodes).size === CHECKLIST_ESCALATION_CODES.length
  && escalation.every((row) => row.detail && typeof row.detail === 'object'),
  JSON.stringify({ expected: CHECKLIST_ESCALATION_CODES, fired: escalation }));

const threshold = evaluateThresholdTriggers({
  nodes: [
    { id: 'q1', status: 'planned', priority: { class: 'p2' }, timestamps: { createdAt: triggerNow - 600_000 } },
    { id: 'q2', status: 'planned', priority: { class: 'p2' }, timestamps: { createdAt: triggerNow - 600_000 } },
    { id: 'q3', status: 'planned', priority: { class: 'deferred' }, timestamps: { createdAt: triggerNow - 600_000 } },
    { id: 'stalled', status: 'running', timestamps: { startedAt: triggerNow - 20 * 60_000, lastActivityAt: triggerNow - 16 * 60_000 } },
    { id: 'f1', status: 'failed', hypothesis: 'converged direction' },
    { id: 'f2', status: 'failed', hypothesis: 'converged direction' },
    { id: 'f3', status: 'failed', hypothesis: 'converged direction' },
  ],
  runs: [
    { id: 'r1', status: 'failed', errorKind: 'OOM', startedAt: triggerNow - 5_000 },
    { id: 'r2', status: 'failed', errorKind: 'OOM', startedAt: triggerNow - 4_000 },
    { id: 'r3', status: 'failed', errorKind: 'OOM', startedAt: triggerNow - 3_000 },
  ],
  intents: [1, 2, 3, 4, 5].map((index) => ({ id: `i${index}`, expertId: 'lab-advisor', status: 'rejected' })),
  project: { counters: { tokensUsed: 850 }, config: { auto: { maxTokens: 1_000 } } },
  freeSlots: 1,
  queueOverloadSince: triggerNow - 5 * 60_000 - 1,
  stalledMs: 15 * 60_000,
  now: triggerNow,
});
const thresholdCodes = threshold.map((row) => row.code);
check('5.3.9: the six checklist thresholds fire (queue 5m, stall 15m, errorKind 3x, reject 5x, budget >80%, 3 failed same hypothesis)',
  CHECKLIST_THRESHOLD_CODES.every((code) => thresholdCodes.includes(code))
  && new Set(thresholdCodes).size === CHECKLIST_THRESHOLD_CODES.length
  && threshold.find((row) => row.code === 'repeated_failure')?.detail?.streak === 3
  && threshold.find((row) => row.code === 'expert_rejected')?.detail?.count === 5
  && threshold.find((row) => row.code === 'direction_converged')?.detail?.nodeIds?.length === 3
  && threshold.find((row) => row.code === 'queue_overload')?.detail?.planned === 3
  && threshold.find((row) => row.code === 'queue_overload')?.detail?.queue === 2,
  JSON.stringify({ expected: CHECKLIST_THRESHOLD_CODES, fired: threshold }));

const zeroSlotOverload = evaluateThresholdTriggers({
  nodes: [
    { id: 'z1', status: 'planned', priority: { class: 'p2' }, timestamps: { createdAt: triggerNow - 600_000 } },
    { id: 'z2', status: 'planned', priority: { class: 'p2' }, timestamps: { createdAt: triggerNow - 600_000 } },
    { id: 'z3', status: 'planned', priority: { class: 'p2' }, timestamps: { createdAt: triggerNow - 600_000 } },
  ],
  freeSlots: 0,
  queueOverloadSince: triggerNow - 5 * 60_000 - 1,
  now: triggerNow,
});
check('5.3.9: the checklist overload formula applies with freeSlots=0 (planned 3 > 0)',
  zeroSlotOverload.find((row) => row.code === 'queue_overload')?.detail?.planned === 3
  && zeroSlotOverload.find((row) => row.code === 'queue_overload')?.detail?.freeSlots === 0,
  JSON.stringify(zeroSlotOverload));

const metrics = computeExpertMetrics({
  expertId: 'lab-advisor',
  nodes: [
    { id: 'a', createdBy: 'lab-advisor', status: 'completed', timestamps: { startedAt: 10, completedAt: 20 } },
    { id: 'b', createdBy: 'lab-advisor', status: 'planning' === 'x' ? 'planned' : 'planned' },
    { id: 'c', createdBy: 'lab-advisor', status: 'planned', priority: { class: 'deferred' } },
    { id: 'd', createdBy: 'other', status: 'completed' },
  ],
  runs: [{ id: 'r1', expertId: 'lab-advisor' }],
});
check('metrics count proposals/accepted/completed/pruned', metrics.proposals === 3 && metrics.accepted === 3 && metrics.completed === 1 && metrics.pruned === 1, JSON.stringify(metrics));
check('metrics derive success rate and duration', metrics.successRate === 0.333 && metrics.avgDurationMs === 10, JSON.stringify(metrics));

const duplicateA = { id: 'n1', title: 'fold fp32 head weights into the tcgen05 kernel', successCriteria: 'same logits, lower memory', status: 'planned', timestamps: { createdAt: 1 } };
const duplicateB = { id: 'n2', title: 'fold fp32 head weights into the tcgen05 kernel', successCriteria: 'same logits, lower memory', status: 'planned', timestamps: { createdAt: 1 } };
const unrelated = { id: 'n3', title: 'measure network bandwidth for distributed training', successCriteria: 'throughput up', status: 'planned', timestamps: { createdAt: 1 } };
const mergeNode = { id: 'n4', title: 'fold fp32 head weights into the tcgen05 kernel', parentIds: ['n1', 'n2'], status: 'planned', timestamps: { createdAt: 1 } };
const scanA = { id: 'scan-a', title: 'scan learning rate', hypothesis: 'lr too high', variant: 'lr=1e-3', tags: ['scan', 'lr'], status: 'planned', timestamps: { createdAt: 1 } };
const scanB = { id: 'scan-b', title: 'scan learning rate', hypothesis: 'lr too high', variant: 'lr=3e-4', tags: ['scan', 'lr'], status: 'planned', timestamps: { createdAt: 1 } };
const scanC = { id: 'scan-c', title: 'scan learning rate', hypothesis: 'lr too high', variant: 'lr=1e-3', tags: ['scan', 'lr'], status: 'planned', timestamps: { createdAt: 1 } };
check('B18: structured hypothesis/variant/tag keys separate parameter scans',
  variantConflict(scanA, scanB) === true && variantConflict(scanA, scanC) === false
  && dedupeSignature(scanA) === dedupeSignature(scanC)
  && dedupeSignature(scanA) !== dedupeSignature(scanB)
  && !recallCandidates([scanA, scanB], { threshold: 0.3 }).pairs.some((pair) => pair.a === 'scan-a' && pair.b === 'scan-b'),
  JSON.stringify({ a: dedupeSignature(scanA), b: dedupeSignature(scanB), recall: recallCandidates([scanA, scanB], { threshold: 0.3 }) }));

check('similarity is symmetric and identical pairs score high', nodeSimilarity(duplicateA, duplicateB) >= 0.89 && nodeSimilarity(duplicateA, duplicateB) === nodeSimilarity(duplicateB, duplicateA) && nodeSimilarity(duplicateA, unrelated) < 0.3);
const first = recallCandidates([duplicateA, duplicateB, unrelated, mergeNode], { threshold: 0.5 });
const second = recallCandidates([duplicateA, duplicateB, unrelated, mergeNode], { threshold: 0.5 });
check('recall finds the known duplicate pair', first.pairs.some((pair) => pair.a === 'n1' && pair.b === 'n2' && pair.kind === 'duplicate'), JSON.stringify(first.pairs));
check('recall is deterministic', JSON.stringify(first) === JSON.stringify(second));
check('recall excludes merge nodes and unrelated pairs', first.pairs.every((pair) => pair.a !== 'n4' && pair.b !== 'n4' && !(pair.a === 'n3' && pair.b === 'n1')), JSON.stringify(first.pairs));
const promptA = { id: 'p1', title: 'route alpha', prompt: 'shared hypothesis: fold the head weights', status: 'planned', timestamps: { createdAt: 1 } };
const promptB = { id: 'p2', title: 'route beta', prompt: 'shared hypothesis: fold the head weights', status: 'planned', timestamps: { createdAt: 1 } };
const promptEvidence = similarityEvidence(promptA, promptB);
check('promptHash prefix is a real predicate', promptEvidence.reasons.includes('promptHashPrefix') && promptEvidence.score >= 0.3, JSON.stringify(promptEvidence));
const siblingA = { id: 's1', title: 'sibling one', parentId: 'root', successCriteria: 'same logits and memory', status: 'planned', timestamps: { createdAt: 1 } };
const siblingB = { id: 's2', title: 'sibling two', parentId: 'root', successCriteria: 'same logits and memory', status: 'planned', timestamps: { createdAt: 1 } };
const siblingEvidence = similarityEvidence(siblingA, siblingB);
check('same-parent + criteria is a real predicate', siblingEvidence.reasons.includes('sameParentCriteria'), JSON.stringify(siblingEvidence));
const metricA = { id: 'm1', title: 'metric route one', status: 'completed', report: { metrics: [{ name: 'tokens_per_sec' }, { name: 'loss' }] }, timestamps: { createdAt: 1 } };
const metricB = { id: 'm2', title: 'metric route two', status: 'completed', report: { metrics: [{ name: 'tokens_per_sec' }, { name: 'loss' }] }, timestamps: { createdAt: 1 } };
check('matching metric targets is a real predicate', similarityEvidence(metricA, metricB).reasons.includes('metricTargets'), JSON.stringify(similarityEvidence(metricA, metricB)));
// Immunity is effective, not merely configured: a pair younger than ten minutes
// is excluded until BOTH sides are old enough.
const immunityNow = 100 * 60_000;
const immunityCurator = createCurator({ clock: () => immunityNow, minAgeMs: 10 * 60_000 });
const oldPair = { title: 'same experiment', successCriteria: 'same logits', status: 'planned' };
const immunity = immunityCurator.nominate({
  nodes: [
    { ...oldPair, id: 'old-a', timestamps: { createdAt: immunityNow - 11 * 60_000 } },
    { ...oldPair, id: 'old-b', timestamps: { createdAt: immunityNow - 11 * 60_000 } },
    { ...oldPair, id: 'young-c', timestamps: { createdAt: immunityNow - 9 * 60_000 } },
  ],
});
check('ten-minute immunity excludes young nodes from nominations', immunity.nominations.length === 1 && immunity.nominations[0].nodeId === 'old-a' && immunity.nominations[0].duplicateOf === 'old-b', JSON.stringify(immunity));
const reverseImmunity = immunityCurator.nominate({
  nodes: [
    { ...oldPair, id: 'parent-old', timestamps: { createdAt: immunityNow - 30 * 60_000 } },
    { ...oldPair, id: 'parent-twin', timestamps: { createdAt: immunityNow - 30 * 60_000 } },
    { id: 'young-child', title: 'different child', parentId: 'parent-old', timestamps: { createdAt: immunityNow - 2 * 60_000 } },
  ],
});
check('a node with a fresh child is immune for ten minutes', reverseImmunity.nominations.every((row) => row.nodeId !== 'parent-old' && row.duplicateOf !== 'parent-old'), JSON.stringify(reverseImmunity));

const expertRecall = recallExperts(descriptors, 'duplicate candidate review', { limit: 2 });
check('expert recall is bounded and scored', expertRecall.experts.length === 2 && expertRecall.experts.every((row) => row.score >= 0), JSON.stringify(expertRecall));

const curator = createCurator({ clock: () => 10_000_000, falseCloseThreshold: 0.2, maxNominations: 5 });
const nominations = curator.nominate({ nodes: [duplicateA, duplicateB, { ...duplicateA, id: 'n10', title: duplicateA.title }, { ...duplicateB, id: 'n11', title: duplicateB.title }] });
check('curator nominates at most five closes', nominations.nominations.length <= 5 && nominations.nominations.every((row) => row.action === 'close'), JSON.stringify(nominations));
check('nominations never execute', applyNomination().ok === false && applyNomination().code === 'curator_cannot_execute', JSON.stringify(applyNomination()));
const young = createCurator({ clock: () => 10_000_000 });
const youngResult = young.nominate({ nodes: [{ ...duplicateA, timestamps: { createdAt: 9_999_999 } }, { ...duplicateB, timestamps: { createdAt: 9_999_999 } }] });
check('nodes younger than ten minutes are not nominated', youngResult.nominations.length === 0, JSON.stringify(youngResult));
check('circuit opens once false-close rate exceeds 20%', (() => {
  const breaker = createCurator({ falseCloseThreshold: 0.2 });
  breaker.recordOutcome({ falseClose: true });
  breaker.recordOutcome({ falseClose: false });
  const status = breaker.recordOutcome({ falseClose: true });
  return status.circuitOpen === true && status.falseCloseRate > 0.2 && breaker.nominate({ nodes: [duplicateA, duplicateB] }).circuitOpen === true;
})());

// Production call sites through the registered agent tool.
const store = await openStore(storeContext(memoryDomain()));
const kernel = createKernel({ store });
const projectId = 'experts-p';
await store.saveProject({ id: projectId, revision: 0, counters: { eventSeq: 0 }, config: { maxRunningNodes: 2, resourcePools: {}, maxNodes: 100 }, repo: { path: process.cwd() }, createdAt: 0, updatedAt: 0 });
kernel.load(projectId);
await store.saveNode(projectId, { id: 'd1', title: 'fold fp32 head weights into the kernel', status: 'planned', createdBy: 'lab-advisor', createdAt: 1, timestamps: { createdAt: 1 } });
await store.saveNode(projectId, { id: 'd2', title: 'fold fp32 head weights into the kernel', status: 'planned', createdBy: 'lab-advisor', createdAt: 2, timestamps: { createdAt: 2 } });
await store.saveNode(projectId, { id: 'u1', title: 'benchmark network bandwidth', status: 'planned', createdBy: 'lab-advisor', timestamps: { createdAt: 3 } });
const service = createLabService({ ctx: { effect: () => {}, get: () => null, logger: { info() {}, warn() {} } }, store, kernel, git: null, runtime: null, transcript: null, orchestrator: null, auto: null, cluster: null, clusterAdmin: null });
const toolCtx = { tools: { register(definition) { toolCtx.tool = definition; return () => {}; } } };
registerAgentTool(toolCtx, service);
const curatorExec = { agent: { session: { id: 's-curator', header: { meta: { agentPreset: 'lab-curator' } } } } };
const humanExec = { agent: { session: { id: 's-human', header: {} } } };
const call = async (args, exec) => JSON.parse((await toolCtx.tool.execute(args, exec)).result);
// 5.3.9 production path: the observer, not the test, owns the 5-minute window.
const thresholdProjectId = 'threshold-p';
const t0 = Date.now();
await store.saveProject({
  id: thresholdProjectId, revision: 0, counters: { eventSeq: 0, tokensUsed: 900 },
  config: { maxRunningNodes: 1, resourcePools: {}, maxNodes: 50, auto: { maxTokens: 1_000 } },
  intents: [1, 2, 3, 4, 5].map((index) => ({ id: `reject-${index}`, expertId: 'lab-advisor', status: 'rejected' })),
  createdAt: 0, updatedAt: 0,
});
kernel.load(thresholdProjectId);
for (const [id, spec] of Object.entries({
  q1: { status: 'planned', priority: { class: 'p2' }, timestamps: { createdAt: t0 - 600_000 } },
  q2: { status: 'planned', priority: { class: 'p2' }, timestamps: { createdAt: t0 - 600_000 } },
  q3: { status: 'planned', priority: { class: 'deferred' }, timestamps: { createdAt: t0 - 600_000 } },
  stalled: { status: 'running', timestamps: { startedAt: t0 - 20 * 60_000, lastActivityAt: t0 - 16 * 60_000 } },
  f1: { status: 'failed', hypothesis: 'same dead direction' },
  f2: { status: 'failed', hypothesis: 'same dead direction' },
  f3: { status: 'failed', hypothesis: 'same dead direction' },
})) {
  await store.saveNode(thresholdProjectId, { id, title: id, timestamps: { createdAt: t0 }, ...spec });
}
for (let index = 0; index < 3; index += 1) {
  await store.saveRun(thresholdProjectId, {
    id: `fail-${index}`, projectId: thresholdProjectId, status: 'failed', errorKind: 'OOM',
    startedAt: t0 - 5_000 + index, endedAt: t0 - 4_000 + index,
  });
}
const firstObserve = service.observerSnapshot(thresholdProjectId, { now: t0 });
const secondObserve = service.observerSnapshot(thresholdProjectId, { now: t0 + 5 * 60_000 + 1 });
const observedCodes = (secondObserve.thresholdTriggers ?? []).map((row) => row.code);
check('5.3.9: the production observer emits all six threshold triggers and keeps the 5-minute window',
  CHECKLIST_THRESHOLD_CODES.every((code) => observedCodes.includes(code))
  && new Set(observedCodes).size === CHECKLIST_THRESHOLD_CODES.length
  && (firstObserve.thresholdTriggers ?? []).every((row) => row.code !== 'queue_overload')
  && secondObserve.thresholdTriggers?.find((row) => row.code === 'queue_overload')?.detail?.planned === 3
  && secondObserve.thresholdTriggers?.find((row) => row.code === 'queue_overload')?.detail?.queue === 2
  && secondObserve.thresholdTriggers?.find((row) => row.code === 'queue_overload')?.detail?.freeSlots === 0,
  JSON.stringify({ first: firstObserve.thresholdTriggers, second: secondObserve.thresholdTriggers }));

// B13 production path: the observer receives the same facts the checker sees.
const escalationProjectId = 'escalation-p';
await store.saveProject({
  id: escalationProjectId, revision: 0, counters: { eventSeq: 0, tokensUsed: 900 },
  config: { maxRunningNodes: 1, resourcePools: {}, maxNodes: 50, auto: { maxTokens: 1_000 } },
  knownHypotheses: ['the old direction'],
  ledger: [{ id: 'l1', target: 'c1', value: 'keep' }, { id: 'l2', target: 'c1', value: 'change' }],
  createdAt: 0, updatedAt: 0,
});
kernel.load(escalationProjectId);
for (const node of [
  { id: 'c1', title: 'c1', status: 'planned', hypothesis: 'same hypothesis', variant: 'lr=1e-3' },
  { id: 'c2', title: 'c2', status: 'planned', hypothesis: 'same hypothesis', variant: 'lr=3e-4' },
  { id: 'nd', title: 'nd', status: 'planned', hypothesis: 'a brand new direction' },
  { id: 'bd', title: 'bd', status: 'failed', branchDead: true },
  { id: 'lc', title: 'lc', status: 'planned', confidence: 0.59 },
]) {
  await store.saveNode(escalationProjectId, { ...node, timestamps: { createdAt: Date.now() } });
}
const escalationObserve = service.observerSnapshot(escalationProjectId, { now: Date.now() });
const observedEscalationCodes = (escalationObserve.triggers ?? []).map((row) => row.code);
check('B13: the production observer emits the six checklist escalation codes',
  CHECKLIST_ESCALATION_CODES.every((code) => observedEscalationCodes.includes(code))
  && new Set(observedEscalationCodes).size === CHECKLIST_ESCALATION_CODES.length,
  JSON.stringify({ expected: CHECKLIST_ESCALATION_CODES, fired: escalationObserve.triggers }));

const listed = await call({ action: 'expert_list', projectId }, curatorExec);
check('expert_list returns descriptors with metrics', listed.ok === true && listed.experts.every((expert) => expert.metrics && expert.metrics.expertId === expert.id), JSON.stringify(listed.experts?.map((expert) => expert.id)));
check('expert_list reports the curator breaker', listed.curator && typeof listed.curator.falseCloseRate === 'number');
const recalled = await call({ action: 'expert_recall', projectId, task: 'duplicate review of a kernel hypothesis' }, curatorExec);
check('expert_recall returns scored descriptors', recalled.ok === true && recalled.experts.length >= 1 && recalled.experts[0].descriptor?.id, JSON.stringify(recalled));
const curated = await call({ action: 'curator_nominate', projectId }, curatorExec);
check('curator_nominate is callable and cannot execute', curated.ok === true && curated.canExecute === false && curated.nominations.every((row) => row.action === 'close'), JSON.stringify(curated));
check('curator nomination is recorded as an intent', (store.getProject(projectId).intents ?? []).some((intent) => intent.kind === 'curate'), JSON.stringify(store.getProject(projectId).intents));
const outcome = await call({ action: 'curator_outcome', projectId, falseClose: true }, humanExec);
check('curator_outcome records a false close', outcome.ok === true && outcome.falseCloses >= 1, JSON.stringify(outcome));
const cannotExecute = await call({ action: 'curator_outcome', projectId, apply: true }, humanExec);
check('curator_outcome refuses execution', cannotExecute.ok === false && cannotExecute.error?.code === 'curator_cannot_execute', JSON.stringify(cannotExecute));

// Claims and reviews are real: an active review claim on d1 must exclude it.
const claimedService = createLabService({
  ctx: { effect: () => {}, get: () => null, logger: { info() {}, warn() {} } }, store, kernel, git: null, runtime: null,
  transcript: null, orchestrator: { reviewClaims: { list: () => [{ nodeId: 'd1', intent: 'review', expiresAt: Date.now() + 60_000 }] } }, auto: null, cluster: null, clusterAdmin: null,
});
const claimedNomination = await claimedService.nominateDuplicates(projectId, {}, curatorExec);
check('curator excludes actively claimed/reviewed nodes', claimedNomination.ok === true && claimedNomination.nominations.every((row) => row.nodeId !== 'd1' && row.duplicateOf !== 'd1'), JSON.stringify(claimedNomination.nominations));

// Intent TTL, withdraw, stale-basis conflict and child auto-withdraw.
const parentIntent = await call({ action: 'intent_submit', projectId, kind: 'curate', nodeId: 'd1', claim: { action: 'nominate_close', nominations: [{ nodeId: 'd1', duplicateOf: 'd2' }] } }, curatorExec);
check('intent has a TTL and pending status', parentIntent.intent?.status === 'pending' && parentIntent.intent?.expiresAt > Date.now(), JSON.stringify(parentIntent.intent));
await kernel.executor.commit(projectId, {
  actor: { kind: 'human', id: 'test' },
  mutations: [{ op: 'node.create', node: { id: 'child-of-d1', title: 'child', status: 'planned', parentId: 'd1', timestamps: { createdAt: Date.now() } } }],
});
const withdrawnByChild = (store.getProject(projectId).intents ?? []).find((intent) => intent.id === parentIntent.intent.id);
check('child creation auto-withdraws the parent nomination', withdrawnByChild?.status === 'withdrawn' && /child/.test(withdrawnByChild.withdrawReason ?? ''), JSON.stringify(withdrawnByChild));
const withdrawalEvent = store.listEvents(projectId, 0).find((event) => event.type === 'nomination/withdrawn' && event.data?.intentId === parentIntent.intent.id);
check('child creation writes nomination/withdrawn{reason:child_created}', withdrawalEvent?.data?.reason === 'child_created' && withdrawalEvent?.data?.childId === 'child-of-d1', JSON.stringify(withdrawalEvent?.data));
const manualNomination = await call({ action: 'intent_submit', projectId, kind: 'curate', nodeId: 'd1', claim: { action: 'nominate_close', nominations: [{ nodeId: 'd1', duplicateOf: 'd2' }] } }, curatorExec);
const manualWithdrawn = await call({ action: 'intent_withdraw', projectId, intentId: manualNomination.intent.id }, curatorExec);
check('manual curator withdrawal is a nomination/withdrawn event', manualWithdrawn.ok === true && store.listEvents(projectId, 0).some((event) => event.type === 'nomination/withdrawn' && event.data?.intentId === manualNomination.intent.id), JSON.stringify(manualWithdrawn));
const withdrawTarget = await call({ action: 'intent_submit', projectId, kind: 'note', nodeId: 'd1', claim: { action: 'observe' } }, curatorExec);
const withdrawn = await call({ action: 'intent_withdraw', projectId, intentId: withdrawTarget.intent.id }, curatorExec);
check('intent_withdraw marks the record withdrawn', withdrawn.ok === true && withdrawn.intent?.status === 'withdrawn', JSON.stringify(withdrawn));
const newer = await call({ action: 'intent_submit', projectId, kind: 'note', nodeId: 'd1', claim: { action: 'newer' } }, curatorExec);
const stale = await call({ action: 'intent_submit', projectId, kind: 'note', nodeId: 'd1', claim: { action: 'stale' }, basis: { projectRevision: 0, snapshotAgeMs: 0, nodesSeen: 2 } }, curatorExec);
check('stale-basis conflict is resolved with a defined code', stale.ok === false && stale.error?.code === 'stale_basis' && stale.error?.conflictingIntentId === newer.intent.id, JSON.stringify(stale));
// TTL is enforced by the next intent write, not only displayed by list.
await kernel.executor.commit(projectId, {
  actor: { kind: 'human', id: 'test' },
  mutations: [{ op: 'intent.put', intent: { id: 'expired-intent', kind: 'note', status: 'pending', expiresAt: 1, basis: { projectRevision: 0, snapshotAgeMs: 0, nodesSeen: 2 }, actor: { kind: 'expert', id: 'lab-curator' }, claim: { action: 'old' }, target: { nodeId: 'd1' } } }],
});
const afterExpiry = await call({ action: 'intent_submit', projectId, kind: 'note', nodeId: 'd1', claim: { action: 'after-expiry' } }, curatorExec);
const expiredRecord = (store.getProject(projectId).intents ?? []).find((intent) => intent.id === 'expired-intent');
check('intent TTL is enforced with intent/expired', expiredRecord?.status === 'expired' && store.listEvents(projectId, 0).some((event) => event.type === 'intent/expired' && event.data?.intentId === 'expired-intent'), JSON.stringify(expiredRecord));
const reset = await call({ action: 'curator_reset' }, humanExec);
check('curator_reset re-arms the breaker', reset.ok === true && reset.circuitOpen === false, JSON.stringify(reset));
check('expert actions are in the catalog', ACTION_CATALOG.expert_recall === 'read' && ACTION_CATALOG.curator_nominate === 'write');
check('curator may nominate but not close', allowedActions({ kind: 'expert', id: 'c', preset: 'lab-curator' }).includes('curator_nominate') && !allowedActions({ kind: 'expert', id: 'c', preset: 'lab-curator' }).includes('curator_outcome'));

console.log(failed === 0 ? '\nexperts-selftest: all checks passed' : `\nexperts-selftest: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
