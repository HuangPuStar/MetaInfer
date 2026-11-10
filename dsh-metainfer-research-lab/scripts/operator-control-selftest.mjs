#!/usr/bin/env node
/**
 * Real-service probes for the operator control plane. The route-level table
 * probe lives in operator-route-selftest; this file checks that the token actor,
 * not a JSON body actor, reaches the actual LabService/runtime boundary for the
 * routes that were previously unauthenticated.
 */
import assert from 'node:assert/strict';
import { openStore } from '../host/store.js';
import { createKernel } from '../host/kernel/instance.js';
import { createLabService } from '../host/lab-service.js';
import { registerHttpRoutes } from '../host/http.js';
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
const projectId = 'operator-control-p';
await store.saveProject({
  id: projectId, revision: 0, counters: { eventSeq: 0 },
  config: { maxRunningNodes: 2, resourcePools: {}, maxNodes: 100 },
  createdAt: 0, updatedAt: 0,
});
kernel.load(projectId);
await kernel.executor.commit(projectId, {
  actor: { kind: 'human', id: 'setup' },
  mutations: [{ op: 'node.create', node: { id: 'root', title: 'root', status: 'planned', timestamps: { createdAt: 1 } } }],
});

const authority = createOperatorAuthority();
const runtimeAppeals = [];
const runtime = {
  appealPreemption: async (pid, nodeId, options) => {
    runtimeAppeals.push({ pid, nodeId, options });
    return { ok: true, projectId: pid, nodeId, appeal: { status: 'appealed', by: options.actor } };
  },
};
const service = createLabService({
  ctx: { effect: () => {}, get: () => null, logger: { info() {}, warn() {} } },
  store, kernel, git: null, runtime, transcript: null, orchestrator: null,
  auto: { statusOf: () => ({ status: 'off', pauseReason: null }), stop: async () => {} },
  cluster: null, clusterAdmin: null, operatorAuthority: authority,
});
const routes = new Map();
registerHttpRoutes({
  effect: () => {},
  connection: { fetch: { register({ path, fetch }) { routes.set(path, fetch); return () => {}; } } },
}, service);

const request = async (routePath, { method = 'GET', token = null, body } = {}) => {
  const [pathname, search = ''] = routePath.split('?');
  const handler = routes.get(PREFIX + pathname);
  assert.ok(handler, `route registered: ${pathname}`);
  const headers = { accept: 'application/json' };
  if (token !== null) headers['x-metainfer-operator'] = token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await handler(new Request(`http://local${PREFIX}${pathname}${search ? '?' + search : ''}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return response.json();
};

const dashboardNoToken = await request(`/dashboard?projectId=${projectId}`);
const dashboardWithToken = await request(`/dashboard?projectId=${projectId}`, { token: authority.token });
check('GET /dashboard is token-gated and the token read succeeds',
  dashboardNoToken.ok === false && dashboardNoToken.error?.code === 'actor_required'
  && dashboardWithToken.ok === true && dashboardWithToken.data?.spec?.enabled !== undefined,
  JSON.stringify({ dashboardNoToken, dashboardWithToken }));

const retroNoToken = await request('/retrospective', { method: 'POST', body: { projectId } });
const retroWithToken = await request('/retrospective', { method: 'POST', token: authority.token, body: { projectId, title: 'operator control probe' } });
check('POST /retrospective is token-gated and records the token actor',
  retroNoToken.ok === false && retroNoToken.error?.code === 'actor_required'
  && retroWithToken.ok === true
  && service.listRetrospectives(projectId).retrospectives.slice(-1)[0]?.retrospective,
  JSON.stringify({ retroNoToken, retroWithToken }));

const updateNoToken = await request('/commands', { method: 'POST', body: { type: 'project.update', projectId, name: 'unauthenticated' } });
const updateWithToken = await request('/commands', { method: 'POST', token: authority.token, body: { type: 'project.update', projectId, name: 'token-authorized' } });
check('POST /commands project.update is token-gated and writes after the token',
  updateNoToken.ok === false && updateNoToken.error?.code === 'actor_required'
  && updateWithToken.ok === true && updateWithToken.data?.project?.name === 'token-authorized',
  JSON.stringify({ updateNoToken, updateWithToken }));

const deleteNoToken = await request('/commands', {
  method: 'POST', body: { type: 'project.delete', projectId, removeWorktrees: false },
});
const deleteWithToken = await request('/commands', {
  method: 'POST', token: authority.token,
  body: { type: 'project.delete', projectId, removeWorktrees: false, actor: { kind: 'human', id: 'body-attacker' } },
});
check('POST /commands project.delete is token-gated and still goes through the claim gate',
  deleteNoToken.ok === false && deleteNoToken.error?.code === 'actor_required'
  && deleteWithToken.ok === false && deleteWithToken.error?.code === 'human_confirmation_required'
  && Boolean(store.getProject(projectId)),
  JSON.stringify({ deleteNoToken, deleteWithToken }));

const appealNoToken = await request('/preemption/appeal', {
  method: 'POST', body: { projectId, nodeId: 'root', reason: 'no token', actor: { kind: 'human', id: 'body-attacker' } },
});
const appealWithToken = await request('/preemption/appeal', {
  method: 'POST', token: authority.token,
  body: { projectId, nodeId: 'root', reason: 'token path', actor: { kind: 'human', id: 'body-attacker' }, actorKey: 'ak_host_FORGED' },
});
check('POST /preemption/appeal ignores the body actor and forwards the token actor',
  appealNoToken.ok === false && appealNoToken.error?.code === 'actor_required'
  && appealWithToken.ok === true && runtimeAppeals.length === 1
  && runtimeAppeals[0].options.actor?.id === 'operator'
  && runtimeAppeals[0].options.actor?.id !== 'body-attacker',
  JSON.stringify({ appealNoToken, appealWithToken, runtimeAppeals }));

await store.close();
if (failed > 0) {
  console.error(`operator-control-selftest: ${failed} check(s) failed`);
  process.exit(1);
}
console.log('operator-control-selftest: all checks passed');
