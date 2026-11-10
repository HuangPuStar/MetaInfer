/**
 * The single definition of "runnable" (design decision B8, QA doc Q5).
 *
 * A node is runnable when all of the following hold:
 *   - it is `planned` (only planned nodes may be dispatched);
 *   - no dispatch decision holds a claim on it (`node.claim`, the commit point);
 *   - its priority class is not `deferred` (prune is a class, never a status);
 *   - it is not held back by `dispatchHold.untilMs` (launch backoff).
 *
 * Every consumer — the deterministic dispatcher, the projection, the auto
 * driver's progress accounting, snapshots and the scheduler prompt — must use
 * this module. The bug this replaces: counting `deferred` nodes as runnable made
 * `canRunPlanned` permanently true, so the auto driver ran a full LLM cycle that
 * started nothing, tripped `noProgress` after three cycles and paused the whole
 * project (the nine-hour outage in QA Q5).
 *
 * Pure functions only; no I/O.
 */
import { comparePriority, isDispatchableClass, normalizePriority } from './priority.js';

/** Why a node is not runnable. Stable machine-readable codes. */
export const RUNNABLE_BLOCK = Object.freeze({
  NOT_PLANNED: 'not_planned',
  ARCHIVED: 'archived',
  DEFERRED: 'deferred',
  CLAIMED: 'claimed',
  HELD: 'dispatch_hold',
});

/**
 * @param {object} node
 * @param {number} [now]
 * @returns {string|null} a RUNNABLE_BLOCK code, or null when the node is runnable.
 */
export function runnableBlockReason(node, now = Date.now()) {
  if (!node || node.archivedAt) return RUNNABLE_BLOCK.ARCHIVED;
  if (node.status !== 'planned') return RUNNABLE_BLOCK.NOT_PLANNED;
  if (node.claim) return RUNNABLE_BLOCK.CLAIMED;
  if (Number(node.deferUntil) > now) return RUNNABLE_BLOCK.DEFERRED;
  if (!isDispatchableClass(node.priority)) return RUNNABLE_BLOCK.DEFERRED;
  if (node.dispatchHold && Number(node.dispatchHold.untilMs) > now) return RUNNABLE_BLOCK.HELD;
  return null;
}

/** @returns {boolean} whether the node may be dispatched right now. */
export function isRunnableNode(node, now = Date.now()) {
  return runnableBlockReason(node, now) === null;
}

/**
 * The instant the node actually entered the runnable queue.
 *
 * `createdAt` is not that instant when a node was created ahead of its start
 * window: a deferred node becomes runnable at `deferUntil`, and a launch-
 * backoff node at `dispatchHold.untilMs`. Measuring from creation would count
 * the hold/defer interval as queue wait (round 23 O3).
 *
 * @param {object} node
 * @returns {number|null}
 */
export function runnableSince(node) {
  const created = Number(node?.timestamps?.createdAt ?? node?.createdAt);
  const plannedAt = Number(node?.timestamps?.plannedAt);
  let since = Number.isFinite(plannedAt) && plannedAt > 0 ? plannedAt : created;
  const deferUntil = Number(node?.deferUntil);
  if (Number.isFinite(deferUntil) && deferUntil > since) since = deferUntil;
  const holdUntil = Number(node?.dispatchHold?.untilMs);
  if (Number.isFinite(holdUntil) && holdUntil > since) since = holdUntil;
  return Number.isFinite(since) && since > 0 ? since : null;
}

/** @returns {boolean} whether the node is deferred now (pruned class or scheduled `deferUntil`). */
export function isDeferredNode(node, now = Date.now()) {
  if (!node || node.archivedAt) return false;
  if (node.status !== 'planned') return false;
  if (normalizePriority(node.priority).class === 'deferred') return true;
  return Number(node.deferUntil) > now;
}

/**
 * Unsorted runnable nodes.
 * @param {Iterable<object>} nodes
 * @param {number} [now]
 */
export function runnableNodes(nodes, now = Date.now()) {
  const out = [];
  for (const node of nodes) if (isRunnableNode(node, now)) out.push(node);
  return out;
}

/**
 * Runnable nodes in dispatch order (lexicographic priority tuple).
 * @param {Iterable<object>} nodes
 * @param {number} [now]
 */
export function runnableQueue(nodes, now = Date.now()) {
  return runnableNodes(nodes, now).sort(comparePriority);
}

/**
 * Queue depth and remaining work, used by the low-water pre-trigger.
 * `remainingMs` sums the timebox of each runnable node: it is an upper bound on
 * how long the queue can keep slots busy, which is exactly the quantity the
 * planner must compare with its own latency (QA Q7).
 *
 * @param {Iterable<object>} nodes
 * @param {{ now?: number, defaultTimeboxMs?: number }} [options]
 */
export function runnableSummary(nodes, options = {}) {
  const now = options.now ?? Date.now();
  const defaultTimeboxMs = options.defaultTimeboxMs ?? 600_000;
  const all = [];
  const runnable = [];
  for (const node of nodes) {
    if (node?.archivedAt) continue;
    all.push(node);
    if (isRunnableNode(node, now)) runnable.push(node);
  }
  let remainingMs = 0;
  let gpu = 0;
  for (const node of runnable) {
    const timebox = Number(node.timeboxMs);
    remainingMs += Number.isFinite(timebox) && timebox > 0 ? timebox : defaultTimeboxMs;
    gpu += Math.max(0, Number(node.needs?.gpu ?? 0));
  }
  return {
    total: all.length,
    runnable: runnable.length,
    deferred: all.filter((node) => isDeferredNode(node, now)).length,
    claimed: all.filter((node) => node?.status === 'planned' && node.claim).length,
    held: all.filter((node) => node?.status === 'planned' && !node.claim
      && isDispatchableClass(node.priority)
      && Number(node.dispatchHold?.untilMs) > now).length,
    remainingMs,
    gpu,
  };
}
