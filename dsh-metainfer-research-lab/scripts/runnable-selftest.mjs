/**
 * Self-test for the single runnable predicate (design decision B8).
 * Covers the success paths and the four blocking reasons, including the exact
 * regression from QA Q5: a deferred node must never count as runnable.
 *
 * Run: `node scripts/runnable-selftest.mjs`
 */
import assert from 'node:assert/strict';
import {
  RUNNABLE_BLOCK,
  isDeferredNode,
  isRunnableNode,
  runnableBlockReason,
  runnableNodes,
  runnableQueue,
  runnableSummary,
} from '../host/kernel/runnable.js';

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

const NOW = 1_000_000;
const node = (id, overrides = {}) => ({
  id,
  status: 'planned',
  priority: { class: 'p2', score: 0 },
  timestamps: { createdAt: 1 },
  timeboxMs: 600_000,
  needs: { gpu: 1 },
  ...overrides,
});

test('a plain planned node is runnable', () => {
  assert.equal(runnableBlockReason(node('n-1'), NOW), null);
  assert.equal(isRunnableNode(node('n-1'), NOW), true);
});

test('every non-planned status is blocked', () => {
  for (const status of ['proposed', 'running', 'completed', 'failed', 'cancelled']) {
    assert.equal(runnableBlockReason(node('n-1', { status }), NOW), RUNNABLE_BLOCK.NOT_PLANNED);
  }
});

test('a deferred node is planned but never runnable', () => {
  const deferred = node('n-1', { priority: { class: 'deferred' } });
  assert.equal(runnableBlockReason(deferred, NOW), RUNNABLE_BLOCK.DEFERRED);
  assert.equal(isDeferredNode(deferred), true);
  assert.deepEqual(runnableNodes([deferred], NOW), []);
});

test('a claimed node is blocked until the claim is released', () => {
  const claimed = node('n-1', { claim: { decisionId: 'dec-1' } });
  assert.equal(runnableBlockReason(claimed, NOW), RUNNABLE_BLOCK.CLAIMED);
});

test('dispatchHold blocks until its deadline and then expires', () => {
  const held = node('n-1', { dispatchHold: { untilMs: NOW + 30_000, reason: 'launch_failed' } });
  assert.equal(runnableBlockReason(held, NOW), RUNNABLE_BLOCK.HELD);
  assert.equal(isRunnableNode(held, NOW + 30_000), true);
});

test('an unknown priority class falls back to p2 and stays runnable', () => {
  const weird = node('n-1', { priority: { class: 'ultra' } });
  assert.equal(runnableBlockReason(weird, NOW), null);
});

test('runnableNodes keeps only runnable nodes', () => {
  const nodes = [
    node('a'),
    node('b', { status: 'running' }),
    node('c', { priority: { class: 'deferred' } }),
    node('d', { claim: { decisionId: 'x' } }),
    node('e', { priority: { class: 'p0' } }),
  ];
  assert.deepEqual(runnableNodes(nodes, NOW).map((item) => item.id), ['a', 'e']);
});

test('runnableQueue orders by the priority tuple', () => {
  const nodes = [
    node('late', { priority: { class: 'p2' }, timestamps: { createdAt: 2 } }),
    node('human', { priority: { class: 'p0' } }),
    node('fix', { priority: { class: 'p1' } }),
    node('early', { priority: { class: 'p2' }, timestamps: { createdAt: 1 } }),
    node('deferred', { priority: { class: 'deferred' }, timestamps: { createdAt: 0 } }),
  ];
  assert.deepEqual(runnableQueue(nodes, NOW).map((item) => item.id), ['human', 'fix', 'early', 'late']);
});

test('runnableSummary counts the regression case instead of hiding it', () => {
  const nodes = [
    node('a'),
    node('b', { status: 'running' }),
    node('c', { priority: { class: 'deferred' } }),
    node('d', { priority: { class: 'deferred' } }),
    node('e', { claim: { decisionId: 'x' } }),
    node('f', { dispatchHold: { untilMs: NOW + 1 } }),
  ];
  const summary = runnableSummary(nodes, { now: NOW });
  assert.equal(summary.total, 6);
  assert.equal(summary.runnable, 1);
  assert.equal(summary.deferred, 2);
  assert.equal(summary.claimed, 1);
  assert.equal(summary.held, 1);
  assert.equal(summary.remainingMs, 600_000);
  assert.equal(summary.gpu, 1);
});

test('runnableSummary uses the default timebox when a node does not declare one', () => {
  const summary = runnableSummary([node('a', { timeboxMs: undefined })], { now: NOW, defaultTimeboxMs: 42 });
  assert.equal(summary.remainingMs, 42);
});

test('an empty set is runnable at depth zero', () => {
  assert.equal(runnableQueue([], NOW).length, 0);
  assert.equal(runnableSummary([], { now: NOW }).runnable, 0);
});

const failed = results.filter((result) => !result.ok);
for (const result of results) {
  if (result.ok) console.log(`ok   ${result.name}`);
  else console.log(`FAIL ${result.name}\n${result.error?.stack ?? result.error}`);
}
console.log(`\nrunnable self-test: ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
