#!/usr/bin/env node
/**
 * Client module surface guard.
 *
 * Extracting a component once deleted a neighbouring function (`replaySnapshot`)
 * because the replacement spanned "until the next doc comment" — type checks and
 * the panel smoke test both stayed green, and the failure only appeared when the
 * replay tab rendered.
 *
 * This probe pins the module surface that other code (and the UI) depends on:
 * every required internal must still be declared in the source *and* reachable
 * through the test exports, and every required component must still be a function.
 * Adding a new required entry is cheap; silently losing one is now loud.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import React from 'react';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

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
globalThis.__METAINFER_OPERATOR_TOKEN__ = 'surface-token';

const failures = [];
function check(name, condition, detail = '') {
  if (condition) process.stdout.write(`ok   ${name}\n`);
  else failures.push(name + (detail === '' ? '' : ': ' + detail));
}

/** Internals other modules/probes call directly. */
const REQUIRED_DAG = [
  'buildDagScene',
  'visibleDagItems',
  'hitTestDag',
  'paintDag',
  'dagTheme',
  'nodeActionsOf',
  'inspectorSectionIndexes',
  'replaySnapshot',
];

/** Components the pages mount by name. */
const REQUIRED_COMPONENTS = [
  'MetainferLabPage',
  'WorkspaceScreen',
  'DagCanvas',
  'NodeRail',
  'NodeDetailWindow',
  'NodeInspector',
  'HistoryModal',
  'WalLogPanel',
  'WalDetailDialog',
  'ProfilerTab',
  'NodeTraceSection',
  'SettingsModal',
  'RunsPanel',
  'ProjectsPanel',
];

const source = await readFile(path.join(ROOT, 'client.js'), 'utf8');

let factory = null;
window.__ModuleLoader__ = { load({ factory: captured }) { factory = captured; } };
await import('../client.js?surface-selftest=1');
const mod = factory((id) => {
  if (id === 'react') return React;
  throw new Error(`unexpected require(${id})`);
});

// 1) declared in the source, with the exact name the rest of the file calls
for (const name of [...REQUIRED_DAG, ...REQUIRED_COMPONENTS]) {
  check(`client.js still declares ${name}`,
    new RegExp(`\\bfunction ${name}\\s*\\(`).test(source) || new RegExp(`\\bconst ${name}\\s*=`).test(source));
}

// 2) reachable through the exports the probes use
const dag = mod.__dag ?? {};
for (const name of REQUIRED_DAG) {
  const value = dag[name];
  check(`__dag exports ${name}`, value !== undefined && value !== null,
    typeof value);
}
check('NODE_WINDOW_TABS is exported as a non-empty list',
  Array.isArray(dag.NODE_WINDOW_TABS) && dag.NODE_WINDOW_TABS.length === 5,
  JSON.stringify(dag.NODE_WINDOW_TABS));

const components = mod.__components ?? {};
for (const name of REQUIRED_COMPONENTS) {
  check(`__components exports ${name}`, typeof components[name] === 'function', typeof components[name]);
}

// 3) the replay snapshot remains callable and graph-shaped
assert.equal(typeof dag.replaySnapshot, 'function');
const snapshot = dag.replaySnapshot({
  startAt: 0,
  endAt: 10,
  nodes: [{ id: 'n-1', status: 'completed', timestamps: { createdAt: 1 } }],
  edges: [],
  events: [],
}, 5);
check('replaySnapshot still returns {nodes, edges}',
  snapshot !== null && Array.isArray(snapshot.nodes) && Array.isArray(snapshot.edges) && snapshot.nodes.length === 1);

process.stdout.write(`\nclient-surface-selftest: ${failures.length === 0 ? 'all checks passed' : failures.length + ' check(s) failed'}\n`);
for (const failure of failures) process.stdout.write(` - ${failure}\n`);
process.exit(failures.length === 0 ? 0 : 1);
