#!/usr/bin/env node
/**
 * K7 regression: proposal count must follow idle capacity, and one reviewer
 * must not be able to fill the whole pass.
 *
 * Before the fix the advisor system prompt said "prefer 1" while the project was
 * running 2.8 of 8 GPUs, and `mergeAdvisorOutputs` gave the first reviewer the
 * entire global budget. Both push the DAG toward one node wide.
 */
import assert from 'node:assert/strict';
import { advisorPrompt, mergeAdvisorOutputs } from '../host/orchestrator.js';

const project = (advisor) => ({
  id: 'prj-test',
  name: 'test',
  config: { advisor, resourcePools: { gpu: 8 } },
});

const out = (id, n) => ({
  analysis: id,
  needUserDecision: false,
  proposals: Array.from({ length: n }, (_, i) => ({
    parentId: 'n-0001',
    title: `${id}-${i}`,
    prompt: `do ${id} ${i}`,
    rationale: 'r',
  })),
});

const cases = [];
const check = (name, fn) => {
  fn();
  cases.push(name);
  console.log(`ok   ${name}`);
};

check('one reviewer cannot exceed maxProposalsPerReviewer', () => {
  const merged = mergeAdvisorOutputs(project({ maxProposalsPerPass: 6, maxProposalsPerReviewer: 2 }), [out('a', 5)]);
  assert.equal(merged.proposals.length, 2);
  assert.deepEqual(merged.proposals.map((p) => p.title), ['a-0', 'a-1']);
});

check('independent reviewers each keep their own slice', () => {
  const merged = mergeAdvisorOutputs(project({ maxProposalsPerPass: 6, maxProposalsPerReviewer: 2 }), [
    out('a', 5),
    out('b', 5),
  ]);
  assert.equal(merged.proposals.length, 4);
  assert.deepEqual(merged.proposals.map((p) => p.title), ['a-0', 'a-1', 'b-0', 'b-1']);
});

check('the global pass cap still wins over per-reviewer slices', () => {
  const merged = mergeAdvisorOutputs(project({ maxProposalsPerPass: 3, maxProposalsPerReviewer: 2 }), [
    out('a', 5),
    out('b', 5),
  ]);
  assert.equal(merged.proposals.length, 3);
  assert.deepEqual(merged.proposals.map((p) => p.title), ['a-0', 'a-1', 'b-0']);
});

check('a duplicate proposal from the second reviewer does not consume its slice', () => {
  const shared = out('a', 1);
  const merged = mergeAdvisorOutputs(project({ maxProposalsPerPass: 9, maxProposalsPerReviewer: 2 }), [
    shared,
    { ...shared, analysis: 'echo' },
    out('b', 2),
  ]);
  assert.deepEqual(merged.proposals.map((p) => p.title), ['a-0', 'b-0', 'b-1']);
});

check('malformed reviewers contribute nothing instead of throwing', () => {
  const merged = mergeAdvisorOutputs(project({ maxProposalsPerPass: 3, maxProposalsPerReviewer: 2 }), [
    null,
    { proposals: 'not-an-array' },
    {},
    out('b', 1),
  ]);
  assert.deepEqual(merged.proposals.map((p) => p.title), ['b-0']);
  assert.equal(merged.aggregatedFrom, 4);
});

check('maxProposalsPerReviewer defaults to 2 when the project has no such key', () => {
  const merged = mergeAdvisorOutputs(project({ maxProposalsPerPass: 9 }), [out('a', 4)]);
  assert.equal(merged.proposals.length, 2);
});

check('the advisor prompt sizes the proposal count to capacity instead of asking for one', () => {
  const prompt = advisorPrompt(project({ maxProposalsPerRun: 3 }), { resources: { free: { gpu: 5 } } }, null);
  assert.ok(!/prefer 1\b/i.test(prompt), 'the old "prefer 1" instruction must be gone');
  assert.ok(/resources\.free/.test(prompt), 'the rule must name the capacity signal');
  assert.ok(/maxProposalsPerReviewer/.test(prompt), 'the rule must name the per-reviewer cap');
});

console.log(`\nadvisor merge self-test passed (${cases.length} checks)`);
