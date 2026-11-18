import assert from 'node:assert/strict';
import test from 'node:test';
import { createSandboxBackend } from '../../host/sandbox-backend.js';
import { fixture } from './fakes.mjs';
const backend=f=>createSandboxBackend({ctx:{},readNode:f.readNode,commitBinding:f.commitBinding,configPath:f.configPath,requestsDir:f.requestsDir,decisionPath:f.decisionPath,clock:()=>f.now,transport:f.transport});
const run=async(fn)=>{const f=await fixture();try{await fn(f,backend(f));}finally{await f.cleanup();}};
const until=async(predicate)=>{const end=Date.now()+2000;while(Date.now()<end){if(predicate())return;await new Promise(r=>setTimeout(r,5));}throw Error('condition not reached');};
const ops=o=>Object.values(o??{});

// Real S7 failure: the liveness pump's status heartbeat was still an in-flight intent when the
// worker's first exec arrived. The generic uncertain guard then answered SANDBOX_UNKNOWN
// ("Uncertain operation blocks replay/new effects"), so the worker correctly abandoned the run
// even though nothing was uncertain. Operations on one binding must serialize instead.
test('worker exec serializes behind an in-flight status heartbeat instead of reporting UNKNOWN',()=>run(async(f,b)=>{
  await b.prepare(f.project,f.node);
  const before=f.uploads.size;
  let open;const gate=new Promise(resolve=>{open=resolve;});
  f.onRequest=async r=>{if(r.action==='status')await gate;return f.reply(r);};
  const beat=b.heartbeat(f.project,f.node);
  await until(()=>ops(f.node.sandbox.operations).some(x=>x.action==='status'&&x.state==='intent'));
  let execError=null;
  const exec=b.execute(f.project,f.node,{action:'exec',command:'python3 compute.py',timeoutMs:60000}).catch(e=>{execError=e;});
  await new Promise(r=>setTimeout(r,50));
  assert.equal(execError,null,'exec must wait for the in-flight heartbeat, not fail as if uncertain');
  assert.equal(f.uploads.size,before+1,'exec must not upload while the heartbeat owns the binding');
  open();
  await beat;
  const result=await exec;assert.equal(execError,null);
  assert.equal(result.exitCode,0);
  const requests=[...f.uploads.values()],status=requests.find(x=>x.action==='status'),ex=requests.find(x=>x.action==='exec');
  assert.ok(status&&ex);
  const index=id=>f.commits.findIndex(c=>c.expected.operationId===id&&c.event==='node/sandbox_intent');
  assert.ok(index(status.operationId)<index(ex.operationId),'exec intent must be created after the heartbeat intent settled');
  assert.ok(ops(f.node.sandbox.operations).every(x=>x.state==='completed'));
}));

// R4: a terminated node must not leave its container alive behind a long exec. Release is a fresh
// operation the remote Bridge can perform during a running command, so it must not queue behind
// the exec lane; the ledger CAS fences any late exec completion.
test('release bypasses a long in-flight exec lane instead of waiting for it',()=>run(async(f,b)=>{
  await b.prepare(f.project,f.node);
  const before=f.uploads.size;
  let open;const gate=new Promise(resolve=>{open=resolve;});
  f.onRequest=async r=>{if(r.action==='exec')await gate;return f.reply(r);};
  const exec=b.execute(f.project,f.node,{action:'exec',command:'sleep 120',timeoutMs:120000}).catch(e=>e);
  await until(()=>ops(f.node.sandbox.operations).some(x=>x.action==='exec'&&x.state==='intent'));
  const releaseP=b.release(f.project,f.node);
  const uploaded=()=>[...f.uploads.values()];
  await until(()=>uploaded().some(x=>x.action==='exec')&&uploaded().some(x=>x.action==='release'));
  assert.equal(f.uploads.size,before+2,'release must upload while exec is still in flight');
  assert.equal(ops(f.node.sandbox.operations).find(x=>x.action==='exec').state,'unknown','in-flight exec is fenced as cancelled, never replayed');
  open();
  const released=await releaseP;assert.equal(released.verifiedClean,true);
  assert.equal(f.node.sandbox.state,'released');assert.equal(f.node.sandbox.verifiedClean,true);
  await exec;
}));
