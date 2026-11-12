#!/usr/bin/env node
/**
 * Phase-3 project pages: settings/migration, sessions and audit tabs. The Host
 * is never contacted; every route is a deterministic fixture.
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/?project=p1&tab=settings',
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
const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');

globalThis.__METAINFER_OPERATOR_TOKEN__ = 'project-pages-token';
window.__METAINFER_TEST__ = true;

const failures = [];
let checks = 0;
function check(name, condition, detail = '') {
  checks += 1;
  if (condition) process.stdout.write(`ok   ${name}\n`);
  else failures.push(name + (detail === '' ? '' : ': ' + detail));
}
async function wait(ms = 50) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
function setValue(element, value) {
  const proto = element.tagName === 'SELECT'
    ? window.HTMLSelectElement.prototype
    : (element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype);
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value);
  element.dispatchEvent(new window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  if (element.tagName !== 'SELECT') element.dispatchEvent(new window.Event('change', { bubbles: true }));
}
function buttonByText(host, text) {
  return Array.from(host.querySelectorAll('button')).find((button) => button.textContent === text) ?? null;
}

let factory = null;
window.__ModuleLoader__ = { load({ factory: captured }) { factory = captured; } };
await import('../client.js?project-pages-selftest=1');
assert.equal(typeof factory, 'function');
const module = factory((id) => {
  if (id === 'react') return React;
  throw new Error(`unexpected require(${id})`);
});
const components = module.__components;
for (const name of ['SettingsTab', 'SessionsTab', 'AuditTab']) assert.equal(typeof components[name], 'function', name);

const project = {
  id: 'p1', name: 'Project One', mode: 'manual', revision: 3,
  repo: { path: '/tmp/p1', branch: 'main', baseCommit: 'abcdef0' },
  config: {
    migration: { phase: 1 }, expertsMode: 'legacy-cycle',
    dispatch: { strategy: 'shadow-deterministic' }, contest: { mode: 'off' },
    resourcePools: { gpu: 1 }, reviewers: [], modelOptions: [], promptDefaults: {},
  },
  nodes: [], edges: [],
};
const nodes = [
  {
    id: 'n1', title: 'Node One', status: 'completed', prompt: 'p', attempts: [
      { attempt: 1, status: 'completed', sessionId: 'sess-n1', startedAt: 1700000000000, endedAt: 1700000100000 },
    ], timestamps: { startedAt: 1700000000000, completedAt: 1700000100000 },
  },
  {
    id: 'n2', title: 'Node Pending', status: 'running', prompt: 'p', attempts: [],
    pendingHighReview: { deadlineAt: 1700000200000 },
  },
];
const events = [
  { seq: 1, type: 'ledger/open', at: 1700000000000, data: { id: 'h1', hypothesis: 'Cache is cold', nodeId: 'n1', expertId: 'lab-advisor', evidence: [] } },
  { seq: 2, type: 'ledger/confirm', at: 1700000100000, data: { id: 'h1', note: 'Reproduced', evidence: [] } },
  { seq: 3, type: 'ledger/open', at: 1700000200000, data: { id: 'h2', hypothesis: 'GPU oversubscribed', nodeId: 'n2', evidence: [] } },
  { seq: 4, type: 'ledger/rule_out', at: 1700000300000, data: { id: 'h2', reason: 'Lease was idle', evidence: [] } },
  { seq: 5, type: 'node/high_review_resolved', at: 1700000400000, nodeId: 'n1', data: { nodeId: 'n1', decision: 'defer', resolvedBy: 'chief:1', rationale: 'Wait for a slot', reasonCode: 'budget_shift', rule: 'review-rule' } },
];
const commands = [];
globalThis.fetch = async (url, options = {}) => {
  const text = String(url);
  let payload = {};
  if (text.includes('/copilot')) payload = { projectId: 'p1', sessionId: 'sess-copilot', sessions: [{ id: 'sess-copilot', title: 'Investigate cache', updatedAt: 1700000500000 }] };
  else if (text.includes('/runs')) payload = { runs: [{ id: 'run-1', role: 'advisor', status: 'completed', sessionId: 'sess-run', startedAt: 1700000000000 }, { id: 'run-2', role: 'worker', status: 'failed', errorCode: 'timeout', errorDetail: 'worker timed out', endedAt: 1700000600000 }], cycles: [] };
  else if (text.includes('/events')) payload = { events, next: 5 };
  else if (text.includes('/disputes')) payload = { disputes: [] };
  else if (text.includes('/command')) { commands.push(JSON.parse(options.body ?? '{}')); payload = { ok: true, projectId: 'p1', phase: 2 }; }
  else payload = {};
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
};

const t = (key) => key;
async function render(component, props) {
  const host = window.document.createElement('div');
  window.document.body.appendChild(host);
  const root = createRoot(host);
  await React.act(async () => {
    root.render(React.createElement(component, { t, ...props }));
    await wait(80);
  });
  return { host, root };
}

const settings = await render(components.SettingsTab, {
  project, projectId: 'p1', cluster: null, catalogProviders: null, promptDefaults: null, promptPlaceholders: [],
  onSave: async () => ({ ok: true }), onSavePlacementPolicy: async () => ({ ok: true }), reload: () => {},
});
check('settings is a page, not an overlay', settings.host.querySelector('[role="dialog"]') === null && settings.host.querySelector('[data-testid="settings-tab"]') !== null);
check('settings page keeps the project configuration editor', settings.host.querySelector('.rl-settings-section') !== null);
check('settings page exposes the migration phase control', settings.host.querySelector('[data-testid="settings-migration"]') !== null);
const advance = buttonByText(settings.host, 'ws.settings.migration.advance');
check('migration cannot advance without the parity acknowledgement', advance !== null && advance.disabled);
const parity = settings.host.querySelector('[data-testid="settings-migration"] input[type="checkbox"]');
await React.act(async () => {
  parity.click();
  await wait(20);
});
check('checking parity enables the phase-2 advance', buttonByText(settings.host, 'ws.settings.migration.advance')?.disabled !== true);
await React.act(async () => {
  buttonByText(settings.host, 'ws.settings.migration.advance')?.click();
  await wait(60);
});
check('advancing sends one migration command', commands.length === 1 && commands[0].type === 'migration.advance' && commands[0].phase === 2, JSON.stringify(commands));
check('phase 2 sends the expert mode and dispatch switch', commands[0]?.expertsMode === 'hierarchy' && commands[0]?.dispatchStrategy === 'shadow-deterministic', JSON.stringify(commands));

let openedSession = null;
const sessions = await render(components.SessionsTab, {
  projectId: 'p1', nodes,
  onOpenSession: (sessionId, view, nodeId) => { openedSession = { sessionId, view, nodeId }; },
});
check('sessions page lists Copilot sessions', sessions.host.textContent.includes('Investigate cache'));
check('sessions page lists node execution records', sessions.host.textContent.includes('sess-n1'));
check('sessions page lists cycle runs', sessions.host.textContent.includes('run-1'));
const openButtons = Array.from(sessions.host.querySelectorAll('button')).filter((button) => button.textContent === 'ws.sessions.open');
await React.act(async () => {
  openButtons[0]?.click();
  await wait(20);
});
check('opening a Copilot session uses the native opener', openedSession?.sessionId === 'sess-copilot' && openedSession?.view === 'chat', JSON.stringify(openedSession));
const filter = sessions.host.querySelector('select');
await React.act(async () => {
  setValue(filter, 'n1');
  await wait(40);
});
const filteredRows = Array.from(sessions.host.querySelectorAll('.rl-session-run-row')).map((row) => row.textContent);
check('node filter narrows the execution records', filteredRows.some((row) => row.includes('sess-n1')) && !filteredRows.some((row) => row.includes('Node Pending')), JSON.stringify(filteredRows));

let openedNode = null;
const audit = await render(components.AuditTab, {
  projectId: 'p1', nodes, onOpenNode: (nodeId) => { openedNode = nodeId; },
});
check('audit page projects the hypothesis ledger', audit.host.textContent.includes('Cache is cold') && audit.host.textContent.includes('GPU oversubscribed'));
check('audit page counts open, confirmed and ruled-out hypotheses', audit.host.textContent.includes('ws.audit.ledger.counts'));
check('audit page renders the resolved high-review chain with actor and rationale', audit.host.textContent.includes('chief:1') && audit.host.textContent.includes('Wait for a slot'));
check('audit page shows a pending high review', audit.host.textContent.includes('ws.audit.highReview.pending'));
const auditOpen = Array.from(audit.host.querySelectorAll('button')).find((button) => button.textContent === 'ws.audit.openNode');
await React.act(async () => {
  auditOpen?.click();
  await wait(20);
});
check('audit rows jump back to the node', openedNode === 'n1' || openedNode === 'n2', String(openedNode));

const observability = await render(components.ObservabilityDrawer, { projectId: 'p1', embedded: true });
await React.act(async () => {
  buttonByText(observability.host, 'ws.obs.tab.failures')?.click();
  await wait(90);
});
check('observability clusters failed runs by errorCode', observability.host.querySelector('[data-testid="obs-failures"]') !== null && observability.host.textContent.includes('timeout'));

if (failures.length > 0) {
  for (const failure of failures) process.stdout.write(`FAIL ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`project-pages-selftest: all ${checks} checks passed\n`);
}
