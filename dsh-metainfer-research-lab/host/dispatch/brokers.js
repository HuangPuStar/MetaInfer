/**
 * First ResourceBroker implementations (WP P3.2, P3.3).
 *
 * - LocalPoolBroker: the project's ledger pools (`config.resourcePools`) and
 *   `config.maxRunningNodes`, i.e. the arithmetic in runtime.ensureCapacity,
 *   expressed as leases so the envelope treats local and cluster GPUs alike.
 * - ClusterBroker: adapter over the existing coordinator facade from
 *   cluster.js (`acquire/renew/release`). Until the coordinator gains
 *   `/v1/verify` and push (WP P3.7), `verify` checks the lease against what
 *   this process was granted, and `watch` is not provided (the strategy polls).
 */
import { randomUUID } from 'node:crypto';

/**
 * @param {object} deps
 * @param {() => {maxRunningNodes?: number, resourcePools?: Record<string, number>}} deps.limits read live project config
 * @param {() => number} [deps.clock]
 */
export function createLocalPoolBroker({ limits, clock = Date.now }) {
  const leases = new Map();

  function held() {
    const total = {};
    for (const lease of leases.values()) {
      for (const [resource, amount] of Object.entries(lease.resources ?? {})) total[resource] = (total[resource] ?? 0) + amount;
    }
    return total;
  }

  function evaluate(req) {
    const { maxRunningNodes = Infinity, resourcePools = {} } = limits() ?? {};
    if (leases.size >= maxRunningNodes) return { status: 'queued', reason: `maxRunningNodes=${maxRunningNodes} reached` };
    const current = held();
    for (const [resource, amount] of Object.entries(req.resources ?? {})) {
      if (resource === 'machines') continue;
      const total = resourcePools[resource] ?? 0;
      if (amount > total) return { status: 'denied', reason: `needs ${amount} ${resource}, pool has ${total}` };
      if ((current[resource] ?? 0) + amount > total) return { status: 'queued', reason: `${resource} ${current[resource] ?? 0}/${total} held` };
    }
    return null;
  }

  return {
    id: 'local-pool',
    async acquire(req) {
      for (const lease of leases.values()) {
        if (lease.requestId === req.requestId) return { status: 'granted', lease };
      }
      const blocked = evaluate(req);
      if (blocked) return blocked;
      const now = clock();
      const lease = {
        leaseId: `local-${randomUUID().slice(0, 8)}`,
        broker: 'local-pool',
        requestId: req.requestId,
        projectId: req.projectId,
        nodeId: req.nodeId,
        resources: { ...(req.resources ?? {}) },
        grantedAt: now,
        hardEndAt: Number.isFinite(req.walltimeMs) ? now + req.walltimeMs : null,
      };
      leases.set(lease.leaseId, lease);
      return { status: 'granted', lease };
    },
    async preview(req) {
      return evaluate(req) ?? { status: 'granted', lease: { leaseId: 'preview', broker: 'local-pool', requestId: req.requestId } };
    },
    async renew(leaseId) {
      const lease = leases.get(leaseId);
      return lease ? { status: 'renewed', lease } : { status: 'lost', reason: 'unknown-lease' };
    },
    async release(leaseId) {
      leases.delete(leaseId);
    },
    async verify(lease, { projectId, nodeId }) {
      const known = leases.get(lease?.leaseId);
      return Boolean(known && known.projectId === projectId && known.nodeId === nodeId);
    },
    /** Boot reconciliation: re-register the leases of nodes that are still running. */
    adopt(lease) {
      leases.set(lease.leaseId, { ...lease, broker: 'local-pool' });
    },
    get size() { return leases.size; },
  };
}

/**
 * @param {object} deps
 * @param {object} deps.cluster facade from createClusterAdmin().facade
 * @param {() => number} [deps.clock]
 * @param {number} [deps.livenessTtlMs] renewal TTL; the walltime bound is `hardEndAt`
 */
export function createClusterBroker({ cluster, clock = Date.now, livenessTtlMs = 120_000 }) {
  const granted = new Map();

  function normalize(lease, req) {
    return {
      ...lease,
      broker: 'cluster',
      requestId: lease.requestId ?? req?.requestId,
      projectId: lease.projectId ?? req?.projectId,
      nodeId: lease.nodeId ?? req?.nodeId,
      machines: lease.machines ?? [{ machineId: lease.machineId, deviceIds: lease.deviceIds ?? [] }],
      hardEndAt: lease.hardEndAt ?? (Number.isFinite(req?.walltimeMs) ? (lease.grantedAt ?? clock()) + req.walltimeMs : null),
    };
  }

  return {
    id: 'cluster',
    async acquire(req) {
      const shape = Array.isArray(req.shapes) && req.shapes[0]?.machines
        ? { amount: req.shapes[0].machines * req.shapes[0].gpusPerMachine, machines: req.shapes[0].machines }
        : { amount: req.amount ?? req.resources?.gpu ?? 1, machines: req.machines ?? 1 };
      const result = await cluster.acquire({
        requestId: req.requestId,
        projectId: req.projectId,
        nodeId: req.nodeId,
        amount: shape.amount,
        machines: shape.machines,
        placement: shape.machines > 1 ? 'fleet' : (req.placement ?? 'local'),
        constraints: req.constraints ?? null,
        // Today's coordinator only knows a TTL; pass walltime + liveness slack.
        ttlMs: (req.walltimeMs ?? 0) + livenessTtlMs,
        priority: req.coordinatorPriority ?? 0,
        walltimeMs: req.walltimeMs,
        shapes: req.shapes,
      });
      if (result?.status === 'granted') {
        const lease = normalize(result.lease, req);
        granted.set(lease.leaseId, lease);
        return { status: 'granted', lease };
      }
      if (result?.status === 'reserved' || result?.status === 'contested' || result?.status === 'queued') return result;
      return { status: 'denied', reason: result?.reason ?? 'coordinator-refused' };
    },
    async renew(leaseId) {
      const result = await cluster.renew(leaseId, livenessTtlMs);
      if (result?.status !== 'renewed') {
        granted.delete(leaseId);
        return { status: 'lost', reason: result?.reason ?? 'lost' };
      }
      return { status: 'renewed', lease: normalize(result.lease, granted.get(leaseId)) };
    },
    async release(leaseId) {
      granted.delete(leaseId);
      await cluster.release(leaseId);
    },
    async verify(lease, { projectId, nodeId }) {
      if (typeof cluster.verify === 'function') return Boolean(await cluster.verify(lease.leaseId, { projectId, nodeId }));
      const known = granted.get(lease?.leaseId);
      if (!known || known.projectId !== projectId || known.nodeId !== nodeId) return false;
      return !(Number.isFinite(known.expiresAt) && known.expiresAt < clock());
    },
  };
}
