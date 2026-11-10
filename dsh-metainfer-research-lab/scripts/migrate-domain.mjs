#!/usr/bin/env node
/**
 * Offline, one-shot migration of the Lab domain from v1 to v2.
 *
 * This is a *tool*, not product code: the plugin never runs it, never reads a v1
 * record, and carries no compatibility branch for old data. The runtime only
 * ever sees v2. If the migration is wrong, fix the tool and re-run it — the
 * source domain is never modified.
 *
 * Why offline instead of in-band compatibility:
 *   - `compatibleVersions` would force every reader to tolerate two shapes forever
 *     (missing actor/commit/revision/priority) and would silently drop records
 *     whose stamp it does not list.
 *   - The event log, 254 nodes and 248 role runs are small enough to transform on
 *     a laptop in seconds. Paying permanent code complexity for a one-time
 *     seconds-long problem is the wrong trade.
 *
 * On-disk shape (storage-json, `layout: per-record`):
 *   <root>/metainfer_research_lab/<table>/<key>.json  →  {"version":1,"record":{…}}
 * so the tool needs no DSH: it reads and writes plain JSON.
 *
 * Usage:
 *   node scripts/migrate-domain.mjs plan   [--from DIR] [--to DIR]
 *   node scripts/migrate-domain.mjs run    [--from DIR] [--to DIR] [--enrich FILE] [--force]
 *   node scripts/migrate-domain.mjs verify [--from DIR] [--to DIR]
 *
 *   --enrich FILE  optional JSON `{ "<nodeId>": { headline?, tags?, priority? } }`
 *                  produced by an offline LLM pass; deterministic fallbacks apply
 *                  to every node it does not mention.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Domain identity has one source of truth: the module the plugin opens with.
// A drifted copy here is exactly how a migration silently targets the wrong
// directory.
import { DOMAIN_NAME as TO_NAME, DOMAIN_VERSION as TO_VERSION, LEGACY_DOMAIN_NAME as FROM_NAME } from '../host/store.js';

const FROM_VERSION = 1;
const TABLES = ['projects', 'nodes', 'runs', 'cycles', 'events'];

const storagesRoot = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'storages');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { command: argv[0] ?? 'plan', from: null, to: null, enrich: null, force: false };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--from') args.from = argv[++index];
    else if (token === '--to') args.to = argv[++index];
    else if (token === '--enrich') args.enrich = argv[++index];
    else if (token === '--force') args.force = true;
    else if (token === '--help' || token === '-h') args.command = 'help';
    else throw new Error(`unknown argument: ${token}`);
  }
  args.from = path.resolve(args.from ?? path.join(storagesRoot, FROM_NAME));
  args.to = path.resolve(args.to ?? path.join(storagesRoot, TO_NAME));
  return args;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function readTable(root, table, version = FROM_VERSION) {
  const dir = path.join(root, table);
  if (!fs.existsSync(dir)) return [];
  const rows = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const document = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (document?.version !== version) {
      throw new Error(`${table}/${file}: expected version ${version}, found ${document?.version}`);
    }
    rows.push({ table, key: file.slice(0, -'.json'.length), record: document.record });
  }
  return rows;
}

/** Write one record through a temp file so a crash cannot leave a torn document. */
function writeRecord(root, table, key, record) {
  const dir = path.join(root, table);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${key}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ version: TO_VERSION, record }, null, 2)}\n`);
  fs.renameSync(temporary, target);
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

const PRIORITY_BY_CREATOR = { user: 'p0', seed: 'p1', advisor: 'p2' };

/** First meaningful line of the report, capped at 300 chars. */
function headlineOf(node) {
  const candidates = [node?.report?.headline, node?.report?.summary, node?.reportText];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const line = candidate.split('\n').map((part) => part.trim()).find((part) => part.length > 0);
    if (line) return line.slice(0, 300);
  }
  return '';
}

/**
 * v1 node → v2 node.
 *
 * Adds exactly the fields v2 dispatch needs and that v1 never had:
 *   rev       the revision this node was last written at (staleness basis)
 *   priority  p0 for human-authored nodes, p1 for seeds, p2 for everything else
 *   claim     null until the dispatcher claims it
 *   headline  indexable one-liner; the report itself is never truncated
 * Everything else is carried over untouched: the domain is data, not a schema
 * to be flattened.
 */
function transformNode(node, project, enrich) {
  const extra = enrich?.[node.id] ?? {};
  const out = { ...node };
  out.rev = Number.isFinite(node.rev) ? node.rev : (project?.revision ?? 0);
  out.claim = node.claim ?? null;
  out.priority = extra.priority ?? {
    class: PRIORITY_BY_CREATOR[node.createdBy] ?? 'p2',
    score: 0,
    by: 'migration',
    reason: `derived from createdBy=${node.createdBy ?? 'unknown'}`,
    at: node?.timestamps?.createdAt ?? 0,
  };
  const headline = extra.headline ?? headlineOf(node);
  if (headline) out.headline = headline;
  if (Array.isArray(extra.tags) && extra.tags.length > 0) out.tags = extra.tags;
  return out;
}

/**
 * v1 event → v2 event.
 *
 * v1 events predate the kernel: no actor, no commit envelope, no revision. v2
 * fills them with the truth (`actor.kind = legacy`) instead of teaching every
 * reader to branch on absence. `commit: null` is what keeps `recover()` from
 * replaying pre-kernel history: it only redoes events that carry a commit.
 */
function transformEvent(event, projectId) {
  return {
    ...event,
    projectId: event.projectId ?? projectId,
    actor: event.actor ?? { kind: 'legacy', id: 'v1-migration' },
    commit: event.commit ?? null,
    revision: Number.isFinite(event.revision) ? event.revision : 0,
    legacy: true,
  };
}

function transformProject(project, at) {
  return {
    ...project,
    migration: {
      from: FROM_NAME,
      fromVersion: FROM_VERSION,
      toVersion: TO_VERSION,
      at,
      tool: 'scripts/migrate-domain.mjs',
    },
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function load(args) {
  const tables = Object.fromEntries(TABLES.map((table) => [table, readTable(args.from, table)]));
  const enrich = args.enrich
    ? JSON.parse(fs.readFileSync(args.enrich, 'utf8'))
    : null;
  return { tables, enrich };
}

function summarize(tables) {
  const projects = tables.projects.map((row) => row.record);
  const nodes = tables.nodes.map((row) => row.record);
  const byStatus = {};
  for (const node of nodes) byStatus[node.status ?? '<none>'] = (byStatus[node.status ?? '<none>'] ?? 0) + 1;
  const withSummary = nodes.filter((node) => typeof node?.report?.summary === 'string').length;
  return {
    projects: tables.projects.length,
    nodes: nodes.length,
    runs: tables.runs.length,
    cycles: tables.cycles.length,
    events: tables.events.length,
    nodesByStatus: byStatus,
    nodesWithReportSummary: withSummary,
    eventSeqMax: tables.events.reduce((max, row) => Math.max(max, row.record?.seq ?? 0), 0),
    projectRevisions: Object.fromEntries(projects.map((project) => [project.id, project.revision ?? 0])),
  };
}

function plan(args) {
  const { tables, enrich } = load(args);
  const summary = summarize(tables);
  const running = tables.nodes.filter((row) => row.record.status === 'running');
  console.log('source      ', args.from);
  console.log('destination ', args.to, fs.existsSync(args.to) ? '(EXISTS)' : '(will be created)');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nnodes missing a report.summary: ${summary.nodes - summary.nodesWithReportSummary}`);
  console.log(`enrichment file: ${enrich ? `${Object.keys(enrich).length} node ids` : 'none (deterministic headline fallback)'}`);
  if (running.length > 0) {
    console.log(`\nwarning: ${running.length} node(s) still marked running (${running.map((r) => r.record.id).join(', ')}).`);
    console.log('         The tool copies the status as-is; the v2 reconcile path fails stale running');
    console.log('         nodes on the first boot, exactly as it does after a Host restart.');
  }
  if (fs.existsSync(args.to)) {
    console.log('\ndestination already exists: `run` will refuse without --force.');
  }
}

function run(args) {
  const at = Date.now();
  const { tables, enrich } = load(args);
  if (fs.existsSync(args.to) && !args.force) {
    throw new Error(`destination ${args.to} already exists; pass --force to replace it`);
  }
  const projects = new Map(tables.projects.map((row) => [row.record.id, row.record]));
  // Build in a sibling temp dir and rename at the end: a crash never leaves a
  // half-migrated domain for the plugin to open.
  const staging = `${args.to}.staging-${randomUUID().slice(0, 8)}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  const counts = {};
  for (const { record } of tables.projects) {
    const id = record.id;
    writeRecord(staging, 'projects', id, transformProject(record, at));
    counts.projects = (counts.projects ?? 0) + 1;
  }
  for (const { record } of tables.nodes) {
    const project = projects.get(record.projectId);
    writeRecord(staging, 'nodes', `${record.projectId}__${record.id}`, transformNode(record, project, enrich));
    counts.nodes = (counts.nodes ?? 0) + 1;
  }
  for (const { record } of tables.events) {
    writeRecord(staging, 'events', `${record.projectId}__e${String(record.seq).padStart(8, '0')}`, transformEvent(record, record.projectId));
    counts.events = (counts.events ?? 0) + 1;
  }
  for (const table of ['runs', 'cycles']) {
    for (const { key, record } of tables[table]) {
      writeRecord(staging, table, key, record);
      counts[table] = (counts[table] ?? 0) + 1;
    }
  }

  const manifest = {
    tool: 'scripts/migrate-domain.mjs',
    from: args.from,
    fromVersion: FROM_VERSION,
    to: args.to,
    toVersion: TO_VERSION,
    at: new Date(at).toISOString(),
    counts,
    enrich: args.enrich ? path.resolve(args.enrich) : null,
    enrichDigest: args.enrich ? createHash('sha256').update(fs.readFileSync(args.enrich)).digest('hex').slice(0, 16) : null,
  };
  fs.writeFileSync(path.join(staging, 'migration.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  if (fs.existsSync(args.to)) fs.rmSync(args.to, { recursive: true, force: true });
  fs.renameSync(staging, args.to);

  // Only now is the count authoritative, so report what actually landed.
  const written = Object.fromEntries(TABLES.map((table) => [table, readTable(args.to, table, TO_VERSION).length]));
  console.log(`migrated ${FROM_NAME} → ${TO_NAME}`);
  console.log(JSON.stringify(written, null, 2));
  console.log(`manifest: ${path.join(args.to, 'migration.json')}`);
  console.log(`source untouched: ${args.from}`);
}

function verify(args) {
  const from = Object.fromEntries(TABLES.map((table) => [table, readTable(args.from, table)]));
  const to = Object.fromEntries(TABLES.map((table) => [table, readTable(args.to, table, TO_VERSION)]));
  const problems = [];
  const expect = (condition, message) => { if (!condition) problems.push(message); };

  for (const table of TABLES) {
    expect(from[table].length === to[table].length, `${table}: ${from[table].length} source rows vs ${to[table].length} migrated`);
    const fromKeys = new Set(from[table].map((row) => row.key));
    for (const row of to[table]) if (!fromKeys.has(row.key)) problems.push(`${table}: ${row.key} does not exist in the source`);
  }

  const sourceNodes = new Map(from.nodes.map((row) => [row.record.id, row.record]));
  const projectRevision = new Map(from.projects.map((row) => [row.record.id, row.record.revision ?? 0]));
  for (const { record } of to.nodes) {
    const before = sourceNodes.get(record.id);
    expect(before !== undefined, `nodes/${record.id}: missing in the source`);
    if (!before) continue;
    for (const field of ['status', 'title', 'parentId', 'createdBy', 'timeboxMs']) {
      expect(before[field] === record[field], `nodes/${record.id}: ${field} changed (${JSON.stringify(before[field])} → ${JSON.stringify(record[field])})`);
    }
    expect(typeof record.rev === 'number', `nodes/${record.id}: rev is not a number`);
    expect(record.rev <= (projectRevision.get(record.projectId) ?? 0), `nodes/${record.id}: rev ${record.rev} exceeds project revision`);
    expect(['p0', 'p1', 'p2', 'p3', 'deferred'].includes(record.priority?.class), `nodes/${record.id}: bad priority class ${record.priority?.class}`);
    expect('claim' in record, `nodes/${record.id}: missing claim`);
    if (typeof before.report?.summary === 'string' && before.report.summary.trim() !== '') {
      expect(typeof record.headline === 'string' && record.headline.length > 0, `nodes/${record.id}: has a report summary but no headline`);
      expect(record.headline.length <= 300, `nodes/${record.id}: headline longer than 300 chars`);
    }
    // The report is evidence: it must survive byte-for-byte.
    expect(before.reportText === record.reportText, `nodes/${record.id}: reportText changed`);
    expect(JSON.stringify(before.report) === JSON.stringify(record.report), `nodes/${record.id}: report changed`);
  }

  for (const { record } of to.events) {
    expect(record.actor?.kind === 'legacy', `events/${record.seq}: missing legacy actor`);
    expect(record.commit === null, `events/${record.seq}: a pre-kernel event must not carry a commit`);
    expect(typeof record.seq === 'number', `events/${record.seq}: seq is not a number`);
  }

  for (const { record } of to.projects) {
    expect(record.migration?.from === FROM_NAME, `projects/${record.id}: missing migration marker`);
    const maxSeq = to.events.reduce((max, row) => Math.max(max, row.record.seq ?? 0), 0);
    expect((record.counters?.eventSeq ?? 0) === maxSeq, `projects/${record.id}: counters.eventSeq ${record.counters?.eventSeq} != max event seq ${maxSeq}`);
  }

  if (problems.length > 0) {
    console.error(`verify FAILED (${problems.length} problems)`);
    for (const problem of problems.slice(0, 40)) console.error(`  - ${problem}`);
    if (problems.length > 40) console.error(`  … and ${problems.length - 40} more`);
    process.exitCode = 1;
    return;
  }
  console.log(`verify ok: ${TABLES.map((table) => `${table}=${to[table].length}`).join(' ')}`);
}

function help() {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(23, 40).join('\n'));
}

// ---------------------------------------------------------------------------

const commands = { plan, run, verify, help };
const args = parseArgs(process.argv.slice(2));
const command = commands[args.command];
if (!command) throw new Error(`unknown command: ${args.command} (plan|run|verify)`);
command(args);
