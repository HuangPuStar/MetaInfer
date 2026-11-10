/**
 * Judgement log (Stage 3). Every dispatch, priority and proposal decision writes
 * an intent carrying *what was claimed* and *which revision it was based on*.
 * The record is persisted by the kernel (`intent.put`), so it shares the event
 * log, revision and cause chain with the action it explains.
 *
 * Pure: no I/O, no ids from the store — callers supply a stable id.
 */
export const INTENT_KINDS = Object.freeze(['dispatch', 'priority', 'proposal', 'review', 'curate', 'note']);

const MAX_TARGET = 160;
const MAX_RATIONALE = 2_000;
const MAX_CLAIM_BYTES = 4_096;
export const INTENT_TTL_MS = 30 * 60_000;

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
 * @param {object} input
 * @param {string} input.id
 * @param {string} input.kind one of INTENT_KINDS
 * @param {{kind: string, id: string}} input.actor
 * @param {object} input.claim non-empty judgement payload (action + reason/strategy)
 * @param {number} input.basis project revision the decision read
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
  if (!Number.isInteger(input?.basis) || input.basis < 0) throw new TypeError('intent.basis must be a non-negative integer revision');
  const claim = plain(input?.claim, 'intent.claim');
  const action = str(claim.action, 'intent.claim.action', 80);
  if (!action) throw new TypeError('intent.claim.action is required');
  if (Buffer.byteLength(JSON.stringify(claim), 'utf8') > MAX_CLAIM_BYTES) throw new TypeError('intent.claim is too large');
  const target = input?.target && typeof input.target === 'object'
    ? {
        ...(str(input.target.nodeId, 'intent.target.nodeId', MAX_TARGET) ? { nodeId: str(input.target.nodeId, 'intent.target.nodeId', MAX_TARGET) } : {}),
        ...(str(input.target.parentId, 'intent.target.parentId', MAX_TARGET) ? { parentId: str(input.target.parentId, 'intent.target.parentId', MAX_TARGET) } : {}),
      }
    : null;
  return {
    id,
    kind: input.kind,
    status: 'pending',
    expiresAt: Number.isFinite(input?.expiresAt) ? input.expiresAt : (Number.isFinite(input?.at) ? input.at : Date.now()) + INTENT_TTL_MS,
    actor: { kind: typeof actor.kind === 'string' ? actor.kind : 'expert', id: actor.id },
    claim: structuredClone(claim),
    basis: input.basis,
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
