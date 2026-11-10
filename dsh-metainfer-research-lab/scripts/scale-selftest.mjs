/**
 * Scale regression test (S1/S2/S3/S4/S6/S7/S10/S13).
 *
 * Generates a 5,000-node project at test time and asserts the budgets the
 * design review adopted. Every number printed here is measured in this process;
 * UI budgets are measured on the view-model in a separate test because a Node
 * process cannot paint.
 *
 * Run: `node scripts/scale-selftest.mjs`
 */
import assert from 'node:assert/strict';
import { openStore } from '../host/store.js';
import { createKernel } from '../host/kernel/instance.js';
import { createDispatchOnce } from '../host/dispatch/dispatch-once.js';
import { createLocalPoolBroker } from '../host/dispatch/brokers.js';
import { createLabService, slimStateNode } from '../host/lab-service.js';
import { buildStatusFacts } from '../host/observability/status.js';
import { memoryDomain, storeContext } from './lib/memory-domain.mjs';

const fakeCtx = { effect: () => {}, get: () => null, logger: { info() {}, warn() {} } };
const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error }); }
}
const nowMs = () => performance.now();

/** Build a wide DAG: node i's parent is i-100 (100 roots). */
async function buildProject(store, count = 5_000) {
  const project = {
    id: 'prj-scale',
    name: 'scale',
    brief: 'benchmark',
    repo: {},
    revision: 0,
    counters: { eventSeq: 0 },
    config: { maxRunningNodes: 200, resourcePools: { gpu: 200 }, maxNodes: 20_000 },
    updatedAt: 0,
  };
  await store.saveProject(project);
  const nodes = [];
  for (let index = 0; index < count; index += 1) {
    const prompt = `Experiment ${index}: tune the pruning ratio and measure accuracy on the evaluation set. `.repeat(20);
    nodes.push({
      id: `n${index}`,
      title: `experiment ${index} token pruning`,
      prompt,
      status: index % 10 === 0 ? 'completed' : 'planned',
      needs: { gpu: 1 },
      timeboxMs: 600_000,
      rev: 1,
      parentId: index >= 100 ? `n${index - 100}` : undefined,
      timestamps: { createdAt: index, startedAt: index, updatedAt: index },
      report: index % 10 === 0
        ? { success: true, summary: `Result ${index}. `.repeat(400), headline: `headline ${index}` }
        : null,
      reportText: index % 10 === 0 ? `raw report ${index}` : undefined,
      attempts: [{ index: 1, status: 'completed', error: null, usage: { totalTokens: 1_000 } }],
    });
  }
  for (const node of nodes) await store.saveNode(project.id, node);
  await store.saveProject({ ...store.getProject(project.id), revision: 1 });
  return project;
}

let store;

await test('setup: 5,000 nodes, in-memory, no Host required', async () => {
  store = await openStore(storeContext(memoryDomain()));
  const started = nowMs();
  await buildProject(store);
  const elapsed = nowMs() - started;
  assert.equal(store.listNodes('prj-scale').length, 5_000);
  console.log(`     built 5,000 nodes in ${elapsed.toFixed(0)} ms`);
});

await test('listNodes is O(page) and copies nothing eagerly', () => {
  const started = nowMs();
  const all = store.listNodes('prj-scale');
  const fullMs = nowMs() - started;
  const pageStart = nowMs();
  const page = store.listNodes('prj-scale', { limit: 100, cursor: 'n2500' });
  const pageMs = nowMs() - pageStart;
  assert.equal(all.length, 5_000);
  assert.equal(page.length, 100);
  assert.ok(fullMs < 200, `full list ${fullMs.toFixed(1)} ms < 200 ms`);
  assert.ok(pageMs < 20, `page ${pageMs.toFixed(1)} ms < 20 ms`);
  console.log(`     listNodes all=${fullMs.toFixed(1)} ms page=${pageMs.toFixed(2)} ms`);
});

await test('event pages stay under 50 ms with 20k events', async () => {
  const project = store.getProject('prj-scale');
  for (let index = 0; index < 20_000; index += 1) {
    await store.appendEvent(project, 'node/edited', { nodeId: `n${index % 5_000}`, data: { index } });
  }
  await store.saveProject(project);
  const started = nowMs();
  const page = store.pageEvents('prj-scale', { after: 15_000, limit: 100 });
  const elapsed = nowMs() - started;
  assert.equal(page.events.length, 100);
  assert.equal(page.events[0].seq, 15_001);
  assert.ok(elapsed < 50, `event page ${elapsed.toFixed(1)} ms < 50 ms`);
  console.log(`     event page 100 of 20k in ${elapsed.toFixed(2)} ms`);
});

await test('run pages are bounded at 50 ms', async () => {
  for (let index = 0; index < 5_000; index += 1) {
    await store.saveRun('prj-scale', { id: `run-${index}`, role: 'advisor', status: 'completed', startedAt: index, endedAt: index + 1 });
  }
  const started = nowMs();
  const page = store.pageRuns('prj-scale', { limit: 50 });
  const elapsed = nowMs() - started;
  assert.equal(page.runs.length, 50);
  assert.equal(page.runs[0].id, 'run-4999');
  assert.ok(elapsed < 50, `run page ${elapsed.toFixed(1)} ms < 50 ms`);
  console.log(`     run page 50 of 5k in ${elapsed.toFixed(2)} ms`);
});

await test('changes_since answers a delta, not the whole state', () => {
  const started = nowMs();
  const delta = store.changesSince('prj-scale', 1);
  const elapsed = nowMs() - started;
  assert.equal(delta.unchanged, true, 'client at the current revision gets an empty delta');
  const cold = store.changesSince('prj-scale', 0);
  assert.ok(cold.full === true || Array.isArray(cold.changed));
  assert.ok(elapsed < 20, `changes ${elapsed.toFixed(2)} ms < 20 ms`);
  console.log(`     changes_since in ${elapsed.toFixed(2)} ms (cold=${cold.full === true ? 'full' : `${cold.changed?.length ?? 0} rows`})`);
});

await test('getState stays under 5 MB and 500 ms at 5,000 nodes', async () => {
  const service = createLabService({
    ctx: fakeCtx, store, git: null, runtime: null, transcript: null, orchestrator: null, auto: null, cluster: null, clusterAdmin: null,
  });
  const started = nowMs();
  const state = await service.getState('prj-scale');
  const elapsed = nowMs() - started;
  const bytes = Buffer.byteLength(JSON.stringify(state), 'utf8');
  const mb = bytes / (1024 * 1024);
  assert.equal(state.nodes.length, 5_000);
  assert.equal(state._indexed, true);
  assert.ok(mb < 5, `${mb.toFixed(2)} MB < 5 MB`);
  assert.ok(elapsed < 500, `${elapsed.toFixed(0)} ms < 500 ms`);
  // Full bodies are still available per node for the inspector.
  const one = service.getNode('prj-scale', 'n0');
  assert.ok(one.node.prompt.length > 600, 'full prompt is one O(1) read away');
  console.log(`     state ${mb.toFixed(2)} MB in ${elapsed.toFixed(0)} ms; slim node ${slimStateNode(store.getNode('prj-scale', 'n0')).prompt.length} prompt chars`);
});

await test('status facts are computed from the same indexed read', async () => {
  const service = createLabService({
    ctx: fakeCtx, store, git: null, runtime: null, transcript: null, orchestrator: null, auto: null, cluster: null, clusterAdmin: null,
  });
  const started = nowMs();
  const facts = await service.statusFacts('prj-scale');
  const elapsed = nowMs() - started;
  assert.equal(facts.counts.total, 5_000);
  assert.equal(facts.running.length, 0);
  assert.ok(facts.nextToStart.length <= 5);
  assert.ok(elapsed < 100, `status facts ${elapsed.toFixed(1)} ms < 100 ms`);
  console.log(`     status facts in ${elapsed.toFixed(1)} ms`);
});

await test('dispatch selection on 5,000 nodes stays under 100 ms (decision latencies)', async () => {
  const kernel = createKernel({ store });
  kernel.load('prj-scale');
  const launched = [];
  const brokers = new Map([['local-pool', createLocalPoolBroker({
    limits: () => ({ maxRunningNodes: 500, resourcePools: { gpu: 500 } }),
  })]]);
  const dispatcher = createDispatchOnce({
    projectId: 'prj-scale',
    executor: kernel.executor,
    projection: kernel.projection,
    brokers,
    launcher: { start: async (projectId, nodeId) => { launched.push(nodeId); } },
  });
  // Start nodes, then release the launch so the next round can pick others.
  kernel.projection.listNodes('prj-scale').slice(0, 100).forEach((node) => {
    // Pretend the first 100 are running: the dispatcher must still pick within budget.
    store.saveNode('prj-scale', { ...node, status: 'running' });
  });
  // One warm-up round pays lazy module/JIT costs before the measured window;
  // a single GC pause must not be mistaken for selection cost.
  await dispatcher.run({ maxStarts: 1 }).then((result) => {
    for (const nodeId of result.startedNodeIds) store.saveNode('prj-scale', { ...store.getNode('prj-scale', nodeId), status: 'running' });
  });
  const decisions = [];
  for (let round = 0; round < 20; round += 1) {
    const started = nowMs();
    const result = await dispatcher.run({ maxStarts: 8 });
    decisions.push(nowMs() - started);
    for (const nodeId of result.startedNodeIds) {
      store.saveNode('prj-scale', { ...store.getNode('prj-scale', nodeId), status: 'running' });
    }
  }
  const max = Math.max(...decisions);
  const p95 = [...decisions].sort((a, b) => a - b)[Math.ceil(decisions.length * 0.95) - 1];
  assert.ok(p95 < 100, `dispatch decision p95 ${p95.toFixed(1)} ms < 100 ms (max ${max.toFixed(1)})`);
  assert.ok(launched.length > 0, 'at least one node was launched through the envelope');
  console.log(`     dispatch decision max=${max.toFixed(1)} ms p95=${p95.toFixed(1)} ms starts=${launched.length}`);
});

await test('snapshot build stays under 50 ms and 12 KB (S6)', async () => {
  const { buildAdvisorSnapshot } = await import('../host/snapshot.js');
  const project = store.getProject('prj-scale');
  const started = nowMs();
  const snapshot = buildAdvisorSnapshot(store, project, null, {});
  const elapsed = nowMs() - started;
  const payload = JSON.stringify(snapshot);
  const kb = payload.length / 1024;
  assert.ok(elapsed < 50, `snapshot ${elapsed.toFixed(1)} ms < 50 ms`);
  assert.ok(kb < 12, `snapshot ${kb.toFixed(1)} KB < 12 KB`);
  console.log(`     snapshot ${kb.toFixed(1)} KB in ${elapsed.toFixed(1)} ms`);
});

await test('status facts at 5k do not depend on the node count (bounded output)', () => {
  const nodes = store.listNodes('prj-scale');
  const facts = buildStatusFacts({ project: store.getProject('prj-scale'), nodes, now: 10_000 });
  const bytes = Buffer.byteLength(JSON.stringify(facts), 'utf8');
  assert.ok(facts.nextToStart.length <= 5);
  assert.ok(facts.recentFailures.length <= 5);
  assert.ok(bytes < 16 * 1024, `facts ${bytes} B < 16 KB`);
  console.log(`     facts ${bytes} B, next=${facts.nextToStart.length}`);
});

let failed = 0;
for (const result of results) {
  if (result.ok) console.log(`ok   ${result.name}`);
  else { failed += 1; console.log(`FAIL ${result.name}\n     ${result.error?.stack ?? result.error}`); }
}
console.log(`\n${results.length - failed}/${results.length} scale checks passed`);
process.exit(failed === 0 ? 0 : 1);
