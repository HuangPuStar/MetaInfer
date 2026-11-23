#!/usr/bin/env node
/**
 * WAL maintenance.
 *
 * Two jobs, both offline (stop the Host first, or accept that it will log a few
 * rows after this runs):
 *
 *  - `--purge-non-projects`: delete rows whose project id looks like a probe
 *    fixture. Probes now use a throwaway WAL file (see scripts/lib/memory-domain.mjs),
 *    but earlier runs appended synthetic nodes to the operator's real log; without
 *    this the first real project's sequence starts at a meaningless offset.
 *  - `--renumber`: recompute every row's `project_seq` from the global order, so
 *    each project's log starts at 1 with no gaps.
 *
 * Usage:
 *   node scripts/wal-maintenance.mjs [--purge-non-projects] [--renumber] [--file PATH]
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dshHome } from '../host/store.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const fileArg = args.indexOf('--file');
const file = fileArg >= 0
  ? args[fileArg + 1]
  : path.join(dshHome(), 'metainfer-research-lab', 'wal.sqlite');

if (!fs.existsSync(file)) {
  console.log(`wal-maintenance: no log at ${file}`);
  process.exit(0);
}

const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode = WAL');
const columns = db.prepare('PRAGMA table_info(wal)').all().map((row) => row.name);
if (!columns.includes('project_seq')) {
  db.exec('ALTER TABLE wal ADD COLUMN project_seq INTEGER NOT NULL DEFAULT 0');
  db.exec('DROP INDEX IF EXISTS wal_project_seq');
  db.exec('CREATE INDEX IF NOT EXISTS wal_project_seq ON wal(project_id, project_seq)');
}

const renumber = () => {
  db.exec(`UPDATE wal SET project_seq = (
    SELECT COUNT(*) FROM wal AS older
    WHERE older.project_id = wal.project_id AND older.seq <= wal.seq
  )`);
  db.exec("DELETE FROM wal_meta WHERE key LIKE 'pseq:%'");
  for (const row of db.prepare('SELECT project_id, MAX(project_seq) AS seq FROM wal GROUP BY project_id').all()) {
    db.prepare("INSERT INTO wal_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run('pseq:' + row.project_id, String(row.seq ?? 0));
  }
};

if (flag('--purge-non-projects')) {
  const removed = db.prepare("DELETE FROM wal WHERE project_id NOT LIKE 'prj-%'").run();
  console.log(`wal-maintenance: purged ${Number(removed.changes)} row(s) from probe projects`);
}

if (flag('--renumber') || flag('--purge-non-projects')) {
  const before = db.prepare('SELECT COUNT(*) AS n FROM wal').get();
  renumber();
  const after = db.prepare('SELECT COUNT(*) AS n FROM wal').get();
  console.log(`wal-maintenance: renumbered ${Number(after.n)} row(s) (was ${Number(before.n)})`);
}

for (const row of db.prepare('SELECT project_id, COUNT(*) AS n, MIN(project_seq) AS lo, MAX(project_seq) AS hi FROM wal GROUP BY project_id ORDER BY project_id').all()) {
  console.log(`  ${row.project_id}: ${row.n} rows, project_seq ${row.lo}..${row.hi}`);
}
db.close();
