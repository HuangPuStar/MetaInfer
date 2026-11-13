/**
 * The kernel instance: one executor + projection + bus per Host.
 *
 * Writes still happen in two places while the legacy runtime/service writers
 * are migrated (see docs/refactor/IMPLEMENTATION.md 未完成): the executor for
 * kernel commits and the plain `store.saveNode` calls in runtime/orchestrator.
 * The projection subscribes to every store node write, so a legacy write can
 * never leave the dispatcher looking at a stale status.
 */
import { createEventBus } from './bus.js';
import { createExecutor } from './executor.js';
import { createProjection } from './projection.js';

/**
 * @param {object} deps
 * @param {object} deps.store ProjectStore (must expose subscribeNodes)
 * @param {() => number} [deps.clock]
 * @param {object} [deps.logger]
 */
export function createKernel({ store, clock = Date.now, logger = null }) {
  const bus = createEventBus();
  const projection = createProjection({ store, clock });
  const executor = createExecutor({ store, clock, projection, bus });
  const loaded = new Set();

  function load(projectId) {
    if (loaded.has(projectId)) return projection.revision(projectId);
    projection.load(projectId);
    loaded.add(projectId);
    return projection.revision(projectId);
  }

  function unload(projectId) {
    projection.unload(projectId);
    loaded.delete(projectId);
  }

  function reload(projectId) {
    unload(projectId);
    return load(projectId);
  }

  const unsubscribe = typeof store.subscribeNodes === 'function'
    ? store.subscribeNodes((projectId, node, kind) => {
      if (!loaded.has(projectId)) return;
      try {
        if (kind === 'node.removed') projection.removeNode(projectId, node?.id);
        else if (node?.id) projection.syncNode(projectId, node);
      } catch (error) {
        logger?.warn?.(`kernel(${projectId}): projection sync failed: ${error?.message ?? error}`);
      }
    })
    : () => {};

  return {
    bus,
    projection,
    executor,
    load,
    unload,
    reload,
    isLoaded: (projectId) => loaded.has(projectId),
    dispose() {
      unsubscribe();
    },
  };
}
