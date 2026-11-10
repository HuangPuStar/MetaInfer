#!/usr/bin/env node
/**
 * Process-level smoke: spawn the Host entry in a fresh Node process with a
 * Host-like context, activate the plugin, create a project on a temp git repo,
 * run one node through the real runtime with a stub worker, and assert a
 * completed node plus a non-empty cause chain. Any uncaught exception or
 * unhandled rejection in the child fails the test.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = await mkdtemp(path.join(os.tmpdir(), 'mirl-smoke-repo-'));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
try {
  git('init', '-b', 'main');
  git('config', 'user.name', 'Smoke Test');
  git('config', 'user.email', 'smoke@localhost');
  await writeFile(path.join(root, 'README.md'), '# smoke\n');
  git('add', 'README.md');
  git('commit', '-m', 'initial');

  const child = spawn(process.execPath, [path.join(HERE, 'plugin-smoke-child.mjs')], {
    cwd: path.resolve(HERE, '..'),
    env: { ...process.env, MIRL_SMOKE_REPO: root, DSH_HOME: path.join(root, '.dsh') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 60_000);
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  clearTimeout(timeout);
  assert.equal(code, 0, `child exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  assert.doesNotMatch(stderr, /uncaught|unhandledRejection/i, stderr);
  const line = stdout.trim().split('\n').filter(Boolean).at(-1);
  const result = JSON.parse(line);
  assert.equal(result.status, 'completed');
  assert.ok(typeof result.reportSummary === 'string' && result.reportSummary.length > 0);
  assert.ok(result.chainLength > 0, 'cause chain is empty');
  assert.equal(result.completedEvent, true);
  process.stdout.write(`ok   plugin activates and completes one node (${result.status}, cause chain ${result.chainLength})\n`);
  process.stdout.write(`ok   completed node carries summary: ${result.reportSummary}\n`);
  process.stdout.write(`ok   node/completed is in the explanation (${result.eventCount} events)\n`);
  process.stdout.write('3/3 process smoke checks passed\n');
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
