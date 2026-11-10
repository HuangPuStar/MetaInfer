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
