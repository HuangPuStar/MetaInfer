/**
 * The deadline sweep is the store-driven counterpart of the runtime's in-memory
 * deadline map: a node whose worker died (killed agent, dropped provider, a
 * plugin reload between launch and expiry) used to stay `running` forever,
 * holding resourcesHeld and a maxRunningNodes slot until the next restart. Four
 * nodes were observed 10-44 minutes past their deadline with zero GPU activity.
 *
 * Run: node scripts/deadline-sweep-selftest.mjs
 */
import { sweepOverdueNodes, TIMEOUT_SWEEP_GRACE_MS } from '../host/reconcile.js';

let failed = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`ok   ${name}`);
  else { failed += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** Minimal committed store: the sweep only needs listProjects/listNodes/getNode and a commit sink. */
function fakeStore(nodes) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return {
    listProjects: () => [{ id: 'p1' }],
    listNodes: () => [...byId.values()],
    getNode: (_projectId, nodeId) => byId.get(nodeId) ?? null,
  };
}

function fakeKernel(commits) {
  return {
    executor: {
      commit: async (projectId, payload) => {
        for (const mutation of payload.mutations) {
          if (mutation.op === 'node.put') commits.push({ projectId, node: mutation.node, eventType: mutation.eventType, eventData: mutation.eventData });
        }
        return { ok: true };
      },
    },
  };
}

const now = 1_000_000_000_000;
const running = (id, deadlineAt, extra = {}) => ({
  id,
  projectId: 'p1',
  status: 'running',
  deadlineAt,
  resourcesHeld: { gpu: 1 },
  lease: { id: 'l1' },
  attempts: [{ index: 1, startedAt: deadlineAt - 600_000 }],
  timestamps: { startedAt: deadlineAt - 600_000 },
  ...extra,
});

// 1. a node past its deadline + grace is swept
{
  const commits = [];
  const store = fakeStore([running('n-over', now - TIMEOUT_SWEEP_GRACE_MS - 5_000)]);
  const swept = await sweepOverdueNodes({ store, kernel: fakeKernel(commits), now });
  const node = commits[0]?.node ?? null;
  check('an overdue running node is swept', swept.length === 1 && swept[0] === 'p1/n-over', JSON.stringify(swept));
  check('the swept node is failed with a timeout marker',
    node?.status === 'failed' && node?.errorStage === 'timeout', JSON.stringify({ status: node?.status, errorStage: node?.errorStage }));
  check('the sweep releases held resources',
    node && !('resourcesHeld' in node) && !('lease' in node) && node.deadlineAt === null,
    JSON.stringify({ resourcesHeld: node?.resourcesHeld, lease: node?.lease, deadlineAt: node?.deadlineAt }));
  check('the sweep closes the attempt as a timeout',
    node?.attempts?.[0]?.status === 'failed' && node?.attempts?.[0]?.stopReason === 'timeout',
    JSON.stringify(node?.attempts?.[0]));
  check('the sweep records a timeout termination',
    node?.termination?.kind === 'timeout' && node?.termination?.gpuFreed === true, JSON.stringify(node?.termination));
  check('the sweep emits node/failed with swept:true',
    commits[0]?.eventType === 'node/failed' && commits[0]?.eventData?.swept === true, JSON.stringify(commits[0]?.eventData));
}

// 2. inside the grace window the node is left alone
{
  const commits = [];
  const store = fakeStore([running('n-grace', now - 5_000)]);
  const swept = await sweepOverdueNodes({ store, kernel: fakeKernel(commits), now });
  check('a node inside its grace window is left running', swept.length === 0 && commits.length === 0, JSON.stringify(swept));
}

// 3. a node without a deadline is never swept (deliberately parked)
{
  const commits = [];
  const store = fakeStore([running('n-parked', null)]);
  const swept = await sweepOverdueNodes({ store, kernel: fakeKernel(commits), now });
  check('a node without a deadline is never swept', swept.length === 0 && commits.length === 0, JSON.stringify(swept));
}

// 4. non-running nodes are untouched
{
  const commits = [];
  const store = fakeStore([
    running('n-done', now - 10_000_000, { status: 'completed' }),
    running('n-plan', now - 10_000_000, { status: 'planned' }),
  ]);
  const swept = await sweepOverdueNodes({ store, kernel: fakeKernel(commits), now });
  check('completed and planned nodes are untouched', swept.length === 0 && commits.length === 0, JSON.stringify(swept));
}

if (failed > 0) {
  console.log(`\ndeadline-sweep-selftest: ${failed} failed`);
  process.exit(1);
}
console.log('\ndeadline-sweep-selftest: all checks passed');
