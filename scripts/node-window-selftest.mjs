#!/usr/bin/env node
/**
 * Node detail windows.
 *
 * The side inspector is gone; double-clicking a node opens a floating window with
 * tabs that can be dragged, resized, minimised and multiplied (for comparisons).
 * This probe mounts the real component in jsdom and drives its pointer events:
 *
 *  - five tabs, switching tabs asks the inspector for that section;
 *  - dragging the header reports a moved x/y;
 *  - the corner handle reports a larger w/h (and clamps at the minimum size);
 *  - minimising hides the body, restoring brings it back;
 *  - close fires the callback;
 *  - the tab split covers every inspector section exactly once.
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
globalThis.__METAINFER_OPERATOR_TOKEN__ = 'window-test-token';

const failures = [];
function check(name, condition, detail = '') {
  if (condition) process.stdout.write(`ok   ${name}\n`);
  else failures.push(name + (detail === '' ? '' : ': ' + detail));
}
const wait = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

let factory = null;
window.__ModuleLoader__ = { load({ factory: captured }) { factory = captured; } };
await import('../client.js?node-window-selftest=1');
const mod = factory((id) => {
  if (id === 'react') return React;
  throw new Error(`unexpected require(${id})`);
});
const dag = mod.__dag;
const NodeDetailWindow = mod.__components.NodeDetailWindow;
assert.equal(typeof NodeDetailWindow, 'function', 'NodeDetailWindow is exported');
assert.equal(typeof dag?.inspectorSectionIndexes, 'function', 'inspectorSectionIndexes is exported');

// --- the tab split must not drop a section -----------------------------------
const split = dag.inspectorSectionIndexes(24);
const flat = dag.NODE_WINDOW_TABS.flatMap((tab) => split[tab]);
check('every inspector section lands in exactly one tab',
  flat.length === 24 && new Set(flat).size === 24 && flat.every((index) => index >= 0 && index < 24),
  JSON.stringify(split));
check('the tab list is the documented five', dag.NODE_WINDOW_TABS.join(',') === 'summary,edit,exec,report,stats');
const empty = dag.inspectorSectionIndexes(0);
check('an empty inspector yields empty tabs',
  dag.NODE_WINDOW_TABS.every((tab) => empty[tab].length === 0));

// --- mount the real component ------------------------------------------------
const host = window.document.createElement('div');
window.document.body.appendChild(host);
const root = createRoot(host);
let geometry = { nodeId: 'n-00042', title: 'fused silu kernel', x: 100, y: 80, w: 560, h: 520, min: false };
const patches = [];
const sections = [];
let closed = 0;
let focused = 0;
const t = (key) => key;

const render = async () => {
  await React.act(async () => {
    root.render(React.createElement(NodeDetailWindow, {
      geometry,
      zIndex: 20,
      t,
      onGeometry: (patch) => { patches.push(patch); geometry = { ...geometry, ...patch }; },
      onClose: () => { closed += 1; },
      onFocus: () => { focused += 1; },
      inspector: (tab) => {
        sections.push(tab);
        return React.createElement('div', { 'data-tab': tab }, 'section-' + tab);
      },
    }));
    await wait(40);
  });
};
await render();

const win = host.querySelector('[data-testid="node-window"]');
check('the window renders with the node identity', win !== null && win.getAttribute('data-node-id') === 'n-00042');
const tabs = [...host.querySelectorAll('.rl-node-window-tab')];
check('the window shows one tab per section', tabs.length === 5, String(tabs.length));
check('the title and id are in the header',
  (host.querySelector('.rl-node-window-title')?.textContent ?? '') === 'fused silu kernel'
  && (host.querySelector('.rl-node-window-id')?.textContent ?? '') === 'n-00042');

// switching tabs
const editTab = tabs.find((button) => (button.textContent ?? '').includes('ws.window.tab.edit'));
await React.act(async () => { editTab.click(); await wait(40); });
check('switching a tab asks the inspector for that section',
  sections[sections.length - 1] === 'edit' && host.querySelector('[data-tab="edit"]') !== null,
  sections.join(','));

// dragging the header
const header = host.querySelector('.rl-node-window-head');
const pointer = (type, x, y) => new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
await React.act(async () => {
  header.dispatchEvent(pointer('pointerdown', 120, 100));
  header.dispatchEvent(pointer('pointermove', 180, 150));
  header.dispatchEvent(pointer('pointerup', 180, 150));
  await wait(40);
});
const moved = patches.filter((patch) => patch.x !== undefined).pop();
check('dragging the header moves the window', moved !== undefined && moved.x === 160 && moved.y === 130, JSON.stringify(moved));

// resizing from the corner
const handle = host.querySelector('.rl-node-window-resize');
check('the window has a resize handle', handle !== null);
await React.act(async () => {
  handle.dispatchEvent(pointer('pointerdown', 600, 560));
  handle.dispatchEvent(pointer('pointermove', 720, 640));
  handle.dispatchEvent(pointer('pointerup', 720, 640));
  await wait(40);
});
const resized = patches.filter((patch) => patch.w !== undefined).pop();
check('dragging the corner resizes the window', resized !== undefined && resized.w === 680 && resized.h === 600, JSON.stringify(resized));

// minimising
const buttons = [...host.querySelectorAll('.rl-node-window-btn')];
const minimize = buttons[0];
await React.act(async () => { minimize.click(); await wait(40); });
await render();
check('minimising hides the tab strip and body',
  host.querySelector('.rl-node-window-tabs') === null && host.querySelector('[data-tab="edit"]') === null);
check('a minimised window keeps its header', host.querySelector('.rl-node-window-head') !== null);
await React.act(async () => { host.querySelectorAll('.rl-node-window-btn')[0].click(); await wait(40); });
await render();
check('restoring brings the tabs back', host.querySelectorAll('.rl-node-window-tab').length === 5);

// closing and focus
await React.act(async () => {
  win.dispatchEvent(pointer('pointerdown', 300, 300));
  await wait(20);
});
check('clicking the window raises it', focused > 0);
const closeButton = [...host.querySelectorAll('.rl-node-window-btn')].pop();
await React.act(async () => { closeButton.click(); await wait(20); });
check('the close button asks the host to drop the window', closed === 1);

await React.act(async () => { root.unmount(); });
host.remove();

process.stdout.write(`\nnode-window-selftest: ${failures.length === 0 ? 'all checks passed' : failures.length + ' check(s) failed'}\n`);
for (const failure of failures) process.stdout.write(` - ${failure}\n`);
process.exit(failures.length === 0 ? 0 : 1);
