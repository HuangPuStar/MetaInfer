import test from 'node:test';
import assert from 'node:assert/strict';
import { createSandboxAdmissionBroker } from '../../host/dispatch/brokers.js';
import { defaultRequestFor } from '../../host/dispatch/deterministic-strategy.js';
function fixture() {
  const node = { projectId:'p', id:'n', status:'planned', currentAttempt:0, needs:{gpu:1}, execution:{profile:'sandbox-pclab19',driver:'dsh',sandboxProfile:'pclab19'} };
  const broker = createSandboxAdmissionBroker({limits:()=>({maxRunningNodes:4,resourcePools:{gpu:4}}),readNode:(p,n)=>p==='p'&&n==='n'?node:null});
  const acquire = () => broker.acquire(defaultRequestFor('p',node));
  const persist = lease => Object.assign(node,{currentAttempt:1,sessionId:'s',admission:structuredClone(lease),claim:{leaseId:lease.leaseId,decisionId:'d'},sandbox:{backend:'opensandbox',profile:'pclab19',state:'queued',verifiedClean:true,operations:{}}});
  return {node,broker,acquire,persist};
}
test('snapshot lists active Host grants including before the kernel claim',async()=>{
  const {broker,acquire,node}=fixture();assert.deepEqual(broker.snapshot(),[]);
  const result=await acquire();assert.equal(result.status,'granted');
  assert.equal(node.claim,undefined);assert.deepEqual(broker.snapshot(),[result.lease]);
});
test('snapshot is deep-cloned and caller mutation cannot change grant verification',async()=>{
  const {broker,acquire}=fixture();const {lease}=await acquire();const view=broker.snapshot();
  view[0].resources.gpu=99;view[0].launchGeneration='forged';view.push({leaseId:'forged'});
  assert.deepEqual(broker.snapshot(),[lease]);assert.equal(await broker.verify(lease,{projectId:'p',nodeId:'n'}),true);
});
test('snapshot excludes a proven release while durable admission and claim still expose the cleanup window',async()=>{
  const {broker,acquire,persist,node}=fixture();const {lease}=await acquire();persist(lease);
  assert.deepEqual(await broker.release(lease.leaseId),{released:true});assert.deepEqual(broker.snapshot(),[]);
  assert.deepEqual(node.admission,lease);assert.equal(node.claim.leaseId,lease.leaseId);
  broker.adopt(lease);assert.deepEqual(broker.snapshot(),[lease]);
});
test('snapshot retains the exact active lease through physical-clean command Unknown and orphan sweeps',async()=>{
  const {broker,acquire,persist,node}=fixture();const {lease}=await acquire();persist(lease);node.status='failed';
  node.sandbox.operations.exec={operationId:'exec',state:'unknown'};
  assert.equal((await broker.release(lease.leaseId)).held,true);assert.deepEqual(broker.releaseOrphans(),[]);
  assert.deepEqual(broker.snapshot(),[lease]);assert.equal(node.sandbox.operations.exec.state,'unknown');
});
