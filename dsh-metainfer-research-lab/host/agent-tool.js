/**
 * The `metainfer_lab` agent tool (fix for docs/issues/0001-agent-tool-scope-drift).
 *
 * DSH tool schemas are static and global, so the action enum cannot be narrowed
 * per preset. The allowlist is therefore enforced here and in the service: the
 * actor is derived from the DSH session (`exec.agent.session.header.meta.
 * agentPreset`), never from model arguments, and a disallowed action returns
 * `forbidden_action` with an actionable next step instead of silently exposing
 * the full surface to a worker.
 */
import { actorFromToolExecution, authorizeAction } from './kernel/policy.js';
import { rejection, toActionable } from './kernel/errors.js';
const ACTION_ENUM = [
  'dag_map',
  'dag_query',
  'dag_walk',
  'dag_get',
  'dag_diff',
  'ledger_read',
  'ledger_update',
  'claim_review',
  'release_review',
  'review_claims',
  'status_facts',
  'resource_status',
  'metrics',
  'explain_node',
  'trace_explain',
  'changes_since',
  'nodes_page',
  'events_page',
  'runs_page',
  'set_priority',
  'intent_submit',
  'intent_list',
  'intent_withdraw',
  'curator_reset',
  'expert_list',
  'expert_recall',
  'expert_hire',
  'expert_drain',
  'expert_fire',
  'curator_nominate',
  'curator_outcome',
  'dispatch_once',
  'health',
  'projects',
  'status',
  'create_project',
  'state',
  'get_node',
  'update_project',
  'update_node',
  'start_node',
  'retry_node',
  'escalate_node',
  'models',
  'cluster',
  'cluster_config',
  'cluster_config_update',
  'compile_placement',
  'validate_model',
  'delete_project',
  'cancel_node',
  'message_node',
  'node_files',
  'replay',
  'dashboard_get',
  'dashboard_update',
  'dashboard_refresh',
  'dashboard_chat',
  'dashboard_layout',
  'transcript',
  'step',
  'successor',
  'create_merge',
  'finish_merge',
  'push_project',
  'approve_node',
  'reject_node',
  'auto_start',
  'auto_stop',
  'auto_resume',
  'auto_status',
  'runs',
  'run',
  'chat',
  'clear_chat',
  'copilot',
  'intake_read',
  'intake_patch',
  'intake_ready',
  'intake_start',
  'intake_message',
  'intake_confirm',
  'intake_discard',
];

/**
 * @param ctx Cordis context with `tools` injected.
 * @param service the `metainferLab` Host service.
 * @returns a disposer that removes the tool.
 */
export function registerAgentTool(ctx, service) {
  return ctx.tools.register({
    name: 'metainfer_lab',
    description:
      'Drive the MetaInfer Research Lab: list projects, inspect node state, create a project bound to a git repo, start/cancel experiment nodes, continue a completed node, read a transcript, run one manual Step cycle, add a successor node, or inspect advisor/scheduler runs. Returns compact JSON as a string.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTION_ENUM },
        projectId: { type: 'string' },
        nodeId: { type: 'string' },
        text: { type: 'string', description: 'message text for message_node, or natural-language placement policy for compile_placement' },
        afterSeq: { type: 'number', description: 'transcript cursor' },
        limit: { type: 'number', description: 'page size for transcript/replay (bounded by the Host)' },
        nodeLimit: { type: 'number', description: 'node page size for replay (bounded by the Host)' },
        config: { type: 'object', additionalProperties: true, description: 'config object: project config for create_project/update_project, cluster config patch for cluster_config_update' },
        force: { type: 'boolean', description: 'for cluster_config_update: allow applying while a GPU lease is active' },
        model: { type: 'object', additionalProperties: true, description: 'model selection {profileId} or {provider,model,reasoningEffort?} for node edit/retry/escalate/successor/merge' },
        upgrade: { type: 'boolean', description: 'for retry_node: escalate to the next stronger model attempt' },
        runId: { type: 'string', description: 'advisor/scheduler run id for action=run' },
        trigger: { type: 'string', description: 'cycle trigger label for action=step' },
        name: { type: 'string' },
        repoPath: { type: 'string', description: 'absolute local git repository path' },
        brief: { type: 'string' },
        initialPrompt: { type: 'string' },
        initialNodes: {
          type: 'array',
          description:
            'for create_project: 1..8 independent root nodes (no parent/child edge). Each item {title, prompt, needs?, timeboxMinutes?}; overrides initialPrompt when present.',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              title: { type: 'string' },
              prompt: { type: 'string' },
              needs: { type: 'object', additionalProperties: true },
              timeboxMinutes: { type: 'number' },
            },
            required: ['title', 'prompt'],
          },
        },
        baseBranch: { type: 'string' },
        needs: { type: 'object', additionalProperties: true, description: 'node resource needs, e.g. {"gpu":2,"machines":2}; successor/create_merge also accept [{"key":"gpu","amount":2}]' },
        parentIds: { type: 'array', items: { type: 'string' }, description: 'for create_merge: 2..4 completed parent node ids' },
        summary: { type: 'string', description: 'for finish_merge: merge summary' },
        remote: { type: 'string', description: 'for push_project: remote name, default origin' },
        removeWorktrees: { type: 'boolean', description: 'for delete_project: remove node worktree directories (branches/tags kept)' },
        create: { type: 'boolean', description: 'for copilot: create a new private Copilot session instead of reusing the active one' },
        title: { type: 'string', description: 'for copilot: display title of a newly created Copilot session' },
        sessionId: { type: 'string', description: 'for copilot: switch to this existing private Copilot session id' },
        dashboardSpec: { type: 'object', additionalProperties: true, description: 'for dashboard_update: {title,prompt,mode,script,intervalMinutes,enabled}' },
        layouts: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'for dashboard_layout: [{id,x,y,w,h}]' },
        intakeId: { type: 'string', description: 'for intake_read/intake_patch/intake_ready: the new-project intake draft id' },
        filter: { type: 'object', additionalProperties: true, description: 'for dag_query: {status, subtreeOf, depth:{min,max}, since, text, parentId}' },
        select: { type: 'array', items: { type: 'string' }, description: 'for dag_query/dag_get: node fields to return (default compact)' },
        limit: { type: 'number', description: 'for dag_query/nodes_page/events_page/runs_page: page size (bounded by the Host)' },
        cursor: { type: 'string', description: 'opaque cursor from a previous page; do not invent one' },
        order: { type: 'string', enum: ['created', 'recent', 'priority'], description: 'for dag_query: stable ordering' },
        nodeIds: { type: 'array', items: { type: 'string' }, description: 'for dag_get: node ids (max 50)' },
        neighbors: { type: 'boolean', description: 'for dag_get: include direct parents/children (default true)' },
        op: { type: 'string', enum: ['open', 'confirm', 'rule_out'], description: 'for ledger_update' },
        hypothesis: { type: 'string', description: 'for ledger_update op=open' },
        evidence: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'evidence pointers {kind,ref,note?}; never log bodies' },
        reason: { type: 'string', description: 'for ledger_update op=rule_out or set_priority' },
        kind: { type: 'string', enum: ['dispatch', 'priority', 'proposal', 'review', 'curate', 'note'], description: 'for intent_submit/intent_list' },
        claim: { type: 'object', additionalProperties: true, description: 'for intent_submit: {action, strategy?, reason?, evidence?}; required and stored verbatim' },
        chiefConfirmed: { type: 'boolean', description: 'for intent_submit: chief confirmation of a level-2/3 irreversible action; only a human or the chief preset may set it' },
        target: { type: 'object', additionalProperties: true, description: 'for intent_submit: {nodeId?, parentId?}' },
        rationale: { type: 'string', description: 'for intent_submit: ≤2,000 characters' },
        intentId: { type: 'string', description: 'for intent_withdraw: the pending intent to withdraw' },
        basis: {
          type: 'object',
          description: 'for intent_submit: {projectRevision, snapshotAgeMs, nodesSeen} the judgement read (default current revision with a fresh snapshot)',
          properties: {
            projectRevision: { type: 'integer', minimum: 0 },
            snapshotAgeMs: { type: 'integer', minimum: 0 },
            nodesSeen: { type: 'integer', minimum: 0 },
          },
          required: ['projectRevision', 'snapshotAgeMs', 'nodesSeen'],
          additionalProperties: false,
        },
        task: { type: 'string', description: 'for expert_recall: the task to match against expert descriptors' },
        expertId: { type: 'string', description: 'for expert_hire/expert_drain/expert_fire: the catalog expert id' },
        provider: { type: 'string', description: 'for expert_hire: optional provider override' },
        model: { type: 'string', description: 'for expert_hire: optional model override' },
        lens: { type: 'string', description: 'for expert_hire: optional review perspective' },
        falseClose: { type: 'boolean', description: 'for curator_outcome: the applied nomination was a false close' },
        apply: { type: 'boolean', description: 'for curator_outcome: must be false; the curator never executes' },
        note: { type: 'string', description: 'for ledger_update op=confirm' },
        priority: { type: 'object', additionalProperties: true, description: 'for set_priority: {class, score?}' },
        class: { type: 'string', enum: ['p0', 'p1', 'p2', 'p3', 'deferred'], description: 'for set_priority' },
        score: { type: 'number', description: 'for set_priority: tie-breaker score' },
        sinceRevision: { type: 'number', description: 'for changes_since: return only records changed after this revision' },
        window: { type: 'number', description: 'for explain_node/trace_explain: event window size (bounded by the Host)' },
        values: { type: 'object', additionalProperties: true, description: 'for intake_patch: {fieldId: value} patch' },
        schema: { type: 'object', additionalProperties: true, description: 'for intake_start: the new-project form schema (fields with id/path/type/default/required)' },
        start: { type: 'boolean', description: 'for intake_confirm: start the root node after creating the project' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { result: { type: 'string' } },
        required: ['result'],
        additionalProperties: false,
      },
      render: (args, value) => {
        const text = value && typeof value.result === 'string' ? value.result : JSON.stringify(value);
        return [{ type: 'text', text: text.length > 20_000 ? `${text.slice(0, 20_000)}\n…[truncated]` : text }];
      },
    },
    timeoutMs: 300_000,
    async execute(args, exec) {
      const action = args?.action;
      const actor = actorFromToolExecution(exec);
      const verdict = authorizeAction(actor, action);
      if (!verdict.ok) {
        return { result: JSON.stringify(rejection(verdict.code, verdict.message, { allowed: verdict.allowed, preset: actor.preset })) };
      }
      try {
        const data = await service.agentTool(args ?? {}, exec);
        return { result: JSON.stringify(data) };
      } catch (error) {
        return { result: JSON.stringify(toActionable(error, { action })) };
      }
    },
  });
}
