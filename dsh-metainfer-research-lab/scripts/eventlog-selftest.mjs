/**
 * P1.2/S12: the hot event table is bounded, cold segments are immutable files
 * with sha256 sidecars, and reads transparently span both. A second store over
 * the same domain simulates a Host restart.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../host/store.js';
import { memoryDomain, storeContext } from './lib/memory-domain.mjs';

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name} — ${error.message}`);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metainfer-eventlog-'));
const config = { kernel: { hotEvents: 3, eventArchiveSegment: 2, eventArchiveRoot: root } };
const domain = memoryDomain();
const store = await openStore(storeContext(domain, config));
const projectId = 'archive-p';
await store.saveProject({ id: projectId, revision: 0, counters: { eventSeq: 0 }, config: {}, createdAt: 0, updatedAt: 0 });
const project = store.getProject(projectId);
for (let index = 1; index <= 7; index += 1) {
  await store.appendEvent(project, 'test/filler', { index });
}
await store.saveProject(project);

check('all events survive the hot-window move', () => {
  const events = store.listEvents(projectId);
  assert.deepEqual(events.map((event) => event.seq), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(domain.table('events').size, 3, 'only the hot window stays in the table');
});
check('segments are immutable files with checksums', () => {
  const segments = fs.readdirSync(root + '/' + projectId).filter((name) => name.endsWith('.jsonl.zst'));
  assert.equal(segments.length, 2);
  for (const name of segments) {
    assert.ok(fs.statSync(path.join(root, projectId, name)).size > 0);
    const sidecar = fs.readFileSync(path.join(root, projectId, `${name}.sha256`), 'utf8').trim();
    assert.match(sidecar, /^[0-9a-f]{64}\s+/);
  }
});
check('listEvents reads across cold and hot', () => {
  assert.deepEqual(store.listEvents(projectId, 2).map((event) => event.seq), [3, 4, 5, 6, 7]);
  assert.deepEqual(store.listEvents(projectId, 5).map((event) => event.seq), [6, 7]);
});
check('pageEvents spans the segment boundary', () => {
  const page = store.pageEvents(projectId, { after: 1, limit: 2 });
  assert.deepEqual(page.events.map((event) => event.seq), [2, 3]);
  assert.equal(page.total, 7);
  assert.equal(page.hasMore, true);
  const tail = store.pageEvents(projectId, { after: 4, limit: 100 });
  assert.deepEqual(tail.events.map((event) => event.seq), [5, 6, 7]);
  assert.equal(tail.hasMore, false);
});

// Restart: a second store over the same domain must rebuild the hot index and
// still read the files written by the first process.
const restarted = await openStore(storeContext(domain, config));
check('archived events survive a restart', () => {
  assert.deepEqual(restarted.listEvents(projectId).map((event) => event.seq), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(restarted.pageEvents(projectId, { after: 6, limit: 10 }).events.map((event) => event.seq), [7]);
});
const project2 = restarted.getProject(projectId);
await restarted.appendEvent(project2, 'test/filler', { index: 8 });
await restarted.saveProject(project2);
check('archiving continues after restart without gaps', () => {
  assert.deepEqual(restarted.listEvents(projectId).map((event) => event.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(restarted.listEvents(projectId).length, 8);
});

// Corrupt a sidecar and prove the store refuses to pretend the segment is valid.
const firstSegment = fs.readdirSync(path.join(root, projectId)).find((name) => name.endsWith('.jsonl.zst'));
fs.writeFileSync(path.join(root, projectId, `${firstSegment}.sha256`), `${'0'.repeat(64)}  ${firstSegment}\n`);
const corrupt = await openStore(storeContext(domain, config));
check('a checksum mismatch is a hard read failure', () => {
  assert.throws(() => corrupt.listEvents(projectId), (error) => error.code === 'archive_checksum_mismatch');
});

fs.rmSync(root, { recursive: true, force: true });
console.log(failed === 0 ? '\neventlog-selftest: all checks passed' : `\neventlog-selftest: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
