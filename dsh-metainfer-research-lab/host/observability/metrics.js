/**
 * Host-computed metrics (observability requirement B1).
 *
 * The answer to "where is the time going" must come from the Host, not from an
 * agent summarizing logs. Two sources:
 *   - durable facts: run records (role, timestamps, usage, inputBytes) and cycle
 *     records (startedAt/endedAt), read with a bounded page;
 *   - live facts: the collector's ring buffer of dispatch latencies and
 *     snapshot sizes, plus the auto driver's pause counters.
 *
 * Everything here is pure or a bounded in-memory ring; no LLM, no full scan
 * beyond the page the caller explicitly requests.
 */

import { runnableSummary } from '../kernel/runnable.js';

const DEFAULT_RING = 200;

/** @returns {number|null} nearest-rank percentile. */
export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

export function summarizeDurations(values) {
  const list = (Array.isArray(values) ? values : []).filter((value) => Number.isFinite(value));
  if (list.length === 0) {
    return {
      count: 0, avg: null, p50: null, p90: null, p95: null, p99: null, max: null, min: null,
      avgMs: null, p50Ms: null, p90Ms: null, p95Ms: null, p99Ms: null, maxMs: null, minMs: null,
    };
  }
  const sum = list.reduce((total, value) => total + value, 0);
  const avg = Math.round(sum / list.length);
  const p50 = percentile(list, 50);
  const p90 = percentile(list, 90);
  const p95 = percentile(list, 95);
  const p99 = percentile(list, 99);
  const max = Math.max(...list);
  const min = Math.min(...list);
  return {
    count: list.length, avg, p50, p90, p95, p99, max, min,
    avgMs: avg, p50Ms: p50, p90Ms: p90, p95Ms: p95, p99Ms: p99, maxMs: max, minMs: min,
  };
}

export function estimateTokens(bytes) {
  return Math.ceil(Math.max(0, bytes) / 3.5);
}

/**
 * In-memory recorder for the hot facts. Per project, bounded rings.
 * @param {{clock?: () => number, ring?: number}} [options]
 */
export function createMetricsCollector({ clock = Date.now, ring = DEFAULT_RING } = {}) {
  const byProject = new Map();

  function entryFor(projectId) {
    let entry = byProject.get(projectId);
    if (!entry) {
      entry = {
        dispatch: [],
        dispatchQueueWait: [],
        dispatchDecisions: [],
        snapshotBytes: [],
        dispatchStarted: 0,
        dispatchSkipped: 0,
        skipReasons: {},
        lastDispatchAt: null,
        lastSnapshotAt: null,
      };
      byProject.set(projectId, entry);
    }
    return entry;
  }

  function push(list, value) {
    list.push(value);
    if (list.length > ring) list.splice(0, list.length - ring);
  }

  /** Record one `dispatchOnce` result (see host/dispatch/dispatch-once.js). */
  function recordDispatch(projectId, result) {
    if (!result || !Number.isFinite(result.durationMs)) return;
    const entry = entryFor(projectId);
    push(entry.dispatch, result.durationMs);
    entry.dispatchStarted += Number(result.started ?? 0);
    entry.dispatchSkipped += Array.isArray(result.skipped) ? result.skipped.length : 0;
    for (const skip of result.skipped ?? []) {
      const key = skip?.code ?? skip?.status ?? 'unknown';
      entry.skipReasons[key] = (entry.skipReasons[key] ?? 0) + 1;
    }
    for (const wait of Array.isArray(result.queueWaits) ? result.queueWaits : []) {
      if (Number.isFinite(wait?.waitMs)) push(entry.dispatchQueueWait, wait.waitMs);
    }
    for (const decision of Array.isArray(result.decisions) ? result.decisions : []) {
      push(entry.dispatchDecisions, {
        nodeId: decision?.nodeId ?? null,
        status: decision?.status ?? null,
        code: decision?.code ?? null,
        waitMs: Number.isFinite(decision?.waitMs) ? decision.waitMs : null,
        at: Number.isFinite(decision?.at) ? decision.at : clock(),
      });
    }
    entry.lastDispatchAt = clock();
  }

  /** Record the serialized advisor payload size (regression metric B3). */
  function recordSnapshot(projectId, bytes) {
    if (!Number.isFinite(bytes)) return;
    const entry = entryFor(projectId);
    push(entry.snapshotBytes, bytes);
    entry.lastSnapshotAt = clock();
  }

  function snapshot(projectId) {
    const entry = entryFor(projectId);
    const dispatch = summarizeDurations(entry.dispatch);
    const snapshots = summarizeDurations(entry.snapshotBytes);
    const queueWait = summarizeDurations(entry.dispatchQueueWait);
    return {
      dispatch: {
        ...dispatch,
        started: entry.dispatchStarted,
        skipped: entry.dispatchSkipped,
        skipReasons: { ...entry.skipReasons },
        queueWait,
        decisions: [...entry.dispatchDecisions],
        lastAt: entry.lastDispatchAt,
      },
      snapshotBytes: {
        ...snapshots,
        last: entry.snapshotBytes.at(-1) ?? null,
        lastAt: entry.lastSnapshotAt,
      },
    };
  }

  function reset(projectId) {
    byProject.delete(projectId);
  }

  return { recordDispatch, recordSnapshot, snapshot, reset };
}

/**
 * Per-role run metrics from run records (already bounded by the caller).
 * @param {object[]} runs
 */
export function roleMetrics(runs) {
  const byRole = {};
  for (const run of runs) {
    const role = run?.role ?? 'unknown';
    if (!byRole[role]) {
      byRole[role] = { runs: 0, failed: 0, durations: [], inputBytes: [], tokens: [] };
    }
    const bucket = byRole[role];
    bucket.runs += 1;
    if (run.status === 'failed') bucket.failed += 1;
    if (Number.isFinite(run.startedAt) && Number.isFinite(run.endedAt)) {
      bucket.durations.push(Math.max(0, run.endedAt - run.startedAt));
    }
    if (Number.isFinite(run.inputBytes)) bucket.inputBytes.push(run.inputBytes);
    if (Number.isFinite(run.usage?.totalTokens)) bucket.tokens.push(run.usage.totalTokens);
  }
  const out = {};
  for (const [role, bucket] of Object.entries(byRole)) {
    out[role] = {
      runs: bucket.runs,
      failed: bucket.failed,
      failRate: bucket.runs > 0 ? Number((bucket.failed / bucket.runs).toFixed(3)) : 0,
      duration: summarizeDurations(bucket.durations),
      inputBytes: summarizeDurations(bucket.inputBytes),
      tokens: summarizeDurations(bucket.tokens),
    };
  }
  return out;
}

/**
 * Assemble the metrics surface.
 * @param {object} input
 * @param {object} input.project
 * @param {object[]} input.nodes
 * @param {object[]} [input.runs]
 * @param {object[]} [input.cycles]
 * @param {object} [input.live] output of collector.snapshot()
 * @param {object} [input.auto] auto.statusOf()
 * @param {number} [input.now]
 * @param {number} [input.budgetBytes] snapshot byte budget
 */
export function computeProjectMetrics({
  project,
  nodes = [],
  runs = [],
  cycles = [],
  live = null,
  auto = null,
  now = Date.now(),
  budgetBytes = 12 * 1024,
  archived = 0,
}) {
  const hotNodes = (Array.isArray(nodes) ? nodes : []).filter((node) => !node?.archivedAt);
  const archivedCount = Math.max(0, Number(archived) || 0);
  const rawCounts = {};
  for (const node of hotNodes) rawCounts[node.status] = (rawCounts[node.status] ?? 0) + 1;
  // O4/O5: queue facts come from the one runnable definition (B8), never from
  // a raw `status === 'planned'` count. Deferred nodes are planned, but they are
  // not waiting to run: reporting them as queue depth recreates the Q5 bug on
  // the metrics surface.
  const runnableFacts = runnableSummary(hotNodes, { now });
  const deferredTotal = runnableFacts.deferred;
  const counts = {
    ...rawCounts,
    planned: runnableFacts.runnable,
    runnable: runnableFacts.runnable,
    claimed: runnableFacts.claimed,
    held: runnableFacts.held,
    deferred: deferredTotal,
    archived: archivedCount,
    total: hotNodes.length + archivedCount,
  };
  const cycleDurations = cycles
    .filter((cycle) => Number.isFinite(cycle.startedAt) && Number.isFinite(cycle.endedAt))
    .map((cycle) => Math.max(0, cycle.endedAt - cycle.startedAt));
  const roles = roleMetrics(runs);
  const advisor = roles.advisor ?? null;
  const snapshot = live?.snapshotBytes ?? null;
  const budget = budgetBytes;
  const p50Bytes = snapshot?.p50 ?? advisor?.inputBytes?.p50 ?? null;
  const p90Bytes = snapshot?.p90 ?? advisor?.inputBytes?.p90 ?? null;
  const tokenBudget = Number(project?.config?.auto?.maxTokens ?? 0);
  const p50Utilization = p50Bytes !== null && budget > 0 ? Number((p50Bytes / budget).toFixed(3)) : null;
  const p90Utilization = p90Bytes !== null && budget > 0 ? Number((p90Bytes / budget).toFixed(3)) : null;
  const utilization = snapshot?.last && budget > 0
    ? Number((snapshot.last / budget).toFixed(3))
    : p50Utilization;
  const cycle = {
    count: cycles.length,
    ...summarizeDurations(cycleDurations),
  };
  const byRole = roles;
  // B13/O2: one advisor object, rendered under both names. The legacy fields
  // are projections of the same values, not a second calculation.
  const advisorInput = {
    inputBytes: {
      p50: p50Bytes,
      p90: p90Bytes,
      max: snapshot?.max ?? advisor?.inputBytes?.max ?? null,
      last: snapshot?.last ?? advisor?.inputBytes?.last ?? null,
      budget,
      p50Utilization,
      p90Utilization,
    },
    tokens: {
      p50: advisor?.tokens?.p50 ?? null,
      p90: advisor?.tokens?.p90 ?? null,
      max: advisor?.tokens?.max ?? null,
      avg: advisor?.tokens?.avg ?? null,
    },
    budgetBytes: budget,
    tokenGuard: {
      maxTokens: tokenBudget,
      used: Number(project?.counters?.tokensUsed ?? 0),
      remaining: tokenBudget > 0 ? Math.max(0, tokenBudget - Number(project?.counters?.tokensUsed ?? 0)) : null,
    },
    lastBytes: snapshot?.last ?? advisor?.inputBytes?.last ?? null,
    maxBytes: snapshot?.max ?? advisor?.inputBytes?.max ?? null,
    p50Bytes,
    p90Bytes,
    avgTokens: advisor?.tokens?.avg ?? null,
    p50Tokens: advisor?.tokens?.p50 ?? null,
    p90Tokens: advisor?.tokens?.p90 ?? null,
    maxTokens: advisor?.tokens?.max ?? null,
    utilization,
    p50Utilization,
    p90Utilization,
    tokenBudget,
  };
  return {
    projectId: project?.id ?? null,
    generatedAt: now,
    revision: project?.revision ?? 0,
    counts,
    queue: {
      depth: runnableFacts.runnable,
      runnable: runnableFacts.runnable,
      claimed: runnableFacts.claimed,
      held: runnableFacts.held,
      deferred: deferredTotal,
      remainingMs: runnableFacts.remainingMs,
      total: runnableFacts.total,
      running: rawCounts.running ?? 0,
      planned: runnableFacts.runnable,
      failed: rawCounts.failed ?? 0,
      proposed: rawCounts.proposed ?? 0,
    },
    cycle,
    cycles: cycle,
    // Compatibility aliases point at the same objects so a single response
    // cannot grow two divergent truths.
    byRole,
    roles: byRole,
    advisor: advisorInput,
    advisorInput,
    dispatch: live?.dispatch ?? {
      count: 0, avgMs: null, p50Ms: null, p90Ms: null, p95Ms: null, p99Ms: null, maxMs: null,
      started: 0, skipped: 0, skipReasons: {}, queueWait: summarizeDurations([]), decisions: [], lastAt: null,
    },
    stalls: {
      pauses: auto?.pauseCounts ?? {},
      noProgress: auto?.pauseCounts?.noProgress ?? 0,
      deadlock: auto?.pauseCounts?.deadlock ?? 0,
      errors: auto?.pauseCounts?.errors ?? 0,
      driverStatus: auto?.status ?? null,
      pauseReason: auto?.pauseReason ?? null,
      blockedBy: Array.isArray(auto?.blockedBy) ? auto.blockedBy : [],
      idleStreak: auto?.idleStreak ?? 0,
      errorStreak: auto?.errorStreak ?? 0,
      throttledStreak: auto?.throttledStreak ?? 0,
      quotaBackoff: auto?.pauseCounts?.quota_backoff ?? 0,
      resumeAt: auto?.resumeAt ?? 0,
      quotaRemaining: auto?.quotaRemaining ?? null,
    },
    planning: auto?.planning ?? null,
  };
}
