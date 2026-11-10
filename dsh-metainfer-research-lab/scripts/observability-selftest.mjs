/**
 * Self-test for the observability + status surfaces:
 *   - Host-computed status facts (running/next/failures, why nothing starts);
 *   - metrics (queue depth, cycle latency, per-role failure rate, dispatch latency);
 *   - explain_node / trace_explain over real kernel events;
 *   - actionable error codes.
 *
 * Run: `node scripts/observability-selftest.mjs`
 */
import assert from 'node:assert/strict';
import { openStore } from '../host/store.js';
import { createExecutor } from '../host/kernel/executor.js';
import { createProjection } from '../host/kernel/projection.js';
import { createEventBus } from '../host/kernel/bus.js';
import { buildStatusFacts, whyNotStarting } from '../host/observability/status.js';
import { computeProjectMetrics, createMetricsCollector, percentile, roleMetrics, summarizeDurations } from '../host/observability/metrics.js';
import { createExplainer } from '../host/observability/explain.js';
import { createKernel } from '../host/kernel/instance.js';
import { createLabService } from '../host/lab-service.js';
import { createLocalPoolBroker } from '../host/dispatch/brokers.js';
import { createDispatchOnce } from '../host/dispatch/dispatch-once.js';
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

async function setup() {
  const store = await openStore(storeContext(memoryDomain()));
  let now = 10_000;
  const clock = () => now;
  const projection = createProjection({ store, strict: true, clock });
  const executor = createExecutor({ store, clock, projection, bus: createEventBus() });
  await store.saveProject({ id: 'p', revision: 0, counters: { eventSeq: 0 }, config: { maxRunningNodes: 2, resourcePools: { gpu: 2 }, maxNodes: 100 }, updatedAt: 0 });
  projection.load('p');
  return { store, projection, executor, advance: (ms) => { now += ms; }, clock };
}

await test('status facts: running, next to start with a reason, recent failure with a cause', async () => {
  const { executor, store, projection } = await setup();
  await executor.commit('p', {
    actor: human, causeId: 'cause-root',
    mutations: [
      { op: 'node.create', node: { id: 'n1', title: 'root', status: 'planned', needs: { gpu: 1 }, timeboxMs: 60_000, priority: { class: 'p2' }, timestamps: { createdAt: 1 } } },
      { op: 'node.create', node: { id: 'n2', title: 'next', status: 'planned', needs: { gpu: 1 }, timeboxMs: 60_000, priority: { class: 'p0' }, timestamps: { createdAt: 2 } } },
      { op: 'node.create', node: { id: 'n3', title: 'broken', status: 'planned', needs: { gpu: 1 }, timeboxMs: 60_000, priority: { class: 'p1' }, timestamps: { createdAt: 3 } } },
    ],
  });
  await executor.commit('p', { actor: human, causeId: 'cause-start', mutations: [{ op: 'node.transition', nodeId: 'n1', to: 'running', set: { timestamps: { startedAt: 9_000, lastActivityAt: 9_500 } } }] });
  await executor.commit('p', { actor: human, causeId: 'cause-fail', mutations: [{ op: 'node.transition', nodeId: 'n3', to: 'failed', set: { error: 'timeout after 10min', errorCode: 'timeout' } }] });
  const nodes = projection.listNodes('p');
  const facts = buildStatusFacts({ project: store.getProject('p'), nodes, now: 12_000, auto: { status: 'running', cycles: 3 } });
  assert.equal(facts.counts.total, 3);
  assert.equal(facts.running.length, 1);
  assert.equal(facts.running[0].elapsedMs, 3_000);
  assert.equal(facts.running[0].lastActivityMs, 2_500);
  assert.equal(facts.nextToStart[0].nodeId, 'n2', 'p0 before p1/p2');
  assert.equal(facts.nextToStart[0].why.code, 'ready');
  assert.deepEqual(facts.queueRows.map((row) => row.nodeId), facts.queueOrder, 'queueRows and queueOrder share one ordering');
  assert.equal(facts.queueRows[0].why.code, 'ready', 'every queue row carries a why');
  assert.equal(facts.recentFailures[0].nodeId, 'n3');
  assert.equal(facts.recentFailures[0].errorCode, 'timeout');
  assert.equal(facts.recentFailures[0].causeId, 'cause-fail');
  assert.match(facts.recentFailures[0].nextStep, /retry|trace/);
  assert.equal(facts.driver.status, 'running');
});

await test('status explains a full capacity instead of silently queueing', async () => {
  const { executor, projection, store } = await setup();
  await executor.commit('p', {
    actor: human,
    mutations: [
      { op: 'node.create', node: { id: 'r1', title: 'r1', status: 'running', needs: { gpu: 1 }, resourcesHeld: { gpu: 1 }, timeboxMs: 60_000, timestamps: { startedAt: 1 } } },
      { op: 'node.create', node: { id: 'r2', title: 'r2', status: 'running', needs: { gpu: 1 }, resourcesHeld: { gpu: 1 }, timeboxMs: 60_000, timestamps: { startedAt: 1 } } },
      { op: 'node.create', node: { id: 'q1', title: 'queued', status: 'planned', needs: { gpu: 1 }, timeboxMs: 60_000 } },
    ],
  });
  const facts = buildStatusFacts({ project: store.getProject('p'), nodes: projection.listNodes('p'), now: 2_000 });
  assert.equal(facts.nextToStart[0].why.code, 'max_running');
  assert.match(facts.nextToStart[0].why.message, /maxRunningNodes/);
  const node = projection.getNode('p', 'q1');
  assert.equal(whyNotStarting(node, { capacity: { runningCount: 2, free: { gpu: 0 }, canStart: false }, project: { config: { maxRunningNodes: 2 } }, now: 2_000 }).code, 'max_running');
});

await test('describe metrics: queue depth, cycle latency, per-role failure rate', () => {
  const nodes = [
    { status: 'running' }, { status: 'planned' }, { status: 'planned', deferUntil: 400_000 }, { status: 'failed' }, { status: 'completed' },
  ];
  const runs = [
    { role: 'advisor', status: 'completed', startedAt: 0, endedAt: 120_000, inputBytes: 8_000, usage: { totalTokens: 3_000 } },
    { role: 'advisor', status: 'failed', startedAt: 200_000, endedAt: 260_000, inputBytes: 8_100 },
    { role: 'scheduler', status: 'completed', startedAt: 0, endedAt: 18_000, inputBytes: 4_000 },
  ];
  const cycles = [{ startedAt: 0, endedAt: 140_000 }, { startedAt: 200_000, endedAt: 280_000 }];
  const live = { dispatch: { count: 2, avg: 12, p95: 18, max: 18, avgMs: 12, p95Ms: 18, maxMs: 18, started: 3, skipped: 1, skipReasons: { queued: 1 }, lastAt: 1 }, snapshotBytes: { count: 1, last: 9_000, max: 9_000, maxMs: 9_000 } };
  const metrics = computeProjectMetrics({ project: { id: 'p', revision: 9 }, nodes, runs, cycles, live, now: 300_000, auto: { status: 'running', pauseCounts: { noProgress: 2 } } });
  assert.equal(metrics.counts.total, 5);
  assert.equal(metrics.queue.depth, 1, 'a scheduled defer is not runnable');
  assert.equal(metrics.queue.deferred, 1);
  assert.equal(metrics.cycle.count, 2);
  assert.equal(metrics.cycle.avgMs, 110_000);
  assert.equal(metrics.byRole.advisor.runs, 2);
  assert.equal(metrics.byRole.advisor.failRate, 0.5);
  assert.equal(metrics.byRole.advisor.inputBytes.max, 8_100);
  assert.equal(metrics.advisor.inputBytes.last, 9_000);
  assert.equal(metrics.advisor.inputBytes.p50Utilization, Number((8_000 / 12_288).toFixed(3)));
  assert.equal(metrics.dispatch.p95Ms, 18);
  assert.equal(metrics.stalls.noProgress, 2);
});

await test('O4/O5: queue/counts use the single runnable definition', () => {
  const nodes = [
    { id: 'r', status: 'running' },
    { id: 'p', status: 'planned', priority: { class: 'p2' }, timeboxMs: 60_000 },
    { id: 'd', status: 'planned', priority: { class: 'deferred' } },
    { id: 'c', status: 'planned', priority: { class: 'p1' }, claim: { status: 'claimed' } },
    { id: 'h', status: 'planned', priority: { class: 'p1' }, dispatchHold: { untilMs: 500_000 } },
    { id: 's', status: 'completed' },
    { id: 'sched', status: 'planned', priority: { class: 'p2' }, deferUntil: 500_000, timeboxMs: 60_000 },
    { id: 'arch', status: 'planned', priority: { class: 'deferred' }, archivedAt: 1, timeboxMs: 60_000 },
  ];
  const metrics = computeProjectMetrics({ project: { id: 'p' }, nodes, archived: 1, now: 300_000 });
  assert.equal(metrics.queue.depth, 1);
  assert.equal(metrics.queue.runnable, 1);
  assert.equal(metrics.queue.planned, 1);
  assert.equal(metrics.queue.claimed, 1);
  assert.equal(metrics.queue.held, 1);
  assert.equal(metrics.queue.deferred, 2, 'deferred class + scheduled deferUntil, no double count');
  assert.equal(metrics.queue.remainingMs, 60_000, 'runnable timebox sum');
  assert.equal(metrics.counts.planned, 1, 'planned count must exclude deferred');
  assert.equal(metrics.counts.deferred, 2);
  assert.equal(metrics.counts.archived, 1);
  assert.equal(metrics.counts.total, 8, 'hot nodes + archived audit count');
});

await test('O1/A11: cycle and per-role latency expose p50/p90, not only p95', () => {
  const runs = [
    { role: 'worker', status: 'completed', startedAt: 0, endedAt: 100, inputBytes: 100, usage: { totalTokens: 10 } },
    { role: 'worker', status: 'completed', startedAt: 100, endedAt: 300, inputBytes: 200, usage: { totalTokens: 20 } },
    { role: 'worker', status: 'failed', startedAt: 300, endedAt: 600, inputBytes: 300, usage: { totalTokens: 30 } },
  ];
  const metrics = computeProjectMetrics({ project: { id: 'p' }, runs, cycles: [{ startedAt: 0, endedAt: 100 }, { startedAt: 100, endedAt: 600 }, { startedAt: 600, endedAt: 1_100 }] });
  assert.equal(metrics.byRole.worker.duration.p50, 200);
  assert.equal(metrics.byRole.worker.duration.p90, 300);
  assert.equal(metrics.byRole.worker.failRate, Number((1 / 3).toFixed(3)));
  assert.equal(metrics.cycle.p50, 500);
  assert.equal(metrics.cycle.p90, 500);
  assert.equal(metrics.cycle, metrics.cycles, 'the compatibility alias is the same object');
  assert.equal(metrics.byRole, metrics.roles, 'the compatibility alias is the same object');
});

await test('O2: advisor input exposes byte/token percentiles and the byte guard', () => {
  const runs = [
    { role: 'advisor', status: 'completed', startedAt: 0, endedAt: 1, inputBytes: 1_000, usage: { totalTokens: 100 } },
    { role: 'advisor', status: 'completed', startedAt: 1, endedAt: 2, inputBytes: 2_000, usage: { totalTokens: 200 } },
    { role: 'advisor', status: 'completed', startedAt: 2, endedAt: 3, inputBytes: 3_000, usage: { totalTokens: 300 } },
  ];
  const metrics = computeProjectMetrics({ project: { id: 'p', config: { auto: { maxTokens: 10_000 } } }, runs });
  assert.equal(metrics.advisor.inputBytes.p50, 2_000);
  assert.equal(metrics.advisor.inputBytes.p90, 3_000);
  assert.equal(metrics.advisor.tokens.p50, 200);
  assert.equal(metrics.advisor.tokens.p90, 300);
  assert.equal(metrics.advisor.inputBytes.p90Utilization, Number((3_000 / 12_288).toFixed(3)));
  assert.equal(metrics.advisor.budgetBytes, 12_288);
  assert.deepEqual(metrics.advisor.tokenGuard, { maxTokens: 10_000, used: 0, remaining: 10_000 });
  assert.equal(metrics.advisorInput.utilization, metrics.advisor.inputBytes.p50Utilization);
  assert.equal(metrics.advisor, metrics.advisorInput, 'advisor and advisorInput are the same object');
  assert.equal(metrics.advisorInput.utilization, Number((2_000 / 12_288).toFixed(3)));
  assert.notEqual(metrics.advisorInput.utilization, null);
});

await test('metrics collector is bounded and aggregation is deterministic', () => {
  const collector = createMetricsCollector({ clock: () => 5, ring: 3 });
  for (let index = 0; index < 5; index += 1) collector.recordDispatch('p', { durationMs: index, started: 1, skipped: [{ status: 'queued' }] });
  collector.recordSnapshot('p', 900);
  const snap = collector.snapshot('p');
  assert.equal(snap.dispatch.count, 3, 'ring is bounded');
  assert.equal(snap.dispatch.started, 5);
  assert.equal(snap.dispatch.skipReasons.queued, 5);
  assert.equal(snap.snapshotBytes.last, 900);
  assert.equal(percentile([1, 2, 3, 4, 100], 95), 100);
  assert.equal(percentile([], 50), null);
  assert.deepEqual(summarizeDurations([]).count, 0);
  assert.equal(roleMetrics([{ role: 'gc' }]).gc.failRate, 0);
});

await test('explain_node returns the cause chain and structured events', async () => {
  const { executor, store, projection } = await setup();
  await executor.commit('p', {
    actor: human, causeId: 'cause-root',
    mutations: [{ op: 'node.create', node: { id: 'n1', title: 'root', status: 'planned', timeboxMs: 60_000, needs: {}, priority: { class: 'p2' } } }],
  });
  await executor.commit('p', { actor: human, causeId: 'cause-start', mutations: [{ op: 'node.transition', nodeId: 'n1', to: 'running' }] });
  const explainer = createExplainer({ store, projection, clock: () => 77 });
  const explained = explainer.explainNode('p', 'n1');
  assert.equal(explained.ok, true);
  assert.equal(explained.node.status, 'running');
  assert.ok(explained.events.some((event) => event.type === 'node/created'));
  assert.ok(explained.events.some((event) => event.type === 'node/started' && event.detail.includes('planned->running')));
  assert.ok(explained.events.every((event) => typeof event.type === 'string' && !('data' in event)));
  assert.equal(explained.generatedAt, 77);
  const missing = explainer.explainNode('p', 'nope');
  assert.equal(missing.code, 'node_not_found');
  assert.match(missing.nextStep, /dag_query|status_facts/);
});

await test('trace_explain walks proposal to outcome, and reports missing runs honestly', async () => {
  const { executor, store, projection } = await setup();
  await executor.commit('p', {
    actor: human,
    mutations: [{ op: 'node.create', node: { id: 'n1', title: 'root', status: 'planned', timeboxMs: 60_000, needs: {}, createdBy: 'advisor' } }],
  });
  await executor.commit('p', { actor: human, mutations: [{ op: 'node.transition', nodeId: 'n1', to: 'running' }] });
  await executor.commit('p', { actor: human, mutations: [{ op: 'node.transition', nodeId: 'n1', to: 'failed', set: { error: 'OOM' } }] });
  const explainer = createExplainer({ store, projection });
  const trace = explainer.traceExplain('p', 'n1');
  assert.equal(trace.ok, true);
  assert.equal(trace.outcome, 'failed');
  const kinds = trace.phases.map((phase) => phase.kind);
  assert.ok(kinds.includes('proposal'));
  assert.ok(kinds.includes('start'));
  assert.ok(kinds.includes('outcome'));
  assert.deepEqual(trace._truncated.phases, null);
  assert.equal(trace.runs.length, 0);
});

await test('O3: production dispatchOnce records runnable->claimed queue wait', async () => {
  const store = await openStore(storeContext(memoryDomain()));
  const kernel = createKernel({ store });
  const projectId = 'prod-o3';
  const now = Date.now();
  await store.saveProject({
    id: projectId, revision: 0, counters: { eventSeq: 0 }, updatedAt: 0,
    config: { maxRunningNodes: 1, resourcePools: { gpu: 1 }, maxNodes: 10 },
  });
  kernel.load(projectId);
  const executor = kernel.executor;
  const projection = kernel.projection;
  await executor.commit(projectId, {
    actor: human,
    mutations: [{ op: 'node.create', node: {
      id: 'held', title: 'held then released', status: 'planned', needs: { gpu: 1 },
      timeboxMs: 600_000, priority: { class: 'p2' },
      timestamps: { createdAt: now - 3_600_000 },
      dispatchHold: { untilMs: now - 1 },
    } }],
  });
  const local = createLocalPoolBroker({ limits: () => ({ maxRunningNodes: 1, resourcePools: { gpu: 1 } }) });
  const brokers = new Map([['local-pool', local], ['cluster', local]]);
  const dispatcher = createDispatchOnce({
    projectId, executor, projection, brokers,
    launcher: {
      async start(id, nodeId, { lease }) {
        await executor.commit(id, {
          actor: { kind: 'system', id: 'runtime' },
          mutations: [{ op: 'node.transition', nodeId, to: 'running', set: { lease: { leaseId: lease.leaseId, broker: lease.broker } } }],
        });
      },
    },
  });
  const service = createLabService({
    ctx: { effect: () => {}, logger: { info() {}, warn() {} } },
    store, kernel, git: null, runtime: null, transcript: null, orchestrator: null,
    auto: null, cluster: null, clusterAdmin: null,
    dispatchOnce: (id, options = {}) => dispatcher.run({
      ...options,
      config: store.getProject(id)?.config,
      maxRunningNodes: store.getProject(id)?.config?.maxRunningNodes ?? Infinity,
    }),
  });
  const round = await service.dispatchOnce(projectId, { includeStatus: false, maxStarts: 1 });
  assert.deepEqual(round.startedNodeIds, ['held']);
  const metrics = await service.metricsFor(projectId);
  assert.equal(metrics.dispatch.queueWait.count, 1, 'production dispatchOnce must feed the queue-wait ring');
  // The hold expired one millisecond before dispatch: wait starts at release,
  // not at createdAt, so a 1h-old node has a near-zero queue wait.
  assert.ok(metrics.dispatch.queueWait.p50 < 5_000, `wait ${metrics.dispatch.queueWait.p50}`);
  assert.equal(metrics.dispatch.decisions.at(-1)?.nodeId, 'held');
  assert.equal(metrics.dispatch.decisions.at(-1)?.status, 'started');
  assert.ok(metrics.dispatch.decisions.at(-1)?.waitMs >= 0 && metrics.dispatch.decisions.at(-1)?.waitMs < 5_000);
});

let failed = 0;
for (const result of results) {
  if (result.ok) console.log(`ok   ${result.name}`);
  else {
    failed += 1;
    console.log(`FAIL ${result.name}\n     ${result.error?.stack ?? result.error}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} observability checks passed`);
process.exit(failed === 0 ? 0 : 1);
