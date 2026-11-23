import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHostBudgetWriter } from '../host/dispatch/host-budget-writer.js';

function fixture() {
  let original = { id:'n1', projectId:'p1', rev:7, status:'planned', currentAttempt:0, sessionId:'s0', execution:{driver:'dsh',profile:'dsh'}, needs:{gpu:1} };
  let node=structuredClone(original), project={id:'p1',revision:7}, tail=Promise.resolve(), writes=0, permits=0;
  const store={getNode:()=>node,getProject:()=>project,isProjectLocked:()=>false,
    withProjectLock:(_p,fn)=>{const p=tail.then(fn,fn);tail=p.catch(()=>{});return p;},
    withWritePermit:async fn=>{permits++;try{return await fn();}finally{permits--; }},saveNode:()=>{throw Error('direct writer forbidden');}};
  const kernel={executor:{commitLocked:async(_p,cmd)=>{
    assert.equal(permits,1);assert.deepEqual(node, original);assert.equal(cmd.expectedProjectRevision,7);assert.equal(cmd.mutations.length,1);
    const m=cmd.mutations[0];assert.equal(m.op,'node.update');assert.equal(m.nodeId,'n1');assert.equal(m.basis,7);
    const next=structuredClone(node);for(const [k,v]of Object.entries(m.set??{}))next[k]=structuredClone(v);for(const k of m.unset??[])delete next[k];
    project={...project,revision:8};next.rev=8;node=next;writes++;return {ok:true,revision:8};
  }}};
  const token={reservationId:'11111111-1111-4111-8111-111111111111',projectId:'p1',nodeId:'n1',requestId:'r1',forAttempt:1,launchGeneration:'g1',executionFingerprint:'e1',resources:{gpu:1},state:'reserved'};
  return {store,kernel,token,write:createHostBudgetWriter({store,kernel}),expected:()=>({projectId:'p1',nodeId:'n1',nodeRev:7,projectRev:7,reservationId:null,currentAttempt:0,sessionId:'s0'}),get node(){return node;},get writes(){return writes;},replace(v){node=v;original=structuredClone(v);}};
}

test('targeted reservation commit is kernel-only and never mutates cached node before commit',async()=>{
 const f=fixture(); const old=f.node; const result=await f.write({expected:f.expected(),reservation:f.token,event:'node/host_budget_reserved'});
 assert.equal(result.ok,true);assert.equal(f.writes,1);assert.equal(old.hostBudgetReservation,undefined);assert.deepEqual(f.node.hostBudgetReservation,f.token);assert.equal(f.node.needs.gpu,1);
});
test('all stale identity and revision dimensions reject before a kernel write',async()=>{
 for(const patch of [{nodeRev:8},{projectRev:8},{reservationId:'foreign'},{currentAttempt:1},{sessionId:'foreign'}]){
  const f=fixture();const r=await f.write({expected:{...f.expected(),...patch},reservation:f.token});assert.equal(r.ok,false);assert.equal(f.writes,0);
 }
 const f=fixture();const r=await f.write({expected:f.expected(),reservation:{...f.token,nodeId:'foreign'}});assert.equal(r.ok,false);assert.equal(f.writes,0);
});
test('two same-revision owners cannot both reserve the same node',async()=>{
 const f=fixture(); const r=await Promise.all([f.write({expected:f.expected(),reservation:f.token}),f.write({expected:f.expected(),reservation:{...f.token,reservationId:'22222222-2222-4222-8222-222222222222'}})]);
 assert.equal(r.filter(x=>x.ok).length,1);assert.equal(f.writes,1);
});
test('removal never erases a reservation while claim/admission or Unknown still holds',async()=>{
 for(const patch of [{claim:{decisionId:'d1'}},{admission:{leaseId:'l1'}},{sandbox:{verifiedClean:true,state:'released',operations:{x:{state:'unknown',action:'exec'}}}}]){
  const f=fixture();f.replace({...f.node,hostBudgetReservation:f.token,...patch});const r=await f.write({expected:{...f.expected(),reservationId:f.token.reservationId},reservation:null});assert.equal(r.ok,false);assert.equal(f.writes,0);assert.deepEqual(f.node.hostBudgetReservation,f.token);
 }
});

test('target, broker and base owner identities are pinned and effect-start evidence is monotonic',async()=>{
 for(const patch of [{target:{fingerprint:'changed'}},{brokerId:'changed'},{baseAttempt:2},{baseSessionId:'changed'},{createdAt:99}]){
  const f=fixture();const old={...f.token,target:{fingerprint:'same'},brokerId:'local-pool',baseAttempt:0,baseSessionId:'s0',createdAt:1,effectStarted:false};
  f.replace({...f.node,hostBudgetReservation:old});const r=await f.write({expected:{...f.expected(),reservationId:old.reservationId},reservation:{...old,...patch}});assert.equal(r.ok,false);assert.equal(f.writes,0);
 }
 const f=fixture();const old={...f.token,effectStarted:true};f.replace({...f.node,hostBudgetReservation:old});assert.equal((await f.write({expected:{...f.expected(),reservationId:old.reservationId},reservation:{...old,effectStarted:false}})).ok,false);assert.equal(f.writes,0);
});

test('writer alone holds legacy physical evidence and malformed unresolved operations',async()=>{
 const variants=[{resourcesHeld:{gpu:1}},{resourcesHeld:{}},{lease:{leaseId:'legacy',state:'unknown'}},{termination:{verifiedClean:false}},
  {sandbox:{bindingId:'b',state:'released',verifiedClean:true,cancelRequested:true,operations:{}}},
  {sandbox:{bindingId:'b',state:'released',verifiedClean:true,operations:{x:{state:'invalid'}}}},
  {sandbox:{bindingId:'b',state:'released',verifiedClean:true,operations:[]}}, {dispatchHold:{reason:'sandbox_held'}}];
 for(const patch of variants){const f=fixture();f.replace({...f.node,status:'failed',hostBudgetReservation:f.token,...patch});const result=await f.write({expected:{...f.expected(),reservationId:f.token.reservationId},reservation:null});assert.equal(result.ok,false,JSON.stringify(patch));assert.equal(f.writes,0);assert.deepEqual(f.node.hostBudgetReservation,f.token);}
});
