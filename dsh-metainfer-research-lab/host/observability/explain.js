/**
 * Explainability (usability A1, observability B2).
 *
 * Every automated decision already writes a structured event with `causeId`,
 * `actor`, `basis` and `commit`. What was missing is a query surface: until now
 * the only way to answer "why did this node appear / start / fail / get held"
 * was to read the event table by hand.
 *
 * `explainNode` returns the cause chain and the node's recent events;
 * `traceExplain` returns the proposal -> approval -> dispatch -> run -> outcome
 * phases. Both are Host-computed, bounded by an event window, and return
 * machine-readable codes, never a log excerpt as the only answer.
 */

const MAX_CHAIN = 8;
const MAX_EVENTS = 40;
const DEFAULT_WINDOW = 500;

/** A short, structured summary of one event; never the free-text body. */
export function summarizeEvent(event) {
  const data = event?.data ?? {};
  const bits = [];
  if (data.from || data.to) bits.push(`${data.from ?? '?'}->${data.to ?? '?'}`);
  if (data.reason) bits.push(`reason=${String(data.reason).slice(0, 80)}`);
  if (data.code) bits.push(`code=${data.code}`);
  if (data.trigger) bits.push(`trigger=${data.trigger}`);
  if (data.nodeId) bits.push(`node=${data.nodeId}`);
  if (data.starts !== undefined) bits.push(`starts=${data.starts}`);
  if (data.created !== undefined) bits.push(`created=${data.created}`);
  return {
    seq: event?.seq ?? null,
    type: event?.type ?? null,
    at: event?.at ?? null,
    actor: event?.actor?.kind ?? null,
    actorId: event?.actor?.id ?? null,
    causeId: event?.causeId ?? null,
    activationId: event?.activationId ?? null,
    revision: event?.revision ?? null,
    commitId: event?.commit?.id ?? null,
    basis: event?.basis ?? null,
    detail: bits.join(' '),
  };
}

function parentsOf(node) {
  if (Array.isArray(node.parentIds) && node.parentIds.length > 0) return node.parentIds;
  return node.parentId ? [node.parentId] : [];
}

/**
 * @param {object} deps
 * @param {object} deps.store
 * @param {object} [deps.projection]
 * @param {() => number} [deps.clock]
 */
export function createExplainer({ store, projection = null, clock = Date.now }) {
  function loadNode(projectId, nodeId) {
    if (projection) {
      try {
        return projection.getNode(projectId, nodeId) ?? null;
      } catch {
        // projection not loaded: fall through to storage
      }
    }
    return store.getNode(projectId, nodeId) ?? null;
  }

  function recentEvents(projectId, nodeId, window) {
    const project = store.getProject(projectId);
    const latest = project?.counters?.eventSeq ?? 0;
    const after = Math.max(0, latest - window);
    const all = store.listEvents(projectId, after);
    const forNode = all.filter((event) => event.nodeId === nodeId);
    return { forNode, window: { afterSeq: after, latestSeq: latest, truncated: after > 0 } };
  }

  /** Walk causeId -> event -> causeId, bounded. */
  function causeChain(projectId, startCauseId, events, node) {
    const chain = [];
    const seen = new Set();
    let causeId = startCauseId ?? node?.causeId ?? null;
    const byCause = new Map();
    for (const event of events) {
      if (event.causeId) byCause.set(event.causeId, event);
      const dataCause = event?.data?.causeId;
      if (dataCause && !byCause.has(dataCause)) byCause.set(dataCause, event);
    }
    while (causeId && !seen.has(causeId) && chain.length < MAX_CHAIN) {
      seen.add(causeId);
      const event = byCause.get(causeId);
      chain.push({
        causeId,
        kind: event ? 'event' : 'unresolved',
        ref: event ? { seq: event.seq, type: event.type } : null,
        at: event?.at ?? null,
        summary: event ? summarizeEvent(event).detail : 'cause is older than the explain window',
      });
      causeId = event?.causeId ?? null;
    }
    return chain;
  }

  /**
   * @param {string} projectId
   * @param {string} nodeId
   * @param {{window?: number, eventLimit?: number}} [options]
   */
  function explainNode(projectId, nodeId, options = {}) {
    const node = loadNode(projectId, nodeId);
    if (!node) {
      return { ok: false, code: 'node_not_found', message: `node ${nodeId} does not exist`, nextStep: 'List nodes with dag_query or status_facts and pick an existing node id.' };
    }
    const window = Number.isFinite(options.window) ? Math.max(50, options.window) : DEFAULT_WINDOW;
    const { forNode, window: windowInfo } = recentEvents(projectId, nodeId, window);
    const events = forNode.slice(-MAX_EVENTS).map(summarizeEvent);
    const chain = causeChain(projectId, node.causeId ?? null, forNode, node);
    const parents = parentsOf(node).map((id) => {
      const parent = loadNode(projectId, id);
      return parent
        ? { nodeId: parent.id, title: parent.title ?? '', status: parent.status, causeId: parent.causeId ?? null }
        : { nodeId: id, missing: true };
    });
    return {
      ok: true,
      node: {
        nodeId: node.id,
        title: node.title ?? '',
        status: node.status,
        rev: node.rev ?? 0,
        attempt: node.attempt ?? 0,
        createdBy: node.createdBy ?? null,
        runId: node.runId ?? null,
        causeId: node.causeId ?? node.lastCauseId ?? null,
        createdAt: node.timestamps?.createdAt ?? null,
        updatedAt: node.timestamps?.updatedAt ?? null,
        priority: node.priority ?? null,
        error: typeof node.error === 'string' ? node.error.slice(0, 500) : (node.error?.message ?? null),
        dispatchHold: node.dispatchHold ?? null,
        review: node.review ?? null,
        leaseId: node.lease?.leaseId ?? null,
      },
      parents,
      causeChain: chain,
      events,
      _truncated: {
        events: forNode.length > events.length ? { shown: events.length, total: forNode.length } : null,
        window: windowInfo.truncated ? windowInfo : null,
        causeChain: chain.length >= MAX_CHAIN ? { shown: chain.length, total: null } : null,
      },
      generatedAt: clock(),
    };
  }

  /**
   * Walk one node from proposal to outcome.
   * @param {string} projectId
   * @param {string} nodeId
   * @param {{window?: number}} [options]
   */
  function traceExplain(projectId, nodeId, options = {}) {
    const explained = explainNode(projectId, nodeId, options);
    if (!explained.ok) return explained;
    const project = store.getProject(projectId);
    const latest = project?.counters?.eventSeq ?? 0;
    const after = Math.max(0, latest - (Number.isFinite(options.window) ? Math.max(50, options.window) : DEFAULT_WINDOW));
    const events = store.listEvents(projectId, after).filter((event) => event.nodeId === nodeId);
    const phases = [];
    const phase = (kind, event, detail) => phases.push({
      kind,
      at: event?.at ?? null,
      seq: event?.seq ?? null,
      actor: event?.actor?.kind ?? null,
      causeId: event?.causeId ?? null,
      commitId: event?.commit?.id ?? null,
      detail: detail ?? summarizeEvent(event).detail,
    });
    for (const event of events) {
      const data = event.data ?? {};
      const type = event.type;
      const to = data.to ?? null;
      if (type === 'node/created' || type === 'advisor/proposal') phase('proposal', event, `status=${data.status ?? 'planned'} createdBy=${data.createdBy ?? '?'}`);
      else if ((type === 'node/planned' || type === 'node/transition') && data.from === 'proposed') phase('approval', event);
      else if (type === 'node/claimed' || type === 'node/claim' || type === 'dispatch/committed') phase('dispatch', event);
      else if (type === 'node/started' || to === 'running') phase('start', event);
      else if (type === 'node/completed' || type === 'node/failed' || type === 'node/cancelled' || to === 'completed' || to === 'failed' || to === 'cancelled') phase('outcome', event);
      else if (type === 'dispatch/rejected' || type === 'dispatch/start_failed') phase('dispatch_blocked', event);
      else if (type === 'ledger/open' || type === 'ledger/confirm' || type === 'ledger/rule_out') phase('ledger', event);
      else if (type === 'review/claimed' || type === 'review/released') phase('review', event);
    }
    const runs = store.listRuns(projectId, 50);
    const relatedRuns = runs
      .filter((run) => run.id === explained.node.runId || (Array.isArray(run.createdNodeIds) && run.createdNodeIds.includes(nodeId)))
      .slice(0, 10)
      .map((run) => ({ runId: run.id, role: run.role, status: run.status, startedAt: run.startedAt ?? null, endedAt: run.endedAt ?? null, inputBytes: run.inputBytes ?? null }));
    return {
      ...explained,
      phases: phases.slice(0, 100),
      runs: relatedRuns,
      outcome: explained.node.status,
      _truncated: {
        ...explained._truncated,
        phases: phases.length > 100 ? { shown: 100, total: phases.length } : null,
      },
    };
  }

  return { explainNode, traceExplain };
}
