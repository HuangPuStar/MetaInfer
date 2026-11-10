/**
 * M1 ProjectStore on DSH storageDomain.
 *
 * Domain name must match /^[a-z][a-z0-9_]*$/ — hence `metainfer_research_lab_v2`.
 * Table value schemas stay permissive (`z.any()`): records are authored by this
 * plugin and validated by host/lab-service.js. New tables can be declared at any
 * time without another version bump; only a change to an existing field's shape
 * needs `scripts/migrate-domain.mjs` again.
 *
 * Storage conventions:
 * - projects keyed by projectId
 * - nodes keyed by `${projectId}__${nodeId}`
 * - runs / cycles keyed by `${projectId}__${id}`
 * - events keyed by `${projectId}__e${padded seq}` (per-record keys must match
 *   /^[a-zA-Z0-9_-]+$/, so "/" is not allowed)
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

/**
 * v2 is a clean break, not an upgrade: the plugin never reads a v1 record and
 * carries no compatibility branch for one. Migrating is a separate offline
 * tool (`scripts/migrate-domain.mjs`), run once, which also normalises legacy
 * events (actor/commit/revision) so the runtime has a single shape to reason
 * about. Rollback is the v1 directory, which the tool never touches.
 */
export const DOMAIN_NAME = 'metainfer_research_lab_v2';
/** The pre-refactor domain: read only by `scripts/migrate-domain.mjs`, never by this module. */
export const LEGACY_DOMAIN_NAME = 'metainfer_research_lab';
export const DOMAIN_VERSION = 2;
/**
 * Events are never deleted: the event log is the system's audit trail and the
 * source for replaying any revision (see docs/07-async-refactor-plan.md, G2).
 * Cold-segment archiving replaces deletion in a later phase (WP P1.2).
 */

/** Passthrough schema for M1: records are authored and checked by this plugin. */
const PERMISSIVE = z.any();

const DOMAIN_SPEC = {
  name: DOMAIN_NAME,
  version: DOMAIN_VERSION,
  layout: 'per-record',
  tables: {
    projects: { valueSchema: PERMISSIVE },
    nodes: { valueSchema: PERMISSIVE },
    runs: { valueSchema: PERMISSIVE },
    cycles: { valueSchema: PERMISSIVE },
    events: { valueSchema: PERMISSIVE },
  },
};

/** The DSH home directory (`$DSH_HOME`, else `~/.dsh`). */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** Absolute worktree root for one project (M2 creates the actual worktrees). */
export function worktreeRootFor(projectId) {
  return path.join(dshHome(), 'metainfer-research-lab', 'worktrees', projectId);
}

export function nodeStorageKey(projectId, nodeId) {
  return `${projectId}__${nodeId}`;
}

function eventStorageKey(projectId, seq) {
  return `${projectId}__e${String(seq).padStart(8, '0')}`;
}

/** @returns {string} a fresh project id. */
export function newProjectId() {
  return `prj-${randomUUID().slice(0, 8)}`;
}

/** @returns {string} a fresh session id (controller/anchor sessions in later phases). */
export function newSessionId() {
  return `session-${randomUUID()}`;
}

/**
 * Refuse to boot on an empty v2 domain while an unmigrated v1 domain sits next
 * to it. Without this the first start after the rename silently shows an empty
 * lab, which the operator reads as "my project vanished". Call this from the
 * plugin activation path, never from `openStore` itself: test doubles open
 * in-memory domains and have no v1 to migrate.
 * @returns {string|null} the legacy directory that needs migrating, if any
 */
export function unmigratedLegacyDomain() {
  const legacy = path.join(dshHome(), 'storages', LEGACY_DOMAIN_NAME);
  return fs.existsSync(legacy) ? legacy : null;
}

/**
 * Open the domain once per Host process and return the storage facade.
 * @param ctx Cordis context with `storageDomain` injected.
 */
export async function openStore(ctx) {
  // A failed activation can leave the storage-domain facility holding this domain
  // open (the close effect was never registered). Reuse that handle on reload so
  // a plugin reload can recover without restarting the whole Host.
  const existing = typeof ctx.storageDomain?.get === 'function'
    ? ctx.storageDomain.get(DOMAIN_NAME)
    : undefined;
  const domain = existing ?? await ctx.storageDomain.open(DOMAIN_SPEC);
  const tables = {
    projects: domain.table('projects'),
    nodes: domain.table('nodes'),
    runs: domain.table('runs'),
    cycles: domain.table('cycles'),
    events: domain.table('events'),
  };

  /**
   * In-memory projection of the per-project read path.
   *
   * The storage tables only expose `entries()`, so every legacy read scanned
   * every record of every project and then sorted the result (S1/S2/S3 in
   * docs/refactor/DESIGN-CHECKLIST.md §9). One scan per process builds these
   * maps; after that `listNodes`, event pages and run pages are O(page) with a
   * binary search for the cursor, and a single node is O(1).
   *
   * The index is a cache, never the source of truth: it can always be rebuilt
   * from the tables, so a stale index can only cost a rescan, never data.
   */
  const indexes = new Map();
  const nodeListeners = new Set();
  let indexesBuilt = false;

  function emptyIndex() {
    return {
      nodes: new Map(),
      nodeOrder: [],
      events: [],
      runs: [],
      cycles: [],
      changes: [],
      changeOverflowAt: null,
    };
  }

  function nodeCompare(a, b) {
    const at = a?.timestamps?.createdAt ?? 0;
    const bt = b?.timestamps?.createdAt ?? 0;
    if (at !== bt) return at - bt;
    return String(a.id).localeCompare(String(b.id));
  }

  function insertSorted(list, value, compare) {
    let low = 0;
    let high = list.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (compare(list[mid], value) <= 0) low = mid + 1;
      else high = mid;
    }
    list.splice(low, 0, value);
  }

  function buildIndexes() {
    if (indexesBuilt) return;
    indexesBuilt = true;
    for (const [key, value] of tables.nodes.entries()) {
      const projectId = key.split('__')[0];
      if (!indexes.has(projectId)) indexes.set(projectId, emptyIndex());
      const entry = indexes.get(projectId);
      const node = value?.id ? value : { ...value, id: key.split('__').slice(1).join('__') };
      entry.nodes.set(node.id, node);
    }
    for (const entry of indexes.values()) {
      entry.nodeOrder = [...entry.nodes.values()].sort(nodeCompare);
    }
    for (const [key, value] of tables.events.entries()) {
      const projectId = key.split('__')[0];
      if (!indexes.has(projectId)) indexes.set(projectId, emptyIndex());
      indexes.get(projectId).events.push(value);
    }
    for (const entry of indexes.values()) entry.events.sort((a, b) => (a?.seq ?? 0) - (b?.seq ?? 0));
    for (const [key, value] of tables.runs.entries()) {
      const projectId = key.split('__')[0];
      if (!indexes.has(projectId)) indexes.set(projectId, emptyIndex());
      const run = { ...value, id: value?.id ?? key.split('__').slice(1).join('__') };
      indexes.get(projectId).runs.push(run);
    }
    for (const entry of indexes.values()) entry.runs.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    for (const [key, value] of tables.cycles.entries()) {
      const projectId = key.split('__')[0];
      if (!indexes.has(projectId)) indexes.set(projectId, emptyIndex());
      const cycle = { ...value, id: value?.id ?? key.split('__').slice(1).join('__') };
      indexes.get(projectId).cycles.push(cycle);
    }
    for (const entry of indexes.values()) entry.cycles.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  }

  function indexFor(projectId) {
    if (!indexesBuilt) buildIndexes();
    let entry = indexes.get(projectId);
    if (!entry) {
      entry = emptyIndex();
      indexes.set(projectId, entry);
    }
    return entry;
  }

  /**
   * Journal one node write for `changesSince`. Entries carry the project
   * revision observed *before* the caller bumps it, and queries include
   * `revision >= since`, so a client never misses a write because it raced the
   * bump (duplicates are idempotent to apply).
   */
  function recordChange(projectId, nodeId, kind, status, rev) {
    const entry = indexFor(projectId);
    if (entry.changes.length >= 5_000) {
      const dropped = entry.changes.shift();
      entry.changeOverflowAt = Math.max(entry.changeOverflowAt ?? 0, dropped?.revision ?? 0);
    }
    entry.changes.push({
      nodeId,
      kind,
      status: status ?? null,
      rev: rev ?? 0,
      revision: getProject(projectId)?.revision ?? 0,
      at: Date.now(),
    });
  }

  /** Per-project async mutex so concurrent HTTP requests cannot interleave. */
  const locks = new Map();
  function withProjectLock(projectId, task) {
    const previous = locks.get(projectId) ?? Promise.resolve();
    const run = previous.then(() => task());
    const tail = run.then(() => undefined, () => undefined);
    locks.set(projectId, tail);
    return run.finally(() => {
      if (locks.get(projectId) === tail) locks.delete(projectId);
    });
  }

  function getProject(projectId) {
    return tables.projects.get(projectId);
  }

  function listProjects() {
    const out = [];
    for (const [key, value] of tables.projects.entries()) {
      out.push({ ...value, id: value?.id ?? key });
    }
    out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return out;
  }

  function saveProject(project) {
    return tables.projects.put(project.id, project);
  }

  function getNode(projectId, nodeId) {
    return tables.nodes.get(nodeStorageKey(projectId, nodeId));
  }

  /** O(page) list of one project's nodes, oldest first (stable order S1). */
  function listNodes(projectId, { limit = Infinity, cursor = null } = {}) {
    const entry = indexFor(projectId);
    let start = 0;
    if (cursor) {
      const index = entry.nodeOrder.findIndex((node) => node.id === cursor);
      start = index >= 0 ? index + 1 : 0;
    }
    const end = Number.isFinite(limit) ? start + limit : undefined;
    const rows = entry.nodeOrder.slice(start, end);
    return rows.map((node) => ({ ...node }));
  }

  function countNodes(projectId) {
    return indexFor(projectId).nodes.size;
  }

  /** Subscribe to every node write, including legacy writers outside the kernel. */
  function subscribeNodes(listener) {
    if (typeof listener !== 'function') throw new TypeError('subscribeNodes: listener must be a function');
    nodeListeners.add(listener);
    return () => nodeListeners.delete(listener);
  }

  function notifyNode(projectId, node, kind) {
    for (const listener of nodeListeners) {
      try { listener(projectId, node, kind); } catch { /* a projection must never fail a write */ }
    }
  }

  function saveNode(projectId, node) {
    const entry = indexFor(projectId);
    const key = nodeStorageKey(projectId, node.id);
    const previous = entry.nodes.get(node.id);
    entry.nodes.set(node.id, node);
    if (previous) {
      const at = entry.nodeOrder.findIndex((candidate) => candidate.id === node.id);
      if (at >= 0) entry.nodeOrder.splice(at, 1);
    }
    insertSorted(entry.nodeOrder, node, nodeCompare);
    recordChange(projectId, node.id, previous ? 'node.updated' : 'node.created', node.status, node.rev);
    notifyNode(projectId, node, previous ? 'node.updated' : 'node.created');
    return tables.nodes.put(key, node);
  }

  function deleteNode(projectId, nodeId) {
    const entry = indexFor(projectId);
    entry.nodes.delete(nodeId);
    const at = entry.nodeOrder.findIndex((candidate) => candidate.id === nodeId);
    if (at >= 0) entry.nodeOrder.splice(at, 1);
    recordChange(projectId, nodeId, 'node.removed', null, null);
    notifyNode(projectId, { id: nodeId }, 'node.removed');
    return tables.nodes.delete(nodeStorageKey(projectId, nodeId));
  }

  /** Remove every record owned by one project (nodes/runs/cycles/events + project). */
  async function deleteProject(projectId) {
    indexes.delete(projectId);
    const prefix = `${projectId}__`;
    for (const table of ['nodes', 'runs', 'cycles', 'events']) {
      const keys = [];
      for (const key of tables[table].keys()) {
        if (key.startsWith(prefix)) keys.push(key);
      }
      for (const key of keys) await tables[table].delete(key);
    }
    await tables.projects.delete(projectId);
  }

  /**
   * Append one LabEvent; mutates `project.counters.eventSeq` (caller saves project).
   * @returns {Promise<object>} the stored event.
   */
  async function appendEvent(project, type, payload = {}) {
    project.counters = project.counters ?? {};
    project.counters.eventSeq = (project.counters.eventSeq ?? 0) + 1;
    const seq = project.counters.eventSeq;
    const event = {
      seq,
      projectId: project.id,
      at: Date.now(),
      type,
      ...payload,
    };
    await tables.events.put(eventStorageKey(project.id, seq), event);
    const entry = indexFor(project.id);
    if ((entry.events[entry.events.length - 1]?.seq ?? 0) < seq) entry.events.push(event);
    else insertSorted(entry.events, event, (a, b) => (a?.seq ?? 0) - (b?.seq ?? 0));
    return event;
  }

  /**
   * Crash recovery only (kernel/executor.js `recover`): remove an event written
   * by a commit that was never acknowledged. Acknowledged events are never deleted.
   */
  async function deleteEventRecord(projectId, seq) {
    const acknowledged = getProject(projectId)?.counters?.eventSeq ?? 0;
    if (seq <= acknowledged) throw new Error(`refusing to delete acknowledged event ${projectId}#${seq}`);
    await tables.events.delete(eventStorageKey(projectId, seq));
    const entry = indexFor(projectId);
    const at = entry.events.findIndex((event) => event.seq === seq);
    if (at >= 0) entry.events.splice(at, 1);
  }

  function firstEventAfter(events, after) {
    let low = 0;
    let high = events.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((events[mid]?.seq ?? 0) <= after) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  /** @returns {Array<object>} events with seq > after, ascending (all of them). */
  function listEvents(projectId, after = 0) {
    const entry = indexFor(projectId);
    return entry.events.slice(firstEventAfter(entry.events, after)).map((event) => ({ ...event }));
  }

  /**
   * One event page: O(log n + page), not O(all events) (S2/S11).
   * @returns {{events: object[], nextSeq: number|null, total: number, hasMore: boolean}}
   */
  function pageEvents(projectId, { after = 0, limit = 100 } = {}) {
    const entry = indexFor(projectId);
    const size = Math.max(1, Math.min(1_000, Number.isFinite(limit) ? limit : 100));
    const start = firstEventAfter(entry.events, after);
    const page = entry.events.slice(start, start + size).map((event) => ({ ...event }));
    const hasMore = start + size < entry.events.length;
    return {
      events: page,
      nextSeq: hasMore ? (page[page.length - 1]?.seq ?? null) : null,
      total: entry.events.length,
      hasMore,
    };
  }

  /** Bounded run page, newest first (S3). */
  function pageRuns(projectId, { limit = 50, cursor = null } = {}) {
    const entry = indexFor(projectId);
    const size = Math.max(1, Math.min(500, Number.isFinite(limit) ? limit : 50));
    let start = 0;
    if (cursor) {
      const index = entry.runs.findIndex((run) => run.id === cursor);
      start = index >= 0 ? index + 1 : 0;
    }
    const runs = entry.runs.slice(start, start + size).map((run) => ({ ...run }));
    return { runs, nextCursor: runs.length > 0 && start + size < entry.runs.length ? runs[runs.length - 1].id : null, total: entry.runs.length };
  }

  /** Changes since a project revision (S10). `full` means the journal cannot answer. */
  function changesSince(projectId, sinceRevision) {
    const project = getProject(projectId);
    const revision = project?.revision ?? 0;
    const since = Number.isFinite(Number(sinceRevision)) ? Number(sinceRevision) : 0;
    if (since >= revision) return { unchanged: true, revision };
    const entry = indexFor(projectId);
    if (entry.changes.length === 0 || (entry.changeOverflowAt !== null && since < entry.changeOverflowAt)) {
      return { full: true, revision, reason: entry.changes.length === 0 ? 'journal_empty' : 'journal_overflow' };
    }
    const latest = new Map();
    for (const change of entry.changes) {
      if (change.revision < since) continue;
      latest.set(change.nodeId, change);
    }
    const changed = [];
    const removed = [];
    for (const change of latest.values()) {
      if (change.kind === 'node.removed') { removed.push(change.nodeId); continue; }
      const node = entry.nodes.get(change.nodeId);
      if (!node) { removed.push(change.nodeId); continue; }
      changed.push({
        id: node.id,
        status: node.status,
        rev: node.rev ?? 0,
        title: node.title ?? '',
        priority: node.priority?.class ?? null,
        updatedAt: node.timestamps?.updatedAt ?? null,
      });
    }
    return { unchanged: false, revision, changed, removed, fromRevision: since };
  }

  function saveRun(projectId, run) {
    const entry = indexFor(projectId);
    const at = entry.runs.findIndex((candidate) => candidate.id === run.id);
    if (at >= 0) entry.runs.splice(at, 1);
    insertSorted(entry.runs, run, (a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    return tables.runs.put(`${projectId}__${run.id}`, run);
  }

  function getRun(projectId, runId) {
    return tables.runs.get(`${projectId}__${runId}`);
  }

  function listRuns(projectId, limit = 50) {
    return indexFor(projectId).runs.slice(0, Math.max(1, limit)).map((run) => ({ ...run }));
  }

  function saveCycle(projectId, cycle) {
    const entry = indexFor(projectId);
    const at = entry.cycles.findIndex((candidate) => candidate.id === cycle.id);
    if (at >= 0) entry.cycles.splice(at, 1);
    insertSorted(entry.cycles, cycle, (a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    return tables.cycles.put(`${projectId}__${cycle.id}`, cycle);
  }

  function listCycles(projectId, limit = 50) {
    return indexFor(projectId).cycles.slice(0, Math.max(1, limit)).map((cycle) => ({ ...cycle }));
  }

  /** Current maximum event seq for a project (0 when none). */
  function maxEventSeq(projectId) {
    const project = getProject(projectId);
    return project?.counters?.eventSeq ?? 0;
  }

  return {
    domainName: DOMAIN_NAME,
    worktreeRootFor,
    withProjectLock,
    getProject,
    listProjects,
    saveProject,
    getNode,
    listNodes,
    countNodes,
    saveNode,
    subscribeNodes,
    deleteNode,
    deleteProject,
    appendEvent,
    deleteEventRecord,
    listEvents,
    pageEvents,
    changesSince,
    pageRuns,
    maxEventSeq,
    saveRun,
    getRun,
    listRuns,
    saveCycle,
    listCycles,
    close: () => domain.close(),
  };
}
