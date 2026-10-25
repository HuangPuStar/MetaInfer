/**
 * M1 ProjectStore on DSH storageDomain.
 *
 * Domain name must match /^[a-z][a-z0-9_]*$/ — hence `metainfer_research_lab`.
 * Table value schemas stay permissive for M1 (`z.any()`): records are authored by
 * this plugin and validated by host/lab-service.js. Typed schemas can land with a
 * later domain version bump.
 *
 * Storage conventions:
 * - projects keyed by projectId
 * - nodes keyed by `${projectId}__${nodeId}`
 * - runs / cycles keyed by `${projectId}__${id}`
 * - events keyed by `${projectId}__e${padded seq}` (per-record keys must match
 *   /^[a-zA-Z0-9_-]+$/, so "/" is not allowed)
 */
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export const DOMAIN_NAME = 'metainfer_research_lab';
export const DOMAIN_VERSION = 1;
export const EVENT_RETENTION = 5000;

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

/** Absolute worktree root for one project (M2 creates the actual worktrees). */
export function worktreeRootFor(projectId) {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'metainfer-research-lab', 'worktrees', projectId);
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
 * Open the domain once per Host process and return the storage facade.
 * @param ctx Cordis context with `storageDomain` injected.
 */
export async function openStore(ctx) {
  const domain = await ctx.storageDomain.open(DOMAIN_SPEC);
  const tables = {
    projects: domain.table('projects'),
    nodes: domain.table('nodes'),
    runs: domain.table('runs'),
    cycles: domain.table('cycles'),
    events: domain.table('events'),
  };

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

  function listNodes(projectId) {
    const prefix = `${projectId}__`;
    const out = [];
    for (const [key, value] of tables.nodes.entries()) {
      if (key.startsWith(prefix)) out.push({ ...value, id: value?.id ?? key });
    }
    out.sort((a, b) => {
      const at = a?.timestamps?.createdAt ?? 0;
      const bt = b?.timestamps?.createdAt ?? 0;
      if (at !== bt) return at - bt;
      return String(a.id).localeCompare(String(b.id));
    });
    return out;
  }

  function saveNode(projectId, node) {
    return tables.nodes.put(nodeStorageKey(projectId, node.id), node);
  }

  function deleteNode(projectId, nodeId) {
    return tables.nodes.delete(nodeStorageKey(projectId, nodeId));
  }

  /** Remove every record owned by one project (nodes/runs/cycles/events + project). */
  async function deleteProject(projectId) {
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
    const oldest = seq - EVENT_RETENTION;
    if (oldest > 0) await tables.events.delete(eventStorageKey(project.id, oldest)).catch(() => {});
    return event;
  }

  /** @returns {Array<object>} events with seq > after, ascending. */
  function listEvents(projectId, after = 0) {
    const prefix = `${projectId}__e`;
    const out = [];
    for (const [key, value] of tables.events.entries()) {
      if (key.startsWith(prefix) && (value?.seq ?? 0) > after) out.push(value);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  function saveRun(projectId, run) {
    return tables.runs.put(`${projectId}__${run.id}`, run);
  }

  function getRun(projectId, runId) {
    return tables.runs.get(`${projectId}__${runId}`);
  }

  function listRuns(projectId, limit = 50) {
    const prefix = `${projectId}__run-`;
    const out = [];
    for (const [key, value] of tables.runs.entries()) {
      if (key.startsWith(prefix)) out.push({ ...value, id: value?.id ?? key });
    }
    out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    return out.slice(0, limit);
  }

  function saveCycle(projectId, cycle) {
    return tables.cycles.put(`${projectId}__${cycle.id}`, cycle);
  }

  function listCycles(projectId, limit = 50) {
    const prefix = `${projectId}__cyc-`;
    const out = [];
    for (const [key, value] of tables.cycles.entries()) {
      if (key.startsWith(prefix)) out.push({ ...value, id: value?.id ?? key });
    }
    out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    return out.slice(0, limit);
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
    saveNode,
    deleteNode,
    deleteProject,
    appendEvent,
    listEvents,
    maxEventSeq,
    saveRun,
    getRun,
    listRuns,
    saveCycle,
    listCycles,
    close: () => domain.close(),
  };
}
