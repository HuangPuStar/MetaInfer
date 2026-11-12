/** Offline report/auto regressions: in-memory records and mocked roles only.
 * Run: node dsh-metainfer-research-lab/scripts/auto-progress-selftest.mjs
 * No model, subprocess, Git, SSH, cluster allocation, or real project store is used.
 */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import * as snapshot from '../host/snapshot.js';
import { createAutoController } from '../host/auto.js';
import { createGcRunner } from '../host/gc.js';
import { LabError } from '../host/git-engine.js';

// Optional SDK is intentionally unavailable to these isolated tests, even if installed.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@openai/codex-sdk') {
      const source = 'export class Codex { constructor() { throw new Error("real execution forbidden in selftest"); } }';
      return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
    }
    if (specifier === 'zod') {
      return { url: 'data:text/javascript,export const z = { any: () => ({}) };', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { createOrchestrator } = await import('../host/orchestrator.js');
process.env.MIRL_ACTIVE_SKILLS_FILE = new URL('./__missing_selftest_skills__.json', import.meta.url).pathname;

const copy = (value) => structuredClone(value);
function memoryStore(nodes = [], config = {}) {
  let project = {
    id: 'prj-mock', name: 'Offline fixture', brief: 'Mock evidence only', mode: 'manual', revision: 1,
    repo: { path: '/mock/repo', worktreeRoot: '/mock/worktrees' }, controllerSessionId: 'session-controller',
    counters: { nextNodeSeq: 2, nodes: nodes.length, cycles: 0, eventSeq: 0 },
    config: { maxNodes: 60, maxRunningNodes: 4, nodeTimeoutMinutes: 10, resourcePools: { gpu: 1 }, advisor: {}, auto: {}, ...copy(config) },
  };
  const records = new Map(nodes.map((node) => [node.id, copy(node)]));
  const runs = new Map();
  const cycles = new Map();
  const events = [];
  let lock = Promise.resolve();
  let writes = 0;
  return {
    get writes() { return writes; },
    events,
    getProject: () => copy(project),
    listProjects: () => [copy(project)],
    saveProject: async (value) => { writes += 1; project = copy(value); },
    getNode: (_projectId, nodeId) => records.has(nodeId) ? copy(records.get(nodeId)) : undefined,
    // Production lists clone record shells, not nested report objects.
    listNodes: () => [...records.values()].map((node) => ({ ...node })),
    saveNode: async (_projectId, node) => { writes += 1; records.set(node.id, copy(node)); },
    saveRun: async (_projectId, run) => { writes += 1; runs.set(run.id, copy(run)); },
    getRun: (_projectId, id) => copy(runs.get(id)),
    listRuns: () => [...runs.values()].map(copy),
    saveCycle: async (_projectId, cycle) => { writes += 1; cycles.set(cycle.id, copy(cycle)); },
    listCycles: () => [...cycles.values()].map(copy),
    appendEvent: async (_project, type, payload) => { writes += 1; events.push({ type, ...copy(payload) }); },
    withProjectLock(_projectId, fn) {
      const work = lock.then(fn);
      lock = work.catch(() => {});
      return work;
    },
  };
}
function completed(patch = {}) {
  return {
    id: 'n-0001', projectId: 'prj-mock', title: 'Fixture', prompt: 'Mock experiment prompt',
    status: 'completed', git: { headCommit: 'head-a' }, needs: {},
    report: { summary: 'A: initial structured report', success: true, metrics: [{ name: 'old', value: 1 }], next: [] },
    reportText: 'A: initial text', timestamps: { createdAt: 1, completedAt: 100 }, ...copy(patch),
  };
}
function legacyFollowUp() {
  return completed({
    reportText: 'B: follow-up says evidence is below the quality threshold',
    followUps: [{ at: 200, user: 'Review again', assistant: 'B: follow-up says evidence is below the quality threshold', headCommit: 'head-a' }],
    timestamps: { createdAt: 1, completedAt: 201 },
  });
}
const emptyStep = (patch = {}) => ({ created: [], started: [], errors: [], skipped: [], ...patch });
const drain = () => new Promise((resolve) => setImmediate(resolve));
async function autoFixture({ nodes = [completed()], config, step = async () => emptyStep(), cluster, setup } = {}) {
  const store = memoryStore(nodes, config);
  if (setup) await setup(store);
  let calls = 0;
  let cancellations = 0;
  const auto = createAutoController({ store, cluster, orchestrator: {
    step: async (...args) => { calls += 1; return step(store, ...args); },
    cancelProjectRuns: async () => { cancellations += 1; },
  } });
  await auto.start('prj-mock');
  await drain();
  return { store, auto, calls: () => calls, cancellations: () => cancellations };
}

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(['PASS', name]); }
  catch (error) { results.push(['FAIL', name, error.stack ?? String(error)]); }
}

await test('legacy same-head follow-up B hides structured A without inventing success/metrics', () => {
  const store = memoryStore([legacyFollowUp()]);
  const before = store.listNodes();
  const view = snapshot.buildAdvisorSnapshot(store, store.getProject());
  assert.equal(view.candidateParents[0].report.summary, before[0].reportText);
  assert.equal(view.candidateParents[0].report.success, undefined);
  assert.equal(view.candidateParents[0].report.metrics, undefined);
  assert.deepEqual(store.listNodes(), before);
  assert.equal(store.writes, 0);
});

await test('step errors count as errors, never idle/noProgress', async () => {
  const { auto } = await autoFixture({
    config: { auto: { idleCycleLimit: 3 } },
    step: async () => emptyStep({ errors: ['advisor: run exceeded 180s'] }),
  });
  try {
    await auto.tick();
    await auto.tick();
    const state = auto.statusOf('prj-mock');
    assert.equal(state.pauseReason, 'errors');
    assert.equal(state.errorStreak, 3);
    assert.equal(state.idleStreak, 0);
  } finally { auto.dispose(); }
});


function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
const advisorOutput = (patch = {}) => ({ analysis: 'Offline fixture review', proposals: [], needUserDecision: false, ...patch });
const proposal = (title = 'Offline next') => ({ parentId: 'n-0001', title, prompt: title + ': run an isolated follow-up experiment', rationale: 'Mock rationale', needs: [] });
function orchestratorFixture({ nodes = [completed()], config, onRole = () => advisorOutput() } = {}) {
  const store = memoryStore(nodes, config);
  const requests = [];
  const ctx = {
    agents: { get: () => ({ id: 'session-controller' }) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock' }) },
    sessionQuery: { readSurface: async () => ({ events: [] }) },
    subagents: { startActivation: async (request) => {
      requests.push(request);
      const output = onRole(request, requests.length);
      return { result: Promise.resolve(output).then((structured) => ({ stopReason: 'completed', structured, output: [] })), dispose: async () => {} };
    } },
  };
  const orchestrator = createOrchestrator({ ctx, store,
    git: { commitWorktree: async (_project, parent) => ({ head: parent.git.headCommit }), tagCommit: async () => {} },
    runtime: { start: async (_projectId, nodeId) => {
      const node = store.getNode('prj-mock', nodeId);
      node.status = 'running';
      await store.saveNode('prj-mock', node);
    } },
  });
  return { store, orchestrator, requests };
}

await test('report selection respects source markers, head/text matches and newer activation/merge evidence', () => {
  const legacy = legacyFollowUp();
  assert.equal(snapshot.nodeReportView(legacy).report, null);
  const mismatchText = { ...copy(legacy), reportText: 'C: new activation text' };
  const mismatchHead = { ...copy(legacy), git: { headCommit: 'head-c' } };
  const restarted = { ...copy(legacy), timestamps: { startedAt: 300 } };
  const attempted = { ...copy(legacy), attempts: [{ startedAt: 250, endedAt: 350 }] };
  const merged = { ...copy(legacy), merge: { committedAt: 300 } };
  for (const node of [mismatchText, mismatchHead, restarted, attempted, merged,
    { ...copy(legacy), reportSource: 'activation', reportUpdatedAt: 300 },
    { ...copy(legacy), reportSource: 'merge', reportUpdatedAt: 300 }]) {
    assert.equal(snapshot.nodeReportView(node).report.summary, legacy.report.summary);
  }
  assert.equal(snapshot.nodeReportView({ ...completed(), reportSource: 'followUp' }).report, null);
  assert.deepEqual(snapshot.nodeReportView({ reportText: 'plain only' }), { report: null, reportText: 'plain only' });
});

await test('report version ignores historical structured A and is stable for raw/projected nodes', () => {
  const node = legacyFollowUp();
  const version = snapshot.reportVersion(node);
  assert.equal(snapshot.reportVersion({ ...node, ...snapshot.nodeReportView(node) }), version);
  assert.equal(snapshot.reportVersion({ ...copy(node), report: { summary: 'ignored old A changed', success: false } }), version);
  const changed = copy(node);
  changed.reportText = 'C: newer same-head evidence';
  changed.followUps.push({ at: 300, headCommit: 'head-a', assistant: changed.reportText });
  assert.notEqual(snapshot.reportVersion(changed), version);
  const marked = { ...copy(node), reportSource: 'followUp', reportUpdatedAt: 200 };
  assert.notEqual(snapshot.reportVersion(marked), snapshot.reportVersion({ ...marked, reportUpdatedAt: 300 }));
  assert.equal(snapshot.reportVersion(marked), snapshot.reportVersion({ ...marked, ...snapshot.nodeReportView(marked) }));
});

await test('same-head new follow-up is actionable once despite old head-only review', async () => {
  const initial = completed();
  const updated = legacyFollowUp();
  updated.review = { reviewedHeadCommit: initial.git.headCommit, reviewedReportVersion: snapshot.reportVersion(initial) };
  const fixture = await autoFixture({ nodes: [updated], step: async (store) => {
    const node = store.getNode('prj-mock', 'n-0001');
    node.review = { reviewedHeadCommit: node.git.headCommit, reviewedReportVersion: snapshot.reportVersion(node) };
    await store.saveNode('prj-mock', node);
    return emptyStep();
  } });
  try {
    assert.equal(fixture.calls(), 1);
    await fixture.auto.tick();
    assert.equal(fixture.calls(), 1);
    assert.equal(fixture.auto.statusOf('prj-mock').pauseReason, 'idle');
  } finally { fixture.auto.dispose(); }
});

await test('running worker and advisor declaring no successor are not noProgress or user-decision pause', async () => {
  const fixture = await autoFixture({ nodes: [completed(), completed({ id: 'n-worker', status: 'running' })], step: async () => emptyStep({ needUserDecision: true }) });
  try {
    await fixture.auto.tick();
    await fixture.auto.tick();
    assert.equal(fixture.calls(), 3);
    assert.equal(fixture.auto.statusOf('prj-mock').status, 'running');
    assert.equal(fixture.auto.statusOf('prj-mock').idleStreak, 0);
    await fixture.auto.stop('prj-mock');
    assert.equal(fixture.store.getNode('prj-mock', 'n-worker').status, 'running');
    assert.equal(fixture.cancellations(), 1);
  } finally { fixture.auto.dispose(); }
});

await test('running-only worker and pending expert role do not consume idle/cycle budget', async () => {
  for (const pending of [false, true]) {
    const fixture = await autoFixture({ nodes: pending ? [completed()] : [completed({ status: 'running' })],
      setup: pending ? (store) => store.saveRun('prj-mock', { id: 'run-pending', role: 'advisor', status: 'running' }) : undefined });
    try {
      await fixture.auto.tick();
      assert.equal(fixture.calls(), 0);
      assert.equal(fixture.auto.statusOf('prj-mock').idleStreak, 0);
      assert.equal(fixture.auto.statusOf('prj-mock').cycles, 0);
    } finally { fixture.auto.dispose(); }
  }
});

await test('deferred auto role stays busy, never consumes idle or duplicate cycles', async () => {
  const gate = deferred();
  const fixture = await autoFixture({ step: async () => gate.promise });
  try {
    await fixture.auto.tick();
    await fixture.auto.tick();
    assert.equal(fixture.calls(), 1);
    assert.equal(fixture.auto.statusOf('prj-mock').cycles, 0);
    assert.equal(fixture.auto.statusOf('prj-mock').idleStreak, 0);
  } finally {
    gate.resolve(emptyStep());
    await drain();
    fixture.auto.dispose();
  }
});

await test('queued resource wait does not burn cycles and rechecks when capacity returns', async () => {
  let free = 0;
  const cluster = { enabled: true, getStatus: () => ({ pools: { gpu: { free } } }) };
  const fixture = await autoFixture({ nodes: [completed({ status: 'planned', needs: { gpu: 1 }, resourceWait: { state: 'pending' } })], cluster,
    step: async (store) => {
      const node = store.getNode('prj-mock', 'n-0001');
      node.status = 'running';
      await store.saveNode('prj-mock', node);
      return emptyStep({ started: [node.id] });
    } });
  try {
    await fixture.auto.tick();
    assert.equal(fixture.calls(), 0);
    assert.equal(fixture.auto.statusOf('prj-mock').pauseReason, 'resourcesQueued');
    assert.equal(fixture.auto.statusOf('prj-mock').idleStreak, 0);
    free = 1;
    const node = fixture.store.getNode('prj-mock', 'n-0001');
    delete node.resourceWait;
    await fixture.store.saveNode('prj-mock', node);
    await fixture.auto.tick();
    assert.equal(fixture.calls(), 1);
    assert.equal(fixture.auto.statusOf('prj-mock').status, 'running');
  } finally { fixture.auto.dispose(); }
});

await test('blocked GPU request does not prevent independent CPU work', async () => {
  const fixture = await autoFixture({ nodes: [
    completed({ status: 'planned', needs: { gpu: 1 }, resourceWait: { state: 'pending' } }),
    completed({ id: 'n-cpu', status: 'planned', needs: {} }),
  ], cluster: { enabled: true, getStatus: () => ({ pools: { gpu: { free: 0 } } }) }, step: async () => emptyStep({ started: ['n-cpu'] }) });
  try { assert.equal(fixture.calls(), 1); } finally { fixture.auto.dispose(); }
});

await test('confirmation proposals remain waiting, neither idle nor noProgress', async () => {
  const fixture = await autoFixture({ nodes: [completed({ status: 'proposed', parentId: 'n-parent' })] });
  try {
    await fixture.auto.tick();
    assert.equal(fixture.calls(), 0);
    assert.equal(fixture.auto.statusOf('prj-mock').pauseReason, 'awaitingConfirmation');
    assert.equal(fixture.auto.statusOf('prj-mock').idleStreak, 0);
  } finally { fixture.auto.dispose(); }
});

await test('true empty cycles still trip noProgress; empty graph remains idle', async () => {
  const fixture = await autoFixture();
  try {
    await fixture.auto.tick();
    await fixture.auto.tick();
    assert.equal(fixture.auto.statusOf('prj-mock').pauseReason, 'noProgress');
    assert.equal(fixture.auto.statusOf('prj-mock').idleStreak, 3);
  } finally { fixture.auto.dispose(); }
  const idle = await autoFixture({ nodes: [] });
  try {
    assert.equal(idle.auto.statusOf('prj-mock').pauseReason, 'idle');
    assert.equal(idle.calls(), 0);
  } finally { idle.auto.dispose(); }
});

await test('explicit zero-output decision pauses without cancelling workers', async () => {
  const fixture = await autoFixture({ step: async () => emptyStep({ needUserDecision: true }) });
  try {
    assert.equal(fixture.auto.statusOf('prj-mock').pauseReason, 'needsUserDecision');
    assert.equal(fixture.auto.statusOf('prj-mock').idleStreak, 0);
    assert.equal(fixture.cancellations(), 0);
  } finally { fixture.auto.dispose(); }
});

await test('thrown errors trip errors, while cycle_busy is pending work', async () => {
  for (const busy of [false, true]) {
    const fixture = await autoFixture({ step: async () => {
      if (busy) throw new LabError('cycle_busy', 'a cycle is already running for this project', 409);
      throw new Error('mock role transport failure');
    } });
    try {
      await fixture.auto.tick();
      await fixture.auto.tick();
      assert.equal(fixture.auto.statusOf('prj-mock').idleStreak, 0);
      assert.equal(fixture.auto.statusOf('prj-mock').errorStreak, busy ? 0 : 3);
      assert.equal(fixture.auto.statusOf('prj-mock').pauseReason, busy ? null : 'errors');
    } finally { fixture.auto.dispose(); }
  }
});

await test('resume clears streaks but never total cycle/wall budgets, including stop/start', async () => {
  const fixture = await autoFixture({ config: { auto: { maxCycles: 3 } }, step: async () => emptyStep({ errors: ['mock error'] }) });
  try {
    await fixture.auto.tick();
    await fixture.auto.tick();
    const before = fixture.auto.statusOf('prj-mock');
    assert.equal(before.cycles, 3);
    await fixture.auto.resume('prj-mock');
    assert.equal(fixture.auto.statusOf('prj-mock').errorStreak, 0);
    assert.equal(fixture.auto.statusOf('prj-mock').idleStreak, 0);
    await fixture.auto.tick();
    assert.equal(fixture.auto.statusOf('prj-mock').pauseReason, 'maxCycles');
    assert.equal(fixture.calls(), 3);
    assert.equal(fixture.auto.statusOf('prj-mock').startedAt, before.startedAt);
    await fixture.auto.stop('prj-mock');
    await fixture.auto.start('prj-mock');
    await drain();
    assert.equal(fixture.calls(), 3);
    assert.equal(fixture.auto.statusOf('prj-mock').cycles, 3);
  } finally { fixture.auto.dispose(); }

  const realNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  const wall = await autoFixture({ nodes: [completed({ status: 'running' })], config: { auto: { maxWallClockMs: 100 } } });
  try {
    now += 101;
    await wall.auto.tick();
    assert.equal(wall.auto.statusOf('prj-mock').pauseReason, 'maxWallClock');
    await wall.auto.resume('prj-mock');
    await wall.auto.tick();
    assert.equal(wall.auto.statusOf('prj-mock').pauseReason, 'maxWallClock');
    assert.equal(wall.auto.statusOf('prj-mock').startedAt, 1_000);
  } finally { wall.auto.dispose(); Date.now = realNow; }
});

await test('token, cost and node budgets remain hard safety stops', async () => {
  for (const [config, node, reason] of [
    [{ auto: { maxTokens: 5 } }, completed({ usage: { totalTokens: 5 } }), 'maxTokens'],
    [{ auto: { maxCostUsd: 2 } }, completed({ costUsd: 2 }), 'maxCost'],
    [{ maxNodes: 1 }, completed(), 'maxNodes'],
  ]) {
    const fixture = await autoFixture({ nodes: [node], config });
    try {
      assert.equal(fixture.auto.statusOf('prj-mock').pauseReason, reason);
      await fixture.auto.resume('prj-mock');
      await fixture.auto.tick();
      assert.equal(fixture.auto.statusOf('prj-mock').pauseReason, reason);
      assert.equal(fixture.calls(), 0);
    } finally { fixture.auto.dispose(); }
  }
});

for (const propose of [false, true]) await test('stale in-flight advisor ' + (propose ? 'proposal' : 'none decision') + ' cannot review or branch newer same-head evidence/new leaves', async () => {
  const started = deferred();
  const gate = deferred();
  const fixture = orchestratorFixture({ config: { advisor: { acceptMode: 'confirm' } }, onRole: (request) => {
    started.resolve(request);
    return gate.promise;
  } });
  const work = fixture.orchestrator.step('prj-mock');
  await started.promise;
  try {
    const current = legacyFollowUp();
    await fixture.store.saveNode('prj-mock', current);
    await fixture.store.saveNode('prj-mock', completed({ id: 'n-late' }));
    gate.resolve(advisorOutput({ proposals: propose ? [proposal()] : [], needUserDecision: true }));
    const result = await work;
    assert.deepEqual(result.created, []);
    assert.equal(result.needUserDecision, false);
    assert.equal(fixture.store.getNode('prj-mock', 'n-0001').review, undefined);
    assert.equal(fixture.store.getNode('prj-mock', 'n-late').review, undefined);
    const run = fixture.store.listRuns().find((item) => item.role === 'advisor');
    assert.equal(run.inputSnapshot.candidateParents[0].report.summary, 'A: initial structured report');
    assert.equal(run.inputSnapshot.candidateParents.length, 1);
    if (propose) assert.equal(run.rejected.length, 1);
  } finally { gate.resolve(advisorOutput()); await work; fixture.orchestrator.dispose(); }
});

await test('deep-frozen advisor snapshot survives nested metric mutation while role is pending', async () => {
  const started = deferred();
  const gate = deferred();
  const fixture = orchestratorFixture({ onRole: (request) => { started.resolve(request); return gate.promise; } });
  const work = fixture.orchestrator.step('prj-mock');
  await started.promise;
  try {
    fixture.store.listNodes()[0].report.metrics[0].value = 999;
    gate.resolve(advisorOutput());
    await work;
    assert.equal(fixture.store.listRuns()[0].inputSnapshot.candidateParents[0].report.metrics[0].value, 1);
    assert.equal(fixture.store.getNode('prj-mock', 'n-0001').review, undefined);
  } finally { gate.resolve(advisorOutput()); await work; fixture.orchestrator.dispose(); }
});

await test('head change while advisor is pending rejects its proposal', async () => {
  const started = deferred();
  const gate = deferred();
  const fixture = orchestratorFixture({ onRole: () => { started.resolve(); return gate.promise; } });
  const work = fixture.orchestrator.step('prj-mock');
  await started.promise;
  try {
    const node = fixture.store.getNode('prj-mock', 'n-0001');
    node.git.headCommit = 'head-new';
    await fixture.store.saveNode('prj-mock', node);
    gate.resolve(advisorOutput({ proposals: [proposal()] }));
    assert.deepEqual((await work).created, []);
    assert.equal(fixture.store.getNode('prj-mock', 'n-0001').review, undefined);
  } finally { gate.resolve(advisorOutput()); await work; fixture.orchestrator.dispose(); }
});

await test('valid latest report is reviewed by its frozen head/version and decision flag is returned', async () => {
  const fixture = orchestratorFixture({ nodes: [legacyFollowUp()], onRole: () => advisorOutput({ needUserDecision: true }) });
  try {
    const result = await fixture.orchestrator.step('prj-mock');
    assert.equal(result.needUserDecision, true);
    const node = fixture.store.getNode('prj-mock', 'n-0001');
    const run = fixture.store.listRuns()[0];
    assert.equal(run.inputSnapshot.candidateParents[0].report.summary, node.reportText);
    assert.equal(run.inputSnapshot.candidateParents[0].report.success, undefined);
    assert.equal(node.review.reviewedHeadCommit, 'head-a');
    assert.equal(node.review.reviewedReportVersion, snapshot.reportVersion(node));
    assert.equal(node.review.decision, 'none');
  } finally { fixture.orchestrator.dispose(); }
});

await test('multiple reviewer panel retains two same-parent proposals and one frozen identity', async () => {
  const fixture = orchestratorFixture({ config: { advisor: { acceptMode: 'confirm', reviewers: [{ lens: 'quality' }, { lens: 'risk' }] } },
    onRole: (_request, index) => advisorOutput({ proposals: [proposal('Independent ' + index)] }) });
  try {
    const result = await fixture.orchestrator.step('prj-mock');
    assert.equal(result.created.length, 2);
    assert.equal(fixture.requests.length, 2);
    const runs = fixture.store.listRuns();
    assert.equal(runs.length, 2);
    assert.deepEqual(runs[0].inputSnapshot, runs[1].inputSnapshot);
    assert.equal(runs[0].panelSize, 2);
    assert.equal(fixture.store.getNode('prj-mock', 'n-0001').review.reviewedReportVersion, snapshot.reportVersion(completed()));
    assert.equal(fixture.store.listNodes().filter((node) => node.status === 'proposed').length, 2);
  } finally { fixture.orchestrator.dispose(); }
});

await test('GC postmortem reads latest selected evidence, not historical structured A', async () => {
  const store = memoryStore([legacyFollowUp()]);
  let prompt;
  const runner = createGcRunner({ store, orchestrator: { ensureController: async () => ({ id: 'mock-controller' }) },
    ctx: { subagents: { startActivation: async (request) => {
      prompt = request.request.prompt[0].text;
      return { result: Promise.resolve({ stopReason: 'completed', structured: { summary: 'mock GC' } }), dispose: async () => {} };
    } } } });
  try {
    assert.equal((await runner.run('prj-mock', 'n-0001', { reason: 'mock timeout' })).status, 'completed');
    assert.ok(prompt.includes('B: follow-up says evidence is below the quality threshold'));
    assert.ok(!prompt.includes('A: initial structured report'));
  } finally { runner.dispose(); }
});


await test('external resource admission clears stale waiting reason and breaks the idle streak', async () => {
  const fixture = await autoFixture();
  try {
    assert.equal(fixture.auto.statusOf('prj-mock').idleStreak, 1);
    const node = fixture.store.getNode('prj-mock', 'n-0001');
    node.status = 'planned';
    node.resourceWait = { state: 'pending' };
    await fixture.store.saveNode('prj-mock', node);
    await fixture.auto.tick();
    assert.equal(fixture.auto.statusOf('prj-mock').pauseReason, 'resourcesQueued');
    assert.equal(fixture.auto.statusOf('prj-mock').idleStreak, 0);
    node.status = 'running';
    delete node.resourceWait;
    await fixture.store.saveNode('prj-mock', node);
    await fixture.auto.tick();
    assert.equal(fixture.auto.statusOf('prj-mock').status, 'running');
    assert.equal(fixture.auto.statusOf('prj-mock').pauseReason, null);
    assert.equal(fixture.calls(), 1);
  } finally { fixture.auto.dispose(); }
});

await test('progress and pending proposals take precedence over an advisor decision flag', async () => {
  for (const kind of ['created', 'started', 'proposal']) {
    const fixture = await autoFixture({ step: async (store) => {
      if (kind === 'proposal') await store.saveNode('prj-mock', completed({ id: 'n-proposed', status: 'proposed', parentId: 'n-0001' }));
      return emptyStep({ needUserDecision: true, ...(kind === 'proposal' ? {} : { [kind]: ['n-new'] }) });
    } });
    try {
      assert.equal(fixture.auto.statusOf('prj-mock').status, kind === 'proposal' ? 'waiting' : 'running');
      assert.equal(fixture.auto.statusOf('prj-mock').pauseReason, kind === 'proposal' ? 'awaitingConfirmation' : null);
      assert.equal(fixture.auto.statusOf('prj-mock').idleStreak, 0);
    } finally { fixture.auto.dispose(); }
  }
});

await test('budget crossed inside a successful step pauses immediately without sending worker control', async () => {
  const fixture = await autoFixture({ config: { auto: { maxTokens: 5 } }, step: async (store) => {
    const node = store.getNode('prj-mock', 'n-0001');
    node.usage = { totalTokens: 5 };
    await store.saveNode('prj-mock', node);
    return emptyStep({ started: ['n-worker'] });
  } });
  try {
    assert.equal(fixture.auto.statusOf('prj-mock').pauseReason, 'maxTokens');
    assert.equal(fixture.cancellations(), 0);
  } finally { fixture.auto.dispose(); }
});

await test('an in-flight cycle finishing after stop never resumes auto or pauses it differently', async () => {
  const gate = deferred();
  const fixture = await autoFixture({ step: async () => gate.promise });
  try {
    await fixture.auto.stop('prj-mock');
    gate.resolve(emptyStep({ needUserDecision: true }));
    await drain();
    assert.equal(fixture.auto.statusOf('prj-mock').status, 'off');
    assert.equal(fixture.auto.statusOf('prj-mock').pauseReason, null);
    assert.equal(fixture.cancellations(), 1);
  } finally { gate.resolve(emptyStep()); await drain(); fixture.auto.dispose(); }
});

await test('valid advisor successor still seals its frozen parent and scheduler starts the planned child', async () => {
  const fixture = orchestratorFixture({ onRole: (request) => request.request.agentPreset === 'lab-advisor'
    ? advisorOutput({ proposals: [proposal()] })
    : { analysis: 'Mock admission', starts: [{ nodeId: 'n-0002', reason: 'Mock capacity' }] } });
  try {
    const result = await fixture.orchestrator.step('prj-mock');
    assert.deepEqual(result.created, ['n-0002']);
    assert.deepEqual(result.started, ['n-0002']);
    assert.equal(fixture.store.getNode('prj-mock', 'n-0002').status, 'running');
    const parent = fixture.store.getNode('prj-mock', 'n-0001');
    assert.equal(parent.review.reviewedHeadCommit, 'head-a');
    assert.equal(parent.review.reviewedReportVersion, snapshot.reportVersion(parent));
  } finally { fixture.orchestrator.dispose(); }
});

await test('old decision flag cannot pause an unseen completed leaf even when its original parent evidence is unchanged', async () => {
  const started = deferred();
  const gate = deferred();
  const fixture = orchestratorFixture({ onRole: () => { started.resolve(); return gate.promise; } });
  const work = fixture.orchestrator.step('prj-mock');
  await started.promise;
  try {
    await fixture.store.saveNode('prj-mock', completed({ id: 'n-unseen' }));
    gate.resolve(advisorOutput({ needUserDecision: true }));
    assert.equal((await work).needUserDecision, false);
    assert.equal(fixture.store.getNode('prj-mock', 'n-0001').review.reviewedReportVersion, snapshot.reportVersion(completed()));
    assert.equal(fixture.store.getNode('prj-mock', 'n-unseen').review, undefined);
  } finally { gate.resolve(advisorOutput()); await work; fixture.orchestrator.dispose(); }
});

for (const kind of ['same-head report', 'new head', 'new planned', 'existing planned', 'new completed', 'in-place metric']) {
  await test('deferred zero-output cycle preserves new work: ' + kind, async () => {
    const gate = deferred();
    const fixture = await autoFixture({ config: { auto: { idleCycleLimit: 1 } }, step: async () => gate.promise });
    try {
      if (kind === 'same-head report') await fixture.store.saveNode('prj-mock', legacyFollowUp());
      if (kind === 'new head') {
        const node = fixture.store.getNode('prj-mock', 'n-0001');
        node.git.headCommit = 'head-b';
        await fixture.store.saveNode('prj-mock', node);
      }
      if (kind === 'new planned') await fixture.store.saveNode('prj-mock', completed({ id: 'n-late-planned', status: 'planned' }));
      if (kind === 'existing planned') await fixture.store.saveNode('prj-mock', completed({ status: 'planned' }));
      if (kind === 'new completed') await fixture.store.saveNode('prj-mock', completed({ id: 'n-late-completed' }));
      if (kind === 'in-place metric') fixture.store.listNodes()[0].report.metrics[0].value = 2;
      gate.resolve(emptyStep({ needUserDecision: false }));
      await drain();
      assert.equal(fixture.auto.statusOf('prj-mock').status, 'running');
      assert.equal(fixture.auto.statusOf('prj-mock').pauseReason, null);
      assert.equal(fixture.auto.statusOf('prj-mock').idleStreak, 0);
      assert.equal(fixture.auto.statusOf('prj-mock').cycles, 1);
      await fixture.auto.tick();
      assert.equal(fixture.auto.statusOf('prj-mock').pauseReason, 'noProgress');
    } finally { gate.resolve(emptyStep()); await drain(); fixture.auto.dispose(); }
  });
}

await test('review settling the last leaf pauses idle even with idleCycleLimit one', async () => {
  const fixture = await autoFixture({ config: { auto: { idleCycleLimit: 1 } }, step: async (store) => {
    const node = store.getNode('prj-mock', 'n-0001');
    node.review = { reviewedHeadCommit: node.git.headCommit, reviewedReportVersion: snapshot.reportVersion(node) };
    await store.saveNode('prj-mock', node);
    return emptyStep();
  } });
  try {
    assert.equal(fixture.auto.statusOf('prj-mock').pauseReason, 'idle');
    assert.equal(fixture.auto.statusOf('prj-mock').idleStreak, 0);
  } finally { fixture.auto.dispose(); }
});

await test('revision, heartbeat and ignored historical report edits are not new work', async () => {
  const fixture = await autoFixture({ nodes: [legacyFollowUp()], config: { auto: { idleCycleLimit: 1 } }, step: async (store) => {
    const project = store.getProject();
    project.revision += 1;
    await store.saveProject(project);
    const node = store.getNode('prj-mock', 'n-0001');
    node.timestamps.lastActivityAt = Date.now();
    node.report.summary = 'ignored historical structured report changed';
    await store.saveNode('prj-mock', node);
    return emptyStep();
  } });
  try { assert.equal(fixture.auto.statusOf('prj-mock').pauseReason, 'noProgress'); }
  finally { fixture.auto.dispose(); }
});

await test('new evidence cannot bypass budgets crossed during a zero-output cycle', async () => {
  for (const [config, change, reason] of [
    [{ auto: { maxCycles: 1 } }, {}, 'maxCycles'],
    [{ auto: { maxTokens: 5 } }, { usage: { totalTokens: 5 } }, 'maxTokens'],
    [{ auto: { maxCostUsd: 2 } }, { costUsd: 2 }, 'maxCost'],
    [{ maxNodes: 2 }, { addPlanned: true }, 'maxNodes'],
  ]) {
    const fixture = await autoFixture({ config, step: async (store) => {
      const node = legacyFollowUp();
      if (change.usage) node.usage = change.usage;
      if (change.costUsd) node.costUsd = change.costUsd;
      await store.saveNode('prj-mock', node);
      if (change.addPlanned) await store.saveNode('prj-mock', completed({ id: 'n-budget', status: 'planned' }));
      return emptyStep();
    } });
    try { assert.equal(fixture.auto.statusOf('prj-mock').pauseReason, reason); }
    finally { fixture.auto.dispose(); }
  }
});

await test('new evidence cannot bypass wall-clock budget crossed inside a zero-output cycle', async () => {
  const realNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  let fixture;
  try {
    fixture = await autoFixture({ config: { auto: { maxWallClockMs: 10 } }, step: async (store) => {
      await store.saveNode('prj-mock', legacyFollowUp());
      now += 10;
      return emptyStep();
    } });
    assert.equal(fixture.auto.statusOf('prj-mock').pauseReason, 'maxWallClock');
  } finally { fixture?.auto.dispose(); Date.now = realNow; }
});

for (const [status, name, detail] of results) console.log([status, name, detail ?? ''].filter(Boolean).join('  '));
hooks.deregister();
const failures = results.filter(([status]) => status === 'FAIL');
console.log('\n' + (results.length - failures.length) + '/' + results.length + ' offline checks passed');
if (failures.length) process.exitCode = 1;
