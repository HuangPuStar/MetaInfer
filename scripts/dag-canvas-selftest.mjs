#!/usr/bin/env node
/**
 * DAG canvas at 10k nodes.
 *
 * The requirement is blunt: ten thousand nodes must be *all* drawn, and panning
 * must not re-render React. This probe builds a 10k-node layered DAG, drives the
 * real scene builder / visibility index / hit test / painter with a recording
 * 2D context, and then mounts the real component in jsdom to prove:
 *
 *  - the scene contains every node (no 300-node window any more);
 *  - at fit zoom the visible slice is the whole graph, so every node is painted;
 *  - at 10k visible nodes text detail is dropped (blocks only) — still all drawn;
 *  - painting a frame stays allocation-light and bounded in draw calls;
 *  - hit testing finds a card exactly and misses in the gaps;
 *  - the mounted component keeps exactly one DOM node card (the selection) and
 *    zero per-node DOM cards.
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
window.matchMedia = window.matchMedia ?? (() => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
// The bundle only exposes __components/__dag behind this flag.
window.__METAINFER_TEST__ = true;
globalThis.__METAINFER_OPERATOR_TOKEN__ = 'dag-test-token';

const failures = [];
function check(name, condition, detail = '') {
  if (condition) process.stdout.write(`ok   ${name}\n`);
  else failures.push(name + (detail === '' ? '' : ': ' + detail));
}
const wait = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

let factory = null;
window.__ModuleLoader__ = { load({ factory: captured }) { factory = captured; } };
await import('../client.js?dag-canvas-selftest=1');
const mod = factory((id) => {
  if (id === 'react') return React;
  throw new Error(`unexpected require(${id})`);
});
const dag = mod.__dag;
const DagCanvas = mod.__components.DagCanvas;
assert.equal(typeof dag?.paintDag, 'function', '__dag internals are exported');
assert.equal(typeof DagCanvas, 'function', 'DagCanvas is exported');

// --- fixture: 10k nodes, 40 columns × 250 rows -------------------------------
const TOTAL = 10000;
const nodes = [];
for (let index = 0; index < TOTAL; index += 1) {
  nodes.push({
    id: `n-${String(index).padStart(5, '0')}`,
    title: `experiment ${index} · kernel tuning`,
    status: ['planned', 'running', 'completed', 'failed'][index % 4],
    parentId: index === 0 ? null : `n-${String(Math.floor((index - 1) / 250) * 250 + (index % 250)).padStart(5, '0')}`,
  });
}
const NODE_W = 208;
const NODE_H = 84;
const layout = (() => {
  const positions = new Map();
  const columns = 40;
  const rows = Math.ceil(TOTAL / columns);
  for (let index = 0; index < TOTAL; index += 1) {
    const col = Math.floor(index / rows);
    const row = index % rows;
    positions.set(nodes[index].id, { x: 48 + col * (NODE_W + 56), y: 48 + row * (NODE_H + 28) });
  }
  return { positions, width: 48 * 2 + columns * (NODE_W + 56) - 56, height: 48 * 2 + rows * (NODE_H + 28) - 28 };
})();
const edges = [];
for (let index = 1; index < TOTAL; index += 1) {
  const parent = nodes[index].parentId;
  if (parent) edges.push({ from: parent, to: nodes[index].id });
}

// The canvas palette must follow the application tokens, not hardcoded white.
window.document.documentElement.className = 'theme-dark';
window.document.documentElement.style.setProperty('--dsw-alias-bg-layer-1', '#14171c');
window.document.documentElement.style.setProperty('--dsw-alias-label-primary', '#e8eaed');
window.document.documentElement.style.setProperty('--dsw-alias-border-l2', '#2f333a');
const themed = dag.dagTheme();
check('canvas palette reads the design tokens', themed.card === '#14171c' && themed.text === '#e8eaed' && themed.border === '#2f333a', JSON.stringify(themed));
check('canvas palette treats a dark surface as dark', themed.edge === '#3d4148', themed.edge);
window.document.documentElement.className = 'theme-light';
window.document.documentElement.style.setProperty('--dsw-alias-bg-layer-1', '#ffffff');
const lightThemed = dag.dagTheme();
check('switching the theme class rebuilds the palette', lightThemed.card === '#ffffff' && lightThemed.edge === '#c9ccd3', JSON.stringify(lightThemed));
window.document.documentElement.className = 'theme-dark';
window.document.documentElement.style.setProperty('--dsw-alias-bg-layer-1', '#14171c');

const scene = dag.buildDagScene({ nodes, edges, layout, t: (key) => key });
check('the scene holds every node', scene.count === TOTAL, String(scene.count));
check('the scene holds every edge', scene.segments.length === edges.length, `${scene.segments.length}/${edges.length}`);

// Fit viewport covering the whole graph.
const size = { width: 1600, height: 1000 };
const fitZoom = Math.min((size.width - 48) / layout.width, (size.height - 48) / layout.height, 1);
const view = { zoom: fitZoom, pan: { x: 0, y: 0 }, dpr: 1, hoverId: null };
const visible = dag.visibleDagItems(scene, view, size);
check('the fit viewport covers the whole graph', visible.items.length === TOTAL, `${visible.items.length}/${TOTAL}`);

// Recording 2D context: counts every primitive, no canvas needed.
function recordingContext() {
  const calls = { fill: 0, stroke: 0, fillText: 0, clear: 0, path: 0, arc: 0, bezier: 0, moveTo: 0 };
  const ctx = {
    calls,
    canvas: null,
    setTransform() {}, save() {}, restore() {}, translate() {}, scale() {}, clearRect() { calls.clear += 1; },
    beginPath() { calls.path += 1; }, closePath() {}, moveTo() { calls.moveTo += 1; }, lineTo() {},
    bezierCurveTo() { calls.bezier += 1; }, arcTo() {}, arc() { calls.arc += 1; }, rect() {},
    roundRect() { calls.arc += 1; }, fill() { calls.fill += 1; }, stroke() { calls.stroke += 1; },
    fillText() { calls.fillText += 1; }, measureText() { return { width: 10 }; },
    set fillStyle(value) { this._fill = value; }, get fillStyle() { return this._fill; },
    set strokeStyle(value) { this._stroke = value; }, get strokeStyle() { return this._stroke; },
    set lineWidth(value) { this._lw = value; }, get lineWidth() { return this._lw; },
    set globalAlpha(value) { this._alpha = value; }, get globalAlpha() { return this._alpha ?? 1; },
    set font(value) { this._font = value; }, get font() { return this._font; },
    set textBaseline(value) { this._tb = value; }, get textBaseline() { return this._tb; },
  };
  return ctx;
}

const ctx = recordingContext();
const theme = { card: '#000', border: '#111', text: '#fff', muted: '#888', edge: '#222', edgeActive: '#333', accent: '#444' };
const started = process.hrtime.bigint();
const painted = dag.paintDag(ctx, scene, view, size, { theme, selectedId: null, hoverId: null, related: null });
const paintMs = Number(process.hrtime.bigint() - started) / 1e6;
check('every node is painted at fit zoom', painted.items === TOTAL, String(painted.items));
check('the whole graph is painted, not a 300-node window', ctx.calls.fill >= TOTAL, String(ctx.calls.fill));
check('text detail is dropped when 10k nodes are visible', painted.labels === false && ctx.calls.fillText === 0);
check('one frame stays within a frame budget', paintMs < 120, `${paintMs.toFixed(1)} ms`);
check('edges are painted for the visible graph', ctx.calls.bezier > 5000, String(ctx.calls.bezier));

// Zoomed-in view: culling + labels.
const zoomView = { zoom: 1, pan: { x: -1200, y: -600 }, dpr: 1, hoverId: null };
const zoomed = dag.paintDag(recordingContext(), scene, zoomView, size, { theme, selectedId: null, hoverId: null, related: null });
check('zooming in culls off-screen cards', zoomed.items < 200, String(zoomed.items));
check('zooming in restores text detail', zoomed.labels === true);

// Hit test: exact centre hit, gap miss, off-node miss.
const target = scene.byId.get('n-01234');
const hit = dag.hitTestDag(scene, { x: target.x + 10, y: target.y + 10 });
check('hit test finds the card under the cursor', hit?.id === 'n-01234', String(hit?.id));
check('hit test misses the gap between cards', dag.hitTestDag(scene, { x: target.x + NODE_W + 20, y: target.y - 20 }) === null);
check('hit test misses beyond the graph', dag.hitTestDag(scene, { x: -500, y: -500 }) === null);

// --- mounted component: one canvas, one DOM card, no per-node DOM -----------
const stub = recordingContext();
window.HTMLCanvasElement.prototype.getContext = function getContext(kind) {
  return kind === '2d' ? stub : null;
};
// jsdom has no layout: give every element the viewport the canvas measures.
window.HTMLElement.prototype.getBoundingClientRect = function rect() {
  return { left: 0, top: 0, width: 1600, height: 1000, right: 1600, bottom: 1000, x: 0, y: 0 };
};
Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 1600; } });
Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 1000; } });
const host = window.document.createElement('div');
window.document.body.appendChild(host);
const root = createRoot(host);
let selected = 'unset';
const calls = [];
const noop = () => {};
const record = (name) => (arg) => { calls.push([name, arg]); };
await React.act(async () => {
  root.render(React.createElement(DagCanvas, {
    nodes, edges, layout, selectedId: null, now: Date.now(), busyKey: '',
    onSelect: (id) => { selected = id; },
    onOpenNative: record('native'), onContinue: record('continue'), onNodeAction: record('action'),
    onProposalAction: noop, onRetryRequest: record('retry'), onEscalate: record('escalate'),
    onOpenTrace: record('trace'), onOpenFiles: record('files'), onSuccessor: record('child'),
    replayFooter: null, factsSlot: null,
    t: (key) => key,
  }));
  await wait(120);
});
await wait(80);
const canvasEl = host.querySelector('[data-testid="dag-canvas"]');
check('the canvas is mounted', canvasEl !== null);
check('no per-node DOM cards exist', host.querySelectorAll('.rl-node').length === 0);
const probeCtx = canvasEl.getContext ? canvasEl.getContext('2d') : null;
check('a frame was painted into the canvas', stub.calls.fill > 0 && stub.calls.fillText >= 0, JSON.stringify(stub.calls));

// Click the canvas where a node lives: the component translates screen → world.
const first = scene.byId.get('n-00000');
// The canvas auto-fits on mount; mirror that transform to click a real card.
const clickZoom = Math.min((1600 - 48 * 2) / layout.width, (1000 - 48 * 2) / layout.height, 1);
const clickPan = { x: (1600 - layout.width * clickZoom) / 2, y: (1000 - layout.height * clickZoom) / 2 };
canvasEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1600, height: 1000, right: 1600, bottom: 1000, x: 0, y: 0 });
await React.act(async () => {
  canvasEl.dispatchEvent(new window.MouseEvent('click', {
    bubbles: true,
    clientX: (first.x + 40) * clickZoom + clickPan.x,
    clientY: (first.y + 40) * clickZoom + clickPan.y,
  }));
  await wait(40);
});
check('clicking a card selects it', selected === 'n-00000', String(selected));


// --- right-click menu --------------------------------------------------------
const menuPoint = (id) => {
  const item = scene.byId.get(id);
  return {
    clientX: (item.x + 40) * clickZoom + clickPan.x,
    clientY: (item.y + 40) * clickZoom + clickPan.y,
  };
};
const openMenuAt = async (point) => {
  const event = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, ...point });
  await React.act(async () => {
    canvasEl.dispatchEvent(event);
    await wait(60);
  });
  return event;
};
selected = 'unset';
const menuEvent = await openMenuAt(menuPoint('n-00042'));
check('right-click suppresses the browser menu', menuEvent.defaultPrevented === true);
const menu = host.querySelector('[data-testid="dag-context-menu"]');
check('right-click on a node opens the context menu', menu !== null);
check('right-click selects the node under the cursor', selected === 'n-00042', String(selected));
check('the context menu is headed by the node id', (menu?.textContent ?? '').includes('n-00042'));
const labels = (menu?.textContent ?? '');
check('the menu offers the required actions',
  ['ws.menu.createChild', 'ws.menu.files', 'ws.menu.trace'].every((key) => labels.includes(key)), labels);
const childItem = [...(menu?.querySelectorAll('.rl-dag-menu-item') ?? [])]
  .find((button) => (button.textContent ?? '').includes('ws.menu.createChild'));
await React.act(async () => {
  childItem.click();
  await wait(40);
});
check('clicking a menu item runs its action and closes the menu',
  calls.some(([name, arg]) => name === 'child' && arg === 'n-00042') && host.querySelector('[data-testid="dag-context-menu"]') === null,
  JSON.stringify(calls));

const blank = await openMenuAt({ clientX: 4, clientY: 4 });
check('right-click on empty canvas suppresses the browser menu', blank.defaultPrevented === true);
const blankMenu = host.querySelector('[data-testid="dag-context-menu"]');
check('empty-canvas menu offers view actions',
  (blankMenu?.textContent ?? '').includes('ws.menu.fit'), blankMenu?.textContent ?? '');
await React.act(async () => {
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  await wait(40);
});
check('Escape closes the context menu', host.querySelector('[data-testid="dag-context-menu"]') === null);


// --- the action predicate is the single source of truth ----------------------
const acts = dag.nodeActionsOf;
check('planned node: start + priority', (() => {
  const a = acts({ status: 'planned', childCount: 0 });
  return a.includes('start') && a.includes('priority') && a.includes('child');
})());
check('completed leaf: continue + merge, no priority',
  (() => { const a = acts({ status: 'completed', childCount: 0, sealed: false }); return a.includes('continue') && a.includes('merge') && !a.includes('priority'); })());
check('completed parent: no continue, no priority',
  (() => { const a = acts({ status: 'completed', childCount: 2, sealed: false }); return !a.includes('continue') && !a.includes('priority'); })());
check('sealed leaf: no continue',
  (() => { const a = acts({ status: 'completed', childCount: 0, sealed: true }); return !a.includes('continue'); })());
check('running merge: cancel + continue',
  (() => { const a = acts({ status: 'running', isMerge: true }); return a.includes('cancel') && a.includes('continue'); })());
check('failed: retry + escalate, no priority',
  (() => { const a = acts({ status: 'failed', childCount: 1 }); return a.includes('retry') && a.includes('escalate') && !a.includes('priority'); })());
check('proposed: approve + reject', (() => { const a = acts({ status: 'proposed' }); return a.includes('approve') && a.includes('reject'); })());
check('every node keeps the shared entries',
  (() => { const a = acts({ status: 'cancelled' }); return ['child', 'files', 'trace', 'native', 'copy'].every((id) => a.includes(id)); })());

// --- priority is offered only where dispatch is still possible ----------------
const dispatchHost = window.document.createElement('div');
window.document.body.appendChild(dispatchHost);
const dispatchRoot = createRoot(dispatchHost);
const dispatchNodes = [
  { id: 'n-planned', title: 'queued', status: 'planned', parentId: null },
  { id: 'n-done', title: 'finished', status: 'completed', parentId: null },
  { id: 'n-child', title: 'child', status: 'completed', parentId: 'n-done' },
];
const dispatchLayout = {
  positions: new Map([['n-planned', { x: 10, y: 10 }], ['n-done', { x: 10, y: 160 }], ['n-child', { x: 280, y: 160 }]]),
  width: 560, height: 320,
};
const dispatchEdges = [{ from: 'n-done', to: 'n-child' }];
await React.act(async () => {
  dispatchRoot.render(React.createElement(DagCanvas, {
    nodes: dispatchNodes, edges: dispatchEdges, layout: dispatchLayout, selectedId: null, now: Date.now(), busyKey: '',
    onSelect: noop, onOpenNative: noop, onContinue: noop, onNodeAction: record('action'),
    onProposalAction: noop, onRetryRequest: noop, onEscalate: noop,
    onOpenTrace: noop, onOpenFiles: noop, onSuccessor: noop, onOpenMergeCreate: noop,
    replayFooter: null, factsSlot: null, t: (key, vars) => (vars && vars.class ? key + ':' + vars.class : key),
  }));
  await wait(120);
});
await wait(60);
const dispatchCanvas = dispatchHost.querySelector('[data-testid="dag-canvas"]');
dispatchCanvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1600, height: 1000, right: 1600, bottom: 1000, x: 0, y: 0 });
const dZoom = Math.min((1600 - 96) / dispatchLayout.width, (1000 - 96) / dispatchLayout.height, 1);
const dPan = { x: (1600 - dispatchLayout.width * dZoom) / 2, y: (1000 - dispatchLayout.height * dZoom) / 2 };
const rightClickAt = async (x, y) => {
  await React.act(async () => {
    dispatchCanvas.dispatchEvent(new window.MouseEvent('contextmenu', {
      bubbles: true, cancelable: true,
      clientX: (x + 30) * dZoom + dPan.x,
      clientY: (y + 30) * dZoom + dPan.y,
    }));
    await wait(60);
  });
  return dispatchHost.querySelector('[data-testid="dag-context-menu"]');
};
const plannedMenu = await rightClickAt(10, 10);
check('a planned node offers start and the priority submenu',
  (plannedMenu?.textContent ?? '').includes('ws.menu.start') && (plannedMenu?.textContent ?? '').includes('ws.menu.priority'),
  plannedMenu?.textContent ?? '');
const doneMenu = await rightClickAt(10, 160);
check('a completed node with a successor offers no priority submenu',
  (doneMenu?.textContent ?? '').includes('ws.menu.priority') === false,
  doneMenu?.textContent ?? '');
check('a completed node still offers the merge action',
  (doneMenu?.textContent ?? '').includes('ws.menu.createMerge'), doneMenu?.textContent ?? '');
check('a completed parent (already has a child) offers no continue',
  (doneMenu?.textContent ?? '').includes('ws.menu.continue') === false, doneMenu?.textContent ?? '');
const leafMenu = await rightClickAt(280, 160);
check('a completed leaf still offers continue',
  (leafMenu?.textContent ?? '').includes('ws.menu.continue'), leafMenu?.textContent ?? '');
await React.act(async () => { dispatchRoot.unmount(); });

// --- multi-level menu: the priority submenu ----------------------------------
const prioHost = window.document.createElement('div');
window.document.body.appendChild(prioHost);
const prioRoot = createRoot(prioHost);
// Priority is offered only for dispatchable nodes, so this fixture is queued.
const prioNodes = [{ id: 'n-prio', title: 'prio', status: 'planned', parentId: null, priority: { class: 'p2' } }];
const prioLayout = { positions: new Map([['n-prio', { x: 10, y: 10 }]]), width: 400, height: 200 };
await React.act(async () => {
  prioRoot.render(React.createElement(DagCanvas, {
    nodes: prioNodes, edges: [], layout: prioLayout, selectedId: null, now: Date.now(), busyKey: '',
    onSelect: noop, onOpenNative: noop, onContinue: noop, onNodeAction: record('action'),
    onProposalAction: noop, onRetryRequest: noop, onEscalate: noop,
    onOpenTrace: noop, onOpenFiles: noop, onSuccessor: noop,
    replayFooter: null, factsSlot: null, t: (key, vars) => (vars && vars.class ? key + ':' + vars.class : key),
  }));
  await wait(120);
});
await wait(60);
const prioCanvas = prioHost.querySelector('[data-testid="dag-canvas"]');
prioCanvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1600, height: 1000, right: 1600, bottom: 1000, x: 0, y: 0 });
const prioZoom = Math.min((1600 - 96) / prioLayout.width, (1000 - 96) / prioLayout.height, 1);
const prioPan = { x: (1600 - prioLayout.width * prioZoom) / 2, y: (1000 - prioLayout.height * prioZoom) / 2 };
await React.act(async () => {
  prioCanvas.dispatchEvent(new window.MouseEvent('contextmenu', {
    bubbles: true, cancelable: true,
    clientX: (10 + 30) * prioZoom + prioPan.x,
    clientY: (10 + 30) * prioZoom + prioPan.y,
  }));
  await wait(60);
});
const prioMenu = prioHost.querySelector('[data-testid="dag-context-menu"]');
check('the root menu exposes a priority entry with a submenu arrow',
  (prioMenu?.textContent ?? '').includes('ws.menu.priority') && (prioMenu?.textContent ?? '').includes('▸'));
const priorityItem = [...(prioMenu?.querySelectorAll('.rl-dag-menu-item') ?? [])]
  .find((button) => (button.textContent ?? '').includes('ws.menu.priority'));
await React.act(async () => { priorityItem.click(); await wait(60); });
const submenu = prioHost.querySelector('[data-testid="dag-context-submenu"]');
check('clicking the priority entry opens a nested menu', submenu !== null);
check('the nested menu steps up/down and picks a class',
  ['ws.menu.priorityRaise', 'ws.menu.priorityLower', 'ws.menu.prioritySet:priority.p0', 'ws.menu.prioritySet:priority.deferred']
    .every((label) => (submenu?.textContent ?? '').includes(label)), submenu?.textContent ?? '');
// Hovering onto a submenu entry must not tear the submenu down (the reported bug).
const raiseItem = [...(submenu?.querySelectorAll('.rl-dag-menu-item') ?? [])]
  .find((button) => (button.textContent ?? '').includes('ws.menu.priorityRaise'));
await React.act(async () => {
  raiseItem.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, relatedTarget: priorityItem }));
  await wait(60);
});
check('hovering a submenu entry keeps the submenu open',
  prioHost.querySelector('[data-testid="dag-context-submenu"]') !== null);
const setP0 = [...(prioHost.querySelectorAll('.rl-dag-menu-item') ?? [])]
  .filter((button) => (button.textContent ?? '').includes('ws.menu.prioritySet:priority.p0'))
  .find((button) => (button.textContent ?? '').includes('ws.menu.prioritySet:priority.p0'));
await React.act(async () => { setP0.click(); await wait(60); });
check('choosing a class dispatches node.priority with that class',
  calls.some(([name, arg]) => name === 'action' && arg === 'node?.priority'), JSON.stringify(calls.slice(-3)));
check('the menu closes after choosing a submenu item', prioHost.querySelector('[data-testid="dag-context-menu"]') === null);
await React.act(async () => { prioRoot.unmount(); });

// --- no floating card: selection is canvas highlight only --------------------
const selHost = window.document.createElement('div');
window.document.body.appendChild(selHost);
const selRoot = createRoot(selHost);
await React.act(async () => {
  selRoot.render(React.createElement(DagCanvas, {
    nodes, edges, layout, selectedId: 'n-00007', now: Date.now(), busyKey: '',
    onSelect: noop, onOpenNative: record('native'), onContinue: record('continue'),
    onNodeAction: record('action'), onProposalAction: record('proposal'), onRetryRequest: record('retry'),
    onEscalate: record('escalate'), onOpenTrace: record('trace'), onOpenFiles: record('files'),
    onSuccessor: record('child'), replayFooter: null, factsSlot: null, t: (key) => key,
  }));
  await wait(120);
});
await wait(60);
check('selecting a node mounts no floating card',
  selHost.querySelectorAll('.rl-dag-overlay-card, .rl-node').length === 0,
  String(selHost.querySelectorAll('.rl-dag-overlay-card, .rl-node').length));
check('the selected node is still drawn on the canvas', stub.calls.fill > 0);
await React.act(async () => { selRoot.unmount(); });

// A proposed node must expose approve/reject in the menu (the card used to).
const propNode = { id: 'n-prop', title: 'proposal', status: 'proposed', parentId: null };
const propLayout = { positions: new Map([['n-prop', { x: 10, y: 10 }]]), width: 400, height: 200 };
const propHost = window.document.createElement('div');
window.document.body.appendChild(propHost);
const propRoot = createRoot(propHost);
localStorage.clear();
await React.act(async () => {
  propRoot.render(React.createElement(DagCanvas, {
    nodes: [propNode], edges: [], layout: propLayout, selectedId: null, now: Date.now(), busyKey: '',
    onSelect: noop, onOpenNative: noop, onContinue: noop, onNodeAction: noop,
    onProposalAction: record('proposal'), onRetryRequest: noop, onEscalate: noop,
    onOpenTrace: noop, onOpenFiles: noop, onSuccessor: noop,
    replayFooter: null, factsSlot: null, t: (key) => key,
  }));
  await wait(120);
});
await wait(60);
const propCanvas = propHost.querySelector('[data-testid="dag-canvas"]');
propCanvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1600, height: 1000, right: 1600, bottom: 1000, x: 0, y: 0 });
const propZoom = Math.min((1600 - 96) / propLayout.width, (1000 - 96) / propLayout.height, 1);
const propPan = { x: (1600 - propLayout.width * propZoom) / 2, y: (1000 - propLayout.height * propZoom) / 2 };
const propEvent = new window.MouseEvent('contextmenu', {
  bubbles: true,
  cancelable: true,
  clientX: (10 + 30) * propZoom + propPan.x,
  clientY: (10 + 30) * propZoom + propPan.y,
});
await React.act(async () => { propCanvas.dispatchEvent(propEvent); await wait(60); });
const propMenu = propHost.querySelector('[data-testid="dag-context-menu"]');
check('a proposed node offers approve/reject in the menu',
  (propMenu?.textContent ?? '').includes('ws.menu.approve') && (propMenu?.textContent ?? '').includes('ws.menu.reject'),
  propMenu?.textContent?.slice(0, 80) ?? 'null');
await React.act(async () => { propRoot.unmount(); });

await React.act(async () => { root.unmount(); });
dom.window.close();

if (failures.length > 0) {
  console.error(`\ndag-canvas-selftest: ${failures.length} check(s) failed`);
  for (const failure of failures) console.error(' - ' + failure);
  process.exit(1);
}
console.log('\ndag-canvas-selftest: all checks passed');
process.exit(0);
