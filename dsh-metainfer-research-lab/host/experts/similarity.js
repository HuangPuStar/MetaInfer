/**
 * Deterministic recall (Stage 4.2). Finding duplicates is a retrieval problem:
 * this module enumerates every eligible pair and scores structural predicates.
 * There is no model call and no randomness, so the same DAG always yields the
 * same candidates (asserted by the selftest).
 *
 * Predicates (B17):
 *   - promptHash prefix: two proposals with the same prompt prefix are likely
 *     the same hypothesis even when the titles were paraphrased;
 *   - same parent + similar success criteria: a sibling re-run;
 *   - matching metric targets;
 *   - title / criteria / tag Jaccard as the fallback.
 */
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'with', 'by', 'is', 'are', 'be', 'from', 'as', 'at', 'it', 'this', 'that']);
const PROMPT_PREFIX = 12;

export function tokens(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOP.has(token));
}

export function jaccard(left, right) {
  const a = new Set(tokens(left));
  const b = new Set(tokens(right));
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/** Small deterministic fingerprint, used when a node predates promptHash. */
export function hashText(value) {
  let hash = 2166136261;
  for (const char of String(value ?? '')) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function promptFingerprint(node) {
  if (node?.promptHash) return String(node.promptHash);
  const prompt = String(node?.prompt ?? '').trim();
  return prompt === '' ? '' : hashText(prompt);
}

function parentKey(node) {
  if (Array.isArray(node?.parentIds) && node.parentIds.length > 0) return [...node.parentIds].sort().join(',');
  return node?.parentId ?? '';
}

function metricsKey(node) {
  const metrics = node?.report?.metrics ?? node?.metrics ?? [];
  if (!Array.isArray(metrics) || metrics.length === 0) return '';
  return metrics.map((metric) => String(metric?.name ?? metric?.key ?? metric ?? '')).sort().join('|');
}

/**
 * B18: structured dedupe keys. A parameter scan is not a duplicate: two nodes
 * with the same hypothesis but different `variant` are deliberately kept apart
 * even when their titles are identical. `tags` are part of the signature so a
 * caller can broadcast a cheap dedupe key before a model sees the pair.
 */
export function structuredVariant(node) {
  return {
    hypothesis: String(node?.hypothesis ?? '').trim(),
    variant: String(node?.variant ?? '').trim(),
    tags: [...new Set((Array.isArray(node?.tags) ? node.tags : []).map((tag) => String(tag).trim()).filter(Boolean))].sort(),
  };
}

export function dedupeSignature(node) {
  const key = structuredVariant(node);
  return [key.hypothesis, key.variant, key.tags.join(',')].join('|');
}

/** True when the pair is a parameter/lever scan, not a duplicate. */
export function variantConflict(left, right) {
  const a = structuredVariant(left);
  const b = structuredVariant(right);
  return a.hypothesis !== '' && a.hypothesis === b.hypothesis
    && a.variant !== '' && b.variant !== ''
    && a.variant !== b.variant;
}

/** Structural reasons for a candidate pair, strongest first. */
export function similarityEvidence(left, right) {
  const reasons = [];
  const leftPrompt = promptFingerprint(left);
  const rightPrompt = promptFingerprint(right);
  if (leftPrompt !== '' && leftPrompt.slice(0, PROMPT_PREFIX) === rightPrompt.slice(0, PROMPT_PREFIX)) reasons.push('promptHashPrefix');
  const criteria = jaccard(left?.successCriteria, right?.successCriteria);
  const sameParent = parentKey(left) !== '' && parentKey(left) === parentKey(right);
  if (sameParent && criteria >= 0.5) reasons.push('sameParentCriteria');
  const leftMetrics = metricsKey(left);
  if (leftMetrics !== '' && leftMetrics === metricsKey(right)) reasons.push('metricTargets');
  const leftStructure = structuredVariant(left);
  const rightStructure = structuredVariant(right);
  if (leftStructure.hypothesis !== '' && leftStructure.hypothesis === rightStructure.hypothesis) reasons.push('sameHypothesis');
  const title = jaccard(left?.title, right?.title);
  const leftTags = (left?.tags ?? []).join(' ');
  const rightTags = (right?.tags ?? []).join(' ');
  const tags = leftTags === '' && rightTags === '' ? 1 : jaccard(leftTags, rightTags);
  if (title >= 0.4) reasons.push('titleOverlap');
  if (tags >= 0.4) reasons.push('tagOverlap');
  const score = Math.min(1,
    title * 0.6
    + criteria * 0.2
    + tags * 0.1
    + (reasons.includes('promptHashPrefix') ? 0.1 : 0)
    + (reasons.includes('sameParentCriteria') ? 0.1 : 0)
    + (reasons.includes('metricTargets') ? 0.1 : 0)
    + (reasons.includes('sameHypothesis') ? 0.15 : 0));
  return { score: Math.round(score * 1000) / 1000, reasons, title, criteria, sameParent };
}

/** Pair score in [0,1]; kept as a stable API for callers that only need a number. */
export function nodeSimilarity(left, right) {
  return similarityEvidence(left, right).score;
}

/**
 * Exhaustive candidate retrieval. Merge nodes (multiple parents) and terminal
 * failures are excluded because closing them is either meaningless or unsafe.
 */
export function recallCandidates(nodes = [], { threshold = 0.3, limit = 20, excludeIds = [] } = {}) {
  const excluded = new Set(excludeIds);
  const eligible = nodes.filter((node) => {
    if (excluded.has(node.id)) return false;
    if (Array.isArray(node.parentIds) && node.parentIds.length > 1) return false;
    return node.status === 'planned' || node.status === 'proposed' || node.status === 'completed';
  });
  const pairs = [];
  for (let i = 0; i < eligible.length; i += 1) {
    for (let j = i + 1; j < eligible.length; j += 1) {
      // B18: a parameter scan is excluded before scoring; otherwise a model
      // would be asked to close legitimate variants.
      if (variantConflict(eligible[i], eligible[j])) continue;
      const evidence = similarityEvidence(eligible[i], eligible[j]);
      // A single strong structural predicate is a candidate even if the weighted
      // score is below θ: B17 is recall (or), not a linear score threshold.
      const strong = evidence.reasons.some((reason) => reason !== 'tagOverlap');
      if (!strong && evidence.score < threshold) continue;
      pairs.push({
        a: eligible[i].id,
        b: eligible[j].id,
        score: evidence.score,
        reasons: evidence.reasons,
        kind: evidence.score >= 0.75 ? 'duplicate' : evidence.score >= 0.5 ? 'variant' : 'extension',
      });
    }
  }
  pairs.sort((left, right) => right.score - left.score || left.a.localeCompare(right.a) || left.b.localeCompare(right.b));
  return { pairs: pairs.slice(0, limit), total: pairs.length };
}

/** Recall experts for a task: pure keyword overlap over persona/id/skills. */
export function recallExperts(descriptors = [], task = '', { limit = 3 } = {}) {
  const taskTokens = new Set(tokens(task));
  const scored = descriptors.map((descriptor) => {
    const corpus = [descriptor.id, descriptor.persona, ...(descriptor.triggers ?? []), ...(descriptor.mayPropose ?? [])].join(' ');
    const tokensOfDescriptor = new Set(tokens(corpus));
    let overlap = 0;
    for (const token of taskTokens) if (tokensOfDescriptor.has(token)) overlap += 1;
    const score = taskTokens.size === 0 ? 0 : overlap / Math.min(taskTokens.size, Math.max(1, tokensOfDescriptor.size));
    return { id: descriptor.id, score: Math.round(score * 1000) / 1000, matched: [...taskTokens].filter((token) => tokensOfDescriptor.has(token)).sort() };
  }).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  return { experts: scored.slice(0, limit), total: scored.length };
}
