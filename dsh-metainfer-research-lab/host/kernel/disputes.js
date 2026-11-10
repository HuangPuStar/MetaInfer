/**
 * Stage 5 dispute primitive (B22 / Q13).
 *
 * A dispute is a first-class record, not a free-form appeal note. The eight
 * conflict classes map deterministically to an authority; only two classes may
 * ask a model (curator or arbiter) at all. Every record carries a deadline and
 * the default action is always `keep_current`, so an ignored dispute cannot
 * silently change the DAG.
 *
 * Pure module: ids and timestamps are supplied by the caller. Actor keys are
 * preserved on the record for identity comparison but stripped by `publicView`
 * on every read surface.
 */
import { actorKeyOf, sameActor } from './actors.js';
export const DISPUTE_TIMEOUT_MS = 24 * 60 * 60_000;
export const DISPUTE_DEFAULT_ACTION = 'keep_current';
export const DISPUTE_RESOLUTIONS = Object.freeze(['keep_current', 'apply_change', 'upheld', 'rejected']);
export const DISPUTE_STATUSES = Object.freeze(['pending', 'resolved', 'withdrawn', 'expired']);
export const DISPUTE_REASON_CODES = Object.freeze([
  'stale_basis',
  'fact_conflict',
  'resource_quantity',
  'resource_quality',
  'value_priority',
  'priority_inversion',
  'duplicate_claim',
  'scope_overlap',
]);

/**
 * The eight conflict classes from Q13-4. `authority` is the actor class that
 * decides; `needsModel` is true for exactly the two semantic classes.
 */
export const DISPUTE_CLASS_MAP = Object.freeze({
  stale_basis: Object.freeze({
    authority: 'code', needsModel: false, requiredReasonCode: false,
    description: 'two judgements saw different project revisions',
  }),
  fact_conflict: Object.freeze({
    authority: 'code', needsModel: false, requiredReasonCode: false,
    description: 'factual claims disagree; the ledger is the source of truth',
  }),
  resource_quantity: Object.freeze({
    authority: 'cfs', needsModel: false, requiredReasonCode: false,
    description: 'both positions fit the resource arithmetic differently',
  }),
  resource_quality: Object.freeze({
    authority: 'arbiter', needsModel: false, requiredReasonCode: false,
    description: 'the resource shape differs, not just the amount',
  }),
  value_priority: Object.freeze({
    authority: 'arbiter', needsModel: true, requiredReasonCode: false,
    description: 'semantic disagreement about which direction is worth more',
  }),
  priority_inversion: Object.freeze({
    authority: 'human', needsModel: false, requiredReasonCode: true,
    description: 'a lower-priority node is holding a slot a human asked for',
  }),
  duplicate_claim: Object.freeze({
    authority: 'curator', needsModel: true, requiredReasonCode: false,
    description: 'two nodes claim to be the same experiment',
  }),
  scope_overlap: Object.freeze({
    authority: 'arbiter', needsModel: false, requiredReasonCode: false,
    description: 'two actors claim the same write scope',
  }),
});

/** Resolve a type name to its immutable mapping row, or throw a typed error. */
export function disputeClassOf(type) {
  const row = DISPUTE_CLASS_MAP[type];
  if (!row) {
    const error = new TypeError(`unknown dispute type: ${String(type)}; expected one of ${DISPUTE_REASON_CODES.join(', ')}`);
    error.code = 'invalid_dispute_type';
    throw error;
  }
  return { type, ...row };
}

function boundedString(value, field, max) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw new TypeError(`${field} exceeds ${max} characters`);
  return trimmed;
}

/** Evidence pointers are the only accepted proof; no prose-only disputes. */
export function normalizeDisputeEvidence(evidence) {
  if (evidence === undefined || evidence === null) return [];
  if (!Array.isArray(evidence)) throw new TypeError('dispute.evidence must be an array');
  return evidence.slice(0, 20).map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new TypeError('dispute.evidence[] must be an object');
    const nodeId = boundedString(row.nodeId, 'dispute.evidence.nodeId', 160);
    const field = boundedString(row.field, 'dispute.evidence.field', 80);
    const quote = boundedString(row.quote, 'dispute.evidence.quote', 500);
    if (!nodeId || !field) throw new TypeError('dispute.evidence requires nodeId and field');
    return { nodeId, field, ...(quote ? { quote } : {}) };
  });
}

/**
 * @param {object} input
 * @param {string} input.id
 * @param {string} input.projectId
 * @param {string} input.type one of DISPUTE_REASON_CODES
 * @param {{kind: string, id: string}} input.raiser
 * @param {object} [input.target]
 * @param {string} [input.reasonCode]
 * @param {string} [input.rationale]
 * @param {Array<object>} [input.evidence]
 * @param {number} [input.at]
 * @param {number} [input.deadlineAt]
 * @param {object} [input.position]
 */
export function createDisputeRecord(input) {
  const id = boundedString(input?.id, 'dispute.id', 160);
  if (!id) throw new TypeError('dispute.id is required');
  const projectId = boundedString(input?.projectId, 'dispute.projectId', 160);
  if (!projectId) throw new TypeError('dispute.projectId is required');
  const mapping = disputeClassOf(input?.type);
  const raiser = input?.raiser;
  if (!raiser || typeof raiser.id !== 'string' || !raiser.id) throw new TypeError('dispute.raiser is required');
  const reasonCode = boundedString(input?.reasonCode, 'dispute.reasonCode', 80);
  if (mapping.requiredReasonCode && !reasonCode) {
    throw new TypeError(`dispute type ${mapping.type} requires reasonCode`);
  }
  const at = Number.isFinite(input?.at) ? input.at : Date.now();
  const deadlineAt = Number.isFinite(input?.deadlineAt) ? input.deadlineAt : at + DISPUTE_TIMEOUT_MS;
  if (deadlineAt <= at) throw new TypeError('dispute.deadlineAt must be after dispute.at');
  return {
    id,
    projectId,
    type: mapping.type,
    status: 'pending',
    authority: mapping.authority,
    needsModel: mapping.needsModel,
    defaultAction: DISPUTE_DEFAULT_ACTION,
    deadlineAt,
    raiser: {
      kind: typeof raiser.kind === 'string' ? raiser.kind : 'expert',
      id: raiser.id,
      ...(typeof raiser.actorKey === 'string' && raiser.actorKey ? { actorKey: raiser.actorKey } : {}),
    },
    target: input?.target && typeof input.target === 'object' ? structuredClone(input.target) : null,
    position: input?.position && typeof input.position === 'object' ? structuredClone(input.position) : null,
    reasonCode,
    rationale: boundedString(input?.rationale, 'dispute.rationale', 2_000),
    evidence: normalizeDisputeEvidence(input?.evidence),
    at,
    resolvedAt: null,
    resolvedBy: null,
    resolution: null,
    resolutionReason: null,
    defaultApplied: false,
    reopenedBy: null,
  };
}

/** A timeout is not an exception: it applies the recorded default. */
export function expireDisputeRecord(record, now = Date.now()) {
  if (record.status !== 'pending' || !Number.isFinite(record.deadlineAt) || record.deadlineAt > now) return record;
  return {
    ...record,
    status: 'resolved',
    resolution: DISPUTE_DEFAULT_ACTION,
    resolutionReason: 'timeout_default',
    resolvedAt: now,
    resolvedBy: { kind: 'system', id: 'dispute-timeout' },
    defaultApplied: true,
  };
}

/** Effective view: pending records past their deadline read as the default. */
export function effectiveDispute(record, now = Date.now()) {
  return expireDisputeRecord(record, now);
}

/**
 * Resolve a record. `resolved` is terminal; a second resolution is refused by
 * the service/mutation layer. `apply_change` is the only non-default action.
 */
export function resolveDisputeRecord(record, input, now = Date.now()) {
  if (!record || typeof record !== 'object') throw new TypeError('dispute record is required');
  if (record.status === 'resolved') throw new TypeError(`dispute ${record.id} is already resolved`);
  if (record.status === 'withdrawn') throw new TypeError(`dispute ${record.id} is withdrawn`);
  const resolution = input?.resolution;
  if (!DISPUTE_RESOLUTIONS.includes(resolution)) {
    throw new TypeError(`dispute.resolution must be one of ${DISPUTE_RESOLUTIONS.join(', ')}`);
  }
  const resolver = input?.resolvedBy;
  if (!resolver || typeof resolver.id !== 'string' || !resolver.id) throw new TypeError('dispute.resolvedBy is required');
  // Identity is the opaque Host key when both rows have one; display ids are
  // only a legacy fallback. Mixing a keyed and an unkeyed actor fails closed.
  const raiserKey = actorKeyOf(record.raiser);
  const resolverKey = actorKeyOf(resolver);
  if (Boolean(raiserKey) !== Boolean(resolverKey)) {
    throw new TypeError('dispute_self_resolution: raiser and resolver identities are not comparable');
  }
  if (raiserKey && resolverKey) {
    if (sameActor(record.raiser, resolver)) throw Object.assign(new TypeError('dispute_self_resolution: the raiser cannot resolve their own dispute'), { code: 'dispute_self_resolution' });
  } else if (record.raiser?.id === resolver.id && record.raiser?.kind === resolver.kind) {
    throw Object.assign(new TypeError('dispute_self_resolution: the raiser cannot resolve their own dispute'), { code: 'dispute_self_resolution' });
  }
  const reason = boundedString(input?.reason, 'dispute.resolutionReason', 500);
  if (resolution !== DISPUTE_DEFAULT_ACTION && !reason) throw new TypeError('dispute resolution requires a reason');
  return {
    ...record,
    status: 'resolved',
    resolution,
    resolutionReason: reason ?? 'resolved',
    resolvedAt: now,
    resolvedBy: {
      kind: typeof resolver.kind === 'string' ? resolver.kind : 'human',
      id: resolver.id,
      ...(resolverKey ? { actorKey: resolverKey } : {}),
    },
    defaultApplied: false,
  };
}

/** Re-open only with evidence that was not on the original record. */
export function reopenDisputeRecord(record, input, now = Date.now()) {
  if (!record || record.status !== 'resolved') throw new TypeError('only a resolved dispute can be re-opened');
  const evidence = normalizeDisputeEvidence(input?.evidence);
  if (evidence.length === 0) throw Object.assign(new TypeError('dispute_reopen_requires_new_evidence'), { code: 'dispute_reopen_requires_new_evidence' });
  const old = new Set((record.evidence ?? []).map((row) => `${row.nodeId}\u0000${row.field}\u0000${row.quote ?? ''}`));
  const fresh = evidence.filter((row) => !old.has(`${row.nodeId}\u0000${row.field}\u0000${row.quote ?? ''}`));
  if (fresh.length === 0) throw Object.assign(new TypeError('dispute_reopen_requires_new_evidence'), { code: 'dispute_reopen_requires_new_evidence' });
  return {
    ...record,
    status: 'pending',
    resolution: null,
    resolutionReason: null,
    resolvedAt: null,
    resolvedBy: null,
    defaultApplied: false,
    deadlineAt: now + DISPUTE_TIMEOUT_MS,
    reopenedBy: {
      kind: typeof input?.by?.kind === 'string' ? input.by.kind : 'human',
      id: input?.by?.id ?? 'operator',
      ...(actorKeyOf(input?.by) ? { actorKey: actorKeyOf(input.by) } : {}),
    },
    evidence: [...(record.evidence ?? []), ...fresh],
  };
}
