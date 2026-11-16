/**
 * M4 auto mode: periodically drives manual Step cycles while the project is in
 * auto mode, with budgets, idle/error breakers, and a `waiting` state for the
 * human-confirmation mode (waiting proposals never block running nodes).
 */
import { LabError } from './git-engine.js';
import { reportVersion } from './snapshot.js';

function newNodeCount(nodes) {
  return nodes.length;
}

/**
 * @param {{ctx: object, store: object, orchestrator: object, intervalMs?: number}} deps
 */
export function createAutoController({ store, orchestrator, cluster, intervalMs = 2000 }) {
  const states = new Map();
  const busy = new Set();
  let timer = null;

  function projectOf(projectId) {
    const project = store.getProject(projectId);
    if (!project) throw new LabError('project_not_found', `unknown project: ${projectId}`, 404);
    return project;
  }

  function stateOf(projectId) {
    const project = store.getProject(projectId);
    let state = states.get(projectId);
    if (!state) {
      state = {
        status: project?.mode === 'auto' ? 'paused' : 'off',
        pauseReason: project?.mode === 'auto' ? 'hostRestarted' : null,
        startedAt: null,
        cycles: 0,
        idleStreak: 0,
        errorStreak: 0,
        lastCycleAt: 0,
      };
      states.set(projectId, state);
    }
    return state;
  }

  function tokensUsed(projectId) {
    const nodes = store.listNodes(projectId);
    const runs = store.listRuns(projectId, 200);
    const sum = (items) => items.reduce((total, item) => total + (item.usage?.totalTokens ?? 0), 0);
    return sum(nodes) + sum(runs);
  }

  function costUsed(projectId) {
    const nodes = store.listNodes(projectId);
    const sum = nodes.reduce((total, node) => total + (node.costUsd ?? 0), 0);
    return Math.round(sum * 1e6) / 1e6;
  }

  function statusOf(projectId) {
    const project = store.getProject(projectId);
    const state = stateOf(projectId);
    const auto = project?.config?.auto ?? {};
    return {
      status: state.status,
      pauseReason: state.pauseReason,
      startedAt: state.startedAt,
      cycles: state.cycles,
      idleStreak: state.idleStreak,
      errorStreak: state.errorStreak,
      lastCycleAt: state.lastCycleAt,
      tokensUsed: tokensUsed(projectId),
      costUsed: costUsed(projectId),
      limits: {
        maxCycles: auto.maxCycles ?? 50,
        maxWallClockMs: auto.maxWallClockMs ?? 6 * 60 * 60 * 1000,
        idleCycleLimit: auto.idleCycleLimit ?? 3,
        maxNodes: project?.config?.maxNodes ?? 60,
        maxTokens: auto.maxTokens ?? 0,
        maxCostUsd: auto.maxCostUsd ?? 0,
      },
    };
  }

  async function saveEvent(project, type, data) {
    await store.appendEvent(project, type, { data });
    project.revision = (project.revision ?? 0) + 1;
    project.updatedAt = Date.now();
    await store.saveProject(project);
  }

  async function pause(projectId, reason) {
    const state = stateOf(projectId);
    if (state.status === 'paused' && state.pauseReason === reason) return;
    state.status = 'paused';
    state.pauseReason = reason;
    const project = store.getProject(projectId);
    if (project) await saveEvent(project, 'auto/paused', { reason });
  }

  async function waiting(projectId, reason) {
    const state = stateOf(projectId);
    if (state.status === 'waiting' && state.pauseReason === reason) return;
    state.status = 'waiting';
    state.pauseReason = reason;
    const project = store.getProject(projectId);
    if (project) await saveEvent(project, 'auto/waiting', { reason });
  }

  async function start(projectId) {
    const project = projectOf(projectId);
    const state = stateOf(projectId);
    state.status = 'running';
    state.pauseReason = null;
    // Re-entering auto is not a new budget: stop/start and resume may reset
    // consecutive streaks, never elapsed time or already consumed cycles.
    if (!state.startedAt) state.startedAt = Date.now();
    state.idleStreak = 0;
    state.errorStreak = 0;
    project.mode = 'auto';
    await saveEvent(project, 'auto/started', { at: state.startedAt });
    void tickOne(projectId);
    return statusOf(projectId);
  }

  async function stop(projectId) {
    const project = projectOf(projectId);
    const state = stateOf(projectId);
    state.status = 'off';
    state.pauseReason = null;
    project.mode = 'manual';
    await saveEvent(project, 'auto/stopped', {});
    try {
      await orchestrator?.cancelProjectRuns?.(projectId);
    } catch {
      // Auto stop must still succeed if a run is already gone.
    }
    return statusOf(projectId);
  }

  async function resume(projectId) {
    const state = stateOf(projectId);
    if (state.status === 'off') return start(projectId);
    state.status = 'running';
    state.pauseReason = null;
    state.idleStreak = 0;
    state.errorStreak = 0;
    if (!state.startedAt) state.startedAt = Date.now();
    return statusOf(projectId);
  }

  /** Called after user actions (approve/reject/resume) to avoid waiting a full tick. */
  function notifyChange(projectId) {
    const state = stateOf(projectId);
    if (state.status === 'waiting') {
      state.status = 'running';
      state.pauseReason = null;
    }
    if (state.status === 'running') void tickOne(projectId);
  }

  function capacityFor(project, nodes, cluster) {
    const running = nodes.filter((node) => node.status === 'running');
    const held = {};
    for (const node of running) {
      for (const [key, amount] of Object.entries(node.resourcesHeld ?? {})) {
        held[key] = (held[key] ?? 0) + amount;
      }
    }
    const free = {};
    for (const [key, total] of Object.entries(project.config.resourcePools ?? {})) {
      free[key] = Math.max(0, total - (held[key] ?? 0));
    }
    let canStart = running.length < (project.config.maxRunningNodes ?? 4);
    if (cluster?.enabled === true) {
      const status = cluster.getStatus?.() ?? {};
      const gpuFree = Number(status.pools?.gpu?.free);
      if (Number.isFinite(gpuFree)) free.gpu = gpuFree;
      const quota = Math.max(0, Number(project.config.resourcePools?.gpu ?? 0));
      if (quota > 0) {
        const heldGpu = running.reduce(
          (sum, node) => sum + Math.max(0, Number(node.resourcesHeld?.gpu ?? 0)),
          0,
        );
        if (heldGpu >= quota) canStart = false;
        free.gpu = Math.min(free.gpu ?? quota, Math.max(0, quota - heldGpu));
      }
    }
    return { runningCount: running.length, canStart, free };
  }

  function plannedFits(project, planned, capacity) {
    return planned.some((node) => {
      if (!capacity.canStart || node.resourceWait) return false;
      return Object.entries(node.needs ?? {}).every(([key, amount]) => (capacity.free[key] ?? 0) >= amount);
    });
  }

  function actionableLeaves(project, nodes) {
    const children = new Set();
    for (const node of nodes) {
      if (node.status === 'proposed') continue;
      const ids = Array.isArray(node.parentIds) && node.parentIds.length > 0
        ? node.parentIds
        : (node.parentId ? [node.parentId] : []);
      for (const id of ids) children.add(id);
    }
    const pendingParents = new Set(nodes.filter((node) => node.status === 'proposed').map((node) => node.parentId));
    return nodes.filter((node) => {
      if (node.status !== 'completed') return false;
      if (children.has(node.id)) return false;
      if (pendingParents.has(node.id)) return false;
      return (node.review?.reviewedHeadCommit ?? null) !== (node.git?.headCommit ?? null)
        || node.review?.reviewedReportVersion !== reportVersion(node);
    });
  }

  function budgetReason(project, nodes, state) {
    const auto = project.config.auto ?? {};
    if (state.cycles >= (auto.maxCycles ?? 50)) return 'maxCycles';
    if (state.startedAt && Date.now() - state.startedAt >= (auto.maxWallClockMs ?? 6 * 60 * 60 * 1000)) {
      return 'maxWallClock';
    }
    if (newNodeCount(nodes) >= (project.config.maxNodes ?? 60)) return 'maxNodes';
    if ((auto.maxTokens ?? 0) > 0 && tokensUsed(project.id) >= auto.maxTokens) return 'maxTokens';
    if ((auto.maxCostUsd ?? 0) > 0 && costUsed(project.id) >= auto.maxCostUsd) return 'maxCost';
    return null;
  }

  function pendingRoles(projectId) {
    return store.listRuns(projectId, 200).some((run) => run.status === 'running'
      && (run.role === 'advisor' || run.role === 'scheduler'));
  }

  async function tickOne(projectId) {
    if (busy.has(projectId)) return;
    const state = stateOf(projectId);
    if (state.status !== 'running' && state.status !== 'waiting') return;
    const project = store.getProject(projectId);
    if (!project) return;
    const nodes = store.listNodes(projectId);
    const limit = budgetReason(project, nodes, state);
    if (limit) return pause(projectId, limit);
    if (state.errorStreak >= 3) return pause(projectId, 'errors');
    // A manual Step may already own the role cycle. It is pending work, not idle.
    if (pendingRoles(projectId)) {
      state.idleStreak = 0;
      state.status = 'running';
      state.pauseReason = null;
      return;
    }

    const running = nodes.filter((node) => node.status === 'running');
    const planned = nodes.filter((node) => node.status === 'planned');
    const proposed = nodes.filter((node) => node.status === 'proposed');
    const actionables = actionableLeaves(project, nodes);
    const capacity = capacityFor(project, nodes, cluster);
    const canRunPlanned = planned.length > 0 && plannedFits(project, planned, capacity);

    if (actionables.length === 0 && !canRunPlanned) {
      state.idleStreak = 0;
      if (proposed.length > 0) return waiting(projectId, 'awaitingConfirmation');
      if (planned.length > 0) return waiting(projectId, 'resourcesQueued');
      if (running.length === 0) return pause(projectId, 'idle');
      state.status = 'running';
      state.pauseReason = null;
      return undefined; // a worker is still producing evidence
    }

    state.status = 'running';
    state.pauseReason = null;
    busy.add(projectId);
    try {
      // Freeze values, not node references: a fast follow-up can finish while
      // Step still reviews the previous evidence, even at the same Git head.
      const workBefore = new Map(nodes.map((node) => [node.id, {
        status: node.status,
        headCommit: node.git?.headCommit ?? null,
        reportVersion: reportVersion(node),
      }]));
      const result = await orchestrator.step(projectId, 'auto');
      state.cycles += 1;
      state.lastCycleAt = Date.now();
      const progress = result.created.length + result.started.length;
      const hasErrors = result.errors.length > 0;
      state.errorStreak = hasErrors ? state.errorStreak + 1 : 0;
      if (hasErrors || progress > 0) state.idleStreak = 0;
      // Stop/pause is explicit. Finishing an in-flight cycle never resumes it.
      if (state.status !== 'running' && state.status !== 'waiting') return undefined;
      const fresh = store.getProject(projectId);
      if (!fresh) return undefined;
      const freshNodes = store.listNodes(projectId);
      const freshLimit = budgetReason(fresh, freshNodes, state);
      if (freshLimit) return pause(projectId, freshLimit);
      if (hasErrors) {
        if (state.errorStreak >= 3) return pause(projectId, 'errors');
        return undefined;
      }
      if (progress > 0) return undefined;

      // A zero-output cycle is not necessarily no progress: workers, role
      // reviews, proposals and resource requests each have their own lifecycle.
      const freshPlanned = freshNodes.filter((node) => node.status === 'planned');
      const canRun = plannedFits(fresh, freshPlanned, capacityFor(fresh, freshNodes, cluster));
      if (freshNodes.some((node) => node.status === 'running') || pendingRoles(projectId)) {
        state.idleStreak = 0;
        return undefined;
      }
      if (freshNodes.some((node) => node.status === 'proposed') && !canRun) {
        state.idleStreak = 0;
        return waiting(projectId, 'awaitingConfirmation');
      }
      if (freshPlanned.length > 0 && !canRun) {
        state.idleStreak = 0;
        return waiting(projectId, 'resourcesQueued');
      }
      const freshActionables = actionableLeaves(fresh, freshNodes);
      const workChanged = freshNodes.some((node) => {
        const before = workBefore.get(node.id);
        return !before || before.status !== node.status
          || before.headCommit !== (node.git?.headCommit ?? null)
          || before.reportVersion !== reportVersion(node);
      });
      if (workChanged && (freshActionables.length > 0 || canRun)) {
        state.idleStreak = 0;
        return undefined; // the next cycle must see the new evidence/work
      }
      if (result.needUserDecision === true && !canRun) {
        state.idleStreak = 0;
        return pause(projectId, 'needsUserDecision');
      }
      if (freshActionables.length === 0 && !canRun) {
        state.idleStreak = 0;
        return pause(projectId, 'idle');
      }
      state.idleStreak += 1;
      if (state.idleStreak >= (fresh.config.auto?.idleCycleLimit ?? 3)) return pause(projectId, 'noProgress');
      return undefined;
    } catch (error) {
      if (error instanceof LabError && error.code === 'cycle_busy') {
        state.idleStreak = 0;
        return undefined;
      }
      state.idleStreak = 0;
      state.errorStreak += 1;
      if (state.errorStreak >= 3 && state.status === 'running') await pause(projectId, 'errors');
      return undefined;
    } finally {
      busy.delete(projectId);
    }
  }

  async function tick() {
    for (const project of store.listProjects()) {
      if (project.mode !== 'auto') continue;
      const state = stateOf(project.id);
      if (state.status === 'running' || state.status === 'waiting') await tickOne(project.id);
    }
  }

  function startTimer() {
    if (timer) return;
    timer = setInterval(() => {
      tick().catch(() => {});
    }, intervalMs);
    timer.unref?.();
  }

  function forget(projectId) {
    states.delete(projectId);
    busy.delete(projectId);
  }

  function dispose() {
    if (timer) clearInterval(timer);
    timer = null;
    busy.clear();
  }

  return {
    start,
    stop,
    resume,
    notifyChange,
    statusOf,
    forget,
    tick,
    startTimer,
    dispose,
  };
}
