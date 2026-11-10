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
  if (list.length === 0) return { count: 0, avg: null, p95: null, max: null, min: null, avgMs: null, p95Ms: null, maxMs: null, minMs: null };
  const sum = list.reduce((total, value) => total + value, 0);
  const avg = Math.round(sum / list.length);
  const p95 = percentile(list, 95);
  const max = Math.max(...list);
  const min = Math.min(...list);
  return { count: list.length, avg, p95, max, min, avgMs: avg, p95Ms: p95, maxMs: max, minMs: min };
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
    return {
      dispatch: {
        ...dispatch,
        started: entry.dispatchStarted,
        skipped: entry.dispatchSkipped,
        skipReasons: { ...entry.skipReasons },
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
}) {
  const counts = {};
  const runnable = [];
  let queueDepth = 0;
  for (const node of nodes) {
    counts[node.status] = (counts[node.status] ?? 0) + 1;
    if (node.status === 'planned') {
      queueDepth += 1;
      runnable.push(node);
    }
  }
  const cycleDurations = cycles
    .filter((cycle) => Number.isFinite(cycle.startedAt) && Number.isFinite(cycle.endedAt))
    .map((cycle) => Math.max(0, cycle.endedAt - cycle.startedAt));
  const roles = roleMetrics(runs);
  const advisor = roles.advisor ?? null;
  const snapshot = live?.snapshotBytes ?? null;
  const budget = budgetBytes;
  return {
    projectId: project?.id ?? null,
    generatedAt: now,
    revision: project?.revision ?? 0,
    counts: { ...counts, total: nodes.length },
    queue: {
      depth: queueDepth,
      running: counts.running ?? 0,
      planned: counts.planned ?? 0,
      failed: counts.failed ?? 0,
      proposed: counts.proposed ?? 0,
      deferred: nodes.filter((node) => node.status === 'planned' && node.deferUntil && Number(node.deferUntil) > now).length,
    },
    cycles: {
      count: cycles.length,
      ...summarizeDurations(cycleDurations),
    },
    roles,
    advisorInput: {
      lastBytes: snapshot?.last ?? advisor?.inputBytes?.max ?? null,
      maxBytes: snapshot?.max ?? advisor?.inputBytes?.max ?? null,
      avgTokens: advisor?.tokens?.avg ?? null,
      budgetBytes: budget,
      utilization: snapshot?.last ? Number((snapshot.last / budget).toFixed(3)) : null,
    },
    dispatch: live?.dispatch ?? { count: 0, avgMs: null, p95Ms: null, maxMs: null, started: 0, skipped: 0, skipReasons: {}, lastAt: null },
    stalls: {
      pauses: auto?.pauseCounts ?? {},
      noProgress: auto?.pauseCounts?.noProgress ?? 0,
      errors: auto?.pauseCounts?.errors ?? 0,
      driverStatus: auto?.status ?? null,
      pauseReason: auto?.pauseReason ?? null,
      idleStreak: auto?.idleStreak ?? 0,
      errorStreak: auto?.errorStreak ?? 0,
    },
    planning: auto?.planning ?? null,
  };
}
