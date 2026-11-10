/**
 * Cold event segments (P1.2/S12).
 *
 * The event log is append-only. When a project outgrows the hot window, the
 * oldest complete segment is written to an immutable file before its rows are
 * moved out of the table. The file has a sha256 sidecar; a segment that fails
 * verification is never treated as archived, so a read either returns the row
 * from the table or from a verified segment.
 *
 * Segment format: zstd-compressed JSONL, one event object per line, named
 * `seg-<firstSeq>-<lastSeq>.jsonl.zst`. Existing segment files are never
 * overwritten.
 */
import { createHash } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

const SEGMENT_RE = /^seg-(\d+)-(\d+)\.jsonl\.zst$/;

export function segmentFileName(from, to) {
  return `seg-${String(from).padStart(8, '0')}-${String(to).padStart(8, '0')}.jsonl.zst`;
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function archiveError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function createEventArchive({ root, hotEvents = 50_000, segmentSize = 10_000 }) {
  if (typeof root !== 'string' || root.length === 0) throw new TypeError('event archive root is required');
  if (!Number.isInteger(hotEvents) || hotEvents < 2) throw new TypeError('hotEvents must be an integer >= 2');
  if (!Number.isInteger(segmentSize) || segmentSize < 1) throw new TypeError('segmentSize must be a positive integer');

  function projectDir(projectId) {
    if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) throw new TypeError('invalid project id for event archive');
    return path.join(root, projectId);
  }

  async function listSegments(projectId) {
    const dir = projectDir(projectId);
    let names;
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const out = [];
    for (const name of names) {
      const match = SEGMENT_RE.exec(name);
      if (!match) continue;
      out.push({
        file: path.join(dir, name),
        name,
        from: Number(match[1]),
        to: Number(match[2]),
      });
    }
    out.sort((a, b) => a.from - b.from || a.to - b.to);
    return out;
  }

  async function readSegment(descriptor) {
    const bytes = await fs.readFile(descriptor.file);
    let expected;
    try {
      expected = (await fs.readFile(`${descriptor.file}.sha256`, 'utf8')).trim().split(/\s+/)[0];
    } catch (error) {
      throw archiveError('archive_checksum_missing', `missing sha256 for ${descriptor.name}: ${error.message}`);
    }
    const actual = sha256(bytes);
    if (!expected || expected !== actual) {
      throw archiveError('archive_checksum_mismatch', `sha256 mismatch for ${descriptor.name}: ${expected} != ${actual}`);
    }
    let text;
    try {
      text = zstdDecompressSync(bytes).toString('utf8');
    } catch (error) {
      throw archiveError('archive_corrupt', `cannot decompress ${descriptor.name}: ${error.message}`);
    }
    const events = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        throw archiveError('archive_corrupt', `invalid JSON in ${descriptor.name}: ${error.message}`);
      }
      if (!Number.isInteger(event?.seq) || event.seq < descriptor.from || event.seq > descriptor.to) {
        throw archiveError('archive_corrupt', `event ${event?.seq} is outside ${descriptor.name}`);
      }
      events.push(event);
    }
    return events;
  }

  async function readArchived(projectId, after = 0) {
    const out = [];
    for (const descriptor of await listSegments(projectId)) {
      if (descriptor.to <= after) continue;
      const events = await readSegment(descriptor);
      for (const event of events) if (event.seq > after) out.push(event);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  async function writeSegment(projectId, events) {
    if (!Array.isArray(events) || events.length === 0) throw new TypeError('cannot archive an empty segment');
    const ordered = [...events].sort((a, b) => a.seq - b.seq);
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index].seq !== ordered[index - 1].seq + 1) {
        throw archiveError('archive_gap', 'a segment must be a contiguous run of event seqs');
      }
    }
    const from = ordered[0].seq;
    const to = ordered[ordered.length - 1].seq;
    const dir = projectDir(projectId);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, segmentFileName(from, to));
    const payload = ordered.map((event) => JSON.stringify(event)).join('\n') + '\n';
    const bytes = zstdCompressSync(Buffer.from(payload, 'utf8'));
    const digest = sha256(bytes);
    try {
      await fs.access(file);
      const existing = await readSegment({ file, name: path.basename(file), from, to });
      const existingDigest = sha256(await fs.readFile(file));
      if (existingDigest !== digest || existing.length !== ordered.length) {
        throw archiveError('archive_conflict', `segment ${path.basename(file)} already exists with different content`);
      }
      return { file, from, to, count: existing.length, checksum: digest };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, bytes);
    // Rename is atomic; the checksum sidecar is written first so a reader can
    // never see a segment without its digest.
    await fs.writeFile(`${file}.sha256`, `${digest}  ${path.basename(file)}\n`, { flag: 'wx' }).catch(async (error) => {
      if (error.code !== 'EEXIST') throw error;
      const existing = (await fs.readFile(`${file}.sha256`, 'utf8')).trim().split(/\s+/)[0];
      if (existing !== digest) throw archiveError('archive_conflict', `checksum sidecar for ${path.basename(file)} differs`);
    });
    await fs.rename(temp, file);
    return { file, from, to, count: ordered.length, checksum: digest };
  }

  async function removeProject(projectId) {
    await fs.rm(projectDir(projectId), { recursive: true, force: true });
  }

  // The store's read API is synchronous (listEvents/pageEvents are used from
  // HTTP handlers without an await). Cold reads therefore use sync file I/O;
  // writes remain async and atomic.
  function listSegmentsSync(projectId) {
    const dir = projectDir(projectId);
    let names;
    try {
      names = fsSync.readdirSync(dir);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const out = [];
    for (const name of names) {
      const match = SEGMENT_RE.exec(name);
      if (!match) continue;
      out.push({ file: path.join(dir, name), name, from: Number(match[1]), to: Number(match[2]) });
    }
    out.sort((a, b) => a.from - b.from || a.to - b.to);
    return out;
  }

  function readSegmentSync(descriptor) {
    const bytes = fsSync.readFileSync(descriptor.file);
    let expected;
    try {
      expected = fsSync.readFileSync(`${descriptor.file}.sha256`, 'utf8').trim().split(/\s+/)[0];
    } catch (error) {
      throw archiveError('archive_checksum_missing', `missing sha256 for ${descriptor.name}: ${error.message}`);
    }
    const actual = sha256(bytes);
    if (!expected || expected !== actual) {
      throw archiveError('archive_checksum_mismatch', `sha256 mismatch for ${descriptor.name}: ${expected} != ${actual}`);
    }
    let text;
    try {
      text = zstdDecompressSync(bytes).toString('utf8');
    } catch (error) {
      throw archiveError('archive_corrupt', `cannot decompress ${descriptor.name}: ${error.message}`);
    }
    const events = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        throw archiveError('archive_corrupt', `invalid JSON in ${descriptor.name}: ${error.message}`);
      }
      if (!Number.isInteger(event?.seq) || event.seq < descriptor.from || event.seq > descriptor.to) {
        throw archiveError('archive_corrupt', `event ${event?.seq} is outside ${descriptor.name}`);
      }
      events.push(event);
    }
    return events;
  }

  function readArchivedSync(projectId, after = 0) {
    const out = [];
    for (const descriptor of listSegmentsSync(projectId)) {
      if (descriptor.to <= after) continue;
      for (const event of readSegmentSync(descriptor)) if (event.seq > after) out.push(event);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  return {
    root,
    hotEvents,
    segmentSize,
    projectDir,
    listSegments,
    readSegment,
    readArchived,
    listSegmentsSync,
    readSegmentSync,
    readArchivedSync,
    writeSegment,
    removeProject,
  };
}
