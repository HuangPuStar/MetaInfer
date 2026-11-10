/**
 * UI budget test (S8/S13): measures the client's *view-model* at 5,000 nodes.
 *
 * A Node process cannot paint, so this test does not claim FPS or paint time.
 * It extracts the real `computeViewportWindow` source out of `client.js` (the
 * client is a ModuleLoader bundle, not ESM, so it cannot be imported) and runs
 * that exact source against a synthetic 5,000-node layout. Paint/DOM numbers
 * stay 未测量 with a reason in docs/refactor/IMPLEMENTATION.md.
 *
 * Run: `node scripts/ui-selftest.mjs`
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error }); }
}

const source = await readFile(path.join(ROOT, 'client.js'), 'utf8');
function extract(region) {
  const pattern = new RegExp(`// #region ${region}\\n([\\s\\S]*?)// #endregion ${region}`);
  const match = pattern.exec(source);
  assert.ok(match, `region ${region} exists in client.js`);
  return match[1];
}

const windowSource = extract('compute-viewport-window');
// eslint-disable-next-line no-new-func
const computeViewportWindow = new Function(`${windowSource}\nreturn computeViewportWindow;`)();
const deltaSource = extract('apply-change-delta');
// eslint-disable-next-line no-new-func
const applyChangeDelta = new Function(`${deltaSource}\nreturn applyChangeDelta;`)();

const COUNT = 5_000;
const idOf = (node) => node.id;
const positions = new Map();
const nodes = [];
for (let index = 0; index < COUNT; index += 1) {
  const node = { id: `n${index}`, status: index % 10 === 0 ? 'completed' : 'planned' };
  nodes.push(node);
  positions.set(node.id, { x: (index % 100) * 320, y: Math.floor(index / 100) * 180 });
}
const edges = [];
for (let index = 100; index < COUNT; index += 1) edges.push({ from: `n${index - 100}`, to: `n${index}` });

const base = {
  nodes,
  edges,
  positions,
  pan: { x: 0, y: 0 },
  zoom: 1,
  viewportSize: { width: 1_280, height: 720 },
  nodeWidth: 280,
  nodeHeight: 132,
  maxRendered: 300,
  pad: 240,
  idOf,
};

await test('renders only the visible window, never all 5,000 cards', () => {
  const started = performance.now();
  let window = null;
  for (let round = 0; round < 20; round += 1) {
    window = computeViewportWindow({ ...base, pan: { x: -round * 40, y: -round * 10 } });
  }
  const perRound = (performance.now() - started) / 20;
  assert.ok(window.nodes.length <= 300, `rendered ${window.nodes.length} ≤ 300`);
  assert.ok(window.nodes.length < COUNT, 'off-screen nodes are dropped');
  assert.equal(window.hidden, COUNT - window.nodes.length);
  assert.ok(perRound < 8, `window model ${perRound.toFixed(2)} ms < 8 ms`);
  console.log(`     viewport window ${perRound.toFixed(2)} ms/round, rendered ${window.nodes.length}/${COUNT}, hidden ${window.hidden}`);
});

await test('edges are culled to rendered endpoints (no 4,900-path SVG)', () => {
  const window = computeViewportWindow(base);
  const ids = new Set(window.nodes.map((node) => node.id));
  assert.ok(window.edges.every((edge) => ids.has(edge.from) && ids.has(edge.to)));
  assert.ok(window.edges.length < edges.length);
  console.log(`     edges ${window.edges.length} of ${edges.length}`);
});

await test('extreme zoom-out is capped, not silently dropped', () => {
  const window = computeViewportWindow({ ...base, zoom: 0.02 });
  assert.equal(window.nodes.length, 300);
  assert.equal(window.hidden, COUNT - 300);
  assert.ok(window.hidden > 0, 'the cap is reported so the UI can say so');
});

await test('empty viewport (first paint) still returns a bounded head', () => {
  const window = computeViewportWindow({ ...base, viewportSize: { width: 0, height: 0 } });
  assert.equal(window.nodes.length, 300);
});

await test('no layout position means no card (ghost nodes are skipped)', () => {
  const window = computeViewportWindow({ ...base, positions: new Map() });
  assert.equal(window.nodes.length, 0);
  assert.equal(window.hidden, COUNT);
});

await test('a changes_since delta mutates the index without a full state fetch', () => {
  const snapshot = {
    phase: 'ready',
    revision: 10,
    nodes: [
      { id: 'a', status: 'planned', title: 'alpha', rev: 1, timestamps: { updatedAt: 1 } },
      { id: 'b', status: 'running', title: 'beta', rev: 2, timestamps: { updatedAt: 2 } },
      { id: 'c', status: 'planned', title: 'gamma', rev: 1, timestamps: { updatedAt: 1 } },
    ],
  };
  const merged = applyChangeDelta(snapshot, {
    revision: 11,
    changed: [
      { id: 'a', kind: 'updated', status: 'running', rev: 3, title: 'alpha', updatedAt: 5 },
      { id: 'd', kind: 'created', status: 'proposed', rev: 1, title: 'delta', updatedAt: 6 },
    ],
    removed: ['b'],
  });
  assert.ok(merged);
  assert.equal(merged.nodes.length, 3);
  assert.equal(merged.nodes.find((node) => node.id === 'a').status, 'running');
  assert.equal(merged.nodes.find((node) => node.id === 'a').timestamps.updatedAt, 5);
  assert.equal(merged.nodes.some((node) => node.id === 'b'), false);
  assert.equal(merged.nodes.find((node) => node.id === 'd').status, 'proposed');
});

await test('unsafe deltas are refused instead of inventing nodes', () => {
  const snapshot = { phase: 'ready', revision: 10, nodes: [{ id: 'a', status: 'planned' }] };
  assert.equal(applyChangeDelta(snapshot, { revision: 11, changed: [{ id: 'zzz', kind: 'updated', status: 'running' }] }), null);
  assert.equal(applyChangeDelta(snapshot, { revision: 11, removed: ['missing'] }), null);
  assert.equal(applyChangeDelta(snapshot, { full: true, reason: 'journal_overflow' }), null);
  assert.equal(applyChangeDelta(snapshot, { revision: 11, changed: [{ id: 'x', kind: 'created', status: 'planned' }] }), null);
});

let failed = 0;
for (const result of results) {
  if (result.ok) console.log(`ok   ${result.name}`);
  else { failed += 1; console.log(`FAIL ${result.name}\n     ${result.error?.stack ?? result.error}`); }
}
await test('expert library UI reads the Host catalog, not a hardcoded list', () => {
  assert.ok(source.includes("fetchExperts(projectId"), 'client fetches the expert catalog');
  assert.ok(source.includes("t('ws.experts.library"), 'expert library strings are localized');
  assert.ok(source.includes("className: 'rl-expert-library'"), 'expert library section is rendered');
});
await test('expert library exposes hire/drain/retire lifecycle actions', () => {
  assert.ok(source.includes("runExpertAction('expert_hire'"), 'hire action is wired');
  assert.ok(source.includes("runExpertAction('expert_drain'"), 'drain action is wired');
  assert.ok(source.includes("runExpertAction('expert_fire'"), 'retire action is wired');
  assert.ok(source.includes("t('ws.experts.drainHint')"), 'drain-not-kill safety copy is shown');
});

await test('dashboard separates Host facts from agent commentary', () => {
  assert.ok(source.includes("className: 'rl-dash-facts'"), 'Host facts strip is rendered');
  assert.ok(source.includes("t('dashboard.facts'"), 'Host facts label is localized');
  assert.ok(source.includes("t('dashboard.commentary'"), 'agent commentary label is localized');
  assert.ok(source.includes("className: 'rl-dw-source"), 'widgets carry a source badge');
  assert.ok(source.includes("dashboard.dataSource"), 'widget source comes from the server view');
});
await test('dashboard stale state carries an age badge', () => {
  assert.ok(source.includes("rl-dash-badge-stale"), 'stale badge is styled');
  assert.ok(source.includes("t('dashboard.stale', { age: dashboardAge"), 'stale badge includes the age');
  assert.ok(source.includes("dashboard.staleRevision"), 'revision drift has a reason');
});

console.log(`\n${results.length - failed}/${results.length} UI budget checks passed`);
process.exit(failed === 0 ? 0 : 1);
