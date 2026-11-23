#!/usr/bin/env node
/** Synthetic carrier; actual requestJson/components. No cookies or user effects. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import React from 'react';
import { createRoot } from 'react-dom/client';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.localStorage = window.localStorage;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.__METAINFER_TEST__ = true;
let reloads = 0;
globalThis.location = { reload() { reloads += 1; } };
const dictionary = JSON.parse(await readFile(new URL('../locale/zh.json', import.meta.url), 'utf8')).keys;
const t = (key) => dictionary[key] ?? key;
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
assert.equal(source.split('exported.__testing = {').length, 2, 'one private test export exists');
let factory;
window.__ModuleLoader__ = { load(value) { factory = value.factory; } };
// Expose existing private functions only in this in-memory test evaluation.
vm.runInThisContext(source.replace('exported.__testing = {', 'exported.__testing = { requestJson, operatorCredentialIssueOf, describeError,'), { filename: 'client.js' });
let fixture;
const response = (data, status = 200) => new Response(JSON.stringify(status === 200 ? { ok: true, data } : { ok: false, error: data }), { status });
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(String(url), 'http://localhost/').pathname;
  const method = options.method ?? 'GET';
  const headers = new Headers(options.headers);
  fixture.requests.push({ url: String(url), path, method, headers, cache: options.cache });
  if (path.endsWith('/operator/credential')) {
    if (fixture.gate) await fixture.gate;
    if (fixture.bootstrapError) throw new Error('synthetic transport unavailable');
    if (fixture.bootstrapResponse) return fixture.bootstrapResponse();
    if (fixture.bootstrapFailure) return response({ code: 'operator_browser_required', message: 'owner browser required' }, 403);
    return response({ token: fixture.token, issuedAt: fixture.issuedAt });
  }
  if (path.endsWith('/health')) return response({ operatorIssuedAt: fixture.issuedAt });
  if (path.endsWith('/disputes') && fixture.rowsFailure) return response({ code: 'read_failed', message: 'dispute rows unavailable' }, 503);
  if (path.endsWith('/disputes')) return response({ disputes: [{ id: 'synthetic-dispute', source: 'dispute', status: 'pending', type: 'fact_conflict', target: {} }] });
  if (path.endsWith('/disputes/classes')) return response({ classes: { fact_conflict: {} } });
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) || path.endsWith('/dashboard')) {
    if (fixture.operationFailure) return response(fixture.operationFailure, fixture.operationStatus ?? 403);
    if (headers.get('x-metainfer-operator') !== fixture.token) return response({ code: 'operator_invalid', message: 'invalid browser credential' }, 401);
  }
  return response({ accepted: true });
};
function reset() {
  for (const target of [globalThis, window]) {
    delete target.__METAINFER_OPERATOR_TOKEN__;
    delete target.__METAINFER_OPERATOR_ISSUED_AT__;
  }
  window.localStorage.clear(); window.sessionStorage.clear(); reloads = 0;
  fixture = { token: 'synthetic-current-authority', issuedAt: 1700000000, requests: [] };
}
function client() {
  const module = factory((id) => { if (id === 'react') return React; throw new Error(`unexpected require ${id}`); });
  const disposers = []; const noop = () => {};
  return { ...module,
    applyNow() {
      module.apply({ effect(fn) { const result = fn(); if (typeof result === 'function') disposers.push(result); return noop; },
        locale: { register: () => noop, bind: () => t }, slots: { inject: () => noop, register: () => ({}) },
        sessions: {}, uiWorkspace: {}, layout: {}, sidebarRight: {} });
    },
    dispose() { for (const fn of disposers.splice(0).reverse()) fn(); },
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const credentialCalls = () => fixture.requests.filter((row) => row.path.endsWith('/operator/credential'));
const writes = () => fixture.requests.filter((row) => !['GET', 'HEAD', 'OPTIONS'].includes(row.method));
const write = (module, method = 'POST') => module.__testing.requestJson('api/metainfer-research-lab/commands', { method, body: { action: 'synthetic-no-op' } }, t);
async function mount(module, name, props = {}) {
  const host = window.document.createElement('div'); window.document.body.appendChild(host); const root = createRoot(host);
  await React.act(async () => { root.render(React.createElement(module.__components[name], { t, projectId: 'synthetic-project', ...props })); await flush(); });
  return { host, async close() { await React.act(async () => root.unmount()); host.remove(); } };
}
let checks = 0; const failures = [];
function check(name, condition) { checks += 1; if (condition) console.log(`ok   ${name}`); else { failures.push(name); console.log(`FAIL ${name}`); } }
async function scenario(name, run) { reset(); try { await run(); } catch (error) { check(`${name}: unexpected ${error?.name ?? 'error'}`, false); } }
await scenario('fresh owner', async () => {
  const module = client(); const result = await write(module).catch(() => null);
  check('fresh owner without any injected token bootstraps before its write', result?.accepted === true && credentialCalls().length === 1 && writes().length === 1);
  const bootstrap = credentialCalls()[0];
  check('bootstrap uses relative route, bootstrap header and no-store', bootstrap?.url === 'api/metainfer-research-lab/operator/credential' && bootstrap?.headers.get('x-metainfer-bootstrap') === '1' && bootstrap?.cache === 'no-store');
  check('bootstrap has no operator-token precondition', bootstrap !== undefined && !bootstrap.headers.has('x-metainfer-operator'));
  check('credentials are not persisted or placed in URLs', window.localStorage.length === 0 && window.sessionStorage.length === 0 && fixture.requests.every((row) => !row.url.includes(fixture.token)));
});
await scenario('late activation and same-second apply', async () => {
  // Explicit stale-token negative fixture, never used to claim fresh success.
  globalThis.__METAINFER_OPERATOR_TOKEN__ = 'synthetic-old-authority'; globalThis.__METAINFER_OPERATOR_ISSUED_AT__ = String(fixture.issuedAt);
  const module = client(); module.applyNow(); await flush(); const late = await write(module).catch(() => null);
  check('late activation replaces old token even when issuedAt is unchanged', late?.accepted === true && writes().at(-1)?.headers.get('x-metainfer-operator') === fixture.token);
  fixture.token = 'synthetic-rotated-same-second'; module.applyNow(); await flush(); const reapplied = await write(module).catch(() => null);
  check('reapply and same-second rotation never reuse old authority', reapplied?.accepted === true && writes().at(-1)?.headers.get('x-metainfer-operator') === fixture.token); module.dispose();
});
await scenario('coalescing', async () => {
  const module = client(); let release; fixture.gate = new Promise((resolve) => { release = resolve; });
  const pending = Promise.allSettled([write(module), write(module)]); await flush();
  check('simultaneous protected requests share one in-flight bootstrap', credentialCalls().length === 1 && writes().length === 0);
  release(); const outcomes = await pending;
  check('both user requests execute once after shared bootstrap settles', outcomes.every((row) => row.status === 'fulfilled') && writes().length === 2);
  fixture.gate = null; fixture.token = 'synthetic-next-request-authority'; const result = await write(module).catch(() => null);
  check('settled bootstrap is not a long-lived credential cache', result?.accepted === true && credentialCalls().length === 2 && writes().length === 3);
});
await scenario('write methods and dashboard', async () => {
  const module = client(); const outcomes = [];
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) outcomes.push(await write(module, method).catch(() => null));
  const dashboard = await module.__testing.requestJson('api/metainfer-research-lab/dashboard?projectId=synthetic-project', {}, t).catch(() => null);
  check('all non-safe methods and mutating GET/dashboard fetch current credentials', outcomes.every((value) => value?.accepted) && dashboard?.accepted && credentialCalls().length === 5);
  check('request method is preserved for PUT/PATCH/DELETE', writes().map((row) => row.method).join(',') === 'POST,PUT,PATCH,DELETE');
});
await scenario('ordinary read', async () => {
  const module = client(); fixture.bootstrapFailure = true; const health = await module.__testing.requestJson('api/metainfer-research-lab/health', {}, t);
  check('ordinary read-only GET is never blocked by bootstrap denial', health.operatorIssuedAt === fixture.issuedAt && credentialCalls().length === 0);
});
await scenario('persistent failure and remount', async () => {
  const module = client(); fixture.bootstrapFailure = true; fixture.operationFailure = { code: 'operator_invalid', message: 'invalid browser credential' }; fixture.operationStatus = 401;
  const now = Date.now;
  try {
    Date.now = () => 1700000000000; let banner = await mount(module, 'OperatorCredentialBanner');
    await React.act(async () => { await write(module).catch(() => {}); await flush(); });
    check('failure shows localized retry without stale-page speculation', banner.host.textContent.includes(t('ws.operator.missing')) && Boolean([...banner.host.querySelectorAll('button')].find((button) => button.textContent === t('common.retry'))) && !banner.host.textContent.includes('多半') && !banner.host.textContent.includes('probably'));
    await banner.close(); Date.now = () => 1700000010001; banner = await mount(module, 'OperatorCredentialBanner');
    await React.act(async () => { await write(module).catch(() => {}); await flush(); }); await banner.close();
    check('persistent failure across 10000ms and remount never auto-reloads', reloads === 0);
    check('bootstrap rejection sends no protected operation', writes().length === 0);
    check('credential rejection clears transient compatibility token', !globalThis.__METAINFER_OPERATOR_TOKEN__);
  } finally { Date.now = now; }
});
await scenario('generic forbidden', async () => {
  const module = client(); fixture.operationFailure = { code: 'budget_exhausted', message: 'budget exhausted' }; const error = await write(module).then(() => null, (reason) => reason);
  check('generic 403 is not classified as expired credential', error?.code === 'budget_exhausted' && module.__testing.operatorCredentialIssueOf(error) === false);
  check('generic 403 keeps operation-specific message', module.__testing.describeError(error, t) === 'budget exhausted');
  check('generic 403 neither auto-reloads nor replays operation', reloads === 0 && writes().length === 1);
  check('generic 403 does not discard a successfully acquired compatibility token', globalThis.__METAINFER_OPERATOR_TOKEN__ === fixture.token);
});
await scenario('explicit retry never replays a failed operation', async () => {
  const module = client(); fixture.bootstrapFailure = true;
  const banner = await mount(module, 'OperatorCredentialBanner');
  await React.act(async () => { await write(module).catch(() => {}); await flush(); });
  const before = writes().length; fixture.bootstrapFailure = false;
  const retry = [...banner.host.querySelectorAll('button')].find((button) => button.textContent === t('common.retry'));
  await React.act(async () => { retry?.click(); await flush(); });
  check('explicit credential Retry recovers without replaying previous protected operation', retry !== undefined && writes().length === before && globalThis.__METAINFER_OPERATOR_TOKEN__ === fixture.token && banner.host.querySelector('[data-testid="operator-credential-banner"]') === null);
  await banner.close();
});
await scenario('no automatic replay', async () => {
  const module = client(); fixture.operationFailure = { code: 'operator_invalid', message: 'rotated during operation' }; fixture.operationStatus = 401;
  await write(module).catch(() => {}); await flush();
  check('rejected POST is never automatically replayed or refreshed', writes().length === 1 && credentialCalls().length === 1 && reloads === 0);
  const before = fixture.requests.length; await module.__testing.requestJson('api/metainfer-research-lab/dashboard?projectId=synthetic-project', {}, t).catch(() => {}); const after = fixture.requests.slice(before);
  check('rejected mutating GET/dashboard is never replayed', after.filter((row) => row.path.endsWith('/dashboard')).length === 1 && after.filter((row) => row.path.endsWith('/operator/credential')).length === 1 && reloads === 0);
});
await scenario('abort does not dispatch an unrequested write', async () => {
  const module = client(); const controller = new AbortController(); controller.abort();
  const error = await module.__testing.requestJson('api/metainfer-research-lab/commands', { method: 'POST', signal: controller.signal }, t).then(() => null, (reason) => reason);
  check('an already-aborted protected request sends neither bootstrap nor write', error?.name === 'AbortError' && fixture.requests.length === 0);
});
await scenario('one aborted caller cannot cancel shared acquisition', async () => {
  const module = client(); const controller = new AbortController(); let release;
  fixture.gate = new Promise((resolve) => { release = resolve; });
  const aborted = module.__testing.requestJson('api/metainfer-research-lab/commands', { method: 'POST', signal: controller.signal }, t);
  const pending = Promise.allSettled([aborted, write(module)]); await flush(); controller.abort(); release();
  const outcomes = await pending;
  check('cancelling one waiter skips only its write while shared bootstrap completes', outcomes[0].status === 'rejected' && outcomes[0].reason.name === 'AbortError' && outcomes[1].status === 'fulfilled' && credentialCalls().length === 1 && writes().length === 1);
});
await scenario('denied acquisition is not cached', async () => {
  const module = client(); fixture.bootstrapFailure = true; await write(module).catch(() => {});
  fixture.bootstrapFailure = false; const result = await write(module).catch(() => null);
  check('a settled bootstrap failure can be retried by the next explicit operation', result?.accepted && credentialCalls().length === 2 && writes().length === 1);
});
await scenario('invalid bootstrap and transport never authorize a write', async () => {
  const module = client();
  const malformed = [
    ['non-JSON response', () => new Response('not json', { status: 200 })],
    ['empty token', () => response({ token: '', issuedAt: fixture.issuedAt })],
    ['missing issuedAt', () => response({ token: 'synthetic-incomplete-authority' })],
  ];
  for (const [name, value] of malformed) {
    fixture.bootstrapResponse = value; globalThis.__METAINFER_OPERATOR_TOKEN__ = 'synthetic-stale-authority';
    const error = await write(module).then(() => null, (reason) => reason);
    check('malformed bootstrap (' + name + ') fails closed and clears compatibility values', error?.code === 'operator_unavailable' && !globalThis.__METAINFER_OPERATOR_TOKEN__ && writes().length === 0);
  }
  fixture.bootstrapResponse = null; fixture.bootstrapError = true;
  const error = await write(module).then(() => null, (reason) => reason);
  check('bootstrap transport failure is localizable, non-replaying and non-reloading', error?.code === 'operator_unavailable' && module.__testing.describeError(error, t).includes(t('ws.operator.missing')) && writes().length === 0 && reloads === 0);
});
await scenario('mounted dashboard never polls a rejected mutating GET', async () => {
  const module = client(); fixture.operationFailure = { code: 'operator_invalid', message: 'rotated during dashboard GET' }; fixture.operationStatus = 401;
  const realSetTimeout = globalThis.setTimeout; const realClearTimeout = globalThis.clearTimeout; const scheduled = [];
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay === 5000) { const timer = { dashboardTimer: true, callback }; scheduled.push(timer); return timer; }
    return realSetTimeout(callback, delay, ...args);
  };
  globalThis.clearTimeout = (timer) => { if (!timer?.dashboardTimer) realClearTimeout(timer); };
  let dashboard; let banner;
  try {
    dashboard = await mount(module, 'DashboardPanel', { open: true });
    check('DashboardPanel schedules no automatic replay after a rejected mutating GET', fixture.requests.filter((row) => row.path.endsWith('/dashboard')).length === 1 && scheduled.length === 0);
    fixture.operationFailure = null;
    banner = await mount(module, 'OperatorCredentialBanner');
    check('credential readiness cannot restart the failed DashboardPanel operation', fixture.requests.filter((row) => row.path.endsWith('/dashboard')).length === 1 && scheduled.length === 0);
  } finally {
    if (banner) await banner.close(); if (dashboard) await dashboard.close();
    globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout;
  }
});
await scenario('mounted dispute recovers only its credential error without replay', async () => {
  const module = client(); const banner = await mount(module, 'OperatorCredentialBanner'); const disputes = await mount(module, 'DisputeTablePanel');
  const keepCurrent = () => [...disputes.host.querySelectorAll('button')].find((button) => button.textContent === 'Keep current');
  fixture.operationFailure = { code: 'operator_invalid', message: 'rotated during dispute action' }; fixture.operationStatus = 401;
  await React.act(async () => { keepCurrent()?.click(); await flush(); });
  check('a rejected dispute write keeps already-loaded rows readable', disputes.host.querySelectorAll('.rl-log-row').length === 1);
  check('a credential-rejected dispute hides only write controls until readiness', !keepCurrent() && banner.host.querySelector('[data-testid="operator-credential-banner"]') !== null);
  const beforeWrites = writes().length; const beforeReads = fixture.requests.filter((row) => row.path.endsWith('/disputes')).length;
  fixture.operationFailure = null;
  const retry = [...banner.host.querySelectorAll('button')].find((button) => button.textContent === t('common.retry'));
  await React.act(async () => { retry?.click(); await flush(); });
  check('Banner Retry restores already-mounted dispute controls and clears only its credential error', Boolean(keepCurrent()) && disputes.host.querySelector('[role="alert"]') === null && banner.host.querySelector('[data-testid="operator-credential-banner"]') === null);
  check('credential recovery never replays the dispute write or forces a read retry', beforeWrites === 1 && writes().length === beforeWrites && fixture.requests.filter((row) => row.path.endsWith('/disputes')).length === beforeReads);
  await disputes.close(); await banner.close();
});
await scenario('mounted dispute business failure survives credential readiness', async () => {
  const module = client(); const banner = await mount(module, 'OperatorCredentialBanner'); const disputes = await mount(module, 'DisputeTablePanel');
  const keepCurrent = () => [...disputes.host.querySelectorAll('button')].find((button) => button.textContent === 'Keep current');
  fixture.operationFailure = { code: 'budget_exhausted', message: 'budget exhausted for this dispute' }; fixture.operationStatus = 403;
  await React.act(async () => { keepCurrent()?.click(); await flush(); });
  check('a generic dispute operation failure does not hide loaded rows or authorized controls', disputes.host.querySelectorAll('.rl-log-row').length === 1 && Boolean(keepCurrent()));
  await React.act(async () => { module.applyNow(); await flush(); });
  check('a later ready event preserves the generic dispute business error', disputes.host.querySelector('[role="alert"]')?.textContent === 'budget exhausted for this dispute' && writes().length === 1);
  await disputes.close(); await banner.close(); module.dispose();
});
await scenario('read failure remains distinct from dispute operation recovery', async () => {
  const module = client(); const disputes = await mount(module, 'DisputeTablePanel'); fixture.rowsFailure = true;
  const retryRead = [...disputes.host.querySelectorAll('button')].find((button) => button.textContent === 'Retry');
  await React.act(async () => { retryRead?.click(); await flush(); module.applyNow(); await flush(); });
  check('a failed rows read hides cached dispute rows even after credential readiness', disputes.host.querySelectorAll('.rl-log-row').length === 0 && disputes.host.querySelector('[role="alert"]')?.textContent === 'dispute rows unavailable' && !disputes.host.textContent.includes('Keep current'));
  await disputes.close(); module.dispose();
});
await scenario('ready events update mounted UI', async () => {
  const module = client(); let release; fixture.gate = new Promise((resolve) => { release = resolve; });
  const banner = await mount(module, 'OperatorCredentialBanner'); const disputes = await mount(module, 'DisputeTablePanel');
  check('dispute controls wait for credential readiness', !disputes.host.textContent.includes('Keep current'));
  module.applyNow(); await flush(); await React.act(async () => { release(); await write(module).catch(() => {}); await flush(); });
  check('ready event removes already-mounted credential banner', banner.host.querySelector('[data-testid="operator-credential-banner"]') === null);
  check('ready event enables already-mounted dispute controls without parent poll', disputes.host.textContent.includes('Keep current'));
  await banner.close(); await disputes.close(); module.dispose();
});
window.close(); console.log(`\noperator-bootstrap-ui-selftest: ${checks - failures.length}/${checks} passed; ${failures.length} failed`);
if (failures.length > 0) process.exitCode = 1;
