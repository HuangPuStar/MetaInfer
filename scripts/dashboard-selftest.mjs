/**
 * U13/U14: dashboard reads separate Host-computed facts from agent-authored
 * widgets/chat, and mark stale data with its age instead of presenting it as
 * current fact.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../host/store.js';
import { createKernel } from '../host/kernel/instance.js';
import { createLabService } from '../host/lab-service.js';
import { memoryDomain, storeContext } from './lib/memory-domain.mjs';

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`ok   ${name}`); }
  catch (error) { failed += 1; console.log(`FAIL ${name} — ${error.message}`); }
}
async function checkAsync(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); }
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
check('O12: dashboard exposes structured GPU, cost and narrative facts', () => {
  assert.equal(view.hostFacts?.gpu?.total, 2);
  assert.equal(view.hostFacts?.gpu?.held, 0);
  assert.equal(view.hostFacts?.gpu?.free, 2);
  assert.equal(view.hostFacts?.gpu?.utilization, 0);
  assert.equal(view.hostFacts?.cost?.tokensUsed, 0);
  assert.equal(view.hostFacts?.cost?.costUsd, 0);
  assert.equal(view.hostFacts?.narrative?.sections?.length, 3);
  assert.equal(view.hostFacts?.narrative?.sections?.find((row) => row.key === 'gpu')?.values?.total, 2);
  assert.doesNotMatch(JSON.stringify(view.hostFacts?.narrative), /AGENT PROSE|AGENT COMMENTARY/);
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

const refreshId = 'dash-refresh';
const refreshRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mir-dash-refresh-'));
const marker = path.join(refreshRoot, 'fail-marker');
let lastGoodRevision = 0;
const script = `if [ -f '${marker}' ]; then exit 9; else echo '{"data":{"value":"ok"}}'; fi`;
await store.saveProject({
  id: refreshId,
  revision: 2,
  counters: { eventSeq: 0 },
  config: { resourcePools: { gpu: 1 } },
  repo: { path: refreshRoot },
  dashboard: {
    spec: { title: 'R', prompt: '', intervalMinutes: 1, enabled: true },
    widgets: [{ id: 'w1', title: 'W', type: 'text', config: { collector: 'script', script }, data: { body: 'old' }, updatedAt: old }],
    lastRun: { status: 'ok', startedAt: old, endedAt: old, revision: 0, lastSuccessAt: old },
  },
  createdAt: old,
  updatedAt: old,
});
kernel.load(refreshId);
await checkAsync('a successful refresh records the revision it actually read', async () => {
  const view = await service.refreshDashboard(refreshId, { force: true });
  assert.equal(view.lastRun?.status, 'ok');
  assert.equal(view.lastRun?.revision, 2);
  assert.equal(view.lastRun?.dataRevision, 2);
  assert.equal(view.lastRun?.committedRevision, store.getProject(refreshId).revision);
  lastGoodRevision = view.lastRun?.revision;
  assert.equal(view.commentary?.lastSuccessAt, view.lastRun?.endedAt);
  assert.equal(view.stale, false);
  assert.equal(view.staleReason, null);
});
await checkAsync('a failed refresh with aligned revisions stays stale', async () => {
  fs.writeFileSync(marker, 'fail');
  const view = await service.refreshDashboard(refreshId, { force: true });
  assert.equal(view.lastRun?.status, 'error');
  assert.equal(view.lastRun?.revision, lastGoodRevision, 'the last successful revision must not be overwritten');
  assert.ok(view.lastRun?.lastSuccessAt > 0);
  assert.equal(view.stale, true);
  assert.equal(view.staleReason, 'refresh_failed');
  assert.equal(view.commentary?.staleReason, 'refresh_failed');
  assert.ok(view.lastRun?.errorHint, 'failed refresh must carry an executable hint');
});
await checkAsync('consecutive failures degrade and back off', async () => {
  let view = await service.refreshDashboard(refreshId, { force: true });
  view = await service.refreshDashboard(refreshId, { force: true });
  assert.ok(view.lastRun?.consecutiveFailures >= 3, JSON.stringify(view.lastRun));
  assert.equal(view.degraded, true);
  assert.equal(view.commentary?.degraded, true);
  assert.equal(view.widgets[0]?.degraded, true);
  assert.ok(view.nextRunAt > Date.now() + 60_000, 'failure backoff must exceed the normal interval');
});
// Partial refresh: one widget succeeds, one fails. The top view must not claim
// fresh, and repeated partial attempts must degrade/back off like failures.
const partialId = 'dash-partial';
const partialRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mir-dash-partial-'));
await store.saveProject({
  id: partialId,
  revision: 1,
  counters: { eventSeq: 0 },
  config: { resourcePools: { gpu: 1 } },
  repo: { path: partialRoot },
  dashboard: {
    spec: { title: 'P', prompt: '', intervalMinutes: 1, enabled: true },
    widgets: [
      { id: 'good', title: 'Good', type: 'text', config: { collector: 'script', script: 'echo \'{"data":{"body":"ok"}}\'' }, data: { body: 'old' }, updatedAt: old },
      { id: 'bad', title: 'Bad', type: 'text', config: { collector: 'script', script: 'exit 7' }, data: { body: 'old' }, updatedAt: old },
    ],
    lastRun: { status: 'ok', startedAt: old, endedAt: old, revision: 0, lastSuccessAt: old },
  },
  createdAt: old,
  updatedAt: old,
});
kernel.load(partialId);
await checkAsync('a partial refresh is stale and keeps the last good success', async () => {
  const view = await service.refreshDashboard(partialId, { force: true });
  assert.equal(view.lastRun?.status, 'partial');
  assert.equal(view.stale, true);
  assert.equal(view.staleReason, 'refresh_partial');
  assert.equal(view.commentary?.staleReason, 'refresh_partial');
  assert.equal(view.failureCount, view.lastRun?.consecutiveFailures);
  assert.ok(view.failureCount >= 1);
  assert.ok(view.commentary?.lastSuccessAt <= old + 1, 'partial refresh must not advance lastSuccessAt');
  assert.ok(view.lastRun?.errorHint, 'partial refresh must carry an executable hint');
  assert.equal(view.widgets.find((widget) => widget.id === 'bad')?.lastRefresh?.status, 'error');
  assert.equal(view.widgets.find((widget) => widget.id === 'good')?.lastRefresh?.status, 'ok');
});
await checkAsync('repeated partial refreshes degrade and back off', async () => {
  await service.refreshDashboard(partialId, { force: true });
  const view = await service.refreshDashboard(partialId, { force: true });
  assert.ok(view.lastRun?.consecutiveFailures >= 3, JSON.stringify(view.lastRun));
  assert.equal(view.degraded, true);
  assert.ok(view.nextRunAt > Date.now() + 60_000);
});
fs.rmSync(partialRoot, { recursive: true, force: true });

fs.rmSync(refreshRoot, { recursive: true, force: true });

console.log(failed === 0 ? '\ndashboard-selftest: all checks passed' : `\ndashboard-selftest: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
