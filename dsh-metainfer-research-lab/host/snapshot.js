/**
 * Compact DAG snapshots for the advisor (review board) and scheduler.
 * Host recomputes validation from the same views; agents only propose.
 */
import { createHash } from 'node:crypto';

const MAX_PROMPT = 800;
const MAX_REPORT = 700;

export function promptHash(prompt) {
  return createHash('sha1').update(String(prompt ?? '').replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 12);
}

function truncate(value, limit) {
  const text = typeof value === 'string' ? value : '';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function reportSummary(node) {
  if (!node.report) return node.reportText ? truncate(node.reportText, MAX_REPORT) : '';
  const report = node.report;
  const metrics = Array.isArray(report.metrics)
    ? report.metrics.slice(0, 6).map((metric) => `${metric.name}=${metric.value}${metric.unit ? ` ${metric.unit}` : ''}`).join(', ')
    : '';
  return truncate([report.summary, metrics ? `metrics: ${metrics}` : ''].filter(Boolean).join(' | '), MAX_REPORT);
}

function childrenIndex(nodes) {
  const map = new Map();
  for (const node of nodes) {
    const ids = Array.isArray(node.parentIds) && node.parentIds.length > 0
      ? node.parentIds
      : (node.parentId ? [node.parentId] : []);
    for (const id of ids) {
      if (!id) continue;
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(node);
    }
  }
  return map;
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

function nodeSummary(node, kind, children) {
  return {
    id: node.id,
    title: node.title,
    kind,
    status: node.status,
    headCommit: node.git?.headCommit ?? null,
    prompt: truncate(node.prompt, MAX_PROMPT),
    report: node.report
      ? {
          summary: truncate(node.report.summary, MAX_REPORT),
          metrics: (node.report.metrics ?? []).slice(0, 8),
          success: node.report.success ?? null,
          next: (node.report.next ?? []).slice(0, 5),
        }
      : node.reportText
        ? { summary: truncate(node.reportText, MAX_REPORT) }
        : null,
    needs: node.needs ?? {},
    timeboxMinutes: Math.round((node.timeboxMs ?? 600_000) / 60_000),
    children: children.get(node.id)?.length ?? 0,
    reviewedHeadCommit: node.review?.reviewedHeadCommit ?? null,
  };
}

/**
 * Candidate parents for the advisor: active leaves plus their k-level completed
 * ancestors (the review board focuses on leaves, not the whole graph).
 * @returns {Map<string, object>} candidate id -> summary.
 */
export function advisorCandidates(store, project, ancestorDepth = 2) {
  const nodes = store.listNodes(project.id);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = childrenIndex(nodes.filter((node) => node.status !== 'proposed'));
  const pendingParents = new Set(
    nodes.filter((node) => node.status === 'proposed').map((node) => node.parentId),
  );
  const leaves = nodes.filter(
    (node) => node.status === 'completed' && (children.get(node.id)?.length ?? 0) === 0,
  );
  const candidates = new Map();
  for (const leaf of leaves) {
    if (pendingParents.has(leaf.id)) continue;
    candidates.set(leaf.id, nodeSummary(leaf, 'leaf', children));
    let cursor = leaf;
    for (let depth = 0; depth < (ancestorDepth ?? 2); depth += 1) {
      const parent = cursor.parentId ? byId.get(cursor.parentId) : undefined;
      if (!parent || parent.status !== 'completed') break;
      if (!candidates.has(parent.id)) candidates.set(parent.id, nodeSummary(parent, 'ancestor', children));
      cursor = parent;
    }
  }
  return candidates;
}

/**
 * @param {object} store ProjectStore.
 * @param {object} project project record.
 */
export function buildAdvisorSnapshot(store, project, cluster) {
  const nodes = store.listNodes(project.id);
  const candidates = advisorCandidates(store, project);
  const running = nodes
    .filter((node) => node.status === 'running')
    .map((node) => ({
      id: node.id,
      title: node.title,
      needs: node.needs ?? {},
      startedAt: node.timestamps?.startedAt ?? null,
      deadlineAt: node.deadlineAt ?? null,
    }));
  const failed = nodes
    .filter((node) => node.status === 'failed')
    .slice(-10)
    .map((node) => ({
      id: node.id,
      title: node.title,
      errorStage: node.error?.stage ?? null,
      error: truncate(node.error?.message, 400),
      timeboxMinutes: Math.round((node.timeboxMs ?? 0) / 60_000),
      termination: node.termination
        ? {
            kind: node.termination.kind,
            verifiedClean: node.termination.verifiedClean,
            leftover: node.termination.leftover ?? [],
            gcRunId: node.termination.gcRunId ?? null,
            gcPostmortem: node.termination.gcPostmortem
              ? {
                  cause: truncate(node.termination.gcPostmortem.cause, 400),
                  recommendation: node.termination.gcPostmortem.recommendation ?? null,
                  summary: truncate(node.termination.gcPostmortem.summary, 600),
                }
              : null,
          }
        : null,
    }));
  const recentProposals = nodes
    .filter((node) => node.createdBy === 'advisor')
    .slice(-20)
    .map((node) => ({ parentId: node.parentId, title: node.title, promptHash: promptHash(node.prompt) }));
  const pendingProposals = nodes
    .filter((node) => node.status === 'proposed')
    .map((node) => ({
      nodeId: node.id,
      parentId: node.parentId,
      title: node.title,
      promptHash: promptHash(node.prompt),
      createdAt: node.timestamps?.createdAt ?? null,
      ageMs: Date.now() - (node.timestamps?.createdAt ?? Date.now()),
    }));

  const held = {};
  for (const node of nodes) {
    if (node.status !== 'running') continue;
    for (const [key, amount] of Object.entries(node.resourcesHeld ?? {})) {
      held[key] = (held[key] ?? 0) + amount;
    }
  }

  return {
    project: { name: project.name, brief: project.brief },
    budget: {
      nodesUsed: nodes.length,
      maxNodes: project.config.maxNodes,
      cyclesRun: project.counters?.cycles ?? 0,
    },
    candidateParents: [...candidates.values()],
    running,
    failed,
    resources: {
      pools: project.config.resourcePools ?? {},
      held,
      free: Object.fromEntries(
        Object.entries(project.config.resourcePools ?? {}).map(([key, total]) => [key, Math.max(0, total - (held[key] ?? 0))]),
      ),
      maxRunningNodes: project.config.maxRunningNodes,
    },
    policy: {
      maxProposalsPerPass: project.config.advisor?.maxProposalsPerPass ?? 3,
      acceptMode: project.config.advisor?.acceptMode ?? 'auto',
      allowedParentKinds: ['leaf', 'ancestor'],
    },
    recentProposals,
    pendingProposals,
    cluster: clusterSummary(cluster, project, nodes.filter((node) => node.status === 'running')),
  };
}

/**
 * @param {object} store ProjectStore.
 * @param {object} project project record.
 */
export function buildSchedulerSnapshot(store, project, cluster) {
  const nodes = store.listNodes(project.id);
  const running = nodes.filter((node) => node.status === 'running');
  const planned = nodes.filter((node) => node.status === 'planned');
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
      parentTitle: node.parentId ? store.getNode(project.id, node.parentId)?.title ?? null : null,
      timeboxMinutes: Math.round((node.timeboxMs ?? 600_000) / 60_000),
      createdAt: node.timestamps?.createdAt ?? null,
    })),
  };
}
