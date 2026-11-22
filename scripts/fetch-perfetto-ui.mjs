#!/usr/bin/env node
/**
 * Fetch the pinned Perfetto UI build into the Host's data directory
 * (issue #94 follow-up): `<root>/<version>/index.html` + assets.
 *
 * Usage:
 *   node scripts/fetch-perfetto-ui.mjs [--root <dir>] [--version v59.1] [--force]
 *
 * Default root is `$DSH_HOME/metainfer-research-lab/perfetto-ui` (or
 * `~/.dsh/...`). The plugin serves it at `/metainfer/perfetto/`; without it the
 * Client falls back to https://ui.perfetto.dev.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const args = process.argv.slice(2);
function flag(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}
const VERSION = flag('--version', 'v59.1');
const FORCE = args.includes('--force');
const ROOT = path.resolve(flag('--root', path.join(
  process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
  'metainfer-research-lab',
  'perfetto-ui',
)));
const URL = `https://github.com/google/perfetto/releases/download/${VERSION}/perfetto-ui.zip`;
const target = path.join(ROOT, VERSION);

async function exists(file) {
  try { await stat(file); return true; } catch { return false; }
}

async function main() {
  if (!FORCE && await exists(path.join(target, 'index.html'))) {
    console.log(`perfetto-ui ${VERSION} already present: ${target}`);
    return;
  }
  await mkdir(ROOT, { recursive: true });
  const temp = await mkdtemp(path.join(os.tmpdir(), 'perfetto-ui-'));
  const zip = path.join(temp, 'perfetto-ui.zip');
  try {
    console.log(`downloading ${URL}`);
    const response = await fetch(URL, { redirect: 'follow' });
    if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 5 * 1024 * 1024) throw new Error(`download looks truncated: ${bytes.length} bytes`);
    await (await import('node:fs/promises')).writeFile(zip, bytes);
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    await run('unzip', ['-q', '-o', zip, '-d', target]);
    if (!await exists(path.join(target, 'index.html'))) {
      throw new Error(`unzip did not produce index.html in ${target}`);
    }
    const files = await readdir(target);
    console.log(`installed ${VERSION} into ${target} (${files.length} top-level entries)`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`fetch-perfetto-ui: ${error.message}`);
  process.exit(1);
});
