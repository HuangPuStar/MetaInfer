/** V2-owned catalog. Data was imported once; no legacy code/state is loaded. */
import { readFileSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const CATALOG_SHA256 = '6eed8c85ae2dc996da80c1683ead77f07f2f60964e975d37d1144b049a60445f';
export function sandboxFail(code, message, unknown = false) {
  const error = new Error(message); error.code = code; error.unknown = unknown; throw error;
}
export function sandboxAssert(ok, code, message) { if (!ok) sandboxFail(code, message); }
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function canonicalJson(value) {
  function sort(v) {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])]));
    return v;
  }
  return JSON.stringify(sort(value)).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const catalogPath = fileURLToPath(new URL('./sandbox-targets.json', import.meta.url));
const info = lstatSync(catalogPath);
sandboxAssert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 65536, 'SANDBOX_CATALOG', 'Catalog is not a bounded regular file');
const bytes = readFileSync(catalogPath);
sandboxAssert(sha256(bytes) === CATALOG_SHA256, 'SANDBOX_CATALOG', 'Catalog bytes do not match the reviewed authority');
const catalog = JSON.parse(bytes);
const record = catalog.profiles.pclab19;
sandboxAssert(catalog.schemaVersion === 1 && record.sshAlias === 'pclab2'
  && record.remoteRoot === '/mnt/newdata/metainfer-opensandbox-19-20261113'
  && record.python === record.remoteRoot + '/venv/bin/python'
  && record.devices.length === 4
  && record.devices.every((d, i) => d.render === '/dev/dri/renderD' + (132 + i) && /^0000:[0-9a-f]{2}:00\.0$/.test(d.bdf))
  && new Set(record.devices.map(d => d.bdf)).size === 4, 'SANDBOX_CATALOG', 'Catalog target violates the 19-only policy');
const config = {
  schemaVersion: 1, profile: 'pclab19', catalogSha256: CATALOG_SHA256,
  poolId: 'pclab2-node19-dcu-4-7', serverId: 'pclab19-safe-dcu', owner: 'metainfer-pclab19',
  image: 'sha256:2ad719884561ec37de050545f81567f76d69d46dc4436a3208786785e138591e',
  mount: { target: '/mnt/newdata', uuid: '07f1fad3-38d7-49ae-8714-91a437b0d852' },
};
const targetIdentity = sha256(canonicalJson(config));
function identityLabel(hex) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'; let bits = 0, value = 0, out = 't-';
  for (const byte of Buffer.from(hex, 'hex')) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; out += alphabet[(value >>> bits) & 31]; }
  }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
const target = freeze({ ...record, ...config, targetIdentity, identityLabel: identityLabel(targetIdentity),
  configSha256: '6bdd182622353250a8d150e2892fb3072af360e7aff4f43adf4bfc7d43bc7f56',
  codeSha256: {
    'bridge.py': '5cfed6d84a7e2ddfa071eac6c91965c8e655e23760c6c8110b0ee1e0d9104176',
    'adapter/dcu_adapter.py': '915841e1218269f855c715dc83164de11a6c0cebf6fbd85eda4e2d14d5e7301f',
    'adapter/launch.py': 'b3f0b0890a3aae9c6ef2e5d95f686ed046811261f92c075482b1d785d38fd55a',
    'remote-runtime/target_config.py': 'f49a43317106ccae7a32cb2844c185105cb7c3a63cec326d098431a3ea4e2612',
  },
});
// Second site. The 19 catalog above is immutable: its bytes are the reviewed authority for the
// existing bindings/decisions, so 27 gets an independent catalog with its own pinned SHA.
export const CATALOG27_SHA256 = '9a16f2a98196c7b5b51e70589c8f669ee7363ae37ddd584c91b1f46828f0d0e0';
const catalog27Path = fileURLToPath(new URL('./sandbox-targets-pclab27.json', import.meta.url));
const info27 = lstatSync(catalog27Path);
sandboxAssert(info27.isFile() && !info27.isSymbolicLink() && info27.nlink === 1 && info27.size <= 65536, 'SANDBOX_CATALOG', '27 catalog is not a bounded regular file');
const bytes27 = readFileSync(catalog27Path);
sandboxAssert(sha256(bytes27) === CATALOG27_SHA256, 'SANDBOX_CATALOG', '27 catalog bytes do not match the reviewed authority');
const catalog27 = JSON.parse(bytes27);
const record27 = catalog27.profiles.pclab27;
sandboxAssert(catalog27.schemaVersion === 1 && Object.keys(catalog27.profiles).length === 1 && record27.sshAlias === 'pclab'
  && record27.remoteRoot === '/data/opensandbox-cluster-metainfer-20261111'
  && record27.python === record27.remoteRoot + '/venv/bin/python'
  && record27.devices.length === 2
  && record27.devices.every((d, i) => d.render === '/dev/dri/renderD' + (128 + i) && /^0000:[0-9a-f]{2}:00\.0$/.test(d.bdf))
  && new Set(record27.devices.map(d => d.bdf)).size === 2, 'SANDBOX_CATALOG', '27 catalog target violates the 0-1 only policy');
const config27 = {
  schemaVersion: 1, profile: 'pclab27', catalogSha256: CATALOG27_SHA256,
  poolId: 'pclab27-dcu-0-3', serverId: 'pclab27-safe-dcu', owner: 'metainfer-pclab27',
  image: 'sha256:94a6bd36f4d857c24d240e0d010ce07c922ec47ea711bce179a35bbdc266fc94',
  mount: { target: '/data', uuid: '4768d52c-06ef-4f19-9286-c4e352502a52' },
};
const targetIdentity27 = sha256(canonicalJson(config27));
const target27 = freeze({ ...record27, ...config27, targetIdentity: targetIdentity27, identityLabel: identityLabel(targetIdentity27),
  configSha256: sha256(canonicalJson(config27)),
  codeSha256: {
    'bridge.py': '5cfed6d84a7e2ddfa071eac6c91965c8e655e23760c6c8110b0ee1e0d9104176',
    'adapter/dcu_adapter.py': '9da017a569141fc10f814187c2abddfea2580dac0c9276b510045dfad464113e',
    'adapter/launch.py': '3948d127d5b5dac7439279d048eb5f1ef458ed6dee65ef28dc478db0f3122ce8',
    'remote-runtime/target_config.py': '1f3906a06fea16c81494c9d3ac2ea845a0daf1ed1c35961f289b73ef78b7f8bd',
  },
});
const targets = Object.freeze({ pclab19: target, pclab27: target27 });
export function isSandboxProfile(profile) { return typeof profile === 'string' && Object.hasOwn(targets, profile); }
export function getSandboxTarget(profile) {
  sandboxAssert(isSandboxProfile(profile), 'SANDBOX_TARGET', 'Only the reviewed sandbox targets are supported');
  return targets[profile];
}
export function validateTransportConfig(config, t = target) {
  const keys = ['sshAlias', 'remoteRoot', 'python'];
  sandboxAssert(config && typeof config === 'object' && !Array.isArray(config)
    && Object.keys(config).length === 3 && keys.every(k => Object.hasOwn(config, k) && config[k] === t[k]),
    'SANDBOX_CONFIG', 'Operator transport config must have exactly the three pinned public transport keys');
  return Object.fromEntries(keys.map(k => [k, config[k]]));
}
