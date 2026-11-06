/**
 * MCP control surface for MetaInfer Research Lab.
 *
 * One write-capable tool creates a project (repo binding + role prompts); every
 * other tool is a read-only view of the same Host service used by the Web UI.
 * The endpoint is exposed on the DSH Web origin at /mcp/metainfer-research-lab.
 */
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';

const SERVER_NAME = 'metainfer-research-lab';
const SERVER_VERSION = '1.0.0';
const ENDPOINT = '/mcp/metainfer-research-lab';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

function ok(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : '';
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: message, code }, null, 2) }],
  };
}

const projectId = z.string().min(1).max(128).describe('MetaInfer Research Lab project id');
const nodeId = z.string().min(1).max(128);
const runId = z.string().min(1).max(128);
const sessionId = z.string().min(1).max(128);

function createServer(service) {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'MetaInfer Research Lab control surface. ' +
        'metainfer_create_project is the ONLY write tool; it binds a git repository and seeds ' +
        'role prompts. Every other tool is read-only. Do not attempt to start, stop, edit, ' +
        'delete, or otherwise mutate lab state through this server.',
    },
  );

  server.registerTool(
    'metainfer_create_project',
    {
      title: 'Create MetaInfer Research Lab project',
      description:
        'Write operation. Create one project bound to an existing git repository, with a root ' +
        'experiment prompt and optional role prompt overrides. The project is created in manual ' +
        'mode and the root node is planned; this tool never starts an experiment.',
      inputSchema: z.object({
        name: z.string().min(1).max(120),
        brief: z.string().min(1).max(8000),
        initialPrompt: z.string().min(10).max(8000).describe('Prompt for the root DAG node'),
        repoPath: z.string().min(1).max(4096).describe('Absolute path to an existing git repository'),
        baseBranch: z.string().min(1).max(256).optional(),
        needs: z.record(z.string(), z.number()).optional(),
        executionProfile: z.string().min(1).max(64).optional(),
        taskType: z.string().min(1).max(64).optional(),
        config: z.record(z.string(), z.unknown()).optional().describe('Lab project config; validated by the Host'),
        prompts: z.object({
          workerPrefix: z.string().max(8000).optional(),
          advisor: z.string().max(8000).optional(),
          scheduler: z.string().max(8000).optional(),
          merge: z.string().max(8000).optional(),
          gc: z.string().max(8000).optional(),
        }).optional().describe('Initial role prompt overrides'),
      }),
      annotations: WRITE,
    },
    async (args) => {
      try {
        const config = args.config && typeof args.config === 'object' && !Array.isArray(args.config)
          ? { ...args.config }
          : {};
        if (args.prompts) {
          config.prompts = { ...(config.prompts && typeof config.prompts === 'object' ? config.prompts : {}), ...args.prompts };
        }
        const result = await service.createProject({
          name: args.name,
          brief: args.brief,
          initialPrompt: args.initialPrompt,
          repoPath: args.repoPath,
          ...(args.baseBranch ? { baseBranch: args.baseBranch } : {}),
          ...(args.needs ? { needs: args.needs } : {}),
          ...(args.executionProfile ? { executionProfile: args.executionProfile } : {}),
          ...(args.taskType ? { taskType: args.taskType } : {}),
          config,
        });
        return ok({
          projectId: result.project?.id,
          revision: result.revision,
          project: result.project,
          rootNode: result.rootNode,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'metainfer_list_projects',
    {
      title: 'List projects',
      description: 'Read-only. List every MetaInfer Research Lab project with repository and node counts.',
      inputSchema: z.object({}),
      annotations: READ,
    },
    async () => {
      try { return ok({ projects: await service.listProjects() }); } catch (error) { return fail(error); }
    },
  );

  server.registerTool(
    'metainfer_get_project',
    {
      title: 'Get project state',
      description: 'Read-only. Read the complete project state: project config, DAG nodes, edges, resources, auto status and cluster status.',
      inputSchema: z.object({ projectId }),
      annotations: READ,
    },
    async ({ projectId: id }) => {
      try { return ok(await service.getState(id)); } catch (error) { return fail(error); }
    },
  );

  server.registerTool(
    'metainfer_list_nodes',
    {
      title: 'List DAG nodes',
      description: 'Read-only. List DAG nodes; optionally filter by status. Includes prompts, reports, attempts, git and timing data.',
      inputSchema: z.object({
        projectId,
        status: z.string().min(1).max(32).optional(),
      }),
      annotations: READ,
    },
    async ({ projectId: id, status }) => {
      try {
        const state = await service.getState(id);
        const nodes = (state.nodes || []).filter((node) => !status || node.status === status);
        return ok({ projectId: id, revision: state.revision, nodes, count: nodes.length });
      } catch (error) { return fail(error); }
    },
  );

  server.registerTool(
    'metainfer_get_node',
    {
      title: 'Get DAG node',
      description: 'Read-only. Read one node record, its attempts, reports, git revisions and status.',
      inputSchema: z.object({ projectId, nodeId }),
      annotations: READ,
    },
    async ({ projectId: id, nodeId: nid }) => {
      try {
        const state = await service.getState(id);
        const node = (state.nodes || []).find((candidate) => candidate.id === nid);
        if (!node) return fail({ code: 'node_not_found', message: `unknown node: ${nid}` });
        return ok({ node });
      } catch (error) { return fail(error); }
    },
  );

  server.registerTool(
    'metainfer_get_node_transcript',
    {
      title: 'Get node conversation transcript',
      description: 'Read-only. Read the node worker conversation transcript. Use afterSeq for incremental reads.',
      inputSchema: z.object({
        projectId,
        nodeId,
        afterSeq: z.number().int().nonnegative().optional(),
      }),
      annotations: READ,
    },
    async ({ projectId: id, nodeId: nid, afterSeq }) => {
      try { return ok(await service.getTranscript(id, nid, afterSeq ?? 0)); } catch (error) { return fail(error); }
    },
  );

  server.registerTool(
    'metainfer_get_session_transcript',
    {
      title: 'Get project session transcript',
      description:
        'Read-only. Read the DSH conversation for a project controller, Copilot, node worker/anchor, ' +
        'or advisor/scheduler/GC run session. The session must belong to the requested project.',
      inputSchema: z.object({
        projectId,
        sessionId,
        afterSeq: z.number().int().nonnegative().optional(),
      }),
      annotations: READ,
    },
    async ({ projectId: id, sessionId: sid, afterSeq }) => {
      try { return ok(await service.getSessionTranscript(id, sid, afterSeq ?? 0)); } catch (error) { return fail(error); }
    },
  );

  server.registerTool(
    'metainfer_list_runs',
    {
      title: 'List expert runs',
      description: 'Read-only. List advisor, reviewer, scheduler and GC runs for a project.',
      inputSchema: z.object({ projectId }),
      annotations: READ,
    },
    async ({ projectId: id }) => {
      try { return ok(await service.listRuns(id)); } catch (error) { return fail(error); }
    },
  );

  server.registerTool(
    'metainfer_get_run',
    {
      title: 'Get expert run',
      description: 'Read-only. Read one advisor/scheduler/GC run including its input snapshot, output, proposals, usage and transcript reference.',
      inputSchema: z.object({ projectId, runId }),
      annotations: READ,
    },
    async ({ projectId: id, runId: rid }) => {
      try { return ok(await service.getRun(id, rid)); } catch (error) { return fail(error); }
    },
  );

  server.registerTool(
    'metainfer_get_events',
    {
      title: 'Read project events',
      description: 'Read-only. Read the project event stream after a sequence number.',
      inputSchema: z.object({
        projectId,
        after: z.number().int().nonnegative().optional(),
      }),
      annotations: READ,
    },
    async ({ projectId: id, after }) => {
      try { return ok(await service.getEvents(id, after ?? 0)); } catch (error) { return fail(error); }
    },
  );

  server.registerTool(
    'metainfer_get_cluster',
    {
      title: 'Get cluster status',
      description: 'Read-only. Read cluster resource status for a project.',
      inputSchema: z.object({ projectId }),
      annotations: READ,
    },
    async ({ projectId: id }) => {
      try { return ok(await service.getCluster(id)); } catch (error) { return fail(error); }
    },
  );

  server.registerTool(
    'metainfer_get_models',
    {
      title: 'Get model and prompt catalog',
      description: 'Read-only. Read available model providers/options, role prompt defaults, and prompt placeholders.',
      inputSchema: z.object({ projectId }),
      annotations: READ,
    },
    async ({ projectId: id }) => {
      try { return ok(await service.getModels(id)); } catch (error) { return fail(error); }
    },
  );

  server.registerTool(
    'metainfer_get_project_prompts',
    {
      title: 'Get project role prompts',
      description: 'Read-only. Read effective project role prompt overrides and the defaults they replace.',
      inputSchema: z.object({ projectId }),
      annotations: READ,
    },
    async ({ projectId: id }) => {
      try {
        const state = await service.getState(id);
        const models = await service.getModels(id);
        return ok({
          projectId: id,
          prompts: state.project?.config?.prompts ?? {},
          defaults: models.promptDefaults ?? {},
          placeholders: models.promptPlaceholders ?? [],
        });
      } catch (error) { return fail(error); }
    },
  );

  return server;
}

function authorized(req, token) {
  if (token) {
    const header = String(req.headers?.authorization || '');
    if (header === `Bearer ${token}`) return true;
    return String(req.headers?.['x-metainfer-mcp-token'] || '') === token;
  }
  const remote = String(req.socket?.remoteAddress || '');
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

/**
 * Register the Streamable HTTP MCP endpoint on the DSH Web server.
 * @param ctx Cordis Host context.
 * @param webServer DSH Web server service.
 * @param service MetaInfer Lab Host service.
 * @returns disposer.
 */
export function registerMcp(ctx, webServer, service) {
  const token = String(process.env.METAINFER_MCP_TOKEN || '').trim();
  const handler = toNodeHandler(createMcpHandler(
    () => createServer(service),
    { legacy: 'stateless', responseMode: 'json' },
  ));
  const route = (req, res) => {
    if (!authorized(req, token)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'mcp endpoint is local-only; set METAINFER_MCP_TOKEN and send a bearer token for remote access' }));
      return;
    }
    return handler(req, res);
  };
  return webServer.register({ kind: 'prefix', path: ENDPOINT, handler: route });
}

export { ENDPOINT, SERVER_NAME, SERVER_VERSION };
