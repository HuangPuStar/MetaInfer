/**
 * Startup reconciliation: no Agent survives a plugin reload / host restart, so a
 * node still marked `running` is stale. Mark it failed with a `restart`
 * termination record, release its resources, and leave the worktree for retry.
 */
export async function reconcileRunningNodes({ store }) {
  const reconciled = [];
  for (const project of store.listProjects()) {
    let changed = false;
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
      await store.saveNode(project.id, node);
      project.revision = (project.revision ?? 0) + 1;
      project.updatedAt = now;
      await store.appendEvent(project, 'node/failed', {
        nodeId: node.id,
        data: { stage: 'run', message: node.error.message, restart: true },
      });
      changed = true;
      reconciled.push(`${project.id}/${node.id}`);
    }
    if (changed) await store.saveProject(project);
  }
  return reconciled;
}

/**
 * Startup reconciliation for background expert runs. No advisor/scheduler/gc
 * activation survives a Host reload, so a run still marked running is stale and
 * must not keep showing as a live expert in the UI.
 */
export async function reconcileRunningRuns({ store }) {
  const reconciled = [];
  for (const project of store.listProjects()) {
    const runs = store.listRuns(project.id, 500);
    let changed = false;
    for (const run of runs) {
      if (run.status !== 'running') continue;
      const now = Date.now();
      run.status = 'failed';
      run.stopReason = 'restart';
      run.endedAt = now;
      run.error = 'host restarted or plugin reloaded while this expert run was active';
      await store.saveRun(project.id, run);
      changed = true;
      reconciled.push(`${project.id}/${run.id}`);
    }
    if (changed) {
      project.revision = (project.revision ?? 0) + 1;
      project.updatedAt = Date.now();
      await store.appendEvent(project, 'expert/runs_reconciled', { data: { count: reconciled.length } });
      await store.saveProject(project);
    }
  }
  return reconciled;
}
