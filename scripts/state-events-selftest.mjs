/**
 * O9: every legal status transition emits exactly one structured event with a
 * stable type. Also checks the dispatch-claim and priority events that the
 * design calls out, using the canonical names this kernel actually emits
 * (`dispatch/claimed`, `dispatch/claim_released`, `node/priority_changed`).
 */
import assert from 'node:assert/strict';
import { openStore } from '../host/store.js';
import { createKernel } from '../host/kernel/instance.js';
import { DEFAULT_TRANSITIONS, NODE_STATUSES } from '../host/kernel/mutations.js';
import { memoryDomain, storeContext } from './lib/memory-domain.mjs';

let checks = 0;
let failed = 0;
const ok = (label) => { checks += 1; process.stdout.write(`ok   ${label}\n`); };
const fail = (label, error) => { checks += 1; failed += 1; process.stdout.write(`FAIL ${label}: ${error?.message ?? error}\n`); };

const store = await openStore(storeContext(memoryDomain()));
const kernel = createKernel({ store });
const projectId = 'prj-events';
const base = {
  id: projectId,
  name: 'events',
  repo: {},
  mode: 'manual',
  revision: 0,
  counters: { eventSeq: 0 },
  config: { maxRunningNodes: 4, maxNodes: 100, resourcePools: {} },
};
const boot = await kernel.executor.bootstrapProject(projectId, base, {
  actor: { kind: 'human', id: 'operator' },
  causeId: 'bootstrap',
  mutations: [{ op: 'event.record', type: 'project/created', data: {} }],
});
assert.equal(boot.ok, true, JSON.stringify(boot));

const EVENT_FOR = {
  proposed: 'node/proposed',
  planned: 'node/planned',
  running: 'node/started',
  completed: 'node/completed',
  failed: 'node/failed',
  cancelled: 'node/cancelled',
};

async function eventsAfter(seq, nodeId) {
  return store.listEvents(projectId, seq).filter((event) => event.nodeId === nodeId);
}

async function newNode(id, status) {
  const result = await kernel.executor.commit(projectId, {
    actor: { kind: 'system', id: 'test' },
    causeId: `create:${id}`,
    mutations: [{ op: 'node.create', node: { id, title: id, prompt: 'p', status, needs: {}, timestamps: { createdAt: 1 } } }],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return { seq: store.getProject(projectId).counters.eventSeq ?? 0, revision: result.revision };
}

try {
  assert.deepEqual(Object.keys(DEFAULT_TRANSITIONS).sort(), [...NODE_STATUSES].sort());
  ok('transition table covers all six statuses');

  for (const [from, targets] of Object.entries(DEFAULT_TRANSITIONS)) {
    for (const to of targets) {
      const id = `n-${from}-${to}`;
      const { seq } = await newNode(id, from);
      const result = await kernel.executor.commit(projectId, {
        actor: { kind: 'system', id: 'test' },
        causeId: `transition:${id}`,
        mutations: [{ op: 'node.transition', nodeId: id, from, to }],
      });
      try {
        assert.equal(result.ok, true, JSON.stringify(result));
        const events = await eventsAfter(seq, id);
        assert.equal(events.length, 1, `expected one event, got ${events.map((event) => event.type).join(',')}`);
        assert.equal(events[0].type, EVENT_FOR[to], `wrong event type for ${from}->${to}`);
        assert.equal(events[0].data?.from, from);
        assert.equal(events[0].data?.to, to);
        assert.equal(store.getNode(projectId, id)?.status, to);
        ok(`${from} -> ${to} emits ${EVENT_FOR[to]}`);
      } catch (error) {
        fail(`${from} -> ${to}`, error);
      }
    }
  }

  const priorityId = 'n-priority';
  const prioritySeq = (await newNode(priorityId, 'planned')).seq;
  const priority = await kernel.executor.commit(projectId, {
    actor: { kind: 'human', id: 'operator' },
    causeId: 'priority',
    mutations: [{ op: 'node.setPriority', nodeId: priorityId, priority: { class: 'p0' } }],
  });
  try {
    assert.equal(priority.ok, true, JSON.stringify(priority));
    const events = await eventsAfter(prioritySeq, priorityId);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'node/priority_changed');
    ok('priority change emits node/priority_changed');
  } catch (error) {
    fail('priority change', error);
  }

  const claimId = 'n-claim';
  const claimSeq = (await newNode(claimId, 'planned')).seq;
  const claimed = await kernel.executor.commit(projectId, {
    actor: { kind: 'system', id: 'dispatcher' },
    causeId: 'claim',
    mutations: [{ op: 'node.claim', nodeId: claimId, claim: { decisionId: 'd-1', strategyId: 'det', broker: 'local-pool' } }],
  });
  try {
    assert.equal(claimed.ok, true, JSON.stringify(claimed));
    const events = await eventsAfter(claimSeq, claimId);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'dispatch/claimed');
    ok('dispatch claim emits dispatch/claimed (canonical, not node/claimed)');
  } catch (error) {
    fail('dispatch claim', error);
  }
  const claimAfter = store.getProject(projectId).counters.eventSeq ?? 0;
  const released = await kernel.executor.commit(projectId, {
    actor: { kind: 'system', id: 'dispatcher' },
    causeId: 'release',
    mutations: [{ op: 'node.releaseClaim', nodeId: claimId, decisionId: 'd-1' }],
  });
  try {
    assert.equal(released.ok, true, JSON.stringify(released));
    const events = await eventsAfter(claimAfter, claimId);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'dispatch/claim_released');
    ok('claim release emits dispatch/claim_released');
  } catch (error) {
    fail('claim release', error);
  }
} finally {
  kernel.dispose();
  await store.close();
}

process.stdout.write(`${checks - failed}/${checks} state-event checks passed\n`);
process.exit(failed === 0 ? 0 : 1);
