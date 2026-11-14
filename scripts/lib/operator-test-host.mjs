/** Inert actual-index fixture. No live Host, credentials, models, SSH or user data. */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../../index.js';
import { memoryDomain } from './memory-domain.mjs';

export async function createOperatorTestHost({ fixedNow } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'mirl-operator-test-'));
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const disposers = [];
  const routes = new Map();
  const browserPeer = { principal: { kind: 'owner' } };
  const apiPeer = { principal: { kind: 'owner' } };
  const guestPeer = { principal: { kind: 'guest' } };
  let mode = 'browser';
  let service;
  let closed = false;
  const connection = {
    browserPeer,
    admit() {
      if (mode === 'anonymous') return { rejection: 401 };
      if (mode === 'untrusted') return { rejection: 403 };
      return { peer: mode === 'api' ? apiPeer : mode === 'guest' ? guestPeer : browserPeer };
    },
    fetch: { register(route) {
      for (const method of route.methods) routes.set(method + ' ' + route.path, route);
      return () => { for (const method of route.methods) routes.delete(method + ' ' + route.path); };
    } },
  };
  const domain = memoryDomain();
  const never = () => { throw new Error('unexpected real subsystem invocation'); };
  const ctx = {
    config: { kernel: { hotEvents: 1000, eventArchiveRoot: path.join(home, 'eventlog') } },
    logger: { info() {}, warn() {}, error() {} },
    storageDomain: { get: () => undefined, open: async () => domain },
    subprocess: { spawn: never },
    agents: { create: never, get: () => null },
    agentPresets: { resolve: async (id) => ({ id }), list: async () => [], mount: async () => {} },
    subagents: { startActivation: never },
    agentDefaultModel: { currentSelection: () => ({ provider: 'inert', model: 'inert' }) },
    llm: {}, sessionQuery: { readSurface: async () => ({ events: [] }) }, sessions: {},
    tools: { register: () => () => {} }, connection,
    provide(key, value) { if (key === 'metainferLab') service = value; },
    // Absence reproduces activation before a webServer/index injection exists.
    get(key) { return key === 'subprocess' ? ctx.subprocess : null; },
    on: () => () => {},
    effect(factory) { const dispose = factory(); if (typeof dispose === 'function') disposers.push(dispose); return dispose; },
  };
  async function close() {
    if (closed) return;
    closed = true;
    for (const dispose of disposers.reverse()) await dispose();
    if (process.env.DSH_HOME === home) {
      if (oldHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = oldHome;
    }
    await rm(home, { recursive: true, force: true });
  }
  const oldNow = Date.now;
  try {
    if (fixedNow !== undefined) Date.now = () => fixedNow;
    await apply(ctx, { kernel: { strictWrites: 'throw' } });
  } catch (error) {
    await close();
    throw error;
  } finally { Date.now = oldNow; }
  return {
    service, connection, routes, close,
    setMode(value) { mode = value; },
    // Contract-shaped carrier: real SDK admission is checked separately by the
    // private packaged-SDK conformance runner; this is explicitly an inert mock.
    async request(url, init = {}) {
      const parsed = new URL(String(url), 'http://localhost');
      const method = init.method ?? 'GET';
      const route = routes.get(method + ' ' + parsed.pathname);
      if (!route) return new Response(JSON.stringify({ ok: false, error: { code: 'not_found' } }), { status: 404 });
      return route.fetch(new Request(parsed, { ...init, method }));
    },
  };
}
