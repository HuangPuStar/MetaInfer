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

const node = (id, cls = 'p2') => ({
  id,
  title: id,
  status: 'planned',
  priority: { class: cls, by: 'advisor', depth: 0, failureRecovery: 0 },
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

async function drive(projectId, count, config = {}, dispatchResult = { started: 0, skipped: [] }, deferred = 0, stepResult = null, completed = 0) {
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
  for (let index = 0; index < deferred; index += 1) await store.saveNode(projectId, node(`d${index}`, 'deferred'));
  for (let index = 0; index < completed; index += 1) {
    await store.saveNode(projectId, {
      ...node(`c${index}`),
      status: 'completed',
      git: { headCommit: 'same' },
      review: { reviewedHeadCommit: 'same' },
      report: { summary: `completed ${index}` },
    });
  }
  let steps = 0;
  const kernel = createKernel({ store });
  const auto = createAutoController({
    store,
    kernel,
    cluster: null,
    dispatchOnce: async () => dispatchResult,
    orchestrator: {
      step: async () => {
        steps += 1;
        return stepResult ?? { created: [], started: [], errors: [] };
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
  assert.equal(status.lastPlanSkip, 'noProposal', 'a zero-proposal planning pass must say why');
});

await test('an empty legacy queue gets a planning cycle, not cycle-0 idle', async () => {
  const skip = [{ stage: 'advisor', reason: 'no completed nodes to review' }];
  const { steps, status } = await drive('p-empty', 0, { expertsMode: 'legacy-cycle' }, { started: 0, skipped: [] }, 0, { created: [], started: [], errors: [], skipped: skip });
  assert.equal(steps, 1, 'the planner must be invoked once for an empty queue');
  assert.equal(status.cycles, 1, 'the cycle counter must show the planner ran');
  assert.equal(status.idleStreak, 1, 'an empty planning pass is one idle cycle, not a pre-cycle pause');
  assert.equal(status.pauseReason, null, 'an empty queue must not pause before the idle limit');
  assert.equal(status.lastPlanSkip, 'no completed nodes to review', 'the planner skip reason must be explicit');
});

await test('all-completed legacy DAG records an advisor skip instead of idle at cycle 0', async () => {
  const skip = [{ stage: 'advisor', reason: 'no actionable candidate parents' }];
  const { steps, status } = await drive('p-complete', 0, { expertsMode: 'legacy-cycle' }, { started: 0, skipped: [] }, 0, { created: [], started: [], errors: [], skipped: skip }, 2);
  assert.equal(steps, 1, 'the advisor pass must run once');
  assert.equal(status.cycles, 1, 'cycle 0 must not be skipped');
  assert.equal(status.idleStreak, 1);
  assert.equal(status.pauseReason, null, 'idle must not pause before idleCycleLimit');
  assert.equal(status.lastPlanSkip, 'no actionable candidate parents');
});

await test('a deterministic dispatch start skips the planner entirely', async () => {
  const { steps, status } = await drive('p-fast', 2, {}, { started: 1, skipped: [], durationMs: 2 });
  assert.equal(steps, 0, 'planner must not run when dispatch started a node');
  assert.equal(status.lastDispatch?.started, 1);
  assert.ok((status.lastDispatch?.durationMs ?? 0) < 100);
});

await test('Q5: deferred nodes do not consume the maxNodes hot budget', async () => {
  const { steps, status } = await drive('p-deferred-cap', 1, { maxNodes: 2, maxDeferred: 20 }, { started: 0, skipped: [] }, 5);
  assert.equal(status.pauseReason, null, `deferred nodes must not trip maxNodes: ${status.pauseReason}`);
  assert.equal(steps, 1, 'the one hot node leaves room for planning');
});

await test('Q5: the separate maxDeferred quota pauses the driver', async () => {
  const { status, store } = await drive('p-deferred-quota', 1, { maxNodes: 100, maxDeferred: 2 }, { started: 0, skipped: [] }, 3);
  assert.equal(status.pauseReason, 'maxDeferred');
  assert.equal(store.getProject('p-deferred-quota')?.autoState?.pauseReason, 'maxDeferred');
  assert.equal(store.getProject('p-deferred-quota')?.autoState?.pauseCounts?.maxDeferred, 1);
});

await test('O6: idle/error streaks and the last pause survive a restart read', async () => {
  const { store } = await drive('p-persist', 1, { maxNodes: 100 }, { started: 0, skipped: [] });
  await store.saveProject({
    ...store.getProject('p-persist'),
    autoState: { status: 'paused', pauseReason: 'noProgress', idleStreak: 2, errorStreak: 1, lastPauseAt: 1234, pauseCounts: { noProgress: 2, errors: 1 } },
  });
  const kernel = createKernel({ store });
  const auto = createAutoController({ store, kernel, cluster: null, dispatchOnce: async () => ({ started: 0, skipped: [] }), orchestrator: { step: async () => ({ created: [], started: [], errors: [] }) }, intervalMs: 60_000 });
  const status = auto.statusOf('p-persist');
  auto.dispose();
  kernel.dispose();
  assert.equal(status.idleStreak, 2);
  assert.equal(status.errorStreak, 1);
  assert.equal(status.lastPauseAt, 1234);
  assert.equal(status.pauseCounts.noProgress, 2);
});

await test('an explicit project cap overrides the derived default', async () => {
  const { steps, status } = await drive('p-pin', 2, { maxPlannedInFlight: 1 });
  assert.equal(steps, 0);
  assert.equal(status.lastPlanSkip, 'maxPlannedInFlight');
});

process.stdout.write(`${checks - failed}/${checks} auto WIP checks passed\n`);
process.exit(failed === 0 ? 0 : 1);
