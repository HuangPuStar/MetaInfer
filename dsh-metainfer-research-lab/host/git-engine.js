/**
 * GitEngine (M1): every Git command goes through `ctx.subprocess.spawn`.
 * The Host plugin runs unsandboxed by design (documented trust boundary); the
 * worker agents never run git write commands.
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGitSetup } from './git-setup.js';

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

function checkWorkingPath(directory) {
  if (process.platform === 'win32' && directory.length >= 260) {
    throw new LabError('path_too_long', 'Git for Windows cannot use this working directory (260+ characters); choose a shorter path or DSH_HOME.', 422);
  }
}

const REMOTE_PROTOCOLS = new Set(['http:', 'https:', 'ssh:', 'git:', 'file:']);
// Shared across engine instances; entries exist only while preparation is active.
const preparations = new Map();

/** Convert clone URLs and GitHub tree/blob URLs without accepting shell transports. */
export function normalizeRemoteRepoUrl(value) {
  const candidate = typeof value === 'string' ? value.trim() : '';
  if (!candidate || /[\0\r\n]/.test(candidate) || path.isAbsolute(candidate)) return null;
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s]+$/.test(candidate)) {
    return { cloneUrl: candidate, branchHint: '' };
  }
  let parsed;
  try { parsed = new URL(candidate); } catch { return null; }
  if (!REMOTE_PROTOCOLS.has(parsed.protocol)) return null;
  if (['http:', 'https:'].includes(parsed.protocol) && /^(?:www\.)?github\.com$/i.test(parsed.hostname)) {
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 2 || !segments.slice(0, 2).every((part) => /^[A-Za-z0-9_.-]+$/.test(part) && !['.', '..'].includes(part))) return null;
    let branchHint = '';
    if (['tree', 'blob'].includes(segments[2])) {
      if (segments.length < 4) throw new LabError('bad_branch', 'GitHub URL must name a branch', 400);
      try { branchHint = decodeURIComponent(segments.slice(3).join('/')); } catch { throw new LabError('bad_branch', 'invalid branch URL encoding', 400); }
      if (/[\0\r\n]/.test(branchHint)) throw new LabError('bad_branch', 'invalid branch URL', 400);
    } else if (segments.length > 2) return null;
    parsed.pathname = `/${segments[0]}/${segments[1].replace(/\.git$/i, '')}.git`;
    parsed.search = '';
    parsed.hash = '';
    return { cloneUrl: parsed.href, branchHint };
  }
  return { cloneUrl: parsed.href, branchHint: '' };
}

/** GitHub branch names can contain slashes; match a branch before the browse path. */
export function matchBranchHint(branches, hint) {
  return branches.filter((branch) => hint === branch || hint.startsWith(`${branch}/`))
    .sort((left, right) => right.length - left.length)[0] ?? '';
}

function filesystemError(error) {
  return new LabError(['EACCES', 'EPERM', 'EROFS'].includes(error?.code) ? 'git_permission' : 'bad_path', error.message || String(error), 422);
}

async function pathStat(candidate, noFollow = false) {
  try { return await (noFollow ? lstat(candidate) : stat(candidate)); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw filesystemError(error);
  }
}

/** Resolve existing ancestors too, so aliases of a not-yet-created path share a lock. */
async function canonicalPath(candidate) {
  const suffix = [];
  let current = path.resolve(candidate);
  while (true) {
    try { return path.join(await realpath(current), ...suffix); } catch (error) {
      if (error.code !== 'ENOENT') throw filesystemError(error);
      const parent = path.dirname(current);
      if (parent === current) throw filesystemError(error);
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

const GIT_LIMITS = {
  stdoutBytes: 2 * 1024 * 1024,
  stderrBytes: 256 * 1024,
  graceMs: 2000,
};

/**
 * Create the GitEngine bound to one Host context.
 * @param ctx Cordis context with `subprocess` injected.
 */
export function createGitEngine(ctx) {
  const gitSetup = createGitSetup(ctx);

  function executionError(error, timedOut = false) {
    if (error instanceof LabError) return error;
    const message = error?.message || String(error);
    let code = error?.code;
    if (timedOut) code = 'git_timeout';
    else if (['ENOENT', 'ENOTDIR'].includes(code) || ['ENOENT', 'ENOTDIR'].includes(error?.cause?.code)) code = 'git_missing';
    else if (['EACCES', 'EPERM', 'EROFS'].includes(code)) code = 'git_permission';
    else if (!['git_missing', 'git_timeout', 'git_permission', 'git_unsafe', 'bad_path'].includes(code)) code = 'git_failed';
    return new LabError(code, message, code === 'git_timeout' ? 504 : 422);
  }

  /** All Git processes use argv, bounded output/deadline and no interactive stdin. */
  async function runGit(args, options) {
    const cwd = options?.cwd ?? process.cwd();
    checkWorkingPath(cwd);
    let executable;
    try { executable = await gitSetup.resolveGit(); } catch (error) { throw executionError(error, error?.status === 504); }
    const timeoutMs = options?.timeoutMs ?? 20_000;
    const controller = new AbortController();
    let timer;
    try {
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new LabError('git_timeout', `git timeout after ${timeoutMs}ms`, 504));
        }, timeoutMs);
      });
      const handle = ctx.subprocess.spawn({
        argv: [executable, ...(process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : []), ...args],
        cwd,
        env: {
          GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...options?.env,
          // SDK undefined tombstones remove ambient repository selectors.
          GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined,
          GIT_INDEX_FILE: undefined, GIT_OBJECT_DIRECTORY: undefined,
          GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined, GIT_NAMESPACE: undefined,
        },
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: GIT_LIMITS.stdoutBytes },
          stderr: { maxBytes: GIT_LIMITS.stderrBytes },
        },
        graceMs: GIT_LIMITS.graceMs,
        signal: controller.signal,
      });
      const outcome = await Promise.race([handle.done, deadline]);
      if (controller.signal.aborted) throw new LabError('git_timeout', `git timeout after ${timeoutMs}ms`, 504);
      const stdout = handle.collected?.stdout?.readFrom(0).text ?? '';
      const stderr = handle.collected?.stderr?.readFrom(0).text ?? '';
      if (outcome.exitCode !== 0) {
        if (/dubious ownership|unsafe repository|safe\.directory/i.test(stderr)) throw new LabError('git_unsafe', stderr.trim(), 422);
        if (/permission denied|access is denied|operation not permitted|read-only file system/i.test(stderr)) throw new LabError('git_permission', stderr.trim(), 422);
      }
      return { code: outcome.exitCode, stdout, stderr, timedOut: false };
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error?.code) && !(await pathStat(cwd))) {
        throw new LabError('bad_path', `Git working directory does not exist: ${cwd}`, 422);
      }
      throw executionError(error, controller.signal.aborted);
    } finally {
      clearTimeout(timer);
    }
  }

  async function gitText(args, options) {
    const result = await runGit(args, options);
    if (result.code !== 0) {
      throw new LabError('git_failed', result.stderr.trim() || `git ${args[0]} failed`, 422);
    }
    return result.stdout.trim();
  }

  /** Create only an empty tree: never read, stage or rewrite the user's index. */
  async function initialCommit(repoRoot, branchRef) {
    const configArgs = [];
    for (const [key, fallback] of [['user.name', 'MetaInfer Research Lab'], ['user.email', 'metainfer@localhost']]) {
      const current = await runGit(['-C', repoRoot, 'config', '--get', key], { cwd: repoRoot });
      if (current.code === 1 || (current.code === 0 && !current.stdout.trim())) configArgs.push('-c', `${key}=${fallback}`);
      else if (current.code !== 0) throw new LabError('initial_commit_failed', current.stderr.trim() || 'cannot read Git identity', 422);
    }
    const tree = await runGit(['-C', repoRoot, 'hash-object', '-t', 'tree', '-w', '--stdin'], { cwd: repoRoot });
    if (tree.code !== 0) throw new LabError('initial_commit_failed', tree.stderr.trim() || 'cannot create empty tree', 422);
    // This synthetic bootstrap object is unsigned; no signing/identity config is persisted.
    const commit = await runGit(['-C', repoRoot, ...configArgs, 'commit-tree', tree.stdout.trim(), '--no-gpg-sign', '-m', 'MetaInfer: initialize repository'], { cwd: repoRoot });
    if (commit.code !== 0) throw new LabError('initial_commit_failed', commit.stderr.trim() || 'cannot create initial commit', 422);
    const hash = commit.stdout.trim();
    const update = await runGit(['-C', repoRoot, 'update-ref', branchRef, hash, '0'.repeat(hash.length)], { cwd: repoRoot });
    if (update.code !== 0) throw new LabError('initial_commit_failed', update.stderr.trim() || 'initial branch changed during preparation', 409);
    return hash;
  }

  async function inspectLocal(repoRoot, { prepare = false, remote = null, fresh = false } = {}) {
    let entry = await pathStat(repoRoot);
    if (!entry) {
      if (!prepare) throw new LabError('not_git', 'repository directory does not exist; preparation is required', 422);
      try { await mkdir(repoRoot, { recursive: true }); } catch (error) { throw filesystemError(error); }
      entry = await pathStat(repoRoot);
    }
    if (!entry.isDirectory()) throw new LabError('bad_path', 'repoPath is not a directory', 400);

    const bare = await runGit(['-C', repoRoot, 'rev-parse', '--is-bare-repository'], { cwd: repoRoot });
    if (bare.code === 0 && bare.stdout.trim() === 'true') throw new LabError('bare', 'bare repositories are not supported', 422);
    let ownRepository = false;
    if (bare.code === 0) {
      const inside = await gitText(['-C', repoRoot, 'rev-parse', '--is-inside-git-dir'], { cwd: repoRoot });
      if (inside === 'true') throw new LabError('bad_path', 'repoPath must not be inside Git metadata', 422);
      const top = await gitText(['-C', repoRoot, 'rev-parse', '--show-toplevel'], { cwd: repoRoot });
      ownRepository = normalizePathForCompare(await canonicalPath(top)) === normalizePathForCompare(repoRoot);
    } else if (!/not a git repository/i.test(bare.stderr)) {
      throw new LabError('git_failed', bare.stderr.trim() || 'cannot inspect repository', 422);
    }
    if (!ownRepository) {
      // Do not reinitialize a corrupt/foreign .git marker, or accidentally use a parent repo.
      if (await pathStat(path.join(repoRoot, '.git'), true)) throw new LabError('not_git', 'existing Git metadata is not a valid repository', 422);
      if (!prepare) throw new LabError('not_git', 'directory is not a repository root; preparation is required', 422);
      await gitText(['init', '--', repoRoot], { cwd: repoRoot });
    }
    const gitDir = await gitText(['-C', repoRoot, 'rev-parse', '--absolute-git-dir'], { cwd: repoRoot });
    const refText = await gitText(['-C', repoRoot, 'for-each-ref', '--format=%(refname)%09%(objecttype)%09%(objectname)%09%(*objecttype)%09%(*objectname)'], { cwd: repoRoot });
    const refs = refText.split('\n').filter(Boolean).map((line) => line.trim().split('\t'));
    const commits = new Map(refs.flatMap(([ref, type, hash, peeledType, peeledHash]) => type === 'commit' ? [[ref, hash]] : peeledType === 'commit' ? [[ref, peeledHash]] : []));
    const heads = [...commits.keys()].filter((ref) => ref.startsWith('refs/heads/'));
    const origins = [...commits.keys()].filter((ref) => ref.startsWith('refs/remotes/origin/') && ref !== 'refs/remotes/origin/HEAD');
    const branches = heads.map((ref) => ref.slice('refs/heads/'.length));
    const symbolic = await runGit(['-C', repoRoot, 'symbolic-ref', '-q', 'HEAD'], { cwd: repoRoot });
    const headRef = symbolic.code === 0 ? symbolic.stdout.trim() : '';
    const head = await runGit(['-C', repoRoot, 'rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'], { cwd: repoRoot });
    const warnings = [];
    let selected;
    if (remote?.branchHint) {
      const names = [...branches, ...origins.map((ref) => ref.slice('refs/remotes/origin/'.length))];
      const hinted = matchBranchHint(names, remote.branchHint);
      if (!hinted) throw new LabError('bad_branch', `unknown branch in GitHub URL: ${remote.branchHint}`, 422);
      selected = commits.has(`refs/heads/${hinted}`) ? `refs/heads/${hinted}` : `refs/remotes/origin/${hinted}`;
    } else if (head.code === 0) {
      selected = commits.has(headRef) ? headRef : 'HEAD';
      commits.set('HEAD', head.stdout.trim());
    } else {
      selected = heads[0] || origins[0] || commits.keys().next().value;
      if (selected) warnings.push('Repository HEAD is invalid; using an existing committed ref without creating new history.');
    }
    let initialized = false;
    if (!selected) {
      if (!prepare || refs.length > 0) throw new LabError('no_commits', 'repository has no valid commit to start from', 422);
      if (!headRef.startsWith('refs/heads/')) throw new LabError('initial_commit_failed', 'unborn HEAD does not name a local branch', 422);
      const hash = await initialCommit(repoRoot, headRef);
      commits.set(headRef, hash);
      selected = headRef;
      branches.push(headRef.slice('refs/heads/'.length));
      initialized = true;
    }
    if (prepare && remote && selected.startsWith('refs/remotes/origin/')) {
      const name = selected.slice('refs/remotes/origin/'.length);
      await gitText(['-C', repoRoot, 'branch', '--track', '--', name, selected], { cwd: repoRoot });
      commits.set(`refs/heads/${name}`, commits.get(selected));
      selected = `refs/heads/${name}`;
      branches.push(name);
    }
    const defaultBranch = selected.startsWith('refs/heads/') ? selected.slice('refs/heads/'.length) : selected;
    // Checkout only our fresh temporary clone, never a user's existing checkout/index.
    if (fresh && selected.startsWith('refs/heads/') && headRef !== selected && !initialized) {
      await gitText(['-C', repoRoot, 'checkout', defaultBranch, '--'], { cwd: repoRoot });
    }
    if (!branches.includes(defaultBranch)) branches.push(defaultBranch);
    const status = await gitText(['-C', repoRoot, 'status', '--porcelain', '--untracked-files=normal'], { cwd: repoRoot });
    const dirty = Boolean(status);
    if (initialized || dirty) warnings.push(initialized
      ? 'Initial commit contains no files. Existing files and staged changes were preserved and are not included in experiment worktrees.'
      : 'Uncommitted files and staged changes are preserved; experiment worktrees start from the selected commit, not these changes.');
    return { repoRoot, gitDir, branches, defaultBranch, baseCommit: commits.get(selected), dirty, warnings, ...(remote ? { remoteUrl: remote.cloneUrl } : {}) };
  }

  /**
   * Validate without writes by default. Explicit prepare initializes local roots
   * or clones into DSH_HOME/metainfer-research-lab/repos (retained until removed).
   * Cached clones are reused offline, without fetch/reset. Only owned temporary
   * clone directories are removed on failure; existing directories are never deleted.
   */
  async function validateRepo(rawPath, { prepare = false } = {}) {
    const candidate = typeof rawPath === 'string' ? rawPath.trim() : '';
    if (!candidate || /[\0\r\n]/.test(candidate)) throw new LabError('bad_path', 'repoPath must be an absolute directory or Git URL', 400);
    const remote = normalizeRemoteRepoUrl(candidate);
    if (!remote && !path.isAbsolute(candidate)) throw new LabError('bad_path', 'repoPath must be an absolute directory or Git URL', 400);
    const cacheRoot = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'metainfer-research-lab', 'repos');
    const target = remote
      ? path.join(await canonicalPath(cacheRoot), createHash('sha256').update(remote.cloneUrl).digest('hex'))
      : await canonicalPath(candidate);
    checkWorkingPath(target);
    const key = normalizePathForCompare(target);
    // Serialize mutations across engine instances and URL/local aliases. Read-only
    // callers wait for active preparation, then inspect their own requested branch.
    if (preparations.has(key)) {
      await preparations.get(key);
      return validateRepo(rawPath, { prepare });
    }
    const operation = async () => {
      if (!remote) return inspectLocal(target, { prepare });
      const existing = await pathStat(target, true);
      if (existing) {
        const metadata = existing.isDirectory() && !existing.isSymbolicLink()
          ? await pathStat(path.join(target, '.git'), true) : null;
        // Our clones never use gitfiles, linked metadata or a shared common dir.
        if (!metadata?.isDirectory() || metadata.isSymbolicLink() || await pathStat(path.join(target, '.git', 'commondir'), true)) {
          throw new LabError('clone_failed', 'managed clone path is occupied or uses external Git metadata; it was not modified', 422);
        }
        const origin = await gitText(['-C', target, 'config', '--get', 'remote.origin.url'], { cwd: target });
        if (origin !== remote.cloneUrl) throw new LabError('clone_failed', 'managed clone origin does not match the requested URL', 422);
        return inspectLocal(target, { prepare, remote });
      }
      if (!prepare) throw new LabError('repo_setup_required', 'remote repository has no local cache; explicit preparation is required', 422);
      let temporary;
      try {
        await mkdir(path.dirname(target), { recursive: true });
        temporary = await mkdtemp(path.join(path.dirname(target), '.clone-'));
        const checkout = path.join(temporary, 'repository');
        const clone = await runGit(['clone', '--no-hardlinks', '--', remote.cloneUrl, checkout], { cwd: temporary, timeoutMs: 300_000 });
        if (clone.code !== 0) throw new LabError('clone_failed', clone.stderr.trim() || 'git clone failed', 422);
        const prepared = await inspectLocal(checkout, { prepare: true, remote, fresh: true });
        // A directory created by another actor must never be replaced/deleted.
        if (await pathStat(target, true)) throw new LabError('clone_failed', 'managed clone path became occupied during preparation', 409);
        await rename(checkout, target);
        return { ...prepared, repoRoot: target, gitDir: path.join(target, path.relative(checkout, prepared.gitDir)) };
      } catch (error) {
        if (error?.code?.startsWith('git_') || error instanceof LabError) throw error;
        throw filesystemError(error);
      } finally {
        if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => {});
      }
    };
    if (!prepare) return operation();
    const pending = operation();
    preparations.set(key, pending);
    try { return await pending; } finally { if (preparations.get(key) === pending) preparations.delete(key); }
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
    const commit = await runGit(['-C', repoRoot, 'rev-parse', '--verify', '--end-of-options', `${branch.trim()}^{commit}`], { cwd: repoRoot });
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

    const present = (await pathStat(worktreePath))?.isDirectory() ?? false;
    const probe = present ? await runGit(['-C', worktreePath, 'rev-parse', '--show-toplevel'], { cwd: worktreePath }) : null;
    if (probe?.code === 0 && normalizePathForCompare(probe.stdout) === normalizePathForCompare(await canonicalPath(worktreePath))) {
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
    gitStatus: gitSetup.status,
    installGit: gitSetup.install,
    runGit,
    validateRepo,
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
