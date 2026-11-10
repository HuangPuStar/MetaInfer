/**
 * B16: resident expert sessions.
 *
 * A resident expert keeps one session for its whole activation and can call
 * tools more than once. `submit` is a tool (not a terminal structured-output
 * channel), so the Host can return tool results and let the expert revise
 * before submitting. The budget is enforced by this module, not by the prompt.
 */

export const RESIDENT_LIMITS = Object.freeze({
  maxQueries: 4,
  maxTokens: 20_000,
  wallClockMs: 240_000,
});

export const SUBMIT_TOOL = Object.freeze({
  name: 'submit',
  description: 'Submit the final review payload. This is a normal tool call; the session stays resident until the Host closes it.',
  inputSchema: Object.freeze({
    type: 'object',
    required: ['payload'],
    properties: { payload: { type: 'object' } },
    additionalProperties: false,
  }),
  terminal: true,
});

export const RESIDENT_TOOL_SURFACE = Object.freeze([
  SUBMIT_TOOL,
  Object.freeze({ name: 'dag_get', description: 'Read one node (raw data).', inputSchema: Object.freeze({ type: 'object', required: ['nodeId'], properties: { nodeId: { type: 'string' } } }) }),
  Object.freeze({ name: 'dag_query', description: 'Query the DAG under a bounded budget.', inputSchema: Object.freeze({ type: 'object', properties: { status: { type: 'string' }, limit: { type: 'number' } } }) }),
  Object.freeze({ name: 'dag_map', description: 'Read the compact DAG map.', inputSchema: Object.freeze({ type: 'object', properties: {} }) }),
  Object.freeze({ name: 'ledger_read', description: 'Read the judgement ledger.', inputSchema: Object.freeze({ type: 'object', properties: {} }) }),
]);

function estimateTokens(value) {
  return Math.ceil(Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value ?? null), 'utf8') / 4);
}

export function createResidentSession({
  expertId,
  sessionId = null,
  limits = {},
  clock = () => Date.now(),
  maxQueries = limits.maxQueries ?? RESIDENT_LIMITS.maxQueries,
  maxTokens = limits.maxTokens ?? RESIDENT_LIMITS.maxTokens,
  wallClockMs = limits.wallClockMs ?? RESIDENT_LIMITS.wallClockMs,
} = {}) {
  const startedAt = clock();
  let queries = 0;
  let tokens = 0;
  let submitted = null;
  let disposed = false;
  let compaction = null;
  const calls = [];
  const budget = {
    maxQueries: Math.max(1, Number(maxQueries) || RESIDENT_LIMITS.maxQueries),
    maxTokens: Math.max(1, Number(maxTokens) || RESIDENT_LIMITS.maxTokens),
    wallClockMs: Math.max(1, Number(wallClockMs) || RESIDENT_LIMITS.wallClockMs),
  };

  function expired() {
    return clock() - startedAt > budget.wallClockMs;
  }

  function snapshot() {
    return {
      expertId,
      sessionId,
      startedAt,
      elapsedMs: clock() - startedAt,
      queries,
      tokens,
      submitted: submitted !== null,
      disposed,
      budget: { ...budget, withinQueries: queries <= budget.maxQueries, withinTokens: tokens <= budget.maxTokens, withinWallClock: !expired() },
      calls: calls.slice(),
      compaction,
    };
  }

  async function invoke(tool, args = {}) {
    if (disposed) return { ok: false, code: 'session_disposed' };
    if (submitted !== null && tool !== 'submit') return { ok: false, code: 'already_submitted' };
    if (!RESIDENT_TOOL_SURFACE.some((entry) => entry.name === tool)) return { ok: false, code: 'unknown_tool', tool };
    if (expired()) return { ok: false, code: 'wall_clock_exceeded', snapshot: snapshot() };
    if (queries >= budget.maxQueries && tool !== 'submit') return { ok: false, code: 'query_budget_exceeded', snapshot: snapshot() };
    const cost = estimateTokens(args);
    if (tokens + cost > budget.maxTokens) return { ok: false, code: 'token_budget_exceeded', snapshot: snapshot() };
    queries += tool === 'submit' ? 0 : 1;
    tokens += cost;
    calls.push({ tool, at: clock(), tokens: cost });
    if (tool === 'submit') {
      const payload = args?.payload;
      if (payload === undefined || payload === null) return { ok: false, code: 'submit_payload_required' };
      submitted = payload;
      return { ok: true, tool, submitted: true, payload, snapshot: snapshot() };
    }
    return { ok: true, tool, result: null, snapshot: snapshot() };
  }

  /** Compaction keeps the durable facts and drops the raw tool transcript. */
  function compact({ facts = null } = {}) {
    const beforeTokens = tokens;
    const summary = {
      expertId,
      facts: facts ?? (submitted !== null ? { submittedKeys: Object.keys(submitted).slice(0, 20) } : { calls: calls.map((call) => call.tool) }),
      calls: calls.length,
      queries,
    };
    compaction = { at: clock(), beforeTokens, afterTokens: estimateTokens(summary), ratio: beforeTokens > 0 ? Number((beforeTokens / Math.max(1, estimateTokens(summary))).toFixed(2)) : null, summary };
    return compaction;
  }

  function dispose() {
    disposed = true;
    return snapshot();
  }

  return { expertId, sessionId, invoke, submit: (payload) => invoke('submit', { payload }), compact, snapshot, dispose, tools: RESIDENT_TOOL_SURFACE };
}

/**
 * Drive a deterministic tool loop. Every iteration is a tool call; the loop
 * only exits when submit succeeds, the budget is exhausted, or `steps` runs out.
 */
export async function runResidentLoop({ session, steps = [], maxSteps = 8 } = {}) {
  const results = [];
  if (!session) return { ok: false, code: 'session_required', results };
  for (const step of steps.slice(0, maxSteps)) {
    const outcome = await session.invoke(step?.tool, step?.args ?? {});
    results.push(outcome);
    if (outcome?.submitted) return { ok: true, submitted: outcome.payload, results, snapshot: session.snapshot() };
    if (!outcome?.ok) return { ok: false, code: outcome?.code ?? 'tool_failed', results, snapshot: session.snapshot() };
  }
  return { ok: false, code: 'no_submit', results, snapshot: session.snapshot() };
}
