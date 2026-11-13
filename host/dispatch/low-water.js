/**
 * Low-watermark planner trigger (design decision: deterministic pre-trigger).
 *
 * The old driver planned only when the runnable queue was already empty, i.e.
 * after the GPUs had gone idle, and then paid the full planner latency
 * (measured advisor 129 s + scheduler 18 s, p90 ~265 s). This module answers a
 * single question deterministically: "is the remaining work smaller than the
 * time it takes to plan the next batch?"
 *
 * Rules:
 *   - trigger when `remainingMs <= max(minRemainingMs, planLatencyMs * safety)`;
 *   - never overlap two planning passes (`beginPlanning`/`endPlanning`);
 *   - debounce terminations: a burst of completions inside `debounceMs` fires
 *     once, because they mean the same thing ("the queue is draining");
 *   - coalesce work that arrives during a pass: `endPlanning` re-arms, and the
 *     next `evaluate` may fire again after `minGapMs`.
 *
 * No LLM, no I/O, clock injected.
 */

const DEFAULTS = Object.freeze({
  // QA values: trigger with ~5 min of runnable work left, then debounce 60 s.
  planLatencyMs: 300_000,
  safetyFactor: 1.0,
  minRemainingMs: 300_000,
  debounceMs: 60_000,
  minGapMs: 30_000,
});

/**
 * @param {object} deps
 * @param {() => number} deps.getRemainingMs remaining runnable work (sum of timeboxes)
 * @param {() => number} [deps.getQueueDepth] number of runnable nodes
 * @param {() => number} [deps.clock]
 * @param {number} [deps.planLatencyMs]
 * @param {number} [deps.safetyFactor]
 * @param {number} [deps.minRemainingMs]
 * @param {number} [deps.debounceMs]
 * @param {number} [deps.minGapMs]
 */
export function createLowWaterPlanner({
  getRemainingMs,
  getQueueDepth = () => 0,
  clock = Date.now,
  planLatencyMs = DEFAULTS.planLatencyMs,
  safetyFactor = DEFAULTS.safetyFactor,
  minRemainingMs = DEFAULTS.minRemainingMs,
  debounceMs = DEFAULTS.debounceMs,
  minGapMs = DEFAULTS.minGapMs,
}) {
  let planning = false;
  let lastFireAt = -Infinity;
  let lastPlanEndAt = -Infinity;
  let dirtyDuringPlan = false;
  let fires = 0;
  let lastDecision = null;

  function watermarkMs() {
    return Math.max(minRemainingMs, planLatencyMs * safetyFactor);
  }

  /**
   * @param {{ remainingMs?: number, queueDepth?: number }} [sample] optional
   *   pre-computed sample so the caller does not scan nodes twice.
   */
  function evaluate(sample = {}) {
    const now = clock();
    const remainingMs = Number.isFinite(sample.remainingMs) ? sample.remainingMs : getRemainingMs();
    const queueDepth = Number.isFinite(sample.queueDepth) ? sample.queueDepth : getQueueDepth();
    const thresholdMs = watermarkMs();
    const base = { remainingMs, queueDepth, thresholdMs, now };
    if (planning) {
      lastDecision = { trigger: false, reason: 'planning', ...base };
      return lastDecision;
    }
    if (queueDepth <= 0 && remainingMs <= 0) {
      lastDecision = { trigger: false, reason: 'no_work', ...base };
      return lastDecision;
    }
    if (remainingMs > thresholdMs) {
      lastDecision = { trigger: false, reason: 'above_watermark', ...base };
      return lastDecision;
    }
    const sinceFire = now - lastFireAt;
    if (sinceFire < debounceMs) {
      lastDecision = { trigger: false, reason: 'debounced', sinceFireMs: sinceFire, ...base };
      return lastDecision;
    }
    const sincePlan = now - lastPlanEndAt;
    if (sincePlan < minGapMs) {
      lastDecision = { trigger: false, reason: 'min_gap', sincePlanMs: sincePlan, ...base };
      return lastDecision;
    }
    lastFireAt = now;
    fires += 1;
    lastDecision = { trigger: true, reason: 'below_watermark', ...base };
    return lastDecision;
  }

  function beginPlanning() {
    planning = true;
    dirtyDuringPlan = false;
  }

  /**
   * @param {{ created?: number, started?: number }} [outcome]
   */
  function endPlanning(outcome = {}) {
    planning = false;
    lastPlanEndAt = clock();
    dirtyDuringPlan = dirtyDuringPlan || (outcome.created ?? 0) > 0 || (outcome.started ?? 0) > 0;
    return dirtyDuringPlan;
  }

  /** Work changed (node added/terminated); the next evaluate sees fresh numbers anyway. */
  function noteChange() {
    if (planning) dirtyDuringPlan = true;
  }

  function state() {
    return {
      planning,
      lastFireAt: Number.isFinite(lastFireAt) ? lastFireAt : null,
      lastPlanEndAt: Number.isFinite(lastPlanEndAt) ? lastPlanEndAt : null,
      fires,
      debounceMs,
      minGapMs,
      planLatencyMs,
      safetyFactor,
      watermarkMs: watermarkMs(),
      lastDecision,
    };
  }

  return { evaluate, beginPlanning, endPlanning, noteChange, state, watermarkMs };
}

/** Resolve the planner knobs from a project config with defaults. */
export function planningConfigOf(project) {
  const raw = project?.config?.planning ?? {};
  const number = (value, fallback, min) => (Number.isFinite(value) && value >= min ? value : fallback);
  return {
    planLatencyMs: number(raw.planLatencyMs, DEFAULTS.planLatencyMs, 1_000),
    safetyFactor: number(raw.safetyFactor, DEFAULTS.safetyFactor, 0.1),
    minRemainingMs: number(raw.minRemainingMs, DEFAULTS.minRemainingMs, 0),
    debounceMs: number(raw.debounceMs, DEFAULTS.debounceMs, 0),
    minGapMs: number(raw.minGapMs, DEFAULTS.minGapMs, 0),
  };
}
