/** Host-owned sandbox lifecycle. All durable writes cross the kernel; there is no local runner. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { sandboxAdmissionBlock } from './sandbox-state.js';

const clone = value => structuredClone(value);
const keyOf = (projectId, nodeId) => JSON.stringify([projectId, nodeId]);
const uncertain = binding => Object.values(binding?.operations ?? {}).some(row => row?.state !== 'completed');
function check(value, message) {
  if (!value) { const error = new Error(message); error.code = 'SANDBOX_SCOPE'; throw error; }
}
async function boundedDispose(activation) {
  if (!activation?.dispose) return;
  let timer;
  try { await Promise.race([Promise.resolve().then(() => activation.dispose()), new Promise(resolve => { timer = setTimeout(resolve, 2000); })]); }
  catch { /* Remote release, not disposal, proves physical cleanup. */ }
  finally { clearTimeout(timer); }
}

export function createSandboxRuntime({ ctx, store, kernel, git, backend, admission, worker, onTerminated, clock = Date.now }) {
  check(kernel?.executor && store?.withProjectLock && store?.withWritePermit, 'Sandbox runtime requires the kernel and project lock.');
  const active = new Map();
  let disposed = false, ticking = false, pumping = false;
  const isSandbox = node => Boolean(backend.isSandbox(node));
  function snapshot(projectId, nodeId) {
    const project = clone(store.getProject(projectId)), node = clone(store.getNode(projectId, nodeId));
    check(project && node && node.projectId === projectId && node.id === nodeId, 'Sandbox owner no longer exists.');
    return { project, node };
  }
  function own(entry, released = false) {
    const current = snapshot(entry.projectId, entry.nodeId), n = current.node;
    check(n.currentAttempt === entry.attempt && n.sessionId === entry.sessionId && n.anchorSessionId === entry.anchorSessionId
      && isDeepStrictEqual(n.execution, entry.execution)
      && (released ? n.admission === undefined && n.claim === undefined : isDeepStrictEqual(n.admission, entry.lease) && isDeepStrictEqual(n.claim, entry.claim))
      && isDeepStrictEqual(n.needs, entry.needs) && n.timeboxMs === entry.timeboxMs,
      'Sandbox attempt/session/admission owner changed.');
    if (entry.worktreePath !== undefined) check(n.git?.worktreePath === entry.worktreePath && n.git?.branch === entry.branch, 'Sandbox worktree owner changed.');
    if (entry.bindingId) check(n.sandbox?.bindingId === entry.bindingId, 'Sandbox binding owner changed.');
    return current;
  }
  function running(entry, enforceDeadline = true) {
    const current = own(entry);
    check(!entry.controller.signal.aborted && current.node.status === 'running', 'Sandbox attempt is no longer running.');
    if (enforceDeadline && entry.deadlineAt !== undefined) check(clock() < entry.deadlineAt, 'Sandbox fixed deadline elapsed.');
    return current;
  }
  async function change(entry, event, update) {
    const expectedStatus = own(entry).node.status, expectedPhase = entry.phase;
    return store.withProjectLock(entry.projectId, async () => {
      const { project, node } = own(entry), next = clone(node);
      check(node.status === expectedStatus && entry.phase === expectedPhase, 'Sandbox lifecycle changed while waiting for the project lock.');
      update(next, project);
      let mutations;
      if (next.status !== node.status) {
        // node.transition consumes claim and forbids running->planned; a clean queue must retain its envelope claim.
        mutations = [{ op: 'node.put', nodeId: node.id, node: next, eventType: event }];
      } else {
        const set = {}, unset = [];
        for (const field of new Set([...Object.keys(node), ...Object.keys(next)])) {
          if (['id', 'rev', 'claim'].includes(field) || isDeepStrictEqual(node[field], next[field])) continue;
          if (Object.hasOwn(next, field)) set[field] = next[field]; else unset.push(field);
        }
        check(!next.claim || isDeepStrictEqual(next.claim, node.claim), 'Runtime cannot replace a dispatch claim.');
        mutations = [...(node.claim && !next.claim ? [{ op: 'node.releaseClaim', nodeId: node.id, decisionId: node.claim.decisionId, reason: 'sandbox_clean' }] : []),
          { op: 'node.update', nodeId: node.id, set, unset, eventType: event }];
      }
      const result = await store.withWritePermit(() => kernel.executor.commitLocked(project.id, {
        actor: { kind: 'system', id: 'sandbox-runtime' }, causeId: `${node.id}-a${entry.attempt ?? 0}`,
        expectedProjectRevision: project.revision, basis: node.rev, mutations,
      }));
      check(result?.ok === true, result?.message ?? 'Sandbox lifecycle commit rejected.');
      return snapshot(entry.projectId, entry.nodeId);
    });
  }
  function response(entry, status, fields = {}) {
    return { node: clone(store.getNode(entry.projectId, entry.nodeId)), revision: store.getProject(entry.projectId)?.revision ?? null,
      startOutcome: { status, attempt: entry.attempt ?? 0, sessionId: entry.sessionId ?? null, ...(status === 'held' ? { retryable: false } : {}), ...fields } };
  }
  function forget(entry) { if (active.get(entry.key) === entry) active.delete(entry.key); }
  function endAttempt(node, status, stopReason) {
    node.attempts = (node.attempts ?? []).map(row => row.attempt === node.currentAttempt && row.sessionId === node.sessionId
      ? { ...row, status, stopReason, endedAt: clock() } : row);
    node.timestamps = { ...(node.timestamps ?? {}), completedAt: clock(), lastActivityAt: clock() };
  }
  async function hold(entry, code) {
    try { await change(entry, 'node/sandbox_held', n => { n.dispatchHold = { untilMs: null, reason: 'sandbox_held', by: 'sandbox-runtime', code }; }); }
    catch { /* A stale owner must not be touched. */ }
  }
  async function cleanup(entry) {
    if (entry.cleanup) return entry.cleanup;
    entry.cleanup = (async () => {
      let current;
      try {
        current = own(entry);
        const binding = current.node.sandbox;
        if (!binding || binding.attempt !== entry.attempt || binding.sessionId !== entry.sessionId) { await hold(entry, 'NO_CLEANUP_PROOF'); return; }
        entry.bindingId ??= binding.bindingId;
        const released = await backend.release(current.project, current.node);
        current = own(entry);
        if (released?.verifiedClean !== true || current.node.sandbox?.verifiedClean !== true
          || current.node.sandbox.bindingId !== entry.bindingId || uncertain(current.node.sandbox) || current.node.sandbox.cancelRequested === true) {
          await hold(entry, 'CLEANUP_UNRESOLVED'); return;
        }
        await change(entry, 'node/sandbox_physically_clean', n => {
          delete n.resourcesHeld; n.deadlineAt = null;
          delete n.dispatchHold; delete n.sandboxGate;
          if (n.termination) n.termination.verifiedClean = true;
        });
        own(entry);
        const permit = await admission.release(entry.projectId, clone(entry.lease));
        own(entry);
        if (permit?.released !== true) { await hold(entry, 'ADMISSION_RELEASE_UNCONFIRMED'); return; }
        await change(entry, 'node/sandbox_released', n => { delete n.admission; delete n.claim; });
        own(entry, true);
        if (admission.finalize) {
          try { return await admission.finalize(entry.projectId, entry.nodeId, clone(entry.lease)); }
          catch { return { released: false, held: true }; } // The Host budget retains its reservation; never reconstruct a permit.
        }
      } catch { await hold(entry, 'CLEANUP_UNKNOWN'); }
    })();
    return entry.cleanup;
  }
  async function releaseHandles(entry) {
    const activation = entry.activation;
    entry.activation = null;
    await boundedDispose(activation);
    if (entry.anchor) {
      entry.anchor = null;
      try { await worker.releaseAnchor(clone(entry.anchorNode)); } catch { /* Only this attempt's Host handle is released. */ }
    }
  }
  async function terminateEntry(entry, kind, payload = {}) {
    if (entry.terminating) return entry.terminating;
    let current;
    try { current = own(entry); } catch { try { current = own(entry, true); } catch { /* A stale owner still disposes only its own handles below. */ } }
    if (current && !['planned', 'running'].includes(current.node.status)) return kind === 'dispose' ? entry.done ?? null : null;
    if (Number.isInteger(payload.expectedRevision)) check(snapshot(entry.projectId, entry.nodeId).project.revision === payload.expectedRevision, 'Cancellation revision changed.');
    const priorPhase = entry.phase;
    entry.terminating = (async () => {
      let accepted = false, stale = false;
      try {
        await change(entry, 'node/sandbox_terminated', (n, project) => {
          check(['planned', 'running'].includes(n.status), 'Sandbox attempt is already terminal.');
          if (Number.isInteger(payload.expectedRevision)) check(project.revision === payload.expectedRevision, 'Cancellation revision changed.');
          entry.phase = 'terminating';
          n.status = kind === 'cancel' ? 'cancelled' : 'failed';
          n.error = { code: payload.code ?? kind, message: String(payload.message ?? kind).slice(0, 2000) };
          n.termination = { kind, requestedAt: clock(), verifiedClean: false };
          if (n.sandbox?.attempt === entry.attempt && n.sandbox.sessionId === entry.sessionId) n.sandbox.cancelRequested = true;
          endAttempt(n, n.status, kind === 'cancel' ? 'cancelled' : kind);
        });
        accepted = true;
        entry.controller.abort();
        await releaseHandles(entry);
        await cleanup(entry);
        const node = store.getNode(entry.projectId, entry.nodeId);
        if (node?.currentAttempt === entry.attempt && node.sessionId === entry.sessionId) {
          try { onTerminated?.(entry.projectId, entry.nodeId, clone(node.termination)); } catch { /* advisory */ }
        }
      } catch (error) {
        try { own(entry); } catch { stale = true; }
        if (!accepted && !stale) { entry.phase = priorPhase; entry.terminating = null; }
        throw error;
      } finally {
        if (accepted || stale) { entry.controller.abort(); await releaseHandles(entry); forget(entry); }
      }
      return response(entry, 'held', { code: kind.toUpperCase() });
    })();
    return entry.terminating;
  }
  async function finish(entry, result, rejection) {
    if (entry.phase !== 'running') return;
    entry.phase = 'finishing';
    try {
      // A liveness status may have started just before this phase; wait for it to settle so a
      // transient intent is not mistaken for an unresolved effect (tick never starts a new one now).
      if (entry.heartbeat) { try { await entry.heartbeat; } catch { /* tick owns heartbeat failures */ } }
      running(entry);
      check(!rejection && result?.stopReason === 'completed', rejection?.message ?? 'Worker did not complete.');
      const report = clone(worker.normalize(result.structured));
      check(report, 'Worker did not return a valid structured report.');
      let current = running(entry);
      check(!uncertain(current.node.sandbox), 'Uncertain execution cannot be reported completed.');
      if (Object.values(current.node.sandbox.operations ?? {}).some(row => row.action === 'exec'
        && (row.result?.exitCode !== 0 || row.result?.success !== true || row.result?.truncated !== false))) report.success = false;
      const collected = await backend.collect(current.project, current.node, { signal: entry.controller.signal });
      current = running(entry);
      check(collected && Array.isArray(collected.files) && collected.truncated === false, 'Artifact collection is incomplete.');
      const branch = await git.branchOf(current.node.git.worktreePath);
      current = running(entry); check(branch === current.node.git.branch, 'Host branch changed before commit.');
      const commit = await git.commitWorktree(current.project, current.node, `sandbox(${current.node.id}): ${current.node.title ?? current.node.id}`);
      current = running(entry);
      const afterBranch = await git.branchOf(current.node.git.worktreePath);
      current = running(entry); check(afterBranch === current.node.git.branch, 'Host branch changed during commit.');
      const usage = await worker.usage(entry.sessionId);
      running(entry);
      await change(entry, 'node/completed', n => {
        running(entry);
        check(!uncertain(n.sandbox), 'Uncertain execution cannot be reported completed.');
        if (Object.values(n.sandbox.operations ?? {}).some(row => row.action === 'exec'
          && (row.result?.exitCode !== 0 || row.result?.success !== true || row.result?.truncated !== false))) report.success = false;
        n.status = 'completed'; n.report = clone(report); n.artifacts = clone(collected);
        n.git = { ...n.git, headCommit: commit.head }; n.usage = clone(usage);
        endAttempt(n, 'completed', result.stopReason);
      });
      await cleanup(entry);
    } catch (error) {
      if (entry.phase !== 'terminating') {
        try {
          running(entry, false);
          if (clock() >= entry.deadlineAt) { await terminateEntry(entry, 'timeout'); return; }
          await change(entry, 'node/failed', n => { n.status = 'failed'; n.error = { code: 'SANDBOX_RUN_FAILED', message: String(error.message ?? error).slice(0, 2000) }; endAttempt(n, 'failed', result?.stopReason ?? 'failed'); });
          await cleanup(entry);
        } catch { /* Stale completions cannot mutate or release a newer owner. */ }
      }
    } finally {
      if (entry.phase !== 'terminating') { await releaseHandles(entry); forget(entry); }
    }
  }
  async function start(projectId, nodeId, options = {}) {
    check(!disposed, 'Sandbox runtime is disposed.');
    const initial = snapshot(projectId, nodeId), n = initial.node;
    check(isSandbox(n) && n.execution?.driver === 'dsh', 'Node is not a supported sandbox worker.');
    check(n.kind !== 'merge' && !options.message && !options.continue && !options.resume, 'Sandbox merge and continuation are unsupported.');
    check(n.status === 'planned' && !active.has(keyOf(projectId, nodeId)), 'Sandbox node is not startable.');
    if (!options.lease) return admission.request(projectId, nodeId, options);
    const lease = clone(options.lease);
    check(lease.broker === 'sandbox-admission' && lease.projectId === projectId && lease.nodeId === nodeId
      && lease.profile === n.execution.sandboxProfile && lease.forAttempt === (n.currentAttempt ?? 0) + 1
      && typeof lease.launchGeneration === 'string' && isDeepStrictEqual(n.admission, lease)
      && n.claim?.leaseId === lease.leaseId && (!options.decisionId || n.claim.decisionId === options.decisionId), 'Sandbox admission scope is invalid.');
    check(await admission.verify(initial.project, n, lease, options.decisionId), 'Sandbox admission was not verified.');
    const entry = { key: keyOf(projectId, nodeId), projectId, nodeId, lease, execution: clone(n.execution),
      attempt: n.currentAttempt, sessionId: n.sessionId, anchorSessionId: n.anchorSessionId, claim: clone(n.claim), needs: clone(n.needs), timeboxMs: n.timeboxMs,
      controller: new AbortController(),
      phase: 'preflight', heartbeatAt: -Infinity, heartbeat: null, bindingId: null, anchor: null, activation: null };
    own(entry);
    check(!active.has(entry.key), 'Sandbox start is already in progress.');
    active.set(entry.key, entry);
    try {
      let preflight;
      try { preflight = await backend.preflight(lease.profile, { signal: entry.controller.signal }); }
      catch (error) { preflight = { ready: false, blockers: [String(error.code ?? 'SANDBOX_PREFLIGHT') + ': ' + String(error.message ?? error).slice(0, 1000)] }; }
      let current = own(entry);
      check(!entry.controller.signal.aborted && current.node.status === 'planned', 'Preflight owner was cancelled.');
      if (preflight?.ready !== true) {
        await change(entry, 'node/sandbox_gate', node => { node.sandboxGate = { profile: lease.profile, code: 'PREFLIGHT_BLOCKED', blockers: clone(preflight?.blockers ?? ['preflight not ready']), at: clock(), retryable: false }; });
        forget(entry); return response(entry, 'held', { code: 'PREFLIGHT_BLOCKED' });
      }
      check(!current.node.sandbox || (current.node.sandbox.verifiedClean === true && !uncertain(current.node.sandbox)), 'Existing sandbox ownership is unresolved.');
      const selection = await worker.select(current.project, current.node);
      current = own(entry); check(current.node.status === 'planned' && !entry.controller.signal.aborted, 'Model selection owner changed.');
      const timebox = current.node.timeboxMs ?? current.project.config?.nodeTimeoutMinutes * 60000;
      check(Number.isInteger(timebox) && timebox > 0 && timebox <= 7080000, 'Invalid fixed sandbox timebox.');
      const now = clock(), sessionId = randomUUID(), anchorSessionId = randomUUID();
      const deadlineAt = Math.min(now + timebox, Number.isFinite(lease.hardEndAt) ? lease.hardEndAt : Infinity);
      check(deadlineAt > now, 'Sandbox admission deadline elapsed.');
      await change(entry, 'node/started', node => {
        node.currentAttempt = (node.currentAttempt ?? 0) + 1;
        if (Object.hasOwn(node, 'attempt')) node.attempt = node.currentAttempt;
        node.sessionId = sessionId; node.anchorSessionId = anchorSessionId;
        node.status = 'running'; node.admission = clone(lease); node.modelResolved = clone(selection);
        node.resourcesHeld = Object.fromEntries(Object.entries(node.needs ?? {}).filter(([key]) => key !== 'machines'));
        node.deadlineAt = deadlineAt;
        node.timestamps = { ...(node.timestamps ?? {}), startedAt: now, lastActivityAt: now };
        node.attempts = [...(node.attempts ?? []), { attempt: node.currentAttempt, sessionId, anchorSessionId, startedAt: now, status: 'running' }];
        delete node.sandboxGate; delete node.dispatchHold; delete node.resourceWait; delete node.error; delete node.termination; delete node.report;
      });
      entry.attempt = lease.forAttempt; entry.sessionId = sessionId; entry.anchorSessionId = anchorSessionId;
      entry.deadlineAt = deadlineAt; entry.phase = 'preparing';
      current = running(entry);
      if (admission.beforeEffects) {
        const marker = await admission.beforeEffects(projectId, nodeId, clone(lease));
        current = running(entry);
        check(marker?.ok === true, 'Shared Host effect intent was not confirmed.');
      }
      const worktree = await git.ensureWorktree(current.project, current.node);
      running(entry);
      await change(entry, 'node/sandbox_worktree', node => { node.git = { ...node.git, worktreePath: worktree.worktreePath }; });
      current = running(entry); entry.worktreePath = current.node.git.worktreePath; entry.branch = current.node.git.branch;
      const prepared = await backend.prepare(current.project, current.node, { signal: entry.controller.signal });
      current = running(entry);
      check(prepared?.binding?.bindingId === current.node.sandbox?.bindingId && current.node.sandbox.attempt === entry.attempt
        && current.node.sandbox.sessionId === entry.sessionId && current.node.sandbox.profile === lease.profile, 'Prepare returned a stale binding.');
      entry.bindingId = current.node.sandbox.bindingId;
      if (prepared.status === 'queued') {
        check(current.node.sandbox.verifiedClean === true && !uncertain(current.node.sandbox), 'NO_CAPACITY lacks verified clean release.');
        await change(entry, 'node/sandbox_queued', node => {
          node.status = 'planned'; endAttempt(node, 'planned', 'no_capacity');
          delete node.resourcesHeld; node.deadlineAt = null;
          node.resourceWait = { backend: 'opensandbox', code: 'NO_CAPACITY', since: clock(), retryAfter: clock() + 5000 };
        });
        forget(entry); return response(entry, 'queued', { code: 'NO_CAPACITY', verifiedClean: true, retryable: true });
      }
      check(prepared.status === 'ready' && current.node.sandbox.state === 'ready' && current.node.sandbox.verifiedClean === false, 'Sandbox is not ready.');
      const anchor = await worker.anchor(current.project, current.node);
      entry.anchor = anchor; entry.anchorNode = clone(current.node);
      current = running(entry);
      const activation = await ctx.subagents.startActivation({
        provider: 'spawn', label: `sandbox/${projectId}/${nodeId}`, delivery: 'caller', signal: entry.controller.signal, childId: entry.sessionId,
        request: { parent: anchor, cwd: current.node.git.worktreePath, agentPreset: 'lab-sandbox-worker-v2', agentOptions: worker.options(selection), outputSchema: worker.schema,
          prompt: [{ type: 'text', text: `${current.node.prompt ?? current.node.title ?? current.node.id}\n\n${prepared.prompt ?? ''}\nReturn the required structured report. Preserve failure: nonzero/truncated or uncertain execution is not success. Never replay an unknown operation.` }] },
      });
      entry.activation = activation;
      running(entry);
      entry.phase = 'running';
      entry.done = Promise.resolve(activation.result).then(result => finish(entry, result), error => finish(entry, undefined, error));
      entry.done.catch(() => {});
      return response(entry, 'started');
    } catch (error) {
      if (entry.terminating) {
        await releaseHandles(entry);
        return response(entry, 'held', { code: 'CANCELLED' });
      }
      try {
        const current = own(entry);
        if (current.node.status === 'running') {
          if (clock() >= entry.deadlineAt) return await terminateEntry(entry, 'timeout');
          await change(entry, 'node/failed', node => { node.status = 'failed'; node.error = { code: error.code ?? 'SANDBOX_START_FAILED', message: String(error.message ?? error).slice(0, 2000) }; endAttempt(node, 'failed', 'start_failed'); });
          await cleanup(entry);
        } else await change(entry, 'node/sandbox_gate', node => { node.sandboxGate = { profile: lease.profile, code: 'START_BLOCKED', blockers: [String(error.message ?? error).slice(0, 1000)], at: clock(), retryable: false }; });
      } catch { /* Cancellation or replacement owns the durable state now. */ }
      await releaseHandles(entry); forget(entry);
      return response(entry, 'held', { code: error.code ?? 'SANDBOX_START_FAILED' });
    }
  }
  async function terminate(projectId, nodeId, kind, payload = {}) {
    check(['cancel', 'timeout', 'failure', 'resource_lost', 'dispose'].includes(kind), 'Sandbox preemption/continuation is unsupported.');
    const entry = active.get(keyOf(projectId, nodeId));
    if (!entry) return null;
    return terminateEntry(entry, kind, payload);
  }
  async function tick() {
    if (disposed || ticking) return;
    ticking = true;
    try {
      for (const entry of [...active.values()]) {
        if (!['preparing', 'running', 'finishing'].includes(entry.phase)) continue;
        let current;
        try { current = running(entry, false); } catch { continue; }
        if (clock() >= Math.min(entry.deadlineAt, Number.isFinite(current.node.deadlineAt) ? current.node.deadlineAt : entry.deadlineAt)) { await terminateEntry(entry, 'timeout'); continue; }
        if (entry.phase !== 'running' || clock() - entry.heartbeatAt < 30000) continue;
        entry.heartbeatAt = clock();
        const beatCall = backend.heartbeat(current.project, current.node);
        entry.heartbeat = beatCall;
        try {
          const beat = await beatCall;
          running(entry);
          if (beat?.skipped === true && beat.reason === 'operation_in_progress') continue;
          check(beat?.live === true, 'Sandbox heartbeat did not prove liveness.');
        } catch {
          try { running(entry, false); await terminateEntry(entry, clock() >= entry.deadlineAt ? 'timeout' : 'resource_lost'); } catch { /* stale */ }
        } finally {
          if (entry.heartbeat === beatCall) entry.heartbeat = null;
        }
      }
    } finally { ticking = false; }
  }
  async function pumpLeases() {
    if (disposed || pumping) return;
    pumping = true;
    try {
      for (const project of store.listProjects()) for (const node of store.listNodes(project.id)) {
        if (!isSandbox(node) || node.status !== 'planned' || node.claim || node.admission || node.resourceWait?.backend !== 'opensandbox'
          || node.resourceWait.retryAfter > clock() || sandboxAdmissionBlock(node) || active.has(keyOf(project.id, node.id))) continue;
        try { await start(project.id, node.id); } catch { /* No local fallback and no replay of a held attempt. */ }
      }
    } finally { pumping = false; }
  }
  async function dispose() {
    disposed = true;
    await Promise.all([...active.values()].map(entry => terminateEntry(entry, 'dispose').catch(() => {})));
  }
  return { isSandbox, has: (projectId, nodeId) => active.has(keyOf(projectId, nodeId)), start, terminate, tick, pumpLeases, dispose };
}
