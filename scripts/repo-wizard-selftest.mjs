#!/usr/bin/env node
/**
 * Create-project wizard: repository bootstrap UX. The Host is a deterministic
 * fetch fixture; this checks that one click prepares a directory or a URL, that
 * errors are localized with a remediation hint, and that a missing Git offers
 * one explicit install action.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/?wizard=repo',
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
globalThis.CustomEvent = window.CustomEvent;
const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');

delete globalThis.__METAINFER_OPERATOR_TOKEN__;
delete window.__METAINFER_OPERATOR_TOKEN__;
window.__METAINFER_TEST__ = true;

const dictionary = JSON.parse(await readFile(new URL('../locale/zh.json', import.meta.url), 'utf8')).keys;
const t = (key, params) => {
  let text = Object.prototype.hasOwnProperty.call(dictionary, key) ? dictionary[key] : key;
  if (params !== null && typeof params === 'object') {
    for (const [name, value] of Object.entries(params)) {
      text = text.split('{' + name + '}').join(String(value));
    }
  }
  return text;
};

const failures = [];
let checks = 0;
function check(name, condition, detail = '') {
  checks += 1;
  if (condition) process.stdout.write(`ok   ${name}\n`);
  else failures.push(name + (detail === '' ? '' : ': ' + detail));
}
async function wait(ms = 60) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
function setValue(element, value) {
  const proto = window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value);
  element.dispatchEvent(new window.Event('input', { bubbles: true }));
  element.dispatchEvent(new window.Event('change', { bubbles: true }));
}
function buttonByText(host, text) {
  return Array.from(host.querySelectorAll('button')).find((button) => button.textContent === text) ?? null;
}

const LOCAL_DIR = 'D:\\work\\demo';
const PREPARED = {
  repoRoot: 'D:/work/demo', gitDir: 'D:/work/demo/.git',
  branches: ['main'], defaultBranch: 'main', baseCommit: 'abcdef1234567',
  dirty: false, prepared: 'local-init', initialized: true, remote: '',
};

let mode = 'ok';
const requests = [];
globalThis.fetch = async (url, options = {}) => {
  const text = String(url);
  const body = typeof options.body === 'string' ? JSON.parse(options.body) : null;
  requests.push({ url: text, method: options.method || 'GET', body, headers: new Headers(options.headers), cache: options.cache });
  const envelope = (payload) => ({ ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) });
  const failure = (code, message, status = 422) => ({
    ok: false,
    status,
    json: async () => ({ ok: false, error: { code, message } }),
    text: async () => JSON.stringify({ ok: false, error: { code, message } }),
  });

  if (text.endsWith('/operator/credential')) return envelope({ ok: true, data: { token: 'synthetic-wizard-authority', issuedAt: 1700000000 } });
  if (text.includes('/repo/prepare')) {
    if (mode === 'git_missing') return failure('git_missing', 'Git is not installed or not on PATH');
    if (mode === 'remote_failed') return failure('remote_clone_failed', 'git clone failed: repository not found');
    if (mode === 'credential') return failure('operator_required', 'a write credential is required', 401);
    return envelope({ ok: true, data: PREPARED });
  }
  if (text.includes('/git/install')) {
    mode = 'ok';
    return envelope({ ok: true, data: { installed: true, alreadyPresent: false, version: '2.56.0' } });
  }
  if (text.includes('/repo?')) return envelope({ ok: true, data: {} });
  return envelope({ ok: true, data: {} });
};

let factory = null;
window.__ModuleLoader__ = { load({ factory: captured }) { factory = captured; } };
await import('../client.js?repo-wizard-selftest=1');
assert.equal(typeof factory, 'function');
const module = factory((id) => {
  if (id === 'react') return React;
  throw new Error(`unexpected require(${id})`);
});
const { CreateProjectWizard } = module.__components;
assert.equal(typeof CreateProjectWizard, 'function', 'CreateProjectWizard is exported for tests');

const host = window.document.createElement('div');
window.document.body.appendChild(host);
const root = createRoot(host);
await React.act(async () => {
  root.render(React.createElement(CreateProjectWizard, { t, onCreated: () => {} }));
  await wait(80);
});

function repoInput() {
  return host.querySelector(`input[aria-label="${t('wizard.repoPath')}"]`);
}
function errorText() {
  const node = host.querySelector('.rl-error-text');
  return node === null ? '' : node.textContent;
}
function hintText() {
  const node = host.querySelector('.rl-repo-hint');
  return node === null ? '' : node.textContent;
}

// 1. One click prepares a plain local directory through POST /repo/prepare.
const input = repoInput();
check('the wizard renders a repository input', input !== null);
await React.act(async () => { setValue(input, LOCAL_DIR); await wait(20); });
const validateButton = buttonByText(host, t('wizard.validate'));
check('the wizard renders the validate button', validateButton !== null);
await React.act(async () => { validateButton.click(); await wait(80); });

const prepareCall = requests.find((entry) => entry.url.includes('/repo/prepare'));
check('validate bootstraps without a pre-seeded credential', requests[0]?.url.endsWith('/operator/credential') && requests[0]?.headers.get('x-metainfer-bootstrap') === '1' && requests[0]?.cache === 'no-store');
check('prepare carries the acquired credential header', prepareCall?.headers.get('x-metainfer-operator') === 'synthetic-wizard-authority');
check('validate uses the prepare route', prepareCall !== undefined, JSON.stringify(requests.map((entry) => entry.url)));
check('prepare posts the picked path', prepareCall !== undefined && prepareCall.method === 'POST' && prepareCall.body.repoPath === LOCAL_DIR, JSON.stringify(prepareCall));
check('the read-only inspect route is not used by the wizard', !requests.some((entry) => entry.url.includes('/repo?path=')));
check('a prepared directory is reported', host.textContent.includes(t('wizard.repo.prepared.localInit')), host.textContent);
check('an initial commit is reported', host.textContent.includes(t('wizard.repo.prepared.initialCommit')));
check('the base commit is shown', host.textContent.includes('abcdef1234567'));
check('no error remains after success', errorText() === '');

// 2. Missing Git shows a localized message, a remediation hint and one install action.
mode = 'git_missing';
await React.act(async () => { setValue(input, LOCAL_DIR + '2'); await wait(20); });
check('editing the path clears the previous result', host.textContent.includes('abcdef1234567') === false);
await React.act(async () => { buttonByText(host, t('wizard.validate')).click(); await wait(80); });
check('a missing Git error is localized', errorText().includes(t('wizard.repo.error.git_missing')), errorText());
check('a missing Git error carries a remediation hint', hintText() === t('wizard.repo.hint.git_missing'), hintText());
const installButton = buttonByText(host, t('wizard.git.install'));
check('a missing Git error offers the install action', installButton !== null);

// 3. The install action runs once, then re-prepares without another click.
await React.act(async () => { installButton.click(); await wait(120); });
const installCall = requests.find((entry) => entry.url.includes('/git/install'));
check('the install action posts explicit confirmation', installCall !== undefined && installCall.body.confirmed === true, JSON.stringify(installCall));
const prepares = requests.filter((entry) => entry.url.includes('/repo/prepare'));
check('the wizard re-prepares after installing Git', prepares.length >= 3, String(prepares.length));
check('the error disappears after a successful install', errorText() === '');
check('the prepared chips return after installing Git', host.textContent.includes(t('wizard.repo.prepared.localInit')));

// 4. Other preparation failures are localized too and never offer software installs.
mode = 'remote_failed';
await React.act(async () => { setValue(input, 'https://github.com/example/missing'); await wait(20); });
await React.act(async () => { buttonByText(host, t('wizard.validate')).click(); await wait(80); });
check('a clone failure is localized', errorText().includes(t('wizard.repo.error.remote_clone_failed')), errorText());
check('a clone failure carries a remediation hint', hintText() === t('wizard.repo.hint.remote_clone_failed'), hintText());
check('a clone failure does not offer a Git install', buttonByText(host, t('wizard.git.install')) === null);

// 5. A rejected credential offers explicit bootstrap Retry, never replays the
//    failed prepare, and requires a new Validate click before preparing again.
mode = 'credential';
await React.act(async () => { setValue(input, LOCAL_DIR + '3'); await wait(20); });
await React.act(async () => { buttonByText(host, t('wizard.validate')).click(); await wait(120); });
check('a missing write credential is localized', errorText().includes(t('ws.operator.missing')), errorText());
check('a missing write credential offers localized Retry', buttonByText(host, t('common.retry')) !== null);
check('a missing write credential does not offer a Git install', buttonByText(host, t('wizard.git.install')) === null);

const prepareCount = requests.filter((entry) => entry.url.includes('/repo/prepare')).length;
mode = 'ok';
await React.act(async () => { buttonByText(host, t('common.retry')).click(); await wait(80); });
check('credential Retry does not replay repository preparation', requests.filter((entry) => entry.url.includes('/repo/prepare')).length === prepareCount && errorText() === '');
await React.act(async () => { buttonByText(host, t('wizard.validate')).click(); await wait(80); });
check('a new explicit Validate click can prepare after credential Retry', requests.filter((entry) => entry.url.includes('/repo/prepare')).length === prepareCount + 1 && host.textContent.includes(t('wizard.repo.prepared.localInit')));

await React.act(async () => { root.unmount(); });
window.close();
if (failures.length > 0) {
  process.stderr.write('\nrepo-wizard-selftest failures:\n' + failures.map((line) => ' - ' + line).join('\n') + '\n');
  process.exit(1);
}
process.stdout.write(`\nrepo-wizard-selftest: all ${checks} checks passed\n`);
