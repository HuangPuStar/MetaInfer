/**
 * Executor: the single writer of Lab state (design rule G1).
 *
 * `commit()` applies a list of mutations atomically for one project:
 *   1. idempotency lookup;
 *   2. load a deep-copied working set (never mutate records the store returns);
 *   3. staleness check against the caller's `basis` revision;
 *   4. run every reducer (any MutationError rejects the whole commit, nothing is written);
 *   5. persist events FIRST (each carries redo `effects` and commit markers),
 *      then node/project records, then the project counters;
 *   6. update the projection and publish to the bus.
 *
 * Crash safety: if the process dies between steps 5 and its end, `recover()`
 * finds events beyond the persisted `counters.eventSeq`, redoes complete
 * commits and discards the tail of an incomplete one (those events were never
 * acknowledged to anyone, so they are not history).
 *
 * Callers that already hold `store.withProjectLock` (legacy code during the
 * migration, WP P1.7) must use `commitLocked`; `commit` takes the lock itself.
 */
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_TRANSITIONS,
  MutationError,
  applyMutation,
  createWorkingSet,
  redoEffect,
} from './mutations.js';
import { currentCause } from './trace.js';

const ACTOR_KINDS = new Set(['human', 'expert', 'dispatcher', 'mcp', 'system', 'legacy']);
const IDEMPOTENCY_LIMIT = 10_000;

function normalizeActor(actor) {
  if (!actor || typeof actor !== 'object') throw new MutationError('invalid_commit', 'actor is required');
  if (!ACTOR_KINDS.has(actor.kind)) throw new MutationError('invalid_commit', `unknown actor kind ${actor.kind}`);
  if (typeof actor.id !== 'string' || !actor.id) throw new MutationError('invalid_commit', 'actor.id is required');
  return { kind: actor.kind, id: actor.id };
}

/**
 * @param {object} deps
 * @param {object} deps.store ProjectStore from host/store.js
 * @param {() => number} [deps.clock]
 * @param {object} [deps.projection] receives `applyCommit(projectId, result)`
 * @param {object} [deps.bus] receives `publish(events)`
 * @param {object} [deps.transitions] status transition table override
 * @param {(error: unknown) => void} [deps.onError] reporter for post-commit hook failures
 */
export function createExecutor({ store, clock = Date.now, projection = null, bus = null, transitions = DEFAULT_TRANSITIONS, onError = () => {} }) {
  /** projectId -> Map(idempotencyKey -> result); bounded, insertion-ordered. */
  const idempotency = new Map();

  function rememberIdempotent(projectId, key, result) {
    if (!key) return;
    let map = idempotency.get(projectId);
    if (!map) { map = new Map(); idempotency.set(projectId, map); }
    map.set(key, result);
    if (map.size > IDEMPOTENCY_LIMIT) map.delete(map.keys().next().value);
  }

  function reject(code, message, extra = {}) {
    return { ok: false, code, message, ...extra };
  }

  /**
   * Apply a commit while the caller holds the project lock.
   * @param {string} projectId
   * @param {object} spec
   * @param {{kind: string, id: string}} spec.actor
   * @param {Array<object>} spec.mutations
   * @param {number} [spec.basis] revision the caller based its decision on
   * @param {boolean} [spec.allowStale] skip the staleness check (system repairs only)
   * @param {string} [spec.idempotencyKey]
   * @param {string} [spec.causeId] id of the event/activation/intent that caused this commit
   * @param {string} [spec.activationId] expert/dispatcher activation that produced it
   * @param {Array<object>} [spec.evidence]
   */
  async function commitLocked(projectId, spec) {
    let actor;
    try {
      actor = normalizeActor(spec?.actor);
    } catch (error) {
      return reject(error.code, error.message);
    }
    if (!Array.isArray(spec.mutations) || spec.mutations.length === 0) {
      return reject('invalid_commit', 'mutations must be a non-empty array');
    }
    const previous = spec.idempotencyKey ? idempotency.get(projectId)?.get(spec.idempotencyKey) : undefined;
    if (previous) return { ...previous, replayed: true };

    const stored = store.getProject(projectId);
    if (!stored) return reject('not_found', `project ${projectId} does not exist`);
    const ws = createWorkingSet(stored, (nodeId) => store.getNode(projectId, nodeId));
    const baseRevision = stored.revision ?? 0;

    if (Number.isFinite(spec.basis) && !spec.allowStale) {
      const conflicts = [];
      for (const mutation of spec.mutations) {
        if (!mutation?.nodeId) continue;
        const node = ws.getNode(mutation.nodeId);
        if (node && (node.rev ?? 0) > spec.basis) conflicts.push({ nodeId: node.id, rev: node.rev });
      }
      if (conflicts.length > 0) {
        return reject('stale', 'targets changed after the caller\'s basis revision', { stale: true, conflicts, revision: baseRevision });
      }
    }

    const now = clock();
    // The cause pointer travels with the mutation so a node can answer "what made
    // me" without scanning the event log (usability A1).
    const ctx = { actor, now, transitions, causeId: spec.causeId ?? null };
    const produced = [];
    try {
      for (const mutation of spec.mutations) produced.push(...applyMutation(ws, mutation, ctx));
    } catch (error) {
      if (error instanceof MutationError) return reject(error.code, error.message, error.detail ? { detail: error.detail } : {});
      throw error;
    }

    const revision = baseRevision + 1;
    const commitId = `cmt-${randomUUID().slice(0, 12)}`;
    const project = ws.project;
    project.revision = revision;
    for (const nodeId of ws.touchedNodeIds()) {
      const node = ws.peekNode(nodeId);
      if (node) node.rev = revision;
    }
    // A pure-record commit still produces an event so the revision bump is explained.
    const events = produced.length > 0 ? produced : [{ type: 'kernel/noop', data: {}, effects: [] }];

    // 5a. events first: they are the redo log.
    const written = [];
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      const payload = {
        ...(event.nodeId ? { nodeId: event.nodeId } : {}),
        actor,
        causeId: spec.causeId ?? currentCause(),
        activationId: spec.activationId ?? null,
        basis: Number.isFinite(spec.basis) ? spec.basis : null,
        revision,
        commit: { id: commitId, index, size: events.length },
        data: event.data ?? {},
        effects: event.effects ?? [],
        ...(index === 0 && Array.isArray(spec.evidence) && spec.evidence.length > 0 ? { evidence: spec.evidence } : {}),
      };
      written.push(await store.appendEvent(project, event.type, payload));
    }
    // 5b. records. Run records are effect-only (no node working set entry).
    for (const event of events) {
      for (const effect of event.effects ?? []) {
        if (effect.op === 'run.put' && effect.run) await store.saveRun(projectId, effect.run);
        if (effect.op === 'cycle.put' && effect.cycle) await store.saveCycle(projectId, effect.cycle);
      }
    }
    for (const nodeId of ws.touchedNodeIds()) {
      if (ws.isDeleted(nodeId)) await store.deleteNode(projectId, nodeId);
      else await store.saveNode(projectId, ws.peekNode(nodeId));
    }
    // 5c. project last: persisting counters.eventSeq acknowledges the commit.
    await store.saveProject(project);

    const result = {
      ok: true,
      commitId,
      revision,
      events: written,
      nodeIds: ws.touchedNodeIds(),
    };
    rememberIdempotent(projectId, spec.idempotencyKey, result);
    try {
      projection?.applyCommit(projectId, written);
    } catch (error) {
      onError(error);
    }
    try {
      bus?.publish(written);
    } catch (error) {
      onError(error);
    }
    return result;
  }

  /**
   * Apply a commit, taking the project lock. The write permit makes the kernel
   * the only permitted writer when `kernel.strictWrites` is enabled: every store
   * mutation performed inside a commit inherits it.
   */
  function commit(projectId, spec) {
    return store.withProjectLock(projectId, () => (
      typeof store.withWritePermit === 'function'
        ? store.withWritePermit(() => commitLocked(projectId, spec))
        : commitLocked(projectId, spec)
    ));
  }

  /**
   * Redo or discard events written after the last acknowledged commit.
   * Must run at boot, before anything else writes. Idempotent.
   * @returns {Promise<{redone: number, discarded: number}>}
   */
  async function recover(projectId) {
    return store.withProjectLock(projectId, () => (typeof store.withWritePermit === 'function'
      ? store.withWritePermit(() => recoverLocked(projectId))
      : recoverLocked(projectId)));
  }

  async function recoverLocked(projectId) {
    return (async () => {
      const project = store.getProject(projectId);
      if (!project) return { redone: 0, discarded: 0 };
      const acknowledged = project.counters?.eventSeq ?? 0;
      const tail = store.listEvents(projectId, acknowledged).filter((event) => event.commit);
      if (tail.length === 0) return { redone: 0, discarded: 0 };
      const byCommit = new Map();
      for (const event of tail) {
        if (!byCommit.has(event.commit.id)) byCommit.set(event.commit.id, []);
        byCommit.get(event.commit.id).push(event);
      }
      const working = structuredClone(project);
      const nodes = new Map();
      const runs = new Map();
      const cycles = new Map();
      const deleted = new Set();
      const target = {
        project: working,
        getNode(nodeId) {
          if (deleted.has(nodeId)) return undefined;
          if (!nodes.has(nodeId)) {
            const storedNode = store.getNode(projectId, nodeId);
            nodes.set(nodeId, storedNode ? structuredClone(storedNode) : undefined);
          }
          return nodes.get(nodeId);
        },
        putNode(node) { deleted.delete(node.id); nodes.set(node.id, node); },
        deleteNode(nodeId) { nodes.delete(nodeId); deleted.add(nodeId); },
        putRun(run) { runs.set(run.id, run); },
        putCycle(cycle) { cycles.set(cycle.id, cycle); },
      };
      let redone = 0;
      let discarded = 0;
      let lastSeq = acknowledged;
      let lastRevision = project.revision ?? 0;
      let truncated = false;
      for (const events of byCommit.values()) {
        events.sort((a, b) => a.seq - b.seq);
        const complete = !truncated && events.length === events[0].commit.size
          && events.every((event, index) => event.commit.index === index);
        if (!complete) {
          // Everything from the first incomplete commit on was never acknowledged.
          truncated = true;
          discarded += events.length;
          continue;
        }
        for (const event of events) {
          for (const effect of event.effects ?? []) redoEffect(target, effect, event.revision);
          lastSeq = Math.max(lastSeq, event.seq);
          lastRevision = Math.max(lastRevision, event.revision ?? lastRevision);
          redone += 1;
        }
      }
      if (discarded > 0) {
        for (const event of tail) {
          if (event.seq > lastSeq) await store.deleteEventRecord?.(projectId, event.seq);
        }
      }
      for (const [nodeId, node] of nodes) if (node) await store.saveNode(projectId, node);
      for (const nodeId of deleted) await store.deleteNode(projectId, nodeId);
      for (const run of runs.values()) await store.saveRun(projectId, run);
      for (const cycle of cycles.values()) await store.saveCycle(projectId, cycle);
      working.counters = { ...(working.counters ?? {}), eventSeq: lastSeq };
      working.revision = lastRevision;
      await store.saveProject(working);
      return { redone, discarded };
    })();
  }

  /**
   * Bootstrap a brand-new project through the same single-writer permit. The
   * project row must exist before a commit can load it; this method writes the
   * skeleton *inside the executor* and immediately commits its creation events,
   * so `strictWrites=throw` still sees exactly one writer.
   */
  async function bootstrapProject(projectId, project, spec) {
    return store.withProjectLock(projectId, () => (typeof store.withWritePermit === 'function'
      ? store.withWritePermit(async () => {
        const skeleton = {
          ...project,
          id: projectId,
          revision: 0,
          counters: { ...(project.counters ?? {}), eventSeq: 0 },
          updatedAt: project.updatedAt ?? Date.now(),
          createdAt: project.createdAt ?? Date.now(),
        };
        await store.saveProject(skeleton);
        return commitLocked(projectId, spec);
      })
      : commitLocked(projectId, spec)));
  }

  /** Project deletion is a maintenance write; keep it on the executor too. */
  async function deleteProject(projectId, spec = {}) {
    return store.withProjectLock(projectId, () => (typeof store.withWritePermit === 'function'
      ? store.withWritePermit(async () => {
        await store.deleteProject(projectId);
        return { ok: true, projectId, actor: normalizeActor(spec.actor ?? { kind: 'system', id: 'service' }) };
      })
      : (async () => {
        await store.deleteProject(projectId);
        return { ok: true, projectId };
      })()));
  }

  return { commit, commitLocked, bootstrapProject, deleteProject, recover };
}
