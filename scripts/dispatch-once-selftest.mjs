/**
 * Self-test for the deterministic fast path `dispatchOnce` (design decision B3).
 *
 * Asserts the measurable claim from QA Q3/Q7: on a synthetic 500-node DAG the
 * dispatch decision (selection + lease + kernel claim, up to `launcher.start`)
 * completes in under 100 ms, and never starts a deferred, claimed, denied or
 * held node.
 *
 * Run: `node scripts/dispatch-once-selftest.mjs`
 */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { openStore } from '../host/store.js';
import { createExecutor } from '../host/kernel/executor.js';
import { createProjection } from '../host/kernel/projection.js';
import { createEventBus } from '../host/kernel/bus.js';
import { createLocalPoolBroker } from '../host/dispatch/brokers.js';
import { createDispatchOnce } from '../host/dispatch/dispatch-once.js';
import { createDispatchEnvelope } from '../host/dispatch/envelope.js';
import { DISPATCH_POLICY, authorizeDispatch } from '../host/kernel/policy.js';
import { memoryDomain, storeContext } from './lib/memory-domain.mjs';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

const human = { kind: 'human', id: 'user' };
const sys = { kind: 'system', id: 'runtime' };
const DISPATCH_BUDGET_MS = 100;

async function setup({ maxRunningNodes = 8, gpu = 8, launchFails = false } = {}) {
  const store = await openStore(storeContext(memoryDomain()));
  let now = 1_000;
  const clock = () => now;
  const bus = createEventBus();
  const projection = createProjection({ store, strict: true, clock });
  const executor = createExecutor({ store, clock, projection, bus });
  await store.saveProject({
    id: 'p', revision: 0, counters: { eventSeq: 0 }, updatedAt: 0,
    config: { maxRunningNodes, resourcePools: { gpu }, maxNodes: 1000 },
  });
  projection.load('p');
  const local = createLocalPoolBroker({ limits: () => ({ maxRunningNodes, resourcePools: { gpu } }), clock });
  const brokers = new Map([['local-pool', local], ['cluster', local]]);
  const launched = [];
  const launcher = {
    async start(projectId, nodeId, { lease }) {
      if (launchFails) throw new Error('worktree creation failed');
      launched.push(nodeId);
      await executor.commit(projectId, {
        actor: sys,
        mutations: [{ op: 'node.transition', nodeId, to: 'running', set: { lease: { leaseId: lease.leaseId, broker: lease.broker } } }],
      });
    },
  };
  const once = createDispatchOnce({ projectId: 'p', executor, projection, brokers, launcher, clock });
  return { store, clock, advance: (ms) => { now += ms; }, projection, executor, local, brokers, launcher, launched, once };
}

async function addNodes(executor, specs) {
  // Chunked so one 500-mutation commit does not build a giant event.
  for (let index = 0; index < specs.length; index += 100) {
    const chunk = specs.slice(index, index + 100);
    await executor.commit('p', {
      actor: human,
      mutations: chunk.map(([id, cls, gpu = 1, createdAt]) => ({
        op: 'node.create',
        node: {
          id,
          status: 'planned',
          needs: { gpu },
          timeboxMs: 600_000,
          priority: { class: cls },
          timestamps: { createdAt: createdAt ?? Number(id.replace(/\D/g, '')) },
        },
      })),
    });
  }
}

await test('500-node DAG: dispatchOnce starts 8 by priority in under 100 ms', async () => {
  const env = await setup();
  const specs = [];
  for (let index = 0; index < 500; index += 1) specs.push([`n${1000 + index}`, 'p2', 1, index]);
  // Human p0 and a p1 must jump the queue even though they are the newest nodes.
  specs.push(['n-human', 'p0', 1, 900], ['n-fix', 'p1', 1, 901]);
  await addNodes(env.executor, specs);

  const wallStart = performance.now();
  const result = await env.once.run();
  const wallMs = performance.now() - wallStart;

  assert.equal(result.started, 8);
  assert.equal(env.launched.length, 8);
  assert.deepEqual(env.launched.slice(0, 2), ['n-human', 'n-fix'], 'class wins over age');
  assert.ok(result.selectionMs < DISPATCH_BUDGET_MS, `selection took ${result.selectionMs} ms`);
  assert.ok(result.durationMs < DISPATCH_BUDGET_MS, `dispatch decision took ${result.durationMs} ms`);
  assert.ok(wallMs < DISPATCH_BUDGET_MS * 4, `wall clock ${wallMs.toFixed(1)} ms (includes storage writes)`);
  assert.equal(result.runnable, 502);
  assert.ok(result.candidates <= 128, 'ordering is capped to the start budget plus backfill slack');
  assert.ok(result.candidates >= 32, 'but has enough slack to backfill');
  // Queued nodes are reported, not silently dropped.
  assert.ok(result.skipped.some((item) => item.status === 'queued'), 'capacity overflow is reported per node');
  assert.equal(env.local.size, 8);
});

await test('deferred and oversized nodes are never started', async () => {
  const env = await setup({ maxRunningNodes: 4, gpu: 4 });
  await addNodes(env.executor, [
    ['n-deferred', 'deferred', 1, 1],
    ['n-huge', 'p2', 8, 2],
    ['n-ok', 'p2', 1, 3],
  ]);
  const result = await env.once.run();
  assert.deepEqual(env.launched, ['n-ok']);
  assert.equal(result.started, 1);
  const skipped = new Map(result.skipped.map((item) => [item.nodeId, item]));
  assert.equal(skipped.has('n-deferred'), false, 'deferred is not even a candidate');
  assert.equal(skipped.get('n-huge').status, 'denied');
  const deferred = env.projection.getNode('p', 'n-deferred');
  assert.equal(deferred.status, 'planned');
});

await test('a launch failure releases the lease, backs off, and the retry is skipped', async () => {
  const env = await setup({ launchFails: true });
  await addNodes(env.executor, [['n1', 'p2', 1, 1]]);
  const first = await env.once.run();
  assert.equal(first.started, 0);
  assert.equal(first.skipped.at(-1).code, 'start_failed');
  const node = env.projection.getNode('p', 'n1');
  assert.equal(node.status, 'planned');
  assert.equal(node.claim, undefined);
  assert.equal(node.dispatchFailures, 1);
  assert.ok(node.dispatchHold.untilMs > env.clock());
  assert.equal(env.local.size, 0, 'no leaked lease');
  const second = await env.once.run();
  assert.equal(second.started, 0);
  assert.equal(second.candidates, 0, 'the held node left the runnable set');
  env.advance(31_000);
  const third = await env.once.run();
  assert.equal(third.candidates, 1, 'the hold expired');
  assert.equal(third.started, 0);
  assert.equal(env.projection.getNode('p', 'n1').dispatchFailures, 2, 'failures accumulate');
});

await test('a second round starts fresh nodes and never re-starts running ones', async () => {
  const env = await setup({ maxRunningNodes: 4, gpu: 4 });
  await addNodes(env.executor, [['n1', 'p2', 1, 1], ['n2', 'p2', 1, 2], ['n3', 'p2', 1, 3]]);
  const first = await env.once.run({ maxStarts: 2 });
  assert.equal(first.started, 2);
  assert.deepEqual(env.launched, ['n1', 'n2']);
  const second = await env.once.run({ maxStarts: 2 });
  assert.equal(second.started, 1);
  assert.deepEqual(env.launched, ['n1', 'n2', 'n3']);
  const third = await env.once.run();
  assert.equal(third.started, 0);
  assert.equal(third.candidates, 0);
});

await test('an expert actor may not take the commit point (G4)', async () => {
  const verdict = authorizeDispatch({ kind: 'expert', id: 'e-1', preset: 'lab-advisor' }, 'dispatch.start', { node: { status: 'planned' } });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'forbidden_dispatch');
  const allowed = authorizeDispatch({ kind: 'dispatcher', id: 'det' }, 'dispatch.start', { node: { status: 'planned' } });
  assert.equal(allowed.ok, true);
  assert.equal(DISPATCH_POLICY.authorize({ kind: 'dispatcher', id: 'det' }, 'dispatch.start', { node: { status: 'planned' } }).ok, true);
});

await test('the envelope refuses a start submitted by an expert even with a valid lease', async () => {
  const env = await setup({ maxRunningNodes: 2, gpu: 2 });
  await addNodes(env.executor, [['n1', 'p2', 1, 1]]);
  const node = env.projection.getNode('p', 'n1');
  const grant = await env.local.acquire({ requestId: 'r-expert', projectId: 'p', nodeId: 'n1', resources: { gpu: 1 } });
  const envelope = createDispatchEnvelope({
    projectId: 'p', executor: env.executor, projection: env.projection, brokers: env.brokers,
    launcher: { start: async () => { throw new Error('must not launch'); } }, policy: DISPATCH_POLICY, clock: env.clock,
  });
  const decision = await envelope.submit({ kind: 'expert', id: 'e-1' }, {
    kind: 'start', nodeId: 'n1', lease: grant.lease, basis: node.rev, reason: 'expert wants it',
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'forbidden_dispatch');
  assert.equal(env.local.size, 0, 'rejected start released the lease');
  assert.equal(env.projection.getNode('p', 'n1').status, 'planned');
  assert.equal(env.launched.length, 0);
});

let failed = 0;
for (const result of results) {
  if (result.ok) console.log(`ok   ${result.name}`);
  else {
    failed += 1;
    console.log(`FAIL ${result.name}\n     ${result.error?.stack ?? result.error}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} dispatchOnce checks passed`);
process.exit(failed === 0 ? 0 : 1);
