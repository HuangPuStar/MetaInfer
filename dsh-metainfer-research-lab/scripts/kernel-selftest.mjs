/**
 * Offline self-test for the deterministic kernel (WP P1.1-P1.6).
 * Run from the plugin directory: `node scripts/kernel-selftest.mjs`
 */
import assert from 'node:assert/strict';
import { openStore } from '../host/store.js';
import { createExecutor } from '../host/kernel/executor.js';
import { createProjection } from '../host/kernel/projection.js';
import { createEventBus } from '../host/kernel/bus.js';
import { comparePriority, fairOrder, normalizePriority } from '../host/kernel/priority.js';
import { sessionLabel, parseSessionLabel, inputDigest, withCause, walkCauses, eventRef } from '../host/kernel/trace.js';
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

async function setup({ domain = memoryDomain(), clockStart = 1_000 } = {}) {
  const store = await openStore(storeContext(domain));
  let now = clockStart;
  const clock = () => now;
  const advance = (ms) => { now += ms; };
  const bus = createEventBus();
  const projection = createProjection({ store, strict: true, clock });
  const executor = createExecutor({ store, clock, projection, bus });
  await store.saveProject({ id: 'prj-t', name: 't', revision: 0, counters: { eventSeq: 0 }, config: {} });
  projection.load('prj-t');
  return { domain, store, clock, advance, bus, projection, executor };
}

const human = { kind: 'human', id: 'user' };
const system = { kind: 'system', id: 'kernel' };

function nodeSpec(id, extra = {}) {
  return { op: 'node.create', node: { id, title: id, prompt: `do ${id}`, status: 'planned', ...extra } };
}

await test('commit creates nodes, bumps revision once, writes events with envelope', async () => {
  const { store, executor, projection } = await setup();
  const result = await executor.commit('prj-t', { actor: human, mutations: [nodeSpec('n-1'), nodeSpec('n-2', { parentId: 'n-1' })] });
  assert.equal(result.ok, true);
  assert.equal(result.revision, 1);
  assert.equal(store.getProject('prj-t').revision, 1);
  const events = store.listEvents('prj-t');
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.type), ['node/created', 'node/created']);
  for (const event of events) {
    assert.deepEqual(event.actor, human);
    assert.equal(event.revision, 1);
    assert.equal(event.commit.size, 2);
  }
  assert.equal(store.getNode('prj-t', 'n-2').rev, 1);
  assert.deepEqual(projection.children('prj-t', 'n-1').map((n) => n.id), ['n-2']);
  assert.deepEqual(projection.checkConsistency('prj-t'), []);
});

await test('a failing mutation rejects the whole commit and writes nothing', async () => {
  const { store, executor } = await setup();
  const result = await executor.commit('prj-t', { actor: human, mutations: [nodeSpec('n-1'), nodeSpec('n-x', { parentId: 'missing' })] });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not_found');
  assert.equal(store.getNode('prj-t', 'n-1'), undefined);
  assert.equal(store.listEvents('prj-t').length, 0);
  assert.equal(store.getProject('prj-t').revision, 0);
});

await test('illegal transitions and protected fields are refused', async () => {
  const { executor } = await setup();
  await executor.commit('prj-t', { actor: human, mutations: [nodeSpec('n-1')] });
  const illegal = await executor.commit('prj-t', { actor: system, mutations: [{ op: 'node.transition', nodeId: 'n-1', to: 'completed' }] });
  assert.equal(illegal.code, 'illegal_transition');
  const protectedField = await executor.commit('prj-t', { actor: system, mutations: [{ op: 'node.update', nodeId: 'n-1', set: { status: 'running' } }] });
  assert.equal(protectedField.code, 'protected_field');
});

await test('cycle.put returns its event and persists the cycle', async () => {
  const { store, executor } = await setup();
  const result = await executor.commit('prj-t', {
    actor: system,
    mutations: [{ op: 'cycle.put', cycle: { id: 'cyc-1', projectId: 'prj-t', status: 'running', trigger: 'manual' }, counters: { eventSeq: 0, cycles: 1 } }],
  });
  assert.equal(result.ok, true);
  const cycles = store.listCycles('prj-t');
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].id, 'cyc-1');
  assert.equal(store.getProject('prj-t').counters.cycles, 1);
  assert.ok(store.listEvents('prj-t').some((event) => event.type === 'cycle/saved'));
});

await test('stale basis is rejected with conflicts; allowStale bypasses', async () => {
  const { executor } = await setup();
  const first = await executor.commit('prj-t', { actor: human, mutations: [nodeSpec('n-1')] });
  await executor.commit('prj-t', { actor: human, mutations: [{ op: 'node.update', nodeId: 'n-1', set: { title: 'edited' } }] });
  const stale = await executor.commit('prj-t', {
    actor: { kind: 'expert', id: 'exp-1' },
    basis: first.revision,
    mutations: [{ op: 'node.setPriority', nodeId: 'n-1', priority: { class: 'deferred' } }],
  });
  assert.equal(stale.code, 'stale');
  assert.equal(stale.conflicts[0].nodeId, 'n-1');
  const forced = await executor.commit('prj-t', {
    actor: system, basis: first.revision, allowStale: true,
    mutations: [{ op: 'node.setPriority', nodeId: 'n-1', priority: { class: 'p1' } }],
  });
  assert.equal(forced.ok, true);
});

await test('idempotency key replays the first result without writing again', async () => {
  const { store, executor } = await setup();
  const a = await executor.commit('prj-t', { actor: human, idempotencyKey: 'k1', mutations: [nodeSpec('n-1')] });
  const b = await executor.commit('prj-t', { actor: human, idempotencyKey: 'k1', mutations: [nodeSpec('n-1')] });
  assert.equal(b.replayed, true);
  assert.equal(b.revision, a.revision);
  assert.equal(store.listEvents('prj-t').length, 1);
});

await test('stored records are never mutated by a rejected commit (deep-copy working set)', async () => {
  const { store, executor } = await setup();
  await executor.commit('prj-t', { actor: human, mutations: [nodeSpec('n-1')] });
  const before = JSON.stringify(store.getNode('prj-t', 'n-1'));
  const result = await executor.commit('prj-t', {
    actor: human,
    mutations: [{ op: 'node.update', nodeId: 'n-1', set: { title: 'changed' } }, { op: 'node.transition', nodeId: 'n-1', to: 'completed' }],
  });
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(store.getNode('prj-t', 'n-1')), before);
});

await test('claim is the dispatch commit point and runnable excludes claimed/deferred/held nodes', async () => {
  const { executor, projection, advance } = await setup();
  await executor.commit('prj-t', {
    actor: human,
    mutations: [
      nodeSpec('n-a', { priority: { class: 'p2' } }),
      nodeSpec('n-b', { priority: { class: 'p0' } }),
      nodeSpec('n-c', { priority: { class: 'deferred' } }),
      nodeSpec('n-d', { dispatchHold: { untilMs: 10_000 } }),
    ],
  });
  assert.deepEqual(projection.runnable('prj-t').map((n) => n.id), ['n-b', 'n-a']);
  const claim = await executor.commit('prj-t', { actor: { kind: 'dispatcher', id: 'det' }, mutations: [{ op: 'node.claim', nodeId: 'n-b', claim: { decisionId: 'd-1' } }] });
  assert.equal(claim.ok, true);
  const again = await executor.commit('prj-t', { actor: { kind: 'dispatcher', id: 'det' }, mutations: [{ op: 'node.claim', nodeId: 'n-b', claim: { decisionId: 'd-2' } }] });
  assert.equal(again.code, 'already_claimed');
  assert.deepEqual(projection.runnable('prj-t').map((n) => n.id), ['n-a']);
  const deferredClaim = await executor.commit('prj-t', { actor: { kind: 'dispatcher', id: 'det' }, mutations: [{ op: 'node.claim', nodeId: 'n-c', claim: { decisionId: 'd-3' } }] });
  assert.equal(deferredClaim.code, 'not_runnable');
  await executor.commit('prj-t', { actor: system, mutations: [{ op: 'node.transition', nodeId: 'n-b', to: 'running' }] });
  assert.equal(projection.getNode('prj-t', 'n-b').claim, undefined, 'transition consumes the claim');
  advance(20_000);
  assert.deepEqual(projection.runnable('prj-t').map((n) => n.id), ['n-a', 'n-d']);
});

await test('projection records are frozen in strict mode', async () => {
  const { executor, projection } = await setup();
  await executor.commit('prj-t', { actor: human, mutations: [nodeSpec('n-1')] });
  assert.throws(() => { projection.getNode('prj-t', 'n-1').title = 'x'; }, TypeError);
});

await test('events are never deleted (no retention window)', async () => {
  const { store, executor } = await setup();
  await executor.commit('prj-t', { actor: human, mutations: [nodeSpec('n-1')] });
  const project = store.getProject('prj-t');
  for (let index = 0; index < 5_200; index += 1) await store.appendEvent(project, 'test/filler', {});
  await store.saveProject(project);
  const events = store.listEvents('prj-t');
  assert.equal(events.length, 5_201);
  assert.equal(events[0].seq, 1);
});

await test('recover() redoes a commit whose records were not written before a crash', async () => {
  const domain = memoryDomain();
  const { store, executor } = await setup({ domain });
  await executor.commit('prj-t', { actor: human, mutations: [nodeSpec('n-1')] });
  // Crash after the 2 event puts of the next commit: records and project are not written.
  domain.failAfterPuts = domain.puts + 2;
  await assert.rejects(executor.commit('prj-t', {
    actor: human,
    mutations: [{ op: 'node.update', nodeId: 'n-1', set: { title: 'after' } }, nodeSpec('n-2')],
  }));
  domain.failAfterPuts = Infinity;
  assert.equal(store.getNode('prj-t', 'n-2'), undefined);
  const report = await executor.recover('prj-t');
  assert.deepEqual(report, { redone: 2, discarded: 0 });
  assert.equal(store.getNode('prj-t', 'n-1').title, 'after');
  assert.equal(store.getNode('prj-t', 'n-2').status, 'planned');
  assert.equal(store.getProject('prj-t').revision, 2);
  assert.equal(store.getProject('prj-t').counters.eventSeq, 3);
  assert.deepEqual(await executor.recover('prj-t'), { redone: 0, discarded: 0 }, 'recover is idempotent');
});

await test('recover() discards the events of an incomplete commit', async () => {
  const domain = memoryDomain();
  const { store, executor } = await setup({ domain });
  await executor.commit('prj-t', { actor: human, mutations: [nodeSpec('n-1')] });
  domain.failAfterPuts = domain.puts + 1; // only 1 of 2 events reaches storage
  await assert.rejects(executor.commit('prj-t', { actor: human, mutations: [nodeSpec('n-2'), nodeSpec('n-3')] }));
  domain.failAfterPuts = Infinity;
  const report = await executor.recover('prj-t');
  assert.deepEqual(report, { redone: 0, discarded: 1 });
  assert.equal(store.listEvents('prj-t').length, 1);
  assert.equal(store.getNode('prj-t', 'n-2'), undefined);
  const next = await executor.commit('prj-t', { actor: human, mutations: [nodeSpec('n-4')] });
  assert.equal(next.revision, 2);
  assert.equal(store.listEvents('prj-t').at(-1).seq, 2);
});

await test('bus delivers in order per subscriber, isolates failures, supports prefixes', async () => {
  const errors = [];
  const bus = createEventBus({ onError: (error, name) => errors.push(name) });
  const seen = [];
  bus.subscribe({ types: ['node/*'] }, async (event) => { seen.push(event.seq); }, 'ok');
  bus.subscribe(null, () => { throw new Error('boom'); }, 'bad');
  bus.publish([{ seq: 1, type: 'node/created' }, { seq: 2, type: 'cycle/started' }, { seq: 3, type: 'node/started' }]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(seen, [1, 3]);
  assert.equal(errors.length, 3);
});

await test('waitForEvents resolves on publish and on timeout', async () => {
  const { store, executor, bus } = await setup();
  const pending = bus.waitForEvents({ projectId: 'prj-t', afterSeq: 0, timeoutMs: 1_000, listEvents: store.listEvents });
  await executor.commit('prj-t', { actor: human, mutations: [nodeSpec('n-1')] });
  assert.equal((await pending).length, 1);
  const empty = await bus.waitForEvents({ projectId: 'prj-t', afterSeq: 1, timeoutMs: 5, listEvents: store.listEvents });
  assert.equal(empty.length, 0);
});

await test('priority tuple ordering and fair share across sources', () => {
  const nodes = [
    { id: 'a', priority: { class: 'p2', score: 0, by: 'exp-1' }, timestamps: { createdAt: 1 } },
    { id: 'b', priority: { class: 'p2', score: 5, by: 'exp-1' }, timestamps: { createdAt: 2 } },
    { id: 'c', priority: { class: 'p1', score: 0, by: 'exp-2' }, timestamps: { createdAt: 3 } },
    { id: 'd', priority: { class: 'p2', score: 0, by: 'exp-2' }, timestamps: { createdAt: 4 } },
  ];
  assert.deepEqual([...nodes].sort(comparePriority).map((n) => n.id), ['c', 'b', 'a', 'd']);
  const usage = new Map([['exp-1', { gpuSeconds: 7_200 }], ['exp-2', { gpuSeconds: 0 }]]);
  assert.deepEqual(fairOrder(nodes, usage).map((n) => n.id), ['c', 'd', 'b', 'a']);
  assert.equal(normalizePriority({ class: 'nope', score: 5_000 }).class, 'p2');
  assert.equal(normalizePriority({ score: 5_000 }).score, 1_000);
});

await test('trace: labels round-trip, digests are stable, ambient cause reaches events, chains walk', async () => {
  const label = sessionLabel({ projectId: 'prj-t', actorKind: 'expert', actorId: 'exp-1', activationId: 'act-1' });
  assert.equal(label, 'mirl/prj-t/expert/exp-1/act-1');
  assert.deepEqual(parseSessionLabel(label), { projectId: 'prj-t', actorKind: 'expert', actorId: 'exp-1', activationId: 'act-1' });
  assert.throws(() => sessionLabel({ projectId: 'a/b', actorKind: 'expert', actorId: 'x' }));
  assert.equal(inputDigest('x'), inputDigest('x'));
  const { store, executor } = await setup();
  await executor.commit('prj-t', { actor: human, mutations: [nodeSpec('n-1')] });
  const first = store.listEvents('prj-t')[0];
  await withCause(eventRef(first), () => executor.commit('prj-t', {
    actor: system, mutations: [{ op: 'event.record', type: 'trigger/fired', data: { rule: 'lowWater' } }],
  }));
  const second = store.listEvents('prj-t')[1];
  assert.equal(second.causeId, 'evt:prj-t:1');
  const index = new Map(store.listEvents('prj-t').map((e) => [e.seq, e]));
  const walk = walkCauses(second, (_p, seq) => index.get(seq));
  assert.deepEqual(walk.chain.map((e) => e.seq), [2, 1]);
});

let failed = 0;
for (const result of results) {
  if (result.ok) console.log(`ok   ${result.name}`);
  else {
    failed += 1;
    console.log(`FAIL ${result.name}\n     ${result.error?.stack ?? result.error}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} kernel checks passed`);
process.exit(failed === 0 ? 0 : 1);
