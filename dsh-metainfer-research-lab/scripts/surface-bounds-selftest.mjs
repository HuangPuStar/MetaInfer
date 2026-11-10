/**
 * Bounded-surface acceptance test (S11): every list an external caller can
 * request (state, transcript, replay, MCP node list) must have a hard page
 * bound and explicit truncation metadata. Drives the real HTTP routes,
 * transcript reader, tool wrapper and service — not source greps.
 */
import { openStore } from '../host/store.js';
import { createKernel } from '../host/kernel/instance.js';
import { createLabService } from '../host/lab-service.js';
import { createTranscriptReader } from '../host/transcript.js';
import { registerHttpRoutes } from '../host/http.js';
import { registerAgentTool } from '../host/agent-tool.js';
import { createServer as createMcpServer } from '../host/mcp.js';
import { memoryDomain, storeContext } from './lib/memory-domain.mjs';

const PREFIX = '/api/metainfer-research-lab';
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`ok   ${name}`);
  else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const store = await openStore(storeContext(memoryDomain()));
const kernel = createKernel({ store });
const projectId = 'bounds';
await store.saveProject({
  id: projectId,
  revision: 0,
  counters: { eventSeq: 0 },
  config: { maxRunningNodes: 2, resourcePools: {}, maxNodes: 20000 },
  updatedAt: 0,
  createdAt: 0,
});
kernel.load(projectId);
for (let index = 0; index < 2500; index += 1) {
  await store.saveNode(projectId, {
    id: `n-${index}`,
    title: `node ${index}`,
    status: 'planned',
    parentIds: index > 0 ? [`n-${index - 1}`] : [],
    timestamps: { createdAt: index },
  });
}
// Enough durable events to prove replay is capped independently of nodes.
for (let index = 0; index < 1200; index += 1) {
  const project = store.getProject(projectId);
  await store.appendEvent(project, 'node/created', { nodeId: `n-${index % 2500}`, data: { index } });
}
for (let index = 0; index < 3; index += 1) {
  await store.saveRun(projectId, { id: `run-${index}`, projectId, role: 'advisor', status: 'completed', startedAt: index, endedAt: index + 1 });
}

const transcriptEvents = Array.from({ length: 500 }, (_, index) => ({
  seq: index + 1,
  time: 1000 + index,
  type: 'user/message',
  data: { content: [{ type: 'text', text: `message ${index} ${'x'.repeat(80)}` }] },
}));
const fakeCtx = {
  effect: () => {},
  get: () => null,
  logger: { info() {}, warn() {} },
  sessionQuery: { readSurface: async () => ({ events: transcriptEvents, capturedThroughSeq: 500 }) },
};
const transcript = createTranscriptReader({ ctx: fakeCtx, store });
await store.saveNode(projectId, {
  id: 't-node',
  title: 'transcript node',
  status: 'completed',
  sessionId: 's-transcript',
  timestamps: { createdAt: 2500 },
});
const service = createLabService({
  ctx: fakeCtx, store, kernel, git: null, runtime: null, transcript, orchestrator: null, auto: null, cluster: null, clusterAdmin: null,
});

// --- HTTP /state: default page is 1,000 nodes, cursor walks the rest ---------
const routes = new Map();
const httpCtx = {
  effect: () => {},
  connection: {
    fetch: {
      register({ path, fetch }) { routes.set(path, fetch); return () => {}; },
    },
  },
};
registerHttpRoutes(httpCtx, service);
async function get(path, query = '') {
  const handler = routes.get(`${PREFIX}/${path}`);
  if (!handler) throw new Error(`route not registered: ${path}`);
  const response = await handler(new Request(`http://local${PREFIX}/${path}?${query}`));
  const envelope = await response.json();
  if (envelope.ok !== true) throw new Error(`${path}: ${JSON.stringify(envelope.error)}`);
  return envelope.data;
}

const first = await get('state', `projectId=${projectId}`);
check('state first page is bounded to 1,000 nodes', first.nodes.length === 1000 && first._truncated?.nodes?.total === 2501, JSON.stringify(first._truncated));
const firstBytes = Buffer.byteLength(JSON.stringify(first), 'utf8');
check('state first page is under 2 MB', firstBytes < 2 * 1024 * 1024, `${firstBytes} B`);
const secondState = await get('state', `projectId=${projectId}&cursor=${encodeURIComponent(first.nextCursor)}`);
check('state cursor returns the next page', secondState.nodes.length === 1000 && secondState.nodes[0].id !== first.nodes[0].id, `${secondState.nodes.length}`);
const thirdState = await get('state', `projectId=${projectId}&cursor=${encodeURIComponent(secondState.nextCursor)}`);
check('state last page reports no cursor', thirdState.nodes.length === 501 && thirdState.nextCursor === null, `${thirdState.nodes.length}/${thirdState.nextCursor}`);

// --- HTTP /transcript: rows are capped, cursor advances ----------------------
const transcriptPage = await get('transcript', `projectId=${projectId}&nodeId=t-node&limit=50`);
check('transcript page is bounded', transcriptPage.rows.length <= 50 && transcriptPage._truncated?.rows?.max === 50, JSON.stringify(transcriptPage._truncated));
check('transcript page reports hasMore', transcriptPage.hasMore === true && transcriptPage.nextSeq > 0, `${transcriptPage.hasMore}/${transcriptPage.nextSeq}`);
const transcriptNext = await get('transcript', `projectId=${projectId}&nodeId=t-node&limit=50&afterSeq=${transcriptPage.nextSeq}`);
check('transcript cursor advances without duplicates', transcriptNext.rows.length > 0 && transcriptNext.rows[0].seq > transcriptPage.rows[transcriptPage.rows.length - 1].seq, `${transcriptNext.rows[0]?.seq}`);

// --- HTTP /replay: nodes and events are capped ------------------------------
const replay = await get('replay', `projectId=${projectId}&limit=100&nodeLimit=500`);
check('replay bounds nodes', replay.nodes.length === 500 && replay._truncated?.nodes?.total === 2501, `${replay.nodes.length}`);
check('replay bounds events', replay.events.length === 100 && replay._truncated?.events?.total === 1200, `${replay.events.length}`);
check('replay carries a cursor', replay.nextSeq > 0 && replay.nextNodeCursor !== null, `${replay.nextSeq}/${replay.nextNodeCursor}`);
const replayBytes = Buffer.byteLength(JSON.stringify(replay), 'utf8');
check('replay response stays under 1 MB', replayBytes < 1024 * 1024, `${replayBytes} B`);

// --- HTTP /events default + /runs cursor -----------------------------------
const eventsDefault = await get('events', `projectId=${projectId}`);
check('events default page is bounded', eventsDefault.events.length === 1000 && eventsDefault.page?.hasMore === true, `${eventsDefault.events.length}`);
const eventsNext = await get('events', `projectId=${projectId}&after=${eventsDefault.page.nextSeq}`);
check('events cursor advances', eventsNext.events[0]?.seq > eventsDefault.events.at(-1)?.seq, `${eventsNext.events[0]?.seq}`);
const runsPage = await get('runs', `projectId=${projectId}&limit=1`);
check('runs page is bounded with a cursor', runsPage.runs.length === 1 && runsPage.total === 3 && runsPage.nextCursor !== null, JSON.stringify({ count: runsPage.runs.length, total: runsPage.total, cursor: runsPage.nextCursor }));
const runsNext = await get('runs', `projectId=${projectId}&limit=1&cursor=${encodeURIComponent(runsPage.nextCursor)}`);
check('runs cursor advances', runsNext.runs[0]?.id !== runsPage.runs[0]?.id, `${runsNext.runs[0]?.id}`);

// --- MCP tool handlers (registered through the real McpServer) --------------
const mcpServer = createMcpServer(service);
const mcpTools = mcpServer._registeredTools;
const callMcp = async (name, args) => {
  const result = await mcpTools[name].handler(args, {});
  return result?.structuredContent ?? JSON.parse(result?.content?.[0]?.text ?? '{}');
};
const mcpPage = await callMcp('metainfer_list_nodes', { projectId, status: 'planned', limit: 10 });
check('mcp list_nodes page is bounded', mcpPage.nodes.length === 10 && mcpPage.nextCursor !== null, `${mcpPage.nodes.length}`);
check('mcp list_nodes total reflects the status filter', mcpPage.total === 2500 && mcpPage._truncated?.nodes?.total === 2500, JSON.stringify({ total: mcpPage.total, trunc: mcpPage._truncated }));
const mcpNext = await callMcp('metainfer_list_nodes', { projectId, status: 'planned', limit: 10, cursor: mcpPage.nextCursor });
check('mcp list_nodes cursor works', mcpNext.nodes.length === 10 && mcpNext.nodes[0].id !== mcpPage.nodes[0].id, `${mcpNext.nodes[0]?.id}`);
const mcpNode = await callMcp('metainfer_get_node', { projectId, nodeId: 't-node' });
check('mcp get_node is a direct lookup', mcpNode.node?.id === 't-node' && mcpNode.isLeaf === true, `${mcpNode.node?.id}`);

// --- Agent tool wrapper uses the same limits -------------------------------
const toolCtx = { tools: { register(definition) { toolCtx.tool = definition; return () => {}; } } };
registerAgentTool(toolCtx, service);
const exec = { agent: { session: { id: 'expert-1', header: { meta: { agentPreset: 'lab-advisor' } } } } };
const toolTranscript = JSON.parse((await toolCtx.tool.execute({ action: 'transcript', projectId, nodeId: 't-node', limit: 20 }, exec)).result);
check('tool transcript honours limit', toolTranscript.rows.length <= 20 && toolTranscript.hasMore === true, `${toolTranscript.rows.length}`);
const toolReplay = JSON.parse((await toolCtx.tool.execute({ action: 'replay', projectId, limit: 10 }, exec)).result);
check('tool replay honours limit', toolReplay.events.length === 10 && toolReplay._truncated.events !== null, `${toolReplay.events.length}`);

if (failed > 0) {
  console.error(`surface-bounds-selftest: ${failed} failed`);
  process.exit(1);
}
console.log('surface-bounds-selftest: all checks passed');
