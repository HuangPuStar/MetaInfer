/**
 * M2 runtime: one worker activation per node, per-node anchor Agent, worktree
 * lifecycle, deterministic timeout watchdog + process reaper, follow-up messages.
 *
 * The runtime owns session/agent handles (memory only); durable node state lives in
 * the ProjectStore. Killing on timeout is plain Host code — never an Agent.
 */
import { readFile, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';
import { LabError } from './git-engine.js';
import {
  cleanModelRef,
  costOfUsage,
  nextTierSelection,
  resolveModelSelection,
  validateModelSelection,
} from './models.js';
import { isDshExecution, EXECUTION_DRIVERS } from './execution.js';
import { ExecutionLog, executionLogPath } from './execution-log.js';
import { newSessionId } from './store.js';
import { nodeReportView } from './snapshot.js';
import { prepareRemoteRun } from './remote-run.js';
import { DEFAULT_MERGE_PROMPT, DEFAULT_WORKER_PREFIX, WORKER_RULES } from './prompts.js';

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
 * A zombie still answers `kill(pid, 0)` but holds no CPU, memory, or GPU
 * context; reporting it as a leftover would turn a clean reap into a false
 * alarm. Missing /proc entry means the process is already gone.
 */
async function isZombie(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const stateIndex = stat.lastIndexOf(')') + 2;
    return stat.slice(stateIndex, stateIndex + 1) === 'Z';
  } catch {
    return true;
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

  /**
   * Append the node session's sandbox-mode override.
   *
   * GPU runtimes open device nodes (e.g. /dev/kfd) read-write; a workspace-write
   * file sandbox denies that open, leaving torch with `device_count() == 0` while
   * the shell itself still works. `auto` lifts only nodes that requested
   * GPU/machine resources, so CPU nodes stay confined by default.
   */
  function seedNodeSandbox(sessionId, project, node) {
    let mode = project?.config?.workerSandboxMode ?? 'auto';
    if (mode === 'auto') {
      const gpu = Number(node?.needs?.gpu ?? 0);
      const machines = Number(node?.needs?.machines ?? 0);
      mode = gpu > 0 || machines > 0 ? 'danger-full-access' : 'workspace-write';
    }
    try {
      const session = ctx.agents.get(sessionId)?.session;
      if (session && typeof session.append === 'function') {
        session.append('sandbox/mode', { mode });
      }
    } catch {
      // Best-effort: leave the deployment default in place if the switch fails.
    }
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

  function isSealed(projectId, nodeId) {
    const node = store.getNode(projectId, nodeId);
    if (node?.timestamps?.sealedAt || node?.tag) return true;
    return store.listNodes(projectId).some((candidate) => {
      if (candidate.status === 'proposed') return false;
      const ids = Array.isArray(candidate.parentIds) ? candidate.parentIds : [candidate.parentId];
      return ids.includes(nodeId);
    });
  }

  /** Claim before awaiting IO. Disposal must never hold the project lock:
   * the SDK turn/end callback may itself be waiting for that lock.
   */
  async function claimEntry(projectId, nodeId, phase, { expected, deadlineAt, allowStarting = false } = {}) {
    return store.withProjectLock(projectId, async () => {
      const key = keyOf(projectId, nodeId);
      const entry = active.get(key);
      const node = store.getNode(projectId, nodeId);
      if (!entry || (expected && entry !== expected) || node?.status !== 'running') return null;
      if (!['running', 'idle', ...(allowStarting ? ['starting'] : [])].includes(entry.phase)) return null;
      if (deadlineAt !== undefined && (node.deadlineAt !== deadlineAt || Date.now() < node.deadlineAt)) return null;
      entry.phase = phase;
      entry.node = node;
      deadlines.delete(key);
      if (pendingFollowUps.get(entry.sessionId)?.entry === entry) pendingFollowUps.delete(entry.sessionId);
      return entry;
    });
  }

  function forgetEntry(entry) {
    const key = keyOf(entry.projectId, entry.nodeId);
    if (active.get(key) !== entry) return;
    active.delete(key);
    deadlines.delete(key);
    if (pendingFollowUps.get(entry.sessionId)?.entry === entry) pendingFollowUps.delete(entry.sessionId);
  }

  async function disposeActivation(entry, timeoutMs = 0) {
    if (!entry.activation) return;
    let timer;
    try {
      const disposed = entry.activation.dispose();
      if (timeoutMs > 0) {
        await Promise.race([disposed, new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
      } else {
        await disposed;
      }
    } catch {
      // Cleanup/reaping still runs when cooperative cancellation fails.
    } finally {
      clearTimeout(timer);
    }
  }

  /** Persist before publishing the watchdog deadline. Failed writes restore
   * only this node's budget fields; project reservations are not rewound.
   */
  async function updateTimebox(projectId, nodeId, timeboxMs) {
    return store.withProjectLock(projectId, async () => {
      const project = requireProject(projectId);
      const node = requireNode(projectId, nodeId);
      const maximum = Math.min(1440, project.config.maxNodeTimeoutMinutes ?? 1440);
      if (!Number.isSafeInteger(timeboxMs) || timeboxMs < 60_000 || timeboxMs % 60_000 !== 0 || timeboxMs > maximum * 60_000) {
        throw new LabError('timebox_invalid', `timebox must be an integer number of minutes in 1..${maximum}`, 400);
      }
      const key = keyOf(projectId, nodeId);
      const entry = active.get(key);
      if (entry && !['running', 'idle'].includes(entry.phase)) {
        throw new LabError('node_timebox_unavailable', 'node is starting, finishing or terminating; try again shortly', 409);
      }
      if (isSealed(projectId, nodeId)) {
        throw new LabError('node_sealed', 'node already has successors and is sealed', 409);
      }
      const oldBudget = node.timeboxMs ?? project.config.nodeTimeoutMinutes * 60_000;
      let newDeadline = node.deadlineAt;
      if (node.status === 'running') {
        if (!entry || !Number.isFinite(node.deadlineAt) || node.deadlineAt <= Date.now()) {
          throw new LabError('node_timebox_unavailable', 'node is starting or its deadline already elapsed; try again shortly if starting', 409);
        }
        newDeadline = node.deadlineAt + timeboxMs - oldBudget;
        if (newDeadline <= Date.now()) {
          throw new LabError('timebox_elapsed', 'new timebox is shorter than the time already used by this run', 409);
        }
      } else if (!['planned', 'proposed', 'failed', 'cancelled', 'completed'].includes(node.status)) {
        throw new LabError('node_timebox_unavailable', 'node timebox is not available in this state', 409);
      }
      const beforeNode = structuredClone(node);
      const reservedRevision = (project.revision ?? 0) + 1;
      const reservedEventSeq = (project.counters?.eventSeq ?? 0) + 1;
      node.timeboxMs = timeboxMs;
      if (node.status === 'running') node.deadlineAt = newDeadline;
      try {
        project.revision = reservedRevision;
        project.updatedAt = Date.now();
        // Reserve the event seq with the authoritative node/project first: a
        // failed saveProject must not leave a successful timebox audit event.
        const eventProject = structuredClone(project);
        project.counters = { ...(project.counters ?? {}), eventSeq: reservedEventSeq };
        await store.saveNode(project.id, node);
        await store.saveProject(project);
        await store.appendEvent(eventProject, 'node/timebox_changed', {
          nodeId: node.id, data: { previousTimeboxMs: oldBudget, timeboxMs, deadlineAt: node.deadlineAt ?? null },
        });
      } catch (error) {
        for (const name of ['timeboxMs', 'deadlineAt']) {
          if (Object.hasOwn(beforeNode, name)) node[name] = beforeNode[name];
          else delete node[name];
        }
        // Keep project revision/seq reservations: even a fresh compensating
        // project put can overwrite another writer already queued before us.
        try { await store.saveNode(projectId, node); } catch (rollbackError) { error.rollbackError = rollbackError; }
        throw error;
      }
      if (entry) { entry.node = node; entry.project = project; }
      if (node.status === 'running') deadlines.set(key, newDeadline);
      return { node, revision: project.revision };
    });
  }

  function requireStarting(entry) {
    if (active.get(keyOf(entry.projectId, entry.nodeId)) !== entry || entry.phase !== 'starting' || entry.node.status !== 'running' || entry.node.sessionId !== entry.sessionId) {
      throw new LabError('node_not_startable', 'node stopped while activation was starting', 409);
    }
  }

  async function registerActivation(entry, activation, patch = {}) {
    try {
      await store.withProjectLock(entry.projectId, async () => {
        requireStarting(entry);
        Object.assign(entry, patch, { activation, phase: 'running' });
      });
      return entry;
    } catch (error) {
      try { ctx.agents.get(entry.sessionId)?.cancel?.({ kind: 'parent' }); } catch { /* best effort */ }
      Promise.resolve(activation.result).catch(() => {});
      await disposeActivation({ activation }, 8000);
      throw error;
    }
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
      const view = nodeReportView(parent);
      out.push({
        title: parent.title,
        summary: view.report?.summary ?? view.reportText.slice(0, 400),
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
        report: nodeReportView(parent).report?.summary ?? nodeReportView(parent).reportText.slice(0, 400),
      }));
    const state = node.merge?.state ?? 'pending';
    const custom = project.config?.prompts?.merge;
    return [
      custom && custom.trim() ? custom.trim() : DEFAULT_MERGE_PROMPT,
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

  async function onMergeTurnEnd(projectId, nodeId, result, expected) {
    if (result?.stopReason !== 'completed') {
      await finishFailure(projectId, nodeId, new Error(`merge turn ended: ${result?.stopReason}`), expected);
      return;
    }
    const text = blocksText(result?.output);
    const usage = await sessionUsage(expected.sessionId);
    await store.withProjectLock(projectId, async () => {
      const entry = active.get(keyOf(projectId, nodeId));
      const project = store.getProject(projectId);
      const node = store.getNode(projectId, nodeId);
      if (entry !== expected || entry.phase !== 'running' || node?.status !== 'running' || !project) return;
      entry.phase = 'idle';
      node.lastReport = text || node.lastReport || '';
      applyUsage(project, node, usage);
      node.timestamps = { ...(node.timestamps ?? {}), lastActivityAt: Date.now() };
      await persistNode(project, node, 'node/merge_turn', {
        data: { stopReason: result?.stopReason ?? null, chars: text.length },
      });
    });
  }

  function workerPrompt(project, node, selection, remotePrompt = '', external = false) {
    const customPrefix = typeof project.config?.prompts?.workerPrefix === 'string'
      ? project.config.prompts.workerPrefix.trim()
      : '';
    const needs = node.needs && Object.keys(node.needs).length > 0
      ? Object.entries(node.needs).map(([key, amount]) => `${key}=${amount}`).join(', ')
      : 'none';
    const ancestors = ancestorSummaries(project.id, node.parentId)
      .map((item, index) => `${index + 1}. ${item.title} — ${item.summary || '(no report)'} @ ${item.headCommit ?? 'n/a'}`)
      .join('\n');
    const rules = external
      ? WORKER_RULES.split('\n').filter((line) => !line.includes('structured_output')).join('\n')
      : WORKER_RULES;
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
      rules,
      ...(external ? [
        '',
        '# Final response contract',
        'End your final answer with exactly one fenced JSON object:',
        '```json',
        '{"summary":"...","changes":["..."],"metrics":[{"name":"...","value":"...","unit":"..."}],"reproduce":["..."],"success":true,"blockers":[],"next":[],"risks":[]}',
        '```',
        'Do not call structured_output; the Host stores this block as the node report.',
      ] : []),
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
    if (pids.length > 0) {
      // SIGKILL is asynchronous. Poll briefly instead of declaring a leftover
      // that disappears a few seconds later (observed with a killed sglang
      // process tree in the cancel path).
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (pids.every((pid) => !isAlive(pid))) break;
        await sleep(150);
      }
    }
    const leftover = [];
    for (const pid of pids) {
      if (!isAlive(pid)) continue;
      if (await isZombie(pid)) continue;
      leftover.push(`pid ${pid} still alive`);
    }
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

  async function cleanupNodeRuntime(node) {
    const killedJobs = await killSessionJobs(node.sessionId);
    const reaped = await reapWorktree(node.git.worktreePath);
    const gpu = await checkGpu(reaped.killedPids);
    const leftover = [...reaped.leftover, ...gpu.leftover];
    return {
      at: Date.now(),
      killedJobs,
      killedPids: reaped.killedPids,
      gpuFreed: gpu.gpuFreed,
      verifiedClean: leftover.length === 0,
      leftover,
      reaper: reaped.reaper,
      reaperSupported: reaped.reaperSupported,
      reaperNote: reaped.reaperNote,
    };
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

  async function finish(projectId, nodeId, result, expected) {
    const entry = await claimEntry(projectId, nodeId, 'finishing', { expected });
    if (!entry) return;

    const project = store.getProject(projectId);
    const node = store.getNode(projectId, nodeId);
    if (!project || !node) { forgetEntry(entry); return; }

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
      // Stop a worker that finished its turn but left a server/job behind;
      // otherwise the supposedly completed node keeps holding GPU memory.
      node.cleanup = await cleanupNodeRuntime(node);
      const commit = await git.commitWorktree(project, node, `dshex(${node.id}): ${node.title}`);
      node.git.headCommit = commit.head;
      node.report = result?.structured && typeof result.structured === 'object' ? result.structured : null;
      node.reportText = blocksText(result?.output);
      node.reportSource = 'activation';
      node.reportUpdatedAt = Date.now();
      delete node.review;
      if (entry.external) {
        node.executionThreadId = result?.threadId ?? node.executionThreadId;
        node.executionRun = {
          ...(node.executionRun ?? {}),
          status: 'completed',
          endedAt: Date.now(),
          threadId: node.executionThreadId ?? null,
        };
      }
      applyUsage(
        project,
        node,
        entry.external && result?.usage
          ? externalUsage(result.usage)
          : await sessionUsage(node.sessionId),
      );
      endAttempt(node, { stopReason: 'completed', status: 'completed' });
      node.status = 'completed';
      node.error = undefined;
      await releaseNode(project, node);
      node.timestamps = { ...(node.timestamps ?? {}), completedAt: Date.now(), lastActivityAt: Date.now() };
      await persistNode(project, node, 'node/completed', {
        data: { headCommit: commit.head, committed: commit.committed, reportSuccess: node.report?.success ?? null, cleanup: node.cleanup ?? null },
      });
    } catch (error) {
      await failNode(project, node, error, error?.stage === 'run' ? 'run' : 'commit');
    } finally {
      await disposeActivation(entry);
      await disposeAnchor({ anchorSessionId: entry.anchorSessionId });
      forgetEntry(entry);
    }
  }

  async function failNode(project, node, error, stage) {
    if (!node.cleanup) {
      try {
        node.cleanup = await cleanupNodeRuntime(node);
      } catch {
        // Cleanup is best-effort; the failure state still needs to be recorded.
      }
    }
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
      data: { stage, message: node.error.message, cleanup: node.cleanup ?? null },
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

  /** Normalize Codex SDK usage into the Lab token shape. */
  function externalUsage(usage) {
    if (!usage || typeof usage !== 'object') return null;
    const inputTokens = Number(usage.input_tokens ?? 0) || 0;
    const outputTokens = Number(usage.output_tokens ?? 0) || 0;
    const cacheReadTokens = Number(usage.cached_input_tokens ?? 0) || 0;
    const cacheWriteTokens = Number(usage.cache_write_input_tokens ?? 0) || 0;
    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
    };
  }

  async function startExternalNode(project, node, execution, startingEntry) {
    const driver = EXECUTION_DRIVERS[execution.driver];
    if (typeof driver !== 'function') {
      throw new LabError('unavailable', `execution driver "${execution.driver}" is not registered`, 503);
    }
    const runId = `${node.id}-a${node.currentAttempt}`;
    const log = new ExecutionLog(executionLogPath(project.id, node.id, runId));
    await log.init();
    requireStarting(startingEntry);
    await log.append({
      type: 'run/started',
      profile: execution.profile,
      driver: execution.driver,
      model: execution.model ?? null,
      reasoningEffort: execution.reasoningEffort ?? null,
      worktreePath: node.git.worktreePath,
    });
    requireStarting(startingEntry);
    node.executionRun = {
      runId,
      profile: execution.profile,
      driver: execution.driver,
      model: execution.model ?? null,
      reasoningEffort: execution.reasoningEffort ?? null,
      logPath: log.filePath,
      status: 'running',
      startedAt: Date.now(),
    };
    await persistNode(project, node, 'node/execution_started', {
      data: { runId, driver: execution.driver, profile: execution.profile, logPath: log.filePath },
    });
    requireStarting(startingEntry);

    const controller = new AbortController();
    let settled = false;
    const prompt = workerPrompt(project, node, null, '', true);
    const resultPromise = (async () => {
      try {
        const result = await driver({
          cwd: node.git.worktreePath,
          prompt,
          outputSchema: NODE_REPORT_SCHEMA,
          model: execution.model,
          reasoningEffort: execution.reasoningEffort,
          codexPath: execution.codexPath,
          signal: controller.signal,
          threadId: node.executionThreadId,
          onEvent: (event) => log.append(event),
        });
        await log.append({
          type: 'run/completed',
          threadId: result.threadId ?? null,
          finalResponse: result.finalResponse ?? '',
          usage: result.usage ?? null,
        });
        return {
          stopReason: 'completed',
          output: [{ type: 'text', text: result.finalResponse ?? '' }],
          structured: result.report ?? null,
          usage: result.usage ?? null,
          threadId: result.threadId ?? null,
        };
      } catch (error) {
        await log.append({
          type: 'run/failed',
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        settled = true;
      }
    })();
    const activation = {
      result: resultPromise,
      dispose: async () => {
        if (settled) return;
        controller.abort();
        await log.append({ type: 'run/cancelled' });
      },
    };
    const entry = await registerActivation(startingEntry, activation, { external: true, execution, executionLog: log });
    resultPromise.then(
      (result) => finish(project.id, node.id, result, entry).catch(() => {}),
      (error) => finishFailure(project.id, node.id, error, entry).catch(() => {}),
    );
    return { node: store.getNode(project.id, node.id), revision: project.revision };
  }

  async function start(projectId, nodeId, options = {}) {
    const preProject = requireProject(projectId);
    const preNode = requireNode(projectId, nodeId);
    if (preNode.status !== 'planned') {
      throw new LabError('node_not_startable', `node ${nodeId} is ${preNode.status}, expected planned`, 409);
    }
    const execution = preNode.execution && typeof preNode.execution === 'object'
      ? preNode.execution
      : { profile: 'dsh', driver: 'dsh' };
    const externalExecution = !isDshExecution(execution);
    const selection = externalExecution
      ? {
          provider: `execution:${execution.profile}`,
          model: execution.model ?? 'native',
          ...(execution.reasoningEffort ? { reasoningEffort: execution.reasoningEffort } : {}),
          source: 'execution-profile',
        }
      : await resolveNodeSelection(
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
    let startingEntry;
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
      startingEntry = { projectId, nodeId, project, node, sessionId: node.sessionId, anchorSessionId: node.anchorSessionId, activation: null, phase: 'starting', external: externalExecution };
      active.set(keyOf(projectId, nodeId), startingEntry);
      deadlines.set(keyOf(projectId, nodeId), node.deadlineAt);
    });

    try {
      await git.ensureWorktree(project, node);
      requireStarting(startingEntry);
      if (externalExecution) {
        if (node.kind === 'merge') {
          throw new LabError('bad_request', 'merge nodes require the dsh execution profile', 400);
        }
        if (node.lease?.placement === 'fleet') {
          throw new LabError('unsupported', 'external execution profiles currently require local placement', 409);
        }
        return await startExternalNode(project, node, execution, startingEntry);
      }
      const anchor = await ensureAnchor(project, node);
      requireStarting(startingEntry);
      let remotePrompt = '';
      if (node.lease?.placement === 'fleet') {
        const remote = await prepareRemoteRun({ project, node, lease: node.lease, cluster });
        remotePrompt = remote.prompt;
        await store.withProjectLock(projectId, async () => {
          requireStarting(startingEntry);
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
      requireStarting(startingEntry);
      if (node.kind === 'merge') {
        await prepareMerge(project, node);
        requireStarting(startingEntry);
        const mergeActivation = await ctx.subagents.startActivation({
          provider: 'spawn',
          label: `mir-merge/${project.id}/${node.id}`,
          delivery: 'caller',
          signal: lifetime.signal,
          childId: startingEntry.sessionId,
          request: {
            parent: anchor,
            cwd: node.git.worktreePath,
            prompt: [{ type: 'text', text: mergePrompt(project, node, selection, remotePrompt) }],
            agentPreset: 'lab-merge',
            agentOptions: selectionToAgentOptions(selection),
          },
        });
        const mergeEntry = await registerActivation(startingEntry, mergeActivation, { mode: 'merge' });
        seedNodeSandbox(mergeEntry.sessionId, project, node);
        const mergeChild = ctx.agents.get(mergeEntry.sessionId);
        const mergeCwd = mergeChild?.session?.header?.cwd;
        if (mergeCwd !== undefined && !sameFsPath(mergeCwd, node.git.worktreePath)) {
          await terminate(projectId, nodeId, 'failure', {
            message: `sandbox boundary mismatch: ${mergeCwd} != ${node.git.worktreePath}`, expectedEntry: mergeEntry,
          });
          throw new LabError('sandbox_mismatch', 'merge session cwd does not equal the node worktree', 409);
        }
        mergeActivation.result.then(
          (result) => onMergeTurnEnd(projectId, nodeId, result, mergeEntry).catch(() => {}),
          (error) => finishFailure(projectId, nodeId, error, mergeEntry).catch(() => {}),
        );
        return { node: store.getNode(projectId, nodeId), revision: store.getProject(projectId).revision };
      }
      const activation = await ctx.subagents.startActivation({
        provider: 'spawn',
        label: `mir/${project.id}/${node.id}`,
        delivery: 'caller',
        signal: lifetime.signal,
        childId: startingEntry.sessionId,
        request: {
          parent: anchor,
          cwd: node.git.worktreePath,
          prompt: [{ type: 'text', text: workerPrompt(project, node, selection, remotePrompt) }],
          agentPreset: 'lab-worker',
          agentOptions: selectionToAgentOptions(selection),
          outputSchema: NODE_REPORT_SCHEMA,
        },
      });
      const activeEntry = await registerActivation(startingEntry, activation);
      seedNodeSandbox(activeEntry.sessionId, project, node);
      const child = ctx.agents.get(activeEntry.sessionId);
      const childCwd = child?.session?.header?.cwd;
      if (childCwd !== undefined && !sameFsPath(childCwd, node.git.worktreePath)) {
        await terminate(projectId, nodeId, 'failure', {
          message: `sandbox boundary mismatch: ${childCwd} != ${node.git.worktreePath}`, expectedEntry: activeEntry,
        });
        throw new LabError('sandbox_mismatch', 'worker session cwd does not equal the node worktree', 409);
      }
      activation.result.then(
        (result) => finish(projectId, nodeId, result, activeEntry).catch(() => {}),
        (error) => finishFailure(projectId, nodeId, error, activeEntry).catch(() => {}),
      );
      return { node: store.getNode(projectId, nodeId), revision: project.revision };
    } catch (error) {
      const failed = await claimEntry(projectId, nodeId, 'finishing', { expected: startingEntry, allowStarting: true });
      if (failed) {
        try {
          await failStart(store.getProject(projectId), node, error);
          await disposeActivation(failed);
          await disposeAnchor({ anchorSessionId: startingEntry.anchorSessionId });
        } finally {
          forgetEntry(failed);
        }
      }
      throw error;
    }
  }

  async function finishFailure(projectId, nodeId, error, expected) {
    const entry = await claimEntry(projectId, nodeId, 'finishing', { expected });
    if (!entry) return;
    const project = store.getProject(projectId);
    const node = store.getNode(projectId, nodeId);
    try {
      if (node && entry.external) {
        node.executionRun = {
          ...(node.executionRun ?? {}), status: 'failed', endedAt: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        };
      }
      if (project && node) await failNode(project, node, error, 'run');
    } finally {
      await disposeActivation(entry);
      if (node) await disposeAnchor({ anchorSessionId: entry.anchorSessionId });
      forgetEntry(entry);
    }
  }

  async function terminate(projectId, nodeId, kind, payload = {}) {
    const entry = await claimEntry(projectId, nodeId, 'terminating', {
      expected: payload.expectedEntry, deadlineAt: payload.expectedDeadlineAt, allowStarting: true,
    });
    if (!entry) return null;
    try {
      const requestedAt = Date.now();
      const child = ctx.agents.get(entry.sessionId);
      if (child && typeof child.cancel === 'function') {
        try {
          child.cancel({ kind: 'parent' });
        } catch {
          // cancellation is cooperative
        }
      }
      // Activation disposal escalates if the child ignores the first cancel.
      await disposeActivation(entry, 8000);
      if (entry.external) {
        try {
          entry.node.executionRun = {
            ...(entry.node.executionRun ?? {}),
            status: kind === 'cancel' ? 'cancelled' : 'terminated',
            endedAt: Date.now(),
            termination: kind,
          };
        } catch {
          // status is best-effort
        }
      }
      const killedJobs = await killSessionJobs(entry.sessionId);
      const reaped = await reapWorktree(entry.node.git.worktreePath);
      const gpu = await checkGpu(reaped.killedPids);

      const project = store.getProject(projectId);
      const node = store.getNode(projectId, nodeId);
      if (project && node) {
        if (entry.external) {
          node.executionRun = {
            ...(node.executionRun ?? entry.node.executionRun ?? {}),
            status: kind === 'cancel' ? 'cancelled' : 'terminated',
            endedAt: Date.now(),
            termination: kind,
          };
        }
        try {
          const commit = await git.commitWorktree(project, node, `dshex(${node.id}): ${node.title} (${kind})`);
          node.git.headCommit = commit.head;
        } catch {
          // best-effort
        }
        await releaseNode(project, node);
        applyUsage(project, node, await sessionUsage(entry.sessionId));
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
      pendingFollowUps.delete(entry.sessionId);
      await disposeAnchor({ anchorSessionId: entry.anchorSessionId });
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
    } finally {
      forgetEntry(entry);
    }
  }

  async function cancel(projectId, nodeId) {
    const project = requireProject(projectId);
    const node = requireNode(projectId, nodeId);
    const key = keyOf(projectId, nodeId);
    if (active.has(key)) {
      const result = await terminate(projectId, nodeId, 'cancel');
      if (result) return result;
      throw new LabError('node_not_cancellable', 'node is already finishing or terminating', 409);
    }
    if (node.status !== 'planned') {
      throw new LabError('node_not_cancellable', `node ${nodeId} is ${node.status}`, 409);
    }
    await store.withProjectLock(projectId, async () => {
      const current = requireNode(projectId, nodeId);
      if (current.status !== 'planned' || active.has(key)) {
        throw new LabError('node_not_cancellable', 'node is no longer planned; retry cancellation against its active runtime', 409);
      }
      current.status = 'cancelled';
      current.timestamps = { ...(current.timestamps ?? {}), completedAt: Date.now() };
      await persistNode(project, current, 'node/cancelled', { data: { kind: 'planned' } });
    });
    return { node: store.getNode(projectId, nodeId), revision: project.revision };
  }

  async function completeFollowUp(pending, reasonKind) {
    const entry = await claimEntry(pending.projectId, pending.nodeId, 'finishing', { expected: pending.entry });
    if (!entry) return;
    const project = store.getProject(pending.projectId);
    const node = store.getNode(pending.projectId, pending.nodeId);
    if (!project || !node) { forgetEntry(entry); return; }
    try {
      if (reasonKind !== 'completed') {
        const error = new Error(`follow-up turn ended: ${reasonKind}`);
        error.stage = 'run';
        throw error;
      }
      node.cleanup = await cleanupNodeRuntime(node);
      const commit = await git.commitWorktree(project, node, `dshex(${node.id}): ${node.title} (follow-up)`);
      node.git.headCommit = commit.head;
      node.report = null;
      node.reportText = await lastAssistantText(node.sessionId);
      node.reportSource = 'followUp';
      node.reportUpdatedAt = Date.now();
      delete node.review;
      applyUsage(project, node, await sessionUsage(node.sessionId));
      const record = node.followUps?.[pending.historyIndex];
      if (record) Object.assign(record, { completedAt: Date.now(), assistant: node.reportText, headCommit: commit.head });
      node.status = 'completed';
      node.error = undefined;
      await releaseNode(project, node);
      node.timestamps = { ...(node.timestamps ?? {}), completedAt: Date.now(), lastActivityAt: Date.now() };
      await persistNode(project, node, 'node/completed', { data: { headCommit: commit.head, followUp: true } });
    } catch (error) {
      await failNode(project, node, error, 'run');
    } finally {
      await disposeActivation(entry);
      await disposeAnchor({ anchorSessionId: entry.anchorSessionId });
      forgetEntry(entry);
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
    if (!isDshExecution(guardNode.execution)) {
      throw new LabError(
        'not_continuable',
        'this node uses an external one-shot execution profile and cannot receive follow-up messages',
        409,
      );
    }
    if (cluster?.enabled && Number(guardNode.needs?.gpu ?? 0) > 0) {
      throw new LabError(
        'gpu_followup_requires_attempt',
        'GPU nodes in cluster mode cannot be continued in place (no GPU lease would be held); use retry/escalate to start a new attempt with a lease',
        409,
      );
    }

    let pending;
    await store.withProjectLock(projectId, async () => {
      const project = requireProject(projectId);
      const node = requireNode(projectId, nodeId);
      const key = keyOf(projectId, nodeId);
      const previous = active.get(key);
      const isLiveMerge = node.kind === 'merge' && node.status === 'running';
      const allowed = node.status === 'completed' || (options.allowFailed === true && node.status === 'failed') || isLiveMerge;
      if (!allowed) throw new LabError('node_not_continuable', 'node is not available for follow-up', 409);
      if (previous && (!isLiveMerge || previous.phase !== 'idle')) {
        throw new LabError('node_not_continuable', 'node is starting, finishing or already processing a turn; try again shortly', 409);
      }
      if (isLiveMerge && (!previous || node.deadlineAt <= Date.now())) {
        throw new LabError('node_not_continuable', 'merge deadline elapsed or runtime is unavailable', 409);
      }
      if (isSealed(projectId, nodeId)) throw new LabError('node_sealed', 'node already has successors and is sealed', 409);
      if (!isLiveMerge) {
        ensureCapacity(project, node);
        node.status = 'running';
        node.resourcesHeld = Object.fromEntries(Object.entries(node.needs ?? {}).filter(([key]) => key !== 'machines'));
        node.deadlineAt = Date.now() + (node.timeboxMs ?? project.config.nodeTimeoutMinutes * 60_000);
      }
      node.followUps = [...(node.followUps ?? []), {
        at: Date.now(), user: trimmed,
        previousReport: structuredClone(node.report ?? null),
        previousReportText: node.reportText ?? '',
        previousReportSource: node.reportSource ?? null,
        previousReportUpdatedAt: node.reportUpdatedAt ?? null,
      }];
      node.report = null;
      node.reportText = '';
      delete node.reportSource;
      delete node.reportUpdatedAt;
      delete node.review;
      delete node.error;
      delete node.termination;
      delete node.cleanup;
      node.timestamps = { ...(node.timestamps ?? {}), lastActivityAt: Date.now() };
      await persistNode(project, node, 'node/resumed', { data: { text: trimmed.slice(0, 200), retry: options.allowFailed === true } });
      const entry = {
        projectId, nodeId, project, node, sessionId: node.sessionId, phase: 'running',
        mode: node.kind === 'merge' ? 'merge' : 'followUp',
        anchorSessionId: node.anchorSessionId,
        activation: previous?.activation ?? null,
      };
      active.set(key, entry);
      pending = {
        sessionId: node.sessionId, projectId, nodeId, mode: entry.mode, entry, historyIndex: node.followUps.length - 1,
        correlation: { messageId: null, claim: null, claims: new Map(), ends: [], completing: false },
      };
      pendingFollowUps.set(node.sessionId, pending);
      deadlines.set(key, node.deadlineAt);
    });
    try {
      const project = requireProject(projectId);
      const node = requireNode(projectId, nodeId);
      const anchor = await resumeAnchor(project, node);
      if (active.get(keyOf(projectId, nodeId)) !== pending.entry || pending.entry.phase !== 'running') {
        throw new LabError('node_not_continuable', 'follow-up was cancelled before delivery', 409);
      }
      const messageId = await ctx.subagents.sendMessage(anchor, node.sessionId, [{ type: 'text', text: followUpPrompt(node, trimmed) }], { signal: lifetime.signal });
      if (isPendingCurrent(pending) && typeof messageId === 'string' && messageId.length > 0) {
        pending.correlation.messageId = messageId;
        pending.correlation.claim = pending.correlation.claims.get(messageId) ?? null;
        pending.correlation.claims.clear();
        await completeCorrelatedFollowUp(pending);
      }
    } catch (error) {
      await finishFailure(projectId, nodeId, error, pending.entry);
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
    const project = requireProject(projectId);
    const node = requireNode(projectId, nodeId);
    if (node.kind !== 'merge') throw new LabError('not_a_merge_node', 'node is not a merge node', 409);
    const entry = await claimEntry(projectId, nodeId, 'finishing');
    if (!entry) throw new LabError('node_not_mergeable', 'merge is starting, finishing, terminating or no longer running', 409);
    try {
      try { ctx.agents.get(node.sessionId)?.cancel?.({ kind: 'parent' }); } catch { /* best effort */ }
      await disposeActivation(entry, 8000);
      node.cleanup = await cleanupNodeRuntime(node);
      const result = await git.finishMergeInWorktree(node.git.worktreePath, `dshex(${node.id}): merge ${node.parentIds.join(' + ')}`);
      node.git.headCommit = result.head;
      node.merge = { ...(node.merge ?? {}), state: 'committed', committedAt: Date.now(), committedBy: 'human', headCommit: result.head };
      node.status = 'completed';
      // Human completion confirms a git merge, not experimental success/metrics.
      node.report = null;
      node.reportText = [
        typeof payload.summary === 'string' ? payload.summary.trim().slice(0, 8000) : '',
        typeof payload.message === 'string' && payload.message.trim() ? payload.message.trim().slice(0, 8000) : (node.lastReport ?? ''),
      ].filter(Boolean).join('\n');
      node.reportSource = 'merge';
      node.reportUpdatedAt = Date.now();
      delete node.review;
      applyUsage(project, node, await sessionUsage(node.sessionId));
      endAttempt(node, { stopReason: 'completed', status: 'completed' });
      await releaseNode(project, node);
      node.timestamps = { ...(node.timestamps ?? {}), completedAt: Date.now(), lastActivityAt: Date.now() };
      await persistNode(project, node, 'node/completed', {
        data: { kind: 'merge', headCommit: result.head, committed: result.committed, cleanup: node.cleanup ?? null },
      });
    } catch (error) {
      if (node.status === 'running') {
        await store.withProjectLock(projectId, async () => {
          if (active.get(keyOf(projectId, nodeId)) === entry) {
            entry.phase = 'idle';
            deadlines.set(keyOf(projectId, nodeId), node.deadlineAt);
          }
        });
      }
      throw error;
    } finally {
      if (node.status !== 'running') {
        await disposeAnchor({ anchorSessionId: entry.anchorSessionId });
        forgetEntry(entry);
      }
    }
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

  function isPendingCurrent(pending) {
    return pendingFollowUps.get(pending.sessionId) === pending
      && active.get(keyOf(pending.projectId, pending.nodeId)) === pending.entry
      && pending.entry.phase === 'running';
  }

  // All caches belong to one live pending delivery, contain correlation metadata
  // only, and are bounded. Receipt, claim and end can arrive in any order.
  const pendingCorrelationLimit = 32;

  async function completeCorrelatedFollowUp(pending) {
    const correlation = pending.correlation;
    if (!isPendingCurrent(pending) || correlation.completing || correlation.messageId === null || correlation.claim === null) return;
    const end = correlation.ends.find((item) => item.turn === correlation.claim.turn && item.session === correlation.claim.session);
    if (!end) return;
    correlation.completing = true;
    correlation.claims.clear();
    correlation.ends.length = 0;
    const reasonKind = end.reasonKind;
    if (pending.mode === 'merge') {
      if (reasonKind !== 'completed') {
        await finishFailure(pending.projectId, pending.nodeId, new Error(`merge follow-up ended: ${reasonKind}`), pending.entry);
        return;
      }
      const text = await lastAssistantText(pending.sessionId);
      await onMergeTurnEnd(pending.projectId, pending.nodeId, { stopReason: reasonKind, output: [{ type: 'text', text }] }, pending.entry);
      if (pendingFollowUps.get(pending.sessionId) === pending) pendingFollowUps.delete(pending.sessionId);
      return;
    }
    await completeFollowUp(pending, reasonKind);
  }

  async function onInboxClaimed(payload) {
    const sessionId = payload?.agent?.id;
    const session = payload?.agent?.session;
    const messageId = payload?.message?.id;
    const turn = payload?.turn;
    const pending = pendingFollowUps.get(sessionId);
    if (!pending || !isPendingCurrent(pending) || !session || session.id !== sessionId
      || typeof messageId !== 'string' || !messageId.length || !Number.isFinite(turn)) return;
    const correlation = pending.correlation;
    if (correlation.completing) return;
    if (correlation.messageId !== null) {
      if (correlation.messageId !== messageId) return;
      correlation.claim ??= { turn, session };
    } else if (!correlation.claims.has(messageId)) {
      correlation.claims.set(messageId, { turn, session });
      if (correlation.claims.size > pendingCorrelationLimit) correlation.claims.delete(correlation.claims.keys().next().value);
    }
    await completeCorrelatedFollowUp(pending);
  }

  async function onSessionEvent(session, event) {
    if (event?.type !== 'turn/end' || !Number.isFinite(event?.data?.turn)) return;
    const pending = pendingFollowUps.get(session?.id);
    if (!pending || !isPendingCurrent(pending) || pending.correlation.completing) return;
    const correlation = pending.correlation;
    const turn = event.data.turn;
    if (correlation.claim && (correlation.claim.turn !== turn || correlation.claim.session !== session)) return;
    if (!correlation.ends.some((item) => item.turn === turn && item.session === session)) {
      correlation.ends.push({ session, turn, reasonKind: event?.data?.reason?.kind ?? 'unknown' });
      if (correlation.ends.length > pendingCorrelationLimit) correlation.ends.shift();
    }
    await completeCorrelatedFollowUp(pending);
  }

  const leaseRenewedAt = new Map();
  const leasePumping = new Set();

  async function renewLeases() {
    if (!cluster?.enabled) return;
    const now = Date.now();
    for (const [key, entry] of active.entries()) {
      if (!['running', 'idle'].includes(entry.phase)) continue;
      const node = store.getNode(entry.projectId, entry.nodeId);
      const lease = node?.lease;
      if (!lease?.leaseId) continue;
      const last = leaseRenewedAt.get(key) ?? 0;
      if (now - last < cluster.heartbeatMs) continue;
      leaseRenewedAt.set(key, now);
      try {
        const renewed = await cluster.renew(lease.leaseId, Math.max(0, node.deadlineAt - Date.now()) + 120_000);
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
    try {
      await renewLeases();
    } catch {
      // renewLeases handles per-lease failures
    }
    for (const [key, deadlineAt] of [...deadlines.entries()]) {
      if (Date.now() < deadlineAt) continue;
      const entry = active.get(key);
      if (!entry) continue;
      await terminate(entry.projectId, entry.nodeId, 'timeout', {
        expectedEntry: entry, expectedDeadlineAt: deadlineAt,
        message: 'node exceeded its deadline and was terminated deterministically',
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
        ctx.agents.get(entry.sessionId)?.cancel?.({ kind: 'parent' });
      } catch {
        // ignore
      }
      try {
        Promise.resolve(entry.activation?.dispose?.()).catch(() => {});
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
    updateTimebox,
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
    ensureAnchor,
    onSessionEvent,
    onInboxClaimed,
    dispose,
  };
}
