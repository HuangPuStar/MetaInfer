import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createSandboxBackend } from '../../host/sandbox-backend.js';
import { fixture, clone } from './fakes.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const OP = '6c3dda68-dd4f-4b04-9180-d694ba199544';
const BID = 'b03ffd42-7de4-4610-b893-315a7a0d5d01';
const FILESHA = sha('historical-operation-bytes');

async function run(fn, { unresolved = [], decision, rawDecision } = {}) {
  const f = await fixture();
  try {
    f.probe = { ...clone(f.probe), unresolved };
    f.decisionPath = path.join(f.temp, 'admission.json');
    if (rawDecision !== undefined) await writeFile(f.decisionPath, rawDecision);
    else if (decision !== undefined) await writeFile(f.decisionPath, JSON.stringify(decision(f)));
    const b = createSandboxBackend({ readNode: f.readNode, commitBinding: f.commitBinding, configPath: f.configPath, requestsDir: f.requestsDir, decisionPath: f.decisionPath, clock: () => f.now, transport: f.transport });
    await fn({ f, b });
  } finally { await f.cleanup(); }
}
function decision(f, over = {}) {
  return { schemaVersion: 1, kind: 'historical-admission-decision', decisionId: '0f0e0d0c-0b0a-4908-8706-050403020100', profile: f.t.profile, targetIdentity: f.t.targetIdentity, catalogSha256: f.t.catalogSha256, decidedAt: 1794767315000, accepted: [{ kind: 'operations', id: OP, state: 'unknown', fileSha256: FILESHA }], ...over };
}
const opRow = { kind: 'operations', identity: OP, state: 'unknown', fileSha256: FILESHA };
const rejects = (b, code) => assert.rejects(() => b.preflight('pclab19'), e => e.code === code);

test('no decision + unresolved historical unknown blocks admission', () => run(async ({ b }) => {
  await rejects(b, 'SANDBOX_PREFLIGHT');
}, { unresolved: [opRow] }));

test('exact historical decision admits only the pinned immutable unknown row', () => run(async ({ b }) => {
  const value = await b.preflight('pclab19');
  assert.equal(value.ready, true);
  assert.equal(value.historicalAdmission.decisionId, '0f0e0d0c-0b0a-4908-8706-050403020100');
  assert.deepEqual(value.historicalAdmission.accepted, [{ kind: 'operations', id: OP, state: 'unknown', fileSha256: FILESHA }]);
}, { unresolved: [opRow], decision: f => decision(f) }));

test('file hash drift, extra accepted row, or missing accepted row fails closed', () => run(async ({ b, f }) => {
  await writes(f, decision(f, { accepted: [{ kind: 'operations', id: OP, state: 'unknown', fileSha256: sha('different') }] }));
  await rejects(b, 'SANDBOX_PREFLIGHT');
  await writes(f, decision(f, { accepted: [{ kind: 'operations', id: OP, state: 'unknown', fileSha256: FILESHA }, { kind: 'operations', id: '22222222-2222-4222-8222-222222222222', state: 'unknown', fileSha256: FILESHA }] }));
  await rejects(b, 'SANDBOX_PREFLIGHT');
}, { unresolved: [opRow] }));

test('unresolved rows not exactly covered by the decision are rejected', () => run(async ({ b }) => {
  await rejects(b, 'SANDBOX_PREFLIGHT');
}, { unresolved: [opRow, { kind: 'bindings', identity: BID, state: 'createUnknown', fileSha256: FILESHA, verifiedClean: false, createUncertain: true }], decision: f => decision(f) }));

test('a binding row can never be admitted by a historical decision', () => run(async ({ b, f }) => {
  const row = { kind: 'bindings', identity: BID, state: 'createUnknown', fileSha256: FILESHA, verifiedClean: false, createUncertain: true };
  await rejects(b, 'SANDBOX_PREFLIGHT');
}, { unresolved: [opRow, { kind: 'bindings', identity: BID, state: 'createUnknown', fileSha256: FILESHA, verifiedClean: false, createUncertain: true }], decision: f => decision(f, { accepted: [{ kind: 'operations', id: OP, state: 'unknown', fileSha256: FILESHA }, { kind: 'bindings', id: BID, state: 'released', verifiedClean: true, fileSha256: FILESHA }] }) }));

test('decision identity must match target identity/profile/catalog', () => run(async ({ b, f }) => {
  await writes(f, decision(f, { targetIdentity: 'f'.repeat(64) }));
  await rejects(b, 'SANDBOX_CONFIG');
  await writes(f, decision(f, { profile: 'other-profile' }));
  await rejects(b, 'SANDBOX_CONFIG');
  await writes(f, decision(f, { catalogSha256: 'e'.repeat(64) }));
  await rejects(b, 'SANDBOX_CONFIG');
}, { unresolved: [opRow] }));

test('stale decision with no unresolved rows is rejected instead of silently ignored', () => run(async ({ b, f }) => {
  await writes(f, decision(f));
  await rejects(b, 'SANDBOX_PREFLIGHT');
}));

test('malformed, oversized, duplicate or non-unknown decisions fail closed', () => run(async ({ b, f }) => {
  await writes(f, '{broken');
  await rejects(b, 'SANDBOX_CONFIG');
  await writes(f, 'x'.repeat(65537));
  await rejects(b, 'SANDBOX_CONFIG');
  await writes(f, decision(f, { accepted: [{ kind: 'operations', id: OP, state: 'unknown', fileSha256: FILESHA }, { kind: 'operations', id: OP, state: 'unknown', fileSha256: FILESHA }] }));
  await rejects(b, 'SANDBOX_CONFIG');
  await writes(f, decision(f, { accepted: [{ kind: 'operations', id: OP, state: 'completed', fileSha256: FILESHA }] }));
  await rejects(b, 'SANDBOX_CONFIG');
}, { unresolved: [opRow] }));

async function writes(f, value) { await writeFile(f.decisionPath, typeof value === 'string' ? value : JSON.stringify(value)); }
