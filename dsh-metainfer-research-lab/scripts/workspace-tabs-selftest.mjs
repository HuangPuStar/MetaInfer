#!/usr/bin/env node
/**
 * Project tab shell regression: deep links, lazy mounting and keyboard/History
 * navigation. The Host is never contacted; every route is a small fixture.
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React from 'react';
import { createRoot } from 'react-dom/client';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/?project=p1&tab=experts&node=n1',
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
globalThis.__METAINFER_OPERATOR_TOKEN__ = 'tab-test-token';
window.__METAINFER_TEST__ = true;

const failures = [];
function check(name, condition, detail = '') {
  if (condition) process.stdout.write(`ok   ${name}\n`);
  else failures.push(name + (detail === '' ? '' : ': ' + detail));
}
async function wait(ms = 35) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

let factory = null;
window.__ModuleLoader__ = {
  load({ factory: captured }) { factory = captured; },
};
await import('../client.js?workspace-tabs-selftest=1');
assert.equal(typeof factory, 'function');
const module = factory((id) => {
  if (id === 'react') return React;
  throw new Error(`unexpected require(${id})`);
});
const components = module.__components;
assert.equal(typeof components.MetainferLabPage, 'function');

const requests = [];
const project = {
  id: 'p1', name: 'Project One', mode: 'manual', revision: 2,
  repo: { path: '/tmp/p1', branch: 'main', baseCommit: 'abcdef0' },
  config: {}, nodes: [], edges: [],
};
const state = {
  project,
  nodes: [{ id: 'n1', title: 'Node One', status: 'completed', prompt: 'p', needs: {}, resourcesHeld: {}, attempts: [], report: {} }],
  edges: [], resources: {}, worktreeRoot: '', revision: 2, auto: null, nextCursor: null,
};
globalThis.fetch = async (url) => {
  const text = String(url);
  requests.push(text);
  let payload = {};
  if (text.includes('/experts')) payload = { experts: [{ id: 'lab-advisor', name: 'Advisor', lifecycle: { status: 'active' }, metrics: {} }], curator: null };
  else if (text.includes('/runs')) payload = { runs: [], cycles: [] };
  else if (text.includes('/events')) payload = { events: [], next: 0 };
  else if (text.includes('/dashboard')) payload = { projectId: 'p1', widgets: [], events: [], chat: [] };
  else if (text.includes('/models')) payload = { providers: [], profiles: [] };
  else if (text.includes('/health')) payload = { ok: true };
  else if (text.includes('/state')) payload = state;
  else if (text.includes('/projects')) payload = { projects: [project] };
  else payload = {};
  return {
    ok: true, status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
};

const host = window.document.createElement('div');
window.document.body.appendChild(host);
const root = createRoot(host);
const t = (key) => key;
await React.act(async () => {
  root.render(React.createElement(components.MetainferLabPage, { t }));
  await wait(90);
});

const tabs = () => Array.from(host.querySelectorAll('[role="tab"]'));
const selectedTab = () => host.querySelector('[role="tab"][aria-selected="true"]');
const activePanel = () => host.querySelector('[role="tabpanel"]:not([hidden])');

check('deep link starts on the experts tab', selectedTab()?.id === 'metainfer-project-tab-experts', selectedTab()?.id);
check('deep link keeps the node in the URL', new URL(window.location.href).searchParams.get('node') === 'n1', window.location.href);
check('the initial DAG tab is not mounted for an experts deep link',
  host.querySelector('.rl-workspace-grid') === null);
check('the experts panel is lazily mounted on first visit',
  activePanel()?.getAttribute('data-tab') === 'experts' && requests.some((url) => url.includes('/experts')));

await React.act(async () => {
  host.querySelector('#metainfer-project-tab-observability').click();
  await wait(60);
});
check('clicking a tab mounts its panel', host.querySelector('[data-tab="observability"]') !== null);
check('tab navigation pushes a history entry and updates the URL',
  new URL(window.location.href).searchParams.get('tab') === 'observability',
  window.location.href);
check('the node parameter is preserved across tabs',
  new URL(window.location.href).searchParams.get('node') === 'n1');

const stateCallsBeforeDag = requests.filter((url) => url.includes('/state')).length;
await React.act(async () => {
  host.querySelector('#metainfer-project-tab-dag').click();
  await wait(60);
});
check('DAG mounts on demand without a full state refetch',
  activePanel()?.getAttribute('data-tab') === 'dag'
  && host.querySelector('.rl-workspace-grid') !== null
  && requests.filter((url) => url.includes('/state')).length === stateCallsBeforeDag,
  JSON.stringify({ before: stateCallsBeforeDag, after: requests.filter((url) => url.includes('/state')).length }));

await React.act(async () => {
  const active = selectedTab();
  active.focus();
  active.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await wait(60);
});
check('ArrowRight moves focus and selection to the next tab',
  selectedTab()?.id === 'metainfer-project-tab-observability'
  && new URL(window.location.href).searchParams.get('tab') === 'observability',
  window.location.href);

const beforeBack = window.location.href;
await React.act(async () => {
  window.history.back();
  await wait(100);
});
check('Back restores the previous tab from the URL',
  window.location.href !== beforeBack
  && selectedTab()?.id === 'metainfer-project-tab-dag'
  && activePanel()?.getAttribute('data-tab') === 'dag',
  JSON.stringify({ beforeBack, href: window.location.href, selected: selectedTab()?.id }));

await React.act(async () => root.unmount());
host.remove();
if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`FAIL ${failure}\n`);
  process.exit(1);
}
process.stdout.write('workspace-tabs-selftest: all checks passed\n');
