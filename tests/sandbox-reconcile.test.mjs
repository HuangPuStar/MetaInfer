import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileRunningNodes } from '../host/reconcile.js';
function setup(node) {
  const original = structuredClone(node); let current = node; const commits = [];
  const store = { listProjects: () => [{ id: 'p' }], listNodes: () => [current], getNode: () => current };
  const kernel = { executor: { async commit(id, spec) { assert.deepEqual(current, original, 'cached record was mutated before kernel'); commits.push(spec); current = structuredClone(spec.mutations[0].node); return { ok: true }; } } };
  return { store, kernel, original, commits, get node() { return current; } };
}
const remote = (patch = {}) => ({ id: 'n', projectId: 'p', status: 'running', currentAttempt: 1, sessionId: 's', execution: { driver: 'dsh', sandboxProfile: 'pclab19' }, resourcesHeld: { gpu: 1 }, admission: { leaseId: 'logical' }, attempts: [{ index: 1, sessionId: 's', startedAt: 1 }], sandbox: { backend: 'opensandbox', profile: 'pclab19', bindingId: 'b', attempt: 1, sessionId: 's', state: 'ready', verifiedClean: false, operations: {} }, ...patch });
test('cold remote running node is held, not declared locally clean', async () => {
  const f = setup(remote()); await reconcileRunningNodes(f); assert.equal(f.node.status, 'failed'); assert.equal(f.node.termination.verifiedClean, false); assert.equal(f.node.sandbox.verifiedClean, false); assert.deepEqual(f.node.resourcesHeld, { gpu: 1 }); assert.ok(f.node.sandboxGate); assert.equal(f.commits.length, 1);
});
test('failed remote unclean binding is reconciled too', async () => {
  const f = setup(remote({ status: 'failed' })); const r = await reconcileRunningNodes(f); assert.deepEqual(r, ['p/n']); assert.equal(f.node.termination.verifiedClean, false);
});
test('unknown exec is preserved even when physical binding was already destroyed', async () => {
  const n = remote({ status: 'cancelled' }); n.sandbox = { ...n.sandbox, state: 'released', verifiedClean: true, operations: { o: { state: 'unknown', action: 'exec', requestHash: 'h' } } }; delete n.resourcesHeld;
  const f = setup(n); await reconcileRunningNodes(f); assert.deepEqual(f.node.sandbox.operations, n.sandbox.operations); assert.ok(f.node.sandboxGate); assert.equal(f.node.sandbox.verifiedClean, true); assert.equal(f.node.status, 'cancelled');
});
test('durable intent becomes unknown rather than replayed', async () => {
  const n = remote(); n.sandbox.operations.o = { operationId: 'o', state: 'intent', action: 'acquire', requestHash: 'h' };
  const f = setup(n); await reconcileRunningNodes(f); assert.equal(f.node.sandbox.operations.o.state, 'unknown'); assert.equal(f.node.sandbox.operations.o.requestHash, 'h');
});
test('local reconciliation keeps old behavior but uses a fresh record', async () => {
  const f = setup({ id: 'n', status: 'running', resourcesHeld: { gpu: 1 }, attempts: [{ index: 1 }] }); await reconcileRunningNodes(f); assert.equal(f.node.termination.verifiedClean, true); assert.equal(f.node.resourcesHeld, undefined);
});

test('a local running node is requeued, not failed, after a Host restart', async () => {
  const f = setup({ id: 'n', projectId: 'p', status: 'running', currentAttempt: 1, execution: { driver: 'dsh' }, attempts: [{ index: 1, startedAt: 1 }] });
  const reconciled = await reconcileRunningNodes(f);
  assert.deepEqual(reconciled, ['p/n']);
  assert.equal(f.node.status, 'planned', 'local work survives a restart as a retryable node');
  assert.equal(f.node.requeued?.reason, 'host-restart');
  assert.equal(f.node.requeued?.previousAttempt, 1);
  assert.equal(f.node.error, undefined);
  assert.equal(f.node.timestamps.completedAt, null);
  assert.ok(f.node.timestamps.runnableAt > 0);
  assert.equal(f.commits.length, 1);
  const event = f.commits[0].mutations[0];
  assert.equal(event.eventType, 'node/requeued');
  assert.equal(event.eventData.requeued, true);
});

test('a remote running node still fails into the sandbox hold', async () => {
  const f = setup(remote());
  await reconcileRunningNodes(f);
  assert.equal(f.node.status, 'failed');
  assert.ok(f.node.sandboxGate);
});
test('completed physically clean remote node is untouched', async () => {
  const n = remote({ status: 'completed' }); n.sandbox.state = 'released'; n.sandbox.verifiedClean = true; delete n.resourcesHeld; n.attempts[0].endedAt = 2; delete n.admission;
  const f = setup(n); assert.deepEqual(await reconcileRunningNodes(f), []); assert.equal(f.commits.length, 0);
});

test('pristine planned remote node is not a phantom restart/cleanup hold', async () => {
  const n = { id: 'n', projectId: 'p', rev: 1, status: 'planned', currentAttempt: 0, attempts: [],
    execution: { driver: 'dsh', sandboxProfile: 'pclab19' } };
  const f = setup(n); assert.deepEqual(await reconcileRunningNodes(f), []); assert.deepEqual(f.node, n); assert.equal(f.commits.length, 0);
});
test('pre-attempt admission/claim is held, unlike a pristine plan', async () => {
  const n = { id: 'n', projectId: 'p', rev: 1, status: 'planned', currentAttempt: 0, attempts: [],
    execution: { driver: 'dsh', sandboxProfile: 'pclab19' }, admission: { leaseId: 'logical' }, claim: { decisionId: 'd' } };
  const f = setup(n); await reconcileRunningNodes(f); assert.ok(f.node.sandboxGate); assert.deepEqual(f.node.admission, n.admission); assert.deepEqual(f.node.claim, n.claim);
});
test('known physical cleanup finishes a cold leftover Host admission without rewriting its result', async () => {
  const n = remote({ status: 'completed', claim: { decisionId: 'd' } }); n.sandbox.state = 'released'; n.sandbox.verifiedClean = true; n.attempts[0].endedAt = 2;
  const f = setup(n); await reconcileRunningNodes(f); assert.equal(f.node.status, 'completed');
  assert.equal(f.node.admission, undefined); assert.equal(f.node.claim, undefined); assert.equal(f.node.resourcesHeld, undefined); assert.equal(f.node.sandboxGate, undefined);
});
test('verifiedClean true with nonterminal physical state is not release proof', async () => {
  const n = remote({ status: 'completed' }); n.sandbox.verifiedClean = true; delete n.admission; delete n.resourcesHeld; n.attempts[0].endedAt = 2;
  const f = setup(n); await reconcileRunningNodes(f); assert.equal(f.node.termination.verifiedClean, false); assert.ok(f.node.sandboxGate);
});
