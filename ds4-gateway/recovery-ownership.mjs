import {machinesFor} from './fleet-machines.mjs';
import {activeCount} from './worker-activity.mjs';

// Synchronous ownership checks use gateway-owned state, never a registry
// projection (which itself computes recovery status). Different worker names
// can occupy the same physical machines, including either member of a pair.
export function recoveryOwnership({node,nodes,store,config={},directReserved=()=>false,releasingHoldId=null,phase='action',operationId=null,allowReservedQueue=false}) {
  const state=store.data.agent_control;
  if(state!==undefined&&(!state||!Array.isArray(state.holds)||!Array.isArray(state.maintenance_locks??[])))return 'maintenance_state_unverified';
  const holds=state?.holds??[],locks=state?.maintenance_locks??[];
  if([...holds,...locks].some(h=>!h||typeof h.worker_id!=='string'||!nodes.some(n=>n.id===h.worker_id)))return 'maintenance_state_unverified';
  let shared;
  try {
    const group=id=>{
      const machines=machinesFor(id,config);
      if(!Array.isArray(machines)||!machines.length||machines.some(m=>typeof m!=='string'||!m.trim())||new Set(machines).size!==machines.length)throw Error();
      return machines;
    };
    const own=new Set(group(node.id));
    shared=nodes.filter(n=>n.id===node.id||group(n.id).some(m=>own.has(m)));
  } catch {return 'physical_ownership_unverified';}
  const ids=new Set(shared.map(n=>n.id));
  // Only the final hold that AgentControl has authenticated for release can be
  // discounted in a read-only hand-back offer. Recovery actions have no bypass.
  if(holds.some(h=>ids.has(h.worker_id)&&!(h.worker_id===node.id&&h.id===releasingHoldId))||locks.some(h=>ids.has(h.worker_id)))return 'maintenance_hold_active';
  for(const peer of shared){
    if(peer.removed)return 'physical_ownership_unverified';
    const heldQueue=allowReservedQueue&&operationId&&peer.recovering&&peer.recoveryOperationId===operationId;
    if(activeCount(peer)||(peer.queue?.length&&!heldQueue))return peer===node?'wait_for_admitted_work':'shared_machine_has_admitted_work';
    if(peer!==node&&peer.recovering&&!(operationId&&peer.recoveryOperationId===operationId))return 'shared_machine_recovery_in_progress';
    // Our own synthetic verification may set a direct-traffic reservation.
    // Routing already honors it; it must not invalidate a completed proof.
    if((phase!=='readmit'||peer!==node)&&directReserved(peer))return 'native_work_reserved';
  }
  return null;
}
