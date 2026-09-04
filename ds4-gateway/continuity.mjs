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
export function fallbackTieBreakForDisplay(value){
  if(value?.schema!==1||!['shadow','active_with_abstention'].includes(value.mode)||value.policy!=='validated_remaining_tiebreak')return null;
  const count=n=>Number.isSafeInteger(n)&&n>=0?n:0,worker=value=>typeof value==='string'&&/^[\w-]{1,64}$/.test(value)?value:null;
  const verdicts=new Set(['would_change','would_keep','insufficient_evidence','not_tied','free_tie']),statuses=new Set(['supported','immediately_free','missing_active_remaining','missing_queued_service','forecast_unavailable']);
  let last=null;
  if(value.last&&validCallId(value.last.request_id)&&verdicts.has(value.last.verdict))last={schema:1,mode:value.mode,policy:'validated_remaining_tiebreak',request_id:value.last.request_id,verdict:value.last.verdict,applied:value.last.applied===true,
    selected:worker(value.last.selected),alternative:worker(value.last.alternative),minimum_load:Number.isSafeInteger(value.last.minimum_load)&&value.last.minimum_load>=0?value.last.minimum_load:null,
    candidates:(Array.isArray(value.last.candidates)?value.last.candidates:[]).slice(0,128).flatMap(c=>worker(c?.node)&&statuses.has(c.status)?[{node:worker(c.node),load:Number.isSafeInteger(c.load)&&c.load>=0?c.load:null,status:c.status,predicted_wait_seconds:Number.isFinite(c.predicted_wait_seconds)&&c.predicted_wait_seconds>=0?c.predicted_wait_seconds:null,evidence:(Array.isArray(c.evidence)?c.evidence:[]).filter(e=>['active_remaining','queued_service'].includes(e)).slice(0,32)}]:[])};
  return {schema:1,mode:value.mode,policy:'validated_remaining_tiebreak',evaluations:count(value.evaluations),comparable:count(value.comparable),would_change:count(value.would_change),applied:count(value.applied),insufficient_evidence:count(value.insufficient_evidence),errors:count(value.errors),last};
}
export function continuityForDisplay(value){
  if(value?.schema!==1)return null;
  const count=n=>Number.isSafeInteger(n)&&n>=0?n:0;
  return {schema:1,safe_retry_contract:value.safe_retry_contract===true,queued_relocation:value.queued_relocation===true,automatic_relocation:value.automatic_relocation===true,
    automatic_relocation_scope:['first_dsg_request_or_unaffined','first_unaffined_or_affinity_wait_expired'].includes(value.automatic_relocation_scope)?value.automatic_relocation_scope:null,
    automatic_affinity_rebalance_min_wait_ms:value.automatic_affinity_rebalance_min_wait_ms===null?null:Number.isSafeInteger(value.automatic_affinity_rebalance_min_wait_ms)&&value.automatic_affinity_rebalance_min_wait_ms>=0?value.automatic_affinity_rebalance_min_wait_ms:null,
    relocation:value.relocation&&typeof value.relocation==='object'?{completed:count(value.relocation.completed),rejected:count(value.relocation.rejected),offers:count(value.relocation.offers),genie_enabled:value.relocation.genie_enabled===true,
      diagnostics:relocationDiagnosticsForDisplay(value.relocation.diagnostics),
      genie_offers:(Array.isArray(value.relocation.genie_offers)?value.relocation.genie_offers:[]).slice(0,8).flatMap(o=>o?.schema===1&&validCallId(o.request_id)&&/^[a-f0-9]{64}$/.test(o.evidence_id??'')&&/^[\w-]{1,64}$/.test(o.source??'')&&/^[\w-]{1,64}$/.test(o.destination??'')&&Number.isFinite(o.waiting_seconds)&&o.waiting_seconds>=0&&o.destination_immediately_free===true?[{schema:1,evidence_id:o.evidence_id,request_id:o.request_id,source:o.source,destination:o.destination,waiting_seconds:o.waiting_seconds,source_active_seconds:Number.isFinite(o.source_active_seconds)&&o.source_active_seconds>=0?o.source_active_seconds:null,source_remaining_prediction:Number.isFinite(o.source_remaining_prediction?.seconds)&&o.source_remaining_prediction.seconds>=0?{seconds:o.source_remaining_prediction.seconds,at:Number.isFinite(o.source_remaining_prediction.at)?o.source_remaining_prediction.at:null,experimental:o.source_remaining_prediction.experimental===true}:null,cache_locality:'unknown',destination_immediately_free:true}]:[])}:null,
    patient_wait:value.patient_wait===true,waiting:count(value.waiting),oldest_wait_seconds:Number.isFinite(value.oldest_wait_seconds)&&value.oldest_wait_seconds>=0?value.oldest_wait_seconds:null,
    waiting_reasons:Object.fromEntries(Object.entries(value.waiting_reasons??{}).filter(([r,n])=>rejectionReasons.has(r)&&count(n)>0)),
    recent_rejections:(Array.isArray(value.recent_rejections)?value.recent_rejections:[]).slice(0,20).filter(r=>validCallId(r?.request_id)&&r.dispatch_state==='not_dispatched'&&rejectionReasons.has(r.reason)&&Number.isFinite(Date.parse(r.time))).map(r=>({time:r.time,request_id:r.request_id,node:typeof r.node==='string'&&/^[\w-]{1,64}$/.test(r.node)?r.node:null,reason:r.reason,dispatch_state:'not_dispatched',retry_class:r.reason==='affinity_write_failed'?'operator_required':'wait_then_retry'}))};
}
const relocationReasons=new Set(['gateway_stopping','gateway_draining','source_not_active','cancelled_queue_head','already_dispatched','same_session_active','same_session_queued','same_session_waiting','no_idle_destination','durable_home_mismatch','offer_ready']);
const relocationPolicyReasons=new Set([...relocationReasons,'automatic_ready','affinity_automatic_disabled','automatic_wait_threshold','affinity_requires_exact_offer','genie_disabled','genie_wait_threshold','genie_offer_ready']);
function relocationDiagnosticsForDisplay(value){
  if(value?.schema!==1)return null;
  const worker=value=>typeof value==='string'&&/^[\w-]{1,64}$/.test(value)?value:null;
  const gateway_reason=relocationReasons.has(value.gateway_reason)?value.gateway_reason:null;
  return {schema:1,gateway_reason,idle_destinations:(Array.isArray(value.idle_destinations)?value.idle_destinations:[]).slice(0,32).map(worker).filter(Boolean),
    sources:(Array.isArray(value.sources)?value.sources:[]).slice(0,32).flatMap(row=>{
      const source=worker(row?.source),request_id=validCallId(row?.request_id),reason=relocationReasons.has(row?.reason)?row.reason:null;
      if(!source||!request_id||!reason||!['new','existing','none','reassigned','rebalanced'].includes(row.affinity)||!Number.isFinite(row.waiting_seconds)||row.waiting_seconds<0)return [];
      return [{source,request_id,affinity:row.affinity,waiting_seconds:row.waiting_seconds,reason,destination:worker(row.destination),conflicting_worker:worker(row.conflicting_worker),
        automatic_reason:relocationPolicyReasons.has(row.automatic_reason)?row.automatic_reason:null,genie_reason:relocationPolicyReasons.has(row.genie_reason)?row.genie_reason:null}];
    }),truncated:value.truncated===true};
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
