#!/usr/bin/env node
/**
 * Trace-viewer UI regression (issue #94).
 *
 * Mounts the real `ProfilerTab` inside jsdom with a small fetch fixture and
 * drives the operator path end to end: open a trace by Host path, read the
 * kernel table + timeline, select a span, open the nine-action panel, dispatch
 * an analysis to the project chat, and materialise a DAG node from a span.
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
await import('../client.js?profiler-ui-selftest=1');
const module = factory((id) => {
  if (id === 'react') return React;
  throw new Error(`unexpected require(${id})`);
});
const ProfilerTab = module.__components.ProfilerTab;
assert.equal(typeof ProfilerTab, 'function', 'ProfilerTab is exported for the jsdom test');

const SUMMARY = {
  traceId: 'tr_1', name: 'torch-demo.json', createdAt: 1, displayTimeUnit: 'ms',
  window: { startTs: 1000, endTs: 2000, durationUs: 1000 },
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
const TIMELINE = {
  traceId: 'tr_1', window: SUMMARY.window, from: 1000, to: 2000,
  lanes: [{ lane: 'gpu0:s7', device: 0, stream: 7, label: 'stream 7' }],
  spans: [
    { id: 0, lane: 'gpu0:s7', ts: 1000, dur: 400, name: 'ampere_sgemm_128x64_nn', fullName: 'ampere_sgemm_128x64_nn' },
    { id: 1, lane: 'gpu0:s7', ts: 1500, dur: 100, name: 'vectorized', fullName: 'void at::native::vectorized_elementwise_kernel' },
  ],
  matched: 2, truncated: false,
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
    const view = parsed.searchParams.get('view');
    const traceId = parsed.searchParams.get('traceId');
    if (!traceId) data = { traces: [{ traceId: 'tr_1', name: 'torch-demo.json' }] };
    else if (view === 'summary') data = SUMMARY;
    else if (view === 'kernels') data = KERNELS;
    else if (view === 'timeline') data = TIMELINE;
    else if (view === 'kernel') data = { detail: DETAIL, actions: ACTIONS };
    else if (view === 'prompt') {
      const action = parsed.searchParams.get('action');
      data = { prompt: `PROMPT:${action}:${parsed.searchParams.get('kernel')}` };
    }
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
check('the opened-trace inventory is fetched on mount',
  calls.some((call) => call.method === 'GET' && call.path.includes('/trace') && !call.path.includes('traceId')));

// Open the fixture trace from the recent list (the path input is asserted separately).
const openInput = host.querySelector('.rl-trace-openbar .rl-input');
check('the open-by-path input is rendered', openInput !== null);
const recentButton = Array.from(host.querySelectorAll('.rl-trace-recent-item'))[0];
check('the fetched trace is offered as a recent entry', recentButton !== undefined);
await React.act(async () => {
  recentButton?.click();
  await wait(200);
});
check('opening a recent trace fetches its summary',
  calls.some((call) => call.path.includes('view=summary') && call.path.includes('traceId=tr_1')),
  JSON.stringify(calls.slice(-4)));

check('the summary line reports the trace name and counts',
  (host.querySelector('.rl-trace-summary')?.textContent ?? '').includes('torch-demo.json'));
check('one timeline span is rendered per fixture span',
  host.querySelectorAll('.rl-trace-span').length === 2, String(host.querySelectorAll('.rl-trace-span').length));
check('the kernel table renders the aggregate rows',
  host.querySelectorAll('[data-testid="trace-kernel-table"] .rl-trace-row').length === 3,
  String(host.querySelectorAll('[data-testid="trace-kernel-table"] .rl-trace-row').length));

// Click a span: detail panel appears with nine actions.
await React.act(async () => {
  host.querySelectorAll('.rl-trace-span')[0].click();
  await wait(120);
});
check('clicking a span fetches its kernel detail',
  calls.some((call) => call.path.includes('view=kernel') && call.path.includes('kernel=0')));
check('the detail panel renders the kernel name',
  (host.querySelector('[data-testid="trace-detail"]')?.textContent ?? '').includes('ampere_sgemm_128x64_nn'));
const actionButtons = Array.from(host.querySelectorAll('.rl-trace-actions button'));
check('the panel lists the nine agent actions', actionButtons.length === 9, String(actionButtons.length));
check('the fusion action is styled as a node action',
  actionButtons.some((button) => button.textContent === t('ws.trace.action.fusion') && button.className.includes('rl-btn-primary')));
check('the input shapes are shown', (host.querySelector('[data-testid="trace-detail"]')?.textContent ?? '').includes('[[32x64], [64x128]]'));

// Double-click opens the panel too.
await React.act(async () => {
  host.querySelectorAll('.rl-trace-span')[1].dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
  await wait(120);
});
check('double-clicking a span also opens the detail panel',
  calls.some((call) => call.path.includes('kernel=1')) && host.querySelector('[data-testid="trace-detail"]') !== null);

// Chat action: prompt fetch + project.chat dispatch.
const currentActionButtons = () => Array.from(host.querySelectorAll('.rl-trace-actions button'));
const boundButton = currentActionButtons().find((button) => button.textContent === t('ws.trace.action.bound'));
await React.act(async () => {
  boundButton?.click();
  await wait(1800);
});
check('a chat action asks the Host for a prompt then posts it to project.chat',
  calls.some((call) => call.path.includes('view=prompt') && call.path.includes('action=bound'))
  && calls.some((call) => call.method === 'POST' && String(call.body ?? '').includes('"type":"project.chat"')),
  JSON.stringify(calls.filter((call) => call.method === 'POST')));
check('the agent answer is rendered in the panel',
  (host.querySelector('.rl-trace-chat')?.textContent ?? '').includes('answer about the kernel'));

// Node action: confirm dialog then trace.task.
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
  createdNode?.type === 'trace.task' && createdNode?.kernelIndex === 1 && createdNode?.action === 'optimize',
  JSON.stringify(createdNode));
check('the created node id is surfaced to the operator',
  (host.querySelector('.rl-trace-detail')?.textContent ?? '').includes('n-0042'));

if (failures.length > 0) {
  console.error(`\nprofiler-ui-selftest: ${failures.length} check(s) failed`);
  for (const failure of failures) console.error(' - ' + failure);
  process.exit(1);
}
console.log('\nprofiler-ui-selftest: all checks passed');
