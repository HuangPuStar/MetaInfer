/**
 * One high-review decision, one audit record.
 *
 * The event, `node.highReview`, and `node.cancelReason` are derived from the
 * same normalized object so a withdrawal cannot have a reason in one surface
 * and an empty string in another. Provenance is explicit:
 *
 *   human:<sessionId>    a session registered as human
 *   expert:<expertId>    the chief (or another expert) resolving a window
 *   system:<policyName>  an automatic Host policy, never a human by omission
 */
const MAX_REASON = 1200;
const MAX_RATIONALE = 2000;

function trimmed(value, max) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function actorDisplayId(actor) {
  if (!actor || typeof actor !== 'object') return 'unknown';
  return trimmed(actor.preset, 120) ?? trimmed(actor.id, 200) ?? trimmed(actor.kind, 40) ?? 'unknown';
}

/** Canonical provenance label used by events, node records and explain_node. */
export function resolvedByRef(actor = {}, policyName = null) {
  const kind = trimmed(actor?.kind, 40) ?? 'system';
  const id = trimmed(actor?.id, 200) ?? 'unknown';
  if (kind === 'human') return `human:${id}`;
  if (kind === 'expert' || kind === 'chief') return `expert:${actorDisplayId(actor)}`;
  if (kind === 'system' || kind === 'dispatcher' || kind === 'mcp') {
    return `system:${trimmed(policyName, 120) ?? trimmed(actor?.preset, 120) ?? id}`;
  }
  // Never let an unknown/legacy actor fall through to "human" just because the
  // session had no agent preset. An unattributed automation is still a system
  // decision for audit purposes.
  return `system:${kind}:${id}`;
}

function ruleOf(input = {}, actor = {}, action = '') {
  const rawSource = input.rule ?? input.policy;
  const raw = rawSource && typeof rawSource === 'object' ? rawSource : null;
  const name = trimmed(raw?.name, 120)
    ?? trimmed(input.ruleName, 120)
    ?? trimmed(input.policyName, 120)
    ?? (typeof input.rule === 'string' ? trimmed(input.rule, 120) : null)
    ?? (typeof input.policy === 'string' ? trimmed(input.policy, 120) : null)
    ?? trimmed(input.policy?.name, 120)
    ?? (actor?.kind === 'system' ? (trimmed(actor.preset, 120) ?? trimmed(actor.id, 120)) : null);
  if (!name) return null;
  return {
    name,
    whyWithdraw: action === 'withdraw'
      ? (trimmed(raw?.whyWithdraw, MAX_RATIONALE)
        ?? trimmed(raw?.reason, MAX_RATIONALE)
        ?? trimmed(input.whyWithdraw, MAX_RATIONALE)
        ?? trimmed(input.ruleReason, MAX_RATIONALE)
        ?? trimmed(input.rationale, MAX_RATIONALE)
        ?? 'the policy selected withdraw because the node must not continue')
      : null,
    whyNotDefer: action === 'withdraw'
      ? (trimmed(raw?.whyNotDefer, MAX_RATIONALE)
        ?? trimmed(input.whyNotDefer, MAX_RATIONALE)
        ?? 'withdraw removes the node from the runnable DAG; defer would only lower its priority and leave it eligible to run')
      : null,
  };
}

/**
 * @param {object} input
 * @param {'defer'|'withdraw'|'keep'} input.action
 * @param {string|null} [input.reasonCode]
 * @param {string|null} [input.rationale]
 * @param {object} input.actor
 * @param {object|string|null} [input.rule]
 * @param {string|null} [input.ruleName]
 * @param {string|null} [input.whyNotDefer]
 * @param {number} [input.at]
 */
export function highReviewResolution(input = {}) {
  const action = input.action;
  const actor = input.actor ?? {};
  const at = Number.isFinite(input.at) ? input.at : Date.now();
  const reasonCode = trimmed(input.reasonCode, 160) ?? `high_review_${action}`;
  const rule = ruleOf(input, actor, action);
  const resolvedBy = resolvedByRef(actor, rule?.name ?? null);
  const rationale = trimmed(input.rationale, MAX_RATIONALE)
    ?? trimmed(input.reason, MAX_RATIONALE)
    ?? (action === 'withdraw'
      ? (rule ? `withdraw selected by policy ${rule.name}` : 'withdraw selected by the high-review resolver')
      : `high-review ${action} selected`);
  const resolvedByActor = {
    kind: trimmed(actor.kind, 40) ?? 'system',
    id: trimmed(actor.id, 200) ?? 'unknown',
    ...(trimmed(actor.preset, 120) ? { preset: trimmed(actor.preset, 120) } : {}),
  };
  const cancelReason = action !== 'withdraw' ? null : {
    decision: action,
    reasonCode,
    rationale,
    resolvedBy,
    resolvedByActor,
    ...(rule ? { rule } : {}),
    source: 'high_review',
    at,
  };
  return {
    decision: action,
    reasonCode,
    rationale,
    resolvedBy,
    resolvedByActor,
    rule,
    at,
    cancelReason,
    cancelReasonText: cancelReason ? formatCancelReason(cancelReason) : null,
  };
}

const PLACEHOLDER_RATIONALE = /\b(?:placeholder|probe|test|todo|tbd|dummy|lorem ipsum|n\/a)\b/i;

/**
 * Human high-review decisions need an explicit, real rationale. The provenance
 * resolver otherwise fills in a generic sentence, which made a probe decision
 * look like a deliberate human audit record. Automated high-review decisions
 * must use `system:<policy>` (or an expert/chief actor); they are exempt.
 *
 * @param {object} input
 * @param {object} actor
 * @returns {{code: string, message: string, resolvedBy: string}|null}
 */
export function validateHighReviewRationale(input = {}, actor = {}) {
  const resolvedBy = resolvedByRef(actor, null);
  if (!resolvedBy.startsWith('human:')) return null;
  const rationale = typeof input?.rationale === 'string' ? input.rationale.trim() : '';
  const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
  const text = rationale || reason;
  if (text && !PLACEHOLDER_RATIONALE.test(text)) return null;
  return {
    code: 'rationale_required',
    resolvedBy,
    message: text
      ? 'human high-review decisions require a non-placeholder rationale; automated or test decisions must use a system:<policy> actor'
      : 'human high-review decisions require a non-empty rationale; automated or test decisions must use a system:<policy> actor',
  };
}

/** A compact string for tool output/UI; the object remains authoritative. */
export function formatCancelReason(reason) {
  if (!reason || typeof reason !== 'object') return typeof reason === 'string' ? reason : '';
  const bits = [`high-review ${reason.decision ?? 'cancel'}`, `by=${reason.resolvedBy ?? 'unknown'}`, `reason=${reason.reasonCode ?? 'unknown'}`];
  if (reason.rule?.name) bits.push(`rule=${reason.rule.name}`);
  if (reason.rationale) bits.push(String(reason.rationale).slice(0, 300));
  return bits.join('; ');
}
