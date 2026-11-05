/**
 * End-to-end regression for `node.successor` needs handling.
 *
 * Before the fix, the successor path reused the advisor's array-only parser, so
 * every Web UI submission (which sends a map, e.g. `{gpu: 2}` or `{}`) failed
 * with "needs must be an array of {key, amount}". This test drives the real
 * LabService -> Orchestrator -> GitEngine path against a throwaway git repo.
 *
 * Run with: `node --test tests/`.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { createGitEngine } from '../host/git-engine.js';
import { createLabService } from '../host/lab-service.js';
import { createOrchestrator } from '../host/orchestrator.js';
import { openStore } from '../host/store.js';

const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'mirl-successor-'));
// Keep worktrees out of the real ~/.dsh tree.
process.env.DSH_HOME = tmpRoot;

after(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

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

/** Real git over the same subprocess seam the Host uses. */
function gitSubprocess() {
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

async function initRepo(name) {
  const dir = path.join(tmpRoot, name);
  await mkdir(dir, { recursive: true });
  const run = (...args) => new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', dir, ...args], { stdio: 'ignore' });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} -> ${code}`))));
    child.on('error', reject);
  });
  await run('init', '-q');
  await writeFile(path.join(dir, 'README.md'), `# ${name}\n`);
  await run('add', '-A');
  await run('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'init');
  return dir;
}

/** Build a project whose root node is completed with a real worktree. */
async function makeFixture(name, { resourcePools = { gpu: 2 }, needs = undefined, cluster } = {}) {
  const repoPath = await initRepo(name);
  const store = await openStore({ storageDomain: { open: async () => memoryDomain() }, logger: { info() {} } });
  const git = createGitEngine({ subprocess: gitSubprocess() });
  const ctx = { agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) } };
  const runtime = { decorateNodes: (_projectId, nodes) => nodes };
  const orchestrator = createOrchestrator({ ctx, store, git, runtime });
  const lab = createLabService({
    ctx,
    store,
    git,
    orchestrator,
    ...(cluster === undefined ? {} : { cluster }),
    transcript: { read: async () => ({ rows: [], nextSeq: 0, running: false }) },
    runtime,
    auto: { stop: async () => ({ status: 'off' }), forget: () => {}, statusOf: () => ({ status: 'off', pauseReason: null }) },
    clusterAdmin: {
      getConfigPayload: () => ({ config: { enabled: false }, status: { enabled: false, mode: 'local' }, activeLeases: 0, canApply: true, warnings: [] }),
      applyConfig: async () => ({ config: { enabled: false }, status: { enabled: false, mode: 'local' }, activeLeases: 0, canApply: true, warnings: [] }),
    },
    version: 'test',
  });

  const created = await lab.createProject({
    name,
    brief: 'Fixture project for the successor needs regression.',
    repoPath,
    initialPrompt: 'Reproduce the successor dialog payload end to end.',
    ...(needs === undefined ? {} : { needs }),
    config: { resourcePools, maxRunningNodes: 2, maxNodes: 10, nodeTimeoutMinutes: 10 },
  });
  const project = created.project;
  const rootNode = created.rootNode;

  await git.ensureWorktree(project, rootNode);
  await writeFile(path.join(rootNode.git.worktreePath, 'results.md'), 'accuracy: pending\n');
  rootNode.status = 'completed';
  rootNode.timestamps = { ...rootNode.timestamps, completedAt: Date.now() };
  await store.saveNode(project.id, rootNode);

  return { lab, store, git, project, rootNode };
}

const successorInput = {
  title: '测试 gsm8k',
  prompt: '使用 GSM8K 数据集跑精度测试，使用 evalscope.',
  successCriteria: 'gsm8k accuracy reported',
  timeboxMinutes: 60,
};

test('node.successor accepts the UI map payload {gpu: 2} (regression)', async () => {
  const { lab, store, git, project, rootNode } = await makeFixture('repo-map');
  const result = await lab.createSuccessor(project.id, rootNode.id, { ...successorInput, needs: { gpu: 2 } });

  assert.equal(result.node.status, 'planned');
  assert.equal(result.node.parentId, rootNode.id);
  assert.deepEqual(result.node.needs, { gpu: 2 });

  const sealed = store.getNode(project.id, rootNode.id);
  assert.ok(sealed.timestamps.sealedAt, 'parent must be sealed after adding the successor');
  assert.notEqual(sealed.git.headCommit, null);
  const tags = await git.runGit(['-C', project.repo.path, 'tag', '-l', `dshex-sealed/${project.id}/${rootNode.id}`], { cwd: project.repo.path });
  assert.match(tags.stdout.trim(), new RegExp(`dshex-sealed/${project.id}/${rootNode.id}`));
});

test('node.successor accepts the UI empty map payload {} (regression)', async () => {
  const { lab, project, rootNode } = await makeFixture('repo-empty');
  const result = await lab.createSuccessor(project.id, rootNode.id, { ...successorInput, needs: {} });
  assert.deepEqual(result.node.needs, {});
});

test('node.successor still rejects needs that exceed the resource pool', async () => {
  const { lab, store, project, rootNode } = await makeFixture('repo-overpool');
  await assert.rejects(
    () => lab.createSuccessor(project.id, rootNode.id, { ...successorInput, needs: { gpu: 3 } }),
    (error) => error.code === 'bad_request' && /exceeds pool/.test(error.message),
  );
  assert.equal(store.listNodes(project.id).length, 1, 'no node is created when validation fails');
});

test('node.successor accepts the advisor array payload too', async () => {
  const { lab, project, rootNode } = await makeFixture('repo-array');
  const result = await lab.createSuccessor(project.id, rootNode.id, {
    ...successorInput,
    needs: [{ key: 'gpu', amount: 2 }],
  });
  assert.deepEqual(result.node.needs, { gpu: 2 });
});

test('createProject accepts a GPU need without a pool when the coordinator is on', async () => {
  const { store, project, rootNode } = await makeFixture('repo-nopool', {
    resourcePools: {},
    needs: { gpu: 4 },
    cluster: { enabled: true },
  });
  assert.deepEqual(project.config.resourcePools, {});
  assert.deepEqual(rootNode.needs, { gpu: 4 });
  assert.equal(store.listNodes(project.id).length, 1);
});

test('createProject rejects a GPU need without a pool when the coordinator is off', async () => {
  await assert.rejects(
    () => makeFixture('repo-nopool-off', { resourcePools: {}, needs: { gpu: 4 } }),
    (error) => error.code === 'bad_request' && /unknown resource: gpu/.test(error.message),
  );
});

test('createProject rejects a pool key named "machines"', async () => {
  await assert.rejects(
    () => makeFixture('repo-reserved', { resourcePools: { machines: 2 } }),
    (error) => error.code === 'bad_request' && /reserved/.test(error.message),
  );
});

test('createProject rejects an uppercase pool key (one key rule with needs)', async () => {
  await assert.rejects(
    () => makeFixture('repo-upper', { resourcePools: { GPU: 1 } }),
    (error) => error.code === 'bad_request' && /invalid resource key: GPU/.test(error.message),
  );
});
