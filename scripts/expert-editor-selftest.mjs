#!/usr/bin/env node
/**
 * Top-level expert editor regression: roster actions, validation, diff, save
 * payload, rollback and the "what next" empty state.
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/?project=p1&tab=experts',
  pretendToBeVisual: true,
});
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.localStorage = window.localStorage;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');

globalThis.__METAINFER_OPERATOR_TOKEN__ = 'expert-editor-token';
window.__METAINFER_TEST__ = true;

const failures = [];
function check(name, condition, detail = '') {
  if (condition) process.stdout.write(`ok   ${name}\n`);
  else failures.push(name + (detail === '' ? '' : ': ' + detail));
}
async function wait(ms = 40) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
function setValue(element, value) {
  const proto = element.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement.prototype
    : element.tagName === 'SELECT'
      ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value);
  if (element.tagName !== 'SELECT') element.dispatchEvent(new window.Event('input', { bubbles: true }));
  element.dispatchEvent(new window.Event('change', { bubbles: true }));
}
function buttonByText(host, text) {
  return Array.from(host.querySelectorAll('button')).find((button) => button.textContent === text) ?? null;
}

let factory = null;
window.__ModuleLoader__ = { load({ factory: captured }) { factory = captured; } };
await import('../client.js?expert-editor-selftest=1');
assert.equal(typeof factory, 'function');
const module = factory((id) => {
  if (id === 'react') return React;
  throw new Error(`unexpected require(${id})`);
});
const components = module.__components;
assert.equal(typeof components.ExpertsTab, 'function');

const baseExpert = {
  id: 'lab-advisor',
  persona: 'Catalog persona',
  model: { provider: 'deepseek', model: 'deepseek-chat' },
  tools: ['dag_get'],
  triggers: ['node.completed'],
  mayVeto: false,
  level: 'branch',
  mayExecute: [],
  budget: { queriesPerRun: 4, tokensPerHour: 1000, wallClockMs: 60000 },
  lifecycle: { status: 'active' },
  metrics: { proposals: 2, completed: 1 },
  budgetUsage: { queryWindow: { maxPerRun: 4, limit: 12 }, tokenWindow: { lastHourTokens: 100, limit: 1000 } },
  override: null,
  overriddenFields: [],
  recentDecisions: [{ seq: 7, type: 'expert/updated', changedFields: ['persona'] }],
  lastUpdate: { seq: 7, type: 'expert/updated' },
};
const toolCatalog = [
  { name: 'dag_map', description: 'Read the DAG map.', readOnly: true },
  { name: 'dag_walk', description: 'Walk a subtree.', readOnly: true },
  { name: 'dag_get', description: 'Read one node.', readOnly: true },
  { name: 'dag_query', description: 'Query nodes.', readOnly: true },
  { name: 'ledger_read', description: 'Read the ledger.', readOnly: true },
  { name: 'intent_list', description: 'Read intents.', readOnly: true },
];
const triggerCatalog = [
  { name: 'node.completed', description: 'Node finished.' },
  { name: 'node.failed', description: 'Node failed.' },
  { name: 'low_water', description: 'Queue is low.' },
  { name: 'review.requested', description: 'Review requested.' },
  { name: 'escalation', description: 'Escalation fired.' },
  { name: 'branch.report', description: 'Branch report ready.' },
  { name: 'branch.event', description: 'Branch event.' },
  { name: 'interval:15m', description: 'Interval elapsed.' },
];
const templates = [
  { id: 'proposer', baseId: 'lab-advisor', mayPropose: ['proposal', 'priority', 'close'], mayCreate: true, mayVeto: false, schemaSource: 'lab-advisor', defaultLevel: 'lead', defaults: { model: { provider: 'deepseek', model: 'deepseek-chat' }, tools: ['dag_map', 'dag_query'], triggers: ['node.completed'], budget: { queriesPerRun: 2, tokensPerHour: 1000, wallClockMs: 60000 }, level: 'lead' } },
  { id: 'reviewer', baseId: 'lab-reviewer', mayPropose: ['review'], mayCreate: false, mayVeto: false, schemaSource: 'lab-reviewer', defaultLevel: 'branch', defaults: { model: { provider: 'deepseek', model: 'deepseek-chat' }, tools: ['dag_get'], triggers: ['review.requested'], budget: { queriesPerRun: 1, tokensPerHour: 1000, wallClockMs: 60000 }, level: 'branch' } },
];
let fetchMode = 'active';
const requests = [];
let commandPayload = null;
let fetchCount = 0;
globalThis.fetch = async (url, options = {}) => {
  const text = String(url);
  requests.push({ url: text, body: options.body });
  if (text.includes('/models')) {
    const payload = {
      ok: true,
      providers: [{ id: 'deepseek', name: 'deepseek', models: [{ id: 'deepseek-chat', name: 'deepseek-chat' }] }],
      options: [{ id: 'deepseek-chat', provider: 'deepseek', model: 'deepseek-chat', efforts: ['low', 'high'], defaultEffort: 'high', available: true }],
    };
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
  }
  if (text.includes('/experts')) {
    fetchCount += 1;
    const experts = fetchMode === 'empty'
      ? [{ ...baseExpert, lifecycle: { status: 'catalog' }, recentDecisions: [] }]
      : [baseExpert];
    const payload = { ok: true, experts, catalog: experts, custom: [], toolCatalog, triggerCatalog, templates, levels: ['branch', 'lead', 'chief'], curator: { status: 'ready' } };
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
  }
  if (text.includes('/command')) {
    commandPayload = JSON.parse(options.body ?? '{}');
    const payload = { ok: true, changed: true, event: { seq: 8, type: 'expert/updated' } };
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
  }
  throw new Error(`unexpected fetch ${text}`);
};

const t = (key, params = {}) => {
  const values = Object.entries(params).map(([name, value]) => `${name}=${value}`).join(',');
  return values === '' ? key : `${key}(${values})`;
};
const host = window.document.createElement('div');
window.document.body.appendChild(host);
const root = createRoot(host);
await React.act(async () => {
  root.render(React.createElement(components.ExpertsTab, { projectId: 'p1', t }));
  await wait(90);
});

check('the expert page renders the roster with lifecycle and budget metrics',
  host.querySelector('[data-testid="expert-card"]') !== null
  && host.textContent.includes('ws.experts.lifecycle.active')
  && host.textContent.includes('ws.experts.budgetUsage'));
check('drain copy explicitly preserves running nodes',
  host.querySelector('[data-testid="expert-drain-hint"]')?.textContent === 'ws.experts.drainHint');

const editButton = buttonByText(host, 'ws.experts.edit.open');
check('an active expert can open the project editor', editButton !== null);
await React.act(async () => {
  editButton.click();
  await wait(30);
});
check('the editor exposes the read-only mayExecute invariant',
  host.querySelector('[data-testid="expert-editor"]') !== null
  && host.querySelector('[data-testid="expert-may-execute-readonly"]')?.textContent === 'ws.experts.edit.readonly'
  && Array.from(host.querySelectorAll('input,textarea,select')).every((field) => field.getAttribute('aria-label') !== 'ws.experts.field.mayExecute'));

const persona = host.querySelector('textarea');
check('the editor starts with the effective persona', persona?.value === 'Catalog persona', persona?.value);
await React.act(async () => {
  setValue(persona, 'Project persona');
  await wait(25);
});
const diffText = host.querySelector('[data-testid="expert-editor-diff"]')?.textContent ?? '';
check('editing shows a before/after diff before save',
  diffText.includes('ws.experts.field.persona') && diffText.includes('Catalog persona') && diffText.includes('Project persona'), diffText);

check('provider, model and effort are rendered as selects, not free text',
  host.querySelector('select[aria-label="ws.model.provider"]') !== null
  && host.querySelector('select[aria-label="ws.model.model"]') !== null
  && host.querySelector('select[aria-label="ws.model.effort"]') !== null
  && host.querySelector('input[aria-label="ws.experts.field.provider"]') === null
  && host.querySelector('input[aria-label="ws.experts.field.effort"]') === null);
check('triggers are multi-select checkboxes with server-provided options',
  host.querySelector('[data-testid="expert-trigger-options"]') !== null
  && host.querySelector('input[aria-label="node.completed"]') !== null
  && host.querySelector('input[aria-label="ws.experts.field.triggers"]') === null);

const provider = host.querySelector('select[aria-label="ws.model.provider"]');
await React.act(async () => {
  setValue(provider, '');
  await wait(25);
});
check('invalid input is rejected with an inline error and a disabled save',
  host.querySelector('[data-testid="expert-editor-errors"]') !== null
  && host.querySelector('[data-testid="expert-editor-errors"]').textContent.includes('ws.experts.edit.error.model')
  && buttonByText(host, 'ws.experts.edit.save')?.disabled === true);

await React.act(async () => {
  setValue(provider, 'deepseek');
  await wait(25);
});
await React.act(async () => {
  const model = host.querySelector('select[aria-label="ws.model.model"]');
  if (model !== null) setValue(model, 'deepseek-chat');
  const effort = host.querySelector('select[aria-label="ws.model.effort"]');
  if (effort !== null) setValue(effort, 'high');
  await wait(25);
});
await React.act(async () => {
  buttonByText(host, 'ws.experts.edit.save').click();
  await wait(90);
});
check('save sends the project override payload and closes the editor',
  commandPayload?.type === 'expert_update'
  && commandPayload?.projectId === 'p1'
  && commandPayload?.expertId === 'lab-advisor'
  && commandPayload?.expert?.persona === 'Project persona'
  && commandPayload?.expert?.model?.provider === 'deepseek'
  && commandPayload?.expert?.mayExecute === undefined
  && host.querySelector('[data-testid="expert-editor"]') === null,
  JSON.stringify(commandPayload));
check('save reloads the roster and shows the event sequence',
  fetchCount >= 2 && host.textContent.includes('ws.experts.edit.saved'));

const rollback = buttonByText(host, 'ws.experts.edit.rollback');
check('a prior update exposes a rollback action', rollback !== null);
await React.act(async () => {
  rollback.click();
  await wait(80);
});
check('rollback names the traced update event',
  commandPayload?.type === 'expert_rollback' && commandPayload?.eventSeq === 7 && commandPayload?.expertId === 'lab-advisor',
  JSON.stringify(commandPayload));

fetchMode = 'empty';
await React.act(async () => {
  root.render(React.createElement(components.ExpertsTab, { projectId: 'p2', t }));
  await wait(90);
});
check('an empty roster gives an explicit next step instead of an empty table',
  host.querySelector('[data-testid="experts-empty-state"]')?.textContent.includes('ws.experts.empty.next'));

// jsdom form case: the create flow only offers server catalogs and controlled
// inputs; name -> slug, template capabilities and checkboxes all stay in sync.
const openCreate = buttonByText(host, 'ws.experts.create.open');
check('the empty expert page offers a create action', openCreate !== null);
await React.act(async () => {
  openCreate.click();
  await wait(40);
});
const createForm = host.querySelector('[data-testid="expert-create-form"]');
check('the create form is a real form with server-provided template/trigger options',
  createForm !== null
  && createForm.querySelector('select[aria-label="ws.experts.create.template"]')?.value === 'proposer'
  && createForm.querySelectorAll('[data-testid="expert-trigger-options"] input[type="checkbox"]').length >= 2
  && createForm.querySelector('input[aria-label="ws.experts.field.provider"]') === null);
check('creation is disabled until the required fields are valid',
  buttonByText(host, 'ws.experts.create.submit')?.disabled === true);

const createName = createForm.querySelector('input[aria-label="ws.experts.create.name"]');
const createPersona = createForm.querySelector('textarea[aria-label="ws.experts.field.persona"]');
await React.act(async () => {
  setValue(createName, 'Delta');
  setValue(createPersona, 'Delta persona for custom expert tests.');
  await wait(30);
});
const createId = createForm.querySelector('input[aria-label="ws.experts.create.id"]');
check('the slug is generated from the name and remains editable',
  createId?.value === 'custom:delta');
const triggerReview = createForm.querySelector('input[aria-label="review.requested"]');
await React.act(async () => {
  triggerReview.click();
  await wait(25);
});
check('trigger selection is a checkbox set, not a free-text field',
  triggerReview.checked === true
  && createForm.querySelector('input[aria-label="ws.experts.field.triggers"]') === null);
const createModel = createForm.querySelector('select[aria-label="ws.model.model"]');
const createEffort = createForm.querySelector('select[aria-label="ws.model.effort"]');
await React.act(async () => {
  if (createModel !== null) setValue(createModel, 'deepseek-chat');
  if (createEffort !== null) setValue(createEffort, 'high');
  await wait(25);
});
check('creation uses cascading model/effort selects backed by the catalog',
  createModel?.tagName === 'SELECT' && createEffort?.tagName === 'SELECT');
check('a valid create form enables submission',
  buttonByText(host, 'ws.experts.create.submit')?.disabled === false);

await React.act(async () => {
  buttonByText(host, 'ws.experts.create.submit').click();
  await wait(100);
});
check('create sends the template, slug and checkbox selections',
  commandPayload?.type === 'expert_create'
  && commandPayload?.expert?.template === 'proposer'
  && commandPayload?.expert?.id === 'custom:delta'
  && commandPayload?.expert?.name === 'Delta'
  && commandPayload?.expert?.tools?.includes('dag_map')
  && commandPayload?.expert?.tools?.includes('dag_query')
  && commandPayload?.expert?.triggers?.includes('node.completed')
  && commandPayload?.expert?.triggers?.includes('review.requested')
  && commandPayload?.expert?.model?.provider === 'deepseek'
  && commandPayload?.expert?.model?.model === 'deepseek-chat'
  && commandPayload?.expert?.model?.reasoningEffort === 'high'
  && commandPayload?.expert?.mayExecute === undefined,
  JSON.stringify(commandPayload));

if (failures.length > 0) {
  for (const failure of failures) process.stdout.write(`FAIL ${failure}\n`);
  process.exit(1);
}
process.stdout.write('expert-editor-selftest: all checks passed\n');
