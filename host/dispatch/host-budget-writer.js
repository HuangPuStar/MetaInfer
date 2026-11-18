/** Targeted kernel CAS for logical Host quota; never edits physical bindings. */
import { isDeepStrictEqual } from 'node:util';
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const reject = (code, message) => ({ok:false,code,message});
const pinned = ['reservationId','projectId','nodeId','requestId','forAttempt','launchGeneration','executionFingerprint','resources','target','brokerId','baseAttempt','baseSessionId','createdAt'];

export function createHostBudgetWriter({store,kernel}) {
  if (!kernel?.executor || typeof store.withProjectLock !== 'function') throw Error('Host budget writer requires kernel/project locking.');
  return async function commitReservation({expected,reservation,event='node/host_budget_updated'}) {
    if (!plain(expected) || (reservation !== null && !plain(reservation))) return reject('invalid_reservation','Explicit reservation or null is required.');
    const apply = async () => {
      const project=structuredClone(store.getProject(expected.projectId));
      const node=structuredClone(store.getNode(expected.projectId,expected.nodeId));
      if (!project || !node || project.id!==expected.projectId || node.id!==expected.nodeId
        || (node.projectId!==undefined && node.projectId!==expected.projectId)) return reject('stale','Budget owner no longer exists.');
      const old=node.hostBudgetReservation;
      if (!Number.isInteger(expected.nodeRev) || expected.nodeRev!==(node.rev??0)
        || expected.projectRev!==project.revision || expected.currentAttempt!==(node.currentAttempt??0)
        || expected.sessionId!==node.sessionId || (expected.reservationId??null)!==(old?.reservationId??null)) return reject('stale','Budget owner/revision changed.');
      if (reservation===null) {
        const operations=node.sandbox?.operations;
        if (node.status==='running' || node.claim || node.admission || node.sandboxGate || node.resourcesHeld!==undefined
          || (node.lease && !(node.lease.state==='released' && node.lease.verifiedClean===true))
          || node.termination?.verifiedClean===false || node.sandbox?.cancelRequested===true || node.dispatchHold?.reason==='sandbox_held'
          || (operations!==undefined && (!plain(operations) || Object.values(operations).some(op=>op?.state!=='completed')))
          || (node.sandbox?.bindingId && (node.sandbox.verifiedClean!==true || !['released','noCapacity'].includes(node.sandbox.state)))) return reject('budget_held','Owner still holds work, admission or uncertainty.');
      } else {
        if (reservation.projectId!==project.id || reservation.nodeId!==node.id
          || typeof reservation.reservationId!=='string' || !reservation.reservationId
          || !Number.isInteger(reservation.forAttempt) || reservation.forAttempt<1
          || typeof reservation.state!=='string' || !reservation.state
          || !plain(reservation.resources) || Object.values(reservation.resources).some(v=>typeof v!=='number'||!Number.isFinite(v)||v<0)) return reject('invalid_reservation','Reservation scope/vector is invalid.');
        if (old && pinned.some(key=>!isDeepStrictEqual(old[key],reservation[key]))) return reject('stale','Cannot relabel an existing Host reservation.');
        if (old?.effectStarted===true && reservation.effectStarted!==true) return reject('budget_held','External-effect evidence is monotonic.');
      }
      const mutation={op:'node.update',nodeId:node.id,basis:node.rev??0,eventType:event,eventData:{reservationId:reservation?.reservationId??old?.reservationId??null,state:reservation?.state??'released'},
        ...(reservation===null?{unset:['hostBudgetReservation']}:{set:{hostBudgetReservation:structuredClone(reservation)}})};
      const result=await store.withWritePermit(()=>kernel.executor.commitLocked(project.id,{
        actor:{kind:'system',id:'host-budget'},causeId:`budget:${reservation?.reservationId??old?.reservationId??node.id}`,
        expectedProjectRevision:project.revision,mutations:[mutation],
      }));
      if (result?.ok!==true) return result?.ok===false?result:reject('commit_unknown','Kernel did not acknowledge budget commit.');
      const fresh=store.getNode(project.id,node.id)?.hostBudgetReservation;
      if (reservation===null?fresh!==undefined:!isDeepStrictEqual(fresh,reservation)) throw Error('Host budget acknowledgement did not match persisted reservation.');
      return {ok:true,revision:result.revision??store.getProject(project.id)?.revision};
    };
    return store.isProjectLocked?.(expected.projectId)===true?apply():store.withProjectLock(expected.projectId,apply);
  };
}
