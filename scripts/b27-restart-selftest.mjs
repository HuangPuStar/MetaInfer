#!/usr/bin/env node
/**
 * B27 restart continuity.
 *
 * The actor-key registry is durable in the v2 store. This probe writes three
 * Host-issued keys, closes the store, starts a *fresh Node process* over the
 * same file domain, and in that child resolves an appeal and executes the real
 * irreversible action. An unknown key must still fail closed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore } from '../host/store.js';
import { createJsonFileDomain } from './lib/json-file-domain.mjs';
import { isIssuedActorKey, resetActorKeyRegistryForTest } from '../host/kernel/actors.js';
import { actorForSession as policyActorForSession } from '../host/kernel/policy.js';
import { storeContext } from './lib/memory-domain.mjs';

let failed = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`ok   ${name}`);
  else { failed += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const projectId = 'b27-restart-p';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b27-restart-'));
const file = path.join(dir, 'domain.json');
const ctx = () => storeContext(createJsonFileDomain(file));

const storeA = await openStore(ctx());
const humanSession = { id: 'b27-restart-human' };
const expertSession = { id: 'b27-restart-expert' };
const confirmerSession = { id: 'b27-restart-confirmer' };
const humanKey = policyActorForSession({ sessionId: humanSession.id, session: humanSession }).actorKey;
const expertKey = policyActorForSession({ sessionId: expertSession.id, session: expertSession }).actorKey;
const confirmerKey = policyActorForSession({ sessionId: confirmerSession.id, session: confirmerSession }).actorKey;
await storeA.flushActorKeys();
await storeA.saveProject({
  id: projectId, revision: 0, counters: { eventSeq: 0 },
  config: { maxRunningNodes: 2, resourcePools: {}, maxNodes: 100 },
  claimStats: { 'b27-restart-human': { total: 20, failed: 0 } }, createdAt: 0, updatedAt: 0,
});
check('keys are minted Host-side before restart',
  [humanKey, expertKey, confirmerKey].every((key) => key.startsWith('ak_host_'))
  && new Set([humanKey, expertKey, confirmerKey]).size === 3);
check('the v2 store contains key, session id, issuedAt and project binding fields',
  storeA.listActorKeys().length >= 3
  && storeA.listActorKeys().every((row) => row.key.startsWith('ak_host_') && typeof row.sessionId === 'string' && Number.isFinite(row.issuedAt) && Object.hasOwn(row, 'projectId')),
  JSON.stringify(storeA.listActorKeys()));
await storeA.close();

// Fresh process: nothing from the parent registry is available in the child.
resetActorKeyRegistryForTest();
const childPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib', 'b27-restart-child.mjs');
const child = spawnSync(process.execPath, [childPath, file, projectId, humanKey, expertKey, confirmerKey], {
  encoding: 'utf8', timeout: 60_000,
});
const lines = String(child.stdout ?? '').trim().split('\n').filter(Boolean);
let childResult = null;
try { childResult = JSON.parse(lines[lines.length - 1] ?? '{}'); } catch { childResult = { parseError: lines[lines.length - 1] ?? '' }; }
check('the fresh process exits cleanly', child.status === 0, JSON.stringify({ status: child.status, stderr: String(child.stderr ?? '').slice(0, 800), result: childResult }));
check('the restarted Host restores every issued key', childResult.restoredHuman && childResult.restoredExpert && childResult.restoredConfirmer, JSON.stringify(childResult));
check('the same DSH session id receives the same key after restart', childResult.sameId === true, JSON.stringify(childResult));
check('an unknown key is still not trusted after restart', childResult.forged === false, JSON.stringify(childResult));
check('the restored appeal resolves and the real irreversible action succeeds', childResult.resolved === true && childResult.deleted === true && childResult.projectGone === true, JSON.stringify(childResult));

// The parent reopens the same file and sees both the durable keys and the
// deletion performed by the child.
const storeB = await openStore(ctx());
check('the re-opened store still knows the human key', isIssuedActorKey(humanKey), JSON.stringify(storeB.listActorKeys()));
check('the irreversible action deleted the project for the next process too', storeB.getProject(projectId) === undefined);
check('the first project acted on is recorded on the durable key',
  storeB.listActorKeys().some((row) => row.key === humanKey && row.projectId === projectId),
  JSON.stringify(storeB.listActorKeys()));
check('a new session object with the same id receives the same key after re-open',
  policyActorForSession({ sessionId: 'b27-restart-human', session: { id: 'b27-restart-human' } }).actorKey === humanKey);
await storeB.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${failed === 0 ? 'b27-restart-selftest: all checks passed' : `b27-restart-selftest: ${failed} failed`}`);
process.exit(failed === 0 ? 0 : 1);
