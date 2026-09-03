// Shared offline/live feature builder. Only evidence available at each forecast
// time enters a feature. No raw text, credentials or model-generated features.
export const FEATURE_SCHEMA='dsg-latency-v2';
export const GROUPS={
  base:['server_id','hardware_family','accelerator_family','ram_gib','context_length','affinity','stage','selected_queued','fleet_queued','fleet_active'],
  history:['history_count','prior_service_s','prior_output_tokens','prior_prompt_tokens','prior_cached_fraction','prior_ttft_s','prior_generation_tps','recent_service_mean','recent_service_std','recent_output_mean','recent_output_std','output_trend','prompt_delta','seconds_since_prior','same_prior_server','worker_service_median','worker_generation_tps','prior_thinking_chars','prior_answer_chars','prior_effort','requested_effort','history_generation_estimate_s','hardware_service_median','fleet_service_median'],
  ratios:['prior_output_prompt_ratio','recent_output_prompt_ratio','prior_thinking_fraction'],
  semantic:['latest_characters','recent_characters','visible_messages','embedding_present','similarity_previous_user','similarity_previous_conversation',...Array.from({length:12},(_,i)=>`semantic_${i}`)],
  progress:['elapsed_s','phase','semantic_characters','semantic_age_s','thinking_characters','answer_characters','tool_characters','observed_chars_per_s']
};
export const CATEGORICAL=['server_id','hardware_family','accelerator_family','affinity','stage','prior_effort','requested_effort','phase'];
export const FEATURE_NAMES=Object.values(GROUPS).flat();
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const num=x=>finite(x)?x:null;
const positive=x=>finite(x)&&x>=0?x:null;
const ratio=(a,b)=>finite(a)&&finite(b)&&b>0?a/b:null;
const mean=v=>v.length?v.reduce((a,b)=>a+b,0)/v.length:null;
export const median=v=>{if(!v.length)return null;const s=[...v].sort((a,b)=>a-b),m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2;};
const std=v=>v.length>1?Math.sqrt(mean(v.map(x=>(x-mean(v))**2))):null;
const cosine=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===384&&b.length===384&&a.every(finite)&&b.every(finite)?Math.max(-1,Math.min(1,a.reduce((s,v,i)=>s+v*b[i],0))):null;
const effort=r=>{const f=r?.fields;return typeof f?.reasoning_effort==='string'?f.reasoning_effort:typeof f?.['reasoning.effort']==='string'?f['reasoning.effort']:r?.status==='not_specified'?'default':f?.['thinking.type']==='disabled'?'off':null;};
const validFinish=f=>f?.outcome==='complete'&&['stop','tool_calls','function_call'].includes(f.finish_reason)&&finite(f.service_ms)&&f.service_ms>0;
export function profileFor(inventory,candidate) {
  const p=inventory?.workers?.[candidate?.node];
  return p?.matching_profiles?.includes(candidate.profile)?p:null;
}
export class PredictionHistory {
  constructor(inventory={}, {maxJobs=4096,maxSessions=4096,maxWorkers=128}={}) {
    Object.assign(this,{inventory,maxJobs,maxSessions,maxWorkers});this.jobs=new Map();this.sessions=new Map();this.workers=new Map();this.completed=0;
  }
  getJob(row){return this.jobs.get(`${row.run_id}:${row.request_id}`);}
  snapshot(job,stage,at,progress=null,candidate=null) {
    const d=job.decision,c=candidate??d.candidates?.find(w=>w.node===d.node)??{},p=profileFor(this.inventory,c);
    // A session may have overlapping requests. Filter by finish time, never
    // assume array insertion order means the observation was already available.
    const history=(this.sessions.get(d.session)||[]).filter(x=>x.at<at).slice(-5),prior=history.at(-1),older=history.at(-2);
    const worker=(this.workers.get(c.node)||[]).filter(x=>x.at<at&&x.profile===c.profile).slice(-32);
    const fleet=[...this.workers.values()].flat().filter(x=>x.at<at&&profileFor(this.inventory,{node:x.node,profile:x.profile})).sort((a,b)=>a.at-b.at).slice(-128);
    const peers=fleet.filter(x=>{const q=this.inventory.workers[x.node];return p&&q.hardware_family===p.hardware_family&&q.accelerator_family===p.accelerator_family&&q.ram_gib===p.ram_gib&&x.context===c.context_length;});
    const values=k=>history.map(x=>x[k]).filter(finite),body=job.body??{},vectors=job.embedding?.vectors??{};
    const f=Object.fromEntries(FEATURE_NAMES.map(k=>[k,null]));
    Object.assign(f,{server_id:c.node??null,hardware_family:p?.hardware_family??null,accelerator_family:p?.accelerator_family??null,ram_gib:num(p?.ram_gib),context_length:positive(c.context_length),affinity:d.affinity??null,stage,
      selected_queued:positive(c.queued),fleet_queued:d.candidates?.every(w=>finite(w.queued))?d.candidates.reduce((s,w)=>s+w.queued,0):null,fleet_active:d.candidates?.every(w=>finite(w.active))?d.candidates.reduce((s,w)=>s+w.active,0):null,
      history_count:history.length,prior_service_s:prior?.service??null,prior_output_tokens:prior?.output??null,prior_prompt_tokens:prior?.prompt??null,prior_cached_fraction:prior?.cached_fraction??null,prior_ttft_s:prior?.ttft??null,prior_generation_tps:prior?.tps??null,
      recent_service_mean:mean(values('service')),recent_service_std:std(values('service')),recent_output_mean:mean(values('output')),recent_output_std:std(values('output')),
      output_trend:prior&&older&&finite(prior.output)&&finite(older.output)?prior.output-older.output:null,prompt_delta:prior&&older&&finite(prior.prompt)&&finite(older.prompt)?prior.prompt-older.prompt:null,
      seconds_since_prior:prior?Math.max(0,(at-prior.at)/1000):null,same_prior_server:prior?Number(prior.node===c.node):null,
      worker_service_median:median(worker.map(x=>x.service)),worker_generation_tps:median(worker.map(x=>x.tps).filter(finite)),
      hardware_service_median:median(peers.map(x=>x.service)),fleet_service_median:median(fleet.map(x=>x.service)),
      history_generation_estimate_s:ratio(mean(values('output')),median(worker.map(x=>x.tps).filter(finite))),
      prior_thinking_chars:prior?.thinking??null,prior_answer_chars:prior?.answer??null,prior_effort:prior?.effort??null,requested_effort:effort(body.requested_thinking),
      prior_output_prompt_ratio:prior?.output_ratio??null,recent_output_prompt_ratio:mean(values('output_ratio')),prior_thinking_fraction:prior?.thinking_fraction??null,
      latest_characters:positive(body.latest_characters),recent_characters:positive(body.recent_characters),visible_messages:positive(body.visible_messages_considered),embedding_present:job.embedding?1:0,
      similarity_previous_user:cosine(vectors.latest_user?.vector,prior?.vectors?.latest_user?.vector),similarity_previous_conversation:cosine(vectors.recent_conversation?.vector,prior?.vectors?.recent_conversation?.vector)});
    // Fixed, data-independent low-dimensional projection. No fitted projection
    // can leak holdout content into training; full vectors stay private.
    const v=vectors.latest_user?.vector;
    if(Array.isArray(v)&&v.length===384&&v.every(finite))for(let k=0;k<12;k++)f[`semantic_${k}`]=v.reduce((s,x,i)=>s+x*Math.cos(Math.PI*(i+.5)*(k+1)/384),0)*Math.sqrt(2/384);
    if(progress)Object.assign(f,{elapsed_s:positive(progress.active_elapsed_ms)===null?null:progress.active_elapsed_ms/1000,phase:progress.phase??null,semantic_characters:positive(progress.semantic_characters),semantic_age_s:positive(progress.semantic_age_ms)===null?null:progress.semantic_age_ms/1000,
      thinking_characters:positive(progress.thinking_characters),answer_characters:positive(progress.answer_characters),tool_characters:positive(progress.tool_characters),observed_chars_per_s:ratio(progress.semantic_characters,progress.active_elapsed_ms/1000)});
    return {kind:stage==='remaining'?'remaining':stage==='admission'?'admission':'updated',stage,at,features:f,profile:c.profile??null,node:c.node??null};
  }
  observe(row) {
    const key=`${row.run_id}:${row.request_id}`,at=Date.parse(row.time);if(!Number.isFinite(at))return {points:[],rows:[]};
    if(row.kind==='decision'){
      if(this.jobs.has(key))return {points:[],rows:[]};
      const job={decision:row,points:[],body:null,embedding:null};this.jobs.set(key,job);
      if(this.jobs.size>this.maxJobs)this.jobs.delete(this.jobs.keys().next().value);
      if(row.traffic_class==='genie'||!row.candidates?.length||row.candidates_truncated)return {points:[],rows:[]};
      const point=this.snapshot(job,'admission',at);job.points.push(point);return {points:[point],rows:[]};
    }
    const job=this.jobs.get(key);if(!job||job.decision.traffic_class==='genie'||row.node!==job.decision.node)return {points:[],rows:[]};
    let point;
    if(at<Date.parse(job.decision.time))return {points:[],rows:[]};
    if(row.kind==='dispatch'){if(job.dispatch)job.invalid=true;else job.dispatch=row;}
    const dispatched=job.dispatch&&at>=Date.parse(job.dispatch.time);
    if(dispatched&&row.kind==='request_features'&&row.status==='ready'&&row.available_at<=at){job.body=row;point=this.snapshot(job,'upload',at);}
    if(dispatched&&row.kind==='embedding'&&row.status==='ready'&&row.available_at<=at&&row.dimensions===384){job.embedding=row;point=this.snapshot(job,'embedded',at);}
    if(dispatched&&row.kind==='progress'&&positive(row.active_elapsed_ms)!==null&&row.active_elapsed_ms<=at-Date.parse(job.dispatch.time)+1000)point=this.snapshot(job,'remaining',at,row);
    if(point){job.points.push(point);if(job.points.length>68){const index=job.points.findIndex(p=>p.stage==='remaining');job.points.splice(index>=0?index:0,1);}return {points:[point],rows:[]};}
    if(['queued_cancel','queue_timeout','unavailable_before_dispatch'].includes(row.kind)){this.jobs.delete(key);return {points:[],rows:[]};}
    if(row.kind!=='finish')return {points:[],rows:[]};
    this.jobs.delete(key);
    if(job.invalid||!validFinish(row)||!job.dispatch||Date.parse(job.dispatch.time)<Date.parse(job.decision.time)||at<Date.parse(job.dispatch.time))return {points:[],rows:[]};
    const c=job.decision.candidates?.find(w=>w.node===row.node),p=profileFor(this.inventory,c),u=row.usage??{},g=row.generation??{};
    const sample={at,node:row.node,profile:c?.profile,context:c?.context_length,service:row.service_ms/1000,output:positive(u.completion_tokens),prompt:positive(u.prompt_tokens),cached_fraction:u.cached_tokens<=u.prompt_tokens?ratio(u.cached_tokens,u.prompt_tokens):null,output_ratio:ratio(u.completion_tokens,u.prompt_tokens),
      ttft:positive(g.first_semantic_ms)===null?null:g.first_semantic_ms/1000,tps:finite(g.first_semantic_ms)&&row.service_ms>g.first_semantic_ms?ratio(u.completion_tokens,(row.service_ms-g.first_semantic_ms)/1000):null,
      thinking:positive(g.thinking_characters),answer:positive(g.answer_characters),thinking_fraction:ratio(g.thinking_characters,(g.thinking_characters??0)+(g.answer_characters??0)+(g.tool_characters??0)),effort:effort(row.requested_thinking),vectors:job.embedding?.vectors};
    if(job.decision.session){const h=this.sessions.get(job.decision.session)??[];h.push(sample);this.sessions.delete(job.decision.session);this.sessions.set(job.decision.session,h.slice(-8));if(this.sessions.size>this.maxSessions)this.sessions.delete(this.sessions.keys().next().value);}
    const w=this.workers.get(row.node)??[];w.push(sample);this.workers.set(row.node,w.slice(-128));if(this.workers.size>this.maxWorkers)this.workers.delete(this.workers.keys().next().value);this.completed++;
    // Unverified worker inventories may support diagnostics, never train a
    // performance claim for an unrelated hardware/config fingerprint.
    const rows=p?job.points.filter(x=>x.at<=at).map(x=>({...x,request_id:row.request_id,run_id:row.run_id,group:job.decision.session??'unknown-session',decision_time:Date.parse(job.decision.time),finish_time:at,
      target_s:x.kind==='remaining'?Math.max(0,row.service_ms/1000-x.features.elapsed_s):row.service_ms/1000})).filter(x=>x.target_s>=0):[];
    return {points:[],rows,finished:{job,finish:row}};
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
