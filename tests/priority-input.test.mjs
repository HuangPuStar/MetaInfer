/**
 * V4-17: `set_priority` documented the nested `{priority:{class,score}}` shape
 * but only read flat `class`, so `deferred` was silently ignored (before/after
 * both p2). Cover both shapes through the real service path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../host/store.js';
import { createKernel } from '../host/kernel/instance.js';
import { createLabService } from '../host/lab-service.js';
import { memoryDomain, storeContext } from '../scripts/lib/memory-domain.mjs';

async function fixture() {
  const store = await openStore(storeContext(memoryDomain()));
  const projectId = 'priority-p';
  await store.saveProject({
    id: projectId, revision: 0, counters: { eventSeq: 0 },
    config: { maxRunningNodes: 2, resourcePools: { gpu: 2 }, maxNodes: 20 },
    createdAt: 0, updatedAt: 0,
  });
  const kernel = createKernel({ store });
  kernel.load(projectId);
  await store.saveNode(projectId, {
    id: 'n-0001', projectId, title: 'priority probe', prompt: 'priority probe prompt', status: 'planned',
    needs: { gpu: 1 }, git: { worktreePath: '/nonexistent', branch: 'b', baseCommit: 'x' },
    timestamps: { createdAt: 1 },
  });
  const service = createLabService({
    ctx: { effect: () => {}, get: () => null, logger: { info() {}, warn() {} } },
    store, kernel, git: null, runtime: null, transcript: null, orchestrator: null, auto: null,
    cluster: null, clusterAdmin: null,
  });
  return { store, service, projectId };
}

test('nested priority input is applied', async () => {
  const { store, service, projectId } = await fixture();
  try {
    const result = await service.setNodePriority(projectId, 'n-0001', { priority: { class: 'deferred', score: 7 } }, { kind: 'human', id: 'op' });
    assert.equal(result.ok, true, JSON.stringify(result));
    const node = store.getNode(projectId, 'n-0001');
    assert.equal(node.priority.class, 'deferred');
    assert.equal(node.priority.score, 7);
  } finally {
    await store.close();
  }
});

test('an unknown nested class is rejected instead of silently kept', async () => {
  const { store, service, projectId } = await fixture();
  try {
    const result = await service.setNodePriority(projectId, 'n-0001', { priority: { class: 'urgent' } }, { kind: 'human', id: 'op' });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'bad_request');
    assert.equal(store.getNode(projectId, 'n-0001').priority?.class ?? 'p2', 'p2');
  } finally {
    await store.close();
  }
});
