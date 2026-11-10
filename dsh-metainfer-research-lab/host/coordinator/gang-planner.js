/**
 * Gang planner: time-aware placement for the GPU coordinator (WP P3.5).
 *
 * The coordinator today (`cluster.js` dispatchQueue) grants every queued entry
 * that fits the GPUs free *now*, in priority order. A request that spans
 * several machines and needs all of them free at once can then starve forever:
 * every freed GPU is taken by a smaller request behind it.
 *
 * This module plans on a resource x time timeline instead:
 *   - every running lease occupies its devices until its hard end (`hardEndAt`);
 *   - a request that fits now on devices that stay free for its whole walltime
 *     is granted;
 *   - the first `reserveDepth` requests that cannot start now get a
 *     reservation at their earliest feasible start; reserved devices are
 *     blocked from that start on;
 *   - later requests are backfilled only if they finish before every
 *     reservation they would overlap (requires a finite walltime).
 * `reserveDepth = 1` is EASY backfilling, `Infinity` is conservative
 * backfilling, `mode: 'greedy'` reproduces today's behaviour for comparison.
 *
 * Nothing here holds GPUs idle on purpose except reservations, and nothing is
 * ever partially granted, so there is no hold-and-wait deadlock.
 *
 * Pure function: no I/O, no clock, no randomness. The caller (coordinator)
 * owns state, issuing, persistence and notifications.
 */

const MODES = new Set(['greedy', 'easy', 'conservative']);

/**
 * Normalize a request's acceptable shapes into lists of per-machine GPU counts.
 * Accepted forms:
 *   shapes: [{ machines: 2, gpusPerMachine: 4 }, { sizes: [5, 3] }]
 *   legacy: { amount: 6, machines: 2 } -> balanced split like planFleetAllocation
 * @returns {number[][]} each entry is a list of sizes, largest first
 */
export function requestShapes(request) {
  const shapes = [];
  if (Array.isArray(request.shapes) && request.shapes.length > 0) {
    for (const shape of request.shapes) {
      if (Array.isArray(shape.sizes) && shape.sizes.length > 0) {
        shapes.push(shape.sizes.map((n) => Math.max(1, Math.floor(n))));
      } else if (Number.isFinite(shape.machines) && Number.isFinite(shape.gpusPerMachine)) {
        shapes.push(Array(Math.max(1, Math.floor(shape.machines))).fill(Math.max(1, Math.floor(shape.gpusPerMachine))));
      }
    }
  } else {
    const total = Math.max(1, Math.floor(request.amount ?? 1));
    const count = Math.max(1, Math.floor(request.machines ?? 1));
    if (count <= total) {
      const base = Math.floor(total / count);
      const rem = total % count;
      shapes.push([...Array(rem).fill(base + 1), ...Array(count - rem).fill(base)]);
    }
  }
  return shapes.map((sizes) => [...sizes].sort((a, b) => b - a));
}

function totalGpus(sizes) {
  return sizes.reduce((sum, n) => sum + n, 0);
}

function deviceKey(machineId, deviceId) {
  return `${machineId}\u0000${deviceId}`;
}

function labelsMatch(labels, required) {
  if (!required) return true;
  return Object.entries(required).every(([key, values]) => {
    const list = (Array.isArray(values) ? values : [values]).map((v) => String(v).toLowerCase());
    return list.includes(String(labels?.[key] ?? '').toLowerCase());
  });
}

function machineAllowed(machine, constraints) {
  if (!constraints) return true;
  if (Array.isArray(constraints.machineIds) && constraints.machineIds.length > 0
    && !constraints.machineIds.includes(machine.machineId)) return false;
  if (Array.isArray(constraints.excludeMachineIds) && constraints.excludeMachineIds.includes(machine.machineId)) return false;
  if (!labelsMatch(machine.labels, constraints.machineLabels)) return false;
  return true;
}

function deviceAllowed(device, constraints) {
  const models = constraints?.gpuModels;
  if (!Array.isArray(models) || models.length === 0) return true;
  const model = String(device.model ?? '').toLowerCase();
  return models.some((pattern) => model.includes(String(pattern).toLowerCase()));
}

/**
 * Timeline of device occupancy: deviceKey -> list of [start, end) intervals.
 */
function createTimeline() {
  const busy = new Map();
  return {
    add(machineId, deviceId, start, end, owner) {
      const key = deviceKey(machineId, deviceId);
      if (!busy.has(key)) busy.set(key, []);
      busy.get(key).push({ start, end, owner });
    },
    isFree(machineId, deviceId, start, end) {
      const intervals = busy.get(deviceKey(machineId, deviceId));
      if (!intervals) return true;
      return intervals.every((interval) => !(interval.start < end && start < interval.end));
    },
    /** Every finite interval end after `after`, ascending: candidate start times. */
    boundaries(after) {
      const out = new Set();
      for (const intervals of busy.values()) {
        for (const interval of intervals) if (Number.isFinite(interval.end) && interval.end > after) out.add(interval.end);
      }
      return [...out].sort((a, b) => a - b);
    },
  };
}

/**
 * Try to place one shape at time `start` for `walltime` ms.
 * Best fit: each part goes to the allowed machine with the fewest free devices
 * that still fit it, which keeps whole machines free for later gang requests.
 */
function placeShape(sizes, machines, timeline, start, walltime, constraints) {
  const end = start + walltime;
  const free = [];
  for (const machine of machines) {
    if (!machineAllowed(machine, constraints)) continue;
    const devices = (machine.devices ?? [])
      .filter((device) => deviceAllowed(device, constraints))
      .filter((device) => timeline.isFree(machine.machineId, device.id, start, end))
      .map((device) => device.id)
      .sort();
    if (devices.length > 0) free.push({ machine, devices });
  }
  const groups = [];
  if (constraints?.colocate) {
    const byValue = new Map();
    for (const entry of free) {
      const value = entry.machine.labels?.[constraints.colocate];
      if (value === undefined || value === null || value === '') continue;
      const key = String(value).toLowerCase();
      if (!byValue.has(key)) byValue.set(key, []);
      byValue.get(key).push(entry);
    }
    for (const key of [...byValue.keys()].sort()) groups.push(byValue.get(key));
  } else {
    groups.push(free);
  }
  for (const group of groups) {
    const used = new Set();
    const allocation = [];
    let ok = true;
    for (const size of sizes) {
      let best = null;
      for (const entry of group) {
        if (used.has(entry.machine.machineId) || entry.devices.length < size) continue;
        if (!best || entry.devices.length < best.devices.length
          || (entry.devices.length === best.devices.length && entry.machine.machineId < best.machine.machineId)) {
          best = entry;
        }
      }
      if (!best) { ok = false; break; }
      used.add(best.machine.machineId);
      allocation.push({ machineId: best.machine.machineId, deviceIds: best.devices.slice(0, size) });
    }
    if (ok) return allocation.sort((a, b) => a.machineId.localeCompare(b.machineId));
  }
  return null;
}

function placeAny(shapes, machines, timeline, start, walltime, constraints) {
  for (let index = 0; index < shapes.length; index += 1) {
    const allocation = placeShape(shapes[index], machines, timeline, start, walltime, constraints);
    if (allocation) return { shapeIndex: index, allocation };
  }
  return null;
}

function occupy(timeline, allocation, start, end, owner) {
  for (const group of allocation) {
    for (const deviceId of group.deviceIds) timeline.add(group.machineId, deviceId, start, end, owner);
  }
}

/** Default queue order: priority desc, then enqueue time, then request id. */
export function defaultQueueOrder(a, b) {
  return (b.priority ?? 0) - (a.priority ?? 0)
    || (a.enqueuedAt ?? 0) - (b.enqueuedAt ?? 0)
    || String(a.requestId).localeCompare(String(b.requestId));
}

/**
 * Plan one scheduling pass.
 *
 * @param {object} input
 * @param {number} input.now
 * @param {Array<{machineId: string, online?: boolean, labels?: object, devices: Array<{id: string, model?: string}>}>} input.machines
 * @param {Array<{leaseId: string, hardEndAt?: number, machines?: Array<{machineId: string, deviceIds: string[]}>, machineId?: string, deviceIds?: string[]}>} input.leases
 * @param {Array<object>} input.queue requests: { requestId, priority?, enqueuedAt?, shapes? | amount+machines, walltimeMs?, constraints? }
 * @param {object} [input.policy]
 * @param {'greedy'|'easy'|'conservative'} [input.policy.mode] default 'easy'
 * @param {number} [input.policy.reserveDepth] reservations per pass (easy: 1)
 * @param {boolean} [input.policy.preordered] keep the queue order as given (e.g. after a contest round)
 * @returns {{
 *   grants: Array<{requestId: string, shapeIndex: number, allocation: object[], startAt: number, hardEndAt: number|null}>,
 *   reservations: Array<{requestId: string, shapeIndex: number, allocation: object[], startAt: number, hardEndAt: number|null}>,
 *   waiting: Array<{requestId: string, reason: string}>
 * }}
 */
export function planSchedule({ now, machines, leases, queue, policy = {} }) {
  const mode = policy.mode ?? 'easy';
  if (!MODES.has(mode)) throw new Error(`gang-planner: unknown mode ${mode}`);
  const reserveDepth = mode === 'greedy' ? 0
    : mode === 'conservative' ? Infinity
      : (Number.isFinite(policy.reserveDepth) ? Math.max(0, policy.reserveDepth) : 1);
  const online = machines.filter((machine) => machine.online !== false);
  const timeline = createTimeline();
  for (const lease of leases) {
    const groups = Array.isArray(lease.machines) && lease.machines.length > 0
      ? lease.machines
      : [{ machineId: lease.machineId, deviceIds: lease.deviceIds ?? [] }];
    // A lease without a hard end blocks its devices indefinitely: renewals can
    // extend it, so the planner must not count on it ending.
    const end = Number.isFinite(lease.hardEndAt) ? Math.max(lease.hardEndAt, now) : Infinity;
    for (const group of groups) {
      for (const deviceId of group.deviceIds ?? []) timeline.add(group.machineId, deviceId, now, end, lease.leaseId);
    }
  }

  const ordered = policy.preordered ? [...queue] : [...queue].sort(defaultQueueOrder);
  const grants = [];
  const reservations = [];
  const waiting = [];
  const capacity = new Map(online.map((machine) => [machine.machineId, (machine.devices ?? []).length]));

  for (const request of ordered) {
    const shapes = requestShapes(request);
    const walltime = Number.isFinite(request.walltimeMs) && request.walltimeMs > 0 ? request.walltimeMs : Infinity;
    const hardEnd = (start) => (Number.isFinite(walltime) ? start + walltime : null);
    if (shapes.length === 0) { waiting.push({ requestId: request.requestId, reason: 'invalid-shape' }); continue; }
    const fitsEver = shapes.some((sizes) => sizes.length <= capacity.size
      && sizes.every((size) => [...capacity.values()].some((n) => n >= size))
      && totalGpus(sizes) <= [...capacity.values()].reduce((sum, n) => sum + n, 0));
    if (!fitsEver) { waiting.push({ requestId: request.requestId, reason: 'exceeds-cluster-capacity' }); continue; }

    const nowPlacement = placeAny(shapes, online, timeline, now, walltime, request.constraints);
    if (nowPlacement) {
      occupy(timeline, nowPlacement.allocation, now, now + walltime, request.requestId);
      grants.push({ requestId: request.requestId, ...nowPlacement, startAt: now, hardEndAt: hardEnd(now) });
      continue;
    }
    if (reservations.length >= reserveDepth) {
      waiting.push({ requestId: request.requestId, reason: mode === 'greedy' ? 'waiting-for-capacity' : 'behind-reservation' });
      continue;
    }
    let reserved = null;
    for (const start of timeline.boundaries(now)) {
      const placement = placeAny(shapes, online, timeline, start, walltime, request.constraints);
      if (placement) { reserved = { start, placement }; break; }
    }
    if (!reserved) {
      waiting.push({ requestId: request.requestId, reason: 'no-known-start (running leases have no hard end)' });
      continue;
    }
    occupy(timeline, reserved.placement.allocation, reserved.start, reserved.start + walltime, request.requestId);
    reservations.push({ requestId: request.requestId, ...reserved.placement, startAt: reserved.start, hardEndAt: hardEnd(reserved.start) });
  }
  return { grants, reservations, waiting };
}

/**
 * Check a plan against the inputs: no device double-booked at any instant, no
 * offline machine used, no partial grant. Used by tests and by the coordinator
 * in debug mode before issuing.
 * @returns {string[]} violations (empty when valid)
 */
export function validatePlan({ now, machines, leases, queue }, plan) {
  const violations = [];
  const online = new Map(machines.filter((m) => m.online !== false).map((m) => [m.machineId, m]));
  const intervals = new Map();
  const add = (machineId, deviceId, start, end, owner) => {
    const key = deviceKey(machineId, deviceId);
    for (const other of intervals.get(key) ?? []) {
      if (other.start < end && start < other.end) violations.push(`device ${machineId}/${deviceId}: ${owner} overlaps ${other.owner}`);
    }
    if (!intervals.has(key)) intervals.set(key, []);
    intervals.get(key).push({ start, end, owner });
  };
  for (const lease of leases) {
    const groups = lease.machines?.length ? lease.machines : [{ machineId: lease.machineId, deviceIds: lease.deviceIds ?? [] }];
    for (const group of groups) for (const deviceId of group.deviceIds ?? []) add(group.machineId, deviceId, now, Number.isFinite(lease.hardEndAt) ? lease.hardEndAt : Infinity, lease.leaseId);
  }
  const requests = new Map(queue.map((request) => [request.requestId, request]));
  for (const item of [...plan.grants, ...plan.reservations]) {
    const request = requests.get(item.requestId);
    if (!request) { violations.push(`unknown request ${item.requestId}`); continue; }
    const sizes = requestShapes(request)[item.shapeIndex];
    const got = item.allocation.map((group) => group.deviceIds.length).sort((a, b) => b - a);
    if (!sizes || JSON.stringify(sizes) !== JSON.stringify(got)) violations.push(`${item.requestId}: allocation does not match shape`);
    const end = Number.isFinite(item.hardEndAt) ? item.hardEndAt : Infinity;
    for (const group of item.allocation) {
      const machine = online.get(group.machineId);
      if (!machine) { violations.push(`${item.requestId}: machine ${group.machineId} offline or unknown`); continue; }
      const known = new Set((machine.devices ?? []).map((d) => d.id));
      for (const deviceId of group.deviceIds) {
        if (!known.has(deviceId)) violations.push(`${item.requestId}: unknown device ${group.machineId}/${deviceId}`);
        add(group.machineId, deviceId, item.startAt, end, item.requestId);
      }
    }
  }
  return violations;
}
