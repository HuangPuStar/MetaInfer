/**
 * One dispatch round, shared by the long-running DeterministicStrategy and by
 * the synchronous `dispatchOnce` fast path.
 *
 * A round is pure orchestration over three injected seams: the candidate list
 * (already ordered), a broker per request, and `submit` (the safety envelope).
 * Keeping the loop here means the fast path and the event-driven strategy cannot
 * diverge in lease handling or backfill behaviour.
 */

/**
 * @param {object} deps
 * @param {string} deps.projectId
 * @param {Array<object>} deps.candidates ordered runnable nodes
 * @param {(projectId: string, node: object) => object} deps.requestFor
 * @param {(request: object) => object|undefined} deps.brokerFor
 * @param {(decision: object) => Promise<{ok: boolean, code?: string}>} deps.submit
 * @param {number} [deps.maxStarts]
 * @param {() => boolean} [deps.shouldStop]
 * @param {Map<string, object>} [deps.lastOutcome]
 * @param {(node: object, ordinal: number) => string} [deps.reasonFor]
 */
export async function dispatchRound({
  projectId,
  candidates,
  requestFor,
  brokerFor,
  submit,
  maxStarts = 32,
  shouldStop = () => false,
  lastOutcome = null,
  reasonFor = defaultReasonFor,
}) {
  let started = 0;
  const startedNodeIds = [];
  const skipped = [];
  for (const node of candidates) {
    if (started >= maxStarts) break;
    if (shouldStop()) break;
    const request = requestFor(projectId, node);
    const broker = brokerFor(request);
    if (!broker) {
      skipped.push({ nodeId: node.id, status: 'no_broker' });
      continue;
    }
    let result;
    try {
      result = await broker.acquire(request);
    } catch (error) {
      const outcome = { status: 'error', message: String(error?.message ?? error) };
      lastOutcome?.set(node.id, outcome);
      skipped.push({ nodeId: node.id, ...outcome });
      continue;
    }
    lastOutcome?.set(node.id, { status: result.status, reason: result.reason ?? null, startAt: result.startAt ?? null });
    if (result.status !== 'granted') {
      skipped.push({ nodeId: node.id, status: result.status, reason: result.reason ?? null, position: result.position ?? null });
      continue;
    }
    const decision = await submit({
      kind: 'start',
      nodeId: node.id,
      lease: result.lease,
      basis: node.rev ?? 0,
      reason: reasonFor(node, started + 1),
      idempotencyKey: `start:${request.requestId}`,
    });
    if (decision.ok) {
      started += 1;
      startedNodeIds.push(node.id);
    } else {
      skipped.push({ nodeId: node.id, status: 'rejected', code: decision.code ?? null, message: decision.message ?? null });
    }
  }
  return { started, startedNodeIds, skipped };
}

/** Default explanation written into `dispatch/started`'s cause chain. */
export function defaultReasonFor(node, ordinal) {
  return `deterministic: class=${node.priority?.class ?? 'p2'} rank=${ordinal}`;
}
