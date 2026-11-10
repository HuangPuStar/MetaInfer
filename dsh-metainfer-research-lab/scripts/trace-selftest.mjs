/**
 * Cause-chain acceptance test (U4/U9/O8):
 *   - executor events carry `causeId` and `explain_node` resolves them;
 *   - the runtime write path stamps `causeId` on live transitions;
 *   - the UI/HTTP explain path exists and the report headline is derived.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../host/store.js';
import { createKernel } from '../host/kernel/instance.js';
import { createExplainer } from '../host/observability/explain.js';
import { createRuntime } from '../host/runtime.js';
import { normalizeNodeReport, REPORT_LIMITS } from '../host/runtime.js';
import { reconcileRunningNodes } from '../host/reconcile.js';
import { createGcRunner } from '../host/gc.js';
import { memoryDomain, storeContext } from './lib/memory-domain.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`ok   ${name}`);
  else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const store = await openStore(storeContext(memoryDomain()));
let now = 10_000;
const clock = () => now;
// Use the production kernel wiring (projection subscribes to store writes), so
// legacy runtime writes are visible to `explain_node` exactly as in the Host.
const kernel = createKernel({ store, clock });
const projection = kernel.projection;
const executor = kernel.executor;
await store.saveProject({
  id: 'p',
  revision: 0,
  counters: { eventSeq: 0 },
  config: { maxRunningNodes: 2, resourcePools: { gpu: 2 }, maxNodes: 100 },
  repo: { path: ROOT },
  updatedAt: 0,
  createdAt: 0,
});
kernel.load('p');
const human = { kind: 'human', id: 'operator' };

// 1. Proposal -> start -> failure, each with an explicit cause, like the runtime.
await executor.commit('p', {
  actor: human,
  causeId: 'proposal-r1',
  mutations: [{ op: 'node.create', node: { id: 'n1', title: 'root', status: 'planned', needs: { gpu: 1 }, timeboxMs: 60_000, priority: { class: 'p1' }, timestamps: { createdAt: 1 } } }],
});
await executor.commit('p', {
  actor: human,
  causeId: 'n1-a1',
  mutations: [{ op: 'node.transition', nodeId: 'n1', to: 'running', set: { timestamps: { startedAt: 9_000 } } }],
});
await executor.commit('p', {
  actor: human,
  causeId: 'n1-a1',
  mutations: [{ op: 'node.transition', nodeId: 'n1', to: 'failed', set: { error: { code: 'timeout', message: 'timeout after 10min' } } }],
});
const node = store.getNode('p', 'n1');
check('node stores its cause pointer', node.causeId === 'n1-a1' || node.lastCauseId === 'n1-a1', JSON.stringify({ causeId: node.causeId, lastCauseId: node.lastCauseId }));
const events = store.listEvents('p', 0).filter((event) => event.nodeId === 'n1');
check('every node event carries a causeId', events.length >= 3 && events.every((event) => typeof event.causeId === 'string' && event.causeId.length > 0), JSON.stringify(events.map((event) => [event.type, event.causeId ?? null])));

const explainer = createExplainer({ store, projection, clock });
const explained = explainer.explainNode('p', 'n1');
check('explain_node returns ok', explained.ok === true, JSON.stringify(explained));
check('explain_node exposes the node cause', explained.node.causeId === 'n1-a1' || explained.node.causeId === 'proposal-r1', JSON.stringify(explained.node));
check('cause chain resolves a real event', Array.isArray(explained.causeChain) && explained.causeChain.length > 0 && explained.causeChain.some((entry) => entry.kind === 'event'), JSON.stringify(explained.causeChain));
check('explain events are structured, not log text', Array.isArray(explained.events) && explained.events.every((event) => typeof event.type === 'string' && typeof event.causeId === 'string'), JSON.stringify(explained.events));
const traced = explainer.traceExplain('p', 'n1');
check('trace_explain exposes phases', Array.isArray(traced.phases) && traced.phases.some((phase) => phase.kind === 'start') && traced.phases.some((phase) => phase.kind === 'outcome'), JSON.stringify(traced.phases.map((phase) => phase.kind)));
check('trace phases carry causeId', traced.phases.every((phase) => typeof phase.causeId === 'string' && phase.causeId.length > 0));

// 2. The live write path must stamp causes for non-activation transitions too.
// A planned node has no activation, so `runtime.cancel()` is the probe that
// catches a path that only stamps starts/resumes.
await executor.commit('p', {
  actor: human,
  mutations: [{ op: 'node.create', node: { id: 'n2', title: 'cancel me', status: 'planned', timestamps: { createdAt: 2 } } }],
});
const runtime = createRuntime({ ctx: {}, store, git: null, onTerminated: () => {}, cluster: null, kernel });
await runtime.cancel('p', 'n2');
const cancelled = store.listEvents('p', 0).filter((event) => event.nodeId === 'n2' && event.type === 'node/cancelled');
check('planned cancel emits an event', cancelled.length === 1, JSON.stringify(cancelled));
check('planned cancel event has a causeId', typeof cancelled[0]?.causeId === 'string' && cancelled[0].causeId.length > 0, JSON.stringify(cancelled[0]?.causeId ?? null));
const cancelledExplain = explainer.explainNode('p', 'n2');
check('planned cancel is explainable', cancelledExplain.ok === true && cancelledExplain.causeChain.length > 0, JSON.stringify(cancelledExplain.causeChain));
// 2b. Real reconcile path: a legacy running node (no cause pointer) must gain a
// node-level cause, not only an event-level fallback.
await store.saveNode('p', { id: 'legacy', title: 'legacy running', status: 'running', timestamps: { createdAt: 3 } });
await reconcileRunningNodes({ store, kernel });
const legacy = store.getNode('p', 'legacy');
check('reconcile stamps the node cause pointer', typeof legacy.causeId === 'string' && legacy.causeId.length > 0, JSON.stringify({ causeId: legacy.causeId, lastCauseId: legacy.lastCauseId }));
const legacyExplain = explainer.explainNode('p', 'legacy');
check('reconcile node is explainable', legacyExplain.ok === true && legacyExplain.causeChain.length > 0, JSON.stringify(legacyExplain.causeChain));

// 2c. Real GC runner: postmortem node update and gc/finished event share a commit.
const gcCtx = {
  subagents: {
    async startActivation() {
      return {
        result: Promise.resolve({
          stopReason: 'completed',
          structured: { cause: 'timeout', leftovers: [], cleanupRequested: false, recommendation: 'retry', summary: 'timed out' },
        }),
        dispose: async () => {},
      };
    },
  },
};
const gcOrchestrator = { ensureController: async () => ({}) };
const gcRunner = createGcRunner({ ctx: gcCtx, store, orchestrator: gcOrchestrator, kernel });
await executor.commit('p', { actor: human, mutations: [{ op: 'node.create', node: { id: 'gc-node', title: 'gc me', status: 'running', timestamps: { createdAt: 4 } } }] });
const gcRecord = await gcRunner.run('p', 'gc-node', { kind: 'timeout' });
const gcCurrent = store.getNode('p', 'gc-node');
check('gc runner completed', gcRecord?.status === 'completed', JSON.stringify({ status: gcRecord?.status, error: gcRecord?.error }));
check('gc stamps the node cause pointer', typeof gcCurrent.causeId === 'string' && gcCurrent.causeId.length > 0, JSON.stringify({ causeId: gcCurrent.causeId, lastCauseId: gcCurrent.lastCauseId }));
const gcExplain = explainer.explainNode('p', 'gc-node');
check('gc node is explainable', gcExplain.ok === true && gcExplain.causeChain.length > 0, JSON.stringify(gcExplain.causeChain));

// 2d. Merge preparation travels through node.put, so the node pointer follows.
await executor.commit('p', {
  actor: human,
  causeId: 'merge-prep:p:n2',
  mutations: [{ op: 'node.put', node: { ...store.getNode('p', 'n2'), merge: { state: 'prepared' } }, eventType: 'node/merge_prepared', eventData: { state: 'prepared' } }],
});
const mergeExplain = explainer.explainNode('p', 'n2');
check('merge prep node is explainable', mergeExplain.ok === true && mergeExplain.causeChain.length > 0, JSON.stringify(mergeExplain.causeChain));
const runtimeSource = readFileSync(path.join(ROOT, 'host/runtime.js'), 'utf8');

// 3. UI + HTTP explain path.
const httpSource = readFileSync(path.join(ROOT, 'host/http.js'), 'utf8');
const clientSource = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
check('HTTP exposes /explain', /PREFIX\}\/explain/.test(httpSource) && /service\.explainNode/.test(httpSource));
check('client fetches explain', /fetchExplain\(projectId, nodeId/.test(clientSource) && /ROUTES\.explain/.test(clientSource));
check('inspector renders ExplainPanel', /function ExplainPanel/.test(clientSource) && /h\(ExplainPanel,/.test(clientSource));
check('explain panel has loading/empty/error states', /ws\.explain\.loading/.test(clientSource) && /ws\.explain\.empty/.test(clientSource) && /ws\.explain\.error/.test(clientSource));

// 4. Report source limits + Host-derived headline.
const report = normalizeNodeReport({ summary: 's'.repeat(900), success: true, changes: ['c'.repeat(3_000)], metrics: [], reproduce: [], blockers: [], next: [], risks: [] });
check('summary is bounded at the source', report.summary.length === REPORT_LIMITS.summary, String(report.summary.length));
check('headline is derived and bounded', report.headline.length === REPORT_LIMITS.headline, String(report.headline.length));
check('list items are bounded', report.changes[0].length <= REPORT_LIMITS.listItemChars);
check('empty summary yields null report', normalizeNodeReport({ summary: '   ' }) === null);
check('NODE_REPORT_SCHEMA bounds summary', /summary: \{ type: 'string', minLength: 1, maxLength: 500 \}/.test(runtimeSource));
const promptsSource = readFileSync(path.join(ROOT, 'host/prompts.js'), 'utf8');
check('worker prompt states the summary limit', /500 characters/.test(promptsSource) && /headline/.test(promptsSource));

console.log(`\n${failed === 0 ? 'trace-selftest: all checks passed' : `trace-selftest: ${failed} failed`}`);
process.exit(failed === 0 ? 0 : 1);
