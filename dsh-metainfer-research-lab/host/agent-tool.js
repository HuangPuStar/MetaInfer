/**
 * Global agent tool exposing the lab operations (same service the UI calls).
 * This is intentionally one small dispatcher: `metainfer_lab`.
 */
const ACTION_ENUM = [
  'projects',
  'status',
  'create_project',
  'state',
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
        config: { type: 'object', additionalProperties: true, description: 'cluster config patch for cluster_config_update' },
        force: { type: 'boolean', description: 'for cluster_config_update: allow applying while a GPU lease is active' },
        model: { type: 'object', additionalProperties: true, description: 'model selection {profileId} or {provider,model,reasoningEffort?} for node edit/retry/escalate/successor/merge' },
        upgrade: { type: 'boolean', description: 'for retry_node: escalate to the next stronger model attempt' },
        runId: { type: 'string', description: 'advisor/scheduler run id for action=run' },
        trigger: { type: 'string', description: 'cycle trigger label for action=step' },
        name: { type: 'string' },
        repoPath: { type: 'string', description: 'absolute local git repository path' },
        brief: { type: 'string' },
        initialPrompt: { type: 'string' },
        baseBranch: { type: 'string' },
        config: { type: 'object', additionalProperties: true },
        needs: { type: 'object', additionalProperties: true, description: 'node resource needs, e.g. {"gpu":2,"machines":2}' },
        parentIds: { type: 'array', items: { type: 'string' }, description: 'for create_merge: 2..4 completed parent node ids' },
        summary: { type: 'string', description: 'for finish_merge: merge summary' },
        remote: { type: 'string', description: 'for push_project: remote name, default origin' },
        removeWorktrees: { type: 'boolean', description: 'for delete_project: remove node worktree directories (branches/tags kept)' },
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
    async execute(args) {
      try {
        const data = await service.agentTool(args ?? {});
        return { result: JSON.stringify(data) };
      } catch (error) {
        return {
          result: JSON.stringify({
            ok: false,
            error: {
              code: typeof error?.code === 'string' ? error.code : 'error',
              message: error instanceof Error ? error.message : String(error),
            },
          }),
        };
      }
    },
  });
}
