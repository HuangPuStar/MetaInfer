/**
 * Targeted tests for the 2026-11-26 fixes:
 *  - an undeclared/unknown resource key is rejected loudly instead of being
 *    accepted and then never gated (the "silently dropped pool key" report);
 *  - a project can forbid multi-parent merges.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../host/store.js';
import { createKernel } from '../host/kernel/instance.js';
import { createLabService, normalizeNeeds } from '../host/lab-service.js';
import { memoryDomain, storeContext } from '../scripts/lib/memory-domain.mjs';

const project = (pools) => ({ config: { resourcePools: pools } });

test('a declared custom pool key is accepted', () => {
  const checked = normalizeNeeds({ gpu: 2, d1pair: 1 }, project({ gpu: 8, d1pair: 1 }));
  assert.equal(checked.error, null);
  assert.deepEqual(checked.needs, { gpu: 2, d1pair: 1 });
});

test('an undeclared pool key is rejected and the available pools are listed', () => {
  const checked = normalizeNeeds({ gpu: 2, d1pair: 1 }, project({ gpu: 8 }));
  assert.match(String(checked.error ?? ''), /unknown resource: d1pair/);
  assert.match(String(checked.error ?? ''), /available: gpu/);
  assert.deepEqual(checked.needs, {});
});

test('requesting more than the pool holds is rejected', () => {
  const checked = normalizeNeeds({ gpu: 16 }, project({ gpu: 8 }));
  assert.match(String(checked.error ?? ''), /exceeds pool gpu=8/);
});

test('machines stays bounded and is never treated as a pool', () => {
  assert.equal(normalizeNeeds({ machines: 2 }, project({ gpu: 8 })).error, null);
  assert.match(String(normalizeNeeds({ machines: 9 }, project({ gpu: 8 })).error ?? ''), /1\.\.8/);
});

test('mergePolicy.allowed=false rejects create_merge with an actionable error', async () => {
  const store = await openStore(storeContext(memoryDomain()));
  const kernel = createKernel({ store });
  const projectId = 'needs-merge-policy-p';
  await store.saveProject({
    id: projectId, revision: 0, counters: { eventSeq: 0 },
    config: { maxRunningNodes: 2, resourcePools: { gpu: 4 }, maxNodes: 20, mergePolicy: { allowed: false } },
    createdAt: 0, updatedAt: 0,
  });
  kernel.load(projectId);
  const service = createLabService({
    ctx: { effect: () => {}, get: () => null, logger: { info() {}, warn() {} } },
    store, kernel, git: null, runtime: null, transcript: null, orchestrator: null,
    auto: null, cluster: null, clusterAdmin: null,
  });
  await assert.rejects(
    () => service.createMergeNode(projectId, { parentIds: ['n-0001', 'n-0002'] }),
    (error) => error?.code === 'merge_disabled' && /single-parent successor/.test(error.message),
  );
  await store.close();
});

test('needs.machines without a fleet inventory fails fast instead of parking', async () => {
  const store = await openStore(storeContext(memoryDomain()));
  const kernel = createKernel({ store });
  const projectId = 'fleet-probe-p';
  await store.saveProject({
    id: projectId, revision: 0, counters: { eventSeq: 0 },
    config: { maxRunningNodes: 2, resourcePools: { gpu: 4 }, maxNodes: 20 },
    createdAt: 0, updatedAt: 0,
  });
  kernel.load(projectId);
  await store.saveNode(projectId, {
    id: 'n-0001', projectId, title: 'fleet node', status: 'planned',
    needs: { machines: 1 }, git: { worktreePath: '/nonexistent', branch: 'b', baseCommit: 'x' },
    timestamps: { createdAt: 1 },
  });
  const service = createLabService({
    ctx: { effect: () => {}, get: () => null, logger: { info() {}, warn() {} } },
    store, kernel, git: null, runtime: { start: async () => ({ started: true }) },
    transcript: null, orchestrator: null, auto: null,
    cluster: { getStatus: () => ({ enabled: false, fleet: { enabled: false, machines: [] } }) },
    clusterAdmin: null,
  });
  await assert.rejects(
    () => service.startNode(projectId, 'n-0001'),
    (error) => error?.code === 'fleet_unavailable' && /fleet inventory/.test(error.message),
  );
  await store.close();
});
