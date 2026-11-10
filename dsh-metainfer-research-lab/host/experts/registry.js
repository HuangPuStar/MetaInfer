/**
 * Expert registry (Stage 4). A descriptor is data, not code: replacing an expert
 * means replacing this record. Every descriptor exposes the eight contract
 * fields, and `mayExecute` is empty for all experts — only the Host commits.
 */
const READ_TOOLS = Object.freeze(['dag_map', 'dag_walk', 'dag_get', 'dag_query', 'ledger_read', 'intent_list']);

function freezeDescriptor(input) {
  return Object.freeze({
    id: input.id,
    persona: input.persona,
    model: Object.freeze({ ...input.model }),
    tools: Object.freeze([...input.tools]),
    triggers: Object.freeze([...input.triggers]),
    mayPropose: Object.freeze([...input.mayPropose]),
    mayExecute: Object.freeze([]),
    budget: Object.freeze({ ...input.budget }),
    schema: Object.freeze({ ...input.schema }),
  });
}

export const EXPERT_DESCRIPTORS = Object.freeze([
  freezeDescriptor({
    id: 'lab-advisor',
    persona: 'Exploration lead: proposes the next experiment and states expected information gain.',
    model: { provider: 'deepseek', model: 'deepseek-chat' },
    tools: READ_TOOLS,
    triggers: ['node.completed', 'node.failed', 'low_water'],
    mayPropose: ['proposal', 'priority', 'close'],
    budget: { queriesPerRun: 4, tokensPerHour: 120_000, wallClockMs: 240_000 },
    schema: { type: 'object', required: ['title', 'prompt', 'rationale'] },
  }),
  freezeDescriptor({
    id: 'lab-reviewer',
    persona: 'Reviewer: checks claims against evidence and proposes accept/reject decisions.',
    model: { provider: 'deepseek', model: 'deepseek-chat' },
    tools: READ_TOOLS,
    triggers: ['review.requested'],
    mayPropose: ['review', 'close'],
    budget: { queriesPerRun: 2, tokensPerHour: 60_000, wallClockMs: 120_000 },
    schema: { type: 'object', required: ['verdict', 'evidence'] },
  }),
  freezeDescriptor({
    id: 'lab-curator',
    persona: 'Duplicate curator: judges deterministically recalled candidate pairs. Never closes a node.',
    model: { provider: 'deepseek', model: 'deepseek-chat' },
    tools: Object.freeze(['dag_map', 'dag_walk', 'dag_get', 'dag_query']),
    triggers: ['duplicate.candidates>=5', 'interval:15m'],
    mayPropose: ['close', 'defer'],
    budget: { queriesPerRun: 8, tokensPerHour: 40_000, wallClockMs: 120_000 },
    schema: { type: 'object', required: ['nominations'] },
  }),
  freezeDescriptor({
    id: 'lab-chief',
    persona: 'Arbitrator: resolves escalations routed by deterministic codes.',
    model: { provider: 'deepseek', model: 'deepseek-chat' },
    tools: READ_TOOLS,
    triggers: ['escalation'],
    mayPropose: ['review', 'priority'],
    budget: { queriesPerRun: 2, tokensPerHour: 40_000, wallClockMs: 120_000 },
    schema: { type: 'object', required: ['decision', 'reasonCode'] },
  }),
]);

export function listExpertDescriptors() {
  return EXPERT_DESCRIPTORS.map((descriptor) => structuredClone(descriptor));
}

export function getExpertDescriptor(id) {
  const found = EXPERT_DESCRIPTORS.find((descriptor) => descriptor.id === id);
  return found ? structuredClone(found) : null;
}

/**
 * Pure performance view from node/run records. No I/O so the same numbers can be
 * asserted in tests; the service passes the store's current rows.
 */
export function computeExpertMetrics({ expertId, nodes = [], runs = [] }) {
  const owned = nodes.filter((node) => node.createdBy === expertId);
  const accepted = owned.filter((node) => node.status !== 'proposed' && node.status !== 'pending');
  const completed = owned.filter((node) => node.status === 'completed');
  const pruned = owned.filter((node) => node.priority?.class === 'deferred');
  const durations = completed
    .map((node) => (node.timestamps?.completedAt ?? 0) - (node.timestamps?.startedAt ?? 0))
    .filter((duration) => duration > 0);
  const expertRuns = runs.filter((run) => run.expertId === expertId || run.createdBy === expertId);
  return {
    expertId,
    proposals: owned.length,
    accepted: accepted.length,
    completed: completed.length,
    pruned: pruned.length,
    successRate: accepted.length === 0 ? null : Math.round((completed.length / accepted.length) * 1000) / 1000,
    avgDurationMs: durations.length === 0 ? null : Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
    runs: expertRuns.length,
  };
}
