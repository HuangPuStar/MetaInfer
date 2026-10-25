#!/usr/bin/env node
/**
 * Offline coordinator fleet self-test: multi-machine whole-GPU leases, queueing,
 * hand-over and usage accounting. Uses only Node builtins + the plugin's cluster
 * module; no DSH runtime required.
 *
 *   node scripts/cluster-fleet-selftest.mjs
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createCoordinator, normalizeClusterConfig } from '../host/cluster.js';

const PORT = 8971;
const TOKEN = 'fleet-selftest-token';
const BASE = `http://127.0.0.1:${PORT}`;

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exitCode = 1;
}

async function api(pathname, body, method = 'POST') {
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}

async function main() {
  const config = normalizeClusterConfig({
    enabled: true,
    role: 'coordinator',
    clusterId: 'fleet-selftest',
    listen: { host: '127.0.0.1', port: PORT },
    token: TOKEN,
    devices: [],
    stateFile: path.join(os.tmpdir(), `mirl-fleet-selftest-${process.pid}.json`),
    heartbeatMs: 1000,
    leaseTtlMs: 60_000,
    fleet: {
      enabled: true,
      placementMode: 'fleet',
      machines: [],
    },
  });
  const coordinator = createCoordinator({ config, stateFile: config.stateFile });
  const started = await coordinator.start();
  assert.equal(started.ok, true, started.error);

  try {
    // Register two remote GPU machines (2 whole GPUs each).
    for (const machineId of ['gpu-a', 'gpu-b']) {
      const registered = await api('/v1/register', {
        clusterId: 'fleet-selftest',
        instanceId: `provider-${machineId}`,
        machineId,
        devices: [
          { id: `${machineId}:0`, localId: '0', model: 'Fake', memoryMiB: 1024 },
          { id: `${machineId}:1`, localId: '1', model: 'Fake', memoryMiB: 1024 },
        ],
      });
      assert.equal(registered.status, 200);
    }

    const first = await api('/v1/acquire', {
      clusterId: 'fleet-selftest',
      requestId: 'req-a',
      holderId: 'holder-1',
      userId: 'alice',
      projectId: 'p1',
      nodeId: 'n1',
      amount: 4,
      machines: 2,
      placement: 'fleet',
      ttlMs: 60_000,
    });
    assert.equal(first.payload.data.status, 'granted');
    assert.equal(first.payload.data.lease.machines.length, 2);
    assert.equal(first.payload.data.lease.deviceIds.length, 4);
    const machineIds = first.payload.data.lease.machines.map((group) => group.machineId).sort();
    assert.deepEqual(machineIds, ['gpu-a', 'gpu-b']);
    for (const group of first.payload.data.lease.machines) {
      assert.equal(group.deviceIds.length, 2);
    }
    console.log('PASS  fleet lease amount=4 machines=2 spans both machines');

    const queued = await api('/v1/acquire', {
      clusterId: 'fleet-selftest',
      requestId: 'req-b',
      holderId: 'holder-2',
      userId: 'bob',
      projectId: 'p2',
      nodeId: 'n2',
      amount: 2,
      machines: 2,
      placement: 'fleet',
      ttlMs: 60_000,
    });
    assert.equal(queued.payload.data.status, 'queued');
    assert.equal(queued.payload.data.position, 1);
    console.log('PASS  insufficient capacity queues the whole fleet request');

    const released = await api('/v1/release', {
      clusterId: 'fleet-selftest',
      leaseId: first.payload.data.lease.leaseId,
      holderId: 'holder-1',
    });
    assert.equal(released.payload.data.status, 'released');

    const status = await api('/v1/status', null, 'GET');
    const queuedLease = (status.payload.data.leases ?? []).find((lease) => lease.requestId === 'req-b');
    assert.ok(queuedLease, 'queued request should be granted after release');
    assert.equal(queuedLease.machines.length, 2);
    assert.equal(queuedLease.deviceIds.length, 2);
    console.log('PASS  queue hand-over grants the waiting multi-machine lease');
    assert.ok(
      (status.payload.data.usage ?? []).some((entry) => entry.projectId === 'p1'),
      'usage should record the released fleet lease',
    );
    console.log('PASS  GPU-seconds usage recorded for the released lease');

    const renew = await api('/v1/renew', {
      clusterId: 'fleet-selftest',
      leaseId: queuedLease.leaseId,
      holderId: 'holder-2',
      ttlMs: 120_000,
    });
    assert.equal(renew.payload.data.status, 'renewed');
    console.log('PASS  fleet lease renew works');

    const cleared = await api('/v1/release', {
      clusterId: 'fleet-selftest',
      leaseId: queuedLease.leaseId,
      holderId: 'holder-2',
    });
    assert.equal(cleared.payload.data.status, 'released');
    const pools = (await api('/v1/status', null, 'GET')).payload.data.pools.gpu;
    assert.equal(pools.free, 4);
    console.log('PASS  all fleet devices are free after release');
  } finally {
    coordinator.close();
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
