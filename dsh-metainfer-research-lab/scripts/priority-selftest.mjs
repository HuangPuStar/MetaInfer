/**
 * Priority write regression (B7): priority must be an executor commit, and a
 * running/terminal node must reject the change instead of reporting success.
 */
import assert from 'node:assert/strict';
import { openStore } from '../host/store.js';
import { createKernel } from '../host/kernel/instance.js';
import { createLabService } from '../host/lab-service.js';
import { memoryDomain, storeContext } from './lib/memory-domain.mjs';

let failed = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`ok   ${name}`);
  else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const fakeCtx = { effect: () => {}, get: () => null, logger: { info() {}, warn() {} } };
const store = await openStore(storeContext(memoryDomain()));
const kernel = createKernel({ store });
const service = createLabService({
  ctx: fakeCtx, store, kernel, git: null, runtime: null, transcript: null, orchestrator: null, auto: null, cluster: null, clusterAdmin: null,
});
await store.saveProject({
  id: 'p',
  revision: 0,
  counters: { eventSeq: 0 },
  config: { maxRunningNodes: 4, resourcePools: { gpu: 4 }, maxNodes: 100 },
  updatedAt: 0,
  createdAt: 0,
});
kernel.load('p');
await kernel.executor.commit('p', {
  actor: { kind: 'human', id: 'test' },
  mutations: [
    { op: 'node.create', node: { id: 'planned', title: 'planned', status: 'planned', priority: { class: 'p2' }, timestamps: { createdAt: 1 } } },
    { op: 'node.create', node: { id: 'running', title: 'running', status: 'planned', priority: { class: 'p2' }, timestamps: { createdAt: 2 } } },
    { op: 'node.create', node: { id: 'done', title: 'done', status: 'planned', priority: { class: 'p2' }, timestamps: { createdAt: 3 } } },
  ],
});
await kernel.executor.commit('p', { actor: { kind: 'human', id: 'test' }, mutations: [{ op: 'node.transition', nodeId: 'running', to: 'running' }] });
await kernel.executor.commit('p', { actor: { kind: 'human', id: 'test' }, mutations: [{ op: 'node.transition', nodeId: 'done', to: 'running' }] });
await kernel.executor.commit('p', { actor: { kind: 'human', id: 'test' }, mutations: [{ op: 'node.transition', nodeId: 'done', to: 'completed' }] });

// 1. Planned node: accepted, and the write is an executor event.
const beforeEvents = store.listEvents('p', 0).length;
const ok = await service.setNodePriority('p', 'planned', { class: 'p0', reason: 'human says urgent' });
check('planned node accepts a priority change', ok.ok === true, JSON.stringify(ok));
check('priority is applied', store.getNode('p', 'planned').priority.class === 'p0', store.getNode('p', 'planned').priority.class);
check('priority change is an executor event', store.listEvents('p', 0).some((event) => event.type === 'node/priority_changed' && event.nodeId === 'planned' && event.actor?.kind === 'human'));
check('exactly one event was committed', store.listEvents('p', 0).length === beforeEvents + 1, String(store.listEvents('p', 0).length - beforeEvents));

// 2. Running/terminal nodes: rejected with a defined, actionable code, no write.
for (const nodeId of ['running', 'done']) {
  const before = store.getNode('p', nodeId);
  const eventsBefore = store.listEvents('p', 0).length;
  const result = await service.setNodePriority('p', nodeId, { class: 'deferred' });
  check(`${nodeId} node rejects priority change`, result.ok === false && result.error?.code === 'priority_frozen', JSON.stringify(result));
  check(`${nodeId} rejection has a next step`, typeof result.error?.nextStep === 'string' && result.error.nextStep.length > 10, JSON.stringify(result.error ?? null));
  check(`${nodeId} node is unchanged`, store.getNode('p', nodeId).priority.class === before.priority.class, store.getNode('p', nodeId).priority.class);
  check(`${nodeId} rejection wrote no event`, store.listEvents('p', 0).length === eventsBefore);
}

// 3. updateNode must not be a second write path around the executor.
let updateError = null;
try {
  await service.updateNode('p', 'running', { title: 'renamed', priority: { class: 'deferred' } });
} catch (error) {
  updateError = error;
}
check('updateNode rejects priority on a running node', updateError !== null && updateError.code === 'priority_frozen', String(updateError?.code));
check('updateNode did not rename the running node', store.getNode('p', 'running').title === 'running', store.getNode('p', 'running').title);

// 4. The kernel itself refuses the write, not only the service wrapper.
const direct = await kernel.executor.commit('p', {
  actor: { kind: 'human', id: 'test' },
  mutations: [{ op: 'node.setPriority', nodeId: 'running', priority: { class: 'p0' } }],
});
check('kernel commit refuses priority on a running node', direct.ok === false && direct.code === 'priority_frozen', JSON.stringify(direct));
check('kernel refusal left the node unchanged', store.getNode('p', 'running').priority.class === 'p2', store.getNode('p', 'running').priority.class);

// 5. Validation still happens before the commit.
const badClass = await service.setNodePriority('p', 'planned', { class: 'urgent' });
check('unknown priority class is rejected', badClass.ok === false && badClass.error?.code === 'bad_request', JSON.stringify(badClass));

console.log(`\n${failed === 0 ? 'priority-selftest: all checks passed' : `priority-selftest: ${failed} failed`}`);
process.exit(failed === 0 ? 0 : 1);
