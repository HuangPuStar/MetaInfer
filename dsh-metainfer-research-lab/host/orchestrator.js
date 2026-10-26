/**
 * M3 orchestrator: advisor (review board) + scheduler role runs and the manual
 * Step cycle. All LLM calls happen outside project locks; validation and node
 * creation happen inside them.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { LabError } from './git-engine.js';
import { cleanModelRef, validateModelSelection } from './models.js';
import { newSessionId } from './store.js';
import { advisorCandidates, buildAdvisorSnapshot, buildSchedulerSnapshot, promptHash } from './snapshot.js';
import { DEFAULT_ADVISOR_PROMPT, DEFAULT_SCHEDULER_PROMPT } from './prompts.js';

const ROLE_RUN_TIMEOUT_MS = 180_000;

const ADVISOR_SCHEMA = {
  type: 'object',
  properties: {
    analysis: { type: 'string' },
    proposals: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          parentId: { type: 'string' },
          title: { type: 'string' },
          prompt: { type: 'string' },
          needs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string' },
                amount: { type: 'integer' },
              },
              required: ['key', 'amount'],
              additionalProperties: false,
            },
          },
          successCriteria: { type: 'string' },
          timeboxMinutes: { type: 'integer' },
          rationale: { type: 'string' },
          expectedInfoGain: { type: 'string' },
          recommendedModel: {
            type: 'object',
            additionalProperties: false,
            properties: {
              profileId: { type: 'string' },
              provider: { type: 'string' },
              model: { type: 'string' },
              reasoningEffort: { type: 'string' },
              rationale: { type: 'string' },
            },
          },
        },
        required: ['parentId', 'title', 'prompt', 'rationale'],
        additionalProperties: false,
      },
    },
    needUserDecision: { type: 'boolean' },
    note: { type: 'string' },
  },
  required: ['analysis', 'proposals', 'needUserDecision'],
  additionalProperties: false,
};

const SCHEDULER_SCHEMA = {
  type: 'object',
  properties: {
    analysis: { type: 'string' },
    starts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['nodeId', 'reason'],
        additionalProperties: false,
      },
    },
    note: { type: 'string' },
  },
  required: ['analysis', 'starts'],
  additionalProperties: false,
};

function advisorPrompt(project, snapshot, lens) {
  const custom = project.config?.prompts?.advisor;
  return [
    lens ? `Perspective for this review pass (one of several independent reviewers): ${lens}` : '',
    custom && custom.trim() ? custom.trim() : DEFAULT_ADVISOR_PROMPT,
    '',
    '# Rules',
    '1. Only propose successors whose parentId is in candidateParents. A parent must be completed.',
    '2. At most the configured number of proposals; prefer 1, use 2-3 for genuinely different hypotheses.',
    '3. Each proposal prompt must be self-contained: a fresh agent with only the project brief, the',
    '   parent worktree and ancestor summaries must be able to execute it.',
    '4. needs is an array of {key, amount}; keys must be in resources.pools and within the pool size.',
    '5. Do not duplicate an existing node or a recent proposal (recentProposals).',
    '6. A failed node with errorStage=timeout was killed deterministically: you may split the task,',
    '   extend its timebox with a concrete reason, try another approach, or abandon the branch.',
    '7. Return proposals: [] when nothing is worth doing.',
    '8. Submit your entire answer through structured_output.',
    '9. Optional: recommend a model for a proposal via recommendedModel {profileId or provider/model/reasoningEffort, rationale}.',
    '   It is only honored when the project enables advisor model selection and the Host allowlist accepts it.',
    '',
    '# Snapshot',
    JSON.stringify(snapshot, null, 2),
  ].join('\n');
}

function schedulerPrompt(project, snapshot) {
  const custom = project.config?.prompts?.scheduler;
  const clusterSection = snapshot.cluster?.enabled
    ? [
        '# Two-layer authority (multi-machine / cluster mode)',
        '- You are the PROJECT-LEVEL experiment scheduler (an LLM). You only choose which planned node ids',
        '  should be started next and in what priority. You do NOT allocate GPUs and cannot reserve a card.',
        '- The CLUSTER COORDINATOR is a separate deterministic service. It is the final authority for',
        '  whole-GPU admission across all projects/machines: every node with needs.gpu>0 must acquire a',
        '  lease when it starts; if no card is free the node waits in the coordinator queue.',
        `- This DSH instance is machine-affine: it can only use GPUs on machine "${snapshot.cluster.machineId ?? 'unknown'}".`,
        '  You cannot choose a machine; the coordinator either grants a card on this machine or queues the node.',
        '- If resources.cluster.pools.gpu.free is 0, prefer starts: [] (or explicitly accept queueing for a',
        '  high-priority node and say so). Do not assume capacity beyond what resources.cluster reports.',
        '- resources.cluster.project.gpuQuota (if set) is the optional per-project GPU concurrency cap; never',
        '  propose starts that would exceed it.',
        '- If resources.cluster.fleet.enabled is true, a node with needs.machines>1 asks the coordinator for a',
        '  multi-machine whole-GPU lease and the Host runs its GPU workload via SSH/containers on those machines.',
        '  You still only choose node ids; you cannot choose which machines are granted.',
        '- resources.cluster.placementPolicy (if set) is the project\'s natural-language GPU allocation preference,',
        '  already compiled into hard requirements/preferences. If the matching free fleet machines are 0 (see',
        '  resources.cluster.fleetMachines labels/models), prefer starts: [] instead of queueing unnecessarily.',
      ].join('\n')
    : '';
  const base = custom && custom.trim()
    ? custom.trim()
    : DEFAULT_SCHEDULER_PROMPT;
  return [
    base,
    clusterSection,
    '',
    '# Rules',
    '1. Only choose nodeIds from planned.',
    snapshot.cluster?.enabled
      ? '2. Never claim a GPU is reserved: runtime acquires a whole-GPU lease from the coordinator at start; if unavailable the node enters the coordinator queue.'
      : '2. Chosen needs plus resources.held must stay within resources.pools; running + chosen must not exceed maxRunningNodes.',
    '3. Array order is priority. Prefer cheap, high-information nodes that unblock later work.',
    '4. starts: [] is valid when waiting is better.',
    '5. Submit your entire answer through structured_output.',
    '',
    '# Snapshot',
    JSON.stringify(snapshot, null, 2),
  ].filter((line, index, lines) => !(line === '' && lines[index - 1] === '')).join('\n');
}

async function sessionUsage(ctx, sessionId) {
  const totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
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
    // surface unavailable
  }
  if (totals.totalTokens === 0) totals.totalTokens = totals.inputTokens + totals.outputTokens;
  return totals;
}

function mergeAdvisorOutputs(project, outputs) {
  const max = project.config.advisor?.maxProposalsPerPass ?? 3;
  const seen = new Set();
  const proposals = [];
  for (const output of outputs) {
    if (!output || typeof output !== 'object') continue;
    for (const proposal of Array.isArray(output.proposals) ? output.proposals : []) {
      const key = `${proposal?.parentId ?? ''}::${promptHash(proposal?.prompt ?? '')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      proposals.push(proposal);
    }
  }
  return {
    analysis: outputs
      .map((output) => (typeof output?.analysis === 'string' ? output.analysis : ''))
      .filter(Boolean)
      .join('\n\n---\n\n'),
    proposals: proposals.slice(0, max),
    needUserDecision: outputs.some((output) => output?.needUserDecision === true),
    note: outputs
      .map((output) => (typeof output?.note === 'string' ? output.note : ''))
      .filter(Boolean)
      .join(' | '),
    aggregatedFrom: outputs.length,
  };
}

function blocksText(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function runId() {
  return `run-${randomUUID().slice(0, 8)}`;
}

function cycleId() {
  return `cyc-${randomUUID().slice(0, 8)}`;
}

/**
 * @param {{ctx: object, store: object, git: object, runtime: object}} deps
 */
export function createOrchestrator({ ctx, store, git, runtime, cluster }) {
  const controllerHandles = new Map();
  const controllerLocks = new Map();
  const roleActivations = new Map(); // sessionId -> { activation, projectId, record }
  const cycleLocks = new Map(); // projectId -> promise
  const lifetime = new AbortController();

  function roleModel(project, role) {
    const configured = project.config?.models?.[role];
    if (configured && configured.provider && configured.model) {
      return {
        provider: configured.provider,
        model: configured.model,
        ...(configured.reasoningEffort ? { reasoningEffort: configured.reasoningEffort } : {}),
      };
    }
    const current = ctx.agentDefaultModel.currentSelection();
    return {
      provider: current.provider,
      model: current.model,
      ...(current.reasoningEffort ? { reasoningEffort: current.reasoningEffort } : {}),
    };
  }

  function requireProject(projectId) {
    const project = store.getProject(projectId);
    if (!project) throw new LabError('project_not_found', `unknown project: ${projectId}`, 404);
    return project;
  }

  async function persistProject(project) {
    project.updatedAt = Date.now();
    await store.saveProject(project);
  }

  async function persistEvent(project, type, payload = {}) {
    await store.appendEvent(project, type, payload);
    await persistProject(project);
  }

  async function ensureController(project) {
    const existing = ctx.agents.get(project.controllerSessionId);
    if (existing) return existing;
    // Reviewer panels call this concurrently for the same controller session.
    if (controllerLocks.has(project.controllerSessionId)) return controllerLocks.get(project.controllerSessionId);
    const promise = (async () => {
      const setup = async (agentCtx) => {
        await ctx.agentPresets.mount(agentCtx, 'lab-controller');
      };
      const model = roleModel(project, 'controller');
      try {
        const handle = await ctx.agents.resume({ resumeSessionId: project.controllerSessionId, setup });
        controllerHandles.set(project.controllerSessionId, handle);
        return handle.agent;
      } catch {
        const handle = await ctx.agents.create({
          sessionId: project.controllerSessionId,
          meta: { cwd: project.repo.path, origin: 'subagent', agentPreset: 'lab-controller' },
          agentOptions: model,
          setup,
        });
        controllerHandles.set(project.controllerSessionId, handle);
        return handle.agent;
      }
    })();
    controllerLocks.set(project.controllerSessionId, promise);
    try {
      return await promise;
    } finally {
      controllerLocks.delete(project.controllerSessionId);
    }
  }

  async function runRole(project, role, cycle, promptText, schema, inputSnapshot, options = {}) {
    const controller = await ensureController(project);
    const id = runId();
    const sessionId = newSessionId();
    const model = options.modelOverride
      ? { ...options.modelOverride }
      : roleModel(project, role);
    const preset = role === 'advisor' ? 'lab-advisor' : 'lab-scheduler';
    const record = {
      id,
      projectId: project.id,
      cycleId: cycle.id,
      role,
      sessionId,
      model,
      status: 'running',
      inputSnapshot,
      lens: options.lens ?? null,
      startedAt: Date.now(),
    };
    await store.saveRun(project.id, record);
    await persistEvent(project, `${role}/started`, { runId: id, data: { cycleId: cycle.id } });

    let activation;
    let result = null;
    let failure = null;
    try {
      activation = await ctx.subagents.startActivation({
        provider: 'spawn',
        label: `mirl-${role}${options.lens ? `-${options.lens.slice(0, 20)}` : ''}/${project.id}`,
        delivery: 'caller',
        signal: lifetime.signal,
        childId: sessionId,
        request: {
          parent: controller,
          cwd: project.repo.path,
          prompt: [{ type: 'text', text: promptText }],
          agentPreset: preset,
          agentOptions: model,
          outputSchema: schema,
        },
      });
      roleActivations.set(sessionId, { activation, projectId: project.id, record });
      result = await Promise.race([
        activation.result,
        new Promise((_, reject) => {
          const timer = setTimeout(
            () => reject(new LabError('run_timeout', `${role} run exceeded ${ROLE_RUN_TIMEOUT_MS / 1000}s`, 504)),
            ROLE_RUN_TIMEOUT_MS,
          );
          timer.unref?.();
        }),
      ]);
      if (result?.stopReason !== 'completed') {
        failure = new Error(`${role} stopped: ${result?.stopReason}`);
      }
    } catch (error) {
      failure = error;
    } finally {
      roleActivations.delete(sessionId);
      if (activation) {
        try {
          await activation.dispose();
        } catch {
          // already settled
        }
      }
    }

    record.endedAt = Date.now();
    record.usage = await sessionUsage(ctx, sessionId);
    if (failure) {
      record.status = 'failed';
      record.stopReason = 'error';
      record.error = failure instanceof Error ? failure.message : String(failure);
    } else {
      record.status = 'completed';
      record.stopReason = 'completed';
      record.output = result?.structured ?? null;
      if (record.output && typeof record.output.analysis === 'string') record.analysis = record.output.analysis;
      if (!record.output) record.rawText = blocksText(result?.output);
    }
    await store.saveRun(project.id, record);
    await persistEvent(project, `${role}/finished`, {
      runId: id,
      data: { status: record.status, error: record.error ?? null, created: record.createdNodeIds?.length ?? 0 },
    });
    return { record, failure };
  }

  function normalizeNeeds(raw, project) {
    if (raw === undefined || raw === null) return { needs: {}, error: null };
    if (!Array.isArray(raw)) return { needs: {}, error: 'needs must be an array of {key, amount}' };
    const needs = {};
    for (const item of raw) {
      const key = typeof item?.key === 'string' ? item.key.trim() : '';
      const amount = Number(item?.amount);
      if (!key) return { needs: {}, error: 'needs[].key is required' };
      if (!Number.isInteger(amount) || amount < 0) return { needs: {}, error: `needs[${key}] must be a non-negative integer` };
      if (key === 'machines') {
        if (amount < 1 || amount > 8) return { needs: {}, error: 'needs[machines] must be 1..8' };
        needs.machines = amount;
        continue;
      }
      if (!(key in (project.config.resourcePools ?? {}))) return { needs: {}, error: `unknown resource: ${key}` };
      if (amount > (project.config.resourcePools[key] ?? 0)) return { needs: {}, error: `needs ${key}=${amount} exceeds pool` };
      needs[key] = (needs[key] ?? 0) + amount;
    }
    return { needs, error: null };
  }

  function checkProposal(project, proposal, nodes, candidateIds) {
    const parentId = typeof proposal?.parentId === 'string' ? proposal.parentId : '';
    if (!parentId) return { ok: false, reason: 'parentId is required' };
    if (!candidateIds.has(parentId)) return { ok: false, reason: `parentId ${parentId} is not a candidate parent` };
    const parent = nodes.find((node) => node.id === parentId);
    if (!parent || parent.status !== 'completed') return { ok: false, reason: `parent ${parentId} is not completed` };
    if (!parent.git?.headCommit) return { ok: false, reason: `parent ${parentId} has no commit` };
    const title = typeof proposal.title === 'string' ? proposal.title.trim() : '';
    const prompt = typeof proposal.prompt === 'string' ? proposal.prompt.trim() : '';
    if (!title || title.length > 120) return { ok: false, reason: 'title must be 1..120 characters' };
    if (prompt.length < 10 || prompt.length > 8000) return { ok: false, reason: 'prompt must be 10..8000 characters' };
    const { needs, error } = normalizeNeeds(proposal.needs, project);
    if (error) return { ok: false, reason: error };
    const maxMinutes = project.config.maxNodeTimeoutMinutes ?? 240;
    const timeboxMinutes = Number.isInteger(proposal.timeboxMinutes)
      ? proposal.timeboxMinutes
      : project.config.nodeTimeoutMinutes;
    if (!Number.isInteger(timeboxMinutes) || timeboxMinutes < 1 || timeboxMinutes > maxMinutes) {
      return { ok: false, reason: `timeboxMinutes must be 1..${maxMinutes}` };
    }
    const hash = promptHash(prompt);
    if (nodes.some((node) => node.parentId === parentId && promptHash(node.prompt) === hash)) {
      return { ok: false, reason: 'duplicate proposal (same parent and prompt hash)' };
    }
    if (nodes.length >= (project.config.maxNodes ?? 60)) return { ok: false, reason: 'maxNodes reached' };
    return {
      ok: true,
      parent,
      spec: {
        title,
        prompt,
        successCriteria: typeof proposal.successCriteria === 'string' ? proposal.successCriteria.trim() : '',
        needs,
        timeboxMinutes,
        model: null,
      },
    };
  }

  /** Commit the parent's frozen version and tag it once. */
  async function sealParent(project, parent, head) {
    if (parent.timestamps?.sealedAt) return;
    // Branch names and tags share the same dshex/... namespace; suffix the tag so
    // `git merge <branch>` never sees an ambiguous refname.
    const tag = `dshex-sealed/${project.id}/${parent.id}`;
    try {
      await git.tagCommit(project.repo.path, tag, head);
    } catch {
      // Tag failure is recorded by later reconciliation; the node is still sealed.
    }
    parent.timestamps = { ...(parent.timestamps ?? {}), sealedAt: Date.now() };
    await store.saveNode(project.id, parent);
    await persistEvent(project, 'node/sealed', { nodeId: parent.id, data: { tag, headCommit: head } });
  }

  /** Create a `proposed` node (confirm mode): no worktree, parent stays unfrozen. */
  async function createProposed(project, parent, spec, meta) {
    const pending = store.listNodes(project.id).filter((node) => node.status === 'proposed');
    const limit = project.config.advisor?.maxPendingProposals ?? 20;
    if (pending.length >= limit) {
      throw new LabError('max_pending_proposals', `maxPendingProposals=${limit} reached`, 409);
    }
    const now = Date.now();
    const nodeId = `n-${String(project.counters.nextNodeSeq).padStart(4, '0')}`;
    const node = {
      id: nodeId,
      projectId: project.id,
      title: spec.title,
      prompt: spec.prompt,
      successCriteria: spec.successCriteria ?? '',
      status: 'proposed',
      parentId: parent.id,
      createdBy: meta.createdBy,
      createdByRunId: meta.runId ?? null,
      ...(spec.model ? { model: spec.model } : {}),
      needs: spec.needs ?? {},
      timeboxMs: spec.timeboxMinutes * 60_000,
      anchorSessionId: newSessionId(),
      sessionId: newSessionId(),
      deadlineAt: null,
      proposal: {
        runId: meta.runId ?? null,
        rationale: meta.rationale ?? null,
        expectedInfoGain: meta.expectedInfoGain ?? null,
        createdAt: now,
      },
      git: {
        branch: `dshex/${project.id}/${nodeId}`,
        worktreePath: path.join(project.repo.worktreeRoot, nodeId),
        baseCommit: parent.git?.headCommit ?? null,
        headCommit: null,
      },
      timestamps: { createdAt: now, lastActivityAt: null },
    };
    await store.saveNode(project.id, node);
    project.counters.nextNodeSeq = (project.counters.nextNodeSeq ?? 2) + 1;
    project.counters.nodes = (project.counters.nodes ?? 0) + 1;
    await persistEvent(project, 'node/proposed', {
      nodeId,
      data: { title: node.title, parentId: parent.id, createdBy: node.createdBy, timeboxMinutes: spec.timeboxMinutes },
    });
    project.revision = (project.revision ?? 0) + 1;
    project.updatedAt = now;
    await persistProject(project);
    return node;
  }

  /** Create a planned child from a completed parent, commit and seal the parent. */
  async function createChild(project, parent, spec, meta) {
    const now = Date.now();
    let head = parent.git?.headCommit ?? null;
    const commit = await git.commitWorktree(project, parent, `dshex(${parent.id}): ${parent.title} (seal)`);
    head = commit.head;
    parent.git.headCommit = head;

    const nodeId = `n-${String(project.counters.nextNodeSeq).padStart(4, '0')}`;
    const node = {
      id: nodeId,
      projectId: project.id,
      title: spec.title,
      prompt: spec.prompt,
      successCriteria: spec.successCriteria ?? '',
      status: 'planned',
      parentId: parent.id,
      createdBy: meta.createdBy,
      createdByRunId: meta.runId ?? null,
      ...(spec.model ? { model: spec.model } : {}),
      needs: spec.needs ?? {},
      timeboxMs: spec.timeboxMinutes * 60_000,
      anchorSessionId: newSessionId(),
      sessionId: newSessionId(),
      deadlineAt: null,
      git: {
        branch: `dshex/${project.id}/${nodeId}`,
        worktreePath: path.join(project.repo.worktreeRoot, nodeId),
        baseCommit: head,
        headCommit: null,
      },
      timestamps: { createdAt: now, lastActivityAt: null },
    };
    await store.saveNode(project.id, node);
    project.counters.nextNodeSeq = (project.counters.nextNodeSeq ?? 2) + 1;
    project.counters.nodes = (project.counters.nodes ?? 0) + 1;
    await persistEvent(project, 'node/created', {
      nodeId,
      data: {
        title: node.title,
        parentId: parent.id,
        createdBy: node.createdBy,
        baseCommit: head,
        timeboxMinutes: spec.timeboxMinutes,
      },
    });

    await sealParent(project, parent, head);
    project.revision = (project.revision ?? 0) + 1;
    project.updatedAt = now;
    await persistProject(project);
    return node;
  }

  async function applyAdvisorOutput(projectId, cycle, output) {
    const applied = { createdNodeIds: [], rejected: [] };
    if (!output || typeof output !== 'object') {
      applied.rejected.push({ reason: 'advisor run had no structured output' });
      return applied;
    }
    const proposals = Array.isArray(output.proposals) ? output.proposals : [];
    const preProject = requireProject(projectId);
    const advisorModels = new Map();
    if (preProject.config.routing?.advisorMaySelectModels === true) {
      for (let index = 0; index < Math.min(proposals.length, 50); index += 1) {
        const raw = proposals[index]?.recommendedModel;
        if (!raw) continue;
        const candidate = cleanModelRef(raw);
        if (!candidate) {
          advisorModels.set(index, { error: 'recommendedModel must be {profileId} or {provider, model, reasoningEffort?}' });
          continue;
        }
        try {
          const validated = await validateModelSelection(ctx, preProject, candidate);
          advisorModels.set(index, {
            model: {
              ...cleanModelRef(validated),
              source: 'advisor',
              ...(typeof raw.rationale === 'string' && raw.rationale.trim() ? { reason: raw.rationale.trim().slice(0, 500) } : {}),
            },
          });
        } catch (error) {
          advisorModels.set(index, { error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    await store.withProjectLock(projectId, async () => {
      // Candidate parents are frozen for this pass: creating the first child seals
      // the parent, but later proposals from the same advisor answer may still
      // branch from that same (now frozen) parent commit.
      let project = requireProject(projectId);
      const candidateIds = new Set(advisorCandidates(store, project).keys());
      const max = project.config.advisor?.maxProposalsPerPass ?? 3;
      const extra = proposals.slice(max);
      for (const proposal of extra) {
        applied.rejected.push({ parentId: proposal?.parentId ?? null, title: proposal?.title ?? null, reason: `maxProposalsPerPass=${max}` });
      }
      for (const [proposalIndex, proposal] of proposals.slice(0, max).entries()) {
        project = requireProject(projectId);
        const nodes = store.listNodes(projectId);
        const check = checkProposal(project, proposal, nodes, candidateIds);
        const advisorModel = advisorModels.get(proposalIndex);
        if (advisorModel?.error) {
          applied.rejected.push({
            parentId: proposal?.parentId ?? null,
            title: proposal?.title ?? null,
            reason: `recommendedModel rejected: ${advisorModel.error}`,
          });
          continue;
        }
        if (!check.ok) {
          applied.rejected.push({
            parentId: proposal?.parentId ?? null,
            title: proposal?.title ?? null,
            reason: check.reason,
          });
          continue;
        }
        try {
          if (advisorModel?.model) check.spec.model = advisorModel.model;
          const acceptMode = project.config.advisor?.acceptMode ?? 'auto';
          const node = acceptMode === 'confirm'
            ? await createProposed(project, check.parent, check.spec, {
                createdBy: 'advisor',
                runId: cycle.advisorRunId,
                rationale: proposal.rationale,
                expectedInfoGain: proposal.expectedInfoGain,
              })
            : await createChild(project, check.parent, check.spec, {
                createdBy: 'advisor',
                runId: cycle.advisorRunId,
              });
          applied.createdNodeIds.push(node.id);
          const parent = store.getNode(projectId, check.parent.id);
          if (parent) {
            parent.review = {
              reviewedAt: Date.now(),
              reviewedHeadCommit: parent.git?.headCommit ?? null,
              runId: cycle.advisorRunId,
              decision: 'proposed',
            };
            await store.saveNode(projectId, parent);
          }
        } catch (error) {
          applied.rejected.push({
            parentId: proposal?.parentId ?? null,
            title: proposal?.title ?? null,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      // Mark remaining candidate leaves as reviewed without new nodes.
      const reviewedParents = new Set(proposals.map((proposal) => proposal?.parentId));
      project = requireProject(projectId);
      const nodes = store.listNodes(projectId);
      const candidates = advisorCandidates(store, project);
      for (const candidate of candidates.values()) {
        if (candidate.kind !== 'leaf' || reviewedParents.has(candidate.id)) continue;
        const node = store.getNode(projectId, candidate.id);
        if (!node) continue;
        node.review = {
          reviewedAt: Date.now(),
          reviewedHeadCommit: node.git?.headCommit ?? null,
          runId: cycle.advisorRunId,
          decision: 'none',
        };
        await store.saveNode(projectId, node);
      }
    });
    return applied;
  }

  async function applySchedulerOutput(projectId, cycle, output) {
    const applied = { startedNodeIds: [], rejected: [] };
    if (!output || typeof output !== 'object') {
      applied.rejected.push({ reason: 'scheduler run had no structured output' });
      return applied;
    }
    const starts = Array.isArray(output.starts) ? output.starts.slice(0, 20) : [];
    for (const item of starts) {
      const nodeId = typeof item?.nodeId === 'string' ? item.nodeId : '';
      const planned = store.getNode(projectId, nodeId);
      if (!planned || planned.status !== 'planned') {
        applied.rejected.push({ nodeId, reason: 'not a planned node' });
        continue;
      }
      try {
        await runtime.start(projectId, nodeId);
        applied.startedNodeIds.push(nodeId);
      } catch (error) {
        applied.rejected.push({ nodeId, reason: error instanceof Error ? error.message : String(error) });
        if (error instanceof LabError && error.code === 'project_not_found') break;
      }
    }
    return applied;
  }

  async function runCycle(projectId, trigger) {
    let project = requireProject(projectId);
    const cycle = {
      id: cycleId(),
      projectId,
      trigger,
      startedAt: Date.now(),
      createdNodeIds: [],
      startedNodeIds: [],
      skipped: [],
      errors: [],
    };
    await store.saveCycle(projectId, cycle);
    await persistEvent(project, 'cycle/started', { cycleId: cycle.id, data: { trigger } });

    // --- advisor pass -------------------------------------------------------
    project = requireProject(projectId);
    const completed = store.listNodes(projectId).filter((node) => node.status === 'completed');
    const candidateCount = advisorCandidates(store, project).size;
    if (completed.length === 0 || candidateCount === 0) {
      cycle.skipped.push({
        stage: 'advisor',
        reason: completed.length === 0 ? 'no completed nodes to review' : 'no actionable candidate parents',
      });
    } else {
      const snapshot = buildAdvisorSnapshot(store, project);
      const reviewers = Array.isArray(project.config.advisor?.reviewers) ? project.config.advisor.reviewers : [];
      try {
        const runs = reviewers.length > 0
          ? await Promise.all(reviewers.map((reviewer, index) => runRole(
              project,
              'advisor',
              cycle,
              advisorPrompt(project, snapshot, reviewer.lens),
              ADVISOR_SCHEMA,
              snapshot,
              {
                lens: reviewer.lens || `reviewer-${index + 1}`,
                modelOverride: reviewer.provider && reviewer.model
                  ? {
                      provider: reviewer.provider,
                      model: reviewer.model,
                      ...(reviewer.reasoningEffort ? { reasoningEffort: reviewer.reasoningEffort } : {}),
                    }
                  : undefined,
              },
            )))
          : [await runRole(project, 'advisor', cycle, advisorPrompt(project, snapshot), ADVISOR_SCHEMA, snapshot)];
        cycle.advisorRunIds = runs.map((run) => run.record.id);
        cycle.advisorRunId = cycle.advisorRunIds[0] ?? null;
        const successful = runs.filter((run) => !run.failure && run.record.output);
        for (const run of runs) {
          if (run.failure) cycle.errors.push(`advisor${run.record.lens ? `[${run.record.lens}]` : ''}: ${run.record.error}`);
        }
        if (successful.length > 0) {
          const merged = reviewers.length > 0
            ? mergeAdvisorOutputs(project, successful.map((run) => run.record.output))
            : successful[0].record.output;
          const applied = await applyAdvisorOutput(projectId, cycle, merged);
          cycle.createdNodeIds.push(...applied.createdNodeIds);
          successful.forEach((run, index) => {
            run.record.createdNodeIds = index === 0 ? applied.createdNodeIds : [];
            run.record.rejected = index === 0 ? applied.rejected : [];
            run.record.panelSize = runs.length;
          });
          for (const run of runs) await store.saveRun(projectId, run.record);
          if (applied.rejected.length > 0) {
            cycle.skipped.push({ stage: 'advisor', reason: `${applied.rejected.length} proposal(s) rejected` });
          }
        }
      } catch (error) {
        cycle.errors.push(`advisor: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // --- scheduler pass -----------------------------------------------------
    project = requireProject(projectId);
    const planned = store.listNodes(projectId).filter((node) => node.status === 'planned');
    if (planned.length === 0) {
      cycle.skipped.push({ stage: 'scheduler', reason: 'no planned nodes' });
    } else {
      const snapshot = buildSchedulerSnapshot(store, project, cluster);
      try {
        const { record, failure } = await runRole(
          project,
          'scheduler',
          cycle,
          schedulerPrompt(project, snapshot),
          SCHEDULER_SCHEMA,
          snapshot,
        );
        cycle.schedulerRunId = record.id;
        if (failure) {
          cycle.errors.push(`scheduler: ${record.error}`);
        } else {
          const applied = await applySchedulerOutput(projectId, cycle, record.output);
          cycle.startedNodeIds.push(...applied.startedNodeIds);
          record.startedNodeIds = applied.startedNodeIds;
          record.rejected = applied.rejected;
          await store.saveRun(projectId, record);
          if (applied.rejected.length > 0) {
            cycle.skipped.push({ stage: 'scheduler', reason: `${applied.rejected.length} start(s) rejected` });
          }
        }
      } catch (error) {
        cycle.errors.push(`scheduler: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // --- finish -------------------------------------------------------------
    project = requireProject(projectId);
    cycle.endedAt = Date.now();
    await store.saveCycle(projectId, cycle);
    project.counters.cycles = (project.counters.cycles ?? 0) + 1;
    await persistEvent(project, 'cycle/finished', {
      cycleId: cycle.id,
      data: {
        created: cycle.createdNodeIds.length,
        started: cycle.startedNodeIds.length,
        errors: cycle.errors.length,
      },
    });
    return {
      cycle,
      created: cycle.createdNodeIds,
      started: cycle.startedNodeIds,
      skipped: cycle.skipped,
      errors: cycle.errors,
    };
  }

  async function step(projectId, trigger = 'manual') {
    if (cycleLocks.has(projectId)) {
      throw new LabError('cycle_busy', 'a cycle is already running for this project', 409);
    }
    const task = (async () => {
      try {
        return await runCycle(projectId, trigger);
      } finally {
        cycleLocks.delete(projectId);
      }
    })();
    cycleLocks.set(projectId, task);
    return task;
  }

  async function createSuccessor(projectId, parentId, input) {
    let validatedModel = null;
    if (input?.model !== undefined) {
      const candidate = cleanModelRef(input.model);
      if (!candidate) throw new LabError('bad_request', 'model must be {profileId} or {provider, model, reasoningEffort?}', 400);
      validatedModel = await validateModelSelection(ctx, requireProject(projectId), candidate);
    }
    return store.withProjectLock(projectId, async () => {
      const project = requireProject(projectId);
      const parent = store.getNode(projectId, parentId);
      if (!parent) throw new LabError('node_not_found', `unknown node: ${parentId}`, 404);
      if (parent.status !== 'completed') {
        throw new LabError('node_not_sealed_source', `node ${parentId} is ${parent.status}; only completed nodes can get successors`, 409);
      }
      const title = typeof input?.title === 'string' ? input.title.trim() : '';
      const prompt = typeof input?.prompt === 'string' ? input.prompt.trim() : '';
      if (!title || title.length > 120) throw new LabError('bad_request', 'title must be 1..120 characters', 400);
      if (prompt.length < 10 || prompt.length > 8000) throw new LabError('bad_request', 'prompt must be 10..8000 characters', 400);
      const { needs, error } = normalizeNeeds(input?.needs, project);
      if (error) throw new LabError('bad_request', error, 400);
      const maxMinutes = project.config.maxNodeTimeoutMinutes ?? 240;
      const timeboxMinutes = Number.isInteger(input?.timeboxMinutes)
        ? input.timeboxMinutes
        : project.config.nodeTimeoutMinutes;
      if (!Number.isInteger(timeboxMinutes) || timeboxMinutes < 1 || timeboxMinutes > maxMinutes) {
        throw new LabError('bad_request', `timeboxMinutes must be 1..${maxMinutes}`, 400);
      }
      const nodes = store.listNodes(projectId);
      if (nodes.length >= (project.config.maxNodes ?? 60)) {
        throw new LabError('max_nodes', 'maxNodes reached for this project', 409);
      }
      const node = await createChild(project, parent, {
        title,
        prompt,
        successCriteria: typeof input?.successCriteria === 'string' ? input.successCriteria.trim() : '',
        needs,
        timeboxMinutes,
        model: validatedModel
          ? { ...cleanModelRef(validatedModel), source: 'user' }
          : null,
      }, { createdBy: 'user' });
      return { node, revision: project.revision };
    });
  }

  async function approveProposal(projectId, nodeId) {
    return store.withProjectLock(projectId, async () => {
      const project = requireProject(projectId);
      const node = store.getNode(projectId, nodeId);
      if (!node) throw new LabError('node_not_found', `unknown node: ${nodeId}`, 404);
      if (node.status !== 'proposed') {
        throw new LabError('node_not_proposed', `node ${nodeId} is ${node.status}, expected proposed`, 409);
      }
      const parent = store.getNode(projectId, node.parentId);
      if (!parent) throw new LabError('parent_not_found', `unknown parent: ${node.parentId}`, 409);
      if (parent.status !== 'completed') {
        throw new LabError('parent_not_ready', `parent ${parent.id} is ${parent.status}; try again later`, 409);
      }
      const commit = await git.commitWorktree(project, parent, `dshex(${parent.id}): ${parent.title} (approve)`);
      parent.git.headCommit = commit.head;
      await store.saveNode(projectId, parent);
      await sealParent(project, parent, commit.head);
      node.git.baseCommit = commit.head;
      node.status = 'planned';
      node.approvedAt = Date.now();
      delete node.proposal;
      await store.saveNode(projectId, node);
      project.revision = (project.revision ?? 0) + 1;
      await persistEvent(project, 'node/approved', { nodeId, data: { parentId: parent.id, headCommit: commit.head } });
      return { node: store.getNode(projectId, nodeId), revision: project.revision };
    });
  }

  async function rejectProposal(projectId, nodeId) {
    return store.withProjectLock(projectId, async () => {
      const project = requireProject(projectId);
      const node = store.getNode(projectId, nodeId);
      if (!node) throw new LabError('node_not_found', `unknown node: ${nodeId}`, 404);
      if (node.status !== 'proposed') {
        throw new LabError('node_not_proposed', `node ${nodeId} is ${node.status}, expected proposed`, 409);
      }
      await store.deleteNode(projectId, nodeId);
      project.counters.nodes = Math.max(0, (project.counters.nodes ?? 1) - 1);
      const parent = store.getNode(projectId, node.parentId);
      if (parent && store.listNodes(projectId).every((candidate) => candidate.parentId !== parent.id)) {
        // The parent stays an actionable leaf again, so the advisor may re-propose later.
        delete parent.review;
        await store.saveNode(projectId, parent);
      }
      project.revision = (project.revision ?? 0) + 1;
      await persistEvent(project, 'node/rejected', { nodeId, data: { parentId: node.parentId } });
      return { nodeId, revision: project.revision };
    });
  }

  /** Create a multi-parent merge node and freeze/seal every parent commit. */
  async function createMergeNode(projectId, input) {
    let validatedModel = null;
    if (input?.model !== undefined) {
      const candidate = cleanModelRef(input.model);
      if (!candidate) throw new LabError('bad_request', 'model must be {profileId} or {provider, model, reasoningEffort?}', 400);
      validatedModel = await validateModelSelection(ctx, requireProject(projectId), candidate);
    }
    return store.withProjectLock(projectId, async () => {
      const project = requireProject(projectId);
      const ids = Array.isArray(input?.parentIds)
        ? [...new Set(input.parentIds.filter((id) => typeof id === 'string'))]
        : [];
      if (ids.length < 2 || ids.length > 4) {
        throw new LabError('bad_request', 'parentIds must contain 2..4 unique node ids', 400);
      }
      const nodes = store.listNodes(projectId);
      const parents = ids.map((id) => nodes.find((node) => node.id === id));
      if (parents.some((parent) => !parent)) {
        throw new LabError('node_not_found', 'one or more merge parents do not exist', 404);
      }
      if (parents.some((parent) => parent.status !== 'completed')) {
        throw new LabError('merge_parent_not_ready', 'all merge parents must be completed', 409);
      }
      if (parents.some((parent) => !parent.git?.headCommit)) {
        throw new LabError('merge_parent_not_ready', 'all merge parents must have a commit', 409);
      }
      if (nodes.length >= (project.config.maxNodes ?? 60)) {
        throw new LabError('max_nodes', 'maxNodes reached for this project', 409);
      }
      const title = typeof input?.title === 'string' && input.title.trim()
        ? input.title.trim()
        : `Merge: ${parents.map((parent) => parent.title).join(' ⊕ ')}`.slice(0, 120);
      if (title.length > 120) throw new LabError('bad_request', 'title must be 1..120 characters', 400);
      const maxMinutes = project.config.maxNodeTimeoutMinutes ?? 240;
      const timeboxMinutes = Number.isInteger(input?.timeboxMinutes)
        ? input.timeboxMinutes
        : project.config.nodeTimeoutMinutes;
      if (!Number.isInteger(timeboxMinutes) || timeboxMinutes < 1 || timeboxMinutes > maxMinutes) {
        throw new LabError('bad_request', `timeboxMinutes must be 1..${maxMinutes}`, 400);
      }
      // Freeze each parent at its committed HEAD first.
      for (const parent of parents) {
        const commit = await git.commitWorktree(project, parent, `dshex(${parent.id}): ${parent.title} (merge freeze)`);
        parent.git.headCommit = commit.head;
        await store.saveNode(projectId, parent);
      }
      const primary = parents[0];
      const nodeId = `n-${String(project.counters.nextNodeSeq).padStart(4, '0')}`;
      const prompt = typeof input?.prompt === 'string' && input.prompt.trim().length >= 10
        ? input.prompt.trim()
        : [
            `Merge the evidence of these parent experiments into one node: ${ids.join(', ')}.`,
            'Resolve any conflicts, keep the strongest evidence from each branch, and produce a short',
            'merged report plus any reusable notes or artifacts. Do not modify unrelated code.',
          ].join('\n');
      const node = {
        id: nodeId,
        projectId,
        title,
        prompt,
        successCriteria: typeof input?.successCriteria === 'string' ? input.successCriteria.trim() : '',
        status: 'planned',
        kind: 'merge',
        parentId: primary.id,
        parentIds: ids,
        createdBy: 'user',
        createdByRunId: null,
        ...(validatedModel ? { model: { ...cleanModelRef(validatedModel), source: 'user' } } : {}),
        needs: {},
        timeboxMs: timeboxMinutes * 60_000,
        anchorSessionId: newSessionId(),
        sessionId: newSessionId(),
        deadlineAt: null,
        merge: {
          primaryParentId: primary.id,
          parentIds: ids,
          state: 'pending',
          conflictFiles: [],
        },
        git: {
          branch: `dshex/${projectId}/${nodeId}`,
          worktreePath: path.join(project.repo.worktreeRoot, nodeId),
          baseCommit: primary.git.headCommit,
          headCommit: null,
        },
        timestamps: { createdAt: Date.now(), lastActivityAt: null },
      };
      await store.saveNode(projectId, node);
      project.counters.nextNodeSeq = (project.counters.nextNodeSeq ?? 2) + 1;
      project.counters.nodes = (project.counters.nodes ?? 0) + 1;
      await persistEvent(project, 'node/created', {
        nodeId,
        data: { title: node.title, parentId: primary.id, parentIds: ids, kind: 'merge', timeboxMinutes },
      });
      for (const parent of parents) {
        await sealParent(project, parent, parent.git.headCommit);
      }
      project.revision = (project.revision ?? 0) + 1;
      await persistProject(project);
      return { node: store.getNode(projectId, nodeId), revision: project.revision };
    });
  }

  function listRuns(projectId) {
    requireProject(projectId);
    return {
      runs: store.listRuns(projectId, 50),
      cycles: store.listCycles(projectId, 50),
    };
  }

  function getRun(projectId, runIdValue) {
    requireProject(projectId);
    const run = store.getRun(projectId, runIdValue);
    if (!run) throw new LabError('run_not_found', `unknown run: ${runIdValue}`, 404);
    return { run };
  }

  /**
   * Cancel in-flight advisor/scheduler activations for one project (used when
   * auto mode is stopped, so the UI does not show a fake running expert run).
   */
  async function cancelProjectRuns(projectId) {
    const cancelled = [];
    for (const [sessionId, entry] of [...roleActivations.entries()]) {
      if (entry.projectId !== projectId) continue;
      cancelled.push(sessionId);
      try {
        await entry.activation.dispose();
      } catch {
        // best-effort; mark the run below regardless
      }
      try {
        const record = store.getRun(projectId, entry.record.id) ?? entry.record;
        if (record.status === 'running') {
          record.status = 'failed';
          record.stopReason = 'cancelled';
          record.endedAt = Date.now();
          record.error = 'cancelled because auto mode was stopped';
          await store.saveRun(projectId, record);
        }
      } catch {
        // run record best-effort
      }
      roleActivations.delete(sessionId);
    }
    return { cancelled: cancelled.length };
  }

  function dispose() {
    lifetime.abort();
    for (const entry of roleActivations.values()) {
      try {
        entry.activation?.dispose?.();
      } catch {
        // ignore
      }
    }
    roleActivations.clear();
    for (const handle of controllerHandles.values()) {
      try {
        handle.dispose?.();
      } catch {
        // ignore
      }
    }
    controllerHandles.clear();
    controllerLocks.clear();
    cycleLocks.clear();
  }

  return {
    step,
    createSuccessor,
    createMergeNode,
    approveProposal,
    rejectProposal,
    listRuns,
    getRun,
    ensureController,
    cancelProjectRuns,
    dispose,
  };
}

export { ADVISOR_SCHEMA, SCHEDULER_SCHEMA, advisorPrompt, schedulerPrompt };
