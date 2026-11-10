/**
 * 5.3.2 / Q3 mechanism C: reservedSlots.p0 + deterministic admission.
 *
 * The reservation must be a view filter, not a second queue: with no p0 waiting
 * p2/p3 use the whole capacity; with a p0 waiting the last N free slots stay
 * free unless the p0 itself starts.
 */
import assert from 'node:assert/strict';
import { openStore } from '../host/store.js';
import { createKernel } from '../host/kernel/instance.js';
import { createDispatchOnce } from '../host/dispatch/dispatch-once.js';
import { createLocalPoolBroker } from '../host/dispatch/brokers.js';
import { applyReservation, reservedSlotsOf } from '../host/dispatch/reservation.js';
import { memoryDomain, storeContext } from './lib/memory-domain.mjs';

let checks = 0;
let failed = 0;
async function test(label, fn) {
  checks += 1;
  try { await fn(); process.stdout.write(`ok   ${label}\n`); }
  catch (error) { failed += 1; process.stdout.write(`FAIL ${label}: ${error?.message ?? error}\n`); }
}

const node = (id, cls) => ({
  id, title: id, status: 'planned',
  priority: { class: cls, by: 'human', depth: 0, failureRecovery: 0 },
  needs: {}, resourcesHeld: {}, timestamps: { createdAt: 1 },
});

await test('reservedSlots defaults to 0 and reads both config shapes', () => {
  assert.equal(reservedSlotsOf({}), 0);
  assert.equal(reservedSlotsOf({ reservedSlots: { p0: 2 } }), 2);
  assert.equal(reservedSlotsOf({ scheduling: { reservedSlots: { p0: 1 } } }), 1);
  assert.equal(reservedSlotsOf({ reservedSlots: { p0: -3 } }), 0);
});

await test('a waiting p0 keeps the last reserved slot from p2', () => {
  const list = [node('p0', 'p0'), node('p2a', 'p2'), node('p2b', 'p2')];
  const kept = applyReservation(list, { runningCount: 0, maxRunningNodes: 2, reservedSlots: 1 });
  assert.deepEqual(kept.map((n) => n.id), ['p0', 'p2a']);
});

await test('without p0 waiting, lower classes use all slots', () => {
  const list = [node('p2a', 'p2'), node('p2b', 'p2')];
  const kept = applyReservation(list, { runningCount: 0, maxRunningNodes: 2, reservedSlots: 1 });
  assert.deepEqual(kept.map((n) => n.id), ['p2a', 'p2b']);
});

await test('reservedSlots=0 is the pre-change behaviour', () => {
  const list = [node('p0', 'p0'), node('p2', 'p2')];
  const kept = applyReservation(list, { runningCount: 0, maxRunningNodes: 1, reservedSlots: 0 });
  assert.deepEqual(kept.map((n) => n.id), ['p0', 'p2']);
});

async function dispatch(projectId, { nodes, reserved, maxRunning = 1 }) {
  const store = await openStore(storeContext(memoryDomain()));
  await store.saveProject({
    id: projectId, name: projectId, mode: 'manual', repo: {}, revision: 0,
    counters: { eventSeq: 0 },
    config: { maxRunningNodes: maxRunning, maxNodes: 100, reservedSlots: { p0: reserved }, resourcePools: {} },
  });
  for (const item of nodes) await store.saveNode(projectId, item);
  const kernel = createKernel({ store });
  kernel.load(projectId);
  const broker = createLocalPoolBroker({
    limits: () => ({ maxRunningNodes: maxRunning, resourcePools: {} }),
  });
  const dispatcher = createDispatchOnce({
    projectId,
    executor: kernel.executor,
    projection: kernel.projection,
    brokers: new Map([['local-pool', broker]]),
    launcher: { start: async () => ({ ok: true }) },
  });
  const round = await dispatcher.run({
    maxStarts: 2,
    config: store.getProject(projectId).config,
    maxRunningNodes: maxRunning,
  });
  kernel.dispose();
  return { round, store };
}

await test('integration: one free slot + reservedSlots.p0=1 starts p0, not p2', async () => {
  const { round } = await dispatch('p-reserve', {
    nodes: [node('p2', 'p2'), node('p0', 'p0')], reserved: 1,
  });
  assert.equal(round.started, 1);
  assert.deepEqual(round.startedNodeIds, ['p0']);
});

await test('integration: no p0 waiting, p2 still starts with the reserve configured', async () => {
  const { round } = await dispatch('p-nop0', {
    nodes: [node('p2', 'p2')], reserved: 1,
  });
  assert.equal(round.started, 1);
  assert.deepEqual(round.startedNodeIds, ['p2']);
});

process.stdout.write(`${checks - failed}/${checks} reserved-slot checks passed\n`);
process.exit(failed === 0 ? 0 : 1);
