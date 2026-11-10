/**
 * Hypothesis ledger: the shared, durable record of what the lab believes and
 * what it has ruled out (design decision B17, QA Q6).
 *
 * Without it every advisor pass re-proposes hypotheses that were already
 * disproved, because the only memory was the node table. The ledger is an
 * event-sourced projection: `ledger/open|confirm|rule_out` events are the
 * authority, `ledgerView()` is derived (B3: derived data is never persisted as
 * a second copy).
 *
 * Only ids, short text and evidence **pointers** are stored (G3): a pointer is
 * `{kind:'node'|'run'|'commit'|'metric'|'url', ref, note?}`, never a log body.
 */

const MAX_OPEN = 200;
const MAX_CLOSED = 500;
const MAX_TEXT = 2_000;

function clampText(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return '';
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function normalizePointer(pointer, index = 0) {
  if (!pointer || typeof pointer !== 'object') return null;
  const kind = ['node', 'run', 'commit', 'metric', 'url', 'event'].includes(pointer.kind) ? pointer.kind : 'event';
  const ref = clampText(pointer.ref ?? pointer.id ?? pointer.url ?? '', 500);
  if (!ref) return null;
  return {
    id: clampText(pointer.id ?? `ev-${index}`, 80),
    kind,
    ref,
    ...(pointer.note ? { note: clampText(pointer.note, 300) } : {}),
  };
}

/** @returns {Map<string, object>} empty ledger state */
export function emptyLedger() {
  return new Map();
}

/**
 * Apply one ledger event to a ledger state. Pure; unknown events are ignored so
 * an older reader cannot crash on a newer event type.
 * @param {Map<string, object>} state
 * @param {object} event
 */
export function applyLedgerEvent(state, event) {
  const type = event?.type;
  const data = event?.data ?? {};
  const at = Number.isFinite(event?.at) ? event.at : (Number.isFinite(event?.timestamps?.at) ? event.timestamps.at : null);
  const id = typeof data.id === 'string' ? data.id : null;
  if (type === 'ledger/open') {
    if (!id || state.has(id)) return state;
    if (state.size >= MAX_OPEN + MAX_CLOSED) {
      // Evict the oldest ruled-out entry, never an open one.
      const oldestClosed = [...state.values()]
        .filter((entry) => entry.state !== 'open')
        .sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0))[0];
      if (oldestClosed) state.delete(oldestClosed.id);
    }
    state.set(id, {
      id,
      hypothesis: clampText(data.hypothesis ?? data.text ?? ''),
      state: 'open',
      evidence: (Array.isArray(data.evidence) ? data.evidence : []).map(normalizePointer).filter(Boolean),
      nodeId: typeof data.nodeId === 'string' ? data.nodeId : null,
      expertId: typeof data.expertId === 'string' ? data.expertId : null,
      createdAt: at,
      updatedAt: at,
      revision: Number.isFinite(event?.revision) ? event.revision : null,
    });
    return state;
  }
  if (!id) return state;
  const entry = state.get(id);
  if (!entry) return state;
  if (type === 'ledger/confirm') {
    entry.state = 'confirmed';
    entry.updatedAt = at;
    entry.revision = Number.isFinite(event?.revision) ? event.revision : entry.revision;
    entry.evidence = [...entry.evidence, ...(Array.isArray(data.evidence) ? data.evidence : []).map(normalizePointer).filter(Boolean)];
    if (data.note) entry.note = clampText(data.note, 1_000);
    return state;
  }
  if (type === 'ledger/rule_out') {
    entry.state = 'ruled_out';
    entry.updatedAt = at;
    entry.revision = Number.isFinite(event?.revision) ? event.revision : entry.revision;
    entry.reason = clampText(data.reason ?? '', 1_000);
    entry.evidence = [...entry.evidence, ...(Array.isArray(data.evidence) ? data.evidence : []).map(normalizePointer).filter(Boolean)];
    if (data.supersededBy) entry.supersededBy = String(data.supersededBy).slice(0, 120);
    return state;
  }
  return state;
}

/**
 * Build a bounded, prompt-ready view. Truncation is explicit (B25).
 * @param {Map<string, object>} state
 * @param {{ open?: number, confirmed?: number, ruledOut?: number, evidence?: number }} [limits]
 */
export function ledgerView(state, limits = {}) {
  const maxOpen = limits.open ?? 10;
  const maxConfirmed = limits.confirmed ?? 5;
  const maxRuledOut = limits.ruledOut ?? 10;
  const maxEvidence = limits.evidence ?? 3;
  const entries = [...state.values()];
  const sort = (list) => list.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const trim = (entry) => ({
    id: entry.id,
    hypothesis: entry.hypothesis,
    nodeId: entry.nodeId,
    expertId: entry.expertId,
    updatedAt: entry.updatedAt,
    ...(entry.reason ? { reason: entry.reason } : {}),
    ...(entry.note ? { note: entry.note } : {}),
    evidence: entry.evidence.slice(-maxEvidence),
    ...(entry.evidence.length > maxEvidence ? { evidenceTruncated: { shown: maxEvidence, total: entry.evidence.length } } : {}),
  });
  const open = sort(entries.filter((entry) => entry.state === 'open'));
  const confirmed = sort(entries.filter((entry) => entry.state === 'confirmed'));
  const ruledOut = sort(entries.filter((entry) => entry.state === 'ruled_out'));
  return {
    counts: { open: open.length, confirmed: confirmed.length, ruledOut: ruledOut.length, total: entries.length },
    open: open.slice(0, maxOpen).map(trim),
    confirmed: confirmed.slice(0, maxConfirmed).map(trim),
    ruledOut: ruledOut.slice(0, maxRuledOut).map(trim),
    _truncated: {
      open: open.length > maxOpen ? { shown: maxOpen, total: open.length } : null,
      confirmed: confirmed.length > maxConfirmed ? { shown: maxConfirmed, total: confirmed.length } : null,
      ruledOut: ruledOut.length > maxRuledOut ? { shown: maxRuledOut, total: ruledOut.length } : null,
    },
  };
}

/**
 * Incremental ledger reader: keeps one ledger per project and only consumes
 * events after the last seen sequence (no full replay on every prompt).
 * @param {{ store: object, clock?: () => number }} deps
 */
export function createLedgerReader({ store, maxProjects = 64 }) {
  const cache = new Map(); // projectId -> { state, cursor }

  function projectEntry(projectId) {
    let entry = cache.get(projectId);
    if (!entry) {
      entry = { state: emptyLedger(), cursor: 0 };
      if (cache.size >= maxProjects) cache.delete(cache.keys().next().value);
      cache.set(projectId, entry);
    }
    return entry;
  }

  function sync(projectId) {
    const entry = projectEntry(projectId);
    const events = store.listEvents(projectId, entry.cursor);
    for (const event of events) {
      if (typeof event.type === 'string' && event.type.startsWith('ledger/')) {
        applyLedgerEvent(entry.state, { ...event, at: event.at ?? event.timestamps?.at ?? event.timestamp });
      }
      entry.cursor = Math.max(entry.cursor, event.seq ?? 0);
    }
    return entry.state;
  }

  return {
    state: (projectId) => sync(projectId),
    view: (projectId, limits) => ledgerView(sync(projectId), limits),
    invalidate: (projectId) => { cache.delete(projectId); },
    cursor: (projectId) => projectEntry(projectId).cursor,
  };
}
