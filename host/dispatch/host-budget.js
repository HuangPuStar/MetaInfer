/** Project-wide Host quota only: persistent owners plus process-pending grants. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { executionSnapshot, executionFingerprint } from '../execution.js';
import { holdsResources } from '../sandbox-state.js';

const copy = value => structuredClone(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const BROKERS = new Set(['local-pool','cluster','sandbox-admission']);
const FIELDS = ['reservationId','projectId','nodeId','requestId','brokerId','resources','target','executionFingerprint','forAttempt','baseAttempt','baseSessionId','launchGeneration','createdAt'];
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0\r\n]/.test(value);
function vector(value) {
  if (!plain(value)) throw Error('invalid resource vector');
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (key === 'machines') continue;
    const amount = value[key];
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(key) || ['constructor','prototype'].includes(key) || !Number.isSafeInteger(amount) || amount < 0) throw Error('invalid resource vector');
    if (amount !== 0) result[key] = amount;
  }
  return result;
}
const targetOf = node => executionSnapshot(node.execution ?? {profile:'dsh',driver:'dsh'});
const tokenOf = value => Object.fromEntries(FIELDS.map(key => [key,copy(value[key])]));
function validToken(value) {
  if (!plain(value) || !['reservationId','projectId','nodeId','requestId','launchGeneration'].every(k => text(value[k])) || !BROKERS.has(value.brokerId)
    || !Number.isSafeInteger(value.baseAttempt) || value.baseAttempt < 0 || value.forAttempt !== value.baseAttempt + 1
    || !(value.baseSessionId === null || text(value.baseSessionId)) || !Number.isFinite(value.createdAt)) return false;
  try { return equal(vector(value.resources),value.resources) && equal(targetOf({execution:value.target}),value.target) && executionFingerprint(value.target) === value.executionFingerprint; }
  catch { return false; }
}
function operationsUnresolved(node) {
  const operations = node.sandbox?.operations;
  if (operations === undefined) return false;
  return !plain(operations) || Object.values(operations).some(op => op?.state !== 'completed');
}
function physical(node) {
  return holdsResources(node) || (plain(node.resourcesHeld) && Object.keys(node.resourcesHeld).length > 0)
    || Boolean(node.lease && !(node.lease.state === 'released' && node.lease.verifiedClean === true))
    || node.termination?.verifiedClean === false;
}
function blocked(node) {
  const binding = node.sandbox;
  return physical(node) || Boolean(node.claim || node.admission || node.sandboxGate)
    || operationsUnresolved(node) || node.dispatchHold?.reason === 'sandbox_held'
    || binding?.cancelRequested === true
    || Boolean(binding?.bindingId && (binding.verifiedClean !== true || !['released','noCapacity'].includes(binding.state)));
}

/** All reads are cloned; commitReservation is the only persistent writer. */
export function createHostBudget({readProject,readNodes,readNode,commitReservation,clock=Date.now}) {
  if (![readProject,readNodes,readNode,commitReservation,clock].every(fn => typeof fn === 'function')) throw new TypeError('Host budget requires read and kernel callbacks');
  const pending = new Map(), released = new Map();
  const project = id => copy(readProject(id));
  const nodes = id => copy(readNodes(id));
  const node = (p,n) => { try { return copy(readNode(p,n)); } catch { return undefined; } };
  const held = (code,extra={}) => ({ok:false,released:false,status:'held',code,reason:code,...extra});
  function identity(token,current,record) {
    if (!current || current.id !== token.nodeId || current.projectId !== token.projectId) return false;
    try { if (executionFingerprint(targetOf(current)) !== token.executionFingerprint || !equal(vector(current.needs??{}),token.resources)) return false; } catch { return false; }
    const attempt = current.currentAttempt ?? 0;
    if (attempt === token.baseAttempt) return (current.sessionId ?? null) === token.baseSessionId;
    if (attempt !== token.forAttempt) return false;
    const owner = record?.bound;
    return owner?.attempt === undefined || (owner.attempt === attempt && owner.sessionId === current.sessionId);
  }
  function context(input) {
    if (!validToken(input)) return null;
    const token = tokenOf(input), current = node(token.projectId,token.nodeId), stored = current?.hostBudgetReservation;
    const entry = pending.get(token.reservationId);
    if ((entry && !equal(entry.token,token)) || !stored || !equal(tokenOf(stored),token)
      || !identity(token,current,stored)) return null;
    // Methods pin immutable token identity; cold record callers may carry an older mutable phase.
    if (entry && (entry.busy || entry.uncertain)) return null;
    const known = entry ?? {token,record:copy(stored),durable:true,busy:false,uncertain:false};
    if (!entry) pending.set(token.reservationId,known);
    known.record = copy(stored);
    return {token,current,record:copy(stored),entry:known};
  }
  function expected(current,p) {
    return {projectId:p.id,nodeId:current.id,nodeRev:current.rev??0,projectRev:p.revision,
      reservationId:current.hostBudgetReservation?.reservationId??null,currentAttempt:current.currentAttempt??0,sessionId:current.sessionId};
  }
  function snapshot(projectId) {
    const owners = new Map(), footprints = new Map(), conflicts = [];
    let all;
    try { if (!project(projectId)) throw Error('project missing');all=nodes(projectId);if (!Array.isArray(all)) throw Error('invalid nodes'); }
    catch { return {slotsUsed:0,quotaUsed:{},owners:[],conflicts:['invalid project snapshot']}; }
    const byId = new Map();
    const add = (id,resources,source,token=null) => {
      let row=owners.get(id);
      if (!row) {row={nodeId:id,resources:{},sources:[],reservationId:null};owners.set(id,row);}
      row.sources.push(source);
      try {
        const values=vector(resources);
        const prior=footprints.get(id);
        if (Object.keys(values).length && prior && !equal(prior,values)) conflicts.push('conflicting resource vector: '+id);
        if (Object.keys(values).length && !prior) footprints.set(id,copy(values));
        if (token && row.reservationId && row.reservationId!==token.reservationId) conflicts.push('conflicting generation: '+id);
        if (token) row.reservationId=token.reservationId;
        for (const [key,amount] of Object.entries(values)) row.resources[key]=Math.max(row.resources[key]??0,amount);
      } catch { conflicts.push('invalid footprint: '+id); }
    };
    for (const current of all) {
      if (!current || !text(current.id) || current.projectId!==projectId || byId.has(current.id)) {conflicts.push('invalid/duplicate node');continue;}
      byId.set(current.id,current);
      const reservation=current.hostBudgetReservation;
      const occupied=physical(current)||Boolean(reservation||current.claim||current.admission)||operationsUnresolved(current)||current.dispatchHold?.reason==='sandbox_held';
      if (!occupied) continue;
      let pinned=false;
      if (reservation) {
        if (!validToken(reservation)||!identity(reservation,current,reservation)) conflicts.push('invalid reservation owner: '+current.id);
        add(current.id,reservation.resources,'persistent-reservation',reservation);pinned=true;
      }
      const binding=current.sandbox;
      if (binding?.bindingId && binding.verifiedClean!==true && binding.gpuCount!==undefined) {
        try {
          if (!Number.isSafeInteger(binding.gpuCount)||binding.gpuCount<0) throw Error('invalid binding count');
          const footprint=vector(current.resourcesHeld??current.needs??{});delete footprint.gpu;
          if (binding.gpuCount>0) footprint.gpu=binding.gpuCount;
          add(current.id,footprint,'physical-binding');pinned=true;
        } catch { conflicts.push('invalid binding footprint: '+current.id); }
      }
      if (current.resourcesHeld!==undefined && physical(current)) {add(current.id,current.resourcesHeld,'resources-held');pinned=true;}
      if (current.admission?.resources!==undefined) {add(current.id,current.admission.resources,'admission');pinned=true;}
      if (current.lease?.resources!==undefined) {add(current.id,current.lease.resources,'lease');pinned=true;}
      if (!pinned) add(current.id,current.needs??{},'persistent-owner');
    }
    for (const entry of pending.values()) {
      if (entry.token.projectId!==projectId) continue;
      const current=byId.get(entry.token.nodeId);
      if (!current || !identity(entry.token,current,current.hostBudgetReservation??entry.record)) conflicts.push('pending owner changed: '+entry.token.nodeId);
      add(entry.token.nodeId,entry.token.resources,'process-pending',entry.token);
    }
    const quotaUsed={};
    for (const row of owners.values()) for (const [key,amount] of Object.entries(row.resources)) quotaUsed[key]=(quotaUsed[key]??0)+amount;
    return copy({slotsUsed:owners.size,quotaUsed,owners:[...owners.values()],conflicts:[...new Set(conflicts)]});
  }
  async function update(ctx,next,event) {
    const {entry,token}=ctx;
    let p;
    try {p=project(token.projectId);} catch {return held('READ_UNKNOWN');}
    entry.busy=true;
    let ack;
    try {ack=await commitReservation({expected:expected(ctx.current,p),reservation:copy(next),event});}
    catch {entry.busy=false;entry.uncertain=true;return held('COMMIT_UNKNOWN');}
    entry.busy=false;
    if (ack?.ok!==true) {
      if (!['stale','budget_held'].includes(ack?.code)) entry.uncertain=true;
      return held(ack?.code??'COMMIT_UNKNOWN');
    }
    const fresh=node(token.projectId,token.nodeId);
    if (!equal(fresh?.hostBudgetReservation,next) || !identity(token,fresh,next)) {entry.uncertain=true;return held('ACK_MISMATCH');}
    entry.record=copy(next);entry.durable=true;
    return {ok:true,state:next.state};
  }
  async function reserve(req) {
    let p,current,resources,target;
    try {
      if (!plain(req)||!['projectId','nodeId','requestId'].every(k=>text(req[k]))||!BROKERS.has(req.brokerId)) throw Error('request');
      p=project(req.projectId);current=node(req.projectId,req.nodeId);resources=vector(req.resources);
      if (!p||!current||current.projectId!==req.projectId||current.id!==req.nodeId||!equal(resources,vector(current.needs??{}))) throw Error('scope/vector');
      target=targetOf(current);
    } catch {return {status:'denied',code:'INVALID_REQUEST',reason:'invalid request scope, target or resource vector'};}
    const existing=current.hostBudgetReservation;
    if (existing) {
      if (validToken(existing)&&existing.requestId===req.requestId&&existing.brokerId===req.brokerId&&equal(existing.resources,resources)
        && existing.executionFingerprint===executionFingerprint(target)&&existing.state==='reserved'&&existing.effectStarted===false
        && identity(existing,current,existing)&&!blocked(current)&&!pending.get(existing.reservationId)?.uncertain&&!pending.get(existing.reservationId)?.busy) {
        const token=tokenOf(existing);pending.set(token.reservationId,{token,record:copy(existing),durable:true,busy:false,uncertain:false});
        return {status:'granted',token:copy(token)};
      }
      return {status:'held',code:'EXISTING_RESERVATION',reason:'existing reservation or effect cannot be replayed'};
    }
    for (const entry of pending.values()) if (entry.token.projectId===req.projectId&&entry.token.nodeId===req.nodeId) return {status:'held',code:'PENDING_OWNER',reason:'process pending owner retained'};
    if (current.status!=='planned'||blocked(current)) return {status:'held',code:'OWNER_BLOCKED',reason:'node has work, admission or uncertainty'};
    const usage=snapshot(req.projectId);
    if (usage.conflicts.length) return {status:'held',code:'BUDGET_CONFLICT',reason:usage.conflicts.join('; ')};
    const max=p.config?.maxRunningNodes??Infinity;
    let pools;
    try {pools=vector(p.config?.resourcePools??{});if (max!==Infinity&&(!Number.isSafeInteger(max)||max<0)) throw Error('limits');}
    catch {return {status:'held',code:'INVALID_LIMITS',reason:'invalid project budget'};}
    for (const [key,used] of Object.entries(usage.quotaUsed)) if (used>(pools[key]??0)) return {status:'queued',code:'HOST_OVERCOMMITTED',reason:'existing project quota exceeds current limits'};
    if (usage.slotsUsed>=max) return {status:'queued',code:'HOST_SLOTS',reason:'project Host slots occupied'};
    for (const [key,amount] of Object.entries(resources)) {
      if (amount>(pools[key]??0)) return {status:'denied',code:'UNSATISFIABLE',reason:'request exceeds project '+key+' quota'};
      if ((usage.quotaUsed[key]??0)+amount>(pools[key]??0)) return {status:'queued',code:'HOST_QUOTA',reason:'project '+key+' quota occupied'};
    }
    const token={reservationId:randomUUID(),projectId:req.projectId,nodeId:req.nodeId,requestId:req.requestId,brokerId:req.brokerId,
      resources,target,executionFingerprint:executionFingerprint(target),forAttempt:(current.currentAttempt??0)+1,
      baseAttempt:current.currentAttempt??0,baseSessionId:current.sessionId??null,launchGeneration:randomUUID(),createdAt:clock()};
    if (!validToken(token)) return {status:'denied',code:'INVALID_OWNER',reason:'invalid owner identity'};
    const record={...copy(token),state:'reserved',effectStarted:false,bound:null};
    // This synchronous insert is before the first await and covers every lane.
    const entry={token:copy(token),record:copy(record),durable:false,busy:true,uncertain:false};pending.set(token.reservationId,entry);
    let ack;
    try {ack=await commitReservation({expected:expected(current,p),reservation:copy(record),event:'node/host_budget_reserved'});}
    catch {entry.busy=false;entry.uncertain=true;return {status:'held',code:'COMMIT_UNKNOWN',reason:'reservation acknowledgement unknown',token:copy(token)};}
    entry.busy=false;
    const fresh=node(token.projectId,token.nodeId);
    if (ack?.ok===true&&equal(fresh?.hostBudgetReservation,record)&&identity(token,fresh,record)) {
      entry.durable=true;return {status:'granted',token:copy(token)};
    }
    if (ack?.ok===false&&ack.code==='stale'&&!fresh?.hostBudgetReservation&&identity(token,fresh,record)) {
      pending.delete(token.reservationId);return {status:'queued',code:'STALE_NO_WRITE',reason:'definite stale with fresh no-write proof'};
    }
    entry.uncertain=true;return {status:'held',code:ack?.code??'ACK_MISMATCH',reason:'reservation not durably confirmed',token:copy(token)};
  }
  async function markExternal(input) {
    const ctx=context(input);
    if (!ctx) return held('OWNER_UNCONFIRMED');
    if (ctx.record.effectStarted===true||!['reserved','bound'].includes(ctx.record.state)) return held('NO_EFFECT_REPLAY');
    const next={...ctx.record,state:'external-pending',effectStarted:true};
    // Busy is set by update before its first await, so this gate cannot repeat.
    return update(ctx,next,'node/host_budget_external_pending');
  }
  async function bind(input,raw) {
    const ctx=context(input);
    if (!ctx) return held('OWNER_UNCONFIRMED');
    if (!plain(raw)||raw.brokerId!==ctx.token.brokerId||!text(raw.leaseId)
      || Object.keys(raw).some(k=>!['brokerId','leaseId','launchGeneration','attempt','sessionId'].includes(k))
      || (raw.launchGeneration!==undefined&&!text(raw.launchGeneration))
      || (raw.attempt!==undefined&&(raw.attempt!==ctx.token.forAttempt||raw.attempt!==ctx.current.currentAttempt||raw.sessionId!==ctx.current.sessionId))
      || (raw.sessionId!==undefined&&raw.attempt===undefined)) return held('RAW_IDENTITY_MISMATCH');
    const known=ctx.record.bound;
    if (known) {
      if (equal(known,raw)) return {ok:true,state:'bound',alreadyBound:true};
      const base={...raw};delete base.attempt;delete base.sessionId;
      if (known.attempt!==undefined||!equal(known,base)) return held('RAW_IDENTITY_MISMATCH');
    }
    return update(ctx,{...ctx.record,state:'bound',bound:copy(raw)},'node/host_budget_bound');
  }
  async function verify(input) {
    const ctx=context(input);
    if (!ctx) return {ok:false,state:'held',code:'OWNER_UNCONFIRMED'};
    if (ctx.record.state==='external-pending'&&!ctx.record.bound) return {ok:false,state:'held',code:'EXTERNAL_PENDING'};
    return {ok:true,state:ctx.record.state,bound:copy(ctx.record.bound)};
  }
  function repeatSafe(input) {
    const proof=released.get(input?.reservationId);
    if (!proof||!validToken(input)||!equal(proof.token,tokenOf(input))) return false;
    const current=node(input.projectId,input.nodeId);
    if (!current||current.hostBudgetReservation||blocked(current)||(current.currentAttempt??0)!==proof.attempt||(current.sessionId??null)!==proof.sessionId) return false;
    if (!identity(input,current,proof.record)) return false;
    for (const entry of pending.values()) if (entry.token.projectId===input.projectId&&entry.token.nodeId===input.nodeId) return false;
    return true;
  }
  async function release(input,proof) {
    const ctx=context(input);
    if (!ctx) return repeatSafe(input)?{ok:true,released:true,alreadyReleased:true}:held('OWNER_UNCONFIRMED');
    if (!plain(proof)||!['no-effect','verified-clean'].includes(proof.kind)||blocked(ctx.current)) return held('BUDGET_HELD');
    if ((proof.attempt!==undefined&&proof.attempt!==(ctx.current.currentAttempt??0))||(proof.sessionId!==undefined&&proof.sessionId!==ctx.current.sessionId)) return held('PROOF_IDENTITY_MISMATCH');
    if (proof.kind==='no-effect'&&ctx.record.effectStarted===true&&proof.noEffectConfirmed!==true) return held('NO_EFFECT_UNCONFIRMED');
    if (proof.kind==='verified-clean'&&ctx.record.effectStarted===true
      && !(ctx.current.sandbox?.verifiedClean===true||ctx.current.termination?.verifiedClean===true||proof.verifiedClean===true)) return held('CLEAN_UNCONFIRMED');
    const {entry,token}=ctx;entry.busy=true;
    let ack;
    try {ack=await commitReservation({expected:expected(ctx.current,project(token.projectId)),reservation:null,event:'node/host_budget_released'});}
    catch {entry.busy=false;entry.uncertain=true;return held('COMMIT_UNKNOWN');}
    entry.busy=false;
    if (ack?.ok!==true) {if (!['stale','budget_held'].includes(ack?.code)) entry.uncertain=true;return held(ack?.code??'COMMIT_UNKNOWN');}
    const fresh=node(token.projectId,token.nodeId);
    if (!fresh||fresh.hostBudgetReservation||blocked(fresh)||!identity(token,fresh,ctx.record)) {entry.uncertain=true;return held('RELEASE_ACK_UNRESOLVED');}
    released.set(token.reservationId,{token:copy(token),record:copy(ctx.record),attempt:fresh.currentAttempt??0,sessionId:fresh.sessionId??null});
    if (released.size>1024) released.delete(released.keys().next().value);
    pending.delete(token.reservationId);return {ok:true,released:true};
  }
  async function adopt(input) {
    if (!validToken(input)) return held('INVALID_TOKEN');
    const current=node(input.projectId,input.nodeId), record=current?.hostBudgetReservation;
    if (!record||!equal(tokenOf(record),tokenOf(input))||(Object.hasOwn(input,'state')&&!equal(record,input))||!identity(input,current,record)) return held('PERSISTED_OWNER_MISMATCH');
    const existing=pending.get(input.reservationId);
    if (existing&&(existing.busy||existing.uncertain)) return held('PENDING_UNCONFIRMED');
    if (existing&&!equal(existing.token,tokenOf(input))) return held('PENDING_OWNER_MISMATCH');
    pending.set(input.reservationId,{token:tokenOf(input),record:copy(record),durable:true,busy:false,uncertain:false});released.delete(input.reservationId);
    return {ok:true,state:record.state==='external-pending'?'held':record.state,token:tokenOf(record)};
  }
  return {reserve,markExternal,bind,verify,release,adopt,snapshot};
}
