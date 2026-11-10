/**
 * Offline self-test for the dispatcher interface, safety envelope, brokers and
 * the deterministic strategy (WP P3.1-P3.5).
 * Run from the plugin directory: `node scripts/dispatch-selftest.mjs`
 */
import assert from 'node:assert/strict';
import { openStore } from '../host/store.js';
import { createExecutor } from '../host/kernel/executor.js';
import { createProjection } from '../host/kernel/projection.js';
import { createEventBus } from '../host/kernel/bus.js';
import { createDispatchEnvelope } from '../host/dispatch/envelope.js';
import { createLocalPoolBroker, createClusterBroker } from '../host/dispatch/brokers.js';
import { createDeterministicStrategy } from '../host/dispatch/deterministic-strategy.js';
import { createDispatcher } from '../host/dispatch/dispatcher.js';
import { validateDecision } from '../host/dispatch/types.js';
import { memoryDomain, storeContext } from './lib/memory-domain.mjs';

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); } catch (error) { results.push({ name, ok: false, error }); }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const human = { kind: 'human', id: 'user' };
const sys = { kind: 'system', id: 'runtime' };

async function setup({ maxRunningNodes = 2, gpu = 2, launchFails = false } = {}) {
  const store = await openStore(storeContext(memoryDomain()));
  let now = 1_000;
  const clock = () => now;
  const bus = createEventBus();
  const projection = createProjection({ store, strict: true, clock });
  const executor = createExecutor({ store, clock, projection, bus });
  await store.saveProject({ id: 'p', revision: 0, counters: { eventSeq: 0 }, config: {} });
  projection.load('p');
  const local = createLocalPoolBroker({ limits: () => ({ maxRunningNodes, resourcePools: { gpu } }), clock });
  const brokers = new Map([['local-pool', local]]);
  const launched = [];
  const launcher = {
    async start(projectId, nodeId, { lease }) {
      if (launchFails) throw new Error('worktree failed');
      launched.push({ nodeId, leaseId: lease.leaseId });
      await executor.commit(projectId, { actor: sys, mutations: [{ op: 'node.transition', nodeId, to: 'running', set: { lease: { leaseId: lease.leaseId, broker: lease.broker } } }] });
    },
  };
  const envelope = createDispatchEnvelope({ projectId: 'p', executor, projection, brokers, launcher, clock });
  const finish = async (nodeId) => {
    const node = projection.getNode('p', nodeId);
    await local.release(node.lease.leaseId);
    await executor.commit('p', { actor: sys, mutations: [{ op: 'node.transition', nodeId, to: 'completed' }] });
  };
  return { store, clock, advance: (ms) => { now += ms; }, bus, projection, executor, local, brokers, launcher, launched, envelope, finish };
}

async function addNodes(executor, specs) {
  await executor.commit('p', {
    actor: human,
    mutations: specs.map(([id, cls, gpu = 1]) => ({ op: 'node.create', node: { id, status: 'planned', needs: { gpu }, timeboxMs: 600_000, priority: { class: cls }, timestamps: { createdAt: Number(id.replace(/\D/g, '')) } } })),
  });
}

function dispatcherFor(env, { active, shadow = null, makeFallback = null, fallbackAfterMs = 60_000 } = {}) {
  return createDispatcher({
    projectId: 'p', executor: env.executor, projection: env.projection, bus: env.bus, brokers: env.brokers,
    brokerIdFor: () => 'local-pool', envelope: env.envelope,
    active: active ?? createDeterministicStrategy({ safetyIntervalMs: 0 }), shadow, makeFallback, fallbackAfterMs, clock: env.clock,
  });
}

await test('decision validation rejects malformed decisions', () => {
  assert.equal(validateDecision({ kind: 'start', nodeId: 'n', basis: 1, reason: 'x' }), 'lease with leaseId and broker is required');
  assert.equal(validateDecision({ kind: 'teleport', reason: 'x' }), 'unknown decision kind teleport');
  assert.equal(validateDecision({ kind: 'release', leaseId: 'l', broker: 'b', reason: 'x' }), null);
});

await test('deterministic strategy starts by priority up to capacity, skips deferred, refills on completion', async () => {
  const env = await setup();
  await addNodes(env.executor, [['n1', 'p2'], ['n2', 'p0'], ['n3', 'p1'], ['n4', 'deferred']]);
  const dispatcher = dispatcherFor(env);
  await dispatcher.start({ watchdogIntervalMs: 0 });
  await settle();
  assert.deepEqual(env.launched.map((l) => l.nodeId), ['n2', 'n3']);
  assert.equal(env.projection.getNode('p', 'n2').status, 'running');
  await env.finish('n2');
  await settle();
  assert.deepEqual(env.launched.map((l) => l.nodeId), ['n2', 'n3', 'n1']);
  assert.equal(env.projection.getNode('p', 'n4').status, 'planned', 'deferred is never dispatched');
  const claims = env.store.listEvents('p').filter((e) => e.type === 'dispatch/claimed');
  assert.equal(claims.length, 3);
  assert.equal(claims[0].actor.kind, 'dispatcher');
  const intents = (env.store.getProject('p').intents ?? []).filter((intent) => intent.kind === 'dispatch');
  assert.equal(intents.length, 3, 'every claimed start writes one dispatch intent');
  assert.equal(intents[0].claim.action, 'claim_node');
  assert.ok(Number.isInteger(intents[0].basis), 'dispatch intent records the basis revision');
  await dispatcher.stop();
});

await test('envelope rejects stale, forged and reused leases and releases what it rejects', async () => {
  const env = await setup();
  await addNodes(env.executor, [['n1', 'p2'], ['n2', 'p2']]);
  const actor = { kind: 'dispatcher', id: 'test' };
  const n1 = env.projection.getNode('p', 'n1');
  const forged = await env.envelope.submit(actor, { kind: 'start', nodeId: 'n1', basis: n1.rev, reason: 't', lease: { leaseId: 'fake', broker: 'local-pool' } });
  assert.equal(forged.code, 'lease_invalid');

  const grant = await env.local.acquire({ requestId: 'r1', projectId: 'p', nodeId: 'n1', resources: { gpu: 1 } });
  const wrongNode = await env.envelope.submit(actor, { kind: 'start', nodeId: 'n2', basis: n1.rev, reason: 't', lease: grant.lease });
  assert.equal(wrongNode.code, 'lease_invalid', 'a lease issued for n1 cannot start n2');
  assert.equal(env.local.size, 0, 'rejected lease was released');

  const grant2 = await env.local.acquire({ requestId: 'r1b', projectId: 'p', nodeId: 'n1', resources: { gpu: 1 } });
  await env.executor.commit('p', { actor: human, mutations: [{ op: 'node.update', nodeId: 'n1', set: { title: 'edited' } }] });
  const stale = await env.envelope.submit(actor, { kind: 'start', nodeId: 'n1', basis: n1.rev, reason: 't', lease: grant2.lease });
  assert.equal(stale.code, 'stale');

  const fresh = env.projection.getNode('p', 'n1');
  const grant3 = await env.local.acquire({ requestId: 'r1c', projectId: 'p', nodeId: 'n1', resources: { gpu: 1 } });
  const ok = await env.envelope.submit(actor, { kind: 'start', nodeId: 'n1', basis: fresh.rev, reason: 't', lease: grant3.lease });
  assert.equal(ok.ok, true);
  const reused = await env.envelope.submit(actor, { kind: 'start', nodeId: 'n2', basis: 99, reason: 't', lease: grant3.lease });
  assert.equal(reused.code, 'lease_reused');
  const rejected = env.store.listEvents('p').filter((e) => e.type === 'dispatch/rejected').map((e) => e.data.code);
  assert.deepEqual(rejected, ['lease_invalid', 'lease_invalid', 'stale', 'lease_reused']);
});

await test('launch failure releases lease and claim and backs the node off', async () => {
  const env = await setup({ launchFails: true });
  await addNodes(env.executor, [['n1', 'p2']]);
  const dispatcher = dispatcherFor(env);
  await dispatcher.start({ watchdogIntervalMs: 0 });
  await settle();
  const node = env.projection.getNode('p', 'n1');
  assert.equal(node.status, 'planned');
  assert.equal(node.claim, undefined);
  assert.equal(node.dispatchFailures, 1);
  assert.ok(node.dispatchHold.untilMs > env.clock());
  assert.equal(env.local.size, 0);
  assert.equal(env.projection.runnable('p').length, 0, 'held back until the backoff expires');
  await dispatcher.stop();
});

await test('shadow strategy only records decisions and never holds GPUs', async () => {
  const env = await setup({ maxRunningNodes: 0 });
  await addNodes(env.executor, [['n1', 'p2']]);
  // Active strategy has no capacity (maxRunningNodes=0); shadow previews against a roomier broker.
  env.brokers.set('local-pool', env.local);
  const roomy = createLocalPoolBroker({ limits: () => ({ maxRunningNodes: 4, resourcePools: { gpu: 4 } }) });
  const shadow = createDeterministicStrategy({ id: 'shadow-det', safetyIntervalMs: 0 });
  const dispatcher = createDispatcher({
    projectId: 'p', executor: env.executor, projection: env.projection, bus: env.bus,
    brokers: new Map([['local-pool', { ...env.local, id: 'local-pool', preview: roomy.preview, acquire: env.local.acquire, verify: env.local.verify, release: env.local.release, renew: env.local.renew }]]),
    brokerIdFor: () => 'local-pool', envelope: env.envelope,
    active: createDeterministicStrategy({ safetyIntervalMs: 0 }), shadow, clock: env.clock,
  });
  await dispatcher.start({ watchdogIntervalMs: 0 });
  await settle();
  const shadowEvents = env.store.listEvents('p').filter((e) => e.type === 'dispatch/shadow_decided');
  assert.equal(shadowEvents.length, 1);
  assert.equal(env.launched.length, 0);
  assert.equal(env.projection.getNode('p', 'n1').status, 'planned');
  assert.equal(roomy.size, 0);
  await dispatcher.stop();
});

await test('fallback replaces a strategy that stops deciding while work waits', async () => {
  const env = await setup();
  await addNodes(env.executor, [['n1', 'p2']]);
  const silentAgent = { id: 'llm-negotiator', kind: 'agent', async start() {}, async stop() {} };
  const dispatcher = dispatcherFor(env, {
    active: silentAgent,
    makeFallback: () => createDeterministicStrategy({ id: 'fallback-det', safetyIntervalMs: 0 }),
    fallbackAfterMs: 60_000,
  });
  await dispatcher.start({ watchdogIntervalMs: 0 });
  assert.equal(await dispatcher.checkFallback(), false);
  env.advance(61_000);
  assert.equal(await dispatcher.checkFallback(), true);
  await settle();
  assert.equal(dispatcher.activeId, 'fallback-det');
  assert.deepEqual(env.launched.map((l) => l.nodeId), ['n1']);
  const fallback = env.store.listEvents('p').find((e) => e.type === 'dispatch/fallback');
  assert.equal(fallback.data.from, 'llm-negotiator');
  await dispatcher.stop();
});

await test('cluster broker adapts the coordinator facade and verifies only its own grants', async () => {
  const calls = [];
  const facade = {
    async acquire(req) {
      calls.push(req);
      if (req.nodeId === 'queued') return { status: 'queued', position: 3, reason: 'waiting-for-fleet-capacity' };
      return { status: 'granted', lease: { leaseId: `L-${req.nodeId}`, requestId: req.requestId, projectId: req.projectId, nodeId: req.nodeId, machineId: 'm1', deviceIds: ['g0'], grantedAt: 0, expiresAt: 10 ** 12 } };
    },
    async renew() { return { status: 'lost' }; },
    async release() {},
  };
  const broker = createClusterBroker({ cluster: facade, clock: () => 0 });
  const granted = await broker.acquire({ requestId: 'r', projectId: 'p', nodeId: 'n1', amount: 1, walltimeMs: 600_000 });
  assert.equal(granted.lease.broker, 'cluster');
  assert.equal(granted.lease.hardEndAt, 600_000);
  assert.deepEqual(granted.lease.machines, [{ machineId: 'm1', deviceIds: ['g0'] }]);
  assert.equal(await broker.verify(granted.lease, { projectId: 'p', nodeId: 'n1' }), true);
  assert.equal(await broker.verify(granted.lease, { projectId: 'p', nodeId: 'other' }), false);
  assert.equal(await broker.verify({ leaseId: 'L-forged' }, { projectId: 'p', nodeId: 'n1' }), false);
  assert.equal((await broker.acquire({ requestId: 'q', projectId: 'p', nodeId: 'queued', amount: 1 })).status, 'queued');
  const gang = await broker.acquire({ requestId: 'g', projectId: 'p', nodeId: 'gang', shapes: [{ machines: 2, gpusPerMachine: 8 }], walltimeMs: 1 });
  assert.equal(gang.status, 'granted');
  assert.equal(calls.at(-1).amount, 16);
  assert.equal(calls.at(-1).placement, 'fleet');
  assert.equal((await broker.renew(granted.lease.leaseId)).status, 'lost');
  assert.equal(await broker.verify(granted.lease, { projectId: 'p', nodeId: 'n1' }), false, 'lost lease no longer verifies');
});

let failed = 0;
for (const result of results) {
  if (result.ok) console.log(`ok   ${result.name}`);
  else { failed += 1; console.log(`FAIL ${result.name}\n     ${result.error?.stack ?? result.error}`); }
}
console.log(`\n${results.length - failed}/${results.length} dispatch checks passed`);
process.exit(failed === 0 ? 0 : 1);
