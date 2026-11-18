import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostBudget } from '../../host/dispatch/host-budget.js';
import { createHostBudgetWriter } from '../../host/dispatch/host-budget-writer.js';
import { createKernel } from '../../host/kernel/instance.js';
import { openStore } from '../../host/store.js';
import { memoryDomain, storeContext } from '../../scripts/lib/memory-domain.mjs';

const copy = value => structuredClone(value);
const actor = {kind:'system',id:'host-budget-test'};
const REMOTE = {profile:'sandbox-pclab19',driver:'dsh',sandboxProfile:'pclab19'};
const node = (id,extra={}) => ({id,projectId:'p',status:'planned',currentAttempt:0,sessionId:'s-'+id,execution:copy(REMOTE),needs:{gpu:1},...extra});
const binding = extra => ({backend:'opensandbox',profile:'pclab19',bindingId:'physical',state:'released',verifiedClean:true,operations:{},...extra});
function deferred() { let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve}; }
async function fixture({nodes=[node('a'),node('b')],max=1,gpu=4,writer=null,twoProjects=false}={}) {
  const domain=memoryDomain();
  const store=await openStore(storeContext(domain,{kernel:{eventArchiveRoot:'D:/file/DSH/MetaInfer/deployments/metainfer-v2-opensandbox-pclab19-20261114/evidence/v2-budget-unused-mock-archive',hotEvents:100000}}));
  const kernel=createKernel({store,clock:()=>1000});
  for(const projectId of twoProjects?['p','q']:['p']) {
    const created=await kernel.executor.bootstrapProject(projectId,{id:projectId,name:'pure-budget-fixture',revision:0,counters:{eventSeq:0,nextNodeSeq:100,nodes:0,cycles:0},config:{maxRunningNodes:max,resourcePools:{gpu,cpu:8}},mode:'manual',createdAt:1,updatedAt:1},{actor,mutations:[{op:'event.record',type:'fixture/created',data:{}},...nodes.filter(n=>n.projectId===projectId).map(n=>({op:'node.create',node:copy(n)}))]});
    assert.equal(created.ok,true,JSON.stringify(created));kernel.load(projectId);
  }
  store.setStrictWrites('throw');
  const calls=[];const real=createHostBudgetWriter({store,kernel});
  const commitReservation=async cmd=>{calls.push(copy(cmd));return writer?writer(cmd,real):real(cmd);};
  const make=()=>createHostBudget({readProject:p=>store.getProject(p),readNodes:p=>store.listNodes(p),readNode:(p,n)=>store.getNode(p,n),commitReservation,clock:()=>1000});
  const budget=make();
  const patch=async(id,set={},unset=[],projectId='p')=>{const next={...copy(store.getNode(projectId,id)),...copy(set)};for(const key of unset)delete next[key];const r=await kernel.executor.commit(projectId,{actor,mutations:[{op:'node.put',node:next}]});assert.equal(r.ok,true,JSON.stringify(r));};
  const req=(id='a',brokerId='sandbox-admission',projectId='p')=>({projectId,nodeId:id,requestId:projectId+':'+id+':next',brokerId,resources:copy(store.getNode(projectId,id).needs)});
  return {store,kernel,budget,make,patch,req,calls,real};
}
const granted=async(f,id='a',brokerId='sandbox-admission',p='p')=>{const r=await f.budget.reserve(f.req(id,brokerId,p));assert.equal(r.status,'granted',JSON.stringify(r));return r.token;};
const notGranted=result=>assert.notEqual(result.status,'granted',JSON.stringify(result));
const clear=(f,token,proof={kind:'no-effect',reason:'BEFORE_RAW'})=>f.budget.release(token,proof);

// Persistent occupancy, not the individual broker maps, controls every lane.
for(const brokerId of ['local-pool','cluster','sandbox-admission']) test('cold persistent local running blocks '+brokerId,async()=>{
  const f=await fixture({nodes:[node('old',{execution:{profile:'dsh',driver:'dsh'},status:'running',resourcesHeld:{gpu:1}}),node('a')]});
  notGranted(await f.budget.reserve(f.req('a',brokerId)));assert.equal(f.budget.snapshot('p').slotsUsed,1);assert.equal(f.calls.length,0);
});
for(const status of ['failed','cancelled','planned']) test('terminal/queued unclean CPU binding still occupies one slot: '+status,async()=>{
  const f=await fixture({nodes:[node('old',{status,needs:{},sandbox:binding({verifiedClean:false,state:'createUnknown'})}),node('a')]});
  notGranted(await f.budget.reserve(f.req()));assert.equal(f.budget.snapshot('p').slotsUsed,1);
});
test('legacy resource-held and unresolved cluster lease survive cold empty maps',async()=>{
  const f=await fixture({nodes:[node('old',{status:'failed',execution:{profile:'dsh',driver:'dsh'},resourcesHeld:{gpu:1},lease:{leaseId:'cluster-old'}}),node('a')]});
  notGranted(await f.budget.reserve(f.req()));assert.equal(f.budget.snapshot('p').quotaUsed.gpu,1);
});
test('GPU vectors 3+2 cannot cross a shared quota of four',async()=>{
  const f=await fixture({max:4,nodes:[node('a',{needs:{gpu:3}}),node('b',{needs:{gpu:2}})]});
  await granted(f,'a','local-pool');notGranted(await f.budget.reserve(f.req('b','cluster')));assert.equal(f.budget.snapshot('p').quotaUsed.gpu,3);
});
test('CPU zero occupies a Host slot without inventing physical GPU use',async()=>{
  const f=await fixture({nodes:[node('a',{needs:{gpu:0}}),node('b')]});await granted(f);
  assert.equal(f.budget.snapshot('p').slotsUsed,1);assert.equal(f.budget.snapshot('p').quotaUsed.gpu??0,0);notGranted(await f.budget.reserve(f.req('b')));
});
test('projects have independent policy budgets',async()=>{
  const f=await fixture({twoProjects:true,nodes:[node('a'),node('a',{projectId:'q'})]});
  await granted(f);await granted(f,'a','local-pool','q');assert.equal(f.budget.snapshot('p').slotsUsed,1);assert.equal(f.budget.snapshot('q').slotsUsed,1);
});
test('process pending is occupied before the first awaited durable CAS',async()=>{
  const barrier=deferred();let entered=false;
  const f=await fixture({writer:async(cmd,real)=>{entered=true;await barrier.promise;return real(cmd);}});
  const first=f.budget.reserve(f.req('a','cluster'));assert.equal(entered,true);assert.equal(f.budget.snapshot('p').slotsUsed,1);
  notGranted(await f.budget.reserve(f.req('b','local-pool')));barrier.resolve();assert.equal((await first).status,'granted');
});
test('Promise.all across three brokers cannot oversubscribe max one',async()=>{
  const f=await fixture({nodes:[node('a'),node('b'),node('c')]});const r=await Promise.all(['local-pool','cluster','sandbox-admission'].map((b,i)=>f.budget.reserve(f.req(['a','b','c'][i],b))));
  assert.equal(r.filter(x=>x.status==='granted').length,1);assert.equal(f.budget.snapshot('p').slotsUsed,1);
});
test('strict kernel writer leaves cached source object unchanged until acknowledgement',async()=>{
  const f=await fixture();const cached=f.store.getNode('p','a');await granted(f);
  assert.equal(cached.hostBudgetReservation,undefined);assert.ok(f.store.getNode('p','a').hostBudgetReservation);assert.equal(f.calls.length,1);
  assert.throws(()=>f.store.saveNode('p',node('forbidden')),/writer|kernel|permit|direct/i);
});
test('the same Node represented by reservation/running/claim/admission is charged once',async()=>{
  const f=await fixture({max:4});const token=await granted(f);
  await f.patch('a',{status:'running',currentAttempt:1,resourcesHeld:{gpu:1},claim:{leaseId:'raw'},admission:{leaseId:'raw',resources:{gpu:1}}});
  const s=f.budget.snapshot('p');assert.equal(s.slotsUsed,1);assert.equal(s.quotaUsed.gpu,1);assert.equal(s.owners.length,1);assert.equal(s.owners[0].nodeId,'a');
  assert.equal(token.forAttempt,1);
});
test('same request before external effects can reuse only its original exact token',async()=>{
  const f=await fixture();const token=await granted(f);const again=await f.budget.reserve(f.req());assert.equal(again.status,'granted');assert.deepEqual(again.token,token);assert.equal(f.budget.snapshot('p').slotsUsed,1);
});
test('different request/broker cannot take an older same-node reservation',async()=>{
  const f=await fixture();const token=await granted(f);notGranted(await f.budget.reserve({...f.req(),requestId:'other'}));notGranted(await f.budget.reserve(f.req('a','local-pool')));assert.equal((await f.budget.verify(token)).ok,true);
});
test('lowering limits keeps old owners and denies additional grants',async()=>{
  const f=await fixture({max:4});await granted(f);const r=await f.kernel.executor.commit('p',{actor,mutations:[{op:'project.update',set:{config:{maxRunningNodes:0,resourcePools:{gpu:0}}}}]});assert.equal(r.ok,true);
  notGranted(await f.budget.reserve(f.req('b')));assert.equal(f.budget.snapshot('p').slotsUsed,1);
});
for(const resources of [{gpu:-1},{gpu:NaN},{gpu:1.5},{gpu:2},{unexpected:1}]) test('invalid/forged resource vector rejected '+JSON.stringify(resources),async()=>{
  const f=await fixture();notGranted(await f.budget.reserve({...f.req(),resources}));assert.equal(f.calls.length,0);
});
test('read and returned token/snapshot aliases cannot mutate quota or cached records',async()=>{
  const f=await fixture();const token=await granted(f);const view=f.budget.snapshot('p');token.resources.gpu=99;view.owners[0].resources.gpu=88;
  assert.equal(f.budget.snapshot('p').quotaUsed.gpu,1);assert.equal(f.store.getNode('p','a').hostBudgetReservation.resources.gpu,1);
});
test('target or future attempt changes invalidate ownership instead of relabeling',async()=>{
  const f=await fixture();const token=await granted(f);await f.patch('a',{execution:{profile:'dsh',driver:'dsh'}});assert.equal((await f.budget.verify(token)).ok,false);notGranted(await f.budget.reserve(f.req('b')));assert.equal((await clear(f,token)).released,false);
});
for(const mode of ['throw-before','commit-unknown','false-other','ack-without-write','write-then-throw']) test('ambiguous reservation acknowledgement remains held: '+mode,async()=>{
  const f=await fixture({writer:async(cmd,real)=>{if(mode==='write-then-throw'){await real(cmd);throw Error('lost ack');}if(mode==='throw-before')throw Error('connection');if(mode==='commit-unknown')return {ok:false,code:'commit_unknown'};if(mode==='false-other')return {ok:false,code:'other'};return {ok:true};}});
  assert.equal((await f.budget.reserve(f.req())).status,'held');assert.equal(f.budget.snapshot('p').slotsUsed,1);notGranted(await f.budget.reserve(f.req('b')));
});
test('explicit stale with a fresh no-write proof can withdraw process pending',async()=>{
  let reject=true;const f=await fixture({writer:(cmd,real)=>reject?{ok:false,code:'stale'}:real(cmd)});
  assert.notEqual((await f.budget.reserve(f.req())).status,'granted');assert.equal(f.budget.snapshot('p').slotsUsed,0);reject=false;await granted(f,'b');
});
test('markExternal persists once before a raw effect may begin; no replay',async()=>{
  const f=await fixture();const token=await granted(f);const mark=await f.budget.markExternal(token);assert.equal(mark.ok,true);
  assert.equal(f.store.getNode('p','a').hostBudgetReservation.effectStarted,true);assert.equal((await f.budget.markExternal(token)).ok,false);assert.equal((await f.budget.reserve(f.req())).status,'held');
});
test('bind associates an exact raw lease without mutating it, and exact repetition is idempotent',async()=>{
  const f=await fixture();const token=await granted(f);await f.budget.markExternal(token);const raw={brokerId:'sandbox-admission',leaseId:'raw',launchGeneration:'raw-generation'};const before=copy(raw);
  assert.equal((await f.budget.bind(token,raw)).ok,true);assert.deepEqual(raw,before);assert.equal((await f.budget.bind(token,raw)).ok,true);
  assert.equal((await f.budget.bind(token,{...raw,leaseId:'foreign'})).ok,false);assert.equal((await f.budget.verify(token)).bound.leaseId,'raw');
});
test('bind may attach the actual once-begun owner but never a different session',async()=>{
  const f=await fixture();const token=await granted(f);await f.patch('a',{currentAttempt:1,sessionId:'new-session'});
  assert.equal((await f.budget.bind(token,{brokerId:'sandbox-admission',leaseId:'raw',attempt:1,sessionId:'new-session'})).ok,true);
  assert.equal((await f.budget.bind(token,{brokerId:'sandbox-admission',leaseId:'raw',attempt:1,sessionId:'foreign'})).ok,false);
});
test('known before-raw rejection releases only after a durable clear; repeat is safe',async()=>{
  const f=await fixture();const token=await granted(f);assert.equal((await clear(f,token)).released,true);assert.equal(f.store.getNode('p','a').hostBudgetReservation,undefined);assert.equal(f.budget.snapshot('p').slotsUsed,0);assert.equal((await clear(f,token)).released,true);
});
test('effectStarted cannot be released by reason string or missing CID alone',async()=>{
  const f=await fixture();const token=await granted(f);await f.budget.markExternal(token);
  assert.equal((await clear(f,token,{kind:'no-effect',reason:'RAW_REJECTED_NO_EFFECT'})).released,false);assert.equal(f.budget.snapshot('p').slotsUsed,1);
  assert.equal((await clear(f,token,{kind:'no-effect',noEffectConfirmed:true,reason:'definite rejection'})).released,true);
});
test('queued raw cleanup does not release Host quota until durable claim/admission cleanup',async()=>{
  const f=await fixture();const token=await granted(f);await f.budget.markExternal(token);await f.budget.bind(token,{brokerId:'sandbox-admission',leaseId:'raw'});
  await f.patch('a',{claim:{decisionId:'d'},admission:{leaseId:'raw',resources:{gpu:1}},sandbox:binding()});
  assert.equal((await clear(f,token,{kind:'verified-clean',reason:'raw clean'})).released,false);notGranted(await f.budget.reserve(f.req('b')));
  await f.patch('a',{},['claim','admission']);assert.equal((await clear(f,token,{kind:'verified-clean',reason:'raw clean'})).released,true);await granted(f,'b');
});
for(const uncertainty of ['intent','unknown']) test('physical-clean '+uncertainty+' command retains logical budget',async()=>{
  const f=await fixture();const token=await granted(f);await f.patch('a',{status:'cancelled',sandbox:binding({operations:{older:{state:uncertainty},release:{state:'completed'}}})});
  assert.equal((await clear(f,token,{kind:'verified-clean',reason:'CID gone'})).released,false);assert.equal(f.budget.snapshot('p').slotsUsed,1);
});
test('durable clear barrier keeps process quota held until acknowledgement',async()=>{
  const gate=deferred();let block=false;const f=await fixture({writer:async(cmd,real)=>{if(block&&cmd.reservation===null)await gate.promise;return real(cmd);}});const token=await granted(f);block=true;
  const release=clear(f,token);notGranted(await f.budget.reserve(f.req('b')));gate.resolve();assert.equal((await release).released,true);await granted(f,'b');
});
test('rejected clear CAS preserves the exact old quota reservation',async()=>{
  const f=await fixture({writer:(cmd,real)=>cmd.reservation===null?{ok:false,code:'stale'}:real(cmd)});const token=await granted(f);
  assert.equal((await clear(f,token)).released,false);assert.equal(f.budget.snapshot('p').slotsUsed,1);notGranted(await f.budget.reserve(f.req('b')));
});
test('new Unknown during release acknowledgement cannot make quota disappear',async()=>{
  let f;f=await fixture({writer:async(cmd,real)=>{const r=await real(cmd);if(cmd.reservation===null)await f.patch('a',{sandbox:binding({operations:{x:{state:'unknown'}}})});return r;}});const token=await granted(f);
  assert.equal((await clear(f,token)).released,false);assert.equal(f.budget.snapshot('p').slotsUsed,1);notGranted(await f.budget.reserve(f.req('b')));
});
test('cold adopt requires exact persisted token and does not repeat external acquire',async()=>{
  const f=await fixture();const token=await granted(f);await f.budget.markExternal(token);const cold=f.make();const record=copy(f.store.getNode('p','a').hostBudgetReservation);
  assert.equal((await cold.adopt(record)).ok,true);assert.equal(cold.snapshot('p').slotsUsed,1);assert.equal((await cold.markExternal(token)).ok,false);assert.equal((await cold.reserve(f.req())).status,'held');
  assert.equal((await cold.adopt({...record,reservationId:'foreign'})).ok,false);
});
test('a released old token cannot clear or verify a later generation',async()=>{
  const f=await fixture();const old=await granted(f);assert.equal((await clear(f,old)).released,true);await f.patch('a',{currentAttempt:1,sessionId:'later-session'});const newer=await granted(f);
  assert.notEqual(newer.reservationId,old.reservationId);assert.equal((await clear(f,old)).released,false);assert.equal((await f.budget.verify(newer)).ok,true);
});
test('malformed occupied footprint fails closed, never coerces to zero capacity use',async()=>{
  const f=await fixture({nodes:[node('old',{status:'failed',resourcesHeld:{gpu:'bad'},lease:{leaseId:'x'}}),node('a')]});
  notGranted(await f.budget.reserve(f.req()));assert.ok(f.budget.snapshot('p').conflicts.length>0);
});
test('snapshot and methods never invoke a raw broker, Agent, SSH, LLM or GPU',async()=>{
  const f=await fixture();const token=await granted(f);const record=f.store.getNode('p','a').hostBudgetReservation;
  assert.ok(record.reservationId);assert.equal(record.projectId,'p');assert.equal(record.nodeId,'a');assert.equal(record.effectStarted,false);assert.equal(token.forAttempt,1);assert.equal((await f.budget.verify(token)).ok,true);
});

// Review the actual wrapper ordering: a pure Host grant is bound before compute.
test('pure Host bind may be followed by the one external-effect gate without invalidating its owner',async()=>{
  const f=await fixture();const token=await granted(f);const raw={brokerId:'sandbox-admission',leaseId:'raw',launchGeneration:'raw-generation'};
  assert.equal((await f.budget.bind(token,raw)).ok,true);assert.equal((await f.budget.markExternal(token)).ok,true);
  assert.equal((await f.budget.verify(token)).ok,true);assert.equal((await f.budget.markExternal(token)).ok,false);
  assert.equal((await clear(f,token,{kind:'no-effect',reason:'only-a-string'})).released,false);
});
test('same raw bound identity may confirm its once-begun session before markExternal',async()=>{
  const f=await fixture();const token=await granted(f);const raw={brokerId:'sandbox-admission',leaseId:'raw',launchGeneration:'raw-generation'};
  assert.equal((await f.budget.bind(token,raw)).ok,true);await f.patch('a',{currentAttempt:1,sessionId:'worker-new'});
  const owned={...raw,attempt:1,sessionId:'worker-new'};assert.equal((await f.budget.bind(token,owned)).ok,true);
  assert.equal((await f.budget.bind(token,owned)).ok,true);assert.equal((await f.budget.markExternal(token)).ok,true);
  assert.equal((await f.budget.bind(token,{...owned,sessionId:'foreign'})).ok,false);
});
test('cold bound record token keeps immutable identity across later mutable phase updates',async()=>{
  const f=await fixture();const token=await granted(f);await f.budget.bind(token,{brokerId:'sandbox-admission',leaseId:'raw'});
  const record=copy(f.store.getNode('p','a').hostBudgetReservation),cold=f.make();assert.equal((await cold.adopt(record)).ok,true);
  assert.equal((await cold.markExternal(record)).ok,true);assert.equal((await cold.verify(record)).ok,true);
  assert.equal((await cold.markExternal(record)).ok,false);
});
test('conflicting pinned same-node resource vectors are held instead of hidden by deduplication',async()=>{
  const f=await fixture({max:4});await granted(f);await f.patch('a',{admission:{leaseId:'other',resources:{gpu:2}}});
  assert.ok(f.budget.snapshot('p').conflicts.length>0);notGranted(await f.budget.reserve(f.req('b')));
});
test('adopt cannot replace a live busy write-ahead gate with an older exact record',async()=>{
  const gate=deferred();let block=false;const f=await fixture({writer:async(cmd,real)=>{if(block&&cmd.reservation?.effectStarted)await gate.promise;return real(cmd);}});
  const token=await granted(f),before=copy(f.store.getNode('p','a').hostBudgetReservation);block=true;
  const mark=f.budget.markExternal(token);assert.equal((await f.budget.adopt(before)).ok,false);
  assert.equal((await f.budget.markExternal(token)).ok,false);gate.resolve();assert.equal((await mark).ok,true);
});

test('an edited declared quantity cannot reuse or relabel an already pinned reservation',async()=>{
  const f=await fixture({max:4});const token=await granted(f);await f.patch('a',{needs:{gpu:2}});
  assert.equal((await f.budget.verify(token)).ok,false);
  assert.equal((await f.budget.markExternal(token)).ok,false);
  assert.equal((await f.budget.bind(token,{brokerId:'sandbox-admission',leaseId:'raw'})).ok,false);
  assert.equal((await clear(f,token)).released,false);assert.ok(f.budget.snapshot('p').conflicts.length>0);
  notGranted(await f.budget.reserve(f.req('b')));assert.equal(f.store.getNode('p','a').hostBudgetReservation.resources.gpu,1);
});

test('overdrawn quota after limit reduction freezes even a new CPU-zero grant without evicting its owner',async()=>{
  const f=await fixture({max:4,nodes:[node('a'),node('b',{needs:{},execution:{profile:'dsh',driver:'dsh'}})]});const token=await granted(f);const saved=copy(f.store.getNode('p','a').hostBudgetReservation);
  assert.equal((await f.kernel.executor.commit('p',{actor,mutations:[{op:'project.update',set:{config:{...f.store.getProject('p').config,resourcePools:{gpu:0}}}}]})).ok,true);
  notGranted(await f.budget.reserve(f.req('b','local-pool')));assert.deepEqual(f.store.getNode('p','a').hostBudgetReservation,saved);
  assert.equal((await f.budget.verify(token)).ok,true);
});
test('cold unclean binding GPU footprint cannot disappear behind CPU-zero declared needs',async()=>{
  const old=node('old',{needs:{}});old.status='failed';old.sandbox={backend:'opensandbox',profile:'pclab19',bindingId:'old-physical',state:'cleanupPending',verifiedClean:false,gpuCount:4};
  const f=await fixture({max:4,nodes:[old,node('a')]});assert.equal(f.budget.snapshot('p').quotaUsed.gpu,4);notGranted(await f.budget.reserve(f.req()));
});

test('an unavailable current-owner read is held and cannot erase persistent or process occupancy',async()=>{
  const f=await fixture();let unavailable=false;
  const budget=createHostBudget({readProject:p=>f.store.getProject(p),readNodes:p=>f.store.listNodes(p),readNode:(p,n)=>{if(unavailable)throw Error('read unavailable');return f.store.getNode(p,n);},commitReservation:f.real,clock:()=>1000});
  const r=await budget.reserve(f.req());assert.equal(r.status,'granted');const saved=copy(f.store.getNode('p','a').hostBudgetReservation);unavailable=true;
  assert.equal((await budget.verify(r.token)).ok,false);assert.equal((await budget.release(r.token,{kind:'no-effect'})).released,false);
  assert.equal((await budget.adopt(saved)).ok,false);assert.equal(budget.snapshot('p').slotsUsed,1);
  assert.deepEqual(f.store.getNode('p','a').hostBudgetReservation,saved);
});
