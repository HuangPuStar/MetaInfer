/**
 * M1 HTTP routes for the Host half.
 *
 * Exact paths below /api on `ctx.connection.fetch`; the Connection carrier only
 * admits authenticated owner peers. The Client half is the only intended caller
 * and uses relative URLs so mount prefixes keep working.
 *
 * Every well-formed request answers HTTP 200 with `{ok:true,data}` or
 * `{ok:false,error:{code,message}}`; the envelope, not the status code, carries
 * business results. Malformed JSON also answers the envelope so the UI can show
 * one consistent error path.
 */
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { publicView } from './kernel/actors.js';

const PREFIX = '/api/metainfer-research-lab';
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function json(payload) {
  return new Response(JSON.stringify(payload), { status: 200, headers: JSON_HEADERS });
}

function ok(data) {
  return json({ ok: true, data: publicView(data) });
}

function okResult(result) {
  if (result && result.ok === false) {
    const error = new Error(result.error?.message ?? 'request rejected');
    error.code = result.error?.code ?? 'rejected';
    throw error;
  }
  return ok(result);
}

function fail(error) {
  const code = typeof error?.code === 'string' ? error.code : 'internal_error';
  const message = typeof error?.message === 'string' ? error.message : String(error);
  return json({ ok: false, error: publicView({ code, message }) });
}

function query(request) {
  return new URL(request.url, 'http://localhost').searchParams;
}

const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
  '.log': 'text/plain; charset=utf-8',
};

function mimeOf(name) {
  return MIME_BY_EXT[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

async function readJsonBody(request) {
  try {
    const value = await request.json();
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('body must be a JSON object');
    }
    return value;
  } catch (error) {
    const wrapped = new Error(error instanceof Error ? error.message : 'invalid JSON body');
    wrapped.code = 'bad_request';
    throw wrapped;
  }
}

/**
 * Register the M1 routes and return one sync disposer.
 * @param ctx Cordis context with `connection` injected.
 * @param service the `metainferLab` Host service.
 */
export function registerHttpRoutes(ctx, service) {
  const disposers = [];

  const route = (path, methods, handler) => {
    disposers.push(
      ctx.connection.fetch.register({
        path,
        methods,
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            return await handler(request);
          } catch (error) {
            return fail(error);
          }
        },
      }),
    );
  };

  route(`${PREFIX}/health`, ['GET'], async () => ok(await service.health()));

  route(`${PREFIX}/projects`, ['GET', 'POST'], async (request) => {
    if (request.method === 'GET') {
      const projects = await service.listProjects();
      return ok({ projects, count: projects.length });
    }
    const body = await readJsonBody(request);
    const result = await service.createProject(body);
    return ok(result);
  });

  route(`${PREFIX}/repo`, ['GET'], async (request) => {
    const repoPath = query(request).get('path');
    return ok(await service.validateRepo(repoPath));
  });

  route(`${PREFIX}/state`, ['GET'], async (request) => {
    const params = query(request);
    const projectId = params.get('projectId');
    const revision = params.get('revision');
    const limit = Number(params.get('limit'));
    const cursor = params.get('cursor');
    return ok(await service.getState(projectId, revision, {
      // HTTP never returns unslim full records: `full` would bypass the byte
      // budget S11 relies on. Internal callers still use the service directly.
      // Every HTTP list is bounded; the client follows `nextCursor`.
      limit: Number.isFinite(limit) && limit > 0 ? Math.min(5000, Math.trunc(limit)) : 1000,
      cursor: cursor || null,
    }));
  });

  route(`${PREFIX}/status`, ['GET'], async (request) => {
    const params = query(request);
    return ok(await service.statusFacts(params.get('projectId')));
  });

  route(`${PREFIX}/metrics`, ['GET'], async (request) => {
    const params = query(request);
    return ok(await service.metricsFor(params.get('projectId')));
  });

  route(`${PREFIX}/intents`, ['GET'], async (request) => {
    const params = query(request);
    const limit = params.get('limit');
    return ok(service.listIntents(params.get('projectId'), {
      limit: limit === null ? 100 : Number(limit),
      kind: params.get('kind') ?? null,
    }));
  });

  route(`${PREFIX}/experts`, ['GET'], async (request) => {
    const params = query(request);
    return ok(service.listExperts(params.get('projectId')));
  });

  route(`${PREFIX}/observer`, ['GET'], async (request) => {
    const params = query(request);
    return ok(service.observerSnapshot(params.get('projectId')));
  });

  route(`${PREFIX}/events/wait`, ['GET'], async (request) => {
    const params = query(request);
    return ok(await service.waitForEvents(params.get('projectId'), {
      after: params.get('after') === null ? null : Number(params.get('after')),
      timeoutMs: params.get('timeoutMs') === null ? undefined : Number(params.get('timeoutMs')),
      pollMs: params.get('pollMs') === null ? undefined : Number(params.get('pollMs')),
    }));
  });

  route(`${PREFIX}/observe`, ['GET'], async (request) => {
    const params = query(request);
    return ok(service.observe(params.get('projectId')));
  });

  route(`${PREFIX}/rotations`, ['GET', 'POST'], async (request) => {
    if (request.method === 'GET') {
      const params = query(request);
      return ok(service.rotationStatus(params.get('projectId')));
    }
    const body = await readJsonBody(request);
    return okResult(await service.rotateExpert(body.projectId, body, null));
  });

  route(`${PREFIX}/arbitrate`, ['POST'], async (request) => {
    const body = await readJsonBody(request);
    return okResult(await service.arbitrate(body.projectId, body, null));
  });

  route(`${PREFIX}/disputes/classes`, ['GET'], async () => ok(service.disputeClasses()));

  route(`${PREFIX}/disputes`, ['GET', 'POST'], async (request) => {
    const params = query(request);
    if (request.method === 'GET') {
      return ok(service.listDisputes(params.get('projectId'), {
        limit: params.get('limit') === null ? 200 : Number(params.get('limit')),
        status: params.get('status') ?? null,
      }));
    }
    const body = await readJsonBody(request);
    return okResult(await service.openDispute(body.projectId, body, null));
  });

  route(`${PREFIX}/disputes/resolve`, ['POST'], async (request) => {
    const body = await readJsonBody(request);
    // Same limited-write gate as the `arbitrate` tool. This route is called by
    // the trusted operator UI (no preset); routing through `arbitrate` keeps a
    // future actor-bearing caller from bypassing the eight-class authority map.
    return okResult(await service.arbitrate(body.projectId, body, null));
  });

  route(`${PREFIX}/disputes/reopen`, ['POST'], async (request) => {
    const body = await readJsonBody(request);
    return okResult(await service.reopenDispute(body.projectId, body.disputeId, body, null));
  });

  route(`${PREFIX}/disputes/sweep`, ['POST'], async (request) => {
    const body = await readJsonBody(request);
    return okResult(await service.sweepDisputes(body.projectId, { now: body.now }));
  });

  route(`${PREFIX}/budgets`, ['GET'], async (request) => {
    const params = query(request);
    return ok(service.classBudgetReport(params.get('projectId')));
  });

  route(`${PREFIX}/reviews`, ['GET'], async (request) => {
    const params = query(request);
    const result = service.reviewClaimsAction(params.get('projectId'));
    // `reviewClaimsAction` returns a rejection envelope for a missing
    // orchestrator; lift it to the HTTP error envelope so the UI's normal
    // error path shows the reason instead of an empty claim list.
    if (result?.ok === false) {
      const error = new Error(result.error?.message ?? 'review claims unavailable');
      error.code = result.error?.code ?? 'unavailable';
      throw error;
    }
    return ok(result);
  });

  route(`${PREFIX}/retrospective`, ['GET', 'POST'], async (request) => {
    const params = query(request);
    if (request.method === 'GET') {
      return ok(service.listRetrospectives(params.get('projectId'), {
        limit: params.get('limit') === null ? 20 : Number(params.get('limit')),
      }));
    }
    const body = await readJsonBody(request);
    return ok(await service.generateRetrospective(body.projectId, body, null));
  });

  route(`${PREFIX}/node`, ['GET'], async (request) => {
    const params = query(request);
    return ok(await service.getNode(params.get('projectId'), params.get('nodeId')));
  });

  route(`${PREFIX}/explain`, ['GET'], async (request) => {
    const params = query(request);
    const window = params.get('window');
    return ok(service.explainNode(params.get('projectId'), params.get('nodeId'), {
      window: window !== null && Number.isFinite(Number(window)) ? Number(window) : undefined,
    }));
  });

  route(`${PREFIX}/changes`, ['GET'], async (request) => {
    const params = query(request);
    return ok(service.changesSince(params.get('projectId'), params.get('revision') ?? 0));
  });

  route(`${PREFIX}/events`, ['GET'], async (request) => {
    const params = query(request);
    const limit = params.get('limit');
    return ok(await service.getEvents(
      params.get('projectId'),
      params.get('after') ?? 0,
      { limit: limit === null ? 1000 : Number(limit) },
    ));
  });

  route(`${PREFIX}/cluster/config`, ['GET'], async () => ok(await service.getClusterConfig()));

  route(`${PREFIX}/cluster`, ['GET'], async (request) => {
    const params = query(request);
    return ok(await service.getCluster(params.get('projectId')));
  });

  route(`${PREFIX}/models`, ['GET'], async (request) => {
    const params = query(request);
    return ok(await service.getModels(params.get('projectId')));
  });

  route(`${PREFIX}/chat`, ['GET'], async (request) => {
    const params = query(request);
    return ok(await service.getChat(params.get('projectId')));
  });

  route(`${PREFIX}/copilot`, ['GET'], async (request) => {
    const params = query(request);
    return ok(await service.getCopilot(params.get('projectId')));
  });

  route(`${PREFIX}/intake`, ['GET'], async (request) => {
    const params = query(request);
    return ok(await service.readIntake(params.get('intakeId')));
  });

  route(`${PREFIX}/runs`, ['GET'], async (request) => {
    const params = query(request);
    const projectId = params.get('projectId');
    const runIdValue = params.get('runId');
    if (runIdValue) return ok(await service.getRun(projectId, runIdValue));
    const limit = Number(params.get('limit'));
    const cursor = params.get('cursor');
    return ok(await service.listRunsPage(projectId, {
      limit: Number.isFinite(limit) && limit > 0 ? Math.min(500, Math.trunc(limit)) : 50,
      cursor: typeof cursor === 'string' && cursor ? cursor : null,
    }));
  });

  route(`${PREFIX}/transcript`, ['GET'], async (request) => {
    const params = query(request);
    const limit = Number(params.get('limit'));
    return ok(await service.getTranscript(
      params.get('projectId'),
      params.get('nodeId'),
      params.get('afterSeq') ?? 0,
      Number.isFinite(limit) && limit > 0 ? Math.min(1000, Math.trunc(limit)) : 200,
    ));
  });

  route(`${PREFIX}/files/info`, ['GET'], async (request) => {
    const file = await service.resolveWorktreeFile(query(request).get('path'));
    return ok({ managed: true, name: file.name, size: file.size, projectId: file.projectId });
  });

  route(`${PREFIX}/files/download`, ['GET'], async (request) => {
    const requested = query(request).get('path');
    const file = await service.resolveWorktreeFile(requested);
    const encoded = encodeURIComponent(file.name);
    const ascii = file.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    return new Response(Readable.toWeb(createReadStream(file.path)), {
      status: 200,
      headers: {
        'content-type': mimeOf(file.name),
        'content-length': String(file.size),
        'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`,
        'cache-control': 'no-store',
      },
    });
  });

  route(`${PREFIX}/replay`, ['GET'], async (request) => {
    const params = query(request);
    const limit = Number(params.get('limit'));
    const nodeLimit = Number(params.get('nodeLimit'));
    const afterSeq = Number(params.get('afterSeq'));
    const nodeCursor = params.get('nodeCursor');
    return ok(await service.getReplay(params.get('projectId'), {
      limit: Number.isFinite(limit) && limit > 0 ? Math.min(5000, Math.trunc(limit)) : 2000,
      nodeLimit: Number.isFinite(nodeLimit) && nodeLimit > 0 ? Math.min(5000, Math.trunc(nodeLimit)) : 2000,
      afterSeq: Number.isFinite(afterSeq) ? Math.max(0, Math.trunc(afterSeq)) : 0,
      nodeCursor: typeof nodeCursor === 'string' && nodeCursor ? nodeCursor : null,
    }));
  });

  route(`${PREFIX}/dashboard`, ['GET', 'POST'], async (request) => {
    const params = query(request);
    if (request.method === 'GET') return ok(await service.getDashboard(params.get('projectId')));
    const body = await readJsonBody(request);
    return ok(await service.updateDashboard(body.projectId, body));
  });

  route(`${PREFIX}/dashboard/refresh`, ['POST'], async (request) => {
    const body = await readJsonBody(request);
    return ok(await service.refreshDashboard(body.projectId, { force: true }));
  });

  route(`${PREFIX}/dashboard/chat`, ['POST'], async (request) => {
    const body = await readJsonBody(request);
    return ok(await service.chatDashboard(body.projectId, body.text));
  });

  route(`${PREFIX}/dashboard/layout`, ['POST'], async (request) => {
    const body = await readJsonBody(request);
    return ok(await service.updateDashboardLayout(body.projectId, body.layouts));
  });

  route(`${PREFIX}/execution`, ['GET'], async (request) => {
    const params = query(request);
    return ok(await service.getExecutionEvents(
      params.get('projectId'),
      params.get('nodeId'),
      params.get('after') ?? 0,
    ));
  });

  route(`${PREFIX}/preemption/appeal`, ['POST'], async (request) => {
    const body = await readJsonBody(request);
    return ok(await service.appealPreemption(body.projectId, body.nodeId, body));
  });

  route(`${PREFIX}/commands`, ['POST'], async (request) => {
    const body = await readJsonBody(request);
    const type = body.type;
    if (type === 'node.priority') {
      return ok(await service.setNodePriority(body.projectId, body.nodeId, body.priority ?? body));
    }
    if (type === 'node.edit') {
      const result = await service.updateNode(body.projectId, body.nodeId, body);
      return ok(result);
    }
    if (type === 'project.update') {
      const result = await service.updateProject(body.projectId, body);
      return ok(result);
    }
    if (type === 'node.retry') {
      return ok(await service.retryNode(body.projectId, body.nodeId, body));
    }
    if (type === 'node.escalate') {
      return ok(await service.escalateNode(body.projectId, body.nodeId, body));
    }
    if (type === 'project.delete') {
      return ok(await service.deleteProject(body.projectId, { removeWorktrees: body.removeWorktrees === true }));
    }
    if (type === 'node.start') {
      return ok(await service.startNode(body.projectId, body.nodeId));
    }
    if (type === 'node.cancel') {
      return ok(await service.cancelNode(body.projectId, body.nodeId));
    }
    if (type === 'node.message') {
      return ok(await service.messageNode(body.projectId, body.nodeId, body.text));
    }
    if (type === 'node.files') {
      return ok(await service.ensureNodeWorktree(body.projectId, body.nodeId));
    }
    if (type === 'cluster.config') {
      return ok(await service.updateClusterConfig(body));
    }
    if (type === 'project.chat') {
      return ok(await service.projectChat(body.projectId, body.text));
    }
    if (type === 'project.chat_clear') {
      return ok(await service.clearProjectChat(body.projectId));
    }
    if (type === 'project.copilot') {
      return ok(await service.openCopilot(body.projectId, {
        sessionId: body.sessionId,
        create: body.create === true,
        title: body.title,
      }));
    }
    if (type === 'project.intake_start') {
      return ok(await service.startIntake({ schema: body.schema }));
    }
    if (type === 'project.intake_message') {
      return ok(await service.messageIntake(body.intakeId, body.text));
    }
    if (type === 'project.intake_confirm') {
      return ok(await service.confirmIntake(body.intakeId, { start: body.start === true }));
    }
    if (type === 'project.intake_discard') {
      return ok(await service.discardIntake(body.intakeId));
    }
    if (type === 'project.intake_get') {
      return ok(await service.readIntake(body.intakeId));
    }
    if (type === 'project.compile_placement') {
      return ok(await service.compilePlacementPolicyForProject(body.projectId, body.text));
    }
    if (type === 'project.step') {
      return ok(await service.step(body.projectId, body.trigger ?? 'manual'));
    }
    if (type === 'node.merge') {
      return ok(await service.createMergeNode(body.projectId, body));
    }
    if (type === 'project.push') {
      return ok(await service.pushProject(body.projectId, body));
    }
    if (type === 'node.finish_merge') {
      return ok(await service.finishMerge(body.projectId, body.nodeId, body));
    }
    if (type === 'node.successor') {
      return ok(await service.createSuccessor(body.projectId, body.nodeId, body));
    }
    if (type === 'node.approve') {
      return ok(await service.approveProposal(body.projectId, body.nodeId));
    }
    if (type === 'node.reject') {
      return ok(await service.rejectProposal(body.projectId, body.nodeId));
    }
    if (type === 'auto.start') {
      return ok(await service.autoStart(body.projectId));
    }
    if (type === 'auto.stop') {
      return ok(await service.autoStop(body.projectId));
    }
    if (type === 'auto.resume') {
      return ok(await service.autoResume(body.projectId));
    }
    if (type === 'expert_hire') {
      return ok(await service.hireExpert(body.projectId, body));
    }
    if (type === 'expert_drain') {
      return ok(await service.drainExpert(body.projectId, body));
    }
    if (type === 'expert_fire') {
      return ok(await service.fireExpert(body.projectId, body));
    }
    const error = new Error(`unknown command: ${String(type)}`);
    error.code = 'unknown_command';
    throw error;
  });

  return () => {
    for (const dispose of disposers) {
      try {
        const pending = dispose();
        if (pending && typeof pending.catch === 'function') pending.catch(() => {});
      } catch {
        // Route removal during teardown is best-effort.
      }
    }
  };
}
