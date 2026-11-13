/**
 * B22 round 20: every dispute/operator HTTP route has one explicit policy.
 *
 * The point of this file is completeness, not a single probe: it asserts the
 * exported route inventory matches the routes actually registered, then drives
 * the four mutations (open, resolve, reopen, sweep) with and without the
 * Host-issued operator token. A missing token never becomes a human actor, and
 * the timeout sweep never accepts a caller clock because it is not an HTTP
 * mutation at all.
 */
import assert from 'node:assert/strict';
import { openStore } from '../host/store.js';
import { createKernel } from '../host/kernel/instance.js';
import { createLabService } from '../host/lab-service.js';
import { registerHttpRoutes, DISPUTE_ROUTE_POLICY } from '../host/http.js';
import { createOperatorAuthority } from '../host/operator-token.js';
import { memoryDomain, storeContext } from './lib/memory-domain.mjs';

let failed = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`ok   ${name}`);
  else { failed += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const PREFIX = '/api/metainfer-research-lab';
const store = await openStore(storeContext(memoryDomain()));
const kernel = createKernel({ store });
const projectId = 'dispute-route-p';
await store.saveProject({
  id: projectId,
  revision: 0,
  counters: { eventSeq: 0 },
  config: { maxRunningNodes: 2, resourcePools: {}, maxNodes: 100 },
  createdAt: 0,
  updatedAt: 0,
});
kernel.load(projectId);
await kernel.executor.commit(projectId, {
  actor: { kind: 'human', id: 'setup' },
  mutations: [
    { op: 'node.create', node: { id: 'root', title: 'root', status: 'planned', timestamps: { createdAt: 1 } } },
  ],
});

const operatorAuthority = createOperatorAuthority();
const service = createLabService({
  ctx: { effect: () => {}, get: () => null, logger: { info() {}, warn() {} } },
  store, kernel, git: null, runtime: null, transcript: null, orchestrator: null, auto: null, cluster: null, clusterAdmin: null,
  operatorAuthority,
});
const routes = new Map();
registerHttpRoutes({
  effect: () => {},
  connection: {
    fetch: {
      register({ path, fetch }) {
        routes.set(path, fetch);
        return () => {};
      },
    },
  },
}, service);

const raiserExec = { agent: { session: { id: 'route-raiser' } } };
const resolverExec = { agent: { session: { id: 'route-resolver' } } };
const thirdExec = { agent: { session: { id: 'route-third' } } };

const request = async (routePath, { method = 'GET', token = null, body = null } = {}) => {
  const [pathname, search = ''] = routePath.split('?');
  const full = PREFIX + pathname;
  const handler = routes.get(full);
  assert.ok(handler, `route is registered: ${full}`);
  const headers = {};
  if (body !== null) headers['content-type'] = 'application/json';
  if (token !== null) headers['x-metainfer-operator'] = token;
  const response = await handler(new Request('http://local' + full + (search ? '?' + search : ''), {
    method,
    headers,
    ...(body === null ? {} : { body: JSON.stringify(body) }),
  }));
  return response.json();
};

const pendingCount = () => service.listDisputes(projectId).disputes.filter((row) => row.status === 'pending').length;
const findDispute = (id) => service.listDisputes(projectId).disputes.find((row) => row.id === id);

// 1. Inventory: the same seven rows are registered, and the policy is explicit.
const registered = [...routes.keys()]
  .filter((path) => path.includes('/disputes') || path.endsWith('/arbitrate'))
  .sort();
const declared = [...new Set(DISPUTE_ROUTE_POLICY.map((row) => PREFIX + row.path))].sort();
check('the exported inventory covers exactly the registered dispute routes',
  JSON.stringify(registered) === JSON.stringify(declared),
  JSON.stringify({ registered, declared }));
check('every mutation route has an explicit token/refusal policy',
  DISPUTE_ROUTE_POLICY.filter((row) => row.method === 'POST').length === 5
  && DISPUTE_ROUTE_POLICY.find((row) => row.method === 'POST' && row.path.endsWith('/disputes'))?.policy === 'operator-token'
  && DISPUTE_ROUTE_POLICY.find((row) => row.method === 'POST' && row.path.endsWith('/disputes/resolve'))?.policy === 'operator-token'
  && DISPUTE_ROUTE_POLICY.find((row) => row.method === 'POST' && row.path.endsWith('/disputes/reopen'))?.policy === 'operator-token'
  && DISPUTE_ROUTE_POLICY.find((row) => row.method === 'POST' && row.path.endsWith('/disputes/sweep'))?.policy === 'refused'
  && DISPUTE_ROUTE_POLICY.find((row) => row.method === 'POST' && row.path.endsWith('/arbitrate'))?.policy === 'operator-token',
  JSON.stringify(DISPUTE_ROUTE_POLICY));

// 2. Reads stay reads; they never mint a human actor.
const listedNoToken = await request('/disputes?projectId=' + encodeURIComponent(projectId));
const classesNoToken = await request('/disputes/classes');
check('GET /disputes and /disputes/classes are read-only without a token',
  listedNoToken.ok === true && Array.isArray(listedNoToken.data?.disputes)
  && classesNoToken.ok === true && Object.keys(classesNoToken.data?.classes ?? {}).length === 8,
  JSON.stringify({ listedNoToken, classesNoToken }));

// 3. POST /disputes: absent caller is not the operator.
const beforeOpen = pendingCount();
const openNoToken = await request('/disputes', {
  method: 'POST',
  body: { projectId, type: 'resource_quantity', target: { nodeId: 'root' }, rationale: 'no token' },
});
check('POST /disputes without a token is actor_required and creates nothing',
  openNoToken.ok === false && openNoToken.error?.code === 'actor_required' && pendingCount() === beforeOpen,
  JSON.stringify(openNoToken));

const openWithToken = await request('/disputes', {
  method: 'POST',
  token: operatorAuthority.token,
  body: {
    projectId, type: 'resource_quantity', target: { nodeId: 'root' }, rationale: 'operator open',
    evidence: [{ nodeId: 'root', field: 'needs.gpu' }],
  },
});
check('POST /disputes with the real operator token creates one row',
  openWithToken.ok === true && Boolean(openWithToken.data?.dispute?.id) && pendingCount() === beforeOpen + 1,
  JSON.stringify(openWithToken));
const openedId = openWithToken.data.dispute.id;

// 4. Reopen: two independent gates on the same route.
const resolved = await service.resolveDispute(projectId, openedId, { resolution: 'keep_current', reason: 'resolver decision' }, resolverExec);
check('the reopen fixture has a different resolver', resolved.ok === true && resolved.dispute.resolvedBy?.id === 'route-resolver', JSON.stringify(resolved));
const reopenNoToken = await request('/disputes/reopen', {
  method: 'POST',
  body: { projectId, disputeId: openedId, evidence: [{ nodeId: 'root', field: 'needs.gpu', quote: '8' }] },
});
check('POST /disputes/reopen without a token is actor_required and leaves the row resolved',
  reopenNoToken.ok === false && reopenNoToken.error?.code === 'actor_required' && findDispute(openedId)?.status === 'resolved',
  JSON.stringify(reopenNoToken));

const reopenWithToken = await request('/disputes/reopen', {
  method: 'POST',
  token: operatorAuthority.token,
  body: { projectId, disputeId: openedId, evidence: [{ nodeId: 'root', field: 'needs.gpu', quote: '8' }] },
});
check('POST /disputes/reopen with the token, by a different actor, returns a pending row',
  reopenWithToken.ok === true && findDispute(openedId)?.status === 'pending'
  && reopenWithToken.data?.dispute?.reopenedBy?.id === 'operator',
  JSON.stringify({ reopenWithToken, persisted: findDispute(openedId) }));

const selfOpen = await service.openDispute(projectId, {
  type: 'fact_conflict', target: { nodeId: 'root' }, evidence: [{ nodeId: 'root', field: 'report' }],
}, raiserExec);
const selfResolveHttp = await request('/disputes/resolve', {
  method: 'POST',
  token: operatorAuthority.token,
  body: { projectId, disputeId: selfOpen.dispute.id, resolution: 'keep_current', reason: 'operator decision' },
});
const selfReopenHttp = await request('/disputes/reopen', {
  method: 'POST',
  token: operatorAuthority.token,
  body: { projectId, disputeId: selfOpen.dispute.id, evidence: [{ nodeId: 'root', field: 'report', quote: 'new' }] },
});
check('the resolver cannot reopen its own resolution, even with the token',
  selfResolveHttp.ok === true && selfReopenHttp.ok === false
  && selfReopenHttp.error?.code === 'dispute_reopen_requires_different_actor'
  && findDispute(selfOpen.dispute.id)?.status === 'resolved',
  JSON.stringify({ selfResolveHttp, selfReopenHttp }));

// 5. /commands is token-gated; destructive types still go through the
// claim/appeal gate after the token is accepted. A token is not a bypass.
const commandNoToken = await request('/commands', {
  method: 'POST', body: { type: 'project.update', projectId, name: 'http command no token' },
});
check('POST /commands without a token is actor_required',
  commandNoToken.ok === false && commandNoToken.error?.code === 'actor_required',
  JSON.stringify(commandNoToken));
const commandWithToken = await request('/commands', {
  method: 'POST', token: operatorAuthority.token, body: { type: 'project.update', projectId, name: 'http command token' },
});
check('POST /commands with the token reaches the non-destructive command',
  commandWithToken.ok === true && commandWithToken.data?.project?.name === 'http command token',
  JSON.stringify(commandWithToken));
const deleteNoToken = await request('/commands', {
  method: 'POST', body: { type: 'project.delete', projectId, removeWorktrees: false },
});
const deleteWithToken = await request('/commands', {
  method: 'POST', token: operatorAuthority.token,
  body: { type: 'project.delete', projectId, removeWorktrees: false, actor: { kind: 'human', id: 'body-attacker' } },
});
check('POST /commands project.delete is token-gated and remains behind the claim gate',
  deleteNoToken.ok === false && deleteNoToken.error?.code === 'actor_required'
  && deleteWithToken.ok === false && deleteWithToken.error?.code === 'human_confirmation_required'
  && Boolean(store.getProject(projectId)),
  JSON.stringify({ deleteNoToken, deleteWithToken }));

// 6. Sweep is scheduler-only: both a future and a past caller clock are refused.
const pending = await service.openDispute(projectId, {
  type: 'stale_basis', target: { nodeId: 'root' }, evidence: [{ nodeId: 'root', field: 'revision' }],
}, thirdExec);
const pendingId = pending.dispute.id;
const futureSweep = await request('/disputes/sweep', {
  method: 'POST',
  body: { projectId, now: Date.now() + 10 * 24 * 60 * 60_000 },
});
const pastSweep = await request('/disputes/sweep', {
  method: 'POST',
  token: operatorAuthority.token,
  body: { projectId, now: 0 },
});
check('POST /disputes/sweep refuses caller clocks (future and past) and leaves the row pending',
  futureSweep.ok === false && futureSweep.error?.code === 'forbidden_action'
  && pastSweep.ok === false && pastSweep.error?.code === 'forbidden_action'
  && findDispute(pendingId)?.status === 'pending',
  JSON.stringify({ futureSweep, pastSweep, persisted: findDispute(pendingId)?.status }));

// 7. The service's scheduler entry point uses Host time, not a passed clock.
const sweepService = await service.sweepDisputes(projectId, { now: Date.now() + 10 * 24 * 60 * 60_000 });
check('the scheduler sweep ignores a caller-supplied future clock',
  sweepService.ok === true && sweepService.timedOut.length === 0 && findDispute(pendingId)?.status === 'pending',
  JSON.stringify({ sweepService, persisted: findDispute(pendingId)?.status }));

console.log('');
if (failed > 0) {
  console.log(`dispute-route-selftest: ${failed} FAILED`);
  process.exit(1);
}
console.log('dispute-route-selftest: all checks passed');
