import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostAdmission } from '../host/dispatch/host-admission.js';
import { createHostBudget } from '../host/dispatch/host-budget.js';
import { createHostBudgetWriter } from '../host/dispatch/host-budget-writer.js';
import { createBudgetBroker } from '../host/dispatch/budget-broker.js';
import { createLocalPoolBroker, createSandboxAdmissionBroker } from '../host/dispatch/brokers.js';
import { createKernel } from '../host/kernel/instance.js';
import { openStore } from '../host/store.js';
import { memoryDomain, storeContext } from '../scripts/lib/memory-domain.mjs';
const local={profile:'dsh',driver:'dsh'},remote={profile:'remote',driver:'dsh',sandboxProfile:'pclab19'};
async function fixture({start,max=1,failClearOnce=false,unloaded=false}={}){
 const store=await openStore(storeContext(memoryDomain(),{kernel:{hotEvents:10000}})),kernel=createKernel({store});
 const initial=[['a',local],['b',remote]].map(([id,execution])=>({id,projectId:'p',rev:1,status:'planned',kind:'experiment',currentAttempt:0,sessionId:'s-'+id,execution,needs:{gpu:1},attempts:[],timeboxMs:60000,timestamps:{createdAt:1}}));
 assert.equal((await kernel.executor.bootstrapProject('p',{id:'p',name:'admission-only',revision:0,mode:'manual',config:{maxRunningNodes:max,resourcePools:{gpu:4}},counters:{eventSeq:0,nextNodeSeq:3,nodes:0,cycles:0},createdAt:1,updatedAt:1},{actor:{kind:'system',id:'fixture'},mutations:initial.map(node=>({op:'node.create',node}))})).ok,true);kernel.load('p');store.setStrictWrites('throw');
 if(unloaded)kernel.unload('p');
 const readNode=(pid,nid)=>structuredClone(store.getNode(pid,nid)),writer=createHostBudgetWriter({store,kernel});
 const budget=createHostBudget({readProject:pid=>store.getProject(pid),readNodes:pid=>store.listNodes(pid),readNode,commitReservation:async args=>{if(failClearOnce&&args.reservation===null){failClearOnce=false;return {ok:false,code:'stale'};}return writer(args);}});
 const limits=()=>({maxRunningNodes:max,resourcePools:{gpu:4}}),brokers=new Map();
 for(const raw of [createLocalPoolBroker({limits}),createSandboxAdmissionBroker({limits,readNode})])brokers.set(raw.id,createBudgetBroker({raw,budget,readNode}));
 let launches=0,launched;
 const manager=createHostAdmission({store,kernel,budget,brokersFor:async()=>brokers,start:async(pid,nid,opts)=>{launches++;launched={pid,nid,opts};return start?start({store,kernel,manager,readNode},pid,nid,opts):{node:readNode(pid,nid),startOutcome:{status:'held',retryable:false,code:'FIXTURE_ONLY'}};}});
 const patch=async(id,set={},unset=[])=>{const n=readNode('p',id),next={...n,...structuredClone(set)};for(const name of unset)delete next[name];const r=await kernel.executor.commit('p',{actor:{kind:'system',id:'fixture'},expectedProjectRevision:store.getProject('p').revision,mutations:[{op:'node.put',nodeId:id,basis:n.rev,node:next}]});assert.equal(r.ok,true,JSON.stringify(r));};
 return {store,kernel,readNode,budget,brokers,manager,patch,get launches(){return launches;},get launched(){return launched;}};
}
test('common manual start uses fresh post-reservation revision and actual kernel claim',async()=>{
 const f=await fixture();const result=await f.manager.request('p','b');assert.equal(result.startOutcome.status,'held');assert.equal(f.launches,1);const n=f.readNode('p','b');assert.ok(n.admission);assert.ok(n.hostBudgetReservation);assert.equal(n.claim.decisionId,f.launched.opts.decisionId);assert.equal(await f.manager.verify(f.store.getProject('p'),n,f.launched.opts.lease,f.launched.opts.decisionId),true);
 const denied=await f.manager.request('p','a');assert.equal(f.launches,1);assert.equal(denied.startOutcome.status,'held');assert.equal(f.budget.snapshot('p').slotsUsed,1);
});
test('foreign or missing claim/raw identity never passes admission verification',async()=>{
 const f=await fixture();await f.manager.request('p','b');const n=f.readNode('p','b'),lease=f.launched.opts.lease;assert.equal(await f.manager.verify(f.store.getProject('p'),n,{...lease,nodeId:'a'},f.launched.opts.decisionId),false);assert.equal(await f.manager.verify(f.store.getProject('p'),n,lease,'foreign'),false);await f.patch('b',{},['claim']);assert.equal(await f.manager.verify(f.store.getProject('p'),f.readNode('p','b'),lease,f.launched.opts.decisionId),false);
});
test('beforeEffects binds actual attempt/session then marks once before any effect',async()=>{
 const f=await fixture();await f.manager.request('p','b');const lease=f.launched.opts.lease;await f.patch('b',{status:'running',currentAttempt:1,sessionId:'new-b'});const r=await f.manager.beforeEffects('p','b',lease);assert.equal(r.ok,true);const n=f.readNode('p','b');assert.equal(n.hostBudgetReservation.effectStarted,true);assert.equal(n.hostBudgetReservation.bound.sessionId,'new-b');assert.equal(n.hostBudgetReservation.bound.attempt,1);assert.equal((await f.manager.beforeEffects('p','b',lease)).ok,false);
});
test('cancelled/replaced node is fenced before mark and raw effects',async()=>{
 const f=await fixture();await f.manager.request('p','b');await f.patch('b',{status:'cancelled',currentAttempt:1,sessionId:'cancelled'});assert.equal((await f.manager.beforeEffects('p','b',f.launched.opts.lease)).ok,false);assert.equal(f.readNode('p','b').hostBudgetReservation.effectStarted,false);
});
test('clean no-capacity goes through envelope cleanup and common finalize',async()=>{
 const f=await fixture({start:async({readNode,kernel,store},pid,nid)=>{const n=readNode(pid,nid);assert.equal((await kernel.executor.commit(pid,{actor:{kind:'system',id:'fixture'},expectedProjectRevision:store.getProject(pid).revision,mutations:[{op:'node.update',nodeId:nid,basis:n.rev,set:{currentAttempt:1,sessionId:'queued-b',sandbox:{backend:'opensandbox',profile:'pclab19',bindingId:'no-create',state:'noCapacity',verifiedClean:true,operations:{}}}}]})).ok,true);return {node:readNode(pid,nid),startOutcome:{status:'queued',code:'NO_CAPACITY',verifiedClean:true,retryable:true,attempt:1,sessionId:'queued-b'}};}});
 const r=await f.manager.request('p','b');assert.equal(r.startOutcome.status,'queued');assert.equal(f.budget.snapshot('p').slotsUsed,0);assert.equal(f.readNode('p','b').claim,undefined);
});
test('local raw cleanup does not finalize common quota until durable exact cleanup proof',async()=>{
 const f=await fixture();await f.manager.request('p','a');const lease=f.launched.opts.lease;await f.patch('a',{status:'running',currentAttempt:1,sessionId:'local-a'},['claim']);assert.equal((await f.manager.beforeEffects('p','a',lease)).ok,true);assert.equal((await f.manager.release('p','a',lease)).released,true);assert.equal((await f.manager.finalize('p','a')).released,false);
 await f.patch('a',{status:'completed',hostBudgetCleanup:{attempt:1,sessionId:'local-a',verifiedClean:true,at:1}});assert.equal((await f.manager.finalize('p','a')).released,true);assert.equal(f.budget.snapshot('p').slotsUsed,0);
});

test('beforeEffects rejects a forged raw vector before binding or effect marker',async()=>{
 const f=await fixture();await f.manager.request('p','b');const lease=f.launched.opts.lease;await f.patch('b',{status:'running',currentAttempt:1,sessionId:'real-b'});
 assert.equal((await f.manager.beforeEffects('p','b',{...lease,resources:{gpu:99}})).ok,false);
 assert.equal(f.readNode('p','b').hostBudgetReservation.effectStarted,false);
 assert.equal((await f.manager.beforeEffects('p','b',lease)).ok,true);
});
test('beforeEffects never treats an actual sandbox gate as ordinary pending admission',async()=>{
 const f=await fixture();await f.manager.request('p','b');await f.patch('b',{status:'running',currentAttempt:1,sessionId:'real-b',sandboxGate:{profile:'pclab19',code:'BLOCK',blockers:['hold'],at:1,retryable:false}});
 assert.equal((await f.manager.beforeEffects('p','b',f.launched.opts.lease)).ok,false);
 assert.equal(f.readNode('p','b').hostBudgetReservation.effectStarted,false);
});

test('manual and pump recover another lane clean reservation after a single stale finalize without explicit dispatch sweep',async()=>{
 const f=await fixture({failClearOnce:true});await f.manager.request('p','a');const lease=f.launched.opts.lease;
 await f.patch('a',{status:'running',currentAttempt:1,sessionId:'done-a'},['claim']);assert.equal((await f.manager.beforeEffects('p','a',lease)).ok,true);
 assert.equal((await f.manager.release('p','a',lease)).released,true);
 await f.patch('a',{status:'failed',hostBudgetCleanup:{attempt:1,sessionId:'done-a',verifiedClean:true,at:1}},['claim','admission','resourcesHeld','lease']);
 assert.equal((await f.manager.finalize('p','a')).released,false,'injected definite stale CAS retains occupation');assert.equal(f.budget.snapshot('p').slotsUsed,1);
 await f.manager.request('p','b');assert.equal(f.launches,2,'selected sandbox lane must sweep already-released local lane before acquiring');
 assert.equal(f.launched.nid,'b');assert.equal(f.readNode('p','a').hostBudgetReservation,undefined);
});

test('manual start of a project created after Host apply loads the idempotent kernel projection before reservation and claim',async()=>{
 const f=await fixture({unloaded:true});assert.equal(f.kernel.isLoaded('p'),false);
 const r=await f.manager.request('p','b');assert.equal(r.startOutcome.status,'held');assert.equal(f.launches,1);
 assert.equal(f.kernel.isLoaded('p'),true);assert.ok(f.kernel.projection.getNode('p','b').admission);
});
