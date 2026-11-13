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
import { mkdir, mkdtemp, readdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMAIN_TABLE_NAMES, STORAGE_NAME_RE } from '../host/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = await mkdtemp(path.join(os.tmpdir(), 'mirl-smoke-repo-'));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
for (const table of DOMAIN_TABLE_NAMES) {
  assert.match(table, STORAGE_NAME_RE, `storage table '${table}' must match the DSH unit name rule`);
}
let startupHome = null;
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
  assert.equal(result.activityAdvanced, true, 'turn-internal activity was not observed');
  assert.equal(result.activityEvent, true, 'node/activity event was not observed');
  assert.equal(result.preemptionStatus, 'cancelled');
  assert.equal(result.preemptionFor, 'p0-smoke');
  assert.equal(result.preemptionAppeal, 'appealed');
  assert.equal(result.preemptionAppealReason, 'smoke: record and review the preemption');
  assert.equal(result.preemptionEvent, true);
  assert.equal(result.preemptionAppealedEvent, true);
  // Startup path on an *existing* v2 unit created by an older version. It has
  // projects/ but no actor_keys/; opening it must not require a fresh unit.
  startupHome = await mkdtemp(path.join(os.tmpdir(), 'mirl-startup-home-'));
  const unitDir = path.join(startupHome, 'storages', 'metainfer_research_lab_v2');
  await mkdir(path.join(unitDir, 'projects'), { recursive: true });
  const existingProject = {
    version: 2,
    record: {
      id: 'prj-old-v2', name: 'old v2 unit', brief: 'existing unit without actor_keys',
      repo: { path: root, baseBranch: 'main', baseCommit: 'base', worktreeRoot: path.join(startupHome, 'worktrees', 'prj-old-v2') },
      mode: 'manual', config: { resourcePools: {}, maxRunningNodes: 1, maxNodes: 10, nodeTimeoutMinutes: 1 },
      counters: { eventSeq: 0, nextNodeSeq: 1, nodes: 1 }, revision: 0,
      createdAt: 1, updatedAt: 1,
    },
  };
  await writeFile(path.join(unitDir, 'projects', 'prj-old-v2.json'), JSON.stringify(existingProject, null, 2));

  const runStartupChild = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(HERE, 'plugin-smoke-child.mjs')], {
      cwd: path.resolve(HERE, '..'),
      env: { ...process.env, MIRL_SMOKE_REPO: root, MIRL_STARTUP_ROOT: startupHome, DSH_HOME: startupHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('error', reject);
    child.on('close', (exitCode) => {
      clearTimeout(timeout);
      resolve({ exitCode, out, err });
    });
  });

  const firstStartup = await runStartupChild();
  assert.equal(firstStartup.exitCode, 0, `startup child exited ${firstStartup.exitCode}\nstdout:\n${firstStartup.out}\nstderr:\n${firstStartup.err}`);
  const firstStartupResult = JSON.parse(firstStartup.out.trim().split('\n').filter(Boolean).at(-1));
  assert.equal(firstStartupResult.status, 'startup-ok');
  assert.equal(firstStartupResult.projects, 1);
  assert.ok(firstStartupResult.keys >= 1, 'startup did not issue an actor key');
  const actorKeysDir = path.join(unitDir, 'actor_keys');
  assert.ok((await readdir(actorKeysDir)).some((file) => file.endsWith('.json')), 'actor_keys table was not materialised');

  const secondStartup = await runStartupChild();
  assert.equal(secondStartup.exitCode, 0, `second startup child exited ${secondStartup.exitCode}\nstdout:\n${secondStartup.out}\nstderr:\n${secondStartup.err}`);
  const secondStartupResult = JSON.parse(secondStartup.out.trim().split('\n').filter(Boolean).at(-1));
  assert.equal(secondStartupResult.status, 'startup-ok');
  assert.equal(secondStartupResult.projects, 1);
  assert.ok(secondStartupResult.keys >= 1, 'the actor key did not survive the restart');
  process.stdout.write(`ok   startup opens an existing v2 unit without actor_keys (${firstStartupResult.projects} project, ${secondStartupResult.keys} key)\n`);

  process.stdout.write(`ok   plugin activates and completes one node (${result.status}, cause chain ${result.chainLength})\n`);
  process.stdout.write(`ok   completed node carries summary: ${result.reportSummary}\n`);
  process.stdout.write(`ok   node/completed is in the explanation (${result.eventCount} events)\n`);
  process.stdout.write('ok   a turn-internal event moves lastActivityAt and writes node/activity\n');
  process.stdout.write('ok   a running node is preempted for p0 with a reviewable appeal trail\n');
  process.stdout.write('6/6 process smoke checks passed\n');
} finally {
  if (startupHome) await rm(startupHome, { recursive: true, force: true }).catch(() => {});
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
