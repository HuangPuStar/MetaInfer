/**
 * Startup reconciliation: no Agent survives a plugin reload / host restart, so a
 * node still marked `running` is stale. Mark it failed with a `restart`
 * termination record, release its resources, and leave the worktree for retry.
 */
export async function reconcileRunningNodes({ store, kernel }) {
  if (!kernel?.executor) throw new Error('reconcile requires kernel.executor');
  const reconciled = [];
  for (const project of store.listProjects()) {
    for (const stored of store.listNodes(project.id)) {
      const node = structuredClone(stored);
      const remote = Boolean(node.execution?.sandboxProfile || node.sandbox?.backend === 'opensandbox');
      const operations = node.sandbox?.operations ?? {};
      const unresolved = Object.values(operations).some(row => row?.state !== 'completed');
      const physicalClean = node.sandbox?.verifiedClean === true && ['released', 'noCapacity'].includes(node.sandbox?.state);
      const pristine = node.status === 'planned' && (node.currentAttempt ?? 0) === 0 && !(node.attempts?.length)
        && !node.sandbox && !node.admission && !node.claim && !node.resourcesHeld && !node.resourceWait && !node.sandboxGate;
      if (remote && pristine) continue;
      const pendingRemote = remote && (!physicalClean || unresolved || node.sandboxGate || node.admission || node.claim || node.resourcesHeld || node.resourceWait);
      if (node.status !== 'running' && !pendingRemote) {
        // A4: a planned/terminal local node can still carry a claim, admission or
        // reservation from a start that died with the Host. Nothing is running for
        // it, so the ownership is stale: clear it and let the node start again
        // instead of blocking the project behind OWNER_BLOCKED/PENDING_OWNER.
        const localStale = !remote && (node.claim || node.admission || node.lease
          || node.resourcesHeld || node.hostBudgetReservation || node.resourceWait);
        if (localStale) {
          const now = Date.now();
          const cleared = {
            claim: Boolean(node.claim),
            admission: Boolean(node.admission),
            lease: Boolean(node.lease),
            resourcesHeld: Boolean(node.resourcesHeld),
            reservation: Boolean(node.hostBudgetReservation),
          };
          delete node.claim;
          delete node.admission;
          delete node.lease;
          delete node.resourcesHeld;
          delete node.hostBudgetReservation;
          delete node.resourceWait;
          delete node.deadlineAt;
          node.timestamps = { ...(node.timestamps ?? {}), lastActivityAt: now };
          const result = await kernel.executor.commit(project.id, {
            actor: { kind: 'system', id: 'reconcile' },
            causeId: `reconcile-clear:${node.id}`,
            ...(Number.isInteger(node.rev) ? { basis: node.rev } : {}),
            mutations: [{ op: 'node.put', nodeId: node.id, node,
              eventType: 'node/ownership_cleared',
              eventData: { reason: 'no attempt survived the restart', cleared } }],
          });
          if (result.ok !== true) throw new Error(result.message ?? `reconcile clear ${node.id} failed`);
          reconciled.push(`${project.id}/${node.id}`);
        }
        continue;
      }
      // A previously held cold node remains held without rewriting its history on every reload.
      if (node.status !== 'running' && node.sandboxGate?.code === 'sandbox_restart_held'
        && !Object.values(operations).some(row => row?.state === 'intent')) continue;
      const now = Date.now();
      const wasRunning = node.status === 'running';
      // A local node whose worker died with the Host is not a task failure: the
      // worktree is intact and the task can simply run again. Requeue it instead
      // of marking it failed. Remote (sandbox) nodes keep the held path below,
      // because their cleanup needs an explicit reconciliation first.
      const requeued = wasRunning && !remote;
      const clean = !remote || physicalClean;
      if (clean) {
        delete node.resourcesHeld;
        delete node.lease;
        delete node.resourceWait;
        if (!unresolved) { delete node.admission; if (remote) delete node.claim; }
      }
      node.deadlineAt = null;
      const lastAttempt = Array.isArray(node.attempts) ? node.attempts[node.attempts.length - 1] : null;
      if (lastAttempt && !lastAttempt.endedAt) {
        lastAttempt.endedAt = now;
        lastAttempt.status = 'failed';
        lastAttempt.stopReason = 'restart';
      }
      if (wasRunning) node.status = requeued ? 'planned' : 'failed';
      if (remote && (!clean || unresolved || node.sandboxGate)) {
        if (node.sandbox) {
          for (const row of Object.values(node.sandbox.operations ?? {})) {
            if (row?.state === 'intent' || row?.state === 'inProgress') {
              row.state = 'unknown'; row.finishedAt = now; row.errorCode = 'HOST_RESTART';
            }
          }
        }
        node.sandboxGate ??= { profile: node.execution?.sandboxProfile ?? node.sandbox?.profile ?? null,
          code: 'sandbox_restart_held', blockers: ['No remote acquire/exec replay; exact binding/operation reconciliation is required.'], at: now, retryable: false };
      }
      if (requeued) {
        node.requeued = {
          at: now,
          previousAttempt: Number(node.currentAttempt) || (Array.isArray(node.attempts) ? node.attempts.length : 0),
          reason: 'host-restart',
        };
        delete node.error;
      } else {
        node.error ??= { message: remote
          ? 'Host restarted; sandbox outcome/cleanup requires explicit reconciliation, not a local process proof.'
          : 'host restarted or plugin reloaded while this node was running; the node was marked failed', at: now, stage: 'run' };
      }
      node.termination = {
        ...(node.termination ?? {}), kind: node.termination?.kind ?? 'restart',
        requestedAt: node.termination?.requestedAt ?? now,
        killedAt: remote ? (node.termination?.killedAt ?? null) : now,
        killedPids: node.termination?.killedPids ?? [], killedJobs: node.termination?.killedJobs ?? [],
        gpuFreed: clean, verifiedClean: clean,
        leftover: remote && (!clean || unresolved) ? ['sandbox proof held; unresolved operation identities are preserved on the binding'] : [],
        ...(remote ? { proofScope: clean ? 'existing exact remote physical cleanup only' : 'remote physical cleanup unconfirmed', reconciledAfterRestart: true } : {}),
      };
      node.timestamps = requeued
        ? { ...(node.timestamps ?? {}), runnableAt: now, lastActivityAt: now, startedAt: null, completedAt: null }
        : { ...(node.timestamps ?? {}), completedAt: node.timestamps?.completedAt ?? now, lastActivityAt: now };
      const result = await kernel.executor.commit(project.id, {
        actor: { kind: 'system', id: 'reconcile' }, causeId: `reconcile:${node.id}`,
        ...(Number.isInteger(node.rev) ? { basis: node.rev } : {}),
        mutations: [{ op: 'node.put', nodeId: node.id, node,
          eventType: requeued ? 'node/requeued' : (remote && node.sandboxGate ? 'node/sandbox_reconcile_held' : 'node/failed'),
          eventData: { stage: 'run', message: requeued ? 'host restarted while running; requeued for a new attempt' : node.error.message, restart: true, ...(requeued ? { requeued: true } : {}), ...(remote ? { verifiedClean: clean, admissionHeld: Boolean(node.sandboxGate) } : {}) } }],
      });
      if (result.ok !== true) throw new Error(result.message ?? `reconcile ${node.id} failed`);
      reconciled.push(`${project.id}/${node.id}`);
    }
  }
  return reconciled;
}

/**
 * Periodic deadline sweep (the store-driven counterpart of the runtime's
 * in-memory deadline map).
 *
 * `runtime.js` terminates a node when its own `deadlines` entry expires, but that
 * map lives in memory and is only populated by the runtime's own launch path. Any
 * node whose worker dies without the runtime noticing — a killed agent process, a
 * dropped provider adapter, a dispatch started through another path, or simply a
 * plugin reload between launch and expiry — stayed `status: 'running'` forever:
 * it kept `resourcesHeld`/`lease`, counted against `maxRunningNodes`, and showed
 * as live in the UI until the next restart. Four nodes were observed sitting
 * 10-44 minutes past their deadline with zero GPU activity.
 *
 * This sweep reads the store, so it is independent of what the current process
 * happens to remember. A node is swept only when it has a real `deadlineAt` and
 * that deadline is older than `graceMs`, so a slow-but-alive worker still gets
 * its grace period.
 */
export const TIMEOUT_SWEEP_GRACE_MS = 60_000;

export async function sweepOverdueNodes({ store, kernel, now = Date.now(), graceMs = TIMEOUT_SWEEP_GRACE_MS }) {
  if (!kernel?.executor) throw new Error('sweepOverdueNodes requires kernel.executor');
  const swept = [];
  for (const project of store.listProjects()) {
    for (const node of store.listNodes(project.id)) {
      if (node.status !== 'running') continue;
      const deadlineAt = Number(node.deadlineAt);
      // No deadline means the node was deliberately parked; not ours to kill.
      if (!Number.isFinite(deadlineAt) || deadlineAt <= 0) continue;
      if (now < deadlineAt + graceMs) continue;
      delete node.resourcesHeld;
      delete node.lease;
      delete node.resourceWait;
      node.deadlineAt = null;
      const lastAttempt = Array.isArray(node.attempts) ? node.attempts[node.attempts.length - 1] : null;
      if (lastAttempt && !lastAttempt.endedAt) {
        lastAttempt.endedAt = now;
        lastAttempt.status = 'failed';
        lastAttempt.stopReason = 'timeout';
      }
      node.status = 'failed';
      // `errorStage: 'timeout'` is the established marker for "killed
      // deterministically" — the advisor prompt treats it as retryable by design.
      node.errorStage = 'timeout';
      node.error = {
        message: `node stayed running ${Math.max(0, Math.round((now - deadlineAt) / 1000))}s past its deadline and was swept`,
        at: now,
        stage: 'timeout',
      };
      node.termination = {
        kind: 'timeout',
        requestedAt: deadlineAt,
        killedAt: now,
        killedPids: [],
        killedJobs: [],
        gpuFreed: true,
        verifiedClean: true,
        leftover: [],
      };
      node.timestamps = { ...(node.timestamps ?? {}), completedAt: now, lastActivityAt: now };
      const result = await kernel.executor.commit(project.id, {
        actor: { kind: 'system', id: 'deadline-sweep' },
        causeId: `sweep:${node.id}`,
        mutations: [{
          op: 'node.put',
          node,
          eventType: 'node/failed',
          eventData: { stage: 'timeout', message: node.error.message, swept: true },
        }],
      });
      if (result.ok !== true) throw new Error(result.message ?? `deadline sweep ${node.id} failed`);
      swept.push(`${project.id}/${node.id}`);
    }
  }
  return swept;
}

/**
 * Startup reconciliation for background expert runs. No advisor/scheduler/gc
 * activation survives a Host reload, so a run still marked running is stale and
 * must not keep showing as a live expert in the UI.
 */
export async function reconcileRunningRuns({ store, kernel }) {
  if (!kernel?.executor) throw new Error('reconcile requires kernel.executor');
  const reconciled = [];
  for (const project of store.listProjects()) {
    const runs = store.listRuns(project.id, 500);
    const mutations = [];
    for (const run of runs) {
      if (run.status !== 'running') continue;
      const now = Date.now();
      run.status = 'failed';
      run.stopReason = 'restart';
      run.endedAt = now;
      run.error = 'host restarted or plugin reloaded while this expert run was active';
      mutations.push({ op: 'run.put', run, eventType: 'expert/run_reconciled' });
      reconciled.push(`${project.id}/${run.id}`);
    }
    if (mutations.length > 0) {
      mutations.push({ op: 'event.record', type: 'expert/runs_reconciled', data: { count: mutations.length - 1 } });
      const result = await kernel.executor.commit(project.id, {
        actor: { kind: 'system', id: 'reconcile' },
        causeId: `reconcile:runs:${project.id}`,
        mutations,
      });
      if (result.ok !== true) throw new Error(result.message ?? 'run reconcile failed');
    }
  }
  return reconciled;
}
