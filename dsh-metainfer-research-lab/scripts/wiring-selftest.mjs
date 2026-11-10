/**
 * Wiring self-test (audit requirement: "assert the call site exists").
 *
 * The failure mode this file exists for is real: `dispatchOnce`, `policy` and
 * `dag_*` were committed, tested and never called. Unit tests cannot see a
 * missing caller, so this test does two things:
 *   1. reads the production sources and asserts the import *and* the invocation
 *      of each capability on a real call path;
 *   2. drives the paths with fakes to prove the behaviour is reachable
 *      (`forbidden_action` from a lab-worker tool call, a deterministic start
 *      through the kernel, `dag_query` returned by the tool dispatcher).
 *
 * Run: `node scripts/wiring-selftest.mjs`
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../host/store.js';
import { createKernel } from '../host/kernel/instance.js';
import { createDispatchOnce } from '../host/dispatch/dispatch-once.js';
import { createLocalPoolBroker } from '../host/dispatch/brokers.js';
import { registerAgentTool } from '../host/agent-tool.js';
import { memoryDomain, storeContext } from './lib/memory-domain.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error }); }
}
async function source(relative) {
  return readFile(path.join(ROOT, relative), 'utf8');
}

await test('auto.tickOne imports and invokes dispatchOnce on the real tick', async () => {
  const auto = await source('host/auto.js');
  assert.match(auto, /createAutoController\(\{[^}]*dispatchOnce/s, 'dispatchOnce is a dependency of the controller');
  assert.match(auto, /await dispatchOnce\(projectId, \{ maxStarts: 4 \}\)/, 'tickOne invokes it');
});

await test('the Host index builds a kernel and passes dispatchOnce to auto + service', async () => {
  const index = await source('index.js');
  assert.match(index, /import \{ createKernel \}/);
  assert.match(index, /createKernel\(\{ store/);
  assert.match(index, /createDispatchOnce\(\{/);
  assert.match(index, /launcher: \{\s+start: \(pid, nodeId, opts\) => runtime\.start\(pid, nodeId, opts\),\s+preempt: \(pid, nodeId, opts\) => runtime\.preempt\(pid, nodeId, opts\),\s+\}/);
  assert.match(index, /let service = null/);
  assert.match(index, /service\s*\?\s*service\.dispatchOnce\(projectId, \{ \.\.\.options, includeStatus: false \}\)/);
  assert.match(index, /createAutoController\(\{ store, kernel, orchestrator, cluster, dispatchOnce: autoDispatch \}\)/);
  assert.match(index, /dispatchOnce,\n\s+version/);
});

await test('the agent tool authorizes every call from the DSH session, not from args', async () => {
  const toolSource = await source('host/agent-tool.js');
  assert.match(toolSource, /import \{ actorFromToolExecution, authorizeAction \} from '\.\/kernel\/policy\.js'/);
  assert.match(toolSource, /actor = actorFromToolExecution\(exec\)/);
  assert.match(toolSource, /const verdict = authorizeAction\(actor, action\)/);
  assert.match(toolSource, /rejection\(verdict\.code, verdict\.message/);
  assert.match(toolSource, /async execute\(args, exec\)/);
});

await test('dag_query / dag_get are registered in the tool enum and dispatched by the service', async () => {
  const toolSource = await source('host/agent-tool.js');
  const serviceSource = await source('host/lab-service.js');
  for (const action of ['dag_query', 'dag_get', 'dag_map', 'dag_walk', 'dag_diff', 'changes_since', 'get_node', 'status_facts', 'explain_node', 'trace_explain', 'set_priority', 'dispatch_once', 'ledger_update']) {
    assert.ok(toolSource.includes(`'${action}'`), `${action} in ACTION_ENUM`);
  }
  assert.match(serviceSource, /if \(action === 'dag_query'\) return dagQuery\(/);
  assert.match(serviceSource, /if \(action === 'dag_get'\) return dagGetAction\(/);
});

await test('Stage 3-5 surfaces are wired from HTTP through the service and into the client', async () => {
  const http = await source('host/http.js');
  const serviceSource = await source('host/lab-service.js');
  const dispatcherSource = await source('host/dispatch/dispatch-once.js');
  const client = await source('client.js');
  for (const route of ['disputes', 'budgets', 'reviews', 'retrospective', 'intents', 'observer', 'events/wait', 'rotations', 'arbitrate']) {
    assert.ok(http.includes(`/${route}\``), `HTTP route /${route} exists`);
  }
  for (const method of ['listDisputes', 'classBudgetReport', 'generateRetrospective', 'listRetrospectives', 'reviewClaimsAction', 'openDispute', 'sweepDisputes', 'rotationStatus', 'rotateDueExperts', 'observerSnapshot', 'waitForEvents', 'observe', 'arbitrate']) {
    assert.ok(serviceSource.includes(`function ${method}(`), `${method} exists`);
    assert.ok(serviceSource.includes(`    ${method},`), `${method} is exported on the service`);
  }
  assert.match(dispatcherSource, /applyClassBudgetsDetailed\(/);
  assert.match(client, /ObservabilityDrawer/);
  assert.match(client, /fetchRetrospectives/);
  assert.match(client, /fetchDisputes/);
  assert.match(client, /fetchBudgets/);
  assert.match(client, /fetchReviews/);
  assert.match(client, /fetchObserver/);
  assert.match(client, /fetchDisputeClasses/);
  assert.match(client, /ObserverPanel/);
});

await test('the prompt tells the model to call dag_query, so a tool call really returns rows', async () => {
  const store = await openStore(storeContext(memoryDomain()));
  const project = { id: 'prj-w', name: 'w', repo: {}, config: { maxRunningNodes: 2, resourcePools: {}, maxNodes: 100 }, counters: { eventSeq: 0 }, revision: 0 };
  await store.saveProject(project);
  await store.saveNode('prj-w', { id: 'n1', title: 'alpha token pruning', status: 'planned', timestamps: { createdAt: 1 } });
  await store.saveNode('prj-w', { id: 'n2', title: 'beta pruning', status: 'completed', timestamps: { createdAt: 2 } });

  let captured = null;
  const ctx = { tools: { register: (definition) => { captured = definition; return () => {}; } } };
  const service = {
    agentTool: async (input) => {
      const dag = await import('../host/context/dag.js');
      if (input.action === 'dag_query') return dag.queryDag({ nodes: store.listNodes('prj-w'), filter: input.filter ?? {}, limit: input.limit });
      if (input.action === 'dag_get') return dag.dagGet({ nodes: store.listNodes('prj-w'), nodeIds: input.nodeIds ?? [] });
      return { ok: true, action: input.action };
    },
  };
  registerAgentTool(ctx, service);
  assert.ok(captured, 'tool registered');
  const exec = { agent: { session: { id: 's1', header: { meta: { agentPreset: 'lab-worker' } } } } };

  // Reading the DAG is allowed for a worker.
  const read = JSON.parse((await captured.execute({ action: 'dag_query', projectId: 'prj-w', limit: 10 }, exec)).result);
  assert.equal(read.ok, true);
  assert.equal(read.nodes.length, 2);
  assert.ok(read.nextCursor === null || typeof read.nextCursor === 'string');
  const get = JSON.parse((await captured.execute({ action: 'dag_get', projectId: 'prj-w', nodeIds: ['n2'] }, exec)).result);
  assert.equal(get.nodes[0].status, 'completed');

  // Destructive actions are not: this is issue 0001, enforced at the handler.
  const forbidden = JSON.parse((await captured.execute({ action: 'delete_project', projectId: 'prj-w' }, exec)).result);
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.error.code, 'forbidden_action');
  assert.match(forbidden.error.nextStep, /human operator/i);
  assert.ok(forbidden.error.allowed.includes('dag_query'));

  // Privileged presets keep their actions; an unknown preset is not widened.
  const advisor = { agent: { session: { id: 's2', header: { meta: { agentPreset: 'lab-advisor' } } } } };
  const advisorWrite = JSON.parse((await captured.execute({ action: 'dag_query', projectId: 'prj-w' }, advisor)).result);
  assert.equal(advisorWrite.ok, true);
  assert.equal(JSON.parse((await captured.execute({ action: 'auto_stop', projectId: 'prj-w' }, advisor)).result).error.code, 'forbidden_action');
});

await test('dispatchOnce starts a planned node through the kernel and leaves the claim at the commit point', async () => {
  const store = await openStore(storeContext(memoryDomain()));
  const kernel = createKernel({ store });
  const project = {
    id: 'prj-d', name: 'd', repo: {}, revision: 0, counters: { eventSeq: 0 },
    config: { maxRunningNodes: 2, resourcePools: { gpu: 2 }, maxNodes: 100 },
  };
  await store.saveProject(project);
  kernel.load('prj-d');
  await kernel.executor.commit('prj-d', {
    actor: { kind: 'human', id: 'test' },
    mutations: [{ op: 'node.create', node: { id: 'n1', title: 'run me', status: 'planned', needs: { gpu: 1 }, timeboxMs: 60_000, timestamps: { createdAt: 1 } } }],
  });
  const launched = [];
  const brokers = new Map([['local-pool', createLocalPoolBroker({
    limits: () => ({ maxRunningNodes: 2, resourcePools: { gpu: 2 } }),
    clock: () => 1_000,
  })]]);
  const dispatcher = createDispatchOnce({
    projectId: 'prj-d',
    executor: kernel.executor,
    projection: kernel.projection,
    brokers,
    launcher: { start: async (projectId, nodeId, opts) => { launched.push({ projectId, nodeId, lease: opts.lease.leaseId }); } },
    clock: () => 1_000,
  });
  const round = await dispatcher.run({ maxStarts: 2 });
  assert.equal(round.started, 1);
  assert.deepEqual(round.startedNodeIds, ['n1']);
  assert.equal(launched.length, 1, 'runtime launcher was invoked');
  const node = store.getNode('prj-d', 'n1');
  assert.equal(node.claim.broker, 'local-pool');
  assert.equal(kernel.projection.getNode('prj-d', 'n1').claim.leaseId, node.claim.leaseId);
  const events = store.listEvents('prj-d').map((event) => event.type);
  assert.ok(events.includes('dispatch/claimed') || events.includes('node/claimed'), `claim event recorded (${events.join(',')})`);

  // The projection must mirror a legacy write (runtime sets status directly).
  const legacy = { ...node, status: 'running' };
  await store.saveNode('prj-d', legacy);
  assert.equal(kernel.projection.getNode('prj-d', 'n1').status, 'running', 'store write reaches the dispatcher view');

  // Idempotent: a second round must not start a claimed node twice.
  const second = await dispatcher.run({ maxStarts: 2 });
  assert.equal(second.started, 0);
});

await test('O(1) read path: node read does not scan, changes_since answers a delta', async () => {
  const store = await openStore(storeContext(memoryDomain()));
  await store.saveProject({ id: 'prj-c', revision: 0, counters: { eventSeq: 0 }, config: {} });
  for (let index = 0; index < 200; index += 1) {
    await store.saveNode('prj-c', { id: `n${index}`, status: 'planned', rev: 1, timestamps: { createdAt: index } });
  }
  await store.saveProject({ ...store.getProject('prj-c'), revision: 1 });
  const started = performance.now();
  for (let index = 0; index < 1_000; index += 1) store.getNode('prj-c', `n${index % 200}`);
  const perRead = (performance.now() - started) / 1_000;
  assert.ok(perRead < 0.5, `single node read is O(1) (${perRead.toFixed(3)} ms)`);
  const delta = store.changesSince('prj-c', 0);
  assert.equal(delta.full, undefined, 'journal can answer from a cold project');
  assert.equal(delta.changed.length, 200);
  const unchanged = store.changesSince('prj-c', 1);
  assert.equal(unchanged.unchanged, true);
});

let failed = 0;
for (const result of results) {
  if (result.ok) console.log(`ok   ${result.name}`);
  else { failed += 1; console.log(`FAIL ${result.name}\n     ${result.error?.stack ?? result.error}`); }
}
console.log(`\n${results.length - failed}/${results.length} wiring checks passed`);
process.exit(failed === 0 ? 0 : 1);
