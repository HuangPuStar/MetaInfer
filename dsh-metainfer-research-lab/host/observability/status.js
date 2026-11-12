/**
 * Host-computed status facts (usability requirement A2).
 *
 * The dashboard used to be entirely agent-generated: a model wrote a summary,
 * the UI rendered it, and it silently went stale. This module produces the
 * facts the UI can trust — counts, running with elapsed/lastActivity, the next
 * node to start with its priority and the reason it has not started, recent
 * failures with a cause pointer — with no model in the loop.
 *
 * Everything is computed from records on demand; no caching, no LLM.
 */
import { runnableQueue } from '../kernel/runnable.js';
import { blockingReason, capacityOf } from '../kernel/capacity.js';

const MAX_RUNNING = 12;
const MAX_NEXT = 5;
// The UI needs positions beyond the five rows the agent context may see. Keep
// the extra list ids-only so the status surface remains bounded.
const MAX_QUEUE_IDS = 100;
const MAX_FAILURES = 5;

function parentsOf(node) {
  if (Array.isArray(node.parentIds) && node.parentIds.length > 0) return node.parentIds;
  return node.parentId ? [node.parentId] : [];
}

function elapsed(now, at) {
  return Number.isFinite(at) ? Math.max(0, now - at) : null;
}

/** @returns {object[]} running nodes, oldest first, bounded. */
export function runningFacts(nodes, now, limit = MAX_RUNNING) {
  return nodes
    .filter((node) => node.status === 'running')
    .sort((a, b) => (a.timestamps?.startedAt ?? 0) - (b.timestamps?.startedAt ?? 0))
    .slice(0, limit)
    .map((node) => {
      const startedAt = node.timestamps?.startedAt ?? node.startedAt ?? null;
      const lastActivityAt = node.timestamps?.lastActivityAt ?? node.lastEventAt ?? startedAt;
      return {
        nodeId: node.id,
        title: node.title ?? '',
        attempt: node.attempt ?? 0,
        startedAt,
        elapsedMs: elapsed(now, startedAt),
        lastActivityMs: elapsed(now, lastActivityAt),
        needs: node.needs ?? {},
        leaseId: node.lease?.leaseId ?? null,
      };
    });
}

/**
 * Why a runnable node is not starting yet, in operator language.
 * @param {object} node
 * @param {object} context {capacity, project, now}
 */
export function whyNotStarting(node, { capacity, project, now } = {}) {
  if (node.dispatchHold && Number(node.dispatchHold.untilMs) > now) {
    return {
      code: 'dispatch_hold',
      message: `start failed ${node.dispatchFailures ?? 1} time(s); retry in ${Math.ceil((node.dispatchHold.untilMs - now) / 1000)}s`,
      retryAt: node.dispatchHold.untilMs,
    };
  }
  if (node.deferUntil && Number(node.deferUntil) > now) {
    return { code: 'deferred', message: `deferred until ${new Date(node.deferUntil).toISOString()}`, retryAt: node.deferUntil };
  }
  const blocking = capacity ? blockingReason(node, capacity, project) : null;
  if (blocking === 'max_running') return { code: 'max_running', message: `maxRunningNodes=${project?.config?.maxRunningNodes ?? 4} slots are busy` };
  if (blocking?.startsWith('pool_')) {
    const key = blocking.slice(5);
    return { code: blocking, message: `no free ${key} (needs ${node.needs?.[key] ?? 0}, free ${capacity?.free?.[key] ?? 0})` };
  }
  if (node.priority?.class === 'deferred') return { code: 'deferred_class', message: 'priority class deferred: only runs when nothing else can' };
  return { code: 'ready', message: 'ready to start on the next dispatch tick' };
}

/**
 * The bounded, deterministic status surface.
 * @param {object} input
 * @param {object} input.project
 * @param {object[]} input.nodes
 * @param {object} [input.auto] auto.statusOf()
 * @param {object} [input.cluster]
 * @param {number} [input.now]
 * @param {object} [input.dispatch] last dispatchOnce result
 */
export function buildStatusFacts({ project, nodes = [], auto = null, cluster = null, now = Date.now(), dispatch = null }) {
  const counts = {};
  for (const node of nodes) counts[node.status] = (counts[node.status] ?? 0) + 1;
  const capacity = capacityOf(project ?? {}, nodes, cluster);
  const queue = runnableQueue(nodes, now);
  const next = queue.slice(0, MAX_NEXT).map((node) => ({
    nodeId: node.id,
    title: node.title ?? '',
    priority: { class: node.priority?.class ?? 'p2', score: Number(node.priority?.score ?? 0) },
    needs: node.needs ?? {},
    why: whyNotStarting(node, { capacity, project, now }),
    parentIds: parentsOf(node),
  }));
  const failures = nodes
    .filter((node) => node.status === 'failed')
    .sort((a, b) => (b.timestamps?.finishedAt ?? b.finishedAt ?? 0) - (a.timestamps?.finishedAt ?? a.finishedAt ?? 0))
    .slice(0, MAX_FAILURES)
    .map((node) => ({
      nodeId: node.id,
      title: node.title ?? '',
      error: typeof node.error === 'string' ? node.error.slice(0, 500) : (node.error?.message ?? ''),
      errorCode: node.errorCode ?? node.failure?.code ?? null,
      causeId: node.lastCauseId ?? node.causeId ?? node.failure?.causeId ?? null,
      finishedAt: node.timestamps?.finishedAt ?? node.finishedAt ?? null,
      attempts: node.attempt ?? 0,
      nextStep: node.nextStep ?? 'Open the node, read trace_explain, then retry or propose a different approach.',
    }));
  const proposed = counts.proposed ?? 0;
  const runnableCount = queue.length;
  let headline;
  if (auto?.status === 'paused') headline = { code: 'paused', message: `driver paused: ${auto.pauseReason ?? 'unknown'}` };
  else if (counts.running > 0) headline = { code: 'running', message: `${counts.running} running, ${runnableCount} queued` };
  else if (proposed > 0) headline = { code: 'awaiting_approval', message: `${proposed} proposal(s) need a decision` };
  else if (runnableCount > 0) headline = { code: 'queued', message: `${runnableCount} queued, none started yet` };
  else headline = { code: 'idle', message: 'nothing running or queued' };

  return {
    revision: project?.revision ?? 0,
    generatedAt: now,
    headline,
    counts: { ...counts, total: nodes.length },
    resources: {
      pools: project?.config?.resourcePools ?? {},
      free: capacity.free,
      held: capacity.held,
      maxRunningNodes: project?.config?.maxRunningNodes ?? 4,
      runningCount: capacity.runningCount,
    },
    running: runningFacts(nodes, now),
    nextToStart: next,
    queueOrder: queue.slice(0, MAX_QUEUE_IDS).map((node) => node.id),
    // `nextToStart` is capped at five for the agent-facing snapshot. The UI
    // still needs a reason on every rendered queue row, so this bounded detail
    // list carries the same why for up to MAX_QUEUE_IDS ids. It is deliberately
    // separate from queueOrder so older clients can keep consuming ids.
    queueRows: queue.slice(0, MAX_QUEUE_IDS).map((node) => ({
      nodeId: node.id,
      why: whyNotStarting(node, { capacity, project, now }),
    })),
    recentFailures: failures,
    proposals: nodes.filter((node) => node.status === 'proposed').slice(0, 5).map((node) => ({
      nodeId: node.id,
      parentId: node.parentId,
      title: node.title ?? '',
      createdAt: node.timestamps?.createdAt ?? null,
    })),
    driver: auto
      ? {
          status: auto.status,
          pauseReason: auto.pauseReason ?? null,
          cycles: auto.cycles ?? 0,
          idleStreak: auto.idleStreak ?? 0,
          errorStreak: auto.errorStreak ?? 0,
          throttledStreak: auto.throttledStreak ?? 0,
          lastThrottle: auto.lastThrottle ?? null,
          resumeAt: auto.resumeAt ?? 0,
          quotaRemaining: auto.quotaRemaining ?? null,
          quotaLimit: auto.quotaLimit ?? null,
          lastCycleAt: auto.lastCycleAt ?? null,
          lastLeadError: auto.lastLeadError ?? null,
          lastLeadErrorCode: auto.lastLeadErrorCode ?? null,
          lastLeadErrorDetail: auto.lastLeadErrorDetail ?? null,
          lastLeadRetryable: auto.lastLeadRetryable ?? null,
          planning: auto.planning ?? null,
        }
      : null,
    dispatch: dispatch
      ? { started: dispatch.started ?? 0, skipped: dispatch.skipped?.length ?? 0, durationMs: dispatch.durationMs, at: now }
      : null,
    _truncated: {
      running: (counts.running ?? 0) > MAX_RUNNING ? { shown: MAX_RUNNING, total: counts.running } : null,
      nextToStart: runnableCount > MAX_NEXT ? { shown: MAX_NEXT, total: runnableCount } : null,
      queueOrder: runnableCount > MAX_QUEUE_IDS ? { shown: MAX_QUEUE_IDS, total: runnableCount } : null,
      recentFailures: (counts.failed ?? 0) > MAX_FAILURES ? { shown: MAX_FAILURES, total: counts.failed } : null,
    },
  };
}
