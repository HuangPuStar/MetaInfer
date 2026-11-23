/** A raw resource broker plus one project-wide Host reservation authority. */
import { isDeepStrictEqual } from 'node:util';
import { holdsResources, sandboxAdmissionBlock } from '../sandbox-state.js';
const clone=structuredClone;
const held=reason=>({status:'contested',reason,retryable:false});

export function createBudgetBroker({raw,budget,readNode}) {
  if (!raw?.id || !budget?.reserve || typeof readNode!=='function') throw Error('Budget broker requires raw broker, common budget and fresh node reader.');
  const links=new Map(),finished=new Map();
  const fresh=link=>readNode(link.lease.projectId,link.lease.nodeId);
  const safeToSettle=n=>Boolean(n && n.status!=='running' && !n.claim && !n.admission && !holdsResources(n) && !sandboxAdmissionBlock(n));
  async function finalizeRelease(leaseId) {
    const link=links.get(leaseId)??finished.get(leaseId);
    if (!link) return {released:false,held:true,reason:'unknown Host reservation owner'};
    if (!link.rawReleased) return {released:false,held:true,reason:'raw release is not confirmed'};
    const node=fresh(link);
    if (!safeToSettle(node)) return {released:false,held:true,reason:'durable owner not yet clean'};
    const cleanup=node.hostBudgetCleanup;
    const localClean=cleanup?.verifiedClean===true && cleanup.attempt===(node.currentAttempt??0) && cleanup.sessionId===node.sessionId;
    const result=await budget.release(link.token,{kind:'verified-clean',reason:'RAW_RELEASED_AND_DURABLE_OWNER_CLEAN',attempt:node.currentAttempt??0,sessionId:node.sessionId,...(localClean?{verifiedClean:true}:{})});
    if (result?.released!==true) return {released:false,held:true,reason:result?.code??'Host reservation cleanup unconfirmed'};
    links.delete(leaseId);finished.set(leaseId,link);
    if(finished.size>1024)finished.delete(finished.keys().next().value);
    return {released:true};
  }
  async function release(leaseId) {
    const link=links.get(leaseId);
    if(!link)return finished.has(leaseId)?finalizeRelease(leaseId):{released:false,held:true,reason:'unknown raw lease owner'};
    if(link.rawReleased)return {released:true,hostBudgetReleased:false};
    const authority=await budget.verify(link.token);
    if(authority?.ok!==true)return {released:false,held:true,reason:'Host owner changed before raw release'};
    let result;
    try{result=await raw.release(leaseId);}catch{return {released:false,held:true,reason:'raw release outcome unknown'};}
    if(['sandbox-admission','cluster'].includes(raw.id) && result?.released!==true)return {released:false,held:true,reason:result?.reason??'sandbox cleanup unconfirmed'};
    if(result?.released===false)return {released:false,held:true,reason:'raw broker retained lease'};
    link.rawReleased=true;
    // Do not free common quota here: the envelope/lifecycle still owns its kernel claim.
    return {released:true,hostBudgetReleased:false};
  }
  async function acquire(req) {
    const reservation=await budget.reserve({...clone(req),brokerId:raw.id});
    if(reservation?.status!=='granted')return reservation?.status==='queued'||reservation?.status==='denied'
      ?{status:reservation.status,reason:reservation.code??reservation.reason??'Host budget unavailable'}:held(reservation?.code??'Host budget held');
    const token=clone(reservation.token);
    if(raw.id==='cluster'){
      const marker=await budget.markExternal(token);
      if(marker?.ok!==true)return held(marker?.code??'External admission intent unconfirmed');
    }
    let answer;
    try{answer=await raw.acquire(clone(req));}catch{return held('Raw acquisition outcome unknown; Host reservation retained');}
    if(answer?.status==='granted' && answer.lease?.broker===raw.id && answer.lease.projectId===req.projectId && answer.lease.nodeId===req.nodeId && typeof answer.lease.leaseId==='string'){
      const lease=clone(answer.lease),link={token,lease,rawReleased:false};links.set(lease.leaseId,link);
      const bound=await budget.bind(token,{brokerId:raw.id,leaseId:lease.leaseId,...(lease.launchGeneration?{launchGeneration:lease.launchGeneration}:{})});
      if(bound?.ok!==true)return held(bound?.code??'Raw lease exists but Host binding is unconfirmed');
      return {...answer,lease:clone(lease),basis:readNode(req.projectId,req.nodeId)?.rev??0};
    }
    if(['queued','denied','reserved','contested'].includes(answer?.status)){
      // Cluster queues are external coordinator state, not proof of no allocation.
      if(raw.id==='cluster')return {...answer,hostBudgetHeld:true};
      const released=await budget.release(token,{kind:'no-effect',reason:raw.id==='cluster'?'RAW_REJECTED_NO_EFFECT':'BEFORE_RAW',noEffectConfirmed:true});
      if(released?.released!==true)return held(released?.code??'Unspent Host reservation could not be released');
      return answer;
    }
    return held('Malformed raw outcome; Host reservation retained');
  }
  return {
    id:raw.id,acquire,release,finalizeRelease,
    async verify(lease,scope){
      const link=links.get(lease?.leaseId);
      if(!link||link.rawReleased||!isDeepStrictEqual(link.lease,lease))return false;
      const v=await budget.verify(link.token);return v?.ok===true && Boolean(await raw.verify(lease,scope));
    },
    async adopt(lease){
      const node=readNode(lease?.projectId,lease?.nodeId),record=node?.hostBudgetReservation;
      if(!record || record.bound?.brokerId!==raw.id || record.bound?.leaseId!==lease?.leaseId)throw Error('Cold raw lease has no exact persistent Host reservation.');
      const a=await budget.adopt(record);if(a?.ok!==true)throw Error('Cold Host reservation remains held.');
      if(typeof raw.adopt!=='function')throw Error('Raw broker does not support cold lease adoption.');
      await raw.adopt(clone(lease));links.set(lease.leaseId,{token:clone(record),lease:clone(lease),rawReleased:false});
    },
    async releaseOrphans(){
      const out=[];
      for(const [id,link]of links){
        const node=fresh(link);
        if(!safeToSettle(node)||(!link.rawReleased&&!['completed','failed','cancelled'].includes(node.status)))continue;
        const r=await release(id);if(r.released===true && (await finalizeRelease(id)).released===true)out.push(id);
      }
      return out;
    },
    async settleNode(projectId,nodeId){
      const results=[];for(const [id,link]of links)if(link.lease.projectId===projectId&&link.lease.nodeId===nodeId){
        if(!safeToSettle(fresh(link))){results.push({released:false,held:true});continue;}
        const r=await release(id);results.push(r.released===true?await finalizeRelease(id):r);
      }return results;
    },
    tokenFor(leaseId){const link=links.get(leaseId)??finished.get(leaseId);return link?clone(link.token):null;},
    snapshot(){return [...links.values()].filter(x=>!x.rawReleased).map(x=>clone(x.lease));},
    get size(){return [...links.values()].filter(x=>!x.rawReleased).length;},
    ...(typeof raw.renew==='function'?{async renew(leaseId,...args){
      const link=links.get(leaseId);
      if(!link || link.rawReleased || (await budget.verify(link.token))?.ok!==true)return {status:'lost',held:true,reason:'Host renewal owner unconfirmed'};
      try{return await raw.renew(leaseId,...args);}catch{return {status:'lost',held:true,reason:'raw renewal outcome unknown'};}
    }}:{}),
  };
}
