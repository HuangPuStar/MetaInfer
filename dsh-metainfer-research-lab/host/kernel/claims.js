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
export const IRREVERSIBLE_ACTIONS = Object.freeze(['delete_project', 'cancel_running', 'prune_branch', 'apply_nomination']);

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

/** Minimum evidence for an irreversible action (C7: silence is not a clean record). */
export function gateClaimAction(action, stats = {}) {
  const total = Number.isInteger(stats.total) ? stats.total : 0;
  const rate = citationErrorRate(stats.failed ?? 0, total);
  const tier = citationTier(rate);
  const irreversible = IRREVERSIBLE_ACTIONS.includes(action);
  if (!irreversible) return { ok: true, action, tier, rate, total };
  if (total === 0) return { ok: false, action, tier, rate, total, code: 'claim_evidence_required' };
  if (rate >= 0.05) return { ok: false, action, tier, rate, total, code: 'citation_error_rate' };
  return { ok: true, action, tier, rate, total };
}
