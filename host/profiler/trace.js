/**
 * Torch profiling trace index (issue #94).
 *
 * Parses the Chrome-trace dialect `torch.profiler` emits (`traceEvents` with
 * `ph: "X"` spans) into a query index the Web Client can page through:
 * kernels grouped by device/stream lanes, the CPU operator that launched each
 * kernel (correlation id), the enclosing call stack, and input shapes.
 *
 * Everything here is pure: no fs, no network, no timers. `host/profiler/store.js`
 * owns loading and lifecycle, `host/profiler/prompts.js` owns the agent-facing
 * text. Keeping the parse pure is what makes `scripts/profiler-selftest.mjs`
 * run without a Host.
 */

/** Hard caps so a hostile or accidental 4 GB trace cannot wedge the Host. */
export const TRACE_LIMITS = Object.freeze({
  /** Largest accepted trace document (bytes of JSON text). */
  maxBytes: 256 * 1024 * 1024,
  /** Largest accepted event count. */
  maxEvents: 2_000_000,
  /** Kernel records kept; the tail beyond this is counted, not indexed. */
  maxKernels: 250_000,
  /** CPU/annotation spans kept for call stacks; beyond this stacks get shallower. */
  maxOps: 400_000,
  /** Per-query page size ceilings. */
  maxKernelsPerPage: 500,
  maxTimelineSpans: 4_000,
  maxTimelineLanes: 48,
  /** Stored name/source strings are truncated here. */
  maxNameChars: 400,
  maxSourceChars: 240,
  /** Neighbour kernels returned per side for fusion analysis. */
  neighbourCount: 3,
});

const KERNEL_CATS = new Set(['kernel', 'gpu_kernel', 'Kernel']);
const MEMORY_CATS = new Set(['gpu_memory', 'gpu_memory_usage', 'memory']);
const RUNTIME_CATS = new Set(['cuda_runtime', 'cuda_driver', 'runtime', 'CudaRuntime', 'cuda']);
/** Spans kept for call-stack reconstruction (everything that is not a GPU kernel). */
const STACK_CATS = new Set([
  'cpu_op',
  'operator',
  'python_function',
  'user_annotation',
  'gpu_user_annotation',
  'cuda_runtime',
  'cuda_driver',
  'runtime',
  'CudaRuntime',
  'cuda',
]);

function finite(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function trimmed(value, limit) {
  const text = typeof value === 'string' ? value : '';
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

/**
 * Torch kernels are template-heavy; the viewer and the prompt text both need a
 * stable short label. Balance `<...>` so `foo<Bar<Baz>>` does not cut mid-angle.
 */
export function shortKernelName(name, limit = 96) {
  const text = typeof name === 'string' ? name : '';
  const callAt = text.indexOf('(');
  const head = callAt > 0 ? text.slice(0, callAt) : text;
  let depth = 0;
  let out = '';
  for (const char of head) {
    if (char === '<') {
      depth += 1;
      if (depth === 1) {
        out += '<…>';
        continue;
      }
    }
    if (char === '>') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) out += char;
  }
  const compact = out.replace(/\s+/g, ' ').trim();
  const finalText = compact === '' ? head : compact;
  return trimmed(finalText, limit);
}

/** The dispatch family (prefix before the first template/parameter list). */
export function kernelFamily(name) {
  const text = typeof name === 'string' ? name : '';
  const cut = text.search(/[<(]/);
  const head = cut > 0 ? text.slice(0, cut) : text;
  return trimmed(head.replace(/\s+/g, ' ').trim(), TRACE_LIMITS.maxNameChars);
}

function readInputs(args) {
  if (!args || typeof args !== 'object') return null;
  const dims = args['Input Dims'];
  if (!Array.isArray(dims)) return null;
  const types = args['Input type'];
  return {
    dims: dims.slice(0, 32).map((entry) => (Array.isArray(entry) ? entry.slice(0, 8).map((value) => finite(value) ?? value) : entry)),
    types: Array.isArray(types) ? types.slice(0, 32) : null,
  };
}

function readSource(args) {
  if (!args || typeof args !== 'object') return null;
  const candidates = [args.source, args.Source, args.python_source, args['Source code']];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return trimmed(candidate.replace(/\s+/g, ' ').trim(), TRACE_LIMITS.maxSourceChars);
    }
  }
  return null;
}

function readGrid(args) {
  const grid = args?.grid ?? args?.['grid'];
  if (!Array.isArray(grid)) return null;
  return grid.slice(0, 3).map((value) => finite(value) ?? 0);
}

function readBlock(args) {
  const block = args?.block ?? args?.['block'];
  if (!Array.isArray(block)) return null;
  return block.slice(0, 3).map((value) => finite(value) ?? 0);
}

function readCorrelation(args) {
  if (!args || typeof args !== 'object') return null;
  const candidates = [args.correlation, args['External id'], args.external_id, args['Ev Idx']];
  for (const candidate of candidates) {
    const number = finite(candidate);
    if (number !== null) return number;
  }
  return null;
}

function readExternalId(args) {
  if (!args || typeof args !== 'object') return null;
  const candidates = [args['External id'], args.external_id, args['Ev Idx'], args['Record function id']];
  for (const candidate of candidates) {
    const number = finite(candidate);
    if (number !== null) return number;
  }
  return null;
}

function readNumbers(args, keys) {
  for (const key of keys) {
    const number = finite(args?.[key]);
    if (number !== null) return number;
  }
  return null;
}

/** Lane label lookup from `ph: "M"` process/thread metadata. */
function readMetadata(event, processes, threads) {
  if (event?.ph !== 'M' || typeof event?.name !== 'string') return;
  const pid = finite(event.pid);
  if (pid === null) return;
  const args = event.args && typeof event.args === 'object' ? event.args : {};
  if (event.name === 'process_name' && typeof args.name === 'string') processes.set(pid, trimmed(args.name, 80));
  if (event.name === 'thread_name' && typeof args.name === 'string') {
    const tid = finite(event.tid);
    if (tid !== null) threads.set(`${pid}:${tid}`, trimmed(args.name, 80));
  }
}

/**
 * Build a queryable index from raw Chrome-trace events.
 *
 * @param {object} input
 * @param {string} input.traceId stable id minted by the store
 * @param {string} input.name display name (file name)
 * @param {Array<object>} input.events raw `traceEvents`
 * @param {string|null} [input.displayTimeUnit]
 * @param {string|null} [input.sourcePath]
 * @returns {object} trace index (internal shape; only the store serializes it)
 */
export function buildTraceIndex(input) {
  const events = Array.isArray(input?.events) ? input.events : [];
  if (events.length > TRACE_LIMITS.maxEvents) {
    throw Object.assign(
      new Error(`trace has ${events.length} events; the limit is ${TRACE_LIMITS.maxEvents}`),
      { code: 'trace_too_large' },
    );
  }
  const processes = new Map();
  const threads = new Map();

  const kernels = [];
  const ops = [];
  const laneOrder = new Map();
  const laneByKey = new Map();
  let droppedKernels = 0;
  let droppedOps = 0;
  let minTs = null;
  let maxTs = null;
  let memorySpans = 0;
  let annotationSpans = 0;
  let runtimeSpans = 0;
  let unnamedSpans = 0;

  const touchSpan = (start, end) => {
    if (minTs === null || start < minTs) minTs = start;
    if (maxTs === null || end > maxTs) maxTs = end;
  };

  // Metadata is not positional, so resolve names before reading spans.
  for (const event of events) {
    if (event && event.ph === 'M') readMetadata(event, processes, threads);
  }

  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const ph = event.ph;
    if (ph !== 'X' && ph !== 'x') continue;
    const ts = finite(event.ts);
    const dur = finite(event.dur);
    if (ts === null || dur === null || dur < 0) continue;
    const cat = typeof event.cat === 'string' ? event.cat : '';
    const name = typeof event.name === 'string' ? event.name : '';
    const end = ts + dur;
    const pid = finite(event.pid);
    const tid = finite(event.tid);
    const args = event.args && typeof event.args === 'object' ? event.args : null;

    if (KERNEL_CATS.has(cat) || (cat === '' && /_kernel|gemm|conv|elementwise/i.test(name))) {
      touchSpan(ts, end);
      if (kernels.length >= TRACE_LIMITS.maxKernels) {
        droppedKernels += 1;
        continue;
      }
      const device = readNumbers(args, ['device', 'Device', 'device_id']) ?? 0;
      const stream = readNumbers(args, ['stream', 'Stream', 'stream_id']) ?? (tid ?? 0);
      const laneKey = `gpu${device}:s${stream}`;
      if (!laneByKey.has(laneKey)) {
        laneByKey.set(laneKey, {
          lane: laneKey,
          kind: 'gpu',
          device,
          stream,
          pid,
          tid,
          label: threads.get(`${pid}:${tid}`) ?? processes.get(pid) ?? `stream ${stream}`,
          kernelCount: 0,
          totalDurUs: 0,
        });
        laneOrder.set(laneKey, laneOrder.size);
      }
      const lane = laneByKey.get(laneKey);
      lane.kernelCount += 1;
      lane.totalDurUs += dur;
      kernels.push({
        index: kernels.length,
        name: trimmed(name, TRACE_LIMITS.maxNameChars),
        shortName: shortKernelName(name),
        family: kernelFamily(name),
        ts,
        dur,
        end,
        device,
        stream,
        lane: laneKey,
        pid,
        tid,
        correlation: readCorrelation(args),
        grid: readGrid(args),
        block: readBlock(args),
        registers: readNumbers(args, ['registers per thread', 'registers', 'Registers Per Thread']),
        sharedMemory: readNumbers(args, ['shared memory', 'shared_memory', 'Shared Memory']),
        occupancy: readNumbers(args, ['est. achieved occupancy %', 'achieved occupancy', 'occupancy']),
        opIndex: null,
        opName: null,
      });
      continue;
    }

    if (MEMORY_CATS.has(cat)) {
      memorySpans += 1;
      continue;
    }
    if (cat === 'user_annotation' || cat === 'gpu_user_annotation') annotationSpans += 1;
    if (RUNTIME_CATS.has(cat)) runtimeSpans += 1;

    if (STACK_CATS.has(cat)) {
      touchSpan(ts, end);
      if (ops.length >= TRACE_LIMITS.maxOps) {
        droppedOps += 1;
        continue;
      }
      const externalId = readExternalId(args);
      ops.push({
        index: ops.length,
        name: trimmed(name === '' ? cat : name, TRACE_LIMITS.maxNameChars),
        category: trimmed(cat, 40),
        ts,
        dur,
        end,
        pid,
        tid,
        externalId,
        inputs: readInputs(args),
        source: readSource(args),
        parentIndex: null,
        threadKey: `${pid ?? '?'}:${tid ?? '?'}`,
      });
      if (name === '') unnamedSpans += 1;
      continue;
    }
    // Anything else (counters, flows, instants) still contributes to the span
    // window but is not indexed.
  }

  if (kernels.length === 0 && ops.length === 0) {
    throw Object.assign(new Error('trace contains no kernels or CPU operators; is this a torch.profiler chrome trace?'), { code: 'trace_empty' });
  }

  // Nest CPU spans per thread so a kernel can report the code path that issued it.
  const byThread = new Map();
  for (const op of ops) {
    if (!byThread.has(op.threadKey)) byThread.set(op.threadKey, []);
    byThread.get(op.threadKey).push(op);
  }
  for (const list of byThread.values()) {
    list.sort((a, b) => a.ts - b.ts || b.dur - a.dur);
    const stack = [];
    for (const op of list) {
      while (stack.length > 0 && stack[stack.length - 1].end <= op.ts) stack.pop();
      // Events on one thread can overlap when the profiler emits nested async
      // ops out of order; keep only true containers.
      while (stack.length > 0 && stack[stack.length - 1].end < op.end) stack.pop();
      op.parentIndex = stack.length > 0 ? stack[stack.length - 1].index : null;
      stack.push(op);
    }
  }

  // Kernel -> launching CPU op through the correlation/External id pair.
  const opByExternalId = new Map();
  for (const op of ops) {
    if (op.externalId === null) continue;
    if (!opByExternalId.has(op.externalId)) opByExternalId.set(op.externalId, op);
  }
  for (const kernel of kernels) {
    if (kernel.correlation === null) continue;
    const op = opByExternalId.get(kernel.correlation);
    if (!op) continue;
    kernel.opIndex = op.index;
    kernel.opName = op.name;
  }

  // Kernel order per lane powers neighbours and timelines without re-sorting.
  const byLane = new Map();
  for (const kernel of kernels) {
    if (!byLane.has(kernel.lane)) byLane.set(kernel.lane, []);
    byLane.get(kernel.lane).push(kernel);
  }
  for (const list of byLane.values()) list.sort((a, b) => a.ts - b.ts || a.index - b.index);

  const allSorted = kernels.slice().sort((a, b) => a.ts - b.ts || a.index - b.index);

  const lanes = [...laneByKey.values()].sort((a, b) => {
    const da = Number(a.device) || 0;
    const db = Number(b.device) || 0;
    if (da !== db) return da - db;
    return (Number(a.stream) || 0) - (Number(b.stream) || 0);
  });

  const startTs = minTs ?? 0;
  const endTs = maxTs ?? startTs;
  return {
    traceId: input.traceId,
    name: input.name,
    sourcePath: input.sourcePath ?? null,
    displayTimeUnit: typeof input.displayTimeUnit === 'string' ? input.displayTimeUnit : 'ms',
    createdAt: Date.now(),
    window: { startTs, endTs, durationUs: Math.max(0, endTs - startTs) },
    counts: {
      events: events.length,
      kernels: kernels.length,
      droppedKernels,
      ops: ops.length,
      droppedOps,
      memorySpans,
      annotations: annotationSpans,
      runtimeSpans,
      unnamedSpans,
    },
    lanes,
    kernels,
    ops,
    byLane,
    allSorted,
    opByExternalId,
    processes,
    threads,
  };
}

/** Parse the JSON document text and hand it to `buildTraceIndex`. */
export function parseTraceDocument(text, meta) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw Object.assign(new Error('trace file is empty'), { code: 'trace_empty' });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw Object.assign(new Error(`trace is not valid JSON: ${error instanceof Error ? error.message : String(error)}`), { code: 'trace_invalid_json' });
  }
  const events = Array.isArray(parsed) ? parsed : parsed?.traceEvents;
  if (!Array.isArray(events)) {
    throw Object.assign(new Error('trace JSON has no traceEvents array'), { code: 'trace_invalid_json' });
  }
  return buildTraceIndex({
    traceId: meta.traceId,
    name: meta.name,
    sourcePath: meta.sourcePath ?? null,
    displayTimeUnit: typeof parsed?.displayTimeUnit === 'string' ? parsed.displayTimeUnit : null,
    events,
  });
}

function percentile(sorted, ratio) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)));
  return sorted[index];
}

function durationStats(durations) {
  if (durations.length === 0) return { count: 0, sumUs: 0, avgUs: 0, minUs: 0, maxUs: 0, p50Us: 0, p99Us: 0 };
  const sorted = durations.slice().sort((a, b) => a - b);
  const sumUs = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    sumUs,
    avgUs: sumUs / sorted.length,
    minUs: sorted[0],
    maxUs: sorted[sorted.length - 1],
    p50Us: percentile(sorted, 0.5),
    p99Us: percentile(sorted, 0.99),
  };
}

/** Per-name aggregate rows (the kernel table). Computed lazily and cached per trace. */
export function aggregateKernels(index) {
  if (index.__aggregates) return index.__aggregates;
  const byFamily = new Map();
  const byName = new Map();
  for (const kernel of index.kernels) {
    if (!byName.has(kernel.name)) byName.set(kernel.name, { name: kernel.name, shortName: kernel.shortName, family: kernel.family, durations: [], devices: new Set(), streams: new Set(), kernels: [] });
    const row = byName.get(kernel.name);
    row.durations.push(kernel.dur);
    row.devices.add(kernel.device);
    row.streams.add(kernel.stream);
    row.kernels.push(kernel.index);
    if (!byFamily.has(kernel.family)) byFamily.set(kernel.family, { family: kernel.family, durations: [], names: new Set() });
    const family = byFamily.get(kernel.family);
    family.durations.push(kernel.dur);
    family.names.add(kernel.name);
  }
  const rows = [...byName.values()].map((row) => {
    const stats = durationStats(row.durations);
    return {
      name: row.name,
      shortName: row.shortName,
      family: row.family,
      count: stats.count,
      sumUs: stats.sumUs,
      avgUs: stats.avgUs,
      minUs: stats.minUs,
      maxUs: stats.maxUs,
      p50Us: stats.p50Us,
      p99Us: stats.p99Us,
      devices: [...row.devices].sort((a, b) => a - b),
      streams: [...row.streams].sort((a, b) => a - b),
      kernelIndex: row.kernels[0],
    };
  });
  const families = [...byFamily.values()].map((family) => {
    const stats = durationStats(family.durations);
    return {
      family: family.family,
      variants: family.names.size,
      count: stats.count,
      sumUs: stats.sumUs,
      avgUs: stats.avgUs,
      p50Us: stats.p50Us,
      p99Us: stats.p99Us,
    };
  });
  const totalKernelUs = index.kernels.reduce((sum, kernel) => sum + kernel.dur, 0);
  const aggregates = { rows, families, totalKernelUs };
  index.__aggregates = aggregates;
  return aggregates;
}

export function traceSummary(index) {
  const { rows, families, totalKernelUs } = aggregateKernels(index);
  const topByTime = rows.slice().sort((a, b) => b.sumUs - a.sumUs).slice(0, 10);
  const topFamilies = families.slice().sort((a, b) => b.sumUs - a.sumUs).slice(0, 8);
  return {
    traceId: index.traceId,
    name: index.name,
    sourcePath: index.sourcePath,
    createdAt: index.createdAt,
    displayTimeUnit: index.displayTimeUnit,
    window: index.window,
    counts: index.counts,
    lanes: index.lanes.slice(0, TRACE_LIMITS.maxTimelineLanes),
    laneCount: index.lanes.length,
    totalKernelUs,
    kernelNameCount: rows.length,
    topKernels: topByTime,
    topFamilies,
  };
}

function matchesQuery(row, query) {
  if (!query) return true;
  const needle = query.toLowerCase();
  return row.name.toLowerCase().includes(needle) || row.family.toLowerCase().includes(needle);
}

export function queryKernels(index, options = {}) {
  const { rows } = aggregateKernels(index);
  const sort = typeof options.sort === 'string' ? options.sort : 'sum';
  const direction = options.direction === 'asc' ? 1 : -1;
  const query = typeof options.query === 'string' ? options.query.trim() : '';
  const limit = Math.min(TRACE_LIMITS.maxKernelsPerPage, Math.max(1, Number.isFinite(options.limit) ? Math.trunc(options.limit) : 100));
  const offset = Math.max(0, Number.isFinite(options.offset) ? Math.trunc(options.offset) : 0);
  const key = {
    sum: (row) => row.sumUs,
    count: (row) => row.count,
    avg: (row) => row.avgUs,
    max: (row) => row.maxUs,
    p99: (row) => row.p99Us,
    name: (row) => row.shortName,
  }[sort] ?? ((row) => row.sumUs);
  const filtered = rows.filter((row) => matchesQuery(row, query));
  filtered.sort((a, b) => {
    if (sort === 'name') return (direction * a.shortName.localeCompare(b.shortName)) || (b.sumUs - a.sumUs);
    return ((key(a) - key(b)) * direction) || b.sumUs - a.sumUs;
  });
  const page = filtered.slice(offset, offset + limit);
  return {
    traceId: index.traceId,
    total: rows.length,
    matched: filtered.length,
    offset,
    limit,
    sort,
    direction: options.direction === 'asc' ? 'asc' : 'desc',
    rows: page.map((row) => ({
      ...row,
      shareOfKernelTime: totalKernelUsOf(index) > 0 ? row.sumUs / totalKernelUsOf(index) : 0,
    })),
  };
}

function totalKernelUsOf(index) {
  return aggregateKernels(index).totalKernelUs;
}

function opChain(index, op) {
  const chain = [];
  let cursor = op;
  const seen = new Set();
  while (cursor && !seen.has(cursor.index)) {
    seen.add(cursor.index);
    chain.push({
      index: cursor.index,
      name: cursor.name,
      category: cursor.category,
      ts: cursor.ts,
      dur: cursor.dur,
      inputs: cursor.inputs,
      source: cursor.source,
    });
    cursor = cursor.parentIndex === null ? null : index.ops[cursor.parentIndex];
  }
  return chain.reverse();
}

function neighbourhood(index, kernel) {
  const lane = index.byLane.get(kernel.lane) ?? [];
  let position = -1;
  for (let i = 0; i < lane.length; i += 1) {
    if (lane[i].index === kernel.index) { position = i; break; }
  }
  const before = position < 0 ? [] : lane.slice(Math.max(0, position - TRACE_LIMITS.neighbourCount), position).reverse();
  const after = position < 0 ? [] : lane.slice(position + 1, position + 1 + TRACE_LIMITS.neighbourCount);
  const shape = (row) => ({
    index: row.index,
    shortName: row.shortName,
    family: row.family,
    ts: row.ts,
    dur: row.dur,
    gapUs: 0,
  });
  const prev = before.map(shape);
  const next = after.map(shape);
  for (let i = 0; i < prev.length; i += 1) {
    const neighbour = lane[position - 1 - i];
    const farther = i + 1 < before.length ? lane[position - 2 - i] : null;
    prev[i].gapUs = kernel.ts - (neighbour.ts + neighbour.dur);
    if (farther) prev[i].gapUs = Math.max(0, prev[i].gapUs);
  }
  for (let i = 0; i < next.length; i += 1) {
    const neighbour = lane[position + 1 + i];
    next[i].gapUs = Math.max(0, neighbour.ts - kernel.end);
  }
  return { prev, next, lanePosition: position, laneCount: lane.length };
}

/** One kernel, with the launching op, full call stack and neighbour kernels. */
export function kernelDetail(index, kernelIndex) {
  const numeric = Number(kernelIndex);
  const kernel = Number.isInteger(numeric) && numeric >= 0 ? index.kernels[numeric] : null;
  if (!kernel) return null;
  const { rows } = aggregateKernels(index);
  const aggregate = rows.find((row) => row.name === kernel.name) ?? null;
  const op = kernel.opIndex === null ? null : index.ops[kernel.opIndex];
  const stack = op ? opChain(index, op) : [];
  const inputs = op?.inputs ?? stack.map((entry) => entry.inputs).filter(Boolean).pop() ?? null;
  const source = op?.source ?? stack.map((entry) => entry.source).filter(Boolean).pop() ?? null;
  const sameDtype = inputs?.types ?? null;
  return {
    traceId: index.traceId,
    kernel: {
      index: kernel.index,
      name: kernel.name,
      shortName: kernel.shortName,
      family: kernel.family,
      ts: kernel.ts,
      dur: kernel.dur,
      end: kernel.end,
      device: kernel.device,
      stream: kernel.stream,
      lane: kernel.lane,
      correlation: kernel.correlation,
      grid: kernel.grid,
      block: kernel.block,
      registers: kernel.registers,
      sharedMemory: kernel.sharedMemory,
      occupancy: kernel.occupancy,
      launchOp: op ? { index: op.index, name: op.name, category: op.category, source: op.source } : null,
    },
    aggregate: aggregate ? {
      count: aggregate.count,
      sumUs: aggregate.sumUs,
      avgUs: aggregate.avgUs,
      minUs: aggregate.minUs,
      maxUs: aggregate.maxUs,
      p50Us: aggregate.p50Us,
      p99Us: aggregate.p99Us,
      shareOfKernelTime: totalKernelUsOf(index) > 0 ? aggregate.sumUs / totalKernelUsOf(index) : 0,
    } : null,
    inputs,
    dtypes: sameDtype,
    source,
    stack,
    launchOp: op ? { name: op.name, category: op.category, externalId: op.externalId } : null,
    neighbours: neighbourhood(index, kernel),
    window: {
      startTs: Math.max(index.window.startTs, kernel.ts - Math.max(kernel.dur * 20, 1000)),
      endTs: Math.min(index.window.endTs, kernel.end + Math.max(kernel.dur * 20, 1000)),
    },
  };
}

function laneSortKey(lane) {
  return [Number(lane.device) || 0, Number(lane.stream) || 0];
}

export function queryTimeline(index, options = {}) {
  const window = index.window;
  const requestedFrom = finite(options.from);
  const requestedTo = finite(options.to);
  const from = requestedFrom === null ? window.startTs : Math.max(window.startTs, requestedFrom);
  const to = requestedTo === null ? window.endTs : Math.min(window.endTs, requestedTo);
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  const limit = Math.min(TRACE_LIMITS.maxTimelineSpans, Math.max(1, Number.isFinite(options.limit) ? Math.trunc(options.limit) : TRACE_LIMITS.maxTimelineSpans));
  const maxLanes = Math.min(TRACE_LIMITS.maxTimelineLanes, Math.max(1, Number.isFinite(options.lanes) ? Math.trunc(options.lanes) : TRACE_LIMITS.maxTimelineLanes));
  const wantedLane = typeof options.lane === 'string' && options.lane !== '' ? options.lane : null;
  const lanes = index.lanes
    .filter((lane) => wantedLane === null || lane.lane === wantedLane)
    .slice(0, maxLanes);
  const keep = new Set(lanes.map((lane) => lane.lane));
  const spans = [];
  let matched = 0;
  for (const kernel of index.allSorted) {
    if (!keep.has(kernel.lane)) continue;
    if (kernel.end < start || kernel.ts > end) continue;
    matched += 1;
    if (spans.length >= limit) continue;
    spans.push({
      id: kernel.index,
      lane: kernel.lane,
      device: kernel.device,
      stream: kernel.stream,
      ts: kernel.ts,
      dur: kernel.dur,
      name: kernel.shortName,
      fullName: kernel.name,
      category: 'kernel',
    });
  }
  return {
    traceId: index.traceId,
    window: index.window,
    from: start,
    to: end,
    lanes: lanes.map((lane) => ({
      lane: lane.lane,
      device: lane.device,
      stream: lane.stream,
      label: lane.label,
      kernelCount: lane.kernelCount,
      totalDurUs: lane.totalDurUs,
    })),
    laneCount: index.lanes.length,
    lanesShown: lanes.length,
    matched,
    truncated: matched > spans.length,
    spans,
  };
}

/** Deterministic ordering helper used by tests and by the fusion action. */
export function sortLanes(lanes) {
  return lanes.slice().sort((a, b) => {
    const [ad, as] = laneSortKey(a);
    const [bd, bs] = laneSortKey(b);
    return ad - bd || as - bs;
  });
}
