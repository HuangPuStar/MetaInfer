/**
 * Bounded exploration (QA Q6): an expert gets navigation tools, so it must also
 * get a budget, otherwise "look around the DAG" becomes an unbounded loop of
 * dag_query calls that costs more tokens than the work it saves.
 *
 * The budget is charged per query with the bytes actually returned (estimated
 * to tokens at 3.5 bytes/token, a deliberately conservative ratio) plus a
 * wall-clock deadline. Exhaustion returns an actionable code, never a throw.
 */

const DEFAULT_TOKEN_ESTIMATE = (bytes) => Math.ceil(bytes / 3.5);

/**
 * @param {object} [options]
 * @param {number} [options.maxQueries]
 * @param {number} [options.maxQueryTokens]
 * @param {number} [options.wallClockMs]
 * @param {() => number} [options.clock]
 * @param {(bytes: number) => number} [options.tokenEstimate]
 */
export function createExplorationBudget({
  // Adjudicated QA values (2026-11-10): a pass is cheap but bounded.
  maxQueries = 4,
  maxQueryTokens = 20_000,
  wallClockMs = 4 * 60 * 1000,
  clock = Date.now,
  tokenEstimate = DEFAULT_TOKEN_ESTIMATE,
} = {}) {
  const startedAt = clock();
  const used = { queries: 0, tokens: 0, bytes: 0 };
  let exhausted = null;

  /**
   * Charge one tool call.
   * @param {{ bytes?: number, queries?: number }} [cost]
   * @returns {{ok: true, used: object, remaining: object} | {ok: false, code: string, message: string, nextStep: string, used: object}}
   */
  function charge(cost = {}) {
    const queries = Number.isFinite(cost.queries) && cost.queries > 0 ? cost.queries : 1;
    const bytes = Number.isFinite(cost.bytes) && cost.bytes > 0 ? cost.bytes : 0;
    if (exhausted) return fail(exhausted, 'the exploration budget is already exhausted');
    const elapsedMs = Math.max(0, clock() - startedAt);
    if (elapsedMs >= wallClockMs) {
      exhausted = 'wall_clock';
      return fail(exhausted, `exploration wall clock exhausted (${elapsedMs} ms of ${wallClockMs} ms)`);
    }
    const nextQueries = used.queries + queries;
    const nextTokens = used.tokens + tokenEstimate(bytes);
    if (nextQueries > maxQueries) {
      exhausted = 'queries';
      return fail(exhausted, `exploration query budget exhausted (${used.queries} of ${maxQueries})`);
    }
    if (nextTokens > maxQueryTokens) {
      exhausted = 'tokens';
      return fail(exhausted, `exploration token budget exhausted (${used.tokens} of ${maxQueryTokens} estimated tokens)`);
    }
    used.queries = nextQueries;
    used.tokens = nextTokens;
    used.bytes += bytes;
    return { ok: true, used: { ...used, elapsedMs }, remaining: remaining(elapsedMs) };
  }

  function remaining(elapsedMs = Math.max(0, clock() - startedAt)) {
    return {
      queries: Math.max(0, maxQueries - used.queries),
      tokens: Math.max(0, maxQueryTokens - used.tokens),
      ms: Math.max(0, wallClockMs - elapsedMs),
    };
  }

  function fail(dimension, message) {
    return {
      ok: false,
      code: 'budget_exhausted',
      dimension,
      message,
      nextStep: 'Stop exploring. Decide from the current focus/ledger, or open a fresh expert pass (the budget resets per pass).',
      used: { ...used },
      remaining: remaining(),
    };
  }

  function state() {
    const elapsedMs = Math.max(0, clock() - startedAt);
    return { ...used, elapsedMs, exhausted, limits: { maxQueries, maxQueryTokens, wallClockMs }, remaining: remaining(elapsedMs) };
  }

  return { charge, state, remaining };
}

export { DEFAULT_TOKEN_ESTIMATE };
