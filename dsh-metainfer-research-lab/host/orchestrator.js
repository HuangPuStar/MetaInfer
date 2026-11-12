/**
 * M3 orchestrator: advisor (review board) + scheduler role runs and the manual
 * Step cycle. All LLM calls happen outside project locks; validation and node
 * creation happen inside them.
 */
import { createHash, randomUUID } from 'node:crypto';
import { ROLE_PRESETS } from './role-presets.js';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LabError } from './git-engine.js';
import { cleanModelRef, validateModelSelection } from './models.js';
import { resolveExecutionProfile } from './execution.js';
import { newSessionId } from './store.js';
import { buildAdvisorSnapshot, buildSchedulerSnapshot, promptHash } from './snapshot.js';
import { DEFAULT_ADVISOR_PROMPT, DEFAULT_SCHEDULER_PROMPT } from './prompts.js';
import { clampNodeTitle, isBlank } from './titles.js';
import { createReviewClaimBoard } from './dispatch/review-claims.js';
import { createLedgerReader } from './context/ledger.js';
import { basisFor, createIntent, intentId, intentMutation } from './kernel/intent.js';
import { baselineFor, normalizeExpected } from './kernel/prediction.js';
import { BRANCH_REPORT_SCHEMA, HIGH_REVIEW_WINDOW_MS, branchIdOf, buildHierarchyReview, branchEventKey, childVoteWeight, escalationQuota, validateChiefDecision } from './experts/hierarchy.js';
import { MAX_CONSUMPTIONS, buildBranchCandidateQueue, candidateSkipReason, candidateStats, candidateStructureKey, replacementChainForNode } from './experts/candidates.js';
import { assertModelSchema } from './schema-check.js';

const ROLE_RUN_TIMEOUT_MS = 180_000;
// 5.3.8: O1 measured advisor p90 at the old 180 s ceiling; the default budget
// now leaves headroom instead of cutting the tail off. Projects can still pin
// `config.advisor.timeoutSeconds` within 30..1800 s.
export const DEFAULT_ADVISOR_TIMEOUT_SECONDS = 240;
export const NODE_TIMEOUT_DEFAULTS = Object.freeze({ nodeTimeoutMinutes: 10, maxNodeTimeoutMinutes: 240 });
const NODE_TIMEOUT_MIN_MINUTES = 1;
const NODE_TIMEOUT_MAX_MINUTES = 1440;

/**
 * Round 37: the same bounds used by checkProposal and the API validators, so a
 * lead prompt cannot advertise a range the Host will not enforce.
 */
export function nodeTimeboxBounds(project) {
  const rawMax = Number(project?.config?.maxNodeTimeoutMinutes);
  const maxNodeTimeoutMinutes = Number.isFinite(rawMax)
    ? Math.max(NODE_TIMEOUT_MIN_MINUTES, Math.min(NODE_TIMEOUT_MAX_MINUTES, Math.round(rawMax)))
    : NODE_TIMEOUT_DEFAULTS.maxNodeTimeoutMinutes;
  const rawDefault = Number(project?.config?.nodeTimeoutMinutes);
  const nodeTimeoutMinutes = Number.isFinite(rawDefault)
    ? Math.max(NODE_TIMEOUT_MIN_MINUTES, Math.min(maxNodeTimeoutMinutes, Math.round(rawDefault)))
    : Math.min(maxNodeTimeoutMinutes, NODE_TIMEOUT_DEFAULTS.nodeTimeoutMinutes);
  return { min: NODE_TIMEOUT_MIN_MINUTES, max: maxNodeTimeoutMinutes, default: nodeTimeoutMinutes };
}

function timeboxLimitLine(project, role = 'lead') {
  const bounds = nodeTimeboxBounds(project);
  const minutes = bounds.default === 1 ? 'minute' : 'minutes';
  const scope = role === 'branch'
    ? 'if a candidate suggests a node timebox, it must stay within this range'
    : role === 'advisor'
      ? 'proposal timeboxes outside this range are rejected'
      : 'proposals outside this range are rejected';
  return `Timebox limit: timeboxMinutes must be an integer in ${bounds.min}..${bounds.max} (this project's default node budget is ${bounds.default} ${minutes}); ${scope}.`;
}

function formatReceivedValue(value) {
  if (typeof value === 'string') return JSON.stringify(value).slice(0, 80);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value).slice(0, 80);
  } catch {
    return String(value).slice(0, 80);
  }
}

/**
 * Read the platform-published expert-skill overlay.  The MetaInfer trajectory
 * registry writes this file; the Lab only consumes it for advisor/scheduler
 * prompts and never mutates it.
 */
function activeSkillSection(roles, seed = '') {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const file = process.env.MIRL_ACTIVE_SKILLS_FILE
    || path.join(dshHome, 'metainfer-research-lab', 'active-skills.json');
  let payload;
  try {
    payload = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return '';
  }
  const entries = payload && typeof payload === 'object' ? payload.entries : null;
  if (!entries || typeof entries !== 'object') return '';
  const wanted = new Set(roles);
  const lines = [];
  for (const [role, entry] of Object.entries(entries)) {
    if (!wanted.has(String(role)) || !entry || typeof entry !== 'object') continue;
    const percent = Number(entry.canaryPercent ?? 100);
    if (Number.isFinite(percent) && percent < 100) {
      const digest = createHash('sha256')
        .update(`${entry.releaseId}:${seed}`)
        .digest('hex');
      if (parseInt(digest.slice(0, 8), 16) % 100 >= Math.max(0, percent)) continue;
    }
    lines.push(`<!-- METAINFER_SKILL_RELEASE:${entry.releaseId};ROLE:${role} -->`);
    lines.push(`Skill: ${entry.skillName || entry.skillId} (version ${entry.skillVersion || '?'})`);
    lines.push('Apply these reviewed expert-skill changes where relevant:');
    for (const change of entry.changes || []) {
      if (change && typeof change.change === 'string' && change.change.trim()) {
        lines.push(`- [${change.type || 'change'}] ${change.change.trim()}`);
      }
    }
    lines.push('');
  }
  return lines.length === 0 ? '' : ['# Active expert skill', ...lines].join('\n');
}

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
          // Round 33: the lead echoes the Host-derived id of a branch-report
          // candidate it is materializing. Optional for ordinary advisor
          // proposals; hierarchy candidates without it fall back to lineage.
          candidateId: { type: 'string' },
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
          expected: {
            type: 'object',
            properties: {
              metric: { type: 'string' },
              direction: { type: 'string', enum: ['up', 'down'] },
              magnitude: { type: 'number' },
              unit: { type: 'string' },
            },
            required: ['metric', 'direction', 'magnitude'],
            additionalProperties: false,
          },
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
          executionProfile: { type: 'string' },
          taskType: { type: 'string' },
        },
        required: ['parentId', 'title', 'prompt', 'rationale'],
        additionalProperties: false,
      },
    },
    // Round 34: the lead must say what it did with every pending candidate it
    // did not materialize. The Host stores this verbatim and merges it with the
    // structural candidate reasons, so a no-create cycle is auditable.
    candidateDecisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          candidateId: { type: 'string' },
          decision: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['candidateId', 'reason'],
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

const CHIEF_SCHEMA = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['defer', 'withdraw', 'keep'] },
    reasonCode: { type: 'string' },
    verifiedEvidence: { type: 'array', items: { type: 'object' } },
    evidenceChain: { type: 'array', items: { type: 'object' } },
  },
  required: ['decision', 'reasonCode', 'verifiedEvidence', 'evidenceChain'],
  additionalProperties: false,
};

export { ROLE_PRESETS };
const ROLE_BUDGETS = Object.freeze({
  branch: { maxQueries: 2, timeoutMs: 60_000 },
  lead: { maxQueries: 4, timeoutMs: 90_000 },
  chief: { maxQueries: 8, timeoutMs: 180_000 },
});

/**
 * Round 35: lead/advisor/branch share `config.advisor.timeoutSeconds`; role
 * defaults are documented and preserved when no value is configured. Chief is
 * deliberately not configurable by the advisor budget (its 180 s exception
 * window is a separate mechanism).
 */
export const ROLE_TIMEOUT_DEFAULTS = Object.freeze({
  branch: 60_000,
  lead: 90_000,
  advisor: DEFAULT_ADVISOR_TIMEOUT_SECONDS * 1000,
  chief: 180_000,
});
const CONFIGURABLE_ROLE_TIMEOUTS = new Set(['branch', 'lead', 'advisor']);

function configuredAdvisorSeconds(project) {
  const raw = project?.config?.advisor?.timeoutSeconds;
  if (raw === undefined || raw === null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function roleTimeoutMs(project, role) {
  const fallback = ROLE_TIMEOUT_DEFAULTS[role] ?? ROLE_RUN_TIMEOUT_MS;
  if (!CONFIGURABLE_ROLE_TIMEOUTS.has(role)) return fallback;
  const configured = configuredAdvisorSeconds(project);
  if (configured === null) return fallback;
  return Math.max(30_000, Math.min(1_800_000, Math.round(configured) * 1000));
}

function roleTimeoutSource(project, role) {
  if (!CONFIGURABLE_ROLE_TIMEOUTS.has(role)) return 'role-default';
  return configuredAdvisorSeconds(project) !== null ? 'config.advisor.timeoutSeconds' : 'role-default';
}

function branchPrompt(project, event, report) {
  return [
    'You are the L0 branch reviewer. Compress exactly one branch subtree into a BranchReport.',
    'Do not create nodes, do not edit the ledger, and do not review other branches.',
    'Return the BranchReport through structured_output: branchId, health, verified, ruledOut, candidates, escalate, evidence.',
    'Every evidence pointer must cite a real nodeId, a whitelisted field and a quote from that field.',
    `Budget: at most ${ROLE_BUDGETS.branch.maxQueries} read calls; finish within ${roleTimeoutMs(project, 'branch') / 1000} seconds.`,
    timeboxLimitLine(project, 'branch'),
    '',
    '# Branch event',
    JSON.stringify(event),
    '',
    '# Deterministic slice',
    JSON.stringify(report),
    '',
    `Project: ${project.id}`,
  ].join('\n');
}

const LEAD_MAX_CANDIDATES = 8;
const LEAD_QUOTE_CHARS = 240;
const LEAD_TEXT_CHARS = 320;
const LEAD_MAX_REPORT_ROWS = 6;
const LEAD_MAX_EVIDENCE = 4;

function priorityRank(priority) {
  const raw = typeof priority === 'string' ? priority.toLowerCase() : '';
  return ({ p0: 0, p1: 1, p2: 2, p3: 3 })[raw] ?? 4;
}

function candidateKindKey(row) {
  return `${row?.branchId ?? 'branch'}|${row?.sourceNodeId ?? 'branch'}|${row?.kind ?? 'idea'}`;
}

function compactExpected(expected) {
  if (!expected || typeof expected !== 'object') return null;
  return {
    metric: boundedText(expected.metric, 120),
    direction: boundedText(expected.direction, 20),
    magnitude: Number.isFinite(Number(expected.magnitude)) ? Number(expected.magnitude) : null,
    unit: boundedText(expected.unit, 60),
  };
}

function compactEvidencePointer(pointer) {
  if (!pointer || typeof pointer !== 'object') return null;
  return {
    nodeId: typeof pointer.nodeId === 'string' ? pointer.nodeId : null,
    field: boundedText(pointer.field, 80),
    quote: boundedText(pointer.quote, LEAD_QUOTE_CHARS),
  };
}

function leadCandidateRow(candidate) {
  return {
    candidateId: candidate.candidateId,
    branchId: candidate.branchId,
    sourceNodeId: candidate.sourceNodeId,
    sourceParentId: candidate.sourceParentId,
    sourceStatus: candidate.sourceStatus,
    kind: candidate.kind,
    priority: candidate.priority,
    title: boundedText(candidate.title, 200),
    detail: boundedText(candidate.detail, 220),
    needs: candidate.needs && typeof candidate.needs === 'object' ? candidate.needs : null,
    expected: compactExpected(candidate.expected),
    lowConfidence: candidate.lowConfidence === true,
  };
}

/**
 * Round 35: cap the lead's queue. Failed-source retries come first, then
 * priority, then non-low-confidence and recency. A candidate whose
 * branch/source/kind was already consumed is not shown again.
 */
function leadCandidateLimit(project) {
  const raw = project?.config?.advisor?.maxLeadCandidates;
  if (raw === undefined || raw === null || raw === '') return LEAD_MAX_CANDIDATES;
  const configured = Number(raw);
  return Number.isFinite(configured) ? Math.max(1, Math.min(24, Math.round(configured))) : LEAD_MAX_CANDIDATES;
}

function selectLeadCandidates(project, pendingCandidates) {
  const limit = leadCandidateLimit(project);
  const consumedKinds = new Set((Array.isArray(project?.candidateConsumptions) ? project.candidateConsumptions : [])
    .map((row) => candidateKindKey(row))
    .filter(Boolean));
  const dedupedConsumed = [];
  const eligible = [];
  for (const candidate of pendingCandidates) {
    if (consumedKinds.has(candidateKindKey(candidate))) {
      dedupedConsumed.push(candidate.candidateId);
      continue;
    }
    eligible.push(candidate);
  }
  eligible.sort((left, right) => {
    const leftRank = left.sourceStatus === 'failed' || left.sourceStatus === 'cancelled' ? 0 : 1;
    const rightRank = right.sourceStatus === 'failed' || right.sourceStatus === 'cancelled' ? 0 : 1;
    if (leftRank !== rightRank) return leftRank - rightRank;
    const priority = priorityRank(left.priority) - priorityRank(right.priority);
    if (priority !== 0) return priority;
    if (Boolean(left.lowConfidence) !== Boolean(right.lowConfidence)) return left.lowConfidence ? 1 : -1;
    const recency = Number(right.reportAt ?? 0) - Number(left.reportAt ?? 0);
    if (recency !== 0) return recency;
    return String(left.candidateId).localeCompare(String(right.candidateId));
  });
  const selected = eligible.slice(0, limit);
  return {
    selected,
    dedupedConsumed,
    omitted: Math.max(0, pendingCandidates.length - selected.length - dedupedConsumed.length),
  };
}

function compactBranchReport(run) {
  const output = run?.output && typeof run.output === 'object' ? run.output : {};
  const compactRows = (rows, mapper) => (Array.isArray(rows) ? rows.slice(0, LEAD_MAX_REPORT_ROWS).map(mapper) : []);
  return {
    branchId: run?.branchId ?? output.branchId ?? null,
    status: run?.status ?? null,
    candidateCount: Array.isArray(output.candidates) ? output.candidates.length : 0,
    events: Array.isArray(run?.events)
      ? run.events.slice(0, 3).map((event) => ({ eventKey: event?.eventKey ?? null, nodeId: event?.nodeId ?? null, status: event?.status ?? null }))
      : [],
    output: {
      branchId: output.branchId ?? run?.branchId ?? null,
      health: output.health ?? null,
      escalate: output.escalate === true,
      reasonCodes: Array.isArray(output.reasonCodes) ? output.reasonCodes.slice(0, 8) : [],
      verified: compactRows(output.verified, (row) => ({
        nodeId: row?.nodeId ?? null,
        kind: row?.kind ?? null,
        confidence: Number.isFinite(Number(row?.confidence)) ? Number(row.confidence) : null,
        claim: boundedText(row?.claim ?? row?.hypothesis ?? row?.reason, LEAD_TEXT_CHARS),
        evidence: compactEvidencePointer(row?.evidence),
      })),
      ruledOut: compactRows(output.ruledOut, (row) => ({
        nodeId: row?.nodeId ?? null,
        kind: row?.kind ?? null,
        reason: boundedText(row?.reason, LEAD_TEXT_CHARS),
        evidence: compactEvidencePointer(row?.evidence),
      })),
      evidence: Array.isArray(output.evidence)
        ? output.evidence.slice(0, LEAD_MAX_EVIDENCE).map(compactEvidencePointer)
        : [],
    },
  };
}

function leadPromptParts(project, review, branchRuns, pendingCandidates = [], options = {}) {
  const previousLeadFeedback = options.previousLeadFeedback ?? null;
  const selection = selectLeadCandidates(project, pendingCandidates);
  const candidates = selection.selected.map(leadCandidateRow);
  const reports = (Array.isArray(branchRuns) ? branchRuns : []).map(compactBranchReport);
  const rawCandidates = pendingCandidates.slice(0, 24).map((candidate) => ({
    candidateId: candidate.candidateId,
    branchId: candidate.branchId,
    sourceNodeId: candidate.sourceNodeId,
    sourceParentId: candidate.sourceParentId,
    sourceStatus: candidate.sourceStatus,
    kind: candidate.kind,
    priority: candidate.priority,
    title: candidate.title,
    detail: candidate.detail,
    needs: candidate.needs,
    expected: candidate.expected,
    lowConfidence: candidate.lowConfidence,
  }));
  const branchBytesBefore = Buffer.byteLength(JSON.stringify(branchRuns ?? []), 'utf8');
  const candidateBytesBefore = Buffer.byteLength(JSON.stringify(rawCandidates), 'utf8');
  const branchBytesAfter = Buffer.byteLength(JSON.stringify(reports), 'utf8');
  const candidateBytesAfter = Buffer.byteLength(JSON.stringify(candidates), 'utf8');
  const text = [
    'You are the L1 lead. Use the bounded L0 BranchReports and the pending candidate queue to materialize the next useful nodes.',
    'Create at most one successor per completed leaf. Return proposals with parentId, title, prompt, rationale.',
    'If a proposal implements one of the pending branch-report candidates, set candidateId to that exact id.',
    'A candidate is consumed only when the Host creates its node; repeating the same candidate without creating a node is useless.',
    'For every pending candidate you do not implement, return a candidateDecisions entry: candidateId, decision (blocked_by_failed_source, needs_human_scope_decision, duplicate_of_consumed, low_confidence_only, deferred_by_pass_limit, not_selected_by_lead, implemented), and a one-line reason.',
    'A retry/replace/decouple candidate whose sourceStatus is failed may be proposed under sourceParentId with the same scope and needs; the Host allows that one replacement even though the failed child exists.',
    timeboxLimitLine(project, 'lead'),
    'Escalate an exception instead of silently guessing; the chief is invisible to peers.',
    `Budget: at most ${ROLE_BUDGETS.lead.maxQueries} read calls; finish within ${roleTimeoutMs(project, 'lead') / 1000} seconds.`,
    '',
    ...(previousLeadFeedback ? ['', '# Previous lead rejection feedback', JSON.stringify(previousLeadFeedback)] : []),
    '',
    '# Branch reports',
    JSON.stringify(reports),
    '',
    '# Pending branch-report candidates',
    JSON.stringify({ shown: candidates.length, omitted: selection.omitted, dedupedConsumedKinds: selection.dedupedConsumed.length, candidates }),
    '',
    '# Review tree',
    JSON.stringify({ branchCount: review.branchCount, activeBranchCount: review.activeBranchCount, groupedTeams: review.groupedTeams, escalations: review.escalations }),
    '',
    `Project: ${project.id}`,
  ].join('\n');
  const afterCandidateSection = JSON.stringify({ shown: candidates.length, omitted: selection.omitted, dedupedConsumedKinds: selection.dedupedConsumed.length, candidates });
  const beforeCandidateSection = JSON.stringify({
    shown: rawCandidates.length,
    omitted: Math.max(0, pendingCandidates.length - rawCandidates.length),
    dedupedConsumedKinds: 0,
    candidates: rawCandidates,
  });
  const beforeText = text
    .replace(JSON.stringify(reports), JSON.stringify(Array.isArray(branchRuns) ? branchRuns : []))
    .replace(afterCandidateSection, beforeCandidateSection);
  return {
    text,
    stats: {
      inputBytes: Buffer.byteLength(text, 'utf8'),
      inputBytesBefore: Buffer.byteLength(beforeText, 'utf8'),
      branchReportBytesBefore: branchBytesBefore,
      branchReportBytesAfter: branchBytesAfter,
      candidateBytesBefore,
      candidateBytesAfter,
      candidateCount: pendingCandidates.length,
      candidateShown: candidates.length,
      candidateOmitted: selection.omitted,
      dedupedConsumedKinds: selection.dedupedConsumed.length,
      branchReportCount: reports.length,
      previousRejectionCount: previousLeadFeedback?.rejectedCount ?? 0,
    },
  };
}

function leadPrompt(project, review, branchRuns, pendingCandidates = [], options = {}) {
  return leadPromptParts(project, review, branchRuns, pendingCandidates, options).text;
}


// Round 34: these are the named reasons a pending candidate can carry when the
// lead did not materialize it. They are stable machine-readable codes; `reason`
// keeps the lead's own sentence next to the code.
const LEAD_DECISION_CODES = new Set([
  'blocked_by_failed_source',
  'needs_human_scope_decision',
  'duplicate_of_consumed',
  'low_confidence_only',
  'deferred_by_pass_limit',
  'not_selected_by_lead',
  'lead_claimed_implemented_unapplied',
  'proposal_rejected',
  'implemented',
]);

function boundedText(value, max) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function leadDecisionCode(row) {
  const rawDecision = typeof row?.decision === 'string' ? row.decision.trim().toLowerCase() : '';
  if (LEAD_DECISION_CODES.has(rawDecision)) return rawDecision;
  const rawReason = typeof row?.reason === 'string' ? row.reason.trim().toLowerCase() : '';
  for (const code of LEAD_DECISION_CODES) {
    if (rawReason === code || rawReason.startsWith(`${code}:`) || rawReason.startsWith(`${code} `)) return code;
  }
  return 'lead_declined';
}

/** Parse the lead's own per-candidate decisions, restricted to pending ids. */
function leadDecisionMap(output, pendingCandidates) {
  const pendingIds = new Set(pendingCandidates.map((candidate) => candidate.candidateId));
  const map = new Map();
  const rows = Array.isArray(output?.candidateDecisions) ? output.candidateDecisions : [];
  for (const row of rows) {
    const candidateId = typeof row?.candidateId === 'string' ? row.candidateId.trim() : '';
    if (!candidateId || !pendingIds.has(candidateId) || map.has(candidateId)) continue;
    map.set(candidateId, {
      decision: leadDecisionCode(row),
      reason: boundedText(row.reason, 1000) || 'lead gave no reason',
    });
  }
  return map;
}

const STRUCTURAL_REJECTION_CODES = new Set(['parent_already_has_successor', 'replacement_chain_exhausted']);

function rejectionReasonCode(result, candidate) {
  if (result?.code === 'candidate_not_pending') return 'duplicate_of_consumed';
  if (result?.code === 'max_proposals') return 'deferred_by_pass_limit';
  if (result?.code === 'replacement_chain_exhausted') return 'replacement_chain_exhausted';
  if (result?.code === 'invalid_timebox') return 'invalid_timebox';
  if (result?.code === 'parent_already_has_successor') {
    return candidate?.sourceStatus === 'failed' || candidate?.sourceStatus === 'cancelled'
      ? 'blocked_by_failed_source'
      : 'duplicate_of_consumed';
  }
  const reason = String(result?.reason ?? '');
  if (/replacement for .* already exists|already has a live successor/i.test(reason)) return 'duplicate_of_consumed';
  if (candidate?.lowConfidence) return 'low_confidence_only';
  if (/model/i.test(reason)) return 'needs_human_scope_decision';
  return 'proposal_rejected';
}

/** Every pending candidate gets one named decision, even if the lead omitted it. */
function candidateDecisionRows({ pendingCandidates, applied, project, nodes, leadDecisions }) {
  const resultsByCandidate = new Map();
  for (const result of applied?.proposalResults ?? []) {
    if (result?.candidateId && !resultsByCandidate.has(result.candidateId)) resultsByCandidate.set(result.candidateId, result);
  }
  const successful = new Set((applied?.createdCandidates ?? []).map((row) => row.candidateId).filter(Boolean));
  const consumedThisCycle = new Set(applied?.consumedCandidateIds ?? []);
  // Use prior consumptions for the "this branch was already advanced" fallback.
  // A retry created in this same cycle must not make its siblings look like
  // duplicates of an earlier consumed candidate.
  const consumedBranches = new Set((project?.candidateConsumptions ?? [])
    .filter((row) => !consumedThisCycle.has(row.candidateId))
    .map((row) => row.branchId)
    .filter(Boolean));
  const parentsOf = (node) => (Array.isArray(node.parentIds) && node.parentIds.length > 0 ? node.parentIds : (node.parentId ? [node.parentId] : []));
  return pendingCandidates.map((candidate) => {
    const result = resultsByCandidate.get(candidate.candidateId) ?? null;
    if (successful.has(candidate.candidateId) || result?.status === 'created') {
      return {
        candidateId: candidate.candidateId,
        branchId: candidate.branchId,
        sourceNodeId: candidate.sourceNodeId,
        kind: candidate.kind,
        lowConfidence: candidate.lowConfidence,
        decision: 'created',
        reasonCode: 'created',
        skipReason: null,
        reason: 'Host created the proposal node',
        nodeId: result?.nodeId ?? (applied?.createdCandidates ?? []).find((row) => row.candidateId === candidate.candidateId)?.nodeId ?? null,
      };
    }
    if (result?.status === 'rejected') {
      const reasonCode = rejectionReasonCode(result, candidate);
      return {
        candidateId: candidate.candidateId,
        branchId: candidate.branchId,
        sourceNodeId: candidate.sourceNodeId,
        kind: candidate.kind,
        lowConfidence: candidate.lowConfidence,
        decision: 'rejected',
        reasonCode,
        skipReason: reasonCode,
        reason: boundedText(result.reason, 1000),
        code: result.code ?? null,
        proposalIndex: result.index ?? null,
      };
    }
    const lead = leadDecisions.get(candidate.candidateId) ?? null;
    if (lead) {
      const code = lead.decision === 'implemented' ? 'lead_claimed_implemented_unapplied' : lead.decision;
      return {
        candidateId: candidate.candidateId,
        branchId: candidate.branchId,
        sourceNodeId: candidate.sourceNodeId,
        kind: candidate.kind,
        lowConfidence: candidate.lowConfidence,
        decision: 'lead_declined',
        reasonCode: code,
        skipReason: code,
        reason: lead.reason,
        leadDecision: lead.decision,
      };
    }
    let reasonCode = 'not_selected_by_lead';
    let reason = 'lead returned no proposal or decision for this candidate';
    if (candidate.lowConfidence) {
      reasonCode = 'low_confidence_only';
      reason = 'candidate confidence is below 0.5; the lead did not spend a proposal on it';
    } else if (candidate.sourceStatus === 'failed' || candidate.sourceStatus === 'cancelled') {
      reasonCode = 'blocked_by_failed_source';
      reason = `source ${candidate.sourceNodeId} is ${candidate.sourceStatus}; retry/replacement was not proposed`;
    } else if (consumedBranches.has(candidate.branchId)) {
      reasonCode = 'duplicate_of_consumed';
      reason = `branch ${candidate.branchId} already has a consumed candidate and was not advanced again`;
    } else if (nodes.some((node) => node.id !== candidate.branchId && parentsOf(node).includes(candidate.branchId) && node.status !== 'failed' && node.status !== 'cancelled')) {
      reasonCode = 'branch_already_advanced';
      reason = `branch ${candidate.branchId} already has a live child; the candidate was not selected`;
    } else if (candidate.kind === 'split' || candidate.kind === 'decouple') {
      reasonCode = 'needs_human_scope_decision';
      reason = `${candidate.kind} changes scope and needs an explicit scope decision`;
    }
    return {
      candidateId: candidate.candidateId,
      branchId: candidate.branchId,
      sourceNodeId: candidate.sourceNodeId,
      kind: candidate.kind,
      lowConfidence: candidate.lowConfidence,
      decision: 'not_selected',
      reasonCode,
      skipReason: reasonCode,
      reason,
    };
  });
}

function decisionSummary(decisions) {
  const counts = new Map();
  for (const row of decisions) {
    counts.set(row.reasonCode, (counts.get(row.reasonCode) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([code, count]) => `${code}=${count}`).join(', ');
}

function leadStallReason({ proposalCount, applied, decisions, pendingCount }) {
  const summary = decisionSummary(decisions);
  if (proposalCount === 0) {
    return `lead returned 0 proposals for ${pendingCount} pending candidate(s); ${summary || 'no candidate decisions'}`;
  }
  const firstRejection = applied?.rejected?.[0]?.reason;
  return firstRejection
    ? `lead made ${proposalCount} proposal(s) but created 0; first rejection: ${boundedText(firstRejection, 300)} (${summary})`
    : `lead made ${proposalCount} proposal(s) but created 0; ${summary || 'no candidate decisions'}`;
}

/**
 * Round 37: a rejected proposal must be visible to the next lead activation.
 * The cycle trace keeps the rejection; this compacts the most recent one into a
 * small prompt section (count + first reason, with up to three examples).
 */
function mostRecentLeadFeedback(cycles, currentCycleId) {
  for (const cycle of Array.isArray(cycles) ? cycles : []) {
    if (!cycle || cycle.id === currentCycleId) continue;
    const lead = cycle.lead;
    if (!lead) continue;
    const rejected = Array.isArray(lead.rejected) ? lead.rejected : [];
    const proposalRejections = (Array.isArray(lead.proposals) ? lead.proposals : [])
      .filter((proposal) => proposal?.status === 'rejected' && proposal?.rejection);
    const rows = rejected.length > 0 ? rejected : proposalRejections.map((proposal) => ({
      parentId: proposal.parentId,
      title: proposal.title,
      candidateId: proposal.candidateId,
      reason: proposal.rejection,
      code: null,
    }));
    if (rows.length === 0) continue;
    const first = rows[0];
    return {
      cycleId: cycle.id,
      proposalCount: Number(lead.proposalCount ?? lead.considered ?? 0),
      rejectedCount: rows.length,
      firstRejection: {
        parentId: first.parentId ?? null,
        candidateId: first.candidateId ?? null,
        title: boundedText(first.title, 300),
        reason: boundedText(first.reason, 1000),
        code: first.code ?? null,
      },
      rejected: rows.slice(0, 3).map((row) => ({
        parentId: row.parentId ?? null,
        candidateId: row.candidateId ?? null,
        title: boundedText(row.title, 200),
        reason: boundedText(row.reason, 500),
        code: row.code ?? null,
      })),
    };
  }
  return null;
}

/** Persist the lead's actual answer next to the Host's per-candidate decisions. */
function buildLeadTrace({ leadRun, applied, decisions, skipReason, input = null }) {
  const output = leadRun?.record?.output ?? null;
  const proposals = Array.isArray(output?.proposals) ? output.proposals : [];
  const results = new Map((applied?.proposalResults ?? []).map((row) => [row.index, row]));
  const leadRows = Array.isArray(output?.candidateDecisions) ? output.candidateDecisions : [];
  return {
    runId: leadRun?.record?.id ?? null,
    status: leadRun?.failure ? 'failed' : (output ? 'completed' : 'no_output'),
    error: leadRun?.record?.error ?? null,
    timeoutMs: leadRun?.record?.timeoutMs ?? null,
    timeoutSource: leadRun?.record?.timeoutSource ?? null,
    analysis: boundedText(output?.analysis, 6000),
    note: boundedText(output?.note, 3000),
    needUserDecision: output?.needUserDecision === true,
    considered: proposals.length,
    proposalCount: proposals.length,
    proposals: proposals.slice(0, 50).map((proposal, index) => ({
      index,
      candidateId: typeof proposal?.candidateId === 'string' ? proposal.candidateId : null,
      parentId: proposal?.parentId ?? null,
      title: boundedText(proposal?.title, 300),
      status: results.get(index)?.status ?? (index >= (applied?.proposalResults?.length ?? 0) ? 'not_processed' : 'unknown'),
      nodeId: results.get(index)?.nodeId ?? null,
      rejection: results.get(index)?.reason ?? null,
    })),
    leadCandidateDecisions: leadRows.slice(0, 200).map((row) => ({
      candidateId: typeof row?.candidateId === 'string' ? row.candidateId : null,
      decision: typeof row?.decision === 'string' ? boundedText(row.decision, 200) : null,
      reason: boundedText(row?.reason, 1000),
    })),
    rejected: (applied?.rejected ?? []).slice(0, 50).map((row) => ({
      parentId: row?.parentId ?? null,
      title: boundedText(row?.title, 300),
      candidateId: row?.candidateId ?? null,
      reason: boundedText(row?.reason, 1000),
      code: row?.code ?? null,
    })),
    decisions,
    candidateDecisions: decisions,
    decisionCounts: decisions.reduce((acc, row) => {
      acc[row.reasonCode] = (acc[row.reasonCode] ?? 0) + 1;
      return acc;
    }, {}),
    inputBytes: Number(leadRun?.record?.inputBytes) || Number(input?.inputBytes) || 0,
    inputBytesBefore: Number.isFinite(Number(input?.inputBytesBefore)) ? Number(input.inputBytesBefore) : null,
    branchReportBytesBefore: input?.branchReportBytesBefore ?? null,
    branchReportBytesAfter: input?.branchReportBytesAfter ?? null,
    candidateBytesBefore: input?.candidateBytesBefore ?? null,
    candidateBytesAfter: input?.candidateBytesAfter ?? null,
    candidateCount: input?.candidateCount ?? null,
    candidateShown: input?.candidateShown ?? null,
    candidateOmitted: input?.candidateOmitted ?? null,
    dedupedConsumedKinds: input?.dedupedConsumedKinds ?? null,
    skipReason,
  };
}

function chiefPrompt(project, node, review) {
  return [
    'You are the L2 chief. Decide one routed exception. You may keep, defer or withdraw the node.',
    'A keep requires at least one verified raw-data pointer and a non-empty evidence chain.',
    'Do not create nodes or run the experiment; the lead already materialized the optimistic p2 child.',
    `Budget: at most ${ROLE_BUDGETS.chief.maxQueries} read calls; finish within ${roleTimeoutMs(project, 'chief') / 1000} seconds.`,
    '',
    '# Pending node',
    JSON.stringify({ id: node.id, title: node.title, priority: node.priority, pendingHighReview: node.pendingHighReview }),
    '',
    '# Review tree',
    JSON.stringify({ branchCount: review.branchCount, escalations: review.escalations, reports: review.reports.map((r) => ({ branchId: r.branchId, health: r.health, evidence: r.evidence })) }),
    '',
    `Project: ${project.id}`,
  ].join('\n');
}

function advisorPrompt(project, snapshot, lens) {
  const custom = project.config?.prompts?.advisor;
  return [
    lens ? `Perspective for this review pass (one of several independent reviewers): ${lens}` : '',
    custom && custom.trim() ? custom.trim() : DEFAULT_ADVISOR_PROMPT,
    activeSkillSection(['advisor', 'reviewer'], project.id),
    '',
    '# Rules',
    '1. The payload is intentionally incomplete. `focus` holds up to 8 active leaves; navigate with',
    '   dag_query (filter by status / subtreeOf / depth / since / text) and dag_get(nodeIds). A parent must be',
    '   a completed leaf with a commit; a completed node that already has a child cannot be extended.',
    '2. Size the proposal count to idle capacity: resources.free / resources.maxRunningNodes say how many',
    '   slots are idle. When free slots exceed the runnable nodes, propose 2-4 INDEPENDENT successors so the',
    '   queue does not drain; when capacity is tight (free < 2) propose only the best next step.',
    '   Never exceed policy.maxProposalsPerReviewer in one answer: the Host rejects the extras.',
    '3. Each proposal prompt must be self-contained: a fresh agent with only the project brief, the',
    '   parent worktree and ancestor summaries must be able to execute it.',
    '4. needs is an array of {key, amount}; keys must be in resources.pools and within the pool size.',
    `4b. ${timeboxLimitLine(project, 'advisor')}`,
    '5. Never re-propose a hypothesis in ledger.ruledOut, and build on ledger.confirmed. If the ledger is',
    '   empty, that is a signal to explore, not a licence to repeat the obvious. Record new hypotheses with',
    '   the ledger_update tool so later passes do not relitigate them.',
    '6. Do not duplicate an existing node or a recent proposal (recentProposals).',
    '7. A failed node with errorStage=timeout was killed deterministically: you may split the task,',
    '   extend its timebox with a concrete reason, try another approach, or abandon the branch.',
    '8. Return proposals: [] when nothing is worth doing.',
    '9. Submit your entire answer through structured_output.',
    '10. Optional: recommend a model for a proposal via recommendedModel {profileId or provider/model/reasoningEffort, rationale}.',
    '   It is only honored when the project enables advisor model selection and the Host allowlist accepts it.',
    '11. Optional: set executionProfile (or taskType mapped by config.execution.taskTypes) to select a',
    '    local execution runtime such as a Codex profile. The Host rejects unknown profiles.',
    '',
    '# Snapshot',
    // Compact JSON: the snapshot is dominated by candidateParents and pretty-printing
    // it costs ~13% of the prompt for no benefit to the model.
    JSON.stringify(snapshot),
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
    activeSkillSection(['scheduler'], project.id),
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
  const totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0 };
  try {
    const snapshot = await ctx.sessionQuery.readSurface(sessionId);
    for (const event of snapshot?.events ?? []) {
      if (typeof event?.type === 'string' && /tool/.test(event.type) && !/result/.test(event.type)) totals.toolCalls += 1;
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
  // Per-reviewer cap: one lens cannot fill the whole pass, otherwise a single
  // chatty reviewer crowds out every other perspective (and the DAG stays one
  // node wide). Independent reviewers each get their own slice of the budget.
  const perReviewer = Math.max(1, project.config.advisor?.maxProposalsPerReviewer ?? 2);
  const seen = new Set();
  const proposals = [];
  for (const output of outputs) {
    if (!output || typeof output !== 'object') continue;
    let taken = 0;
    for (const proposal of Array.isArray(output.proposals) ? output.proposals : []) {
      if (taken >= perReviewer) break;
      const key = `${proposal?.parentId ?? ''}::${promptHash(proposal?.prompt ?? '')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      proposals.push(proposal);
      taken += 1;
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
export function createOrchestrator({ ctx, store, git, runtime, cluster, kernel }) {
  /**
   * Review claims (QA Q9): one expert at a time may propose a successor for one
   * parent. The board is liveness state; durable claim events are written by
   * the intent log once the expert runtime lands.
   */
  const reviewClaims = createReviewClaimBoard();
  const ledgerReader = createLedgerReader({ store });
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

  async function commitMutations(projectId, mutations, options = {}) {
    if (!kernel?.executor) throw new LabError('unavailable', 'orchestrator requires kernel.executor', 503);
    const spec = {
      actor: options.actor ?? { kind: 'system', id: options.source ?? 'orchestrator' },
      causeId: options.causeId ?? `orchestrator:${projectId}`,
      mutations,
    };
    const result = store.isProjectLocked?.(projectId) === true
      ? await store.withWritePermit(() => kernel.executor.commitLocked(projectId, spec))
      : await kernel.executor.commit(projectId, spec);
    if (result.ok !== true) throw new LabError(result.code ?? 'commit_failed', result.message ?? 'commit failed', 500);
    return result;
  }

  async function persistEvent(project, type, payload = {}) {
    return commitMutations(project.id, [{
      op: 'event.record',
      type,
      ...(payload.nodeId ? { nodeId: payload.nodeId } : {}),
      data: payload.data ?? {},
    }], { causeId: payload.causeId ?? `${type}:${project.id}` });
  }

  async function saveRun(projectId, record, eventType = 'run/saved', eventData = undefined) {
    return commitMutations(projectId, [{
      op: 'run.put',
      run: record,
      eventType,
      ...(eventData ? { eventData } : {}),
    }], { causeId: `${eventType}:${record.id}` });
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

  /** Per-project advisor wall-clock budget (seconds -> ms), with the measured default. */

  async function runRole(project, role, cycle, promptText, schema, inputSnapshot, options = {}) {
    // The Host provider validates this before an activation starts; failing
    // here names the role and prevents a malformed schema from becoming a
    // silent lead-stage skip after the branch reports have already failed.
    assertModelSchema(schema, role);
    const controller = await ensureController(project);
    const id = runId();
    const sessionId = newSessionId();
    const model = options.modelOverride
      ? { ...options.modelOverride }
      : roleModel(project, role);
    const preset = ROLE_PRESETS[role] ?? 'lab-scheduler';
    const roleBudget = ROLE_BUDGETS[role] ?? null;
    const maxQueries = Number.isFinite(Number(options.maxQueries)) ? Number(options.maxQueries) : roleBudget?.maxQueries ?? null;
    const resolvedTimeoutMs = Number(options.timeoutMs);
    const timeoutMs = Math.max(
      30_000,
      Math.min(1_800_000, Number.isFinite(resolvedTimeoutMs) && resolvedTimeoutMs > 0
        ? resolvedTimeoutMs
        : roleTimeoutMs(project, role)),
    );
    const timeoutSource = roleTimeoutSource(project, role);
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
      preset,
      timeoutMs,
      timeoutSource,
      budget: maxQueries ? { maxQueries, timeoutMs } : { timeoutMs },
      startedAt: Date.now(),
      // Observability: the real prompt size in bytes, and the snapshot size as
      // a separate regression metric (B3 in the observability package).
      inputBytes: Buffer.byteLength(promptText, 'utf8'),
      snapshotBytes: Buffer.byteLength(JSON.stringify(inputSnapshot ?? {}), 'utf8'),
    };
    await saveRun(project.id, record, `${role}/started`, { runId: id, cycleId: cycle.id });

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
            () => reject(new LabError('run_timeout', `${role} run exceeded ${timeoutMs / 1000}s (role=${role}, timeoutMs=${timeoutMs}, source=${timeoutSource})`, 504)),
            timeoutMs,
          );
          timer.unref?.();
        }),
      ]);
      if (result?.stopReason !== 'completed') {
        failure = new Error(`${role} stopped: ${result?.stopReason} (timeoutMs=${timeoutMs}, source=${timeoutSource})`);
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
    if (!failure && maxQueries && Number(record.usage.toolCalls ?? 0) > maxQueries) {
      failure = new LabError('query_budget_exceeded', `${role} used ${record.usage.toolCalls} tool calls, budget ${maxQueries}`, 429);
    }
    if (failure) {
      record.status = 'failed';
      record.stopReason = 'error';
      record.error = failure instanceof Error ? failure.message : String(failure);
      record.errorCode = failure?.code ?? null;
    } else {
      record.status = 'completed';
      record.stopReason = 'completed';
      record.output = result?.structured ?? null;
      if (record.output && typeof record.output.analysis === 'string') record.analysis = record.output.analysis;
      if (!record.output) record.rawText = blocksText(result?.output);
    }
    await saveRun(project.id, record, `${role}/finished`, {
      runId: id,
      status: record.status,
      error: record.error ?? null,
      created: record.createdNodeIds?.length ?? 0,
    });
    return { record, failure };
  }

  function normalizeNeeds(raw, project) {
    if (raw === undefined || raw === null) return { needs: {}, error: null };
    // Two callers exist: advisor structured output sends [{key, amount}] while
    // the agent tool / project config use the compact {gpu: 4} form. Accept
    // both here so a user-facing `successor` call cannot fail on a shape the
    // tool description advertises.
    let entries;
    if (Array.isArray(raw)) {
      entries = raw;
    } else if (typeof raw === 'object') {
      entries = Object.entries(raw).map(([key, amount]) => ({ key, amount }));
    } else {
      return { needs: {}, error: 'needs must be an object {gpu: 4} or an array of {key, amount}' };
    }
    const needs = {};
    for (const item of entries) {
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

  function checkProposal(project, proposal, nodes, candidate = null) {
    const parentId = typeof proposal?.parentId === 'string' ? proposal.parentId : '';
    if (!parentId) return { ok: false, reason: 'parentId is required' };
    const parent = nodes.find((node) => node.id === parentId);
    if (!parent || parent.status !== 'completed') return { ok: false, reason: `parent ${parentId} is not completed` };
    if (!parent.git?.headCommit) return { ok: false, reason: `parent ${parentId} has no commit` };
    const parentsOf = (node) => (Array.isArray(node.parentIds) && node.parentIds.length > 0 ? node.parentIds : (node.parentId ? [node.parentId] : []));
    const sourceNodeId = typeof candidate?.sourceNodeId === 'string' ? candidate.sourceNodeId : '';
    const source = sourceNodeId ? nodes.find((node) => node.id === sourceNodeId) ?? null : null;
    const sourceFailed = Boolean(source && (source.status === 'failed' || source.status === 'cancelled'));
    // Round 34: a failed child blocks ordinary succession, but it must not
    // block its own retry/replacement. The replacement is a sibling under the
    // failed node's completed parent, with the same scope and needs unless the
    // lead overrides them.
    const replacingFailedSource = Boolean(sourceFailed && parentsOf(source).includes(parentId));
    const children = nodes.filter((node) => node.id !== parentId && parentsOf(node).includes(parentId));
    const blockingChildren = children.filter((node) => node.status !== 'proposed');
    let replacementTarget = null;
    if (replacingFailedSource) {
      // Round 36: a failed replacement is not a live successor. Walk the
      // replacesNodeId chain so A(failed) -> B(failed) can produce C, and C's
      // replacesNodeId points at B. Cap the chain at three attempts so a scope
      // cannot be retried forever; a fourth proposal gets a named rejection.
      const chain = replacementChainForNode(nodes, source.id);
      const chainIds = new Set(chain.map((node) => node.id));
      const chainLabel = chain.map((node) => node.id).join(' -> ');
      const liveReplacement = chain.find((node) => node.id !== source.id && node.status !== 'failed' && node.status !== 'cancelled');
      if (liveReplacement) {
        return {
          ok: false,
          code: 'replacement_chain_exhausted',
          reason: `replacement chain for ${chain[0]?.id ?? source.id} already reached live node ${liveReplacement.id} (${chainLabel}); no further attempt`,
        };
      }
      if (chain.length >= 3) {
        return {
          ok: false,
          code: 'replacement_chain_exhausted',
          reason: `replacement chain for ${chain[0]?.id ?? source.id} exhausted after 3 attempts (${chainLabel}); no further attempt`,
        };
      }
      const liveChild = blockingChildren.find((node) => node.id !== source.id && !chainIds.has(node.id) && node.status !== 'failed' && node.status !== 'cancelled');
      if (liveChild) {
        return {
          ok: false,
          code: 'parent_already_has_successor',
          reason: `parent ${parentId} already has a live successor ${liveChild.id}; only the failed child ${source.id} is retryable`,
        };
      }
      const terminal = chain.at(-1) ?? source;
      replacementTarget = terminal.id;
    } else if (blockingChildren.length > 0) {
      return { ok: false, code: 'parent_already_has_successor', reason: `parent ${parentId} already has a successor; propose from a leaf` };
    }
    // A title is a label, not an instruction: clamp it instead of rejecting the
    // whole proposal (rejections here used to starve the auto driver silently).
    const title = clampNodeTitle(proposal?.title || (source?.title ? `Retry ${source.title}` : ''));
    const prompt = typeof proposal?.prompt === 'string' && proposal.prompt.trim()
      ? proposal.prompt.trim()
      : (typeof source?.prompt === 'string' ? source.prompt.trim() : '');
    if (isBlank(title)) return { ok: false, reason: 'title is required' };
    if (prompt.length < 10 || prompt.length > 8000) return { ok: false, reason: 'prompt must be 10..8000 characters' };
    const rawNeeds = proposal?.needs === undefined || proposal?.needs === null ? source?.needs : proposal.needs;
    const { needs, error } = normalizeNeeds(rawNeeds, project);
    if (error) return { ok: false, reason: error };
    const bounds = nodeTimeboxBounds(project);
    const sourceTimeboxMinutes = source?.timeboxMs ? Math.ceil(source.timeboxMs / 60_000) : null;
    const requestedTimebox = proposal?.timeboxMinutes;
    const timeboxMinutes = requestedTimebox === undefined || requestedTimebox === null
      ? (sourceTimeboxMinutes ?? bounds.default)
      : requestedTimebox;
    if (!Number.isInteger(timeboxMinutes) || timeboxMinutes < bounds.min || timeboxMinutes > bounds.max) {
      return {
        ok: false,
        code: 'invalid_timebox',
        reason: `timeboxMinutes must be ${bounds.min}..${bounds.max} (got ${formatReceivedValue(timeboxMinutes)})`,
      };
    }
    const hash = promptHash(prompt);
    if (!replacingFailedSource && nodes.some((node) => node.parentId === parentId && promptHash(node.prompt) === hash)) {
      return { ok: false, reason: 'duplicate proposal (same parent and prompt hash)' };
    }
    if (nodes.length >= (project.config.maxNodes ?? 60)) return { ok: false, reason: 'maxNodes reached' };
    let execution;
    try {
      execution = resolveExecutionProfile(project, {
        executionProfile: proposal?.executionProfile ?? source?.execution?.profile,
        taskType: proposal?.taskType ?? source?.taskType,
        // A wrong profile name in a suggestion is not a reason to throw the
        // experiment away; it falls back to the project default and the cycle
        // records the correction.
        fallbackToDefault: true,
      });
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    return {
      ok: true,
      parent,
      replacesNodeId: replacingFailedSource ? replacementTarget : null,
      executionNote: execution.profileFallback
        ? { requestedProfile: execution.requestedProfile, usedProfile: execution.profile }
        : null,
      spec: {
        title,
        prompt,
        successCriteria: typeof proposal.successCriteria === 'string' ? proposal.successCriteria.trim() : '',
        needs,
        timeboxMinutes,
        model: null,
        execution,
        ...(replacingFailedSource ? { replacesNodeId: replacementTarget } : {}),
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
    await commitMutations(project.id, [{
      op: 'node.put',
      node: parent,
      eventType: 'node/sealed',
      eventData: { tag, headCommit: head },
    }], { causeId: `seal:${parent.id}` });
  }

  /**
   * Round 33: consume a branch-report candidate in the same Host commit that
   * creates its node. Recording the nodeId is the cause/lineage link; no text
   * comparison is involved.
   */
  function candidateConsumptionMutation(project, meta, nodeId) {
    if (!meta?.candidateId) return null;
    const record = {
      candidateId: meta.candidateId,
      branchId: meta.candidate?.branchId ?? null,
      sourceNodeId: meta.candidate?.sourceNodeId ?? null,
      kind: meta.candidate?.kind ?? null,
      nodeId,
      runId: meta.runId ?? null,
      consumedAt: Date.now(),
    };
    return {
      op: 'project.update',
      set: { candidateConsumptions: [...(project.candidateConsumptions ?? []), record].slice(-MAX_CONSUMPTIONS) },
      eventType: 'review/candidate_consumed',
      eventData: record,
    };
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
      promptHash: promptHash(spec.prompt),
      successCriteria: spec.successCriteria ?? '',
      status: 'proposed',
      parentId: parent.id,
      createdBy: meta.createdBy,
      createdByRunId: meta.runId ?? null,
      ...(meta.candidateId ? { candidateId: meta.candidateId } : {}),
      ...(spec.replacesNodeId ? { replacesNodeId: spec.replacesNodeId } : {}),
      ...(meta.reviewLevel ? { reviewLevel: meta.reviewLevel, ratifiedBy: null } : {}),
      ...(meta.pendingHighReview ? { pendingHighReview: meta.pendingHighReview, highReview: { status: 'pending', openedAt: meta.pendingHighReview.openedAt } } : {}),
      ...(meta.expected ? { expected: meta.expected, expectedBaseline: meta.expectedBaseline ?? null } : {}),
      ...(spec.model ? { model: spec.model } : {}),
      execution: spec.execution
        ? {
            profile: spec.execution.profile,
            driver: spec.execution.driver,
            ...(spec.execution.model ? { model: spec.execution.model } : {}),
            ...(spec.execution.reasoningEffort ? { reasoningEffort: spec.execution.reasoningEffort } : {}),
            ...(spec.execution.codexPath ? { codexPath: spec.execution.codexPath } : {}),
          }
        : { profile: 'dsh', driver: 'dsh' },
      taskType: spec.execution?.taskType ?? '',
      needs: spec.needs ?? {},
      timeboxMs: spec.timeboxMinutes * 60_000,
      anchorSessionId: newSessionId(),
      sessionId: newSessionId(),
      deadlineAt: null,
      proposal: {
        runId: meta.runId ?? null,
        rationale: meta.rationale ?? null,
        expectedInfoGain: meta.expectedInfoGain ?? null,
        ...(meta.expected ? { expected: meta.expected, expectedBaseline: meta.expectedBaseline ?? null } : {}),
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
    const counters = {
      ...project.counters,
      nextNodeSeq: (project.counters.nextNodeSeq ?? 2) + 1,
      nodes: (project.counters.nodes ?? 0) + 1,
    };
    const proposalIntent = createIntent({
      id: intentId('proposal', project.revision + 1, meta.createdBy ?? 'advisor'),
      kind: 'proposal',
      actor: { kind: 'expert', id: meta.createdBy ?? 'advisor' },
      claim: {
        action: 'propose_node',
        parentId: parent.id,
        title: node.title,
        expectedInfoGain: meta.expectedInfoGain ?? null,
        ...(meta.expected ? { expected: meta.expected } : {}),
      },
      basis: basisFor(project.revision, store.listNodes(project.id).length),
      target: { nodeId, parentId: parent.id },
      rationale: meta.rationale ?? null,
    });
    const mutations = [{
      op: 'node.create',
      node,
      counters,
      eventType: 'node/proposed',
      eventData: { title: node.title, parentId: parent.id, createdBy: node.createdBy, timeboxMinutes: spec.timeboxMinutes },
    }, intentMutation(proposalIntent)];
    const consumption = candidateConsumptionMutation(project, meta, nodeId);
    if (consumption) mutations.push(consumption);
    const result = await commitMutations(project.id, mutations, { causeId: `intent:${proposalIntent.id}` });
    if (result.ok !== true) throw new LabError(result.code ?? 'commit_failed', result.message ?? 'proposal commit failed', 500);
    return store.getNode(project.id, nodeId);
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
      promptHash: promptHash(spec.prompt),
      successCriteria: spec.successCriteria ?? '',
      status: 'planned',
      ...(meta.createdBy === 'user'
        ? { priority: { class: 'p0', by: 'human', reason: 'human request', at: now } }
        : (meta.reviewLevel ? { priority: { class: 'p2', by: meta.createdBy, reason: 'lead materialization', at: now } } : {})),
      ...(meta.escalationDenied ? { escalationDenied: meta.escalationDenied } : {}),
      parentId: parent.id,
      createdBy: meta.createdBy,
      createdByRunId: meta.runId ?? null,
      ...(meta.candidateId ? { candidateId: meta.candidateId } : {}),
      ...(spec.replacesNodeId ? { replacesNodeId: spec.replacesNodeId } : {}),
      ...(meta.reviewLevel ? { reviewLevel: meta.reviewLevel, ratifiedBy: null } : {}),
      ...(meta.pendingHighReview ? { pendingHighReview: meta.pendingHighReview, highReview: { status: 'pending', openedAt: meta.pendingHighReview.openedAt } } : {}),
      ...(meta.expected ? { expected: meta.expected, expectedBaseline: meta.expectedBaseline ?? null } : {}),
      ...(spec.model ? { model: spec.model } : {}),
      execution: spec.execution
        ? {
            profile: spec.execution.profile,
            driver: spec.execution.driver,
            ...(spec.execution.model ? { model: spec.execution.model } : {}),
            ...(spec.execution.reasoningEffort ? { reasoningEffort: spec.execution.reasoningEffort } : {}),
            ...(spec.execution.codexPath ? { codexPath: spec.execution.codexPath } : {}),
          }
        : { profile: 'dsh', driver: 'dsh' },
      taskType: spec.execution?.taskType ?? '',
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
    const counters = {
      ...project.counters,
      nextNodeSeq: (project.counters.nextNodeSeq ?? 2) + 1,
      nodes: (project.counters.nodes ?? 0) + 1,
    };
    const hierarchy = meta.hierarchy === true;
    const vote = hierarchy
      ? childVoteWeight({ project, nodes: store.listNodes(project.id), parent, child: node, expertId: meta.createdBy, now })
      : null;
    if (vote && vote.weight === 0) {
      throw new LabError(vote.reason === 'duplicate' ? 'duplicate_child' : 'vote_quota_exceeded', `child creation vote rejected: ${vote.reason}`, 409);
    }
    const mutations = [{
      op: 'node.create',
      node,
      counters,
      eventType: 'node/created',
      eventData: {
        title: node.title,
        parentId: parent.id,
        createdBy: node.createdBy,
        baseCommit: head,
        timeboxMinutes: spec.timeboxMinutes,
        ...(vote ? { voteWeight: vote.weight } : {}),
      },
    }];
    if (vote?.vote) {
      mutations.push({
        op: 'project.update',
        set: { childVotes: [...(project.childVotes ?? []), vote.vote] },
        eventType: 'review/vote_counted',
        eventData: { expertId: vote.vote.expertId, nodeId: vote.vote.nodeId, parentId: vote.vote.parentId, weight: 1 },
      });
    }
    if (meta.escalation) {
      mutations.push({
        op: 'project.update',
        set: { reviewEscalations: [...(project.reviewEscalations ?? []), meta.escalation] },
        eventType: 'review/escalated',
        eventData: { leadId: meta.escalation.leadId, branchId: meta.escalation.branchId, codes: meta.escalation.codes, epoch: meta.escalation.epoch },
      });
    }
    const consumption = candidateConsumptionMutation(project, meta, nodeId);
    if (consumption) mutations.push(consumption);
    await commitMutations(project.id, mutations, { causeId: `create:${nodeId}` });

    await sealParent(project, parent, head);
    return store.getNode(project.id, nodeId);
  }

  /**
   * Round 33: bind a proposal to a pending branch-report candidate. The lead is
   * asked to echo candidateId. If it omits it, use node lineage (a candidate
   * whose source node is the parent or an ancestor), then the parent's branch.
   * No title/prompt text comparison is used.
   */
  function candidateForProposal(proposal, parent, nodes, pendingCandidates) {
    const explicit = typeof proposal?.candidateId === 'string' ? proposal.candidateId.trim() : '';
    if (explicit) {
      const candidate = pendingCandidates.find((row) => row.candidateId === explicit);
      return candidate ? { candidate, explicit: true } : { candidate: null, explicit: true, unknown: explicit };
    }
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const parentIdsOf = (node) => (Array.isArray(node.parentIds) && node.parentIds.length > 0 ? node.parentIds : (node.parentId ? [node.parentId] : []));
    const parentNodeId = parent?.id ?? '';
    // A retry's source is the failed child, not an ancestor of the parent. Match
    // that direct failed child before falling back to lineage/branch so an
    // omitted candidateId cannot bind a retry to an unrelated branch candidate.
    const failedChildren = new Set(nodes
      .filter((node) => parentNodeId && parentIdsOf(node).includes(parentNodeId) && (node.status === 'failed' || node.status === 'cancelled'))
      .map((node) => node.id));
    const failedChildMatch = pendingCandidates.find((row) => row.sourceNodeId && failedChildren.has(row.sourceNodeId));
    if (failedChildMatch) return { candidate: failedChildMatch, explicit: false };
    const ancestry = new Set();
    const stack = [parent];
    while (stack.length > 0) {
      const cursor = stack.pop();
      if (!cursor?.id || ancestry.has(cursor.id)) continue;
      ancestry.add(cursor.id);
      const parentIds = Array.isArray(cursor.parentIds) && cursor.parentIds.length > 0
        ? cursor.parentIds
        : (cursor.parentId ? [cursor.parentId] : []);
      for (const parentId of parentIds) {
        const ancestor = byId.get(parentId);
        if (ancestor) stack.push(ancestor);
      }
    }
    const lineageMatch = pendingCandidates.find((row) => row.sourceNodeId && ancestry.has(row.sourceNodeId));
    if (lineageMatch) return { candidate: lineageMatch, explicit: false };
    const branchId = parent ? branchIdOf(parent.id, byId) : null;
    const branchMatch = pendingCandidates.find((row) => row.branchId === branchId);
    return { candidate: branchMatch ?? null, explicit: false };
  }

  /**
   * Round 36: remember a candidate the DAG structurally rejects. The block carries
   * a fingerprint of the relevant parent/source/replacement chain; it expires by
   * itself when that structure changes (for example when a live replacement
   * fails), so a changed scope can be proposed again.
   */
  async function persistCandidateBlock(projectId, candidate, code, reason, cycleId) {
    if (!candidate?.candidateId || !STRUCTURAL_REJECTION_CODES.has(code)) return;
    const project = requireProject(projectId);
    const nodes = store.listNodes(projectId);
    const structureKey = candidateStructureKey(candidate, nodes);
    const now = Date.now();
    const blocks = project.candidateBlocks && typeof project.candidateBlocks === 'object' ? { ...project.candidateBlocks } : {};
    blocks[candidate.candidateId] = {
      code,
      reason: boundedText(reason, 1000),
      structureKey,
      at: now,
      cycleId,
      branchId: candidate.branchId ?? null,
      sourceNodeId: candidate.sourceNodeId ?? null,
      kind: candidate.kind ?? null,
    };
    const trimmed = Object.fromEntries(Object.entries(blocks)
      .sort(([, a], [, b]) => Number(b?.at ?? 0) - Number(a?.at ?? 0))
      .slice(0, 1000));
    await commitMutations(projectId, [{
      op: 'project.update',
      set: { candidateBlocks: trimmed },
      eventType: 'review/candidate_blocked',
      eventData: { candidateId: candidate.candidateId, code, reason: blocks[candidate.candidateId].reason, structureKey },
    }], { causeId: `candidate-block:${candidate.candidateId}` });
  }

  async function applyAdvisorOutput(projectId, cycle, output, pendingCandidates = []) {
    const applied = { createdNodeIds: [], rejected: [], consumedCandidateIds: [], createdCandidates: [], proposalResults: [] };
    if (!output || typeof output !== 'object') {
      applied.rejected.push({ reason: 'advisor run had no structured output' });
      return applied;
    }
    const proposals = Array.isArray(output.proposals) ? output.proposals : [];
    const expertId = `advisor:${cycle.advisorRunId ?? cycle.id}`;
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
    try {
    await store.withProjectLock(projectId, async () => {
      // Candidate parents are frozen for this pass: creating the first child seals
      // the parent, but later proposals from the same advisor answer may still
      // branch from that same (now frozen) parent commit.
      let project = requireProject(projectId);
      const max = project.config.advisor?.maxProposalsPerPass ?? 3;
      const extra = proposals.slice(max);
      for (const [extraIndex, proposal] of extra.entries()) {
        const reason = `maxProposalsPerPass=${max}`;
        const candidateId = typeof proposal?.candidateId === 'string' && proposal.candidateId.trim() ? proposal.candidateId.trim() : null;
        applied.rejected.push({ parentId: proposal?.parentId ?? null, title: proposal?.title ?? null, candidateId, reason, code: 'max_proposals' });
        applied.proposalResults.push({ index: max + extraIndex, candidateId, parentId: proposal?.parentId ?? null, title: proposal?.title ?? null, status: 'rejected', reason, code: 'max_proposals', nodeId: null });
      }
      let availableCandidates = [...pendingCandidates];
      for (const [proposalIndex, proposal] of proposals.slice(0, max).entries()) {
        project = requireProject(projectId);
        const nodes = store.listNodes(projectId);
        const result = {
          index: proposalIndex,
          candidateId: typeof proposal?.candidateId === 'string' && proposal.candidateId.trim() ? proposal.candidateId.trim() : null,
          parentId: proposal?.parentId ?? null,
          title: proposal?.title ?? null,
          status: 'rejected',
          reason: null,
          code: null,
          nodeId: null,
        };
        applied.proposalResults.push(result);
        const rejectResult = (reason, code = null) => {
          result.status = 'rejected';
          result.reason = reason;
          result.code = code;
          applied.rejected.push({
            parentId: proposal?.parentId ?? null,
            title: proposal?.title ?? null,
            candidateId: result.candidateId,
            reason,
            ...(code ? { code } : {}),
          });
        };
        const advisorModel = advisorModels.get(proposalIndex);
        const parent = nodes.find((node) => node.id === (typeof proposal?.parentId === 'string' ? proposal.parentId : '')) ?? null;
        const candidateSelection = candidateForProposal(proposal, parent, nodes, availableCandidates);
        if (candidateSelection.candidate) result.candidateId = candidateSelection.candidate.candidateId;
        if (candidateSelection.unknown) {
          rejectResult(`candidateId ${candidateSelection.unknown} is not pending`, 'candidate_not_pending');
          continue;
        }
        if (advisorModel?.error) {
          rejectResult(`recommendedModel rejected: ${advisorModel.error}`, 'recommended_model_rejected');
          continue;
        }
        const selectedCandidate = candidateSelection.candidate;
        const check = checkProposal(project, proposal, nodes, selectedCandidate);
        if (!check.ok) {
          const code = check.code ?? (/already has a successor|already has a live successor|replacement for .* already exists/.test(check.reason)
            ? 'parent_already_has_successor'
            : null);
          rejectResult(check.reason, code);
          if (selectedCandidate && code && STRUCTURAL_REJECTION_CODES.has(code)) {
            try {
              await persistCandidateBlock(projectId, selectedCandidate, code, check.reason, cycle.id);
            } catch (blockError) {
              applied.rejected.push({ candidateId: selectedCandidate.candidateId, reason: `candidate block not persisted: ${blockError instanceof Error ? blockError.message : String(blockError)}`, code: 'block_persist_failed' });
            }
          }
          continue;
        }
        let expected = null;
        try {
          expected = normalizeExpected(proposal?.expected);
        } catch (expectedError) {
          rejectResult(`expected rejected: ${expectedError.message}`, 'invalid_expected');
          continue;
        }
        const claim = reviewClaims.claim({
          projectId,
          nodeId: check.parent.id,
          expertId,
          intent: 'propose',
          title: proposal?.title ?? '',
        });
        if (!claim.ok) {
          rejectResult(claim.message, claim.code);
          continue;
        }
        try {
          if (advisorModel?.model) check.spec.model = advisorModel.model;
          const acceptMode = project.config.advisor?.acceptMode ?? 'auto';
          const hierarchy = cycle.hierarchy?.enabled ? cycle.hierarchy : null;
          const parentBranchId = hierarchy ? branchIdOf(check.parent.id, new Map(nodes.map((node) => [node.id, node]))) : null;
          const reasonCodes = hierarchy?.escalations?.[parentBranchId] ?? [];
          const now = Date.now();
          const epoch = String(project.config?.reviewEpoch ?? project.revision ?? 0);
          const quota = hierarchy && reasonCodes.length > 0 ? escalationQuota({ project, leadId: 'lab-lead', epoch }) : null;
          const allowedEscalation = reasonCodes.length > 0 && quota?.allowed === true;
          const evidenceChain = hierarchy?.reports?.find((report) => report.branchId === parentBranchId)?.evidence ?? [];
          const pendingHighReview = allowedEscalation
            ? { reasonCodes, openedAt: now, deadlineAt: now + HIGH_REVIEW_WINDOW_MS, by: 'lab-lead', evidenceChain }
            : null;
          const escalation = allowedEscalation
            ? { leadId: 'lab-lead', branchId: parentBranchId, codes: reasonCodes, epoch, at: now }
            : null;
          const escalationDenied = reasonCodes.length > 0 && !allowedEscalation
            ? { codes: reasonCodes, epoch, quota }
            : null;
          const reviewMeta = {
            createdBy: hierarchy ? 'lab-lead' : 'advisor',
            runId: cycle.leadRunId ?? cycle.advisorRunId,
            rationale: proposal.rationale,
            expected,
            expectedBaseline: baselineFor(check.parent, expected),
            ...(selectedCandidate ? { candidateId: selectedCandidate.candidateId, candidate: selectedCandidate } : {}),
            ...(hierarchy ? { reviewLevel: 'lead', hierarchy: true } : {}),
            ...(pendingHighReview ? { pendingHighReview } : {}),
            ...(escalation ? { escalation } : {}),
            ...(escalationDenied ? { escalationDenied } : {}),
          };
          // B14: the L1 proposal is materialized immediately as p2. The old
          // `confirm` accept mode would hold it as proposed and never start the
          // ten-minute chief window.
          const node = !hierarchy && acceptMode === 'confirm'
            ? await createProposed(project, check.parent, check.spec, { ...reviewMeta, expectedInfoGain: proposal.expectedInfoGain })
            : await createChild(project, check.parent, check.spec, reviewMeta);
          applied.createdNodeIds.push(node.id);
          applied.createdCandidates.push({ candidateId: selectedCandidate?.candidateId ?? null, nodeId: node.id, parentId: check.parent.id, replacesNodeId: check.replacesNodeId ?? null });
          result.status = 'created';
          result.reason = null;
          result.code = null;
          result.nodeId = node.id;
          if (selectedCandidate) {
            applied.consumedCandidateIds.push(selectedCandidate.candidateId);
            availableCandidates = availableCandidates.filter((row) => row.candidateId !== selectedCandidate.candidateId);
          }
          if (check.executionNote) {
            // Visible, non-fatal correction: the proposal asked for a profile this
            // project does not define, so the node runs on the default profile.
            await persistEvent(project, 'node/profile_fallback', {
              nodeId: node.id,
              data: check.executionNote,
            });
          }
          const parent = store.getNode(projectId, check.parent.id);
          if (parent) {
            parent.review = {
              reviewedAt: Date.now(),
              reviewedHeadCommit: parent.git?.headCommit ?? null,
              runId: cycle.advisorRunId,
              decision: 'proposed',
            };
            await commitMutations(projectId, [{
              op: 'node.put',
              node: parent,
              eventType: 'node/reviewed',
              eventData: { decision: 'proposed', runId: cycle.advisorRunId },
            }], { causeId: `review:${parent.id}` });
          }
        } catch (error) {
          rejectResult(error instanceof Error ? error.message : String(error), 'create_failed');
        }
      }
      // Mark remaining completed leaves as reviewed without new nodes, so a
      // later pass does not relitigate a leaf that this pass saw and skipped.
      const reviewedParents = new Set(proposals.map((proposal) => proposal?.parentId));
      project = requireProject(projectId);
      const nodes = store.listNodes(projectId);
      const parentIds = (node) => (Array.isArray(node.parentIds) && node.parentIds.length > 0 ? node.parentIds : (node.parentId ? [node.parentId] : []));
      const withChildren = new Set();
      const pendingParents = new Set();
      for (const node of nodes) {
        if (node.status === 'proposed') {
          for (const id of parentIds(node)) pendingParents.add(id);
          continue;
        }
        for (const id of parentIds(node)) withChildren.add(id);
      }
      for (const node of nodes) {
        if (node.status !== 'completed' || withChildren.has(node.id) || pendingParents.has(node.id)) continue;
        if (reviewedParents.has(node.id)) continue;
        node.review = {
          reviewedAt: Date.now(),
          reviewedHeadCommit: node.git?.headCommit ?? null,
          runId: cycle.advisorRunId,
          decision: 'none',
        };
        await commitMutations(projectId, [{
          op: 'node.put',
          node,
          eventType: 'node/reviewed',
          eventData: { decision: 'none', runId: cycle.advisorRunId },
        }], { causeId: `review:${node.id}` });
      }
    });
    } finally {
      reviewClaims.releaseAll(projectId, expertId);
    }
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

  function hierarchyMode(project) {
    const mode = project?.config?.expertsMode ?? project?.config?.experts?.mode;
    return mode === 'hierarchy' || mode === 'resident' || project?.config?.reviewHierarchy?.enabled === true;
  }

  function hierarchySummary(review) {
    if (!review) return null;
    return {
      enabled: true,
      generatedAt: review.generatedAt,
      l0Trigger: review.l0Trigger,
      eventDriven: review.eventDriven,
      branchEvents: review.branchEvents,
      depth: review.depth,
      branchCount: review.branchCount,
      activeBranchCount: review.activeBranchCount,
      groupedTeams: review.groupedTeams,
      chief: review.chief,
      compression: review.compression,
      coverage: review.coverage,
      escalations: review.escalations,
      reports: review.reports.map((report) => ({
        branchId: report.branchId,
        health: report.health,
        nodeCount: report.nodeCount,
        totalNodes: report.totalNodes,
        escalate: report.escalate,
        evidence: report.evidence,
      })),
    };
  }

  /**
   * B14: a pending high-review window must expire in the production tick, not
   * only when an operator remembers to call the service. The node stays
   * materialized; only its review status becomes `unreviewed`.
   */
  async function sweepDueHighReviews(projectId, now = Date.now()) {
    const due = store.listNodes(projectId).filter((node) => node.pendingHighReview
      && Number(node.pendingHighReview.deadlineAt) > 0
      && Number(node.pendingHighReview.deadlineAt) <= now);
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
    return resolved;
  }

  async function applyChiefActivation(projectId, node, output) {
    const project = requireProject(projectId);
    const decision = {
      action: output?.decision,
      reasonCode: typeof output?.reasonCode === 'string' ? output.reasonCode : null,
      verifiedEvidence: Array.isArray(output?.verifiedEvidence) ? output.verifiedEvidence : [],
      evidenceChain: Array.isArray(output?.evidenceChain) ? output.evidenceChain : (node.pendingHighReview?.evidenceChain ?? []),
    };
    const errors = validateChiefDecision(decision, store.listNodes(projectId));
    if (errors.length > 0) return { ok: false, errors };
    const now = Date.now();
    const next = structuredClone(node);
    next.pendingHighReview = null;
    next.highReview = {
      ...(node.highReview ?? {}),
      status: decision.action === 'defer' ? 'deferred' : decision.action === 'withdraw' ? 'withdrawn' : 'kept',
      resolvedAt: now,
      resolvedBy: { kind: 'chief', id: 'lab-chief' },
      reasonCode: decision.reasonCode,
      evidenceChain: decision.evidenceChain,
    };
    if (decision.action === 'defer') next.priority = { ...(next.priority ?? {}), class: 'deferred', by: 'lab-chief', reason: 'high-review veto: defer', at: now };
    if (decision.action === 'withdraw') {
      next.status = 'cancelled';
      next.cancelledAt = now;
      next.cancelledBy = { kind: 'chief', id: 'lab-chief' };
      next.cancelReason = 'high-review veto: withdraw';
    }
    if (decision.action === 'keep') next.ratifiedBy = 'lab-chief';
    await commitMutations(projectId, [{
      op: 'node.put',
      node: next,
      eventType: 'node/high_review_resolved',
      eventData: { decision: decision.action, reasonCode: decision.reasonCode, by: 'lab-chief' },
    }], { causeId: `high-review:${node.id}:${decision.action}`, actor: { kind: 'chief', id: 'lab-chief' } });
    return { ok: true, node: next };
  }

  /**
   * B11: a real hierarchy pass. A completed/failed branch event activates L0;
   * only after the bounded BranchReports does L1 materialize; L2 is activated
   * only for a routed pending window. The old advisor pass is not used in
   * hierarchy mode, so `createdBy=lab-lead` is a real lead activation result,
   * not a label attached to an advisor run.
   */
  async function runHierarchyPass(projectId, cycle) {
    let project = requireProject(projectId);
    const nodes = store.listNodes(projectId);
    const review = buildHierarchyReview({ project, nodes, now: Date.now() });
    cycle.hierarchy = hierarchySummary(review);
    const events = Array.isArray(review.branchEvents) ? review.branchEvents : [];
    const recordCandidates = (queue, options = {}) => {
      const stats = candidateStats(queue, { events, ...options });
      cycle.candidates = stats;
      cycle.candidateStats = stats;
      return stats;
    };

    // Round 33: a planning cycle is triggered by a fresh completed/failed
    // branch event OR by a candidate in an existing BranchReport that has not
    // yet been consumed. The latter must not wait for another branch event:
    // otherwise a project whose branches all completed can optimize exactly
    // once and then park forever.
    let queue = buildBranchCandidateQueue({ project, nodes, runs: store.listRuns(projectId, 500) });
    cycle.hierarchy.planTrigger = events.length > 0 ? 'branch_event' : queue.pendingCount > 0 ? 'candidate_queue' : queue.blockedCount > 0 ? 'candidate_blocked' : 'noop';
    const initialSkip = events.length === 0 && queue.pendingCount === 0
      ? candidateSkipReason(queue, { events, reports: queue.reports.length })
      : null;
    if (initialSkip) {
      recordCandidates(queue, { skipReason: initialSkip });
      cycle.branchReports = [];
      cycle.hierarchy.branchEventCount = 0;
      cycle.hierarchy.branchRuns = [];
      cycle.skipped.push({ stage: 'advisor', reason: initialSkip });
      return;
    }

    const byBranch = new Map();
    for (const event of events) {
      const rows = byBranch.get(event.branchId) ?? [];
      rows.push(event);
      byBranch.set(event.branchId, rows);
    }
    let branchRuns = [];
    if (events.length === 0) {
      // Reuse the stored successful BranchReports. L0 is event-driven and has
      // nothing new to compress, but L1 still has real work: the pending
      // candidates in those reports.
      branchRuns = queue.reports;
      cycle.skipped.push({
        stage: 'branch',
        reason: `reused ${branchRuns.length} stored branch report(s); ${queue.pendingCount} unconsumed candidate(s)`,
      });
    } else {
      for (const [branchId, branchEvents] of byBranch) {
        const report = review.reports.find((row) => row.branchId === branchId) ?? null;
        const run = await runRole(
          project,
          'branch',
          cycle,
          branchPrompt(project, branchEvents, report),
          BRANCH_REPORT_SCHEMA,
          { branchId, events: branchEvents, report },
          { lens: branchId, timeoutMs: roleTimeoutMs(project, 'branch'), maxQueries: ROLE_BUDGETS.branch.maxQueries },
        );
        cycle.branchRunIds = [...(cycle.branchRunIds ?? []), run.record.id];
        if (run.failure) {
          cycle.errors.push(`branch[${branchId}]: ${run.record.error}`);
          continue;
        }
        branchRuns.push({ branchId, events: branchEvents, output: run.record.output ?? null, report });
        const fresh = requireProject(projectId);
        const reviewed = [...(Array.isArray(fresh.branchReviews) ? fresh.branchReviews : [])];
        for (const event of branchEvents) {
          reviewed.push({ branchId, eventKey: event.eventKey, nodeId: event.nodeId, at: Date.now(), runId: run.record.id });
        }
        await commitMutations(projectId, [{
          op: 'project.update',
          set: { branchReviews: reviewed.slice(-200) },
          eventType: 'review/branch_reviewed',
          eventData: { branchId, events: branchEvents.map((event) => event.eventKey) },
        }], { causeId: `branch-review:${branchId}:${run.record.id}` });
      }
    }
    cycle.branchReports = branchRuns;
    for (const run of branchRuns) {
      const codes = Array.isArray(run.output?.reasonCodes) ? run.output.reasonCodes : [];
      if (codes.length === 0) continue;
      const current = Array.isArray(cycle.hierarchy.escalations?.[run.branchId]) ? cycle.hierarchy.escalations[run.branchId] : [];
      cycle.hierarchy.escalations = {
        ...(cycle.hierarchy.escalations ?? {}),
        [run.branchId]: [...new Set([...current, ...codes])],
      };
    }
    cycle.hierarchy.branchEventCount = events.length;
    cycle.hierarchy.branchRuns = cycle.branchRunIds ?? [];

    // Recompute after fresh L0 writes: their outputs may add candidates this
    // cycle, and an old report may still hold candidates that were never acted
    // on. A failed L0 must not hide a usable stored report.
    project = requireProject(projectId);
    queue = buildBranchCandidateQueue({ project, nodes: store.listNodes(projectId), runs: store.listRuns(projectId, 500) });
    recordCandidates(queue);
    if (queue.pendingCount === 0 && queue.blockedCount > 0) {
      const reason = candidateSkipReason(queue, { events, reports: queue.reports.length });
      recordCandidates(queue, { skipReason: reason });
      cycle.skipped.push({ stage: 'lead', reason });
      return;
    }
    if (branchRuns.length === 0) {
      if (queue.pendingCount > 0 && queue.reports.length > 0) {
        branchRuns = queue.reports;
        cycle.branchReports = branchRuns;
        cycle.skipped.push({
          stage: 'branch',
          reason: `reused ${branchRuns.length} stored branch report(s); ${queue.pendingCount} unconsumed candidate(s)`,
        });
      } else {
        const reason = candidateSkipReason(queue, { events, reports: queue.reports.length });
        recordCandidates(queue, { skipReason: reason });
        cycle.skipped.push({ stage: 'lead', reason });
        return;
      }
    }

    // L1 only runs after at least one bounded branch report exists. It is the
    // only role allowed to create nodes; applyAdvisorOutput is the same Host
    // validator/materializer used by the old advisor path.
    project = requireProject(projectId);
    const previousLeadFeedback = mostRecentLeadFeedback(store.listCycles(projectId, 20), cycle.id);
    cycle.previousLeadFeedback = previousLeadFeedback;
    const leadParts = leadPromptParts(
      project,
      { ...review, escalations: cycle.hierarchy.escalations },
      branchRuns,
      queue.pending,
      { previousLeadFeedback },
    );
    cycle.leadInputBytes = leadParts.stats.inputBytes;
    cycle.leadInputStats = leadParts.stats;
    const leadRun = await runRole(
      project,
      'lead',
      cycle,
      leadParts.text,
      ADVISOR_SCHEMA,
      { branchReports: branchRuns, pendingCandidates: queue.pending, review: { branchCount: review.branchCount, escalations: review.escalations } },
      { timeoutMs: roleTimeoutMs(project, 'lead'), maxQueries: ROLE_BUDGETS.lead.maxQueries },
    );
    leadRun.record.inputStats = leadParts.stats;
    cycle.leadRunId = leadRun.record.id;
    const pendingBefore = [...queue.pending];
    if (leadRun.failure) {
      cycle.errors.push(`lead: ${leadRun.record.error}`);
      const leadDecisions = leadDecisionMap(leadRun.record.output, pendingBefore);
      const decisions = candidateDecisionRows({
        pendingCandidates: pendingBefore,
        applied: { createdNodeIds: [], createdCandidates: [], proposalResults: [], rejected: [] },
        project,
        nodes: store.listNodes(projectId),
        leadDecisions,
      });
      const failedReason = queue.pendingCount > 0
        ? `blocked by failed lead run: ${boundedText(leadRun.record.error ?? 'unknown error', 500)}; ${queue.pendingCount} candidate(s) pending; ${decisionSummary(decisions)}`
        : candidateSkipReason(queue, { events, reports: queue.reports.length });
      cycle.lead = buildLeadTrace({
        leadRun,
        applied: { createdNodeIds: [], createdCandidates: [], proposalResults: [], rejected: [] },
        decisions,
        skipReason: failedReason,
        input: leadParts.stats,
      });
      leadRun.record.candidateDecisions = decisions;
      leadRun.record.outcome = {
        status: 'failed',
        error: leadRun.record.error ?? null,
        proposalCount: 0,
        created: 0,
        rejected: 0,
        decisionCounts: cycle.lead.decisionCounts,
        skipReason: failedReason,
      };
      await saveRun(projectId, leadRun.record, 'run/updated', { created: 0, failed: true });
      if (failedReason) {
        recordCandidates(queue, { skipReason: failedReason });
        cycle.skipped.push({ stage: 'advisor', reason: failedReason });
      }
      return;
    }
    let applied = { createdNodeIds: [], rejected: [], consumedCandidateIds: [], createdCandidates: [], proposalResults: [] };
    if (leadRun.record.output && Array.isArray(leadRun.record.output.proposals)) {
      try {
        applied = await applyAdvisorOutput(projectId, cycle, leadRun.record.output, queue.pending);
        cycle.createdNodeIds.push(...applied.createdNodeIds);
      } catch (error) {
        cycle.errors.push(`lead apply: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Candidate accounting is recomputed from the durable consumption records,
    // not assumed from the lead's answer. The lead's own answer and one named
    // decision per pending candidate are written even when it created nothing.
    project = requireProject(projectId);
    queue = buildBranchCandidateQueue({ project, nodes: store.listNodes(projectId), runs: store.listRuns(projectId, 500) });
    const leadDecisions = leadDecisionMap(leadRun.record.output, pendingBefore);
    const decisions = candidateDecisionRows({
      pendingCandidates: pendingBefore,
      applied,
      project,
      nodes: store.listNodes(projectId),
      leadDecisions,
    });
    const proposalCount = Array.isArray(leadRun.record.output?.proposals) ? leadRun.record.output.proposals.length : 0;
    const stallReason = applied.createdNodeIds.length === 0
      ? (queue.pendingCount > 0
          ? leadStallReason({ proposalCount, applied, decisions, pendingCount: queue.pendingCount })
          : candidateSkipReason(queue, { events, reports: queue.reports.length }))
      : null;
    recordCandidates(queue, { consumedThisCycle: applied.consumedCandidateIds?.length ?? 0, skipReason: stallReason });
    cycle.lead = buildLeadTrace({ leadRun, applied, decisions, skipReason: stallReason, input: leadParts.stats });
    leadRun.record.createdNodeIds = applied.createdNodeIds;
    leadRun.record.rejected = applied.rejected;
    leadRun.record.candidateDecisions = decisions;
    leadRun.record.outcome = {
      status: cycle.lead.status,
      proposalCount,
      created: applied.createdNodeIds.length,
      rejected: applied.rejected.length,
      decisionCounts: cycle.lead.decisionCounts,
      skipReason: stallReason,
    };
    await saveRun(projectId, leadRun.record, 'run/updated', { created: applied.createdNodeIds.length });
    if (stallReason) cycle.skipped.push({ stage: 'advisor', reason: stallReason });

    // L2 is exception-only: it activates only for a node that got a pending
    // window in this cycle. No pending node means no chief run at all.
    const pending = store.listNodes(projectId).filter((node) => applied.createdNodeIds.includes(node.id) && node.pendingHighReview);
    cycle.chiefRunIds = [];
    for (const node of pending) {
      const chiefRun = await runRole(
        project,
        'chief',
        cycle,
        chiefPrompt(project, node, review),
        CHIEF_SCHEMA,
        { nodeId: node.id, pendingHighReview: node.pendingHighReview },
        { timeoutMs: roleTimeoutMs(project, 'chief'), maxQueries: ROLE_BUDGETS.chief.maxQueries },
      );
      cycle.chiefRunIds.push(chiefRun.record.id);
      if (chiefRun.failure) {
        cycle.errors.push(`chief[${node.id}]: ${chiefRun.record.error}`);
        continue;
      }
      const outcome = await applyChiefActivation(projectId, node, chiefRun.record.output);
      if (!outcome.ok) cycle.errors.push(`chief[${node.id}]: ${outcome.errors.join('; ')}`);
      await saveRun(projectId, chiefRun.record, 'run/updated', { reviewed: outcome.ok ? node.id : null });
    }
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
    cycle.highReviewSwept = await sweepDueHighReviews(projectId, cycle.startedAt);
    if (hierarchyMode(project)) {
      // B11/Q8/5.4: the review tree is planned from a bounded slice of the DAG
      // before any model call. L0 never writes; the summary is persisted so a
      // restart can audit coverage/compression.
      cycle.hierarchy = hierarchySummary(buildHierarchyReview({ project, nodes: store.listNodes(projectId), now: cycle.startedAt }));
    }
    await commitMutations(projectId, [{
      op: 'cycle.put',
      cycle,
      eventType: 'cycle/started',
      eventData: { trigger },
    }], { causeId: `cycle:${cycle.id}:started` });

    // --- hierarchy pass (real L0/L1/L2 activations) -------------------------
    if (hierarchyMode(project)) {
      await runHierarchyPass(projectId, cycle);
    } else {
    // --- advisor pass -------------------------------------------------------
    project = requireProject(projectId);
    const allNodes = store.listNodes(projectId);
    const completed = allNodes.filter((node) => node.status === 'completed');
    const parentIdsOf = (node) => (Array.isArray(node.parentIds) && node.parentIds.length > 0 ? node.parentIds : (node.parentId ? [node.parentId] : []));
    const withChildren = new Set();
    const pendingParents = new Set();
    for (const node of allNodes) {
      for (const id of parentIdsOf(node)) (node.status === 'proposed' ? pendingParents : withChildren).add(id);
    }
    const candidateCount = allNodes.filter((node) => node.status === 'completed'
      && !withChildren.has(node.id) && !pendingParents.has(node.id)
      && (node.review?.reviewedHeadCommit ?? null) !== (node.git?.headCommit ?? null)).length;
    if (completed.length === 0 || candidateCount === 0) {
      cycle.skipped.push({
        stage: 'advisor',
        reason: completed.length === 0 ? 'no completed nodes to review' : 'no actionable candidate parents',
      });
    } else {
      const snapshot = buildAdvisorSnapshot(store, project, cluster, { ledgerReader });
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
                timeoutMs: advisorTimeoutMs(project),
                modelOverride: reviewer.provider && reviewer.model
                  ? {
                      provider: reviewer.provider,
                      model: reviewer.model,
                      ...(reviewer.reasoningEffort ? { reasoningEffort: reviewer.reasoningEffort } : {}),
                    }
                  : undefined,
              },
            )))
          : [await runRole(project, 'advisor', cycle, advisorPrompt(project, snapshot), ADVISOR_SCHEMA, snapshot, { timeoutMs: advisorTimeoutMs(project) })];
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
          for (const run of runs) await saveRun(projectId, run.record, 'run/updated', { created: run.record.createdNodeIds?.length ?? 0 });
          if (applied.rejected.length > 0) {
            cycle.skipped.push({ stage: 'advisor', reason: `${applied.rejected.length} proposal(s) rejected` });
          }
        }
      } catch (error) {
        cycle.errors.push(`advisor: ${error instanceof Error ? error.message : String(error)}`);
      }
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
          await saveRun(projectId, record, 'run/updated', { started: applied.startedNodeIds.length });
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
    const counters = { ...project.counters, cycles: (project.counters.cycles ?? 0) + 1 };
    await commitMutations(projectId, [{
      op: 'cycle.put',
      cycle,
      counters,
      eventType: 'cycle/finished',
      eventData: {
        created: cycle.createdNodeIds.length,
        started: cycle.startedNodeIds.length,
        errors: cycle.errors.length,
      },
    }], { causeId: `cycle:${cycle.id}:finished` });
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
      // Clamp rather than reject: see host/titles.js.
      const title = clampNodeTitle(input?.title);
      const prompt = typeof input?.prompt === 'string' ? input.prompt.trim() : '';
      if (isBlank(title)) throw new LabError('bad_request', 'title is required', 400);
      if (prompt.length < 10 || prompt.length > 8000) throw new LabError('bad_request', 'prompt must be 10..8000 characters', 400);
      const { needs, error } = normalizeNeeds(input?.needs, project);
      if (error) throw new LabError('bad_request', error, 400);
      const bounds = nodeTimeboxBounds(project);
      const timeboxMinutes = input?.timeboxMinutes === undefined || input?.timeboxMinutes === null
        ? bounds.default
        : input.timeboxMinutes;
      if (!Number.isInteger(timeboxMinutes) || timeboxMinutes < bounds.min || timeboxMinutes > bounds.max) {
        throw new LabError('bad_request', `timeboxMinutes must be ${bounds.min}..${bounds.max} (got ${formatReceivedValue(timeboxMinutes)})`, 400);
      }
      const nodes = store.listNodes(projectId);
      if (nodes.length >= (project.config.maxNodes ?? 60)) {
        throw new LabError('max_nodes', 'maxNodes reached for this project', 409);
      }
      const execution = resolveExecutionProfile(project, {
        executionProfile: input?.executionProfile,
        taskType: input?.taskType,
      });
      const node = await createChild(project, parent, {
        title,
        prompt,
        successCriteria: typeof input?.successCriteria === 'string' ? input.successCriteria.trim() : '',
        needs,
        timeboxMinutes,
        model: validatedModel
          ? { ...cleanModelRef(validatedModel), source: 'user' }
          : null,
        execution,
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
      await sealParent(project, parent, commit.head);
      node.git.baseCommit = commit.head;
      node.status = 'planned';
      node.approvedAt = Date.now();
      delete node.proposal;
      const result = await commitMutations(projectId, [{
        op: 'node.put',
        node,
        eventType: 'node/approved',
        eventData: { parentId: parent.id, headCommit: commit.head },
      }], { causeId: `approve:${nodeId}` });
      return { node: store.getNode(projectId, nodeId), revision: result.revision };
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
      const counters = { ...project.counters, nodes: Math.max(0, (project.counters.nodes ?? 1) - 1) };
      const mutations = [{
        op: 'node.delete',
        nodeId,
        counters,
        eventType: 'node/rejected',
        eventData: { parentId: node.parentId },
      }];
      const parent = store.getNode(projectId, node.parentId);
      if (parent && store.listNodes(projectId).every((candidate) => candidate.parentId !== parent.id)) {
        delete parent.review;
        mutations.push({ op: 'node.put', node: parent, eventType: 'node/reopened', eventData: { reason: 'proposal rejected' } });
      }
      const result = await commitMutations(projectId, mutations, { causeId: `reject:${nodeId}` });
      return { nodeId, revision: result.revision };
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
      const execution = resolveExecutionProfile(project, {
        executionProfile: input?.executionProfile,
        taskType: input?.taskType,
      });
      if (execution.driver !== 'dsh') {
        throw new LabError('bad_request', 'merge nodes require the dsh execution profile', 400);
      }
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
      const rawTitle = typeof input?.title === 'string' && input.title.trim()
        ? input.title
        : `Merge: ${parents.map((parent) => parent.title).join(' ⊕ ')}`;
      const title = clampNodeTitle(rawTitle);
      if (isBlank(title)) throw new LabError('bad_request', 'title is required', 400);
      const bounds = nodeTimeboxBounds(project);
      const timeboxMinutes = input?.timeboxMinutes === undefined || input?.timeboxMinutes === null
        ? bounds.default
        : input.timeboxMinutes;
      if (!Number.isInteger(timeboxMinutes) || timeboxMinutes < bounds.min || timeboxMinutes > bounds.max) {
        throw new LabError('bad_request', `timeboxMinutes must be ${bounds.min}..${bounds.max} (got ${formatReceivedValue(timeboxMinutes)})`, 400);
      }
      // Freeze each parent at its committed HEAD first.
      for (const parent of parents) {
        const commit = await git.commitWorktree(project, parent, `dshex(${parent.id}): ${parent.title} (merge freeze)`);
        parent.git.headCommit = commit.head;
        await commitMutations(projectId, [{
          op: 'node.put',
          node: parent,
          eventType: 'node/frozen',
          eventData: { headCommit: commit.head, reason: 'merge freeze' },
        }], { causeId: `freeze:${parent.id}` });
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
        execution: { profile: 'dsh', driver: 'dsh' },
        taskType: execution.taskType,
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
      const counters = {
        ...project.counters,
        nextNodeSeq: (project.counters.nextNodeSeq ?? 2) + 1,
        nodes: (project.counters.nodes ?? 0) + 1,
      };
      const result = await commitMutations(projectId, [{
        op: 'node.create',
        node,
        counters,
        eventType: 'node/created',
        eventData: { title: node.title, parentId: primary.id, parentIds: ids, kind: 'merge', timeboxMinutes },
      }], { causeId: `merge:${nodeId}` });
      for (const parent of parents) {
        await sealParent(project, parent, parent.git.headCommit);
      }
      return { node: store.getNode(projectId, nodeId), revision: result.revision };
    });
  }

  /**
   * Round 33: auto mode needs to know that an existing BranchReport still has
   * unconsumed candidates even when no branch event exists. This is a cheap
   * deterministic read, never a model call.
   */
  function pendingCandidateCount(projectId) {
    const project = requireProject(projectId);
    if (!hierarchyMode(project)) return 0;
    const queue = buildBranchCandidateQueue({
      project,
      nodes: store.listNodes(projectId),
      runs: store.listRuns(projectId, 500),
    });
    return queue.pendingCount;
  }

  /** Round 36: a fully blocked queue still needs one cycle to explain why. */
  function blockedCandidateCount(projectId) {
    const project = requireProject(projectId);
    if (!hierarchyMode(project)) return 0;
    const queue = buildBranchCandidateQueue({
      project,
      nodes: store.listNodes(projectId),
      runs: store.listRuns(projectId, 500),
    });
    return queue.blockedCount;
  }

  function listRuns(projectId, limit = 50) {
    requireProject(projectId);
    const size = Math.max(1, Math.min(500, Number.isFinite(limit) ? limit : 50));
    return {
      runs: store.listRuns(projectId, size),
      cycles: store.listCycles(projectId, size),
      _truncated: null,
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
          await saveRun(projectId, record, 'run/cancelled', { status: record.status });
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
    pendingCandidateCount,
    blockedCandidateCount,
    getRun,
    ensureController,
    cancelProjectRuns,
    reviewClaims,
    dispose,
  };
}

export { ADVISOR_SCHEMA, SCHEDULER_SCHEMA, CHIEF_SCHEMA, advisorPrompt, schedulerPrompt, mergeAdvisorOutputs, leadPromptParts };


/** 5.3.8: bounded advisor wall-clock budget in ms; default is the measured 240 s. */
export function advisorTimeoutMs(project) {
  return roleTimeoutMs(project, 'advisor');
}
