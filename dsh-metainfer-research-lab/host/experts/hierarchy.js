/**
 * Q8/B11/B12/B14/5.4/5.3.10: hierarchical review primitives.
 *
 * The hierarchy is a *context compression tree*, not a panel of lenses reading
 * the same snapshot:
 *   L0 branch reviewer  -> BranchReport for exactly one branch subtree
 *   L1 lead             -> 1..2 leads per project, may materialize nodes
 *   L2 chief            -> exactly one, exception arbiter with veto
 *
 * Everything in this module is deterministic and side-effect free. The
 * orchestrator owns model calls and kernel writes; this module owns the
 * slicing, evidence checks, compression accounting and arbitration policy so
 * those rules cannot drift between call sites.
 */

import { evaluateEscalationTriggers } from './triggers.js';
import { getExpertDescriptor } from './registry.js';
import { nodeFailureReason } from '../failure.js';

export const EXPERT_LEVELS = Object.freeze(['branch', 'lead', 'chief']);

export const HIERARCHY_DESCRIPTORS = Object.freeze([
  Object.freeze({
    id: 'lab-branch',
    level: 'branch',
    persona: 'Branch reviewer: summarizes one subtree and recommends next steps as text.',
    mayCreate: false,
    mayVeto: false,
    mayPropose: Object.freeze(['branch_report', 'escalate']),
    tools: Object.freeze(['dag_map', 'dag_walk', 'dag_get', 'dag_query']),
    budget: Object.freeze({ queriesPerRun: 2, tokensPerRun: 20_000, wallClockMs: 60_000 }),
    latencyMs: Object.freeze({ min: 30_000, max: 60_000 }),
    schema: Object.freeze({ type: 'object', required: ['branchId', 'health', 'verified', 'ruledOut', 'candidates', 'escalate'] }),
  }),
  Object.freeze({
    id: 'lab-lead',
    level: 'lead',
    persona: 'Direction lead: owns 1+ branch reports, materializes the next nodes and escalates exceptions.',
    mayCreate: true,
    mayVeto: false,
    mayPropose: Object.freeze(['proposal', 'priority', 'escalate']),
    tools: Object.freeze(['dag_map', 'dag_walk', 'dag_get', 'dag_query', 'ledger_read']),
    budget: Object.freeze({ queriesPerRun: 4, tokensPerRun: 40_000, wallClockMs: 90_000 }),
    latencyMs: Object.freeze({ min: 60_000, max: 90_000 }),
    schema: Object.freeze({ type: 'object', required: ['teamId', 'proposals'] }),
  }),
  Object.freeze({
    id: 'lab-chief',
    level: 'chief',
    persona: 'Exception arbiter: invisible to peers; decides only routed exceptions and may veto within the window.',
    mayCreate: false,
    mayVeto: true,
    mayPropose: Object.freeze(['review', 'priority']),
    tools: Object.freeze(['dag_map', 'dag_get', 'dag_query', 'ledger_read']),
    budget: Object.freeze({ queriesPerRun: 8, tokensPerRun: 40_000, wallClockMs: 180_000 }),
    latencyMs: Object.freeze({ min: 120_000, max: 180_000 }),
    schema: Object.freeze({ type: 'object', required: ['decision', 'reasonCode', 'verifiedEvidence'] }),
  }),
]);

export const BRANCH_REPORT_SCHEMA = Object.freeze({
  type: 'object',
  required: ['branchId', 'health', 'verified', 'ruledOut', 'candidates', 'escalate', 'evidence'],
  properties: {
    branchId: { type: 'string' },
    health: { type: 'string', enum: ['healthy', 'watch', 'dead'] },
    verified: { type: 'array' },
    ruledOut: { type: 'array' },
    candidates: { type: 'array' },
    escalate: { type: 'boolean' },
    reasonCodes: { type: 'array' },
    evidence: { type: 'array' },
    // `_truncated` is host-only: the deterministic report carries it for the
    // prompt, but the model-facing schema may not declare `type: ['object','null']`
    // because DSH structured output rejects type arrays.
  },
});

/** Fields an evidence pointer may cite. The Host validates this list, not the model. */
export const EVIDENCE_FIELDS = Object.freeze([
  'title',
  'prompt',
  'status',
  'report.summary',
  'report.metrics',
  'report.hypothesis',
  'review.verdict',
  'git.headCommit',
]);

export const HIGH_REVIEW_WINDOW_MS = 10 * 60_000;
export const CHIEF_VETO_ACTIONS = Object.freeze(['defer', 'withdraw']);

const LEVEL_BY_ID = new Map(HIERARCHY_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor.level]));
const BRANCH_BYTES_LIMIT = 20_000;
// A branch smaller than this cannot carry 3x because BranchReport has mandatory
// evidence/health fields; larger branches must meet the 3x contract.
const BRANCH_SMALL_INPUT_BYTES = 4_000;
const BRANCH_NODE_LIMIT = 15;
const LAYER_COMPRESSION = 3;
const MAX_DEPTH = 3;

function text(value, max = 500) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function parentIdsOf(node) {
  if (Array.isArray(node?.parentIds) && node.parentIds.length > 0) return node.parentIds;
  return node?.parentId ? [node.parentId] : [];
}

/** The root of a node's subtree is the stable branch identity. */
export function branchIdOf(nodeId, byId) {
  let current = nodeId;
  const seen = new Set();
  while (typeof current === 'string' && byId.has(current) && !seen.has(current)) {
    seen.add(current);
    const parents = parentIdsOf(byId.get(current));
    if (parents.length === 0) return current;
    current = parents[0];
  }
  return seen.size > 0 ? [...seen][0] : nodeId;
}

export function branchEventKey(node) {
  const version = node?.timestamps?.completedAt ?? node?.timestamps?.updatedAt ?? node?.timestamps?.createdAt ?? '';
  return `${node?.id ?? ''}:${node?.status ?? ''}:${version}`;
}

export function branchNodes(nodes, branchId) {
  const byId = new Map((Array.isArray(nodes) ? nodes : []).map((node) => [node.id, node]));
  return (Array.isArray(nodes) ? nodes : [])
    .filter((node) => node && !node.archivedAt && branchIdOf(node.id, byId) === branchId)
    .sort((a, b) => Number(a.timestamps?.createdAt ?? 0) - Number(b.timestamps?.createdAt ?? 0));
}

/** Validate Q8 evidence pointers against the Host's node facts. */
export function validateEvidencePointers(evidence, nodes, { requireQuote = false } = {}) {
  const byId = new Map((Array.isArray(nodes) ? nodes : []).map((node) => [node.id, node]));
  const errors = [];
  if (!Array.isArray(evidence) || evidence.length === 0) return ['evidence must be a non-empty array'];
  evidence.forEach((pointer, index) => {
    if (!pointer || typeof pointer !== 'object' || Array.isArray(pointer)) {
      errors.push(`evidence[${index}] must be an object`);
      return;
    }
    const nodeId = pointer.nodeId;
    if (typeof nodeId !== 'string' || !byId.has(nodeId)) {
      errors.push(`evidence[${index}].nodeId must reference an existing node`);
      return;
    }
    const field = pointer.field;
    const allowed = EVIDENCE_FIELDS.join(', ');
    if (field === undefined || field === null || field === '') {
      errors.push(`evidence[${index}] missing field (allowed: ${allowed}; add "field" with one of these exact values)`);
      return;
    }
    if (!EVIDENCE_FIELDS.includes(field)) {
      errors.push(`evidence[${index}].field ${JSON.stringify(field)} is not whitelisted (allowed: ${allowed}; use one of these exact values)`);
      return;
    }
    const node = byId.get(nodeId);
    const value = field.split('.').reduce((current, key) => (current && typeof current === 'object' ? current[key] : undefined), node);
    if (value === undefined || value === null) {
      errors.push(`evidence[${index}].field ${field} is absent on ${nodeId}`);
      return;
    }
    if (requireQuote) {
      const quote = pointer.quote;
      if (typeof quote !== 'string' || quote.length === 0) errors.push(`evidence[${index}].quote is required`);
      else if (!JSON.stringify(value).includes(quote)) errors.push(`evidence[${index}].quote is not present in ${field}`);
    }
  });
  return errors;
}

/** Compact one branch into a bounded BranchReport (<=15 nodes / <=20 KB). */
export function buildBranchReport({ branchId, nodes = [], inputNodes = null, now = Date.now() }) {
  const all = branchNodes(nodes, branchId);
  const source = all.length > 0 ? all : (Array.isArray(inputNodes) ? inputNodes : []);
  const selected = [];
  const compact = [];
  const inputBytes = jsonBytes(source);
  for (const node of source.slice(0, BRANCH_NODE_LIMIT)) {
    const row = {
      id: node.id,
      title: text(node.title, 120),
      status: node.status,
      hypothesis: text(node.hypothesis ?? node.report?.hypothesis, 160),
      confidence: Number.isFinite(Number(node.confidence ?? node.report?.confidence)) ? Number(node.confidence ?? node.report?.confidence) : null,
      summary: text(node.report?.summary, 240),
      updatedAt: Number(node.timestamps?.updatedAt ?? node.timestamps?.createdAt ?? 0),
    };
    const candidateBytes = jsonBytes([...selected, row]);
    if (selected.length > 0 && candidateBytes > BRANCH_BYTES_LIMIT) break;
    selected.push(row);
    compact.push(node);
  }
  const verified = compact.filter((node) => node.status === 'completed')
    .map((node) => ({ nodeId: node.id, hypothesis: text(node.hypothesis ?? node.report?.hypothesis, 160), confidence: Number(node.report?.confidence ?? node.confidence ?? 0) }));
  const ruledOut = compact.filter((node) => node.status === 'failed' || node.status === 'cancelled')
    .map((node) => ({ nodeId: node.id, hypothesis: text(node.hypothesis ?? node.report?.hypothesis, 160), reason: nodeFailureReason(node, 160) }));
  const candidates = compact.filter((node) => node.status === 'proposed' || node.status === 'planned')
    .map((node) => ({ nodeId: node.id, title: text(node.title, 120), textOnly: true }));
  const active = compact.some((node) => node.status === 'running' || node.status === 'planned' || node.status === 'proposed');
  const terminalFailures = compact.filter((node) => node.status === 'failed' || node.status === 'cancelled').length;
  const health = active ? (terminalFailures >= compact.length && compact.length > 0 ? 'dead' : 'healthy') : (compact.length > 0 && terminalFailures === compact.length ? 'dead' : 'watch');
  const evidence = compact.filter((node) => node.status === 'completed' && typeof node.report?.summary === 'string' && node.report.summary.length > 0)
    .slice(0, 5)
    .map((node) => ({ nodeId: node.id, field: 'report.summary', quote: text(node.report.summary, 80) }));
  const report = {
    branchId,
    level: 'branch',
    health,
    nodeCount: selected.length,
    totalNodes: all.length || source.length,
    verified,
    ruledOut,
    candidates,
    escalate: health === 'dead' || ruledOut.length > 0,
    reasonCodes: health === 'dead' ? ['branch_death'] : [],
    evidence,
    _truncated: (all.length || source.length) > selected.length || (all.length || source.length) > BRANCH_NODE_LIMIT
      ? { shown: selected.length, total: all.length || source.length }
      : null,
    inputBytes,
    outputBytes: 0,
    createdAt: now,
  };
  report.outputBytes = jsonBytes(report);
  report.compressionRatio = report.outputBytes > 0 ? Number((inputBytes / report.outputBytes).toFixed(3)) : null;
  return report;
}

/** Compress a layer to at least 3x; returns the compact summary and ratio. */
export function compressLayer(rows, { maxBytes = null } = {}) {
  const inputBytes = jsonBytes(rows);
  const limit = maxBytes ?? Math.max(1, Math.floor(inputBytes / LAYER_COMPRESSION));
  const summary = [];
  for (const row of rows) {
    const compact = {
      id: row.branchId ?? row.teamId ?? row.id ?? null,
      health: row.health ?? null,
      escalate: row.escalate === true,
      reasonCodes: Array.isArray(row.reasonCodes) ? row.reasonCodes.slice(0, 6) : [],
      candidates: Array.isArray(row.candidates) ? row.candidates.length : 0,
      verified: Array.isArray(row.verified) ? row.verified.length : 0,
      ruledOut: Array.isArray(row.ruledOut) ? row.ruledOut.length : 0,
    };
    if (jsonBytes([...summary, compact]) > limit && summary.length > 0) break;
    summary.push(compact);
  }
  if (summary.length === 0 && rows.length > 0) {
    summary.push({ id: rows[0]?.branchId ?? rows[0]?.teamId ?? rows[0]?.id ?? null });
  }
  if (jsonBytes(summary) > limit && summary.length > 0) {
    summary.splice(0, summary.length, { id: summary[0]?.id ?? null });
  }
  return { rows: summary, inputBytes, outputBytes: jsonBytes(summary), ratio: jsonBytes(summary) > 0 ? Number((inputBytes / jsonBytes(summary)).toFixed(3)) : null };
}

export function groupCount(activeBranches) {
  return Math.max(1, Math.ceil(Math.max(0, Number(activeBranches) || 0) / 2));
}

/** Exactly one chief per project, and it is not visible to peer experts. */
export function chiefPolicy(project) {
  const configured = project?.config?.experts?.chiefId;
  const chiefId = typeof configured === 'string' && configured.trim() ? configured.trim() : 'lab-chief';
  return { chiefId, count: 1, visibleToPeers: false, visibleTo: ['human', 'chief'] };
}

export function canSeeExpert(actor, expert) {
  if (!expert || expert.level !== 'chief') return true;
  // No actor means the operator-facing library (HTTP/UI), which may see the
  // arbiter. Only a peer expert is excluded from knowing it exists.
  if (!actor || actor.kind === 'human' || actor.kind === 'system') return true;
  return actor.kind === 'chief' || actor.id === 'lab-chief' || actor.preset === 'lab-chief';
}

export function filterVisibleExperts(experts, actor) {
  return (Array.isArray(experts) ? experts : []).filter((expert) => canSeeExpert(actor, expert));
}

/** Chief ratio is activations/completed and must stay well below 100%. */
export function chiefActivationMetrics({ activations = 0, completed = 0 }) {
  const ratio = completed > 0 ? Number((activations / completed).toFixed(3)) : 0;
  return { activations, completed, ratio, exceptionArbiter: ratio < 0.5 };
}

/** Validate the L2 decision: at least one verified raw-data pointer. */
export function validateChiefDecision(decision, nodes) {
  const errors = [];
  if (!decision || typeof decision !== 'object') return ['decision must be an object'];
  if (!CHIEF_VETO_ACTIONS.includes(decision.action) && decision.action !== 'keep' && decision.action !== 'unreviewed') {
    errors.push('decision.action must be defer/withdraw/keep/unreviewed');
  }
  const verified = Array.isArray(decision.verifiedEvidence) ? decision.verifiedEvidence : [];
  if (verified.length === 0) errors.push('verifiedEvidence must contain at least one raw-data pointer');
  errors.push(...validateEvidencePointers(verified, nodes, { requireQuote: true }));
  if (!Array.isArray(decision.evidenceChain) || decision.evidenceChain.length === 0) errors.push('evidenceChain must not be empty');
  return errors;
}

/** One review tree: L0 reports -> L1 team compression -> one L2 arbiter. */
export function buildHierarchyReview({ project, nodes = [], now = Date.now() }) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const present = nodes.filter((node) => !node.archivedAt);
  const active = present.filter((node) => ['planned', 'running', 'proposed'].includes(node.status));
  const branchIds = [...new Set(present.map((node) => branchIdOf(node.id, byId)))].sort();
  const activeBranchIds = [...new Set(active.map((node) => branchIdOf(node.id, byId)))].sort();
  const reports = branchIds.map((branchId) => buildBranchReport({ branchId, nodes, now }));
  const grouped = groupCount(activeBranchIds.length);
  const branchBytes = jsonBytes(reports);
  const leadLimit = Math.max(1, Math.floor(branchBytes / LAYER_COMPRESSION));
  const leadRows = compressLayer(reports, { maxBytes: leadLimit }).rows;
  const leadBytes = jsonBytes(leadRows);
  const chiefLimit = Math.max(1, Math.floor(leadBytes / LAYER_COMPRESSION));
  const chiefRows = compressLayer(leadRows, { maxBytes: chiefLimit }).rows;
  const chiefBytes = jsonBytes(chiefRows);
  const teams = [];
  for (let index = 0; index < grouped; index += 1) {
    teams.push({ teamId: `team-${index + 1}`, level: 'lead', branchIds: activeBranchIds.filter((_, reportIndex) => reportIndex % grouped === index), reports: leadRows });
  }
  const layers = [
    { level: 'branch', bytes: branchBytes, rows: reports },
    { level: 'lead', bytes: leadBytes, rows: leadRows },
    { level: 'chief', bytes: chiefBytes, rows: chiefRows },
  ];
  const chief = chiefPolicy(project);
  const escalationRows = evaluateEscalationTriggers({ nodes: present, project, knownHypotheses: project?.knownHypotheses ?? [], now });
  const escalations = {};
  for (const report of reports) escalations[report.branchId] = [];
  for (const row of escalationRows) {
    const ids = [...(row.detail?.nodeIds ?? []), ...(row.detail?.nodeId ? [row.detail.nodeId] : [])];
    if (ids.length === 0) {
      for (const branchId of activeBranchIds) escalations[branchId].push(row.code);
      continue;
    }
    for (const nodeId of ids) {
      const node = byId.get(nodeId);
      if (!node) continue;
      const branchId = branchIdOf(node.id, byId);
      if (escalations[branchId] && !escalations[branchId].includes(row.code)) escalations[branchId].push(row.code);
    }
  }
  const reviewedEvents = new Set((Array.isArray(project?.branchReviews) ? project.branchReviews : []).map((row) => row?.eventKey).filter(Boolean));
  const branchEvents = present
    .filter((node) => node.status === 'completed' || node.status === 'failed')
    .map((node) => ({ nodeId: node.id, branchId: branchIdOf(node.id, byId), eventKey: branchEventKey(node), status: node.status }))
    .filter((event) => !reviewedEvents.has(event.eventKey));
  const completed = present.filter((node) => node.status === 'completed').length;
  const coveredCompleted = reports.reduce((sum, report) => sum + report.verified.length, 0);
  return {
    enabled: true,
    generatedAt: now,
    l0Trigger: branchEvents.length > 0 ? 'branch_event' : 'noop',
    eventDriven: true,
    branchEvents,
    depth: layers.length,
    maxDepth: MAX_DEPTH,
    branchCount: branchIds.length,
    activeBranchCount: activeBranchIds.length,
    groupedTeams: grouped,
    chief,
    layers,
    compression: {
      perLayer: [
        {
          level: 'branch',
          inputBytes: jsonBytes(present),
          outputBytes: branchBytes,
          ratio: branchBytes > 0 ? Number((jsonBytes(present) / branchBytes).toFixed(3)) : null,
          // A one-node branch cannot carry 3x because BranchReport has mandatory
          // evidence/health fields. Mark that explicitly instead of skipping the
          // layer silently; validateHierarchyReview still enforces the 3x rule for
          // every branch whose raw slice is large enough.
          smallBranch: jsonBytes(present) < BRANCH_SMALL_INPUT_BYTES && jsonBytes(present) < branchBytes * LAYER_COMPRESSION,
        },
        { level: 'lead', inputBytes: branchBytes, outputBytes: leadBytes, ratio: leadBytes > 0 ? Number((branchBytes / leadBytes).toFixed(3)) : null },
        { level: 'chief', inputBytes: leadBytes, outputBytes: chiefBytes, ratio: chiefBytes > 0 ? Number((leadBytes / chiefBytes).toFixed(3)) : null },
      ],
    },
    coverage: {
      completed,
      coveredCompleted,
      ratio: completed > 0 ? Number((coveredCompleted / completed).toFixed(3)) : 1,
    },
    evidenceChain: reports.flatMap((report) => report.evidence),
    createdBy: 'lab-lead',
    ratifiedBy: null,
    reports,
    teams,
    escalations,
    nodes: present,
  };
}



/** C2: one lead cannot escalate without bound in one review epoch. */
export function escalationQuota({ project = {}, leadId = 'lab-lead', epoch = 1, limit = null } = {}) {
  const configured = Number(project?.config?.maxEscalationsPerEpoch ?? project?.config?.migration?.maxEscalationsPerEpoch);
  const max = Math.max(1, Number.isFinite(limit) ? limit : (Number.isFinite(configured) && configured > 0 ? configured : 3));
  const rows = (Array.isArray(project.reviewEscalations) ? project.reviewEscalations : [])
    .filter((row) => row && row.leadId === leadId && String(row.epoch) === String(epoch));
  return { leadId, epoch: String(epoch), used: rows.length, limit: max, allowed: rows.length < max, remaining: Math.max(0, max - rows.length) };
}

/** C2: escalation-rate monitoring has explicit alert/tighten codes. */
export function escalationRate({ escalations = [], intents = [], alertAt = 0.25, tightenAt = 0.5 } = {}) {
  const count = escalations.length;
  const denominator = Math.max(0, intents.length);
  const ratio = denominator > 0 ? Number((count / denominator).toFixed(3)) : 0;
  const status = ratio >= tightenAt ? 'tighten' : ratio >= alertAt ? 'alert' : 'normal';
  return {
    escalations: count,
    intents: denominator,
    ratio,
    status,
    code: status === 'normal' ? null : status === 'alert' ? 'escalation_rate_alert' : 'escalation_rate_tighten',
    alertAt,
    tightenAt,
  };
}

const getPath = (obj, path) => path.split('.').reduce((current, key) => (current && typeof current === 'object' ? current[key] : undefined), obj);

/** C8: child creation is a vote only when dedupe/budget/quota pass. */
export function childVoteWeight({ project = {}, nodes = [], parent = null, child = null, expertId = 'lab-lead', now = Date.now() }) {
  const votes = Array.isArray(project.childVotes) ? project.childVotes : [];
  const sameExpert = votes.filter((vote) => vote.expertId === expertId);
  const sameTarget = sameExpert.filter((vote) => vote.parentId === parent?.id && vote.nodeId === child?.id);
  if (sameTarget.length > 0) return { weight: 0, reason: 'same_expert_same_node' };
  const rosterConfig = Array.isArray(project.config?.experts) ? null : project.config?.experts;
  const descriptorBudget = getExpertDescriptor(expertId)?.budget ?? {};
  const maxPerHour = Math.max(1, Number(project.config?.expertsVotesPerHour ?? rosterConfig?.votesPerHour ?? descriptorBudget.childVotesPerHour ?? 50));
  const hourAgo = now - 60 * 60_000;
  if (sameExpert.filter((vote) => Number(vote.at) >= hourAgo).length >= maxPerHour) return { weight: 0, reason: 'quota_exceeded' };
  const prompt = text(child?.prompt, 500);
  const duplicate = (nodes || []).some((node) => node && node.id !== child?.id && node.id !== child?.replacesNodeId && !node.archivedAt
    && ((prompt && node.promptHash && child?.promptHash && node.promptHash === child.promptHash)
      || (text(node.title, 200) === text(child?.title, 200) && text(node.prompt, 500) === prompt)));
  if (duplicate) return { weight: 0, reason: 'duplicate' };
  return { weight: 1, reason: 'counted', vote: { expertId, parentId: parent?.id ?? null, nodeId: child?.id ?? null, at: now, weight: 1 } };
}

/** Validate depth<=3 and each layer >=3x compression. */
export function validateHierarchyReview(review, nodes = review?.nodes ?? []) {
  const errors = [];
  if (!review || typeof review !== 'object') return ['review missing'];
  if (review.branchCount === 0 && (review.compression?.perLayer ?? []).every((layer) => layer.inputBytes <= 2)) return errors;
  if (review.depth > MAX_DEPTH) errors.push(`depth ${review.depth} exceeds ${MAX_DEPTH}`);
  if (review.chief?.count !== 1) errors.push('exactly one chief is required');
  const chain = Array.isArray(review.evidenceChain) ? review.evidenceChain : [];
  if (chain.length > 0) errors.push(...validateEvidencePointers(chain, nodes, { requireQuote: false }));
  for (const layer of review.compression?.perLayer ?? []) {
    if (layer.level === 'branch' && layer.smallBranch === true && layer.inputBytes < BRANCH_SMALL_INPUT_BYTES) {
      if (layer.outputBytes > BRANCH_BYTES_LIMIT) errors.push(`branch report ${layer.outputBytes} exceeds the ${BRANCH_BYTES_LIMIT} byte bound`);
      continue;
    }
    if (layer.level === 'branch' && layer.smallBranch === true) {
      errors.push(`branch smallBranch claim is invalid for ${layer.inputBytes} input bytes`);
      continue;
    }
    if (layer.inputBytes > 0 && !(layer.ratio >= LAYER_COMPRESSION)) errors.push(`${layer.level} compression ${layer.ratio} is below ${LAYER_COMPRESSION}x`);
  }
  return errors;
}

export function descriptorForLevel(level) {
  return HIERARCHY_DESCRIPTORS.find((descriptor) => descriptor.level === level) ?? null;
}

export function levelOfExpert(expertId) {
  return LEVEL_BY_ID.get(expertId) ?? null;
}

// Round 33: candidate identity/consumption is part of the hierarchy review
// surface so callers do not have to import an implementation module directly.
export {
  MAX_CANDIDATES,
  MAX_CONSUMPTIONS,
  buildBranchCandidateQueue,
  candidateNoProposalReason,
  candidateSkipReason,
  candidateStats,
} from './candidates.js';
