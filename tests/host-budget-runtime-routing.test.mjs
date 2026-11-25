import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRuntime } from '../host/runtime.js';
import { applyMutation, createWorkingSet, DEFAULT_TRANSITIONS } from '../host/kernel/mutations.js';
const clone = structuredClone;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function freeze(v) { if (v && typeof v === 'object') { for (const x of Object.values(v)) freeze(x); Object.freeze(v); } return v; }
function fixture(opts = {}) {
  let n = freeze({ id: 'n', projectId: 'p', rev: 1, status: 'planned', currentAttempt: 0, sessionId: 'child-0', anchorSessionId: 'anchor-0', title: 'inert', prompt: 'inert', execution: { driver: 'dsh' }, git: { worktreePath: '/inert/host-budget-n', branch: 'b', baseCommit: 'base' }, needs: { gpu: 1 }, timeboxMs: 60000, ...opts.node });
  let p = freeze({ id: 'p', revision: 1, brief: 'inert', config: { maxRunningNodes: 4, resourcePools: { gpu: 8 }, nodeTimeoutMinutes: 1, routing: opts.routing ?? {} } });
  const calls = [], commits = [], signals = new Map(), als = new AsyncLocalStorage(); let tail = Promise.resolve(), permit = false, rt;
  const raw = { leaseId: 'raw-1', broker: 'local-soft', projectId: 'p', nodeId: 'n', grantedAt: 1, hardEndAt: Date.now() + 60000, marker: { unchanged: true } };
  const signal = name => { if (!signals.has(name)) signals.set(name, deferred()); return signals.get(name); };
  const emit = name => { calls.push(name); signal(name).resolve(); };
  const store = { getProject: () => p, getNode: () => n, listProjects: () => [p], listNodes: () => [n], childrenOf: () => [], isProjectLocked: id => als.getStore() === id,
    async withProjectLock(id, fn) { const prior = tail; let done; tail = new Promise(r => { done = r; }); await prior; try { return await als.run(id, fn); } finally { done(); } },
    async withWritePermit(fn) { permit = true; try { return await fn(); } finally { permit = false; } }, saveNode() { throw Error('direct writer forbidden'); } };
  const kernel = { executor: { async commitLocked(id, spec) {
    assert.equal(als.getStore(), id); assert.equal(permit, true); assert.equal(spec.expectedProjectRevision, p.revision);
    if (opts.rejectCommit?.(spec)) return { ok: false, code: 'stale_basis', message: 'inert rejected commit' };
    commits.push(clone(spec)); const ws = createWorkingSet(p, id => id === n.id ? n : undefined);
    for (const m of spec.mutations) { assert.equal(m.nodeId, n.id); assert.equal(spec.basis, n.rev); applyMutation(ws, m, { actor: { kind: 'system', id: 'fixture' }, now: Date.now(), transitions: DEFAULT_TRANSITIONS }); }
    n = freeze({ ...clone(ws.peekNode(n.id)), rev: p.revision + 1 }); p = freeze({ ...p, revision: p.revision + 1 });
    for (const m of spec.mutations) emit(m.eventType ?? m.op); if (opts.afterCommit) await opts.afterCommit(f, spec); return { ok: true, revision: p.revision };
  } } };
  kernel.executor.commit = (id, spec) => store.withProjectLock(id, () => store.withWritePermit(() => kernel.executor.commitLocked(id, { ...spec, expectedProjectRevision: p.revision, basis: n.rev })));
  const result = deferred(), activation = { result: result.promise, async dispose() { emit('dispose'); if (opts.dispose) await opts.dispose(f); } };
  const ctx = { agentDefaultModel: { currentSelection() { emit('model'); opts.model?.(f); return { provider: 'fake', model: 'inert' }; } }, llm: {}, get: () => null,
    agents: { get: () => undefined, async create() { emit('anchor'); if (opts.anchor) await opts.anchor(f); return { agent: {}, async dispose() { emit('anchor.dispose'); } }; }, async resume() { throw Error('unexpected resume'); } },
    subagents: { async startActivation() { emit('agent'); if (opts.agent) return opts.agent(f); return activation; }, async sendMessage() { emit('message'); if (opts.message) await opts.message(f); } }, sessionQuery: { async readSurface() { emit('usage'); if (opts.usage) await opts.usage(f); return { events: [] }; } } };
  const git = { async ensureWorktree() { emit('worktree'); if (opts.worktree) await opts.worktree(f); }, async branchOf() { emit('branch'); return opts.branch ?? 'b'; }, async commitWorktree() { emit('commit'); if (opts.commit) await opts.commit(f); return { head: 'head', committed: true }; } };
  const cluster = { enabled: true, placementMode: 'local', getStatus: () => ({ devices: [{}] }), async acquire() { emit('cluster.acquire'); return { status: 'granted', lease: { ...raw } }; }, async release() { emit('cluster.release'); }, async renew() { emit('cluster.renew'); return { status: 'renewed', lease: raw }; } };
  const admission = {
    async request(pid, nid, options) { emit('request'); return opts.request ? opts.request(f, options) : { routed: true, startOutcome: { status: 'held' } }; },
    async verify(project, node, lease, decisionId) { emit('verify'); assert.deepEqual(lease, raw); return opts.verify ? opts.verify(f) : decisionId === 'd1' && node.claim?.decisionId === 'd1'; },
    async beforeEffects(pid, nid, lease) { emit('beforeEffects'); assert.deepEqual(lease, raw); assert.equal(n.status, 'running'); assert.equal(n.currentAttempt, 1); assert.ok(n.claim); assert.ok(n.hostBudgetReservation); return opts.beforeEffects ? opts.beforeEffects(f) : { ok: true }; },
    async release(pid, nid, lease) { emit('release'); assert.deepEqual(lease, raw); assert.ok(n.resourcesHeld); return opts.release ? opts.release(f) : { released: true }; },
    async finalize() { emit('finalize'); assert.ok(['completed', 'failed', 'cancelled'].includes(n.status)); for (const k of ['claim', 'admission', 'lease', 'resourcesHeld']) assert.equal(n[k], undefined); assert.equal(n.hostBudgetCleanup.verifiedClean, true); return opts.finalize ? opts.finalize(f) : { released: true }; },
  };
  const f = { calls, commits, store, kernel, raw, result, admission, get runtime() { return rt; }, get node() { return n; }, wait: name => signal(name).promise,
    replace(patch) { n = freeze({ ...clone(n), ...clone(patch), rev: p.revision + 1 }); p = freeze({ ...p, revision: p.revision + 1 }); },
    async grant() { f.replace({ claim: { decisionId: 'd1', broker: raw.broker, leaseId: raw.leaseId }, hostBudgetReservation: { id: 'budget-1', state: 'bound' } }); return rt.start('p', 'n', { lease: clone(raw), decisionId: 'd1' }); },
    async finish() { result.resolve({ stopReason: 'completed', structured: { summary: 'inert', success: true } }); },
  };
  rt = createRuntime({ ctx, store, kernel, git, cluster, ...(opts.legacy ? {} : { hostAdmission: admission }) }); return f;
}
test('manual request precedes model/cluster/Git/Agent', async () => { const f = fixture(); assert.equal((await f.runtime.start('p', 'n')).routed, true); assert.deepEqual(f.calls, ['request']); });
test('forged admission is rejected before effects', async () => { const f = fixture({ verify: () => false }); await assert.rejects(f.grant(), /admission|permit|budget|lease/i); assert.deepEqual(f.calls, ['verify']); });
test('admitted start does not reacquire; durable running -> beforeEffects -> Git', async () => { const f = fixture(), before = clone(f.raw); await f.grant(); assert.ok(!f.calls.includes('request')); assert.ok(!f.calls.includes('cluster.acquire')); assert.deepEqual(f.raw, before); assert.ok(f.calls.indexOf('node/started') < f.calls.indexOf('beforeEffects')); assert.ok(f.calls.indexOf('beforeEffects') < f.calls.indexOf('worktree')); await f.runtime.dispose(); });
test('cancel during beforeEffects fences late Git/Agent and stale write', async () => { const d = deferred(), f = fixture({ beforeEffects: () => d.promise }); const starting = f.grant(); await f.wait('beforeEffects'); await f.runtime.cancel('p', 'n'); const rev = f.node.rev; d.resolve({ ok: true }); await starting; assert.equal(f.node.status, 'cancelled'); assert.equal(f.node.rev, rev); assert.ok(!f.calls.includes('worktree')); assert.ok(!f.calls.includes('agent')); });
test('beforeEffects false retains uncertain owner', async () => { const f = fixture({ beforeEffects: () => ({ ok: false, held: true }) }); assert.equal((await f.grant()).startOutcome.status, 'held'); assert.ok(!f.calls.includes('worktree')); assert.ok(f.node.hostBudgetReservation); assert.ok(f.node.claim); assert.ok(f.node.resourcesHeld); assert.ok(!f.calls.includes('finalize')); });
for (const throws of [false, true]) test(`raw ${throws ? 'throw' : 'Unknown'} preserves resources/lease/claim`, async () => { const f = fixture({ release() { if (throws) throw Error('raw Unknown'); return { released: false, held: true }; } }); await f.grant(); await f.runtime.cancel('p', 'n'); assert.equal(f.node.status, 'cancelled'); for (const k of ['resourcesHeld', 'lease', 'claim', 'hostBudgetReservation']) assert.ok(f.node[k]); assert.notEqual(f.node.hostBudgetCleanup?.verifiedClean, true); assert.ok(!f.calls.includes('finalize')); });
test('raw ACK -> kernel cleanup -> finalize false keeps reservation', async () => { const f = fixture({ finalize: () => ({ released: false, held: true }) }); await f.grant(); await f.runtime.cancel('p', 'n'); assert.ok(f.calls.indexOf('release') < f.calls.indexOf('node/host_budget_cleaned')); assert.ok(f.calls.indexOf('node/host_budget_cleaned') < f.calls.indexOf('finalize')); assert.ok(f.node.hostBudgetReservation); assert.equal(f.node.hostBudgetCleanup.attempt, 1); assert.equal(f.node.hostBudgetCleanup.sessionId, f.node.sessionId); });
test('success finish finalizes only durable terminal clean', async () => { const f = fixture(); await f.grant(); await f.finish(); await f.wait('finalize'); assert.equal(f.node.status, 'completed'); assert.equal(f.node.report.success, true); assert.equal(f.node.resourcesHeld, undefined); await f.runtime.dispose(); });
for (const field of ['hostBudgetReservation', 'claim', 'lease', 'resourcesHeld', 'hostBudgetGate']) test(`retry cannot erase old ${field}`, async () => { const f = fixture({ node: { status: 'failed', currentAttempt: 1, [field]: { unresolved: true }, error: { stage: 'start', message: 'old' } } }); const before = clone(f.node); await assert.rejects(f.runtime.retry('p', 'n'), /held|budget|cleanup|unresolved/i); assert.deepEqual(f.node, before); assert.equal(f.calls.length, 0); });
test('clean retry goes through common request', async () => { const f = fixture({ node: { status: 'failed', error: { stage: 'run', message: 'old' }, timestamps: { startedAt: 1 } } }); assert.equal((await f.runtime.retry('p', 'n')).routed, true); assert.equal(f.node.status, 'planned'); assert.ok(f.calls.includes('request')); assert.ok(!f.calls.includes('agent')); });
test('pump uses common request, no legacy acquire/replay', async () => { const f = fixture({ node: { resourceWait: { requestId: 'wait-1', amount: 1 } } }); await f.runtime.pumpLeases(); assert.deepEqual(f.calls, ['request']); });
test('dispose awaits own activation and cleanup/finalize', async () => { const d = deferred(), f = fixture({ dispose: () => d.promise }); await f.grant(); let settled = false; const closing = f.runtime.dispose().then(() => { settled = true; }); await f.wait('dispose'); assert.equal(settled, false); d.resolve(); await closing; assert.ok(f.calls.includes('finalize')); assert.equal(f.node.status, 'cancelled'); });
test('new owner during raw release cannot be overwritten/finalized', async () => { const d = deferred(), f = fixture({ release: () => d.promise }); await f.grant(); const cancelling = f.runtime.cancel('p', 'n'); await f.wait('release'); f.replace({ currentAttempt: 2, sessionId: 'replacement', claim: { decisionId: 'other' }, lease: { leaseId: 'new' }, resourcesHeld: { gpu: 2 } }); const before = clone(f.node); d.resolve({ released: true }); await cancelling; assert.deepEqual(f.node, before); assert.ok(!f.calls.includes('finalize')); });

test('replacement after running commit is never adopted as original owner', async () => {
  let replacement; const f = fixture({ afterCommit(f, spec) { if (spec.mutations.some(m => m.eventType === 'node/started')) { f.replace({ currentAttempt: 2, sessionId: 'foreign', lease: { leaseId: 'foreign' } }); replacement = clone(f.node); } } });
  assert.equal((await f.grant()).startOutcome.status, 'held'); assert.deepEqual(f.node, replacement); assert.ok(!f.calls.includes('beforeEffects')); assert.ok(!f.calls.includes('worktree'));
});
test('beforeEffects exception creates durable local hold without effects', async () => {
  const f = fixture({ beforeEffects() { throw Error('uncertain marker'); } }); assert.equal((await f.grant()).startOutcome.status, 'held');
  assert.ok(f.node.hostBudgetGate); assert.ok(f.node.claim); assert.ok(!f.calls.includes('worktree')); await f.runtime.dispose();
});
test('cancel while model resolves does not release unstarted ownership or create handles', async () => {
  let once = false; const f = fixture({ model(f) { if (!once) { once = true; f.replace({ needs: { gpu: 2 } }); } } });
  const result = await f.grant(); assert.equal(result.startOutcome.status, 'held'); assert.ok(!f.calls.includes('worktree')); assert.ok(!f.calls.includes('release')); assert.equal(f.node.currentAttempt, 0);
});
for (const boundary of ['worktree', 'anchor', 'agent']) test(`cancel during ${boundary} reclaims only late own handle`, async () => {
  const d = deferred(); let disposed = 0;
  const f = fixture({ [boundary]: async () => { await d.promise; if (boundary === 'agent') return { result: new Promise(() => {}), async dispose() { disposed++; } }; } });
  const starting = f.grant(); await f.wait(boundary); await f.runtime.cancel('p', 'n'); const before = clone(f.node); d.resolve(); await starting;
  assert.deepEqual(f.node, before); assert.equal(f.node.status, 'cancelled'); if (boundary !== 'agent') assert.ok(!f.calls.includes('agent')); else assert.equal(disposed, 1);
  if (boundary === 'anchor') assert.equal(f.calls.filter(x => x === 'anchor.dispose').length, 1);
});
test('cleanup kernel rejection does not finalize or erase confirmed raw ownership', async () => {
  const f = fixture({ rejectCommit: spec => spec.mutations.some(m => m.eventType === 'node/cancelled') }); await f.grant();
  await f.runtime.cancel('p', 'n'); assert.ok(f.calls.includes('release')); assert.ok(f.node.lease); assert.ok(f.node.resourcesHeld); assert.ok(!f.calls.includes('finalize'));
});
test('false worker report is never promoted by successful cleanup', async () => {
  const f = fixture(); await f.grant(); f.result.resolve({ stopReason: 'completed', structured: { summary: 'failure', success: false } }); await f.wait('finalize'); assert.equal(f.node.report.success, false); await f.runtime.dispose();
});
test('wrong branch fails closed but still goes through cleanup', async () => {
  const f = fixture({ branch: 'foreign' }); await f.grant(); await f.finish(); await f.wait('finalize'); assert.equal(f.node.status, 'failed'); assert.equal(f.node.report, null); assert.ok(!f.calls.includes('commit')); await f.runtime.dispose();
});
test('cancel during finishing usage can terminate without waiting for usage', async () => {
  const d = deferred(), f = fixture({ usage: () => d.promise }); await f.grant(); await f.finish(); await f.wait('usage');
  let ended = false; const cancel = f.runtime.cancel('p', 'n').then(() => { ended = true; });
  try {
    // Bounded wall-clock wait: the commit path flushes through the kernel event
    // bus (tens of ms), so a fixed number of microtask ticks was machine-dependent.
    for (let i = 0; i < 200 && !ended; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(ended, true, 'cancel must not wait for the pending usage read');
    assert.equal(f.node.status, 'cancelled');
  } finally { d.resolve(); await cancel; await f.runtime.dispose(); }
});
test('rejected cancel preserves owner until ordinary completion', async () => {
  const f = fixture(); await f.grant(); const before = clone(f.node); await assert.rejects(f.runtime.cancel('p', 'n', { expectedRevision: 0 }), /revision/i); assert.deepEqual(f.node, before);
  await f.finish(); await f.wait('finalize'); assert.equal(f.node.status, 'completed'); await f.runtime.dispose();
});
test('live message verifies same raw permit without new admission or Agent', async () => {
  const f = fixture({ verify: () => true }); await f.grant(); const deadline = f.node.deadlineAt; await f.runtime.message('p', 'n', 'live instruction');
  assert.equal(f.calls.filter(x => x === 'agent').length, 1); assert.equal(f.calls.filter(x => x === 'beforeEffects').length, 1); assert.ok(f.calls.includes('message')); assert.ok(!f.calls.includes('request')); assert.equal(f.node.deadlineAt, deadline); await f.runtime.dispose();
});
test('terminal followup starts fresh common admission preserving instruction', async () => {
  const f = fixture({ node: { status: 'completed', prompt: 'original task' } }); assert.equal((await f.runtime.message('p', 'n', 'additional task')).routed, true);
  assert.match(f.node.prompt, /original task[\s\S]*additional task/); assert.ok(!f.calls.includes('agent'));
});
test('finalize exception does not reconstruct already released raw ownership', async () => {
  const f = fixture({ finalize() { throw Error('budget unavailable'); } }); await f.grant(); const result = await f.runtime.cancel('p', 'n'); assert.equal(result.startOutcome.status, 'held');
  assert.ok(f.node.hostBudgetReservation); assert.equal(f.node.lease, undefined); assert.equal(f.node.claim, undefined); assert.equal(f.node.hostBudgetCleanup.verifiedClean, true);
});
test('foreign owner after kernel clear is not finalized', async () => {
  let foreign; const f = fixture({ afterCommit(f, spec) { if (spec.mutations.some(m => m.eventType === 'node/host_budget_cleaned')) { f.replace({ currentAttempt: 2, sessionId: 'foreign', lease: { leaseId: 'foreign' }, resourcesHeld: { gpu: 2 } }); foreign = clone(f.node); } } });
  await f.grant(); await f.runtime.cancel('p', 'n'); assert.deepEqual(f.node, foreign); assert.ok(!f.calls.includes('finalize'));
});

test('targeted Kernel callback writes survive beforeEffects/release/finalize awaits', async () => {
  const f = fixture({
    async beforeEffects(f) {
      await f.kernel.executor.commit('p', { mutations: [{ op: 'node.update', nodeId: 'n', set: { hostBudgetReservation: { ...clone(f.node.hostBudgetReservation), effectStarted: true, boundAttempt: f.node.currentAttempt, boundSessionId: f.node.sessionId } } }] });
      return { ok: true };
    },
    async release(f) {
      assert.equal(f.node.hostBudgetReservation.effectStarted, true);
      assert.equal(f.node.hostBudgetReservation.boundSessionId, f.node.sessionId);
      await f.kernel.executor.commit('p', { mutations: [{ op: 'node.update', nodeId: 'n', set: { budgetReleaseMemo: 'fresh-release', hostBudgetReservation: { ...clone(f.node.hostBudgetReservation), rawReleased: true } } }] });
      return { released: true };
    },
    async finalize(f) {
      assert.equal(f.node.hostBudgetReservation.effectStarted, true);
      assert.equal(f.node.hostBudgetReservation.rawReleased, true);
      assert.equal(f.node.budgetReleaseMemo, 'fresh-release');
      await f.kernel.executor.commit('p', { mutations: [{ op: 'node.update', nodeId: 'n', unset: ['hostBudgetReservation'], set: { budgetFinalizeMemo: 'fresh-finalize' } }] });
      return { released: true };
    },
  });
  await f.grant(); assert.equal(f.node.hostBudgetReservation.effectStarted, true);
  const raw = clone(f.raw); await f.finish(); await f.wait('finalize'); await f.runtime.dispose();
  assert.equal(f.node.status, 'completed'); assert.equal(f.node.hostBudgetReservation, undefined);
  assert.equal(f.node.budgetReleaseMemo, 'fresh-release'); assert.equal(f.node.budgetFinalizeMemo, 'fresh-finalize'); assert.deepEqual(f.raw, raw);
});
test('watchdog terminates finishing usage at the original hard deadline', async t => {
  let now = 100000; t.mock.method(Date, 'now', () => now);
  const d = deferred(), f = fixture({ usage: () => d.promise }); await f.grant(); const deadline = f.node.deadlineAt;
  await f.finish(); await f.wait('usage'); now = deadline + 1;
  try { await f.runtime.tick(); assert.equal(f.node.status, 'failed'); assert.equal(f.node.error.stage, 'timeout'); assert.equal(f.node.report, null); }
  finally { d.resolve(); await f.runtime.dispose(); }
});
for (const watchdog of [false, true]) test(`last completion lock crossing deadline stays failed, watchdog=${watchdog}`, async t => {
  let now = 200000; t.mock.method(Date, 'now', () => now);
  const usage = deferred(), lock = deferred(), entered = deferred(), f = fixture({ usage: () => usage.promise });
  await f.grant(); const deadline = f.node.deadlineAt; await f.finish(); await f.wait('usage');
  const blocking = f.store.withProjectLock('p', async () => { entered.resolve(); await lock.promise; }); await entered.promise;
  usage.resolve(); for (let i = 0; i < 4; i++) await new Promise(setImmediate);
  now = deadline + 1; const ticking = watchdog ? f.runtime.tick() : Promise.resolve(); lock.resolve();
  await blocking; await ticking; await f.wait('finalize'); await f.runtime.dispose();
  assert.equal(f.node.status, 'failed'); assert.equal(f.node.report, null); assert.equal(f.node.error.stage, 'timeout');
});
test('autoUpgrade after durable clean uses common request before another model', async () => {
  const f = fixture({ routing: { autoUpgrade: true, maxAttempts: 2 }, async finalize(f) {
    await f.kernel.executor.commit('p', { mutations: [{ op: 'node.update', nodeId: 'n', unset: ['hostBudgetReservation'] }] }); return { released: true };
  } });
  await f.grant(); const modelCalls = f.calls.filter(x => x === 'model').length; f.result.resolve({ stopReason: 'error' }); await f.wait('request');
  assert.equal(f.node.status, 'planned'); assert.ok(f.calls.indexOf('finalize') < f.calls.indexOf('request'));
  assert.equal(f.calls.filter(x => x === 'model').length, modelCalls); assert.ok(!f.calls.includes('cluster.acquire')); await f.runtime.dispose();
});
test('autoUpgrade cannot erase a reservation held after finalize', async () => {
  const f = fixture({ routing: { autoUpgrade: true, maxAttempts: 2 }, finalize: () => ({ released: false, held: true }) });
  await f.grant(); f.result.resolve({ stopReason: 'error' }); await f.wait('finalize'); await f.runtime.dispose();
  assert.equal(f.node.status, 'failed'); assert.ok(f.node.hostBudgetReservation); assert.ok(!f.calls.includes('request'));
});
test('explicit escalation carries upgrade intent through common request', async () => {
  let requested; const f = fixture({ node: { status: 'failed' }, request(f, options) { requested = options; return { routed: true }; } });
  assert.equal((await f.runtime.escalate('p', 'n')).routed, true); assert.equal(requested.upgrade, true); assert.ok(!f.calls.includes('model'));
});


test('managed legacy preemption preserves beneficiary, appeal and causal event instead of silently becoming ordinary cancel',async()=>{
 const f=fixture();await f.grant();await f.runtime.preempt('p','n',{forNodeId:'p0-target',reason:'priority work',by:'dispatcher',causeId:'priority-cause'});
 assert.equal(f.node.status,'cancelled');assert.equal(f.node.preemption.forNodeId,'p0-target');assert.equal(f.node.preemption.appeal.status,'open');
 assert.equal(f.node.preemption.causeId,'priority-cause');assert.equal(f.node.termination.kind,'preempted');
 const commit=f.commits.find(c=>c.mutations.some(m=>m.eventType==='node/preempted'));assert.ok(commit);assert.equal(commit.causeId,'priority-cause');
 assert.equal(commit.mutations.find(m=>m.eventType==='node/preempted').eventData.preemption.forNodeId,'p0-target');
 assert.equal(f.node.claim,undefined);assert.equal(f.node.resourcesHeld,undefined);assert.ok(f.calls.includes('finalize'));await f.runtime.dispose();
});
test('actual runtime pump invokes common host-budget waiting admission even for sandbox nodes',async()=>{
 const f=fixture({node:{execution:{driver:'dsh',sandboxProfile:'pclab19'},resourceWait:{backend:'host-budget',retryAfter:0}}});let common=0;
 f.admission.pumpLeases=async()=>{common++;};await f.runtime.pumpLeases();assert.equal(common,1);assert.ok(!f.calls.includes('cluster.acquire'));
});
