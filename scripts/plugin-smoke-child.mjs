/**
 * Process-level smoke child: activate the real Host entry (`index.js`) with a
 * Host-like context, create a project in a temp git repo, start one node with a
 * stub worker, and wait for `node/completed`. The parent asserts the JSON and
 * that this process exited without an uncaught exception.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { apply, name, inject } from '../index.js';

const repoPath = process.env.MIRL_SMOKE_REPO;
const declaredPresets = new Set([...(await readFile(new URL('../presets.patch.yml', import.meta.url), 'utf8')).matchAll(/^ {8}id: (lab-[a-z-]+)$/gm)].map((match) => match[1]));
assert.ok(repoPath, 'MIRL_SMOKE_REPO is required');
const startupRoot = process.env.MIRL_STARTUP_ROOT;
const home = startupRoot ?? await mkdtemp(path.join(os.tmpdir(), 'mirl-smoke-home-'));
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

/**
 * Reproduce the real JSON backend's open contract for a startup test: table
 * names must match UNIT_NAME_RE, and a declared-but-missing table loads empty.
 * `MIRL_STARTUP_ROOT` points at an existing unit created without actor_keys.
 */
function existingUnitDomain(root) {
  const unitDir = path.join(root, 'storages', 'metainfer_research_lab_v2');
  return {
    async open(spec) {
      if (!/^[a-z][a-z0-9_]*$/.test(spec.name)) throw new Error(`invalid unit name '${spec.name}'`);
      const names = Object.keys(spec.tables);
      for (const table of names) {
        if (!/^[a-z][a-z0-9_]*$/.test(table)) throw new Error(`invalid table name '${table}' in unit '${spec.name}'`);
      }
      const tables = new Map();
      for (const table of names) {
        const records = new Map();
        try {
          for (const file of await readdir(path.join(unitDir, table))) {
            if (!file.endsWith('.json')) continue;
            const document = JSON.parse(await readFile(path.join(unitDir, table, file), 'utf8'));
            if (document?.version === spec.version) records.set(file.slice(0, -5), document.record);
          }
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        tables.set(table, records);
      }
      return {
        table(name) {
          if (!names.includes(name)) throw new Error(`unit '${spec.name}' does not declare table '${name}'`);
          const data = tables.get(name);
          return {
            get: (key) => data.get(key),
            entries: () => data.entries(),
            keys: () => data.keys(),
            get size() { return data.size; },
            put: async (key, value) => {
              data.set(key, value);
              await mkdir(path.join(unitDir, name), { recursive: true });
              await writeFile(path.join(unitDir, name, `${key}.json`), JSON.stringify({ version: spec.version, record: value }, null, 2));
            },
            delete: async (key) => { data.delete(key); },
          };
        },
        close: async () => {},
      };
    },
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
const sessionEventHandlers = [];
let service = null;
const subagents = {
  async startActivation(options) {
    const sessionId = options.childId;
    const cwd = options.request?.cwd;
    const append = () => {};
    agents.set(sessionId, { session: { id: sessionId, header: { cwd }, append } });
    return {
      // Keep the turn open long enough for the process smoke to deliver a real
      // session event while the node is still running, not just at turn/end.
      result: new Promise((resolve) => setTimeout(() => resolve({
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
      }), 300)),
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
    open: async (spec) => (startupRoot ? (await existingUnitDomain(startupRoot).open(spec)) : memoryDomain()),
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
  agentPresets: {
    resolve: async (id) => {
      if (!declaredPresets.has(id)) throw new Error(`Unknown agent preset: ${id}`);
      return { id };
    },
    list: async () => [...declaredPresets].map((id) => ({ id })),
    mount: async (_ctx, id) => {
      if (!declaredPresets.has(id)) throw new Error(`Unknown agent preset: ${id}`);
    },
  },
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
  on: (name, handler) => {
    if (name === 'session/event') sessionEventHandlers.push(handler);
    return () => {};
  },
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

  if (startupRoot) {
    // The existing unit has no actor_keys directory. The first actor-key put
    // must materialise the declared table; a second process must read it back.
    const { issueActorKeyForRegistration, flushActorKeyStore, actorKeyRecords } = await import('../host/kernel/actors.js');
    issueActorKeyForRegistration({ sessionId: 'startup-probe', projectId: 'prj-startup' });
    await flushActorKeyStore();
    const projects = await service.listProjects();
    process.stdout.write(`${JSON.stringify({ status: 'startup-ok', projects: projects.length, projectIds: projects.map((row) => row.id), keys: actorKeyRecords().length })}\n`);
    process.exit(0);
  }
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
  const startedNode = service.getNode(projectId, nodeId)?.node;
  assert.equal(startedNode?.status, 'running', 'node did not enter running state before activity probe');
  assert.ok(sessionEventHandlers.length > 0, 'plugin did not subscribe to session/event');
  const startedAt = startedNode.timestamps?.lastActivityAt ?? startedNode.timestamps?.startedAt;
  await sessionEventHandlers[0](
    { id: startedNode.sessionId },
    { type: 'assistant/message', time: Date.now(), data: { turnId: 'smoke-turn-1' } },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  const activeNode = service.getNode(projectId, nodeId)?.node;
  const activityAdvanced = Number(activeNode?.timestamps?.lastActivityAt ?? 0) > Number(startedAt ?? 0);
  const activeExplanation = service.explainNode(projectId, nodeId, { window: 200 });
  const activityEvent = Array.isArray(activeExplanation.events)
    && activeExplanation.events.some((event) => event.type === 'node/activity');
  assert.equal(activityAdvanced, true, 'turn-internal event did not move lastActivityAt');
  assert.equal(activityEvent, true, 'node/activity was not written before turn/end');

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

  // 5.3.2/Q3 process probe: start a second real runtime node, then preempt it
  // through the same runtime path the dispatcher uses. The activation result is
  // still pending when terminate disposes it, so an unhandled rejection here
  // would fail the child.
  const successor = await service.createSuccessor(projectId, nodeId, {
    title: 'preemption victim',
    prompt: 'stay running until the p0 preemption probe terminates this node',
  });
  const victimId = successor.node.id;
  await service.startNode(projectId, victimId);
  assert.equal(service.getNode(projectId, victimId)?.node?.status, 'running');
  const preempted = await service.preemptNode(projectId, victimId, {
    forNodeId: 'p0-smoke',
    reason: 'process smoke: p0 needs the slot',
    by: 'dispatcher',
  });
  const preemptedNode = preempted.node ?? service.getNode(projectId, victimId)?.node;
  const preemptionExplanation = service.explainNode(projectId, victimId, { window: 200 });
  const preemptionEvent = Array.isArray(preemptionExplanation.events)
    && preemptionExplanation.events.some((event) => event.type === 'node/preempted');
  assert.equal(preemptedNode?.status, 'cancelled');
  assert.equal(preemptedNode?.preemption?.forNodeId, 'p0-smoke');
  assert.equal(preemptedNode?.preemption?.appeal?.status, 'open');
  assert.equal(preemptedNode?.preemption?.appeal?.endpoint, '/api/metainfer-research-lab/preemption/appeal');
  assert.equal(preemptionEvent, true, 'node/preempted missing from explanation');
  const appealed = await service.appealPreemption(projectId, victimId, {
    reason: 'smoke: record and review the preemption',
  }, { kind: 'human', id: 'smoke-operator' });
  const appealedNode = appealed.node ?? service.getNode(projectId, victimId)?.node;
  assert.equal(appealedNode?.preemption?.appeal?.status, 'appealed');
  assert.equal(appealedNode?.preemption?.appeal?.reason, 'smoke: record and review the preemption');
  const appealedExplanation = service.explainNode(projectId, victimId, { window: 200 });
  assert.equal(
    Array.isArray(appealedExplanation.events)
      && appealedExplanation.events.some((event) => event.type === 'node/preemption_appealed'),
    true,
    'node/preemption_appealed missing from explanation',
  );
  await new Promise((resolve) => setTimeout(resolve, 350));

  process.stdout.write(`${JSON.stringify({
    status: node.status,
    reportSummary: node.report.summary,
    causeId: explanation.node.causeId,
    chainLength: explanation.causeChain.length,
    chainFirst: explanation.causeChain[0]?.ref?.type ?? null,
    completedEvent: explanation.events.some((event) => event.type === 'node/completed'),
    activityAdvanced,
    activityEvent,
    preemptionStatus: preemptedNode?.status,
    preemptionFor: preemptedNode?.preemption?.forNodeId,
    preemptionAppeal: appealedNode?.preemption?.appeal?.status,
    preemptionAppealReason: appealedNode?.preemption?.appeal?.reason,
    preemptionEvent,
    preemptionAppealedEvent: appealedExplanation.events.some((event) => event.type === 'node/preemption_appealed'),
    eventCount: explanation.events.length,
  })}\n`);
} catch (error) {
  failure = error;
} finally {
  for (const dispose of disposers.reverse()) {
    try { await dispose(); } catch {}
  }
  if (!startupRoot) await rm(home, { recursive: true, force: true }).catch(() => {});
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
