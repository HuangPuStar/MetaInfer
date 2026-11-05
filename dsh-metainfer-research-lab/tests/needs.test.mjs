/**
 * Unit tests for the shared `node.needs` normalizer.
 *
 * The normalizer exists because `node.successor` used to be validated by the advisor's
 * array-only parser while the Web UI sends a map, so every "添加后继" submission failed
 * with `needs must be an array of {key, amount}` (upstream issue #49). These tests pin the
 * unified rule set: both wire shapes are accepted, the stored shape is always the map, and
 * invalid input is rejected consistently for every call site.
 *
 * Run with: `node --test tests/` (or `npm test`).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { RESOURCE_KEY_PATTERN, normalizeNeeds } from '../host/needs.js';

const project = (pools) => ({ config: { resourcePools: pools } });

// ---------------------------------------------------------------------------
// Shape handling: map (UI/HTTP/MCP/agent tool) and array (advisor proposals)
// ---------------------------------------------------------------------------

test('undefined / null needs normalize to an empty map', () => {
  assert.deepEqual(normalizeNeeds(undefined, project({ gpu: 2 })), { needs: {}, error: null });
  assert.deepEqual(normalizeNeeds(null, project({ gpu: 2 })), { needs: {}, error: null });
});

test('UI payload: empty map is accepted (regression for #49)', () => {
  // The successor dialog always sends `needs`, at minimum `{}`.
  assert.deepEqual(normalizeNeeds({}, project({ gpu: 2 })), { needs: {}, error: null });
});

test('UI payload: canonical map is accepted (regression for #49)', () => {
  assert.deepEqual(normalizeNeeds({ gpu: 2 }, project({ gpu: 2 })), { needs: { gpu: 2 }, error: null });
  assert.deepEqual(
    normalizeNeeds({ gpu: 2, machines: 2 }, project({ gpu: 4 })),
    { needs: { gpu: 2, machines: 2 }, error: null },
  );
});

test('advisor payload: array of {key, amount} still works', () => {
  assert.deepEqual(
    normalizeNeeds([{ key: 'gpu', amount: 1 }], project({ gpu: 2 })),
    { needs: { gpu: 1 }, error: null },
  );
  assert.deepEqual(normalizeNeeds([], project({ gpu: 2 })), { needs: {}, error: null });
});

test('bad shapes are rejected with a message naming both accepted forms', () => {
  for (const raw of ['gpu=2', 2, true, [{ key: 'gpu' }, null]]) {
    const result = normalizeNeeds(raw, project({ gpu: 2 }));
    assert.deepEqual(result.needs, {});
    assert.match(result.error, /needs must be an object like .* or an array of \{key, amount\}/);
  }
});

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

test('string amounts from form-like callers are coerced', () => {
  assert.deepEqual(normalizeNeeds({ gpu: '1' }, project({ gpu: 2 })), { needs: { gpu: 1 }, error: null });
  assert.deepEqual(
    normalizeNeeds([{ key: 'gpu', amount: '2' }], project({ gpu: 2 })),
    { needs: { gpu: 2 }, error: null },
  );
});

test('non-numeric amounts are rejected instead of coerced (review: needs.js:59)', () => {
  // `Number()` would turn these into 1, 2 and 0 respectively; `null` must not silently
  // drop the requirement either.
  for (const value of [true, false, null, [2], 'two', '', ' ', '1.5', 1.5, -1, Infinity, NaN, {}]) {
    const result = normalizeNeeds({ gpu: value }, project({ gpu: 2 }));
    assert.deepEqual(result.needs, {}, `value ${String(value)} must not normalize`);
    assert.match(result.error, /resource "gpu" must be a non-negative integer/);
  }
});

test('amounts above 64 are allowed when the pool allows them (review: needs.js:60)', () => {
  // The previous 0..64 cap rejected valid requests such as cpu=96 on a cpu=128 pool.
  assert.deepEqual(
    normalizeNeeds({ cpu: 96 }, project({ cpu: 128 })),
    { needs: { cpu: 96 }, error: null },
  );
  assert.match(normalizeNeeds({ cpu: 129 }, project({ cpu: 128 })).error, /needs cpu=129 exceeds pool/);
});

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

test('resource-key pattern is lowercase and shared with the pool validator', () => {
  // `runtime`/`auto` read `needs.gpu` by literal name, so an uppercase key would bypass
  // the GPU lease path; `normalizeResourcePools` imports this same pattern.
  assert.ok(RESOURCE_KEY_PATTERN.test('gpu'));
  assert.ok(RESOURCE_KEY_PATTERN.test('machines'));
  assert.ok(RESOURCE_KEY_PATTERN.test('cpu_2'));
  assert.ok(!RESOURCE_KEY_PATTERN.test('GPU'));
  assert.ok(!RESOURCE_KEY_PATTERN.test('__proto__'));

  for (const key of ['GPU', 'gpu!', '', 'a'.repeat(33), '__proto__']) {
    const result = normalizeNeeds({ [key]: 1 }, project({ gpu: 2 }));
    assert.match(result.error, /invalid resource name|needs must be an object like/);
  }
});

test('prototype keys are not treated as pool members (review: needs.js:70)', () => {
  // `constructor` matches the key pattern and `'constructor' in {}` is true; only an
  // own-property check keeps it from being accepted and string-concatenated into `needs`.
  const result = normalizeNeeds({ constructor: 1 }, project({ gpu: 2 }));
  assert.deepEqual(result.needs, {});
  assert.match(result.error, /unknown resource: constructor/);

  // A JSON payload can carry a real own `__proto__` key; it must not pollute anything.
  const parsed = JSON.parse('{"__proto__": 5}');
  assert.match(normalizeNeeds(parsed, project({ gpu: 2 })).error, /invalid resource name/);
  assert.equal({}.polluted, undefined);

  assert.match(normalizeNeeds({ toString: 1 }, project({ gpu: 2 })).error, /invalid resource name: toString/);
});

test('unknown pool keys are rejected', () => {
  assert.match(normalizeNeeds({ tpu: 1 }, project({ gpu: 2 })).error, /unknown resource: tpu/);
  assert.match(normalizeNeeds({ cpu: 1 }, project({})).error, /unknown resource: cpu/);
});

// ---------------------------------------------------------------------------
// Pool rules, including the cluster-mode GPU exception
// ---------------------------------------------------------------------------

test('over-pool amounts are rejected', () => {
  assert.match(normalizeNeeds({ gpu: 3 }, project({ gpu: 2 })).error, /needs gpu=3 exceeds pool/);
  assert.match(normalizeNeeds({ cpu: 3 }, project({ cpu: 2 })).error, /needs cpu=3 exceeds pool/);
});

test('gpu may be requested without a pool only when the cluster coordinator is on', () => {
  // runtime.js skips `ensureCapacity` for leased GPU nodes and only enforces
  // `resourcePools.gpu` when it is a non-zero quota, so this payload is startable in
  // cluster mode. Without the coordinator it could never start, so it is rejected early.
  const cluster = { clusterEnabled: true };
  assert.deepEqual(normalizeNeeds({ gpu: 4 }, project({}), cluster), { needs: { gpu: 4 }, error: null });
  assert.deepEqual(
    normalizeNeeds({ gpu: 4, machines: 2 }, project({}), cluster),
    { needs: { gpu: 4, machines: 2 }, error: null },
  );
  assert.match(normalizeNeeds({ gpu: 4 }, project({})).error, /unknown resource: gpu .*cluster coordinator/);
  // Other resources are only ever counted locally, so they still need a pool.
  assert.match(normalizeNeeds({ cpu: 4 }, project({}), cluster).error, /unknown resource: cpu/);
});

test('a gpu pool of 0 means "no local quota" only for leased nodes', () => {
  assert.deepEqual(
    normalizeNeeds({ gpu: 4 }, project({ gpu: 0 }), { clusterEnabled: true }),
    { needs: { gpu: 4 }, error: null },
  );
  // Without the coordinator the runtime counts against the (zero) pool, so the node could
  // never start: reject it here, as the previous normalizer did.
  assert.match(normalizeNeeds({ gpu: 4 }, project({ gpu: 0 })).error, /needs gpu=4 exceeds pool/);
  // A non-zero gpu pool is the per-project quota and is still enforced.
  assert.match(
    normalizeNeeds({ gpu: 4 }, project({ gpu: 2 }), { clusterEnabled: true }).error,
    /needs gpu=4 exceeds pool/,
  );
  // Every other resource is a hard local limit, including an explicit 0.
  assert.match(normalizeNeeds({ cpu: 1 }, project({ cpu: 0 })).error, /needs cpu=1 exceeds pool/);
});

// ---------------------------------------------------------------------------
// machines placement hint
// ---------------------------------------------------------------------------

test('machines is a placement hint bounded by 1..8', () => {
  assert.deepEqual(normalizeNeeds({ machines: 2 }, project({})), { needs: { machines: 2 }, error: null });
  assert.match(normalizeNeeds({ machines: 9 }, project({})).error, /needs\[machines\] must be 1\.\.8/);
});

// ---------------------------------------------------------------------------
// Zero handling and duplicates
// ---------------------------------------------------------------------------

test('zero entries are dropped only after their key was validated (review: needs.js:62)', () => {
  assert.deepEqual(normalizeNeeds({ gpu: 0 }, project({ gpu: 2 })), { needs: {}, error: null });
  assert.deepEqual(normalizeNeeds([], project({ gpu: 2 })), { needs: {}, error: null });
  assert.match(normalizeNeeds({ tpu: 0 }, project({ gpu: 2 })).error, /unknown resource: tpu/);
  assert.match(normalizeNeeds({ machines: 0 }, project({})).error, /needs\[machines\] must be 1\.\.8/);
});

test('duplicate entries accumulate and the accumulated total is checked (review: tests:46)', () => {
  assert.deepEqual(
    normalizeNeeds([{ key: 'gpu', amount: 1 }, { key: 'gpu', amount: 1 }], project({ gpu: 2 })),
    { needs: { gpu: 2 }, error: null },
  );
  // Two 2s on a 2-GPU pool must not pass just because each entry fits on its own.
  const result = normalizeNeeds([{ key: 'gpu', amount: 2 }, { key: 'gpu', amount: 2 }], project({ gpu: 2 }));
  assert.deepEqual(result.needs, {});
  assert.match(result.error, /needs gpu=4 exceeds pool/);
});
