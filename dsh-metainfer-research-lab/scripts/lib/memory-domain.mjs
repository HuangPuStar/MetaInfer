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

/** Minimal Cordis-like ctx exposing only `storageDomain`, enough for openStore(). */
export function storeContext(domain, config = {}) {
  return { storageDomain: { open: async () => domain }, config };
}
