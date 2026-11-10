/**
 * Single-writer regression (G1). Two independent checks:
 *  1. no production module outside the executor/store may call a mutating store method;
 *  2. with `strictWrites=throw`, representative runtime + service mutations still
 *     succeed, while a direct store write is rejected.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../host/store.js';
import { createKernel } from '../host/kernel/instance.js';
import { createLabService } from '../host/lab-service.js';
import { createRuntime } from '../host/runtime.js';
import { memoryDomain, storeContext } from './lib/memory-domain.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`ok   ${name}`);
  else { failed += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// 1. Static bypass guard: a new direct writer fails this test immediately.
const guarded = [
  'host/runtime.js', 'host/gc.js', 'host/reconcile.js', 'host/auto.js',
  'host/lab-service.js', 'host/orchestrator.js',
];
const pattern = /\bstore\.(save[A-Z][A-Za-z]*|appendEvent|deleteNode|deleteProject|deleteEventRecord)\s*\(/;
const offenders = [];
for (const file of guarded) {
  const source = await readFile(path.join(root, file), 'utf8');
  for (const [index, line] of source.split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
    if (pattern.test(line)) offenders.push(`${file}:${index + 1}`);
  }
}
check('no production module writes the store directly', offenders.length === 0, offenders.join(', '));

const fakeCtx = { effect: () => {}, get: () => null, logger: { info() {}, warn() {} } };
const store = await openStore(storeContext(memoryDomain()));
const kernel = createKernel({ store });
const runtime = createRuntime({ ctx: fakeCtx, store, git: null, kernel, onTerminated: () => {}, cluster: null });
const service = createLabService({
  ctx: fakeCtx, store, kernel, git: null, runtime, transcript: null, orchestrator: null, auto: null, cluster: null, clusterAdmin: null,
});

// Setup happens before the guard is armed (fixtures are not production writes).
await store.saveProject({
  id: 'p', revision: 0, counters: { eventSeq: 0, nextNodeSeq: 4, nodes: 2, cycles: 0 },
  config: { maxRunningNodes: 4, maxNodes: 100, nodeTimeoutMinutes: 5, resourcePools: { gpu: 4 }, dashboard: { widgets: [], spec: { enabled: false } } },
  dashboard: { spec: { enabled: false, intervalMinutes: 60, widgets: [] }, widgets: [], chat: [] },
  chatLog: [], createdAt: 0, updatedAt: 0,
});
kernel.load('p');
await kernel.executor.commit('p', {
  actor: { kind: 'human', id: 'test' },
  mutations: [
    { op: 'node.create', node: { id: 'n1', title: 'one', status: 'planned', timestamps: { createdAt: 1 } } },
    { op: 'node.create', node: { id: 'n2', title: 'two', status: 'planned', timestamps: { createdAt: 2 } } },
  ],
});
store.setStrictWrites('throw');

// 2a. A direct write is rejected; the guard is actually armed.
let bypass = null;
try {
  await store.saveProject({ ...store.getProject('p'), name: 'bypass' });
} catch (error) { bypass = error; }
check('direct store write is rejected under throw', bypass?.code === 'unpermitted_write', String(bypass?.code));
check('bypass did not change the project', store.getProject('p').name !== 'bypass');

// 2b. Service mutations through the executor still work.
const updated = await service.updateProject('p', { name: 'renamed-by-service' });
check('service updateProject succeeds under throw', store.getProject('p').name === 'renamed-by-service', JSON.stringify(updated?.revision));
const edited = await service.updateNode('p', 'n1', { title: 'renamed-node' });
check('service updateNode succeeds under throw', store.getNode('p', 'n1').title === 'renamed-node', JSON.stringify(edited?.revision));
const cleared = await service.clearProjectChat('p');
check('service clearProjectChat succeeds under throw', cleared.messages.length === 0);
let dashboard = null;
try { dashboard = await service.updateDashboardLayout('p', []); }
catch (error) { console.log('dashboard error:', error.code, error.message); }
check('service dashboard write succeeds under throw', Array.isArray(dashboard?.widgets), JSON.stringify(dashboard));
const priority = await service.setNodePriority('p', 'n1', { class: 'p1' });
check('service priority write succeeds under throw', priority.ok === true && store.getNode('p', 'n1').priority.class === 'p1', JSON.stringify(priority));

// 2c. Runtime cancellation goes through the executor even though it holds the lock.
const revisionBefore = store.getProject('p').revision;
await runtime.cancel('p', 'n2');
check('runtime cancel succeeds under throw', store.getNode('p', 'n2').status === 'cancelled', store.getNode('p', 'n2').status);
check('runtime cancel advanced the revision', store.getProject('p').revision > revisionBefore, `${revisionBefore}->${store.getProject('p').revision}`);
check('runtime cancel wrote a caused event', store.listEvents('p', 0).some((event) => event.type === 'node/cancelled' && event.nodeId === 'n2' && event.causeId));

const stats = store.writeStats();
check('only the deliberate bypass was rejected', stats.unpermitted === 1 && stats.byOp.saveProject === 1, JSON.stringify(stats));

console.log(failed === 0 ? '\nstrict-writes-selftest: all checks passed' : `\nstrict-writes-selftest: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
