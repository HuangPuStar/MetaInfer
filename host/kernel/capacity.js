/**
 * Resource arithmetic shared by the auto driver and the Host status surface.
 *
 * Local capacity is `config.resourcePools` minus `resourcesHeld` of running
 * nodes, capped by `config.maxRunningNodes`; in cluster mode the coordinator's
 * free GPU count is the authority and the project GPU quota caps it further.
 * Pure: every input is passed in.
 */

/** @param {object} project @param {object[]} nodes */
export function capacityOf(project, nodes, cluster = null) {
  const running = nodes.filter((node) => node.status === 'running');
  const held = {};
  for (const node of running) {
    for (const [key, amount] of Object.entries(node.resourcesHeld ?? {})) {
      held[key] = (held[key] ?? 0) + amount;
    }
  }
  const free = {};
  for (const [key, total] of Object.entries(project.config?.resourcePools ?? {})) {
    free[key] = Math.max(0, total - (held[key] ?? 0));
  }
  let canStart = running.length < (project.config?.maxRunningNodes ?? 4);
  if (cluster?.enabled === true) {
    const status = cluster.getStatus?.() ?? {};
    const gpuFree = Number(status.pools?.gpu?.free);
    if (Number.isFinite(gpuFree)) free.gpu = gpuFree;
    const quota = Math.max(0, Number(project.config?.resourcePools?.gpu ?? 0));
    if (quota > 0) {
      const heldGpu = running.reduce(
        (sum, node) => sum + Math.max(0, Number(node.resourcesHeld?.gpu ?? 0)),
        0,
      );
      if (heldGpu >= quota) canStart = false;
      free.gpu = Math.min(free.gpu ?? quota, Math.max(0, quota - heldGpu));
    }
  }
  return { runningCount: running.length, held, free, canStart };
}

/** @returns {boolean} whether this node's needs fit the free pools right now. */
export function nodeFits(node, capacity) {
  if (!capacity.canStart) return false;
  return Object.entries(node.needs ?? {}).every(([key, amount]) => (capacity.free?.[key] ?? 0) >= amount);
}

/** @returns {boolean} whether any of the candidates fits. */
export function anyFits(nodes, capacity) {
  return nodes.some((node) => nodeFits(node, capacity));
}

/** Machine-readable reason a node cannot start now, or null when it fits. */
export function blockingReason(node, capacity, project) {
  if ((capacity.runningCount ?? 0) >= (project?.config?.maxRunningNodes ?? 4)) return 'max_running';
  for (const [key, amount] of Object.entries(node.needs ?? {})) {
    if (key === 'machines') continue;
    const free = capacity.free?.[key] ?? 0;
    if (amount > free) return `pool_${key}`;
  }
  return null;
}
