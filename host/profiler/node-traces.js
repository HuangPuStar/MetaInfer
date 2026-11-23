/**
 * Discover profiling traces that live inside a node's worktree.
 *
 * A node owns a git worktree (`node.git.worktreePath`); traces produced by an
 * experiment land in it as torch.profiler chrome-trace JSON (plain or gzipped).
 * The DAG → trace hop must not ask the operator to paste an absolute path: the
 * Host can enumerate the candidates itself and hand relative paths back.
 *
 * The listing is **extension-only on purpose**: experiments also ship traces as
 * `tar.gz` bundles or as files the Host cannot classify without unpacking them.
 * Parsing every candidate up front would be slow and would hide exactly the files
 * the operator wants; instead the scan reports what it finds, and `trace.open`
 * fails with a named code when the document is not a chrome trace.
 *
 * Two invariants:
 *  - the scan never leaves the worktree, never follows symlinks, and skips
 *    `.git` / `node_modules`;
 *  - resolving a path back (for `trace.open`) re-checks containment, so a
 *    crafted `../../etc/passwd` is a named bad_request rather than a read.
 */
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { TRACE_LIMITS } from './trace.js';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.cache', 'build', 'dist']);
/**
 * Only `*.json.gz` is listed (operator decision, 2026-11-23): that is the single
 * container their experiments actually emit. Bare json, tar bundles and other
 * containers are hidden on purpose — a shorter list is worth more than a list of
 * files that cannot be indexed.
 */
const CANDIDATE_EXT = /\.json\.gz$/i;

/** Every candidate is a gzipped chrome trace; the viewer validates on open. */
export function traceKindOf(name) {
  return /\.json\.gz$/i.test(String(name ?? '')) ? 'gzip-json' : 'unknown';
}

const DEFAULT_MAX_FILES = 4000;
const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_LIMIT = 60;

/**
 * Walk one node worktree and return trace candidates, best first.
 * Chrome traces (marker present) come before plain JSON files, then by mtime.
 * @param {string} root absolute worktree path
 * @param {{maxFiles?: number, maxDepth?: number, limit?: number}} [options]
 */
export async function listNodeTraces(root, options = {}) {
  const base = typeof root === 'string' ? path.resolve(root) : '';
  if (!base) return { worktree: '', scanned: 0, candidates: [] };
  const maxFiles = Number.isFinite(options.maxFiles) ? options.maxFiles : DEFAULT_MAX_FILES;
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : DEFAULT_MAX_DEPTH;
  const limit = Number.isFinite(options.limit) ? options.limit : DEFAULT_LIMIT;

  const candidates = [];
  let scanned = 0;
  const queue = [{ dir: base, depth: 0 }];
  while (queue.length > 0 && scanned < maxFiles) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (scanned >= maxFiles) break;
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth >= maxDepth || SKIP_DIRS.has(entry.name)) continue;
        queue.push({ dir: absolute, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile() || !CANDIDATE_EXT.test(entry.name)) continue;
      scanned += 1;
      let info;
      try { info = await stat(absolute); } catch { continue; }
      // Size is the only content-level filter: an oversized candidate is skipped
      // because opening it would exceed the trace budget anyway.
      if (!info.isFile() || info.size === 0 || info.size > TRACE_LIMITS.maxBytes) continue;
      const relPath = path.relative(base, absolute);
      candidates.push({
        relPath,
        name: path.basename(relPath),
        size: info.size,
        mtimeMs: Math.trunc(info.mtimeMs),
        gzip: true,
        kind: 'gzip-json',
      });
    }
  }
  candidates.sort((a, b) => (b.mtimeMs - a.mtimeMs) || a.relPath.localeCompare(b.relPath));
  return { worktree: base, scanned, candidates: candidates.slice(0, limit), total: candidates.length };
}

/**
 * Resolve a client-supplied relative path inside the worktree.
 * @param {string} root absolute worktree path
 * @param {string} relPath client path, may be nested
 * @returns {string} absolute path that is guaranteed to be inside `root`
 */
export function resolveNodeTracePath(root, relPath) {
  const base = typeof root === 'string' ? path.resolve(root) : '';
  const raw = typeof relPath === 'string' ? relPath.trim() : '';
  const fail = (message) => Object.assign(new Error(message), { code: 'bad_request' });
  if (!base) throw fail('node has no worktree');
  if (!raw) throw fail('relPath is required');
  const absolute = path.resolve(base, raw);
  if (absolute === base || !absolute.startsWith(base + path.sep)) {
    throw fail(`relPath escapes the node worktree: ${raw}`);
  }
  return absolute;
}
