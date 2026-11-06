/** Offline wizard regression: real client functions with a minimal React hook harness. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { registerHttpRoutes } from '../host/http.js';

const source = (await readFile(new URL('../client.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const marker = "    return {\n      inject: ['slots'";
assert.ok(source.includes(marker), 'client factory export marker');
const exposed = source.replace(marker, "    globalThis.client = { zh, en, api, LabRequestError, localizedRepoError, normalizeRepoInfo, CreateProjectWizard };\n" + marker);
const results = [];
async function test(name, fn) {
  try { await fn(); results.push(['PASS', name]); }
  catch (error) { results.push(['FAIL', name, error.stack]); }
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function harness(locale = 'zh') {
  const slots = [];
  const cleanups = [];
  let cursor = 0;
  let mounted = true;
  let lateUpdates = 0;
  let created = 0;
  const React = {
    Component: class {},
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (next) => { if (!mounted) lateUpdates++; slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
    useMemo(fn) { cursor++; return fn(); },
    useCallback(fn) { cursor++; return fn; },
    useEffect(fn) { const index = cursor++; if (!(index in slots)) { slots[index] = true; const cleanup = fn(); if (cleanup) cleanups.push(cleanup); } },
  };
  const context = vm.createContext({
    window: { __ModuleLoader__: { load: ({ factory }) => factory(() => React) } },
    AbortController, fetch: async () => { throw new Error('unexpected network'); }, URL, console,
  });
  vm.runInContext(exposed, context, { filename: 'client.js' });
  const client = context.client;
  const t = (key, values = {}) => {
    assert.ok(Object.hasOwn(client[locale], key), `missing ${locale} key ${key}`);
    return client[locale][key].replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? `{${name}}`));
  };
  let tree;
  function render() { cursor = 0; tree = client.CreateProjectWizard({ t, onCreated() { created++; } }); return tree; }
  function nodes(node = tree) { return !node || typeof node !== 'object' ? [] : [node, ...node.children.flatMap((child) => nodes(child))]; }
  function field(key, value) {
    const node = nodes().find((item) => item.props.ariaLabel === t(key));
    assert.ok(node); node.props.onChange({ target: { value } }); render();
  }
  function input(value) { field('wizard.repoPath', value); }
  function button(key) { return nodes().find((node) => node.props.label === t(key)); }
  function text() { return nodes().flatMap((node) => [typeof node.props.value === 'string' ? node.props.value : '', ...node.children.filter((child) => typeof child === 'string')]).join(' '); }
  render();
  return { client, t, render, input, field, button, text, context, language(next) { locale = next; render(); }, stats: () => ({ lateUpdates, created }), unmount() { mounted = false; cleanups.forEach((cleanup) => cleanup()); } };
}
const info = (root = 'D:/new-project') => ({ repoRoot: root, branches: ['main'], defaultBranch: 'main', baseCommit: 'a'.repeat(40), dirty: false });

await test('all repository errors are localized and never expose raw Git stderr', () => {
  const codes = ['bad_path', 'path_too_long', 'not_git', 'no_commits', 'bare', 'bad_branch', 'git_missing', 'git_timeout', 'git_failed', 'git_permission', 'git_unsafe', 'clone_failed', 'repo_setup_required', 'initial_commit_failed', 'git_install_confirmation_required', 'git_install_failed', 'git_install_timeout', 'git_install_unavailable'];
  for (const language of ['zh', 'en']) {
    const app = harness(language);
    for (const code of codes.concat('unrecognized_backend_code')) {
      const result = app.client.localizedRepoError(new app.client.LabRequestError(code, 'fatal: Needed a single revision'), app.t);
      assert.ok(!result.includes('fatal:'));
      assert.ok(result.length > 20, `${language}/${code} has actionable guidance`);
      assert.equal(/[\u4e00-\u9fff]/u.test(result), language === 'zh', `${language}/${code}`);
    }
  }
});
await test('repository preparation uses POST; Git install sends explicit confirmation only', async () => {
  const app = harness();
  const calls = [];
  app.context.fetch = async (url, options) => { calls.push({ url, ...options }); return { ok: true, status: 200, json: async () => ({ ok: true, data: info() }) }; };
  await app.client.api.prepareRepo('D:/empty', undefined, app.t);
  await app.client.api.gitStatus(undefined, app.t);
  await app.client.api.installGit(undefined, app.t);
  assert.equal(calls[0].method, 'POST');
  assert.equal(JSON.parse(calls[0].body).path, 'D:/empty');
  assert.ok(calls[1].url.endsWith('/git'));
  assert.ok(calls[2].url.endsWith('/git/install'));
  assert.deepEqual(JSON.parse(calls[2].body), { confirmed: true });
});
await test('prepare succeeds for a new directory and displays actual root', async () => {
  const app = harness(); let called;
  app.client.api.prepareRepo = async (value) => { called = value; return info(); };
  app.input('D:/new-project');
  await app.button('wizard.validate').props.onClick(); app.render();
  assert.equal(called, 'D:/new-project');
  assert.ok(app.text().includes('D:/new-project'));
  assert.ok(app.text().includes(app.t('wizard.repo.valid')));
});
await test('changing a path aborts old work and ignores even late successful responses', async () => {
  const app = harness(); const pending = deferred(); let signal;
  app.client.api.prepareRepo = (_path, value) => { signal = value; return pending.promise; };
  app.input('D:/old'); const work = app.button('wizard.validate').props.onClick(); app.render();
  app.input('D:/new'); assert.equal(signal.aborted, true);
  pending.resolve(info('D:/old')); await work; app.render();
  assert.ok(!app.text().includes('D:/old'));
  assert.ok(!app.text().includes(app.t('wizard.repo.valid')));
});
await test('missing Git asks once, installs only on consent, and retries original path', async () => {
  const app = harness(); const prepared = []; let installs = 0;
  app.client.api.prepareRepo = async (value) => {
    prepared.push(value);
    if (prepared.length === 1) throw new app.client.LabRequestError('git_missing', 'missing');
    return info(value);
  };
  app.client.api.gitStatus = async () => ({ available: false, installable: true, platform: 'win32', command: 'winget install --id Git.Git --exact', manualCommand: 'winget install --id Git.Git --exact' });
  app.client.api.installGit = async () => { installs++; return { available: true }; };
  app.input('D:/empty'); await app.button('wizard.validate').props.onClick(); app.render();
  assert.equal(installs, 0);
  assert.ok(app.text().includes(app.t('wizard.git.consent')));
  assert.ok(app.text().includes('winget install'));
  await app.button('wizard.git.install').props.onClick(); app.render();
  assert.equal(installs, 1); assert.deepEqual(prepared, ['D:/empty', 'D:/empty']);
  assert.ok(app.text().includes(app.t('wizard.repo.valid')));
});
await test('declining Git installation does not install or erase the path', async () => {
  const app = harness(); let installs = 0;
  app.client.api.prepareRepo = async () => { throw new app.client.LabRequestError('git_missing', 'missing'); };
  app.client.api.gitStatus = async () => ({ available: false, installable: true, platform: 'win32', command: 'winget install', manualCommand: 'winget install' });
  app.client.api.installGit = async () => { installs++; };
  app.input('D:/retained'); await app.button('wizard.validate').props.onClick(); app.render();
  app.button('wizard.git.cancel').props.onClick(); app.render();
  assert.equal(installs, 0);
  assert.ok(app.text().includes(app.t('wizard.repo.error.git_missing')));
});
await test('unmount aborts pending preparation and ignores its late result', async () => {
  const app = harness(); const pending = deferred(); let signal;
  app.client.api.prepareRepo = (_path, value) => { signal = value; return pending.promise; };
  app.input('D:/closed'); const work = app.button('wizard.validate').props.onClick();
  app.unmount(); assert.equal(signal.aborted, true); pending.resolve(info()); await work;
  assert.deepEqual(app.stats(), { lateUpdates: 0, created: 0 });
});
await test('double-clicking preparation starts only one request', async () => {
  const app = harness(); const pending = deferred(); let calls = 0;
  app.client.api.prepareRepo = () => { calls++; return pending.promise; };
  app.input('D:/once'); const prepare = app.button('wizard.validate');
  const work = prepare.props.onClick(); await prepare.props.onClick();
  assert.equal(calls, 1); pending.resolve(info('D:/once')); await work;
});
await test('changing the path ignores a late missing-Git status response', async () => {
  const app = harness(); const pending = deferred(); const probing = deferred(); let signal;
  app.client.api.prepareRepo = async () => { throw new app.client.LabRequestError('git_missing', 'missing'); };
  app.client.api.gitStatus = (value) => { signal = value; probing.resolve(); return pending.promise; };
  app.input('D:/old'); const work = app.button('wizard.validate').props.onClick();
  await probing.promise; assert.ok(signal);
  app.input('D:/new'); assert.equal(signal.aborted, true);
  pending.resolve({ available: false, installable: true, command: 'winget install' }); await work; app.render();
  assert.equal(app.button('wizard.git.install'), undefined);
  assert.ok(!app.text().includes('D:/old'));
});
await test('unsupported installers show localized manual guidance without an install button', async () => {
  const app = harness('en');
  app.client.api.prepareRepo = async () => { throw new app.client.LabRequestError('git_missing', 'fatal: missing'); };
  app.client.api.gitStatus = async () => ({ available: false, installable: false, manualCommand: 'https://git-scm.com/downloads' });
  app.input('D:/manual'); await app.button('wizard.validate').props.onClick(); app.render();
  assert.equal(app.button('wizard.git.install'), undefined);
  assert.ok(app.text().includes(app.t('wizard.git.manual')));
  assert.ok(app.text().includes('https://git-scm.com/downloads'));
  assert.ok(!/[\u4e00-\u9fff]/u.test(app.text()));
});
await test('installation failure keeps the path and shows actionable localized guidance', async () => {
  const app = harness(); let installs = 0;
  app.client.api.prepareRepo = async () => { throw new app.client.LabRequestError('git_missing', 'missing'); };
  app.client.api.gitStatus = async () => ({ available: false, installable: true, command: 'winget install' });
  app.client.api.installGit = async () => { installs++; throw new app.client.LabRequestError('git_install_failed', 'raw installer stderr'); };
  app.input('D:/retained'); await app.button('wizard.validate').props.onClick(); app.render();
  await app.button('wizard.git.install').props.onClick(); app.render();
  assert.equal(installs, 1); assert.ok(app.text().includes('D:/retained'));
  assert.ok(app.text().includes(app.t('wizard.repo.error.git_install_failed')));
  assert.ok(!app.text().includes('raw installer'));
});
await test('short prompts and invalid project settings are localized without raw Host messages', async () => {
  const app = harness(); let creates = 0;
  app.client.api.prepareRepo = async () => info();
  app.client.api.createProject = async () => { creates++; throw new app.client.LabRequestError('bad_request', 'raw Host validation'); };
  app.input('D:/new-project'); await app.button('wizard.validate').props.onClick(); app.render();
  app.field('wizard.brief', 'A useful research goal'); app.field('wizard.initialPrompt', '得出答案9900');
  await app.button('wizard.create').props.onClick(); app.render();
  assert.equal(creates, 0); assert.ok(app.text().includes(app.t('wizard.required.prompt')));
  app.field('wizard.initialPrompt', 'Compute 99 times 100 and report 9900');
  await app.button('wizard.create').props.onClick(); app.render();
  assert.equal(creates, 1); assert.ok(app.text().includes(app.t('wizard.error.validation')));
  assert.ok(!app.text().includes('raw Host validation'));
});
await test('a project name edited during preparation is not replaced by the suggested name', async () => {
  const app = harness(); const pending = deferred();
  app.client.api.prepareRepo = () => pending.promise;
  app.input('D:/downloaded-repo'); const work = app.button('wizard.validate').props.onClick();
  app.field('wizard.name', 'Keep my custom project name');
  pending.resolve(info('D:/downloaded-repo')); await work; app.render();
  assert.ok(app.text().includes('Keep my custom project name'));
});
await test('unmount during installation prevents preparation retry and late state updates', async () => {
  const app = harness(); const pending = deferred(); let signal; let prepares = 0;
  app.client.api.prepareRepo = async () => { prepares++; throw new app.client.LabRequestError('git_missing', 'missing'); };
  app.client.api.gitStatus = async () => ({ available: false, installable: true, command: 'winget install' });
  app.client.api.installGit = (value) => { signal = value; return pending.promise; };
  app.input('D:/closed'); await app.button('wizard.validate').props.onClick(); app.render();
  const work = app.button('wizard.git.install').props.onClick(); app.unmount();
  assert.equal(signal.aborted, true); pending.resolve({ available: true }); await work;
  assert.equal(prepares, 1); assert.deepEqual(app.stats(), { lateUpdates: 0, created: 0 });
});
await test('unmount during project creation ignores late success and navigation', async () => {
  const app = harness(); const pending = deferred(); let signal;
  app.client.api.prepareRepo = async () => info();
  app.client.api.createProject = (_payload, value) => { signal = value; return pending.promise; };
  app.input('D:/closed'); await app.button('wizard.validate').props.onClick(); app.render();
  app.field('wizard.brief', 'A useful research goal'); app.field('wizard.initialPrompt', 'Compute 99 times 100 and report 9900');
  const work = app.button('wizard.create').props.onClick(); app.unmount();
  assert.equal(signal.aborted, true); pending.resolve({ project: { id: 'old-project' } }); await work;
  assert.deepEqual(app.stats(), { lateUpdates: 0, created: 0 });
});
await test('existing repository and form errors follow the current UI language', async () => {
  const app = harness();
  app.client.api.prepareRepo = async () => { throw new app.client.LabRequestError('git_failed', 'raw Git stderr'); };
  app.input('D:/broken'); await app.button('wizard.validate').props.onClick(); app.render();
  app.language('en'); assert.ok(app.text().includes(app.t('wizard.repo.error.git_failed')));
  assert.ok(!app.text().includes(app.client.zh['wizard.repo.error.git_failed']));
  app.language('zh'); await app.button('wizard.create').props.onClick(); app.render();
  app.language('en'); assert.ok(app.text().includes(app.t('wizard.required.repo')));
  assert.ok(!app.text().includes(app.client.zh['wizard.required.repo']));
});
await test('HTTP GET stays read-only; POST prepares; installation confirmation is forwarded', async () => {
  const routes = []; const calls = [];
  const service = {
    validateRepo: async (value) => { calls.push(['read', value]); return info(); },
    prepareRepo: async (value) => { calls.push(['prepare', value]); return info(); },
    gitStatus: async () => ({ available: false }),
    installGit: async (value) => { calls.push(['install', value]); if (value.confirmed !== true) throw Object.assign(new Error('confirmation required'), { code: 'git_install_confirmation_required' }); return { available: true }; },
  };
  registerHttpRoutes({ connection: { fetch: { register(route) { routes.push(route); return () => {}; } } } }, service);
  async function call(path, method = 'GET', body) {
    const route = routes.find((item) => item.path === '/api/metainfer-research-lab' + path.split('?')[0] && item.methods.includes(method));
    assert.ok(route, `${method} ${path} registered`);
    return (await route.fetch(new Request('http://local/api/metainfer-research-lab' + path, { method, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) }))).json();
  }
  assert.equal((await call('/repo?path=D%3A%2Fempty')).ok, true);
  assert.equal((await call('/repo', 'POST', { path: 'D:/empty' })).ok, true);
  assert.equal((await call('/git')).data.available, false);
  for (const confirmed of [undefined, false, null, 0, 1, 'true', [], {}]) {
    assert.equal((await call('/git/install', 'POST', { confirmed })).error.code, 'git_install_confirmation_required');
    assert.equal(calls.at(-1)[1].confirmed, false);
  }
  assert.equal((await call('/git/install', 'POST', { confirmed: true, command: 'arbitrary-command', argv: ['ignored'] })).data.available, true);
  assert.deepEqual(calls.at(-1), ['install', { confirmed: true }]);
  for (const invalid of [null, [], true, 'true']) assert.equal((await call('/git/install', 'POST', invalid)).error.code, 'bad_request');
  assert.deepEqual(calls.slice(0, 2), [['read', 'D:/empty'], ['prepare', 'D:/empty']]);
});
for (const [status, name, detail] of results) console.log(`${status} ${name}${detail ? '\n' + detail : ''}`);
assert.equal(results.filter(([status]) => status === 'FAIL').length, 0, 'repository client/HTTP checks');
