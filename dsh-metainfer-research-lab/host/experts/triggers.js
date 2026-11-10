/**
 * B13 / 5.3.9: six deterministic trigger codes.
 *
 * These are Host predicates, not LLM opinions. Each code has a stable name,
 * a machine-readable detail payload, and no model in the evaluation path. The
 * observer returns them so an expert is invoked by a reproducible condition
 * rather than by a model deciding that something "looks wrong".
 */
import { runnableQueue } from '../kernel/runnable.js';
import { comparePriority } from '../kernel/priority.js';

export const TRIGGER_CODES = Object.freeze([
  'stalled_node',
  'starving_node',
  'driver_paused',
  'repeated_failure',
  'priority_inversion',
  'duplicate_candidates',
]);

function idleMs(node, now) {
  const at = Number(node?.timestamps?.lastActivityAt ?? node?.lastEventAt ?? node?.timestamps?.startedAt ?? 0);
  return at > 0 ? Math.max(0, now - at) : 0;
}

/**
 * @param {{nodes?: object[], auto?: {status?: string, pauseReason?: string}, now?: number, stalledMs?: number, starvingMs?: number}} input
 * @returns {{code: string, detail: object}[]}
 */
export function evaluateTriggers(input = {}) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const nodes = Array.isArray(input.nodes) ? input.nodes : [];
  const stalledMs = Number.isFinite(input.stalledMs) ? input.stalledMs : 15 * 60_000;
  const starvingMs = Number.isFinite(input.starvingMs) ? input.starvingMs : 5 * 60_000;
  const triggers = [];
  const running = nodes.filter((node) => node.status === 'running');
  const queue = runnableQueue(nodes, now);

  for (const node of running) {
    const idle = idleMs(node, now);
    if (idle >= stalledMs) {
      triggers.push({ code: 'stalled_node', detail: { nodeId: node.id, idleMs: idle, thresholdMs: stalledMs } });
      break;
    }
  }

  const starving = queue.filter((node) => {
    const at = Number(node.timestamps?.createdAt ?? node.createdAt ?? 0);
    return at > 0 && now - at >= starvingMs;
  });
  if (starving.length > 0) {
    triggers.push({ code: 'starving_node', detail: { nodeIds: starving.slice(0, 20).map((node) => node.id), waitingMs: Math.max(...starving.map((node) => now - Number(node.timestamps?.createdAt ?? 0))) } });
  }

  if (input.auto?.status === 'paused') {
    triggers.push({ code: 'driver_paused', detail: { pauseReason: input.auto.pauseReason ?? null } });
  }

  const failed = nodes.filter((node) => node.status === 'failed' || Number(node.attempt) >= 3);
  if (failed.length > 0) {
    triggers.push({ code: 'repeated_failure', detail: { nodeIds: failed.slice(0, 20).map((node) => node.id), maxAttempt: Math.max(...failed.map((node) => Number(node.attempt ?? 1))) } });
  }

  if (queue.length > 0 && running.length > 0) {
    const bestQueued = queue[0];
    const worstRunning = running.slice().sort((a, b) => comparePriority(b, a))[0];
    if (bestQueued && worstRunning && comparePriority(bestQueued, worstRunning) < 0
      && bestQueued.priority?.class === 'p0' && worstRunning.priority?.class !== 'p0') {
      triggers.push({ code: 'priority_inversion', detail: { queued: bestQueued.id, running: worstRunning.id } });
    }
  }

  const byTitle = new Map();
  for (const node of nodes) {
    if (node.kind === 'merge') continue;
    const key = String(node.title ?? '').trim().toLowerCase();
    if (!key) continue;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(node.id);
  }
  const duplicates = [...byTitle.values()].filter((ids) => ids.length > 1);
  if (duplicates.length > 0) {
    triggers.push({ code: 'duplicate_candidates', detail: { groups: duplicates.slice(0, 10) } });
  }

  return triggers;
}
