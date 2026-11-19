/**
 * Startup reconciliation: no Agent survives a plugin reload / host restart, so a
 * node still marked `running` is stale. Mark it failed with a `restart`
 * termination record, release its resources, and leave the worktree for retry.
 */
export async function reconcileRunningNodes({ store, kernel }) {
  if (!kernel?.executor) throw new Error('reconcile requires kernel.executor');
  const reconciled = [];
  for (const project of store.listProjects()) {
    for (const node of store.listNodes(project.id)) {
      if (node.status !== 'running') continue;
      const now = Date.now();
      delete node.resourcesHeld;
      delete node.lease;
      delete node.resourceWait;
      node.deadlineAt = null;
      const lastAttempt = Array.isArray(node.attempts) ? node.attempts[node.attempts.length - 1] : null;
      if (lastAttempt && !lastAttempt.endedAt) {
        lastAttempt.endedAt = now;
        lastAttempt.status = 'failed';
        lastAttempt.stopReason = 'restart';
      }
      node.status = 'failed';
      node.error = {
        message: 'host restarted or plugin reloaded while this node was running; the node was marked failed',
        at: now,
        stage: 'run',
      };
      node.termination = {
        kind: 'restart',
        requestedAt: now,
        killedAt: now,
        killedPids: [],
        killedJobs: [],
        gpuFreed: true,
        verifiedClean: true,
        leftover: [],
      };
      node.timestamps = { ...(node.timestamps ?? {}), completedAt: now, lastActivityAt: now };
      const result = await kernel.executor.commit(project.id, {
        actor: { kind: 'system', id: 'reconcile' },
        causeId: `reconcile:${node.id}`,
        mutations: [{
          op: 'node.put',
          node,
          eventType: 'node/failed',
          eventData: { stage: 'run', message: node.error.message, restart: true },
        }],
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
