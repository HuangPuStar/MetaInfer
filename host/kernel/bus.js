/**
 * In-process event bus: delivers acknowledged kernel events to subscribers.
 *
 * - Publishing happens after the executor has persisted a commit, so a
 *   subscriber never sees an event that could still be rolled back.
 * - Each subscriber has its own ordered queue: events reach one subscriber in
 *   publication order, and a slow or failing subscriber cannot block others.
 * - The bus is not durable. Consumers that must not miss events (experts,
 *   triggers) keep a `lastSeenSeq` cursor and catch up from the event log;
 *   the bus is only the wake-up signal.
 */

/**
 * @param {object} [options]
 * @param {(error: unknown, subscription: string) => void} [options.onError]
 */
export function createEventBus({ onError = () => {} } = {}) {
  const subscribers = new Set();

  function matches(filter, event) {
    if (!filter) return true;
    if (filter.projectId && event.projectId !== filter.projectId) return false;
    if (Array.isArray(filter.types) && filter.types.length > 0) {
      const ok = filter.types.some((type) => (type.endsWith('/*')
        ? event.type.startsWith(type.slice(0, -1))
        : event.type === type));
      if (!ok) return false;
    }
    if (typeof filter.predicate === 'function' && !filter.predicate(event)) return false;
    return true;
  }

  /**
   * @param {{projectId?: string, types?: string[], predicate?: (event) => boolean}|null} filter
   *   `types` accepts exact names and prefixes such as `node/*`.
   * @param {(event: object) => (void|Promise<void>)} handler
   * @param {string} [name] label used in error reports
   * @returns {() => void} unsubscribe
   */
  function subscribe(filter, handler, name = 'anonymous') {
    const subscriber = { filter, handler, name, queue: [], draining: false, closed: false };
    subscribers.add(subscriber);
    return () => {
      subscriber.closed = true;
      subscribers.delete(subscriber);
    };
  }

  async function drain(subscriber) {
    if (subscriber.draining) return;
    subscriber.draining = true;
    try {
      while (subscriber.queue.length > 0 && !subscriber.closed) {
        const event = subscriber.queue.shift();
        try {
          await subscriber.handler(event);
        } catch (error) {
          onError(error, subscriber.name);
        }
      }
    } finally {
      subscriber.draining = false;
    }
  }

  /** Queue events for every matching subscriber; delivery is asynchronous. */
  function publish(events) {
    for (const event of events) {
      for (const subscriber of subscribers) {
        if (!matches(subscriber.filter, event)) continue;
        subscriber.queue.push(event);
        queueMicrotask(() => { void drain(subscriber); });
      }
    }
  }

  /**
   * Long-poll helper: resolve with events newer than `afterSeq`, waiting up to
   * `timeoutMs` for the first one. Reads the durable log, so nothing is missed
   * between calls.
   * @param {object} args
   * @param {string} args.projectId
   * @param {number} args.afterSeq
   * @param {number} args.timeoutMs
   * @param {(projectId: string, after: number) => object[]} args.listEvents
   * @param {number} [args.limit]
   */
  function waitForEvents({ projectId, afterSeq, timeoutMs, listEvents, limit = 500 }) {
    const ready = listEvents(projectId, afterSeq);
    if (ready.length > 0 || timeoutMs <= 0) return Promise.resolve(ready.slice(0, limit));
    return new Promise((resolve) => {
      let timer = null;
      const unsubscribe = subscribe({ projectId }, () => {
        clearTimeout(timer);
        unsubscribe();
        resolve(listEvents(projectId, afterSeq).slice(0, limit));
      }, 'waitForEvents');
      timer = setTimeout(() => {
        unsubscribe();
        resolve(listEvents(projectId, afterSeq).slice(0, limit));
      }, timeoutMs);
    });
  }

  return { subscribe, publish, waitForEvents, get size() { return subscribers.size; } };
}
