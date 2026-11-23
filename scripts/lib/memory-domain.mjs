import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * In-memory stand-in for the DSH storageDomain facility, shared by offline
 * self-tests and the simulator. Values are stored by reference, like a cache-
 * backed domain might do; kernel code must therefore never mutate records it
 * reads (the executor deep-copies its working set).
 *
 * `failAfterPuts` lets crash tests stop writes after N successful puts.
 */
export function memoryDomain({ failAfterPuts = Infinity } = {}) {
  const tables = new Map();
  let puts = 0;
  const domain = {
    table(name) {
      if (!tables.has(name)) tables.set(name, new Map());
      const data = tables.get(name);
      return {
        get: (key) => data.get(key),
        entries: () => data.entries(),
        keys: () => data.keys(),
        get size() { return data.size; },
        put: async (key, value) => {
          if (puts >= domain.failAfterPuts) throw new Error('simulated crash: storage write refused');
          puts += 1;
          data.set(key, value);
        },
        delete: async (key) => data.delete(key),
      };
    },
    close: async () => {},
    failAfterPuts,
    get puts() { return puts; },
  };
  return domain;
}

/**
 * Minimal Cordis-like ctx exposing only `storageDomain`, enough for openStore().
 *
 * The DAG WAL defaults to a file under DSH_HOME; a probe that forgot to override
 * it would append its synthetic nodes to the operator's real log (which is how the
 * production log once started at seq 67). Every probe therefore gets its own
 * throwaway WAL file unless it passes an explicit `kernel.walFile`.
 */
export function storeContext(domain, config = {}) {
  const kernel = { walFile: config?.kernel?.walFile ?? defaultProbeWalFile(), ...(config?.kernel ?? {}) };
  return { storageDomain: { open: async () => domain }, config: { ...config, kernel } };
}

/** One WAL file per probe process, removed at exit. */
function defaultProbeWalFile() {
  const dir = path.join(os.tmpdir(), 'mirl-probe-wal-' + process.pid);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'wal.sqlite');
  process.once('exit', () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  return file;
}
