/**
 * Repository bootstrap tests: the wizard must accept a plain directory or a
 * remote URL and prepare it itself.
 *
 * These tests use a real `git` binary through a fake subprocess seam (the same
 * contract scripts/plugin-smoke-child.mjs implements), so Git behaviour is
 * genuine while "Git is missing" and the package-manager installer stay test
 * doubles that can never touch this machine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createGitEngine, LabError } from '../host/git-engine.js';

/**
 * Fake Host subprocess seam.
 * - runs real processes unless they are the hidden Git executable or installer
 * - `gitAvailable: false` makes every Git invocation fail with ENOENT
 * - `installer: 'ok'` makes the installer succeed and Git appear afterwards
 * - `installer: 'fail'` makes the installer exit non-zero
 */
function seam(options = {}) {
  const state = { gitAvailable: options.gitAvailable !== false, installed: false, calls: [] };
  const hiddenGit = options.hiddenGit ?? 'no-such-git';

  function handle(argv, done, collected) {
    return {
      control: undefined,
      collected,
      done,
      terminate() {},
      waitForExit: async () => true,
    };
  }

  function emptyCollected() {
    return {
      stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
    };
  }

  return {
    state,
    spawn(spec) {
      const argv = spec.argv;
      state.calls.push(argv);
      const isGit = /(?:^|[/\\])git(?:\.exe)?$/i.test(argv[0]) || argv[0] === hiddenGit;
      if (isGit && !state.gitAvailable) {
        return handle(argv, Promise.reject(new Error('spawn git ENOENT')), emptyCollected());
      }
      if (isGit && argv[0] === hiddenGit) {
        return handle(argv, Promise.resolve({ exitCode: 0 }), {
          stdout: { readFrom: () => ({ text: 'git version 9.9.9-fake\n', nextOffset: 0, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        });
      }
      const isInstaller = argv[0] === 'winget' || argv[0] === 'brew' || argv[0] === 'sudo';
      if (isInstaller) {
        if (options.installer === 'fail') {
          const text = 'installer refused to run\n';
          return handle(argv, Promise.resolve({ exitCode: 1 }), {
            stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
            stderr: { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) },
          });
        }
        state.installed = true;
        state.gitAvailable = true;
        return handle(argv, Promise.resolve({ exitCode: 0 }), emptyCollected());
      }
      const childSpec = { ...spec, env: { ...options.env, ...spec.env } };
      options.onRealSpawn?.(childSpec);
      if (isGit && argv.includes('clone') && options.beforeClone) {
        let child;
        const done = Promise.resolve(options.beforeClone(childSpec)).then(() => {
          child = realChild(childSpec);
          return child.done;
        });
        const collected = {};
        for (const stream of ['stdout', 'stderr']) {
          collected[stream] = { readFrom: (offset) => child?.collected[stream].readFrom(offset)
            ?? { text: '', nextOffset: 0, lossy: false } };
        }
        return handle(argv, done, collected);
      }
      return realChild(childSpec);
    },
  };
}

/** Real process runner mirroring scripts/plugin-smoke-child.mjs. */
function realChild(spec) {
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
}

/** Build an engine bound to a throwaway cache root. */
async function harness(options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'mirl-hard-'));
  for (const directory of ['home', 'temp', 'dsh', 'template']) await mkdir(path.join(root, directory));
  const globalConfig = path.join(root, 'gitconfig');
  await writeFile(globalConfig, '');
  const env = {
    HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
    TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'),
    DSH_HOME: path.join(root, 'dsh'), GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1', GIT_TEMPLATE_DIR: path.join(root, 'template'),
    GIT_TERMINAL_PROMPT: '0',
  };
  const subprocess = seam({ ...options, env });
  const engine = createGitEngine(
    { subprocess },
    {
      platform: options.platform ?? process.platform,
      reposRoot: path.join(root, 'repos'),
      gitExecutable: options.gitExecutable ?? 'git',
    },
  );
  return { engine, root, subprocess, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function expectLabError(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof LabError, `expected LabError, got ${error?.name}: ${error?.message}`);
    assert.equal(error.code, code);
    return true;
  });
}

test('a plain directory is initialised, committed and usable', async () => {
  const { engine, root, cleanup } = await harness();
  try {
    const dir = path.join(root, 'plain');
    await mkdir(dir);
    await writeFile(path.join(dir, 'notes.md'), '# experiment\n');

    const info = await engine.prepareRepo(dir);

    assert.equal(info.prepared, 'local-init');
    assert.equal(info.initialized, true);
    assert.equal(info.remote, null);
    assert.ok(info.baseCommit.length >= 7);
    assert.ok(info.branches.includes(info.defaultBranch));
    assert.equal(await engine.branchOf(dir), info.defaultBranch);
    assert.equal(await engine.headOf(dir), info.baseCommit);
    assert.equal(info.dirty, false);
    assert.match(await readFile(path.join(dir, '.git', 'HEAD'), 'utf8'), /^ref:/);
  } finally {
    await cleanup();
  }
});

test('an existing repository is reused without a second commit', async () => {
  const { engine, root, cleanup } = await harness();
  try {
    const dir = path.join(root, 'existing');
    await mkdir(dir);
    await writeFile(path.join(dir, 'a.txt'), 'a\n');
    const first = await engine.prepareRepo(dir);
    const second = await engine.prepareRepo(dir);

    assert.equal(first.prepared, 'local-init');
    assert.equal(second.prepared, 'existing');
    assert.equal(second.initialized, false);
    assert.equal(second.baseCommit, first.baseCommit);
  } finally {
    await cleanup();
  }
});

test('a repository with no commits is repaired instead of rejected', async () => {
  const { engine, root, cleanup } = await harness();
  try {
    const dir = path.join(root, 'unborn');
    await mkdir(dir);
    const init = await engine.runGit(['init', dir], { cwd: dir });
    assert.equal(init.code, 0);

    const info = await engine.prepareRepo(dir);
    assert.equal(info.initialized, true);
    assert.equal(info.prepared, 'existing');
    assert.ok(info.baseCommit.length >= 7);
  } finally {
    await cleanup();
  }
});

test('an already configured repository identity is not overwritten', async () => {
  const { engine, root, cleanup } = await harness();
  try {
    const dir = path.join(root, 'identity');
    await mkdir(dir);
    await writeFile(path.join(dir, 'a.txt'), 'a\n');
    await engine.runGit(['init', dir], { cwd: dir });
    await engine.runGit(['config', 'user.name', 'Ada Lovelace'], { cwd: dir });
    await engine.runGit(['config', 'user.email', 'ada@example.com'], { cwd: dir });

    await engine.prepareRepo(dir);
    const log = await engine.runGit(['log', '-1', '--format=%an <%ae>'], { cwd: dir });
    assert.equal(log.code, 0);
    assert.equal(log.stdout.trim(), 'Ada Lovelace <ada@example.com>');
  } finally {
    await cleanup();
  }
});

test('a remote URL is cloned into the cache and reused afterwards', async () => {
  const { engine, root, cleanup } = await harness();
  try {
    const source = path.join(root, 'source');
    await mkdir(source);
    await writeFile(path.join(source, 'README.md'), 'remote\n');
    await engine.runGit(['init', '--initial-branch=trunk', source], { cwd: source });
    await engine.runGit(['config', 'user.name', 'Remote'], { cwd: source });
    await engine.runGit(['config', 'user.email', 'remote@example.com'], { cwd: source });
    await engine.runGit(['add', '-A'], { cwd: source });
    await engine.runGit(['commit', '-m', 'seed'], { cwd: source });
    const url = pathToFileURL(source).href;

    const first = await engine.prepareRepo(url);
    assert.equal(first.prepared, 'remote-clone');
    assert.equal(first.remote, url);
    assert.equal(first.defaultBranch, 'trunk');
    assert.equal((await readFile(path.join(first.repoRoot, 'README.md'), 'utf8')).trim(), 'remote');
    assert.ok(first.repoRoot.startsWith(path.join(root, 'repos')));

    const second = await engine.prepareRepo(url);
    assert.equal(second.prepared, 'remote-cache');
    assert.equal(second.repoRoot, first.repoRoot);
    assert.equal(second.baseCommit, first.baseCommit);
  } finally {
    await cleanup();
  }
});

test('an empty remote repository is cloned and given an initial commit', async () => {
  const { engine, root, cleanup } = await harness();
  try {
    const empty = path.join(root, 'empty.git');
    await engine.runGit(['init', '--bare', empty], { cwd: root });
    const url = pathToFileURL(empty).href;

    const info = await engine.prepareRepo(url);
    assert.equal(info.prepared, 'remote-clone');
    assert.equal(info.initialized, true);
    assert.ok(info.baseCommit.length >= 7);

    const second = await engine.prepareRepo(url);
    assert.equal(second.prepared, 'remote-cache');
    assert.equal(second.baseCommit, info.baseCommit);
  } finally {
    await cleanup();
  }
});

test('a failed clone reports remote_clone_failed and leaves no poisoned cache', async () => {
  const { engine, root, cleanup } = await harness();
  try {
    const missing = pathToFileURL(path.join(root, 'does-not-exist')).href;
    await expectLabError(engine.prepareRepo(missing), 'remote_clone_failed');
    // Retrying must clone again, not trip over a half-written cache directory.
    await expectLabError(engine.prepareRepo(missing), 'remote_clone_failed');
  } finally {
    await cleanup();
  }
});

test('a missing directory or a bare repository is refused with a specific code', async () => {
  const { engine, root, cleanup } = await harness();
  try {
    await expectLabError(engine.prepareRepo(path.join(root, 'never-created')), 'repo_not_found');

    const bare = path.join(root, 'bare.git');
    await engine.runGit(['init', '--bare', bare], { cwd: root });
    await expectLabError(engine.prepareRepo(bare), 'bare');
  } finally {
    await cleanup();
  }
});

test('input shape errors carry bad_path or remote_invalid', async () => {
  const { engine, cleanup } = await harness();
  try {
    await expectLabError(engine.prepareRepo(''), 'bad_path');
    await expectLabError(engine.prepareRepo('relative/dir'), 'bad_path');
    await expectLabError(engine.prepareRepo('github.com/owner/repo'), 'remote_invalid');
    await expectLabError(engine.prepareRepo({ url: '  ' }), 'bad_path');

    const byKey = await engine.prepareRepo({ path: '' }).catch((error) => error);
    assert.equal(byKey.code, 'bad_path');
  } finally {
    await cleanup();
  }
});

test('validateRepo stays read-only and never initialises a directory', async () => {
  const { engine, root, cleanup } = await harness();
  try {
    const dir = path.join(root, 'not-a-repo');
    await mkdir(dir);
    await expectLabError(engine.validateRepo(dir), 'not_git');
    await assert.rejects(readFile(path.join(dir, '.git', 'HEAD'), 'utf8'));
    await expectLabError(engine.validateRepo('relative'), 'bad_path');
  } finally {
    await cleanup();
  }
});

test('missing Git is reported as git_missing and gitInfo explains the remedy', async () => {
  const { engine, cleanup } = await harness({
    gitAvailable: false,
    gitExecutable: 'no-such-git',
    platform: 'plan9',
  });
  try {
    await expectLabError(engine.prepareRepo(path.join(tmpdir(), 'whatever')), 'git_missing');
    const info = await engine.gitInfo();
    assert.equal(info.available, false);
    assert.equal(info.version, null);
    assert.equal(info.manager, null);
    assert.equal(info.installCommand, null);
    assert.match(info.downloadUrl, /^https:\/\/git-scm\.com\//);
  } finally {
    await cleanup();
  }
});

test('installGit refuses to run without explicit confirmation', async () => {
  const { engine, cleanup, subprocess } = await harness({
    gitAvailable: false,
    hiddenGit: 'no-such-git',
    gitExecutable: 'no-such-git',
    platform: 'linux',
  });
  try {
    await expectLabError(engine.installGit({}), 'git_install_unconfirmed');
    await expectLabError(engine.installGit(undefined), 'git_install_unconfirmed');
    const installerCalls = subprocess.state.calls.filter((argv) => argv[0] === 'sudo');
    assert.equal(installerCalls.length, 0);
  } finally {
    await cleanup();
  }
});

test('installGit reports the platform command and succeeds when Git appears', async () => {
  const { engine, cleanup, subprocess } = await harness({
    gitAvailable: false,
    hiddenGit: 'no-such-git',
    gitExecutable: 'no-such-git',
    platform: 'linux',
    installer: 'ok',
  });
  try {
    const before = await engine.gitInfo();
    assert.equal(before.available, false);
    assert.equal(before.manager, 'apt-get');
    assert.equal(before.installCommand, 'sudo apt-get install -y git');

    const result = await engine.installGit({ confirmed: true });
    assert.equal(result.installed, true);
    assert.equal(result.alreadyPresent, false);
    assert.equal(result.version, '9.9.9-fake');
    assert.ok(subprocess.state.calls.some((argv) => argv[0] === 'sudo'));
    assert.equal((await engine.gitInfo()).available, true);
  } finally {
    await cleanup();
  }
});

test('installGit surfaces an installer failure and an unsupported platform', async () => {
  const failing = await harness({
    gitAvailable: false,
    hiddenGit: 'no-such-git',
    gitExecutable: 'no-such-git',
    platform: 'win32',
    installer: 'fail',
  });
  try {
    await assert.rejects(failing.engine.installGit({ confirmed: true }), (error) => {
      assert.ok(error instanceof LabError);
      assert.equal(error.code, 'git_install_failed');
      assert.equal(error.status, 502);
      assert.match(error.message, /installer refused to run/);
      return true;
    });
  } finally {
    await failing.cleanup();
  }

  const unsupported = await harness({
    gitAvailable: false,
    hiddenGit: 'no-such-git',
    gitExecutable: 'no-such-git',
    platform: 'plan9',
  });
  try {
    await expectLabError(unsupported.engine.installGit({ confirmed: true }), 'git_install_unsupported');
  } finally {
    await unsupported.cleanup();
  }
});

test('installGit is a no-op when Git is already available', async () => {
  const { engine, cleanup, subprocess } = await harness();
  try {
    const result = await engine.installGit({ confirmed: true });
    assert.equal(result.alreadyPresent, true);
    assert.equal(result.installed, true);
    assert.ok(typeof result.version === 'string' && result.version.length > 0);
    const installerCalls = subprocess.state.calls.filter((argv) => argv[0] === 'sudo' || argv[0] === 'winget');
    assert.equal(installerCalls.length, 0);
  } finally {
    await cleanup();
  }
});

// Publication hardening regression cases.
test('preparing a child never mutates an unborn ancestor repository', async () => {
  const { engine, root, subprocess, cleanup } = await harness();
  try {
    const parent = path.join(root, 'parent');
    const selected = path.join(parent, 'selected');
    await mkdir(selected, { recursive: true });
    assert.equal((await engine.runGit(['init', parent], { cwd: parent })).code, 0);
    await writeFile(path.join(parent, 'outside.txt'), 'staged outside selection\n');
    assert.equal((await engine.runGit(['add', 'outside.txt'], { cwd: parent })).code, 0);
    const index = await readFile(path.join(parent, '.git', 'index'));
    const config = await readFile(path.join(parent, '.git', 'config'));
    const head = await readFile(path.join(parent, '.git', 'HEAD'));
    const callStart = subprocess.state.calls.length;
    await assert.rejects(engine.prepareRepo(selected), (error) => {
      assert.ok(error instanceof LabError);
      assert.equal(error.code, 'repo_parent_unsafe');
      assert.equal(error.status, 422);
      assert.ok(!error.message.includes(parent));
      return true;
    });
    assert.deepEqual(await readFile(path.join(parent, '.git', 'index')), index);
    assert.deepEqual(await readFile(path.join(parent, '.git', 'config')), config);
    assert.deepEqual(await readFile(path.join(parent, '.git', 'HEAD')), head);
    assert.notEqual((await engine.runGit(['rev-parse', '--verify', 'HEAD'], { cwd: parent })).code, 0);
    assert.ok(!subprocess.state.calls.slice(callStart).some((argv) =>
      ['init', 'add', 'commit'].some((command) => argv.includes(command))));
    assert.deepEqual(await readdir(selected), []);
  } finally { await cleanup(); }
});

test('read-only validation resolves an ancestor but preparation refuses it', async () => {
  const { engine, root, cleanup } = await harness();
  try {
    const parent = path.join(root, 'parent');
    await mkdir(parent);
    const initial = await engine.prepareRepo(parent);
    const selected = path.join(parent, 'selected');
    await mkdir(selected);
    assert.equal((await engine.validateRepo(selected)).baseCommit, initial.baseCommit);
    await expectLabError(engine.prepareRepo(selected), 'repo_parent_unsafe');
    assert.equal(await engine.headOf(parent), initial.baseCommit);
  } finally { await cleanup(); }
});

test('preparing an unborn index preserves staged v1 and unstaged v2', async () => {
  const { engine, root, subprocess, cleanup } = await harness();
  try {
    const dir = path.join(root, 'staged');
    await mkdir(dir);
    assert.equal((await engine.runGit(['init', dir], { cwd: dir })).code, 0);
    await writeFile(path.join(dir, 'staged.txt'), 'v1\n');
    assert.equal((await engine.runGit(['add', 'staged.txt'], { cwd: dir })).code, 0);
    await writeFile(path.join(dir, 'staged.txt'), 'v2\n');
    await writeFile(path.join(dir, 'untracked.txt'), 'leave untracked\n');
    const config = await readFile(path.join(dir, '.git', 'config'));
    const callStart = subprocess.state.calls.length;
    const info = await engine.prepareRepo(dir);
    const committed = await engine.runGit(['show', 'HEAD:staged.txt'], { cwd: dir });
    assert.equal(committed.code, 0);
    assert.equal(committed.stdout, 'v1\n');
    assert.equal(await readFile(path.join(dir, 'staged.txt'), 'utf8'), 'v2\n');
    assert.equal(await readFile(path.join(dir, 'untracked.txt'), 'utf8'), 'leave untracked\n');
    assert.equal((await engine.runGit(['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: dir })).stdout.trim(), 'staged.txt');
    assert.equal(info.initialized, true);
    assert.equal(info.dirty, true);
    assert.deepEqual(await readFile(path.join(dir, '.git', 'config')), config);
    assert.ok(!subprocess.state.calls.slice(callStart).some((argv) => argv.includes('add')));
  } finally { await cleanup(); }
});

test('a canonical alias of the selected root is accepted', async () => {
  const { engine, root, cleanup } = await harness();
  try {
    const dir = path.join(root, 'canonical');
    const alias = path.join(root, 'alias');
    await mkdir(dir);
    const first = await engine.prepareRepo(dir);
    await symlink(dir, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const second = await engine.prepareRepo(alias);
    assert.equal(second.baseCommit, first.baseCommit);
    assert.equal(await realpath(second.repoRoot), await realpath(dir));
  } finally { await cleanup(); }
});

test('concurrent clones publish once and the loser cannot delete the winner', async () => {
  let startSecond;
  const bothCloning = new Promise((resolve) => { startSecond = resolve; });
  let finishFirst;
  const firstPublished = new Promise((resolve) => { finishFirst = resolve; });
  let cloneCount = 0;
  const { engine, root, subprocess, cleanup } = await harness({
    beforeClone: async () => {
      cloneCount += 1;
      if (cloneCount === 1) await bothCloning;
      else { startSecond(); await firstPublished; }
    },
  });
  try {
    const source = path.join(root, 'source');
    await mkdir(source);
    await writeFile(path.join(source, 'README.md'), 'concurrent seed\n');
    await engine.prepareRepo(source);
    const url = pathToFileURL(source).href;
    const requests = [engine.prepareRepo(url), engine.prepareRepo(url)].map((request) =>
      request.finally(() => finishFirst()));
    const results = await Promise.allSettled(requests);
    assert.equal(cloneCount, 2);
    assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'fulfilled']);
    const [first, second] = results.map((result) => result.value);
    assert.equal(first.repoRoot, second.repoRoot);
    assert.equal(first.baseCommit, second.baseCommit);
    assert.equal(await readFile(path.join(first.repoRoot, 'README.md'), 'utf8'), 'concurrent seed\n');
    const cached = await engine.prepareRepo(url);
    assert.equal(cached.prepared, 'remote-cache');
    assert.equal(cached.baseCommit, first.baseCommit);
    assert.deepEqual(await readdir(path.join(root, 'repos')), [path.basename(first.repoRoot)]);
    assert.ok(!subprocess.state.calls.some((argv) => argv.includes('push')));
  } finally { startSecond(); finishFirst(); await cleanup(); }
});

for (const [index, url] of [
  'https://synthetic-secret@example.invalid/owner/repo.git',
  'http://user:synthetic-secret@example.invalid/owner/repo.git',
  'https://user:synthetic-secret@example.invalid/owner/repo.git',
  'ssh://git:synthetic-secret@example.invalid/owner/repo.git',
  'git://git:synthetic-secret@example.invalid/owner/repo.git',
  'file://user:synthetic-secret@example.invalid/owner/repo.git',
].entries()) {
  test(`credential-bearing URL ${index + 1} is rejected before cache or clone`, async () => {
    const { engine, root, subprocess, cleanup } = await harness({
      gitExecutable: 'no-such-git',
      onRealSpawn() { assert.fail('rejected credentials must never reach a real executable'); },
    });
    try {
      await assert.rejects(engine.prepareRepo(url), (error) => {
        assert.ok(error instanceof LabError, error?.message);
        assert.equal(error.code, 'remote_credentials_unsupported');
        assert.ok(!error.message.includes('synthetic-secret'));
        assert.ok(!JSON.stringify(error).includes('synthetic-secret'));
        return true;
      });
      assert.ok(!(await readdir(root)).includes('repos'));
      assert.ok(!JSON.stringify(subprocess.state.calls).includes('synthetic-secret'));
    } finally { await cleanup(); }
  });
}

for (const suffix of ['?token=synthetic-secret', '#synthetic-secret']) {
  test(`HTTP URL ${suffix[0] === '?' ? 'query' : 'fragment'} is rejected before clone`, async () => {
    const { engine, root, subprocess, cleanup } = await harness({
      gitExecutable: 'no-such-git',
      onRealSpawn() { assert.fail('invalid URL must never reach a real executable'); },
    });
    try {
      await expectLabError(engine.prepareRepo(`https://example.invalid/owner/repo.git${suffix}`), 'remote_invalid');
      assert.ok(!(await readdir(root)).includes('repos'));
      assert.ok(!JSON.stringify(subprocess.state.calls).includes('synthetic-secret'));
    } finally { await cleanup(); }
  });
}

for (const url of [
  'ssh://deploy-marker@example.invalid/owner/repo.git?query-marker#fragment-marker',
  'git@example.invalid:owner/repo.git',
]) {
  test(`SSH remote syntax stays supported with a host/path-only cache label (${url.startsWith('ssh:') ? 'URL' : 'SCP'})`, async () => {
    const { engine, cleanup, subprocess } = await harness({
      gitExecutable: 'no-such-git',
      onRealSpawn() { assert.fail('SSH metadata test must stay entirely mocked'); },
    });
    try {
      const info = await engine.prepareRepo(url);
      assert.equal(info.prepared, 'remote-clone');
      assert.equal(info.remote, url);
      assert.match(path.basename(info.repoRoot), /^example\.invalid-owner-repo\.git-[a-f0-9]{12}$/);
      assert.ok(!/deploy-marker|query-marker|fragment-marker/.test(path.basename(info.repoRoot)));
      assert.ok(subprocess.state.calls.some((argv) => argv.includes('clone') && argv.includes(url)));
    } finally { await cleanup(); }
  });
}

test('missing-Git fallback probes never delegate absolute Git executables', async () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const { engine, subprocess, cleanup } = await harness({
      gitAvailable: false, gitExecutable: 'no-such-git', platform,
      onRealSpawn(spec) { assert.fail(`missing Git escaped mock: ${spec.argv[0]}`); },
    });
    try {
      assert.equal((await engine.gitInfo()).available, false);
      assert.ok(subprocess.state.calls.length > 1);
    } finally { await cleanup(); }
  }
});

