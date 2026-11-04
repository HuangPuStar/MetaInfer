/**
 * Plugin update engine: inspect the installed copy, check the GitHub branch and
 * replace the install with either the remote snapshot or a local directory.
 *
 * The plugin is normally installed as a linked directory, so updating means
 * copying files over the package root. Updates always back up the current tree
 * first (without node_modules) and report that a restart is required, because
 * the Host and Client halves are only re-imported when DSH restarts.
 */
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_NAME = 'dsh-metainfer-research-lab';
const DEFAULT_REPO = 'https://github.com/HuangPuStar/MetaInfer.git';
const DEFAULT_BRANCH = 'feat/dsh-metainfer-research-lab';
const DEFAULT_SUBDIR = 'dsh-metainfer-research-lab';
const BACKUP_LIMIT = 5;
const SKIP_COPY = new Set(['node_modules', '.git']);

function failure(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function firstString() {
  for (let index = 0; index < arguments.length; index += 1) {
    const value = arguments[index];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function insidePath(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function normalizeProxy(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') return '';
  return /^[a-z]+:\/\//i.test(text) ? text : 'http://' + text;
}

/** Resolve the plugin root from a module URL (index.js passes its own URL). */
export function updateRootFrom(metaUrl) {
  return path.resolve(path.dirname(fileURLToPath(metaUrl)), '..');
}

/** Read and validate the plugin package manifest of a directory. */
export async function readPluginPackage(dir) {
  let raw;
  try {
    raw = await readFile(path.join(dir, 'package.json'), 'utf8');
  } catch {
    throw failure('bad_source', 'plugin source has no readable package.json');
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw failure('bad_source', 'plugin source package.json is not valid JSON');
  }
  if (manifest === null || typeof manifest !== 'object' || manifest.name !== PLUGIN_NAME) {
    throw failure('bad_source', 'package.json name must be ' + PLUGIN_NAME);
  }
  return {
    dir: path.resolve(dir),
    name: PLUGIN_NAME,
    version: typeof manifest.version === 'string' && manifest.version ? manifest.version : '0.0.0',
  };
}

/** Validate a directory before it is copied over the installed plugin. */
export async function validatePluginSource(dir, target) {
  if (typeof dir !== 'string' || dir.trim() === '') {
    throw failure('bad_request', 'sourcePath is required');
  }
  const source = path.resolve(dir.trim());
  let info;
  try {
    info = await stat(source);
  } catch {
    throw failure('bad_source', 'source directory does not exist: ' + source);
  }
  if (!info.isDirectory()) throw failure('bad_source', 'source is not a directory: ' + source);
  const manifest = await readPluginPackage(source);
  if (target && samePath(source, target)) {
    throw failure('same_source', 'source directory is the current install directory');
  }
  if (target && insidePath(source, target)) {
    throw failure('source_inside_install', 'source directory is inside the current install directory');
  }
  if (target && insidePath(target, source)) {
    throw failure('install_inside_source', 'source directory contains the current install directory');
  }
  return manifest;
}

function copyFilter(sourcePath) {
  return !SKIP_COPY.has(path.basename(sourcePath));
}

/** Merge a plugin tree into target, preserving target node_modules and .git. */
export async function copyPluginTree(source, target) {
  await mkdir(target, { recursive: true });
  await cp(source, target, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter: copyFilter,
  });
}

/** Copy the current install into the data directory; keep the newest backups. */
export async function backupPlugin(root, stateDir, options = {}) {
  const backupsDir = path.join(stateDir, 'plugin-backups');
  await mkdir(backupsDir, { recursive: true });
  const now = options.now instanceof Date ? options.now : new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const target = path.join(backupsDir, stamp);
  await copyPluginTree(root, target);
  let entries = [];
  try {
    entries = await readdir(backupsDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  for (const name of names.slice(BACKUP_LIMIT)) {
    await rm(path.join(backupsDir, name), { recursive: true, force: true }).catch(() => {});
  }
  return target;
}

function describeGitFailure(args, code, stderr) {
  const detail = String(stderr || '').trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || '';
  const command = 'git ' + args.slice(0, 3).join(' ');
  return command + ' failed (exit ' + String(code) + ')' + (detail ? ': ' + detail : '');
}

/**
 * Run a git command with the given proxy. Resolves {stdout,stderr} or rejects
 * with an Error carrying a stable code (git_missing/git_failed/git_timeout).
 */
export function runGit(args, options = {}) {
  return new Promise((resolve, reject) => {
    const proxy = normalizeProxy(options.proxy);
    const argv = [];
    if (proxy !== '') argv.push('-c', 'http.proxy=' + proxy, '-c', 'https.proxy=' + proxy);
    argv.push('-c', 'credential.interactive=never', ...args);
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    if (proxy !== '') {
      env.HTTP_PROXY = proxy;
      env.HTTPS_PROXY = proxy;
      env.http_proxy = proxy;
      env.https_proxy = proxy;
    }
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 120000;
    let child;
    try {
      child = spawn('git', argv, { cwd: options.cwd || undefined, env, windowsHide: true });
    } catch (error) {
      reject(failure('git_missing', 'git executable is not available: ' + error.message, 500));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    const finish = (code, override) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(failure(override?.code || 'git_failed', override?.message || describeGitFailure(args, code, stderr), 500));
    };
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Best effort.
      }
      finish('timeout', {
        code: 'git_timeout',
        message: 'git timed out after ' + String(Math.round(timeoutMs / 1000)) + 's',
      });
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdout = (stdout + String(chunk)).slice(-1000000);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-1000000);
    });
    child.on('error', (error) => {
      finish('spawn', { code: 'git_missing', message: 'failed to start git: ' + error.message });
    });
    child.on('close', (code) => finish(code));
  });
}

async function readRemoteSha(run, repo, branch, proxy) {
  const { stdout } = await run(['ls-remote', repo, 'refs/heads/' + branch], { proxy, timeoutMs: 30000 });
  const line = String(stdout || '').split(/\r?\n/).find((entry) => entry.trim() !== '');
  if (!line) throw failure('branch_not_found', 'branch not found on remote: ' + branch, 400);
  return line.trim().split(/\s+/)[0];
}

async function clonePluginSnapshot(run, repo, branch, subdir, proxy) {
  const cloneRoot = await mkdtemp(path.join(os.tmpdir(), 'mirl-update-'));
  const fullArgs = ['clone', '--depth', '1', '--branch', branch, '--single-branch', '--', repo, cloneRoot];
  const sparseArgs = [
    'clone', '--depth', '1', '--branch', branch, '--single-branch',
    '--filter=blob:none', '--sparse', '--', repo, cloneRoot,
  ];
  try {
    try {
      await run(sparseArgs, { proxy, timeoutMs: 300000 });
    } catch {
      await rm(cloneRoot, { recursive: true, force: true }).catch(() => {});
      await mkdir(cloneRoot, { recursive: true });
      await run(fullArgs, { proxy, timeoutMs: 300000 });
    }
    try {
      await run(['-C', cloneRoot, 'sparse-checkout', 'set', subdir], { proxy, timeoutMs: 60000 });
    } catch {
      // A non-sparse clone already contains the full tree; ignore this step.
    }
    const source = path.join(cloneRoot, subdir);
    await readPluginPackage(source).catch(() => {
      throw failure('source_not_found', 'plugin subdirectory not found in the remote snapshot: ' + subdir, 500);
    });
    return { root: cloneRoot, source };
  } catch (error) {
    await rm(cloneRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Create the update service bound to one install root and one state directory.
 * Tests pass a temporary root/stateDir; index.js uses the defaults.
 */
export function createUpdateService(options = {}) {
  const root = path.resolve(options.root || updateRootFrom(import.meta.url));
  const stateDir = path.resolve(options.stateDir || path.join(dshHome(), 'metainfer-research-lab'));
  const repoUrl = firstString(options.repoUrl, DEFAULT_REPO);
  const branch = firstString(options.branch, DEFAULT_BRANCH);
  const subdir = firstString(options.subdir, DEFAULT_SUBDIR);
  const run = typeof options.runGit === 'function' ? options.runGit : runGit;
  const clock = typeof options.now === 'function' ? options.now : () => new Date();
  const stateFile = path.join(stateDir, 'update-state.json');

  async function readState() {
    try {
      return JSON.parse(await readFile(stateFile, 'utf8'));
    } catch {
      return null;
    }
  }

  async function writeState(state) {
    await mkdir(stateDir, { recursive: true });
    await writeFile(stateFile, JSON.stringify(state, null, 2) + '\n');
  }

  async function status() {
    const manifest = await readPluginPackage(root);
    const state = await readState();
    const record = state !== null && typeof state === 'object' ? state : {};
    return {
      name: manifest.name,
      version: manifest.version,
      root,
      stateDir,
      repoUrl,
      branch,
      subdir,
      source: firstString(record.source),
      sourcePath: firstString(record.sourcePath),
      updatedAt: firstString(record.updatedAt),
      remoteSha: firstString(record.remoteSha),
    };
  }

  async function check(input = {}) {
    const proxy = normalizeProxy(input.proxy);
    const remoteSha = await readRemoteSha(run, repoUrl, branch, proxy);
    const state = await readState();
    const record = state !== null && typeof state === 'object' ? state : {};
    const installedRemoteSha = firstString(record.remoteSha);
    return {
      repoUrl,
      branch,
      remoteSha,
      installedRemoteSha,
      updateAvailable: installedRemoteSha === '' ? null : remoteSha !== installedRemoteSha,
    };
  }

  async function applyFrom(sourcePath, meta = {}) {
    const manifest = await validatePluginSource(sourcePath, root);
    await mkdir(stateDir, { recursive: true });
    const current = await readPluginPackage(root).catch(() => null);
    let backup = '';
    try {
      backup = await backupPlugin(root, stateDir, { now: clock() });
    } catch (error) {
      throw failure('backup_failed', 'could not back up the current install: ' + error.message, 500);
    }
    try {
      await copyPluginTree(manifest.dir, root);
    } catch (error) {
      try {
        await copyPluginTree(backup, root);
      } catch {
        // The backup path is reported below; a failed restore leaves it usable.
      }
      throw failure('copy_failed', 'could not write plugin files: ' + error.message, 500);
    }
    const state = {
      name: manifest.name,
      version: manifest.version,
      previousVersion: current !== null ? current.version : '',
      source: meta.source === 'github' ? 'github' : 'local',
      sourcePath: manifest.dir,
      remoteSha: typeof meta.remoteSha === 'string' ? meta.remoteSha : '',
      updatedAt: clock().toISOString(),
      backup,
    };
    await writeState(state);
    return {
      version: manifest.version,
      previousVersion: state.previousVersion,
      source: state.source,
      backup,
      updatedAt: state.updatedAt,
      restartRequired: true,
    };
  }

  async function applyLocal(input = {}) {
    return applyFrom(input.sourcePath, { source: 'local' });
  }

  async function applyGithub(input = {}) {
    const proxy = normalizeProxy(input.proxy);
    const remoteSha = await readRemoteSha(run, repoUrl, branch, proxy);
    const snapshot = await clonePluginSnapshot(run, repoUrl, branch, subdir, proxy);
    try {
      const result = await applyFrom(snapshot.source, { source: 'github', remoteSha });
      return { ...result, remoteSha };
    } finally {
      await rm(snapshot.root, { recursive: true, force: true }).catch(() => {});
    }
  }

  return { root, stateDir, repoUrl, branch, subdir, status, check, applyLocal, applyGithub };
}
