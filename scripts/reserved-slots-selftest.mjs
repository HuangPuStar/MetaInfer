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
import { PREEMPTION_MIN_RUN_MS, applyClassBudgets, applyReservation, classBudgetOf, reservedSlotsOf, selectPreemptionVictim } from '../host/dispatch/reservation.js';
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

await test('per-class budgets parse both shapes and treat absent budgets as uncapped', () => {
  assert.equal(classBudgetOf({}, 'p2'), null);
  assert.equal(classBudgetOf({ scheduling: { classBudgets: { p2: 1 } } }, 'p2'), 1);
  assert.equal(classBudgetOf({ scheduling: { budgets: { p3: 2 } } }, 'p3'), 2);
  assert.equal(classBudgetOf({ classBudgets: { p0: 0 } }, 'p0'), 0);
  const admitted = applyClassBudgets([node('p2a', 'p2'), node('p2b', 'p2'), node('p3', 'p3')], {
    running: [], config: { scheduling: { classBudgets: { p2: 1 } } },
  });
  assert.deepEqual(admitted.map((row) => row.id), ['p2a', 'p3']);
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


await test('preemption selector only takes an old lower-class running experiment', () => {
  const now = 20_000_000;
  const running = [
    { id: 'p2-new', status: 'running', priority: { class: 'p2' }, timestamps: { startedAt: now - 60_000 } },
    { id: 'p3-old', status: 'running', priority: { class: 'p3' }, timestamps: { startedAt: now - PREEMPTION_MIN_RUN_MS - 1 } },
    { id: 'p2-old', status: 'running', priority: { class: 'p2' }, timestamps: { startedAt: now - PREEMPTION_MIN_RUN_MS - 2 } },
    { id: 'merge', status: 'running', kind: 'merge', priority: { class: 'p3' }, timestamps: { startedAt: now - PREEMPTION_MIN_RUN_MS - 3 } },
  ];
  const p0 = node('p0', 'p0');
  const victim = selectPreemptionVictim({ now, running, runnable: [p0], maxRunningNodes: 4 });
  assert.equal(victim?.id, 'p3-old');
  assert.equal(selectPreemptionVictim({ now, running, runnable: [p0], maxRunningNodes: 5 }), null);
  const withP1 = [...running, { id: 'p1-old', status: 'running', priority: { class: 'p1' }, timestamps: { startedAt: now - PREEMPTION_MIN_RUN_MS - 5 } }];
  assert.equal(selectPreemptionVictim({ now, running: withP1, runnable: [p0], maxRunningNodes: 5 })?.id, 'p3-old');
  assert.equal(selectPreemptionVictim({ now, running, runnable: [node('p2', 'p2')], maxRunningNodes: 4 }), null);
  assert.equal(selectPreemptionVictim({ now, running, runnable: [p0], maxRunningNodes: 4, enabled: false }), null);
  assert.equal(selectPreemptionVictim({ now, running: [{ ...running[0], timestamps: { startedAt: now - 10 } }], runnable: [p0], maxRunningNodes: 1 }), null);
});

await test('integration: a p0 preempts one old p2 and takes the freed slot', async () => {
  const store = await openStore(storeContext(memoryDomain()));
  const projectId = 'p-preempt';
  const now = Date.now();
  await store.saveProject({
    id: projectId, name: projectId, mode: 'manual', repo: {}, revision: 0,
    counters: { eventSeq: 0 },
    config: { maxRunningNodes: 1, maxNodes: 100, resourcePools: {} },
  });
  const victim = {
    ...node('victim', 'p2'), status: 'running',
    timestamps: { createdAt: now - 900_000, startedAt: now - PREEMPTION_MIN_RUN_MS - 1 },
  };
  await store.saveNode(projectId, victim);
  await store.saveNode(projectId, node('p0', 'p0'));
  const kernel = createKernel({ store });
  kernel.load(projectId);
  const broker = createLocalPoolBroker({ limits: () => ({ maxRunningNodes: 1, resourcePools: {} }) });
  broker.adopt({ leaseId: 'lease-victim', requestId: 'victim:1', projectId, nodeId: 'victim', resources: {} });
  const preempted = [];
  const dispatcher = createDispatchOnce({
    projectId,
    executor: kernel.executor,
    projection: kernel.projection,
    brokers: new Map([['local-pool', broker]]),
    launcher: {
      start: async () => ({ ok: true }),
      preempt: async (pid, nodeId, options) => {
        preempted.push({ nodeId, options });
        const commit = await kernel.executor.commit(pid, {
          actor: { kind: 'system', id: 'test-preemptor' },
          mutations: [{ op: 'node.transition', nodeId, from: 'running', to: 'cancelled' }],
        });
        assert.equal(commit.ok, true, JSON.stringify(commit));
      },
    },
  });
  const round = await dispatcher.run({ maxStarts: 1, maxRunningNodes: 1, config: store.getProject(projectId).config });
  assert.deepEqual(round.startedNodeIds, ['p0']);
  assert.equal(round.preempted?.victimNodeId, 'victim');
  assert.equal(round.preempted?.forNodeId, 'p0');
  assert.equal(preempted.length, 1);
  assert.equal(preempted[0].options.forNodeId, 'p0');
  assert.equal(store.getNode(projectId, 'victim').status, 'cancelled');
  assert.ok(store.listEvents(projectId).some((event) => event.type === 'dispatch/preempting'));
  kernel.dispose();
});

await test('integration: a per-class budget caps starts even when global capacity remains', async () => {
  const store = await openStore(storeContext(memoryDomain()));
  const projectId = 'p-class-budget';
  await store.saveProject({
    id: projectId, name: projectId, mode: 'manual', repo: {}, revision: 0,
    counters: { eventSeq: 0 },
    config: { maxRunningNodes: 4, maxNodes: 100, resourcePools: {}, scheduling: { classBudgets: { p2: 1 } } },
  });
  await store.saveNode(projectId, node('p2a', 'p2'));
  await store.saveNode(projectId, node('p2b', 'p2'));
  const kernel = createKernel({ store });
  kernel.load(projectId);
  const broker = createLocalPoolBroker({ limits: () => ({ maxRunningNodes: 4, resourcePools: {} }) });
  const dispatcher = createDispatchOnce({
    projectId,
    executor: kernel.executor,
    projection: kernel.projection,
    brokers: new Map([['local-pool', broker]]),
    launcher: { start: async () => ({ ok: true }) },
  });
  const round = await dispatcher.run({ maxStarts: 2, maxRunningNodes: 4, config: store.getProject(projectId).config });
  assert.equal(round.started, 1);
  assert.deepEqual(round.startedNodeIds, ['p2a']);
  assert.equal(store.getNode(projectId, 'p2b').status, 'planned');
  assert.equal(round.delayed?.[0]?.nodeId, 'p2b');
  assert.equal(round.delayed?.[0]?.reason, 'class_budget_exhausted');
  assert.ok(store.listEvents(projectId).some((event) => event.type === 'priority/delayed'
    && event.data?.nodes?.some((row) => row.nodeId === 'p2b')), 'priority/delayed event is written');
  kernel.dispose();
});

await test('integration: p0 waiting >30s gets blockedBy and expectedRemaining in a priority/delayed event', async () => {
  const store = await openStore(storeContext(memoryDomain()));
  const projectId = 'p-p0-wait';
  const now = Date.now();
  await store.saveProject({
    id: projectId, name: projectId, mode: 'manual', repo: {}, revision: 0,
    counters: { eventSeq: 0 },
    config: { maxRunningNodes: 1, maxNodes: 100, resourcePools: {} },
  });
  await store.saveNode(projectId, {
    ...node('busy', 'p2'), status: 'running', deadlineAt: now + 120_000,
    timestamps: { createdAt: now - 120_000, startedAt: now - 60_000 },
  });
  await store.saveNode(projectId, {
    ...node('p0-wait', 'p0'), priority: { class: 'p0', at: now - 31_000, by: 'human', depth: 0, failureRecovery: 0 },
  });
  const kernel = createKernel({ store });
  kernel.load(projectId);
  const broker = createLocalPoolBroker({ limits: () => ({ maxRunningNodes: 1, resourcePools: {} }) });
  broker.adopt({ leaseId: 'lease-busy', requestId: 'busy:1', projectId, nodeId: 'busy', resources: {} });
  const dispatcher = createDispatchOnce({
    projectId,
    executor: kernel.executor,
    projection: kernel.projection,
    brokers: new Map([['local-pool', broker]]),
    launcher: { start: async () => ({ ok: true }) },
  });
  const round = await dispatcher.run({ maxStarts: 1, maxRunningNodes: 1, config: store.getProject(projectId).config });
  assert.equal(round.started, 0, JSON.stringify(round));
  const wait = round.delayed?.find((row) => row.nodeId === 'p0-wait');
  assert.equal(wait?.reason, 'p0_waiting');
  assert.equal(wait?.blockedBy, 'max_running_nodes');
  assert.ok(wait?.waitedMs >= 30_000);
  assert.ok(wait?.expectedRemainingMs > 0 && wait.expectedRemainingMs <= 120_000);
  const event = store.listEvents(projectId).find((row) => row.type === 'priority/delayed');
  assert.ok(event?.data?.nodes?.some((row) => row.nodeId === 'p0-wait' && row.blockedBy === 'max_running_nodes'));
  kernel.dispose();
});

process.stdout.write(`${checks - failed}/${checks} reserved-slot checks passed\n`);
process.exit(failed === 0 ? 0 : 1);
