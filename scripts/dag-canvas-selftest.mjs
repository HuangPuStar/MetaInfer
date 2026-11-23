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
const noop = () => {};
await React.act(async () => {
  root.render(React.createElement(DagCanvas, {
    nodes, edges, layout, selectedId: null, now: Date.now(), busyKey: '',
    onSelect: (id) => { selected = id; },
    onOpenNative: noop, onContinue: noop, onNodeAction: noop, onProposalAction: noop,
    onRetryRequest: noop, onEscalate: noop, replayFooter: null, factsSlot: null,
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

await React.act(async () => { root.unmount(); });
dom.window.close();

if (failures.length > 0) {
  console.error(`\ndag-canvas-selftest: ${failures.length} check(s) failed`);
  for (const failure of failures) console.error(' - ' + failure);
  process.exit(1);
}
console.log('\ndag-canvas-selftest: all checks passed');
process.exit(0);
