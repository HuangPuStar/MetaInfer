#!/usr/bin/env node
/**
 * Host end-to-end probe for the profiling trace viewer (issue #94).
 *
 * Drives the real HTTP routes and the real LabService: open an inline trace,
 * page kernels, read one kernel + its prompt, materialise a root DAG node from
 * it, then close the trace. No mock envelope — only the carrier registry that
 * connects a Request to route.fetch().
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../host/store.js';
import { createKernel } from '../host/kernel/instance.js';
import { createLabService } from '../host/lab-service.js';
import { registerHttpRoutes } from '../host/http.js';
import { createOperatorAuthority } from '../host/operator-token.js';
import { createProfilerStore } from '../host/profiler/store.js';
import { memoryDomain, storeContext } from './lib/memory-domain.mjs';

let failed = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`ok   ${name}`);
  else { failed += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const TRACE = {
  displayTimeUnit: 'ms',
  traceEvents: [
    { ph: 'M', name: 'thread_name', pid: 0, tid: 7, args: { name: 'stream 7' } },
    { ph: 'X', cat: 'cpu_op', name: 'aten::mm', pid: 1, tid: 1, ts: 100, dur: 300, args: { 'External id': 10, 'Input Dims': [[32, 64], [64, 128]], 'Input type': ['Float', 'Float'], source: 'model.py:42' } },
    { ph: 'X', cat: 'kernel', name: 'ampere_sgemm_128x64_nn', pid: 0, tid: 7, ts: 1000, dur: 400, args: { correlation: 10, device: 0, stream: 7, grid: [128, 1, 1], block: [128, 1, 1] } },
    { ph: 'X', cat: 'kernel', name: 'void at::native::vectorized_elementwise_kernel<4, float>(int, float*, float*)', pid: 0, tid: 7, ts: 1500, dur: 100, args: { device: 0, stream: 7 } },
  ],
};

const root = await mkdtemp(path.join(os.tmpdir(), 'mirl-profiler-'));
const domain = memoryDomain();
const store = await openStore(storeContext(domain));
const kernel = createKernel({ store });
const projectId = 'profiler-p';
await store.saveProject({
  id: projectId,
  name: 'profiler project',
  revision: 0,
  counters: { eventSeq: 0, nextNodeSeq: 2, nodes: 1 },
  config: { maxNodes: 60, nodeTimeoutMinutes: 10, maxNodeTimeoutMinutes: 120 },
  repo: { path: root, baseBranch: 'main', baseCommit: 'deadbeef', worktreeRoot: path.join(root, 'wt') },
  createdAt: 0,
  updatedAt: 0,
});
kernel.load(projectId);
await kernel.executor.commit(projectId, {
  actor: { kind: 'human', id: 'setup' },
  mutations: [{ op: 'node.create', node: { id: 'n-0001', projectId, title: 'seed', status: 'completed', timestamps: { createdAt: 1, completedAt: 2 } } }],
});

const authority = createOperatorAuthority();
const service = createLabService({
  ctx: { effect: () => {}, get: () => null, logger: { info() {}, warn() {} } },
  store,
  kernel,
  git: null,
  runtime: null,
  transcript: null,
  orchestrator: null,
  auto: { statusOf: () => ({ status: 'off', pauseReason: null }) },
  cluster: null,
  clusterAdmin: null,
  operatorAuthority: authority,
});
const profiler = createProfilerStore();
const routes = [];
registerHttpRoutes({
  effect: () => {},
  connection: { fetch: { register(route) { routes.push(route); return () => {}; } } },
}, service, { profiler });

async function call(method, pathname, { body, token = authority.token, search = '' } = {}) {
  const route = routes.find((candidate) => candidate.path === pathname && candidate.methods.includes(method));
  assert.ok(route, `route ${method} ${pathname} is registered`);
  const headers = { accept: 'application/json' };
  if (token !== null) headers['x-metainfer-operator'] = token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await route.fetch(new Request('http://local' + pathname + search, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return response.json();
}

const tracePath = '/api/metainfer-research-lab/trace';
const commandPath = '/api/metainfer-research-lab/commands';
const envelope = (payload) => (payload.ok === true ? payload.data : null);

// 1. Open from inline content (the browser file-picker path).
const opened = await call('POST', commandPath, { body: { type: 'trace.open', content: JSON.stringify(TRACE), name: 'torch-demo.json' } });
const summary = envelope(opened);
check('trace.open returns a summary', summary !== null && summary.counts.kernels === 2, JSON.stringify(opened).slice(0, 400));
check('trace.open keeps the display name and lanes', summary?.name === 'torch-demo.json' && summary?.lanes?.length === 1);
const traceId = summary?.traceId;
check('trace.open mints a trace id', typeof traceId === 'string' && traceId.startsWith('tr_'), String(traceId));
check('trace.list is exposed when no id is given',
  Array.isArray(envelope(await call('GET', tracePath, { search: '' }))?.traces));

// 2. Kernel table, detail, prompt.
const kernels = envelope(await call('GET', tracePath, { search: `?traceId=${traceId}&view=kernels&sort=sum` }));
check('trace kernels page returns both kernels', kernels?.rows?.length === 2, JSON.stringify(kernels).slice(0, 300));
check('trace kernels are ranked by total time', kernels?.rows?.[0]?.name === 'ampere_sgemm_128x64_nn');
const detail = envelope(await call('GET', tracePath, { search: `?traceId=${traceId}&view=kernel&kernel=0` }));
check('kernel detail embeds the correlation launch op', detail?.detail?.launchOp?.name === 'aten::mm');
check('kernel detail carries the nine actions', Array.isArray(detail?.actions) && detail.actions.length === 9);
const prompt = envelope(await call('GET', tracePath, { search: `?traceId=${traceId}&view=prompt&action=fusion&kernel=0` }));
check('a fusion prompt is built on demand', typeof prompt?.prompt === 'string' && prompt.prompt.includes('fusion'));
const timeline = envelope(await call('GET', tracePath, { search: `?traceId=${traceId}&view=timeline` }));
check('timeline returns spans and lanes', timeline?.spans?.length === 2 && timeline?.lanes?.length === 1);

// 3. Materialise a root node from the span.
const task = await call('POST', commandPath, {
  body: { type: 'trace.task', projectId, traceId, kernelIndex: 0, action: 'fusion', timeboxMinutes: 45 },
});
const created = envelope(task);
const node = created?.node;
check('trace.task creates a root node', node?.parentId === null && node?.status === 'planned', JSON.stringify(task).slice(0, 400));
check('trace.task records the profiling source', node?.source?.kind === 'profiling-trace' && node?.source?.traceId === traceId);
check('trace.task titles the node after the kernel family', typeof node?.title === 'string' && node.title.includes('fusion'), node?.title);
check('trace.task sets the requested timebox', node?.timeboxMs === 45 * 60_000, String(node?.timeboxMs));
check('trace.task stores a prompt under the chat limit', typeof node?.prompt === 'string' && node.prompt.length > 10 && node.prompt.length <= 8000);
const state = envelope(await call('GET', '/api/metainfer-research-lab/state', { search: `?projectId=${projectId}` }));
check('the new node appears in the project state', Array.isArray(state?.nodes) && state.nodes.some((row) => row?.id === node.id));

// 4. Rejections are named, not 500s.
const badAction = await call('POST', commandPath, { body: { type: 'trace.task', projectId, traceId, kernelIndex: 0, action: 'bound' } });
check('trace.task rejects a chat action', badAction.ok === false && badAction.error?.code === 'bad_request', JSON.stringify(badAction).slice(0, 200));
const badIndex = await call('GET', tracePath, { search: `?traceId=${traceId}&view=kernel&kernel=9999` });
check('an unknown kernel index is a named error', badIndex.ok === false && badIndex.error?.code === 'kernel_not_found');
const badTrace = await call('GET', tracePath, { search: '?traceId=tr_missing&view=summary' });
check('an unknown trace id is a named error', badTrace.ok === false && badTrace.error?.code === 'trace_not_found');
const badJson = await call('POST', commandPath, { body: { type: 'trace.open', content: '{"traceEvents": "nope"}' } });
check('a malformed trace document is rejected', badJson.ok === false && badJson.error?.code === 'trace_invalid_json', JSON.stringify(badJson).slice(0, 200));
const noWrite = await call('GET', tracePath, { search: `?traceId=${traceId}&view=prompt&action=bound`, token: null });
check('the read route is not token-gated', noWrite.ok === true || noWrite.error?.code !== 'actor_required');
const missingToken = await call('POST', commandPath, { body: { type: 'trace.open', content: JSON.stringify(TRACE) }, token: null });
check('trace.open requires the operator token', missingToken.ok === false && missingToken.error?.code === 'actor_required');

// 5. Close evicts the trace.
const closed = envelope(await call('POST', commandPath, { body: { type: 'trace.close', traceId } }));
check('trace.close reports the eviction', closed?.closed === true);
const afterClose = await call('GET', tracePath, { search: `?traceId=${traceId}&view=summary` });
check('a closed trace is no longer queryable', afterClose.ok === false && afterClose.error?.code === 'trace_not_found');

await rm(root, { recursive: true, force: true });
if (failed > 0) {
  console.error(`profiler-host-selftest: ${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nprofiler-host-selftest: all checks passed');
