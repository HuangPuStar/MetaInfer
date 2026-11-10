/**
 * Discrete-event simulation: one gang request among a saturating stream of
 * single-GPU requests, scheduled by the gang planner in greedy (today's
 * coordinator behaviour), EASY and conservative modes.
 *
 * Run: `node scripts/sim/gang-starvation.mjs [--seed 7] [--hours 24] [--json]`
 * Exit code 1 if EASY/conservative violate the starvation bound or any plan is invalid.
 *
 * Starvation bound checked: with reservations, the gang request must start no
 * later than (its arrival + the longest walltime among requests ahead of it or
 * running when it arrived). Jobs finish at or before their walltime (hard end),
 * mirroring the Lab's deterministic timebox watchdog.
 */
import { planSchedule, validatePlan } from '../../host/coordinator/gang-planner.js';

const MIN = 60_000;
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? Number(args[index + 1]) : fallback;
};
const SEED = option('seed', 7);
const HOURS = option('hours', 24);
const JSON_OUT = args.includes('--json');

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function workload(seed) {
  const random = rng(seed);
  const jobs = [];
  let t = 0;
  let index = 0;
  // Mean 25-min single-GPU jobs arriving every ~1.5 min keep 16 GPUs saturated.
  while (t < HOURS * 60 * MIN) {
    t += Math.round((0.5 + random() * 2) * MIN);
    const walltimeMs = Math.round((10 + random() * 30) * MIN);
    jobs.push({ requestId: `s-${String(index++).padStart(4, '0')}`, arrival: t, amount: 1, walltimeMs, actualMs: Math.round(walltimeMs * (0.5 + random() * 0.5)) });
  }
  jobs.push({ requestId: 'gang-16', arrival: 30 * MIN, shapes: [{ machines: 2, gpusPerMachine: 8 }], walltimeMs: 60 * MIN, actualMs: 55 * MIN });
  return jobs.sort((a, b) => a.arrival - b.arrival || a.requestId.localeCompare(b.requestId));
}

function simulate(mode, jobs) {
  const machines = ['m1', 'm2'].map((machineId) => ({ machineId, devices: Array.from({ length: 8 }, (_, i) => ({ id: `g${i}` })) }));
  const horizon = HOURS * 60 * MIN;
  const pending = [...jobs];
  const queue = [];
  const running = new Map();
  const started = new Map();
  let now = 0;
  let busyGpuMs = 0;
  let invalidPlans = 0;
  let gangBound = null;
  while (now <= horizon) {
    // Arrivals.
    while (pending.length > 0 && pending[0].arrival <= now) {
      const job = pending.shift();
      queue.push({ ...job, enqueuedAt: job.arrival, priority: 0 });
      if (job.requestId === 'gang-16') {
        const ahead = [...running.values()].map((r) => r.hardEndAt);
        gangBound = Math.max(now, ...ahead);
      }
    }
    const leases = [...running.values()].map((r) => ({ leaseId: r.requestId, machines: r.allocation, hardEndAt: r.hardEndAt }));
    const input = { now, machines, leases, queue };
    const plan = planSchedule({ ...input, policy: { mode } });
    if (validatePlan(input, plan).length > 0) invalidPlans += 1;
    for (const grant of plan.grants) {
      const job = queue.find((q) => q.requestId === grant.requestId);
      queue.splice(queue.indexOf(job), 1);
      running.set(job.requestId, { requestId: job.requestId, allocation: grant.allocation, endAt: now + job.actualMs, hardEndAt: grant.hardEndAt ?? Infinity, gpus: grant.allocation.reduce((n, g) => n + g.deviceIds.length, 0) });
      started.set(job.requestId, { startAt: now, waitMs: now - job.arrival });
    }
    // Advance to the next event: an arrival or a completion.
    const nextArrival = pending[0]?.arrival ?? Infinity;
    const nextEnd = Math.min(...[...running.values()].map((r) => r.endAt), Infinity);
    const next = Math.min(nextArrival, nextEnd);
    if (!Number.isFinite(next)) break;
    for (const r of running.values()) busyGpuMs += r.gpus * (Math.min(next, horizon) - now);
    now = next;
    for (const [id, r] of running) if (r.endAt <= now) running.delete(id);
  }
  const gang = started.get('gang-16');
  const small = [...started.entries()].filter(([id]) => id !== 'gang-16').map(([, s]) => s.waitMs);
  return {
    mode,
    gangStartMin: gang ? gang.startAt / MIN : null,
    gangWaitMin: gang ? gang.waitMs / MIN : null,
    gangBoundMin: gangBound === null ? null : gangBound / MIN,
    utilization: busyGpuMs / (16 * horizon),
    smallStarted: small.length,
    smallMeanWaitMin: small.reduce((a, b) => a + b, 0) / Math.max(1, small.length) / MIN,
    invalidPlans,
  };
}

const jobs = workload(SEED);
const report = ['greedy', 'easy', 'conservative'].map((mode) => simulate(mode, jobs));
let failed = false;
for (const row of report) {
  if (row.invalidPlans > 0) failed = true;
  if (row.mode !== 'greedy' && (row.gangStartMin === null || row.gangStartMin > row.gangBoundMin + 1e-9)) failed = true;
}
if (JSON_OUT) {
  console.log(JSON.stringify({ seed: SEED, hours: HOURS, jobs: jobs.length, report, ok: !failed }, null, 2));
} else {
  console.log(`seed=${SEED} hours=${HOURS} requests=${jobs.length} (one 2x8 gang request arriving at +30 min)`);
  for (const row of report) {
    const gangText = row.gangStartMin === null ? 'never started' : `started at +${row.gangStartMin.toFixed(1)} min (waited ${row.gangWaitMin.toFixed(1)} min, bound +${row.gangBoundMin.toFixed(1)})`;
    console.log(`${row.mode.padEnd(12)} gang ${gangText}; utilization ${(row.utilization * 100).toFixed(1)}%; single-GPU mean wait ${row.smallMeanWaitMin.toFixed(1)} min; invalid plans ${row.invalidPlans}`);
  }
  console.log(failed ? '\nFAIL' : '\nok: reservations bound the gang wait; all plans valid');
}
process.exit(failed ? 1 : 0);
