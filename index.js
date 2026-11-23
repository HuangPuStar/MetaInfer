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
import { createProfilerStore } from './host/profiler/store.js';
import { registerPerfettoWeb } from './host/profiler/perfetto-assets.js';
import { registerTrajectoryWeb } from './host/trajectory-web.js';
import { registerMcp } from './host/mcp.js';
import { createWebotsBridge, defaultTablePath as defaultWebotsTablePath } from './host/webots-bridge.js';
import { ensureTrajectoryBackend } from './host/trajectory-backend.js';
import { reconcileRunningNodes, reconcileRunningRuns } from './host/reconcile.js';
import { createGcRunner } from './host/gc.js';
import { createAutoController } from './host/auto.js';
import { createClusterAdmin } from './host/cluster.js';
import { createKernel } from './host/kernel/instance.js';
import { createDispatchOnce } from './host/dispatch/dispatch-once.js';
import { usageBySourceOf } from './host/kernel/priority.js';
import { createOperatorAuthority } from './host/operator-token.js';
import { createLocalPoolBroker, createClusterBroker, createSandboxAdmissionBroker } from './host/dispatch/brokers.js';
import { createHostBudget } from './host/dispatch/host-budget.js';
import { createHostBudgetWriter } from './host/dispatch/host-budget-writer.js';
import { createBudgetBroker } from './host/dispatch/budget-broker.js';
import { createHostAdmission } from './host/dispatch/host-admission.js';
import { createSandboxBackend } from './host/sandbox-backend.js';
import { createBindingWriter } from './host/sandbox-binding.js';
import { createSandboxWorkerPolicy, SANDBOX_PRESET } from './host/sandbox-worker.js';
import { createSandboxRuntime } from './host/sandbox-runtime.js';
import { assertModelSchemas } from './host/model-schemas.js';
import { assertRolePresets } from './host/role-presets.js';

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
  // Registry settlement can await this Host's Loader. Never resolve inside
  // our own activation; validate executable references on admitted starts.
  let activationComplete = false;
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
  const readNode = (projectId, nodeId) => {
    const node = store.getNode(projectId, nodeId); return node ? structuredClone(node) : null;
  };
  const commitBinding = createBindingWriter({ store, kernel });
  const sandboxBackend = createSandboxBackend({ ctx, readNode, commitBinding });
  const sandboxPolicy = createSandboxWorkerPolicy({ ctx, backend: sandboxBackend, commitBinding,
    readOwner: (sessionId) => {
      const owners = store.listProjects().flatMap(project => store.listNodes(project.id)
        .filter(node => node.sessionId === sessionId && node.execution?.sandboxProfile)
        .map(node => ({ project: structuredClone(project), node: structuredClone(node) })));
      return owners.length === 1 ? owners[0] : null;
    } });
  ctx.effect(() => () => sandboxPolicy.dispose(), 'metainfer-research-lab: sandbox tool boundary');
  const hostBudget = createHostBudget({ readNode,
    readProject: projectId => structuredClone(store.getProject(projectId)),
    readNodes: projectId => structuredClone(store.listNodes(projectId)),
    commitReservation: createHostBudgetWriter({ store, kernel }) });
  const brokerInitializations = new Map();
  async function brokersFor(projectId) {
    if (brokerMaps.has(projectId)) return brokerMaps.get(projectId);
    if (brokerInitializations.has(projectId)) return brokerInitializations.get(projectId);
    const building = (async () => {
      const limits = () => ({ maxRunningNodes: store.getProject(projectId)?.config?.maxRunningNodes ?? Infinity,
        resourcePools: store.getProject(projectId)?.config?.resourcePools ?? {} });
      const raw = [createLocalPoolBroker({ limits }), createSandboxAdmissionBroker({ readNode, limits })];
      if (cluster?.enabled === true) raw.push(createClusterBroker({ cluster }));
      const map = new Map(raw.map(broker => [broker.id, createBudgetBroker({ raw: broker, budget: hostBudget, readNode })]));
      // Cold uncertainty remains in the durable budget. Never recreate an external lease.
      for (const node of store.listNodes(projectId)) {
        const lease = node.admission;
        if (lease?.broker === 'sandbox-admission' && node.hostBudgetReservation) {
          try { await map.get(lease.broker).adopt(lease); }
          catch { ctx.logger?.warn?.(`sandbox admission remains held for ${projectId}/${node.id}`); }
        }
      }
      brokerMaps.set(projectId, map); return map;
    })();
    brokerInitializations.set(projectId, building);
    try { return await building; } finally { brokerInitializations.delete(projectId); }
  }
  const hostAdmission = createHostAdmission({ store, kernel, budget: hostBudget, brokersFor,
    start: (projectId, nodeId, options) => runtime.start(projectId, nodeId, options) });

  async function dispatchOnce(projectId, options = {}) {
    const project = store.getProject(projectId);
    if (!project) return Promise.resolve({ started: 0, startedNodeIds: [], skipped: [{ status: 'project_not_found' }], durationMs: 0 });
    kernel.load(projectId);
    const brokers = await brokersFor(projectId);
    for (const broker of brokers.values()) await broker.releaseOrphans?.(store.listNodes(projectId));
    const dispatcher = createDispatchOnce({
      projectId,
      executor: kernel.executor,
      projection: kernel.projection,
      brokers,
      brokerIdFor: request => hostAdmission.brokerIdFor(request, brokers),
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

  const runtimeCore = createRuntime({
    ctx,
    store,
    git,
    onTerminated: (projectId, nodeId, termination) => {
      const node = readNode(projectId, nodeId);
      if (node?.execution?.sandboxProfile || node?.sandbox?.backend === 'opensandbox') {
        // A container result must never launch a Host-shell GC/followup in manual mode.
        if (store.getProject(projectId)?.mode === 'auto') autoDispatch(projectId, { maxStarts: 4 }).catch(() => {});
        return;
      }
      gcRunner?.run(projectId, nodeId, termination).catch(() => {});
      // Backfill immediately instead of waiting for the next 2 s tick.
      autoDispatch(projectId, { maxStarts: 4 }).catch(() => {});
    },
    cluster,
    kernel,
    sandboxFactory: createSandboxRuntime,
    sandboxBackend,
    hostAdmission,
    sandboxAdmission: { request: hostAdmission.request, verify: hostAdmission.verify,
      beforeEffects: hostAdmission.beforeEffects,
      release: (projectId, lease) => hostAdmission.release(projectId, lease.nodeId, lease),
      finalize: (projectId, nodeId) => hostAdmission.finalize(projectId, nodeId) },
  });
  const runtime = { ...runtimeCore, async start(projectId, nodeId, options) {
    if (!activationComplete) throw Object.assign(new Error('Host activation is not settled; no Agent may start'), { code: 'HOST_ACTIVATION_PENDING' });
    await assertRolePresets(ctx.agentPresets);
    if (!activationComplete) throw Object.assign(new Error('Host activation is not settled; no Agent may start'), { code: 'HOST_ACTIVATION_PENDING' });
    const node = readNode(projectId, nodeId);
    if (node && (Object.hasOwn(node.execution ?? {}, 'sandboxProfile') || node.sandbox?.backend === 'opensandbox' || node.admission?.profile || node.sandboxGate)) {
      await assertRolePresets(ctx.agentPresets, { sandboxWorker: SANDBOX_PRESET });
    }
    if (!activationComplete) throw Object.assign(new Error('Host activation is not settled; no Agent may start'), { code: 'HOST_ACTIVATION_PENDING' });
    return runtimeCore.start(projectId, nodeId, options);
  } };
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

  // Issue #94: profiling traces are Host-memory only; the store keeps the last
  // few opened traces queryable and never writes into the user's repository.
  const profiler = createProfilerStore();

  ctx.effect(
    () => registerHttpRoutes(ctx, service, { operatorAuthority, profiler }),
    'metainfer-research-lab: http routes',
  );

  // WeBots project agents: one poller per binding in the token table. Inert while
  // the table is missing, so a fresh install behaves exactly as before.
  const webotsConfig = cfg?.webotsBridge ?? {};
  if (webotsConfig.enabled !== false) {
    const webotsBridge = createWebotsBridge({
      service,
      logger: ctx.logger,
      tablePath: webotsConfig.tokenTable || defaultWebotsTablePath(),
      pollMs: webotsConfig.pollMs ?? 3000,
    });
    ctx.effect(
      () => {
        webotsBridge.start();
        return () => webotsBridge.stop();
      },
      'metainfer-research-lab: webots bridge',
    );
  }

  const webServer = ctx.get('webServer');
  if (webServer) {
    ctx.effect(() => ctx.on('webserver/index-inject', (table, peer) => {
      // Only the owner page gets the browser credential. It is read fresh on
      // every index render and is never returned by an API response.
      //
      // Older Hosts passed the requesting peer as the second emit argument and a
      // strict `peer.principal.kind !== 'owner'` guard made sense. Current Hosts
      // emit ONLY the table (dsh-host-webserver: collectIndexInjections() emits a
      // single argument), so `peer` is undefined for every subscriber and the guard
      // silently dropped the token from every index render — the browser then had
      // no write credential on any page, no matter how often it was reloaded.
      // Keep the owner check when a peer is supplied; inject when it is absent.
      if (peer && peer.principal?.kind !== 'owner') return;
      table.push({
        kind: 'global',
        name: '__METAINFER_OPERATOR_TOKEN__',
        value: operatorAuthority.token,
      });
      // The issue time lets an already-open page compare itself with the
      // current Host process via the read-only /health field. It is metadata,
      // not a credential, and is only rendered to the owner page.
      table.push({
        kind: 'global',
        name: '__METAINFER_OPERATOR_ISSUED_AT__',
        value: operatorAuthority.issuedAt,
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
    // Issue #94 follow-up: serve the pinned Perfetto UI build from this origin
    // (offline, same-origin => no trust prompt). Missing assets answer 404 and
    // the Client falls back to ui.perfetto.dev.
    const perfettoUiRoot = path.join(
      process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'),
      'metainfer-research-lab',
      'perfetto-ui',
    );
    ctx.effect(
      () => registerPerfettoWeb(webServer, { uiRoot: perfettoUiRoot, logger: ctx.logger }),
      'metainfer-research-lab: perfetto ui',
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
    () => () => { activationComplete = false; return runtime.dispose(); },
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
  activationComplete = true;
}
