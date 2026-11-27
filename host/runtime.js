/**
 * M2 runtime: one worker activation per node, per-node anchor Agent, worktree
 * lifecycle, deterministic timeout watchdog + process reaper, follow-up messages.
 *
 * The runtime owns session/agent handles (memory only); durable node state lives in
 * the ProjectStore. Killing on timeout is plain Host code — never an Agent.
 */
import { readFile, readdir, readlink } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
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
import { holdsResources, sandboxAdmissionBlock } from './sandbox-state.js';
import { isDispatchableClass } from './kernel/priority.js';
import { ExecutionLog, executionLogPath } from './execution-log.js';
import { newSessionId } from './store.js';
import { startActivation } from './subagent-compat.js';
import { prepareRemoteRun } from './remote-run.js';
import { DEFAULT_MERGE_PROMPT, DEFAULT_WORKER_PREFIX, WORKER_RULES } from './prompts.js';
import { applyPredictionToNode } from './kernel/prediction.js';
import { failureCode, failureDiagnostic, failureMessage } from './failure.js';
import { assertModelSchema } from './schema-check.js';
import { isNonBlockingSuccessor } from './kernel/runnable.js';

/** JSON schema accepted by DSH's structured-output tool (supported subset only). */
export const NODE_REPORT_SCHEMA = {
  type: 'object',
  properties: {
    // Source limit (B26/D16): the report is durable, so bound the summary at
    // write time. Detail belongs in changes/metrics/reproduce, not one blob.
    // Length is enforced by normalizeNodeReport, not by the schema: the DSH
    // structured-output subset rejects minLength/maxLength keywords outright.
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
    // Disk policy contract: every produced artifact is declared with its size so
    // the Host can flag oversized outputs instead of discovering them at commit time.
    artifacts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          sizeBytes: { type: 'number' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'changes', 'metrics', 'reproduce', 'success', 'blockers', 'next', 'risks'],
  additionalProperties: false,
};


/** Report field bounds: durable records must not grow without a source limit. */
export const REPORT_LIMITS = Object.freeze({
  summary: 500,
  headline: 300,
  listItems: 200,
  listItemChars: 2_000,
});

/**
 * Normalise a structured report before it is persisted.
 *
 * The JSON schema rejects an over-long summary, but remote/external execution
 * drivers do not go through DSH's structured-output validator, so the Host
 * enforces the same bound here. `headline` is derived by the Host (never by the
 * model) and is the only field the state index keeps.
 */
export function normalizeNodeReport(report) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) return null;
  const summary = typeof report.summary === 'string' ? report.summary.trim().slice(0, REPORT_LIMITS.summary) : '';
  if (!summary) return null;
  const clampList = (value) => (Array.isArray(value)
    ? value
      .filter((item) => typeof item === 'string' && item.trim())
      .slice(0, REPORT_LIMITS.listItems)
      .map((item) => item.trim().slice(0, REPORT_LIMITS.listItemChars))
    : []);
  const metrics = Array.isArray(report.metrics)
    ? report.metrics
      .filter((item) => item && typeof item === 'object' && typeof item.name === 'string')
      .slice(0, REPORT_LIMITS.listItems)
      .map((item) => ({ name: String(item.name).slice(0, 120), value: String(item.value ?? '').slice(0, 200), unit: String(item.unit ?? '').slice(0, 40) }))
    : [];
  const headline = typeof report.headline === 'string' && report.headline.trim()
    ? report.headline.trim().slice(0, REPORT_LIMITS.headline)
    : summary.slice(0, REPORT_LIMITS.headline);
  const artifacts = Array.isArray(report.artifacts)
    ? report.artifacts
      .filter((item) => item && typeof item === 'object' && typeof item.path === 'string' && item.path.trim())
      .slice(0, 50)
      .map((item) => ({
        path: String(item.path).trim().slice(0, 300),
        sizeBytes: Number.isFinite(Number(item.sizeBytes)) ? Math.max(0, Math.trunc(Number(item.sizeBytes))) : null,
      }))
    : [];
  return {
    artifacts,
    summary,
    headline,
    changes: clampList(report.changes),
    metrics,
    reproduce: clampList(report.reproduce),
    success: report.success === true,
    blockers: clampList(report.blockers),
    next: clampList(report.next),
    risks: clampList(report.risks),
  };
}

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

/** Session events that mean a running turn is still making progress (K8/1.3). */
export const ACTIVITY_EVENT_TYPES = Object.freeze([
  'turn/start',
  'assistant/message',
  'tool/call',
  'tool/use',
  'tool/result',
  'reasoning/message',
  'step/start',
  'step/end',
]);

/** Minimum spacing between durable activity writes for one node, per turn. */
export const ACTIVITY_WRITE_INTERVAL_MS = 30_000;

/** True for assistant chunks, tool calls/results, reasoning and step boundaries. */
export function isTurnActivityEvent(event) {
  const type = typeof event?.type === 'string' ? event.type : '';
  if (!type || type === 'turn/end') return false;
  return ACTIVITY_EVENT_TYPES.includes(type)
    || type.startsWith('step/')
    || type.startsWith('tool/')
    || type.startsWith('assistant/')
    || type.startsWith('reasoning/');
}

/** The turn id is only used to let the first event of a new turn bypass throttle. */
export function turnIdOf(event) {
  const data = event?.data;
  return data?.turnId ?? data?.turn?.id ?? event?.turnId ?? null;
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
const WIP_CHECKPOINT_MS = 10 * 60_000;

export function createRuntime({ ctx, store, git, onTerminated, cluster, kernel, sandboxFactory, sandboxBackend, sandboxAdmission, hostAdmission }) {
  const active = new Map(); // key -> entry
  const deadlines = new Map(); // key -> epoch ms
  const pendingFollowUps = new Map(); // sessionId -> pending record
  const anchorHandles = new Map(); // sessionId -> AgentHandle
  const lifetime = new AbortController();
  const sandboxRuntime = sandboxFactory ? sandboxFactory({ ctx, store, kernel, git,
    backend: sandboxBackend, admission: sandboxAdmission, onTerminated,
    worker: { select: (project, node) => resolveNodeSelection(project, node, 'worker'),
      options: selectionToAgentOptions, schema: NODE_REPORT_SCHEMA, normalize: normalizeNodeReport,
      anchor: ensureAnchor, releaseAnchor: disposeAnchor, usage: sessionUsage } }) : null;

  function needsSandbox(node) {
    return Boolean(node && ((node.execution && Object.hasOwn(node.execution, 'sandboxProfile'))
      || node.sandbox?.backend === 'opensandbox' || node.admission?.broker === 'sandbox-admission' || node.sandboxGate));
  }
  function sandboxLane() {
    if (!sandboxRuntime) throw new LabError('sandbox_unavailable', 'Sandbox execution is not connected; do not run this node locally.', 409);
    return sandboxRuntime;
  }
  function rejectSandboxOperation(node, action) {
    if (needsSandbox(node)) throw new LabError('sandbox_not_supported', `Sandbox ${action} is not supported; use an explicitly isolated successor after cleanup.`, 409);
  }
  async function retrySandbox(projectId, nodeId, options) {
    if (options.model || options.upgrade === true) throw new LabError('sandbox_not_supported', 'Sandbox model escalation is not supported in place.', 409);
    await store.withProjectLock(projectId, async () => {
      const project = structuredClone(requireProject(projectId)), node = structuredClone(requireNode(projectId, nodeId));
      if (!['failed', 'cancelled'].includes(node.status)) throw new LabError('node_not_retryable', 'Sandbox retry requires a failed or cancelled node.', 409);
      const binding = node.sandbox;
      if (sandboxAdmissionBlock(node) || node.admission || node.claim
        || (binding && (binding.verifiedClean !== true || !['released', 'noCapacity'].includes(binding.state)))) {
        throw new LabError('sandbox_held', 'Sandbox result or cleanup is unresolved; reconcile it before retry.', 409);
      }
      if (Number.isInteger(options.expectedRevision) && options.expectedRevision !== project.revision) throw new LabError('stale_basis', 'project revision changed since authorization', 409);
      const basis = node.rev ?? 0;
      node.status = 'planned'; node.deadlineAt = null; node.report = null;
      delete node.error; delete node.termination; delete node.resourcesHeld; delete node.resourceWait;
      node.timestamps = { ...(node.timestamps ?? {}), lastActivityAt: Date.now() };
      const result = await store.withWritePermit(() => kernel.executor.commitLocked(projectId, {
        actor: { kind: 'system', id: 'sandbox-retry' }, expectedProjectRevision: project.revision, basis,
        mutations: [{ op: 'node.put', nodeId, node, eventType: 'node/retried', eventData: { freshSandboxAttemptRequired: true } }],
      }));
      if (!result.ok) throw new LabError(result.code ?? 'commit_failed', result.message ?? 'Sandbox retry commit failed', 409);
    });
    return sandboxLane().start(projectId, nodeId, options);
  }

  // The optional Host-budget lane owns its handles, not a second durable store.
  // Legacy callers below are unchanged when hostAdmission is absent.
  const hostCopy = structuredClone;
  const hostScope = node => ({
    currentAttempt: node.currentAttempt ?? 0, sessionId: node.sessionId, anchorSessionId: node.anchorSessionId,
    execution: node.execution, needs: node.needs, timeboxMs: node.timeboxMs,
    worktreePath: node.git?.worktreePath, branch: node.git?.branch,
    lease: node.lease, claim: node.claim, admission: node.admission,
    reservationId: node.hostBudgetReservation?.reservationId ?? node.hostBudgetReservation?.id,
  });
  function hostNode(entry, released = false) {
    const node = hostCopy(requireNode(entry.projectId, entry.nodeId));
    const scope = hostScope(node), expected = hostCopy(entry.owner);
    if (released) {
      for (const field of ['lease', 'claim', 'admission']) {
        if (node[field] !== undefined) throw new LabError('host_budget_held', 'Host owner changed after cleanup', 409);
        delete scope[field]; delete expected[field];
      }
      if (node.resourcesHeld !== undefined) throw new LabError('host_budget_held', 'Host resources remain held', 409);
    }
    if (needsSandbox(node) || !isDeepStrictEqual(scope, expected)) {
      throw new LabError('host_budget_held', 'Host admission owner changed', 409);
    }
    return node;
  }
  function hostLive(entry) {
    const node = hostNode(entry);
    if (node.status !== 'running' || !['preparing', 'running', 'idle', 'finishing'].includes(entry.phase)) {
      throw new LabError('host_budget_held', 'Host attempt is no longer executable', 409);
    }
    if (Date.now() >= node.deadlineAt) throw new LabError('host_deadline', 'Host admission deadline elapsed', 409);
    return node;
  }
  function hostResult(entry, status, code) {
    return { node: hostCopy(requireNode(entry.projectId, entry.nodeId)), revision: requireProject(entry.projectId).revision,
      startOutcome: { status, attempt: entry.owner.currentAttempt, sessionId: entry.owner.sessionId ?? null,
        ...(status === 'held' ? { retryable: false, code } : {}) } };
  }
  async function hostChange(entry, eventType, change, options = {}) {
    const priorStatus = hostNode(entry).status, phase = entry.phase;
    let written;
    await store.withProjectLock(entry.projectId, async () => {
      const project = hostCopy(requireProject(entry.projectId)), node = hostNode(entry);
      if (node.status !== priorStatus || entry.phase !== phase) throw new LabError('host_budget_held', 'Host lifecycle changed while waiting for the project lock', 409);
      if (Number.isInteger(options.expectedRevision) && options.expectedRevision !== project.revision) throw new LabError('stale_basis', 'project revision changed since authorization', 409);
      const basis = node.rev ?? 0;
      change(node, project);
      written = hostCopy(node);
      const mutations = [{ op: 'node.put', nodeId: node.id, node, eventType, ...(options.data ? { eventData: options.data } : {}) }];
      if (options.cleaned) mutations.push({ op: 'event.record', nodeId: node.id, type: 'node/host_budget_cleaned', eventType: 'node/host_budget_cleaned', data: node.hostBudgetCleanup });
      const result = await store.withWritePermit(() => kernel.executor.commitLocked(entry.projectId, {
        actor: { kind: 'system', id: 'host-runtime' }, expectedProjectRevision: project.revision, basis, mutations, ...(options.causeId ? { causeId: options.causeId } : {}),
      }));
      if (result.ok !== true) throw new LabError(result.code ?? 'commit_failed', result.message ?? 'Host runtime commit failed', 409);
    });
    return written;
  }
  async function hostDisposeHandles(entry) {
    if (entry.wipTimer) { clearInterval(entry.wipTimer); entry.wipTimer = null; }
    const activation = entry.activation; entry.activation = null;
    try { await activation?.dispose?.(); } finally { await disposeAnchor({ anchorSessionId: entry.owner.anchorSessionId }); }
  }
  async function hostTerminal(entry, status, details = {}) {
    const requestedAt = details.requestedAt ?? Date.now(), payload = details.preemptionPayload ?? {};
    const preemption = details.kind === 'preempted' ? { at: requestedAt, by: payload.by ?? 'dispatcher',
      forNodeId: payload.forNodeId ?? null, reason: payload.reason ?? 'higher-priority work needed this slot',
      causeId: payload.causeId ?? `preempt:${entry.nodeId}:${requestedAt}`,
      appeal: { status: 'open', deadlineAt: Date.now() + 24 * 60 * 60_000, endpoint: '/api/metainfer-research-lab/preemption/appeal' } } : null;
    let cleanup = details.cleanup;
    hostNode(entry);
    if (!cleanup) {
      try { cleanup = await cleanupNodeRuntime(hostNode(entry)); }
      catch (error) { cleanup = { verifiedClean: false, leftover: [failureMessage(error)] }; }
    }
    hostNode(entry);
    let released = false;
    try { released = (await hostAdmission.release(entry.projectId, entry.nodeId, hostCopy(entry.rawAdmissionLease)))?.released === true; }
    catch { /* An unconfirmed raw release must retain all durable ownership. */ }
    hostNode(entry);
    const clean = cleanup.verifiedClean === true && released;
    // Disk policy enforcement (after-the-fact): flag a node that left oversized
    // untracked files in its worktree so a human can inspect/clean before the next
    // node copies them around. The commit guard already refuses to add >maxFileMb
    // files to history.
    let diskWarning = null;
    try {
      const project = requireProject(entry.projectId);
      const policy = project.config?.diskPolicy ?? {};
      const maxUntrackedMb = Number(policy.maxUntrackedMb ?? 200);
      const maxFileMb = Number(policy.maxFileMb ?? 100);
      const files = typeof git?.untrackedFiles === 'function' ? await git.untrackedFiles(hostLive(entry).git.worktreePath) : [];
      const totalBytes = files.reduce((sum, file) => sum + Number(file.size ?? 0), 0);
      const largest = files.reduce((max, file) => (Number(file.size ?? 0) > Number(max?.size ?? 0) ? file : max), null);
      const tooMuch = maxUntrackedMb > 0 && totalBytes > maxUntrackedMb * 1024 * 1024;
      const tooBig = maxFileMb > 0 && largest !== null && Number(largest.size) > maxFileMb * 1024 * 1024;
      if (tooMuch || tooBig) {
        diskWarning = {
          at: Date.now(),
          untrackedBytes: totalBytes,
          untrackedFiles: files.length,
          largestFile: largest ? { path: largest.path, sizeBytes: Number(largest.size) } : null,
          maxUntrackedMb,
          maxFileMb,
        };
      }
    } catch { /* the warning is best effort and must never mask the terminal status */ }
    if (status !== 'completed' && details.stage === 'timeout') {
      // Preserve whatever the worker produced before a timebox expiry is recorded.
      // Other failures keep the old contract: never commit on a tree whose branch
      // may have been changed by the worker.
      try {
        const live = hostLive(entry);
        await git.commitWorktree(requireProject(entry.projectId), live, `wip(${live.id}): checkpoint before ${status}`);
      } catch { /* best effort: never mask the terminal status */ }
    }
    await hostChange(entry, preemption ? 'node/preempted' : status === 'completed' ? 'node/completed' : status === 'cancelled' ? 'node/cancelled' : 'node/failed', (n, project) => {
      if (!['planned', 'running'].includes(n.status)) throw new LabError('host_budget_held', 'Host attempt is already terminal', 409);
      if (status === 'completed') {
        hostLive(entry); n.report = details.report; n.reportText = details.reportText ?? '';
        if (details.head) n.git.headCommit = details.head;
        if (details.merge) n.merge = details.merge;
        applyPredictionToNode(n);
      } else { n.report = null; }
      n.status = status; n.cleanup = cleanup;
      if (details.error) n.error = failureDiagnostic(n, details.stage ?? 'run', details.error); else delete n.error;
      if (details.kind) n.termination = { ...cleanup, kind: details.kind, requestedAt, killedAt: Date.now() };
      if (preemption) n.preemption = preemption;
      if (details.usage) applyUsage(project, n, details.usage);
      if (diskWarning !== null) n.diskWarning = diskWarning;
      endAttempt(n, { status, stopReason: status, ...(details.error ? { error: failureMessage(details.error) } : {}) });
      n.timestamps = { ...(n.timestamps ?? {}), completedAt: Date.now(), lastActivityAt: Date.now() };
      if (clean) {
        for (const field of ['claim', 'admission', 'resourcesHeld', 'lease', 'hostBudgetGate']) delete n[field];
        n.deadlineAt = null;
        n.hostBudgetCleanup = { attempt: n.currentAttempt, sessionId: n.sessionId, verifiedClean: true, at: Date.now() };
      }
    }, { cleaned: clean, ...(diskWarning !== null ? { data: { diskWarning } } : {}), ...(preemption ? { causeId: preemption.causeId, data: { kind: 'preempted', preemption, ...(diskWarning !== null ? { diskWarning } : {}) } } : {}) });
    let final = { released: false, held: true };
    if (clean) {
      hostNode(entry, true);
      try { final = await hostAdmission.finalize(entry.projectId, entry.nodeId); } catch { /* Budget remains held. */ }
    }
    if (final?.released !== true) return hostResult(entry, 'held', 'HOST_CLEANUP_UNCONFIRMED');
    return { node: hostCopy(requireNode(entry.projectId, entry.nodeId)), revision: requireProject(entry.projectId).revision };
  }
  function hostEnd(entry, kind, payload = {}) {
    if (Number.isInteger(payload.expectedRevision) && payload.expectedRevision !== requireProject(entry.projectId).revision) throw new LabError('stale_basis', 'project revision changed since authorization', 409);
    if (entry.terminating) return entry.terminating;
    const current = requireNode(entry.projectId, entry.nodeId);
    if (entry.done && current.currentAttempt === entry.owner.currentAttempt && current.sessionId === entry.owner.sessionId && !['planned', 'running'].includes(current.status)) return entry.done;
    const requestedAt = Date.now();
    entry.phase = 'terminating'; entry.controller.abort();
    entry.terminating = (async () => {
      try {
        await hostDisposeHandles(entry); hostNode(entry);
        const cancelled = ['cancel', 'dispose', 'preempted', 'requeue'].includes(kind);
        return await hostTerminal(entry, cancelled ? 'cancelled' : 'failed', { kind, requestedAt, preemptionPayload: payload, stage: kind === 'timeout' ? 'timeout' : 'run', error: payload.message ?? payload.reason ?? (cancelled ? 'cancelled by user' : 'Host attempt terminated') });
      } catch (error) {
        // Never write through a changed owner, including a late release ACK.
        return hostResult(entry, 'held', error.code ?? 'HOST_CLEANUP_UNCONFIRMED');
      } finally {
        await hostDisposeHandles(entry);
        if (active.get(keyOf(entry.projectId, entry.nodeId)) === entry) active.delete(keyOf(entry.projectId, entry.nodeId));
        deadlines.delete(keyOf(entry.projectId, entry.nodeId));
        if (!['cancel', 'dispose', 'preempted', 'requeue'].includes(kind)) await hostAutoUpgrade(entry, kind === 'timeout' ? 'timeout' : 'run');
      }
    })();
    entry.done = entry.terminating;
    return entry.terminating;
  }
  /**
   * L2-2: shrink a running node's reservation in place. Only decreases are
   * accepted (an increase needs a new admission, see requeueWithNeeds); the
   * freed quota is immediately visible to capacity/compute pickers because the
   * pool is computed from `resourcesHeld`.
   */
  async function shrinkNeeds(projectId, nodeId, needs, reason = 'needs_shrunk') {
    const current = requireNode(projectId, nodeId);
    if (current.status !== 'running') throw new LabError('node_not_running', `node ${nodeId} is ${current.status}`, 409);
    const before = { ...(current.needs ?? {}) };
    const increases = Object.keys(needs ?? {}).some((key) => Number(needs[key] ?? 0) > Number(before[key] ?? 0));
    if (increases) {
      throw new LabError('needs_increase_requires_readmission',
        'needs may only shrink while the node is running; an increase needs a new admission', 409);
    }
    const next = structuredClone(current);
    next.needs = { ...needs };
    // V4-13: the durable Host reservation must move with the new vector. Leaving
    // the old resources behind made snapshot() see two different footprints and
    // report BUDGET_CONFLICT on every later dispatch (free 64 GPUs, nothing
    // started), and identity() rejected replays of the node itself.
    if (next.hostBudgetReservation && typeof next.hostBudgetReservation === 'object') {
      const resources = {};
      for (const [key, value] of Object.entries(next.needs ?? {})) {
        const amount = Number(value ?? 0);
        if (key === 'machines' || !Number.isFinite(amount) || amount <= 0) continue;
        resources[key] = amount;
      }
      next.hostBudgetReservation = { ...next.hostBudgetReservation, resources };
    }
    if (next.resourcesHeld !== undefined) {
      const held = { ...next.resourcesHeld };
      for (const key of Object.keys(held)) {
        const released = Math.max(0, Number(before[key] ?? 0) - Number(needs?.[key] ?? 0));
        // Keep the key at 0 instead of deleting it: release/cleanup paths treat
        // a missing resourcesHeld as "no reservation" and would skip the
        // hand-back of the raw lease.
        held[key] = Math.max(0, Number(held[key] ?? 0) - released);
      }
      next.resourcesHeld = held;
    }
    const result = await kernel.executor.commit(projectId, {
      actor: { kind: 'system', id: 'lease' },
      causeId: `shrink:${nodeId}`,
      ...(Number.isInteger(next.rev) ? { basis: next.rev } : {}),
      mutations: [{ op: 'node.put', nodeId, node: next, eventType: 'node/needs_shrunk',
        eventData: { reason, before, after: next.needs, released: Object.keys(before).filter((key) => Number(before[key] ?? 0) > Number(needs?.[key] ?? 0)) } }],
    });
    if (result.ok !== true) throw new LabError(result.code ?? 'needs_shrink_failed', result.message ?? 'shrink failed', 409);
    return { ok: true, node: hostCopy(requireNode(projectId, nodeId)), revision: requireProject(projectId).revision };
  }

  /**
   * A6/U2: a node can be marked running while no Host attempt exists (a start
   * that died between the running commit and the activation). Nothing can drive
   * it and message_node already reports "No live admitted Host attempt", so the
   * sweep fails it and clears the local ownership instead of letting it hold a
   * slot for the whole timebox.
   */
  async function sweepGhostAttempts(nowMs = Date.now()) {
    const outcomes = [];
    for (const project of store.listProjects()) {
      let ttlMinutes = 30;
      try { ttlMinutes = Number(project.config?.leaseTtlMinutes ?? 30); } catch { ttlMinutes = 30; }
      const ttlMs = Math.max(5, Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes : 30) * 60_000;
      for (const stored of store.listNodes(project.id)) {
        if (stored.status !== 'running') continue;
        if (stored.sandbox || needsSandbox(stored)) continue;
        const key = keyOf(project.id, stored.id);
        if (active.has(key)) continue;
        const last = Number(stored.timestamps?.lastActivityAt ?? stored.timestamps?.startedAt ?? nowMs);
        const idleMs = Math.max(0, nowMs - last);
        if (idleMs < ttlMs) continue;
        const next = structuredClone(stored);
        const attempt = Array.isArray(next.attempts) ? next.attempts[next.attempts.length - 1] : null;
        if (attempt && !attempt.endedAt) { attempt.endedAt = nowMs; attempt.status = 'failed'; attempt.stopReason = 'ghost'; }
        next.status = 'failed';
        next.error = { code: 'ghost_attempt', message: 'node was marked running but no Host attempt exists; the stale ownership was released. Check the worker log and retry.', at: nowMs, stage: 'run' };
        next.deadlineAt = null;
        next.termination = { ...(next.termination ?? {}), kind: 'ghost', requestedAt: nowMs, killedAt: nowMs, verifiedClean: true, leftover: [] };
        delete next.claim;
        delete next.admission;
        delete next.lease;
        delete next.resourcesHeld;
        delete next.hostBudgetReservation;
        delete next.resourceWait;
        delete next.sandboxGate;
        next.timestamps = { ...(next.timestamps ?? {}), completedAt: next.timestamps?.completedAt ?? nowMs, lastActivityAt: nowMs };
        try {
          const result = await kernel.executor.commit(project.id, {
            actor: { kind: 'system', id: 'reaper' },
            causeId: `ghost:${stored.id}`,
            ...(Number.isInteger(next.rev) ? { basis: next.rev } : {}),
            mutations: [{ op: 'node.put', nodeId: stored.id, node: next, eventType: 'node/failed',
              eventData: { stage: 'run', message: next.error.message, ghost: true, idleMs } }],
          });
          if (result.ok === true) outcomes.push({ projectId: project.id, nodeId: stored.id, action: 'freed', idleMs });
        } catch { /* a changed owner is handled by the next sweep */ }
      }
    }
    return outcomes;
  }

  /**
   * L2-3: lease TTL sweep. A running attempt with no recorded activity for two
   * thirds of `config.leaseTtlMinutes` (default 30 -> 20 min) gets one warning;
   * the TTL itself (30 min) releases the reservation (the attempt is terminated
   * as a failure). Sandbox nodes are skipped: their leases belong to the remote
   * backend and need its own expiry.
   */
  async function sweepLeaseTtl(nowMs = Date.now()) {
    const outcomes = [];
    for (const [key, entry] of [...active.entries()]) {
      if (!entry || entry.phase !== 'running') continue;
      let node;
      try { node = hostCopy(requireNode(entry.projectId, entry.nodeId)); } catch { continue; }
      if (node.sandbox || needsSandbox(node)) continue;
      let ttlMinutes = 30;
      try {
        const project = requireProject(entry.projectId);
        ttlMinutes = Number(project.config?.leaseTtlMinutes ?? 30);
      } catch { continue; }
      const ttlMs = ttlMinutes * 60_000;
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) continue;
      // Warn at 2/3 of the TTL and release at the TTL itself (default: 20 min and
      // 30 min), so an idle reservation is reclaimed within one TTL window.
      const warnMs = Math.round(ttlMs * 2 / 3);
      const last = Number(node.timestamps?.lastActivityAt ?? node.timestamps?.startedAt ?? nowMs);
      const idleMs = Math.max(0, nowMs - last);
      if (idleMs < warnMs) continue;
      if (!node.leaseTtlWarning) {
        try {
          await hostChange(entry, 'node/lease_idle_warning', (n) => {
            n.timestamps = { ...(n.timestamps ?? {}), lastActivityAt: n.timestamps?.lastActivityAt ?? nowMs };
            n.leaseTtlWarning = { at: nowMs, idleMs, ttlMs };
          });
          outcomes.push({ projectId: entry.projectId, nodeId: entry.nodeId, action: 'warned', idleMs });
        } catch { /* an owner change is handled by the next sweep */ }
        continue;
      }
      if (idleMs < ttlMs) continue;
      try {
        await hostEnd(entry, 'failure', { message: `lease TTL expired: no activity for ${Math.round(idleMs / 60000)} min; the reservation is released` });
        outcomes.push({ projectId: entry.projectId, nodeId: entry.nodeId, action: 'released', idleMs });
      } catch { /* hostEnd reports its own result */ }
    }
    return outcomes;
  }

  /**
   * Apply new resource needs to a running node by re-admitting it: the current
   * attempt is terminated (audited), the node goes back to planned with the new
   * needs, and the scheduler/admission will acquire the right resources.
   */
  async function requeueWithNeeds(projectId, nodeId, needs, reason = 'needs_changed') {
    const node = requireNode(projectId, nodeId);
    if (node.status !== 'running') throw new LabError('node_not_running', `node ${nodeId} is ${node.status}`, 409);
    const entry = active.get(keyOf(projectId, nodeId));
    if (!entry) throw new LabError('node_not_running', `node ${nodeId} has no live Host attempt to requeue`, 409);
    const ended = await hostEnd(entry, 'requeue', { message: `needs changed to ${JSON.stringify(needs)}; the attempt is requeued`, reason });
    if (ended?.status === 'held') return { ok: false, code: ended.code ?? 'HOST_CLEANUP_UNCONFIRMED', message: 'previous attempt cleanup is unconfirmed; the node stays as it is' };
    const current = requireNode(projectId, nodeId);
    if (!['cancelled', 'failed'].includes(current.status)) {
      throw new LabError('requeue_conflict', `node ${nodeId} changed to ${current.status} while requeueing`, 409);
    }
    const next = structuredClone(current);
    next.status = 'planned';
    next.needs = needs;
    next.deadlineAt = null;
    next.requeued = { at: Date.now(), previousAttempt: current.currentAttempt ?? 0, reason };
    delete next.error;
    delete next.termination;
    delete next.cleanup;
    next.timestamps = { ...(next.timestamps ?? {}), runnableAt: Date.now(), startedAt: null, completedAt: null, lastActivityAt: Date.now() };
    const result = await kernel.executor.commit(projectId, {
      actor: { kind: 'system', id: 'requeue' },
      causeId: `requeue:${nodeId}`,
      ...(Number.isInteger(next.rev) ? { basis: next.rev } : {}),
      mutations: [{ op: 'node.put', nodeId, node: next, eventType: 'node/requeued', eventData: { reason, needs, previousAttempt: next.requeued.previousAttempt } }],
    });
    if (result.ok !== true) throw new LabError(result.code ?? 'requeue_failed', result.message ?? 'requeue failed', 409);
    return { ok: true, node: hostCopy(requireNode(projectId, nodeId)), revision: requireProject(projectId).revision };
  }

  function hostFinish(entry, result, failure, mergePayload) {
    if (entry.done) return entry.done;
    entry.phase = 'finishing';
    entry.done = (async () => {
      try {
        let node = hostLive(entry), project = hostCopy(requireProject(entry.projectId));
        if (failure) throw failure;
        if (result?.stopReason !== 'completed') throw new LabError('worker_incomplete', `worker stopped: ${result?.stopReason}`, 409);
        const report = normalizeNodeReport(mergePayload ? { summary: mergePayload.summary?.trim() || 'Merge completed by the user', success: true } : result.structured);
        if (!report) throw new LabError('invalid_report', 'worker returned no valid structured report', 409);
        const branch = await git.branchOf(node.git.worktreePath); node = hostLive(entry);
        if (branch !== node.git.branch) throw new LabError('branch_changed', 'worker left the expected Host branch', 409);
        const cleanup = await cleanupNodeRuntime(node); node = hostLive(entry);
        const commit = mergePayload
          ? await git.finishMergeInWorktree(node.git.worktreePath, `dshex(${node.id}): merge ${(node.parentIds ?? []).join(' + ')}`)
          : await git.commitWorktree(project, node, `dshex(${node.id}): ${node.title}`);
        node = hostLive(entry);
        const usage = entry.external && result.usage ? externalUsage(result.usage) : await sessionUsage(node.sessionId);
        hostLive(entry);
        return await hostTerminal(entry, 'completed', { report, reportText: mergePayload?.message ?? blocksText(result.output), head: commit.head, usage, cleanup,
          ...(mergePayload ? { merge: { ...node.merge, state: 'committed', committedAt: Date.now(), committedBy: 'human', headCommit: commit.head } } : {}) });
      } catch (error) {
        if (entry.terminating) return await entry.terminating;
        hostNode(entry);
        return await hostTerminal(entry, 'failed', { error, stage: error.code === 'host_deadline' ? 'timeout' : 'run' });
      } finally {
        await hostDisposeHandles(entry);
        if (active.get(keyOf(entry.projectId, entry.nodeId)) === entry) active.delete(keyOf(entry.projectId, entry.nodeId));
        deadlines.delete(keyOf(entry.projectId, entry.nodeId));
        if (!entry.terminating) await hostAutoUpgrade(entry, requireNode(entry.projectId, entry.nodeId).error?.stage ?? 'run');
      }
    })();
    // Callers attach their own completion; retain failures for dispose/cancel too.
    entry.done.catch(() => {});
    return entry.done;
  }
  async function hostStart(projectId, nodeId, options) {
    if (!options.lease || !options.decisionId) return hostAdmission.request(projectId, nodeId, options);
    const project = hostCopy(requireProject(projectId)), node = hostCopy(requireNode(projectId, nodeId));
    if (node.status !== 'planned') throw new LabError('node_not_startable', 'Host node is not planned', 409);
    const rawAdmissionLease = hostCopy(options.lease);
    if (await hostAdmission.verify(project, node, rawAdmissionLease, options.decisionId) !== true) throw new LabError('host_budget_permit', 'Host admission lease could not be verified', 409);
    const key = keyOf(projectId, nodeId);
    const entry = { hostManaged: true, projectId, nodeId, rawAdmissionLease, decisionId: options.decisionId,
      owner: hostScope(node), node, project, phase: 'authorizing', controller: new AbortController() };
    hostNode(entry);
    if (active.has(key)) return hostResult(entry, 'held', 'HOST_ALREADY_ACTIVE');
    active.set(key, entry);
    try {
      const execution = node.execution ?? { driver: 'dsh' }, external = !isDshExecution(execution);
      let selection;
      if (external) selection = { provider: `execution:${execution.profile}`, model: execution.model ?? 'native', source: 'execution-profile' };
      else if (options.model || options.upgrade === true) {
        const requested = options.model ?? nextTierSelection(project, node.modelResolved ?? node.model);
        if (!requested) throw new LabError('no_upgrade', 'No stronger model profile is configured', 409);
        selection = await validateModelSelection(ctx, project, cleanModelRef(requested));
      } else selection = await resolveNodeSelection(project, node, node.kind === 'merge' ? 'merge' : 'worker');
      hostNode(entry);
      const started = await hostChange(entry, 'node/started', n => {
        if (n.status !== 'planned' || entry.phase !== 'authorizing') throw new LabError('host_budget_held', 'Host start was cancelled', 409);
        n.sessionId = newSessionId(); n.anchorSessionId = newSessionId();
        beginAttempt(n, selection);
        if (options.model || options.upgrade === true) n.model = cleanModelRef(selection);
        n.status = 'running'; n.modelResolved = hostCopy(selection); n.lease = hostCopy(rawAdmissionLease);
        n.resourcesHeld = Object.fromEntries(Object.entries(n.needs ?? {}).filter(([name]) => name !== 'machines'));
        n.deadlineAt = Math.min(Date.now() + (n.timeboxMs ?? project.config.nodeTimeoutMinutes * 60000), Number.isFinite(rawAdmissionLease.hardEndAt) ? rawAdmissionLease.hardEndAt : Infinity);
        if (n.deadlineAt <= Date.now()) throw new LabError('host_deadline', 'Host admission deadline elapsed', 409);
        for (const field of ['error', 'termination', 'resourceWait', 'hostBudgetCleanup']) delete n[field];
        n.timestamps = { ...(n.timestamps ?? {}), startedAt: Date.now(), lastActivityAt: Date.now() };
      }, options);
      entry.owner = hostScope(started); entry.node = started; entry.phase = 'preparing';
      deadlines.set(key, started.deadlineAt);
      hostLive(entry);
      let gate;
      try { gate = await hostAdmission.beforeEffects(projectId, nodeId, hostCopy(rawAdmissionLease)); }
      catch { gate = { ok: false, held: true }; }
      hostLive(entry);
      if (gate?.ok !== true) {
        await hostChange(entry, 'node/host_budget_gate', n => { n.hostBudgetGate = { attempt: n.currentAttempt, sessionId: n.sessionId, code: 'HOST_EFFECTS_UNCONFIRMED', at: Date.now() }; });
        entry.phase = 'held'; return hostResult(entry, 'held', 'HOST_EFFECTS_UNCONFIRMED');
      }
      await git.ensureWorktree(project, hostLive(entry)); hostLive(entry);
      if (external) {
        if (node.kind === 'merge' || rawAdmissionLease.placement === 'fleet') throw new LabError('unsupported', 'External execution requires a local non-merge Host attempt', 409);
        return await startExternalNode(project, hostLive(entry), execution, entry);
      }
      const anchor = await ensureAnchor(project, hostLive(entry)); hostLive(entry);
      let remotePrompt = '';
      if (rawAdmissionLease.placement === 'fleet') {
        const remote = await prepareRemoteRun({ project, node: hostLive(entry), lease: rawAdmissionLease, cluster }); hostLive(entry);
        remotePrompt = remote.prompt;
        await hostChange(entry, 'node/remote_prepared', n => { n.remote = { mode: 'fleet', dir: '.dshex-run', leaseId: rawAdmissionLease.leaseId, machineIds: (rawAdmissionLease.machines ?? []).map(group => group.machineId) }; });
      }
      if (node.kind === 'merge') {
        await prepareMerge(project, hostLive(entry), entry);
        const preparedMerge = hostLive(entry).merge;
        if (preparedMerge?.state === 'failed') {
          // Never start a merge worker on a tree that is not in a mergeable
          // state: the old code reported `clean` and the worker had nothing to do.
          throw new LabError('merge_prepare_failed', preparedMerge.error || 'merge preparation failed', 409);
        }
      }
      const current = hostLive(entry);
      const activation = await startActivation(ctx, { provider: 'spawn', label: `mir/${projectId}/${nodeId}`, delivery: 'caller', signal: entry.controller.signal, childId: current.sessionId,
        request: { parent: anchor, cwd: current.git.worktreePath, prompt: [{ type: 'text', text: node.kind === 'merge' ? mergePrompt(project, current, selection, remotePrompt) : workerPrompt(project, current, selection, remotePrompt) }],
          agentPreset: node.kind === 'merge' ? 'lab-merge' : 'lab-worker', agentOptions: selectionToAgentOptions(selection), ...(node.kind === 'merge' ? {} : { outputSchema: NODE_REPORT_SCHEMA }) } });
      entry.activation = activation; hostLive(entry);
      entry.phase = 'running'; entry.mode = node.kind === 'merge' ? 'merge' : 'experiment';
      // A 4-hour run must not lose everything when the timebox expires: checkpoint
      // the worktree periodically so a timeout still leaves commits behind.
      entry.wipTimer = setInterval(() => {
        void (async () => {
          try {
            const live = hostLive(entry);
            if (live.status !== 'running') return;
            await git.commitWorktree(requireProject(entry.projectId), live, `wip(${live.id}): checkpoint`);
          } catch { /* a failed checkpoint must never end the attempt */ }
        })();
      }, WIP_CHECKPOINT_MS);
      entry.wipTimer.unref?.();
      seedNodeSandbox(current.sessionId, project, current);
      activation.result.then(result => node.kind === 'merge' ? onMergeTurnEnd(projectId, nodeId, result) : hostFinish(entry, result), error => hostFinish(entry, null, error)).catch(() => {});
      return hostResult(entry, 'started');
    } catch (error) {
      if (entry.done) { await hostDisposeHandles(entry); return hostResult(entry, 'held', 'HOST_ATTEMPT_TERMINATED'); }
      try { hostNode(entry); } catch { await hostDisposeHandles(entry); active.delete(key); return hostResult(entry, 'held', 'HOST_OWNER_CHANGED'); }
      if (entry.owner.currentAttempt === (node.currentAttempt ?? 0)) { active.delete(key); throw error; }
      return hostEnd(entry, error.code === 'host_deadline' ? 'timeout' : 'failure', { message: failureMessage(error) });
    }
  }
  function hostUnresolved(node) {
    return Boolean(node.hostBudgetReservation || node.claim || node.admission || node.lease || node.resourcesHeld || node.hostBudgetGate
      || (node.hostBudgetCleanup && node.hostBudgetCleanup.verifiedClean !== true));
  }
  async function hostRetry(projectId, nodeId, options = {}) {
    const prior = hostCopy(requireNode(projectId, nodeId));
    if (hostUnresolved(prior)) throw new LabError('host_budget_held', 'Host budget or cleanup is unresolved; retry cannot erase ownership', 409);
    if (!['failed', 'cancelled', 'completed'].includes(prior.status)) throw new LabError('node_not_retryable', 'Host retry needs a terminal node', 409);
    if (store.childrenOf(projectId, nodeId).some(candidate => candidate.status !== 'proposed' && !isNonBlockingSuccessor(candidate))) throw new LabError('node_sealed', 'node has successors', 409);
    const entry = { projectId, nodeId, owner: hostScope(prior), phase: 'retrying' };
    await hostChange(entry, 'node/retried', n => {
      if (hostUnresolved(n)) throw new LabError('host_budget_held', 'Host budget changed while preparing retry', 409);
      n.status = 'planned'; n.report = null; n.deadlineAt = null;
      if (options.model) n.model = cleanModelRef(options.model);
      if (options.text) n.prompt = `${n.prompt ?? ''}\n\n# Additional instruction\n${options.text}`;
      delete n.error; delete n.termination;
    }, options);
    return start(projectId, nodeId, { ...(options.model ? { model: options.model } : {}), ...(options.upgrade === true ? { upgrade: true } : {}) });
  }

  async function hostAutoUpgrade(entry, stage) {
    if (lifetime.signal.aborted) return;
    const node = hostCopy(requireNode(entry.projectId, entry.nodeId));
    if (node.currentAttempt !== entry.owner.currentAttempt || node.sessionId !== entry.owner.sessionId || node.status !== 'failed' || hostUnresolved(node)) return;
    try { await maybeAutoUpgrade(hostCopy(requireProject(entry.projectId)), node, stage); } catch { /* A rejected new admission cannot rewrite the old attempt. */ }
  }

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
    if (needsSandbox(node)) return false; // Unknown/cleanup holds must never enter legacy replay.
    if (stage !== 'run' && stage !== 'timeout') return false;
    if (project.config.routing?.autoUpgrade !== true) return false;
    const maxAttempts = project.config.routing?.maxAttempts ?? 2;
    const attempts = Array.isArray(node.attempts) ? node.attempts.length : 0;
    if (attempts >= maxAttempts) return false;
    const maxCost = project.config.auto?.maxCostUsd ?? 0;
    if (maxCost > 0 && (node.costUsd ?? 0) >= maxCost) return false;
    if (hostAdmission) {
      if (node.kind === 'merge' || node.status !== 'failed' || hostUnresolved(node)) return false;
      await hostRetry(project.id, node.id, { upgrade: true });
      return true;
    }
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
    if (hostAdmission) return hostRetry(projectId, nodeId, { ...options, upgrade: options.reuseModel !== true && !options.model });
    const project = requireProject(projectId);
    const node = requireNode(projectId, nodeId);
    if (node.status === 'running' || node.status === 'proposed') {
      throw new LabError('node_not_escalatable', `node ${nodeId} is ${node.status}`, 409);
    }
    if (node.status === 'completed') {
      const hasChildren = store.childrenOf(projectId, nodeId)
        .some((candidate) => candidate.status !== 'proposed' && !isNonBlockingSuccessor(candidate));
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
    // Cause pointer (A1/O8): every runtime transition records *what* caused it.
    // A start/resume gets a fresh activation cause; later transitions keep it so
    // `explain_node` can answer "why is this node in this state" without reading
    // the whole event log.
    const activation = eventType === 'node/started' || eventType === 'node/resumed' || eventType === 'node/retried';
    const activationCause = `${node.id}-a${node.currentAttempt ?? node.attempt ?? 1}`;
    // Non-activation transitions still need a cause: a planned node cancelled
    // before it ever started has no activation to point at, and merge/GC writes
    // are not activations either. Synthesize a stable action cause so
    // `explain_node` never returns an empty chain.
    const actionCause = `${eventType}:${node.id}:a${node.currentAttempt ?? node.attempt ?? 1}`;
    const causeId = payload.causeId ?? (activation ? activationCause : (node.causeId ?? node.lastCauseId ?? actionCause));
    if (causeId) {
      if (activation) node.causeId = causeId;
      else node.lastCauseId = causeId;
    }
    // WP P1.7: runtime is a kernel caller, not a second writer. `node.put`
    // updates the full record through the executor so the event is durable
    // before the node/project rows move and `strictWrites=throw` stays honest.
    if (!kernel?.executor) throw new Error('runtime requires kernel.executor (single-writer invariant)');
    const spec = {
      actor: { kind: 'system', id: 'runtime' },
      causeId,
      expectedProjectRevision: payload.expectedProjectRevision,
      mutations: [{ op: 'node.put', node, eventType, eventData: payload.data ?? {} }],
    };
    // Several runtime transitions already hold `withProjectLock`; the executor's
    // `commit` would deadlock on that same lock. Use `commitLocked` (plus the
    // write permit) only when the current async chain demonstrably holds it.
    const result = store.isProjectLocked?.(project.id) === true
      ? await store.withWritePermit(() => kernel.executor.commitLocked(project.id, spec))
      : await kernel.executor.commit(project.id, spec);
    if (result.ok !== true) {
      const error = new Error(result.message ?? `${eventType} commit failed`);
      error.code = result.code ?? 'commit_failed';
      throw error;
    }
    project.revision = result.revision;
    node.rev = result.revision;
    return result.revision;
  }

  function runningNodes(projectId) {
    return store.listNodes(projectId).filter(holdsResources);
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
    try {
      const handle = await ctx.agents.create({
        sessionId: node.anchorSessionId,
        // DSH >= 0.2.2-rc.5 refuses to parent children under a session marked origin:'subagent'
        // once this host process no longer owns that session. An anchor only has to be a
        // durable private parent, so create it as its own root instead.
        meta: { cwd: node.git.worktreePath, agentPreset: 'lab-controller' },
        agentOptions: model,
        setup: async (agentCtx) => {
          await ctx.agentPresets.mount(agentCtx, 'lab-controller');
        },
      });
      anchorHandles.set(node.anchorSessionId, handle);
      return handle.agent;
    } catch (error) {
      // A previous attempt may already have created this anchor session and then
      // dropped the handle when it failed: `get()` finds nothing in memory while
      // the session still exists on disk. Resume it instead of stranding the node.
      if (!/already exists/i.test(String(error?.message ?? error))) throw error;
      return resumeAnchor(project, node);
    }
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

  function mergePrompt(project, node, selection, remotePrompt = '', external = false) {
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
    const custom = project.config?.prompts?.merge;
    return [
      custom && custom.trim() ? custom.trim() : DEFAULT_MERGE_PROMPT,
      `Worktree: ${node.git.worktreePath} (branch ${node.git.branch}). Work only inside it.`,
      external
        ? `Execution profile: ${node.execution?.profile ?? 'external'} (driver ${node.execution?.driver ?? 'unknown'}${node.execution?.model ? `, model ${node.execution.model}` : ''})`
        : `Model for this attempt: ${selection?.provider ?? 'default'}/${selection?.model ?? 'default'}${selection?.reasoningEffort ? ` (reasoning effort: ${selection.reasoningEffort})` : ''}`,
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

  async function prepareMerge(project, node, managed = null) {
    const others = (node.parentIds ?? [])
      .slice(1)
      .map((id) => store.getNode(project.id, id))
      .filter(Boolean);
    const prepared = [];
    let conflicts = [];
    let failure = null;
    for (const other of others) {
      if (!other.git?.headCommit || !other.git?.branch) {
        throw new LabError('merge_parent_not_ready', `parent ${other.id} has no committed branch`, 409);
      }
      if (managed) hostLive(managed);
      const result = await git.mergeBranchIntoWorktree(node.git.worktreePath, other.git.branch);
      if (managed) hostLive(managed);
      const ok = result.code === 0 && result.conflicts.length === 0;
      prepared.push({
        parentId: other.id,
        branch: other.git.branch,
        headCommit: other.git.headCommit,
        clean: ok,
        conflicts: result.conflicts,
        stderr: result.stderr,
      });
      if (!ok) {
        conflicts = result.conflicts;
        failure = result.stderr || `git merge exited with ${result.code}`;
        break;
      }
      // `git merge --no-commit` leaves MERGE_HEAD behind; committing each parent
      // immediately is what lets the next parent merge in. Without this the 3rd
      // parent always failed with "MERGE_HEAD exists" and the failure was then
      // reported as a clean merge.
      const step = await git.finishMergeInWorktree(node.git.worktreePath, `dshex(${node.id}): merge parent ${other.id} (prepare)`);
      prepared[prepared.length - 1].mergeCommit = step.head;
    }
    node.merge = {
      ...(node.merge ?? {}),
      state: conflicts.length > 0 ? 'conflict' : failure ? 'failed' : 'clean',
      conflictFiles: conflicts,
      error: failure ? String(failure).slice(0, 2000) : null,
      prepared,
      preparedAt: Date.now(),
    };
    if (managed) await hostChange(managed, 'node/merge_prepared', current => { hostLive(managed); current.merge = hostCopy(node.merge); });
    else await persistNode(project, node, 'node/merge_prepared', {
      data: { state: node.merge.state, conflicts: conflicts.length, parents: node.parentIds },
    });
  }

  async function onMergeTurnEnd(projectId, nodeId, result) {
    const key = keyOf(projectId, nodeId);
    const entry = active.get(key);
    if (!entry || entry.phase !== 'running') return;
    if (entry.hostManaged) {
      if (result?.stopReason !== 'completed') return hostFinish(entry, null, new Error(`merge worker stopped: ${result?.stopReason}`));
      const usage = await sessionUsage(hostLive(entry).sessionId);
      await hostChange(entry, 'node/merge_turn', (node, project) => { hostLive(entry); node.lastReport = blocksText(result?.output) || node.lastReport || ''; applyUsage(project, node, usage); node.timestamps = { ...(node.timestamps ?? {}), lastActivityAt: Date.now() }; });
      entry.phase = 'idle'; return;
    }
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
      `Node: ${node.id}`,
      // The title is a short label for humans and may be clamped for display. It is
      // deliberately NOT an instruction: only the Task and Success criteria sections
      // below define what this node must do.
      `Node title (label only, not an instruction): ${node.title}`,
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
      '# Reference: ancestor experiments (titles are labels; the reports carry the findings)',
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

  async function finish(projectId, nodeId, result) {
    const key = keyOf(projectId, nodeId);
    activityWrites.delete(key);
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
      // Stop a worker that finished its turn but left a server/job behind;
      // otherwise the supposedly completed node keeps holding GPU memory.
      node.cleanup = await cleanupNodeRuntime(node);
      const commit = await git.commitWorktree(project, node, `dshex(${node.id}): ${node.title}`);
      node.git.headCommit = commit.head;
      node.report = normalizeNodeReport(result?.structured);
      node.reportText = blocksText(result?.output) || node.reportText || '';
      const predictionResult = applyPredictionToNode(node);
      const openRetroTicket = predictionResult?.openRetroTicket === true;
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
        data: { headCommit: commit.head, committed: commit.committed, reportSuccess: node.report?.success ?? null, cleanup: node.cleanup ?? null, prediction: node.expectedOutcome ?? null },
      });
      if (openRetroTicket && kernel?.executor) {
        await kernel.executor.commit(project.id, {
          actor: { kind: 'system', id: 'postmortem' },
          causeId: `retro:${node.id}:${node.expectedRetroAt}`,
          mutations: [{
            op: 'event.record',
            type: 'retro/opened',
            data: {
              nodeId: node.id,
              expected: node.expected,
              outcome: node.expectedOutcome,
              reason: node.expectedOutcome.reason,
              openedAt: node.expectedRetroAt,
            },
          }],
        });
      }
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
      error: failureMessage(error),
      errorCode: failureCode(error),
    });
    node.status = 'failed';
    node.error = failureDiagnostic(node, stage, error);
    node.timestamps = { ...(node.timestamps ?? {}), completedAt: Date.now(), lastActivityAt: Date.now() };
    await persistNode(project, node, 'node/failed', {
      data: { stage, message: node.error.message, error: node.error, cleanup: node.cleanup ?? null },
    });
    await maybeAutoUpgrade(project, node, stage === 'run' ? 'run' : stage);
  }

  async function failStart(project, node, error) {
    await releaseNode(project, node);
    node.status = 'failed';
    node.error = failureDiagnostic(node, 'start', error);
    node.timestamps = { ...(node.timestamps ?? {}), completedAt: Date.now(), lastActivityAt: Date.now() };
    await persistNode(project, node, 'node/failed', { data: { stage: 'start', message: node.error.message, error: node.error } });
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

  async function startExternalNode(project, node, execution, managed = null) {
    const driver = EXECUTION_DRIVERS[execution.driver];
    if (typeof driver !== 'function') {
      throw new LabError('unavailable', `execution driver "${execution.driver}" is not registered`, 503);
    }
    const runId = `${node.id}-a${node.currentAttempt}`;
    const log = new ExecutionLog(executionLogPath(project.id, node.id, runId));
    await log.init();
    if (managed) hostLive(managed);
    await log.append({
      type: 'run/started',
      profile: execution.profile,
      driver: execution.driver,
      model: execution.model ?? null,
      reasoningEffort: execution.reasoningEffort ?? null,
      worktreePath: node.git.worktreePath,
    });
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
    if (managed) {
      await hostChange(managed, 'node/execution_started', current => { current.executionRun = hostCopy(node.executionRun); });
      hostLive(managed);
    } else await persistNode(project, node, 'node/execution_started', {
      data: { runId, driver: execution.driver, profile: execution.profile, logPath: log.filePath },
    });

    const controller = managed?.controller ?? new AbortController();
    let settled = false;
    const prompt = workerPrompt(project, node, null, '', true);
    const resultPromise = (async () => {
      try {
        if (managed) hostLive(managed);
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
        if (managed) await resultPromise.catch(() => {});
      },
    };
    const entry = managed ?? { projectId: project.id, nodeId: node.id, project, node };
    Object.assign(entry, { activation, phase: 'running', external: true, execution, executionLog: log });
    if (managed) hostLive(managed);
    active.set(keyOf(project.id, node.id), entry);
    deadlines.set(keyOf(project.id, node.id), node.deadlineAt);
    resultPromise.then(
      (result) => managed ? hostFinish(entry, result) : finish(project.id, node.id, result),
      (error) => managed ? hostFinish(entry, null, error) : finishFailure(project.id, node.id, error),
    ).catch(() => {});
    return managed ? hostResult(entry, 'started') : { node: store.getNode(project.id, node.id), revision: project.revision };
  }

  async function start(projectId, nodeId, options = {}) {
    if (needsSandbox(requireNode(projectId, nodeId))) return sandboxLane().start(projectId, nodeId, options);
    if (hostAdmission) return hostStart(projectId, nodeId, options);
    const preProject = requireProject(projectId);
    const preNode = requireNode(projectId, nodeId);
    if (preNode.status !== 'planned') {
      throw new LabError('node_not_startable', `node ${nodeId} is ${preNode.status}, expected planned`, 409);
    }
    // `deferred` is a priority class that means "never dispatched", and only
    // `node.claim` enforced it. A claim persisted across a reload is resumed by a
    // path that calls start() directly, so a node deferred after it was claimed
    // still launched — an operator/chief prune silently overridden. Guard the one
    // chokepoint every launch goes through.
    if (!isDispatchableClass(preNode.priority ?? {})) {
      throw new LabError('node_not_dispatchable', `node ${nodeId} is deferred; restore its priority before starting it`, 409);
    }
    const execution = preNode.execution && typeof preNode.execution === 'object'
      ? preNode.execution
      : { profile: 'dsh', driver: 'dsh' };
    const externalExecution = !isDshExecution(execution);
    if (preNode.kind !== 'merge') assertModelSchema(NODE_REPORT_SCHEMA, 'worker');
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
    await store.withProjectLock(projectId, async () => {
      project = requireProject(projectId);
      node = requireNode(projectId, nodeId);
      if (node.status !== 'planned') {
        throw new LabError('node_not_startable', `node ${nodeId} is ${node.status}, expected planned`, 409);
      }
      // The dispatcher commits `node.claim` before launching; the runtime adopts
      // the start and must not leave a stale claim on a running node.
      delete node.claim;
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
      if (externalExecution) {
        if (node.kind === 'merge') {
          throw new LabError('bad_request', 'merge nodes require the dsh execution profile', 400);
        }
        if (node.lease?.placement === 'fleet') {
          throw new LabError('unsupported', 'external execution profiles currently require local placement', 409);
        }
        return await startExternalNode(project, node, execution);
      }
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
        const mergeActivation = await startActivation(ctx, {
          provider: 'spawn',
          label: `mir-merge/${project.id}/${node.id}`,
          delivery: 'caller',
          signal: lifetime.signal,
          childId: node.sessionId,
          request: {
            parent: anchor,
            cwd: node.git.worktreePath,
            prompt: [{ type: 'text', text: mergePrompt(project, node, selection, remotePrompt, externalExecution) }],
            agentPreset: 'lab-merge',
            agentOptions: selectionToAgentOptions(selection),
          },
        });
        seedNodeSandbox(node.sessionId, project, node);
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
      const activation = await startActivation(ctx, {
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
      seedNodeSandbox(node.sessionId, project, node);
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
    activityWrites.delete(key);
    const entry = active.get(key);
    if (!entry || entry.phase !== 'running') return;
    entry.phase = 'finishing';
    active.delete(key);
    deadlines.delete(key);
    const project = store.getProject(projectId);
    const node = store.getNode(projectId, nodeId);
    if (node && entry.external) {
      node.executionRun = {
        ...(node.executionRun ?? {}),
        status: 'failed',
        endedAt: Date.now(),
        error: failureMessage(error),
      };
    }
    if (project && node) await failNode(project, node, error, 'run');
    try {
      await entry.activation.dispose();
    } catch {
      // already settled
    }
    if (node) await disposeAnchor(node);
  }

  async function terminate(projectId, nodeId, kind, payload = {}) {
    if (needsSandbox(store.getNode(projectId, nodeId))) return sandboxLane().terminate(projectId, nodeId, kind, payload);
    if (hostAdmission) {
      const managed = active.get(keyOf(projectId, nodeId));
      return managed?.hostManaged ? hostEnd(managed, kind, payload) : null;
    }
    const key = keyOf(projectId, nodeId);
    activityWrites.delete(key);
    const expectedProjectRevision = Number.isInteger(payload.expectedRevision) ? payload.expectedRevision : null;
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
    if (entry.external) {
      try {
        entry.node.executionRun = {
          ...(entry.node.executionRun ?? {}),
          status: kind === 'cancelled' ? 'cancelled' : 'terminated',
          endedAt: Date.now(),
          termination: kind,
        };
      } catch {
        // status is best-effort
      }
    }
    const killedJobs = await killSessionJobs(entry.node.sessionId);
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
      applyUsage(project, node, await sessionUsage(entry.node.sessionId));
      endAttempt(node, {
        stopReason: kind === 'cancel' || kind === 'preempted' ? 'cancelled' : 'timeout',
        status: kind === 'cancel' || kind === 'preempted' ? 'cancelled' : 'failed',
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
      if (kind === 'preempted') {
        // Project-local p0 preemption is a deliberate policy decision, not a
        // user cancellation or a timeout. Keep the reason, the beneficiary and
        // an open appeal record on the node and in the event cause chain.
        node.preemption = {
          at: requestedAt,
          by: payload.by ?? 'dispatcher',
          forNodeId: payload.forNodeId ?? null,
          reason: payload.reason ?? 'higher-priority work needed this slot',
          causeId: payload.causeId ?? `preempt:${node.id}:${requestedAt}`,
          appeal: {
            status: 'open',
            deadlineAt: Date.now() + 24 * 60 * 60_000,
            endpoint: `/api/metainfer-research-lab/preemption/appeal`,
          },
        };
      }
      const cancelled = kind === 'cancel' || kind === 'preempted';
      node.status = cancelled ? 'cancelled' : 'failed';
      const terminationMessage = payload.message || (kind === 'cancel'
        ? 'cancelled by user'
        : kind === 'preempted'
          ? `preempted for ${payload.forNodeId ?? 'higher-priority work'}`
          : 'node timed out and was terminated');
      node.error = failureDiagnostic(node, kind === 'timeout' ? 'timeout' : 'run', payload.code
        ? { code: payload.code, message: terminationMessage }
        : terminationMessage);
      node.timestamps = { ...(node.timestamps ?? {}), completedAt: Date.now(), lastActivityAt: Date.now() };
      const terminalEvent = kind === 'cancel'
        ? 'node/cancelled'
        : kind === 'preempted'
          ? 'node/preempted'
          : kind === 'resource_lost'
            ? 'node/resource_lost'
            : 'node/timeout';
      const currentProject = store.getProject(projectId);
      if (expectedProjectRevision !== null && (currentProject?.revision ?? 0) !== expectedProjectRevision) {
        throw new LabError('stale_basis', `project revision changed while cancelling (expected ${expectedProjectRevision}, actual ${currentProject?.revision ?? 0})`, 409);
      }
      await persistNode(project, node, terminalEvent, {
        data: {
          kind,
          killedPids: reaped.killedPids.length,
          killedJobs: killedJobs.length,
          verifiedClean: node.termination.verifiedClean,
          error: node.error,
          leftover,
          reaper: reaped.reaper,
          reaperSupported: reaped.reaperSupported,
          ...(node.preemption ? { preemption: node.preemption } : {}),
        },
        ...(node.preemption?.causeId ? { causeId: node.preemption.causeId } : {}),
        expectedProjectRevision,
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

  /** Record a human/system appeal against a preemption; the slot decision is never rewritten. */
  async function appealPreemption(projectId, nodeId, options = {}) {
    const project = requireProject(projectId);
    const node = requireNode(projectId, nodeId);
    if (!node.preemption) {
      throw new LabError('preemption_not_found', `node ${nodeId} has no preemption record`, 404);
    }
    const appeal = node.preemption.appeal ?? {};
    if (appeal.status === 'appealed') {
      throw new LabError('preemption_already_appealed', `node ${nodeId} preemption is already appealed`, 409);
    }
    const reason = typeof options.reason === 'string' ? options.reason.trim().slice(0, 2000) : '';
    if (!reason) throw new LabError('bad_request', 'preemption appeal reason is required', 400);
    if (!options.actor || typeof options.actor !== 'object' || typeof options.actor.id !== 'string' || !options.actor.id) {
      throw new LabError('actor_required', 'preemption appeal requires an authenticated actor', 403);
    }
    node.preemption = {
      ...node.preemption,
      appeal: {
        ...appeal,
        status: 'appealed',
        at: Date.now(),
        by: options.actor,
        reason,
      },
    };
    await persistNode(project, node, 'node/preemption_appealed', {
      data: { reason, by: node.preemption.appeal.by, preemption: node.preemption },
    });
    return { node: store.getNode(projectId, nodeId), revision: store.getProject(projectId)?.revision ?? null };
  }

  /**
   * Project-local p0 preemption (5.3.2/Q3 mechanism C).
   * The dispatcher selects a lower-class victim that has run > 10 min; this
   * method is the only producer of the `preempted` termination kind.
   */
  async function preempt(projectId, nodeId, options = {}) {
    rejectSandboxOperation(requireNode(projectId, nodeId), 'preemption');
    const node = requireNode(projectId, nodeId);
    if (node.status !== 'running') {
      throw new LabError('node_not_preemptible', `node ${nodeId} is ${node.status}; only a running node can be preempted`, 409);
    }
    if (node.kind === 'merge') {
      throw new LabError('node_not_preemptible', 'merge nodes are never preempted', 409);
    }
    return terminate(projectId, nodeId, 'preempted', {
      ...options,
      forNodeId: options.forNodeId ?? null,
      reason: options.reason ?? 'higher-priority work needed this slot',
      by: options.by ?? 'dispatcher',
    });
  }

  async function cancel(projectId, nodeId, options = {}) {
    const project = requireProject(projectId);
    const node = requireNode(projectId, nodeId);
    const key = keyOf(projectId, nodeId);
    const expectedRevision = Number.isInteger(options.expectedRevision) ? options.expectedRevision : null;
    if (expectedRevision !== null && (project.revision ?? 0) !== expectedRevision) {
      throw new LabError('stale_basis', `project revision changed since authorization (expected ${expectedRevision}, actual ${project.revision ?? 0})`, 409);
    }
    if (needsSandbox(node)) return sandboxLane().terminate(projectId, nodeId, 'cancel', options);
    if (hostAdmission) {
      const entry = active.get(key);
      if (entry?.hostManaged) return hostEnd(entry, 'cancel', options);
      if (node.status !== 'planned') throw new LabError('node_not_cancellable', `node ${nodeId} is ${node.status}`, 409);
      const planned = { projectId, nodeId, owner: hostScope(node), phase: 'cancelling' };
      await hostChange(planned, 'node/cancelled', current => { current.status = 'cancelled'; current.timestamps = { ...(current.timestamps ?? {}), completedAt: Date.now() }; }, options);
      return { node: hostCopy(requireNode(projectId, nodeId)), revision: requireProject(projectId).revision };
    }
    if (active.has(key)) return terminate(projectId, nodeId, 'cancel', { expectedRevision });
    if (node.status !== 'planned') {
      throw new LabError('node_not_cancellable', `node ${nodeId} is ${node.status}`, 409);
    }
    await store.withProjectLock(projectId, async () => {
      const currentProject = requireProject(projectId);
      if (expectedRevision !== null && (currentProject.revision ?? 0) !== expectedRevision) {
        throw new LabError('stale_basis', `project revision changed since authorization (expected ${expectedRevision}, actual ${currentProject.revision ?? 0})`, 409);
      }
      const current = requireNode(projectId, nodeId);
      current.status = 'cancelled';
      current.timestamps = { ...(current.timestamps ?? {}), completedAt: Date.now() };
      await persistNode(project, current, 'node/cancelled', {
        data: { kind: 'planned' },
        expectedProjectRevision: expectedRevision,
      });
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
    rejectSandboxOperation(requireNode(projectId, nodeId), 'followup');
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (!trimmed) throw new LabError('bad_request', 'message text is required', 400);
    if (trimmed.length > 8000) throw new LabError('bad_request', 'message text is too long', 400);
    if (hostAdmission) {
      const entry = active.get(keyOf(projectId, nodeId)), current = hostCopy(requireNode(projectId, nodeId));
      if (current.status !== 'running') return hostRetry(projectId, nodeId, { ...options, text: trimmed });
      if (!entry?.hostManaged || entry.done || !['running', 'idle'].includes(entry.phase)) throw new LabError('host_budget_held', 'No live admitted Host attempt is available', 409);
      hostLive(entry);
      const verified = await hostAdmission.verify(hostCopy(requireProject(projectId)), current, hostCopy(entry.rawAdmissionLease), entry.decisionId);
      hostLive(entry);
      if (verified !== true) throw new LabError('host_budget_held', 'Live Host permit is not verified', 409);
      const anchor = await ensureAnchor(hostCopy(requireProject(projectId)), hostLive(entry)); hostLive(entry);
      if (entry.mode === 'merge') {
        entry.phase = 'running';
        pendingFollowUps.set(current.sessionId, { projectId, nodeId, sessionId: current.sessionId, mode: 'merge', text: trimmed });
      }
      await ctx.subagents.sendMessage(anchor, current.sessionId, [{ type: 'text', text: followUpPrompt(current, trimmed) }], { signal: entry.controller.signal });
      hostLive(entry);
      return hostResult(entry, 'started');
    }
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
      const hasChildren = store.childrenOf(projectId, nodeId)
        .some((candidate) => candidate.status !== 'proposed' && !isNonBlockingSuccessor(candidate));
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
    if (needsSandbox(requireNode(projectId, nodeId))) return retrySandbox(projectId, nodeId, options);
    if (hostAdmission) return hostRetry(projectId, nodeId, options);
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
    rejectSandboxOperation(requireNode(projectId, nodeId), 'merge');
    if (hostAdmission) {
      const managed = active.get(keyOf(projectId, nodeId));
      if (!managed?.hostManaged || requireNode(projectId, nodeId).kind !== 'merge') throw new LabError('host_budget_held', 'No admitted live merge owner', 409);
      hostLive(managed);
      return hostFinish(managed, { stopReason: 'completed', output: [] }, null, payload);
    }
    const key = keyOf(projectId, nodeId);
    const entry = active.get(key);
    const project = requireProject(projectId);
    const node = requireNode(projectId, nodeId);
    if (node.kind !== 'merge') throw new LabError('not_a_merge_node', `node ${nodeId} is not a merge node`, 409);
    if (node.status !== 'running') {
      throw new LabError('node_not_mergeable', `node ${nodeId} is ${node.status}, expected running`, 409);
    }
    // A merge agent may have left a test server or shell job behind before the
    // human pressed "finish merge"; reap it before joining the branch.
    node.cleanup = await cleanupNodeRuntime(node);
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
    node.report = normalizeNodeReport({
      summary: typeof payload.summary === 'string' && payload.summary.trim()
        ? payload.summary.trim()
        : `Merge of ${node.parentIds.join(' + ')} completed by the user`,
      success: true,
      changes: [],
      metrics: [],
      reproduce: [],
      next: [],
      risks: [],
    });
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
      data: { kind: 'merge', headCommit: result.head, committed: result.committed, cleanup: node.cleanup ?? null },
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
    rejectSandboxOperation(requireNode(projectId, nodeId), 'escalation');
    return prepareNewAttempt(projectId, nodeId, {
      model: options.model,
      source: 'escalation',
      reason: options.reason ?? 'manual escalation',
    });
  }

  const activityWrites = new Map();

  /** Find the active node whose worker session emitted this event. */
  function activeEntryForSession(sessionId) {
    if (!sessionId) return null;
    for (const entry of active.values()) {
      if (entry?.node?.sessionId === sessionId) return entry;
    }
    return null;
  }

  /**
   * K8/1.3: a turn can run for minutes without a turn/end. Assistant/tool/step
   * events still prove the node is alive, so move `lastActivityAt` and write a
   * bounded `node/activity` record. The first event of a turn is immediate; the
   * rest are throttled per node to avoid turning a token stream into event spam.
   */
  async function recordActivity(entry, event, now) {
    const key = keyOf(entry.projectId, entry.nodeId);
    const turnId = turnIdOf(event);
    const previous = activityWrites.get(key);
    const newTurn = turnId !== null && previous?.turnId !== turnId;
    if (!newTurn && previous && now - previous.at < ACTIVITY_WRITE_INTERVAL_MS) return false;
    activityWrites.set(key, { at: now, turnId: turnId ?? previous?.turnId ?? null });
    const project = store.getProject(entry.projectId);
    const node = store.getNode(entry.projectId, entry.nodeId);
    if (!project || !node || node.status !== 'running') return false;
    if (entry.hostManaged) {
      hostLive(entry);
      await hostChange(entry, 'node/activity', current => { hostLive(entry); current.timestamps = { ...(current.timestamps ?? {}), lastActivityAt: now }; });
      return true;
    }
    node.timestamps = { ...(node.timestamps ?? {}), lastActivityAt: now };
    await persistNode(project, node, 'node/activity', {
      data: { event: event.type, turnId, at: now },
    });
    return true;
  }

  async function onSessionEvent(session, event) {
    if (session?.id && isTurnActivityEvent(event)) {
      const entry = activeEntryForSession(session.id);
      if (entry) {
        try {
          await recordActivity(entry, event, Date.now());
        } catch {
          // Activity telemetry must never take down the worker's event stream.
        }
      }
      return;
    }
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
        if (entry?.hostManaged) {
          const text = await lastAssistantText(hostLive(entry).sessionId); hostLive(entry);
          await onMergeTurnEnd(pending.projectId, pending.nodeId, { stopReason: reasonKind, output: [{ type: 'text', text }] });
          return;
        }
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
      if (entry.hostManaged) {
        if (entry.rawAdmissionLease.broker !== 'cluster') continue;
        const last = leaseRenewedAt.get(key) ?? 0;
        if (now - last < cluster.heartbeatMs) continue;
        leaseRenewedAt.set(key, now);
        try {
          const current = hostLive(entry);
          if (await hostAdmission.verify(hostCopy(requireProject(entry.projectId)), current, hostCopy(entry.rawAdmissionLease), entry.decisionId) !== true) throw new Error('Host permit lost');
          hostLive(entry);
          const renewed = await cluster.renew(entry.rawAdmissionLease.leaseId, Math.max(1, current.deadlineAt - Date.now()) + 120_000);
          hostLive(entry);
          if (renewed?.status !== 'renewed') throw new Error('lease lost');
        } catch { await hostEnd(entry, Date.now() >= entry.node.deadlineAt ? 'timeout' : 'resource_lost'); }
        continue;
      }
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
    await hostAdmission?.pumpLeases?.();
    await sandboxRuntime?.pumpLeases();
    if (hostAdmission) {
      for (const project of store.listProjects()) for (const node of store.listNodes(project.id)) {
        if (needsSandbox(node) || node.status !== 'planned' || !node.resourceWait || hostUnresolved(node) || node.resourceWait.retryAfter > Date.now()) continue;
        const key = keyOf(project.id, node.id);
        if (leasePumping.has(key)) continue;
        leasePumping.add(key);
        try { await start(project.id, node.id); } finally { leasePumping.delete(key); }
      }
      return;
    }
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
    await sandboxRuntime?.tick();
    const now = Date.now();
    try {
      await renewLeases();
    } catch {
      // renewLeases handles per-lease failures
    }
    for (const [key, deadlineAt] of [...deadlines.entries()]) {
      if (now < deadlineAt) continue;
      const entry = active.get(key);
      if (entry?.hostManaged) { await hostEnd(entry, 'timeout'); continue; }
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

  async function dispose() {
    lifetime.abort();
    await sandboxRuntime?.dispose();
    if (hostAdmission) await Promise.all([...active.values()].filter(entry => entry.hostManaged).map(entry => hostEnd(entry, 'dispose')));
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

  // L2-3/A6 sweep: the timer only decides how often we LOOK; the thresholds are
  // leaseTtlMinutes (default 30 min) and 2x that for release, and a ghost must
  // additionally have no live Host attempt. Ten minutes keeps the scan cheap
  // while still reacting well inside those thresholds.
  const MAINTENANCE_SWEEP_MS = 10 * 60_000;
  const leaseTtlTimer = setInterval(() => { void sweepLeaseTtl().catch(() => {}); void sweepGhostAttempts().catch(() => {}); }, MAINTENANCE_SWEEP_MS);
  leaseTtlTimer.unref?.();
  lifetime.signal.addEventListener('abort', () => clearInterval(leaseTtlTimer), { once: true });

  return {
    start,
    cancel,
    requeueWithNeeds,
    shrinkNeeds,
    sweepLeaseTtl,
    sweepGhostAttempts,
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
    preempt,
    appealPreemption,
    isTurnActivityEvent,
    recordSessionActivity: async (sessionId, event) => {
      const entry = activeEntryForSession(sessionId);
      if (!entry) return false;
      return recordActivity(entry, event, Date.now());
    },
    dispose,
  };
}
