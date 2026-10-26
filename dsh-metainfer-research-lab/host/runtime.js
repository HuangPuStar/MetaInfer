/**
 * M2 runtime: one worker activation per node, per-node anchor Agent, worktree
 * lifecycle, deterministic timeout watchdog + process reaper, follow-up messages.
 *
 * The runtime owns session/agent handles (memory only); durable node state lives in
 * the ProjectStore. Killing on timeout is plain Host code — never an Agent.
 */
import { readdir, readlink } from 'node:fs/promises';
import path from 'node:path';
import { LabError } from './git-engine.js';
import {
  cleanModelRef,
  costOfUsage,
  nextTierSelection,
  resolveModelSelection,
  validateModelSelection,
} from './models.js';
import { newSessionId } from './store.js';
import { prepareRemoteRun } from './remote-run.js';
import { DEFAULT_WORKER_PREFIX, WORKER_RULES } from './prompts.js';

/** JSON schema accepted by DSH's structured-output tool (supported subset only). */
export const NODE_REPORT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    changes: { type: 'array', items: { type: 'string' } },
    metrics: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          value: { type: 'string' },
          unit: { type: 'string' },
        },
        required: ['name', 'value'],
        additionalProperties: false,
      },
    },
    reproduce: { type: 'array', items: { type: 'string' } },
    success: { type: 'boolean' },
    blockers: { type: 'array', items: { type: 'string' } },
    next: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'changes', 'metrics', 'reproduce', 'success', 'blockers', 'next', 'risks'],
  additionalProperties: false,
};


function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function blocksText(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

/** Compare filesystem paths across Windows slash/case normalisation. */
function sameFsPath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return left === right;
  try {
    const a = path.resolve(left);
    const b = path.resolve(right);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return left === right;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Process-reaper platform fact. Linux uses /proc; macOS has no /proc and the
 * Windows process model exposes no stable per-process cwd API through Node, so
 * those platforms rely on DSH session-job cancellation (job objects on Windows)
 * plus this best-effort scan. Never pretend a reaper ran when it could not.
 */
function reaperPlatform() {
  if (process.platform === 'linux') return { kind: 'proc', supported: true, note: null };
  if (process.platform === 'darwin') return { kind: 'best-effort', supported: false, note: 'macOS has no /proc; worktree-cwd process reaping is best-effort; DSH job cancellation remains the primary cleanup path.' };
  if (process.platform === 'win32') return { kind: 'unsupported', supported: false, note: 'Windows has no /proc cwd scan; the lab relies on DSH session-job cancellation (job objects) for process-tree cleanup. GPU verification still runs.' };
  return { kind: 'unsupported', supported: false, note: `Process-cwd reaping is unsupported on ${process.platform}; DSH job cancellation remains the primary cleanup path.` };
}

/**
 * @returns {Promise<number[]>} processes whose cwd is inside the worktree.
 * Linux only; other platforms return [] and report their reaper fact separately.
 */
async function scanWorktreePids(worktreePath) {
  if (process.platform !== 'linux') return [];
  let entries;
  try {
    entries = await readdir('/proc');
  } catch {
    return [];
  }
  const prefix = worktreePath.endsWith(path.sep) ? worktreePath : worktreePath + path.sep;
  const found = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    try {
      const cwd = await readlink(`/proc/${name}/cwd`);
      if (cwd === worktreePath || cwd.startsWith(prefix)) found.push(pid);
    } catch {
      // process vanished or /proc entry unreadable
    }
  }
  return found;
}

/** Terminate known PIDs with a cheap platform-appropriate sequence. */
async function terminatePids(pids) {
  if (pids.length === 0) return;
  if (process.platform === 'win32') {
    for (const pid of pids) {
      try {
        process.kill(pid);
      } catch {
        // already gone or access denied
      }
    }
    return;
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  await sleep(400);
  for (const pid of pids) {
    if (!isAlive(pid)) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

/**
 * @param {{ctx: object, store: object, git: object}} deps
 */
export function createRuntime({ ctx, store, git, onTerminated, cluster }) {
  const active = new Map(); // key -> entry
  const deadlines = new Map(); // key -> epoch ms
  const pendingFollowUps = new Map(); // sessionId -> pending record
  const anchorHandles = new Map(); // sessionId -> AgentHandle
  const lifetime = new AbortController();

  function keyOf(projectId, nodeId) {
    return `${projectId}__${nodeId}`;
  }

  function roleModel(project, role) {
    const selection = resolveModelSelection(ctx, project, null, role);
    return {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
    };
  }

  function selectionToAgentOptions(selection) {
    return {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
    };
  }

  /** Resolve + validate the effective model for one node/role. */
  async function resolveNodeSelection(project, node, role) {
    const selection = resolveModelSelection(ctx, project, node, role);
    return validateModelSelection(ctx, project, selection);
  }

  function beginAttempt(node, selection) {
    if (!Array.isArray(node.attempts)) node.attempts = [];
    const attempt = {
      index: node.attempts.length + 1,
      sessionId: node.sessionId,
      anchorSessionId: node.anchorSessionId,
      model: {
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
        ...(selection.profileId ? { profileId: selection.profileId } : {}),
        source: selection.source ?? 'user',
      },
      startedAt: Date.now(),
    };
    node.attempts.push(attempt);
    node.currentAttempt = attempt.index;
    return attempt;
  }

  function lastAttempt(node) {
    return Array.isArray(node.attempts) && node.attempts.length > 0
      ? node.attempts[node.attempts.length - 1]
      : null;
  }

  function endAttempt(node, patch = {}) {
    const attempt = lastAttempt(node);
    if (!attempt || attempt.endedAt) return attempt;
    attempt.endedAt = Date.now();
    Object.assign(attempt, patch);
    return attempt;
  }

  /** Apply aggregated session usage + per-attempt cost to the node. */
  function applyUsage(project, node, usage) {
    node.usage = usage;
    const attempt = lastAttempt(node);
    const cost = costOfUsage(project, node.modelResolved ?? node.model, usage);
    if (attempt) {
      attempt.usage = usage;
      attempt.costUsd = cost.usd;
      attempt.priced = cost.priced;
    }
    const attemptsCost = (node.attempts ?? []).reduce((sum, item) => sum + (item.costUsd ?? 0), 0);
    node.costUsd = attemptsCost > 0 ? attemptsCost : cost.usd;
    node.costPriced = cost.priced || attemptsCost > 0;
  }

  /**
   * Automatic escalation: after a run-stage failure/timeout, if the project opted
   * in, rerun the same node as a NEW attempt with the next more expensive model
   * profile. Budget and maxAttempts are hard guards.
   */
  async function maybeAutoUpgrade(project, node, stage) {
    if (stage !== 'run' && stage !== 'timeout') return false;
    if (project.config.routing?.autoUpgrade !== true) return false;
    const maxAttempts = project.config.routing?.maxAttempts ?? 2;
    const attempts = Array.isArray(node.attempts) ? node.attempts.length : 0;
    if (attempts >= maxAttempts) return false;
    const maxCost = project.config.auto?.maxCostUsd ?? 0;
    if (maxCost > 0 && (node.costUsd ?? 0) >= maxCost) return false;
    const next = nextTierSelection(project, node.modelResolved ?? node.model);
    if (!next) return false;
    let validated;
    try {
      validated = await validateModelSelection(ctx, project, cleanModelRef(next));
    } catch {
      return false;
    }
    if (node.status === 'completed' || node.status === 'cancelled') return false;
    if (node.kind === 'merge') return false;
    node.model = {
      ...cleanModelRef(validated),
      source: 'escalation',
      reason: `automatic upgrade after ${stage} (attempt ${attempts})`,
    };
    node.sessionId = newSessionId();
    node.anchorSessionId = newSessionId();
    node.status = 'planned';
    node.autoEscalations = (node.autoEscalations ?? 0) + 1;
    node.deadlineAt = null;
    delete node.resourcesHeld;
    delete node.termination;
    node.timestamps = { ...(node.timestamps ?? {}), lastActivityAt: Date.now() };
    await persistNode(project, node, 'node/escalated', {
      data: {
        stage,
        attempts,
        to: validated.profileId ?? `${validated.provider}/${validated.model}`,
        effort: validated.reasoningEffort ?? null,
        automatic: true,
      },
    });
    setTimeout(() => {
      start(project.id, node.id).catch(() => {});
    }, 50);
    return true;
  }

  /** Prepare a fresh attempt with an explicit/next-tier model (manual upgrade). */
  async function prepareNewAttempt(projectId, nodeId, options = {}) {
    const project = requireProject(projectId);
    const node = requireNode(projectId, nodeId);
    if (node.status === 'running' || node.status === 'proposed') {
      throw new LabError('node_not_escalatable', `node ${nodeId} is ${node.status}`, 409);
    }
    if (node.status === 'completed') {
      const hasChildren = store
        .listNodes(projectId)
        .some((candidate) => {
          if (candidate.status === 'proposed') return false;
          const ids = Array.isArray(candidate.parentIds) ? candidate.parentIds : [candidate.parentId];
          return ids.includes(nodeId);
        });
      if (hasChildren) throw new LabError('node_sealed', 'cannot re-run a sealed node; fork a new successor instead', 409);
    }
    if (!['failed', 'completed', 'cancelled'].includes(node.status)) {
      throw new LabError('node_not_escalatable', `node ${nodeId} is ${node.status}; only failed/completed/cancelled nodes can start a new attempt`, 409);
    }
    const candidate = options.reuseModel === true
      ? cleanModelRef(options.model ?? node.modelResolved ?? node.model)
      : options.model
        ? cleanModelRef(options.model)
        : nextTierSelection(project, node.modelResolved ?? node.model);
    if (!candidate) throw new LabError('no_model_tier', 'no stronger priced model profile is configured', 409);
    const validated = await validateModelSelection(ctx, project, candidate);
    await store.withProjectLock(projectId, async () => {
      const freshProject = requireProject(projectId);
      const freshNode = requireNode(projectId, nodeId);
      if (!['failed', 'completed', 'cancelled'].includes(freshNode.status)) {
        throw new LabError('node_not_escalatable', `node ${nodeId} changed to ${freshNode.status}`, 409);
      }
      freshNode.model = {
        ...cleanModelRef(validated),
        source: options.source ?? 'user',
        ...(options.reason ? { reason: String(options.reason).slice(0, 500) } : {}),
      };
      freshNode.sessionId = newSessionId();
      freshNode.anchorSessionId = newSessionId();
      freshNode.status = 'planned';
      freshNode.deadlineAt = null;
      delete freshNode.resourcesHeld;
      delete freshNode.error;
      delete freshNode.termination;
      freshNode.timestamps = { ...(freshNode.timestamps ?? {}), lastActivityAt: Date.now() };
      await persistNode(freshProject, freshNode, options.eventType ?? 'node/model_changed', {
        data: {
          profileId: validated.profileId ?? null,
          provider: validated.provider,
          model: validated.model,
          reasoningEffort: validated.reasoningEffort ?? null,
          reason: options.reason ?? null,
          source: options.source ?? 'user',
        },
      });
    });
    return start(projectId, nodeId);
  }

  function requireProject(projectId) {
    const project = store.getProject(projectId);
    if (!project) throw new LabError('project_not_found', `unknown project: ${projectId}`, 404);
    return project;
  }

  function requireNode(projectId, nodeId) {
    const node = store.getNode(projectId, nodeId);
    if (!node) throw new LabError('node_not_found', `unknown node: ${nodeId}`, 404);
    return node;
  }

  function bump(project) {
    project.revision = (project.revision ?? 0) + 1;
    project.updatedAt = Date.now();
    return project.revision;
  }

  async function persistNode(project, node, eventType, payload = {}) {
    bump(project);
    await store.saveNode(project.id, node);
    await store.appendEvent(project, eventType, { nodeId: node.id, ...payload });
    await store.saveProject(project);
    return project.revision;
  }

  function runningNodes(projectId) {
    return store.listNodes(projectId).filter((node) => node.status === 'running');
  }

  function ensureCapacity(project, node) {
    const running = runningNodes(project.id);
    if (running.length >= project.config.maxRunningNodes) {
      throw new LabError(
        'capacity_exceeded',
        `maxRunningNodes=${project.config.maxRunningNodes} reached (${running.length} running)`,
        409,
      );
    }
    const held = {};
    for (const current of running) {
      for (const [resource, amount] of Object.entries(current.resourcesHeld ?? {})) {
        held[resource] = (held[resource] ?? 0) + amount;
      }
    }
    for (const [resource, amount] of Object.entries(node.needs ?? {})) {
      if (resource === 'machines') continue; // placement hint, not a resource pool
      const total = project.config.resourcePools?.[resource] ?? 0;
      if ((held[resource] ?? 0) + amount > total) {
        throw new LabError(
          'resource_exceeded',
          `resource "${resource}" unavailable: ${held[resource] ?? 0}/${total} held, node needs ${amount}`,
          409,
        );
      }
    }
  }

  async function ensureAnchor(project, node) {
    const existing = ctx.agents.get(node.anchorSessionId);
    if (existing) return existing;
    const set = new Set(node.needs ? Object.keys(node.needs) : []);
    void set;
    const model = roleModel(project, 'controller');
    const handle = await ctx.agents.create({
      sessionId: node.anchorSessionId,
      meta: { cwd: node.git.worktreePath, origin: 'subagent', agentPreset: 'lab-controller' },
      agentOptions: model,
      setup: async (agentCtx) => {
        await ctx.agentPresets.mount(agentCtx, 'lab-controller');
      },
    });
    anchorHandles.set(node.anchorSessionId, handle);
    return handle.agent;
  }

  async function resumeAnchor(project, node) {
    const existing = ctx.agents.get(node.anchorSessionId);
    if (existing) return existing;
    const handle = await ctx.agents.resume({
      resumeSessionId: node.anchorSessionId,
      setup: async (agentCtx) => {
        await ctx.agentPresets.mount(agentCtx, 'lab-controller');
      },
    });
    anchorHandles.set(node.anchorSessionId, handle);
    void project;
    return handle.agent;
  }

  async function disposeAnchor(node) {
    const handle = anchorHandles.get(node.anchorSessionId);
    if (!handle) return;
    anchorHandles.delete(node.anchorSessionId);
    try {
      await handle.dispose();
    } catch {
      // Anchor disposal is best-effort.
    }
  }

  function ancestorSummaries(projectId, parentId, depth = 2) {
    const out = [];
    let cursor = parentId;
    let guard = 0;
    while (cursor && guard < depth) {
      const parent = store.getNode(projectId, cursor);
      if (!parent) break;
      out.push({
        title: parent.title,
        summary: parent.report?.summary ?? (parent.reportText ?? '').slice(0, 400),
        headCommit: parent.git?.headCommit ?? null,
      });
      cursor = parent.parentId;
      guard += 1;
    }
    return out;
  }

  function mergePrompt(project, node, selection, remotePrompt = '') {
    const parents = (node.parentIds ?? [])
      .map((id) => store.getNode(project.id, id))
      .filter(Boolean)
      .map((parent) => ({
        id: parent.id,
        title: parent.title,
        branch: parent.git?.branch ?? null,
        headCommit: parent.git?.headCommit ?? null,
        report: parent.report?.summary ?? null,
      }));
    const state = node.merge?.state ?? 'pending';
    return [
      'You are the interactive merge agent of MetaInfer Research Lab.',
      `Worktree: ${node.git.worktreePath} (branch ${node.git.branch}). Work only inside it.`,
      `Model for this attempt: ${selection?.provider ?? 'default'}/${selection?.model ?? 'default'}${selection?.reasoningEffort ? ` (reasoning effort: ${selection.reasoningEffort})` : ''}`,
      `Parents merged into this worktree: ${JSON.stringify(parents, null, 2)}`,
      `Merge state: ${state}. Conflict files: ${JSON.stringify(node.merge?.conflictFiles ?? [])}.`,
      state === 'conflict'
        ? 'Resolve every conflict marker in the listed files. Keep the best evidence from both parents, then explain your resolution.'
        : 'The merge applied cleanly. Review the merged tree (and run a cheap check if useful), then summarize what the merge now contains.',
      'Do NOT run git commit/merge/checkout/branch/push: the Host commits the merge when the human clicks 完成合并.',
      'Read-only git commands (status/diff/log) are fine. Work only inside the worktree, do not delegate, do not ask questions.',
      'The human can send follow-up instructions in this conversation; answer concisely.',
      remotePrompt,
    ].join('\n');
  }

  async function prepareMerge(project, node) {
    const others = (node.parentIds ?? [])
      .slice(1)
      .map((id) => store.getNode(project.id, id))
      .filter(Boolean);
    const prepared = [];
    let conflicts = [];
    for (const other of others) {
      if (!other.git?.headCommit || !other.git?.branch) {
        throw new LabError('merge_parent_not_ready', `parent ${other.id} has no committed branch`, 409);
      }
      const result = await git.mergeBranchIntoWorktree(node.git.worktreePath, other.git.branch);
      prepared.push({
        parentId: other.id,
        branch: other.git.branch,
        headCommit: other.git.headCommit,
        clean: result.code === 0 && result.conflicts.length === 0,
        conflicts: result.conflicts,
        stderr: result.stderr,
      });
      if (result.conflicts.length > 0 || result.code !== 0) {
        conflicts = result.conflicts;
        break;
      }
    }
    node.merge = {
      ...(node.merge ?? {}),
      state: conflicts.length > 0 ? 'conflict' : 'clean',
      conflictFiles: conflicts,
      prepared,
      preparedAt: Date.now(),
    };
    await persistNode(project, node, 'node/merge_prepared', {
      data: { state: node.merge.state, conflicts: conflicts.length, parents: node.parentIds },
    });
  }

  async function onMergeTurnEnd(projectId, nodeId, result) {
    const key = keyOf(projectId, nodeId);
    const entry = active.get(key);
    if (!entry || entry.phase !== 'running') return;
    entry.phase = 'idle';
    const project = store.getProject(projectId);
    const node = store.getNode(projectId, nodeId);
    if (!project || !node) return;
    const text = blocksText(result?.output);
    node.lastReport = text || node.lastReport || '';
    applyUsage(project, node, await sessionUsage(node.sessionId));
    node.timestamps = { ...(node.timestamps ?? {}), lastActivityAt: Date.now() };
    await persistNode(project, node, 'node/merge_turn', {
      data: { stopReason: result?.stopReason ?? null, chars: text.length },
    });
  }

  function workerPrompt(project, node, selection, remotePrompt = '') {
    const customPrefix = typeof project.config?.prompts?.workerPrefix === 'string'
      ? project.config.prompts.workerPrefix.trim()
      : '';
    const needs = node.needs && Object.keys(node.needs).length > 0
      ? Object.entries(node.needs).map(([key, amount]) => `${key}=${amount}`).join(', ')
      : 'none';
    const ancestors = ancestorSummaries(project.id, node.parentId)
      .map((item, index) => `${index + 1}. ${item.title} — ${item.summary || '(no report)'} @ ${item.headCommit ?? 'n/a'}`)
      .join('\n');
    return [
      ...(customPrefix ? ['# Project-specific worker instructions', customPrefix, ''] : []),
      '# Project',
      `Name: ${project.name}`,
      'Research goal / brief:',
      project.brief,
      '',
      '# Your node',
      `Node: ${node.id} — ${node.title}`,
      `Base commit: ${node.git.baseCommit}`,
      `Model for this attempt: ${selection?.provider ?? 'default'}/${selection?.model ?? 'default'}${selection?.reasoningEffort ? ` (reasoning effort: ${selection.reasoningEffort})` : ''}`,
      `Working directory: ${node.git.worktreePath} (this is your git worktree; work only inside it)`,
      '',
      '# Task',
      node.prompt,
      '',
      '# Success criteria',
      node.successCriteria || "The task's code/data/artifacts are written into the working directory and are reproducible.",
      '',
      '# Reference: ancestor experiments',
      ancestors || '(this is the root experiment)',
      '',
      '# Constraints',
      `- Resources requested: ${needs}. Do not launch work beyond these.`,
      ...(node.needs?.machines > 1 ? [`- Placement: ${node.needs.machines} remote machines (fleet lease).`] : []),
      `- Time box: ${Math.round((node.timeboxMs ?? 600000) / 60000)} minutes (hard deadline enforced by the lab).`,
      WORKER_RULES,
      remotePrompt,
    ].join('\n');
  }

  function followUpPrompt(node, text) {
    return [
      `Additional instruction for node ${node.id} "${node.title}":`,
      text,
      '',
      'Work only inside the current worktree, do not run git write commands, and finish with a',
      'short plain-text summary of what changed and what you observed. Do not call structured_output.',
    ].join('\n');
  }

  async function killSessionJobs(sessionId) {
    const jobs = ctx.get('jobs');
    if (!jobs || typeof jobs.list !== 'function') return [];
    let list = [];
    try {
      list = jobs.list(sessionId) ?? [];
    } catch {
      return [];
    }
    const killed = [];
    for (const job of list) {
      const id = job?.id ?? job?.jobId;
      if (id === undefined || id === null) continue;
      try {
        const outcome = jobs.kill(id, sessionId, 'node terminated');
        killed.push(String(id));
        void outcome;
      } catch {
        // Job may have settled between list and kill.
      }
    }
    return killed;
  }

  async function reapWorktree(worktreePath) {
    const reaper = reaperPlatform();
    const pids = await scanWorktreePids(worktreePath);
    await terminatePids(pids);
    if (pids.length > 0) await sleep(300);
    const leftover = pids.filter((pid) => isAlive(pid)).map((pid) => `pid ${pid} still alive`);
    return {
      killedPids: pids,
      leftover,
      reaper: reaper.kind,
      reaperSupported: reaper.supported,
      reaperNote: reaper.note,
    };
  }

  /** Best-effort GPU accounting: which of `pids` still own a compute context. */
  async function checkGpu(pids) {
    if (!ctx.get('subprocess')) return { gpuFreed: true, leftover: [] };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('nvidia-smi timeout')), 5000);
    try {
      const nvidiaSmi = process.platform === 'win32' ? 'nvidia-smi.exe' : 'nvidia-smi';
      const handle = ctx.subprocess.spawn({
        argv: [nvidiaSmi, '--query-compute-apps=pid,used_memory', '--format=csv,noheader'],
        cwd: process.cwd(),
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 64 * 1024 },
          stderr: { maxBytes: 16 * 1024 },
        },
        graceMs: 1000,
        signal: controller.signal,
      });
      await handle.done;
      const text = handle.collected.stdout?.readFrom(0).text ?? '';
      const holders = text
        .split('\n')
        .map((line) => line.split(',')[0].trim())
        .filter((value) => /^\d+$/.test(value))
        .map(Number);
      const remaining = holders.filter((pid) => pids.includes(pid));
      return {
        gpuFreed: remaining.length === 0,
        leftover: remaining.map((pid) => `pid ${pid} still holds GPU memory`),
      };
    } catch {
      // No nvidia-smi / no GPU: not an error for accounting.
      return { gpuFreed: true, leftover: [] };
    } finally {
      clearTimeout(timer);
    }
  }

  async function releaseNode(project, node) {
    const leaseId = node.lease?.leaseId;
    delete node.resourcesHeld;
    node.deadlineAt = null;
    if (leaseId && cluster?.enabled) {
      try {
        await cluster.release(leaseId);
      } catch {
        // Lease expiry/reaper will recover it; never block finalization.
      }
    }
    delete node.lease;
    void project;
  }

  async function finish(projectId, nodeId, result) {
    const key = keyOf(projectId, nodeId);
    const entry = active.get(key);
    if (!entry || entry.phase !== 'running') return;
    entry.phase = 'finishing';
    active.delete(key);
    deadlines.delete(key);

    const project = store.getProject(projectId);
    const node = store.getNode(projectId, nodeId);
    if (!project || !node) return;

    try {
      const child = ctx.agents.get(node.sessionId);
      const childCwd = child?.session?.header?.cwd;
      if (childCwd !== undefined && !sameFsPath(childCwd, node.git.worktreePath)) {
        throw new LabError('sandbox_mismatch', `child cwd ${childCwd} != worktree ${node.git.worktreePath}`, 409);
      }
      if (result?.stopReason !== 'completed') {
        const diagnostic = result?.diagnostic || blocksText(result?.output) || `worker stopped: ${result?.stopReason}`;
        const error = new Error(diagnostic);
        error.stage = 'run';
        throw error;
      }
      const branch = await git.branchOf(node.git.worktreePath);
      if (branch !== node.git.branch) {
        const error = new Error(`worker left the worktree on branch "${branch}" (expected "${node.git.branch}")`);
        error.stage = 'run';
        throw error;
      }
      const commit = await git.commitWorktree(project, node, `dshex(${node.id}): ${node.title}`);
      node.git.headCommit = commit.head;
      node.report = result?.structured && typeof result.structured === 'object' ? result.structured : null;
      node.reportText = blocksText(result?.output) || node.reportText || '';
      applyUsage(project, node, await sessionUsage(node.sessionId));
      endAttempt(node, { stopReason: 'completed', status: 'completed' });
      node.status = 'completed';
      node.error = undefined;
      await releaseNode(project, node);
      node.timestamps = { ...(node.timestamps ?? {}), completedAt: Date.now(), lastActivityAt: Date.now() };
      await persistNode(project, node, 'node/completed', {
        data: { headCommit: commit.head, committed: commit.committed, reportSuccess: node.report?.success ?? null },
      });
    } catch (error) {
      await failNode(project, node, error, error?.stage === 'run' ? 'run' : 'commit');
    } finally {
      try {
        await entry.activation.dispose();
      } catch {
        // Activation already settled.
      }
      await disposeAnchor(node);
    }
  }

  async function failNode(project, node, error, stage) {
    try {
      const commit = await git.commitWorktree(project, node, `dshex(${node.id}): ${node.title} (failed)`);
      node.git.headCommit = commit.head;
    } catch {
      // Partial commit is best-effort.
    }
    await releaseNode(project, node);
    applyUsage(project, node, await sessionUsage(node.sessionId));
    endAttempt(node, {
      stopReason: 'failed',
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
    node.status = 'failed';
    node.error = {
      message: error instanceof Error ? error.message : String(error),
      at: Date.now(),
      stage,
    };
    node.timestamps = { ...(node.timestamps ?? {}), completedAt: Date.now(), lastActivityAt: Date.now() };
    await persistNode(project, node, 'node/failed', {
      data: { stage, message: node.error.message },
    });
    await maybeAutoUpgrade(project, node, stage === 'run' ? 'run' : stage);
  }

  async function failStart(project, node, error) {
    await releaseNode(project, node);
    node.status = 'failed';
    node.error = {
      message: error instanceof Error ? error.message : String(error),
      at: Date.now(),
      stage: 'start',
    };
    await persistNode(project, node, 'node/failed', { data: { stage: 'start', message: node.error.message } });
  }

  async function start(projectId, nodeId, options = {}) {
    const preProject = requireProject(projectId);
    const preNode = requireNode(projectId, nodeId);
    if (preNode.status !== 'planned') {
      throw new LabError('node_not_startable', `node ${nodeId} is ${preNode.status}, expected planned`, 409);
    }
    const selection = await resolveNodeSelection(
      preProject,
      preNode,
      preNode.kind === 'merge' ? 'merge' : 'worker',
    );
    const gpuNeed = Math.max(0, Math.floor(Number(preNode.needs?.gpu ?? 0)));
    // machines is a fleet placement hint that only exists together with GPU work.
    // CPU-only nodes must not be rejected by the default machines=1.
    const machinesNeed = gpuNeed > 0
      ? Math.max(1, Math.floor(Number(preNode.needs?.machines ?? 1)))
      : 0;
    if (gpuNeed > 0 && machinesNeed > 1 && !cluster?.enabled) {
      throw new LabError('multi_machine_requires_cluster', 'needs.machines>1 requires the cluster coordinator to be enabled', 409);
    }
    if (gpuNeed > 0 && machinesNeed > gpuNeed) {
      throw new LabError('bad_request', `needs.machines=${machinesNeed} cannot exceed needs.gpu=${gpuNeed}`, 400);
    }
    const clusterStatus = cluster?.getStatus?.() ?? {};
    const localDeviceCount = Array.isArray(clusterStatus.devices) ? clusterStatus.devices.length : 0;
    const localPlacement = cluster?.placementMode ?? 'local';
    let placement = 'local';
    if (cluster?.enabled && gpuNeed > 0) {
      placement = machinesNeed > 1
        || localPlacement === 'fleet'
        || (localPlacement === 'auto' && localDeviceCount === 0)
        ? 'fleet'
        : 'local';
      if (placement === 'fleet' && cluster.fleetEnabled !== true) {
        throw new LabError(
          'fleet_not_configured',
          'this node needs remote fleet GPUs but cluster.fleet is not configured on this DSH instance',
          409,
        );
      }
    }
    const placementConstraints = placement === 'fleet'
      ? (preProject.config.placementPolicy?.spec ?? null)
      : null;
    let lease = options.lease ?? null;
    if (cluster?.enabled && gpuNeed > 0 && !lease) {
      const quota = Math.max(0, Number(preProject.config.resourcePools?.gpu ?? 0));
      if (quota > 0) {
        const heldGpu = store
          .listNodes(projectId)
          .filter((candidate) => candidate.status === 'running')
          .reduce((sum, candidate) => sum + Math.max(0, Number(candidate.resourcesHeld?.gpu ?? 0)), 0);
        if (heldGpu + gpuNeed > quota) {
          throw new LabError(
            'project_gpu_quota',
            `project GPU quota reached: held ${heldGpu}/${quota}, node needs ${gpuNeed}`,
            409,
          );
        }
      }
      const requestId = `${preProject.id}:${preNode.id}`;
      let acquired;
      try {
        acquired = await cluster.acquire({
          requestId,
          projectId,
          nodeId,
          amount: gpuNeed,
          machines: machinesNeed,
          placement,
          constraints: placementConstraints,
          ttlMs: (preNode.timeboxMs ?? preProject.config.nodeTimeoutMinutes * 60_000) + 120_000,
          priority: preProject.config.clusterPriority ?? 0,
        });
      } catch (error) {
        const current = store.getNode(projectId, nodeId);
        if (current) {
          await failStart(store.getProject(projectId), current, new LabError(
            'cluster_unavailable',
            `GPU cluster coordinator unavailable: ${error instanceof Error ? error.message : String(error)}`,
            503,
          ));
        }
        throw error;
      }
      if (acquired.status === 'queued') {
        await store.withProjectLock(projectId, async () => {
          const queuedProject = requireProject(projectId);
          const queuedNode = requireNode(projectId, nodeId);
          if (queuedNode.status !== 'planned') return;
          queuedNode.resourceWait = {
            requestId,
            position: acquired.position ?? null,
            machineId: placement === 'local' ? cluster.machineId : null,
            pool: 'gpu',
            amount: gpuNeed,
            machines: machinesNeed,
            placement,
            constraints: placementConstraints,
            since: Date.now(),
            reason: acquired.reason ?? (placement === 'fleet' ? 'waiting-for-fleet-capacity' : 'waiting-for-gpu'),
          };
          await persistNode(queuedProject, queuedNode, 'node/resource_waiting', {
            data: {
              position: acquired.position ?? null,
              amount: gpuNeed,
              machines: machinesNeed,
              placement,
              machineId: placement === 'local' ? cluster.machineId : null,
            },
          });
        });
        return {
          node: store.getNode(projectId, nodeId),
          revision: store.getProject(projectId)?.revision ?? null,
          queued: true,
          queuePosition: acquired.position ?? null,
        };
      }
      lease = acquired.lease ?? null;
    }
    let project;
    let node;
    await store.withProjectLock(projectId, async () => {
      project = requireProject(projectId);
      node = requireNode(projectId, nodeId);
      if (node.status !== 'planned') {
        throw new LabError('node_not_startable', `node ${nodeId} is ${node.status}, expected planned`, 409);
      }
      if (cluster?.enabled && gpuNeed > 0) {
        const running = store.listNodes(projectId).filter((candidate) => candidate.status === 'running');
        if (running.length >= project.config.maxRunningNodes) {
          throw new LabError(
            'capacity_exceeded',
            `maxRunningNodes=${project.config.maxRunningNodes} reached (${running.length} running)`,
            409,
          );
        }
      } else {
        ensureCapacity(project, node);
      }
      if (lease) {
        node.lease = {
          leaseId: lease.leaseId,
          machineId: lease.machineId,
          deviceIds: lease.deviceIds,
          machines: Array.isArray(lease.machines) ? lease.machines : undefined,
          placement: lease.placement ?? placement,
          pool: lease.pool,
          expiresAt: lease.expiresAt,
          renewedAt: lease.renewedAt,
        };
        delete node.resourceWait;
      }
      beginAttempt(node, selection);
      node.modelResolved = {
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
        ...(selection.profileId ? { profileId: selection.profileId } : {}),
        source: selection.source ?? 'user',
      };
      node.status = 'running';
      delete node.error;
      delete node.termination;
      node.resourcesHeld = Object.fromEntries(
        Object.entries(node.needs ?? {}).filter(([key]) => key !== 'machines'),
      );
      node.usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      const timebox = node.timeboxMs ?? project.config.nodeTimeoutMinutes * 60_000;
      node.deadlineAt = Date.now() + timebox;
      node.timestamps = { ...(node.timestamps ?? {}), startedAt: Date.now(), lastActivityAt: Date.now() };
      await persistNode(project, node, 'node/started', {
        data: {
          deadlineAt: node.deadlineAt,
          timeboxMs: timebox,
          attempt: node.currentAttempt,
          model: node.modelResolved.profileId ?? `${node.modelResolved.provider}/${node.modelResolved.model}`,
          reasoningEffort: node.modelResolved.reasoningEffort ?? null,
        },
      });
    });

    try {
      await git.ensureWorktree(project, node);
      const anchor = await ensureAnchor(project, node);
      let remotePrompt = '';
      if (node.lease?.placement === 'fleet') {
        const remote = await prepareRemoteRun({ project, node, lease: node.lease, cluster });
        remotePrompt = remote.prompt;
        await store.withProjectLock(projectId, async () => {
          const remoteProject = requireProject(projectId);
          const remoteNode = requireNode(projectId, nodeId);
          remoteNode.remote = {
            mode: 'fleet',
            dir: '.dshex-run',
            leaseId: node.lease.leaseId,
            machineIds: (node.lease.machines ?? []).map((group) => group.machineId),
            masterPort: cluster.fleetMasterPort,
            preparedAt: Date.now(),
          };
          await persistNode(remoteProject, remoteNode, 'node/remote_prepared', {
            data: { leaseId: node.lease.leaseId, machineIds: remoteNode.remote.machineIds },
          });
        });
        node.remote = {
          mode: 'fleet',
          dir: '.dshex-run',
          leaseId: node.lease.leaseId,
          machineIds: (node.lease.machines ?? []).map((group) => group.machineId),
        };
      }
      if (node.kind === 'merge') {
        await prepareMerge(project, node);
        const mergeActivation = await ctx.subagents.startActivation({
          provider: 'spawn',
          label: `mir-merge/${project.id}/${node.id}`,
          delivery: 'caller',
          signal: lifetime.signal,
          childId: node.sessionId,
          request: {
            parent: anchor,
            cwd: node.git.worktreePath,
            prompt: [{ type: 'text', text: mergePrompt(project, node, selection, remotePrompt) }],
            agentPreset: 'lab-merge',
            agentOptions: selectionToAgentOptions(selection),
          },
        });
        active.set(keyOf(projectId, nodeId), {
          projectId,
          nodeId,
          project,
          node,
          activation: mergeActivation,
          anchorSessionId: node.anchorSessionId,
          phase: 'running',
          mode: 'merge',
        });
        deadlines.set(keyOf(projectId, nodeId), node.deadlineAt);
        const mergeChild = ctx.agents.get(node.sessionId);
        const mergeCwd = mergeChild?.session?.header?.cwd;
        if (mergeCwd !== undefined && !sameFsPath(mergeCwd, node.git.worktreePath)) {
          await terminate(projectId, nodeId, 'failure', {
            message: `sandbox boundary mismatch: ${mergeCwd} != ${node.git.worktreePath}`,
          });
          throw new LabError('sandbox_mismatch', 'merge session cwd does not equal the node worktree', 409);
        }
        mergeActivation.result.then(
          (result) => onMergeTurnEnd(projectId, nodeId, result).catch(() => {}),
          (error) => finishFailure(projectId, nodeId, error),
        );
        return { node: store.getNode(projectId, nodeId), revision: store.getProject(projectId).revision };
      }
      const activation = await ctx.subagents.startActivation({
        provider: 'spawn',
        label: `mir/${project.id}/${node.id}`,
        delivery: 'caller',
        signal: lifetime.signal,
        childId: node.sessionId,
        request: {
          parent: anchor,
          cwd: node.git.worktreePath,
          prompt: [{ type: 'text', text: workerPrompt(project, node, selection, remotePrompt) }],
          agentPreset: 'lab-worker',
          agentOptions: selectionToAgentOptions(selection),
          outputSchema: NODE_REPORT_SCHEMA,
        },
      });
      const activeEntry = {
        projectId,
        nodeId,
        project,
        node,
        activation,
        anchorSessionId: node.anchorSessionId,
        phase: 'running',
      };
      active.set(keyOf(projectId, nodeId), activeEntry);
      deadlines.set(keyOf(projectId, nodeId), node.deadlineAt);
      const child = ctx.agents.get(node.sessionId);
      const childCwd = child?.session?.header?.cwd;
      if (childCwd !== undefined && !sameFsPath(childCwd, node.git.worktreePath)) {
        await terminate(projectId, nodeId, 'failure', {
          message: `sandbox boundary mismatch: ${childCwd} != ${node.git.worktreePath}`,
        });
        throw new LabError('sandbox_mismatch', 'worker session cwd does not equal the node worktree', 409);
      }
      activation.result.then(
        (result) => finish(projectId, nodeId, result).catch(() => {}),
        (error) => finishFailure(projectId, nodeId, error),
      );
      return { node: store.getNode(projectId, nodeId), revision: project.revision };
    } catch (error) {
      const failed = active.get(keyOf(projectId, nodeId));
      if (!failed) {
        const current = store.getNode(projectId, nodeId);
        if (current) {
          await failStart(store.getProject(projectId), current, error);
          await disposeAnchor(current);
        }
      }
      throw error;
    }
  }

  async function finishFailure(projectId, nodeId, error) {
    const key = keyOf(projectId, nodeId);
    const entry = active.get(key);
    if (!entry || entry.phase !== 'running') return;
    entry.phase = 'finishing';
    active.delete(key);
    deadlines.delete(key);
    const project = store.getProject(projectId);
    const node = store.getNode(projectId, nodeId);
    if (project && node) await failNode(project, node, error, 'run');
    try {
      await entry.activation.dispose();
    } catch {
      // already settled
    }
    if (node) await disposeAnchor(node);
  }

  async function terminate(projectId, nodeId, kind, payload = {}) {
    const key = keyOf(projectId, nodeId);
    const entry = active.get(key);
    if (!entry || entry.phase !== 'running') return null;
    entry.phase = 'terminating';
    active.delete(key);
    deadlines.delete(key);

    const requestedAt = Date.now();
    const child = ctx.agents.get(nodeId === undefined ? '' : entry.node.sessionId);
    if (child && typeof child.cancel === 'function') {
      try {
        child.cancel({ kind: 'parent' });
      } catch {
        // cancellation is cooperative
      }
    }
    // Cancelling the activation escalates if the child ignores the first cancel.
    try {
      await Promise.race([entry.activation.dispose(), sleep(8000)]);
    } catch {
      // ignore dispose failure; the reaper still runs
    }
    const killedJobs = await killSessionJobs(entry.node.sessionId);
    const reaped = await reapWorktree(entry.node.git.worktreePath);
    const gpu = await checkGpu(reaped.killedPids);

    const project = store.getProject(projectId);
    const node = store.getNode(projectId, nodeId);
    if (project && node) {
      try {
        const commit = await git.commitWorktree(project, node, `dshex(${node.id}): ${node.title} (${kind})`);
        node.git.headCommit = commit.head;
      } catch {
        // best-effort
      }
      await releaseNode(project, node);
      applyUsage(project, node, await sessionUsage(entry.node.sessionId));
      endAttempt(node, {
        stopReason: kind === 'cancel' ? 'cancelled' : 'timeout',
        status: kind === 'cancel' ? 'cancelled' : 'failed',
      });
      const leftover = [...reaped.leftover, ...gpu.leftover];
      node.termination = {
        kind,
        requestedAt,
        killedAt: Date.now(),
        killedPids: reaped.killedPids,
        killedJobs,
        gpuFreed: gpu.gpuFreed,
        verifiedClean: leftover.length === 0,
        leftover,
        reaper: reaped.reaper,
        reaperSupported: reaped.reaperSupported,
        reaperNote: reaped.reaperNote,
      };
      node.status = kind === 'cancel' ? 'cancelled' : 'failed';
      node.error = {
        message: payload.message || (kind === 'cancel' ? 'cancelled by user' : 'node timed out and was terminated'),
        at: Date.now(),
        stage: kind === 'cancel' ? 'run' : kind === 'timeout' ? 'timeout' : 'run',
      };
      node.timestamps = { ...(node.timestamps ?? {}), completedAt: Date.now(), lastActivityAt: Date.now() };
      const terminalEvent = kind === 'cancel'
        ? 'node/cancelled'
        : kind === 'resource_lost'
          ? 'node/resource_lost'
          : 'node/timeout';
      await persistNode(project, node, terminalEvent, {
        data: {
          kind,
          killedPids: reaped.killedPids.length,
          killedJobs: killedJobs.length,
          verifiedClean: node.termination.verifiedClean,
          leftover,
          reaper: reaped.reaper,
          reaperSupported: reaped.reaperSupported,
        },
      });
    }
    pendingFollowUps.delete(entry.node.sessionId);
    await disposeAnchor(entry.node);
    try {
      onTerminated?.(projectId, nodeId, node?.termination ?? null);
    } catch {
      // GC is advisory; never block termination.
    }
    if (kind === 'timeout' && project && node) {
      try {
        await maybeAutoUpgrade(store.getProject(projectId), store.getNode(projectId, nodeId), 'timeout');
      } catch {
        // Escalation is best-effort; the timeout failure state stays.
      }
    }
    return { node, revision: project?.revision ?? null };
  }

  async function cancel(projectId, nodeId) {
    const project = requireProject(projectId);
    const node = requireNode(projectId, nodeId);
    const key = keyOf(projectId, nodeId);
    if (active.has(key)) return terminate(projectId, nodeId, 'cancel');
    if (node.status !== 'planned') {
      throw new LabError('node_not_cancellable', `node ${nodeId} is ${node.status}`, 409);
    }
    await store.withProjectLock(projectId, async () => {
      const current = requireNode(projectId, nodeId);
      current.status = 'cancelled';
      current.timestamps = { ...(current.timestamps ?? {}), completedAt: Date.now() };
      await persistNode(project, current, 'node/cancelled', { data: { kind: 'planned' } });
    });
    return { node: store.getNode(projectId, nodeId), revision: project.revision };
  }

  async function completeFollowUp(pending, reasonKind) {
    const entry = pendingFollowUps.get(pending.sessionId);
    if (entry) pendingFollowUps.delete(pending.sessionId);
    const project = store.getProject(pending.projectId);
    const node = store.getNode(pending.projectId, pending.nodeId);
    if (!project || !node) return;
    deadlines.delete(keyOf(pending.projectId, pending.nodeId));
    try {
      if (reasonKind !== 'completed') {
        const error = new Error(`follow-up turn ended: ${reasonKind}`);
        error.stage = 'run';
        throw error;
      }
      const commit = await git.commitWorktree(project, node, `dshex(${node.id}): ${node.title} (follow-up)`);
      node.git.headCommit = commit.head;
      node.reportText = (await lastAssistantText(node.sessionId)) || node.reportText || '';
      applyUsage(project, node, await sessionUsage(node.sessionId));
      node.followUps = [...(node.followUps ?? []), {
        at: Date.now(),
        user: pending.text,
        assistant: node.reportText,
        headCommit: commit.head,
      }];
      node.status = 'completed';
      node.error = undefined;
      await releaseNode(project, node);
      node.timestamps = { ...(node.timestamps ?? {}), completedAt: Date.now(), lastActivityAt: Date.now() };
      await persistNode(project, node, 'node/completed', { data: { headCommit: commit.head, followUp: true } });
    } catch (error) {
      await failNode(project, node, error, 'run');
    } finally {
      await disposeAnchor(node);
    }
  }

  async function lastAssistantText(sessionId) {
    try {
      const snapshot = await ctx.sessionQuery.readSurface(sessionId);
      const events = snapshot?.events ?? [];
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event?.type !== 'assistant/message') continue;
        const text = blocksText(event?.data?.message?.content);
        if (text) return text;
      }
    } catch {
      // surface unavailable
    }
    return '';
  }

  /** Sum TokenUsage carried by assistant/message events of one node session. */
  async function sessionUsage(sessionId) {
    const totals = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    try {
      const snapshot = await ctx.sessionQuery.readSurface(sessionId);
      for (const event of snapshot?.events ?? []) {
        if (event?.type !== 'assistant/message') continue;
        const usage = event?.data?.usage;
        if (!usage) continue;
        totals.inputTokens += usage.inputTokens ?? 0;
        totals.outputTokens += usage.outputTokens ?? 0;
        totals.cacheReadTokens += usage.cacheReadTokens ?? 0;
        totals.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
        totals.totalTokens += usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
      }
    } catch {
      // surface unavailable: keep zeroed accounting
    }
    if (totals.totalTokens === 0) totals.totalTokens = totals.inputTokens + totals.outputTokens;
    return totals;
  }

  async function message(projectId, nodeId, text, options = {}) {
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (!trimmed) throw new LabError('bad_request', 'message text is required', 400);
    if (trimmed.length > 8000) throw new LabError('bad_request', 'message text is too long', 400);
    const guardProject = requireProject(projectId);
    const guardNode = requireNode(projectId, nodeId);
    if (cluster?.enabled && Number(guardNode.needs?.gpu ?? 0) > 0) {
      throw new LabError(
        'gpu_followup_requires_attempt',
        'GPU nodes in cluster mode cannot be continued in place (no GPU lease would be held); use retry/escalate to start a new attempt with a lease',
        409,
      );
    }

    await store.withProjectLock(projectId, async () => {
      const project = requireProject(projectId);
      const node = requireNode(projectId, nodeId);
      const isLiveMerge = node.kind === 'merge' && node.status === 'running';
      const allowed =
        node.status === 'completed' ||
        (options.allowFailed === true && node.status === 'failed') ||
        isLiveMerge;
      if (!allowed) {
        throw new LabError('node_not_continuable', `node ${nodeId} is ${node.status}, expected completed`, 409);
      }
      const hasChildren = store
        .listNodes(projectId)
        .some((candidate) => {
          if (candidate.status === 'proposed') return false;
          const ids = Array.isArray(candidate.parentIds) ? candidate.parentIds : [candidate.parentId];
          return ids.includes(nodeId);
        });
      if (hasChildren) throw new LabError('node_sealed', 'node already has successors and is sealed', 409);
      if (!isLiveMerge) {
        ensureCapacity(project, node);
        node.status = 'running';
        node.resourcesHeld = Object.fromEntries(
          Object.entries(node.needs ?? {}).filter(([key]) => key !== 'machines'),
        );
        node.deadlineAt = Date.now() + (node.timeboxMs ?? project.config.nodeTimeoutMinutes * 60_000);
      }
      node.timestamps = { ...(node.timestamps ?? {}), lastActivityAt: Date.now() };
      await persistNode(project, node, 'node/resumed', {
        data: { text: trimmed.slice(0, 200), retry: options.allowFailed === true },
      });
    });

    const project = requireProject(projectId);
    const node = requireNode(projectId, nodeId);
    const pending = {
      sessionId: node.sessionId,
      projectId,
      nodeId,
      text: trimmed,
      mode: node.kind === 'merge' ? 'merge' : 'experiment',
    };
    pendingFollowUps.set(node.sessionId, pending);
    deadlines.set(keyOf(projectId, nodeId), node.deadlineAt);
    try {
      const anchor = await resumeAnchor(project, node);
      await ctx.subagents.sendMessage(anchor, node.sessionId, [{ type: 'text', text: followUpPrompt(node, trimmed) }], {
        signal: lifetime.signal,
      });
    } catch (error) {
      pendingFollowUps.delete(node.sessionId);
      const current = store.getNode(projectId, nodeId);
      if (current) await failNode(project, current, error, 'run');
      throw error;
    }
    return { node: store.getNode(projectId, nodeId), revision: store.getProject(projectId).revision };
  }

  /** Retry a failed node: restart a start-stage failure, or continue a run-stage failure. */
  async function retry(projectId, nodeId, options = {}) {
    const project = requireProject(projectId);
    const node = requireNode(projectId, nodeId);
    if (options.model || options.upgrade === true) {
      // Explicit model change / upgrade: run as a fresh attempt (new session).
      if (!['failed', 'completed', 'cancelled'].includes(node.status)) {
        throw new LabError('node_not_retryable', `node ${nodeId} is ${node.status}, expected failed/completed/cancelled`, 409);
      }
      return prepareNewAttempt(projectId, nodeId, {
        model: options.model,
        reuseModel: options.model === undefined && node.status === 'cancelled',
        source: options.model ? 'user' : 'escalation',
        reason: options.reason ?? (options.model ? 'manual model selection' : 'manual upgrade to a stronger model'),
        eventType: node.status === 'cancelled' ? 'node/retried' : undefined,
      });
    }
    if (node.status === 'cancelled') {
      if (node.error?.stage === 'start' || !node.timestamps?.startedAt) {
        await store.withProjectLock(projectId, async () => {
          const current = requireNode(projectId, nodeId);
          current.status = 'planned';
          current.deadlineAt = null;
          delete current.error;
          delete current.termination;
          delete current.resourcesHeld;
          current.timestamps = { ...(current.timestamps ?? {}), lastActivityAt: Date.now() };
          await persistNode(project, current, 'node/retried', { data: { restart: true } });
        });
        return { node: store.getNode(projectId, nodeId), revision: project.revision, restart: true };
      }
      // A cancelled running attempt cannot be resumed in place: start a fresh
      // attempt with a new session while reusing the current model tier.
      const current = resolveModelSelection(
        ctx,
        project,
        node,
        node.kind === 'merge' ? 'merge' : 'worker',
      );
      return prepareNewAttempt(projectId, nodeId, {
        model: cleanModelRef(current) ?? current,
        reuseModel: true,
        source: 'user',
        reason: options.reason ?? 'retry cancelled node as a fresh attempt',
        eventType: 'node/retried',
      });
    }
    if (node.status !== 'failed') {
      throw new LabError('node_not_retryable', `node ${nodeId} is ${node.status}, expected failed`, 409);
    }
    if (cluster?.enabled && Number(node.needs?.gpu ?? 0) > 0) {
      // A follow-up would run without a GPU lease; retry as a fresh attempt so
      // runtime.start() acquires a whole-GPU lease from the coordinator first.
      const current = resolveModelSelection(
        ctx,
        project,
        node,
        node.kind === 'merge' ? 'merge' : 'worker',
      );
      return prepareNewAttempt(projectId, nodeId, {
        model: cleanModelRef(current) ?? current,
        source: 'user',
        reason: 'cluster GPU retry as a new attempt (lease required)',
      });
    }
    if (node.error?.stage === 'start' || !node.timestamps?.startedAt) {
      await store.withProjectLock(projectId, async () => {
        const current = requireNode(projectId, nodeId);
        current.status = 'planned';
        current.deadlineAt = null;
        delete current.error;
        delete current.termination;
        delete current.resourcesHeld;
        current.timestamps = { ...(current.timestamps ?? {}), lastActivityAt: Date.now() };
        await persistNode(project, current, 'node/retried', { data: { restart: true } });
      });
      return { node: store.getNode(projectId, nodeId), revision: project.revision };
    }
    const failure = node.error?.message ?? 'unknown error';
    const termination = node.termination?.kind ? ` Termination: ${node.termination.kind}.` : '';
    const retryText = [
      `The previous run of this node failed: ${failure}.${termination}`,
      'Retry the original task. Diagnose the failure first (check the worktree state and any partial notes),',
      'then finish the original deliverables and submit the report. Do not repeat a deterministic hang.',
    ].join('\n');
    return message(projectId, nodeId, retryText, { allowFailed: true });
  }

  /** Human-in-the-loop completion of a merge node: verify + commit the merge. */
  async function finishMerge(projectId, nodeId, payload = {}) {
    const key = keyOf(projectId, nodeId);
    const entry = active.get(key);
    const project = requireProject(projectId);
    const node = requireNode(projectId, nodeId);
    if (node.kind !== 'merge') throw new LabError('not_a_merge_node', `node ${nodeId} is not a merge node`, 409);
    if (node.status !== 'running') {
      throw new LabError('node_not_mergeable', `node ${nodeId} is ${node.status}, expected running`, 409);
    }
    const result = await git.finishMergeInWorktree(
      node.git.worktreePath,
      `dshex(${node.id}): merge ${node.parentIds.join(' + ')}`,
    );
    if (entry) {
      entry.phase = 'finishing';
      active.delete(key);
      deadlines.delete(key);
    }
    node.git.headCommit = result.head;
    node.merge = {
      ...(node.merge ?? {}),
      state: 'committed',
      committedAt: Date.now(),
      committedBy: 'human',
      headCommit: result.head,
    };
    node.status = 'completed';
    node.report = {
      summary: typeof payload.summary === 'string' && payload.summary.trim()
        ? payload.summary.trim()
        : `Merge of ${node.parentIds.join(' + ')} completed by the user`,
      success: true,
      changes: [],
      metrics: [],
      reproduce: [],
      next: [],
      risks: [],
    };
    node.reportText = typeof payload.message === 'string' && payload.message.trim()
      ? payload.message.trim().slice(0, 8000)
      : (node.lastReport ?? '');
    applyUsage(project, node, await sessionUsage(node.sessionId));
    endAttempt(node, { stopReason: 'completed', status: 'completed' });
    await releaseNode(project, node);
    node.timestamps = {
      ...(node.timestamps ?? {}),
      completedAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    await persistNode(project, node, 'node/completed', {
      data: { kind: 'merge', headCommit: result.head, committed: result.committed },
    });
    if (entry) {
      try {
        await entry.activation.dispose();
      } catch {
        // already settled
      }
    }
    await disposeAnchor(node);
    return { node: store.getNode(projectId, nodeId), revision: store.getProject(projectId).revision };
  }

  /** Manual upgrade: rerun failed or completed-unsealed nodes with a stronger model. */
  async function escalate(projectId, nodeId, options = {}) {
    return prepareNewAttempt(projectId, nodeId, {
      model: options.model,
      source: 'escalation',
      reason: options.reason ?? 'manual escalation',
    });
  }

  async function onSessionEvent(session, event) {
    if (event?.type !== 'turn/end') return;
    const pending = pendingFollowUps.get(session?.id);
    if (!pending) return;
    pendingFollowUps.delete(session.id);
    const reasonKind = event?.data?.reason?.kind ?? 'unknown';
    if (pending.mode === 'merge') {
      const project = store.getProject(pending.projectId);
      const node = store.getNode(pending.projectId, pending.nodeId);
      if (project && node) {
        const entry = active.get(keyOf(pending.projectId, pending.nodeId));
        if (entry) entry.phase = 'idle';
        node.lastReport = (await lastAssistantText(node.sessionId)) || node.lastReport || '';
        applyUsage(project, node, await sessionUsage(node.sessionId));
        node.timestamps = { ...(node.timestamps ?? {}), lastActivityAt: Date.now() };
        await persistNode(project, node, 'node/merge_turn', { data: { followUp: true, reason: reasonKind } });
      }
      return;
    }
    await completeFollowUp(pending, reasonKind);
  }

  const leaseRenewedAt = new Map();
  const leasePumping = new Set();

  async function renewLeases() {
    if (!cluster?.enabled) return;
    const now = Date.now();
    for (const [key, entry] of active.entries()) {
      if (entry.phase !== 'running') continue;
      const lease = entry.node?.lease;
      if (!lease?.leaseId) continue;
      const last = leaseRenewedAt.get(key) ?? 0;
      if (now - last < cluster.heartbeatMs) continue;
      leaseRenewedAt.set(key, now);
      try {
        const renewed = await cluster.renew(lease.leaseId, (entry.node.timeboxMs ?? 600_000) + 120_000);
        if (renewed?.status === 'lost') throw new Error('lease lost');
        if (renewed?.lease) {
          lease.expiresAt = renewed.lease.expiresAt;
          lease.renewedAt = renewed.lease.renewedAt;
        }
      } catch (error) {
        await terminate(entry.projectId, entry.nodeId, 'resource_lost', {
          message: `GPU lease lost: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  async function clearNodeLease(projectId, nodeId, eventType, data = {}) {
    await store.withProjectLock(projectId, async () => {
      const project = requireProject(projectId);
      const node = requireNode(projectId, nodeId);
      if (!node.lease) return;
      delete node.lease;
      delete node.resourceWait;
      await persistNode(project, node, eventType, { data });
    });
  }

  async function pumpLeases() {
    if (!cluster?.enabled) return;
    for (const project of store.listProjects()) {
      for (const node of store.listNodes(project.id)) {
        if (node.status !== 'planned') continue;
        const hasWait = Boolean(node.resourceWait?.requestId);
        const hasLease = Boolean(node.lease?.leaseId);
        if (!hasWait && !hasLease) continue;
        const key = `${project.id}:${node.id}`;
        if (leasePumping.has(key)) continue;
        leasePumping.add(key);
        try {
          if (hasLease) {
            // Crash/reload recovery: the lease was granted but the node never started.
            let renewed;
            try {
              renewed = await cluster.renew(node.lease.leaseId, (node.timeboxMs ?? 600_000) + 120_000);
              if (renewed?.status !== 'renewed') throw new Error('lease lost');
            } catch {
              await clearNodeLease(project.id, node.id, 'node/resource_lost', { reason: 'lease-lost-on-recovery' });
              continue;
            }
            try {
              await start(project.id, node.id, {
                lease: { ...node.lease, expiresAt: renewed.lease.expiresAt, renewedAt: renewed.lease.renewedAt },
              });
            } catch {
              await cluster.release(node.lease.leaseId).catch(() => {});
              await clearNodeLease(project.id, node.id, 'node/resource_lost', { reason: 'start-failed-after-lease' });
            }
            continue;
          }
          const acquired = await cluster.acquire({
            requestId: node.resourceWait.requestId,
            projectId: project.id,
            nodeId: node.id,
            amount: node.resourceWait.amount ?? 1,
            machines: node.resourceWait.machines ?? 1,
            placement: node.resourceWait.placement ?? 'local',
            constraints: node.resourceWait.constraints ?? null,
            ttlMs: (node.timeboxMs ?? project.config.nodeTimeoutMinutes * 60_000) + 120_000,
            priority: project.config.clusterPriority ?? 0,
          });
          if (acquired.status !== 'granted') continue;
          await store.withProjectLock(project.id, async () => {
            const freshProject = requireProject(project.id);
            const freshNode = requireNode(project.id, node.id);
            if (freshNode.status !== 'planned' || !freshNode.resourceWait) return;
            delete freshNode.resourceWait;
            freshNode.lease = {
              leaseId: acquired.lease.leaseId,
              machineId: acquired.lease.machineId,
              deviceIds: acquired.lease.deviceIds,
              pool: acquired.lease.pool,
              expiresAt: acquired.lease.expiresAt,
              renewedAt: acquired.lease.renewedAt,
            };
            await persistNode(freshProject, freshNode, 'node/resource_granted', {
              data: { leaseId: acquired.lease.leaseId, deviceIds: acquired.lease.deviceIds, machineId: acquired.lease.machineId },
            });
          });
          await start(project.id, node.id, { lease: acquired.lease });
        } catch {
          // Coordinator unreachable or race: retry on the next pump cycle.
        } finally {
          leasePumping.delete(key);
        }
      }
    }
  }

  function startLeasePump(intervalMs = 2000) {
    const timer = setInterval(() => {
      pumpLeases().catch(() => {});
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  async function tick() {
    const now = Date.now();
    try {
      await renewLeases();
    } catch {
      // renewLeases handles per-lease failures
    }
    for (const [key, deadlineAt] of [...deadlines.entries()]) {
      if (now < deadlineAt) continue;
      const entry = active.get(key);
      if (!entry || entry.phase !== 'running') {
        deadlines.delete(key);
        continue;
      }
      await terminate(entry.projectId, entry.nodeId, 'timeout', {
        message: `node exceeded its ${Math.round((entry.node.timeboxMs ?? 0) / 60000)} minute deadline and was terminated deterministically`,
      });
    }
  }

  function decorateNodes(projectId, nodes) {
    return nodes.map((node) => {
      if (node.status !== 'running') return node;
      const deadlineAt = deadlines.get(keyOf(projectId, node.id)) ?? node.deadlineAt ?? null;
      return { ...node, deadlineAt };
    });
  }

  function dispose() {
    lifetime.abort();
    for (const entry of active.values()) {
      try {
        entry.activation.cancel?.();
      } catch {
        // ignore
      }
      try {
        entry.activation.dispose?.();
      } catch {
        // ignore
      }
    }
    active.clear();
    for (const handle of anchorHandles.values()) {
      try {
        handle.dispose?.();
      } catch {
        // ignore
      }
    }
    anchorHandles.clear();
    pendingFollowUps.clear();
    deadlines.clear();
  }

  return {
    start,
    cancel,
    message,
    retry,
    escalate,
    finishMerge,
    terminate,
    tick,
    pumpLeases,
    startLeasePump,
    decorateNodes,
    onSessionEvent,
    dispose,
  };
}
