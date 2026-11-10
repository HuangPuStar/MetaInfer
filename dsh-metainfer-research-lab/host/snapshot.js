/**
 * Compact DAG snapshots for the advisor (review board) and scheduler.
 * Host recomputes validation from the same views; agents only propose.
 */
import { createHash } from 'node:crypto';
import { runnableQueue } from './kernel/runnable.js';
import { buildContextPayload, enforceByteBudget, CONTEXT_BUDGET_BYTES } from './context/payload.js';

export function promptHash(prompt) {
  return createHash('sha1').update(String(prompt ?? '').replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 12);
}

function truncate(value, limit) {
  const text = typeof value === 'string' ? value : '';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function clusterSummary(cluster, project, running) {
  const enabled = Boolean(cluster?.enabled);
  if (!enabled) {
    return {
      enabled: false,
      mode: cluster?.mode ?? 'local',
      authority: 'local project resource pools only',
    };
  }
  const status = cluster.getStatus?.() ?? {};
  const heldGpu = running.reduce(
    (sum, node) => sum + Math.max(0, Number(node.resourcesHeld?.gpu ?? 0)),
    0,
  );
  const leasedDevices = new Set();
  for (const lease of status.leases ?? []) {
    for (const deviceId of lease.deviceIds ?? []) leasedDevices.add(deviceId);
  }
  const fleetMachines = (status.machines ?? [])
    .filter((machine) => (machine.devices ?? []).length > 0)
    .map((machine) => {
      const free = (machine.devices ?? []).filter((device) => !leasedDevices.has(device.id));
      return {
        machineId: machine.machineId,
        labels: machine.labels ?? {},
        online: machine.online === true,
        gpuModels: [...new Set((machine.devices ?? []).map((device) => device.model))],
        freeGpus: free.length,
        totalGpus: (machine.devices ?? []).length,
      };
    });
  const placementPolicy = project.config.placementPolicy?.spec
    ? {
        text: project.config.placementPolicy.text,
        summary: project.config.placementPolicy.summary ?? null,
        spec: project.config.placementPolicy.spec,
      }
    : null;
  const queue = (status.queue ?? [])
    .filter((item) => item.projectId === project.id)
    .slice(0, 10)
    .map((item) => ({
      position: item.position,
      nodeId: item.nodeId ?? null,
      amount: item.amount ?? 1,
      waitedMs: item.waitedMs ?? null,
    }));
  return {
    enabled: true,
    mode: status.mode ?? 'cluster',
    connected: status.connected === true,
    blocked: status.blocked === true,
    error: status.error ?? null,
    clusterId: status.clusterId ?? null,
    coordinatorId: status.coordinatorId ?? null,
    coordinatorUrl: status.coordinatorUrl ?? null,
    machineId: status.machineId ?? null,
    pools: status.pools ?? {},
    leases: (status.leases ?? [])
      .filter((lease) => lease.projectId === project.id)
      .map((lease) => ({
        leaseId: lease.leaseId,
        nodeId: lease.nodeId,
        machineId: lease.machineId,
        deviceIds: lease.deviceIds,
        expiresInMs: lease.expiresAt ? Math.max(0, lease.expiresAt - Date.now()) : null,
      })),
    project: {
      gpuHeld: heldGpu,
      gpuQuota: Number(project.config.resourcePools?.gpu ?? 0) || null,
    },
    fleet: status.fleet ?? { enabled: false },
    fleetMachines,
    placementPolicy,
    queueForThisProject: queue,
    authority:
      'the cluster coordinator is the final authority for whole-GPU admission; the scheduler only proposes which planned nodes should start, not which machine or whether a lease exists',
  };
}

/**
 * Advisor context (QA Q6): a bounded payload plus the few reviewer-specific
 * extras. The whole object is what the prompt embeds, so it is held to the same
 * byte budget as the payload itself — a 500-node DAG cannot grow the prompt.
 *
 * @param {object} store ProjectStore.
 * @param {object} project project record.
 * @param {object} [cluster]
 * @param {{ledgerReader?: object, now?: number, limits?: object}} [options]
 */
export function buildAdvisorSnapshot(store, project, cluster, options = {}) {
  const nodes = store.listNodes(project.id);
  const ledger = options.ledgerReader?.view(project.id);
  const payload = buildContextPayload({
    project,
    nodes,
    ledger,
    now: options.now ?? Date.now(),
    limits: options.limits,
  });
  const pendingProposals = nodes
    .filter((node) => node.status === 'proposed')
    .slice(0, 5)
    .map((node) => ({
      nodeId: node.id,
      parentId: node.parentId,
      title: truncate(node.title, 160),
      promptHash: promptHash(node.prompt),
      ageMs: Math.max(0, Date.now() - (node.timestamps?.createdAt ?? Date.now())),
    }));
  const recentProposals = nodes
    .filter((node) => node.createdBy === 'advisor')
    .slice(-6)
    .map((node) => ({ parentId: node.parentId, title: truncate(node.title, 120), promptHash: promptHash(node.prompt) }));
  const summary = clusterSummary(cluster, project, nodes.filter((node) => node.status === 'running'));
  const snapshot = {
    ...payload,
    policy: {
      maxProposalsPerPass: project.config.advisor?.maxProposalsPerPass ?? 3,
      maxProposalsPerReviewer: project.config.advisor?.maxProposalsPerReviewer ?? 2,
      acceptMode: project.config.advisor?.acceptMode ?? 'auto',
    },
    pendingProposals,
    recentProposals,
    cluster: {
      enabled: summary.enabled === true,
      mode: summary.mode,
      blocked: summary.blocked === true,
      error: summary.error,
      machineId: summary.machineId,
      pools: summary.pools,
      project: summary.project,
      fleet: summary.fleet,
      queueForThisProject: (summary.queueForThisProject ?? []).slice(0, 5),
      fleetMachines: (summary.fleetMachines ?? []).slice(0, 6),
    },
  };
  return enforceByteBudget(snapshot, CONTEXT_BUDGET_BYTES);
}

/**
 * @param {object} store ProjectStore.
 * @param {object} project project record.
 */
export function buildSchedulerSnapshot(store, project, cluster) {
  const nodes = store.listNodes(project.id);
  const running = nodes.filter((node) => node.status === 'running');
  const planned = runnableQueue(nodes);
  const held = {};
  for (const node of running) {
    for (const [key, amount] of Object.entries(node.resourcesHeld ?? {})) {
      held[key] = (held[key] ?? 0) + amount;
    }
  }
  const pools = project.config.resourcePools ?? {};
  return {
    project: { name: project.name, brief: truncate(project.brief, 1200) },
    resources: {
      // Legacy/local project pools. In cluster mode they act as optional per-project quota.
      pools,
      held,
      free: Object.fromEntries(Object.entries(pools).map(([key, total]) => [key, Math.max(0, total - (held[key] ?? 0))])),
      maxRunningNodes: project.config.maxRunningNodes,
      runningCount: running.length,
      note: 'GPU admission in cluster mode is decided by the cluster coordinator; this project snapshot is advisory for the scheduler.',
    },
    cluster: clusterSummary(cluster, project, running),
    running: running.map((node) => ({
      id: node.id,
      title: node.title,
      needs: node.needs ?? {},
      startedAt: node.timestamps?.startedAt ?? null,
      elapsedMs: node.timestamps?.startedAt ? Date.now() - node.timestamps.startedAt : null,
    })),
    planned: planned.map((node) => ({
      id: node.id,
      title: node.title,
      promptExcerpt: truncate(node.prompt, 400),
      needs: node.needs ?? {},
      class: node.priority?.class ?? 'p2',
      parentTitle: node.parentId ? store.getNode(project.id, node.parentId)?.title ?? null : null,
      timeboxMinutes: Math.round((node.timeboxMs ?? 600_000) / 60_000),
      createdAt: node.timestamps?.createdAt ?? null,
    })),
  };
}
