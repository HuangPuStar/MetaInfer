import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBudgetBroker } from '../host/dispatch/budget-broker.js';
const clone=structuredClone;
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
function fixture(){
 const nodes=new Map(['a','b'].map(id=>[id,{id,projectId:'p',status:'planned',currentAttempt:0,sessionId:'s0',needs:{gpu:1}}]));let seq=0;
 const slots=new Map(),logs=[];
 const budget={async reserve(req){logs.push('reserve:'+req.nodeId);if(slots.size)return {status:'queued',code:'HOST_SLOTS'};const token={reservationId:'t'+(++seq),...clone(req)};slots.set(token.reservationId,{token,state:'reserved'});nodes.get(req.nodeId).hostBudgetReservation={...token,state:'reserved'};return {status:'granted',token};},
 async markExternal(t){logs.push('external:'+t.nodeId);slots.get(t.reservationId).effectStarted=true;return {ok:true};},
 async bind(t,bound){logs.push('bind:'+t.nodeId);slots.get(t.reservationId).bound=clone(bound);slots.get(t.reservationId).state='bound';nodes.get(t.nodeId).hostBudgetReservation={...t,state:'bound',bound};return {ok:true};},
 async verify(t){return {ok:slots.has(t.reservationId),state:slots.get(t.reservationId)?.state};},
 async release(t,proof){logs.push('release-budget:'+t.nodeId);const n=nodes.get(t.nodeId);if(n.claim||n.admission||n.unknown)return {ok:false,released:false,held:true};slots.delete(t.reservationId);delete n.hostBudgetReservation;return {ok:true,released:true};},
 async adopt(t){return {ok:slots.has(t.reservationId)};},snapshot(){return {slotsUsed:slots.size};}};
 const raw=(id,acquire)=>({id,async acquire(req){logs.push('raw:'+req.nodeId);return acquire?acquire(req):{status:'granted',lease:{broker:id,leaseId:'l'+(++seq),projectId:req.projectId,nodeId:req.nodeId,requestId:req.requestId}};},async verify(){return true;},async release(id){logs.push('release-raw:'+id);return {released:true};},adopt(){logs.push('adopt-raw');}});
 const readNode=(_p,n)=>clone(nodes.get(n));const wrap=r=>createBudgetBroker({raw:r,budget,readNode});
 const req=nodeId=>({projectId:'p',nodeId,requestId:'r'+nodeId,resources:{gpu:1}});
 return {nodes,slots,logs,budget,raw,wrap,req};
}
test('raw broker cannot run before durable reservation acknowledgement',async()=>{
 const f=fixture(),gate=deferred();const reserve=f.budget.reserve;f.budget.reserve=async req=>{const answer=await reserve(req);await gate.promise;return answer;};
 const p=f.wrap(f.raw('local-pool')).acquire(f.req('a'));await Promise.resolve();assert.equal(f.logs.some(x=>x.startsWith('raw:')),false);gate.resolve();assert.equal((await p).status,'granted');
});
test('one Host quota covers deferred cluster, local and sandbox brokers',async()=>{
 const f=fixture(),entered=deferred(),gate=deferred();const cluster=f.wrap(f.raw('cluster',async req=>{entered.resolve();await gate.promise;return {status:'granted',lease:{broker:'cluster',leaseId:'lc',projectId:'p',nodeId:'a',requestId:req.requestId}};}));
 const p=cluster.acquire(f.req('a'));await entered.promise;const [l,s]=await Promise.all([f.wrap(f.raw('local-pool')).acquire(f.req('b')),f.wrap(f.raw('sandbox-admission')).acquire(f.req('b'))]);assert.equal(l.status,'queued');assert.equal(s.status,'queued');assert.deepEqual(f.logs.filter(x=>x.startsWith('raw:')),['raw:a']);assert.ok(f.logs.indexOf('external:a')<f.logs.indexOf('raw:a'));gate.resolve();assert.equal((await p).status,'granted');
});
test('raw release does not expose quota during queued kernel cleanup barrier',async()=>{
 const f=fixture(),b=f.wrap(f.raw('sandbox-admission'));const {lease}=await b.acquire(f.req('a'));const a=f.nodes.get('a');a.claim={decisionId:'d'};a.admission=lease;
 assert.equal((await b.release(lease.leaseId)).released,true);assert.equal(f.slots.size,1);assert.equal((await b.finalizeRelease(lease.leaseId)).released,false);assert.equal((await f.wrap(f.raw('local-pool')).acquire(f.req('b'))).status,'queued');
 delete a.claim;delete a.admission;assert.equal((await b.finalizeRelease(lease.leaseId)).released,true);assert.equal(f.slots.size,0);assert.equal((await f.wrap(f.raw('local-pool')).acquire(f.req('b'))).status,'granted');
});
test('typed budget verify false cannot be mistaken for a truthy object',async()=>{
 const f=fixture(),b=f.wrap(f.raw('sandbox-admission'));const {lease}=await b.acquire(f.req('a'));f.budget.verify=async()=>({ok:false,state:'held'});assert.equal(await b.verify(lease,{projectId:'p',nodeId:'a'}),false);
});
test('unknown external acquire holds reservation and is never replayed or auto-released',async()=>{
 const f=fixture(),b=f.wrap(f.raw('cluster',()=>{throw Error('reply lost');}));const a=await b.acquire(f.req('a'));assert.equal(a.status,'contested');assert.equal(f.slots.size,1);assert.equal(f.logs.some(x=>x.startsWith('release-budget:')),false);assert.equal((await b.acquire(f.req('a'))).status,'queued');assert.equal(f.logs.filter(x=>x==='raw:a').length,1);
});
test('unknown lease release cannot call a raw resource release',async()=>{
 const f=fixture(),b=f.wrap(f.raw('sandbox-admission'));assert.equal((await b.release('foreign')).released,false);assert.equal(f.logs.some(x=>x.startsWith('release-raw:')),false);
});
test('known Host-only denial returns the unspent reservation but malformed reply stays held',async()=>{
 const f=fixture();const denied=await f.wrap(f.raw('sandbox-admission',()=>({status:'denied',reason:'shape'}))).acquire(f.req('a'));assert.equal(denied.status,'denied');assert.equal(f.slots.size,0);
 const weird=await f.wrap(f.raw('local-pool',()=>({unexpected:true}))).acquire(f.req('a'));assert.equal(weird.status,'contested');assert.equal(f.slots.size,1);
});
test('orphan sweep never removes a pre-claim grant, but settles an exact completed owner',async()=>{
 const f=fixture(),b=f.wrap(f.raw('local-pool'));const {lease}=await b.acquire(f.req('a'));await b.releaseOrphans();assert.equal(f.slots.size,1);f.nodes.get('a').status='completed';await b.releaseOrphans();assert.equal(f.slots.size,0);assert.equal(f.logs.filter(x=>x==='release-raw:'+lease.leaseId).length,1);
});

test('finalize cannot free a token before raw release acknowledgement',async()=>{
 const f=fixture(),b=f.wrap(f.raw('local-pool'));const {lease}=await b.acquire(f.req('a'));
 assert.equal((await b.finalizeRelease(lease.leaseId)).released,false);assert.equal(f.slots.size,1);
});
test('renewal cannot bypass an unknown or stale Host reservation owner',async()=>{
 const f=fixture();let renews=0;const raw={...f.raw('cluster'),async renew(){renews++;return {status:'renewed'};}};const b=f.wrap(raw);
 assert.notEqual((await b.renew('foreign',30000))?.status,'renewed');assert.equal(renews,0);
 const {lease}=await b.acquire(f.req('a'));f.budget.verify=async()=>({ok:false});
 assert.notEqual((await b.renew(lease.leaseId,30000))?.status,'renewed');assert.equal(renews,0);
});
test('a stale Host token cannot call raw release even with an old known raw ID',async()=>{
 const f=fixture(),b=f.wrap(f.raw('sandbox-admission'));const {lease}=await b.acquire(f.req('a'));f.budget.verify=async()=>({ok:false});
 assert.equal((await b.release(lease.leaseId)).released,false);assert.equal(f.logs.some(x=>x.startsWith('release-raw:')),false);assert.equal(f.slots.size,1);
});
test('an external denied status alone does not prove no resource effect',async()=>{
 const f=fixture(),b=f.wrap(f.raw('cluster',()=>({status:'denied'})));await b.acquire(f.req('a'));
 assert.equal(f.slots.size,1);assert.equal(f.logs.some(x=>x.startsWith('release-budget:')),false);
});
