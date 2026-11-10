/**
 * Projection: in-memory indexes over node records, maintained from commits.
 *
 * Replaces the O(all nodes of all projects) `store.listNodes` scans on hot
 * paths (auto tick, lease pump, snapshots, getState). It is a derived cache
 * (never written back to storage): `load()` rebuilds it from the store and
 * `applyCommit()` keeps it current from the executor's events.
 *
 * Records handed out are frozen in `strict` mode so callers cannot mutate the
 * cache by accident; mutate state only through executor.commit().
 */
import { comparePriority } from './priority.js';
import { parentIdsOf, redoEffect } from './mutations.js';
import { isRunnableNode } from './runnable.js';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function createProjectIndex() {
  return {
    revision: 0,
    byId: new Map(),
    byStatus: new Map(),
    children: new Map(),
  };
}

/**
 * @param {object} deps
 * @param {object} deps.store ProjectStore
 * @param {boolean} [deps.strict] freeze records (tests, simulator)
 * @param {() => number} [deps.clock]
 */
export function createProjection({ store, strict = false, clock = Date.now }) {
  const projects = new Map();

  function indexFor(projectId) {
    const index = projects.get(projectId);
    if (!index) throw new Error(`projection: project ${projectId} is not loaded`);
    return index;
  }

  function addToSet(map, key, value) {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(value);
  }

  function removeFromSet(map, key, value) {
    const set = map.get(key);
    if (!set) return;
    set.delete(value);
    if (set.size === 0) map.delete(key);
  }

  function unindex(index, node) {
    removeFromSet(index.byStatus, node.status, node.id);
    for (const parentId of parentIdsOf(node)) removeFromSet(index.children, parentId, node.id);
    index.byId.delete(node.id);
  }

  function indexNode(index, node) {
    const stored = strict ? deepFreeze(structuredClone(node)) : node;
    index.byId.set(node.id, stored);
    addToSet(index.byStatus, node.status, node.id);
    for (const parentId of parentIdsOf(node)) addToSet(index.children, parentId, node.id);
  }

  /** (Re)build one project's index from storage. One scan per project at boot. */
  function load(projectId) {
    const index = createProjectIndex();
    index.revision = store.getProject(projectId)?.revision ?? 0;
    for (const node of store.listNodes(projectId)) indexNode(index, structuredClone(node));
    projects.set(projectId, index);
    return index.revision;
  }

  function unload(projectId) {
    projects.delete(projectId);
  }

  /** Apply the events of one acknowledged commit (called by the executor). */
  function applyCommit(projectId, events) {
    const index = projects.get(projectId);
    if (!index) return; // not loaded: nothing cached, nothing to update
    const target = {
      project: {},
      getNode: (nodeId) => {
        const node = index.byId.get(nodeId);
        return node ? structuredClone(node) : undefined;
      },
      putNode: (node) => {
        const previous = index.byId.get(node.id);
        if (previous) unindex(index, previous);
        indexNode(index, node);
      },
      deleteNode: (nodeId) => {
        const previous = index.byId.get(nodeId);
        if (previous) unindex(index, previous);
      },
    };
    for (const event of events) {
      for (const effect of event.effects ?? []) {
        if (effect.op.startsWith('node.')) redoEffect(target, effect, event.revision);
      }
      if (Number.isFinite(event.revision)) index.revision = Math.max(index.revision, event.revision);
    }
  }

  /**
   * Mirror a write made outside the executor (legacy runtime/service writes).
   * The store calls this for every saveNode; without it the projection would
   * serve stale statuses to the dispatcher.
   */
  function syncNode(projectId, node) {
    const index = projects.get(projectId);
    if (!index) return;
    const previous = index.byId.get(node.id);
    if (previous) unindex(index, previous);
    indexNode(index, node);
  }

  function removeNode(projectId, nodeId) {
    const index = projects.get(projectId);
    if (!index) return;
    const previous = index.byId.get(nodeId);
    if (previous) unindex(index, previous);
  }

  function getNode(projectId, nodeId) {
    return indexFor(projectId).byId.get(nodeId);
  }

  function listNodes(projectId) {
    return [...indexFor(projectId).byId.values()];
  }

  function listByStatus(projectId, status) {
    const index = indexFor(projectId);
    return [...(index.byStatus.get(status) ?? [])].map((id) => index.byId.get(id));
  }

  function countByStatus(projectId) {
    const out = {};
    for (const [status, ids] of indexFor(projectId).byStatus) out[status] = ids.size;
    return out;
  }

  /** Children that are part of the DAG (proposals are not edges yet). */
  function children(projectId, nodeId) {
    const index = indexFor(projectId);
    return [...(index.children.get(nodeId) ?? [])]
      .map((id) => index.byId.get(id))
      .filter((node) => node && node.status !== 'proposed');
  }

  function isLeaf(projectId, nodeId) {
    return children(projectId, nodeId).length === 0;
  }

  /**
   * Runnable nodes (design decision B8) in dispatch order. The predicate itself
   * lives in kernel/runnable.js so the projection, the dispatcher, the auto
   * driver and the scheduler snapshot cannot drift apart.
   */
  function runnable(projectId, now = clock()) {
    return listByStatus(projectId, 'planned')
      .filter((node) => isRunnableNode(node, now))
      .sort(comparePriority);
  }

  function revision(projectId) {
    return indexFor(projectId).revision;
  }

  /**
   * Compare the projection with storage. Used by the simulator and by a debug
   * flag in production; returns a list of human-readable differences.
   */
  function checkConsistency(projectId) {
    const index = indexFor(projectId);
    const diffs = [];
    const stored = new Map(store.listNodes(projectId).map((node) => [node.id, node]));
    for (const [id, node] of stored) {
      const cached = index.byId.get(id);
      if (!cached) { diffs.push(`missing ${id}`); continue; }
      if (cached.status !== node.status) diffs.push(`${id} status ${cached.status} != ${node.status}`);
      if ((cached.rev ?? 0) !== (node.rev ?? 0)) diffs.push(`${id} rev ${cached.rev} != ${node.rev}`);
      if (Boolean(cached.claim) !== Boolean(node.claim)) diffs.push(`${id} claim mismatch`);
    }
    for (const id of index.byId.keys()) if (!stored.has(id)) diffs.push(`extra ${id}`);
    return diffs;
  }

  return {
    load,
    unload,
    applyCommit,
    getNode,
    syncNode,
    removeNode,
    listNodes,
    listByStatus,
    countByStatus,
    children,
    isLeaf,
    runnable,
    revision,
    checkConsistency,
  };
}
