/**
 * GitEngine (M1): every Git command goes through `ctx.subprocess.spawn`.
 * The Host plugin runs unsandboxed by design (documented trust boundary); the
 * worker agents never run git write commands.
 */
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

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

/**
 * Create the GitEngine bound to one Host context.
 * @param ctx Cordis context with `subprocess` injected.
 */
export function createGitEngine(ctx) {
  /**
   * Run git with a bounded deadline and collected output.
   * @param {string[]} args git arguments (without the leading "git").
   * @param {{cwd: string, timeoutMs?: number}} options
   * @returns {Promise<{code: number|null, stdout: string, stderr: string, timedOut: boolean}>}
   */
  async function runGit(args, options) {
    const cwd = options?.cwd ?? process.cwd();
    const timeoutMs = options?.timeoutMs ?? 20_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`git timeout after ${timeoutMs}ms`)), timeoutMs);
    try {
      const handle = ctx.subprocess.spawn({
        argv: ['git', ...args],
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

  async function gitText(args, options) {
    const result = await runGit(args, options);
    if (result.code !== 0) {
      throw new LabError('git_failed', result.stderr.trim() || `git ${args[0]} failed`, 422);
    }
    return result.stdout.trim();
  }

  /**
   * Validate a repository path and return the info needed by the wizard.
   * @param {unknown} rawPath absolute path supplied by the user.
   * @returns {Promise<object>} repository facts.
   */
  async function validateRepo(rawPath) {
    const candidate = typeof rawPath === 'string' ? rawPath.trim() : '';
    if (!candidate) throw new LabError('bad_path', 'repoPath is required', 400);
    if (!path.isAbsolute(candidate)) throw new LabError('bad_path', 'repoPath must be an absolute path', 400);

    const top = await runGit(['-C', candidate, 'rev-parse', '--show-toplevel'], { cwd: candidate });
    if (top.code !== 0) {
      throw new LabError('not_git', top.stderr.trim() || 'not a git repository', 422);
    }
    const repoRoot = top.stdout.trim();
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

    const baseCommit = await gitText(['-C', repoRoot, 'rev-parse', '--verify', `${defaultBranch}^{commit}`], { cwd: repoRoot });
    const status = await runGit(['-C', repoRoot, 'status', '--porcelain'], { cwd: repoRoot });

    return {
      repoRoot,
      gitDir,
      branches,
      defaultBranch,
      baseCommit,
      dirty: status.code === 0 && status.stdout.trim().length > 0,
    };
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
