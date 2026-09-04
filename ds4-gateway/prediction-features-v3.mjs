// V3 is an additive challenger schema. V2 stays byte-for-byte available so a
// validated deployed model remains usable while V3 earns its own evidence.
import {
  PredictionHistory as V2PredictionHistory,
  FEATURE_NAMES as V2_FEATURE_NAMES,
  CATEGORICAL as V2_CATEGORICAL,
  GROUPS as V2_GROUPS
} from './prediction-features.mjs';

export const FEATURE_SCHEMA='dsg-latency-v3';
const CLIENT=[
  'client_metadata_ready','client_prompt_tokens_estimate','client_turn_index','client_compaction_count','client_reasoning_effort'
];
const ADMISSION=[
  'traffic_class','admission_wait_s',
  'selected_active','assigned_sessions','worker_idle_s','active_elapsed_at_admission_s','upstream_byte_age_at_admission_s',
  'session_last_used_s','session_last_finished_s','intervening_requests','candidate_prior_prompt_tokens',
  'candidate_prior_cached_tokens','candidate_prior_cached_fraction','current_prompt_delta','current_prompt_growth_ratio',
  'observation_epoch','cache_residence'
];
const REQUEST=[
  'request_bytes','request_message_count','request_user_messages','request_assistant_messages','request_system_messages',
  'request_tool_messages','request_text_characters','request_image_parts','request_tool_definitions',
  'request_max_output_tokens','request_temperature','request_top_p','request_stream','request_route'
];
export const GROUPS={...V2_GROUPS,admission_state:ADMISSION,client:CLIENT,request:REQUEST};
export const FEATURE_NAMES=[...V2_FEATURE_NAMES,...ADMISSION,...CLIENT,...REQUEST];
export const CATEGORICAL=[...V2_CATEGORICAL,'traffic_class','client_reasoning_effort','cache_residence','request_route'];

const finite=x=>typeof x==='number'&&Number.isFinite(x);
const nonnegative=x=>finite(x)&&x>=0?x:null;
const seconds=x=>nonnegative(x)===null?null:x/1000;
const ratio=(a,b)=>finite(a)&&finite(b)&&b>0?a/b:null;

export class PredictionHistory extends V2PredictionHistory {
  snapshot(job,stage,at,progress=null,candidate=null) {
    const point=super.snapshot(job,stage,at,progress,candidate),d=job.decision;
    const c=candidate??d.candidates?.find(worker=>worker.node===d.node)??{};
    const metadata=d.client_metadata??{},body=job.body??{};
    const prompt=nonnegative(metadata.prompt_tokens_estimate),priorPrompt=nonnegative(c.prior_prompt_tokens),priorCached=nonnegative(c.prior_cached_tokens);
    Object.assign(point.features,{
      traffic_class:d.traffic_class??null,
      admission_wait_s:seconds(d.admission_wait_ms),
      client_metadata_ready:metadata.status==='ready'?1:0,
      client_prompt_tokens_estimate:prompt,
      client_turn_index:nonnegative(metadata.turn_index),
      client_compaction_count:nonnegative(metadata.compaction_count),
      client_reasoning_effort:typeof metadata.reasoning_effort==='string'?metadata.reasoning_effort:null,
      selected_active:nonnegative(c.active),assigned_sessions:nonnegative(c.assigned_sessions),worker_idle_s:seconds(c.worker_idle_ms),
      active_elapsed_at_admission_s:seconds(c.active_elapsed_ms),upstream_byte_age_at_admission_s:seconds(c.upstream_byte_age_ms),
      session_last_used_s:seconds(c.session_last_used_ms),session_last_finished_s:seconds(c.session_last_finished_ms),
      intervening_requests:nonnegative(c.intervening_requests),candidate_prior_prompt_tokens:priorPrompt,candidate_prior_cached_tokens:priorCached,
      candidate_prior_cached_fraction:priorPrompt===null||priorCached===null?null:ratio(priorCached,priorPrompt),
      current_prompt_delta:prompt===null||priorPrompt===null?null:prompt-priorPrompt,
      current_prompt_growth_ratio:prompt===null||priorPrompt===null?null:ratio(prompt,priorPrompt),
      observation_epoch:nonnegative(c.observation_epoch),cache_residence:typeof c.cache_residence==='string'?c.cache_residence:null,
      request_bytes:nonnegative(body.request_bytes),request_message_count:nonnegative(body.message_count),
      request_user_messages:nonnegative(body.user_messages),request_assistant_messages:nonnegative(body.assistant_messages),
      request_system_messages:nonnegative(body.system_messages),request_tool_messages:nonnegative(body.tool_messages),
      request_text_characters:nonnegative(body.text_characters),request_image_parts:nonnegative(body.image_parts),
      request_tool_definitions:nonnegative(body.tool_definitions),request_max_output_tokens:nonnegative(body.max_output_tokens),
      request_temperature:nonnegative(body.temperature),request_top_p:nonnegative(body.top_p),
      request_stream:typeof body.request_stream==='boolean'?Number(body.request_stream):null,
      request_route:typeof body.request_route==='string'?body.request_route:null
    });
    return point;
  }
}

export function replay(events,inventory) {
  const history=new PredictionHistory(inventory),rows=[],seen=new Map();let invalid=0;
  for(const row of [...events].sort((a,b)=>Date.parse(a.time)-Date.parse(b.time))){
    if(!row?.event_id||!row.run_id||!row.request_id||row.schema!==1){invalid++;continue;}
    const key=row.run_id+':'+row.event_id,canonical=JSON.stringify(row);
    if(seen.has(key)){if(seen.get(key)!==canonical)throw new Error('Conflicting evidence ID');continue;}seen.set(key,canonical);
    rows.push(...history.observe(row).rows);
  }
  return {schema:FEATURE_SCHEMA,feature_names:FEATURE_NAMES,categorical:CATEGORICAL,groups:GROUPS,rows,invalid};
}
