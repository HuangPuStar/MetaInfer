/** Offline lifecycle regression: memory store, fake clock and mocked SDK/git/process/driver IO.
 * Run with Node >=24: node scripts/runtime-lifecycle-selftest.mjs
 * No provider, process, filesystem worktree, GPU or network is contacted.
 */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const runtimeUrl = new URL('../host/runtime.js', import.meta.url).href;
const mockSources = {
  'node:fs/promises': `export const readdir=async()=>[]; export const readFile=async()=>''; export const readlink=async()=>'';`,
  './store.js': `let next=0; export const newSessionId=()=> 'mock-session-'+(++next);`,
  './execution-log.js': `export const executionLogPath=()=> 'mock-log'; export class ExecutionLog { constructor(filePath){this.filePath=filePath} async init(){} async append(){} }`,
  './remote-run.js': `export const prepareRemoteRun=async()=>{throw Error('unexpected remote run')};`,
};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    let source = context.parentURL === runtimeUrl ? mockSources[specifier] : undefined;
    if (specifier === './execution-codex.js') {
      source = `export const runCodexExecution=(options)=>globalThis.__lifecycleExternal(options);`;
    }
    if (source) return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { createRuntime } = await import(runtimeUrl);
hooks.deregister();

const minute = 60_000;
const clone = (value) => structuredClone(value);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const realNow = Date.now;
let now = 100 * minute;
Date.now = () => now;
const runtimes = [];
function fixture(patch = {}, options = {}) {
  const project = { id: 'test-project', name: 'Test', brief: 'Mock only', revision: 0, counters: { eventSeq: 0 }, config: {
    maxRunningNodes: 10, resourcePools: { gpu: 4 }, nodeTimeoutMinutes: 10, maxNodeTimeoutMinutes: 120,
  } };
  let currentProject = project;
  const nodes = new Map();
  const diskNodes = new Map();
  const diskProjects = new Map([[project.id, clone(project)]]);
  const events = [];
  const locks = new Map();
  let failure = null, persistentFailure = false, failureNodeId = null, saveGate, saveGateNodeId = null, ensureGate;
  const fail = (name, nodeId) => { if (failure === name && (failureNodeId === null || failureNodeId === nodeId)) { if (!persistentFailure) failure = null; throw Error(`storage ${name} failed`); } };
  const store = {
    getProject: () => currentProject,
    listProjects: () => [currentProject],
    getNode: (_projectId, id) => nodes.get(id),
    listNodes: () => [...nodes.values()].map((node) => ({ ...node })),
    async saveNode(_projectId, node) { if (saveGateNodeId === null || saveGateNodeId === node.id) await saveGate?.promise; fail('saveNode', node.id); nodes.set(node.id, node); diskNodes.set(node.id, clone(node)); },
    async saveProject(value) { fail('saveProject'); currentProject = value; diskProjects.set(value.id, clone(value)); },
    async appendEvent(value, type, payload) { fail('appendEvent'); value.counters.eventSeq++; events.push({ seq: value.counters.eventSeq, type, ...payload }); },
    withProjectLock(id, task) {
      const result = (locks.get(id) ?? Promise.resolve()).then(task);
      locks.set(id, result.catch(() => {}));
      return result;
    },
  };
  function add(id, override = {}) {
    const node = { id, title: id, prompt: 'Mock task', sessionId: `test-session-${id}`, anchorSessionId: `test-anchor-${id}`,
      status: 'planned', kind: 'experiment', timeboxMs: 10 * minute, needs: {}, timestamps: {},
      git: { worktreePath: `/mock-worktrees/${id}`, branch: `mock-${id}`, baseCommit: 'base', headCommit: 'head' }, ...override };
    nodes.set(id, node); diskNodes.set(id, clone(node)); return node;
  }
  const node = add('node-a', patch);
  const agents = new Map();
  const sessions = new Map();
  const sandboxEvents = [];
  const sessionOf = (id) => { if (!sessions.has(id)) sessions.set(id, { id, append: (type, data) => sandboxEvents.push({ sessionId: id, type, data }) }); return sessions.get(id); };
  const activations = [];
  const sends = [];
  const commits = [];
  const cancellations = [];
  let commitGate, activationGate, sendGate;
  const texts = new Map();
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock-provider', model: 'mock-model' }) },
    get: () => null,
    agents: {
      get: (id) => agents.get(id),
      async create({ sessionId }) { const agent = { id: sessionId, session: sessionOf(sessionId) }; agents.set(sessionId, agent); return { agent, dispose: async () => {} }; },
      async resume({ resumeSessionId }) { const agent = { id: resumeSessionId, session: sessionOf(resumeSessionId) }; agents.set(resumeSessionId, agent); return { agent, dispose: async () => {} }; },
    },
    subagents: {
      async startActivation(spec) {
        if (options.startFailure) throw Error('activation start failed');
        const result = deferred();
        const activation = { result: result.promise, disposeCount: 0, dispose: async () => { activation.disposeCount++; await options.onDispose?.(); await options.disposeGate?.promise; } };
        agents.set(spec.childId, { id: spec.childId, session: Object.assign(sessionOf(spec.childId), { header: { cwd: options.childCwd ?? spec.request.cwd } }), cancel: () => cancellations.push(spec.childId) });
        activations.push({ ...result, activation, spec });
        await activationGate?.promise;
        return activation;
      },
      async sendMessage(anchor, sessionId, content) {
        const messageId = 'mock-message-' + (sends.length + 1);
        sends.push({ anchor, sessionId, content, messageId, turn: sends.length + 2 });
        agents.set(sessionId, { id: sessionId, session: sessionOf(sessionId), cancel: () => cancellations.push(sessionId) });
        await sendGate?.promise;
        if (options.sendFailure) throw Error('send failed');
        return Object.hasOwn(options, 'receipt') ? options.receipt : messageId;
      },
    },
    sessionQuery: { readSurface: async (id) => ({ events: [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: texts.get(id) ?? '' }] } } }] }) },
  };
  const git = {
    ensureWorktree: async () => { await ensureGate?.promise; if (options.ensureFailure) throw Error('worktree failed'); },
    branchOf: async (worktree) => [...nodes.values()].find((item) => item.git.worktreePath === worktree)?.git.branch,
    async commitWorktree(_project, value) { commits.push(value.id); await commitGate?.promise; return { head: 'same-head', committed: false }; },
    mergeBranchIntoWorktree: async () => ({ code: 0, conflicts: [] }),
    finishMergeInWorktree: async () => { if (options.mergeFailure) throw Error('merge conflict'); commits.push('merge'); await commitGate?.promise; return { head: 'same-head', committed: true }; },
  };
  const renewals = [], releases = [];
  const cluster = options.cluster ? {
    enabled: true, heartbeatMs: 1, machineId: 'mock-machine',
    getStatus: () => ({ devices: ['mock-device'] }),
    acquire: async () => ({ status: 'granted', lease: { leaseId: 'mock-lease', placement: 'local' } }),
    renew: async (id, ttl) => { renewals.push({ id, ttl }); return options.renewalResult ?? { status: 'renewed' }; },
    release: async (id) => { releases.push(id); },
  } : undefined;
  const externalRuns = [];
  globalThis.__lifecycleExternal = (spec) => {
    const run = deferred(); externalRuns.push({ ...run, spec });
    spec.signal.addEventListener('abort', () => run.reject(Error('external aborted')), { once: true });
    return run.promise;
  };
  const runtime = createRuntime({ ctx, store, git, cluster });
  runtimes.push(runtime);
  return { runtime, store, project, node, nodes, diskNodes, diskProjects, events, activations, sends, commits, cancellations, texts, renewals, releases, externalRuns, add, sessionOf, sandboxEvents,
    replaceProject: (patch) => { currentProject = { ...clone(currentProject), ...clone(patch) }; diskProjects.set(currentProject.id, clone(currentProject)); return currentProject; },
    failNext: (name, persistent = false, nodeId = null) => { failure = name; persistentFailure = persistent; failureNodeId = nodeId; },
    gateSave: (nodeId = null) => { saveGateNodeId = nodeId; return (saveGate = deferred()); }, gateEnsure: () => (ensureGate = deferred()),
    gateCommit: () => (commitGate = deferred()), gateActivation: () => (activationGate = deferred()), gateSend: () => (sendGate = deferred()),
  };
}
async function flush() { for (let i = 0; i < 12; i++) await new Promise((resolve) => setImmediate(resolve)); }
const completed = (summary = 'A') => ({ stopReason: 'completed', structured: { summary, success: true, metrics: [] }, output: [{ type: 'text', text: summary }] });
async function finishFirst(f) { f.activations[0].resolve(completed()); await flush(); assert.equal(f.node.status, 'completed'); }
async function inboxClaim(f, messageId, turn, sessionId = f.node.sessionId, session = f.sessionOf(sessionId)) {
  await f.runtime.onInboxClaimed?.({ agent: { id: sessionId, session }, message: { id: messageId }, turn });
}
async function endOnly(f, turn, kind = 'completed', sessionId = f.node.sessionId, session = f.sessionOf(sessionId)) {
  await f.runtime.onSessionEvent(session, { type: 'turn/end', data: { turn, reason: { kind } } });
}
async function turnEnd(f, kind = 'completed') {
  const sent = f.sends.at(-1);
  if (sent) await inboxClaim(f, sent.messageId, sent.turn);
  await endOnly(f, sent?.turn ?? 1, kind);
}
const results = [];
async function test(name, fn) {
  now = 100 * minute;
  try { await fn(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: error.stack }); }
  finally { for (const runtime of runtimes.splice(0)) runtime.dispose(); }
}
const code = (expected) => (error) => error.code === expected;

await test('running extension preserves elapsed time and identity', async () => {
  const f = fixture(); await f.runtime.start(f.project.id, f.node.id);
  const deadline = f.node.deadlineAt, session = f.node.sessionId;
  now += 3 * minute;
  const result = await f.runtime.updateTimebox(f.project.id, f.node.id, 15 * minute);
  assert.equal(result.node.deadlineAt, deadline + 5 * minute);
  assert.equal(result.node.sessionId, session);
  assert.equal(f.project.config.nodeTimeoutMinutes, 10);
  assert.equal(f.runtime.decorateNodes(f.project.id, [f.node])[0].deadlineAt, f.node.deadlineAt);
});
await test('follow-up times out and cannot be resurrected by late end', async () => {
  const f = fixture(); await f.runtime.start(f.project.id, f.node.id); await finishFirst(f);
  await f.runtime.message(f.project.id, f.node.id, 'new instruction');
  now = f.node.deadlineAt + 1; await f.runtime.tick();
  assert.equal(f.node.status, 'failed'); assert.equal(f.node.error.stage, 'timeout');
  assert.equal(f.cancellations.length, 1);
  const count = f.commits.length; await turnEnd(f); assert.equal(f.node.status, 'failed'); assert.equal(f.commits.length, count);
});
await test('merge idle stays deadline-managed and cancellable', async () => {
  const f = fixture({ kind: 'merge', parentIds: [] }); await f.runtime.start(f.project.id, f.node.id);
  f.activations[0].resolve(completed()); await flush();
  assert.equal(f.node.status, 'running');
  await f.runtime.cancel(f.project.id, f.node.id); assert.equal(f.node.status, 'cancelled'); assert.equal(f.cancellations.length, 1);
});
await test('storage failure restores timebox and deadline without rewinding metadata reservations', async () => {
  const f = fixture(); await f.runtime.start(f.project.id, f.node.id);
  const before = clone(f.node), revision = f.project.revision, eventSeq = f.project.counters.eventSeq;
  f.failNext('saveNode');
  await assert.rejects(() => f.runtime.updateTimebox(f.project.id, f.node.id, 20 * minute), /storage/);
  assert.deepEqual(f.node, before); assert.equal(f.project.revision, revision + 1); assert.equal(f.project.counters.eventSeq, eventSeq + 1);
  assert.equal(f.runtime.decorateNodes(f.project.id, [f.node])[0].deadlineAt, before.deadlineAt);
  assert.equal(f.events.some((event) => event.type === 'node/timebox_changed'), false);
});
await test('follow-up report A to B on same head clears stale structured evidence and review', async () => {
  const f = fixture(); await f.runtime.start(f.project.id, f.node.id); await finishFirst(f);
  f.node.review = { verdict: 'accepted' };
  await f.runtime.message(f.project.id, f.node.id, 'B');
  assert.equal(f.node.report, null); assert.equal(f.node.review, undefined);
  f.texts.set(f.node.sessionId, 'B'); now += 1; await turnEnd(f);
  assert.equal(f.node.reportText, 'B'); assert.equal(f.node.reportSource, 'followUp'); assert.equal(f.node.reportUpdatedAt, now);
  assert.equal(f.node.followUps.at(-1).previousReport.summary, 'A'); assert.equal(f.node.git.headCommit, 'same-head');
});
await test('external retry never falls back into DSH follow-up', async () => {
  const f = fixture({ status: 'failed', execution: { profile: 'codex', driver: 'codex' }, error: { stage: 'run' }, timestamps: { startedAt: now - minute } });
  await assert.rejects(() => f.runtime.retry(f.project.id, f.node.id), code('not_continuable'));
  assert.equal(f.activations.length, 0); assert.equal(f.sends.length, 0);
});


for (const status of ['planned', 'proposed', 'failed', 'cancelled', 'completed']) {
  await test('future budget edit on ' + status + ' has no runtime effects', async () => {
    const f = fixture({ status, deadlineAt: 12, model: { provider: 'x', model: 'y' }, needs: { gpu: 1 } });
    const before = clone(f.node); await f.runtime.updateTimebox(f.project.id, f.node.id, 8 * minute);
    assert.deepEqual(f.node, { ...before, timeboxMs: 8 * minute });
    assert.equal(f.activations.length, 0); assert.equal(f.sends.length, 0); assert.equal(f.commits.length, 0);
    assert.equal(f.diskNodes.get(f.node.id).timeboxMs, 8 * minute);
  });
}
await test('validation rejects noninteger/nonminute/out-of-cap values without mutation', async () => {
  const f = fixture(); const before = clone(f.node);
  for (const value of [0, -minute, minute + 1, 1.5, NaN, Infinity, '60000', null, 121 * minute]) {
    await assert.rejects(() => f.runtime.updateTimebox(f.project.id, f.node.id, value), code('timebox_invalid'));
    assert.deepEqual(f.node, before); assert.equal(f.project.revision, 0);
  }
  f.project.config.maxNodeTimeoutMinutes = 2000;
  await assert.rejects(() => f.runtime.updateTimebox(f.project.id, f.node.id, 1441 * minute), code('timebox_invalid'));
  await f.runtime.updateTimebox(f.project.id, f.node.id, 1440 * minute);
  const g = fixture(); delete g.project.config.maxNodeTimeoutMinutes;
  await g.runtime.updateTimebox(g.project.id, g.node.id, 1440 * minute);
});
await test('completed nodes sealed by successor, sealedAt or tag reject editing', async () => {
  for (const marker of ['child', 'sealedAt', 'tag']) {
    const f = fixture({ status: 'completed' });
    if (marker === 'child') f.add('child', { parentId: f.node.id, status: 'planned' });
    if (marker === 'sealedAt') f.node.timestamps.sealedAt = now;
    if (marker === 'tag') f.node.tag = 'release';
    await assert.rejects(() => f.runtime.updateTimebox(f.project.id, f.node.id, 8 * minute), code('node_sealed'));
  }
  const f = fixture({ status: 'completed' }); f.add('proposal', { parentIds: [f.node.id], status: 'proposed' });
  await f.runtime.updateTimebox(f.project.id, f.node.id, 8 * minute);
});
await test('shortening retains elapsed time and rejects an already-passed new deadline', async () => {
  const f = fixture(); await f.runtime.start(f.project.id, f.node.id); const oldDeadline = f.node.deadlineAt;
  now += 3 * minute; await f.runtime.updateTimebox(f.project.id, f.node.id, 6 * minute);
  assert.equal(f.node.deadlineAt, oldDeadline - 4 * minute);
  const before = clone(f.node), revision = f.project.revision;
  await assert.rejects(() => f.runtime.updateTimebox(f.project.id, f.node.id, 3 * minute), code('timebox_elapsed'));
  assert.deepEqual(f.node, before); assert.equal(f.project.revision, revision);
});
await test('expired or missing active runtime cannot be revived', async () => {
  const f = fixture(); await f.runtime.start(f.project.id, f.node.id); now = f.node.deadlineAt;
  await assert.rejects(() => f.runtime.updateTimebox(f.project.id, f.node.id, 20 * minute), code('node_timebox_unavailable'));
  const g = fixture({ status: 'running', deadlineAt: now + minute });
  await assert.rejects(() => g.runtime.updateTimebox(g.project.id, g.node.id, 20 * minute), code('node_timebox_unavailable'));
});
for (const operation of ['saveNode', 'saveProject', 'appendEvent']) {
  await test(operation + ' failure restores durable and in-memory timebox state', async () => {
    const f = fixture(); await f.runtime.start(f.project.id, f.node.id);
    const node = clone(f.node), project = clone(f.project), eventCount = f.events.length;
    f.failNext(operation);
    await assert.rejects(() => f.runtime.updateTimebox(f.project.id, f.node.id, 20 * minute), /storage/);
    assert.deepEqual(f.node, node); assert.deepEqual(f.diskNodes.get(f.node.id), node);
    assert.equal(f.project.revision, project.revision + 1); assert.equal(f.project.counters.eventSeq, project.counters.eventSeq + 1);
    assert.deepEqual(f.project.config, project.config);
    const durable = f.diskProjects.get(f.project.id);
    assert.ok(durable.revision >= project.revision); assert.ok(durable.counters.eventSeq >= project.counters.eventSeq);
    assert.equal(f.runtime.decorateNodes(f.project.id, [f.node])[0].deadlineAt, node.deadlineAt);
    assert.equal(f.events.length, eventCount);
    now = node.deadlineAt + 1; await f.runtime.tick(); assert.equal(f.node.status, 'failed');
  });
}
await test('persistent project failure is thrown without a compensating project retry', async () => {
  const f = fixture(); await f.runtime.start(f.project.id, f.node.id); const before = clone(f.node);
  const saveProject = f.store.saveProject; let calls = 0;
  f.store.saveProject = (...args) => { calls++; return saveProject(...args); };
  f.failNext('saveProject', true);
  await assert.rejects(() => f.runtime.updateTimebox(f.project.id, f.node.id, 20 * minute), (error) => /storage saveProject failed/.test(error.message) && !Object.hasOwn(error, 'rollbackError'));
  assert.deepEqual(f.node, before); assert.equal(calls, 1); assert.deepEqual(f.diskNodes.get(f.node.id), before);
});
await test('persistent node compensation failure throws the original error with only its node rollbackError', async () => {
  const f = fixture(); await f.runtime.start(f.project.id, f.node.id); const before = clone(f.node);
  const primary = Error('primary node save failed'), rollback = Error('compensating node save failed'); let calls = 0, projectCalls = 0;
  f.store.saveNode = async () => { throw ++calls === 1 ? primary : rollback; };
  f.store.saveProject = async () => { projectCalls++; };
  await assert.rejects(() => f.runtime.updateTimebox(f.project.id, f.node.id, 20 * minute), (error) => error === primary && error.rollbackError === rollback);
  assert.deepEqual(f.node, before); assert.equal(calls, 2); assert.equal(projectCalls, 0);
  assert.equal(f.events.some((event) => event.type === 'node/timebox_changed'), false);
});
await test('old watchdog snapshot cannot terminate a successfully extended node', async () => {
  const f = fixture(); await f.runtime.start(f.project.id, f.node.id); const oldDeadline = f.node.deadlineAt;
  const gate = f.gateSave(); now = oldDeadline - 1;
  const update = f.runtime.updateTimebox(f.project.id, f.node.id, 20 * minute); await flush();
  now = oldDeadline + 1; const tick = f.runtime.tick(); await flush(); gate.resolve();
  await Promise.all([update, tick]);
  assert.equal(f.node.status, 'running'); assert.equal(f.cancellations.length, 0);
  assert.equal(f.node.deadlineAt, oldDeadline + 10 * minute);
  now = f.node.deadlineAt + 1; await f.runtime.tick(); assert.equal(f.node.status, 'failed');
});


await test('activation startup rejects timebox editing and cancellation wins a late handle', async () => {
  const f = fixture(); const gate = f.gateActivation(); const start = f.runtime.start(f.project.id, f.node.id);
  const rejected = assert.rejects(start, code('node_not_startable')); await flush();
  await assert.rejects(() => f.runtime.updateTimebox(f.project.id, f.node.id, 20 * minute), code('node_timebox_unavailable'));
  await f.runtime.cancel(f.project.id, f.node.id); assert.equal(f.node.status, 'cancelled');
  const count = f.commits.length; gate.resolve(); await rejected;
  assert.equal(f.node.status, 'cancelled'); assert.equal(f.commits.length, count); assert.equal(f.activations[0].activation.disposeCount, 1);
});
await test('starting activation failure is start-stage failed and releases exactly once', async () => {
  const f = fixture({ needs: { gpu: 1 } }, { cluster: true, startFailure: true });
  await assert.rejects(() => f.runtime.start(f.project.id, f.node.id), /activation start failed/);
  assert.equal(f.node.status, 'failed'); assert.equal(f.node.error.stage, 'start'); assert.equal(f.releases.length, 1);
});
await test('sandbox mismatch terminates outside project lock without startup resurrection', async () => {
  const f = fixture({}, { childCwd: '/different-cwd' });
  await assert.rejects(() => f.runtime.start(f.project.id, f.node.id), code('sandbox_mismatch'));
  assert.equal(f.node.status, 'failed'); assert.equal(f.node.termination.kind, 'failure'); assert.equal(f.commits.length, 1);
});
await test('follow-up extension and explicit cancellation use the same managed deadline', async () => {
  const f = fixture(); await f.runtime.start(f.project.id, f.node.id); await finishFirst(f);
  now += 100 * minute; await f.runtime.message(f.project.id, f.node.id, 'follow up'); const deadline = f.node.deadlineAt;
  now += minute; await f.runtime.updateTimebox(f.project.id, f.node.id, 15 * minute);
  assert.equal(f.node.deadlineAt, deadline + 5 * minute); const count = f.commits.length;
  await f.runtime.cancel(f.project.id, f.node.id); await turnEnd(f);
  assert.equal(f.node.status, 'cancelled'); assert.equal(f.commits.length, count + 1); assert.equal(f.cancellations.length, 1);
});
await test('send failure fails once and later turn end does not resurrect', async () => {
  const f = fixture({}, { sendFailure: true }); await f.runtime.start(f.project.id, f.node.id); await finishFirst(f);
  const count = f.commits.length;
  await assert.rejects(() => f.runtime.message(f.project.id, f.node.id, 'fail'), /send failed/);
  assert.equal(f.node.status, 'failed'); assert.equal(f.node.error.stage, 'run'); assert.equal(f.commits.length, count + 1);
  await turnEnd(f); assert.equal(f.node.status, 'failed'); assert.equal(f.commits.length, count + 1);
});
await test('timeout during blocked send wins send rejection and a late end once', async () => {
  const f = fixture({}, { sendFailure: true }); await f.runtime.start(f.project.id, f.node.id); await finishFirst(f);
  const gate = f.gateSend(), count = f.commits.length;
  const send = f.runtime.message(f.project.id, f.node.id, 'slow'); const rejected = assert.rejects(send, /send failed/); await flush();
  now = f.node.deadlineAt + 1; await f.runtime.tick(); gate.resolve(); await rejected; await turnEnd(f);
  assert.equal(f.node.status, 'failed'); assert.equal(f.node.error.stage, 'timeout'); assert.equal(f.commits.length, count + 1);
});
await test('follow-up completion claims once against duplicate end, timeout and cancel', async () => {
  const f = fixture(); await f.runtime.start(f.project.id, f.node.id); await finishFirst(f);
  await f.runtime.message(f.project.id, f.node.id, 'done'); const gate = f.gateCommit(), count = f.commits.length;
  const end = turnEnd(f); await flush();
  await turnEnd(f); await assert.rejects(() => f.runtime.cancel(f.project.id, f.node.id), code('node_not_cancellable'));
  await assert.rejects(() => f.runtime.updateTimebox(f.project.id, f.node.id, 20 * minute), code('node_timebox_unavailable'));
  now = f.node.deadlineAt + 1; await f.runtime.tick(); gate.resolve(); await end;
  assert.equal(f.node.status, 'completed'); assert.equal(f.commits.length, count + 1);
});
await test('run-stage retry is managed and GPU follow-up remains forbidden', async () => {
  const f = fixture({ status: 'failed', error: { stage: 'run', message: 'old error' }, timestamps: { startedAt: now - minute } });
  await f.runtime.retry(f.project.id, f.node.id); assert.equal(f.sends.length, 1); assert.equal(f.activations.length, 0);
  now = f.node.deadlineAt + 1; await f.runtime.tick(); assert.equal(f.node.error.stage, 'timeout');
  const g = fixture({ status: 'completed', needs: { gpu: 1 } }, { cluster: true });
  await assert.rejects(() => g.runtime.message(g.project.id, g.node.id, 'unsafe GPU'), code('gpu_followup_requires_attempt'));
});


await test('merge idle extension survives old deadline and times out once on the new deadline', async () => {
  const f = fixture({ kind: 'merge', parentIds: [] }); await f.runtime.start(f.project.id, f.node.id);
  f.activations[0].resolve(completed()); await flush(); const deadline = f.node.deadlineAt;
  await f.runtime.updateTimebox(f.project.id, f.node.id, 20 * minute); now = deadline + 1; await f.runtime.tick();
  assert.equal(f.node.status, 'running'); now = f.node.deadlineAt + 1; await f.runtime.tick(); await f.runtime.tick();
  assert.equal(f.node.status, 'failed'); assert.equal(f.commits.length, 1); assert.equal(f.cancellations.length, 1);
});
await test('merge follow-up returns idle without resetting original deadline', async () => {
  const f = fixture({ kind: 'merge', parentIds: [] }); await f.runtime.start(f.project.id, f.node.id);
  f.activations[0].resolve(completed()); await flush(); const deadline = f.node.deadlineAt;
  now += minute; await f.runtime.message(f.project.id, f.node.id, 'resolve'); f.texts.set(f.node.sessionId, 'resolved'); await turnEnd(f);
  assert.equal(f.node.status, 'running'); assert.equal(f.node.deadlineAt, deadline);
  await f.runtime.cancel(f.project.id, f.node.id); assert.equal(f.node.status, 'cancelled');
});
await test('merge finish single-claims git and writes merge-source text without fabricated metrics', async () => {
  const f = fixture({ kind: 'merge', parentIds: [] }); await f.runtime.start(f.project.id, f.node.id);
  f.activations[0].resolve(completed()); await flush(); const gate = f.gateCommit();
  const finish = f.runtime.finishMerge(f.project.id, f.node.id, { summary: 'human evidence' }); await flush();
  await assert.rejects(() => f.runtime.finishMerge(f.project.id, f.node.id), code('node_not_mergeable'));
  await assert.rejects(() => f.runtime.updateTimebox(f.project.id, f.node.id, 20 * minute), code('node_timebox_unavailable'));
  await assert.rejects(() => f.runtime.cancel(f.project.id, f.node.id), code('node_not_cancellable'));
  gate.resolve(); await finish;
  assert.equal(f.node.status, 'completed'); assert.equal(f.node.report, null); assert.equal(f.node.reportSource, 'merge');
  assert.match(f.node.reportText, /human evidence/); assert.equal(f.commits.length, 1); assert.equal(f.node.reportUpdatedAt, now);
});
await test('failed merge commit keeps idle merge deadline-managed', async () => {
  const f = fixture({ kind: 'merge', parentIds: [] }, { mergeFailure: true }); await f.runtime.start(f.project.id, f.node.id);
  f.activations[0].resolve(completed()); await flush(); await assert.rejects(() => f.runtime.finishMerge(f.project.id, f.node.id), /merge conflict/);
  await f.runtime.updateTimebox(f.project.id, f.node.id, 20 * minute);
  await f.runtime.cancel(f.project.id, f.node.id); assert.equal(f.node.status, 'cancelled');
});
await test('lease renewal TTL follows current remaining deadline including idle merges', async () => {
  const f = fixture({ needs: { gpu: 1 } }, { cluster: true }); await f.runtime.start(f.project.id, f.node.id);
  now += 2 * minute; await f.runtime.updateTimebox(f.project.id, f.node.id, 20 * minute); await f.runtime.tick();
  assert.equal(f.renewals.at(-1).ttl, f.node.deadlineAt - now + 120_000);
  f.activations[0].resolve(completed()); await flush(); assert.equal(f.releases.length, 1);
  const g = fixture({ kind: 'merge', parentIds: [], needs: { gpu: 1 } }, { cluster: true }); await g.runtime.start(g.project.id, g.node.id);
  g.activations[0].resolve(completed()); await flush(); now += minute; await g.runtime.tick(); assert.equal(g.renewals.length, 1);
});
await test('external driver stays external and late completion cannot resurrect timeout', async () => {
  const f = fixture({ execution: { profile: 'codex', driver: 'codex' } }); await f.runtime.start(f.project.id, f.node.id);
  assert.equal(f.externalRuns.length, 1); assert.equal(f.activations.length, 0);
  await f.runtime.updateTimebox(f.project.id, f.node.id, 15 * minute); now = f.node.deadlineAt + 1;
  await f.runtime.tick(); await flush(); assert.equal(f.node.status, 'failed'); assert.equal(f.commits.length, 1);
});
await test('ancestry and merge prompts use legacy follow-up text rather than stale structured evidence', async () => {
  const legacy = { status: 'completed', report: { summary: 'STALE-A' }, reportText: 'CURRENT-B',
    followUps: [{ at: now, assistant: 'CURRENT-B', headCommit: 'head' }] };
  const f = fixture(); f.add('parent', legacy); f.node.parentId = 'parent'; await f.runtime.start(f.project.id, f.node.id);
  assert.match(f.activations[0].spec.request.prompt[0].text, /CURRENT-B/); assert.doesNotMatch(f.activations[0].spec.request.prompt[0].text, /STALE-A/);
  const g = fixture({ kind: 'merge', parentIds: ['parent'] }); g.add('parent', legacy); await g.runtime.start(g.project.id, g.node.id);
  assert.match(g.activations[0].spec.request.prompt[0].text, /CURRENT-B/); assert.doesNotMatch(g.activations[0].spec.request.prompt[0].text, /STALE-A/);
});


await test('activation evidence is explicitly current and independent of follow-up history', async () => {
  const f = fixture({ followUps: [{ at: now - minute, assistant: 'historical' }] });
  const structured = { success: true, summary: 'fresh activation', metrics: { score: 7 } };
  await f.runtime.start(f.project.id, f.node.id); f.activations[0].resolve({ ...completed('fresh activation'), structured }); await flush();
  assert.equal(f.node.status, 'completed'); assert.equal(f.node.reportSource, 'activation');
  assert.deepEqual(f.node.report, structured); assert.equal(f.node.reportUpdatedAt, now);
});
await test('interrupted initial merge turn fails rather than pretending to be idle', async () => {
  const f = fixture({ kind: 'merge', parentIds: [] }); await f.runtime.start(f.project.id, f.node.id);
  f.activations[0].resolve({ ...completed(), stopReason: 'cancelled' }); await flush();
  assert.equal(f.node.status, 'failed'); assert.equal(f.commits.length, 1); await turnEnd(f); assert.equal(f.node.status, 'failed');
});
await test('activation disposal never waits while owning the project lock', async () => {
  const options = {}; const f = fixture({}, options); await f.runtime.start(f.project.id, f.node.id);
  let lockEntered = false;
  options.onDispose = () => f.store.withProjectLock(f.project.id, async () => { lockEntered = true; });
  await f.runtime.cancel(f.project.id, f.node.id); assert.equal(lockEntered, true); assert.equal(f.node.status, 'cancelled');
});
await test('finishing state remains unavailable until disposal ends but leaves project lock free', async () => {
  const gate = deferred(); const f = fixture({}, { disposeGate: gate }); await f.runtime.start(f.project.id, f.node.id);
  f.activations[0].resolve(completed()); await flush(); assert.equal(f.node.status, 'completed');
  await assert.rejects(() => f.runtime.updateTimebox(f.project.id, f.node.id, 20 * minute), code('node_timebox_unavailable'));
  gate.resolve(); await flush(); await f.runtime.updateTimebox(f.project.id, f.node.id, 20 * minute); assert.equal(f.node.timeboxMs, 20 * minute);
});


for (const status of ['failed', 'cancelled']) {
  for (const sealed of [{ tag: 'archived-head' }, { timestamps: { sealedAt: 1 } }]) {
    await test(status + ' historical sealed marker rejects timebox edits: ' + Object.keys(sealed)[0], async () => {
      const f = fixture({ status, ...sealed }); const before = clone(f.node);
      await assert.rejects(() => f.runtime.updateTimebox(f.project.id, f.node.id, 20 * minute), code('node_sealed'));
      assert.deepEqual(f.node, before); assert.equal(f.events.length, 0);
    });
  }
}


await test('external startup cancellation cannot start a driver later or leave its run marked live', async () => {
  const f = fixture({ execution: { profile: 'codex', driver: 'codex' } }); const gate = f.gateEnsure();
  const starting = f.runtime.start(f.project.id, f.node.id); const rejected = assert.rejects(starting, code('node_not_startable'));
  await flush(); await f.runtime.cancel(f.project.id, f.node.id); gate.resolve(); await rejected;
  assert.equal(f.node.status, 'cancelled'); assert.equal(f.node.executionRun.status, 'cancelled'); assert.equal(f.externalRuns.length, 0);
});


await test('cross-turn old end cannot complete a new retry in the same session', async () => {
  const f = fixture({ status: 'completed', timestamps: { startedAt: now - minute } }); const sessionId = f.node.sessionId;
  await f.runtime.message(f.project.id, f.node.id, 'first continuation'); await inboxClaim(f, f.sends[0].messageId, 4);
  now = f.node.deadlineAt + 1; await f.runtime.tick(); assert.equal(f.node.status, 'failed');
  await f.runtime.retry(f.project.id, f.node.id); assert.equal(f.node.sessionId, sessionId);
  await inboxClaim(f, f.sends[1].messageId, 5); const count = f.commits.length;
  await endOnly(f, 4); assert.equal(f.node.status, 'running'); assert.equal(f.commits.length, count);
  f.texts.set(sessionId, 'new retry evidence'); await endOnly(f, 5); assert.equal(f.node.status, 'completed');
  assert.equal(f.node.reportText, 'new retry evidence'); assert.equal(f.commits.length, count + 1);
});
for (const order of ['rce', 'rec', 'cre', 'cer', 'erc', 'ecr']) {
  await test('receipt/claim/end order ' + order + ' requires all correlation evidence', async () => {
    const f = fixture({ status: 'completed' }); const gate = f.gateSend();
    const sending = f.runtime.message(f.project.id, f.node.id, 'ordered continuation'); await flush();
    try {
      assert.equal(f.sends.length, 1); const id = f.sends[0].messageId; const seen = new Set();
      for (const step of order) {
        if (step === 'r') { gate.resolve(); await sending; }
        if (step === 'c') await inboxClaim(f, id, 7);
        if (step === 'e') await endOnly(f, 7);
        seen.add(step);
        assert.equal(f.node.status, seen.size === 3 ? 'completed' : 'running');
      }
      assert.equal(f.commits.length, 1);
    } finally { gate.resolve(); await sending.catch(() => {}); }
  });
}
await test('wrong session, message id and turn never finish another pending delivery', async () => {
  const f = fixture({ status: 'completed' }); await f.runtime.message(f.project.id, f.node.id, 'correlated');
  const id = f.sends[0].messageId;
  await inboxClaim(f, id, 6, 'unrelated-session'); await inboxClaim(f, 'unrelated-message', 6); await endOnly(f, 6);
  assert.equal(f.node.status, 'running'); assert.equal(f.commits.length, 0);
  await inboxClaim(f, id, 8); await endOnly(f, 8, 'completed', 'unrelated-session'); await endOnly(f, 9);
  assert.equal(f.node.status, 'running'); await endOnly(f, 8); assert.equal(f.node.status, 'completed');
});
await test('same-turn steer and historical turn zero are valid claimed turn numbers', async () => {
  const f = fixture({ status: 'completed' });
  for (const turn of [3, 3, 0]) {
    await f.runtime.message(f.project.id, f.node.id, 'steered continuation');
    await inboxClaim(f, f.sends.at(-1).messageId, turn); assert.equal(f.node.status, 'running');
    await endOnly(f, turn); assert.equal(f.node.status, 'completed');
  }
  assert.equal(f.commits.length, 3);
});
for (const receipt of [undefined, null, { messageId: 'not-the-SDK-shape' }]) {
  await test('missing/non-string receipt cannot report completion: ' + String(receipt), async () => {
    const f = fixture({ status: 'completed' }, { receipt }); await f.runtime.message(f.project.id, f.node.id, 'missing receipt');
    await inboxClaim(f, f.sends[0].messageId, 2); await endOnly(f, 2);
    assert.equal(f.node.status, 'running'); assert.equal(f.commits.length, 0);
    now = f.node.deadlineAt + 1; await f.runtime.tick(); assert.equal(f.node.status, 'failed');
  });
}
await test('missing claimed/end turn stays managed and cancellable without a fabricated success', async () => {
  const f = fixture({ status: 'completed' }); await f.runtime.message(f.project.id, f.node.id, 'missing turn');
  await inboxClaim(f, f.sends[0].messageId, undefined); await endOnly(f, undefined);
  assert.equal(f.node.status, 'running'); await inboxClaim(f, f.sends[0].messageId, 2); await endOnly(f, undefined);
  assert.equal(f.node.status, 'running'); await f.runtime.cancel(f.project.id, f.node.id); assert.equal(f.node.status, 'cancelled');
});
await test('duplicate correlation, delayed receipt and late cancel events cannot resurrect a cancelled pending', async () => {
  const f = fixture({ status: 'completed' }); const gate = f.gateSend();
  const sending = f.runtime.message(f.project.id, f.node.id, 'cancel before receipt'); await flush();
  await inboxClaim(f, f.sends[0].messageId, 4); await f.runtime.cancel(f.project.id, f.node.id); const count = f.commits.length;
  await endOnly(f, 4); gate.resolve(); await sending; await inboxClaim(f, f.sends[0].messageId, 4); await endOnly(f, 4);
  assert.equal(f.node.status, 'cancelled'); assert.equal(f.commits.length, count);
});
await test('matching failed end fails once while unrelated failed end is ignored', async () => {
  const f = fixture({ status: 'completed' }); await f.runtime.message(f.project.id, f.node.id, 'failure correlation');
  await inboxClaim(f, f.sends[0].messageId, 11); await endOnly(f, 10, 'error'); assert.equal(f.node.status, 'running');
  await endOnly(f, 11, 'error'); assert.equal(f.node.status, 'failed'); const count = f.commits.length;
  await endOnly(f, 11, 'error'); assert.equal(f.commits.length, count);
});


await test('same-id different Session object and equal turn cannot complete current pending', async () => {
  const f = fixture({ status: 'completed' }); await f.runtime.message(f.project.id, f.node.id, 'session identity');
  await inboxClaim(f, f.sends[0].messageId, 9);
  await endOnly(f, 9, 'completed', f.node.sessionId, { id: f.node.sessionId });
  assert.equal(f.node.status, 'running'); assert.equal(f.commits.length, 0);
  await endOnly(f, 9); assert.equal(f.node.status, 'completed');
});


await test('claimed hook is public and initial activation still completes only through its captured result', async () => {
  const f = fixture(); assert.equal(typeof f.runtime.onInboxClaimed, 'function'); await f.runtime.start(f.project.id, f.node.id);
  await inboxClaim(f, 'activation-message', 1); await endOnly(f, 1); assert.equal(f.node.status, 'running');
  await finishFirst(f); assert.equal(f.node.reportSource, 'activation');
});
await test('merge follow-up needs correlated end before becoming idle and accepting another steer', async () => {
  const f = fixture({ kind: 'merge', parentIds: [] }); await f.runtime.start(f.project.id, f.node.id);
  f.activations[0].resolve(completed()); await flush(); await f.runtime.message(f.project.id, f.node.id, 'merge follow-up');
  await inboxClaim(f, f.sends[0].messageId, 5); await endOnly(f, 4);
  await assert.rejects(() => f.runtime.message(f.project.id, f.node.id, 'too early'), code('node_not_continuable'));
  await endOnly(f, 5); await f.runtime.message(f.project.id, f.node.id, 'same-turn steer');
  await inboxClaim(f, f.sends[1].messageId, 5); await endOnly(f, 5); await f.runtime.cancel(f.project.id, f.node.id);
  assert.equal(f.node.status, 'cancelled'); assert.equal(f.commits.length, 1);
});
await test('bounded noisy metadata before receipt cannot fabricate success or poison the final matching claim', async () => {
  const f = fixture({ status: 'completed' }); const gate = f.gateSend();
  const sending = f.runtime.message(f.project.id, f.node.id, 'bounded metadata'); await flush();
  try {
    for (let turn = 0; turn < 80; turn++) { await inboxClaim(f, 'unrelated-' + turn, turn); await endOnly(f, turn); }
    assert.equal(f.node.status, 'running'); assert.equal(f.commits.length, 0);
    await inboxClaim(f, f.sends[0].messageId, 500); await inboxClaim(f, f.sends[0].messageId, 500);
    await endOnly(f, 500); await endOnly(f, 500); assert.equal(f.node.status, 'running');
    gate.resolve(); await sending; assert.equal(f.node.status, 'completed'); assert.equal(f.commits.length, 1);
    assert.doesNotMatch(JSON.stringify(f.node), /mock-message-/);
  } finally { gate.resolve(); await sending.catch(() => {}); }
});
await test('old receipt delivered after next retry cannot bind or complete the replacement pending', async () => {
  const f = fixture({ status: 'completed', timestamps: { startedAt: now - minute } }); const gate = f.gateSend();
  const oldSending = f.runtime.message(f.project.id, f.node.id, 'old delivery'); await flush();
  now = f.node.deadlineAt + 1; await f.runtime.tick(); const count = f.commits.length;
  const newSending = f.runtime.retry(f.project.id, f.node.id); await flush();
  try {
    await inboxClaim(f, f.sends[0].messageId, 4); await endOnly(f, 4);
    assert.equal(f.node.status, 'running'); assert.equal(f.commits.length, count);
    await inboxClaim(f, f.sends[1].messageId, 5); await endOnly(f, 5); assert.equal(f.node.status, 'running');
    gate.resolve(); await oldSending; await newSending;
    assert.equal(f.node.status, 'completed'); assert.equal(f.commits.length, count + 1);
  } finally { gate.resolve(); await Promise.allSettled([oldSending, newSending]); }
});
await test('old Session end cached before receipt and claim cannot complete equal turn on replacement Session', async () => {
  const f = fixture({ status: 'completed' }); const gate = f.gateSend();
  const sending = f.runtime.message(f.project.id, f.node.id, 'session identity ordering'); await flush();
  try {
    await endOnly(f, 9, 'completed', f.node.sessionId, { id: f.node.sessionId });
    await inboxClaim(f, f.sends[0].messageId, 9); gate.resolve(); await sending; assert.equal(f.node.status, 'running');
    await endOnly(f, 9); assert.equal(f.node.status, 'completed');
  } finally { gate.resolve(); await sending.catch(() => {}); }
});
await test('empty receipt and nonnumeric claimed/end turns are fail-safe and remain cancellable', async () => {
  const f = fixture({ status: 'completed' }, { receipt: '' }); await f.runtime.message(f.project.id, f.node.id, 'empty receipt');
  await inboxClaim(f, f.sends[0].messageId, 2); await endOnly(f, 2); assert.equal(f.node.status, 'running');
  await f.runtime.cancel(f.project.id, f.node.id);
  const g = fixture({ status: 'completed' }); await g.runtime.message(g.project.id, g.node.id, 'invalid turn');
  for (const turn of [undefined, null, NaN, '2']) { await inboxClaim(g, g.sends[0].messageId, turn); await endOnly(g, turn); }
  assert.equal(g.node.status, 'running'); await g.runtime.cancel(g.project.id, g.node.id); assert.equal(g.node.status, 'cancelled');
});


for (const kind of ['experiment', 'merge']) {
  await test('late ' + kind + ' activation cannot cancel or sandbox-seed replacement attempt', async () => {
    const f = fixture({ kind, parentIds: [] }); const oldGate = f.gateActivation();
    const oldStart = f.runtime.start(f.project.id, f.node.id); const oldRejected = assert.rejects(oldStart, code('node_not_startable'));
    await flush(); const oldSession = f.node.sessionId; await f.runtime.cancel(f.project.id, f.node.id);
    f.gateActivation().resolve(); await f.runtime.retry(f.project.id, f.node.id); const newSession = f.node.sessionId;
    assert.notEqual(newSession, oldSession); assert.equal(f.node.status, 'running');
    const sandboxCount = f.sandboxEvents.filter((event) => event.sessionId === newSession).length;
    oldGate.resolve(); await oldRejected;
    assert.deepEqual({ cancelledNew: f.cancellations.includes(newSession), seededNewAgain: f.sandboxEvents.filter((event) => event.sessionId === newSession).length !== sandboxCount }, { cancelledNew: false, seededNewAgain: false });
    assert.equal(f.activations[0].activation.disposeCount, 1); assert.equal(f.activations[1].activation.disposeCount, 0);
    assert.equal(f.node.sessionId, newSession); assert.equal(f.node.status, 'running');
  });
}
await test('external execution_started persistence returning after cancellation cannot launch a driver', async () => {
  const f = fixture({ execution: { profile: 'codex', driver: 'codex' } }); const ensure = f.gateEnsure();
  const starting = f.runtime.start(f.project.id, f.node.id); const rejected = assert.rejects(starting, code('node_not_startable'));
  await flush(); const save = f.gateSave(); ensure.resolve(); await flush();
  assert.equal(f.node.executionRun.status, 'running'); assert.equal(f.externalRuns.length, 0);
  const cancellation = f.runtime.cancel(f.project.id, f.node.id); await flush();
  save.resolve(); await rejected; await cancellation;
  assert.equal(f.externalRuns.length, 0); assert.equal(f.node.status, 'cancelled'); assert.equal(f.node.executionRun.status, 'cancelled');
});


await test('failed timebox compensation preserves another node completion revision and event sequence', async () => {
  const f = fixture(); const b = f.add('node-b'); await f.runtime.start(f.project.id, f.node.id); await f.runtime.start(f.project.id, b.id);
  const commit = f.gateCommit(); f.activations[1].resolve(completed('B')); await flush();
  const save = f.gateSave(f.node.id); f.failNext('saveNode', false, f.node.id);
  const beforeBudget = f.node.timeboxMs; const edit = f.runtime.updateTimebox(f.project.id, f.node.id, 15 * minute);
  const rejected = assert.rejects(edit, /storage saveNode failed/); await flush();
  commit.resolve(); await flush(); assert.equal(b.status, 'completed');
  const published = { revision: f.project.revision, eventSeq: f.project.counters.eventSeq };
  assert.equal(f.events.findLast((event) => event.nodeId === b.id).seq, published.eventSeq);
  save.resolve(); await rejected;
  assert.equal(f.node.timeboxMs, beforeBudget); assert.equal(b.status, 'completed');
  assert.deepEqual({ revision: f.project.revision, eventSeq: f.project.counters.eventSeq }, published);
  assert.deepEqual({ revision: f.diskProjects.get(f.project.id).revision, eventSeq: f.diskProjects.get(f.project.id).counters.eventSeq }, published);
  assert.equal(f.events.some((event) => event.type === 'node/timebox_changed'), false);
  const c = f.add('node-c'); await f.runtime.start(f.project.id, c.id);
  assert.ok(f.events.at(-1).seq > published.eventSeq); assert.equal(new Set(f.events.map((event) => event.seq)).size, f.events.length);
});


await test('failed timebox compensation cannot replace a newer project object with its stale reference', async () => {
  const f = fixture(); await f.runtime.start(f.project.id, f.node.id); const save = f.gateSave(f.node.id);
  f.failNext('saveNode', false, f.node.id); const edit = f.runtime.updateTimebox(f.project.id, f.node.id, 15 * minute);
  const rejected = assert.rejects(edit, /storage saveNode failed/); await flush();
  const replacement = f.replaceProject({ revision: 20, updatedAt: now + 1, counters: { eventSeq: 20, concurrent: 7 }, usage: { costUsd: 9 }, concurrentField: 'preserve' });
  save.resolve(); await rejected;
  assert.equal(f.store.getProject(f.project.id), replacement);
  assert.deepEqual(f.diskProjects.get(f.project.id), replacement); assert.equal(replacement.revision, 20); assert.equal(replacement.counters.eventSeq, 20);
  assert.equal(replacement.concurrentField, 'preserve'); assert.equal(f.node.timeboxMs, 10 * minute);
});


await test('project replacement during node compensation await survives failure cleanup', async () => {
  const f = fixture(); await f.runtime.start(f.project.id, f.node.id);
  const compensating = deferred(), release = deferred(); const saveNode = f.store.saveNode; let calls = 0;
  f.store.saveNode = async (...args) => { if (++calls === 2) { compensating.resolve(); await release.promise; } return saveNode(...args); };
  f.failNext('saveNode', false, f.node.id);
  const edit = f.runtime.updateTimebox(f.project.id, f.node.id, 15 * minute);
  const rejected = assert.rejects(edit, /storage saveNode failed/);
  try {
    await compensating.promise;
    const replacement = f.replaceProject({ revision: 30, updatedAt: now + 2, counters: { eventSeq: 30, concurrent: 8 }, usage: { costUsd: 11 }, concurrentField: 'during-compensation' });
    release.resolve(); await rejected;
    assert.equal(f.store.getProject(f.project.id), replacement); assert.deepEqual(f.diskProjects.get(f.project.id), replacement);
    assert.equal(replacement.revision, 30); assert.equal(replacement.counters.eventSeq, 30); assert.equal(replacement.counters.concurrent, 8);
    assert.equal(replacement.usage.costUsd, 11); assert.equal(replacement.concurrentField, 'during-compensation');
    assert.equal(f.node.timeboxMs, 10 * minute);
  } finally { release.resolve(); await edit.catch(() => {}); }
});
await test('timebox save failure rolls back only its fields and preserves a concurrent lease renewal', async () => {
  const renewalResult = { status: 'renewed', lease: { expiresAt: now + 20 * minute, renewedAt: now + 1 } };
  const f = fixture({ needs: { gpu: 1 } }, { cluster: true, renewalResult }); await f.runtime.start(f.project.id, f.node.id);
  const lease = f.node.lease; const before = { timeboxMs: f.node.timeboxMs, deadlineAt: f.node.deadlineAt };
  const save = f.gateSave(f.node.id); f.failNext('saveNode', false, f.node.id);
  const edit = f.runtime.updateTimebox(f.project.id, f.node.id, 15 * minute); const rejected = assert.rejects(edit, /storage saveNode failed/);
  try {
    await flush(); await f.runtime.tick(); assert.equal(f.renewals.length, 1);
    assert.equal(f.node.lease, lease); assert.equal(lease.expiresAt, renewalResult.lease.expiresAt); assert.equal(lease.renewedAt, renewalResult.lease.renewedAt);
    f.node.concurrentField = 'preserve-node-field'; save.resolve(); await rejected;
    assert.deepEqual({ timeboxMs: f.node.timeboxMs, deadlineAt: f.node.deadlineAt }, before);
    assert.equal(f.node.lease, lease); assert.equal(f.node.concurrentField, 'preserve-node-field');
    assert.deepEqual(f.diskNodes.get(f.node.id).lease, lease); assert.equal(f.diskNodes.get(f.node.id).concurrentField, 'preserve-node-field');
    assert.equal(f.runtime.decorateNodes(f.project.id, [f.node])[0].deadlineAt, before.deadlineAt);
  } finally { save.resolve(); await edit.catch(() => {}); }
});


await test('queued replacement not yet visible in Map cannot be overwritten by a failure compensation put', async () => {
  const f = fixture(); await f.runtime.start(f.project.id, f.node.id);
  const saveProject = f.store.saveProject, releaseProject = deferred(), puts = []; let queue = Promise.resolve();
  f.store.saveProject = (value) => {
    puts.push(value);
    const write = queue.then(async () => { await releaseProject.promise; return saveProject(value); });
    queue = write.catch(() => {}); return write;
  };
  const save = f.gateSave(f.node.id); f.failNext('saveNode', false, f.node.id);
  const edit = f.runtime.updateTimebox(f.project.id, f.node.id, 15 * minute); const rejected = assert.rejects(edit, /storage saveNode failed/);
  await flush();
  const current = f.store.getProject(f.project.id);
  const replacement = { ...clone(current), revision: 40, counters: { eventSeq: 40, queued: 9 }, usage: { costUsd: 13 }, concurrentField: 'queued-replacement' };
  const replacing = f.store.saveProject(replacement);
  try {
    await flush(); assert.equal(f.store.getProject(f.project.id), current); assert.notEqual(current, replacement);
    save.resolve(); await flush(); releaseProject.resolve(); await replacing; await rejected;
    assert.deepEqual({ puts: puts.length, retainedReplacement: f.store.getProject(f.project.id) === replacement }, { puts: 1, retainedReplacement: true });
    assert.deepEqual(f.diskProjects.get(f.project.id), replacement); assert.equal(replacement.revision, 40); assert.equal(replacement.counters.eventSeq, 40);
    assert.equal(replacement.counters.queued, 9); assert.equal(replacement.usage.costUsd, 13); assert.equal(replacement.concurrentField, 'queued-replacement');
    assert.equal(f.node.timeboxMs, 10 * minute); assert.equal(f.events.some((event) => event.type === 'node/timebox_changed'), false);
  } finally { save.resolve(); releaseProject.resolve(); await Promise.allSettled([edit, replacing]); }
});

Date.now = realNow;
for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}${result.error ? '\n' + result.error : ''}`);
const failed = results.filter((item) => !item.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed (${results.length} checks)`);
process.exitCode = failed ? 1 : 0;
