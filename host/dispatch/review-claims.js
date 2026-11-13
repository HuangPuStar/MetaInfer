/**
 * Review claims: a short lease that says "an expert is reviewing this node".
 *
 * The design point (QA Q9 ③): overlapping *reads* are fine, overlapping *work*
 * is not. Before an expert proposes a successor for a parent it claims that
 * parent; a second expert sees the claim and either waits or picks another
 * leaf. This is the mechanism that prevents two concurrent proposals on one
 * parent, and it is deliberately separate from the dispatch claim
 * (`node.claim`), which is the commit point for starting work.
 *
 * Claims are in-memory leases with a TTL: they are liveness state, not durable
 * truth. The durable record is the `review/claimed` / `review/released` event
 * the caller writes through the executor (see IntentLog).
 *
 * Pure data structure; clock and id factory injected.
 */
import { randomUUID } from 'node:crypto';

const DEFAULT_TTL_MS = 180_000;
const DEFAULT_MAX_CLAIMS = 512;
const MAX_TITLE = 160;

function keyOf(projectId, nodeId) {
  return `${projectId}::${nodeId}`;
}

/**
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {number} [deps.ttlMs]
 * @param {number} [deps.maxClaims]
 * @param {(event: object) => void} [deps.onEvent] observability hook
 * @param {() => string} [deps.idFactory]
 */
export function createReviewClaimBoard({
  clock = Date.now,
  ttlMs = DEFAULT_TTL_MS,
  maxClaims = DEFAULT_MAX_CLAIMS,
  onEvent = () => {},
  idFactory = () => `rcl-${randomUUID().slice(0, 8)}`,
} = {}) {
  const claims = new Map();

  function sweep(now = clock()) {
    let expired = 0;
    for (const [key, claim] of claims) {
      if (claim.expiresAt <= now) {
        claims.delete(key);
        expired += 1;
        onEvent({ type: 'review/expired', claim });
      }
    }
    return expired;
  }

  /**
   * @param {object} input
   * @param {string} input.projectId
   * @param {string} input.nodeId
   * @param {string} input.expertId
   * @param {string} [input.intent] `propose` | `review` | `curate`
   * @param {string} [input.title]
   * @param {number} [input.ttlMs]
   * @returns {{ok: true, claim: object, refreshed?: boolean}
   *   | {ok: false, code: string, holder?: object, message: string}}
   */
  function claim(input) {
    const now = clock();
    sweep(now);
    const projectId = String(input?.projectId ?? '');
    const nodeId = String(input?.nodeId ?? '');
    const expertId = String(input?.expertId ?? '');
    if (!projectId || !nodeId || !expertId) {
      return { ok: false, code: 'invalid_claim', message: 'projectId, nodeId and expertId are required' };
    }
    const ttl = Number.isFinite(input?.ttlMs) && input.ttlMs > 0 ? input.ttlMs : ttlMs;
    const key = keyOf(projectId, nodeId);
    const existing = claims.get(key);
    if (existing) {
      if (existing.expertId === expertId) {
        existing.expiresAt = now + ttl;
        existing.title = String(input?.title ?? existing.title ?? '').slice(0, MAX_TITLE);
        onEvent({ type: 'review/refreshed', claim: { ...existing } });
        return { ok: true, claim: { ...existing }, refreshed: true };
      }
      return {
        ok: false,
        code: 'review_claimed',
        holder: { expertId: existing.expertId, intent: existing.intent, expiresAt: existing.expiresAt, title: existing.title },
        message: `node ${nodeId} is already under review by ${existing.expertId}`,
      };
    }
    if (claims.size >= maxClaims) {
      return { ok: false, code: 'claim_board_full', message: `too many active review claims (${claims.size})` };
    }
    const record = {
      id: idFactory(),
      projectId,
      nodeId,
      expertId,
      intent: typeof input?.intent === 'string' ? input.intent.slice(0, 32) : 'propose',
      title: String(input?.title ?? '').slice(0, MAX_TITLE),
      claimedAt: now,
      expiresAt: now + ttl,
    };
    claims.set(key, record);
    onEvent({ type: 'review/claimed', claim: { ...record } });
    return { ok: true, claim: { ...record } };
  }

  /**
   * @param {{projectId: string, nodeId: string, expertId: string}} input
   */
  function release({ projectId, nodeId, expertId }) {
    const key = keyOf(projectId, nodeId);
    const existing = claims.get(key);
    if (!existing) return { ok: false, code: 'not_claimed', message: `node ${nodeId} is not claimed` };
    if (existing.expertId !== expertId) {
      return {
        ok: false,
        code: 'not_holder',
        holder: { expertId: existing.expertId, expiresAt: existing.expiresAt },
        message: `node ${nodeId} is claimed by ${existing.expertId}`,
      };
    }
    claims.delete(key);
    onEvent({ type: 'review/released', claim: { ...existing } });
    return { ok: true };
  }

  /** Release every claim held by one expert in one project; returns the count. */
  function releaseAll(projectId, expertId) {
    let released = 0;
    for (const [key, claim] of claims) {
      if (claim.projectId !== projectId || claim.expertId !== expertId) continue;
      claims.delete(key);
      released += 1;
      onEvent({ type: 'review/released', claim: { ...claim } });
    }
    return released;
  }

  function get(projectId, nodeId, now = clock()) {
    const claim = claims.get(keyOf(projectId, nodeId));
    if (!claim) return null;
    return claim.expiresAt > now ? { ...claim } : null;
  }

  function isClaimed(projectId, nodeId, now = clock()) {
    return get(projectId, nodeId, now) !== null;
  }

  function list(projectId, now = clock()) {
    const out = [];
    for (const claim of claims.values()) {
      if (claim.projectId !== projectId) continue;
      if (claim.expiresAt <= now) continue;
      out.push({ ...claim });
    }
    return out.sort((a, b) => a.claimedAt - b.claimedAt || a.nodeId.localeCompare(b.nodeId));
  }

  function size() {
    return claims.size;
  }

  return { claim, release, releaseAll, get, isClaimed, list, sweep, size };
}
