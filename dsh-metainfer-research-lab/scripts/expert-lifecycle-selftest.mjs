/**
 * 4.5 lifecycle: hire one catalog expert, drain without killing work, then fire
 * only after the drain is empty. Ownership is handed back to the human; experts
 * cannot mutate the roster.
 */
import { openStore } from '../host/store.js';
import { createKernel } from '../host/kernel/instance.js';
import { createLabService } from '../host/lab-service.js';
import { registerAgentTool } from '../host/agent-tool.js';
import { registerHttpRoutes } from '../host/http.js';
import { actorForSession, authorizeAction } from '../host/kernel/policy.js';
import { memoryDomain, storeContext } from './lib/memory-domain.mjs';

let failed = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`ok   ${name}`);
  else { failed += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const store = await openStore(storeContext(memoryDomain()));
const kernel = createKernel({ store });
const projectId = 'lifecycle-p';
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
await kernel.executor.commit(projectId, {
  actor: { kind: 'human', id: 'test' },
  mutations: [
    { op: 'node.create', node: { id: 'run-1', title: 'running work', status: 'running', createdBy: 'lab-advisor', timestamps: { createdAt: 1, startedAt: 1 } } },
    { op: 'node.create', node: { id: 'plan-1', title: 'planned work', status: 'planned', createdBy: 'lab-advisor', timestamps: { createdAt: 2 } } },
  ],
});
const service = createLabService({ ctx: { effect: () => {}, get: () => null, logger: { info() {}, warn() {} } }, store, kernel, git: null, runtime: null, transcript: null, orchestrator: null, auto: null, cluster: null, clusterAdmin: null });
const toolCtx = { tools: { register(definition) { toolCtx.tool = definition; return () => {}; } } };
registerAgentTool(toolCtx, service);
const call = async (args, exec) => JSON.parse((await toolCtx.tool.execute(args, exec)).result);
const humanExec = { agent: { session: { id: 's-human', header: {} } } };
const curatorExec = { agent: { session: { id: 's-curator', header: { meta: { agentPreset: 'lab-curator' } } } } };

const before = await call({ action: 'expert_list', projectId }, humanExec);
check('catalog starts as available and read-only', before.ok === true && before.experts.every((expert) => expert.lifecycle?.status === 'catalog' && expert.mayExecute.length === 0));

const forbidden = await call({ action: 'expert_hire', projectId, expertId: 'lab-advisor' }, curatorExec);
check('an expert preset cannot mutate the roster', forbidden.ok === false && forbidden.error?.code === 'forbidden_action', JSON.stringify(forbidden));

const hired = await call({ action: 'expert_hire', projectId, expertId: 'lab-advisor', lens: 'systems' }, humanExec);
check('hire creates an active roster entry', hired.ok === true && hired.expert?.lifecycle?.status === 'active' && hired.expert?.lifecycle?.active === true, JSON.stringify(hired));
const listed = await call({ action: 'expert_list', projectId }, humanExec);
check('expert library shows lifecycle status', listed.experts.find((expert) => expert.id === 'lab-advisor')?.lifecycle?.status === 'active');

const duplicate = await call({ action: 'expert_hire', projectId, expertId: 'lab-advisor' }, humanExec);
check('hire is idempotently refused for an active expert', duplicate.ok === false && duplicate.error?.code === 'expert_already_hired', JSON.stringify(duplicate));

const recalled = await call({ action: 'expert_recall', projectId, task: 'review duplicate kernel work' }, humanExec);
check('recall only returns active roster experts', recalled.ok === true && recalled.experts.every((expert) => expert.descriptor?.id === 'lab-advisor'), JSON.stringify(recalled.experts?.map((expert) => expert.descriptor?.id)));

const earlyFire = await call({ action: 'expert_fire', projectId, expertId: 'lab-advisor' }, humanExec);
check('fire before drain is refused', earlyFire.ok === false && earlyFire.error?.code === 'expert_must_drain', JSON.stringify(earlyFire));

const drained = await call({ action: 'expert_drain', projectId, expertId: 'lab-advisor' }, humanExec);
check('drain preserves the running node instead of killing it', drained.ok === true && drained.expert?.lifecycle?.status === 'draining' && drained.runningPreserved.includes('run-1') && store.getNode(projectId, 'run-1')?.status === 'running', JSON.stringify(drained));

const afterDrain = await call({ action: 'expert_recall', projectId, task: 'review duplicate kernel work' }, humanExec);
check('a draining expert is no longer recruited', afterDrain.ok === true && afterDrain.total === 0 && afterDrain.experts.length === 0, JSON.stringify(afterDrain));

const busyFire = await call({ action: 'expert_fire', projectId, expertId: 'lab-advisor' }, humanExec);
check('fire while a running node remains is refused', busyFire.ok === false && busyFire.error?.code === 'expert_busy', JSON.stringify(busyFire));

await kernel.executor.commit(projectId, {
  actor: { kind: 'human', id: 'test' },
  mutations: [{ op: 'node.transition', nodeId: 'run-1', to: 'completed', set: {} }],
});
const fired = await call({ action: 'expert_fire', projectId, expertId: 'lab-advisor' }, humanExec);
check('fire retires the drained expert', fired.ok === true && fired.expert?.lifecycle?.status === 'retired', JSON.stringify(fired));
check('unfinished ownership is handed back to the human', fired.reassigned.includes('plan-1') && store.getNode(projectId, 'plan-1')?.createdBy === 'human' && store.getNode(projectId, 'plan-1')?.orphanedFrom === 'lab-advisor', JSON.stringify(store.getNode(projectId, 'plan-1')));
check('the retired expert is no longer recruited', (await call({ action: 'expert_recall', projectId, task: 'anything' }, humanExec)).total === 0);

// Direct service check: self-hire is a specific refusal, not a generic one.
const routes = new Map();
registerHttpRoutes({
  effect: () => {},
  connection: { fetch: { register({ path: routePath, fetch }) { routes.set(routePath, fetch); return () => {}; } } },
}, service);
const httpCommand = async (body) => {
  const handler = routes.get('/api/metainfer-research-lab/commands');
  const response = await handler(new Request('http://local/api/metainfer-research-lab/commands', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return response.json();
};
const viaHttp = await httpCommand({ type: 'expert_hire', projectId, expertId: 'lab-advisor' });
check('HTTP /commands exposes expert_hire (not unknown_command)', viaHttp.ok === true && viaHttp.data?.expert?.lifecycle?.status === 'active', JSON.stringify(viaHttp));

const httpRequest = async (routePath, options = {}) => {
  const [pathname, search = ''] = routePath.split('?');
  const handler = routes.get('/api/metainfer-research-lab/' + pathname);
  const response = await handler(new Request('http://local/api/metainfer-research-lab/' + pathname + (search ? '?' + search : ''), options));
  return response.json();
};
const disputesHttp = await httpRequest('disputes?projectId=' + encodeURIComponent(projectId));
check('HTTP /disputes returns the dispute table', disputesHttp.ok === true && Array.isArray(disputesHttp.data?.disputes), JSON.stringify(disputesHttp));
const budgetsHttp = await httpRequest('budgets?projectId=' + encodeURIComponent(projectId));
check('HTTP /budgets returns five uncapped class rows without actor keys',
  budgetsHttp.ok === true && budgetsHttp.data?.classes?.length === 5
  && budgetsHttp.data.classes.every((row) => row.budget === null && !Object.prototype.hasOwnProperty.call(row, 'actorKey')),
  JSON.stringify(budgetsHttp));
const reviewsHttp = await httpRequest('reviews?projectId=' + encodeURIComponent(projectId));
check('HTTP /reviews degrades to a named unavailable error when no orchestrator is wired',
  reviewsHttp.ok === false && reviewsHttp.error?.code === 'unavailable', JSON.stringify(reviewsHttp));
const retroBeforeHttp = await httpRequest('retrospective?projectId=' + encodeURIComponent(projectId));
const retroGenerateHttp = await httpRequest('retrospective', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ projectId, title: 'http probe' }),
});
const retroAfterHttp = await httpRequest('retrospective?projectId=' + encodeURIComponent(projectId));
check('HTTP POST/GET /retrospective persists one generated record',
  retroBeforeHttp.ok === true && retroGenerateHttp.ok === true
  && retroGenerateHttp.data?.retrospective?.counts?.nodes === 2
  && retroAfterHttp.data?.retrospectives?.length === retroBeforeHttp.data.retrospectives.length + 1
  && retroAfterHttp.data.retrospectives.slice(-1)[0]?.retrospective?.id === retroGenerateHttp.data.retrospective.id,
  JSON.stringify({ before: retroBeforeHttp.data?.retrospectives?.length, after: retroAfterHttp.data?.retrospectives?.length, generated: retroGenerateHttp }));


const selfExec = { agent: { session: { id: 'lab-advisor', header: { meta: { agentPreset: 'lab-advisor' } } } } };
let selfError = null;
try { await service.hireExpert(projectId, { expertId: 'lab-advisor' }, selfExec); } catch (error) { selfError = error; }
check('an expert cannot hire itself', selfError?.code === 'self_hire_forbidden', String(selfError));
const curatorActor = actorForSession({ agentPreset: 'lab-curator', sessionId: 's-curator' });
check('lifecycle actions are Host-control only', ['expert_hire', 'expert_drain', 'expert_fire'].every((action) => authorizeAction(curatorActor, action).ok === false));

console.log(`\n${failed === 0 ? 'all checks passed' : `${failed} failed`}`);
process.exit(failed === 0 ? 0 : 1);
