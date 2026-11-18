import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createSandboxBackend } from '../../host/sandbox-backend.js';
import { fixture, clone } from './fakes.mjs';
const make=(f,transport=f.transport)=>createSandboxBackend({readNode:f.readNode,commitBinding:f.commitBinding,configPath:f.configPath,requestsDir:f.requestsDir,decisionPath:f.decisionPath,clock:()=>f.now,transport});
const run=async fn=>{const f=await fixture();try{await fn(f,make(f));}finally{await f.cleanup();}};
test('explicit Native success false is never promoted even with exit zero and no truncation',()=>run(async(f,b)=>{
 await b.prepare(f.project,f.node);f.onRequest=async r=>{const v=await f.reply(r);if(r.action==='exec')v.data.success=false;return v;};
 const result=await b.execute(f.project,f.node,{action:'exec',command:'x',timeoutMs:1000});assert.equal(result.success,false);
}));
test('nonzero and truncated command output cannot inherit a Native success true',()=>run(async(f,b)=>{
 await b.prepare(f.project,f.node);for(const patch of [{exitCode:7},{truncated:true}]){f.onRequest=async r=>{const v=await f.reply(r);if(r.action==='exec')Object.assign(v.data,patch,{success:true});return v;};assert.equal((await b.execute(f.project,f.node,{action:'exec',command:'x',timeoutMs:1000})).success,false);}
}));
test('truncated upload acknowledgement cannot invoke Bridge',()=>run(async(f)=>{
 const transport=async(n,a,o)=>{const v=await f.transport(n,a,o);return n==='ssh_upload'?{...v,truncated:true}:v;};
 await assert.rejects(()=>make(f,transport).prepare(f.project,f.node));assert.equal(f.calls.filter(c=>c.args.command?.includes('--request-id')).length,0);
}));
test('heartbeat refuses malformed intent identifiers/hash/foreign scope instead of skipping',()=>run(async(f,b)=>{
 await b.prepare(f.project,f.node);const template=clone(Object.values(f.node.sandbox.operations)[0]);
 for(const patch of [{operationId:randomUUID()},{requestHash:'bad'},{sessionId:'foreign'},{targetIdentity:'f'.repeat(64)}]){const id=randomUUID();f.node.sandbox.operations[id]={...template,operationId:id,action:'exec',state:'intent',...patch};await assert.rejects(()=>b.heartbeat(f.project,f.node),e=>e.code==='SANDBOX_UNKNOWN');delete f.node.sandbox.operations[id];}
}));
for(const [label,raw] of Object.entries({booleanExit:{exitCode:false,stdout:'{}'},missingExit:{stdout:'{}'},nonzeroExit:{exitCode:1,stdout:'{}'},truncated:{exitCode:0,stdout:'{}',truncated:true},mixed:{content:[{type:'text',text:'{}'},{type:'text',text:'{}'}]},toolError:{isError:true,exitCode:0,stdout:'{}'},explicitFailure:{success:false,exitCode:0,stdout:'{}'},timedOut:{timedOut:true,exitCode:0,stdout:'{}'}}))test('tool envelope '+label+' leaves the exec result unknown',()=>run(async(f,b)=>{
 await b.prepare(f.project,f.node);f.onRequest=async()=>({rawTool:raw});await assert.rejects(()=>b.execute(f.project,f.node,{action:'exec',command:'x',timeoutMs:1000}));assert.ok(Object.values(f.node.sandbox.operations).some(o=>o.action==='exec'&&o.state==='unknown'));
}));
test('single text JSON transport envelope executes while mixed content fails closed',()=>run(async(f,b)=>{
 await b.prepare(f.project,f.node);f.onRequest=async r=>({rawTool:{content:[{type:'text',text:JSON.stringify({success:true,exitCode:0,timedOut:false,stdout:JSON.stringify(await f.reply(r)),stderr:'',durationMs:1})}]}});
 assert.equal((await b.execute(f.project,f.node,{action:'exec',command:'x',timeoutMs:1000})).success,true);
 f.onRequest=async()=>({rawTool:{content:[{type:'text',text:'{}'},{type:'text',text:'{}'}]}});await assert.rejects(()=>b.execute(f.project,f.node,{action:'exec',command:'x',timeoutMs:1000}));
}));
test('default ctx.tools path is used only with pinned alias and request arguments',()=>run(async(f)=>{
 const b=createSandboxBackend({ctx:{tools:new Map(['ssh_exec','ssh_upload'].map(n=>[n,{execute:(a,o)=>f.transport(n,a,o)}]))},readNode:f.readNode,commitBinding:f.commitBinding,configPath:f.configPath,requestsDir:f.requestsDir,decisionPath:f.decisionPath,clock:()=>f.now});
 assert.equal((await b.prepare(f.project,f.node)).status,'ready');assert.ok(f.calls.every(c=>c.args.alias==='pclab2'));
}));

for(const [label,change] of Object.entries({missing:()=>({}),falseAck:()=>({ok:false,error:'failed'}),unknown:()=>({status:'uploaded'}),wrongBytes:v=>({...v,transferredBytes:0}),wrongCount:v=>({...v,files:2}),mixed:v=>({content:[{type:'text',text:JSON.stringify(v)}],ok:true}),twoText:v=>({content:[{type:'text',text:JSON.stringify(v)},{type:'text',text:'{}'}]})}))test('upload '+label+' acknowledgement cannot run Bridge',()=>run(async f=>{
 const transport=async(n,a,o)=>{const v=await f.transport(n,a,o);return n==='ssh_upload'?change(v):v;};await assert.rejects(()=>make(f,transport).prepare(f.project,f.node));assert.equal(f.calls.filter(c=>c.args.command?.includes('--request-id')).length,0);
}));
test('official upload payload accepts unique text JSON with exact one-file byte acknowledgement',()=>run(async f=>{
 const transport=async(n,a,o)=>{const v=await f.transport(n,a,o);return n==='ssh_upload'?{content:[{type:'text',text:JSON.stringify(v)}]}:v;};assert.equal((await make(f,transport).prepare(f.project,f.node)).status,'ready');
}));
async function fillLedger(f,count){const template=clone(Object.values(f.node.sandbox.operations)[0]);while(Object.keys(f.node.sandbox.operations).length<count){const id=randomUUID();f.node.sandbox.operations[id]={...template,operationId:id,action:'status',state:'completed',result:{ok:true}};}}
test('non-release budget reserves the final 512th slot for exact physical cleanup',()=>run(async(f,b)=>{
 await b.prepare(f.project,f.node);await fillLedger(f,511);const calls=f.calls.length,rev=f.node.rev;await assert.rejects(()=>b.heartbeat(f.project,f.node),e=>e.code==='SANDBOX_UNKNOWN');assert.equal(f.calls.length,calls);assert.equal(f.node.rev,rev);
 assert.equal((await b.release(f.project,f.node)).verifiedClean,true);assert.equal(Object.keys(f.node.sandbox.operations).length,512);
}));
test('release Unknown exhausting the final slot stays held without dropping any history',()=>run(async(f,b)=>{
 await b.prepare(f.project,f.node);await fillLedger(f,511);f.onRequest=async()=>({rawTool:{exitCode:1,stdout:'',stderr:'lost release'}});await assert.rejects(()=>b.release(f.project,f.node));
 const before=JSON.stringify(f.node.sandbox.operations),calls=f.calls.length;await assert.rejects(()=>b.release(f.project,f.node));assert.equal(f.calls.length,calls);assert.equal(JSON.stringify(f.node.sandbox.operations),before);assert.notEqual(f.node.sandbox.verifiedClean,true);
}));

for(const patch of [{success:false},{timedOut:true}])test('official tool failure flags cannot be promoted by a valid exit-zero Bridge body '+JSON.stringify(patch),()=>run(async(f,b)=>{
 await b.prepare(f.project,f.node);f.onRequest=async r=>({rawTool:{success:true,exitCode:0,timedOut:false,stdout:JSON.stringify(await f.reply(r)),stderr:'',durationMs:1,...patch}});await assert.rejects(()=>b.execute(f.project,f.node,{action:'exec',command:'x',timeoutMs:1000}));
}));
