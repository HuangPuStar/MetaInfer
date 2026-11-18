/** Common manual/dispatch admission: logical Host budget, never physical GPU truth. */
import { isDeepStrictEqual as equal } from 'node:util';
import { createDispatchEnvelope } from './envelope.js';
import { defaultRequestFor } from './deterministic-strategy.js';
import { sandboxAdmissionBlock } from '../sandbox-state.js';
const copy=structuredClone;
export function createHostAdmission({store,kernel,budget,brokersFor,start,clock=Date.now}) {
 const inflight=new Set(),effects=new Set();let pumping=false;
 const key=(p,n)=>p+'\0'+n;
 const read=(p,n)=>{const value=store.getNode(p,n);return value?copy(value):null;};
 const project=p=>{const value=store.getProject(p);return value?copy(value):null;};
 const outcome=(p,n,code)=>({node:read(p,n),revision:project(p)?.revision,startOutcome:{status:'held',retryable:false,code}});
 function brokerIdFor(req,brokers){return req.sandboxProfile!==undefined?'sandbox-admission':req.placement==='fleet'||(Number(req.amount)>0&&brokers.has('cluster'))?'cluster':'local-pool';}
 async function wait(p,n,code){
  await store.withProjectLock(p,async()=>{const node=read(p,n),pr=project(p);if(!node||node.status!=='planned'||node.claim||node.admission||node.hostBudgetReservation||sandboxAdmissionBlock(node))return;
   await store.withWritePermit(()=>kernel.executor.commitLocked(p,{actor:{kind:'system',id:'host-admission'},expectedProjectRevision:pr.revision,mutations:[{op:'node.update',nodeId:n,basis:node.rev??0,set:{resourceWait:{backend:'host-budget',code,since:node.resourceWait?.since??clock(),retryAfter:clock()+5000}},eventType:'node/host_budget_wait'}]}));
  });
 }
 async function request(p,n,opts={}){
  const id=key(p,n);if(inflight.has(id))return outcome(p,n,'ADMISSION_IN_PROGRESS');inflight.add(id);
  try{
   const node=read(p,n);if(!node||node.status!=='planned')return outcome(p,n,'NODE_NOT_PLANNED');
   kernel.load(p); // Idempotent: projects created after apply are not yet projected.
   const brokers=await brokersFor(p),req=defaultRequestFor(p,node),broker=brokers.get(brokerIdFor(req,brokers));
   if(!broker)return outcome(p,n,'BROKER_UNAVAILABLE');
   // A clean reservation can belong to another lane after a conservative CAS hold.
   for (const candidate of brokers.values()) await candidate.releaseOrphans?.();
   const answer=await broker.acquire(req);
   if(answer.status!=='granted'){if(answer.status==='queued')await wait(p,n,answer.reason??answer.code??'HOST_QUOTA');return outcome(p,n,answer.reason??answer.code??'HOST_BUDGET_HELD');}
   // reserve/bind write Node revisions. Never submit the pre-acquire basis.
   const fresh=read(p,n);
   const envelope=createDispatchEnvelope({projectId:p,executor:kernel.executor,projection:kernel.projection,brokers,clock,launcher:{start:(pid,nid,granted)=>start(pid,nid,{...opts,...granted})}});
   const result=await envelope.submit({kind:'system',id:'host-admission'}, {kind:'start',nodeId:n,lease:answer.lease,basis:fresh?.rev??0,reason:'common Host admission'});
   return {node:read(p,n),revision:project(p)?.revision,startOutcome:result.startOutcome??{status:'held',retryable:false,code:result.code??'ADMISSION_UNCONFIRMED'}};
  }finally{inflight.delete(id);}
 }
 async function owner(p,n,lease){
  const node=read(p,n),brokers=await brokersFor(p),broker=brokers.get(lease?.broker??node?.hostBudgetReservation?.bound?.brokerId);
  const record=node?.hostBudgetReservation,id=lease?.leaseId??record?.bound?.leaseId,token=broker?.tokenFor?.(id);
  if(!node||!record||!broker||!token||token.reservationId!==record.reservationId||record.bound?.leaseId!==id||record.bound?.brokerId!==broker.id)return null;
  const raw=lease??broker.snapshot?.().find(x=>x.leaseId===id);
  if(raw&&(raw.projectId!==p||raw.nodeId!==n))return null;
  return {node,record,broker,token,id,raw};
 }
 async function verify(pr,snapshot,lease,decisionId){
  const own=await owner(pr?.id,snapshot?.id,lease);if(!own)return false;
  const {node,record,broker,token}=own;
  if(node.currentAttempt!==snapshot.currentAttempt||node.sessionId!==snapshot.sessionId||!equal(node.execution,snapshot.execution))return false;
  if(node.status==='planned'){
   if((node.currentAttempt??0)!==token.baseAttempt||node.claim?.decisionId!==decisionId||node.claim?.leaseId!==lease.leaseId||node.claim?.broker!==broker.id)return false;
  }else if(node.status==='running'){
   if(node.currentAttempt!==token.forAttempt||record.bound?.attempt!==node.currentAttempt||record.bound.sessionId!==node.sessionId)return false;
  }else return false;
  return await broker.verify(lease,{projectId:node.projectId,nodeId:node.id})===true;
 }
 async function beforeEffects(p,n,lease){
  const own=await owner(p,n,lease);if(!own)return {ok:false,held:true,code:'HOST_OWNER_UNCONFIRMED'};
  const {node,record,broker,token}=own,id=token.reservationId;
  const knownRaw=broker.snapshot?.().find(row=>row.leaseId===lease?.leaseId);
   const block=sandboxAdmissionBlock(node);
   const ownPending=block==='sandbox_admission_pending' && equal(node.admission,lease)
     && node.claim?.leaseId===lease?.leaseId && node.claim?.broker===broker.id;
   if(effects.has(id)||node.status!=='running'||node.currentAttempt!==token.forAttempt
     || !knownRaw || !equal(knownRaw,lease) || (block && !ownPending))return {ok:false,held:true,code:'HOST_EFFECT_FENCED'};
  effects.add(id);const attempt=node.currentAttempt,sessionId=node.sessionId;
  const bound=await budget.bind(token,{brokerId:broker.id,leaseId:lease.leaseId,...(lease.launchGeneration?{launchGeneration:lease.launchGeneration}:{}),attempt,sessionId});
  let current=read(p,n);if(bound?.ok!==true||current?.status!=='running'||current.currentAttempt!==attempt||current.sessionId!==sessionId||await broker.verify(lease,{projectId:p,nodeId:n})!==true)return {ok:false,held:true,code:'HOST_BIND_UNCONFIRMED'};
  if(current.hostBudgetReservation?.effectStarted!==true){const marker=await budget.markExternal(token);if(marker?.ok!==true)return {ok:false,held:true,code:'HOST_EFFECT_UNCONFIRMED'};}
  current=read(p,n);
  if(current?.status!=='running'||current.currentAttempt!==attempt||current.sessionId!==sessionId||(await budget.verify(token))?.ok!==true)return {ok:false,held:true,code:'HOST_EFFECT_OWNER_CHANGED'};
  return {ok:true,node:current};
 }
 async function release(p,n,lease){const own=await owner(p,n,lease);return own?own.broker.release(own.id):{released:false,held:true,reason:'unknown Host raw owner'};}
 async function finalize(p,n){
  const node=read(p,n),record=node?.hostBudgetReservation;if(!record)return {released:true,alreadyReleased:true};
  const own=await owner(p,n);return own?own.broker.finalizeRelease(own.id):{released:false,held:true,reason:'unknown final Host owner'};
 }
 async function pumpLeases(){if(pumping)return;pumping=true;try{for(const pr of store.listProjects())for(const node of store.listNodes(pr.id)){
  if(node.status!=='planned'||node.resourceWait?.backend!=='host-budget'||node.resourceWait.retryAfter>clock()||node.hostBudgetReservation||node.claim||node.admission||sandboxAdmissionBlock(node))continue;
  await request(pr.id,node.id).catch(()=>{});
 }}finally{pumping=false;}}
 return {request,verify,beforeEffects,release,finalize,pumpLeases,brokerIdFor};
}
