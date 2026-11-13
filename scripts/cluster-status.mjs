#!/usr/bin/env node
/**
 * Read-only cluster status CLI.
 *
 * Usage:
 *   node scripts/cluster-status.mjs [--config PATH] [--url URL] [--token TOKEN] [--json] [--watch SECONDS]
 *
 * Defaults to ~/.dsh/metainfer-research-lab/cluster.json; the token defaults to the
 * token in that file. This script never mutates coordinator state.
 */
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function parseArgs(argv) {
  const args = { json: false, watch: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--json') args.json = true;
    else if (flag === '--config') args.config = argv[++index];
    else if (flag === '--url') args.url = argv[++index];
    else if (flag === '--token') args.token = argv[++index];
    else if (flag === '--watch') args.watch = Math.max(0, Number(argv[++index]) || 0);
    else if (flag === '--help' || flag === '-h') args.help = true;
  }
  return args;
}

function pad(value, width) {
  return String(value ?? '').padEnd(width).slice(0, width);
}

function formatTable(headers, rows) {
  if (rows.length === 0) return '  (empty)';
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => String(row[index] ?? '').length)),
  );
  const line = (row) => '  ' + row.map((cell, index) => pad(cell, widths[index])).join('  ');
  return [line(headers), line(widths.map((width) => '─'.repeat(width))), ...rows.map(line)].join('\n');
}

async function loadConfig(args) {
  const configPath = args.config ?? path.join(os.homedir(), '.dsh', 'metainfer-research-lab', 'cluster.json');
  let raw = {};
  try {
    raw = JSON.parse(await readFile(configPath, 'utf8'));
  } catch {
    // allow --url/--token without a config file
  }
  const listen = raw.listen ?? {};
  const url = args.url ?? raw.url ?? `http://${listen.host ?? '127.0.0.1'}:${listen.port ?? 8794}`;
  const token = args.token ?? raw.token ?? '';
  return { url: String(url).replace(/\/$/, ''), token, configPath, raw };
}

async function fetchStatus(url, token) {
  const response = await fetch(`${url}/v1/status`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    const code = body?.error?.code ?? `http-${response.status}`;
    throw new Error(`status request failed: ${code}`);
  }
  return body.data;
}

function printStatus(data, url) {
  const gpu = data.pools?.gpu ?? { total: 0, used: 0, free: 0 };
  console.log(`\nMetaInfer GPU cluster  ${data.clusterId ?? '(no clusterId)'}`);
  console.log(`  coordinator : ${data.coordinatorId ?? '-'}  ${data.url ?? url}`);
  console.log(`  gpu         : total=${gpu.total} used=${gpu.used} free=${gpu.free} queue=${(data.queue ?? []).length}`);
  console.log('\nMachines');
  console.log(formatTable(
    ['machine', 'online', 'instances', 'devices'],
    (data.machines ?? []).map((machine) => [
      machine.machineId,
      machine.online ? 'yes' : 'no',
      (machine.instances ?? []).join(','),
      (machine.devices ?? []).map((device) => `${device.id}(${device.model}${device.memoryMiB ? `,${device.memoryMiB}MiB` : ''})`).join(' '),
    ]),
  ));
  console.log('\nLeases');
  const now = Date.now();
  console.log(formatTable(
    ['lease', 'project/node', 'user', 'machine', 'devices', 'ttl'],
    (data.leases ?? []).map((lease) => [
      lease.leaseId,
      `${lease.projectId ?? '-'}/${lease.nodeId ?? '-'}`,
      lease.userId ?? '-',
      lease.machineId,
      (lease.deviceIds ?? []).join(','),
      `${Math.max(0, Math.round(((lease.expiresAt ?? now) - now) / 1000))}s`,
    ]),
  ));
  console.log('\nQueue');
  console.log(formatTable(
    ['#', 'project/node', 'user', 'machine', 'gpus', 'waited'],
    (data.queue ?? []).map((item) => [
      item.position,
      `${item.projectId ?? '-'}/${item.nodeId ?? '-'}`,
      item.userId ?? '-',
      item.machineId,
      item.amount,
      `${Math.round((item.waitedMs ?? 0) / 1000)}s`,
    ]),
  ));
  console.log('\nUsage (GPU-seconds)');
  console.log(formatTable(
    ['user', 'project', 'gpu-seconds', 'leases'],
    (data.usage ?? []).map((item) => [
      item.userId ?? '-',
      item.projectId ?? '-',
      Math.round(item.gpuSeconds ?? 0),
      item.leases ?? 0,
    ]),
  ));
  console.log('');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node scripts/cluster-status.mjs [--config PATH] [--url URL] [--token TOKEN] [--json] [--watch SECONDS]');
    return;
  }
  const { url, token } = await loadConfig(args);
  const once = async () => {
    try {
      const data = await fetchStatus(url, token);
      if (args.json) console.log(JSON.stringify(data, null, 2));
      else printStatus(data, url);
      return data;
    } catch (error) {
      console.error(`cluster-status: ${error instanceof Error ? error.message : String(error)}`);
      console.error(`  coordinator: ${url}`);
      console.error('  hint: is the coordinator instance running with cluster.enabled=true and the same token?');
      process.exitCode = 1;
      return null;
    }
  };
  const data = await once();
  if (args.watch > 0 && data) {
    setInterval(() => {
      once();
    }, args.watch * 1000);
  }
}

void main();
