/**
 * Tool-surface acceptance test (B15/S11): an action advertised in the schema
 * enum must have a callable handler and a policy entry. This drives every
 * action that used to fall through to `unknown_command` through the real
 * service, and asserts the removed, unimplemented names are gone.
 */
import assert from 'node:assert/strict';
import { openStore } from '../host/store.js';
import { createKernel } from '../host/kernel/instance.js';
import { createLabService } from '../host/lab-service.js';
import { createReviewClaimBoard } from '../host/dispatch/review-claims.js';
import { registerAgentTool } from '../host/agent-tool.js';
import { createDiffCache } from '../host/context/dag.js';
import { memoryDomain, storeContext } from './lib/memory-domain.mjs';

let failed = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`ok   ${name}`);
  else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const fakeCtx = { effect: () => {}, get: () => null, logger: { info() {}, warn() {} } };
const store = await openStore(storeContext(memoryDomain()));
const kernel = createKernel({ store });
const orchestrator = { reviewClaims: createReviewClaimBoard({ clock: () => 1_000 }) };
const service = createLabService({
  ctx: fakeCtx, store, kernel, git: null, runtime: null, transcript: null, orchestrator, auto: null, cluster: null, clusterAdmin: null,
});
await store.saveProject({
  id: 'p',
  revision: 0,
  counters: { eventSeq: 0 },
  config: { maxRunningNodes: 4, resourcePools: { gpu: 4 }, maxNodes: 100 },
  updatedAt: 0,
  createdAt: 0,
});
kernel.load('p');
await kernel.executor.commit('p', {
  actor: { kind: 'human', id: 'test' },
  mutations: [
    { op: 'node.create', node: { id: 'n1', title: 'root', status: 'planned', timestamps: { createdAt: 1 } } },
    { op: 'node.create', node: { id: 'n2', title: 'child', parentId: 'n1', parentIds: ['n1'], status: 'completed', timestamps: { createdAt: 2 } } },
  ],
});
const exec = { agent: { session: { id: 'expert-1', header: { meta: { agentPreset: 'lab-advisor' } } } } };
const toolCtx = { tools: { register(definition) { toolCtx.tool = definition; return () => {}; } } };
registerAgentTool(toolCtx, service);

async function call(action, input = {}) {
  return service.agentTool({ action, projectId: 'p', ...input }, exec);
}

const map = await call('dag_map', { by: 'status' });
check('dag_map returns grouped counts', map.ok === true && Array.isArray(map.groups) && map.total === 2, JSON.stringify(map));
const walk = await call('dag_walk', { from: 'n1', depth: 2 });
check('dag_walk returns reachable nodes', walk.ok === true && walk.nodes.some((node) => node.id === 'n2'), JSON.stringify(walk));
const diff = await call('dag_diff');
check('dag_diff returns a snapshot diff', diff.ok === true && Array.isArray(diff.added) && diff.added.length === 2, JSON.stringify(diff));
check('dag_map carries revision', Number.isFinite(map.revision), JSON.stringify(map.revision));
check('dag_walk carries revision', Number.isFinite(walk.revision), JSON.stringify(walk.revision));
check('dag_diff carries revision', Number.isFinite(diff.revision), JSON.stringify(diff.revision));
const query = await call('dag_query', { limit: 1 });
check('dag_query carries revision', Number.isFinite(query.revision), JSON.stringify(query.revision));
const get = await call('dag_get', { nodeIds: ['n1'] });
check('dag_get carries revision', Number.isFinite(get.revision), JSON.stringify(get.revision));
const resource = await call('resource_status', { nodeId: 'n1' });
check('resource_status is advertised and callable', resource.ok === true && resource.node?.nodeId === 'n1', JSON.stringify(resource));
check('resource_status reports the project pools', resource.resources?.pools?.gpu === 4 && resource.resources?.free?.gpu === 4, JSON.stringify(resource.resources));
check('resource_status reports the queue position', resource.queue?.position === 1 && resource.queue?.runnable >= 1, JSON.stringify(resource.queue));
const resourceAggregate = await call('resource_status');
check('resource_status works without a nodeId', resourceAggregate.ok === true && resourceAggregate.node === null && resourceAggregate.resources?.pools?.gpu === 4, JSON.stringify(resourceAggregate));

// `sinceRevision` must be honoured, not just echoed: add one node after the
// first snapshot and diff from that exact revision.
const since = diff.revision;
await kernel.executor.commit('p', {
  actor: { kind: 'human', id: 'test' },
  mutations: [{ op: 'node.create', node: { id: 'n3', title: 'after diff', status: 'planned', timestamps: { createdAt: 3 } } }],
});
const sinceDiff = await call('dag_diff', { sinceRevision: since });
check('dag_diff honours sinceRevision', sinceDiff.ok === true && sinceDiff.fromRevision === since && sinceDiff.added.length === 1 && sinceDiff.added[0] === 'n3', JSON.stringify(sinceDiff));
const unavailable = await call('dag_diff', { sinceRevision: 999 });
check('dag_diff refuses an unknown sinceRevision', unavailable.ok === false && unavailable.code === 'diff_unavailable', JSON.stringify(unavailable));
// A cursor between two snapshots must not fall back to the older one: the
// caller would get a delta labelled with a revision it did not ask for.
const cache = createDiffCache({ maxCachedNodes: 100 });
cache.diff('x', [{ id: 'a', status: 'planned', rev: 1 }], 1);
cache.diff('x', [{ id: 'a', status: 'planned', rev: 1 }, { id: 'b', status: 'planned', rev: 2 }], 2);
const gap = cache.diff('x', [{ id: 'a', status: 'planned', rev: 1 }, { id: 'b', status: 'planned', rev: 2 }], 3, 3);
check('dag_diff rejects a cursor with no exact snapshot', gap.ok === false && gap.code === 'diff_unavailable', JSON.stringify(gap));
cache.reset('x');
const afterReset = cache.diff('x', [{ id: 'a', status: 'planned', rev: 1 }], 4, 2);
check('diff cache reset drops history', afterReset.ok === false && afterReset.code === 'diff_unavailable', JSON.stringify(afterReset));

// Byte budgets: 5,000 distinct owners used to produce 372,846 B for dag_map.
await store.saveProject({ id: 'big', revision: 0, counters: { eventSeq: 0 }, config: { maxRunningNodes: 2, resourcePools: {}, maxNodes: 20000 }, updatedAt: 0, createdAt: 0 });
kernel.load('big');
const LONG = 'x'.repeat(300);
for (let index = 0; index < 5000; index += 1) {
  await store.saveNode('big', {
    id: index === 0 ? 'root' : `n-${index}`,
    title: LONG,
    status: 'planned',
    createdBy: 'o'.repeat(1 + ((index * 7 + 19 * 13) % 120)) + index,
    ...(index === 0 ? {} : { parentId: 'root', parentIds: ['root'] }),
    timestamps: { createdAt: index },
  });
}
const bigMap = JSON.parse((await toolCtx.tool.execute({ action: 'dag_map', projectId: 'big', by: 'owner' }, exec)).result);
const bigMapBytes = Buffer.byteLength(JSON.stringify(bigMap), 'utf8');
check('dag_map stays under its 6 KB budget', bigMapBytes <= 6 * 1024, `${bigMapBytes} B`);
check('dag_map reports final serialized bytes', bigMap._truncated?.bytes?.used === bigMapBytes, `${bigMap._truncated?.bytes?.used} vs ${bigMapBytes}`);
check('dag_map reports group truncation', bigMap._truncated?.groups?.total === 5000 && bigMap._truncated.groups.shown < 5000, JSON.stringify(bigMap._truncated));
const bigWalk = JSON.parse((await toolCtx.tool.execute({ action: 'dag_walk', projectId: 'big', from: 'root', depth: 2 }, exec)).result);
const bigWalkBytes = Buffer.byteLength(JSON.stringify(bigWalk), 'utf8');
check('dag_walk stays under its 24 KB budget', bigWalkBytes <= 24 * 1024, `${bigWalkBytes} B`);
check('dag_walk reports final serialized bytes', bigWalk.truncated?.bytes?.used === bigWalkBytes, `${bigWalk.truncated?.bytes?.used} vs ${bigWalkBytes}`);
check('dag_walk reports byte truncation', bigWalk.truncated?.reason === 'bytes' && bigWalk.truncated.shown < 201, JSON.stringify(bigWalk.truncated));
check('dag_walk total is the real subtree size', bigWalk.truncated?.total === 4999 && bigWalk.truncated?.discovered === 5000, JSON.stringify(bigWalk.truncated));
const nodesPage = await call('nodes_page', { limit: 1 });
check('nodes_page returns a cursor page', nodesPage.ok === true && nodesPage.nodes.length === 1 && nodesPage.total === 3, JSON.stringify(nodesPage));
const secondPage = await call('nodes_page', { limit: 1, cursor: nodesPage.nextCursor });
check('nodes_page accepts its own cursor', secondPage.ok === true && secondPage.nodes.length === 1 && secondPage.nodes[0].id !== nodesPage.nodes[0].id, JSON.stringify(secondPage));
const eventsPage = await call('events_page', { limit: 1 });
check('events_page returns an event page', eventsPage.ok === true && eventsPage.events.length === 1 && typeof eventsPage.total === 'number', JSON.stringify(eventsPage));
const node = await call('get_node', { nodeId: 'n1' });
check('get_node is callable', node.ok !== false && node.node?.id === 'n1', JSON.stringify(node));
const dashboard = await call('dashboard_get');
check('dashboard_get is callable', dashboard !== null && typeof dashboard === 'object' && dashboard.ok !== false, JSON.stringify(dashboard).slice(0, 200));
const health = await call('health');
check('health is callable', health?.version !== undefined && health?.storage === 'ready', JSON.stringify(health));

const claim = await call('claim_review', { nodeId: 'n1', title: 'reviewing' });
check('claim_review takes the claim', claim.ok === true && claim.claim?.expertId === 'expert-1', JSON.stringify(claim));
const claims = await call('review_claims');
check('review_claims lists the claim', claims.ok === true && claims.claims.length === 1 && claims.claims[0].nodeId === 'n1', JSON.stringify(claims));
const release = await call('release_review', { nodeId: 'n1' });
check('release_review releases the claim', release.ok === true, JSON.stringify(release));
const released = await call('review_claims');
check('claim board is empty after release', released.ok === true && released.claims.length === 0, JSON.stringify(released));

// Removed actions must not linger in the enum, and the real tool wrapper must
// reject them with the exact documented code. `null` (silent acceptance) is a
// failure, not a pass — that was the weak assertion the verifier caught.
const { ACTION_CATALOG } = await import('../host/kernel/policy.js');
const removed = ['experts_list', 'expert_upsert', 'curator_scan'];
/** @returns {{ok: boolean, code: string|null}} */
async function removedVerdict(wrapper, action) {
  const parsed = JSON.parse((await wrapper.execute({ action, projectId: 'p' }, exec)).result);
  return { ok: parsed.ok, code: parsed.error?.code ?? null };
}
const rejectedUnknown = (verdict) => verdict.ok === false && verdict.code === 'unknown_action';
// Mutation check: the predicate must go red for silent acceptance (the old
// `thrown === null || ...` assertion passed exactly this shape).
check('rejection predicate catches silent acceptance', rejectedUnknown({ ok: true, code: null }) === false);
check('rejection predicate catches a different code', rejectedUnknown({ ok: false, code: 'internal_error' }) === false);
for (const action of removed) {
  check(`${action} is not advertised`, !Object.hasOwn(ACTION_CATALOG, action));
  const verdict = await removedVerdict(toolCtx.tool, action);
  check(`${action} is rejected with unknown_action`, rejectedUnknown(verdict), JSON.stringify(verdict));
}

console.log(`\n${failed === 0 ? 'tool-surface-selftest: all checks passed' : `tool-surface-selftest: ${failed} failed`}`);
process.exit(failed === 0 ? 0 : 1);
