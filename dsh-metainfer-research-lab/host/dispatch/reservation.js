/**
 * Project-local p0 reservation (QA Q3, 5.3.2).
 *
 * A reservation is not a second queue: it only filters the *runnable view* for
 * one round. Capacity still comes from the same local-pool broker and the same
 * `maxRunningNodes`; if no p0 is waiting, lower classes may use every slot.
 *
 * `reservedSlots.p0` defaults to 0, so existing projects are unchanged.
 */

/** Read `reservedSlots.p0` from either the flat or scheduling config shape. */
export function reservedSlotsOf(config = {}) {
  const raw = config?.reservedSlots?.p0 ?? config?.scheduling?.reservedSlots?.p0 ?? 0;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * Filter candidates so lower-priority nodes cannot consume the last N free
 * slots while p0 work is waiting.
 *
 * @param {Array<object>} candidates ordered runnable nodes
 * @param {{runningCount?: number, maxRunningNodes?: number, reservedSlots?: number}} capacity
 * @returns {Array<object>}
 */
export function applyReservation(candidates, { runningCount = 0, maxRunningNodes = Infinity, reservedSlots = 0 } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const reserved = Number.isFinite(reservedSlots) ? Math.max(0, Math.floor(reservedSlots)) : 0;
  if (reserved === 0 || !Number.isFinite(maxRunningNodes)) return list;
  const p0Waiting = list.some((node) => node?.priority?.class === 'p0');
  if (!p0Waiting) return list;
  const free = Math.max(0, maxRunningNodes - Math.max(0, runningCount));
  const lowerBudget = Math.max(0, free - reserved);
  let lowerKept = 0;
  return list.filter((node) => {
    if (node?.priority?.class === 'p0') return true;
    if (lowerKept >= lowerBudget) return false;
    lowerKept += 1;
    return true;
  });
}

/** A victim must have been running for this long before preemption is legal. */
export const PREEMPTION_MIN_RUN_MS = 10 * 60_000;

/**
 * Select one project-local p0 preemption victim.
 *
 * Only p2/p3 running experiment nodes are eligible (p1 is a human/urgent class
 * and merge nodes are never preempted). Lowest class wins (p3 before p2), then
 * oldest start, so the decision is deterministic and does not depend on Map
 * iteration order.
 *
 * @param {{now?: number, running?: Array<object>, runnable?: Array<object>,
 *          maxRunningNodes?: number, minRunMs?: number, enabled?: boolean}} input
 * @returns {object|null}
 */
export function selectPreemptionVictim({
  now = Date.now(),
  running = [],
  runnable = [],
  maxRunningNodes = Infinity,
  minRunMs = PREEMPTION_MIN_RUN_MS,
  enabled = true,
} = {}) {
  if (enabled !== true) return null;
  if (!Number.isFinite(maxRunningNodes)) return null;
  const runningList = Array.isArray(running) ? running.filter((node) => node?.status === 'running') : [];
  if (runningList.length < maxRunningNodes) return null;
  const p0 = (Array.isArray(runnable) ? runnable : []).find((node) => node?.priority?.class === 'p0');
  if (!p0) return null;
  const rank = { p3: 0, p2: 1 };
  const eligible = runningList
    .filter((node) => node.kind !== 'merge')
    .filter((node) => rank[node?.priority?.class] !== undefined)
    .filter((node) => {
      const startedAt = node?.timestamps?.startedAt;
      return Number.isFinite(startedAt) && now - startedAt > minRunMs;
    })
    .sort((left, right) => {
      const rankDelta = rank[left.priority.class] - rank[right.priority.class];
      if (rankDelta !== 0) return rankDelta;
      const startedDelta = (left.timestamps?.startedAt ?? 0) - (right.timestamps?.startedAt ?? 0);
      if (startedDelta !== 0) return startedDelta;
      return String(left.id).localeCompare(String(right.id));
    });
  return eligible[0] ?? null;
}


/** Canonical priority classes, highest first. */
export const PRIORITY_CLASSES = Object.freeze(['p0', 'p1', 'p2', 'p3', 'deferred']);

/**
 * Read a per-class running budget. Accepts both documented shapes:
 * `scheduling.classBudgets.p0` and `scheduling.budgets.p0`. Missing/invalid
 * values mean no cap (Infinity), preserving pre-budget behaviour.
 */
export function classBudgetOf(config, priorityClass) {
  const raw = config?.scheduling?.classBudgets?.[priorityClass]
    ?? config?.classBudgets?.[priorityClass]
    ?? config?.scheduling?.budgets?.[priorityClass]
    ?? config?.budgets?.[priorityClass];
  if (raw === undefined || raw === null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
}

/**
 * Filter ordered candidates by per-class running budgets. Counts start from
 * the already-running nodes and are incremented for every admitted candidate,
 * so one dispatch round cannot exceed a class budget.
 *
 * @param {Array<object>} candidates
 * @param {{running?: Array<object>, config?: object}} input
 * @returns {Array<object>}
 */
export function applyClassBudgets(candidates, { running = [], config = {} } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const counts = new Map();
  for (const node of Array.isArray(running) ? running : []) {
    const cls = node?.priority?.class ?? 'p2';
    counts.set(cls, (counts.get(cls) ?? 0) + 1);
  }
  const admitted = [];
  for (const node of list) {
    const cls = node?.priority?.class ?? 'p2';
    const budget = classBudgetOf(config, cls);
    const used = counts.get(cls) ?? 0;
    if (budget !== null && used >= budget) continue;
    admitted.push(node);
    counts.set(cls, used + 1);
  }
  return admitted;
}
