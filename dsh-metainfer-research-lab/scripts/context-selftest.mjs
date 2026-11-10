/**
 * Self-test for the context-construction stack (QA Q6):
 *   - bounded payload: a 500-node DAG still fits the advisor byte budget;
 *   - hypothesis ledger: event-sourced, bounded view, incremental reader;
 *   - dag_query / dag_get: filters, subtree, depth, pagination, errors;
 *   - bounded exploration: query/token/wall-clock exhaustion with actionable codes.
 *
 * Run: `node scripts/context-selftest.mjs`
 */
import assert from 'node:assert/strict';
import {
  buildContextPayload, payloadBytes, enforceByteBudget, CONTEXT_BUDGET_BYTES, dagDepth,
} from '../host/context/payload.js';
import { emptyLedger, applyLedgerEvent, ledgerView, createLedgerReader } from '../host/context/ledger.js';
import { queryDag, dagGet, normalizeSelect } from '../host/context/dag.js';
import { createExplorationBudget } from '../host/context/limits.js';
import { buildAdvisorSnapshot } from '../host/snapshot.js';

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

/** Synthetic DAG: a binary tree, no fixture files. */
function syntheticDag(size = 500) {
  const nodes = [];
  for (let index = 0; index < size; index += 1) {
    const parentIds = index === 0 ? [] : [`n${Math.floor((index - 1) / 2)}`];
    let status = 'completed';
    if (index >= size - 30) status = index % 3 === 0 ? 'running' : 'planned';
    if (index >= size - 40 && index < size - 30) status = 'failed';
    if (index >= size - 45 && index < size - 40) status = 'deferred';
    nodes.push({
      id: `n${index}`,
      title: `node ${index} ${'x'.repeat(80)}`,
      prompt: `do thing ${index} with a long explanation that should never reach the payload for nodes outside focus`,
      status,
      parentIds,
      priority: { class: index % 7 === 0 ? 'p0' : 'p2', score: index % 5 },
      needs: { gpu: 1 },
      timeboxMs: 600_000,
      rev: index,
      attempt: 0,
      timestamps: {
        createdAt: 1_000 + index,
        updatedAt: 2_000 + index,
        ...(status === 'running' ? { startedAt: 3_000 + index } : {}),
        ...(status === 'failed' ? { finishedAt: 4_000 + index } : {}),
      },
      ...(status === 'failed' ? { error: `CUDA OOM at step ${index} `.repeat(6) } : {}),
    });
  }
  return nodes;
}

function syntheticLedger() {
  const state = emptyLedger();
  for (let index = 0; index < 30; index += 1) {
    applyLedgerEvent(state, { type: 'ledger/open', at: index, revision: index, data: { id: `h${index}`, hypothesis: `hypothesis ${index}`, evidence: [{ kind: 'node', ref: `n${index}` }] } });
  }
  for (let index = 0; index < 20; index += 1) {
    applyLedgerEvent(state, { type: 'ledger/confirm', at: 100 + index, data: { id: `h${index}`, note: 'confirmed by run' } });
  }
  for (let index = 20; index < 60; index += 1) {
    applyLedgerEvent(state, { type: 'ledger/open', at: index, data: { id: `h${index}`, hypothesis: `ruled ${index}` } });
    applyLedgerEvent(state, { type: 'ledger/rule_out', at: 200 + index, data: { id: `h${index}`, reason: 'no speedup', evidence: [{ kind: 'run', ref: `run-${index}` }] } });
  }
  return state;
}

const project = {
  id: 'p1',
  title: 'Kernel fusion study',
  mode: 'auto',
  revision: 512,
  config: {
    brief: `We want to cut attention latency. ${'Context. '.repeat(400)}`,
    tags: ['attention', 'cuda'],
    auto: { maxTokens: 2_000_000, maxCostUsd: 40, maxCycles: 80, maxWallClockMs: 6 * 60 * 60 * 1000 },
    resourcePools: { gpu: 8 },
  },
  counters: { tokensUsed: 250_000, costUsd: 3.5, cycles: 12 },
  timestamps: { startedAt: 1_000 },
};

test('500 nodes: the advisor payload stays under the 12 KB budget', () => {
  const nodes = syntheticDag(500);
  const payload = buildContextPayload({ project, nodes, ledger: ledgerView(syntheticLedger()), now: 10_000 });
  const bytes = payloadBytes(payload);
  assert.ok(bytes < CONTEXT_BUDGET_BYTES, `payload is ${bytes} bytes, budget ${CONTEXT_BUDGET_BYTES}`);
  assert.ok(bytes < CONTEXT_BUDGET_BYTES - 2_048, `payload should leave headroom, got ${bytes}`);
  // The payload must not grow with the DAG: only the counts and depth differ.
  const small = buildContextPayload({ project, nodes: syntheticDag(50), ledger: ledgerView(syntheticLedger()), now: 10_000 });
  assert.ok(Math.abs(bytes - payloadBytes(small)) < 200, `payload grew with N: ${payloadBytes(small)} -> ${bytes}`);
  assert.equal(payload.focus.length, 8);
  assert.equal(payload.index.total, 500);
  assert.equal(payload.index.counts.completed, 455);
  assert.equal(payload.index.counts.failed, 10);
  assert.ok(payload.index.maxDepth >= 8, `depth ${payload.index.maxDepth}`);
  assert.ok(JSON.stringify(payload).length < 500 * 100, 'no per-node dump leaked in');
  assert.equal(payload.ledger.counts.ruledOut, 40);
  assert.equal(payload.ledger.ruledOut.length, 6);
  // Truncation is explicit, never silent (B25).
  assert.deepEqual(payload._truncated.focus, { shown: 8, total: payload._truncated.focus.total });
  assert.ok(payload._truncated.focus.total > 8);
});

test('focus rows explain why the node is in focus and carry a pointer', () => {
  const nodes = syntheticDag(500);
  const payload = buildContextPayload({ project, nodes, now: 10_000 });
  const running = payload.running[0];
  assert.ok(running.elapsedMs >= 0);
  assert.ok(running.lastActivityMs >= 0);
  for (const row of payload.focus) {
    assert.ok(['running', 'next_by_priority', 'failed_needs_decision', 'awaiting_approval', 'dispatch_hold'].includes(row.why));
    assert.ok(Array.isArray(row.parentIds));
    assert.ok(Number.isInteger(row.rev));
  }
});

test('the byte budget degrades in a defined order and marks every cut', () => {
  const nodes = syntheticDag(500);
  const ledger = ledgerView(syntheticLedger());
  const payload = buildContextPayload({ project, nodes, ledger, now: 10_000, limits: { maxBytes: 1_500 } });
  const bytes = payloadBytes(payload);
  assert.ok(bytes <= 1_500, `expected <= 1500 bytes, got ${bytes}`);
  assert.ok(payload._truncated['ledger.ruledOut'] || payload._truncated.full, 'a cut is recorded');
  // Identity and counts survive even the smallest payload.
  assert.equal(payload.project.id, 'p1');
  assert.equal(payload.index.total, 500);
});

test('ledger is event-sourced, idempotent and bounded', () => {
  const state = emptyLedger();
  applyLedgerEvent(state, { type: 'ledger/open', at: 5, revision: 3, data: { id: 'h1', hypothesis: 'flash beats baseline', evidence: [{ kind: 'run', ref: 'r1' }] } });
  applyLedgerEvent(state, { type: 'ledger/open', at: 6, data: { id: 'h1', hypothesis: 'duplicate' } });
  assert.equal(state.get('h1').hypothesis, 'flash beats baseline');
  applyLedgerEvent(state, { type: 'ledger/confirm', at: 7, data: { id: 'h1', note: '2.1x' } });
  applyLedgerEvent(state, { type: 'ledger/rule_out', at: 8, data: { id: 'h1', reason: 'noise', evidence: [{ kind: 'metric', ref: 'm1' }] } });
  assert.equal(state.get('h1').state, 'ruled_out');
  applyLedgerEvent(state, { type: 'ledger/rule_out', at: 9, data: { id: 'missing', reason: 'ignored' } });
  assert.equal(state.size, 1);
  applyLedgerEvent(state, { type: 'ledger/unknown', data: { id: 'h1' } });
  const view = ledgerView(state, { open: 1, confirmed: 1, ruledOut: 1, evidence: 1 });
  assert.equal(view.counts.total, 1);
  assert.equal(view.ruledOut[0].reason, 'noise');
  assert.ok(view.ruledOut[0].evidenceTruncated, 'evidence is capped with an explicit marker');
  assert.equal(view._truncated.ruledOut, null);
});

test('the ledger reader consumes only new events from its cursor', () => {
  const events = [];
  let cursorCalls = [];
  const store = {
    listEvents(projectId, after) {
      cursorCalls.push(after);
      return events.filter((event) => event.seq > after).sort((a, b) => a.seq - b.seq);
    },
  };
  events.push({ seq: 1, type: 'ledger/open', at: 1, data: { id: 'h1', hypothesis: 'first' } });
  events.push({ seq: 2, type: 'node/created', at: 2, data: {} });
  const reader = createLedgerReader({ store });
  assert.equal(reader.view('p').counts.open, 1);
  assert.deepEqual(cursorCalls, [0]);
  events.push({ seq: 3, type: 'ledger/confirm', at: 3, data: { id: 'h1' } });
  assert.equal(reader.view('p').counts.confirmed, 1);
  assert.deepEqual(cursorCalls, [0, 2]);
  assert.equal(reader.state('p').get('h1').state, 'confirmed');
});

test('dag_query filters by status, subtree, depth, text and paginates stably', () => {
  const nodes = syntheticDag(200);
  const running = queryDag({ nodes, filter: { status: ['running'] } });
  assert.ok(running.total > 0);
  assert.ok(running.nodes.every((row) => row.status === 'running'));

  const subtree = queryDag({ nodes, filter: { subtreeOf: 'n0' }, limit: 200 });
  assert.equal(subtree.total, 200, 'the whole tree is under the root');
  const shallow = queryDag({ nodes, filter: { subtreeOf: 'n0', depth: { max: 1 } }, limit: 200 });
  assert.ok(shallow.total < 5, `depth<=1 should be tiny, got ${shallow.total}`);

  const page1 = queryDag({ nodes, limit: 10 });
  assert.equal(page1.nodes.length, 10);
  assert.equal(page1.truncated.total, 200);
  const page2 = queryDag({ nodes, limit: 10, cursor: page1.nextCursor });
  assert.equal(page2.nodes[0].id, 'n10');
  assert.equal(page1.nodes.at(-1).id, 'n9');

  const bad = queryDag({ nodes, filter: { status: ['planned'] }, cursor: page1.nextCursor });
  assert.equal(bad.code, 'invalid_cursor');

  const text = queryDag({ nodes, filter: { text: 'do thing 42 ' }, limit: 20 });
  assert.equal(text.total, 1);
  assert.equal(text.nodes[0].id, 'n42');

  const recent = queryDag({ nodes, order: 'recent', limit: 3 });
  assert.equal(recent.nodes[0].id, 'n199');
  const priority = queryDag({ nodes, order: 'priority', limit: 5 });
  assert.equal(priority.nodes[0].priority.class, 'p0');
});

test('dag_get returns one hop of context and reports missing ids', () => {
  const nodes = syntheticDag(20);
  const result = dagGet({ nodes, nodeIds: ['n5', 'n6', 'nope'] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.nodes.map((node) => node.id).sort(), ['n5', 'n6']);
  assert.deepEqual(result.missing, ['nope']);
  assert.ok(result.parents.some((row) => row.id === 'n2'));
  assert.ok(result.children.some((row) => row.id === 'n11'));
  assert.equal(dagGet({ nodes, nodeIds: [] }).code, 'missing_ids');
  assert.equal(dagGet({ nodes, nodeIds: Array.from({ length: 51 }, (_, index) => `n${index}`) }).code, 'too_many_ids');
  assert.deepEqual(normalizeSelect(['title']), ['id', 'title']);
  assert.deepEqual(normalizeSelect(['nope']), ['id', 'title', 'status', 'priority', 'parentIds', 'rev']);
});

test('bounded exploration stops with an actionable code on each dimension', () => {
  const state = { now: 0 };
  const budget = createExplorationBudget({ maxQueries: 3, maxQueryTokens: 1_000, wallClockMs: 60_000, clock: () => state.now });
  assert.equal(budget.charge({ bytes: 100 }).ok, true);
  assert.equal(budget.charge({ bytes: 100 }).ok, true);
  assert.equal(budget.charge({ bytes: 100, queries: 2 }).code, 'budget_exhausted');
  const tokens = createExplorationBudget({ maxQueries: 10, maxQueryTokens: 100, clock: () => state.now });
  const first = tokens.charge({ bytes: 350 });
  assert.equal(first.ok, true);
  const second = tokens.charge({ bytes: 1 });
  assert.equal(second.code, 'budget_exhausted');
  assert.equal(second.dimension, 'tokens');
  assert.match(second.nextStep, /Stop exploring/);
  const clock = createExplorationBudget({ maxQueries: 5, maxQueryTokens: 1_000, wallClockMs: 1_000, clock: () => state.now });
  state.now = 1_001;
  const expired = clock.charge({ bytes: 0 });
  assert.equal(expired.dimension, 'wall_clock');
  const again = clock.charge({ bytes: 0 });
  assert.equal(again.ok, false);
  assert.equal(again.dimension, 'wall_clock', 'exhaustion is sticky');
});

test('enforceByteBudget never returns a payload above the limit it can fix', () => {
  const huge = { project: { id: 'x', title: 't', brief: 'b'.repeat(5_000) }, focus: [], running: [], recentFailures: [], ledger: { open: [], confirmed: [], ruledOut: [] }, index: { total: 1 } };
  const out = enforceByteBudget(huge, 500);
  assert.ok(payloadBytes(out) <= 500, `got ${payloadBytes(out)}`);
});

test('the advisor snapshot stays bounded with 500 nodes and exposes resources', () => {
  const nodes = syntheticDag(500);
  const store = { listNodes: () => nodes };
  const snapshot = buildAdvisorSnapshot(store, project, null, { now: 10_000 });
  assert.ok(payloadBytes(snapshot) < CONTEXT_BUDGET_BYTES, `snapshot ${payloadBytes(snapshot)} bytes`);
  assert.equal(snapshot.candidateParents, undefined, 'the old full candidate dump is gone');
  assert.ok(snapshot.resources.free.gpu >= 0);
  assert.ok(snapshot.policy.maxProposalsPerReviewer >= 1);
  assert.ok(snapshot.guidance.navigation.includes('dag_query'));
});

test('dagDepth is linear and handles an orphan parent reference', () => {
  const nodes = [
    { id: 'a', parentIds: [] },
    { id: 'b', parentIds: ['a'] },
    { id: 'c', parentIds: ['b', 'gone'] },
  ];
  const { maxDepth, depth } = dagDepth(nodes);
  assert.equal(maxDepth, 2);
  assert.equal(depth.get('c'), 2);
});

let failed = 0;
for (const result of results) {
  if (result.ok) console.log(`ok   ${result.name}`);
  else {
    failed += 1;
    console.log(`FAIL ${result.name}\n     ${result.error?.stack ?? result.error}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} context checks passed`);
process.exit(failed === 0 ? 0 : 1);
