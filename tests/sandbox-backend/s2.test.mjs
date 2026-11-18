import assert from 'node:assert/strict';
import test from 'node:test';
import { rename, mkdir } from 'node:fs/promises';
import { createSandboxBackend } from '../../host/sandbox-backend.js';
import { fixture, clone } from './fakes.mjs';
const backend=f=>createSandboxBackend({readNode:f.readNode,commitBinding:f.commitBinding,configPath:f.configPath,requestsDir:f.requestsDir,decisionPath:f.decisionPath,clock:()=>f.now,transport:f.transport});
const run=async fn=>{const f=await fixture();try{await fn(f,backend(f));}finally{await f.cleanup();}};
const waiting=async(f,r)=>{const v=await f.reply(r);Object.assign(v.data,{state:'waiting',providerId:null,containerId:null,expiresAt:null,renders:[],bdfs:[]});f.remote.set(r.bindingId,clone(v.data));return {ok:false,error:{code:'NO_CAPACITY'},data:v.data};};
test('real Bridge wire accepts decimal 644, not JS octal 420, in staging and worker writes',()=>run(async(f,b)=>{
  f.onRequest=async r=>{if(r.action==='write')assert.equal(r.mode,644,'Bridge.validate accepts decimal 600/644 only');return f.reply(r);};
  await b.prepare(f.project,f.node);await b.execute(f.project,f.node,{action:'write',path:'out.txt',contentBase64:'eA=='});
}));
test('same-path worktree replacement is rejected across all existing-binding APIs before effects',()=>run(async(f,b)=>{
  await b.prepare(f.project,f.node);await rename(f.worktree,f.worktree+'.old');await mkdir(f.worktree);
  const calls=f.calls.length,rev=f.node.rev;
  for(const fn of [()=>b.execute(f.project,f.node,{action:'exec',command:'x'}),()=>b.collect(f.project,f.node),()=>b.heartbeat(f.project,f.node),()=>b.release(f.project,f.node)])await assert.rejects(fn,e=>e.code==='SANDBOX_SCOPE');
  assert.equal(f.calls.length,calls);assert.equal(f.node.rev,rev);
}));
test('NoCapacity waiting cannot smuggle provider/container; no release is attempted',()=>run(async(f,b)=>{
  f.onRequest=async r=>{const v=await waiting(f,r);v.data.providerId='11111111-1111-1111-1111-111111111111';return v;};
  await assert.rejects(()=>b.prepare(f.project,f.node));assert.deepEqual([...f.uploads.values()].map(r=>r.action),['acquire']);
}));
test('NoCapacity empty release must preserve exact managed identity',()=>run(async(f,b)=>{
  f.onRequest=async r=>{if(r.action==='acquire')return waiting(f,r);const v=await f.reply(r);v.data.managedId='foreign';return v;};
  await assert.rejects(()=>b.prepare(f.project,f.node));assert.notEqual(f.node.sandbox.verifiedClean,true);
}));
test('unknown acquire with empty provider is never given the completed NoCapacity exemption',()=>run(async(f,b)=>{
  f.onRequest=async r=>{if(r.action==='acquire'){await f.reply(r);return {rawTool:{exitCode:1,stdout:'',stderr:'lost'}};}const v=await f.reply(r);Object.assign(v.data,{providerId:null,containerId:null,renders:[],bdfs:[]});return v;};
  await assert.rejects(()=>b.prepare(f.project,f.node));const op=Object.values(f.node.sandbox.operations)[0];op.result={code:'NO_CAPACITY'};
  await assert.rejects(()=>b.release(f.project,f.node));assert.notEqual(f.node.sandbox.verifiedClean,true);assert.equal(op.state,'unknown');
}));
test('long exec heartbeat skips without live claim, RPC, revision or op-map writes; deadline remains fixed',()=>run(async(f,b)=>{
  await b.prepare(f.project,f.node);let started,finish;const seen=new Promise(r=>started=r),gate=new Promise(r=>finish=r);
  f.onRequest=async r=>{if(r.action==='exec'){started();await gate;}return f.reply(r);};
  const pending=b.execute(f.project,f.node,{action:'exec',command:'long',timeoutMs:1000});await seen;
  try{const rev=f.node.rev,ops=JSON.stringify(f.node.sandbox.operations),calls=f.calls.length,deadline=f.node.sandbox.expiresAt;
    assert.deepEqual(await b.heartbeat(f.project,f.node),{skipped:true,reason:'operation_in_progress'});
    assert.equal(f.node.rev,rev);assert.equal(JSON.stringify(f.node.sandbox.operations),ops);assert.equal(f.calls.length,calls);assert.equal(f.node.sandbox.expiresAt,deadline);
    f.now=deadline;await assert.rejects(()=>b.heartbeat(f.project,f.node));f.now=1800000000000;
  }finally{finish();await pending;}
}));
test('heartbeat unknown takes priority and cannot be disguised as an in-progress skip',()=>run(async(f,b)=>{
  await b.prepare(f.project,f.node);f.onRequest=async()=>({rawTool:{exitCode:1,stdout:'',stderr:'lost'}});
  await assert.rejects(()=>b.execute(f.project,f.node,{action:'exec',command:'x',timeoutMs:1000}));const rev=f.node.rev,calls=f.calls.length;
  await assert.rejects(()=>b.heartbeat(f.project,f.node),e=>e.code==='SANDBOX_UNKNOWN');assert.equal(f.node.rev,rev);assert.equal(f.calls.length,calls);
}));
test('verified same-identity release clears cancelRequested only, preserving unknown op bytes',()=>run(async(f,b)=>{
  await b.prepare(f.project,f.node);f.onRequest=async r=>r.action==='exec'?{rawTool:{exitCode:1,stdout:'',stderr:'lost'}}:f.reply(r);
  await assert.rejects(()=>b.execute(f.project,f.node,{action:'exec',command:'x',timeoutMs:1000}));
  const [id,op]=Object.entries(f.node.sandbox.operations).find(([,v])=>v.state==='unknown'),before=JSON.stringify(op);
  f.node.sandbox.cancelRequested=true;f.node.status='cancelled';f.node.rev++;
  const result=await b.release(f.project,f.node);assert.equal(result.verifiedClean,true);assert.equal(result.binding.cancelRequested,false);assert.equal(JSON.stringify(result.binding.operations[id]),before);
}));
test('failed release must not clear cancelRequested',()=>run(async(f,b)=>{
  await b.prepare(f.project,f.node);f.node.sandbox.cancelRequested=true;f.node.rev++;
  f.onRequest=async r=>{const v=await f.reply(r);if(r.action==='release')v.data.verifiedClean=false;return v;};
  await assert.rejects(()=>b.release(f.project,f.node));assert.equal(f.node.sandbox.cancelRequested,true);
}));
