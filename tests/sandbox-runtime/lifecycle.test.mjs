import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createSandboxRuntime } from '../../host/sandbox-runtime.js';
import { createBindingWriter } from '../../host/sandbox-binding.js';
import { applyMutation, createWorkingSet, DEFAULT_TRANSITIONS } from '../../host/kernel/mutations.js';
import { createExecutor } from '../../host/kernel/executor.js';
import { startOutcomeOf } from '../../host/dispatch/types.js';
import { createDispatchEnvelope } from '../../host/dispatch/envelope.js';
const clone = structuredClone;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(setImmediate); };
function fixture(opts = {}) {
  let time = 100000, n = { id: 'n', projectId: 'p', rev: 1, status: 'planned', currentAttempt: 0, execution: { driver: 'dsh', sandboxProfile: 'pclab19' }, needs: { gpu: 1 }, git: { branch: 'b', worktreePath: '/inert/n' }, timeboxMs: 60000, ...opts.node };
  const p = { id: 'p', revision: 1, config: {} }, calls = [], results = [], snapshots = [], commits = [], als = new AsyncLocalStorage(); let tail = Promise.resolve(), permit = false, gen = 0;
  const store = { getProject: () => p, getNode: () => n, listProjects: () => [p], listNodes: () => [n], isProjectLocked: id => als.getStore() === id,
    async withProjectLock(id, fn) { const old = tail; let release; tail = new Promise(r => { release = r; }); await old; try { return await als.run(id, fn); } finally { release(); } },
    async withWritePermit(fn) { permit = true; try { return await fn(); } finally { permit = false; } }, saveNode() { throw Error('direct write'); } };
  const kernel = { executor: { async commitLocked(id, spec) {
    assert.equal(als.getStore(), id); assert.equal(permit, true); assert.equal(spec.expectedProjectRevision, p.revision);
    snapshots.push(clone(n)); commits.push({ spec: clone(spec), node: clone(n), project: clone(p) });
    const ws = createWorkingSet(p, id => id === n.id ? n : undefined);
    for (const m of spec.mutations) applyMutation(ws, m, { actor: { kind: 'system', id: 'fixture' }, now: time, transitions: DEFAULT_TRANSITIONS, causeId: null });
    n = clone(ws.peekNode(n.id));
    n.rev = ++p.revision; if (opts.afterCommit) await opts.afterCommit(f, spec); return { ok: true, revision: p.revision };
  } } };
  const writer = createBindingWriter({ store, kernel });
  async function bind(patch, replace = false) { const b = { ...(replace ? {} : clone(n.sandbox ?? {})), backend: 'opensandbox', profile: 'pclab19', bindingId: replace ? 'b' + n.currentAttempt : n.sandbox.bindingId, attempt: n.currentAttempt, sessionId: n.sessionId, state: 'ready', verifiedClean: false, operations: {}, ...patch }; return writer({ expected: { projectId: 'p', nodeId: 'n', attempt: n.currentAttempt, sessionId: n.sessionId, profile: 'pclab19', bindingId: n.sandbox?.bindingId ?? null, nodeRev: n.rev }, binding: b }); }
  let rt;
  const admission = {
    async request(pid, nid, options) {
      calls.push('request');
      const lease = { leaseId: 'l' + ++gen, broker: 'sandbox-admission', projectId: pid, nodeId: nid, profile: 'pclab19', launchGeneration: 'g' + gen, forAttempt: (n.currentAttempt ?? 0) + 1, ...opts.lease };
      const decisionId = 'd' + gen;
      await store.withProjectLock(pid, () => store.withWritePermit(() => kernel.executor.commitLocked(pid, { expectedProjectRevision: p.revision, mutations: [{ op: 'node.claim', nodeId: nid, claim: { leaseId: lease.leaseId, decisionId } }, { op: 'node.update', nodeId: nid, set: { admission: clone(lease) } }] })));
      const result = await rt.start(pid, nid, { ...options, lease, decisionId });
      if (result.startOutcome.status === 'queued') {
        assert.equal(n.admission.leaseId, lease.leaseId, 'runtime must leave admission to envelope');
        assert.equal(n.claim.decisionId, decisionId, 'runtime must leave claim to envelope');
        assert.equal(n.sandbox.verifiedClean, true);
        assert.equal(n.resourcesHeld, undefined);
        assert.equal((await admission.release(pid, lease)).released, true);
        await store.withProjectLock(pid, () => store.withWritePermit(() => kernel.executor.commitLocked(pid, { expectedProjectRevision: p.revision, mutations: [{ op: 'node.releaseClaim', nodeId: nid, decisionId }, { op: 'node.update', nodeId: nid, unset: ['admission'] }] })));
      }
      return result;
    },
    async verify(p, node, l) { return l.leaseId?.startsWith('l') && l.forAttempt === node.currentAttempt + 1 && assert.deepEqual(node.admission, l) === undefined; },
    async release() { calls.push('admission.release'); if (opts.admissionRelease) return opts.admissionRelease(f); return { released: true }; },
  };
  const backend = { isSandbox: n => !!n.execution?.sandboxProfile, async preflight() { calls.push('preflight'); if (typeof opts.preflight === 'function') return opts.preflight(f); return opts.preflight ?? { ready: true, blockers: [] }; }, async prepare(p, n, options) { calls.push('prepare'); assert.equal(f.node.status, 'running'); assert.equal(f.node.admission.forAttempt, n.currentAttempt); await bind({ state: 'preparing' }, true); if (opts.prepare) return opts.prepare(f, options); return { status: 'ready', binding: await bind({ state: 'ready' }), prompt: 'remote only' }; }, async collect() { calls.push('collect'); if (opts.collect) return opts.collect(f); return { files: [], totalBytes: 0, truncated: false }; }, async release() { calls.push('release'); if (opts.release) return opts.release(f); return { verifiedClean: true, binding: await bind({ state: 'released', verifiedClean: true, cancelRequested: false, operations: clone(n.sandbox.operations) }) }; }, async heartbeat() { calls.push('heartbeat'); if (opts.heartbeat) return opts.heartbeat(f); return { live: true }; } };
  const worker = { async select() { calls.push('select'); if (opts.invalidModel) throw Error('invalid model'); if (opts.select) return opts.select(f); return { provider: 'fake', model: 'inert' }; }, options: s => s, schema: { type: 'object' }, normalize: r => r?.summary ? r : null, async anchor() { calls.push('anchor'); if (opts.anchor) return opts.anchor(f); return {}; }, async releaseAnchor() { calls.push('anchor.release'); }, async usage() { if (opts.usage) return opts.usage(f); return { totalTokens: 1 }; } };
  const git = { async ensureWorktree() { calls.push('worktree'); return { worktreePath: '/inert/n' }; }, async branchOf() { if (opts.branchOf) return opts.branchOf(f); return 'b'; }, async commitWorktree() { calls.push('commit'); return { head: 'head', committed: true }; } };
  const ctx = { subagents: { async startActivation(args) { calls.push('agent'); assert.equal(args.request.agentPreset, 'lab-sandbox-worker-v2'); assert.ok(!JSON.stringify(args).includes('danger-full-access')); if (opts.activationError) throw Error('activation failed'); if (opts.activation) return opts.activation(f, args); const d = deferred(); results.push(d); return { result: d.promise, async dispose() { calls.push('dispose'); } }; } } };
  const f = { store, kernel, calls, results, bind, snapshots, commits, get node() { return n; }, set node(value) { n = value; }, get runtime() { return rt; }, advance(ms) { time += ms; }, get now() { return time; }, async finish(success = true, stopReason = 'completed') { results.at(-1).resolve({ stopReason, structured: { summary: 'fake', success } }); await flush(); } };
  if (opts.beforeEffects) admission.beforeEffects = async (...args) => { calls.push('admission.beforeEffects'); return opts.beforeEffects(f, ...args); };
  if (opts.finalize) admission.finalize = async (...args) => { calls.push('admission.finalize'); return opts.finalize(f, ...args); };
  rt = createSandboxRuntime({ ctx, store, kernel, git, backend, admission, worker, clock: () => time }); return f;
}
function envelopeFor(f) {
  const lease = { leaseId: 'l-envelope', broker: 'sandbox-admission', projectId: 'p', nodeId: 'n', profile: 'pclab19', forAttempt: f.node.currentAttempt + 1, launchGeneration: 'g-envelope' };
  const broker = { id: 'sandbox-admission', async verify(value) { return value.leaseId === lease.leaseId; }, async release() { f.calls.push('envelope.release'); assert.equal(f.node.sandbox.verifiedClean, true); return { released: true }; } };
  const executor = { commit: (id, spec) => f.store.withProjectLock(id, () => f.store.withWritePermit(() => f.kernel.executor.commitLocked(id, { ...spec, expectedProjectRevision: f.store.getProject(id).revision }))) };
  const envelope = createDispatchEnvelope({ projectId: 'p', executor, projection: { getNode: () => clone(f.node), revision: () => f.store.getProject('p').revision, listNodes: () => [clone(f.node)] }, brokers: new Map([[broker.id, broker]]), launcher: f.runtime, clock: () => f.now });
  return () => envelope.submit({ kind: 'system', id: 'joint-test' }, { kind: 'start', nodeId: 'n', lease, basis: f.node.rev, reason: 'inert joint lifecycle contract' });
}
test('ready chain: durable attempt before remote, persona-only worker, collect/Host commit/clean release', async () => { const f = fixture(), initial = clone(f.node), r = await f.runtime.start('p', 'n'); assert.equal(r.startOutcome.status, 'started'); assert.deepEqual(f.snapshots[0], initial); assert.ok(f.calls.indexOf('preflight') < f.calls.indexOf('worktree')); assert.ok(f.calls.indexOf('prepare') < f.calls.indexOf('anchor')); await f.finish(false); assert.equal(f.node.status, 'completed'); assert.equal(f.node.report.success, false); assert.equal(f.node.git.headCommit, 'head'); assert.equal(f.node.admission, undefined); assert.equal(f.node.resourcesHeld, undefined); assert.equal(f.node.deadlineAt, null); assert.ok(f.node.attempts[0].endedAt); });
test('2 clean NO_CAPACITY -> ready pump new IDs without cluster/auto/Agent on queues', async () => { let count = 0; const f = fixture({ async prepare(f) { if (++count <= 2) return { status: 'queued', binding: await f.bind({ state: 'released', verifiedClean: true }) }; return { status: 'ready', binding: await f.bind({ state: 'ready' }), prompt: 'ready' }; } }); const r = await f.runtime.start('p', 'n'); assert.equal(r.startOutcome.status, 'queued'); assert.equal(r.startOutcome.code, 'NO_CAPACITY'); assert.equal(r.startOutcome.verifiedClean, true); assert.equal(f.node.resourceWait.retryAfter, f.now + 5000); const ids = [f.node.sessionId]; assert.ok(!f.calls.includes('agent')); assert.ok(!f.calls.includes('anchor')); await f.runtime.pumpLeases(); assert.equal(count, 1); for (let i = 0; i < 2; i++) { f.advance(5000); await f.runtime.pumpLeases(); ids.push(f.node.sessionId); } assert.equal(count, 3); assert.equal(new Set(ids).size, 3); assert.equal(f.node.currentAttempt, 3); assert.equal(f.node.attempts.filter(a => a.endedAt).length, 2); await f.runtime.dispose(); });
test('STOP gate is local only, no fake binding or Git/Agent, no auto retry', async () => { const f = fixture({ preflight: { ready: false, blockers: ['STOP', 'Unknown'] } }); const r = await f.runtime.start('p', 'n'); assert.equal(r.startOutcome.status, 'held'); assert.equal(r.startOutcome.retryable, false); assert.equal(f.node.sandbox, undefined); assert.equal(f.node.sandboxGate.retryable, false); assert.ok(f.node.admission); assert.ok(!f.calls.includes('worktree')); await f.runtime.pumpLeases(); assert.equal(f.calls.filter(c => c === 'request').length, 1); });
test('invalid model and forged prospective admission never create physical resources', async () => { const f = fixture({ invalidModel: true }); assert.equal((await f.runtime.start('p', 'n')).startOutcome.status, 'held'); assert.ok(!f.calls.includes('prepare')); const bad = fixture(); await assert.rejects(bad.runtime.start('p', 'n', { lease: { leaseId: 'forged', forAttempt: 7 } })); });
test('prepare Unknown remains held and never replays', async () => { const f = fixture({ async prepare(f) { await f.bind({ state: 'unknown', operations: { a: { state: 'unknown', requestHash: 'h' } } }); throw Error('Unknown'); } }); assert.equal((await f.runtime.start('p', 'n')).startOutcome.status, 'held'); assert.ok(f.node.admission); assert.ok(f.node.resourcesHeld); assert.ok(f.node.attempts[0].endedAt); f.advance(6000); await f.runtime.pumpLeases(); assert.equal(f.calls.filter(c => c === 'prepare').length, 1); });
test('cancel during prepare fences late ready and standard releases without resurrection', async () => { const d = deferred(), f = fixture({ async prepare(f) { await d.promise; return { status: 'ready', binding: clone(f.node.sandbox), prompt: 'late' }; } }); const starting = f.runtime.start('p', 'n'); await flush(); await f.runtime.terminate('p', 'n', 'cancel'); d.resolve(); assert.equal((await starting).startOutcome.status, 'held'); assert.equal(f.node.status, 'cancelled'); assert.ok(!f.calls.includes('agent')); assert.equal(f.node.sandbox.verifiedClean, true); assert.equal(f.node.admission, undefined); });
test('stale finish cannot collect/release/overwrite replacement attempt', async () => { const f = fixture(); await f.runtime.start('p', 'n'); f.node = { ...clone(f.node), currentAttempt: 2, sessionId: 'new', admission: { ...f.node.admission, launchGeneration: 'new' } }; const before = clone(f.node); await f.finish(); assert.deepEqual(f.node, before); assert.ok(!f.calls.includes('collect')); assert.ok(!f.calls.includes('release')); });
test('fresh read preserves concurrent unrelated update during collect', async () => { const d = deferred(), f = fixture({ collect: () => d.promise }); await f.runtime.start('p', 'n'); f.results[0].resolve({ stopReason: 'completed', structured: { summary: 'fake', success: true } }); await flush(); f.node = { ...clone(f.node), unrelated: 'keep', rev: ++f.store.getProject('p').revision }; d.resolve({ files: [], truncated: false }); await flush(); assert.equal(f.node.status, 'completed'); assert.equal(f.node.unrelated, 'keep'); });
test('noncompleted stop fails despite success report, no local reaper', async () => { const f = fixture(); await f.runtime.start('p', 'n'); await f.finish(true, 'failed'); assert.equal(f.node.status, 'failed'); assert.equal(f.node.sandbox.verifiedClean, true); });
test('202 cleanup Pending keeps admission/resources/deadline and no ordinary backoff', async () => { const f = fixture({ release: () => ({ verifiedClean: false, status: 202 }) }); await f.runtime.start('p', 'n'); const deadline = f.node.deadlineAt; await f.finish(); assert.ok(f.node.admission); assert.ok(f.node.resourcesHeld); assert.equal(f.node.deadlineAt, deadline); assert.equal(f.node.resourceWait, undefined); });
test('physical clean execUnknown keeps logical admission and immutable operations', async () => { const f = fixture(); await f.runtime.start('p', 'n'); await f.bind({ operations: { exec: { state: 'unknown', requestHash: 'h' } } }); await f.finish(); assert.equal(f.node.sandbox.verifiedClean, true); assert.equal(f.node.sandbox.operations.exec.state, 'unknown'); assert.ok(f.node.admission); assert.ok(f.node.resourcesHeld); });
test('heartbeat never renews deadline; timeout uses remote cleanup', async () => { const f = fixture(); await f.runtime.start('p', 'n'); const deadline = f.node.deadlineAt; await f.runtime.tick(); assert.ok(f.calls.includes('heartbeat')); assert.equal(f.node.deadlineAt, deadline); f.advance(60001); await f.runtime.tick(); assert.equal(f.node.status, 'failed'); assert.equal(f.node.termination.kind, 'timeout'); assert.equal(f.node.sandbox.verifiedClean, true); });
test('activation creation failure closes attempt and standard releases', async () => { const f = fixture({ activationError: true }); assert.equal((await f.runtime.start('p', 'n')).startOutcome.status, 'held'); assert.equal(f.node.status, 'failed'); assert.ok(f.node.attempts[0].endedAt); assert.equal(f.node.sandbox.verifiedClean, true); });
test('late anchor after cancel is released, cannot create an Agent', async () => {
  const d = deferred(), f = fixture({ anchor: () => d.promise });
  const starting = f.runtime.start('p', 'n'); await flush();
  await f.runtime.terminate('p', 'n', 'cancel'); d.resolve({});
  assert.equal((await starting).startOutcome.status, 'held');
  assert.equal(f.calls.filter(c => c === 'anchor.release').length, 1);
  assert.ok(!f.calls.includes('agent'));
});
test('late activation after cancel is disposed, cannot leak its own child', async () => {
  const d = deferred(), result = deferred(); let disposed = 0;
  const f = fixture({ activation: () => d.promise });
  const starting = f.runtime.start('p', 'n'); await flush();
  await f.runtime.terminate('p', 'n', 'cancel');
  d.resolve({ result: result.promise, async dispose() { disposed++; } });
  assert.equal((await starting).startOutcome.status, 'held');
  assert.equal(disposed, 1); assert.equal(f.node.status, 'cancelled');
});
test('claim or resource demand change during model selection fences every physical effect', async () => {
  for (const field of ['claim', 'needs']) {
    const d = deferred(), f = fixture({ select: () => d.promise });
    const starting = f.runtime.start('p', 'n'); await flush();
    f.node = { ...clone(f.node), [field]: field === 'claim' ? { ...f.node.claim, decisionId: 'other' } : { gpu: 2 } };
    const before = clone(f.node); d.resolve({ provider: 'fake', model: 'inert' });
    await starting; assert.deepEqual(f.node, before);
    assert.ok(!f.calls.includes('worktree')); assert.ok(!f.calls.includes('prepare'));
  }
});
test('completed nonzero exec evidence cannot become report success', async () => {
  const f = fixture(); await f.runtime.start('p', 'n');
  await f.bind({ operations: { exec: { action: 'exec', state: 'completed', result: { exitCode: 7, success: false, truncated: false } } } });
  await f.finish(true);
  assert.equal(f.node.report.success, false); assert.equal(f.node.sandbox.verifiedClean, true);
});
test('long exec heartbeat skip is not liveness proof or termination, but fixed deadline still fires', async () => {
  const f = fixture({ heartbeat: () => ({ skipped: true, reason: 'operation_in_progress' }) });
  await f.runtime.start('p', 'n'); const deadline = f.node.deadlineAt;
  await f.runtime.tick(); await f.runtime.tick();
  assert.equal(f.calls.filter(c => c === 'heartbeat').length, 1);
  assert.equal(f.node.status, 'running'); assert.equal(f.node.deadlineAt, deadline);
  f.advance(60001); await f.runtime.tick(); assert.equal(f.node.termination.kind, 'timeout');
});
test('finish waits for an in-flight liveness status instead of failing the node as uncertain', async () => {
  const d = deferred();
  const f = fixture({ async heartbeat(f) {
    const op = { operationId: 's1', action: 'status', state: 'intent', requestHash: 'h', createdAt: f.now };
    await f.bind({ operations: { s1: op } });
    await d.promise;
    await f.bind({ operations: { s1: { ...op, state: 'completed', result: { ok: true } } } });
    return { live: true };
  } });
  await f.runtime.start('p', 'n');
  const ticking = f.runtime.tick();
  await flush();
  assert.equal(f.node.sandbox.operations.s1.state, 'intent');
  f.results.at(-1).resolve({ stopReason: 'completed', structured: { summary: 'fake', success: true } });
  await flush();
  d.resolve({ live: true });
  await ticking;
  await flush();
  assert.equal(f.node.status, 'completed');
  assert.equal(f.node.error, undefined);
  assert.equal(f.node.sandbox.verifiedClean, true);
});

test('release return is not cleanup proof unless the fresh durable same binding is clean', async () => {
  const f = fixture({ release: () => ({ verifiedClean: true, binding: { verifiedClean: true } }) });
  await f.runtime.start('p', 'n'); await f.finish();
  assert.equal(f.node.sandbox.verifiedClean, false); assert.ok(f.node.admission); assert.ok(f.node.claim);
  assert.ok(f.node.resourcesHeld); assert.ok(!f.calls.includes('admission.release'));
});
test('admission release held cannot erase claim/admission after physical cleanup', async () => {
  const f = fixture({ admissionRelease: () => ({ released: false, held: true }) });
  await f.runtime.start('p', 'n'); await f.finish();
  assert.equal(f.node.sandbox.verifiedClean, true); assert.ok(f.node.admission); assert.ok(f.node.claim);
  assert.equal(f.node.dispatchHold.reason, 'sandbox_held');
});
test('STOP is evaluated before model validation and no attempt or binding is created', async () => {
  const f = fixture({ invalidModel: true, preflight: { ready: false, blockers: ['STOP'] } });
  await f.runtime.start('p', 'n'); assert.ok(!f.calls.includes('select'));
  assert.equal(f.node.currentAttempt, 0); assert.equal(f.node.sandbox, undefined); assert.ok(f.node.admission);
});
test('fixed deadline still terminates a finish blocked in collection', async () => {
  const d = deferred(), f = fixture({ collect: () => d.promise });
  await f.runtime.start('p', 'n');
  f.results[0].resolve({ stopReason: 'completed', structured: { summary: 'fake', success: true } }); await flush();
  f.advance(60001); await f.runtime.tick();
  assert.equal(f.node.status, 'failed'); assert.equal(f.node.termination.kind, 'timeout');
  d.resolve({ files: [], truncated: false }); await flush();
  assert.equal(f.node.status, 'failed'); assert.ok(!f.calls.includes('commit'));
});
test('SDK structuredOutput alias is not accepted as a completed report', async () => {
  const f = fixture(); await f.runtime.start('p', 'n');
  f.results[0].resolve({ stopReason: 'completed', structuredOutput: { summary: 'wrong field', success: true } }); await flush();
  assert.equal(f.node.status, 'failed'); assert.ok(!f.calls.includes('collect'));
  assert.equal(f.node.sandbox.verifiedClean, true);
});
test('changed Host branch prevents commit and still uses standard remote release', async () => {
  const f = fixture({ branchOf: () => 'other' });
  await f.runtime.start('p', 'n'); await f.finish();
  assert.equal(f.node.status, 'failed'); assert.ok(!f.calls.includes('commit'));
  assert.equal(f.node.sandbox.verifiedClean, true);
});
test('new admission generation appearing during release acknowledgement is never cleared', async () => {
  const d = deferred(), f = fixture({ admissionRelease: () => d.promise });
  await f.runtime.start('p', 'n');
  f.results[0].resolve({ stopReason: 'completed', structured: { summary: 'fake', success: true } }); await flush();
  f.node = { ...clone(f.node), admission: { ...f.node.admission, launchGeneration: 'new' }, unrelated: 'keep' };
  const before = clone(f.node); d.resolve({ released: true }); await flush();
  assert.deepEqual(f.node, before);
});
test('revision-rejected cancel preserves its live handle and does not dispose the child', async () => {
  const f = fixture(); await f.runtime.start('p', 'n');
  await assert.rejects(f.runtime.terminate('p', 'n', 'cancel', { expectedRevision: -1 }));
  assert.equal(f.runtime.has('p', 'n'), true); assert.equal(f.node.status, 'running');
  assert.ok(!f.calls.includes('dispose')); await f.runtime.dispose();
});
test('dispose of a stale owner closes only its own handles, never releases the new binding', async () => {
  const f = fixture(); await f.runtime.start('p', 'n');
  f.node = { ...clone(f.node), currentAttempt: 2, sessionId: 'new', admission: { ...f.node.admission, launchGeneration: 'new' } };
  const before = clone(f.node); await f.runtime.dispose();
  assert.deepEqual(f.node, before); assert.equal(f.calls.filter(c => c === 'dispose').length, 1);
  assert.ok(!f.calls.includes('release'));
});
test('a finish waiting for the project lock cannot overwrite the preceding cancel commit', async () => {
  const usage = deferred(), block = deferred(), f = fixture({ usage: () => usage.promise });
  await f.runtime.start('p', 'n');
  f.results[0].resolve({ stopReason: 'completed', structured: { summary: 'fake', success: true } }); await flush();
  const locked = f.store.withProjectLock('p', () => block.promise); await flush();
  const cancelled = f.runtime.terminate('p', 'n', 'cancel'); await flush();
  usage.resolve({}); await flush(); block.resolve(); await locked; await cancelled; await flush();
  assert.equal(f.node.status, 'cancelled'); assert.equal(f.node.report, undefined);
});
test('logical deadline cannot extend the admission hard end after a delayed selection', async () => {
  const f = fixture({ lease: { hardEndAt: 150000 }, select(f) { f.advance(10000); return { provider: 'fake', model: 'inert' }; } });
  await f.runtime.start('p', 'n'); assert.equal(f.node.deadlineAt, 150000); await f.runtime.dispose();
});
test('thrown preflight becomes a local gate before model lookup without manufacturing a binding', async () => {
  const f = fixture({ preflight() { throw Object.assign(Error('STOP/Unknown'), { code: 'SANDBOX_PREFLIGHT' }); } });
  const r = await f.runtime.start('p', 'n'); assert.equal(r.startOutcome.status, 'held');
  assert.ok(f.node.sandboxGate.blockers[0].includes('STOP/Unknown')); assert.equal(f.node.sandbox, undefined);
  assert.ok(!f.calls.includes('select')); assert.ok(!f.calls.includes('agent'));
});
test('prepare reply after the fixed deadline times out before anchor or Agent creation', async () => {
  const f = fixture({ async prepare(f) { f.advance(60001); return { status: 'ready', binding: await f.bind({ state: 'ready' }) }; } });
  const r = await f.runtime.start('p', 'n');
  assert.equal(r.startOutcome.status, 'held'); assert.equal(f.node.termination.kind, 'timeout');
  assert.equal(f.node.sandbox.verifiedClean, true); assert.ok(!f.calls.includes('anchor')); assert.ok(!f.calls.includes('agent'));
});
test('real outcome validator accepts runtime started and clean queued identities', async () => {
  for (const queued of [false, true]) {
    const f = fixture(queued ? { async prepare(f) { return { status: 'queued', binding: await f.bind({ state: 'released', verifiedClean: true }) }; } } : {});
    const original = clone(f.node), result = await f.runtime.start('p', 'n');
    const outcome = startOutcomeOf(result, f.node, original);
    assert.equal(outcome.status, queued ? 'queued' : 'started');
    assert.equal(outcome.attempt, 1); assert.equal(outcome.sessionId, f.node.sessionId);
    await f.runtime.dispose();
  }
  const gated = fixture({ preflight: { ready: false, blockers: ['STOP'] } });
  const held = await gated.runtime.start('p', 'n');
  assert.equal(held.startOutcome.attempt, 0); assert.equal(held.startOutcome.sessionId, null);
  assert.equal(startOutcomeOf(held, gated.node).status, 'held');
});
test('actual envelope recognizes the runtime started outcome instead of holding it', async () => {
  const f = fixture(), result = await envelopeFor(f)();
  assert.equal(result.ok, true); assert.equal(result.startOutcome.status, 'started');
  assert.equal(result.startOutcome.sessionId, f.node.sessionId); assert.ok(f.node.admission); assert.ok(f.node.claim);
  assert.ok(!f.calls.includes('envelope.release')); await f.runtime.dispose();
});
test('actual envelope recognizes runtime clean queue and alone releases its permit', async () => {
  const f = fixture({ async prepare(f) { return { status: 'queued', binding: await f.bind({ state: 'released', verifiedClean: true }) }; } });
  const result = await envelopeFor(f)();
  assert.equal(result.ok, true); assert.equal(result.startOutcome.status, 'queued');
  assert.equal(result.startOutcome.attempt, 1); assert.equal(result.startOutcome.sessionId, f.node.sessionId);
  assert.equal(f.calls.filter(c => c === 'envelope.release').length, 1);
  assert.ok(!f.calls.includes('admission.release')); assert.equal(f.node.claim, undefined); assert.equal(f.node.admission, undefined);
  assert.ok(!f.calls.includes('agent')); assert.ok(!f.calls.includes('anchor'));
});
test('a stale start response keeps its own identity, never borrows the foreign fresh node', async () => {
  let ownSession;
  const f = fixture({ activation(f, args) { ownSession = args.childId; f.node = { ...clone(f.node), currentAttempt: 2, sessionId: 'foreign', admission: { ...f.node.admission, launchGeneration: 'foreign' } }; return { result: deferred().promise, async dispose() { f.calls.push('dispose'); } }; } });
  const result = await f.runtime.start('p', 'n');
  assert.equal(result.startOutcome.status, 'held'); assert.equal(result.node.sessionId, 'foreign');
  assert.equal(result.startOutcome.attempt, 1); assert.equal(result.startOutcome.sessionId, ownSession);
  assert.ok(!f.calls.includes('release'));
});
test('runtime commits explicitly target nodes and carry each lock-fresh node revision', async () => {
  const f = fixture(); await f.runtime.start('p', 'n'); await f.finish();
  const runtime = f.commits.filter(row => row.spec.actor?.id === 'sandbox-runtime');
  assert.ok(runtime.some(row => row.spec.mutations.some(m => m.op === 'node.put')));
  for (const { spec, node } of runtime) {
    assert.equal(spec.basis, node.rev, 'runtime basis must be the lock-fresh node revision');
    assert.ok(spec.mutations.every(m => m.nodeId === node.id), 'every mutation must expose its target to executor basis checks');
  }
});
test('actual executor rejects a captured status mutation when its node basis is stale', async () => {
  const f = fixture(); await f.runtime.start('p', 'n');
  const row = f.commits.find(row => row.spec.actor?.id === 'sandbox-runtime' && row.spec.mutations.some(m => m.op === 'node.put'));
  assert.ok(row); const current = { ...clone(row.node), rev: row.node.rev + 1 }, project = { ...clone(row.project), revision: row.node.rev + 1 }; let writes = 0;
  const neverWrite = async () => { writes++; throw Error('stale node commit reached persistence'); };
  const executor = createExecutor({ store: { getProject: () => clone(project), getNode: () => clone(current), appendEvent: neverWrite, saveNode: neverWrite, saveProject: neverWrite } });
  const rejected = await executor.commitLocked('p', { ...clone(row.spec), expectedProjectRevision: project.revision, basis: row.node.rev });
  assert.equal(rejected.ok, false); assert.equal(rejected.code, 'stale'); assert.equal(writes, 0);
  await f.runtime.dispose();
});
test('dispose awaits own cleanup; merge/preemption reject without local fallback', async () => { const m = fixture({ node: { kind: 'merge' } }); await assert.rejects(m.runtime.start('p', 'n')); const f = fixture(); await f.runtime.start('p', 'n'); await assert.rejects(f.runtime.terminate('p', 'n', 'preempted')); await f.runtime.dispose(); assert.equal(f.runtime.has('p', 'n'), false); assert.equal(f.node.termination.kind, 'dispose'); assert.equal(f.node.sandbox.verifiedClean, true); assert.equal(f.node.admission, undefined); });
for (const stage of ['usage', 'lock']) test(`late Unknown at ${stage} cannot produce a completed report`, async () => {
    const usage = deferred(), entered = deferred(), release = deferred(), write = deferred();
    const f = fixture({ usage: () => usage.promise }); await f.runtime.start('p', 'n');
    f.results[0].resolve({ stopReason: 'completed', structured: { summary: 'fake', success: true } }); await flush();
    const patch = async () => { await f.bind({ operations: { exec: { state: 'intent', action: 'exec', requestHash: 'h' } } }); await f.bind({ operations: { exec: { state: 'unknown', action: 'exec', requestHash: 'h' } } }); };
    let locked;
    if (stage === 'lock') { locked = f.store.withProjectLock('p', async () => { entered.resolve(); await write.promise; await patch(); await release.promise; }); await entered.promise; usage.resolve({}); await flush(); write.resolve(); await flush(); release.resolve(); await locked; }
    else { await patch(); usage.resolve({}); }
    await flush(); assert.equal(f.node.status, 'failed', stage); assert.equal(f.node.report, undefined);
    assert.equal(f.node.sandbox.operations.exec.state, 'unknown'); assert.equal(f.node.sandbox.verifiedClean, true);
    assert.ok(f.node.admission); assert.ok(f.node.claim); assert.ok(f.node.resourcesHeld); assert.ok(!f.calls.includes('admission.release'));
    await f.runtime.dispose();
});
for (const stage of ['usage', 'lock']) test(`late completed failing exec is recomputed at ${stage}`, async () => {
    const usage = deferred(), entered = deferred(), release = deferred(), write = deferred();
    const f = fixture({ usage: () => usage.promise }); await f.runtime.start('p', 'n');
    f.results[0].resolve({ stopReason: 'completed', structured: { summary: 'fake', success: true } }); await flush();
    const patch = async () => { await f.bind({ operations: { exec: { state: 'intent', action: 'exec', requestHash: 'h' } } }); await f.bind({ operations: { exec: { state: 'completed', action: 'exec', requestHash: 'h', result: { exitCode: 7, success: false, truncated: false } } } }); };
    if (stage === 'lock') { const locked = f.store.withProjectLock('p', async () => { entered.resolve(); await write.promise; await patch(); await release.promise; }); await entered.promise; usage.resolve({}); await flush(); write.resolve(); await flush(); release.resolve(); await locked; }
    else { await patch(); usage.resolve({}); }
    await flush(); assert.equal(f.node.status, 'completed'); assert.equal(f.node.report.success, false, stage);
    assert.equal(f.node.sandbox.operations.exec.result.exitCode, 7); assert.equal(f.node.admission, undefined); await f.runtime.dispose();
});
for (const watchdog of [false, true]) test(`completion waiting past hard end times out once (concurrent tick: ${watchdog})`, async () => {
    const usage = deferred(), entered = deferred(), release = deferred(), f = fixture({ usage: () => usage.promise, lease: { hardEndAt: 130000 } });
    await f.runtime.start('p', 'n'); assert.equal(f.node.deadlineAt, 130000);
    f.results[0].resolve({ stopReason: 'completed', structured: { summary: 'fake', success: true } }); await flush();
    const locked = f.store.withProjectLock('p', async () => { entered.resolve(); await release.promise; }); await entered.promise;
    usage.resolve({}); await flush(); f.advance(30001);
    const tick = watchdog ? f.runtime.tick().then(() => null, error => error) : Promise.resolve(null); await flush(); release.resolve(); await locked; const tickError = await tick; await flush();
    assert.equal(tickError, null); assert.equal(f.node.status, 'failed', String(watchdog)); assert.equal(f.node.termination.kind, 'timeout'); assert.equal(f.node.report, undefined);
    assert.equal(f.node.attempts[0].stopReason, 'timeout'); assert.equal(f.node.attempts[0].endedAt, 130001);
    assert.equal(f.calls.filter(c => c === 'release').length, 1); assert.equal(f.calls.filter(c => c === 'dispose').length, 1); await f.runtime.dispose();
});
test('cancel after durable completion cannot overwrite the terminal state or disturb pending cleanup', async () => {
  const releasing = deferred(), release = deferred();
  const f = fixture({ async release(f) { releasing.resolve(); await release.promise; return { verifiedClean: true, binding: await f.bind({ state: 'released', verifiedClean: true, cancelRequested: false, operations: clone(f.node.sandbox.operations) }) }; } });
  await f.runtime.start('p', 'n'); f.results[0].resolve({ stopReason: 'completed', structured: { summary: 'fake', success: true } }); await releasing.promise;
  assert.equal(f.node.status, 'completed'); const before = clone(f.node);
  const cancelling = f.runtime.terminate('p', 'n', 'cancel', { expectedRevision: f.store.getProject('p').revision }); await flush();
  assert.deepEqual(f.node, before); assert.equal(f.runtime.has('p', 'n'), true); assert.ok(!f.calls.includes('dispose'));
  release.resolve(); await cancelling; await flush(); assert.equal(f.node.status, 'completed'); assert.equal(f.node.attempts[0].status, 'completed');
  assert.equal(f.node.report.success, true); assert.equal(f.node.termination, undefined); assert.equal(f.calls.filter(c => c === 'release').length, 1); assert.equal(f.calls.filter(c => c === 'dispose').length, 1);
});
test('cancel queued behind a completed commit cannot change terminal state or own cleanup', async () => {
  const usage = deferred(), entered = deferred(), release = deferred(), f = fixture({ usage: () => usage.promise });
  await f.runtime.start('p', 'n'); f.results[0].resolve({ stopReason: 'completed', structured: { summary: 'fake', success: true } }); await flush();
  const locked = f.store.withProjectLock('p', async () => { entered.resolve(); await release.promise; }); await entered.promise;
  usage.resolve({}); await flush();
  const cancelling = f.runtime.terminate('p', 'n', 'cancel').then(() => ({ accepted: true }), error => ({ accepted: false, code: error.code })); await flush();
  release.resolve(); await locked; const cancellation = await cancelling; await flush();
  assert.equal(cancellation.accepted, false); assert.equal(f.node.status, 'completed'); assert.equal(f.node.report.success, true);
  assert.equal(f.node.termination, undefined); assert.equal(f.calls.filter(c => c === 'dispose').length, 1); assert.equal(f.calls.filter(c => c === 'release').length, 1);
});
test('rejected cancel lock race remains a valid finish with exactly one owned disposal', async () => {
  const entered = deferred(), release = deferred(), f = fixture(); await f.runtime.start('p', 'n');
  const locked = f.store.withProjectLock('p', async () => { entered.resolve(); await release.promise; }); await entered.promise;
  const cancelling = f.runtime.terminate('p', 'n', 'cancel', { expectedRevision: f.store.getProject('p').revision }).then(() => ({ accepted: true }), error => ({ accepted: false, code: error.code }));
  f.results[0].resolve({ stopReason: 'completed', structured: { summary: 'fake', success: true } }); await flush(); release.resolve(); await locked;
  const cancellation = await cancelling; await flush(); assert.equal(cancellation.accepted, false); assert.equal(cancellation.code, 'SANDBOX_SCOPE');
  assert.equal(f.node.status, 'completed'); assert.equal(f.node.report.success, true); assert.equal(f.node.error, undefined);
  assert.equal(f.runtime.has('p', 'n'), false); assert.equal(f.calls.filter(c => c === 'dispose').length, 1);
});
test('optional finalize runs only after raw release and successful kernel removal, preserving false or throwing budget holds', async () => {
  for (const outcome of ['success', 'held', 'throw']) {
    const reservation = { id: 'host-budget', held: true };
    const f = fixture({ node: { hostBudgetReservation: reservation }, async finalize(f, pid, nid, lease) {
      assert.equal(pid, 'p'); assert.equal(nid, 'n'); assert.equal(lease.leaseId, 'l1'); assert.equal(f.node.admission, undefined); assert.equal(f.node.claim, undefined);
      assert.equal(f.node.sandbox.verifiedClean, true); assert.ok(f.calls.includes('admission.release'));
      assert.ok(f.commits.some(row => row.spec.mutations.some(m => m.eventType === 'node/sandbox_released')));
      if (outcome === 'throw') throw Error('logical budget remains held');
      if (outcome === 'held') return { released: false, held: true };
      await f.store.withProjectLock(pid, () => f.store.withWritePermit(() => f.kernel.executor.commitLocked(pid, { expectedProjectRevision: f.store.getProject(pid).revision, mutations: [{ op: 'node.update', nodeId: nid, unset: ['hostBudgetReservation'] }] })));
      return { released: true };
    } });
    await f.runtime.start('p', 'n'); await f.finish(); assert.equal(f.calls.filter(c => c === 'admission.finalize').length, 1, outcome);
    assert.equal(f.node.status, 'completed'); assert.equal(f.node.sandbox.verifiedClean, true); assert.equal(f.node.admission, undefined); assert.equal(f.node.claim, undefined);
    assert.deepEqual(f.node.hostBudgetReservation, outcome === 'success' ? undefined : reservation); await f.runtime.dispose();
    assert.equal(f.calls.filter(c => c === 'admission.finalize').length, 1);
  }
});
test('finalize is not called for queued, unknown, unconfirmed permit, or rejected kernel removal', async () => {
  for (const scenario of ['queued', 'unknown', 'permit', 'kernel']) {
    let finalized = 0; const opts = { finalize() { finalized++; return { released: true }; } };
    if (scenario === 'queued') opts.prepare = async f => ({ status: 'queued', binding: await f.bind({ state: 'released', verifiedClean: true }) });
    if (scenario === 'permit') opts.admissionRelease = () => ({ released: false, held: true });
    const f = fixture(opts);
    if (scenario === 'kernel') { const commit = f.kernel.executor.commitLocked; f.kernel.executor.commitLocked = (id, spec) => spec.mutations.some(m => m.eventType === 'node/sandbox_released') ? { ok: false, message: 'forced kernel rejection' } : commit(id, spec); }
    await f.runtime.start('p', 'n');
    if (scenario !== 'queued') { if (scenario === 'unknown') await f.bind({ operations: { exec: { state: 'unknown', requestHash: 'h' } } }); await f.finish(); }
    assert.equal(finalized, 0, scenario); if (scenario !== 'queued') assert.ok(f.node.admission); await f.runtime.dispose();
  }
});
test('new owner replacing a just-cleared admission prevents the old finalizer callback', async () => {
  let finalized = 0, replacement;
  const f = fixture({ finalize() { finalized++; return { released: true }; }, afterCommit(f, spec) {
    if (spec.mutations.some(m => m.eventType === 'node/sandbox_released')) {
      replacement = { ...clone(f.node), currentAttempt: 2, sessionId: 'foreign', admission: { leaseId: 'foreign' }, claim: { leaseId: 'foreign', decisionId: 'foreign' }, hostBudgetReservation: { id: 'foreign-budget' }, rev: ++f.store.getProject('p').revision };
      f.node = clone(replacement);
    }
  } });
  await f.runtime.start('p', 'n'); await f.finish(); assert.equal(finalized, 0); assert.deepEqual(f.node, replacement);
  assert.equal(f.calls.filter(c => c === 'dispose').length, 1);
});
test('timeout after the last lock retains a late Unknown ledger and logical permit', async () => {
  const usage = deferred(), entered = deferred(), release = deferred(), f = fixture({ usage: () => usage.promise, lease: { hardEndAt: 130000 } });
  await f.runtime.start('p', 'n'); f.results[0].resolve({ stopReason: 'completed', structured: { summary: 'fake', success: true } }); await flush();
  await f.bind({ operations: { exec: { state: 'intent', action: 'exec', requestHash: 'h' } } });
  await f.bind({ operations: { exec: { state: 'unknown', action: 'exec', requestHash: 'h' } } });
  const locked = f.store.withProjectLock('p', async () => { entered.resolve(); await release.promise; }); await entered.promise;
  usage.resolve({}); await flush(); f.advance(30001); const tick = f.runtime.tick(); await flush(); release.resolve(); await locked; await tick; await flush();
  assert.equal(f.node.status, 'failed'); assert.equal(f.node.termination.kind, 'timeout'); assert.equal(f.node.report, undefined);
  assert.equal(f.node.sandbox.verifiedClean, true); assert.equal(f.node.sandbox.operations.exec.state, 'unknown');
  assert.ok(f.node.admission); assert.ok(f.node.claim); assert.ok(f.node.resourcesHeld); assert.ok(!f.calls.includes('admission.release'));
  assert.equal(f.calls.filter(c => c === 'release').length, 1); assert.equal(f.calls.filter(c => c === 'dispose').length, 1);
});
test('cancel after claim removal leaves a pending finalizer and its owned cleanup undisturbed', async () => {
  const finalizing = deferred(), release = deferred(), reservation = { id: 'held-budget' };
  const f = fixture({ node: { hostBudgetReservation: reservation }, async finalize() { finalizing.resolve(); await release.promise; return { released: false, held: true }; } });
  await f.runtime.start('p', 'n'); f.results[0].resolve({ stopReason: 'completed', structured: { summary: 'fake', success: true } }); await finalizing.promise;
  const before = clone(f.node); assert.equal(before.admission, undefined); assert.equal(before.claim, undefined);
  await f.runtime.terminate('p', 'n', 'cancel', { expectedRevision: f.store.getProject('p').revision });
  assert.deepEqual(f.node, before); assert.equal(f.runtime.has('p', 'n'), true); assert.ok(!f.calls.includes('dispose'));
  const disposing = f.runtime.dispose(); await flush(); assert.equal(f.runtime.has('p', 'n'), true); assert.ok(!f.calls.includes('dispose'));
  release.resolve(); await disposing; await flush(); assert.equal(f.node.status, 'completed'); assert.equal(f.node.termination, undefined);
  assert.deepEqual(f.node.hostBudgetReservation, reservation); assert.equal(f.calls.filter(c => c === 'admission.finalize').length, 1); assert.equal(f.calls.filter(c => c === 'dispose').length, 1);
});
test('a finalizer replacing the owner and then throwing cannot mutate the replacement through an old permit', async () => {
  let replacement;
  const f = fixture({ finalize(f) { replacement = { ...clone(f.node), currentAttempt: 2, sessionId: 'foreign', admission: { leaseId: 'foreign' }, claim: { leaseId: 'foreign', decisionId: 'foreign' }, hostBudgetReservation: { id: 'foreign-budget' } }; f.node = clone(replacement); throw Error('foreign budget hold'); } });
  await f.runtime.start('p', 'n'); await f.finish(); assert.ok(replacement); assert.deepEqual(f.node, replacement); assert.equal(f.calls.filter(c => c === 'admission.finalize').length, 1);
});

test('shared effect marker follows durable attempt and precedes Git, prepare and Agent',async()=>{
 const f=fixture({beforeEffects(f){assert.equal(f.node.status,'running');assert.equal(f.node.currentAttempt,1);assert.ok(!f.calls.includes('worktree'));assert.ok(!f.calls.includes('prepare'));return {ok:true};}});
 assert.equal((await f.runtime.start('p','n')).startOutcome.status,'started');
 assert.ok(f.calls.indexOf('admission.beforeEffects')>=0);assert.ok(f.calls.indexOf('admission.beforeEffects')<f.calls.indexOf('worktree'));await f.runtime.dispose();
});
test('unconfirmed shared effect intent never reaches Git or sandbox create',async()=>{
 const f=fixture({beforeEffects:()=>({ok:false,held:true})});const r=await f.runtime.start('p','n');assert.equal(r.startOutcome.status,'held');assert.ok(!f.calls.includes('worktree'));assert.ok(!f.calls.includes('prepare'));assert.ok(!f.calls.includes('agent'));assert.ok(f.node.admission);
});
test('cancel while common effect marker is pending fences a late positive callback',async()=>{
 const entered=deferred(),done=deferred();const f=fixture({beforeEffects(){entered.resolve();return done.promise;}});const starting=f.runtime.start('p','n');
 await entered.promise;await f.runtime.terminate('p','n','cancel');done.resolve({ok:true});await starting;assert.equal(f.node.status,'cancelled');assert.ok(!f.calls.includes('worktree'));assert.ok(!f.calls.includes('prepare'));assert.ok(!f.calls.includes('agent'));
});
