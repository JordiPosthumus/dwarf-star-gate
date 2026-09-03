// Versioned pre-dispatch receipts. Never infer safe replay from an HTTP code alone.
export const CALL_ID_HEADER='x-dsg-call-id';
export const DISPATCH_HEADER='x-dsg-dispatch-state';
export const validCallId=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)?value.toLowerCase():null;
export function continuityForDisplay(value){
  if(value?.schema!==1)return null;
  const count=n=>Number.isSafeInteger(n)&&n>=0?n:0;
  return {schema:1,safe_retry_contract:value.safe_retry_contract===true,queued_relocation:false,
    patient_wait:value.patient_wait===true,waiting:count(value.waiting),oldest_wait_seconds:Number.isFinite(value.oldest_wait_seconds)&&value.oldest_wait_seconds>=0?value.oldest_wait_seconds:null,
    waiting_reasons:Object.fromEntries(Object.entries(value.waiting_reasons??{}).filter(([r,n])=>rejectionReasons.has(r)&&count(n)>0)),
    recent_rejections:(Array.isArray(value.recent_rejections)?value.recent_rejections:[]).slice(0,20).filter(r=>validCallId(r?.request_id)&&r.dispatch_state==='not_dispatched'&&rejectionReasons.has(r.reason)&&Number.isFinite(Date.parse(r.time))).map(r=>({time:r.time,request_id:r.request_id,node:typeof r.node==='string'&&/^[\w-]{1,64}$/.test(r.node)?r.node:null,reason:r.reason,dispatch_state:'not_dispatched',retry_class:r.reason==='affinity_write_failed'?'operator_required':'wait_then_retry'}))};
}
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
