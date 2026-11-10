/**
 * Deterministic recall (Stage 4.2). Finding duplicates is a retrieval problem:
 * this module enumerates every eligible pair and scores it with plain token
 * overlap. There is no model call and no randomness, so the same DAG always
 * yields the same candidates (asserted by the selftest).
 */
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'with', 'by', 'is', 'are', 'be', 'from', 'as', 'at', 'it', 'this', 'that']);

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

/** Pair score in [0,1]; title dominates, criteria and tags refine. */
export function nodeSimilarity(left, right) {
  const title = jaccard(left?.title, right?.title);
  const criteria = jaccard(left?.successCriteria, right?.successCriteria);
  const tags = jaccard((left?.tags ?? []).join(' '), (right?.tags ?? []).join(' '));
  const sameHash = left?.promptHash && left.promptHash === right?.promptHash ? 0.15 : 0;
  return Math.min(1, title * 0.7 + criteria * 0.2 + tags * 0.1 + sameHash);
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
      const score = nodeSimilarity(eligible[i], eligible[j]);
      if (score < threshold) continue;
      pairs.push({
        a: eligible[i].id,
        b: eligible[j].id,
        score: Math.round(score * 1000) / 1000,
        kind: score >= 0.75 ? 'duplicate' : score >= 0.5 ? 'variant' : 'extension',
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
