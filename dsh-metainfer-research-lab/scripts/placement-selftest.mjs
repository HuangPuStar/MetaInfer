#!/usr/bin/env node
/**
 * Placement-policy self-test (V7):
 *   - natural-language compiler against a labeled fleet catalog
 *   - coordinator multi-machine allocation honoring require/prefer/exclude/soft-colocate
 *
 *   node scripts/placement-selftest.mjs
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createCoordinator, normalizeClusterConfig } from '../host/cluster.js';
import { compilePlacementPolicy, describePlacementSpec } from '../host/placement.js';

const PORT = 8972;
const TOKEN = 'placement-selftest-token';
const BASE = `http://127.0.0.1:${PORT}`;

const catalog = {
  machines: [
    { machineId: 'a1', labels: { gpu: 'a100', rack: 'rack-a', interconnect: 'nvlink' }, devices: [{ model: 'NVIDIA A100 80G' }, { model: 'NVIDIA A100 80G' }] },
    { machineId: 'a2', labels: { gpu: 'a100', rack: 'rack-a', interconnect: 'nvlink' }, devices: [{ model: 'NVIDIA A100 80G' }, { model: 'NVIDIA A100 80G' }] },
    { machineId: 'h1', labels: { gpu: 'h100', rack: 'rack-b', interconnect: 'nvlink' }, devices: [{ model: 'NVIDIA H100 80G' }, { model: 'NVIDIA H100 80G' }] },
    { machineId: 'h2', labels: { gpu: 'h100', rack: 'rack-b', interconnect: 'nvlink' }, devices: [{ model: 'NVIDIA H100 80G' }, { model: 'NVIDIA H100 80G' }] },
  ],
};

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
  // ---- compiler ----
  const hard = compilePlacementPolicy('必须使用 A100；必须同一机架', catalog);
  assert.ok(hard.spec.require.gpuModels.includes('a100'), 'hard A100 requirement');
  assert.equal(hard.spec.require.colocate, 'rack');
  assert.equal(hard.warnings.length, 0, hard.warnings.join('; '));
  console.log('PASS  compiler: hard GPU model + hard same-rack');

  const soft = compilePlacementPolicy('优先 H100，NVLink 互联，尽量同机架', catalog);
  assert.ok(soft.spec.prefer.some((rule) => rule.gpuModels.includes('h100')), 'soft H100 preference');
  assert.ok(soft.spec.prefer.some((rule) => rule.machineLabels.interconnect?.includes('nvlink')), 'soft NVLink preference');
  assert.equal(soft.spec.preferColocate, 'rack');
  assert.equal(soft.spec.require.gpuModels.length, 0);
  console.log('PASS  compiler: soft preferences + soft same-rack');

  const negative = compilePlacementPolicy('不要 H100', catalog);
  assert.ok(negative.spec.require.excludeGpuModels.includes('h100'));
  console.log('PASS  compiler: negative GPU model exclusion');

  const impossible = compilePlacementPolicy('必须使用 V100', catalog);
  assert.ok(impossible.warnings.length > 0, 'unavailable requirement should warn');
  console.log('PASS  compiler: unavailable hard requirement warned');

  // ---- coordinator constraints ----
  const config = normalizeClusterConfig({
    enabled: true,
    role: 'coordinator',
    clusterId: 'placement-selftest',
    listen: { host: '127.0.0.1', port: PORT },
    token: TOKEN,
    devices: [],
    stateFile: path.join(os.tmpdir(), `mirl-placement-selftest-${process.pid}.json`),
    leaseTtlMs: 60_000,
    fleet: { enabled: true, placementMode: 'fleet', machines: [] },
  });
  const coordinator = createCoordinator({ config, stateFile: config.stateFile });
  const started = await coordinator.start();
  assert.equal(started.ok, true, started.error);
  try {
    for (const machine of catalog.machines) {
      const registered = await api('/v1/register', {
        clusterId: 'placement-selftest',
        instanceId: `provider-${machine.machineId}`,
        machineId: machine.machineId,
        labels: machine.labels,
        devices: machine.devices.map((device, index) => ({
          id: `${machine.machineId}:${index}`,
          localId: String(index),
          model: device.model,
        })),
      });
      assert.equal(registered.status, 200);
    }

    async function acquire(requestId, constraints) {
      const result = await api('/v1/acquire', {
        clusterId: 'placement-selftest',
        requestId,
        holderId: 'holder-1',
        userId: 'alice',
        projectId: 'p1',
        nodeId: requestId,
        amount: 4,
        machines: 2,
        placement: 'fleet',
        constraints,
        ttlMs: 60_000,
      });
      return result.payload.data;
    }
    async function release(lease) {
      await api('/v1/release', { clusterId: 'placement-selftest', leaseId: lease.leaseId, holderId: 'holder-1' });
    }

    const a100 = await acquire('req-a100', {
      require: { gpuModels: ['a100'] },
    });
    assert.equal(a100.status, 'granted');
    assert.deepEqual(a100.lease.machines.map((machine) => machine.machineId).sort(), ['a1', 'a2']);
    console.log('PASS  coordinator: hard GPU-model constraint selects only A100 machines');
    await release(a100.lease);

    const preferred = await acquire('req-h100', {
      prefer: [{ gpuModels: ['h100'] }],
    });
    assert.equal(preferred.status, 'granted');
    assert.deepEqual(preferred.lease.machines.map((machine) => machine.machineId).sort(), ['h1', 'h2']);
    console.log('PASS  coordinator: soft preference selects H100 machines first');
    await release(preferred.lease);

    const rack = await acquire('req-rack-a', {
      require: { machineLabels: { rack: ['rack-a'] } },
    });
    assert.equal(rack.status, 'granted');
    assert.deepEqual(rack.lease.machines.map((machine) => machine.machineId).sort(), ['a1', 'a2']);
    console.log('PASS  coordinator: machine-label requirement works');
    await release(rack.lease);

    const impossibleRes = await acquire('req-v100', { require: { gpuModels: ['v100'] } });
    assert.equal(impossibleRes.status, 'queued');
    assert.equal(impossibleRes.reason, 'no-matching-machines');
    console.log('PASS  coordinator: unsatisfiable constraint queues with no-matching-machines');

    const status = await api('/v1/status', null, 'GET');
    assert.equal(status.payload.data.pools.gpu.free, 8);
    assert.equal(typeof describePlacementSpec(hard.spec), 'string');
    console.log('PASS  placement spec summary + all devices free');
  } finally {
    coordinator.close();
  }
}

main().catch((error) => {
  console.error(`FAIL  ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
