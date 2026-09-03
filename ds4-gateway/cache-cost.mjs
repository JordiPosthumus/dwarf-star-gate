// Measured components, not a cache directory or evidence that a snapshot exists.
const finite=x=>Number.isFinite(x)&&x>=0;
const bucket=x=>x>0?Math.ceil(Math.log2(x)):0;
const HOUR=3600000;
export class CacheCosts {
  constructor(){this.samples=[];this.started=null;this.rejected=0;}
  accept(e) {
    if(!finite(e?.time))return;
    let sample;
    if(e.kind==='disk_restore'&&finite(e.load_ms)&&Number.isSafeInteger(e.cached)&&e.cached>0)
      sample={kind:'disk_load',time:e.time,tokens:e.cached,ms:e.load_ms};
    if(e.kind==='start')this.started=e;
    if(e.kind==='prefill_done') {
      const start=this.started;this.started=null;
      if(!start||e.time<start.time||e.time-start.time>HOUR||start.cached!==e.cached||start.prompt!==e.prompt||start.new_tokens!==e.new_tokens||!finite(e.seconds)||e.prompt!==e.cached+e.new_tokens){this.rejected++;return;}
      sample={kind:'prefill',time:e.time,tokens:e.new_tokens,prompt:e.prompt,reused:e.cached>0,ms:e.seconds*1000};
    }
    if(e.kind==='finish')this.started=null;
    if(sample){this.samples.push(sample);this.samples=this.samples.filter(x=>sample.time-x.time<=HOUR).slice(-128);}
  }
  snapshot(now=Date.now()) {
    return {schema:1,source:'engine_component_timings',request_attribution:'unverified',backend_epoch:'unverified',
      samples:this.samples.filter(x=>now>=x.time&&now-x.time<=HOUR),rejected:this.rejected,
      note:'Disk-load span excludes prefix search and any later engine synchronization. No remote-copy or hot-lookup measurement.'};
  }
}
function estimate(samples,kind,tokens,{prompt,reused,now}={}) {
  const rows=samples.filter(x=>x.kind===kind&&finite(x.ms)&&finite(x.time)&&now>=x.time&&now-x.time<=HOUR&&bucket(x.tokens)===bucket(tokens)&&
    (kind!=='prefill'||(bucket(x.prompt)===bucket(prompt)&&x.reused===reused)));
  if(rows.length<3)return {status:'insufficient_evidence',samples:rows.length,estimated_ms:null};
  return {status:'unvalidated_estimate',samples:rows.length,estimated_ms:rows.reduce((sum,x)=>sum+x.ms,0)/rows.length,
    observed_min_ms:Math.min(...rows.map(x=>x.ms)),observed_max_ms:Math.max(...rows.map(x=>x.ms)),
    token_bucket:{lower:tokens>0?2**(bucket(tokens)-1):0,upper:tokens>0?2**bucket(tokens):0},latest_sample_at:Math.max(...rows.map(x=>x.time))};
}
export function estimateCacheCost(snapshot,{tier,cached_tokens,prompt_tokens},now=Date.now()) {
  if(!['local_disk','cold','hot','remote'].includes(tier)||![cached_tokens,prompt_tokens].every(x=>Number.isSafeInteger(x)&&x>=0)||cached_tokens>prompt_tokens||prompt_tokens<1||prompt_tokens>10485760||tier==='cold'&&cached_tokens!==0)throw new Error('Invalid cache scenario');
  const samples=snapshot?.schema===1&&Array.isArray(snapshot.samples)?snapshot.samples:[];
  const missing={status:'not_measured',samples:0,estimated_ms:null};
  const load=tier==='local_disk'?estimate(samples,'disk_load',cached_tokens,{now}):tier==='cold'?{status:'no_cache_payload',samples:0,estimated_ms:0}:missing;
  const prefill=tier==='remote'?missing:estimate(samples,'prefill',prompt_tokens-cached_tokens,{prompt:prompt_tokens,reused:cached_tokens>0,now});
  return {tier,cached_tokens,prompt_tokens,source:'measured_component_baseline',validation:'unvalidated',
    disk_load:load,prefill,measured_components_ms:load.estimated_ms!==null&&prefill.estimated_ms!==null?load.estimated_ms+prefill.estimated_ms:null,
    total_acquisition_ms:null,cache_existence_verified:false,request_attribution:'unverified',
    excluded:['prefix_search','unmeasured_engine_sync','remote_transfer','queue_wait','generation'],
    note:'Scenario estimate only. Sample ranges are not confidence intervals. Never add these costs to a total-service estimate that already includes them.'};
}
