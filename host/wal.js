/**
 * DAG write-ahead log.
 *
 * Every mutation of a DAG node appends one immutable row here, in the order the
 * store applied it. The numeric `seq` is strictly increasing and never reused, so
 * a consumer can hold `seq` as a cursor and later ask "what changed after my
 * position?" without diffing the whole graph.
 *
 * Why SQLite (`node:sqlite`, available in this runtime, no dependency):
 * - append-only by contract, but *queryable*: range scans, per-node history and
 *   pagination are indexed instead of linear;
 * - `journal_mode = WAL` is a real write-ahead log: a crash never tears a commit,
 *   and readers never block the writer;
 * - it survives restarts, unlike the previous in-memory 5,000-entry ring buffer
 *   that `changes_since` used (and that only returned a final snapshot per node).
 *
 * The log is the audit trail, not the state: replaying it is enough to know *what
 * changed*, but the authoritative node record remains the store table.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Kinds are stable strings; consumers may filter by them. */
export const WAL_KINDS = Object.freeze([
  'node.created',
  'node.updated',
  'node.status',
  'node.priority',
  'node.title',
  'node.removed',
  'node.snapshot',
]);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wal (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT    NOT NULL,
  node_id    TEXT,
  kind       TEXT    NOT NULL,
  at         INTEGER NOT NULL,
  actor      TEXT,
  revision   INTEGER,
  payload    TEXT
);
CREATE INDEX IF NOT EXISTS wal_project_seq ON wal(project_id, seq);
CREATE INDEX IF NOT EXISTS wal_project_node ON wal(project_id, node_id, seq);
CREATE TABLE IF NOT EXISTS wal_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

/**
 * Open (or create) the log.
 * @param {{file?: string, now?: () => number, fresh?: boolean}} [options]
 */
export function createWal(options = {}) {
  const file = options.file ?? path.join(process.cwd(), 'wal.sqlite');
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  if (file !== ':memory:') {
    // DatabaseSync creates the file but not the directory.
    const dir = path.dirname(file);
    if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);

  const insertStmt = db.prepare(
    'INSERT INTO wal (project_id, node_id, kind, at, actor, revision, payload) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const metaGet = db.prepare('SELECT value FROM wal_meta WHERE key = ?');
  const metaSet = db.prepare('INSERT INTO wal_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const latestStmt = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM wal WHERE project_id = ?');
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM wal WHERE project_id = ?');

  function meta(key) {
    const row = metaGet.get(key);
    return row === undefined ? null : row.value;
  }

  /**
   * Append one entry. Returns `{ seq, at }`.
   * `payload` is stored as JSON; pass a plain object.
   */
  function append({ projectId, nodeId = null, kind, actor = null, revision = null, payload = null }) {
    if (typeof projectId !== 'string' || projectId === '') throw new Error('wal.append: projectId is required');
    if (typeof kind !== 'string' || kind === '') throw new Error('wal.append: kind is required');
    const at = now();
    const result = insertStmt.run(
      projectId,
      nodeId === null ? null : String(nodeId),
      kind,
      at,
      actor === null ? null : String(actor),
      revision === null ? null : Number(revision),
      payload === null ? null : JSON.stringify(payload),
    );
    return { seq: Number(result.lastInsertRowid), at };
  }

  /** Append many entries atomically (used by the one-time backfill). */
  function appendMany(entries) {
    const out = [];
    db.exec('BEGIN');
    try {
      for (const entry of entries) out.push(append(entry));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return out;
  }

  function decode(row) {
    let payload = null;
    if (row.payload !== null && row.payload !== undefined) {
      try { payload = JSON.parse(row.payload); } catch { payload = { raw: String(row.payload) }; }
    }
    return {
      seq: Number(row.seq),
      projectId: row.project_id,
      nodeId: row.node_id,
      kind: row.kind,
      at: Number(row.at),
      actor: row.actor,
      revision: row.revision === null ? null : Number(row.revision),
      payload,
    };
  }

  /**
   * Query a range.
   *
   * @param {object} input
   * @param {string} input.projectId
   * @param {number} [input.fromSeq] exclusive lower bound: only entries with seq > fromSeq
 *                                  (cursor semantics: pass the last seq you handled)
   * @param {number|null} [input.toSeq] inclusive upper bound (default: latest)
   * @param {string|null} [input.nodeId] only this node
   * @param {string[]|null} [input.kinds] only these kinds
   * @param {number} [input.limit] page size (1..1000)
   * @param {string|null} [input.cursor] opaque cursor from a previous page
   * @param {'asc'|'desc'} [input.order]
   */
  function query(input = {}) {
    const projectId = input.projectId;
    if (typeof projectId !== 'string' || projectId === '') throw new Error('wal.query: projectId is required');
    const limit = Math.min(1000, Math.max(1, Number.isFinite(input.limit) ? Math.trunc(input.limit) : 100));
    const order = input.order === 'desc' ? 'desc' : 'asc';
    const fromSeq = Number.isFinite(input.fromSeq) ? Math.max(0, Math.trunc(input.fromSeq)) : 0;
    const toSeq = Number.isFinite(input.toSeq) ? Math.trunc(input.toSeq) : null;
    const nodeId = typeof input.nodeId === 'string' && input.nodeId !== '' ? input.nodeId : null;
    const kinds = Array.isArray(input.kinds) && input.kinds.length > 0 ? input.kinds.filter((kind) => typeof kind === 'string') : null;
    const cursorSeq = decodeCursor(input.cursor);

    const where = ['project_id = ?'];
    const params = [projectId];
    let lower = fromSeq;
    if (cursorSeq !== null && order === 'asc') lower = Math.max(lower, cursorSeq);
    if (cursorSeq !== null && order === 'desc') {
      // Descending pages walk backwards from the cursor.
      if (toSeq === null || cursorSeq < toSeq) params.push(cursorSeq);
      if (toSeq === null || cursorSeq < toSeq) where.push('seq < ?');
    }
    if (lower > 0) { where.push('seq > ?'); params.push(lower); }
    if (toSeq !== null) { where.push('seq <= ?'); params.push(toSeq); }
    if (nodeId !== null) { where.push('node_id = ?'); params.push(nodeId); }
    if (kinds !== null) {
      where.push('kind IN (' + kinds.map(() => '?').join(', ') + ')');
      params.push(...kinds);
    }
    const sql = `SELECT * FROM wal WHERE ${where.join(' AND ')} ORDER BY seq ${order.toUpperCase()} LIMIT ${limit + 1}`;
    const rows = db.prepare(sql).all(...params).map(decode);
    const hasMore = rows.length > limit;
    const entries = hasMore ? rows.slice(0, limit) : rows;
    const last = entries.length > 0 ? entries[entries.length - 1].seq : null;
    return {
      projectId,
      order,
      entries,
      count: entries.length,
      hasMore,
      nextCursor: hasMore && last !== null ? encodeCursor(last) : null,
      latestSeq: latestSeq(projectId),
      fromSeq,
      toSeq,
    };
  }

  function latestSeq(projectId) {
    const row = latestStmt.get(projectId);
    return row === undefined ? 0 : Number(row.seq);
  }

  function count(projectId) {
    const row = countStmt.get(projectId);
    return row === undefined ? 0 : Number(row.n);
  }

  /**
   * Seed the log for a project that predates it, exactly once.
   *
   * Existing nodes become one `node.snapshot` entry each, so a fresh cursor at 0
   * still learns the current graph; a project created afterwards starts empty and
   * gets `node.created` entries as it grows.
   */
  function ensureBackfill(projectId, nodes, { actor = 'host:backfill' } = {}) {
    const key = 'backfill:' + projectId;
    if (meta(key) !== null) return { seeded: 0, done: true };
    const list = Array.isArray(nodes) ? nodes : [];
    if (list.length > 0) {
      appendMany(list.map((node) => ({
        projectId,
        nodeId: node?.id ?? null,
        kind: 'node.snapshot',
        actor,
        revision: node?.rev ?? null,
        payload: {
          status: node?.status ?? null,
          title: node?.title ?? '',
          priority: node?.priority?.class ?? null,
          parentId: node?.parentId ?? null,
          rev: node?.rev ?? 0,
        },
      })));
    }
    metaSet.run(key, String(now()));
    return { seeded: list.length, done: true };
  }

  function close() {
    try { db.close(); } catch { /* already closed */ }
  }

  return { file, append, appendMany, query, latestSeq, count, ensureBackfill, close };
}

/** Cursor is the seq as a string; kept opaque so the encoding can change. */
export function encodeCursor(seq) {
  return 'w' + String(seq);
}

export function decodeCursor(cursor) {
  if (typeof cursor !== 'string') return null;
  const match = /^w(\d+)$/.exec(cursor.trim());
  if (match === null) return null;
  const seq = Number(match[1]);
  return Number.isSafeInteger(seq) && seq >= 0 ? seq : null;
}

/**
 * Semantic kind for a node write, plus a small diff payload.
 *
 * Keeping this next to the log (instead of in the store) means every writer gets
 * the same classification, and a consumer filtering `node.status` sees exactly the
 * writes that changed a status.
 */
export function describeNodeChange(previous, next) {
  if (!previous) {
    return {
      kind: 'node.created',
      payload: {
        status: next?.status ?? null,
        title: next?.title ?? '',
        priority: next?.priority?.class ?? null,
        parentId: next?.parentId ?? null,
        rev: next?.rev ?? 0,
      },
    };
  }
  const changed = [];
  for (const field of ['status', 'title', 'parentId']) {
    if ((previous[field] ?? null) !== (next[field] ?? null)) changed.push(field);
  }
  const prevPriority = previous.priority?.class ?? null;
  const nextPriority = next.priority?.class ?? null;
  if (prevPriority !== nextPriority) changed.push('priority');
  if ((previous.rev ?? 0) !== (next.rev ?? 0)) changed.push('rev');
  let kind = 'node.updated';
  if (changed.includes('status')) kind = 'node.status';
  else if (changed.includes('priority')) kind = 'node.priority';
  else if (changed.includes('title')) kind = 'node.title';
  return {
    kind,
    payload: {
      changed,
      before: { status: previous.status ?? null, title: previous.title ?? '', priority: prevPriority, rev: previous.rev ?? 0 },
      after: { status: next?.status ?? null, title: next?.title ?? '', priority: nextPriority, rev: next?.rev ?? 0 },
    },
  };
}
