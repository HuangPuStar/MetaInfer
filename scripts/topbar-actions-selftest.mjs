#!/usr/bin/env node
/**
 * Duplicate-entry guard: the workspace top bar owns exactly seven actions.
 * The old observability/dashboard/runs/settings/trajectory shortcuts are gone;
 * their capabilities live in the seven tabs and the project menu.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import React from 'react';
import { createRoot } from 'react-dom/client';

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const source = await readFile(path.join(rootDir, 'client.js'), 'utf8');
const start = source.indexOf('    function WorkspaceTopBar({');
const end = source.indexOf('    /** Resources currently held by running nodes', start);
assert.ok(start > 0 && end > start, 'WorkspaceTopBar source not found');
const topbar = source.slice(start, end);
const actionIds = [...topbar.matchAll(/['"]data-testid['"]: '(topbar-action-[a-z-]+)'/g)].map((match) => match[1]);

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/?project=p1&tab=dag', pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.__METAINFER_OPERATOR_TOKEN__ = 'topbar-test-token';
dom.window.__METAINFER_TEST__ = true;
const failures = [];
let checks = 0;
function check(name, condition, detail = '') {
  checks += 1;
  if (condition) process.stdout.write(`ok   ${name}\n`);
  else failures.push(name + (detail === '' ? '' : ': ' + detail));
}

check('topbar declares exactly seven action ids', JSON.stringify(actionIds) === JSON.stringify([
  'topbar-action-mode', 'topbar-action-auto', 'topbar-action-experts', 'topbar-action-step',
  'topbar-action-menu', 'topbar-action-copilot', 'topbar-action-replay',
]), JSON.stringify(actionIds));
for (const forbidden of ['📊', 't(\'ws.runs.open\')', 't(\'dashboard.toggle\')', 't(\'ws.settings.open\')', 'trajectory.open', 'onToggleDashboard', 'onToggleObservability', 'onOpenSettings', 'onOpenRuns']) {
  check('topbar source has no ' + forbidden, !topbar.includes(forbidden));
}
check('SettingsModal has no expert-library entry', !source.slice(source.indexOf('    function SettingsModal('), source.indexOf('    function SettingsTab(')).includes('obs-expert-library'));

let factory = null;
dom.window.__ModuleLoader__ = { load({ factory: captured }) { factory = captured; } };
await import('../client.js?topbar-actions-selftest=1');
const module = factory((id) => {
  if (id === 'react') return React;
  throw new Error(`unexpected require(${id})`);
});
const components = module.__components;
assert.equal(typeof components.WorkspaceTopBar, 'function');

const host = document.createElement('div');
document.body.appendChild(host);
const root = createRoot(host);
const noop = () => {};
const project = {
  id: 'p1', name: 'Project One', config: {},
  repo: { path: '/tmp/p1', branch: 'main', baseCommit: 'abcdef0' },
};
await React.act(async () => {
  root.render(React.createElement(components.WorkspaceTopBar, {
    project,
    resources: {},
    revision: 1,
    nodeCount: 5,
    runningCount: 0,
    stepBusy: false,
    auto: null,
    activeTab: 'dag',
    onSelectTab: noop,
    pendingProposals: 0,
    autoBusy: false,
    onStep: noop,
    onOpenExperts: noop,
    replayOpen: false,
    onToggleReplay: noop,
    onAutoStart: noop,
    onAutoStop: noop,
    onAutoResume: noop,
    onManualMode: noop,
    onViewPending: noop,
    projectMenuOpen: false,
    onToggleProjectMenu: noop,
    onCloseProjectMenu: noop,
    onDeleteProject: noop,
    onPush: noop,
    onOpenClusterConfig: noop,
    onOpenCluster: noop,
    runs: [],
    copilotOpen: false,
    onToggleCopilot: noop,
    onBack: noop,
    t: (key) => key,
  }));
  await new Promise((resolve) => setTimeout(resolve, 20));
});
const renderedActions = host.querySelectorAll('[data-testid^="topbar-action-"]');
check('rendered topbar has exactly seven action groups', renderedActions.length === 7, String(renderedActions.length));
const text = host.textContent ?? '';
for (const forbidden of ['📊', '运行记录', 'ws.runs.open', 'dashboard.toggle', 'ws.settings.open', 'trajectory.open', '⚙']) {
  check('rendered topbar does not show ' + forbidden, !text.includes(forbidden));
}
check('topbar keeps the expert group action', text.includes('ws.experts.chipIdle'));

await React.act(async () => root.unmount());
host.remove();
if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`FAIL ${failure}\n`);
  process.exit(1);
}
process.stdout.write(`topbar-actions-selftest: all ${checks} checks passed\n`);
