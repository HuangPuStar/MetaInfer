/**
 * Node titles are LABELS, not instructions.
 *
 * A title is shown in the UI/DAG, in advisor and scheduler snapshots, in the
 * worker prompt as a descriptive line, and in the git commit subject. None of
 * those places may change what an agent is asked to do: the authoritative
 * instruction set is `node.prompt` (+ `node.successCriteria`), and the worker
 * prompt says so explicitly.
 *
 * Because a title is only a label, an over-long title is not an error — it is
 * clamped. Rejecting it (the old behaviour) silently discarded whole advisor
 * proposals and, in one project, tripped the no-progress breaker and paused the
 * auto driver for hours.
 */

/** Hard ceiling for a node title, in characters, after clamping. */
export const NODE_TITLE_MAX = 120;

/** Cap used when a caller only wants a short label (dashboard rows, commit subjects). */
export const NODE_TITLE_SOFT_MAX = 120;

const ELLIPSIS = '\u2026';

/**
 * Normalise an arbitrary string into a node title of at most `max` characters.
 *
 * - collapses all whitespace (including newlines/tabs) into single spaces, so a
 *   multi-line proposal cannot smuggle structure into a one-line label;
 * - trims;
 * - if the result is too long, cuts at the last word boundary when that keeps
 *   at least 60% of the budget, otherwise cuts mid-word, and appends an ellipsis
 *   so the truncation is visible rather than looking like a finished sentence.
 *
 * Returns `''` for non-strings / empty input; callers decide whether an empty
 * title is acceptable.
 *
 * @param {unknown} value raw title
 * @param {number} [max] maximum length (>= 1)
 * @returns {string}
 */
export function clampNodeTitle(value, max = NODE_TITLE_MAX) {
  const limit = Number.isInteger(max) && max > 0 ? max : NODE_TITLE_MAX;
  if (typeof value !== 'string') return '';
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= limit) return collapsed;
  // Reserve one character for the ellipsis so the result never exceeds `limit`.
  const budget = Math.max(1, limit - 1);
  const head = collapsed.slice(0, budget);
  const lastSpace = head.lastIndexOf(' ');
  const cut = lastSpace >= Math.ceil(budget * 0.6) ? head.slice(0, lastSpace) : head;
  return `${cut.trimEnd()}${ELLIPSIS}`;
}

/** @param {unknown} value */
export function isBlank(value) {
  return typeof value !== 'string' || value.trim().length === 0;
}
