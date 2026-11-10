/**
 * Priority model shared by the kernel, the dispatcher and the experts.
 *
 * A node's priority is `{ class, score, by, reason, at }`. Ordering is the
 * lexicographic tuple (class rank, -score, createdAt, seq): the class always
 * wins, the score breaks ties inside a class, then age, then creation order.
 *
 * `deferred` is a priority class, not a node status (design decision B6): a
 * deferred node stays `planned` but is never runnable until it is restored.
 *
 * Pure functions only; no I/O.
 */

/** Ordered from most to least urgent. `deferred` is never dispatched. */
export const PRIORITY_CLASSES = Object.freeze(['p0', 'p1', 'p2', 'p3', 'deferred']);

export const DEFAULT_PRIORITY_CLASS = 'p2';
export const HUMAN_PRIORITY_CLASS = 'p0';

const CLASS_RANK = new Map(PRIORITY_CLASSES.map((name, index) => [name, index]));

/** @returns {boolean} whether `value` names a known priority class. */
export function isPriorityClass(value) {
  return CLASS_RANK.has(value);
}

/**
 * Normalize a stored or proposed priority object. Unknown classes fall back to
 * the default class; scores are clamped to [-1000, 1000].
 * @param {object|undefined|null} raw
 * @param {{ by?: string, at?: number }} [defaults]
 */
export function normalizePriority(raw, defaults = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const cls = isPriorityClass(source.class) ? source.class : DEFAULT_PRIORITY_CLASS;
  const score = Number.isFinite(source.score) ? Math.max(-1000, Math.min(1000, source.score)) : 0;
  return {
    class: cls,
    score,
    by: typeof source.by === 'string' ? source.by : (defaults.by ?? 'system'),
    reason: typeof source.reason === 'string' ? source.reason.slice(0, 500) : '',
    at: Number.isFinite(source.at) ? source.at : (defaults.at ?? 0),
  };
}

/** @returns {number} rank of a class; unknown classes rank as the default class. */
export function classRank(cls) {
  return CLASS_RANK.get(cls) ?? CLASS_RANK.get(DEFAULT_PRIORITY_CLASS);
}

/**
 * Comparator over nodes (or any object with `priority`, `timestamps.createdAt`, `seq`/`id`).
 * Negative when `a` should be dispatched before `b`.
 */
export function comparePriority(a, b) {
  const pa = normalizePriority(a?.priority);
  const pb = normalizePriority(b?.priority);
  const byClass = classRank(pa.class) - classRank(pb.class);
  if (byClass !== 0) return byClass;
  if (pa.score !== pb.score) return pb.score - pa.score;
  const ca = a?.timestamps?.createdAt ?? a?.createdAt ?? 0;
  const cb = b?.timestamps?.createdAt ?? b?.createdAt ?? 0;
  if (ca !== cb) return ca - cb;
  const sa = a?.seq ?? 0;
  const sb = b?.seq ?? 0;
  if (sa !== sb) return sa - sb;
  return String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
}

/** @returns {boolean} whether a node with this priority may ever be dispatched. */
export function isDispatchableClass(priority) {
  return normalizePriority(priority).class !== 'deferred';
}

/**
 * Completely-fair ordering across sources inside one priority class.
 *
 * Every source (an expert id, `human`, `legacy-advisor`, ...) accumulates a
 * virtual runtime equal to the GPU-seconds its nodes have consumed divided by
 * its weight. Candidates are ordered by class first, then by their source's
 * virtual runtime (lowest first), then by the normal tuple. The source map is
 * an input so the function stays pure; the caller owns the accounting.
 *
 * @param {Array<object>} nodes candidates (each with `priority.by` as source)
 * @param {Map<string, {gpuSeconds: number, weight?: number}>} usageBySource
 * @param {{ slotSeconds?: number, limit?: number }} [options] nominal cost of one slot (default 3600)
 *   and an optional cap on the returned prefix. The cap is a real optimisation:
 *   the dispatcher only needs the next `maxStartsPerRound` nodes, and a full
 *   order of 500+ candidates costs O(n²) priority normalisations on the hot path.
 * @returns {Array<object>} a new, ordered array (at most `limit` entries)
 */
export function fairOrder(nodes, usageBySource = new Map(), options = {}) {
  const slotSeconds = Number.isFinite(options.slotSeconds) && options.slotSeconds > 0 ? options.slotSeconds : 3600;
  const limit = Number.isFinite(options.limit) && options.limit >= 0 ? Math.floor(options.limit) : Infinity;
  const weightOf = (source) => {
    const weight = usageBySource.get(source)?.weight;
    return weight && weight > 0 ? weight : 1;
  };
  const vruntime = (node) => {
    const source = normalizePriority(node?.priority).by;
    return (usageBySource.get(source)?.gpuSeconds ?? 0) / weightOf(source);
  };
  // Simulate the fair-share effect of handing out slots in order: once a source
  // gets a slot its vruntime grows by one nominal slot (`slotSeconds` GPU-seconds
  // divided by its weight), so one prolific source cannot take every slot.
  const pending = [...nodes];
  const bump = new Map();
  const out = [];
  while (pending.length > 0 && out.length < limit) {
    let bestIndex = 0;
    for (let index = 1; index < pending.length; index += 1) {
      const candidate = pending[index];
      const best = pending[bestIndex];
      const pc = normalizePriority(candidate.priority);
      const pb = normalizePriority(best.priority);
      const byClass = classRank(pc.class) - classRank(pb.class);
      if (byClass < 0) { bestIndex = index; continue; }
      if (byClass > 0) continue;
      const vc = vruntime(candidate) + (bump.get(pc.by) ?? 0);
      const vb = vruntime(best) + (bump.get(pb.by) ?? 0);
      if (vc < vb || (vc === vb && comparePriority(candidate, best) < 0)) bestIndex = index;
    }
    const [chosen] = pending.splice(bestIndex, 1);
    const source = normalizePriority(chosen.priority).by;
    bump.set(source, (bump.get(source) ?? 0) + slotSeconds / weightOf(source));
    out.push(chosen);
  }
  return out;
}
