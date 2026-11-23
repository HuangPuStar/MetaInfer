import test from 'node:test';
import assert from 'node:assert/strict';
import * as execution from '../../host/execution.js';
import * as brokersModule from '../../host/dispatch/brokers.js';
import { capacityOf } from '../../host/kernel/capacity.js';
import { isRunnableNode, runnableSummary } from '../../host/kernel/runnable.js';
import { defaultRequestFor } from '../../host/dispatch/deterministic-strategy.js';
import { defaultBrokerIdFor, createDispatchOnce } from '../../host/dispatch/dispatch-once.js';
import { createDispatchEnvelope } from '../../host/dispatch/envelope.js';
import { dispatchRound } from '../../host/dispatch/round.js';
import { createKernel } from '../../host/kernel/instance.js';
import { openStore } from '../../host/store.js';
import { createLabService } from '../../host/lab-service.js';
import { createOrchestrator } from '../../host/orchestrator.js';
import { memoryDomain, storeContext } from '../../scripts/lib/memory-domain.mjs';

const state = await import('../../host/sandbox-state.js').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const REMOTE = { profile:'sandbox-pclab19',driver:'dsh',sandboxProfile:'pclab19' };
const CONFIG = {
  execution:{profiles:{dsh:{driver:'dsh'},codex:{driver:'codex'},'sandbox-pclab19':{driver:'dsh',sandboxProfile:'pclab19'}},taskTypes:{gpu:'sandbox-pclab19'}},
  resourcePools:{gpu:4},maxRunningNodes:4,maxNodes:100,nodeTimeoutMinutes:2,maxNodeTimeoutMinutes:5,
  advisor:{acceptMode:'confirm',maxPendingProposals:10},
};
const actor={kind:'dispatcher',id:'offline-test'};
const human={kind:'human',id:'offline-test'};
const copy=value=>structuredClone(value);
const sandboxNode=(extra={})=>({id:'n1',projectId:'p',status:'planned',needs:{gpu:1},execution:copy(REMOTE),rev:0,currentAttempt:0,sessionId:'session-initial',timeboxMs:120000,...extra});
const binding=(extra={})=>({backend:'opensandbox',profile:'pclab19',bindingId:'binding-test',attempt:1,sessionId:'session-initial',state:'createUnknown',verifiedClean:false,gpuCount:1,operations:{},...extra});
function required(fn,name) { assert.equal(typeof fn,'function',name+' must exist'); return fn; }
function newBroker(readNode,limits=()=>({maxRunningNodes:4,resourcePools:{gpu:4}})) {
  return required(brokersModule.createSandboxAdmissionBroker,'createSandboxAdmissionBroker')({readNode,limits,clock:()=>1000});
}
async function env({nodes=[],runtimeStart=null,roleOutputs={}}={}) {
  const domain=memoryDomain();
  const store=await openStore(storeContext(domain,{kernel:{eventArchiveRoot:'D:/file/DSH/MetaInfer/deployments/metainfer-v2-opensandbox-pclab19-20261114/evidence/v2-config-unused-mock-archive',hotEvents:100000}}));
  const kernel=createKernel({store,clock:()=>1000});
  const created=await kernel.executor.bootstrapProject('p',{
    id:'p',name:'offline',brief:'mock only',revision:0,counters:{eventSeq:0,nextNodeSeq:100,nodes:0,cycles:0},
    repo:{path:'mock-repo',worktreeRoot:'mock-worktree',baseBranch:'main',baseCommit:'base'},
    config:copy(CONFIG),controllerSessionId:'controller-test',mode:'manual',createdAt:1,updatedAt:1,
  },{actor:human,mutations:[{op:'event.record',type:'fixture/created',data:{}},...nodes.map(node=>({op:'node.create',node:copy(node)}))]});
  assert.equal(created.ok,true,JSON.stringify(created));
  kernel.load('p');
  store.setStrictWrites('throw');
  const controller={sessionId:'controller-test'};
  const roles=[];
  const ctx={effect(){},get(){return null;},logger:{info(){},warn(){}},
    agentDefaultModel:{currentSelection:()=>({provider:'mock',model:'no-inference'})},
    agents:{get:()=>controller},
    subagents:{async startActivation(options){
      const role=options.request.agentPreset.replace('lab-',''); roles.push(role);
      const output=roleOutputs[role]??(role==='scheduler'?{analysis:'mock',starts:[]}:{analysis:'mock',proposals:[]});
      return {sessionId:options.childId,result:Promise.resolve({stopReason:'completed',structured:copy(output)}),dispose:async()=>{}};
    }},
  };
  const git={validateRepo:async()=>({repoRoot:'mock-repo',gitDir:'mock-repo/.git',defaultBranch:'main'}),resolveBranch:async()=> 'base',commitWorktree:async()=>({head:'head-mock'}),tagCommit:async()=>{}};
  const runtime={start:runtimeStart??(async()=>({startOutcome:{status:'started',attempt:1,sessionId:'mock-session'}}))};
  const service=createLabService({ctx,store,kernel,git,runtime,transcript:null,orchestrator:null,auto:null,cluster:null,clusterAdmin:null});
  const orchestrator=createOrchestrator({ctx,store,kernel,git,runtime,cluster:null});
  return {store,kernel,service,orchestrator,roles,ctx,git};
}

// Profile validation/copying: no target list duplicated outside the catalog.
test('normalization retains the independent sandbox axis',()=>{
  assert.deepEqual(execution.normalizeExecutionProfile({driver:'dsh',sandboxProfile:'pclab19',model:'model',reasoningEffort:'high'}),{driver:'dsh',sandboxProfile:'pclab19',model:'model',reasoningEffort:'high'});
});
test('normalization accepts both reviewed sandbox targets',()=>{
  assert.deepEqual(execution.normalizeExecutionProfile({driver:'dsh',sandboxProfile:'pclab27'}),{driver:'dsh',sandboxProfile:'pclab27'});
});
for(const sandboxProfile of ['pclab',' pclab19 ','',null,1]) test('rejects invalid target '+JSON.stringify(sandboxProfile),()=>{
  assert.throws(()=>execution.normalizeExecutionProfile({driver:'dsh',sandboxProfile}),/sandbox|target/i);
});
test('codex plus sandbox and legacy backend shape are rejected',()=>{
  assert.throws(()=>execution.normalizeExecutionProfile({driver:'codex',sandboxProfile:'pclab19'}),/sandbox|dsh/i);
  assert.throws(()=>execution.normalizeExecutionProfile({backend:'opensandbox',profile:'pclab19'}),/backend|legacy|execution/i);
});
test('executionSnapshot is a fresh strict whitelist',()=>{
  const source={...REMOTE,model:'m',requestedProfile:'bad',profileFallback:true,taskType:'gpu',unknown:{x:1}};
  const snapshot=required(execution.executionSnapshot,'executionSnapshot')(source);
  assert.deepEqual(snapshot,{...REMOTE,model:'m'}); snapshot.model='different'; assert.equal(source.model,'m');
});
test('resolve preserves configured target and CPU inheritance',()=>{
  const project={config:CONFIG};
  assert.equal(execution.resolveExecutionProfile(project,{executionProfile:'sandbox-pclab19'}).sandboxProfile,'pclab19');
  const inherited=execution.resolveExecutionProfile(project,{inheritExecution:REMOTE});
  assert.equal(inherited.sandboxProfile,'pclab19');
});
test('sandbox inheritance rejects local selection and unknown suggestion fallback',()=>{
  for(const executionProfile of ['dsh','codex','default']) assert.throws(()=>execution.resolveExecutionProfile({config:CONFIG},{executionProfile,inheritExecution:REMOTE,fallbackToDefault:true}),/sandbox|inherit|isolation|profile/i);
});
test('ordinary local/codex and suggestion fallback remain compatible',()=>{
  assert.deepEqual(execution.normalizeExecutionProfile({driver:'codex',codexPath:'tool',reasoningEffort:'high'}),{driver:'codex',codexPath:'tool',reasoningEffort:'high'});
  assert.equal(execution.resolveExecutionProfile({config:CONFIG},{executionProfile:'default',fallbackToDefault:true}).profileFallback,true);
});

// One shared resource/admission interpretation; terminal UI states are untouched.
test('failed/cancelled/CPU unverified bindings still occupy capacity',()=>{
  const holds=required(state.holdsResources,'holdsResources');
  for(const status of ['failed','cancelled','planned']) for(const gpu of [0,1,4]) {
    const node=sandboxNode({status,needs:{gpu},sandbox:binding({gpuCount:gpu})});
    assert.equal(holds(node),true,status+'/'+gpu); assert.equal(node.status,status);
  }
});
test('a cleaned physical binding can retain an older exec Unknown admission block',()=>{
  const node=sandboxNode({status:'cancelled',sandbox:binding({state:'released',verifiedClean:true,operations:{oldExec:{state:'unknown'},newRelease:{state:'completed'}}})});
  assert.equal(required(state.holdsResources,'holdsResources')(node),false);
  assert.ok(required(state.sandboxAdmissionBlock,'sandboxAdmissionBlock')(node));
});
test('any unresolved operation and mismatched selection block admission',()=>{
  const block=required(state.sandboxAdmissionBlock,'sandboxAdmissionBlock');
  for(const opState of ['intent','unknown']) assert.ok(block(sandboxNode({sandbox:binding({state:'released',verifiedClean:true,operations:{older:{state:opState},latest:{state:'completed'}}})})));
  assert.ok(block(sandboxNode({execution:{profile:'dsh',driver:'dsh'},sandbox:binding({state:'released',verifiedClean:true})})));
  assert.equal(block(sandboxNode()),null);
});
test('kernel capacity includes terminal held demand and CPU slots',()=>{
  const nodes=[sandboxNode({status:'failed',resourcesHeld:{gpu:4},sandbox:binding({gpuCount:4})})];
  const capacity=capacityOf({config:{resourcePools:{gpu:4},maxRunningNodes:1}},nodes);
  assert.equal(capacity.free.gpu,0); assert.equal(capacity.canStart,false);
  assert.equal(capacity.runningCount,0,'do not rename failed to running');
  assert.equal(capacity.occupiedCount,1);
  const cpu=capacityOf({config:{resourcePools:{gpu:4},maxRunningNodes:1}},[sandboxNode({status:'cancelled',needs:{},sandbox:binding({gpuCount:0})})]);
  assert.equal(cpu.canStart,false);
});
test('runnable and summaries refuse unresolved sandbox states',()=>{
  const held=sandboxNode({sandbox:binding()});
  assert.equal(isRunnableNode(held,1000),false);
  assert.equal(runnableSummary([held],{now:1000}).held,1);
  const clean=sandboxNode({sandbox:binding({state:'queued',verifiedClean:true,operations:{}})});
  assert.equal(isRunnableNode(clean,1000),true);
});
test('sandbox request selects only the admission broker, not cluster or local',()=>{
  const request=defaultRequestFor('p',sandboxNode({placement:'fleet'}));
  assert.equal(request.sandboxProfile,'pclab19'); assert.deepEqual(request.execution,REMOTE);
  assert.equal(defaultBrokerIdFor(request),'sandbox-admission');
});

// Thin broker: immutable identity and local quota only, never a GPU allocator.
test('sandbox broker verifies exact grant and rejects tampering',async()=>{
  const node=sandboxNode(); const broker=newBroker(()=>copy(node));
  const grant=await broker.acquire(defaultRequestFor('p',node));
  assert.equal(grant.status,'granted'); assert.equal(grant.lease.broker,'sandbox-admission');
  assert.equal(grant.lease.profile,'pclab19'); assert.match(grant.lease.launchGeneration,/^[0-9a-f-]{36}$/);
  assert.equal(await broker.verify(grant.lease,{projectId:'p',nodeId:'n1'}),true);
  for(const change of [{nodeId:'n2'},{projectId:'q'},{profile:'pclab27'},{executionFingerprint:'tampered'},{launchGeneration:'forged'},{resources:{gpu:0}}]) {
    assert.equal(await broker.verify({...grant.lease,...change},{projectId:'p',nodeId:'n1'}),false,JSON.stringify(change));
  }
  grant.lease.resources.gpu=0;
  const again=await broker.acquire(defaultRequestFor('p',node)); assert.equal(again.lease.resources.gpu,1);
});
test('sandbox broker refuses profile drift and unknown orphan reclamation',async()=>{
  let node=sandboxNode(); const broker=newBroker(()=>copy(node));
  const {lease}=await broker.acquire(defaultRequestFor('p',node));
  node={...node,status:'failed',sandbox:binding(),admission:copy(lease),currentAttempt:1};
  assert.deepEqual(broker.releaseOrphans([copy(node)]),[]);
  assert.equal((await broker.release(lease.leaseId)).held,true); assert.equal(broker.size,1);
  node.execution={profile:'dsh',driver:'dsh'};
  assert.equal(await broker.verify(lease,{projectId:'p',nodeId:'n1'}),false);
});
test('sandbox broker quotas count whole requests and CPU slots',async()=>{
  const nodes=new Map([['n1',sandboxNode({needs:{gpu:4}})],['n2',sandboxNode({id:'n2'})]]);
  const broker=newBroker((_,id)=>copy(nodes.get(id)),()=>({maxRunningNodes:1,resourcePools:{gpu:4}}));
  assert.equal((await broker.acquire(defaultRequestFor('p',nodes.get('n1')))).status,'granted');
  assert.equal((await broker.acquire(defaultRequestFor('p',nodes.get('n2')))).status,'queued');
  assert.equal(broker.size,1);
});
test('cold broker adopts only its persisted matching admission and retains held',async()=>{
  let node=sandboxNode(); const first=newBroker(()=>copy(node));
  const {lease}=await first.acquire(defaultRequestFor('p',node));
  node={...node,status:'failed',currentAttempt:1,admission:copy(lease),sandbox:binding()};
  const cold=newBroker(()=>copy(node)); cold.adopt(copy(lease)); assert.equal(cold.size,1);
  assert.equal((await cold.release(lease.leaseId)).held,true);
  assert.throws(()=>cold.adopt({...lease,launchGeneration:'forged'}),/admission|lease|identity/i);
});

async function dispatchEnv({outcome,throws=false}={}) {
  const e=await env({nodes:[sandboxNode()]});
  const local=newBroker((_,id)=>copy(e.store.getNode('p',id)));
  const brokers=new Map([['sandbox-admission',local]]);
  let calls=0;
  const launcher={async start(projectId,nodeId,{lease}){
    calls++;
    if(throws) {
      await e.kernel.executor.commit('p',{actor:human,mutations:[{op:'node.update',nodeId,set:{sandbox:binding(),admission:copy(lease)}}]});
      throw Error('transport interrupted after durable intent');
    }
    if(outcome?.status==='queued' && outcome.code==='NO_CAPACITY' && outcome.verifiedClean===true) await e.kernel.executor.commit('p',{actor:human,mutations:[{op:'node.update',nodeId,set:{currentAttempt:lease.forAttempt,sessionId:outcome.sessionId,admission:copy(lease),sandbox:binding({state:'queued',verifiedClean:true,attempt:lease.forAttempt,sessionId:outcome.sessionId})}}]});
    if(outcome?.status==='started') await e.kernel.executor.commit('p',{actor:human,mutations:[{op:'node.transition',nodeId,to:'running',set:{currentAttempt:lease.forAttempt,sessionId:outcome.sessionId,resourcesHeld:{gpu:1},admission:copy(lease),sandbox:binding({state:'ready',attempt:lease.forAttempt,sessionId:outcome.sessionId})}}]});
    return outcome===undefined?{}:{node:copy(e.store.getNode('p',nodeId)),revision:e.store.getProject('p').revision,startOutcome:copy(outcome)};
  }};
  const once=createDispatchOnce({projectId:'p',executor:e.kernel.executor,projection:e.kernel.projection,brokers,launcher,clock:()=>1000});
  return {...e,local,brokers,once,calls:()=>calls};
}
test('typed started is counted once',async()=>{
  const e=await dispatchEnv({outcome:{status:'started',attempt:1,sessionId:'s'}});
  const r=await e.once.run(); assert.equal(r.started,1); assert.deepEqual(r.startedNodeIds,['n1']); assert.equal(e.calls(),1);
});
test('typed clean NO_CAPACITY is queued, not a start or failed launch',async()=>{
  const e=await dispatchEnv({outcome:{status:'queued',code:'NO_CAPACITY',verifiedClean:true,attempt:1,sessionId:'s',retryAfter:6000}});
  const r=await e.once.run(); assert.equal(r.started,0); assert.equal(r.skipped.at(-1).status,'queued');
  const node=e.store.getNode('p','n1'); assert.equal(node.claim,undefined); assert.equal(node.dispatchFailures,undefined); assert.equal(node.dispatchHold,undefined); assert.equal(e.local.size,0);
});
for(const outcome of [{status:'held',code:'CREATE_UNKNOWN',retryable:false,attempt:1,sessionId:'s'},undefined,{status:'queued',verifiedClean:false},{status:'queued',code:'other',verifiedClean:true}]) test('held or invalid sandbox outcome is never released/started '+JSON.stringify(outcome),async()=>{
  const e=await dispatchEnv({outcome}); const r=await e.once.run();
  assert.equal(r.started,0); assert.equal(r.skipped.at(-1).status,'held'); assert.equal(e.local.size,1); assert.ok(e.store.getNode('p','n1').claim);
  assert.equal(e.store.getNode('p','n1').dispatchFailures,undefined);
});
test('throw after sandbox intent retains lease and identity without generic backoff',async()=>{
  const e=await dispatchEnv({throws:true}); const r=await e.once.run(); assert.equal(r.started,0); assert.equal(e.local.size,1);
  assert.ok(e.store.getNode('p','n1').claim); assert.equal(e.store.getNode('p','n1').dispatchFailures,undefined);
});
test('round consumes queued/held outcomes rather than ok alone',async()=>{
  for(const status of ['queued','held']) {
    const result=await dispatchRound({projectId:'p',candidates:[sandboxNode()],requestFor:defaultRequestFor,brokerFor:()=>({acquire:async()=>({status:'granted',lease:{leaseId:'x',broker:'sandbox-admission'}})}),submit:async()=>({ok:true,startOutcome:{status}})});
    assert.equal(result.started,0); assert.equal(result.skipped[0].status,status);
  }
});
test('sandbox preemption is rejected before launcher callback',async()=>{
  const e=await env({nodes:[sandboxNode({status:'running'})]}); let called=false;
  const envelope=createDispatchEnvelope({projectId:'p',executor:e.kernel.executor,projection:e.kernel.projection,brokers:new Map(),launcher:{preempt:async()=>{called=true;}},policy:{authorize:()=>({ok:true})}});
  const result=await envelope.submit(human,{kind:'preempt',victimNodeId:'n1',forNodeId:'n2',basis:0,reason:'mock'});
  assert.equal(result.ok,false); assert.equal(called,false);
});

test('actual project root and node edit preserve sandbox snapshot',async()=>{
  const e=await env();
  const result=await e.service.createProject({name:'pure mock',brief:'pure mock profile test',repoPath:'mock-repo',initialPrompt:'No execution in this mock fixture.',executionProfile:'sandbox-pclab19',config:copy(CONFIG)});
  const id=result.project.id; assert.deepEqual(result.rootNode.execution,REMOTE);
  const edited=await e.service.updateNode(id,result.rootNode.id,{executionProfile:'sandbox-pclab19'}); assert.deepEqual(edited.node.execution,REMOTE);
});
test('legacy project execution.backend is rejected rather than becoming local',async()=>{
  const e=await env(); await assert.rejects(()=>e.service.createProject({name:'bad',brief:'pure mock',repoPath:'mock',initialPrompt:'No execution in this mock fixture.',config:{execution:{backend:'opensandbox',profile:'pclab19'}}}),/backend|legacy|execution/i);
});
for(const busy of [
  {status:'running'},
  {claim:{decisionId:'existing'}},
  {admission:{leaseId:'reserved'}},
  {sandbox:binding()},
]) test('execution target edit is atomic while busy '+JSON.stringify(busy),async()=>{
  const e=await env({nodes:[sandboxNode(busy)]}); const before=copy(e.store.getProject('p')); const beforeNode=copy(e.store.getNode('p','n1'));
  await assert.rejects(()=>e.service.updateProject('p',{name:'must-not-leak',config:{execution:{profiles:{'sandbox-pclab19':{driver:'dsh'}}}}}),/execution|target|sandbox|use/i);
  assert.deepEqual(e.store.getProject('p'),before); assert.deepEqual(e.store.getNode('p','n1'),beforeNode);
});
test('claimed/unknown node profile edit cannot mutate cache before rejection',async()=>{
  const e=await env({nodes:[sandboxNode({claim:{decisionId:'existing'},sandbox:binding()})]}); const before=copy(e.store.getNode('p','n1'));
  await assert.rejects(()=>e.service.updateNode('p','n1',{title:'must-not-leak',executionProfile:'dsh'}),/execution|target|sandbox|inherit|use/i);
  assert.deepEqual(e.store.getNode('p','n1'),before);
});
test('CPU successor inherits remote and explicit local successor is rejected',async()=>{
  const parent=sandboxNode({status:'completed',git:{headCommit:'head',branch:'mock',worktreePath:'mock'},timestamps:{createdAt:1,sealedAt:1},sandbox:binding({state:'released',verifiedClean:true})});
  const e=await env({nodes:[parent]});
  const result=await e.orchestrator.createSuccessor('p','n1',{title:'CPU child',prompt:'No execution in this mock fixture.',needs:{}});
  assert.deepEqual(result.node.execution,REMOTE); assert.deepEqual(result.node.needs,{});
  const e2=await env({nodes:[parent]});
  await assert.rejects(()=>e2.orchestrator.createSuccessor('p','n1',{title:'unsafe',prompt:'No execution in this mock fixture.',executionProfile:'dsh'}),/sandbox|inherit|isolation/i);
});
test('sandbox parent merge is unsupported even if requested local',async()=>{
  const a=sandboxNode({status:'completed',git:{headCommit:'head-a'}}); const b={...copy(a),id:'n2'};
  const e=await env({nodes:[a,b]}); await assert.rejects(()=>e.orchestrator.createMergeNode('p',{parentIds:['n1','n2'],executionProfile:'dsh'}),/sandbox|unsupported|support/i);
});
for(const status of ['queued','held','started']) test('actual mocked Step counts only typed started: '+status,async()=>{
  const node=sandboxNode(); const startOutcome={status,attempt:1,sessionId:'mock',...(status==='queued'?{code:'NO_CAPACITY',verifiedClean:true}:status==='held'?{retryable:false}: {})};
  let e;
  e=await env({nodes:[node],runtimeStart:async()=>{
    const set={currentAttempt:1,sessionId:'mock',sandbox:binding({state:status==='started'?'ready':'queued',verifiedClean:status==='queued',sessionId:'mock'})};
    await e.kernel.executor.commit('p',{actor:human,mutations:[status==='started'?{op:'node.transition',nodeId:'n1',to:'running',set}:{op:'node.update',nodeId:'n1',set}]});
    return {node:copy(e.store.getNode('p','n1')),startOutcome};
  },roleOutputs:{scheduler:{analysis:'mock',starts:[{nodeId:'n1',reason:'mock'}]}}});
  const result=await e.orchestrator.step('p','offline-test');
  assert.deepEqual(result.started,status==='started'?['n1']:[]); assert.deepEqual(e.roles,['scheduler']);
});
for(const acceptMode of ['confirm','auto']) test('actual mocked advisor '+acceptMode+' propagates isolated proposal/child',async()=>{
  const parent=sandboxNode({status:'completed',git:{headCommit:'head',branch:'mock',worktreePath:'mock'},timestamps:{createdAt:1,sealedAt:1}});
  const e=await env({nodes:[parent],roleOutputs:{advisor:{analysis:'mock',proposals:[{parentId:'n1',title:'isolated child',prompt:'No execution in this mock fixture.',needs:[],timeboxMinutes:1,decision:'propose'}]}}});
  await e.kernel.executor.commit('p',{actor:human,mutations:[{op:'project.update',set:{config:{...copy(CONFIG),advisor:{...CONFIG.advisor,acceptMode}}}}]});
  await e.orchestrator.step('p','offline-test');
  const children=e.store.listNodes('p').filter(n=>n.parentId==='n1');
  assert.equal(children.length,1); assert.deepEqual(children[0].execution,REMOTE);
});


// Review cases: malformed persisted state, cold admission generations and clocks.
test('preflight STOP gate holds admission without inventing physical GPU use',()=>{
  const gate={profile:'pclab19',code:'STOP',blockers:['operator STOP'],at:1000,retryable:false};
  const node=sandboxNode({needs:{gpu:4},sandboxGate:gate,admission:{broker:'sandbox-admission'}});
  assert.equal(state.holdsResources(node),false); assert.ok(state.sandboxAdmissionBlock(node));
  const capacity=capacityOf({config:CONFIG},[node]); assert.equal(capacity.held.gpu,undefined); assert.equal(capacity.occupiedCount,0);
  assert.equal(isRunnableNode(node,1000),false);
});
test('malformed stored target and orphan gate fail closed, not local',()=>{
  for(const sandboxProfile of [null,'pclab99',1]) assert.ok(state.sandboxAdmissionBlock(sandboxNode({execution:{profile:'bad',driver:'dsh',sandboxProfile}})));
  assert.ok(state.sandboxAdmissionBlock({id:'local-looking',sandboxGate:{profile:'pclab19',code:'STOP',blockers:[],at:1000,retryable:false}}));
});
test('legacy persisted execution.backend is rejected by the resolver',()=>{
  assert.throws(()=>execution.resolveExecutionProfile({config:{execution:{backend:'opensandbox',profile:'pclab19'}}}),/backend|legacy|execution/i);
});
test('wrong-level sandbox execution shape cannot silently create local nodes',async()=>{
  const e=await env();
  await assert.rejects(e.service.createProject({name:'bad',repoPath:'mock',brief:'mock only',initialPrompt:'a long enough prompt',config:{execution:{driver:'dsh',sandboxProfile:'pclab19'}}}),/execution|profiles|sandbox/i);
});
test('broker prospective permit survives only its exact persisted beginAttempt generation',async()=>{
  let node=sandboxNode(); const broker=newBroker(()=>copy(node));
  const {lease}=await broker.acquire(defaultRequestFor('p',node));
  node={...node,currentAttempt:lease.forAttempt,admission:copy(lease),sessionId:'new-session',status:'running',sandbox:binding({state:'ready',sessionId:'new-session'})};
  assert.equal(await broker.verify(lease,{projectId:'p',nodeId:'n1'}),true);
  node.admission.launchGeneration='other'; assert.equal(await broker.verify(lease,{projectId:'p',nodeId:'n1'}),false);
  assert.equal((await broker.release(lease.leaseId)).held,true); assert.equal(broker.size,1);
});
test('two clean capacity waits use new prospective permits before eventual admission',async()=>{
  let node=sandboxNode(); const broker=newBroker(()=>copy(node)); const ids=[]; const generations=[];
  for(let i=1;i<=3;i++) {
    const result=await broker.acquire(defaultRequestFor('p',node)); assert.equal(result.status,'granted');
    const lease=result.lease; ids.push(lease.leaseId); generations.push(lease.launchGeneration); assert.equal(lease.forAttempt,i);
    node={...node,currentAttempt:i,admission:copy(lease),sessionId:'session-'+i,status:i===3?'running':'planned',sandbox:binding({attempt:i,sessionId:'session-'+i,state:i===3?'ready':'queued',verifiedClean:i!==3})};
    assert.equal(await broker.verify(lease,{projectId:'p',nodeId:'n1'}),true);
    if(i!==3) { assert.equal((await broker.release(lease.leaseId)).released,true); delete node.admission; }
  }
  assert.equal(new Set(ids).size,3); assert.equal(new Set(generations).size,3); assert.equal(broker.size,1);
});
test('missing node after acquire is held and cannot be reclaimed as an orphan',async()=>{
  let node=sandboxNode(); const broker=newBroker(()=>node&&copy(node)); const {lease}=await broker.acquire(defaultRequestFor('p',node));
  node=null; assert.deepEqual(broker.releaseOrphans([]),[]); assert.equal((await broker.release(lease.leaseId)).held,true); assert.equal(broker.size,1);
});
test('completed release cannot reclaim a permit with older command Unknown',async()=>{
  let node=sandboxNode(); const broker=newBroker(()=>copy(node)); const {lease}=await broker.acquire(defaultRequestFor('p',node));
  node={...node,status:'cancelled',currentAttempt:1,admission:copy(lease),sandbox:binding({state:'released',verifiedClean:true,operations:{exec:{state:'unknown'},release:{state:'completed'}}})};
  assert.equal(state.holdsResources(node),false); assert.equal((await broker.release(lease.leaseId)).held,true); assert.deepEqual(broker.releaseOrphans([]),[]);
});
test('typed outcomes cannot attribute a foreign attempt/session as started or clean queue',async()=>{
  const {startOutcomeOf}=await import('../../host/dispatch/types.js');
  const current=sandboxNode({currentAttempt:2,sessionId:'current'});
  for(const status of ['started','queued']) {
    const startOutcome={status,attempt:1,sessionId:'old',code:'NO_CAPACITY',verifiedClean:true};
    assert.equal(startOutcomeOf({node:copy(current),startOutcome},current).status,'held');
  }
});
test('held orphan sweep cannot mutate stored binding',async()=>{
  const e=await dispatchEnv({outcome:{status:'held',code:'WAIT',attempt:1,sessionId:'s'}});
  const r=await e.once.run(); assert.equal(r.started,0);
  const old=copy(e.store.getNode('p','n1'));
  const before=copy(old.sandbox); e.local.releaseOrphans([]);
  assert.deepEqual(e.store.getNode('p','n1').sandbox,before); assert.equal(e.local.size,1);
});

test('delayed clean queue callback cannot release or overwrite a newer admission generation',async()=>{
  const e=await env({nodes:[sandboxNode()]}); const broker=newBroker((_,id)=>copy(e.store.getNode('p',id)));
  let enter,finish,oldLease;
  const entered=new Promise(resolve=>{enter=resolve;}); const barrier=new Promise(resolve=>{finish=resolve;});
  const once=createDispatchOnce({projectId:'p',executor:e.kernel.executor,projection:e.kernel.projection,brokers:new Map([['sandbox-admission',broker]]),clock:()=>1000,launcher:{async start(pid,nid,{lease}){
    oldLease=copy(lease); enter(); await barrier;
    return {startOutcome:{status:'queued',code:'NO_CAPACITY',verifiedClean:true,attempt:1,sessionId:'old'}};
  }}});
  const pending=once.run(); await entered;
  await e.kernel.executor.commit('p',{actor:human,mutations:[{op:'node.update',nodeId:'n1',set:{currentAttempt:2,sessionId:'new',admission:{...oldLease,leaseId:'new-lease',launchGeneration:'new-generation',forAttempt:2}}}]});
  const before=copy(e.store.getNode('p','n1')); finish();
  const result=await pending; assert.equal(result.started,0); assert.deepEqual(e.store.getNode('p','n1'),before); assert.equal(broker.size,1);
});


// S2-resume: the original compute boundary cannot disappear after await.
test('original sandbox context forbids missing/fresh-local legacy started fallback',async()=>{
  const {startOutcomeOf}=await import('../../host/dispatch/types.js');
  const original=sandboxNode();
  for(const fresh of [undefined,{...sandboxNode(),execution:{profile:'dsh',driver:'dsh'}}]) {
    for(const result of [{},{startOutcome:{status:'started',attempt:1,sessionId:'s'}},{startOutcome:{status:'queued',attempt:1,sessionId:'s',code:'NO_CAPACITY',verifiedClean:true}}]) {
      assert.equal(startOutcomeOf(result,fresh,original).status,'held');
    }
  }
  assert.equal(startOutcomeOf({}, {id:'local',execution:{profile:'dsh',driver:'dsh'}}).status,'started');
});
for(const loss of ['missing','local']) test('sandbox envelope pins its original context after fresh node becomes '+loss,async()=>{
  const e=await env({nodes:[sandboxNode()]}); const broker=newBroker((_,id)=>copy(e.store.getNode('p',id))); let hidden=false;
  const projection={...e.kernel.projection,getNode:(pid,nid)=>hidden?undefined:e.kernel.projection.getNode(pid,nid)};
  const once=createDispatchOnce({projectId:'p',executor:e.kernel.executor,projection,brokers:new Map([['sandbox-admission',broker]]),clock:()=>1000,launcher:{async start(){
    if(loss==='missing') hidden=true;
    else await e.kernel.executor.commit('p',{actor:human,mutations:[{op:'node.update',nodeId:'n1',set:{execution:{profile:'dsh',driver:'dsh'}}}]});
    return {};
  }}});
  const result=await once.run(); assert.equal(result.started,0); assert.equal(result.skipped.at(-1).status,'held'); assert.equal(broker.size,1);
});
test('mock Step retains original sandbox context if fresh node disappears',async()=>{
  let e; e=await env({nodes:[sandboxNode()],runtimeStart:async()=>{
    const get=e.store.getNode; e.store.getNode=(pid,nid)=>nid==='n1'?undefined:get(pid,nid); return {};
  },roleOutputs:{scheduler:{analysis:'mock',starts:[{nodeId:'n1',reason:'mock'}]}}});
  const result=await e.orchestrator.step('p','resume-mock'); assert.deepEqual(result.started,[]);
});
test('public runnable reason and runnable predicate share sandbox/gate blocking',async()=>{
  const {runnableBlockReason}=await import('../../host/kernel/runnable.js');
  for(const node of [sandboxNode({sandbox:binding()}),sandboxNode({sandboxGate:{profile:'pclab19',code:'STOP',blockers:[],at:1000,retryable:false}})]) {
    assert.notEqual(runnableBlockReason(node,1000),null); assert.equal(isRunnableNode(node,1000),false);
  }
});
async function releasedAdmission() {
  let node=sandboxNode(); const broker=newBroker(()=>copy(node)); const {lease}=await broker.acquire(defaultRequestFor('p',node));
  node={...node,currentAttempt:lease.forAttempt,sessionId:'released-session',status:'cancelled',admission:copy(lease),sandbox:binding({state:'released',verifiedClean:true,cancelRequested:false,sessionId:'released-session'})};
  return {broker,lease,get:()=>copy(node),set:value=>{node=copy(value);}};
}
test('proved same-lease release is idempotent before and after admission metadata cleanup',async()=>{
  const e=await releasedAdmission(); assert.equal((await e.broker.release(e.lease.leaseId)).released,true);
  assert.equal((await e.broker.release(e.lease.leaseId)).released,true);
  const node=e.get(); delete node.admission; e.set(node);
  assert.equal((await e.broker.release(e.lease.leaseId)).released,true); assert.equal(e.broker.size,0);
});
test('never-seen lease remains held across repeated release calls',async()=>{
  const broker=newBroker(()=>sandboxNode());
  assert.equal((await broker.release('unknown-lease')).held,true); assert.equal((await broker.release('unknown-lease')).held,true);
});
test('release proof never crosses attempt, session, target, Unknown or new admission generation',async()=>{
  for(const change of ['attempt','session','target','unknown','new-admission']) {
    const e=await releasedAdmission(); assert.equal((await e.broker.release(e.lease.leaseId)).released,true);
    const node=e.get();
    if(change==='attempt') node.currentAttempt++;
    if(change==='session') node.sessionId='different-session';
    if(change==='target') node.execution={profile:'dsh',driver:'dsh'};
    if(change==='unknown') node.sandbox.operations.exec={state:'unknown'};
    if(change==='new-admission') node.admission={...node.admission,launchGeneration:'different-generation'};
    e.set(node); assert.equal((await e.broker.release(e.lease.leaseId)).held,true,change);
  }
});
test('concurrent duplicate release of clean cancellation never leaks a slot',async()=>{
  const e=await releasedAdmission(); const results=await Promise.all([e.broker.release(e.lease.leaseId),e.broker.release(e.lease.leaseId)]);
  assert.equal(results.every(r=>r.released===true),true); assert.equal(e.broker.size,0);
});
test('pre-attempt released permit is idempotent but cannot release a replacement permit',async()=>{
  let node=sandboxNode(); const broker=newBroker(()=>copy(node)); const req=defaultRequestFor('p',node); const first=await broker.acquire(req);
  assert.equal((await broker.release(first.lease.leaseId)).released,true); assert.equal((await broker.release(first.lease.leaseId)).released,true);
  const second=await broker.acquire(req); assert.notEqual(second.lease.leaseId,first.lease.leaseId);
  assert.equal((await broker.release(first.lease.leaseId)).held,true); assert.equal(broker.size,1);
});
async function queuedCancellationRace(mode) {
  const e=await env({nodes:[sandboxNode()]}); const broker=newBroker((_,id)=>copy(e.store.getNode('p',id)));
  let snapshot,lease,releaseCalls=0;
  async function cancel() {
    const current=copy(e.store.getNode('p','n1'));
    current.sandbox.cancelRequested=false;
    if(mode.includes('unknown')) current.sandbox.operations.exec={state:'unknown'};
    await e.kernel.executor.commit('p',{actor:human,mutations:[{op:'node.transition',nodeId:'n1',to:'cancelled',set:{sandbox:current.sandbox}}]});
    snapshot=copy(e.store.getNode('p','n1'));
  }
  const wrapper={...broker,async release(id){
    releaseCalls++;
    if(mode==='clean-before' || mode==='unknown-before') await cancel();
    const proof=await broker.release(id);
    if(mode==='unknown-after') await cancel();
    return proof;
  }};
  const once=createDispatchOnce({projectId:'p',executor:e.kernel.executor,projection:e.kernel.projection,brokers:new Map([['sandbox-admission',wrapper]]),clock:()=>1000,launcher:{async start(pid,nid,options){
    lease=copy(options.lease);
    await e.kernel.executor.commit('p',{actor:human,mutations:[{
      op:'node.update',nodeId:nid,set:{currentAttempt:lease.forAttempt,sessionId:'queued-session',
        sandbox:binding({state:'released',verifiedClean:true,sessionId:'queued-session',
          operations:{acquire:{state:'completed'},release:{state:'completed'}}})}
    }]});
    return {startOutcome:{status:'queued',attempt:lease.forAttempt,sessionId:'queued-session',code:'NO_CAPACITY',verifiedClean:true}};
  }}});
  const result=await once.run(); return {e,broker,result,snapshot,lease,releaseCalls};
}
test('clean NO_CAPACITY releases exactly once in envelope, not runtime',async()=>{
  const r=await queuedCancellationRace('none'); assert.equal(r.releaseCalls,1); assert.equal(r.result.started,0); assert.equal(r.broker.size,0);
  assert.equal(r.e.store.getNode('p','n1').claim,undefined); assert.equal(r.e.store.getNode('p','n1').admission,undefined);
});
for(const mode of ['clean-before','unknown-before','unknown-after']) test('queued/cancel competition preserves terminal lifecycle ownership: '+mode,async()=>{
  const r=await queuedCancellationRace(mode);
  assert.equal(r.result.started,0); assert.deepEqual(r.e.store.getNode('p','n1'),r.snapshot,'late queued callback must not clear terminal claim/admission or add holds');
  if(mode==='clean-before') { assert.equal((await r.broker.release(r.lease.leaseId)).released,true); assert.equal(r.broker.size,0); }
  else { assert.equal((await r.broker.release(r.lease.leaseId)).held,true); assert.equal(r.broker.size,1); }
});


test('rejected queued cleanup CAS keeps the exact admission and soft permit held',async()=>{
  const e=await env({nodes:[sandboxNode()]}); const broker=newBroker((_,id)=>copy(e.store.getNode('p',id))); let pinned;
  const executor={...e.kernel.executor,async commit(pid,spec){
    if(spec.mutations?.some(m=>m.eventType==='dispatch/queued')) {
      await e.kernel.executor.commit(pid,{actor:human,mutations:[{op:'node.update',nodeId:'n1',set:{title:'concurrent harmless edit'}}]});
      pinned=copy(e.store.getNode('p','n1'));
    }
    return e.kernel.executor.commit(pid,spec);
  }};
  const once=createDispatchOnce({projectId:'p',executor,projection:e.kernel.projection,brokers:new Map([['sandbox-admission',broker]]),clock:()=>1000,launcher:{async start(pid,nid,{lease}){
    await e.kernel.executor.commit(pid,{actor:human,mutations:[{op:'node.update',nodeId:nid,set:{currentAttempt:lease.forAttempt,sessionId:'queued-session',sandbox:binding({state:'released',verifiedClean:true,sessionId:'queued-session',operations:{acquire:{state:'completed'},release:{state:'completed'}}})}}]});
    return {startOutcome:{status:'queued',attempt:lease.forAttempt,sessionId:'queued-session',code:'NO_CAPACITY',verifiedClean:true}};
  }}});
  const result=await once.run(); const current=e.store.getNode('p','n1');
  assert.equal(result.started,0); assert.deepEqual(current.admission,pinned.admission); assert.deepEqual(current.claim,pinned.claim);
  assert.equal(broker.size,1); assert.equal((await broker.release(pinned.admission.leaseId)).held,true);
});
