#!/usr/bin/env node
/**
 * DAG write-ahead log probe.
 *
 * Drives the real store (memory domain) and asserts the contract a consumer such
 * as the scheduler or the dashboard relies on:
 *
 *  - every node write appends exactly one entry with a strictly increasing seq;
 *  - kinds distinguish created / status / priority / title / updated / removed;
 *  - a cursor resumes exactly where the reader stopped (no gap, no duplicate);
 *  - range queries are half-open at the bottom (seq > from) and closed at the top;
 *  - filters by node and by kind work together with pagination;
 *  - the log survives closing and reopening the store, and seq keeps growing;
 *  - pre-existing nodes are seeded once (a later read does not duplicate them).
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../host/store.js';
import { createWal } from '../host/wal.js';
import { createKernel } from '../host/kernel/instance.js';
import { createLabService } from '../host/lab-service.js';
import { registerHttpRoutes } from '../host/http.js';
import { createOperatorAuthority } from '../host/operator-token.js';
import { memoryDomain, storeContext } from './lib/memory-domain.mjs';

let failed = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`ok   ${name}`);
  else { failed += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const root = await mkdtemp(path.join(os.tmpdir(), 'mirl-wal-'));
const walFile = path.join(root, 'wal.sqlite');
const projectId = 'wal-p';

// --- the log itself (no store) ----------------------------------------------
{
  const wal = createWal({ file: walFile });
  const seqs = [];
  for (let index = 0; index < 5; index += 1) {
    seqs.push(wal.append({ projectId, nodeId: 'n-' + index, kind: 'node.created' }).seq);
  }
  check('sequence numbers strictly increase', seqs.every((seq, i) => i === 0 || seq > seqs[i - 1]), JSON.stringify(seqs));

  const first = wal.query({ projectId, limit: 2 });
  check('a page reports hasMore and a cursor', first.hasMore === true && typeof first.nextCursor === 'string');
  const second = wal.query({ projectId, limit: 2, cursor: first.nextCursor });
  const third = wal.query({ projectId, limit: 2, cursor: second.nextCursor });
  const walked = [...first.entries, ...second.entries, ...third.entries].map((entry) => entry.seq);
  check('paging with the cursor walks every entry once',
    walked.length === 5 && new Set(walked).size === 5, JSON.stringify(walked));
  check('the last page reports no cursor', second.hasMore === true && third.hasMore === false && third.nextCursor === null);

  const range = wal.query({ projectId, fromSeq: second.entries[0].seq, toSeq: second.entries[1].seq });
  check('range is (from, to]: exclusive below, inclusive above',
    range.entries.map((entry) => entry.seq).join(',') === String(second.entries[1].seq), JSON.stringify(range.entries.map((e) => e.seq)));

  const nodeOnly = wal.query({ projectId, nodeId: 'n-2' });
  check('filters by node', nodeOnly.entries.length === 1 && nodeOnly.entries[0].nodeId === 'n-2');
  wal.close();

  const reopened = createWal({ file: walFile });
  check('entries survive reopening the log', reopened.count(projectId) === 5 && reopened.latestSeq(projectId) === seqs[4]);
  const next = reopened.append({ projectId, nodeId: 'n-9', kind: 'node.created' });
  check('seq keeps growing after reopening', next.seq === seqs[4] + 1);
  reopened.close();
}

// --- through the store -------------------------------------------------------
await rm(walFile, { force: true });
for (const suffix of ['-wal', '-shm']) await rm(walFile + suffix, { force: true });
const domain = memoryDomain();
const cfg = { kernel: { walFile } };
let store = await openStore(storeContext(domain), cfg);
await store.saveProject({ id: projectId, name: 'wal', repo: { path: root, baseBranch: 'main' }, mode: 'manual', config: {}, counters: {} });
const baseNode = {
  id: 'n-0001', projectId, title: 'root', prompt: 'p', status: 'planned', needs: {}, parentId: null, rev: 0,
  priority: { class: 'p2' }, timestamps: { createdAt: 1, updatedAt: 1 },
};
await store.saveNode(projectId, { ...baseNode });
await store.saveNode(projectId, { ...baseNode, status: 'running', rev: 1 });
await store.saveNode(projectId, { ...baseNode, status: 'running', rev: 2, priority: { class: 'p0' } });
await store.saveNode(projectId, { ...baseNode, status: 'running', rev: 3, priority: { class: 'p0' }, title: 'root v2' });
await store.saveNode(projectId, { ...baseNode, status: 'completed', rev: 4, priority: { class: 'p0' }, title: 'root v2' });

const kinds = store.walQuery({ projectId, limit: 50 }).entries.map((entry) => entry.kind);
check('each node write appends one entry with a semantic kind',
  kinds.join(',') === 'node.created,node.status,node.priority,node.title,node.status', kinds.join(','));
check('created carries the initial snapshot',
  store.walQuery({ projectId, kinds: ['node.created'] }).entries[0].payload.status === 'planned');
check('status entries carry before/after',
  store.walQuery({ projectId, kinds: ['node.status'] }).entries[0].payload.after.status === 'running');

const latest = store.walLatestSeq(projectId);
check('latestSeq matches the newest entry', latest.seq === 5 && latest.count === 5, JSON.stringify(latest));

// cursor semantics: resume from 3 and see only what came after
const tail = store.walQuery({ projectId, fromSeq: 3 });
check('a cursor returns only later entries',
  tail.entries.map((entry) => entry.seq).join(',') === '4,5', JSON.stringify(tail.entries.map((e) => e.seq)));

// paging collects everything exactly once
const collected = [];
let cursor = null;
for (let guard = 0; guard < 10; guard += 1) {
  const page = store.walQuery({ projectId, limit: 2, cursor });
  collected.push(...page.entries.map((entry) => entry.seq));
  if (!page.hasMore) break;
  cursor = page.nextCursor;
}
check('paging through the store covers the whole log once',
  collected.join(',') === '1,2,3,4,5', collected.join(','));

// removal
await store.deleteNode(projectId, 'n-0001');
const removed = store.walQuery({ projectId, kinds: ['node.removed'] }).entries;
check('deletion is recorded as node.removed', removed.length === 1 && removed[0].nodeId === 'n-0001');

// persistence across a store restart
const before = store.walLatestSeq(projectId);
await store.close();
store = await openStore(storeContext(domain), cfg);
const after = store.walLatestSeq(projectId);
check('the log survives a store restart', after.seq === before.seq && after.count === before.count, JSON.stringify({ before, after }));
await store.saveNode(projectId, { ...baseNode, status: 'cancelled', rev: 5, priority: { class: 'p0' }, title: 'root v2' });
check('seq continues after a restart', store.walLatestSeq(projectId).seq === before.seq + 1);

// --- HTTP surface ------------------------------------------------------------
{
  const kernel = createKernel({ store });
  const authority = createOperatorAuthority();
  const service = createLabService({
    ctx: { effect: () => {}, get: () => null, logger: { info() {}, warn() {} } },
    store,
    kernel,
    git: null,
    runtime: null,
    transcript: null,
    orchestrator: null,
    auto: { statusOf: () => ({ status: 'off', pauseReason: null }) },
    cluster: null,
    clusterAdmin: null,
    operatorAuthority: authority,
  });
  const routes = [];
  registerHttpRoutes({
    effect: () => {},
    connection: { fetch: { register(route) { routes.push(route); return () => {}; } } },
  }, service, {});
  const walPath = '/api/metainfer-research-lab/wal';
  const route = routes.find((candidate) => candidate.path === walPath && candidate.methods.includes('GET'));
  check('GET /wal is registered', route !== undefined);
  const call = async (search) => {
    const response = await route.fetch(new Request('http://local' + walPath + search, {
      method: 'GET',
      headers: { accept: 'application/json', 'x-metainfer-operator': authority.token },
    }));
    return response.json();
  };
  const page = await call(`?projectId=${projectId}&limit=2`);
  check('GET /wal returns a page with a cursor',
    page.ok === true && Array.isArray(page.data.entries) && page.data.entries.length === 2 && typeof page.data.nextCursor === 'string',
    JSON.stringify(page).slice(0, 160));
  const ranged = await call(`?projectId=${projectId}&fromSeq=4&toSeq=5`);
  check('GET /wal honours fromSeq/toSeq',
    ranged.data.entries.map((entry) => entry.seq).join(',') === '5', JSON.stringify(ranged.data?.entries?.map((e) => e.seq)));
  const filtered = await call(`?projectId=${projectId}&kinds=node.status`);
  check('GET /wal honours kind filters',
    filtered.data.entries.length > 0 && filtered.data.entries.every((entry) => entry.kind === 'node.status'));
}

// ---- per-project numbering ---------------------------------------------------
{
  const isoWal = path.join(root, 'wal-two-projects.sqlite');
  const wal = createWal({ file: isoWal });
  const a1 = wal.append({ projectId: 'pa', nodeId: 'n-1', kind: 'node.created' });
  const b1 = wal.append({ projectId: 'pb', nodeId: 'n-1', kind: 'node.created' });
  const a2 = wal.append({ projectId: 'pa', nodeId: 'n-2', kind: 'node.created' });
  check('each project starts its own sequence at 1',
    a1.projectSeq === 1 && b1.projectSeq === 1 && a2.projectSeq === 2,
    JSON.stringify([a1, b1, a2]));
  check('the global row id keeps growing across projects',
    a1.seq === 1 && b1.seq === 2 && a2.seq === 3, JSON.stringify([a1.seq, b1.seq, a2.seq]));
  check('queries use the project sequence',
    wal.query({ projectId: 'pa' }).entries.map((entry) => entry.projectSeq).join(',') === '1,2'
    && wal.query({ projectId: 'pb' }).entries.map((entry) => entry.projectSeq).join(',') === '1');
  check('latestSeq is per project while the cursor still works',
    wal.latestSeq('pa') === 2 && wal.latestSeq('pb') === 1 && wal.query({ projectId: 'pa', fromSeq: 1 }).entries.length === 1);
  wal.close();
}

// ---- backfill for a project that predates the log ---------------------------
const oldProject = 'wal-old';
await store.saveProject({ id: oldProject, name: 'old', repo: { path: root, baseBranch: 'main' }, mode: 'manual', config: {}, counters: {} });
for (const id of ['n-1', 'n-2', 'n-3']) {
  await store.saveNode(oldProject, { ...baseNode, id, projectId: oldProject, status: 'completed' });
}
// A project that predates the log has no rows in it. Point the store at a fresh
// log file: the projection still knows the nodes, the log is empty, so the first
// read must seed it.
await store.close();
const freshWal = path.join(root, 'wal-fresh.sqlite');
store = await openStore(storeContext(domain), { kernel: { walFile: freshWal } });
const seeded = store.walQuery({ projectId: oldProject, limit: 100 });
check('pre-existing nodes are seeded as snapshots',
  seeded.entries.length === 3 && seeded.entries.every((entry) => entry.kind === 'node.snapshot'), String(seeded.entries.length));
const reseeded = store.walQuery({ projectId: oldProject, limit: 100 });
check('seeding happens once', reseeded.entries.length === 3, String(reseeded.entries.length));


await store.close();
await rm(root, { recursive: true, force: true });

console.log(failed === 0 ? '\nwal-selftest: all checks passed' : `\nwal-selftest: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
