/**
 * Model routing (M5): per-node model + reasoning effort with project-level
 * defaults, allowlists, catalog validation and simple cost accounting.
 *
 * Resolution order: node.model > project.models.roles[role] > project.models.default
 * > ctx.agentDefaultModel.currentSelection().
 */
import { LabError } from './git-engine.js';

const CAPABILITY_TTL_MS = 60_000;
const capabilityCache = new Map(); // `${provider}\u0000${model}` -> {at, info, error}
const providerCatalogCache = { at: 0, value: [] };

function trimString(value, max = 200) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Return a plain ModelRef if it carries provider/model/profileId/effort, else null. */
export function cleanModelRef(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null;
  const profileId = trimString(ref.profileId, 120);
  const provider = trimString(ref.provider, 120);
  const model = trimString(ref.model, 200);
  const reasoningEffort = trimString(ref.reasoningEffort, 60);
  const source = ['user', 'advisor', 'escalation', 'project-role', 'project-default', 'default'].includes(ref.source)
    ? ref.source
    : undefined;
  const reason = typeof ref.reason === 'string' ? ref.reason.trim().slice(0, 500) : undefined;
  if (!profileId && !provider && !model) return null;
  return {
    ...(profileId ? { profileId } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(source ? { source } : {}),
    ...(reason ? { reason } : {}),
  };
}

export function modelRefLabel(ref) {
  if (!ref) return 'default';
  const providerPart = ref.provider ? `${ref.provider}/` : '';
  const modelPart = ref.model || (ref.profileId ? `@${ref.profileId}` : 'inherit');
  return `${providerPart}${modelPart}${ref.reasoningEffort ? ` · ${ref.reasoningEffort}` : ''}`;
}

export function findModelOption(project, ref) {
  if (!ref) return null;
  const options = project?.config?.modelOptions ?? [];
  if (ref.profileId) {
    const byId = options.find((option) => option.id === ref.profileId);
    if (byId) return byId;
  }
  if (ref.provider && ref.model) {
    return options.find(
      (option) =>
        option.provider === ref.provider &&
        option.model === ref.model &&
        (ref.reasoningEffort ? option.reasoningEffort === ref.reasoningEffort : true),
    ) ?? null;
  }
  return null;
}

function optionAsRef(option) {
  return {
    profileId: option.id,
    provider: option.provider,
    model: option.model,
    ...(option.reasoningEffort ? { reasoningEffort: option.reasoningEffort } : {}),
  };
}

function roleRef(project, role) {
  const models = project?.config?.models ?? {};
  return cleanModelRef(models.roles?.[role] ?? models[role]);
}

function expandRef(project, ref) {
  if (!ref) return null;
  let merged = { ...ref };
  if (ref.profileId) {
    const option = findModelOption(project, ref);
    if (!option) {
      throw new LabError('model_profile_unknown', `unknown model profile: ${ref.profileId}`, 400);
    }
    merged = { ...optionAsRef(option), ...ref, profileId: option.id };
  }
  return merged;
}

function defaultSelection(ctx) {
  const selection = ctx.agentDefaultModel?.currentSelection?.() ?? {};
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
    source: 'default',
  };
}

/**
 * Resolve the effective (unvalidated) model selection for a node/role.
 * @param {object} ctx Cordis context (agentDefaultModel/llm may be absent in tests).
 * @param {object} project project record.
 * @param {object|null} node node record (merge/worker role).
 * @param {string} role worker|merge|advisor|scheduler|controller|gc.
 */
export function resolveModelSelection(ctx, project, node, role) {
  const fallback = defaultSelection(ctx);
  const nodeRef = node ? cleanModelRef(node.model) : null;
  let ref = null;
  let source = 'default';
  if (nodeRef) {
    ref = expandRef(project, nodeRef);
    source = nodeRef.source ?? 'user';
  } else {
    const mergeRef = roleRef(project, 'merge');
    const roleCandidate = role === 'merge'
      ? (mergeRef ?? roleRef(project, 'worker'))
      : roleRef(project, role);
    const roleSource = role === 'merge' && !mergeRef ? 'worker' : 'project-role';
    if (roleCandidate) {
      ref = expandRef(project, roleCandidate);
      source = roleSource;
    } else {
      const defaultRef = cleanModelRef(project?.config?.models?.default ?? project?.config?.models?.roles?.default);
      if (defaultRef) {
        ref = expandRef(project, defaultRef);
        source = 'project-default';
      }
    }
  }
  const selection = {
    provider: ref?.provider ?? fallback.provider,
    model: ref?.model ?? fallback.model,
  };
  const effort = ref?.reasoningEffort ?? fallback.reasoningEffort;
  if (effort) selection.reasoningEffort = effort;
  if (ref?.profileId) selection.profileId = ref.profileId;
  selection.source = source;
  if (nodeRef?.reason) selection.reason = nodeRef.reason;
  return selection;
}

export function isModelInAllowlist(project, selection) {
  const allowed = project?.config?.models?.allowed;
  if (!Array.isArray(allowed) || allowed.length === 0) return true;
  return allowed.some((entry) => {
    if (entry === '*') return true;
    if (entry === selection.profileId) return true;
    return entry === `${selection.provider}/${selection.model}` || entry === `${selection.provider}:${selection.model}`;
  });
}

async function resolveCapabilities(ctx, provider, model) {
  const llm = ctx.llm;
  if (!llm) return { available: false, reason: 'llm-unavailable' };
  const key = `${provider}\u0000${model}`;
  const cached = capabilityCache.get(key);
  if (cached && Date.now() - cached.at < CAPABILITY_TTL_MS) return cached.value;
  let value;
  try {
    const providers = typeof llm.listProviders === 'function' ? llm.listProviders() : null;
    if (providers && !providers.some((entry) => entry.id === provider || entry.name === provider)) {
      value = { available: false, reason: 'provider-unregistered' };
    } else {
      // LlmRuntime exposes resolveModelInfo; adapters may override resolveModel.
      const resolver = typeof llm.resolveModelInfo === 'function'
        ? llm.resolveModelInfo.bind(llm)
        : (typeof llm.resolveModel === 'function' ? llm.resolveModel.bind(llm) : null);
      if (!resolver) {
        value = { available: true, reason: 'capability-unavailable' };
      } else {
        const info = await resolver(provider, model);
        value = {
          available: true,
          contextWindow: info?.context?.contextWindow,
          efforts: info?.reasoning?.efforts?.map((effort) => effort.id) ?? [],
          defaultEffort: info?.reasoning?.defaultEffort,
          name: info?.name,
        };
      }
    }
  } catch (error) {
    value = {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  capabilityCache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * Async validation: provider registered, model resolvable, effort supported,
 * and project allowlist respected. Throws actionable LabError on failure.
 */
export async function validateModelSelection(ctx, project, selection) {
  let effective = selection;
  if (selection?.profileId && (!selection.provider || !selection.model)) {
    const option = findModelOption(project, selection);
    if (!option) {
      throw new LabError('model_profile_unknown', `unknown model profile: ${selection.profileId}`, 400);
    }
    effective = { ...optionAsRef(option), ...selection, profileId: option.id };
  }
  if (!effective?.provider || !effective.model) {
    throw new LabError('model_unresolved', 'provider and model are required (or a known profileId)', 400);
  }
  if (!isModelInAllowlist(project, effective)) {
    throw new LabError(
      'model_not_allowed',
      `model ${effective.provider}/${effective.model} is not in this project's allowlist`,
      400,
    );
  }
  const capabilities = await resolveCapabilities(ctx, effective.provider, effective.model);
  if (!capabilities.available) {
    if (capabilities.reason === 'llm-unavailable') return { ...effective, capabilities };
    throw new LabError(
      'model_unavailable',
      `model ${effective.provider}/${effective.model} is unavailable: ${capabilities.reason}`,
      400,
    );
  }
  if (effective.reasoningEffort) {
    if (Array.isArray(capabilities.efforts) && capabilities.efforts.length > 0) {
      if (!capabilities.efforts.includes(effective.reasoningEffort)) {
        throw new LabError(
          'model_effort_unsupported',
          `reasoningEffort "${effective.reasoningEffort}" is not supported by ${effective.provider}/${effective.model}; allowed: ${capabilities.efforts.join(', ')}`,
          400,
        );
      }
    }
  }
  return { ...effective, capabilities };
}

export function effortChoices(project, modelRef) {
  const option = findModelOption(project, modelRef);
  return option?.reasoningEffort ? [option.reasoningEffort] : [];
}

/**
 * Build the GET /models payload for one project: configured options, role
 * defaults, routing flags and (when ctx.llm is available) live availability.
 */
async function providerCatalog(ctx) {
  const llm = ctx.llm;
  if (!llm || typeof llm.listProviders !== 'function') return [];
  if (Date.now() - providerCatalogCache.at < CAPABILITY_TTL_MS) return providerCatalogCache.value;
  let value = [];
  try {
    const providers = llm.listProviders();
    value = await Promise.all(providers.map(async (provider) => {
      let models = [];
      try {
        models = typeof llm.listModels === 'function'
          ? (await llm.listModels(provider.name)).map((model) => ({ id: model.id, name: model.name ?? model.id }))
          : [];
      } catch {
        models = [];
      }
      return { id: provider.id, name: provider.name, models };
    }));
  } catch {
    value = [];
  }
  providerCatalogCache.at = Date.now();
  providerCatalogCache.value = value;
  return value;
}

export async function buildModelCatalog(ctx, project) {
  const options = [];
  for (const option of project?.config?.modelOptions ?? []) {
    const selection = { provider: option.provider, model: option.model, profileId: option.id };
    if (option.reasoningEffort) selection.reasoningEffort = option.reasoningEffort;
    let availability = { available: null, reason: null };
    try {
      const checked = await validateModelSelection(ctx, project, selection);
      availability = {
        available: checked.capabilities.available,
        reason: checked.capabilities.available ? null : checked.capabilities.reason ?? null,
        efforts: checked.capabilities.efforts ?? [],
        defaultEffort: checked.capabilities.defaultEffort ?? null,
        contextWindow: checked.capabilities.contextWindow ?? null,
      };
    } catch (error) {
      availability = { available: false, reason: error instanceof Error ? error.message : String(error) };
    }
    options.push({
      id: option.id,
      provider: option.provider,
      model: option.model,
      reasoningEffort: option.reasoningEffort ?? null,
      tags: option.tags ?? [],
      pricePerMTokIn: option.pricePerMTokIn ?? 0,
      pricePerMTokOut: option.pricePerMTokOut ?? 0,
      ...availability,
    });
  }
  const roles = {};
  for (const role of ['worker', 'advisor', 'scheduler', 'controller', 'merge', 'gc']) {
    const selection = resolveModelSelection(ctx, project, null, role);
    roles[role] = selection;
  }
  return {
    projectId: project.id,
    options,
    providers: await providerCatalog(ctx),
    roles,
    default: resolveModelSelection(ctx, project, null, 'worker'),
    routing: {
      advisorMaySelectModels: project.config.routing?.advisorMaySelectModels === true,
      autoUpgrade: project.config.routing?.autoUpgrade === true,
      maxAttempts: project.config.routing?.maxAttempts ?? 2,
    },
    allowlist: project.config.models?.allowed ?? [],
  };
}

/** Cost in USD for one usage record under the selected model option (0 when unpriced). */
export function costOfUsage(project, selectionOrModel, usage) {
  const usageValue = usage ?? {};
  const ref = selectionOrModel ?? {};
  const option = findModelOption(project, ref);
  const inPrice = option?.pricePerMTokIn ?? 0;
  const outPrice = option?.pricePerMTokOut ?? 0;
  if (!option || (inPrice === 0 && outPrice === 0)) return { usd: 0, priced: false };
  const cacheRead = usageValue.cacheReadTokens ?? 0;
  const cachedInput = (usageValue.inputTokens ?? 0);
  const usd =
    ((cachedInput + cacheRead * 0.1) * inPrice) / 1_000_000 +
    ((usageValue.outputTokens ?? 0) * outPrice) / 1_000_000;
  return { usd: Math.round(usd * 1e6) / 1e6, priced: true };
}

/** Next more expensive configured model profile, for manual/automatic upgrades. */
export function nextTierSelection(project, currentNodeModel) {
  const options = (project?.config?.modelOptions ?? []).filter(
    (option) => (option.pricePerMTokIn ?? 0) + (option.pricePerMTokOut ?? 0) > 0,
  );
  if (options.length === 0) return null;
  const current = findModelOption(project, currentNodeModel ?? {});
  const priceOf = (option) => (option.pricePerMTokIn ?? 0) + (option.pricePerMTokOut ?? 0);
  const currentPrice = current ? priceOf(current) : 0;
  const sorted = [...options].sort((a, b) => priceOf(a) - priceOf(b));
  const next = sorted.find((option) => priceOf(option) > currentPrice && option.id !== current?.id);
  return next ? { ...optionAsRef(next), source: 'escalation' } : null;
}
