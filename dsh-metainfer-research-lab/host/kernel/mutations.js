/**
 * Kernel mutation reducers.
 *
 * Every state change in the Lab is expressed as a list of mutations that the
 * Executor applies atomically (see executor.js). A reducer takes the working
 * set of one commit and one mutation, validates it, changes the working set and
 * returns the events it produces. Each event carries the `effects` needed to
 * redo it during crash recovery, so the event log alone can rebuild the
 * records (design rule G2: events are the audit trail and the redo log).
 *
 * Reducers are pure with respect to I/O: they never touch the store.
 */
import { isPriorityClass, normalizePriority } from './priority.js';

export const NODE_STATUSES = Object.freeze(['proposed', 'planned', 'running', 'completed', 'failed', 'cancelled']);

/**
 * Allowed status transitions. Derived from the status writes in runtime.js,
 * orchestrator.js, lab-service.js and reconcile.js at baseline 867d277:
 * - proposed -> planned (approveProposal, maybeAutoUpgrade), cancelled (reject)
 * - planned  -> running (start), failed (failStart), cancelled (cancel)
 * - running  -> completed | failed | cancelled
 * - completed -> running (follow-up message on a leaf), planned (prepareNewAttempt)
 * - failed / cancelled -> planned (retry / prepareNewAttempt)
 * WP P1.7 must re-verify this table against every migrated writer and tighten it.
 */
export const DEFAULT_TRANSITIONS = Object.freeze({
  proposed: ['planned', 'cancelled'],
  planned: ['running', 'failed', 'cancelled'],
  running: ['completed', 'failed', 'cancelled'],
  completed: ['running', 'planned'],
  failed: ['planned', 'running'],
  cancelled: ['planned'],
});

/** Default event type per target status (legacy event names are preserved). */
const TRANSITION_EVENT = Object.freeze({
  planned: 'node/planned',
  running: 'node/started',
  completed: 'node/completed',
  failed: 'node/failed',
  cancelled: 'node/cancelled',
});

/** Fields that only dedicated mutations may change. */
const NODE_PROTECTED_FIELDS = new Set(['id', 'status', 'rev', 'priority', 'claim']);
const PROJECT_PROTECTED_FIELDS = new Set(['id', 'counters', 'revision']);

export class MutationError extends Error {
  /**
   * @param {string} code stable machine-readable code
   * @param {string} message human-readable detail
   * @param {object} [detail]
   */
  constructor(code, message, detail = undefined) {
    super(message);
    this.name = 'MutationError';
    this.code = code;
    this.detail = detail;
  }
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new MutationError('invalid_mutation', `${field} must be a non-empty string`);
  }
  return value;
}

function requirePlainObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MutationError('invalid_mutation', `${field} must be an object`);
  }
  return value;
}

/** Parent ids of a node, accepting both the multi-parent and legacy single-parent form. */
export function parentIdsOf(node) {
  if (Array.isArray(node?.parentIds) && node.parentIds.length > 0) return node.parentIds;
  return node?.parentId ? [node.parentId] : [];
}

/**
 * Working set for one commit. Nodes are loaded lazily through `loadNode` and
 * deep-copied so a rejected commit never leaks partial changes into records the
 * store (or the projection) still references.
 */
export function createWorkingSet(project, loadNode) {
  const nodes = new Map();
  const deleted = new Set();
  const touched = new Set();
  return {
    project: structuredClone(project),
    projectTouched: false,
    getNode(nodeId) {
      if (deleted.has(nodeId)) return undefined;
      if (!nodes.has(nodeId)) {
        const stored = loadNode(nodeId);
        nodes.set(nodeId, stored ? structuredClone(stored) : undefined);
      }
      return nodes.get(nodeId);
    },
    putNode(node) {
      deleted.delete(node.id);
      nodes.set(node.id, node);
      touched.add(node.id);
    },
    deleteNode(nodeId) {
      nodes.delete(nodeId);
      deleted.add(nodeId);
      touched.add(nodeId);
    },
    touchedNodeIds: () => [...touched],
    isDeleted: (nodeId) => deleted.has(nodeId),
    peekNode: (nodeId) => nodes.get(nodeId),
  };
}

function nodeEvent(type, node, data, effect) {
  return { type, nodeId: node.id, data, effects: [effect] };
}

const reducers = {
  'node.create'(ws, m, ctx) {
    const input = requirePlainObject(m.node, 'node');
    const id = requireString(input.id, 'node.id');
    if (ws.getNode(id)) throw new MutationError('conflict', `node ${id} already exists`);
    const status = input.status ?? 'planned';
    if (!NODE_STATUSES.includes(status)) throw new MutationError('invalid_mutation', `unknown status ${status}`);
    for (const parentId of parentIdsOf(input)) {
      if (!ws.getNode(parentId)) throw new MutationError('not_found', `parent ${parentId} does not exist`);
    }
    const node = structuredClone(input);
    node.status = status;
    if (ctx.causeId && !node.causeId) node.causeId = ctx.causeId;
    node.priority = normalizePriority(input.priority, { by: ctx.actor.id, at: ctx.now });
    node.timestamps = { ...(input.timestamps ?? {}), createdAt: input.timestamps?.createdAt ?? ctx.now, updatedAt: ctx.now };
    ws.putNode(node);
    return [nodeEvent(m.eventType ?? 'node/created', node, m.eventData ?? { status }, { op: 'node.put', nodeId: id, node })];
  },

  'node.update'(ws, m, ctx) {
    const nodeId = requireString(m.nodeId, 'nodeId');
    const node = ws.getNode(nodeId);
    if (!node) throw new MutationError('not_found', `node ${nodeId} does not exist`);
    const set = m.set === undefined ? {} : requirePlainObject(m.set, 'set');
    const unset = Array.isArray(m.unset) ? m.unset : [];
    for (const key of [...Object.keys(set), ...unset]) {
      if (NODE_PROTECTED_FIELDS.has(key)) {
        throw new MutationError('protected_field', `${key} cannot be changed by node.update`);
      }
    }
    Object.assign(node, structuredClone(set));
    for (const key of unset) delete node[key];
    node.timestamps = { ...(node.timestamps ?? {}), updatedAt: ctx.now };
    ws.putNode(node);
    return [nodeEvent(m.eventType ?? 'node/edited', node, m.eventData ?? { fields: [...Object.keys(set), ...unset] }, {
      op: 'node.merge', nodeId, set: structuredClone(set), unset, updatedAt: ctx.now,
    })];
  },

  'node.transition'(ws, m, ctx) {
    const nodeId = requireString(m.nodeId, 'nodeId');
    const node = ws.getNode(nodeId);
    if (!node) throw new MutationError('not_found', `node ${nodeId} does not exist`);
    const to = requireString(m.to, 'to');
    if (!NODE_STATUSES.includes(to)) throw new MutationError('invalid_mutation', `unknown status ${to}`);
    if (m.from !== undefined && node.status !== m.from) {
      throw new MutationError('precondition_failed', `node ${nodeId} is ${node.status}, expected ${m.from}`);
    }
    const allowed = ctx.transitions[node.status] ?? [];
    if (!allowed.includes(to)) {
      throw new MutationError('illegal_transition', `node ${nodeId}: ${node.status} -> ${to} is not allowed`);
    }
    const set = m.set === undefined ? {} : requirePlainObject(m.set, 'set');
    for (const key of Object.keys(set)) {
      if (NODE_PROTECTED_FIELDS.has(key)) throw new MutationError('protected_field', `${key} cannot be set here`);
    }
    const from = node.status;
    Object.assign(node, structuredClone(set));
    node.status = to;
    // A node that leaves `planned` no longer holds a dispatch claim (commit point consumed).
    const hadClaim = Boolean(node.claim);
    delete node.claim;
    if (ctx.causeId) node.lastCauseId = ctx.causeId;
    node.timestamps = { ...(node.timestamps ?? {}), updatedAt: ctx.now };
    ws.putNode(node);
    return [nodeEvent(m.eventType ?? TRANSITION_EVENT[to], node, m.eventData ?? { from, to }, {
      op: 'node.merge', nodeId, set: { ...structuredClone(set), status: to, ...(ctx.causeId ? { lastCauseId: ctx.causeId } : {}) }, unset: hadClaim ? ['claim'] : [], updatedAt: ctx.now,
    })];
  },

  'node.setPriority'(ws, m, ctx) {
    const nodeId = requireString(m.nodeId, 'nodeId');
    const node = ws.getNode(nodeId);
    if (!node) throw new MutationError('not_found', `node ${nodeId} does not exist`);
    // Defense in depth: priority is a pre-run hint. The service checks first,
    // but the kernel must reject the write even if another writer changed the
    // status between that check and this commit (B7, single writer).
    if (node.status !== 'planned' && node.status !== 'proposed') {
      throw new MutationError('priority_frozen', `node ${nodeId} is ${node.status}; priority can only change while planned or proposed`);
    }
    const raw = requirePlainObject(m.priority, 'priority');
    if (raw.class !== undefined && !isPriorityClass(raw.class)) {
      throw new MutationError('invalid_mutation', `unknown priority class ${raw.class}`);
    }
    const before = normalizePriority(node.priority);
    const priority = normalizePriority({ ...before, ...raw, by: ctx.actor.id, at: ctx.now });
    node.priority = priority;
    node.timestamps = { ...(node.timestamps ?? {}), updatedAt: ctx.now };
    ws.putNode(node);
    return [nodeEvent(m.eventType ?? 'node/priority_changed', node, m.eventData ?? { before, after: priority }, {
      op: 'node.merge', nodeId, set: { priority }, unset: [], updatedAt: ctx.now,
    })];
  },

  'node.claim'(ws, m, ctx) {
    const nodeId = requireString(m.nodeId, 'nodeId');
    const node = ws.getNode(nodeId);
    if (!node) throw new MutationError('not_found', `node ${nodeId} does not exist`);
    if (node.status !== 'planned') throw new MutationError('not_runnable', `node ${nodeId} is ${node.status}`);
    if (node.claim) throw new MutationError('already_claimed', `node ${nodeId} is claimed by ${node.claim.decisionId}`);
    if (normalizePriority(node.priority).class === 'deferred') {
      throw new MutationError('not_runnable', `node ${nodeId} is deferred`);
    }
    const claim = {
      decisionId: requireString(m.claim?.decisionId, 'claim.decisionId'),
      strategyId: m.claim?.strategyId ?? null,
      broker: m.claim?.broker ?? null,
      leaseId: m.claim?.leaseId ?? null,
      at: ctx.now,
      by: ctx.actor.id,
    };
    node.claim = claim;
    ws.putNode(node);
    return [nodeEvent(m.eventType ?? 'dispatch/claimed', node, m.eventData ?? claim, {
      op: 'node.merge', nodeId, set: { claim }, unset: [], updatedAt: node.timestamps?.updatedAt ?? ctx.now,
    })];
  },

  'node.releaseClaim'(ws, m, ctx) {
    const nodeId = requireString(m.nodeId, 'nodeId');
    const node = ws.getNode(nodeId);
    if (!node) throw new MutationError('not_found', `node ${nodeId} does not exist`);
    if (!node.claim) return [];
    if (m.decisionId && node.claim.decisionId !== m.decisionId) {
      throw new MutationError('precondition_failed', `claim on ${nodeId} belongs to ${node.claim.decisionId}`);
    }
    const released = node.claim;
    delete node.claim;
    ws.putNode(node);
    return [nodeEvent(m.eventType ?? 'dispatch/claim_released', node, m.eventData ?? { decisionId: released.decisionId, reason: m.reason ?? null }, {
      op: 'node.merge', nodeId, set: {}, unset: ['claim'], updatedAt: node.timestamps?.updatedAt ?? ctx.now,
    })];
  },

  'node.delete'(ws, m, ctx) {
    const nodeId = requireString(m.nodeId, 'nodeId');
    const node = ws.getNode(nodeId);
    if (!node) throw new MutationError('not_found', `node ${nodeId} does not exist`);
    if (node.status !== 'proposed' && ctx.actor.kind !== 'system') {
      throw new MutationError('forbidden', 'only proposed nodes can be deleted outside system maintenance');
    }
    ws.deleteNode(nodeId);
    return [{ type: m.eventType ?? 'node/deleted', nodeId, data: m.eventData ?? { status: node.status }, effects: [{ op: 'node.delete', nodeId }] }];
  },

  'project.update'(ws, m, ctx) {
    const set = requirePlainObject(m.set, 'set');
    for (const key of Object.keys(set)) {
      if (PROJECT_PROTECTED_FIELDS.has(key)) throw new MutationError('protected_field', `${key} cannot be changed`);
    }
    Object.assign(ws.project, structuredClone(set));
    ws.project.updatedAt = ctx.now;
    ws.projectTouched = true;
    return [{ type: m.eventType ?? 'project/edited', data: m.eventData ?? { fields: Object.keys(set) }, effects: [{ op: 'project.merge', set: structuredClone(set), updatedAt: ctx.now }] }];
  },

  /** Decision record with no state change (dispatch/decided, trigger/fired, intent/rejected ...). */
  'event.record'(ws, m) {
    const type = requireString(m.type, 'type');
    if (!/^[a-z][a-z0-9_-]*\/[a-z0-9_]+$/.test(type)) throw new MutationError('invalid_mutation', `bad event type ${type}`);
    return [{ type, nodeId: m.nodeId ?? undefined, data: m.data ?? {}, effects: [] }];
  },
};

export const MUTATION_OPS = Object.freeze(Object.keys(reducers));

/**
 * Apply one mutation to the working set.
 * @returns {Array<{type: string, nodeId?: string, data: object, effects: object[]}>}
 */
export function applyMutation(ws, mutation, ctx) {
  const reducer = reducers[mutation?.op];
  if (!reducer) throw new MutationError('unknown_op', `unknown mutation op ${mutation?.op}`);
  return reducer(ws, mutation, ctx);
}

/**
 * Redo one stored effect against plain records (crash recovery and replay).
 * @param {{ getNode(id): object|undefined, putNode(node), deleteNode(id), project: object }} target
 * @param {object} effect one entry of an event's `effects`
 * @param {number} revision the revision of the commit that produced the effect
 */
export function redoEffect(target, effect, revision) {
  switch (effect.op) {
    case 'node.put':
      target.putNode({ ...structuredClone(effect.node), rev: revision });
      return;
    case 'node.merge': {
      const node = target.getNode(effect.nodeId);
      if (!node) return;
      Object.assign(node, structuredClone(effect.set ?? {}));
      for (const key of effect.unset ?? []) delete node[key];
      node.timestamps = { ...(node.timestamps ?? {}), updatedAt: effect.updatedAt ?? node.timestamps?.updatedAt };
      node.rev = revision;
      target.putNode(node);
      return;
    }
    case 'node.delete':
      target.deleteNode(effect.nodeId);
      return;
    case 'project.merge':
      Object.assign(target.project, structuredClone(effect.set ?? {}));
      target.project.updatedAt = effect.updatedAt ?? target.project.updatedAt;
      return;
    default:
      throw new Error(`unknown effect ${effect.op}`);
  }
}
