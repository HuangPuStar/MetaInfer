/**
 * Trace helpers: naming, digests, cause propagation and causal-chain walks.
 *
 * Three linked layers (design rule G3):
 *   Lab event log  --causeId/activationId-->  activation records  --sessionId-->  DSH sessions
 * DSH sessions are the only store of full LLM input/output; the plugin keeps
 * ids and digests, never a second copy of prompts or transcripts.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';

export const ACTOR_KINDS = Object.freeze(['expert', 'dispatcher', 'worker', 'controller', 'curator', 'arbiter', 'postmortem', 'legacy']);

const LABEL_PART = /^[A-Za-z0-9._-]+$/;

/**
 * DSH session label for any Lab-owned LLM session:
 * `mirl/<projectId>/<actorKind>/<actorId>/<activationId>` (activation optional
 * for identity sessions). Grouping by prefix gives one subtree per actor.
 */
export function sessionLabel({ projectId, actorKind, actorId, activationId = null }) {
  for (const [name, value] of Object.entries({ projectId, actorKind, actorId })) {
    if (typeof value !== 'string' || !LABEL_PART.test(value)) throw new Error(`sessionLabel: invalid ${name}`);
  }
  if (activationId !== null && (typeof activationId !== 'string' || !LABEL_PART.test(activationId))) {
    throw new Error('sessionLabel: invalid activationId');
  }
  return ['mirl', projectId, actorKind, actorId, activationId].filter(Boolean).join('/');
}

/** @returns {object|null} the parts of a label produced by `sessionLabel`. */
export function parseSessionLabel(label) {
  const parts = String(label ?? '').split('/');
  if (parts[0] !== 'mirl' || parts.length < 4 || parts.length > 5) return null;
  return { projectId: parts[1], actorKind: parts[2], actorId: parts[3], activationId: parts[4] ?? null };
}

/** sha256 of the exact rendered input (prompt + attached context). */
export function inputDigest(text) {
  return `sha256:${createHash('sha256').update(String(text)).digest('hex')}`;
}

export function newActivationId() {
  return `act-${randomUUID().slice(0, 12)}`;
}

/**
 * A pointer to a full trace. DSH sessions are the default; `execution-log`
 * exists only for the Codex path until it is mirrored into DSH (WP P4.9).
 * @returns {{kind: 'dsh-session', sessionId: string, toolCallId?: string} | {kind: 'execution-log', path: string}}
 */
export function traceRef(kind, value, extra = {}) {
  if (kind === 'dsh-session') {
    if (typeof value !== 'string' || !value) throw new Error('traceRef: sessionId required');
    return { kind, sessionId: value, ...(extra.toolCallId ? { toolCallId: extra.toolCallId } : {}) };
  }
  if (kind === 'execution-log') {
    if (typeof value !== 'string' || !value) throw new Error('traceRef: path required');
    return { kind, path: value };
  }
  throw new Error(`traceRef: unknown kind ${kind}`);
}

const causeStorage = new AsyncLocalStorage();

/**
 * Run `fn` with an ambient cause id so commits made inside it are linked to
 * what triggered them without threading the id through every call.
 */
export function withCause(causeId, fn) {
  return causeStorage.run({ causeId }, fn);
}

/** @returns {string|null} the ambient cause id, if any. */
export function currentCause() {
  return causeStorage.getStore()?.causeId ?? null;
}

/** Stable reference to one event, used as a `causeId`. */
export function eventRef(event) {
  return `evt:${event.projectId}:${event.seq}`;
}

/**
 * Walk a causal chain backwards from one event.
 * `causeId` values are `evt:<project>:<seq>`, `act:<activationId>`,
 * `intent:<intentId>` or `round:<roundId>`; only `evt:` links are followed
 * here; the others terminate the walk and are returned so the caller can
 * resolve them through the activation/intent/round tables.
 *
 * @param {object} start the event to explain
 * @param {(projectId: string, seq: number) => object|undefined} getEvent
 * @param {number} [maxDepth]
 * @returns {{ chain: object[], terminal: string|null }}
 */
export function walkCauses(start, getEvent, maxDepth = 64) {
  const chain = [start];
  const seen = new Set([`${start.projectId}:${start.seq}`]);
  let current = start;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const cause = current.causeId;
    if (!cause) return { chain, terminal: null };
    const match = /^evt:([^:]+):(\d+)$/.exec(cause);
    if (!match) return { chain, terminal: cause };
    const key = `${match[1]}:${match[2]}`;
    if (seen.has(key)) return { chain, terminal: 'cycle' };
    seen.add(key);
    const next = getEvent(match[1], Number(match[2]));
    if (!next) return { chain, terminal: cause };
    chain.push(next);
    current = next;
  }
  return { chain, terminal: 'max-depth' };
}
