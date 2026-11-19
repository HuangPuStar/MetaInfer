/**
 * Trace store for the profiling viewer (issue #94).
 *
 * Owns everything the pure index in `trace.js` must not know about: reading the
 * file (plain JSON or gzip), enforcing the byte ceiling, minting ids, and the
 * small in-memory LRU that keeps the last few opened traces queryable.
 *
 * The store is intentionally file-read-only: it never writes into the user's
 * repository and never uploads a trace anywhere. A trace stays in Host memory
 * until it is closed or evicted.
 */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { TRACE_LIMITS, parseTraceDocument, traceSummary } from './trace.js';

const MAX_TRACES = 3;

function mintId(name, size, now) {
  const digest = createHash('sha1')
    .update(`${name}:${size}:${now}:${Math.random()}`)
    .digest('hex')
    .slice(0, 12);
  return `tr_${digest}`;
}

function looksGzip(buffer) {
  return buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

/**
 * @param {object} [options]
 * @param {number} [options.maxTraces] in-memory traces kept before LRU eviction
 */
export function createProfilerStore(options = {}) {
  const maxTraces = Number.isFinite(options.maxTraces) ? Math.max(1, Math.trunc(options.maxTraces)) : MAX_TRACES;
  /** @type {Map<string, object>} traceId -> index, insertion order = LRU order */
  const traces = new Map();

  function touch(traceId) {
    const index = traces.get(traceId);
    if (!index) return null;
    // Refresh recency: Map preserves insertion order.
    traces.delete(traceId);
    traces.set(traceId, index);
    return index;
  }

  function remember(index) {
    traces.set(index.traceId, index);
    while (traces.size > maxTraces) {
      const oldest = traces.keys().next().value;
      traces.delete(oldest);
    }
    return index;
  }

  /**
   * Load a trace from an absolute path on the Host machine.
   * @param {string} filePath
   */
  async function openPath(filePath) {
    const resolved = path.resolve(String(filePath ?? ''));
    if (!path.isAbsolute(resolved)) {
      throw Object.assign(new Error('trace path must be absolute'), { code: 'bad_request' });
    }
    const extension = path.extname(resolved).toLowerCase();
    if (extension !== '.json' && extension !== '.gz' && extension !== '.json.gz') {
      throw Object.assign(new Error('trace must be a .json or .json.gz file'), { code: 'bad_request' });
    }
    const info = await stat(resolved).catch(() => null);
    if (!info || !info.isFile()) {
      throw Object.assign(new Error(`trace file not found: ${resolved}`), { code: 'trace_not_found' });
    }
    if (info.size > TRACE_LIMITS.maxBytes) {
      throw Object.assign(
        new Error(`trace file is ${info.size} bytes; the limit is ${TRACE_LIMITS.maxBytes}`),
        { code: 'trace_too_large' },
      );
    }
    const bytes = await readFile(resolved);
    const text = looksGzip(bytes) ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
    const now = Date.now();
    const traceId = mintId(path.basename(resolved), info.size, now);
    const index = parseTraceDocument(text, {
      traceId,
      name: path.basename(resolved),
      sourcePath: resolved,
    });
    return remember(index);
  }

  /**
   * Load a trace the Client sent inline (small files only; the JSON body is
   * already bounded by the Connection carrier).
   * @param {string} content raw JSON text
   * @param {string} name display name
   */
  function openContent(content, name) {
    if (typeof content !== 'string' || content.length === 0) {
      throw Object.assign(new Error('trace content is required'), { code: 'bad_request' });
    }
    if (Buffer.byteLength(content, 'utf8') > TRACE_LIMITS.maxBytes) {
      throw Object.assign(new Error('trace content is too large; open it by path instead'), { code: 'trace_too_large' });
    }
    const now = Date.now();
    const displayName = typeof name === 'string' && name.trim() !== '' ? name.trim().slice(0, 200) : 'uploaded-trace.json';
    const traceId = mintId(displayName, content.length, now);
    const index = parseTraceDocument(content, { traceId, name: displayName, sourcePath: null });
    return remember(index);
  }

  function get(traceId) {
    return typeof traceId === 'string' && traceId !== '' ? touch(traceId) : null;
  }

  function list() {
    return [...traces.values()]
      .map((index) => ({
        traceId: index.traceId,
        name: index.name,
        sourcePath: index.sourcePath,
        createdAt: index.createdAt,
        window: index.window,
        counts: index.counts,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  function summary(traceId) {
    const index = get(traceId);
    return index ? traceSummary(index) : null;
  }

  function close(traceId) {
    return traces.delete(traceId);
  }

  return { openPath, openContent, get, list, summary, close };
}
