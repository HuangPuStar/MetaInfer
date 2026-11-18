import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRuntime } from '../host/runtime.js';
function fixture({ factory = true } = {}) {
  let project = { id: 'p', revision: 1, config: {} };
  let node = { id: 'n', projectId: 'p', rev: 1, status: 'planned', currentAttempt: 0,
    execution: { profile: 'sandbox', driver: 'dsh', sandboxProfile: 'pclab19' } };
  const calls = [], lock = new AsyncLocalStorage(); let sandboxDeps;
  const store = { getProject: () => project, getNode: () => node, listProjects: () => [project], listNodes: () => [node],
    isProjectLocked: id => lock.getStore() === id, withProjectLock: (id, fn) => lock.run(id, fn), withWritePermit: fn => fn(),
    saveNode() { throw Error('direct writer'); } };
  const kernel = { executor: { async commitLocked(id, spec) {
    assert.equal(lock.getStore(), id); assert.equal(spec.expectedProjectRevision, project.revision);
    for (const mutation of spec.mutations) {
      if (mutation.op === 'node.put') { assert.equal(spec.basis, node.rev); node = structuredClone(mutation.node); }
      else { assert.equal(mutation.op, 'node.update'); assert.equal(mutation.set?.status, undefined);
        node = { ...structuredClone(node), ...structuredClone(mutation.set ?? {}) };
        for (const key of mutation.unset ?? []) delete node[key]; }
    }
    node.rev = ++project.revision; return { ok: true, revision: project.revision };
  } } };
  const sandbox = { isSandbox: n => !!n.execution?.sandboxProfile,
    start: async (...args) => { calls.push(['start', ...args]); return { node: structuredClone(node), startOutcome: { status: 'held' } }; },
    terminate: async (...args) => { calls.push(['terminate', ...args]); return { node: structuredClone(node) }; },
    pumpLeases: async () => calls.push(['pump']), tick: async () => calls.push(['tick']),
    dispose: async () => { await new Promise(setImmediate); calls.push(['dispose']); }, has: () => false };
  const runtime = createRuntime({ ctx: {}, store, kernel, git: {}, sandboxBackend: {}, sandboxAdmission: {},
    ...(factory ? { sandboxFactory: deps => { sandboxDeps = deps; return sandbox; } } : {}) });
  return { runtime, calls, get node() { return node; }, set node(n) { node = n; }, get deps() { return sandboxDeps; } };
}
test('sandbox start routes before local model/cluster/danger mode', async () => {
  const f = fixture(); await f.runtime.start('p', 'n', { marker: 'only' });
  assert.deepEqual(f.calls, [['start', 'p', 'n', { marker: 'only' }]]);
  assert.equal(typeof f.deps.worker.select, 'function'); assert.equal(typeof f.deps.worker.anchor, 'function'); assert.equal(typeof f.deps.worker.usage, 'function');
});
test('CPU/binding-only/invalid sandbox policy never falls through to local', async () => {
  for (const execution of [{ driver: 'dsh', sandboxProfile: 'pclab19' }, { driver: 'dsh', sandboxProfile: null }, { driver: 'dsh' }]) {
    const f = fixture(); f.node = { ...f.node, execution, needs: {}, sandbox: { backend: 'opensandbox' } };
    await f.runtime.start('p', 'n'); assert.equal(f.calls[0][0], 'start');
  }
});
test('cancel/terminate preserve expected revision and bypass local reaper', async () => {
  const f = fixture(); await f.runtime.cancel('p', 'n', { expectedRevision: 1 });
  assert.deepEqual(f.calls[0], ['terminate', 'p', 'n', 'cancel', { expectedRevision: 1 }]);
  await f.runtime.terminate('p', 'n', 'timeout', { message: 'bound' }); assert.equal(f.calls[1][3], 'timeout');
  await assert.rejects(f.runtime.cancel('p', 'n', { expectedRevision: 0 }), /revision/);
});
test('followup/merge/preempt reject rather than become Host work', async () => {
  const f = fixture(); await assert.rejects(f.runtime.message('p', 'n', 'continue'), /sandbox|沙箱/i);
  await assert.rejects(f.runtime.finishMerge('p', 'n'), /sandbox|沙箱/i);
  await assert.rejects(f.runtime.preempt('p', 'n'), /sandbox|沙箱/i); assert.equal(f.calls.length, 0);
});
test('retry rejects Unknown without changing its owner', async () => {
  const f = fixture(); f.node = { ...f.node, status: 'failed', currentAttempt: 1,
    sandbox: { backend: 'opensandbox', profile: 'pclab19', state: 'unknown', verifiedClean: false, operations: { exec: { state: 'unknown' } } } };
  const before = structuredClone(f.node); await assert.rejects(f.runtime.retry('p', 'n'), /sandbox|沙箱/i);
  assert.deepEqual(f.node, before); assert.equal(f.calls.length, 0);
});
test('clean retry plans via kernel then uses same admission path', async () => {
  const f = fixture(); f.node = { ...f.node, status: 'failed', currentAttempt: 1, sessionId: 'old',
    sandbox: { backend: 'opensandbox', profile: 'pclab19', state: 'released', verifiedClean: true, operations: {} },
    attempts: [{ index: 1, endedAt: 7 }], error: { message: 'old' } };
  const prior = structuredClone(f.node.sandbox); await f.runtime.retry('p', 'n', { upgrade: false });
  assert.equal(f.node.status, 'planned'); assert.equal(f.node.currentAttempt, 1); assert.deepEqual(f.node.sandbox, prior);
  assert.equal(f.node.error, undefined); assert.equal(f.calls[0][0], 'start');
});
test('pump/watchdog/awaited dispose connect without legacy cluster', async () => {
  const f = fixture(); await f.runtime.pumpLeases(); await f.runtime.tick();
  const closing = f.runtime.dispose(); assert.equal(typeof closing?.then, 'function'); await closing;
  assert.deepEqual(f.calls.map(x => x[0]), ['pump', 'tick', 'dispose']);
});
test('missing adapter fails closed before local execution', async () => {
  const f = fixture({ factory: false }); await assert.rejects(f.runtime.start('p', 'n'), /sandbox|沙箱/i);
});
