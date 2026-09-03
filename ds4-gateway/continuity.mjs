// Versioned pre-dispatch receipts. Never infer safe replay from an HTTP code alone.
export const CALL_ID_HEADER='x-dsg-call-id';
export const DISPATCH_HEADER='x-dsg-dispatch-state';
export const validCallId=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)?value.toLowerCase():null;
export function continuityDoorForDisplay(value){
  if(value?.service!=='dwarf-star-gate-continuity-door'||value.version!==1)return null;
  const count=n=>Number.isSafeInteger(n)&&n>=0?n:0;
  const reason=['planned_gateway_core_restart','core_connection_failed','core_not_ready'].includes(value.reason)?value.reason:null;
  return {schema:1,holding:value.holding===true,hold_kind:['manual','automatic'].includes(value.hold_kind)?value.hold_kind:null,reason,
    since:typeof value.since==='string'&&Number.isFinite(Date.parse(value.since))?value.since:null,held:count(value.held),active:count(value.active),
    core_ready:value.core_ready===true,core_failures:count(value.core_failures),body_spooling:value.body_spooling===false?false:null,replay:value.replay===false?false:null};
}
export function continuityForDisplay(value){
  if(value?.schema!==1)return null;
  const count=n=>Number.isSafeInteger(n)&&n>=0?n:0;
  return {schema:1,safe_retry_contract:value.safe_retry_contract===true,queued_relocation:value.queued_relocation===true,automatic_relocation:value.automatic_relocation===true,
    automatic_relocation_scope:value.automatic_relocation_scope==='first_dsg_request_or_unaffined'?'first_dsg_request_or_unaffined':null,
    relocation:value.relocation&&typeof value.relocation==='object'?{completed:count(value.relocation.completed),rejected:count(value.relocation.rejected),offers:count(value.relocation.offers),genie_enabled:value.relocation.genie_enabled===true,
      genie_offers:(Array.isArray(value.relocation.genie_offers)?value.relocation.genie_offers:[]).slice(0,8).flatMap(o=>o?.schema===1&&validCallId(o.request_id)&&/^[a-f0-9]{64}$/.test(o.evidence_id??'')&&/^[\w-]{1,64}$/.test(o.source??'')&&/^[\w-]{1,64}$/.test(o.destination??'')&&Number.isFinite(o.waiting_seconds)&&o.waiting_seconds>=0&&o.destination_immediately_free===true?[{schema:1,evidence_id:o.evidence_id,request_id:o.request_id,source:o.source,destination:o.destination,waiting_seconds:o.waiting_seconds,source_active_seconds:Number.isFinite(o.source_active_seconds)&&o.source_active_seconds>=0?o.source_active_seconds:null,source_remaining_prediction:Number.isFinite(o.source_remaining_prediction?.seconds)&&o.source_remaining_prediction.seconds>=0?{seconds:o.source_remaining_prediction.seconds,at:Number.isFinite(o.source_remaining_prediction.at)?o.source_remaining_prediction.at:null,experimental:o.source_remaining_prediction.experimental===true}:null,cache_locality:'unknown',destination_immediately_free:true}]:[])}:null,
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
