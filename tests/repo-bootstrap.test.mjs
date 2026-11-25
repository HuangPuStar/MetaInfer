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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
      // Also match absolute candidates (/usr/bin/git, C:\\...\\git.exe): the
      // engine falls back to a candidate list after the bare name fails, so
      // matching only `git` made this harness pass or fail depending on whether
      // the host machine happened to have Git installed.
      const isGit = /(^|[\\/])git(\.exe)?$/i.test(argv[0]) || argv[0] === hiddenGit;
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
      return realChild(spec);
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
  const root = await mkdtemp(path.join(tmpdir(), 'metainfer-repo-'));
  const subprocess = seam(options);
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
