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

if (failures.length > 0) {
  for (const failure of failures) process.stdout.write(`FAIL ${failure}\n`);
  process.stdout.write(`${names.length - failures.length}/${names.length} panel smoke checks passed\n`);
  process.exit(1);
}
process.stdout.write(`${names.length}/${names.length} panel smoke checks passed\n`);
