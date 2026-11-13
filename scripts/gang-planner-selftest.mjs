/**
 * Offline self-test for the gang planner (WP P3.5.2-P3.5.4).
 * Run from the plugin directory: `node scripts/gang-planner-selftest.mjs`
 */
import assert from 'node:assert/strict';
import { planSchedule, requestShapes, validatePlan } from '../host/coordinator/gang-planner.js';

const MIN = 60_000;
const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (error) { results.push({ name, ok: false, error }); }
}

function machine(machineId, gpus, labels = {}, model = 'A100') {
  return { machineId, labels, devices: Array.from({ length: gpus }, (_, i) => ({ id: `g${i}`, model })) };
}
function lease(leaseId, machineId, deviceIds, hardEndAt) {
  return { leaseId, machines: [{ machineId, deviceIds }], hardEndAt };
}
function plan(input) {
  const out = planSchedule(input);
  assert.deepEqual(validatePlan(input, out), [], 'plan must be valid');
  return out;
}

test('legacy amount/machines converts to a balanced shape', () => {
  assert.deepEqual(requestShapes({ amount: 6, machines: 2 }), [[3, 3]]);
  assert.deepEqual(requestShapes({ amount: 7, machines: 3 }), [[3, 2, 2]]);
  assert.deepEqual(requestShapes({ amount: 1 }), [[1]]);
  assert.deepEqual(requestShapes({ amount: 1, machines: 2 }), []);
  assert.deepEqual(requestShapes({ shapes: [{ machines: 2, gpusPerMachine: 4 }, { sizes: [8] }] }), [[4, 4], [8]]);
});

// Two 8-GPU machines; m1 has 2 GPUs busy until +30 min, m2 has 1 GPU busy until +50 min.
const base = {
  now: 0,
  machines: [machine('m1', 8), machine('m2', 8)],
  leases: [lease('L1', 'm1', ['g0', 'g1'], 30 * MIN), lease('L2', 'm2', ['g0'], 50 * MIN)],
};
const gang = { requestId: 'gang', priority: 0, enqueuedAt: 1, shapes: [{ machines: 2, gpusPerMachine: 8 }], walltimeMs: 120 * MIN };
const smallLong = { requestId: 'small-long', priority: 0, enqueuedAt: 2, amount: 1, walltimeMs: 90 * MIN };
const smallShort = { requestId: 'small-short', priority: 0, enqueuedAt: 3, amount: 1, walltimeMs: 20 * MIN };
const smallUnknown = { requestId: 'small-unknown', priority: 0, enqueuedAt: 4, amount: 1 };

test('greedy (today) lets small requests take freed GPUs past a blocked gang request', () => {
  const out = plan({ ...base, queue: [gang, smallLong, smallShort, smallUnknown], policy: { mode: 'greedy' } });
  assert.deepEqual(out.grants.map((g) => g.requestId).sort(), ['small-long', 'small-short', 'small-unknown']);
  assert.equal(out.reservations.length, 0);
  assert.equal(out.waiting[0].requestId, 'gang');
});

test('EASY reserves the gang request at its earliest start and only backfills jobs that end before it', () => {
  const out = plan({ ...base, queue: [gang, smallLong, smallShort, smallUnknown], policy: { mode: 'easy' } });
  assert.equal(out.reservations.length, 1);
  assert.equal(out.reservations[0].requestId, 'gang');
  assert.equal(out.reservations[0].startAt, 50 * MIN, 'both machines are fully free at +50 min');
  assert.deepEqual(out.grants.map((g) => g.requestId), ['small-short'], '20-min job ends before +50 min');
  const reasons = Object.fromEntries(out.waiting.map((w) => [w.requestId, w.reason]));
  assert.equal(reasons['small-long'], 'behind-reservation');
  assert.equal(reasons['small-unknown'], 'behind-reservation', 'no walltime => cannot be backfilled into a reservation');
});

test('backfill may use devices that the reservation does not need', () => {
  const machines = [machine('m1', 8), machine('m2', 8), machine('m3', 2)];
  const out = plan({ now: 0, machines, leases: base.leases, queue: [gang, smallLong], policy: { mode: 'easy' } });
  assert.equal(out.reservations[0].requestId, 'gang');
  assert.equal(out.grants[0].requestId, 'small-long');
  assert.equal(out.grants[0].allocation[0].machineId, 'm3');
});

test('a gang request that fits now is granted atomically across machines', () => {
  const out = plan({ now: 0, machines: [machine('m1', 8), machine('m2', 8)], leases: [], queue: [gang] });
  assert.equal(out.grants.length, 1);
  assert.deepEqual(out.grants[0].allocation.map((g) => [g.machineId, g.deviceIds.length]), [['m1', 8], ['m2', 8]]);
  assert.equal(out.grants[0].hardEndAt, 120 * MIN);
});

test('alternative shapes: the first shape that fits now wins', () => {
  const flexible = { requestId: 'flex', shapes: [{ machines: 2, gpusPerMachine: 4 }, { machines: 1, gpusPerMachine: 8 }], walltimeMs: 60 * MIN };
  const busy = [lease('B', 'm2', ['g0', 'g1', 'g2', 'g3', 'g4'], 30 * MIN)];
  const out = plan({ now: 0, machines: [machine('m1', 8), machine('m2', 8)], leases: busy, queue: [flexible] });
  assert.equal(out.grants[0].shapeIndex, 1);
  assert.deepEqual(out.grants[0].allocation.map((g) => g.machineId), ['m1']);
});

test('best fit keeps whole machines free for later gang requests', () => {
  const partly = [lease('P', 'm2', ['g0', 'g1', 'g2', 'g3', 'g4', 'g5'], 30 * MIN)];
  const out = plan({ now: 0, machines: [machine('m1', 8), machine('m2', 8)], leases: partly, queue: [{ requestId: 'one', amount: 1, walltimeMs: MIN }] });
  assert.equal(out.grants[0].allocation[0].machineId, 'm2', 'goes to the fuller machine');
});

test('colocate keeps every part inside one label group', () => {
  const machines = [machine('a1', 4, { rack: 'a' }), machine('b1', 4, { rack: 'b' }), machine('b2', 4, { rack: 'b' })];
  const leases = [lease('X', 'b2', ['g0'], 10 * MIN)];
  const request = { requestId: 'co', shapes: [{ machines: 2, gpusPerMachine: 4 }], walltimeMs: 30 * MIN, constraints: { colocate: 'rack' } };
  const out = plan({ now: 0, machines, leases, queue: [request] });
  assert.equal(out.grants.length, 0);
  assert.equal(out.reservations[0].startAt, 10 * MIN);
  assert.deepEqual(out.reservations[0].allocation.map((g) => g.machineId), ['b1', 'b2']);
});

test('constraints: machine ids, labels and GPU models filter candidates', () => {
  const machines = [machine('m1', 4, { pool: 'x' }, 'H100'), machine('m2', 4, { pool: 'y' }, 'A100')];
  const pick = (constraints) => plan({ now: 0, machines, leases: [], queue: [{ requestId: 'r', amount: 1, walltimeMs: MIN, constraints }] }).grants[0]?.allocation[0].machineId;
  assert.equal(pick({ gpuModels: ['a100'] }), 'm2');
  assert.equal(pick({ machineLabels: { pool: ['x'] } }), 'm1');
  assert.equal(pick({ excludeMachineIds: ['m1'] }), 'm2');
  assert.equal(pick({ machineIds: ['m1'] }), 'm1');
});

test('offline machines are never planned on', () => {
  const machines = [machine('m1', 8), { ...machine('m2', 8), online: false }];
  const out = plan({ now: 0, machines, leases: [], queue: [gang] });
  assert.equal(out.waiting[0].reason, 'exceeds-cluster-capacity');
});

test('leases without a hard end make the start unknown instead of guessing', () => {
  const out = plan({ now: 0, machines: base.machines, leases: [lease('U', 'm1', ['g0'], undefined)], queue: [gang] });
  assert.match(out.waiting[0].reason, /no-known-start/);
});

test('conservative mode gives every blocked request a non-overlapping reservation', () => {
  const second = { ...gang, requestId: 'gang-2', enqueuedAt: 5 };
  const out = plan({ ...base, queue: [gang, second, smallLong], policy: { mode: 'conservative' } });
  // Queue order is gang (t=1), small-long (t=2), gang-2 (t=5): small-long is
  // reserved right after gang ends, gang-2 after small-long frees its GPU.
  assert.deepEqual(out.reservations.map((r) => [r.requestId, r.startAt / MIN]), [['gang', 50], ['small-long', 170], ['gang-2', 260]]);
});

test('priority order decides who gets the reservation; preordered keeps a negotiated order', () => {
  const urgentSmall = { ...smallLong, requestId: 'urgent', priority: 10 };
  const byPriority = plan({ ...base, queue: [gang, urgentSmall] });
  assert.equal(byPriority.grants[0].requestId, 'urgent');
  const negotiated = plan({ ...base, queue: [gang, urgentSmall], policy: { preordered: true } });
  assert.equal(negotiated.reservations[0].requestId, 'gang');
  assert.equal(negotiated.waiting[0].requestId, 'urgent');
});

test('validatePlan catches double booking', () => {
  const input = { now: 0, machines: [machine('m1', 1)], leases: [], queue: [{ requestId: 'a', amount: 1 }, { requestId: 'b', amount: 1 }] };
  const bogus = {
    grants: [
      { requestId: 'a', shapeIndex: 0, allocation: [{ machineId: 'm1', deviceIds: ['g0'] }], startAt: 0, hardEndAt: null },
      { requestId: 'b', shapeIndex: 0, allocation: [{ machineId: 'm1', deviceIds: ['g0'] }], startAt: 0, hardEndAt: null },
    ],
    reservations: [],
  };
  assert.equal(validatePlan(input, bogus).length, 1);
});

let failed = 0;
for (const result of results) {
  if (result.ok) console.log(`ok   ${result.name}`);
  else { failed += 1; console.log(`FAIL ${result.name}\n     ${result.error?.stack ?? result.error}`); }
}
console.log(`\n${results.length - failed}/${results.length} gang planner checks passed`);
process.exit(failed === 0 ? 0 : 1);
