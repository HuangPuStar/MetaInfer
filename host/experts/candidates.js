import { isNonBlockingSuccessor } from '../kernel/runnable.js';

/**
 * Round 33: durable branch-report candidate queue.
 *
 * Branch reports are model output. Their `candidates` array has no stable
 * provider id, so the Host derives one from *structure* (branch, source node,
 * kind, priority, action and the candidate's ordinal within that shape). It
 * never derives identity from prose: editing a title must not make the same
 * candidate look new, and two candidates that differ only in wording are still
 * one shape with separate ordinals.
 *
 * Consumption is recorded on the project when the lead materializes a node
 * (`review/candidate_consumed`). A candidate stays pending until a node exists
 * whose cause records its candidateId, so a completed/failed branch event is
 * no longer the only planning trigger.
 */

const MAX_CANDIDATES = 500;
const MAX_CONSUMPTIONS = 5000;

function text(value, max = 240) {
  if (typeof value !== 'string') return '';
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function fieldString(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return '';
}

function hash(value) {
  let h = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    h ^= value.charCodeAt(index);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function sourceNodeIdOf(candidate) {
  return fieldString(candidate?.nodeId)
    || fieldString(candidate?.targetNodeId)
    || fieldString(candidate?.sourceNodeId)
    || fieldString(candidate?.parentId)
    || null;
}

function kindOf(candidate) {
  const kind = fieldString(candidate?.kind)
    || fieldString(candidate?.action)
    || (candidate?.priority ? 'candidate' : '')
    || 'idea';
  return kind.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 32) || 'idea';
}

function priorityOf(candidate) {
  const raw = candidate?.priority;
  if (typeof raw === 'string' && raw.trim()) return raw.trim().slice(0, 16);
  if (raw && typeof raw === 'object' && typeof raw.class === 'string') return raw.class.trim().slice(0, 16);
  return null;
}

function actionOf(candidate) {
  return fieldString(candidate?.action).slice(0, 48) || null;
}

function nodeParentId(node) {
  if (!node) return null;
  return fieldString(node.parentId)
    || fieldString(Array.isArray(node.parentIds) ? node.parentIds[0] : '')
    || null;
}

/**
 * Follow `replacesNodeId` from the original failed node through its failed
 * replacements. A chain is a scope's retry history, not a set of siblings.
 */
export function replacementChainForNode(nodes, sourceNodeId) {
  const list = Array.isArray(nodes) ? nodes : [];
  const byId = new Map(list.filter((node) => node?.id).map((node) => [node.id, node]));
  let source = byId.get(sourceNodeId) ?? null;
  if (!source) return [];
  const upwardSeen = new Set();
  while (source?.replacesNodeId && byId.has(source.replacesNodeId) && !upwardSeen.has(source.id)) {
    upwardSeen.add(source.id);
    source = byId.get(source.replacesNodeId);
  }
  const chain = [];
  const forwardSeen = new Set();
  let current = source;
  while (current && !forwardSeen.has(current.id)) {
    forwardSeen.add(current.id);
    chain.push(current);
    const next = list
      .filter((node) => node?.replacesNodeId === current.id && node.id !== current.id)
      .sort((a, b) => Number(a.timestamps?.createdAt ?? 0) - Number(b.timestamps?.createdAt ?? 0) || String(a.id).localeCompare(String(b.id)))
      .at(-1);
    current = next ?? null;
  }
  return chain;
}

/** Stable structural fingerprint used to expire a candidate block when the DAG changes. */
export function candidateStructureKey(candidate, nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const source = list.find((node) => node.id === candidate?.sourceNodeId) ?? null;
  const parentId = nodeParentId(source);
  const parent = list.find((node) => node.id === parentId) ?? null;
  const chain = source ? replacementChainForNode(list, source.id) : [];
  // Deferred/cancelled siblings do not block succession, so they must not
  // keep an old `parent_already_has_successor` block alive after the blocker is
  // deferred. Omitting them changes the structural key and expires that block.
  const siblings = parentId
    ? list
      .filter((node) => nodeParentId(node) === parentId && !isNonBlockingSuccessor(node))
      .map((node) => `${node.id}:${node.status}:${node.replacesNodeId ?? ''}`)
      .sort()
    : [];
  // A `parent_already_has_successor` block is about the *source's* children,
  // not its siblings. Include the non-blocking-filtered successor set so an old
  // block expires the moment the sole child is deferred or cancelled.
  const successors = source
    ? list
      .filter((node) => nodeParentId(node) === source.id && !isNonBlockingSuccessor(node))
      .map((node) => `${node.id}:${node.status}:${node.replacesNodeId ?? ''}`)
      .sort()
    : [];
  return JSON.stringify({
    candidateId: candidate?.candidateId ?? null,
    branchId: candidate?.branchId ?? null,
    sourceNodeId: candidate?.sourceNodeId ?? null,
    sourceStatus: source?.status ?? null,
    parentId,
    parentStatus: parent?.status ?? null,
    chain: chain.map((node) => `${node.id}:${node.status}:${node.replacesNodeId ?? ''}`),
    siblings,
    successors,
  });
}

function normalizeCandidate(candidate, { branchId, run, nodeById = null }) {
  if (candidate == null) return null;
  const object = typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : null;
  if (!object && typeof candidate !== 'string') return null;
  const title = object
    ? text(firstString(
        candidate.title,
        candidate.idea,
        candidate.description,
        candidate.nodeTitle,
        candidate.hypothesis,
        candidate.name,
        candidate.text,
      ))
    : text(candidate);
  const detail = object
    ? text(firstString(candidate.rationale, candidate.note, candidate.basis, candidate.expectedImpact), 500)
    : '';
  const sourceNodeId = object ? sourceNodeIdOf(candidate) : null;
  // Round 34: a retry/replacement must know the failed node's parent. Resolve it
  // from the node map when available; reports may also carry sourceParentId.
  const sourceNode = sourceNodeId && nodeById ? nodeById.get(sourceNodeId) : null;
  const sourceParentId = sourceNode
    ? (fieldString(sourceNode.parentId) || fieldString(Array.isArray(sourceNode.parentIds) ? sourceNode.parentIds[0] : ''))
    : (object ? fieldString(candidate.sourceParentId) : '');
  const sourceStatus = sourceNode ? fieldString(sourceNode.status) : null;
  const kind = object ? kindOf(candidate) : 'idea';
  const priority = object ? priorityOf(candidate) : null;
  const action = object ? actionOf(candidate) : null;
  if (!title && !sourceNodeId && !action && !candidate?.kind && !candidate?.priority) return null;
  const signatureParts = [branchId, sourceNodeId ?? 'branch', kind, priority ?? '', action ?? ''];
  const signature = signatureParts.join('|');
  const confidence = Number(object?.confidence);
  const lowConfidence = (Number.isFinite(confidence) && confidence < 0.5)
    || (Array.isArray(run.output?.reasonCodes) && run.output.reasonCodes.includes('low_confidence'));
  return {
    branchId,
    sourceNodeId,
    sourceParentId: sourceParentId || null,
    sourceStatus,
    kind,
    priority,
    action,
    signature,
    title: title || (sourceNodeId ? `candidate for ${sourceNodeId}` : `${kind} candidate`),
    detail,
    needs: object?.needs && typeof object.needs === 'object' && !Array.isArray(object.needs) ? object.needs : null,
    expected: object?.expected && typeof object.expected === 'object' && !Array.isArray(object.expected) ? object.expected : null,
    lowConfidence,
    reportRunId: run.id ?? null,
    reportAt: Number(run.endedAt ?? run.startedAt ?? run.createdAt ?? 0) || null,
    reportHealth: typeof run.output?.health === 'string' ? run.output.health : null,
  };
}

/**
 * Build the deterministic queue from every successful branch run.
 *
 * All reports are merged, not just the latest one: an older report may still
 * hold a candidate that was never materialized, and dropping it when the same
 * branch reports again would silently lose optimization work. Identical shapes
 * at the same ordinal collapse to one candidateId.
 */
export function buildBranchCandidateQueue({ project = {}, runs = [], nodes = [], now = Date.now() } = {}) {
  const consumedRows = Array.isArray(project?.candidateConsumptions) ? project.candidateConsumptions : [];
  const consumedById = new Map();
  for (const row of consumedRows) {
    if (row && typeof row.candidateId === 'string' && row.candidateId) consumedById.set(row.candidateId, row);
  }
  const branchRuns = (Array.isArray(runs) ? runs : [])
    .filter((run) => run && run.role === 'branch' && (run.status === 'completed' || run.status === 'failed'))
    .sort((a, b) => Number(a.startedAt ?? a.createdAt ?? 0) - Number(b.startedAt ?? b.createdAt ?? 0));
  const latestReports = new Map();
  const failedReports = new Map();
  for (const run of branchRuns) {
    const branchId = fieldString(run.lens) || fieldString(run.output?.branchId) || null;
    if (!branchId) continue;
    if (run.status === 'failed') {
      failedReports.set(branchId, { branchId, runId: run.id ?? null, error: text(run.error, 300), reportAt: Number(run.endedAt ?? run.startedAt ?? 0) || null });
      continue;
    }
    if (!run.output || typeof run.output !== 'object') continue;
    latestReports.set(branchId, {
      branchId,
      runId: run.id ?? null,
      output: run.output,
      events: [],
      stored: true,
      status: 'completed',
    });
  }

  const nodeById = new Map((Array.isArray(nodes) ? nodes : []).filter((node) => node?.id).map((node) => [node.id, node]));
  const candidatesById = new Map();
  const skipped = [];
  for (const run of branchRuns) {
    if (run.status !== 'completed' || !run.output || typeof run.output !== 'object') continue;
    const branchId = fieldString(run.lens) || fieldString(run.output?.branchId) || null;
    if (!branchId) continue;
    const raw = Array.isArray(run.output.candidates) ? run.output.candidates : [];
    const shapeCounts = new Map();
    for (let index = 0; index < raw.length; index += 1) {
      if (candidatesById.size >= MAX_CANDIDATES) {
        skipped.push({ branchId, runId: run.id ?? null, candidateIndex: index, reason: 'candidate_limit' });
        continue;
      }
      const normalized = normalizeCandidate(raw[index], { branchId, run, nodeById });
      if (!normalized) {
        skipped.push({ branchId, runId: run.id ?? null, candidateIndex: index, reason: 'candidate has no structural or descriptive fields' });
        continue;
      }
      const shape = `${normalized.signature}|${hash(normalized.signature)}`;
      const ordinal = shapeCounts.get(shape) ?? 0;
      shapeCounts.set(shape, ordinal + 1);
      const candidateId = `cand:${branchId}:${normalized.sourceNodeId ?? 'branch'}:${normalized.kind}:${hash(normalized.signature)}:${ordinal}`;
      if (candidatesById.has(candidateId)) continue;
      const consumedRow = consumedById.get(candidateId) ?? null;
      const block = project?.candidateBlocks && typeof project.candidateBlocks === 'object'
        ? project.candidateBlocks[candidateId] ?? null
        : null;
      const structureKey = block ? candidateStructureKey({ candidateId, ...normalized }, nodes) : null;
      const sourceNode = normalized.sourceNodeId ? nodeById.get(normalized.sourceNodeId) ?? null : null;
      const hasBlockingSuccessors = sourceNode
        ? (Array.isArray(nodes) ? nodes : []).some((node) => nodeParentId(node) === sourceNode.id && !isNonBlockingSuccessor(node))
        : false;
      // Even a legacy block without a structureKey must not survive after the
      // only successor was deferred/cancelled: that is exactly the deadlock.
      const obsoleteParentSuccessorBlock = block?.code === 'parent_already_has_successor'
        && Boolean(sourceNode)
        && !hasBlockingSuccessors;
      const blocked = Boolean(!consumedRow && block && !obsoleteParentSuccessorBlock && (!block.structureKey || block.structureKey === structureKey));
      candidatesById.set(candidateId, {
        candidateId,
        ...normalized,
        ordinal,
        consumed: Boolean(consumedRow),
        consumedByNodeId: consumedRow?.nodeId ?? null,
        consumedAt: consumedRow?.consumedAt ?? null,
        blocked,
        blockedAt: blocked ? block.at ?? null : null,
        blockedCode: blocked ? block.code ?? null : null,
        blockedReason: blocked ? block.reason ?? null : null,
        blockedStructureKey: blocked ? block.structureKey ?? structureKey : null,
      });
    }
  }

  const candidates = [...candidatesById.values()].sort((a, b) => {
    if (a.branchId !== b.branchId) return a.branchId.localeCompare(b.branchId);
    if ((a.sourceNodeId ?? '') !== (b.sourceNodeId ?? '')) return (a.sourceNodeId ?? '').localeCompare(b.sourceNodeId ?? '');
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.ordinal - b.ordinal;
  });
  const pending = candidates.filter((candidate) => !candidate.consumed && !candidate.blocked);
  const consumed = candidates.filter((candidate) => candidate.consumed);
  const blocked = candidates.filter((candidate) => candidate.blocked);
  const reports = [...latestReports.values()].sort((a, b) => a.branchId.localeCompare(b.branchId));
  return {
    generatedAt: now,
    candidates,
    pending,
    consumed,
    blocked,
    skipped,
    reports,
    failedReports: [...failedReports.values()].sort((a, b) => a.branchId.localeCompare(b.branchId)),
    considered: candidates.length,
    pendingCount: pending.length,
    consumedCount: consumed.length,
    blockedCount: blocked.length,
    skippedCount: skipped.length,
    lowConfidenceCount: candidates.filter((candidate) => candidate.lowConfidence).length,
    nodeIds: Array.isArray(nodes) ? nodes.map((node) => node.id).filter(Boolean) : [],
  };
}

/** Explicit reason why a hierarchy cycle has no candidate to plan from. */
export function candidateSkipReason(queue, { events = 0, reports = null } = {}) {
  if (!queue) return 'no branch-report candidate queue';
  if (queue.pendingCount > 0) return null;
  const reportCount = Number.isFinite(reports) ? reports : queue.reports.length;
  if (queue.blockedCount > 0 && queue.pendingCount === 0) {
    const sample = queue.blocked[0];
    return `all branch-report candidates structurally blocked: ${sample.blockedCode ?? 'structural_block'}; ${sample.blockedReason ?? 'no reason recorded'}`;
  }
  if (queue.considered === 0) {
    if (reportCount === 0) {
      if (queue.failedReports.length > 0) return 'blocked by failed branch report';
      return events > 0 ? 'branch reports contain no candidates' : 'no completed/failed branch event and no branch report';
    }
    return queue.skipped.length > 0 ? 'no actionable branch-report candidates' : 'branch reports contain no candidates';
  }
  if (queue.consumedCount === queue.considered) return 'all branch-report candidates consumed';
  if (queue.skipped.length > 0 && queue.consumedCount + queue.skipped.length >= queue.considered) {
    return 'all branch-report candidates consumed or skipped';
  }
  return 'no actionable branch-report candidates';
}

/** A no-proposal lead answer still gets a named, non-misleading reason. */
export function candidateNoProposalReason(queue) {
  if (!queue || queue.pendingCount === 0) return null;
  if (queue.pending.every((candidate) => candidate.lowConfidence)) {
    return `low-confidence candidates only (${queue.pendingCount}); lead returned no decision`;
  }
  return `lead returned no decision for ${queue.pendingCount} pending branch-report candidate(s); per-candidate reasons are recorded on cycle.lead`;
}

/** Compact candidate accounting stored on cycle.candidates. */
export function candidateStats(queue, { consumedThisCycle = 0, events = 0, skipReason = null } = {}) {
  return {
    considered: queue?.considered ?? 0,
    consumed: queue?.consumedCount ?? 0,
    consumedThisCycle,
    pending: queue?.pendingCount ?? 0,
    skipped: queue?.skippedCount ?? 0,
    lowConfidence: queue?.lowConfidenceCount ?? 0,
    reports: queue?.reports.length ?? 0,
    failedReports: queue?.failedReports.length ?? 0,
    blocked: queue?.blockedCount ?? 0,
    blockedReason: queue?.blocked?.[0]?.blockedReason ?? null,
    events: Array.isArray(events) ? events.length : Number(events) || 0,
    eventCount: Array.isArray(events) ? events.length : Number(events) || 0,
    skipReason: skipReason ?? candidateSkipReason(queue, { events }),
  };
}

export { MAX_CANDIDATES, MAX_CONSUMPTIONS };
