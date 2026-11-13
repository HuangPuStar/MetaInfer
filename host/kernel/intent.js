/**
 * Judgement log (Stage 3). Every dispatch, priority and proposal decision writes
 * an intent carrying *what was claimed* and *which revision it was based on*.
 * The record is persisted by the kernel (`intent.put`), so it shares the event
 * log, revision and cause chain with the action it explains.
 *
 * Pure: no I/O, no ids from the store — callers supply a stable id.
 */
import { ActorKeyError, actorKeyOf, ensureActorKey, isIssuedActorKey, withActorKey } from './actors.js';
import { normalizeExpected } from './prediction.js';
export const INTENT_KINDS = Object.freeze(['dispatch', 'priority', 'proposal', 'review', 'curate', 'note', 'appeal', 'escalate']);

/**
 * B13: the only reasonCode values an `escalate` intent may carry. Kept in the
 * kernel because createIntent is the write boundary; the trigger evaluator
 * imports the same frozen list instead of inventing a second vocabulary.
 */
export const ESCALATION_REASON_CODES = Object.freeze([
  'conflict',
  'budget_shift',
  'new_direction',
  'branch_death',
  'low_confidence',
  'ledger_conflict',
]);

/**
 * C5: every semantic action needs an explicit executor or an explicit
 * escalation. Enumerating actions here prevents the old dead end where an
 * expert could submit an action that neither code nor any expert was allowed
 * to execute, and no route existed to a human decision.
 *
 * `host` actions are deterministic Host writes, `expert` actions are reviewed
 * by an expert, and `human` actions require the operator claim/appeal gate.
 * Unknown actions are deliberately *not* dropped: they carry a `human_review`
 * fallback so a semantic disagreement still reaches a decision-maker.
 */
export const INTENT_ACTIONS = Object.freeze([
  'observe', 'dispatch', 'set_priority', 'propose_node', 'review', 'curate', 'note', 'appeal', 'escalate',
  'create_planned', 'defer_planned', 'apply_nomination', 'cancel_running', 'prune_branch', 'delete_project',
]);

export const SEMANTIC_ACTION_FALLBACKS = Object.freeze({
  observe: Object.freeze({ executor: 'host', route: 'host:read', code: 'host_read' }),
  dispatch: Object.freeze({ executor: 'host', route: 'host:dispatchOnce', code: 'host_dispatch' }),
  set_priority: Object.freeze({ executor: 'host', route: 'host:setNodePriority', code: 'host_priority' }),
  propose_node: Object.freeze({ executor: 'expert', route: 'advisor:proposal', code: 'expert_proposal' }),
  review: Object.freeze({ executor: 'expert', route: 'curator:reviewClaims', code: 'expert_review' }),
  curate: Object.freeze({ executor: 'expert', route: 'curator:outcome', code: 'expert_curate' }),
  note: Object.freeze({ executor: 'host', route: 'host:intentLog', code: 'host_note' }),
  appeal: Object.freeze({ executor: 'human', route: 'human:dispute', code: 'human_appeal' }),
  escalate: Object.freeze({ executor: 'human', route: 'human:dispute', code: 'human_escalation' }),
  create_planned: Object.freeze({ executor: 'host', route: 'host:node.create', code: 'host_create' }),
  defer_planned: Object.freeze({ executor: 'host', route: 'host:setNodePriority', code: 'host_defer' }),
  apply_nomination: Object.freeze({ executor: 'expert', route: 'curator:applyNomination', code: 'expert_nominate' }),
  cancel_running: Object.freeze({ executor: 'human', route: 'human:claim_gate', code: 'human_cancel' }),
  prune_branch: Object.freeze({ executor: 'human', route: 'human:claim_gate', code: 'human_prune' }),
  delete_project: Object.freeze({ executor: 'human', route: 'human:claim_gate', code: 'human_delete' }),
});

/** @returns {{executor: string, route: string, code: string, action: string, reason?: string}} */
export function semanticFallback(action) {
  const name = typeof action === 'string' ? action : '';
  const known = SEMANTIC_ACTION_FALLBACKS[name];
  if (known) return { action: name, ...known };
  return {
    action: name || 'unknown',
    executor: 'human',
    route: 'human:operator_decision',
    code: 'human_review',
    reason: 'no host or expert executor is registered for this semantic action; escalate to the operator instead of silently dropping it',
  };
}

/**
 * Q12: the only matrix allowed to judge a pending intent. Two pending intents
 * that claim the same target from the same basis are a conflict; different
 * targets or an expired intent are not. The Host remains the single writer.
 */
export function detectIntentConflicts(intents, now = Date.now()) {
  const pending = (Array.isArray(intents) ? intents : []).filter((intent) => intent?.status === 'pending'
    && (!Number.isFinite(intent.expiresAt) || intent.expiresAt > now));
  const byTarget = new Map();
  const conflicts = [];
  for (const intent of pending) {
    const key = intent.target?.nodeId ?? intent.target?.parentId ?? intent.target?.projectId ?? null;
    if (!key) continue;
    const row = byTarget.get(key);
    if (!row) {
      byTarget.set(key, intent);
      continue;
    }
    conflicts.push({
      target: key,
      firstIntentId: row.id,
      secondIntentId: intent.id,
      reason: 'same_target_pending',
      firstActor: row.actor?.id ?? null,
      secondActor: intent.actor?.id ?? null,
    });
  }
  return {
    pending: pending.length,
    byKind: pending.reduce((out, intent) => ({ ...out, [intent.kind]: (out[intent.kind] ?? 0) + 1 }), {}),
    conflicts,
    writer: 'host',
  };
}

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
  const suppliedKey = actorKeyOf(actor);
  if (suppliedKey && !isIssuedActorKey(suppliedKey)) {
    throw new ActorKeyError('caller_supplied_actor_key', 'intent actorKey is not in the Host registry');
  }
  const actorKey = suppliedKey ?? ensureActorKey(actor);
  const basis = intentBasis(input?.basis);
  const claim = plain(input?.claim, 'intent.claim');
  const expected = normalizeExpected(input?.expected ?? claim.expected);
  const action = str(claim.action, 'intent.claim.action', 80);
  if (!action) throw new TypeError('intent.claim.action is required');
  const fallback = semanticFallback(action);
  if (input.kind === 'appeal' && action !== 'appeal') {
    throw new TypeError('intent_action_mismatch: an intent with kind "appeal" must carry claim.action "appeal"');
  }
  if (input.kind === 'escalate') {
    if (action !== 'escalate') {
      throw new TypeError('intent_action_mismatch: an intent with kind "escalate" must carry claim.action "escalate"');
    }
    const reasonCode = typeof claim.reasonCode === 'string' ? claim.reasonCode.trim() : '';
    if (!reasonCode) {
      throw new TypeError('escalation_reason_required: an escalate intent requires claim.reasonCode');
    }
    if (!ESCALATION_REASON_CODES.includes(reasonCode)) {
      throw new TypeError(`escalation_reason_invalid: reasonCode must be one of ${ESCALATION_REASON_CODES.join(', ')}`);
    }
  }
  if (Buffer.byteLength(JSON.stringify(claim), 'utf8') > MAX_CLAIM_BYTES) throw new TypeError('intent.claim is too large');
  const target = input?.target && typeof input.target === 'object'
    ? {
        ...(str(input.target.projectId, 'intent.target.projectId', MAX_TARGET) ? { projectId: str(input.target.projectId, 'intent.target.projectId', MAX_TARGET) } : {}),
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
    actor: withActorKey({ kind: typeof actor.kind === 'string' ? actor.kind : 'expert', id: actor.id, actorKey }),
    claim: structuredClone(claim),
    // C5: the executor/route is part of the record, so a reader never has to
    // guess whether an action is code-backed, expert-backed or human-only.
    fallback,
    basis,
    target,
    ...(expected ? { expected } : {}),
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
