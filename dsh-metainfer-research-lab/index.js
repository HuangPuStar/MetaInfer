/**
 * MetaInfer Research Lab — Host half (M1).
 *
 * Wires the storage domain, GitEngine, lab service and HTTP routes. The bundle is
 * installed as a linked local directory, so it must not import `@deepseek-ai/*`
 * packages: only Node built-ins, the MCP SDK, and our own `zod` dependency are
 * imported.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openStore, unmigratedLegacyDomain } from './host/store.js';
import { createGitEngine } from './host/git-engine.js';
import { createLabService } from './host/lab-service.js';
import { createRuntime } from './host/runtime.js';
import { createTranscriptReader } from './host/transcript.js';
import { createOrchestrator } from './host/orchestrator.js';
import { registerAgentTool } from './host/agent-tool.js';
import { registerHttpRoutes } from './host/http.js';
import { registerTrajectoryWeb } from './host/trajectory-web.js';
import { registerMcp } from './host/mcp.js';
import { ensureTrajectoryBackend } from './host/trajectory-backend.js';
import { reconcileRunningNodes, reconcileRunningRuns } from './host/reconcile.js';
import { createGcRunner } from './host/gc.js';
import { createAutoController } from './host/auto.js';
import { createClusterAdmin } from './host/cluster.js';
import { createKernel } from './host/kernel/instance.js';
import { createDispatchOnce } from './host/dispatch/dispatch-once.js';
import { usageBySourceOf } from './host/kernel/priority.js';
import { createOperatorAuthority } from './host/operator-token.js';
import { createLocalPoolBroker, createClusterBroker } from './host/dispatch/brokers.js';
import { assertModelSchemas } from './host/model-schemas.js';

export const name = 'metainfer-research-lab';
export const inject = [
  'connection',
  'storageDomain',
  'subprocess',
  'agents',
  'agentPresets',
  'subagents',
  'agentDefaultModel',
  'llm',
  'sessionQuery',
  'sessions',
  'tools',
];

/** Evidence that this code generation activated (used by dev verification, not by the UI). */
async function writeActivationMarker(version) {
  try {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const dir = path.join(home, 'metainfer-research-lab');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'activation.json'),
      `${JSON.stringify({ plugin: 'dsh-metainfer-research-lab', version, pid: process.pid, at: new Date().toISOString() }, null, 2)}\n`,
    );
  } catch {
    // The marker is diagnostic only; never block activation.
  }
}

function readCtxConfig(ctx) {
  try {
    return ctx.config ?? {};
  } catch {
    return {};
  }
}

export async function apply(ctx, config = {}) {
  // Fail plugin boot, not the L1 lead stage, when a model-facing schema uses
  // a keyword the provider's structured-output subset rejects.
  assertModelSchemas();
  const cfg = config && Object.keys(config).length ? config : readCtxConfig(ctx);
  const store = await openStore(ctx, config);
  // Fail loud when the v2 domain has never been migrated and a v1 domain with
  // data is still on disk: a silently empty lab looks like data loss.
  const legacy = unmigratedLegacyDomain();
  if (legacy && store.listProjects().length === 0) {
    throw new Error(
      `the v2 domain is empty but the pre-refactor domain still exists at ${legacy}. `
      + 'Run `node scripts/migrate-domain.mjs run` once, then reload the plugin.',
    );
  }
  const git = createGitEngine(ctx);
  // The kernel is the only writer; the projection is kept in sync by the store
  // subscription inside createKernel.
  // G1: strictWrites defaults to `throw`. Every production writer goes through
  // kernel.executor (runtime/GC/reconcile/auto/service/orchestrator); any new
  // direct `store.save*` becomes a visible failure instead of silent drift.
  const strictWrites = cfg?.kernel?.strictWrites ?? 'throw';
  store.setStrictWrites(strictWrites);
  const kernel = createKernel({ store, logger: ctx.logger });
  for (const project of store.listProjects()) kernel.load(project.id);

  // Lightweight cluster coordinator (optional, enabled by
  // ~/.dsh/metainfer-research-lab/cluster.json). Absent => local mode unchanged.
  const clusterConfigPath = path.join(
    process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'),
    'metainfer-research-lab',
    'cluster.json',
  );
  const clusterAdmin = createClusterAdmin({ ctx, store, configPath: clusterConfigPath, logger: ctx.logger });
  await clusterAdmin.boot();
  const cluster = clusterAdmin.facade;
  const clusterInfo = cluster.getStatus();

  // No Agent survives a plugin reload: mark stale running nodes failed before
  // anything new can run, and release their resource ledger entries.
  const reconciled = await reconcileRunningNodes({ store, kernel });
  const reconciledRuns = await reconcileRunningRuns({ store, kernel });

  let gcRunner = null;
  // One long-lived broker map per project: leases must survive across ticks.
  const brokerMaps = new Map();
  function brokersFor(projectId) {
    let map = brokerMaps.get(projectId);
    if (map) return map;
    map = new Map();
    map.set('local-pool', createLocalPoolBroker({
      limits: () => {
        const project = store.getProject(projectId);
        return {
          maxRunningNodes: project?.config?.maxRunningNodes ?? Infinity,
          resourcePools: project?.config?.resourcePools ?? {},
        };
      },
    }));
    if (cluster?.enabled === true) map.set('cluster', createClusterBroker({ cluster }));
    brokerMaps.set(projectId, map);
    return map;
  }

  function dispatchOnce(projectId, options = {}) {
    const project = store.getProject(projectId);
    if (!project) return Promise.resolve({ started: 0, startedNodeIds: [], skipped: [{ status: 'project_not_found' }], durationMs: 0 });
    kernel.load(projectId);
    const brokers = brokersFor(projectId);
    for (const broker of brokers.values()) broker.releaseOrphans?.(store.listNodes(projectId));
    const dispatcher = createDispatchOnce({
      projectId,
      executor: kernel.executor,
      projection: kernel.projection,
      brokers,
      launcher: {
        start: (pid, nodeId, opts) => runtime.start(pid, nodeId, opts),
        preempt: (pid, nodeId, opts) => runtime.preempt(pid, nodeId, opts),
      },
      maxStarts: options.maxStarts ?? 8,
      // 5.3.4: fair share is driven by the durable GPU-seconds ledger, not by
      // an empty map that made every source start at zero on every round.
      usageBySource: () => usageBySourceOf(store.listNodes(projectId)),
    });
    return dispatcher.run({
      maxStarts: options.maxStarts,
      config: project.config,
      maxRunningNodes: project.config?.maxRunningNodes ?? Infinity,
    });
  }

  let service = null;
  // The auto tick must run the same housekeeping as the explicit dispatch_once
  // tool (timeout defaults, rotation, observer escalation), not raw dispatch.
  // `service` is assigned below; early lifecycle calls fall back to raw.
  const autoDispatch = async (projectId, options = {}) => (service
    ? service.dispatchOnce(projectId, { ...options, includeStatus: false })
    : dispatchOnce(projectId, options));

  const runtime = createRuntime({
    ctx,
    store,
    git,
    onTerminated: (projectId, nodeId, termination) => {
      gcRunner?.run(projectId, nodeId, termination).catch(() => {});
      // Backfill immediately instead of waiting for the next 2 s tick.
      autoDispatch(projectId, { maxStarts: 4 }).catch(() => {});
    },
    cluster,
    kernel,
  });
  const transcript = createTranscriptReader({ ctx, store });
  const orchestrator = createOrchestrator({ ctx, store, git, runtime, cluster, kernel });
  gcRunner = createGcRunner({ ctx, store, orchestrator, kernel });
  const auto = createAutoController({ store, kernel, orchestrator, cluster, dispatchOnce: autoDispatch });
  const operatorAuthority = createOperatorAuthority();
  service = createLabService({
    ctx,
    store,
    git,
    runtime,
    transcript,
    orchestrator,
    auto,
    cluster,
    clusterAdmin,
    kernel,
    dispatchOnce,
    operatorAuthority,
    version: '0.11.0',
  });

  // Publish the Host service for future phases (routes and agent tools share it).
  ctx.provide('metainferLab', service);

  ctx.effect(
    () => () => store.close().catch(() => {}),
    'metainfer-research-lab: storage domain',
  );

  ctx.effect(
    () => registerHttpRoutes(ctx, service),
    'metainfer-research-lab: http routes',
  );

  const webServer = ctx.get('webServer');
  if (webServer) {
    ctx.effect(() => ctx.on('webserver/index-inject', (table, peer) => {
      // Only the owner page gets the browser credential. It is read fresh on
      // every index render and is never returned by an API response.
      if (peer?.principal?.kind !== 'owner') return;
      table.push({
        kind: 'global',
        name: '__METAINFER_OPERATOR_TOKEN__',
        value: operatorAuthority.token,
      });
    }), 'metainfer-research-lab: operator token injection');
    const trajectoryBackend = await ensureTrajectoryBackend(ctx.logger);
    ctx.effect(
      () => () => {
        if (trajectoryBackend.owned && trajectoryBackend.process) {
          try { trajectoryBackend.process.kill('SIGTERM'); } catch { /* already gone */ }
        }
      },
      'metainfer-research-lab: trajectory backend lifecycle',
    );
    ctx.effect(
      () => registerTrajectoryWeb(ctx, webServer),
      'metainfer-research-lab: trajectory web bridge',
    );
    ctx.effect(
      () => registerMcp(ctx, webServer, service),
      'metainfer-research-lab: MCP control surface',
    );
  }

  ctx.effect(
    () => registerAgentTool(ctx, service),
    'metainfer-research-lab: agent tool',
  );

  ctx.effect(
    () => service.startDashboardScheduler(),
    'metainfer-research-lab: dashboard scheduler',
  );

  ctx.effect(() => {
    const timer = setInterval(() => {
      runtime.tick().catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, 'metainfer-research-lab: timeout watchdog');

  ctx.effect(
    () => ctx.on('session/event', (session, event) => {
      runtime.onSessionEvent(session, event).catch(() => {});
    }),
    'metainfer-research-lab: session events',
  );

  ctx.effect(
    () => () => runtime.dispose(),
    'metainfer-research-lab: runtime',
  );

  ctx.effect(
    () => () => kernel.dispose(),
    'metainfer-research-lab: kernel projection',
  );

  ctx.effect(
    () => () => orchestrator.dispose(),
    'metainfer-research-lab: orchestrator',
  );

  ctx.effect(
    () => () => gcRunner?.dispose(),
    'metainfer-research-lab: gc runner',
  );

  ctx.effect(() => {
    auto.startTimer();
    return () => auto.dispose();
  }, 'metainfer-research-lab: auto controller');

  ctx.effect(
    () => runtime.startLeasePump(2000),
    'metainfer-research-lab: gpu lease pump',
  );

  ctx.effect(
    () => () => clusterAdmin.stop(),
    'metainfer-research-lab: cluster manager',
  );

  ctx.logger?.info?.(`metainfer-research-lab: cluster mode=${clusterInfo.mode} enabled=${Boolean(clusterInfo.enabled)}`);
  await writeActivationMarker('0.11.0');
  ctx.logger?.info?.(`metainfer-research-lab: M4 host ready (reconciled ${reconciled.length} running node(s))`);
}
