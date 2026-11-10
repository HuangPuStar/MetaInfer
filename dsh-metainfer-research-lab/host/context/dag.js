/**
 * Composable DAG reads (QA Q6): `dag_query` and `dag_get`.
 *
 * The context payload must stay small, so navigation is a separate, explicit
 * call. Queries are bounded (default 50, hard max 200) and cursor-paginated:
 * a cursor is an opaque base64 JSON with the filter signature, so a cursor
 * reused with a different filter fails loudly instead of silently skipping.
 *
 * These functions scan the node array; that is deliberate and acceptable
 * because they are operator/expert-driven reads, not the 2s hot path (the hot
 * path uses the projection indexes). The scan is O(n) once per query.
 */
import { createHash } from 'node:crypto';

export const DEFAULT_QUERY_LIMIT = 50;
export const MAX_QUERY_LIMIT = 200;
export const MAX_GET_IDS = 50;
/** Hard response budgets for the coarse map/walk views (B15). */
export const DAG_MAP_MAX_BYTES = 6 * 1024;
export const DAG_WALK_MAX_BYTES = 24 * 1024;
const DIFF_HISTORY = 16;

const ROW_FIELDS = ['id', 'title', 'status', 'priority', 'parentIds', 'rev', 'needs', 'timestamps', 'git', 'error', 'review', 'attempt', 'lease', 'dispatchHold', 'source'];
const DEFAULT_SELECT = ['id', 'title', 'status', 'priority', 'parentIds', 'rev'];

function parentsOf(node) {
  if (Array.isArray(node.parentIds) && node.parentIds.length > 0) return node.parentIds;
  return node.parentId ? [node.parentId] : [];
}

function hashOf(value) {
  return createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function encodeCursor(offset, signature) {
  return Buffer.from(JSON.stringify({ o: offset, s: signature }), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (!Number.isInteger(parsed.o) || parsed.o < 0 || typeof parsed.s !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Normalize a select list against the allowed fields. */
export function normalizeSelect(select) {
  if (!Array.isArray(select) || select.length === 0) return DEFAULT_SELECT;
  const wanted = select.filter((field) => ROW_FIELDS.includes(field));
  const out = wanted.length > 0 ? wanted : DEFAULT_SELECT;
  return out.includes('id') ? out : ['id', ...out];
}

/** Project a node to the selected fields (compact, no undefined keys). */
export function projectRow(node, select = DEFAULT_SELECT) {
  const row = {};
  for (const field of select) {
    if (field === 'parentIds') row.parentIds = parentsOf(node);
    else if (field === 'title') row.title = typeof node.title === 'string' ? node.title.slice(0, 300) : '';
    else if (field === 'error') row.error = typeof node.error === 'string' ? node.error.slice(0, 500) : (node.error ?? '');
    else if (node[field] !== undefined) row[field] = node[field];
  }
  return row;
}

/**
 * @param {object} input
 * @param {object[]} input.nodes
 * @param {object} [input.filter]
 * @param {string[]} [input.select]
 * @param {number} [input.limit]
 * @param {string|null} [input.cursor]
 * @param {'created'|'recent'|'priority'} [input.order]
 */
export function queryDag({ nodes, filter = {}, select, limit = DEFAULT_QUERY_LIMIT, cursor = null, order = 'created' }) {
  const signature = hashOf({ filter, order, select: normalizeSelect(select) });
  const offset = cursor ? decodeCursor(cursor) : null;
  if (cursor && (!offset || offset.s !== signature)) {
    return { ok: false, code: 'invalid_cursor', message: 'cursor was issued for a different query; restart without a cursor' };
  }
  const max = Math.max(1, Math.min(MAX_QUERY_LIMIT, Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_QUERY_LIMIT));
  const fields = normalizeSelect(select);
  const byId = new Map(nodes.map((node) => [node.id, node]));

  let pool = nodes;
  if (Array.isArray(filter.status) && filter.status.length > 0) {
    const allowed = new Set(filter.status);
    pool = pool.filter((node) => allowed.has(node.status));
  }
  if (filter.parentId) pool = pool.filter((node) => parentsOf(node).includes(filter.parentId));
  if (filter.text) {
    const needle = String(filter.text).toLowerCase();
    pool = pool.filter((node) => `${node.title ?? ''}\n${node.prompt ?? ''}\n${node.error ?? ''}`.toLowerCase().includes(needle));
  }
  if (Number.isFinite(filter.since)) pool = pool.filter((node) => (node.timestamps?.updatedAt ?? node.timestamps?.createdAt ?? 0) >= filter.since);
  if (filter.subtreeOf) {
    const wanted = new Set([filter.subtreeOf]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of nodes) {
        if (wanted.has(node.id)) continue;
        if (parentsOf(node).some((parentId) => wanted.has(parentId))) {
          wanted.add(node.id);
          changed = true;
        }
      }
    }
    pool = pool.filter((node) => wanted.has(node.id));
  }
  if (filter.depth && (Number.isFinite(filter.depth.min) || Number.isFinite(filter.depth.max))) {
    const depth = new Map();
    const visiting = new Set();
    const depthOf = (node) => {
      if (depth.has(node.id)) return depth.get(node.id);
      if (visiting.has(node.id)) return 0;
      visiting.add(node.id);
      const parents = parentsOf(node).filter((id) => byId.has(id));
      const value = parents.length === 0 ? 0 : 1 + Math.max(...parents.map((id) => depthOf(byId.get(id))));
      visiting.delete(node.id);
      depth.set(node.id, value);
      return value;
    };
    for (const node of nodes) depthOf(node);
    pool = pool.filter((node) => {
      const value = depth.get(node.id) ?? 0;
      if (Number.isFinite(filter.depth.min) && value < filter.depth.min) return false;
      if (Number.isFinite(filter.depth.max) && value > filter.depth.max) return false;
      return true;
    });
  }

  const sorted = [...pool];
  if (order === 'recent') sorted.sort((a, b) => (b.timestamps?.createdAt ?? 0) - (a.timestamps?.createdAt ?? 0) || a.id.localeCompare(b.id));
  else if (order === 'priority') {
    sorted.sort((a, b) => String(a.priority?.class ?? 'p2').localeCompare(String(b.priority?.class ?? 'p2'))
      || Number(b.priority?.score ?? 0) - Number(a.priority?.score ?? 0)
      || (a.timestamps?.createdAt ?? 0) - (b.timestamps?.createdAt ?? 0));
  } else sorted.sort((a, b) => (a.timestamps?.createdAt ?? 0) - (b.timestamps?.createdAt ?? 0) || a.id.localeCompare(b.id));

  const start = offset?.o ?? 0;
  const page = sorted.slice(start, start + max).map((node) => projectRow(node, fields));
  const next = start + page.length;
  return {
    ok: true,
    nodes: page,
    total: sorted.length,
    nextCursor: next < sorted.length ? encodeCursor(next, signature) : null,
    truncated: { shown: page.length, total: sorted.length },
  };
}

/**
 * Fetch specific nodes plus one hop of context. Missing ids are reported, never
 * silently dropped.
 * @param {object} input
 * @param {object[]} input.nodes
 * @param {string[]} input.nodeIds
 * @param {string[]} [input.select]
 * @param {boolean} [input.neighbors] include direct parents and children
 */
export function dagGet({ nodes, nodeIds, select, neighbors = true }) {
  const fields = normalizeSelect(select);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map();
  for (const node of nodes) {
    for (const parentId of parentsOf(node)) {
      if (!children.has(parentId)) children.set(parentId, []);
      children.get(parentId).push(node.id);
    }
  }
  const requested = [...new Set((Array.isArray(nodeIds) ? nodeIds : []).filter((id) => typeof id === 'string'))];
  if (requested.length === 0) return { ok: false, code: 'missing_ids', message: 'nodeIds must contain at least one node id' };
  if (requested.length > MAX_GET_IDS) return { ok: false, code: 'too_many_ids', message: `at most ${MAX_GET_IDS} node ids per call` };
  const found = requested.filter((id) => byId.has(id));
  const missing = requested.filter((id) => !byId.has(id));
  const out = { ok: true, nodes: found.map((id) => projectRow(byId.get(id), fields)), missing };
  if (neighbors) {
    const parentRows = [];
    const childRows = [];
    const seen = new Set();
    for (const id of found) {
      for (const parentId of parentsOf(byId.get(id))) {
        if (seen.has(`p:${parentId}`) || !byId.has(parentId)) continue;
        seen.add(`p:${parentId}`);
        parentRows.push(projectRow(byId.get(parentId), fields));
      }
      for (const childId of children.get(id) ?? []) {
        if (seen.has(`c:${childId}`)) continue;
        seen.add(`c:${childId}`);
        childRows.push(projectRow(byId.get(childId), fields));
      }
    }
    out.parents = parentRows;
    out.children = childRows;
  }
  return out;
}

/** Direct children index (used by dag_walk / explain). */
export function childrenIndex(nodes) {
  const map = new Map();
  for (const node of nodes) {
    for (const parentId of parentsOf(node)) {
      if (!map.has(parentId)) map.set(parentId, []);
      map.get(parentId).push(node.id);
    }
  }
  return map;
}

/**
 * Group nodes for a coarse map (dag_map). Bounded: each bucket lists at most
 * `sample` ids and reports the full count, so a 5,000-node DAG returns a map,
 * not a dump.
 * @param {object} input
 * @param {object[]} input.nodes
 * @param {'status'|'depth'|'owner'|'parent'} [input.by]
 * @param {number} [input.sample]
 */
export function mapDag({ nodes, by = 'status', sample = 5, maxBytes = DAG_MAP_MAX_BYTES }) {
  const groups = new Map();
  let depth = null;
  if (by === 'depth') {
    depth = new Map();
    const visiting = new Set();
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const depthOf = (node) => {
      if (depth.has(node.id)) return depth.get(node.id);
      if (visiting.has(node.id)) return 0;
      visiting.add(node.id);
      const parents = parentsOf(node).filter((id) => byId.has(id));
      const value = parents.length === 0 ? 0 : 1 + Math.max(...parents.map((id) => depthOf(byId.get(id))));
      visiting.delete(node.id);
      depth.set(node.id, value);
      return value;
    };
    for (const node of nodes) depthOf(node);
  }
  for (const node of nodes) {
    const key = by === 'status' ? node.status
      : by === 'depth' ? String(depth.get(node.id) ?? 0)
        : by === 'owner' ? (node.createdBy ?? node.source?.expertId ?? 'unknown')
          : (parentsOf(node)[0] ?? 'root');
    if (!groups.has(key)) groups.set(key, { key, count: 0, sample: [], statuses: {} });
    const group = groups.get(key);
    group.count += 1;
    group.statuses[node.status] = (group.statuses[node.status] ?? 0) + 1;
    if (group.sample.length < sample) group.sample.push(node.id);
  }
  const sorted = [...groups.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const build = (kept, truncated) => ({
    ok: true,
    by,
    groups: kept,
    total: nodes.length,
    _truncated: truncated,
  });
  const fit = fitPrefix(sorted, maxBytes, (kept) => build(kept, kept.length < sorted.length
    ? { groups: { shown: kept.length, total: sorted.length } }
    : null));
  let kept = fit.kept;
  let truncated = kept.length < sorted.length
    ? { groups: { shown: kept.length, total: sorted.length }, bytes: { max: maxBytes, used: fit.bytes } }
    : null;
  let result = build(kept, truncated);
  // `bytes.used` itself costs a few bytes; trim until the final envelope fits.
  while (truncated && Buffer.byteLength(JSON.stringify(result)) > maxBytes && kept.length > 0) {
    kept = kept.slice(0, -1);
    truncated = kept.length < sorted.length
      ? { groups: { shown: kept.length, total: sorted.length }, bytes: { max: maxBytes, used: 0 } }
      : null;
    result = build(kept, truncated);
  }
  if (truncated) truncated.bytes.used = Buffer.byteLength(JSON.stringify(result));
  return result;
}

/**
 * Largest prefix of `items` whose serialized envelope is <= `maxBytes`.
 * `build(kept)` must include the truncation metadata for `kept.length` so the
 * budget covers the envelope callers actually receive, not just the payload.
 */
function fitPrefix(items, maxBytes, build) {
  let low = 0;
  let high = items.length;
  let best = 0;
  let bytes = Buffer.byteLength(JSON.stringify(build([])));
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = build(items.slice(0, mid));
    const size = Buffer.byteLength(JSON.stringify(candidate));
    if (size <= maxBytes) {
      best = mid;
      bytes = size;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return { kept: items.slice(0, best), bytes };
}

/**
 * Bounded walk (dag_walk): BFS from one node, up or down, with an explicit
 * node cap. Returns nodes and the edges traversed.
 * @param {object} input
 * @param {object[]} input.nodes
 * @param {string} input.from
 * @param {'down'|'up'} [input.direction]
 * @param {number} [input.depth]
 * @param {number} [input.limit]
 */
export function walkDag({ nodes, from, direction = 'down', depth = 3, limit = MAX_QUERY_LIMIT, maxBytes = DAG_WALK_MAX_BYTES }) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (!byId.has(from)) return { ok: false, code: 'node_not_found', message: `node ${from} does not exist` };
  const children = childrenIndex(nodes);
  const parents = new Map();
  for (const node of nodes) parents.set(node.id, parentsOf(node));
  const maxDepth = Math.max(1, Math.min(20, Number.isFinite(depth) ? depth : 3));
  const maxNodes = Math.max(1, Math.min(MAX_QUERY_LIMIT, Number.isFinite(limit) ? limit : MAX_QUERY_LIMIT));
  const seen = new Set([from]);
  const edges = [];
  let frontier = [from];
  let level = 0;
  let truncated = false;
  while (frontier.length > 0 && level < maxDepth && seen.size < maxNodes) {
    const next = [];
    for (const id of frontier) {
      const neighbors = direction === 'up' ? (parents.get(id) ?? []) : (children.get(id) ?? []);
      for (const neighbor of neighbors) {
        if (!byId.has(neighbor)) continue;
        edges.push({ from: direction === 'up' ? neighbor : id, to: direction === 'up' ? id : neighbor });
        if (seen.has(neighbor)) continue;
        if (seen.size >= maxNodes) { truncated = true; break; }
        seen.add(neighbor);
        next.push(neighbor);
      }
      if (truncated) break;
    }
    frontier = next;
    level += 1;
  }
  if (frontier.length > 0) truncated = true;
  const rows = [...seen].map((id) => projectRow(byId.get(id)));
  const build = (kept) => {
    const ids = new Set(kept.map((row) => row.id));
    return {
      ok: true,
      from,
      direction,
      depth: maxDepth,
      nodes: kept,
      edges: edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
      truncated: (truncated || kept.length < rows.length)
        ? { shown: kept.length, total: kept.length < rows.length ? rows.length : null, discovered: rows.length, reason: kept.length < rows.length ? 'bytes' : 'limit' }
        : null,
    };
  };
  const fit = fitPrefix(rows, maxBytes, build);
  let kept = fit.kept;
  let result = build(kept);
  while (kept.length > 0 && Buffer.byteLength(JSON.stringify(result)) > maxBytes) {
    kept = kept.slice(0, -1);
    result = build(kept);
  }
  if (result.truncated) {
    result.truncated.bytes = { max: maxBytes, used: 0 };
    result.truncated.bytes.used = Buffer.byteLength(JSON.stringify(result));
  }
  return result;
}

/**
 * Diff two node snapshots (dag_diff / changes_since). Pure; the caller supplies
 * the previous snapshot and the current nodes.
 * @param {{byId: Map<string, object>, revision?: number}} before
 * @param {object[]} afterNodes
 * @param {number} [revision]
 */
export function diffSnapshots(before, afterNodes, revision = null) {
  const after = new Map(afterNodes.map((node) => [node.id, node]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [id, node] of after) {
    const previous = before?.byId?.get(id);
    if (!previous) { added.push(id); continue; }
    const fields = [];
    if (previous.status !== node.status) fields.push('status');
    if ((previous.rev ?? 0) !== (node.rev ?? 0)) fields.push('rev');
    if (JSON.stringify(previous.priority?.class) !== JSON.stringify(node.priority?.class)) fields.push('priority');
    if (JSON.stringify(previous.lease?.leaseId) !== JSON.stringify(node.lease?.leaseId)) fields.push('lease');
    if (fields.length > 0) changed.push({ nodeId: id, fields, status: node.status, rev: node.rev ?? 0 });
  }
  for (const id of before?.byId?.keys?.() ?? []) {
    if (!after.has(id)) removed.push(id);
  }
  return {
    ok: true,
    fromRevision: before?.revision ?? null,
    toRevision: revision,
    added,
    removed,
    changed,
    counts: { added: added.length, removed: removed.length, changed: changed.length },
  };
}

/**
 * Keep a bounded history of node snapshots per project so `dag_diff` can
 * honour an explicit `sinceRevision` instead of only "since the last call".
 * A cold or too-old cursor returns a defined `diff_unavailable` error rather
 * than silently claiming everything was added.
 */
export function createDiffCache({ maxProjects = 16, clock = Date.now } = {}) {
  const cache = new Map();
  function snapshotOf(nodes, revision) {
    return {
      revision,
      byId: new Map(nodes.map((node) => [node.id, {
        id: node.id,
        status: node.status,
        rev: node.rev ?? 0,
        priority: node.priority ?? null,
        lease: node.lease ? { leaseId: node.lease.leaseId } : null,
      }])),
    };
  }
  function diff(projectId, nodes, revision, sinceRevision = null) {
    const entry = cache.get(projectId) ?? { history: [] };
    const since = Number.isFinite(sinceRevision) ? sinceRevision : null;
    if (since !== null && Number.isFinite(revision) && since > revision) {
      return {
        ok: false,
        code: 'diff_unavailable',
        message: `revision ${since} is ahead of the project revision ${revision}`,
        nextStep: 'pass a revision at or before the current project revision',
        sinceRevision: since,
        revision,
      };
    }
    let before = null;
    if (since === 0) {
      // Revision 0 is the empty project; a cold caller from 0 gets every node
      // as `added`, which is a complete and honest delta.
      before = { revision: 0, byId: new Map() };
    } else if (since !== null) {
      for (const snapshot of entry.history) {
        if (snapshot.revision <= since && (before === null || snapshot.revision > before.revision)) before = snapshot;
      }
      if (before === null) {
        return {
          ok: false,
          code: 'diff_unavailable',
          message: `no snapshot at or before revision ${since}`,
          nextStep: 'call dag_diff without sinceRevision for a cold diff',
          sinceRevision: since,
          revision,
        };
      }
    } else {
      before = entry.history.length > 0 ? entry.history[entry.history.length - 1] : null;
    }
    const result = diffSnapshots(before, nodes, revision);
    const snapshot = snapshotOf(nodes, revision);
    entry.history.push(snapshot);
    if (entry.history.length > DIFF_HISTORY) entry.history.splice(0, entry.history.length - DIFF_HISTORY);
    cache.delete(projectId);
    if (cache.size >= maxProjects) cache.delete(cache.keys().next().value);
    cache.set(projectId, entry);
    return { ...result, sinceRevision: since ?? before?.revision ?? null, coldStart: before === null };
  }
  return { diff, reset: (projectId) => cache.delete(projectId) };
}
