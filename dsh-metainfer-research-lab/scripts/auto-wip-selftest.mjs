/**
 * Auto-driver WIP cap (QA Q3 mechanism B): a deep runnable queue must not buy
 * more advisor planning. The default is `max(2 * freeSlots, 4)`; a project can
 * pin it explicitly for an experiment. This is a real controller test, not a
 * source regex.
 */
import assert from 'node:assert/strict';
import { openStore } from '../host/store.js';
import { createAutoController, maxPlannedInFlightOf } from '../host/auto.js';
import { createKernel } from '../host/kernel/instance.js';
import { memoryDomain, storeContext } from './lib/memory-domain.mjs';

const ok = (label) => process.stdout.write(`ok   ${label}\n`);
let checks = 0;
let failed = 0;
async function test(label, fn) {
  checks += 1;
  try {
    await fn();
    ok(label);
  } catch (error) {
    failed += 1;
    process.stdout.write(`FAIL ${label}: ${error?.message ?? error}\n`);
  }
}

const node = (id) => ({
  id,
  title: id,
  status: 'planned',
  priority: { class: 'p2', by: 'advisor', depth: 0, failureRecovery: 0 },
  needs: {},
  resourcesHeld: {},
  timestamps: { createdAt: 1 },
});

await test('default cap is max(2 * freeSlots, 4)', async () => {
  assert.equal(maxPlannedInFlightOf({ config: { maxRunningNodes: 4 } }, { runningCount: 0 }), 8);
  assert.equal(maxPlannedInFlightOf({ config: { maxRunningNodes: 4 } }, { runningCount: 2 }), 4);
  assert.equal(maxPlannedInFlightOf({ config: { maxRunningNodes: 10 } }, { runningCount: 1 }), 18);
  assert.equal(maxPlannedInFlightOf({ config: { maxRunningNodes: 4, maxPlannedInFlight: 3 } }, { runningCount: 0 }), 3);
});

async function drive(projectId, count, config = {}) {
  const store = await openStore(storeContext(memoryDomain()));
  await store.saveProject({
    id: projectId,
    name: projectId,
    mode: 'manual',
    repo: {},
    revision: 0,
    counters: { eventSeq: 0 },
    config: { maxRunningNodes: 2, maxNodes: 100, resourcePools: {}, planning: { minRemainingMs: 3_600_000, planLatencyMs: 1_000, safetyFactor: 0.1, debounceMs: 0, minGapMs: 0 }, ...config },
  });
  for (let index = 0; index < count; index += 1) await store.saveNode(projectId, node(`n${index}`));
  let steps = 0;
  const kernel = createKernel({ store });
  const auto = createAutoController({
    store,
    kernel,
    cluster: null,
    dispatchOnce: async () => ({ started: 0, skipped: [] }),
    orchestrator: {
      step: async () => {
        steps += 1;
        return { created: [], started: [], errors: [] };
      },
    },
    intervalMs: 60_000,
  });
  auto.start(projectId);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const status = auto.statusOf(projectId);
  auto.dispose();
  kernel.dispose();
  return { steps, status, store };
}

await test('a queue over the cap skips the advisor pass', async () => {
  const { steps, status } = await drive('p-full', 5);
  assert.equal(steps, 0, 'advisor must not run when runnable >= cap');
  assert.equal(status.lastPlanSkip, 'maxPlannedInFlight');
});

await test('a queue below the cap can plan', async () => {
  const { steps, status } = await drive('p-room', 2);
  assert.equal(steps, 1, 'advisor runs for a two-node queue');
  assert.equal(status.lastPlanSkip, null);
});

await test('an explicit project cap overrides the derived default', async () => {
  const { steps, status } = await drive('p-pin', 2, { maxPlannedInFlight: 1 });
  assert.equal(steps, 0);
  assert.equal(status.lastPlanSkip, 'maxPlannedInFlight');
});

process.stdout.write(`${checks - failed}/${checks} auto WIP checks passed\n`);
process.exit(failed === 0 ? 0 : 1);
