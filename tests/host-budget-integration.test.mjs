import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostBudget } from '../host/dispatch/host-budget.js';
import { createHostBudgetWriter } from '../host/dispatch/host-budget-writer.js';
import { createDispatchEnvelope } from '../host/dispatch/envelope.js';
import { createBudgetBroker } from '../host/dispatch/budget-broker.js';
import { createLocalPoolBroker, createSandboxAdmissionBroker } from '../host/dispatch/brokers.js';
import { defaultRequestFor } from '../host/dispatch/deterministic-strategy.js';
import { createKernel } from '../host/kernel/instance.js';
import { openStore } from '../host/store.js';
import { memoryDomain, storeContext } from '../scripts/lib/memory-domain.mjs';
const actor={kind:'system',id:'budget-joint-test'};
const local={profile:'dsh',driver:'dsh'},remote={profile:'remote',driver:'dsh',sandboxProfile:'pclab19'};
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
async function fixture({max=1,gpu=4,needA={gpu:1},needB={gpu:1},writeGate=null}={}){
 const store=await openStore(storeContext(memoryDomain(),{kernel:{hotEvents:100000}})),kernel=createKernel({store});
 const nodes=[['a',local,needA],['b',remote,needB]].map(([id,execution,needs])=>({id,projectId:'p',rev:1,status:'planned',kind:'experiment',currentAttempt:0,sessionId:'s-'+id,attempts:[],execution,needs,timeboxMs:60000,timestamps:{createdAt:1}}));
 const boot=await kernel.executor.bootstrapProject('p',{id:'p',name:'joint-only',revision:0,mode:'manual',config:{maxRunningNodes:max,resourcePools:{gpu}},counters:{eventSeq:0,nextNodeSeq:3,nodes:0,cycles:0},createdAt:1,updatedAt:1},{actor,mutations:nodes.map(node=>({op:'node.create',node}))});assert.equal(boot.ok,true);kernel.load('p');store.setStrictWrites('throw');
 const readNode=(p,n)=>{const value=store.getNode(p,n);return value?structuredClone(value):null;};
 const writer=createHostBudgetWriter({store,kernel});
 const budget=createHostBudget({readProject:p=>store.getProject(p),readNodes:p=>store.listNodes(p),readNode,commitReservation:cmd=>writeGate?writeGate(cmd,writer):writer(cmd)});
 const limits=()=>({maxRunningNodes:max,resourcePools:{gpu}});
 const rawLocal=createLocalPoolBroker({limits}),rawRemote=createSandboxAdmissionBroker({limits,readNode});
 const wrap=raw=>createBudgetBroker({raw,budget,readNode});
 const brokers={local:wrap(rawLocal),remote:wrap(rawRemote)};
 const patch=async(id,set={},unset=[])=>{const n=readNode('p',id),next={...n,...structuredClone(set)};for(const k of unset)delete next[k];const r=await kernel.executor.commit('p',{actor,basis:n.rev,nodeId:id,expectedProjectRevision:store.getProject('p').revision,mutations:[{op:'node.put',nodeId:id,node:next}]});assert.equal(r.ok,true,JSON.stringify(r));};
 const req=id=>defaultRequestFor('p',readNode('p',id));
 return {store,kernel,readNode,budget,brokers,rawLocal,rawRemote,wrap,patch,req};
}
test('real shared budget and raw brokers deny two grants with maxRunningNodes one',async()=>{
 const f=await fixture();const [a,b]=await Promise.all([f.brokers.local.acquire(f.req('a')),f.brokers.remote.acquire(f.req('b'))]);
 assert.equal([a,b].filter(x=>x.status==='granted').length,1);assert.equal(f.budget.snapshot('p').slotsUsed,1);
 assert.equal(f.rawLocal.size+f.rawRemote.size,1);
});
test('real resource vector GPU3 plus GPU2 exceeds one common quota of four',async()=>{
 const f=await fixture({max:4,needA:{gpu:3},needB:{gpu:2}});assert.equal((await f.brokers.local.acquire(f.req('a'))).status,'granted');
 assert.equal((await f.brokers.remote.acquire(f.req('b'))).status,'queued');assert.equal(f.budget.snapshot('p').quotaUsed.gpu,3);
});
test('actual raw-release/durable-cleanup gap never admits another lane',async()=>{
 const f=await fixture();const r=await f.brokers.remote.acquire(f.req('b'));assert.equal(r.status,'granted');
 const lease=r.lease;
 await f.patch('b',{currentAttempt:1,sessionId:'new-b',admission:lease,claim:{leaseId:lease.leaseId,decisionId:'d'},sandbox:{backend:'opensandbox',profile:'pclab19',bindingId:'no-create',state:'noCapacity',verifiedClean:true,operations:{}}});
 assert.equal((await f.brokers.remote.release(lease.leaseId)).released,true);assert.equal(f.rawRemote.size,0);
 assert.equal(f.budget.snapshot('p').slotsUsed,1);assert.equal((await f.brokers.local.acquire(f.req('a'))).status,'queued');
 assert.equal((await f.brokers.remote.finalizeRelease(lease.leaseId)).released,false);
 await f.patch('b',{},['claim','admission']);assert.equal((await f.brokers.remote.finalizeRelease(lease.leaseId)).released,true);
 assert.equal(f.budget.snapshot('p').slotsUsed,0);assert.equal((await f.brokers.local.acquire(f.req('a'))).status,'granted');
});
test('a clear kernel CAS rejection after raw cleanup retains common quota',async()=>{
 const f=await fixture({writeGate:(cmd,writer)=>cmd.reservation===null?{ok:false,code:'stale'}:writer(cmd)});
 const r=await f.brokers.local.acquire(f.req('a'));assert.equal(r.status,'granted');assert.equal((await f.brokers.local.release(r.lease.leaseId)).released,true);
 assert.equal((await f.brokers.local.finalizeRelease(r.lease.leaseId)).released,false);assert.equal(f.budget.snapshot('p').slotsUsed,1);
 assert.equal((await f.brokers.remote.acquire(f.req('b'))).status,'queued');
});
test('external cluster promise holds real common quota before resolution',async()=>{
 const gate=deferred(),entered=deferred();let called=false;const f=await fixture();
 const raw={id:'cluster',async acquire(req){called=true;entered.resolve();await gate.promise;return {status:'granted',lease:{broker:'cluster',projectId:'p',nodeId:'a',leaseId:'cluster-one',resources:req.resources}};},verify:async()=>true,release:async()=>({released:true})};
 const cluster=f.wrap(raw),pending=cluster.acquire(f.req('a'));
 await entered.promise;assert.equal(called,true);
 assert.equal(f.readNode('p','a').hostBudgetReservation.effectStarted,true);assert.equal((await f.brokers.remote.acquire(f.req('b'))).status,'queued');
 gate.resolve();assert.equal((await pending).status,'granted');assert.equal(f.budget.snapshot('p').slotsUsed,1);
});
test('cold physical-clean but Unknown command still blocks both raw lanes',async()=>{
 const f=await fixture();await f.patch('a',{status:'cancelled',sandbox:{backend:'opensandbox',profile:'pclab19',bindingId:'old',state:'released',verifiedClean:true,operations:{exec:{state:'unknown'}}}});
 assert.notEqual((await f.brokers.remote.acquire(f.req('b'))).status,'granted');assert.equal(f.rawRemote.size,0);assert.equal(f.budget.snapshot('p').slotsUsed,1);
});

test('actual envelope finalizes common quota only after kernel queued cleanup',async()=>{
 const f=await fixture();const granted=await f.brokers.remote.acquire(f.req('b'));assert.equal(granted.status,'granted');
 const envelope=createDispatchEnvelope({projectId:'p',executor:f.kernel.executor,projection:f.kernel.projection,brokers:new Map([['sandbox-admission',f.brokers.remote]]),launcher:{async start(){
   await f.patch('b',{currentAttempt:1,sessionId:'begun-b',sandbox:{backend:'opensandbox',profile:'pclab19',bindingId:'known-no-cap',state:'noCapacity',verifiedClean:true,operations:{}}});
   return {node:f.readNode('p','b'),startOutcome:{status:'queued',code:'NO_CAPACITY',verifiedClean:true,retryable:true,attempt:1,sessionId:'begun-b'}};
 }}});
 const result=await envelope.submit(actor,{kind:'start',nodeId:'b',lease:granted.lease,basis:f.readNode('p','b').rev,reason:'inert queue'});
 assert.equal(result.startOutcome.status,'queued');assert.equal(f.readNode('p','b').claim,undefined);assert.equal(f.readNode('p','b').admission,undefined);
 assert.equal(f.budget.snapshot('p').slotsUsed,0);assert.equal((await f.brokers.local.acquire(f.req('a'))).status,'granted');
});

test('actual dispatch round uses post-reservation basis without changing raw lease bytes',async()=>{
 const {dispatchRound}=await import('../host/dispatch/round.js');const f=await fixture();const candidate=f.readNode('p','b');
 const envelope=createDispatchEnvelope({projectId:'p',executor:f.kernel.executor,projection:f.kernel.projection,brokers:new Map([['sandbox-admission',f.brokers.remote]]),launcher:{async start(){
  await f.patch('b',{status:'running',currentAttempt:1,sessionId:'round-b'});return {node:f.readNode('p','b'),startOutcome:{status:'started',attempt:1,sessionId:'round-b'}};
 }}});
 const result=await dispatchRound({projectId:'p',candidates:[candidate],requestFor:defaultRequestFor,brokerFor:()=>f.brokers.remote,submit:decision=>envelope.submit(actor,decision),maxStarts:1});
 assert.equal(result.started,1,JSON.stringify(result));assert.equal(f.readNode('p','b').status,'running');assert.equal(candidate.rev,1);
});
