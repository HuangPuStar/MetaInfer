/**
 * Atomic claim verification (B24/B27, Q14).
 *
 * A claim is a list of deterministic predicates over the project snapshot. The
 * Host verifies every atom before the intent is written, so a model that cites
 * a node that does not exist is corrected at submission time instead of being
 * trusted and audited later.
 *
 * Pure: the caller supplies the nodes; no store, clock or model is involved.
 */

export const CLAIM_PREDICATES = Object.freeze([
  'nodeExists',
  'statusIs',
  'parentOf',
  'metricIs',
  'textContains',
  'countWhere',
  'reviewedBy',
]);

/** Actions whose effect cannot be undone; they require a clean citation record. */
export const IRREVERSIBLE_ACTIONS = Object.freeze(['delete_project', 'cancel_running', 'prune_branch']);

/**
 * B27: five verification strengths. `evidence` is the number of *fresh, verified
 * atoms in this submission*; the statistical floor below is computed over the
 * actor's whole verified history. Levels 2 and 3 cannot be self-confirmed by an
 * expert: `chiefConfirmed` is accepted only from a human or the chief preset by
 * `submitIntent`.
 */
export const VERIFICATION_LEVELS = Object.freeze([
  { level: 0, name: 'planned_create', evidence: 0, description: 'parent exists and is not deferred' },
  { level: 1, name: 'defer_nominate', evidence: 1, description: 'one verified atom' },
  { level: 2, name: 'cancel_running', evidence: 2, chief: true, description: 'two verified atoms + chief confirmation' },
  { level: 3, name: 'prune_branch', evidence: 3, chief: true, appeal: true, description: 'three verified atoms + chief confirmation + appeal window' },
  { level: 4, name: 'delete_project', humanOnly: true, humanConfirmation: true, appeal: true, description: 'human operator only, with explicit confirmation and an appeal window' },
]);

export const ACTION_VERIFICATION = Object.freeze({
  create_planned: VERIFICATION_LEVELS[0],
  defer_planned: VERIFICATION_LEVELS[1],
  apply_nomination: VERIFICATION_LEVELS[1],
  cancel_running: VERIFICATION_LEVELS[2],
  prune_branch: VERIFICATION_LEVELS[3],
  delete_project: VERIFICATION_LEVELS[4],
});

/** C7: a handful of clean claims is not a citation record. */
export const MIN_CITATION_EVIDENCE = 20;
/** C7: Wilson lower bound on the clean-citation rate (95% one-sided z=1.96). */
export const MIN_CITATION_LOWER_BOUND = 0.80;
export const WILSON_Z = 1.96;

const MAX_EVIDENCE = 200;

function asMap(nodes) {
  const map = new Map();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node && typeof node.id === 'string') map.set(node.id, node);
  }
  return map;
}

function fail(predicate, reason, claim = null) {
  return { ok: false, predicate, reason, claim };
}

function invalid(predicate, reason, claim) {
  return fail(predicate, `invalid_claim:${reason}`, claim);
}

function findMetric(node, name) {
  const metrics = node?.report?.metrics ?? node?.metrics;
  if (Array.isArray(metrics)) {
    const hit = metrics.find((row) => row && (row.name === name || row.metric === name || row.key === name));
    return hit ? (hit.value ?? hit.target ?? hit.actual) : undefined;
  }
  if (metrics && typeof metrics === 'object') return metrics[name];
  return undefined;
}

function fieldValue(node, field) {
  const parts = String(field).split('.');
  let value = node;
  for (const part of parts) {
    if (value === undefined || value === null) return undefined;
    value = value[part];
  }
  return value;
}

function reviewedBy(node, reviewer) {
  const review = node?.review;
  if (review && (review.by === reviewer || review.reviewer === reviewer)) return true;
  return (Array.isArray(node?.reviews) ? node.reviews : []).some((row) => (
    row === reviewer || row?.by === reviewer || row?.reviewer === reviewer
  ));
}

/**
 * Verify one atom.
 *
 * @param {object} claim
 * @param {Map<string, object>|Array<object>} nodes
 * @returns {{ok: boolean, predicate: string, reason: string, claim: object|null}}
 */
export function verifyClaim(claim, nodes) {
  const map = nodes instanceof Map ? nodes : asMap(nodes);
  const predicate = claim?.predicate;
  if (typeof predicate !== 'string' || !CLAIM_PREDICATES.includes(predicate)) {
    return fail(String(predicate ?? 'unknown'), 'unknown_predicate', claim ?? null);
  }
  const nodeId = claim.nodeId;
  const node = typeof nodeId === 'string' ? map.get(nodeId) : undefined;
  if (predicate !== 'countWhere' && predicate !== 'parentOf' && !node) {
    return fail(predicate, 'node_missing', claim);
  }
  switch (predicate) {
    case 'nodeExists':
      return { ok: true, predicate, reason: 'ok', claim };
    case 'statusIs':
      if (typeof claim.status !== 'string') return invalid(predicate, 'status_required', claim);
      return node.status === claim.status
        ? { ok: true, predicate, reason: 'ok', claim }
        : fail(predicate, `status_is_${node.status ?? 'unknown'}`, claim);
    case 'parentOf': {
      if (typeof claim.parentId !== 'string' || typeof nodeId !== 'string') return invalid(predicate, 'parent_and_child_required', claim);
      const parentIds = Array.isArray(node?.parentIds) ? node.parentIds : (node?.parentId ? [node.parentId] : []);
      return parentIds.includes(claim.parentId)
        ? { ok: true, predicate, reason: 'ok', claim }
        : fail(predicate, 'not_a_parent', claim);
    }
    case 'metricIs': {
      if (typeof claim.metric !== 'string' || claim.value === undefined) return invalid(predicate, 'metric_and_value_required', claim);
      const actual = findMetric(node, claim.metric);
      const expected = claim.value;
      const match = typeof actual === 'number' && typeof expected === 'number' ? Object.is(actual, expected) : actual === expected;
      return match ? { ok: true, predicate, reason: 'ok', claim } : fail(predicate, 'metric_mismatch', claim);
    }
    case 'textContains': {
      if (typeof claim.text !== 'string' || claim.text.length === 0) return invalid(predicate, 'text_required', claim);
      const field = typeof claim.field === 'string' ? claim.field : 'title';
      const value = fieldValue(node, field);
      return typeof value === 'string' && value.includes(claim.text)
        ? { ok: true, predicate, reason: 'ok', claim }
        : fail(predicate, 'text_not_found', claim);
    }
    case 'countWhere': {
      if (!Number.isInteger(claim.count) || claim.count < 0) return invalid(predicate, 'count_required', claim);
      const rows = [...map.values()];
      const actual = typeof claim.status === 'string' ? rows.filter((row) => row.status === claim.status).length : rows.length;
      return actual === claim.count ? { ok: true, predicate, reason: 'ok', claim } : fail(predicate, `count_is_${actual}`, claim);
    }
    case 'reviewedBy': {
      if (typeof claim.reviewer !== 'string' || claim.reviewer.length === 0) return invalid(predicate, 'reviewer_required', claim);
      return reviewedBy(node, claim.reviewer) ? { ok: true, predicate, reason: 'ok', claim } : fail(predicate, 'review_missing', claim);
    }
    default:
      return fail(predicate, 'unknown_predicate', claim);
  }
}

/** Verify a claim set. `rate` is failures / atoms, not failures / submissions. */
export function verifyClaims(claims, nodes) {
  if (!Array.isArray(claims)) {
    return { ok: false, total: 0, failed: 0, rate: 0, tier: 'full', results: [], failures: [], code: 'evidence_required' };
  }
  if (claims.length > MAX_EVIDENCE) {
    return { ok: false, total: claims.length, failed: claims.length, rate: 1, tier: 'nominate', results: [], failures: [], code: 'evidence_too_large' };
  }
  const map = nodes instanceof Map ? nodes : asMap(nodes);
  const results = claims.map((claim) => verifyClaim(claim, map));
  const failures = results.filter((row) => !row.ok);
  const total = results.length;
  const failed = failures.length;
  const rate = citationErrorRate(failed, total);
  return {
    ok: failed === 0,
    total,
    failed,
    rate,
    tier: citationTier(rate),
    results,
    failures,
  };
}

/** `citationErrorRate` with the empty denominator treated as a clean record. */
export function citationErrorRate(failed, total) {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(1, Math.max(0, failed / total));
}

/**
 * Permission trial tiers:
 *   < 5%  full      — may propose irreversible actions
 *   5–15% review    — may propose, but no irreversible action
 *   > 15% nominate  — may only nominate for a human/curator
 */
export function citationTier(rate) {
  const value = Number.isFinite(rate) ? rate : 1;
  if (value < 0.05) return 'full';
  if (value <= 0.15) return 'review';
  return 'nominate';
}

/**
 * Wilson score interval lower bound for a binomial success rate. C7 uses the
 * clean-citation rate (success = verified atom); with `successes = total` this
 * grows only as the history grows, so a single clean atom cannot buy a full
 * permission tier. `z=1.96` is a 95% one-sided bound.
 */
export function wilsonLowerBound(successes, total, z = WILSON_Z) {
  const n = Number.isFinite(total) ? Math.max(0, total) : 0;
  if (n === 0) return 0;
  const s = Math.min(n, Math.max(0, Number.isFinite(successes) ? successes : 0));
  const p = s / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, Math.min(1, (centre - margin) / denominator));
}

/**
 * Verify permission to perform `action`.
 *
 * B27 checks this submission's evidence count, chief confirmation and appeal
 * window. C7 then checks the actor's whole citation history: at least
 * `MIN_CITATION_EVIDENCE` atoms and a Wilson lower bound of at least
 * `MIN_CITATION_LOWER_BOUND`. Keeping both in this one function is deliberate:
 * a caller cannot satisfy the action count and forget the statistical floor.
 *
 * `context.submitted` (alias `context.evidence`) is the number of fresh verified
 * atoms in this submission; it defaults to `stats.total` for direct callers.
 */
export function gateClaimAction(action, stats = {}, context = {}) {
  const total = Number.isInteger(stats.total) ? stats.total : 0;
  const failed = Number.isInteger(stats.failed) ? stats.failed : 0;
  const rate = citationErrorRate(failed, total);
  const tier = citationTier(rate);
  const requirement = ACTION_VERIFICATION[action];
  if (!requirement) return { ok: true, action, tier, rate, total };
  const submitted = Number.isInteger(context.submitted)
    ? context.submitted
    : Number.isInteger(context.evidence) ? context.evidence : total;
  const base = {
    ok: false,
    action,
    tier,
    rate,
    total,
    level: requirement.level,
    requiredEvidence: requirement.evidence ?? 0,
    submitted,
  };
  const actor = context.actor ?? null;
  if (requirement.humanOnly && actor?.kind !== 'human') {
    return { ...base, code: 'human_only' };
  }
  if (requirement.humanConfirmation && context.humanConfirmed !== true) {
    return { ...base, code: 'human_confirmation_required' };
  }
  if (submitted < (requirement.evidence ?? 0)) {
    return { ...base, code: 'claim_evidence_required' };
  }
  if (requirement.chief && context.chiefConfirmed !== true) {
    return { ...base, code: 'chief_confirmation_required' };
  }
  // L0/L1 are planning and nomination: they are deliberately outside C7. A new
  // expert with no citation history must still be able to propose (B27 L0) and
  // defer one atom (L1); the 20-atom statistical floor begins at the first
  // irreversible action (L2).
  if (requirement.level < 2) {
    return { ...base, ok: true, lowerBound: null, requiredEvidence: requirement.evidence ?? 0 };
  }
  if (requirement.appeal) {
    const now = Number.isFinite(context.now) ? context.now : Date.now();
    // A live, registered appeal blocks the action even when the numeric window
    // is still open. `appealUntil` alone is a timestamp, not a mechanism.
    if (context.appealPending === true) return { ...base, code: 'appeal_pending' };
    const appealUntil = Number.isFinite(context.appealUntil) ? context.appealUntil : 0;
    if (appealUntil <= now) return { ...base, code: 'appeal_window_required' };
  }
  if (total < MIN_CITATION_EVIDENCE) {
    return { ...base, code: 'citation_evidence_floor', minimumEvidence: MIN_CITATION_EVIDENCE };
  }
  const lowerBound = wilsonLowerBound(total - failed, total);
  if (lowerBound < MIN_CITATION_LOWER_BOUND) {
    return { ...base, code: 'citation_confidence_too_low', lowerBound, minimumLowerBound: MIN_CITATION_LOWER_BOUND };
  }
  if (rate >= 0.05) return { ...base, code: 'citation_error_rate' };
  return {
    ...base,
    ok: true,
    lowerBound,
    requiredEvidence: requirement.evidence ?? 0,
  };
}
