/**
 * Single-writer guard test (G1, `kernel.strictWrites`).
 *
 * The invariant "only the kernel executor writes records" was documentation for
 * five rounds. This test makes it executable: unpermitted writes are counted in
 * `warn`, rejected in `throw`, and the executor's commit path always carries the
 * permit (including `recover`).
 *
 * Run: `node scripts/strict-writes-selftest.mjs`
 */
import assert from 'node:assert/strict';
import { openStore } from '../host/store.js';
import { createKernel } from '../host/kernel/instance.js';
import { memoryDomain, storeContext } from './lib/memory-domain.mjs';

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error }); }
}
async function fresh() {
  const store = await openStore(storeContext(memoryDomain()));
  await store.saveProject({ id: 'p', revision: 0, counters: { eventSeq: 0 }, config: {} });
  return store;
}

await test('mode off accepts a direct write and counts nothing', async () => {
  const store = await fresh();
  store.setStrictWrites('off');
  await store.saveNode('p', { id: 'n1', status: 'planned' });
  assert.equal(store.writeStats().unpermitted, 0);
});

await test('mode warn counts a direct write and keeps it', async () => {
  const store = await fresh();
  store.setStrictWrites('warn');
  await store.saveNode('p', { id: 'n1', status: 'planned' });
  const stats = store.writeStats();
  assert.equal(stats.mode, 'warn');
  assert.equal(stats.unpermitted, 1);
  assert.equal(stats.byOp.saveNode, 1);
  assert.ok(store.getNode('p', 'n1'), 'warn never loses data');
});

await test('mode throw rejects a direct write with an actionable code', async () => {
  const store = await fresh();
  store.setStrictWrites('throw');
  let thrown = null;
  try { await store.saveNode('p', { id: 'n1', status: 'planned' }); } catch (error) { thrown = error; }
  assert.ok(thrown, 'the write is rejected');
  assert.equal(thrown.code, 'unpermitted_write');
  assert.match(thrown.message, /strictWrites=throw/);
  assert.equal(store.getNode('p', 'n1'), undefined);
});

await test('an explicit permit makes the write legal in throw mode', async () => {
  const store = await fresh();
  store.setStrictWrites('throw');
  const { withWritePermit } = await import('../host/store.js');
  await withWritePermit(async () => {
    await store.saveNode('p', { id: 'n2', status: 'planned' });
  });
  assert.ok(store.getNode('p', 'n2'));
  assert.equal(store.writeStats().unpermitted, 0);
});

await test('kernel commit and recover carry the permit in throw mode', async () => {
  const store = await fresh();
  store.setStrictWrites('throw');
  const kernel = createKernel({ store });
  kernel.load('p');
  const committed = await kernel.executor.commit('p', {
    actor: { kind: 'human', id: 'test' },
    mutations: [{ op: 'node.create', node: { id: 'n1', title: 't', status: 'planned', timestamps: { createdAt: 1 } } }],
  });
  assert.equal(committed.ok, true);
  assert.ok(store.getNode('p', 'n1'));
  const recovered = await kernel.executor.recover('p');
  assert.ok(recovered.redone >= 0);
  assert.equal(store.writeStats().unpermitted, 0, 'no kernel write was flagged');
});

await test('a legacy writer is still flagged while the kernel is writing', async () => {
  const store = await fresh();
  store.setStrictWrites('warn');
  const kernel = createKernel({ store });
  kernel.load('p');
  await kernel.executor.commit('p', {
    actor: { kind: 'human', id: 'test' },
    mutations: [{ op: 'node.create', node: { id: 'n1', title: 't', status: 'planned', timestamps: { createdAt: 1 } } }],
  });
  // runtime.start()/gc() still write through the store directly: counted, not lost.
  await store.saveNode('p', { ...store.getNode('p', 'n1'), status: 'running' });
  assert.equal(store.writeStats().byOp.saveNode, 1);
  assert.equal(kernel.projection.getNode('p', 'n1').status, 'running');
});

let failed = 0;
for (const result of results) {
  if (result.ok) console.log(`ok   ${result.name}`);
  else { failed += 1; console.log(`FAIL ${result.name}\n     ${result.error?.stack ?? result.error}`); }
}
console.log(`\n${results.length - failed}/${results.length} strict-write checks passed`);
process.exit(failed === 0 ? 0 : 1);
