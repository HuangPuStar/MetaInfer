/**
 * Offline repository-bootstrap regression: real Git, disposable repositories and
 * isolated Git configuration. Run: node --test scripts/repository-selftest.mjs
 * No network, installs, user configuration changes or remote pushes are needed.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import * as gitModule from '../host/git-engine.js';

await test('repository preparation (offline real Git)', async (suite) => {
const test = (name, fn) => suite.test(name, fn);
const root = await mkdtemp(path.join(os.tmpdir(), 'metainfer-repository-'));
const savedEnv = { ...process.env };
const globalConfig = path.join(root, 'gitconfig');
const globalText = '[init]\n\tdefaultBranch = laboratory-default\n[user]\n\tname = Existing Human\n\temail = existing@example.invalid\n[commit]\n\tgpgSign = true\n[gpg]\n\tprogram = metainfer-selftest-no-signer\n';
process.env.DSH_HOME = path.join(root, 'dsh-home');
process.env.GIT_CONFIG_GLOBAL = globalConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_TERMINAL_PROMPT = '0';
for (const name of Object.keys(process.env)) {
  if (/^GIT_(?:CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)|DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|AUTHOR_.*|COMMITTER_.*)$/.test(name)) delete process.env[name];
}
await writeFile(globalConfig, globalText);
suite.after(async () => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  await rm(root, { recursive: true, force: true });
});

function provider(calls = [], intercept) {
  return {
    spawn(spec) {
      calls.push(spec);
      const special = intercept?.(spec);
      if (special) return special;
      const env = { ...process.env };
      for (const [key, value] of Object.entries(spec.env || {})) {
        for (const inherited of Object.keys(env)) {
          if (inherited === key || (process.platform === 'win32' && inherited.toUpperCase() === key.toUpperCase())) delete env[inherited];
        }
        if (value !== undefined) env[key] = value;
      }
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const abort = () => child.kill('SIGKILL');
      spec.signal?.addEventListener('abort', abort, { once: true });
      const done = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (exitCode, signal) => {
          spec.signal?.removeEventListener('abort', abort);
          resolve({ exitCode, signal });
        });
      });
      return {
        done,
        collected: {
          stdout: { readFrom: () => ({ text: stdout }) },
          stderr: { readFrom: () => ({ text: stderr }) },
        },
      };
    },
  };
}
function engine(calls, intercept) {
  return gitModule.createGitEngine({ subprocess: provider(calls, intercept) });
}
const git = engine();
async function command(cwd, ...args) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn('git', [...(process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : []), ...args], { cwd, env: process.env, windowsHide: true, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end();
  });
  assert.equal(result.code, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
async function directory(name) {
  const target = path.join(root, name);
  await mkdir(target, { recursive: true });
  return target;
}
async function initialized(name, branch = 'laboratory-default') {
  const target = await directory(name);
  await command(target, 'init', '-b', branch);
  return target;
}
async function committed(name, branch = 'stable') {
  const target = await initialized(name, branch);
  await writeFile(path.join(target, 'tracked.txt'), 'tracked baseline\n');
  await command(target, 'add', 'tracked.txt');
  await command(target, '-c', 'commit.gpgSign=false', 'commit', '-m', 'existing history');
  return target;
}
async function bareRemote(name, source) {
  const target = path.join(root, `${name}.git`);
  if (source) await command(root, 'clone', '--bare', '--', source, target);
  else await command(root, 'init', '--bare', target);
  return { target, url: pathToFileURL(target).href };
}
async function exists(target) { return stat(target).then(() => true, () => false); }
function code(expected) { return (error) => { assert.equal(error.code, expected, error.stack); return true; }; }
function samePath(actual, expected) {
  const normalize = (value) => value.replaceAll('\\', '/').toLowerCase();
  assert.equal(normalize(actual), normalize(expected));
}

await test('ambient repository selectors cannot redirect preparation or its index', async () => {
  const victim = await committed('ambient-victim');
  const target = await committed('ambient-target');
  const fresh = await directory('ambient-new');
  const victimGit = path.join(victim, '.git');
  const before = await Promise.all(['config', 'index', 'refs/heads/stable'].map((name) => readFile(path.join(victimGit, name))));
  const ambient = {
    GIT_DIR: victimGit,
    GIT_WORK_TREE: victim,
    GIT_COMMON_DIR: victimGit,
    GIT_INDEX_FILE: path.join(victimGit, 'index'),
    GIT_OBJECT_DIRECTORY: path.join(victimGit, 'objects'),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(victimGit, 'objects'),
    GIT_NAMESPACE: 'ambient-namespace',
  };
  const saved = Object.fromEntries(Object.keys(ambient).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, ambient);
    const calls = [];
    const isolated = engine(calls);
    samePath((await isolated.validateRepo(target, { prepare: true })).repoRoot, target);
    samePath((await isolated.validateRepo(fresh, { prepare: true })).repoRoot, fresh);
    for (const spec of calls.filter((entry) => !entry.argv.includes('--version'))) {
      for (const key of Object.keys(ambient)) {
        assert.ok(Object.hasOwn(spec.env, key));
        assert.equal(spec.env[key], undefined);
      }
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  const after = await Promise.all(['config', 'index', 'refs/heads/stable'].map((name) => readFile(path.join(victimGit, name))));
  assert.deepEqual(after, before);
  assert.equal(await command(fresh, 'ls-tree', '-r', 'HEAD'), '');
});

await test('read-only non-repository validation never initializes a directory', async () => {
  const target = await directory('read-only-new');
  await assert.rejects(git.validateRepo(target), code('not_git'));
  assert.equal(await exists(path.join(target, '.git')), false);
});

await test('read-only missing directory stays absent', async () => {
  const target = path.join(root, 'missing', 'child');
  await assert.rejects(git.validateRepo(target), code('not_git'));
  assert.equal(await exists(path.dirname(target)), false);
});

await test('read-only unborn repository returns no_commits, not generic revision failure', async () => {
  const target = await initialized('read-only-unborn');
  const config = await readFile(path.join(target, '.git', 'config'));
  await assert.rejects(git.validateRepo(target), code('no_commits'));
  assert.equal(await command(target, 'for-each-ref'), '');
  assert.deepEqual(await readFile(path.join(target, '.git', 'config')), config);
});

await test('prepare creates missing local directory and empty-tree initial commit with configured branch/identity', async () => {
  const target = path.join(root, 'new-missing', 'repo');
  const repo = await git.validateRepo(target, { prepare: true });
  samePath(repo.repoRoot, target);
  assert.equal(repo.defaultBranch, 'laboratory-default');
  assert.equal(repo.dirty, false);
  assert.match(repo.baseCommit, /^[0-9a-f]{40,64}$/);
  assert.equal(await command(target, 'ls-tree', '-r', 'HEAD'), '');
  assert.equal(await command(target, 'show', '-s', '--format=%an <%ae>', 'HEAD'), 'Existing Human <existing@example.invalid>');
  assert.equal(await readFile(globalConfig, 'utf8'), globalText);
  const local = await readFile(path.join(target, '.git', 'config'), 'utf8');
  assert.doesNotMatch(local, /\[user\]|gpgsign|defaultbranch/i);
});

await test('prepare nonempty new directory reports excluded files without staging them', async () => {
  const target = await directory('new-with-files');
  await writeFile(path.join(target, 'private.txt'), 'secret; $(not a command)\n');
  const repo = await git.validateRepo(target, { prepare: true });
  assert.equal(repo.dirty, true);
  assert.ok(repo.warnings.length > 0);
  assert.equal(await command(target, 'ls-tree', '-r', 'HEAD'), '');
  assert.equal(await command(target, 'ls-files'), '');
  assert.equal(await readFile(path.join(target, 'private.txt'), 'utf8'), 'secret; $(not a command)\n');
});

await test('initial empty-tree warning also covers ignored files with clean status', async () => {
  const target = await initialized('ignored-files');
  await writeFile(path.join(target, '.git', 'info', 'exclude'), 'ignored.txt\n');
  await writeFile(path.join(target, 'ignored.txt'), 'ignored but preserved');
  const repo = await git.validateRepo(target, { prepare: true });
  assert.equal(repo.dirty, false);
  assert.ok(repo.warnings.some((warning) => warning.includes('Initial commit contains no files')));
  assert.equal(await command(target, 'ls-tree', '-r', 'HEAD'), '');
  assert.equal(await readFile(path.join(target, 'ignored.txt'), 'utf8'), 'ignored but preserved');
});

await test('initial commit preserves pre-existing staged secrets and index byte-for-byte', async () => {
  const target = await initialized('staged-secrets');
  await writeFile(path.join(target, 'staged-secret.txt'), 'staged secret\n');
  await writeFile(path.join(target, 'untracked-secret.txt'), 'untracked secret\n');
  await command(target, 'add', 'staged-secret.txt');
  const index = await readFile(path.join(target, '.git', 'index'));
  const staged = await command(target, 'ls-files', '--stage');
  const repo = await git.validateRepo(target, { prepare: true });
  assert.equal(repo.dirty, true);
  assert.ok(repo.warnings.length > 0);
  assert.deepEqual(await readFile(path.join(target, '.git', 'index')), index);
  assert.equal(await command(target, 'ls-files', '--stage'), staged);
  assert.equal(await command(target, 'ls-tree', '-r', 'HEAD'), '');
});

await test('existing dirty committed repository is never committed, reset or reconfigured', async () => {
  const target = await committed('existing-dirty');
  await command(target, 'config', 'user.name', 'Local Human');
  await command(target, 'config', 'user.email', 'local@example.invalid');
  await command(target, 'config', 'commit.gpgSign', 'true');
  await writeFile(path.join(target, 'tracked.txt'), 'staged edit\n');
  await command(target, 'add', 'tracked.txt');
  await writeFile(path.join(target, 'tracked.txt'), 'unstaged edit\n');
  const head = await command(target, 'rev-parse', 'HEAD');
  const config = await readFile(path.join(target, '.git', 'config'));
  const index = await readFile(path.join(target, '.git', 'index'));
  const repo = await git.validateRepo(target, { prepare: true });
  assert.equal(repo.baseCommit, head);
  assert.equal(repo.dirty, true);
  assert.deepEqual(await readFile(path.join(target, '.git', 'config')), config);
  assert.deepEqual(await readFile(path.join(target, '.git', 'index')), index);
  assert.equal(await command(target, 'rev-list', '--count', 'HEAD'), '1');
});

await test('nested directory validation never adopts or initializes its parent repository', async () => {
  const parent = await initialized('parent-unborn');
  const target = path.join(parent, 'nested', 'project');
  await mkdir(target, { recursive: true });
  const parentConfig = await readFile(path.join(parent, '.git', 'config'));
  await assert.rejects(git.validateRepo(target), code('not_git'));
  const repo = await git.validateRepo(target, { prepare: true });
  samePath(repo.repoRoot, target);
  assert.equal(await command(parent, 'for-each-ref'), '');
  assert.deepEqual(await readFile(path.join(parent, '.git', 'config')), parentConfig);
  assert.equal(await exists(path.join(target, '.git')), true);
});

await test('bare repositories are consistently rejected before initialization', async () => {
  const remote = await bareRemote('bare-rejected');
  for (const prepare of [false, true]) await assert.rejects(git.validateRepo(remote.target, { prepare }), code('bare'));
  assert.equal(await command(remote.target, 'for-each-ref'), '');
});

await test('bad paths and unsafe transport strings are rejected without writes', async () => {
  const file = path.join(root, 'not-a-directory');
  await writeFile(file, 'leave me alone');
  for (const target of ['', 'relative/path', 'ext::sh -c anything', 'https://github.com/owner', `${root}\0bad`, file]) {
    await assert.rejects(git.validateRepo(target, { prepare: true }), code('bad_path'));
  }
  assert.equal(await readFile(file, 'utf8'), 'leave me alone');
});

await test('read-only uncached remote returns repo_setup_required and does not clone', async () => {
  const remote = await bareRemote('empty-read-only');
  const calls = [];
  await assert.rejects(engine(calls).validateRepo(remote.url), code('repo_setup_required'));
  assert.equal(calls.some((spec) => spec.argv.includes('clone')), false);
  assert.equal(await exists(path.join(process.env.DSH_HOME, 'metainfer-research-lab', 'repos')), false);
});

let emptyRemote;
let emptyClone;
await test('empty file URL remote is cloned, initialized locally and never pushed', async () => {
  emptyRemote = await bareRemote('empty-origin');
  const calls = [];
  emptyClone = await engine(calls).validateRepo(emptyRemote.url, { prepare: true });
  assert.ok(emptyClone.repoRoot.startsWith(process.env.DSH_HOME));
  assert.equal(emptyClone.remoteUrl, emptyRemote.url);
  assert.match(emptyClone.baseCommit, /^[0-9a-f]{40,64}$/);
  assert.equal(await command(root, 'ls-remote', emptyRemote.url), '');
  assert.equal(calls.some((spec) => spec.argv.includes('push')), false);
  assert.equal(await command(emptyClone.repoRoot, 'ls-tree', '-r', 'HEAD'), '');
});

await test('cached remote preparation/read-only reuse preserves local changes and commit', async () => {
  assert.ok(emptyClone);
  await writeFile(path.join(emptyClone.repoRoot, 'keep.txt'), 'cached user change\n');
  const calls = [];
  const cachedGit = engine(calls);
  for (const prepare of [true, false]) {
    const repo = await cachedGit.validateRepo(emptyRemote.url, { prepare });
    samePath(repo.repoRoot, emptyClone.repoRoot);
    assert.equal(repo.baseCommit, emptyClone.baseCommit);
    assert.equal(repo.dirty, true);
  }
  assert.equal(calls.some((spec) => spec.argv.includes('clone') || spec.argv.includes('fetch')), false);
  assert.equal(await readFile(path.join(emptyClone.repoRoot, 'keep.txt'), 'utf8'), 'cached user change\n');
  assert.equal(await command(root, 'ls-remote', emptyRemote.url), '');
});

await test('nonempty remote with invalid HEAD selects existing history instead of empty initialization', async () => {
  const source = await committed('broken-head-source', 'available');
  const expected = await command(source, 'rev-parse', 'HEAD');
  const remote = await bareRemote('broken-head-origin', source);
  await command(remote.target, 'symbolic-ref', 'HEAD', 'refs/heads/missing');
  const repo = await git.validateRepo(remote.url, { prepare: true });
  assert.equal(repo.baseCommit, expected);
  assert.ok(repo.defaultBranch.endsWith('available'));
  assert.equal(await command(repo.repoRoot, 'rev-list', '--all', '--count'), '1');
  assert.equal(await command(repo.repoRoot, 'show', `${repo.baseCommit}:tracked.txt`), 'tracked baseline');
});

await test('broken local HEAD with existing branch does not create a commit or discard files', async () => {
  const target = await committed('local-broken-head', 'available');
  const expected = await command(target, 'rev-parse', 'HEAD');
  await command(target, 'symbolic-ref', 'HEAD', 'refs/heads/missing');
  const repo = await git.validateRepo(target, { prepare: true });
  assert.equal(repo.baseCommit, expected);
  assert.equal(repo.defaultBranch, 'available');
  assert.equal(await command(target, 'rev-list', '--all', '--count'), '1');
  assert.equal(await command(target, 'symbolic-ref', 'HEAD'), 'refs/heads/missing');
});

await test('detached/tag-only existing history never receives a synthetic initial commit', async () => {
  const target = await committed('detached-history');
  const expected = await command(target, 'rev-parse', 'HEAD');
  await command(target, 'tag', 'existing', expected);
  await command(target, 'checkout', '--detach', expected);
  await command(target, 'branch', '-D', 'stable');
  const repo = await git.validateRepo(target, { prepare: true });
  assert.equal(repo.baseCommit, expected);
  assert.equal(await command(target, 'rev-list', '--all', '--count'), '1');
});

await test('GitHub tree URL picks longest valid branch prefix; unknown branches fail without fallback', async () => {
  const source = await committed('github-source', 'stable');
  await command(source, 'branch', 'feature-other');
  await command(source, 'branch', 'feature/topic');
  const remote = await bareRemote('github-origin', source);
  const url = 'https://github.com/metainfer-selftest/branch-fixture.git';
  await writeFile(globalConfig, `${globalText}[url "${remote.url}"]\n\tinsteadOf = ${url}\n`);
  try {
    const repo = await git.validateRepo('https://github.com/metainfer-selftest/branch-fixture/tree/feature/topic/docs', { prepare: true });
    assert.equal(repo.defaultBranch, 'feature/topic');
    await assert.rejects(git.validateRepo('https://github.com/metainfer-selftest/branch-fixture/tree/unknown/topic', { prepare: true }), code('bad_branch'));
    await assert.rejects(git.validateRepo('https://github.com/metainfer-selftest/branch-fixture/tree/unknown/topic'), code('bad_branch'));
  } finally {
    await writeFile(globalConfig, globalText);
  }
});

await test('deep managed cache supports packed commits without persisted long-path overrides', async () => {
  const source = await committed('deep-cache-source');
  const remote = await bareRemote('deep-cache-origin', source);
  const home = process.env.DSH_HOME;
  const padding = Math.max(1, 225 - path.join(root, 'deep-cache', 'metainfer-research-lab', 'repos', '0'.repeat(64)).length - 1);
  process.env.DSH_HOME = path.join(root, 'deep-cache', 'x'.repeat(padding));
  try {
    const calls = [];
    const prepared = await engine(calls).validateRepo(remote.url, { prepare: true });
    const reused = await git.validateRepo(remote.url);
    assert.equal(reused.baseCommit, prepared.baseCommit);
    assert.equal(await command(prepared.repoRoot, 'show', `${prepared.baseCommit}:tracked.txt`), 'tracked baseline');
    assert.doesNotMatch(await readFile(path.join(prepared.repoRoot, '.git', 'config'), 'utf8'), /longpaths/i);
    if (process.platform === 'win32') assert.ok(calls.filter((spec) => !spec.argv.includes('--version')).every((spec) => spec.argv.includes('core.longpaths=true')));
  } finally {
    process.env.DSH_HOME = home;
  }
});

await test('Windows working directories beyond Git MAX_PATH fail before writes/spawn', async () => {
  if (process.platform !== 'win32') return;
  const target = path.join(root, 'long-parent'.repeat(18), 'child'.repeat(12));
  const calls = [];
  await assert.rejects(engine(calls).validateRepo(target, { prepare: true }), code('path_too_long'));
  assert.equal(calls.length, 0);
  assert.equal(await exists(path.dirname(target)), false);
});

await test('concurrent prepare across engine instances creates one local initial commit', async () => {
  const target = await directory('concurrent-local');
  const calls = [];
  const results = await Promise.all(Array.from({ length: 4 }, () => engine(calls).validateRepo(target, { prepare: true })));
  assert.equal(new Set(results.map((repo) => repo.baseCommit)).size, 1);
  assert.equal(calls.filter((spec) => spec.argv.includes('commit-tree')).length, 1);
  assert.equal(calls.filter((spec) => spec.argv.includes('init')).length, 1);
});

await test('concurrent remote prepare clones once and publishes a reusable cache', async () => {
  const remote = await bareRemote('concurrent-origin');
  const calls = [];
  const results = await Promise.all(Array.from({ length: 4 }, () => engine(calls).validateRepo(remote.url, { prepare: true })));
  assert.equal(new Set(results.map((repo) => repo.baseCommit)).size, 1);
  assert.equal(calls.filter((spec) => spec.argv.includes('clone')).length, 1);
});

await test('failed clones remove only owned temporary directories', async () => {
  const cache = path.join(process.env.DSH_HOME, 'metainfer-research-lab', 'repos');
  const before = (await readdir(cache)).sort();
  const remote = pathToFileURL(path.join(root, 'nonexistent-origin.git')).href;
  await assert.rejects(git.validateRepo(remote, { prepare: true }), code('clone_failed'));
  assert.deepEqual((await readdir(cache)).sort(), before);
});

await test('clone infrastructure failures retain their codes and clean owned staging directories', async () => {
  const cache = path.join(process.env.DSH_HOME, 'metainfer-research-lab', 'repos');
  const before = (await readdir(cache)).sort();
  const remote = await bareRemote('infrastructure-origin');
  for (const [failure, expected] of [['ENOENT', 'git_missing'], ['EACCES', 'git_permission'], ['git_timeout', 'git_timeout']]) {
    const failing = engine([], (spec) => {
      if (!spec.argv.includes('clone')) return undefined;
      const error = new Error(`fixture clone failure ${failure}`);
      error.code = failure;
      throw error;
    });
    await assert.rejects(failing.validateRepo(remote.url, { prepare: true }), code(expected));
    assert.deepEqual((await readdir(cache)).sort(), before);
  }
});

await test('occupied managed clone path is preserved, never removed or silently initialized', async () => {
  const remote = await bareRemote('occupied-origin');
  const repo = await git.validateRepo(remote.url, { prepare: true });
  await rm(repo.repoRoot, { recursive: true, force: true });
  await mkdir(repo.repoRoot);
  await writeFile(path.join(repo.repoRoot, 'user-owned.txt'), 'preserve occupied directory');
  await assert.rejects(git.validateRepo(remote.url, { prepare: true }), code('clone_failed'));
  assert.equal(await readFile(path.join(repo.repoRoot, 'user-owned.txt'), 'utf8'), 'preserve occupied directory');
  assert.equal(await exists(path.join(repo.repoRoot, '.git')), false);
});

await test('symlinked managed clone path is rejected without modifying its target', async () => {
  const remote = await bareRemote('symlink-origin');
  const repo = await git.validateRepo(remote.url, { prepare: true });
  await rm(repo.repoRoot, { recursive: true, force: true });
  const foreign = await committed('symlink-foreign');
  await command(foreign, 'remote', 'add', 'origin', remote.url);
  const index = await readFile(path.join(foreign, '.git', 'index'));
  const config = await readFile(path.join(foreign, '.git', 'config'));
  await symlink(foreign, repo.repoRoot, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(git.validateRepo(remote.url, { prepare: true }), code('clone_failed'));
  assert.deepEqual(await readFile(path.join(foreign, '.git', 'index')), index);
  assert.deepEqual(await readFile(path.join(foreign, '.git', 'config')), config);
  assert.equal(await command(foreign, 'rev-list', '--all', '--count'), '1');
});

await test('managed caches reject external Git metadata without changing foreign refs/config/index', async () => {
  for (const kind of ['symlink', 'gitfile', 'commondir']) {
    const remote = await bareRemote(`metadata-${kind}-origin`);
    const repo = await git.validateRepo(remote.url, { prepare: true });
    const metadata = path.join(repo.repoRoot, '.git');
    const foreign = await initialized(`metadata-${kind}-foreign`);
    await command(foreign, 'remote', 'add', 'origin', remote.url);
    await writeFile(path.join(foreign, 'private.txt'), 'preserve staged foreign file');
    await command(foreign, 'add', 'private.txt');
    const foreignGit = path.join(foreign, '.git');
    const before = await Promise.all(['config', 'index'].map((name) => readFile(path.join(foreignGit, name))));
    if (kind === 'commondir') {
      await writeFile(path.join(metadata, 'commondir'), foreignGit + '\n');
    } else {
      await rm(metadata, { recursive: true, force: true });
      if (kind === 'symlink') await symlink(foreignGit, metadata, process.platform === 'win32' ? 'junction' : 'dir');
      else await writeFile(metadata, 'gitdir: ' + foreignGit + '\n');
    }
    await assert.rejects(git.validateRepo(remote.url, { prepare: true }), code('clone_failed'));
    assert.deepEqual(await Promise.all(['config', 'index'].map((name) => readFile(path.join(foreignGit, name)))), before);
    assert.equal(await command(foreign, 'for-each-ref'), '');
    assert.equal(await readFile(path.join(foreign, 'private.txt'), 'utf8'), 'preserve staged foreign file');
  }
});

await test('initial commit failures are stable and preserve staged files/configuration', async () => {
  const target = await initialized('initial-commit-failure');
  await writeFile(path.join(target, 'staged.txt'), 'keep staged contents');
  await command(target, 'add', 'staged.txt');
  const index = await readFile(path.join(target, '.git', 'index'));
  const config = await readFile(path.join(target, '.git', 'config'));
  const failing = engine([], (spec) => {
    if (!spec.argv.includes('commit-tree')) return undefined;
    return { done: Promise.resolve({ exitCode: 1 }), collected: { stderr: { readFrom: () => ({ text: 'fixture commit-tree failure' }) } } };
  });
  await assert.rejects(failing.validateRepo(target, { prepare: true }), code('initial_commit_failed'));
  assert.deepEqual(await readFile(path.join(target, '.git', 'index')), index);
  assert.deepEqual(await readFile(path.join(target, '.git', 'config')), config);
  assert.equal(await command(target, 'for-each-ref'), '');
});

await test('fallback identity is operation-scoped and signing/global configuration is unchanged', async () => {
  const alternateConfig = path.join(root, 'identityless-gitconfig');
  const text = '[init]\n\tdefaultBranch = identityless\n[commit]\n\tgpgSign = true\n[gpg]\n\tprogram = metainfer-selftest-no-signer\n';
  await writeFile(alternateConfig, text);
  process.env.GIT_CONFIG_GLOBAL = alternateConfig;
  try {
    const target = await directory('identityless');
    const repo = await git.validateRepo(target, { prepare: true });
    assert.equal(repo.defaultBranch, 'identityless');
    assert.equal(await readFile(alternateConfig, 'utf8'), text);
    assert.doesNotMatch(await readFile(path.join(target, '.git', 'config'), 'utf8'), /\[user\]|gpgsign/i);
    assert.match(await command(target, 'show', '-s', '--format=%an <%ae>', 'HEAD'), /MetaInfer/);
  } finally {
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
  }
});

await test('prepared repository supports existing worktree create/reuse/prune recovery', async () => {
  const target = await directory('worktree-source');
  const repo = await git.validateRepo(target, { prepare: true });
  const worktreePath = path.join(root, 'worktrees', 'node');
  const project = { repo: { path: target } };
  const node = { git: { worktreePath, branch: 'experiment/node', baseCommit: repo.baseCommit } };
  assert.equal((await git.ensureWorktree(project, node)).reused, false);
  assert.equal((await git.ensureWorktree(project, node)).reused, true);
  await rm(worktreePath, { recursive: true, force: true });
  assert.equal((await git.ensureWorktree(project, node)).reused, false);
  assert.equal(await git.headOf(worktreePath), repo.baseCommit);
  assert.equal(await git.removeWorktree(target, worktreePath), true);
});

await test('missing Git synchronous spawn failures are not mislabeled not_git', async () => {
  const missing = engine([], () => { const error = new Error('spawn git ENOENT'); error.code = 'ENOENT'; throw error; });
  await assert.rejects(missing.validateRepo(root), code('git_missing'));
});

await test('missing Git asynchronous spawn failures are not mislabeled not_git', async () => {
  const missing = engine([], () => {
    const error = new Error('spawn git ENOENT'); error.code = 'ENOENT';
    return { done: Promise.reject(error), collected: {} };
  });
  await assert.rejects(missing.validateRepo(root), code('git_missing'));
});

await test('runtime executable disappearance is classified git_missing after resolution', async () => {
  const missing = engine([], (spec) => {
    if (spec.argv.includes('--version')) return undefined;
    const error = new Error('spawn resolved-git ENOENT'); error.code = 'ENOENT'; throw error;
  });
  await assert.rejects(missing.validateRepo(root), code('git_missing'));
});

await test('timeouts remain git_timeout instead of repository/clone errors', async () => {
  const timeout = engine([], (spec) => {
    if (spec.argv.includes('--version')) return undefined;
    return {
      done: new Promise((resolve) => spec.signal.addEventListener('abort', () => resolve({ exitCode: null }), { once: true })),
      collected: {},
    };
  });
  await assert.rejects(timeout.runGit(['status'], { cwd: root, timeoutMs: 10 }), code('git_timeout'));
});

await test('dubious ownership and permissions have stable codes and never trigger init', async () => {
  for (const [stderr, expected] of [
    ["fatal: detected dubious ownership in repository at '/somewhere'", 'git_unsafe'],
    ['fatal: could not open .git/config: Permission denied', 'git_permission'],
  ]) {
    const calls = [];
    const failing = engine(calls, (spec) => {
      if (spec.argv.includes('--version')) return undefined;
      return { done: Promise.resolve({ exitCode: 128 }), collected: { stderr: { readFrom: () => ({ text: stderr }) } } };
    });
    await assert.rejects(failing.validateRepo(root, { prepare: true }), code(expected));
    assert.equal(calls.some((spec) => spec.argv.includes('init')), false);
  }
});

await test('Git setup status/install entry points are exposed without invoking installation', async () => {
  assert.equal(typeof git.gitStatus, 'function');
  assert.equal(typeof git.installGit, 'function');
  const status = await git.gitStatus();
  assert.equal(typeof status, 'object');
  const calls = [];
  const guarded = engine(calls);
  await assert.rejects(guarded.installGit({ confirmed: false }), (error) => Boolean(error.code));
  assert.equal(calls.some((spec) => /^(winget|brew|apt|sudo|choco)(?:\.exe)?$/i.test(path.basename(spec.argv[0]))), false);
});
});
