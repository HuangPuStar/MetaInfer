/**
 * `dispatchOnce`: the deterministic fast path (design decision B3).
 *
 * A single call answers "start whatever can start right now" without a model:
 * read the runnable set, order it, acquire leases, take the commit point and
 * launch. It is wired into the auto driver's 2s tick and into the runtime's
 * termination hook, so a planned node no longer waits for advisor + scheduler
 * (measured 129 s + 18 s in the QA doc).
 *
 * The latency budget covers the dispatch decision: selection, lease and the
 * kernel claim, up to the `launcher.start` call. Bootstrapping the experiment
 * (worktree, anchor session, worker) is the runtime's job and is not part of
 * this budget; the test in scripts/dispatch-once-selftest.mjs asserts the
 * decision path stays under 100 ms for a 500-node DAG.
 */
import { fairOrder } from '../kernel/priority.js';
import { DISPATCH_POLICY } from '../kernel/policy.js';
import { createDispatchEnvelope } from './envelope.js';
import { defaultRequestFor } from './deterministic-strategy.js';
import { dispatchRound } from './round.js';
import { applyClassBudgets, applyReservation, classBudgetOf, reservedSlotsOf, selectPreemptionVictim } from './reservation.js';

/** Default broker choice: fleet nodes need the cluster broker, everything else the local pool. */
export function defaultBrokerIdFor(request) {
  return request?.placement === 'fleet' ? 'cluster' : 'local-pool';
}

/**
 * @param {object} deps
 * @param {string} deps.projectId
 * @param {object} deps.executor
 * @param {object} deps.projection
 * @param {Map<string, object>} deps.brokers
 * @param {object} deps.launcher `{start(projectId, nodeId, opts)}`
 * @param {(request: object) => string} [deps.brokerIdFor]
 * @param {object} [deps.policy]
 * @param {() => number} [deps.clock]
 * @param {number} [deps.maxStarts]
 * @param {(projectId: string, node: object) => object} [deps.requestFor]
 * @param {() => Map<string, {gpuSeconds: number, weight?: number}>} [deps.usageBySource]
 */
export function createDispatchOnce({
  projectId,
  executor,
  projection,
  brokers,
  launcher,
  brokerIdFor = defaultBrokerIdFor,
  policy = DISPATCH_POLICY,
  clock = Date.now,
  maxStarts = 32,
  requestFor = defaultRequestFor,
  usageBySource = () => new Map(),
  logger = null,
}) {
  const envelope = createDispatchEnvelope({ projectId, executor, projection, brokers, launcher, policy, clock });
  const lastOutcome = new Map();
  const actor = Object.freeze({ kind: 'dispatcher', id: 'dispatch-once' });

  /**
   * Run one round.
   * @param {{ maxStarts?: number }} [options]
   */
  async function run(options = {}) {
    const startedAt = clock();
    const budget = Number.isFinite(options.maxStarts) ? Math.max(0, Math.floor(options.maxStarts)) : maxStarts;
    const candidateStart = clock();
    const runnable = projection.runnable(projectId, candidateStart);
    const maxRunningNodes = options.maxRunningNodes ?? Infinity;
    const running = projection.listByStatus(projectId, 'running');
    // Project-local p0 preemption (5.3.2/Q3): if every slot is held by a
    // lower-class node that has already run > 10 min, the dispatcher preempts
    // exactly one victim through the safety envelope. The victim records a
    // cause and an open appeal; the p0 below can then acquire the freed slot in
    // this same round.
    let preempted = null;
    const p0Candidate = runnable.find((node) => node?.priority?.class === 'p0');
    const p0Budget = classBudgetOf(options.config, 'p0');
    const p0Running = running.filter((node) => node?.priority?.class === 'p0').length;
    const p0HasBudget = p0Budget === null || p0Running < p0Budget;
    const victim = p0HasBudget
      ? selectPreemptionVictim({
          now: candidateStart,
          running,
          runnable,
          maxRunningNodes,
          enabled: options.preemption !== false,
        })
      : null;
    if (victim) {
      const p0 = p0Candidate;
      const decision = await envelope.submit(
        { kind: 'system', id: 'preemptor' },
        {
          kind: 'preempt',
          victimNodeId: victim.id,
          forNodeId: p0?.id ?? null,
          basis: victim.rev ?? 0,
          reason: `p0 ${p0?.id ?? 'waiting'} needs a slot; preempt ${victim.priority?.class ?? 'lower'} ${victim.id} after >10 min`,
        },
      );
      if (decision.ok) {
        // The victim's broker lease is local to the dispatcher, while runtime
        // preemption only knows the node. Sweep orphaned leases now so the p0
        // can use the freed slot in this same round instead of waiting a tick.
        for (const broker of brokers.values()) {
          broker.releaseOrphans?.(executor.store?.listNodes?.(projectId) ?? projection.listNodes(projectId));
        }
        preempted = { victimNodeId: victim.id, forNodeId: p0?.id ?? null, decisionId: decision.decisionId };
      } else {
        preempted = { victimNodeId: victim.id, forNodeId: p0?.id ?? null, code: decision.code ?? 'rejected' };
      }
    }
    // Reserve capacity for waiting p0 work before ordering/limiting. The filter
    // is round-local; the queue remains the projection, never a second store.
    const reserved = options.reservedSlots ?? reservedSlotsOf(options.config);
    const admitted = applyClassBudgets(applyReservation(runnable, {
      runningCount: projection.countByStatus(projectId).running ?? 0,
      maxRunningNodes,
      reservedSlots: reserved,
    }), { running, config: options.config ?? {} });
    const candidates = fairOrder(admitted, usageBySource(), {
      // Slack so a queued head does not stop smaller nodes from backfilling.
      limit: Math.max(budget * 4, budget),
    });
    const selectionMs = clock() - candidateStart;
    let round;
    try {
      round = await dispatchRound({
        projectId,
        candidates,
        requestFor,
        brokerFor: (request) => brokers.get(brokerIdFor(request)),
        submit: (decision) => envelope.submit(actor, decision),
        maxStarts: budget,
        lastOutcome,
      });
    } catch (error) {
      logger?.warn?.(`dispatchOnce(${projectId}): round failed: ${error?.message ?? error}`);
      round = { started: 0, startedNodeIds: [], skipped: [{ nodeId: null, status: 'error', message: String(error?.message ?? error) }] };
    }
    return {
      ...round,
      candidates: candidates.length,
      runnable: runnable.length,
      ...(preempted ? { preempted } : {}),
      selectionMs,
      durationMs: clock() - startedAt,
    };
  }

  return {
    run,
    outcomes: () => new Map(lastOutcome),
    envelope,
  };
}
