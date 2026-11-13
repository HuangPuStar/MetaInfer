/**
 * Advisor/scheduler context payload (QA Q6, design decision B25).
 *
 * The old snapshot inlined every node, every candidate parent and the whole
 * report into the prompt; at a few hundred nodes it blew the context budget and
 * the advisor started truncating silently. This module builds a **bounded**
 * payload instead:
 *
 *   project   identity + a <=1500 char brief (not the whole config)
 *   budget    what is left, so the advisor can throttle itself
 *   focus     <=8 active leaves, with priority and a machine-readable reason
 *   running   what occupies the GPUs, with elapsed / lastActivity
 *   failures  <=5 recent failures with the error and cause pointer
 *   ledger    open / confirmed / ruled out hypotheses (bounded)
 *   index     counts only; navigation goes through dag_query / dag_get
 *
 * `_truncated` markers are always explicit ({shown,total}) so a reader can tell
 * the difference between "there are 3 failures" and "there are 3 shown of 41".
 * The byte budget is enforced by dropping decorative sections first; the final
 * fallback keeps identity, budget and counts.
 */

export const CONTEXT_BUDGET_BYTES = 12 * 1024;

export const DEFAULT_CONTEXT_LIMITS = Object.freeze({
  brief: 1_500,
  goal: 600,
  focus: 8,
  running: 6,
  failures: 5,
  errorChars: 300,
  ledgerOpen: 8,
  ledgerConfirmed: 4,
  ledgerRuledOut: 6,
  evidence: 2,
  maxBytes: CONTEXT_BUDGET_BYTES,
});

const ACTIVE_STATUSES = new Set(['planned', 'running', 'failed', 'proposed']);

function text(value, max) {
  if (typeof value !== 'string') return '';
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

function parentsOf(node) {
  if (Array.isArray(node.parentIds) && node.parentIds.length > 0) return node.parentIds;
  return node.parentId ? [node.parentId] : [];
}

function childCounts(nodes) {
  const counts = new Map();
  for (const node of nodes) {
    if (node.status === 'proposed') continue;
    for (const parentId of parentsOf(node)) counts.set(parentId, (counts.get(parentId) ?? 0) + 1);
  }
  return counts;
}

/** Resolve the human brief: explicit config first, then title/goal. */
export function projectBrief(project, max = 1_500) {
  const config = project?.config ?? {};
  const raw = config.brief ?? config.summary ?? config.goal ?? '';
  const fallback = [project?.title, config.goal].filter((value) => typeof value === 'string' && value.trim()).join('\n');
  return text((raw || fallback || '').trim(), max);
}

/** Local capacity view; cluster free counts are folded in by the caller when known. */
function resourcesView(project, nodes) {
  const held = {};
  let runningCount = 0;
  for (const node of nodes) {
    if (node.status !== 'running') continue;
    runningCount += 1;
    for (const [key, amount] of Object.entries(node.resourcesHeld ?? {})) held[key] = (held[key] ?? 0) + amount;
  }
  const pools = project?.config?.resourcePools ?? {};
  return {
    pools,
    held,
    free: Object.fromEntries(Object.entries(pools).map(([key, total]) => [key, Math.max(0, total - (held[key] ?? 0))])),
    maxRunningNodes: project?.config?.maxRunningNodes ?? 4,
    runningCount,
  };
}

function budgetView(project, now) {
  const auto = project?.config?.auto ?? {};
  const counters = project?.counters ?? {};
  const startedAt = Number.isFinite(auto.startedAt) ? auto.startedAt : (Number.isFinite(project?.timestamps?.startedAt) ? project.timestamps.startedAt : null);
  return {
    maxTokens: auto.maxTokens ?? 0,
    tokensUsed: Math.round(counters.tokensUsed ?? 0),
    maxCostUsd: auto.maxCostUsd ?? 0,
    costUsed: Number((counters.costUsd ?? 0).toFixed(4)),
    maxCycles: auto.maxCycles ?? 50,
    cycles: Math.round(counters.cycles ?? 0),
    maxWallClockMs: auto.maxWallClockMs ?? 6 * 60 * 60 * 1000,
    elapsedMs: startedAt ? Math.max(0, now - startedAt) : 0,
  };
}

function focusReason(node) {
  if (node.status === 'running') return 'running';
  if (node.status === 'proposed') return 'awaiting_approval';
  if (node.status === 'failed') return 'failed_needs_decision';
  if (node.dispatchHold) return 'dispatch_hold';
  return 'next_by_priority';
}

function focusRow(node) {
  return {
    id: node.id,
    title: text(node.title ?? '', 160),
    status: node.status,
    why: focusReason(node),
    priority: { class: node.priority?.class ?? 'p2', score: Number(node.priority?.score ?? 0) },
    parentIds: parentsOf(node),
    needs: node.needs ?? {},
    timeboxMs: node.timeboxMs ?? null,
    rev: node.rev ?? 0,
  };
}

function runningRow(node, now) {
  const startedAt = node.timestamps?.startedAt ?? node.startedAt ?? null;
  const lastActivity = node.timestamps?.lastActivityAt ?? node.lastEventAt ?? startedAt;
  return {
    id: node.id,
    title: text(node.title ?? '', 120),
    elapsedMs: startedAt ? Math.max(0, now - startedAt) : null,
    lastActivityMs: lastActivity ? Math.max(0, now - lastActivity) : null,
    attempt: node.attempt ?? 0,
    needs: node.needs ?? {},
  };
}

function failureRow(node, maxError) {
  return {
    id: node.id,
    title: text(node.title ?? '', 120),
    error: text(node.error ?? node.lastError ?? '', maxError),
    causeId: node.causeId ?? node.lastCauseId ?? null,
    finishedAt: node.timestamps?.finishedAt ?? node.finishedAt ?? null,
    attempts: node.attempt ?? 0,
  };
}

/** Re-bound an incoming ledger view to the payload's own limits (B25). */
export function boundedLedger(view, limits) {
  const counts = view?.counts ?? { open: 0, confirmed: 0, ruledOut: 0, total: 0 };
  const pick = (list, max) => (Array.isArray(list) ? list.slice(0, max) : []);
  const open = pick(view?.open, limits.ledgerOpen);
  const confirmed = pick(view?.confirmed, limits.ledgerConfirmed);
  const ruledOut = pick(view?.ruledOut, limits.ledgerRuledOut);
  return {
    counts,
    open,
    confirmed,
    ruledOut,
    _truncated: {
      open: counts.open > open.length ? { shown: open.length, total: counts.open } : null,
      confirmed: counts.confirmed > confirmed.length ? { shown: confirmed.length, total: counts.confirmed } : null,
      ruledOut: counts.ruledOut > ruledOut.length ? { shown: ruledOut.length, total: counts.ruledOut } : null,
    },
  };
}

/**
 * Compute the DAG depth per node (memoised, O(nodes + edges)).
 * @returns {{ maxDepth: number, depth: Map<string, number> }}
 */
export function dagDepth(nodes) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const depth = new Map();
  const visiting = new Set();
  function depthOf(node) {
    if (depth.has(node.id)) return depth.get(node.id);
    if (visiting.has(node.id)) return 0; // cycle guard; should not happen
    visiting.add(node.id);
    const parents = parentsOf(node).filter((id) => byId.has(id));
    const value = parents.length === 0 ? 0 : 1 + Math.max(...parents.map((id) => depthOf(byId.get(id))));
    visiting.delete(node.id);
    depth.set(node.id, value);
    return value;
  }
  for (const node of nodes) depthOf(node);
  let maxDepth = 0;
  for (const value of depth.values()) maxDepth = Math.max(maxDepth, value);
  return { maxDepth, depth };
}

/**
 * @param {object} input
 * @param {object} input.project
 * @param {object[]} input.nodes
 * @param {object} [input.ledger] output of ledgerView()
 * @param {number} [input.now]
 * @param {object} [input.limits]
 */
export function buildContextPayload({ project, nodes = [], ledger = null, now = Date.now(), limits = {} }) {
  const config = { ...DEFAULT_CONTEXT_LIMITS, ...limits };
  const counts = {};
  for (const node of nodes) counts[node.status] = (counts[node.status] ?? 0) + 1;
  const children = childCounts(nodes);
  const running = nodes.filter((node) => node.status === 'running')
    .sort((a, b) => (b.timestamps?.startedAt ?? 0) - (a.timestamps?.startedAt ?? 0));
  const active = nodes
    .filter((node) => ACTIVE_STATUSES.has(node.status) && (node.status === 'running' || (children.get(node.id) ?? 0) === 0))
    .sort((a, b) => {
      const rank = { running: 0, proposed: 1, planned: 2, failed: 3 };
      const byRank = (rank[a.status] ?? 4) - (rank[b.status] ?? 4);
      if (byRank !== 0) return byRank;
      const byClass = String(a.priority?.class ?? 'p2').localeCompare(String(b.priority?.class ?? 'p2'));
      if (byClass !== 0) return byClass;
      return (a.timestamps?.createdAt ?? 0) - (b.timestamps?.createdAt ?? 0);
    });
  const failed = nodes
    .filter((node) => node.status === 'failed')
    .sort((a, b) => (b.timestamps?.finishedAt ?? b.finishedAt ?? 0) - (a.timestamps?.finishedAt ?? a.finishedAt ?? 0));
  const { maxDepth } = dagDepth(nodes);

  const focus = active.slice(0, config.focus).map(focusRow);
  const payload = {
    project: {
      id: project?.id ?? null,
      title: text(project?.title ?? '', 200),
      mode: project?.mode ?? 'manual',
      brief: projectBrief(project, config.brief),
      tags: Array.isArray(project?.config?.tags) ? project.config.tags.slice(0, 12) : [],
      revision: project?.revision ?? 0,
      rootNodeId: project?.rootNodeId ?? project?.config?.rootNodeId ?? null,
    },
    budget: budgetView(project, now),
    resources: resourcesView(project, nodes),
    focus,
    running: running.slice(0, config.running).map((node) => runningRow(node, now)),
    recentFailures: failed.slice(0, config.failures).map((node) => failureRow(node, config.errorChars)),
    ledger: boundedLedger(ledger, config),
    index: { counts, total: nodes.length, maxDepth },
    _truncated: {
      focus: active.length > config.focus ? { shown: focus.length, total: active.length } : null,
      running: running.length > config.running ? { shown: config.running, total: running.length } : null,
      recentFailures: failed.length > config.failures ? { shown: config.failures, total: failed.length } : null,
    },
    guidance: {
      navigation: 'This payload is intentionally incomplete. Use dag_query (status / subtreeOf / depth / since / text) and dag_get(nodeIds) for anything not in focus.',
      propose: 'Propose successors only for completed leaves in focus or found via dag_query; a parent with children cannot be extended.',
    },
  };
  return enforceByteBudget(payload, config.maxBytes);
}

/** @returns {number} UTF-8 bytes of the serialized payload. */
export function payloadBytes(payload) {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

/**
 * Drop decorative sections until the payload fits. Ordered so the advisor
 * loses history before it loses the work it must decide on (B25 explicit
 * truncation, never silent).
 * @param {object} payload
 * @param {number} maxBytes
 */
export function enforceByteBudget(payload, maxBytes = CONTEXT_BUDGET_BYTES) {
  if (payloadBytes(payload) <= maxBytes) return payload;
  const out = structuredClone(payload);
  out._truncated = out._truncated ?? {};
  const mark = (key, shown, total) => {
    out._truncated[key] = { shown, total };
  };
  const stages = [
    () => { const total = out.ledger?.ruledOut?.length ?? 0; out.ledger.ruledOut = []; mark('ledger.ruledOut', 0, total); },
    () => { const total = out.recentFailures.length; out.recentFailures = out.recentFailures.slice(0, 2); mark('recentFailures', out.recentFailures.length, total); },
    () => { const total = out.ledger?.confirmed?.length ?? 0; out.ledger.confirmed = []; mark('ledger.confirmed', 0, total); },
    () => { const total = out.focus.length; out.focus = out.focus.slice(0, Math.min(4, total)); mark('focus', out.focus.length, total); },
    () => { const total = out.running.length; out.running = out.running.slice(0, 2); mark('running', out.running.length, total); },
    () => { const total = out.project.brief.length; out.project.brief = text(out.project.brief, 400); mark('project.brief', out.project.brief.length, total); },
    () => {
      const total = out.focus.length;
      out.focus = [];
      mark('focus', 0, total);
      out.ledger.open = [];
      out.recentFailures = [];
      out.budget = { maxTokens: out.budget?.maxTokens ?? 0, tokensUsed: out.budget?.tokensUsed ?? 0 };
      out._truncated.full = true;
    },
  ];
  for (const stage of stages) {
    stage();
    if (payloadBytes(out) <= maxBytes) return out;
  }
  // Last resort: identity, counts and budget only. Never return an oversized
  // payload just because the caller asked for an impossible budget.
  const minimal = {
    project: { id: out.project?.id ?? null, title: text(out.project?.title ?? '', 120) },
    index: { counts: out.index?.counts ?? {}, total: out.index?.total ?? 0 },
    budget: { maxTokens: out.budget?.maxTokens ?? 0, tokensUsed: out.budget?.tokensUsed ?? 0 },
    _truncated: { ...out._truncated, full: true },
  };
  if (payloadBytes(minimal) <= maxBytes) return minimal;
  return { project: { id: out.project?.id ?? null }, index: { total: out.index?.total ?? 0 }, _truncated: { full: true } };
}
