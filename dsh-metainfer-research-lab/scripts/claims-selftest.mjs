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
    { op: 'node.create', node: { id: 'scope-target', title: 'scope probe', status: 'completed', timestamps: { createdAt: 5 } } },
    { op: 'node.create', node: { id: 'self-target', title: 'self-raised probe', status: 'completed', timestamps: { createdAt: 6 } } },
    { op: 'node.create', node: { id: 'race-target', title: 'resolution race probe', status: 'completed', timestamps: { createdAt: 7 } } },
    { op: 'node.create', node: { id: 'other-target', title: 'different target probe', status: 'completed', timestamps: { createdAt: 8 } } },
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
check('every irreversible level requires a human confirmation', VERIFICATION_LEVELS.filter((row) => row.level >= 2).every((row) => row.humanConfirmation === true));
check('Wilson lower bound needs a real clean history', wilsonLowerBound(20, 20) >= 0.80 && wilsonLowerBound(1, 1) < 0.80 && wilsonLowerBound(0, 20) === 0);
check('C7 has a minimum evidence floor', MIN_CITATION_EVIDENCE >= 20 && gateClaimAction('cancel_running', { total: 19, failed: 0 }, {
  submitted: 2, chiefConfirmed: true, humanConfirmed: true,
}).code === 'citation_evidence_floor');

const oneEvidence = { submitted: 1, chiefConfirmed: true, humanConfirmed: true };
check('cancel_running rejects one atom even with chief confirmation', gateClaimAction('cancel_running', { total: 20, failed: 0 }, oneEvidence).code === 'claim_evidence_required');
check('prune_branch rejects one atom even with chief confirmation and an appeal window', gateClaimAction('prune_branch', { total: 20, failed: 0 }, oneEvidence).code === 'claim_evidence_required');
check('delete_project rejects one atom without human confirmation', gateClaimAction('delete_project', { total: 20, failed: 0 }, {
  submitted: 1, actor: { kind: 'human' },
}).code === 'human_confirmation_required');
check('delete_project rejects non-humans', gateClaimAction('delete_project', { total: 20, failed: 0 }, {
  submitted: 3, actor: { kind: 'expert' }, humanConfirmed: true,
}).code === 'human_only');
check('cancel_running requires an independent human confirmation even with chief and evidence', gateClaimAction('cancel_running', { total: 20, failed: 0 }, {
  submitted: 2, chiefConfirmed: true,
}).code === 'human_confirmation_required');
check('prune_branch requires independent human confirmation even with an otherwise valid window', gateClaimAction('prune_branch', { total: 20, failed: 0 }, {
  submitted: 3, chiefConfirmed: true, serverAppealWindow: true,
}).code === 'human_confirmation_required');

const required = { chiefConfirmed: true, humanConfirmed: true, serverAppealWindow: true };
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
  submitted: 2, chiefConfirmed: true, humanConfirmed: true,
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
  submitted: 3, chiefConfirmed: true, humanConfirmed: true,
}).code === 'appeal_window_required');
check('C7 blocks a clean-but-thin history below the Wilson floor', gateClaimAction('cancel_running', { total: 20, failed: 4 }, {
  submitted: 2, chiefConfirmed: true, humanConfirmed: true,
}).code === 'citation_confidence_too_low');
check('gate rejects a differently-scoped resolution before evidence', gateClaimAction('prune_branch', { total: 20, failed: 0 }, {
  submitted: 3, chiefConfirmed: true, humanConfirmed: true, serverAppealWindow: true, appealTargetMismatch: true,
}).code === 'appeal_target_mismatch');

const submitOn = (nodeId, claim, extra = {}) => service.submitIntent(projectId, { kind: 'note', nodeId, claim, ...extra }, null);
const submit = (claim, extra = {}) => submitOn('child', claim, extra);
const chiefExec = { agent: { session: { id: 'chief-1', header: { meta: { agentPreset: 'lab-chief' } } } } };
const expertExec = { agent: { session: { id: 'advisor-1', header: { meta: { agentPreset: 'lab-advisor' } } } } };
const humanExec = { agent: { session: { id: 'human-reviewer' } } };
const humanExec2 = { agent: { session: { id: 'human-2' } } };
const accepted = await submit({ action: 'observe', evidence: valid });
check('a valid claim set is accepted', accepted.ok === true && accepted.intent?.claim?.verification?.failed === 0, JSON.stringify(accepted));
// C7 needs a record: build 21 clean atoms before asking for an irreversible action.
for (let index = 0; index < 2; index += 1) await submit({ action: 'observe', evidence: valid });
// A resolved appeal is the only legitimate way to open the L3/L4 window
// before the Host clock reaches the appeal's expiry.
const neverSupplied = await submitOn('clean-target', { action: 'prune_branch', evidence: valid.slice(0, 3) }, {
  chiefConfirmed: true, appealUntil: Date.now() + 60_000,
});
check('a caller window on a never-appealed target is rejected', neverSupplied.ok === false
  && neverSupplied.error?.code === 'appeal_window_caller_supplied', JSON.stringify(neverSupplied));
const neverNoWindow = await submitOn('clean-target', { action: 'prune_branch', evidence: valid.slice(0, 3) }, { chiefConfirmed: true });
check('a never-appealed target has no independent human confirmation', neverNoWindow.ok === false
  && neverNoWindow.error?.code === 'human_confirmation_required', JSON.stringify(neverNoWindow));
const booleanOnly = await submitOn('clean-target', { action: 'cancel_running', evidence: valid }, {
  chiefConfirmed: true, humanConfirmed: true,
});
check('a humanConfirmed request flag alone cannot unlock an irreversible action', booleanOnly.ok === false
  && booleanOnly.error?.code === 'human_confirmation_required', JSON.stringify(booleanOnly));
const setupAppeals = {};
const setupResolved = [];
for (const targetAction of ['cancel_running', 'prune_branch', 'delete_project']) {
  const opened = await service.submitIntent(projectId, {
    kind: 'note', nodeId: 'child', claim: { action: 'appeal', targetAction, reason: `setup a resolvable ${targetAction} window` },
  }, chiefExec);
  setupAppeals[targetAction] = opened;
  setupResolved.push(await service.resolveAppeal(projectId, opened.intent.id, {
    resolution: 'upheld', reason: `human opens the ${targetAction} window for the clean path`,
  }, humanExec));
}
check('scoped resolved appeals supply the Host-side window for L2/L3/L4',
  setupResolved.every((row) => row.ok === true), JSON.stringify(setupResolved));
const selfConfirmed = await service.submitIntent(projectId, {
  kind: 'note', nodeId: 'child', claim: { action: 'cancel_running', evidence: valid },
  chiefConfirmed: true, humanConfirmed: true,
}, humanExec);
check('the requester cannot reuse its own resolution as human confirmation', selfConfirmed.ok === false
  && selfConfirmed.error?.code === 'human_confirmation_required', JSON.stringify(selfConfirmed));
const irreversible = await submit({ action: 'cancel_running', evidence: valid }, { chiefConfirmed: true });
check('a clean history and the required evidence permit cancel_running', irreversible.ok === true, JSON.stringify(irreversible));
check('the gate records the independent human confirmer', irreversible.intent?.claim?.gate?.humanConfirmedBy?.id === 'human-reviewer', JSON.stringify(irreversible.intent?.claim?.gate));
const pruned = await submit({ action: 'prune_branch', evidence: valid.slice(0, 3) }, { chiefConfirmed: true });
check('a clean history and the required evidence permit prune_branch', pruned.ok === true, JSON.stringify(pruned));
const deleted = await submit({ action: 'delete_project' }, {});
check('a confirming human can submit delete_project', deleted.ok === true, JSON.stringify(deleted));
const appeal = await service.submitIntent(projectId, {
  kind: 'note', nodeId: 'child', claim: { action: 'appeal', targetAction: 'prune_branch', reason: 'I object to pruning this branch' },
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
}, humanExec);
check('resolving an appeal records who resolved it and why', resolved.ok === true
  && resolved.intent?.status === 'resolved'
  && resolved.intent?.resolvedBy?.kind === 'human'
  && typeof resolved.intent?.resolvedBy?.id === 'string'
  && resolved.intent?.resolution === 'upheld'
  && /human heard/.test(resolved.intent?.resolutionReason ?? ''), JSON.stringify(resolved));

for (const [action, extra] of [
  ['cancel_running', { chiefConfirmed: true }],
  ['prune_branch', { chiefConfirmed: true }],
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
  kind: 'note', nodeId: 'root', claim: { action: 'appeal', targetAction: 'prune_branch', reason: 'expert objection' },
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
  kind: 'note', nodeId: 'root', claim: { action: 'appeal', targetAction: 'prune_branch', reason: 'chief objection' },
}, chiefExec);
const selfResolve = await service.resolveAppeal(projectId, chiefAppeal.intent.id, {
  resolution: 'upheld', reason: 'chief decides own appeal',
}, chiefExec);
check('the raiser cannot resolve their own appeal', selfResolve.ok === false && selfResolve.error?.code === 'appeal_self_resolution', JSON.stringify(selfResolve));
// Exact Round 9 probes: withdrawal must not clear the gate, and the caller
// cannot manufacture a window. `withdrawn-target` has one withdrawn appeal;
// `clean-target` has never been appealed.
const withdrawnAppeal = await service.submitIntent(projectId, {
  kind: 'note', nodeId: 'withdrawn-target', claim: { action: 'appeal', targetAction: 'prune_branch', reason: 'withdrawn probe' },
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
// Exact Round 10 probe: a manufactured appeal record (`kind:'appeal'` with a
// non-appeal claim action) must not create a Host window. The write boundary
// rejects it, and appealState also ignores any legacy malformed row.
const manufactured = await service.submitIntent(projectId, {
  kind: 'appeal', nodeId: 'clean-target', claim: { action: 'observe', reason: 'manufactured window' },
}, expertExec);
check('a manufactured appeal window is rejected', manufactured.ok === false
  && manufactured.error?.code === 'intent_action_mismatch', JSON.stringify(manufactured));
const wrongAppealAction = await service.submitIntent(projectId, {
  kind: 'appeal', nodeId: 'clean-target', claim: { action: 'prune_branch', reason: 'manufactured prune appeal' },
}, expertExec);
check('an appeal kind carrying a different gate action is rejected', wrongAppealAction.ok === false
  && wrongAppealAction.error?.code === 'intent_action_mismatch', JSON.stringify(wrongAppealAction));
const ordinaryIntent = await submit({ action: 'observe', evidence: valid });
const resolveOrdinary = await service.resolveAppeal(projectId, ordinaryIntent.intent.id, {
  resolution: 'upheld', reason: 'not an appeal',
}, humanExec);
check('resolveAppeal rejects a kind/claim action mismatch', resolveOrdinary.ok === false
  && resolveOrdinary.error?.code === 'intent_action_mismatch', JSON.stringify(resolveOrdinary));
// Exact Round 10 probe: advancing the Host clock past INTENT_TTL_MS must not
// turn a withdrawal into permission. Only an explicit resolution can.
const realNow = Date.now;
const afterTtl = await (async () => {
  Date.now = () => realNow() + 31 * 60_000;
  try {
    return await submitOn('withdrawn-target', { action: 'prune_branch', evidence: valid.slice(0, 3) }, { chiefConfirmed: true });
  } finally {
    Date.now = realNow;
  }
})();
check('a withdrawn appeal stays appeal_not_resolved after the TTL', afterTtl.ok === false
  && afterTtl.error?.code === 'appeal_not_resolved', JSON.stringify(afterTtl));
const withdrawnResolved = await service.resolveAppeal(projectId, withdrawnAppeal.intent.id, {
  resolution: 'upheld', reason: 'explicit hearing after withdrawal',
}, humanExec);
check('a different human can explicitly resolve a withdrawn appeal', withdrawnResolved.ok === true
  && withdrawnResolved.intent?.status === 'resolved'
  && withdrawnResolved.intent?.resolvedBy?.id === 'human-reviewer', JSON.stringify(withdrawnResolved));
const afterWithdrawnResolve = await submitOn('withdrawn-target', { action: 'prune_branch', evidence: valid.slice(0, 3) }, { chiefConfirmed: true });
check('explicit resolution of a withdrawn appeal opens the action', afterWithdrawnResolve.ok === true, JSON.stringify(afterWithdrawnResolve));

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
const negativeAppeal = await service.submitIntent(projectId, {
  kind: 'note', nodeId: 'clean-target', claim: { action: 'appeal', targetAction: 'cancel_running', reason: 'negative resolution probe' },
}, expertExec);
const negativeResolve = await service.resolveAppeal(projectId, negativeAppeal.intent.id, {
  resolution: 'rejected', reason: 'human rejects the objection',
}, humanExec);
const negativeConfirm = await submitOn('clean-target', { action: 'cancel_running', evidence: valid }, { chiefConfirmed: true });
check('a rejected appeal resolution is not human confirmation', negativeResolve.ok === true
  && negativeConfirm.ok === false && negativeConfirm.error?.code === 'human_confirmation_required', JSON.stringify(negativeConfirm));

// Exact Round 11 probe: an appeal without a target/action scope is not a
// wildcard. It is rejected at the write boundary, and a differently-scoped
// resolution cannot authorize a different action on the same node.
const unscopedAppeal = await service.submitIntent(projectId, {
  kind: 'note', nodeId: 'scope-target', claim: { action: 'appeal', reason: 'unscoped probe' },
}, chiefExec);
check('an appeal without an exact targetAction is rejected', unscopedAppeal.ok === false
  && unscopedAppeal.error?.code === 'appeal_target_mismatch', JSON.stringify(unscopedAppeal));
const unscopedNode = await service.submitIntent(projectId, {
  kind: 'note', claim: { action: 'appeal', targetAction: 'prune_branch', reason: 'no target node' },
}, chiefExec);
check('an appeal without a target node id is rejected', unscopedNode.ok === false
  && unscopedNode.error?.code === 'appeal_target_mismatch', JSON.stringify(unscopedNode));
const scopedAppeal = await service.submitIntent(projectId, {
  kind: 'note', nodeId: 'scope-target', claim: { action: 'appeal', targetAction: 'prune_branch', reason: 'scope probe' },
}, chiefExec);
const scopedResolved = await service.resolveAppeal(projectId, scopedAppeal.intent.id, {
  resolution: 'upheld', reason: 'human resolves the prune appeal only',
}, humanExec);
const wrongAction = await submitOn('scope-target', { action: 'cancel_running', evidence: valid }, { chiefConfirmed: true });
check('a resolution scoped to prune does not authorize cancel', scopedResolved.ok === true
  && wrongAction.ok === false && wrongAction.error?.code === 'appeal_target_mismatch', JSON.stringify(wrongAction));
const wrongTarget = await submitOn('other-target', { action: 'prune_branch', evidence: valid.slice(0, 3) }, { chiefConfirmed: true });
check('a resolution scoped to one node does not authorize another node', wrongTarget.ok === false
  && wrongTarget.error?.code === 'appeal_target_mismatch', JSON.stringify(wrongTarget));

// Exact Round 11 probe: the requester may raise an appeal, but it cannot be
// the raiser and the requester at the same time. A different human resolving
// it is still not three distinct actors.
const selfRaised = await submitOn('self-target', { action: 'appeal', targetAction: 'prune_branch' }, {});
const selfRaisedResolved = await service.resolveAppeal(projectId, selfRaised.intent.id, {
  resolution: 'upheld', reason: 'different human resolves a self-raised appeal',
}, humanExec);
const selfRaisedAction = await submitOn('self-target', { action: 'prune_branch', evidence: valid.slice(0, 3) }, { chiefConfirmed: true });
check('a requester that raised the appeal cannot use its resolution', selfRaisedResolved.ok === true
  && selfRaisedAction.ok === false && selfRaisedAction.error?.code === 'human_confirmation_required', JSON.stringify({ selfRaisedResolved, selfRaisedAction }));

// Exact Round 11 probe: concurrent rejected/upheld resolutions. The mutation
// carries expectedStatus + expectedRevision, so exactly one commit wins and
// exactly one appeal/resolved event exists.
const raceAppeal = await service.submitIntent(projectId, {
  kind: 'note', nodeId: 'race-target', claim: { action: 'appeal', targetAction: 'prune_branch', reason: 'race probe' },
}, chiefExec);
// The verifier's exact case is a withdrawn appeal: withdrawal never expires
// into permission, but it still permits one explicit resolution.
const raceWithdrawn = await service.withdrawIntent(projectId, raceAppeal.intent.id, { reason: 'race setup withdrawal' }, humanExec);
const raceResults = await Promise.all([
  service.resolveAppeal(projectId, raceAppeal.intent.id, { resolution: 'rejected', reason: 'race rejected' }, humanExec),
  service.resolveAppeal(projectId, raceAppeal.intent.id, { resolution: 'upheld', reason: 'race upheld' }, humanExec2),
]);
const raceWinners = raceResults.filter((row) => row.ok === true);
const raceLoser = raceResults.find((row) => row.ok !== true);
const raceStored = store.getProject(projectId).intents.find((row) => row.id === raceAppeal.intent.id);
const raceEvents = store.listEvents(projectId, 0).filter((event) => event.type === 'appeal/resolved' && event.data?.intentId === raceAppeal.intent.id);
console.log(`RACE ${JSON.stringify({
  withdrawn: raceWithdrawn.ok === true,
  calls: raceResults.map((row) => (row.ok ? { ok: true, resolution: row.intent?.resolution, resolvedBy: row.intent?.resolvedBy?.id } : { ok: false, code: row.error?.code })),
  stored: { status: raceStored?.status, resolution: raceStored?.resolution, resolvedBy: raceStored?.resolvedBy?.id },
  resolvedEvents: raceEvents.length,
})}`);
check('concurrent reject/upheld resolutions: exactly one wins', raceWinners.length === 1
  && raceLoser?.error?.code === 'intent_not_pending', JSON.stringify(raceResults));
check('concurrent resolutions emit exactly one appeal/resolved event', raceEvents.length === 1, String(raceEvents.length));
check('the stored resolution matches the winning call', raceStored?.status === 'resolved'
  && raceStored?.resolution === raceWinners[0]?.intent?.resolution
  && raceStored?.resolvedBy?.id === raceWinners[0]?.intent?.resolvedBy?.id, JSON.stringify({ stored: raceStored, winner: raceWinners[0] }));

// The same CAS discipline applies to the other external intent transition.
const raceWithdrawAppeal = await service.submitIntent(projectId, {
  kind: 'note', nodeId: 'race-target', claim: { action: 'appeal', targetAction: 'cancel_running', reason: 'withdraw race probe' },
}, chiefExec);
const raceWithdrawResults = await Promise.all([
  service.resolveAppeal(projectId, raceWithdrawAppeal.intent.id, { resolution: 'upheld', reason: 'resolve race' }, humanExec),
  service.withdrawIntent(projectId, raceWithdrawAppeal.intent.id, { reason: 'withdraw race' }, humanExec),
]);
const raceWithdrawWinners = raceWithdrawResults.filter((row) => row.ok === true);
const raceWithdrawLoser = raceWithdrawResults.find((row) => row.ok !== true);
const raceWithdrawStored = store.getProject(projectId).intents.find((row) => row.id === raceWithdrawAppeal.intent.id);
const raceWithdrawEvents = store.listEvents(projectId, 0).filter((event) => event.data?.intentId === raceWithdrawAppeal.intent.id
  && (event.type === 'appeal/resolved' || event.type === 'intent/withdrawn'));
console.log(`RACE_WITHDRAW ${JSON.stringify({
  calls: raceWithdrawResults.map((row) => (row.ok ? { ok: true, resolution: row.intent?.resolution } : { ok: false, code: row.error?.code })),
  stored: { status: raceWithdrawStored?.status, resolution: raceWithdrawStored?.resolution },
  transitionEvents: raceWithdrawEvents.length,
})}`);
check('concurrent resolve/withdraw: exactly one transition wins', raceWithdrawWinners.length === 1
  && raceWithdrawLoser?.error?.code === 'intent_not_pending', JSON.stringify(raceWithdrawResults));
check('concurrent resolve/withdraw emits exactly one transition event', raceWithdrawEvents.length === 1, String(raceWithdrawEvents.length));

console.log(failed === 0 ? '\nclaims-selftest: all checks passed' : `\nclaims-selftest: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
