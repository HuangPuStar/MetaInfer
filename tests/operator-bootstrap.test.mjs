import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperatorTestHost } from '../scripts/lib/operator-test-host.mjs';

const URL = 'http://localhost/api/metainfer-research-lab/operator/credential';
const options = { headers: { 'x-metainfer-bootstrap': '1' } };
const P = 'http://localhost/api/metainfer-research-lab';

test('actual index activation acquires credentials without index globals or webServer', async () => {
  const host = await createOperatorTestHost();
  try {
    const response = await host.request(URL, options);
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.ok, true);
    assert.equal(host.service.verifyOperatorToken(value.data.token).ok, true);
    assert.equal(Number.isFinite(value.data.issuedAt), true);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const health = await host.service.health();
    assert.equal(JSON.stringify(health).includes(value.data.token), false);
  } finally { await host.close(); }
});

test('bootstrap requires an explicit custom header even for a browser owner', async () => {
  const host = await createOperatorTestHost();
  try {
    const response = await host.request(URL);
    assert.equal(response.status, 403);
    const value = await response.json();
    assert.equal(value.ok, false);
    assert.equal(value.data?.token, undefined);
  } finally { await host.close(); }
});

for (const mode of ['anonymous', 'untrusted', 'guest', 'api']) {
  test('bootstrap refuses ' + mode + ' admission, not merely owner kind', async () => {
    const host = await createOperatorTestHost();
    try {
      host.setMode(mode);
      const response = await host.request(URL + '?token=forged&owner=true', {
        headers: { ...options.headers, 'x-metainfer-operator': 'forged', 'x-owner': 'true' },
      });
      assert.equal([401, 403].includes(response.status), true);
      const value = await response.json();
      assert.equal(value.ok, false);
      assert.equal(value.data?.token, undefined);
    } finally { await host.close(); }
  });
}

test('missing browser admission contract fails closed', async () => {
  const host = await createOperatorTestHost();
  try {
    delete host.connection.admit;
    const response = await host.request(URL, options);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).ok, false);
  } finally { await host.close(); }
});

test('bootstrap does not remove missing/forged mutation gates or replay writes', async () => {
  const host = await createOperatorTestHost();
  try {
    let calls = 0;
    host.service.prepareRepo = async () => { calls += 1; return { prepared: 'inert' }; };
    const post = (token) => host.request(P + '/repo/prepare', {
      method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-metainfer-operator': token } : {}) },
      body: JSON.stringify({ repoPath: 'inert', actor: { kind: 'human', id: 'forged' } }),
    });
    assert.equal((await (await post()).json()).error.code, 'actor_required');
    assert.equal((await (await post('forged')).json()).error.code, 'actor_required');
    assert.equal(calls, 0);
    const boot = await (await host.request(URL, options)).json();
    assert.equal(boot.ok, true);
    assert.equal((await (await post(boot.data.token)).json()).ok, true);
    assert.equal(calls, 1);
    host.setMode('api');
    const denied = await (await host.request(URL, { headers: { ...options.headers, 'x-metainfer-operator': boot.data.token } })).json();
    assert.equal(denied.ok, false);
    assert.equal(denied.data?.token, undefined);
  } finally { await host.close(); }
});

test('same-second reapply returns current authority independent of a retained Desktop snapshot', async () => {
  const fixedNow = 1763100000123;
  const first = await createOperatorTestHost({ fixedNow });
  let second;
  try {
    const old = await (await first.request(URL, options)).json();
    assert.equal(old.ok, true);
    second = await createOperatorTestHost({ fixedNow });
    const current = await (await second.request(URL, options)).json();
    assert.equal(current.ok, true);
    assert.equal(current.data.issuedAt, old.data.issuedAt);
    assert.notEqual(current.data.token, old.data.token);
    assert.equal(second.service.verifyOperatorToken(old.data.token).ok, false);
    assert.equal(second.service.verifyOperatorToken(current.data.token).ok, true);
  } finally { if (second) await second.close(); await first.close(); }
});


test('fresh actual index and actual Wizard prepare local and remote inputs without injected globals', async () => {
  const { JSDOM } = await import('jsdom');
  const { readFile } = await import('node:fs/promises');
  const { pathToFileURL } = await import('node:url');
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
  const names = ['window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'Node', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT', 'CustomEvent', 'fetch', '__METAINFER_OPERATOR_TOKEN__', '__METAINFER_OPERATOR_ISSUED_AT__'];
  const originals = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const host = await createOperatorTestHost();
  let root;
  let React;
  try {
    for (const [name, value] of Object.entries({
      window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
      localStorage: dom.window.localStorage, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
      getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: fn => setTimeout(fn, 0),
      cancelAnimationFrame: id => clearTimeout(id), IS_REACT_ACT_ENVIRONMENT: true, CustomEvent: dom.window.CustomEvent,
    })) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    delete globalThis.__METAINFER_OPERATOR_TOKEN__;
    delete globalThis.__METAINFER_OPERATOR_ISSUED_AT__;
    dom.window.__METAINFER_TEST__ = true;
    // Old-source RED comparison only: suppress its actual jsdom navigation;
    // reload-loop behavior is independently covered by the virtual-clock suite.
    if (process.env.MIRL_TEST_CLIENT_SOURCE) dom.window.sessionStorage.setItem('metainfer:operator-reload', String(Date.now()));
    React = (await import('react')).default;
    const { createRoot } = await import('react-dom/client');
    const dictionary = JSON.parse(await readFile(new globalThis.URL('../locale/zh.json', import.meta.url), 'utf8')).keys;
    const t = (key, params = {}) => Object.entries(params).reduce((text, [name, value]) => text.split('{' + name + '}').join(String(value)), dictionary[key] ?? key);
    const prepared = [];
    host.service.prepareRepo = async (input) => {
      prepared.push(input.repoPath);
      return { repoRoot: 'D:/inert-prepared', gitDir: 'D:/inert-prepared/.git', branches: ['main'], defaultBranch: 'main', baseCommit: 'abcdef1234567', dirty: false, prepared: String(input.repoPath).startsWith('https:') ? 'remote-clone' : 'local-init', initialized: true, remote: '' };
    };
    const requests = [];
    globalThis.fetch = async (url, init = {}) => {
      const headers = new Headers(init.headers);
      requests.push({ path: new globalThis.URL(String(url), 'http://localhost/').pathname, method: init.method ?? 'GET', operatorValid: host.service.verifyOperatorToken(headers.get('x-metainfer-operator')).ok === true });
      return host.request(String(url), init);
    };
    let factory;
    dom.window.__ModuleLoader__ = { load: ({ factory: value }) => { factory = value; } };
    const source = process.env.MIRL_TEST_CLIENT_SOURCE ? pathToFileURL(process.env.MIRL_TEST_CLIENT_SOURCE) : new globalThis.URL('../client.js', import.meta.url);
    source.searchParams.set('operator-integration', 'fresh');
    await import(source.href);
    const module = factory(id => { if (id === 'react') return React; throw Error('unexpected test dependency'); });
    const Wizard = module.__components.CreateProjectWizard;
    assert.equal(typeof Wizard, 'function');
    root = createRoot(dom.window.document.getElementById('root'));
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    await React.act(async () => { root.render(React.createElement(Wizard, { t, onCreated() {} })); await wait(20); });
    const input = () => dom.window.document.querySelector('input[aria-label="' + t('wizard.repoPath') + '"]');
    const setValue = value => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input(), value); input().dispatchEvent(new dom.window.Event('input', { bubbles: true })); input().dispatchEvent(new dom.window.Event('change', { bubbles: true })); };
    const values = ['D:\\inert-new-directory', 'https://github.com/example/inert-empty-repo'];
    for (const value of values) {
      await React.act(async () => { setValue(value); await wait(20); });
      const button = [...dom.window.document.querySelectorAll('button')].find(b => b.textContent === t('wizard.validate'));
      assert.ok(button, 'check-and-prepare button');
      await React.act(async () => { button.click(); await wait(60); });
    }
    assert.deepEqual(prepared, values, 'both user actions reach the actual protected Host route');
    const posts = requests.filter(r => r.path.endsWith('/repo/prepare'));
    assert.equal(posts.length, 2, 'no replay');
    assert.equal(posts.every(r => r.operatorValid), true, 'only obtained signed credentials');
    assert.equal(requests.filter(r => r.path.endsWith('/operator/credential')).length >= 2, true, 'fresh acquisition for each protected action');
    assert.equal(dom.window.document.querySelector('.rl-error-text'), null);
  } finally {
    if (root) await React.act(async () => { root.unmount(); });
    await host.close();
    dom.window.close();
    for (const name of names) {
      if (originals[name]) Object.defineProperty(globalThis, name, originals[name]);
      else delete globalThis[name];
    }
  }
});
