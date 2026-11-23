import { sandboxProfileOf } from '../sandbox-state.js';
import { executionFingerprint } from '../execution.js';
/**
 * Dispatcher contracts (WP P3.1). JSDoc only; this module exports validators.
 *
 * Principle: strategies decide, the kernel executes. No strategy (including a
 * future LLM agent that negotiates GPU slots with another machine's agent) can
 * start a node or treat GPUs as its own without a lease issued by a broker and
 * accepted by the kernel's safety envelope (`submit`, envelope.js).
 *
 * @typedef {object} LeaseRequest
 * @property {string} requestId stable per node attempt (`<projectId>:<nodeId>:<attempt>`)
 * @property {string} projectId
 * @property {string} nodeId
 * @property {Array<{machines?: number, gpusPerMachine?: number, sizes?: number[]}>} [shapes] acceptable gang shapes
 * @property {number} [amount] legacy single-shape form
 * @property {number} [machines]
 * @property {object} [constraints] placement constraints (labels, models, colocate ...)
 * @property {Record<string, number>} [resources] local pool needs (`{gpu: 1}`)
 * @property {number} walltimeMs hard upper bound; equals the node timebox
 * @property {string} [priorityClass]
 *
 * @typedef {object} LeaseGrant
 * @property {string} leaseId
 * @property {string} broker id of the issuing broker
 * @property {string} requestId
 * @property {Array<{machineId: string, deviceIds: string[]}>} [machines]
 * @property {Record<string, number>} [resources]
 * @property {number} grantedAt
 * @property {number|null} hardEndAt walltime end; renewals never move it
 * @property {number} [expiresAt] liveness TTL; renewals move it
 *
 * @typedef {{status: 'granted', lease: LeaseGrant}
 *   | {status: 'reserved', reservationId: string, startAt: number}
 *   | {status: 'queued', position?: number|null, reason?: string}
 *   | {status: 'contested', roundId: string, deadlineAt: number}
 *   | {status: 'denied', reason: string}} AcquireResult
 *
 * @typedef {object} ResourceBroker
 * @property {string} id 'local-pool' | 'cluster' | 'peer:<machine>'
 * @property {(req: LeaseRequest, opts?: {signal?: AbortSignal}) => Promise<AcquireResult>} acquire
 * @property {(leaseId: string) => Promise<{status: 'renewed', lease: LeaseGrant}|{status: 'lost', reason?: string}>} renew
 * @property {(leaseId: string) => Promise<void>} release
 * @property {(lease: LeaseGrant, req: {projectId: string, nodeId: string}) => Promise<boolean>} verify
 *   must be true only for a live lease issued by this broker for exactly this node
 * @property {(req: LeaseRequest) => Promise<AcquireResult>} [preview] dry run (shadow strategies)
 * @property {(onChange: (info: object) => void) => (() => void)} [watch] capacity/grant push
 *
 * @typedef {{kind: 'start', nodeId: string, lease: LeaseGrant, basis: number, reason: string, idempotencyKey?: string}
 *   | {kind: 'release', leaseId: string, broker: string, reason: string}
 *   | {kind: 'defer', nodeId: string, untilMs: number, basis: number, reason: string}
 *   | {kind: 'preempt', victimNodeId: string, forNodeId: string, basis: number, reason: string}} DispatchDecision
 *
 * @typedef {{ok: true, decisionId: string, shadow?: boolean} | {ok: false, code: string, message?: string, decisionId?: string}} DecisionResult
 *
 * @typedef {object} DispatchContext
 * @property {string} projectId
 * @property {object} view read-only projection (runnable, getNode, listByStatus, revision)
 * @property {Map<string, ResourceBroker>} brokers
 * @property {(req: LeaseRequest) => ResourceBroker} brokerFor
 * @property {(filter: object, handler: Function, name?: string) => (() => void)} subscribe
 * @property {(decision: DispatchDecision) => Promise<DecisionResult>} submit the only write path
 * @property {{ openActivation?: Function }} trace agent strategies open DSH sessions here
 * @property {() => number} clock
 * @property {object} config
 * @property {object} logger
 *
 * @typedef {object} DispatchStrategy
 * @property {string} id
 * @property {'deterministic'|'agent'|string} kind
 * @property {(ctx: DispatchContext) => Promise<void>} start
 * @property {(opts: {drain: boolean}) => Promise<void>} stop
 * @property {() => Promise<void>} [poke] run one round now (used by tests and the fallback watchdog)
 */

export const DECISION_KINDS = Object.freeze(['start', 'release', 'defer', 'preempt']);

/** @returns {string|null} a validation error, or null when the decision is well-formed. */
export function validateDecision(decision) {
  if (!decision || typeof decision !== 'object') return 'decision must be an object';
  if (!DECISION_KINDS.includes(decision.kind)) return `unknown decision kind ${decision?.kind}`;
  if (typeof decision.reason !== 'string' || decision.reason.length === 0) return 'reason is required';
  switch (decision.kind) {
    case 'start':
      if (typeof decision.nodeId !== 'string') return 'nodeId is required';
      if (!decision.lease || typeof decision.lease.leaseId !== 'string' || typeof decision.lease.broker !== 'string') {
        return 'lease with leaseId and broker is required';
      }
      if (!Number.isFinite(decision.basis)) return 'basis revision is required';
      return null;
    case 'release':
      return typeof decision.leaseId === 'string' && typeof decision.broker === 'string' ? null : 'leaseId and broker are required';
    case 'defer':
      if (typeof decision.nodeId !== 'string') return 'nodeId is required';
      if (!Number.isFinite(decision.untilMs)) return 'untilMs is required';
      return Number.isFinite(decision.basis) ? null : 'basis revision is required';
    case 'preempt':
      if (typeof decision.victimNodeId !== 'string' || typeof decision.forNodeId !== 'string') return 'victimNodeId and forNodeId are required';
      return Number.isFinite(decision.basis) ? null : 'basis revision is required';
    default:
      return 'unreachable';
  }
}

/** Stable request id for one node attempt, so retries never reuse a lease. */
export function leaseRequestId(projectId, node) {
  return `${projectId}:${node.id}:${node.attempt ?? node.attempts?.length ?? 0}`;
}

/** Normalize the Host runtime result; only a positive started outcome counts. */
export function startOutcomeOf(result, node, originalNode = node) {
  const boundary = (value) => sandboxProfileOf(value) !== null || value?.sandbox?.backend === 'opensandbox'
    || value?.admission?.broker === 'sandbox-admission' || Boolean(value?.sandboxGate)
    || Object.hasOwn(value?.execution ?? {}, 'sandboxProfile');
  const sandboxed = boundary(originalNode) || boundary(node);
  let sameBoundary = !sandboxed;
  if (sandboxed && node && originalNode && node.id === originalNode.id && node.projectId === originalNode.projectId) {
    try {
      sameBoundary = sandboxProfileOf(originalNode) !== null
        && sandboxProfileOf(node) === sandboxProfileOf(originalNode)
        && executionFingerprint(node.execution) === executionFingerprint(originalNode.execution);
    } catch { sameBoundary = false; }
  }
  const outcome = result?.startOutcome;
  if (!outcome && !sandboxed) return { status: 'started' }; // legacy local runtime
  const identity = Number.isInteger(outcome?.attempt) && outcome.attempt > 0
    && typeof outcome.sessionId === 'string' && outcome.sessionId.length > 0
    && (!sandboxed || (sameBoundary && outcome.attempt === node.currentAttempt && outcome.sessionId === node.sessionId));
  if (outcome?.status === 'started' && (!sandboxed || identity)) return { ...outcome };
  if (outcome?.status === 'queued' && (!sandboxed || (identity && outcome.code === 'NO_CAPACITY' && outcome.verifiedClean === true))) return { ...outcome };
  if (outcome?.status === 'held') return { ...outcome, retryable: false };
  return { status: 'held', code: 'INVALID_START_OUTCOME', retryable: false };
}
