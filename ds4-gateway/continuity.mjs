// Versioned pre-dispatch receipts. Never infer safe replay from an HTTP code alone.
export const CALL_ID_HEADER='x-dsg-call-id';
export const DISPATCH_HEADER='x-dsg-dispatch-state';
export const validCallId=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)?value.toLowerCase():null;
export const rejectionReasons=new Set(['gateway_draining','same_session_active','same_session_queued','worker_quarantined','worker_paused','worker_unhealthy','no_ready_worker','queue_full','queue_deadline','affinity_write_failed']);
export function unavailableReason(node){return node.quarantine?'worker_quarantined':node.drained?'worker_paused':'worker_unhealthy';}
export function sessionWork(nodes,key){
  if(!key)return null;
  for(const node of nodes)if(node.active?.key===key)return {node,reason:'same_session_active'};
  for(const node of nodes)if(node.queue.some(job=>job.key===key&&!job.cancelled))return {node,reason:'same_session_queued'};
  return null;
}
export function rejectionReceipt({request_id,call_id=null,node=null,session=null,code,reason}){
  if(!validCallId(request_id)||!rejectionReasons.has(reason))throw new Error('Invalid rejection receipt');
  return {schema:1,request_id,call_id:validCallId(call_id),node,session,code,reason,
    dispatch_state:'not_dispatched',retry_class:reason==='affinity_write_failed'?'operator_required':'wait_then_retry',retry_after_ms:5000};
}
