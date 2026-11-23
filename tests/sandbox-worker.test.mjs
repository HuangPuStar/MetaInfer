import test from 'node:test';
import assert from 'node:assert/strict';
import { createSandboxWorkerPolicy, SANDBOX_PRESET, SANDBOX_TOOL } from '../host/sandbox-worker.js';

function fixture(extra = {}) {
  const project = { id: 'p' };
  let node = { id: 'n', projectId: 'p', rev: 4, status: 'running', currentAttempt: 1, sessionId: 'worker', execution: { driver: 'dsh', sandboxProfile: 'pclab19' }, sandbox: { bindingId: 'b', profile: 'pclab19', attempt: 1, sessionId: 'worker', state: 'ready', verifiedClean: false, operations: {} } };
  const hooks = new Map(), tools = new Map(), calls = [], writes = [];
  let guard;
  const agent = { id: 'worker', session: { header: { agentPreset: SANDBOX_PRESET } }, ctx: { tools: {
    restrict(value) { calls.push(['restrict', value]); }, guard(value) { guard = value; },
    schemas() { return [{ name: SANDBOX_TOOL }, { name: 'structured_output' }, { name: 'run_code' }]; },
  } } };
  const ctx = { on(name, fn) { hooks.set(name, fn); return () => hooks.delete(name); }, tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } } };
  const backend = { async execute(p, n, args) { calls.push(['execute', p.id, n.id, args]); return { exitCode: 0, success: true }; } };
  const policy = createSandboxWorkerPolicy({ ctx, backend, readOwner(id) { return id === node.sessionId ? { project: structuredClone(project), node: structuredClone(node) } : null; },
    async commitBinding(change) { writes.push(change); if (extra.wait) await extra.wait; assert.equal(change.expected.nodeRev, node.rev); node = { ...node, rev: node.rev + 1, sandbox: structuredClone(change.binding) }; }, clock: () => 123,
  });
  return { policy, agent, calls, writes, tools, hooks, get node() { return node; }, set node(value) { node = value; },
    created() { return hooks.get('agent/created')({ agent }); }, check(name = SANDBOX_TOOL, caller = agent) { return guard?.({ name, agent: caller }); },
    async exec(args = { operation: 'exec', command: 'true' }, caller = agent) { return JSON.parse((await tools.get(SANDBOX_TOOL).execute(args, { agent: caller })).result); },
  };
}

test('policy is durable before first authorized tool and uses one node-scoped backend', async () => {
  const f = fixture(); await f.created(); assert.equal(f.writes.length, 1); assert.equal(f.writes[0].expected.nodeRev, 4);
  assert.equal(f.node.sandbox.toolBoundary.preset, SANDBOX_PRESET); assert.deepEqual(f.node.sandbox.toolBoundary.visibleTools, [SANDBOX_TOOL, 'run_code', 'structured_output'].sort());
  assert.equal(f.check(), undefined); assert.ok(f.check('ssh_exec')); assert.ok(f.check('run_code', { id: 'worker' }));
  assert.equal((await f.exec()).ok, true); assert.equal(f.calls.filter(c => c[0] === 'execute').length, 1); await f.policy.dispose();
});
test('same session id does not authorize a different Agent object', async () => { const f = fixture(); await f.created(); assert.equal((await f.exec(undefined, { id: 'worker' })).ok, false); });
test('stale attempt, profile and binding fail closed', async () => {
  for (const mutate of [n => n.currentAttempt++, n => n.sandbox.profile = 'pclab27', n => n.sandbox.bindingId = 'other', n => n.status = 'cancelled']) {
    const f = fixture(); await f.created(); const n = structuredClone(f.node); mutate(n); f.node = n; assert.ok(f.check()); assert.equal((await f.exec()).ok, false);
  }
});
test('forbidden target selectors and unbounded reads never reach backend', async () => {
  const f = fixture(); await f.created();
  for (const args of [{ operation: 'exec', command: 'true', bindingId: 'other' }, { operation: 'read', path: 'x', maxBytes: 1048577 }, { operation: 'exec', command: 'true', cwd: '/' }]) assert.equal((await f.exec(args)).ok, false);
  assert.equal(f.calls.filter(c => c[0] === 'execute').length, 0);
});
test('wrong preset and unexpected inherited tool block first turn', async () => {
  const f = fixture(); f.agent.session.header.agentPreset = 'lab-worker'; await assert.rejects(f.created(), /preset/i); assert.equal(f.writes.length, 0);
  const g = fixture(); g.agent.ctx.tools.schemas = () => [{ name: SANDBOX_TOOL }, { name: 'bash' }]; await assert.rejects(g.created(), /tool/i); assert.equal(g.writes.length, 0);
});
test('cannot call sandbox tool until policy commit resolves', async () => {
  let resolve; const f = fixture({ wait: new Promise(r => { resolve = r; }) }); const creating = f.created(); await Promise.resolve();
  assert.equal((await f.exec()).ok, false); resolve(); await creating; assert.equal((await f.exec()).ok, true);
});
test('teardown never reopens surviving Agent tools', async () => {
  const f = fixture(); await f.created(); await f.policy.dispose(); assert.ok(f.check()); assert.equal(f.tools.has(SANDBOX_TOOL), false);
});
