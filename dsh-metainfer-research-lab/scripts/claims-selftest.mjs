/**
 * B24/B27: the seven atomic predicates, submission-time rejection, and the
 * citationErrorRate permission tiers. Each predicate is mutated independently
 * so a verifier that accepts everything cannot pass.
 */
import { openStore } from '../host/store.js';
import { createKernel } from '../host/kernel/instance.js';
import { createLabService } from '../host/lab-service.js';
import { CLAIM_PREDICATES, citationErrorRate, citationTier, gateClaimAction, verifyClaims } from '../host/kernel/claims.js';
import { memoryDomain, storeContext } from './lib/memory-domain.mjs';

let failed = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`ok   ${name}`);
  else { failed += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const store = await openStore(storeContext(memoryDomain()));
const kernel = createKernel({ store });
const projectId = 'claims-p';
await store.saveProject({ id: projectId, revision: 0, counters: { eventSeq: 0 }, config: {}, createdAt: 0, updatedAt: 0 });
kernel.load(projectId);
await kernel.executor.commit(projectId, {
  actor: { kind: 'human', id: 'test' },
  mutations: [
    { op: 'node.create', node: { id: 'root', title: 'alpha root', status: 'planned', report: { metrics: { gpu: 1 } }, review: { by: 'alice' }, timestamps: { createdAt: 1 } } },
    { op: 'node.create', node: { id: 'child', title: 'beta child', status: 'planned', parentId: 'root', prompt: 'do beta', timestamps: { createdAt: 2 } } },
  ],
});
const nodes = store.listNodes(projectId);
const service = createLabService({
  ctx: { effect: () => {}, get: () => null, logger: { info() {}, warn() {} } },
  store, kernel, git: null, runtime: null, transcript: null, orchestrator: null, auto: null, cluster: null, clusterAdmin: null,
});

const valid = [
  { predicate: 'nodeExists', nodeId: 'child' },
  { predicate: 'statusIs', nodeId: 'child', status: 'planned' },
  { predicate: 'parentOf', parentId: 'root', nodeId: 'child' },
  { predicate: 'metricIs', nodeId: 'root', metric: 'gpu', value: 1 },
  { predicate: 'textContains', nodeId: 'child', field: 'title', text: 'beta' },
  { predicate: 'countWhere', status: 'planned', count: 2 },
  { predicate: 'reviewedBy', nodeId: 'root', reviewer: 'alice' },
];
const validResult = verifyClaims(valid, nodes);
check('all seven predicates verify', CLAIM_PREDICATES.length === 7 && validResult.total === 7 && validResult.failed === 0 && validResult.rate === 0, JSON.stringify(validResult));
check('every predicate has a positive result', validResult.results.every((row) => row.ok && CLAIM_PREDICATES.includes(row.predicate)), JSON.stringify(validResult.results));

const mutations = {
  nodeExists: (row) => { row.nodeId = 'missing'; },
  statusIs: (row) => { row.status = 'completed'; },
  parentOf: (row) => { row.parentId = 'child'; },
  metricIs: (row) => { row.value = 99; },
  textContains: (row) => { row.text = 'not-present'; },
  countWhere: (row) => { row.count = 99; },
  reviewedBy: (row) => { row.reviewer = 'bob'; },
};
for (const predicate of CLAIM_PREDICATES) {
  const one = structuredClone(valid);
  mutations[predicate](one.find((row) => row.predicate === predicate));
  const result = verifyClaims(one, nodes);
  check(`verifier rejects a failing ${predicate}`, result.failed === 1 && result.failures[0]?.predicate === predicate, JSON.stringify(result.failures));
}

check('citationErrorRate is failures / atoms', citationErrorRate(1, 7) === 1 / 7 && citationErrorRate(0, 0) === 0 && citationErrorRate(7, 7) === 1);
check('citation tier boundaries are 5% and 15%', citationTier(0.049) === 'full' && citationTier(0.05) === 'review' && citationTier(0.15) === 'review' && citationTier(0.151) === 'nominate');
check('irreversible actions need evidence', gateClaimAction('cancel_running', { total: 0, failed: 0 }).code === 'claim_evidence_required');
check('a clean claim allows an irreversible action', gateClaimAction('cancel_running', { total: 7, failed: 0 }).ok === true);
check('a dirty claim is downgraded', gateClaimAction('cancel_running', { total: 7, failed: 1 }).code === 'citation_error_rate');

const submit = (claim) => service.submitIntent(projectId, { kind: 'note', nodeId: 'child', claim }, null);
const accepted = await submit({ action: 'observe', evidence: valid });
check('a valid claim set is accepted', accepted.ok === true && accepted.intent?.claim?.verification?.failed === 0, JSON.stringify(accepted));
const irreversible = await submit({ action: 'cancel_running', evidence: valid });
check('clean history permits an irreversible claim', irreversible.ok === true, JSON.stringify(irreversible));

for (const predicate of CLAIM_PREDICATES) {
  const one = structuredClone(valid);
  mutations[predicate](one.find((row) => row.predicate === predicate));
  const rejected = await submit({ action: 'observe', evidence: one });
  check(`submitIntent rejects a failing ${predicate} before writing`, rejected.ok === false && rejected.error?.code === 'claim_invalid'
    && rejected.error?.failures?.some((row) => row.predicate === predicate), JSON.stringify(rejected));
}

const gated = await submit({ action: 'cancel_running', evidence: valid });
check('history above 5% blocks the irreversible action', gated.ok === false && gated.error?.code === 'citation_error_rate' && gated.error?.tier === 'review', JSON.stringify(gated));
const missingEvidence = await submit({ action: 'cancel_running' });
check('an irreversible claim without fresh evidence is still gated', missingEvidence.ok === false && missingEvidence.error?.code === 'citation_error_rate', JSON.stringify(missingEvidence));
const stored = store.getProject(projectId);
const actorId = accepted.intent.actor.id;
check('claim statistics are persisted per actor', stored.claimStats?.[actorId]?.total >= 56 && stored.claimStats?.[actorId]?.failed === 7, JSON.stringify(stored.claimStats));
check('rejected claims write a claim/rejected event', store.listEvents(projectId, 0).filter((event) => event.type === 'claim/rejected').length >= 7);

console.log(failed === 0 ? '\nclaims-selftest: all checks passed' : `\nclaims-selftest: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
