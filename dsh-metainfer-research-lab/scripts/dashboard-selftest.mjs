/**
 * U13/U14: dashboard reads separate Host-computed facts from agent-authored
 * widgets/chat, and mark stale data with its age instead of presenting it as
 * current fact.
 */
import assert from 'node:assert/strict';
import { openStore } from '../host/store.js';
import { createKernel } from '../host/kernel/instance.js';
import { createLabService } from '../host/lab-service.js';
import { memoryDomain, storeContext } from './lib/memory-domain.mjs';

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`ok   ${name}`); }
  catch (error) { failed += 1; console.log(`FAIL ${name} — ${error.message}`); }
}

const store = await openStore(storeContext(memoryDomain()));
const kernel = createKernel({ store });
const projectId = 'dash-p';
const old = Date.now() - 30 * 60_000;
await store.saveProject({
  id: projectId,
  revision: 0,
  counters: { eventSeq: 0 },
  config: { resourcePools: { gpu: 2 } },
  dashboard: {
    spec: { title: 'D', prompt: '', intervalMinutes: 1, enabled: true },
    widgets: [
      { id: 'agent-w', title: 'Agent view', type: 'text', config: { collector: 'agent' }, data: { body: 'AGENT PROSE', status: 'ok' }, updatedAt: old },
      { id: 'host-w', title: 'Host view', type: 'metric', config: { collector: 'script', script: 'true' }, data: { value: '2', status: 'ok' }, updatedAt: old },
    ],
    chat: [
      { role: 'assistant', text: 'AGENT COMMENTARY', at: old },
      { role: 'user', text: 'human note', at: old },
    ],
    lastRun: { status: 'ok', startedAt: old, endedAt: old, revision: 0 },
  },
  createdAt: old,
  updatedAt: old,
});
kernel.load(projectId);
await kernel.executor.commit(projectId, {
  actor: { kind: 'human', id: 'test' },
  mutations: [{ op: 'node.create', node: { id: 'n1', title: 'root', status: 'planned', timestamps: { createdAt: 1 } } }],
});
const service = createLabService({
  ctx: { effect: () => {}, get: () => null, logger: { info() {}, warn() {} } },
  store, kernel, git: null, runtime: null, transcript: null, orchestrator: null, auto: null, cluster: null, clusterAdmin: null,
});
const view = await service.getDashboard(projectId);

check('dashboard returns Host facts with no agent prose', () => {
  assert.equal(view.hostFacts?.source, 'host');
  assert.equal(view.hostFacts?.projectRevision, 1);
  assert.equal(view.hostFacts?.counts?.total, 1);
  assert.deepEqual(view.hostFacts?.resources, { gpu: 2 });
  assert.doesNotMatch(JSON.stringify(view.hostFacts), /AGENT PROSE|AGENT COMMENTARY/);
});
check('agent widgets are attributed to the agent', () => {
  const agent = view.widgets.find((widget) => widget.id === 'agent-w');
  assert.equal(agent.dataSource, 'agent');
  assert.equal(agent.stale, true);
  assert.ok(agent.ageMs >= 29 * 60_000);
});
check('script widgets are attributed to the Host', () => {
  assert.equal(view.widgets.find((widget) => widget.id === 'host-w').dataSource, 'host');
});
check('chat entries carry source attribution', () => {
  assert.equal(view.chat.find((entry) => entry.role === 'assistant').source, 'agent');
  assert.equal(view.chat.find((entry) => entry.role === 'user').source, 'human');
});
check('revision drift is a stale reason, not a fresh fact', () => {
  assert.equal(view.stale, true);
  assert.equal(view.staleReason, 'revision_changed');
  assert.equal(view.commentary.source, 'agent');
  assert.equal(view.commentary.staleReason, 'revision_changed');
});
check('stale view carries the age and threshold', () => {
  assert.ok(view.ageMs >= 29 * 60_000);
  assert.equal(view.commentary.staleAfterMs, 120_000);
  assert.equal(view.commentary.ageMs, view.ageMs);
});

// Same revision, old timestamp: age alone marks stale.
const project = store.getProject(projectId);
await kernel.executor.commit(projectId, {
  actor: { kind: 'human', id: 'test' },
  mutations: [{ op: 'project.update', set: { dashboard: { ...project.dashboard, lastRun: { ...project.dashboard.lastRun, revision: 2 } } } }],
});
const aged = await service.getDashboard(projectId);
check('age alone marks an agent view stale', () => {
  assert.equal(aged.stale, true);
  assert.equal(aged.staleReason, 'age');
  assert.ok(aged.commentary.ageMs > aged.commentary.staleAfterMs);
});

console.log(failed === 0 ? '\ndashboard-selftest: all checks passed' : `\ndashboard-selftest: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
