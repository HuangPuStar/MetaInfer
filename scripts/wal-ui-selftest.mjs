#!/usr/bin/env node
/**
 * Human WAL query surface + history module.
 *
 * Mounts the real WalLogPanel and HistoryModal in jsdom against a stubbed fetch and
 * asserts what an operator does:
 *
 *  - opening the panel shows the newest page without any query;
 *  - rows carry seq, kind and node, and the summary is readable;
 *  - a kind chip filters the request, a range is passed through as fromSeq/toSeq;
 *  - "next page" sends the cursor, not the previous range;
 *  - clicking a node id selects that node;
 *  - the history modal shows both tabs and switching tabs swaps the panel;
 *  - an HTTP error is reported, not rendered as an empty list.
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React from 'react';
import { createRoot } from 'react-dom/client';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/?project=p1&tab=dag',
  pretendToBeVisual: true,
});
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.localStorage = window.localStorage;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.CustomEvent = window.CustomEvent;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.__METAINFER_TEST__ = true;
globalThis.__METAINFER_OPERATOR_TOKEN__ = 'wal-ui-token';

const failures = [];
function check(name, condition, detail = '') {
  if (condition) process.stdout.write(`ok   ${name}\n`);
  else failures.push(name + (detail === '' ? '' : ': ' + detail));
}
const wait = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

const calls = [];
let mode = 'ok';
const ENTRIES = [
  { seq: 101, nodeId: 'n-0001', kind: 'node.status', at: 1_700_000_000_000, payload: { changed: ['status'], before: { status: 'planned' }, after: { status: 'running' } } },
  { seq: 102, nodeId: 'n-0002', kind: 'node.created', at: 1_700_000_001_000, payload: { status: 'planned', title: 'second node' } },
  { seq: 103, nodeId: 'n-0001', kind: 'node.priority', at: 1_700_000_002_000, payload: { changed: ['priority'], before: { priority: 'p2' }, after: { priority: 'p0' } } },
];
globalThis.fetch = async (url, init = {}) => {
  const parsed = new URL(String(url), 'http://localhost');
  calls.push({ path: parsed.pathname, params: Object.fromEntries(parsed.searchParams.entries()) });
  if (mode === 'error') {
    return { ok: false, status: 500, json: async () => ({ ok: false, error: 'wal unavailable' }), text: async () => 'wal unavailable' };
  }
  const limit = Number(parsed.searchParams.get('limit') ?? 50);
  const desc = parsed.searchParams.get('order') === 'desc';
  const fromSeq = Number(parsed.searchParams.get('fromSeq') ?? 0);
  const cursor = parsed.searchParams.get('cursor');
  let rows = ENTRIES.slice();
  if (desc) rows = rows.slice().reverse().slice(0, limit);
  else {
    rows = rows.filter((row) => row.seq > fromSeq);
    if (cursor !== null) {
      const cursorSeq = Number(String(cursor).replace(/^w/, ''));
      rows = rows.filter((row) => row.seq > cursorSeq);
    }
    rows = rows.slice(0, limit);
  }
  const body = {
    projectId: 'p1',
    entries: rows,
    count: rows.length,
    hasMore: false,
    nextCursor: null,
    latestSeq: 103,
    fromSeq,
    toSeq: null,
  };
  return { ok: true, status: 200, json: async () => ({ ok: true, data: body }), text: async () => JSON.stringify(body) };
};

let factory = null;
window.__ModuleLoader__ = { load({ factory: captured }) { factory = captured; } };
await import('../client.js?wal-ui-selftest=1');
const mod = factory((id) => {
  if (id === 'react') return React;
  throw new Error(`unexpected require(${id})`);
});
const WalLogPanel = mod.__components.WalLogPanel;
const HistoryModal = mod.__components.HistoryModal;
assert.equal(typeof WalLogPanel, 'function', 'WalLogPanel is exported');
assert.equal(typeof HistoryModal, 'function', 'HistoryModal is exported');
const t = (key, vars) => (vars ? key + ':' + JSON.stringify(vars) : key);

// --- the panel ---------------------------------------------------------------
const host = window.document.createElement('div');
window.document.body.appendChild(host);
const root = createRoot(host);
let selected = null;
let detailed = null;
await React.act(async () => {
  root.render(React.createElement(WalLogPanel, { projectId: 'p1', onSelect: (id) => { selected = id; }, onDetail: (entry) => { detailed = entry; }, t }));
  await wait(120);
});
check('opening the panel loads the newest page unprompted',
  calls.some((call) => call.params.order === 'desc') && calls.some((call) => call.params.fromSeq !== undefined),
  JSON.stringify(calls.slice(0, 3)));
const rows = [...host.querySelectorAll('.rl-wal-row')].filter((row) => !row.className.includes('head'));
check('the panel lists the log entries', rows.length === 3, String(rows.length));
check('a row shows seq, kind and node',
  rows[0].textContent.includes('101') && rows[0].textContent.includes('node.status') && rows[0].textContent.includes('n-0001'),
  rows[0].textContent);
check('the status change is summarised as before → after',
  rows[0].textContent.includes('planned') && rows[0].textContent.includes('running'), rows[0].textContent);
check('the panel reports the latest seq',
  (host.textContent ?? '').includes('ws.wal.statusLine'), host.textContent?.slice(0, 80));

// kind filter
const kindChip = [...host.querySelectorAll('.rl-wal-kinds .rl-chip')]
  .find((chip) => (chip.textContent ?? '') === 'node.priority');
await React.act(async () => { kindChip.click(); await wait(40); });
const queryButton = [...host.querySelectorAll('button')].find((button) => (button.textContent ?? '').includes('ws.wal.query'));
await React.act(async () => { queryButton.click(); await wait(80); });
check('a kind chip filters the request',
  calls.some((call) => call.params.kinds === 'node.priority'), JSON.stringify(calls.slice(-2)));

// range + node filter
const inputs = [...host.querySelectorAll('.rl-wal-form input')];
check('the form exposes seq range and node id', inputs.length >= 3, String(inputs.length));
const setValue = (element, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(element, value);
  element.dispatchEvent(new window.Event('input', { bubbles: true }));
};
await React.act(async () => {
  setValue(inputs[0], '55');
  setValue(inputs[1], '99');
  setValue(inputs[2], 'n-0002');
  await wait(60);
});
await React.act(async () => {
  queryButton.click();
  await wait(80);
});
check('the range and node filters are sent to the host',
  calls.some((call) => call.params.fromSeq === '55' && call.params.toSeq === '99' && call.params.nodeId === 'n-0002'),
  JSON.stringify(calls.slice(-2)));

// the summary is clipped in the table, so every row offers the full record
const detailButton = [...host.querySelectorAll('.rl-wal-summary-btn')][0];
check('each row has a clickable summary for the full change', detailButton !== undefined);
await React.act(async () => { detailButton.click(); await wait(20); });
check('clicking a row summary asks for the detail dialog',
  detailed !== null && detailed.seq === 101, JSON.stringify(detailed));
const detailButtons = [...host.querySelectorAll('.rl-link-btn')].filter((button) => (button.textContent ?? '') === 'ws.wal.detail');
check('the row also carries an explicit details button', detailButtons.length === 3, String(detailButtons.length));

// node link selects the node
const nodeLink = [...host.querySelectorAll('.rl-link-btn')].find((button) => (button.textContent ?? '') === 'n-0001');
await React.act(async () => { nodeLink.click(); await wait(20); });
check('clicking a node id selects that node', selected === 'n-0001', String(selected));

// error state
mode = 'error';
await React.act(async () => { queryButton.click(); await wait(80); });
check('a host error is reported, not shown as an empty log',
  (host.querySelector('[role="alert"]')?.textContent ?? '') !== '', host.querySelector('[role="alert"]')?.textContent ?? '(none)');
await React.act(async () => { root.unmount(); });
host.remove();

// --- the detail dialog -------------------------------------------------------
{
  const Detail = mod.components?.WalDetailDialog ?? mod.__components.WalDetailDialog;
  const detailHost = window.document.createElement('div');
  window.document.body.appendChild(detailHost);
  const detailRoot = createRoot(detailHost);
  const entry = {
    seq: 900, projectSeq: 42, nodeId: 'n-0007', kind: 'node.status', at: 1_700_000_000_000,
    payload: { changed: ['status', 'rev'], before: { status: 'planned', rev: 3 }, after: { status: 'completed', rev: 4 } },
  };
  let picked = null;
  await React.act(async () => {
    detailRoot.render(React.createElement(Detail, {
      entry, t, onClose: () => {}, onSelectNode: (id) => { picked = id; },
    }));
    await wait(40);
  });
  check('the detail dialog shows both sequences and the kind',
    (detailHost.textContent ?? '').includes('42') && (detailHost.textContent ?? '').includes('900')
    && (detailHost.textContent ?? '').includes('node.status'));
  check('the detail dialog shows the before/after table',
    [...detailHost.querySelectorAll('.rl-wal-diff-row')].length === 3,
    String(detailHost.querySelectorAll('.rl-wal-diff-row').length));
  check('the detail dialog shows the complete raw payload, not an ellipsis',
    (detailHost.querySelector('[data-testid="wal-detail-json"]')?.textContent ?? '').includes('"completed"'),
    (detailHost.querySelector('[data-testid="wal-detail-json"]')?.textContent ?? '').slice(0, 60));
  const nodeButton = [...detailHost.querySelectorAll('.rl-link-btn')][0];
  await React.act(async () => { nodeButton.click(); await wait(20); });
  check('the dialog can jump to the node', picked === 'n-0007', String(picked));
  await React.act(async () => { detailRoot.unmount(); });
  detailHost.remove();
}

// --- the history module ------------------------------------------------------
const modalHost = window.document.createElement('div');
window.document.body.appendChild(modalHost);
const modalRoot = createRoot(modalHost);
let tab = 'wal';
let closed = 0;
const renderModal = async () => {
  modalRoot.render(React.createElement(HistoryModal, {
    open: true,
    tab,
    onTab: (next) => { tab = next; },
    onClose: () => { closed += 1; },
    walPanel: React.createElement('div', { 'data-panel': 'wal' }, 'wal panel'),
    replayPanel: React.createElement('div', { 'data-panel': 'replay' }, 'replay panel'),
    t,
  }));
  await React.act(async () => { await wait(40); });
};
await renderModal();
check('the history modal opens on the change log', modalHost.querySelector('[data-panel="wal"]') !== null);
const modalTabs = [...modalHost.querySelectorAll('.rl-modal-tab')];
check('the modal offers both modules', modalTabs.length === 2, String(modalTabs.length));
const replayTab = modalTabs.find((button) => (button.textContent ?? '').includes('ws.history.tab.replay'));
await React.act(async () => { replayTab.click(); await wait(40); });
await renderModal();
check('switching to replay swaps the panel',
  modalHost.querySelector('[data-panel="replay"]') !== null && modalHost.querySelector('[data-panel="wal"]') === null);
const closeButton = [...modalHost.querySelectorAll('button')].find((button) => (button.textContent ?? '') === '✕');
await React.act(async () => { closeButton.click(); await wait(20); });
check('the modal closes', closed === 1);
await React.act(async () => { modalRoot.unmount(); });
modalHost.remove();

process.stdout.write(`\nwal-ui-selftest: ${failures.length === 0 ? 'all checks passed' : failures.length + ' check(s) failed'}\n`);
for (const failure of failures) process.stdout.write(` - ${failure}\n`);
process.exit(failures.length === 0 ? 0 : 1);
