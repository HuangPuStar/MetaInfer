/**
 * B24/B27: the seven atomic predicates, submission-time rejection, and the
 * citationErrorRate permission tiers. Each predicate is mutated independently
 * so a verifier that accepts everything cannot pass.
 */
import { openStore } from '../host/store.js';
import { createKernel } from '../host/kernel/instance.js';
import { createLabService } from '../host/lab-service.js';
import { ACTION_VERIFICATION, CLAIM_PREDICATES, MIN_CITATION_EVIDENCE, VERIFICATION_LEVELS, citationErrorRate, citationTier, gateClaimAction, verifyClaims, wilsonLowerBound } from '../host/kernel/claims.js';
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
    { op: 'node.create', node: { id: 'clean-target', title: 'never appealed', status: 'planned', timestamps: { createdAt: 3 } } },
    { op: 'node.create', node: { id: 'withdrawn-target', title: 'withdrawn appeal', status: 'planned', timestamps: { createdAt: 4 } } },
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
  { predicate: 'countWhere', status: 'planned', count: 4 },
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
check('the five verification levels are distinct and ordered', VERIFICATION_LEVELS.length === 5
  && VERIFICATION_LEVELS.every((row, index) => row.level === index)
  && ACTION_VERIFICATION.cancel_running.level === 2
  && ACTION_VERIFICATION.prune_branch.level === 3
  && ACTION_VERIFICATION.delete_project.level === 4);
check('Wilson lower bound needs a real clean history', wilsonLowerBound(20, 20) >= 0.80 && wilsonLowerBound(1, 1) < 0.80 && wilsonLowerBound(0, 20) === 0);
check('C7 has a minimum evidence floor', MIN_CITATION_EVIDENCE >= 20 && gateClaimAction('cancel_running', { total: 19, failed: 0 }, {
  submitted: 2, chiefConfirmed: true,
}).code === 'citation_evidence_floor');

const oneEvidence = { submitted: 1, chiefConfirmed: true };
check('cancel_running rejects one atom even with chief confirmation', gateClaimAction('cancel_running', { total: 20, failed: 0 }, oneEvidence).code === 'claim_evidence_required');
check('prune_branch rejects one atom even with chief confirmation and an appeal window', gateClaimAction('prune_branch', { total: 20, failed: 0 }, oneEvidence).code === 'claim_evidence_required');
check('delete_project rejects one atom without human confirmation', gateClaimAction('delete_project', { total: 20, failed: 0 }, {
  submitted: 1, actor: { kind: 'human' },
}).code === 'human_confirmation_required');
check('delete_project rejects non-humans', gateClaimAction('delete_project', { total: 20, failed: 0 }, {
  submitted: 3, actor: { kind: 'expert' }, humanConfirmed: true,
}).code === 'human_only');

const required = { chiefConfirmed: true, serverAppealWindow: true };
check('cancel_running passes with two atoms and chief confirmation', gateClaimAction('cancel_running', { total: 20, failed: 0 }, {
  ...required, submitted: 2,
}).ok === true);
check('prune_branch passes with three atoms, chief confirmation and an appeal window', gateClaimAction('prune_branch', { total: 20, failed: 0 }, {
  ...required, submitted: 3,
}).ok === true);
check('delete_project passes only for a confirming human', gateClaimAction('delete_project', { total: 20, failed: 0 }, {
  submitted: 0, actor: { kind: 'human' }, humanConfirmed: true, serverAppealWindow: true,
}).ok === true);
check('C7 blocks the required B27 set when the history is too small', gateClaimAction('cancel_running', { total: 1, failed: 0 }, {
  submitted: 2, chiefConfirmed: true,
}).code === 'citation_evidence_floor');
check('L0 planned_create is not blocked by the C7 history floor', gateClaimAction('create_planned', { total: 0, failed: 0 }, {
  submitted: 0,
}).ok === true);
check('L1 defer_planned is not blocked by the C7 history floor', gateClaimAction('defer_planned', { total: 0, failed: 0 }, {
  submitted: 1,
}).ok === true);
check('a live appeal blocks prune_branch even with a future window', gateClaimAction('prune_branch', { total: 20, failed: 0 }, {
  submitted: 3, chiefConfirmed: true, serverAppealWindow: true, appealPending: true,
}).code === 'appeal_pending');
check('an open appeal blocks L0 create_planned too', gateClaimAction('create_planned', { total: 0, failed: 0 }, {
  submitted: 0, appealPending: true,
}).code === 'appeal_pending');
check('an open appeal blocks L1 defer_planned too', gateClaimAction('defer_planned', { total: 0, failed: 0 }, {
  submitted: 1, appealPending: true,
}).code === 'appeal_pending');
check('a caller-supplied window is rejected by the gate itself', gateClaimAction('prune_branch', { total: 20, failed: 0 }, {
  submitted: 3, chiefConfirmed: true, appealUntil: Date.now() + 60_000,
}).code === 'appeal_window_caller_supplied');
check('a withdrawn appeal blocks prune_branch without a supplied window', gateClaimAction('prune_branch', { total: 20, failed: 0 }, {
  submitted: 3, chiefConfirmed: true, appealUnresolved: true, serverAppealWindow: true,
}).code === 'appeal_not_resolved');
check('a withdrawn appeal blocks cancel_running (L2 has no appeal flag)', gateClaimAction('cancel_running', { total: 20, failed: 0 }, {
  submitted: 2, chiefConfirmed: true, appealUnresolved: true,
}).code === 'appeal_not_resolved');
check('prune_branch needs a Host-registered appeal window', gateClaimAction('prune_branch', { total: 20, failed: 0 }, {
  submitted: 3, chiefConfirmed: true,
}).code === 'appeal_window_required');
check('C7 blocks a clean-but-thin history below the Wilson floor', gateClaimAction('cancel_running', { total: 20, failed: 4 }, {
  submitted: 2, chiefConfirmed: true,
}).code === 'citation_confidence_too_low');

const submitOn = (nodeId, claim, extra = {}) => service.submitIntent(projectId, { kind: 'note', nodeId, claim, ...extra }, null);
const submit = (claim, extra = {}) => submitOn('child', claim, extra);
const chiefExec = { agent: { session: { id: 'chief-1', header: { meta: { agentPreset: 'lab-chief' } } } } };
const expertExec = { agent: { session: { id: 'advisor-1', header: { meta: { agentPreset: 'lab-advisor' } } } } };
const accepted = await submit({ action: 'observe', evidence: valid });
check('a valid claim set is accepted', accepted.ok === true && accepted.intent?.claim?.verification?.failed === 0, JSON.stringify(accepted));
// C7 needs a record: build 21 clean atoms before asking for an irreversible action.
for (let index = 0; index < 2; index += 1) await submit({ action: 'observe', evidence: valid });
// A resolved appeal is the only legitimate way to open the L3/L4 window
// before the Host clock reaches the appeal's expiry.
const setupAppeal = await service.submitIntent(projectId, {
  kind: 'note', nodeId: 'child', claim: { action: 'appeal', reason: 'setup a resolvable window' },
}, chiefExec);
const setupResolved = await service.resolveAppeal(projectId, setupAppeal.intent.id, {
  resolution: 'upheld', reason: 'human opens the window for the clean path',
});
check('a resolved appeal supplies the Host-side window for L3/L4', setupResolved.ok === true, JSON.stringify(setupResolved));
const irreversible = await submit({ action: 'cancel_running', evidence: valid }, { chiefConfirmed: true });
check('a clean history and the required evidence permit cancel_running', irreversible.ok === true, JSON.stringify(irreversible));
const pruned = await submit({ action: 'prune_branch', evidence: valid.slice(0, 3) }, { chiefConfirmed: true });
check('a clean history and the required evidence permit prune_branch', pruned.ok === true, JSON.stringify(pruned));
const deleted = await submit({ action: 'delete_project' }, { humanConfirmed: true });
check('a confirming human can submit delete_project', deleted.ok === true, JSON.stringify(deleted));
const appeal = await service.submitIntent(projectId, {
  kind: 'note', nodeId: 'child', claim: { action: 'appeal', reason: 'I object to pruning this branch' },
}, chiefExec);
check('an appeal is stored as an appeal intent, not a note', appeal.ok === true && appeal.intent?.kind === 'appeal', JSON.stringify(appeal));
const blocked = await submit({ action: 'prune_branch', evidence: valid.slice(0, 3) }, { chiefConfirmed: true });
check('an open appeal blocks a new prune_branch submission', blocked.ok === false && blocked.error?.code === 'appeal_pending', JSON.stringify(blocked));
const cancelBlocked = await submit({ action: 'cancel_running', evidence: valid }, { chiefConfirmed: true });
check('an open appeal also blocks cancel_running (L2, no appeal flag in its level)', cancelBlocked.ok === false && cancelBlocked.error?.code === 'appeal_pending', JSON.stringify(cancelBlocked));

const expertResolve = await service.resolveAppeal(projectId, appeal.intent.id, {
  resolution: 'upheld', reason: 'expert should not resolve',
}, expertExec);
check('only a human or chief can resolve an appeal', expertResolve.ok === false && expertResolve.error?.code === 'forbidden_action', JSON.stringify(expertResolve));
const resolved = await service.resolveAppeal(projectId, appeal.intent.id, {
  resolution: 'upheld', reason: 'human heard the objection',
});
check('resolving an appeal records who resolved it and why', resolved.ok === true
  && resolved.intent?.status === 'resolved'
  && resolved.intent?.resolvedBy?.kind === 'human'
  && typeof resolved.intent?.resolvedBy?.id === 'string'
  && resolved.intent?.resolution === 'upheld'
  && /human heard/.test(resolved.intent?.resolutionReason ?? ''), JSON.stringify(resolved));

for (const [action, extra] of [
  ['cancel_running', { chiefConfirmed: true }],
  ['prune_branch', { chiefConfirmed: true }],
  ['delete_project', {}],
]) {
  const rejected = await submit({ action, evidence: [valid[0]] }, extra);
  check(`one atom cannot ${action}`, rejected.ok === false && ['claim_evidence_required', 'human_confirmation_required'].includes(rejected.error?.code), JSON.stringify(rejected));
}

const oneAtomCancel = await submit({ action: 'cancel_running', evidence: [valid[0]] }, { chiefConfirmed: true });
check('one atom is rejected by the action-level evidence count', oneAtomCancel.ok === false && oneAtomCancel.error?.code === 'claim_evidence_required', JSON.stringify(oneAtomCancel));
const noChief = await submit({ action: 'cancel_running', evidence: valid }, {});
check('cancel_running cannot self-confirm without a chief', noChief.ok === false && noChief.error?.code === 'chief_confirmation_required', JSON.stringify(noChief));
// Probe 2: an expert withdrawing its own appeal must not impersonate a
// resolution. The appeal disappears (withdrawn), but no resolvedBy is written.
const expertAppeal = await service.submitIntent(projectId, {
  kind: 'note', nodeId: 'root', claim: { action: 'appeal', reason: 'expert objection' },
}, expertExec);
const expertWithdraw = await service.withdrawIntent(projectId, expertAppeal.intent.id, { reason: 'expert withdraws' }, expertExec);
check('an expert cannot withdraw an appeal into a resolved record', expertWithdraw.ok === true
  && expertWithdraw.intent?.status === 'withdrawn'
  && expertWithdraw.intent?.resolvedBy === undefined
  && expertWithdraw.intent?.resolution === undefined
  && expertWithdraw.intent?.withdrawnBy?.kind === 'expert', JSON.stringify(expertWithdraw));
check('withdrawal emits intent/withdrawn, not appeal/resolved',
  store.listEvents(projectId, 0).some((event) => event.type === 'intent/withdrawn' && event.data?.intentId === expertAppeal.intent.id)
  && !store.listEvents(projectId, 0).some((event) => event.type === 'appeal/resolved' && event.data?.intentId === expertAppeal.intent.id));
// Probe 3: the raiser cannot resolve their own appeal, even as lab-chief.
const chiefAppeal = await service.submitIntent(projectId, {
  kind: 'note', nodeId: 'root', claim: { action: 'appeal', reason: 'chief objection' },
}, chiefExec);
const selfResolve = await service.resolveAppeal(projectId, chiefAppeal.intent.id, {
  resolution: 'upheld', reason: 'chief decides own appeal',
}, chiefExec);
check('the raiser cannot resolve their own appeal', selfResolve.ok === false && selfResolve.error?.code === 'appeal_self_resolution', JSON.stringify(selfResolve));
// Exact Round 9 probes: withdrawal must not clear the gate, and the caller
// cannot manufacture a window. `withdrawn-target` has one withdrawn appeal;
// `clean-target` has never been appealed.
const withdrawnAppeal = await service.submitIntent(projectId, {
  kind: 'note', nodeId: 'withdrawn-target', claim: { action: 'appeal', reason: 'withdrawn probe' },
}, expertExec);
const withdrawn = await service.withdrawIntent(projectId, withdrawnAppeal.intent.id, { reason: 'withdraw probe' }, expertExec);
check('withdraw-then-prune without a window is blocked', withdrawn.ok === true
  && (await submitOn('withdrawn-target', { action: 'prune_branch', evidence: valid.slice(0, 3) }, { chiefConfirmed: true })).error?.code === 'appeal_not_resolved');
const withdrawPruneSupplied = await submitOn('withdrawn-target', { action: 'prune_branch', evidence: valid.slice(0, 3) }, {
  chiefConfirmed: true, appealUntil: Date.now() + 60_000,
});
check('withdraw-then-prune with a caller window is rejected', withdrawPruneSupplied.ok === false
  && withdrawPruneSupplied.error?.code === 'appeal_window_caller_supplied', JSON.stringify(withdrawPruneSupplied));
const withdrawCancel = await submitOn('withdrawn-target', { action: 'cancel_running', evidence: valid }, { chiefConfirmed: true });
check('withdraw-then-cancel is blocked without a window', withdrawCancel.ok === false
  && withdrawCancel.error?.code === 'appeal_not_resolved', JSON.stringify(withdrawCancel));
const neverSupplied = await submitOn('clean-target', { action: 'prune_branch', evidence: valid.slice(0, 3) }, {
  chiefConfirmed: true, appealUntil: Date.now() + 60_000,
});
check('a caller window on a never-appealed target is rejected', neverSupplied.ok === false
  && neverSupplied.error?.code === 'appeal_window_caller_supplied', JSON.stringify(neverSupplied));
const neverNoWindow = await submitOn('clean-target', { action: 'prune_branch', evidence: valid.slice(0, 3) }, { chiefConfirmed: true });
check('a never-appealed target has no Host window', neverNoWindow.ok === false
  && neverNoWindow.error?.code === 'appeal_window_required', JSON.stringify(neverNoWindow));

for (const predicate of CLAIM_PREDICATES) {
  const one = structuredClone(valid);
  mutations[predicate](one.find((row) => row.predicate === predicate));
  const rejected = await submit({ action: 'observe', evidence: one });
  check(`submitIntent rejects a failing ${predicate} before writing`, rejected.ok === false && rejected.error?.code === 'claim_invalid'
    && rejected.error?.failures?.some((row) => row.predicate === predicate), JSON.stringify(rejected));
}

const gated = await submit({ action: 'cancel_running', evidence: valid }, { chiefConfirmed: true });
check('history above the statistical floor blocks the irreversible action', gated.ok === false && ['citation_error_rate', 'citation_confidence_too_low'].includes(gated.error?.code), JSON.stringify(gated));
const missingEvidence = await submit({ action: 'cancel_running' }, { chiefConfirmed: true });
check('an irreversible claim without fresh evidence is still gated', missingEvidence.ok === false && missingEvidence.error?.code === 'claim_evidence_required', JSON.stringify(missingEvidence));
const stored = store.getProject(projectId);
const actorId = accepted.intent.actor.id;
check('claim statistics are persisted per actor', stored.claimStats?.[actorId]?.total >= 56 && stored.claimStats?.[actorId]?.failed === 7, JSON.stringify(stored.claimStats));
check('rejected claims write a claim/rejected event', store.listEvents(projectId, 0).filter((event) => event.type === 'claim/rejected').length >= 7);

console.log(failed === 0 ? '\nclaims-selftest: all checks passed' : `\nclaims-selftest: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
