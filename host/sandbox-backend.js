/** Host-only v2 transport. Kernel durable intents are the authority; never replay uncertainty. */
import { constants } from 'node:fs';
import { open, mkdir, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { getSandboxTarget, isSandboxProfile, validateTransportConfig, sandboxAssert as check, sandboxFail, sha256, canonicalJson } from './sandbox-targets.js';
import { FILE_LIMITS, validateRelativePath, validateFileManifest, readWorktreeFiles, restoreWorktreeFiles, worktreeIdentity, assertWorktree } from './sandbox-files.js';
const clone = value => structuredClone(value);
const uncertain = op => ['intent', 'unknown', 'inProgress'].includes(op?.state);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const allowedBindingFields = ['managedId','providerId','containerId','state','expiresAt','gpuCount','renders','bdfs','verifiedClean'];
const equal = (a, b) => canonicalJson(a) === canonicalJson(b);
function exact(object, keys) { check(object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).every(k => keys.includes(k)), 'SANDBOX_INPUT', 'Unexpected input field/target selector'); }
function toolValue(result, maximum) {
  check(result && typeof result === 'object' && !Array.isArray(result) && (result.isError === undefined || result.isError === false)
    && (result.truncated === undefined || result.truncated === false), 'SANDBOX_TRANSPORT', 'Tool failed or truncated its result');
  if (Object.hasOwn(result, 'content')) {
    check(Object.keys(result).every(k => ['content','isError','truncated'].includes(k)) && Array.isArray(result.content)
      && result.content.length === 1 && result.content[0].type === 'text' && typeof result.content[0].text === 'string'
      && Buffer.byteLength(result.content[0].text) <= maximum, 'SANDBOX_TRANSPORT', 'Ambiguous or oversized tool result');
    result = JSON.parse(result.content[0].text);
    check(result && typeof result === 'object' && !Array.isArray(result) && !Object.hasOwn(result, 'content')
      && result.isError !== true && result.truncated !== true, 'SANDBOX_TRANSPORT', 'Nested or failed tool result');
  }
  return result;
}
function envelope(result) {
  result = toolValue(result, 24 * 1024 ** 2);
  const required = ['success','exitCode','timedOut','stdout','stderr','durationMs'];
  check(required.every(k => Object.hasOwn(result, k)) && Object.keys(result).every(k => required.includes(k) || k === 'error')
    && result.success === true && result.timedOut === false && Number.isSafeInteger(result.exitCode) && result.exitCode === 0
    && Number.isSafeInteger(result.durationMs) && result.durationMs >= 0
    && (!Object.hasOwn(result, 'error') || (typeof result.error === 'string' && result.error === ''))
    && typeof result.stdout === 'string' && typeof result.stderr === 'string'
    && Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 24 * 1024 ** 2,
    'SANDBOX_TRANSPORT', 'Missing exact official SSH success or bounded process result');
  return JSON.parse(result.stdout);
}
function uploadAcknowledged(result, bytes) {
  const value = toolValue(result, 65536);
  check(Object.keys(value).sort().join(',') === 'files,ok,transferredBytes' && value.ok === true && value.files === 1
    && Number.isSafeInteger(value.transferredBytes) && value.transferredBytes === bytes, 'SANDBOX_TRANSPORT', 'Upload lacks exact official one-file byte acknowledgement');
}
const PREFLIGHT_LAYOUT = Object.freeze({ operations: 'operations', bindings: 'bindings', stop: 'state/STOP', admission: 'admission-blocked.json', nativePending: 'adapter/dcu-allocation.lock' });
const ADMISSION_DECISION_KIND = 'historical-admission-decision';
const ADMISSION_DECIDED_KEYS = 'accepted,catalogSha256,decidedAt,decisionId,kind,profile,schemaVersion,targetIdentity';
const ADMISSION_STATE = Object.freeze({ operations: 'unknown', bindings: 'released' });
function admissionDecision(t, value) {
  check(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === ADMISSION_DECIDED_KEYS
    && value.schemaVersion === 1 && value.kind === ADMISSION_DECISION_KIND
    && uuid(value.decisionId) && value.profile === t.profile && value.targetIdentity === t.targetIdentity
    && value.catalogSha256 === t.catalogSha256 && Number.isSafeInteger(value.decidedAt) && value.decidedAt > 0
    && Array.isArray(value.accepted) && value.accepted.length >= 1 && value.accepted.length <= 8,
    'SANDBOX_CONFIG', 'Malformed historical admission decision');
  const seen = new Set(), accepted = value.accepted.map(row => {
    const keys = row?.kind === 'bindings' ? 'fileSha256,id,kind,state,verifiedClean' : 'fileSha256,id,kind,state';
    check(row && typeof row === 'object' && !Array.isArray(row) && Object.keys(row).sort().join(',') === keys
      && Object.hasOwn(ADMISSION_STATE, row.kind) && uuid(row.id)
      && typeof row.fileSha256 === 'string' && /^[0-9a-f]{64}$/.test(row.fileSha256)
      && row.state === ADMISSION_STATE[row.kind]
      && (row.kind !== 'bindings' || row.verifiedClean === true),
      'SANDBOX_CONFIG', 'Malformed accepted historical row');
    check(!seen.has(row.kind + ':' + row.id), 'SANDBOX_CONFIG', 'Duplicate accepted historical row');
    seen.add(row.kind + ':' + row.id);
    return row.kind === 'bindings'
      ? { kind: row.kind, id: row.id, state: row.state, verifiedClean: true, fileSha256: row.fileSha256 }
      : { kind: row.kind, id: row.id, state: row.state, fileSha256: row.fileSha256 };
  });
  return { decisionId: value.decisionId, accepted };
}
function historicalRows(unresolved, accepted) {
  check(unresolved.length === accepted.length, 'SANDBOX_PREFLIGHT', 'Historical admission decision does not cover exactly the unresolved ledger rows');
  const used = new Set();
  for (const row of unresolved) {
    check(row && typeof row === 'object' && !Array.isArray(row) && Object.hasOwn(ADMISSION_STATE, row.kind) && uuid(row.identity)
      && typeof row.fileSha256 === 'string' && /^[0-9a-f]{64}$/.test(row.fileSha256)
      && row.state === ADMISSION_STATE[row.kind]
      && (row.kind !== 'bindings' || (row.verifiedClean === true && row.createUncertain === false)),
      'SANDBOX_PREFLIGHT', 'Unresolved ledger row is not a bounded historical unknown');
    const index = accepted.findIndex((row2, i) => !used.has(i) && row2.kind === row.kind && row2.id === row.identity
      && row2.state === row.state && row2.fileSha256 === row.fileSha256);
    check(index >= 0, 'SANDBOX_PREFLIGHT', 'Historical admission decision does not match the unresolved ledger row');
    used.add(index);
  }
  return accepted.map(row => ({ kind: row.kind, id: row.id, state: row.state, fileSha256: row.fileSha256 }));
}
function preflightSource(t) {
  // Fixed metadata-only code: hash reviewed files BEFORE importing the physical guard. No keys, Bridge RPC or device opens.
  return `import os,sys,json,stat,hashlib,uuid,time
from pathlib import Path
r=Path(${JSON.stringify(t.remoteRoot)})
layout=${JSON.stringify(PREFLIGHT_LAYOUT)}
def read(p,limit):
 assert p.is_relative_to(r) and p.resolve()==p
 before=p.lstat()
 assert stat.S_ISREG(before.st_mode) and before.st_nlink==1 and before.st_size<=limit
 f=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|getattr(os,'O_NOATIME',0)|getattr(os,'O_NONBLOCK',0))
 try:
  same=lambda s:(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns)
  assert same(os.fstat(f))==same(before)
  b=b''
  while len(b)<=limit:
   chunk=os.read(f,min(1048576,limit+1-len(b)))
   if not chunk:break
   b+=chunk
  assert len(b)==before.st_size and len(b)<=limit and same(os.fstat(f))==same(before) and same(p.lstat())==same(before)
  return b
 finally:os.close(f)
code=${JSON.stringify(t.codeSha256)}
for n,h in code.items():assert hashlib.sha256(read(r/n,2097152)).hexdigest()==h
sys.path.insert(0,str(r/'remote-runtime'))
from target_config import load_target
t=load_target()
def pairs(items):
 d={}
 for k,v in items:
  assert k not in d
  d[k]=v
 return d
def directory(n):
 p=r/n
 assert p.is_dir() and not p.is_symlink() and p.resolve()==p
 return p
directory('state')
def marker(n,limit=65536):
 try:
  b=read(r/n,limit)
  return {'present':True,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
 except FileNotFoundError:return {'present':False,'bytes':0}
unresolved=[];live=set()
for kind in ['operations','bindings']:
 rows=list(directory(layout[kind]).iterdir());assert len(rows)<=4096
 for p in rows:
  assert p.suffix=='.json' and str(uuid.UUID(p.stem))==p.stem and not p.is_symlink()
  raw=read(p,33554432 if kind=='operations' else 65536)
  o=json.loads(raw,object_pairs_hook=pairs)
  assert isinstance(o,dict) and o.get('profile')==t.profile and o.get('targetIdentity')==t.identity
  identity='operationId' if kind=='operations' else 'bindingId'
  assert o.get(identity)==p.stem
  if kind=='operations':
   clear=o.get('state')!='unknown'
   started=o.get('startedAt')
   if o.get('action')=='acquire' and o.get('state')=='inProgress' and isinstance(started,(int,float)) and 0<=time.time()-started<=180:live.add(o.get('bindingId'))
  else:clear=(o.get('createUncertain') is False or p.stem in live) and not (o.get('state')=='released' and o.get('verifiedClean') is not True)
  if not clear:
   row={'kind':kind,'identity':p.stem,'state':o.get('state'),'fileSha256':hashlib.sha256(raw).hexdigest()}
   if kind=='bindings':row.update({'verifiedClean':o.get('verifiedClean') is True,'createUncertain':o.get('createUncertain') is True})
   unresolved.append(row)
print(json.dumps({'schemaVersion':1,'profile':t.profile,'remoteRoot':str(t.root),'catalogSha256':t.catalog_sha256,'targetIdentity':t.identity,'identityLabel':t.identity_label,'image':t.image,'devices':[{'render':'/dev/dri/renderD'+str(k),'bdf':v} for k,v in t.bdfs.items()],'codeSha256':code,'scanComplete':True,'layout':layout,'markers':{'stop':marker(layout['stop']),'admission':marker(layout['admission']),'nativePending':marker(layout['nativePending'])},'unresolved':unresolved},separators=(',',':')))
`;
}
export function createSandboxBackend({ ctx, readNode, commitBinding, configPath, requestsDir, decisionPath, configPaths, decisionPaths, clock = Date.now, transport } = {}) {
  check(typeof readNode === 'function' && typeof commitBinding === 'function', 'SANDBOX_CONFIG', 'Backend requires scoped reads and kernel binding CAS');
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  configPath ??= path.join(home, 'metainfer-research-lab', 'opensandbox.json');
  requestsDir ??= path.join(home, 'metainfer-research-lab', 'opensandbox-v2-requests');
  decisionPath ??= path.join(home, 'metainfer-research-lab', 'opensandbox-admission.json');
  // Transport config and historical decisions are per profile: separate files keep the 19
  // authority (and its admission decision) independent from the second site.
  const configFile = Object.freeze({ pclab19: configPath, pclab27: path.join(home, 'metainfer-research-lab', 'opensandbox-pclab27.json'), ...configPaths });
  const decisionFile = Object.freeze({ pclab19: decisionPath, pclab27: path.join(home, 'metainfer-research-lab', 'opensandbox-admission-pclab27.json'), ...decisionPaths });
  const call = transport ?? (async (name, args, options) => {
    const tool = ctx?.tools?.get(name); check(typeof tool?.execute === 'function', 'SANDBOX_TRANSPORT', 'Host SSH tool unavailable'); return tool.execute(args, options);
  });
  async function boundedFile(file, maximum) {
    const s = await lstat(file); check(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.size <= maximum, 'SANDBOX_CONFIG', 'Expected bounded regular configuration');
    const h = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { const b = await h.readFile(); check(b.length <= maximum, 'SANDBOX_CONFIG', 'Configuration grew beyond bound'); return b; } finally { await h.close(); }
  }
  async function configuration(t) { return validateTransportConfig(JSON.parse(await boundedFile(configFile[t.profile], 65536)), t); }
  async function admission(t) {
    let bytes;
    try { bytes = await boundedFile(decisionFile[t.profile], 65536); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
    let value; try { value = JSON.parse(bytes.toString('utf8')); }
    catch { sandboxFail('SANDBOX_CONFIG', 'Malformed historical admission decision'); }
    return admissionDecision(t, value);
  }
  async function preflight(profile, { signal } = {}) {
    const t = getSandboxTarget(profile); await configuration(t); check(!signal?.aborted, 'SANDBOX_CANCELLED', 'Cancelled before preflight');
    const decision = await admission(t);
    const value = envelope(await call('ssh_exec', { alias: t.sshAlias, command: `${quote(t.python)} -B -I -c ${quote(preflightSource(t))}`, timeoutMs: 30000 }, { signal }));
    check(!signal?.aborted && value?.schemaVersion === 1 && value.scanComplete === true
      && value.profile === t.profile && value.remoteRoot === t.remoteRoot && value.catalogSha256 === t.catalogSha256
      && value.targetIdentity === t.targetIdentity && value.identityLabel === t.identityLabel && value.image === t.image
      && equal(value.devices, t.devices) && equal(value.codeSha256, t.codeSha256) && equal(value.layout, PREFLIGHT_LAYOUT)
      && value.markers?.stop?.present === false && value.markers?.admission?.present === false
      && value.markers?.nativePending && (value.markers.nativePending.present === false || value.markers.nativePending.bytes === 0)
      && Array.isArray(value.unresolved),
      'SANDBOX_PREFLIGHT', 'Target identity/physical guard or STOP/Unknown/native pending blocks admission');
    let historicalAdmission = null;
    if (decision) historicalAdmission = { decisionId: decision.decisionId, accepted: historicalRows(value.unresolved, decision.accepted) };
    else check(value.unresolved.length === 0, 'SANDBOX_PREFLIGHT', 'Target identity/physical guard or STOP/Unknown/native pending blocks admission');
    return historicalAdmission ? { ...value, ready: true, historicalAdmission } : { ...value, ready: true };
  }
  function profile(node) { return node?.execution?.driver === 'dsh' && isSandboxProfile(node.execution.sandboxProfile) ? node.execution.sandboxProfile : null; }
  function checkOwner(n, cap, running) {
    check(n && n.id === cap.nodeId && n.projectId === cap.projectId && n.currentAttempt === cap.attempt
      && (n.attempt === undefined || n.attempt === n.currentAttempt) && n.sessionId === cap.sessionId
      && profile(n) === cap.profile && Number.isInteger(n.rev) && (!running || (n.status === 'running' && !n.sandbox?.cancelRequested))
      && path.resolve(n.git?.worktreePath ?? '') === cap.worktree.root && (n.sandbox?.bindingId ?? null) === cap.bindingId,
      'SANDBOX_SCOPE', 'Attempt/session/profile/worktree/revision owner changed');
    if (n.sandbox && !(cap.cleanPrior && n.sandbox.verifiedClean === true && !Object.values(n.sandbox.operations ?? {}).some(uncertain))) {
      const b = n.sandbox; check(b.backend === 'opensandbox' && b.profile === cap.profile && b.attempt === cap.attempt
        && b.sessionId === cap.sessionId && b.projectId === cap.projectId && b.nodeId === cap.nodeId
        && b.targetIdentity === cap.t.targetIdentity && b.worktreePath === cap.worktree.root && equal(b.worktreeIdentity, cap.worktree),
        'SANDBOX_SCOPE', 'Binding identity does not match the current owner');
    }
  }
  async function fresh(cap, running = true) {
    check(!running || !cap.signal?.aborted, 'SANDBOX_CANCELLED', 'Sandbox operation was cancelled');
    const n = clone(await readNode(cap.projectId, cap.nodeId)); checkOwner(n, cap, running); await assertWorktree(cap.worktree); return n;
  }
  async function capture(project, input, signal, running = true) {
    check(project?.id && input?.id && input.projectId === project.id, 'SANDBOX_SCOPE', 'Missing project/node identity');
    const n = clone(await readNode(project.id, input.id)), p = profile(n); check(p, 'SANDBOX_SCOPE', 'Node is not a 19 sandbox worker');
    check(Number.isInteger(n.currentAttempt) && n.currentAttempt > 0 && n.currentAttempt <= 1000000
      && typeof n.sessionId === 'string' && n.sessionId.length > 0 && n.currentAttempt === input.currentAttempt && n.sessionId === input.sessionId,
      'SANDBOX_SCOPE', 'Stale or missing attempt/session');
    const root = path.resolve(project.repo?.worktreeRoot ?? ''), tree = await worktreeIdentity(n.git?.worktreePath);
    const relative = path.relative(root, tree.root); check(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'SANDBOX_SCOPE', 'Worktree is outside the project root');
    const cap = { projectId: project.id, nodeId: n.id, attempt: n.currentAttempt, sessionId: n.sessionId, profile: p,
      t: getSandboxTarget(p), bindingId: n.sandbox?.bindingId ?? null, cleanPrior: true, worktree: tree, signal };
    checkOwner(n, cap, running); return { cap, node: n };
  }
  async function save(cap, source, binding, operationId, event, running = true) {
    const n = await fresh(cap, running); check(n.rev === source.rev, 'SANDBOX_CAS', 'Binding snapshot revision changed');
    await commitBinding({ expected: { projectId: cap.projectId, nodeId: cap.nodeId, attempt: cap.attempt, sessionId: cap.sessionId,
      profile: cap.profile, bindingId: cap.bindingId, nodeRev: n.rev, ...(operationId ? { operationId } : {}) }, binding: clone(binding), event });
    cap.bindingId = binding.bindingId; cap.cleanPrior = false; return fresh(cap, running);
  }
  async function unknown(cap, operationId, code) {
    try {
      const n = await fresh(cap, false), b = clone(n.sandbox), op = b.operations?.[operationId]; if (!op || op.state !== 'intent') return;
      b.operations[operationId] = { ...op, state: 'unknown', finishedAt: clock(), errorCode: /^[A-Z_]{1,64}$/.test(code ?? '') ? code : 'SANDBOX_UNKNOWN' };
      b.state = op.action === 'acquire' ? 'createUnknown' : op.action === 'release' ? 'cleanupPending' : 'unknown';
      await save(cap, n, b, operationId, 'node/sandbox_unknown', false);
    } catch { /* A late owner/CAS failure must leave the durable intent, never overwrite a newer attempt. */ }
  }
  async function requestFile(request) {
    const directory = path.resolve(requestsDir); await mkdir(directory, { recursive: true, mode: 0o700 });
    const s = await lstat(directory); check(s.isDirectory() && !s.isSymbolicLink() && path.resolve(await realpath(directory)).toLowerCase() === directory.toLowerCase(), 'SANDBOX_CONFIG', 'Request directory is redirected');
    if (process.platform !== 'win32') check((s.mode & 0o077) === 0, 'SANDBOX_CONFIG', 'Request directory is not private');
    const file = path.join(directory, request.operationId + '.json'), bytes = Buffer.from(canonicalJson(request));
    check(bytes.length <= 24 * 1024 ** 2, 'SANDBOX_INPUT', 'Bridge request exceeds internal byte bound');
    const h = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { await h.writeFile(bytes); await h.sync(); } finally { await h.close(); }
    if (process.platform !== 'win32') { const d = await open(directory, constants.O_RDONLY); try { await d.sync(); } finally { await d.close(); } }
    return { file, requestHash: sha256(bytes), byteLength: bytes.length };
  }
  function ownedOperation(op, cap) {
    return op && uuid(op.operationId) && /^[a-f0-9]{64}$/.test(op.requestHash) && Number.isSafeInteger(op.createdAt)
      && op.projectId === cap.projectId && op.nodeId === cap.nodeId && op.attempt === cap.attempt && op.sessionId === cap.sessionId
      && op.profile === cap.profile && op.bindingId === cap.bindingId && op.targetIdentity === cap.t.targetIdentity;
  }
  function noCapacityCreation(prior, cap) {
    const acquires = Object.values(prior.operations ?? {}).filter(op => op.action === 'acquire');
    return acquires.length === 1 && ownedOperation(acquires[0], cap) && acquires[0].state === 'completed' && acquires[0].result?.code === 'NO_CAPACITY'
      && Object.values(prior.operations).every(op => op === acquires[0] || (ownedOperation(op, cap) && op.action === 'release' && ['intent','completed'].includes(op.state)))
      && prior.providerId === null && prior.containerId === null && prior.renders?.length === 0 && prior.bdfs?.length === 0;
  }
  function bindingData(data, cap, prior, state) {
    check(data && data.profile === cap.profile && data.bindingId === cap.bindingId && data.projectId === cap.projectId
      && data.nodeId === cap.nodeId && data.attempt === cap.attempt && data.state === state
      && data.gpuCount === prior.gpuCount && typeof data.verifiedClean === 'boolean' && Array.isArray(data.renders) && Array.isArray(data.bdfs)
      && typeof data.managedId === 'string' && data.managedId.length > 0,
      'SANDBOX_REPLY', 'Bridge binding owner/state mismatch');
    const waiting = state === 'waiting', noCreation = state === 'released' && noCapacityCreation(prior, cap);
    if (waiting || noCreation) check(data.providerId === null && data.containerId === null && data.expiresAt === null
      && (waiting ? data.verifiedClean === false : data.verifiedClean === true), 'SANDBOX_REPLY', 'NoCapacity unexpectedly owns a provider/container');
    check(data.renders.length === (waiting || noCreation ? 0 : prior.gpuCount) && data.bdfs.length === data.renders.length && new Set(data.renders).size === data.renders.length
      && data.renders.every((render, i) => cap.t.devices.some(d => d.render === render && d.bdf === data.bdfs[i])), 'SANDBOX_REPLY', 'Protected/unknown/duplicate physical device mapping');
    if (!waiting && !noCreation) check(uuid(data.providerId) && /^[a-f0-9]{64}$/.test(data.containerId), 'SANDBOX_REPLY', 'Missing physical sandbox identity');
    if (prior.managedId) check(data.managedId === prior.managedId, 'SANDBOX_REPLY', 'Managed identity changed');
    if (prior.containerId) check(data.containerId === prior.containerId && data.providerId === prior.providerId
      && equal(data.renders, prior.renders) && equal(data.bdfs, prior.bdfs), 'SANDBOX_REPLY', 'Bound physical identity changed');
    if (state === 'ready') check(data.verifiedClean === false && Number.isSafeInteger(data.expiresAt) && data.expiresAt > clock() + 30000
      && data.expiresAt <= prior.localLeaseDeadline + 5000 && (!prior.expiresAt || data.expiresAt === prior.expiresAt), 'SANDBOX_LEASE', 'Lease changed, expired or was renewed');
    if (state === 'released') check(data.verifiedClean === true, 'SANDBOX_CLEANUP', 'Release lacks exact verified physical cleanup');
    return Object.fromEntries(allowedBindingFields.filter(k => Object.hasOwn(data, k)).map(k => [k, clone(data[k])]));
  }
  async function rpcInner(cap, action, fields, validate, { initial, running = true } = {}) {
    let n = await fresh(cap, running), b = initial ? clone(initial) : clone(n.sandbox);
    check(b && Object.keys(b.operations ?? {}).length < (action === 'release' ? 512 : 511), 'SANDBOX_UNKNOWN', 'Missing binding or bounded operation ledger is full');
    if (action !== 'release') check(!Object.values(b.operations ?? {}).some(uncertain), 'SANDBOX_UNKNOWN', 'Uncertain operation blocks replay/new effects');
    const operationId = randomUUID(), request = { profile: cap.profile, operationId, bindingId: b.bindingId, action, ...fields };
    const local = await requestFile(request);
    b.operations ??= {}; b.operations[operationId] = { operationId, action, state: 'intent', requestHash: local.requestHash,
      projectId: cap.projectId, nodeId: cap.nodeId, attempt: cap.attempt, sessionId: cap.sessionId, profile: cap.profile,
      bindingId: b.bindingId, targetIdentity: cap.t.targetIdentity, createdAt: clock() };
    if (action === 'release') b.state = 'cleanupPending';
    n = await save(cap, n, b, operationId, 'node/sandbox_intent', running); const revision = n.rev;
    async function guard() { const current = await fresh(cap, running); check(current.rev === revision && current.sandbox.operations[operationId]?.state === 'intent', 'SANDBOX_CAS', 'Operation owner/revision changed'); return current; }
    try {
      await configuration(cap.t); await guard();
      const uploaded = await call('ssh_upload', { alias: cap.t.sshAlias, localPath: local.file, remotePath: `${cap.t.remoteRoot}/requests/${operationId}.json` }, { signal: cap.signal });
      uploadAcknowledged(uploaded, local.byteLength);
      await guard(); const raw = await call('ssh_exec', { alias: cap.t.sshAlias,
        command: `${quote(cap.t.python)} -B ${quote(cap.t.remoteRoot + '/bridge.py')} --request-id ${quote(operationId)}`,
        timeoutMs: action === 'exec' ? fields.timeoutMs + 60000 : 120000 }, { signal: cap.signal });
      n = await guard(); const reply = envelope(raw); check(reply && typeof reply.ok === 'boolean', 'SANDBOX_REPLY', 'Invalid Bridge envelope');
      const validated = validate(reply, clone(n.sandbox)); b = clone(n.sandbox);
      if (validated.binding) Object.assign(b, validated.binding);
      if (action === 'release' && b.state === 'released' && b.verifiedClean === true) b.cancelRequested = false;
      b.operations[operationId] = { ...b.operations[operationId], state: 'completed', finishedAt: clock(), result: validated.summary ?? { ok: true } };
      await save(cap, n, b, operationId, 'node/sandbox_completed', running); return validated.value;
    } catch (error) { await unknown(cap, operationId, error.code); throw error; }
  }
  // One binding has exactly one writer. A status heartbeat overlapping the worker's first
  // exec used to surface as SANDBOX_UNKNOWN (an in-flight intent was treated as uncertainty) and
  // the worker correctly abandoned the run; serialize every operation per binding instead.
  const lanes = new Map();
  function rpc(cap, action, fields, validate, options) {
    // Release is a fresh, independent operation: the remote Bridge kills a long command and
    // verifies physical absence, so it must not queue behind an in-flight exec lane. The node
    // ledger CAS in save() still fences any late exec completion.
    if (action === 'release') return rpcInner(cap, action, fields, validate, options);
    const previous = lanes.get(cap.bindingId) ?? Promise.resolve();
    const next = previous.then(() => rpcInner(cap, action, fields, validate, options));
    lanes.set(cap.bindingId, next.then(() => {}, () => {}));
    return next;
  }
  function lease(b) { check(b?.state === 'ready' && b.verifiedClean === false && Number.isSafeInteger(b.expiresAt) && Math.min(b.expiresAt, b.localLeaseDeadline) - clock() > 30000,
    'SANDBOX_LEASE', 'No live fixed-TTL sandbox lease'); }
  function ok(reply) { check(reply.ok === true, 'SANDBOX_REMOTE', 'Bridge did not report a verified result'); return reply.data; }
  async function releaseCap(cap) {
    let n = await fresh(cap, false); if (!n.sandbox) return { binding: null, verifiedClean: false };
    if (n.sandbox.state === 'released' && n.sandbox.verifiedClean === true && n.sandbox.cancelRequested !== true) return { binding: clone(n.sandbox), verifiedClean: true };
    // Cancellation can abandon an in-flight result, not erase it. Release is a different fresh operation.
    for (const [id, op] of Object.entries(n.sandbox.operations ?? {})) if (op.state === 'intent') { await unknown(cap, id, 'SANDBOX_CANCELLED'); n = await fresh(cap, false); }
    await rpc(cap, 'release', {}, (reply, prior) => ({ binding: bindingData(ok(reply), cap, prior, 'released'), value: true }), { running: false });
    n = await fresh(cap, false); return { binding: clone(n.sandbox), verifiedClean: n.sandbox.verifiedClean === true };
  }
  async function prepare(project, input, { signal } = {}) {
    const { cap, node: n } = await capture(project, input, signal);
    if (n.sandbox) {
      check(n.sandbox.verifiedClean === true && !Object.values(n.sandbox.operations ?? {}).some(uncertain), 'SANDBOX_UNKNOWN', 'Existing binding must be reconciled/released before prepare');
    }
    const gpuCount = n.needs?.gpu ?? 0, machines = n.needs?.machines ?? 1, timebox = n.timeboxMs ?? project.config?.nodeTimeoutMinutes * 60000;
    check(Number.isInteger(gpuCount) && gpuCount >= 0 && gpuCount <= 4 && machines === 1
      && Number.isInteger(timebox) && timebox > 0 && timebox + 120000 <= 7200000, 'SANDBOX_INPUT', 'Unsupported demand or fixed lease budget');
    const files = await readWorktreeFiles(cap.worktree.root, { guard: () => fresh(cap) }); await preflight(cap.profile, { signal }); await fresh(cap);
    const binding = { backend: 'opensandbox', bindingId: randomUUID(), projectId: cap.projectId, nodeId: cap.nodeId,
      attempt: cap.attempt, sessionId: cap.sessionId, profile: cap.profile, targetIdentity: cap.t.targetIdentity,
      worktreePath: cap.worktree.root, worktreeIdentity: cap.worktree, state: 'creating', verifiedClean: false, gpuCount,
      sourceFiles: files.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
      leaseSeconds: Math.ceil(timebox / 1000) + 120, localLeaseDeadline: clock() + Math.ceil(timebox / 1000) * 1000 + 120000, operations: {} };
    const acquired = await rpc(cap, 'acquire', { projectId: cap.projectId, nodeId: cap.nodeId, attempt: cap.attempt, gpuCount, leaseSeconds: binding.leaseSeconds }, (reply, prior) => {
      if (reply.ok === false && reply.error?.code === 'NO_CAPACITY') return { binding: bindingData(reply.data, cap, prior, 'waiting'), value: 'waiting', summary: { code: 'NO_CAPACITY' } };
      return { binding: bindingData(ok(reply), cap, prior, 'ready'), value: 'ready' };
    }, { initial: binding });
    if (acquired === 'waiting') { const result = await releaseCap(cap); return { status: 'queued', binding: result.binding, prompt: null }; }
    for (const f of files) await rpc(cap, 'write', { path: f.path, contentBase64: f.contentBase64, mode: 644 }, reply => {
      const d = ok(reply); check(d?.path === f.path && d.size === f.size && d.sha256 === f.sha256, 'SANDBOX_FILES', 'Staged file verification failed'); return { value: d };
    });
    const current = await fresh(cap); lease(current.sandbox);
    return { status: 'ready', binding: clone(current.sandbox), prompt: 'Computation is remote in your bound sandbox. Use metainfer_sandbox with operation exec/read/write only. The cwd is /workspace/project. No Host shell/files/SSH/target/binding selection. Nonzero exit or truncated output is NOT success. Report exact exitCode and evidence; unknown operations must never be retried.' };
  }
  async function execute(project, input, args, { signal } = {}) {
    check(args && Buffer.byteLength(JSON.stringify(args)) <= FILE_LIMITS.tool, 'SANDBOX_INPUT', 'Oversized tool arguments');
    const { cap, node: n } = await capture(project, input, signal); cap.cleanPrior = false; lease(n.sandbox);
    check(['exec','read','write'].includes(args.action), 'SANDBOX_INPUT', 'Unsupported worker operation');
    let fields, validate;
    if (args.action === 'exec') {
      exact(args, ['action','command','timeoutMs']); const maximum = Math.min(600000, Math.floor(Math.min(n.sandbox.expiresAt, n.sandbox.localLeaseDeadline) - clock() - 30000));
      const timeoutMs = args.timeoutMs ?? maximum;
      check(typeof args.command === 'string' && Buffer.byteLength(args.command) > 0 && Buffer.byteLength(args.command) <= 128 * 1024
        && Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= maximum, 'SANDBOX_INPUT', 'Command/timeout exceeds fixed lease bounds');
      fields = { command: args.command, timeoutMs, cwd: '/workspace/project' };
      validate = reply => { const d = ok(reply); check(d && Number.isInteger(d.exitCode) && d.exitCode >= 0 && d.exitCode <= 255 && typeof d.success === 'boolean'
        && (uuid(d.commandId) || /^[a-f0-9]{32}$/.test(d.commandId)) && Number.isInteger(d.durationMs) && d.durationMs >= 0
        && typeof d.truncated === 'boolean' && typeof d.stdout === 'string' && typeof d.stderr === 'string'
        && Buffer.byteLength(d.stdout) + Buffer.byteLength(d.stderr) <= FILE_LIMITS.log, 'SANDBOX_REPLY', 'Missing explicit bounded command termination');
        const value = { ...d, success: d.success && d.exitCode === 0 && d.truncated === false }; return { value, summary: { exitCode: value.exitCode, success: value.success, truncated: value.truncated } }; };
    } else if (args.action === 'read') {
      exact(args, ['action','path','maxBytes']); const relative = validateRelativePath(args.path), maxBytes = args.maxBytes ?? FILE_LIMITS.read;
      check(Number.isInteger(maxBytes) && maxBytes > 0 && maxBytes <= FILE_LIMITS.read, 'SANDBOX_INPUT', 'Read exceeds 1 MiB'); fields = { path: relative, maxBytes };
      validate = reply => { const d = ok(reply); check(d?.path === relative, 'SANDBOX_FILES', 'Read path mismatch'); validateFileManifest({ files: [d], totalBytes: d.size, truncated: false }, { maxBytes }); return { value: d, summary: { path: d.path, size: d.size, sha256: d.sha256 } }; };
    } else {
      exact(args, ['action','path','contentBase64']); const relative = validateRelativePath(args.path);
      check(typeof args.contentBase64 === 'string', 'SANDBOX_INPUT', 'Write requires canonical base64');
      const content = Buffer.from(args.contentBase64, 'base64'), expected = { path: relative, size: content.length, sha256: sha256(content) };
      validateFileManifest({ files: [{ ...expected, contentBase64: args.contentBase64 }], totalBytes: content.length, truncated: false });
      fields = { path: relative, contentBase64: args.contentBase64, mode: 644 };
      validate = reply => { const d = ok(reply); check(equal(d, expected), 'SANDBOX_FILES', 'Write verification mismatch'); return { value: d, summary: d }; };
    }
    return rpc(cap, args.action, fields, validate);
  }
  async function collect(project, input, { signal } = {}) {
    const { cap, node: n } = await capture(project, input, signal); cap.cleanPrior = false; lease(n.sandbox);
    // Collection is intentionally additive. Reject unsupported deletions before
    // restoring a Host tree that would silently disagree with the container.
    const sourceFiles = n.sandbox.sourceFiles, paths = new Set(), prefixes = new Map(); let sourceBytes = 0;
    try {
      check(Array.isArray(sourceFiles) && sourceFiles.length <= FILE_LIMITS.count, 'SANDBOX_SOURCE_MANIFEST', 'Missing bounded source manifest');
      for (const file of sourceFiles) {
        exact(file, ['path','size','sha256']);
        check(validateRelativePath(file.path) === file.path && !paths.has(file.path.toLowerCase())
          && Number.isSafeInteger(file.size) && file.size >= 0 && typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/.test(file.sha256), 'SANDBOX_SOURCE_MANIFEST', 'Invalid source file metadata');
        const parts = file.path.split('/');
        for (let i = 1; i <= parts.length; i++) {
          const prefix = parts.slice(0, i).join('/'), key = prefix.toLowerCase();
          check(!prefixes.has(key) || prefixes.get(key) === prefix, 'SANDBOX_SOURCE_MANIFEST', 'Case-colliding source parents');
          prefixes.set(key, prefix);
        }
        paths.add(file.path.toLowerCase()); sourceBytes += file.size;
      }
      for (const file of sourceFiles) for (const parent of file.path.split('/').slice(0, -1).map((_, i) => file.path.split('/').slice(0, i + 1).join('/').toLowerCase())) {
        check(!paths.has(parent), 'SANDBOX_SOURCE_MANIFEST', 'Source file/directory collision');
      }
      check(sourceBytes <= FILE_LIMITS.total, 'SANDBOX_SOURCE_MANIFEST', 'Source manifest exceeds limit');
    } catch (error) {
      if (error.code === 'SANDBOX_SOURCE_MANIFEST') throw error;
      throw Object.assign(new Error('Invalid original source manifest'), { code: 'SANDBOX_SOURCE_MANIFEST' });
    }
    const payload = await rpc(cap, 'collect', { maxBytes: FILE_LIMITS.total }, reply => { const data = ok(reply); validateFileManifest(data); return { value: data, summary: { count: data.files.length, totalBytes: data.totalBytes } }; });
    const returned = new Set(payload.files.map(file => file.path));
    check(sourceFiles.every(file => returned.has(file.path)), 'SANDBOX_COLLECTION_DELETE_UNSUPPORTED', 'Deleting original source files is not supported; no Host files restored');
    return restoreWorktreeFiles(cap.worktree.root, payload, { guard: () => fresh(cap) });
  }
  async function release(project, input) { const { cap } = await capture(project, input, undefined, false); cap.cleanPrior = false; return releaseCap(cap); }
  async function heartbeat(project, input) {
    const { cap } = await capture(project, input); cap.cleanPrior = false;
    const n = await fresh(cap), entries = Object.entries(n.sandbox?.operations ?? {}), ops = entries.map(([, op]) => op);
    check(ops.every(op => ['completed','intent'].includes(op.state)), 'SANDBOX_UNKNOWN', 'Unknown operation blocks heartbeat');
    lease(n.sandbox);
    const intents = entries.filter(([, op]) => op.state === 'intent');
    if (intents.length) {
      check(intents.length === 1 && intents[0][0] === intents[0][1].operationId && ownedOperation(intents[0][1], cap) && ['exec','read','write','collect','status'].includes(intents[0][1].action),
        'SANDBOX_UNKNOWN', 'Malformed or foreign durable intent');
      return { skipped: true, reason: 'operation_in_progress' };
    }
    return rpc(cap, 'status', {}, (reply, prior) => { const d = ok(reply); check(d?.live === true, 'SANDBOX_REPLY', 'Sandbox is not live');
      return { binding: bindingData(d.binding, cap, prior, 'ready'), value: { binding: d.binding, live: true } }; });
  }
  return { isSandbox: node => Boolean(profile(node)), target: getSandboxTarget, preflight, prepare, execute, collect, release, heartbeat };
}
