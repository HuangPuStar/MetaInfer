/**
 * GitEngine (M1): every Git command goes through `ctx.subprocess.spawn`.
 * The Host plugin runs unsandboxed by design (documented trust boundary); the
 * worker agents never run git write commands.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { dshHome } from './store.js';

/** Structured business error carrying a stable code for HTTP envelopes. */
export class LabError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'LabError';
    this.code = code;
    this.status = status;
  }
}

/** Git prints POSIX-style paths even on Windows; compare normalised forms. */
function normalizePathForCompare(value) {
  let normalized = String(value ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32') normalized = normalized.toLowerCase();
  return normalized;
}

const GIT_LIMITS = {
  stdoutBytes: 2 * 1024 * 1024,
  stderrBytes: 256 * 1024,
  graceMs: 2000,
};

/** Automatic Git installation runs outside the short-lived command budget. */
const GIT_INSTALL_TIMEOUT_MS = 15 * 60_000;
const GIT_DOWNLOAD_URL = 'https://git-scm.com/downloads';
const GIT_IDENTITY = Object.freeze({ name: 'MetaInfer Research Lab', email: 'metainfer@localhost' });
const REPOS_SUBDIR = ['metainfer-research-lab', 'repos'];

/** Installer executables, kept here so every host reports the same command. */
function gitInstallSpec(platform) {
  if (platform === 'win32') {
    return {
      manager: 'winget',
      command: 'winget install --id Git.Git -e --source winget',
      argv: [
        'winget', 'install', '--id', 'Git.Git', '--exact', '--source', 'winget',
        '--silent', '--disable-interactivity',
        '--accept-package-agreements', '--accept-source-agreements',
      ],
    };
  }
  if (platform === 'darwin') {
    return { manager: 'brew', command: 'brew install git', argv: ['brew', 'install', 'git'] };
  }
  if (platform === 'linux') {
    // `-n` fails instead of prompting; a password-protected sudo cannot run here.
    return { manager: 'apt-get', command: 'sudo apt-get install -y git', argv: ['sudo', '-n', 'apt-get', 'install', '-y', 'git'] };
  }
  return null;
}

/** Well-known Git locations for shells whose PATH the Host process did not inherit. */
const GIT_CANDIDATES = Object.freeze({
  win32: [
    'C:\\Program Files\\Git\\cmd\\git.exe',
    'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
    path.join(homedir(), 'AppData', 'Local', 'Programs', 'Git', 'cmd', 'git.exe'),
  ],
  darwin: ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git'],
  linux: ['/usr/bin/git', '/usr/local/bin/git', '/bin/git'],
});

/** @returns {string} last non-empty stderr/stdout line, for compact messages. */
function lastLine(text) {
  const lines = String(text ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : '';
}

/** @returns {boolean} whether the input is a remote repository URL. */
function isRemoteUrl(value) {
  return /^(https?:\/\/|ssh:\/\/|git:\/\/|file:\/\/|git@[^:/\s]+:)/i.test(value);
}

/** Strip credentials from anything echoed back to the browser. */
function redactUrl(text) {
  return String(text ?? '').replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1***@');
}

/** Validate remote input before it reaches cache paths, Git or public metadata. */
function parseRemoteUrl(value) {
  const scp = /^git@([^:/\s]+):(.+)$/i.exec(value);
  if (scp) return { hostname: scp[1], pathname: `/${scp[2]}` };

  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(value)?.[1] ?? '';
  const userinfo = authority.includes('@') ? authority.slice(0, authority.lastIndexOf('@')) : null;
  const http = /^https?:\/\//i.test(value);
  if ((http && userinfo !== null) || userinfo?.includes(':')) {
    throw new LabError('remote_credentials_unsupported', 'credential-bearing repository URLs are not supported', 400);
  }
  let parsed;
  try { parsed = new URL(value); } catch {
    throw new LabError('remote_invalid', 'use a valid remote repository URL', 400);
  }
  if (parsed.password || (http && parsed.username)) {
    throw new LabError('remote_credentials_unsupported', 'credential-bearing repository URLs are not supported', 400);
  }
  if (http && /[?#]/.test(value)) {
    throw new LabError('remote_invalid', 'repository URLs must not contain a query or fragment', 400);
  }
  return parsed;
}

/** A readable, collision-resistant cache directory name for one remote URL. */
function cacheDirName(url, remote) {
  const digest = createHash('sha256').update(url).digest('hex').slice(0, 12);
  const readable = `${remote.hostname}${remote.pathname}`
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'repo';
  return `${readable}-${digest}`;
}


/**
 * Create the GitEngine bound to one Host context.
 * @param ctx Cordis context with `subprocess` injected.
 * @param {{platform?: string, reposRoot?: string, gitExecutable?: string}} [options]
 *   test seams: the platform decides the installer, the cache root keeps tests
 *   out of the real DSH home, and the executable lets a test hide Git.
 */
export function createGitEngine(ctx, options = {}) {
  const platform = options.platform ?? process.platform;
  const reposRoot = options.reposRoot ?? path.join(dshHome(), ...REPOS_SUBDIR);
  let gitExecutable = options.gitExecutable ?? 'git';

  /**
   * Run one process with a bounded deadline and collected output.
   * @param {string[]} argv executable and arguments.
   * @param {{cwd: string, timeoutMs?: number}} options
   * @returns {Promise<{code: number|null, stdout: string, stderr: string, timedOut: boolean}>}
   */
  async function runProcess(argv, options) {
    const cwd = options?.cwd ?? process.cwd();
    const timeoutMs = options?.timeoutMs ?? 20_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`command timeout after ${timeoutMs}ms`)), timeoutMs);
    try {
      const handle = ctx.subprocess.spawn({
        argv,
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: GIT_LIMITS.stdoutBytes },
          stderr: { maxBytes: GIT_LIMITS.stderrBytes },
        },
        graceMs: GIT_LIMITS.graceMs,
        signal: controller.signal,
      });
      let outcome;
      try {
        outcome = await handle.done;
      } catch (error) {
        return {
          code: null,
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
          timedOut: controller.signal.aborted,
        };
      }
      const stdout = handle.collected.stdout?.readFrom(0).text ?? '';
      const stderr = handle.collected.stderr?.readFrom(0).text ?? '';
      return { code: outcome.exitCode, stdout, stderr, timedOut: controller.signal.aborted };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Run git with a bounded deadline and collected output.
   * @param {string[]} args git arguments (without the leading "git").
   * @param {{cwd: string, timeoutMs?: number}} options
   * @returns {Promise<{code: number|null, stdout: string, stderr: string, timedOut: boolean}>}
   */
  async function runGit(args, options) {
    return runProcess([gitExecutable, ...args], options);
  }

  async function gitText(args, options) {
    const result = await runGit(args, options);
    if (result.code !== 0) {
      throw new LabError('git_failed', result.stderr.trim() || `git ${args[0]} failed`, 422);
    }
    return result.stdout.trim();
  }

  /**
   * Read the version of one executable, or null when it cannot run.
   * @param {string} executable
   * @returns {Promise<string|null>}
   */
  async function versionOf(executable) {
    const result = await runProcess([executable, '--version'], { cwd: tmpdir(), timeoutMs: 10_000 });
    if (result.code !== 0) return null;
    const match = /git version\s+(\S+)/i.exec(result.stdout.trim());
    return match ? match[1] : (result.stdout.trim() || 'unknown');
  }

  /**
   * Locate Git: PATH first, then the well-known install locations. The Host
   * process may have started before Git was installed, so every call re-probes.
   * @returns {Promise<string|null>} version when Git is usable.
   */
  async function detectGit() {
    const direct = await versionOf(gitExecutable);
    if (direct !== null) return direct;
    for (const candidate of GIT_CANDIDATES[platform] ?? []) {
      const version = await versionOf(candidate);
      if (version !== null) {
        gitExecutable = candidate;
        return version;
      }
    }
    return null;
  }

  /** @returns {Promise<string>} Git version, or a `git_missing` LabError. */
  async function requireGit() {
    const version = await detectGit();
    if (version === null) {
      throw new LabError('git_missing', 'Git is not installed or not on PATH', 422);
    }
    return version;
  }

  /**
   * Host facts for the wizard: whether Git is usable and how to install it.
   * @returns {Promise<object>}
   */
  async function gitInfo() {
    const version = await detectGit();
    const spec = gitInstallSpec(platform);
    return {
      available: version !== null,
      version,
      platform,
      manager: spec === null ? null : spec.manager,
      installCommand: spec === null ? null : spec.command,
      downloadUrl: GIT_DOWNLOAD_URL,
    };
  }

  /**
   * Return the facts the wizard needs for an already prepared repository.
   * @param {string} repoRoot absolute repository root.
   * @param {object} [extra] caller-specific fields (`prepared`, `remote`, ...).
   * @returns {Promise<object>}
   */
  async function describeRepo(repoRoot, extra = {}) {
    const bare = await gitText(['-C', repoRoot, 'rev-parse', '--is-bare-repository'], { cwd: repoRoot });
    if (bare === 'true') throw new LabError('bare', 'bare repositories are not supported', 422);

    const gitDir = await gitText(['-C', repoRoot, 'rev-parse', '--absolute-git-dir'], { cwd: repoRoot });

    const branchOut = await gitText(
      ['-C', repoRoot, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'],
      { cwd: repoRoot },
    );
    const branches = branchOut.split('\n').map((line) => line.trim()).filter(Boolean);

    let defaultBranch;
    try {
      defaultBranch = await gitText(['-C', repoRoot, 'symbolic-ref', '--short', 'HEAD'], { cwd: repoRoot });
    } catch {
      defaultBranch = branches[0];
    }
    if (!defaultBranch) throw new LabError('no_commits', 'repository has no branch to start from', 422);

    // `--quiet` makes an unborn HEAD a plain non-zero exit; without it Git
    // prints "fatal: Needed a single revision", which is not a usable message.
    const head = await runGit(['-C', repoRoot, 'rev-parse', '--quiet', '--verify', `${defaultBranch}^{commit}`], { cwd: repoRoot });
    if (head.code !== 0) throw new LabError('no_commits', 'repository has no commits yet', 422);
    const status = await runGit(['-C', repoRoot, 'status', '--porcelain'], { cwd: repoRoot });

    return {
      repoRoot,
      gitDir,
      branches,
      defaultBranch,
      baseCommit: head.stdout.trim(),
      dirty: status.code === 0 && status.stdout.trim().length > 0,
      ...extra,
    };
  }

  /**
   * Validate a repository path and return the info needed by the wizard.
   * Read-only: it never initialises or clones anything.
   * @param {unknown} rawPath absolute path supplied by the user.
   * @returns {Promise<object>} repository facts.
   */
  async function validateRepo(rawPath) {
    const candidate = typeof rawPath === 'string' ? rawPath.trim() : '';
    if (!candidate) throw new LabError('bad_path', 'repoPath is required', 400);
    if (!path.isAbsolute(candidate)) throw new LabError('bad_path', 'repoPath must be an absolute path', 400);
    await requireGit();

    const top = await runGit(['-C', candidate, 'rev-parse', '--show-toplevel'], { cwd: candidate });
    if (top.code !== 0) {
      throw new LabError('not_git', top.stderr.trim() || 'not a git repository', 422);
    }
    return describeRepo(top.stdout.trim(), { prepared: 'existing' });
  }

  /** @returns {boolean} whether HEAD resolves to a commit. */
  async function hasCommit(repoRoot) {
    const head = await runGit(['-C', repoRoot, 'rev-parse', '--quiet', '--verify', 'HEAD'], { cwd: repoRoot });
    return head.code === 0;
  }

  /**
   * Give a freshly created (or freshly cloned, empty) repository an initial
   * commit so the wizard has a base commit to branch from. User identity is
   * never written to a global config: unset values become per-command flags.
   * @param {string} repoRoot
   * @returns {Promise<boolean>} whether a commit was created.
   */
  async function ensureInitialCommit(repoRoot) {
    if (await hasCommit(repoRoot)) return false;

    const status = await runGit(['-C', repoRoot, 'status', '--porcelain'], { cwd: repoRoot });
    if (status.code !== 0) throw new LabError('repo_init_failed', status.stderr.trim() || 'git status failed', 422);
    const staged = await runGit(['-C', repoRoot, 'ls-files', '--cached', '-z'], { cwd: repoRoot });
    if (staged.code !== 0) throw new LabError('repo_init_failed', staged.stderr.trim() || 'git ls-files failed', 422);
    if (staged.stdout === '' && status.stdout.trim() !== '') {
      const add = await runGit(['-C', repoRoot, 'add', '-A'], { cwd: repoRoot, timeoutMs: 120_000 });
      if (add.code !== 0) throw new LabError('repo_init_failed', add.stderr.trim() || 'git add failed', 422);
    }

    const identity = [];
    const userName = await runGit(['-C', repoRoot, 'config', '--get', 'user.name'], { cwd: repoRoot });
    if (userName.code !== 0) identity.push('-c', `user.name=${GIT_IDENTITY.name}`);
    const userEmail = await runGit(['-C', repoRoot, 'config', '--get', 'user.email'], { cwd: repoRoot });
    if (userEmail.code !== 0) identity.push('-c', `user.email=${GIT_IDENTITY.email}`);

    const commit = await runGit(
      [
        '-C', repoRoot, ...identity, '-c', 'commit.gpgsign=false',
        'commit', '--no-verify', '--allow-empty', '-m', 'Initialize MetaInfer project',
      ],
      { cwd: repoRoot, timeoutMs: 120_000 },
    );
    if (commit.code !== 0) throw new LabError('repo_init_failed', commit.stderr.trim() || 'git commit failed', 422);
    return true;
  }

  /**
   * Initialise a local directory in place (and commit its current files).
   * @param {string} candidate absolute directory path.
   * @returns {Promise<object>}
   */
  async function prepareLocal(candidate) {
    let info = null;
    try { info = await stat(candidate); } catch { info = null; }
    if (info === null) throw new LabError('repo_not_found', `directory not found: ${candidate}`, 404);
    if (!info.isDirectory()) throw new LabError('bad_path', 'repoPath must be a directory', 400);

    const bare = await runGit(['-C', candidate, 'rev-parse', '--is-bare-repository'], { cwd: candidate });
    if (bare.code === 0 && bare.stdout.trim() === 'true') {
      throw new LabError('bare', 'bare repositories are not supported', 422);
    }

    const top = await runGit(['-C', candidate, 'rev-parse', '--show-toplevel'], { cwd: candidate });
    let prepared = 'existing';
    if (top.code !== 0) {
      const init = await runGit(['init', candidate], { cwd: candidate, timeoutMs: 60_000 });
      if (init.code !== 0) throw new LabError('repo_init_failed', init.stderr.trim() || 'git init failed', 422);
      prepared = 'local-init';
    }
    const repoRoot = await gitText(['-C', candidate, 'rev-parse', '--show-toplevel'], { cwd: candidate });
    const selectedRoot = await realpath(candidate);
    const canonicalRoot = await realpath(repoRoot);
    if (normalizePathForCompare(selectedRoot) !== normalizePathForCompare(canonicalRoot)) {
      throw new LabError('repo_parent_unsafe', 'select the repository root rather than a directory inside it', 422);
    }
    const initialized = await ensureInitialCommit(repoRoot);
    return describeRepo(repoRoot, { prepared, initialized, remote: null });
  }

  /**
   * Clone a remote URL into the managed cache (or reuse an existing clone).
   * @param {string} url http(s), ssh, git or file URL.
   * @returns {Promise<object>}
   */
  async function prepareRemote(url) {
    const remote = parseRemoteUrl(url);
    const target = path.join(reposRoot, cacheDirName(url, remote));
    await mkdir(reposRoot, { recursive: true });

    async function reuseCache() {
      const top = await runGit(['-C', target, 'rev-parse', '--show-toplevel'], { cwd: target });
      if (top.code !== 0 || normalizePathForCompare(await realpath(top.stdout.trim()))
        !== normalizePathForCompare(await realpath(target))) {
        throw new LabError('remote_cache_invalid', `cached clone is not a git repository: ${target}`, 409);
      }
      const initialized = await ensureInitialCommit(target);
      return describeRepo(target, { prepared: 'remote-cache', remote: url, initialized });
    }

    let present = false;
    try { present = (await stat(target)).isDirectory(); } catch { present = false; }
    if (present) return reuseCache();

    const staging = await mkdtemp(path.join(reposRoot, '.clone-'));
    try {
      const clone = await runGit(['clone', '--', url, staging], { cwd: reposRoot, timeoutMs: 300_000 });
      if (clone.code !== 0) {
        throw new LabError(
          'remote_clone_failed',
          redactUrl(clone.stderr.trim() || `git clone ${url} failed`),
          422,
        );
      }
      const initialized = await ensureInitialCommit(staging);
      try {
        await rename(staging, target);
      } catch (error) {
        // Another successful request may already have published this URL.
        let published = false;
        try { published = (await stat(target)).isDirectory(); } catch { published = false; }
        if (!published) throw error;
        return reuseCache();
      }
      return describeRepo(target, { prepared: 'remote-clone', remote: url, initialized });
    } finally {
      // Only this request's private clone is ours to remove, never the cache.
      await rm(staging, { recursive: true, force: true });
    }
  }

  /**
   * Accept a repository exactly as a user picked it: an existing local
   * directory (initialised when needed) or a remote URL (cloned and cached).
   * @param {unknown} input string path/URL or `{repoPath|path|url}`.
   * @returns {Promise<object>} repository facts plus `prepared`/`initialized`.
   */
  async function prepareRepo(input) {
    let candidate = '';
    if (typeof input === 'string') candidate = input.trim();
    else if (input !== null && typeof input === 'object') {
      for (const key of ['repoPath', 'path', 'url']) {
        const value = input[key];
        if (typeof value === 'string' && value.trim() !== '') { candidate = value.trim(); break; }
      }
    }
    if (!candidate) throw new LabError('bad_path', 'repoPath is required', 400);
    await requireGit();

    if (isRemoteUrl(candidate)) return prepareRemote(candidate);
    if (!path.isAbsolute(candidate)) {
      // `github.com/owner/repo` is a common half-typed URL, not a local path.
      if (/^[^\s/\\]+(\.[^\s/\\]+)+[/\\]/.test(candidate)) {
        throw new LabError('remote_invalid', 'use https://, ssh:// or git@host:owner/repo for a remote repository', 400);
      }
      throw new LabError('bad_path', 'repoPath must be an absolute path', 400);
    }
    return prepareLocal(candidate);
  }

  /**
   * Install Git through the platform package manager. Requires explicit
   * consent in the request body; the Host never installs software silently.
   * @param {{confirmed?: boolean}} input
   * @returns {Promise<{installed: boolean, alreadyPresent: boolean, version: string}>}
   */
  async function installGit(input) {
    const confirmed = input !== null && typeof input === 'object' ? input.confirmed === true : false;
    if (!confirmed) {
      throw new LabError('git_install_unconfirmed', 'Git installation requires explicit confirmation', 400);
    }
    const current = await detectGit();
    if (current !== null) return { installed: true, alreadyPresent: true, version: current };

    const spec = gitInstallSpec(platform);
    if (spec === null) {
      throw new LabError(
        'git_install_unsupported',
        `automatic Git installation is not supported on ${platform}; install Git from ${GIT_DOWNLOAD_URL}`,
        501,
      );
    }
    const result = await runProcess(spec.argv, { cwd: tmpdir(), timeoutMs: GIT_INSTALL_TIMEOUT_MS });
    if (result.code !== 0) {
      const detail = lastLine(result.stderr || result.stdout);
      if (result.code === null || /not found|ENOENT|not recognized|command not found/i.test(detail)) {
        throw new LabError(
          'git_install_unsupported',
          `${spec.manager} is not available${detail ? `: ${detail}` : ''}; install Git from ${GIT_DOWNLOAD_URL}`,
          501,
        );
      }
      throw new LabError(
        'git_install_failed',
        `${spec.manager} exited with code ${result.code}${detail ? `: ${detail}` : ''}`,
        502,
      );
    }
    const version = await detectGit();
    if (version === null) {
      throw new LabError('git_install_failed', 'Git was installed but is not reachable from the Host process; restart DSH and retry', 502);
    }
    return { installed: true, alreadyPresent: false, version };
  }

  /**
   * Resolve one branch name to its commit inside a validated repository.
   * @param {string} repoRoot absolute repository root.
   * @param {string} branch branch name.
   * @returns {Promise<string>} commit hash.
   */
  async function resolveBranch(repoRoot, branch) {
    if (typeof branch !== 'string' || !branch.trim()) {
      throw new LabError('bad_branch', 'baseBranch is required', 400);
    }
    const commit = await runGit(['-C', repoRoot, 'rev-parse', '--verify', `${branch.trim()}^{commit}`], { cwd: repoRoot });
    if (commit.code !== 0) throw new LabError('bad_branch', `unknown branch: ${branch}`, 422);
    return commit.stdout.trim();
  }

  /**
   * Create (or reuse) the per-node worktree and branch.
   * @param {object} project project record.
   * @param {object} node node record (planned or running).
   * @returns {Promise<{worktreePath: string, reused: boolean}>}
   */
  async function ensureWorktree(project, node) {
    const worktreePath = node.git.worktreePath;
    await mkdir(path.dirname(worktreePath), { recursive: true });

    const probe = await runGit(['-C', worktreePath, 'rev-parse', '--is-inside-work-tree'], { cwd: worktreePath });
    if (probe.code === 0 && probe.stdout.trim() === 'true') {
      const branch = (await runGit(['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreePath })).stdout.trim();
      if (branch !== node.git.branch) {
        throw new LabError(
          'worktree_conflict',
          `existing worktree is on "${branch}", expected "${node.git.branch}"`,
          409,
        );
      }
      return { worktreePath, reused: true };
    }

    // The worktree may have been deleted to reclaim disk while its git
    // registration survived. Prune stale registrations before adding it back.
    let present = false;
    try { present = (await stat(worktreePath)).isDirectory(); } catch { present = false; }
    if (!present) {
      await runGit(['-C', project.repo.path, 'worktree', 'prune'], {
        cwd: project.repo.path,
        timeoutMs: 60_000,
      });
    }
    const add = await runGit(
      ['-C', project.repo.path, 'worktree', 'add', '-b', node.git.branch, worktreePath, node.git.baseCommit],
      { cwd: project.repo.path, timeoutMs: 60_000 },
    );
    if (add.code !== 0) {
      // A previous attempt may have created the branch without the worktree.
      const attach = await runGit(
        ['-C', project.repo.path, 'worktree', 'add', worktreePath, node.git.branch],
        { cwd: project.repo.path, timeoutMs: 60_000 },
      );
      if (attach.code !== 0) {
        throw new LabError('worktree_failed', (add.stderr || attach.stderr).trim() || 'git worktree add failed', 422);
      }
    }
    return { worktreePath, reused: false };
  }

  /**
   * Stage everything and commit when the worktree is dirty.
   * @param {object} project project record (commit identity config).
   * @param {object} node node record.
   * @param {string} message commit message.
   * @returns {Promise<{committed: boolean, head: string}>}
   */
  async function commitWorktree(project, node, message) {
    const cwd = node.git.worktreePath;
    const add = await runGit(['-C', cwd, 'add', '-A'], { cwd, timeoutMs: 30_000 });
    if (add.code !== 0) throw new LabError('git_failed', add.stderr.trim() || 'git add failed', 422);

    const status = await runGit(['-C', cwd, 'status', '--porcelain'], { cwd });
    const head = await runGit(['-C', cwd, 'rev-parse', 'HEAD'], { cwd });
    if (status.code !== 0 || head.code !== 0) {
      throw new LabError('git_failed', (status.stderr || head.stderr).trim() || 'git status/head failed', 422);
    }
    if (status.stdout.trim() === '') return { committed: false, head: head.stdout.trim() };

    const identity = project.config?.git ?? {};
    const authorName = identity.authorName || 'MetaInfer Research Lab';
    const authorEmail = identity.authorEmail || 'metainfer@localhost';
    const commit = await runGit(
      ['-C', cwd, '-c', `user.name=${authorName}`, '-c', `user.email=${authorEmail}`, 'commit', '-m', message],
      { cwd, timeoutMs: 60_000 },
    );
    if (commit.code !== 0) throw new LabError('commit_failed', commit.stderr.trim() || 'git commit failed', 422);
    const nextHead = await runGit(['-C', cwd, 'rev-parse', 'HEAD'], { cwd });
    return { committed: true, head: nextHead.stdout.trim() };
  }

  /** @returns {Promise<string>} current worktree HEAD. */
  async function headOf(worktreePath) {
    return gitText(['-C', worktreePath, 'rev-parse', 'HEAD'], { cwd: worktreePath });
  }

  /** @returns {Promise<string>} current worktree branch name. */
  async function branchOf(worktreePath) {
    return gitText(['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreePath });
  }

  /**
   * Start a --no-commit merge inside a worktree. Does not throw on conflicts: the
   * caller decides whether the agent should resolve them interactively.
   * @returns {Promise<{code:number, stdout:string, stderr:string, conflicts:string[]}>}
   */
  async function mergeBranchIntoWorktree(worktreePath, branch) {
    const ref = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
    const result = await runGit(
      ['-C', worktreePath, 'merge', '--no-ff', '--no-commit', ref],
      { cwd: worktreePath, timeoutMs: 120_000 },
    );
    const unmerged = await runGit(
      ['-C', worktreePath, 'diff', '--name-only', '--diff-filter=U'],
      { cwd: worktreePath, timeoutMs: 30_000 },
    );
    return {
      code: result.code,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      conflicts: unmerged.stdout.split('\n').map((line) => line.trim()).filter(Boolean),
    };
  }

  /**
   * Commit a prepared merge after the human/merge-agent resolved conflicts.
   * @returns {Promise<{head:string, conflicts:string[], committed:boolean}>}
   */
  async function finishMergeInWorktree(worktreePath, message) {
    const unmerged = await runGit(
      ['-C', worktreePath, 'diff', '--name-only', '--diff-filter=U'],
      { cwd: worktreePath, timeoutMs: 30_000 },
    );
    const conflicts = unmerged.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    if (conflicts.length > 0) {
      // The merge agent is forbidden from running git write commands. It resolves
      // conflict markers by editing files, so the Host stages them here after
      // verifying that no markers remain.
      const unresolved = [];
      for (const relative of conflicts) {
        try {
          const text = await readFile(path.join(worktreePath, relative), 'utf8');
          if (/^<<<<<<< |^=======$|^>>>>>>> /m.test(text)) unresolved.push(relative);
        } catch {
          unresolved.push(relative);
        }
      }
      if (unresolved.length > 0) {
        throw new LabError('merge_conflicts', `unresolved conflict paths: ${unresolved.join(', ')}`, 409);
      }
      const add = await runGit(['-C', worktreePath, 'add', '--', ...conflicts], {
        cwd: worktreePath,
        timeoutMs: 120_000,
      });
      if (add.code !== 0) throw new LabError('git_failed', add.stderr.trim() || 'git add failed', 422);
    }
    const mergeHead = await runGit(['-C', worktreePath, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'], {
      cwd: worktreePath,
      timeoutMs: 30_000,
    });
    const status = await runGit(['-C', worktreePath, 'status', '--porcelain'], { cwd: worktreePath, timeoutMs: 30_000 });
    const dirty = status.stdout.trim().length > 0;
    if (mergeHead.code !== 0 && !dirty) {
      const head = await runGit(['-C', worktreePath, 'rev-parse', 'HEAD'], { cwd: worktreePath, timeoutMs: 30_000 });
      return { head: head.stdout.trim(), conflicts: [], committed: false };
    }
    const add = await runGit(['-C', worktreePath, 'add', '-A'], { cwd: worktreePath, timeoutMs: 120_000 });
    if (add.code !== 0) throw new LabError('git_failed', add.stderr.trim() || 'git add failed', 422);
    const commit = await runGit(
      ['-C', worktreePath, 'commit', '--no-verify', '-m', String(message || 'dshex: merge')],
      { cwd: worktreePath, timeoutMs: 120_000 },
    );
    if (commit.code !== 0) throw new LabError('git_failed', commit.stderr.trim() || 'git commit failed', 422);
    const head = await runGit(['-C', worktreePath, 'rev-parse', 'HEAD'], { cwd: worktreePath, timeoutMs: 30_000 });
    return { head: head.stdout.trim(), conflicts: [], committed: true };
  }

  /** List refnames under a prefix (e.g. refs/tags/dshex-sealed/<projectId>/). */
  async function listRefs(repoRoot, prefix) {
    const result = await runGit(
      ['-C', repoRoot, 'for-each-ref', '--format=%(refname)', prefix],
      { cwd: repoRoot, timeoutMs: 60_000 },
    );
    if (result.code !== 0) return [];
    return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  }

  /**
   * Push the project's experiment branches and seal tags to a remote.
   * @returns {Promise<{remote:string, refs:string[], stdout:string}>}
   */
  async function pushProject(repoRoot, remote, refs) {
    const target = remote || 'origin';
    const list = Array.isArray(refs) && refs.length > 0 ? refs : [];
    const result = await runGit(
      ['-C', repoRoot, 'push', target, ...list],
      { cwd: repoRoot, timeoutMs: 300_000 },
    );
    if (result.code !== 0) throw new LabError('git_push_failed', result.stderr.trim() || 'git push failed', 422);
    return { remote: target, refs: list, stdout: result.stdout.trim() };
  }

  /**
   * Remove one managed worktree directory. Branches and tags are kept by default
   * so the experiment history remains inspectable.
   * @param {string} repoRoot repository root.
   * @param {string} worktreePath worktree directory.
   * @returns {Promise<boolean>} whether a worktree was removed (false when absent).
   */
  async function removeWorktree(repoRoot, worktreePath) {
    const probe = await runGit(['-C', repoRoot, 'worktree', 'list', '--porcelain'], { cwd: repoRoot });
    if (probe.code !== 0) return false;
    const target = normalizePathForCompare(worktreePath);
    const listed = probe.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('worktree '))
      .some((line) => normalizePathForCompare(line.slice('worktree '.length)) === target);
    if (!listed) return false;
    const remove = await runGit(['-C', repoRoot, 'worktree', 'remove', '--force', worktreePath], {
      cwd: repoRoot,
      timeoutMs: 60_000,
    });
    if (remove.code !== 0) throw new LabError('git_failed', remove.stderr.trim() || 'git worktree remove failed', 422);
    return true;
  }

  /** Create (or move) an annotated ref used as the node seal tag. */
  async function tagCommit(repoRoot, tagName, commit) {
    const result = await runGit(['-C', repoRoot, 'tag', '-f', tagName, commit], { cwd: repoRoot, timeoutMs: 30_000 });
    if (result.code !== 0) throw new LabError('git_failed', result.stderr.trim() || 'git tag failed', 422);
  }

  return {
    runGit,
    validateRepo,
    prepareRepo,
    gitInfo,
    installGit,
    resolveBranch,
    ensureWorktree,
    removeWorktree,
    mergeBranchIntoWorktree,
    finishMergeInWorktree,
    listRefs,
    pushProject,
    commitWorktree,
    headOf,
    branchOf,
    tagCommit,
  };
}
