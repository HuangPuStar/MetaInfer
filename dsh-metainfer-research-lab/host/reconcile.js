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
