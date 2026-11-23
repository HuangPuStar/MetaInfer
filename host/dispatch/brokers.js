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
import { isDeepStrictEqual } from 'node:util';
import { executionFingerprint, executionSnapshot } from '../execution.js';
import { holdsResources, sandboxAdmissionBlock, sandboxProfileOf } from '../sandbox-state.js';

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
    /**
     * Release leases whose node is no longer running. The runtime does not know
     * about the broker, so the dispatcher sweeps orphans on every round instead
     * of leaking a slot when a node completes/cancels between two rounds.
     */
    releaseOrphans(nodes) {
      const live = new Set(nodes.filter((node) => holdsResources(node) || sandboxAdmissionBlock(node)).map((node) => node.id));
      const released = [];
      for (const [leaseId, lease] of leases) {
        if (live.has(lease.nodeId)) continue;
        leases.delete(leaseId);
        released.push(leaseId);
      }
      return released;
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
      const known = typeof leaseId === 'string' && leaseId ? granted.get(leaseId) : null;
      if (!known) return { released: false, held: true, reason: 'unknown-cluster-lease' };
      const result = await cluster.release(leaseId);
      if (!result || typeof result !== 'object' || Array.isArray(result)
        || !Object.hasOwn(result, 'status') || result.status !== 'released'
        || Object.keys(result).some(key => !['status', 'already', 'granted'].includes(key))
        || (Object.hasOwn(result, 'already') && typeof result.already !== 'boolean')
        || (Object.hasOwn(result, 'granted') && (!Number.isInteger(result.granted) || result.granted < 0))) {
        return { released: false, held: true, reason: 'coordinator-release-unconfirmed' };
      }
      if (granted.get(leaseId) !== known) return { released: false, held: true, reason: 'cluster-lease-owner-changed' };
      granted.delete(leaseId);
      return { released: true };
    },
    async verify(lease, { projectId, nodeId }) {
      if (typeof cluster.verify === 'function') return Boolean(await cluster.verify(lease.leaseId, { projectId, nodeId }));
      const known = granted.get(lease?.leaseId);
      if (!known || known.projectId !== projectId || known.nodeId !== nodeId) return false;
      return !(Number.isFinite(known.expiresAt) && known.expiresAt < clock());
    },
  };
}

/** Host-local admission only. Remote binding/command journals remain authoritative. */
export function createSandboxAdmissionBroker({ limits, readNode, clock = Date.now }) {
  if (typeof readNode !== 'function') throw new TypeError('sandbox admission requires readNode');
  const leases = new Map();
  const releasedLeases = new Map(); // bounded process-local clean proofs, not a remote replay cache
  const read = (projectId, nodeId) => {
    const node = readNode(projectId, nodeId);
    return node ? structuredClone(node) : null;
  };
  function identity(lease, node) {
    if (!node || node.id !== lease.nodeId || node.projectId !== lease.projectId) return false;
    try {
      if (sandboxProfileOf(node) !== lease.profile || executionFingerprint(node.execution) !== lease.executionFingerprint) return false;
    } catch { return false; }
    const attempt = node.currentAttempt ?? 0;
    const persisted = isDeepStrictEqual(node.admission, lease);
    // beginAttempt advances currentAttempt; it does not invalidate the same permit.
    return (attempt === lease.forAttempt - 1 && node.status === 'planned'
      && (!node.admission || persisted) && (!node.claim || node.claim.leaseId === lease.leaseId))
      || (attempt === lease.forAttempt && persisted);
  }
  function evaluate(req) {
    const { maxRunningNodes = Infinity, resourcePools = {} } = limits() ?? {};
    if (leases.size >= maxRunningNodes) return { status: 'queued', reason: 'sandbox admission slots held' };
    for (const [key, amount] of Object.entries(req.resources ?? {})) {
      if (key === 'machines') continue;
      const total = resourcePools[key] ?? 0;
      if (!Number.isInteger(amount) || amount < 0 || amount > total) return { status: 'denied', reason: 'invalid sandbox resource request' };
      const held = [...leases.values()].reduce((sum, lease) => sum + (lease.resources[key] ?? 0), 0);
      if (held + amount > total) return { status: 'queued', reason: key + ' admission quota held' };
    }
    return null;
  }
  function releasableNode(lease) {
    const node = read(lease.projectId, lease.nodeId);
    return identity(lease, node) && !holdsResources(node) && !sandboxAdmissionBlock(node) ? node : null;
  }
  function rememberRelease(lease, node) {
    releasedLeases.set(lease.leaseId, { lease: structuredClone(lease), attempt: node.currentAttempt ?? 0, sessionId: node.sessionId ?? null });
    if (releasedLeases.size > 1024) releasedLeases.delete(releasedLeases.keys().next().value);
  }
  function repeatedReleaseSafe(proof) {
    if (!proof) return false;
    const { lease } = proof, node = read(lease.projectId, lease.nodeId);
    if (!node || node.projectId !== lease.projectId || node.id !== lease.nodeId
      || (node.currentAttempt ?? 0) !== proof.attempt || (node.sessionId ?? null) !== proof.sessionId
      || (node.admission && !isDeepStrictEqual(node.admission, lease))
      || (node.claim && node.claim.leaseId !== lease.leaseId) || holdsResources(node) || sandboxAdmissionBlock(node)) return false;
    for (const current of leases.values()) if (current.projectId === lease.projectId && current.nodeId === lease.nodeId) return false;
    try { return sandboxProfileOf(node) === lease.profile && executionFingerprint(node.execution) === lease.executionFingerprint; }
    catch { return false; }
  }
  return {
    id: 'sandbox-admission',
    async acquire(req) {
      const node = read(req.projectId, req.nodeId);
      if (!node || sandboxAdmissionBlock(node) || node.status !== 'planned') return { status: 'denied', reason: 'sandbox node is not safely runnable' };
      let snapshot;
      try { snapshot = executionSnapshot(node.execution); } catch { return { status: 'denied', reason: 'invalid sandbox execution' }; }
      const forAttempt = (node.currentAttempt ?? 0) + 1;
      const resources = Object.fromEntries(Object.entries(node.needs ?? {}).filter(([key]) => key !== 'machines'));
      if (!snapshot.sandboxProfile || req.sandboxProfile !== snapshot.sandboxProfile
        || req.forAttempt !== forAttempt || !isDeepStrictEqual(req.execution, snapshot)
        || !isDeepStrictEqual(req.resources, resources) || (req.machines ?? 1) !== 1) return { status: 'denied', reason: 'sandbox request identity mismatch' };
      for (const known of leases.values()) {
        if (known.projectId === req.projectId && known.nodeId === req.nodeId) {
          return known.requestId === req.requestId && known.forAttempt === forAttempt && identity(known, node)
            ? { status: 'granted', lease: structuredClone(known) }
            : { status: 'contested', reason: 'older sandbox admission retained' };
        }
      }
      const blocked = evaluate(req);
      if (blocked) return blocked;
      const now = clock();
      const lease = {
        leaseId: 'sandbox-' + randomUUID(), broker: 'sandbox-admission',
        requestId: req.requestId, projectId: req.projectId, nodeId: req.nodeId,
        profile: snapshot.sandboxProfile, executionFingerprint: executionFingerprint(snapshot),
        forAttempt, launchGeneration: randomUUID(), resources, grantedAt: now,
        hardEndAt: Number.isFinite(req.walltimeMs) ? now + req.walltimeMs : null,
      };
      leases.set(lease.leaseId, structuredClone(lease));
      return { status: 'granted', lease: structuredClone(lease) };
    },
    async verify(lease, { projectId, nodeId }) {
      const known = leases.get(lease?.leaseId);
      return Boolean(known && known.projectId === projectId && known.nodeId === nodeId
        && isDeepStrictEqual(known, lease) && identity(known, read(projectId, nodeId)));
    },
    async release(leaseId) {
      const known = leases.get(leaseId);
      if (!known) return repeatedReleaseSafe(releasedLeases.get(leaseId))
        ? { released: true, alreadyReleased: true }
        : { released: false, held: true, reason: 'unknown or superseded admission lease' };
      const node = releasableNode(known);
      if (!node) return { released: false, held: true, reason: 'sandbox ownership or operation unresolved' };
      rememberRelease(known, node); leases.delete(leaseId);
      return { released: true };
    },
    releaseOrphans() {
      const released = [];
      for (const [id, lease] of leases) {
        const node = releasableNode(lease);
        if (!node) continue;
        rememberRelease(lease, node); leases.delete(id); released.push(id);
      }
      return released;
    },
    adopt(lease) {
      const node = lease && read(lease.projectId, lease.nodeId);
      if (lease?.broker !== 'sandbox-admission' || !isDeepStrictEqual(node?.admission, lease)
        || !identity(lease, node) || (leases.has(lease.leaseId) && !isDeepStrictEqual(leases.get(lease.leaseId), lease))) {
        throw new Error('persisted sandbox admission lease identity mismatch');
      }
      releasedLeases.delete(lease.leaseId);
      leases.set(lease.leaseId, structuredClone(lease));
    },
    // Active Host grants only; never expose the mutable map or clean-proof cache.
    snapshot() { return [...leases.values()].map(lease => structuredClone(lease)); },
    get size() { return leases.size; },
  };
}
