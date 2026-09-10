import {endpointHeaders} from './endpoint.mjs';

const finite=value=>Number.isFinite(value)&&value>=0?value:null;
const POLL_MS=2000,RETRY_MS=15000,HISTORY_MS=900000;
const workerKey=worker=>JSON.stringify([worker.id,worker.url,worker.api_key_file??null]);
class UnsupportedMetrics extends Error {}
class MetricsHttpError extends Error {
  constructor(status){super('Endpoint metrics unavailable');this.status=status;}
}
const canRediscover=error=>error instanceof UnsupportedMetrics||[404,405,415].includes(error.status);
const validInterval=(now,previous)=>previous&&now>previous.at&&now-previous.at<=30000;
const delta=(value,old)=>finite(value)!==null&&finite(old)!==null&&value>=old?value-old:null;

export function prometheusValues(text){
  const result={};
  for(const line of text.split('\n')){
    const match=line.match(/^(vllm:[\w]+)(?:\{.*\})?\s+([\d.eE+\-]+)(?:\s|$)/);
    if(!match)continue;
    const value=finite(Number(match[2]));
    if(value!==null)result[match[1]]=(result[match[1]]??0)+value;
  }
  return result;
}

export function vllmSnapshot(text,now,previous){
  const values=prometheusValues(text),get=name=>finite(values['vllm:'+name]);
  if(get('generation_tokens_total')===null||get('num_requests_running')===null)throw new UnsupportedMetrics();
  const generated=get('generation_tokens_total'),seconds=previous?(now-previous.at)/1000:0;
  let computed=null;
  for(const line of text.split('\n')){
    if(!/^vllm:prompt_tokens_by_source_total\{/.test(line)||!line.includes('source="local_compute"'))continue;
    const match=line.match(/\}\s+([\d.eE+\-]+)/),value=match?finite(Number(match[1])):null;
    if(value!==null)computed=(computed??0)+value;
  }
  if(computed===null&&get('prompt_tokens_total')!==null&&get('prompt_tokens_cached_total')!==null)
    computed=Math.max(0,get('prompt_tokens_total')-get('prompt_tokens_cached_total'));
  const generationDelta=delta(generated,previous?.generated);
  const sampleValid=validInterval(now,previous)&&generationDelta!==null;
  const prefillDelta=sampleValid?delta(computed,previous?.computed):null;
  const intervalPhase=sampleValid&&generationDelta>0&&prefillDelta>0?'mixed':sampleValid&&generationDelta>0?'decode':prefillDelta>0?'prefill':null;
  const running=get('num_requests_running'),requests=get('request_generation_tokens_count');
  const phase=running===0?'idle':intervalPhase??'working';
  const rate=(tokens,duration)=>get(duration)>0&&get(tokens)!==null?get(tokens)/get(duration):null;
  return {
    source:'vllm',live_rate_scope:'poll_interval_throughput',at:now,connected:true,running,
    waiting:get('num_requests_waiting'),generated,computed,phase,phase_basis:'observed_token_counters',live_activity:true,
    interval_start:sampleValid?previous.at:null,interval_phase:intervalPhase,
    interval_generated:sampleValid?generationDelta:null,interval_prefill:prefillDelta,
    live_prefill_tps:prefillDelta!==null?prefillDelta/seconds:null,
    live_decode_tps:sampleValid?generationDelta/seconds:null,
    prefill_tps:rate('request_prefill_kv_computed_tokens_sum','request_prefill_time_seconds_sum'),
    decode_tps:rate('request_generation_tokens_sum','request_decode_time_seconds_sum'),
    cached_tokens:get('prefix_cache_hits_total'),requests,scope:'engine_session_average',
  };
}

export function omlxSnapshot(value,now,previous){
  if(value?.status!=='ok'||finite(value.total_requests)===null||finite(value.avg_generation_tps)===null)throw new UnsupportedMetrics();
  const prompt=finite(value.total_prompt_tokens),cached=finite(value.total_cached_tokens);
  const computed=prompt!==null&&cached!==null&&cached<=prompt?prompt-cached:null;
  const uptime=finite(value.uptime_seconds),sameSession=!(uptime!==null&&finite(previous?.uptime_seconds)!==null&&uptime<previous.uptime_seconds);
  return {
    source:'omlx',live_rate_scope:'active_request_average',at:now,connected:true,
    running:finite(value.active_requests),waiting:finite(value.waiting_requests),requests:value.total_requests,
    prefill_tps:value.total_requests>0?finite(value.avg_prefill_tps):null,
    decode_tps:value.total_requests>0?finite(value.avg_generation_tps):null,
    cached_tokens:cached,computed,uptime_seconds:uptime,scope:'engine_session_average',live_decode_tps:null,
    // This is completion evidence, not the duration or instantaneous phase of
    // prefill. It survives prefills too short to appear in /admin/api/activity.
    completed_prefill_tokens:sameSession&&validInterval(now,previous)&&value.total_requests>previous.requests?delta(computed,previous.computed):null,
  };
}

export function omlxActivity(value){
  const models=value?.active_models?.models;
  if(!Array.isArray(models)||models.some(model=>!model||typeof model!=='object'||['prefilling','generating'].some(key=>model[key]!==undefined&&!Array.isArray(model[key]))))throw new UnsupportedMetrics();
  const prefill=models.flatMap(model=>model.prefilling??[]);
  // oMLX also puts request setup/cache restore and other zero-output work in
  // "generating". Positive generated tokens are the evidence of generation.
  const generation=models.flatMap(model=>model.generating??[]).filter(row=>finite(row?.generated_tokens)>0);
  const sum=(items,key)=>{
    const values=items.map(row=>finite(row?.[key]));
    return values.length&&values.every(n=>n!==null)?values.reduce((a,b)=>a+b,0):null;
  };
  const running=finite(value.active_models.total_active_requests)??(models.length?sum(models,'active_requests'):0);
  const waiting=finite(value.active_models.total_waiting_requests)??(models.length?sum(models,'waiting_requests'):0);
  return {
    live_activity:true,running,waiting,
    phase:prefill.length&&generation.length?'mixed':prefill.length?'prefill':generation.length?'decode':running===0?'idle':'working',
    live_prefill_tps:sum(prefill,'speed'),live_decode_tps:sum(generation,'tokens_per_second'),
    prefill_processed:sum(prefill,'processed'),prefill_total:sum(prefill,'total'),generated_tokens:sum(generation,'generated_tokens'),
  };
}

export class EndpointTelemetry {
  constructor({fetcher=fetch,now=Date.now,onSample=()=>{}}={}){
    Object.assign(this,{fetcher,now,onSample});
    this.states=new Map();this.workers=[];this.busy=new Map();this.closed=false;
    this.cookies=new Map();this.histories=new Map();this.activityRetry=new Map();this.identities=new Map();
  }
  sync(workers){
    this.workers=workers.filter(worker=>worker.backend==='openai');
    const next=new Map(this.workers.map(worker=>[worker.id,workerKey(worker)]));
    for(const [id,key]of this.identities)if(next.get(id)!==key){
      this.states.delete(id);this.histories.delete(id);this.activityRetry.delete(id);this.cookies.delete(key);
      this.busy.get(id)?.controller.abort();this.busy.delete(id);
    }
    this.identities=next;
  }
  snapshot(id){
    const state=this.states.get(id);if(!state)return null;
    const {url,retryAt,...publicState}=state;
    return {...publicState,series:(this.histories.get(id)??[]).filter(point=>this.now()>=point.time&&this.now()-point.time<HISTORY_MS)};
  }
  poll(){
    if(this.closed)return;
    for(const worker of this.workers)if(!this.busy.has(worker.id)&&this.now()>=(this.states.get(worker.id)?.retryAt??0))void this.sample(worker);
  }
  async read(worker,route,extraHeaders={},signal){
    const url=new URL(worker.url);
    url.pathname=url.pathname.replace(/\/v1\/?$/,'').replace(/\/$/,'')+route;
    const timeout=AbortSignal.timeout(2000);
    const response=await this.fetcher(url,{headers:{...endpointHeaders(worker),...extraHeaders},signal:signal?AbortSignal.any([signal,timeout]):timeout,redirect:'error'});
    if(!response.ok){await response.body?.cancel();throw new MetricsHttpError(response.status);}
    if(!response.body)throw new UnsupportedMetrics();
    const reader=response.body.getReader();let bytes=0;const parts=[];
    try{
      for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>1048576)throw new UnsupportedMetrics();parts.push(Buffer.from(value));}
    }finally{await reader.cancel();}
    return Buffer.concat(parts).toString();
  }
  async activity(worker,signal){
    const key=workerKey(worker);let cookie=this.cookies.get(key);
    try{return omlxActivity(JSON.parse(await this.read(worker,'/admin/api/activity',cookie?{cookie}:{},signal)));}
    catch(error){this.cookies.delete(key);if(signal?.aborted)throw error;}
    const auth=endpointHeaders(worker).authorization;
    if(!auth)throw new Error('Activity authentication unavailable');
    const url=new URL(worker.url);url.pathname=url.pathname.replace(/\/v1\/?$/,'').replace(/\/$/,'')+'/admin/api/login';
    const timeout=AbortSignal.timeout(2000);
    const response=await this.fetcher(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({api_key:auth.slice(7),remember:false}),signal:signal?AbortSignal.any([signal,timeout]):timeout,redirect:'error'});
    await response.body?.cancel();
    if(!response.ok||signal?.aborted)throw new Error('Activity authentication unavailable');
    cookie=response.headers.get('set-cookie')?.split(';')[0];
    if(!cookie?.startsWith('omlx_admin_session='))throw new Error('Activity session unavailable');
    this.cookies.set(key,cookie);
    return omlxActivity(JSON.parse(await this.read(worker,'/admin/api/activity',{cookie},signal)));
  }
  async sample(worker){
    if(this.closed||this.busy.has(worker.id))return;
    const key=workerKey(worker),started=this.now(),controller=new AbortController(),pending={key,controller};
    this.busy.set(worker.id,pending);
    const before=this.states.get(worker.id),current=()=>!this.closed&&this.identities.get(worker.id)===key&&this.busy.get(worker.id)===pending;
    const readVllm=async()=>vllmSnapshot(await this.read(worker,'/metrics',{},controller.signal),this.now(),before?.source==='vllm'?before:null);
    const readOmlx=async()=>{
      const raw=await this.read(worker,'/api/status',{},controller.signal);let value;
      try{value=JSON.parse(raw);}catch{throw new UnsupportedMetrics();}
      return omlxSnapshot(value,this.now(),before?.source==='omlx'?before:null);
    };
    try{
      let value;
      if(before?.source==='omlx'){
        try{value=await readOmlx();}catch(error){if(!canRediscover(error))throw error;value=await readVllm();}
      }else{
        try{value=await readVllm();}catch(error){if(before?.source==='vllm'&&!canRediscover(error))throw error;value=await readOmlx();}
      }
      if(value.source==='omlx'){
        value.live_activity=false;
        if(this.now()>=(this.activityRetry.get(worker.id)??0)){
          try{Object.assign(value,await this.activity(worker,controller.signal),{activity_at:this.now()});this.activityRetry.delete(worker.id);}
          catch{this.activityRetry.set(worker.id,this.now()+RETRY_MS);}
        }
      }
      if(current()){
        this.states.set(worker.id,{...value,url:worker.url,retryAt:Math.max(started+POLL_MS,this.now())});
        const rows=(before?.source&&before.source!==value.source?[]:this.histories.get(worker.id)??[]).filter(point=>value.at>=point.time&&value.at-point.time<HISTORY_MS&&point.scope===value.live_rate_scope);
        for(const kind of ['prefill','decode']){
          const rate=value['live_'+kind+'_tps'];
          if(Number.isFinite(rate)&&rate>0)rows.push({time:value.activity_at??value.at,kind,tps:rate,scope:value.live_rate_scope});
        }
        this.histories.set(worker.id,rows.slice(-1024));
        this.notify(worker.id);
      }
    }catch{
      if(current()){
        this.states.set(worker.id,{...before,url:worker.url,connected:false,error:'Endpoint metrics unavailable',retryAt:this.now()+RETRY_MS});
        this.notify(worker.id);
      }
    }finally{
      if(this.busy.get(worker.id)===pending)this.busy.delete(worker.id);
      if(this.closed||this.identities.get(worker.id)!==key){this.cookies.delete(key);if(!this.identities.has(worker.id))this.activityRetry.delete(worker.id);}
    }
  }
  notify(id){try{this.onSample(id,this.snapshot(id),this.now());}catch{/* Observation cannot break polling or inference. */}}
  close(){this.closed=true;for(const {controller}of this.busy.values())controller.abort();this.cookies.clear();}
}
