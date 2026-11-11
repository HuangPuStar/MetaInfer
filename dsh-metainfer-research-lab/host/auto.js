/**
 * M4 auto mode: periodically drives manual Step cycles while the project is in
 * auto mode, with budgets, idle/error breakers, and a `waiting` state for the
 * human-confirmation mode (waiting proposals never block running nodes).
 */
import { LabError } from './git-engine.js';
import { isDeferredNode, runnableQueue, runnableSummary } from './kernel/runnable.js';
import { createLowWaterPlanner, planningConfigOf } from './dispatch/low-water.js';
import { anyFits, capacityOf } from './kernel/capacity.js';

export const LEAD_RETRY_BACKOFF_BASE_MS = 60_000;
export const LEAD_RETRY_BACKOFF_MAX_MS = 300_000;

/** Round 35: exponential lead-failure backoff, capped at five minutes. */
export function leadRetryBackoffMs(streak) {
  const count = Math.max(1, Math.min(10, Number(streak) || 1));
  return Math.min(LEAD_RETRY_BACKOFF_MAX_MS, LEAD_RETRY_BACKOFF_BASE_MS * 2 ** (count - 1));
}

function leadFailureInCycle(cycle) {
  return (Array.isArray(cycle?.errors) ? cycle.errors : []).some((error) => /^lead\b/.test(String(error)));
}

function newNodeCount(nodes) {
  // Q5: a deferred (pruned) node is still in the DAG for restoration, but it
  // must not consume a hot-node slot. Counting `nodes.length` let 40 pruned
  // nodes permanently freeze the advisor's maxNodes budget.
  return nodes.filter((node) => !isDeferredNode(node)).length;
}

/**
 * Queue cap (QA Q3 mechanism B): `max(2 * freeSlots, 4)` by default. A deep
 * queue must not make the advisor plan even deeper; it only spends a model pass
 * on more work that cannot start. The cap is configurable per project for
 * experiments, but the default is derived from present capacity, not a magic
 * global number.
 *
 * @param {object} project
 * @param {{ runningCount: number }} capacity
 */
export function maxPlannedInFlightOf(project, capacity) {
  const configured = Number(project?.config?.maxPlannedInFlight);
  if (Number.isFinite(configured) && configured >= 1) return Math.floor(configured);
  const maxRunning = Number(project?.config?.maxRunningNodes ?? 4);
  const freeSlots = Math.max(0, (Number.isFinite(maxRunning) ? maxRunning : 4) - (capacity?.runningCount ?? 0));
  return Math.max(2 * freeSlots, 4);
}

/**
 * @param {{ctx: object, store: object, orchestrator: object, intervalMs?: number}} deps
 */
export function createAutoController({ store, kernel, orchestrator, cluster, dispatchOnce = null, intervalMs = 2000 }) {
  const states = new Map();
  const busy = new Set();
  const planners = new Map();
  let timer = null;

  /**
   * Planner trigger per project (QA Q7): plan when the remaining runnable work
   * drops below the measured planner latency, not when the queue is already
   * empty. The planner is rebuilt when its config changes.
   */
  function plannerOf(project) {
    const config = planningConfigOf(project);
    const key = JSON.stringify(config);
    const cached = planners.get(project.id);
    if (cached && cached.key === key) return cached.planner;
    const planner = createLowWaterPlanner({
      getRemainingMs: () => runnableSummary(store.listNodes(project.id), { now: Date.now() }).remainingMs,
      getQueueDepth: () => runnableSummary(store.listNodes(project.id), { now: Date.now() }).runnable,
      ...config,
    });
    planners.set(project.id, { key, planner });
    return planner;
  }

  function projectOf(projectId) {
    const project = store.getProject(projectId);
    if (!project) throw new LabError('project_not_found', `unknown project: ${projectId}`, 404);
    return project;
  }

  function stateOf(projectId) {
    const project = store.getProject(projectId);
    let state = states.get(projectId);
    if (!state) {
      // O6: streak counters and the last pause survive a Host restart. The
      // driver still comes back paused (a restart must not silently resume
      // work), but the audit counters are not reset to zero.
      const persisted = project?.autoState && typeof project.autoState === 'object' ? project.autoState : {};
      state = {
        status: project?.mode === 'auto' ? 'paused' : 'off',
        pauseReason: project?.mode === 'auto' ? (persisted.pauseReason ?? 'hostRestarted') : null,
        startedAt: Number.isFinite(persisted.startedAt) ? persisted.startedAt : null,
        cycles: Number.isFinite(persisted.cycles) ? persisted.cycles : 0,
        idleStreak: Number.isFinite(persisted.idleStreak) ? persisted.idleStreak : 0,
        errorStreak: Number.isFinite(persisted.errorStreak) ? persisted.errorStreak : 0,
        lastCycleAt: Number.isFinite(persisted.lastCycleAt) ? persisted.lastCycleAt : 0,
        lastPlanSkip: persisted.lastPlanSkip ?? null,
        lastPauseAt: Number.isFinite(persisted.lastPauseAt) ? persisted.lastPauseAt : null,
        pauseCounts: persisted.pauseCounts && typeof persisted.pauseCounts === 'object' ? { ...persisted.pauseCounts } : {},
        leadFailureStreak: Number.isFinite(persisted.leadFailureStreak) ? persisted.leadFailureStreak : 0,
        leadBackoffUntil: Number.isFinite(persisted.leadBackoffUntil) ? persisted.leadBackoffUntil : 0,
        lastLeadFailureAt: Number.isFinite(persisted.lastLeadFailureAt) ? persisted.lastLeadFailureAt : null,
        lastLeadError: typeof persisted.lastLeadError === 'string' ? persisted.lastLeadError : null,
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
      lastPlanSkip: state.lastPlanSkip,
      lastPauseAt: state.lastPauseAt ?? null,
      pauseCounts: { ...state.pauseCounts },
      lastDispatch: state.lastDispatch ?? null,
      dispatchStarted: state.dispatchStarted ?? 0,
      leadFailureStreak: state.leadFailureStreak ?? 0,
      leadBackoffUntil: state.leadBackoffUntil ?? 0,
      lastLeadFailureAt: state.lastLeadFailureAt ?? null,
      lastLeadError: state.lastLeadError ?? null,
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
    if (!kernel?.executor) throw new LabError('unavailable', 'auto controller requires kernel.executor', 503);
    const state = stateOf(project.id);
    const result = await kernel.executor.commit(project.id, {
      actor: { kind: 'system', id: 'auto' },
      causeId: `${type}:${project.id}`,
      mutations: [
        { op: 'event.record', type, data },
        // O6: the event is the audit trail; autoState is the restart read model.
        { op: 'project.update', set: { autoState: {
          status: state.status,
          pauseReason: state.pauseReason,
          startedAt: state.startedAt,
          cycles: state.cycles,
          idleStreak: state.idleStreak,
          errorStreak: state.errorStreak,
          lastCycleAt: state.lastCycleAt,
          lastPlanSkip: state.lastPlanSkip,
          lastPauseAt: state.lastPauseAt ?? null,
          pauseCounts: { ...state.pauseCounts },
          leadFailureStreak: state.leadFailureStreak ?? 0,
          leadBackoffUntil: state.leadBackoffUntil ?? 0,
          lastLeadFailureAt: state.lastLeadFailureAt ?? null,
          lastLeadError: state.lastLeadError ?? null,
        } } },
      ],
    });
    if (result.ok !== true) throw new LabError(result.code ?? 'commit_failed', result.message ?? 'auto event commit failed', 500);
  }

  async function pause(projectId, reason) {
    const state = stateOf(projectId);
    if (state.status === 'paused' && state.pauseReason === reason) return;
    state.status = 'paused';
    state.pauseReason = reason;
    state.pauseCounts[reason] = (state.pauseCounts[reason] ?? 0) + 1;
    state.lastPauseAt = Date.now();
    const project = store.getProject(projectId);
    if (project) await saveEvent(project, 'auto/paused', { reason });
  }

  async function waiting(projectId, reason) {
    const state = stateOf(projectId);
    if (state.status === 'waiting') return;
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
    state.startedAt = Date.now();
    state.cycles = 0;
    state.idleStreak = 0;
    state.errorStreak = 0;
    state.lastCycleAt = 0;
    state.pauseCounts = {};
    state.leadFailureStreak = 0;
    state.leadBackoffUntil = 0;
    state.lastLeadFailureAt = null;
    state.lastLeadError = null;
    planners.delete(projectId);
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
    // A manual resume is an explicit "try again", so it must clear the failure
    // streak: the breaker pauses at errorStreak >= 3 and would otherwise re-pause
    // on the very next tick, making auto_resume look like a no-op.
    state.errorStreak = 0;
    state.leadFailureStreak = 0;
    state.leadBackoffUntil = 0;
    state.lastLeadFailureAt = null;
    state.lastLeadError = null;
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
      return (node.review?.reviewedHeadCommit ?? null) !== (node.git?.headCommit ?? null);
    });
  }

  async function tickOne(projectId) {
    if (busy.has(projectId)) return;
    const state = stateOf(projectId);
    if (state.status !== 'running') return;
    const project = store.getProject(projectId);
    if (!project) return;
    const auto = project.config.auto ?? {};
    const nodes = store.listNodes(projectId);

    // --- breakers ----------------------------------------------------------
    if (state.cycles >= (auto.maxCycles ?? 50)) return pause(projectId, 'maxCycles');
    if (state.startedAt && Date.now() - state.startedAt >= (auto.maxWallClockMs ?? 6 * 60 * 60 * 1000)) {
      return pause(projectId, 'maxWallClock');
    }
    const maxDeferred = project.config.maxDeferred ?? 20;
    if (nodes.filter((node) => isDeferredNode(node) && !node.archivedAt).length > maxDeferred) return pause(projectId, 'maxDeferred');
    if (newNodeCount(nodes) >= (project.config.maxNodes ?? 60)) return pause(projectId, 'maxNodes');
    const tokenLimit = auto.maxTokens ?? 0;
    if (tokenLimit > 0 && tokensUsed(projectId) >= tokenLimit) return pause(projectId, 'maxTokens');
    const costLimit = auto.maxCostUsd ?? 0;
    if (costLimit > 0 && costUsed(projectId) >= costLimit) return pause(projectId, 'maxCost');
    if (state.errorStreak >= 3) return pause(projectId, 'errors');

    const running = nodes.filter((node) => node.status === 'running');
    // One definition of the executable queue (B8): deferred nodes are planned
    // but never runnable, so they must not keep `canRunPlanned` true. Counting
    // them was the mechanism behind the nine-hour `noProgress` pause (QA Q5).
    const runnable = runnableQueue(nodes);
    const proposed = nodes.filter((node) => node.status === 'proposed');
    const actionables = actionableLeaves(project, nodes);

    // Cluster mode: a queued GPU node means waiting for the coordinator, not an
    // idle project. Do not burn cycles while the lease queue is pending/blocked.
    if (cluster?.enabled === true) {
      if (runnable.some((node) => node.resourceWait)) {
        return waiting(projectId, 'awaitingGpu');
      }
      const gpuPlanned = runnable.filter((node) => Number(node.needs?.gpu ?? 0) > 0);
      if (gpuPlanned.length > 0) {
        const clusterStatus = cluster.getStatus();
        const freeGpu = clusterStatus?.pools?.gpu?.free;
        if (freeGpu === 0) return waiting(projectId, 'awaitingGpu');
      }
    }

    const capacity = capacityOf(project, nodes, cluster);
    const summary = runnableSummary(nodes, { now: Date.now() });
    const plannedLimit = maxPlannedInFlightOf(project, capacity);
    const plannedInFlight = summary.runnable + summary.claimed + summary.held;
    const wipFull = plannedInFlight >= plannedLimit;
    state.lastPlanSkip = wipFull ? 'maxPlannedInFlight' : null;
    const planner = plannerOf(project);
    const trigger = planner.evaluate({ remainingMs: summary.remainingMs, queueDepth: summary.runnable });

    // Deterministic fast path (B3/B10): fill free slots without a model call.
    // Only when it actually starts something do we skip the planning cycle;
    // otherwise the cycle still runs so a waiting expert can be consulted.
    if (typeof dispatchOnce === 'function' && !busy.has(projectId)) {
      try {
        const round = await dispatchOnce(projectId, { maxStarts: 4 });
        if (round?.started > 0) {
          busy.add(projectId);
          try {
            state.dispatchStarted = (state.dispatchStarted ?? 0) + round.started;
            state.lastDispatch = { started: round.started, skipped: round.skipped?.length ?? 0, durationMs: round.durationMs ?? null, at: Date.now() };
            state.lastDispatchAt = Date.now();
            state.lastCycleAt = Date.now();
            state.idleStreak = 0;
          } finally {
            busy.delete(projectId);
          }
          return undefined;
        }
        if (round) state.lastDispatch = { started: round.started, skipped: round.skipped?.length ?? 0, durationMs: round.durationMs ?? null, at: Date.now() };
      } catch {
        // Dispatch is best-effort on the tick; the cycle below still runs.
      }
    }
    // Unreviewed completed leaves are always worth planning for; queue depth is
    // paced by the low-water trigger so a long-running batch is not replanned
    // every tick. An empty queue is also a planning event, not an immediate
    // `idle` pause: the advisor/hierarchy pass must get a cycle to decide
    // whether it has a proposal. Only a completed planning cycle increments
    // idleStreak, so idleCycleLimit counts real no-proposal passes.
    const empty = running.length === 0 && runnable.length === 0 && proposed.length === 0;
    // Round 33: existing BranchReports can still hold candidates after every
    // branch event has been consumed. That is a planning signal even while
    // other nodes run, so it must be checked before deciding not to plan.
    let pendingCandidates = 0;
    try {
      pendingCandidates = Number(orchestrator.pendingCandidateCount?.(project.id) ?? 0);
    } catch {
      pendingCandidates = 0;
    }
    const shouldPlan = !wipFull && (actionables.length > 0 || trigger.trigger || empty || pendingCandidates > 0);

    if (!shouldPlan) {
      if (proposed.length > 0) return waiting(projectId, 'awaitingConfirmation');
      if (runnable.length > 0 && !anyFits(runnable, capacity)) return waiting(projectId, 'capacityFull');
      return undefined; // queue is healthy: let dispatchOnce keep the slots full
    }
    if (state.leadBackoffUntil > Date.now()) {
      const seconds = Math.max(1, Math.ceil((state.leadBackoffUntil - Date.now()) / 1000));
      state.lastPlanSkip = `lead retry backoff; ${seconds}s remaining${state.lastLeadError ? `; last error: ${state.lastLeadError}` : ''}`;
      return undefined;
    }

    busy.add(projectId);
    planner.beginPlanning();
    try {
      const result = await orchestrator.step(projectId, trigger.trigger ? 'low_water' : 'auto');
      state.cycles += 1;
      state.lastCycleAt = Date.now();
      planner.endPlanning({ created: result.created.length, started: result.started.length });
      const progress = result.created.length + result.started.length;
      state.idleStreak = progress === 0 ? state.idleStreak + 1 : 0;
      if (progress === 0) {
        const skipped = Array.isArray(result.skipped) ? result.skipped : [];
        state.lastPlanSkip = result.cycle?.candidates?.skipReason
          ?? result.cycle?.candidateStats?.skipReason
          ?? skipped.find((row) => row?.stage === 'advisor')?.reason
          ?? skipped.find((row) => typeof row?.reason === 'string')?.reason
          ?? 'noProposal';
      } else {
        state.lastPlanSkip = null;
      }
      state.errorStreak = result.errors.length > 0 ? state.errorStreak + 1 : 0;
      if (leadFailureInCycle(result.cycle)) {
        const streak = (state.leadFailureStreak ?? 0) + 1;
        state.leadFailureStreak = streak;
        state.lastLeadFailureAt = Date.now();
        state.leadBackoffUntil = state.lastLeadFailureAt + leadRetryBackoffMs(streak);
        state.lastLeadError = result.errors.find((error) => /^lead\b/.test(String(error))) ?? 'lead failed';
        state.lastPlanSkip = `lead retry backoff; ${Math.round(leadRetryBackoffMs(streak) / 1000)}s after: ${state.lastLeadError}`;
      } else {
        state.leadFailureStreak = 0;
        state.leadBackoffUntil = 0;
        state.lastLeadError = null;
      }
      const fresh = store.getProject(projectId);
      if (!fresh) return undefined;
      if (state.cycles >= (auto.maxCycles ?? 50)) return pause(projectId, 'maxCycles');
      if (Date.now() - (state.startedAt ?? Date.now()) >= (auto.maxWallClockMs ?? 6 * 60 * 60 * 1000)) {
        return pause(projectId, 'maxWallClock');
      }
      if (state.idleStreak >= (auto.idleCycleLimit ?? 3)) return pause(projectId, 'noProgress');
      if (state.errorStreak >= 3) return pause(projectId, 'errors');
      return undefined;
    } catch (error) {
      planner.endPlanning({});
      if (error instanceof LabError && error.code === 'cycle_busy') return undefined;
      state.errorStreak += 1;
      if (state.errorStreak >= 3) await pause(projectId, 'errors');
      return undefined;
    } finally {
      busy.delete(projectId);
    }
  }

  async function tick() {
    for (const project of store.listProjects()) {
      if (project.mode !== 'auto') continue;
      const state = stateOf(project.id);
      if (state.status === 'running') await tickOne(project.id);
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
    planners.delete(projectId);
  }

  function dispose() {
    if (timer) clearInterval(timer);
    timer = null;
    busy.clear();
    planners.clear();
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
