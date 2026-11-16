/**
 * Offline M1 self-test: real git against the demo repo, in-memory storage domain,
 * and a local subprocess provider that mirrors the DSH subprocess seam.
 *
 * Run from the plugin directory: `node scripts/selftest.mjs`
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../host/store.js';
import { createGitEngine } from '../host/git-engine.js';
import { createLabService } from '../host/lab-service.js';
import { registerHttpRoutes } from '../host/http.js';
import { registerAgentTool } from '../host/agent-tool.js';

const DEMO_REPO = process.env.MIRL_DEMO_REPO
  ? path.resolve(process.env.MIRL_DEMO_REPO)
  : path.resolve(process.cwd(), '..', 'metainfer-demo-repo');
const NON_REPO_DIR = await mkdtemp(path.join(os.tmpdir(), 'mirl-nonrepo-'));

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

function fakeSubprocess() {
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
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
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

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(['PASS', name]);
  } catch (error) {
    results.push(['FAIL', name, error?.stack || String(error)]);
  }
}

const store = await openStore({ storageDomain: { open: async () => memoryDomain() }, logger: { info() {} } });
const git = createGitEngine({ subprocess: fakeSubprocess() });
const timeboxEdits = [];
let modelLookups = 0;
const lab = createLabService({
  ctx: {
    agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
    llm: { listProviders: () => { modelLookups += 1; return []; } },
  },
  store,
  git,
  transcript: { read: async () => ({ rows: [], nextSeq: 0, running: false }) },
  runtime: {
    retry: async () => ({ node: { id: 'n-0001', status: 'running' }, revision: 1 }),
    decorateNodes: (_projectId, nodes) => nodes,
    updateTimebox: async (projectId, nodeId, timeboxMs) => store.withProjectLock(projectId, async () => {
      timeboxEdits.push({ projectId, nodeId, timeboxMs });
      const currentProject = store.getProject(projectId);
      const node = store.getNode(projectId, nodeId);
      node.timeboxMs = timeboxMs;
      currentProject.revision += 1;
      await store.saveNode(projectId, node);
      await store.saveProject(currentProject);
      return { node, revision: currentProject.revision };
    }),
  },
  auto: {
    stop: async () => ({ status: 'off' }),
    forget: () => {},
    statusOf: () => ({ status: 'off', pauseReason: null }),
  },
  clusterAdmin: {
    getConfigPayload: () => ({ path: path.join(os.tmpdir(), 'cluster.json'), config: { enabled: false }, status: { enabled: false, mode: 'local' }, activeLeases: 0, canApply: true, warnings: [] }),
    applyConfig: async (patch) => ({ path: path.join(os.tmpdir(), 'cluster.json'), config: { enabled: false, ...patch }, status: { enabled: false, mode: 'local' }, activeLeases: 0, canApply: true, warnings: [] }),
  },
  orchestrator: {
    step: async () => ({ cycle: { id: 'cyc-test' }, created: [], started: [], skipped: [], errors: [] }),
    createSuccessor: async () => ({ node: { id: 'n-0002' }, revision: 1 }),
    listRuns: async () => ({ runs: [], cycles: [] }),
    getRun: async () => ({ run: { id: 'run-test' } }),
  },
  version: 'selftest',
});

await test('validateRepo(demo repo)', async () => {
  const repo = await git.validateRepo(DEMO_REPO);
  assert.ok(repo.repoRoot.endsWith('metainfer-demo-repo'));
  assert.ok(repo.branches.length >= 1);
  assert.match(repo.baseCommit, /^[0-9a-f]{40}$/);
});

await test('validateRepo(non-repo) is rejected', async () => {
  await assert.rejects(() => git.validateRepo(NON_REPO_DIR), (error) => error.code === 'not_git');
});

await test('validateRepo(relative path) is rejected', async () => {
  await assert.rejects(() => git.validateRepo('relative/path'), (error) => error.code === 'bad_path');
});

let project;
let rootNode;
await test('createProject', async () => {
  const result = await lab.createProject({
    name: 'Selftest project',
    brief: 'Toy linear-regression experiments to verify M1 plumbing.',
    repoPath: DEMO_REPO,
    initialPrompt: 'Run a learning-rate sweep on the demo repo and report validation loss.',
    config: { resourcePools: { gpu: 1 }, maxRunningNodes: 2, maxNodes: 10, nodeTimeoutMinutes: 10 },
  });
  project = result.project;
  rootNode = result.rootNode;
  assert.equal(rootNode.status, 'planned');
  assert.equal(rootNode.git.baseCommit, project.repo.baseCommit);
  assert.ok(rootNode.git.worktreePath.startsWith(project.repo.worktreeRoot));
  assert.equal(project.counters.nodes, 1);
  assert.equal(project.counters.eventSeq, 2);
  assert.equal(project.mode, 'manual');
});

await test('getState and revision short-circuit', async () => {
  const state = await lab.getState(project.id);
  assert.equal(state.nodes.length, 1);
  assert.equal(state.edges.length, 0);
  assert.equal(state.revision, 1);
  assert.equal(state.resources.free.gpu, 1);
  const unchanged = await lab.getState(project.id, '1');
  assert.equal(unchanged.unchanged, true);
});

await test('updateNode (prompt edit) bumps revision and event', async () => {
  const result = await lab.updateNode(project.id, 'n-0001', {
    prompt: 'Run a ridge sweep, compare val loss, and write a reproducible report.',
  });
  assert.equal(result.revision, 2);
  assert.ok(result.node.prompt.includes('ridge'));
  const state = await lab.getState(project.id);
  assert.equal(state.nodes[0].prompt, result.node.prompt);
});

await test('updateProject (brief) bumps revision', async () => {
  const result = await lab.updateProject(project.id, { brief: 'Updated M1 self-test brief.' });
  assert.equal(result.revision, 3);
  assert.equal(result.project.brief, 'Updated M1 self-test brief.');
});

await test('events are ordered and paged', async () => {
  const all = await lab.getEvents(project.id, 0);
  assert.equal(all.events.length, 4);
  assert.equal(all.next, 4);
  assert.deepEqual(all.events.map((event) => event.seq), [1, 2, 3, 4]);
  const tail = await lab.getEvents(project.id, 3);
  assert.equal(tail.events.length, 1);
});

await test('listProjects summary', async () => {
  const list = await lab.listProjects();
  assert.equal(list.length, 1);
  assert.equal(list[0].nodeCount, 1);
  assert.equal(list[0].id, project.id);
  assert.equal(path.resolve(list[0].repoPath), DEMO_REPO);
});

await test('reject invalid config', async () => {
  await assert.rejects(
    () => lab.createProject({
      name: 'Invalid',
      brief: 'brief',
      repoPath: DEMO_REPO,
      initialPrompt: '0123456789',
      config: { resourcePools: { gpu: -1 } },
    }),
    (error) => error.code === 'bad_request',
  );
});

await test('retryNode delegates to runtime', async () => {
  const result = await lab.retryNode(project.id, 'n-0001');
  assert.equal(result.node.id, 'n-0001');
});

await test('deleteProject removes all records', async () => {
  const created = await lab.createProject({
    name: 'Delete me',
    brief: 'Temporary project for the delete-path self-test.',
    repoPath: DEMO_REPO,
    initialPrompt: 'Run one tiny command and report the result.',
  });
  const deleted = await lab.deleteProject(created.project.id, { removeWorktrees: false });
  assert.equal(deleted.deleted, true);
  const list = await lab.listProjects();
  assert.ok(!list.some((entry) => entry.id === created.project.id));
  await assert.rejects(() => lab.getState(created.project.id), (error) => error.code === 'project_not_found');
});

await test('reject unknown project', async () => {
  await assert.rejects(() => lab.getState('prj-missing'), (error) => error.code === 'project_not_found');
});

await test('health', async () => {
  const health = await lab.health();
  assert.equal(health.storage, 'ready');
  assert.equal(health.projects, 1);
});

// ---------------------------------------------------------------------------
// HTTP route contract (same JSON envelopes the Client half calls)
// ---------------------------------------------------------------------------
const routes = [];
const disposeRoutes = registerHttpRoutes(
  { connection: { fetch: { register(route) { routes.push(route); return () => Promise.resolve(); } } } },
  lab,
);
const PREFIX = '/api/metainfer-research-lab';
function findRoute(pathname, method) {
  const route = routes.find((candidate) => candidate.path === pathname && candidate.methods.includes(method));
  assert.ok(route, `route ${method} ${pathname} is registered`);
  return route;
}
async function callHttp(pathname, { method = 'GET', query = '', rawBody = undefined } = {}) {
  const route = findRoute(pathname, method);
  const request = new Request(`http://local${pathname}${query}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : (rawBody ?? '{}'),
  });
  const response = await route.fetch(request);
  assert.equal(response.status, 200);
  return response.json();
}

await test('routes: all current endpoints registered', async () => {
  assert.equal(routes.length, 22);
  const expected = [
    [`${PREFIX}/health`, 'GET'],
    [`${PREFIX}/projects`, 'GET'],
    [`${PREFIX}/projects`, 'POST'],
    [`${PREFIX}/repo`, 'GET'],
    [`${PREFIX}/state`, 'GET'],
    [`${PREFIX}/events`, 'GET'],
    [`${PREFIX}/transcript`, 'GET'],
    [`${PREFIX}/cluster`, 'GET'],
    [`${PREFIX}/cluster/config`, 'GET'],
    [`${PREFIX}/models`, 'GET'],
    [`${PREFIX}/chat`, 'GET'],
    [`${PREFIX}/copilot`, 'GET'],
    [`${PREFIX}/runs`, 'GET'],
    [`${PREFIX}/commands`, 'POST'],
    [`${PREFIX}/intake`, 'GET'],
    [`${PREFIX}/files/info`, 'GET'],
    [`${PREFIX}/files/download`, 'GET'],
    [`${PREFIX}/replay`, 'GET'],
    [`${PREFIX}/dashboard`, 'GET'],
    [`${PREFIX}/dashboard`, 'POST'],
    [`${PREFIX}/dashboard/refresh`, 'POST'],
    [`${PREFIX}/dashboard/chat`, 'POST'],
    [`${PREFIX}/dashboard/layout`, 'POST'],
    [`${PREFIX}/execution`, 'GET'],
  ];
  for (const [pathname, method] of expected) findRoute(pathname, method);
});

await test('HTTP health', async () => {
  const payload = await callHttp(`${PREFIX}/health`);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.storage, 'ready');
});

await test('HTTP repo validation (ok + error envelope)', async () => {
  const good = await callHttp(`${PREFIX}/repo`, { query: `?path=${encodeURIComponent(DEMO_REPO)}` });
  assert.equal(good.ok, true);
  assert.ok(good.data.repoRoot.endsWith('metainfer-demo-repo'));
  const bad = await callHttp(`${PREFIX}/repo`, { query: `?path=${encodeURIComponent(NON_REPO_DIR)}` });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'not_git');
});

await test('HTTP project list + create + state + events + edit', async () => {
  const list = await callHttp(`${PREFIX}/projects`);
  assert.equal(list.ok, true);
  assert.ok(list.data.projects.length >= 1);

  const createBody = JSON.stringify({
    name: 'HTTP project',
    brief: 'Created through the HTTP contract used by the Client half.',
    repoPath: DEMO_REPO,
    initialPrompt: 'Run a seed sweep and report mean validation loss with the exact command.',
    config: { resourcePools: { gpu: 1 }, maxRunningNodes: 2, maxNodes: 10, nodeTimeoutMinutes: 10 },
  });
  const created = await callHttp(`${PREFIX}/projects`, { method: 'POST', rawBody: createBody });
  assert.equal(created.ok, true);
  const projectId = created.data.project.id;
  assert.equal(created.data.rootNode.status, 'planned');

  const state = await callHttp(`${PREFIX}/state`, { query: `?projectId=${encodeURIComponent(projectId)}` });
  assert.equal(state.ok, true);
  assert.equal(state.data.nodes.length, 1);
  assert.equal(state.data.edges.length, 0);
  assert.equal(state.data.revision, 1);

  const unchanged = await callHttp(`${PREFIX}/state`, {
    query: `?projectId=${encodeURIComponent(projectId)}&revision=1`,
  });
  assert.equal(unchanged.data.unchanged, true);

  const events = await callHttp(`${PREFIX}/events`, { query: `?projectId=${encodeURIComponent(projectId)}&after=0` });
  assert.equal(events.ok, true);
  assert.equal(events.data.events.length, 2);
  assert.equal(events.data.next, 2);

  const edited = await callHttp(`${PREFIX}/commands`, {
    method: 'POST',
    rawBody: JSON.stringify({
      type: 'node.edit',
      projectId,
      nodeId: 'n-0001',
      prompt: 'Run a batch-size sweep and report the validation loss trend.',
    }),
  });
  assert.equal(edited.ok, true);
  assert.equal(edited.data.revision, 2);
  assert.ok(edited.data.node.prompt.includes('batch-size'));

  const transcript = await callHttp(`${PREFIX}/transcript`, {
    query: `?projectId=${encodeURIComponent(projectId)}&nodeId=n-0001&afterSeq=0`,
  });
  assert.equal(transcript.ok, true);
  assert.ok(Array.isArray(transcript.data.rows));
  assert.equal(typeof transcript.data.running, 'boolean');

  const clusterConfig = await callHttp(`${PREFIX}/cluster/config`);
  assert.equal(clusterConfig.ok, true);
  assert.equal(typeof clusterConfig.data.config, 'object');

  const updateCluster = await callHttp(`${PREFIX}/commands`, {
    method: 'POST',
    rawBody: JSON.stringify({ type: 'cluster.config', config: { enabled: false } }),
  });
  assert.equal(updateCluster.ok, true);

  const models = await callHttp(`${PREFIX}/models`, { query: `?projectId=${encodeURIComponent(projectId)}` });
  assert.equal(models.ok, true);
  assert.ok(Array.isArray(models.data.options));

  const runs = await callHttp(`${PREFIX}/runs`, { query: `?projectId=${encodeURIComponent(projectId)}` });
  assert.equal(runs.ok, true);
  assert.ok(Array.isArray(runs.data.runs));

  const step = await callHttp(`${PREFIX}/commands`, {
    method: 'POST',
    rawBody: JSON.stringify({ type: 'project.step', projectId }),
  });
  assert.equal(step.ok, true);
  assert.equal(typeof step.data.cycle, 'object');

  const unknown = await callHttp(`${PREFIX}/commands`, {
    method: 'POST',
    rawBody: JSON.stringify({ type: 'nope', projectId }),
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'unknown_command');
});

await test('HTTP malformed body returns the error envelope', async () => {
  const payload = await callHttp(`${PREFIX}/commands`, { method: 'POST', rawBody: 'not-json' });
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'bad_request');
});

// The runtime double checks dispatch only; real deadline/cancel/persistence paths
// are exercised by runtime-lifecycle-selftest.mjs with controlled clocks.
const editingTemplate = structuredClone(store.getNode(project.id, rootNode.id));
async function editingNode(status = 'planned') {
  const node = { ...structuredClone(editingTemplate), status };
  project.config.maxNodeTimeoutMinutes = 240;
  await store.saveNode(project.id, node);
  return node;
}

await test('strict timebox validation happens before any planned-field mutation', async () => {
  for (const minutes of [0, -1, 2.5, NaN, Infinity, null, undefined, '20', 241, 1441]) {
    const node = await editingNode();
    const before = structuredClone(node);
    const revision = project.revision;
    const calls = timeboxEdits.length;
    await assert.rejects(() => lab.updateNode(project.id, node.id, { title: 'Must not be stored', timeboxMinutes: minutes }),
      (error) => error.code === 'timebox_invalid');
    assert.deepEqual(store.getNode(project.id, node.id), before);
    assert.equal(project.revision, revision);
    assert.equal(timeboxEdits.length, calls);
  }
});

await test('timebox-only edits delegate for running and retryable terminal nodes without starting', async () => {
  for (const status of ['running', 'completed', 'failed', 'cancelled', 'planned', 'proposed']) {
    const node = await editingNode(status);
    const calls = timeboxEdits.length;
    const result = await lab.updateNode(project.id, node.id, { timeboxMinutes: 120 });
    assert.equal(result.node.status, status);
    assert.equal(result.node.timeboxMs, 120 * 60_000);
    assert.equal(timeboxEdits.length, calls + 1);
  }
});

await test('live mixed edits reject atomically before model capability lookup', async () => {
  for (const field of [{ title: 'No change' }, { prompt: 'Do not replace a live task' }, { model: null },
    { model: { provider: 'missing-provider', model: 'missing-model' } }, { needs: { gpu: 2 } },
    { executionProfile: 'codex-strong' }, { taskType: 'analysis' }, { unknown: true }]) {
    const node = await editingNode('running');
    const before = structuredClone(node);
    const revision = project.revision;
    const calls = timeboxEdits.length;
    const lookups = modelLookups;
    await assert.rejects(() => lab.updateNode(project.id, node.id, { timeboxMinutes: 120, ...field }),
      (error) => error.code === 'node_not_editable');
    assert.deepEqual(store.getNode(project.id, node.id), before);
    assert.equal(project.revision, revision);
    assert.equal(timeboxEdits.length, calls);
    assert.equal(modelLookups, lookups);
  }
});

await test('planned and proposed mixed task edits keep their original permissions', async () => {
  for (const status of ['planned', 'proposed']) {
    const node = await editingNode(status);
    const calls = timeboxEdits.length;
    const result = await lab.updateNode(project.id, node.id, { title: 'Updated planned task', timeboxMinutes: 25 });
    assert.equal(result.node.title, 'Updated planned task');
    assert.equal(result.node.timeboxMs, 25 * 60_000);
    assert.equal(timeboxEdits.length, calls);
  }
});

await test('HTTP and agent dispatch accept transport keys on timebox-only edits', async () => {
  const node = await editingNode('running');
  const calls = timeboxEdits.length;
  const response = await callHttp(PREFIX + '/commands', { method: 'POST', rawBody: JSON.stringify({
    type: 'node.edit', projectId: project.id, nodeId: node.id, timeboxMinutes: 130,
  }) });
  assert.equal(response.ok, true);
  assert.equal(response.data.node.timeboxMs, 130 * 60_000);
  const result = await lab.agentTool({ action: 'update_node', projectId: project.id, nodeId: node.id, timeboxMinutes: 140 });
  assert.equal(result.node.timeboxMs, 140 * 60_000);
  assert.equal(timeboxEdits.length, calls + 2);
  const bad = await callHttp(PREFIX + '/commands', { method: 'POST', rawBody: JSON.stringify({
    type: 'node.edit', projectId: project.id, nodeId: node.id, timeboxMinutes: 2.5,
  }) });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'timebox_invalid');
});

await test('registered agent tool exposes and forwards integer timebox minutes', async () => {
  const node = await editingNode('running');
  let spec;
  const disposeTool = registerAgentTool({ tools: { register(value) { spec = value; return () => {}; } } }, lab);
  assert.deepEqual(spec.parameters.properties.timeboxMinutes, {
    type: 'integer', minimum: 1, maximum: 1440,
    description: 'for update_node: total minutes for the current run, or the next execution when stopped; project limit also applies',
  });
  const response = await spec.execute({ action: 'update_node', projectId: project.id, nodeId: node.id, timeboxMinutes: 150 });
  assert.equal(JSON.parse(response.result).node.timeboxMs, 150 * 60_000);
  disposeTool();
});

await test('state projects legacy follow-up evidence without overwriting stored history', async () => {
  const node = await editingNode('completed');
  const at = Date.now() + 1;
  node.git.headCommit = project.repo.baseCommit;
  node.report = { success: false, summary: 'old activation safety gate', metrics: [] };
  node.reportText = 'fresh follow-up measurements, not a structured success claim';
  node.followUps = [{ at, headCommit: node.git.headCommit, assistant: node.reportText }];
  const before = structuredClone(node);
  const state = await lab.getState(project.id);
  assert.equal(state.nodes[0].report, null);
  assert.equal(state.nodes[0].reportText, node.reportText);
  assert.deepEqual(store.getNode(project.id, node.id), before);
  assert.equal(store.getNode(project.id, node.id).report.success, false);
  const status = await lab.agentTool({ action: 'status', projectId: project.id });
  assert.equal(status.nodes[0].report, null);
  assert.equal(status.nodes[0].reportText, node.reportText);
  node.reportSource = 'activation';
  node.report = { success: true, summary: 'new activation report', metrics: [] };
  node.reportText = 'new activation text';
  const fresh = await lab.getState(project.id);
  assert.equal(fresh.nodes[0].report.summary, 'new activation report');
});

await test('node command DTOs keep legacy report projection across revision short-circuits', async () => {
  for (const channel of ['service', 'http', 'agent']) {
    const node = await editingNode('completed');
    node.git.headCommit = project.repo.baseCommit;
    node.report = { success: false, summary: 'obsolete structured report A', metrics: [] };
    node.reportText = 'new follow-up B is the current evidence';
    node.followUps = [{ at: Date.now() + 1, headCommit: node.git.headCommit, assistant: node.reportText }];
    const originalReport = structuredClone(node.report);
    const initial = await lab.getState(project.id);
    assert.equal(initial.nodes[0].report, null);
    let result;
    if (channel === 'service') result = await lab.updateNode(project.id, node.id, { timeboxMinutes: 150 });
    if (channel === 'http') {
      const response = await callHttp(PREFIX + '/commands', { method: 'POST', rawBody: JSON.stringify({ type: 'node.edit', projectId: project.id, nodeId: node.id, timeboxMinutes: 150 }) });
      assert.equal(response.ok, true); result = response.data;
    }
    if (channel === 'agent') result = await lab.agentTool({ action: 'update_node', projectId: project.id, nodeId: node.id, timeboxMinutes: 150 });
    assert.equal(result.node.report, null, channel + ' must not reintroduce A');
    assert.equal(result.node.reportText, node.reportText);
    assert.deepEqual(store.getNode(project.id, node.id).report, originalReport);
    const refresh = await callHttp(PREFIX + '/state', { query: '?projectId=' + encodeURIComponent(project.id) + '&revision=' + result.revision });
    assert.equal(refresh.data.unchanged, true, 'same-revision refresh cannot repair a raw command DTO');
  }
});

await test('project defaults do not silently rewrite existing node budgets', async () => {
  const node = await editingNode();
  node.timeboxMs = 90 * 60_000;
  await lab.updateProject(project.id, { config: { nodeTimeoutMinutes: 20, maxNodeTimeoutMinutes: 360 } });
  assert.equal(store.getNode(project.id, node.id).timeboxMs, 90 * 60_000);
  assert.equal(project.config.nodeTimeoutMinutes, 20);
  assert.equal(project.config.maxNodeTimeoutMinutes, 360);
});

disposeRoutes();

for (const [status, name, detail] of results) {
  console.log(`${status}  ${name}${detail ? `\n${detail}` : ''}`);
}
await store.close();
const failures = results.filter(([status]) => status === 'FAIL');
if (failures.length > 0) {
  console.error(`\n${failures.length} self-test check(s) failed`);
  process.exit(1);
}
console.log(`\nall ${results.length} self-test checks passed`);
