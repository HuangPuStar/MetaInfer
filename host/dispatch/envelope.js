/**
 * The kernel's dispatch safety envelope (WP P3.1). Not pluggable.
 *
 * `submit(decision)` is the only way a dispatch strategy changes anything.
 * For `start` it enforces, in order:
 *   1. well-formed decision (types.js validateDecision);
 *   2. node is runnable at the current revision and not changed since `basis`;
 *   3. lease is fresh in this process (no double spend) and `broker.verify`
 *      confirms it is live and issued for exactly this node;
 *   4. policy allows the actor to start this node;
 *   5. commit point: executor commits `node.claim` (node leaves the runnable set);
 *   6. launch through the runtime; on failure the lease and the claim are
 *      released and the node is held back with exponential backoff.
 * Every rejection releases the lease (a rejected start must not leak GPUs) and
 * is recorded as a `dispatch/rejected` event, so every decision is explainable.
 */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { startOutcomeOf, validateDecision } from './types.js';
import { holdsResources, sandboxAdmissionBlock, sandboxProfileOf } from '../sandbox-state.js';
import { basisFor, createIntent, intentId, intentMutation } from '../kernel/intent.js';

const LAUNCH_BACKOFF_BASE_MS = 30_000;
const LAUNCH_BACKOFF_MAX_MS = 30 * 60_000;

/**
 * @param {object} deps
 * @param {string} deps.projectId
 * @param {object} deps.executor kernel executor
 * @param {object} deps.projection kernel projection
 * @param {Map<string, object>} deps.brokers
 * @param {{ start(projectId: string, nodeId: string, opts: {lease: object, decisionId: string}): Promise<void>,
 *           preempt?(projectId: string, nodeId: string, opts: object): Promise<void> }} deps.launcher
 * @param {{ authorize(actor: object, action: string, target: object): {ok: boolean, code?: string} }} [deps.policy]
 * @param {() => number} [deps.clock]
 */
export function createDispatchEnvelope({ projectId, executor, projection, brokers, launcher, policy = null, clock = Date.now }) {
  const usedLeases = new Set();

  async function record(actor, type, data, nodeId = undefined) {
    await executor.commit(projectId, { actor, mutations: [{ op: 'event.record', type, nodeId, data }] });
  }

  async function finalize(broker, leaseId) {
    if (typeof broker?.finalizeRelease !== 'function') return { released: true };
    try { return await broker.finalizeRelease(leaseId); } catch { return { released: false, held: true }; }
  }

  async function rejectStart(actor, decision, decisionId, code, message, { releaseLease = true } = {}) {
    if (releaseLease && decision.lease?.leaseId) {
      const released = await brokers.get(decision.lease.broker)?.release(decision.lease.leaseId).catch(() => null);
      if (decision.lease.broker === 'sandbox-admission' && released?.released !== true) {
        await record(actor, 'dispatch/held', { decisionId, code, leaseId: decision.lease.leaseId, reason: 'sandbox ownership unresolved' }, decision.nodeId);
        return { ok: false, code: 'sandbox_held', decisionId, startOutcome: { status: 'held', retryable: false } };
      }
      if (released?.released === true && (await finalize(brokers.get(decision.lease.broker), decision.lease.leaseId))?.released !== true) {
        await record(actor, 'dispatch/held', { decisionId, code, leaseId: decision.lease.leaseId, reason: 'Host budget remains held' }, decision.nodeId);
        return { ok: false, code: 'host_budget_held', decisionId, startOutcome: { status: 'held', retryable: false } };
      }
    }
    await record(actor, 'dispatch/rejected', { decisionId, kind: decision.kind, code, message, leaseId: decision.lease?.leaseId ?? null }, decision.nodeId);
    return { ok: false, code, message, decisionId };
  }

  async function submitStart(actor, decision, decisionId) {
    const node = projection.getNode(projectId, decision.nodeId);
    if (!node) return rejectStart(actor, decision, decisionId, 'not_found', `node ${decision.nodeId} not found`);
    if (node.status !== 'planned' || node.claim) return rejectStart(actor, decision, decisionId, 'not_runnable', `node is ${node.status}${node.claim ? ' (claimed)' : ''}`);
    if (sandboxAdmissionBlock(node)) return rejectStart(actor, decision, decisionId, 'sandbox_held', 'sandbox ownership or operation unresolved');
    if (sandboxProfileOf(node) !== null && decision.lease.broker !== 'sandbox-admission') return rejectStart(actor, decision, decisionId, 'lease_invalid', 'sandbox requires its Host admission broker');
    if ((node.rev ?? 0) > decision.basis) return rejectStart(actor, decision, decisionId, 'stale', `node changed at revision ${node.rev} after basis ${decision.basis}`);
    if (usedLeases.has(decision.lease.leaseId)) {
      return rejectStart(actor, decision, decisionId, 'lease_reused', 'lease already used for another start', { releaseLease: false });
    }
    const broker = brokers.get(decision.lease.broker);
    if (!broker) return rejectStart(actor, decision, decisionId, 'unknown_broker', `no broker ${decision.lease.broker}`, { releaseLease: false });
    let valid = false;
    try {
      valid = await broker.verify(decision.lease, { projectId, nodeId: node.id });
    } catch {
      valid = false;
    }
    if (!valid) return rejectStart(actor, decision, decisionId, 'lease_invalid', 'broker did not confirm the lease for this node');
    if (policy) {
      const verdict = policy.authorize(actor, 'dispatch.start', { projectId, node });
      if (!verdict?.ok) return rejectStart(actor, decision, decisionId, verdict?.code ?? 'forbidden', 'policy denied dispatch.start');
    }
    usedLeases.add(decision.lease.leaseId);
    const dispatchIntent = createIntent({
      id: intentId('dispatch', node.rev ?? 0, actor.id),
      kind: 'dispatch',
      actor,
      claim: {
        action: 'claim_node',
        decisionId,
        strategyId: actor.id,
        broker: broker.id,
        leaseId: decision.lease.leaseId,
        reason: decision.reason ?? null,
        hardEndAt: decision.lease.hardEndAt ?? null,
      },
      basis: basisFor(projection.revision(projectId), projection.listNodes(projectId).length),
      target: { nodeId: node.id },
      rationale: decision.reason ?? null,
    });
    const claimed = await executor.commit(projectId, {
      actor,
      basis: decision.basis,
      idempotencyKey: decision.idempotencyKey,
      mutations: [{
        op: 'node.claim',
        nodeId: node.id,
        claim: { decisionId, strategyId: actor.id, broker: broker.id, leaseId: decision.lease.leaseId },
        eventData: { decisionId, strategyId: actor.id, broker: broker.id, leaseId: decision.lease.leaseId, reason: decision.reason, hardEndAt: decision.lease.hardEndAt ?? null },
      }, ...(broker.id === 'sandbox-admission' ? [{ op: 'node.update', nodeId: node.id, set: { admission: structuredClone(decision.lease) }, eventType: 'dispatch/admitted' }] : []), intentMutation(dispatchIntent)],
    });
    if (!claimed.ok) {
      usedLeases.delete(decision.lease.leaseId);
      return rejectStart(actor, decision, decisionId, claimed.code, claimed.message);
    }
    const launchContext = structuredClone(node);
    const sameAdmission = (value) => isDeepStrictEqual(value?.admission, decision.lease);
    async function held(outcome) {
      const fresh = projection.getNode(projectId, node.id);
      // A late queue result must not overwrite a terminal cancellation/new owner.
      if (fresh?.status === 'planned' && sameAdmission(fresh)
        && fresh.claim?.decisionId === decisionId && !sandboxAdmissionBlock(fresh)
        && await broker.verify(decision.lease, { projectId, nodeId: node.id }).catch(() => false)) {
        await executor.commit(projectId, {
          actor, basis: fresh.rev ?? 0,
          mutations: [{ op: 'node.update', nodeId: node.id, set: { dispatchHold: { untilMs: null, reason: 'sandbox_held', by: actor.id } }, eventType: 'dispatch/held', eventData: { decisionId, outcome } }],
        });
      }
      return { ok: true, decisionId, startOutcome: { ...outcome, status: 'held', retryable: false } };
    }
    let outcome;
    try {
      const result = await launcher.start(projectId, node.id, { lease: structuredClone(decision.lease), decisionId });
      outcome = startOutcomeOf(result, projection.getNode(projectId, node.id), launchContext);
    } catch (error) {
      if (broker.id === 'sandbox-admission') return held({ code: 'START_UNKNOWN', message: String(error?.message ?? error) });
      await broker.release(decision.lease.leaseId).catch(() => {});
      // Back off so a node whose launch keeps failing cannot spin the dispatcher.
      const failures = (node.dispatchFailures ?? 0) + 1;
      const backoffMs = Math.min(LAUNCH_BACKOFF_MAX_MS, LAUNCH_BACKOFF_BASE_MS * 2 ** (failures - 1));
      await executor.commit(projectId, {
        actor,
        mutations: [
          { op: 'node.releaseClaim', nodeId: node.id, decisionId, reason: 'launch_failed', eventType: 'dispatch/start_failed', eventData: { decisionId, message: String(error?.message ?? error), backoffMs } },
          // The `dispatch/start_failed` event above carries the message too, but
          // `node.releaseClaim` returns no event when the claim is already gone,
          // and in practice only this `dispatch/held` row survived — which left
          // every launch failure undiagnosable. Repeat the message here.
          { op: 'node.update', nodeId: node.id, set: { dispatchFailures: failures, dispatchHold: { untilMs: clock() + backoffMs, reason: 'launch_failed', by: actor.id } }, eventType: 'dispatch/held', eventData: { decisionId, untilMs: clock() + backoffMs, reason: 'launch_failed', message: String(error?.message ?? error).slice(0, 500) } },
        ],
      });
      await finalize(broker, decision.lease.leaseId);
      return { ok: false, code: 'start_failed', message: String(error?.message ?? error), decisionId };
    }
    if (outcome.status === 'held') return held(outcome);
    if (outcome.status === 'queued') {
      const released = await broker.release(decision.lease.leaseId).catch(() => null);
      if (broker.id === 'sandbox-admission' && released?.released !== true) return held({ code: 'CLEAN_RELEASE_UNCONFIRMED' });
      const fresh = projection.getNode(projectId, node.id);
      if (broker.id === 'sandbox-admission') {
        if (sameAdmission(fresh) && (holdsResources(fresh) || sandboxAdmissionBlock(fresh))) {
          // A concurrent Unknown after the clean proof still owns its exact permit.
          try { broker.adopt(decision.lease); } catch { /* never adopt a different identity */ }
          return held({ code: 'QUEUE_STATE_UNRESOLVED' });
        }
        if (!fresh || fresh.status !== 'planned' || !sameAdmission(fresh)
          || fresh.claim?.decisionId !== decisionId || fresh.currentAttempt !== outcome.attempt
          || fresh.sessionId !== outcome.sessionId) return held({ code: 'LAUNCH_IDENTITY_CHANGED' });
      }
      const clean = await executor.commit(projectId, {
        actor, basis: fresh?.rev ?? 0,
        mutations: [
          { op: 'node.releaseClaim', nodeId: node.id, decisionId, reason: 'no_capacity', eventType: 'dispatch/queued', eventData: { decisionId, outcome } },
          { op: 'node.update', nodeId: node.id, unset: ['admission', 'dispatchFailures', 'dispatchHold'] },
        ],
      });
      if (!clean.ok) {
        const latest = projection.getNode(projectId, node.id);
        if (broker.id === 'sandbox-admission' && sameAdmission(latest)
          && ((latest.status === 'planned' && latest.claim?.decisionId === decisionId)
            || holdsResources(latest) || sandboxAdmissionBlock(latest))) {
          try { broker.adopt(decision.lease); } catch { /* stale owner never replaces a permit */ }
        }
        return held({ code: 'QUEUE_COMMIT_REJECTED' });
      }
      if ((await finalize(broker, decision.lease.leaseId))?.released !== true) return held({ code: 'HOST_BUDGET_RELEASE_UNCONFIRMED' });
    }
    return { ok: true, decisionId, startOutcome: outcome };
  }

  /**
   * @param {{kind: string, id: string}} actor the strategy, as a kernel actor
   * @param {object} decision DispatchDecision
   */
  async function submit(actor, decision) {
    const decisionId = `dec-${randomUUID().slice(0, 12)}`;
    const invalid = validateDecision(decision);
    if (invalid) {
      await record(actor, 'dispatch/rejected', { decisionId, kind: decision?.kind ?? null, code: 'invalid_decision', message: invalid }, decision?.nodeId);
      return { ok: false, code: 'invalid_decision', message: invalid, decisionId };
    }
    switch (decision.kind) {
      case 'start':
        return submitStart(actor, decision, decisionId);
      case 'release': {
        const broker = brokers.get(decision.broker);
        if (!broker) return { ok: false, code: 'unknown_broker', decisionId };
        const released = await broker.release(decision.leaseId);
        if (decision.broker === 'sandbox-admission' && released?.released !== true) {
          await record(actor, 'dispatch/held', { decisionId, leaseId: decision.leaseId, reason: 'sandbox ownership unresolved' });
          return { ok: false, code: 'sandbox_held', decisionId, startOutcome: { status: 'held', retryable: false } };
        }
        if (released?.released === true && (await finalize(broker, decision.leaseId))?.released !== true) return { ok: false, code: 'host_budget_held', decisionId, startOutcome: { status: 'held', retryable: false } };
        await record(actor, 'dispatch/released', { decisionId, leaseId: decision.leaseId, reason: decision.reason });
        return { ok: true, decisionId };
      }
      case 'defer': {
        const result = await executor.commit(projectId, {
          actor,
          basis: decision.basis,
          mutations: [{
            op: 'node.update', nodeId: decision.nodeId, set: { dispatchHold: { untilMs: decision.untilMs, reason: decision.reason, by: actor.id } },
            eventType: 'dispatch/held', eventData: { decisionId, untilMs: decision.untilMs, reason: decision.reason },
          }],
        });
        return result.ok ? { ok: true, decisionId } : { ok: false, code: result.code, message: result.message, decisionId };
      }
      case 'preempt': {
        if (!policy) return { ok: false, code: 'forbidden', message: 'preemption requires a policy', decisionId };
        const victim = projection.getNode(projectId, decision.victimNodeId);
        if (sandboxProfileOf(victim) !== null || victim?.sandbox?.backend === 'opensandbox') return { ok: false, code: 'not_supported', message: 'sandbox preemption is not supported', decisionId };
        const verdict = policy.authorize(actor, 'dispatch.preempt', { projectId, node: victim, forNodeId: decision.forNodeId });
        if (!verdict?.ok) return { ok: false, code: verdict?.code ?? 'forbidden', decisionId };
        if (!victim || victim.status !== 'running') return { ok: false, code: 'not_running', decisionId };
        if (typeof launcher.preempt !== 'function') return { ok: false, code: 'not_supported', message: 'runtime has no preemption yet (WP P3.5.9)', decisionId };
        await record(actor, 'dispatch/preempting', { decisionId, victimNodeId: victim.id, forNodeId: decision.forNodeId, reason: decision.reason }, victim.id);
        await launcher.preempt(projectId, victim.id, {
          decisionId,
          reason: decision.reason,
          forNodeId: decision.forNodeId,
          by: actor.kind === 'system' ? actor.id : actor.kind,
          causeId: `preempt:${decisionId}`,
          at: clock(),
        });
        return { ok: true, decisionId };
      }
      default:
        return { ok: false, code: 'invalid_decision', decisionId };
    }
  }

  return { submit };
}
