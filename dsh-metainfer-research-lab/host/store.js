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
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { createEventArchive } from './kernel/eventlog.js';

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
/**
 * Single-writer guard (G1, `kernel.strictWrites`).
 *
 * Records may only be mutated by the kernel executor. That invariant used to be
 * documentation; this is the runtime check. `warn` counts unpermitted writes and
 * logs once per operation, `throw` rejects them (tests use this to prove the
 * executor's permit covers every write it performs), `off` disables the check.
 *
 * The permit travels in AsyncLocalStorage because a commit writes across awaits.
 */
const writePermit = new AsyncLocalStorage();
const projectLockScope = new AsyncLocalStorage();

export function withWritePermit(fn) {
  return writePermit.run({ kernel: true }, fn);
}

function readCtxConfig(ctx) {
  try {
    return ctx.config ?? {};
  } catch {
    return {};
  }
}

export async function openStore(ctx, config = {}) {
  const cfg = config && Object.keys(config).length ? config : readCtxConfig(ctx);
  // Per-store state: a test process may open several stores, and one store's
  // throw mode must never reject another store's setup writes.
  const writeGuard = { mode: 'off', unpermitted: 0, byOp: {}, warnings: 0 };

  function guardWrite(op) {
    if (writeGuard.mode === 'off') return;
    if (writePermit.getStore()?.kernel === true) return;
    writeGuard.unpermitted += 1;
    writeGuard.byOp[op] = (writeGuard.byOp[op] ?? 0) + 1;
    if (writeGuard.mode === 'throw') {
      const error = new Error(`unpermitted store write: ${op} (kernel.strictWrites=${writeGuard.mode})`);
      error.code = 'unpermitted_write';
      throw error;
    }
    if (writeGuard.warnings < 5) {
      writeGuard.warnings += 1;
      console.warn(`[metainfer-lab] unpermitted store write: ${op} (kernel.strictWrites=warn)`);
    }
  }

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
  const archive = createEventArchive({
    root: cfg?.kernel?.eventArchiveRoot ?? path.join(dshHome(), 'metainfer-research-lab', 'eventlog'),
    hotEvents: cfg?.kernel?.hotEvents ?? 50_000,
    segmentSize: cfg?.kernel?.eventArchiveSegment ?? 10_000,
  });
  const coldCache = new Map();
  // Merged cold+hot event view. Archived segments are immutable, so only the
  // hot tail moves; rebuilding the whole 100k array on every page was the S12
  // 60 ms first-page regression. Keep it warm and append the hot tail.
  const timelineCache = new Map();

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
      children: new Map(),
      changes: [],
      changeOverflowAt: null,
    };
  }

  function parentIdsOf(node) {
    if (Array.isArray(node?.parentIds) && node.parentIds.length > 0) return node.parentIds;
    return node?.parentId ? [node.parentId] : [];
  }

  function linkParents(entry, node) {
    for (const parent of parentIdsOf(node)) {
      if (!entry.children.has(parent)) entry.children.set(parent, new Set());
      entry.children.get(parent).add(node.id);
    }
  }

  function unlinkParents(entry, node) {
    for (const parent of parentIdsOf(node)) {
      const set = entry.children.get(parent);
      if (!set) continue;
      set.delete(node.id);
      if (set.size === 0) entry.children.delete(parent);
    }
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
      entry.children = new Map();
      for (const node of entry.nodes.values()) {
        for (const parent of parentIdsOf(node)) {
          if (!entry.children.has(parent)) entry.children.set(parent, new Set());
          entry.children.get(parent).add(node.id);
        }
      }
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
    const inherited = projectLockScope.getStore();
    const held = inherited ? new Set(inherited) : new Set();
    held.add(projectId);
    const run = previous.then(() => projectLockScope.run(held, task));
    const tail = run.then(() => undefined, () => undefined);
    locks.set(projectId, tail);
    return run.finally(() => {
      if (locks.get(projectId) === tail) locks.delete(projectId);
    });
  }

  /** True when the current async call chain already holds this project's lock. */
  function isProjectLocked(projectId) {
    return projectLockScope.getStore()?.has(projectId) === true;
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
    guardWrite('saveProject');
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

  /** True when another node names `nodeId` as parent; O(1) via the child index. */
  function hasChildren(projectId, nodeId) {
    return (indexFor(projectId).children.get(nodeId)?.size ?? 0) > 0;
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
    guardWrite('saveNode');
    const entry = indexFor(projectId);
    const key = nodeStorageKey(projectId, node.id);
    const previous = entry.nodes.get(node.id);
    if (previous) unlinkParents(entry, previous);
    entry.nodes.set(node.id, node);
    linkParents(entry, node);
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
    guardWrite('deleteNode');
    const entry = indexFor(projectId);
    const previous = entry.nodes.get(nodeId);
    if (previous) unlinkParents(entry, previous);
    entry.nodes.delete(nodeId);
    const at = entry.nodeOrder.findIndex((candidate) => candidate.id === nodeId);
    if (at >= 0) entry.nodeOrder.splice(at, 1);
    recordChange(projectId, nodeId, 'node.removed', null, null);
    notifyNode(projectId, { id: nodeId }, 'node.removed');
    return tables.nodes.delete(nodeStorageKey(projectId, nodeId));
  }

  /** Remove every record owned by one project (nodes/runs/cycles/events + project). */
  async function deleteProject(projectId) {
    guardWrite('deleteProject');
    indexes.delete(projectId);
    coldCache.delete(projectId);
    timelineCache.delete(projectId);
    await archive.removeProject(projectId);
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
    guardWrite('appendEvent');
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
    // Every durable event needs a cause, including writes that do not come
    // from the runtime activation path (planned cancel, merge prep, GC,
    // reconcile, dashboard edits). A type+seq fallback keeps `explain_node`
    // and the cause chain non-empty without inventing a cross-node link.
    if (event.causeId === undefined || event.causeId === null) {
      event.causeId = `${type}:${project.id}:${seq}`;
    }
    // Build the in-memory index before inserting the row; otherwise the first
    // append can make buildIndexes() load the row and then push it a second time.
    const entry = indexFor(project.id);
    await tables.events.put(eventStorageKey(project.id, seq), event);
    if ((entry.events[entry.events.length - 1]?.seq ?? 0) < seq) entry.events.push(event);
    else insertSorted(entry.events, event, (a, b) => (a?.seq ?? 0) - (b?.seq ?? 0));
    try {
      await archiveEvents(project.id);
    } catch (error) {
      // Archiving must never lose an event: on failure the hot table stays the
      // source of truth and the next append retries.
      ctx.logger?.warn?.(`[metainfer-lab] event archive deferred: ${error?.message ?? error}`);
    }
    return event;
  }

  /**
   * Crash recovery only (kernel/executor.js `recover`): remove an event written
   * by a commit that was never acknowledged. Acknowledged events are never deleted.
   */
  async function deleteEventRecord(projectId, seq) {
    guardWrite('deleteEventRecord');
    const acknowledged = getProject(projectId)?.counters?.eventSeq ?? 0;
    if (seq <= acknowledged) throw new Error(`refusing to delete acknowledged event ${projectId}#${seq}`);
    await tables.events.delete(eventStorageKey(projectId, seq));
    const entry = indexFor(projectId);
    const at = entry.events.findIndex((event) => event.seq === seq);
    if (at >= 0) entry.events.splice(at, 1);
  }

  /** Archived events for one project, cached until the next archive write. */
  function coldEvents(projectId) {
    if (!coldCache.has(projectId)) coldCache.set(projectId, archive.readArchivedSync(projectId));
    return coldCache.get(projectId);
  }

  function rebuildTimeline(projectId, cold) {
    const hot = indexFor(projectId).events;
    const merged = [...cold, ...hot].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    timelineCache.set(projectId, { cold, hotLength: hot.length, events: merged });
    return merged;
  }

  function allEvents(projectId) {
    const cold = coldEvents(projectId);
    if (cold.length === 0) return indexFor(projectId).events;
    const hot = indexFor(projectId).events;
    const cached = timelineCache.get(projectId);
    if (cached && cached.cold === cold && cached.hotLength <= hot.length) {
      const extra = hot.slice(cached.hotLength);
      const lastSeq = cached.events[cached.events.length - 1]?.seq ?? 0;
      if (extra.length === 0 || (extra[0]?.seq ?? 0) > lastSeq) {
        cached.events.push(...extra);
        cached.hotLength = hot.length;
        return cached.events;
      }
    }
    return rebuildTimeline(projectId, cold);
  }

  /**
   * Move the oldest complete segment out of the hot table. The segment file and
   * its checksum are durable before any row is deleted; a failed archive write
   * leaves the table untouched. Archived events remain readable through
   * listEvents/pageEvents.
   */
  async function archiveEvents(projectId) {
    const entry = indexFor(projectId);
    if (entry.events.length <= archive.hotEvents) return { archived: 0, segments: (await archive.listSegments(projectId)).length };
    const segment = entry.events.slice(0, archive.segmentSize);
    if (segment.length === 0) return { archived: 0, segments: (await archive.listSegments(projectId)).length };
    const descriptor = await archive.writeSegment(projectId, segment);
    guardWrite('archiveEvent');
    for (const event of segment) await tables.events.delete(eventStorageKey(projectId, event.seq));
    entry.events.splice(0, segment.length);
    coldCache.delete(projectId);
    timelineCache.delete(projectId);
    // Pay the cold merge at the archive boundary, not on the next first page.
    const cold = coldEvents(projectId);
    if (cold.length > 0) rebuildTimeline(projectId, cold);
    return { archived: segment.length, ...descriptor, segments: (await archive.listSegments(projectId)).length };
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
    const events = allEvents(projectId);
    return events.slice(firstEventAfter(events, after)).map((event) => ({ ...event }));
  }

  /**
   * One event page: O(log n + page), not O(all events) (S2/S11).
   * @returns {{events: object[], nextSeq: number|null, total: number, hasMore: boolean}}
   */
  function storeProjectEventSeq(projectId) {
    const project = getProject(projectId);
    return Number.isInteger(project?.counters?.eventSeq) ? project.counters.eventSeq : 0;
  }

  function pageEvents(projectId, { after = 0, limit = 100 } = {}) {
    const size = Math.max(1, Math.min(1_000, Number.isFinite(limit) ? limit : 100));
    const descriptors = archive.listSegmentsSync(projectId);
    if (descriptors.length === 0) {
      const events = allEvents(projectId);
      const start = firstEventAfter(events, after);
      const page = events.slice(start, start + size).map((event) => ({ ...event }));
      const hasMore = start + size < events.length;
      return {
        events: page,
        nextSeq: hasMore ? (page[page.length - 1]?.seq ?? null) : null,
        total: events.length,
        hasMore,
      };
    }
    // S12 restart path: do not decompress every cold segment just to return the
    // first page. Segments carry contiguous seq ranges, so the offset and total
    // are known from metadata; only the segment(s) that overlap the page are read.
    const coldTotal = descriptors.reduce((sum, descriptor) => sum + (descriptor.to - descriptor.from + 1), 0);
    // Total is known from metadata: sequences are contiguous. Do not build the
    // hot index until the page actually crosses into the hot tail; building it
    // was the 45 ms restart cost, not decompressing the cold segment.
    const total = Math.max(coldTotal, storeProjectEventSeq(projectId));
    let start = 0;
    for (const descriptor of descriptors) {
      if (descriptor.to <= after) {
        start += descriptor.to - descriptor.from + 1;
        continue;
      }
      if (descriptor.from <= after) start += after - descriptor.from + 1;
      break;
    }
    const page = [];
    for (const descriptor of descriptors) {
      if (page.length >= size) break;
      if (descriptor.to <= after) continue;
      // Restart fast path: the first page of the oldest segment is served from
      // the sidecar head. Fall back to the checksummed segment if absent.
      const head = after === 0 && page.length === 0 ? archive.readHeadSync(descriptor) : null;
      const events = head ?? archive.readSegmentSync(descriptor);
      for (const event of events) {
        if (event.seq <= after) continue;
        page.push({ ...event });
        if (page.length >= size) break;
      }
      if (head && page.length < size) {
        // The head was too short for this page; the next descriptor continues,
        // but this descriptor's tail was not read. Read it before moving on.
        const full = archive.readSegmentSync(descriptor);
        for (const event of full) {
          if (event.seq <= after || (page.length > 0 && event.seq <= page[page.length - 1].seq)) continue;
          page.push({ ...event });
          if (page.length >= size) break;
        }
      }
    }
    if (page.length < size) {
      const hot = indexFor(projectId).events;
      if (after >= coldTotal) start += firstEventAfter(hot, after);
      const at = firstEventAfter(hot, page.length > 0 ? (page[page.length - 1]?.seq ?? after) : after);
      for (let index = at; index < hot.length && page.length < size; index += 1) page.push({ ...hot[index] });
    }
    const hasMore = start + page.length < total;
    return {
      events: page,
      nextSeq: hasMore ? (page[page.length - 1]?.seq ?? null) : null,
      total,
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
    guardWrite('saveRun');
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
    guardWrite('saveCycle');
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

  /** @param {'off'|'warn'|'throw'} mode */
  function setStrictWrites(mode) {
    if (!['off', 'warn', 'throw'].includes(mode)) throw new Error(`unknown strictWrites mode: ${mode}`);
    writeGuard.mode = mode;
  }

  function writeStats() {
    return { mode: writeGuard.mode, unpermitted: writeGuard.unpermitted, byOp: { ...writeGuard.byOp } };
  }

  return {
    domainName: DOMAIN_NAME,
    withWritePermit,
    setStrictWrites,
    writeStats,
    worktreeRootFor,
    withProjectLock,
    isProjectLocked,
    getProject,
    listProjects,
    saveProject,
    getNode,
    listNodes,
    countNodes,
    hasChildren,
    saveNode,
    subscribeNodes,
    deleteNode,
    deleteProject,
    appendEvent,
    archiveEvents,
    listEventSegments: (projectId) => archive.listSegments(projectId),
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
