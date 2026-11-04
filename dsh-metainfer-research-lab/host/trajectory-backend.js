/**
 * Lifecycle owner for the local MetaInfer trajectory backend.
 *
 * The browser talks to the DSH Web origin only.  If the platform HTTP service
 * is not already running (for example after a DSH restart), this module starts
 * it once and stops only the child it owns.  An existing service is reused.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const HOST = '127.0.0.1';
const PORT = 8765;
const HEALTH_PATH = '/api/sys-shell/trajectories/health';

function healthy(timeoutMs = 800) {
  return new Promise((resolve) => {
    const request = http.get({ host: HOST, port: PORT, path: HEALTH_PATH, timeout: timeoutMs }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('timeout', () => { request.destroy(); resolve(false); });
    request.on('error', () => resolve(false));
  });
}

async function firstNode(root) {
  try {
    const entries = await readdir(path.join(root, 'nodes'));
    return entries.filter((entry) => !entry.startsWith('.')).sort()[0] || '';
  } catch {
    return '';
  }
}

export async function ensureTrajectoryBackend(logger) {
  if (await healthy()) return { owned: false, process: null };
  const root = process.env.METAINFER_ROOT || '/home/MetaInfer';
  const nodeId = process.env.METAINFER_NODE_ID || await firstNode(root);
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const logDir = path.join(dshHome, 'metainfer-research-lab');
  mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, 'metainfer-web.log');
  const logFd = openSync(logPath, 'a');
  const env = {
    ...process.env,
    METAINFER_ROOT: root,
    METAINFER_HOST: HOST,
    METAINFER_PORT: String(PORT),
    DSH_HOME: dshHome,
  };
  if (nodeId) env.METAINFER_NODE_ID = nodeId;
  if (!env.DSH_SESSIONS_DIR) env.DSH_SESSIONS_DIR = path.join(dshHome, 'sessions');
  const child = spawn(process.env.METAINFER_PYTHON || 'python3', ['-m', 'metainfer.server.app'], {
    cwd: root,
    env,
    stdio: ['ignore', logFd, logFd],
  });
  closeSync(logFd);
  child.on('exit', (code, signal) => {
    try {
      logger?.info?.(`[trajectory-backend] exited code=${code} signal=${signal}`);
    } catch { /* diagnostics only */ }
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (await healthy(500)) return { owned: true, process: child, logPath };
    if (child.exitCode !== null) break;
  }
  return { owned: true, process: child, logPath };
}
