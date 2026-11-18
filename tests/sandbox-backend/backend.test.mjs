import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { createSandboxBackend } from '../../host/sandbox-backend.js';
import { fixture, clone, entry, bundle } from './fakes.mjs';
const backend=f=>createSandboxBackend({ctx:{},readNode:f.readNode,commitBinding:f.commitBinding,configPath:f.configPath,requestsDir:f.requestsDir,decisionPath:f.decisionPath,clock:()=>f.now,transport:f.transport});
const run=async(fn)=>{const f=await fixture();try{await fn(f,backend(f));}finally{await f.cleanup();}};
test('preflight is fixed read-only metadata; STOP/Unknown/native pending fail closed',()=>run(async(f,b)=>{
  assert.equal((await b.preflight('pclab19')).ready,true);
  assert.ok(f.calls[0].args.command.includes('load_target'));
  assert.ok(!f.calls[0].args.command.includes('--request-id'));
  for(const change of [()=>f.probe.markers.stop={present:true},()=>f.probe.unresolved=[{state:'unknown'}],()=>f.probe.markers.nativePending={present:true,bytes:36},()=>f.probe.catalogSha256='f'.repeat(64)]){
    f.probe=(await import('./fakes.mjs')).probe(f.t);change();await assert.rejects(()=>b.prepare(f.project,f.node));assert.equal(f.uploads.size,0);
  }
}));
test('prepare persists fresh rev/identity/hash before fake SSH, stages files and preserves input',()=>run(async(f,b)=>{
  const input=clone(f.node),before=clone(input),r=await b.prepare(f.project,input);
  assert.equal(r.status,'ready');assert.deepEqual(input,before);assert.equal(r.binding.backend,'opensandbox');
  assert.equal(r.binding.leaseSeconds,180);assert.equal(f.files.get('README.md').sha256,(await import('./fakes.mjs')).sha('hello'));
  assert.ok(f.commits.every(c=>Number.isInteger(c.expected.nodeRev)));
  assert.ok(Object.values(f.node.sandbox.operations).every(o=>o.state==='completed'&&/^[a-f0-9]{64}$/.test(o.requestHash)));
  const ids=await readdir(f.requestsDir);assert.equal(new Set(ids).size,ids.length);
}));
test('CPU empty renders and exact protected-device rejection',()=>run(async(f,b)=>{
  f.node.needs.gpu=0;const r=await b.prepare(f.project,f.node);assert.deepEqual(r.binding.renders,[]);
  await b.release(f.project,f.node);f.node.sandbox=null;f.node.rev++;f.node.needs.gpu=1;
  f.onRequest=async r=>{const v=await f.reply(r);if(r.action==='acquire')v.data.renders=['/dev/dri/renderD128'];return v;};
  await assert.rejects(()=>b.prepare(f.project,f.node));assert.equal(Object.values(f.node.sandbox.operations).at(-1).state,'unknown');
}));
test('durable commit failure means no upload or Bridge invocation',()=>run(async(f,b)=>{
  f.onCommit=async()=>{throw Error('durability failed');};await assert.rejects(()=>b.prepare(f.project,f.node));assert.equal(f.uploads.size,0);
}));
test('NO_CAPACITY queues only after same-binding verified physical release',()=>run(async(f,b)=>{
  f.onRequest=async r=>{if(r.action==='acquire'){const v=await f.reply(r);Object.assign(v.data,{state:'waiting',providerId:null,containerId:null,expiresAt:null,renders:[],bdfs:[]});f.remote.set(r.bindingId,clone(v.data));return {ok:false,error:{code:'NO_CAPACITY'},data:v.data};}return f.reply(r);};
  const r=await b.prepare(f.project,f.node);assert.equal(r.status,'queued');assert.equal(r.binding.verifiedClean,true);
  assert.deepEqual([...f.uploads.values()].map(r=>r.action),['acquire','release']);
}));
test('ambiguous transport/result cannot replay acquire or exec',()=>run(async(f,b)=>{
  f.onRequest=async()=>({rawTool:{exitCode:0,stdout:'{"ok":true}',stderr:'',truncated:true}});
  await assert.rejects(()=>b.prepare(f.project,f.node));const n=f.uploads.size;
  await assert.rejects(()=>b.prepare(f.project,f.node));assert.equal(f.uploads.size,n);
  assert.ok(Object.values(f.node.sandbox.operations).some(o=>o.state==='unknown'));
}));
test('cancel after upload prevents Bridge exec; late acquire cannot revive cancelled node',()=>run(async(f,b)=>{
  f.onUpload=async r=>{if(r.action==='acquire'){f.node.status='cancelled';f.node.rev++;}};
  await assert.rejects(()=>b.prepare(f.project,f.node));assert.equal(f.calls.filter(c=>c.name==='ssh_exec'&&c.args.command.includes('--request-id')).length,0);
}));
test('stale attempt/session and nodeRev CAS prevent old result overwrite',()=>run(async(f,b)=>{
  f.onRequest=async r=>{const v=await f.reply(r);f.node.currentAttempt=2;f.node.sessionId='session-new';f.node.rev++;return v;};
  await assert.rejects(()=>b.prepare(f.project,f.node));assert.equal(f.node.currentAttempt,2);assert.notEqual(f.node.sandbox.state,'ready');
}));
test('exec requires exact integer exit and truncation is never success; cwd/target are not worker inputs',()=>run(async(f,b)=>{
  await b.prepare(f.project,f.node);
  await assert.rejects(()=>b.execute(f.project,f.node,{action:'exec',command:'echo x',cwd:'/'}));
  await assert.rejects(()=>b.execute(f.project,f.node,{action:'exec',command:'x',profile:'pclab27'}));
  f.onRequest=async r=>{const v=await f.reply(r);if(r.action==='exec')v.data.truncated=true;return v;};
  const r=await b.execute(f.project,f.node,{action:'exec',command:'printf x',timeoutMs:1000});assert.equal(r.success,false);
  f.onRequest=async r=>{const v=await f.reply(r);if(r.action==='exec')v.data.exitCode=false;return v;};
  await assert.rejects(()=>b.execute(f.project,f.node,{action:'exec',command:'x',timeoutMs:1000}));
}));
test('release preserves old execUnknown and incomplete cleanup never frees',()=>run(async(f,b)=>{
  await b.prepare(f.project,f.node);f.onRequest=async r=>r.action==='exec'?{rawTool:{exitCode:1,stdout:'',stderr:'network lost'}}:f.reply(r);
  await assert.rejects(()=>b.execute(f.project,f.node,{action:'exec',command:'x',timeoutMs:1000}));
  const [id,old]=Object.entries(f.node.sandbox.operations).find(([,o])=>o.state==='unknown');
  await b.release(f.project,f.node);assert.equal(f.node.sandbox.verifiedClean,true);assert.deepEqual(f.node.sandbox.operations[id],old);
}));
test('heartbeat never renews TTL; lease guard and scope cannot drift',()=>run(async(f,b)=>{
  await b.prepare(f.project,f.node);const deadline=f.node.sandbox.expiresAt;await b.heartbeat(f.project,f.node);assert.equal(f.node.sandbox.expiresAt,deadline);
  f.now=deadline-30000;await assert.rejects(()=>b.execute(f.project,f.node,{action:'exec',command:'x',timeoutMs:1000}));
  f.node.git.worktreePath=f.temp;await assert.rejects(()=>b.collect(f.project,f.node));
}));
test('collect validates data before restoring exact worktree and returns bounded summaries',()=>run(async(f,b)=>{
  await b.prepare(f.project,f.node);f.files.set('result.bin',entry('result.bin',Buffer.from([0,255])));
  const r=await b.collect(f.project,f.node);assert.deepEqual(await readFile(f.worktree+'/result.bin'),Buffer.from([0,255]));assert.ok(r.files.every(e=>!('contentBase64'in e)));
  f.files.set('bad',entry('.git/config','x'));await assert.rejects(()=>b.collect(f.project,f.node));
}));
