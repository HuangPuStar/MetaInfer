#!/usr/bin/env node
/**
 * Boot-time deep-link recovery:
 *  1. ?project=...&tab=... opens the Lab panel and the tab from a cold module.
 *  2. A stripped URL (login 303) restores metainfer:last-route from localStorage.
 *  3. Returning to the project list clears the persisted route.
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React from 'react';
import { createRoot } from 'react-dom/client';

const failures = [];
let checks = 0;
function check(name, condition, detail = '') {
  checks += 1;
  if (condition) process.stdout.write(`ok   ${name}\n`);
  else failures.push(name + (detail === '' ? '' : ': ' + detail));
}
async function wait(ms = 50) { await new Promise((resolve) => setTimeout(resolve, ms)); }
let scenario = 0;

async function boot({ url, saved = null }) {
  scenario += 1;
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url, pretendToBeVisual: true });
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
  globalThis.__METAINFER_OPERATOR_TOKEN__ = 'deep-link-test-token';
  window.__METAINFER_TEST__ = true;
  if (saved !== null) window.localStorage.setItem('metainfer:last-route', JSON.stringify(saved));
  const projectId = saved?.projectId ?? new URL(url).searchParams.get('project') ?? 'p1';
  const state = {
    project: { id: projectId, name: 'Project ' + projectId, mode: 'manual', revision: 1, repo: { path: '/tmp/' + projectId, branch: 'main', baseCommit: 'abcdef0' }, config: {}, nodes: [], edges: [] },
    nodes: [{ id: 'n1', title: 'Node One', status: 'completed', prompt: 'p', needs: {}, resourcesHeld: {}, attempts: [], report: {} }],
    edges: [], resources: {}, worktreeRoot: '', revision: 1, auto: null, nextCursor: null,
  };
  globalThis.fetch = async (url) => {
    const text = String(url);
    let payload = {};
    if (text.includes('/experts')) payload = { experts: [], curator: null };
    else if (text.includes('/runs')) payload = { runs: [], cycles: [] };
    else if (text.includes('/events')) payload = { events: [], next: 0 };
    else if (text.includes('/copilot')) payload = { sessions: [] };
    else if (text.includes('/dashboard')) payload = { projectId, widgets: [], events: [], chat: [] };
    else if (text.includes('/models')) payload = { providers: [], profiles: [] };
    else if (text.includes('/health')) payload = { ok: true };
    else if (text.includes('/state')) payload = state;
    else if (text.includes('/projects')) payload = { projects: [state.project] };
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
  };
  let factory = null;
  window.__ModuleLoader__ = { load({ factory: captured }) { factory = captured; } };
  await import(`../client.js?deep-link-boot-selftest=${scenario}`);
  const module = factory((id) => {
    if (id === 'react') return React;
    throw new Error(`unexpected require(${id})`);
  });
  return { dom, module, host: window.document.body };
}

async function renderPage(module, host) {
  const mount = document.createElement('div');
  host.appendChild(mount);
  const root = createRoot(mount);
  await React.act(async () => {
    root.render(React.createElement(module.__components.MetainferLabPage, { t: (key) => key }));
    await wait(90);
  });
  return { root, mount };
}

// 1. Cold start with the query intact.
{
  const { module } = await boot({ url: 'http://localhost/?project=p1&tab=experts&node=n1' });
  const testing = module.__testing;
  check('boot route reads project/tab/node from the URL',
    testing.readBootLabRoute().projectId === 'p1'
    && testing.readBootLabRoute().tab === 'experts'
    && testing.readBootLabRoute().nodeId === 'n1');
  let selected = null;
  const restored = testing.restoreBootLabRoute((panelId) => { selected = panelId; });
  check('restoring a boot route selects the Lab main panel', restored === true && selected === 'metainfer-research-lab', String(selected));
  const { root, mount } = await renderPage(module, document.body);
  check('a query deep link mounts the Experts tab',
    mount.querySelector('[role="tab"][aria-selected="true"]')?.id === 'metainfer-project-tab-experts');
  await React.act(async () => { root.unmount(); });
  mount.remove();
}

// 2. The login 303 stripped the query; localStorage carries the route.
{
  const saved = { projectId: 'prj-e1cbb8e1', tab: 'sessions', nodeId: 'n1' };
  const { module } = await boot({ url: 'http://localhost/', saved });
  const testing = module.__testing;
  check('empty query falls back to metainfer:last-route',
    testing.readBootLabRoute().projectId === saved.projectId
    && testing.readBootLabRoute().tab === 'sessions');
  let selected = null;
  let registrations = 0;
  const ctx = {
    effect(fn) { fn(); },
    locale: { register() {}, bind() { return (key) => key; } },
    slots: {
      inject(name, fn) { registrations += 1; fn(); },
      register(meta, component) { return { meta, component }; },
    },
    layout: { selectPanel(id) { selected = id; } },
    sessions: {}, sidebarRight: {}, uiWorkspace: {},
  };
  module.apply(ctx);
  await wait(80);
  check('plugin apply auto-selects the Lab panel from the persisted route',
    selected === 'metainfer-research-lab' && registrations >= 4,
    JSON.stringify({ selected, registrations }));
  const { root, mount } = await renderPage(module, document.body);
  check('the restored route mounts the Sessions tab',
    mount.querySelector('[role="tab"][aria-selected="true"]')?.id === 'metainfer-project-tab-sessions');
  check('the restored route is written back into the URL',
    new URL(window.location.href).searchParams.get('project') === saved.projectId
    && new URL(window.location.href).searchParams.get('tab') === 'sessions'
    && new URL(window.location.href).searchParams.get('node') === 'n1',
    window.location.href);
  const back = mount.querySelector('button[aria-label="ws.back"]') ?? Array.from(mount.querySelectorAll('button')).find((button) => button.textContent === 'ws.back');
  check('the workspace exposes a project-list back button', back !== undefined);
  await React.act(async () => {
    back?.click();
    await wait(50);
  });
  check('returning to the project list clears the persisted route',
    window.localStorage.getItem('metainfer:last-route') === null,
    String(window.localStorage.getItem('metainfer:last-route')));
  check('returning to the project list no longer shows project tabs',
    mount.querySelectorAll('[role="tab"]').length === 0);
  await React.act(async () => { root.unmount(); });
  mount.remove();
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`FAIL ${failure}\n`);
  process.exit(1);
}
process.stdout.write(`deep-link-boot-selftest: all ${checks} checks passed\n`);
