#!/usr/bin/env node
/**
 * jsdom panel smoke: mount the real client module through its ModuleLoader
 * contract, then render every panel with degraded / empty payloads. The point
 * is crash containment, not visual assertions: optional fields are absent and
 * every fetch fails or returns a minimal payload.
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React from 'react';
import { createRoot } from 'react-dom/client';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
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
window.__ModuleLoader__ = {
  load({ factory: captured }) {
    factory = captured;
  },
};
await import('../client.js?client-smoke=1');
assert.equal(typeof factory, 'function', 'client factory was not registered');

const module = factory((id) => {
  if (id === 'react') return React;
  throw new Error(`unexpected require(${id})`);
});
const components = module.__components;
assert.ok(components !== null && typeof components === 'object', 'test components missing');

const captures = [];
const noop = () => {};
const ctx = {
  effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : noop; },
  locale: {
    register() { return noop; },
    bind() { return (key) => key; },
  },
  slots: {
    inject(name, register) { captures.push({ name, value: register() }); return noop; },
    register(config, component) { return { config, component }; },
  },
  sessions: {},
  uiWorkspace: {},
  layout: {},
  sidebarRight: {},
};
module.apply(ctx);
assert.ok(captures.some((entry) => entry.name === 'main' && typeof entry.value?.component === 'function'), 'main slot was not registered');

const projects = [{ id: 'p1', name: 'P', repoPath: '/tmp/repo', mode: 'manual', nodeCount: 0 }];
const payloadFor = (url) => {
  const text = String(url);
  if (text.includes('/projects')) return { projects };
  if (text.includes('/health')) return { ok: true, status: 'degraded' };
  if (text.includes('/state')) return {
    project: { id: 'p1', name: 'P', mode: 'manual', config: {}, repo: { path: '/tmp/repo' } },
    nodes: [], edges: [], resources: {}, worktreeRoot: '', revision: 1, auto: null,
  };
  if (text.includes('/events')) return { events: [], next: 0 };
  if (text.includes('/runs')) return { runs: [] };
  if (text.includes('/dashboard')) return {
    projectId: 'p1', widgets: [], events: [], failureCount: 3, degraded: true,
    stale: true, staleReason: 'refresh_failed', commentary: null,
  };
  if (text.includes('/experts')) return { experts: [] };
  if (text.includes('/models')) return { providers: [], profiles: [] };
  return {};
};
globalThis.fetch = async (url) => ({
  ok: true,
  status: 200,
  json: async () => payloadFor(url),
  text: async () => JSON.stringify(payloadFor(url)),
});

class Boundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch() {}
  render() {
    if (this.state.error !== null) return React.createElement('div', { 'data-crash': 'true' }, String(this.state.error?.message ?? this.state.error));
    return this.props.children;
  }
}

const base = {
  t: (key) => key,
  projectId: 'p1',
  nodeId: 'n1',
  project: { id: 'p1', name: 'P', mode: 'manual', config: {}, repo: { path: '/tmp/repo' } },
  node: { id: 'n1', title: 'N', status: 'completed', prompt: '', needs: {}, resourcesHeld: {}, attempts: [], report: {} },
  nodes: [], edges: [], resources: {}, revision: 1,
  open: true,
  state: { phase: 'error', projects: [], health: null, error: 'degraded' },
  runsState: { phase: 'error', runs: [], error: 'degraded' },
  cluster: null, catalogProviders: [], promptDefaults: {}, promptPlaceholders: {},
  dashboard: { projectId: 'p1', widgets: [], events: [], failureCount: 3, degraded: true, stale: true, commentary: null },
  events: [], runs: [], proposal: null, termination: null, postmortem: null, gcRunId: null,
  initialRunId: null, initialNodeId: null,
  onBack: noop, onClose: noop, onOpenProject: noop, onOpenNode: noop, onSelectNode: noop,
  onRetry: noop, onDelete: noop, onSave: noop, onSubmit: noop, onConfirm: noop,
  onCancel: noop, onPush: noop, onOpenRun: noop, onOpenSession: noop, onOpenFiles: noop,
  onSavePlacementPolicy: noop,
};

const names = Object.keys(components).filter((name) => typeof components[name] === 'function');
assert.ok(names.length >= 10, 'not enough panels exported');
const failures = [];
for (const name of names) {
  const host = window.document.createElement('div');
  window.document.body.appendChild(host);
  const root = createRoot(host);
  let thrown = null;
  try {
    await React.act(async () => {
      root.render(React.createElement(Boundary, null, React.createElement(components[name], base)));
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
  } catch (error) {
    thrown = error;
  }
  const text = host.textContent ?? '';
  const crashed = host.querySelector('[data-crash]') !== null || text.includes('crash.title');
  if (thrown !== null) failures.push(`${name}: threw ${thrown.message}`);
  else if (crashed) failures.push(`${name}: rendered the crash boundary`);
  else process.stdout.write(`ok   ${name} mounts with degraded payloads\n`);
  try { await React.act(async () => root.unmount()); } catch {}
  host.remove();
}

// A20: a partial refresh must show the same dismissible alert as a total
// failure. The verifier found the banner only reacted to status==='error'.
if (typeof components.DashboardPanel === 'function') {
  const host = window.document.createElement('div');
  window.document.body.appendChild(host);
  const root = createRoot(host);
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/dashboard')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          projectId: 'p1', widgets: [], events: [], chat: [],
          stale: true, staleReason: 'refresh_partial', failureCount: 1, degraded: false,
          lastRun: { status: 'partial', error: '1 widget(s) failed', errorHint: 'fix it', failedAt: Date.now(), consecutiveFailures: 1 },
        }),
        text: async () => '{}',
      };
    }
    return savedFetch(url);
  };
  try {
    await React.act(async () => {
      root.render(React.createElement(Boundary, null, React.createElement(components.DashboardPanel, base)));
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    const alert = host.querySelector('.rl-dash-alert');
    if (alert === null) failures.push('Dashboard: partial refresh did not render an alert');
    else if (!(host.textContent ?? '').includes('dashboard.partialAlert')) failures.push('Dashboard: partial alert used the wrong message');
    else process.stdout.write('ok   Dashboard renders a partial-refresh alert\n');
  } catch (error) {
    failures.push(`Dashboard partial alert: threw ${error.message}`);
  }
  try { await React.act(async () => root.unmount()); } catch {}
  globalThis.fetch = savedFetch;
  host.remove();
}
// U1/U2/U3/U12 behavioural assertions, not crash containment.
let extraChecks = 0;
const extraFailures = [];
async function renderWith(component, fetchImpl) {
  const saved = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const host = window.document.createElement('div');
  window.document.body.appendChild(host);
  const root = createRoot(host);
  await React.act(async () => {
    root.render(React.createElement(Boundary, null, React.createElement(component, base)));
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  return { host, root, restore() { globalThis.fetch = saved; } };
}
{
  const payload = (url) => {
    const text = String(url);
    if (text.includes('/state')) return { project: { id: 'p1', name: 'P', config: {}, repo: {} }, nodes: [
      { id: 'run1', title: 'running node', status: 'running', priority: { class: 'p0' }, timestamps: { startedAt: Date.now() - 60_000 }, resourcesHeld: { gpu: 2 }, needs: { gpu: 2 }, git: { branch: 'exp/run1' } },
      ...Array.from({ length: 6 }, (_, index) => ({ id: 'q' + (index + 1), title: 'queued ' + (index + 1), status: 'planned', priority: { class: 'p2' }, resourceWait: index === 0 ? { reason: 'gpu_quota' } : undefined, timestamps: { createdAt: 1 } })),
    ], edges: [], revision: 1 };
    if (text.includes('/status') || text.includes('/facts')) return {
      summary: { runnable: 6 },
      nextToStart: Array.from({ length: 5 }, (_, index) => ({ nodeId: 'q' + (index + 1), why: { code: 'max_running', message: 'maxRunningNodes=4 slots are busy' } })),
      queueOrder: ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'],
    };
    if (text.includes('/metrics')) return {};
    if (text.includes('/budgets')) return { classes: [] };
    return {};
  };
  const view = await renderWith(components.DispatchQueuePanel, async (url) => ({ ok: true, status: 200, json: async () => payload(url), text: async () => JSON.stringify(payload(url)) }));
  extraChecks += 1;
  const text = view.host.textContent ?? '';
  if (!text.includes('elapsed 60s') || !text.includes('GPU 2') || !text.includes('exp/run1') || !text.includes('#1')) {
    extraFailures.push(`U1/U2 dispatch row missing elapsed/GPU/branch/position: ${text.slice(0, 500)}`);
  } else process.stdout.write('ok   U1/U2 running row shows elapsed/GPU/branch and queue position\n');
  extraChecks += 1;
  if (!text.includes('#6') || !text.includes('maxRunningNodes=4')) {
    extraFailures.push(`U2 sixth queue position or why reason missing: ${text.slice(0, 800)}`);
  } else process.stdout.write('ok   U2 renders the sixth queue position and facts.why\n');
  await React.act(async () => view.root.unmount()); view.restore(); view.host.remove();
}
{
  const total = 150;
  const ids = Array.from({ length: total }, (_, index) => 'q' + (index + 1));
  const payload = (url) => {
    const text = String(url);
    if (text.includes('/state')) return { project: { id: 'p1', name: 'P', config: {}, repo: {} }, nodes: [
      { id: 'run1', title: 'running node', status: 'running', priority: { class: 'p0' }, timestamps: { startedAt: Date.now() - 60_000 } },
      ...ids.map((id, index) => ({ id, title: 'queued ' + (index + 1), status: 'planned', priority: { class: 'p2' }, timestamps: { createdAt: 1 } })),
    ], edges: [], revision: 1 };
    if (text.includes('/status') || text.includes('/facts')) return {
      summary: { runnable: total },
      nextToStart: ids.slice(0, 5).map((nodeId) => ({ nodeId, why: { code: 'max_running', message: 'maxRunningNodes=4 slots are busy' } })),
      queueOrder: ids.slice(0, 100),
      queueRows: ids.slice(0, 100).map((nodeId) => ({ nodeId, why: { code: 'max_running', message: 'maxRunningNodes=4 slots are busy' } })),
      _truncated: { queueOrder: { shown: 100, total } },
    };
    if (text.includes('/metrics')) return {};
    if (text.includes('/budgets')) return { classes: [] };
    return {};
  };
  const view = await renderWith(components.DispatchQueuePanel, async (url) => ({ ok: true, status: 200, json: async () => payload(url), text: async () => JSON.stringify(payload(url)) }));
  extraChecks += 1;
  const text = view.host.textContent ?? '';
  if (!text.includes('showing 100 of 150') || !text.includes('#100') || text.includes('#101')) {
    extraFailures.push(`U2 150-row truncation notice/position is wrong: ${text.slice(0, 800)}`);
  } else process.stdout.write('ok   U2 surfaces showing 100 of 150 and stops at #100\n');
  extraChecks += 1;
  const rows = [...view.host.querySelectorAll('.rl-log-row')];
  const hundredth = rows.find((row) => (row.textContent ?? '').includes('#100'));
  if (!hundredth || !(hundredth.textContent ?? '').includes('maxRunningNodes=4')) {
    extraFailures.push(`U2 row #100 has no facts.why reason: ${hundredth?.textContent ?? 'missing'}`);
  } else process.stdout.write('ok   U2 puts facts.why on the rendered row beyond the first five\n');
  await React.act(async () => view.root.unmount()); view.restore(); view.host.remove();
}
{
  const payload = (url) => {
    const text = String(url);
    if (text.includes('/events')) return { events: [{ seq: 1, type: 'node/failed', nodeId: 'n1', at: Date.now(), error: { stage: 'dispatch', role: 'worker', timeoutMs: 30000 } }] };
    return {};
  };
  const view = await renderWith(components.EventTimelinePanel, async (url) => ({ ok: true, status: 200, json: async () => payload(url), text: async () => JSON.stringify(payload(url)) }));
  extraChecks += 1;
  const text = view.host.textContent ?? '';
  if (!text.includes('stage dispatch') || !text.includes('role worker') || !text.includes('timeout 30000ms')) {
    extraFailures.push(`U3 event row missing failure attribution: ${text.slice(0, 500)}`);
  } else process.stdout.write('ok   U3 event row shows failure stage/role/timeout\n');
  await React.act(async () => view.root.unmount()); view.restore(); view.host.remove();
}
{
  const saved = globalThis.fetch;
  let release = null;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/events')) {
      return { ok: true, status: 200, json: () => new Promise((resolve) => { release = () => resolve({ events: [] }); }), text: async () => '{}' };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
  };
  const host = window.document.createElement('div');
  window.document.body.appendChild(host);
  const root = createRoot(host);
  await React.act(async () => { root.render(React.createElement(Boundary, null, React.createElement(components.EventTimelinePanel, base))); await Promise.resolve(); });
  extraChecks += 1;
  const pendingText = host.textContent ?? '';
  if (!pendingText.includes('common.loading') || !pendingText.includes('Retry')) {
    extraFailures.push(`U12 EventTimeline lacks loading/retry: ${pendingText.slice(0, 500)}`);
  } else process.stdout.write('ok   U12 EventTimeline shows loading and retry before the first payload\n');
  if (release) await React.act(async () => { release(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  await React.act(async () => root.unmount());
  globalThis.fetch = saved;
  host.remove();
}

{
  const saved = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/events')) {
      attempts += 1;
      if (attempts === 1) throw new Error('events exploded');
      return { ok: true, status: 200, json: async () => ({ events: [{ seq: 7, type: 'node/completed', nodeId: 'n7', at: Date.now() }] }), text: async () => '{}' };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
  };
  const host = window.document.createElement('div');
  window.document.body.appendChild(host);
  const root = createRoot(host);
  await React.act(async () => {
    root.render(React.createElement(Boundary, null, React.createElement(components.EventTimelinePanel, base)));
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  extraChecks += 1;
  const errorText = host.textContent ?? '';
  if (!errorText.includes('events exploded') || errorText.includes('No events yet.')) {
    extraFailures.push(`U12 EventTimeline error state is wrong: ${errorText.slice(0, 500)}`);
  } else process.stdout.write('ok   U12 EventTimeline shows the error without an empty-state claim\n');
  const retry = [...host.querySelectorAll('button')].find((button) => (button.textContent ?? '').includes('Retry'));
  if (!retry) extraFailures.push('U12 EventTimeline error state has no Retry button');
  else {
    await React.act(async () => { retry.click(); await new Promise((resolve) => setTimeout(resolve, 50)); });
    extraChecks += 1;
    if (!(host.textContent ?? '').includes('#7')) extraFailures.push(`U12 Retry did not re-fetch: ${(host.textContent ?? '').slice(0, 500)}`);
    else process.stdout.write('ok   U12 Retry re-fetches after an error\n');
  }
  await React.act(async () => root.unmount());
  globalThis.fetch = saved;
  host.remove();
}

// U12: every new panel must expose loading + Retry before its first payload.
{
  const panelCases = [
    ['DispatchQueue', components.DispatchQueuePanel],
    ['ClaimEvidence', components.ClaimEvidencePanel],
    ['ExpertLibrary', components.ExpertLibraryPanel],
    ['DisputeTable', components.DisputeTablePanel],
  ];
  for (const [label, component] of panelCases) {
    const forever = new Promise(() => {});
    const view = await renderWith(component, async () => ({ ok: true, status: 200, json: () => forever, text: () => forever }));
    extraChecks += 1;
    const pendingText = view.host.textContent ?? '';
    const retry = [...view.host.querySelectorAll('button')].find((button) => (button.textContent ?? '').includes('Retry'));
    if (!pendingText.includes('common.loading') || !retry) {
      extraFailures.push(`U12 ${label} lacks loading/retry before the first payload: ${pendingText.slice(0, 500)}`);
    } else process.stdout.write(`ok   U12 ${label} shows loading and retry before the first payload\n`);
    await React.act(async () => view.root.unmount()); view.restore(); view.host.remove();
  }
}

// U12: a partial failure must not render an empty-state claim, and Retry must
// re-fetch a successful payload. Each panel gets its own failure injection.
{
  let stateAttempts = 0;
  const payload = (url) => {
    const text = String(url);
    if (text.includes('/state')) return { project: { id: 'p1' }, nodes: [{ id: 'q1', title: 'queued after retry', status: 'planned', priority: { class: 'p2' }, timestamps: { createdAt: 1 } }], edges: [], revision: 1 };
    if (text.includes('/status') || text.includes('/facts')) return { summary: { runnable: 1 }, nextToStart: [{ nodeId: 'q1' }], queueOrder: ['q1'] };
    if (text.includes('/metrics')) return {};
    if (text.includes('/budgets')) return { classes: [] };
    return {};
  };
  const view = await renderWith(components.DispatchQueuePanel, async (url) => {
    if (String(url).includes('/state')) {
      stateAttempts += 1;
      if (stateAttempts === 1) throw new Error('state exploded');
    }
    const data = payload(url);
    return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
  });
  extraChecks += 1;
  const failedText = view.host.textContent ?? '';
  if (!failedText.includes('state exploded') || failedText.includes('No node is running.') || failedText.includes('The executable queue is empty.') || failedText.includes('0 running')) {
    extraFailures.push(`U12 DispatchQueue partial failure rendered a false empty state: ${failedText.slice(0, 700)}`);
  } else process.stdout.write('ok   U12 DispatchQueue reports a partial failure without empty-state claims\n');
  const retry = [...view.host.querySelectorAll('button')].find((button) => (button.textContent ?? '').includes('Retry'));
  if (!retry) extraFailures.push('U12 DispatchQueue failure has no Retry button');
  else {
    await React.act(async () => { retry.click(); await new Promise((resolve) => setTimeout(resolve, 60)); });
    extraChecks += 1;
    if (!(view.host.textContent ?? '').includes('queued after retry')) extraFailures.push(`U12 DispatchQueue Retry did not re-fetch: ${(view.host.textContent ?? '').slice(0, 600)}`);
    else process.stdout.write('ok   U12 DispatchQueue Retry re-fetches after a partial failure\n');
  }
  await React.act(async () => view.root.unmount()); view.restore(); view.host.remove();
}

{
  let stateAttempts = 0;
  const fetchImpl = async (url) => {
    const text = String(url);
    let data;
    if (text.includes('/state')) {
      stateAttempts += 1;
      if (stateAttempts === 1) throw new Error('claims state exploded');
      data = { project: { id: 'p1' }, nodes: [{ id: 'c1', title: 'claimed', status: 'planned', claim: { status: 'held' } }], edges: [], revision: 1 };
    } else if (text.includes('/intents')) data = { intents: [] };
    else data = {};
    return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
  };
  const view = await renderWith(components.ClaimEvidencePanel, fetchImpl);
  extraChecks += 1;
  const failedText = view.host.textContent ?? '';
  if (!failedText.includes('claims state exploded') || failedText.includes('No dispatch claim, preemption, or p0 priority is recorded.') || failedText.includes('No judgement intents have been recorded.') || failedText.includes('0 node claims')) {
    extraFailures.push(`U12 ClaimEvidence partial failure rendered a false empty state: ${failedText.slice(0, 700)}`);
  } else process.stdout.write('ok   U12 ClaimEvidence reports a partial failure without empty-state claims\n');
  const retry = [...view.host.querySelectorAll('button')].find((button) => (button.textContent ?? '').includes('Retry'));
  if (!retry) extraFailures.push('U12 ClaimEvidence failure has no Retry button');
  else {
    await React.act(async () => { retry.click(); await new Promise((resolve) => setTimeout(resolve, 60)); });
    extraChecks += 1;
    if (!(view.host.textContent ?? '').includes('c1')) extraFailures.push(`U12 ClaimEvidence Retry did not re-fetch: ${(view.host.textContent ?? '').slice(0, 600)}`);
    else process.stdout.write('ok   U12 ClaimEvidence Retry re-fetches after a partial failure\n');
  }
  await React.act(async () => view.root.unmount()); view.restore(); view.host.remove();
}

{
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('experts exploded');
    const data = { experts: [{ id: 'e1', name: 'expert after retry', lifecycle: { status: 'catalog' }, metrics: {} }], curator: { status: 'open' } };
    return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
  };
  const view = await renderWith(components.ExpertLibraryPanel, fetchImpl);
  extraChecks += 1;
  const failedText = view.host.textContent ?? '';
  if (!failedText.includes('experts exploded') || failedText.includes('The Host returned no expert descriptors.') || failedText.includes('0 experts')) {
    extraFailures.push(`U12 ExpertLibrary error plus empty state: ${failedText.slice(0, 700)}`);
  } else process.stdout.write('ok   U12 ExpertLibrary reports an error without an empty-state claim\n');
  const retry = [...view.host.querySelectorAll('button')].find((button) => (button.textContent ?? '').includes('Retry'));
  if (!retry) extraFailures.push('U12 ExpertLibrary failure has no Retry button');
  else {
    await React.act(async () => { retry.click(); await new Promise((resolve) => setTimeout(resolve, 60)); });
    extraChecks += 1;
    if (!(view.host.textContent ?? '').includes('expert after retry')) extraFailures.push(`U12 ExpertLibrary Retry did not re-fetch: ${(view.host.textContent ?? '').slice(0, 600)}`);
    else process.stdout.write('ok   U12 ExpertLibrary Retry re-fetches after an error\n');
  }
  await React.act(async () => view.root.unmount()); view.restore(); view.host.remove();
}

{
  let attempts = 0;
  const fetchImpl = async (url) => {
    const text = String(url);
    let data;
    if (text.includes('/disputes/classes')) data = { classes: { fact_conflict: { authority: 'code' } } };
    else if (text.includes('/disputes')) {
      attempts += 1;
      if (attempts === 1) throw new Error('disputes exploded');
      data = { disputes: [{ id: 'd1', type: 'fact_conflict', status: 'pending', source: 'dispute', target: { nodeId: 'n1' } }] };
    } else data = {};
    return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
  };
  const view = await renderWith(components.DisputeTablePanel, fetchImpl);
  extraChecks += 1;
  const failedText = view.host.textContent ?? '';
  if (!failedText.includes('disputes exploded') || failedText.includes('No appeal or dispute has been opened.') || failedText.includes('0 disputes')) {
    extraFailures.push(`U12 DisputeTable error plus empty state: ${failedText.slice(0, 700)}`);
  } else process.stdout.write('ok   U12 DisputeTable reports an error without an empty-state claim\n');
  const retry = [...view.host.querySelectorAll('button')].find((button) => (button.textContent ?? '').includes('Retry'));
  if (!retry) extraFailures.push('U12 DisputeTable failure has no Retry button');
  else {
    await React.act(async () => { retry.click(); await new Promise((resolve) => setTimeout(resolve, 60)); });
    extraChecks += 1;
    if (!(view.host.textContent ?? '').includes('1 disputes')) extraFailures.push(`U12 DisputeTable Retry did not re-fetch: ${(view.host.textContent ?? '').slice(0, 600)}`);
    else process.stdout.write('ok   U12 DisputeTable Retry re-fetches after an error\n');
  }
  await React.act(async () => view.root.unmount()); view.restore(); view.host.remove();
}

const totalChecks = names.length + (typeof components.DashboardPanel === 'function' ? 1 : 0) + extraChecks;
failures.push(...extraFailures);
if (failures.length > 0) {
  for (const failure of failures) process.stdout.write(`FAIL ${failure}\n`);
  process.stdout.write(`${totalChecks - failures.length}/${totalChecks} panel smoke checks passed\n`);
  process.exit(1);
}
process.stdout.write(`${totalChecks}/${totalChecks} panel smoke checks passed\n`);
