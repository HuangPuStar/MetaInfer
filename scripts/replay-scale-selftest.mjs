/**
 * S5: replay stays bounded at 10k+ events.
 *
 * The production call site is `service.getReplay`, reached through the same
 * service the HTTP route uses. Before this probe, replay called
 * `store.listEvents` (all events) and spread every timestamp into Math.min/
 * Math.max, so the response page was bounded but the work was O(all events).
 */
import assert from 'node:assert/strict';
import { openStore } from '../host/store.js';
import { createLabService } from '../host/lab-service.js';
import { memoryDomain, storeContext } from './lib/memory-domain.mjs';

const store = await openStore(storeContext(memoryDomain()));
const projectId = 'replay-scale';
await store.saveProject({
  id: projectId,
  name: projectId,
  revision: 0,
  counters: { eventSeq: 0 },
  config: { maxRunningNodes: 4, maxNodes: 20000 },
  createdAt: 1,
  updatedAt: 1,
});
for (let index = 0; index < 10_500; index += 1) {
  await store.saveNode(projectId, {
    id: `n-${index}`,
    title: `node ${index}`,
    status: 'completed',
    timestamps: { createdAt: index + 1, finishedAt: index + 2 },
  });
}
for (let index = 0; index < 10_500; index += 1) {
  const project = store.getProject(projectId);
  await store.appendEvent(project, index % 2 === 0 ? 'node/created' : 'node/completed', {
    nodeId: `n-${index}`,
    at: index + 1,
  });
}
const service = createLabService({
  ctx: { effect: () => {}, get: () => null, logger: { info() {}, warn() {} } },
  store,
  kernel: null,
  git: null,
  runtime: null,
  transcript: null,
  orchestrator: null,
  auto: null,
  cluster: null,
  clusterAdmin: null,
});
const before = process.memoryUsage().heapUsed;
const startedAt = process.hrtime.bigint();
const replay = await service.getReplay(projectId, { limit: 100, nodeLimit: 100 });
const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
const bytes = Buffer.byteLength(JSON.stringify(replay), 'utf8');
assert.equal(replay.events.length, 100, `events=${replay.events.length}`);
assert.equal(replay._truncated?.events?.total, 10_500, JSON.stringify(replay._truncated?.events));
assert.equal(replay.nodes.length, 100, `nodes=${replay.nodes.length}`);
assert.ok(replay.nextSeq > 0, 'replay must carry an event cursor');
assert.ok(replay.nextNodeCursor !== null, 'replay must carry a node cursor');
assert.ok(bytes < 1024 * 1024, `replay response is ${bytes} B`);
assert.ok(elapsedMs < 2000, `replay page took ${elapsedMs.toFixed(0)} ms`);
assert.ok(process.memoryUsage().heapUsed - before < 128 * 1024 * 1024, 'replay page must not retain the whole event log');
console.log(`ok   S5 replay is bounded at 10k events: events=${replay.events.length}/${replay._truncated.events.total}, nodes=${replay.nodes.length}, ${bytes} B, ${elapsedMs.toFixed(1)} ms`);
console.log('replay-scale-selftest: all checks passed');
