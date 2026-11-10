/**
 * Priority write regression (B7): priority must be an executor commit, and a
 * running/terminal node must reject the change instead of reporting success.
 */
import assert from 'node:assert/strict';
import { openStore } from '../host/store.js';
import { createKernel } from '../host/kernel/instance.js';
import { createLabService } from '../host/lab-service.js';
import { registerAgentTool } from '../host/agent-tool.js';
import { createOrchestrator } from '../host/orchestrator.js';
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
const service = createLabService({
  ctx: fakeCtx, store, kernel, git: null, runtime: null, transcript: null, orchestrator: null, auto: null, cluster: null, clusterAdmin: null,
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
    { op: 'node.create', node: { id: 'planned', title: 'planned', status: 'planned', priority: { class: 'p2' }, timestamps: { createdAt: 1 } } },
    { op: 'node.create', node: { id: 'running', title: 'running', status: 'planned', priority: { class: 'p2' }, timestamps: { createdAt: 2 } } },
    { op: 'node.create', node: { id: 'done', title: 'done', status: 'planned', priority: { class: 'p2' }, timestamps: { createdAt: 3 } } },
  ],
});
await kernel.executor.commit('p', { actor: { kind: 'human', id: 'test' }, mutations: [{ op: 'node.transition', nodeId: 'running', to: 'running' }] });
await kernel.executor.commit('p', { actor: { kind: 'human', id: 'test' }, mutations: [{ op: 'node.transition', nodeId: 'done', to: 'running' }] });
await kernel.executor.commit('p', { actor: { kind: 'human', id: 'test' }, mutations: [{ op: 'node.transition', nodeId: 'done', to: 'completed' }] });

// 1. Planned node: accepted, and the write is an executor event.
const beforeEvents = store.listEvents('p', 0).length;
const ok = await service.setNodePriority('p', 'planned', { class: 'p0', reason: 'human says urgent' });
check('planned node accepts a priority change', ok.ok === true, JSON.stringify(ok));
check('priority is applied', store.getNode('p', 'planned').priority.class === 'p0', store.getNode('p', 'planned').priority.class);
check('priority change is an executor event', store.listEvents('p', 0).some((event) => event.type === 'node/priority_changed' && event.nodeId === 'planned' && event.actor?.kind === 'human'));
check('priority and its intent are committed together', store.listEvents('p', 0).length === beforeEvents + 2 && store.listEvents('p', 0).some((event) => event.type === 'intent/submitted' && event.nodeId === 'planned'), String(store.listEvents('p', 0).length - beforeEvents));

// 2. Running/terminal nodes: rejected with a defined, actionable code, no write.
for (const nodeId of ['running', 'done']) {
  const before = store.getNode('p', nodeId);
  const eventsBefore = store.listEvents('p', 0).length;
  const result = await service.setNodePriority('p', nodeId, { class: 'deferred' });
  check(`${nodeId} node rejects priority change`, result.ok === false && result.error?.code === 'priority_frozen', JSON.stringify(result));
  check(`${nodeId} rejection has a next step`, typeof result.error?.nextStep === 'string' && result.error.nextStep.length > 10, JSON.stringify(result.error ?? null));
  check(`${nodeId} node is unchanged`, store.getNode('p', nodeId).priority.class === before.priority.class, store.getNode('p', nodeId).priority.class);
  check(`${nodeId} rejection wrote no event`, store.listEvents('p', 0).length === eventsBefore);
}

// 3. updateNode must not be a second write path around the executor.
let updateError = null;
try {
  await service.updateNode('p', 'running', { title: 'renamed', priority: { class: 'deferred' } });
} catch (error) {
  updateError = error;
}
check('updateNode rejects priority on a running node', updateError !== null && updateError.code === 'priority_frozen', String(updateError?.code));
check('updateNode did not rename the running node', store.getNode('p', 'running').title === 'running', store.getNode('p', 'running').title);

// 3b. A tool call must be attributed to the real session, not to a fake human.
const toolCtx = { tools: { register(definition) { toolCtx.tool = definition; return () => {}; } } };
registerAgentTool(toolCtx, service);
const chatExec = { agent: { session: { id: 'sess-chat-1', header: { meta: { agentPreset: 'lab-chat' } } } } };
const chatCall = JSON.parse((await toolCtx.tool.execute({ action: 'set_priority', projectId: 'p', nodeId: 'planned', class: 'p1' }, chatExec)).result);
check('lab-chat may change priority through the tool', chatCall.ok === true, JSON.stringify(chatCall));
const priorityEvents = store.listEvents('p', 0).filter((event) => event.nodeId === 'planned' && event.type === 'node/priority_changed');
const lastPriority = priorityEvents[priorityEvents.length - 1];
check('priority event is attributed to the calling session', lastPriority?.actor?.id === 'sess-chat-1', JSON.stringify(lastPriority?.actor ?? null));
check('priority event keeps the actor kind', lastPriority?.actor?.kind === 'expert', JSON.stringify(lastPriority?.actor ?? null));

// 4. The kernel itself refuses the write, not only the service wrapper.
const direct = await kernel.executor.commit('p', {
  actor: { kind: 'human', id: 'test' },
  mutations: [{ op: 'node.setPriority', nodeId: 'running', priority: { class: 'p0' } }],
});
check('kernel commit refuses priority on a running node', direct.ok === false && direct.code === 'priority_frozen', JSON.stringify(direct));
check('kernel refusal left the node unchanged', store.getNode('p', 'running').priority.class === 'p2', store.getNode('p', 'running').priority.class);

// 5. Validation still happens before the commit.
const badClass = await service.setNodePriority('p', 'planned', { class: 'urgent' });
check('unknown priority class is rejected', badClass.ok === false && badClass.error?.code === 'bad_request', JSON.stringify(badClass));

// 6. A human-created successor defaults to p0, so the human path bypasses the
// advisor queue. The fake git only supplies the two methods createChild uses.
const humanProject = {
  id: 'hp', revision: 0, counters: { eventSeq: 0, nextNodeSeq: 2, nodes: 1, cycles: 0 },
  config: { maxRunningNodes: 2, resourcePools: { gpu: 2 }, maxNodes: 100, nodeTimeoutMinutes: 30, maxNodeTimeoutMinutes: 240 },
  repo: { path: process.cwd(), worktreeRoot: process.cwd(), baseBranch: 'main', baseCommit: 'base' },
  createdAt: 0, updatedAt: 0,
};
await store.saveProject(humanProject);
kernel.load('hp');
await kernel.executor.commit('hp', {
  actor: { kind: 'human', id: 'test' },
  mutations: [{ op: 'node.create', node: { id: 'parent', title: 'completed parent', status: 'completed', createdBy: 'user', git: { headCommit: 'base' }, timestamps: { createdAt: 1, completedAt: 2 } } }],
});
const fakeGit = {
  async commitWorktree() { return { head: 'abc123' }; },
  async tagCommit() {},
};
const orchestrator = createOrchestrator({ ctx: fakeCtx, store, git: fakeGit, runtime: null, cluster: null, kernel });
const humanStarted = Date.now();
const successor = await orchestrator.createSuccessor('hp', 'parent', {
  title: 'human successor',
  prompt: 'Run the human-requested follow-up experiment.',
  successCriteria: 'a measurable result',
  timeboxMinutes: 10,
});
const humanElapsed = Date.now() - humanStarted;
check('human successor is created', Boolean(successor?.node?.id), JSON.stringify(successor));
check('human successor defaults to p0', successor.node.priority?.class === 'p0', JSON.stringify(successor.node.priority));
check('human successor is attributed to the human', successor.node.priority?.by === 'human', JSON.stringify(successor.node.priority));
check('human p0 creation completes under one second', humanElapsed < 1000, `${humanElapsed} ms`);

console.log(`\n${failed === 0 ? 'priority-selftest: all checks passed' : `priority-selftest: ${failed} failed`}`);
process.exit(failed === 0 ? 0 : 1);
