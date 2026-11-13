/**
 * Tiny file-backed storageDomain for restart probes.
 *
 * The real DSH domain is provided by the Host; self-tests cannot open it. This
 * adapter persists the same per-record shape to a JSON file so a second Node
 * process sees exactly what the first process wrote. It is test infrastructure,
 * not a production storage implementation.
 */
import fs from 'node:fs';

export function createJsonFileDomain(file) {
  const state = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : { tables: {} };
  if (!state.tables || typeof state.tables !== 'object') state.tables = {};
  function flush() {
    fs.writeFileSync(file, JSON.stringify(state), 'utf8');
  }
  return {
    table(name) {
      if (!state.tables[name] || typeof state.tables[name] !== 'object') state.tables[name] = {};
      const data = state.tables[name];
      return {
        get: (key) => data[key]?.value,
        entries: () => Object.entries(data).map(([key, row]) => [key, row.value]),
        keys: () => Object.keys(data),
        get size() { return Object.keys(data).length; },
        put: async (key, value) => {
          data[key] = { value };
          flush();
        },
        delete: async (key) => { delete data[key]; flush(); },
      };
    },
    close: async () => {},
  };
}
