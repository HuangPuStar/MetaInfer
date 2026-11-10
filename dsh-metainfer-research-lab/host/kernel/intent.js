/**
 * Judgement log (Stage 3). Every dispatch, priority and proposal decision writes
 * an intent carrying *what was claimed* and *which revision it was based on*.
 * The record is persisted by the kernel (`intent.put`), so it shares the event
 * log, revision and cause chain with the action it explains.
 *
 * Pure: no I/O, no ids from the store — callers supply a stable id.
 */
export const INTENT_KINDS = Object.freeze(['dispatch', 'priority', 'proposal', 'review', 'curate', 'note', 'appeal']);

const MAX_TARGET = 160;
const MAX_RATIONALE = 2_000;
const MAX_CLAIM_BYTES = 4_096;
export const INTENT_TTL_MS = 30 * 60_000;
const MAX_SNAPSHOT_AGE_MS = 24 * 60 * 60_000;
const MAX_NODES_SEEN = 100_000;

function str(value, field, max) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) throw new TypeError(`${field} exceeds ${max} characters`);
  return trimmed;
}

function plain(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  return value;
}

/**
 * B21: a judgement is only comparable when we know what world it saw. Keeping
 * the three fields together prevents callers from comparing a revision from
 * one snapshot with a node count from another.
 *
 * @param {{projectRevision: number, snapshotAgeMs: number, nodesSeen: number}} value
 * @returns {{projectRevision: number, snapshotAgeMs: number, nodesSeen: number}}
 */
export function intentBasis(value) {
  const basis = plain(value, 'intent.basis');
  const projectRevision = basis.projectRevision;
  const snapshotAgeMs = basis.snapshotAgeMs;
  const nodesSeen = basis.nodesSeen;
  if (!Number.isInteger(projectRevision) || projectRevision < 0) {
    throw new TypeError('intent.basis.projectRevision must be a non-negative integer');
  }
  if (!Number.isInteger(snapshotAgeMs) || snapshotAgeMs < 0 || snapshotAgeMs > MAX_SNAPSHOT_AGE_MS) {
    throw new TypeError(`intent.basis.snapshotAgeMs must be an integer between 0 and ${MAX_SNAPSHOT_AGE_MS}`);
  }
  if (!Number.isInteger(nodesSeen) || nodesSeen < 0 || nodesSeen > MAX_NODES_SEEN) {
    throw new TypeError(`intent.basis.nodesSeen must be an integer between 0 and ${MAX_NODES_SEEN}`);
  }
  return { projectRevision, snapshotAgeMs, nodesSeen };
}

/** Build a basis for Host-authored intents from one indexed read. */
export function basisFor(projectRevision, nodesSeen, snapshotAgeMs = 0) {
  return intentBasis({ projectRevision, nodesSeen, snapshotAgeMs });
}

/**
 * @param {object} input
 * @param {string} input.id
 * @param {string} input.kind one of INTENT_KINDS
 * @param {{kind: string, id: string}} input.actor
 * @param {object} input.claim non-empty judgement payload (action + reason/strategy)
 * @param {{projectRevision: number, snapshotAgeMs: number, nodesSeen: number}} input.basis what the decision read
 * @param {{nodeId?: string, parentId?: string}} [input.target]
 * @param {string} [input.rationale]
 * @param {number} [input.at]
 */
export function createIntent(input) {
  const id = str(input?.id, 'intent.id', 160);
  if (!id) throw new TypeError('intent.id is required');
  if (!INTENT_KINDS.includes(input?.kind)) throw new TypeError(`intent.kind must be one of ${INTENT_KINDS.join(', ')}`);
  const actor = input?.actor;
  if (!actor || typeof actor.id !== 'string' || !actor.id) throw new TypeError('intent.actor is required');
  const basis = intentBasis(input?.basis);
  const claim = plain(input?.claim, 'intent.claim');
  const action = str(claim.action, 'intent.claim.action', 80);
  if (!action) throw new TypeError('intent.claim.action is required');
  if (input.kind === 'appeal' && action !== 'appeal') {
    throw new TypeError('intent_action_mismatch: an intent with kind "appeal" must carry claim.action "appeal"');
  }
  if (Buffer.byteLength(JSON.stringify(claim), 'utf8') > MAX_CLAIM_BYTES) throw new TypeError('intent.claim is too large');
  const target = input?.target && typeof input.target === 'object'
    ? {
        ...(str(input.target.nodeId, 'intent.target.nodeId', MAX_TARGET) ? { nodeId: str(input.target.nodeId, 'intent.target.nodeId', MAX_TARGET) } : {}),
        ...(str(input.target.parentId, 'intent.target.parentId', MAX_TARGET) ? { parentId: str(input.target.parentId, 'intent.target.parentId', MAX_TARGET) } : {}),
        ...(str(input.target.intentId, 'intent.target.intentId', MAX_TARGET) ? { intentId: str(input.target.intentId, 'intent.target.intentId', MAX_TARGET) } : {}),
      }
    : null;
  return {
    id,
    kind: input.kind,
    status: 'pending',
    expiresAt: Number.isFinite(input?.expiresAt) ? input.expiresAt : (Number.isFinite(input?.at) ? input.at : Date.now()) + INTENT_TTL_MS,
    actor: { kind: typeof actor.kind === 'string' ? actor.kind : 'expert', id: actor.id },
    claim: structuredClone(claim),
    basis,
    target,
    rationale: str(input?.rationale, 'intent.rationale', MAX_RATIONALE),
    at: Number.isFinite(input?.at) ? input.at : Date.now(),
  };
}

/** Mutation that appends an intent to the project's bounded log. */
export function intentMutation(intent) {
  return { op: 'intent.put', intent };
}

/** A stable intent id from the revision and actor, bounded to the schema. */
export function intentId(prefix, revision, actorId, now = Date.now()) {
  const clean = String(actorId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'actor';
  return `intent-${prefix}-${revision}-${clean}-${now.toString(36)}`.slice(0, 160);
}
