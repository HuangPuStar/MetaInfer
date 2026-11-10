#!/usr/bin/env node
/**
 * Round 20: one credential rule for the whole HTTP surface.
 *
 * The exported ROUTE_POLICY table is the reviewable method+path inventory.
 * This probe registers the real Host route wrapper with a recording service,
 * then drives every policy row:
 *   - read-only: no token, handler runs;
 *   - operator-token: absent and forged tokens are actor_required; the real
 *     Host-issued token reaches the handler exactly once;
 *   - refused: neither a missing nor a valid token can reach the handler.
 *
 * The stub records calls, so a successful envelope cannot come from a cached
 * response or from a body-supplied actor.
 */
import assert from 'node:assert/strict';
import { registerHttpRoutes, ROUTE_POLICY } from '../host/http.js';
import { createOperatorAuthority } from '../host/operator-token.js';

let failed = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`ok   ${name}`);
  else { failed += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const PREFIX = '/api/metainfer-research-lab';
const authority = createOperatorAuthority();
const calls = [];
const service = new Proxy({ verifyOperatorToken: (token) => authority.verify(token) }, {
  get(target, property) {
    if (property === 'verifyOperatorToken') return target.verifyOperatorToken;
    if (property === 'then') return undefined;
    return (...args) => {
      calls.push({ method: String(property), args });
      return Promise.resolve({ stub: String(property) });
    };
  },
});

const routes = new Map();
const registrations = [];
const dispose = registerHttpRoutes({
  effect: () => {},
  connection: {
    fetch: {
      register({ path, methods, fetch }) {
        registrations.push({ path, methods });
        for (const method of methods) routes.set(`${method} ${path}`, fetch);
        return () => {};
      },
    },
  },
}, service);

const request = async (entry, { token = null, body } = {}) => {
  const handler = routes.get(`${entry.method} ${entry.path}`);
  assert.ok(handler, `registered handler for ${entry.method} ${entry.path}`);
  const headers = { accept: 'application/json' };
  if (token !== null) headers['x-metainfer-operator'] = token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await handler(new Request('http://local' + entry.path, {
    method: entry.method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return response.json();
};

const tokenBody = (entry) => {
  if (entry.path.endsWith('/commands')) return { type: 'project.update', projectId: 'p' };
  if (entry.method === 'GET') return undefined;
  return {};
};

check('the policy table has exactly 48 unique method+path rows',
  ROUTE_POLICY.length === 48 && new Set(ROUTE_POLICY.map((row) => `${row.method} ${row.path}`)).size === 48,
  JSON.stringify({ rows: ROUTE_POLICY.length }));

const registeredPairs = registrations.flatMap((row) => row.methods.map((method) => `${method} ${row.path}`)).sort();
const policyPairs = ROUTE_POLICY.map((row) => `${row.method} ${row.path}`).sort();
check('every registered method+path pair is declared, and every declaration is registered',
  JSON.stringify(registeredPairs) === JSON.stringify(policyPairs),
  JSON.stringify({ registered: registeredPairs, declared: policyPairs }));

let tokenRows = 0;
let readRows = 0;
let refusedRows = 0;
for (const entry of ROUTE_POLICY) {
  const key = `${entry.method} ${entry.path}`;
  if (entry.policy === 'read-only') {
    readRows += 1;
    const before = calls.length;
    const payload = await request(entry);
    check(`read-only ${key} is never token-gated`,
      payload.ok === true || payload.error?.code !== 'actor_required',
      JSON.stringify(payload));
    continue;
  }
  if (entry.policy === 'refused') {
    refusedRows += 1;
    const before = calls.length;
    const absent = await request(entry);
    const withToken = await request(entry, { token: authority.token });
    check(`refused ${key} is not callable with or without a token`,
      absent.ok === false && absent.error?.code === 'forbidden_action'
      && withToken.ok === false && withToken.error?.code === 'forbidden_action'
      && calls.length === before,
      JSON.stringify({ absent, withToken, calls: calls.length - before }));
    continue;
  }
  if (entry.policy !== 'operator-token') {
    check(`unknown policy for ${key}`, false, entry.policy);
    continue;
  }
  tokenRows += 1;
  const before = calls.length;
  const absent = await request(entry, { body: tokenBody(entry) });
  const forged = await request(entry, { token: authority.token.replace(/.$/, (char) => (char === 'A' ? 'B' : 'A')), body: tokenBody(entry) });
  check(`operator-token ${key} rejects an absent token before the handler`,
    absent.ok === false && absent.error?.code === 'actor_required' && calls.length === before,
    JSON.stringify(absent));
  check(`operator-token ${key} rejects a forged token before the handler`,
    forged.ok === false && forged.error?.code === 'actor_required' && calls.length === before,
    JSON.stringify(forged));
  const accepted = await request(entry, { token: authority.token, body: tokenBody(entry) });
  check(`operator-token ${key} accepts the Host token and reaches the handler exactly once`,
    accepted.ok === true && calls.length === before + 1,
    JSON.stringify({ accepted, calls: calls.length - before }));
}

check('the inventory actually includes every policy kind',
  tokenRows > 0 && readRows > 0 && refusedRows === 1,
  JSON.stringify({ tokenRows, readRows, refusedRows }));

// Body-supplied actors are data, not credentials: the same forged actor body
// still returns actor_required without a token, and the accepted token call
// resolves the human actor from the token rather than from the body.
const appeal = ROUTE_POLICY.find((row) => row.path.endsWith('/preemption/appeal'));
const bodyActor = { actor: { kind: 'human', id: 'body-attacker' }, actorKey: 'ak_host_FORGED', reason: 'probe' };
const bodyNoToken = await request(appeal, { body: bodyActor });
check('a body actor still does not authenticate /preemption/appeal',
  bodyNoToken.ok === false && bodyNoToken.error?.code === 'actor_required',
  JSON.stringify(bodyNoToken));
const bodyWithToken = await request(appeal, { token: authority.token, body: bodyActor });
const appealCall = calls[calls.length - 1];
check('the accepted /preemption/appeal handler receives only the token actor, never the body actor',
  bodyWithToken.ok === true && appealCall?.method === 'appealPreemption'
  && typeof appealCall.args[3]?.id === 'string' && appealCall.args[3].id !== 'body-attacker',
  JSON.stringify({ envelope: bodyWithToken, call: appealCall }));

dispose();
if (failed > 0) {
  console.error(`operator-route-selftest: ${failed} check(s) failed`);
  process.exit(1);
}
console.log(`operator-route-selftest: all checks passed (${ROUTE_POLICY.length} route pairs)`);
