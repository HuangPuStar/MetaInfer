#!/usr/bin/env node
/**
 * Operator path through real HTTP routes and LabService. The browser obtains
 * its token from bootstrap, then the DisputeTable sends it through the real
 * resolve route. Only the carrier/admission registry and in-memory domain are
 * fixtures; this is not a real Desktop connection or a user-project mutation.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { openStore } from '../host/store.js';
import { createKernel } from '../host/kernel/instance.js';
import { createLabService } from '../host/lab-service.js';
import { registerHttpRoutes } from '../host/http.js';
import { createOperatorAuthority } from '../host/operator-token.js';
import { memoryDomain, storeContext } from './lib/memory-domain.mjs';

let failed = 0;
let checks = 0;
function check(name, condition, detail = '') {
  checks += 1;
  if (condition) console.log(`ok   ${name}`);
  else { failed += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const authority = createOperatorAuthority();
check('operator authority mints a verifiable token', authority.verify(authority.token).ok === true);
check('operator authority rejects a forged token',
  authority.verify(authority.token.replace(/.$/, (char) => (char === 'A' ? 'B' : 'A'))).ok === false);
check('operator authority rejects an absent token', authority.verify('').ok === false);

const domain = memoryDomain();
const store = await openStore(storeContext(domain));
const kernel = createKernel({ store });
const projectId = 'operator-ui-p';
await store.saveProject({ id: projectId, revision: 0, counters: { eventSeq: 0 }, config: {}, createdAt: 0, updatedAt: 0 });
kernel.load(projectId);
await kernel.executor.commit(projectId, {
  actor: { kind: 'human', id: 'setup' },
  mutations: [{ op: 'node.create', node: { id: 'root', title: 'root', status: 'completed', timestamps: { createdAt: 1, completedAt: 2 } } }],
});
const service = createLabService({
  ctx: { effect: () => {}, get: () => null, logger: { info() {}, warn() {} } },
  store, kernel, git: null, runtime: null, transcript: null, orchestrator: null,
  auto: { statusOf: () => ({ status: 'off', pauseReason: null }) }, cluster: null, clusterAdmin: null,
  operatorAuthority: authority,
});
const health = await service.health();
check('health exposes the operator issue time without the token',
  health.operatorIssuedAt === authority.issuedAt && !JSON.stringify(health).includes(authority.token),
  JSON.stringify({ health: health.operatorIssuedAt, authority: authority.issuedAt }));
const raiser = { agent: { session: { id: 'operator-ui-raiser' } } };
const opened = await service.openDispute(projectId, {
  type: 'resource_quantity',
  target: { nodeId: 'root', action: 'resize' },
  rationale: 'token path probe',
  evidence: [{ nodeId: 'root', field: 'needs.gpu' }],
}, raiser);
assert.equal(opened.ok, true, JSON.stringify(opened));

const routes = [];
const browserPeer = { principal: { kind: 'owner' } };
let browserAllowed = false;
const disposeRoutes = registerHttpRoutes({
  connection: {
    browserPeer,
    admit() { return browserAllowed ? { peer: browserPeer } : { rejection: 403 }; },
    fetch: { register(route) { routes.push(route); return () => Promise.resolve(); } },
  },
}, service, { operatorAuthority: authority });

const requests = [];
globalThis.fetch = async (url, init = {}) => {
  const parsed = new URL(String(url), 'http://localhost');
  requests.push({ path: parsed.pathname, method: init.method ?? 'GET', headers: { ...(init.headers ?? {}) } });
  const route = routes.find((candidate) => candidate.path === parsed.pathname && candidate.methods.includes(init.method ?? 'GET'));
  if (!route) return new Response(JSON.stringify({ ok: false, error: { code: 'not_found', message: parsed.pathname } }), { status: 404 });
  const headers = { ...(init.headers ?? {}) };
  return route.fetch(new Request('http://localhost' + parsed.pathname + parsed.search, {
    method: init.method ?? 'GET',
    headers,
    body: init.body,
  }));
};

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
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
window.__METAINFER_TEST__ = true;

let factory = null;
window.__ModuleLoader__ = { load({ factory: captured }) { factory = captured; } };
await import('../client.js?operator-ui-selftest=1');
assert.equal(typeof factory, 'function', 'client factory was not registered');
const module = factory((id) => {
  if (id === 'react') return React;
  throw new Error(`unexpected require(${id})`);
});
const components = module.__components;
assert.equal(typeof components.DisputeTablePanel, 'function', 'DisputeTablePanel is exported');
const noop = () => {};
module.apply({
  effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : noop; },
  locale: { register() { return noop; }, bind() { return (key) => key; } },
  slots: { inject() { return noop; }, register(config, component) { return { config, component }; } },
  sessions: {}, uiWorkspace: {}, layout: {}, sidebarRight: {},
});
const dictionary = JSON.parse(await readFile(new URL('../locale/zh.json', import.meta.url), 'utf8')).keys;
const t = (key) => dictionary[key] ?? key;
const base = { t, projectId, nodes: [], edges: [], resources: {}, revision: 1 };

class Boundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch() {}
  render() {
    if (this.state.error !== null) return React.createElement('div', { 'data-crash': 'true' }, String(this.state.error?.message ?? this.state.error));
    return this.props.children;
  }
}

async function mountBanner(t) {
  const host = window.document.createElement('div');
  window.document.body.appendChild(host);
  const root = createRoot(host);
  await React.act(async () => {
    root.render(React.createElement(Boundary, null, React.createElement(components.OperatorCredentialBanner, { t })));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return { host, root };
}

async function mount() {
  const host = window.document.createElement('div');
  window.document.body.appendChild(host);
  const root = createRoot(host);
  await React.act(async () => {
    root.render(React.createElement(Boundary, null, React.createElement(components.DisputeTablePanel, base)));
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
  return { host, root };
}

// Bootstrap denial hides controls but preserves readable dispute content.
delete globalThis.__METAINFER_OPERATOR_TOKEN__;
{
  const view = await mount();
  const text = view.host.textContent ?? '';
  check('bootstrap denial hides dispute controls with a localized explanation',
    !text.includes('Keep current') && !text.includes('Apply change')
    && text.includes(t('ws.operator.missing')), text.slice(0, 700));
  await React.act(async () => view.root.unmount());
  view.host.remove();
  const banner = await mountBanner(t);
  const bannerBody = banner.host.textContent ?? '';
  check('the persistent localized banner offers Retry and manual Reload',
    bannerBody.includes(t('ws.operator.missing')) && bannerBody.includes(t('common.retry'))
    && bannerBody.includes(t('ws.operator.reload'))
    && banner.host.querySelector('[data-testid="operator-credential-banner"]') !== null,
    bannerBody.slice(0, 700));
  await React.act(async () => banner.root.unmount());
  banner.host.remove();
}

// Stale compatibility values are never an authority or an automatic reload
// trigger. Persistent failure beyond the former cooldown still cannot reload.
{
  const savedLocation = globalThis.location;
  const savedNow = Date.now;
  let reloads = 0;
  globalThis.location = { reload: () => { reloads += 1; } };
  globalThis.__METAINFER_OPERATOR_TOKEN__ = 'synthetic-old-authority';
  globalThis.__METAINFER_OPERATOR_ISSUED_AT__ = String(authority.issuedAt);
  Date.now = () => 1700000000000;
  const stale = await mountBanner(t);
  check('a rejected stale compatibility credential never triggers reload',
    reloads === 0 && !globalThis.__METAINFER_OPERATOR_TOKEN__
    && (stale.host.textContent ?? '').includes(t('ws.operator.missing')));
  await React.act(async () => stale.root.unmount());
  stale.host.remove();
  Date.now = () => 1700000010001;
  const retry = await mountBanner(t);
  check('failure after 10000ms and remount remains visible without reload or storage markers',
    reloads === 0 && retry.host.querySelector('[data-testid="operator-credential-banner"]') !== null
    && window.sessionStorage.getItem('metainfer:operator-reload') === null);
  await React.act(async () => retry.root.unmount());
  retry.host.remove();
  Date.now = savedNow;
  if (savedLocation === undefined) delete globalThis.location;
  else globalThis.location = savedLocation;
}

// Successful bootstrap, with no hand-seeded token, enables a real route click.
for (const target of [globalThis, window]) {
  delete target.__METAINFER_OPERATOR_TOKEN__;
  delete target.__METAINFER_OPERATOR_ISSUED_AT__;
}
browserAllowed = true;
const beforeButtons = requests.length;
{
  const view = await mount();
  const text = view.host.textContent ?? '';
  check('successful bootstrap without a global token enables dispute controls', text.includes('Keep current'), text.slice(0, 700));
  const button = [...view.host.querySelectorAll('button')].find((candidate) => (candidate.textContent ?? '').includes('Keep current'));
  check('the Keep current control exists', Boolean(button));
  if (button) {
    await React.act(async () => { button.click(); await new Promise((resolve) => setTimeout(resolve, 100)); });
  }
  const bootstrap = requests.slice(beforeButtons).filter((request) => request.path.endsWith('/operator/credential'));
  check('the UI obtains a fresh credential through the real owner-bootstrap route',
    bootstrap.length >= 2 && bootstrap.every((request) => request.headers['x-metainfer-bootstrap'] === '1'));
  check('bootstrap never requires the old operator header', bootstrap.every((request) => !request.headers['x-metainfer-operator']));
  const actions = requests.slice(beforeButtons).filter((request) => request.path.endsWith('/arbitrate') && request.method === 'POST');
  const listed = service.listDisputes(projectId);
  const record = listed.disputes.find((row) => row.id === opened.dispute.id);
  check('clicking Keep current sends a real POST with the operator header',
    actions.length === 1 && actions[0].headers['x-metainfer-operator'] === authority.token,
    JSON.stringify({ actions: actions.length }));
  check('the real service resolves the dispute and records the operator actor',
    record?.status === 'resolved' && record?.resolution === 'keep_current' && record?.resolvedBy?.id === 'operator',
    JSON.stringify(record));
  check('the rendered row reports the resolved state instead of an error',
    (view.host.textContent ?? '').includes('resolved') && (view.host.textContent ?? '').includes('by operator')
    && !(view.host.textContent ?? '').includes('actor_required'),
    (view.host.textContent ?? '').slice(0, 900));
  await React.act(async () => view.root.unmount());
  view.host.remove();
}

// A forged body without the operator header stays rejected; and it must not
// mutate the newly opened dispute.
const second = await service.openDispute(projectId, {
  type: 'fact_conflict', target: { nodeId: 'root' }, rationale: 'forged body probe',
}, { agent: { session: { id: 'operator-ui-second-raiser' } } });
assert.equal(second.ok, true, JSON.stringify(second));
const resolveRoute = routes.find((route) => route.path.endsWith('/disputes/resolve'));
const forgedResponse = await resolveRoute.fetch(new Request('http://localhost/api/metainfer-research-lab/disputes/resolve', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    projectId,
    disputeId: second.dispute.id,
    resolution: 'apply_change',
    reason: 'forged body must not authenticate',
    agentPreset: 'operator',
    actorKey: 'forged',
  }),
}));
const forged = await forgedResponse.json();
const afterForged = service.listDisputes(projectId).disputes.find((row) => row.id === second.dispute.id);
check('a forged body without the operator header is rejected and mutates nothing',
  forged.ok === false && forged.error?.code === 'actor_required' && afterForged?.status === 'pending',
  JSON.stringify(forged));

disposeRoutes();
await store.close();
if (failed > 0) {
  console.error(`operator-ui-selftest: ${failed} check(s) failed`);
  process.exit(1);
}
window.close();
console.log(`operator-ui-selftest: all ${checks} checks passed`);
