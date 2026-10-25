/**
 * Remote fleet execution bundle (V6).
 *
 * The DSH host may have no GPUs; nodes still run their agent/worktree locally but
 * execute GPU workloads on leased remote machines over SSH inside containers.
 * The Host writes a per-node `.dshex-run/` bundle containing the lease manifest and
 * small runner scripts; `.dshex-run/` is git-excluded so it never enters commits.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function normalizePathText(value) {
  return String(value ?? '').trim().replace(/\\/g, '/');
}

function normalizeForMatch(value) {
  const normalized = normalizePathText(value).replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function mapPath(localPath, pathMaps) {
  const normalizedLocal = normalizePathText(localPath).replace(/\/+$/, '');
  const matchLocal = normalizeForMatch(normalizedLocal);
  for (const pair of pathMaps ?? []) {
    if (!pair?.from || !pair?.to) continue;
    const from = normalizeForMatch(pair.from);
    if (from === '' || !(matchLocal === from || matchLocal.startsWith(from + '/'))) continue;
    const rest = normalizedLocal.slice(normalizePathText(pair.from).replace(/\/+$/, '').length);
    return normalizePathText(pair.to).replace(/\/+$/, '') + rest;
  }
  return normalizedLocal;
}

function remotePathFor(machine, localWorktree, fleetPathMap) {
  return mapPath(localWorktree, [...(machine.pathMap ?? []), ...(fleetPathMap ?? [])]);
}

function isWindowsStylePath(value) {
  return /^[A-Za-z]:[\\/]/.test(String(value ?? '')) || /^\\\\/.test(String(value ?? ''));
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function buildMachineEntry(machine, group, node, fleet, rank, masterAddr) {
  const remoteWorktree = remotePathFor(machine, node.git.worktreePath, fleet.pathMap);
  const devices = (group.deviceIds ?? []).map((deviceId) => {
    const known = (machine.devices ?? []).find(
      (device) => `${machine.machineId}:${device.id}` === deviceId,
    );
    return {
      id: deviceId,
      localId: known?.localId ?? deviceId.split(':').pop(),
    };
  });
  return {
    rank,
    machineId: machine.machineId,
    labels: machine.labels ?? {},
    ssh: machine.ssh,
    container: machine.container,
    remoteWorktree,
    devices,
    cudaVisibleDevices: devices.map((device) => device.localId).join(','),
    masterAddr,
    masterPort: fleet.masterPort,
  };
}

const RUNNER_TEMPLATE = `
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'manifest.json'), 'utf8'));

function quote(value) {
  return "'" + String(value).replace(/'/g, "'\\\\''") + "'";
}
function envPairs(machine, extra = {}) {
  const pairs = {
    CUDA_VISIBLE_DEVICES: machine.cudaVisibleDevices,
    DSHEX_MACHINE_ID: machine.machineId,
    DSHEX_RANK: String(machine.rank),
    DSHEX_WORLD_SIZE: String(manifest.machines.length),
    DSHEX_GPUS: String(machine.devices.length),
    DSHEX_MASTER_ADDR: machine.masterAddr,
    DSHEX_MASTER_PORT: String(machine.masterPort),
    ...(manifest.containerEnv ?? {}),
    ...extra,
  };
  return pairs;
}
function remoteCommand(machine, commandString, extraEnv = {}) {
  const pairs = envPairs(machine, extraEnv);
  const envFlags = Object.entries(pairs).flatMap(([key, value]) => ['-e', key + '=' + value]);
  const envPrefix = Object.entries(pairs).map(([key, value]) => key + '=' + quote(value)).join(' ');
  const container = machine.container ?? {};
  if (container.runtime === 'docker' || container.runtime === 'podman') {
    return envPrefix + ' ' + container.runtime + ' exec ' + envFlags.map(quote).join(' ') +
      ' -w ' + quote(machine.remoteWorktree) +
      (container.user ? ' --user ' + quote(container.user) : '') +
      ' ' + quote(container.name) + ' bash -lc ' + quote(commandString);
  }
  if (container.runtime === 'apptainer') {
    return 'cd ' + quote(machine.remoteWorktree) + ' && ' + envPrefix +
      ' apptainer exec --nv ' + quote(container.name) + ' bash -lc ' + quote(commandString);
  }
  return 'cd ' + quote(machine.remoteWorktree) + ' && ' + envPrefix + ' bash -lc ' + quote(commandString);
}
function sshArgs(machine, remote) {
  const ssh = machine.ssh ?? {};
  const args = [];
  if (ssh.port) args.push('-p', String(ssh.port));
  if (ssh.keyPath) args.push('-i', ssh.keyPath);
  for (const option of ssh.options ?? []) args.push(option);
  args.push((ssh.user || 'root') + '@' + ssh.host, remote);
  return args;
}
function findMachine(machineId) {
  return manifest.machines.find((machine) => machine.machineId === machineId);
}
function runRemote(machineId, commandArgs) {
  const machine = findMachine(machineId);
  if (!machine) {
    console.error('unknown leased machine: ' + machineId + '; leased: ' + manifest.machines.map((m) => m.machineId).join(', '));
    process.exit(2);
  }
  const commandString = commandArgs.map((part) => quote(part)).join(' ');
  const remote = remoteCommand(machine, commandString);
  const ssh = machine.ssh ?? {};
  const result = spawnSync(ssh.command || 'ssh', sshArgs(machine, remote), { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
function launchAll(commandArgs) {
  const commandString = commandArgs.map((part) => quote(part)).join(' ');
  const children = manifest.machines.map((machine) => {
    const remote = remoteCommand(machine, commandString);
    const ssh = machine.ssh ?? {};
    const child = spawn(ssh.command || 'ssh', sshArgs(machine, remote), { stdio: 'inherit' });
    return { machine, child };
  });
  let pending = children.length;
  let exitCode = 0;
  if (pending === 0) process.exit(0);
  for (const item of children) {
    item.child.on('exit', (code) => {
      if (code && code !== 0 && exitCode === 0) exitCode = code;
      pending -= 1;
      if (pending === 0) process.exit(exitCode);
    });
    item.child.on('error', (error) => {
      console.error(item.machine.machineId + ': ' + error.message);
      if (exitCode === 0) exitCode = 1;
      pending -= 1;
      if (pending === 0) process.exit(exitCode);
    });
  }
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'remote') {
  runRemote(rest[0], rest.slice(1));
} else if (mode === 'launch') {
  launchAll(rest);
} else {
  console.error('usage: runner.mjs remote <machineId> <command...> | runner.mjs launch <command...>');
  process.exit(2);
}
`;

const REMOTE_SH = `#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
exec node "$DIR/runner.mjs" remote "$@"
`;

const LAUNCH_SH = `#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
exec node "$DIR/runner.mjs" launch "$@"
`;

const REMOTE_PS1 = `$ErrorActionPreference = 'Stop'
$runner = Join-Path $PSScriptRoot 'runner.mjs'
& __NODE__ $runner remote @args
exit $LASTEXITCODE
`;

const LAUNCH_PS1 = `$ErrorActionPreference = 'Stop'
$runner = Join-Path $PSScriptRoot 'runner.mjs'
& __NODE__ $runner launch @args
exit $LASTEXITCODE
`;

const REMOTE_CMD = `@echo off
"__NODE__" "%~dp0runner.mjs" remote %*
`;

const LAUNCH_CMD = `@echo off
"__NODE__" "%~dp0runner.mjs" launch %*
`;

/**
 * Write the per-node remote run bundle.
 * @returns {Promise<{dir:string, manifest:object, prompt:string}>}
 */
export async function prepareRemoteRun({ project, node, lease, cluster }) {
  const fleet = cluster.getFleetConfig();
  const machineConfigs = new Map((cluster.getFleetMachines() ?? []).map((machine) => [machine.machineId, machine]));
  const groups = Array.isArray(lease?.machines) && lease.machines.length > 0
    ? lease.machines
    : [{ machineId: lease?.machineId, deviceIds: lease?.deviceIds ?? [] }];
  const masterAddress = groups
    .map((group) => machineConfigs.get(group.machineId))
    .map((machine) => machine?.masterAddr || machine?.ssh?.host)
    .find(Boolean) ?? null;
  const machines = [];
  let rank = 0;
  for (const group of groups) {
    const machine = machineConfigs.get(group.machineId);
    if (!machine) {
      throw new Error(`fleet machine "${group.machineId}" is not configured on this DSH instance`);
    }
    machines.push(buildMachineEntry(machine, group, node, fleet, rank, masterAddress));
    rank += 1;
  }
  if (process.platform === 'win32') {
    for (const machine of machines) {
      if (isWindowsStylePath(machine.remoteWorktree)) {
        throw new Error(
          `fleet_path_map_required: remote path "${machine.remoteWorktree}" is a local Windows path. ` +
          'Configure fleet.pathMap (or the machine pathMap) from the local worktree prefix to the ' +
          'POSIX/NFS path visible inside the Linux container.',
        );
      }
    }
  }
  const dir = path.join(node.git.worktreePath, '.dshex-run');
  await mkdir(dir, { recursive: true });
  const containerEnv = Object.assign({}, ...machines.map((machine) => machine.container?.env ?? {}));
  const manifest = {
    version: 1,
    generatedAt: Date.now(),
    projectId: project.id,
    nodeId: node.id,
    leaseId: lease?.leaseId ?? null,
    leaseExpiresAt: lease?.expiresAt ?? null,
    clusterId: cluster.getStatus()?.clusterId ?? null,
    localWorktree: node.git.worktreePath,
    masterPort: fleet.masterPort,
    containerEnv,
    hostPlatform: process.platform,
    nodePath: process.execPath,
    machines,
  };
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  await writeFile(path.join(dir, 'runner.mjs'), RUNNER_TEMPLATE, 'utf8');
  await writeFile(path.join(dir, 'remote.sh'), REMOTE_SH, { encoding: 'utf8', mode: 0o755 });
  await writeFile(path.join(dir, 'launch.sh'), LAUNCH_SH, { encoding: 'utf8', mode: 0o755 });
  await writeFile(path.join(dir, 'remote.ps1'), REMOTE_PS1.replace('__NODE__', psQuote(process.execPath)), 'utf8');
  await writeFile(path.join(dir, 'launch.ps1'), LAUNCH_PS1.replace('__NODE__', psQuote(process.execPath)), 'utf8');
  await writeFile(path.join(dir, 'remote.cmd'), REMOTE_CMD.replace('__NODE__', process.execPath).replace(/\n/g, '\r\n'), 'utf8');
  await writeFile(path.join(dir, 'launch.cmd'), LAUNCH_CMD.replace('__NODE__', process.execPath).replace(/\n/g, '\r\n'), 'utf8');
  const readme = [
    '# Remote fleet execution bundle',
    '',
    `Lease: ${lease?.leaseId ?? '(none)'} (expires ${lease?.expiresAt ? new Date(lease.expiresAt).toISOString() : 'unknown'})`,
    `Machines: ${machines.map((machine) => `${machine.machineId} (${machine.cudaVisibleDevices})`).join(', ')}`,
    '',
    'Do NOT SSH to machines outside this lease. Use:',
    '  POSIX:     ./.dshex-run/remote.sh <machineId> <command...>',
    '             ./.dshex-run/launch.sh \'<command with $DSHEX_* variables>\'',
    '  PowerShell: .\\.dshex-run\\remote.ps1 <machineId> <command...>',
    '             .\\.dshex-run\\launch.ps1 \'<command with $DSHEX_* variables>\'',
    '  Any:       node .dshex-run/runner.mjs remote <machineId> <command...>',
    '             node .dshex-run/runner.mjs launch \'<command with $DSHEX_* variables>\'',
    '',
    'Environment on every machine: CUDA_VISIBLE_DEVICES, DSHEX_MACHINE_ID, DSHEX_RANK,',
    'DSHEX_WORLD_SIZE, DSHEX_GPUS, DSHEX_MASTER_ADDR, DSHEX_MASTER_PORT.',
  ].join('\n');
  await writeFile(path.join(dir, 'README.md'), readme, 'utf8');
  // Keep the bundle out of git commits (shared repo exclude file is used by all worktrees).
  const excludePath = path.join(project.repo.gitDir, 'info', 'exclude');
  try {
    await mkdir(path.dirname(excludePath), { recursive: true });
    let current = '';
    try {
      current = await readFile(excludePath, 'utf8');
    } catch {
      current = '';
    }
    if (!current.split('\n').some((line) => line.trim() === '.dshex-run/')) {
      await writeFile(excludePath, `${current.replace(/\n$/, '')}\n.dshex-run/\n`, 'utf8');
    }
  } catch {
    // info/exclude is best-effort; .dshex-run is also harmless if committed.
  }
  const prompt = [
    '',
    '# Remote GPU execution (this node uses a remote fleet lease)',
    'This DSH host does not execute GPU work for this node. The leased machines are:',
    ...machines.map((machine) => `- ${machine.machineId}${Object.keys(machine.labels ?? {}).length > 0 ? ` [${Object.entries(machine.labels).map(([key, value]) => `${key}=${value}`).join(', ')}]` : ''}: SSH ${machine.ssh.user}@${machine.ssh.host}, container ${machine.container.runtime}:${machine.container.name}, project dir ${machine.remoteWorktree}, CUDA_VISIBLE_DEVICES=${machine.cudaVisibleDevices}`),
    '',
    'Worktree files are on shared NFS storage, so the same paths are visible inside the containers.',
    'Use ONLY the generated wrappers (they contain the lease; do not ssh to other machines):',
    ...(process.platform === 'win32'
      ? [
          '- Single machine: `node .dshex-run/runner.mjs remote <machineId> <command...>`',
          '  or PowerShell: `.\\.dshex-run\\remote.ps1 <machineId> <command...>`',
          '- All machines concurrently: `node .dshex-run/runner.mjs launch \'<command using $DSHEX_* env>\'`',
          '  or PowerShell: `.\\.dshex-run\\launch.ps1 \'<command using $DSHEX_* env>\'`',
          '  (single quotes keep $DSHEX_* literal; the remote bash inside the container expands them)',
        ]
      : [
          '- Single machine: `./.dshex-run/remote.sh <machineId> <command...>`',
          '- All machines concurrently: `./.dshex-run/launch.sh \'<command using $DSHEX_* env>\'`',
        ]),
    '  Available env: DSHEX_MACHINE_ID, DSHEX_RANK, DSHEX_WORLD_SIZE, DSHEX_GPUS,',
    '  DSHEX_MASTER_ADDR, DSHEX_MASTER_PORT, CUDA_VISIBLE_DEVICES.',
    'Example multi-machine torchrun (single quotes keep the variables for the remote container):',
    ...(process.platform === 'win32'
      ? ['  node .dshex-run/runner.mjs launch \'torchrun --nnodes=$DSHEX_WORLD_SIZE --node_rank=$DSHEX_RANK --nproc_per_node=$DSHEX_GPUS --master_addr=$DSHEX_MASTER_ADDR --master_port=$DSHEX_MASTER_PORT train.py\'']
      : ['  ./.dshex-run/launch.sh \'torchrun --nnodes=$DSHEX_WORLD_SIZE --node_rank=$DSHEX_RANK --nproc_per_node=$DSHEX_GPUS --master_addr=$DSHEX_MASTER_ADDR --master_port=$DSHEX_MASTER_PORT train.py\'']),
    `The lease expires at ${lease?.expiresAt ? new Date(lease.expiresAt).toISOString() : 'unknown'}; the Host renews it while the node runs.`,
    'Do not run GPU commands on the local DSH host (it may have no GPU); do not start long-lived work after the lease ends.',
  ].join('\n');
  return { dir, manifest, prompt };
}
