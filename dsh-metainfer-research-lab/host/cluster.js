/**
 * Lightweight multi-instance GPU cluster coordinator (V3).
 *
 * One DSH instance can act as the coordinator (`role:'coordinator'` or `'both'`)
 * and owns the authoritative whole-GPU lease ledger. Every other instance
 * (`role:'client'`) registers its machine inventory and asks the coordinator for
 * whole-GPU leases before starting a GPU-needing node. No k8s/slurm: plain HTTP +
 * JSON state. GPUs are machine-affine (a lease is granted from the requesting
 * instance's machine), which keeps execution local and the design lightweight.
 */
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LabError } from './git-engine.js';

const ONLINE_MS = 30_000;
const MAX_BODY = 1_000_000;

const FLEET_DEFAULTS = {
  enabled: false,
  placementMode: 'local',
  masterPort: 29500,
  pathMap: [],
  machines: [],
};

function cleanText(value, max = 400) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function cleanPairs(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 32)
    .map((pair) => ({ from: cleanText(pair?.from, 1024), to: cleanText(pair?.to, 1024) }))
    .filter((pair) => pair.from && pair.to);
}

/** Remote GPU fleet (NFS + SSH + containers). */
export function normalizeFleetConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...FLEET_DEFAULTS };
  const machines = Array.isArray(raw.machines)
    ? raw.machines.slice(0, 64).map((machine, index) => {
        const ssh = machine?.ssh && typeof machine.ssh === 'object' ? machine.ssh : {};
        const container = machine?.container && typeof machine.container === 'object' ? machine.container : {};
        const devices = Array.isArray(machine?.devices)
          ? machine.devices.slice(0, 64).map((device, deviceIndex) => ({
              id: cleanText(device?.id, 120) || String(deviceIndex),
              model: cleanText(device?.model, 160) || 'GPU',
              memoryMiB: Number.isFinite(Number(device?.memoryMiB)) ? Number(device.memoryMiB) : 0,
              localId: cleanText(device?.localId, 120) || cleanText(device?.id, 120) || String(deviceIndex),
            }))
          : null;
        return {
          machineId: cleanText(machine?.machineId, 120) || `gpu-node-${index + 1}`,
          masterAddr: cleanText(machine?.masterAddr, 255) || null,
          ssh: {
            host: cleanText(ssh.host, 255),
            user: cleanText(ssh.user, 120) || 'root',
            port: Number.isInteger(Number(ssh.port)) ? Math.max(1, Math.min(65535, Number(ssh.port))) : 22,
            keyPath: cleanText(ssh.keyPath, 1024),
            options: Array.isArray(ssh.options)
              ? ssh.options.filter((item) => typeof item === 'string').slice(0, 20)
              : [],
            command: cleanText(ssh.command, 255) || 'ssh',
          },
          container: {
            runtime: ['docker', 'podman', 'apptainer', 'none'].includes(container.runtime)
              ? container.runtime
              : 'docker',
            name: cleanText(container.name, 255),
            workdir: cleanText(container.workdir, 1024),
            user: cleanText(container.user, 120),
            env: container.env && typeof container.env === 'object' && !Array.isArray(container.env)
              ? Object.fromEntries(Object.entries(container.env).slice(0, 32).map(([key, value]) => [cleanText(key, 120), String(value).slice(0, 500)]))
              : {},
          },
          devices,
          labels: machine?.labels && typeof machine.labels === 'object' && !Array.isArray(machine.labels)
            ? Object.fromEntries(
                Object.entries(machine.labels)
                  .slice(0, 32)
                  .map(([key, value]) => [cleanText(key, 80).toLowerCase(), cleanText(value, 160).toLowerCase()])
                  .filter(([key, value]) => key && value),
              )
            : {},
          pathMap: cleanPairs(machine?.pathMap),
        };
      })
    : [];
  return {
    enabled: raw.enabled === true,
    placementMode: ['local', 'fleet', 'auto'].includes(raw.placementMode) ? raw.placementMode : 'local',
    masterPort: Number.isInteger(Number(raw.masterPort))
      ? Math.max(1024, Math.min(65535, Number(raw.masterPort)))
      : 29500,
    pathMap: cleanPairs(raw.pathMap),
    machines,
  };
}

export function fleetWarnings(raw) {
  const fleet = normalizeFleetConfig(raw);
  const warnings = [];
  if (fleet.enabled && fleet.machines.length === 0) warnings.push('fleet.enabled is true but fleet.machines is empty');
  const seen = new Set();
  for (const machine of fleet.machines) {
    if (seen.has(machine.machineId)) warnings.push(`duplicate fleet machineId: ${machine.machineId}`);
    seen.add(machine.machineId);
    if (!machine.ssh.host) warnings.push(`fleet machine ${machine.machineId}: ssh.host is required`);
    if (!machine.container.workdir) warnings.push(`fleet machine ${machine.machineId}: container.workdir is required`);
    if (Object.keys(machine.labels ?? {}).length === 0) {
      warnings.push(`fleet machine ${machine.machineId}: no labels (e.g. gpuModel/rack/interconnect) — natural-language placement preferences cannot target it`);
    }
    if (machine.container.runtime !== 'none' && !machine.container.name) {
      warnings.push(`fleet machine ${machine.machineId}: container.name is required for ${machine.container.runtime}`);
    }
  }
  return warnings;
}

const DEFAULTS = {
  enabled: false,
  role: 'both',
  instanceId: null,
  machineId: null,
  userId: 'default',
  url: null,
  listen: { host: '127.0.0.1', port: 8791 },
  token: '',
  heartbeatMs: 10_000,
  leaseTtlMs: 15 * 60 * 1000,
  requestTimeoutMs: 5_000,
  devices: null,
  priority: 0,
  allowAnyMachine: false,
  stateFile: null,
  clusterId: 'default',
  coordinatorId: null,
  dashboard: true,
  claimDir: null,
  allowMultipleCoordinators: false,
  fleet: { ...FLEET_DEFAULTS },
};

function asInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

export function normalizeClusterConfig(raw, { stateFile } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULTS, enabled: false };
  }
  const listen = raw.listen && typeof raw.listen === 'object' ? raw.listen : {};
  const devices = Array.isArray(raw.devices)
    ? raw.devices.slice(0, 64).map((device, index) => ({
        id: typeof device?.id === 'string' && device.id.trim() ? device.id.trim() : `gpu${index}`,
        model: typeof device?.model === 'string' ? device.model : 'GPU',
        memoryMiB: Number.isFinite(Number(device?.memoryMiB)) ? Number(device.memoryMiB) : 0,
      }))
    : null;
  return {
    ...DEFAULTS,
    ...raw,
    enabled: raw.enabled === true,
    role: ['coordinator', 'client', 'both'].includes(raw.role) ? raw.role : 'both',
    instanceId: typeof raw.instanceId === 'string' && raw.instanceId.trim() ? raw.instanceId.trim() : null,
    machineId: typeof raw.machineId === 'string' && raw.machineId.trim() ? raw.machineId.trim() : null,
    userId: typeof raw.userId === 'string' && raw.userId.trim() ? raw.userId.trim() : 'default',
    url: typeof raw.url === 'string' && raw.url.trim() ? raw.url.trim().replace(/\/$/, '') : null,
    listen: {
      host: typeof listen.host === 'string' ? listen.host : '127.0.0.1',
      port: asInt(listen.port, 8791, 1, 65535),
    },
    token: typeof raw.token === 'string' ? raw.token : '',
    heartbeatMs: asInt(raw.heartbeatMs, 10_000, 1_000, 120_000),
    leaseTtlMs: asInt(raw.leaseTtlMs, 900_000, 10_000, 24 * 60 * 60 * 1000),
    requestTimeoutMs: asInt(raw.requestTimeoutMs, 5_000, 500, 30_000),
    devices,
    priority: asInt(raw.priority, 0, 0, 100),
    allowAnyMachine: raw.allowAnyMachine === true,
    stateFile: stateFile ?? raw.stateFile ?? null,
    clusterId: typeof raw.clusterId === 'string' && raw.clusterId.trim() ? raw.clusterId.trim() : 'default',
    coordinatorId: typeof raw.coordinatorId === 'string' && raw.coordinatorId.trim() ? raw.coordinatorId.trim() : null,
    dashboard: raw.dashboard !== false,
    claimDir: typeof raw.claimDir === 'string' && raw.claimDir.trim() ? raw.claimDir.trim() : null,
    allowMultipleCoordinators: raw.allowMultipleCoordinators === true,
    fleet: normalizeFleetConfig(raw.fleet),
  };
}

export async function loadClusterConfig(filePath) {
  try {
    const textValue = await readFile(filePath, 'utf8');
    const raw = JSON.parse(textValue);
    return normalizeClusterConfig(raw, {
      stateFile: path.join(path.dirname(filePath), 'cluster-state.json'),
    });
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.name === 'SyntaxError')) {
      return { ...DEFAULTS, enabled: false, configError: error.code === 'ENOENT' ? null : 'invalid-json' };
    }
    return { ...DEFAULTS, enabled: false, configError: error instanceof Error ? error.message : String(error) };
  }
}

/** Discover GPUs: explicit config devices first, otherwise best-effort nvidia-smi. */
export async function detectDevices(config, machineId) {
  if (Array.isArray(config.devices) && config.devices.length > 0) {
    return config.devices.map((device) => ({ ...device, id: `${machineId}:${device.id}` }));
  }
  return new Promise((resolve) => {
    execFile(
      process.platform === 'win32' ? 'nvidia-smi.exe' : 'nvidia-smi',
      ['--query-gpu=index,uuid,name,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 5000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) return resolve([]);
        const devices = String(stdout)
          .split('\n')
          .map((line) => line.split(',').map((part) => part.trim()))
          .filter((parts) => parts.length >= 4)
          .map(([index, uuid, name, memory]) => ({
            id: `${machineId}:${uuid || `gpu${index}`}`,
            model: name || 'GPU',
            memoryMiB: Number(memory) || 0,
          }));
        resolve(devices);
      },
    );
  });
}

function nextFreeDevices(state, machineId, amount) {
  const leased = new Set();
  for (const lease of Object.values(state.leases)) {
    for (const deviceId of lease.deviceIds ?? []) leased.add(deviceId);
  }
  const machine = state.machines[machineId];
  if (!machine) return null;
  const free = machine.devices.filter((device) => !leased.has(device.id));
  if (free.length < amount) return null;
  return free.slice(0, amount).map((device) => device.id);
}

function renderDashboardHtml({ clusterId, coordinatorId, url }) {
  const injected = JSON.stringify({ clusterId, coordinatorId, url });
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>MetaInfer GPU Cluster · ${clusterId}</title>
<style>
  :root { color-scheme: dark; --bg:#0f1115; --panel:#171a21; --line:#2a2f3a; --text:#e6e8ee; --muted:#98a0ad; --accent:#7aa2f7; --ok:#7bd88f; --warn:#f6c177; --bad:#f07178; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  header { padding:18px 24px; border-bottom:1px solid var(--line); display:flex; gap:16px; align-items:baseline; flex-wrap:wrap; }
  h1 { font-size:18px; margin:0; }
  .muted { color:var(--muted); font-size:12px; }
  main { padding:20px 24px; display:grid; gap:18px; }
  section { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  h2 { font-size:14px; margin:0 0 10px; color:var(--accent); font-weight:600; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); white-space:nowrap; }
  th { color:var(--muted); font-weight:500; }
  .chips { display:flex; gap:10px; flex-wrap:wrap; }
  .chip { border:1px solid var(--line); border-radius:999px; padding:4px 10px; font-size:12px; color:var(--muted); }
  .chip b { color:var(--text); font-weight:600; }
  .ok { color:var(--ok); } .warn { color:var(--warn); } .bad { color:var(--bad); }
  #err { display:none; margin:0 24px; padding:10px 14px; border:1px solid var(--bad); border-radius:8px; color:var(--bad); }
  form { display:flex; gap:8px; padding:0 24px 12px; }
  input { flex:1; max-width:520px; background:#0c0e13; color:var(--text); border:1px solid var(--line); border-radius:6px; padding:8px 10px; }
  button { background:var(--accent); color:#0b1020; border:0; border-radius:6px; padding:8px 14px; font-weight:600; cursor:pointer; }
</style>
</head>
<body>
<header>
  <h1>MetaInfer GPU Cluster</h1>
  <span class="muted" id="meta"></span>
  <span class="muted" id="stamp"></span>
</header>
<div id="err"></div>
<form id="token-form"><input id="token" placeholder="cluster token" autocomplete="off" /><button type="submit">连接</button></form>
<main>
  <section><h2>总览</h2><div class="chips" id="pools"><span class="muted">等待数据…</span></div></section>
  <section><h2>机器 / GPU</h2><table><thead><tr><th>机器</th><th>在线</th><th>实例</th><th>设备</th></tr></thead><tbody id="machines"></tbody></table></section>
  <section><h2>租约（Leases）</h2><table><thead><tr><th>Lease</th><th>项目 / 节点</th><th>用户</th><th>机器</th><th>设备</th><th>到期</th></tr></thead><tbody id="leases"></tbody></table></section>
  <section><h2>排队（Queue）</h2><table><thead><tr><th>#</th><th>项目 / 节点</th><th>用户</th><th>机器</th><th>卡数</th><th>已等待</th></tr></thead><tbody id="queue"></tbody></table></section>
  <section><h2>用量（GPU-秒）</h2><table><thead><tr><th>用户</th><th>项目</th><th>GPU-秒</th><th>租约次数</th></tr></thead><tbody id="usage"></tbody></table></section>
</main>
<script>
  const FIXED = ${injected};
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  function token() {
    const fromUrl = new URLSearchParams(location.search).get('token');
    if (fromUrl) { localStorage.setItem('dsh-cluster-token', fromUrl); return fromUrl; }
    return localStorage.getItem('dsh-cluster-token') ?? '';
  }
  $('token').value = token();
  $('meta').textContent = 'cluster ' + FIXED.clusterId + ' · coordinator ' + FIXED.coordinatorId + ' · ' + FIXED.url;
  $('token-form').addEventListener('submit', (event) => {
    event.preventDefault();
    localStorage.setItem('dsh-cluster-token', $('token').value.trim());
    window.location.search = '?token=' + encodeURIComponent($('token').value.trim());
  });
  function row(cells) { return '<tr>' + cells.map((cell) => '<td>' + esc(cell) + '</td>').join('') + '</tr>'; }
  async function refresh() {
    const t = token();
    if (!t) { $('err').style.display = 'block'; $('err').textContent = '需要 cluster token：填写后点“连接”。'; return; }
    try {
      const response = await fetch('/v1/status', { headers: { authorization: 'Bearer ' + t } });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.ok) throw new Error(body?.error?.code || ('HTTP ' + response.status));
      const data = body.data;
      $('err').style.display = 'none';
      const gpu = data.pools?.gpu ?? { total: 0, used: 0, free: 0 };
      $('pools').innerHTML =
        '<span class="chip">GPU 总卡 <b>' + gpu.total + '</b></span>' +
        '<span class="chip">已租 <b>' + gpu.used + '</b></span>' +
        '<span class="chip">空闲 <b class="' + (gpu.free > 0 ? 'ok' : 'bad') + '">' + gpu.free + '</b></span>' +
        '<span class="chip">队列 <b>' + (data.queue?.length ?? 0) + '</b></span>' +
        '<span class="chip">机器 <b>' + (data.machines?.length ?? 0) + '</b></span>';
      $('machines').innerHTML = (data.machines ?? []).map((machine) => row([
        machine.machineId,
        machine.online ? 'online' : 'offline',
        (machine.instances ?? []).join(', '),
        (machine.devices ?? []).map((device) => device.id + ' · ' + device.model + (device.memoryMiB ? ' · ' + device.memoryMiB + 'MiB' : '')).join(' | '),
      ])).join('') || '<tr><td colspan="4" class="muted">没有注册机器</td></tr>';
      const now = Date.now();
      $('leases').innerHTML = (data.leases ?? []).map((lease) => row([
        lease.leaseId,
        (lease.projectId ?? '-') + ' / ' + (lease.nodeId ?? '-'),
        lease.userId ?? '-',
        lease.machineId,
        (lease.deviceIds ?? []).join(', '),
        Math.max(0, Math.round(((lease.expiresAt ?? now) - now) / 1000)) + 's',
      ])).join('') || '<tr><td colspan="6" class="muted">没有活跃租约</td></tr>';
      $('queue').innerHTML = (data.queue ?? []).map((item) => row([
        item.position,
        (item.projectId ?? '-') + ' / ' + (item.nodeId ?? '-'),
        item.userId ?? '-',
        item.machineId,
        item.amount,
        Math.round((item.waitedMs ?? 0) / 1000) + 's',
      ])).join('') || '<tr><td colspan="6" class="muted">队列为空</td></tr>';
      $('usage').innerHTML = (data.usage ?? []).map((item) => row([
        item.userId ?? '-', item.projectId ?? '-', Math.round(item.gpuSeconds ?? 0), item.leases ?? 0,
      ])).join('') || '<tr><td colspan="4" class="muted">暂无用量</td></tr>';
      $('stamp').textContent = '更新于 ' + new Date().toLocaleTimeString();
    } catch (error) {
      $('err').style.display = 'block';
      $('err').textContent = '连接失败：' + (error?.message || error);
    }
  }
  refresh();
  setInterval(refresh, 3000);
</script>
</body>
</html>`;
}

/** Single-writer coordinator: JSON state + HTTP lease API. */
export function createCoordinator({ config, stateFile }) {
  const coordinatorId = config.coordinatorId ?? `coordinator-${randomUUID().slice(0, 8)}`;
  const state = {
    version: 1,
    clusterId: config.clusterId,
    coordinatorId,
    machines: {},
    leases: {},
    queue: [],
    usage: {},
    updatedAt: Date.now(),
  };
  let ready = false;
  let saveChain = Promise.resolve();
  let lockHeld = false;
  const lockFile = stateFile ? `${stateFile}.lock` : null;

  function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function acquireStateLock(url) {
    if (!lockFile) return { ok: true };
    try {
      const raw = JSON.parse(await readFile(lockFile, 'utf8'));
      if (raw && raw.pid !== process.pid && pidAlive(raw.pid)) {
        return { ok: false, error: `coordinator-already-running (pid ${raw.pid}, url ${raw.url ?? 'unknown'})` };
      }
    } catch {
      // no/invalid lock
    }
    try {
      await mkdir(path.dirname(lockFile), { recursive: true });
      await writeFile(lockFile, JSON.stringify({ pid: process.pid, coordinatorId, url, at: Date.now() }), 'utf8');
      lockHeld = true;
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `state-lock-failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async function releaseStateLock() {
    if (!lockHeld || !lockFile) return;
    lockHeld = false;
    try {
      const raw = JSON.parse(await readFile(lockFile, 'utf8'));
      if (raw?.pid === process.pid) await unlink(lockFile);
    } catch {
      // ignore
    }
  }

  function clusterMismatch(payload) {
    return Boolean(payload?.clusterId && payload.clusterId !== config.clusterId);
  }

  async function load() {
    if (!stateFile) return;
    try {
      const raw = JSON.parse(await readFile(stateFile, 'utf8'));
      if (raw && typeof raw === 'object') {
        state.machines = raw.machines ?? {};
        state.leases = raw.leases ?? {};
        state.queue = Array.isArray(raw.queue) ? raw.queue : [];
        state.usage = raw.usage ?? {};
      }
    } catch {
      // start empty
    }
  }

  function persist() {
    state.updatedAt = Date.now();
    if (!stateFile) return saveChain;
    const payload = JSON.stringify(state, null, 2);
    saveChain = saveChain
      .then(async () => {
        await mkdir(path.dirname(stateFile), { recursive: true });
        const tmp = `${stateFile}.${process.pid}.tmp`;
        await writeFile(tmp, payload, 'utf8');
        await rename(tmp, stateFile);
      })
      .catch(() => {});
    return saveChain;
  }

  function online(machine) {
    return Date.now() - (machine.lastHeartbeatAt ?? 0) <= ONLINE_MS;
  }

  function queueOrder() {
    return [...state.queue].sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || (a.enqueuedAt ?? 0) - (b.enqueuedAt ?? 0),
    );
  }

  function queuePosition(requestId) {
    const ordered = queueOrder();
    const index = ordered.findIndex((entry) => entry.requestId === requestId);
    return index < 0 ? null : index + 1;
  }

  function lowercaseList(raw, max = 16) {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((value) => cleanText(value, 160).toLowerCase())
      .filter(Boolean)
      .slice(0, max);
  }

  function sanitizeLabelMap(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const map = {};
    for (const [key, value] of Object.entries(raw).slice(0, 16)) {
      const name = cleanText(key, 80).toLowerCase();
      const values = lowercaseList(Array.isArray(value) ? value : [value], 8);
      if (name && values.length > 0) map[name] = values;
    }
    return map;
  }

  function sanitizePreferRule(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const machineLabels = sanitizeLabelMap(raw.machineLabels);
    const gpuModels = lowercaseList(raw.gpuModels, 8);
    const machineIds = Array.isArray(raw.machineIds)
      ? raw.machineIds.filter((id) => typeof id === 'string').slice(0, 64)
      : [];
    if (Object.keys(machineLabels).length === 0 && gpuModels.length === 0 && machineIds.length === 0) return null;
    return { machineLabels, gpuModels, machineIds };
  }

  function sanitizeConstraints(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const requireRaw = raw.require && typeof raw.require === 'object' && !Array.isArray(raw.require)
      ? raw.require
      : {};
    const constraints = {
      require: {
        machineLabels: sanitizeLabelMap(requireRaw.machineLabels),
        gpuModels: lowercaseList(requireRaw.gpuModels, 8),
        machineIds: Array.isArray(requireRaw.machineIds)
          ? requireRaw.machineIds.filter((id) => typeof id === 'string').slice(0, 64)
          : [],
        excludeMachineIds: Array.isArray(requireRaw.excludeMachineIds)
          ? requireRaw.excludeMachineIds.filter((id) => typeof id === 'string').slice(0, 64)
          : [],
        excludeMachineLabels: sanitizeLabelMap(requireRaw.excludeMachineLabels),
        excludeGpuModels: lowercaseList(requireRaw.excludeGpuModels, 8),
        colocate: typeof requireRaw.colocate === 'string' && requireRaw.colocate.trim()
          ? requireRaw.colocate.trim().toLowerCase().slice(0, 80)
          : null,
      },
      preferColocate: typeof raw.preferColocate === 'string' && raw.preferColocate.trim()
        ? raw.preferColocate.trim().toLowerCase().slice(0, 80)
        : null,
      prefer: Array.isArray(raw.prefer)
        ? raw.prefer.slice(0, 5).map(sanitizePreferRule).filter(Boolean)
        : [],
    };
    const hasRequire = Object.keys(constraints.require.machineLabels).length > 0
      || constraints.require.gpuModels.length > 0
      || constraints.require.machineIds.length > 0
      || constraints.require.excludeMachineIds.length > 0
      || Object.keys(constraints.require.excludeMachineLabels).length > 0
      || constraints.require.excludeGpuModels.length > 0
      || Boolean(constraints.require.colocate);
    if (!hasRequire && constraints.prefer.length === 0 && !constraints.preferColocate) return null;
    return constraints;
  }

  function freeDevicesFor(machine, stateSnapshot, gpuModels = []) {
    const leased = new Set();
    for (const lease of Object.values(stateSnapshot.leases)) {
      for (const deviceId of lease.deviceIds ?? []) leased.add(deviceId);
    }
    return (machine.devices ?? []).filter((device) => {
      if (leased.has(device.id)) return false;
      if (gpuModels.length === 0) return true;
      const model = String(device.model ?? '').toLowerCase();
      return gpuModels.some((pattern) => model.includes(pattern));
    });
  }

  function labelsMatch(machineLabels, required) {
    if (!required || Object.keys(required).length === 0) return true;
    const labels = machineLabels ?? {};
    return Object.entries(required).every(([key, values]) =>
      values.includes(String(labels[key] ?? '').toLowerCase()),
    );
  }

  function preferenceMatches(machine, rule) {
    if (!labelsMatch(machine.labels, rule.machineLabels)) return false;
    if ((rule.machineIds?.length ?? 0) > 0 && !rule.machineIds.includes(machine.machineId)) return false;
    if (rule.gpuModels.length === 0) return true;
    return (machine.devices ?? []).some((device) =>
      rule.gpuModels.some((pattern) => String(device.model ?? '').toLowerCase().includes(pattern)),
    );
  }

  function machineCandidateList(constraints) {
    const require = constraints?.require;
    const candidates = [];
    for (const machine of Object.values(state.machines)) {
      if (!online(machine)) continue;
      const machineId = machine.machineId;
      if (require?.machineIds?.length > 0 && !require.machineIds.includes(machineId)) continue;
      if (require?.excludeMachineIds?.includes(machineId)) continue;
      if (!labelsMatch(machine.labels, require?.machineLabels)) continue;
      if (Object.keys(require?.excludeMachineLabels ?? {}).length > 0 && labelsMatch(machine.labels, require.excludeMachineLabels)) {
        continue;
      }
      if (require?.excludeGpuModels?.length > 0 && (machine.devices ?? []).some((device) =>
        require.excludeGpuModels.some((pattern) => String(device.model ?? '').toLowerCase().includes(pattern)))) {
        continue;
      }
      const devices = freeDevicesFor(machine, state, require?.gpuModels ?? []);
      if (devices.length === 0) continue;
      let preferScore = constraints?.prefer?.length ?? 0;
      for (let index = 0; index < (constraints?.prefer?.length ?? 0); index += 1) {
        if (preferenceMatches(machine, constraints.prefer[index])) {
          preferScore = index;
          break;
        }
      }
      candidates.push({ machine, devices, preferScore, free: devices.length });
    }
    candidates.sort(
      (a, b) => a.preferScore - b.preferScore
        || b.free - a.free
        || a.machine.machineId.localeCompare(b.machine.machineId),
    );
    return candidates;
  }

  function allocateFromCandidates(candidates, total, count, gpuModels) {
    if (candidates.length < count) return null;
    const base = Math.floor(total / count);
    const rem = total % count;
    if (base < 1) return null;
    const extrasNeeded = rem;
    const normalNeeded = count - rem;
    const extras = [];
    const normals = [];
    for (const candidate of candidates) {
      if (extras.length < extrasNeeded && candidate.free >= base + 1) {
        extras.push({ ...candidate, size: base + 1 });
      } else if (normals.length < normalNeeded && candidate.free >= base) {
        normals.push({ ...candidate, size: base });
      }
      if (extras.length === extrasNeeded && normals.length === normalNeeded) break;
    }
    if (extras.length + normals.length !== count) return null;
    const allocation = [];
    for (const entry of [...extras, ...normals]) {
      const deviceIds = freeDevicesFor(entry.machine, state, gpuModels)
        .slice(0, entry.size)
        .map((device) => device.id);
      if (deviceIds.length < entry.size) return null;
      allocation.push({
        machineId: entry.machine.machineId,
        deviceIds,
        labels: entry.machine.labels ?? {},
      });
    }
    return allocation.sort((a, b) => a.machineId.localeCompare(b.machineId));
  }

  /** Balanced whole-GPU allocation across `machines` distinct online machines. */
  function planFleetAllocation(amount, machines, constraints = null) {
    const total = Math.max(1, Math.floor(amount));
    const count = Math.max(1, Math.floor(machines));
    if (count > total) return { allocation: null, reason: 'machines-exceed-gpus' };
    const candidates = machineCandidateList(constraints);
    if (candidates.length === 0) return { allocation: null, reason: 'no-matching-machines' };
    const gpuModels = constraints?.require?.gpuModels ?? [];
    if (constraints?.require?.colocate) {
      const groups = new Map();
      for (const candidate of candidates) {
        const value = candidate.machine.labels?.[constraints.require.colocate];
        if (!value) continue;
        const key = String(value).toLowerCase();
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(candidate);
      }
      const orderedGroups = [...groups.values()].sort(
        (a, b) => (a[0]?.preferScore ?? 99) - (b[0]?.preferScore ?? 99)
          || b.reduce((sum, item) => sum + item.free, 0) - a.reduce((sum, item) => sum + item.free, 0),
      );
      for (const group of orderedGroups) {
        const allocation = allocateFromCandidates(group, total, count, gpuModels);
        if (allocation) return { allocation, reason: null };
      }
      return { allocation: null, reason: 'colocate-constraint-unsatisfiable' };
    }
    if (constraints?.preferColocate) {
      const groups = new Map();
      for (const candidate of candidates) {
        const value = candidate.machine.labels?.[constraints.preferColocate];
        if (!value) continue;
        const key = String(value).toLowerCase();
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(candidate);
      }
      const orderedGroups = [...groups.values()].sort(
        (a, b) => (a[0]?.preferScore ?? 99) - (b[0]?.preferScore ?? 99)
          || b.reduce((sum, item) => sum + item.free, 0) - a.reduce((sum, item) => sum + item.free, 0),
      );
      for (const group of orderedGroups) {
        const grouped = allocateFromCandidates(group, total, count, gpuModels);
        if (grouped) return { allocation: grouped, reason: null };
      }
    }
    const allocation = allocateFromCandidates(candidates, total, count, gpuModels);
    return allocation
      ? { allocation, reason: null }
      : { allocation: null, reason: 'insufficient-matching-capacity' };
  }

  function grant(entry, allocation) {
    const groups = allocation.map((group) => ({
      machineId: group.machineId,
      deviceIds: group.deviceIds,
      labels: group.labels ?? {},
    }));
    const deviceIds = groups.flatMap((group) => group.deviceIds);
    const machineId = groups[0]?.machineId ?? entry.machineId;
    const lease = {
      leaseId: `lease-${randomUUID().slice(0, 8)}`,
      requestId: entry.requestId,
      machineId,
      deviceIds,
      machines: groups,
      placement: groups.length > 1 ? 'fleet' : (entry.placement ?? 'local'),
      pool: 'gpu',
      holderId: entry.holderId,
      userId: entry.userId ?? 'default',
      projectId: entry.projectId ?? null,
      nodeId: entry.nodeId ?? null,
      grantedAt: Date.now(),
      renewedAt: Date.now(),
      expiresAt: Date.now() + (entry.ttlMs ?? config.leaseTtlMs),
      priority: entry.priority ?? 0,
    };
    state.leases[lease.leaseId] = lease;
    return lease;
  }

  function dispatchQueue() {
    const ordered = queueOrder();
    const remaining = [];
    const granted = [];
    for (const entry of ordered) {
      if (entry.placement === 'fleet' || (entry.machines ?? 1) > 1) {
        const planned = planFleetAllocation(entry.amount ?? 1, entry.machines ?? 1, entry.constraints ?? null);
        if (!planned.allocation) {
          entry.reason = planned.reason ?? 'waiting-for-fleet-capacity';
          remaining.push(entry);
          continue;
        }
        const lease = grant(entry, planned.allocation);
        granted.push({ entry, lease });
        continue;
      }
      const machine = state.machines[entry.machineId];
      if (!machine || !online(machine)) {
        remaining.push(entry);
        continue;
      }
      const devices = nextFreeDevices(state, entry.machineId, entry.amount ?? 1);
      if (!devices) {
        remaining.push(entry);
        continue;
      }
      const lease = grant(entry, [{ machineId: entry.machineId, deviceIds: devices }]);
      granted.push({ entry, lease });
    }
    state.queue = remaining;
    return granted;
  }

  function register({ instanceId, machineId, userId, devices, labels }) {
    if (!machineId) throw new Error('machineId is required');
    const machine = state.machines[machineId] ?? {
      machineId,
      devices: [],
      instances: [],
      registeredAt: Date.now(),
    };
    if (Array.isArray(devices)) machine.devices = devices;
    const instances = new Set(machine.instances ?? []);
    if (instanceId) instances.add(instanceId);
    machine.instances = [...instances];
    machine.userId = userId ?? machine.userId ?? null;
    if (labels && typeof labels === 'object' && !Array.isArray(labels)) {
      machine.labels = Object.fromEntries(
        Object.entries(labels).slice(0, 32).map(([key, value]) => [cleanText(key, 80).toLowerCase(), cleanText(value, 160).toLowerCase()]),
      );
    } else if (!machine.labels) {
      machine.labels = {};
    }
    machine.lastHeartbeatAt = Date.now();
    state.machines[machineId] = machine;
    const granted = dispatchQueue();
    void persist();
    return { machine, granted };
  }

  function acquire(request) {
    const existing = Object.values(state.leases).find((lease) => lease.requestId === request.requestId);
    if (existing) return { status: 'granted', lease: existing };
    const queued = state.queue.find((entry) => entry.requestId === request.requestId);
    if (queued) {
      const grantedNow = dispatchQueue();
      const hit = grantedNow.find((item) => item.entry.requestId === request.requestId);
      if (hit) {
        void persist();
        return { status: 'granted', lease: hit.lease };
      }
      queued.position = queuePosition(request.requestId);
      void persist();
      return { status: 'queued', position: queued.position, queueDepth: state.queue.length };
    }
    const amount = Math.max(1, Number(request.amount) || 1);
    const machines = Math.max(1, Number(request.machines) || 1);
    const entryBase = {
      requestId: request.requestId,
      holderId: request.holderId,
      userId: request.userId,
      projectId: request.projectId,
      nodeId: request.nodeId,
      amount,
      machines,
      placement: request.placement === 'fleet' || machines > 1 ? 'fleet' : 'local',
      ttlMs: request.ttlMs ?? config.leaseTtlMs,
      priority: request.priority ?? config.priority ?? 0,
    };
    if (entryBase.placement === 'fleet') {
      if (machines > amount) throw new Error('machines cannot exceed amount (whole GPUs)');
      const constraints = sanitizeConstraints(request.constraints);
      if (constraints) entryBase.constraints = constraints;
      const planned = planFleetAllocation(amount, machines, constraints);
      if (planned.allocation) {
        const lease = grant(entryBase, planned.allocation);
        void persist();
        return { status: 'granted', lease };
      }
      state.queue.push({ ...entryBase, enqueuedAt: Date.now(), reason: planned.reason ?? 'waiting-for-fleet-capacity' });
      void persist();
      return {
        status: 'queued',
        position: queuePosition(request.requestId),
        queueDepth: state.queue.length,
        reason: planned.reason ?? 'waiting-for-fleet-capacity',
      };
    }
    const machineId = request.machineId;
    if (!machineId) throw new Error('machineId is required for local placement');
    if (!state.machines[machineId]) {
      return { status: 'queued', position: null, reason: 'machine-not-registered' };
    }
    const devices = nextFreeDevices(state, machineId, amount);
    if (devices) {
      const lease = grant({ ...entryBase, machineId }, [{ machineId, deviceIds: devices }]);
      void persist();
      return { status: 'granted', lease };
    }
    state.queue.push({ ...entryBase, machineId, enqueuedAt: Date.now() });
    void persist();
    return { status: 'queued', position: queuePosition(entry.requestId), queueDepth: state.queue.length };
  }

  function renew(request) {
    const lease = state.leases[request.leaseId];
    if (!lease || lease.holderId !== request.holderId) return { status: 'lost', reason: 'lease-not-found' };
    lease.renewedAt = Date.now();
    lease.expiresAt = Date.now() + (request.ttlMs ?? config.leaseTtlMs);
    void persist();
    return { status: 'renewed', lease };
  }

  function accountUsage(lease) {
    const key = `${lease.userId ?? 'default'}|${lease.projectId ?? 'none'}`;
    const entry = state.usage[key] ?? {
      userId: lease.userId ?? 'default',
      projectId: lease.projectId ?? null,
      gpuSeconds: 0,
      leases: 0,
    };
    entry.gpuSeconds += Math.max(0, (Date.now() - lease.grantedAt) / 1000) * (lease.deviceIds?.length ?? 1);
    entry.leases += 1;
    state.usage[key] = entry;
  }

  function release(request) {
    const lease = state.leases[request.leaseId];
    if (!lease) return { status: 'released', already: true };
    if (request.holderId && lease.holderId !== request.holderId) {
      return { status: 'error', error: 'lease-holder-mismatch' };
    }
    accountUsage(lease);
    delete state.leases[request.leaseId];
    const granted = dispatchQueue();
    void persist();
    return { status: 'released', granted: granted.length };
  }

  function reapExpired() {
    const now = Date.now();
    let changed = false;
    for (const [leaseId, lease] of Object.entries(state.leases)) {
      if (lease.expiresAt > now) continue;
      accountUsage(lease);
      delete state.leases[leaseId];
      changed = true;
    }
    const granted = dispatchQueue();
    if (changed || granted.length > 0) void persist();
    return { expired: changed, granted: granted.length };
  }

  function status() {
    const leasedDevices = new Set();
    for (const lease of Object.values(state.leases)) {
      for (const deviceId of lease.deviceIds ?? []) leasedDevices.add(deviceId);
    }
    const machines = Object.values(state.machines).map((machine) => ({
      machineId: machine.machineId,
      devices: machine.devices,
      labels: machine.labels ?? {},
      instances: machine.instances,
      online: online(machine),
      lastHeartbeatAt: machine.lastHeartbeatAt,
    }));
    const total = machines.reduce((sum, machine) => sum + machine.devices.length, 0);
    const used = leasedDevices.size;
    const byMachine = {};
    for (const machine of machines) {
      const machineUsed = machine.devices.filter((device) => leasedDevices.has(device.id)).length;
      byMachine[machine.machineId] = {
        total: machine.devices.length,
        used: machineUsed,
        free: machine.devices.length - machineUsed,
        online: machine.online,
      };
    }
    const queue = queueOrder().map((entry, index) => ({
      ...entry,
      position: index + 1,
      waitedMs: Date.now() - (entry.enqueuedAt ?? Date.now()),
    }));
    return {
      coordinator: true,
      clusterId: config.clusterId,
      coordinatorId,
      url: `http://${config.listen.host}:${config.listen.port}`,
      machines,
      pools: { gpu: { total, used, free: total - used, byMachine } },
      leases: Object.values(state.leases),
      queue,
      usage: Object.values(state.usage),
      updatedAt: Date.now(),
    };
  }

  function startServer() {
    const server = createServer(async (request, response) => {
      const send = (statusCode, payload) => {
        response.writeHead(statusCode, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      try {
        const url = new URL(request.url ?? '/', 'http://localhost');
        if (url.pathname === '/health') {
          return send(200, {
            ok: true,
            coordinator: true,
            clusterId: config.clusterId,
            coordinatorId,
            url: `http://${config.listen.host}:${config.listen.port}`,
          });
        }
        if (config.dashboard && (url.pathname === '/' || url.pathname === '/dashboard')) {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          response.end(renderDashboardHtml({ clusterId: config.clusterId, coordinatorId, url: `http://${config.listen.host}:${config.listen.port}` }));
          return undefined;
        }
        const auth = request.headers.authorization ?? '';
        if (!config.token || auth !== `Bearer ${config.token}`) {
          return send(401, { ok: false, error: { code: 'unauthorized' } });
        }
        if (request.method === 'GET' && url.pathname === '/v1/status') {
          return send(200, { ok: true, data: status() });
        }
        if (request.method === 'POST') {
          const chunks = [];
          let size = 0;
          for await (const chunk of request) {
            size += chunk.length;
            if (size > MAX_BODY) return send(413, { ok: false, error: { code: 'body-too-large' } });
            chunks.push(chunk);
          }
          let body = {};
          if (chunks.length > 0) {
            try {
              body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              return send(400, { ok: false, error: { code: 'invalid-json' } });
            }
          }
          if (clusterMismatch(body)) {
            return send(409, {
              ok: false,
              error: { code: 'cluster-mismatch', expected: config.clusterId, got: body.clusterId },
            });
          }
          if (url.pathname === '/v1/register') {
            return send(200, {
              ok: true,
              data: { ...register(body), clusterId: config.clusterId, coordinatorId },
            });
          }
          if (url.pathname === '/v1/acquire') {
            return send(200, { ok: true, data: acquire(body) });
          }
          if (url.pathname === '/v1/renew') {
            return send(200, { ok: true, data: renew(body) });
          }
          if (url.pathname === '/v1/release') {
            return send(200, { ok: true, data: release(body) });
          }
        }
        return send(404, { ok: false, error: { code: 'not-found' } });
      } catch (error) {
        return send(500, { ok: false, error: { code: 'coordinator-error', message: error instanceof Error ? error.message : String(error) } });
      }
    });
    return new Promise((resolve) => {
      server.once('error', (error) => resolve({ ok: false, error }));
      server.listen(config.listen.port, config.listen.host, () => resolve({ ok: true, server }));
    });
  }

  let reaperTimer = null;
  let httpServer = null;
  return {
    config,
    async start() {
      const url = `http://${config.listen.host}:${config.listen.port}`;
      const lock = await acquireStateLock(url);
      if (!lock.ok) return { ok: false, error: lock.error };
      if (!ready) {
        await load();
        if (state.clusterId && state.clusterId !== config.clusterId) {
          await releaseStateLock();
          return { ok: false, error: `state-cluster-mismatch (state=${state.clusterId}, config=${config.clusterId})` };
        }
        state.clusterId = config.clusterId;
        state.coordinatorId = coordinatorId;
        ready = true;
      }
      const result = await startServer();
      if (!result.ok) {
        await releaseStateLock();
        return { ok: false, error: result.error?.message ?? 'listen failed' };
      }
      httpServer = result.server;
      reaperTimer = setInterval(() => reapExpired(), 2000);
      reaperTimer.unref?.();
      return { ok: true, url: `http://${config.listen.host}:${config.listen.port}` };
    },
    status,
    persist,
    close() {
      if (reaperTimer) clearInterval(reaperTimer);
      reaperTimer = null;
      if (httpServer) {
        try {
          httpServer.close();
        } catch {
          // already closed
        }
        httpServer = null;
      }
      void releaseStateLock();
    },
  };
}

/** HTTP client + self-inventory manager used by the lab runtime. */
export function createClusterManager({ ctx, config, logger }) {
  const enabled = config.enabled === true;
  const mode = !enabled
    ? 'local'
    : (config.role === 'coordinator' ? 'coordinator' : config.role === 'client' ? 'client' : 'both');
  const machineId = config.machineId ?? `machine-${process.pid}`;
  const instanceId = config.instanceId ?? `dsh-${process.pid}-${randomUUID().slice(0, 6)}`;
  const listenUrl = `http://${config.listen.host}:${config.listen.port}`;
  const coordinatorUrl = config.url ?? listenUrl;
  let coordinator = null;
  let server = null;
  let heartbeatTimer = null;
  let devices = [];
  let heartbeatAt = 0;
  let connected = false;
  let lastError = config.configError ?? null;
  let statusCache = null;
  let blocked = false;
  const fleetConfig = config.fleet ?? normalizeFleetConfig(null);
  const fleetInventory = new Map(); // machineId -> [{id, localId, model, memoryMiB}]
  const fleetErrors = new Map(); // machineId -> string
  let claimConflict = null;
  const claimDir = config.claimDir ?? path.join(
    process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'),
    'metainfer-research-lab',
  );
  const claimFile = path.join(claimDir, `machine-claim-${machineId}.json`);

  function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function readClaim() {
    try {
      return JSON.parse(await readFile(claimFile, 'utf8'));
    } catch {
      return null;
    }
  }

  async function detectClaimConflict() {
    const claim = await readClaim();
    if (!claim) return null;
    if (claim.coordinatorUrl === coordinatorUrl) return null;
    if (claim.pid === process.pid) return null;
    if (Date.now() - (claim.at ?? 0) > 120_000) return null;
    if (!pidAlive(claim.pid)) return null;
    return claim;
  }

  async function writeClaim() {
    try {
      await mkdir(claimDir, { recursive: true });
      await writeFile(
        claimFile,
        JSON.stringify({
          machineId,
          instanceId,
          pid: process.pid,
          coordinatorUrl,
          clusterId: config.clusterId,
          at: Date.now(),
        }),
        'utf8',
      );
    } catch {
      // claim file is advisory; do not block the cluster on it
    }
  }

  async function removeOwnClaim() {
    const claim = await readClaim();
    if (claim?.pid === process.pid && claim?.instanceId === instanceId) {
      try {
        await unlink(claimFile);
      } catch {
        // ignore
      }
    }
  }

  async function http(pathname, payload, { method = 'POST' } = {}) {
    const response = await fetch(`${coordinatorUrl}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json',
      },
      ...(method === 'POST' ? { body: JSON.stringify(payload ?? {}) } : {}),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.ok) {
      const code = body?.error?.code ?? `http-${response.status}`;
      throw new Error(code);
    }
    return body.data;
  }

  function sshArgs(machine, remoteCommand) {
    const args = [];
    const ssh = machine.ssh ?? {};
    if (ssh.port) args.push('-p', String(ssh.port));
    if (ssh.keyPath) args.push('-i', ssh.keyPath);
    for (const option of ssh.options ?? []) args.push(option);
    args.push(`${ssh.user || 'root'}@${ssh.host}`, remoteCommand);
    return args;
  }

  function sshExec(machine, remoteCommand) {
    return new Promise((resolve, reject) => {
      const command = machine.ssh?.command || 'ssh';
      execFile(
        command,
        sshArgs(machine, remoteCommand),
        { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`${machine.machineId}: ${stderr?.trim() || error.message}`));
            return;
          }
          resolve(String(stdout ?? ''));
        },
      );
    });
  }

  async function discoverFleetDevices(machine) {
    if (Array.isArray(machine.devices) && machine.devices.length > 0) {
      return machine.devices.map((device, index) => ({
        id: `${machine.machineId}:${device.id ?? index}`,
        localId: device.localId ?? device.id ?? String(index),
        model: device.model ?? 'GPU',
        memoryMiB: device.memoryMiB ?? 0,
      }));
    }
    const stdout = await sshExec(
      machine,
      'nvidia-smi --query-gpu=index,uuid,name,memory.total --format=csv,noheader,nounits',
    );
    return String(stdout)
      .split('\n')
      .map((line) => line.split(',').map((part) => part.trim()))
      .filter((parts) => parts.length >= 4)
      .map(([index, uuid, name, memory]) => ({
        id: `${machine.machineId}:${uuid || index}`,
        localId: index,
        model: name || 'GPU',
        memoryMiB: Number(memory) || 0,
      }));
  }

  async function registerFleetMachines() {
    if (fleetConfig.enabled !== true || fleetConfig.machines.length === 0) return;
    for (const machine of fleetConfig.machines) {
      try {
        let devices = fleetInventory.get(machine.machineId);
        if (!devices || devices.length === 0) {
          devices = await discoverFleetDevices(machine);
          fleetInventory.set(machine.machineId, devices);
        }
        await http('/v1/register', {
          instanceId: `${instanceId}:fleet`,
          machineId: machine.machineId,
          userId: config.userId,
          clusterId: config.clusterId,
          labels: machine.labels ?? {},
          devices,
        });
        fleetErrors.delete(machine.machineId);
      } catch (error) {
        fleetErrors.set(machine.machineId, error instanceof Error ? error.message : String(error));
        fleetInventory.delete(machine.machineId);
      }
    }
    heartbeatAt = Date.now();
  }

  function fleetSummary() {
    return {
      enabled: fleetConfig.enabled,
      placementMode: fleetConfig.placementMode,
      machines: fleetConfig.machines.map((machine) => ({
        machineId: machine.machineId,
        sshHost: machine.ssh.host,
        sshUser: machine.ssh.user,
        labels: machine.labels ?? {},
        container: machine.container,
        devices: (fleetInventory.get(machine.machineId) ?? []).map((device) => ({
          id: device.id,
          model: device.model,
          localId: device.localId,
        })),
        error: fleetErrors.get(machine.machineId) ?? null,
      })),
    };
  }

  function getFleetMachines() {
    return fleetConfig.machines;
  }

  async function registerSelf() {
    const result = await http('/v1/register', {
      instanceId,
      machineId,
      userId: config.userId,
      clusterId: config.clusterId,
      devices,
    });
    await writeClaim();
    heartbeatAt = Date.now();
    connected = true;
    lastError = null;
    return result;
  }

  async function refreshStatus() {
    statusCache = await http('/v1/status', null, { method: 'GET' });
    heartbeatAt = Date.now();
    connected = true;
    lastError = null;
    return statusCache;
  }

  async function beat() {
    try {
      await registerSelf();
      await registerFleetMachines();
      await refreshStatus();
    } catch (error) {
      connected = false;
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  async function start() {
    if (!enabled) return { enabled: false, mode: 'local' };
    devices = await detectDevices(config, machineId);
    claimConflict = await detectClaimConflict();
    if (claimConflict && config.allowMultipleCoordinators !== true) {
      blocked = true;
      lastError = `machine-claimed-by-other-coordinator (${claimConflict.coordinatorUrl}, pid ${claimConflict.pid})`;
      logger?.warn?.(`metainfer-cluster: ${lastError}`);
      return { enabled: true, mode, machineId, instanceId, blocked: true, error: lastError };
    }
    if (mode === 'coordinator' || mode === 'both') {
      coordinator = createCoordinator({ config, stateFile: config.stateFile });
      const started = await coordinator.start();
      if (!started.ok) {
        lastError = `coordinator listen failed: ${started.error}`;
        logger?.warn?.(`metainfer-cluster: ${lastError}`);
      } else {
        server = started;
        logger?.info?.(`metainfer-cluster: coordinator listening on ${started.url}`);
      }
    }
    if (mode === 'client' || mode === 'both' || (mode === 'coordinator' && fleetConfig.enabled)) {
      await beat();
      heartbeatTimer = setInterval(() => beat(), config.heartbeatMs);
      heartbeatTimer.unref?.();
    }
    return { enabled: true, mode, machineId, instanceId };
  }

  async function acquire({ requestId, projectId, nodeId, amount, machines, placement, constraints, ttlMs, priority }) {
    if (!enabled) return { status: 'granted', lease: null };
    if (blocked) throw new Error(lastError ?? 'machine-claimed-by-other-coordinator');
    try {
      const result = await http('/v1/acquire', {
        requestId,
        holderId: instanceId,
        userId: config.userId,
        clusterId: config.clusterId,
        machineId,
        projectId,
        nodeId,
        amount,
        machines: machines ?? 1,
        placement: placement ?? 'local',
        constraints: constraints ?? null,
        ttlMs: ttlMs ?? config.leaseTtlMs,
        priority: priority ?? config.priority,
      });
      if (result.status === 'granted') void refreshStatus().catch(() => {});
      return result;
    } catch (error) {
      connected = false;
      lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async function renew(leaseId, ttlMs) {
    if (!enabled) return { status: 'renewed', lease: null };
    return http('/v1/renew', { leaseId, holderId: instanceId, clusterId: config.clusterId, ttlMs: ttlMs ?? config.leaseTtlMs });
  }

  async function release(leaseId) {
    if (!enabled || !leaseId) return { status: 'released', already: true };
    return http('/v1/release', { leaseId, holderId: instanceId, clusterId: config.clusterId });
  }

  async function releaseAllMine() {
    if (!enabled) return { released: 0 };
    try {
      const data = await http('/v1/status', null, { method: 'GET' });
      const mine = (data.leases ?? []).filter((lease) => lease.holderId === instanceId);
      for (const lease of mine) await release(lease.leaseId);
      return { released: mine.length };
    } catch {
      return { released: 0, error: lastError };
    }
  }

  function getStatus() {
    return {
      enabled,
      mode,
      instanceId,
      machineId,
      userId: config.userId,
      clusterId: config.clusterId,
      coordinatorId: config.coordinatorId ?? null,
      coordinatorUrl,
      connected,
      blocked,
      claimConflict,
      heartbeatAt,
      error: lastError,
      devices,
      fleet: fleetSummary(),
      ...(statusCache ?? {}),
    };
  }

  async function stop() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    if (coordinator) coordinator.close();
    coordinator = null;
    server = null;
    await removeOwnClaim();
  }

  return {
    enabled,
    mode,
    machineId,
    instanceId,
    userId: config.userId,
    heartbeatMs: config.heartbeatMs,
    start,
    acquire,
    renew,
    release,
    releaseAllMine,
    getStatus,
    refreshStatus,
    getFleetMachines,
    get placementMode() {
      return fleetConfig.placementMode;
    },
    get fleetEnabled() {
      return fleetConfig.enabled === true;
    },
    get fleetMasterPort() {
      return fleetConfig.masterPort;
    },
    get fleetPathMap() {
      return fleetConfig.pathMap;
    },
    stop,
  };
}


// ---------------------------------------------------------------------------
// GUI configuration helpers + live reconfiguration
// ---------------------------------------------------------------------------

const TOKEN_MASK = '••••••••';

export async function readClusterConfigRaw(filePath) {
  try {
    const textValue = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(textValue);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeClusterConfigRaw(filePath, raw) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(raw, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, filePath);
}

/** Return the config with the token masked; UI submits a new token only when it changes. */
export function maskClusterConfig(raw) {
  const token = typeof raw.token === 'string' ? raw.token : '';
  return {
    enabled: raw.enabled === true,
    role: raw.role ?? 'both',
    clusterId: raw.clusterId ?? 'default',
    instanceId: raw.instanceId ?? null,
    machineId: raw.machineId ?? null,
    coordinatorId: raw.coordinatorId ?? null,
    userId: raw.userId ?? 'default',
    url: raw.url ?? null,
    listen: { host: raw.listen?.host ?? '127.0.0.1', port: raw.listen?.port ?? 8791 },
    tokenSet: token.length > 0,
    tokenMasked: token.length > 0 ? TOKEN_MASK : '',
    heartbeatMs: raw.heartbeatMs ?? 10000,
    leaseTtlMs: raw.leaseTtlMs ?? 900000,
    devices: Array.isArray(raw.devices) ? raw.devices : null,
    priority: raw.priority ?? 0,
    dashboard: raw.dashboard !== false,
    allowMultipleCoordinators: raw.allowMultipleCoordinators === true,
    claimDir: raw.claimDir ?? null,
    stateFile: raw.stateFile ?? null,
    fleet: normalizeFleetConfig(raw.fleet),
  };
}

function mergeClusterConfigRaw(current, patch) {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (key === 'token') {
      if (value === TOKEN_MASK || value === undefined) continue;
      next.token = typeof value === 'string' ? value : '';
      continue;
    }
    if (key === 'listen') {
      next.listen = { ...(current.listen ?? {}), ...(value ?? {}) };
      continue;
    }
    next[key] = value;
  }
  return next;
}

/**
 * Owns the live cluster manager and exposes both the runtime facade and the GUI
 * configuration API. Reconfiguration stops the old manager, persists the merged
 * config, then starts a fresh manager — no plugin reload/command line needed.
 */
export function createClusterAdmin({ ctx, store, configPath, logger }) {
  let rawConfig = {};
  let manager = null;
  let bootError = null;

  function normalized(raw) {
    return normalizeClusterConfig(raw, {
      stateFile: raw.stateFile ?? path.join(path.dirname(configPath), 'cluster-state.json'),
    });
  }

  function activeLeaseCount() {
    let count = 0;
    try {
      for (const project of store.listProjects()) {
        for (const node of store.listNodes(project.id)) {
          if (node.lease?.leaseId) count += 1;
        }
      }
    } catch {
      // store might be unavailable during early boot
    }
    return count;
  }

  function getConfigPayload() {
    const normalizedConfig = normalized(rawConfig);
    const status = manager ? manager.getStatus() : {
      enabled: normalizedConfig.enabled,
      mode: 'local',
      error: bootError,
    };
    const warnings = [...fleetWarnings(rawConfig.fleet)];
    if (normalizedConfig.enabled && !normalizedConfig.token) {
      warnings.push('token is empty: every cluster client will be rejected (401)');
    }
    if (normalizedConfig.enabled && !normalizedConfig.machineId) {
      warnings.push('machineId is empty: it will fall back to a process-based id');
    }
    if (normalizedConfig.enabled && ['client'].includes(normalizedConfig.role) && !normalizedConfig.url) {
      warnings.push('client role needs a coordinator URL');
    }
    return {
      path: configPath,
      config: maskClusterConfig(rawConfig),
      status,
      activeLeases: activeLeaseCount(),
      canApply: true,
      warnings,
    };
  }

  async function boot() {
    rawConfig = await readClusterConfigRaw(configPath);
    manager = createClusterManager({ ctx, config: normalized(rawConfig), logger });
    if (manager.enabled) {
      try {
        const info = await manager.start();
        if (info?.blocked || (info?.error && !info?.enabled)) bootError = info.error ?? null;
        await manager.releaseAllMine().catch(() => ({}));
      } catch (error) {
        bootError = error instanceof Error ? error.message : String(error);
        logger?.warn?.(`metainfer-cluster: boot failed: ${bootError}`);
      }
    }
    return manager;
  }

  async function applyConfig(patch, { force = false } = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new LabError('bad_request', 'cluster config must be an object', 400);
    }
    const merged = mergeClusterConfigRaw(rawConfig, patch);
    const normalizedConfig = normalized(merged);
    const fleet = normalizeFleetConfig(merged.fleet);
    if (normalizedConfig.enabled && fleet.enabled && fleet.machines.length === 0) {
      throw new LabError('bad_request', 'fleet.enabled requires at least one fleet machine', 400);
    }
    const seenFleet = new Set();
    for (const machine of fleet.machines) {
      if (seenFleet.has(machine.machineId)) {
        throw new LabError('bad_request', `duplicate fleet machineId: ${machine.machineId}`, 400);
      }
      seenFleet.add(machine.machineId);
      if (!machine.ssh.host) throw new LabError('bad_request', `fleet machine ${machine.machineId}: ssh.host is required`, 400);
      if (!machine.container.workdir) throw new LabError('bad_request', `fleet machine ${machine.machineId}: container.workdir is required`, 400);
      if (machine.container.runtime !== 'none' && !machine.container.name) {
        throw new LabError('bad_request', `fleet machine ${machine.machineId}: container.name is required`, 400);
      }
    }
    if (normalizedConfig.enabled && !['coordinator', 'client', 'both'].includes(normalizedConfig.role)) {
      throw new LabError('bad_request', 'cluster.role must be coordinator/client/both', 400);
    }
    if (normalizedConfig.enabled && !force && activeLeaseCount() > 0) {
      throw new LabError(
        'cluster_busy',
        'a node currently holds a GPU lease; wait for it to finish or stop it before changing cluster settings',
        409,
      );
    }
    const old = manager;
    if (old) {
      await old.releaseAllMine().catch(() => ({}));
      await old.stop().catch(() => {});
    }
    rawConfig = merged;
    await writeClusterConfigRaw(configPath, rawConfig);
    manager = createClusterManager({ ctx, config: normalized(rawConfig), logger });
    bootError = null;
    if (manager.enabled) {
      try {
        const info = await manager.start();
        if (info?.blocked) bootError = info.error ?? 'cluster blocked';
        else if (info?.error && !info?.enabled) bootError = info.error;
      } catch (error) {
        bootError = error instanceof Error ? error.message : String(error);
        logger?.warn?.(`metainfer-cluster: apply failed: ${bootError}`);
      }
    }
    return getConfigPayload();
  }

  async function stop() {
    if (manager) await manager.stop().catch(() => {});
  }

  const facade = {
    get enabled() {
      return Boolean(manager?.enabled);
    },
    get mode() {
      return manager?.mode ?? 'local';
    },
    get machineId() {
      return manager?.machineId ?? null;
    },
    get instanceId() {
      return manager?.instanceId ?? null;
    },
    get userId() {
      return manager?.userId ?? 'default';
    },
    get heartbeatMs() {
      return manager?.heartbeatMs ?? 10000;
    },
    get fleetEnabled() {
      return manager?.fleetEnabled === true;
    },
    get placementMode() {
      return manager?.placementMode ?? 'local';
    },
    get fleetMasterPort() {
      return manager?.fleetMasterPort ?? 29500;
    },
    getFleetMachines: () => manager?.getFleetMachines?.() ?? [],
    get fleetPathMap() {
      return manager?.fleetPathMap ?? [];
    },
    getFleetConfig: () => normalized(rawConfig).fleet ?? normalizeFleetConfig(null),
    acquire: (...args) => manager.acquire(...args),
    renew: (...args) => manager.renew(...args),
    release: (...args) => manager.release(...args),
    releaseAllMine: (...args) => manager.releaseAllMine(...args),
    getStatus: () => (manager ? manager.getStatus() : { enabled: false, mode: 'local' }),
    refreshStatus: (...args) => manager.refreshStatus(...args),
  };

  return {
    facade,
    boot,
    getConfigPayload,
    applyConfig,
    stop,
  };
}
