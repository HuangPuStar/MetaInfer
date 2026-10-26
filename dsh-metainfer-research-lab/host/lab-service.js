/**
 * M1 lab service: project creation, state projection, edits.
 *
 * The service is transport-free: host/http.js calls the same methods the UI
 * uses, and later phases expose the same operations to agent tools.
 */
import path from 'node:path';
import { LabError } from './git-engine.js';
import { buildModelCatalog, cleanModelRef, resolveModelSelection, validateModelSelection } from './models.js';
import { compilePlacementPolicy, describePlacementSpec, sanitizePlacementSpec } from './placement.js';
import { DEFAULT_ADVISOR_PROMPT, DEFAULT_SCHEDULER_PROMPT, DEFAULT_WORKER_PREFIX, PROMPT_PLACEHOLDERS } from './prompts.js';
import { newProjectId, newSessionId } from './store.js';

const MAX_TIMEOUT_MINUTES = 1440;

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
  const config = {
    ...previous,
    resourcePools: input.resourcePools === undefined
      ? (previous.resourcePools ?? {})
      : normalizeResourcePools(input.resourcePools),
    maxRunningNodes: integer(input.maxRunningNodes, 'config.maxRunningNodes', previous.maxRunningNodes ?? 4, 1, 64),
    maxNodes: integer(input.maxNodes, 'config.maxNodes', previous.maxNodes ?? 60, 1, 1000),
    // Cluster queue priority (higher starts sooner when several projects contend for one GPU).
    clusterPriority: integer(input.clusterPriority, 'config.clusterPriority', previous.clusterPriority ?? 0, 0, 100),
    nodeTimeoutMinutes,
    maxNodeTimeoutMinutes,
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
    for (const role of ['worker', 'advisor', 'scheduler', 'controller', 'merge', 'gc']) {
      if (input.models[role] !== undefined) roleInputs[role] = input.models[role];
    }
    for (const [role, raw] of Object.entries(roleInputs)) {
      if (!['worker', 'advisor', 'scheduler', 'controller', 'merge', 'gc'].includes(role)) continue;
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
      Object.entries(models).filter(([key]) => ['worker', 'advisor', 'scheduler', 'controller', 'merge', 'gc'].includes(key)),
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

  if (input.prompts !== undefined) {
    if (typeof input.prompts !== 'object' || Array.isArray(input.prompts)) {
      throw new LabError('bad_request', 'config.prompts must be an object');
    }
    const prompts = { ...(previous.prompts ?? {}) };
    for (const key of ['workerPrefix', 'advisor', 'scheduler']) {
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
      ancestorDepth: previous.advisor?.ancestorDepth ?? 2,
      acceptMode: previous.advisor?.acceptMode ?? 'auto',
      maxPendingProposals: previous.advisor?.maxPendingProposals ?? 20,
      reviewers: previous.advisor?.reviewers ?? [],
    };
    if (input.advisor.maxProposalsPerPass !== undefined) {
      advisor.maxProposalsPerPass = integer(input.advisor.maxProposalsPerPass, 'config.advisor.maxProposalsPerPass', advisor.maxProposalsPerPass, 1, 10);
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

  // Ensure every project has the full default shape even when created before M4.
  config.advisor = config.advisor ?? { maxProposalsPerPass: 3, ancestorDepth: 2, acceptMode: 'auto', maxPendingProposals: 20, reviewers: [] };
  config.auto = config.auto ?? { maxCycles: 50, maxWallClockMs: 6 * 60 * 60 * 1000, idleCycleLimit: 3, debounceMs: 1500, cooldownMs: 5000, maxTokens: 0, maxCostUsd: 0 };
  config.modelOptions = config.modelOptions ?? [];
  config.routing = config.routing ?? { advisorMaySelectModels: false, autoUpgrade: false, maxAttempts: 2 };
  config.models = config.models ?? {};
  config.placementPolicy = config.placementPolicy ?? { text: '', spec: null, compiledAt: null, explanation: [], warnings: [], compiler: null };
  return config;
}

/**
 * @param {{store: object, git: object, version?: string}} deps
 */
export function createLabService({ ctx, store, git, runtime, transcript, orchestrator, auto, cluster, clusterAdmin, version = '0.8.9-v3' }) {
  function requireProject(projectId) {
    const project = typeof projectId === 'string' ? store.getProject(projectId) : undefined;
    if (!project) throw new LabError('project_not_found', `unknown project: ${projectId}`, 404);
    return project;
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
    const initialPrompt = text(input?.initialPrompt, 'initialPrompt', { required: true, max: 8000 });
    if (initialPrompt.length < 10) throw new LabError('bad_request', 'initialPrompt must be at least 10 characters');
    const repoPath = text(input?.repoPath, 'repoPath', { required: true, max: 4096 });

    const repo = await git.validateRepo(repoPath);
    const baseBranch = text(input?.baseBranch, 'baseBranch', { max: 256 }) || repo.defaultBranch;
    const baseCommit = await git.resolveBranch(repo.repoRoot, baseBranch);
    const config = normalizeConfig(input?.config);
    let rootNeeds = {};
    if (input?.needs !== undefined) {
      const checked = normalizeNeeds(input.needs, { config });
      if (checked.error) throw new LabError('bad_request', checked.error, 400);
      rootNeeds = checked.needs;
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
      counters: { nextNodeSeq: 2, nodes: 1, cycles: 0, eventSeq: 0 },
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };

    const nodeId = 'n-0001';
    const rootNode = {
      id: nodeId,
      projectId,
      title: '根节点',
      anchorSessionId: newSessionId(),
      sessionId: newSessionId(),
      deadlineAt: null,
      prompt: initialPrompt,
      successCriteria: '',
      status: 'planned',
      parentId: null,
      createdBy: 'seed',
      needs: rootNeeds,
      timeboxMs: config.nodeTimeoutMinutes * 60_000,
      git: {
        branch: `dshex/${projectId}/${nodeId}`,
        worktreePath: path.join(worktreeRoot, nodeId),
        baseCommit,
        headCommit: null,
      },
      timestamps: { createdAt: now, lastActivityAt: null },
    };

    await store.saveProject(project);
    await store.saveNode(projectId, rootNode);
    await store.appendEvent(project, 'project/created', {
      data: { name, repoPath: repo.repoRoot, baseBranch, baseCommit },
    });
    await store.appendEvent(project, 'node/created', {
      nodeId,
      data: { title: rootNode.title, status: rootNode.status, createdBy: rootNode.createdBy },
    });
    project.updatedAt = Date.now();
    await store.saveProject(project);

    return { project, rootNode, revision: project.revision };
  }

  async function getState(projectId, sinceRevision) {
    const project = requireProject(projectId);
    if (sinceRevision !== undefined && sinceRevision !== null && sinceRevision !== '') {
      const parsed = Number(sinceRevision);
      if (Number.isFinite(parsed) && parsed === project.revision) {
        return { unchanged: true, revision: project.revision };
      }
    }
    const rawNodes = runtime
      ? runtime.decorateNodes(projectId, store.listNodes(projectId))
      : store.listNodes(projectId);
    const parentIds = new Set();
    for (const node of rawNodes) {
      if (node.status === 'proposed') continue;
      const ids = Array.isArray(node.parentIds) && node.parentIds.length > 0
        ? node.parentIds
        : (node.parentId ? [node.parentId] : []);
      for (const id of ids) parentIds.add(id);
    }
    const nodes = rawNodes.map((node) => ({
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
    for (const node of nodes) {
      if (node.status !== 'running' || !node.resourcesHeld) continue;
      for (const [key, amount] of Object.entries(node.resourcesHeld)) {
        held[key] = (held[key] ?? 0) + amount;
      }
    }
    const free = {};
    for (const [key, total] of Object.entries(pools)) {
      free[key] = Math.max(0, total - (held[key] ?? 0));
    }

    return {
      project,
      nodes,
      edges,
      resources: { pools, held, free },
      worktreeRoot: project.repo?.worktreeRoot,
      revision: project.revision,
      lastEventSeq: project.counters?.eventSeq ?? 0,
      pendingProposals: nodes.filter((node) => node.status === 'proposed').length,
      auto: auto ? auto.statusOf(projectId) : { status: 'off', pauseReason: null },
      cluster: cluster ? cluster.getStatus() : { enabled: false, mode: 'local' },
    };
  }

  async function getEvents(projectId, after = 0) {
    requireProject(projectId);
    const parsedAfter = Number.isFinite(Number(after)) ? Math.max(0, Math.trunc(Number(after))) : 0;
    const events = store.listEvents(projectId, parsedAfter);
    return { events, next: store.maxEventSeq(projectId) };
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
      project.revision += 1;
      project.updatedAt = Date.now();
      await store.saveProject(project);
      await store.appendEvent(project, 'project/edited', { data: { revision: project.revision } });
      await store.saveProject(project);
      return { project, revision: project.revision };
    });
  }

  async function updateNode(projectId, nodeId, input) {
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
      if (node.status !== 'planned' && node.status !== 'proposed') {
        throw new LabError('node_not_editable', 'only planned or proposed nodes can be edited', 409);
      }
      let changed = false;
      if (input?.title !== undefined) {
        node.title = text(input.title, 'title', { required: true, max: 120 });
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
      if (!changed) return { node, revision: project.revision };
      node.timestamps = { ...(node.timestamps ?? {}), lastActivityAt: Date.now() };
      project.revision += 1;
      project.updatedAt = Date.now();
      await store.saveNode(projectId, node);
      await store.appendEvent(project, 'node/edited', { nodeId, data: { revision: project.revision } });
      await store.saveProject(project);
      return { node, revision: project.revision };
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
      project.chatLog = log.slice(-80);
      project.revision = (project.revision ?? 0) + 1;
      project.updatedAt = Date.now();
      await store.saveProject(project);
      return chatMessagesOf(project);
    });
  }

  async function clearProjectChat(projectId) {
    return store.withProjectLock(projectId, async () => {
      const project = requireProject(projectId);
      project.chatLog = [];
      project.revision = (project.revision ?? 0) + 1;
      project.updatedAt = Date.now();
      await store.saveProject(project);
      return { projectId, messages: [] };
    });
  }

  // ---------------------------------------------------------------------------
  // Persistent project Copilot session: a root lab-chat agent with a scoped,
  // read-only project-context tool. The Client embeds the native DSH
  // Conversation for this session in a large drawer, so history/trajectory/live
  // thinking are native while the agent still has full project visibility.
  // ---------------------------------------------------------------------------
  const copilotHandles = new Map(); // sessionId -> AgentHandle
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

  async function setupCopilot(projectId, agentCtx) {
    await ctx.agentPresets.mount(agentCtx, 'lab-chat');
    agentCtx.tools.register(copilotToolDefinition(projectId));
  }

  async function ensureCopilotSession(projectId) {
    if (copilotLocks.has(projectId)) return copilotLocks.get(projectId);
    const task = (async () => {
      const project = requireProject(projectId);
      // A resumed root agent must be given agentOptions again: agentOptions are
      // resume-time inputs and are not reconstructed from the persisted session.
      const model = resolveModelSelection(ctx, project, null, 'controller');
      const existingId = typeof project.copilotSessionId === 'string' && project.copilotSessionId ? project.copilotSessionId : '';
      if (existingId) {
        const live = copilotHandles.get(existingId) ?? ctx.agents.get(existingId);
        if (live) return { sessionId: existingId, reused: true };
        try {
          const handle = await ctx.agents.resume({
            resumeSessionId: existingId,
            agentOptions: model,
            setup: (agentCtx) => setupCopilot(projectId, agentCtx),
          });
          copilotHandles.set(existingId, handle);
          return { sessionId: existingId, reused: true };
        } catch {
          // Session persistence missing/broken: create a fresh Copilot session below.
        }
      }
      const sessionId = newSessionId();
      const handle = await ctx.agents.create({
        sessionId,
        meta: { cwd: project.repo.path, agentPreset: 'lab-chat' },
        agentOptions: model,
        setup: (agentCtx) => setupCopilot(projectId, agentCtx),
      });
      copilotHandles.set(sessionId, handle);
      await store.withProjectLock(projectId, async () => {
        const current = requireProject(projectId);
        current.copilotSessionId = sessionId;
        current.revision = (current.revision ?? 0) + 1;
        current.updatedAt = Date.now();
        await store.saveProject(current);
      });
      return { sessionId, reused: false };
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
    return {
      projectId,
      sessionId: project.copilotSessionId ?? null,
    };
  }

  async function openCopilot(projectId) {
    const result = await ensureCopilotSession(projectId);
    return { ...result, projectId };
  }

  // Dispose live Copilot agent handles with the plugin fiber.
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const handle of copilotHandles.values()) {
        try {
          handle.dispose?.();
        } catch {
          // best-effort
        }
      }
      copilotHandles.clear();
    }, 'metainfer-research-lab: copilot sessions');
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
    await store.deleteProject(projectId);
    auto?.forget?.(projectId);
    return { deleted: true, projectId, worktreesRemoved, removeWorktrees };
  }

  async function cancelNode(projectId, nodeId) {
    return runtime.cancel(projectId, nodeId);
  }

  async function messageNode(projectId, nodeId, text) {
    return runtime.message(projectId, nodeId, text);
  }

  async function getTranscript(projectId, nodeId, afterSeq) {
    if (!transcript) throw new LabError('unavailable', 'transcript reader is not wired', 503);
    return transcript.read(projectId, nodeId, afterSeq);
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

  async function listRuns(projectId) {
    if (!orchestrator) throw new LabError('unavailable', 'orchestrator is not wired', 503);
    return orchestrator.listRuns(projectId);
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
  async function agentTool(input) {
    const action = input?.action;
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
      return { project: result.project, rootNode: result.rootNode, revision: result.revision };
    }
    if (action === 'state') return getState(input?.projectId);
    if (action === 'update_project') return updateProject(input?.projectId, input ?? {});
    if (action === 'update_node') return updateNode(input?.projectId, input?.nodeId, input ?? {});
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
    if (action === 'delete_project') return deleteProject(input?.projectId, { removeWorktrees: input?.removeWorktrees === true });
    if (action === 'cancel_node') return runtime.cancel(input?.projectId, input?.nodeId);
    if (action === 'message_node') return runtime.message(input?.projectId, input?.nodeId, input?.text);
    if (action === 'transcript') return getTranscript(input?.projectId, input?.nodeId, input?.afterSeq);
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
    if (action === 'runs') return listRuns(input?.projectId);
    if (action === 'run') return getRun(input?.projectId, input?.runId);
    if (action === 'chat') return projectChat(input?.projectId, input?.text);
    if (action === 'clear_chat') return clearProjectChat(input?.projectId);
    if (action === 'copilot') return openCopilot(input?.projectId);
    throw new LabError('unknown_command', `unknown metainfer_lab action: ${String(action)}`, 400);
  }

  async function health() {
    return {
      name: 'metainfer-research-lab',
      version,
      domain: store.domainName,
      storage: 'ready',
      projects: store.listProjects().length,
    };
  }

  return {
    name: 'metainfer-research-lab',
    version,
    domainName: store.domainName,
    health,
    listProjects,
    validateRepo,
    createProject,
    getState,
    getEvents,
    updateProject,
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
    getCluster,
    getClusterConfig,
    updateClusterConfig,
    compilePlacementPolicyForProject,
    deleteProject,
    cancelNode,
    messageNode,
    getTranscript,
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
    getRun,
    agentTool,
  };
}
