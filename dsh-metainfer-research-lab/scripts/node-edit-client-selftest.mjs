/** Offline inspector checks: real client functions, mock React hooks, no browser/network. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = (await readFile(new URL('../client.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const marker = "    return {\n      inject: ['slots'";
assert.ok(source.includes(marker), 'client factory export marker');
const exposed = source.replace(marker, '    globalThis.client = { zh, en, NodeInspector, LabInput, autoPauseLabelKeyOf, LabRequestError, api, useProjectWorkspace };\n' + marker);
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
function harness({ status = 'running', sealed = false, locale = 'zh', save } = {}) {
  const slots = []; const effects = [];
  let cursor = 0; let mounted = true; let lateUpdates = 0; let tree;
  const React = {
    Component: class {}, memo: (component) => component,
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], (next) => { if (!mounted) lateUpdates++; slots[i] = typeof next === 'function' ? next(slots[i]) : next; }];
    },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useMemo: (fn) => { cursor++; return fn(); }, useCallback: (fn) => { cursor++; return fn; },
    useEffect(fn, dependencies) {
      const i = cursor++; const old = slots[i];
      if (!old || !dependencies || dependencies.some((value, index) => value !== old.dependencies[index])) {
        effects.push(() => { old?.cleanup?.(); slots[i] = { dependencies, cleanup: fn() }; });
      }
    },
  };
  const context = vm.createContext({ window: { __ModuleLoader__: { load: ({ factory }) => factory(() => React) } }, AbortController, URL, console, fetch: async () => { throw Error('unexpected network'); } });
  vm.runInContext(exposed, context, { filename: 'client.js' });
  const client = context.client;
  const t = (key, values = {}) => {
    assert.ok(Object.hasOwn(client[locale], key), `missing ${locale} key ${key}`);
    return client[locale][key].replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? `{${name}}`));
  };
  const calls = [];
  const project = { id: 'p-test', config: { nodeTimeoutMinutes: 10, maxNodeTimeoutMinutes: 360 } };
  let node = { id: 'n-test', title: 'Test node', status, sealed, isLeaf: !sealed, prompt: 'Run an isolated test.', timeboxMs: 120 * 60000, timestamps: {} };
  const props = { project, now: Date.now(), busyKey: '', modelOptions: [], modelProviders: [], clusterEnabled: false,
    onSave: async (patch) => { calls.push(JSON.parse(JSON.stringify(patch))); return save ? save(patch) : { ok: true }; },
    onAction() {}, onOpenSession() {}, onOpenFiles() {}, onContinue() {}, onSuccessor() {}, onProposalAction() {}, onOpenRun() {}, onRetryRequest() {}, onOpenMergeCreate() {}, onFinishMerge() {}, onEscalate() {},
  };
  function render() {
    cursor = 0; tree = client.NodeInspector({ ...props, node, nodes: [node], t });
    const pending = effects.splice(0); pending.forEach((effect) => effect());
    if (pending.length) { cursor = 0; tree = client.NodeInspector({ ...props, node, nodes: [node], t }); }
    return tree;
  }
  function nodes(item = tree) { return !item || typeof item !== 'object' ? [] : [item, ...item.children.flatMap((child) => nodes(child))]; }
  function input() { return nodes().find((item) => item.props.ariaLabel === t('ws.inspector.timebox')); }
  function button(key) { return nodes().find((item) => item.props.label === t(key)); }
  function field(value) { input().props.onChange({ target: { value } }); render(); }
  function text() { return nodes().flatMap((item) => item.children.filter((child) => typeof child === 'string')).join(' '); }
  render();
  return { client, context, t, render, input, button, field, text, calls,
    language(next) { locale = next; render(); }, node(next) { node = { ...node, ...next }; render(); },
    busy(next) { props.busyKey = next; render(); },
    unmount() { mounted = false; for (const slot of slots) slot?.cleanup?.(); }, lateUpdates: () => lateUpdates };
}
await test('running nodes unlock only timebox, not prompt or model', async () => {
  const app = harness();
  assert.equal(app.input().props.disabled, false); assert.equal(app.button('ws.inspector.saveTimebox').props.disabled, false);
  assert.equal(app.button('ws.inspector.savePrompt').props.disabled, true); assert.equal(app.button('ws.inspector.saveModel'), undefined);
  app.field('180'); await app.button('ws.inspector.saveTimebox').props.onClick(); assert.deepEqual(app.calls, [{ timeboxMinutes: 180 }]);
});
await test('planned and proposed edits remain available', () => {
  for (const status of ['planned', 'proposed']) { const app = harness({ status }); assert.equal(app.input().props.disabled, false); assert.equal(app.button('ws.inspector.savePrompt').props.disabled, false); }
});
await test('retryable terminal budgets edit without starting anything', async () => {
  for (const status of ['failed', 'cancelled', 'completed']) { const app = harness({ status }); assert.equal(app.input().props.disabled, false, status); app.field('240'); await app.button('ws.inspector.saveTimebox').props.onClick(); assert.deepEqual(app.calls, [{ timeboxMinutes: 240 }]); }
});
await test('sealed completed history remains locked', () => {
  const app = harness({ status: 'completed', sealed: true }); assert.equal(app.input().props.disabled, true); assert.equal(app.button('ws.inspector.saveTimebox').props.disabled, true);
});
await test('fractional, invalid and out-of-range minutes never send', async () => {
  const app = harness({ status: 'planned' });
  for (const value of ['', '0', '-1', '2.5', 'NaN', 'Infinity', '361', '1e3', '120minutes']) { app.field(value); await app.button('ws.inspector.saveTimebox').props.onClick(); app.render(); assert.equal(app.calls.length, 0, value); assert.ok(app.text().includes(app.t('ws.inspector.timebox.invalid', { max: 360 })), value); }
});
await test('saving is single-flight even before rerender', async () => {
  const pending = deferred(); const app = harness({ save: () => pending.promise }); app.field('180'); const button = app.button('ws.inspector.saveTimebox');
  const work = button.props.onClick(); const duplicate = button.props.onClick(); app.render(); assert.equal(app.input().props.disabled, true); assert.equal(app.calls.length, 1);
  pending.resolve({ ok: true }); await Promise.all([work, duplicate]); app.render(); assert.equal(app.input().props.disabled, false);
});
await test('guidance distinguishes total current budget and next-attempt budget', () => {
  for (const locale of ['zh', 'en']) { const app = harness({ locale }); assert.ok(app.text().includes(app.t('ws.inspector.timebox.runningHint'))); assert.ok(app.text().includes(app.t('ws.inspector.timebox.settingsHint', { max: 360 }))); const failed = harness({ locale, status: 'failed' }); assert.ok(failed.text().includes(failed.t('ws.inspector.timebox.futureHint'))); }
});
await test('timebox errors are actionable and follow current UI language', async () => {
  for (const code of ['timebox_invalid', 'timebox_elapsed', 'node_timebox_unavailable', 'node_not_editable', 'node_sealed']) {
    const app = harness({ save: async () => ({ ok: false, error: 'raw Host error', errorCode: code }) }); app.field('180'); await app.button('ws.inspector.saveTimebox').props.onClick(); app.render();
    assert.ok(!app.text().includes('raw Host error'), code); assert.ok(app.text().includes(app.t('ws.inspector.timebox.error.' + code)), code); app.language('en'); assert.ok(app.text().includes(app.t('ws.inspector.timebox.error.' + code)), code);
  }
});
await test('late save does not update a different selected node', async () => {
  const pending = deferred(); const app = harness({ save: () => pending.promise }); app.field('180'); const work = app.button('ws.inspector.saveTimebox').props.onClick();
  app.node({ id: 'n-next', timeboxMs: 30 * 60000 }); pending.resolve({ ok: false, error: 'belongs to old node', errorCode: 'timebox_elapsed' }); await work; app.render();
  assert.equal(app.input().props.value, '30'); assert.ok(!app.text().includes('belongs to old node')); assert.ok(!app.text().includes(app.t('ws.inspector.timebox.error.timebox_elapsed')));
});
await test('unmounted inspector ignores late save completion', async () => {
  const pending = deferred(); const app = harness({ save: () => pending.promise }); app.field('180'); const work = app.button('ws.inspector.saveTimebox').props.onClick();
  app.unmount(); pending.resolve({ ok: true }); await work; assert.equal(app.lateUpdates(), 0);
});
await test('idle, human decision, errors and no-progress have distinct labels', () => {
  for (const locale of ['zh', 'en']) { const app = harness({ locale }); const labels = ['idle', 'needsUserDecision', 'errors', 'noProgress'].map((reason) => app.t(app.client.autoPauseLabelKeyOf(reason))); assert.equal(new Set(labels).size, 4); assert.ok(!/fuse|熔断/i.test(labels[0])); assert.ok(!labels.some((label) => label === app.t('ws.auto.pause.unknown'))); }
});
await test('HTTP200 business errors preserve codes for save feedback', async () => {
  const app = harness(); let body; app.context.fetch = async (_url, init) => { body = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ ok: false, error: { code: 'timebox_elapsed', message: 'raw Host error' } }) }; };
  await assert.rejects(() => app.client.api.command({ type: 'node.edit', projectId: 'p-test', nodeId: 'n-test', timeboxMinutes: 60 }, undefined, app.t), (error) => error.code === 'timebox_elapsed'); assert.equal(body.timeboxMinutes, 60);
});
await test('numeric input forwards current bounds and whole-minute step', () => {
  const app = harness();
  assert.equal(app.input().props.min, 1);
  assert.equal(app.input().props.max, 360);
  assert.equal(app.input().props.step, 1);
  const control = app.client.LabInput(app.input().props);
  assert.equal(control.props.min, 1); assert.equal(control.props.max, 360); assert.equal(control.props.step, 1);
});
await test('poll updates untouched budgets but preserves a user draft', () => {
  const app = harness();
  app.node({ timeboxMs: 150 * 60000 }); assert.equal(app.input().props.value, '150');
  app.field('180'); app.node({ timeboxMs: 160 * 60000 }); assert.equal(app.input().props.value, '180');
});
await test('in-flight actions on the selected node prevent timebox submissions', async () => {
  const app = harness(); app.field('180'); app.busy('node.cancel:n-test');
  assert.equal(app.input().props.disabled, true);
  assert.equal(app.button('ws.inspector.saveTimebox').props.disabled, true);
  await app.button('ws.inspector.saveTimebox').props.onClick(); assert.equal(app.calls.length, 0);
});
await test('unknown and thrown save failures never expose raw host detail', async () => {
  for (const save of [async () => ({ ok: false, errorCode: 'unexpected_storage', error: 'raw sensitive host detail' }),
    async () => { throw new Error('raw sensitive host detail'); }]) {
    const app = harness({ save }); app.field('180'); await app.button('ws.inspector.saveTimebox').props.onClick(); app.render();
    assert.ok(app.text().includes(app.t('ws.inspector.timebox.error.unknown')));
    assert.ok(!app.text().includes('raw sensitive host detail'));
    app.language('en'); assert.ok(app.text().includes(app.t('ws.inspector.timebox.error.unknown')));
  }
});
await test('local invalid-input errors switch with the current language', async () => {
  const app = harness(); app.field('2.5'); await app.button('ws.inspector.saveTimebox').props.onClick(); app.render();
  app.language('en'); assert.ok(app.text().includes(app.t('ws.inspector.timebox.invalid', { max: 360 })));
});
await test('workspace keeps projected command evidence through an unchanged-revision refresh', async () => {
  const slots = []; const effects = []; let cursor = 0; let workspace;
  const React = {
    Component: class {}, memo: (component) => component,
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], (value) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useMemo: (fn) => { cursor++; return fn(); }, useCallback: (fn) => { cursor++; return fn; },
    useEffect(fn, dependencies) { const i = cursor++; if (!slots[i]) effects.push(() => { slots[i] = { dependencies, cleanup: fn() }; }); },
  };
  const context = vm.createContext({ window: { __ModuleLoader__: { load: ({ factory }) => factory(() => React) } }, URL, AbortController, console,
    setTimeout: () => 1, clearTimeout() {}, fetch: async () => { throw Error('unexpected network'); } });
  vm.runInContext(exposed, context, { filename: 'client.js' });
  const client = context.client; const requests = []; let revision = 1;
  const legacy = { id: 'n-test', status: 'completed', report: { success: false, summary: 'obsolete structured A' }, reportText: 'fresh follow-up B', timeboxMs: 120 * 60000 };
  // The service regression asserts real HTTP/agent/update responses use this projection.
  let projected = { ...legacy, report: null };
  client.api.fetchState = async (_id, since) => {
    requests.push(since);
    return since === revision ? { unchanged: true, revision } : { project: { id: 'p-test' }, nodes: [projected], edges: [], revision };
  };
  client.api.fetchEvents = async () => ({ events: [], next: 0 });
  const t = (key) => key;
  const render = () => { cursor = 0; workspace = client.useProjectWorkspace('p-test', t); effects.splice(0).forEach((effect) => effect()); };
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); render(); };
  render(); await flush(); assert.equal(workspace.snapshot.nodes[0].report, null);
  revision = 2;
  projected = { ...projected, timeboxMs: 150 * 60000 };
  workspace.applyCommandResult({ node: { ...projected, timeboxMs: 150 * 60000 }, revision });
  await flush();
  assert.equal(requests.at(-1), null, 'a partial command triggers a full state reconciliation');
  assert.equal(workspace.snapshot.revision, 2);
  assert.equal(workspace.snapshot.nodes[0].report, null);
  assert.equal(workspace.snapshot.nodes[0].reportText, 'fresh follow-up B');
  assert.equal(workspace.snapshot.nodes[0].timeboxMs, 150 * 60000);
  assert.equal(legacy.report.summary, 'obsolete structured A', 'stored history is not rewritten by projection');
  workspace.refresh(); await flush();
  assert.equal(requests.at(-1), 2, 'normal polling resumes revision short-circuits after the full snapshot');
  assert.equal(workspace.snapshot.nodes[0].reportText, 'fresh follow-up B');
  for (const slot of slots) slot?.cleanup?.();
});
await test('workspace command reconciliation includes concurrent changes outside its partial DTO', async () => {
  const slots = []; const effects = []; let cursor = 0; let workspace;
  const React = {
    Component: class {}, memo: (component) => component,
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], (value) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useMemo: (fn) => { cursor++; return fn(); }, useCallback: (fn) => { cursor++; return fn; },
    useEffect(fn, dependencies) { const i = cursor++; if (!slots[i]) effects.push(() => { slots[i] = { dependencies, cleanup: fn() }; }); },
  };
  const context = vm.createContext({ window: { __ModuleLoader__: { load: ({ factory }) => factory(() => React) } }, URL, AbortController, console,
    setTimeout: () => 1, clearTimeout() {}, fetch: async () => { throw Error('unexpected network'); } });
  vm.runInContext(exposed, context, { filename: 'client.js' });
  const client = context.client; const requests = []; let revision = 1;
  const legacy = { id: 'n-test', status: 'completed', report: { success: false, summary: 'obsolete structured A' }, reportText: 'fresh follow-up B', timeboxMs: 120 * 60000 };
  // The service regression asserts real HTTP/agent/update responses use this projection.
  let projected = { ...legacy, report: null };
  let other = { id: 'n-other', status: 'running' };
  client.api.fetchState = async (_id, since) => {
    requests.push(since);
    return since === revision ? { unchanged: true, revision } : { project: { id: 'p-test' }, nodes: [projected, { ...other }], edges: [], revision };
  };
  client.api.fetchEvents = async () => ({ events: [], next: 0 });
  const t = (key) => key;
  const render = () => { cursor = 0; workspace = client.useProjectWorkspace('p-test', t); effects.splice(0).forEach((effect) => effect()); };
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); render(); };
  render(); await flush(); assert.equal(workspace.snapshot.nodes[0].report, null);
  revision = 2;
  other = { ...other, status: 'completed' };
  projected = { ...projected, timeboxMs: 150 * 60000 };
  workspace.applyCommandResult({ node: { ...projected, timeboxMs: 150 * 60000 }, revision });
  await flush();
  assert.equal(workspace.snapshot.nodes.find((node) => node.id === 'n-other').status, 'completed', 'a project revision on a partial DTO must not hide concurrent changes');
  assert.equal(workspace.snapshot.revision, 2);
  assert.equal(workspace.snapshot.nodes[0].report, null);
  assert.equal(workspace.snapshot.nodes[0].reportText, 'fresh follow-up B');
  assert.equal(workspace.snapshot.nodes[0].timeboxMs, 150 * 60000);
  assert.equal(legacy.report.summary, 'obsolete structured A', 'stored history is not rewritten by projection');
  workspace.refresh(); await flush();
  assert.equal(requests.at(-1), 2, 'normal polling resumes revision short-circuits after the full snapshot');
  assert.equal(workspace.snapshot.nodes[0].reportText, 'fresh follow-up B');
  for (const slot of slots) slot?.cleanup?.();
});
await test('Host entrypoint wires claimed payload and disposes its listener', async () => {
  const index = (await readFile(new URL('../index.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const start = index.indexOf("  ctx.effect(\n    () => ctx.on('agent/inbox/claimed',");
  assert.ok(start >= 0);
  const end = index.indexOf('\n  );', start) + '\n  );'.length;
  assert.ok(end > start);
  let handler; let dispose; let removed = 0; const received = [];
  const context = vm.createContext({
    ctx: { effect(fn) { dispose = fn(); }, on(name, fn) { assert.equal(name, 'agent/inbox/claimed'); handler = fn; return () => { removed++; }; } },
    runtime: { async onInboxClaimed(payload) { received.push(payload); } },
  });
  vm.runInContext(index.slice(start, end), context, { filename: 'index.js' });
  const session = { id: 'session-test' };
  const payload = { agent: { id: session.id, session }, message: { id: 'message-test' }, turn: 0 };
  handler(payload); await Promise.resolve();
  assert.equal(received.length, 1); assert.equal(received[0], payload);
  dispose(); assert.equal(removed, 1);
});
for (const row of results) console.log(row[0] + ' ' + row[1] + (row[2] ? '\n' + row[2] : ''));
const failures = results.filter(([status]) => status === 'FAIL').length;
console.log(`\n${results.length - failures}/${results.length} node-edit client checks passed.`);
if (failures) process.exitCode = 1;
