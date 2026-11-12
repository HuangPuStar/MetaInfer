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
  const proto = element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value);
  element.dispatchEvent(new window.Event('input', { bubbles: true }));
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
let fetchMode = 'active';
const requests = [];
let commandPayload = null;
let fetchCount = 0;
globalThis.fetch = async (url, options = {}) => {
  const text = String(url);
  requests.push({ url: text, body: options.body });
  if (text.includes('/experts')) {
    fetchCount += 1;
    const experts = fetchMode === 'empty'
      ? [{ ...baseExpert, lifecycle: { status: 'catalog' }, recentDecisions: [] }]
      : [baseExpert];
    const payload = { ok: true, experts, curator: { status: 'ready' } };
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

const provider = Array.from(host.querySelectorAll('input')).find((input) => input.getAttribute('aria-label') === 'ws.experts.field.provider');
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

if (failures.length > 0) {
  for (const failure of failures) process.stdout.write(`FAIL ${failure}\n`);
  process.exit(1);
}
process.stdout.write('expert-editor-selftest: all checks passed\n');
