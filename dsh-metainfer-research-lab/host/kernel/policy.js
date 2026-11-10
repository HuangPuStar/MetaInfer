/**
 * Kernel policy: the single source of truth for "who may do what".
 *
 * Two surfaces share this module so they cannot drift:
 *   1. the agent tool (`metainfer_lab`): a per-preset action allowlist. This is
 *      the fix for docs/issues/0001-agent-tool-scope-drift.md — a worker or an
 *      advisor that calls `start_node` / `delete_project` / `auto_stop` gets
 *      `forbidden_action`, not the full 49-action surface.
 *   2. dispatch: experts may propose, never dispatch (G4); only the dispatcher,
 *      the system and a human may take the commit point.
 *
 * The actor is derived from the DSH session (`exec.agent.session.header.meta.
 * agentPreset`), never from model-supplied arguments: a model cannot promote
 * itself by writing `preset: "standard"` into the tool call.
 *
 * Pure functions only; no I/O.
 */

/** Coarse capability of every action. Used by policy tables and by the UI. */
export const ACTION_CATALOG = Object.freeze({
  // read
  projects: 'read',
  status: 'read',
  state: 'read',
  models: 'read',
  cluster: 'read',
  cluster_config: 'read',
  validate_model: 'read',
  node_files: 'read',
  transcript: 'read',
  runs: 'read',
  run: 'read',
  replay: 'read',
  auto_status: 'read',
  health: 'read',
  dag_map: 'read',
  dag_query: 'read',
  dag_walk: 'read',
  dag_get: 'read',
  dag_diff: 'read',
  ledger_read: 'read',
  experts_list: 'read',
  intent_list: 'read',
  review_claims: 'read',
  // project / node writes
  create_project: 'write',
  update_project: 'write',
  update_node: 'write',
  successor: 'write',
  create_merge: 'write',
  finish_merge: 'write',
  approve_node: 'write',
  reject_node: 'write',
  push_project: 'write',
  compile_placement: 'write',
  chat: 'write',
  clear_chat: 'write',
  copilot: 'write',
  ledger_update: 'write',
  intent_submit: 'write',
  claim_review: 'write',
  release_review: 'write',
  expert_upsert: 'write',
  curator_nominate: 'write',
  // control (runtime / driver)
  start_node: 'control',
  cancel_node: 'control',
  retry_node: 'control',
  escalate_node: 'control',
  message_node: 'control',
  step: 'control',
  dispatch_once: 'control',
  curator_scan: 'control',
  auto_start: 'control',
  auto_stop: 'control',
  auto_resume: 'control',
  dashboard_update: 'control',
  dashboard_refresh: 'control',
  dashboard_chat: 'control',
  dashboard_layout: 'control',
  // destructive / cross-project
  delete_project: 'danger',
  cluster_config_update: 'danger',
  // intake
  intake_read: 'read',
  intake_patch: 'write',
  intake_ready: 'write',
  intake_start: 'write',
  intake_message: 'write',
  intake_confirm: 'write',
  intake_discard: 'write',
});

/** All action ids, sorted for stable schemas and error messages. */
export const ALL_ACTIONS = Object.freeze(Object.keys(ACTION_CATALOG).sort());

const READ = ALL_ACTIONS.filter((action) => ACTION_CATALOG[action] === 'read');
const DAG = Object.freeze(['dag_map', 'dag_query', 'dag_walk', 'dag_get', 'dag_diff', 'ledger_read']);
const EXPERT_PROPOSE = Object.freeze(['intent_submit', 'claim_review', 'release_review', 'review_claims']);

/**
 * Preset -> allowlist. A preset missing from this table is an operator/human
 * surface (the main session, the controller root) and keeps the full surface;
 * that is intentional, but every role that can run arbitrary model output is
 * listed explicitly so the default is never "accidentally full".
 */
export const PRESET_POLICIES = Object.freeze({
  'lab-worker': Object.freeze({
    kind: 'worker',
    allowed: Object.freeze([...READ, ...DAG]),
    note: 'workers read state and navigate the DAG; they never change the lab',
  }),
  'lab-advisor': Object.freeze({
    kind: 'expert',
    allowed: Object.freeze([...READ, ...DAG, ...EXPERT_PROPOSE, 'ledger_update']),
    note: 'experts propose through intents and the ledger; they never start, cancel or delete',
  }),
  'lab-reviewer': Object.freeze({
    kind: 'expert',
    allowed: Object.freeze([...READ, ...DAG, ...EXPERT_PROPOSE, 'ledger_update']),
    note: 'reviewers propose through intents and the ledger',
  }),
  'lab-curator': Object.freeze({
    kind: 'expert',
    allowed: Object.freeze([...READ, ...DAG, ...EXPERT_PROPOSE, 'curator_scan']),
    note: 'the curator may only nominate; Host applies any close',
  }),
  'lab-chief': Object.freeze({
    kind: 'expert',
    allowed: Object.freeze([...READ, ...DAG, ...EXPERT_PROPOSE, 'ledger_update', 'curator_scan', 'approve_node', 'reject_node']),
    note: 'the chief arbitrates proposals; it cannot start or cancel runs',
  }),
  'lab-scheduler': Object.freeze({
    kind: 'system',
    allowed: Object.freeze([...READ, ...DAG]),
    note: 'ordering is deterministic code; the scheduler prompt is a planning aid',
  }),
  'lab-gc': Object.freeze({
    kind: 'system',
    allowed: Object.freeze([...READ, 'node_files', 'transcript']),
    note: 'post-mortem reads only',
  }),
  'lab-intake': Object.freeze({
    kind: 'system',
    allowed: Object.freeze(['projects', 'intake_read', 'intake_patch', 'intake_ready', 'intake_start', 'intake_message', 'intake_confirm', 'intake_discard', 'dag_map', 'dag_query']),
    note: 'the intake session may only edit its own draft',
  }),
  'lab-controller': Object.freeze({
    kind: 'system',
    allowed: Object.freeze([...READ, ...DAG]),
    note: 'the controller root belongs to the UI; it hosts sessions instead of acting',
  }),
});

/** Actor kinds used by the kernel. Mirrors executor's ACTOR_KINDS. */
export const ACTOR_KIND = Object.freeze({
  HUMAN: 'human',
  EXPERT: 'expert',
  DISPATCHER: 'dispatcher',
  MCP: 'mcp',
  SYSTEM: 'system',
  LEGACY: 'legacy',
});

/**
 * Build the immutable actor identity of one DSH session.
 * @param {{agentPreset?: string, sessionId?: string, kind?: string}} input
 */
export function actorForSession(input = {}) {
  const preset = typeof input.agentPreset === 'string' && input.agentPreset ? input.agentPreset : null;
  const policy = preset ? PRESET_POLICIES[preset] : null;
  const kind = input.kind ?? (policy?.kind === 'expert' ? ACTOR_KIND.EXPERT : (policy ? ACTOR_KIND.SYSTEM : ACTOR_KIND.HUMAN));
  return Object.freeze({
    kind,
    id: typeof input.sessionId === 'string' && input.sessionId ? input.sessionId : (preset ?? 'human'),
    preset,
  });
}

/**
 * Extract the actor from a DSH tool execution. The session header is the only
 * trusted source of the preset; `exec` may be absent in offline tests.
 * @param {object} exec ToolRunContext
 */
export function actorFromToolExecution(exec) {
  const session = exec?.agent?.session;
  const meta = session?.header?.meta ?? session?.meta ?? null;
  return actorForSession({
    agentPreset: meta?.agentPreset,
    sessionId: typeof session?.id === 'string' ? session.id : undefined,
  });
}

/** @returns {boolean} whether the action names a known action. */
export function isKnownAction(action) {
  return Object.prototype.hasOwnProperty.call(ACTION_CATALOG, action);
}

/** @returns {string[]} the actions this actor may call, sorted. */
export function allowedActions(actor) {
  const preset = actor?.preset;
  const policy = preset ? PRESET_POLICIES[preset] : null;
  if (!policy) return ALL_ACTIONS;
  return [...policy.allowed].sort();
}

/**
 * Authorize one agent-tool action.
 * @param {{kind: string, id: string, preset?: string|null}} actor
 * @param {string} action
 * @returns {{ok: true} | {ok: false, code: string, message: string, allowed: string[]}}
 */
export function authorizeAction(actor, action) {
  const allowed = allowedActions(actor);
  if (!isKnownAction(action)) {
    return { ok: false, code: 'unknown_action', message: `unknown action "${String(action)}"`, allowed };
  }
  if (!allowed.includes(action)) {
    return {
      ok: false,
      code: 'forbidden_action',
      message: `action "${action}" is not available to ${actor?.preset ? `preset ${actor.preset}` : 'this actor'}; allowed actions: ${allowed.join(', ')}`,
      allowed,
    };
  }
  return { ok: true };
}

/**
 * Dispatch authorization (G4: experts only propose). The envelope calls this
 * before taking the commit point.
 * @param {object} actor
 * @param {string} action `dispatch.start` | `dispatch.preempt` | `dispatch.release` | `dispatch.defer`
 * @param {object} [target]
 */
export function authorizeDispatch(actor, action, target = {}) {
  const kind = actor?.kind;
  if (kind === ACTOR_KIND.EXPERT) {
    return { ok: false, code: 'forbidden_dispatch', message: 'experts may propose but never dispatch (G4)' };
  }
  if (action === 'dispatch.start') {
    if (kind !== ACTOR_KIND.DISPATCHER && kind !== ACTOR_KIND.SYSTEM && kind !== ACTOR_KIND.HUMAN) {
      return { ok: false, code: 'forbidden_dispatch', message: `actor kind ${kind} may not start nodes` };
    }
    const node = target?.node;
    if (node && node.status !== 'planned') {
      return { ok: false, code: 'not_runnable', message: `node is ${node.status}` };
    }
    return { ok: true };
  }
  if (action === 'dispatch.preempt') {
    return kind === ACTOR_KIND.HUMAN || kind === ACTOR_KIND.SYSTEM
      ? { ok: true }
      : { ok: false, code: 'forbidden_dispatch', message: 'preemption requires a human or system actor' };
  }
  if (action === 'dispatch.release' || action === 'dispatch.defer') {
    return kind === ACTOR_KIND.DISPATCHER || kind === ACTOR_KIND.SYSTEM
      ? { ok: true }
      : { ok: false, code: 'forbidden_dispatch', message: 'only the dispatcher manages holds and leases' };
  }
  return { ok: false, code: 'forbidden_dispatch', message: `unknown dispatch action ${String(action)}` };
}

/** The object the dispatch envelope expects. */
export const DISPATCH_POLICY = Object.freeze({ authorize: authorizeDispatch });
