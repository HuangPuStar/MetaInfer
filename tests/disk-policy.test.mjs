/**
 * Disk policy (2026-11-26): the Host must not commit oversized worktree
 * artifacts into git history, and the default repository excludes keep raw
 * captures out of `git status`/`git add -A` entirely.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGitEngine } from '../host/git-engine.js';
import { normalizeNodeReport } from '../host/runtime.js';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

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

async function repo() {
  const root = await mkdtemp(path.join(tmpdir(), 'mi-disk-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'test');
  git(root, 'config', 'user.email', 'test@local');
  await writeFile(path.join(root, 'README.md'), 'base\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');
  const engine = createGitEngine({ subprocess: { spawn: realChild } }, { reposRoot: path.join(root, '..', `cache-${path.basename(root)}`) });
  return { root, engine };
}

test('default excludes keep raw captures out of git status', async () => {
  const { root, engine } = await repo();
  try {
    assert.equal(await engine.ensureRepoExcludes(root), true);
    // Re-running is idempotent.
    assert.equal(await engine.ensureRepoExcludes(root), false);
    const exclude = await readFile(path.join(root, '.git', 'info', 'exclude'), 'utf8');
    assert.match(exclude, /profile\//);
    assert.match(exclude, /\*\.tar\.gz/);
    await mkdir(path.join(root, 'profile'), { recursive: true });
    await writeFile(path.join(root, 'profile', 'capture.bin'), 'x');
    assert.equal(git(root, 'status', '--porcelain').trim(), '');
    assert.deepEqual(await engine.untrackedFiles(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an oversized untracked artifact is refused instead of committed', async () => {
  const { root, engine } = await repo();
  try {
    await writeFile(path.join(root, 'big.bin'), Buffer.alloc(2 * 1024 * 1024, 1));
    const project = { config: { diskPolicy: { maxFileMb: 1 } } };
    const node = { git: { worktreePath: root } };
    await assert.rejects(
      () => engine.commitWorktree(project, node, 'dshex: test'),
      (error) => error?.code === 'artifact_too_large' && /big\.bin/.test(error.message),
    );
    // The guard refuses before `git add`, so nothing entered the index.
    assert.equal(git(root, 'diff', '--cached', '--name-only').trim(), '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the report contract carries declared artifact sizes', () => {
  const report = normalizeNodeReport({
    summary: 'done',
    success: true,
    artifacts: [
      { path: 'out/metrics.csv', sizeBytes: 1024 },
      { path: 'out/report.md' },
      { path: '' },
    ],
  });
  assert.deepEqual(report.artifacts, [
    { path: 'out/metrics.csv', sizeBytes: 1024 },
    { path: 'out/report.md', sizeBytes: null },
  ]);
});
