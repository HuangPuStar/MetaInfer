/** Bounded portable file exchange; no Host execution and no worker-selected root. */
import { constants } from 'node:fs';
import { lstat, realpath, open, readdir, mkdir, mkdtemp, rename, unlink, rmdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { sandboxAssert as check, sha256 } from './sandbox-targets.js';
export const FILE_LIMITS = Object.freeze({ count: 128, total: 16 * 1024 ** 2, read: 1024 ** 2, log: 2 * 1024 ** 2, tool: 3 * 1024 ** 2 });
const privateName = /^(?:\.git|node_modules|\.ssh|\.aws|\.azure|\.gnupg|secrets?|keys?|credentials?)(?:$|\.)|^\.env(?:$|\.)|^id_(?:rsa|dsa|ecdsa|ed25519)(?:$|\.)|\.(?:pem|key|p12|pfx)$/i;
export function validateRelativePath(value) {
  check(typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 2048 && value === value.normalize('NFC')
    && !/[\\:\x00-\x1f\x7f<>"|?*]/.test(value), 'SANDBOX_PATH', 'Expected a portable workspace-relative path');
  check(value.split('/').every(p => p && p !== '.' && p !== '..' && Buffer.byteLength(p) <= 255
    && !/[. ]$/.test(p) && !privateName.test(p) && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/i.test(p)),
    'SANDBOX_PATH', 'Private, ambiguous or non-portable workspace path');
  return value;
}
function registerPath(registry, value) {
  const parts = value.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const prefix = parts.slice(0, i).join('/'), key = prefix.toLowerCase();
    check(!registry.has(key) || registry.get(key) === prefix, 'SANDBOX_PATH', 'Case-colliding workspace paths');
    registry.set(key, prefix);
  }
}
export function validateFileManifest(payload, { maxBytes = FILE_LIMITS.total } = {}) {
  check(payload && Array.isArray(payload.files) && payload.files.length <= FILE_LIMITS.count
    && payload.truncated === false && Number.isInteger(payload.totalBytes) && payload.totalBytes >= 0,
    'SANDBOX_FILES', 'Incomplete or unbounded file collection');
  const registry = new Map(), seen = new Set(); let total = 0;
  const files = payload.files.map(item => {
    check(item && Object.keys(item).sort().join(',') === 'contentBase64,path,sha256,size', 'SANDBOX_FILES', 'Unexpected file descriptor');
    const relative = validateRelativePath(item.path); registerPath(registry, relative);
    check(!seen.has(relative), 'SANDBOX_FILES', 'Duplicate workspace file'); seen.add(relative);
    check(Number.isInteger(item.size) && item.size >= 0 && item.size <= maxBytes && /^[a-f0-9]{64}$/.test(item.sha256)
      && typeof item.contentBase64 === 'string' && item.contentBase64.length <= Math.ceil(maxBytes / 3) * 4
      && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.contentBase64),
      'SANDBOX_FILES', 'Invalid file size/hash/canonical base64');
    const content = Buffer.from(item.contentBase64, 'base64');
    check(content.toString('base64') === item.contentBase64 && content.length === item.size && sha256(content) === item.sha256,
      'SANDBOX_FILES', 'File bytes do not match size/hash/base64');
    total += content.length; check(total <= maxBytes, 'SANDBOX_FILES', 'File collection exceeds total bound');
    return { path: relative, size: item.size, sha256: item.sha256, content };
  });
  check(total === payload.totalBytes, 'SANDBOX_FILES', 'File total does not match');
  const fileKeys = new Set(files.map(f => f.path.toLowerCase()));
  for (const f of files) for (const parent of f.path.split('/').slice(0, -1).map((_, i) => f.path.split('/').slice(0, i + 1).join('/').toLowerCase()))
    check(!fileKeys.has(parent), 'SANDBOX_FILES', 'File/directory collision');
  return files;
}
const equalPath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const same = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
async function optionalStat(file) { try { return await lstat(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
export async function worktreeIdentity(value) {
  check(typeof value === 'string' && path.isAbsolute(value), 'SANDBOX_SCOPE', 'Host worktree must be absolute');
  const root = path.resolve(value), info = await lstat(root), real = await realpath(root);
  check(info.isDirectory() && !info.isSymbolicLink() && equalPath(root, real), 'SANDBOX_SCOPE', 'Worktree or an ancestor is a symlink/reparse target');
  return { root, dev: info.dev, ino: info.ino };
}
export async function assertWorktree(identity) {
  const now = await worktreeIdentity(identity.root);
  check(now.dev === identity.dev && now.ino === identity.ino, 'SANDBOX_SCOPE', 'Worktree identity changed');
}
async function parents(identity, relative, create = false, made = [], expected = null) {
  try {
    await assertWorktree(identity); let current = identity.root;
    for (const component of relative.split('/').slice(0, -1)) {
      current = path.join(current, component); let info = await optionalStat(current);
      if (!info && create) {
        check(!expected?.has(current), 'SANDBOX_SCOPE', 'Original workspace parent disappeared');
        await mkdir(current, { mode: 0o700 }); made.push(current); info = await lstat(current);
        if (expected) expected.set(current, { dev: info.dev, ino: info.ino });
      }
      check(info?.isDirectory() && !info.isSymbolicLink() && equalPath(await realpath(current), current), 'SANDBOX_PATH', 'Workspace parent is missing or redirected');
      if (expected) check(expected.get(current)?.dev === info.dev && expected.get(current)?.ino === info.ino,
        'SANDBOX_SCOPE', 'Original workspace parent identity changed');
    }
    return path.join(identity.root, ...relative.split('/'));
  } catch (error) { if (expected) error.code = 'SANDBOX_RESTORE_UNKNOWN'; throw error; }
}
async function boundedRead(file, maximum) {
  const before = await lstat(file);
  check(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= maximum, 'SANDBOX_FILES', 'Expected a bounded single-link regular file');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat(); check(same(before, opened) && opened.nlink === 1, 'SANDBOX_FILES', 'File changed before read');
    const content = Buffer.alloc(before.size + 1); let count = 0;
    while (count < content.length) { const { bytesRead } = await handle.read(content, count, content.length - count, count); if (!bytesRead) break; count += bytesRead; }
    const after = await handle.stat(), named = await lstat(file);
    check(count === before.size && same(before, after) && same(after, named) && named.nlink === 1, 'SANDBOX_FILES', 'File changed during read');
    return { content: content.subarray(0, count), info: after };
  } finally { await handle.close(); }
}
export async function readWorktreeFiles(worktree, { guard = async () => {} } = {}) {
  const identity = await worktreeIdentity(worktree), files = [], registry = new Map(); let total = 0;
  async function walk(prefix) {
    await guard(); await assertWorktree(identity);
    const directory = prefix ? await parents(identity, prefix + '/placeholder') : identity.root;
    // parents returns the placeholder, not the directory itself.
    const dir = prefix ? path.dirname(directory) : directory;
    for (const name of (await readdir(dir)).sort()) {
      if (name.toLowerCase() === '.git') continue; // Never read/transfer Git administration, including a worktree .git file.
      const relative = validateRelativePath(prefix ? prefix + '/' + name : name); registerPath(registry, relative);
      await guard(); const file = await parents(identity, relative), info = await lstat(file);
      check(!info.isSymbolicLink(), 'SANDBOX_FILES', 'Symlink input is forbidden');
      if (info.isDirectory()) await walk(relative);
      else {
        const { content } = await boundedRead(file, FILE_LIMITS.total - total); total += content.length;
        check(files.length < FILE_LIMITS.count && total <= FILE_LIMITS.total, 'SANDBOX_FILES', 'Workspace exceeds collection limits');
        files.push({ path: relative, size: content.length, sha256: sha256(content), contentBase64: content.toString('base64') });
      }
    }
  }
  await walk(''); await guard(); await assertWorktree(identity); return files;
}
async function privateWrite(file, content, mode = 0o600) {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
}
export async function restoreWorktreeFiles(worktree, payload, { guard = async () => {} } = {}) {
  await guard(); const files = validateFileManifest(payload), identity = await worktreeIdentity(worktree);
  await guard(); const stage = await mkdtemp(path.join(path.dirname(identity.root), '.sandbox-v2-'));
  const stageIdentity = await worktreeIdentity(stage), installed = [], made = [], directories = new Map(); let removeStage = false;
  async function staged(file, expected) {
    await assertWorktree(stageIdentity); const current = await lstat(file);
    check(current.isFile() && !current.isSymbolicLink() && current.nlink === 1 && same(expected, current),
      'SANDBOX_SCOPE', 'Private recovery file identity changed');
  }
  try {
    const pending = [];
    for (const [i, f] of files.entries()) {
      await assertWorktree(identity); const target = path.join(identity.root, ...f.path.split('/'));
      // Record directory identities before backups. Rollback must not trust a relocated same-inode target.
      let parent = path.dirname(target);
      while (parent !== identity.root) {
        const p = await optionalStat(parent);
        if (p) {
          check(p.isDirectory() && !p.isSymbolicLink() && equalPath(await realpath(parent), parent), 'SANDBOX_PATH', 'Redirected restore parent');
          const previous = directories.get(parent);
          check(!previous || (previous.dev === p.dev && previous.ino === p.ino), 'SANDBOX_SCOPE', 'Restore parent changed during preparation');
          directories.set(parent, { dev: p.dev, ino: p.ino });
        }
        parent = path.dirname(parent);
      }
      const before = await optionalStat(target), backup = before ? path.join(stage, i + '.before') : null;
      let backupInfo;
      if (before) {
        const { content, info } = await boundedRead(target, FILE_LIMITS.total);
        check(same(before, info), 'SANDBOX_SCOPE', 'Restore target changed before backup');
        await assertWorktree(stageIdentity); await privateWrite(backup, content, before.mode & 0o777); backupInfo = await lstat(backup);
      }
      // Keep incoming recovery bytes even if a new file has no previous backup and its parent moves.
      await assertWorktree(stageIdentity); await privateWrite(path.join(stage, i + '.after'), f.content);
      const incoming = path.join(stage, i + '.new'); await assertWorktree(stageIdentity);
      await privateWrite(incoming, f.content, before ? before.mode & 0o777 : 0o600);
      pending.push({ ...f, target, before, backup, backupInfo, incoming, incomingInfo: await lstat(incoming) });
    }
    await guard();
    for (const item of pending) {
      await guard(); await parents(identity, item.path, true, made, directories);
      const current = await optionalStat(item.target);
      check((!item.before && !current) || same(item.before, current), 'SANDBOX_SCOPE', 'Restore target changed concurrently');
      await staged(item.incoming, item.incomingInfo); await parents(identity, item.path, false, [], directories);
      // Record the intended inode before rename: even an ambiguous rename failure retains recovery materials.
      installed.push({ ...item, after: item.incomingInfo }); await rename(item.incoming, item.target);
      await parents(identity, item.path, false, [], directories);
      check(same(item.incomingInfo, await lstat(item.target)), 'SANDBOX_SCOPE', 'Installed file identity changed'); await guard();
    }
    await assertWorktree(identity); await guard();
    for (const item of installed) {
      await parents(identity, item.path, false, [], directories);
      check(same(item.after, await lstat(item.target)), 'SANDBOX_SCOPE', 'Installed file changed before completion');
    }
    removeStage = true;
    return { files: files.map(({ path, size, sha256 }) => ({ path, size, sha256 })), totalBytes: payload.totalBytes, truncated: false };
  } catch (error) {
    let restored = error.code !== 'SANDBOX_RESTORE_UNKNOWN';
    try { await assertWorktree(identity); await assertWorktree(stageIdentity); } catch { restored = false; }
    for (const item of installed.reverse()) {
      try {
        await parents(identity, item.path, false, [], directories); await assertWorktree(stageIdentity);
        const current = await lstat(item.target);
        check(current.isFile() && !current.isSymbolicLink() && current.nlink === 1 && same(item.after, current), 'SANDBOX_SCOPE', 'Concurrent changes prevent rollback');
        if (item.backup) await staged(item.backup, item.backupInfo);
        await parents(identity, item.path, false, [], directories);
        check(same(item.after, await lstat(item.target)), 'SANDBOX_SCOPE', 'Rollback target changed');
        if (item.backup) await rename(item.backup, item.target); else await unlink(item.target);
      } catch { restored = false; }
    }
    if (restored) {
      for (const dir of made.reverse()) {
        try {
          const relative = path.relative(identity.root, dir).split(path.sep).join('/') + '/placeholder';
          await parents(identity, relative, false, [], directories); await rmdir(dir); directories.delete(dir);
        } catch { restored = false; break; }
      }
    }
    if (restored) removeStage = true;
    else { error.recoveryPath = stage; error.code = 'SANDBOX_RESTORE_UNKNOWN'; }
    throw error;
  } finally {
    if (removeStage) {
      try { await assertWorktree(stageIdentity); await rm(stage, { recursive: true, force: true }); }
      catch (error) { error.recoveryPath = stage; error.code = 'SANDBOX_RESTORE_UNKNOWN'; throw error; }
    }
  }
}
