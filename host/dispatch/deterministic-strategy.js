/**
 * DeterministicStrategy (WP P3.4): the default dispatch strategy, no LLM.
 *
 * One round: take the projection's runnable set (single definition, B8),
 * order it fairly across sources inside each priority class, and for each
 * node ask the matching broker for a lease; on `granted`, submit a `start`
 * decision. Requests that are `queued`, `reserved` or `contested` stay with
 * the broker/coordinator; the round continues so smaller nodes can backfill
 * wherever the broker allows it (the coordinator decides what is safe).
 *
 * Rounds run on kernel events (new runnable work, terminations, priority
 * changes, releases) and on a slow safety timer; a single-flight guard keeps
 * at most one round running and coalesces wake-ups into one follow-up round.
 */
import { fairOrder } from '../kernel/priority.js';
import { leaseRequestId } from './types.js';
import { dispatchRound } from './round.js';

const WAKE_TYPES = [
  'node/*',
  'dispatch/claim_released',
  'dispatch/start_failed',
  'dispatch/released',
  'resource/*',
];

/**
 * @param {object} [options]
 * @param {string} [options.id]
 * @param {number} [options.maxStartsPerRound]
 * @param {number} [options.safetyIntervalMs]
 * @param {(projectId: string, node: object) => object} [options.requestFor] build a LeaseRequest
 * @param {() => Map<string, {gpuSeconds: number, weight?: number}>} [options.usageBySource]
 */
export function createDeterministicStrategy({
  id = 'deterministic',
  maxStartsPerRound = 32,
  safetyIntervalMs = 15_000,
  requestFor = defaultRequestFor,
  usageBySource = () => new Map(),
} = {}) {
  let ctx = null;
  let unsubscribe = null;
  let timer = null;
  let running = null;
  let again = false;
  let stopped = true;
  const lastOutcome = new Map();

  async function round() {
    const { projectId, view } = ctx;
    const candidates = fairOrder(view.runnable(projectId, ctx.clock()), usageBySource(), {
      // Backfill needs a little slack beyond the start budget: a queued broker
      // answer for the head must not stop the round from filling smaller nodes.
      limit: Math.max(maxStartsPerRound * 4, maxStartsPerRound),
    });
    const result = await dispatchRound({
      projectId,
      candidates,
      requestFor,
      brokerFor: (request) => ctx.brokerFor(request),
      submit: (decision) => ctx.submit(decision),
      maxStarts: maxStartsPerRound,
      shouldStop: () => stopped,
      lastOutcome,
    });
    return result.started;
  }

  function wake() {
    if (stopped) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await round();
        } while (again && !stopped);
      } catch (error) {
        ctx?.logger?.warn?.(`dispatch(${id}): round failed: ${error?.message ?? error}`);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  return {
    id,
    kind: 'deterministic',
    async start(context) {
      ctx = context;
      stopped = false;
      unsubscribe = ctx.subscribe({ projectId: ctx.projectId, types: WAKE_TYPES }, () => wake(), `dispatch:${id}`);
      if (safetyIntervalMs > 0) {
        timer = setInterval(() => { void wake(); }, safetyIntervalMs);
        timer.unref?.();
      }
      await wake();
    },
    async stop() {
      stopped = true;
      unsubscribe?.();
      if (timer) clearInterval(timer);
      await running;
    },
    poke: () => wake(),
    /** Last broker answer per node, for UI and `trace_explain` ("why is this not running"). */
    outcomes: () => new Map(lastOutcome),
  };
}

/** Map a node's `needs` to a LeaseRequest. */
export function defaultRequestFor(projectId, node) {
  const needs = node.needs ?? {};
  const gpu = Number(needs.gpu ?? 0);
  const machines = Number(needs.machines ?? 1);
  const resources = Object.fromEntries(Object.entries(needs).filter(([key]) => key !== 'machines'));
  return {
    requestId: leaseRequestId(projectId, node),
    projectId,
    nodeId: node.id,
    resources,
    amount: gpu,
    machines,
    shapes: Array.isArray(needs.shapes) ? needs.shapes : undefined,
    constraints: node.placementConstraints ?? null,
    placement: node.placement ?? (machines > 1 ? 'fleet' : 'local'),
    walltimeMs: node.timeboxMs ?? null,
    priorityClass: node.priority?.class ?? 'p2',
  };
}
