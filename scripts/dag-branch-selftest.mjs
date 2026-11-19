/**
 * The lab graph is a DAG, not a frontier-only tree.
 *
 * Regression guard for the misimplementation that turned "a parent's commit is
 * frozen once it branches" into "a parent may never branch again":
 *
 *   1. a completed node may receive a NEW child even when it already has live
 *      ones (re-opening an older state after a review found a missing
 *      experiment). Duplicate WORK is still refused — by the prompt-hash check
 *      in checkProposal, not by a child count;
 *   2. `parent_already_has_successor` is gone, so every block recorded under
 *      that code is obsolete. Leaving branch-level blocks alive starved the
 *      queue: their structure fingerprint has no DAG-dependent field, so they
 *      could never expire and every planning pass produced zero candidates;
 *   3. `replacement_chain_exhausted` still blocks — the retry cap is real;
 *   4. the default prompts no longer tell experts that only leaves are legal
 *      parents.
 *
 * Run: node scripts/dag-branch-selftest.mjs
 */
import { readFileSync } from 'node:fs';
import { buildBranchCandidateQueue } from '../host/experts/candidates.js';

let failed = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`ok   ${name}`);
  else { failed += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** A branch report whose candidates carry no nodeId, i.e. branch-level ideas. */
const branchLevelRun = (id) => ({
  id,
  role: 'branch',
  status: 'completed',
  lens: 'n-0001',
  startedAt: 1,
  endedAt: 2,
  output: {
    branchId: 'n-0001',
    health: 'watch',
    candidates: [{ kind: 'idea', priority: 'p2', title: 're-open the older state and run the missing experiment' }],
  },
});

const baseQueue = buildBranchCandidateQueue({ project: {}, runs: [branchLevelRun('r1')] });
const candidateId = baseQueue.candidates[0]?.candidateId ?? null;
check('fixture: a branch-level candidate is produced', Boolean(candidateId) && baseQueue.pending.length === 1,
  JSON.stringify({ candidateId, pending: baseQueue.pending.length }));
check('fixture: the candidate has no source node (branch-level)', baseQueue.candidates[0]?.sourceNodeId == null,
  JSON.stringify({ sourceNodeId: baseQueue.candidates[0]?.sourceNodeId }));

// --- 1. an obsolete parent_already_has_successor block must not block -------
const obsoleteQueue = buildBranchCandidateQueue({
  project: {
    candidateBlocks: {
      [candidateId]: {
        code: 'parent_already_has_successor',
        reason: 'parent n-0007 already has a successor; propose from a leaf',
        structureKey: null,
        at: 1,
        cycleId: 'cyc-old',
      },
    },
  },
  runs: [branchLevelRun('r1')],
});
check('a legacy parent_already_has_successor block no longer blocks a branch-level candidate',
  obsoleteQueue.pending.length === 1 && obsoleteQueue.blocked.length === 0,
  JSON.stringify({ pending: obsoleteQueue.pending.length, blocked: obsoleteQueue.blocked.length, blockedCode: obsoleteQueue.blocked[0]?.blockedCode }));

// --- 2. the retry cap still blocks ----------------------------------------
const retryExhaustedQueue = buildBranchCandidateQueue({
  project: {
    candidateBlocks: {
      [candidateId]: {
        code: 'replacement_chain_exhausted',
        reason: 'replacement chain for n-0002 exhausted after 3 attempts',
        structureKey: null,
        at: 1,
        cycleId: 'cyc-old',
      },
    },
  },
  runs: [branchLevelRun('r1')],
});
check('replacement_chain_exhausted still blocks (the retry cap is real)',
  retryExhaustedQueue.blocked.length === 1 && retryExhaustedQueue.pending.length === 0,
  JSON.stringify({ pending: retryExhaustedQueue.pending.length, blocked: retryExhaustedQueue.blocked.length }));

// --- 3. the default prompts do not restrict branching to leaves ------------
const orchestratorSource = readFileSync(new URL('../host/orchestrator.js', import.meta.url), 'utf8');
const activationSource = readFileSync(new URL('../host/experts/activation.js', import.meta.url), 'utf8');
const payloadSource = readFileSync(new URL('../host/context/payload.js', import.meta.url), 'utf8');

check('the lead prompt no longer says "at most one successor per completed leaf"',
  !orchestratorSource.includes('Create at most one successor per completed leaf'));
check('the advisor prompt no longer says a parent with children cannot be extended',
  !orchestratorSource.includes('a completed node that already has a child cannot be extended'));
check('the expert prompt no longer requires a completed LEAF id',
  !activationSource.includes('parentId must be one of the completed leaf ids above'));
check('the payload guidance no longer forbids parents with children',
  !payloadSource.includes('a parent with children cannot be extended'));
check('the lead prompt now states that any completed node may get a successor',
  orchestratorSource.includes('Any completed node may receive a successor'));
check('the expert prompt now states that a parent with children is allowed',
  activationSource.includes('A parent that already has children is allowed'));

if (failed > 0) {
  console.log(`\ndag-branch-selftest: ${failed} failed`);
  process.exit(1);
}
console.log('\ndag-branch-selftest: all checks passed');
