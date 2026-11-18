/** Exact owner CAS at the kernel boundary; no transport or direct record writes here. */
import { isDeepStrictEqual } from 'node:util';

function check(value, message) { if (!value) { const error = new Error(message); error.code = 'sandbox_cas_mismatch'; throw error; } }
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const unknown = row => row?.state === 'unknown' || row?.state === 'intent' || row?.state === 'inProgress';

export function createBindingWriter({ store, kernel }) {
  check(kernel?.executor && typeof store.withProjectLock === 'function', 'Sandbox binding writer requires the kernel and project lock.');
  return async function commitBinding({ expected, binding, event = 'node/sandbox_updated' }) {
    check(plain(expected) && plain(binding), 'Invalid binding CAS input.');
    const apply = async () => {
      const project = structuredClone(store.getProject(expected.projectId));
      const node = structuredClone(store.getNode(expected.projectId, expected.nodeId));
      check(project && node, 'Sandbox CAS owner no longer exists.');
      const prior = node.sandbox;
      check(Number.isInteger(expected.nodeRev) && expected.nodeRev === (node.rev ?? 0), 'Sandbox CAS node revision changed.');
      check(node.currentAttempt === expected.attempt && node.sessionId === expected.sessionId
        && node.execution?.driver === 'dsh' && node.execution.sandboxProfile === expected.profile
        && (prior?.bindingId ?? null) === (expected.bindingId ?? null), 'Sandbox CAS owner scope changed.');
      check(binding.profile === expected.profile && binding.attempt === expected.attempt && binding.sessionId === expected.sessionId
        && typeof binding.bindingId === 'string' && binding.bindingId.length > 0
        && (binding.projectId === undefined || binding.projectId === expected.projectId)
        && (binding.nodeId === undefined || binding.nodeId === expected.nodeId), 'New binding does not match the current owner scope.');
      check(typeof binding.verifiedClean === 'boolean' && plain(binding.operations), 'Binding cleanup/operation state is required.');
      check(binding.state !== 'ready' || node.status === 'running', 'Late ready binding cannot revive a non-running node.');
      if (prior && prior.bindingId !== binding.bindingId) {
        check(prior.verifiedClean === true && !Object.values(prior.operations ?? {}).some(unknown), 'Cannot replace an unclean or uncertain binding.');
      } else if (prior) {
        check(prior.attempt === binding.attempt && prior.sessionId === binding.sessionId && prior.profile === binding.profile, 'Cannot relabel an existing binding to another attempt.');
        for (const [id, row] of Object.entries(prior.operations ?? {})) {
          if (row?.state === 'unknown') check(isDeepStrictEqual(binding.operations[id], row), 'An unknown operation is immutable without explicit reconciliation.');
        }
      }
      if (expected.operationId) {
        const before = prior?.operations?.[expected.operationId], after = binding.operations[expected.operationId];
        check(plain(after), 'Expected operation is missing from the binding.');
        check(before || after.state === 'intent', 'Only a durable intent may introduce a new operation.');
        if (before) check(before.requestHash === after.requestHash && before.action === after.action, 'Operation request identity changed.');
      }
      const result = await store.withWritePermit(() => kernel.executor.commitLocked(project.id, {
        actor: { kind: 'system', id: 'sandbox-backend' }, causeId: `${node.id}-a${node.currentAttempt}`,
        expectedProjectRevision: project.revision,
        mutations: [{ op: 'node.update', nodeId: node.id, set: { sandbox: structuredClone(binding) }, eventType: event,
          eventData: { bindingId: binding.bindingId, profile: binding.profile, attempt: binding.attempt, state: binding.state, ...(expected.operationId ? { operationId: expected.operationId } : {}) } }],
      }));
      check(result?.ok === true, result?.message ?? 'Sandbox kernel commit was rejected.');
      return structuredClone(store.getNode(project.id, node.id).sandbox);
    };
    return store.isProjectLocked?.(expected.projectId) === true ? apply() : store.withProjectLock(expected.projectId, apply);
  };
}
