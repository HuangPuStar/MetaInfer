import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getSandboxTarget, isSandboxProfile, CATALOG_SHA256, CATALOG27_SHA256 } from '../../host/sandbox-targets.js';
import { createSandboxBackend } from '../../host/sandbox-backend.js';

const temps = [];
async function temp() { const dir = await mkdtemp(path.join(os.tmpdir(), 'sandbox-dual-')); temps.push(dir); return dir; }
test.after(async () => { for (const dir of temps) await rm(dir, { recursive: true, force: true }); });

test('19 target identity and code pins are unchanged by the second site', () => {
  const t = getSandboxTarget('pclab19');
  assert.equal(CATALOG_SHA256, '6eed8c85ae2dc996da80c1683ead77f07f2f60964e975d37d1144b049a60445f');
  assert.equal(t.profile, 'pclab19');
  assert.equal(t.targetIdentity, '15f599c072a796ef9e6958584bf9337a3573d53908eb4af36daf71605bf5d4b6');
  assert.equal(t.configSha256, '6bdd182622353250a8d150e2892fb3072af360e7aff4f43adf4bfc7d43bc7f56');
  assert.deepEqual(t.devices.map(d => d.render), ['/dev/dri/renderD132', '/dev/dri/renderD133', '/dev/dri/renderD134', '/dev/dri/renderD135']);
  assert.equal(t.codeSha256['remote-runtime/target_config.py'], 'f49a43317106ccae7a32cb2844c185105cb7c3a63cec326d098431a3ea4e2612');
});

test('27 target is independent and exposes only physical cards 0-1', () => {
  const t = getSandboxTarget('pclab27');
  assert.equal(CATALOG27_SHA256, '9a16f2a98196c7b5b51e70589c8f669ee7363ae37ddd584c91b1f46828f0d0e0');
  assert.equal(t.profile, 'pclab27');
  assert.equal(t.sshAlias, 'pclab');
  assert.equal(t.remoteRoot, '/data/opensandbox-cluster-metainfer-20261111');
  assert.equal(t.python, '/data/opensandbox-cluster-metainfer-20261111/venv/bin/python');
  assert.deepEqual(t.devices, [
    { render: '/dev/dri/renderD128', bdf: '0000:09:00.0' },
    { render: '/dev/dri/renderD129', bdf: '0000:36:00.0' },
  ]);
  assert.equal(t.mount.target, '/data');
  assert.equal(t.mount.uuid, '4768d52c-06ef-4f19-9286-c4e352502a52');
  assert.equal(t.image, 'sha256:94a6bd36f4d857c24d240e0d010ce07c922ec47ea711bce179a35bbdc266fc94');
  assert.match(t.targetIdentity, /^[0-9a-f]{64}$/);
  assert.match(t.identityLabel, /^t-[a-z2-7]{40,63}$/);
  assert.equal(t.codeSha256['bridge.py'], '5cfed6d84a7e2ddfa071eac6c91965c8e655e23760c6c8110b0ee1e0d9104176');
  assert.equal(t.codeSha256['remote-runtime/target_config.py'], '1f3906a06fea16c81494c9d3ac2ea845a0daf1ed1c35961f289b73ef78b7f8bd');
});

test('unknown profiles are rejected and both reviewed profiles are sandbox profiles', () => {
  assert.equal(isSandboxProfile('pclab19'), true);
  assert.equal(isSandboxProfile('pclab27'), true);
  assert.equal(isSandboxProfile('pclab'), false);
  assert.equal(isSandboxProfile(undefined), false);
  assert.throws(() => getSandboxTarget('pclab99'), (error) => error.code === 'SANDBOX_TARGET');
});

test('the backend resolves transport config per profile instead of sharing the 19 file', async () => {
  const dir = await temp();
  const bad27 = path.join(dir, 'bad27.json'), bad19 = path.join(dir, 'bad19.json'), decision = path.join(dir, 'decision.json');
  await writeFile(bad27, '{"sshAlias":"wrong"}');
  await writeFile(bad19, '{"sshAlias":"wrong"}');
  await writeFile(decision, '{"kind":"wrong"}');
  const backend = createSandboxBackend({
    readNode: async () => { throw new Error('readNode must not be called by preflight'); },
    commitBinding: async () => { throw new Error('commitBinding must not be called by preflight'); },
    configPaths: { pclab19: bad19, pclab27: bad27 },
    decisionPaths: { pclab19: decision, pclab27: decision },
    transport: async () => { throw new Error('transport must not be called for a malformed transport config'); },
  });
  await assert.rejects(backend.preflight('pclab27'), (error) => error.code === 'SANDBOX_CONFIG');
  await assert.rejects(backend.preflight('pclab19'), (error) => error.code === 'SANDBOX_CONFIG');
});

test('the backend reads the 27 admission decision file when the transport config is valid', async () => {
  const dir = await temp();
  const root = '/data/opensandbox-cluster-metainfer-20261111';
  const config = path.join(dir, 'ok27.json'), config19 = path.join(dir, 'ok19.json');
  const decision27 = path.join(dir, 'decision27.json'), decision19 = path.join(dir, 'decision19.json');
  await writeFile(config, JSON.stringify({ sshAlias: 'pclab', remoteRoot: root, python: root + '/venv/bin/python' }));
  await writeFile(config19, JSON.stringify({ sshAlias: 'pclab2', remoteRoot: '/mnt/newdata/metainfer-opensandbox-19-20261113', python: '/mnt/newdata/metainfer-opensandbox-19-20261113/venv/bin/python' }));
  await writeFile(decision27, 'not json');
  await writeFile(decision19, '{"schemaVersion":1}');
  const backend = createSandboxBackend({
    readNode: async () => { throw new Error('readNode must not be called by preflight'); },
    commitBinding: async () => { throw new Error('commitBinding must not be called by preflight'); },
    configPaths: { pclab19: config19, pclab27: config },
    decisionPaths: { pclab19: decision19, pclab27: decision27 },
    transport: async () => { throw new Error('transport must not be called when the decision is malformed'); },
  });
  await assert.rejects(backend.preflight('pclab27'), (error) => error.code === 'SANDBOX_CONFIG');
  await assert.rejects(backend.preflight('pclab19'), (error) => error.code === 'SANDBOX_CONFIG');
});
