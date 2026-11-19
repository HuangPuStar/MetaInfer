/**
 * Expert activation (P4 wiring).
 *
 * Until now the hired roster was bookkeeping only: `host/experts/registry.js`
 * described experts, `triggers.js` knew the trigger codes, but nothing in the
 * runtime ever woke an expert up, so `expert_list` always showed `runs: 0`.
 * This module is the missing selector + prompt builder; the orchestrator drives
 * the actual activation through `runRole`.
 *
 * Contract kept deliberately narrow:
 *  - an expert only ever *proposes*; the Host validates and materialises nodes,
 *  - reviewer-template experts produce a verdict that is recorded, never applied,
 *  - activation is capped per cycle so a wide roster cannot fan out the DAG.
 */

import { getExpertDescriptor } from './registry.js';

/** Hard cap of experts woken per planning cycle. */
export const EXPERT_ACTIVATION_CAP = 2;

const PROPOSAL_SCHEMA = {
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
              properties: { key: { type: 'string' }, amount: { type: 'integer' } },
              required: ['key', 'amount'],
              additionalProperties: false,
            },
          },
          successCriteria: { type: 'string' },
          timeboxMinutes: { type: 'integer' },
          rationale: { type: 'string' },
          expectedInfoGain: { type: 'string' },
          falsification: { type: 'string' },
        },
        required: ['title', 'prompt', 'rationale'],
        additionalProperties: false,
      },
    },
  },
  required: ['proposals'],
  additionalProperties: false,
};

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['accept', 'reject', 'insufficient'] },
    reason: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    pruneSuggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { nodeId: { type: 'string' }, action: { type: 'string' }, reason: { type: 'string' } },
        required: ['nodeId', 'action', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdict'],
  additionalProperties: false,
};

/** The output contract an expert's template implies. */
export function expertSchemaFor(template) {
  return template === 'reviewer' || template === 'curator' ? REVIEW_SCHEMA : PROPOSAL_SCHEMA;
}

/** True when the expert's answer carries successor proposals rather than a verdict. */
export function expertProposes(template) {
  return !(template === 'reviewer' || template === 'curator');
}

/**
 * Merge the hired roster with its descriptor (custom experts live in project
 * config, catalog experts come from the registry).
 * @param {object} project
 */
export function resolveRoster(project) {
  const hired = Array.isArray(project?.config?.experts) ? project.config.experts : [];
  const custom = Array.isArray(project?.config?.customExperts) ? project.config.customExperts : [];
  const roster = [];
  for (const row of hired) {
    if (!row || row.status !== 'active') continue;
    const id = typeof row.expertId === 'string' && row.expertId ? row.expertId : (typeof row.id === 'string' ? row.id : '');
    if (!id) continue;
    const descriptor = custom.find((entry) => entry?.id === id) ?? getExpertDescriptor(id);
    if (!descriptor) continue;
    const model = row.model
      ? { provider: row.provider ?? descriptor.model?.provider ?? 'deepseek', model: row.model }
      : descriptor.model ?? null;
    roster.push({ ...descriptor, id, model, roster: row });
  }
  return roster;
}

/**
 * Trigger codes that fired for this cycle, derived from DAG shape.
 * Deterministic and cheap: no model call decides whether a trigger fired.
 * @param {{project: object, nodes: object[], cycle: object}} input
 */
export function firedTriggers({ project, nodes, cycle }) {
  const fired = new Set();
  const parentIds = new Set();
  for (const node of nodes) {
    const ids = Array.isArray(node.parentIds) && node.parentIds.length > 0 ? node.parentIds : (node.parentId ? [node.parentId] : []);
    for (const id of ids) parentIds.add(id);
  }
  const completed = nodes
    .filter((node) => node.status === 'completed')
    .sort((a, b) => (Number(b.timestamps?.completedAt ?? b.timestamps?.lastActivityAt ?? 0))
      - (Number(a.timestamps?.completedAt ?? a.timestamps?.lastActivityAt ?? 0)));
  const leaves = completed.filter((node) => !parentIds.has(node.id));
  // Reviewers judge finished work even when every branch already has a child;
  // only proposers need an attachable leaf.
  if (completed.length > 0) fired.add('node.completed');
  const inFlight = nodes.filter((node) => node.status === 'running' || node.status === 'planned').length;
  if (inFlight < 2) fired.add('low_water');
  if (leaves.some((node) => (node.review?.reviewedHeadCommit ?? null) !== (node.git?.headCommit ?? null))) {
    fired.add('review.requested');
  }
  void project;
  void cycle;
  return { fired, leaves, recent: completed.slice(0, 6) };
}

/**
 * Pick the experts to wake: trigger match, recent-run cooldown, hourly token
 * budget, then at most `cap` of them ordered by level then id (stable).
 * @param {{roster: object[], fired: Set<string>, runs: object[], now?: number, cap?: number}} input
 */
export function selectActivations({ roster, fired, runs = [], leaves = [], now = Date.now(), cap = EXPERT_ACTIVATION_CAP }) {
  const cooldownMs = 5 * 60_000;
  const hourAgo = now - 60 * 60_000;
  const picked = [];
  for (const expert of roster) {
    const triggers = Array.isArray(expert.triggers) ? expert.triggers : [];
    if (!triggers.some((trigger) => fired.has(trigger))) continue;
    // A proposer with nowhere to attach would only burn an activation.
    if (expertProposes(expert.template) && leaves.length === 0) continue;
    const mine = runs.filter((run) => run.expertId === expert.id);
    const recent = mine.filter((run) => Number(run.startedAt ?? 0) > now - cooldownMs);
    if (recent.length > 0) continue;
    const tokensPerHour = Number(expert.budget?.tokensPerHour ?? 0);
    if (tokensPerHour > 0) {
      const spent = mine
        .filter((run) => Number(run.startedAt ?? 0) > hourAgo)
        .reduce((sum, run) => sum + Number(run.usage?.totalTokens ?? 0), 0);
      if (spent >= tokensPerHour) continue;
    }
    const levelRank = { chief: 0, lead: 1, branch: 2 }[String(expert.level ?? 'branch')] ?? 3;
    picked.push({ expert, rank: levelRank });
  }
  return picked
    .sort((a, b) => (a.rank - b.rank) || String(a.expert.id).localeCompare(String(b.expert.id)))
    .slice(0, cap)
    .map((entry) => entry.expert);
}

const clip = (text, max) => {
  const value = typeof text === 'string' ? text : '';
  return value.length > max ? `${value.slice(0, max)}…` : value;
};

/**
 * Self-contained prompt: a fresh agent sees only the project brief, its persona
 * and this text, so the focus set and the rules must be repeated here.
 * @param {{project: object, expert: object, leaves: object[], fired: Set<string>, maxProposals: number}} input
 */
export function buildExpertPrompt({ project, expert, leaves, fired, maxProposals = 2 }) {
  const focus = leaves.slice(-6).map((node) => ({
    id: node.id,
    title: clip(node.title, 120),
    headCommit: node.git?.headCommit ?? null,
    report: clip(node.report?.summary ?? node.reportText ?? '', 700),
    metrics: node.report?.metrics ?? null,
  }));
  const proposes = expertProposes(expert.template);
  const lines = [
    `You are the ${expert.name ?? expert.id} of MetaInfer Research Lab.`,
    '',
    '# Your standing brief (project persona)',
    String(expert.persona ?? '').trim() || 'You judge this experiment and state the next best move.',
    '',
    '# Project',
    `Name: ${project.name}`,
    `Brief: ${clip(project.brief, 1200)}`,
    `Pool: ${JSON.stringify(project.config?.resourcePools ?? {})}`,
    '',
    `# Fired triggers: ${[...fired].join(', ')}`,
    '',
    '# Completed leaves you may branch from',
    focus.length === 0 ? '(none)' : JSON.stringify(focus, null, 2),
    '',
    '# Rules',
    proposes
      ? [
        `1. Propose at most ${maxProposals} successors. Each must be ONE falsifiable experiment, not a batch.`,
        '2. parentId must be one of the completed leaf ids above.',
        '3. The prompt must be self-contained: a fresh worker sees only that text plus the project brief.',
        '4. Every proposal needs an explicit falsification condition (what result kills the branch).',
        '5. Never repeat work already reported by a leaf: read its report/metrics first.',
        '6. needs must stay within the pool above; a single GPU experiment needs gpu=1.',
        '7. Return proposals: [] when nothing is worth doing.',
      ].join('\n')
      : [
        '1. Judge the completed work against its own stated criteria: was it falsifiable, same-protocol, statistically meaningful?',
        '2. verdict=accept only with reproducible numbers (median/P90, exclusive card, fp64 check).',
        '3. pruneSuggestions: name a node id and why its branch should be closed or deferred.',
        '4. Never propose new experiments; other experts do that.',
      ].join('\n'),
    '',
    '# Output',
    `Submit your entire answer through structured_output using the ${proposes ? 'proposal' : 'review'} schema.`,
    'Keep it compact: analysis <= 800 characters, no prose padding.',
  ];
  return lines.join('\n');
}
