import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createBindingWriter } from '../host/sandbox-binding.js';

function setup() {
  let node = { id: 'n', projectId: 'p', rev: 3, status: 'running', currentAttempt: 1, sessionId: 's', execution: { driver: 'dsh', sandboxProfile: 'pclab19' }, unrelated: { keep: true } };
  const project = { id: 'p', revision: 3 }, als = new AsyncLocalStorage(); let tail = Promise.resolve(); const commits = [];
  const store = { getNode: () => node, getProject: () => project, isProjectLocked: id => als.getStore() === id,
    async withProjectLock(id, fn) { const before = tail; let release; tail = new Promise(r => { release = r; }); await before; try { return await als.run(id, fn); } finally { release(); } },
    withWritePermit: fn => fn(),
  };
  const kernel = { executor: { async commitLocked(id, spec) {
    assert.equal(als.getStore(), 'p'); assert.equal(id, 'p'); assert.equal(node.rev, project.revision);
    commits.push(structuredClone(spec)); assert.deepEqual(spec.mutations.map(m => m.op), ['node.update']);
    const set = spec.mutations[0].set; assert.deepEqual(Object.keys(set), ['sandbox']);
    node = { ...node, sandbox: structuredClone(set.sandbox), rev: ++project.revision }; return { ok: true, revision: project.revision };
  } } };
  const commit = createBindingWriter({ store, kernel });
  const binding = { backend: 'opensandbox', profile: 'pclab19', projectId: 'p', nodeId: 'n', attempt: 1, sessionId: 's', bindingId: 'b', state: 'preparing', verifiedClean: false, operations: {} };
  const change = () => ({ expected: { projectId: 'p', nodeId: 'n', attempt: 1, sessionId: 's', profile: 'pclab19', bindingId: node.sandbox?.bindingId ?? null, nodeRev: node.rev }, binding: structuredClone(binding), event: 'node/sandbox_intent' });
  return { commit, change, binding, commits, store, get node() { return node; }, set node(value) { node = value; } };
}
test('targeted kernel write preserves unrelated fields and never mutates cached input', async () => {
  const f = setup(), old = f.node; await f.commit(f.change()); assert.equal(old.sandbox, undefined); assert.deepEqual(f.node.unrelated, { keep: true }); assert.equal(f.node.sandbox.bindingId, 'b'); assert.equal(f.commits.length, 1);
});
test('stale revision/attempt/session/profile/binding identities reject before kernel', async () => {
  for (const [key, value] of [['nodeRev', 2], ['attempt', 2], ['sessionId', 'other'], ['profile', 'pclab27'], ['bindingId', 'other']]) {
    const f = setup(), c = f.change(); c.expected[key] = value; await assert.rejects(f.commit(c)); assert.equal(f.commits.length, 0, key);
  }
});
test('two writers from one snapshot cannot overwrite each other', async () => {
  const f = setup(), a = f.change(), b = f.change(); const results = await Promise.allSettled([f.commit(a), f.commit(b)]);
  assert.deepEqual(results.map(r => r.status), ['fulfilled', 'rejected']); assert.equal(f.commits.length, 1);
});
test('unknown operation remains immutable through release and physical verifiedClean', async () => {
  const f = setup(); await f.commit(f.change()); const n = structuredClone(f.node); n.sandbox.operations.o = { state: 'unknown', requestHash: 'h' }; f.node = n;
  const c = f.change(); c.binding = { ...structuredClone(n.sandbox), state: 'released', verifiedClean: true, operations: {} }; await assert.rejects(f.commit(c), /unknown/i);
  c.binding.operations = structuredClone(n.sandbox.operations); await f.commit(c); assert.equal(f.node.sandbox.operations.o.state, 'unknown');
});
test('cancelled node is never revived by a late ready binding', async () => {
  const f = setup(), c = f.change(); f.node = { ...f.node, status: 'cancelled' }; c.binding.state = 'ready'; await assert.rejects(f.commit(c), /ready|cancel|running/i);
});
test('cannot relabel a live binding or swap it to another generation', async () => {
  const f = setup(); await f.commit(f.change()); const c = f.change(); c.binding.bindingId = 'new'; await assert.rejects(f.commit(c), /clean|binding/i);
});
test('writer uses current lock rather than recursively acquiring it', async () => {
  const f = setup(); await f.store.withProjectLock('p', () => f.commit(f.change())); assert.equal(f.commits.length, 1);
});
