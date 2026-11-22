#!/usr/bin/env node
/**
 * Trace-viewer UI regression (issue #94 follow-up: standard Perfetto UI).
 *
 * Mounts the real `ProfilerTab` in jsdom with a small fetch fixture and drives
 * the operator path: open a trace, complete the Perfetto PING/PONG handshake and
 * assert the raw bytes are posted to the iframe, pick a kernel from the rail,
 * use the nine Agent actions, and materialise a DAG node from a span.
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React from 'react';
import { createRoot } from 'react-dom/client';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/?project=p1&tab=trace',
  pretendToBeVisual: true,
});
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.localStorage = window.localStorage;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.MessageEvent = window.MessageEvent;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.__METAINFER_OPERATOR_TOKEN__ = 'profiler-test-token';
window.__METAINFER_TEST__ = true;

const failures = [];
function check(name, condition, detail = '') {
  if (condition) process.stdout.write(`ok   ${name}\n`);
  else failures.push(name + (detail === '' ? '' : ': ' + detail));
}
async function wait(ms = 40) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

let factory = null;
window.__ModuleLoader__ = { load({ factory: captured }) { factory = captured; } };
await import('../client.js?profiler-ui-selftest=2');
const module = factory((id) => {
  if (id === 'react') return React;
  throw new Error(`unexpected require(${id})`);
});
const ProfilerTab = module.__components.ProfilerTab;
assert.equal(typeof ProfilerTab, 'function', 'ProfilerTab is exported for the jsdom test');

const TRACE = {
  displayTimeUnit: 'ms',
  traceEvents: [
    { ph: 'M', name: 'thread_name', pid: 0, tid: 7, args: { name: 'stream 7' } },
    { ph: 'X', cat: 'cpu_op', name: 'aten::mm', pid: 1, tid: 1, ts: 100, dur: 300, args: { 'External id': 10, 'Input Dims': [[32, 64], [64, 128]], 'Input type': ['Float', 'Float'], source: 'model.py:42' } },
    { ph: 'X', cat: 'kernel', name: 'ampere_sgemm_128x64_nn', pid: 0, tid: 7, ts: 1000, dur: 400, args: { correlation: 10, device: 0, stream: 7, grid: [128, 1, 1], block: [128, 1, 1] } },
    { ph: 'X', cat: 'kernel', name: 'void at::native::vectorized_elementwise_kernel<4, float>', pid: 0, tid: 7, ts: 1500, dur: 100, args: { device: 0, stream: 7 } },
  ],
};
const TRACE_TEXT = JSON.stringify(TRACE);

const SUMMARY = {
  traceId: 'tr_1', name: 'torch-demo.json', createdAt: 1, displayTimeUnit: 'ms',
  window: { startTs: 100, endTs: 1600, durationUs: 1500 },
  counts: { kernels: 2, ops: 1, events: 4 },
  lanes: [{ lane: 'gpu0:s7', device: 0, stream: 7, kernelCount: 2 }],
};
const KERNELS = {
  traceId: 'tr_1', total: 2, matched: 2, offset: 0, limit: 200, sort: 'sum', direction: 'desc',
  rows: [
    { name: 'ampere_sgemm_128x64_nn', shortName: 'ampere_sgemm_128x64_nn', family: 'ampere_sgemm_128x64_nn', count: 1, sumUs: 400, avgUs: 400, minUs: 400, maxUs: 400, p50Us: 400, p99Us: 400, devices: [0], streams: [7], kernelIndex: 0, shareOfKernelTime: 0.8 },
    { name: 'void at::native::vectorized_elementwise_kernel<4, float>', shortName: 'void at::native::vectorized_elementwise_kernel<…>', family: 'void at::native::vectorized_elementwise_kernel', count: 1, sumUs: 100, avgUs: 100, minUs: 100, maxUs: 100, p50Us: 100, p99Us: 100, devices: [0], streams: [7], kernelIndex: 1, shareOfKernelTime: 0.2 },
  ],
};
const ACTIONS = ['bound', 'implementation', 'code-path', 'call-context', 'shapes', 'fusion', 'optimize', 'explain', 'ask']
  .map((id) => ({ id, kind: id === 'fusion' || id === 'optimize' ? 'node' : 'chat' }));
const DETAIL = {
  traceId: 'tr_1',
  kernel: {
    index: 0, name: 'ampere_sgemm_128x64_nn', shortName: 'ampere_sgemm_128x64_nn', family: 'ampere_sgemm_128x64_nn',
    ts: 1000, dur: 400, end: 1400, device: 0, stream: 7, lane: 'gpu0:s7', correlation: 10,
    grid: [128, 1, 1], block: [128, 1, 1], registers: 64, sharedMemory: 8192, occupancy: 62,
    launchOp: { name: 'aten::mm' },
  },
  aggregate: { count: 1, sumUs: 400, avgUs: 400, minUs: 400, maxUs: 400, p50Us: 400, p99Us: 400, shareOfKernelTime: 0.8 },
  inputs: { dims: [[32, 64], [64, 128]], types: ['Float', 'Float'] },
  dtypes: ['Float', 'Float'],
  source: 'model.py:42',
  stack: [{ name: 'aten::mm', category: 'cpu_op', source: 'model.py:42' }],
  launchOp: { name: 'aten::mm', category: 'cpu_op', externalId: 10 },
  neighbours: { prev: [], next: [{ shortName: 'vectorized', dur: 100, gapUs: 100 }] },
  window: { startTs: 900, endTs: 1500 },
};

const calls = [];
let chatMessages = [];
let createdNode = null;
globalThis.fetch = async (url, init = {}) => {
  const text = String(url);
  const method = String(init.method ?? 'GET').toUpperCase();
  const parsed = new URL(text, 'http://localhost');
  calls.push({ method, path: parsed.pathname + parsed.search, body: init.body });
  const view = parsed.searchParams.get('view');
  if (parsed.pathname.endsWith('/trace') && view === 'bytes') {
    const bytes = new TextEncoder().encode(TRACE_TEXT);
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      json: async () => TRACE,
      text: async () => TRACE_TEXT,
    };
  }
  let data = {};
  if (method === 'POST' && parsed.pathname.endsWith('/commands')) {
    const body = JSON.parse(String(init.body ?? '{}'));
    if (body.type === 'trace.open') data = { traceId: 'tr_1' };
    else if (body.type === 'trace.close') data = { closed: true };
    else if (body.type === 'project.chat') {
      chatMessages = [...chatMessages, { role: 'user', text: body.text, at: 1 }, { role: 'assistant', text: 'answer about the kernel', at: 2 }];
      data = { messages: chatMessages };
    } else if (body.type === 'trace.task') {
      createdNode = body;
      data = { node: { id: 'n-0042', title: 'Kernel fusion 研究', parentId: null } };
    }
  } else if (parsed.pathname.endsWith('/trace')) {
    const traceId = parsed.searchParams.get('traceId');
    if (!traceId) data = { traces: [{ traceId: 'tr_1', name: 'torch-demo.json' }] };
    else if (view === 'summary') data = SUMMARY;
    else if (view === 'kernels') data = KERNELS;
    else if (view === 'kernel') data = { detail: DETAIL, actions: ACTIONS };
    else if (view === 'prompt') data = { prompt: `PROMPT:${parsed.searchParams.get('action')}:${parsed.searchParams.get('kernel')}` };
  } else if (parsed.pathname.endsWith('/chat')) {
    data = { projectId: 'p1', messages: chatMessages };
  }
  return { ok: true, status: 200, json: async () => ({ ok: true, data }), text: async () => JSON.stringify({ ok: true, data }) };
};

const host = window.document.createElement('div');
window.document.body.appendChild(host);
const root = createRoot(host);
const t = (key, vars) => (vars && typeof vars === 'object' ? key + JSON.stringify(vars) : key);
await React.act(async () => {
  root.render(React.createElement(ProfilerTab, { projectId: 'p1', t, active: true }));
  await wait(120);
});

check('the trace tab root renders', host.querySelector('[data-testid="trace-view"]') !== null);
const frame = host.querySelector('iframe.rl-trace-frame');
check('the embedded Perfetto UI iframe is present', frame !== null && String(frame.getAttribute('src')).includes('/metainfer/perfetto/'));
check('embedded mode is requested', String(frame?.getAttribute('src')).includes('mode=embedded'));
check('the opened-trace inventory is fetched on mount',
  calls.some((call) => call.method === 'GET' && call.path.includes('/trace') && !call.path.includes('traceId')));

// Spy on the iframe channel, then complete the handshake.
const posted = [];
if (frame !== null) frame.contentWindow.postMessage = (data, origin, transfer) => { posted.push({ data, origin, transfer }); };
await wait(200);
check('the host pings the iframe until PONG', posted.some((entry) => entry.data === 'PING'));
const pong = new window.MessageEvent('message', { data: 'PONG' });
Object.defineProperty(pong, 'source', { value: frame?.contentWindow });
await React.act(async () => {
  window.dispatchEvent(pong);
  await wait(80);
});

// Open the fixture trace from the recent list.
const recentButton = Array.from(host.querySelectorAll('.rl-trace-recent-item'))[0];
check('the fetched trace is offered as a recent entry', recentButton !== undefined);
await React.act(async () => {
  recentButton?.click();
  await wait(250);
});
check('opening a recent trace fetches its summary',
  calls.some((call) => call.path.includes('view=summary') && call.path.includes('traceId=tr_1')));
check('the summary line reports the trace name and counts',
  (host.querySelector('.rl-trace-summary')?.textContent ?? '').includes('torch-demo.json'));
check('the raw trace bytes are fetched for Perfetto',
  calls.some((call) => call.path.includes('view=bytes')));
const tracePost = posted.find((entry) => entry.data && entry.data.perfetto && entry.data.perfetto.buffer);
check('the trace buffer is posted to the embedded UI',
  tracePost !== undefined && tracePost.data.perfetto.title === 'torch-demo.json',
  JSON.stringify(posted.filter((entry) => entry.data && entry.data.perfetto).map((entry) => Object.keys(entry.data.perfetto))));
check('the buffer is transferred, not copied', Array.isArray(tracePost?.transfer) && tracePost.transfer.length === 1);


// Kernel rail: rows, selection, detail and the Perfetto viewport jump.
const rows = host.querySelectorAll('.rl-trace-krow');
check('the kernel rail lists the parsed kernels', rows.length === 2, String(rows.length));
await React.act(async () => {
  rows[0].click();
  await wait(160);
});
check('picking a kernel fetches its detail',
  calls.some((call) => call.path.includes('view=kernel') && call.path.includes('kernel=0')));
check('the detail panel renders the kernel name',
  (host.querySelector('[data-testid="trace-detail"]')?.textContent ?? '').includes('ampere_sgemm_128x64_nn'));
check('the detail panel shows the input shapes',
  (host.querySelector('[data-testid="trace-detail"]')?.textContent ?? '').includes('[[32x64], [64x128]]'));
const actionButtons = Array.from(host.querySelectorAll('.rl-trace-actions button'));
check('the panel lists the nine agent actions', actionButtons.length === 9, String(actionButtons.length));
check('the fusion action is styled as a node action',
  actionButtons.some((button) => button.textContent === t('ws.trace.action.fusion') && button.className.includes('rl-btn-primary')));
const viewPost = posted.find((entry) => entry.data && entry.data.perfetto && Number.isFinite(entry.data.perfetto.timeStart));
check('picking a kernel zooms Perfetto to that slice',
  viewPost !== undefined
  && Math.abs(viewPost.data.perfetto.timeStart - 0.001) < 1e-9
  && Math.abs(viewPost.data.perfetto.timeEnd - 0.0014) < 1e-9,
  JSON.stringify(viewPost?.data?.perfetto));

const currentActionButtons = () => Array.from(host.querySelectorAll('.rl-trace-actions button'));
const boundButton = currentActionButtons().find((button) => button.textContent === t('ws.trace.action.bound'));
await React.act(async () => {
  boundButton?.click();
  await wait(1800);
});
check('a chat action asks the Host for a prompt then posts it to project.chat',
  calls.some((call) => call.path.includes('view=prompt') && call.path.includes('action=bound'))
  && calls.some((call) => call.method === 'POST' && String(call.body ?? '').includes('"type":"project.chat"')));
check('the agent answer is rendered in the panel',
  (host.querySelector('.rl-trace-chat')?.textContent ?? '').includes('answer about the kernel'));

const optimizeButton = currentActionButtons().find((button) => button.textContent === t('ws.trace.action.optimize'));
await React.act(async () => {
  optimizeButton?.click();
  await wait(60);
});
const dialog = host.querySelector('[role="dialog"]');
check('a node action opens the timebox dialog', dialog !== null);
check('the dialog explains that a root node will be created',
  (dialog?.textContent ?? '').includes(t('ws.trace.nodeHint')));
const createButton = Array.from(dialog?.querySelectorAll('button') ?? []).find((button) => button.textContent === t('ws.trace.nodeCreate'));
await React.act(async () => {
  createButton?.click();
  await wait(140);
});
check('confirming posts trace.task with the kernel index and action',
  createdNode?.type === 'trace.task' && createdNode?.kernelIndex === 0 && createdNode?.action === 'optimize',
  JSON.stringify(createdNode));
check('the created node id is surfaced to the operator',
  (host.querySelector('[data-testid="trace-detail"]')?.textContent ?? '').includes('n-0042'));

// Rail back button returns to the kernel list without another fetch storm.
const backButton = Array.from(host.querySelectorAll('[data-testid="trace-detail"] button')).find((button) => String(button.textContent).startsWith('←'));
await React.act(async () => {
  backButton?.click();
  await wait(80);
});
check('the rail returns to the kernel list', host.querySelectorAll('.rl-trace-krow').length === 2);


// Self-hosted hook: a selection message inside Perfetto must drive the rail.
const selectionEvent = new window.MessageEvent('message', {
  data: { metainfer: { selection: { text: 'Name ampere_sgemm_128x64_nn Start 1.0 ms Duration 400 us', at: 1 } } },
});
Object.defineProperty(selectionEvent, 'source', { value: frame?.contentWindow });
await React.act(async () => {
  window.dispatchEvent(selectionEvent);
  await wait(200);
});
check('a slice selected inside Perfetto opens that kernel in the rail',
  calls.some((call) => call.path.includes('view=kernel') && call.path.includes('kernel=0'))
  && (host.querySelector('[data-testid="trace-detail"]')?.textContent ?? '').includes('ampere_sgemm_128x64_nn'));

if (failures.length > 0) {
  console.error(`\nprofiler-ui-selftest: ${failures.length} check(s) failed`);
  for (const failure of failures) console.error(' - ' + failure);
  process.exit(1);
}
console.log('\nprofiler-ui-selftest: all checks passed');
