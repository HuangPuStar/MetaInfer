/**
 * Semantic curator (Stage 4.3). The curator only *nominates* candidate closes.
 * It holds no store and no executor: the code that applies a nomination lives in
 * the Host, and this module rejects any attempt to execute one itself.
 *
 * A false-close circuit breaker protects against a curator that starts seeing
 * duplicates everywhere: once the observed false-close rate exceeds the
 * threshold, nominations stop until a human resets it.
 */
import { recallCandidates } from './similarity.js';

const DEFAULT_MIN_AGE_MS = 10 * 60_000;

export function createCurator({
  clock = Date.now,
  falseCloseThreshold = 0.2,
  maxNominations = 5,
  minAgeMs = DEFAULT_MIN_AGE_MS,
  threshold = 0.3,
} = {}) {
  let proposed = 0;
  let decided = 0;
  let falseCloses = 0;
  let circuitOpen = false;
  let circuitReason = null;

  function falseCloseRate() {
    return decided === 0 ? 0 : Math.round((falseCloses / decided) * 1000) / 1000;
  }

  /**
   * @param {{nodes: object[], claims?: object[], reviews?: object[]}} input
   * @returns {{nominations: object[], candidates: number, circuitOpen: boolean}}
   */
  function nominate({ nodes = [], claims = [], reviews = [] } = {}) {
    if (circuitOpen) {
      return { nominations: [], candidates: 0, circuitOpen: true, reason: circuitReason };
    }
    const now = clock();
    const blocked = new Set([
      ...claims.filter((claim) => !claim.expiresAt || claim.expiresAt > now).map((claim) => claim.nodeId),
      ...reviews.filter((review) => review.status === 'pending' || review.status === 'claimed').map((review) => review.nodeId),
    ]);
    const recent = new Set(nodes.filter((node) => {
      const createdAt = node.timestamps?.createdAt ?? 0;
      return createdAt > 0 && now - createdAt < minAgeMs;
    }).map((node) => node.id));
    const recall = recallCandidates(nodes, { threshold, limit: maxNominations * 4, excludeIds: [...blocked, ...recent] });
    const nominations = recall.pairs.slice(0, maxNominations).map((pair, index) => ({
      nominationId: `nom-${now}-${index + 1}`,
      action: 'close',
      nodeId: pair.a,
      duplicateOf: pair.b,
      kind: pair.kind,
      confidence: pair.score,
      evidence: [{ kind: 'similarity', ref: `${pair.a}~${pair.b}`, note: `score ${pair.score}; ${(pair.reasons ?? []).join(',')}` }],
    }));
    proposed += nominations.length;
    return { nominations, candidates: recall.total, circuitOpen: false };
  }

  /** Record whether an applied nomination turned out to be a false close. */
  function recordOutcome({ falseClose = false } = {}) {
    decided += 1;
    if (falseClose) falseCloses += 1;
    const rate = falseCloseRate();
    if (rate > falseCloseThreshold) {
      circuitOpen = true;
      circuitReason = `falseCloseRate ${rate} > ${falseCloseThreshold}`;
    }
    return { ok: true, decided, falseCloses, falseCloseRate: rate, circuitOpen, reason: circuitReason };
  }

  function reset() {
    circuitOpen = false;
    circuitReason = null;
    return status();
  }

  function status() {
    return { proposed, decided, falseCloses, falseCloseRate: falseCloseRate(), circuitOpen, reason: circuitReason };
  }

  return { nominate, recordOutcome, reset, status };
}

/**
 * Executing a nomination is deliberately impossible here. The Host applies a
 * nomination through a kernel commit after its own validation; a caller that
 * tries to use the curator as an executor gets an explicit rejection.
 */
export function applyNomination() {
  return {
    ok: false,
    code: 'curator_cannot_execute',
    message: 'the curator may only nominate; Host code applies a closed nomination',
  };
}
