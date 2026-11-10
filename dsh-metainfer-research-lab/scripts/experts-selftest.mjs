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
import { nodeSimilarity, recallCandidates, recallExperts } from '../host/experts/similarity.js';
import { applyNomination, createCurator } from '../host/experts/curator.js';
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
check('similarity is symmetric and identical pairs score high', nodeSimilarity(duplicateA, duplicateB) >= 0.89 && nodeSimilarity(duplicateA, duplicateB) === nodeSimilarity(duplicateB, duplicateA) && nodeSimilarity(duplicateA, unrelated) < 0.3);
const first = recallCandidates([duplicateA, duplicateB, unrelated, mergeNode], { threshold: 0.5 });
const second = recallCandidates([duplicateA, duplicateB, unrelated, mergeNode], { threshold: 0.5 });
check('recall finds the known duplicate pair', first.pairs.some((pair) => pair.a === 'n1' && pair.b === 'n2' && pair.kind === 'duplicate'), JSON.stringify(first.pairs));
check('recall is deterministic', JSON.stringify(first) === JSON.stringify(second));
check('recall excludes merge nodes and unrelated pairs', first.pairs.every((pair) => pair.a !== 'n4' && pair.b !== 'n4' && !(pair.a === 'n3' && pair.b === 'n1')), JSON.stringify(first.pairs));
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
check('expert actions are in the catalog', ACTION_CATALOG.expert_recall === 'read' && ACTION_CATALOG.curator_nominate === 'write');
check('curator may nominate but not close', allowedActions({ kind: 'expert', id: 'c', preset: 'lab-curator' }).includes('curator_nominate') && !allowedActions({ kind: 'expert', id: 'c', preset: 'lab-curator' }).includes('curator_outcome'));

console.log(failed === 0 ? '\nexperts-selftest: all checks passed' : `\nexperts-selftest: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
