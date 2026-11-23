import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSandboxBackend } from '../../host/sandbox-backend.js';
import { fixture, sha } from './fakes.mjs';
// The actual Python source is executed; only fixed ROOT relocation and hardware/code identities are test mocks.
const python=process.env.DSH_TEST_PYTHON??(process.platform==='win32'?path.resolve(path.dirname(process.execPath),'../../python/python.exe'):'python3');
const helper=fileURLToPath(new URL('./preflight-fixture.py',import.meta.url));
async function run(fn){const f=await fixture();try{
  const root=path.join(f.temp,'remote');await mkdir(root);
  for(const n of ['operations','bindings','state','adapter'])await mkdir(path.join(root,n));
  for(const n of Object.keys(f.t.codeSha256)){const p=path.join(root,n);await mkdir(path.dirname(p),{recursive:true});await writeFile(p,'FIXTURE_METADATA:'+n);}
  const put=async(n,v)=>writeFile(path.join(root,n),typeof v==='string'?v:JSON.stringify(v));
  const base={profile:f.t.profile,targetIdentity:f.t.targetIdentity},id='11111111-1111-1111-1111-111111111111';
  await put('operations/'+id+'.json',{...base,operationId:id,bindingId:id,action:'release',state:'completed'});
  await put('bindings/'+id+'.json',{...base,bindingId:id,state:'released',verifiedClean:true,createUncertain:false});
  const transport=async(name,args)=>{assert.equal(name,'ssh_exec');const out=spawnSync(python,['-I','-B',helper],{input:JSON.stringify({root,target:f.t,command:args.command}),encoding:'utf8',timeout:10000,maxBuffer:1024*1024});if(out.error)throw out.error;f.lastPython=out;return {success:out.status===0,exitCode:out.status,timedOut:false,stdout:out.stdout,stderr:out.stderr,durationMs:0};};
  const b=createSandboxBackend({readNode:f.readNode,commitBinding:f.commitBinding,configPath:f.configPath,requestsDir:f.requestsDir,decisionPath:path.join(f.temp,'admission.json'),clock:()=>f.now,transport});
  await fn({f,b,root,put,base,id});
}finally{await f.cleanup();}}
test('actual generated Python accepts the real ROOT layout (physical guard explicitly mocked)',()=>run(async({b,f})=>{try{assert.equal((await b.preflight('pclab19')).ready,true);}catch(e){e.message+='; actual generated Python: '+f.lastPython?.stderr;throw e;}}));
for(const [label,file,value] of [
 ['STOP','state/STOP','stop'],['admission','admission-blocked.json','blocked'],['native pending','adapter/dcu-allocation.lock','pending'],
 ['operation Unknown','operations/11111111-1111-1111-1111-111111111111.json',{state:'unknown'}],
 ['binding uncertain','bindings/11111111-1111-1111-1111-111111111111.json',{state:'createUnknown',createUncertain:true}],
])test('real layout cannot hide '+label+' behind a phantom empty state/operations',()=>run(async({b,root,put,base,id})=>{
 await mkdir(path.join(root,'state/operations'));await put(file,typeof value==='string'?value:{...base,operationId:id,bindingId:id,...value});
 await assert.rejects(()=>b.preflight('pclab19'));
}));
test('preflight rejects malformed/foreign/completed-false and symlink ledger metadata',()=>run(async({b,root,put,base,id})=>{
 await mkdir(path.join(root,'state/operations'));
 for(const value of ['{broken',JSON.stringify({...base,operationId:id,bindingId:id,state:'completed',targetIdentity:'f'.repeat(64)}),'{"state":"unknown","state":"completed"}']){await put('operations/'+id+'.json',value);await assert.rejects(()=>b.preflight('pclab19'));}
 await rm(path.join(root,'operations/'+id+'.json'));await symlink(path.join(root,'state'),path.join(root,'operations/link.json'),'junction');await assert.rejects(()=>b.preflight('pclab19'));
}));
test('preflight code metadata hash drift is rejected without loading a physical guard',()=>run(async({b,put})=>{await put('bridge.py','wrong fixture bytes');await assert.rejects(()=>b.preflight('pclab19'));}));
test('actual generated Python reports the pinned unknown hash and admits exactly it',()=>run(async({f,b,put,base,id})=>{
 const raw=JSON.stringify({...base,operationId:id,bindingId:id,action:'exec',state:'unknown'});
 await put('operations/'+id+'.json',raw);
 await writeFile(path.join(f.temp,'admission.json'),JSON.stringify({schemaVersion:1,kind:'historical-admission-decision',decisionId:'0f0e0d0c-0b0a-4908-8706-050403020100',profile:f.t.profile,targetIdentity:f.t.targetIdentity,catalogSha256:f.t.catalogSha256,decidedAt:1794767315000,accepted:[{kind:'operations',id,state:'unknown',fileSha256:sha(Buffer.from(raw))}]}));
 const value=await b.preflight('pclab19');
 assert.equal(value.ready,true);
 assert.deepEqual(value.historicalAdmission.accepted,[{kind:'operations',id,state:'unknown',fileSha256:sha(Buffer.from(raw))}]);
}));
