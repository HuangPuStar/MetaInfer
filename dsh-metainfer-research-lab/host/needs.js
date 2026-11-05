/**
 * Single source of truth for `node.needs` normalization (Host side).
 *
 * The canonical stored / HTTP / MCP / agent-tool shape is a map:
 * `{ "gpu": 2, "machines": 2 }` — see `NodeRecord.needs` in docs/01-architecture.md.
 * The advisor LLM's structured-output schema cannot express a map (the DSH JSON-schema
 * subset requires `additionalProperties` to be a boolean), so proposals arrive as
 * `[{ key, amount }]`. Both wire shapes are accepted here and always normalized into the
 * canonical map, so no call site needs to know which transport produced the value.
 *
 * Rules (kept in one place so `createProject`, `node.edit`, `node.successor`,
 * advisor proposals, the MCP surface and the agent tool cannot drift apart):
 *
 *   - resource keys match RESOURCE_KEY_PATTERN (lowercase): `runtime` and `auto` read
 *     `needs.gpu` / `needs.machines` by literal name, so an uppercase `GPU` would silently
 *     skip the GPU lease/placement logic. `normalizeResourcePools()` imports the same
 *     pattern, so a declared pool key can always be requested.
 *   - amounts are integers >= 0, given as a number or a digit-only string. `Number()`'s
 *     looser coercions (`true` -> 1, `[2]` -> 2, `null`/"" -> 0, `"0x10"` -> 16) are
 *     rejected, so a malformed payload can never silently drop or inflate a requirement.
 *   - `machines` is a placement hint, not a pool resource: 1..8 when present, and the last
 *     value wins for repeated entries (these are not additive quantities).
 *   - `gpu` may be requested without a local pool, or against a `gpu: 0` pool, only while the
 *     cluster coordinator is enabled: it leases whole GPUs and `resourcePools.gpu` is then an
 *     optional per-project quota that `runtime.js` skips for leased nodes. Without the
 *     coordinator the node could never start, so the request is rejected at creation/edit time.
 *   - the accumulated amount must not exceed the declared pool size, so duplicate entries in
 *     the array form cannot smuggle a larger request past the check.
 *   - key lookups use own properties only: `constructor` matches the key pattern and would
 *     otherwise be read from `Object.prototype` and string-concatenated into `needs`.
 */

/** A resource key must be lowercase so `needs.gpu` / `needs.machines` lookups keep working. */
export const RESOURCE_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

const AMOUNT_PATTERN = /^\d+$/;
const MAX_MACHINES = 8;
/** Placement hint, not a resource pool: the runtime skips it in `ensureCapacity`. */
export const RESERVED_NEEDS_KEYS = Object.freeze(['machines']);
const BAD_SHAPE = 'needs must be an object like {"gpu": 2} or an array of {key, amount}';

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/**
 * Read `project.config.resourcePools` defensively: a hand-edited or legacy record may hold
 * a non-object, and this function must return a validation error rather than throw.
 * @returns {Record<string, number>}
 */
function poolsOf(project) {
  const pools = project?.config?.resourcePools;
  return pools && typeof pools === 'object' && !Array.isArray(pools) ? pools : {};
}

/**
 * Accept a number or a digit-only string and reject everything else.
 * @returns {number | null} the amount, or null when the value is not a non-negative integer.
 */
function toAmount(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value === 'string' && AMOUNT_PATTERN.test(value.trim())) {
    const amount = Number(value.trim());
    return Number.isSafeInteger(amount) ? amount : null;
  }
  return null;
}

/** @returns {Array<[unknown, unknown]> | null} key/amount pairs, or null for a bad shape. */
function toPairs(raw) {
  if (Array.isArray(raw)) {
    const pairs = [];
    for (const item of raw) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
      pairs.push([item.key, item.amount]);
    }
    return pairs;
  }
  if (typeof raw === 'object') return Object.entries(raw);
  return null;
}

/**
 * Normalize a `needs` payload from any caller into the canonical map.
 *
 * @param {unknown} raw `{gpu: 2}` | `[{key: 'gpu', amount: 2}]` | null/undefined
 * @param {{config?: {resourcePools?: Record<string, number>}}} [project]
 * @param {{clusterEnabled?: boolean}} [options]
 *   `clusterEnabled` allows `gpu` without a local pool (the coordinator leases the card).
 * @returns {{needs: Record<string, number>, error: string | null}}
 */
export function normalizeNeeds(raw, project, { clusterEnabled = false } = {}) {
  if (raw === undefined || raw === null) return { needs: {}, error: null };
  const pairs = toPairs(raw);
  if (pairs === null) return { needs: {}, error: BAD_SHAPE };
  const pools = poolsOf(project);
  const needs = {};
  for (const [rawKey, rawValue] of pairs) {
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (!RESOURCE_KEY_PATTERN.test(key)) {
      return { needs: {}, error: `invalid resource name: ${typeof rawKey === 'string' ? rawKey : String(rawKey)}` };
    }
    const amount = toAmount(rawValue);
    if (amount === null) {
      return { needs: {}, error: `resource "${key}" must be a non-negative integer` };
    }
    if (key === 'machines') {
      if (amount < 1 || amount > MAX_MACHINES) {
        return { needs: {}, error: `needs[machines] must be 1..${MAX_MACHINES}` };
      }
      needs.machines = amount;
      continue;
    }
    // Validate the key before dropping a zero amount, so `{tpu: 0}` is still an error.
    const hasPool = hasOwn(pools, key);
    const poolTotal = hasPool ? Number(pools[key]) : undefined;
    if (!hasPool) {
      if (key !== 'gpu') return { needs: {}, error: `unknown resource: ${key}` };
      if (!clusterEnabled) {
        return {
          needs: {},
          error: 'unknown resource: gpu (declare "gpu" in resourcePools, or enable the cluster coordinator to lease GPUs)',
        };
      }
    }
    if (amount === 0) continue;
    const total = (hasOwn(needs, key) ? needs[key] : 0) + amount;
    // A `gpu` pool of 0 means "no local quota" — but only for leased nodes: without the
    // coordinator the runtime counts against the pool (`ensureCapacity`) and would reject
    // this node at start, so the request must fail here instead.
    const leasedGpu = key === 'gpu' && poolTotal === 0 && clusterEnabled;
    const capped = hasPool && Number.isFinite(poolTotal) && !leasedGpu;
    if (capped && total > poolTotal) {
      return { needs: {}, error: `needs ${key}=${total} exceeds pool` };
    }
    needs[key] = total;
  }
  return { needs, error: null };
}
