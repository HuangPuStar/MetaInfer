/**
 * Advisor snapshot budget regression (Q6/B26): the snapshot must stay under
 * 12 KB and under 50 ms even when the project has thousands of nodes whose
 * titles/prompts/reports are individually much larger than the budget.
 */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { openStore } from '../host/store.js';
import { buildAdvisorSnapshot } from '../host/snapshot.js';
import { memoryDomain, storeContext } from './lib/memory-domain.mjs';

const CONTEXT_BUDGET_BYTES = 12 * 1024;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`ok   ${name}`);
  else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const store = await openStore(storeContext(memoryDomain()));
const project = {
  id: 'p-snapshot',
  revision: 0,
  counters: { eventSeq: 0 },
  createdAt: 0,
  updatedAt: 0,
  brief: 'B'.repeat(6_000),
  goal: 'G'.repeat(4_000),
  config: {
    maxRunningNodes: 2,
    maxNodes: 20_000,
    resourcePools: { gpu: 4 },
    nodeTimeoutMinutes: 30,
  },
};
await store.saveProject(project);
const TOTAL = 2_000;
for (let index = 0; index < TOTAL; index += 1) {
  const id = `n${index}`;
  const status = index % 11 === 0 ? 'running' : (index % 7 === 0 ? 'failed' : (index % 3 === 0 ? 'completed' : 'planned'));
  await store.saveNode('p-snapshot', {
    id,
    title: `Experiment ${index} ${'T'.repeat(300)}`,
    prompt: `P`.repeat(8_000),
    status,
    parentId: index === 0 ? null : `n${index - 1}`,
    parentIds: index === 0 ? [] : [`n${index - 1}`],
    needs: { gpu: 1 },
    timeboxMs: 1_800_000,
    priority: { class: index % 5 === 0 ? 'p0' : 'p2' },
    report: { summary: 'S'.repeat(500), headline: 'H'.repeat(300), success: true, changes: ['C'.repeat(2_000)] },
    reportText: 'R'.repeat(8_000),
    error: index % 7 === 0 ? { code: 'timeout', message: 'E'.repeat(2_000) } : null,
    timestamps: { createdAt: index, lastActivityAt: index },
    rev: 1,
  });
}
// Warm the projection/index path, then measure the steady state.
buildAdvisorSnapshot(store, store.getProject('p-snapshot'), null, {});
const samples = [];
let snapshot = null;
for (let round = 0; round < 5; round += 1) {
  const started = performance.now();
  snapshot = buildAdvisorSnapshot(store, store.getProject('p-snapshot'), null, {});
  samples.push(performance.now() - started);
}
const bytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
const best = Math.min(...samples);
const worst = Math.max(...samples);
check('snapshot exists', snapshot !== null && typeof snapshot === 'object');
check('snapshot under 12 KB', bytes < CONTEXT_BUDGET_BYTES, `${bytes} B`);
check('snapshot build under 50 ms (best of 5)', best < 50, `${best.toFixed(1)} ms`);
check('snapshot build under 50 ms (worst of 5)', worst < 50, `${worst.toFixed(1)} ms`);
check('snapshot declares its truncation', snapshot?._truncated !== undefined && snapshot?._truncated !== null, JSON.stringify(snapshot?._truncated));
check('no full node prompt leaks into the snapshot', !JSON.stringify(snapshot).includes('P'.repeat(2_000)));
check('no full report text leaks into the snapshot', !JSON.stringify(snapshot).includes('R'.repeat(2_000)));
check('brief is bounded', String(snapshot?.brief ?? '').length <= 1_500, String(snapshot?.brief?.length));
check('focus is bounded', Array.isArray(snapshot?.focus) && snapshot.focus.length <= 8, String(snapshot?.focus?.length));
check('running is bounded', Array.isArray(snapshot?.running) && snapshot.running.length <= 6, String(snapshot?.running?.length));
check('recentFailures is bounded', Array.isArray(snapshot?.recentFailures) && snapshot.recentFailures.length <= 5, String(snapshot?.recentFailures?.length));
console.log(`     ${bytes} B (${(bytes / 1024).toFixed(1)} KB), build ${best.toFixed(1)}–${worst.toFixed(1)} ms over ${TOTAL} nodes`);

console.log(`\n${failed === 0 ? 'snapshot-size-selftest: all checks passed' : `snapshot-size-selftest: ${failed} failed`}`);
process.exit(failed === 0 ? 0 : 1);
