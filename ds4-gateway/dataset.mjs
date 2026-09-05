// Passive, private evidence. No request/response bodies or arbitrary log fields.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeRequestedThinking } from './requested-thinking.mjs';
import { safeClientMetadata } from './client-metadata.mjs';
import { ENCODER_MODEL, ENCODER_REVISION, EXTRACTION } from './embeddings.mjs';
import {validCallId,rejectionReasons} from './continuity.mjs';
import {safeHardwareSnapshot} from './hardware-snapshot.mjs';

const number = x => Number.isFinite(x) && x >= 0 ? x : null;
const id = x => typeof x === 'string' && /^[\w-]{1,64}$/.test(x) ? x : null;
export const EVIDENCE_KINDS=Object.freeze(['decision','dispatch','finish','queued_cancel','queue_timeout','unavailable_before_dispatch','queue_relocation','routing_shadow','routing_tiebreak_shadow','request_features','embedding','progress','model_prediction','rejection','waiting']);
const kinds = new Set(EVIDENCE_KINDS);
const timingKeys=['worker_idle_ms','active_elapsed_ms','upstream_byte_age_ms','session_last_used_ms','session_last_finished_ms','intervening_requests','prior_prompt_tokens','prior_cached_tokens','observation_epoch'];
export function evidence(kind, raw) {
  if (!kinds.has(kind)) return null;
  const row = { kind, request_id:id(raw.request_id), node:id(raw.node) };
  if (!row.request_id) return null;
  if(kind==='waiting'){if(!rejectionReasons.has(raw.reason))return null;row.reason=raw.reason;row.dispatch_state='not_dispatched';}
  if(kind==='queue_relocation'){
    row.relocation_schema=1;row.source=id(raw.source);row.destination=id(raw.destination);
    row.actor=['operator','scheduler','genie'].includes(raw.actor)?raw.actor:null;row.dispatch_state=raw.dispatch_state==='not_dispatched'?'not_dispatched':null;
    row.body_replayed=raw.body_replayed===false?false:null;row.deadline_preserved=raw.deadline_preserved===true;row.cache_locality='unknown';row.waiting_ms=number(raw.waiting_ms);
    if(!row.source||!row.destination||!row.actor||!row.dispatch_state||row.body_replayed!==false||!row.deadline_preserved||row.waiting_ms===null)return null;
  }
  if(kind==='rejection'){
    if(!rejectionReasons.has(raw.reason)||!['draining','home_unavailable','no_healthy_workers','queue_full','state_unavailable','queue_timeout'].includes(raw.code)||raw.dispatch_state!=='not_dispatched')return null;
    Object.assign(row,{continuity_schema:1,call_id:validCallId(raw.call_id),code:raw.code,reason:raw.reason,dispatch_state:'not_dispatched',retry_class:raw.reason==='affinity_write_failed'?'operator_required':'wait_then_retry',retry_after_ms:5000});
  }
  if(kind==='decision'){row.client_metadata=safeClientMetadata(raw.client_metadata??{schema:1,status:'missing'});row.call_id=validCallId(raw.call_id);}
  for (const k of ['queue_ms','service_ms','total_ms','first_body_byte_ms','request_bytes','context_length','admission_wait_ms']) if (k in raw) row[k]=number(raw[k]);
  if (['new','existing','none','reassigned'].includes(raw.affinity)) row.affinity=raw.affinity;
  if (['genie','unclassified'].includes(raw.traffic_class)) row.traffic_class=raw.traffic_class;
  if (typeof raw.session==='string' && /^[a-f0-9]{64}$/.test(raw.session)) row.session=raw.session;
  if (['complete','client_cancelled','upstream_error','upstream_stream_error','upstream_aborted','upstream_http_error','upstream_engine_error','incomplete_sse','sse_observation_limited','connection_closed','timeout'].includes(raw.outcome)) row.outcome=raw.outcome;
  if (raw.usage) row.usage=Object.fromEntries(['prompt_tokens','completion_tokens','cached_tokens'].map(k=>[k,number(raw.usage[k])]));
  if(kind==='finish')row.finish_reason=['stop','length','tool_calls','function_call','content_filter'].includes(raw.finish_reason)?raw.finish_reason:null;
  if(kind==='finish'){
    row.route=['/v1/chat/completions','/v1/completions','/v1/responses','/v1/messages'].includes(raw.route)?raw.route:null;
    row.response_format=['sse','json','other','no_response'].includes(raw.response_format)?raw.response_format:null;
    row.http_status=Number.isInteger(raw.http_status)&&raw.http_status>=100&&raw.http_status<=599?raw.http_status:null;
    row.usage_observation=['observed','partial','not_reported','json_capture_limit','unsupported_format','invalid_json','unsupported_route'].includes(raw.usage_observation)?raw.usage_observation:null;
    for(const k of ['request_stream','requested_usage'])row[k]=typeof raw[k]==='boolean'?raw[k]:null;
    row.stream_end=['terminal','terminal_without_finish_reason','terminal_reason_unobserved','engine_error','clean_eof_no_terminal','partial_sse_event','observation_limited'].includes(raw.stream_end)?raw.stream_end:null;
  }
  if(kind==='finish'&&raw.generation)row.generation=Object.fromEntries(['thinking_characters','answer_characters','tool_characters','first_semantic_ms'].map(k=>[k,number(raw.generation[k])]));
  if (raw.requested_thinking) row.requested_thinking=safeRequestedThinking(raw.requested_thinking);
  if(kind==='model_prediction'){
    if(raw.predictor_schema!==2||!/^[a-f0-9]{64}$/.test(raw.model_id)||!['admission','updated','remaining'].includes(raw.model_kind)||!['admission','upload','embedded','remaining'].includes(raw.prediction_stage))return null;
    Object.assign(row,{predictor_schema:2,model_id:raw.model_id,model_kind:raw.model_kind,prediction_stage:raw.prediction_stage,experimental:raw.experimental===true});
    for(const k of ['seconds','baseline_seconds','elapsed_s','available_at'])row[k]=number(raw[k]);if(row.seconds===null||row.available_at===null)return null;
  }
  if(kind==='request_features') {
    row.hardware=safeHardwareSnapshot(raw.hardware,row.node);
    row.feature_schema=2;row.prediction_point='after_upload';
    row.status=['ready','invalid_body','unsupported_route','unsupported_body','no_recent_user_text','capture_limit','encoded_body','invalid_json','incomplete_body'].includes(raw.status)?raw.status:'unavailable';
    row.extraction=EXTRACTION;
    for(const key of ['available_at','visible_messages_considered','latest_characters','recent_characters','request_bytes','message_count','user_messages','assistant_messages','system_messages','tool_messages','text_characters','image_parts','tool_definitions','max_output_tokens','temperature','top_p'])row[key]=number(raw[key]);
    row.request_stream=typeof raw.request_stream==='boolean'?raw.request_stream:null;
    row.request_route=['/v1/chat/completions','/v1/responses','/v1/messages'].includes(raw.request_route)?raw.request_route:null;
    row.bounded_slice=true;row.history_scan_limited=raw.history_scan_limited===true;
  }
  if(kind==='embedding') {
    row.hardware=safeHardwareSnapshot(raw.hardware,row.node);
    row.embedding_schema=1;row.extraction=EXTRACTION;
    row.status=['ready','queue_full','worker_unavailable','worker_timeout','invalid_worker_output','collector_stopped'].includes(raw.status)?raw.status:'unavailable';
    if(row.status==='ready') {
      if(raw.model!==ENCODER_MODEL||raw.revision!==ENCODER_REVISION||raw.dimensions!==384)return null;
      row.model=ENCODER_MODEL;row.revision=ENCODER_REVISION;row.dimensions=384;
      for(const key of ['available_at','queued_at','elapsed_ms']){row[key]=number(raw[key]);if(row[key]===null)return null;}
      row.vectors={};
      for(const scope of ['latest_user','recent_conversation']) {
        const v=raw.vectors?.[scope];if(!v)continue;
        if(!Array.isArray(v.vector)||v.vector.length!==384||!v.vector.every(Number.isFinite)||Math.abs(Math.hypot(...v.vector)-1)>.001||!Number.isInteger(v.input_tokens)||v.input_tokens<1||v.used_tokens!==Math.min(v.input_tokens,256)||v.truncated!==(v.input_tokens>256))return null;
        row.vectors[scope]={vector:v.vector,input_tokens:v.input_tokens,used_tokens:v.used_tokens,truncated:v.truncated};
      }
      if(!row.vectors.latest_user)return null;
    }
  }
  if(kind==='progress') {
    row.hardware=safeHardwareSnapshot(raw.hardware,row.node);
    row.progress_schema=1;row.prediction_point='while_active';
    for(const key of ['active_elapsed_ms','semantic_characters','semantic_age_ms','thinking_characters','answer_characters','tool_characters'])row[key]=number(raw[key]);
    row.phase=['awaiting_content','thinking','answering','tool_output'].includes(raw.phase)?raw.phase:'unknown';
    row.requested_thinking=safeRequestedThinking(raw.requested_thinking);
  }
  if(kind==='routing_shadow') {
    row.shadow_schema=1;
    row.reason=['admission','worker_free'].includes(raw.reason)?raw.reason:null;
    row.verdict=['would_move','would_stay','insufficient_evidence','handover_blocked','no_idle_alternative'].includes(raw.verdict)?raw.verdict:null;
    row.confidence='unvalidated';row.basis='prior_session_prompt_bucket_mixed_cache';
    row.source=id(raw.source);row.alternative=id(raw.alternative);row.session_busy=raw.session_busy===true;
    row.waiting_ms=number(raw.waiting_ms);row.saving_ms=number(raw.saving_ms);
  }
  if(kind==='routing_tiebreak_shadow'){
    row.shadow_schema=1;row.mode=['shadow','active_with_abstention'].includes(raw.mode)?raw.mode:null;row.applied=raw.applied===true;row.policy=raw.policy==='validated_remaining_tiebreak'?raw.policy:null;
    row.verdict=['would_change','would_keep','insufficient_evidence','not_tied','free_tie'].includes(raw.verdict)?raw.verdict:null;
    row.selected=id(raw.selected);row.alternative=id(raw.alternative);row.minimum_load=number(raw.minimum_load);
    const statuses=new Set(['supported','immediately_free','missing_active_remaining','missing_queued_service','forecast_unavailable']);
    row.candidate_costs=(Array.isArray(raw.candidates)?raw.candidates:[]).slice(0,128).flatMap(c=>id(c?.node)&&statuses.has(c.status)?[{node:id(c.node),load:number(c.load),status:c.status,predicted_wait_seconds:number(c.predicted_wait_seconds),evidence:(Array.isArray(c.evidence)?c.evidence:[]).filter(v=>['active_remaining','queued_service'].includes(v)).slice(0,32)}]:[]);
    if(!row.mode||!row.policy||!row.verdict||!row.selected)return null;
  }
  if (kind!=='routing_tiebreak_shadow'&&Array.isArray(raw.candidates)) {
    row.candidates=raw.candidates.slice(0,128).map(w=>({node:id(w.node), healthy:w.healthy===true, paused:w.paused===true,
      active:number(w.active), queued:number(w.queued), assigned_sessions:number(w.assigned_sessions), context_length:number(w.context_length),
      profile:/^[a-f0-9]{64}$/.test(w.profile)?w.profile:null,hardware:safeHardwareSnapshot(w.hardware,w.node),
      ...('worker_idle_ms' in w?Object.fromEntries(timingKeys.map(k=>[k,number(w[k])])):{}),
      ...('worker_idle_ms' in w?{cache_residence:'unknown',backend_epoch:null,
        active_request_id:/^[a-f0-9-]{36}$/.test(w.active_request_id)?w.active_request_id:null}:{}),
      ...(kind==='routing_shadow'?{eligible:w.eligible===true,...Object.fromEntries(['samples','remaining_ms','wait_ms','service_ms','completion_ms'].map(k=>[k,number(w[k])]))}:{})}));
    row.candidates_truncated=raw.candidates.length>128 || raw.candidates_truncated===true;
  }
  return row;
}

export class Dataset {
  constructor(directory, {enabled=false, maxBytes=1024**3, maxPending=512}={}) {
    this.directory=directory; this.enabled=enabled; this.maxBytes=maxBytes; this.maxPending=maxPending;
    this.run=randomUUID(); this.queue=[]; this.writing=null; this.closed=false;
    this.state={enabled,run_id:this.run,written:0,dropped:0,bytes:0,last_write:null,error:null,
      schema:1,raw_text:false,embeddings:false,retention:'No automatic deletion',finished:0,missing_usage:0,truncated:0,failed_or_cancelled:0,observation_limited:0};
    this.ready=enabled ? this.initialize() : Promise.resolve();
  }
  async initialize() {
    try {
      await fs.mkdir(this.directory,{recursive:true,mode:0o700});
      for (const file of await fs.readdir(this.directory)) if (/^routing-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)) this.state.bytes+=(await fs.stat(path.join(this.directory,file))).size;
    } catch {this.state.error='Dataset directory unavailable';}
  }
  record(kind, raw) {
    if (!this.enabled || this.closed) return;
    try {
      const row=evidence(kind,raw); if(!row)return;
      const event={schema:1,run_id:this.run,event_id:randomUUID(),time:new Date().toISOString(),...row},line=JSON.stringify(event)+'\n';
      if(Buffer.byteLength(line)>65536 || this.queue.length>=this.maxPending) {this.state.dropped++;return;}
      this.queue.push(line); this.flush();
      // Prediction failures cannot erase collected evidence or affect inference.
      try{this.onRecord?.(event);}catch{}
    } catch {this.state.dropped++;this.state.error='Evidence serialization failed';}
  }
  flush() {
    if(this.writing)return;
    this.writing=(async()=>{
      await this.ready;
      while(this.queue.length) {
        const lines=this.queue.splice(0,32), body=lines.join(''), bytes=Buffer.byteLength(body);
        if(this.state.error || this.state.bytes+bytes>this.maxBytes) {
          this.state.error ||= 'Dataset storage budget reached; collection paused, inference unchanged'; this.state.dropped+=lines.length; continue;
        }
        let handle;
        try {
          handle=await fs.open(path.join(this.directory,`routing-${new Date().toISOString().slice(0,10)}.jsonl`),'a',0o600);
          await handle.writeFile(body); await handle.sync();
          this.state.bytes+=bytes;this.state.written+=lines.length;this.state.last_write=Date.now();
          for(const line of lines){const row=JSON.parse(line);if(row.kind==='finish'){
            this.state.finished++;if(row.usage?.prompt_tokens==null||row.usage?.completion_tokens==null)this.state.missing_usage++;
            if(row.finish_reason==='length')this.state.truncated++;
            if(row.outcome==='sse_observation_limited')this.state.observation_limited++;
            else if(row.outcome!=='complete')this.state.failed_or_cancelled++;
          }}
        } catch {this.state.error='Dataset write failed; inference unchanged';this.state.dropped+=lines.length;}
        finally {await handle?.close().catch(()=>{});}
      }
    })().catch(()=>{this.state.error='Dataset writer failed';}).finally(()=>{this.writing=null;if(this.queue.length)this.flush();});
  }
  snapshot() {return {...this.state,pending:this.queue.length};}
  async close() {this.closed=true;await this.ready;while(this.writing)await this.writing;}
}
