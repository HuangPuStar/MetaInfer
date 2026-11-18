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
      if (node.status !== 'running' && !pendingRemote) continue;
      // A previously held cold node remains held without rewriting its history on every reload.
      if (node.status !== 'running' && node.sandboxGate?.code === 'sandbox_restart_held'
        && !Object.values(operations).some(row => row?.state === 'intent')) continue;
      const now = Date.now();
      const wasRunning = node.status === 'running';
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
      if (wasRunning) node.status = 'failed';
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
      node.error ??= { message: remote
        ? 'Host restarted; sandbox outcome/cleanup requires explicit reconciliation, not a local process proof.'
        : 'host restarted or plugin reloaded while this node was running; the node was marked failed', at: now, stage: 'run' };
      node.termination = {
        ...(node.termination ?? {}), kind: node.termination?.kind ?? 'restart',
        requestedAt: node.termination?.requestedAt ?? now,
        killedAt: remote ? (node.termination?.killedAt ?? null) : now,
        killedPids: node.termination?.killedPids ?? [], killedJobs: node.termination?.killedJobs ?? [],
        gpuFreed: clean, verifiedClean: clean,
        leftover: remote && (!clean || unresolved) ? ['sandbox proof held; unresolved operation identities are preserved on the binding'] : [],
        ...(remote ? { proofScope: clean ? 'existing exact remote physical cleanup only' : 'remote physical cleanup unconfirmed', reconciledAfterRestart: true } : {}),
      };
      node.timestamps = { ...(node.timestamps ?? {}), completedAt: node.timestamps?.completedAt ?? now, lastActivityAt: now };
      const result = await kernel.executor.commit(project.id, {
        actor: { kind: 'system', id: 'reconcile' }, causeId: `reconcile:${node.id}`,
        ...(Number.isInteger(node.rev) ? { basis: node.rev } : {}),
        mutations: [{ op: 'node.put', nodeId: node.id, node,
          eventType: remote && node.sandboxGate ? 'node/sandbox_reconcile_held' : 'node/failed',
          eventData: { stage: 'run', message: node.error.message, restart: true, ...(remote ? { verifiedClean: clean, admissionHeld: Boolean(node.sandboxGate) } : {}) } }],
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
