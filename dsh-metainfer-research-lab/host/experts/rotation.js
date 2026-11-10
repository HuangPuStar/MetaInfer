/**
 * B23 rotation primitive. An expert that has owned the same branch for more
 * than N days is rotated deterministically to the next active expert. The
 * module is pure; the service persists the resulting assignment.
 */
export const DEFAULT_ROTATION_DAYS = 14;
export const DAY_MS = 24 * 60 * 60_000;

/** Walk parent links to the branch root; unknown parents stop the walk. */
export function branchIdOf(node, nodes) {
  const byId = nodes instanceof Map ? nodes : new Map((Array.isArray(nodes) ? nodes : []).map((row) => [row.id, row]));
  let current = node;
  const seen = new Set();
  while (current?.parentId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = byId.get(current.parentId);
    if (!parent) break;
    current = parent;
  }
  return current?.id ?? node?.id ?? null;
}

/**
 * @param {{nodes?: Array<object>, experts?: Array<string>, rotations?: object,
 *          now?: number, maxDays?: number}} input
 * @returns {{due: Array<object>, assignments: Array<object>}}
 */
export function rotationPlan({ nodes = [], experts = [], rotations = {}, now = Date.now(), maxDays = DEFAULT_ROTATION_DAYS } = {}) {
  const list = Array.isArray(nodes) ? nodes : [];
  const active = [...new Set((Array.isArray(experts) ? experts : []).filter((id) => typeof id === 'string' && id))].sort();
  const windowMs = Math.max(1, Number(maxDays) || DEFAULT_ROTATION_DAYS) * DAY_MS;
  const byBranch = new Map();
  for (const node of list) {
    const expertId = typeof node?.createdBy === 'string' ? node.createdBy : '';
    if (!expertId || !active.includes(expertId)) continue;
    const branchId = branchIdOf(node, list) ?? node.id;
    const createdAt = Number(node?.timestamps?.createdAt);
    if (!Number.isFinite(createdAt)) continue;
    const key = `${expertId}\u0000${branchId}`;
    const previous = byBranch.get(key);
    if (!previous || createdAt < previous.since) {
      byBranch.set(key, { expertId, branchId, since: createdAt, nodeIds: previous?.nodeIds ?? [] });
    }
    byBranch.get(key).nodeIds.push(node.id);
  }
  const rotationMap = rotations && typeof rotations === 'object' ? rotations : {};
  const assignments = [...byBranch.values()].map((row) => ({
    ...row,
    nodeIds: row.nodeIds.slice(0, 200),
    rotatedAt: Number(rotationMap[row.branchId]?.rotatedAt) || null,
  }));
  const due = [];
  for (const row of assignments) {
    const lastRotation = Number(rotationMap[row.branchId]?.rotatedAt);
    const since = Number.isFinite(lastRotation) && lastRotation > 0 ? lastRotation : row.since;
    if (now - since <= windowMs) continue;
    const current = rotationMap[row.branchId]?.expertId ?? row.expertId;
    const candidates = active.filter((id) => id !== current);
    const currentIndex = Math.max(0, active.indexOf(current));
    const next = candidates[currentIndex % Math.max(1, candidates.length)] ?? null;
    if (!next) continue;
    due.push({
      branchId: row.branchId,
      expertId: current,
      nextExpertId: next,
      since,
      ageMs: now - since,
      reason: `expert ${current} owned branch ${row.branchId} for more than ${Math.round(windowMs / DAY_MS)} days`,
    });
  }
  due.sort((left, right) => String(left.branchId).localeCompare(String(right.branchId)));
  return { due, assignments };
}
