/**
 * Policy self-test: the preset allowlist is a security boundary, so it is
 * regression-guarded per preset (B1) and checked against the real tool enum (B15).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACTION_CATALOG,
  ALL_ACTIONS,
  DEFAULT_PRESET_ACTIONS,
  PRESET_POLICIES,
  actorForSession,
  allowedActions,
  authorizeAction,
} from '../host/kernel/policy.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`ok   ${name}`);
  else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const presetsSource = readFileSync(path.join(ROOT, 'presets.patch.yml'), 'utf8');
const declared = [...presetsSource.matchAll(/^ {8}id: (lab-[a-z-]+)$/gm)].map((m) => m[1]);
check('presets.patch.yml declares the expected roles', declared.length >= 9, declared.join(','));

// 1. Every declared preset has an explicit policy — no preset inherits the full surface.
for (const preset of declared) {
  check(`${preset} has an explicit policy`, Object.hasOwn(PRESET_POLICIES, preset));
}
// The reviewer/curator/chief policies are agent roles the Host mounts per
// session; they are intentionally not selectable presets in presets.patch.yml.
check('every PRESET_POLICIES key is a lab role with a note', Object.entries(PRESET_POLICIES).every(([id, policy]) => id.startsWith('lab-') && typeof policy.note === 'string' && policy.note.length > 0));
check('policy table has no stale non-lab key', Object.keys(PRESET_POLICIES).every((id) => id.startsWith('lab-')));

// 2. No preset can destroy, start or cancel work.
const DANGEROUS = ['delete_project', 'start_node', 'cancel_node', 'cluster_config_update', 'auto_start', 'auto_stop'];
for (const preset of Object.keys(PRESET_POLICIES)) {
  const allowed = allowedActions({ preset });
  const leaked = DANGEROUS.filter((action) => allowed.includes(action));
  check(`${preset} cannot run dangerous actions`, leaked.length === 0, leaked.join(','));
  const unknown = allowed.filter((action) => !ALL_ACTIONS.includes(action));
  check(`${preset} allowlist names only real actions`, unknown.length === 0, unknown.join(','));
  check(`${preset} allowlist has no duplicate actions`, new Set(allowed).size === allowed.length, allowed.join(','));
}

// 3. The reported hole: lab-chat deleting a project.
for (const action of ['delete_project', 'start_node', 'cancel_node', 'auto_stop']) {
  const decision = authorizeAction(actorForSession({ agentPreset: 'lab-chat', sessionId: 's-chat' }), action);
  check(`lab-chat is denied ${action}`, decision.ok === false && decision.code === 'forbidden_action', JSON.stringify(decision));
}
check('lab-chat may edit a planned node', authorizeAction(actorForSession({ agentPreset: 'lab-chat', sessionId: 's-chat' }), 'update_node').ok === true);
check('lab-chat may explain a node', authorizeAction(actorForSession({ agentPreset: 'lab-chat', sessionId: 's-chat' }), 'explain_node').ok === true);

// 4. Every other preset gets a minimal, explicit decision on the same probes.
const probes = {
  'lab-worker': ['start_node', 'delete_project'],
  'lab-advisor': ['start_node', 'delete_project', 'approve_node'],
  'lab-reviewer': ['start_node', 'delete_project'],
  'lab-curator': ['start_node', 'delete_project'],
  'lab-chief': ['start_node', 'delete_project', 'cancel_node'],
  'lab-scheduler': ['start_node', 'delete_project', 'auto_start'],
  'lab-gc': ['delete_project', 'start_node'],
  'lab-intake': ['delete_project', 'start_node'],
  'lab-controller': ['start_node', 'delete_project'],
  'lab-merge': ['approve_node', 'delete_project', 'start_node'],
  'lab-dashboard': ['create_project', 'delete_project', 'update_node'],
};
for (const [preset, actions] of Object.entries(probes)) {
  for (const action of actions) {
    const decision = authorizeAction(actorForSession({ agentPreset: preset, sessionId: 's' }), action);
    check(`${preset} is denied ${action}`, decision.ok === false && decision.code === 'forbidden_action', JSON.stringify(decision));
  }
}

// 5. Default-deny: an unlisted preset never falls back to the global list.
const rogue = actorForSession({ agentPreset: 'lab-rogue', sessionId: 's-rogue' });
check('unknown preset gets the smallest safe set', JSON.stringify(allowedActions(rogue)) === JSON.stringify([...DEFAULT_PRESET_ACTIONS].sort()));
check('unknown preset is not actor kind human', rogue.kind !== 'human', rogue.kind);
check('unknown preset cannot delete a project', authorizeAction(rogue, 'delete_project').code === 'forbidden_action');
check('unknown preset can still read the DAG', authorizeAction(rogue, 'dag_query').ok === true);
check('the human/operator session keeps the full surface', allowedActions({}) .length === ALL_ACTIONS.length);

// 6. Enum <-> catalog <-> handler parity (B15/S11): no advertised-but-missing action.
const toolSource = readFileSync(path.join(ROOT, 'host/agent-tool.js'), 'utf8');
const enumBody = /const ACTION_ENUM = \[([\s\S]*?)\];/.exec(toolSource)?.[1] ?? '';
const enumActions = [...enumBody.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
const serviceSource = readFileSync(path.join(ROOT, 'host/lab-service.js'), 'utf8');
const handled = new Set([...serviceSource.matchAll(/action === '([a-z_]+)'/g)].map((m) => m[1]));
check('tool enum matches the policy catalog', enumActions.length === Object.keys(ACTION_CATALOG).length
  && enumActions.every((action) => Object.hasOwn(ACTION_CATALOG, action))
  && Object.keys(ACTION_CATALOG).every((action) => enumActions.includes(action)));
const unhandled = enumActions.filter((action) => !handled.has(action));
check('every advertised action has a handler', unhandled.length === 0, unhandled.join(','));
check('get_node is a known action', Object.hasOwn(ACTION_CATALOG, 'get_node'));
check('dashboard_get is a known action', Object.hasOwn(ACTION_CATALOG, 'dashboard_get'));

console.log(`\n${failed === 0 ? 'policy-selftest: all checks passed' : `policy-selftest: ${failed} failed`}`);
process.exit(failed === 0 ? 0 : 1);
