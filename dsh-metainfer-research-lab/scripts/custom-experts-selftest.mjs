#!/usr/bin/env node
/**
 * Project-scoped custom experts: role-template inheritance, server-side
 * validation, lifecycle reuse and safe deletion.
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
async function errorCode(fn) {
  try {
    await fn();
    return null;
  } catch (error) {
    return error?.code ?? String(error);
  }
}

const store = await openStore(storeContext(memoryDomain()));
const kernel = createKernel({ store });
const projectId = 'custom-expert-p';
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
check('GET /experts advertises the read-only tool catalog',
  initial.toolCatalog.length >= 6
  && initial.toolCatalog.every((tool) => typeof tool.name === 'string' && tool.readOnly === true && typeof tool.description === 'string'),
  JSON.stringify(initial.toolCatalog));
check('GET /experts advertises the closed trigger enum',
  initial.triggerCatalog.some((trigger) => trigger.name === 'node.completed')
  && initial.triggerCatalog.some((trigger) => trigger.name === 'interval:15m'),
  JSON.stringify(initial.triggerCatalog));
check('GET /experts advertises all five role templates with locked capabilities',
  initial.templates.map((template) => template.id).join(',') === 'proposer,reviewer,branch,curator,chief'
  && initial.templates.every((template) => typeof template.mayCreate === 'boolean' && typeof template.mayVeto === 'boolean'),
  JSON.stringify(initial.templates.map((template) => template.id)));

const created = await service.createExpert(projectId, {
  expert: {
    name: 'Delta',
    id: 'custom:delta',
    template: 'proposer',
    persona: 'Delta focuses on cheap ablations and states expected information gain.',
    model: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
    tools: ['dag_map', 'dag_query'],
    triggers: ['node.completed', 'review.requested'],
    budget: { queriesPerRun: 2, tokensPerHour: 32_000, wallClockMs: 90_000 },
    level: 'lead',
  },
}, humanExec);
const delta = created.expert;
check('a custom expert inherits mayPropose/schema from its template',
  delta.id === 'custom:delta' && delta.template === 'proposer' && delta.custom === true
  && delta.mayPropose.join(',') === 'proposal,priority' && delta.mayCreate === true && delta.mayVeto === false,
  JSON.stringify({ mayPropose: delta.mayPropose, mayCreate: delta.mayCreate, mayVeto: delta.mayVeto }));
check('a custom expert can never hold execution authority',
  Array.isArray(delta.mayExecute) && delta.mayExecute.length === 0);
check('the custom definition is stored project-level, not in the code catalog',
  store.getProject(projectId).config.customExperts?.some((row) => row.id === 'custom:delta' && row.template === 'proposer'));

const listed = await service.listExperts(projectId);
check('the new custom expert appears in catalog + custom collections',
  listed.experts.some((expert) => expert.id === 'custom:delta')
  && listed.custom.some((expert) => expert.id === 'custom:delta')
  && listed.catalog.every((expert) => expert.id !== 'custom:delta'));

const hired = await service.hireExpert(projectId, { expertId: 'custom:delta' }, humanExec);
check('a custom expert can be hired through the existing lifecycle',
  hired.ok === true && hired.expert.lifecycle.status === 'active');
check('the custom expert appears on the project roster',
  (await service.listExperts(projectId)).experts.find((expert) => expert.id === 'custom:delta')?.lifecycle.status === 'active');

const mayExecuteCode = await errorCode(() => service.createExpert(projectId, {
  expert: { name: 'Bad', id: 'custom:bad-exec', template: 'proposer', mayExecute: [] },
}, humanExec));
check('mayExecute is rejected even when the request sends an empty list',
  mayExecuteCode === 'expert_may_execute_readonly', mayExecuteCode);
const unknownToolCode = await errorCode(() => service.createExpert(projectId, {
  expert: {
    name: 'Bad', id: 'custom:bad-tool', template: 'proposer', persona: 'x',
    model: { provider: 'deepseek', model: 'deepseek-chat' }, tools: ['shell.exec'], triggers: [],
    budget: { queriesPerRun: 1, tokensPerHour: 1, wallClockMs: 1000 },
  },
}, humanExec));
check('unknown tools are rejected with an executable message',
  unknownToolCode === 'expert_tool_unknown', unknownToolCode);
const vetoCode = await errorCode(() => service.createExpert(projectId, {
  expert: {
    name: 'Bad', id: 'custom:bad-veto', template: 'reviewer', mayVeto: true, persona: 'x',
    model: { provider: 'deepseek', model: 'deepseek-chat' }, tools: [], triggers: [],
    budget: { queriesPerRun: 1, tokensPerHour: 1, wallClockMs: 1000 },
  },
}, humanExec));
check('a template cannot be granted mayVeto in the request',
  vetoCode === 'expert_template_capability_locked', vetoCode);
const badIdCode = await errorCode(() => service.createExpert(projectId, {
  expert: {
    name: 'Bad', id: 'delta', template: 'proposer', persona: 'x',
    model: { provider: 'deepseek', model: 'deepseek-chat' }, tools: [], triggers: [],
    budget: { queriesPerRun: 1, tokensPerHour: 1, wallClockMs: 1000 },
  },
}, humanExec));
check('custom ids must be custom:<slug>', badIdCode === 'expert_id_invalid', badIdCode);
const duplicateCode = await errorCode(() => service.createExpert(projectId, {
  expert: {
    name: 'Delta again', id: 'custom:delta', template: 'reviewer', persona: 'x',
    model: { provider: 'deepseek', model: 'deepseek-chat' }, tools: [], triggers: [],
    budget: { queriesPerRun: 1, tokensPerHour: 1, wallClockMs: 1000 },
  },
}, humanExec));
check('duplicate custom ids are rejected', duplicateCode === 'expert_id_taken', duplicateCode);
const catalogDeleteCode = await errorCode(() => service.deleteExpert(projectId, { expertId: 'lab-advisor' }, humanExec));
check('catalog experts cannot be deleted', catalogDeleteCode === 'expert_not_custom', catalogDeleteCode);

const deleteHiredCode = await errorCode(() => service.deleteExpert(projectId, { expertId: 'custom:delta' }, humanExec));
check('an active custom expert cannot be deleted', deleteHiredCode === 'expert_in_use', deleteHiredCode);
const updateVetoCode = await errorCode(() => service.updateExpert(projectId, {
  expertId: 'custom:delta', expert: { mayVeto: true },
}, humanExec));
check('an update cannot override the template capability',
  updateVetoCode === 'expert_template_capability_locked', updateVetoCode);
const updated = await service.updateExpert(projectId, {
  expertId: 'custom:delta', expert: { persona: 'Updated Delta persona', tools: ['dag_get'] },
}, humanExec);
check('a custom expert can still be edited through project overrides',
  updated.changed === true && updated.expert.persona === 'Updated Delta persona' && updated.expert.tools.join(',') === 'dag_get');
const rolledBack = await service.rollbackExpert(projectId, {
  expertId: 'custom:delta', eventSeq: updated.event.seq,
}, humanExec);
check('rollback restores the custom expert definition view',
  rolledBack.changed === true && rolledBack.expert.persona.startsWith('Delta focuses'));

await service.drainExpert(projectId, { expertId: 'custom:delta' }, humanExec);
await service.fireExpert(projectId, { expertId: 'custom:delta' }, humanExec);
const deleted = await service.deleteExpert(projectId, { expertId: 'custom:delta' }, humanExec);
check('after retire the custom definition can be deleted',
  deleted.deleted === true && store.getProject(projectId).config.customExperts.every((row) => row.id !== 'custom:delta'));
check('deleting the definition also removes its project override',
  store.getProject(projectId).config.expertOverrides['custom:delta'] === undefined);
const eventTypes = store.listEvents(projectId, 0).map((event) => event.type);
check('created/deleted lifecycle events are recorded',
  eventTypes.includes('expert/created') && eventTypes.includes('expert/deleted'));

console.log(failed === 0 ? '\ncustom-experts-selftest: all checks passed' : `\ncustom-experts-selftest: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
