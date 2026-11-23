import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSandboxBackend } from '../../host/sandbox-backend.js';
import { fixture } from './fakes.mjs';
// The actual generated Python is executed against a synthetic ROOT; only fixed identities and hardware are mocked.
const python=process.env.DSH_TEST_PYTHON??(process.platform==='win32'?path.resolve(path.dirname(process.execPath),'../../python/python.exe'):'python3');
const helper=fileURLToPath(new URL('./preflight-fixture.py',import.meta.url));

async function run(fn,setup){
  const f=await fixture();
  try{
    const root=path.join(f.temp,'remote');
    await mkdir(root,{recursive:true});
    for(const n of ['operations','bindings','state','adapter'])await mkdir(path.join(root,n));
    for(const n of Object.keys(f.t.codeSha256)){const p=path.join(root,n);await mkdir(path.dirname(p),{recursive:true});await writeFile(p,'FIXTURE_METADATA:'+n);}
    const put=async(n,v)=>writeFile(path.join(root,n),typeof v==='string'?v:JSON.stringify(v));
    const base={profile:f.t.profile,targetIdentity:f.t.targetIdentity};
    const id='11111111-1111-1111-1111-111111111111';
    await put('operations/'+id+'.json',{...base,operationId:id,bindingId:id,action:'release',state:'completed'});
    await put('bindings/'+id+'.json',{...base,bindingId:id,state:'released',verifiedClean:true,createUncertain:false});
    await setup?.({root,put,base,id});
    const transport=async(name,args)=>{assert.equal(name,'ssh_exec');const out=spawnSync(python,['-I','-B',helper],{input:JSON.stringify({root,target:f.t,command:args.command}),encoding:'utf8',timeout:10000,maxBuffer:1024*1024});if(out.error)throw out.error;f.lastPython=out;return {success:out.status===0,exitCode:out.status,timedOut:false,stdout:out.stdout,stderr:out.stderr,durationMs:0};};
    const b=createSandboxBackend({readNode:f.readNode,commitBinding:f.commitBinding,configPath:f.configPath,requestsDir:f.requestsDir,decisionPath:path.join(f.temp,'admission.json'),clock:()=>f.now,transport});
    await fn({f,b,root,put,base,id});
  }finally{await f.cleanup();}
}

test('another sandbox binding holding an in-flight operation does not block admission',()=>run(async({f,b})=>{
  try{assert.equal((await b.preflight('pclab19')).ready,true);}
  catch(e){e.message+='; actual generated Python: '+f.lastPython?.stderr;throw e;}
},async({put,base})=>{
  const other='22222222-2222-2222-2222-222222222222';
  await put('operations/'+other+'.json',{...base,operationId:other,bindingId:other,action:'exec',state:'intent'});
  await put('bindings/'+other+'.json',{...base,bindingId:other,state:'ready',verifiedClean:false,createUncertain:false,activeOperation:other});
}));

test('an unknown operation of another binding still blocks admission',()=>run(async({b})=>{
  await assert.rejects(()=>b.preflight('pclab19'));
},async({put,base})=>{
  const other='33333333-3333-3333-3333-333333333333';
  await put('operations/'+other+'.json',{...base,operationId:other,bindingId:other,action:'exec',state:'unknown'});
}));

test('a released-but-unverified binding still blocks admission',()=>run(async({b})=>{
  await assert.rejects(()=>b.preflight('pclab19'));
},async({put,base})=>{
  const other='44444444-4444-4444-4444-444444444444';
  await put('bindings/'+other+'.json',{...base,bindingId:other,state:'released',verifiedClean:false,createUncertain:false});
}));

test('a create-uncertain binding still blocks admission',()=>run(async({b})=>{
  await assert.rejects(()=>b.preflight('pclab19'));
},async({put,base})=>{
  const other='55555555-5555-5555-5555-555555555555';
  await put('bindings/'+other+'.json',{...base,bindingId:other,state:'createUnknown',createUncertain:true});
}));

test('a live acquire in progress is transient and does not dead-end admission',()=>run(async({f,b})=>{
  try{assert.equal((await b.preflight('pclab19')).ready,true);}
  catch(e){e.message+='; actual generated Python: '+f.lastPython?.stderr;throw e;}
},async({put,base})=>{
  const other='66666666-6666-6666-6666-666666666666';
  await put('operations/'+other+'.json',{...base,operationId:other,bindingId:other,action:'acquire',state:'inProgress',startedAt:Date.now()/1000});
  await put('bindings/'+other+'.json',{...base,bindingId:other,state:'creating',createUncertain:true});
}));

test('an old create-uncertain acquire is not transient and still blocks admission',()=>run(async({b})=>{
  await assert.rejects(()=>b.preflight('pclab19'));
},async({put,base})=>{
  const other='77777777-7777-7777-7777-777777777777';
  await put('operations/'+other+'.json',{...base,operationId:other,bindingId:other,action:'acquire',state:'inProgress',startedAt:Date.now()/1000-600});
  await put('bindings/'+other+'.json',{...base,bindingId:other,state:'creating',createUncertain:true});
}));
