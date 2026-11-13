/**
 * B23 prediction-error primitive. A proposal records the metric change it
 * expects; after the node completes the Host compares the prediction with the
 * report's measured metric. The result is a retro ticket, never a model debate.
 */
export const PREDICTION_DIRECTIONS = Object.freeze(['up', 'down']);
export const DEFAULT_CALIBRATION_THRESHOLD = 0.5;

function metricValue(metrics, name) {
  if (Array.isArray(metrics)) {
    const row = metrics.find((entry) => entry?.name === name);
    if (!row) return null;
    const value = Number(row.value);
    return Number.isFinite(value) ? value : null;
  }
  if (metrics && typeof metrics === 'object') {
    const value = Number(metrics[name]);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

/** Normalize a proposal's `expected` block; absent means no prediction. */
export function normalizeExpected(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('expected must be an object');
  const metric = typeof value.metric === 'string' ? value.metric.trim() : '';
  if (!metric) throw new TypeError('expected.metric is required');
  const direction = typeof value.direction === 'string' ? value.direction.trim() : '';
  if (!PREDICTION_DIRECTIONS.includes(direction)) throw new TypeError('expected.direction must be up or down');
  const magnitude = Number(value.magnitude);
  if (!Number.isFinite(magnitude) || magnitude < 0) throw new TypeError('expected.magnitude must be a non-negative number');
  return {
    metric: metric.slice(0, 80),
    direction,
    magnitude,
    ...(typeof value.unit === 'string' && value.unit.trim() ? { unit: value.unit.trim().slice(0, 40) } : {}),
  };
}

/** Read the baseline from the parent report (metric value before this node). */
export function baselineFor(parent, expected) {
  if (!expected) return null;
  return metricValue(parent?.report?.metrics, expected.metric);
}

/**
 * Compare expected direction/magnitude with observed delta.
 * @returns {null | {metric, expected, actual, delta, directionMatched, withinMagnitude, deviation, retroOpen, calibration}}
 */
export function evaluateExpected(expected, metrics, baseline = null, threshold = DEFAULT_CALIBRATION_THRESHOLD) {
  if (!expected) return null;
  const actual = metricValue(metrics, expected.metric);
  if (actual === null) {
    return {
      metric: expected.metric,
      expected,
      actual: null,
      baseline,
      delta: null,
      directionMatched: null,
      withinMagnitude: null,
      deviation: null,
      retroOpen: true,
      calibration: 'missing_metric',
      reason: 'report_metric_missing',
    };
  }
  if (baseline === null || baseline === undefined || !Number.isFinite(Number(baseline))) {
    return {
      metric: expected.metric,
      expected,
      actual,
      baseline: null,
      delta: null,
      directionMatched: null,
      withinMagnitude: null,
      deviation: null,
      retroOpen: true,
      calibration: 'missing_baseline',
      reason: 'expected_baseline_missing',
    };
  }
  const base = Number(baseline);
  const delta = actual - base;
  const directionMatched = expected.direction === 'up' ? delta >= 0 : delta <= 0;
  const deviation = Math.abs(Math.abs(delta) - expected.magnitude);
  const withinMagnitude = deviation <= Math.max(expected.magnitude * threshold, 0);
  return {
    metric: expected.metric,
    expected,
    actual,
    baseline: base,
    delta,
    directionMatched,
    withinMagnitude,
    deviation,
    retroOpen: !directionMatched || !withinMagnitude,
    calibration: directionMatched && withinMagnitude ? 'calibrated' : directionMatched ? 'magnitude_off' : 'direction_off',
    reason: !directionMatched ? 'direction_missed' : !withinMagnitude ? 'magnitude_missed' : 'within_threshold',
  };
}


/**
 * Apply one post-completion comparison to a node record. Mutates the supplied
 * node (the runtime is its single writer) and returns the ticket flag so the
 * caller can write the durable `retro/opened` event exactly once.
 */
export function applyPredictionToNode(node, now = Date.now()) {
  if (!node || typeof node !== 'object') return null;
  const prediction = evaluateExpected(node.expected, node.report?.metrics, node.expectedBaseline);
  if (!prediction) return null;
  const openRetroTicket = prediction.retroOpen === true && !node.expectedRetroAt;
  node.expectedOutcome = prediction;
  if (openRetroTicket) node.expectedRetroAt = now;
  return { prediction, openRetroTicket };
}
