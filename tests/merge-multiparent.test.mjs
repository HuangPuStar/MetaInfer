/**
 * Regression for the multi-parent Join bug: merging parent branches one by one
 * with `git merge --no-commit` leaves MERGE_HEAD behind, so the third parent
 * used to fail with "You have not concluded your merge" and the merge was still
 * reported as clean. The Host now commits each parent step before the next one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGitEngine } from '../host/git-engine.js';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

/** Real process runner mirroring tests/repo-bootstrap.test.mjs. */
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
const ctx = { subprocess: { spawn: realChild } };

async function repoWithThreeBranches() {
  const root = await mkdtemp(path.join(tmpdir(), 'mi-merge-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'test');
  git(root, 'config', 'user.email', 'test@local');
  await writeFile(path.join(root, 'shared.txt'), 'base\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');
  for (const name of ['a', 'b', 'c']) {
    git(root, 'checkout', '-qb', name);
    await writeFile(path.join(root, `${name}.txt`), `${name}\n`);
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', `${name}`);
    git(root, 'checkout', '-q', 'main');
  }
  return root;
}

test('merging three parent branches commits each step so the next one applies', async () => {
  const root = await repoWithThreeBranches();
  const engine = createGitEngine(ctx, { reposRoot: path.join(root, '..', `cache-${path.basename(root)}`) });
  try {
    const first = await engine.mergeBranchIntoWorktree(root, 'a');
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual(first.conflicts, []);
    const step1 = await engine.finishMergeInWorktree(root, 'merge a');
    assert.ok(step1.head);
    // The step commit must clear MERGE_HEAD; otherwise the next parent cannot merge.
    assert.throws(() => git(root, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'));

    const second = await engine.mergeBranchIntoWorktree(root, 'b');
    assert.equal(second.code, 0, second.stderr);
    await engine.finishMergeInWorktree(root, 'merge b');

    const third = await engine.mergeBranchIntoWorktree(root, 'c');
    assert.equal(third.code, 0, third.stderr);
    assert.deepEqual(third.conflicts, []);
    const final = await engine.finishMergeInWorktree(root, 'merge c');
    assert.ok(final.head);

    for (const name of ['a', 'b', 'c']) {
      assert.equal(git(root, 'show', `HEAD:${name}.txt`).trim(), name);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(path.join(root, '..', `cache-${path.basename(root)}`), { recursive: true, force: true });
  }
});

test('a merge blocked by MERGE_HEAD reports a failing exit code, never a clean one', async () => {
  const root = await repoWithThreeBranches();
  const engine = createGitEngine(ctx, { reposRoot: path.join(root, '..', `cache-${path.basename(root)}`) });
  try {
    const first = await engine.mergeBranchIntoWorktree(root, 'a');
    assert.equal(first.code, 0);
    // Deliberately skip the commit: this is what prepareMerge used to do.
    const blocked = await engine.mergeBranchIntoWorktree(root, 'b');
    assert.notEqual(blocked.code, 0);
    assert.deepEqual(blocked.conflicts, []);
    assert.match(blocked.stderr, /MERGE_HEAD/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(path.join(root, '..', `cache-${path.basename(root)}`), { recursive: true, force: true });
  }
});
