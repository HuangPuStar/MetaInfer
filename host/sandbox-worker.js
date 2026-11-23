/** Sandbox computation belongs to a bound container; the DSH reasoning Agent stays on Host. */
import { isSandboxProfile } from './sandbox-targets.js';
export const SANDBOX_PRESET = 'lab-sandbox-worker-v2';
export const SANDBOX_TOOL = 'metainfer_sandbox';
const allowed = new Set([SANDBOX_TOOL, 'structured_output', 'run_code']);
const inputFields = new Set(['operation', 'command', 'timeoutMs', 'path', 'contentBase64', 'maxBytes']);

function requireSafe(value, message) { if (!value) { const error = new Error(message); error.code = 'sandbox_policy_denied'; throw error; } }
function scopeOf(project, node) {
  const b = node?.sandbox;
  requireSafe(project?.id && node?.id && node.status === 'running' && node.execution?.driver === 'dsh'
    && isSandboxProfile(node.execution.sandboxProfile) && b?.profile === node.execution.sandboxProfile
    && typeof b.bindingId === 'string' && b.bindingId.length > 0 && Number.isInteger(node.currentAttempt) && node.currentAttempt > 0 && b.state === 'ready' && b.verifiedClean === false && b.attempt === node.currentAttempt && b.sessionId === node.sessionId,
  'Sandbox tool has no current ready owner.');
  return { projectId: project.id, nodeId: node.id, attempt: node.currentAttempt, sessionId: node.sessionId, profile: b.profile, bindingId: b.bindingId };
}
const sameScope = (a, b) => Object.keys(a).every(key => a[key] === b[key]);

export function createSandboxWorkerPolicy({ ctx, readOwner, backend, commitBinding, clock = Date.now }) {
  requireSafe(typeof ctx.on === 'function' && typeof ctx.tools?.register === 'function', 'Sandbox policy requires Host pre-turn and tool registration APIs.');
  const authorized = new Map();
  let disposed = false;
  function current(agent, expected) {
    requireSafe(!disposed && agent && authorized.get(agent.id)?.agent === agent, 'Sandbox policy not installed for this Agent.');
    const owner = readOwner(agent.id);
    requireSafe(owner && owner.node.sessionId === agent.id && sameScope(expected, scopeOf(owner.project, owner.node)), 'Sandbox owner identity changed.');
    return owner;
  }
  const offTool = ctx.tools.register({
    name: SANDBOX_TOOL,
    description: 'Execute/read/write only this worker’s bound remote computation sandbox. No Host tool or target/cwd/binding selector. Nonzero exitCode and truncation are not success.',
    parameters: { type: 'object', properties: { operation: { type: 'string', enum: ['exec', 'read', 'write'] }, command: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 1000, maximum: 600000 }, path: { type: 'string' }, contentBase64: { type: 'string' }, maxBytes: { type: 'integer', minimum: 1, maximum: 1048576 } }, required: ['operation'], additionalProperties: false },
    output: { schema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'], additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: value.result }] },
    timeoutMs: 660000,
    async execute(args, call) {
      try {
        const policy = authorized.get(call?.agent?.id);
        requireSafe(policy, 'Sandbox policy is not installed.');
        const owner = current(call.agent, policy.scope);
        requireSafe(args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).every(key => inputFields.has(key)) && ['exec', 'read', 'write'].includes(args.operation), 'Invalid sandbox tool input/target selector.');
        requireSafe(args.maxBytes === undefined || (Number.isInteger(args.maxBytes) && args.maxBytes > 0 && args.maxBytes <= 1048576), 'Sandbox reads are bounded to 1 MiB.');
        requireSafe(Buffer.byteLength(JSON.stringify(args)) <= 3 * 1024 * 1024, 'Sandbox tool input exceeds 3 MiB.');
        const { operation, ...fields } = args;
        const data = await backend.execute(owner.project, owner.node, { ...fields, action: operation }, { signal: call.signal });
        current(call.agent, policy.scope);
        const result = JSON.stringify({ ok: true, data });
        requireSafe(Buffer.byteLength(result) <= 3 * 1024 * 1024, 'Sandbox tool output exceeds 3 MiB.');
        return { result };
      } catch (error) {
        return { result: JSON.stringify({ ok: false, error: { code: error.code ?? 'sandbox_tool_failed', message: String(error.message ?? error).slice(0, 1000) } }) };
      }
    },
  });
  const offCreated = ctx.on('agent/created', async ({ agent }) => {
    const owner = agent && readOwner(agent.id);
    const preset = agent?.session?.header?.agentPreset;
    if (!owner && preset !== SANDBOX_PRESET) return;
    requireSafe(!disposed && owner && preset === SANDBOX_PRESET, 'Sandbox worker requires its persona-only preset and unique node owner.');
    const scope = scopeOf(owner.project, owner.node);
    requireSafe(scope.sessionId === agent.id, 'Sandbox owner session does not match its Agent.');
    if (authorized.get(agent.id)?.agent === agent) return;
    const tools = agent.ctx?.tools;
    requireSafe(typeof tools?.restrict === 'function' && typeof tools.guard === 'function' && typeof tools.schemas === 'function', 'Scoped tool policy APIs unavailable.');
    tools.restrict({ allow: [SANDBOX_TOOL] });
    tools.guard(call => {
      try { requireSafe(allowed.has(call.name), 'Only sandbox/report/restricted transport tools permitted.'); current(call.agent, scope); return undefined; }
      catch (error) { return error.message; }
    });
    const visibleTools = tools.schemas(agent).map(row => row.name).sort();
    requireSafe(visibleTools.includes(SANDBOX_TOOL) && visibleTools.every(name => allowed.has(name)), 'Unexpected inherited or child-local tool remains visible.');
    const binding = structuredClone(owner.node.sandbox);
    binding.toolBoundary = { preset: SANDBOX_PRESET, agentId: agent.id, ...scope, installedAt: clock(), restrictAllow: [SANDBOX_TOOL], guardAllow: [...allowed], visibleTools };
    await commitBinding({ expected: { ...scope, nodeRev: owner.node.rev ?? 0 }, binding, event: 'node/sandbox_policy_installed' });
    const fresh = readOwner(agent.id);
    requireSafe(!disposed && fresh && sameScope(scope, scopeOf(fresh.project, fresh.node)), 'Sandbox owner changed while policy was being persisted.');
    authorized.set(agent.id, { agent, scope });
  });
  return { presetId: SANDBOX_PRESET, toolName: SANDBOX_TOOL, async dispose() { disposed = true; offCreated?.(); offTool?.(); authorized.clear(); } };
}
