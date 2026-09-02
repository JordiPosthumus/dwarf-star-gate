// Passive, bounded evidence and an UNVALIDATED historical baseline. No worker,
// queue, affinity store, request body, or routing mutation is accessible here.
const finite = n => Number.isFinite(n) && n >= 0;
const median = values => {
  if (!values.length) return null;
  const s = [...values].sort((a,b)=>a-b), m = Math.floor(s.length/2);
  return s.length%2 ? s[m] : (s[m-1]+s[m])/2;
};
const bucket = tokens => finite(tokens) && tokens > 0 ? Math.ceil(Math.log2(tokens)) : null;
const routes = new Set(['/v1/chat/completions','/v1/completions','/v1/responses','/v1/messages']);
export function conditionalRemaining(durations, elapsed, minimum=5) {
  if (!finite(elapsed)) return null;
  // Condition on having survived this long. Never subtract elapsed from an
  // unconditional average and conclude a long-thinking request is overdue.
  const survivors = durations.filter(x=>finite(x) && x>elapsed);
  return survivors.length>=minimum ? median(survivors.map(x=>x-elapsed)) : null;
}

export class RoutingShadow {
  constructor({enabled=false, now=()=>performance.now(), maxSessions=4096, maxSamples=128, maxWorkers=128, ttlMs=3600000}={}) {
    Object.assign(this,{enabled,now,maxSessions,maxSamples,maxWorkers,ttlMs});
    this.workers=new Map();this.sessions=new Map();
    this.state={enabled,mode:'shadow',predictor:'unvalidated_historical_baseline',evaluations:0,would_move:0,insufficient_evidence:0,skipped:0,errors:0,last:null};
  }
  snapshot(){return {...this.state};}
  worker(node) {
    if(!this.workers.has(node)) {
      if(this.workers.size>=this.maxWorkers)return null;
      this.workers.set(node,{sequence:0,idleAt:null,samples:[],epoch:0});
    }
    return this.workers.get(node);
  }
  reset(node) {
    const w=this.workers.get(node);if(!w)return;
    this.workers.set(node,{sequence:0,idleAt:null,samples:[],epoch:w.epoch+1});
    for(const [key,value] of this.sessions)if(value.node===node)this.sessions.delete(key);
  }
  remove(node){this.reset(node);this.workers.delete(node);}
  entry(node,session){return session?this.sessions.get(`${node}:${session}`):null;}
  started(node,session) {
    if(!this.enabled)return;
    const w=this.worker(node);if(!w)return;
    w.sequence++;w.idleAt=null;
    if(!session)return;
    const key=`${node}:${session}`,previous=this.sessions.get(key);
    this.sessions.delete(key);
    this.sessions.set(key,{...previous,node,started:this.now(),sequence:w.sequence});
    if(this.sessions.size>this.maxSessions)this.sessions.delete(this.sessions.keys().next().value);
  }
  finished(node,session,{outcome,finish_reason,service_ms,usage,route,traffic_class}) {
    if(!this.enabled)return;
    const w=this.worker(node);if(!w)return;
    const now=this.now();w.idleAt=now;
    const valid=outcome==='complete' && ['stop','tool_calls','function_call'].includes(finish_reason) &&
      finite(service_ms) && service_ms>0 && routes.has(route) && traffic_class!=='genie';
    const old=this.entry(node,session);
    if(old && valid)Object.assign(old,{finished:now,prompt:finite(usage?.prompt_tokens)?usage.prompt_tokens:null,
      cached:finite(usage?.cached_tokens)?usage.cached_tokens:null});
    if(valid && bucket(usage?.prompt_tokens)!==null) {
      w.samples.push({at:now,route,bucket:bucket(usage.prompt_tokens),service_ms});
      w.samples=w.samples.filter(x=>now-x.at<=this.ttlMs).slice(-this.maxSamples);
    }
  }
  timing(node,session,active) {
    const now=this.now(),w=this.workers.get(node),s=this.entry(node,session);
    return {worker_idle_ms:!active && finite(w?.idleAt)?Math.max(0,now-w.idleAt):null,
      active_elapsed_ms:active && finite(active.dispatchedMono)?Math.max(0,now-active.dispatchedMono):null,
      upstream_byte_age_ms:active && finite(active.lastUpstreamByteMono)?Math.max(0,now-active.lastUpstreamByteMono):null,
      session_last_used_ms:finite(s?.started)?Math.max(0,now-s.started):null,
      session_last_finished_ms:finite(s?.finished)?Math.max(0,now-s.finished):null,
      intervening_requests:s && w?Math.max(0,w.sequence-s.sequence):null,
      prior_prompt_tokens:s?.prompt??null,prior_cached_tokens:s?.cached??null,
      cache_residence:'unknown',backend_epoch:null,observation_epoch:w?.epoch??0};
  }
  prior(session) {
    let result=null;
    if(!session)return null;
    for(const node of this.workers.keys()){const v=this.entry(node,session);if(finite(v?.finished) && (!result || v.finished>result.finished))result=v;}
    return result;
  }
  durations(node,job) {
    if((this.workers.get(node)?.samples.length??0)<5)return [];
    const prior=this.prior(job.key),b=bucket(prior?.prompt),now=this.now();
    if(b===null || now-prior.finished>this.ttlMs || job.trafficClass==='genie')return [];
    return (this.workers.get(node)?.samples??[]).filter(x=>x.route===job.route && x.bucket===b && now-x.at<=this.ttlMs).map(x=>x.service_ms);
  }
  service(node,job) {
    const values=this.durations(node,job);
    return values.length>=5?median(values):null;
  }
  assess({job,home,candidates,reason,waiting_ms,session_busy}) {
    if(!this.enabled)return null;
    const estimates=candidates.map(c=>{
      const values=this.durations(c.node,job),service_ms=values.length>=5?median(values):null;
      const activeValues=c.active_job?this.durations(c.node,c.active_job):[];
      const remaining_ms=c.active_job?conditionalRemaining(activeValues,c.active_elapsed_ms):0;
      // Only the home queue or a genuinely idle alternative can be compared in
      // this slice. Do not estimate arbitrary other queues on the request path.
      const ahead=c.node===home?c.ahead_jobs.map(j=>this.service(c.node,j)):c.queued?[null]:[];
      const wait_ms=remaining_ms===null || ahead.some(x=>x===null)?null:remaining_ms+ahead.reduce((a,b)=>a+b,0);
      const eligible=c.healthy && !c.paused;
      const {active_job,ahead_jobs,...visible}=c;
      return {...visible,eligible,samples:values.length,remaining_ms,wait_ms,service_ms,
        completion_ms:eligible && wait_ms!==null && service_ms!==null?wait_ms+service_ms:null};
    });
    const stay=estimates.find(c=>c.node===home),idle=estimates.filter(c=>c.node!==home && c.eligible && !c.active && !c.queued);
    const usable=idle.filter(c=>c.completion_ms!==null).sort((a,b)=>a.completion_ms-b.completion_ms),best=usable[0];
    let verdict='insufficient_evidence';
    if(session_busy)verdict='handover_blocked';
    else if(!idle.length)verdict='no_idle_alternative';
    else if(stay?.completion_ms!==null && stay?.completion_ms!==undefined && best)verdict=best.completion_ms<stay.completion_ms?'would_move':'would_stay';
    const result={reason,verdict,confidence:'unvalidated',basis:'prior_session_prompt_bucket_mixed_cache',waiting_ms,
      source:home,alternative:best?.node??idle[0]?.node??null,session_busy,
      saving_ms:best && stay?.completion_ms!=null?Math.max(0,stay.completion_ms-best.completion_ms):null,candidates:estimates};
    this.state.evaluations++;if(verdict==='would_move')this.state.would_move++;
    if(verdict==='insufficient_evidence')this.state.insufficient_evidence++;
    this.state.last={reason,verdict,source:home,alternative:result.alternative,saving_ms:result.saving_ms};
    return result;
  }
}
