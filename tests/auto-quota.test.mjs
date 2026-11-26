/**
 * Provider quota exhaustion (402 / insufficient_quota) must pause the driver as
 * a quota backoff until the next reset, not accumulate the generic error streak
 * and stop the lab as "errors".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../host/store.js';
import { createKernel } from '../host/kernel/instance.js';
import { createAutoController } from '../host/auto.js';
import { memoryDomain, storeContext } from '../scripts/lib/memory-domain.mjs';

async function fixture(step) {
  const store = await openStore(storeContext(memoryDomain()));
  const projectId = 'auto-quota-p';
  await store.saveProject({
    id: projectId, name: 'quota', mode: 'auto', repo: {}, revision: 0,
    counters: { eventSeq: 0 },
    config: { maxRunningNodes: 1, maxNodes: 20, resourcePools: {}, auto: { idleCycleLimit: 99, maxCycles: 99 } },
    createdAt: 0, updatedAt: 0,
  });
  const kernel = createKernel({ store });
  const auto = createAutoController({
    store, kernel, cluster: null,
    dispatchOnce: async () => ({ started: 0, skipped: [] }),
    orchestrator: { step },
    intervalMs: 60_000,
  });
  return { store, auto, projectId };
}

test('a quota-exhausted lead pauses as quota_backoff until the next reset', async () => {
  const { store, auto, projectId } = await fixture(async () => ({
    created: [], started: [], errors: ['lead: dsh API error (402): insufficient_quota'],
    cycle: { leadFailure: { errorCode: 'provider_quota_exhausted', retryable: true }, errors: ['lead: 402'] },
  }));
  try {
    auto.start(projectId);
    await auto.tick();
    const status = auto.statusOf(projectId);
    assert.equal(status.status, 'paused');
    assert.equal(status.pauseReason, 'quota_backoff');
    assert.ok(status.quotaResumeAt > Date.now(), String(status.quotaResumeAt));
    const resume = new Date(status.quotaResumeAt);
    assert.equal(resume.getHours(), 0, 'reset should be local midnight');
  } finally {
    auto.dispose();
    await store.close();
  }
});

test('quota text is classified as provider_quota_exhausted', async () => {
  const { classifyRoleFailure } = await import('../host/role-errors.js');
  const result = classifyRoleFailure({ role: 'lead', failure: { message: 'insufficient_quota: 该 API Key 今日额度已用尽' }, stopReason: 'error' });
  assert.equal(result.errorCode, 'provider_quota_exhausted');
  assert.equal(result.retryable, true);
});
