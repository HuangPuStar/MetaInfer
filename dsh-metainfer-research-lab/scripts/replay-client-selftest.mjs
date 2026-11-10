/**
 * Replay pagination regression (S11). Executes the *client* helper against real
 * HTTP replay pages: a single-page fetch used to drop every node after the first
 * 2,000, so the test fails unless the follow loop consumes `nextNodeCursor`.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../host/store.js';
import { createKernel } from '../host/kernel/instance.js';
import { createLabService } from '../host/lab-service.js';
import { registerHttpRoutes } from '../host/http.js';
import { memoryDomain, storeContext } from './lib/memory-domain.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREFIX = '/api/metainfer-research-lab';
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`ok   ${name}`);
  else { failed += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const store = await openStore(storeContext(memoryDomain()));
const kernel = createKernel({ store });
const projectId = 'replay-e2e';
await store.saveProject({
  id: projectId, revision: 0, counters: { eventSeq: 0 },
  config: { maxRunningNodes: 1, resourcePools: {}, maxNodes: 20000 }, createdAt: 0, updatedAt: 0,
});
kernel.load(projectId);
const totalNodes = 3001;
for (let index = 0; index < totalNodes; index += 1) {
  await store.saveNode(projectId, {
    id: `n-${String(index).padStart(4, '0')}`,
    title: `node ${index}`,
    status: 'planned',
    parentIds: index > 0 ? [`n-${String(index - 1).padStart(4, '0')}`] : [],
    timestamps: { createdAt: index + 1 },
  });
}
const totalEvents = 2500;
for (let index = 0; index < totalEvents; index += 1) {
  const project = store.getProject(projectId);
  await store.appendEvent(project, 'node/created', { nodeId: `n-${String(index).padStart(4, '0')}`, data: { index } });
}
await store.saveProject(store.getProject(projectId));

const service = createLabService({
  ctx: { effect: () => {}, get: () => null, logger: { info() {}, warn() {} } },
  store, kernel, git: null, runtime: null, transcript: null, orchestrator: null, auto: null, cluster: null, clusterAdmin: null,
});
const routes = new Map();
registerHttpRoutes({
  effect: () => {},
  connection: { fetch: { register({ path: routePath, fetch }) { routes.set(routePath, fetch); return () => {}; } } },
}, service);
const request = async (url) => {
  const handler = routes.get(`${PREFIX}/replay`);
  const response = await handler(new Request(`http://local${url}`));
  const body = await response.json();
  if (body.ok !== true) throw new Error(JSON.stringify(body));
  return body.data;
};

// Extract and execute the client helper instead of re-implementing it.
const source = await readFile(path.join(root, 'client.js'), 'utf8');
const start = source.indexOf('async function fetchReplayAll');
const end = source.indexOf('/** Typed Host calls;', start);
if (start < 0 || end < 0) throw new Error('fetchReplayAll not found in client.js');
const helper = source.slice(start, end);
const makeHelper = new Function('requestJson', 'ROUTES', `${helper}\nreturn fetchReplayAll;`);
const fetchReplayAll = makeHelper(request, { replay: `${PREFIX}/replay` });

const all = await fetchReplayAll(projectId, undefined, (key) => key, { nodeLimit: 1000, limit: 1000 });
check('client replay follows every node page', all.nodes.length === totalNodes, `nodes=${all.nodes.length}/${totalNodes}`);
check('client replay keeps every event page', all.events.length === totalEvents, `events=${all.events.length}/${totalEvents}`);
check('client replay has no duplicate nodes', new Set(all.nodes.map((node) => node.id)).size === totalNodes);
check('client replay has no duplicate edges', new Set(all.edges.map((edge) => `${edge.from}>${edge.to}`)).size === all.edges.length);
check('client replay reports completion', all.nextNodeCursor === null && all._truncated === null, JSON.stringify(all._truncated));
check('client replay spans the full timeline', all.startAt > 0 && all.endAt >= all.startAt);

// A one-page regression would return 1,000 nodes; prove the helper really makes
// multiple requests by counting them.
let calls = 0;
const counting = async (url) => { calls += 1; return request(url); };
const limited = await makeHelper(counting, { replay: `${PREFIX}/replay` })(projectId, undefined, (key) => key, { nodeLimit: 1000, limit: 1000 });
check('client replay requests multiple pages', calls >= 4, `calls=${calls}`);
check('multi-page helper still returns all nodes', limited.nodes.length === totalNodes, `nodes=${limited.nodes.length}`);

console.log(failed === 0 ? '\nreplay-client-selftest: all checks passed' : `\nreplay-client-selftest: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
