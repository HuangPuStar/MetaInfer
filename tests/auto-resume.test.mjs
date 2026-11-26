/**
 * Regression for `auto_resume` after a maxWallClock pause: resume used to
 * reference an undefined `wasWallClock` (ReferenceError) and, even when it did
 * not throw, the stale window made the next tick pause again immediately.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../host/store.js';
import { createKernel } from '../host/kernel/instance.js';
import { createAutoController } from '../host/auto.js';
import { memoryDomain, storeContext } from '../scripts/lib/memory-domain.mjs';

async function fixture(autoConfig) {
  const store = await openStore(storeContext(memoryDomain()));
  const projectId = 'auto-resume-p';
  await store.saveProject({
    id: projectId,
    name: 'auto-resume',
    mode: 'auto',
    repo: {},
    revision: 0,
    counters: { eventSeq: 0 },
    config: { maxRunningNodes: 1, maxNodes: 20, resourcePools: {}, auto: autoConfig },
    createdAt: 0,
    updatedAt: 0,
  });
  const kernel = createKernel({ store });
  const auto = createAutoController({
    store,
    kernel,
    cluster: null,
    dispatchOnce: async () => ({ started: 0, skipped: [] }),
    orchestrator: { step: async () => ({ created: [], started: [], errors: [] }) },
    intervalMs: 60_000,
  });
  return { store, auto, projectId };
}

test('resume after a wall-clock pause starts a new window without throwing', async () => {
  const { store, auto, projectId } = await fixture({ maxWallClockMs: 40, idleCycleLimit: 99, maxCycles: 99 });
  try {
    auto.start(projectId);
    // Let the short window expire, then one tick pauses with maxWallClock.
    await new Promise((resolve) => setTimeout(resolve, 60));
    await auto.tick();
    const paused = auto.statusOf(projectId);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.pauseReason, 'maxWallClock');
    // With the old bug this rejected with "wasWallClock is not defined".
    const resumed = await auto.resume(projectId);
    assert.equal(resumed.status, 'running');
    assert.equal(resumed.pauseReason, null);
    // The fresh window must survive the next tick.
    await auto.tick();
    const after = auto.statusOf(projectId);
    assert.equal(after.status !== 'paused' || after.pauseReason !== 'maxWallClock', true,
      `next tick re-paused with ${after.pauseReason}`);
  } finally {
    auto.dispose();
    await store.close();
  }
});

test('resume keeps a normal pause window (no premature reset)', async () => {
  const { store, auto, projectId } = await fixture({ maxCycles: 1, idleCycleLimit: 99, maxWallClockMs: 6 * 60 * 60 * 1000 });
  try {
    auto.start(projectId);
    await auto.tick();
    assert.equal(auto.statusOf(projectId).pauseReason, 'maxCycles');
    const resumed = await auto.resume(projectId);
    assert.equal(resumed.status, 'running');
  } finally {
    auto.dispose();
    await store.close();
  }
});
