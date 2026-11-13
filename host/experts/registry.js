/**
 * Expert registry (Stage 4). A descriptor is data, not code: replacing an expert
 * means replacing this record. Every descriptor exposes the eight contract
 * fields, and `mayExecute` is empty for all experts — only the Host commits.
 */
const READ_TOOLS = Object.freeze(['dag_map', 'dag_walk', 'dag_get', 'dag_query', 'ledger_read', 'intent_list']);

/**
 * The only tools an advisory expert may ever hold. Each one is read-only; the
 * Host remains the sole writer. This catalogue is served by GET /experts so the
 * UI does not duplicate (or drift from) the allowlist.
 */
export const EXPERT_TOOL_CATALOG = Object.freeze([
  Object.freeze({ name: 'dag_map', description: 'Read the project DAG map (nodes, edges, status).', readOnly: true }),
  Object.freeze({ name: 'dag_walk', description: 'Walk a subtree and read its structure.', readOnly: true }),
  Object.freeze({ name: 'dag_get', description: 'Read one node, including its latest report.', readOnly: true }),
  Object.freeze({ name: 'dag_query', description: 'Query nodes by status, owner, branch or text.', readOnly: true }),
  Object.freeze({ name: 'ledger_read', description: 'Read the claim ledger and its evidence pointers.', readOnly: true }),
  Object.freeze({ name: 'intent_list', description: 'Read pending Host intents; never submit one.', readOnly: true }),
]);
export const EXPERT_TOOL_NAMES = Object.freeze(EXPERT_TOOL_CATALOG.map((tool) => tool.name));

/**
 * Trigger codes understood by the expert lifecycle. The list is deliberately
 * closed: a custom expert picks from it instead of inventing a new event.
 */
export const EXPERT_TRIGGER_CATALOG = Object.freeze([
  Object.freeze({ name: 'node.completed', description: 'A node run finished successfully.' }),
  Object.freeze({ name: 'node.failed', description: 'A node run failed or exhausted retries.' }),
  Object.freeze({ name: 'low_water', description: 'The runnable queue is running low.' }),
  Object.freeze({ name: 'review.requested', description: 'A proposal is waiting for review.' }),
  Object.freeze({ name: 'escalation', description: 'A deterministic escalation code fired.' }),
  Object.freeze({ name: 'branch.report', description: 'A branch report is ready for a lead.' }),
  Object.freeze({ name: 'branch.event', description: 'A branch lifecycle event was recorded.' }),
  Object.freeze({ name: 'duplicate.candidates>=5', description: 'At least five duplicate-candidate pairs are waiting.' }),
  Object.freeze({ name: 'interval:15m', description: 'The 15-minute curator interval elapsed.' }),
]);
export const EXPERT_TRIGGER_NAMES = Object.freeze(EXPERT_TRIGGER_CATALOG.map((trigger) => trigger.name));

/**
 * A custom expert never invents an output contract. It picks one of these role
 * templates, and the template supplies mayPropose/schema/mayCreate/mayVeto.
 * `baseId` makes the inheritance auditable in the catalog.
 */
export const EXPERT_TEMPLATE_CATALOG = Object.freeze([
  Object.freeze({
    id: 'proposer', baseId: 'lab-advisor', mayPropose: Object.freeze(['proposal', 'priority']),
    mayCreate: true, mayVeto: false, schemaSource: 'lab-advisor', defaultLevel: 'lead',
  }),
  Object.freeze({
    id: 'reviewer', baseId: 'lab-reviewer', mayPropose: Object.freeze(['review']),
    mayCreate: false, mayVeto: false, schemaSource: 'lab-reviewer', defaultLevel: 'branch',
  }),
  Object.freeze({
    id: 'branch', baseId: 'lab-branch', mayPropose: Object.freeze(['branch_report', 'escalate']),
    mayCreate: false, mayVeto: false, schemaSource: 'lab-branch', defaultLevel: 'branch',
  }),
  Object.freeze({
    id: 'curator', baseId: 'lab-curator', mayPropose: Object.freeze(['close', 'defer']),
    mayCreate: false, mayVeto: false, schemaSource: 'lab-curator', defaultLevel: 'branch',
  }),
  Object.freeze({
    id: 'chief', baseId: 'lab-chief', mayPropose: Object.freeze(['review', 'priority']),
    mayCreate: false, mayVeto: true, schemaSource: 'lab-chief', defaultLevel: 'chief',
  }),
]);
export const EXPERT_TEMPLATE_IDS = Object.freeze(EXPERT_TEMPLATE_CATALOG.map((template) => template.id));

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
    level: input.level ?? 'branch',
    mayCreate: input.mayCreate === true,
    mayVeto: input.mayVeto === true,
    latencyMs: Object.freeze({ ...(input.latencyMs ?? { min: 30_000, max: 60_000 }) }),
    visibleToPeers: input.visibleToPeers !== false,
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
    level: 'lead',
    mayCreate: true,
    latencyMs: { min: 60_000, max: 90_000 },
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
    level: 'branch',
    mayCreate: false,
    latencyMs: { min: 30_000, max: 60_000 },
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
    level: 'branch',
    mayCreate: false,
  }),
  freezeDescriptor({
    id: 'lab-chief',
    persona: 'Arbitrator: resolves escalations routed by deterministic codes.',
    model: { provider: 'deepseek', model: 'deepseek-chat' },
    tools: READ_TOOLS,
    triggers: ['escalation'],
    mayPropose: ['review', 'priority'],
    budget: { queriesPerRun: 2, tokensPerHour: 40_000, wallClockMs: 120_000 },
    schema: { type: 'object', required: ['decision', 'reasonCode', 'verifiedEvidence'] },
    level: 'chief',
    mayCreate: false,
    mayVeto: true,
    visibleToPeers: false,
    latencyMs: { min: 120_000, max: 180_000 },
  }),
  freezeDescriptor({
    id: 'lab-branch',
    persona: 'Branch reviewer: compresses exactly one subtree into a BranchReport; may never create a node.',
    model: { provider: 'deepseek', model: 'deepseek-chat' },
    tools: Object.freeze(['dag_map', 'dag_walk', 'dag_get', 'dag_query']),
    triggers: ['node.completed', 'node.failed', 'branch.event'],
    mayPropose: ['branch_report', 'escalate'],
    budget: { queriesPerRun: 2, tokensPerHour: 20_000, wallClockMs: 60_000 },
    schema: { type: 'object', required: ['branchId', 'health', 'verified', 'ruledOut', 'candidates', 'escalate'] },
    level: 'branch',
    mayCreate: false,
    latencyMs: { min: 30_000, max: 60_000 },
  }),
  freezeDescriptor({
    id: 'lab-lead',
    persona: 'Direction lead: owns branch reports and materializes the next nodes; escalates exceptions to the chief.',
    model: { provider: 'deepseek', model: 'deepseek-chat' },
    tools: READ_TOOLS,
    triggers: ['branch.report', 'escalation'],
    mayPropose: ['proposal', 'priority', 'escalate'],
    budget: { queriesPerRun: 4, tokensPerHour: 40_000, wallClockMs: 90_000, childVotesPerHour: 20 },
    schema: { type: 'object', required: ['teamId', 'proposals'] },
    level: 'lead',
    mayCreate: true,
    latencyMs: { min: 60_000, max: 90_000 },
  }),
]);

export function listExpertDescriptors() {
  return EXPERT_DESCRIPTORS.map((descriptor) => structuredClone(descriptor));
}

export function getExpertDescriptor(id) {
  const found = EXPERT_DESCRIPTORS.find((descriptor) => descriptor.id === id);
  return found ? structuredClone(found) : null;
}

export function getExpertTemplate(id) {
  const found = EXPERT_TEMPLATE_CATALOG.find((template) => template.id === id);
  return found ? structuredClone(found) : null;
}

/** Resolve a role template to the immutable catalog descriptor that owns its contract. */
export function getExpertTemplateDescriptor(templateId) {
  const template = getExpertTemplate(templateId);
  return template === null ? null : getExpertDescriptor(template.baseId);
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
