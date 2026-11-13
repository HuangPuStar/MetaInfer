/**
 * Actionable errors (usability A4).
 *
 * Every rejected action must answer "what do I do next?", not just "it failed".
 * The UI never renders a stack trace; the agent tool returns the same envelope
 * as the HTTP layer: `{ok:false, error:{code,message,nextStep,retryable}}`.
 *
 * Unknown codes keep a generic next step instead of pretending to know.
 */

const NEXT_STEPS = Object.freeze({
  forbidden_action: 'This preset is not allowed to run that action. Ask a human operator (main session) to do it, or use a read-only action such as status_facts / dag_query.',
  forbidden_dispatch: 'Only the dispatcher or a human may start/stop work. Ask the operator to start the node, or use claim_review while it is under review.',
  unknown_action: 'Check the action name against the tool description; use `status` or `status_facts` to see what is available.',
  unknown_command: 'Check the action name against the tool description; use `status` or `status_facts` to see what is available.',
  model_profile_unknown: 'Call `models` to list registered profiles, then retry with an existing profileId (or provider/model).',
  model_not_allowed: 'Choose a model from this project\'s allowlist (Settings -> Models) or ask the operator to add it.',
  model_unresolved: 'Set a provider/model or a known profileId; `models` lists both.',
  appeal_self_resolution: 'An appeal must be resolved by someone other than the actor who raised it; ask another human or the chief.',
  appeal_not_resolved: 'The target was appealed and the appeal was withdrawn, not resolved. Obtain an explicit resolution by a different human/system actor; the appeal TTL never clears a withdrawal.',
  appeal_window_caller_supplied: 'Do not send appealUntil; the Host computes the cooling-off window from the appeal record.',
  intent_action_mismatch: 'An appeal intent and claim.action must both name the appeal action; an action intent must carry the action it asks to perform.',
  appeal_target_mismatch: 'An appeal must name the exact target node and the exact action it authorizes. An unscoped or differently-scoped appeal cannot authorize or resolve any irreversible action.',
  appeal_expired: 'The appeal window has expired; submit a new appeal with a fresh basis if the objection still holds.',
  intent_not_pending: 'This intent is no longer pending; list intents to see its current status.',
  appeal_pending: 'An appeal is open against this target. Wait for it to be withdrawn/expired, or ask the chief/human to resolve it before retrying.',
  dashboard_disabled: 'Enable the dashboard in project settings, or call dashboard_get without refreshing.',
  dashboard_empty: 'Add at least one widget in project settings before refreshing the dashboard.',
  agent_tool_scope: 'Use a read-only action or ask the operator.',
  project_not_found: 'Call `projects` to list project ids, then retry with an existing projectId.',
  node_not_found: 'Call `dag_query` or `status_facts` to list node ids, then retry with an existing nodeId.',
  bad_request: 'Fix the arguments named in the message and retry; no state was changed.',
  invalid_cursor: 'Restart the query without `cursor`; the filter changed since the cursor was issued.',
  budget_exhausted: 'Stop exploring and decide from the current focus/ledger, or open a fresh expert pass.',
  review_claimed: 'Another expert holds the review claim on this node. Pick a different leaf or wait for the claim to expire.',
  claim_board_full: 'Too many concurrent reviews. Release claims you no longer need (release_review) or retry after the TTL.',
  not_holder: 'Only the expert that claimed this node can release it; use review_claims to see the holder.',
  maxNodes: 'The project reached config.maxNodes. Finish/cancel nodes, raise the limit, or propose a successor for an existing leaf instead of a new branch.',
  max_running: 'Capacity is full. Wait for a running node to finish, raise maxRunningNodes, or cancel a low-value node.',
  cycle_busy: 'A cycle is already running. Wait for it to finish; do not start a second one.',
  run_timeout: 'The role run timed out. Retry the step, or raise the project advisor/scheduler timeout if the task is genuinely long.',
  preconditions: 'The repository is not in the required state. Read the message, fix the repo, and retry.',
  illegal_transition: 'The node is in a different state than the action requires. Refresh status_facts and choose an action valid for the current status.',
  stale: 'Another write landed first. Re-read the node (dag_get) and retry with the fresh revision.',
  stale_basis: 'An appeal or withdrawal landed after the authorization snapshot. Re-read the project and repeat the claim/appeal gate before retrying.',
  priority_frozen: 'Priority is a pre-run scheduling hint; only planned or proposed nodes can change it. Refresh status_facts and pick a planned node.',
  not_runnable: 'The node is not runnable (deferred, claimed, held, or not planned). Check `status_facts.nextToStart` for the reason.',
  start_failed: 'The experiment failed to boot. Read explain_node(nodeId), fix the cause, then retry; the node backs off automatically.',
  internal_error: 'Read the Host log for the stack, then retry. If it repeats, report the code to the operator.',
  error: 'Read the message, correct the input, and retry.',
});

const RETRYABLE = new Set([
  'stale', 'stale_basis', 'cycle_busy', 'review_claimed', 'not_runnable', 'start_failed', 'run_timeout', 'claim_board_full', 'internal_error', 'error',
]);

/**
 * @param {unknown} error
 * @param {{action?: string, extra?: object}} [context]
 * @returns {{ok: false, error: {code: string, message: string, nextStep: string, retryable: boolean, action?: string}}}
 */
export function toActionable(error, context = {}) {
  const code = typeof error?.code === 'string' && error.code ? error.code : 'error';
  const message = typeof error?.message === 'string' && error.message
    ? error.message
    : (typeof error === 'string' ? error : 'the action failed');
  return {
    ok: false,
    error: {
      code,
      message: message.slice(0, 2_000),
      nextStep: NEXT_STEPS[code] ?? NEXT_STEPS.error,
      retryable: RETRYABLE.has(code),
      ...(context.action ? { action: context.action } : {}),
      ...(context.extra ?? {}),
    },
  };
}

/** Build an actionable rejection without throwing. */
export function rejection(code, message, extra = {}) {
  return toActionable({ code, message }, { extra });
}

export { NEXT_STEPS };
