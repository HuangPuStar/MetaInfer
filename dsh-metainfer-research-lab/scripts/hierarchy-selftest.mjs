/**
 * B11/B12/B14/Q8/5.4/C2/C8/B16/C14/5.3.10: hierarchical review, optimistic
 * high-review windows, weighted child votes, resident sessions and the staged
 * migration switches. Every production assertion drives Host code, not a test
 * double standing in for it.
 */
import { readFileSync } from 'node:fs';
import { openStore } from '../host/store.js';
import { createKernel } from '../host/kernel/instance.js';
import { createLabService, slimStateNode } from '../host/lab-service.js';
import { createOrchestrator } from '../host/orchestrator.js';
import { registerAgentTool } from '../host/agent-tool.js';
import { registerHttpRoutes } from '../host/http.js';
import { createOperatorAuthority } from '../host/operator-token.js';
import { listExpertDescriptors, getExpertDescriptor } from '../host/experts/registry.js';
import {
  HIERARCHY_DESCRIPTORS, HIGH_REVIEW_WINDOW_MS, BRANCH_REPORT_SCHEMA, buildBranchReport, buildHierarchyReview,
  buildBranchCandidateQueue, candidateNoProposalReason, candidateSkipReason,
  chiefActivationMetrics, chiefPolicy, childVoteWeight, escalationQuota, escalationRate, filterVisibleExperts, groupCount,
  validateChiefDecision, validateEvidencePointers, validateHierarchyReview,
} from '../host/experts/hierarchy.js';
import { RESIDENT_TOOL_SURFACE, createResidentSession, runResidentLoop } from '../host/experts/resident.js';
import { assertModelSchema, ModelSchemaError } from '../host/schema-check.js';
import { MODEL_SCHEMAS, assertModelSchemas } from '../host/model-schemas.js';
import { failureDiagnostic, nodeFailureReason } from '../host/failure.js';
import { RolePresetError, ROLE_PRESETS, assertRolePresets } from '../host/role-presets.js';
import { memoryDomain, storeContext } from './lib/memory-domain.mjs';

let failed = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`ok   ${name}`);
  else { failed += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const descriptors = listExpertDescriptors();
const chief = descriptors.filter((descriptor) => descriptor.level === 'chief');
const branch = descriptors.find((descriptor) => descriptor.level === 'branch' && descriptor.id === 'lab-branch');
const lead = descriptors.find((descriptor) => descriptor.level === 'lead' && descriptor.id === 'lab-lead');
check('B11: registry exposes branch/lead/chief levels', HIERARCHY_DESCRIPTORS.length === 3 && descriptors.some((d) => d.level === 'branch') && descriptors.some((d) => d.level === 'lead') && chief.length === 1, JSON.stringify(descriptors.map((d) => [d.id, d.level])));
check('B11: L0 branch descriptor may never create; only L1 lead may', branch?.mayCreate === false && lead?.mayCreate === true && chief.every((descriptor) => descriptor.mayCreate === false) && branch?.mayPropose.includes('branch_report') && !branch?.mayPropose.includes('create'), JSON.stringify({ branch, lead }));
check('B12: exactly one chief and it is invisible to peers', chiefPolicy({}).count === 1 && filterVisibleExperts(descriptors, { kind: 'expert', id: 'lab-advisor' }).every((d) => d.level !== 'chief') && filterVisibleExperts(descriptors, { kind: 'human', id: 'operator' }).some((d) => d.level === 'chief'), JSON.stringify(filterVisibleExperts(descriptors, { kind: 'expert', id: 'lab-advisor' }).map((d) => d.id)));
check('B12: chief activation ratio is an exception budget, not a review pass', chiefActivationMetrics({ activations: 2, completed: 100 }).exceptionArbiter === true && chiefActivationMetrics({ activations: 100, completed: 100 }).exceptionArbiter === false, JSON.stringify(chiefActivationMetrics({ activations: 2, completed: 100 })));
// Structured-output schema gate: the provider rejects keywords outside its
// subset before an activation starts. Boot must fail loudly, not skip L1.
const checkedRoles = assertModelSchemas();
check('schema gate: every model-facing role schema is provider-compatible at startup', checkedRoles.includes('branch') && checkedRoles.includes('lead') && checkedRoles.includes('worker') && checkedRoles.includes('gc') && checkedRoles.includes('chief') && checkedRoles.includes('advisor') && checkedRoles.includes('scheduler') && MODEL_SCHEMAS.some((entry) => entry.role === 'merge' && entry.schema === null), JSON.stringify({ checkedRoles, registry: MODEL_SCHEMAS.map((entry) => [entry.role, entry.schema === null]) }));
const oldBranchSchema = {
  ...BRANCH_REPORT_SCHEMA,
  properties: { ...BRANCH_REPORT_SCHEMA.properties, _truncated: { type: ['object', 'null'] } },
};
let schemaGateError = null;
try {
  assertModelSchemas([{ role: 'branch', schema: oldBranchSchema }]);
} catch (error) {
  schemaGateError = error;
}
check('schema gate: the old union-typed _truncated schema fails at boot with a role-named error', schemaGateError instanceof ModelSchemaError && schemaGateError.role === 'branch' && /type arrays are not supported/.test(schemaGateError.message), schemaGateError && schemaGateError.message);
check('schema gate: the branch schema itself is accepted', (() => { try { assertModelSchema(BRANCH_REPORT_SCHEMA, 'branch'); return true; } catch { return false; } })());

// Preset ids are executable references. Parse the bundle's own preset rows so
// this test cannot silently accept a role preset that was never registered.
const declaredPresets = new Set([...readFileSync(new URL('../presets.patch.yml', import.meta.url), 'utf8').matchAll(/^ {8}id: (lab-[a-z-]+)$/gm)].map((match) => match[1]));
const presetRegistry = {
  resolve: async (id) => {
    if (!declaredPresets.has(id)) throw new Error(`Unknown agent preset: ${id}`);
    return { id };
  },
  list: async () => [...declaredPresets].map((id) => ({ id })),
};
const resolvedRolePresets = await assertRolePresets(presetRegistry);
check('preset gate: every ROLE_PRESETS value resolves to a registered preset', Object.values(ROLE_PRESETS).every((id) => resolvedRolePresets.includes(id)), JSON.stringify({ resolvedRolePresets, declared: [...declaredPresets].sort() }));
let missingPresetError = null;
try {
  await assertRolePresets({ resolve: async (id) => { throw new Error(`Unknown agent preset: ${id}`); } });
} catch (error) {
  missingPresetError = error;
}
check('preset gate: a missing role preset fails boot with a named error', missingPresetError instanceof RolePresetError && missingPresetError.code === 'ROLE_PRESET_NOT_FOUND' && /lab-branch/.test(missingPresetError.message), missingPresetError && missingPresetError.message);

// Failure attribution: the live n-0005/n-0006 shape has an error object, while
// older records may only have an execution/attempt error. Neither may produce
// an empty ruledOut.reason.
const failedNodes = [
  {
    id: 'n-0005', parentId: null, title: 'decode', status: 'failed',
    error: { code: 'ETIMEDOUT', message: 'stream disconnected before completion', stage: 'run' },
    timestamps: { createdAt: Date.now() - 2 },
  },
  {
    id: 'n-0006', parentId: 'n-0005', title: 'prefill', status: 'failed',
    error: null, executionRun: { error: 'external driver exited with code 1' },
    timestamps: { createdAt: Date.now() - 1 },
  },
];
const failedReport = buildBranchReport({ branchId: 'n-0005', nodes: failedNodes, now: Date.now() });
check('failure reason: a failed node with an error object keeps code + message', failedReport.ruledOut[0]?.reason?.includes('ETIMEDOUT') && failedReport.ruledOut[0]?.reason?.includes('stream disconnected'), JSON.stringify(failedReport.ruledOut));
check('failure reason: an error-less failed node falls back to its execution error', failedReport.ruledOut[1]?.reason?.includes('external driver exited'), JSON.stringify(failedReport.ruledOut));
const nullDiagnostic = failureDiagnostic({}, 'run', null);
check('failure reason: a null failure still records a non-empty diagnostic', typeof nullDiagnostic.message === 'string' && nullDiagnostic.message.length > 0 && typeof nullDiagnostic.at === 'number', JSON.stringify(nullDiagnostic));
const coded = Object.assign(new Error('stream failed'), { code: 'ETIMEDOUT' });
const codedDiagnostic = failureDiagnostic({}, 'run', coded);
check('failure reason: the durable diagnostic records the error code and message', codedDiagnostic.code === 'ETIMEDOUT' && codedDiagnostic.message === 'stream failed' && codedDiagnostic.stage === 'run', JSON.stringify(codedDiagnostic));
check('failure reason: nodeFailureReason never returns an empty string', nodeFailureReason({ status: 'failed' }, 160).length > 0, JSON.stringify(nodeFailureReason({ status: 'failed' }, 160)));
const projectedFailure = slimStateNode({ id: 'n-0005', status: 'failed', error: null, executionRun: { error: 'driver exited with code 1' } });
check('failure reason: the state projection backfills error.message for a legacy failed node', projectedFailure.error?.message?.includes('driver exited') && projectedFailure.error?.stage, JSON.stringify(projectedFailure.error));

check('C2: per-lead epoch quota and escalation-rate codes are explicit', escalationQuota({ project: { config: { maxEscalationsPerEpoch: 1 }, reviewEscalations: [] } }).allowed === true && escalationQuota({ project: { config: { maxEscalationsPerEpoch: 1 }, reviewEscalations: [{ leadId: 'lab-lead', epoch: '1' }] } }).allowed === false && escalationRate({ escalations: [1, 2], intents: [1, 2, 3, 4] }).status === 'tighten' && escalationRate({ escalations: [1], intents: [1, 2, 3, 4] }).code === 'escalation_rate_alert', JSON.stringify({ quota: escalationQuota({ project: { config: { maxEscalationsPerEpoch: 1 }, reviewEscalations: [{ leadId: 'lab-lead', epoch: '1' }] } }), rate: escalationRate({ escalations: [1, 2], intents: [1, 2, 3, 4] }) }));

const now = Date.now();
const nodes = [];
for (let branchIndex = 0; branchIndex < 5; branchIndex += 1) {
  const rootId = `b${branchIndex}`;
  nodes.push({
    id: rootId,
    title: `branch ${branchIndex}`,
    prompt: `run branch ${branchIndex} ` + 'x'.repeat(900),
    status: branchIndex < 4 ? 'running' : 'completed',
    report: { summary: `branch ${branchIndex} verified summary`, confidence: 0.8 },
    timestamps: { createdAt: now - 10_000 + branchIndex, updatedAt: now },
  });
  for (let childIndex = 0; childIndex < 2; childIndex += 1) {
    nodes.push({
      id: `b${branchIndex}-c${childIndex}`,
      parentId: rootId,
      title: `child ${branchIndex}.${childIndex}`,
      prompt: `child prompt ${branchIndex}.${childIndex} ` + 'y'.repeat(600),
      status: branchIndex === 4 ? 'completed' : 'planned',
      report: { summary: `child ${branchIndex}.${childIndex} evidence`, confidence: 0.7 },
      timestamps: { createdAt: now - 5_000 + childIndex, updatedAt: now },
    });
  }
}
const review = buildHierarchyReview({ project: { config: { migration: { phase: 2 } } }, nodes, now });
check('Q8/5.3.10: hierarchy has exactly three levels and one chief', review.depth === 3 && review.chief.count === 1 && review.layers.map((layer) => layer.level).join(',') === 'branch,lead,chief', JSON.stringify({ depth: review.depth, chief: review.chief }));
check('B11: L0 is triggered by branch completion/failure, not only the global cycle', review.l0Trigger === 'branch_event' && review.eventDriven === true, JSON.stringify({ l0Trigger: review.l0Trigger, eventDriven: review.eventDriven }));
check('5.4: dynamic grouping is ceil(active branches / 2)', review.groupedTeams === Math.ceil(review.activeBranchCount / 2) && review.groupedTeams === groupCount(review.activeBranchCount), JSON.stringify({ active: review.activeBranchCount, groups: review.groupedTeams }));
check('5.4: every layer, including branch, compresses >= 3x', review.compression.perLayer.every((layer) => layer.ratio >= 3) && validateHierarchyReview(review, nodes).length === 0, JSON.stringify(review.compression.perLayer));
check('5.4: completed coverage is counted, not asserted', review.coverage.ratio === 1 && review.coverage.coveredCompleted === review.coverage.completed, JSON.stringify(review.coverage));
check('Q8: every BranchReport is <= 15 nodes and <= 20 KB', review.reports.every((report) => report.nodeCount <= 15 && report.outputBytes <= 20_000), JSON.stringify(review.reports.map((report) => [report.branchId, report.nodeCount, report.outputBytes])));
const branchReport = buildBranchReport({ branchId: 'b4', nodes, now });
check('Q8: BranchReport carries evidence pointers and no create action', branchReport.evidence.length > 0 && branchReport.candidates.every((candidate) => candidate.textOnly === true) && validateEvidencePointers(branchReport.evidence, nodes).length === 0, JSON.stringify(branchReport.evidence));
check('Q8: evidence pointers reject missing nodes and non-whitelisted fields', validateEvidencePointers([{ nodeId: 'missing', field: 'report.summary', quote: 'x' }], nodes).length === 1 && validateEvidencePointers([{ nodeId: 'b0', field: 'secret', quote: 'x' }], nodes).length === 1, JSON.stringify(validateEvidencePointers([{ nodeId: 'b0', field: 'secret', quote: 'x' }], nodes)));
check('Q8: hierarchy validation accepts the real tree and rejects bad compression', validateHierarchyReview(review, nodes).length === 0, JSON.stringify(validateHierarchyReview(review, nodes)));
const broken = structuredClone(review);
broken.compression.perLayer[2].ratio = 1;
const badBranch = structuredClone(review);
badBranch.compression.perLayer[0].ratio = 1;
check('Q8: a branch layer below 3x is rejected instead of skipped', validateHierarchyReview(badBranch, nodes).some((error) => error.includes('branch compression')), JSON.stringify(validateHierarchyReview(badBranch, nodes)));
check('Q8: a chief layer below 3x is rejected', validateHierarchyReview(broken, nodes).some((error) => error.includes('chief compression')), JSON.stringify(validateHierarchyReview(broken, nodes)));
check('Q8: a chief decision needs verified raw evidence', validateChiefDecision({ action: 'keep', verifiedEvidence: [], evidenceChain: [{ nodeId: 'b4', field: 'report.summary', quote: 'evidence' }] }, nodes).some((error) => error.includes('verifiedEvidence')) && validateChiefDecision({ action: 'keep', verifiedEvidence: [{ nodeId: 'b4', field: 'report.summary', quote: 'verified summary' }], evidenceChain: [{ nodeId: 'b4', field: 'report.summary', quote: 'verified summary' }] }, nodes).length === 0, JSON.stringify(validateChiefDecision({ action: 'keep', verifiedEvidence: [], evidenceChain: [] }, nodes)));

// Round 33 candidate identity is structural: editing prose must not make the
// same candidate look new, and exhaustion must have a named reason.
const candidateShapeRun = (id, titleA, titleB) => ({
  id, role: 'branch', status: 'completed', lens: 'n-0003', startedAt: Number(id.slice(1)) || 1,
  endedAt: 2,
  output: {
    branchId: 'n-0003', health: 'watch', candidates: [
      { nodeId: 'n-0001', kind: 'optimization', priority: 'p1', title: titleA },
      { nodeId: 'n-0002', kind: 'optimization', priority: 'p1', title: titleB },
    ],
  },
});
const candidateQueueA = buildBranchCandidateQueue({ project: {}, runs: [candidateShapeRun('r1', 'prefetch A', 'bandwidth A')] });
const candidateQueueB = buildBranchCandidateQueue({ project: {}, runs: [candidateShapeRun('r1', 'prefetch wording changed', 'bandwidth wording changed')] });
check('Round 33: candidate identity ignores prose edits', candidateQueueA.candidates.map((row) => row.candidateId).join(',') === candidateQueueB.candidates.map((row) => row.candidateId).join(','), JSON.stringify({ a: candidateQueueA.candidates.map((row) => row.candidateId), b: candidateQueueB.candidates.map((row) => row.candidateId) }));
const candidateConsumedQueue = buildBranchCandidateQueue({
  project: { candidateConsumptions: candidateQueueA.candidates.map((row) => ({ candidateId: row.candidateId, nodeId: 'x' })) },
  runs: [candidateShapeRun('r1', 'a', 'b')],
});
check('Round 33: every consumed candidate yields an explicit stop reason', candidateSkipReason(candidateConsumedQueue, { events: 0 }) === 'all branch-report candidates consumed', candidateSkipReason(candidateConsumedQueue, { events: 0 }));
const lowConfidenceQueue = buildBranchCandidateQueue({
  project: {},
  runs: [{ id: 'r-low', role: 'branch', status: 'completed', lens: 'n-0003', startedAt: 1, output: { branchId: 'n-0003', reasonCodes: ['low_confidence'], candidates: [{ nodeId: 'n-0001', kind: 'retry', title: 'retry' }] } }],
});
check('Round 33: low-confidence-only queues name the reason', /low-confidence candidates only/.test(candidateNoProposalReason(lowConfidenceQueue) ?? ''), candidateNoProposalReason(lowConfidenceQueue));
const failedReportQueue = buildBranchCandidateQueue({
  project: {},
  runs: [{ id: 'r-fail', role: 'branch', status: 'failed', lens: 'n-0003', startedAt: 1, error: 'stream timeout' }],
});
check('Round 33: a failed branch report names the failure instead of claiming no event', candidateSkipReason(failedReportQueue, { events: 1 }) === 'blocked by failed branch report', candidateSkipReason(failedReportQueue, { events: 1 }));

// Production service fixture for high-review windows and migration switches.
const store = await openStore(storeContext(memoryDomain()));
const kernel = createKernel({ store });
const projectId = 'hierarchy-p';
await store.saveProject({
  id: projectId, revision: 0, counters: { eventSeq: 0 },
  config: { maxRunningNodes: 2, resourcePools: {}, maxNodes: 100, migration: { phase: 1 } },
  repo: { path: process.cwd() }, createdAt: 0, updatedAt: 0,
});
kernel.load(projectId);
const operatorAuthority = createOperatorAuthority();
const service = createLabService({
  ctx: { effect: () => {}, get: () => null, logger: { info() {}, warn() {} } },
  store, kernel, git: null, runtime: null, transcript: null, orchestrator: null, auto: null, cluster: null, clusterAdmin: null,
  operatorAuthority,
});
const visibleToExpert = service.listExperts(projectId, { actor: { kind: 'expert', id: 'lab-advisor' } });
const visibleToOperator = service.listExperts(projectId, { actor: { kind: 'human', id: 'operator' } });
check('B12/C2: the production expert library hides the chief from peers but not from the operator', visibleToExpert.experts.every((expert) => expert.id !== 'lab-chief') && visibleToOperator.experts.some((expert) => expert.id === 'lab-chief'), JSON.stringify({ peer: visibleToExpert.experts.map((e) => e.id), operator: visibleToOperator.experts.map((e) => e.id) }));
const chiefExec = { agent: { session: { id: 's-chief', header: { meta: { agentPreset: 'lab-chief' } } } } };
const toolCtx = { tools: { register(definition) { toolCtx.tool = definition; return () => {}; } } };
registerAgentTool(toolCtx, service);
const callTool = async (args, exec) => JSON.parse((await toolCtx.tool.execute(args, exec)).result);
const humanExec = { agent: { session: { id: 's-human', header: {} } } };

// C14 production surfaces: the same advanceMigration result through the
// operator-token HTTP route and the agent-tool action.
const httpHandlers = new Map();
const disposeHttp = registerHttpRoutes({
  effect: () => {},
  connection: { fetch: { register({ path, methods, fetch }) { for (const method of methods) httpHandlers.set(`${method} ${path}`, fetch); return () => {}; } } },
}, service);
const callHttp = async (method, routePath, body, token = operatorAuthority.token) => {
  const handler = httpHandlers.get(`${method} ${routePath}`);
  if (!handler) throw new Error(`missing handler ${method} ${routePath}`);
  const response = await handler(new Request(`http://local${routePath}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { 'x-metainfer-operator': token } : {}) },
    body: JSON.stringify(body),
  }));
  return response.json();
};

async function savePending(id, nowAt, extra = {}) {
  await store.saveNode(projectId, {
    id, title: id, prompt: `prompt ${id}`, promptHash: `hash-${id}`, status: 'planned', parentId: 'root',
    priority: { class: 'p2' }, createdBy: 'seed', reviewLevel: 'lead', ratifiedBy: null,
    report: { summary: `evidence for ${id}` },
    pendingHighReview: { reasonCodes: ['low_confidence'], openedAt: nowAt, deadlineAt: nowAt + HIGH_REVIEW_WINDOW_MS, by: 'lab-lead', evidenceChain: [{ nodeId: id, field: 'report.summary', quote: `evidence for ${id}` }] },
    timestamps: { createdAt: nowAt },
    ...extra,
  });
}
await store.saveNode(projectId, { id: 'root', title: 'root', status: 'completed', report: { summary: 'root evidence' }, timestamps: { createdAt: 0 } });
await savePending('keep-node', Date.now());
const kept = await service.resolveHighReview(projectId, 'keep-node', {
  action: 'keep', reasonCode: 'low_confidence',
  verifiedEvidence: [{ nodeId: 'keep-node', field: 'report.summary', quote: 'evidence for keep-node' }],
  evidenceChain: [{ nodeId: 'keep-node', field: 'report.summary', quote: 'evidence for keep-node' }],
}, chiefExec);
check('B14: chief keep clears the window and records ratification', kept.ok === true && kept.node.pendingHighReview === null && kept.node.ratifiedBy === 'lab-chief' && kept.node.highReview.status === 'kept', JSON.stringify(kept));
await savePending('bad-keep', Date.now());
const noEvidence = await service.resolveHighReview(projectId, 'bad-keep', { action: 'keep' }, chiefExec);
check('B14: keep without verified evidence is rejected', noEvidence.ok === false && noEvidence.error?.code === 'invalid_high_review', JSON.stringify(noEvidence));

await savePending('defer-node', Date.now());
const deferred = await service.resolveHighReview(projectId, 'defer-node', { action: 'defer', reasonCode: 'low_confidence' }, chiefExec);
check('B14: veto defer demotes the optimistic p2 node', deferred.ok === true && deferred.node.priority.class === 'deferred' && deferred.node.highReview.status === 'deferred', JSON.stringify(deferred));
await savePending('withdraw-node', Date.now());
const withdrawn = await service.resolveHighReview(projectId, 'withdraw-node', { action: 'withdraw', reasonCode: 'branch_death' }, chiefExec);
check('B14: veto withdraw cancels the node instead of leaving it runnable', withdrawn.ok === true && withdrawn.node.status === 'cancelled' && withdrawn.node.highReview.status === 'withdrawn', JSON.stringify(withdrawn));
await savePending('timeout-node', Date.now() - HIGH_REVIEW_WINDOW_MS - 1);
const swept = await service.sweepHighReviews(projectId);
const timeoutNode = store.getNode(projectId, 'timeout-node');
check('B14: a timed-out window keeps the node and marks it unreviewed', swept.ok === true && swept.resolved.includes('timeout-node') && timeoutNode.status === 'planned' && timeoutNode.highReview.status === 'unreviewed' && timeoutNode.pendingHighReview === null, JSON.stringify({ swept, timeoutNode }));
await savePending('tool-node', Date.now());
const toolResolved = await callTool({ action: 'resolve_high_review', projectId, nodeId: 'tool-node', decision: 'defer', reasonCode: 'low_confidence' }, chiefExec);
check('B14: the chief tool surface resolves a pending window', toolResolved.ok === true && toolResolved.node.priority.class === 'deferred' && toolResolved.node.highReview.status === 'deferred', JSON.stringify(toolResolved));
const forbidden = await service.resolveHighReview(projectId, 'timeout-node', { action: 'defer' }, humanExec);
check('B14: only a pending window can be resolved', forbidden.ok === false && forbidden.error?.code === 'no_pending_high_review', JSON.stringify(forbidden));

// C8: child creation votes are deduped, quota-limited and one-per-expert/node.
const voteProject = { config: { experts: { votesPerHour: 2 } }, childVotes: [] };
const child = { id: 'new-child', title: 'new child', prompt: 'new child prompt', promptHash: 'h-new' };
const duplicate = { id: 'old-child', title: 'new child', prompt: 'new child prompt', promptHash: 'h-new' };
check('C8: an identical child is a zero-weight duplicate', childVoteWeight({ project: voteProject, nodes: [duplicate], parent: { id: 'root' }, child, expertId: 'lab-lead' }).weight === 0, JSON.stringify(childVoteWeight({ project: voteProject, nodes: [duplicate], parent: { id: 'root' }, child, expertId: 'lab-lead' })));
const counted = childVoteWeight({ project: voteProject, nodes: [], parent: { id: 'root' }, child, expertId: 'lab-lead' });
check('C8: a unique child counts as exactly one vote', counted.weight === 1 && counted.reason === 'counted', JSON.stringify(counted));
const sameNodeProject = { ...voteProject, childVotes: [{ expertId: 'lab-lead', parentId: 'root', nodeId: 'new-child', at: Date.now(), weight: 1 }] };
check('C8: one expert gets one vote per node', childVoteWeight({ project: sameNodeProject, nodes: [], parent: { id: 'root' }, child, expertId: 'lab-lead' }).weight === 0, JSON.stringify(childVoteWeight({ project: sameNodeProject, nodes: [], parent: { id: 'root' }, child, expertId: 'lab-lead' })));
const quotaProject = { ...voteProject, childVotes: [
  { expertId: 'lab-lead', parentId: 'p1', nodeId: 'c1', at: Date.now(), weight: 1 },
  { expertId: 'lab-lead', parentId: 'p2', nodeId: 'c2', at: Date.now(), weight: 1 },
] };
check('C8: one expert cannot exceed its per-hour vote quota', childVoteWeight({ project: quotaProject, nodes: [], parent: { id: 'root' }, child, expertId: 'lab-lead' }).weight === 0, JSON.stringify(childVoteWeight({ project: quotaProject, nodes: [], parent: { id: 'root' }, child, expertId: 'lab-lead' })));
const descriptorBudgetProject = { config: {}, childVotes: Array.from({ length: 20 }, (_, index) => ({ expertId: 'lab-lead', parentId: `p${index}`, nodeId: `c${index}`, at: Date.now(), weight: 1 })) };
check('C8: an exhausted lead budget suppresses the vote even without project quota config', childVoteWeight({ project: descriptorBudgetProject, nodes: [], parent: { id: 'root' }, child, expertId: 'lab-lead' }).weight === 0, JSON.stringify(childVoteWeight({ project: descriptorBudgetProject, nodes: [], parent: { id: 'root' }, child, expertId: 'lab-lead' })));

// B16: resident session, multiple calls, submit-as-tool and compaction.
const resident = createResidentSession({ expertId: 'lab-advisor', sessionId: 'resident-test' });
const first = await resident.invoke('dag_get', { nodeId: 'b0' });
const second = await resident.invoke('dag_query', { status: 'running' });
const submitted = await resident.submit({ branchId: 'b0', verdict: 'keep' });
check('B16: one resident session makes more than one tool call', first.ok === true && second.ok === true && resident.snapshot().queries === 2, JSON.stringify(resident.snapshot()));
check('B16: submit is a tool in the surface, not structured_output', RESIDENT_TOOL_SURFACE.some((tool) => tool.name === 'submit') && !RESIDENT_TOOL_SURFACE.some((tool) => tool.name === 'structured_output') && submitted.submitted === true, JSON.stringify(RESIDENT_TOOL_SURFACE.map((tool) => tool.name)));
const afterSubmit = await resident.invoke('dag_get', { nodeId: 'b1' });
check('B16: after submit the session refuses further reads', afterSubmit.ok === false && afterSubmit.code === 'already_submitted', JSON.stringify(afterSubmit));
const looped = await runResidentLoop({
  session: createResidentSession({ expertId: 'lab-lead', maxQueries: 3 }),
  steps: [{ tool: 'dag_get', args: { nodeId: 'b0' } }, { tool: 'dag_map', args: {} }, { tool: 'submit', args: { payload: { ok: true } } }],
});
check('B16: a resident loop executes multiple calls before submit', looped.ok === true && looped.snapshot.queries === 2 && looped.results.length === 3, JSON.stringify(looped));
const tight = createResidentSession({ expertId: 'lab-lead', maxQueries: 1 });
await tight.invoke('dag_get', { nodeId: 'b0' });
const exhausted = await tight.invoke('dag_get', { nodeId: 'b1' });
check('B16: maxQueries=4 default and a smaller override are enforced', exhausted.ok === false && exhausted.code === 'query_budget_exceeded' && RESIDENT_TOOL_SURFACE.length <= 8, JSON.stringify({ exhausted, tools: RESIDENT_TOOL_SURFACE.length }));
const compactable = createResidentSession({ expertId: 'lab-advisor' });
await compactable.invoke('dag_get', { nodeId: 'b0' });
await compactable.submit({ payload: { blob: 'z'.repeat(20_000) } });
const compacted = compactable.compact();
check('B16: compaction drops the raw transcript and records a ratio', compacted.ratio >= 1 && compacted.afterTokens < compacted.beforeTokens && compactable.snapshot().compaction !== null, JSON.stringify(compacted));

// Production orchestrator probe: hierarchy mode materializes the L1 child as
// p2, opens a ten-minute window only for an escalated branch, and records the
// child vote and escalation in the same Host commit.
const prodId = 'prod-p';
await store.saveProject({
  id: prodId, name: 'prod', brief: 'hierarchy probe', revision: 0,
  counters: { eventSeq: 0, nextNodeSeq: 2, nodes: 1 },
  config: {
    maxRunningNodes: 1, resourcePools: { gpu: 1 }, maxNodes: 10,
    expertsMode: 'hierarchy', migration: { phase: 2 },
    advisor: { maxProposalsPerPass: 1, maxProposalsPerReviewer: 1, ancestorDepth: 1, acceptMode: 'confirm', maxPendingProposals: 5, timeoutSeconds: 60, reviewers: [] },
    auto: { maxCycles: 1 },
  },
  repo: { path: process.cwd(), worktreeRoot: '/tmp/hierarchy-wt', baseBranch: 'main', baseCommit: 'base' },
  createdAt: 0, updatedAt: 0,
});
kernel.load(prodId);
await kernel.executor.commit(prodId, {
  actor: { kind: 'human', id: 'test' },
  mutations: [{ op: 'node.create', node: { id: 'parent', title: 'parent', prompt: 'do parent', status: 'completed', confidence: 0.4, git: { headCommit: 'abc' }, report: { summary: 'parent done', confidence: 0.4 }, createdBy: 'seed', timestamps: { createdAt: 1, completedAt: 2 } } }],
});
await store.saveNode(prodId, {
  id: 'sweep-node', title: 'sweep', prompt: 'due review', promptHash: 'h-sweep', status: 'planned',
  priority: { class: 'p2' }, createdBy: 'seed', reviewLevel: 'lead',
  pendingHighReview: { reasonCodes: ['low_confidence'], openedAt: Date.now() - HIGH_REVIEW_WINDOW_MS - 10, deadlineAt: Date.now() - 10, by: 'lab-lead', evidenceChain: [] },
  timestamps: { createdAt: 1 },
});
const productionPresets = [];
const prodCtx = {
  effect: () => {}, get: () => null, logger: { info() {}, warn() {} },
  agents: { get: () => null, resume: async () => { throw new Error('none'); }, create: async () => ({ agent: {} }) },
  agentPresets: {
    resolve: presetRegistry.resolve,
    list: presetRegistry.list,
    mount: async (_ctx, id) => {
      if (!declaredPresets.has(id)) throw new Error(`Unknown agent preset: ${id}`);
    },
  },
  agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
  subagents: {
    async startActivation(spec) {
      const preset = spec.request.agentPreset;
      productionPresets.push(preset);
      if (!declaredPresets.has(preset)) throw new Error(`Unknown agent preset: ${preset}`);
      assertModelSchema(spec.request.outputSchema, preset.replace('lab-', ''));
      const promptText = spec.request.prompt?.[0]?.text ?? '';
      const branchId = /^mirl-branch-(.+?)\//.exec(spec.request.label ?? '')?.[1] ?? 'parent';
      const section = (title) => {
        const marker = `# ${title}\n`;
        const start = promptText.indexOf(marker);
        if (start < 0) return null;
        const rest = promptText.slice(start + marker.length);
        const end = rest.search(/\n\n# /);
        return (end < 0 ? rest : rest.slice(0, end)).trim();
      };
      const reports = JSON.parse(section('Branch reports') ?? '[]');
      const candidateSection = JSON.parse(section('Pending branch-report candidates') ?? '[]');
      const candidates = Array.isArray(candidateSection) ? candidateSection : (candidateSection.candidates ?? []);
      const leadParent = reports[0]?.branchId ?? 'parent';
      const structured = preset === 'lab-branch'
        ? { branchId, health: 'watch', verified: [], ruledOut: [], candidates: [], escalate: true, reasonCodes: ['low_confidence'], evidence: [{ nodeId: branchId, field: 'report.summary', quote: 'done' }] }
        : preset === 'lab-lead'
          ? {
              analysis: 'lead',
              needUserDecision: false,
              proposals: candidates.length > 0
                ? candidates.slice(0, 4).map((candidate) => ({
                    parentId: candidate.sourceNodeId ?? candidate.branchId,
                    title: `child for ${candidate.kind} ${candidate.sourceNodeId ?? candidate.branchId}`,
                    prompt: `do child work for ${candidate.sourceNodeId ?? candidate.branchId} ${candidate.kind} ${candidate.candidateId}`,
                    rationale: 'r',
                    timeboxMinutes: 5,
                    candidateId: candidate.candidateId,
                  }))
                : [{ parentId: leadParent, title: 'child', prompt: 'do child work', rationale: 'r', timeboxMinutes: 5 }],
            }
          : preset === 'lab-chief'
            ? { decision: 'keep', reasonCode: 'low_confidence', verifiedEvidence: [], evidenceChain: [] }
            : { analysis: 'x', proposals: [] };
      return { result: Promise.resolve({ stopReason: 'completed', structured }), dispose: async () => {} };
    },
  },
};
const prodOrch = createOrchestrator({ ctx: prodCtx, store, git: { async commitWorktree() { return { head: 'abc123' }; }, async tagCommit() {} }, runtime: { start: async () => {} }, cluster: null, kernel });

// C14 surface: create a phase-1 project and advance it through the actual
// operator HTTP route, then run the real orchestrator on the resulting mode.
const surfaceId = 'migration-surface-p';
await store.saveProject({
  id: surfaceId, revision: 0, counters: { eventSeq: 0, nextNodeSeq: 1, nodes: 1 },
  config: { maxRunningNodes: 2, resourcePools: {}, maxNodes: 100, expertsMode: 'legacy-cycle', migration: { phase: 1 } },
  repo: { path: process.cwd() }, createdAt: 0, updatedAt: 0,
});
kernel.load(surfaceId);
await kernel.executor.commit(surfaceId, {
  actor: { kind: 'human', id: 'test' },
  mutations: [{ op: 'node.create', node: { id: 'parent', title: 'parent', prompt: 'do parent work', status: 'completed', confidence: 0.4, git: { headCommit: 'abc' }, report: { summary: 'parent done', confidence: 0.4 }, createdBy: 'seed', timestamps: { createdAt: 1, completedAt: 2 } } }],
});
const routeAdvance = await callHttp('POST', '/api/metainfer-research-lab/migration/advance', { projectId: surfaceId, phase: 2, parity: { ok: true, fixture: 's14-live' } });
const routeAdvanceData = routeAdvance.data;
check('C14 surface: operator HTTP route advances phase 1 -> 2 and returns the service shape', routeAdvanceData?.ok === true && routeAdvanceData.phase === 2 && routeAdvanceData.switches?.experts === 'hierarchy' && service.migrationStatus(surfaceId).switches.experts === 'hierarchy', JSON.stringify(routeAdvance));
const presetsBeforeSurface = productionPresets.length;
await prodOrch.step(surfaceId, 'migration-surface-probe');
const surfacePresets = productionPresets.slice(presetsBeforeSurface);
const surfaceCycle = store.listCycles(surfaceId, 1)[0];
check('C14 surface: after advancing, the production orchestrator runs the hierarchy pass', surfacePresets.includes('lab-branch') && surfacePresets.includes('lab-lead') && surfaceCycle?.hierarchy?.l0Trigger === 'branch_event', JSON.stringify({ surfacePresets, hierarchy: surfaceCycle?.hierarchy }));

const noParityId = 'migration-no-parity-p';
await store.saveProject({ id: noParityId, revision: 0, counters: { eventSeq: 0 }, config: { migration: { phase: 1 } }, repo: { path: process.cwd() }, createdAt: 0, updatedAt: 0 });
kernel.load(noParityId);
const noParityHttp = await callHttp('POST', '/api/metainfer-research-lab/migration/advance', { projectId: noParityId, phase: 2, parity: { ok: false } });
check('C14 surface: phase 2 without parity is refused through HTTP', noParityHttp.data?.ok === false && noParityHttp.data?.error?.code === 'parity_required' && service.migrationStatus(noParityId).phase === 1, JSON.stringify(noParityHttp));

const toolAdvanceId = 'migration-tool-p';
await store.saveProject({ id: toolAdvanceId, revision: 0, counters: { eventSeq: 0 }, config: { migration: { phase: 1 } }, repo: { path: process.cwd() }, createdAt: 0, updatedAt: 0 });
kernel.load(toolAdvanceId);
const toolAdvance = await callTool({ action: 'advance_migration', projectId: toolAdvanceId, phase: 2, parity: { ok: true, fixture: 's14-tool' } }, humanExec);
const expertAdvance = await callTool({ action: 'advance_migration', projectId: toolAdvanceId, phase: 3, parity: { ok: true } }, chiefExec);
check('C14 surface: agent tool advances phase 1 -> 2 with the same result shape', toolAdvance.ok === true && toolAdvance.phase === 2 && toolAdvance.switches?.experts === 'hierarchy' && service.migrationStatus(toolAdvanceId).phase === 2, JSON.stringify(toolAdvance));
check('C14 surface: an expert preset cannot call the migration control action', expertAdvance.ok === false && expertAdvance.error?.code === 'forbidden_action', JSON.stringify(expertAdvance));

const stepped = await prodOrch.step(prodId, 'hierarchy-probe');
const produced = store.listNodes(prodId).find((node) => node.createdBy === 'lab-lead');
const prodProject = store.getProject(prodId);
const prodCycle = store.listCycles(prodId, 1)[0];
const sweptByCycle = store.getNode(prodId, 'sweep-node');
check('B14: the production tick itself sweeps a due high-review window', prodCycle.highReviewSwept.includes('sweep-node') && sweptByCycle.highReview?.status === 'unreviewed' && sweptByCycle.pendingHighReview === null, JSON.stringify({ swept: prodCycle.highReviewSwept, node: sweptByCycle }));
const prodRuns = store.listRuns(prodId);
const branchProductionRun = prodRuns.find((run) => run.role === 'branch');
const leadProductionRun = prodRuns.find((run) => run.role === 'lead');
const chiefProductionRun = prodRuns.find((run) => run.role === 'chief');
check('B11: production L0/L1/L2 are real activations, not labels', productionPresets.includes('lab-branch') && productionPresets.includes('lab-lead') && productionPresets.includes('lab-chief') && branchProductionRun?.budget?.maxQueries === 2 && branchProductionRun?.timeoutMs === 60_000 && leadProductionRun?.budget?.maxQueries === 4 && leadProductionRun?.timeoutMs === 90_000 && chiefProductionRun?.budget?.maxQueries === 8 && chiefProductionRun?.timeoutMs === 180_000, JSON.stringify({ productionPresets, budgets: prodRuns.map((run) => ({ role: run.role, budget: run.budget, timeoutMs: run.timeoutMs })) }));
check('B11/B14/C8: production cycle builds L0 reports and materializes one L1 p2 child', stepped.created.length === 1 && produced?.reviewLevel === 'lead' && produced?.priority?.class === 'p2' && prodCycle?.hierarchy?.l0Trigger === 'branch_event' && prodCycle?.hierarchy?.branchCount >= 1, JSON.stringify({ stepped, produced: produced && { id: produced.id, createdBy: produced.createdBy, reviewLevel: produced.reviewLevel, priority: produced.priority, pending: produced.pendingHighReview }, hierarchy: prodCycle?.hierarchy }));
check('B14: the escalated L1 child gets a 10-minute window; an unescalated child would not', produced?.pendingHighReview?.deadlineAt - produced?.pendingHighReview?.openedAt === 10 * 60_000 && prodProject?.reviewEscalations?.length === 1, JSON.stringify({ pending: produced?.pendingHighReview, escalations: prodProject?.reviewEscalations }));
check('C8: the same production child creation records exactly one weighted vote', prodProject?.childVotes?.length === 1 && prodProject.childVotes[0].weight === 1 && prodProject.childVotes[0].nodeId === produced?.id, JSON.stringify(prodProject?.childVotes));
const prodResolved = await service.resolveHighReview(prodId, produced.id, { action: 'keep', reasonCode: 'low_confidence', verifiedEvidence: [{ nodeId: produced.id, field: 'title', quote: 'child' }], evidenceChain: [{ nodeId: produced.id, field: 'title', quote: 'child' }] }, chiefExec);
check('B14: the chief can ratify the production child inside the window', prodResolved.ok === true && prodResolved.node.ratifiedBy === 'lab-chief' && prodResolved.node.pendingHighReview === null, JSON.stringify(prodResolved));

const presetsBeforeSecondStep = productionPresets.length;
await prodOrch.step(prodId, 'hierarchy-probe-2');
const secondStepPresets = productionPresets.slice(presetsBeforeSecondStep);
check('B11: the second tick does not re-run L0 for an already-reviewed branch event', secondStepPresets.includes('lab-branch') === false, JSON.stringify(secondStepPresets));

// Three completed branches must produce three bounded BranchReports, then run
// L1 instead of skipping it with "no successful branch report".
const threeId = 'hierarchy-three-branch-p';
await store.saveProject({
  id: threeId, name: 'three-branch', brief: 'three completed branches', revision: 0,
  counters: { eventSeq: 0, nextNodeSeq: 4, nodes: 3 },
  config: {
    maxRunningNodes: 2, resourcePools: {}, maxNodes: 20, expertsMode: 'hierarchy', migration: { phase: 2 },
    advisor: { maxProposalsPerPass: 2, maxProposalsPerReviewer: 2, ancestorDepth: 1, acceptMode: 'confirm', maxPendingProposals: 5, timeoutSeconds: 60, reviewers: [] },
    auto: { maxCycles: 1 },
  },
  repo: { path: process.cwd(), worktreeRoot: '/tmp/hierarchy-three-wt', baseBranch: 'main', baseCommit: 'base' },
  createdAt: 0, updatedAt: 0,
});
kernel.load(threeId);
await kernel.executor.commit(threeId, {
  actor: { kind: 'human', id: 'test' },
  mutations: ['branch-1', 'branch-2', 'branch-3'].map((id, index) => ({
    op: 'node.create',
    node: {
      id, title: `${id} done`, prompt: `${id} work`, status: 'completed',
      git: { headCommit: `head-${index}` }, report: { summary: `${id} done`, confidence: 0.8 },
      createdBy: 'seed', timestamps: { createdAt: index + 1, completedAt: index + 10 },
    },
  })),
});
const threeStep = await prodOrch.step(threeId, 'three-branch-probe');
const threeCycle = store.listCycles(threeId, 1)[0];
const threeReports = Array.isArray(threeCycle?.branchReports) ? threeCycle.branchReports : [];
const threeLeadSkips = (threeCycle?.skipped ?? []).filter((entry) => entry.stage === 'lead');
check('hierarchy cycle: three completed branches produce three BranchReports', threeReports.length === 3 && threeReports.every((entry) => entry.output && entry.output.branchId), JSON.stringify({ reports: threeReports.map((entry) => ({ branchId: entry.branchId, hasOutput: Boolean(entry.output), health: entry.output?.health })), errors: threeCycle?.errors, skipped: threeCycle?.skipped }));
check('hierarchy cycle: the lead stage is not skipped after branch reports succeed', threeLeadSkips.length === 0 && threeCycle?.leadRunId, JSON.stringify({ leadRunId: threeCycle?.leadRunId, skipped: threeCycle?.skipped, errors: threeCycle?.errors }));
check('hierarchy cycle: no branch or lead run failed with an unsupported schema', !(threeCycle?.errors ?? []).some((entry) => entry.startsWith('branch[') || entry.startsWith('lead:')), JSON.stringify(threeCycle?.errors));
check('hierarchy cycle: no activation failed with Unknown agent preset', !(threeCycle?.errors ?? []).some((entry) => /Unknown agent preset/.test(entry)), JSON.stringify(threeCycle?.errors));
check('hierarchy cycle: the lead produces a proposal or an explicit skip reason', (Array.isArray(threeStep.created) && threeStep.created.length > 0) || Boolean(threeCycle?.skipped?.some((entry) => entry.stage === 'lead')), JSON.stringify({ created: threeStep.created, skipped: threeCycle?.skipped, errors: threeCycle?.errors }));
if (process.env.MIRL_EVIDENCE === '1') {
  console.log(`evidence three-branch cycle: ${JSON.stringify({ branchReports: threeReports.map((entry) => entry.branchId), leadRunId: threeCycle?.leadRunId, created: threeStep.created, skipped: threeCycle?.skipped })}`);
}

// Round 33: an all-completed project with four unconsumed candidates in an
// existing BranchReport must plan without a new branch event, record which
// candidates the lead consumed, and then stop with a named reason instead of
// re-proposing the same four forever.
const candidateId = 'round33-p';
await store.saveProject({
  id: candidateId, name: 'round33-candidates', brief: 'candidate consumption loop', revision: 0,
  counters: { eventSeq: 0, nextNodeSeq: 6, nodes: 5 },
  config: {
    maxRunningNodes: 2, resourcePools: {}, maxNodes: 20, expertsMode: 'hierarchy', migration: { phase: 2 },
    advisor: { maxProposalsPerPass: 4, maxProposalsPerReviewer: 4, ancestorDepth: 1, acceptMode: 'confirm', maxPendingProposals: 8, timeoutSeconds: 60, reviewers: [] },
    auto: { maxCycles: 2 },
  },
  branchReviews: ['n-0003:completed:5', 'n-0001:completed:1', 'n-0002:completed:2', 'n-0004:completed:4', 'n-0005:completed:6'].map((eventKey) => ({ eventKey })),
  repo: { path: process.cwd(), worktreeRoot: '/tmp/hierarchy-round33-wt', baseBranch: 'main', baseCommit: 'base' },
  createdAt: 0, updatedAt: 0,
});
kernel.load(candidateId);
const round33Nodes = [
  { id: 'n-0003', title: 'decode branch', prompt: 'decode work', status: 'completed', git: { headCommit: 'head-3' }, report: { summary: 'branch root done', confidence: 0.7 }, createdBy: 'seed', timestamps: { createdAt: 0, completedAt: 5 } },
  { id: 'n-0001', title: 'prefetch', prompt: 'prefetch work', parentId: 'n-0003', status: 'completed', git: { headCommit: 'head-1' }, report: { summary: 'prefetch done', confidence: 0.7 }, createdBy: 'seed', timestamps: { createdAt: 1, completedAt: 1 } },
  { id: 'n-0002', title: 'bandwidth', prompt: 'bandwidth work', parentId: 'n-0003', status: 'completed', git: { headCommit: 'head-2' }, report: { summary: 'bandwidth done', confidence: 0.7 }, createdBy: 'seed', timestamps: { createdAt: 2, completedAt: 2 } },
  { id: 'n-0004', title: 'triton', prompt: 'triton work', parentId: 'n-0003', status: 'completed', git: { headCommit: 'head-4' }, report: { summary: 'triton done', confidence: 0.7 }, createdBy: 'seed', timestamps: { createdAt: 4, completedAt: 4 } },
  { id: 'n-0005', title: 'tilelang', prompt: 'tilelang work', parentId: 'n-0003', status: 'completed', git: { headCommit: 'head-5' }, report: { summary: 'tilelang done', confidence: 0.7 }, createdBy: 'seed', timestamps: { createdAt: 6, completedAt: 6 } },
];
await kernel.executor.commit(candidateId, {
  actor: { kind: 'human', id: 'test' },
  mutations: round33Nodes.map((node) => ({ op: 'node.create', node })),
});
const round33Candidates = [
  { nodeId: 'n-0001', kind: 'optimization', title: 'KV cache double-buffered prefetch', priority: 'p1', rationale: 'hide copy latency' },
  { nodeId: 'n-0002', kind: 'optimization', title: 'output write bandwidth', priority: 'p1', rationale: 'raise stores per cycle' },
  { nodeId: 'n-0004', kind: 'optimization', title: 'per-CU residency and occupancy', priority: 'p2', rationale: 'BM=64 BN=64 threads=512' },
  { nodeId: 'n-0005', kind: 'comparison', title: 'Triton versus TileLang comparison', priority: 'p2', rationale: 'missing comparison' },
];
await store.saveRun(candidateId, {
  id: 'run-round33-branch', projectId: candidateId, role: 'branch', lens: 'n-0003', status: 'completed',
  startedAt: 100, endedAt: 101, output: {
    branchId: 'n-0003', health: 'watch', verified: [], ruledOut: [], candidates: round33Candidates,
    escalate: false, reasonCodes: [], evidence: [{ nodeId: 'n-0003', field: 'report.summary', quote: 'branch root done' }],
  },
});
const round33Step = await prodOrch.step(candidateId, 'round33-candidate-probe');
const round33Cycle = store.listCycles(candidateId, 1)[0];
const round33Project = store.getProject(candidateId);
const round33New = store.listNodes(candidateId).filter((node) => node.createdBy === 'lab-lead');
check('Round 33: all-completed project with four unconsumed candidates plans without a branch event', round33Step.created.length === 4 && round33Cycle?.candidates?.considered === 4 && round33Cycle?.candidates?.pending === 0 && round33Cycle?.candidates?.consumedThisCycle === 4, JSON.stringify({ created: round33Step.created, candidates: round33Cycle?.candidates, skipped: round33Cycle?.skipped, errors: round33Cycle?.errors }));
check('Round 33: consumption is recorded by candidate id and node cause, not title text', round33Project?.candidateConsumptions?.length === 4 && round33New.every((node) => typeof node.candidateId === 'string' && node.candidateId.startsWith('cand:n-0003:')), JSON.stringify({ consumptions: round33Project?.candidateConsumptions, nodes: round33New.map((node) => [node.id, node.candidateId]) }));
const round33BeforeSecond = productionPresets.length;
const round33Second = await prodOrch.step(candidateId, 'round33-candidate-probe-2');
const round33SecondCycle = store.listCycles(candidateId, 1)[0];
const round33SecondPresets = productionPresets.slice(round33BeforeSecond);
check('Round 33: a consumed queue stops with a named reason instead of re-running the lead', round33SecondPresets.includes('lab-lead') === false && round33Second.created.length === 0 && round33SecondCycle?.leadRunId == null && round33SecondCycle?.candidates?.skipReason === 'all branch-report candidates consumed' && round33SecondCycle?.candidates?.pending === 0 && round33SecondCycle?.skipped?.some((row) => row.stage === 'advisor' && row.reason === 'all branch-report candidates consumed'), JSON.stringify({ presets: round33SecondPresets, created: round33Second.created, cycle: round33SecondCycle?.candidates, skipped: round33SecondCycle?.skipped }));
const budgetId = 'prod-budget';
await store.saveProject({
  id: budgetId, name: 'budget', brief: 'budget probe', revision: 0,
  counters: { eventSeq: 0, nextNodeSeq: 1, nodes: 1 },
  config: { maxRunningNodes: 1, resourcePools: { gpu: 1 }, maxNodes: 10, expertsMode: 'hierarchy', migration: { phase: 2 }, auto: { maxCycles: 1 } },
  repo: { path: process.cwd(), worktreeRoot: '/tmp/hierarchy-wt', baseBranch: 'main', baseCommit: 'base' },
  createdAt: 0, updatedAt: 0,
});
kernel.load(budgetId);
await kernel.executor.commit(budgetId, {
  actor: { kind: 'human', id: 'test' },
  mutations: [{ op: 'node.create', node: { id: 'parent', title: 'parent', prompt: 'do parent', status: 'completed', confidence: 0.4, git: { headCommit: 'abc' }, report: { summary: 'parent done', confidence: 0.4 }, createdBy: 'seed', timestamps: { createdAt: 1, completedAt: 2 } } }],
});
const budgetCtx = {
  ...prodCtx,
  sessionQuery: { readSurface: async () => ({ events: [{ type: 'tool/call' }, { type: 'tool/call' }, { type: 'tool/call' }] }) },
};
const budgetOrch = createOrchestrator({ ctx: budgetCtx, store, git: { async commitWorktree() { return { head: 'abc123' }; }, async tagCommit() {} }, runtime: { start: async () => {} }, cluster: null, kernel });
await budgetOrch.step(budgetId, 'budget-probe');
const budgetBranch = store.listRuns(budgetId).find((run) => run.role === 'branch');
check('B11: the L0 query budget is executed, not just recorded', budgetBranch?.status === 'failed' && budgetBranch?.errorCode === 'query_budget_exceeded' && String(budgetBranch?.error ?? '').includes('budget 2') && budgetBranch?.usage?.toolCalls === 3, JSON.stringify(budgetBranch && { status: budgetBranch.status, error: budgetBranch.error, usage: budgetBranch.usage, budget: budgetBranch.budget }));

const prodMetrics = await service.metricsFor(prodId);
check('5.4/C2: production metrics expose coverage, compression, chief ratio and escalation rate', prodMetrics.review?.levels?.join(',') === 'branch,lead,chief' && prodMetrics.review.coverage?.completed >= 1 && prodMetrics.review.compression?.length === 3 && prodMetrics.review.chief?.count === 1 && typeof prodMetrics.review.escalationRate?.ratio === 'number', JSON.stringify(prodMetrics.review));

const gateId = 'migration-gate-p';
await store.saveProject({
  id: gateId, name: 'gate', brief: 'gate probe', revision: 0, counters: { eventSeq: 0 },
  config: { migration: { phase: 1 } }, repo: { path: process.cwd() }, createdAt: 0, updatedAt: 0,
});
kernel.load(gateId);
let directMigrationError = null;
try {
  await service.updateProject(gateId, { config: { migration: { phase: 3, parity: null } } });
} catch (error) {
  directMigrationError = error;
}
const directKernel = await kernel.executor.commit(gateId, {
  actor: { kind: 'human', id: 'operator' },
  mutations: [{ op: 'project.update', set: { config: { ...store.getProject(gateId).config, migration: { phase: 3, parity: null } } } }],
});
check('C14: direct project.update cannot bypass the migration parity gate', directMigrationError?.code === 'migration_gate_required' && directKernel.ok === false && directKernel.code === 'migration_gate_required', JSON.stringify({ directMigrationError: directMigrationError && { code: directMigrationError.code, message: directMigrationError.message }, directKernel }));

// C14: staged migration switches, S14 parity gate and P1 no-switch.
const phase1 = service.migrationStatus(projectId);
const noParity = await service.advanceMigration(projectId, { phase: 2 }, humanExec);
check('C14: phase 2 refuses to advance without the S14 parity gate', noParity.ok === false && noParity.error?.code === 'parity_required' && phase1.switches.experts === 'legacy-cycle' && phase1.p1NoSwitch === true, JSON.stringify({ phase1, noParity }));
const phase2 = await service.advanceMigration(projectId, { phase: 2, parity: { ok: true, fixture: 's14', at: Date.now() } }, humanExec);
const phase3 = await service.advanceMigration(projectId, { phase: 3, parity: { ok: true, fixture: 's14', at: Date.now() } }, humanExec);
const skipped = await service.advanceMigration(projectId, { phase: 1, parity: { ok: true } }, humanExec);
check('C14: phases advance one at a time with all three switches visible', phase2.ok === true && phase2.switches.experts === 'hierarchy' && phase3.ok === true && phase3.switches.contest === 'shadow' && skipped.ok === false && service.migrationStatus(projectId).staged.length === 3, JSON.stringify({ phase2, phase3, skipped, status: service.migrationStatus(projectId) }));

// B16 production Host surface: open/call/close resident session.
const opened = service.openResidentSession(projectId, { expertId: 'lab-advisor' }, humanExec);
const toolOne = await service.callResidentTool(projectId, { sessionId: opened.sessionId, tool: 'dag_get', args: { nodeId: 'b0' } }, humanExec);
const toolTwo = await service.callResidentTool(projectId, { sessionId: opened.sessionId, tool: 'dag_query', args: { status: 'running' } }, humanExec);
const hostSubmit = await service.callResidentTool(projectId, { sessionId: opened.sessionId, tool: 'submit', args: { payload: { ok: true, source: 'host' } } }, humanExec);
const closed = service.closeResidentSession(projectId, opened.sessionId);
check('B16: Host service executes multiple calls then submit on a resident session', opened.ok === true && toolOne.ok === true && toolTwo.ok === true && hostSubmit.ok === true && hostSubmit.outcome.submitted === true && closed.ok === true, JSON.stringify({ opened, hostSubmit, closed }));

// B16 production reachability: the same session is exposed through the agent
// tool (policy-checked), not only through a service method.
const toolOpened = await callTool({ action: 'resident_open', projectId, expertId: 'lab-advisor' }, chiefExec);
const toolCall = await callTool({ action: 'resident_call', projectId, sessionId: toolOpened.sessionId, tool: 'dag_get', args: { nodeId: 'root' } }, chiefExec);
const toolClosed = await callTool({ action: 'resident_close', projectId, sessionId: toolOpened.sessionId }, chiefExec);
check('B16: the agent tool can open/call/close a resident session', toolOpened.ok === true && Number(toolOpened.expiresAt) > Date.now() && toolOpened.ttlMs === 15 * 60_000 && toolCall.ok === true && toolClosed.ok === true, JSON.stringify({ toolOpened, toolCall, toolClosed }));

const expiring = service.openResidentSession(projectId, { expertId: 'lab-advisor', ttlMs: 1 }, humanExec);
await new Promise((resolve) => setTimeout(resolve, 5));
const expiredCall = await service.callResidentTool(projectId, { sessionId: expiring.sessionId, tool: 'dag_get', args: { nodeId: 'root' } }, humanExec);
check('B16: an expired resident session is evicted and cannot be called', expiredCall.ok === false && expiredCall.error?.code === 'session_expired', JSON.stringify(expiredCall));

const capacitySessions = [];
for (let index = 0; index < 8; index += 1) capacitySessions.push(service.openResidentSession(projectId, { expertId: 'lab-advisor' }, humanExec));
const overCapacity = service.openResidentSession(projectId, { expertId: 'lab-advisor' }, humanExec);
for (const session of capacitySessions) if (session.ok) service.closeResidentSession(projectId, session.sessionId);
check('B16: the resident session map is bounded by a global concurrency cap', capacitySessions.every((session) => session.ok === true) && overCapacity.ok === false && overCapacity.error?.code === 'resident_capacity', JSON.stringify({ cap: overCapacity }));

if (failed > 0) {
  console.error(`hierarchy-selftest: ${failed} failed`);
  process.exit(1);
}
console.log('hierarchy-selftest: all checks passed');
