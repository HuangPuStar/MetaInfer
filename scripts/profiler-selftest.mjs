/**
 * Offline self-test for the profiling trace viewer index (issue #94).
 * Run from the plugin directory: `node scripts/profiler-selftest.mjs`
 */
import assert from 'node:assert/strict';
import { buildTraceIndex, kernelDetail, parseTraceDocument, queryKernels, queryTimeline, shortKernelName, traceSummary } from '../host/profiler/trace.js';
import { buildActionPrompt, buildNodeTask, PROFILE_ACTIONS, PROMPT_LIMIT } from '../host/profiler/prompts.js';
import { injectPerfettoHook, perfettoMimeOf, resolvePerfettoPath } from '../host/profiler/perfetto-assets.js';

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

const ATTN = 'void at::native::vectorized_elementwise_kernel<4, at::native::binary_internal::MulFunctor<float>, std::array<char*, 3ul> >(int, float, float*, float*, float*)';
const GEMM = 'ampere_sgemm_128x64_nn';

/** A minimal but realistic torch.profiler chrome trace. */
function fixture() {
  return {
    displayTimeUnit: 'ms',
    traceEvents: [
      { ph: 'M', name: 'process_name', pid: 0, args: { name: 'GPU 0' } },
      { ph: 'M', name: 'thread_name', pid: 0, tid: 7, args: { name: 'stream 7' } },
      { ph: 'M', name: 'process_name', pid: 1, args: { name: 'python' } },
      { ph: 'M', name: 'thread_name', pid: 1, tid: 1, args: { name: 'python thread 1' } },
      // CPU stack: forward -> mm -> cudaLaunchKernel
      { ph: 'X', cat: 'python_function', name: 'model.forward', pid: 1, tid: 1, ts: 100, dur: 900 },
      { ph: 'X', cat: 'cpu_op', name: 'aten::mm', pid: 1, tid: 1, ts: 200, dur: 300, args: { 'External id': 10, 'Input Dims': [[32, 64], [64, 128]], 'Input type': ['Float', 'Float'], source: 'model.py:42' } },
      { ph: 'X', cat: 'cuda_runtime', name: 'cudaLaunchKernel', pid: 1, tid: 1, ts: 210, dur: 40, args: { 'External id': 11 } },
      { ph: 'X', cat: 'cpu_op', name: 'aten::mul', pid: 1, tid: 1, ts: 500, dur: 200, args: { 'External id': 20, 'Input Dims': [[128, 128], [128, 128]], 'Input type': ['Float', 'Float'], source: 'model.py:43' } },
      // GPU kernels
      { ph: 'X', cat: 'kernel', name: GEMM, pid: 0, tid: 7, ts: 1000, dur: 400, args: { correlation: 10, device: 0, stream: 7, grid: [128, 1, 1], block: [128, 1, 1], 'registers per thread': 64, 'shared memory': 8192, 'est. achieved occupancy %': 62 } },
      { ph: 'X', cat: 'kernel', name: ATTN, pid: 0, tid: 7, ts: 1500, dur: 100, args: { correlation: 20, device: 0, stream: 7, grid: [256, 1, 1], block: [128, 1, 1], 'registers per thread': 24, 'shared memory': 0, 'est. achieved occupancy %': 88 } },
      { ph: 'X', cat: 'kernel', name: ATTN, pid: 0, tid: 7, ts: 1700, dur: 120, args: { correlation: 20, device: 0, stream: 7, grid: [256, 1, 1], block: [128, 1, 1], 'registers per thread': 24, 'shared memory': 0, 'est. achieved occupancy %': 88 } },
      { ph: 'X', cat: 'gpu_memory', name: '[memory]', pid: 0, tid: 0, ts: 900, dur: 1200, args: {} },
      { ph: 'f', cat: 'ac2g', name: 'flow', pid: 1, tid: 1, ts: 220 },
    ],
  };
}

let index = null;

test('shortKernelName keeps a compact balanced label', () => {
  const short = shortKernelName(ATTN);
  assert.equal(short.startsWith('void at::native::vectorized_elementwise_kernel'), true);
  assert.equal(short.includes('MulFunctor'), false, 'template body is collapsed');
  assert.equal(shortKernelName(GEMM), GEMM);
});

test('parse rejects documents without traceEvents', () => {
  assert.throws(() => parseTraceDocument('{"nope":1}', { traceId: 't', name: 'x.json' }), /traceEvents/);
  assert.throws(() => parseTraceDocument('not json', { traceId: 't', name: 'x.json' }), /not valid JSON/);
});

test('buildTraceIndex counts spans, kernels, lanes and window', () => {
  index = buildTraceIndex({ traceId: 'tr_test', name: 'torch_trace.json', events: fixture().traceEvents, displayTimeUnit: 'ms' });
  assert.equal(index.counts.kernels, 3);
  assert.equal(index.counts.ops, 4, 'python_function + 2 cpu_op + cuda_runtime');
  assert.equal(index.counts.memorySpans, 1);
  assert.deepEqual(index.window, { startTs: 100, endTs: 1820, durationUs: 1720 });
  assert.equal(index.lanes.length, 1);
  assert.equal(index.lanes[0].lane, 'gpu0:s7');
  assert.equal(index.lanes[0].label, 'stream 7');
  assert.equal(index.lanes[0].kernelCount, 3);
});

test('correlation links each kernel to its launching CPU op and inputs', () => {
  const gemm = index.kernels.find((kernel) => kernel.name === GEMM);
  assert.equal(gemm.opName, 'aten::mm');
  const detail = kernelDetail(index, gemm.index);
  assert.equal(detail.launchOp.name, 'aten::mm');
  assert.deepEqual(detail.inputs.dims, [[32, 64], [64, 128]]);
  assert.deepEqual(detail.dtypes, ['Float', 'Float']);
  assert.equal(detail.source, 'model.py:42');
});

test('the call stack is ordered from the root to the launching op', () => {
  const attn = index.kernels.find((kernel) => kernel.name === ATTN);
  const detail = kernelDetail(index, attn.index);
  const names = detail.stack.map((entry) => entry.name);
  assert.deepEqual(names, ['model.forward', 'aten::mul']);
});

test('kernel aggregates group repeated launches', () => {
  const summary = traceSummary(index);
  assert.equal(summary.kernelNameCount, 2);
  const mul = summary.topKernels.find((row) => row.name === ATTN);
  assert.equal(mul.count, 2);
  assert.equal(mul.sumUs, 220);
  assert.equal(mul.avgUs, 110);
  assert.equal(mul.minUs, 100);
  assert.equal(mul.maxUs, 120);
  assert.equal(summary.totalKernelUs, 620);
  assert.equal(summary.topFamilies.length, 2);
});

test('kernel queries sort, filter, page and carry a time share', () => {
  const bySum = queryKernels(index, { sort: 'sum' });
  assert.equal(bySum.total, 2);
  assert.equal(bySum.rows[0].name, GEMM, 'the 400us launch outranks the two 110us launches');
  assert.equal(Math.round(bySum.rows[0].shareOfKernelTime * 1000) / 1000, 0.645);
  const byCount = queryKernels(index, { sort: 'count', query: 'vectorized' });
  assert.equal(byCount.matched, 1);
  assert.equal(byCount.rows[0].count, 2);
  const paged = queryKernels(index, { limit: 1, offset: 1, sort: 'name', direction: 'asc' });
  assert.equal(paged.rows.length, 1);
  assert.equal(paged.offset, 1);
});

test('timeline windows clamp to the requested range and keep lane order', () => {
  const all = queryTimeline(index, {});
  assert.equal(all.spans.length, 3);
  assert.equal(all.truncated, false);
  assert.equal(all.lanes[0].lane, 'gpu0:s7');
  const windowed = queryTimeline(index, { from: 1450, to: 1650 });
  assert.equal(windowed.spans.length, 1, 'a span overlapping the window is kept');
  assert.equal(windowed.spans[0].name.startsWith('void at::native::vectorized'), true);
  const limited = queryTimeline(index, { limit: 2 });
  assert.equal(limited.spans.length, 2);
  assert.equal(limited.truncated, true);
  assert.equal(limited.matched, 3);
});

test('neighbours expose gaps on the same stream for fusion analysis', () => {
  const first = kernelDetail(index, 0);
  assert.equal(first.neighbours.prev.length, 0);
  assert.equal(first.neighbours.next.length, 2);
  assert.equal(first.neighbours.next[0].gapUs, 100, '1500 - (1000+400)');
  const second = kernelDetail(index, 1);
  assert.equal(second.neighbours.prev[0].shortName, GEMM);
  assert.equal(second.neighbours.next[0].gapUs, 100, '1700 - 1600');
});

test('detail is null for an unknown index and actions embed the span context', () => {
  assert.equal(kernelDetail(index, 9999), null);
  assert.equal(kernelDetail(index, -1), null);
  const detail = kernelDetail(index, 0);
  const bound = buildActionPrompt(detail, 'bound');
  assert.equal(bound.includes(GEMM), true);
  assert.equal(bound.includes('grid=[128x1x1]'), true);
  assert.equal(bound.includes('compute bound'), true);
  assert.equal(buildActionPrompt(detail, 'shapes').includes('[[32x64], [64x128]]'), true);
  assert.throws(() => buildActionPrompt(detail, 'nope'), /unknown profiler action/);
  assert.throws(() => buildActionPrompt(detail, 'ask'), /question is required/);
});

test('every action stays under the project chat limit', () => {
  const detail = kernelDetail(index, 0);
  const longAsk = 'x'.repeat(4000);
  for (const action of PROFILE_ACTIONS) {
    const prompt = buildActionPrompt(detail, action.id, { question: longAsk });
    assert.equal(prompt.length <= PROMPT_LIMIT, true, `${action.id} prompt is ${prompt.length}`);
    assert.equal(prompt.includes('### Profiling span context'), true, `${action.id} embeds the context block`);
  }
});

test('node tasks exist only for fusion and optimisation', () => {
  const detail = kernelDetail(index, 1);
  const fusion = buildNodeTask(detail, 'fusion');
  assert.equal(fusion.title.includes('fusion'), true);
  assert.equal(fusion.prompt.includes('相邻 kernel'), true);
  assert.equal(fusion.prompt.length <= 7600, true);
  const optimize = buildNodeTask(detail, 'optimize');
  assert.equal(optimize.title.startsWith('定向优化'), true);
  assert.throws(() => buildNodeTask(detail, 'bound'), /does not create a node/);
});

test('a trace with only CPU ops still parses (kernel-less export)', () => {
  const cpuOnly = buildTraceIndex({
    traceId: 'tr_cpu',
    name: 'cpu.json',
    events: [{ ph: 'X', cat: 'cpu_op', name: 'aten::add', pid: 1, tid: 1, ts: 0, dur: 5, args: { 'External id': 1 } }],
  });
  assert.equal(cpuOnly.counts.kernels, 0);
  assert.equal(cpuOnly.lanes.length, 0);
  assert.equal(queryTimeline(cpuOnly, {}).spans.length, 0);
});

test('empty traces are rejected with a named code', () => {
  try {
    buildTraceIndex({ traceId: 'tr_e', name: 'empty.json', events: [{ ph: 'M', name: 'process_name', pid: 0, args: { name: 'GPU 0' } }] });
    assert.fail('expected a rejection');
  } catch (error) {
    assert.equal(error.code, 'trace_empty');
  }
});

test('the Perfetto hook is injected once into index.html', () => {
  const html = '<html><body><div id="app"></div></body></html>';
  const injected = injectPerfettoHook(html);
  assert.equal(injected.includes('/metainfer/perfetto/hook.js'), true);
  assert.equal(injected.indexOf('</body>') > injected.indexOf('hook.js'), true);
  assert.equal(injectPerfettoHook(injected), injected, 'injection is idempotent');
  assert.equal(injectPerfettoHook(''), '');
});

test('the static Perfetto handler refuses traversal and maps MIME types', () => {
  assert.equal(resolvePerfettoPath('/srv/perfetto', '/v59.1/index.html'), '/srv/perfetto/v59.1/index.html');
  assert.equal(resolvePerfettoPath('/srv/perfetto', '/../../etc/passwd'), null);
  assert.equal(resolvePerfettoPath('/srv/perfetto', 'v59.1/../../../etc/passwd'), null);
  assert.equal(perfettoMimeOf('a.wasm'), 'application/wasm');
  assert.equal(perfettoMimeOf('a.woff2'), 'font/woff2');
  assert.equal(perfettoMimeOf('a.unknown'), 'application/octet-stream');
});

const failures = results.filter((row) => !row.ok);
for (const row of results) {
  if (row.ok) {
    console.log(`ok   ${row.name}`);
  } else {
    console.error(`FAIL ${row.name}`);
    console.error(row.error);
  }
}
console.log(`\n${results.length - failures.length}/${results.length} passed`);
if (failures.length > 0) process.exitCode = 1;
