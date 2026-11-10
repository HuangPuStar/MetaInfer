/**
 * M1 lab service: project creation, state projection, edits.
 *
 * The service is transport-free: host/http.js calls the same methods the UI
 * uses, and later phases expose the same operations to agent tools.
 */
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { LabError } from './git-engine.js';
import { buildModelCatalog, cleanModelRef, resolveModelSelection, validateModelSelection } from './models.js';
import { compilePlacementPolicy, describePlacementSpec, sanitizePlacementSpec } from './placement.js';
import { DEFAULT_ADVISOR_PROMPT, DEFAULT_GC_PROMPT, DEFAULT_MERGE_PROMPT, DEFAULT_SCHEDULER_PROMPT, DEFAULT_WORKER_PREFIX, PROMPT_PLACEHOLDERS } from './prompts.js';
import { DEFAULT_EXECUTION_PROFILES, normalizeExecutionProfile, resolveExecutionProfile } from './execution.js';
import { ExecutionLog } from './execution-log.js';
import { DEFAULT_DASHBOARD_SPEC, DASHBOARD_CHAT_SCHEMA, WIDGET_DATA_RESULT_SCHEMA, sanitizeDashboardSpec, normalizeWidgets, normalizeWidgetData, applyWidgetLayouts, buildWidgetPrompt, buildDashboardChatPrompt } from './dashboard.js';
import { newProjectId, newSessionId } from './store.js';
import { clampNodeTitle } from './titles.js';
import { buildStatusFacts } from './observability/status.js';
import { computeProjectMetrics, createMetricsCollector } from './observability/metrics.js';
import { createExplainer } from './observability/explain.js';
import { queryDag, dagGet, mapDag, walkDag, createDiffCache } from './context/dag.js';
import { createExplorationBudget } from './context/limits.js';
import { createLedgerReader } from './context/ledger.js';
import { normalizePriority } from './kernel/priority.js';
import { runnableQueue, runnableSince } from './kernel/runnable.js';
import { NEXT_STEPS, rejection, toActionable } from './kernel/errors.js';
import { PRIORITY_CLASSES, classBudgetOf } from './dispatch/reservation.js';
import { DISPUTE_CLASS_MAP, DISPUTE_DEFAULT_ACTION, createDisputeRecord, disputeActorVerdict, disputeAuthorityVerdict, effectiveDispute, expireDisputeRecord, reopenDisputeRecord, resolveDisputeRecord } from './kernel/disputes.js';
import { DEFAULT_ROTATION_DAYS, rotationPlan } from './experts/rotation.js';
import { actorForSession, actorFromToolExecution } from './kernel/policy.js';
import { actorKeyOf, hasActorIdentity, isIssuedActorKey, publicView, sameActor } from './kernel/actors.js';
import { ESCALATION_REASON_CODES, INTENT_KINDS, INTENT_TTL_MS, basisFor, createIntent, detectIntentConflicts, intentBasis, intentId, intentMutation } from './kernel/intent.js';
import { ACTION_VERIFICATION, IRREVERSIBLE_ACTIONS, citationErrorRate, citationTier, gateClaimAction, verifyClaims } from './kernel/claims.js';
import { listExpertDescriptors, getExpertDescriptor, computeExpertMetrics } from './experts/registry.js';
import { recallExperts } from './experts/similarity.js';
import { evaluateEscalationTriggers, evaluateThresholdTriggers, queueOverloadState, THRESHOLD_TRIGGER_CODES, TRIGGER_CODES } from './experts/triggers.js';
import { applyNomination, createCurator } from './experts/curator.js';
import { HIGH_REVIEW_WINDOW_MS, buildHierarchyReview, chiefActivationMetrics, chiefPolicy, childVoteWeight, escalationRate, filterVisibleExperts, validateChiefDecision } from './experts/hierarchy.js';
import { createResidentSession, RESIDENT_LIMITS } from './experts/resident.js';

const MAX_TIMEOUT_MINUTES = 1440;
// A state index row never carries a full prompt; the inspector loads the node.
const STATE_PROMPT_CHARS = 400;
// Upper bound on independent root nodes created together with a project.
const MAX_ROOT_NODES = 8;

function text(value, field, { required = false, max = 8000 } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new LabError('bad_request', `${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw new LabError('bad_request', `${field} must be a string`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new LabError('bad_request', `${field} is required`);
  if (trimmed.length > max) throw new LabError('bad_request', `${field} must be at most ${max} characters`);
  return trimmed;
}

function integer(value, field, fallback, min, max) {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new LabError('bad_request', `${field} must be a finite number`);
  const rounded = Math.trunc(n);
  if (rounded < min || rounded > max) {
    throw new LabError('bad_request', `${field} must be between ${min} and ${max}`);
  }
  return rounded;
}

function normalizeResourcePools(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new LabError('bad_request', 'config.resourcePools must be an object');
  }
  const pools = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(key)) {
      throw new LabError('bad_request', `invalid resource key: ${key}`);
    }
    const amount = Number(value);
    if (!Number.isInteger(amount) || amount < 0) {
      throw new LabError('bad_request', `resource "${key}" must be a non-negative integer`);
    }
    pools[key] = amount;
  }
  return pools;
}

function normalizeModelRef(raw, field) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new LabError('bad_request', `${field} must be an object`);
  const provider = text(raw.provider, `${field}.provider`, { required: true, max: 120 });
  const model = text(raw.model, `${field}.model`, { required: true, max: 200 });
  const reasoningEffort = raw.reasoningEffort === undefined
    ? undefined
    : text(raw.reasoningEffort, `${field}.reasoningEffort`, { max: 40 });
  return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

function normalizeNeeds(raw, project) {
  if (raw === undefined || raw === null) return { needs: {}, error: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { needs: {}, error: 'needs must be an object like {"gpu": 1}' };
  }
  const needs = {};
  for (const [key, value] of Object.entries(raw)) {
    const name = String(key).trim();
    const amount = Number(value);
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) {
      return { needs: {}, error: `invalid resource name: ${name}` };
    }
    if (!Number.isInteger(amount) || amount < 0 || amount > 64) {
      return { needs: {}, error: `resource ${name} must be an integer 0..64` };
    }
    if (amount === 0) continue;
    needs[name] = amount;
  }
  void project;
  return { needs, error: null };
}

function normalizeConfig(raw, base = undefined) {
  const input = raw === undefined || raw === null ? {} : raw;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new LabError('bad_request', 'config must be an object');
  }
  const previous = base ?? {};
  const maxNodeTimeoutMinutes = integer(
    input.maxNodeTimeoutMinutes,
    'config.maxNodeTimeoutMinutes',
    previous.maxNodeTimeoutMinutes ?? 240,
    1,
    MAX_TIMEOUT_MINUTES,
  );
  const nodeTimeoutMinutes = integer(
    input.nodeTimeoutMinutes,
    'config.nodeTimeoutMinutes',
    previous.nodeTimeoutMinutes ?? 10,
    1,
    Math.min(MAX_TIMEOUT_MINUTES, maxNodeTimeoutMinutes),
  );
  // Node sessions (worker/merge) run arbitrary experiments. The workspace-write
  // sandbox is enough for CPU work, but GPU runtimes open /dev/kfd (and vendor
  // device nodes) read-write; the file sandbox denies that, so the node looks
  // healthy while torch reports zero devices. `auto` (the default) keeps CPU
  // nodes confined and lifts only nodes that requested GPU/machine resources;
  // a project may also pin any explicit mode.
  const SANDBOX_MODES = ['auto', 'read-only', 'workspace-write', 'danger-full-access'];
  let workerSandboxMode = previous.workerSandboxMode ?? 'auto';
  if (input.workerSandboxMode !== undefined) {
    if (typeof input.workerSandboxMode !== 'string' || !SANDBOX_MODES.includes(input.workerSandboxMode)) {
      throw new LabError(
        'bad_request',
        `config.workerSandboxMode must be one of ${SANDBOX_MODES.join(', ')}`,
      );
    }
    workerSandboxMode = input.workerSandboxMode;
  }
  const config = {
    ...previous,
    resourcePools: input.resourcePools === undefined
      ? (previous.resourcePools ?? {})
      : normalizeResourcePools(input.resourcePools),
    maxRunningNodes: integer(input.maxRunningNodes, 'config.maxRunningNodes', previous.maxRunningNodes ?? 4, 1, 64),
    maxNodes: integer(input.maxNodes, 'config.maxNodes', previous.maxNodes ?? 60, 1, 20_000),
    // Q5: deferred/pruned nodes are held for restoration but do not consume a
    // hot maxNodes slot; this separate quota bounds the cold set.
    maxDeferred: integer(input.maxDeferred, 'config.maxDeferred', previous.maxDeferred ?? 20, 0, 20_000),
    // Cluster queue priority (higher starts sooner when several projects contend for one GPU).
    clusterPriority: integer(input.clusterPriority, 'config.clusterPriority', previous.clusterPriority ?? 0, 0, 100),
    nodeTimeoutMinutes,
    maxNodeTimeoutMinutes,
    workerSandboxMode,
    execution: {
      profiles: previous.execution?.profiles ?? { ...DEFAULT_EXECUTION_PROFILES },
      taskTypes: previous.execution?.taskTypes ?? {},
    },
  };

  if (input.models !== undefined) {
    if (typeof input.models !== 'object' || Array.isArray(input.models)) {
      throw new LabError('bad_request', 'config.models must be an object');
    }
    const models = { ...(previous.models ?? {}) };
    const roleInputs = {
      ...(input.models.roles && typeof input.models.roles === 'object' && !Array.isArray(input.models.roles)
        ? input.models.roles
        : {}),
    };
    for (const role of ['worker', 'advisor', 'scheduler', 'controller', 'merge', 'gc', 'dashboard']) {
      if (input.models[role] !== undefined) roleInputs[role] = input.models[role];
    }
    for (const [role, raw] of Object.entries(roleInputs)) {
      if (!['worker', 'advisor', 'scheduler', 'controller', 'merge', 'gc', 'dashboard'].includes(role)) continue;
      const normalized = normalizeModelRef(raw, `config.models.${role}`);
      if (normalized) {
        models[role] = normalized; // flat form used by existing settings UI
      }
    }
    if (input.models.default !== undefined) {
      const normalized = normalizeModelRef(input.models.default, 'config.models.default');
      if (normalized) models.default = normalized;
    }
    models.roles = Object.fromEntries(
      Object.entries(models).filter(([key]) => ['worker', 'advisor', 'scheduler', 'controller', 'merge', 'gc', 'dashboard'].includes(key)),
    );
    config.models = models;
  }

  if (input.modelOptions !== undefined) {
    if (!Array.isArray(input.modelOptions)) {
      throw new LabError('bad_request', 'config.modelOptions must be an array');
    }
    if (input.modelOptions.length > 50) {
      throw new LabError('bad_request', 'config.modelOptions supports at most 50 entries');
    }
    config.modelOptions = input.modelOptions.map((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new LabError('bad_request', `config.modelOptions[${index}] must be an object`);
      }
      const provider = text(raw.provider, `config.modelOptions[${index}].provider`, { required: true, max: 120 });
      const model = text(raw.model, `config.modelOptions[${index}].model`, { required: true, max: 200 });
      const id = text(raw.id, `config.modelOptions[${index}].id`, { max: 120 })
        || `${provider}:${model}${raw.reasoningEffort ? `:${raw.reasoningEffort}` : ''}`;
      const reasoningEffort = raw.reasoningEffort === undefined
        ? undefined
        : text(raw.reasoningEffort, `config.modelOptions[${index}].reasoningEffort`, { max: 60 });
      const tags = Array.isArray(raw.tags)
        ? raw.tags.filter((tag) => typeof tag === 'string').map((tag) => tag.trim()).filter(Boolean).slice(0, 8)
        : [];
      const priceIn = raw.pricePerMTokIn === undefined
        ? 0
        : Number(raw.pricePerMTokIn);
      const priceOut = raw.pricePerMTokOut === undefined
        ? 0
        : Number(raw.pricePerMTokOut);
      if (!Number.isFinite(priceIn) || priceIn < 0 || !Number.isFinite(priceOut) || priceOut < 0) {
        throw new LabError('bad_request', `config.modelOptions[${index}] prices must be non-negative numbers`);
      }
      return {
        id,
        provider,
        model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        pricePerMTokIn: priceIn,
        pricePerMTokOut: priceOut,
      };
    });
    const seen = new Set();
    for (const option of config.modelOptions) {
      if (seen.has(option.id)) throw new LabError('bad_request', `duplicate modelOptions id: ${option.id}`);
      seen.add(option.id);
    }
  }

  if (input.placementPolicy !== undefined) {
    if (input.placementPolicy !== null && typeof input.placementPolicy !== 'object') {
      throw new LabError('bad_request', 'config.placementPolicy must be an object');
    }
    if (input.placementPolicy === null) {
      config.placementPolicy = { text: '', spec: null, compiledAt: null, explanation: [], warnings: [], compiler: null };
    } else {
      const previousPolicy = previous.placementPolicy ?? {};
      const policyText = input.placementPolicy.text === undefined
        ? (previousPolicy.text ?? '')
        : text(input.placementPolicy.text, 'config.placementPolicy.text', { max: 4000 }) ?? '';
      let spec = previousPolicy.spec ?? null;
      if (input.placementPolicy.spec !== undefined) {
        try {
          spec = sanitizePlacementSpec(input.placementPolicy.spec);
        } catch (error) {
          throw new LabError('bad_request', `config.placementPolicy.spec: ${error.message}`);
        }
      }
      config.placementPolicy = {
        text: policyText,
        spec,
        compiledAt: Number.isFinite(Number(input.placementPolicy.compiledAt))
          ? Number(input.placementPolicy.compiledAt)
          : (previousPolicy.compiledAt ?? null),
        explanation: Array.isArray(input.placementPolicy.explanation)
          ? input.placementPolicy.explanation.filter((item) => typeof item === 'string').slice(0, 40)
          : (previousPolicy.explanation ?? []),
        warnings: Array.isArray(input.placementPolicy.warnings)
          ? input.placementPolicy.warnings.filter((item) => typeof item === 'string').slice(0, 40)
          : (previousPolicy.warnings ?? []),
        compiler: typeof input.placementPolicy.compiler === 'string'
          ? input.placementPolicy.compiler
          : (previousPolicy.compiler ?? null),
        summary: typeof input.placementPolicy.summary === 'string'
          ? input.placementPolicy.summary.slice(0, 2000)
          : (previousPolicy.summary ?? describePlacementSpec(spec)),
      };
    }
  }

  if (input.routing !== undefined) {
    if (typeof input.routing !== 'object' || Array.isArray(input.routing)) {
      throw new LabError('bad_request', 'config.routing must be an object');
    }
    const routing = {
      advisorMaySelectModels: previous.routing?.advisorMaySelectModels ?? false,
      autoUpgrade: previous.routing?.autoUpgrade ?? false,
      maxAttempts: previous.routing?.maxAttempts ?? 2,
    };
    if (input.routing.advisorMaySelectModels !== undefined) {
      routing.advisorMaySelectModels = input.routing.advisorMaySelectModels === true;
    }
    if (input.routing.autoUpgrade !== undefined) {
      routing.autoUpgrade = input.routing.autoUpgrade === true;
    }
    if (input.routing.maxAttempts !== undefined) {
      routing.maxAttempts = integer(input.routing.maxAttempts, 'config.routing.maxAttempts', routing.maxAttempts, 1, 3);
    }
    config.routing = routing;
  }

  if (input.execution !== undefined) {
    if (typeof input.execution !== 'object' || Array.isArray(input.execution)) {
      throw new LabError('bad_request', 'config.execution must be an object');
    }
    const execution = {
      profiles: { ...(previous.execution?.profiles ?? DEFAULT_EXECUTION_PROFILES) },
      taskTypes: { ...(previous.execution?.taskTypes ?? {}) },
    };
    if (input.execution.profiles !== undefined) {
      if (typeof input.execution.profiles !== 'object' || Array.isArray(input.execution.profiles)) {
        throw new LabError('bad_request', 'config.execution.profiles must be an object');
      }
      for (const [key, value] of Object.entries(input.execution.profiles)) {
        if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key)) {
          throw new LabError('bad_request', `invalid execution profile name: ${key}`);
        }
        execution.profiles[key] = normalizeExecutionProfile(value);
      }
    }
    if (input.execution.taskTypes !== undefined) {
      if (typeof input.execution.taskTypes !== 'object' || Array.isArray(input.execution.taskTypes)) {
        throw new LabError('bad_request', 'config.execution.taskTypes must be an object');
      }
      for (const [taskType, rawProfile] of Object.entries(input.execution.taskTypes)) {
        const key = taskType.trim();
        const profile = typeof rawProfile === 'string' ? rawProfile.trim() : '';
        if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key)) {
          throw new LabError('bad_request', `invalid task type: ${taskType}`);
        }
        if (!execution.profiles[profile]) {
          throw new LabError('bad_request', `task type ${key} uses unknown execution profile ${profile}`);
        }
        execution.taskTypes[key] = profile;
      }
    }
    config.execution = execution;
  }

  if (input.prompts !== undefined) {
    if (typeof input.prompts !== 'object' || Array.isArray(input.prompts)) {
      throw new LabError('bad_request', 'config.prompts must be an object');
    }
    const prompts = { ...(previous.prompts ?? {}) };
    for (const key of ['workerPrefix', 'advisor', 'scheduler', 'merge', 'gc']) {
      if (input.prompts[key] === undefined) continue;
      const value = text(input.prompts[key], `config.prompts.${key}`, { max: 8000 });
      if (value) prompts[key] = value;
      else delete prompts[key];
    }
    config.prompts = prompts;
  }

  if (input.advisor !== undefined) {
    if (typeof input.advisor !== 'object' || Array.isArray(input.advisor)) {
      throw new LabError('bad_request', 'config.advisor must be an object');
    }
    const advisor = {
      maxProposalsPerPass: previous.advisor?.maxProposalsPerPass ?? 3,
      maxProposalsPerReviewer: previous.advisor?.maxProposalsPerReviewer ?? 2,
      ancestorDepth: previous.advisor?.ancestorDepth ?? 2,
      acceptMode: previous.advisor?.acceptMode ?? 'auto',
      maxPendingProposals: previous.advisor?.maxPendingProposals ?? 20,
      timeoutSeconds: previous.advisor?.timeoutSeconds ?? 180,
      reviewers: previous.advisor?.reviewers ?? [],
    };
    if (input.advisor.maxProposalsPerPass !== undefined) {
      advisor.maxProposalsPerPass = integer(input.advisor.maxProposalsPerPass, 'config.advisor.maxProposalsPerPass', advisor.maxProposalsPerPass, 1, 10);
    }
    if (input.advisor.maxProposalsPerReviewer !== undefined) {
      advisor.maxProposalsPerReviewer = integer(input.advisor.maxProposalsPerReviewer, 'config.advisor.maxProposalsPerReviewer', advisor.maxProposalsPerReviewer, 1, 10);
    }
    if (input.advisor.ancestorDepth !== undefined) {
      advisor.ancestorDepth = integer(input.advisor.ancestorDepth, 'config.advisor.ancestorDepth', advisor.ancestorDepth, 1, 5);
    }
    if (input.advisor.acceptMode !== undefined) {
      const mode = input.advisor.acceptMode;
      if (mode !== 'auto' && mode !== 'confirm') {
        throw new LabError('bad_request', 'config.advisor.acceptMode must be "auto" or "confirm"');
      }
      advisor.acceptMode = mode;
    }
    if (input.advisor.maxPendingProposals !== undefined) {
      advisor.maxPendingProposals = integer(input.advisor.maxPendingProposals, 'config.advisor.maxPendingProposals', advisor.maxPendingProposals, 1, 200);
    }
    if (input.advisor.timeoutSeconds !== undefined) {
      advisor.timeoutSeconds = integer(input.advisor.timeoutSeconds, 'config.advisor.timeoutSeconds', advisor.timeoutSeconds, 30, 1800);
    }
    if (input.advisor.reviewers !== undefined) {
      if (!Array.isArray(input.advisor.reviewers)) {
        throw new LabError('bad_request', 'config.advisor.reviewers must be an array');
      }
      advisor.reviewers = input.advisor.reviewers.slice(0, 4).map((raw, index) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new LabError('bad_request', `config.advisor.reviewers[${index}] must be an object`);
        }
        const lens = text(raw.lens, `config.advisor.reviewers[${index}].lens`, { max: 120 })
          || `reviewer-${index + 1}`;
        const provider = text(raw.provider, `config.advisor.reviewers[${index}].provider`, { required: true, max: 120 });
        const model = text(raw.model, `config.advisor.reviewers[${index}].model`, { required: true, max: 200 });
        const reasoningEffort = raw.reasoningEffort === undefined
          ? undefined
          : text(raw.reasoningEffort, `config.advisor.reviewers[${index}].reasoningEffort`, { max: 40 });
        return { lens, provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
      });
    }
    config.advisor = advisor;
  }

  if (input.auto !== undefined) {
    if (typeof input.auto !== 'object' || Array.isArray(input.auto)) {
      throw new LabError('bad_request', 'config.auto must be an object');
    }
    const auto = {
      maxCycles: previous.auto?.maxCycles ?? 50,
      maxWallClockMs: previous.auto?.maxWallClockMs ?? 6 * 60 * 60 * 1000,
      idleCycleLimit: previous.auto?.idleCycleLimit ?? 3,
      debounceMs: previous.auto?.debounceMs ?? 1500,
      cooldownMs: previous.auto?.cooldownMs ?? 5000,
      maxTokens: previous.auto?.maxTokens ?? 0,
      maxCostUsd: previous.auto?.maxCostUsd ?? 0,
    };
    if (input.auto.maxCycles !== undefined) auto.maxCycles = integer(input.auto.maxCycles, 'config.auto.maxCycles', auto.maxCycles, 1, 1000);
    if (input.auto.maxWallClockMs !== undefined) auto.maxWallClockMs = integer(input.auto.maxWallClockMs, 'config.auto.maxWallClockMs', auto.maxWallClockMs, 60_000, 7 * 24 * 60 * 60 * 1000);
    if (input.auto.idleCycleLimit !== undefined) auto.idleCycleLimit = integer(input.auto.idleCycleLimit, 'config.auto.idleCycleLimit', auto.idleCycleLimit, 1, 20);
    if (input.auto.debounceMs !== undefined) auto.debounceMs = integer(input.auto.debounceMs, 'config.auto.debounceMs', auto.debounceMs, 0, 60_000);
    if (input.auto.cooldownMs !== undefined) auto.cooldownMs = integer(input.auto.cooldownMs, 'config.auto.cooldownMs', auto.cooldownMs, 0, 600_000);
    if (input.auto.maxTokens !== undefined) auto.maxTokens = integer(input.auto.maxTokens, 'config.auto.maxTokens', auto.maxTokens, 0, 2_000_000_000);
    if (input.auto.maxCostUsd !== undefined) {
      const value = Number(input.auto.maxCostUsd);
      if (!Number.isFinite(value) || value < 0 || value > 1_000_000) {
        throw new LabError('bad_request', 'config.auto.maxCostUsd must be a non-negative number');
      }
      auto.maxCostUsd = value;
    }
    config.auto = auto;
  }

  if (input.git !== undefined) {
    if (typeof input.git !== 'object' || Array.isArray(input.git)) {
      throw new LabError('bad_request', 'config.git must be an object');
    }
    const git = { ...(previous.git ?? {}) };
    if (input.git.authorName !== undefined) git.authorName = text(input.git.authorName, 'config.git.authorName', { max: 120 });
    if (input.git.authorEmail !== undefined) git.authorEmail = text(input.git.authorEmail, 'config.git.authorEmail', { max: 200 });
    if (input.git.remote !== undefined) git.remote = text(input.git.remote, 'config.git.remote', { max: 500 });
    config.git = git;
  }

  // 5.3.12: rotation threshold policy. N=14 days is the v2 default: long
  // enough for a branch to make progress, short enough to bound single-expert
  // ownership. Projects may pin N (1..365) for an explicit experiment.
  const scheduling = { ...(previous.scheduling ?? {}) };
  if (input.scheduling !== undefined) {
    if (typeof input.scheduling !== 'object' || Array.isArray(input.scheduling)) {
      throw new LabError('bad_request', 'config.scheduling must be an object');
    }
    Object.assign(scheduling, input.scheduling);
  }
  scheduling.rotationDays = integer(
    input.scheduling?.rotationDays,
    'config.scheduling.rotationDays',
    previous.scheduling?.rotationDays ?? DEFAULT_ROTATION_DAYS,
    1,
    365,
  );
  // C1: deferred nodes older than this leave the hot index. They remain in the
  // DAG with archivedAt so a human can still audit or restore them.
  scheduling.deferredTtlDays = integer(
    input.scheduling?.deferredTtlDays,
    'config.scheduling.deferredTtlDays',
    previous.scheduling?.deferredTtlDays ?? 7,
    1,
    365,
  );
  config.scheduling = scheduling;

  // 5.4.2: retention is an explicit policy, not an implicit log rotation. The
  // plan is read-only; deleting/archiving sessions remains an operator action.
  const retention = { ...(previous.retention ?? {}) };
  retention.sessionDays = integer(input.retention?.sessionDays, 'config.retention.sessionDays', retention.sessionDays ?? 90, 1, 3650);
  retention.coldAfterDays = integer(input.retention?.coldAfterDays, 'config.retention.coldAfterDays', retention.coldAfterDays ?? 7, 1, 3650);
  retention.transcriptDays = integer(input.retention?.transcriptDays, 'config.retention.transcriptDays', retention.transcriptDays ?? 180, 1, 3650);
  config.retention = retention;

  // Ensure every project has the full default shape even when created before M4.
  config.advisor = config.advisor ?? { maxProposalsPerPass: 3, maxProposalsPerReviewer: 2, ancestorDepth: 2, acceptMode: 'auto', maxPendingProposals: 20, timeoutSeconds: 180, reviewers: [] };
  config.auto = config.auto ?? { maxCycles: 50, maxWallClockMs: 6 * 60 * 60 * 1000, idleCycleLimit: 3, debounceMs: 1500, cooldownMs: 5000, maxTokens: 0, maxCostUsd: 0 };
  config.modelOptions = config.modelOptions ?? [];
  config.routing = config.routing ?? { advisorMaySelectModels: false, autoUpgrade: false, maxAttempts: 2 };
  config.models = config.models ?? {};
  config.placementPolicy = config.placementPolicy ?? { text: '', spec: null, compiledAt: null, explanation: [], warnings: [], compiler: null };

  // C14: the migration is staged, and every phase has an explicit switch. The
  // defaults keep an existing project on the legacy cycle until an operator
  // advances the phase; no project is silently moved between runtimes.
  const migration = { ...(previous.migration ?? {}), ...(input.migration ?? {}) };
  const phase = integer(migration.phase, 'config.migration.phase', previous.migration?.phase ?? 1, 1, 3);
  const expertMode = input.expertsMode ?? previous.expertsMode ?? migration.expertMode ?? 'legacy-cycle';
  if (!['legacy-cycle', 'hierarchy', 'resident'].includes(expertMode)) {
    throw new LabError('bad_request', 'config.expertsMode must be legacy-cycle, hierarchy or resident');
  }
  if (input.expertsMode !== undefined && expertMode !== 'legacy-cycle' && phase < 2) {
    throw new LabError('bad_request', 'config.expertsMode hierarchy/resident is only available from migration phase 2');
  }
  const dispatch = { ...(previous.dispatch ?? {}), ...(input.dispatch ?? {}) };
  const dispatchStrategy = dispatch.strategy ?? previous.dispatch?.strategy ?? 'deterministic';
  if (!['legacy-llm', 'shadow-deterministic', 'deterministic'].includes(dispatchStrategy)) {
    throw new LabError('bad_request', 'config.dispatch.strategy must be legacy-llm, shadow-deterministic or deterministic');
  }
  const contest = { ...(previous.contest ?? {}), ...(input.contest ?? {}) };
  const contestMode = contest.mode ?? previous.contest?.mode ?? 'off';
  if (!['off', 'shadow', 'consensus'].includes(contestMode)) {
    throw new LabError('bad_request', 'config.contest.mode must be off, shadow or consensus');
  }
  config.migration = {
    phase,
    expertMode,
    dispatchStrategy,
    contestMode,
    switchedAt: migration.switchedAt ?? previous.migration?.switchedAt ?? null,
    switchedBy: migration.switchedBy ?? previous.migration?.switchedBy ?? null,
    // S14: the parity gate must be re-run against the same fixture before a
    // phase switch; a missing result means the switch is not yet allowed.
    parity: migration.parity ?? previous.migration?.parity ?? null,
  };
  config.expertsMode = expertMode;
  config.dispatch = { ...dispatch, strategy: dispatchStrategy };
  config.contest = { ...contest, mode: contestMode };
  return config;
}

/**
 * Resolve a tool execution to an actor, but never synthesize the operator from
 * an absent execution. HTTP has no actor context; `exec=null` must fail closed
 * instead of inheriting the human operator's authority.
 */
function actorFromDisputeExecution(exec) {
  if (!exec || typeof exec !== 'object') return null;
  const session = exec.agent?.session;
  if (session && typeof session === 'object' && typeof session.id === 'string' && session.id.length > 0) {
    return actorFromToolExecution(exec);
  }
  // In-process callers may pass an already-resolved actor ({kind,id,preset}).
  // HTTP never does: it always passes null, so this cannot revive the omitted
  // operator fallback on the network path.
  if (typeof exec.kind === 'string' && typeof exec.id === 'string' && exec.id.length > 0) {
    return actorForSession({
      sessionId: exec.id,
      kind: exec.kind,
      ...(typeof exec.preset === 'string' && exec.preset ? { agentPreset: exec.preset } : {}),
    });
  }
  return null;
}


/**
 * @param {{store: object, git: object, version?: string}} deps
 */
export function createLabService({ ctx, store, git, runtime, transcript, orchestrator, auto, cluster, clusterAdmin, kernel = null, dispatchOnce = null, operatorAuthority = null, version = '0.11.0' }) {
  /**
   * Verify the Host-issued browser credential. HTTP is deliberately not the
   * source of an actor: a verified operator token is mapped to the human actor
   * here, while a missing or forged token stays an absent caller.
   * @param {unknown} token
   */
  function verifyOperatorToken(token) {
    if (!operatorAuthority || typeof operatorAuthority.verify !== 'function') {
      return { ok: false, code: 'operator_required', message: 'this Host has no operator authority' };
    }
    return operatorAuthority.verify(token);
  }

  const metricsCollector = createMetricsCollector();
  const explainer = createExplainer({ store });
  const ledgerReader = createLedgerReader({ store });
  const diffCache = createDiffCache({ maxProjects: 32 });
  // Exploration budgets are per DSH session, not per call: a model that keeps
  // navigating the DAG must run out of budget inside one pass.
  const budgets = new Map();
  const MAX_BUDGET_SESSIONS = 128;
  function requireProject(projectId) {
    const project = typeof projectId === 'string' ? store.getProject(projectId) : undefined;
    if (!project) throw new LabError('project_not_found', `unknown project: ${projectId}`, 404);
    return project;
  }

  /**
   * WP P1.7: every service mutation goes through the kernel. Callers that already
   * hold the project lock (dashboard refresh/chat, copilot bookkeeping) use
   * `commitLocked` + the write permit; everyone else uses `commit`.
   */
  async function commitMutations(projectId, mutations, options = {}) {
    if (!kernel?.executor) throw new LabError('unavailable', 'lab service requires kernel.executor', 503);
    const spec = {
      actor: options.actor ?? { kind: 'human', id: 'operator' },
      causeId: options.causeId ?? `service:${projectId}`,
      mutations,
    };
    const result = store.isProjectLocked?.(projectId) === true
      ? await store.withWritePermit(() => kernel.executor.commitLocked(projectId, spec))
      : await kernel.executor.commit(projectId, spec);
    if (result.ok !== true) {
      throw new LabError(result.code ?? 'commit_failed', result.message ?? 'commit failed', 500);
    }
    return result;
  }

  /** Replace arbitrary project fields through the executor (dashboard/chat/copilot). */
  async function commitProjectFields(projectId, set, options = {}) {
    return commitMutations(projectId, [{
      op: 'project.update',
      set,
      ...(options.eventType ? { eventType: options.eventType } : {}),
      ...(options.eventData ? { eventData: options.eventData } : {}),
    }], options);
  }

  function requireNode(projectId, nodeId) {
    const node = typeof nodeId === 'string' ? store.getNode(projectId, nodeId) : undefined;
    if (!node) throw new LabError('node_not_found', `unknown node: ${nodeId}`, 404);
    return node;
  }

  async function listProjects() {
    return store.listProjects().map((project) => ({
      id: project.id,
      name: project.name,
      repoPath: project.repo?.path,
      baseBranch: project.repo?.baseBranch,
      baseCommit: project.repo?.baseCommit,
      mode: project.mode,
      nodeCount: project.counters?.nodes ?? 0,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      revision: project.revision,
    }));
  }

  async function validateRepo(repoPath) {
    return git.validateRepo(repoPath);
  }

  async function createProject(input) {
    const name = text(input?.name, 'name', { required: true, max: 120 });
    const brief = text(input?.brief, 'brief', { required: true, max: 8000 });
    const repoPath = text(input?.repoPath, 'repoPath', { required: true, max: 4096 });

    const repo = await git.validateRepo(repoPath);
    const baseBranch = text(input?.baseBranch, 'baseBranch', { max: 256 }) || repo.defaultBranch;
    const baseCommit = await git.resolveBranch(repo.repoRoot, baseBranch);
    const config = normalizeConfig(input?.config);
    const rootExecution = resolveExecutionProfile({ config }, {
      executionProfile: input?.executionProfile,
      taskType: input?.taskType ?? 'general',
    });

    // A project may open several independent root nodes, so two or more DAG
    // branches can grow in parallel from the base commit with no edge between
    // them. `initialPrompt` describes the single-root form; `initialNodes`
    // generalises it to N roots. Every root gets its own branch/worktree.
    const rootSpecs = [];
    const initialNodes = Array.isArray(input?.initialNodes) ? input.initialNodes : null;
    if (initialNodes && initialNodes.length > 0) {
      if (initialNodes.length > MAX_ROOT_NODES) {
        throw new LabError('bad_request', `initialNodes supports at most ${MAX_ROOT_NODES} root nodes`, 400);
      }
      const maxMinutes = config.maxNodeTimeoutMinutes ?? 240;
      initialNodes.forEach((spec, index) => {
        const label = `initialNodes[${index}]`;
        // A title is a label: clamp it rather than rejecting the whole request.
        const title = clampNodeTitle(text(spec?.title, `${label}.title`, { required: true }));
        const prompt = text(spec?.prompt, `${label}.prompt`, { required: true, max: 8000 });
        if (prompt.length < 10) {
          throw new LabError('bad_request', `${label}.prompt must be at least 10 characters`, 400);
        }
        let needs = {};
        if (spec?.needs !== undefined) {
          const checked = normalizeNeeds(spec.needs, { config });
          if (checked.error) throw new LabError('bad_request', `${label}: ${checked.error}`, 400);
          needs = checked.needs;
        }
        const timeboxMinutes = spec?.timeboxMinutes === undefined
          ? config.nodeTimeoutMinutes
          : spec.timeboxMinutes;
        if (!Number.isInteger(timeboxMinutes) || timeboxMinutes < 1 || timeboxMinutes > maxMinutes) {
          throw new LabError('bad_request', `${label}.timeboxMinutes must be 1..${maxMinutes}`, 400);
        }
        rootSpecs.push({ title, prompt, needs, timeboxMinutes });
      });
    } else {
      const initialPrompt = text(input?.initialPrompt, 'initialPrompt', { required: true, max: 8000 });
      if (initialPrompt.length < 10) throw new LabError('bad_request', 'initialPrompt must be at least 10 characters');
      let rootNeeds = {};
      if (input?.needs !== undefined) {
        const checked = normalizeNeeds(input.needs, { config });
        if (checked.error) throw new LabError('bad_request', checked.error, 400);
        rootNeeds = checked.needs;
      }
      rootSpecs.push({
        title: '根节点',
        prompt: initialPrompt,
        needs: rootNeeds,
        timeboxMinutes: config.nodeTimeoutMinutes,
      });
    }

    const projectId = newProjectId();
    const now = Date.now();
    const worktreeRoot = store.worktreeRootFor(projectId);
    const project = {
      id: projectId,
      name,
      brief,
      controllerSessionId: newSessionId(),
      repo: {
        path: repo.repoRoot,
        gitDir: repo.gitDir,
        baseBranch,
        baseCommit,
        worktreeRoot,
      },
      mode: 'manual',
      config,
      counters: { nextNodeSeq: rootSpecs.length + 1, nodes: rootSpecs.length, cycles: 0, eventSeq: 0 },
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };

    const rootNodes = rootSpecs.map((spec, index) => {
      const nodeId = `n-${String(index + 1).padStart(4, '0')}`;
      return {
        id: nodeId,
        projectId,
        title: spec.title,
        anchorSessionId: newSessionId(),
        sessionId: newSessionId(),
        deadlineAt: null,
        prompt: spec.prompt,
        successCriteria: '',
        status: 'planned',
        execution: {
          profile: rootExecution.profile,
          driver: rootExecution.driver,
          ...(rootExecution.model ? { model: rootExecution.model } : {}),
          ...(rootExecution.reasoningEffort ? { reasoningEffort: rootExecution.reasoningEffort } : {}),
          ...(rootExecution.codexPath ? { codexPath: rootExecution.codexPath } : {}),
        },
        taskType: rootExecution.taskType,
        parentId: null,
        createdBy: 'seed',
        needs: spec.needs,
        timeboxMs: spec.timeboxMinutes * 60_000,
        git: {
          branch: `dshex/${projectId}/${nodeId}`,
          worktreePath: path.join(worktreeRoot, nodeId),
          baseCommit,
          headCommit: null,
        },
        timestamps: { createdAt: now, lastActivityAt: null },
      };
    });

    if (!kernel?.executor) throw new LabError('unavailable', 'lab service requires kernel.executor', 503);
    const created = await kernel.executor.bootstrapProject(projectId, project, {
      actor: { kind: 'human', id: 'operator' },
      causeId: `project:${projectId}:created`,
      mutations: [
        {
          op: 'event.record',
          type: 'project/created',
          data: {
            name,
            repoPath: repo.repoRoot,
            baseBranch,
            baseCommit,
            rootNodeIds: rootNodes.map((node) => node.id),
          },
        },
        ...rootNodes.map((node) => ({
          op: 'node.create',
          node,
          eventData: { title: node.title, status: node.status, createdBy: node.createdBy, isRoot: true },
        })),
      ],
    });
    if (created.ok !== true) {
      throw new LabError(created.code ?? 'commit_failed', created.message ?? 'project creation failed', 500);
    }
    const storedProject = requireProject(projectId);
    const byId = new Map(store.listNodes(projectId).map((node) => [node.id, node]));
    const storedRoots = rootNodes.map((node) => byId.get(node.id)).filter(Boolean);
    return { project: storedProject, rootNode: storedRoots[0], rootNodes: storedRoots, revision: storedProject.revision };
  }

  /**
   * `state` is an index, not an archive (S4/D16): prompts and report bodies are
   * capped here and the full records are fetched per node on selection
   * (`getNode`). Without this, 5,000 nodes serialize to ~80 MB.
   */
  function stateNode(node) {
    return slimStateNode(node);
  }

  async function getState(projectId, sinceRevision, options = {}) {
    const project = requireProject(projectId);
    if (sinceRevision !== undefined && sinceRevision !== null && sinceRevision !== '') {
      const parsed = Number(sinceRevision);
      if (Number.isFinite(parsed) && parsed === project.revision) {
        return { unchanged: true, revision: project.revision };
      }
    }
    const allRaw = runtime
      ? runtime.decorateNodes(projectId, store.listNodes(projectId))
      : store.listNodes(projectId);
    // HTTP callers page this response; internal callers may pass `limit: null`
    // to get the full index in one object.
    const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(5000, Math.trunc(options.limit))) : null;
    const cursor = typeof options.cursor === 'string' && options.cursor ? options.cursor : null;
    let start = 0;
    if (limit !== null && cursor) {
      const at = allRaw.findIndex((node) => node.id === cursor);
      start = at >= 0 ? at + 1 : 0;
    }
    const rawNodes = limit === null ? allRaw : allRaw.slice(start, start + limit);
    const nextCursor = limit !== null && start + rawNodes.length < allRaw.length
      ? rawNodes[rawNodes.length - 1]?.id ?? null
      : null;
    const projected = options.full === true ? rawNodes : rawNodes.map(stateNode);
    const parentIds = new Set();
    for (const node of allRaw) {
      if (node.status === 'proposed') continue;
      const ids = Array.isArray(node.parentIds) && node.parentIds.length > 0
        ? node.parentIds
        : (node.parentId ? [node.parentId] : []);
      for (const id of ids) parentIds.add(id);
    }
    const nodes = projected.map((node) => ({
      ...node,
      sealed: parentIds.has(node.id),
      isLeaf: !parentIds.has(node.id),
    }));
    const edges = [];
    for (const node of nodes) {
      const ids = Array.isArray(node.parentIds) && node.parentIds.length > 0
        ? node.parentIds
        : (node.parentId ? [node.parentId] : []);
      for (const id of ids) edges.push({ from: id, to: node.id });
    }

    const pools = project.config?.resourcePools ?? {};
    const held = {};
    for (const node of allRaw) {
      if (node.status !== 'running' || !node.resourcesHeld) continue;
      for (const [key, amount] of Object.entries(node.resourcesHeld)) {
        held[key] = (held[key] ?? 0) + amount;
      }
    }
    const free = {};
    for (const [key, total] of Object.entries(pools)) {
      free[key] = Math.max(0, total - (held[key] ?? 0));
    }

    return publicView({
      project,
      nodes,
      edges,
      resources: { pools, held, free },
      worktreeRoot: project.repo?.worktreeRoot,
      revision: project.revision,
      lastEventSeq: project.counters?.eventSeq ?? 0,
      pendingProposals: allRaw.filter((node) => node.status === 'proposed').length,
      archivedCount: store.countArchived(projectId),
      // Q12: the UI and MCP can read the intent boundary and claim map without
      // scanning every event. `writer` makes the single-writer invariant explicit.
      intents: (() => {
        const boundary = detectIntentConflicts(project.intents ?? []);
        return { ...boundary, claims: allRaw.filter((node) => node.claim).map((node) => ({ nodeId: node.id, status: node.claim.status ?? 'claimed', by: node.claim.strategyId ?? null, at: node.claim.at ?? null })) };
      })(),
      auto: auto ? auto.statusOf(projectId) : { status: 'off', pauseReason: null },
      cluster: cluster ? cluster.getStatus() : { enabled: false, mode: 'local' },
      _indexed: options.full !== true,
      nextCursor,
      _truncated: nextCursor !== null ? { nodes: { shown: nodes.length, total: allRaw.length } } : null,
    });
  }

  /** Bounded node list for MCP/host surfaces that must not dump the DAG. */
  function listNodesPage(projectId, { limit = 100, cursor = null, status = null } = {}) {
    const project = requireProject(projectId);
    const size = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.trunc(limit))) : 100;
    const all = status ? store.listNodes(projectId).filter((node) => node.status === status) : store.listNodes(projectId);
    const start = typeof cursor === 'string' && cursor ? Math.max(0, all.findIndex((node) => node.id === cursor) + 1) : 0;
    const nodes = all.slice(start, start + size);
    const nextCursor = start + size < all.length ? nodes[nodes.length - 1]?.id ?? null : null;
    return {
      ok: true,
      projectId,
      revision: project.revision,
      nodes,
      count: nodes.length,
      total: all.length,
      nextCursor,
      hasMore: nextCursor !== null,
      _truncated: nextCursor !== null ? { nodes: { shown: nodes.length, total: all.length } } : null,
    };
  }

  /** Full record for one node (inspector/agent deep read); O(1) via the store index. */
  function getNode(projectId, nodeId) {
    requireProject(projectId);
    const node = store.getNode(projectId, nodeId);
    if (!node) throw new LabError('node_not_found', `unknown node: ${nodeId}`, 404);
    const hasChildren = store.hasChildren(projectId, node.id);
    return publicView({ ok: true, node, sealed: hasChildren, isLeaf: !hasChildren });
  }

  /** Delta read (S10): node ids changed since a revision, or `full` when unknowable. */
  function changesSince(projectId, sinceRevision) {
    requireProject(projectId);
    // Raw event data may contain an actor key on a dispute resolution row;
    // every read surface strips keys before returning it.
    return publicView(store.changesSince(projectId, sinceRevision));
  }

  const dashboardRuns = new Map();
  const dashboardChatRuns = new Map();

  function dashboardOf(project) {
    const stored = project.dashboard && typeof project.dashboard === 'object' ? project.dashboard : {};
    const chat = (Array.isArray(stored.chat) ? stored.chat.slice(-60) : []).map((entry) => ({
      ...entry,
      // Attribution is structural, not a rendering choice: a chat reply is
      // agent-authored even though it is stored next to Host facts.
      source: entry?.role === 'user' ? 'human' : 'agent',
    }));
    return {
      spec: sanitizeDashboardSpec(stored.spec ?? DEFAULT_DASHBOARD_SPEC, DEFAULT_DASHBOARD_SPEC),
      widgets: Array.isArray(stored.widgets) ? stored.widgets : [],
      chat,
      lastRun: stored.lastRun ?? null,
      lastChat: stored.lastChat ?? null,
      nextRunAt: stored.nextRunAt ?? null,
      updatedAt: stored.updatedAt ?? null,
    };
  }

  /** Host-computed facts only; no widget body, chat text or agent prose. */
  function dashboardHostFacts(project) {
    const nodes = store.listNodes(project.id);
    const running = nodes.filter((node) => node.status === 'running');
    const pools = project.config?.resourcePools ?? {};
    const held = {};
    for (const node of running) {
      for (const [key, amount] of Object.entries(node.resourcesHeld ?? {})) held[key] = (held[key] ?? 0) + amount;
    }
    const free = Object.fromEntries(Object.entries(pools).map(([key, total]) => [key, Math.max(0, Number(total) - (held[key] ?? 0))]));
    // O12: GPU, cost and narrative are structured Host facts, not prose a model
    // can rewrite. `narrative` is a stable list of sections for the UI.
    const gpuTotal = Math.max(0, Number(pools.gpu ?? 0));
    const gpuHeld = Math.max(0, Number(held.gpu ?? 0));
    const gpu = {
      total: gpuTotal,
      held: gpuHeld,
      free: Math.max(0, gpuTotal - gpuHeld),
      utilization: gpuTotal > 0 ? Number((gpuHeld / gpuTotal).toFixed(3)) : null,
      runningNodes: running.filter((node) => Number(node.needs?.gpu ?? node.resourcesHeld?.gpu ?? 0) > 0).length,
    };
    const tokensUsed = Math.max(0, Number(project.counters?.tokensUsed ?? 0));
    const costUsd = Number(project.counters?.costUsd ?? 0);
    const cost = {
      tokensUsed,
      costUsd: Number.isFinite(costUsd) ? Number(costUsd.toFixed(6)) : 0,
      maxTokens: Number(project.config?.auto?.maxTokens ?? 0),
      maxCostUsd: Number(project.config?.auto?.maxCostUsd ?? 0),
      tokenUtilization: Number(project.config?.auto?.maxTokens ?? 0) > 0
        ? Number((tokensUsed / Number(project.config.auto.maxTokens)).toFixed(3)) : null,
      costUtilization: Number(project.config?.auto?.maxCostUsd ?? 0) > 0
        ? Number((costUsd / Number(project.config.auto.maxCostUsd)).toFixed(3)) : null,
    };
    return {
      source: 'host',
      computedAt: Date.now(),
      projectRevision: project.revision ?? 0,
      counts: {
        total: nodes.length,
        running: running.length,
        planned: nodes.filter((node) => node.status === 'planned').length,
        completed: nodes.filter((node) => node.status === 'completed').length,
        failed: nodes.filter((node) => node.status === 'failed').length,
        deferred: nodes.filter((node) => node.status === 'deferred' && !node.archivedAt).length,
        archived: nodes.filter((node) => node.archivedAt).length,
      },
      resources: pools,
      gpu,
      cost,
      narrative: {
        headline: `${running.length} running · ${nodes.filter((node) => node.status === 'planned').length} queued`,
        sections: [
          { key: 'execution', label: 'Execution', values: { running: running.length, queued: nodes.filter((node) => node.status === 'planned').length, completed: nodes.filter((node) => node.status === 'completed').length, failed: nodes.filter((node) => node.status === 'failed').length } },
          { key: 'gpu', label: 'GPU', values: gpu },
          { key: 'cost', label: 'Cost', values: cost },
        ],
      },
    };
  }

  function dashboardView(project) {
    const dash = dashboardOf(project);
    const now = Date.now();
    const staleAfterMs = Math.max(60_000, dash.spec.intervalMinutes * 2 * 60_000);
    const lastRun = dash.lastRun && typeof dash.lastRun === 'object' ? dash.lastRun : null;
    // A partial refresh is a failure for freshness purposes: at least one
    // widget did not update, so the top-level commentary must not claim fresh.
    const failed = lastRun?.status === 'error' || lastRun?.status === 'partial';
    const consecutiveFailures = Number.isInteger(lastRun?.consecutiveFailures) ? lastRun.consecutiveFailures : 0;
    const lastSuccessAt = Number.isFinite(lastRun?.lastSuccessAt)
      ? lastRun.lastSuccessAt
      : (!failed && Number.isFinite(lastRun?.endedAt) ? lastRun.endedAt : null);
    const degraded = failed && consecutiveFailures >= 3;
    const widgets = dash.widgets.map((widget) => {
      const config = widget.config && typeof widget.config === 'object' ? widget.config : {};
      const at = Number.isFinite(widget.updatedAt) ? widget.updatedAt : null;
      const ageMs = at === null ? null : Math.max(0, now - at);
      return {
        ...widget,
        dataSource: config.collector === 'script' || config.script ? 'host' : 'agent',
        ageMs,
        stale: at === null || ageMs > staleAfterMs,
        degraded,
        lastSuccessAt: at,
      };
    });
    const times = widgets.map((widget) => widget.updatedAt).filter((at) => Number.isFinite(at));
    if (Number.isFinite(lastSuccessAt)) times.push(lastSuccessAt);
    const commentaryAt = times.length > 0 ? Math.max(...times) : null;
    const ageMs = commentaryAt === null ? null : Math.max(0, now - commentaryAt);
    // `revision` is the revision the refresh actually read. The dashboard's own
    // metadata write also advances the project revision, so freshness compares
    // the post-write `committedRevision` when it is present.
    const revisionKey = Number.isInteger(lastRun?.committedRevision)
      ? lastRun.committedRevision
      : lastRun?.revision;
    const revisionChanged = Number.isInteger(revisionKey) && revisionKey !== (project.revision ?? 0);
    // A failed refresh is never evidence of freshness. Even when the project
    // revision happens to match the last successful read, the attempt failed and
    // the old commentary must stay visibly stale.
    const stale = failed || commentaryAt === null || ageMs > staleAfterMs || revisionChanged;
    const staleReason = failed
      ? (lastRun?.status === 'partial' ? 'refresh_partial' : 'refresh_failed')
      : commentaryAt === null
        ? 'never_generated'
        : revisionChanged
          ? 'revision_changed'
          : stale ? 'age' : null;
    return {
      projectId: project.id,
      ...dash,
      widgets,
      hostFacts: dashboardHostFacts(project),
      commentary: {
        source: 'agent',
        generatedAt: commentaryAt,
        lastSuccessAt,
        lastAttemptAt: Number.isFinite(lastRun?.endedAt) ? lastRun.endedAt : null,
        ageMs,
        stale,
        staleReason,
        staleAfterMs,
        failureCount: consecutiveFailures,
        degraded,
        error: typeof lastRun?.error === 'string' ? lastRun.error : null,
      },
      stale,
      ageMs,
      staleReason,
      failureCount: consecutiveFailures,
      degraded,
    };
  }

  function dashboardSnapshot(project) {
    const nodes = store.listNodes(project.id).map((node) => ({
      id: node.id,
      title: node.title,
      status: node.status,
      kind: node.kind ?? 'experiment',
      createdBy: node.createdBy,
      execution: node.execution ?? null,
      executionRun: node.executionRun ?? null,
      needs: node.needs ?? {},
      git: node.git ? { branch: node.git.branch, headCommit: node.git.headCommit } : null,
      report: node.report ?? null,
      reportText: (node.reportText ?? '').slice(0, 1200),
      error: node.error ?? null,
      timestamps: node.timestamps ?? null,
      usage: node.usage ?? null,
    }));
    const runs = store.listRuns(project.id, 20).map((run) => ({
      id: run.id,
      role: run.role,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      proposals: Array.isArray(run.output?.proposals) ? run.output.proposals.length : 0,
      error: run.error ?? null,
    }));
    return {
      project: { id: project.id, name: project.name, brief: project.brief, mode: project.mode, revision: project.revision },
      nodes,
      runs,
      resources: project.config?.resourcePools ?? {},
      counts: {
        total: nodes.length,
        running: nodes.filter((node) => node.status === 'running').length,
        completed: nodes.filter((node) => node.status === 'completed').length,
        failed: nodes.filter((node) => node.status === 'failed').length,
        planned: nodes.filter((node) => node.status === 'planned').length,
      },
    };
  }

  function runWidgetScript(script, cwd) {
    return new Promise((resolve, reject) => {
      const command = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
      const args = process.platform === 'win32' ? ['/d', '/s', '/c', script] : ['-c', script];
      const child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 120_000);
      child.stdout?.on('data', (chunk) => { if (stdout.length < 2_000_000) stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk) => { if (stderr.length < 100_000) stderr += chunk.toString(); });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new LabError('dashboard_script_failed', `widget script exited with code ${code}: ${stderr.trim().slice(0, 1000)}`, 500));
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          resolve(normalizeWidgetData(parsed?.data ?? parsed));
        } catch (error) {
          reject(error instanceof LabError ? error : new LabError('dashboard_script_invalid', `widget script did not return JSON data: ${error instanceof Error ? error.message : String(error)}`, 500));
        }
      });
    });
  }

  async function runDashboardAgent(project, prompt, outputSchema = WIDGET_DATA_RESULT_SCHEMA) {
    if (!ctx.subagents || !orchestrator) throw new LabError('unavailable', 'dashboard agent runtime is unavailable', 503);
    const controller = await orchestrator.ensureController(project);
    const model = resolveModelSelection(ctx, project, null, 'dashboard');
    const deadlineMs = 600_000;
    // A dashboard edit is one very large structured_output call (the agent returns the
    // whole widget list), and a provider can end the turn with an unusable tool payload
    // (e.g. MALFORMED_RESPONSE). One retry keeps a single bad stream from losing the edit.
    const maxAttempts = 2;
    let lastReason = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const abort = new AbortController();
      let activation = null;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        abort.abort();
        try { activation?.dispose?.().catch?.(() => {}); } catch {}
      }, deadlineMs);
      const attemptPrompt = attempt === 1
        ? prompt
        : `${prompt}\n\n# Retry\nThe previous attempt ended with an unusable tool payload (invalid JSON).\nProduce the same content again, but keep every string short (aim for <= 600 characters per widget query) so the structured_output payload stays small and valid.`;
      try {
        activation = await ctx.subagents.startActivation({
          provider: 'spawn',
          label: `mir-dashboard/${project.id}`,
          delivery: 'caller',
          signal: abort.signal,
          request: {
            parent: controller,
            cwd: project.repo.path,
            prompt: [{ type: 'text', text: attemptPrompt }],
            agentPreset: 'lab-dashboard',
            agentOptions: {
              provider: model.provider,
              model: model.model,
              ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
            },
            outputSchema,
          },
        });
        const timeout = new Promise((_, reject) => {
          setTimeout(() => reject(new LabError('dashboard_timeout', `dashboard agent did not finish within ${Math.round(deadlineMs / 1000)}s`, 504)), deadlineMs + 500);
        });
        const result = await Promise.race([activation.result, timeout]);
        if (timedOut) throw new LabError('dashboard_timeout', `dashboard agent did not finish within ${Math.round(deadlineMs / 1000)}s`, 504);
        if (result.stopReason === 'completed' && result.structured) {
          return { result: result.structured, agentSessionId: activation.childId ?? null };
        }
        lastReason = result.stopReason ?? 'unknown';
        if (result.stopReason !== 'error') break;
      } finally {
        clearTimeout(timer);
        try { await activation?.dispose(); } catch {}
      }
    }
    throw new LabError('dashboard_agent_failed', `dashboard agent stopped: ${lastReason ?? 'unknown'}`, 500);
  }

  async function refreshDashboard(projectId, options = {}) {
    if (dashboardRuns.has(projectId)) return dashboardRuns.get(projectId);
    const project = requireProject(projectId);
    const current = dashboardOf(project);
    if (current.spec.enabled !== true && options.force !== true) {
      throw new LabError('dashboard_disabled', 'dashboard is disabled', 409);
    }
    if (current.widgets.length === 0) {
      throw new LabError('dashboard_empty', 'dashboard has no widgets to refresh', 409);
    }
    const task = (async () => {
      const startedAt = Date.now();
      // The revision the refresh actually starts from. The outer `project`
      // snapshot can predate a successful commit by two revisions; recording it
      // made every later view look permanently revision_changed.
      const readRevision = requireProject(projectId).revision ?? 0;
      await store.withProjectLock(projectId, async () => {
        const locked = requireProject(projectId);
        const previous = locked.dashboard?.lastRun && typeof locked.dashboard.lastRun === 'object'
          ? locked.dashboard.lastRun
          : {};
        locked.dashboard = {
          ...(locked.dashboard ?? {}),
          lastRun: {
            ...previous,
            status: 'running',
            startedAt,
            revision: previous.revision ?? null,
            lastSuccessAt: previous.lastSuccessAt
              ?? (previous.status !== 'error' && Number.isFinite(previous.endedAt) ? previous.endedAt : null),
            consecutiveFailures: previous.consecutiveFailures ?? 0,
            error: null,
          },
        };
        await commitProjectFields(projectId, { dashboard: locked.dashboard });
      });
      const errors = [];
      let updated = 0;
      const widgets = [];
      // Each widget owns its own collector; refresh them independently.
      for (const widget of current.widgets) {
        const config = widget.config && typeof widget.config === 'object' ? widget.config : {};
        try {
          let data;
          let agentSessionId = null;
          if (config.collector === 'script' || config.script) {
            if (!config.script) throw new LabError('widget_script_required', 'widget script is empty', 400);
            data = await runWidgetScript(config.script, project.repo.path);
          } else {
            const generated = await runDashboardAgent(
              requireProject(projectId),
              buildWidgetPrompt(requireProject(projectId), widget, dashboardSnapshot(requireProject(projectId))),
              WIDGET_DATA_RESULT_SCHEMA,
            );
            data = normalizeWidgetData(generated.result.data);
            agentSessionId = generated.agentSessionId;
          }
          widgets.push({
            ...widget,
            data,
            updatedAt: Date.now(),
            lastRefresh: { status: 'ok', at: Date.now(), agentSessionId, error: null },
          });
          updated += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push({
            widgetId: widget.id,
            title: widget.title,
            error: message,
            code: typeof error?.code === 'string' ? error.code : 'error',
          });
          widgets.push({
            ...widget,
            lastRefresh: { status: 'error', at: Date.now(), agentSessionId: null, error: message },
          });
        }
      }
      const now = Date.now();
      const status = errors.length === 0 ? 'ok' : updated > 0 ? 'partial' : 'error';
      const failed = status !== 'ok';
      await store.withProjectLock(projectId, async () => {
        const locked = requireProject(projectId);
        const previous = locked.dashboard?.lastRun && typeof locked.dashboard.lastRun === 'object'
          ? locked.dashboard.lastRun
          : {};
        const previousFailures = Number.isInteger(previous.consecutiveFailures) ? previous.consecutiveFailures : 0;
        const consecutiveFailures = failed ? previousFailures + 1 : 0;
        // Preserve the last success on failure; do not copy this attempt's
        // revision or timestamp into the freshness inputs.
        const lastSuccessAt = failed
          ? (Number.isFinite(previous.lastSuccessAt)
            ? previous.lastSuccessAt
            : (!['error', 'partial'].includes(previous.status) && Number.isFinite(previous.endedAt) ? previous.endedAt : null))
          : now;
        const intervalMs = Math.max(60_000, current.spec.intervalMinutes * 60_000);
        // Exponential backoff after total failures, capped at 30 minutes. This
        // is the degradation: a broken dashboard stops hammering its collector.
        const backoffMs = failed
          ? Math.min(30 * 60_000, intervalMs * (2 ** Math.min(consecutiveFailures - 1, 4)))
          : intervalMs;
        locked.dashboard = {
          ...(locked.dashboard ?? {}),
          spec: current.spec,
          widgets,
          lastRun: {
            status,
            startedAt,
            endedAt: now,
            durationMs: now - startedAt,
            // Record the revision the data actually came from; the dashboard
            // write itself advances the project revision, so keep the
            // post-write revision separately for the freshness comparison.
            revision: failed ? (previous.revision ?? null) : readRevision,
            dataRevision: failed ? (previous.dataRevision ?? null) : readRevision,
            committedRevision: failed ? (previous.committedRevision ?? null) : ((locked.revision ?? 0) + 1),
            lastSuccessAt,
            consecutiveFailures,
            failedAt: failed ? now : (previous.failedAt ?? null),
            updated,
            errors,
            error: errors.length > 0 ? `${errors.length} widget(s) failed` : null,
            errorCode: errors[0]?.code ?? null,
            errorHint: errors[0]?.code ? (NEXT_STEPS[errors[0].code] ?? NEXT_STEPS.error) : null,
          },
          updatedAt: now,
          nextRunAt: current.spec.enabled ? now + backoffMs : null,
        };
        await commitProjectFields(projectId, { dashboard: locked.dashboard }, {
          eventType: status === 'ok' ? 'dashboard/updated' : status === 'partial' ? 'dashboard/partial' : 'dashboard/failed',
          eventData: { updated, errors: errors.length, durationMs: now - startedAt, consecutiveFailures },
        });
      });
      return dashboardView(requireProject(projectId));
    })();
    dashboardRuns.set(projectId, task);
    // A completed run must not become a permanent memoized response: the next
    // refresh has to collect fresh data. Keep the in-flight dedupe only.
    task.finally(() => {
      if (dashboardRuns.get(projectId) === task) dashboardRuns.delete(projectId);
    }).catch(() => {});
    return task;
  }

  async function chatDashboard(projectId, textValue) {
    const text = typeof textValue === 'string' ? textValue.trim() : '';
    if (!text) throw new LabError('bad_request', 'dashboard chat text is required', 400);
    if (text.length > 8000) throw new LabError('bad_request', 'dashboard chat text is too long', 400);
    if (dashboardChatRuns.has(projectId)) return getDashboard(projectId);
    const project = requireProject(projectId);
    const current = dashboardOf(project);
    const at = Date.now();
    const userMessage = { role: 'user', text, at };
    const pendingMessage = { role: 'assistant', text: 'Dashboard agent is working…', at, pending: true };
    const history = [...current.chat, userMessage].slice(-60);
    await store.withProjectLock(projectId, async () => {
      const locked = requireProject(projectId);
      locked.dashboard = {
        ...(locked.dashboard ?? {}),
        spec: current.spec,
        widgets: current.widgets,
        chat: [...history, pendingMessage].slice(-60),
        lastChat: { status: 'running', startedAt: at },
      };
      await commitProjectFields(projectId, { dashboard: locked.dashboard });
    });
    const task = (async () => {
      try {
        const generated = await runDashboardAgent(
          requireProject(projectId),
          buildDashboardChatPrompt(requireProject(projectId), current.spec, dashboardSnapshot(requireProject(projectId)), current.widgets, history, text),
          DASHBOARD_CHAT_SCHEMA,
        );
        const widgets = normalizeWidgets(generated.result.widgets ?? [], current.widgets);
        const requestedSpec = generated.result.spec && typeof generated.result.spec === 'object'
          ? generated.result.spec
          : null;
        const nextSpec = requestedSpec
          ? sanitizeDashboardSpec({ ...current.spec, ...requestedSpec }, current.spec)
          : current.spec;
        const assistantMessage = {
          role: 'assistant',
          text: typeof generated.result.reply === 'string' && generated.result.reply.trim() ? generated.result.reply.trim() : 'Dashboard updated.',
          at: Date.now(),
        };
        await store.withProjectLock(projectId, async () => {
          const locked = requireProject(projectId);
          locked.dashboard = {
            ...(locked.dashboard ?? {}),
            spec: nextSpec,
            widgets,
            chat: [...history, assistantMessage].slice(-60),
            lastChat: { status: 'ok', startedAt: at, endedAt: Date.now(), agentSessionId: generated.agentSessionId },
            updatedAt: Date.now(),
            nextRunAt: nextSpec.enabled ? Date.now() + nextSpec.intervalMinutes * 60_000 : null,
          };
          await commitProjectFields(projectId, { dashboard: locked.dashboard }, {
            eventType: 'dashboard/chat',
            eventData: { widgetCount: widgets.length },
          });
        });
      } catch (error) {
        await store.withProjectLock(projectId, async () => {
          const locked = requireProject(projectId);
          locked.dashboard = {
            ...(locked.dashboard ?? {}),
            chat: [...history, { role: 'assistant', text: `Dashboard update failed: ${error instanceof Error ? error.message : String(error)}`, at: Date.now(), error: true }].slice(-60),
            lastChat: { status: 'error', startedAt: at, endedAt: Date.now(), error: error instanceof Error ? error.message : String(error) },
          };
          await commitProjectFields(projectId, { dashboard: locked.dashboard });
        });
      } finally {
        dashboardChatRuns.delete(projectId);
      }
    })();
    dashboardChatRuns.set(projectId, task);
    return getDashboard(projectId);
  }

  async function updateDashboardLayout(projectId, layouts) {
    const project = requireProject(projectId);
    const current = dashboardOf(project);
    if (!Array.isArray(layouts)) throw new LabError('bad_request', 'layouts must be an array', 400);
    const allowed = new Set(current.widgets.map((widget) => widget.id));
    const safe = layouts.filter((entry) => entry && typeof entry.id === 'string' && allowed.has(entry.id));
    await commitProjectFields(projectId, {
      dashboard: {
        ...(project.dashboard ?? {}),
        widgets: applyWidgetLayouts(current.widgets, safe),
        updatedAt: Date.now(),
      },
    });
    return { ...dashboardView(requireProject(projectId)), running: dashboardRuns.has(projectId) };
  }

  async function getDashboard(projectId, actor = null) {
    const project = requireProject(projectId);
    let dash = dashboardOf(project);
    if (dash.lastChat?.status === 'running' && !dashboardChatRuns.has(projectId)) {
      const message = 'Dashboard chat was interrupted or timed out. Please retry.';
      await commitProjectFields(projectId, {
        dashboard: {
          ...(project.dashboard ?? {}),
          chat: [
            ...dash.chat.filter((entry) => !entry?.pending),
            { role: 'assistant', text: message, at: Date.now(), error: true },
          ].slice(-60),
          lastChat: {
            ...(dash.lastChat ?? {}),
            status: 'error',
            endedAt: Date.now(),
            error: message,
          },
        },
      }, { actor: actor ?? { kind: 'system', id: 'dashboard-watchdog' } });
      dash = dashboardOf(requireProject(projectId));
    }
    return { ...dashboardView(requireProject(projectId)), running: dashboardRuns.has(projectId), chatting: dashboardChatRuns.has(projectId) };
  }

  async function updateDashboard(projectId, input) {
    const project = requireProject(projectId);
    const current = dashboardOf(project);
    const spec = sanitizeDashboardSpec(input?.spec ?? input, current.spec);
    const next = {
      ...(project.dashboard ?? {}),
      spec,
      widgets: current.widgets,
      chat: current.chat,
      lastRun: current.lastRun,
      lastChat: current.lastChat,
      updatedAt: Date.now(),
      nextRunAt: spec.enabled ? Date.now() + spec.intervalMinutes * 60_000 : null,
    };
    await commitProjectFields(projectId, { dashboard: next }, {
      eventType: 'dashboard/spec_updated',
      eventData: { enabled: spec.enabled, intervalMinutes: spec.intervalMinutes },
    });
    return { ...dashboardView(requireProject(projectId)), running: dashboardRuns.has(projectId), chatting: dashboardChatRuns.has(projectId) };
  }

  async function tickDashboards() {
    for (const project of store.listProjects()) {
      const dash = dashboardOf(project);
      if (!dash.spec.enabled) continue;
      if (dash.nextRunAt !== null && dash.nextRunAt > Date.now()) continue;
      if (dashboardRuns.has(project.id)) continue;
      refreshDashboard(project.id, { force: false }).catch(() => {});
    }
  }

  function startDashboardScheduler() {
    const timer = setInterval(() => { tickDashboards().catch(() => {}); }, 30_000);
    return () => clearInterval(timer);
  }

  async function getEvents(projectId, after = 0, options = {}) {
    requireProject(projectId);
    const parsedAfter = Number.isFinite(Number(after)) ? Math.max(0, Math.trunc(Number(after))) : 0;
    if (options.limit !== undefined) {
      const page = store.pageEvents(projectId, { after: parsedAfter, limit: options.limit });
      return publicView({ events: page.events, next: store.maxEventSeq(projectId), page: { total: page.total, hasMore: page.hasMore, nextSeq: page.nextSeq }, _truncated: page.hasMore ? { shown: page.events.length, total: page.total } : null });
    }
    const events = store.listEvents(projectId, parsedAfter);
    return publicView({ events, next: store.maxEventSeq(projectId) });
  }

  const OBSERVER_STALL_MS = 15 * 60_000;
  const queueOverloadSince = new Map();
  const OBSERVER_STARVE_MS = 10 * 60_000;
  // The cheap observer long-polls for a full minute; a shorter cap would make
  // the external model poll more often than the checklist (5.3.13) allows.
  const OBSERVER_MAX_WAIT_MS = 60_000;

  /**
   * 5.3.13 observe surface: what is running, what is idle, what the event cursor
   * is and which nodes are stalled, starving, or held by a paused driver.
   * Read-only; escalation writes happen in escalateStalled().
   */
  function observerSnapshot(projectId, { now = Date.now(), stallMs = OBSERVER_STALL_MS, starveMs = OBSERVER_STARVE_MS } = {}) {
    const project = requireProject(projectId);
    const nodes = store.listNodes(projectId);
    const events = store.listEvents(projectId, Math.max(0, store.maxEventSeq(projectId) - 40));
    const lastEventByNode = new Map();
    const progressEvents = new Set(['node/started', 'node/activity', 'node/resumed', 'turn/start', 'turn/end', 'assistant/message', 'tool/call', 'tool/use', 'tool/result', 'reasoning/message', 'step/start', 'step/end']);
    for (const event of events) {
      if (!event?.nodeId || !progressEvents.has(event.type)) continue;
      lastEventByNode.set(event.nodeId, Math.max(lastEventByNode.get(event.nodeId) ?? 0, Number(event.at) || 0));
    }
    const running = nodes.filter((node) => node.status === 'running');
    const stalled = running
      .map((node) => {
        const last = Math.max(
          Number(node.timestamps?.lastActivityAt) || 0,
          Number(node.timestamps?.startedAt) || 0,
          lastEventByNode.get(node.id) ?? 0,
        );
        return { nodeId: node.id, title: node.title, idleMs: Math.max(0, now - last), lastActivityAt: last || null };
      })
      .filter((row) => row.idleMs >= stallMs);
    const starving = runnableQueue(nodes, now)
      .map((node) => {
        const queuedAt = runnableSince(node) ?? 0;
        return {
          nodeId: node.id,
          title: node.title ?? '',
          className: normalizePriority(node.priority).class,
          waitingMs: queuedAt > 0 ? Math.max(0, now - queuedAt) : 0,
          queuedAt: queuedAt || null,
        };
      })
      .filter((row) => row.waitingMs >= starveMs);
    const autoStatus = auto?.statusOf?.(projectId) ?? null;
    const pauseReason = autoStatus?.status === 'paused' ? (autoStatus.pauseReason || 'unknown') : null;
    const openDisputes = (Array.isArray(project.disputes) ? project.disputes : [])
      .map((record) => effectiveDispute(record, now))
      .filter((record) => record.status === 'pending');
    const pools = project.config?.resourcePools ?? {};
    const held = {};
    for (const node of running) {
      for (const [key, amount] of Object.entries(node.resourcesHeld ?? {})) held[key] = (held[key] ?? 0) + Number(amount || 0);
    }
    const freeSlots = Object.keys(pools).length > 0
      ? Object.entries(pools).reduce((sum, [key, total]) => sum + Math.max(0, Number(total) - (held[key] ?? 0)), 0)
      : Math.max(0, Number(project.config?.maxRunningNodes ?? 1) - running.length);
    const overload = queueOverloadState(nodes, freeSlots);
    if (!overload.overloaded) queueOverloadSince.delete(projectId);
    else if (!queueOverloadSince.has(projectId)) queueOverloadSince.set(projectId, now);
    const escalation = evaluateEscalationTriggers({ nodes, project, knownHypotheses: project.knownHypotheses ?? [], now });
    const thresholds = evaluateThresholdTriggers({
      nodes,
      runs: store.listRuns(projectId, 100),
      intents: Array.isArray(project.intents) ? project.intents : [],
      project,
      now,
      freeSlots,
      queueOverloadSince: queueOverloadSince.get(projectId),
    });
    return publicView({
      ok: true,
      projectId,
      revision: project.revision ?? 0,
      cursor: store.maxEventSeq(projectId),
      now,
      stallMs,
      starveMs,
      running: running.map((node) => ({ nodeId: node.id, title: node.title, startedAt: node.timestamps?.startedAt ?? null })),
      stalled,
      starving,
      pauseReason,
      triggers: escalation,
      triggerCodes: [...TRIGGER_CODES],
      thresholdTriggers: thresholds,
      thresholdTriggerCodes: [...THRESHOLD_TRIGGER_CODES],
      openDisputes: openDisputes.map((record) => ({ id: record.id, type: record.type, deadlineAt: record.deadlineAt, authority: record.authority })),
      recentEvents: events.slice(-20).map((event) => ({ seq: event.seq, type: event.type, at: event.at, nodeId: event.nodeId ?? null })),
    });
  }

  /** Build the single escalation envelope when any 5.3.13 condition is met. */
  function observerEscalation(snapshot) {
    if (snapshot.stalled.length > 0) {
      return { code: 'observer_stalled', nodes: snapshot.stalled, stalled: snapshot.stalled, starving: snapshot.starving, pauseReason: snapshot.pauseReason };
    }
    // A paused driver is the root cause; it must not be masked by the
    // starvation it necessarily causes.
    if (snapshot.pauseReason) {
      return { code: 'observer_paused', nodes: [], stalled: snapshot.stalled, starving: snapshot.starving, pauseReason: snapshot.pauseReason };
    }
    if (snapshot.starving.length > 0) {
      return { code: 'observer_starving', nodes: snapshot.starving, stalled: snapshot.stalled, starving: snapshot.starving, pauseReason: snapshot.pauseReason };
    }
    return null;
  }

  /**
   * Long-poll: hold the request until the event cursor advances, a stall /
   * starvation / driver pause is observable, or the 60s bound expires.
   * No model and no write here.
   */
  async function waitForEvents(projectId, { after = null, timeoutMs = OBSERVER_MAX_WAIT_MS, pollMs = 250 } = {}) {
    requireProject(projectId);
    const started = Date.now();
    const timeout = Number.isFinite(timeoutMs) ? Math.max(0, Math.min(OBSERVER_MAX_WAIT_MS, Math.trunc(timeoutMs))) : OBSERVER_MAX_WAIT_MS;
    const interval = Number.isFinite(pollMs) ? Math.max(25, Math.min(1_000, Math.trunc(pollMs))) : 250;
    let cursor = Number.isFinite(after) ? Math.max(0, Math.trunc(after)) : store.maxEventSeq(projectId);
    while (Date.now() - started <= timeout) {
      const page = await getEvents(projectId, cursor);
      if (page.events.length > 0) {
        return publicView({
          ok: true,
          projectId,
          events: page.events,
          next: page.next,
          cursor: page.next,
          waitedMs: Date.now() - started,
          timedOut: false,
          escalation: null,
        });
      }
      const snapshot = observerSnapshot(projectId);
      const escalation = observerEscalation(snapshot);
      if (escalation) {
        return publicView({
          ok: true,
          projectId,
          events: [],
          next: page.next,
          cursor: page.next,
          waitedMs: Date.now() - started,
          timedOut: false,
          escalation,
        });
      }
      const remaining = timeout - (Date.now() - started);
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(interval, remaining)));
      // Keep the original cursor: an event that arrives during the sleep must
      // be returned by the next page read, not silently skipped.
    }
    return publicView({
      ok: true,
      projectId,
      events: [],
      next: store.maxEventSeq(projectId),
      cursor: store.maxEventSeq(projectId),
      waitedMs: Date.now() - started,
      timedOut: true,
      escalation: null,
    });
  }

  /** Deterministic escalation write: one observer event per idle/starve/pause window. */
  async function escalateStalled(projectId, { now = Date.now() } = {}) {
    const snapshot = observerSnapshot(projectId, { now });
    const events = store.listEvents(projectId, 0);
    const escalated = [];
    const starving = [];
    const paused = [];
    for (const row of snapshot.stalled) {
      const lastActivityAt = Number(row.lastActivityAt) || 0;
      const already = events.some((event) => event?.type === 'observer/escalation'
        && event.data?.code === 'stalled_node'
        && event.data?.nodeId === row.nodeId
        && (Number(event.at) || 0) >= lastActivityAt);
      if (already) continue;
      await commitMutations(projectId, [{
        op: 'event.record',
        type: 'observer/escalation',
        data: { nodeId: row.nodeId, code: 'stalled_node', idleMs: row.idleMs, lastActivityAt: row.lastActivityAt ?? null, at: now },
      }], { actor: { kind: 'system', id: 'observer' }, causeId: `observer:escalation:${row.nodeId}:${now}` });
      escalated.push(row.nodeId);
    }
    for (const row of snapshot.starving) {
      const queuedAt = Number(row.queuedAt) || 0;
      const already = events.some((event) => event?.type === 'observer/escalation'
        && event.data?.code === 'starving_node'
        && event.data?.nodeId === row.nodeId
        && (Number(event.at) || 0) >= queuedAt);
      if (already) continue;
      await commitMutations(projectId, [{
        op: 'event.record',
        type: 'observer/escalation',
        data: { nodeId: row.nodeId, code: 'starving_node', waitingMs: row.waitingMs, className: row.className, queuedAt: row.queuedAt, at: now },
      }], { actor: { kind: 'system', id: 'observer' }, causeId: `observer:starving:${row.nodeId}:${now}` });
      starving.push(row.nodeId);
    }
    if (snapshot.pauseReason) {
      const already = events.some((event) => event?.type === 'observer/escalation'
        && event.data?.code === 'driver_paused'
        && event.data?.pauseReason === snapshot.pauseReason
        && (Number(event.at) || 0) >= now - OBSERVER_STALL_MS);
      if (!already) {
        await commitMutations(projectId, [{
          op: 'event.record',
          type: 'observer/escalation',
          data: { code: 'driver_paused', pauseReason: snapshot.pauseReason, at: now },
        }], { actor: { kind: 'system', id: 'observer' }, causeId: `observer:paused:${projectId}:${now}` });
        paused.push(snapshot.pauseReason);
      }
    }
    return publicView({ ok: true, projectId, escalated, starving, paused, stalled: snapshot.stalled, starvingNodes: snapshot.starving, pauseReason: snapshot.pauseReason });
  }

  /** 5.3.14 bounded observe surface; no handles, no secrets, no writes. */
  function observe(projectId) {
    const snapshot = observerSnapshot(projectId);
    const project = requireProject(projectId);
    const intents = (Array.isArray(project.intents) ? project.intents : [])
      .filter((intent) => intent.status === 'pending')
      .slice(-20)
      .map((intent) => ({ id: intent.id, kind: intent.kind, actor: intent.actor ? { kind: intent.actor.kind, id: intent.actor.id } : null, claim: intent.claim ?? null, expiresAt: intent.expiresAt ?? null }));
    return publicView({ ...snapshot, pendingIntents: intents });
  }

  /**
   * Arbitration is a limited write: only a dispute resolution, never a runtime
   * action. Human-authority disputes cannot be overridden by a model arbiter.
   */
  async function arbitrate(projectId, input = {}, exec = null) {
    const actor = actorFromDisputeExecution(exec);
    if (!actor) return rejection('actor_required', 'arbitrate requires an authenticated actor; an absent exec is not the operator');
    const actorVerdict = disputeActorVerdict(actor);
    if (actorVerdict.ok !== true) return rejection(actorVerdict.code, actorVerdict.message);
    const project = requireProject(projectId);
    const record = (Array.isArray(project.disputes) ? project.disputes : []).find((row) => row.id === input.disputeId);
    if (!record) return rejection('dispute_not_found', `unknown dispute: ${input.disputeId ?? ''}`);
    const authority = disputeAuthorityVerdict(actor, record);
    if (authority.ok !== true) return rejection(authority.code, authority.message, { authority: record.authority ?? null });
    return resolveDispute(projectId, input.disputeId, {
      resolution: input.resolution,
      reason: input.reason,
    }, exec);
  }

  async function getReplay(projectId, options = {}) {
    const nodeLimit = Number.isFinite(options.nodeLimit) ? Math.max(1, Math.min(5000, Math.trunc(options.nodeLimit))) : 2000;
    const eventLimit = Number.isFinite(options.limit) ? Math.max(1, Math.min(5000, Math.trunc(options.limit))) : 2000;
    const afterSeq = Number.isFinite(options.afterSeq) ? Math.max(0, Math.trunc(options.afterSeq)) : 0;
    const nodeCursor = typeof options.nodeCursor === 'string' && options.nodeCursor ? options.nodeCursor : null;
    const state = await getState(projectId, undefined, { limit: nodeLimit, cursor: nodeCursor });
    // S5: replay events use the same bounded page as /events. Reading all
    // events just to slice the first N made 10k+ event projects O(all) and
    // ignored the cursor even though the response already advertised one.
    const eventPage = store.pageEvents(projectId, { after: afterSeq, limit: eventLimit });
    const events = eventPage.events;
    const nextSeq = eventPage.nextSeq ?? (events.length > 0 ? events[events.length - 1].seq : afterSeq);
    // Replay spans the first node's creation through the last node activity,
    // not project creation or the current wall clock. Accumulate extrema in a
    // loop: spreading 10k+ timestamps into Math.min/Math.max can overflow the
    // argument limit (S5).
    let startAt = Infinity;
    let endAt = -Infinity;
    for (const node of store.listNodes(projectId)) {
      const stamps = node.timestamps && typeof node.timestamps === 'object' ? node.timestamps : {};
      for (const value of Object.values(stamps)) {
        const stamp = Number(value);
        if (!Number.isFinite(stamp) || stamp <= 0) continue;
        if (stamp < startAt) startAt = stamp;
        if (stamp > endAt) endAt = stamp;
      }
    }
    for (const event of events) {
      if (!event?.nodeId && !String(event?.type ?? '').startsWith('node/')) continue;
      const stamp = Number(event.at);
      if (!Number.isFinite(stamp) || stamp <= 0) continue;
      if (stamp < startAt) startAt = stamp;
      if (stamp > endAt) endAt = stamp;
    }
    if (!Number.isFinite(startAt)) startAt = Number(state.project.createdAt) || Date.now();
    if (!Number.isFinite(endAt)) endAt = startAt + 1000;
    if (!(endAt > startAt)) endAt = startAt + 1000;
    return publicView({
      projectId,
      project: {
        id: state.project.id,
        name: state.project.name,
        createdAt: state.project.createdAt,
      },
      startAt,
      endAt,
      nodes: state.nodes,
      edges: state.edges,
      events,
      revision: state.revision,
      nextSeq,
      nextNodeCursor: state.nextCursor ?? null,
      _truncated: {
        nodes: state._truncated?.nodes ?? null,
        events: eventPage.total > events.length
          ? { shown: events.length, total: eventPage.total, max: eventLimit }
          : null,
      },
    });
  }

  /** C14: read the staged switches and the S14 parity gate as one object. */
  function migrationStatus(projectId) {
    const project = requireProject(projectId);
    const migration = project.config?.migration ?? {};
    return {
      ok: true,
      projectId,
      phase: migration.phase ?? 1,
      switches: {
        dispatch: project.config?.dispatch?.strategy ?? 'deterministic',
        experts: project.config?.expertsMode ?? 'legacy-cycle',
        contest: project.config?.contest?.mode ?? 'off',
      },
      parity: migration.parity ?? null,
      zeroDowntime: true,
      staged: [
        { phase: 1, switch: 'dispatch.strategy', values: ['legacy-llm', 'shadow-deterministic', 'deterministic'] },
        { phase: 2, switch: 'expertsMode', values: ['legacy-cycle', 'hierarchy', 'resident'] },
        { phase: 3, switch: 'contest.mode', values: ['off', 'shadow', 'consensus'] },
      ],
      p1NoSwitch: (project.config?.migration?.phase ?? 1) === 1,
    };
  }

  /** C14: move one phase at a time; phase > 1 requires a passing S14 parity run. */
  async function advanceMigration(projectId, input = {}, exec = null) {
    const project = requireProject(projectId);
    const actor = exec ? actorFromToolExecution(exec) : { kind: 'human', id: 'operator' };
    if (actor.kind === 'expert') return rejection('forbidden_expert_action', 'experts may not advance the migration');
    const target = Number(input.phase);
    if (![1, 2, 3].includes(target)) return rejection('bad_request', 'phase must be 1, 2 or 3');
    const current = project.config?.migration?.phase ?? 1;
    if (target !== current && target !== current + 1) return rejection('invalid_migration_step', `migration must advance one phase at a time (current ${current})`);
    const parity = input.parity ?? project.config?.migration?.parity ?? null;
    if (target > 1 && parity?.ok !== true) return rejection('parity_required', 'S14 parity must pass before phase 2 or 3');
    const currentExpertMode = project.config?.expertsMode ?? 'legacy-cycle';
    const requestedExperts = input.expertsMode ?? null;
    if (requestedExperts !== null && !['legacy-cycle', 'hierarchy', 'resident'].includes(requestedExperts)) {
      return rejection('bad_request', 'expertsMode must be legacy-cycle, hierarchy or resident');
    }
    const expertsMode = target >= 2 ? (requestedExperts && requestedExperts !== 'legacy-cycle' ? requestedExperts : (currentExpertMode === 'legacy-cycle' ? 'hierarchy' : currentExpertMode)) : 'legacy-cycle';
    const requestedContest = input.contestMode ?? null;
    if (requestedContest !== null && !['off', 'shadow', 'consensus'].includes(requestedContest)) {
      return rejection('bad_request', 'contestMode must be off, shadow or consensus');
    }
    const contestMode = target >= 3 ? (requestedContest && requestedContest !== 'off' ? requestedContest : (project.config?.contest?.mode === 'off' ? 'shadow' : project.config.contest.mode)) : 'off';
    const requestedDispatch = input.dispatchStrategy ?? null;
    if (requestedDispatch !== null && !['legacy-llm', 'shadow-deterministic', 'deterministic'].includes(requestedDispatch)) {
      return rejection('bad_request', 'dispatchStrategy must be legacy-llm, shadow-deterministic or deterministic');
    }
    const dispatchStrategy = target === 1
      ? (requestedDispatch ?? (project.config?.dispatch?.strategy === 'legacy-llm' ? 'shadow-deterministic' : project.config?.dispatch?.strategy ?? 'shadow-deterministic'))
      : (requestedDispatch ?? project.config?.dispatch?.strategy ?? 'shadow-deterministic');
    const next = {
      ...project.config,
      migration: { ...(project.config.migration ?? {}), phase: target, parity, switchedAt: Date.now(), switchedBy: { kind: actor.kind, id: actor.id } },
      expertsMode,
      contest: { ...(project.config.contest ?? {}), mode: contestMode },
      dispatch: { ...(project.config.dispatch ?? {}), strategy: dispatchStrategy },
    };
    if (target >= 2 && expertsMode === 'legacy-cycle') return rejection('invalid_migration_step', 'phase 2 must select a hierarchy or resident expert mode');
    if (target >= 3 && contestMode === 'off') return rejection('invalid_migration_step', 'phase 3 must select contest shadow or consensus');
    const commit = await commitProjectFields(projectId, { config: normalizeConfig(next, project.config) }, { eventType: 'project/migration_advanced', eventData: { from: current, to: target, switches: { expertsMode, contestMode } }, actor });
    if (commit?.ok !== true) return rejection(commit?.code ?? 'internal_error', commit?.message ?? 'migration commit failed');
    return { ok: true, projectId, phase: target, switches: { dispatch: next.dispatch.strategy, experts: expertsMode, contest: contestMode } };
  }

  const residentSessions = new Map();

  /** B16: open a resident Host session; its budget is enforced by the module. */
  function openResidentSession(projectId, input = {}, exec = null) {
    const project = requireProject(projectId);
    const expertId = typeof input?.expertId === 'string' && input.expertId ? input.expertId : (exec?.agent?.session?.header?.meta?.agentPreset ?? 'lab-advisor');
    const sessionId = `resident-${projectId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const session = createResidentSession({
      expertId,
      sessionId,
      maxQueries: input?.maxQueries ?? RESIDENT_LIMITS.maxQueries,
      maxTokens: input?.maxTokens ?? RESIDENT_LIMITS.maxTokens,
      wallClockMs: input?.wallClockMs ?? RESIDENT_LIMITS.wallClockMs,
    });
    residentSessions.set(sessionId, { session, projectId, expertId });
    return { ok: true, projectId, sessionId, expertId, snapshot: session.snapshot(), tools: session.tools.map((tool) => tool.name) };
  }

  /** B16: every tool call, including submit, goes through the same resident session. */
  async function callResidentTool(projectId, input = {}, exec = null) {
    const row = residentSessions.get(input?.sessionId);
    if (!row || row.projectId !== projectId) return rejection('session_not_found', 'resident session not found');
    const outcome = await row.session.invoke(input?.tool, input?.args ?? {});
    return { ok: outcome.ok === true, projectId, sessionId: input.sessionId, outcome, snapshot: row.session.snapshot() };
  }

  function closeResidentSession(projectId, sessionId) {
    const row = residentSessions.get(sessionId);
    if (!row || row.projectId !== projectId) return { ok: false, code: 'session_not_found' };
    const snapshot = row.session.dispose();
    residentSessions.delete(sessionId);
    return { ok: true, projectId, sessionId, snapshot };
  }

  async function updateProject(projectId, input) {
    return store.withProjectLock(projectId, async () => {
      const project = requireProject(projectId);
      let changed = false;
      if (input?.name !== undefined) {
        project.name = text(input.name, 'name', { required: true, max: 120 });
        changed = true;
      }
      if (input?.brief !== undefined) {
        project.brief = text(input.brief, 'brief', { required: true, max: 8000 });
        changed = true;
      }
      if (input?.config !== undefined) {
        project.config = normalizeConfig(input.config, project.config);
        changed = true;
      }
      if (!changed) return { project, revision: project.revision };
      const result = await commitProjectFields(projectId, {
        name: project.name,
        brief: project.brief,
        config: project.config,
      }, { eventType: 'project/edited', eventData: { revision: (project.revision ?? 0) + 1 } });
      return { project: requireProject(projectId), revision: result.revision };
    });
  }

  async function updateNode(projectId, nodeId, input, actor = null) {
    // Priority is a separate executor commit (G1): apply it before the edit so
    // a terminal node's priority is rejected even when fields are also edited.
    let priorityResult = null;
    if (input?.priority !== undefined) {
      if (typeof input.priority !== 'object' || input.priority === null || Array.isArray(input.priority)) {
        throw new LabError('bad_request', 'priority must be {class, score?}', 400);
      }
      priorityResult = await setNodePriority(projectId, nodeId, { ...input.priority, reason: input.reason }, actor);
      if (priorityResult.ok !== true) {
        const error = priorityResult.error ?? {};
        throw new LabError(error.code ?? 'priority_frozen', error.message ?? 'priority update failed', 409);
      }
    }
    let validatedModel;
    if (input?.model !== undefined) {
      const candidate = cleanModelRef(input.model);
      if (!candidate) throw new LabError('bad_request', 'model must be {profileId} or {provider, model, reasoningEffort?}', 400);
      const preProject = requireProject(projectId);
      validatedModel = await validateModelSelection(ctx, preProject, candidate);
    }
    return store.withProjectLock(projectId, async () => {
      const project = requireProject(projectId);
      const node = requireNode(projectId, nodeId);
      const FIELD_EDITS = ['title', 'prompt', 'successCriteria', 'timeboxMinutes', 'needs', 'model', 'executionProfile', 'taskType'];
      const hasFieldEdits = FIELD_EDITS.some((key) => input?.[key] !== undefined);
      if (hasFieldEdits && node.status !== 'planned' && node.status !== 'proposed') {
        throw new LabError('node_not_editable', 'only planned or proposed nodes can be edited', 409);
      }
      let changed = false;
      if (input?.title !== undefined) {
        // A title is a label: clamp an over-long edit instead of rejecting it.
        node.title = clampNodeTitle(text(input.title, 'title', { required: true }));
        changed = true;
      }
      if (input?.prompt !== undefined) {
        const prompt = text(input.prompt, 'prompt', { required: true, max: 8000 });
        if (prompt.length < 10) throw new LabError('bad_request', 'prompt must be at least 10 characters');
        node.prompt = prompt;
        changed = true;
      }
      if (input?.successCriteria !== undefined) {
        node.successCriteria = text(input.successCriteria, 'successCriteria', { max: 2000 }) ?? '';
        changed = true;
      }
      if (input?.timeboxMinutes !== undefined) {
        const minutes = integer(input.timeboxMinutes, 'timeboxMinutes', project.config.nodeTimeoutMinutes, 1, project.config.maxNodeTimeoutMinutes);
        node.timeboxMs = minutes * 60_000;
        changed = true;
      }
      if (input?.needs !== undefined) {
        const checked = normalizeNeeds(input.needs, project);
        if (checked.error) throw new LabError('bad_request', checked.error, 400);
        node.needs = checked.needs;
        changed = true;
      }
      if (validatedModel) {
        node.model = {
          ...cleanModelRef(validatedModel),
          source: 'user',
          ...(typeof input.reason === 'string' && input.reason.trim() ? { reason: input.reason.trim().slice(0, 500) } : {}),
        };
        changed = true;
      }
      if (input?.executionProfile !== undefined || input?.taskType !== undefined) {
        const execution = resolveExecutionProfile(project, input);
        node.execution = {
          profile: execution.profile,
          driver: execution.driver,
          ...(execution.model ? { model: execution.model } : {}),
          ...(execution.reasoningEffort ? { reasoningEffort: execution.reasoningEffort } : {}),
          ...(execution.codexPath ? { codexPath: execution.codexPath } : {}),
        };
        node.taskType = execution.taskType;
        changed = true;
      }
      if (!changed) return { node, revision: project.revision };
      node.timestamps = { ...(node.timestamps ?? {}), lastActivityAt: Date.now() };
      const result = await commitMutations(projectId, [{
        op: 'node.put',
        node,
        eventType: 'node/edited',
        eventData: { revision: (project.revision ?? 0) + 1 },
      }], actor ? { actor } : {});
      return { node: store.getNode(projectId, nodeId), revision: result.revision, priority: node.priority ?? null };
    });
  }

  async function startNode(projectId, nodeId) {
    return runtime.start(projectId, nodeId);
  }

  async function getCluster(projectId) {
    if (projectId !== undefined) requireProject(projectId);
    return cluster ? cluster.getStatus() : { enabled: false, mode: 'local' };
  }

  async function getClusterConfig() {
    if (!clusterAdmin) throw new LabError('unavailable', 'cluster admin is not wired', 503);
    return clusterAdmin.getConfigPayload();
  }

  async function updateClusterConfig(input = {}) {
    if (!clusterAdmin) throw new LabError('unavailable', 'cluster admin is not wired', 503);
    return clusterAdmin.applyConfig(input.config ?? {}, { force: input.force === true });
  }

  async function compilePlacementPolicyForProject(projectId, textValue) {
    const project = requireProject(projectId);
    const fleetMachines = cluster?.getFleetMachines?.() ?? [];
    const fleetStatusMachines = cluster?.getStatus?.()?.fleet?.machines ?? [];
    const statusById = new Map(fleetStatusMachines.map((machine) => [machine.machineId, machine]));
    const machines = fleetMachines.map((machine) => {
      const statusMachine = statusById.get(machine.machineId);
      const devices = statusMachine?.devices?.length > 0
        ? statusMachine.devices.map((device) => ({ model: device.model ?? device.id }))
        : (machine.devices ?? []).map((device) => ({ model: device.model }));
      return { machineId: machine.machineId, labels: machine.labels ?? {}, devices };
    });
    const sourceText = typeof textValue === 'string' ? textValue : (project.config.placementPolicy?.text ?? '');
    const compiled = compilePlacementPolicy(sourceText, { machines });
    let spec;
    try {
      spec = sanitizePlacementSpec(compiled.spec);
    } catch (error) {
      throw new LabError('bad_request', error instanceof Error ? error.message : String(error));
    }
    const policy = {
      text: sourceText.slice(0, 4000),
      spec,
      compiledAt: Date.now(),
      explanation: compiled.explanation,
      warnings: compiled.warnings,
      compiler: 'rule-based-v1',
      summary: describePlacementSpec(spec),
    };
    return {
      policy,
      explanation: compiled.explanation,
      warnings: compiled.warnings,
      summary: policy.summary,
      catalog: compiled.catalog,
      machineCount: machines.length,
    };
  }

  // ---------------------------------------------------------------------------
  // Project copilot chat: one project-scoped, read-oriented discussion agent per
  // turn. The Host supplies a complete state snapshot and the agent may call the
  // global metainfer_lab tool for live inspection. Persisted in project.chatLog.
  // ---------------------------------------------------------------------------
  const CHAT_LIMIT = 8000;
  const CHAT_HISTORY = 24;
  const CHAT_TIMEOUT_MS = 150_000;
  const chatLocks = new Map();

  function chatTextOf(blocks) {
    if (!Array.isArray(blocks)) return '';
    return blocks
      .map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  function chatMessagesOf(project) {
    return (Array.isArray(project.chatLog) ? project.chatLog : []).map((message) => ({
      id: String(message.id ?? ''),
      role: message.role === 'assistant' ? 'assistant' : (message.role === 'error' ? 'error' : 'user'),
      text: String(message.text ?? ''),
      at: Number(message.at ?? 0),
    }));
  }

  function compactStateForChat(projectId) {
    const project = requireProject(projectId);
    const state = getState(projectId);
    const runs = listRuns(projectId, 20);
    const events = store.listEvents(projectId, Math.max(0, (project.counters?.eventSeq ?? 0) - 40));
    const autoState = auto ? auto.statusOf(projectId) : { status: 'off', pauseReason: null };
    const nodes = (state.nodes ?? []).map((node) => ({
      id: node.id,
      title: node.title,
      status: node.status,
      parentId: node.parentId ?? null,
      parentIds: node.parentIds ?? undefined,
      needs: node.needs ?? {},
      timeboxMinutes: Math.round(((node.timeboxMs ?? 0) / 60000) * 10) / 10,
      deadlineAt: node.deadlineAt ?? null,
      headCommit: node.git?.headCommit ?? null,
      model: node.modelResolved ?? node.model ?? null,
      report: node.report?.summary ?? (node.reportText ? String(node.reportText).slice(0, 1200) : null),
      error: node.error?.message ?? null,
      sealed: node.sealed === true,
      isLeaf: node.isLeaf === true,
      attempts: (node.attempts ?? []).map((attempt) => ({
        index: attempt.index, status: attempt.status ?? null, stopReason: attempt.stopReason ?? null,
        model: attempt.model ?? null, startedAt: attempt.startedAt ?? null, endedAt: attempt.endedAt ?? null,
      })),
      usage: node.usage ?? null,
    }));
    const runRows = (runs.runs ?? []).slice(0, 20).map((run) => ({
      id: run.id,
      role: run.role,
      lens: run.lens ?? null,
      status: run.status,
      sessionId: run.sessionId,
      startedAt: run.startedAt ?? null,
      endedAt: run.endedAt ?? null,
      model: run.model ?? null,
      analysis: typeof run.analysis === 'string' ? run.analysis.slice(0, 1600) : null,
      error: run.error ?? null,
      createdNodeIds: run.createdNodeIds ?? undefined,
      startedNodeIds: run.startedNodeIds ?? undefined,
      output: run.output ? JSON.stringify(run.output).slice(0, 3000) : null,
    }));
    return {
      project: {
        id: project.id,
        name: project.name,
        brief: project.brief,
        mode: project.mode,
        repoPath: project.repo?.path,
        worktreeRoot: project.repo?.worktreeRoot,
        createdAt: project.createdAt,
        revision: project.revision,
        config: {
          resourcePools: project.config?.resourcePools ?? {},
          maxRunningNodes: project.config?.maxRunningNodes,
          maxNodes: project.config?.maxNodes,
          nodeTimeoutMinutes: project.config?.nodeTimeoutMinutes,
          models: project.config?.models ?? {},
          advisor: project.config?.advisor ?? {},
          auto: project.config?.auto ?? {},
        },
      },
      nodes,
      edges: state.edges ?? [],
      resources: state.resources ?? {},
      auto: autoState,
      cluster: state.cluster ?? { enabled: false },
      runs: runRows,
      cycles: runs.cycles ?? [],
      events: events.slice(-40).map((event) => ({
        seq: event.seq,
        at: event.at,
        type: event.type,
        nodeId: event.nodeId ?? null,
        data: event.data ?? null,
      })),
    };
  }

  function chatPrompt(project, userText) {
    const all = chatMessagesOf(project);
    const history = (all.length > 0 && all[all.length - 1].role === 'user' ? all.slice(0, -1) : all).slice(-CHAT_HISTORY);
    const historyText = history.length > 0
      ? history.map((message) => `${message.role === 'assistant' ? 'Assistant' : message.role === 'error' ? 'System error' : 'User'}: ${message.text}`).join('\n\n')
      : '(no previous messages)';
    return [
      'You are the project-level copilot of MetaInfer Research Lab.',
      `Project id: ${project.id}`,
      `Project name: ${project.name}`,
      'You have read access to the whole project through the metainfer_lab tool: use',
      `  metainfer_lab({action:"state", projectId:"${project.id}"})`,
      `  metainfer_lab({action:"runs", projectId:"${project.id}"}) / action:"run" with runId`,
      `  metainfer_lab({action:"transcript", projectId:"${project.id}", nodeId:"..."})`,
      `  metainfer_lab({action:"cluster", projectId:"${project.id}"})`,
      'The Host also embeds a recent complete snapshot below. Prefer live tool data when freshness matters.',
      'You may analyze, explain, compare, summarize, and propose next steps. Treat the project as',
      'READ-ONLY unless the human explicitly asks you to mutate it; never start/stop/cancel/retry',
      'experiments on your own. Answer in the language of the user. Cite node/run ids where useful.',
      '',
      '# Conversation so far',
      historyText,
      '',
      '# Recent project state snapshot',
      JSON.stringify(compactStateForChat(project.id), null, 2),
      '',
      '# Current user message',
      userText,
    ].join('\n');
  }

  async function saveChatMessage(projectId, message) {
    return store.withProjectLock(projectId, async () => {
      const project = requireProject(projectId);
      const log = Array.isArray(project.chatLog) ? project.chatLog.slice() : [];
      log.push({ id: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ...message });
      await commitProjectFields(projectId, { chatLog: log.slice(-80) });
      return chatMessagesOf(requireProject(projectId));
    });
  }

  async function clearProjectChat(projectId) {
    return store.withProjectLock(projectId, async () => {
      const project = requireProject(projectId);
      await commitProjectFields(projectId, { chatLog: [] });
      return { projectId, messages: [] };
    });
  }

  // ---------------------------------------------------------------------------
  // Persistent project Copilot session: a root lab-chat agent with a scoped,
  // read-only project-context tool. The Client embeds the native DSH
  // Conversation for this session in a large drawer, so history/trajectory/live
  // thinking are native while the agent still has full project visibility.
  // ---------------------------------------------------------------------------
  const copilotLocks = new Map(); // projectId -> Promise

  async function copilotContext(projectId, input = {}) {
    const action = typeof input?.action === 'string' ? input.action : 'snapshot';
    if (action === 'state') return getState(projectId);
    if (action === 'runs') return listRuns(projectId);
    if (action === 'run') return getRun(projectId, input?.runId);
    if (action === 'events') return getEvents(projectId, input?.after ?? 0);
    if (action === 'cluster') return getCluster(projectId);
    if (action === 'node') {
      const node = store.getNode(projectId, input?.nodeId);
      if (!node) throw new LabError('node_not_found', `unknown node: ${input?.nodeId}`, 404);
      return { node };
    }
    if (action === 'snapshot') return compactStateForChat(projectId);
    throw new LabError('bad_request', `unknown copilot context action: ${action}`, 400);
  }

  function copilotToolDefinition(projectId) {
    return {
      name: 'lab_project_context',
      description:
        'Read the complete state of the current MetaInfer Research Lab project (read-only): ' +
        'snapshot/state/nodes/runs/run/events/cluster. Use this whenever the human asks about ' +
        'project progress, reports, failures, resources or next steps.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['snapshot', 'state', 'runs', 'run', 'events', 'cluster', 'node'],
          },
          nodeId: { type: 'string' },
          runId: { type: 'string' },
          after: { type: 'number' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { result: { type: 'string' } },
          required: ['result'],
          additionalProperties: false,
        },
        render: (args, value) => {
          const text = value && typeof value.result === 'string' ? value.result : JSON.stringify(value);
          return [{ type: 'text', text: text.length > 30_000 ? `${text.slice(0, 30_000)}\n…[truncated]` : text }];
        },
      },
      timeoutMs: 60_000,
      async execute(args) {
        const data = await copilotContext(projectId, args ?? {});
        return { result: JSON.stringify(data) };
      },
    };
  }

  function copilotDescriptor(project, model) {
    const descriptor = {
      version: 3,
      mode: 'continuable',
      provider: 'spawn',
      label: `mirl-copilot/${project.id}`,
    };
    if (model && typeof model.provider === 'string') descriptor.agentProvider = model.provider;
    if (model && typeof model.model === 'string') descriptor.agentModel = model.model;
    if (model && typeof model.reasoningEffort === 'string') descriptor.agentReasoningEffort = model.reasoningEffort;
    return descriptor;
  }

  /** Append the durable child descriptor if an older Copilot session lacks it. */
  function ensureCopilotDescriptor(session, project, model) {
    if (!session || typeof session.append !== 'function') return;
    const header = session.header || {};
    if (header.origin !== 'subagent') return;
    const hasPreset = session.ownEvents().some((event) => event.type === 'agent-preset/selected');
    if (!hasPreset) session.append('agent-preset/selected', { agentPreset: 'lab-chat' });
    const hasDescriptor = session.ownEvents().some((event) => event.type === 'subagent/descriptor');
    if (!hasDescriptor) session.append('subagent/descriptor', copilotDescriptor(project, model));
  }

  function catalogCopilotChild(project, childId, childCreatedAt) {
    if (!project.controllerSessionId) return;
    const parent = ctx.sessions.get(project.controllerSessionId);
    if (!parent || typeof parent.append !== 'function') return;
    const known = parent.ownEvents().some((event) => (
      event.type === 'subagent/catalog'
      && event.data
      && event.data.childId === childId
    ));
    if (known) return;
    parent.append('subagent/catalog', {
      version: 0,
      childId,
      childCreatedAt: Number(childCreatedAt) || Date.now(),
      mode: 'continuable',
      label: `mirl-copilot/${project.id}`,
    });
  }

  async function setupCopilot(project, model, agentCtx, agent) {
    const session = agent && agent.session ? agent.session : null;
    ensureCopilotDescriptor(session, project, model);
    await ctx.agentPresets.mount(agentCtx, 'lab-chat');
    agentCtx.tools.register(copilotToolDefinition(project.id));
  }

  /** Normalized Copilot session list, including one legacy visible session. */
  function copilotEntriesOf(project) {
    const entries = Array.isArray(project.copilotSessions)
      ? project.copilotSessions
          .filter((entry) => entry && typeof entry.id === 'string' && entry.id)
          .map((entry) => ({
            id: entry.id,
            title: typeof entry.title === 'string' && entry.title.trim() ? entry.title.trim() : 'Copilot',
            createdAt: Number(entry.createdAt) || 0,
            updatedAt: Number(entry.updatedAt) || 0,
            private: entry.private !== false,
          }))
      : [];
    if (entries.length === 0 && typeof project.copilotSessionId === 'string' && project.copilotSessionId) {
      // Pre-private Copilot sessions were created as root sessions and are
      // visible in the DSH workspace. Keep them listed as legacy history.
      entries.push({
        id: project.copilotSessionId,
        title: 'Copilot (legacy)',
        createdAt: Number(project.updatedAt) || 0,
        updatedAt: Number(project.updatedAt) || 0,
        private: false,
      });
    }
    return entries;
  }

  function copilotSummaryOf(project) {
    const sessions = copilotEntriesOf(project);
    const active = typeof project.activeCopilotSessionId === 'string'
      ? project.activeCopilotSessionId
      : '';
    return {
      sessions,
      activeSessionId: sessions.some((entry) => entry.id === active && entry.private) ? active : null,
    };
  }

  async function rememberCopilotSession(projectId, sessionId, title, existing) {
    return store.withProjectLock(projectId, async () => {
      const current = requireProject(projectId);
      const sessions = copilotEntriesOf(current);
      const previous = existing ?? sessions.find((entry) => entry.id === sessionId);
      const next = sessions.filter((entry) => entry.id !== sessionId);
      next.unshift({
        id: sessionId,
        title: title || previous?.title || `Copilot ${sessions.filter((entry) => entry.private).length + 1}`,
        createdAt: previous?.createdAt || Date.now(),
        updatedAt: Date.now(),
        private: true,
      });
      await commitProjectFields(projectId, {
        copilotSessions: next,
        activeCopilotSessionId: sessionId,
        // Backward-compatible alias for older client builds / status consumers.
        copilotSessionId: sessionId,
      });
      return copilotSummaryOf(requireProject(projectId));
    });
  }

  async function createPrivateCopilotSession(projectId, title = '') {
    const project = requireProject(projectId);
    await archiveRootCopilots(projectId);
    if (!project.controllerSessionId) throw new LabError('bad_request', 'project has no controller session', 400);
    await orchestrator.ensureController(project);
    const model = resolveModelSelection(ctx, project, null, 'controller');
    const sessionId = newSessionId();
    const handle = await ctx.agents.create({
      sessionId,
      meta: {
        cwd: project.repo.path,
        origin: 'subagent',
        parentSession: project.controllerSessionId,
        delegationDepth: 1,
        agentPreset: 'lab-chat',
      },
      agentOptions: model,
      setup: async (agentCtx, agent) => {
        const session = agent && agent.session ? agent.session : null;
        ensureCopilotDescriptor(session, project, model);
        await ctx.agentPresets.mount(agentCtx, 'lab-chat');
        agentCtx.tools.register(copilotToolDefinition(project.id));
      },
    });
    catalogCopilotChild(project, sessionId, Date.now());
    // The native subagent composer cold-resumes from persistence. Keep no
    // regular live Agent for the child, otherwise the Manager's cold resume
    // conflicts with the live registry entry.
    await handle.dispose();
    const requestedTitle = typeof title === 'string' ? title.trim() : '';
    const titleText = requestedTitle || `Copilot ${copilotEntriesOf(project).filter((entry) => entry.private).length + 1}`;
    const summary = await rememberCopilotSession(projectId, sessionId, titleText, null);
    return { sessionId, reused: false, ...summary };
  }

  async function archiveRootCopilots(projectId) {
    const registry = ctx.get('workspaceRegistry');
    let changed = false;
    await store.withProjectLock(projectId, async () => {
      const project = requireProject(projectId);
      const entries = Array.isArray(project.copilotSessions) ? project.copilotSessions : [];
      const keep = [];
      for (const entry of entries) {
        if (!entry || !entry.id) continue;
        let root = false;
        try {
          const snapshot = await ctx.sessionQuery.readSession(entry.id);
          root = snapshot?.session?.origin !== 'subagent';
        } catch {
          root = true;
        }
        if (!root) {
          keep.push(entry);
          continue;
        }
        changed = true;
        if (registry && typeof registry.archiveSession === 'function') {
          try {
            await registry.archiveSession(entry.id, { stopActivity: true });
          } catch {
            // Archiving is best-effort; removing the project link still hides
            // the Copilot from the picker.
          }
        }
      }
      if (!changed) return;
      project.copilotSessions = keep;
      if (!keep.some((entry) => entry.id === project.activeCopilotSessionId)) {
        project.activeCopilotSessionId = keep[0]?.id ?? '';
      }
      if (!keep.some((entry) => entry.id === project.copilotSessionId)) {
        project.copilotSessionId = project.activeCopilotSessionId || '';
      }
      await commitProjectFields(projectId, {
        copilotSessions: keep,
        activeCopilotSessionId: keep.some((entry) => entry.id === project.activeCopilotSessionId)
          ? project.activeCopilotSessionId
          : (keep[0]?.id ?? ''),
        copilotSessionId: keep.some((entry) => entry.id === project.copilotSessionId)
          ? project.copilotSessionId
          : (keep[0]?.id ?? ''),
      });
    });
  }

  async function ensureCopilotSession(projectId, options = {}) {
    if (copilotLocks.has(projectId)) return copilotLocks.get(projectId);
    const task = (async () => {
      const project = requireProject(projectId);
      // A resumed root agent must be given agentOptions again: agentOptions are
      // resume-time inputs and are not reconstructed from the persisted session.
      const model = resolveModelSelection(ctx, project, null, 'controller');
      await archiveRootCopilots(projectId);
      // A proper Copilot is a private subagent child; its history route and
      // cold resume are authorized by the parent controller catalog.
      const sessions = copilotEntriesOf(project);
      const requested = typeof options.sessionId === 'string' ? options.sessionId : '';
      let entry = requested ? sessions.find((candidate) => candidate.id === requested) ?? null : null;
      if (!entry && options.create !== true) {
        const active = typeof project.activeCopilotSessionId === 'string' ? project.activeCopilotSessionId : '';
        entry = sessions.find((candidate) => candidate.id === active && candidate.private)
          ?? sessions.filter((candidate) => candidate.private).sort((left, right) => right.updatedAt - left.updatedAt)[0]
          ?? null;
      }
      if (entry) {
        try {
          const snapshot = await ctx.sessionQuery.readSession(entry.id);
          const hasDescriptor = (snapshot.events || []).some((event) => event.type === 'subagent/descriptor');
          if (snapshot?.session?.origin === 'subagent' && hasDescriptor) {
            // A proper private child is cold-resumed by the native subagent
            // composer from its descriptor; the Lab must not hold a competing
            // regular Agent for it. Only keep the parent controller live.
            await orchestrator.ensureController(project);
            const summary = await rememberCopilotSession(projectId, entry.id, entry.title, entry);
            return { sessionId: entry.id, reused: true, ...summary };
          }
        } catch {
          // Unreadable legacy entry: create a fresh private child below.
        }
      }
      return createPrivateCopilotSession(projectId, options.title);
    })();
    copilotLocks.set(projectId, task);
    try {
      return await task;
    } finally {
      copilotLocks.delete(projectId);
    }
  }

  async function getCopilot(projectId) {
    const project = requireProject(projectId);
    const summary = copilotSummaryOf(project);
    return {
      projectId,
      sessionId: summary.activeSessionId,
      ...summary,
    };
  }

  async function openCopilot(projectId, input = {}) {
    const result = await ensureCopilotSession(projectId, input);
    const agent = ctx.agents.get(result.sessionId);
    return {
      ...result,
      projectId,
      origin: agent?.session?.header?.origin ?? null,
      parentSession: agent?.session?.header?.parentSession ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // Natural-language new-project intake. The manual form schema is supplied by
  // the Client (the form stays the source of truth); every user turn runs one
  // private child agent that reads/patches the Host-side draft through the
  // global metainfer_lab tool. The human confirms creation in the UI.
  // ---------------------------------------------------------------------------
  const intakeDrafts = new Map();
  let intakeAnchorHandle = null;
  let intakeAnchorSessionId = '';

  function sanitizeIntakeSchema(raw) {
    const schema = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const fields = [];
    for (const rawField of Array.isArray(schema.fields) ? schema.fields.slice(0, 40) : []) {
      if (!rawField || typeof rawField !== 'object' || Array.isArray(rawField)) continue;
      const id = typeof rawField.id === 'string' ? rawField.id.trim() : '';
      const pathValue = typeof rawField.path === 'string' ? rawField.path.trim() : '';
      if (!id || !pathValue || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,80}$/.test(id)) continue;
      if (!/^[a-zA-Z][a-zA-Z0-9_.[\]-]{0,120}$/.test(pathValue)) continue;
      const type = ['text', 'textarea', 'number', 'select', 'pools', 'boolean'].includes(rawField.type)
        ? rawField.type
        : 'text';
      const options = type === 'select' && Array.isArray(rawField.options)
        ? rawField.options
            .filter((option) => option && typeof option.value === 'string')
            .slice(0, 40)
            .map((option) => ({ value: option.value, label: typeof option.label === 'string' ? option.label : option.value }))
        : undefined;
      fields.push({
        id,
        path: pathValue,
        type,
        label: typeof rawField.label === 'string' ? rawField.label.slice(0, 200) : id,
        help: typeof rawField.help === 'string' ? rawField.help.slice(0, 600) : '',
        group: typeof rawField.group === 'string' ? rawField.group.slice(0, 80) : '',
        required: rawField.required === true,
        ...(rawField.default !== undefined ? { default: rawField.default } : {}),
        ...(options ? { options } : {}),
        ...(Number.isFinite(Number(rawField.min)) ? { min: Number(rawField.min) } : {}),
        ...(Number.isFinite(Number(rawField.max)) ? { max: Number(rawField.max) } : {}),
        ...(Number.isFinite(Number(rawField.rows)) ? { rows: Number(rawField.rows) } : {}),
      });
    }
    return { fields, version: Number.isFinite(Number(schema.version)) ? Number(schema.version) : 1 };
  }

  function normalizeIntakeValue(field, value) {
    if (value === undefined || value === null) return { value: undefined };
    if (field.type === 'number') {
      const numeric = Number(value);
      if (!Number.isInteger(numeric)) return { error: `${field.label} 必须是整数` };
      if (field.min !== undefined && numeric < field.min) return { error: `${field.label} 不能小于 ${field.min}` };
      if (field.max !== undefined && numeric > field.max) return { error: `${field.label} 不能大于 ${field.max}` };
      return { value: numeric };
    }
    if (field.type === 'boolean') return { value: value === true || value === 'true' };
    if (field.type === 'pools') {
      let source = value;
      if (typeof source === 'string') {
        try {
          source = JSON.parse(source);
        } catch {
          return { error: `${field.label} 必须是 {资源: 数量} 对象` };
        }
      }
      if (!source || typeof source !== 'object' || Array.isArray(source)) {
        return { error: `${field.label} 必须是 {资源: 数量} 对象` };
      }
      const pools = {};
      for (const [key, amountRaw] of Object.entries(source)) {
        const name = String(key).trim();
        const amount = Number(amountRaw);
        if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(name)) return { error: `${field.label}: 非法资源名 ${name}` };
        if (!Number.isInteger(amount) || amount < 0 || amount > 64) {
          return { error: `${field.label}: ${name} 必须是 0..64 整数` };
        }
        if (amount > 0) pools[name] = amount;
      }
      if (Object.keys(pools).length === 0) return { error: `${field.label} 至少需要一个资源` };
      return { value: pools };
    }
    if (field.type === 'select') {
      const text = String(value).trim();
      if (!field.options || !field.options.some((option) => option.value === text)) {
        return { error: `${field.label} 必须是 ${(field.options ?? []).map((option) => option.value).join('/')}` };
      }
      return { value: text };
    }
    const text = String(value).trim();
    if (text.length > 8000) return { error: `${field.label} 不能超过 8000 字符` };
    return { value: text };
  }

  function intakeDefaults(schema) {
    const values = {};
    for (const field of schema.fields) {
      if (field.default === undefined) {
        if (field.type === 'pools') values[field.id] = { gpu: 1 };
        else if (field.type === 'number') values[field.id] = field.min ?? 0;
        else values[field.id] = field.type === 'boolean' ? false : '';
        continue;
      }
      const normalized = normalizeIntakeValue(field, field.default);
      values[field.id] = normalized.error ? field.default : normalized.value;
    }
    return values;
  }

  function intakeMissing(schema, values) {
    return schema.fields
      .filter((field) => {
        if (!field.required) return false;
        const value = values[field.id];
        if (field.type === 'pools') return !value || typeof value !== 'object' || Object.keys(value).length === 0;
        if (field.type === 'number') return !Number.isInteger(value);
        if (field.type === 'boolean') return value !== true && value !== false;
        return !(typeof value === 'string' && value.trim() !== '');
      })
      .map((field) => ({ id: field.id, label: field.label }));
  }

  function intakeSummary(draft) {
    return {
      intakeId: draft.intakeId,
      schema: draft.schema,
      values: draft.values,
      missing: intakeMissing(draft.schema, draft.values),
      ready: draft.ready,
      projectId: draft.projectId ?? null,
      messages: draft.messages,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
    };
  }

  function requireIntake(intakeId) {
    const id = typeof intakeId === 'string' ? intakeId : '';
    const draft = intakeDrafts.get(id);
    if (!draft) throw new LabError('intake_not_found', `unknown intake: ${id}`, 404);
    return draft;
  }

  function setPath(target, pathValue, value) {
    const parts = pathValue.split('.');
    let cursor = target;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const key = parts[index];
      if (!cursor[key] || typeof cursor[key] !== 'object' || Array.isArray(cursor[key])) cursor[key] = {};
      cursor = cursor[key];
    }
    cursor[parts[parts.length - 1]] = value;
  }

  function intakePayload(draft) {
    const payload = {};
    for (const field of draft.schema.fields) {
      const value = draft.values[field.id];
      if (value === undefined) continue;
      if (typeof value === 'string' && value.trim() === '') continue;
      setPath(payload, field.path, value);
    }
    if (!payload.config) payload.config = {};
    return payload;
  }

  function startIntake(input = {}) {
    const schema = sanitizeIntakeSchema(input.schema);
    if (schema.fields.length === 0) throw new LabError('bad_request', 'intake schema has no fields', 400);
    const intakeId = newSessionId();
    const now = Date.now();
    const draft = {
      intakeId,
      schema,
      values: intakeDefaults(schema),
      messages: [],
      ready: false,
      projectId: null,
      createdAt: now,
      updatedAt: now,
    };
    intakeDrafts.set(intakeId, draft);
    return intakeSummary(draft);
  }

  function readIntake(intakeId) {
    return intakeSummary(requireIntake(intakeId));
  }

  function patchIntake(intakeId, patch) {
    const draft = requireIntake(intakeId);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new LabError('bad_request', 'values must be an object', 400);
    }
    const byId = new Map(draft.schema.fields.map((field) => [field.id, field]));
    const rejected = [];
    for (const [fieldId, raw] of Object.entries(patch)) {
      const field = byId.get(fieldId);
      if (!field) {
        rejected.push({ id: fieldId, error: 'unknown field' });
        continue;
      }
      const normalized = normalizeIntakeValue(field, raw);
      if (normalized.error) {
        rejected.push({ id: fieldId, error: normalized.error });
        continue;
      }
      if (normalized.value === undefined) delete draft.values[fieldId];
      else draft.values[fieldId] = normalized.value;
    }
    draft.updatedAt = Date.now();
    return { ...intakeSummary(draft), rejected };
  }

  function readyIntake(intakeId) {
    const draft = requireIntake(intakeId);
    const missing = intakeMissing(draft.schema, draft.values);
    draft.ready = missing.length === 0;
    draft.updatedAt = Date.now();
    return {
      ...intakeSummary(draft),
      ...(missing.length > 0 ? { error: 'missing required fields' } : {}),
    };
  }

  async function ensureIntakeAnchor() {
    const live = intakeAnchorSessionId ? ctx.agents.get(intakeAnchorSessionId) : null;
    if (live) return live;
    const sessionId = intakeAnchorSessionId || newSessionId();
    const model = resolveModelSelection(ctx, null, null, 'controller');
    const handle = await ctx.agents.create({
      sessionId,
      // An anchor is only a durable private parent; it never runs a turn.
      meta: { cwd: os.homedir(), origin: 'subagent', agentPreset: 'lab-controller' },
      agentOptions: model,
      setup: async (agentCtx) => {
        await ctx.agentPresets.mount(agentCtx, 'lab-controller');
      },
    });
    intakeAnchorSessionId = sessionId;
    intakeAnchorHandle = handle;
    return handle.agent;
  }

  function intakePrompt(draft, userText) {
    const history = draft.messages
      .slice(-20)
      .map((message) => `${message.role === 'assistant' ? 'Assistant' : 'Human'}: ${message.text}`)
      .join('\n\n') || '(none)';
    return [
      'You are the new-project intake assistant of MetaInfer Research Lab.',
      `The intakeId for the metainfer_lab tool is: ${draft.intakeId}`,
      'Use metainfer_lab({action:"intake_read", intakeId:"..."}) to inspect the schema and current values.',
      'Use metainfer_lab({action:"intake_patch", intakeId:"...", values:{fieldId:value}}) to fill fields.',
      'Use metainfer_lab({action:"intake_ready", intakeId:"..."}) only after the required fields are present and the human agrees.',
      'The human clicks the confirm button in the UI; never create the project yourself.',
      'Ask only for missing or uncertain fields, use defaults for the rest, and keep replies short.',
      '',
      '# Form schema and current draft',
      JSON.stringify({ schema: draft.schema, values: draft.values, missing: intakeMissing(draft.schema, draft.values) }, null, 2),
      '',
      '# Conversation so far',
      history,
      '',
      `Human: ${userText}`,
    ].join('\n');
  }

  async function messageIntake(intakeId, rawText) {
    const draft = requireIntake(intakeId);
    const userText = typeof rawText === 'string' ? rawText.trim() : '';
    if (!userText) throw new LabError('bad_request', 'message text is required', 400);
    if (userText.length > 8000) throw new LabError('bad_request', 'message text is too long', 400);
    draft.messages.push({ role: 'user', text: userText, at: Date.now() });
    const anchor = await ensureIntakeAnchor();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('intake turn timed out')), 120_000);
    timer.unref?.();
    let activation;
    try {
      activation = await ctx.subagents.startActivation({
        provider: 'spawn',
        label: `mirl-intake/${draft.intakeId}`,
        delivery: 'caller',
        signal: controller.signal,
        childId: newSessionId(),
        request: {
          parent: anchor,
          cwd: os.homedir(),
          prompt: [{ type: 'text', text: intakePrompt(draft, userText) }],
          agentPreset: 'lab-intake',
        },
      });
      const result = await activation.result;
      const reply = chatTextOf(result?.output).trim();
      if (result?.stopReason !== 'completed') {
        throw new Error(reply || `intake assistant stopped: ${result?.stopReason}`);
      }
      draft.messages.push({ role: 'assistant', text: reply || '(no reply)', at: Date.now() });
      draft.updatedAt = Date.now();
      if (draft.messages.length > 60) draft.messages = draft.messages.slice(-60);
      return { ...intakeSummary(draft), reply: reply || '' };
    } finally {
      clearTimeout(timer);
      if (activation) {
        try {
          await activation.dispose();
        } catch {
          // already settled
        }
      }
    }
  }

  async function confirmIntake(intakeId, options = {}) {
    const draft = requireIntake(intakeId);
    const missing = intakeMissing(draft.schema, draft.values);
    if (missing.length > 0) {
      throw new LabError('intake_incomplete', `missing required fields: ${missing.map((field) => field.label).join(', ')}`, 400);
    }
    const result = await createProject(intakePayload(draft));
    draft.projectId = result.project.id;
    draft.ready = true;
    draft.updatedAt = Date.now();
    let started = false;
    let startError = null;
    if (options.start === true) {
      try {
        await runtime.start(result.project.id, result.rootNode.id);
        started = true;
      } catch (error) {
        startError = error instanceof Error ? error.message : String(error);
      }
    }
    return {
      ...intakeSummary(draft),
      project: result.project,
      rootNode: result.rootNode,
      revision: result.revision,
      started,
      startError,
    };
  }

  function discardIntake(intakeId) {
    const draft = requireIntake(intakeId);
    intakeDrafts.delete(draft.intakeId);
    return { intakeId: draft.intakeId, discarded: true };
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      intakeDrafts.clear();
      try {
        intakeAnchorHandle?.dispose?.();
      } catch {
        // best-effort
      }
      intakeAnchorHandle = null;
      intakeAnchorSessionId = '';
    }, 'metainfer-research-lab: intake sessions');
  }

  async function getChat(projectId) {
    const project = requireProject(projectId);
    return {
      projectId,
      messages: chatMessagesOf(project),
      running: chatLocks.has(projectId),
    };
  }

  async function projectChat(projectId, rawText) {
    const trimmed = typeof rawText === 'string' ? rawText.trim() : '';
    if (!trimmed) throw new LabError('bad_request', 'chat text is required', 400);
    if (trimmed.length > CHAT_LIMIT) throw new LabError('bad_request', 'chat text is too long', 400);
    if (chatLocks.has(projectId)) throw new LabError('chat_busy', 'a project copilot turn is already running', 409);
    const project = requireProject(projectId);
    const model = resolveModelSelection(ctx, project, null, 'controller');
    await saveChatMessage(projectId, { role: 'user', text: trimmed, at: Date.now() });
    const current = requireProject(projectId);
    const promptText = chatPrompt(current, trimmed);
    const task = (async () => {
      let activation;
      let reply = '';
      let failure = null;
      try {
        const controller = await orchestrator.ensureController(current);
        const sessionId = newSessionId();
        activation = await ctx.subagents.startActivation({
          provider: 'spawn',
          label: `mirl-chat/${projectId}`,
          delivery: 'caller',
          signal: new AbortController().signal,
          childId: sessionId,
          request: {
            parent: controller,
            cwd: current.repo.path,
            prompt: [{ type: 'text', text: promptText }],
            agentPreset: 'lab-chat',
            agentOptions: model,
          },
        });
        const result = await Promise.race([
          activation.result,
          new Promise((_, reject) => {
            const timer = setTimeout(
              () => reject(new LabError('chat_timeout', `project chat exceeded ${CHAT_TIMEOUT_MS / 1000}s`, 504)),
              CHAT_TIMEOUT_MS,
            );
            timer.unref?.();
          }),
        ]);
        if (result?.stopReason !== 'completed') failure = `chat stopped: ${result?.stopReason ?? 'unknown'}`;
        reply = chatTextOf(result?.output);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      } finally {
        if (activation) {
          try {
            await activation.dispose();
          } catch {
            // Best-effort cleanup.
          }
        }
      }
      if (failure) {
        const messages = await saveChatMessage(projectId, { role: 'error', text: `Copilot failed: ${failure}`, at: Date.now() });
        return { messages, running: false, error: failure };
      }
      const messages = await saveChatMessage(projectId, {
        role: 'assistant',
        text: reply || '(copilot returned no text)',
        at: Date.now(),
        model,
      });
      return { messages, running: false };
    })();
    chatLocks.set(projectId, task);
    try {
      return await task;
    } finally {
      chatLocks.delete(projectId);
    }
  }

  async function getModels(projectId) {
    const project = requireProject(projectId);
    const catalog = await buildModelCatalog(ctx, project);
    return {
      ...catalog,
      promptDefaults: {
        workerPrefix: DEFAULT_WORKER_PREFIX,
        advisor: DEFAULT_ADVISOR_PROMPT,
        scheduler: DEFAULT_SCHEDULER_PROMPT,
        merge: DEFAULT_MERGE_PROMPT,
        gc: DEFAULT_GC_PROMPT,
      },
      promptPlaceholders: PROMPT_PLACEHOLDERS,
    };
  }

  async function escalateNode(projectId, nodeId, input = {}) {
    if (!runtime) throw new LabError('unavailable', 'runtime is not wired', 503);
    return runtime.escalate(projectId, nodeId, input);
  }

  async function retryNode(projectId, nodeId, input = {}) {
    if (!runtime) throw new LabError('unavailable', 'runtime is not wired', 503);
    const model = input?.model !== undefined ? cleanModelRef(input.model) : undefined;
    if (input?.model !== undefined && !model) {
      throw new LabError('bad_request', 'model must be {profileId} or {provider, model, reasoningEffort?}', 400);
    }
    return runtime.retry(projectId, nodeId, {
      model,
      upgrade: input?.upgrade === true,
      reason: typeof input?.reason === 'string' ? input.reason : undefined,
    });
  }

  async function deleteProject(projectId, options = {}) {
    let authorization = await authorizeIrreversibleTool(projectId, 'delete_project', options, options.exec ?? null);
    const project = requireProject(projectId);
    const nodes = store.listNodes(projectId);
    if (nodes.some((node) => node.status === 'running')) {
      throw new LabError('project_busy', 'cannot delete a project while a node is running', 409);
    }
    try {
      await auto?.stop(projectId);
    } catch {
      // auto may not be wired in tests
    }
    // auto.stop writes an `auto/stopped` event and therefore advances the
    // project revision. Re-read the authorization after that write so the CAS
    // below compares against the revision the delete will actually observe.
    authorization = await authorizeIrreversibleTool(projectId, 'delete_project', options, options.exec ?? null);
    const removeWorktrees = options.removeWorktrees === true;
    let worktreesRemoved = 0;
    if (removeWorktrees && git?.removeWorktree) {
      for (const node of nodes) {
        try {
          if (await git.removeWorktree(project.repo.path, node.git.worktreePath)) worktreesRemoved += 1;
        } catch {
          // Best-effort cleanup; branches and tags stay for history.
        }
      }
      try {
        const { rm } = await import('node:fs/promises');
        await rm(project.repo.worktreeRoot, { recursive: true, force: true });
      } catch {
        // Ignore missing worktree root.
      }
    }
    const deleted = await kernel.executor.deleteProject(projectId, {
      actor: authorization.actor,
      expectedRevision: authorization.projectRevision,
    });
    if (deleted.ok !== true) throw new LabError(deleted.code ?? 'commit_failed', deleted.message ?? 'delete failed', deleted.code === 'stale_basis' ? 409 : 500);
    diffCache.reset(projectId);
    auto?.forget?.(projectId);
    return { deleted: true, projectId, worktreesRemoved, removeWorktrees };
  }

  async function cancelNode(projectId, nodeId, options = {}) {
    const authorization = await authorizeIrreversibleTool(projectId, 'cancel_node', { nodeId, ...options }, options.exec ?? null);
    return runtime.cancel(projectId, nodeId, { expectedRevision: authorization.projectRevision });
  }

  /**
   * Internal/system preemption entrypoint (5.3.2/Q3). The dispatcher owns the
   * decision; this wrapper exists for the process probe and recoverable
   * operator tooling, not as a human bypass of the p0 policy.
   */
  async function preemptNode(projectId, nodeId, options = {}) {
    return runtime.preempt(projectId, nodeId, {
      forNodeId: options.forNodeId ?? null,
      reason: options.reason ?? 'project-local p0 preemption',
      by: options.by ?? 'dispatcher',
      causeId: options.causeId ?? null,
    });
  }

  async function appealPreemption(projectId, nodeId, input = {}, exec = null) {
    const actor = actorFromDisputeExecution(exec);
    if (!actor) throw new LabError('actor_required', 'preemption appeal requires an authenticated actor');
    // `input.actor` is body data and is deliberately ignored.
    return runtime.appealPreemption(projectId, nodeId, {
      reason: input.reason,
      actor,
    });
  }

  async function messageNode(projectId, nodeId, text) {
    return runtime.message(projectId, nodeId, text);
  }

  /**
   * Resolve a previewed absolute path to a regular file inside a managed node
   * worktree. Symlinks that escape the worktree are rejected.
   */
  async function resolveWorktreeFile(filePath) {
    const requested = typeof filePath === 'string' ? filePath.trim() : '';
    if (!requested || !path.isAbsolute(requested)) {
      throw new LabError('bad_request', 'absolute file path is required', 400);
    }
    let resolved;
    try {
      resolved = await realpath(requested);
    } catch {
      throw new LabError('file_not_found', `file not found: ${requested}`, 404);
    }
    let matched = null;
    for (const project of store.listProjects()) {
      const root = project.repo?.worktreeRoot;
      if (!root) continue;
      let rootReal;
      try {
        rootReal = await realpath(root);
      } catch {
        continue;
      }
      const relative = path.relative(rootReal, resolved);
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        matched = project;
        break;
      }
    }
    if (!matched) throw new LabError('file_not_found', 'file is outside managed worktrees', 404);
    let info;
    try {
      info = await stat(resolved);
    } catch {
      throw new LabError('file_not_found', `file not found: ${requested}`, 404);
    }
    if (!info.isFile()) throw new LabError('bad_request', 'path is not a regular file', 400);
    return { path: resolved, name: path.basename(resolved), size: info.size, projectId: matched.id };
  }

  /** Read the durable event trace of one node's external execution. */
  async function getExecutionEvents(projectId, nodeId, after = 0) {
    const node = requireNode(projectId, nodeId);
    const run = node.executionRun;
    if (!run || !run.logPath) {
      return { events: [], next: 0, running: node.status === 'running', executionRun: null };
    }
    const log = new ExecutionLog(run.logPath);
    const parsedAfter = Number.isFinite(Number(after)) ? Math.max(0, Math.trunc(Number(after))) : 0;
    const result = await log.read(parsedAfter);
    return {
      events: result.events,
      next: result.next,
      running: node.status === 'running' && run.status === 'running',
      executionRun: run,
    };
  }

  /**
   * Ensure a node's worktree exists for browsing. A worktree deleted to reclaim
   * disk is recreated from the node branch; a planned node gets its branch at
   * the recorded base commit. No experiment is started.
   */
  async function ensureNodeWorktree(projectId, nodeId) {
    if (!runtime) throw new LabError('unavailable', 'runtime is not wired', 503);
    const project = requireProject(projectId);
    const node = requireNode(projectId, nodeId);
    if (!node.git || !node.git.worktreePath) {
      throw new LabError('worktree_not_recorded', 'node has no recorded worktree path', 404);
    }
    const ensured = await git.ensureWorktree(project, node);
    let sessionId = typeof node.sessionId === 'string' ? node.sessionId : '';
    let sessionAvailable = false;
    if (sessionId && ctx.sessionQuery) {
      try {
        await ctx.sessionQuery.readSession(sessionId);
        sessionAvailable = true;
      } catch {
        sessionAvailable = false;
      }
    }
    if (!sessionAvailable) {
      if (!node.anchorSessionId) {
        throw new LabError('session_unavailable', 'node has no usable session for file browsing', 404);
      }
      await runtime.ensureAnchor(project, node);
      sessionId = node.anchorSessionId;
    }
    if (!ensured.reused) {
      await commitMutations(projectId, [{
        op: 'event.record',
        type: 'worktree/ensured',
        nodeId,
        data: { path: ensured.worktreePath, branch: node.git.branch },
      }], { causeId: `worktree:${nodeId}` });
    }
    return {
      projectId,
      nodeId,
      worktreePath: ensured.worktreePath,
      branch: node.git.branch,
      sessionId,
      recreated: !ensured.reused,
    };
  }

  async function getSessionTranscript(projectId, sessionId, afterSeq = 0, limit = 200) {
    const project = requireProject(projectId);
    const id = typeof sessionId === 'string' ? sessionId : '';
    if (!id) throw new LabError('bad_request', 'sessionId is required', 400);
    const allowed = new Set();
    const add = (value) => { if (typeof value === 'string' && value) allowed.add(value); };
    add(project.controllerSessionId);
    for (const entry of project.copilotSessions || []) add(entry?.id);
    add(project.activeCopilotSessionId);
    for (const node of store.listNodes(projectId)) {
      add(node.anchorSessionId); add(node.sessionId);
      for (const attempt of node.attempts || []) {
        add(attempt.sessionId); add(attempt.anchorSessionId);
      }
    }
    if (orchestrator && typeof orchestrator.listRuns === 'function') {
      try {
        const listed = await orchestrator.listRuns(projectId);
        const runs = Array.isArray(listed) ? listed : (Array.isArray(listed?.runs) ? listed.runs : []);
        for (const run of runs) add(run.sessionId);
      } catch {
        // A run index failure must not make controller/node transcripts unreadable.
      }
    }
    if (!allowed.has(id)) throw new LabError('session_not_found', `session does not belong to project: ${id}`, 404);
    const after = Number.isFinite(Number(afterSeq)) ? Math.max(0, Math.trunc(Number(afterSeq))) : 0;
    let snapshot;
    try {
      snapshot = await ctx.sessionQuery.readSurface(id);
    } catch {
      return { sessionId: id, rows: [], nextSeq: after, unavailable: true };
    }
    const rows = [];
    const maxRows = Math.max(1, Math.min(1000, Number.isFinite(limit) ? Math.trunc(limit) : 200));
    let hasMore = false;
    let scannedThrough = after;
    const textOf = (blocks) => (Array.isArray(blocks) ? blocks : [])
      .map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .filter(Boolean).join('\n').trim();
    for (const event of Array.isArray(snapshot?.events) ? snapshot.events : []) {
      const seq = event?.seq;
      if (!Number.isFinite(seq) || seq <= after) continue;
      scannedThrough = seq;
      const data = event?.data ?? {};
      if (event.type === 'user/message') {
        const text = textOf(data.content);
        if (text) rows.push({ seq, at: event.time, kind: 'user', text });
      } else if (event.type === 'assistant/message') {
        for (const block of data.message?.content ?? []) {
          if (block?.type === 'text' && block.text) rows.push({ seq, at: event.time, kind: 'assistant', text: block.text });
          else if (block?.type === 'reasoning' && block.text) rows.push({ seq, at: event.time, kind: 'reasoning', text: block.text });
          else if (block?.type === 'tool-call') rows.push({ seq, at: event.time, kind: 'tool', name: block.name, args: block.arguments });
        }
      } else if (event.type === 'tool/result') {
        rows.push({ seq, at: event.time, kind: 'tool-result', text: textOf(data.message?.content), error: Boolean(data.message?.isError) });
      }
      if (rows.length >= maxRows) { hasMore = true; break; }
    }
    rows.sort((a, b) => a.seq - b.seq || (a.at ?? 0) - (b.at ?? 0));
    const nextSeq = rows.length ? Math.max(...rows.map((row) => row.seq)) : after;
    return {
      sessionId: id,
      header: snapshot?.header ?? null,
      rows,
      nextSeq: hasMore ? Math.max(nextSeq, scannedThrough) : nextSeq,
      hasMore,
      _truncated: hasMore ? { rows: { shown: rows.length, max: maxRows } } : null,
    };
  }

  async function getTranscript(projectId, nodeId, afterSeq, limit = 200) {
    if (!transcript) throw new LabError('unavailable', 'transcript reader is not wired', 503);
    return transcript.read(projectId, nodeId, afterSeq, limit);
  }

  async function step(projectId, trigger = 'manual') {
    if (!orchestrator) throw new LabError('unavailable', 'orchestrator is not wired', 503);
    return orchestrator.step(projectId, trigger);
  }

  async function createSuccessor(projectId, nodeId, input) {
    if (!orchestrator) throw new LabError('unavailable', 'orchestrator is not wired', 503);
    return orchestrator.createSuccessor(projectId, nodeId, input);
  }

  async function createMergeNode(projectId, input) {
    if (!orchestrator) throw new LabError('unavailable', 'orchestrator is not wired', 503);
    return orchestrator.createMergeNode(projectId, input);
  }

  async function pushProject(projectId, input = {}) {
    const project = requireProject(projectId);
    // Push only refs that actually exist (planned nodes may have a branch name but no ref yet).
    const branchRefs = await git.listRefs(project.repo.path, `refs/heads/dshex/${projectId}/`);
    const tagRefs = await git.listRefs(project.repo.path, `refs/tags/dshex-sealed/${projectId}/`);
    const nodeBranches = store
      .listNodes(projectId)
      .map((node) => node.git?.branch)
      .filter(Boolean)
      .map((branch) => `refs/heads/${branch}`);
    const refs = [...new Set([...branchRefs, ...nodeBranches.filter((ref) => branchRefs.includes(ref)), ...tagRefs])];
    if (refs.length === 0) throw new LabError('nothing_to_push', 'no branches or tags to push', 409);
    const remote = (typeof input.remote === 'string' && input.remote.trim())
      || project.config.git?.remote
      || 'origin';
    const result = await git.pushProject(project.repo.path, remote, refs);
    return {
      projectId,
      remote: result.remote,
      pushedRefs: result.refs,
      stdout: result.stdout,
    };
  }

  async function finishMerge(projectId, nodeId, input) {
    if (!runtime) throw new LabError('unavailable', 'runtime is not wired', 503);
    return runtime.finishMerge(projectId, nodeId, input ?? {});
  }

  async function listRuns(projectId, limit) {
    if (!orchestrator) throw new LabError('unavailable', 'orchestrator is not wired', 503);
    return orchestrator.listRuns(projectId, limit);
  }

  function listRunsPage(projectId, { limit = 50, cursor = null } = {}) {
    requireProject(projectId);
    const page = store.pageRuns(projectId, { limit, cursor });
    return {
      ok: true,
      projectId,
      ...page,
      hasMore: page.nextCursor !== null,
      _truncated: page.nextCursor !== null ? { runs: { shown: page.runs.length, total: page.total } } : null,
    };
  }

  async function getRun(projectId, runIdValue) {
    if (!orchestrator) throw new LabError('unavailable', 'orchestrator is not wired', 503);
    return orchestrator.getRun(projectId, runIdValue);
  }

  async function approveProposal(projectId, nodeId) {
    if (!orchestrator) throw new LabError('unavailable', 'orchestrator is not wired', 503);
    const result = await orchestrator.approveProposal(projectId, nodeId);
    auto?.notifyChange(projectId);
    return result;
  }

  async function rejectProposal(projectId, nodeId) {
    if (!orchestrator) throw new LabError('unavailable', 'orchestrator is not wired', 503);
    const result = await orchestrator.rejectProposal(projectId, nodeId);
    auto?.notifyChange(projectId);
    return result;
  }

  async function autoStart(projectId) {
    if (!auto) throw new LabError('unavailable', 'auto controller is not wired', 503);
    return auto.start(projectId);
  }

  async function autoStop(projectId) {
    if (!auto) throw new LabError('unavailable', 'auto controller is not wired', 503);
    return auto.stop(projectId);
  }

  async function autoResume(projectId) {
    if (!auto) throw new LabError('unavailable', 'auto controller is not wired', 503);
    return auto.resume(projectId);
  }

  async function autoStatus(projectId) {
    if (!auto) return { status: 'off', pauseReason: null };
    return auto.statusOf(projectId);
  }

  /**
   * One dispatcher for the `metainfer_lab` agent tool (same operations as the UI).
   * @param {object} input tool arguments.
   * @returns {Promise<object>} compact result object for the tool.
   */
  function budgetFor(exec) {
    const sessionId = exec?.agent?.session?.id ?? 'anonymous';
    let entry = budgets.get(sessionId);
    if (!entry) {
      entry = { budget: createExplorationBudget(), lastAt: Date.now() };
      if (budgets.size >= MAX_BUDGET_SESSIONS) {
        const oldest = [...budgets.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt)[0];
        if (oldest) budgets.delete(oldest[0]);
      }
      budgets.set(sessionId, entry);
    }
    entry.lastAt = Date.now();
    return entry.budget;
  }

  function projectNodes(projectId) {
    requireProject(projectId);
    return store.listNodes(projectId);
  }

  const observerSweepAt = new Map();

  async function dispatchOnceAction(projectId, options = {}) {
    if (typeof dispatchOnce !== 'function') {
      return rejection('unavailable', 'deterministic dispatch is not wired in this Host build');
    }
    requireProject(projectId);
    const now = Date.now();
    // The auto tick runs every 2s; scanning the full event log for observer
    // dedup on every tick would be O(all events). Explicit dispatch_once still
    // sweeps immediately, while auto sweeps at the observer's own cadence.
    const sweepObserver = options.includeStatus !== false
      || now - (observerSweepAt.get(projectId) ?? 0) >= 30_000;
    if (sweepObserver) {
      observerSweepAt.set(projectId, now);
      await escalateStalled(projectId, { now });
    }
    await archiveDeferred(projectId, { now });
    const joined = await autoJoinCompleted(projectId);
    await rotateDueExperts(projectId);
    // Timeout defaults are applied by the same tick that takes the dispatch
    // commit point; a pending dispute therefore cannot block forever.
    await sweepDisputes(projectId);
    const round = await dispatchOnce(projectId, options);
    // O3: runnable→claimed latency is measured from the instant the node could
    // actually enter the runnable queue (plannedAt, deferUntil or the release
    // of dispatchHold), not from createdAt. The same pass records the
    // per-decision rows so a percentile can be audited back to a concrete node.
    const afterNodes = new Map(store.listNodes(projectId).map((node) => [node.id, node]));
    const at = Date.now();
    const queueWaits = [];
    const decisions = [];
    for (const nodeId of round.startedNodeIds ?? []) {
      const node = afterNodes.get(nodeId);
      const queuedAt = runnableSince(node);
      const startedAt = Number(node?.timestamps?.startedAt ?? at);
      const waitMs = Number.isFinite(queuedAt) ? Math.max(0, startedAt - queuedAt) : null;
      if (waitMs !== null) queueWaits.push({ nodeId, waitMs });
      decisions.push({ nodeId, status: 'started', code: null, waitMs, at });
    }
    for (const skip of round.skipped ?? []) {
      decisions.push({ nodeId: skip?.nodeId ?? null, status: skip?.status ?? 'skipped', code: skip?.code ?? null, waitMs: null, at });
    }
    metricsCollector.recordDispatch(projectId, {
      durationMs: round.durationMs ?? 0,
      started: round.started ?? 0,
      skipped: round.skipped ?? [],
      queueWaits,
      decisions,
      at,
    });
    if (options.includeStatus === false) return { ...round };
    return { ...round, status: await statusFacts(projectId) };
  }

  /**
   * Resource-side facts for one node (or the project): queue position, held and
   * free pools, the broker's blocked reason and any reserved start. This is the
   * read-only tool experts use before proposing a smaller shape; it never
   * mutates or reserves anything.
   */
  async function resourceStatus(projectId, nodeId = null) {
    const facts = await statusFacts(projectId);
    const node = nodeId ? requireNode(projectId, nodeId) : null;
    const queueEntry = node ? facts.nextToStart.find((row) => row.nodeId === node.id) ?? null : null;
    const position = queueEntry
      ? facts.nextToStart.findIndex((row) => row.nodeId === node.id) + 1
      : null;
    const resourceWait = node?.resourceWait ?? null;
    return {
      ok: true,
      projectId,
      revision: facts.revision,
      generatedAt: facts.generatedAt,
      resources: facts.resources,
      queue: {
        runnable: facts._truncated?.nextToStart?.total ?? facts.nextToStart.length,
        truncated: facts._truncated?.nextToStart ?? null,
        position,
      },
      node: node
        ? {
            nodeId: node.id,
            status: node.status,
            priority: node.priority ?? null,
            needs: node.needs ?? {},
            resourcesHeld: node.resourcesHeld ?? {},
            lease: node.lease ?? null,
            resourceWait,
            blockedBy: resourceWait?.reason ?? queueEntry?.why ?? null,
            reservedStartAt: resourceWait?.startAt ?? resourceWait?.reservedStartAt ?? null,
            why: queueEntry?.why ?? null,
          }
        : null,
    };
  }

  async function statusFacts(projectId) {
    const project = requireProject(projectId);
    let autoStatus = null;
    try {
      autoStatus = auto.statusOf(projectId);
    } catch {
      autoStatus = null;
    }
    return buildStatusFacts({
      project,
      nodes: store.listNodes(projectId),
      auto: autoStatus,
      cluster,
      now: Date.now(),
    });
  }

  async function metricsFor(projectId) {
    const project = requireProject(projectId);
    let autoStatus = null;
    try {
      autoStatus = auto.statusOf(projectId);
    } catch {
      autoStatus = null;
    }
    const nodes = store.listNodes(projectId);
    const runs = store.listRuns(projectId, 100);
    const metrics = computeProjectMetrics({
      project,
      nodes,
      archived: store.countArchived(projectId),
      runs,
      cycles: store.listCycles(projectId, 100),
      live: metricsCollector.snapshot(projectId),
      auto: autoStatus,
      now: Date.now(),
    });
    // C2/5.4: expose the hierarchy's chief ratio, escalation rate, pending
    // windows and compression/coverage next to the ordinary run metrics.
    const hierarchy = buildHierarchyReview({ project, nodes, now: Date.now() });
    const chiefRuns = runs.filter((run) => run.preset === 'lab-chief' || run.expertId === 'lab-chief' || run.createdBy === 'lab-chief');
    const completed = nodes.filter((node) => node.status === 'completed').length;
    const escalationRows = Array.isArray(project.reviewEscalations) ? project.reviewEscalations : [];
    return {
      ...metrics,
      review: {
        levels: hierarchy.layers.map((layer) => layer.level),
        branchCount: hierarchy.branchCount,
        groupedTeams: hierarchy.groupedTeams,
        chief: { ...chiefPolicy(project), ...chiefActivationMetrics({ activations: chiefRuns.length, completed }) },
        escalationRate: escalationRate({ escalations: escalationRows, intents: Array.isArray(project.intents) ? project.intents : [] }),
        pendingHighReview: nodes.filter((node) => node.pendingHighReview).length,
        unreviewed: nodes.filter((node) => node.highReview?.status === 'unreviewed').length,
        coverage: hierarchy.coverage,
        compression: hierarchy.compression.perLayer,
      },
    };
  }

  function explainNode(projectId, nodeId, options = {}) {
    requireProject(projectId);
    return publicView(explainer.explainNode(projectId, nodeId, options));
  }

  function traceExplain(projectId, nodeId, options = {}) {
    requireProject(projectId);
    return publicView(explainer.traceExplain(projectId, nodeId, options));
  }

  function projectRevision(projectId) {
    return store.getProject(projectId)?.revision ?? 0;
  }

  async function dagQuery(projectId, input, exec) {
    const budget = budgetFor(exec);
    const nodes = projectNodes(projectId);
    const result = { ...queryDag({
      nodes,
      filter: input?.filter ?? {},
      select: input?.select,
      limit: input?.limit,
      cursor: input?.cursor ?? null,
      order: input?.order,
    }), revision: projectRevision(projectId) };
    const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    const charge = budget.charge({ bytes });
    if (!charge.ok) return { ok: false, error: { code: charge.code, dimension: charge.dimension, message: charge.message, nextStep: charge.nextStep } };
    return { ...result, budget: { remaining: charge.remaining } };
  }

  async function dagGetAction(projectId, input, exec) {
    const budget = budgetFor(exec);
    const result = { ...dagGet({ nodes: projectNodes(projectId), nodeIds: input?.nodeIds ?? [], select: input?.select, neighbors: input?.neighbors !== false }), revision: projectRevision(projectId) };
    const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    const charge = budget.charge({ bytes });
    if (!charge.ok) return { ok: false, error: { code: charge.code, dimension: charge.dimension, message: charge.message, nextStep: charge.nextStep } };
    return { ...result, budget: { remaining: charge.remaining } };
  }

  function dagMapAction(projectId, input) {
    requireProject(projectId);
    const by = ['status', 'depth', 'owner', 'parent'].includes(input?.by) ? input.by : 'status';
    const sample = Number.isFinite(input?.sample) ? Math.max(1, Math.min(20, input.sample)) : 5;
    const revision = projectRevision(projectId);
    return mapDag({ nodes: projectNodes(projectId), by, sample, envelope: { projectId, revision } });
  }

  function dagWalkAction(projectId, input) {
    requireProject(projectId);
    const from = text(input?.from, 'from', { required: true, max: 120 });
    const nodes = projectNodes(projectId);
    const revision = projectRevision(projectId);
    const result = walkDag({ nodes, from, direction: input?.direction === 'up' ? 'up' : 'down', depth: input?.depth, limit: input?.limit, envelope: { projectId, revision } });
    if (result.ok !== true) return rejection(result.code ?? 'node_not_found', result.message ?? `node ${from} does not exist`);
    return result;
  }

  function dagDiffAction(projectId, input) {
    requireProject(projectId);
    const since = Number.isFinite(Number(input?.sinceRevision)) ? Math.max(0, Math.trunc(Number(input.sinceRevision))) : null;
    const nodes = projectNodes(projectId);
    const revision = projectRevision(projectId);
    // The cache keeps a bounded snapshot history. A caller-supplied revision
    // older than that history cannot be reconstructed (events are the durable
    // source) — the cache returns `diff_unavailable` instead of a wrong delta.
    return { ...diffCache.diff(projectId, nodes, revision, since), projectId, revision };
  }

  async function nodesPageAction(projectId, input) {
    requireProject(projectId);
    const limit = Number.isFinite(input?.limit) ? Math.max(1, Math.min(500, input.limit)) : 100;
    const cursor = typeof input?.cursor === 'string' && input.cursor ? input.cursor : null;
    const page = store.listNodes(projectId, { limit, cursor });
    const total = store.countNodes(projectId);
    const nextCursor = page.length === limit ? page[page.length - 1]?.id ?? null : null;
    return { ok: true, projectId, nodes: page, nextCursor, total, hasMore: nextCursor !== null };
  }

  async function eventsPageAction(projectId, input) {
    requireProject(projectId);
    const after = Number.isFinite(Number(input?.after)) ? Math.max(0, Math.trunc(Number(input.after))) : 0;
    const limit = Number.isFinite(input?.limit) ? Math.max(1, Math.min(500, input.limit)) : 100;
    const page = store.pageEvents(projectId, { after, limit });
    return { ok: true, projectId, events: page.events, nextSeq: page.nextSeq, total: page.total, hasMore: page.hasMore };
  }

  function reviewClaimAction(projectId, input, exec) {
    requireProject(projectId);
    if (!orchestrator) return rejection('unavailable', 'review claims are not wired');
    const nodeId = text(input?.nodeId, 'nodeId', { required: true, max: 120 });
    const expertId = exec?.agent?.session?.id ?? 'operator';
    const result = orchestrator.reviewClaims.claim({ projectId, nodeId, expertId, intent: input?.op, title: input?.title, ttlMs: input?.ttlMs });
    if (result.ok !== true) return rejection(result.code ?? 'review_claimed', result.message ?? 'claim failed', result.holder ? { holder: result.holder } : {});
    return { ok: true, claim: result.claim, refreshed: result.refreshed === true };
  }

  function reviewReleaseAction(projectId, input, exec) {
    requireProject(projectId);
    if (!orchestrator) return rejection('unavailable', 'review claims are not wired');
    const nodeId = text(input?.nodeId, 'nodeId', { required: true, max: 120 });
    const expertId = exec?.agent?.session?.id ?? 'operator';
    const result = orchestrator.reviewClaims.release({ projectId, nodeId, expertId });
    if (result.ok !== true) return rejection(result.code ?? 'not_claimed', result.message ?? 'release failed', result.holder ? { holder: result.holder } : {});
    return { ok: true };
  }

  function reviewClaimsAction(projectId) {
    requireProject(projectId);
    if (!orchestrator) return rejection('unavailable', 'review claims are not wired');
    return { ok: true, projectId, claims: orchestrator.reviewClaims.list(projectId) };
  }

  function ledgerRead(projectId, limits) {
    requireProject(projectId);
    return publicView({ ok: true, projectId, ledger: ledgerReader.view(projectId, limits) });
  }

  async function ledgerUpdate(projectId, input, exec) {
    const project = requireProject(projectId);
    const op = input?.op;
    const id = text(input?.id, 'id', { required: true, max: 120 });
    const known = ['open', 'confirm', 'rule_out'];
    if (!known.includes(op)) {
      return rejection('bad_request', `ledger op must be one of ${known.join(', ')}`);
    }
    const data = { id, expertId: exec?.agent?.session?.id ?? 'operator' };
    if (op === 'open') data.hypothesis = text(input?.hypothesis, 'hypothesis', { required: true, max: 2000 });
    if (op === 'rule_out') data.reason = text(input?.reason, 'reason', { required: true, max: 1000 });
    if (op === 'confirm') data.note = text(input?.note, 'note', { max: 1000 });
    if (input?.nodeId) data.nodeId = text(input.nodeId, 'nodeId', { max: 120 });
    if (Array.isArray(input?.evidence)) data.evidence = input.evidence.slice(0, 10);
    const result = await commitMutations(projectId, [{
      op: 'event.record',
      type: `ledger/${op}`,
      data,
    }], { actor: { kind: 'expert', id: data.expertId }, causeId: `ledger:${projectId}:${data.expertId}` });
    const event = result.events[0];
    ledgerReader.invalidate(projectId);
    return { ok: true, projectId, event: { seq: event.seq, type: event.type }, ledger: ledgerReader.view(projectId) };
  }

  const curator = createCurator({ clock: () => Date.now() });

  const EXPERT_LIFECYCLE_STATUSES = Object.freeze(['active', 'draining', 'retired']);

  function expertRosterOf(project) {
    const raw = project?.config?.experts;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((row) => row && typeof row === 'object' && typeof row.expertId === 'string')
      .map((row) => structuredClone(row));
  }

  function expertRosterRow(project, expertId) {
    return expertRosterOf(project).find((row) => row.expertId === expertId) ?? null;
  }

  function expertLifecycleOf(project, expertId) {
    const row = expertRosterRow(project, expertId);
    if (!row) return { status: 'catalog', active: false };
    const lifecycle = {
      status: EXPERT_LIFECYCLE_STATUSES.includes(row.status) ? row.status : 'retired',
      active: row.status === 'active' && !(row.temporary === true && Number(row.expiresAt) > 0 && Number(row.expiresAt) <= Date.now()),
      hiredAt: row.hiredAt ?? null,
      hiredBy: row.hiredBy ?? null,
      drainedAt: row.drainedAt ?? null,
      retiredAt: row.retiredAt ?? null,
      temporary: row.temporary === true,
      invitedAt: row.invitedAt ?? null,
      expiresAt: row.expiresAt ?? null,
      expired: row.temporary === true && Number(row.expiresAt) > 0 && Number(row.expiresAt) <= Date.now(),
    };
    return lifecycle;
  }

  /** An empty roster means the catalog is available; a non-empty roster is the source of truth. */
  function recruitabilityOf(project) {
    const roster = expertRosterOf(project);
    if (roster.length === 0) return listExpertDescriptors();
    const now = Date.now();
    const active = new Set(roster
      .filter((row) => row.status === 'active' && !(row.temporary === true && Number(row.expiresAt) > 0 && Number(row.expiresAt) <= now))
      .map((row) => row.expertId));
    return listExpertDescriptors().filter((descriptor) => active.has(descriptor.id));
  }

  function assertOperator(actor, action) {
    if (actor?.kind === 'expert') {
      throw new LabError('forbidden_expert_action', `experts may not ${action}; the Host owns the roster`, 403);
    }
  }

  function rotationMaxDays(project) {
    const value = Number(project?.config?.scheduling?.rotationDays ?? project?.config?.rotationDays ?? DEFAULT_ROTATION_DAYS);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_ROTATION_DAYS;
  }

  function rotationExperts(project) {
    return recruitabilityOf(project).map((descriptor) => descriptor.id).filter((id) => typeof id === 'string');
  }

  /** B23: same expert + same branch beyond N days is a deterministic rotation. */
  function rotationStatus(projectId) {
    const project = requireProject(projectId);
    const plan = rotationPlan({
      nodes: store.listNodes(projectId),
      experts: rotationExperts(project),
      rotations: project.expertRotations ?? {},
      now: Date.now(),
      maxDays: rotationMaxDays(project),
    });
    return publicView({
      ok: true,
      projectId,
      maxDays: rotationMaxDays(project),
      policy: { maxDays: rotationMaxDays(project), defaultDays: DEFAULT_ROTATION_DAYS, minDays: 1, maxDaysLimit: 365, unit: 'days' },
      rotations: project.expertRotations ?? {},
      assignments: plan.assignments,
      due: plan.due,
    });
  }

  async function commitRotation(projectId, decision, actor, now = Date.now()) {
    const project = requireProject(projectId);
    const record = {
      branchId: decision.branchId,
      expertId: decision.expertId,
      nextExpertId: decision.nextExpertId,
      rotatedAt: now,
      rotatedBy: { kind: actor?.kind ?? 'system', id: actor?.id ?? 'rotator' },
      reason: decision.reason,
      assignedNodeIds: [],
    };
    // 5.3.12: consuming nextExpertId is a real assignment change, not just an
    // audit row. Move createdBy for this branch and stamp the rotation epoch so
    // the same branch is not immediately due again for the new expert.
    const updates = [];
    for (const nodeId of Array.isArray(decision.nodeIds) ? decision.nodeIds : []) {
      const node = store.getNode(projectId, nodeId);
      if (!node || node.archivedAt || node.createdBy !== record.expertId) continue;
      updates.push({
        op: 'node.update',
        nodeId,
        set: { createdBy: record.nextExpertId, expertAssignedAt: now },
        eventType: 'node/expert_assigned',
        eventData: { branchId: record.branchId, from: record.expertId, to: record.nextExpertId, at: now },
      });
      record.assignedNodeIds.push(nodeId);
    }
    const result = await commitMutations(projectId, [
      ...updates,
      {
        op: 'project.update',
        set: { expertRotations: { ...(project.expertRotations ?? {}), [record.branchId]: record } },
        eventType: 'expert/rotated',
        eventData: { ...record, title: `expert rotation: ${record.expertId} -> ${record.nextExpertId}` },
      },
    ], { actor, causeId: `rotation:${record.branchId}:${now}` });
    return publicView({ ok: true, projectId, rotation: record, revision: store.getProject(projectId)?.revision ?? null, commitRevision: result.revision ?? null });
  }

  /** Explicit operator rotation (the production path also rotates automatically). */
  async function rotateExpert(projectId, input = {}, exec = null) {
    const project = requireProject(projectId);
    const actor = actorFromDisputeExecution(exec) ?? actorForSession({ sessionId: 'operator' });
    const branchId = typeof input.branchId === 'string' ? input.branchId : '';
    if (!branchId) return rejection('bad_request', 'branchId is required');
    const experts = rotationExperts(project);
    const current = typeof input.expertId === 'string' && input.expertId
      ? input.expertId
      : project.expertRotations?.[branchId]?.expertId
        ?? store.listNodes(projectId).find((node) => node.id === branchId)?.createdBy
        ?? null;
    const next = typeof input.nextExpertId === 'string' && input.nextExpertId
      ? input.nextExpertId
      : experts.filter((id) => id !== current).sort()[0] ?? null;
    if (!current || !next) return rejection('rotation_unavailable', 'need a current expert and one different active expert');
    if (next === current) return rejection('rotation_same_expert', 'rotation must assign a different expert');
    if (experts.length > 0 && (!experts.includes(next) || !experts.includes(current))) {
      return rejection('rotation_unknown_expert', 'both experts must be active in this project roster');
    }
    return commitRotation(projectId, {
      branchId,
      expertId: current,
      nextExpertId: next,
      reason: typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim().slice(0, 500) : 'explicit operator rotation',
    }, actor);
  }

  /**
   * C1: archive deferred nodes past their TTL. The sweep is called by the same
   * dispatch tick that rotates experts, so it cannot depend on a human click.
   * A bounded batch keeps one tick from writing hundreds of events.
   */
  async function archiveDeferred(projectId, { now = Date.now() } = {}) {
    const project = requireProject(projectId);
    const ttlDays = Number(project?.config?.scheduling?.deferredTtlDays ?? 7);
    const ttlMs = Math.max(1, Number.isFinite(ttlDays) ? ttlDays : 7) * 86_400_000;
    const candidates = store.listNodes(projectId)
      .filter((node) => node.status === 'planned'
        && node.priority?.class === 'deferred'
        && !node.archivedAt)
      .map((node) => {
        const since = Number(node.priority?.at ?? node.timestamps?.createdAt ?? 0);
        return { node, since, ageMs: now - since };
      })
      .filter((row) => Number.isFinite(row.since) && row.since > 0 && row.ageMs > ttlMs)
      .slice(0, 50);
    const archived = [];
    for (const row of candidates) {
      const commit = await commitMutations(projectId, [{
        op: 'node.archive',
        nodeId: row.node.id,
        reason: `deferred_ttl:${ttlDays}d`,
      }], { actor: { kind: 'system', id: 'deferred-archiver' }, causeId: `deferred-ttl:${row.node.id}:${now}` });
      if (commit.ok !== false) archived.push(row.node.id);
    }
    return { ok: true, projectId, ttlDays, archived };
  }

  /**
   * 5.3.7: a true join primitive. When all direct children of a completed node
   * have committed branches, create the merge node deterministically instead of
   * waiting for a human to run `finish_merge`. The merge still runs as a normal
   * node; `finish_merge` remains the conflict-safe fallback.
   *
   * Only one join per tick is created, and an existing merge with the exact
   * parent set suppresses a duplicate.
   */
  async function autoJoinCompleted(projectId) {
    const project = requireProject(projectId);
    if (project.config?.scheduling?.autoJoin === false) return { ok: true, projectId, created: [] };
    if (!orchestrator || typeof orchestrator.createMergeNode !== 'function') return { ok: true, projectId, created: [] };
    if (!git) return { ok: true, projectId, created: [] };
    const nodes = store.listNodes(projectId);
    const existing = new Set(nodes
      .filter((node) => node.kind === 'merge' && Array.isArray(node.parentIds))
      .map((node) => [...node.parentIds].sort().join(',')));
    const byParent = new Map();
    for (const node of nodes) {
      if (node.status !== 'completed' || !node.git?.headCommit) continue;
      if (node.kind === 'merge') continue;
      const parentId = node.parentId;
      if (!parentId) continue;
      if (!byParent.has(parentId)) byParent.set(parentId, []);
      byParent.get(parentId).push(node);
    }
    for (const [parentId, children] of byParent) {
      if (children.length < 2 || children.length > 4) continue;
      const ids = children.map((node) => node.id).sort();
      if (existing.has(ids.join(','))) continue;
      try {
        const result = await orchestrator.createMergeNode(projectId, {
          parentIds: ids,
          title: `Join ${children.map((node) => node.title).join(' + ').slice(0, 120)}`,
        });
        return { ok: true, projectId, created: [result?.node?.id ?? result?.id ?? null], parentId, parentIds: ids };
      } catch (error) {
        return { ok: false, projectId, created: [], code: error?.code ?? 'auto_join_failed', message: error?.message ?? String(error) };
      }
    }
    return { ok: true, projectId, created: [] };
  }

  /**
   * 5.4.2: one read model for session/transcript/event retention. It classifies
   * Copilot sessions into hot/cold/prune and reports the event segments already
   * cold-archived by the store. It is deliberately a plan: the Host never
   * deletes a session behind the operator's back.
   */
  async function retentionPlan(projectId, { now = Date.now() } = {}) {
    const project = requireProject(projectId);
    const policy = {
      sessionDays: Number(project.config?.retention?.sessionDays ?? 90),
      coldAfterDays: Number(project.config?.retention?.coldAfterDays ?? 7),
      transcriptDays: Number(project.config?.retention?.transcriptDays ?? 180),
      hotEvents: Number(project.config?.storage?.hotEvents ?? store.hotEvents ?? 0),
    };
    const sessions = copilotEntriesOf(project).map((entry) => {
      const ageMs = Math.max(0, now - Number(entry.updatedAt || entry.createdAt || now));
      const ageDays = Math.floor(ageMs / 86_400_000);
      const action = ageDays >= policy.sessionDays ? 'prune' : ageDays >= policy.coldAfterDays ? 'cold' : 'hot';
      return { id: entry.id, title: entry.title, ageDays, updatedAt: entry.updatedAt || null, action };
    });
    const segments = typeof store.listEventSegments === 'function' ? await store.listEventSegments(projectId) : [];
    return publicView({
      ok: true,
      projectId,
      now,
      policy,
      sessions,
      summary: {
        hot: sessions.filter((row) => row.action === 'hot').length,
        cold: sessions.filter((row) => row.action === 'cold').length,
        prune: sessions.filter((row) => row.action === 'prune').length,
      },
      events: { segments: segments.length, hotEvents: Math.max(0, store.maxEventSeq(projectId) - segments.reduce((sum, row) => sum + Number(row.count ?? row.events ?? 0), 0)) },
      destructive: false,
    });
  }

  /** Called by the dispatch tick, so rotation does not depend on a human click. */
  async function rotateDueExperts(projectId, { now = Date.now() } = {}) {
    const status = rotationStatus(projectId);
    if (status.due.length === 0) return { ok: true, projectId, rotated: [] };
    const rotated = [];
    for (const decision of status.due) {
      const result = await commitRotation(projectId, decision, { kind: 'system', id: 'rotation' }, now);
      if (result.ok === true) rotated.push(result.rotation);
    }
    return publicView({ ok: true, projectId, rotated });
  }

  /** C13 performance: disputes raised/won, not proposal acceptance rate. */
  function disputePerformance(project, expertId) {
    const rows = (Array.isArray(project.disputes) ? project.disputes : []).filter((record) => record?.raiser?.id === expertId);
    return {
      disputesRaised: rows.length,
      disputesWon: rows.filter((record) => record.status === 'resolved' && ['apply_change', 'upheld'].includes(record.resolution)).length,
      disputesLost: rows.filter((record) => record.status === 'resolved' && ['keep_current', 'rejected'].includes(record.resolution)).length,
    };
  }

  /** Expert descriptors plus Host-computed performance metrics (Stage 4.1). */
  function listExperts(projectId, { actor = null } = {}) {
    const project = requireProject(projectId);
    const nodes = store.listNodes(projectId);
    const runs = store.listRuns(projectId);
    return publicView({
      ok: true,
      projectId,
      revision: project.revision,
      experts: filterVisibleExperts(listExpertDescriptors(), actor).map((descriptor) => {
        // Q4: budget is a descriptor contract, so expose its measured usage and
        // whether this project is still inside it. `runs` is the same bounded
        // list the performance metrics use.
        const expertRuns = runs.filter((run) => run.expertId === descriptor.id || run.preset === descriptor.id || run.createdBy === descriptor.id);
        // Q4 windows: queries are per run, tokens are per rolling hour, and
        // wall clock is a single-run maximum. Summing all history makes every
        // long-lived project look over budget even when each run is small.
        const runQueries = (run) => Number(run.queries ?? run.usage?.queries ?? run.usage?.queryCount ?? 0);
        const runTokens = (run) => Number(run.usage?.totalTokens ?? run.usage?.tokens ?? 0);
        const runStarted = (run) => Number(run.startedAt ?? run.endedAt ?? run.finishedAt ?? 0);
        const runWall = (run) => {
          const started = Number(run.startedAt ?? 0);
          const ended = Number(run.endedAt ?? run.finishedAt ?? 0);
          return started > 0 && ended >= started ? ended - started : 0;
        };
        const maxQueriesPerRun = expertRuns.reduce((max, run) => Math.max(max, runQueries(run)), 0);
        const hourAgo = Date.now() - 60 * 60_000;
        const recentRuns = expertRuns.filter((run) => runStarted(run) >= hourAgo);
        const tokensLastHour = recentRuns.reduce((sum, run) => sum + runTokens(run), 0);
        const maxRunWallClockMs = expertRuns.reduce((max, run) => Math.max(max, runWall(run)), 0);
        const queryLimit = Number(descriptor.budget.queriesPerRun ?? Number.MAX_SAFE_INTEGER);
        const tokenLimit = Number(descriptor.budget.tokensPerHour ?? Number.MAX_SAFE_INTEGER);
        const wallLimit = Number(descriptor.budget.wallClockMs ?? Number.MAX_SAFE_INTEGER);
        const budgetUsage = {
          runs: expertRuns.length,
          windows: { query: 'per_run', token: 'per_hour', wallClock: 'per_run' },
          queryWindow: { maxPerRun: maxQueriesPerRun, limit: queryLimit, within: maxQueriesPerRun <= queryLimit },
          tokenWindow: { lastHourTokens: tokensLastHour, limit: tokenLimit, within: tokensLastHour <= tokenLimit, runs: recentRuns.length },
          wallClockWindow: { maxRunMs: maxRunWallClockMs, limit: wallLimit, within: maxRunWallClockMs <= wallLimit },
          tokens: tokensLastHour,
          wallClockMs: maxRunWallClockMs,
          withinQueries: maxQueriesPerRun <= queryLimit,
          withinTokens: tokensLastHour <= tokenLimit,
          withinWallClock: maxRunWallClockMs <= wallLimit,
        };
        return {
          ...descriptor,
          lifecycle: expertLifecycleOf(project, descriptor.id),
          budgetUsage,
          metrics: {
            ...computeExpertMetrics({ expertId: descriptor.id, nodes, runs }),
            ...disputePerformance(project, descriptor.id),
          },
        };
      }),
      curator: curator.status(),
    });
  }

  /** Deterministic expert recall for a task (Stage 4.2 production call site). */
  function recallExpertFor(projectId, task, { limit = 3, actor = null } = {}) {
    const project = requireProject(projectId);
    const descriptors = filterVisibleExperts(recruitabilityOf(project), actor);
    const recall = recallExperts(descriptors, typeof task === 'string' ? task : '', { limit });
    const nodes = store.listNodes(projectId);
    const runs = store.listRuns(projectId);
    return {
      ok: true,
      projectId,
      task: typeof task === 'string' ? task : '',
      experts: recall.experts.map((row) => ({
        ...row,
        descriptor: getExpertDescriptor(row.id),
        lifecycle: expertLifecycleOf(project, row.id),
        metrics: {
          ...computeExpertMetrics({ expertId: row.id, nodes, runs }),
          ...disputePerformance(project, row.id),
        },
      })),
      total: recall.total,
      _truncated: recall.total > recall.experts.length ? { shown: recall.experts.length, total: recall.total } : null,
    };
  }

  /** Hire one catalog expert into the project roster. */
  async function hireExpert(projectId, input = {}, exec = null) {
    const project = requireProject(projectId);
    const actor = actorFromToolExecution(exec);
    const expertId = text(input.expertId, 'expertId', { required: true, max: 120 });
    if (actor.kind === 'expert' && (actor.id === expertId || actor.preset === expertId)) {
      throw new LabError('self_hire_forbidden', 'an expert cannot hire itself', 403);
    }
    assertOperator(actor, 'hire experts');
    const descriptor = getExpertDescriptor(expertId);
    if (!descriptor) throw new LabError('expert_not_found', `unknown expert: ${expertId}`, 404);
    if (descriptor.mayExecute.length > 0) {
      throw new LabError('expert_may_execute', 'an executing expert cannot be hired into the advisory roster', 409);
    }
    const roster = expertRosterOf(project);
    const existing = roster.find((row) => row.expertId === expertId);
    const existingExpired = existing?.temporary === true && Number(existing.expiresAt) > 0 && Number(existing.expiresAt) <= Date.now();
    if (existing && !existingExpired && (existing.status === 'active' || existing.status === 'draining')) {
      throw new LabError('expert_already_hired', `expert is already ${existing.status}: ${expertId}`, 409);
    }
    if (!existing && roster.length >= 8) throw new LabError('expert_roster_full', 'the expert roster is full (8)', 409);
    const provider = text(input.provider, 'provider', { max: 120 }) || descriptor.model.provider;
    const model = text(input.model, 'model', { max: 200 }) || descriptor.model.model;
    const lens = text(input.lens, 'lens', { max: 120 }) || '';
    const now = Date.now();
    const temporary = input?.temporary === true;
    const ttlHours = temporary
      ? Math.max(1, Math.min(168, Number.isInteger(input?.ttlHours) ? input.ttlHours : 24))
      : null;
    const entry = {
      expertId,
      status: 'active',
      provider,
      model,
      ...(lens ? { lens } : {}),
      hiredAt: now,
      hiredBy: actor.id,
      ...(temporary ? { temporary: true, invitedAt: now, expiresAt: now + ttlHours * 3_600_000 } : {}),
      ...(existing?.history ? { history: [...existing.history, { event: 'rehired', at: now }] } : {}),
    };
    const next = existing
      ? roster.map((row) => row.expertId === expertId ? entry : row)
      : [...roster, entry];
    await commitProjectFields(projectId, {
      config: { ...project.config, experts: next },
    }, {
      actor,
      eventType: 'expert/hired',
      eventData: { expertId, provider, model, lens },
      causeId: `expert:${projectId}:${expertId}:hired`,
    });
    return {
      ok: true,
      projectId,
      expert: { ...descriptor, lifecycle: expertLifecycleOf(requireProject(projectId), expertId) },
    };
  }

  /** Start draining: never cancels a running node, and never pretends it is a fire. */
  /**
   * 5.3.5: temporary invited experts. They use the same roster/lifecycle as a
   * hired expert but carry `temporary` + `expiresAt`; recruitability and
   * rotation exclude an expired invite without deleting its history.
   */
  async function inviteExpert(projectId, input = {}, exec = null) {
    const ttlHours = Math.max(1, Math.min(168, Number.isInteger(input?.ttlHours) ? input.ttlHours : 24));
    const result = await hireExpert(projectId, { ...input, temporary: true, ttlHours }, exec);
    return { ...result, invited: true, ttlHours, expiresAt: result?.expert?.lifecycle?.expiresAt ?? null };
  }

  async function drainExpert(projectId, input = {}, exec = null) {
    const project = requireProject(projectId);
    const actor = actorFromToolExecution(exec);
    assertOperator(actor, 'drain experts');
    const expertId = text(input.expertId, 'expertId', { required: true, max: 120 });
    const row = expertRosterRow(project, expertId);
    if (!row) throw new LabError('expert_not_hired', `expert is not on the roster: ${expertId}`, 409);
    if (row.status === 'retired') throw new LabError('expert_retired', `expert is retired: ${expertId}`, 409);
    if (row.status !== 'active') throw new LabError('expert_not_active', `expert is already ${row.status}: ${expertId}`, 409);
    const running = store.listNodes(projectId).filter((node) => node.createdBy === expertId && node.status === 'running');
    const now = Date.now();
    const next = expertRosterOf(project).map((candidate) => candidate.expertId === expertId
      ? { ...candidate, status: 'draining', drainedAt: now, drainingBy: actor.id, runningPreserved: running.length }
      : candidate);
    await commitProjectFields(projectId, {
      config: { ...project.config, experts: next },
    }, {
      actor,
      eventType: 'expert/draining',
      eventData: { expertId, runningPreserved: running.length },
      causeId: `expert:${projectId}:${expertId}:draining`,
    });
    return {
      ok: true,
      projectId,
      expert: { id: expertId, lifecycle: expertLifecycleOf(requireProject(projectId), expertId) },
      runningPreserved: running.map((node) => node.id),
    };
  }

  /**
   * Retire a drained expert. Running nodes must finish first (drain is not a
   * kill), and every unfinished node is handed back to the human owner.
   */
  async function fireExpert(projectId, input = {}, exec = null) {
    const project = requireProject(projectId);
    const actor = actorFromToolExecution(exec);
    assertOperator(actor, 'fire experts');
    const expertId = text(input.expertId, 'expertId', { required: true, max: 120 });
    const row = expertRosterRow(project, expertId);
    if (!row) throw new LabError('expert_not_hired', `expert is not on the roster: ${expertId}`, 409);
    if (row.status === 'retired') throw new LabError('expert_retired', `expert is retired: ${expertId}`, 409);
    if (row.status !== 'draining') throw new LabError('expert_must_drain', 'drain the expert before firing it', 409);
    const nodes = store.listNodes(projectId);
    const running = nodes.filter((node) => node.createdBy === expertId && node.status === 'running');
    if (running.length > 0) {
      throw new LabError('expert_busy', `expert still owns ${running.length} running node(s); drain preserves them`, 409);
    }
    const now = Date.now();
    const orphans = nodes.filter((node) => node.createdBy === expertId && !['completed', 'cancelled'].includes(node.status));
    const next = expertRosterOf(project).map((candidate) => candidate.expertId === expertId
      ? { ...candidate, status: 'retired', retiredAt: now, retiredBy: actor.id, handoverTo: 'human' }
      : candidate);
    const mutations = [{
      op: 'project.update',
      set: { config: { ...project.config, experts: next } },
      eventType: 'expert/retired',
      eventData: { expertId, reassigned: orphans.length, handoverTo: 'human' },
    }];
    for (const node of orphans) {
      mutations.push({
        op: 'node.update',
        nodeId: node.id,
        set: { createdBy: 'human', orphanedFrom: expertId },
      });
    }
    await commitMutations(projectId, mutations, {
      actor,
      causeId: `expert:${projectId}:${expertId}:retired`,
    });
    return {
      ok: true,
      projectId,
      expert: { id: expertId, lifecycle: expertLifecycleOf(requireProject(projectId), expertId) },
      reassigned: orphans.map((node) => node.id),
    };
  }

  /** Curator nominations: code recalls, curator only judges and proposes. */
  async function nominateDuplicates(projectId, input = {}, exec = null) {
    const project = requireProject(projectId);
    if (!kernel?.executor) return rejection('internal_error', 'kernel executor is not wired');
    const nodes = store.listNodes(projectId);
    const reviewClaims = typeof orchestrator?.reviewClaims?.list === 'function' ? orchestrator.reviewClaims.list(projectId) : [];
    const claims = [
      ...nodes.filter((node) => node.claim).map((node) => ({ nodeId: node.id, expiresAt: null })),
      ...reviewClaims.map((claim) => ({ nodeId: claim.nodeId, expiresAt: claim.expiresAt ?? null })),
    ];
    const reviews = reviewClaims.map((claim) => ({ nodeId: claim.nodeId, status: claim.intent === 'review' ? 'claimed' : 'pending' }));
    const result = curator.nominate({ nodes, claims, reviews });
    const actor = actorFromToolExecution(exec) ?? actorForSession({ sessionId: 'operator' });
    if (result.nominations.length > 0 && result.circuitOpen !== true) {
      const intent = createIntent({
        id: intentId('curate', project.revision + 1, actor.id),
        kind: 'curate',
        actor,
        claim: {
          action: 'nominate_close',
          candidates: result.candidates,
          nominations: result.nominations.map((row) => ({ nodeId: row.nodeId, duplicateOf: row.duplicateOf, kind: row.kind, confidence: row.confidence })),
        },
        basis: basisFor(project.revision, nodes.length),
        target: { nodeId: result.nominations[0].nodeId },
        rationale: `deterministic recall produced ${result.candidates} candidate pair(s)`,
      });
      const commit = await commitMutations(projectId, [intentMutation(intent)], { actor, causeId: `intent:${intent.id}` });
      if (commit.ok !== true) return rejection(commit.code ?? 'internal_error', commit.message ?? 'curator intent failed');
      return { ok: true, projectId, ...result, intent: { id: intent.id }, canExecute: false };
    }
    return { ok: true, projectId, ...result, canExecute: false };
  }

  /** Human feedback that drives the false-close circuit breaker. */
  function recordCuratorOutcome(input = {}) {
    if (input?.apply === true) return rejection('curator_cannot_execute', applyNomination().message);
    return { ok: true, ...curator.recordOutcome({ falseClose: input?.falseClose === true }) };
  }

  /**
   * The Host-side appeal window starts when the appeal record was opened. It
   * is intentionally not read from the request: a caller can neither shorten
   * nor extend a cooling-off period, and a withdrawal does not erase the fact
   * that the target was appealed during this window.
   */
  function appealActionOf(claim, input = null) {
    const candidates = [
      claim?.targetAction,
      claim?.actionOnTarget,
      claim?.forAction,
      claim?.actionToAuthorize,
      claim?.authorizedAction,
      claim?.target && typeof claim.target === 'object' ? claim.target.action : null,
      claim?.authorization && typeof claim.authorization === 'object' ? claim.authorization.action : null,
      claim?.authorizes && typeof claim.authorizes === 'object' ? claim.authorizes.action : null,
      claim?.scope && typeof claim.scope === 'object' ? claim.scope.action : null,
      input?.targetAction,
      input?.actionOnTarget,
      input?.target && typeof input.target === 'object' ? input.target.action : null,
      input?.action,
    ];
    return candidates.find((value) => typeof value === 'string' && value.length > 0) ?? null;
  }

  /**
   * The one scope shape an irreversible action accepts. A project-wide action
   * is authorized by the project id, never by a node; a node action is
   * authorized by the node id, never by the project id.
   */
  function expectedScopeKind(action) {
    return action === 'delete_project' ? 'project' : 'node';
  }

  function appealState(project, target, action, actor, now = Date.now()) {
    const expectedKind = expectedScopeKind(action);
    const requestedKey = expectedKind === 'project'
      ? (target?.projectId && !target?.nodeId ? `project:${target.projectId}` : null)
      : (target?.nodeId && !target?.projectId ? `node:${target.nodeId}` : null);
    const records = (Array.isArray(project.intents) ? project.intents : [])
      .filter((candidate) => candidate?.kind === 'appeal' && candidate?.claim?.action === 'appeal')
      .map((intent) => {
        // `expiresAt` is written by createIntent on the Host; `at` is the
        // opened timestamp and is the fallback for legacy records. Neither is
        // accepted from the request.
        const openedAt = Number.isFinite(intent.at) ? intent.at : null;
        const expiresAt = Number.isFinite(intent.expiresAt) ? intent.expiresAt : null;
        const targetProjectId = typeof intent.target?.projectId === 'string' && intent.target.projectId
          ? intent.target.projectId
          : null;
        const targetNodeId = typeof intent.target?.nodeId === 'string' && intent.target.nodeId
          ? intent.target.nodeId
          : null;
        const targetAction = appealActionOf(intent.claim);
        const recordKind = targetAction ? expectedScopeKind(targetAction) : null;
        const key = recordKind === 'project'
          ? (targetProjectId && !targetNodeId ? `project:${targetProjectId}` : null)
          : (recordKind === 'node' && targetNodeId && !targetProjectId ? `node:${targetNodeId}` : null);
        return {
          intent,
          key,
          targetProjectId,
          targetNodeId,
          targetAction,
          until: expiresAt !== null ? expiresAt : (openedAt !== null ? openedAt + INTENT_TTL_MS : null),
        };
      });
    const scoped = records.filter((row) => row.key !== null && row.targetAction !== null);
    const malformed = records.length !== scoped.length;
    // Exact target+action for every state. A pending/withdrawn objection to
    // prune must not block cancellation of the same node (and vice versa):
    // those are different operations with different authorization.
    const exactRows = scoped.filter((row) => row.key === requestedKey && row.targetAction === action);
    const pending = exactRows.some((row) => row.intent.status === 'pending' && row.until !== null && row.until > now);
    // A withdrawn appeal is not a hearing and does not become permission when
    // the original TTL passes. It stays unresolved until a different actor
    // writes an explicit resolution.
    const unresolved = exactRows.some((row) => row.intent.status === 'withdrawn');
    const windowed = exactRows.filter((row) => row.until !== null && (row.intent.status === 'resolved' || row.intent.status === 'pending'));
    const exactResolved = exactRows.some((row) => row.intent.status === 'resolved');
    // Any resolved appeal that is not exactly this target+action is a
    // differently-scoped record, not a wildcard authorization.
    const foreignResolved = scoped.some((row) => row.intent.status === 'resolved'
      && (row.key !== requestedKey || row.targetAction !== action));
    const targetMismatch = requestedKey === null || malformed || (foreignResolved && !exactResolved);
    const confirmation = exactRows.find((row) => {
      if (row.intent.status !== 'resolved') return false;
      // A resolution that rejects the objection is not a confirmation to
      // execute. Only the affirmative resolution opens the human gate.
      if (row.intent.resolution !== 'upheld') return false;
      const by = row.intent.resolvedBy;
      if (!by || (by.kind !== 'human' && by.kind !== 'system')) return false;
      // Raiser, requester and resolver are three distinct actors. Identity is
      // the opaque actorKey; display ids only participate for legacy records
      // that predate keys (and then only by exact-byte equality).
      if (!hasActorIdentity(actor) || !hasActorIdentity(row.intent.actor) || !hasActorIdentity(by)) return false;
      // A keyed identity and an unkeyed legacy identity cannot be compared
      // soundly. If any of the three has a key, require all three to have one;
      // mixing them must not turn "not provably equal" into "distinct".
      const resolverKey = actorKeyOf(by);
      const raiserKey = actorKeyOf(row.intent.actor);
      const requesterKey = actorKeyOf(actor);
      // Irreversible confirmation requires three Host-issued identities. A
      // legacy/forged key that was stripped on load is unkeyed and falls back
      // to exact-id equality for read-only comparison only; it can never open
      // the human confirmation gate.
      if (![resolverKey, raiserKey, requesterKey].every(isIssuedActorKey)) return false;
      const identities = [resolverKey, raiserKey, requesterKey];
      if (identities.some(Boolean) && !identities.every(Boolean)) return false;
      if (sameActor(by, actor)) return false;
      if (sameActor(by, row.intent.actor)) return false;
      if (sameActor(row.intent.actor, actor)) return false;
      return true;
    });
    // The same unresolved predicate gates both outcomes: while any withdrawn
    // appeal remains unresolved, neither a positive window nor a resolution
    // from another appeal can let the action through.
    const hasWindow = !unresolved && !targetMismatch && windowed.length > 0;
    return {
      pending,
      unresolved,
      targetMismatch,
      // A corrupt/legacy appeal without a Host timestamp cannot grant a
      // window; and a withdrawn appeal has no window until it is resolved.
      hasWindow,
      until: hasWindow ? Math.max(...windowed.map((row) => row.until ?? 0)) : null,
      humanConfirmation: confirmation && !targetMismatch
        ? { appealId: confirmation.intent.id, by: confirmation.intent.resolvedBy }
        : null,
    };
  }

  function claimStats(project, actorId) {
    const row = project?.claimStats?.[actorId];
    return {
      total: Number.isInteger(row?.total) ? row.total : 0,
      failed: Number.isInteger(row?.failed) ? row.failed : 0,
    };
  }

  function toolActionScope(toolAction) {
    if (toolAction === 'delete_project') return 'delete_project';
    if (toolAction === 'cancel_node') return 'cancel_running';
    return null;
  }

  /**
   * Re-run the complete claim/appeal/human gate at the destructive handler.
   * `submitIntent` is a record of a decision, not the execution path; a
   * transport that deletes or cancels must not be able to skip this.
   */
  async function authorizeIrreversibleTool(projectId, toolAction, input = {}, exec = null) {
    const project = requireProject(projectId);
    const action = toolActionScope(toolAction);
    if (!action) throw new LabError('unknown_action', `unknown irreversible handler: ${toolAction}`, 400);
    const actor = actorFromDisputeExecution(exec);
    if (!actor) throw new LabError('actor_required', 'irreversible actions require an authenticated actor');
    let target;
    if (action === 'delete_project') {
      // Project-wide action: the authorization scope is the project id. A
      // node id here is a scope confusion, not an alias for the project.
      if (input?.nodeId !== undefined && input?.nodeId !== null) {
        throw new LabError('appeal_target_mismatch', 'delete_project is project-scoped and does not accept a nodeId', 400);
      }
      target = { projectId };
    } else {
      const nodeId = text(input?.nodeId, 'nodeId', { required: true });
      if (!store.getNode(projectId, nodeId)) throw new LabError('node_not_found', `unknown node: ${nodeId}`, 404);
      target = { nodeId };
    }
    let stats = claimStats(project, actor.id);
    let submitted = 0;
    if (input?.claim?.evidence !== undefined) {
      if (!Array.isArray(input.claim.evidence)) throw new LabError('bad_request', 'claim.evidence must be an array of predicates');
      const verification = verifyClaims(input.claim.evidence, store.listNodes(projectId));
      submitted = verification.total;
      if (verification.failed > 0) {
        throw new LabError('claim_invalid', `claim failed ${verification.failed}/${verification.total} predicate(s); re-read the cited facts and resubmit`, 400);
      }
      stats = { total: stats.total + verification.total, failed: stats.failed + verification.failed };
    }
    const appeal = appealState(project, target, action, actor);
    const chiefConfirmed = (input?.chiefConfirmed === true || input?.claim?.chiefConfirmed === true)
      && (actor.kind === 'human' || actor.kind === 'system' || actor.preset === 'lab-chief');
    const gate = gateClaimAction(action, stats, {
      submitted,
      chiefConfirmed,
      humanConfirmed: appeal.humanConfirmation !== null,
      humanConfirmedBy: appeal.humanConfirmation?.by ?? null,
      appealPending: appeal.pending,
      appealUnresolved: appeal.unresolved,
      appealTargetMismatch: appeal.targetMismatch,
      serverAppealWindow: appeal.hasWindow,
      serverAppealUntil: appeal.until,
      now: Date.now(),
      actor,
    });
    if (!gate.ok) throw new LabError(gate.code, `irreversible action ${action} rejected by the claim gate: ${gate.code}`, 403);
    return { projectRevision: project.revision ?? 0, actor, actorKey: actor.actorKey, target, action, gate };
  }

  /** Append one judgement to the project intent log (Stage 3). */
  async function submitIntent(projectId, input, exec = null) {
    const project = requireProject(projectId);
    if (!kernel?.executor) return rejection('internal_error', 'kernel executor is not wired');
    let kind = typeof input?.kind === 'string' ? input.kind : 'note';
    if (!INTENT_KINDS.includes(kind)) return rejection('bad_request', `intent.kind must be one of ${INTENT_KINDS.join(', ')}`);
    const actor = actorFromToolExecution(exec) ?? actorForSession({ sessionId: 'operator' });
    // Reject the field even when no appeal exists, before any target lookup:
    // an action must not satisfy its own cooling-off requirement by supplying
    // a future timestamp.
    if (input?.appealUntil !== undefined || input?.claim?.appealUntil !== undefined) {
      return rejection('appeal_window_caller_supplied', 'appealUntil is computed by the Host from the appeal record; remove it from the request');
    }
    let target = input?.target && typeof input.target === 'object'
      ? {
          projectId: input.target.projectId ?? input?.targetProjectId ?? null,
          nodeId: input.target.nodeId ?? input?.nodeId ?? null,
          parentId: input.target.parentId ?? input?.parentId ?? null,
          intentId: input.target.intentId ?? input?.intentId ?? null,
        }
      : (input?.nodeId || input?.parentId || input?.intentId || input?.targetProjectId
        ? { projectId: input.targetProjectId ?? null, nodeId: input.nodeId ?? null, parentId: input.parentId ?? null, intentId: input.intentId ?? null }
        : null);
    let claim = input?.claim;
    // Confirmation is a Host-derived record, never a claim field. Strip any
    // caller-authored copy before it can reach the intent log.
    if (claim && (Object.prototype.hasOwnProperty.call(claim, 'humanConfirmed') || Object.prototype.hasOwnProperty.call(claim, 'humanConfirmedBy'))) {
      const { humanConfirmed: _humanConfirmed, humanConfirmedBy: _humanConfirmedBy, ...rest } = claim;
      claim = rest;
    }
    // An appeal is a first-class judgement, not a note with a flag. Forcing the
    // kind here means every transport gets the same registerable record.
    if (claim?.action === 'appeal') kind = 'appeal';
    if (claim?.action === 'escalate') kind = 'escalate';
    // B13: an escalate intent is only actionable when it names one of the six
    // checklist reason codes. Validate at the write boundary, before the
    // generic intent schema, so the caller gets a stable actionable code.
    if (kind === 'escalate') {
      if (claim?.action !== 'escalate') {
        return rejection('intent_action_mismatch', 'an intent with kind "escalate" must carry claim.action "escalate"');
      }
      const reasonCode = typeof claim?.reasonCode === 'string' ? claim.reasonCode.trim() : '';
      if (!reasonCode) {
        return rejection('escalation_reason_required', 'an escalate intent requires claim.reasonCode', { allowed: [...ESCALATION_REASON_CODES] });
      }
      if (!ESCALATION_REASON_CODES.includes(reasonCode)) {
        return rejection('escalation_reason_invalid', `reasonCode must be one of ${ESCALATION_REASON_CODES.join(', ')}`, { allowed: [...ESCALATION_REASON_CODES] });
      }
      claim = { ...claim, reasonCode };
    }
    // The inverse is not optional: `kind:'appeal'` with a different claim
    // action is a manufactured appeal record, not an objection. Reject it at
    // the write boundary so it cannot create a Host window later.
    if (kind === 'appeal' && claim?.action !== 'appeal') {
      return rejection('intent_action_mismatch', 'an intent with kind "appeal" must carry claim.action "appeal"');
    }
    // An appeal authorizes exactly one scope + one action. A node action is
    // scoped by node id; project-wide delete is scoped by project id. Mixing
    // the two shapes is a target mismatch, not a wildcard.
    if (kind === 'appeal') {
      const scopeAction = appealActionOf(claim, input);
      if (!scopeAction || !IRREVERSIBLE_ACTIONS.includes(scopeAction)) {
        return rejection('appeal_target_mismatch', 'an appeal must carry targetAction naming one irreversible action');
      }
      const claimTarget = claim?.target;
      const authorization = claim?.authorization ?? claim?.authorizes;
      const scope = claim?.scope;
      const scopeNodeId = (typeof claimTarget === 'string' ? claimTarget : null)
        ?? (claimTarget && typeof claimTarget === 'object' ? claimTarget.nodeId : null)
        ?? (typeof claim?.targetNodeId === 'string' ? claim.targetNodeId : null)
        ?? (typeof claim?.nodeId === 'string' ? claim.nodeId : null)
        ?? (authorization && typeof authorization === 'object'
          ? (authorization.nodeId
            ?? (typeof authorization.target === 'string' ? authorization.target : null)
            ?? (authorization.target && typeof authorization.target === 'object' ? authorization.target.nodeId : null))
          : null)
        ?? (typeof scope === 'string' ? scope : null)
        ?? (scope && typeof scope === 'object'
          ? (scope.nodeId ?? (scope.target && typeof scope.target === 'object' ? scope.target.nodeId : null))
          : null)
        ?? (typeof input?.targetNodeId === 'string' ? input.targetNodeId : null)
        ?? null;
      const scopeProjectId = (typeof claim?.projectId === 'string' ? claim.projectId : null)
        ?? (typeof claim?.targetProjectId === 'string' ? claim.targetProjectId : null)
        ?? (claimTarget && typeof claimTarget === 'object' && typeof claimTarget.projectId === 'string' ? claimTarget.projectId : null)
        ?? (authorization && typeof authorization === 'object' && typeof authorization.projectId === 'string' ? authorization.projectId : null)
        ?? (scope && typeof scope === 'object' && typeof scope.projectId === 'string' ? scope.projectId : null)
        ?? (typeof input?.targetProjectId === 'string' ? input.targetProjectId : null)
        ?? (target && typeof target.projectId === 'string' ? target.projectId : null)
        ?? null;
      if (expectedScopeKind(scopeAction) === 'project') {
        // delete_project is project-wide. A node id here would silently turn a
        // node-level objection into authority over the whole project.
        if (scopeNodeId || target?.nodeId || (scopeProjectId && scopeProjectId !== projectId)) {
          return rejection('appeal_target_mismatch', 'a delete_project appeal must be scoped to the project, not a node');
        }
        // The project is the scope, so the known project id is the exact value.
        target = { projectId };
      } else {
        if (scopeProjectId || target?.projectId) {
          return rejection('appeal_target_mismatch', 'a node action appeal cannot be scoped to the project');
        }
        if (scopeNodeId && target?.nodeId && scopeNodeId !== target.nodeId) {
          return rejection('appeal_target_mismatch', 'the appeal target node and the action target node disagree');
        }
        if (!target?.nodeId && scopeNodeId) {
          target = { projectId: null, nodeId: scopeNodeId, parentId: null, intentId: null };
        }
        if (!target?.nodeId) {
          return rejection('appeal_target_mismatch', 'an appeal must carry a target.nodeId and targetAction naming one irreversible action');
        }
      }
      claim = { ...claim, targetAction: scopeAction };
    }
    // A project-wide action never accepts a node target. Keeping this at the
    // action boundary is what stops node authorization from leaking into
    // delete_project.
    if (claim?.action === 'delete_project') {
      if (target?.nodeId) {
        return rejection('appeal_target_mismatch', 'delete_project is project-scoped and cannot target a node');
      }
      if (target?.projectId && target.projectId !== projectId) {
        return rejection('appeal_target_mismatch', 'delete_project target project does not match the request project');
      }
      target = { projectId };
    } else if (claim?.action !== 'appeal' && target?.projectId) {
      return rejection('appeal_target_mismatch', 'this action is node-scoped and cannot target the project');
    }
    // Target validation happens after appeal scope normalization so a node
    // named inside the appeal claim is checked by the same path.
    if (target?.nodeId && !store.getNode(projectId, target.nodeId)) {
      return rejection('node_not_found', `unknown node: ${target.nodeId}`);
    }
    let verifiedStats = null;
    let verification = null;
    if (claim && claim.evidence !== undefined) {
      if (!Array.isArray(claim.evidence)) return rejection('bad_request', 'claim.evidence must be an array of predicates');
      verification = verifyClaims(claim.evidence, store.listNodes(projectId));
      const before = claimStats(project, actor.id);
      verifiedStats = {
        total: before.total + verification.total,
        failed: before.failed + verification.failed,
        updatedAt: Date.now(),
      };
      const rate = citationErrorRate(verifiedStats.failed, verifiedStats.total);
      claim = {
        ...claim,
        verification: {
          total: verification.total,
          failed: verification.failed,
          rate,
          tier: citationTier(rate),
        },
      };
      if (verification.failed > 0) {
        const recorded = await commitMutations(projectId, [{
          op: 'project.update',
          set: { claimStats: { ...(project.claimStats ?? {}), [actor.id]: verifiedStats } },
          eventType: 'claim/rejected',
          eventData: { actorId: actor.id, total: verifiedStats.total, failed: verifiedStats.failed, failures: verification.failures.length },
        }], { actor, causeId: `claim:${actor.id}` });
        if (recorded.ok !== true) return rejection(recorded.code ?? 'internal_error', recorded.message ?? 'claim statistics write failed');
        return rejection('claim_invalid', `claim failed ${verification.failed}/${verification.total} predicate(s); re-read the cited facts and resubmit`, {
          failures: verification.failures.map((row) => ({ predicate: row.predicate, reason: row.reason, claim: row.claim })),
          citationErrorRate: rate,
        });
      }
    }
    const appeal = appealState(project, target, claim?.action, actor);
    if (claim && ACTION_VERIFICATION[claim.action]) {
      const stats = verifiedStats ?? claimStats(project, actor.id);
      // Chief confirmation is an authority, not a model-authored boolean. A
      // human operator or the single chief preset may confirm; an advisor
      // cannot promote itself by writing `chiefConfirmed: true`.
      const chiefConfirmed = (input?.chiefConfirmed === true || claim?.chiefConfirmed === true)
        && (actor.kind === 'human' || actor.kind === 'system' || actor.preset === 'lab-chief');
      // A request boolean is not a confirmation. The Host derives this only
      // from an appeal resolution written by a human/system actor who is
      // neither the requester nor the appeal raiser.
      const humanConfirmed = appeal.humanConfirmation !== null;
      const humanConfirmedBy = appeal.humanConfirmation?.by ?? null;
      const gate = gateClaimAction(claim.action, stats, {
        submitted: verification?.total ?? 0,
        chiefConfirmed,
        humanConfirmed,
        humanConfirmedBy,
        appealPending: appeal.pending,
        appealUnresolved: appeal.unresolved,
        appealTargetMismatch: appeal.targetMismatch,
        serverAppealWindow: appeal.hasWindow,
        serverAppealUntil: appeal.until,
        now: Date.now(),
        actor,
      });
      if (!gate.ok) {
        if (verifiedStats) {
          await commitMutations(projectId, [{
            op: 'project.update',
            set: { claimStats: { ...(project.claimStats ?? {}), [actor.id]: verifiedStats } },
            eventType: 'claim/rejected',
            eventData: { actorId: actor.id, total: verifiedStats.total, failed: verifiedStats.failed, gate: gate.code },
          }], { actor, causeId: `claim:${actor.id}` });
        }
        return rejection(gate.code, `claim action ${claim.action} did not meet verification level ${gate.level}: ${gate.code}`, {
          citationErrorRate: gate.rate,
          tier: gate.tier,
          total: gate.total,
          level: gate.level,
          submitted: gate.submitted,
          requiredEvidence: gate.requiredEvidence,
          minimumEvidence: gate.minimumEvidence ?? null,
          lowerBound: gate.lowerBound ?? null,
          serverAppealUntil: gate.serverAppealUntil ?? null,
          humanConfirmedBy: gate.humanConfirmedBy ?? null,
        });
      }
      claim = {
        ...claim,
        gate: {
          actorKey: actor.actorKey,
          level: gate.level,
          requiredEvidence: gate.requiredEvidence,
          submitted: gate.submitted,
          chiefConfirmed,
          humanConfirmed,
          humanConfirmedBy,
          appealTargetMismatch: appeal.targetMismatch,
          serverAppealUntil: appeal.until,
          appealPending: appeal.pending,
          appealUnresolved: appeal.unresolved,
          lowerBound: gate.lowerBound,
        },
      };
    }
    let basis;
    try {
      basis = intentBasis(input?.basis === undefined
        ? basisFor(project.revision, store.listNodes(projectId).length)
        : input.basis);
    } catch (error) {
      return rejection('bad_request', error instanceof Error ? error.message : String(error));
    }
    if (basis.projectRevision > project.revision) {
      return rejection('basis_ahead', `basis projectRevision ${basis.projectRevision} is newer than project revision ${project.revision}`);
    }
    // B21: only the project revision can make a judgement stale. Snapshot age
    // and node count are carried for diagnosis; a larger node count from the
    // same revision is not a different world.
    const conflict = (Array.isArray(project.intents) ? project.intents : []).find((candidate) => (
      candidate.status === 'pending'
      && (!Number.isFinite(candidate.expiresAt) || candidate.expiresAt > Date.now())
      && candidate.target?.nodeId
      && candidate.target.nodeId === target?.nodeId
      && Number.isInteger(candidate.basis?.projectRevision)
      && candidate.basis.projectRevision > basis.projectRevision
    ));
    if (conflict) {
      return rejection('stale_basis', `intent ${conflict.id} already judged this target from revision ${conflict.basis.projectRevision}; re-read before submitting`, {
        conflictingIntentId: conflict.id,
        basis: conflict.basis,
        currentRevision: project.revision,
      });
    }
    let intent;
    try {
      intent = createIntent({
        id: intentId(kind, project.revision + 1, actor.id),
        kind,
        actor,
        claim,
        basis,
        target,
        expected: input?.expected,
        rationale: input?.rationale,
      });
    } catch (error) {
      return rejection('bad_request', error instanceof Error ? error.message : String(error));
    }
    const mutations = [{ ...intentMutation(intent), expectedRevision: project.revision ?? 0 }];
    if (verifiedStats) {
      mutations.push({
        op: 'project.update',
        set: { claimStats: { ...(project.claimStats ?? {}), [actor.id]: verifiedStats } },
        eventType: 'claim/verified',
        eventData: { actorId: actor.id, total: verifiedStats.total, failed: verifiedStats.failed },
      });
    }
    let commit;
    try {
      commit = await commitMutations(projectId, mutations, {
        actor,
        causeId: `intent:${intent.id}`,
      });
    } catch (error) {
      if (error instanceof LabError) return rejection(error.code, error.message);
      throw error;
    }
    if (commit.ok !== true) return rejection(commit.code ?? 'internal_error', commit.message ?? 'intent write failed');
    return { ok: true, projectId, intent, revision: store.getProject(projectId)?.revision ?? null, event: commit.events?.[0] ? { seq: commit.events[0].seq, type: commit.events[0].type, causeId: commit.events[0].causeId } : null };
  }

  /** Bounded, newest-last view of the intent log. */
  function listIntents(projectId, { limit = 100, kind = null } = {}) {
    const project = requireProject(projectId);
    const all = (Array.isArray(project.intents) ? project.intents : []).filter((intent) => !kind || intent.kind === kind);
    const size = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.trunc(limit))) : 100;
    const now = Date.now();
    const intents = all.slice(-size).map((intent) => {
      const expired = intent.status !== 'withdrawn' && Number.isFinite(intent.expiresAt) && intent.expiresAt <= now;
      return { ...intent, status: expired ? 'expired' : intent.status, expired };
    });
    return publicView({
      ok: true,
      projectId,
      revision: project.revision,
      intents,
      total: all.length,
      // Q12: pending/claims are first-class, not inferred from the node list.
      boundary: detectIntentConflicts(project.intents ?? [], now),
      _truncated: all.length > intents.length ? { shown: intents.length, total: all.length } : null,
    });
  }

  /** Read-only dispute table: first-class disputes plus legacy appeal intents. */
  function listDisputes(projectId, { limit = 200, status = null } = {}) {
    const project = requireProject(projectId);
    const now = Date.now();
    const size = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.trunc(limit))) : 200;
    const firstClass = (Array.isArray(project.disputes) ? project.disputes : [])
      .map((record) => effectiveDispute(record, now));
    const appeals = (Array.isArray(project.intents) ? project.intents : [])
      .filter((intent) => intent && (intent.kind === 'appeal' || intent.claim?.action === 'appeal'))
      .map((intent) => ({
        id: intent.id,
        source: 'appeal',
        status: intent.status,
        type: 'appeal',
        authority: 'human',
        defaultAction: DISPUTE_DEFAULT_ACTION,
        deadlineAt: intent.expiresAt ?? null,
        targetAction: intent.claim?.targetAction ?? null,
        target: intent.target ?? null,
        position: null,
        raiser: intent.actor ? { kind: intent.actor.kind, id: intent.actor.id } : null,
        evidence: [],
        reasonCode: null,
        resolution: intent.resolution ?? null,
        resolutionReason: intent.resolutionReason ?? null,
        resolvedBy: intent.resolvedBy ? { kind: intent.resolvedBy.kind, id: intent.resolvedBy.id } : null,
        resolvedAt: intent.resolvedAt ?? null,
        withdrawnBy: intent.withdrawnBy ? { kind: intent.withdrawnBy.kind, id: intent.withdrawnBy.id } : null,
        withdrawnAt: intent.withdrawnAt ?? null,
        openedAt: intent.at ?? null,
        expiresAt: intent.expiresAt ?? null,
      }));
    const matching = [
      ...firstClass.map((record) => ({
        ...record,
        source: 'dispute',
        targetAction: record.target?.action ?? null,
        openedAt: record.at,
        expiresAt: record.deadlineAt,
        raiser: record.raiser,
      })),
      ...appeals,
    ].filter((row) => !status || row.status === status);
    const rows = matching.slice(-size);
    return publicView({ ok: true, projectId, revision: project.revision ?? 0, disputes: rows, total: matching.length, classes: DISPUTE_CLASS_MAP });
  }

  /** Expose the eight-class mapping to the UI and policy tests. */
  function disputeClasses() {
    return publicView({ ok: true, classes: DISPUTE_CLASS_MAP, defaultAction: DISPUTE_DEFAULT_ACTION, resolutions: ['keep_current', 'apply_change', 'upheld', 'rejected'] });
  }

  const DISPUTE_EPOCH_MS = 7 * 24 * 60 * 60_000;

  function disputeQuota(project) {
    const value = Number(project?.config?.disputes?.escalationQuotaPerEpoch ?? project?.config?.disputeEscalationQuota ?? 5);
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 5;
  }

  function disputeEscalationsThisEpoch(project, actor, now) {
    const epoch = Math.floor(now / DISPUTE_EPOCH_MS);
    return (Array.isArray(project.disputes) ? project.disputes : []).filter((record) => {
      if (!record || record.type !== 'priority_inversion' || !sameActor(record.raiser, actor)) return false;
      const at = Number(record.at);
      return Number.isFinite(at) && Math.floor(at / DISPUTE_EPOCH_MS) === epoch;
    }).length;
  }

  async function openDispute(projectId, input = {}, exec = null) {
    const project = requireProject(projectId);
    // Opening a dispute records its raiser. HTTP passes only a verified
    // operator actor (or null); an absent caller must not become a human by
    // default. Agent tool calls still arrive with their DSH session.
    const actor = actorFromDisputeExecution(exec);
    if (!actor) return rejection('actor_required', 'openDispute requires an authenticated actor; an absent caller is not the operator');
    const now = Date.now();
    const budget = Number(project?.config?.disputes?.budgetPerEpoch);
    if (Number.isFinite(budget) && budget >= 0) {
      const epoch = Math.floor(now / DISPUTE_EPOCH_MS);
      const consumed = (Array.isArray(project.disputes) ? project.disputes : [])
        .filter((record) => Number.isFinite(Number(record?.at)) && Math.floor(Number(record.at) / DISPUTE_EPOCH_MS) === epoch).length;
      if (consumed >= budget) {
        return rejection('dispute_budget_exhausted', `project dispute budget ${budget} for this epoch is exhausted`);
      }
    }
    if (input?.type === 'priority_inversion') {
      if (typeof input?.reasonCode !== 'string' || !input.reasonCode.trim()) {
        return rejection('escalation_reason_required', 'a human escalation requires reasonCode');
      }
      if (disputeEscalationsThisEpoch(project, actor, now) >= disputeQuota(project)) {
        return rejection('escalation_quota_exceeded', `expert ${actor.id} exhausted its per-epoch human escalation quota`);
      }
    }
    let record;
    try {
      record = createDisputeRecord({
        ...input,
        id: typeof input.id === 'string' && input.id ? input.id : `dispute-${project.revision + 1}-${now.toString(36)}`,
        projectId,
        raiser: actor,
        at: now,
      });
    } catch (error) {
      return rejection(error?.code ?? 'invalid_dispute', error?.message ?? String(error));
    }
    const result = await commitMutations(projectId, [{
      op: 'dispute.open',
      dispute: record,
      expectedRevision: project.revision ?? 0,
    }], { actor, causeId: `dispute:${record.id}` });
    return publicView({ ok: true, projectId, dispute: record, revision: store.getProject(projectId)?.revision ?? null });
  }

  async function resolveDispute(projectId, disputeId, input = {}, exec = null) {
    const project = requireProject(projectId);
    const current = (Array.isArray(project.disputes) ? project.disputes : []).find((row) => row.id === disputeId);
    if (!current) return rejection('dispute_not_found', `unknown dispute: ${disputeId}`);
    const actor = actorFromDisputeExecution(exec);
    if (!actor) return rejection('actor_required', 'resolveDispute requires an authenticated actor; an absent exec is not the operator');
    // This is the same actor-class gate the `arbitrate` tool uses. Without it
    // a curator (which has no `arbitrate` action) could resolve a
    // duplicate_claim through the direct service path but not through the tool.
    const actorVerdict = disputeActorVerdict(actor);
    if (actorVerdict.ok !== true) return rejection(actorVerdict.code, actorVerdict.message);
    // The authority map is enforced here as well as in `arbitrate`: the HTTP
    // resolve route used to call this function directly, which let an expert
    // bypass the limited-write check.
    const authority = disputeAuthorityVerdict(actor, current);
    if (authority.ok !== true) return rejection(authority.code, authority.message, { authority: current.authority ?? null });
    let resolved;
    try {
      resolved = resolveDisputeRecord(current, {
        resolution: input.resolution,
        reason: input.reason,
        resolvedBy: actor,
      }, Date.now());
    } catch (error) {
      return rejection(error?.code ?? 'invalid_dispute_resolution', error?.message ?? String(error));
    }
    const result = await commitMutations(projectId, [{
      op: 'dispute.resolve',
      dispute: resolved,
      expectedRevision: project.revision ?? 0,
    }], { actor, causeId: `dispute:${disputeId}:resolve` });
    return publicView({ ok: true, projectId, dispute: resolved, revision: store.getProject(projectId)?.revision ?? null });
  }

  async function reopenDispute(projectId, disputeId, input = {}, exec = null) {
    const project = requireProject(projectId);
    const current = (Array.isArray(project.disputes) ? project.disputes : []).find((row) => row.id === disputeId);
    if (!current) return rejection('dispute_not_found', `unknown dispute: ${disputeId}`);
    const actor = actorFromDisputeExecution(exec);
    if (!actor) return rejection('actor_required', 'reopenDispute requires an authenticated actor; an absent caller is not the operator');
    let reopened;
    try {
      reopened = reopenDisputeRecord(current, { evidence: input.evidence, by: actor }, Date.now());
    } catch (error) {
      return rejection(error?.code ?? 'invalid_dispute_reopen', error?.message ?? String(error));
    }
    // Re-opening is a fresh decision about a resolution. The resolver cannot
    // be the only participant in that challenge: require a comparable, and
    // different, actor whenever the record names one. A system timeout is
    // deliberately exempt because it is not a human decision.
    const priorResolver = current.resolvedBy;
    if (priorResolver && typeof priorResolver === 'object' && priorResolver.kind !== 'system') {
      const priorKey = actorKeyOf(priorResolver);
      const nextKey = actorKeyOf(actor);
      if (Boolean(priorKey) !== Boolean(nextKey)) {
        return rejection('dispute_reopen_actor_not_comparable', 'dispute resolver and reopener identities are not comparable');
      }
      if (sameActor(priorResolver, actor)) {
        return rejection('dispute_reopen_requires_different_actor', 'a dispute resolver cannot reopen their own resolution');
      }
    }
    const result = await commitMutations(projectId, [{
      op: 'dispute.reopen',
      dispute: reopened,
      expectedRevision: project.revision ?? 0,
    }], { actor, causeId: `dispute:${disputeId}:reopen` });
    return publicView({ ok: true, projectId, dispute: reopened, revision: store.getProject(projectId)?.revision ?? null });
  }

  /**
   * Production timeout sweep: every overdue pending dispute applies
   * keep_current. The clock is always Host time; no caller (and no HTTP body)
   * can advance it. This method is called by the scheduler, not exposed as an
   * HTTP mutation.
   */
  async function sweepDisputes(projectId) {
    const project = requireProject(projectId);
    const now = Date.now();
    const pending = (Array.isArray(project.disputes) ? project.disputes : [])
      .filter((row) => row.status === 'pending' && Number.isFinite(row.deadlineAt) && row.deadlineAt <= now);
    if (pending.length === 0) return { ok: true, projectId, timedOut: [] };
    const mutations = pending.map((row) => ({
      op: 'dispute.resolve',
      dispute: expireDisputeRecord(row, now),
    }));
    await commitMutations(projectId, mutations, {
      actor: { kind: 'system', id: 'dispute-timeout' },
      causeId: `dispute:timeout:${projectId}:${now}`,
    });
    return publicView({ ok: true, projectId, timedOut: pending.map((row) => row.id) });
  }

  /** Per-class scheduling budgets plus observed outcomes; missing budgets mean no cap. */
  function classBudgetReport(projectId) {
    const project = requireProject(projectId);
    const nodes = store.listNodes(projectId);
    const classes = PRIORITY_CLASSES.map((priorityClass) => {
      const matching = nodes.filter((node) => (node.priority?.class ?? 'p2') === priorityClass);
      const count = (status) => matching.filter((node) => node.status === status).length;
      return {
        class: priorityClass,
        budget: classBudgetOf(project.config ?? {}, priorityClass),
        running: count('running'),
        queued: matching.filter((node) => ['planned', 'proposed', 'deferred'].includes(node.status)).length,
        completed: count('completed'),
        failed: count('failed'),
        cancelled: count('cancelled'),
        preempted: matching.filter((node) => Boolean(node.preemption)).length,
      };
    });
    const disputes = Array.isArray(project.disputes) ? project.disputes : [];
    const disputeBudget = Number(project?.config?.disputes?.budgetPerEpoch);
    return publicView({
      ok: true,
      projectId,
      revision: project.revision ?? 0,
      classes,
      disputes: {
        budget: Number.isFinite(disputeBudget) && disputeBudget >= 0 ? disputeBudget : null,
        opened: disputes.length,
        resolved: disputes.filter((row) => row.status === 'resolved').length,
        pending: disputes.filter((row) => row.status === 'pending').length,
        consumed: disputes.length,
      },
      escalationQuotaPerEpoch: disputeQuota(project),
    });
  }

  /** Deterministic Stage-5 retrospective built from durable events/nodes. */
  function retrospectiveOf(project, nodes, now) {
    const completed = nodes.filter((node) => node.status === 'completed');
    const failed = nodes.filter((node) => node.status === 'failed');
    const cancelled = nodes.filter((node) => node.status === 'cancelled');
    const preempted = nodes.filter((node) => Boolean(node.preemption));
    const durations = completed
      .map((node) => Number(node.timestamps?.completedAt) - Number(node.timestamps?.startedAt))
      .filter((value) => Number.isFinite(value) && value >= 0);
    const failureStages = new Map();
    const failureMessages = new Map();
    for (const node of failed) {
      const stage = typeof node.error?.stage === 'string' ? node.error.stage : 'unknown';
      failureStages.set(stage, (failureStages.get(stage) ?? 0) + 1);
      const message = typeof node.error?.message === 'string' ? node.error.message.slice(0, 180) : 'unknown failure';
      failureMessages.set(message, (failureMessages.get(message) ?? 0) + 1);
    }
    const disputes = listDisputes(project.id, { limit: 500 }).disputes;
    const resolved = disputes.filter((row) => row.status === 'resolved');
    const classReport = classBudgetReport(project.id).classes;
    const started = nodes.filter((node) => Number.isFinite(Number(node.timestamps?.startedAt)));
    const wallClockMs = started.length === 0
      ? 0
      : Math.max(0, now - Math.min(...started.map((node) => Number(node.timestamps.startedAt))));
    return {
      id: `retro-${project.id}-${now}`,
      projectId: project.id,
      generatedAt: now,
      projectRevision: project.revision ?? 0,
      window: { wallClockMs, firstStartAt: started.length ? Math.min(...started.map((node) => Number(node.timestamps.startedAt))) : null },
      counts: {
        nodes: nodes.length,
        completed: completed.length,
        failed: failed.length,
        cancelled: cancelled.length,
        preempted: preempted.length,
        running: nodes.filter((node) => node.status === 'running').length,
        planned: nodes.filter((node) => ['planned', 'proposed', 'deferred'].includes(node.status)).length,
      },
      throughputPerHour: wallClockMs > 0 ? Number(((completed.length * 3_600_000) / wallClockMs).toFixed(2)) : null,
      durationMs: { avg: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null, max: durations.length ? Math.max(...durations) : null },
      failureStages: [...failureStages.entries()].sort((a, b) => b[1] - a[1]).map(([stage, count]) => ({ stage, count })),
      failureMessages: [...failureMessages.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([message, count]) => ({ message, count })),
      preemptions: preempted.map((node) => ({
        nodeId: node.id,
        forNodeId: node.preemption?.forNodeId ?? null,
        at: node.preemption?.at ?? null,
        appeal: node.preemption?.appeal?.status ?? null,
      })),
      disputes: {
        total: disputes.length,
        resolved: resolved.length,
        upheld: resolved.filter((row) => row.resolution === 'upheld').length,
        rejected: resolved.filter((row) => row.resolution === 'rejected').length,
        withdrawn: disputes.filter((row) => row.status === 'withdrawn').length,
        pending: disputes.filter((row) => row.status === 'pending').length,
        timedOut: resolved.filter((row) => row.resolutionReason === 'timeout_default' || row.defaultApplied === true).length,
      },
      predictions: {
        total: nodes.filter((node) => node.expectedOutcome).length,
        calibrated: nodes.filter((node) => node.expectedOutcome?.calibration === 'calibrated').length,
        directionOff: nodes.filter((node) => node.expectedOutcome?.calibration === 'direction_off').length,
        magnitudeOff: nodes.filter((node) => node.expectedOutcome?.calibration === 'magnitude_off').length,
        missingMetric: nodes.filter((node) => node.expectedOutcome?.calibration === 'missing_metric').length,
        retroOpen: nodes.filter((node) => node.expectedOutcome?.retroOpen).length,
        errors: nodes
          .filter((node) => node.expectedOutcome?.retroOpen)
          .slice(-10)
          .map((node) => ({
            nodeId: node.id,
            title: node.title,
            expected: node.expected ?? null,
            actual: node.expectedOutcome?.actual ?? null,
            delta: node.expectedOutcome?.delta ?? null,
            reason: node.expectedOutcome?.reason ?? null,
          })),
      },
      classBudgets: classReport,
    };
  }

  async function generateRetrospective(projectId, input = {}, exec = null) {
    const project = requireProject(projectId);
    const actor = actorFromDisputeExecution(exec) ?? actorForSession({ sessionId: 'operator' });
    const now = Date.now();
    const retrospective = retrospectiveOf(project, store.listNodes(projectId), now);
    const commit = await commitMutations(projectId, [{
      op: 'event.record',
      type: 'retrospective/generated',
      data: { retrospective, title: typeof input.title === 'string' ? input.title.slice(0, 200) : null },
    }], { actor, causeId: `retrospective:${projectId}:${now}` });
    const event = commit.events?.[0] ?? null;
    return publicView({ ok: true, projectId, retrospective, event: event ? { seq: event.seq, type: event.type } : null });
  }

  function listRetrospectives(projectId, { limit = 20 } = {}) {
    const project = requireProject(projectId);
    const size = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.trunc(limit))) : 20;
    const rows = store.listEvents(projectId)
      .filter((event) => event.type === 'retrospective/generated')
      .slice(-size)
      .map((event) => ({
        seq: event.seq,
        at: event.at,
        title: event.data?.title ?? null,
        retrospective: event.data?.retrospective ?? null,
      }));
    return publicView({ ok: true, projectId, revision: project.revision ?? 0, retrospectives: rows });
  }

  /**
   * Resolve an appeal. This is deliberately distinct from a generic withdraw:
   * the record names the resolver and the reason, and the status becomes
   * `resolved`, so an audit can tell an appeal that was heard from one that
   * simply expired. Only a human or the chief can resolve an appeal.
   */
  async function resolveAppeal(projectId, intentId, input = {}, exec = null) {
    const project = requireProject(projectId);
    if (!kernel?.executor) return rejection('internal_error', 'kernel executor is not wired');
    const intent = (Array.isArray(project.intents) ? project.intents : []).find((candidate) => candidate.id === intentId);
    if (!intent) return rejection('intent_not_found', `unknown intent: ${intentId}`);
    // Both halves of the appeal register must agree. Checking only `kind`
    // would let a malformed record borrow the appeal path.
    if (intent.kind !== 'appeal' || intent.claim?.action !== 'appeal') {
      return rejection('intent_action_mismatch', `intent ${intentId} is not a valid appeal record`);
    }
    const scopeAction = appealActionOf(intent.claim);
    if (!scopeAction || !IRREVERSIBLE_ACTIONS.includes(scopeAction)) {
      return rejection('appeal_target_mismatch', `appeal ${intentId} does not name an exact target and irreversible action`);
    }
    if (expectedScopeKind(scopeAction) === 'project') {
      if (intent.target?.nodeId || intent.target?.projectId !== projectId) {
        return rejection('appeal_target_mismatch', `delete_project appeal ${intentId} is not scoped to this project`);
      }
    } else {
      if (!intent.target?.nodeId || intent.target?.projectId) {
        return rejection('appeal_target_mismatch', `appeal ${intentId} does not name an exact node target`);
      }
      if (!store.getNode(projectId, intent.target.nodeId)) {
        return rejection('node_not_found', `appeal ${intentId} targets unknown node ${intent.target.nodeId}`);
      }
    }
    const actor = actorFromToolExecution(exec) ?? actorForSession({ sessionId: 'operator' });
    if (actor.kind !== 'human' && actor.kind !== 'system' && actor.preset !== 'lab-chief') {
      return rejection('forbidden_action', 'only a human or the chief may resolve an appeal');
    }
    if (intent.status !== 'pending' && intent.status !== 'withdrawn') {
      return rejection('intent_not_pending', `appeal ${intentId} is already ${intent.status}`);
    }
    // A pending appeal still expires, but a withdrawn appeal does not: its TTL
    // cannot turn silence into permission. It needs an explicit hearing.
    if (intent.status === 'pending' && Number.isFinite(intent.expiresAt) && intent.expiresAt <= Date.now()) {
      return rejection('appeal_expired', `appeal ${intentId} expired before it was resolved`);
    }
    // Separation of powers: the actor who raised an appeal cannot also decide
    // it. This is by opaque actorKey, not by role, so a chief cannot self-certify.
    // A keyed actor and an unkeyed legacy raiser are not comparable; fail closed
    // instead of treating "not provably equal" as a different person.
    if (Boolean(actorKeyOf(intent.actor)) !== Boolean(actorKeyOf(actor))) {
      return rejection('forbidden_action', 'appeal raiser and resolver have incomparable actor identities');
    }
    if (sameActor(intent.actor, actor)) {
      return rejection('appeal_self_resolution', 'the actor who raised an appeal cannot resolve it; a different human or the chief must decide');
    }
    let commit;
    try {
      commit = await commitMutations(projectId, [{
        op: 'intent.withdraw',
        intentId,
        expectedStatus: intent.status,
        expectedRevision: project.revision ?? 0,
        resolve: true,
        actor,
        resolution: typeof input?.resolution === 'string' ? input.resolution : 'upheld',
        reason: typeof input?.reason === 'string' ? input.reason : 'appeal resolved by operator',
      }], { actor, causeId: `appeal-resolve:${intentId}` });
    } catch (error) {
      if (error instanceof LabError) return rejection(error.code, error.message);
      throw error;
    }
    if (commit.ok !== true) return rejection(commit.code ?? 'internal_error', commit.message ?? 'appeal resolution failed');
    const fresh = store.getProject(projectId)?.intents?.find((candidate) => candidate.id === intentId) ?? null;
    return { ok: true, projectId, intent: fresh };
  }

  /** Withdraw a pending judgement (curator nomination or stale proposal). */
  async function withdrawIntent(projectId, intentId, input = {}, exec = null) {
    const project = requireProject(projectId);
    if (!kernel?.executor) return rejection('internal_error', 'kernel executor is not wired');
    const intent = (Array.isArray(project.intents) ? project.intents : []).find((candidate) => candidate.id === intentId);
    if (!intent) return rejection('intent_not_found', `unknown intent: ${intentId}`);
    if (intent.status === 'withdrawn') return { ok: true, projectId, intent, alreadyWithdrawn: true };
    if (intent.status === 'resolved') return rejection('intent_not_pending', `intent ${intentId} is already resolved`);
    const actor = actorFromToolExecution(exec) ?? actorForSession({ sessionId: 'operator' });
    const appeal = intent.kind === 'appeal';
    // Withdrawal is not a hearing and it does not remove the block: a
    // withdrawn appeal remains `appeal_not_resolved` until an explicit
    // resolution by another actor. An expert may withdraw only the appeal it
    // raised; a different expert cannot silence someone else's objection.
    if (appeal && actor.kind === 'expert' && actor.preset !== 'lab-chief') {
      if (Boolean(actorKeyOf(intent.actor)) !== Boolean(actorKeyOf(actor))) {
        return rejection('forbidden_action', 'appeal raiser and withdrawer have incomparable actor identities');
      }
      if (!sameActor(intent.actor, actor)) {
        return rejection('forbidden_action', 'an expert may withdraw only its own appeal; a human or the chief may withdraw another actor\'s appeal');
      }
    }
    // Withdrawal is not a hearing: it must not write `resolved`, `resolvedBy`
    // or `resolution`, and it cannot be used by an expert to impersonate the
    // resolver role. The TTL never turns the withdrawal into permission.
    let commit;
    try {
      commit = await commitMutations(projectId, [{
        op: 'intent.withdraw',
        intentId,
        expectedStatus: intent.status,
        expectedRevision: project.revision ?? 0,
        actor,
        reason: typeof input?.reason === 'string' ? input.reason : 'withdrawn by operator',
      }], { actor, causeId: `intent-withdraw:${intentId}` });
    } catch (error) {
      if (error instanceof LabError) return rejection(error.code, error.message);
      throw error;
    }
    if (commit.ok !== true) return rejection(commit.code ?? 'internal_error', commit.message ?? 'intent withdraw failed');
    const fresh = store.getProject(projectId)?.intents?.find((candidate) => candidate.id === intentId) ?? null;
    return { ok: true, projectId, intent: fresh };
  }

  /** Human reset for the curator's false-close breaker (production path). */
  function resetCurator() {
    return { ok: true, ...curator.reset() };
  }

  /**
   * B14: resolve one pending high-review window. The chief (or a human owner)
   * can defer/withdraw, or keep with at least one verified raw-data pointer.
   * The node was already materialized as p2, so the normal path is optimistic.
   */
  async function resolveHighReview(projectId, nodeId, input = {}, exec = null) {
    const project = requireProject(projectId);
    const node = requireNode(projectId, nodeId);
    if (!node.pendingHighReview) return rejection('no_pending_high_review', `node ${nodeId} has no pending high review`, { nodeId });
    const actor = exec && (exec.kind || exec.agent) ? actorFromToolExecution(exec) : null;
    if (!actor) return rejection('actor_required', 'high-review resolution requires an actor');
    const chief = chiefPolicy(project);
    if (!(actor.kind === 'human' || actor.id === chief.chiefId || actor.preset === chief.chiefId || actor.kind === 'chief')) {
      return rejection('forbidden_action', 'only the chief or a human owner may resolve a high review', { chiefId: chief.chiefId });
    }
    const action = input?.action;
    if (!['defer', 'withdraw', 'keep'].includes(action)) {
      return rejection('bad_request', 'action must be defer, withdraw or keep');
    }
    const decision = {
      action,
      reasonCode: typeof input?.reasonCode === 'string' ? input.reasonCode : null,
      verifiedEvidence: Array.isArray(input?.verifiedEvidence) ? input.verifiedEvidence : [],
      evidenceChain: Array.isArray(input?.evidenceChain) ? input.evidenceChain : node.pendingHighReview.evidenceChain ?? [],
    };
    if (action === 'keep') {
      const errors = validateChiefDecision(decision, store.listNodes(projectId));
      if (errors.length > 0) return rejection('invalid_high_review', errors.join('; '), { errors });
    }
    const now = Date.now();
    const next = structuredClone(node);
    next.pendingHighReview = null;
    next.highReview = {
      ...(node.highReview ?? {}),
      status: action === 'defer' ? 'deferred' : action === 'withdraw' ? 'withdrawn' : 'kept',
      resolvedAt: now,
      resolvedBy: { kind: actor.kind, id: actor.id },
      reasonCode: decision.reasonCode,
      evidenceChain: decision.evidenceChain,
    };
    if (action === 'defer') {
      next.priority = { ...(next.priority ?? {}), class: 'deferred', by: actor.id, reason: 'high-review veto: defer', at: now };
    }
    if (action === 'withdraw') {
      next.status = 'cancelled';
      next.cancelledAt = now;
      next.cancelledBy = { kind: actor.kind, id: actor.id };
      next.cancelReason = 'high-review veto: withdraw';
    }
    if (action === 'keep') next.ratifiedBy = chief.chiefId;
    const commit = await kernel.executor.commit(projectId, {
      actor,
      mutations: [{ op: 'node.put', node: next, eventType: 'node/high_review_resolved', eventData: { decision: action, reasonCode: decision.reasonCode } }],
      causeId: `high-review:${nodeId}:${action}`,
    });
    if (commit.ok !== true) return rejection(commit.code ?? 'internal_error', commit.message ?? 'high review commit failed');
    return { ok: true, projectId, nodeId, decision: action, node: store.getNode(projectId, nodeId), event: commit.events?.[0] ?? null };
  }

  /** B14: timeout keeps the optimistic node but records it as unreviewed. */
  async function sweepHighReviews(projectId, now = Date.now()) {
    const project = requireProject(projectId);
    const due = store.listNodes(projectId).filter((node) => node.pendingHighReview && Number(node.pendingHighReview.deadlineAt) > 0 && Number(node.pendingHighReview.deadlineAt) <= now);
    const resolved = [];
    for (const node of due) {
      const next = structuredClone(node);
      next.pendingHighReview = null;
      next.highReview = {
        ...(node.highReview ?? {}),
        status: 'unreviewed',
        resolvedAt: now,
        resolvedBy: null,
        reasonCode: 'window_timeout',
      };
      const commit = await kernel.executor.commit(projectId, {
        actor: { kind: 'system', id: 'high-review-sweeper' },
        mutations: [{ op: 'node.put', node: next, eventType: 'node/high_review_unreviewed', eventData: { deadlineAt: node.pendingHighReview.deadlineAt } }],
        causeId: `high-review:${node.id}:timeout`,
      });
      if (commit.ok === true) resolved.push(node.id);
    }
    return { ok: true, projectId, resolved };
  }

  async function setNodePriority(projectId, nodeId, input, actor = null) {
    const project = requireProject(projectId);
    const node = requireNode(projectId, nodeId);
    const classes = ['p0', 'p1', 'p2', 'p3', 'deferred'];
    if (input?.class !== undefined && !classes.includes(input.class)) {
      return rejection('bad_request', `priority.class must be one of ${classes.join(', ')}`);
    }
    // Priority is a pre-run scheduling hint. Once a node is running or terminal
    // the dispatch order no longer means anything, and silently accepting the
    // write would fake an intervention that cannot happen (B7).
    if (node.status !== 'planned' && node.status !== 'proposed') {
      return rejection(
        'priority_frozen',
        `node ${nodeId} is ${node.status}; priority can only change while planned or proposed`,
        { status: node.status },
      );
    }
    if (!kernel?.executor) return rejection('internal_error', 'kernel executor is not wired');
    // Attribute the commit to the real caller. HTTP/UI passes no actor and is
    // the human operator; a tool call passes its DSH session actor, so a
    // `lab-chat` change is never recorded as a human intervention.
    const commitActor = actor ?? { kind: 'human', id: 'operator' };
    const priority = {
      ...(input?.class !== undefined ? { class: input.class } : {}),
      ...(Number.isFinite(input?.score) ? { score: input.score } : {}),
      reason: typeof input?.reason === 'string' && input.reason.trim() ? input.reason.trim().slice(0, 500) : 'manual priority change',
    };
    // Q5: pruning is a separate quota. Without this check a project could
    // accumulate unbounded deferred nodes while maxNodes never moved.
    if (priority.class === 'deferred' && normalizePriority(node.priority).class !== 'deferred') {
      const maxDeferred = project.config?.maxDeferred ?? 20;
      const deferredCount = store.listNodes(projectId).filter((candidate) => candidate.status === 'planned' && !candidate.archivedAt && normalizePriority(candidate.priority).class === 'deferred').length;
      if (deferredCount >= maxDeferred) {
        return rejection('max_deferred_reached', `deferred quota is ${maxDeferred}; restore or archive a deferred node first`, { maxDeferred, deferred: deferredCount });
      }
    }
    const judgement = createIntent({
      id: intentId('priority', project.revision + 1, commitActor.id),
      kind: 'priority',
      actor: commitActor,
      claim: { action: 'set_priority', from: normalizePriority(node.priority), to: normalizePriority(priority), reason: priority.reason },
      basis: basisFor(project.revision, store.listNodes(projectId).length),
      target: { nodeId },
      rationale: priority.reason,
    });
    // G1/B7: the only write path is the kernel executor, so the change is an
    // event-sourced commit (same invariant as dispatch and node edits).
    const commit = await kernel.executor.commit(projectId, {
      actor: commitActor,
      mutations: [{ op: 'node.setPriority', nodeId, priority }, intentMutation(judgement)],
      causeId: `intent:${judgement.id}`,
    });
    if (commit.ok !== true) {
      return rejection(commit.code ?? 'internal_error', commit.message ?? 'priority update failed');
    }
    const fresh = store.getNode(projectId, nodeId);
    const before = normalizePriority(node.priority);
    const after = normalizePriority(fresh?.priority ?? priority);
    return {
      ok: true,
      nodeId,
      node: fresh ?? null,
      revision: store.getProject(projectId)?.revision ?? project.revision,
      before,
      after,
      event: commit.events?.[0] ? { seq: commit.events[0].seq, type: commit.events[0].type } : null,
      effect: after.class === 'p0'
        ? 'The next dispatch tick will consider this node first.'
        : 'The node keeps its place; runnable ordering updates on the next tick.',
      nextToStart: (await statusFacts(projectId)).nextToStart.slice(0, 3),
    };
  }

  async function agentTool(input, exec = null) {
    const action = input?.action;
    let actor;
    try {
      actor = actorFromToolExecution(exec);
    } catch (error) {
      return rejection(error?.code ?? 'caller_supplied_actor_key', error?.message ?? String(error));
    }
    if (action === 'projects') return { projects: await listProjects() };
    if (action === 'status') {
      if (!input?.projectId) return { projects: await listProjects() };
      const state = await getState(input.projectId);
      return {
        project: state.project,
        nodes: state.nodes.map((node) => ({
          id: node.id,
          title: node.title,
          status: node.status,
          parentId: node.parentId,
          needs: node.needs,
          lease: node.lease ?? null,
          resourceWait: node.resourceWait ?? null,
          timeboxMs: node.timeboxMs,
          deadlineAt: node.deadlineAt ?? null,
          headCommit: node.git?.headCommit ?? null,
          model: node.model ?? null,
          modelResolved: node.modelResolved ?? null,
          attempts: (node.attempts ?? []).map((attempt) => ({
            index: attempt.index,
            model: attempt.model ?? null,
            startedAt: attempt.startedAt,
            endedAt: attempt.endedAt ?? null,
            status: attempt.status ?? null,
            stopReason: attempt.stopReason ?? null,
            error: attempt.error ?? null,
            costUsd: attempt.costUsd ?? null,
            usage: attempt.usage ?? null,
          })),
          usage: node.usage ?? null,
          costUsd: node.costUsd ?? null,
          report: node.report ? { summary: node.report.summary, success: node.report.success } : null,
          reportText: node.reportText ? String(node.reportText).slice(0, 500) : null,
          error: node.error ?? null,
          termination: node.termination ?? null,
          followUps: node.followUps?.length ?? 0,
        })),
        edges: state.edges,
        resources: state.resources,
        cluster: state.cluster,
        revision: state.revision,
      };
    }
    if (action === 'create_project') {
      const result = await createProject(input);
      return {
        project: result.project,
        rootNode: result.rootNode,
        rootNodes: result.rootNodes,
        revision: result.revision,
      };
    }
    if (action === 'state') return getState(input?.projectId, input?.sinceRevision, { full: input?.full === true });
    if (action === 'changes_since') return changesSince(input?.projectId, input?.sinceRevision);
    if (action === 'get_node') return getNode(input?.projectId, input?.nodeId);
    if (action === 'update_project') return updateProject(input?.projectId, input ?? {});
    if (action === 'update_node') return updateNode(input?.projectId, input?.nodeId, input ?? {}, actor);
    if (action === 'cluster') return getCluster(input?.projectId);
    if (action === 'cluster_config') return getClusterConfig();
    if (action === 'compile_placement') return compilePlacementPolicyForProject(input?.projectId, input?.text);
    if (action === 'cluster_config_update') return updateClusterConfig(input);
    if (action === 'models') return getModels(input?.projectId);
    if (action === 'validate_model') {
      const project = requireProject(input?.projectId);
      const llm = ctx?.llm;
      let providers = null;
      try {
        providers = typeof llm?.listProviders === 'function' ? llm.listProviders().slice(0, 4) : null;
      } catch (error) {
        providers = { error: error instanceof Error ? error.message : String(error) };
      }
      return {
        hasCtx: Boolean(ctx),
        hasLlm: Boolean(llm),
        llmKeys: llm ? Object.keys(Object.getPrototypeOf(llm) ?? {}).slice(0, 20) : null,
        hasResolveModel: typeof llm?.resolveModel === 'function',
        hasListProviders: typeof llm?.listProviders === 'function',
        providers,
        validated: await validateModelSelection(ctx, project, cleanModelRef(input?.model) ?? input?.model),
      };
    }
    if (action === 'start_node') return runtime.start(input?.projectId, input?.nodeId);
    if (action === 'retry_node') return retryNode(input?.projectId, input?.nodeId, input);
    if (action === 'escalate_node') return escalateNode(input?.projectId, input?.nodeId, input);
    if (action === 'delete_project') return deleteProject(input?.projectId, { removeWorktrees: input?.removeWorktrees === true, nodeId: input?.nodeId, exec });
    if (action === 'cancel_node') return cancelNode(input?.projectId, input?.nodeId, { exec, claim: input?.claim, chiefConfirmed: input?.chiefConfirmed });
    if (action === 'message_node') return runtime.message(input?.projectId, input?.nodeId, input?.text);
    if (action === 'node_files') return ensureNodeWorktree(input?.projectId, input?.nodeId);
    if (action === 'replay') return getReplay(input?.projectId, { limit: input?.limit, afterSeq: input?.afterSeq, nodeLimit: input?.nodeLimit });
    if (action === 'dashboard_get') return getDashboard(input?.projectId);
    if (action === 'dashboard_update') return updateDashboard(input?.projectId, { spec: input?.dashboardSpec ?? input?.spec });
    if (action === 'dashboard_refresh') return refreshDashboard(input?.projectId, { force: true });
    if (action === 'dashboard_chat') return chatDashboard(input?.projectId, input?.text);
    if (action === 'dashboard_layout') return updateDashboardLayout(input?.projectId, input?.layouts);
    if (action === 'transcript') return getTranscript(input?.projectId, input?.nodeId, input?.afterSeq, input?.limit);
    if (action === 'step') return orchestrator.step(input?.projectId, input?.trigger ?? 'manual');
    if (action === 'successor') return orchestrator.createSuccessor(input?.projectId, input?.nodeId, input);
    if (action === 'create_merge') return createMergeNode(input?.projectId, input);
    if (action === 'finish_merge') return finishMerge(input?.projectId, input?.nodeId, input);
    if (action === 'push_project') return pushProject(input?.projectId, input);
    if (action === 'approve_node') return approveProposal(input?.projectId, input?.nodeId);
    if (action === 'reject_node') return rejectProposal(input?.projectId, input?.nodeId);
    if (action === 'auto_start') return autoStart(input?.projectId);
    if (action === 'auto_stop') return autoStop(input?.projectId);
    if (action === 'auto_resume') return autoResume(input?.projectId);
    if (action === 'auto_status') return autoStatus(input?.projectId);
    if (action === 'runs') return listRuns(input?.projectId, input?.limit);
    if (action === 'runs_page') { requireProject(input?.projectId); return store.pageRuns(input?.projectId, { limit: input?.limit, cursor: input?.cursor }); }
    if (action === 'run') return getRun(input?.projectId, input?.runId);
    if (action === 'chat') return projectChat(input?.projectId, input?.text);
    if (action === 'clear_chat') return clearProjectChat(input?.projectId);
    if (action === 'copilot') return openCopilot(input?.projectId, { create: input?.create === true, title: input?.title, sessionId: input?.sessionId });
    if (action === 'intake_read') return readIntake(input?.intakeId);
    if (action === 'intake_patch') return patchIntake(input?.intakeId, input?.values);
    if (action === 'intake_ready') return readyIntake(input?.intakeId);
    if (action === 'intake_start') return startIntake(input);
    if (action === 'intake_message') return messageIntake(input?.intakeId, input?.text);
    if (action === 'intake_confirm') return confirmIntake(input?.intakeId, { start: input?.start === true });
    if (action === 'intake_discard') return discardIntake(input?.intakeId);
    if (action === 'status_facts') return statusFacts(input?.projectId);
    if (action === 'resource_status') return resourceStatus(input?.projectId, input?.nodeId ?? null);
    if (action === 'dispatch_once') return dispatchOnceAction(input?.projectId, { maxStarts: input?.limit });
    if (action === 'metrics') return metricsFor(input?.projectId);
    if (action === 'explain_node') return explainNode(input?.projectId, input?.nodeId, { window: input?.window });
    if (action === 'trace_explain') return traceExplain(input?.projectId, input?.nodeId, { window: input?.window });
    if (action === 'dag_query') return dagQuery(input?.projectId, input, exec);
    if (action === 'dag_get') return dagGetAction(input?.projectId, input, exec);
    if (action === 'dag_map') return dagMapAction(input?.projectId, input);
    if (action === 'dag_walk') return dagWalkAction(input?.projectId, input);
    if (action === 'dag_diff') return dagDiffAction(input?.projectId, input);
    if (action === 'nodes_page') return nodesPageAction(input?.projectId, input);
    if (action === 'events_page') return eventsPageAction(input?.projectId, input);
    if (action === 'claim_review') return reviewClaimAction(input?.projectId, input, exec);
    if (action === 'release_review') return reviewReleaseAction(input?.projectId, input, exec);
    if (action === 'review_claims') return reviewClaimsAction(input?.projectId);
    if (action === 'observe') return observe(input?.projectId);
    if (action === 'disputes') return listDisputes(input?.projectId, { limit: input?.limit, status: input?.status ?? null });
    if (action === 'dispute_open') return openDispute(input?.projectId, input, exec);
    if (action === 'arbitrate') return arbitrate(input?.projectId, input, exec);
    if (action === 'health') return health();
    if (action === 'ledger_read') return ledgerRead(input?.projectId, input?.limits);
    if (action === 'ledger_update') return ledgerUpdate(input?.projectId, input, exec);
    if (action === 'set_priority') return setNodePriority(input?.projectId, input?.nodeId, input, actor);
    if (action === 'resolve_high_review') return resolveHighReview(input?.projectId, input?.nodeId, { ...input, action: input?.decision }, exec);
    if (action === 'intent_submit') return submitIntent(input?.projectId, input, exec);
    if (action === 'intent_list') return listIntents(input?.projectId, { limit: input?.limit, kind: input?.kind ?? null });
    if (action === 'expert_list') return listExperts(input?.projectId, { actor: exec ? actorFromToolExecution(exec) : null });
    if (action === 'expert_recall') return recallExpertFor(input?.projectId, input?.task ?? input?.text ?? '', { limit: input?.limit, actor: exec ? actorFromToolExecution(exec) : null });
    if (action === 'expert_hire') return hireExpert(input?.projectId, input, exec);
    if (action === 'expert_invite') return inviteExpert(input?.projectId, input, exec);
    if (action === 'expert_drain') return drainExpert(input?.projectId, input, exec);
    if (action === 'expert_fire') return fireExpert(input?.projectId, input, exec);
    if (action === 'curator_nominate') return nominateDuplicates(input?.projectId, input, exec);
    if (action === 'curator_outcome') return recordCuratorOutcome(input);
    if (action === 'curator_reset') return resetCurator();
    if (action === 'intent_withdraw') return withdrawIntent(input?.projectId, input?.intentId, input, exec);
    if (action === 'retention_plan') return retentionPlan(input?.projectId, input);
    throw new LabError('unknown_command', `unknown metainfer_lab action: ${String(action)}`, 400);
  }

  async function health() {
    return {
      name: 'metainfer-research-lab',
      version,
      domain: store.domainName,
      storage: 'ready',
      projects: store.listProjects().length,
      writes: typeof store.writeStats === 'function' ? store.writeStats() : null,
    };
  }

  return {
    name: 'metainfer-research-lab',
    version,
    domainName: store.domainName,
    health,
    verifyOperatorToken,
    listProjects,
    validateRepo,
    createProject,
    getState,
    getNode,
    listNodesPage,
    submitIntent,
    listIntents,
    listDisputes,
    disputeClasses,
    openDispute,
    resolveDispute,
    reopenDispute,
    sweepDisputes,
    classBudgetReport,
    generateRetrospective,
    listRetrospectives,
    reviewClaimsAction,
    withdrawIntent,
    resolveAppeal,
    resetCurator,
    listExperts,
    recallExpertFor,
    hireExpert,
    inviteExpert,
    drainExpert,
    fireExpert,
    rotationStatus,
    rotateExpert,
    rotateDueExperts,
    archiveDeferred,
    autoJoinCompleted,
    retentionPlan,
    nominateDuplicates,
    recordCuratorOutcome,
    changesSince,
    getEvents,
    getReplay,
    observerSnapshot,
    waitForEvents,
    escalateStalled,
    observe,
    arbitrate,
    updateProject,
    migrationStatus,
    advanceMigration,
    openResidentSession,
    callResidentTool,
    closeResidentSession,
    updateNode,
    startNode,
    retryNode,
    escalateNode,
    getModels,
    getChat,
    clearProjectChat,
    projectChat,
    getCopilot,
    openCopilot,
    createPrivateCopilotSession,
    startIntake,
    readIntake,
    patchIntake,
    readyIntake,
    messageIntake,
    confirmIntake,
    discardIntake,
    getCluster,
    getClusterConfig,
    updateClusterConfig,
    compilePlacementPolicyForProject,
    deleteProject,
    cancelNode,
    preemptNode,
    appealPreemption,
    messageNode,
    getTranscript,
    getSessionTranscript,
    ensureNodeWorktree,
    getDashboard,
    updateDashboard,
    refreshDashboard,
    chatDashboard,
    updateDashboardLayout,
    startDashboardScheduler,
    resolveWorktreeFile,
    getExecutionEvents,
    step,
    createSuccessor,
    createMergeNode,
    finishMerge,
    pushProject,
    approveProposal,
    rejectProposal,
    autoStart,
    autoStop,
    autoResume,
    autoStatus,
    listRuns,
    listRunsPage,
    getRun,
    agentTool,
    statusFacts,
    metricsFor,
    dispatchOnce: dispatchOnceAction,
    explainNode,
    traceExplain,
    dagQuery,
    dagGet: dagGetAction,
    ledgerRead,
    ledgerUpdate,
    setNodePriority,
    resolveHighReview,
    sweepHighReviews,
    metricsCollector,
    toActionable,
  };
}

/** Exported for the scale test: the state-index projection of one node. */
export function slimStateNode(node) {
  const out = { ...node };
  const prompt = typeof node.prompt === 'string' ? node.prompt : null;
  if (prompt !== null) {
    out.prompt = prompt.slice(0, STATE_PROMPT_CHARS);
    out.promptChars = prompt.length;
    out.promptComplete = prompt.length <= STATE_PROMPT_CHARS;
  }
  const report = node.report && typeof node.report === 'object' ? node.report : null;
  const summary = report && typeof report.summary === 'string' ? report.summary : '';
  const reportText = typeof node.reportText === 'string' ? node.reportText : '';
  delete out.reportText;
  if (report !== null) {
    const headline = (typeof report.headline === 'string' && report.headline.trim())
      ? report.headline.trim().slice(0, 300)
      : summary.split('\n')[0].slice(0, 300);
    out.report = { ...report, summary: headline, headline, summaryChars: summary.length };
  }
  out.reportChars = summary.length || reportText.length;
  out.reportAvailable = Boolean(summary || reportText);
  return out;
}
