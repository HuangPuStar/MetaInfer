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
import { injectPerfettoHook, registerPerfettoWeb } from '../host/profiler/perfetto-assets.js';
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
const perfettoRoot = await mkdtemp(path.join(os.tmpdir(), 'mirl-perfetto-'));
await (await import('node:fs/promises')).mkdir(path.join(perfettoRoot, 'v59.1'), { recursive: true });
await (await import('node:fs/promises')).writeFile(path.join(perfettoRoot, 'v59.1', 'index.html'), '<html><body>perfetto</body></html>');
await (await import('node:fs/promises')).writeFile(path.join(perfettoRoot, 'v59.1', 'app.js'), 'console.log(1);');
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

async function callRaw(method, pathname, { search = '', token = authority.token } = {}) {
  const route = routes.find((candidate) => candidate.path === pathname && candidate.methods.includes(method));
  assert.ok(route, `route ${method} ${pathname} is registered`);
  const headers = { accept: 'application/json' };
  if (token !== null) headers['x-metainfer-operator'] = token;
  const response = await route.fetch(new Request('http://local' + pathname + search, { method, headers }));
  return response;
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

// 2b. Raw bytes for the embedded Perfetto UI.
const bytesResponse = await callRaw('GET', tracePath, { search: `?traceId=${traceId}&view=bytes` });
const raw = await bytesResponse.text();
check('trace bytes view returns the original document', raw.includes('ampere_sgemm_128x64_nn') && JSON.parse(raw).traceEvents.length === TRACE.traceEvents.length);
check('trace bytes view is served as JSON with no-store', bytesResponse.headers.get('content-type')?.includes('application/json') === true && bytesResponse.headers.get('cache-control') === 'no-store');

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

// 6. Self-hosted Perfetto static route: injection, MIME, traversal refusal.
const perfettoRoutes = [];
registerPerfettoWeb({ register(route) { perfettoRoutes.push(route); return () => {}; } }, { uiRoot: perfettoRoot });
check('the perfetto route is a prefix route below /metainfer/perfetto',
  perfettoRoutes.length === 1 && perfettoRoutes[0].kind === 'prefix' && perfettoRoutes[0].path === '/metainfer/perfetto');
function fakeRes() {
  const chunks = [];
  return {
    statusCode: 0,
    headers: {},
    writeHead(code, headers) { this.statusCode = code; this.headers = headers ?? {}; },
    end(body) { if (body !== undefined) chunks.push(String(body)); this.body = chunks.join(''); },
    write(chunk) { chunks.push(String(chunk)); },
    on() {},
    once() {},
    emit() {},
    body: '',
  };
}
async function perfettoCall(url) {
  const res = fakeRes();
  const req = { url, method: 'GET' };
  perfettoRoutes[0].handler(req, res);
  await new Promise((resolve) => setTimeout(resolve, 120));
  return res;
}
const indexRes = await perfettoCall('/metainfer/perfetto/');
check('the perfetto index is served with the hook injected',
  indexRes.statusCode === 200 && indexRes.body.includes('/metainfer/perfetto/hook.js') && indexRes.body.includes('perfetto'));
check('the perfetto index is HTML', String(indexRes.headers['content-type']).includes('text/html'));
const hookRes = await perfettoCall('/metainfer/perfetto/hook.js');
check('the hook script is served', hookRes.statusCode === 200 && hookRes.body.includes('__METAINFER_PERFETTO_HOOK__'));
const assetRes = await perfettoCall('/metainfer/perfetto/app.js');
check('an asset keeps its JavaScript MIME', assetRes.statusCode === 200 && String(assetRes.headers['content-type']).includes('javascript'), JSON.stringify({ status: assetRes.statusCode, headers: assetRes.headers }));
const missingRes = await perfettoCall('/metainfer/perfetto/nope.js');
check('a missing asset answers 404', missingRes.statusCode === 404);
const traversalRes = await perfettoCall('/metainfer/perfetto/../../etc/passwd');
check('a traversal attempt is refused', traversalRes.statusCode === 400 || traversalRes.statusCode === 404);


// 5. DAG → trace hop: enumerate the node worktree, open by relative path, compare.
const { mkdir: mkdirP, writeFile: writeF } = await import('node:fs/promises');
const nodeRow = envelope(await call('GET', '/api/metainfer-research-lab/state', { search: `?projectId=${projectId}` }))
  ?.nodes?.find((row) => row?.id === node.id);
const worktree = nodeRow?.git?.worktreePath;
check('the created node records a worktree', typeof worktree === 'string' && worktree !== '', String(worktree));
const traceV2 = JSON.parse(JSON.stringify(TRACE));
traceV2.traceEvents[2].dur = 800; // same kernel, twice as slow => +100%
traceV2.traceEvents[3].dur = 300;
await mkdirP(path.join(worktree, 'results', 'nested'), { recursive: true });
await writeF(path.join(worktree, 'results', 'torch-v1.json'), JSON.stringify(TRACE));
await writeF(path.join(worktree, 'results', 'nested', 'torch-v2.json'), JSON.stringify(traceV2));
await writeF(path.join(worktree, 'results', 'notes.json'), JSON.stringify({ hello: 'not a trace' }));
const { gzipSync } = await import('node:zlib');
// A real gzip stream wrapping a POSIX tar header, so the failure is the tar
// check rather than a broken gzip.
const tarHeader = Buffer.alloc(1024);
tarHeader.write('ustar', 257, 'latin1');
await writeF(path.join(worktree, 'results', 'trace.tar.gz'), gzipSync(tarHeader));
await mkdirP(path.join(worktree, 'node_modules', 'pkg'), { recursive: true });
await writeF(path.join(worktree, 'node_modules', 'pkg', 'decoy.json'), JSON.stringify(TRACE));

const candidates = envelope(await call('GET', tracePath, { search: `?view=candidates&projectId=${projectId}&nodeId=${node.id}` }));
check('candidates lists every trace-looking file by extension',
  candidates?.candidates?.length === 4, JSON.stringify(candidates?.candidates?.map((row) => row.relPath)));
check('candidates keep the tar.gz bundle', candidates?.candidates?.some((row) => row.relPath.endsWith('trace.tar.gz') && row.needsExtraction === true));
check('candidates still skip node_modules',
  candidates?.candidates?.every((row) => !row.relPath.includes('node_modules')));
check('a plain json artifact is listed without being parsed',
  candidates?.candidates?.some((row) => row.relPath.endsWith('notes.json')));
check('candidates carry a relative path and size',
  typeof candidates?.candidates?.[0]?.relPath === 'string' && candidates.candidates[0].size > 0);

const openedV1 = envelope(await call('POST', commandPath, {
  body: { type: 'trace.open', projectId, nodeId: node.id, relPath: 'results/torch-v1.json' },
}));
check('trace.open accepts a node-relative path', openedV1?.traceId?.startsWith('tr_') === true, JSON.stringify(openedV1).slice(0, 200));
const openedV2 = envelope(await call('POST', commandPath, {
  body: { type: 'trace.open', projectId, nodeId: node.id, relPath: 'results/nested/torch-v2.json' },
}));
check('two traces from one node can be open at once', openedV1?.traceId !== openedV2?.traceId);
const listed = envelope(await call('GET', tracePath, { search: '' }));
const listedRow = listed?.traces?.find((row) => row.traceId === openedV1?.traceId);
check('an opened node trace keeps its provenance', listedRow?.nodeId === node.id && listedRow?.relPath === 'results/torch-v1.json');
const tarball = await call('POST', commandPath, {
  body: { type: 'trace.open', projectId, nodeId: node.id, relPath: 'results/trace.tar.gz' },
});
check('opening a tar.gz fails with a named code', tarball.ok === false && tarball.error?.code === 'trace_is_tarball', JSON.stringify(tarball).slice(0, 200));
const escaped = await call('POST', commandPath, {
  body: { type: 'trace.open', projectId, nodeId: node.id, relPath: '../../../etc/passwd' },
});
check('a traversal relPath is refused', escaped.ok === false && escaped.error?.code === 'bad_request', JSON.stringify(escaped).slice(0, 200));

const compare = envelope(await call('GET', tracePath, {
  search: `?view=compare&traceIds=${openedV1.traceId},${openedV2.traceId}`,
}));
check('compare returns both columns', compare?.columns?.length === 2 && compare?.totals?.length === 2, JSON.stringify(compare).slice(0, 300));
const faster = compare?.totals?.[0]?.totalKernelUs ?? 0;
const slower = compare?.totals?.[1]?.totalKernelUs ?? 0;
check('compare totals describe the doubled trace', slower > faster, JSON.stringify(compare?.totals));
check('compare reports the total delta as a percentage', typeof compare?.totals?.[1]?.deltaPct === 'number' && compare.totals[1].deltaPct > 0);
const sgemm = compare?.rows?.find((row) => row.name === 'ampere_sgemm_128x64_nn');
check('compare aligns rows by kernel name', Boolean(sgemm) && sgemm.perTrace.length === 2, JSON.stringify(compare?.rows?.slice(0, 2)));
check('compare marks the fastest column per row', sgemm?.fastest === 0 && sgemm?.deltaPct?.[1] === 100, JSON.stringify(sgemm?.deltaPct));
const oneTrace = await call('GET', tracePath, { search: `?view=compare&traceIds=${openedV1.traceId}` });
check('compare needs at least two traces', oneTrace.ok === false && oneTrace.error?.code === 'bad_request');

await rm(root, { recursive: true, force: true });
await rm(perfettoRoot, { recursive: true, force: true });
if (failed > 0) {
  console.error(`profiler-host-selftest: ${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nprofiler-host-selftest: all checks passed');
