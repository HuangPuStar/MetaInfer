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
