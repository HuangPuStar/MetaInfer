/**
 * Dispatcher host (WP P3.5 in the plan's Phase 3): runs one active strategy per
 * project, an optional shadow strategy, and falls back to a deterministic
 * strategy when the active one stops producing decisions while work waits.
 *
 * - Active: its `submit` goes through the safety envelope.
 * - Shadow: its decisions are recorded as `dispatch/shadow_decided` events and
 *   never executed; its brokers are dry-run (`preview`) so it cannot hold GPUs.
 * - Fallback: if runnable nodes exist and the active strategy has not had a
 *   successful decision for `fallbackAfterMs`, the host stops it (drain) and
 *   starts the fallback, recording `dispatch/fallback`.
 */

function dryRunBroker(broker) {
  return {
    id: broker.id,
    async acquire(req) {
      if (typeof broker.preview === 'function') return broker.preview(req);
      return { status: 'queued', reason: 'shadow: broker has no preview' };
    },
    async renew() { return { status: 'lost', reason: 'shadow' }; },
    async release() {},
    async verify() { return false; },
  };
}

/**
 * @param {object} deps
 * @param {string} deps.projectId
 * @param {object} deps.executor
 * @param {object} deps.projection
 * @param {object} deps.bus
 * @param {Map<string, object>} deps.brokers
 * @param {(req: object) => string} deps.brokerIdFor which broker serves a request
 * @param {object} deps.envelope createDispatchEnvelope(...)
 * @param {object} deps.active DispatchStrategy
 * @param {object} [deps.shadow] DispatchStrategy
 * @param {() => object} [deps.makeFallback] factory for the fallback strategy
 * @param {number} [deps.fallbackAfterMs]
 * @param {() => number} [deps.clock]
 * @param {object} [deps.trace]
 * @param {object} [deps.logger]
 */
export function createDispatcher({
  projectId,
  executor,
  projection,
  bus,
  brokers,
  brokerIdFor,
  envelope,
  active,
  shadow = null,
  makeFallback = null,
  fallbackAfterMs = 120_000,
  clock = Date.now,
  trace = {},
  logger = null,
}) {
  let current = active;
  let lastProgressAt = clock();
  let fellBack = false;
  let watchdog = null;

  const view = {
    runnable: (id, now) => projection.runnable(id, now),
    getNode: (id, nodeId) => projection.getNode(id, nodeId),
    listByStatus: (id, status) => projection.listByStatus(id, status),
    revision: (id) => projection.revision(id),
  };

  function actorOf(strategy) {
    return { kind: 'dispatcher', id: strategy.id };
  }

  function contextFor(strategy, { isShadow }) {
    const strategyBrokers = isShadow
      ? new Map([...brokers].map(([id, broker]) => [id, dryRunBroker(broker)]))
      : brokers;
    return {
      projectId,
      view,
      brokers: strategyBrokers,
      brokerFor: (req) => strategyBrokers.get(brokerIdFor(req)),
      subscribe: (filter, handler, name) => bus.subscribe(filter, handler, name),
      submit: async (decision) => {
        if (isShadow) {
          await executor.commit(projectId, {
            actor: actorOf(strategy),
            mutations: [{ op: 'event.record', type: 'dispatch/shadow_decided', nodeId: decision?.nodeId, data: { kind: decision?.kind, reason: decision?.reason ?? null, broker: decision?.lease?.broker ?? null } }],
          });
          return { ok: true, shadow: true, decisionId: 'shadow' };
        }
        if (strategy !== current) return { ok: false, code: 'strategy_inactive' };
        const result = await envelope.submit(actorOf(strategy), decision);
        if (result.ok) lastProgressAt = clock();
        return result;
      },
      trace,
      clock,
      config: {},
      logger,
    };
  }

  /** Runnable work exists but the active strategy made no successful decision lately. */
  async function checkFallback(now = clock()) {
    if (fellBack || !makeFallback) return false;
    const waiting = projection.runnable(projectId, now).length > 0;
    if (!waiting) {
      lastProgressAt = now;
      return false;
    }
    if (now - lastProgressAt < fallbackAfterMs) return false;
    fellBack = true;
    const previous = current;
    const fallback = makeFallback();
    current = fallback;
    await previous.stop({ drain: true }).catch(() => {});
    await executor.commit(projectId, {
      actor: { kind: 'system', id: 'dispatcher' },
      mutations: [{ op: 'event.record', type: 'dispatch/fallback', data: { from: previous.id, to: fallback.id, idleMs: now - lastProgressAt } }],
    });
    lastProgressAt = now;
    await fallback.start(contextFor(fallback, { isShadow: false }));
    return true;
  }

  return {
    async start({ watchdogIntervalMs = 5_000 } = {}) {
      lastProgressAt = clock();
      await current.start(contextFor(current, { isShadow: false }));
      if (shadow) await shadow.start(contextFor(shadow, { isShadow: true }));
      if (watchdogIntervalMs > 0 && makeFallback) {
        watchdog = setInterval(() => { void checkFallback(); }, watchdogIntervalMs);
        watchdog.unref?.();
      }
    },
    async stop() {
      if (watchdog) clearInterval(watchdog);
      await current.stop({ drain: true });
      if (shadow) await shadow.stop({ drain: true });
    },
    checkFallback,
    get activeId() { return current.id; },
    get fellBack() { return fellBack; },
  };
}
