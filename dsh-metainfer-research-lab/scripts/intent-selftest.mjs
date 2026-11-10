/**
 * Stage 3 intent log: an expert's judgement carries claim + basis, is persisted
 * through the kernel, and resolves through /explain. Also covers the Host's own
 * priority decision, which must write an intent without the model asking.
 */
import { openStore } from '../host/store.js';
import { createKernel } from '../host/kernel/instance.js';
import { createLabService } from '../host/lab-service.js';
import { registerAgentTool } from '../host/agent-tool.js';
import { createExplainer } from '../host/observability/explain.js';
import { ACTION_CATALOG, allowedActions } from '../host/kernel/policy.js';
import { memoryDomain, storeContext } from './lib/memory-domain.mjs';

let failed = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`ok   ${name}`);
  else { failed += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const store = await openStore(storeContext(memoryDomain()));
const kernel = createKernel({ store });
const projectId = 'intent-p';
await store.saveProject({
  id: projectId,
  revision: 0,
  counters: { eventSeq: 0 },
  config: { maxRunningNodes: 2, resourcePools: {}, maxNodes: 100 },
  repo: { path: process.cwd() },
  createdAt: 0,
  updatedAt: 0,
});
kernel.load(projectId);
await store.saveNode(projectId, { id: 'n1', title: 'root', status: 'planned', timestamps: { createdAt: 1 } });
await store.saveNode(projectId, { id: 'n2', title: 'child', status: 'planned', parentIds: ['n1'], timestamps: { createdAt: 2 } });
const service = createLabService({
  ctx: { effect: () => {}, get: () => null, logger: { info() {}, warn() {} } },
  store, kernel, git: null, runtime: null, transcript: null, orchestrator: null, auto: null, cluster: null, clusterAdmin: null,
});
const toolCtx = { tools: { register(definition) { toolCtx.tool = definition; return () => {}; } } };
registerAgentTool(toolCtx, service);
const advisor = { agent: { session: { id: 's-advisor', header: { meta: { agentPreset: 'lab-advisor' } } } } };
const human = { agent: { session: { id: 's-human', header: {} } } };
const call = async (args, exec = advisor) => JSON.parse((await toolCtx.tool.execute(args, exec)).result);

const submitted = await call({
  action: 'intent_submit',
  projectId,
  kind: 'proposal',
  nodeId: 'n2',
  target: { nodeId: 'n2', parentId: 'n1' },
  claim: { action: 'propose_split', strategy: 'split-by-file', reason: 'two independent seams' },
  rationale: 'split lowers timebox risk',
});
check('intent_submit returns an intent', submitted.ok === true && submitted.intent?.id, JSON.stringify(submitted));
check('intent records claim and basis', submitted.intent?.claim?.action === 'propose_split' && Number.isInteger(submitted.intent?.basis), JSON.stringify(submitted.intent));
check('intent is persisted in the project', (store.getProject(projectId).intents ?? []).some((intent) => intent.id === submitted.intent.id));
check('intent event carries the intent cause', submitted.event?.causeId === `intent:${submitted.intent.id}` && submitted.event?.type === 'intent/submitted', JSON.stringify(submitted.event));

const explainer = createExplainer({ store, projection: kernel.projection });
const explained = explainer.explainNode(projectId, 'n2');
check('intent target explains through its cause chain', explained.ok === true && explained.causeChain.some((entry) => entry.causeId === `intent:${submitted.intent.id}`), JSON.stringify(explained.causeChain));

const listed = await call({ action: 'intent_list', projectId, limit: 10, kind: 'proposal' });
check('intent_list returns the claim', listed.ok === true && listed.intents.some((intent) => intent.id === submitted.intent.id), JSON.stringify(listed));
check('intent_list is bounded', listed._truncated === null && listed.total >= 1);

const missingClaim = await call({ action: 'intent_submit', projectId, kind: 'note', nodeId: 'n1' });
check('intent_submit rejects a claimless judgement', missingClaim.ok === false && missingClaim.error?.code === 'bad_request', JSON.stringify(missingClaim));
const ahead = await call({ action: 'intent_submit', projectId, kind: 'note', nodeId: 'n1', claim: { action: 'observe' }, basis: 999 });
check('intent_submit rejects a basis ahead of the project', ahead.ok === false && ahead.error?.code === 'basis_ahead', JSON.stringify(ahead));
const badKind = await call({ action: 'intent_submit', projectId, kind: 'delete_everything', nodeId: 'n1', claim: { action: 'nuke' } });
check('intent_submit rejects an unknown kind', badKind.ok === false && badKind.error?.code === 'bad_request', JSON.stringify(badKind));

// Host-authored priority decision: the caller does not submit an intent.
const prior = await call({ action: 'set_priority', projectId, nodeId: 'n1', class: 'p1', reason: 'unblocks the merge' }, human);
check('set_priority succeeds', prior.ok === true, JSON.stringify(prior));
const priorityIntents = store.getProject(projectId).intents.filter((intent) => intent.kind === 'priority');
check('set_priority writes a priority intent automatically', priorityIntents.length === 1 && priorityIntents[0].claim?.action === 'set_priority', JSON.stringify(priorityIntents));
check('priority intent carries the actor and basis', priorityIntents[0]?.actor?.kind === 'human' && Number.isInteger(priorityIntents[0]?.basis), JSON.stringify(priorityIntents[0]?.actor));
const priorityExplain = explainer.explainNode(projectId, 'n1');
check('priority decision is explainable', priorityExplain.ok === true && priorityExplain.causeChain.some((entry) => entry.causeId === `intent:${priorityIntents[0].id}`), JSON.stringify(priorityExplain.causeChain));

check('intent actions are in the policy catalog', ACTION_CATALOG.intent_submit === 'write' && ACTION_CATALOG.intent_list === 'read');
check('intent_submit is allowed for advisors', allowedActions({ kind: 'expert', id: 'a', preset: 'lab-advisor' }).includes('intent_submit'));

console.log(failed === 0 ? '\nintent-selftest: all checks passed' : `\nintent-selftest: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
