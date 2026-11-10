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

async function call(action, input = {}) {
  return service.agentTool({ action, projectId: 'p', ...input }, exec);
}

const map = await call('dag_map', { by: 'status' });
check('dag_map returns grouped counts', map.ok === true && Array.isArray(map.groups) && map.total === 2, JSON.stringify(map));
const walk = await call('dag_walk', { from: 'n1', depth: 2 });
check('dag_walk returns reachable nodes', walk.ok === true && walk.nodes.some((node) => node.id === 'n2'), JSON.stringify(walk));
const diff = await call('dag_diff');
check('dag_diff returns a snapshot diff', diff.ok === true && Array.isArray(diff.added) && diff.added.length === 2, JSON.stringify(diff));
const nodesPage = await call('nodes_page', { limit: 1 });
check('nodes_page returns a cursor page', nodesPage.ok === true && nodesPage.nodes.length === 1 && nodesPage.total === 2, JSON.stringify(nodesPage));
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

// Removed actions must not linger in the service dispatcher or the enum.
const { ACTION_CATALOG } = await import('../host/kernel/policy.js');
for (const action of ['intent_submit', 'intent_list', 'experts_list', 'expert_upsert', 'curator_scan', 'curator_nominate']) {
  check(`${action} is not advertised`, !Object.hasOwn(ACTION_CATALOG, action));
  let thrown = null;
  try {
    await call(action, {});
  } catch (error) {
    thrown = error;
  }
  check(`${action} is not silently accepted`, thrown === null || thrown.code === 'unknown_command', String(thrown?.code));
}

console.log(`\n${failed === 0 ? 'tool-surface-selftest: all checks passed' : `tool-surface-selftest: ${failed} failed`}`);
process.exit(failed === 0 ? 0 : 1);
