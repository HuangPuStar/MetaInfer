import test from 'node:test';
import assert from 'node:assert/strict';
import { createClusterBroker } from '../host/dispatch/brokers.js';
import { createBudgetBroker } from '../host/dispatch/budget-broker.js';
import { createHostBudget } from '../host/dispatch/host-budget.js';
import { createHostBudgetWriter } from '../host/dispatch/host-budget-writer.js';
import { openStore } from '../host/store.js';
import { createKernel } from '../host/kernel/instance.js';
import { memoryDomain, storeContext } from '../scripts/lib/memory-domain.mjs';

const copy = structuredClone;
const actor = { kind: 'system', id: 'cluster-release-test' };
const request = (nodeId='a', projectId='p') => ({ projectId, nodeId, requestId:projectId+':'+nodeId+':1', resources:{gpu:1}, walltimeMs:1000 });
const deferred = () => { let resolve; const promise=new Promise(r=>{resolve=r;}); return {promise,resolve}; };
function fixture(reply=()=>({status:'released'}), {sameLeaseId=false}={}) {
  const calls=[];
  const cluster={
    async acquire(req) { return {status:'granted',lease:{leaseId:sameLeaseId?'fixture-same':'fixture-'+req.projectId+'-'+req.nodeId,requestId:req.requestId,projectId:req.projectId,nodeId:req.nodeId,holderId:'fixture-holder',machineId:'fixture-machine',deviceIds:['fixture-device'],grantedAt:1000,expiresAt:61000}}; },
    async release(id) { calls.push(id); return reply(id,calls.length); },
  };
  return {cluster,calls,raw:createClusterBroker({cluster,clock:()=>1000})};
}
const acquire = async (f, req=request()) => { const answer=await f.raw.acquire(req);assert.equal(answer.status,'granted');return answer.lease; };
const owns = (raw,lease) => raw.verify(lease,{projectId:lease.projectId,nodeId:lease.nodeId});
function retained(result) { assert.equal(result?.released,false);assert.equal(result?.held,true); }

// Official coordinator contract: cluster.js release(), not the obsolete {released:true} fake.
for (const [label,ack] of [
  ['minimal',{status:'released'}],['already',{status:'released',already:true}],
  ['dispatch-count',{status:'released',granted:2}],['zero-count',{status:'released',granted:0}],
]) test('official released acknowledgement is propagated: '+label,async()=>{
  const f=fixture(()=>copy(ack)),lease=await acquire(f);
  assert.equal(await owns(f.raw,lease),true);
  assert.deepEqual(await f.raw.release(lease.leaseId),{released:true});
  assert.equal(await owns(f.raw,lease),false);assert.deepEqual(f.calls,[lease.leaseId]);
});
for (const [label,ack] of [
  ['void',undefined],['null',null],['boolean-false',false],['boolean-true',true],['empty',{}],['array',[]],
  ['obsolete-bool',{released:true}],['holder-mismatch',{status:'error',error:'lease-holder-mismatch'}],
  ['lost',{status:'lost'}],['bad-already',{status:'released',already:'true'}],
  ['negative-count',{status:'released',granted:-1}],['fractional-count',{status:'released',granted:0.5}],
  ['contradictory-error',{status:'released',error:'lease-holder-mismatch'}],
  ['unknown-field',{status:'released',unconfirmed:true}],
  ['inherited-status',Object.create({status:'released'})],
]) test('unconfirmed/malformed coordinator acknowledgement retains exact owner: '+label,async()=>{
  const f=fixture(()=>ack),lease=await acquire(f);
  retained(await f.raw.release(lease.leaseId));assert.equal(await owns(f.raw,lease),true);
  assert.equal(f.calls.length,1,'no automatic release retries');
});
for (const id of ['never-owned',undefined,null,'',42,{}]) test('unknown or invalid lease never calls coordinator: '+String(id),async()=>{
  const f=fixture(),lease=await acquire(f);retained(await f.raw.release(id));
  assert.equal(f.calls.length,0);assert.equal(await owns(f.raw,lease),true);
});
test('a different broker instance cannot release this instance owned lease',async()=>{
  const f=fixture(),lease=await acquire(f),foreign=createClusterBroker({cluster:f.cluster,clock:()=>1000});
  retained(await foreign.release(lease.leaseId));assert.equal(f.calls.length,0);assert.equal(await owns(f.raw,lease),true);
});
test('pending official acknowledgement keeps the known owner until it resolves',async()=>{
  const barrier=deferred(),f=fixture(()=>barrier.promise),lease=await acquire(f);
  const releasing=f.raw.release(lease.leaseId);assert.equal(f.calls.length,1);
  assert.equal(await owns(f.raw,lease),true);barrier.resolve({status:'released',already:true});
  assert.deepEqual(await releasing,{released:true});assert.equal(await owns(f.raw,lease),false);
});
test('provider throw does not delete or relabel the local owner',async()=>{
  const f=fixture(()=>{throw Error('lost coordinator acknowledgement');}),lease=await acquire(f),before=copy(lease);
  await assert.rejects(f.raw.release(lease.leaseId),/lost coordinator acknowledgement/);
  assert.equal(await owns(f.raw,lease),true);assert.deepEqual(lease,before);assert.equal(f.calls.length,1);
});
test('late ACK cannot delete a replacement owner registered under the same ID',async()=>{
  const barrier=deferred(),f=fixture(()=>barrier.promise,{sameLeaseId:true}),old=await acquire(f);
  const releasing=f.raw.release(old.leaseId),next=await acquire(f,request('b'));
  assert.equal(next.leaseId,old.leaseId);barrier.resolve({status:'released'});retained(await releasing);
  assert.equal(await owns(f.raw,next),true);assert.equal(await owns(f.raw,old),false);assert.equal(f.calls.length,1);
});
test('a clean old lease repeat cannot issue another RPC or release a new owner',async()=>{
  const f=fixture(),old=await acquire(f);assert.deepEqual(await f.raw.release(old.leaseId),{released:true});
  const next=await acquire(f,request('b'));retained(await f.raw.release(old.leaseId));
  assert.equal(f.calls.length,1);assert.equal(await owns(f.raw,next),true);
});
test('an explicit subsequent known-owner retry may consume a later official ACK',async()=>{
  const f=fixture((id,count)=>count===1?undefined:{status:'released',already:true}),lease=await acquire(f);
  retained(await f.raw.release(lease.leaseId));assert.equal(await owns(f.raw,lease),true);
  assert.deepEqual(await f.raw.release(lease.leaseId),{released:true});assert.equal(f.calls.length,2);
});

// No Agent/payload is ever launched; positive fixtures separately persist Host clean proof after the raw ACK.
async function joint(reply, {clearBarrier=null}={}) {
  const store=await openStore(storeContext(memoryDomain(),{kernel:{hotEvents:100000,eventArchiveRoot:'D:/file/DSH/MetaInfer/deployments/metainfer-v2-opensandbox-pclab19-20261114/evidence/v2-cluster-release-unused-memory'}}));
  const kernel=createKernel({store,clock:()=>1000});
  const nodes=['a','b'].map(id=>({id,projectId:'p',status:'planned',currentAttempt:0,sessionId:'session-'+id,execution:{profile:'dsh',driver:'dsh'},needs:{gpu:1}}));
  const bootstrap=await kernel.executor.bootstrapProject('p',{id:'p',name:'inert-cluster-release',revision:0,counters:{eventSeq:0,nextNodeSeq:3,nodes:0,cycles:0},config:{maxRunningNodes:1,resourcePools:{gpu:4}},mode:'manual',createdAt:1,updatedAt:1},{actor,mutations:[{op:'event.record',type:'fixture/created',data:{}},...nodes.map(node=>({op:'node.create',node}))]});
  assert.equal(bootstrap.ok,true,JSON.stringify(bootstrap));kernel.load('p');store.setStrictWrites('throw');
  const writer=createHostBudgetWriter({store,kernel});
  const budget=createHostBudget({readProject:p=>store.getProject(p),readNodes:p=>store.listNodes(p),readNode:(p,n)=>store.getNode(p,n),commitReservation:async command=>{if(command.reservation===null&&clearBarrier){clearBarrier.entered.resolve();await clearBarrier.release.promise;}return writer(command);},clock:()=>1000});
  const f=fixture(reply),wrapped=createBudgetBroker({raw:f.raw,budget,readNode:(p,n)=>store.getNode(p,n)});
  const granted=await wrapped.acquire(request());assert.equal(granted.status,'granted',JSON.stringify(granted));const lease=granted.lease;
  async function patch(set={},unset=[]) { const node={...copy(store.getNode('p','a')),...copy(set)};for(const key of unset)delete node[key];const result=await kernel.executor.commit('p',{actor,mutations:[{op:'node.put',node}]});assert.equal(result.ok,true,JSON.stringify(result)); }
  await patch({claim:{leaseId:lease.leaseId,decisionId:'fixture-decision'},admission:copy(lease)});
  return {...f,store,kernel,budget,wrapped,lease,patch};
}
test('official raw ACK is separate from durable claim cleanup and common budget release',async()=>{
  const f=await joint(()=>({status:'released',granted:0}));const result=await f.wrapped.release(f.lease.leaseId);
  assert.equal(result.released,true);assert.equal(result.hostBudgetReleased,false);assert.equal(f.budget.snapshot('p').slotsUsed,1);
  retained(await f.wrapped.finalizeRelease(f.lease.leaseId));assert.ok(f.store.getNode('p','a').claim);
  await f.patch({termination:{verifiedClean:true,reason:'INERT_FIXTURE_NO_PAYLOAD_EVER_LAUNCHED'}},['claim','admission']);assert.equal((await f.wrapped.finalizeRelease(f.lease.leaseId)).released,true);
  assert.equal(f.budget.snapshot('p').slotsUsed,0);assert.equal(f.store.getNode('p','a').hostBudgetReservation,undefined);
});
for (const [label,reply] of [['void',()=>undefined],['mismatch',()=>({status:'error',error:'lease-holder-mismatch'})],['throw',()=>{throw Error('transport unknown');}]]) test('real kernel wrapper retains claim and reservation after raw '+label,async()=>{
  const f=await joint(reply),before=copy(f.store.getNode('p','a'));retained(await f.wrapped.release(f.lease.leaseId));
  assert.equal(await owns(f.raw,f.lease),true);assert.deepEqual(f.store.getNode('p','a'),before);assert.equal(f.budget.snapshot('p').slotsUsed,1);
  assert.notEqual((await f.budget.reserve({...request('b'),brokerId:'local-pool'})).status,'granted');assert.equal(f.calls.length,1);
});
test('official raw release cannot free common quota before the durable clear ACK',async()=>{
  const clearBarrier={entered:deferred(),release:deferred()},f=await joint(()=>({status:'released'}),{clearBarrier});
  assert.equal((await f.wrapped.release(f.lease.leaseId)).released,true);await f.patch({termination:{verifiedClean:true,reason:'INERT_FIXTURE_NO_PAYLOAD_EVER_LAUNCHED'}},['claim','admission']);
  const pending=f.wrapped.finalizeRelease(f.lease.leaseId);await clearBarrier.entered.promise;
  assert.equal(f.budget.snapshot('p').slotsUsed,1);assert.ok(f.store.getNode('p','a').hostBudgetReservation);
  clearBarrier.release.resolve();assert.equal((await pending).released,true);assert.equal(f.budget.snapshot('p').slotsUsed,0);
});
