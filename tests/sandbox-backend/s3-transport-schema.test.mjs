import assert from 'node:assert/strict';
import test from 'node:test';
import { createSandboxBackend } from '../../host/sandbox-backend.js';
import { fixture } from './fakes.mjs';
const make=f=>createSandboxBackend({readNode:f.readNode,commitBinding:f.commitBinding,configPath:f.configPath,requestsDir:f.requestsDir,decisionPath:f.decisionPath,clock:()=>f.now,transport:f.transport});
const official=value=>({success:true,exitCode:0,timedOut:false,stdout:JSON.stringify(value),stderr:'',durationMs:1});
const changes={};
for(const key of ['success','exitCode','timedOut','stdout','stderr','durationMs'])changes['missing '+key]=v=>{delete v[key];return v;};
for(const [label,patch] of Object.entries({stringFailure:{success:'false'},stringSuccess:{success:'true'},nullSuccess:{success:null},stringTimeout:{timedOut:'true'},stringNoTimeout:{timedOut:'false'},nullTimeout:{timedOut:null},numberStderr:{stderr:123},nullStderr:{stderr:null},numberStdout:{stdout:123},negativeDuration:{durationMs:-1},fractionalDuration:{durationMs:0.5},stringDuration:{durationMs:'1'},unsafeDuration:{durationMs:Number.MAX_SAFE_INTEGER+1},nullDuration:{durationMs:null},booleanExit:{exitCode:false},stringExit:{exitCode:'0'},nullExit:{exitCode:null},nonzeroExit:{exitCode:1},unknownField:{unexpected:true},typedError:{error:123},errorMessage:{error:'connection lost'},explicitFailure:{success:false},timeout:{timedOut:true}}))changes[label]=v=>Object.assign(v,patch);
for(const [label,change] of Object.entries(changes))test('strict official SSH '+label+' cannot complete a valid Bridge exec',async()=>{
 const f=await fixture();try{
  const b=make(f);await b.prepare(f.project,f.node);let request;
  f.onRequest=async r=>{request=r;return {rawTool:change(official(await f.reply(r)))};};
  await assert.rejects(()=>b.execute(f.project,f.node,{action:'exec',command:'only mocked',timeoutMs:1000}),e=>e.code==='SANDBOX_TRANSPORT');
  assert.equal(f.node.sandbox.operations[request.operationId].state,'unknown');
  const calls=f.calls.length;await assert.rejects(()=>b.execute(f.project,f.node,{action:'exec',command:'never replay',timeoutMs:1000}));assert.equal(f.calls.length,calls);
 }finally{await f.cleanup();}
});
for(const wrapped of [false,true])test('complete official SSH schema succeeds '+(wrapped?'in unique text JSON':'directly'),async()=>{
 const f=await fixture();try{const b=make(f);await b.prepare(f.project,f.node);f.onRequest=async r=>{const v=official(await f.reply(r));v.error='';return {rawTool:wrapped?{content:[{type:'text',text:JSON.stringify(v)}]}:v};};assert.equal((await b.execute(f.project,f.node,{action:'exec',command:'mock',timeoutMs:1000})).success,true);}finally{await f.cleanup();}
});
test('typed official fields are also mandatory inside unique text JSON',async()=>{
 const f=await fixture();try{const b=make(f);await b.prepare(f.project,f.node);let id;f.onRequest=async r=>{id=r.operationId;const v=official(await f.reply(r));v.timedOut='false';return {rawTool:{content:[{type:'text',text:JSON.stringify(v)}]}};};await assert.rejects(()=>b.execute(f.project,f.node,{action:'exec',command:'mock',timeoutMs:1000}),e=>e.code==='SANDBOX_TRANSPORT');assert.equal(f.node.sandbox.operations[id].state,'unknown');}finally{await f.cleanup();}
});
