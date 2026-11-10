/**
 * Process-level smoke child: activate the real Host entry (`index.js`) with a
 * Host-like context, create a project in a temp git repo, start one node with a
 * stub worker, and wait for `node/completed`. The parent asserts the JSON and
 * that this process exited without an uncaught exception.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { apply, name, inject } from '../index.js';

const repoPath = process.env.MIRL_SMOKE_REPO;
assert.ok(repoPath, 'MIRL_SMOKE_REPO is required');
const home = await mkdtemp(path.join(os.tmpdir(), 'mirl-smoke-home-'));
process.env.DSH_HOME = home;

let uncaught = null;
process.on('uncaughtException', (error) => { uncaught = error; });
process.on('unhandledRejection', (error) => { uncaught = error; });

function memoryDomain() {
  const tables = new Map();
  return {
    table(name) {
      if (!tables.has(name)) tables.set(name, new Map());
      const data = tables.get(name);
      return {
        get: (key) => data.get(key),
        entries: () => data.entries(),
        keys: () => data.keys(),
        get size() { return data.size; },
        put: async (key, value) => { data.set(key, value); },
        delete: async (key) => data.delete(key),
      };
    },
    close: async () => {},
  };
}

/** The DSH subprocess seam, backed by a real child process for git. */
function subprocessSeam() {
  return {
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: { ...process.env, ...spec.env } });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const done = new Promise((resolve, reject) => {
        child.on('close', (exitCode, signal) => resolve({ exitCode, signal }));
        child.on('error', reject);
      });
      spec.signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
      return {
        control: undefined,
        collected: {
          stdout: { readFrom: () => ({ text: stdout, nextOffset: stdout.length, lossy: false }) },
          stderr: { readFrom: () => ({ text: stderr, nextOffset: stderr.length, lossy: false }) },
        },
        done,
        terminate() { child.kill('SIGTERM'); },
        waitForExit: async () => true,
      };
    },
  };
}

const agents = new Map();
const disposers = [];
let service = null;
const subagents = {
  async startActivation(options) {
    const sessionId = options.childId;
    const cwd = options.request?.cwd;
    const append = () => {};
    agents.set(sessionId, { session: { id: sessionId, header: { cwd }, append } });
    return {
      result: Promise.resolve({
        stopReason: 'completed',
        output: [{ type: 'text', text: 'stub worker finished' }],
        structured: {
          summary: 'stub worker completed the smoke node',
          success: true,
          changes: ['README.md'],
          next: [],
        },
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        threadId: 'stub-thread',
      }),
      dispose: async () => {},
    };
  },
};

const ctx = {
  config: {
    kernel: { hotEvents: 1000, eventArchiveRoot: path.join(home, 'eventlog') },
  },
  logger: { info() {}, warn() {}, error() {} },
  storageDomain: {
    get: () => undefined,
    open: async () => memoryDomain(),
  },
  subprocess: subprocessSeam(),
  agents: {
    async create(options) {
      const sessionId = options.sessionId;
      const cwd = options.meta?.cwd;
      const session = { id: sessionId, header: { cwd }, append() {} };
      agents.set(sessionId, { session });
      if (typeof options.setup === 'function') await options.setup({});
      return { agent: { session }, dispose: async () => { agents.delete(sessionId); } };
    },
    get: (sessionId) => agents.get(sessionId) ?? null,
  },
  agentPresets: { mount: async () => {} },
  subagents,
  agentDefaultModel: { currentSelection: () => ({ provider: 'stub-provider', model: 'stub-model' }) },
  llm: {},
  sessionQuery: { readSurface: async () => ({ events: [] }) },
  sessions: {},
  tools: { register: () => () => {} },
  connection: { fetch: { register: () => () => {} } },
  provide: (key, value) => { if (key === 'metainferLab') service = value; },
  get: (key) => {
    if (key === 'subprocess') return ctx.subprocess;
    if (key === 'jobs') return null;
    return null;
  },
  on: () => () => {},
  effect: (factory) => {
    const dispose = factory();
    if (typeof dispose === 'function') disposers.push(dispose);
  },
};

let failure = null;
try {
  assert.equal(name, 'metainfer-research-lab');
  assert.ok(Array.isArray(inject) && inject.includes('storageDomain'));
  await apply(ctx, { kernel: { strictWrites: 'throw' } });
  assert.ok(service, 'apply did not provide metainferLab');

  const created = await service.createProject({
    name: 'smoke',
    brief: 'process smoke',
    repoPath,
    initialPrompt: 'complete one end-to-end smoke node',
    config: { maxRunningNodes: 1, maxNodes: 10, nodeTimeoutMinutes: 1, resourcePools: {} },
  });
  const projectId = created.project.id;
  const nodeId = created.rootNode.id;
  await service.startNode(projectId, nodeId);

  let node = null;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    node = service.getNode(projectId, nodeId)?.node;
    if (node?.status === 'completed' || node?.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(node?.status, 'completed', `node did not complete (status=${node?.status}, error=${node?.error ?? 'none'})`);
  assert.ok(node.report?.summary, 'completed node has no report summary');
  const explanation = service.explainNode(projectId, nodeId, { window: 200 });
  assert.equal(explanation.ok, true);
  assert.ok(Array.isArray(explanation.causeChain) && explanation.causeChain.length > 0, 'cause chain is empty');
  assert.ok(Array.isArray(explanation.events) && explanation.events.some((event) => event.type === 'node/completed'), 'node/completed missing from explanation');

  process.stdout.write(`${JSON.stringify({
    status: node.status,
    reportSummary: node.report.summary,
    causeId: explanation.node.causeId,
    chainLength: explanation.causeChain.length,
    chainFirst: explanation.causeChain[0]?.ref?.type ?? null,
    completedEvent: explanation.events.some((event) => event.type === 'node/completed'),
    eventCount: explanation.events.length,
  })}\n`);
} catch (error) {
  failure = error;
} finally {
  for (const dispose of disposers.reverse()) {
    try { await dispose(); } catch {}
  }
  await rm(home, { recursive: true, force: true }).catch(() => {});
}
if (uncaught) {
  process.stderr.write(`uncaught: ${uncaught?.stack ?? uncaught}\n`);
  process.exit(1);
}
if (failure) {
  process.stderr.write(`${failure?.stack ?? failure}\n`);
  process.exit(1);
}
process.exit(0);
