import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { getSandboxTarget } from '../../host/sandbox-targets.js';
export const sha=v=>createHash('sha256').update(v).digest('hex');
export const clone=v=>structuredClone(v);
export function entry(p,v){const b=Buffer.from(v);return {path:p,size:b.length,sha256:sha(b),contentBase64:b.toString('base64')};}
export const bundle=files=>({files,totalBytes:files.reduce((n,f)=>n+f.size,0),truncated:false});
export function probe(t){return {schemaVersion:1,profile:t.profile,remoteRoot:t.remoteRoot,catalogSha256:t.catalogSha256,targetIdentity:t.targetIdentity,identityLabel:t.identityLabel,image:t.image,devices:t.devices,codeSha256:t.codeSha256,scanComplete:true,layout:{operations:'operations',bindings:'bindings',stop:'state/STOP',admission:'admission-blocked.json',nativePending:'adapter/dcu-allocation.lock'},markers:{stop:{present:false},admission:{present:false},nativePending:{present:true,bytes:0}},unresolved:[]};}
export async function fixture(){
  const temp=await mkdtemp(path.join(fileURLToPath(new URL('./',import.meta.url)),'.tmp-'));
  const root=path.join(temp,'worktrees'), worktree=path.join(root,'node-1');await mkdir(worktree,{recursive:true});
  await writeFile(path.join(worktree,'README.md'),'hello');
  const t=getSandboxTarget('pclab19'), configPath=path.join(temp,'opensandbox.json'), requestsDir=path.join(temp,'requests');
  await writeFile(configPath,JSON.stringify({sshAlias:t.sshAlias,remoteRoot:t.remoteRoot,python:t.python}));
  const f={temp,t,worktree,configPath,requestsDir,decisionPath:path.join(temp,'admission.json'),now:1800000000000,calls:[],commits:[],remote:new Map(),files:new Map(),uploads:new Map(),onRequest:null,onUpload:null,onCommit:null,probe:probe(t)};
  f.project={id:'prj-test',repo:{worktreeRoot:root}};
  f.node={id:'node-1',projectId:f.project.id,currentAttempt:1,sessionId:'session-fixture',rev:1,status:'running',execution:{driver:'dsh',sandboxProfile:'pclab19'},needs:{gpu:1,machines:1},timeboxMs:60000,git:{worktreePath:worktree}};
  f.readNode=async()=>clone(f.node);
  f.commitBinding=async({expected,binding,event})=>{
    if(f.onCommit) await f.onCommit({expected,binding,event});
    assert.equal(expected.nodeRev,f.node.rev,'nodeRev CAS');
    assert.equal(expected.attempt,f.node.currentAttempt);assert.equal(expected.sessionId,f.node.sessionId);
    assert.equal(expected.profile,f.node.execution.sandboxProfile);
    assert.equal(expected.bindingId,f.node.sandbox?.bindingId??null);
    if(expected.operationId){const prev=f.node.sandbox?.operations?.[expected.operationId];assert.ok(prev||binding.operations[expected.operationId]?.state==='intent');}
    for(const [id,op] of Object.entries(f.node.sandbox?.operations??{})) if(op.state==='unknown') assert.deepEqual(binding.operations[id],op,'unknown must remain byte-equivalent');
    f.commits.push(clone({expected,binding,event}));f.node.sandbox=clone(binding);f.node.rev++;return clone(f.node);
  };
  f.reply=async r=>{
    const bid=r.bindingId;
    if(r.action==='acquire'){
      const ds=t.devices.slice(0,r.gpuCount),b={profile:t.profile,bindingId:bid,projectId:r.projectId,nodeId:r.nodeId,attempt:r.attempt,managedId:'mi-'+bid,providerId:randomUUID(),containerId:'c'.repeat(64),state:'ready',expiresAt:f.now+r.leaseSeconds*1000,gpuCount:r.gpuCount,renders:ds.map(d=>d.render),bdfs:ds.map(d=>d.bdf),verifiedClean:false};f.remote.set(bid,b);return {ok:true,data:clone(b)};
    }
    const b=f.remote.get(bid);
    if(r.action==='release'){b.state='released';b.verifiedClean=true;return {ok:true,data:clone(b)};}
    if(r.action==='status')return {ok:true,data:{binding:clone(b),live:true}};
    if(r.action==='exec')return {ok:true,data:{commandId:randomUUID(),exitCode:0,success:true,stdout:'ok',stderr:'',durationMs:1,truncated:false}};
    if(r.action==='write'){const e=entry(r.path,Buffer.from(r.contentBase64,'base64'));f.files.set(r.path,e);return {ok:true,data:{path:e.path,size:e.size,sha256:e.sha256}};}
    if(r.action==='read')return {ok:true,data:clone(f.files.get(r.path))};
    if(r.action==='collect')return {ok:true,data:bundle([...f.files.values()])};
    throw Error('unexpected fake action');
  };
  f.transport=async(name,args,options)=>{
    f.calls.push({name,args:clone(args),signal:options?.signal});assert.equal(args.alias,'pclab2');
    if(name==='ssh_upload'){
      const bytes=await readFile(args.localPath),r=JSON.parse(bytes.toString('utf8'));
      assert.equal(args.remotePath,`${t.remoteRoot}/requests/${r.operationId}.json`);
      assert.equal(f.node.sandbox.operations[r.operationId].state,'intent','durable intent precedes upload');
      f.uploads.set(r.operationId,r);if(f.onUpload)await f.onUpload(r);return {ok:true,transferredBytes:bytes.length,files:1};
    }
    assert.equal(name,'ssh_exec');
    if(!args.command.includes('--request-id'))return {success:true,exitCode:0,timedOut:false,stdout:JSON.stringify(f.probe),stderr:'',durationMs:1};
    const id=args.command.match(/--request-id\s+'?([0-9a-f-]{36})/)[1],r=f.uploads.get(id);
    assert.ok(r);const value=f.onRequest?await f.onRequest(r):await f.reply(r);
    if(value?.rawTool)return value.rawTool;
    return {success:true,exitCode:0,timedOut:false,stdout:JSON.stringify(value),stderr:'',durationMs:1};
  };
  f.cleanup=()=>rm(temp,{recursive:true,force:true});return f;
}
