/**
 * Self-test for the low-watermark planner trigger.
 * Run: `node scripts/low-water-selftest.mjs`
 */
import assert from 'node:assert/strict';
import { createLowWaterPlanner, planningConfigOf } from '../host/dispatch/low-water.js';

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

function harness({ remainingMs = 0, queueDepth = 0, now = 0, ...options } = {}) {
  const state = { now, remainingMs, queueDepth };
  const planner = createLowWaterPlanner({
    getRemainingMs: () => state.remainingMs,
    getQueueDepth: () => state.queueDepth,
    clock: () => state.now,
    planLatencyMs: 300_000,
    debounceMs: 60_000,
    minGapMs: 30_000,
    minRemainingMs: 300_000,
    ...options,
  });
  return { planner, state };
}

test('does not trigger while the queue is above the watermark', () => {
  const { planner, state } = harness();
  state.remainingMs = 3_600_000;
  state.queueDepth = 6;
  const decision = planner.evaluate();
  assert.equal(decision.trigger, false);
  assert.equal(decision.reason, 'above_watermark');
  assert.equal(decision.thresholdMs, 300_000);
});

test('triggers when remaining work is below planner latency', () => {
  const { planner, state } = harness();
  state.remainingMs = 120_000;
  state.queueDepth = 2;
  const decision = planner.evaluate();
  assert.equal(decision.trigger, true);
  assert.equal(decision.reason, 'below_watermark');
  assert.equal(decision.remainingMs, 120_000);
});

test('a burst of terminations inside the debounce window fires once', () => {
  const { planner, state } = harness();
  state.remainingMs = 100_000;
  state.queueDepth = 2;
  assert.equal(planner.evaluate().trigger, true);
  state.now += 1_000;
  state.remainingMs = 50_000;
  const second = planner.evaluate();
  assert.equal(second.trigger, false);
  assert.equal(second.reason, 'debounced');
  state.now += 30_000;
  assert.equal(planner.evaluate().trigger, false, 'still inside the 60 s debounce');
  state.now += 30_000;
  assert.equal(planner.evaluate().trigger, true, 'debounce expired and work is still low');
});

test('no trigger without work, even at zero remaining', () => {
  const { planner } = harness();
  const decision = planner.evaluate();
  assert.equal(decision.trigger, false);
  assert.equal(decision.reason, 'no_work');
});

test('no overlapping planning passes, and work during a pass coalesces', () => {
  const { planner, state } = harness();
  state.remainingMs = 0;
  state.queueDepth = 1;
  planner.beginPlanning();
  const during = planner.evaluate();
  assert.equal(during.trigger, false);
  assert.equal(during.reason, 'planning');
  planner.noteChange();
  assert.equal(planner.endPlanning({ created: 0 }), true, 'a change during the pass is remembered');
  state.now += 30_000;
  const after = planner.evaluate();
  assert.equal(after.trigger, true, 're-armed after the pass');
});

test('the minimum gap applies after a pass even when the debounce expired', () => {
  const { planner, state } = harness({ debounceMs: 0, minGapMs: 30_000 });
  state.remainingMs = 1;
  state.queueDepth = 1;
  assert.equal(planner.evaluate().trigger, true);
  planner.beginPlanning();
  state.now += 5_000;
  planner.endPlanning({ created: 0 });
  state.now += 10_000;
  const decision = planner.evaluate();
  assert.equal(decision.trigger, false);
  assert.equal(decision.reason, 'min_gap');
  state.now += 20_000;
  assert.equal(planner.evaluate().trigger, true);
});

test('the watermark adapts to planner latency and safety factor', () => {
  const { planner } = harness({ planLatencyMs: 600_000, safetyFactor: 1.5, minRemainingMs: 60_000 });
  assert.equal(planner.watermarkMs(), 900_000);
  const config = planningConfigOf({ config: { planning: { planLatencyMs: 600_000, safetyFactor: 1.5 } } });
  assert.equal(config.planLatencyMs, 600_000);
  assert.equal(config.safetyFactor, 1.5);
  assert.equal(planningConfigOf({}).planLatencyMs, 300_000);
  assert.equal(planningConfigOf({ config: { planning: { debounceMs: -1 } } }).debounceMs, 60_000);
});

test('state() exposes the last decision for the metrics surface', () => {
  const { planner, state } = harness();
  state.remainingMs = 1;
  state.queueDepth = 1;
  planner.evaluate();
  const snapshot = planner.state();
  assert.equal(snapshot.fires, 1);
  assert.equal(snapshot.lastDecision.reason, 'below_watermark');
  assert.equal(snapshot.planning, false);
});

let failed = 0;
for (const result of results) {
  if (result.ok) console.log(`ok   ${result.name}`);
  else {
    failed += 1;
    console.log(`FAIL ${result.name}\n     ${result.error?.stack ?? result.error}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} low-water checks passed`);
process.exit(failed === 0 ? 0 : 1);
