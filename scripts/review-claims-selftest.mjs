/**
 * Self-test for review claims (one concurrent proposal per parent).
 * Run: `node scripts/review-claims-selftest.mjs`
 */
import assert from 'node:assert/strict';
import { createReviewClaimBoard } from '../host/dispatch/review-claims.js';

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

function harness() {
  const state = { now: 10_000 };
  let seq = 0;
  const events = [];
  const board = createReviewClaimBoard({
    clock: () => state.now,
    ttlMs: 60_000,
    idFactory: () => `rcl-${seq += 1}`,
    onEvent: (event) => events.push(event),
  });
  return { board, state, events };
}

test('one expert can claim a node and gets the holder back', () => {
  const { board, events } = harness();
  const result = board.claim({ projectId: 'p', nodeId: 'n1', expertId: 'e-1', intent: 'propose', title: 'try swizzle' });
  assert.equal(result.ok, true);
  assert.equal(result.claim.expertId, 'e-1');
  assert.equal(result.claim.expiresAt, 70_000);
  assert.equal(board.isClaimed('p', 'n1'), true);
  assert.deepEqual(events.map((event) => event.type), ['review/claimed']);
});

test('a second expert is rejected while the claim lives', () => {
  const { board } = harness();
  board.claim({ projectId: 'p', nodeId: 'n1', expertId: 'e-1' });
  const second = board.claim({ projectId: 'p', nodeId: 'n1', expertId: 'e-2' });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'review_claimed');
  assert.equal(second.holder.expertId, 'e-1');
  assert.equal(board.list('p').length, 1);
});

test('a different project may claim the same node id', () => {
  const { board } = harness();
  assert.equal(board.claim({ projectId: 'p1', nodeId: 'n1', expertId: 'e-1' }).ok, true);
  assert.equal(board.claim({ projectId: 'p2', nodeId: 'n1', expertId: 'e-2' }).ok, true);
  assert.equal(board.size(), 2);
});

test('the same expert refreshes its own claim instead of conflicting', () => {
  const { board, state } = harness();
  board.claim({ projectId: 'p', nodeId: 'n1', expertId: 'e-1' });
  state.now += 30_000;
  const again = board.claim({ projectId: 'p', nodeId: 'n1', expertId: 'e-1' });
  assert.equal(again.ok, true);
  assert.equal(again.refreshed, true);
  assert.equal(again.claim.expiresAt, 100_000);
});

test('expiry releases the claim without an explicit release', () => {
  const { board, state, events } = harness();
  board.claim({ projectId: 'p', nodeId: 'n1', expertId: 'e-1' });
  state.now += 60_001;
  assert.equal(board.isClaimed('p', 'n1'), false);
  assert.equal(board.get('p', 'n1'), null);
  const second = board.claim({ projectId: 'p', nodeId: 'n1', expertId: 'e-2' });
  assert.equal(second.ok, true);
  assert.ok(events.some((event) => event.type === 'review/expired'));
});

test('only the holder may release, and releasing twice fails', () => {
  const { board } = harness();
  board.claim({ projectId: 'p', nodeId: 'n1', expertId: 'e-1' });
  const wrong = board.release({ projectId: 'p', nodeId: 'n1', expertId: 'e-2' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, 'not_holder');
  const ok = board.release({ projectId: 'p', nodeId: 'n1', expertId: 'e-1' });
  assert.equal(ok.ok, true);
  const twice = board.release({ projectId: 'p', nodeId: 'n1', expertId: 'e-1' });
  assert.equal(twice.code, 'not_claimed');
});

test('releaseAll drains one expert and leaves the others alone', () => {
  const { board } = harness();
  board.claim({ projectId: 'p', nodeId: 'n1', expertId: 'e-1' });
  board.claim({ projectId: 'p', nodeId: 'n2', expertId: 'e-1' });
  board.claim({ projectId: 'p', nodeId: 'n3', expertId: 'e-2' });
  assert.equal(board.releaseAll('p', 'e-1'), 2);
  assert.deepEqual(board.list('p').map((claim) => claim.expertId), ['e-2']);
});

test('invalid input and a full board fail with codes instead of throwing', () => {
  const { board } = harness();
  assert.equal(board.claim({ projectId: 'p', nodeId: 'n1' }).code, 'invalid_claim');
  const tiny = createReviewClaimBoard({ clock: () => 0, maxClaims: 1 });
  assert.equal(tiny.claim({ projectId: 'p', nodeId: 'n1', expertId: 'e-1' }).ok, true);
  assert.equal(tiny.claim({ projectId: 'p', nodeId: 'n2', expertId: 'e-1' }).code, 'claim_board_full');
});

test('list is stable, sorted by claim time', () => {
  const { board, state } = harness();
  board.claim({ projectId: 'p', nodeId: 'n2', expertId: 'e-1' });
  state.now += 10;
  board.claim({ projectId: 'p', nodeId: 'n1', expertId: 'e-2' });
  assert.deepEqual(board.list('p').map((claim) => claim.nodeId), ['n2', 'n1']);
});

let failed = 0;
for (const result of results) {
  if (result.ok) console.log(`ok   ${result.name}`);
  else {
    failed += 1;
    console.log(`FAIL ${result.name}\n     ${result.error?.stack ?? result.error}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} review-claim checks passed`);
process.exit(failed === 0 ? 0 : 1);
