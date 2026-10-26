/**
 * MetaInfer Research Lab — Host half (M1).
 *
 * Wires the storage domain, GitEngine, lab service and HTTP routes. The bundle is
 * installed as a linked local directory, so it must not import `@deepseek-ai/*`
 * packages: only Node built-ins and our own `zod` dependency are imported.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openStore } from './host/store.js';
import { createGitEngine } from './host/git-engine.js';
import { createLabService } from './host/lab-service.js';
import { createRuntime } from './host/runtime.js';
import { createTranscriptReader } from './host/transcript.js';
import { createOrchestrator } from './host/orchestrator.js';
import { registerAgentTool } from './host/agent-tool.js';
import { registerHttpRoutes } from './host/http.js';
import { reconcileRunningNodes, reconcileRunningRuns } from './host/reconcile.js';
import { createGcRunner } from './host/gc.js';
import { createAutoController } from './host/auto.js';
import { createClusterAdmin } from './host/cluster.js';

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

export async function apply(ctx) {
  const store = await openStore(ctx);
  const git = createGitEngine(ctx);

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
  const reconciled = await reconcileRunningNodes({ store });
  const reconciledRuns = await reconcileRunningRuns({ store });

  let gcRunner = null;
  const runtime = createRuntime({
    ctx,
    store,
    git,
    onTerminated: (projectId, nodeId, termination) => {
      gcRunner?.run(projectId, nodeId, termination).catch(() => {});
    },
    cluster,
  });
  const transcript = createTranscriptReader({ ctx, store });
  const orchestrator = createOrchestrator({ ctx, store, git, runtime, cluster });
  gcRunner = createGcRunner({ ctx, store, orchestrator });
  const auto = createAutoController({ store, orchestrator, cluster });
  const service = createLabService({
    ctx,
    store,
    git,
    runtime,
    transcript,
    orchestrator,
    auto,
    cluster,
    clusterAdmin,
    version: '0.8.9-v3',
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

  ctx.effect(
    () => registerAgentTool(ctx, service),
    'metainfer-research-lab: agent tool',
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
  await writeActivationMarker('0.8.9-v3');
  ctx.logger?.info?.(`metainfer-research-lab: M4 host ready (reconciled ${reconciled.length} running node(s))`);
}
