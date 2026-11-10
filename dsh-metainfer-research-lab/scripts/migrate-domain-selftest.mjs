#!/usr/bin/env node
/**
 * Tests for scripts/migrate-domain.mjs.
 *
 * The tool runs against real user data, so it needs a fixture that exercises the
 * awkward cases: a node with a report, a node without one, a human-authored node,
 * an event stream, and a re-run that must refuse to clobber an existing domain.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tool = path.join(here, 'migrate-domain.mjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-selftest-'));
const from = path.join(root, 'metainfer_research_lab');
const to = path.join(root, 'metainfer_research_lab_v2');

const write = (table, key, record) => {
  fs.mkdirSync(path.join(from, table), { recursive: true });
  fs.writeFileSync(path.join(from, table, `${key}.json`), JSON.stringify({ version: 1, record }, null, 2));
};

write('projects', 'prj-t1', {
  id: 'prj-t1',
  name: 'fixture',
  revision: 12,
  counters: { eventSeq: 3 },
  config: { advisor: { maxProposalsPerPass: 3 } },
});
write('nodes', 'prj-t1__n-0001', {
  id: 'n-0001',
  projectId: 'prj-t1',
  title: 'seed node',
  status: 'completed',
  parentId: null,
  createdBy: 'seed',
  execution: 'local',
  taskType: 'analysis',
  needs: { gpu: 1 },
  timeboxMs: 60000,
  timestamps: { createdAt: 1000 },
  report: { summary: 'First line of the report.\nSecond line.', success: true },
  reportText: 'First line of the report.\nSecond line.\nFull body.',
});
write('nodes', 'prj-t1__n-0002', {
  id: 'n-0002',
  projectId: 'prj-t1',
  title: 'human node',
  status: 'planned',
  parentId: 'n-0001',
  createdBy: 'user',
  execution: 'local',
  taskType: 'analysis',
  needs: { gpu: 1 },
  timeboxMs: 60000,
  timestamps: { createdAt: 2000 },
});
write('events', 'prj-t1__e00000001', { seq: 1, projectId: 'prj-t1', at: 1000, type: 'node/created', data: {} });
write('events', 'prj-t1__e00000002', { seq: 2, projectId: 'prj-t1', at: 2000, type: 'node/created', data: {} });
write('events', 'prj-t1__e00000003', { seq: 3, projectId: 'prj-t1', at: 3000, type: 'node/completed', nodeId: 'n-0001', data: {} });

const run = (command, extra = []) => execFileSync(process.execPath, [tool, command, '--from', from, '--to', to, ...extra], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
const readV2 = (table, key) => JSON.parse(fs.readFileSync(path.join(to, table, `${key}.json`), 'utf8')).record;

const checks = [];
const check = (name, fn) => {
  fn();
  checks.push(name);
  console.log(`ok   ${name}`);
};

check('run writes a v2 domain and leaves the source untouched', () => {
  run('run');
  assert.equal(JSON.parse(fs.readFileSync(path.join(from, 'nodes', 'prj-t1__n-0001.json'), 'utf8')).version, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(to, 'nodes', 'prj-t1__n-0001.json'), 'utf8')).version, 2);
  assert.ok(fs.existsSync(path.join(to, 'migration.json')));
});

check('every node gets a revision, a priority and a claim slot', () => {
  const seed = readV2('nodes', 'prj-t1__n-0001');
  const human = readV2('nodes', 'prj-t1__n-0002');
  assert.equal(seed.rev, 12);
  assert.equal(seed.priority.class, 'p1', 'a seed becomes p1');
  assert.equal(human.priority.class, 'p0', 'a human node becomes p0');
  assert.equal(human.claim, null);
});

check('the headline comes from the report and the report itself is untouched', () => {
  const seed = readV2('nodes', 'prj-t1__n-0001');
  assert.equal(seed.headline, 'First line of the report.');
  assert.equal(seed.reportText, 'First line of the report.\nSecond line.\nFull body.');
  assert.equal(seed.report.summary, 'First line of the report.\nSecond line.');
});

check('a node with no report gets no empty headline field', () => {
  assert.equal('headline' in readV2('nodes', 'prj-t1__n-0002'), false);
});

check('legacy events gain an actor and a null commit so recover() skips them', () => {
  const event = readV2('events', 'prj-t1__e00000001');
  assert.equal(event.actor.kind, 'legacy');
  assert.equal(event.commit, null);
  assert.equal(event.revision, 0);
  assert.equal(event.legacy, true);
});

check('the project carries a migration marker', () => {
  const project = readV2('projects', 'prj-t1');
  assert.equal(project.migration.from, 'metainfer_research_lab');
  assert.equal(project.migration.toVersion, 2);
});

check('verify passes on a healthy migration', () => {
  assert.match(run('verify'), /verify ok: projects=1 nodes=2/);
});

check('a second run refuses to clobber the existing domain', () => {
  assert.throws(() => run('run'), /already exists; pass --force/);
});

check('--enrich overrides the deterministic fallback', () => {
  const enrichFile = path.join(root, 'enrich.json');
  fs.writeFileSync(enrichFile, JSON.stringify({
    'n-0002': { headline: 'model-written headline', tags: ['fp32', 'weights'] },
  }));
  run('run', ['--force', '--enrich', enrichFile]);
  const human = readV2('nodes', 'prj-t1__n-0002');
  assert.equal(human.headline, 'model-written headline');
  assert.deepEqual(human.tags, ['fp32', 'weights']);
  const seed = readV2('nodes', 'prj-t1__n-0001');
  assert.equal(seed.headline, 'First line of the report.', 'nodes the model did not mention keep the fallback');
  assert.match(run('verify'), /verify ok/);
});

check('verify catches a tampered report', () => {
  const target = path.join(to, 'nodes', 'prj-t1__n-0001.json');
  const document = JSON.parse(fs.readFileSync(target, 'utf8'));
  document.record.reportText = 'tampered';
  fs.writeFileSync(target, JSON.stringify(document));
  assert.throws(() => run('verify'), (error) => /verify FAILED/.test(error.stdout + error.stderr));
});

check('a source record with the wrong version stamp aborts instead of silently skipping', () => {
  const victim = path.join(from, 'nodes', 'prj-t1__n-0002.json');
  const document = JSON.parse(fs.readFileSync(victim, 'utf8'));
  document.version = 7;
  fs.writeFileSync(victim, JSON.stringify(document));
  assert.throws(() => run('run', ['--force']), (error) => /expected version 1, found 7/.test(error.stderr));
});

fs.rmSync(root, { recursive: true, force: true });
console.log(`\nmigrate-domain self-test passed (${checks.length} checks)`);
