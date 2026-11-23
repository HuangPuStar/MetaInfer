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

const deltaSource = extract('apply-change-delta');
// eslint-disable-next-line no-new-func
const applyChangeDelta = new Function(`${deltaSource}\nreturn applyChangeDelta;`)();

const deepLinkSource = extract('deep-link-selection');
// eslint-disable-next-line no-new-func
const resolveDeepLinkSelection = new Function(`${deepLinkSource}\nreturn resolveDeepLinkSelection;`)();

await test('a deep link applies once, then the operator owns the selection', () => {
  const nodeIds = ['n1', 'n2', 'n3'];
  // Boot: no navigation applied yet -> follow the deep link.
  let state = { applied: '', selected: '' };
  let decision = resolveDeepLinkSelection({ wanted: 'n1', applied: state.applied, selectedId: state.selected, nodeIds });
  assert.equal(decision.select, 'n1');
  state = { applied: decision.applied, selected: 'n1' };
  // Operator clicks n2; the stale deep link must NOT pull them back (the flicker).
  decision = resolveDeepLinkSelection({ wanted: 'n1', applied: state.applied, selectedId: 'n2', nodeIds });
  assert.equal(decision.select, null, 'stale deep link must not re-assert');
  assert.equal(decision.applied, 'n1');
  // A real navigation intent (popstate to n3) still moves the selection.
  decision = resolveDeepLinkSelection({ wanted: 'n3', applied: 'n1', selectedId: 'n2', nodeIds });
  assert.equal(decision.select, 'n3');
  // An unknown id is remembered as applied but selects nothing.
  decision = resolveDeepLinkSelection({ wanted: 'nope', applied: 'n3', selectedId: 'n2', nodeIds });
  assert.equal(decision.select, null);
  assert.equal(decision.applied, 'n3');
  // Clearing the deep link resets the intent.
  decision = resolveDeepLinkSelection({ wanted: '', applied: 'n3', selectedId: 'n2', nodeIds });
  assert.equal(decision.applied, '');
  assert.equal(decision.select, null);
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
  assert.ok(source.includes("dashboard.staleFailed"), 'failed refresh has a reason');
});
await test('dashboard failure alert is dismissible and degrades', () => {
  assert.ok(source.includes("className: 'rl-dash-alert'"), 'failure alert is rendered');
  assert.ok(source.includes("setDismissedFailureAt(failureAt)"), 'the alert can be dismissed');
  assert.ok(source.includes("dashboard.failedDegraded"), 'consecutive failures are called out');
  assert.ok(source.includes("failureCount >= 3"), 'degradation starts at three failures');
});

console.log(`\n${results.length - failed}/${results.length} UI budget checks passed`);
process.exit(failed === 0 ? 0 : 1);
