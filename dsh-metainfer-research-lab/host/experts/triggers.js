/**
 * B13 / 5.3.9: deterministic escalation predicates.
 *
 * Two independent sets live here:
 *   - B13 `ESCALATION_TRIGGER_CODES`: the six reasons an expert may escalate;
 *   - 5.3.9 `THRESHOLD_TRIGGER_CODES`: the six time/volume conditions that
 *     make the observer act without asking a model.
 *
 * Every predicate is a pure function of facts the Host already has. No LLM
 * decides whether a trigger fired.
 */
import { runnableQueue } from '../kernel/runnable.js';
import { ESCALATION_REASON_CODES } from '../kernel/intent.js';

export const ESCALATION_TRIGGER_CODES = ESCALATION_REASON_CODES;

// The old name is kept as an export alias because existing callers import it;
// the values are now the checklist codes, not the implementation's old six.
export const TRIGGER_CODES = ESCALATION_TRIGGER_CODES;

export const THRESHOLD_TRIGGER_CODES = Object.freeze([
  'queue_overload',
  'stalled',
  'repeated_failure',
  'expert_rejected',
  'budget_alert',
  'direction_converged',
]);

const MINUTE = 60_000;
const DEFAULT_QUEUE_OVERLOAD_MS = 5 * MINUTE;
const DEFAULT_STALLED_MS = 15 * MINUTE;
const DEFAULT_BUDGET_RATIO = 0.8;

/**
 * The single 5.3.9 queue-overload definition. `planned` (not runnable-only)
 * is the checklist quantity; the observer and the threshold evaluator must use
 * this helper so deferred nodes cannot make the two disagree.
 */
export function queueOverloadState(nodes, freeSlotsValue) {
  const planned = nodes.filter((node) => node?.status === 'planned' && !node?.archivedAt).length;
  const freeSlots = Math.max(0, Number(freeSlotsValue ?? 0));
  return {
    overloaded: freeSlots > 0 && planned > 2 * freeSlots,
    planned,
    freeSlots,
  };
}

function confidenceOf(node) {
  const value = node?.confidence ?? node?.report?.confidence ?? node?.proposal?.confidence;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function hypothesisKey(node) {
  const value = node?.hypothesis ?? node?.report?.hypothesis ?? node?.proposal?.hypothesis;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function rate(used, limit) {
  const u = Number(used);
  const l = Number(limit);
  return Number.isFinite(u) && Number.isFinite(l) && l > 0 ? u / l : 0;
}

/**
 * B13: the six escalation reasons. Inputs are explicit so tests do not have to
 * mutate a collector or infer a trigger from the emitted code list.
 *
 * @param {{nodes?: object[], project?: object, budget?: object,
 *          knownHypotheses?: string[], ledger?: object[], now?: number}} input
 * @returns {{code: string, detail: object}[]}
 */
export function evaluateEscalationTriggers(input = {}) {
  const nodes = Array.isArray(input.nodes) ? input.nodes : [];
  const project = input.project ?? {};
  const budget = input.budget ?? {};
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const triggers = [];

  // conflict: same hypothesis, different concrete variant.
  const variants = new Map();
  for (const node of nodes) {
    const hypothesis = hypothesisKey(node);
    if (!hypothesis) continue;
    if (!variants.has(hypothesis)) variants.set(hypothesis, new Map());
    const variant = typeof node.variant === 'string' && node.variant.trim() ? node.variant.trim() : '';
    if (!variants.get(hypothesis).has(variant)) variants.get(hypothesis).set(variant, []);
    variants.get(hypothesis).get(variant).push(node.id);
  }
  for (const [hypothesis, byVariant] of variants) {
    if (byVariant.size < 2) continue;
    const nonEmpty = [...byVariant.keys()].filter(Boolean);
    if (nonEmpty.length >= 2) {
      triggers.push({ code: 'conflict', detail: { hypothesis, variants: nonEmpty.slice(0, 10), nodeIds: [...byVariant.values()].flat().slice(0, 20) } });
      break;
    }
  }
  if (triggers.length === 0 && nodes.some((node) => node?.conflict === true)) {
    triggers.push({ code: 'conflict', detail: { nodeIds: nodes.filter((node) => node?.conflict === true).map((node) => node.id).slice(0, 20) } });
  }

  // budget_shift: the project is above 80% of any declared budget.
  const usedTokens = Number(budget.usedTokens ?? project?.counters?.tokensUsed ?? 0);
  const maxTokens = Number(budget.maxTokens ?? project?.config?.auto?.maxTokens ?? 0);
  const usedCost = Number(budget.usedCostUsd ?? project?.counters?.costUsd ?? 0);
  const maxCost = Number(budget.maxCostUsd ?? project?.config?.auto?.maxCostUsd ?? 0);
  const tokenRatio = rate(usedTokens, maxTokens);
  const costRatio = rate(usedCost, maxCost);
  const explicitRatio = Number(budget.usedPct);
  const budgetRatio = Math.max(tokenRatio, costRatio, Number.isFinite(explicitRatio) ? explicitRatio / 100 : 0);
  if (budgetRatio > DEFAULT_BUDGET_RATIO) {
    triggers.push({ code: 'budget_shift', detail: { ratio: Number(budgetRatio.toFixed(3)), threshold: DEFAULT_BUDGET_RATIO, usedTokens, maxTokens, usedCost, maxCost } });
  }

  // new_direction: a hypothesis not present in the known set.
  const known = new Set((Array.isArray(input.knownHypotheses) ? input.knownHypotheses : [])
    .filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()));
  const newDirection = nodes.find((node) => {
    if (node?.newDirection === true) return true;
    const hypothesis = hypothesisKey(node);
    return hypothesis !== null && known.size > 0 && !known.has(hypothesis);
  });
  if (newDirection) {
    triggers.push({ code: 'new_direction', detail: { nodeId: newDirection.id, hypothesis: hypothesisKey(newDirection), knownHypotheses: [...known].slice(0, 20) } });
  }

  // branch_death: every node in a branch is terminal/failed and none can run.
  const deadNodes = nodes.filter((node) => node?.branchDead === true || node?.branch?.status === 'dead');
  if (deadNodes.length > 0) {
    triggers.push({ code: 'branch_death', detail: { nodeIds: deadNodes.map((node) => node.id).slice(0, 20), branches: [...new Set(deadNodes.map((node) => node.branch?.id ?? node.branchId ?? node.id))].slice(0, 20) } });
  }

  // low_confidence: strict `< 0.6`.
  const low = nodes.filter((node) => {
    const confidence = confidenceOf(node);
    return confidence !== null && confidence < 0.6;
  });
  if (low.length > 0) {
    triggers.push({ code: 'low_confidence', detail: { nodeIds: low.map((node) => node.id).slice(0, 20), minConfidence: Math.min(...low.map((node) => confidenceOf(node))), threshold: 0.6 } });
  }

  // ledger_conflict: two ledger claims on one target disagree.
  const ledger = Array.isArray(input.ledger) ? input.ledger : Array.isArray(project?.ledger) ? project.ledger : [];
  const byTarget = new Map();
  for (const entry of ledger) {
    const target = entry?.target ?? entry?.nodeId ?? entry?.id;
    if (typeof target !== 'string' || !target) continue;
    const value = JSON.stringify(entry?.value ?? entry?.claim ?? entry?.hypothesis ?? null);
    if (!byTarget.has(target)) byTarget.set(target, new Map());
    if (!byTarget.get(target).has(value)) byTarget.get(target).set(value, []);
    byTarget.get(target).get(value).push(entry.id ?? null);
  }
  const conflictTargets = [...byTarget.entries()].filter(([, values]) => values.size > 1).map(([target]) => target);
  if (conflictTargets.length > 0) {
    triggers.push({ code: 'ledger_conflict', detail: { targets: conflictTargets.slice(0, 20) } });
  }

  return triggers;
}

/** Backwards-compatible entry point used by the observer. */
export function evaluateTriggers(input = {}) {
  return evaluateEscalationTriggers(input);
}

function errorKindOf(run) {
  return run?.errorKind ?? run?.errorCode ?? run?.error?.kind ?? run?.error?.code ?? (run?.status === 'failed' ? 'unknown' : null);
}

/**
 * 5.3.9: six time/volume thresholds. `queueOverloadSince` is owned by the
 * caller (the observer) so the 5-minute window survives across snapshots.
 *
 * @param {{nodes?: object[], runs?: object[], project?: object, budget?: object,
 *          now?: number, freeSlots?: number, queueOverloadSince?: number,
 *          queueOverloadMs?: number, stalledMs?: number}} input
 * @returns {{code: string, detail: object}[]}
 */
export function evaluateThresholdTriggers(input = {}) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const nodes = Array.isArray(input.nodes) ? input.nodes : [];
  const runs = Array.isArray(input.runs) ? input.runs : [];
  const queue = runnableQueue(nodes, now);
  const overload = queueOverloadState(nodes, input.freeSlots);
  const planned = overload.planned;
  const freeSlots = overload.freeSlots;
  const queueOverloadMs = Number.isFinite(input.queueOverloadMs) ? input.queueOverloadMs : DEFAULT_QUEUE_OVERLOAD_MS;
  const stalledMs = Number.isFinite(input.stalledMs) ? input.stalledMs : DEFAULT_STALLED_MS;
  const triggers = [];

  const queueOverloaded = overload.overloaded;
  if (queueOverloaded) {
    const since = Number(input.queueOverloadSince);
    const overMs = Number.isFinite(since) && since > 0 ? Math.max(0, now - since) : 0;
    if (overMs >= queueOverloadMs) {
      triggers.push({ code: 'queue_overload', detail: { planned, queue: queue.length, freeSlots, ratio: Number((planned / freeSlots).toFixed(2)), overMs, thresholdMs: queueOverloadMs } });
    }
  }

  const stalled = nodes.filter((node) => {
    if (node?.archivedAt) return false;
    const status = node?.status;
    const at = Number(node?.timestamps?.lastActivityAt ?? node?.timestamps?.startedAt ?? 0);
    const idle = at > 0 ? now - at : 0;
    return (status === 'running' || status === 'planning') && idle >= stalledMs;
  });
  if (stalled.length > 0) {
    triggers.push({ code: 'stalled', detail: { nodeIds: stalled.map((node) => node.id).slice(0, 20), idleMs: Math.max(...stalled.map((node) => now - Number(node.timestamps.lastActivityAt ?? node.timestamps.startedAt ?? 0))), thresholdMs: stalledMs } });
  }

  // Same errorKind three times in a row (chronological run order).
  const ordered = runs
    .slice()
    .sort((a, b) => Number(a.startedAt ?? a.endedAt ?? 0) - Number(b.startedAt ?? b.endedAt ?? 0));
  let previousKind = null;
  let streak = 0;
  for (const run of ordered) {
    if (run?.status !== 'failed') { previousKind = null; streak = 0; continue; }
    const kind = errorKindOf(run);
    if (!kind) { previousKind = null; streak = 0; continue; }
    if (kind === previousKind) streak += 1;
    else { previousKind = kind; streak = 1; }
    if (streak >= 3) {
      triggers.push({ code: 'repeated_failure', detail: { errorKind: kind, streak, threshold: 3 } });
      break;
    }
  }

  // The same expert rejected five times (across intents/runs).
  const rejectedByExpert = new Map();
  for (const item of [...runs, ...(Array.isArray(input.intents) ? input.intents : [])]) {
    const expertId = item?.expertId ?? item?.agent?.session?.id ?? item?.createdBy;
    if (typeof expertId !== 'string' || !expertId) continue;
    if (!rejectedByExpert.has(expertId)) rejectedByExpert.set(expertId, 0);
    if (item?.status === 'rejected' || item?.outcome === 'rejected' || item?.rejected === true) {
      rejectedByExpert.set(expertId, rejectedByExpert.get(expertId) + 1);
    }
  }
  for (const [expertId, count] of rejectedByExpert) {
    if (count >= 5) {
      triggers.push({ code: 'expert_rejected', detail: { expertId, count, threshold: 5 } });
      break;
    }
  }

  const project = input.project ?? {};
  const budget = input.budget ?? {};
  const tokenRatio = rate(budget.usedTokens ?? project?.counters?.tokensUsed ?? 0, budget.maxTokens ?? project?.config?.auto?.maxTokens ?? 0);
  const costRatio = rate(budget.usedCostUsd ?? project?.counters?.costUsd ?? 0, budget.maxCostUsd ?? project?.config?.auto?.maxCostUsd ?? 0);
  const explicitRatio = Number(budget.usedPct);
  const budgetRatio = Math.max(tokenRatio, costRatio, Number.isFinite(explicitRatio) ? explicitRatio / 100 : 0);
  if (budgetRatio > DEFAULT_BUDGET_RATIO) {
    triggers.push({ code: 'budget_alert', detail: { ratio: Number(budgetRatio.toFixed(3)), threshold: DEFAULT_BUDGET_RATIO } });
  }

  // Three failed nodes on one hypothesis: the direction has converged.
  const failedByHypothesis = new Map();
  for (const node of nodes) {
    const hypothesis = hypothesisKey(node);
    if (!hypothesis || node.status !== 'failed') continue;
    if (!failedByHypothesis.has(hypothesis)) failedByHypothesis.set(hypothesis, []);
    failedByHypothesis.get(hypothesis).push(node.id);
  }
  for (const [hypothesis, nodeIds] of failedByHypothesis) {
    if (nodeIds.length >= 3) {
      triggers.push({ code: 'direction_converged', detail: { hypothesis, nodeIds: nodeIds.slice(0, 20), threshold: 3 } });
      break;
    }
  }

  return triggers;
}
