import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { getSandboxTarget, isSandboxProfile, validateTransportConfig } from '../../host/sandbox-targets.js';
const sha = (v) => createHash('sha256').update(v).digest('hex');
test('catalog is exact one-way data, 19 stays immutable and 27 is a separate reviewed catalog', async () => {
  assert.equal(sha(await readFile(new URL('../../host/sandbox-targets.json', import.meta.url))), '6eed8c85ae2dc996da80c1683ead77f07f2f60964e975d37d1144b049a60445f');
  assert.equal(sha(await readFile(new URL('../../host/sandbox-targets-pclab27.json', import.meta.url))), '9a16f2a98196c7b5b51e70589c8f669ee7363ae37ddd584c91b1f46828f0d0e0');
  const t = getSandboxTarget('pclab19');
  assert.equal(t.sshAlias, 'pclab2');
  assert.equal(t.remoteRoot, '/mnt/newdata/metainfer-opensandbox-19-20261113');
  assert.deepEqual(t.devices.map(d => d.render), [132,133,134,135].map(n => `/dev/dri/renderD${n}`));
  assert.deepEqual(t.devices.map(d => d.bdf), ['85','b5','d5','f5'].map(n => `0000:${n}:00.0`));
  assert.equal(t.targetIdentity, '15f599c072a796ef9e6958584bf9337a3573d53908eb4af36daf71605bf5d4b6');
  assert.equal(t.identityLabel, 't-cx2ztqdsu6lo7htjlbmex6jtpi2xhvjzbdvuv43nv5ywaw7v2s3a');
  assert.ok(Object.isFrozen(t) && Object.isFrozen(t.devices[0]));
  assert.throws(() => { t.devices[0].render='/dev/dri/renderD128'; });
  const u = getSandboxTarget('pclab27');
  assert.equal(u.sshAlias, 'pclab');
  assert.equal(u.remoteRoot, '/data/opensandbox-cluster-metainfer-20261111');
  assert.deepEqual(u.devices.map(d => d.render), ['/dev/dri/renderD128','/dev/dri/renderD129']);
  assert.deepEqual(u.devices.map(d => d.bdf), ['0000:09:00.0','0000:36:00.0']);
  assert.match(u.targetIdentity, /^[0-9a-f]{64}$/);
  assert.match(u.identityLabel, /^t-[a-z2-7]{40,63}$/);
  for (const p of ['pclab','',' pclab19',null,{},'pclab19\n','pclab99']) {
    assert.equal(isSandboxProfile(p),false);assert.throws(() => getSandboxTarget(p));
  }
  assert.equal(isSandboxProfile('pclab19'),true);
  assert.equal(isSandboxProfile('pclab27'),true);
});
test('operator transport config accepts exactly three pinned keys', () => {
  const t=getSandboxTarget('pclab19'), cfg={sshAlias:t.sshAlias,remoteRoot:t.remoteRoot,python:t.python};
  assert.deepEqual(validateTransportConfig(cfg,t),cfg);
  for(const bad of [{...cfg,devices:[]},{...cfg,sshAlias:'pclab'},{...cfg,python:'python'},{...cfg,remoteRoot:'/tmp'},{...cfg,image:t.image},{},null]) assert.throws(()=>validateTransportConfig(bad,t));
});
