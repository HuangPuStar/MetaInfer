#!/usr/bin/env node
/**
 * Project-level expert overrides: edit, validation, before/after trace and
 * rollback. The catalog remains immutable; mayExecute is never writable.
 */
import { openStore } from '../host/store.js';
import { createKernel } from '../host/kernel/instance.js';
import { createLabService } from '../host/lab-service.js';
import { memoryDomain, storeContext } from './lib/memory-domain.mjs';

let failed = 0;
function check(name, condition, detail = '') {
  if (condition) process.stdout.write(`ok   ${name}\n`);
  else {
    failed += 1;
    process.stdout.write(`FAIL ${name}${detail ? ` — ${detail}` : ''}\n`);
  }
}
async function expectError(fn, code) {
  try {
    await fn();
    return false;
  } catch (error) {
    return error?.code === code;
  }
}

const store = await openStore(storeContext(memoryDomain()));
const kernel = createKernel({ store });
const projectId = 'expert-override-p';
await store.saveProject({
  id: projectId, revision: 0, counters: { eventSeq: 0 },
  config: { maxRunningNodes: 2, resourcePools: {}, maxNodes: 100 },
  repo: { path: process.cwd() }, createdAt: 0, updatedAt: 0,
});
kernel.load(projectId);
const service = createLabService({
  ctx: { effect: () => {}, get: () => null, logger: { info() {}, warn() {} } },
  store, kernel, git: null, runtime: null, transcript: null, orchestrator: null, auto: null,
  cluster: null, clusterAdmin: null,
});
const humanExec = { kind: 'human', id: 'operator' };

const initial = await service.listExperts(projectId);
const advisor = initial.experts.find((expert) => expert.id === 'lab-advisor');
check('catalog experts expose an effective descriptor and no project override',
  advisor !== undefined && advisor.override === null && advisor.overriddenFields.length === 0
  && advisor.mayExecute.length === 0);

const updated = await service.updateExpert(projectId, {
  expertId: 'lab-advisor',
  expert: {
    persona: 'Project-specific lead: prefer small ablation branches.',
    model: { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' },
    tools: ['dag_get', 'dag_query'],
    budget: { queriesPerRun: 2, tokensPerHour: 50_000, wallClockMs: 90_000 },
    triggers: ['node.completed', 'review.requested'],
    mayVeto: true,
    level: 'lead',
  },
  reason: 'tighten the advisor budget for this project',
}, humanExec);
check('updateExpert commits a project override event', updated.changed === true && updated.event?.type === 'expert/updated', JSON.stringify(updated));

const projectAfter = store.getProject(projectId);
const saved = projectAfter.config.expertOverrides['lab-advisor'];
check('the override is stored project-level, not in the catalog',
  saved?.persona.startsWith('Project-specific') && saved?.model?.model === 'deepseek-reasoner'
  && saved?.budget?.queriesPerRun === 2 && saved?.mayVeto === true && saved?.level === 'lead',
  JSON.stringify(saved));
check('mayExecute is not stored or writable', !Object.prototype.hasOwnProperty.call(saved, 'mayExecute'));

const listed = await service.listExperts(projectId);
const effective = listed.experts.find((expert) => expert.id === 'lab-advisor');
check('listExperts returns the effective editable fields and the override',
  effective.persona.startsWith('Project-specific') && effective.model.model === 'deepseek-reasoner'
  && effective.budget.queriesPerRun === 2 && effective.override !== null
  && effective.overriddenFields.includes('persona') && effective.mayExecute.length === 0,
  JSON.stringify({ overriddenFields: effective?.overriddenFields, mayExecute: effective?.mayExecute }));

const events = store.listEvents(projectId, 0).filter((event) => event.type === 'expert/updated');
check('the trace records before/after and the changed field list',
  events.length === 1 && events[0].data.before === null
  && events[0].data.after.persona.startsWith('Project-specific')
  && events[0].data.changedFields.includes('persona')
  && events[0].data.reason === 'tighten the advisor budget for this project',
  JSON.stringify(events[0]?.data ?? null));

check('mayExecute cannot be granted by an update',
  await expectError(() => service.updateExpert(projectId, {
    expertId: 'lab-advisor', expert: { mayExecute: ['node.start'] },
  }, humanExec), 'expert_may_execute_readonly'));
check('unknown tools are rejected before writing',
  await expectError(() => service.updateExpert(projectId, {
    expertId: 'lab-advisor', expert: { tools: ['shell.exec'] },
  }, humanExec), 'expert_tool_unknown'));
check('unknown budget keys are rejected before writing',
  await expectError(() => service.updateExpert(projectId, {
    expertId: 'lab-advisor', expert: { budget: { infinite: true } },
  }, humanExec), 'expert_budget_unknown'));
check('invalid levels are rejected before writing',
  await expectError(() => service.updateExpert(projectId, {
    expertId: 'lab-advisor', expert: { level: 'root' },
  }, humanExec), 'bad_request'));

const rolledBack = await service.rollbackExpert(projectId, {
  expertId: 'lab-advisor', eventSeq: events[0].seq, reason: 'restore catalog budget',
}, humanExec);
check('rollback removes the project override and records its own event',
  rolledBack.changed === true && rolledBack.event?.type === 'expert/update_rolled_back'
  && store.getProject(projectId).config.expertOverrides['lab-advisor'] === undefined,
  JSON.stringify(rolledBack));
const rollbackEvent = store.listEvents(projectId, 0).find((event) => event.type === 'expert/update_rolled_back');
check('rollback trace points at the update it undid',
  rollbackEvent?.data?.targetEventSeq === events[0].seq && rollbackEvent?.data?.after === null,
  JSON.stringify(rollbackEvent?.data ?? null));

const afterRollback = await service.listExperts(projectId);
const restored = afterRollback.experts.find((expert) => expert.id === 'lab-advisor');
check('rollback restores the catalog persona/model/budget',
  restored.override === null && restored.persona.includes('Exploration lead')
  && restored.model.model === 'deepseek-chat' && restored.budget.queriesPerRun === 4,
  JSON.stringify({ persona: restored.persona, model: restored.model, budget: restored.budget }));

const noChange = await service.updateExpert(projectId, {
  expertId: 'lab-advisor', expert: { persona: restored.persona },
}, humanExec);
check('a no-op edit does not create a false trace entry',
  noChange.changed === false && noChange.event === null
  && store.listEvents(projectId, 0).filter((event) => event.type === 'expert/updated').length === 1,
  JSON.stringify(noChange));

if (failed > 0) process.exit(1);
process.stdout.write('expert-overrides-selftest: all checks passed\n');
